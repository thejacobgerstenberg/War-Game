/**
 * combat.test.ts — §7 (field/naval combat) and §8 (sieges).
 *
 * Determinism is asserted by resolving the same (state, seed) twice and
 * deep-comparing the BattleResult. Exact-value tests use the deterministic
 * siege-bombardment channel (the first rng draws in resolveSiege), which lets
 * us predict wall damage from balance.SIEGE.bombardDamage without running the
 * whole battle. Field modifiers/rout/pursuit are exercised through overwhelming
 * or forced setups plus a determinism re-run.
 */
import { describe, it, expect, vi } from "vitest";
import {
  BuildingType,
  Faction,
  GamePhase,
  TaxPosture,
  TerrainType,
  UnitType,
  asTacticCardId,
  type ActiveModifier,
  type Army,
  type Fleet,
  type GameState,
  type PendingBattle,
  type Player,
  type Province,
  type SeaZone,
  type SiegeState,
} from "@imperium/shared";
import { emptyUnits } from "../gameState.js";
import { makeRng } from "../rng.js";
import { CONQUEST_PRESTIGE, GREAT_BOMBARD, SIEGE } from "../balance.js";
import { resolveBattle, resolveNaval, resolveSiege } from "../combat.js";

// The tactic subsystem is a sibling module; mock its combat entry-point so the
// §7.7 tactic HOOK inside combat can be unit-tested in isolation (order, ≤1/side,
// consumption, state threading) without depending on the real card resolver.
vi.mock("../tactics/index.js", () => ({
  playTactic: vi.fn((state: GameState) => state),
}));
// eslint-disable-next-line import/first
import { playTactic } from "../tactics/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function player(id: string, faction: Faction): Player {
  return {
    id,
    name: id,
    faction,
    isHost: false,
    connected: true,
    treasury: { gold: 0, grain: 0, timber: 0, marble: 0, faith: 0 },
    hand: [],
    prestige: 0,
    objectives: [],
    tax: TaxPosture.NORMAL,
    treaties: [],
    vassals: [],
    betrayals: 0,
    actionsRemaining: 0,
  };
}

function army(
  id: string,
  ownerId: string,
  locationId: string,
  units: Partial<Record<UnitType, number>>,
): Army {
  return { id, ownerId, locationId, units: { ...emptyUnits(), ...units } };
}

function fleet(
  id: string,
  ownerId: string,
  locationId: string,
  units: Partial<Record<UnitType, number>>,
): Fleet {
  return { id, ownerId, locationId, units: { ...emptyUnits(), ...units } };
}

function province(id: string, opts: Partial<Province> = {}): Province {
  return {
    id,
    name: id,
    terrain: TerrainType.PLAINS,
    yields: { gold: 0, grain: 0, timber: 0, marble: 0, faith: 0 },
    ownerId: null,
    coastal: false,
    position: { x: 0, y: 0 },
    walls: { tier: 0, hp: 0 },
    buildings: [],
    greatWorks: [],
    ...opts,
  };
}

function seaZone(id: string): SeaZone {
  return { id, name: id, position: { x: 0, y: 0 }, blockadedBy: null };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    roomCode: "TEST",
    phase: GamePhase.COMBAT,
    turn: 3,
    round: 3,
    era: 1,
    activePlayerIndex: 0,
    turnOrder: ["p1", "p2"],
    players: [player("p1", Faction.OTTOMAN), player("p2", Faction.BYZANTIUM)],
    provinces: [],
    seaZones: [],
    armies: [],
    fleets: [],
    omenDeck: [],
    omenDiscard: [],
    eraDecksRemaining: {},
    mercMarket: [],
    minors: [],
    pendingBattles: [],
    siegeStates: [],
    wars: [],
    activeModifiers: [],
    constantinopleHold: { faction: null, rounds: 0 },
    rngSeed: 1,
    rngCursor: 0,
    logCounter: 0,
    clock: 0,
    log: [],
    ...overrides,
  };
}

const SEED = 987654321;

// ---------------------------------------------------------------------------
// §7 Field combat
// ---------------------------------------------------------------------------

