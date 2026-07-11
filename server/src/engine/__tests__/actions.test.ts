/**
 * actions.test.ts — CORE ACTIONS & ROUND LOOP (§6 recruit/stacking, §7/§6.4
 * move & attack, §10 action economy, §10/§13 round loop).
 *
 * Exercises the parts of the reducer this subsystem owns: the RECRUIT handler
 * (cost / location legality / stacking), MOVE (adjacency + a valid relocation),
 * ATTACK (a defended tile queues a PendingBattle rather than resolving inline),
 * the per-round action budget (§10.0), a full `advancePhase` round on the tiny
 * 2-player canonical fixture, and end-to-end determinism from a fixed seed.
 */
import { describe, it, expect } from "vitest";
import {
  Faction,
  GamePhase,
  UnitType,
  type GameState,
  type MoveAction,
  type RecruitAction,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { applyAction, EngineError } from "../actions.js";
import { advancePhase } from "../roundLoop.js";

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

/** A fresh, deterministic 2-player game (Byzantium vs Ottoman) at INCOME, r1. */
function fresh(seed = 12345): GameState {
  return structuredClone(createInitialState("ROOM01", seats, seed));
}

const BYZ_ARMY = "army-p1-constantinople";

function recruit(over: Partial<RecruitAction>): RecruitAction {
  return {
    type: "RECRUIT",
    player: "p1",
    provinceId: "constantinople",
    units: {},
    ...over,
  };
}

function move(over: Partial<MoveAction>): MoveAction {
  return { type: "MOVE", player: "p1", stackId: BYZ_ARMY, toId: "selymbria", ...over };
}

// ---------------------------------------------------------------------------
// RECRUIT (§6.2 recruitment, §6.4 stacking)
// ---------------------------------------------------------------------------

describe("RECRUIT", () => {
  it("§6.2 raises units in a capital and pays the UNIT_STATS cost", () => {
    const s = fresh();
    s.phase = GamePhase.RECRUITMENT;
    const before = s.players.find((p) => p.id === "p1")!.treasury;
    expect(before.gold).toBe(5); // BYZANTIUM start

    const next = applyAction(s, recruit({ units: { [UnitType.INFANTRY]: 1 } }));

    const p1 = next.players.find((p) => p.id === "p1")!;
    expect(p1.treasury.gold).toBe(1); // −4 gold (INFANTRY)
    expect(p1.treasury.grain).toBe(3); // −1 grain
    expect(p1.actionsRemaining).toBe(3); // one action spent
    const army = next.armies.find((a) => a.id === BYZ_ARMY)!;
    expect(army.units[UnitType.INFANTRY]).toBe(3); // 2 starting + 1 recruited
  });

  it("§6.2 rejects recruitment in a non-capital/CITY/Barracks province", () => {
    const s = fresh();
    s.phase = GamePhase.RECRUITMENT;
    // selymbria is a COAST province p1 owns but has no Barracks.
    expect(() =>
      applyAction(s, recruit({ provinceId: "selymbria", units: { [UnitType.INFANTRY]: 1 } })),
    ).toThrowError(expect.objectContaining({ code: "BAD_RECRUIT" }));
  });

  it("§6.2 throws INSUFFICIENT_RESOURCES when the treasury cannot pay", () => {
    const s = fresh();
    s.phase = GamePhase.RECRUITMENT;
    // 10 CAVALRY (60 gold) far exceeds the 5-gold starting treasury.
    expect(() =>
      applyAction(s, recruit({ units: { [UnitType.CAVALRY]: 10 } })),
    ).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_RESOURCES" }));
  });

  it("§6.4 enforces the 12-unit CITY stacking limit", () => {
    const s = fresh();
    s.phase = GamePhase.RECRUITMENT;
    const p1 = s.players.find((p) => p.id === "p1")!;
    p1.treasury.gold = 1000;
    p1.treasury.grain = 1000;
    // constantinople already holds 3 land units; +12 would be 15 > 12.
    expect(() =>
      applyAction(s, recruit({ units: { [UnitType.INFANTRY]: 12 } })),
    ).toThrowError(expect.objectContaining({ code: "STACK_LIMIT" }));
  });
});

// ---------------------------------------------------------------------------
// MOVE / ATTACK (§6.4 movement, §7 battle declaration)
// ---------------------------------------------------------------------------

describe("MOVE / ATTACK", () => {
  it("§6.4 rejects a move to a non-adjacent province (NOT_ADJACENT)", () => {
    const s = fresh();
    s.phase = GamePhase.MOVEMENT;
    expect(() => applyAction(s, move({ toId: "athens" }))).toThrowError(
      expect.objectContaining({ code: "NOT_ADJACENT" }),
    );
  });

  it("§6.4 relocates a stack into an adjacent friendly province", () => {
    const s = fresh();
    s.phase = GamePhase.MOVEMENT;
    const next = applyAction(s, move({ toId: "selymbria" }));
    const army = next.armies.find((a) => a.id === BYZ_ARMY)!;
    expect(army.locationId).toBe("selymbria");
    expect(next.pendingBattles).toHaveLength(0);
  });

  it("§7 queues a PendingBattle when entering a defended enemy tile", () => {
    const s = fresh();
    s.phase = GamePhase.MOVEMENT;
    // bithynia is Ottoman-held (p2) with a garrison levy and adjacent to the City.
    const next = applyAction(s, move({ toId: "bithynia" }));
    expect(next.pendingBattles).toHaveLength(1);
    const battle = next.pendingBattles[0];
    expect(battle.attackerId).toBe("p1");
    expect(battle.defenderId).toBe("p2");
    expect(battle.attackerStackIds).toContain(BYZ_ARMY);
    expect(battle.provinceId).toBe("bithynia");
  });

  it("§10.0 rejects an action with no budget left (NO_ACTIONS)", () => {
    const s = fresh();
    s.phase = GamePhase.MOVEMENT;
    s.players.find((p) => p.id === "p1")!.actionsRemaining = 0;
    expect(() => applyAction(s, move({ toId: "selymbria" }))).toThrowError(
      expect.objectContaining({ code: "NO_ACTIONS" }),
    );
  });

  it("§10.0 rejects a budgeted action outside an action phase (WRONG_PHASE)", () => {
    const s = fresh(); // phase INCOME
    expect(() => applyAction(s, move({ toId: "selymbria" }))).toThrowError(
      expect.objectContaining({ code: "WRONG_PHASE" }),
    );
  });
});

// ---------------------------------------------------------------------------
// ROUND LOOP (§10 phase machine, §13.4 reshuffle)
// ---------------------------------------------------------------------------

describe("advancePhase round loop", () => {
  it("§10 walks a full round and increments the round counter", () => {
    let s = fresh(); // INCOME, round 1
    expect(s.round).toBe(1);
    const seen: GamePhase[] = [];
    // INCOME → RECRUITMENT → MOVEMENT → DIPLOMACY → COMBAT → END → INCOME(r2)
    for (let i = 0; i < 6; i += 1) {
      s = advancePhase(s);
      seen.push(s.phase);
    }
    expect(seen).toEqual([
      GamePhase.RECRUITMENT,
      GamePhase.MOVEMENT,
      GamePhase.DIPLOMACY,
      GamePhase.COMBAT,
      GamePhase.END,
      GamePhase.INCOME,
    ]);
    expect(s.round).toBe(2);
    expect(s.winner).toBeUndefined();
  });

  it("§10 resets action budgets on entering a new round", () => {
    let s = fresh();
    s.players.forEach((p) => (p.actionsRemaining = 0));
    s = advancePhase(s); // INCOME → RECRUITMENT (resets budgets)
    for (const p of s.players) expect(p.actionsRemaining).toBeGreaterThanOrEqual(4);
  });

  it("§13.4 re-sorts turn order lowest-prestige first at the round head", () => {
    let s = fresh();
    // Give p2 a large prestige lead so p1 (lower) should act first this round.
    s.players.find((p) => p.id === "p2")!.prestige = 100;
    s = advancePhase(s); // INCOME processes the reshuffle
    expect(s.turnOrder[0]).toBe("p1");
    expect(s.activePlayerIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism (§4 RNG cursor discipline through a full action script)
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same seed + same action script → byte-identical state", () => {
    const script = (): GameState => {
      let s = fresh(4242);
      s.phase = GamePhase.RECRUITMENT;
      s = applyAction(s, recruit({ units: { [UnitType.INFANTRY]: 1 } }));
      // Advance through a whole round (COMBAT consumes the shared RNG stream).
      for (let i = 0; i < 6; i += 1) s = applyAction(s, { type: "ADVANCE_PHASE" });
      return s;
    };
    expect(JSON.stringify(script())).toBe(JSON.stringify(script()));
  });

  it("EngineError carries a machine-readable code", () => {
    const s = fresh();
    s.phase = GamePhase.MOVEMENT;
    try {
      applyAction(s, move({ toId: "athens" }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe("NOT_ADJACENT");
    }
  });
});
