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
  TerrainType,
  UnitType,
  asTacticCardId,
  type Army,
  type GameState,
  type MoveAction,
  type PendingBattle,
  type RecruitAction,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { applyAction, EngineError } from "../actions.js";
import { advancePhase } from "../roundLoop.js";
import { omenCardId } from "../events/index.js";
import {
  UNJUSTIFIED_WAR_PRESTIGE,
  UNIQUE_UNIT_OVERRIDES,
  UNIT_STATS,
} from "../balance.js";

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

  it("§6.1/§2.3 charges a unique variant's per-unique `cost` override, not the base cost", () => {
    const s = fresh();
    s.phase = GamePhase.RECRUITMENT;
    const p1 = s.players.find((p) => p.id === "p1")!;
    p1.treasury.gold = 10;
    p1.treasury.grain = 5;

    // Varangian Guard: BYZANTIUM, base INFANTRY, §2.3 cost override { gold: 6 };
    // recruitable at constantinople. Base INFANTRY costs gold 4, so the override
    // (6) is strictly higher — an unmistakable signal of which cost was charged.
    const guard = UNIQUE_UNIT_OVERRIDES.VARANGIAN_GUARD;
    const overrideGold = guard.cost!.gold!;
    const baseGold = UNIT_STATS[guard.base].cost.gold!;
    const baseGrain = UNIT_STATS[guard.base].cost.grain!;
    expect(overrideGold).toBe(6);
    expect(baseGold).toBe(4);

    const next = applyAction(
      s,
      recruit({ units: {}, variants: [{ base: UnitType.INFANTRY, variant: "VARANGIAN_GUARD", count: 1 }] }),
    );

    const after = next.players.find((p) => p.id === "p1")!;
    // Charged the OVERRIDE gold (6), not the base gold (4): 10 − 6 = 4 (a base
    // charge would have left 6). Grain is ABSENT from the override → it falls
    // through to the base INFANTRY grain cost (1): 5 − 1 = 4.
    expect(after.treasury.gold).toBe(10 - overrideGold); // 4, not 10 − baseGold (6)
    expect(after.treasury.gold).not.toBe(10 - baseGold);
    expect(after.treasury.grain).toBe(5 - baseGrain); // 4 (override omits grain)

    const army = next.armies.find((a) => a.id === BYZ_ARMY)!;
    const stack = army.variants!.find((v) => v.variant === "VARANGIAN_GUARD")!;
    // Byzantium's canonical starting roster seeds 1 Varangian Guard at
    // constantinople (factions.ts), so recruiting 1 more lands at 2 (balance
    // reconciliation PR #11 @f760294 — per-unique cost override, count unaffected).
    expect(stack.count).toBe(2);
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

  it("§6.4/§10 defers occupation of an empty enemy tile (no inline ownerId flip)", () => {
    const s = fresh();
    s.phase = GamePhase.MOVEMENT;
    // Make the adjacent selymbria an UNDEFENDED enemy province (Ottoman-held, no
    // garrison, no defending stack) so the march is unopposed.
    const prov = s.provinces.find((p) => p.id === "selymbria")!;
    prov.ownerId = "p2";
    prov.garrison = 0;
    s.armies = s.armies.filter(
      (a) => !(a.locationId === "selymbria" && a.ownerId === "p2"),
    );
    const next = applyAction(s, move({ toId: "selymbria" }));
    // The stack relocates...
    expect(next.armies.find((a) => a.id === BYZ_ARMY)!.locationId).toBe("selymbria");
    // ...but ownership does NOT flip inline (§6.4: flips at cleanup unless contested).
    expect(next.provinces.find((p) => p.id === "selymbria")!.ownerId).toBe("p2");
    // The occupation is recorded for the roundLoop END/cleanup flip.
    expect(next.pendingOccupations).toContainEqual(
      expect.objectContaining({ provinceId: "selymbria", occupantId: "p1" }),
    );
    // Undefended → no battle queued.
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

// ---------------------------------------------------------------------------
// ACTION WINDOW (CANON #9, §10.0, ARCH §10): any action type in any window phase
// ---------------------------------------------------------------------------

/** A bare land army for a player at a location (only the given generic units). */
function makeArmy(id: string, owner: string, at: string, units: Partial<Record<UnitType, number>>): Army {
  const u = {} as Record<UnitType, number>;
  for (const t of Object.values(UnitType)) u[t] = units[t] ?? 0;
  return { id, ownerId: owner, locationId: at, units: u, variants: [] };
}

describe("action window (§10.0 / CANON #9)", () => {
  it("§10.0 accepts a RECRUIT during the MOVEMENT phase (no per-type gate)", () => {
    const s = fresh();
    s.phase = GamePhase.MOVEMENT; // not RECRUITMENT — but still inside the window
    const next = applyAction(s, recruit({ units: { [UnitType.INFANTRY]: 1 } }));
    const army = next.armies.find((a) => a.id === BYZ_ARMY)!;
    expect(army.units[UnitType.INFANTRY]).toBe(3); // recruit accepted mid-MOVEMENT
    expect(next.players.find((p) => p.id === "p1")!.actionsRemaining).toBe(3);
  });

  it("§10.0 accepts a MOVE during the DIPLOMACY phase", () => {
    const s = fresh();
    s.phase = GamePhase.DIPLOMACY;
    const next = applyAction(s, move({ toId: "selymbria" }));
    expect(next.armies.find((a) => a.id === BYZ_ARMY)!.locationId).toBe("selymbria");
  });

  it("§10.0 rejects any budgeted action during INCOME (outside the window, WRONG_PHASE)", () => {
    const s = fresh(); // INCOME
    expect(() =>
      applyAction(s, recruit({ units: { [UnitType.INFANTRY]: 1 } })),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });

  it("§10.0 rejects a budgeted action during COMBAT (outside the window)", () => {
    const s = fresh();
    s.phase = GamePhase.COMBAT;
    expect(() =>
      applyAction(s, recruit({ units: { [UnitType.INFANTRY]: 1 } })),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });

  it("§10.0 the shared 4-action budget is exhausted regardless of action mix (NO_ACTIONS)", () => {
    const s = fresh();
    s.phase = GamePhase.RECRUITMENT;
    s.players.find((p) => p.id === "p1")!.actionsRemaining = 0;
    expect(() =>
      applyAction(s, recruit({ units: { [UnitType.INFANTRY]: 1 } })),
    ).toThrowError(expect.objectContaining({ code: "NO_ACTIONS" }));
  });
});

// ---------------------------------------------------------------------------
// MOVEMENT POINTS (§3.1 / §6.4): slowest-unit budget vs terrain move cost
// ---------------------------------------------------------------------------

describe("movement points (§3.1 / §6.4)", () => {
  it("§3.1 a CAVALRY stack (mv2) may enter a cost-2 MOUNTAINS province", () => {
    const s = fresh();
    s.phase = GamePhase.MOVEMENT;
    // selymbria is p1-owned, empty and adjacent to constantinople; force it to
    // MOUNTAINS so entering costs 2 move points.
    s.provinces.find((p) => p.id === "selymbria")!.terrain = TerrainType.MOUNTAINS;
    s.armies.push(makeArmy("cav1", "p1", "constantinople", { [UnitType.CAVALRY]: 1 }));
    const next = applyAction(s, {
      type: "MOVE",
      player: "p1",
      stackId: "cav1",
      toId: "selymbria",
    });
    expect(next.armies.find((a) => a.id === "cav1")!.locationId).toBe("selymbria");
  });

  it("§3.1 a SIEGE stack (mv1) may NOT enter a cost-2 MOUNTAINS province (INSUFFICIENT_MOVEMENT)", () => {
    const s = fresh();
    s.phase = GamePhase.MOVEMENT;
    s.provinces.find((p) => p.id === "selymbria")!.terrain = TerrainType.MOUNTAINS;
    s.armies.push(makeArmy("siege1", "p1", "constantinople", { [UnitType.SIEGE]: 1 }));
    expect(() =>
      applyAction(s, { type: "MOVE", player: "p1", stackId: "siege1", toId: "selymbria" }),
    ).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_MOVEMENT" }));
  });

  it("§3.1 a SIEGE stack (mv1) enters a cost-1 COAST province normally", () => {
    const s = fresh();
    s.phase = GamePhase.MOVEMENT;
    // selymbria stays COAST (cost 1) — a mv1 siege can afford it.
    s.armies.push(makeArmy("siege2", "p1", "constantinople", { [UnitType.SIEGE]: 1 }));
    const next = applyAction(s, {
      type: "MOVE",
      player: "p1",
      stackId: "siege2",
      toId: "selymbria",
    });
    expect(next.armies.find((a) => a.id === "siege2")!.locationId).toBe("selymbria");
  });
});

// ---------------------------------------------------------------------------
// GREAT BOMBARD not recruitable (§8.4, DELTA 3)
// ---------------------------------------------------------------------------

const GREAT_BOMBARD_VARIANT = { base: UnitType.SIEGE, variant: "GREAT_BOMBARD", count: 1 };

describe("Great Bombard is NOT recruitable (§8.4, DELTA 3)", () => {
  // CANON "Great Bombard model — CORRECTED": the piece is acquired ONLY by Omen
  // #34 resolving (spawned onto GameState.greatBombard in the Ottoman capital, or
  // auctioned) — GD §8.4 "It cannot be recruited, rebuilt, or duplicated." The old
  // unlock→RECRUIT path (and its NOT_UNLOCKED / greatBombardUnlocked gating) is
  // GONE. A RECRUIT order for it is always rejected.

  it("§8.4 rejects recruiting the Great Bombard outright (NOT_RECRUITABLE)", () => {
    const s = fresh();
    s.phase = GamePhase.RECRUITMENT;
    expect(() =>
      applyAction(s, recruit({ units: {}, variants: [GREAT_BOMBARD_VARIANT] })),
    ).toThrowError(expect.objectContaining({ code: "NOT_RECRUITABLE" }));
  });

  it("§8.4 rejects the Great Bombard RECRUIT even with the deprecated unlock flag set", () => {
    const s = fresh();
    s.phase = GamePhase.RECRUITMENT;
    // The deprecated flag no longer opens any recruit path — the RECRUIT is still
    // rejected (DELTA 3 dropped every read of it in the recruit gate).
    s.players.find((p) => p.id === "p1")!.greatBombardUnlocked = true;
    expect(() =>
      applyAction(s, recruit({ units: {}, variants: [GREAT_BOMBARD_VARIANT] })),
    ).toThrowError(expect.objectContaining({ code: "NOT_RECRUITABLE" }));
  });

  it("§8.4 rejects the Great Bombard RECRUIT even with the Omen #34 kind:'unlock' modifier present", () => {
    const s = fresh();
    s.phase = GamePhase.RECRUITMENT;
    s.activeModifiers.push({
      id: "omen-34:unlock",
      scope: "game",
      kind: "unlock",
      target: { faction: Faction.BYZANTIUM },
      data: { unlock: "GREAT_BOMBARD" },
    });
    expect(() =>
      applyAction(s, recruit({ units: {}, variants: [GREAT_BOMBARD_VARIANT] })),
    ).toThrowError(expect.objectContaining({ code: "NOT_RECRUITABLE" }));
  });

  it("§8.4 a normal RECRUIT alongside a Great Bombard variant is still rejected (no partial recruit)", () => {
    const s = fresh();
    s.phase = GamePhase.RECRUITMENT;
    const p1 = s.players.find((p) => p.id === "p1")!;
    const goldBefore = p1.treasury.gold;
    expect(() =>
      applyAction(
        s,
        recruit({ units: { [UnitType.INFANTRY]: 1 }, variants: [GREAT_BOMBARD_VARIANT] }),
      ),
    ).toThrowError(expect.objectContaining({ code: "NOT_RECRUITABLE" }));
    // A thrown EngineError never mutates state (treasury untouched, no stack change).
    expect(s.players.find((p) => p.id === "p1")!.treasury.gold).toBe(goldBefore);
  });
});

// ---------------------------------------------------------------------------
// PLAY_TACTIC (§7.7): queue onto a battle + remove from hand
// ---------------------------------------------------------------------------

const VETERANS = asTacticCardId("veterans-of-the-border");

/** Push a p1-attacker / p2-defender pending battle and return its id. */
function seedBattle(s: GameState): string {
  const battle: PendingBattle = {
    id: "pb-test-1",
    provinceId: "bithynia",
    attackerId: "p1",
    defenderId: "p2",
    attackerStackIds: [BYZ_ARMY],
    defenderStackIds: [],
  };
  s.pendingBattles.push(battle);
  return battle.id;
}

describe("PLAY_TACTIC (§7.7)", () => {
  it("§7.7 queues a held tactic onto the correct battle side and removes it from hand", () => {
    const s = fresh();
    const battleId = seedBattle(s);
    s.players.find((p) => p.id === "p1")!.tacticHand = [VETERANS];
    const next = applyAction(s, { type: "PLAY_TACTIC", player: "p1", battleId, cardId: VETERANS });
    const battle = next.pendingBattles.find((b) => b.id === battleId)!;
    expect(battle.attackerTactics).toContain(VETERANS); // p1 is the attacker
    expect(next.players.find((p) => p.id === "p1")!.tacticHand).toHaveLength(0);
  });

  it("§7.7 rejects a tactic card the player does not hold (NOT_IN_HAND)", () => {
    const s = fresh();
    const battleId = seedBattle(s);
    s.players.find((p) => p.id === "p1")!.tacticHand = []; // empty hand
    expect(() =>
      applyAction(s, { type: "PLAY_TACTIC", player: "p1", battleId, cardId: VETERANS }),
    ).toThrowError(expect.objectContaining({ code: "NOT_IN_HAND" }));
  });

  it("§7.7 rejects a play referencing a non-existent battle (NO_SUCH_BATTLE)", () => {
    const s = fresh();
    s.players.find((p) => p.id === "p1")!.tacticHand = [VETERANS];
    expect(() =>
      applyAction(s, { type: "PLAY_TACTIC", player: "p1", battleId: "nope", cardId: VETERANS }),
    ).toThrowError(expect.objectContaining({ code: "NO_SUCH_BATTLE" }));
  });

  it("§7.7 PLAY_TACTIC is free — it spends no action budget", () => {
    const s = fresh();
    const battleId = seedBattle(s);
    const p1 = s.players.find((p) => p.id === "p1")!;
    p1.tacticHand = [VETERANS];
    const before = p1.actionsRemaining;
    const next = applyAction(s, { type: "PLAY_TACTIC", player: "p1", battleId, cardId: VETERANS });
    expect(next.players.find((p) => p.id === "p1")!.actionsRemaining).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// PLAY_CARD (§10.6): hand verification + discard
// ---------------------------------------------------------------------------

describe("PLAY_CARD (§10.6)", () => {
  it("§10.6 rejects playing a card not in hand (NOT_IN_HAND)", () => {
    const s = fresh();
    s.players.find((p) => p.id === "p1")!.hand = [];
    expect(() =>
      applyAction(s, { type: "PLAY_CARD", player: "p1", cardId: "omen-1" }),
    ).toThrowError(expect.objectContaining({ code: "NOT_IN_HAND" }));
  });

  it("§10.6 discards the played card from hand after resolving", () => {
    const s = fresh();
    // A non-event id makes resolveCard a no-op; we assert only the hand-discard.
    s.players.find((p) => p.id === "p1")!.hand = [
      { id: "held-card-x", name: "Held Card", description: "", cost: {} },
    ];
    const next = applyAction(s, { type: "PLAY_CARD", player: "p1", cardId: "held-card-x" });
    expect(next.players.find((p) => p.id === "p1")!.hand).toHaveLength(0);
  });

  it("FL-03 threads targetPlayerId into resolveCard (#28 Papal Interdict hits the target alone)", () => {
    // EVENT_CARDS.md Era II #28: "Target loses all ✝️ income for 2 rounds." p1
    // (Byzantium) plays the interdict targeting p2 (Ottoman). Because actions.ts
    // now forwards action.targetPlayerId to resolveCard, #28 posts a faith_income
    // modifier SCOPED to the interdicted faction. Without the thread, #28's
    // neutral (no-target) path posts NOTHING — so the modifier's presence AND its
    // Ottoman-scoped target together prove the target reached the events layer.
    const s = fresh(); // p1 = Byzantium, p2 = Ottoman
    const interdict = omenCardId(28);
    s.players.find((p) => p.id === "p1")!.hand = [
      { id: interdict, name: "Papal Interdict", description: "", cost: {} },
    ];
    const next = applyAction(s, {
      type: "PLAY_CARD",
      player: "p1",
      cardId: interdict,
      targetPlayerId: "p2",
    });
    const faithMod = next.activeModifiers.find(
      (m) => m.sourceCardId === interdict && m.kind === "faith_income",
    );
    expect(faithMod).toBeDefined();
    expect(faithMod!.target?.faction).toBe(Faction.OTTOMAN); // scoped to the target, not global
    // The played copy is still discarded from hand.
    expect(next.players.find((p) => p.id === "p1")!.hand).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MERC_BID voluntary pass dispatch (DA-3 / CANON CLARIFICATION 3, §6.3)
// ---------------------------------------------------------------------------

describe("MERC_BID pass dispatch (DA-3 / §6.3)", () => {
  it("§6.3 forwards a pass:true MERC_BID to the mercenaries round-robin (records the pass)", () => {
    // CANON CLARIFICATION 3 / DA-3: MERC_BID may carry pass:true (a voluntary
    // withdrawal). actions.ts only validates the issuer and forwards the whole
    // action — pass flag included — to applyMercBid, whose round-robin records
    // the passer in the offer's `passedPlayerIds` (bid ignored on a pass). Here
    // the dispatch must NOT reject the pass, and the pass must reach the handler.
    const s = fresh();
    s.mercMarket = [
      { companyId: "CATALAN", currentBid: 0, highBidderId: null, sold: false },
    ];
    const next = applyAction(s, {
      type: "MERC_BID",
      player: "p1",
      companyId: "CATALAN",
      bid: 0,
      pass: true,
    });
    const offer = next.mercMarket.find((o) => o.companyId === "CATALAN")!;
    expect(offer.passedPlayerIds ?? []).toContain("p1");
  });
});

// ---------------------------------------------------------------------------
// DECLARE_WAR (§11) & LEVY_CALL (§11.5)
// ---------------------------------------------------------------------------

describe("DECLARE_WAR (§11)", () => {
  it("§11 opens a WarState against the target faction's player (deduped)", () => {
    const s = fresh();
    s.phase = GamePhase.DIPLOMACY;
    const next = applyAction(s, { type: "DECLARE_WAR", player: "p1", target: Faction.OTTOMAN });
    expect(next.wars.some((w) => w.a === "p1" && w.b === "p2")).toBe(true);
    // A second declaration does not add a duplicate war.
    const again = applyAction(
      { ...next, players: next.players.map((p) => ({ ...p, actionsRemaining: 4 })) },
      { type: "DECLARE_WAR", player: "p1", target: Faction.OTTOMAN },
    );
    expect(again.wars.filter((w) => w.a === "p1" && w.b === "p2")).toHaveLength(1);
  });

  it("§11 rejects declaring war on your own faction (BAD_TARGET)", () => {
    const s = fresh();
    s.phase = GamePhase.DIPLOMACY;
    expect(() =>
      applyAction(s, { type: "DECLARE_WAR", player: "p1", target: Faction.BYZANTIUM }),
    ).toThrowError(expect.objectContaining({ code: "BAD_TARGET" }));
  });

  it("§11 rejects declaring war on an unseated faction (NO_TARGET)", () => {
    const s = fresh();
    s.phase = GamePhase.DIPLOMACY;
    expect(() =>
      applyAction(s, { type: "DECLARE_WAR", player: "p1", target: Faction.VENICE }),
    ).toThrowError(expect.objectContaining({ code: "NO_TARGET" }));
  });

  // ---- DELTA 5 (§11 Casus belli): justification dispatch --------------------

  /** The unjustified-war penalty modifier for `playerId`, if one was posted. */
  function unjustifiedMod(s: GameState, playerId: string) {
    return s.activeModifiers.find(
      (m) =>
        m.kind === "prestige_pending" &&
        m.data?.reason === "unjustified_war" &&
        m.data?.playerId === playerId,
    );
  }

  it("DELTA 5 §11 an UNJUSTIFIED DECLARE_WAR (no justification) posts a −1 prestige_pending", () => {
    const s = fresh();
    s.phase = GamePhase.DIPLOMACY;
    const next = applyAction(s, { type: "DECLARE_WAR", player: "p1", target: Faction.OTTOMAN });
    // The war still opens...
    expect(next.wars.some((w) => w.a === "p1" && w.b === "p2")).toBe(true);
    // ...and a negative prestige_pending is posted (consumed by prestige at Cleanup,
    // never mutating Player.prestige inline — CONTRACT2 §12.8).
    const mod = unjustifiedMod(next, "p1");
    expect(mod).toBeDefined();
    expect(mod!.value).toBe(-UNJUSTIFIED_WAR_PRESTIGE);
    expect(mod!.scope).toBe("round");
    expect(mod!.data?.conquest).toBe(false); // stays off the conquest track
    expect(mod!.target?.faction).toBe(Faction.BYZANTIUM); // scoped to the declarer
    // Prestige is NOT mutated inline (the pending modifier is scored later).
    expect(next.players.find((p) => p.id === "p1")!.prestige).toBe(
      s.players.find((p) => p.id === "p1")!.prestige,
    );
  });

  it("DELTA 5 §11 a JUSTIFIED DECLARE_WAR (claim) posts NO prestige penalty", () => {
    const s = fresh();
    s.phase = GamePhase.DIPLOMACY;
    const next = applyAction(s, {
      type: "DECLARE_WAR",
      player: "p1",
      target: Faction.OTTOMAN,
      justification: "claim",
    });
    expect(next.wars.some((w) => w.a === "p1" && w.b === "p2")).toBe(true);
    expect(unjustifiedMod(next, "p1")).toBeUndefined();
  });

  it("DELTA 5 §11 vassal-defense with NO vassal is implausible → unjustified (penalty)", () => {
    const s = fresh();
    s.phase = GamePhase.DIPLOMACY;
    // p1 holds no vassal minor, so the claimed defence is implausible.
    const next = applyAction(s, {
      type: "DECLARE_WAR",
      player: "p1",
      target: Faction.OTTOMAN,
      justification: "vassal-defense",
    });
    expect(unjustifiedMod(next, "p1")).toBeDefined();
  });

  it("DELTA 5 §11 vassal-defense WITH a vassal is a valid casus belli (no penalty)", () => {
    const s = fresh();
    s.phase = GamePhase.DIPLOMACY;
    s.minors.push({
      id: "m-serbia",
      name: "Serbia",
      provinceIds: ["selymbria"],
      garrison: 4,
      tier: 1,
      vassalOf: "p1",
      roundsUntilLevy: 0,
    });
    const next = applyAction(s, {
      type: "DECLARE_WAR",
      player: "p1",
      target: Faction.OTTOMAN,
      justification: "vassal-defense",
    });
    expect(unjustifiedMod(next, "p1")).toBeUndefined();
  });

  it("DELTA 5 §11 re-declaring an existing war levies no fresh unjustified penalty", () => {
    const s = fresh();
    s.phase = GamePhase.DIPLOMACY;
    const first = applyAction(s, { type: "DECLARE_WAR", player: "p1", target: Faction.OTTOMAN });
    expect(unjustifiedMod(first, "p1")).toBeDefined();
    // Second (redundant) declaration on the already-open war: no new penalty modifier.
    const again = applyAction(
      {
        ...first,
        players: first.players.map((p) => ({ ...p, actionsRemaining: 4 })),
        // clear the first penalty so we detect only a *new* one
        activeModifiers: first.activeModifiers.filter(
          (m) => m.data?.reason !== "unjustified_war",
        ),
      },
      { type: "DECLARE_WAR", player: "p1", target: Faction.OTTOMAN },
    );
    expect(unjustifiedMod(again, "p1")).toBeUndefined();
  });
});

describe("LEVY_CALL (§11.5)", () => {
  function withVassal(s: GameState): GameState {
    // FL-17: garrison 4 gives a GARRISON tier of ⌊4 ÷ 2⌋ = 2, deliberately
    // DIFFERENT from the MAP wall `tier: 1`, so the levy-size test distinguishes
    // the correct garrison-tier formula from the old wall-tier one.
    s.minors.push({
      id: "m-serbia",
      name: "Serbia",
      provinceIds: ["selymbria"],
      garrison: 4,
      tier: 1,
      vassalOf: "p1",
      roundsUntilLevy: 0,
    });
    return s;
  }

  it("§11.5 levy size = 2 base + 1 per GARRISON tier ⌊garrison ÷ 2⌋ (FL-17)", () => {
    const s = withVassal(fresh());
    s.phase = GamePhase.DIPLOMACY;
    const next = applyAction(s, { type: "LEVY_CALL", player: "p1", minorId: "m-serbia" });
    const army = next.armies.find((a) => a.ownerId === "p1" && a.locationId === "selymbria")!;
    // Byzantium's canonical starting garrison at selymbria is 1 LEVY (FACTIONS.md
    // / CONTRACT §11). Serbia's garrison tier = ⌊4 ÷ 2⌋ = 2, so the levy call
    // raises 2 base + 1×2 = 4 into that same stack → 5 total. Under the OLD
    // wall-tier formula (2 + 1×tier-1) it would have raised only 3 (→ 4) — this
    // asserts the garrison-tier fix (§11.5, CANON supersedes the CONTRACT2 baseline).
    expect(army.units[UnitType.LEVY]).toBe(5); // 1 starting + (2 base + 1 × garrison-tier-2)
    // Cooldown re-armed so runRevolts won't double-levy this cadence.
    expect(next.minors.find((m) => m.id === "m-serbia")!.roundsUntilLevy).toBe(2);
  });

  it("§6.4 clamps the levy to the remaining land-stacking capacity at the capital", () => {
    const s = withVassal(fresh());
    s.phase = GamePhase.DIPLOMACY;
    // Fill p1's stack at the vassal capital (selymbria) to 7 land units, one shy
    // of the §6.4 land cap (8). The 4-unit levy (2 base + garrison-tier-2) must
    // be trimmed to 1, not 4.
    const army = s.armies.find(
      (a) => a.ownerId === "p1" && a.locationId === "selymbria",
    )!;
    army.units[UnitType.LEVY] = 7;
    const next = applyAction(s, { type: "LEVY_CALL", player: "p1", minorId: "m-serbia" });
    const after = next.armies.find(
      (a) => a.ownerId === "p1" && a.locationId === "selymbria",
    )!;
    // 7 + min(4, 8 - 7) = 8, never 11 — stacking invariant preserved (§6.4).
    expect(after.units[UnitType.LEVY]).toBe(8);
  });

  it("§11.5 rejects a levy call still on cooldown (LEVY_COOLDOWN)", () => {
    const s = withVassal(fresh());
    s.phase = GamePhase.DIPLOMACY;
    s.minors.find((m) => m.id === "m-serbia")!.roundsUntilLevy = 2;
    expect(() =>
      applyAction(s, { type: "LEVY_CALL", player: "p1", minorId: "m-serbia" }),
    ).toThrowError(expect.objectContaining({ code: "LEVY_COOLDOWN" }));
  });

  it("§11.5 rejects calling a levy from a minor that is not your vassal (NOT_OWNER)", () => {
    const s = withVassal(fresh());
    s.phase = GamePhase.DIPLOMACY;
    s.minors.find((m) => m.id === "m-serbia")!.vassalOf = "p2";
    expect(() =>
      applyAction(s, { type: "LEVY_CALL", player: "p1", minorId: "m-serbia" }),
    ).toThrowError(expect.objectContaining({ code: "NOT_OWNER" }));
  });
});