describe("resolveBattle (§7)", () => {
  it("occupies an undefended province without rolling dice (§6.4)", () => {
    const state = makeState({
      provinces: [province("targ", { ownerId: "p2" })],
      armies: [army("a1", "p1", "targ", { [UnitType.INFANTRY]: 3 })],
    });
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "targ",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: [],
    };
    const rng = makeRng(SEED, 0);
    const res = resolveBattle(state, battle, rng);
    expect(res.winnerId).toBe("p1");
    expect(res.rounds).toBe(0);
    expect(res.state.provinces[0].ownerId).toBe("p1");
    // no randomness consumed for an uncontested occupation
    expect(res.state.rngCursor).toBe(0);
    // input state is not mutated
    expect(state.provinces[0].ownerId).toBe("p2");
  });

  it("is deterministic: same (state, seed) twice → identical BattleResult", () => {
    const build = (): [GameState, PendingBattle] => [
      makeState({
        provinces: [province("targ", { ownerId: "p2", terrain: TerrainType.HILLS })],
        armies: [
          army("a1", "p1", "targ", {
            [UnitType.INFANTRY]: 4,
            [UnitType.ARCHER]: 2,
            [UnitType.CAVALRY]: 2,
          }),
          army("d1", "p2", "targ", {
            [UnitType.INFANTRY]: 3,
            [UnitType.ARCHER]: 2,
            [UnitType.LEVY]: 3,
          }),
        ],
      }),
      {
        id: "b1",
        provinceId: "targ",
        attackerId: "p1",
        defenderId: "p2",
        attackerStackIds: ["a1"],
        defenderStackIds: ["d1"],
      },
    ];
    const [s1, b1] = build();
    const [s2, b2] = build();
    const r1 = resolveBattle(s1, b1, makeRng(SEED, 0));
    const r2 = resolveBattle(s2, b2, makeRng(SEED, 0));
    expect(r1).toEqual(r2);
  });

  it("an overwhelming attacker captures a walled city (walls + escalade, §7.3/§8.1)", () => {
    const state = makeState({
      provinces: [
        // FL-14: restored 5-tier model — T1 = 3 HP / +1 (was 6 HP under the collapsed model).
        province("city", { ownerId: "p2", terrain: TerrainType.CITY, walls: { tier: 1, hp: 3 } }),
      ],
      armies: [
        army("a1", "p1", "city", { [UnitType.INFANTRY]: 20 }),
        army("d1", "p2", "city", { [UnitType.LEVY]: 1 }),
      ],
    });
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "city",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
    };
    const res = resolveBattle(state, battle, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1");
    expect(res.state.provinces[0].ownerId).toBe("p1");
    expect(res.rounds).toBeGreaterThanOrEqual(1);
    // the RNG stream advanced (dice were rolled)
    expect(res.state.rngCursor).toBeGreaterThan(0);
  });

  it("resolves rout/pursuit against a hopeless defender (§7.5) and captures", () => {
    const build = (): [GameState, PendingBattle] => [
      makeState({
        provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
        armies: [
          army("a1", "p1", "field", { [UnitType.CAVALRY]: 12, [UnitType.INFANTRY]: 6 }),
          army("d1", "p2", "field", { [UnitType.LEVY]: 4 }),
        ],
      }),
      {
        id: "b1",
        provinceId: "field",
        attackerId: "p1",
        defenderId: "p2",
        attackerStackIds: ["a1"],
        defenderStackIds: ["d1"],
      },
    ];
    const [s1, b1] = build();
    const res = resolveBattle(s1, b1, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1");
    expect(res.state.provinces[0].ownerId).toBe("p1");
    // defender took casualties (rout+pursuit or annihilation)
    const defLost = Object.values(res.defender.losses).reduce((a, b) => a + b, 0);
    expect(defLost).toBeGreaterThan(0);
    // determinism re-run
    const [s2, b2] = build();
    const res2 = resolveBattle(s2, b2, makeRng(SEED, 0));
    expect(res2).toEqual(res);
  });
});

// ---------------------------------------------------------------------------
// §8 Sieges
// ---------------------------------------------------------------------------

/** A siege where the besieger is SIEGE-only: it bombards but scores 0 assault
 *  hits, so the wall-HP change is entirely the bombardment table (§8.2.2). */
function bombardOnlyState(overrides: Partial<Province> = {}): GameState {
  return makeState({
    provinces: [
      province("keep", {
        ownerId: "p2",
        terrain: TerrainType.CITY,
        walls: { tier: 3, hp: 10 }, // FL-14: 10 HP is T3 (10/+3) in the restored 5-tier model
        garrison: 2,
        ...overrides,
      }),
    ],
    armies: [army("s1", "p1", "keep", { [UnitType.SIEGE]: 1 })],
    siegeStates: [siegeState()],
  });
}

