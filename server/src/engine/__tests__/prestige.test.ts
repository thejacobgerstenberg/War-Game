/**
 * prestige.test.ts — PRESTIGE & VICTORY subsystem (§13).
 *
 * Covers each §13.1 prestige source value scored at cleanup (own/enemy capital,
 * key city, trade monopoly, secret objective, decisive battle, won war, lose
 * capital), the §13.2 threshold per player count, the §13.3 round-16 highest +
 * tiebreaks, and the §13.3 Constantinople sudden-death (2 consecutive cleanups).
 * Also asserts the coordination boundary: scorePrestige does NOT re-award the
 * §13.1 sources owned by economy (great works) or diplomacy (vassal/marriage).
 */
import { describe, it, expect } from "vitest";
import {
  Faction,
  GamePhase,
  GreatWorkType,
  TreatyType,
  UnitType,
  type GameLogEntry,
  type GameState,
  type SecretObjective,
  type SecretObjectiveClause,
} from "@imperium/shared";
import { createInitialState, emptyUnits, type SeatInput } from "../gameState.js";
import { scorePrestige, checkVictory } from "../prestige.js";
import { FACTION_STARTS } from "../factions.js";
import { PROVINCES, SEA_ZONES } from "../mapData.js";
import {
  MONOPOLY_PRESTIGE,
  PRESTIGE_THRESHOLDS,
  PRESTIGE_VALUES,
} from "../balance.js";

const seats2: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];
const seats3: SeatInput[] = [
  ...seats2,
  { id: "p3", name: "Doge", faction: Faction.VENICE, isHost: false },
];
const seats4: SeatInput[] = [
  ...seats3,
  { id: "p4", name: "Hunyadi", faction: Faction.HUNGARY, isHost: false },
];

function fresh(seats: SeatInput[] = seats2): GameState {
  const s = structuredClone(createInitialState("ROOM01", seats, 12345));
  s.phase = GamePhase.END; // scoring happens at cleanup
  return s;
}

/**
 * Blank every province's ownership, then assign the given owners — for precise
 * totals. Also clears each player's *seeded* secret objectives so a single-source
 * measurement is not perturbed by an unrelated starting objective that happens to
 * be satisfied by the isolated ownership (e.g. Byzantium's two constantinople
 * objectives). Tests that exercise objective scoring assign their own afterward.
 */
function isolate(state: GameState, owners: Record<string, string>): void {
  for (const prov of state.provinces) prov.ownerId = null;
  for (const [id, pid] of Object.entries(owners)) {
    const prov = state.provinces.find((p) => p.id === id);
    if (prov) prov.ownerId = pid;
  }
  for (const player of state.players) player.objectives = [];
}

/** Append a raw combat log entry for the CURRENT round (bypassing the factory). */
function pushLog(state: GameState, entry: Partial<GameLogEntry>): void {
  state.log.push({
    id: `log-${state.logCounter++}`,
    round: state.round,
    phase: GamePhase.COMBAT,
    type: "battle",
    actors: [],
    message: "",
    timestamp: state.clock++,
    ...entry,
  } as GameLogEntry);
}

const prestigeOf = (s: GameState, id: string) =>
  s.players.find((p) => p.id === id)!.prestige;

/** A high-value province that is NOT a capital (a §13.1 "named key city"). */
function keyCityId(state: GameState): string {
  return state.provinces.find((p) => (p.highValue ?? 0) > 0 && !p.isCapitalOf)!.id;
}

/** A plain province: neither a capital nor high-value (scores nothing on its own). */
function plainId(state: GameState): string {
  return state.provinces.find((p) => !p.isCapitalOf && !(p.highValue ?? 0))!.id;
}

// ---------------------------------------------------------------------------
// §13.1 Per-round prestige sources
// ---------------------------------------------------------------------------

describe("scorePrestige — §13.1 prestige sources", () => {
  it("§13.1 hold your own capital → +1", () => {
    const s = fresh();
    isolate(s, { constantinople: "p1" }); // Byzantine capital, held by Byzantium
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.holdOwnCapitalPerRound);
    expect(PRESTIGE_VALUES.holdOwnCapitalPerRound).toBe(1);
  });

  it("§13.1 hold an enemy capital → +3", () => {
    const s = fresh();
    isolate(s, { edirne: "p1" }); // Ottoman capital, held by Byzantium
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.holdEnemyCapitalPerRound);
    expect(PRESTIGE_VALUES.holdEnemyCapitalPerRound).toBe(3);
  });

  it("§13.1 hold a named key city → +1 each", () => {
    const s = fresh();
    const key = keyCityId(s);
    isolate(s, { [key]: "p1" });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.holdKeyCityPerRound);
    expect(PRESTIGE_VALUES.holdKeyCityPerRound).toBe(1);
  });

  it("§13.1 a capital is not double-scored as a key city", () => {
    const s = fresh();
    isolate(s, { constantinople: "p1" }); // capital AND highValue=5
    const out = scorePrestige(s);
    // Only the +1 own-capital source, not an extra +1 key-city.
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.holdOwnCapitalPerRound);
  });

  it("§13.1 trade monopoly → +2 (via posted monopoly)", () => {
    const s = fresh();
    isolate(s, {});
    s.activeModifiers.push({
      id: "m-mono",
      scope: "round",
      kind: "trade_monopoly",
      data: { playerId: "p1" },
    });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.tradeMonopolyPerRound);
    expect(PRESTIGE_VALUES.tradeMonopolyPerRound).toBe(2);
  });

  it("§13.1 win a decisive battle → +1 (consumed from prestige_pending)", () => {
    // CANON/§13 conquest track: combat POSTS the +1 as a prestige_pending
    // modifier; scorePrestige consumes it (never scans the battle log for it).
    const s = fresh();
    isolate(s, {});
    s.activeModifiers.push({
      id: "pp-decisive",
      scope: "round",
      kind: "prestige_pending",
      target: { faction: Faction.BYZANTIUM },
      value: PRESTIGE_VALUES.decisiveBattleWin,
      data: { reason: "decisive_battle", source: "combat" },
    });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.decisiveBattleWin);
    expect(PRESTIGE_VALUES.decisiveBattleWin).toBe(1);
    // Folded into the running conquest total and consumed exactly once.
    expect(out.players.find((p) => p.id === "p1")!.conquestPrestige).toBe(1);
    expect(out.activeModifiers.some((m) => m.kind === "prestige_pending")).toBe(false);
  });

  it("§13 a raw battle log is NOT scored (prestige_pending is the only path)", () => {
    // Guards against double-counting: scorePrestige must ignore combat logs for
    // conquest awards, since combat posts prestige_pending instead.
    const s = fresh();
    isolate(s, {});
    pushLog(s, { type: "battle", actors: ["p1", "p2"], data: { winnerId: "p1" } });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(0);
    expect(prestigeOf(out, "p2")).toBe(0);
  });

  it("§13 conquest track: take a walled city → +2/+3 (from prestige_pending)", () => {
    const s = fresh();
    isolate(s, {});
    s.activeModifiers.push({
      id: "pp-walled",
      scope: "round",
      kind: "prestige_pending",
      target: { faction: Faction.OTTOMAN },
      value: 3, // T4–T5 walled city (combat computed the +3)
      data: { reason: "take_walled_city", source: "combat" },
    });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p2")).toBe(3);
    expect(out.players.find((p) => p.id === "p2")!.conquestPrestige).toBe(3);
  });

  it("§13 prestige_pending is consumed only ONCE across cleanups", () => {
    const s = fresh();
    isolate(s, {});
    s.activeModifiers.push({
      id: "pp-once",
      scope: "round",
      kind: "prestige_pending",
      target: { faction: Faction.BYZANTIUM },
      value: PRESTIGE_VALUES.decisiveBattleWin,
      data: { reason: "decisive_battle" },
    });
    const first = scorePrestige(s);
    expect(prestigeOf(first, "p1")).toBe(1);
    // The modifier is gone; a second cleanup does not re-award it.
    const second = scorePrestige(first);
    expect(prestigeOf(second, "p1")).toBe(1);
  });

  it("§13.1 win a war → +3 (from prestige_pending posted by diplomacy)", () => {
    const s = fresh();
    isolate(s, {});
    s.activeModifiers.push({
      id: "pp-war",
      scope: "round",
      kind: "prestige_pending",
      target: { faction: Faction.OTTOMAN },
      value: PRESTIGE_VALUES.winWar,
      data: { reason: "win_war", source: "diplomacy" },
    });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p2")).toBe(PRESTIGE_VALUES.winWar);
    expect(PRESTIGE_VALUES.winWar).toBe(3);
    expect(out.activeModifiers.some((m) => m.kind === "prestige_pending")).toBe(false);
  });

  it("§13.1 lose your own capital → −3 (rightful owner dispossessed)", () => {
    const s = fresh();
    isolate(s, { edirne: "p1" }); // p1 has just taken the Ottoman capital
    // Battle log: attacker p1 beats defender p2 (Ottoman) at edirne. The −3
    // lose-capital penalty is log-derived; the captor's +1 decisive award arrives
    // separately as a prestige_pending (posted by combat).
    pushLog(s, { type: "battle", actors: ["p1", "p2"], targets: ["edirne"], data: { winnerId: "p1" } });
    s.activeModifiers.push({
      id: "pp-cap",
      scope: "round",
      kind: "prestige_pending",
      target: { faction: Faction.BYZANTIUM },
      value: PRESTIGE_VALUES.decisiveBattleWin,
      data: { reason: "decisive_battle", source: "combat" },
    });
    const out = scorePrestige(s);
    // p2 (Ottoman) lost its own capital.
    expect(prestigeOf(out, "p2")).toBe(PRESTIGE_VALUES.loseCapital);
    expect(PRESTIGE_VALUES.loseCapital).toBe(-3);
    // p1 gains enemy-capital hold (+3) plus the decisive-battle win (+1).
    expect(prestigeOf(out, "p1")).toBe(
      PRESTIGE_VALUES.holdEnemyCapitalPerRound + PRESTIGE_VALUES.decisiveBattleWin,
    );
  });
});

