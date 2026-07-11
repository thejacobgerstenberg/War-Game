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
import { PRESTIGE_THRESHOLDS, PRESTIGE_VALUES } from "../balance.js";

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

  it("§13.1 complete a secret objective → +4, once", () => {
    const s = fresh();
    const plain = plainId(s);
    isolate(s, { [plain]: "p1" });
    const obj: SecretObjective = {
      id: "obj-1",
      description: "Hold the frontier",
      provinceRefs: [plain],
      prestige: PRESTIGE_VALUES.secretObjective,
    };
    s.players.find((p) => p.id === "p1")!.objectives = [obj];

    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.secretObjective);
    expect(PRESTIGE_VALUES.secretObjective).toBe(4);
    expect(out.players.find((p) => p.id === "p1")!.objectives[0].completed).toBe(true);

    // Scoring again must not re-award a completed objective.
    const again = scorePrestige(out);
    expect(prestigeOf(again, "p1")).toBe(PRESTIGE_VALUES.secretObjective);
  });

  it("§13.1 win a decisive battle → +1 (battle winner)", () => {
    const s = fresh();
    isolate(s, {});
    pushLog(s, { type: "battle", actors: ["p1", "p2"], data: { winnerId: "p1" } });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(PRESTIGE_VALUES.decisiveBattleWin);
    expect(PRESTIGE_VALUES.decisiveBattleWin).toBe(1);
  });

  it("§13.1 an indecisive battle (no winner) scores nothing", () => {
    const s = fresh();
    isolate(s, {});
    pushLog(s, { type: "battle", actors: ["p1", "p2"], data: { winnerId: null } });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p1")).toBe(0);
    expect(prestigeOf(out, "p2")).toBe(0);
  });

  it("§13.1 a stormed siege counts as a decisive battle for the besieger", () => {
    const s = fresh();
    isolate(s, {});
    pushLog(s, { type: "siege", actors: ["p2"], targets: ["edirne"], data: { captured: true } });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p2")).toBe(PRESTIGE_VALUES.decisiveBattleWin);
  });

  it("§13.1 win a war → +3 (via posted war_won, one-time)", () => {
    const s = fresh();
    isolate(s, {});
    s.activeModifiers.push({
      id: "m-war",
      scope: "round",
      kind: "war_won",
      data: { playerId: "p2" },
    });
    const out = scorePrestige(s);
    expect(prestigeOf(out, "p2")).toBe(PRESTIGE_VALUES.winWar);
    expect(PRESTIGE_VALUES.winWar).toBe(3);
    // Cleared so it is not re-scored next cleanup.
    expect(out.activeModifiers.some((m) => m.kind === "war_won")).toBe(false);
  });

  it("§13.1 lose your own capital → −3 (rightful owner dispossessed)", () => {
    const s = fresh();
    isolate(s, { edirne: "p1" }); // p1 has just taken the Ottoman capital
    // Battle log: attacker p1 beats defender p2 (Ottoman) at edirne.
    pushLog(s, { type: "battle", actors: ["p1", "p2"], targets: ["edirne"], data: { winnerId: "p1" } });
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
