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
  type GameLogEntry,
  type GameState,
  type SecretObjective,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { scorePrestige, checkVictory } from "../prestige.js";
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
    s.players.find((p) => p.id === "p2")!.prestige = 25; // p2 crosses → game ends
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
    s.players.find((p) => p.id === "p1")!.prestige = 100; // >> threshold 25
    // Both triggers fire; sudden death (Ottoman) wins, NOT the prestige leader.
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("DELTA 6 (§13.3): a 1-cleanup hold does NOT pre-empt a threshold win", () => {
    const s = fresh(seats2);
    const cple = s.provinces.find((p) => p.id === "constantinople")!;
    cple.ownerId = "p2";
    // Only one cleanup held → sudden death not yet armed.
    s.constantinopleHold = { faction: Faction.OTTOMAN, rounds: 1 };
    s.players.find((p) => p.id === "p1")!.prestige = 30; // over threshold
    // Threshold win stands for Byzantium; sudden death has not triggered.
    expect(checkVictory(s)).toBe(Faction.BYZANTIUM);
  });
});

// ---------------------------------------------------------------------------
// §13.2 Prestige thresholds by player count
// ---------------------------------------------------------------------------

describe("checkVictory — §13.2 prestige threshold", () => {
  it("2 players → threshold 25", () => {
    expect(PRESTIGE_THRESHOLDS[2]).toBe(25);
    const s = fresh(seats2);
    s.players.find((p) => p.id === "p1")!.prestige = 24;
    expect(checkVictory(s)).toBeNull();
    s.players.find((p) => p.id === "p1")!.prestige = 25;
    expect(checkVictory(s)).toBe(Faction.BYZANTIUM);
  });

  it("3 players → threshold 30", () => {
    expect(PRESTIGE_THRESHOLDS[3]).toBe(30);
    const s = fresh(seats3);
    s.players.find((p) => p.id === "p2")!.prestige = 29;
    expect(checkVictory(s)).toBeNull();
    s.players.find((p) => p.id === "p2")!.prestige = 30;
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("4 players → threshold 35", () => {
    expect(PRESTIGE_THRESHOLDS[4]).toBe(35);
    const s = fresh(seats4);
    s.players.find((p) => p.id === "p4")!.prestige = 34;
    expect(checkVictory(s)).toBeNull();
    s.players.find((p) => p.id === "p4")!.prestige = 35;
    expect(checkVictory(s)).toBe(Faction.HUNGARY);
  });

  it("§13.2 when several cross the same cleanup, highest prestige wins", () => {
    const s = fresh(seats2);
    s.players.find((p) => p.id === "p1")!.prestige = 26;
    s.players.find((p) => p.id === "p2")!.prestige = 30;
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  // CLARIFICATION §13.3 cap tiebreak: at the prestige cap, when several cross with
  // EQUAL prestige the tiebreak order is most key/high-value cities, THEN most gold.
  it("§13.3 cap tiebreak: equal prestige at the cap breaks on most key cities", () => {
    const s = fresh(seats2);
    const key = keyCityId(s);
    isolate(s, { [key]: "p2" }); // p2 holds one more key city
    // Both are at the 2-player threshold (25) with equal prestige.
    s.players.find((p) => p.id === "p1")!.prestige = 25;
    s.players.find((p) => p.id === "p2")!.prestige = 25;
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("§13.3 cap tiebreak: equal prestige AND key cities breaks on most gold", () => {
    const s = fresh(seats2);
    isolate(s, {}); // neither holds a key city
    s.players.find((p) => p.id === "p1")!.prestige = 25;
    s.players.find((p) => p.id === "p2")!.prestige = 25;
    s.players.find((p) => p.id === "p1")!.treasury.gold = 4;
    s.players.find((p) => p.id === "p2")!.treasury.gold = 11; // more gold → p2
    expect(checkVictory(s)).toBe(Faction.OTTOMAN);
  });

  it("CANON #3 / §13.2: victory is only checked at Cleanup (END phase)", () => {
    const s = fresh(seats2);
    s.players.find((p) => p.id === "p1")!.prestige = 30; // over threshold
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
