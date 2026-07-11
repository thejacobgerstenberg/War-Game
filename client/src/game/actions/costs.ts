/**
 * Display-only mirrors of the engine's tuning tables.
 *
 * PROVENANCE: every number below is copied from server/src/engine/balance.ts
 * (UNIT_STATS, BUILDING_COSTS, BUILDING_EFFECTS, WALL_BUILD_COST, WALL_TIERS,
 * GREAT_WORK_COSTS, TAX_MULTIPLIERS, MERC_MARKET, ACTIONS_PER_ROUND) and the
 * ratified tables of docs/GAME_DESIGN.md §4.2/§6.1/§9. The client may NEVER
 * import server code, so these are mirrored as constants for DISPLAY only —
 * the server remains authoritative and rejects anything that drifts.
 * When balance.ts is retuned, re-mirror these values.
 *
 * User-facing names/glosses quote docs/GAME_DESIGN.md (the canon tables) and
 * lore/ui-text.md §7 (the in-voice shortfall lines).
 */
import { BuildingType, GreatWorkType, TaxPosture, UnitType } from "@imperium/shared";
import type { ResourceBundle } from "@imperium/shared";

export type CostBundle = Partial<ResourceBundle>;

/** The five stores, in the Treasury's display order. */
export const RESOURCE_KEYS = [
  "gold",
  "grain",
  "timber",
  "marble",
  "faith",
] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

/** Chip words for the five stores (icon + word + count, always all three). */
export const RESOURCE_LABEL: Record<ResourceKey, string> = {
  gold: "Gold",
  grain: "Grain",
  timber: "Timber",
  marble: "Marble",
  faith: "Faith",
};

/** In-voice shortfall lines, verbatim from lore/ui-text.md §7 (1–5). */
export const RESOURCE_SHORT_REASON: Record<ResourceKey, string> = {
  gold: "Not enough gold in the treasury.",
  grain: "The granaries are bare — no grain to spare.",
  timber: "The woodyards are empty — no timber for keel, wall, or engine.",
  marble: "The quarries have given their last — no marble for the work.",
  faith: "The people's faith will not stretch so far.",
};

// ---------------------------------------------------------------------------
// Units (balance.ts UNIT_STATS / docs/GAME_DESIGN.md §6.1)
// ---------------------------------------------------------------------------

/** Raise cost per unit (mirror of UNIT_STATS[type].cost). */
export const UNIT_COST: Record<UnitType, CostBundle> = {
  [UnitType.LEVY]: { gold: 2, grain: 1 },
  [UnitType.INFANTRY]: { gold: 4, grain: 1 },
  [UnitType.ARCHER]: { gold: 3, grain: 1 },
  [UnitType.CAVALRY]: { gold: 6, grain: 2 },
  [UnitType.SIEGE]: { gold: 8, marble: 2, timber: 2 },
  [UnitType.GALLEY]: { gold: 5, timber: 2 },
  [UnitType.WARSHIP]: { gold: 8, timber: 3 },
};

/** Canon unit names (docs/GAME_DESIGN.md §6.1 roster). */
export const UNIT_NAME: Record<UnitType, string> = {
  [UnitType.LEVY]: "Levy",
  [UnitType.INFANTRY]: "Infantry",
  [UnitType.ARCHER]: "Archer",
  [UnitType.CAVALRY]: "Cavalry",
  [UnitType.SIEGE]: "Siege Engine",
  [UnitType.GALLEY]: "Galley",
  [UnitType.WARSHIP]: "Warship",
};

/** Canon unit roles, verbatim from the §6.1 roster table. */
export const UNIT_ROLE: Record<UnitType, string> = {
  [UnitType.LEVY]: "Peasant militia",
  [UnitType.INFANTRY]: "Professional men-at-arms",
  [UnitType.ARCHER]: "Missile troops",
  [UnitType.CAVALRY]: "Knights / sipahi",
  [UnitType.SIEGE]: "Bombards / trebuchets",
  [UnitType.GALLEY]: "War / merchant galley",
  [UnitType.WARSHIP]: "Great galley / carrack",
};

/** Land units in muster-roll order. */
export const LAND_UNITS: readonly UnitType[] = [
  UnitType.LEVY,
  UnitType.INFANTRY,
  UnitType.ARCHER,
  UnitType.CAVALRY,
  UnitType.SIEGE,
];