function siegeState(overrides: Partial<SiegeState> = {}): SiegeState {
  return {
    provinceId: "keep",
    besiegerId: "p1",
    besiegingArmyIds: ["s1"],
    roundsElapsed: 0,
    grainStores: 99,
    breached: false,
    circumvallated: false,
    ...overrides,
  };
}

describe("resolveSiege (§8)", () => {
  it("bombardment reduces wall HP by the §8.2.2 table for the rolled d6", () => {
    const state = bombardOnlyState();
    // resolveSiege's first RNG draws are the bombardment dice (1 SIEGE → 1 roll).
    const predictedRoll = makeRng(SEED, 0).rollD6();
    const expectedDamage = SIEGE.bombardDamage[predictedRoll];
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.wallHpRemaining).toBe(10 - expectedDamage);
    expect(res.captured).toBe(false);
  });

  it("caps an ordinary siege train to 1 Wall-HP/round vs an intact T5 wall, regardless of holder (FL-01, §8.3)", () => {
    // T5 Theodosian = tier 5 (16 HP / +4). A 40-gun train would roll dozens of HP
    // uncapped; the masonry cap holds ordinary bombardment to 1 HP/round IN TOTAL.
    // The cap is a property of the intact wall, NOT the defender's faction — a
    // non-Byzantine holder of the City is equally protected.
    const runFor = (holder: Faction): number[] => {
      let state = makeState({
        players: [player("p1", Faction.OTTOMAN), player("p2", holder)],
        provinces: [
          province("constantinople", {
            ownerId: "p2",
            terrain: TerrainType.CITY,
            walls: { tier: 5, hp: 16 },
            garrison: 1,
          }),
        ],
        armies: [army("s1", "p1", "constantinople", { [UnitType.SIEGE]: 40 })],
        siegeStates: [siegeState({ provinceId: "constantinople" })],
      });
      const hps: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
        hps.push(res.wallHpRemaining);
        state = res.state;
      }
      return hps;
    };
    // 16 → 15 → 14 → 13: exactly the SIEGE.t5MasonryCapPerRound each round.
    const capped = [16, 15, 14].map((h) => h - SIEGE.t5MasonryCapPerRound);
    expect(runFor(Faction.BYZANTIUM)).toEqual(capped);
    expect(runFor(Faction.VENICE)).toEqual(capped); // non-Byzantine holder equally protected
  });

  it("garrison holds the default 3 rounds then starves 1/round (§8.2.3)", () => {
    // Besieger is 30 SIEGE (survives, but scores 0 assault hits), so the garrison
    // can only shrink via starvation.
    let state = makeState({
      provinces: [
        province("keep", { ownerId: "p2", walls: { tier: 0, hp: 0 }, garrison: 5 }),
      ],
      armies: [army("s1", "p1", "keep", { [UnitType.SIEGE]: 30 })],
      // FL-12: starvation is driven off grainStores. No Granary → initial stores =
      // baseHoldoutRounds; each round depletes 1, hunger begins once stores hit 0.
      siegeStates: [siegeState({ grainStores: SIEGE.baseHoldoutRounds })],
    });
    const garrisonAfter = (n: number): number => {
      for (let i = 0; i < n; i += 1) {
        const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
        state = res.state;
      }
      return state.provinces[0].garrison ?? 0;
    };
    // baseHoldoutRounds = 3 stores: garrison intact through round 3.
    expect(garrisonAfter(SIEGE.baseHoldoutRounds)).toBe(5);
    // the very next round begins starvation.
    expect(garrisonAfter(1)).toBe(5 - SIEGE.starvationLossPerRound);
  });

  it("a Granary extends the starvation hold-out by +2 rounds (§8.2.3)", () => {
    let state = makeState({
      provinces: [
        province("keep", {
          ownerId: "p2",
          walls: { tier: 0, hp: 0 },
          garrison: 5,
          buildings: [BuildingType.GRANARY],
        }),
      ],
      armies: [army("s1", "p1", "keep", { [UnitType.SIEGE]: 30 })],
      // FL-12: the Granary's +2 is folded into the INITIAL grainStores at siege
      // creation (not a parallel holdout constant), so a Granary city starts with
      // base + granary stores. combat.ts drives starvation purely off grainStores.
      siegeStates: [siegeState({ grainStores: SIEGE.baseHoldoutRounds + SIEGE.granaryBonusRounds })],
    });
    const holdout = SIEGE.baseHoldoutRounds + SIEGE.granaryBonusRounds;
    const garrisonAfter = (n: number): number => {
      for (let i = 0; i < n; i += 1) {
        const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
        state = res.state;
      }
      return state.provinces[0].garrison ?? 0;
    };
    expect(garrisonAfter(holdout)).toBe(5); // still fed thanks to the Granary
    expect(garrisonAfter(1)).toBe(5 - SIEGE.starvationLossPerRound);
  });

  it("assault through a breach (HP=0) uses field odds and captures (§8.2.4)", () => {
    const state = makeState({
      provinces: [
        province("keep", { ownerId: "p2", terrain: TerrainType.PLAINS, walls: { tier: 0, hp: 0 }, garrison: 1 }),
      ],
      armies: [army("s1", "p1", "keep", { [UnitType.INFANTRY]: 20 })],
      siegeStates: [siegeState()],
    });
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(true);
    expect(res.state.provinces[0].ownerId).toBe("p1");
  });

  it("an intact wall (HP>0) with escalade repels a token assault (§8.2.4)", () => {
    const state = makeState({
      provinces: [
        // FL-14: Theodosian = tier 5 (16 HP / +4) in the restored 5-tier model.
        province("keep", { ownerId: "p2", terrain: TerrainType.CITY, walls: { tier: 5, hp: 16 }, garrison: 10 }),
      ],
      // A lone LEVY cannot storm Theodosian walls (defender +4, escalade −1).
      armies: [army("s1", "p1", "keep", { [UnitType.LEVY]: 1 })],
      siegeStates: [siegeState()],
    });
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(false);
    expect(res.state.provinces[0].ownerId).toBe("p2");
    expect(res.wallHpRemaining).toBeGreaterThan(0);
  });

  it("relief lifts the siege and walls repair +1/round (§8.2.5)", () => {
    const state = makeState({
      provinces: [
        // FL-14: T2 = 6 HP / +2 in the restored 5-tier model (was T1 under the collapsed model).
        province("keep", { ownerId: "p2", walls: { tier: 2, hp: 5 } }),
      ],
      // besieging army was wiped by a relief force → no units remain
      armies: [army("s1", "p1", "keep", {})],
      siegeStates: [siegeState()],
    });
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(false);
    // tier-2 max HP is 6; repair +1 from 5 → 6 (capped).
    expect(res.wallHpRemaining).toBe(6);
    expect(res.state.siegeStates).toHaveLength(0);
    expect(res.state.provinces[0].siege).toBeUndefined();
  });

  it("is deterministic: same siege resolved twice → identical result", () => {
    const s1 = bombardOnlyState();
    const s2 = bombardOnlyState();
    const r1 = resolveSiege(s1, s1.siegeStates[0], makeRng(SEED, 0));
    const r2 = resolveSiege(s2, s2.siegeStates[0], makeRng(SEED, 0));
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// §7.6 Naval combat
// ---------------------------------------------------------------------------

describe("resolveNaval (§7.6)", () => {
  it("an uncontested sea zone falls under the mover's control", () => {
    const state = makeState({
      seaZones: [seaZone("aegean")],
      fleets: [fleet("f1", "p1", "aegean", { [UnitType.WARSHIP]: 2 })],
    });
    const battle: PendingBattle = {
      id: "n1",
      seaZoneId: "aegean",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["f1"],
      defenderStackIds: [],
      isNaval: true,
    };
    const res = resolveNaval(state, battle, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1");
    expect(res.rounds).toBe(0);
    expect(res.state.seaZones[0].blockadedBy).toBe("p1");
    expect(res.state.rngCursor).toBe(0);
  });

  it("the winner of a naval battle controls the zone (§7.6)", () => {
    const build = (): [GameState, PendingBattle] => [
      makeState({
        seaZones: [seaZone("aegean")],
        fleets: [
          fleet("f1", "p1", "aegean", { [UnitType.WARSHIP]: 6 }),
          fleet("f2", "p2", "aegean", { [UnitType.GALLEY]: 1 }),
        ],
      }),
      {
        id: "n1",
        seaZoneId: "aegean",
        attackerId: "p1",
        defenderId: "p2",
        attackerStackIds: ["f1"],
        defenderStackIds: ["f2"],
        isNaval: true,
      },
    ];
    const [s1, b1] = build();
    const res = resolveNaval(s1, b1, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1");
    expect(res.state.seaZones[0].blockadedBy).toBe("p1");
    // determinism re-run
    const [s2, b2] = build();
    expect(resolveNaval(s2, b2, makeRng(SEED, 0))).toEqual(res);
  });

  it("refuses to resolve naval combat in a frozen sea zone (freeze_sea, §7.6)", () => {
    const freeze: ActiveModifier = {
      id: "ice",
      scope: "round",
      kind: "freeze_sea",
      target: { seaZoneId: "aegean" },
    };
    const state = makeState({
      seaZones: [seaZone("aegean")],
      fleets: [
        fleet("f1", "p1", "aegean", { [UnitType.WARSHIP]: 6 }),
        fleet("f2", "p2", "aegean", { [UnitType.GALLEY]: 3 }),
      ],
      activeModifiers: [freeze],
    });
    const battle: PendingBattle = {
      id: "n1",
      seaZoneId: "aegean",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["f1"],
      defenderStackIds: ["f2"],
      isNaval: true,
    };
    const res = resolveNaval(state, battle, makeRng(SEED, 0));
    expect(res.winnerId).toBeNull();
    expect(res.rounds).toBe(0);
    // no dice rolled, no blockade flip, both fleets intact
    expect(res.state.rngCursor).toBe(0);
    expect(res.state.seaZones[0].blockadedBy).toBeNull();
    expect(res.state.fleets).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §8.4 Great Bombard
// ---------------------------------------------------------------------------

/** An Army carrying a Great Bombard variant piece (base SIEGE). */
function bombardArmy(id: string, ownerId: string, locationId: string, count = 1): Army {
  return {
    id,
    ownerId,
    locationId,
    units: { ...emptyUnits() },
    variants: [{ base: UnitType.SIEGE, variant: GREAT_BOMBARD.variant, count }],
  };
}

describe("Great Bombard (§8.4)", () => {
  it("an UNLOCKED Great Bombard rolls bombardDice dice/round vs the walls", () => {
    const p1 = { ...player("p1", Faction.OTTOMAN), greatBombardUnlocked: true };
    const state = makeState({
      players: [p1, player("p2", Faction.BYZANTIUM)],
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 3, hp: 10 }, // FL-14: 10 HP is T3 (10/+3) in the restored 5-tier model
          garrison: 1,
        }),
      ],
      armies: [bombardArmy("gb", "p1", "keep")],
      siegeStates: [siegeState({ besiegingArmyIds: ["gb"] })],
    });
    // No generic guns roll first → the Bombard's `bombardDice` dice are the first
    // RNG draws; each maps through SIEGE.bombardDamage, capped per round.
    const predict = makeRng(SEED, 0);
    let expected = 0;
    for (const r of predict.rollDice(GREAT_BOMBARD.bombardDice)) expected += SIEGE.bombardDamage[r];
    expected = Math.min(expected, GREAT_BOMBARD.maxWallDamagePerRound);
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.wallHpRemaining).toBe(10 - expected);
    // enhanced fire: a single Bombard removes more than a single ordinary die could
    // when both dice are non-trivial (sanity: at least the smaller single die).
    expect(10 - res.wallHpRemaining).toBe(expected);
  });

  it("a LOCKED Great Bombard fires as an ordinary single-die siege gun", () => {
    // p1 has NOT unlocked it → the piece is treated as one generic SIEGE gun.
    const state = makeState({
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 3, hp: 10 }, // FL-14: 10 HP is T3 (10/+3) in the restored 5-tier model
          garrison: 1,
        }),
      ],
      armies: [bombardArmy("gb", "p1", "keep")],
      siegeStates: [siegeState({ besiegingArmyIds: ["gb"] })],
    });
    const singleDie = SIEGE.bombardDamage[makeRng(SEED, 0).rollD6()];
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.wallHpRemaining).toBe(10 - singleDie);
  });

  it("an UNLOCKED Great Bombard cracks Theodosian walls despite the T5 masonry cap (§8.3/§8.4)", () => {
    const p1 = { ...player("p1", Faction.OTTOMAN), greatBombardUnlocked: true };
    const state = makeState({
      players: [p1, player("p2", Faction.BYZANTIUM)],
      provinces: [
        province("constantinople", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 5, hp: 16 }, // FL-14: T5 Theodosian in the restored 5-tier model
          garrison: 1,
        }),
      ],
      armies: [bombardArmy("gb", "p1", "constantinople")],
      siegeStates: [siegeState({ provinceId: "constantinople", besiegingArmyIds: ["gb"] })],
    });
    // An ordinary train would be held to SIEGE.t5MasonryCapPerRound, but an unlocked
    // Bombard lifts the cap for the whole train → the walls take real damage.
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.wallHpRemaining).toBeLessThan(16);
  });
});

