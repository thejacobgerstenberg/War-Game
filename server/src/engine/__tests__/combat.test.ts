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
import { describe, it, expect } from "vitest";
import {
  BuildingType,
  Faction,
  GamePhase,
  TaxPosture,
  TerrainType,
  UnitType,
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
import { SIEGE } from "../balance.js";
import { resolveBattle, resolveNaval, resolveSiege } from "../combat.js";

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
    treasury: { gold: 0, grain: 0, timber: 0, stone: 0, faith: 0 },
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
    yields: { gold: 0, grain: 0, timber: 0, stone: 0, faith: 0 },
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
        province("city", { ownerId: "p2", terrain: TerrainType.CITY, walls: { tier: 1, hp: 6 } }),
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
        walls: { tier: 2, hp: 10 },
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

  it("Byzantine Theodosian Walls auto-repel the first rounds of bombardment (§8.3)", () => {
    // Theodosian = HP tier 3; defender is BYZANTIUM (p2) → auto-repel while
    // roundsElapsed <= SIEGE.byzantineAutoRepelRounds.
    let state = makeState({
      provinces: [
        province("constantinople", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 3, hp: 16 },
          garrison: 1,
        }),
      ],
      // Many bombards so the besieger survives the token garrison's sorties
      // across the whole auto-repel window.
      armies: [army("s1", "p1", "constantinople", { [UnitType.SIEGE]: 40 })],
      siegeStates: [siegeState({ provinceId: "constantinople" })],
    });
    for (let round = 0; round < SIEGE.byzantineAutoRepelRounds; round += 1) {
      const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
      expect(res.wallHpRemaining).toBe(16); // no damage while auto-repelling
      state = res.state;
    }
    // Once past the auto-repel window, bombardment bites.
    const after = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
    expect(after.wallHpRemaining).toBeLessThan(16);
  });

  it("garrison holds the default 3 rounds then starves 1/round (§8.2.3)", () => {
    // Besieger is 30 SIEGE (survives, but scores 0 assault hits), so the garrison
    // can only shrink via starvation.
    let state = makeState({
      provinces: [
        province("keep", { ownerId: "p2", walls: { tier: 0, hp: 0 }, garrison: 5 }),
      ],
      armies: [army("s1", "p1", "keep", { [UnitType.SIEGE]: 30 })],
      siegeStates: [siegeState({ grainStores: 99 })],
    });
    const garrisonAfter = (n: number): number => {
      for (let i = 0; i < n; i += 1) {
        const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
        state = res.state;
      }
      return state.provinces[0].garrison ?? 0;
    };
    // baseHoldoutRounds = 3: garrison intact through round 3.
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
      siegeStates: [siegeState({ grainStores: 99 })],
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
        province("keep", { ownerId: "p2", terrain: TerrainType.CITY, walls: { tier: 3, hp: 16 }, garrison: 10 }),
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
        province("keep", { ownerId: "p2", walls: { tier: 1, hp: 5 } }),
      ],
      // besieging army was wiped by a relief force → no units remain
      armies: [army("s1", "p1", "keep", {})],
      siegeStates: [siegeState()],
    });
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(false);
    // tier-1 max HP is 6; repair +1 from 5 → 6 (capped).
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
});