/** Naval units (need a Shipyard). */
export const NAVAL_UNITS: readonly UnitType[] = [UnitType.GALLEY, UnitType.WARSHIP];

/** Mercenary hire premium (balance.MERC_MARKET): ×1.5 gold, Genoa ×1.0. */
export const MERC_HIRE_GOLD_MULTIPLIER = 1.5;
export const MERC_GENOA_GOLD_MULTIPLIER = 1.0;

// ---------------------------------------------------------------------------
// Buildings (balance.ts BUILDING_COSTS/BUILDING_EFFECTS / GAME_DESIGN §9.1)
// ---------------------------------------------------------------------------

export const BUILDING_COST: Record<BuildingType, CostBundle> = {
  [BuildingType.BARRACKS]: { gold: 4, timber: 2 },
  [BuildingType.MARKET]: { gold: 4, marble: 2 },
  [BuildingType.GRANARY]: { gold: 4, timber: 3 },
  [BuildingType.SHIPYARD]: { gold: 6, timber: 4 },
  [BuildingType.TEMPLE]: { gold: 5, marble: 3, faith: 1 },
  [BuildingType.WALLS]: { gold: 5, marble: 4 },
  [BuildingType.UNIVERSITY]: { gold: 10, marble: 4, faith: 2 },
};

/** Display names (GAME_DESIGN §9.1; TEMPLE is the faith building). */
export const BUILDING_NAME: Record<BuildingType, string> = {
  [BuildingType.BARRACKS]: "Barracks",
  [BuildingType.MARKET]: "Market",
  [BuildingType.GRANARY]: "Granary",
  [BuildingType.SHIPYARD]: "Shipyard",
  [BuildingType.TEMPLE]: "Church / Mosque",
  [BuildingType.WALLS]: "Walls",
  [BuildingType.UNIVERSITY]: "University",
};

/** Effect glosses, quoted from the GAME_DESIGN §9.1 table. */
export const BUILDING_GLOSS: Record<BuildingType, string> = {
  [BuildingType.BARRACKS]: "Enables land recruitment in this province",
  [BuildingType.MARKET]: "Trade ratio 2:1; +1 gold each round here",
  [BuildingType.GRANARY]: "+2 grain storage; +2 siege hold-out rounds",
  [BuildingType.SHIPYARD]: "Build galleys and warships here; +1 fleet cap",
  [BuildingType.TEMPLE]: "+1 faith each round; defenders here gain +1 morale",
  [BuildingType.WALLS]: "Raise the fortification tier",
  [BuildingType.UNIVERSITY]: "+1 tactic-card draw each round; minor prestige",
};

/** Buildings in the build-sheet order (WALLS handled as its own row). */
export const BUILDING_ORDER: readonly BuildingType[] = [
  BuildingType.BARRACKS,
  BuildingType.MARKET,
  BuildingType.GRANARY,
  BuildingType.SHIPYARD,
  BuildingType.TEMPLE,
  BuildingType.UNIVERSITY,
];

// ---------------------------------------------------------------------------
// Walls (balance.ts WALL_BUILD_COST / WALL_TIERS — five MAP tiers)
// ---------------------------------------------------------------------------

/** Cost to raise the walls TO a given tier (mirror of WALL_BUILD_COST). */
export const WALL_COST: Record<number, CostBundle> = {
  1: { gold: 4, marble: 3 },
  2: { gold: 5, marble: 4 },
  3: { gold: 8, marble: 6 },
  4: { gold: 12, marble: 9 },
  5: { gold: 15, marble: 12 },
};

/** Wall strength per tier (mirror of WALL_TIERS: hp / defender bonus). */
export const WALL_TIER_STATS: Record<number, { hp: number; defBonus: number }> = {
  0: { hp: 0, defBonus: 0 },
  1: { hp: 3, defBonus: 1 },
  2: { hp: 6, defBonus: 2 },
  3: { hp: 10, defBonus: 3 },
  4: { hp: 13, defBonus: 4 },
  5: { hp: 16, defBonus: 4 },
};

export const MAX_WALL_TIER = 5;

// ---------------------------------------------------------------------------
// Great works (balance.ts GREAT_WORK_COSTS / GAME_DESIGN §9.2)
// ---------------------------------------------------------------------------