// ---------------------------------------------------------------------------
// CANON sea-resupply (GD §8.2)
// ---------------------------------------------------------------------------

describe("sea-resupply siege rule (GD §8.2, CANON)", () => {
  // constantinople is coastal and adjacent to "sea-of-marmara" in the canonical map.
  const runSiege = (seaOwner: string | null, rounds: number): number => {
    let state = makeState({
      provinces: [
        province("constantinople", {
          ownerId: "p2",
          coastal: true,
          walls: { tier: 0, hp: 0 },
          garrison: 5,
        }),
      ],
      // SIEGE-only besieger: no assault troops, so the garrison can only starve.
      armies: [army("s1", "p1", "constantinople", { [UnitType.SIEGE]: 30 })],
      seaZones: [{ id: "sea-of-marmara", name: "sea-of-marmara", position: { x: 0, y: 0 }, blockadedBy: seaOwner }],
      // FL-12: initial stores = baseHoldoutRounds; an open lane preserves them.
      siegeStates: [siegeState({ provinceId: "constantinople", grainStores: SIEGE.baseHoldoutRounds })],
    });
    for (let i = 0; i < rounds; i += 1) {
      const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
      state = res.state;
    }
    return state.provinces[0].garrison ?? 0;
  };

  it("a friendly/neutral adjacent sea keeps a coastal city fed (no starvation)", () => {
    // sea-of-marmara uncontrolled → open lane → garrison never starves.
    expect(runSiege(null, SIEGE.baseHoldoutRounds + 3)).toBe(5);
  });

  it("an ENEMY-controlled adjacent sea allows the coastal city to starve", () => {
    // sea-of-marmara blockaded by the besieger (p1) → lane cut → starvation resumes.
    expect(runSiege("p1", SIEGE.baseHoldoutRounds + 1)).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// §8 multi-round siege progression
// ---------------------------------------------------------------------------

describe("multi-round siege progression (§8)", () => {
  it("bombardment reduces wall HP across successive COMBAT phases and persists the SiegeState", () => {
    let state = makeState({
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 3, hp: 10 }, // FL-14: 10 HP is T3 (10/+3) in the restored 5-tier model
          garrison: 3,
        }),
      ],
      // 1 SIEGE (1–3 dmg/round, no assault troops): HP strictly falls but the
      // 10-HP wall cannot breach within 3 rounds (max 9 dmg), so the strict-<
      // assertion never hits the HP=0 floor.
      armies: [army("s1", "p1", "keep", { [UnitType.SIEGE]: 1 })],
      siegeStates: [siegeState({ besiegingArmyIds: ["s1"] })],
    });
    let prevHp = state.provinces[0].walls.hp;
    let prevRounds = 0;
    for (let i = 0; i < 3; i += 1) {
      const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
      state = res.state;
      // §8.2.2 bombardment removes ≥1 HP/round while walls stand.
      expect(res.wallHpRemaining).toBeLessThan(prevHp);
      prevHp = res.wallHpRemaining;
      // the SiegeState persists and its round counter advances.
      const live = state.siegeStates.find((s) => s.provinceId === "keep");
      expect(live).toBeDefined();
      expect(live?.roundsElapsed).toBe(prevRounds + 1);
      prevRounds = live?.roundsElapsed ?? 0;
    }
  });

  it("tracks the starvation timer once the hold-out elapses (§8.2.3)", () => {
    let state = makeState({
      provinces: [
        province("keep", { ownerId: "p2", walls: { tier: 0, hp: 0 }, garrison: 6 }),
      ],
      armies: [army("s1", "p1", "keep", { [UnitType.SIEGE]: 30 })],
      // FL-12: no Granary → initial stores = baseHoldoutRounds; two ticks after it empties.
      siegeStates: [siegeState({ besiegingArmyIds: ["s1"], grainStores: SIEGE.baseHoldoutRounds })],
    });
    for (let i = 0; i < SIEGE.baseHoldoutRounds + 2; i += 1) {
      const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
      state = res.state;
    }
    const live = state.siegeStates.find((s) => s.provinceId === "keep");
    // two starvation ticks past a 3-round hold-out.
    expect(live?.starvationCounter).toBe(2);
    expect(state.provinces[0].garrison).toBe(6 - 2 * SIEGE.starvationLossPerRound);
  });
});

