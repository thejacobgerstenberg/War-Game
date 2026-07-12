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
import { describe, it, expect, vi, beforeEach } from "vitest";
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
import {
  CONQUEST_PRESTIGE,
  GREAT_BOMBARD,
  ROUNDS,
  SIEGE,
  TEMPLE_MORALE_BONUS,
  TREASON_GATE,
} from "../balance.js";
import { resolveBattle, resolveNaval, resolveSiege } from "../combat.js";
import { scorePrestige } from "../prestige.js";
import { startingObjectives } from "../factions.js";
import { playTactic } from "../tactics/index.js";
// The REAL resolver, imported from the flat module ("../tactics.js" — a different
// specifier than the mocked barrel), for the Stage-B CONSUMPTION tests: those must
// exercise the full card → modifier → dice/state-delta chain, not a stub.
import { playTactic as realPlayTactic } from "../tactics.js";

// The tactic subsystem is a sibling module; mock its barrel entry-point so the
// §7.7 tactic HOOK inside combat can be unit-tested in isolation (order, ≤1/side,
// consumption, state threading). The default implementation is a no-op identity;
// the Stage-B consumption suites swap in `realPlayTactic` per test via
// `useRealTactics()`. (combat.ts reads card DATA from ../tactics/cards.js, which
// is intentionally NOT mocked.)
vi.mock("../tactics/index.js", () => ({
  playTactic: vi.fn((state: GameState) => state),
}));

/** Route the combat tactic hook to the REAL §7.7 resolver for this test. */
function useRealTactics(): void {
  vi.mocked(playTactic).mockImplementation(realPlayTactic);
}

beforeEach(() => {
  // Every test starts from the no-op stub; consumption tests opt into the real
  // resolver explicitly. Keeps the suites order-independent.
  vi.mocked(playTactic).mockReset();
  vi.mocked(playTactic).mockImplementation((state: GameState) => state);
});

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
    port: false,
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
// §6.4 / §7.5 rout retreat respects the stacking cap ("else surrenders")
// ---------------------------------------------------------------------------

describe("rout retreat enforces §6.4 stacking (overflow surrenders)", () => {
  // philippopolis is adjacent to edirne (an Ottoman CAPITAL → 12-cap) in the
  // canonical map graph, so a routed p2 stack at philippopolis retreats into
  // edirne. A morale −6 modifier forces the rout deterministically; the p1
  // attacker is cavalry-free so pursuit inflicts no extra hits. Seed 6 makes the
  // defender rout with 3 survivors, so the destination's remaining room decides
  // how many make it home.
  const morale = (v: number): ActiveModifier => ({
    id: "mor",
    scope: "round",
    kind: "morale",
    target: { faction: Faction.BYZANTIUM }, // the defender p2
    value: v,
  });
  const build = (edirneGarrison: number): [GameState, PendingBattle] => [
    makeState({
      provinces: [
        province("philippopolis", { ownerId: "p2", terrain: TerrainType.PLAINS }),
        // Capital → §6.4 cap 12; pre-seeded with `edirneGarrison` friendly units.
        province("edirne", { ownerId: "p2", isCapitalOf: Faction.OTTOMAN }),
      ],
      armies: [
        army("a1", "p1", "philippopolis", { [UnitType.INFANTRY]: 20 }), // no cavalry → no pursuit
        army("d1", "p2", "philippopolis", { [UnitType.LEVY]: 8 }),
        army("garr", "p2", "edirne", { [UnitType.INFANTRY]: edirneGarrison }),
      ],
      activeModifiers: [morale(-6)],
    }),
    {
      id: "b1",
      provinceId: "philippopolis",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
    },
  ];
  const p2AtEdirne = (s: GameState): number =>
    s.armies
      .filter((a) => a.ownerId === "p2" && a.locationId === "edirne")
      .reduce((n, a) => n + Object.values(a.units).reduce((x, y) => x + y, 0), 0);

  it("only moves what fits into a near-full destination; overflow surrenders (never exceeds cap)", () => {
    // edirne holds 11/12 → exactly 1 slot free. The 3 rout survivors: 1 retreats,
    // 2 surrender. edirne lands on the cap, not over it.
    const [state, battle] = build(11);
    const res = resolveBattle(state, battle, makeRng(6, 0));
    expect(res.defender.routed).toContain("d1");
    expect(p2AtEdirne(res.state)).toBe(12); // §6.4 cap, never breached
    const survivor = res.state.armies.find((a) => a.id === "d1");
    expect(survivor?.locationId).toBe("edirne");
    expect(Object.values(survivor!.units).reduce((x, y) => x + y, 0)).toBe(1);
    const overflow = res.state.log.find((l) => (l.data as { retreatOverflowSurrendered?: number }).retreatOverflowSurrendered);
    expect((overflow?.data as { retreatOverflowSurrendered?: number })?.retreatOverflowSurrendered).toBe(2);
  });

  it("surrenders the whole stack when the only adjacent destination is at capacity", () => {
    // edirne holds 12/12 → no room; philippopolis's other neighbours are off-map
    // here, so there is nowhere to retreat and the routed stack surrenders entirely.
    const [state, battle] = build(12);
    const res = resolveBattle(state, battle, makeRng(6, 0));
    expect(res.defender.routed).toContain("d1");
    expect(p2AtEdirne(res.state)).toBe(12); // unchanged, still at cap
    expect(res.state.armies.find((a) => a.id === "d1")).toBeUndefined(); // wholly removed
  });

  it("a normal retreat into a low-occupancy destination still moves every survivor", () => {
    // edirne holds 2/12 → ample room; all 3 survivors retreat, nothing surrenders.
    const [state, battle] = build(2);
    const res = resolveBattle(state, battle, makeRng(6, 0));
    expect(res.defender.routed).toContain("d1");
    const survivor = res.state.armies.find((a) => a.id === "d1");
    expect(survivor?.locationId).toBe("edirne");
    expect(Object.values(survivor!.units).reduce((x, y) => x + y, 0)).toBe(3);
    expect(p2AtEdirne(res.state)).toBe(5); // 2 pre-existing + 3 retreated
    expect(
      res.state.log.some((l) => (l.data as { retreatOverflowSurrendered?: number }).retreatOverflowSurrendered),
    ).toBe(false);
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
    // §8.2 step 4 CHOSEN ASSAULT (Stage B): sieges no longer auto-assault; the
    // fixture defaults to a declared assault so the storm-path tests exercise
    // the assault branch. Undeclared-round tests override this to false.
    assaultDeclared: true,
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
  it("a #34-spawned Great Bombard rolls bombardDice dice/round vs the walls once emplaced", () => {
    // The piece enters play the CANON way: the GameState.greatBombard singleton (set
    // by Omen #34) + a GREAT_BOMBARD variant unit in the besieging force. Its physical
    // presence — not any Player flag — authorizes enhanced fire. emplacedRound 2 with
    // the default round 3 means it is past its 1-round emplacement and may fire.
    const state = makeState({
      players: [player("p1", Faction.OTTOMAN), player("p2", Faction.BYZANTIUM)],
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 3, hp: 10 }, // FL-14: 10 HP is T3 (10/+3) in the restored 5-tier model
          garrison: 1,
        }),
      ],
      armies: [bombardArmy("gb", "p1", "keep")],
      greatBombard: { inPlay: true, ownerId: "p1", provinceId: "keep", emplacedRound: 2 },
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
    // enhanced fire: the Bombard fires its full bombardDice (not one ordinary die).
    expect(10 - res.wallHpRemaining).toBe(expected);
  });

  it("a #34-spawned Great Bombard cracks Theodosian walls despite the T5 masonry cap (§8.3/§8.4)", () => {
    const state = makeState({
      players: [player("p1", Faction.OTTOMAN), player("p2", Faction.BYZANTIUM)],
      provinces: [
        province("constantinople", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 5, hp: 16 }, // FL-14: T5 Theodosian in the restored 5-tier model
          garrison: 1,
        }),
      ],
      armies: [bombardArmy("gb", "p1", "constantinople")],
      // Canon spawn: singleton + variant piece; emplaced (emplacedRound 2 < round 3).
      greatBombard: { inPlay: true, ownerId: "p1", provinceId: "constantinople", emplacedRound: 2 },
      siegeStates: [siegeState({ provinceId: "constantinople", besiegingArmyIds: ["gb"] })],
    });
    // An ordinary train would be held to SIEGE.t5MasonryCapPerRound, but the presence
    // of the emplaced Bombard lifts the cap for the whole train → real wall damage.
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.wallHpRemaining).toBeLessThan(16 - SIEGE.t5MasonryCapPerRound);
  });
});

// ---------------------------------------------------------------------------
// §8.4 delta 3 — 1-round EMPLACEMENT: a freshly placed/relocated Great Bombard
// cannot FIRE (bombard walls) until the round AFTER it entered play. The arrival
// clock is GameState.greatBombard.emplacedRound; it may bombard only once
// state.round >= emplacedRound + GREAT_BOMBARD.emplacementRounds.
// ---------------------------------------------------------------------------

