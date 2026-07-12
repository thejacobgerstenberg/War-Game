/**
 * economy.test.ts — ECONOMY subsystem (§4 economy, §5 trade, §9 buildings).
 *
 * Covers the tax multipliers (§4.2), starvation desertion order incl. the
 * mercenary double-rate (§4.4), market ratios + trade-route formula + piracy
 * (§4.3/§5), and building costs/effects + multi-round great-work completion (§9).
 */
import { describe, it, expect } from "vitest";
import {
  BuildingType,
  Faction,
  GreatWorkType,
  TaxPosture,
  TerrainType,
  UnitType,
  type Army,
  type Fleet,
  type GameState,
  type ResourceBundle,
  type TradeAction,
  type BuildAction,
} from "@imperium/shared";
import { createInitialState, emptyUnits, type SeatInput } from "../gameState.js";
import {
  applyBuild,
  applyIncomePhase,
  applyTrade,
  computeIncome,
  upkeep,
} from "../economy.js";
import { EngineError } from "../actions.js";
import { makeRng } from "../rng.js";
import { expireRoundModifiers, getModifiers } from "../modifiers.js";
import { GREAT_BOMBARD, MERC_REVOLT_PILLAGE, TRADE } from "../balance.js";

/** Tag an army's units as mercenaries (§6.2/§4.4). */
function tagMercs(stack: Army, mercs: Partial<Record<UnitType, number>>): Army {
  (stack as { mercenaries?: Partial<Record<UnitType, number>> }).mercenaries = mercs;
  return stack;
}

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

function fresh(): GameState {
  return structuredClone(createInitialState("ROOM01", seats, 12345));
}

function army(ownerId: string, locationId: string, units: Partial<Record<UnitType, number>>): Army {
  return { id: `a-${ownerId}`, ownerId, locationId, units: { ...emptyUnits(), ...units } };
}

function galleyFleet(ownerId: string, locationId: string, count = 1): Fleet {
  return { id: `f-${ownerId}`, ownerId, locationId, units: { ...emptyUnits(), [UnitType.GALLEY]: count } };
}

/** Build a TRADE/ROUTE action (B1 §5.2 validation fixtures). */
function route(
  player: string,
  fromProvinceId: string,
  toProvinceId: string,
  seaZonePath: string[],
): TradeAction {
  return {
    type: "TRADE",
    player,
    trade: { kind: "ROUTE", fromProvinceId, toProvinceId, seaZonePath },
  };
}