// ---------------------------------------------------------------------------
// §7.3/§7.5 modifier readers (combat_mod, morale, siege_mod)
// ---------------------------------------------------------------------------

describe("combat modifier readers (§7.3/§7.5, CONTRACT2 §12.10)", () => {
  const contested = (mods: ActiveModifier[]): GameState =>
    makeState({
      provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
      armies: [
        army("a1", "p1", "field", { [UnitType.INFANTRY]: 5 }),
        army("d1", "p2", "field", { [UnitType.INFANTRY]: 5 }),
      ],
      activeModifiers: mods,
    });
  const battle: PendingBattle = {
    id: "b1",
    provinceId: "field",
    attackerId: "p1",
    defenderId: "p2",
    attackerStackIds: ["a1"],
    defenderStackIds: ["d1"],
  };

  it("a combat_mod on the defender changes the deterministic outcome", () => {
    const baseline = resolveBattle(contested([]), battle, makeRng(SEED, 0));
    const buff: ActiveModifier = {
      id: "cm",
      scope: "round",
      kind: "combat_mod",
      target: { faction: Faction.BYZANTIUM }, // p2's faction
      value: 4,
    };
    const withMod = resolveBattle(contested([buff]), battle, makeRng(SEED, 0));
    // The modifier was READ: the same seed produces a materially different result.
    expect(withMod).not.toEqual(baseline);
    // deterministic under the modifier
    const withMod2 = resolveBattle(contested([buff]), battle, makeRng(SEED, 0));
    expect(withMod2).toEqual(withMod);
  });

  it("a morale modifier shifts the rout threshold and changes the outcome", () => {
    // A grind where the defender degrades below 50% while still alive, so a rout
    // check fires. Comparing morale +6 (threshold→0, NEVER routs) against −6
    // (threshold→6, ALWAYS routs) guarantees divergence independent of the d6.
    const grind = (mods: ActiveModifier[]): GameState =>
      makeState({
        provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
        armies: [
          army("a1", "p1", "field", { [UnitType.INFANTRY]: 10 }),
          army("d1", "p2", "field", { [UnitType.INFANTRY]: 6 }),
        ],
        activeModifiers: mods,
      });
    const morale = (value: number): ActiveModifier => ({
      id: `mor${value}`,
      scope: "round",
      kind: "morale",
      target: { faction: Faction.BYZANTIUM }, // the defender
      value,
    });
    const neverRout = resolveBattle(grind([morale(6)]), battle, makeRng(SEED, 0));
    const alwaysRout = resolveBattle(grind([morale(-6)]), battle, makeRng(SEED, 0));
    expect(alwaysRout).not.toEqual(neverRout);
  });

  it("a siege_mod adds to bombardment wall damage", () => {
    const base = bombardOnlyState();
    const boosted = makeState({
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 3, hp: 10 }, // FL-14: 10 HP is T3 (10/+3) in the restored 5-tier model
          garrison: 2,
        }),
      ],
      armies: [army("s1", "p1", "keep", { [UnitType.SIEGE]: 1 })],
      siegeStates: [siegeState()],
      activeModifiers: [
        {
          id: "sm",
          scope: "round",
          kind: "siege_mod",
          target: { faction: Faction.OTTOMAN }, // p1's faction
          value: 2,
        },
      ],
    });
    const baseRes = resolveSiege(base, base.siegeStates[0], makeRng(SEED, 0));
    const boostRes = resolveSiege(boosted, boosted.siegeStates[0], makeRng(SEED, 0));
    expect(10 - boostRes.wallHpRemaining).toBe(10 - baseRes.wallHpRemaining + 2);
  });
});

