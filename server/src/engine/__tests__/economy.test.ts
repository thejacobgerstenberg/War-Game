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
  it("deserts lowest-value first (LEVY before INFANTRY)", () => {
    const state = fresh();
    state.armies = [army("p1", "selymbria", { [UnitType.LEVY]: 1, [UnitType.INFANTRY]: 1 })];
    state.fleets = [];
    state.players[0].treasury.grain = 1; // due 2, deficit 1 → one LEVY deserts
    const out = upkeep(state);
    const a = out.armies[0];
    expect(a.units[UnitType.LEVY]).toBe(0);
    expect(a.units[UnitType.INFANTRY]).toBe(1); // best defender survives
  });

  it("charges mercenaries double grain upkeep (MERC_UPKEEP_MULTIPLIER)", () => {
    const state = fresh();
    const merc = army("p1", "selymbria", { [UnitType.LEVY]: 2 });
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
    const stack = army("p1", "selymbria", { [UnitType.LEVY]: 1, [UnitType.CAVALRY]: 1 });
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

  it("establishes a route via applyTrade ROUTE with a merchant galley", () => {
    const state = fresh();
    state.fleets = [galleyFleet("p1", "constantinople")];
    const action: TradeAction = {
      type: "TRADE",
      player: "p1",
      trade: {
        kind: "ROUTE",
        fromProvinceId: "constantinople",
        toProvinceId: "selymbria",
        seaZonePath: ["bosphorus"],
      },
    };
    const out = applyTrade(state, action);
    expect(out.activeModifiers.some((m) => m.kind === "trade_route")).toBe(true);
  });

  it("rejects a route with no merchant galley (§5.1)", () => {
    const state = fresh();
    state.fleets = [];
    const action: TradeAction = {
      type: "TRADE",
      player: "p1",
      trade: {
        kind: "ROUTE",
        fromProvinceId: "constantinople",
        toProvinceId: "selymbria",
        seaZonePath: [],
      },
    };
    expect(() => applyTrade(state, action)).toThrow(EngineError);
  });
});

describe("applyIncomePhase — §5.3 piracy", () => {
  it("sinks an unescorted merchant on a 1d6 <= 2 roll, else it survives", () => {
    const state = fresh();
    state.fleets = [galleyFleet("p1", "constantinople")]; // no WARSHIP escort
    addRoute(state, "p1", "constantinople", "selymbria", ["bosphorus"], "f-p1");
    // The very first RNG draw of the Income phase is this route's piracy check.
    const expectedRoll = makeRng(state.rngSeed, state.rngCursor).rollD6();
    const out = applyIncomePhase(state);
    const routeGone = !out.activeModifiers.some((m) => m.kind === "trade_route");
    const fleet = out.fleets.find((f) => f.id === "f-p1");
    if (expectedRoll <= 2) {
      expect(routeGone).toBe(true); // §5.3 sunk → route broken
      expect(fleet?.units[UnitType.GALLEY] ?? 0).toBe(0);
    } else {
      expect(routeGone).toBe(false);
      expect(fleet?.units[UnitType.GALLEY]).toBe(1);
    }
  });

  it("a friendly GALLEY war fleet in the lane escorts and prevents piracy (§5.3, FL-15)", () => {
    const state = fresh();
    state.fleets = [
      galleyFleet("p1", "constantinople"), // merchantman (id f-p1), off-lane
      {
        id: "escort",
        ownerId: "p1",
        locationId: "bosphorus",
        units: { ...emptyUnits(), [UnitType.GALLEY]: 1 }, // GALLEY, not WARSHIP
      },
    ];
    addRoute(state, "p1", "constantinople", "selymbria", ["bosphorus"], "f-p1");
    const out = applyIncomePhase(state);
    // A galley (war fleet per §5.3) escorting the hop prevents the sink outright,
    // regardless of the piracy die → route stays intact and no galley is lost.
    expect(out.activeModifiers.some((m) => m.kind === "trade_route")).toBe(true);
    expect(out.fleets.find((f) => f.id === "f-p1")?.units[UnitType.GALLEY]).toBe(1);
  });

  it("advances and persists the RNG cursor (determinism)", () => {
    const state = fresh();
    const out = applyIncomePhase(state);
    expect(out.rngCursor).toBeGreaterThanOrEqual(state.rngCursor);
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
    state.armies = [army("p1", "selymbria", { [UnitType.LEVY]: 1 })]; // due 1 grain
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
    const stack = army("p1", "selymbria", { [UnitType.LEVY]: 3 });
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
    // One regular LEVY plus one VARANGIAN_REMNANT INFANTRY head.
    state.armies = [
      variantArmy(
        "p1",
        "selymbria",
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