export interface GreatWorkDisplay {
  name: string;
  cost: CostBundle;
  rounds: number;
  prestige: number;
  /** Effect line from the GAME_DESIGN §9.2 table (RULING 1 trims Hagia Sophia's). */
  gloss: string;
}

export const GREAT_WORK: Record<GreatWorkType, GreatWorkDisplay> = {
  [GreatWorkType.HAGIA_SOPHIA]: {
    name: "Hagia Sophia Repair",
    cost: { gold: 20, marble: 10, faith: 8 },
    rounds: 3,
    prestige: 10,
    gloss: "Unlocks unique Byzantine cards",
  },
  [GreatWorkType.THEODOSIAN_WALLS]: {
    name: "Theodosian Walls",
    cost: { gold: 15, marble: 12 },
    rounds: 2,
    prestige: 6,
    gloss: "Wall tier V: wall HP 16, defender +4",
  },
  [GreatWorkType.GREAT_UNIVERSITY]: {
    name: "Great University",
    cost: { gold: 18, marble: 8, faith: 4 },
    rounds: 3,
    prestige: 6,
    gloss: "+2 tactic-card draws each round; tactic reroll aura",
  },
  [GreatWorkType.GRAND_BAZAAR]: {
    name: "Grand Bazaar",
    cost: { gold: 16, timber: 6, marble: 6 },
    rounds: 2,
    prestige: 5,
    gloss: "Best trade ratio; +3 gold per route from this port",
  },
};

export const GREAT_WORK_ORDER: readonly GreatWorkType[] = [
  GreatWorkType.HAGIA_SOPHIA,
  GreatWorkType.THEODOSIAN_WALLS,
  GreatWorkType.GREAT_UNIVERSITY,
  GreatWorkType.GRAND_BAZAAR,
];

// ---------------------------------------------------------------------------
// Taxation (balance.ts TAX_MULTIPLIERS / GAME_DESIGN §4.2)
// ---------------------------------------------------------------------------

export const TAX_ORDER: readonly TaxPosture[] = [
  TaxPosture.LENIENT,
  TaxPosture.NORMAL,
  TaxPosture.HEAVY,
];

export const TAX_LABEL: Record<TaxPosture, string> = {
  [TaxPosture.LENIENT]: "Lenient",
  [TaxPosture.NORMAL]: "Normal",
  [TaxPosture.HEAVY]: "Heavy",
};

/** Posture lines from the GAME_DESIGN §4.2 table (gold modifier · risk). */
export const TAX_GLOSS: Record<TaxPosture, string> = {
  [TaxPosture.LENIENT]: "×0.75 gold · +1 unrest resistance",
  [TaxPosture.NORMAL]: "×1.0 gold",
  [TaxPosture.HEAVY]: "×1.5 gold · 1-in-6 province revolt check",
};

/** The standing action budget (balance.ACTIONS_PER_ROUND). */
export const ACTIONS_PER_ROUND = 4;

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------

/** Nonzero (resource, amount) entries of a cost bundle, in display order. */
export function costEntries(cost: CostBundle): [ResourceKey, number][] {
  const out: [ResourceKey, number][] = [];
  for (const k of RESOURCE_KEYS) {
    const n = cost[k] ?? 0;
    if (n > 0) out.push([k, n]);
  }
  return out;
}

/** Stores of `cost` the treasury cannot bear, in display order. */
export function shortStores(treasury: ResourceBundle, cost: CostBundle): ResourceKey[] {
  return costEntries(cost)
    .filter(([k, n]) => treasury[k] < n)
    .map(([k]) => k);
}

/** "gold 4, timber 2" — the GAME_DESIGN table notation for a cost. */
export function costText(cost: CostBundle): string {
  return costEntries(cost)
    .map(([k, n]) => `${RESOURCE_LABEL[k].toLowerCase()} ${n}`)
    .join(", ");
}

/** Sum two cost bundles. */
export function addCost(a: CostBundle, b: CostBundle, times = 1): CostBundle {
  const out: CostBundle = { ...a };
  for (const k of RESOURCE_KEYS) {
    const n = (b[k] ?? 0) * times;
    if (n !== 0) out[k] = (out[k] ?? 0) + n;
  }
  return out;
}