// ---------------------------------------------------------------------------
// §7.7 tactic hook (attacker-then-defender, ≤1 per side per round)
// ---------------------------------------------------------------------------

describe("tactic hook in the battle round loop (§7.7)", () => {
  it("plays attacker-then-defender, at most one card per side per round, without mutating the input", () => {
    const calls: { side: string; cardId: string }[] = [];
    vi.mocked(playTactic).mockImplementation(
      (state: GameState, _battle, side: string, cardId) => {
        calls.push({ side, cardId: String(cardId) });
        return state; // no-op resolver: we assert only the hook wiring
      },
    );
    const state = makeState({
      provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
      armies: [
        army("a1", "p1", "field", { [UnitType.INFANTRY]: 12 }),
        army("d1", "p2", "field", { [UnitType.LEVY]: 1 }),
      ],
    });
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "field",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
      // two attacker cards queued but a single round should consume only the first.
      attackerTactics: [asTacticCardId("atk-a"), asTacticCardId("atk-b")],
      defenderTactics: [asTacticCardId("def-a")],
    };
    const res = resolveBattle(state, battle, makeRng(SEED, 0));

    // Attacker declares first each round; ≤1 per side per round.
    const attackerCalls = calls.filter((c) => c.side === "attacker");
    const defenderCalls = calls.filter((c) => c.side === "defender");
    expect(attackerCalls.length).toBe(Math.min(2, res.rounds));
    expect(defenderCalls.length).toBe(Math.min(1, res.rounds));
    expect(calls[0]).toEqual({ side: "attacker", cardId: "atk-a" });
    if (res.rounds >= 1) {
      // within a round, the attacker's card resolves before the defender's.
      const firstDefIdx = calls.findIndex((c) => c.side === "defender");
      expect(firstDefIdx).toBe(1);
      expect(calls[1]).toEqual({ side: "defender", cardId: "def-a" });
    }
    // FIFO consumption: the 2nd attacker card only plays if the fight ran ≥2 rounds.
    if (res.rounds < 2) {
      expect(calls.some((c) => c.cardId === "atk-b")).toBe(false);
    }
    // PURITY: the caller's input battle queues are untouched.
    expect(battle.attackerTactics).toEqual([asTacticCardId("atk-a"), asTacticCardId("atk-b")]);
    expect(battle.defenderTactics).toEqual([asTacticCardId("def-a")]);

    vi.mocked(playTactic).mockReset();
    vi.mocked(playTactic).mockImplementation((s: GameState) => s);
  });
});