// ---------------------------------------------------------------------------
// DELTA 2 — trade-monopoly prestige is DIMINISHING (§13.1 + ratified ruling)
// ---------------------------------------------------------------------------

describe("scorePrestige — DELTA 2 diminishing trade monopoly (§13.1 + ruling)", () => {
  /** Post an explicit trade_monopoly modifier crediting `playerId` (one route). */
  function pushMonopoly(state: GameState, id: string, playerId: string): void {
    state.activeModifiers.push({
      id,
      scope: "round",
      kind: "trade_monopoly",
      data: { playerId },
    });
  }

  it("a SINGLE monopoly scores MONOPOLY_PRESTIGE.first (= +2)", () => {
    const s = fresh();
    isolate(s, {});
    pushMonopoly(s, "m1", "p1");
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(MONOPOLY_PRESTIGE.first);
    expect(MONOPOLY_PRESTIGE.first).toBe(2);
  });

  it("a SECOND monopoly adds only MONOPOLY_PRESTIGE.additional, not another first", () => {
    const s = fresh();
    isolate(s, {});
    pushMonopoly(s, "m1", "p1");
    pushMonopoly(s, "m2", "p1");
    const out = scorePrestige(s);
    // Diminishing: first + additional, NOT 2 * first (which the old flat +2 gave).
    expect(prestigeOf(out, "p1")).toBe(
      MONOPOLY_PRESTIGE.first + MONOPOLY_PRESTIGE.additional,
    );
    expect(MONOPOLY_PRESTIGE.additional).toBe(1);
  });

  it("THREE monopolies score first + 2 * additional (diminishing, not 3 * first)", () => {
    const s = fresh();
    isolate(s, {});
    pushMonopoly(s, "m1", "p1");
    pushMonopoly(s, "m2", "p1");
    pushMonopoly(s, "m3", "p1");
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(
      MONOPOLY_PRESTIGE.first + MONOPOLY_PRESTIGE.additional * 2,
    );
    // Guard against a regression to the old flat model (would be 3 * first = 6).
    expect(prestigeOf(out, "p1")).not.toBe(MONOPOLY_PRESTIGE.first * 3);
  });

  it("no monopoly scores nothing", () => {
    const s = fresh();
    isolate(s, {});
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §13.1/§13.3 Secret objectives — scored ONLY at game end (CANON #10)
// ---------------------------------------------------------------------------

describe("scorePrestige — §13.3 secret objectives scored only at game end", () => {
  function withObjective(state: GameState, playerId: string, provinceId: string): void {
    const obj: SecretObjective = {
      id: "obj-1",
      description: "Hold the frontier",
      provinceRefs: [provinceId],
      prestige: PRESTIGE_VALUES.secretObjective,
    };
    state.players.find((p) => p.id === playerId)!.objectives = [obj];
  }

  it("CANON #10: a satisfied objective is NOT scored mid-game", () => {
    const s = fresh(); // round 1, no threshold-crosser, not sudden death
    const plain = plainId(s);
    isolate(s, { [plain]: "p1" });
    withObjective(s, "p1", plain);
    const out = scorePrestige(s);
    // Objective held but game is not ending → not revealed, not scored.
    expect(prestigeOf(out, "p1")).toBe(0);
    expect(out.players.find((p) => p.id === "p1")!.objectives[0].completed).toBeFalsy();
  });

  it("§13.3 a satisfied objective is revealed & scored (+4) at game end (round 16)", () => {
    const s = fresh();
    s.round = 16; // the 1453 endgame ends the game this cleanup
    const plain = plainId(s);
    isolate(s, { [plain]: "p1" });
    withObjective(s, "p1", plain);
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.secretObjective);
    expect(PRESTIGE_VALUES.secretObjective).toBe(4);
    expect(out.players.find((p) => p.id === "p1")!.objectives[0].completed).toBe(true);
  });

  it("§13.3 an UNSATISFIED objective scores nothing at game end", () => {
    const s = fresh();
    s.round = 16;
    const plain = plainId(s);
    isolate(s, {}); // p1 owns nothing → objective unsatisfied
    withObjective(s, "p1", plain);
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(0);
    expect(out.players.find((p) => p.id === "p1")!.objectives[0].completed).toBeFalsy();
  });

  it("§13.3 objectives are scored when a threshold win ends the game", () => {
    const s = fresh(seats2); // round 1
    const plain = plainId(s);
    isolate(s, { [plain]: "p1" });
    withObjective(s, "p1", plain);
    s.players.find((p) => p.id === "p2")!.prestige = 72; // p2 crosses 2p threshold 72 → game ends (balance §2.13 @ac39705)
    const out = scorePrestige(s);
    // p1's objective is revealed at the terminating cleanup.
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.secretObjective);
  });

  // ---- DELTA 4: each secret objective scores +4 INDEPENDENTLY (not a bundle) ---
  // §13.3 (ratified ruling): objectives are NOT an all-3 bundle — every satisfied
  // objective contributes its own +4 at game end. A player satisfying 2 of 3 scores
  // +8; 3 of 3 scores +12.
  it("DELTA 4 (§13.3): satisfying 2 of 3 objectives scores +8 (independent, not bundled)", () => {
    const s = fresh();
    s.round = 16;
    // Use INLAND (non-coastal) plains so owning them cannot incidentally form a
    // §13.1 sea-majority trade monopoly (DELTA 2) — this test isolates the
    // objective-scoring contribution alone.
    const plains = s.provinces
      .filter((p) => !p.isCapitalOf && !(p.highValue ?? 0) && !p.coastal)
      .slice(0, 3)
      .map((p) => p.id);
    expect(plains.length).toBe(3);
    // p1 owns the first two provinces but NOT the third.
    isolate(s, { [plains[0]]: "p1", [plains[1]]: "p1" });
    s.players.find((p) => p.id === "p1")!.objectives = plains.map((provId, i) => ({
      id: `obj-${i}`,
      description: `hold ${provId}`,
      provinceRefs: [provId],
      prestige: PRESTIGE_VALUES.secretObjective,
    }));
    const out = scorePrestige(s);
    // Two satisfied objectives × +4 each = +8; the third (unowned) scores nothing.
    expect(prestigeOf(out, "p1")).toBe(2 * PRESTIGE_VALUES.secretObjective);
    const objs = out.players.find((p) => p.id === "p1")!.objectives;
    expect(objs.filter((o) => o.completed).length).toBe(2);
    expect(objs.find((o) => o.id === "obj-2")!.completed).toBeFalsy();
  });

  it("DELTA 4 (§13.3): satisfying 3 of 3 objectives scores +12 (independent, not bundled)", () => {
    const s = fresh();
    s.round = 16;
    // Use INLAND (non-coastal) plains so owning all three cannot incidentally
    // form a §13.1 sea-majority trade monopoly (DELTA 2, +2) — this test measures
    // ONLY the three independent +4 objective awards (ratified DELTA 4).
    const plains = s.provinces
      .filter((p) => !p.isCapitalOf && !(p.highValue ?? 0) && !p.coastal)
      .slice(0, 3)
      .map((p) => p.id);
    expect(plains.length).toBe(3);
    isolate(s, { [plains[0]]: "p1", [plains[1]]: "p1", [plains[2]]: "p1" });
    s.players.find((p) => p.id === "p1")!.objectives = plains.map((provId, i) => ({
      id: `obj-${i}`,
      description: `hold ${provId}`,
      provinceRefs: [provId],
      prestige: PRESTIGE_VALUES.secretObjective,
    }));
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(3 * PRESTIGE_VALUES.secretObjective);
    expect(
      out.players.find((p) => p.id === "p1")!.objectives.every((o) => o.completed),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FL-06/07/08 secret-objective predicates (FACTIONS.md / §13.1)
// ---------------------------------------------------------------------------

describe("scorePrestige — FL-06/07/08 secret-objective predicates", () => {
  /** Wipe all ownership + every player's objectives (caller re-seeds a target). */
  function blank(state: GameState): void {
    for (const prov of state.provinces) prov.ownerId = null;
    for (const player of state.players) player.objectives = [];
  }
  const own = (s: GameState, provId: string, pid: string): void => {
    s.provinces.find((p) => p.id === provId)!.ownerId = pid;
  };
  const objsOf = (s: GameState, pid: string) =>
    s.players.find((p) => p.id === pid)!.objectives;
  const seededObj = (s: GameState, pid: string, id: string): SecretObjective =>
    objsOf(s, pid).find((o) => o.id === id)!;
  const setObjective = (s: GameState, pid: string, obj: SecretObjective): void => {
    s.players.find((p) => p.id === pid)!.objectives = [obj];
  };
  const completed = (out: GameState, pid: string): boolean | undefined =>
    out.players.find((p) => p.id === pid)!.objectives[0].completed;

  // ---- FL-06 Restoration of the Empire (allOf + anyOf OR-clause) ----------
  it("FL-06 Restoration: allOf held + one anyOf → completed at game end", () => {
    const s = fresh();
    const restoration = seededObj(s, "p1", "byz-restoration-of-the-empire");
    // Seed is now an OR-clause, not an AND of all four provinces.
    expect(restoration.allOf).toEqual(["thessalonica", "morea"]);
    expect(restoration.anyOf).toEqual(["nicaea", "athens"]);
    blank(s);
    setObjective(s, "p1", restoration);
    s.round = 16;
    own(s, "thessalonica", "p1");
    own(s, "morea", "p1");
    own(s, "nicaea", "p1"); // one of the anyOf, but NOT athens
    const out = scorePrestige(s);
    expect(completed(out, "p1")).toBe(true);
  });

  it("FL-06 Restoration: allOf held but NEITHER anyOf → not completed", () => {
    const s = fresh();
    const restoration = seededObj(s, "p1", "byz-restoration-of-the-empire");
    blank(s);
    setObjective(s, "p1", restoration);
    s.round = 16;
    own(s, "thessalonica", "p1");
    own(s, "morea", "p1"); // no nicaea / athens
    const out = scorePrestige(s);
    expect(completed(out, "p1")).toBeFalsy();
  });

  it("FL-06 Restoration: missing a required allOf province → not completed", () => {
    const s = fresh();
    const restoration = seededObj(s, "p1", "byz-restoration-of-the-empire");
    blank(s);
    setObjective(s, "p1", restoration);
    s.round = 16;
    own(s, "thessalonica", "p1"); // morea missing
    own(s, "athens", "p1");
    const out = scorePrestige(s);
    expect(completed(out, "p1")).toBeFalsy();
  });

  // ---- FL-08 Faith of the Fathers (constantinople held + never sacked +
  //      faith + refusal) — coordinator ruling 1: NO Hagia Sophia great work -
  it("FL-08 Faith of the Fathers: constantinople ownership ALONE no longer scores", () => {
    const s = fresh();
    const faith = seededObj(s, "p1", "byz-faith-of-the-fathers");
    // Seed keeps requiresHagiaSophia as the switch, but its meaning is now
    // "constantinople not sacked" — NOT a completed great work (ruling 1).
    expect(faith.requiresHagiaSophia).toBe(true);
    expect(faith.minFaith).toBe(15);
    expect(faith.refusedChurchUnion).toBe(true);
    blank(s);
    setObjective(s, "p1", faith);
    s.round = 16;
    own(s, "constantinople", "p1");
    s.players.find((p) => p.id === "p1")!.treasury.faith = 4; // < 15
    const out = scorePrestige(s);
    // Phantom +4 removed: ownership without the faith/refusal gate no longer completes it.
    expect(completed(out, "p1")).toBeFalsy();
  });

  it("FL-08 Faith of the Fathers: held + never sacked + faith≥15 + Union refused → completed (no Hagia Sophia great work needed)", () => {
    const s = fresh();
    const faith = seededObj(s, "p1", "byz-faith-of-the-fathers");
    blank(s);
    setObjective(s, "p1", faith);
    s.round = 16;
    own(s, "constantinople", "p1");
    // Ruling 1: the HAGIA_SOPHIA great work is a standing building, NOT required —
    // deliberately do NOT seed any greatWorks on the City.
    const cple = s.provinces.find((p) => p.id === "constantinople")!;
    expect(cple.greatWorks.some((gw) => gw.type === GreatWorkType.HAGIA_SOPHIA)).toBe(false);
    cple.sacked = false; // never taken by assault
    s.players.find((p) => p.id === "p1")!.treasury.faith = 15;
    // acceptedChurchUnion undefined ⇒ "refused" (Prep4/FIX-PREP2 default).
    const out = scorePrestige(s);
    expect(completed(out, "p1")).toBe(true);
  });

  it("FL-08 Faith of the Fathers: a SACKED constantinople fails it (assault-captured, faith/refusal met)", () => {
    const s = fresh();
    const faith = seededObj(s, "p1", "byz-faith-of-the-fathers");
    blank(s);
    setObjective(s, "p1", faith);
    s.round = 16;
    own(s, "constantinople", "p1"); // held at game end (e.g. retaken)
    s.provinces.find((p) => p.id === "constantinople")!.sacked = true; // stormed at some point
    s.players.find((p) => p.id === "p1")!.treasury.faith = 20; // faith + refusal both met
    const out = scorePrestige(s);
    // "Hagia Sophia intact" broken by the sack ⇒ objective fails despite the other gates.
    expect(completed(out, "p1")).toBeFalsy();
  });

  it("FL-08 Faith of the Fathers: faith below 15 → not completed", () => {
    const s = fresh();
    const faith = seededObj(s, "p1", "byz-faith-of-the-fathers");
    blank(s);
    setObjective(s, "p1", faith);
    s.round = 16;
    own(s, "constantinople", "p1");
    s.provinces.find((p) => p.id === "constantinople")!.sacked = false;
    s.players.find((p) => p.id === "p1")!.treasury.faith = 14; // one short
    const out = scorePrestige(s);
    expect(completed(out, "p1")).toBeFalsy();
  });

  it("FL-08 Faith of the Fathers: accepting Church Union blocks it", () => {
    const s = fresh();
    const faith = seededObj(s, "p1", "byz-faith-of-the-fathers");
    blank(s);
    setObjective(s, "p1", faith);
    s.round = 16;
    own(s, "constantinople", "p1");
    s.provinces.find((p) => p.id === "constantinople")!.sacked = false;
    s.players.find((p) => p.id === "p1")!.treasury.faith = 20;
    // Prep4 canonical field: the player accepted the Union ⇒ predicate blocked.
    s.players.find((p) => p.id === "p1")!.acceptedChurchUnion = true;
    const out = scorePrestige(s);
    expect(completed(out, "p1")).toBeFalsy();
  });

  // ---- FL-07 Ghazi Empire (minProvinces OR sackedHighValueCities) ---------
  it("FL-07 Ghazi Empire: ≥15 provinces at game end → completed", () => {
    const s = fresh();
    const ghazi = seededObj(s, "p2", "ott-ghazi-empire");
    expect(ghazi.provinceRefs).toEqual([]); // non-territorial: no longer unreachable
    expect(ghazi.minProvinces).toBe(15);
    expect(ghazi.sackedHighValueCities).toBe(3);
    blank(s);
    setObjective(s, "p2", ghazi);
    s.round = 16;
    const plains = s.provinces
      .filter((p) => !p.isCapitalOf && !(p.highValue ?? 0))
      .slice(0, 15);
    expect(plains.length).toBe(15);
    for (const p of plains) p.ownerId = "p2";
    const out = scorePrestige(s);
    expect(completed(out, "p2")).toBe(true);
  });

  it("FL-07 Ghazi Empire: sacking 3 HV cities → completed (province gate unmet)", () => {
    const s = fresh();
    const ghazi = seededObj(s, "p2", "ott-ghazi-empire");
    blank(s);
    setObjective(s, "p2", ghazi); // p2 owns nothing → minProvinces fails
    s.round = 16;
    // Prep4 canonical counter (incremented by combat on HV-city capture).
    s.players.find((p) => p.id === "p2")!.sackedHighValueCities = 3;
    const out = scorePrestige(s);
    expect(completed(out, "p2")).toBe(true);
  });

  it("FL-07 Ghazi Empire: neither gate met → not completed", () => {
    const s = fresh();
    const ghazi = seededObj(s, "p2", "ott-ghazi-empire");
    blank(s);
    setObjective(s, "p2", ghazi); // owns nothing, no sacks
    s.round = 16;
    const out = scorePrestige(s);
    expect(completed(out, "p2")).toBeFalsy();
  });

  it("FL-07 Ghazi Empire: only 2 HV sacks is not enough", () => {
    const s = fresh();
    const ghazi = seededObj(s, "p2", "ott-ghazi-empire");
    blank(s);
    setObjective(s, "p2", ghazi);
    s.round = 16;
    // Counter below the threshold of 3 ⇒ sack gate unmet.
    s.players.find((p) => p.id === "p2")!.sackedHighValueCities = 2;
    const out = scorePrestige(s);
    expect(completed(out, "p2")).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// FL-20 Uncontested capture of a capital → −3 lose-capital penalty (§13.1)
// ---------------------------------------------------------------------------

describe("scorePrestige — FL-20 uncontested capital occupation", () => {
  it("§13.1 an unopposed march into an enemy CAPITAL applies −3 to its owner", () => {
    const s = fresh();
    isolate(s, { edirne: "p1" }); // p1 occupies the (empty) Ottoman capital
    // Occupation log as actions.ts::relocate emits it: attacker only, no
    // defender, `occupied:true`, no winnerId (the real integration contract).
    pushLog(s, { type: "battle", actors: ["p1"], targets: ["edirne"], data: { occupied: true } });
    const out = scorePrestige(s);
    // p2 (Ottoman) is dispossessed of its capital → −3.
    expect(prestigeOf(out, "p2")).toBe(PRESTIGE_VALUES.loseCapital);
    // p1 still accrues the +3 enemy-capital hold (no prestige_pending in this fixture).
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.holdEnemyCapitalPerRound);
  });

  it("§13.1 an unopposed occupation of a NON-capital applies no −3", () => {
    const s = fresh();
    const plain = plainId(s);
    isolate(s, { [plain]: "p1" });
    pushLog(s, { type: "battle", actors: ["p1"], targets: [plain], data: { occupied: true } });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(0);
    expect(prestigeOf(out, "p2")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Coordination boundary — sources owned by OTHER subsystems (no double count)
// ---------------------------------------------------------------------------

describe("scorePrestige — coordination boundary (no double count)", () => {
  it("does NOT re-award great-work prestige (economy owns completion)", () => {
    const s = fresh();
    const plain = plainId(s);
    isolate(s, { [plain]: "p1" });
    const prov = s.provinces.find((p) => p.id === plain)!;
    prov.greatWorks = [{ type: GreatWorkType.HAGIA_SOPHIA, progress: 3 }]; // complete
    const out = scorePrestige(s);
    // No +10 here; economy.completeGreatWork already awarded it at build time.
    expect(prestigeOf(out, "p1")).toBe(0);
  });

  it("does NOT award vassal/royal-marriage prestige (diplomacy.runRevolts owns it)", () => {
    const s = fresh();
    isolate(s, {});
    const p1 = s.players.find((p) => p.id === "p1")!;
    p1.vassals = ["serbia"];
    p1.treaties = [
      {
        id: "t-marriage",
        type: TreatyType.ROYAL_MARRIAGE,
        parties: ["p1", "p2"],
        expiresRound: null,
      },
    ];
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(0);
    expect(prestigeOf(out, "p2")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §13.3 Constantinople sudden death (2 consecutive cleanups)
// ---------------------------------------------------------------------------

describe("scorePrestige / checkVictory — §13.3 Constantinople sudden death", () => {
  it("increments the hold counter while a foreign power holds the City", () => {
    const s = fresh();
    isolate(s, { constantinople: "p2" }); // Ottoman holds the City
    s.constantinopleHold = { faction: null, rounds: 0 };
    const first = scorePrestige(s);
    // First cleanup under Ottoman control → 1 round held, not yet a win.
    expect(first.constantinopleHold).toEqual({ faction: Faction.OTTOMAN, rounds: 1 });
    expect(checkVictory(first)).toBeNull();
  });

  it("§13.3 holding the City through two cleanups wins immediately", () => {
    const s = fresh();
    isolate(s, { constantinople: "p2" });
    s.constantinopleHold = { faction: Faction.OTTOMAN, rounds: 1 };
    const out = scorePrestige(s);
    expect(out.constantinopleHold.rounds).toBe(2);
    expect(checkVictory(out)).toBe(Faction.OTTOMAN);
  });

  it("§13.3 the counter resets when the City changes hands", () => {
    const s = fresh();
    isolate(s, { constantinople: "p1" }); // Byzantium retakes its own capital
    s.constantinopleHold = { faction: Faction.OTTOMAN, rounds: 1 };
    const out = scorePrestige(s);
    // Rightful owner back in control → clock disarmed.
    expect(out.constantinopleHold).toEqual({ faction: null, rounds: 0 });
    expect(checkVictory(out)).toBeNull();
  });

  it("§13.3 the rightful owner holding the City never triggers sudden death", () => {
    const s = fresh();
    // Byzantium has held its capital for many rounds.
    s.constantinopleHold = { faction: Faction.BYZANTIUM, rounds: 9 };
    const cple = s.provinces.find((p) => p.id === "constantinople")!;
    cple.ownerId = "p1";
    expect(checkVictory(s)).toBeNull();
  });

  // ---- DELTA 6: sudden death OUTRANKS a same-cleanup threshold win -----------
  // §13.2/§13.3 (ratified ruling): if a foreign power's 2-cleanup Constantinople
  // hold AND a prestige-threshold crossing both resolve in the SAME cleanup, the
  // sudden-death Fall of Constantinople wins — regardless of prestige.
  it("DELTA 6 (§13.2/§13.3): sudden death beats a same-cleanup threshold win", () => {
    const s = fresh(seats2);
    // Ottoman (p2) holds Byzantium's capital through its second cleanup.
    const cple = s.provinces.find((p) => p.id === "constantinople")!;
    cple.ownerId = "p2";
    s.constantinopleHold = { faction: Faction.OTTOMAN, rounds: 2 };
    // Simultaneously, Byzantium (p1) is far over the prestige threshold this cleanup.
    s.players.find((p) => p.id === "p1")!.prestige = 100; // >> 2p threshold 72 (balance §2.13 @ac39705)
    // Both triggers fire; sudden death (Ottoman) wins, NOT the prestige leader.
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("DELTA 6 (§13.3): a 1-cleanup hold does NOT pre-empt a threshold win", () => {
    const s = fresh(seats2);
    const cple = s.provinces.find((p) => p.id === "constantinople")!;
    cple.ownerId = "p2";
    // Only one cleanup held → sudden death not yet armed.
    s.constantinopleHold = { faction: Faction.OTTOMAN, rounds: 1 };
    s.players.find((p) => p.id === "p1")!.prestige = 80; // over 2p threshold 72 (balance §2.13 @ac39705)
    // Threshold win stands for Byzantium; sudden death has not triggered.
    expect(checkVictory(s)).toBe(Faction.BYZANTIUM);
  });
});

// ---------------------------------------------------------------------------
// §13.2 Prestige thresholds by player count
// ---------------------------------------------------------------------------

describe("checkVictory — §13.2 prestige threshold", () => {
  // Per-count victory thresholds re-keyed to the FINAL §2.13 table
  // (VICTORY_THRESHOLD_BY_PLAYER_COUNT): 2p=72, 3p=75, 4p=80, 5p=78 —
  // balance STACKING-config re-sweep @ac39705 (supersedes 71/74/76/78; 4p=80 is
  // tie-break-driven, 76 the monotonic alternative).
  it("2 players → threshold 72", () => {
    expect(PRESTIGE_THRESHOLDS[2]).toBe(72);
    const s = fresh(seats2);
    s.players.find((p) => p.id === "p1")!.prestige = 71;
    expect(checkVictory(s)).toBeNull();
    s.players.find((p) => p.id === "p1")!.prestige = 72;
    expect(checkVictory(s)).toBe(Faction.BYZANTIUM);
  });

  it("3 players → threshold 75", () => {
    expect(PRESTIGE_THRESHOLDS[3]).toBe(75);
    const s = fresh(seats3);
    s.players.find((p) => p.id === "p2")!.prestige = 74;
    expect(checkVictory(s)).toBeNull();
    s.players.find((p) => p.id === "p2")!.prestige = 75;
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("4 players → threshold 80", () => {
    expect(PRESTIGE_THRESHOLDS[4]).toBe(80);
    const s = fresh(seats4);
    s.players.find((p) => p.id === "p4")!.prestige = 79;
    expect(checkVictory(s)).toBeNull();
    s.players.find((p) => p.id === "p4")!.prestige = 80;
    expect(checkVictory(s)).toBe(Faction.HUNGARY);
  });

  it("§13.2 when several cross the same cleanup, highest prestige wins", () => {
    const s = fresh(seats2);
    s.players.find((p) => p.id === "p1")!.prestige = 74; // over 2p threshold 72
    s.players.find((p) => p.id === "p2")!.prestige = 80; // higher → wins (balance §2.13 @ac39705)
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  // CLARIFICATION §13.3 cap tiebreak: at the prestige cap, when several cross with
  // EQUAL prestige the tiebreak order is most key/high-value cities, THEN most gold.
  it("§13.3 cap tiebreak: equal prestige at the cap breaks on most key cities", () => {
    const s = fresh(seats2);
    const key = keyCityId(s);
    isolate(s, { [key]: "p2" }); // p2 holds one more key city
    // Both are at the 2-player threshold (72) with equal prestige (balance §2.13 @ac39705).
    s.players.find((p) => p.id === "p1")!.prestige = 72;
    s.players.find((p) => p.id === "p2")!.prestige = 72;
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("§13.3 cap tiebreak: equal prestige AND key cities breaks on most gold", () => {
    const s = fresh(seats2);
    isolate(s, {}); // neither holds a key city
    s.players.find((p) => p.id === "p1")!.prestige = 72;
    s.players.find((p) => p.id === "p2")!.prestige = 72;
    s.players.find((p) => p.id === "p1")!.treasury.gold = 4;
    s.players.find((p) => p.id === "p2")!.treasury.gold = 11; // more gold → p2
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("CANON #3 / §13.2: victory is only checked at Cleanup (END phase)", () => {
    const s = fresh(seats2);
    s.players.find((p) => p.id === "p1")!.prestige = 80; // over 2p threshold 72 (balance §2.13 @ac39705)
    // Mid-round: threshold crossing must NOT win outside Cleanup.
    for (const phase of [
      GamePhase.INCOME,
      GamePhase.RECRUITMENT,
      GamePhase.MOVEMENT,
      GamePhase.COMBAT,
      GamePhase.DIPLOMACY,
    ]) {
      s.phase = phase;
      expect(checkVictory(s)).toBeNull();
    }
    // Only at Cleanup does the threshold win land.
    s.phase = GamePhase.END;
    expect(checkVictory(s)).toBe(Faction.BYZANTIUM);
  });
});

// ---------------------------------------------------------------------------
// §13.3 Round-16 endgame: highest prestige, tiebreak key cities then gold
// ---------------------------------------------------------------------------

describe("checkVictory — §13.3 round-16 endgame & tiebreaks", () => {
  it("round 16 with no threshold-crosser → highest prestige wins", () => {
    const s = fresh(seats2);
    s.round = 16;
    isolate(s, {});
    s.players.find((p) => p.id === "p1")!.prestige = 8;
    s.players.find((p) => p.id === "p2")!.prestige = 12;
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("§13.3 tie on prestige breaks on most key cities", () => {
    const s = fresh(seats2);
    s.round = 16;
    const key = keyCityId(s);
    isolate(s, { [key]: "p2" }); // p2 holds one more key city
    s.players.find((p) => p.id === "p1")!.prestige = 10;
    s.players.find((p) => p.id === "p2")!.prestige = 10;
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("§13.3 tie on prestige AND key cities breaks on most gold", () => {
    const s = fresh(seats2);
    s.round = 16;
    isolate(s, {}); // neither holds any key city
    s.players.find((p) => p.id === "p1")!.prestige = 10;
    s.players.find((p) => p.id === "p2")!.prestige = 10;
    s.players.find((p) => p.id === "p1")!.treasury.gold = 3;
    s.players.find((p) => p.id === "p2")!.treasury.gold = 9;
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("before round 16, a sub-threshold leader does not win", () => {
    const s = fresh(seats2);
    s.round = 10;
    s.players.find((p) => p.id === "p1")!.prestige = 20; // below 25
    expect(checkVictory(s)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Marshal review B4/B5 + the 4 OR/count majors — re-encoded secret objectives
// ---------------------------------------------------------------------------

const seats5: SeatInput[] = [
  ...seats4,
  { id: "p5", name: "Doria", faction: Faction.GENOA, isHost: false },
];

describe("scorePrestige — B4/B5 re-encoded secret objectives (marshal review)", () => {
  /** Wipe all ownership + every player's objectives (caller re-seeds a target). */
  function blank(state: GameState): void {
    for (const prov of state.provinces) prov.ownerId = null;
    for (const player of state.players) player.objectives = [];
  }
  const own = (s: GameState, provId: string, pid: string): void => {
    s.provinces.find((p) => p.id === provId)!.ownerId = pid;
  };
  const seededObj = (s: GameState, pid: string, id: string): SecretObjective =>
    s.players.find((p) => p.id === pid)!.objectives.find((o) => o.id === id)!;

  /**
   * STATE-DELTA scorer: score the state twice — once with `obj` as `pid`'s sole
   * objective, once with none — and return the prestige DELTA plus the revealed
   * `completed` flag. The delta isolates the objective's own +4 from the
   * incidental §13.1 accruals (capitals / key cities / sea-majority monopolies)
   * that the same ownership fixture produces, so a passing test proves the
   * objective itself SCORED, not merely that something was posted.
   */
  function scoreObjective(
    s: GameState,
    pid: string,
    obj: SecretObjective,
  ): { delta: number; completed: boolean } {
    const prestigeAt = (st: GameState): number =>
      st.players.find((p) => p.id === pid)!.prestige;
    const withObj = structuredClone(s);
    withObj.players.find((p) => p.id === pid)!.objectives = [structuredClone(obj)];
    const without = structuredClone(s);
    without.players.find((p) => p.id === pid)!.objectives = [];
    const scored = scorePrestige(withObj);
    return {
      delta: prestigeAt(scored) - prestigeAt(scorePrestige(without)),
      completed:
        scored.players.find((p) => p.id === pid)!.objectives[0].completed === true,
    };
  }

  // ---- ven-stato-da-mar (count major: "8 ports" clause was dropped) --------
  it("ven-stato-da-mar (FACTIONS L176): 8 ports incl. the 3 mandatory → scores +4 at game end", () => {
    const s = fresh(seats3);
    const obj = seededObj(s, "p3", "ven-stato-da-mar");
    expect(obj.minPorts).toBe(8); // the restored count clause
    expect(obj.provinceRefs).toEqual(["crete", "negroponte", "corfu"]);
    blank(s);
    s.round = 16;
    const ports = ["crete", "negroponte", "corfu", "modon", "dalmatia", "athens", "smyrna", "cyprus"];
    for (const id of ports) own(s, id, "p3");
    const r = scoreObjective(s, "p3", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("ven-stato-da-mar: only 7 ports (mandatory 3 held) → count clause unmet, no +4", () => {
    const s = fresh(seats3);
    const obj = seededObj(s, "p3", "ven-stato-da-mar");
    blank(s);
    s.round = 16;
    for (const id of ["crete", "negroponte", "corfu", "modon", "dalmatia", "athens", "smyrna"]) {
      own(s, id, "p3"); // 7 coastal ports — one short of 8
    }
    const r = scoreObjective(s, "p3", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  // ---- ven-monopoly-of-the-straits (B4: sea-zone id in provinceRefs) -------
  it("ven-monopoly-of-the-straits (B4, FACTIONS L177-178): a fleet in the bosphorus SEA ZONE + any 3 Aegean islands → +4 (was unsatisfiable)", () => {
    const s = fresh(seats3);
    const obj = seededObj(s, "p3", "ven-monopoly-of-the-straits");
    // B4 root cause fixed at the seed: no sea-zone id left in provinceRefs.
    expect(obj.provinceRefs).toEqual([]);
    expect(obj.minOfProvinces).toEqual([
      { provinceIds: ["lemnos", "lesbos", "chios", "naxos", "negroponte"], min: 3 },
    ]);
    blank(s);
    s.round = 16;
    // 3 of the 5 named islands (deliberately NOT constantinople/pera)…
    for (const id of ["lemnos", "lesbos", "naxos"]) own(s, id, "p3");
    // …and a Venetian fleet stack located IN the bosphorus sea zone.
    s.fleets.push({
      id: "fleet-p3-bosphorus",
      ownerId: "p3",
      locationId: "bosphorus",
      units: { ...emptyUnits(), [UnitType.WARSHIP]: 1 },
    });
    const r = scoreObjective(s, "p3", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("ven-monopoly-of-the-straits (B4): fleet parked elsewhere and no constantinople/pera → straits branch unmet", () => {
    const s = fresh(seats3);
    const obj = seededObj(s, "p3", "ven-monopoly-of-the-straits");
    blank(s);
    s.round = 16;
    for (const id of ["lemnos", "lesbos", "naxos"]) own(s, id, "p3");
    s.fleets.push({
      id: "fleet-p3-aegean",
      ownerId: "p3",
      locationId: "aegean", // NOT the bosphorus
      units: { ...emptyUnits(), [UnitType.WARSHIP]: 1 },
    });
    const r = scoreObjective(s, "p3", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  it("ven-monopoly-of-the-straits: holding pera satisfies the straits branch without any fleet", () => {
    const s = fresh(seats3);
    const obj = seededObj(s, "p3", "ven-monopoly-of-the-straits");
    blank(s);
    s.round = 16;
    for (const id of ["pera", "chios", "naxos", "negroponte"]) own(s, id, "p3");
    const r = scoreObjective(s, "p3", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("ven-monopoly-of-the-straits: straits branch met but only 2 islands → count clause fails", () => {
    const s = fresh(seats3);
    const obj = seededObj(s, "p3", "ven-monopoly-of-the-straits");
    blank(s);
    s.round = 16;
    for (const id of ["constantinople", "lemnos", "lesbos"]) own(s, id, "p3");
    const r = scoreObjective(s, "p3", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  // ---- ven-queen-of-the-adriatic (B4: 'adriatic' sea-zone id + OR branch) --
  it("ven-queen-of-the-adriatic (B4, FACTIONS L179-180): 4 Adriatic ports + a destroyed Genoese fleet → +4 (was unsatisfiable)", () => {
    const s = fresh(seats3);
    const obj = seededObj(s, "p3", "ven-queen-of-the-adriatic");
    expect(obj.provinceRefs).toEqual([]); // the 'adriatic' sea-zone id is gone
    expect(obj.allOf).toEqual(["venice", "dalmatia", "corfu", "ragusa"]);
    blank(s);
    s.round = 16;
    for (const id of ["venice", "dalmatia", "corfu", "ragusa"]) own(s, id, "p3");
    // combat.ts counter: one Genoese fleet wiped at sea over the game.
    s.players.find((p) => p.id === "p3")!.fleetsDestroyed = { [Faction.GENOA]: 1 };
    const r = scoreObjective(s, "p3", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("ven-queen-of-the-adriatic: seizing a Genoese colony instead of sinking a fleet also completes it", () => {
    const s = fresh(seats3);
    const obj = seededObj(s, "p3", "ven-queen-of-the-adriatic");
    blank(s);
    s.round = 16;
    for (const id of ["venice", "dalmatia", "corfu", "ragusa", "kaffa"]) own(s, id, "p3");
    const r = scoreObjective(s, "p3", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("ven-queen-of-the-adriatic: all 4 Adriatic ports but NEITHER or-branch → not completed", () => {
    const s = fresh(seats3);
    const obj = seededObj(s, "p3", "ven-queen-of-the-adriatic");
    blank(s);
    s.round = 16;
    for (const id of ["venice", "dalmatia", "corfu", "ragusa"]) own(s, id, "p3");
    const r = scoreObjective(s, "p3", obj); // no fleet kill, no colony
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  // ---- gen-dominium-maris (B4: black-sea-* sea-zone ids in provinceRefs) ---
  it("gen-dominium-maris (B4, FACTIONS L220-221): kaffa+chios+another port, Black Sea unblockaded → +4 (was unsatisfiable)", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-dominium-maris");
    // B4 root cause fixed at the seed: only PROVINCE ids remain in provinceRefs;
    // the zones moved to the naval blockade predicate.
    expect(obj.provinceRefs).toEqual(["kaffa", "chios"]);
    expect(obj.zonesNotEnemyBlockaded).toEqual(["black-sea-west", "black-sea-east"]);
    blank(s);
    s.round = 16;
    for (const id of ["kaffa", "chios", "lesbos"]) own(s, id, "p5");
    const r = scoreObjective(s, "p5", obj); // no blockades anywhere
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("gen-dominium-maris (B4): a RIVAL blockade on black-sea-west fails it at game end", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-dominium-maris");
    blank(s);
    s.round = 16;
    for (const id of ["kaffa", "chios", "lesbos"]) own(s, id, "p5");
    s.seaZones.find((z) => z.id === "black-sea-west")!.blockadedBy = "p3"; // Venice blockades
    const r = scoreObjective(s, "p5", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  it("gen-dominium-maris (B4): the player's OWN blockade of the zone does not fail it", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-dominium-maris");
    blank(s);
    s.round = 16;
    for (const id of ["kaffa", "chios", "lesbos"]) own(s, id, "p5");
    s.seaZones.find((z) => z.id === "black-sea-west")!.blockadedBy = "p5"; // self
    const r = scoreObjective(s, "p5", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("gen-dominium-maris: kaffa+chios but no OTHER Black Sea/Aegean port → not completed", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-dominium-maris");
    blank(s);
    s.round = 16;
    for (const id of ["kaffa", "chios"]) own(s, id, "p5");
    const r = scoreObjective(s, "p5", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  // ---- gen-bankers-of-kings (B5: had NO machine-checkable clause) ----------
  it("gen-bankers-of-kings (B5): strictly most gold of any player at game end → +4 (was never awardable)", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-bankers-of-kings");
    expect(obj.anyOfClauses).toEqual([{ minGold: 25, minDebtors: 2 }, { mostGold: true }]);
    blank(s);
    s.round = 16;
    for (const p of s.players) p.treasury.gold = 5;
    s.players.find((p) => p.id === "p5")!.treasury.gold = 12; // strictly richest
    const r = scoreObjective(s, "p5", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("gen-bankers-of-kings (B5): a gold TIE fails mostGold (strictly-highest, per the marshal ruling)", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-bankers-of-kings");
    blank(s);
    s.round = 16;
    for (const p of s.players) p.treasury.gold = 5;
    s.players.find((p) => p.id === "p5")!.treasury.gold = 12;
    s.players.find((p) => p.id === "p3")!.treasury.gold = 12; // Venice ties
    const r = scoreObjective(s, "p5", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  it("gen-bankers-of-kings (B5): ≥25 gold + 2 debtors completes even when NOT the richest", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-bankers-of-kings");
    blank(s);
    s.round = 16;
    for (const p of s.players) p.treasury.gold = 5;
    const genoa = s.players.find((p) => p.id === "p5")!;
    genoa.treasury.gold = 25;
    genoa.debtors = ["p1", "p2"]; // two factions in debt to Genoa
    s.players.find((p) => p.id === "p3")!.treasury.gold = 40; // Venice richer → mostGold fails
    const r = scoreObjective(s, "p5", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("gen-bankers-of-kings (B5): ≥25 gold but only ONE debtor and not richest → not completed", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-bankers-of-kings");
    blank(s);
    s.round = 16;
    for (const p of s.players) p.treasury.gold = 5;
    const genoa = s.players.find((p) => p.id === "p5")!;
    genoa.treasury.gold = 25;
    genoa.debtors = ["p1"];
    s.players.find((p) => p.id === "p3")!.treasury.gold = 40;
    const r = scoreObjective(s, "p5", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  // ---- gen-overshadow-the-lion (OR major: both branches were AND-ed) -------
  it("gen-overshadow-the-lion (FACTIONS L224-225): strictly more ports than Venice → +4 without any colony", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-overshadow-the-lion");
    expect(obj.provinceRefs).toEqual([]); // no longer an all-of of 5 colonies
    blank(s);
    s.round = 16;
    for (const id of ["kaffa", "chios"]) own(s, id, "p5"); // 2 Genoese ports
    own(s, "crete", "p3"); // Venice holds only 1 port
    const r = scoreObjective(s, "p5", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("gen-overshadow-the-lion: a port TIE with Venice and no colony → not completed (strict)", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-overshadow-the-lion");
    blank(s);
    s.round = 16;
    own(s, "kaffa", "p5"); // 1 port each — tie
    own(s, "crete", "p3");
    const r = scoreObjective(s, "p5", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  it("gen-overshadow-the-lion: capturing ONE Venetian colony completes it even with fewer ports", () => {
    const s = fresh(seats5);
    const obj = seededObj(s, "p5", "gen-overshadow-the-lion");
    blank(s);
    s.round = 16;
    own(s, "modon", "p5"); // a single captured Venetian colony (1 port)
    for (const id of ["crete", "negroponte", "corfu"]) own(s, id, "p3"); // Venice keeps 3
    const r = scoreObjective(s, "p5", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  // ---- hun-crusader (count major: "three of four" was AND-ed as all four) --
  it("hun-crusader (FACTIONS L264-265): varna + any 3 of the 4 Balkan neutrals → +4", () => {
    const s = fresh(seats4);
    const obj = seededObj(s, "p4", "hun-crusader");
    expect(obj.provinceRefs).toEqual(["varna"]);
    expect(obj.minOfProvinces).toEqual([
      { provinceIds: ["serbia", "bosnia", "wallachia", "albania"], min: 3 },
    ]);
    blank(s);
    s.round = 16;
    for (const id of ["varna", "serbia", "bosnia", "wallachia"]) own(s, id, "p4"); // NOT albania
    const r = scoreObjective(s, "p4", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("hun-crusader: varna + only 2 neutrals → count clause unmet", () => {
    const s = fresh(seats4);
    const obj = seededObj(s, "p4", "hun-crusader");
    blank(s);
    s.round = 16;
    for (const id of ["varna", "serbia", "bosnia"]) own(s, id, "p4");
    const r = scoreObjective(s, "p4", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  it("hun-crusader: all 4 neutrals without varna → front proxy unmet", () => {
    const s = fresh(seats4);
    const obj = seededObj(s, "p4", "hun-crusader");
    blank(s);
    s.round = 16;
    for (const id of ["serbia", "bosnia", "wallachia", "albania"]) own(s, id, "p4");
    const r = scoreObjective(s, "p4", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });

  // ---- hun-defender-of-the-faith (OR major: pure OR was AND-ed as 4 ids) ---
  it("hun-defender-of-the-faith (FACTIONS L266-267): holding edirne ALONE completes it (+4)", () => {
    const s = fresh(seats4);
    const obj = seededObj(s, "p4", "hun-defender-of-the-faith");
    expect(obj.provinceRefs).toEqual([]); // old seed AND-ed edirne+sofia+bursa+constantinople
    blank(s);
    s.round = 16;
    own(s, "edirne", "p4"); // one captured Muslim-held city — nothing else
    const r = scoreObjective(s, "p4", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("hun-defender-of-the-faith: holding constantinople alone satisfies the second OR branch", () => {
    const s = fresh(seats4);
    const obj = seededObj(s, "p4", "hun-defender-of-the-faith");
    blank(s);
    s.round = 16;
    own(s, "constantinople", "p4");
    const r = scoreObjective(s, "p4", obj);
    expect(r.completed).toBe(true);
    expect(r.delta).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("hun-defender-of-the-faith: neither branch held → not completed", () => {
    const s = fresh(seats4);
    const obj = seededObj(s, "p4", "hun-defender-of-the-faith");
    blank(s);
    s.round = 16;
    const r = scoreObjective(s, "p4", obj);
    expect(r.completed).toBe(false);
    expect(r.delta).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B4 GUARD — every seeded objective id must resolve on the canonical board
// ---------------------------------------------------------------------------

describe("seeded secret objectives — id-resolution guard (B4 regression lock)", () => {
  const provinceIds = new Set(PROVINCES.map((p) => p.id));
  const seaZoneIds = new Set(SEA_ZONES.map((z) => z.id));

  /** The objective's base clause plus every anyOfClauses OR-group. */
  const clausesOf = (obj: SecretObjective): SecretObjectiveClause[] => [
    obj,
    ...(obj.anyOfClauses ?? []),
  ];
  const allObjectives = Object.values(FACTION_STARTS).flatMap((start) =>
    start.objectives.map((obj) => ({ faction: start.faction, obj })),
  );

  it("covers all 5 factions × 3 objectives", () => {
    expect(allObjectives.length).toBe(15);
  });

  it("B4: every province ref in every seeded objective resolves in PROVINCES (a sea-zone id can never sneak back in)", () => {
    for (const { obj } of allObjectives) {
      for (const id of obj.provinceRefs) {
        expect(provinceIds.has(id), `${obj.id}: provinceRefs "${id}" not in PROVINCES`).toBe(true);
      }
      for (const clause of clausesOf(obj)) {
        for (const id of clause.allOf ?? []) {
          expect(provinceIds.has(id), `${obj.id}: allOf "${id}" not in PROVINCES`).toBe(true);
        }
        for (const id of clause.anyOf ?? []) {
          expect(provinceIds.has(id), `${obj.id}: anyOf "${id}" not in PROVINCES`).toBe(true);
        }
        for (const entry of clause.minOfProvinces ?? []) {
          for (const id of entry.provinceIds) {
            expect(provinceIds.has(id), `${obj.id}: minOfProvinces "${id}" not in PROVINCES`).toBe(true);
          }
          // A count clause must also be satisfiable: 0 < min <= pool size.
          expect(entry.min, `${obj.id}: minOfProvinces min must be > 0`).toBeGreaterThan(0);
          expect(
            entry.min,
            `${obj.id}: minOfProvinces min exceeds its province pool`,
          ).toBeLessThanOrEqual(entry.provinceIds.length);
        }
      }
    }
  });

  it("B4: every sea-zone predicate id resolves in SEA_ZONES (and never in PROVINCES)", () => {
    for (const { obj } of allObjectives) {
      for (const clause of clausesOf(obj)) {
        const zoneIds = [
          ...(clause.fleetsInZone ?? []).map((e) => e.seaZoneId),
          ...(clause.zonesNotEnemyBlockaded ?? []),
        ];
        for (const id of zoneIds) {
          expect(seaZoneIds.has(id), `${obj.id}: sea-zone id "${id}" not in SEA_ZONES`).toBe(true);
          expect(provinceIds.has(id), `${obj.id}: "${id}" is a province, not a sea zone`).toBe(false);
        }
      }
    }
  });

  it("B5: every seeded objective carries at least one machine-checkable clause (never dead like gen-bankers-of-kings was)", () => {
    const hasContent = (c: SecretObjectiveClause): boolean =>
      Boolean(
        c.allOf?.length ||
          c.anyOf?.length ||
          c.minProvinces !== undefined ||
          c.requiresHagiaSophia ||
          c.minFaith !== undefined ||
          c.refusedChurchUnion ||
          c.sackedHighValueCities !== undefined ||
          c.minPorts !== undefined ||
          c.minOfProvinces?.length ||
          c.fleetsInZone?.length ||
          c.zonesNotEnemyBlockaded?.length ||
          c.minGold !== undefined ||
          c.mostGold ||
          c.minDebtors !== undefined ||
          c.morePortsThan !== undefined ||
          c.destroyedFleetOf !== undefined,
      );
    for (const { obj } of allObjectives) {
      const checkable =
        obj.provinceRefs.length > 0 ||
        hasContent(obj) ||
        (obj.anyOfClauses ?? []).some(hasContent);
      expect(checkable, `${obj.id} has no machine-checkable clause (B5 failure mode)`).toBe(true);
    }
  });
});