describe("Great Bombard 1-round emplacement (§8.4, delta 3)", () => {
  /** A siege state where the ONLY besieger is the emplacing Great Bombard. */
  const emplacingState = (round: number, emplacedRound: number): GameState => {
    return makeState({
      round,
      turn: round,
      players: [player("p1", Faction.OTTOMAN), player("p2", Faction.BYZANTIUM)],
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 3, hp: 10 },
          garrison: 1,
        }),
      ],
      armies: [bombardArmy("gb", "p1", "keep")],
      // The singleton tracker carries the arrival clock the gate reads.
      greatBombard: { inPlay: true, ownerId: "p1", provinceId: "keep", emplacedRound },
      // grainStores high so nothing changes via starvation; walls only move if it fires.
      siegeStates: [siegeState({ besiegingArmyIds: ["gb"], grainStores: 99 })],
    });
  };

  it("does NOT bombard the round it arrives (round === emplacedRound): walls untouched, no dice rolled", () => {
    const state = emplacingState(3, 3); // arrived this very round
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    // Emplacing this round → the gun cannot fire → the walls are untouched…
    expect(res.wallHpRemaining).toBe(10);
    // …and (no generic guns, no assault troops, no starvation) NO dice were rolled.
    expect(res.state.rngCursor).toBe(0);
    expect(res.captured).toBe(false);
  });

  it("DOES bombard the following round (round > emplacedRound): enhanced two-die fire", () => {
    const state = emplacingState(4, 3); // arrived last round → emplaced now
    // Emplaced → the Bombard fires its GREAT_BOMBARD.bombardDice dice (first draws).
    const predict = makeRng(SEED, 0);
    let expected = 0;
    for (const r of predict.rollDice(GREAT_BOMBARD.bombardDice)) expected += SIEGE.bombardDamage[r];
    expected = Math.min(expected, GREAT_BOMBARD.maxWallDamagePerRound);
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.wallHpRemaining).toBe(10 - expected);
    expect(res.state.rngCursor).toBeGreaterThan(0);
  });

  it("is deterministic across the emplacement gate", () => {
    const a = emplacingState(4, 3);
    const b = emplacingState(4, 3);
    const r1 = resolveSiege(a, a.siegeStates[0], makeRng(SEED, 0));
    const r2 = resolveSiege(b, b.siegeStates[0], makeRng(SEED, 0));
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// §7.2 step 1 + §8.4 assault row (RAW canon, balance §2 @ac39705): in a siege
// ASSAULT the storming TROOPS fight at field odds (wall bonus + escalade while the
// wall stands, field odds at breach) with NO flat +3; the besieger's SIEGE engines
// and an emplaced Great Bombard roll their OWN dice at the +3-vs-walls threshold
// (SIEGE CV 0 + 3 → hit on 4+) that ADD to the attacker's hits, in EVERY assault
// round INCLUDING at a breach (HP=0). Replaces the old flat siegeAssaultBonus model.
// ---------------------------------------------------------------------------

describe("siege-assault engine dice (§7.2/§8.4, RAW canon)", () => {
  /** A breached-wall assault: INFANTRY storm + `siegeCount` engines vs a 14-INF garrison-army. */
  const breachAssault = (siegeCount: number): GameState =>
    makeState({
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.PLAINS,
          walls: { tier: 0, hp: 0 }, // breached → troops fight at field odds
          garrison: 0,
        }),
      ],
      armies: [
        army("a1", "p1", "keep", { [UnitType.INFANTRY]: 6, [UnitType.SIEGE]: siegeCount }),
        army("d1", "p2", "keep", { [UnitType.INFANTRY]: 14 }),
      ],
      siegeStates: [siegeState({ besiegingArmyIds: ["a1"], breached: true })],
    });
  const defendersLeft = (s: GameState): number =>
    s.armies
      .filter((a) => a.ownerId === "p2")
      .reduce((n, a) => n + Object.values(a.units).reduce((x, y) => x + y, 0), 0);

  it("SIEGE engines fight at a BREACH (HP=0): they roll and score engine-attributable hits (§7.2 step 1)", () => {
    // Identical breached assault, engines present vs removed. The storming INFANTRY
    // are the same in both runs; the ONLY combat difference is the engine dice.
    const withEngines = breachAssault(20);
    const noEngines = breachAssault(0);
    const wRes = resolveSiege(withEngines, withEngines.siegeStates[0], makeRng(SEED, 0));
    const nRes = resolveSiege(noEngines, noEngines.siegeStates[0], makeRng(SEED, 0));
    // With 20 engines rolling on 4+ at the breach, the storm carries the city and
    // wipes the garrison; the identical INFANTRY-only storm cannot.
    expect(nRes.captured).toBe(false);
    expect(wRes.captured).toBe(true);
    // Engine-attributable casualties: the defenders lose strictly more with engines.
    expect(defendersLeft(wRes.state)).toBeLessThan(defendersLeft(nRes.state));
  });

  it("an emplaced Great Bombard adds EXACTLY one assault die at the 4+ threshold, breach included (§8.4)", () => {
    // A breached wall so troops fight at field odds; the Bombard's contribution is a
    // single assault die (GREAT_BOMBARD_ASSAULT_DICE = 1), NOT its bombardDice (2).
    const forceState = (a1: Army, gb?: GameState["greatBombard"]): GameState =>
      makeState({
        provinces: [
          province("keep", { ownerId: "p2", terrain: TerrainType.PLAINS, walls: { tier: 0, hp: 0 }, garrison: 0 }),
        ],
        armies: [a1, army("d1", "p2", "keep", { [UnitType.INFANTRY]: 14 })],
        siegeStates: [siegeState({ besiegingArmyIds: ["a1"], breached: true })],
        ...(gb ? { greatBombard: gb } : {}),
      });
    const infOnly = army("a1", "p1", "keep", { [UnitType.INFANTRY]: 6 });
    const infPlusBombard = (): Army => ({
      ...army("a1", "p1", "keep", { [UnitType.INFANTRY]: 6 }),
      variants: [{ base: UnitType.SIEGE, variant: GREAT_BOMBARD.variant, count: 1 }],
    });
    const infPlus2Guns = army("a1", "p1", "keep", { [UnitType.INFANTRY]: 6, [UnitType.SIEGE]: 2 });
    const emplaced: GameState["greatBombard"] = {
      inPlay: true, ownerId: "p1", provinceId: "keep", emplacedRound: 2, // < round 3 → emplaced
    };
    const notEmplaced: GameState["greatBombard"] = {
      inPlay: true, ownerId: "p1", provinceId: "keep", emplacedRound: 3, // == round 3 → still emplacing
    };
    const dLeft = (st: GameState): number => {
      const res = resolveSiege(st, st.siegeStates[0], makeRng(SEED, 0));
      return res.state.armies
        .filter((a) => a.ownerId === "p2")
        .reduce((n, a) => n + Object.values(a.units).reduce((x, y) => x + y, 0), 0);
    };
    const baseline = dLeft(forceState(infOnly)); // 0 engine dice
    const bombard = dLeft(forceState(infPlusBombard(), emplaced)); // +1 assault die
    const bombardCold = dLeft(forceState(infPlusBombard(), notEmplaced)); // still emplacing → +0
    const twoGuns = dLeft(forceState(infPlus2Guns)); // +2 assault dice
    // The emplaced Bombard's single 4+ assault die scores one extra casualty vs the
    // INFANTRY-only baseline (proves it fights at the breach)…
    expect(bombard).toBe(baseline - 1);
    // …a not-yet-emplaced Bombard contributes nothing (identical to the baseline)…
    expect(bombardCold).toBe(baseline);
    // …and its assault contribution is ONE die, strictly fewer than two generic guns
    // — it does NOT roll its wall-battering bombardDice (2) as assault dice.
    //   (bombard shares the two guns' identical bombardment RNG, so this is isolated.)
    expect(twoGuns).toBeLessThan(bombard);
  });

  it("a WALLS-STANDING assault gives the storming troops FIELD odds (wall bonus + escalade), with NO flat +3", () => {
    // A troops-only siege assault on a standing wall must resolve the storming
    // troops on EXACTLY the same odds as a field assault of the same troops on the
    // same standing wall (both apply the wall's defBonus to the garrison and the
    // escalade −1 to the attacker; NEITHER grants a +3). Byte-for-byte identical
    // combat exchange (same rng cursor, same survivors) pins the "no flat +3" model.
    const standingWall = (): Province =>
      province("keep", {
        ownerId: "p2",
        terrain: TerrainType.CITY,
        walls: { tier: 3, hp: 6 }, // standing → wall +3 to the garrison, escalade −1 to the storm
        garrison: 10,
      });
    // Siege assault (troops only → no engine dice, no bombardment RNG).
    const sState = makeState({
      provinces: [standingWall()],
      armies: [army("a1", "p1", "keep", { [UnitType.INFANTRY]: 9 })],
      siegeStates: [siegeState({ besiegingArmyIds: ["a1"], grainStores: 99 })],
    });
    const sRes = resolveSiege(sState, sState.siegeStates[0], makeRng(SEED, 0));
    // Field assault: same troops, same standing wall, garrison stands in as INFANTRY.
    const fState = makeState({
      provinces: [standingWall()],
      armies: [army("a1", "p1", "keep", { [UnitType.INFANTRY]: 9 })],
    });
    const fBattle: PendingBattle = {
      id: "fb", provinceId: "keep", attackerId: "p1", defenderId: "p2",
      attackerStackIds: ["a1"], defenderStackIds: [],
    };
    const fRes = resolveBattle(fState, fBattle, makeRng(SEED, 0));
    const atkLeft = (s: GameState): number =>
      s.armies.filter((a) => a.ownerId === "p1").reduce((n, a) => n + Object.values(a.units).reduce((x, y) => x + y, 0), 0);
    // Identical exchange → the storming troops enjoyed NO siege-only +3.
    expect(sRes.state.rngCursor).toBe(fRes.state.rngCursor);
    expect(atkLeft(sRes.state)).toBe(atkLeft(fRes.state));
    expect(sRes.state.provinces[0].garrison ?? 0).toBe(fRes.state.provinces[0].garrison ?? 0);
  });

  it("is deterministic through the engine-dice path: same state + seed → identical SiegeResult", () => {
    const build = (): GameState =>
      makeState({
        provinces: [province("keep", { ownerId: "p2", terrain: TerrainType.CITY, walls: { tier: 3, hp: 4 }, garrison: 8 })],
        armies: [army("a1", "p1", "keep", { [UnitType.INFANTRY]: 8, [UnitType.ARCHER]: 2, [UnitType.SIEGE]: 4 })],
        siegeStates: [siegeState({ besiegingArmyIds: ["a1"] })],
      });
    const s1 = build();
    const s2 = build();
    const r1 = resolveSiege(s1, s1.siegeStates[0], makeRng(SEED, 0));
    const r2 = resolveSiege(s2, s2.siegeStates[0], makeRng(SEED, 0));
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// §8.4 delta 3 — CAPTURE-PASSES-INTACT: the Great Bombard is never destroyed by
// battle. When the escort stack carrying it is DEFEATED/destroyed, the gun passes
// INTACT to the victor (transferred onto the winner's stack + the singleton
// GameState.greatBombard re-homed to the new owner/province and re-emplaced).
// ---------------------------------------------------------------------------

describe("Great Bombard capture-passes-intact (§8.4, delta 3)", () => {
  it("a defeated GB-carrying field stack passes the gun INTACT to the victor", () => {
    // p2's ONLY stack is the Great Bombard (base SIEGE → rolls no field dice), so an
    // overwhelming p1 assault wipes the escort. The gun must NOT be destroyed — it is
    // captured by p1.
    const state = makeState({
      provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
      armies: [
        army("a1", "p1", "field", { [UnitType.INFANTRY]: 20 }),
        bombardArmy("d1", "p2", "field"),
      ],
      greatBombard: { inPlay: true, ownerId: "p2", provinceId: "field", emplacedRound: 1 },
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
    // The loser's GB stack is gone…
    expect(res.state.armies.find((a) => a.id === "d1")).toBeUndefined();
    // …but the gun survives on the victor's stack (elite loot, not scrap).
    const winnerArmy = res.state.armies.find((a) => a.id === "a1");
    const gbVariant = winnerArmy?.variants?.find((v) => v.variant === GREAT_BOMBARD.variant);
    expect(gbVariant?.count).toBe(1);
    // The singleton tracker is re-homed to the victor + province, and re-emplaced
    // this round (a captured gun must sit a fresh emplacement round before firing).
    expect(res.state.greatBombard?.ownerId).toBe("p1");
    expect(res.state.greatBombard?.provinceId).toBe("field");
    expect(res.state.greatBombard?.emplacedRound).toBe(state.round);
    expect(res.state.greatBombard?.inPlay).toBe(true);
    // Exactly ONE Great Bombard remains in play (onePerGame) — only on the winner.
    const totalGb = res.state.armies.reduce(
      (n, a) => n + (a.variants?.find((v) => v.variant === GREAT_BOMBARD.variant)?.count ?? 0),
      0,
    );
    expect(totalGb).toBe(1);
    // Purity: the caller's input tracker is untouched.
    expect(state.greatBombard?.ownerId).toBe("p2");
  });

  it("a GB stack that RETREATS intact keeps its gun (not a capture)", () => {
    // Defender routs WITH a retreat available (an owned adjacent province), so its
    // stack survives and keeps the gun — the victor does NOT capture it.
    const p1 = { ...player("p1", Faction.OTTOMAN) };
    const p2 = { ...player("p2", Faction.BYZANTIUM) };
    const gbArmy = bombardArmy("d1", "p2", "field");
    gbArmy.units[UnitType.LEVY] = 4; // some line troops so the stack can rout-and-retreat
    const state = makeState({
      players: [p1, p2],
      provinces: [
        province("field", { ownerId: "p2", terrain: TerrainType.PLAINS }),
        province("haven", { ownerId: "p2", terrain: TerrainType.PLAINS }), // retreat target
      ],
      armies: [army("a1", "p1", "field", { [UnitType.CAVALRY]: 30 }), gbArmy],
      greatBombard: { inPlay: true, ownerId: "p2", provinceId: "field", emplacedRound: 1 },
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
    const survivor = res.state.armies.find((a) => a.id === "d1");
    if (survivor) {
      // If the defender survived (retreated), it still owns the gun; the tracker
      // must NOT have flipped to p1.
      const stillHasGb = survivor.variants?.some((v) => v.variant === GREAT_BOMBARD.variant);
      expect(stillHasGb).toBe(true);
      expect(res.state.greatBombard?.ownerId).toBe("p2");
    } else {
      // If it was destroyed instead, capture-passes-intact must have handed the gun
      // to p1 (never destroyed it).
      expect(res.state.greatBombard?.ownerId).toBe("p1");
    }
  });
});

// ---------------------------------------------------------------------------
// CANON sea-resupply (GD §8.2)
// ---------------------------------------------------------------------------

describe("sea-resupply siege rule (GD §8.2, CANON — FRESH fleet presence, Stage B)", () => {
  // constantinople is coastal and adjacent to "sea-of-marmara" in the canonical
  // map. Stage-B marshal fix: enemy control of the lane is computed from the war
  // fleets ACTUALLY PRESENT in the zone at resolution time, never from the stale
  // `SeaZone.blockadedBy` bookkeeping field.
  const runSiege = (
    opts: { staleBlockade?: string | null; fleets?: Fleet[] },
    rounds: number,
  ): number => {
    let state = makeState({
      provinces: [
        province("constantinople", {
          ownerId: "p2",
          port: true,
          walls: { tier: 0, hp: 0 },
          garrison: 5,
        }),
      ],
      // SIEGE-only besieger: no assault troops, so the garrison can only starve.
      armies: [army("s1", "p1", "constantinople", { [UnitType.SIEGE]: 30 })],
      fleets: opts.fleets ?? [],
      seaZones: [
        {
          id: "sea-of-marmara",
          name: "sea-of-marmara",
          position: { x: 0, y: 0 },
          blockadedBy: opts.staleBlockade ?? null,
        },
      ],
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
    // no war fleet anywhere near → open lane → garrison never starves.
    expect(runSiege({}, SIEGE.baseHoldoutRounds + 3)).toBe(5);
  });

  it("an enemy war fleet PRESENT in the only adjacent sea starves the port — even with blockadedBy stale-null", () => {
    // The freshness delta: the bookkeeping field says NOTHING (blockadedBy null),
    // but a real enemy war fleet sits in the lane → the port hungers.
    const enemyFleet = fleet("bf", "p1", "sea-of-marmara", { [UnitType.WARSHIP]: 2 });
    expect(
      runSiege({ staleBlockade: null, fleets: [enemyFleet] }, SIEGE.baseHoldoutRounds + 1),
    ).toBeLessThan(5);
  });

  it("a PHANTOM stale blockade (blockadedBy set, no fleet present) no longer starves the port", () => {
    // Marshal major: the old reader keyed off blockadedBy and would starve this
    // port. The fleet that set the flag has sailed away → the lane is open.
    expect(runSiege({ staleBlockade: "p1", fleets: [] }, SIEGE.baseHoldoutRounds + 3)).toBe(5);
  });

  it("an enemy fleet CONTESTED by a defender war fleet leaves the lane open (§5.3 uncontested rule)", () => {
    const fleets = [
      fleet("bf", "p1", "sea-of-marmara", { [UnitType.WARSHIP]: 2 }),
      fleet("hf", "p2", "sea-of-marmara", { [UnitType.GALLEY]: 1 }),
    ];
    expect(runSiege({ fleets }, SIEGE.baseHoldoutRounds + 3)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// CANON clarification §8.2.3 (coordinator): sea-resupply SUSPENDS starvation ONLY.
// While a besieged coastal city is sea-resupplied (open lane → not starving) the
// besieger may still CONTEST the blockade and the defender may still receive HARBOR
// REINFORCEMENT via an ordinary naval battle in the adjacent sea. The resupply must
// gate ONLY the starvation branch — it must NOT freeze the naval contest path.
// ---------------------------------------------------------------------------

describe("sea-resupply does not freeze naval/harbor action (§8.2.3, CANON)", () => {
  const marmara = (blockadedBy: string | null): SeaZone => ({
    id: "sea-of-marmara",
    name: "sea-of-marmara",
    position: { x: 0, y: 0 },
    blockadedBy,
  });

  const besiegedPort = (
    seaOwner: string | null,
    grainStores: number,
    fleets?: Fleet[],
  ): GameState =>
    makeState({
      provinces: [
        province("constantinople", {
          ownerId: "p2",
          port: true,
          walls: { tier: 0, hp: 0 },
          garrison: 5,
        }),
      ],
      // SIEGE-only land besieger (0 assault troops → the garrison can only starve),
      // plus a war fleet each so the sea lane can actually be contested.
      armies: [army("s1", "p1", "constantinople", { [UnitType.SIEGE]: 30 })],
      fleets: fleets ?? [
        fleet("f1", "p1", "sea-of-marmara", { [UnitType.WARSHIP]: 6 }), // besieger's fleet
        fleet("f2", "p2", "sea-of-marmara", { [UnitType.GALLEY]: 1 }), // defender's harbor fleet
      ],
      seaZones: [marmara(seaOwner)],
      siegeStates: [siegeState({ provinceId: "constantinople", grainStores })],
    });

  it("a sea-resupplied siege still permits a naval contest that flips the blockade", () => {
    // Open lane (blockadedBy null) → the port is resupplied and does NOT starve…
    let state = besiegedPort(null, SIEGE.baseHoldoutRounds);
    const siegeRes = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
    expect(siegeRes.state.provinces[0].garrison).toBe(5); // fed: resupply gated starvation
    state = siegeRes.state;

    // …yet the besieger may still CONTEST the lane: the naval battle is NOT frozen by
    // the active resupply and resolves normally, flipping control of the sea zone.
    const navalBattle: PendingBattle = {
      id: "n1",
      seaZoneId: "sea-of-marmara",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["f1"],
      defenderStackIds: ["f2"],
      isNaval: true,
    };
    const navalRes = resolveNaval(state, navalBattle, makeRng(SEED, state.rngCursor));
    expect(navalRes.winnerId).toBe("p1"); // contest happened and was decided
    expect(navalRes.state.seaZones[0].blockadedBy).toBe("p1"); // lane now closed by the besieger
  });

  it("once the contest closes the only lane, the port starves next round (resupply gated starvation only)", () => {
    // The defender's harbor fleet was destroyed in the contest: only the
    // besieger's war fleet remains PHYSICALLY in the lane (fresh Stage-B rule —
    // the blockadedBy field mirrors it but is no longer what is read) and stores
    // are empty → the port now hungers exactly like an inland city, proving the
    // resupply gate governs ONLY starvation and the naval closure took effect.
    const state = besiegedPort("p1", 0, [
      fleet("f1", "p1", "sea-of-marmara", { [UnitType.WARSHIP]: 6 }), // victor holds the lane
    ]);
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
    expect(res.state.provinces[0].garrison).toBeLessThan(5);
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

// ---------------------------------------------------------------------------
// §8.2 step 1 siege investment (FL-12): declaring a siege CREATES the SiegeState
// seeded with grainStores (base, +Granary), so store-driven starvation has a
// starting value. This is the sole construction point of a SiegeState.
// ---------------------------------------------------------------------------

describe("siege investment seeds grainStores (§8.2 step 1, FL-12)", () => {
  const investBattle: PendingBattle = {
    id: "b1",
    provinceId: "keep",
    attackerId: "p1",
    defenderId: "p2",
    attackerStackIds: ["s1"],
    defenderStackIds: [],
    isSiege: true,
  };

  it("a declared siege on a standing-walled city creates a SiegeState seeded with baseHoldoutRounds (no dice)", () => {
    const state = makeState({
      provinces: [
        province("keep", { ownerId: "p2", terrain: TerrainType.CITY, walls: { tier: 1, hp: 3 }, garrison: 2 }),
      ],
      armies: [army("s1", "p1", "keep", { [UnitType.INFANTRY]: 6, [UnitType.SIEGE]: 2 })],
    });
    const res = resolveBattle(state, investBattle, makeRng(SEED, 0));
    // Investment is not an assault: no capture, no dice consumed.
    expect(res.winnerId).toBeNull();
    expect(res.rounds).toBe(0);
    expect(res.state.rngCursor).toBe(0);
    expect(res.state.provinces[0].ownerId).toBe("p2"); // still the defender's
    // The SiegeState now exists, seeded with the default hold-out.
    expect(res.state.siegeStates).toHaveLength(1);
    const live = res.state.siegeStates[0];
    expect(live.provinceId).toBe("keep");
    expect(live.besiegerId).toBe("p1");
    expect(live.besiegingArmyIds).toEqual(["s1"]);
    expect(live.grainStores).toBe(SIEGE.baseHoldoutRounds);
    expect(live.circumvallated).toBe(true);
    expect(live.breached).toBe(false);
    // Mirrored onto the province for the combat subsystem.
    expect(res.state.provinces[0].siege?.grainStores).toBe(SIEGE.baseHoldoutRounds);
    // Purity: the caller's input is untouched.
    expect(state.siegeStates).toHaveLength(0);
  });

  it("a Granary folds +granaryBonusRounds into the INITIAL grainStores", () => {
    const state = makeState({
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 1, hp: 3 },
          garrison: 2,
          buildings: [BuildingType.GRANARY],
        }),
      ],
      armies: [army("s1", "p1", "keep", { [UnitType.INFANTRY]: 6 })],
    });
    const res = resolveBattle(state, investBattle, makeRng(SEED, 0));
    expect(res.state.siegeStates[0].grainStores).toBe(
      SIEGE.baseHoldoutRounds + SIEGE.granaryBonusRounds,
    );
  });

  it("is deterministic: investing the same siege twice → identical result", () => {
    const build = (): GameState =>
      makeState({
        provinces: [
          province("keep", { ownerId: "p2", terrain: TerrainType.CITY, walls: { tier: 1, hp: 3 }, garrison: 2 }),
        ],
        armies: [army("s1", "p1", "keep", { [UnitType.INFANTRY]: 6 })],
      });
    const r1 = resolveBattle(build(), investBattle, makeRng(SEED, 0));
    const r2 = resolveBattle(build(), investBattle, makeRng(SEED, 0));
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// §13.1 / FACTIONS Ottoman #3 "Ghazi Empire" (FL-07): sacking an enemy
// high-value city increments the capturer's sackedHighValueCities + logs sacked.
// ---------------------------------------------------------------------------

describe("high-value city sack counter (§13.1 / FACTIONS Ottoman #3, FL-07)", () => {
  it("a won FIELD battle that captures an enemy high-value city increments sackedHighValueCities and logs data.sacked", () => {
    const state = makeState({
      provinces: [
        province("nicaea", { ownerId: "p2", terrain: TerrainType.PLAINS, highValue: 3 }),
      ],
      armies: [
        army("a1", "p1", "nicaea", { [UnitType.INFANTRY]: 20 }),
        army("d1", "p2", "nicaea", { [UnitType.LEVY]: 1 }),
      ],
    });
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "nicaea",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
    };
    const res = resolveBattle(state, battle, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1");
    expect(res.state.provinces[0].ownerId).toBe("p1");
    // The Ghazi counter ticks on the capturing player only.
    expect(res.state.players.find((p) => p.id === "p1")?.sackedHighValueCities).toBe(1);
    expect(res.state.players.find((p) => p.id === "p2")?.sackedHighValueCities ?? 0).toBe(0);
    // The capture log entry flags the sack.
    const capLog = res.state.log.find((l) => l.type === "battle" && l.data?.sacked === true);
    expect(capLog).toBeDefined();
  });

  it("a siege STORM that captures an enemy high-value city increments the counter and logs data.sacked", () => {
    const state = makeState({
      provinces: [
        province("nicaea", {
          ownerId: "p2",
          terrain: TerrainType.PLAINS,
          walls: { tier: 0, hp: 0 }, // breached → field-odds assault captures
          garrison: 1,
          highValue: 4,
        }),
      ],
      armies: [army("s1", "p1", "nicaea", { [UnitType.INFANTRY]: 20 })],
      siegeStates: [siegeState({ provinceId: "nicaea" })],
    });
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(true);
    expect(res.state.players.find((p) => p.id === "p1")?.sackedHighValueCities).toBe(1);
    const capLog = res.state.log.find((l) => l.type === "siege" && l.data?.sacked === true);
    expect(capLog).toBeDefined();
  });

  it("capturing an ordinary (non-high-value) city does NOT increment the sack counter", () => {
    const state = makeState({
      provinces: [
        province("plain", { ownerId: "p2", terrain: TerrainType.PLAINS }), // no highValue
      ],
      armies: [
        army("a1", "p1", "plain", { [UnitType.INFANTRY]: 20 }),
        army("d1", "p2", "plain", { [UnitType.LEVY]: 1 }),
      ],
    });
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "plain",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
    };
    const res = resolveBattle(state, battle, makeRng(SEED, 0));
    expect(res.state.provinces[0].ownerId).toBe("p1");
    expect(res.state.players.find((p) => p.id === "p1")?.sackedHighValueCities ?? 0).toBe(0);
    const capLog = res.state.log.find((l) => l.type === "battle" && l.data?.sacked === true);
    expect(capLog).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Coordinator ratification (§8.2 / §13.1 / FACTIONS Ottoman #3): a city is
// SACKED (Province.sacked=true, +sackedHighValueCities if high-value) ONLY when
// captured by ASSAULT — a breach/escalade storm or a field-assault that carries
// the city. A starvation-SURRENDER transfers ownership WITHOUT sacking or ticking
// the counter. Reconciles FL-07, which incremented the counter on ANY capture.
// ---------------------------------------------------------------------------

describe("sack only on ASSAULT capture (§8.2 / §13.1 ratification)", () => {
  it("an ASSAULT storm of Constantinople sets province.sacked and increments sackedHighValueCities", () => {
    const state = makeState({
      provinces: [
        province("constantinople", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          // Theodosian wall breached (HP=0) → the storm resolves on field odds.
          walls: { tier: 5, hp: 0 },
          garrison: 1,
          highValue: 5,
        }),
      ],
      armies: [army("s1", "p1", "constantinople", { [UnitType.INFANTRY]: 20 })],
      siegeStates: [siegeState({ provinceId: "constantinople" })],
    });
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(true);
    // ASSAULT capture → the city is SACKED.
    expect(res.state.provinces[0].sacked).toBe(true);
    expect(res.state.provinces[0].ownerId).toBe("p1");
    // a high-value sack ticks the capturer's Ghazi Empire counter.
    expect(res.state.players.find((p) => p.id === "p1")?.sackedHighValueCities).toBe(1);
    expect(res.state.players.find((p) => p.id === "p2")?.sackedHighValueCities ?? 0).toBe(0);
    // the storm log flags the sack.
    const capLog = res.state.log.find((l) => l.type === "siege" && l.data?.sacked === true);
    expect(capLog).toBeDefined();
    // purity: the caller's input province is untouched.
    expect(state.provinces[0].sacked ?? false).toBe(false);
  });

  it("a won FIELD-assault that carries the city sets province.sacked", () => {
    const state = makeState({
      provinces: [
        province("constantinople", { ownerId: "p2", terrain: TerrainType.CITY, highValue: 5 }),
      ],
      armies: [
        army("a1", "p1", "constantinople", { [UnitType.INFANTRY]: 20 }),
        army("d1", "p2", "constantinople", { [UnitType.LEVY]: 1 }),
      ],
    });
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "constantinople",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
    };
    const res = resolveBattle(state, battle, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1");
    expect(res.state.provinces[0].sacked).toBe(true);
    expect(res.state.players.find((p) => p.id === "p1")?.sackedHighValueCities).toBe(1);
  });

  it("a STARVATION-surrender captures WITHOUT sacking or ticking the counter", () => {
    // SIEGE-only besieger (0 assault troops) + empty grain stores: the garrison can
    // only STARVE, so the city falls by surrender — never by storm.
    let state = makeState({
      provinces: [
        province("constantinople", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 0, hp: 0 },
          garrison: 1,
          highValue: 5, // even a HIGH-VALUE city must NOT tick on a surrender
        }),
      ],
      armies: [army("s1", "p1", "constantinople", { [UnitType.SIEGE]: 30 })],
      siegeStates: [siegeState({ provinceId: "constantinople", grainStores: 0 })],
    });
    let res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
    let guard = 0;
    while (!res.captured && guard < 10) {
      state = res.state;
      res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, state.rngCursor));
      guard += 1;
    }
    expect(res.captured).toBe(true);
    // SURRENDER → ownership flips but the city is NOT sacked.
    expect(res.state.provinces[0].ownerId).toBe("p1");
    expect(res.state.provinces[0].sacked ?? false).toBe(false);
    // the Ghazi Empire counter is NOT ticked by a starvation-surrender (FL-07 fix).
    expect(res.state.players.find((p) => p.id === "p1")?.sackedHighValueCities ?? 0).toBe(0);
    // and the capture log does NOT flag a sack.
    const capLog = res.state.log.find((l) => l.type === "siege" && l.data?.sacked === true);
    expect(capLog).toBeUndefined();
  });
});

// ===========================================================================
// STAGE B — §7.7 tactic CONSUMPTION (marshal-review combat cluster). Every test
// below asserts CONSUMPTION via dice-outcome / state DELTAS: the same seed is
// resolved with and without the card, and the card must CHANGE the dice or the
// state — never merely post a modifier. These suites route the combat hook to
// the REAL tactic resolver (useRealTactics), so the full chain
// card → playTactic → modifier → combat consumer is exercised end-to-end.
// ===========================================================================

// ---------------------------------------------------------------------------
// §7.7 "+N dice" cards are N actual EXTRA DICE, not a to-hit shift
// ---------------------------------------------------------------------------

describe("§7.7 '+N dice' consumption — extra dice, not a to-hit shift (marshal fix)", () => {
  // 4 CAVALRY on PLAINS: threshold = clamp(7−3(atk)−1(charge)−1(outnumber), 2, 6)
  // = 2 — ALREADY at the clamp floor. Under the old flat-+N model condottieri's
  // +2 could not change anything (threshold stays 2 and no extra draws happen).
  // Under the correct model the side rolls 2 actual EXTRA DICE from the stream.
  const build = (withCard: boolean): [GameState, PendingBattle] => {
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "field",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
      attackerTactics: withCard ? [asTacticCardId("condottieri-contract")] : [],
    };
    const p1 = player("p1", Faction.OTTOMAN);
    p1.treasury = { ...p1.treasury, gold: 2 }; // the card's printed 2-gold cost
    const state = makeState({
      players: [p1, player("p2", Faction.BYZANTIUM)],
      provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
      armies: [
        army("a1", "p1", "field", { [UnitType.CAVALRY]: 4 }),
        army("d1", "p2", "field", { [UnitType.LEVY]: 2 }),
      ],
      pendingBattles: [battle],
    });
    return [state, battle];
  };

  it("condottieri-contract (+2 dice) consumes exactly 2 extra draws and pays its cost", () => {
    useRealTactics();
    // Guard: the seed wipes both LEVY in round 1 in both runs (>=2 hits at 2+
    // among the attacker's 4 normal dice), so the battle is a single round and
    // the cursor delta is EXACTLY the extra dice.
    const predict = makeRng(SEED, 0);
    const normal = predict.rollDice(4);
    expect(normal.filter((r) => r >= 2).length).toBeGreaterThanOrEqual(2);

    const [sBase, bBase] = build(false);
    const base = resolveBattle(sBase, bBase, makeRng(SEED, 0));
    const [sCard, bCard] = build(true);
    const withCard = resolveBattle(sCard, bCard, makeRng(SEED, 0));

    // Both runs wipe the 2-LEVY defender in one round…
    expect(base.winnerId).toBe("p1");
    expect(withCard.winnerId).toBe("p1");
    expect(Object.values(base.defender.losses).reduce((a, b) => a + b, 0)).toBe(2);
    expect(Object.values(withCard.defender.losses).reduce((a, b) => a + b, 0)).toBe(2);
    // …but the card run drew EXACTLY 2 more dice from the same stream. A flat
    // +2 to-hit (the old model) would have left the cursor identical, because
    // the threshold was already clamped at 2.
    expect(withCard.state.rngCursor).toBe(base.state.rngCursor + 2);
    // The printed 2-gold cost was charged on play (§10.6).
    expect(withCard.state.players.find((p) => p.id === "p1")?.treasury.gold).toBe(0);
    // The card was consumed to the discard pile.
    expect(withCard.state.tacticDiscard).toContain(asTacticCardId("condottieri-contract"));
    // Dice delta is observable in state too: the defender's 2 dice shifted 2
    // stream positions, changing the attacker's casualties deterministically.
    const cavLeft = (s: GameState): number =>
      s.armies.find((a) => a.id === "a1")?.units[UnitType.CAVALRY] ?? 0;
    expect(cavLeft(base.state)).not.toBe(cavLeft(withCard.state));
  });
});

// ---------------------------------------------------------------------------
// §7.7 reroll cards actually REROLL (deterministically, from the same stream)
// ---------------------------------------------------------------------------

describe("§7.7 reroll consumption — the roll RESULT changes (marshal fix)", () => {
  it("the-white-knights-stroke rerolls the attacker's missed die and FLIPS the battle (seed 5)", () => {
    useRealTactics();
    // 1 INFANTRY (thr 5) vs 1 LEVY (thr 6). Hand-computed stream for seed 5:
    // draw1 misses, its REROLL hits, draw3 (the defender, shifted) misses — so
    // WITH the card the attacker wins in round 1 on the rerolled die. WITHOUT
    // it, draw2 becomes the defender's die and kills the attacker instead.
    const p = makeRng(5, 0);
    const first = p.rollD6();
    const reroll = p.rollD6();
    const defDie = p.rollD6();
    expect(first).toBeLessThan(5); // initial miss
    expect(reroll).toBeGreaterThanOrEqual(5); // the reroll hits
    expect(defDie).toBeLessThan(6); // shifted defender die misses

    const build = (withCard: boolean): [GameState, PendingBattle] => {
      const battle: PendingBattle = {
        id: "b1",
        provinceId: "field",
        attackerId: "p1",
        defenderId: "p2",
        attackerStackIds: ["a1"],
        defenderStackIds: ["d1"],
        attackerTactics: withCard ? [asTacticCardId("the-white-knights-stroke")] : [],
      };
      const state = makeState({
        provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
        armies: [
          army("a1", "p1", "field", { [UnitType.INFANTRY]: 1 }),
          army("d1", "p2", "field", { [UnitType.LEVY]: 1 }),
        ],
        pendingBattles: [battle],
      });
      return [state, battle];
    };

    const [sCard, bCard] = build(true);
    const withCard = resolveBattle(sCard, bCard, makeRng(5, 0));
    expect(withCard.winnerId).toBe("p1"); // the reroll won the battle
    expect(withCard.rounds).toBe(1);
    expect(withCard.state.rngCursor).toBe(3); // die + reroll + defender die
    // one-round grant: CONSUMED on use (removed from activeModifiers).
    expect(
      withCard.state.activeModifiers.filter((m) => typeof m.data?.reroll === "string"),
    ).toHaveLength(0);
    expect(withCard.state.tacticDiscard).toContain(asTacticCardId("the-white-knights-stroke"));

    const [sBase, bBase] = build(false);
    const base = resolveBattle(sBase, bBase, makeRng(5, 0));
    expect(base.winnerId).toBe("p2"); // same seed, no card: the attacker dies
    expect(base.state.rngCursor).toBe(2);
  });

  it("locked-shields rerolls the defender's lowest die each melee step and persists (seed 1)", () => {
    useRealTactics();
    // Attacker 1 LEVY (thr 6) vs defender 1 INFANTRY (thr 4). Seed 1 stream:
    // a1 misses, d1 misses, the lowest-die REROLL hits → with the card the
    // defender kills the attacker in round 1; without it the fight takes a
    // second round (draws 3+4) before the defender lands the same kill.
    const p = makeRng(1, 0);
    const a1 = p.rollD6();
    const d1 = p.rollD6();
    const r = p.rollD6();
    expect(a1).toBeLessThan(6);
    expect(d1).toBeLessThan(4);
    expect(r).toBeGreaterThanOrEqual(4); // the reroll hits

    const build = (withCard: boolean): [GameState, PendingBattle] => {
      const battle: PendingBattle = {
        id: "b1",
        provinceId: "field",
        attackerId: "p1",
        defenderId: "p2",
        attackerStackIds: ["a1"],
        defenderStackIds: ["d1"],
        defenderTactics: withCard ? [asTacticCardId("locked-shields")] : [],
      };
      const state = makeState({
        provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
        armies: [
          army("a1", "p1", "field", { [UnitType.LEVY]: 1 }),
          army("d1", "p2", "field", { [UnitType.INFANTRY]: 1 }),
        ],
        pendingBattles: [battle],
      });
      return [state, battle];
    };

    const [sCard, bCard] = build(true);
    const withCard = resolveBattle(sCard, bCard, makeRng(1, 0));
    expect(withCard.winnerId).toBe("p2");
    expect(withCard.rounds).toBe(1); // the reroll ended it a round early
    expect(withCard.state.rngCursor).toBe(3);
    // "in EACH melee step": the grant persists for the battle (round-scoped —
    // it lapses at cleanup, not on first use).
    expect(
      withCard.state.activeModifiers.filter((m) => m.data?.reroll === "lowest"),
    ).toHaveLength(1);

    const [sBase, bBase] = build(false);
    const base = resolveBattle(sBase, bBase, makeRng(1, 0));
    expect(base.winnerId).toBe("p2");
    expect(base.rounds).toBe(2); // same kill, one round later
    expect(base.state.rngCursor).toBe(4);
  });

  it("ladders-and-fascines rerolls one assault die in a siege round and takes the wall (seed 44)", () => {
    // Siege-mode play (PLAY_TACTIC siegeProvinceId) posts this siege_mod; combat
    // must CONSUME it inside the declared assault. 1 INFANTRY storms a T1 wall
    // (thr 6 with escalade) vs a 1-strong garrison (thr 3 behind the wall).
    // Seed 44 stream: storm die misses, its REROLL hits (a 6), the garrison die
    // misses → the reroll captures the city; without it the same stream kills
    // the storming party instead.
    const p = makeRng(44, 0);
    const a1 = p.rollD6();
    const r = p.rollD6();
    const d = p.rollD6();
    expect(a1).toBeLessThan(6);
    expect(r).toBeGreaterThanOrEqual(6);
    expect(d).toBeLessThan(3);

    const build = (withMod: boolean): GameState =>
      makeState({
        provinces: [
          province("keep", {
            ownerId: "p2",
            terrain: TerrainType.CITY,
            walls: { tier: 1, hp: 3 },
            garrison: 1,
          }),
        ],
        armies: [army("a1", "p1", "keep", { [UnitType.INFANTRY]: 1 })],
        siegeStates: [siegeState({ besiegingArmyIds: ["a1"] })],
        activeModifiers: withMod
          ? [
              {
                id: "tac-ladders",
                scope: "round",
                kind: "siege_mod",
                target: { faction: Faction.OTTOMAN, provinceId: "keep" },
                value: 0,
                data: { reroll: "one", dice: 1, side: "attacker", tactic: "ladders-and-fascines" },
              },
            ]
          : [],
      });

    const withMod = resolveSiege(build(true), build(true).siegeStates[0], makeRng(44, 0));
    expect(withMod.captured).toBe(true); // the rerolled die carried the wall
    expect(withMod.state.provinces[0].ownerId).toBe("p1");
    expect(withMod.state.rngCursor).toBe(3); // storm die + reroll + garrison die
    // one-round grant: consumed.
    expect(
      withMod.state.activeModifiers.filter((m) => typeof m.data?.reroll === "string"),
    ).toHaveLength(0);

    const base = resolveSiege(build(false), build(false).siegeStates[0], makeRng(44, 0));
    expect(base.captured).toBe(false); // same stream, no reroll: the storm dies
    expect(base.state.provinces[0].ownerId).toBe("p2");
    expect(base.state.rngCursor).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §7.7 the-intercepted-letter — REACTION that cancels the rival's played card
// ---------------------------------------------------------------------------

describe("§7.7 intercepted-letter consumption — the rival's card has NO effect (marshal fix)", () => {
  // 12 INFANTRY (thr 4 with outnumber) vs 1 LEVY (thr 6): the battle ends in
  // round 1 on this seed, so cursor arithmetic isolates the card effects.
  const build = (
    attackerTactics: string[],
    defenderTactics: string[],
  ): [GameState, PendingBattle] => {
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "field",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
      attackerTactics: attackerTactics.map(asTacticCardId),
      defenderTactics: defenderTactics.map(asTacticCardId),
    };
    const state = makeState({
      provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
      armies: [
        army("a1", "p1", "field", { [UnitType.INFANTRY]: 12 }),
        army("d1", "p2", "field", { [UnitType.LEVY]: 1 }),
      ],
      pendingBattles: [battle],
    });
    return [state, battle];
  };

  it("the letter nullifies the opponent's +1-die card: dice identical to the no-card baseline", () => {
    useRealTactics();
    // Guard: >=1 hit among the attacker's 12 normal dice at 4+ (round-1 kill).
    const predict = makeRng(SEED, 0);
    expect(predict.rollDice(12).filter((r) => r >= 4).length).toBeGreaterThanOrEqual(1);

    const [s0, b0] = build([], []);
    const baseline = resolveBattle(s0, b0, makeRng(SEED, 0));
    const [s1, b1] = build(["veterans-of-the-border"], []);
    const withCard = resolveBattle(s1, b1, makeRng(SEED, 0));
    const [s2, b2] = build(["veterans-of-the-border"], ["the-intercepted-letter"]);
    const intercepted = resolveBattle(s2, b2, makeRng(SEED, 0));

    // Un-intercepted, the +1-die card consumes exactly one extra draw…
    expect(withCard.state.rngCursor).toBe(baseline.state.rngCursor + 1);
    // …but INTERCEPTED it has NO effect: the dice stream is byte-identical to
    // the no-card baseline (the extra die was never rolled).
    expect(intercepted.state.rngCursor).toBe(baseline.state.rngCursor);
    expect(intercepted.winnerId).toBe("p1");
    // No +N-dice modifier survives — the effect never registered.
    expect(
      intercepted.state.activeModifiers.filter((m) => m.data?.dice === true),
    ).toHaveLength(0);
    // §7.7 "both cards are discarded": the cancelled card AND the letter.
    expect(intercepted.state.tacticDiscard).toContain(asTacticCardId("veterans-of-the-border"));
    expect(intercepted.state.tacticDiscard).toContain(asTacticCardId("the-intercepted-letter"));
    // The live battle queues were emptied (nothing left to leak).
    expect(intercepted.state.pendingBattles[0].attackerTactics).toHaveLength(0);
    expect(intercepted.state.pendingBattles[0].defenderTactics).toHaveLength(0);
  });

  it("a letter with nothing to intercept stays queued (reaction, never played proactively)", () => {
    useRealTactics();
    const [s, b] = build(["the-intercepted-letter"], []);
    const res = resolveBattle(s, b, makeRng(SEED, 0));
    // The reaction never fired: still queued on the live battle, not discarded.
    expect(res.state.pendingBattles[0].attackerTactics).toContain(
      asTacticCardId("the-intercepted-letter"),
    );
    expect(res.state.tacticDiscard ?? []).not.toContain(asTacticCardId("the-intercepted-letter"));
    // And the battle itself resolved exactly like the baseline.
    expect(res.state.rngCursor).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// §7.7 greek-fire — naval AUTO-WIN, card removed from game
// ---------------------------------------------------------------------------

describe("§7.7 greek-fire consumption — instant naval win (marshal fix)", () => {
  const build = (withCard: boolean): [GameState, PendingBattle] => {
    const battle: PendingBattle = {
      id: "n1",
      seaZoneId: "aegean",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["f1"],
      defenderStackIds: ["f2"],
      isNaval: true,
      attackerTactics: withCard ? [asTacticCardId("greek-fire")] : [],
    };
    const p1 = player("p1", Faction.OTTOMAN);
    // §7.7: "then discard one OTHER tactic card from your hand".
    p1.tacticHand = [asTacticCardId("the-counting-house")];
    const state = makeState({
      players: [p1, player("p2", Faction.BYZANTIUM)],
      seaZones: [seaZone("aegean")],
      fleets: [
        fleet("f1", "p1", "aegean", { [UnitType.WARSHIP]: 1 }), // hopeless without the card
        fleet("f2", "p2", "aegean", { [UnitType.WARSHIP]: 6 }),
      ],
      pendingBattles: [battle],
    });
    return [state, battle];
  };

  it("a hopeless 1-v-6 fleet WINS OUTRIGHT with greek-fire: no dice, enemy destroyed, card removed", () => {
    useRealTactics();
    const [sCard, bCard] = build(true);
    const res = resolveNaval(sCard, bCard, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1"); // the outnumbered side wins outright
    expect(res.state.rngCursor).toBe(0); // "before dice" — no draw at all
    // All enemy naval units in the zone are destroyed.
    expect(res.state.fleets.find((f) => f.id === "f2")).toBeUndefined();
    expect(res.state.fleets.find((f) => f.id === "f1")).toBeDefined();
    // Winner controls the zone (§7.6).
    expect(res.state.seaZones[0].blockadedBy).toBe("p1");
    // The card is REMOVED FROM THE GAME; the forced extra discard hit the hand.
    expect(res.state.tacticRemoved).toContain(asTacticCardId("greek-fire"));
    expect(res.state.tacticDiscard).toContain(asTacticCardId("the-counting-house"));
    expect(res.state.players.find((p) => p.id === "p1")?.tacticHand).toHaveLength(0);
    // The auto-win grant was CONSUMED (no lingering modifier).
    expect(
      res.state.activeModifiers.filter((m) => m.data?.autoWinNaval === true),
    ).toHaveLength(0);
  });

  it("without the card the same seed resolves by normal dice and the 1-v-6 side loses", () => {
    const [sBase, bBase] = build(false);
    const res = resolveNaval(sBase, bBase, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p2");
    expect(res.state.rngCursor).toBeGreaterThan(0); // dice were actually rolled
    expect(res.state.seaZones[0].blockadedBy).toBe("p2");
    expect(res.state.fleets.find((f) => f.id === "f1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §7.7 feigned-retreat — withdraw before dice; battle ends; NO pursuit
// ---------------------------------------------------------------------------

describe("§7.7 feigned-retreat consumption — withdrawal before dice (marshal fix)", () => {
  // philippopolis ↔ edirne are adjacent in the canonical map graph; edirne is
  // p2-owned, so the defender has a legal withdrawal destination.
  const build = (withCard: boolean): [GameState, PendingBattle] => {
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "philippopolis",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
      defenderTactics: withCard ? [asTacticCardId("feigned-retreat")] : [],
    };
    const state = makeState({
      provinces: [
        province("philippopolis", { ownerId: "p2", terrain: TerrainType.PLAINS }),
        province("edirne", { ownerId: "p2" }),
      ],
      armies: [
        // 8 CAVALRY: if this were a ROUT, pursuit would hit the fleeing stack.
        army("a1", "p1", "philippopolis", { [UnitType.CAVALRY]: 8 }),
        army("d1", "p2", "philippopolis", { [UnitType.INFANTRY]: 5 }),
      ],
      pendingBattles: [battle],
    });
    return [state, battle];
  };

  it("the whole stack withdraws intact (no dice, no pursuit), the battle ends, the attacker holds the field", () => {
    useRealTactics();
    const [s, b] = build(true);
    const res = resolveBattle(s, b, makeRng(SEED, 0));
    // "Before dice" — the battle ended with ZERO draws.
    expect(res.state.rngCursor).toBe(0);
    expect(res.rounds).toBe(1);
    // The withdrawing stack relocated INTACT: all 5 units, no pursuit casualties
    // despite the attacker's 8 CAVALRY (a rout would have taken pursuit hits).
    const d1 = res.state.armies.find((a) => a.id === "d1");
    expect(d1?.locationId).toBe("edirne");
    expect(Object.values(d1!.units).reduce((x, y) => x + y, 0)).toBe(5);
    // Not a rout: the casualty report carries no routed stacks.
    expect(res.defender.routed).toHaveLength(0);
    // The attacker holds the ceded field…
    expect(res.winnerId).toBe("p1");
    expect(res.state.provinces.find((p) => p.id === "philippopolis")?.ownerId).toBe("p1");
    // …but a cession is NOT won by arms: no sack, no conquest prestige.
    expect(res.state.provinces.find((p) => p.id === "philippopolis")?.sacked ?? false).toBe(false);
    expect(
      res.state.activeModifiers.filter((m) => m.kind === "prestige_pending"),
    ).toHaveLength(0);
    // The card resolved (discarded) and its retreat grant was CONSUMED.
    expect(res.state.tacticDiscard).toContain(asTacticCardId("feigned-retreat"));
    expect(
      res.state.activeModifiers.filter((m) => m.data?.retreat === true),
    ).toHaveLength(0);
  });

  it("without the card the same seed fights a real battle (dice are rolled)", () => {
    const [s, b] = build(false);
    const res = resolveBattle(s, b, makeRng(SEED, 0));
    expect(res.state.rngCursor).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §7.7 treason-at-the-gate — the besieged city FALLS when the grant is consumed
// ---------------------------------------------------------------------------

describe("§7.7 treason-at-the-gate consumption — autoCapture executes (marshal fix)", () => {
  // A gates-passing siege: round 9, siege laid round 6 (roundsElapsed 3 ⇒ started
  // at 9−3=6 ≥ TREASON_GATE.minGameRound), garrison 3 ≤ TREASON_GATE.maxGarrison.
  const build = (withMod: boolean): GameState =>
    makeState({
      round: 9,
      turn: 9,
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 2, hp: 6 },
          garrison: 3,
        }),
      ],
      armies: [
        army("a1", "p1", "keep", { [UnitType.INFANTRY]: 6 }),
        army("d1", "p2", "keep", { [UnitType.INFANTRY]: 2 }), // defender stack inside the walls
      ],
      siegeStates: [
        siegeState({
          besiegingArmyIds: ["a1"],
          roundsElapsed: 3,
          grainStores: 2,
          assaultDeclared: false,
        }),
      ],
      activeModifiers: withMod
        ? [
            {
              id: "tac-treason",
              scope: "round",
              kind: "siege_mod",
              target: { faction: Faction.OTTOMAN, provinceId: "keep" },
              data: { autoCapture: true, tactic: "treason-at-the-gate" },
            },
          ]
        : [],
    });

  it("gates passed + grant consumed → the city changes owner THIS round, without an assault", () => {
    const state = build(true);
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    // The city FELL — no assault was declared, no dice were rolled.
    expect(res.captured).toBe(true);
    expect(res.state.provinces[0].ownerId).toBe("p1");
    expect(res.state.rngCursor).toBe(0);
    // "its garrison surrenders (removed)": province garrison AND the defender
    // stack inside the walls are gone; the besieger survives.
    expect(res.state.provinces[0].garrison).toBe(0);
    expect(res.state.armies.find((a) => a.id === "d1")).toBeUndefined();
    expect(res.state.armies.find((a) => a.id === "a1")).toBeDefined();
    // "walls at their current HP": untouched.
    expect(res.state.provinces[0].walls.hp).toBe(6);
    expect(res.wallHpRemaining).toBe(6);
    // NOT a sack (the city fell without a storm).
    expect(res.state.provinces[0].sacked ?? false).toBe(false);
    // The grant was CONSUMED.
    expect(
      res.state.activeModifiers.filter((m) => m.data?.autoCapture === true),
    ).toHaveLength(0);
    // Taking a walled city by siege still posts the §13.1 conquest award.
    const city = res.state.activeModifiers.find(
      (m) => m.kind === "prestige_pending" && m.data?.reason === "take_walled_city",
    );
    expect(city?.value).toBe(CONQUEST_PRESTIGE.takeWalledCity);
    // The siege itself is over.
    expect(res.state.siegeStates).toHaveLength(0);
  });

  it("without the grant the same seed does NOT capture (bombard/starve only)", () => {
    const state = build(false);
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(false);
    expect(res.state.provinces[0].ownerId).toBe("p2");
    expect(res.state.armies.find((a) => a.id === "d1")).toBeDefined();
  });

  it("gates FAIL → the play itself is rejected (double brake, delta 1) and nothing is captured", () => {
    // Gate (a): garrison too large.
    const bigGarrison = makeState({
      round: 9,
      turn: 9,
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 2, hp: 6 },
          garrison: TREASON_GATE.maxGarrison + 1,
        }),
      ],
      armies: [army("a1", "p1", "keep", { [UnitType.INFANTRY]: 6 })],
      siegeStates: [siegeState({ besiegingArmyIds: ["a1"], roundsElapsed: 3 })],
    });
    const treason = asTacticCardId("treason-at-the-gate");
    const battleA: PendingBattle = {
      id: "b1",
      provinceId: "keep",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: [],
      attackerTactics: [treason],
    };
    const sA = { ...bigGarrison, pendingBattles: [battleA] };
    sA.players = sA.players.map((p) =>
      p.id === "p1" ? { ...p, treasury: { ...p.treasury, gold: 4 } } : p,
    );
    expect(() => realPlayTactic(sA, battleA, "attacker", treason, makeRng(1, 0))).toThrowError(
      /garrison/,
    );

    // Gate (b): the siege clock started before TREASON_GATE.minGameRound.
    const earlySiege = makeState({
      round: 5,
      turn: 5,
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 2, hp: 6 },
          garrison: 2,
        }),
      ],
      armies: [army("a1", "p1", "keep", { [UnitType.INFANTRY]: 6 })],
      // No declared assault: isolates "no capture without the treason grant".
      siegeStates: [
        siegeState({ besiegingArmyIds: ["a1"], roundsElapsed: 2, assaultDeclared: false }),
      ],
    });
    const sB = { ...earlySiege, pendingBattles: [battleA] };
    sB.players = sB.players.map((p) =>
      p.id === "p1" ? { ...p, treasury: { ...p.treasury, gold: 4 } } : p,
    );
    expect(() => realPlayTactic(sB, battleA, "attacker", treason, makeRng(1, 0))).toThrowError(
      /earliest permitted round/,
    );
    // And with no consumed grant, resolving the siege captures nothing.
    const res = resolveSiege(sB, sB.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(false);
    expect(res.state.provinces[0].ownerId).toBe("p2");
  });
});

// ---------------------------------------------------------------------------
// §8.2 step 4 — CHOSEN assault: no SIEGE_ASSAULT declaration → no storm
// ---------------------------------------------------------------------------

describe("chosen assault (§8.2 step 4, SIEGE_ASSAULT declaration)", () => {
  const build = (declared: boolean): GameState =>
    makeState({
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 3, hp: 10 },
          garrison: 12,
        }),
      ],
      // Troops-only besieger (no guns): an UNDECLARED round rolls ZERO dice.
      armies: [army("a1", "p1", "keep", { [UnitType.INFANTRY]: 2 })],
      siegeStates: [
        siegeState({ besiegingArmyIds: ["a1"], grainStores: 5, assaultDeclared: declared }),
      ],
    });

  it("an UNDECLARED siege round does bombardment + starvation only: walls/stores tick, NO storm casualties", () => {
    const state = build(false);
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(false);
    // No storm: zero dice were drawn, the garrison is untouched.
    expect(res.state.rngCursor).toBe(0);
    expect(res.state.provinces[0].garrison).toBe(12);
    // But the siege still progressed: a grain store depleted.
    expect(res.state.siegeStates[0].grainStores).toBe(4);
    expect(res.state.siegeStates[0].roundsElapsed).toBe(1);
    const log = res.state.log.find((l) => l.type === "siege");
    expect(log?.data?.assaultRounds).toBe(0);
  });

  it("a DECLARED assault resolves the storm — and the declaration is cleared after resolving", () => {
    const state = build(true);
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    // The storm was fought: dice were drawn and the garrison took casualties.
    expect(res.state.rngCursor).toBeGreaterThan(0);
    expect(res.state.provinces[0].garrison).toBeLessThan(12);
    expect(res.captured).toBe(false); // 2 INF cannot carry a T3 wall + 12 garrison
    const log = res.state.log.find((l) => l.type === "siege");
    expect((log?.data?.assaultRounds as number) ?? 0).toBeGreaterThanOrEqual(1);
    // CONSUMED: declarations never carry over.
    expect(res.state.siegeStates[0].assaultDeclared).toBe(false);
  });

  it("the with/without delta on the same seed is exactly the assault", () => {
    const undeclared = resolveSiege(build(false), build(false).siegeStates[0], makeRng(SEED, 0));
    const declared = resolveSiege(build(true), build(true).siegeStates[0], makeRng(SEED, 0));
    expect(undeclared.state.provinces[0].garrison).toBe(12);
    expect(declared.state.provinces[0].garrison).toBeLessThan(12);
    // Same non-assault bookkeeping either way.
    expect(undeclared.state.siegeStates[0].grainStores).toBe(
      declared.state.siegeStates[0].grainStores,
    );
  });
});

// ---------------------------------------------------------------------------
// §8.2 step 1 — SIEGE LOCK: only stacks physically in the province besiege
// ---------------------------------------------------------------------------

describe("siege lock (§8.2 step 1) — no remote besieging", () => {
  const build = (besiegerLocation: string): GameState =>
    makeState({
      provinces: [
        province("keep", { ownerId: "p2", walls: { tier: 2, hp: 5 }, garrison: 2 }),
        province("elsewhere", { ownerId: "p1" }),
      ],
      armies: [
        army("s1", "p1", besiegerLocation, { [UnitType.SIEGE]: 2, [UnitType.INFANTRY]: 2 }),
      ],
      // Undeclared round: isolates the LOCK (bombardment-only, no storm).
      siegeStates: [siegeState({ besiegingArmyIds: ["s1"], assaultDeclared: false })],
    });

  it("a besieger that MARCHED AWAY no longer besieges: the siege lifts and walls begin repair", () => {
    const state = build("elsewhere"); // still listed in besiegingArmyIds, but gone
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.captured).toBe(false);
    // Lifted: no live siege, province cleared, walls repaired +1 (5 → 6).
    expect(res.state.siegeStates).toHaveLength(0);
    expect(res.state.provinces.find((p) => p.id === "keep")?.siege).toBeUndefined();
    expect(res.wallHpRemaining).toBe(5 + SIEGE.wallRepairPerRound);
    // No remote bombardment happened: zero dice drawn.
    expect(res.state.rngCursor).toBe(0);
    const log = res.state.log.find((l) => l.type === "siege");
    expect(log?.data?.lifted).toBe(true);
  });

  it("the same stack physically AT the province keeps the siege alive (control)", () => {
    const state = build("keep");
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.state.siegeStates).toHaveLength(1);
    expect(res.state.siegeStates[0].roundsElapsed).toBe(1);
    // The 2 guns bombarded (>=1 HP each per the §8.2.2 table).
    expect(res.wallHpRemaining).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// §8.4 Great Bombard SILENCE (unpaid upkeep) — no bombard dice, no assault dice
// ---------------------------------------------------------------------------

describe("Great Bombard silence (§8.4 upkeep row; economy sets, combat consumes)", () => {
  const bombardSiege = (silenced: boolean): GameState =>
    makeState({
      round: 4,
      turn: 4,
      players: [player("p1", Faction.OTTOMAN), player("p2", Faction.BYZANTIUM)],
      provinces: [
        province("keep", {
          ownerId: "p2",
          terrain: TerrainType.CITY,
          walls: { tier: 3, hp: 10 },
          garrison: 1,
        }),
      ],
      armies: [bombardArmy("gb", "p1", "keep")],
      // Emplaced since round 2 → past the 1-round emplacement gate; only the
      // silence flag separates the two runs.
      greatBombard: { inPlay: true, ownerId: "p1", provinceId: "keep", emplacedRound: 2, silenced },
      siegeStates: [siegeState({ besiegingArmyIds: ["gb"], grainStores: 99 })],
    });

  it("a SILENCED emplaced Bombard rolls NO bombardment dice: walls untouched, zero draws", () => {
    const state = bombardSiege(true);
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.wallHpRemaining).toBe(10);
    expect(res.state.rngCursor).toBe(0);
  });

  it("the same gun un-silenced fires its full two-die bombardment (same seed delta)", () => {
    const state = bombardSiege(false);
    const res = resolveSiege(state, state.siegeStates[0], makeRng(SEED, 0));
    expect(res.wallHpRemaining).toBeLessThan(10);
    expect(res.state.rngCursor).toBeGreaterThan(0);
  });

  it("a SILENCED Bombard adds NO assault die either: identical to a no-gun storm", () => {
    // Breached-wall declared assault; the ONLY difference between the two runs
    // is the silenced gun, which must contribute nothing (same rng stream).
    const storm = (withSilencedGun: boolean): GameState => {
      const a1: Army = withSilencedGun
        ? {
            ...army("a1", "p1", "keep", { [UnitType.INFANTRY]: 6 }),
            variants: [{ base: UnitType.SIEGE, variant: GREAT_BOMBARD.variant, count: 1 }],
          }
        : army("a1", "p1", "keep", { [UnitType.INFANTRY]: 6 });
      return makeState({
        provinces: [
          province("keep", { ownerId: "p2", terrain: TerrainType.PLAINS, walls: { tier: 0, hp: 0 }, garrison: 0 }),
        ],
        armies: [a1, army("d1", "p2", "keep", { [UnitType.INFANTRY]: 14 })],
        siegeStates: [siegeState({ besiegingArmyIds: ["a1"], breached: true })],
        ...(withSilencedGun
          ? {
              greatBombard: {
                inPlay: true,
                ownerId: "p1",
                provinceId: "keep",
                emplacedRound: 2, // emplaced — ONLY the silence stops it
                silenced: true,
              },
            }
          : {}),
      });
    };
    const dLeft = (st: GameState): number => {
      const res = resolveSiege(st, st.siegeStates[0], makeRng(SEED, 0));
      return res.state.armies
        .filter((a) => a.ownerId === "p2")
        .reduce((n, a) => n + Object.values(a.units).reduce((x, y) => x + y, 0), 0);
    };
    expect(dLeft(storm(true))).toBe(dLeft(storm(false)));
  });
});

// ---------------------------------------------------------------------------
// ERROR CONTAINMENT — a throwing queued tactic must not crash the COMBAT phase
// ---------------------------------------------------------------------------

describe("tactic error containment (marshal major — COMBAT phase must not crash)", () => {
  const build = (attackerTactics: string[], gold = 0): [GameState, PendingBattle] => {
    const battle: PendingBattle = {
      id: "b1",
      provinceId: "field",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a1"],
      defenderStackIds: ["d1"],
      attackerTactics: attackerTactics.map(asTacticCardId),
    };
    const p1 = player("p1", Faction.OTTOMAN);
    p1.treasury = { ...p1.treasury, gold };
    const state = makeState({
      players: [p1, player("p2", Faction.BYZANTIUM)],
      provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
      armies: [
        army("a1", "p1", "field", { [UnitType.INFANTRY]: 12 }),
        army("d1", "p2", "field", { [UnitType.LEVY]: 1 }),
      ],
      pendingBattles: [battle],
    });
    return [state, battle];
  };

  it("an UNKNOWN queued card is contained: skipped, discarded, logged — the battle resolves as if card-free", () => {
    useRealTactics();
    const [s0, b0] = build([]);
    const baseline = resolveBattle(s0, b0, makeRng(SEED, 0));
    const [s1, b1] = build(["no-such-card"]);
    const res = resolveBattle(s1, b1, makeRng(SEED, 0)); // must NOT throw
    expect(res.winnerId).toBe("p1");
    // Deterministic continuation: the failed card consumed no rng — the dice
    // stream is byte-identical to the card-free baseline.
    expect(res.state.rngCursor).toBe(baseline.state.rngCursor);
    // The card was skipped out of the queue and discarded…
    expect(res.state.pendingBattles[0].attackerTactics).toHaveLength(0);
    expect(res.state.tacticDiscard).toContain(asTacticCardId("no-such-card"));
    // …and the failure was chronicled.
    expect(
      res.state.log.some((l) => l.data?.action === "discard_unresolved"),
    ).toBe(true);
  });

  it("an unpayable printed cost is contained the same way (no crash, effect skipped)", () => {
    useRealTactics();
    const [s0, b0] = build([], 0);
    const baseline = resolveBattle(s0, b0, makeRng(SEED, 0));
    // condottieri costs 2 gold; the player has 0 → resolution throws → contained.
    const [s1, b1] = build(["condottieri-contract"], 0);
    const res = resolveBattle(s1, b1, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1");
    expect(res.state.rngCursor).toBe(baseline.state.rngCursor); // no +2 dice happened
    expect(res.state.tacticDiscard).toContain(asTacticCardId("condottieri-contract"));
    expect(res.state.players.find((p) => p.id === "p1")?.treasury.gold).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §9.1 TEMPLE "+1 defender morale" CONSUMER (marshal minors list, ECONOMY:
// balance.ts:345 — the bonus existed as data with no combat reader)
// ---------------------------------------------------------------------------

describe("TEMPLE defender morale (§9.1, minors follow-up)", () => {
  // 8 INF vs 8 INF on HILLS. Seed 112 (hunted against the real kernel): the
  // defender's first §7.5 rout die is EXACTLY routThreshold (3), so the temple's
  // +1 morale (threshold 3 → 2) is the single deciding input: without it the
  // defender routs round 1 and the attacker takes the field; with it the same
  // die MISSES, the defence holds, and the shattered attacker is wiped in round
  // 2 — the whole battle flips on the temple.
  const TEMPLE_SEED = 112;
  const build = (buildings: BuildingType[]): [GameState, PendingBattle] => [
    makeState({
      provinces: [
        province("field", { ownerId: "p2", terrain: TerrainType.HILLS, buildings }),
      ],
      armies: [
        army("a1", "p1", "field", { [UnitType.INFANTRY]: 8 }),
        army("d1", "p2", "field", { [UnitType.INFANTRY]: 8 }),
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

  it("same seed: the defender routs without the temple, holds (and wins) with it", () => {
    // The fixture's dice math is tuned to a ±1 threshold shift.
    expect(TEMPLE_MORALE_BONUS).toBe(1);

    const [bare, bareBattle] = build([]);
    const noTemple = resolveBattle(bare, bareBattle, makeRng(TEMPLE_SEED, 0));
    expect(noTemple.defender.routed).toContain("d1");
    expect(noTemple.winnerId).toBe("p1");
    // "field" has no map neighbours → the routed stack surrenders wholly (§7.5).
    expect(noTemple.state.armies.find((a) => a.id === "d1")).toBeUndefined();
    expect(noTemple.state.provinces[0].ownerId).toBe("p1");

    const [blessed, blessedBattle] = build([BuildingType.TEMPLE]);
    const withTemple = resolveBattle(blessed, blessedBattle, makeRng(TEMPLE_SEED, 0));
    // Identical dice stream up to the rout die — only the threshold moved.
    expect(withTemple.defender.routed).toHaveLength(0);
    expect(withTemple.winnerId).toBe("p2");
    const survivor = withTemple.state.armies.find((a) => a.id === "d1");
    expect(survivor).toBeDefined();
    expect(withTemple.state.provinces[0].ownerId).toBe("p2");

    // Deterministic under the temple: same (state, seed) → identical result.
    const [blessed2, blessedBattle2] = build([BuildingType.TEMPLE]);
    expect(resolveBattle(blessed2, blessedBattle2, makeRng(TEMPLE_SEED, 0))).toEqual(withTemple);
  });
});

// ---------------------------------------------------------------------------
// §8.4 capture row — GB spike-on-capture (marshal minors list, COMBAT:
// combat.ts:371 "GB captor 'spike it' option unimplemented")
// ---------------------------------------------------------------------------

describe("Great Bombard spike-on-capture (§8.4 capture row, minors follow-up)", () => {
  const build = (): [GameState, PendingBattle] => [
    makeState({
      provinces: [province("field", { ownerId: "p2", terrain: TerrainType.PLAINS })],
      armies: [
        army("a1", "p1", "field", { [UnitType.INFANTRY]: 20 }),
        bombardArmy("d1", "p2", "field"),
      ],
      greatBombard: { inPlay: true, ownerId: "p2", provinceId: "field", emplacedRound: 1 },
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
  const totalGb = (s: GameState): number =>
    s.armies.reduce(
      (n, a) => n + (a.variants?.find((v) => v.variant === GREAT_BOMBARD.variant)?.count ?? 0),
      0,
    );

  it("default (spikeOnCapture=false): the captured gun transfers intact to the victor", () => {
    expect(GREAT_BOMBARD.spikeOnCapture).toBe(false); // authored default
    const [state, battle] = build();
    const res = resolveBattle(state, battle, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1");
    expect(totalGb(res.state)).toBe(1); // the piece lives on, on the winner's stack
    expect(res.state.armies.find((a) => a.id === "a1")?.variants?.some(
      (v) => v.variant === GREAT_BOMBARD.variant && v.count === 1,
    )).toBe(true);
    expect(res.state.greatBombard?.inPlay).toBe(true);
    expect(res.state.greatBombard?.ownerId).toBe("p1");
    expect(res.state.log.some((l) => l.data?.greatBombardSpiked === true)).toBe(false);
  });

  it("spikeOnCapture=true: the captured gun is PERMANENTLY removed (tracker out of play, piece gone, logged)", () => {
    // Flip the balance default for this test only (runtime override of the
    // `as const` literal; restored in finally so sibling tests see the default).
    const knob = GREAT_BOMBARD as unknown as { spikeOnCapture: boolean };
    knob.spikeOnCapture = true;
    try {
      const [state, battle] = build();
      const res = resolveBattle(state, battle, makeRng(SEED, 0));
      expect(res.winnerId).toBe("p1");
      // The one-per-game piece is gone from every stack…
      expect(totalGb(res.state)).toBe(0);
      // …and the singleton tracker is retired for good.
      expect(res.state.greatBombard?.inPlay).toBe(false);
      expect(res.state.greatBombard?.ownerId).toBeNull();
      expect(res.state.greatBombard?.provinceId).toBeNull();
      // The spiking is chronicled.
      expect(res.state.log.some((l) => l.data?.greatBombardSpiked === true)).toBe(true);
      // Purity: the caller's input tracker is untouched.
      expect(state.greatBombard?.inPlay).toBe(true);
      expect(state.greatBombard?.ownerId).toBe("p2");
    } finally {
      knob.spikeOnCapture = false;
    }
  });
});

// ---------------------------------------------------------------------------
// §7.6 / B4 residual — resolveNaval tallies destroyed enemy fleets onto the
// winner's Player.fleetsDestroyed (consumed by prestige's destroyedFleetOf)
// ---------------------------------------------------------------------------

describe("fleetsDestroyed counter (§7.6, B4 residual — minors follow-up)", () => {
  it("credits the winner one tally per destroyed enemy fleet, keyed by victim faction", () => {
    const build = (): GameState =>
      makeState({
        seaZones: [seaZone("aegean")],
        fleets: [
          fleet("f1", "p1", "aegean", { [UnitType.WARSHIP]: 6 }),
          fleet("f2", "p2", "aegean", { [UnitType.GALLEY]: 1 }),
          fleet("f3", "p2", "aegean", { [UnitType.GALLEY]: 1 }),
        ],
      });
    const battle: PendingBattle = {
      id: "n1",
      seaZoneId: "aegean",
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["f1"],
      defenderStackIds: ["f2", "f3"],
      isNaval: true,
    };
    const state = build();
    const res = resolveNaval(state, battle, makeRng(SEED, 0));
    expect(res.winnerId).toBe("p1");
    // Both defending fleets were wiped → the winner's per-victim tally reads 2.
    expect(res.state.fleets.filter((f) => f.ownerId === "p2")).toHaveLength(0);
    const winner = res.state.players.find((p) => p.id === "p1");
    expect(winner?.fleetsDestroyed?.[Faction.BYZANTIUM]).toBe(2);
    // The loser is credited nothing (its own surviving-victim view stays empty),
    // and the winner's damaged-but-surviving fleet counts for no one.
    expect(res.state.players.find((p) => p.id === "p2")?.fleetsDestroyed).toBeUndefined();
    // Purity: the input state's players are untouched.
    expect(state.players.find((p) => p.id === "p1")?.fleetsDestroyed).toBeUndefined();
    // Determinism re-run.
    expect(resolveNaval(build(), battle, makeRng(SEED, 0))).toEqual(res);
  });

  it("end-to-end: the tally makes ven-queen-of-the-adriatic's destroyedFleetOf clause satisfiable (B4)", () => {
    const queen = startingObjectives(Faction.VENICE).find(
      (o) => o.id === "ven-queen-of-the-adriatic",
    );
    expect(queen).toBeDefined();
    const pv = player("pv", Faction.VENICE);
    pv.objectives = [structuredClone(queen!)];
    const pg = player("pg", Faction.GENOA);
    const state = makeState({
      // Final round → this cleanup ends the game, so objectives are revealed & scored.
      round: ROUNDS,
      turn: ROUNDS,
      players: [pv, pg],
      turnOrder: ["pv", "pg"],
      provinces: [
        // The objective's territorial all-of: every Adriatic port is Venetian.
        province("venice", { ownerId: "pv" }),
        province("dalmatia", { ownerId: "pv" }),
        province("corfu", { ownerId: "pv" }),
        province("ragusa", { ownerId: "pv" }),
        // No Genoese colony (pera/chios/lesbos/kaffa) is owned, so the OR-group
        // can ONLY be satisfied through destroyedFleetOf.
      ],
      seaZones: [seaZone("adriatic")],
      fleets: [
        fleet("fv", "pv", "adriatic", { [UnitType.WARSHIP]: 6 }),
        fleet("fg", "pg", "adriatic", { [UnitType.GALLEY]: 1 }),
      ],
    });
    const battle: PendingBattle = {
      id: "n1",
      seaZoneId: "adriatic",
      attackerId: "pv",
      defenderId: "pg",
      attackerStackIds: ["fv"],
      defenderStackIds: ["fg"],
      isNaval: true,
    };
    const naval = resolveNaval(state, battle, makeRng(SEED, 0));
    expect(naval.winnerId).toBe("pv");
    expect(
      naval.state.players.find((p) => p.id === "pv")?.fleetsDestroyed?.[Faction.GENOA],
    ).toBe(1);

    // Game-end scoring WITH the tally: the objective completes and pays out.
    const scored = scorePrestige(naval.state);
    const scoredPv = scored.players.find((p) => p.id === "pv")!;
    expect(scoredPv.objectives[0].completed).toBe(true);

    // Control: the SAME post-battle state with the tally stripped — the OR-group
    // has no other satisfiable arm, so the objective does NOT complete and the
    // prestige difference is exactly the objective award.
    const control = structuredClone(naval.state) as GameState;
    delete control.players.find((p) => p.id === "pv")!.fleetsDestroyed;
    const controlScored = scorePrestige(control);
    const controlPv = controlScored.players.find((p) => p.id === "pv")!;
    expect(controlPv.objectives[0].completed).not.toBe(true);
    expect(scoredPv.prestige - controlPv.prestige).toBe(queen!.prestige);
  });
});