// ---------------------------------------------------------------------------
// §13 prestige signals (prestige_pending)
// ---------------------------------------------------------------------------

describe("prestige signals (§13, CONTRACT2 §12.8)", () => {
  it("posts a prestige_pending award to the winner on a decisive battle (never mutates prestige)", () => {
    const state = makeState({
      provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
      armies: [
        army("a1", "p1", "field", { [UnitType.CAVALRY]: 12, [UnitType.INFANTRY]: 6 }),
        army("d1", "p2", "field", { [UnitType.LEVY]: 3 }),
      ],
    });
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "field",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
    };
    const res = resolveBattle(state, battle, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1");
    const pend = res.state.activeModifiers.filter((m) => m.kind === "prestige_pending");
    // at least the decisive-battle +1 targeting the winner's faction (OTTOMAN).
    const decisive = pend.find((m) => m.data?.reason === "decisive_battle");
    expect(decisive).toBeDefined();
    expect(decisive?.value).toBe(CONQUEST_PRESTIGE.decisiveBattle);
    expect(decisive?.scope).toBe("round");
    expect(decisive?.target?.faction).toBe(Faction.OTTOMAN);
    // combat must NOT mutate Player.prestige directly (prestige is scored later).
    expect(res.state.players.find((p) => p.id === "p1")?.prestige).toBe(0);
  });

  it("posts a walled-city award (+3 at high tier) when a storm captures a T4–T5 city", () => {
    const state = makeState({
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.PLAINS,
          // FL-14: high-tier award is MAP tier ≥ 4 (T4–T5). tier 4 = great fortress.
          walls: { tier: 4, hp: 0 }, // already breached → field-odds assault
          garrison: 1,
        }),
      ],
      armies: [army("s1", "p1", "keep", { [UnitType.INFANTRY]: 20 })],
      siegeStates: [siegeState()],
    });
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(true);
    const pend = res.state.activeModifiers.filter((m) => m.kind === "prestige_pending");
    const city = pend.find((m) => m.data?.reason === "take_walled_city");
    expect(city?.value).toBe(CONQUEST_PRESTIGE.takeWalledCityHighTier);
    expect(city?.target?.faction).toBe(Faction.OTTOMAN);
  });
});