/** Assert fn throws an EngineError carrying EXACTLY the given code. */
function expectEngineCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected EngineError(${code}) to be thrown`).toBeInstanceOf(EngineError);
  expect((thrown as EngineError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// §4.2 Taxation multipliers
// ---------------------------------------------------------------------------

describe("computeIncome — §4.2 taxation multipliers", () => {
  it("applies ×1.0 gold under NORMAL tax (Byzantium gross gold 13)", () => {
    const state = fresh();
    // Byzantium (canonical map) owned-province gold sums to 13 (see income.test).
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13);
  });

  it("applies ×0.75 (floor) gold under LENIENT tax", () => {
    const state = fresh();
    state.players[0].tax = TaxPosture.LENIENT;
    expect(computeIncome(state).perPlayer.p1.gold).toBe(Math.floor(13 * 0.75)); // 9
  });

  it("applies ×1.5 (floor) gold under HEAVY tax", () => {
    const state = fresh();
    state.players[0].tax = TaxPosture.HEAVY;
    expect(computeIncome(state).perPlayer.p1.gold).toBe(Math.floor(13 * 1.5)); // 19
  });
});

// ---------------------------------------------------------------------------
// §4.4 Upkeep & starvation desertion order (incl. mercenary double-rate)
// ---------------------------------------------------------------------------

describe("upkeep — §4.4 starvation desertion", () => {
  // NOTE (§6.1 no-home-upkeep): these fixtures campaign IN THE FIELD (edirne is
  // p2-owned) — a levy garrisoning its owner's home province now owes 0 grain
  // and would unbalance the ledgers below; see the dedicated §6.1 suite.
  it("deserts lowest-value first (LEVY before INFANTRY)", () => {
    const state = fresh();
    state.armies = [army("p1", "edirne", { [UnitType.LEVY]: 1, [UnitType.INFANTRY]: 1 })];
    state.fleets = [];
    state.players[0].treasury.grain = 1; // due 2, deficit 1 → one LEVY deserts
    const out = upkeep(state);
    const a = out.armies[0];
    expect(a.units[UnitType.LEVY]).toBe(0);
    expect(a.units[UnitType.INFANTRY]).toBe(1); // best defender survives
  });

  it("charges mercenaries double grain upkeep (MERC_UPKEEP_MULTIPLIER)", () => {
    const state = fresh();
    const merc = army("p1", "edirne", { [UnitType.LEVY]: 2 });
    (merc as { mercenaries?: Partial<Record<UnitType, number>> }).mercenaries = {
      [UnitType.LEVY]: 2,
    };
    state.armies = [merc];
    state.fleets = [];
    state.players[0].treasury.grain = 10;
    const out = upkeep(state);
    // 2 mercenary LEVY at ×2 = 4 grain due; 10 − 4 = 6 remains (vs 8 if regular).
    expect(out.players[0].treasury.grain).toBe(6);
  });

  it("deserts mercenaries FIRST even when they are higher-value than regulars", () => {
    const state = fresh();
    const stack = army("p1", "edirne", { [UnitType.LEVY]: 1, [UnitType.CAVALRY]: 1 });
    (stack as { mercenaries?: Partial<Record<UnitType, number>> }).mercenaries = {
      [UnitType.CAVALRY]: 1,
    };
    state.armies = [stack];
    state.fleets = [];
    // due = LEVY 1 + CAV(merc) 2×2 = 5; treasury 4 → deficit 1.
    state.players[0].treasury.grain = 4;
    const out = upkeep(state);
    const a = out.armies[0];
    expect(a.units[UnitType.CAVALRY]).toBe(0); // mercenary flees first...
    expect(a.units[UnitType.LEVY]).toBe(1); // ...sparing the cheaper regular
  });
});

// ---------------------------------------------------------------------------
// §4.3 Market conversion ratios
// ---------------------------------------------------------------------------

function convert(
  player: string,
  give: Partial<ResourceBundle>,
  get: Partial<ResourceBundle>,
): TradeAction {
  return { type: "TRADE", player, trade: { kind: "CONVERT", give, get } };
}

describe("applyTrade CONVERT — §4.3 market ratios", () => {
  it("converts at the base 3:1 ratio without infrastructure", () => {
    const state = fresh();
    state.players[0].treasury.gold = 6;
    const out = applyTrade(state, convert("p1", { gold: 3 }, { grain: 1 }));
    expect(out.players[0].treasury.gold).toBe(3);
    expect(out.players[0].treasury.grain).toBe(state.players[0].treasury.grain + 1);
  });

  it("rejects an under-paid conversion at the base ratio", () => {
    const state = fresh();
    state.players[0].treasury.gold = 6;
    expect(() => applyTrade(state, convert("p1", { gold: 2 }, { grain: 1 }))).toThrow(EngineError);
  });

  it("improves to 2:1 with a Market building", () => {
    const state = fresh();
    state.players[0].treasury.gold = 6;
    state.provinces.find((p) => p.id === "selymbria")!.buildings.push(BuildingType.MARKET);
    const out = applyTrade(state, convert("p1", { gold: 2 }, { grain: 1 }));
    expect(out.players[0].treasury.gold).toBe(4);
  });

  it("Grand Bazaar trades general goods 2:1 and only its specialty 1:1 (DA-1, §4.3)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 6, grain: 0, timber: 0, marble: 0, faith: 0 };
    state.provinces
      .find((p) => p.id === "selymbria")!
      .greatWorks.push({ type: GreatWorkType.GRAND_BAZAAR, progress: 2 });
    // selymbria's dominant secondary yield (grain 2) is the port's specialty.
    // GENERAL good (marble, non-specialty) trades 2:1 — 1 gold for 1 marble is
    // under-paid and rejected...
    expect(() => applyTrade(state, convert("p1", { gold: 1 }, { marble: 1 }))).toThrow(
      EngineError,
    );
    // ...but 2 gold for 1 marble clears at the 2:1 general Grand-Bazaar ratio.
    const general = applyTrade(state, convert("p1", { gold: 2 }, { marble: 1 }));
    expect(general.players[0].treasury.gold).toBe(4);
    // SPECIALTY good (grain) still trades 1:1 via the specialty lane: 1 gold buys 1.
    const specialty = applyTrade(state, convert("p1", { gold: 1 }, { grain: 1 }));
    expect(specialty.players[0].treasury.gold).toBe(5);
  });

  it("refuses to trade faith (non-tradeable §4.3)", () => {
    const state = fresh();
    expect(() => applyTrade(state, convert("p1", { faith: 1 }, { gold: 1 }))).toThrow(
      /faith/i,
    );
  });
});

// ---------------------------------------------------------------------------
// §5.2 Trade-route income formula + §5.3 piracy
// ---------------------------------------------------------------------------

function addRoute(
  state: GameState,
  ownerId: string,
  fromProvinceId: string,
  toProvinceId: string,
  seaZonePath: string[],
  fleetId?: string,
): void {
  state.activeModifiers.push({
    id: `trade_route-${state.activeModifiers.length}`,
    scope: "persistent",
    kind: "trade_route",
    data: { ownerId, fromProvinceId, toProvinceId, seaZonePath, fleetId },
  });
}

describe("trade routes — §5.2 formula", () => {
  it("scores base + portTier(A) + portTier(B) + controlledHops", () => {
    const state = fresh();
    // §5.2 band map (FL-09): constantinople HV5 → portTier 3; selymbria is a
    // coastal port with no HV flag → portTier 1 (any other port); 0 hops.
    addRoute(state, "p1", "constantinople", "selymbria", []);
    // 2 + 3 + 1 + 0 = 6 gold route income added to the 13 province gold.
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13 + 6);
  });

  it("halves (floor) route income when a hop is blockaded but escorted", () => {
    const state = fresh();
    state.seaZones.find((z) => z.id === "bosphorus")!.blockadedBy = "p2"; // enemy fleet
    state.fleets = [galleyFleet("p1", "bosphorus")]; // friendly escort → not severed
    addRoute(state, "p1", "constantinople", "selymbria", ["bosphorus"]);
    // base 6 (blockaded hop not counted as controlled) × 0.5 = 3.
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13 + 3);
  });

  it("severs route income to 0 when a blockaded hop has no escort", () => {
    const state = fresh();
    state.seaZones.find((z) => z.id === "bosphorus")!.blockadedBy = "p2";
    state.fleets = [];
    addRoute(state, "p1", "constantinople", "selymbria", ["bosphorus"]);
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13); // no route gold
  });

  it("multiplies route income ×1.5 (floor) for a maritime faction (Venice/Genoa)", () => {
    const state = fresh();
    state.players[0].faction = Faction.VENICE; // maritime merchant bonus
    addRoute(state, "p1", "constantinople", "selymbria", []);
    // floor(6 × 1.5) = 9.
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13 + 9);
  });

  it("establishes a route via applyTrade ROUTE and records the backing galley's fleetId (B1d)", () => {
    const state = fresh();
    state.fleets = [galleyFleet("p1", "constantinople")];
    // B1(a/b): constantinople and selymbria BOTH border sea-of-marmara — a
    // valid single-hop path (the old ["bosphorus"] fixture is now rejected:
    // selymbria does not border the bosphorus; see the rejection suite below).
    const out = applyTrade(state, route("p1", "constantinople", "selymbria", ["sea-of-marmara"]));
    const mod = out.activeModifiers.find((m) => m.kind === "trade_route");
    expect(mod).toBeDefined();
    // B1(d): the backing merchantman is recorded on the route modifier.
    expect(mod!.data?.fleetId).toBe("f-p1");
    // OUTCOME: the persisted route actually pays at the next income projection
    // (base 2 + portTier(cple)=3 + portTier(selymbria)=1 + 0 controlled hops).
    expect(computeIncome(out).perPlayer.p1.gold).toBe(13 + 6);
  });

  it("rejects a route with no merchant galley (§5.1/B1d, NO_GALLEY)", () => {
    const state = fresh();
    state.fleets = [];
    expectEngineCode(
      () => applyTrade(state, route("p1", "constantinople", "selymbria", ["sea-of-marmara"])),
      "NO_GALLEY",
    );
  });
});

// §5.3 piracy — RAID SPLIT (minors list economy.ts:625): raid-occurrence and
// sinking are SEPARATE dice. A raid suppresses that route's income THIS Income
// phase; only a further sink roll (1d6 <= TRADE.piracySinkRoll) also removes the
// galley and breaks the route. Tests steer the deterministic seeded stream by
// picking a cursor whose next draws produce the wanted hit/miss sequence.
describe("applyIncomePhase — §5.3 piracy (raid split: income loss vs sinking)", () => {
  /** First cursor ≥ start whose next d6 draws hit (<= piracySinkRoll) per `wanted`. */
  function cursorWhere(seed: number, start: number, wanted: boolean[]): number {
    for (let c = start; c < start + 100_000; c += 1) {
      const rng = makeRng(seed, c);
      if (wanted.every((hit) => (rng.rollD6() <= TRADE.piracySinkRoll) === hit)) {
        return c;
      }
    }
    throw new Error("no cursor produces the wanted piracy roll sequence");
  }

  /**
   * Unescorted single-route fixture. The FIRST Income-phase rng draws are this
   * route's raid (and, on a raid, sink) checks; `rolls` forces their outcomes.
   * Land upkeep isolated away (armies cleared); route pays 2+3+1+0 = 6.
   */
  function piracyFixture(rolls: boolean[]): GameState {
    const state = fresh();
    state.armies = [];
    state.fleets = [galleyFleet("p1", "constantinople")]; // off-lane: no escort
    addRoute(state, "p1", "constantinople", "selymbria", ["sea-of-marmara"], "f-p1");
    state.rngCursor = cursorWhere(state.rngSeed, state.rngCursor, rolls);
    return state;
  }

  it("no raid: the route pays in full and the merchantman is untouched", () => {
    const state = piracyFixture([false]); // raid roll misses
    const goldBefore = state.players[0].treasury.gold;
    const out = applyIncomePhase(state);
    expect(out.players[0].treasury.gold - goldBefore).toBe(13 + 6); // route paid
    expect(out.fleets.find((f) => f.id === "f-p1")?.units[UnitType.GALLEY]).toBe(1);
    const mod = out.activeModifiers.find((m) => m.kind === "trade_route");
    expect(mod).toBeDefined();
    expect(mod!.data?.raidedRound).toBeUndefined(); // never stamped
  });

  it("raided but NOT sunk: income suppressed THIS phase, galley + route survive and pay again next round", () => {
    const state = piracyFixture([true, false]); // raid hits, sink roll misses
    const goldBefore = state.players[0].treasury.gold;
    const out = applyIncomePhase(state);
    // §5.3 "loses that round's route income": province gold only, no route gold.
    expect(out.players[0].treasury.gold - goldBefore).toBe(13);
    // The merchantman SURVIVES and the route persists (stamped, not broken).
    expect(out.fleets.find((f) => f.id === "f-p1")?.units[UnitType.GALLEY]).toBe(1);
    const mod = out.activeModifiers.find((m) => m.kind === "trade_route");
    expect(mod).toBeDefined();
    expect(mod!.data?.raidedRound).toBe(out.round);
    // The raid is chronicled.
    expect(out.log.some((l) => (l.data as { raided?: boolean })?.raided === true)).toBe(true);
    // The suppression lasts EXACTLY this Income: next round the route pays again.
    const nextRound = structuredClone(out) as GameState;
    nextRound.round += 1;
    expect(computeIncome(nextRound).perPlayer.p1.gold).toBe(13 + 6);
  });

  it("raided AND sunk: income suppressed, the galley is removed and the route broken", () => {
    const state = piracyFixture([true, true]); // raid hits, sink hits
    const goldBefore = state.players[0].treasury.gold;
    const out = applyIncomePhase(state);
    expect(out.players[0].treasury.gold - goldBefore).toBe(13); // no route gold
    expect(out.fleets.find((f) => f.id === "f-p1")?.units[UnitType.GALLEY]).toBe(0); // sunk
    expect(out.activeModifiers.some((m) => m.kind === "trade_route")).toBe(false); // broken
    expect(out.log.some((l) => (l.data as { sunk?: boolean })?.sunk === true)).toBe(true);
  });

  it("a friendly GALLEY war fleet in the lane escorts and prevents piracy (§5.3, FL-15)", () => {
    const state = fresh();
    state.armies = [];
    state.fleets = [
      galleyFleet("p1", "constantinople"), // merchantman (id f-p1), off-lane
      {
        id: "escort",
        ownerId: "p1",
        locationId: "sea-of-marmara",
        units: { ...emptyUnits(), [UnitType.GALLEY]: 1 }, // GALLEY, not WARSHIP
      },
    ];
    addRoute(state, "p1", "constantinople", "selymbria", ["sea-of-marmara"], "f-p1");
    // Steer the dice to raid-AND-sink: the escort must bypass them entirely.
    state.rngCursor = cursorWhere(state.rngSeed, state.rngCursor, [true, true]);
    const out = applyIncomePhase(state);
    // A galley (war fleet per §5.3) escorting the hop prevents the raid outright,
    // regardless of the piracy dice → route intact, no galley lost, no raid stamp.
    const mod = out.activeModifiers.find((m) => m.kind === "trade_route");
    expect(mod).toBeDefined();
    expect(mod!.data?.raidedRound).toBeUndefined();
    expect(out.fleets.find((f) => f.id === "f-p1")?.units[UnitType.GALLEY]).toBe(1);
    expect(out.log.some((l) => (l.data as { raided?: boolean })?.raided === true)).toBe(false);
  });

  it("advances and persists the RNG cursor (determinism)", () => {
    const state = fresh();
    const out = applyIncomePhase(state);
    expect(out.rngCursor).toBeGreaterThanOrEqual(state.rngCursor);
  });

  it("is deterministic: the same seed/cursor replays the identical piracy outcome", () => {
    const a = applyIncomePhase(piracyFixture([true, false]));
    const b = applyIncomePhase(piracyFixture([true, false]));
    expect(b.rngCursor).toBe(a.rngCursor);
    expect(b.players[0].treasury).toEqual(a.players[0].treasury);
    expect(b.fleets).toEqual(a.fleets);
  });
});

// ---------------------------------------------------------------------------
// §9 Buildings: costs + effects
// ---------------------------------------------------------------------------

function build(player: string, provinceId: string, extra: Partial<BuildAction>): BuildAction {
  return { type: "BUILD", player, provinceId, ...extra } as BuildAction;
}

describe("applyBuild — §9.1 buildings", () => {
  it("charges BUILDING_COSTS and adds the building", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 10, grain: 0, timber: 0, marble: 5, faith: 0 };
    const out = applyBuild(state, build("p1", "selymbria", { building: BuildingType.MARKET }));
    const prov = out.provinces.find((p) => p.id === "selymbria")!;
    expect(prov.buildings).toContain(BuildingType.MARKET);
    // Market cost gold 4, marble 2.
    expect(out.players[0].treasury.gold).toBe(6);
    expect(out.players[0].treasury.marble).toBe(3);
  });

  it("adds the Market yield bonus (+1 gold/round) to income (§9.1)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 10, grain: 0, timber: 0, marble: 5, faith: 0 };
    const built = applyBuild(state, build("p1", "selymbria", { building: BuildingType.MARKET }));
    // Byzantium gross gold 13 + Market +1 = 14 (NORMAL tax).
    expect(computeIncome(built).perPlayer.p1.gold).toBe(14);
  });

  it("rejects building on an unowned province (NOT_OWNER)", () => {
    const state = fresh();
    // edirne is Ottoman-owned.
    expect(() =>
      applyBuild(state, build("p1", "edirne", { building: BuildingType.MARKET })),
    ).toThrow(EngineError);
  });

  it("rejects a build the player cannot afford (INSUFFICIENT_RESOURCES)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 0, grain: 0, timber: 0, marble: 0, faith: 0 };
    expect(() =>
      applyBuild(state, build("p1", "selymbria", { building: BuildingType.MARKET })),
    ).toThrow(EngineError);
  });

  it("upgrades walls one tier and sets HP from WALL_TIERS (§8.1/§9)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 20, grain: 0, timber: 0, marble: 20, faith: 0 };
    const prov0 = state.provinces.find((p) => p.id === "selymbria")!;
    const out = applyBuild(state, build("p1", "selymbria", { building: BuildingType.WALLS }));
    const prov = out.provinces.find((p) => p.id === "selymbria")!;
    expect(prov.walls.tier).toBe(prov0.walls.tier + 1);
    expect(prov.walls.hp).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §9.2 Great works: multi-round completion + prestige
// ---------------------------------------------------------------------------

describe("applyBuild — §9.2 great works", () => {
  it("charges cost up front, tracks progress across rounds, then awards prestige on completion", () => {
    const state = fresh();
    // Grand Bazaar: cost gold16/timber6/stone6, rounds 2, prestige 5.
    state.players[0].treasury = { gold: 30, grain: 0, timber: 10, marble: 10, faith: 0 };
    const gw = { greatWork: GreatWorkType.GRAND_BAZAAR };

    const r1 = applyBuild(state, build("p1", "selymbria", gw));
    const prov1 = r1.provinces.find((p) => p.id === "selymbria")!;
    expect(prov1.greatWorks[0].progress).toBe(1); // 1/2, not complete
    expect(r1.players[0].prestige).toBe(0);
    // Cost paid up front on the first invest.
    expect(r1.players[0].treasury.gold).toBe(30 - 16);

    const r2 = applyBuild(r1, build("p1", "selymbria", gw));
    const prov2 = r2.provinces.find((p) => p.id === "selymbria")!;
    expect(prov2.greatWorks[0].progress).toBe(2); // 2/2 complete
    expect(r2.players[0].prestige).toBe(5); // +5 prestige on completion
    // No additional cost on the second invest.
    expect(r2.players[0].treasury.gold).toBe(30 - 16);
  });

  it("sets Theodosian Walls to tier 5 / 16 HP on completion", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 40, grain: 0, timber: 0, marble: 40, faith: 0 };
    const gw = { greatWork: GreatWorkType.THEODOSIAN_WALLS }; // rounds 2
    const r1 = applyBuild(state, build("p1", "selymbria", gw));
    const r2 = applyBuild(r1, build("p1", "selymbria", gw));
    const prov = r2.provinces.find((p) => p.id === "selymbria")!;
    // CANON #4: Theodosian = T5 = 16 HP / +4 under the restored 5-tier keyspace.
    expect(prov.walls.tier).toBe(5);
    expect(prov.walls.hp).toBe(16);
  });

  it("rejects investing in an already-complete great work", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 40, grain: 0, timber: 40, marble: 40, faith: 0 };
    const gw = { greatWork: GreatWorkType.GRAND_BAZAAR };
    const r1 = applyBuild(state, build("p1", "selymbria", gw));
    const r2 = applyBuild(r1, build("p1", "selymbria", gw)); // complete at 2/2
    expect(() => applyBuild(r2, build("p1", "selymbria", gw))).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------------------
// Modifier readers — event/tactic ActiveModifiers honored by economy
// (CONTRACT2 §12.10 map; §4/§5)
// ---------------------------------------------------------------------------

/** Push an ActiveModifier onto the side-channel (mimics an event/tactic card). */
function addMod(
  state: GameState,
  kind: string,
  extra: {
    value?: number;
    target?: { faction?: Faction; provinceId?: string; seaZoneId?: string };
    data?: Record<string, unknown>;
    scope?: "round" | "persistent" | "game";
  } = {},
): void {
  state.activeModifiers.push({
    id: `${kind}-${state.activeModifiers.length}`,
    scope: extra.scope ?? "round",
    kind,
    value: extra.value,
    target: extra.target,
    data: extra.data,
  });
}

describe("economy modifier readers — §4/§5", () => {
  it("'no_income' zeroes a suppressed province's yield this Income (§10.7)", () => {
    const state = fresh();
    // Byzantium gross gold 13 includes selymbria's +1 gold.
    addMod(state, "no_income", { target: { provinceId: "selymbria" } });
    expect(computeIncome(state).perPlayer.p1.gold).toBe(12);
  });

  it("adds an additive 'faith_income' delta for the targeted faction (§4.1)", () => {
    const state = fresh();
    const base = computeIncome(state).perPlayer.p1.faith; // Byzantium base faith
    addMod(state, "faith_income", { value: 2, target: { faction: Faction.BYZANTIUM } });
    expect(computeIncome(state).perPlayer.p1.faith).toBe(base + 2);
  });

  it("zeroes faith income via the multiplicative Interdict path (#28, faith ×0)", () => {
    const state = fresh();
    const p2Base = computeIncome(state).perPlayer.p2.faith; // Ottoman, untargeted
    expect(computeIncome(state).perPlayer.p1.faith).toBeGreaterThan(0);
    // As events/index.ts case 28 posts it: faith_income value 0 carrying a ×0 multiplier.
    addMod(state, "faith_income", {
      value: 0,
      target: { faction: Faction.BYZANTIUM },
      data: { multiplier: 0 },
      scope: "persistent",
    });
    const out = computeIncome(state);
    expect(out.perPlayer.p1.faith).toBe(0); // additive sum could never zero this
    // Targeting isolation: Ottoman faith income is untouched.
    expect(out.perPlayer.p2.faith).toBe(p2Base);
  });

  it("also honors a dedicated 'faith_mult' multiplicative kind", () => {
    const state = fresh();
    const base = computeIncome(state).perPlayer.p1.faith;
    addMod(state, "faith_mult", { value: 0, target: { faction: Faction.BYZANTIUM } });
    expect(computeIncome(state).perPlayer.p1.faith).toBe(0);
    expect(base).toBeGreaterThan(0);
  });

  it("'trade_mod' improves a market conversion ratio (§4.3)", () => {
    const state = fresh();
    state.players[0].treasury.gold = 6;
    // Base ratio 3:1 → give 2 gold for 1 grain would normally be under-paid...
    expect(() => applyTrade(state, convert("p1", { gold: 2 }, { grain: 1 }))).toThrow(
      EngineError,
    );
    // ...but a +1 trade_mod sharpens it to 2:1, so the same trade now clears.
    addMod(state, "trade_mod", { value: 1, target: { faction: Faction.BYZANTIUM } });
    const out = applyTrade(state, convert("p1", { gold: 2 }, { grain: 1 }));
    expect(out.players[0].treasury.gold).toBe(4);
  });

  it("'trade_mod' adjusts trade-route gold (§5.2, e.g. #18 Venetian–Genoese War −2)", () => {
    const state = fresh();
    addRoute(state, "p1", "constantinople", "selymbria", []); // base route gold 6
    addMod(state, "trade_mod", { value: -2, target: { faction: Faction.BYZANTIUM } });
    // 13 province gold + max(0, 6 − 2) = 13 + 4.
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13 + 4);
  });

  it("'income' pays a flat per-round gold to the controller of a targeted province (#9 Alum)", () => {
    const state = fresh();
    const base = computeIncome(state).perPlayer.p1.gold; // 13
    const p2Base = computeIncome(state).perPlayer.p2.gold;
    // selymbria is Byzantium-controlled: a standing +2 gold/round dye monopoly.
    addMod(state, "income", {
      value: 2,
      target: { provinceId: "selymbria" },
      data: { perRoundGold: 2 },
      scope: "game",
    });
    const out = computeIncome(state);
    expect(out.perPlayer.p1.gold).toBe(base + 2); // fires EVERY income phase
    expect(out.perPlayer.p2.gold).toBe(p2Base); // only the controller collects
  });

  it("'income' pays a flat per-round gold to a targeted faction (#39 pilgrimage)", () => {
    const state = fresh();
    const base = computeIncome(state).perPlayer.p1.gold;
    addMod(state, "income", {
      value: 1,
      target: { faction: Faction.BYZANTIUM },
      data: { perRoundGold: 1 },
      scope: "game",
    });
    expect(computeIncome(state).perPlayer.p1.gold).toBe(base + 1);
  });

  it("'plague' subtracts −1 grain/−1 gold per controlled CITY/high-value province (#35)", () => {
    const state = fresh();
    const baseGold = computeIncome(state).perPlayer.p1.gold;
    const baseGrain = computeIncome(state).perPlayer.p1.grain;
    const qualifying = state.provinces.filter(
      (p) =>
        p.ownerId === "p1" &&
        (p.terrain === TerrainType.CITY || (p.highValue ?? 0) > 0),
    ).length;
    expect(qualifying).toBeGreaterThan(0); // Byzantium holds Constantinople
    // As events/index.ts case 35 posts it: kind:'plague', data:{grain:-1,gold:-1}.
    addMod(state, "plague", {
      data: { grain: -1, gold: -1, cullRatio: 3 },
      scope: "persistent",
    });
    const out = computeIncome(state);
    expect(out.perPlayer.p1.gold).toBe(Math.max(0, baseGold - qualifying));
    expect(out.perPlayer.p1.grain).toBe(Math.max(0, baseGrain - qualifying));
  });

  it("'upkeep_mod' changes the grain a faction owes at upkeep (§4.4)", () => {
    const state = fresh();
    // Field levy (edirne is p2-owned): due 1 grain (§6.1 home levies owe 0).
    state.armies = [army("p1", "edirne", { [UnitType.LEVY]: 1 })];
    state.fleets = [];
    state.players[0].treasury.grain = 5;
    addMod(state, "upkeep_mod", { value: 2, target: { faction: Faction.BYZANTIUM } });
    // due = 1 + 2 = 3; 5 − 3 = 2 remains (vs 4 without the modifier).
    expect(upkeep(state).players[0].treasury.grain).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §4.3/§5 Specialty 1:1 trade lane (Venice/Genoa & Grand Bazaar)
// ---------------------------------------------------------------------------

describe("applyTrade CONVERT — §4.3/§5 specialty 1:1 lane", () => {
  it("Venice trades gold↔the port's specialty good at 1:1", () => {
    const state = fresh();
    state.players[0].faction = Faction.VENICE; // maritime merchant republic
    state.players[0].treasury = { gold: 6, grain: 0, timber: 0, marble: 0, faith: 0 };
    // Make selymbria's specialty unambiguously timber (a coastal owned port).
    const port = state.provinces.find((p) => p.id === "selymbria")!;
    port.yields = { gold: 0, grain: 0, timber: 3, marble: 0, faith: 0 };
    // gold↔specialty (timber) clears at 1:1 — 1 gold buys 1 timber.
    const out = applyTrade(state, convert("p1", { gold: 1 }, { timber: 1 }));
    expect(out.players[0].treasury.gold).toBe(5);
    expect(out.players[0].treasury.timber).toBe(1);
  });

  it("does not extend the 1:1 lane to a non-specialty resource (port stays 2:1)", () => {
    const state = fresh();
    state.players[0].faction = Faction.VENICE;
    state.players[0].treasury = { gold: 6, grain: 0, timber: 0, marble: 0, faith: 0 };
    const port = state.provinces.find((p) => p.id === "selymbria")!;
    port.yields = { gold: 0, grain: 0, timber: 3, marble: 0, faith: 0 };
    // marble is no owned port's specialty → Venice's port ratio (2:1) applies,
    // so paying 1 gold for 1 marble is under-paid and rejected.
    expect(() => applyTrade(state, convert("p1", { gold: 1 }, { marble: 1 }))).toThrow(
      EngineError,
    );
  });

  it("denies the specialty lane to a non-maritime faction without a Grand Bazaar", () => {
    const state = fresh();
    // Byzantium (default) is not a trade-ratio-port faction.
    const port = state.provinces.find((p) => p.id === "selymbria")!;
    port.yields = { gold: 0, grain: 0, timber: 3, marble: 0, faith: 0 };
    state.players[0].treasury.gold = 6;
    expect(() => applyTrade(state, convert("p1", { gold: 1 }, { timber: 1 }))).toThrow(
      EngineError,
    );
  });
});

// ---------------------------------------------------------------------------
// §4.4 Mercenary double-rate desertion (tightened ledger reading)
// ---------------------------------------------------------------------------

describe("upkeep — §4.4 mercenary double-rate desertion", () => {
  it("deserts mercenaries at double rate: each merc relieves its doubled upkeep", () => {
    const state = fresh();
    // Field fixture (edirne is p2-owned): §6.1 home levies would owe 0.
    const stack = army("p1", "edirne", { [UnitType.LEVY]: 3 });
    (stack as { mercenaries?: Partial<Record<UnitType, number>> }).mercenaries = {
      [UnitType.LEVY]: 3,
    };
    state.armies = [stack];
    state.fleets = [];
    // due = 3 merc LEVY × 1 × 2 = 6; treasury 2 → deficit 4.
    // Each deserting merc relieves 2 grain → 2 mercs desert, 1 remains.
    state.players[0].treasury.grain = 2;
    const out = upkeep(state);
    const a = out.armies[0];
    expect(a.units[UnitType.LEVY]).toBe(1);
    expect(a.mercenaries?.[UnitType.LEVY]).toBe(1); // survivor is still merc-tagged
    expect(out.players[0].treasury.grain).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §4.4/§6.3 Elite-mercenary VARIANT heads (Varangian Remnant) — FL-10
// ---------------------------------------------------------------------------

/** Army carrying named variant heads (auction-fielded elite mercenaries). */
function variantArmy(
  ownerId: string,
  locationId: string,
  variants: { base: UnitType; variant: string; count: number }[],
  units: Partial<Record<UnitType, number>> = {},
): Army {
  return {
    id: `av-${ownerId}`,
    ownerId,
    locationId,
    units: { ...emptyUnits(), ...units },
    variants,
  };
}

describe("upkeep — §4.4/§6.3 elite-mercenary variant heads (FL-10)", () => {
  it("charges Varangian Remnant variant heads DOUBLE grain upkeep (elite-mercenary)", () => {
    const state = fresh();
    // The full VARANGIAN_REMNANT company: INFANTRY×4 + CAVALRY×2 fielded as variants.
    state.armies = [
      variantArmy("p1", "selymbria", [
        { base: UnitType.INFANTRY, variant: "VARANGIAN_REMNANT", count: 4 },
        { base: UnitType.CAVALRY, variant: "VARANGIAN_REMNANT", count: 2 },
      ]),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 20;
    const out = upkeep(state);
    // §4.4 ×2 merc upkeep: 4 INF×1×2 + 2 CAV×2×2 = 8 + 8 = 16; 20 − 16 = 4 remains
    // (the regular rate would owe only 8, leaving 12).
    expect(out.players[0].treasury.grain).toBe(4);
  });

  it("does NOT double a non-mercenary faction unique (Varangian GUARD stays regular)", () => {
    const state = fresh();
    // VARANGIAN_GUARD is one of the 10 faction uniques — no `elite-mercenary` tag.
    state.armies = [
      variantArmy("p1", "selymbria", [
        { base: UnitType.INFANTRY, variant: "VARANGIAN_GUARD", count: 4 },
      ]),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 20;
    const out = upkeep(state);
    // Regular rate: 4 INF × 1 = 4; 20 − 4 = 16 (NOT the ×2 = 8 a mercenary would owe).
    expect(out.players[0].treasury.grain).toBe(16);
  });

  it("variant mercenaries desert FIRST, before regular units, at the doubled rate", () => {
    const state = fresh();
    // One regular LEVY plus one VARANGIAN_REMNANT INFANTRY head, in the FIELD
    // (edirne is p2-owned — a §6.1 home levy would owe 0 and skew the ledger).
    state.armies = [
      variantArmy(
        "p1",
        "edirne",
        [{ base: UnitType.INFANTRY, variant: "VARANGIAN_REMNANT", count: 1 }],
        { [UnitType.LEVY]: 1 },
      ),
    ];
    state.fleets = [];
    // due = LEVY 1 (regular) + INF variant merc 1×1×2 = 3; treasury 1 → deficit 2.
    // The variant merc (2 grain relief) deserts first, clearing the deficit and
    // sparing the cheaper regular LEVY — §4.4 desert-first now scans variant heads.
    state.players[0].treasury.grain = 1;
    const out = upkeep(state);
    const a = out.armies[0];
    expect(a.variants ?? []).toHaveLength(0); // Varangian head fled first...
    expect(a.units[UnitType.LEVY]).toBe(1); // ...regular LEVY survives
  });
});

// ---------------------------------------------------------------------------
// EVENT_CARDS #22 `mercenary-revolt` / ratified errata E5b — unpaid-mercenary
// desertion PILLAGES the host province: −2 gold to the owner AND yield 0 next
// Income (both printed halves; formerly mis-cited as §4.4/§11 "DELTA 5").
// ---------------------------------------------------------------------------

describe("upkeep — EVENT_CARDS #22/E5b unpaid-merc desertion pillages host", () => {
  it("strips MERC_REVOLT_PILLAGE gold from the host province's owner when an unpaid merc deserts", () => {
    const state = fresh();
    // One mercenary INFANTRY hosted at selymbria (owned by p1); no grain to feed
    // it. (INFANTRY, not LEVY: a home-garrison levy owes 0 grain under §6.1 and
    // would never desert.)
    state.armies = [
      tagMercs(army("p1", "selymbria", { [UnitType.INFANTRY]: 1 }), {
        [UnitType.INFANTRY]: 1,
      }),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 0; // due 2 (merc ×2) → deficit 2 → merc deserts
    state.players[0].treasury.gold = 10;
    const out = upkeep(state);
    expect(out.armies[0].units[UnitType.INFANTRY]).toBe(0); // unpaid merc deserted
    // #22/E5b gold half: the deserting company pillages its host (selymbria, p1-owned).
    expect(out.players[0].treasury.gold).toBe(10 - MERC_REVOLT_PILLAGE.pillageGold);
    // A pillage entry is chronicled.
    expect(out.log.some((l) => (l.data as { pillageGold?: number })?.pillageGold)).toBe(
      true,
    );
  });

  it("pillages the HOST province's owner, not the mercenary's owner (mercs on foreign soil)", () => {
    const state = fresh();
    // p1's mercenaries campaign on Ottoman soil (edirne is p2-owned).
    state.armies = [
      tagMercs(army("p1", "edirne", { [UnitType.LEVY]: 1 }), { [UnitType.LEVY]: 1 }),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 0; // deficit 2 → the merc deserts
    state.players[0].treasury.gold = 10; // merc owner
    state.players[1].treasury.gold = 10; // host (edirne) owner
    const out = upkeep(state);
    // #22/E5b: the HOST province owner (p2) is robbed; the merc owner (p1) is not.
    expect(out.players[1].treasury.gold).toBe(10 - MERC_REVOLT_PILLAGE.pillageGold);
    expect(out.players[0].treasury.gold).toBe(10);
  });

  it("does NOT pillage on ordinary (non-mercenary) desertion", () => {
    const state = fresh();
    // A regular (un-tagged) INFANTRY that starves and deserts — no pillage.
    state.armies = [army("p1", "selymbria", { [UnitType.INFANTRY]: 1 })];
    state.fleets = [];
    state.players[0].treasury.grain = 0; // due 1 → deficit 1 → regular unit deserts
    state.players[0].treasury.gold = 10;
    const out = upkeep(state);
    expect(out.armies[0].units[UnitType.INFANTRY]).toBe(0); // deserted...
    expect(out.players[0].treasury.gold).toBe(10); // ...but no pillage (#22/E5b merc-only)
    // The YIELD half never fires for ordinary desertion either.
    expect(getModifiers(out, "no_income", { provinceId: "selymbria" })).toHaveLength(0);
  });

  it("clamps the pillage at zero gold (never negative)", () => {
    const state = fresh();
    state.armies = [
      tagMercs(army("p1", "selymbria", { [UnitType.INFANTRY]: 1 }), {
        [UnitType.INFANTRY]: 1,
      }),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 0;
    state.players[0].treasury.gold = 1; // less than pillageGold → floors at 0
    const out = upkeep(state);
    expect(out.players[0].treasury.gold).toBe(0);
  });

  it("E5b YIELD half: the pillaged host yields 0 at exactly the NEXT Income (#22 'yield 0 next round')", () => {
    const state = fresh();
    state.armies = [
      tagMercs(army("p1", "selymbria", { [UnitType.INFANTRY]: 1 }), {
        [UnitType.INFANTRY]: 1,
      }),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 0; // deficit → the unpaid merc deserts + pillages
    state.players[0].treasury.gold = 10;
    const out = upkeep(state);
    // Both halves landed: gold stripped AND a 1-round no_income suppression posted.
    expect(out.players[0].treasury.gold).toBe(10 - MERC_REVOLT_PILLAGE.pillageGold);
    const mods = getModifiers(out, "no_income", { provinceId: "selymbria" });
    expect(mods).toHaveLength(1);
    expect(mods[0].expiresRound).toBe(out.round + 1);
    // NEXT Income (round + 1): selymbria (1 gold in Byzantium's 13) yields nothing.
    const nextRound = structuredClone(out) as GameState;
    nextRound.round += 1;
    expect(computeIncome(nextRound).perPlayer.p1.gold).toBe(12);
    // EXACTLY once: the round-(N+1) cleanup retires the modifier, income recovers.
    const cleaned = expireRoundModifiers(nextRound);
    expect(getModifiers(cleaned, "no_income", { provinceId: "selymbria" })).toHaveLength(0);
    expect(computeIncome(cleaned).perPlayer.p1.gold).toBe(13);
  });

  it("does not pillage GOLD when the host province is neutral (no owner to rob)", () => {
    const state = fresh();
    // A neutral province is NOT a §6.1 home for the merc's owner, so the levy
    // still owes its doubled grain and deserts.
    const merc = tagMercs(army("p1", "selymbria", { [UnitType.LEVY]: 1 }), {
      [UnitType.LEVY]: 1,
    });
    state.armies = [merc];
    state.fleets = [];
    state.provinces.find((p) => p.id === "selymbria")!.ownerId = null; // neutral host
    state.players[0].treasury.grain = 0;
    state.players[0].treasury.gold = 10;
    const out = upkeep(state);
    expect(out.armies[0].units[UnitType.LEVY]).toBe(0); // still deserts
    expect(out.players[0].treasury.gold).toBe(10); // nobody controls the host → no theft
    // The E5b YIELD half still lands on the sacked land itself.
    expect(getModifiers(out, "no_income", { provinceId: "selymbria" })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §5.2 CLARIFICATION — a blockaded hop HALVES (does NOT cancel) route income;
// only a SEVERED hop zeroes it.
// ---------------------------------------------------------------------------

describe("trade routes — §5.2 blockade halves, severed cancels (CLARIFICATION §5.2)", () => {
  it("a blockaded-but-escorted hop earns HALF the route income, strictly greater than zero", () => {
    const state = fresh();
    state.seaZones.find((z) => z.id === "bosphorus")!.blockadedBy = "p2"; // enemy fleet
    state.fleets = [galleyFleet("p1", "bosphorus")]; // friendly escort ⇒ blockaded, not severed
    addRoute(state, "p1", "constantinople", "selymbria", ["bosphorus"]);
    const withBlockade = computeIncome(state).perPlayer.p1.gold;
    // Base route gold 6 (blockaded hop not counted as a controlled hop) → ×0.5 = 3.
    expect(withBlockade).toBe(13 + 3);
    // §5.2: HALVED, never cancelled — the route still pays (> the no-route baseline).
    expect(withBlockade).toBeGreaterThan(13);
  });

  it("a severed hop (enemy fleet, no escort) zeroes the route income", () => {
    const state = fresh();
    state.seaZones.find((z) => z.id === "bosphorus")!.blockadedBy = "p2";
    state.fleets = []; // no friendly escort on the blockaded hop ⇒ SEVERED
    addRoute(state, "p1", "constantinople", "selymbria", ["bosphorus"]);
    // §5.2: only a severed route = 0; province gold alone, no route contribution.
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// §2.3 PER-UNIQUE UPKEEP OVERRIDES — grainUpkeep / goldUpkeep (donative pay)
// ---------------------------------------------------------------------------

describe("upkeep — §2.3 per-unique grain/gold upkeep overrides (§4.4)", () => {
  it("charges a unique its `grainUpkeep` OVERRIDE, not the base UnitType upkeep", () => {
    const state = fresh();
    // JANISSARY (base INFANTRY, base grain upkeep 1) carries §2.3 grainUpkeep 0.
    state.armies = [
      variantArmy("p1", "selymbria", [
        { base: UnitType.INFANTRY, variant: "JANISSARY", count: 4 },
      ]),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 20;
    state.players[0].treasury.gold = 20; // fund the donative so nobody mutinies
    const out = upkeep(state);
    // §2.3 override 0 grain: NOTHING is drawn from grain stores (base rate would
    // owe 4 INF × 1 = 4, leaving 16). The override wins.
    expect(out.players[0].treasury.grain).toBe(20);
    // All four Janissaries survive (grain 0 owed, gold donative paid in full).
    const inf = out.armies[0].variants!.find((v) => v.variant === "JANISSARY");
    expect(inf?.count).toBe(4);
  });

  it("deducts a `goldUpkeep` unique's donative from the treasury gold", () => {
    const state = fresh();
    // BLACK_ARMY (base INFANTRY) carries §2.3 goldUpkeep 1, grainUpkeep 0.
    state.armies = [
      variantArmy("p1", "selymbria", [
        { base: UnitType.INFANTRY, variant: "BLACK_ARMY", count: 3 },
      ]),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 20;
    state.players[0].treasury.gold = 10;
    const out = upkeep(state);
    // §2.3 donative: 3 gold-paid INF × 1 gold = 3 drawn from gold; 10 − 3 = 7.
    expect(out.players[0].treasury.gold).toBe(7);
    // Grain untouched (grainUpkeep override 0).
    expect(out.players[0].treasury.grain).toBe(20);
    // Troops stay (donative paid).
    expect(out.armies[0].variants!.find((v) => v.variant === "BLACK_ARMY")?.count).toBe(3);
  });

  it("mutinies unpaid gold-paid troops when the donative is unaffordable (§4.4)", () => {
    const state = fresh();
    state.armies = [
      variantArmy("p1", "selymbria", [
        { base: UnitType.INFANTRY, variant: "JANISSARY", count: 4 },
      ]),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 20;
    // Owe 4 gold (4 × 1); hold only 1 → deficit 3 → 3 Janissaries mutiny, 1 stays.
    state.players[0].treasury.gold = 1;
    const out = upkeep(state);
    expect(out.players[0].treasury.gold).toBe(0);
    const inf = out.armies[0].variants!.find((v) => v.variant === "JANISSARY");
    expect(inf?.count).toBe(1);
    // A mutiny/desertion entry is chronicled (unpaid gold donative).
    expect(
      out.log.some((l) => (l.data as { unpaid?: string })?.unpaid === "gold"),
    ).toBe(true);
  });

  it("keeps the mercenary-variant ×2 grain rate intact alongside per-unique overrides", () => {
    const state = fresh();
    // Mix an elite-mercenary VARIANT (Varangian Remnant, no override → base ×2)
    // with a gold-paid unique (Janissary, grain 0 / gold 1) in one force.
    state.armies = [
      variantArmy("p1", "selymbria", [
        { base: UnitType.INFANTRY, variant: "VARANGIAN_REMNANT", count: 2 },
        { base: UnitType.INFANTRY, variant: "JANISSARY", count: 3 },
      ]),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 20;
    state.players[0].treasury.gold = 20;
    const out = upkeep(state);
    // Grain: Varangian 2 × 1 × 2 (merc double) = 4; Janissary 3 × 0 = 0 → 20 − 4 = 16.
    expect(out.players[0].treasury.grain).toBe(16);
    // Gold: Janissary 3 × 1 donative = 3; Varangian owes none → 20 − 3 = 17.
    expect(out.players[0].treasury.gold).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// §4.3 GOLD → RESOURCE market conversion (buy grain/timber/marble WITH gold)
// Already supported by applyTrade's direction-agnostic CONVERT ratio; these
// tests confirm the §4.3 gold→resource direction at 3:1 base / 2:1 with Market.
// ---------------------------------------------------------------------------

describe("upkeep — faction-scoped base-LEVY grain lever (Ottoman devshirme, PR #11 @d332061)", () => {
  it("an OTTOMAN player's base levies owe 0 grain upkeep (devshirme)", () => {
    const state = fresh();
    // p2 is OTTOMAN — the FACTION_LEVY_ECONOMY[OTTOMAN].grainUpkeep = 0 holder.
    // Fielded on FOREIGN soil (selymbria is p1-owned) so the §6.1 home-province
    // exemption cannot mask the devshirme lever being tested.
    state.armies = [army("p2", "selymbria", { [UnitType.LEVY]: 3 })];
    state.fleets = [];
    state.players[1].treasury.grain = 5;
    const out = upkeep(state);
    // 0 grain owed (the base rate would have drawn 3 × 1 = 3, leaving 2). The
    // explicit-0 override wins (`??`), so nothing is drawn from grain stores...
    expect(out.players[1].treasury.grain).toBe(5);
    // ...and with no deficit no levy deserts — the whole stack survives.
    expect(out.armies[0].units[UnitType.LEVY]).toBe(3);
  });

  it("a non-Ottoman player's base levies still owe the base 1 grain each", () => {
    const state = fresh();
    // p1 is BYZANTIUM (no lever) — its FIELD levies pay the plain UNIT_STATS base
    // rate (edirne is p2-owned; §6.1 exempts only home garrisons).
    state.armies = [army("p1", "edirne", { [UnitType.LEVY]: 3 })];
    state.fleets = [];
    state.players[0].treasury.grain = 5;
    const out = upkeep(state);
    expect(out.players[0].treasury.grain).toBe(5 - 3); // 2 — base 1 grain/levy
    expect(out.armies[0].units[UnitType.LEVY]).toBe(3);
  });

  it("Ottoman devshirme levies never desert for grain; other units still starve (shortfall/desertion intact)", () => {
    const state = fresh();
    // p2 (OTTOMAN) fields 2 base levies (0 grain each) + 1 INFANTRY (base 1
    // grain) on FOREIGN soil (selymbria is p1-owned — devshirme, not §6.1 home).
    state.armies = [
      army("p2", "selymbria", { [UnitType.LEVY]: 2, [UnitType.INFANTRY]: 1 }),
    ];
    state.fleets = [];
    // due = 2 × 0 (devshirme levy) + 1 × 1 (infantry) = 1; no grain → deficit 1.
    state.players[1].treasury.grain = 0;
    const out = upkeep(state);
    const a = out.armies[0];
    // The 0-grain levies relieve nothing, so they are NOT culled; the INFANTRY —
    // the only unit that actually owes grain — starves to clear the 1-grain deficit.
    expect(a.units[UnitType.LEVY]).toBe(2); // devshirme levies spared
    expect(a.units[UnitType.INFANTRY]).toBe(0); // starved to cover the deficit
    expect(out.players[1].treasury.grain).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §6.1 LEVY "no map upkeep in home province" (minors list economy.ts:478;
// balance UNIT_STATS[LEVY].special "no-home-upkeep" tag)
// ---------------------------------------------------------------------------

describe("upkeep — §6.1 LEVY no-home-upkeep (home garrison owes 0 grain)", () => {
  it("a LEVY garrisoning its owner's HOME province owes 0 grain (and never starves)", () => {
    const state = fresh();
    // selymbria is p1-owned: home garrison for p1's militia.
    state.armies = [army("p1", "selymbria", { [UnitType.LEVY]: 3 })];
    state.fleets = [];
    state.players[0].treasury.grain = 5;
    const out = upkeep(state);
    // DELTA: nothing drawn (the field rate would take 3, leaving 2)...
    expect(out.players[0].treasury.grain).toBe(5);
    // ...and the whole stack survives.
    expect(out.armies[0].units[UnitType.LEVY]).toBe(3);
  });

  it("the SAME levies in the FIELD pay the base 1 grain each (§6.1 exempts only home)", () => {
    const state = fresh();
    // edirne is p2-owned: p1's levies campaign abroad.
    state.armies = [army("p1", "edirne", { [UnitType.LEVY]: 3 })];
    state.fleets = [];
    state.players[0].treasury.grain = 5;
    const out = upkeep(state);
    expect(out.players[0].treasury.grain).toBe(2); // 5 − 3×1
    expect(out.armies[0].units[UnitType.LEVY]).toBe(3);
  });

  it("NEUTRAL soil is not home: the levy still pays", () => {
    const state = fresh();
    state.provinces.find((p) => p.id === "selymbria")!.ownerId = null;
    state.armies = [army("p1", "selymbria", { [UnitType.LEVY]: 2 })];
    state.fleets = [];
    state.players[0].treasury.grain = 5;
    const out = upkeep(state);
    expect(out.players[0].treasury.grain).toBe(3); // 5 − 2×1
  });

  it("home levies (0 relief) are never culled to cover another unit's deficit", () => {
    const state = fresh();
    // 2 home levies (owe 0) + 1 INFANTRY (owes 1) at p1-owned selymbria, grain 0.
    state.armies = [
      army("p1", "selymbria", { [UnitType.LEVY]: 2, [UnitType.INFANTRY]: 1 }),
    ];
    state.fleets = [];
    state.players[0].treasury.grain = 0; // due 1 → deficit 1
    const out = upkeep(state);
    const a = out.armies[0];
    // The desertion ledger mirrors the bill: the 0-grain home levies relieve
    // nothing and are spared; the INFANTRY that actually owes grain starves.
    expect(a.units[UnitType.LEVY]).toBe(2);
    expect(a.units[UnitType.INFANTRY]).toBe(0);
  });

  it("composes with Ottoman devshirme WITHOUT double-application (0 at home AND in the field)", () => {
    const state = fresh();
    // p2 (OTTOMAN) fields levies at HOME (edirne) and ABROAD (selymbria, p1's).
    state.armies = [
      army("p2", "edirne", { [UnitType.LEVY]: 2 }),
      { ...army("p2", "selymbria", { [UnitType.LEVY]: 2 }), id: "a-p2-field" },
    ];
    state.fleets = [];
    state.players[1].treasury.grain = 5;
    const out = upkeep(state);
    // Devshirme (field) + home exemption (home) each resolve to 0 exactly once —
    // the levers never stack into a negative bill or phantom relief.
    expect(out.players[1].treasury.grain).toBe(5);
    expect(out.armies[0].units[UnitType.LEVY]).toBe(2);
    expect(out.armies[1].units[UnitType.LEVY]).toBe(2);
  });

  it("computeIncome's grain SHORTFALL projection honours the home exemption", () => {
    const home = fresh();
    // Zero all grain yields so the shortfall projection exposes the raw bill.
    for (const p of home.provinces) p.yields = { ...p.yields, grain: 0 };
    home.armies = [army("p1", "selymbria", { [UnitType.LEVY]: 3 })];
    home.fleets = [];
    home.players[0].treasury.grain = 0;
    const field = structuredClone(home) as GameState;
    field.armies[0].locationId = "edirne";
    expect(computeIncome(home).shortfall.p1).toBe(0); // home garrison: 0 due
    expect(computeIncome(field).shortfall.p1).toBe(3); // same host abroad: 3 due
  });
});

describe("applyTrade CONVERT — §4.3 gold→resource direction (turtle archetype)", () => {
  it("buys grain WITH gold at the base 3:1 ratio (no infrastructure)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 6, grain: 0, timber: 0, marble: 0, faith: 0 };
    const out = applyTrade(state, convert("p1", { gold: 3 }, { grain: 1 }));
    expect(out.players[0].treasury.gold).toBe(3); // 3 gold spent
    expect(out.players[0].treasury.grain).toBe(1); // 1 grain bought
  });

  it("rejects buying grain with under-paid gold at the base 3:1 (2 gold < 3)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 6, grain: 0, timber: 0, marble: 0, faith: 0 };
    expect(() => applyTrade(state, convert("p1", { gold: 2 }, { grain: 1 }))).toThrow(
      EngineError,
    );
  });

  it("buys grain WITH gold at 2:1 with a Market building (§4.3)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 6, grain: 0, timber: 0, marble: 0, faith: 0 };
    state.provinces.find((p) => p.id === "selymbria")!.buildings.push(BuildingType.MARKET);
    const out = applyTrade(state, convert("p1", { gold: 2 }, { grain: 1 }));
    expect(out.players[0].treasury.gold).toBe(4); // 2 gold spent at 2:1
    expect(out.players[0].treasury.grain).toBe(1);
  });

  it("buys timber and marble WITH gold too at the base 3:1 (direction generalizes)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 12, grain: 0, timber: 0, marble: 0, faith: 0 };
    const t = applyTrade(state, convert("p1", { gold: 3 }, { timber: 1 }));
    expect(t.players[0].treasury.timber).toBe(1);
    expect(t.players[0].treasury.gold).toBe(9);
    const m = applyTrade(t, convert("p1", { gold: 3 }, { marble: 1 }));
    expect(m.players[0].treasury.marble).toBe(1);
    expect(m.players[0].treasury.gold).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// B1 (§5.2, marshal blocker) — TRADE/ROUTE seaZonePath validation:
// connectivity, endpoint attachment, duplicates, distinct galley backing.
// ---------------------------------------------------------------------------

describe("applyTrade ROUTE — B1 §5.2 seaZonePath validation", () => {
  function withGalley(state: GameState): GameState {
    state.fleets = [galleyFleet("p1", "constantinople")];
    return state;
  }

  it("rejects an EMPTY seaZonePath (BAD_ROUTE_PATH)", () => {
    const state = withGalley(fresh());
    expectEngineCode(
      () => applyTrade(state, route("p1", "constantinople", "selymbria", [])),
      "BAD_ROUTE_PATH",
    );
    // No route was minted — computeIncome carries no route gold.
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13);
  });

  it("rejects an unknown sea zone in the path (BAD_ROUTE_PATH)", () => {
    const state = withGalley(fresh());
    expectEngineCode(
      () => applyTrade(state, route("p1", "constantinople", "selymbria", ["sea-of-nowhere"])),
      "BAD_ROUTE_PATH",
    );
  });

  it("rejects a path whose FIRST zone does not border the from-port (BAD_ROUTE_PATH)", () => {
    const state = withGalley(fresh());
    // thessalonica borders the aegean only — starting in the bosphorus is fabricated geography.
    expectEngineCode(
      () => applyTrade(state, route("p1", "thessalonica", "lemnos", ["bosphorus", "sea-of-marmara", "aegean"])),
      "BAD_ROUTE_PATH",
    );
  });

  it("rejects a path whose LAST zone does not border the to-port (BAD_ROUTE_PATH)", () => {
    const state = withGalley(fresh());
    // The pre-B1 fixture: selymbria borders sea-of-marmara, NOT the bosphorus.
    expectEngineCode(
      () => applyTrade(state, route("p1", "constantinople", "selymbria", ["bosphorus"])),
      "BAD_ROUTE_PATH",
    );
  });

  it("rejects a DISCONNECTED zone chain (BAD_ROUTE_PATH)", () => {
    const state = withGalley(fresh());
    // bosphorus and aegean share no strait (sea-of-marmara lies between them),
    // yet the endpoints attach: cple↔bosphorus, thessalonica↔aegean. Only the
    // chain check catches this — the pre-B1 exploit minted +1/zone off it.
    expectEngineCode(
      () => applyTrade(state, route("p1", "constantinople", "thessalonica", ["bosphorus", "aegean"])),
      "BAD_ROUTE_PATH",
    );
  });

  it("accepts a CONNECTED multi-hop chain and the route then actually pays income", () => {
    const state = withGalley(fresh());
    const before = computeIncome(state).perPlayer.p1.gold; // 13, no routes
    // cple↔sea-of-marmara, marmara↔aegean (Dardanelles), aegean↔thessalonica.
    const out = applyTrade(state, route("p1", "constantinople", "thessalonica", ["sea-of-marmara", "aegean"]));
    const mod = out.activeModifiers.find((m) => m.kind === "trade_route");
    expect(mod?.data?.seaZonePath).toEqual(["sea-of-marmara", "aegean"]);
    // OUTCOME delta: base 2 + portTier(cple HV5)=3 + portTier(thessalonica HV3)=2
    // + 0 controlled hops (no friendly fleet in either zone) = 7 gold/round.
    expect(computeIncome(out).perPlayer.p1.gold).toBe(before + 7);
  });

  it("rejects a duplicate route for the same {from,to} pair (DUP_ROUTE)", () => {
    const state = withGalley(fresh());
    const first = applyTrade(state, route("p1", "constantinople", "selymbria", ["sea-of-marmara"]));
    expectEngineCode(
      () => applyTrade(first, route("p1", "constantinople", "selymbria", ["sea-of-marmara"])),
      "DUP_ROUTE",
    );
    // Still exactly ONE route modifier — the duplicate never landed.
    expect(first.activeModifiers.filter((m) => m.kind === "trade_route")).toHaveLength(1);
  });

  it("rejects the REVERSED pair too — A→B and B→A are the same lane (DUP_ROUTE)", () => {
    const state = withGalley(fresh());
    const first = applyTrade(state, route("p1", "constantinople", "selymbria", ["sea-of-marmara"]));
    expectEngineCode(
      () => applyTrade(first, route("p1", "selymbria", "constantinople", ["sea-of-marmara"])),
      "DUP_ROUTE",
    );
  });

  it("rejects a second route when the only galley already backs one (GALLEY_BUSY)", () => {
    const state = withGalley(fresh()); // exactly one galley fleet
    const first = applyTrade(state, route("p1", "constantinople", "selymbria", ["sea-of-marmara"]));
    // A DIFFERENT port pair, so the dup check passes — but the sole galley is taken.
    expectEngineCode(
      () => applyTrade(first, route("p1", "thessalonica", "lemnos", ["aegean"])),
      "GALLEY_BUSY",
    );
    expect(first.activeModifiers.filter((m) => m.kind === "trade_route")).toHaveLength(1);
  });

  it("backs each route with a DISTINCT galley fleet (B1d): two galleys → two routes, different fleetIds", () => {
    const state = fresh();
    state.fleets = [
      { id: "merchant-1", ownerId: "p1", locationId: "constantinople", units: { ...emptyUnits(), [UnitType.GALLEY]: 1 } },
      { id: "merchant-2", ownerId: "p1", locationId: "thessalonica", units: { ...emptyUnits(), [UnitType.GALLEY]: 1 } },
    ];
    const first = applyTrade(state, route("p1", "constantinople", "selymbria", ["sea-of-marmara"]));
    const second = applyTrade(first, route("p1", "thessalonica", "lemnos", ["aegean"]));
    const mods = second.activeModifiers.filter((m) => m.kind === "trade_route");
    expect(mods).toHaveLength(2);
    const backing = mods.map((m) => m.data?.fleetId);
    expect(new Set(backing).size).toBe(2); // distinct galley per route
    expect(backing).toContain("merchant-1");
    expect(backing).toContain("merchant-2");
  });

  it("does not let a rival's galley back the route (NO_GALLEY when only enemy galleys exist)", () => {
    const state = fresh();
    state.fleets = [galleyFleet("p2", "sea-of-marmara")]; // p2's merchantman, not p1's
    expectEngineCode(
      () => applyTrade(state, route("p1", "constantinople", "selymbria", ["sea-of-marmara"])),
      "NO_GALLEY",
    );
  });
});

// ---------------------------------------------------------------------------
// §5.2 controlled-hop bonus (marshal economy major) — the +1 per controlled sea
// hop requires a FRIENDLY FLEET PRESENT in the zone, not nominal control of
// empty water.
// ---------------------------------------------------------------------------

describe("trade routes — §5.2 controlled hop requires a friendly fleet present", () => {
  it("pays NO hop bonus for empty, unblockaded water", () => {
    const state = fresh();
    state.fleets = []; // nobody at sea
    addRoute(state, "p1", "constantinople", "selymbria", ["sea-of-marmara"]);
    // base 2 + 3 + 1 + 0 controlled = 6 — the empty hop contributes nothing.
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13 + 6);
  });

  it("pays the +1 hop bonus when a friendly war fleet holds the zone", () => {
    const state = fresh();
    state.fleets = [galleyFleet("p1", "sea-of-marmara")]; // friendly galley ON the hop
    addRoute(state, "p1", "constantinople", "selymbria", ["sea-of-marmara"]);
    // base 2 + 3 + 1 + 1 controlled (fleet present) = 7.
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13 + 7);
  });

  it("a RIVAL fleet in the zone does not count as the owner's control", () => {
    const state = fresh();
    state.fleets = [galleyFleet("p2", "sea-of-marmara")]; // enemy fleet, zone NOT blockaded
    addRoute(state, "p1", "constantinople", "selymbria", ["sea-of-marmara"]);
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13 + 6); // no +1 for p1
  });

  it("a blockaded-but-escorted hop is halved and still earns no control bonus", () => {
    const state = fresh();
    state.seaZones.find((z) => z.id === "sea-of-marmara")!.blockadedBy = "p2";
    state.fleets = [galleyFleet("p1", "sea-of-marmara")]; // escort prevents severing
    addRoute(state, "p1", "constantinople", "selymbria", ["sea-of-marmara"]);
    // base 6, blockaded hop never controlled → floor(6 × 0.5) = 3.
    expect(computeIncome(state).perPlayer.p1.gold).toBe(13 + 3);
  });
});

// ---------------------------------------------------------------------------
// AUTHORITY MAJOR (marshal review) — TRADE/CONVERT must reject negative or
// fractional components on BOTH sides (the faith-mint / negative-treasury exploit).
// ---------------------------------------------------------------------------

describe("applyTrade CONVERT — negative/fractional component guard (authority major)", () => {
  it("rejects the faith-mint exploit: a NEGATIVE faith give would CREDIT faith (BAD_TRADE)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 20, grain: 0, timber: 0, marble: 0, faith: 0 };
    // Pre-guard: giveTotal = 12 − 9 = 3 satisfies the 3:1 ratio for 1 grain, the
    // faith>0 gate never sees a negative, and `treasury.faith -= (−9)` MINTS 9 faith.
    expectEngineCode(
      () => applyTrade(state, convert("p1", { gold: 12, faith: -9 }, { grain: 1 })),
      "BAD_TRADE",
    );
    // OUTCOME: nothing minted, nothing spent — the input state is untouched.
    expect(state.players[0].treasury.faith).toBe(0);
    expect(state.players[0].treasury.gold).toBe(20);
  });

  it("rejects a NEGATIVE get component (would drain a resource below zero) (BAD_TRADE)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 20, grain: 0, timber: 5, marble: 0, faith: 0 };
    // getTotal = 4 − 3 = 1 clears the old ratio check while timber goes negative.
    expectEngineCode(
      () => applyTrade(state, convert("p1", { gold: 3 }, { grain: 4, timber: -3 })),
      "BAD_TRADE",
    );
    expect(state.players[0].treasury.timber).toBe(5);
  });

  it("rejects FRACTIONAL amounts on either side (BAD_TRADE)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 20, grain: 0, timber: 0, marble: 0, faith: 0 };
    expectEngineCode(
      () => applyTrade(state, convert("p1", { gold: 1.5 }, { grain: 0.5 })),
      "BAD_TRADE",
    );
    expectEngineCode(
      () => applyTrade(state, convert("p1", { gold: 3 }, { grain: 0.5 })),
      "BAD_TRADE",
    );
    expect(state.players[0].treasury.gold).toBe(20);
  });

  it("still accepts an honest all-positive integer conversion", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 20, grain: 0, timber: 0, marble: 0, faith: 0 };
    const out = applyTrade(state, convert("p1", { gold: 3 }, { grain: 1 }));
    expect(out.players[0].treasury.gold).toBe(17);
    expect(out.players[0].treasury.grain).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §9.1 wall BUILD cap (marshal economy major) — ordinary BUILD tops out at T3;
// T5 remains the Theodosian Walls GREAT WORK's exclusive path.
// ---------------------------------------------------------------------------

describe("applyBuild WALLS — §9.1 MAX_BUILDABLE_WALL_TIER cap", () => {
  it("still allows the ordinary ladder up to T3 (Walls Lv2)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 50, grain: 0, timber: 0, marble: 50, faith: 0 };
    const prov = state.provinces.find((p) => p.id === "selymbria")!;
    prov.walls = { tier: 2, hp: 6 };
    const out = applyBuild(state, build("p1", "selymbria", { building: BuildingType.WALLS }));
    const walls = out.provinces.find((p) => p.id === "selymbria")!.walls;
    expect(walls.tier).toBe(3);
    expect(walls.hp).toBe(10); // WALL_TIERS[3].hp under the 5-tier keyspace
  });

  it("rejects raising T3 walls to T4 by ordinary BUILD (WALL_TIER_CAP)", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 50, grain: 0, timber: 0, marble: 50, faith: 0 };
    const prov = state.provinces.find((p) => p.id === "selymbria")!;
    prov.walls = { tier: 3, hp: 10 };
    expectEngineCode(
      () => applyBuild(state, build("p1", "selymbria", { building: BuildingType.WALLS })),
      "WALL_TIER_CAP",
    );
    // OUTCOME: the walls did not move and nothing was paid.
    expect(state.provinces.find((p) => p.id === "selymbria")!.walls.tier).toBe(3);
    expect(state.players[0].treasury.gold).toBe(50);
  });

  it("the Theodosian Walls GREAT WORK still reaches T5 — and further BUILD is capped", () => {
    const state = fresh();
    state.players[0].treasury = { gold: 80, grain: 0, timber: 0, marble: 80, faith: 0 };
    const gw = { greatWork: GreatWorkType.THEODOSIAN_WALLS }; // rounds 2
    const r1 = applyBuild(state, build("p1", "selymbria", gw));
    const r2 = applyBuild(r1, build("p1", "selymbria", gw));
    const prov = r2.provinces.find((p) => p.id === "selymbria")!;
    expect(prov.walls.tier).toBe(5); // §9.2 great-work path unaffected by the cap
    expect(prov.walls.hp).toBe(16);
    // Ordinary BUILD can never push beyond the great work's T5 either.
    expectEngineCode(
      () => applyBuild(r2, build("p1", "selymbria", { building: BuildingType.WALLS })),
      "WALL_TIER_CAP",
    );
  });
});

// ---------------------------------------------------------------------------
// RULING 1 alignment (answer-key major "RULING 1 over-reaches ratified") —
// Hagia Sophia STARTS INTACT: +2 faith standing from round 1, NOT gated on
// sacked (never-sacked gates only the secret OBJECTIVE, scored in prestige.ts),
// and the HAGIA_SOPHIA great work is prestige-only (adds no faith).
// ---------------------------------------------------------------------------

describe("computeIncome — Hagia Sophia standing +2 faith (RULING 1, ratified reading)", () => {
  it("pays the +2 from ROUND 1 with no great work built (Byzantium faith 9)", () => {
    const state = fresh();
    // constantinople 4 (+2 Hagia Sophia) + thessalonica 2 + morea 1 = 9.
    expect(computeIncome(state).perPlayer.p1.faith).toBe(9);
  });

  it("keeps paying the +2 even after Constantinople is SACKED — never-sacked gates only the objective", () => {
    const state = fresh();
    state.provinces.find((p) => p.id === "constantinople")!.sacked = true;
    // RULING 1: the ratified text gates ONLY the "Faith of the Fathers"
    // OBJECTIVE on never-sacked; the standing income carries no such gate.
    expect(computeIncome(state).perPlayer.p1.faith).toBe(9);
  });

  it("completing the HAGIA_SOPHIA great work adds NO further faith (prestige-only)", () => {
    const state = fresh();
    const cple = state.provinces.find((p) => p.id === "constantinople")!;
    cple.greatWorks.push({ type: GreatWorkType.HAGIA_SOPHIA, progress: 3 }); // complete (rounds 3)
    // Still 9 — no double-count: the great work is a prestige-only endowment.
    expect(computeIncome(state).perPlayer.p1.faith).toBe(9);
  });

  it("the +2 follows Constantinople's controller (standing province yield)", () => {
    const state = fresh();
    const p2Before = computeIncome(state).perPlayer.p2.faith;
    state.provinces.find((p) => p.id === "constantinople")!.ownerId = "p2";
    const out = computeIncome(state);
    // p2 gains the listed faith 4 PLUS the standing Hagia Sophia +2.
    expect(out.perPlayer.p2.faith).toBe(p2Before + 4 + 2);
    // p1 loses the whole Constantinople faith stream.
    expect(out.perPlayer.p1.faith).toBe(9 - 4 - 2);
  });
});

// ---------------------------------------------------------------------------
// §8.4 Great Bombard upkeep + silence (marshal major "GB grain upkeep 1 not 3
// + no silence-when-unpaid"). CONSUMPTION lens: every test asserts a STATE
// DELTA (grain drained, silenced flag combat.ts consumes, unit survival) —
// never merely that something was posted.
// ---------------------------------------------------------------------------

/** The singleton Great Bombard piece, as events/cards.ts emplaces it (§8.4). */
function bombardArmy(ownerId: string, locationId: string): Army {
  return {
    id: "army-great-bombard", // fixed id — exactly one exists per game
    ownerId,
    locationId,
    units: { ...emptyUnits() },
    variants: [{ base: UnitType.SIEGE, variant: GREAT_BOMBARD.variant, count: 1 }],
  };
}

/** Point the canonical `GameState.greatBombard` tracker at an in-play gun. */
function trackBombard(state: GameState, ownerId: string, provinceId: string): void {
  state.greatBombard = { inPlay: true, ownerId, provinceId, emplacedRound: state.round };
}

/** The gun's silence-transition chronicle entries (data.greatBombard). */
function bombardLogs(state: GameState, silenced: boolean) {
  return state.log.filter((l) => {
    const d = l.data as { greatBombard?: boolean; silenced?: boolean } | undefined;
    return d?.greatBombard === true && d.silenced === silenced;
  });
}

describe("upkeep — §8.4 Great Bombard upkeep + silence (marshal major)", () => {
  it("charges the owner EXACTLY GREAT_BOMBARD.grainUpkeep (3) — never the base SIEGE 1, never twice", () => {
    const state = fresh();
    state.armies = [bombardArmy("p2", "edirne")];
    state.fleets = [];
    trackBombard(state, "p2", "edirne");
    state.players[1].treasury.grain = 10;
    const out = upkeep(state);
    // DELTA: 10 − 3 = 7. The pre-fix consumer billed the base SIEGE row (1 →
    // would leave 9); a double-charge (variant ledger + dedicated pass) would
    // take 4 (→ 6). Only the reconciled single 3-grain charge leaves 7.
    expect(out.players[1].treasury.grain).toBe(7);
    // Paid → the gun stays LIVE (no silence flag for combat to consume)...
    expect(out.greatBombard?.silenced ?? false).toBe(false);
    // ...and the unique piece is untouched.
    expect(out.armies[0].variants).toEqual([
      { base: UnitType.SIEGE, variant: GREAT_BOMBARD.variant, count: 1 },
    ]);
  });

  it("bills the gun ONLY via the tracker: variant head alone (not in play) owes nothing (no base-SIEGE leak)", () => {
    const state = fresh();
    state.armies = [bombardArmy("p2", "edirne")];
    state.fleets = [];
    // Tracker stays the createInitialState default: NOT in play. The old code
    // still billed this variant head 1 grain through the §4.4 variant ledger.
    expect(state.greatBombard?.inPlay).toBe(false);
    state.players[1].treasury.grain = 10;
    const out = upkeep(state);
    expect(out.players[1].treasury.grain).toBe(10); // DELTA: zero, not −1
  });

  it("SILENCES (never destroys) the gun when the owner cannot pay: all-or-nothing, grain floor respected", () => {
    const state = fresh();
    state.armies = [bombardArmy("p2", "edirne")];
    state.fleets = [];
    trackBombard(state, "p2", "edirne");
    state.players[1].treasury.grain = 2; // < 3: cannot pay this round
    const out = upkeep(state);
    // The flag combat.ts CONSUMES (rolls no bombardment/assault dice) is set.
    expect(out.greatBombard?.silenced).toBe(true);
    // All-or-nothing: no partial drain — grain stays 2 (and never negative).
    expect(out.players[1].treasury.grain).toBe(2);
    // §8.4 "never deserts": the piece survives intact — no destruction, no cull.
    expect(out.armies).toHaveLength(1);
    expect(out.armies[0].variants).toEqual([
      { base: UnitType.SIEGE, variant: GREAT_BOMBARD.variant, count: 1 },
    ]);
    // The silencing is chronicled.
    expect(bombardLogs(out, true)).toHaveLength(1);
  });

  it("paying in a LATER round clears silenced (the gun may fire again)", () => {
    const state = fresh();
    state.armies = [bombardArmy("p2", "edirne")];
    state.fleets = [];
    trackBombard(state, "p2", "edirne");
    state.players[1].treasury.grain = 0;
    const starved = upkeep(state);
    expect(starved.greatBombard?.silenced).toBe(true); // round N: unpaid → silent
    // Round N+1: the owner banks grain and the upkeep is paid.
    starved.players[1].treasury.grain = 5;
    const paid = upkeep(starved);
    expect(paid.greatBombard?.silenced).toBe(false); // DELTA: flag cleared...
    expect(paid.players[1].treasury.grain).toBe(2); // ...for exactly 3 grain
    // The gun is still the same single intact piece.
    expect(paid.armies[0].variants?.[0]?.count).toBe(1);
    // The un-silencing is chronicled.
    expect(bombardLogs(paid, false)).toHaveLength(1);
  });

  it("stays silenced while STILL unpaid — one silencing chronicle, no flip-flop", () => {
    const state = fresh();
    state.armies = [bombardArmy("p2", "edirne")];
    state.fleets = [];
    trackBombard(state, "p2", "edirne");
    state.players[1].treasury.grain = 0;
    const r1 = upkeep(state);
    const r2 = upkeep(r1); // second round, still no grain
    expect(r2.greatBombard?.silenced).toBe(true);
    expect(bombardLogs(r2, true)).toHaveLength(1); // transition logged ONCE
    expect(bombardLogs(r2, false)).toHaveLength(0); // never un-silenced
    expect(r2.armies[0].variants?.[0]?.count).toBe(1); // still never destroyed
  });

  it("the gun's unpaid bill NEVER converts into unit desertion (host settles first, gun silences)", () => {
    const state = fresh();
    state.armies = [
      bombardArmy("p2", "edirne"),
      army("p2", "edirne", { [UnitType.INFANTRY]: 2 }),
    ];
    state.fleets = [];
    trackBombard(state, "p2", "edirne");
    // Host owes 2 (2 INF × 1); gun owes 3. Grain 4 covers the host but not the
    // gun: the §4.4 settlement pays 2, the residual 2 < 3 silences the gun.
    state.players[1].treasury.grain = 4;
    const out = upkeep(state);
    // DELTA: NO desertion — both infantrymen survive (a ledger that folded the
    // gun's 3 into grainDue would have starved a unit to cover the deficit).
    const host = out.armies.find((a) => a.id === "a-p2")!;
    expect(host.units[UnitType.INFANTRY]).toBe(2);
    expect(out.players[1].treasury.grain).toBe(2); // host paid, gun unpaid
    expect(out.greatBombard?.silenced).toBe(true); // silence, not starvation
    expect(out.armies.find((a) => a.id === "army-great-bombard")?.variants?.[0]?.count).toBe(1);
  });
});
