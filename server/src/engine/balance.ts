/**
 * balance.ts — the SINGLE source of every numeric constant in the engine.
 *
 * This file is pure data: flat exported records keyed by enum, with no logic.
 * The balance-simulation phase will overwrite VALUES here (never structure), so
 * every subsystem must read its constants from these exports rather than
 * hardcoding numbers. Section references point at docs/GAME_DESIGN.md and
 * docs/EVENT_CARDS.md.
 */
import {
  BuildingType,
  Faction,
  GreatWorkType,
  TaxPosture,
  TerrainType,
  UnitType,
  type ResourceBundle,
  type UniqueUnitDef,
} from "@imperium/shared";

// ---------------------------------------------------------------------------
// §3.1 Terrain
// ---------------------------------------------------------------------------

/** Base per-turn yield of each terrain (§3.1). DESERT authored: trade gold, no grain. */
export const TERRAIN_YIELDS: Record<TerrainType, ResourceBundle> = {
  [TerrainType.PLAINS]: { gold: 1, grain: 2, timber: 0, stone: 0, faith: 0 },
  [TerrainType.HILLS]: { gold: 1, grain: 0, timber: 0, stone: 1, faith: 0 },
  [TerrainType.MOUNTAINS]: { gold: 0, grain: 0, timber: 0, stone: 2, faith: 0 },
  [TerrainType.FOREST]: { gold: 0, grain: 1, timber: 2, stone: 0, faith: 0 },
  [TerrainType.COAST]: { gold: 1, grain: 1, timber: 0, stone: 0, faith: 0 },
  [TerrainType.CITY]: { gold: 3, grain: 0, timber: 0, stone: 0, faith: 1 },
  [TerrainType.DESERT]: { gold: 1, grain: 0, timber: 0, stone: 0, faith: 0 },
};

/** Movement point cost to enter a terrain (§3.1). */
export const TERRAIN_MOVE_COST: Record<TerrainType, number> = {
  [TerrainType.PLAINS]: 1,
  [TerrainType.HILLS]: 1,
  [TerrainType.MOUNTAINS]: 2,
  [TerrainType.FOREST]: 1,
  [TerrainType.COAST]: 1,
  [TerrainType.CITY]: 1,
  [TerrainType.DESERT]: 2,
};

/** Defender combat bonus granted by terrain (§3.1 / §7.3). */
export const TERRAIN_DEF_MOD: Record<TerrainType, number> = {
  [TerrainType.PLAINS]: 0,
  [TerrainType.HILLS]: 1,
  [TerrainType.MOUNTAINS]: 1,
  [TerrainType.FOREST]: 1,
  [TerrainType.COAST]: 0,
  [TerrainType.CITY]: 0, // walls provide the city bonus, not terrain
  [TerrainType.DESERT]: 0,
};

// ---------------------------------------------------------------------------
// §6.1 Unit roster
// ---------------------------------------------------------------------------

export interface UnitStat {
  /** Raise cost bundle. */
  cost: Partial<ResourceBundle>;
  /** Grain consumed per unit per round. */
  grainUpkeep: number;
  /** Attack combat value. */
  atk: number;
  /** Defence combat value. */
  def: number;
  /** Movement points. */
  mv: number;
  /** Primary combat value (== atk for hit-rule bookkeeping). */
  combatValue: number;
  /** Fires in the pre-melee ranged step. */
  ranged: boolean;
  /** True for naval units (occupy sea zones). */
  naval: boolean;
  /** Free-form ability tags. */
  special: string[];
}

/** Stat block for all seven generic units (§6.1). */
export const UNIT_STATS: Record<UnitType, UnitStat> = {
  [UnitType.LEVY]: {
    cost: { gold: 2, grain: 1 },
    grainUpkeep: 1,
    atk: 1,
    def: 1,
    mv: 1,
    combatValue: 1,
    ranged: false,
    naval: false,
    special: ["cheap", "no-home-upkeep"],
  },
  [UnitType.INFANTRY]: {
    cost: { gold: 4, grain: 1 },
    grainUpkeep: 1,
    atk: 2,
    def: 3,
    mv: 1,
    combatValue: 2,
    ranged: false,
    naval: false,
    special: ["best-defender"],
  },
  [UnitType.ARCHER]: {
    cost: { gold: 3, grain: 1 },
    grainUpkeep: 1,
    atk: 2,
    def: 1,
    mv: 1,
    combatValue: 2,
    ranged: true,
    naval: false,
    special: ["ranged"],
  },
  [UnitType.CAVALRY]: {
    cost: { gold: 6, grain: 2 },
    grainUpkeep: 2,
    atk: 3,
    def: 2,
    mv: 2,
    combatValue: 3,
    ranged: false,
    naval: false,
    special: ["charge-plains", "pursuit"],
  },
  [UnitType.SIEGE]: {
    cost: { gold: 8, stone: 2, timber: 2 },
    grainUpkeep: 1,
    atk: 0, // no offensive field dice
    def: 1,
    mv: 1,
    combatValue: 0,
    ranged: true, // fires in siege bombardment
    naval: false,
    special: ["no-field-dice", "bombard", "+3-vs-walls"],
  },
  [UnitType.GALLEY]: {
    cost: { gold: 5, timber: 2 },
    grainUpkeep: 1,
    atk: 2,
    def: 2,
    mv: 2,
    combatValue: 2,
    ranged: false,
    naval: true,
    special: ["transport-1-army", "merchantman"],
  },
  [UnitType.WARSHIP]: {
    cost: { gold: 8, timber: 3 },
    grainUpkeep: 1,
    atk: 3,
    def: 3,
    mv: 2,
    combatValue: 3,
    ranged: false,
    naval: true,
    special: ["blockade", "escort"],
  },
};

/** Desertion order under starvation: lowest value deserts first (§4.4). */
export const DESERTION_ORDER: UnitType[] = [
  UnitType.LEVY,
  UnitType.ARCHER,
  UnitType.INFANTRY,
  UnitType.CAVALRY,
  UnitType.SIEGE,
];

/** Mercenaries eat double grain and desert first when unpaid (§4.4 / §6.2). */
export const MERC_UPKEEP_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Unique units (10 named) — modelled as base UnitType + stat deltas (§FACTIONS)
// ---------------------------------------------------------------------------

/**
 * Overrides keyed by variant string. Each unique unit is a generic `base` unit
 * with additive combat deltas and ability tags; the reducer resolves a
 * variant's effective stats as UNIT_STATS[base] + these deltas.
 */
export const UNIQUE_UNIT_OVERRIDES: Record<string, UniqueUnitDef> = {
  VARANGIAN_GUARD: {
    variant: "VARANGIAN_GUARD",
    base: UnitType.INFANTRY,
    name: "Varangian Guard",
    faction: Faction.BYZANTIUM,
    defMod: 1,
    abilities: ["elite-wall-defense", "no-rout"],
    recruitProvinces: ["constantinople"],
  },
  GREEK_FIRE_DROMON: {
    variant: "GREEK_FIRE_DROMON",
    base: UnitType.GALLEY,
    name: "Greek-Fire Dromon",
    faction: Faction.BYZANTIUM,
    atkMod: 1,
    abilities: ["burn-besieging-fleet", "anti-fleet"],
    recruitProvinces: ["constantinople", "thessalonica"],
  },
  JANISSARY: {
    variant: "JANISSARY",
    base: UnitType.INFANTRY,
    name: "Janissary",
    faction: Faction.OTTOMAN,
    atkMod: 1,
    abilities: ["assault-bonus", "gold-paid", "mutiny-risk"],
    recruitProvinces: ["edirne", "bursa"],
  },
  GHAZI_AKINCI: {
    variant: "GHAZI_AKINCI",
    base: UnitType.CAVALRY,
    name: "Ghazi Akıncı",
    faction: Faction.OTTOMAN,
    abilities: ["pillage", "ignore-rough-terrain", "screen"],
  },
  STRADIOTI: {
    variant: "STRADIOTI",
    base: UnitType.CAVALRY,
    name: "Stradioti",
    faction: Faction.VENICE,
    defMod: -1,
    abilities: ["embark", "coastal-raid"],
  },
  GREAT_GALLEY: {
    variant: "GREAT_GALLEY",
    base: UnitType.WARSHIP,
    name: "Great Galley (Galeazza)",
    faction: Faction.VENICE,
    atkMod: 1,
    abilities: ["anti-galley", "coastal-siege-support"],
    recruitProvinces: ["venice"],
  },
  GENOESE_CROSSBOWMEN: {
    variant: "GENOESE_CROSSBOWMEN",
    base: UnitType.ARCHER,
    name: "Genoese Crossbowmen",
    faction: Faction.GENOA,
    atkMod: 1,
    defMod: 1,
    abilities: ["ranged", "wall-defense", "sellable"],
  },
  CARRACK: {
    variant: "CARRACK",
    base: UnitType.GALLEY,
    name: "Carrack (Nave)",
    faction: Faction.GENOA,
    defMod: 1,
    abilities: ["heavy-transport", "run-blockade"],
  },
  BLACK_ARMY: {
    variant: "BLACK_ARMY",
    base: UnitType.INFANTRY,
    name: "Black Army (Fekete Sereg)",
    faction: Faction.HUNGARY,
    atkMod: 1,
    abilities: ["open-battle-bonus", "assault-bonus", "gold-paid"],
    recruitProvinces: ["buda"],
  },
  BANDERIAL_KNIGHTS: {
    variant: "BANDERIAL_KNIGHTS",
    base: UnitType.CAVALRY,
    name: "Banderial Knights",
    faction: Faction.HUNGARY,
    atkMod: 1,
    abilities: ["premier-charge", "weak-mountains", "weak-siege"],
  },
};

// ---------------------------------------------------------------------------
// §9 Buildings & Great Works
// ---------------------------------------------------------------------------

/** Build cost per building (§9). WALLS cost is the Lv1 build; see WALL_BUILD_COST. */
export const BUILDING_COSTS: Record<BuildingType, Partial<ResourceBundle>> = {
  [BuildingType.BARRACKS]: { gold: 4, timber: 2 },
  [BuildingType.MARKET]: { gold: 4, stone: 2 },
  [BuildingType.GRANARY]: { gold: 4, timber: 3 },
  [BuildingType.SHIPYARD]: { gold: 6, timber: 4 },
  [BuildingType.TEMPLE]: { gold: 5, stone: 3, faith: 1 },
  [BuildingType.WALLS]: { gold: 5, stone: 4 },
  [BuildingType.UNIVERSITY]: { gold: 10, stone: 4, faith: 2 },
};

export interface BuildingEffect {
  /** Extra flat yield per round from this building. */
  yieldBonus?: Partial<ResourceBundle>;
  /** Market trade ratio override (give per 1 get); 0 = none. */
  tradeRatio?: number;
  /** Extra siege hold-out rounds (Granary). */
  siegeHoldoutBonus?: number;
  /** Extra grain storage capacity. */
  grainStorageBonus?: number;
  /** Extra fleet capacity (Shipyard). */
  fleetCapBonus?: number;
  /** Extra card/omen draws per round (University). */
  drawBonus?: number;
  /** Enables land unit recruitment (Barracks). */
  enablesLandRecruit?: boolean;
  /** Enables naval unit construction (Shipyard). */
  enablesNavalBuild?: boolean;
  /** Free-form ability tags. */
  tags?: string[];
}

/** Passive effect of each completed building (§9). */
export const BUILDING_EFFECTS: Record<BuildingType, BuildingEffect> = {
  [BuildingType.BARRACKS]: { enablesLandRecruit: true },
  [BuildingType.MARKET]: { tradeRatio: 2, yieldBonus: { gold: 1 } },
  [BuildingType.GRANARY]: { grainStorageBonus: 2, siegeHoldoutBonus: 2 },
  [BuildingType.SHIPYARD]: { enablesNavalBuild: true, fleetCapBonus: 1 },
  [BuildingType.TEMPLE]: { yieldBonus: { faith: 1 }, tags: ["morale"] },
  [BuildingType.WALLS]: { tags: ["fortification"] },
  [BuildingType.UNIVERSITY]: { drawBonus: 1, tags: ["prestige-minor"] },
};

export interface GreatWorkDef {
  cost: Partial<ResourceBundle>;
  /** Build actions (rounds) required to complete. */
  rounds: number;
  /** Prestige awarded once, on completion (§13). */
  prestige: number;
  /** Free-form effect tags. */
  effects: string[];
}

/** Great works: cost, build rounds, prestige and effect tags (§9 / §13). */
export const GREAT_WORK_COSTS: Record<GreatWorkType, GreatWorkDef> = {
  [GreatWorkType.HAGIA_SOPHIA]: {
    cost: { gold: 20, stone: 10, faith: 8 },
    rounds: 3,
    prestige: 10,
    effects: ["+2-faith-per-round", "unlock-byzantine-cards"],
  },
  [GreatWorkType.THEODOSIAN_WALLS]: {
    cost: { gold: 15, stone: 12 },
    rounds: 2,
    prestige: 6,
    effects: ["wall-hp-16", "def+4"],
  },
  [GreatWorkType.GREAT_UNIVERSITY]: {
    cost: { gold: 18, stone: 8, faith: 4 },
    rounds: 3,
    prestige: 6,
    effects: ["+2-card-draw-per-round", "tactic-reroll-aura"],
  },
  [GreatWorkType.GRAND_BAZAAR]: {
    cost: { gold: 16, timber: 6, stone: 6 },
    rounds: 2,
    prestige: 5,
    effects: ["best-trade-ratio", "+3-gold-per-port-route"],
  },
};

// ---------------------------------------------------------------------------
// §8 Walls & sieges
// ---------------------------------------------------------------------------

export interface WallTier {
  /** Wall hit points at this tier. */
  hp: number;
  /** Defender combat bonus while HP > 0. */
  defBonus: number;
}

/**
 * HP wall model (§8.1), keyed by HP-model tier:
 *   0 none, 1 Walls Lv1, 2 Walls Lv2, 3 Theodosian.
 * See MAP_WALL_TIER for the MAP.md T1–T5 → HP-tier mapping.
 */
export const WALL_TIERS: Record<number, WallTier> = {
  0: { hp: 0, defBonus: 0 },
  1: { hp: 6, defBonus: 2 },
  2: { hp: 10, defBonus: 3 },
  3: { hp: 16, defBonus: 4 },
};

/**
 * MAP.md siege tiers T1–T5 → HP-model tier (see CONTRACT.md "wall model").
 * T5 (Constantinople) is the Theodosian tier that the Great Bombard targets.
 */
export const MAP_WALL_TIER: Record<number, number> = {
  0: 0,
  1: 1,
  2: 1,
  3: 2,
  4: 2,
  5: 3,
};

/** Cost to build/upgrade walls to a given HP-model tier (§9). */
export const WALL_BUILD_COST: Record<number, Partial<ResourceBundle>> = {
  1: { gold: 5, stone: 4 },
  2: { gold: 8, stone: 6 },
  3: { gold: 15, stone: 12 }, // Theodosian (also a great work)
};

// ---------------------------------------------------------------------------
// §7 Combat modifiers
// ---------------------------------------------------------------------------

/** Combat modifiers and thresholds (§7.1 / §7.3 / §7.5). */
export const COMBAT_MODS = {
  /** Defender bonus in hills/mountains/forest. */
  defensiveTerrain: 1,
  /** Attacker penalty when attacking from a sea zone. */
  amphibiousAttacker: -1,
  /** Cavalry attack bonus when charging on plains. */
  cavalryCharge: 1,
  /** Attacker penalty when assaulting un-breached walls. */
  escalade: -1,
  /** Larger side's per-round bonus when outnumbering at the ratio below. */
  outnumber: 1,
  outnumberRatio: 2,
  /** Hit rule: roll >= clamp(hitBase - cv - mods, hitClampMin, hitClampMax). */
  hitBase: 7,
  hitClampMin: 2,
  hitClampMax: 6,
  /** A side that loses this fraction of its starting stack rolls a rout check. */
  routLossFraction: 0.5,
  /** Rout occurs on a d6 <= this. */
  routThreshold: 3,
} as const;

/** Siege bombardment, garrison starvation and special-bombard values (§8). */
export const SIEGE = {
  /** Wall HP damage per SIEGE unit, indexed by the d6 roll (1..6). */
  bombardDamage: { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3 } as Record<number, number>,
  /** SIEGE units add this to their assault dice vs walls. */
  bombardVsWalls: 3,
  /** Default garrison hold-out rounds before starvation. */
  baseHoldoutRounds: 3,
  /** Extra hold-out rounds with a Granary. */
  granaryBonusRounds: 2,
  /** Units lost per round once starving. */
  starvationLossPerRound: 1,
  /** Byzantine Theodosian Walls auto-repel this many siege rounds. */
  byzantineAutoRepelRounds: 2,
  /** Ottoman Great Bombard damages up to this many T5 wall tiers per round. */
  greatBombardTierDamage: 2,
  /** Walls repair this many HP per round when out of siege. */
  wallRepairPerRound: 1,
} as const;

// ---------------------------------------------------------------------------
// §6.3 Mercenaries
// ---------------------------------------------------------------------------

export interface MercCompanyDef {
  name: string;
  /** Generic units in the company roster. */
  roster: Partial<Record<UnitType, number>>;
  /** Named unique units in the roster (variant key → count). */
  variants?: { base: UnitType; variant: string; count: number }[];
  /** Minimum opening bid, in gold. */
  minBid: number;
  /** Gold cost multiplier when fielded (mercenary premium). */
  goldMultiplier: number;
}

/** Named free companies for the merc bid market (§6.3). */
export const MERC_COMPANIES: Record<string, MercCompanyDef> = {
  CATALAN: {
    name: "Catalan Company",
    roster: { [UnitType.INFANTRY]: 5, [UnitType.ARCHER]: 3 },
    minBid: 12,
    goldMultiplier: 1.5,
  },
  ST_GEORGE: {
    name: "Company of St George",
    roster: { [UnitType.INFANTRY]: 4, [UnitType.CAVALRY]: 3 },
    minBid: 14,
    goldMultiplier: 1.5,
  },
  ALMOGAVARS: {
    name: "The Almogavars",
    roster: { [UnitType.LEVY]: 6, [UnitType.CAVALRY]: 2, [UnitType.SIEGE]: 1 },
    minBid: 10,
    goldMultiplier: 1.5,
  },
  VARANGIAN_REMNANT: {
    name: "Varangian Remnant",
    roster: { [UnitType.INFANTRY]: 4, [UnitType.CAVALRY]: 2 },
    minBid: 16,
    goldMultiplier: 1.5,
  },
};

/** Merc market rules (§6.3). */
export const MERC_MARKET = {
  /** Companies revealed per round (2–3, seeded). */
  minCompaniesPerRound: 2,
  maxCompaniesPerRound: 3,
  /** Minimum bid raise, in whole gold. */
  minBidRaise: 1,
  /** General mercenary gold premium. */
  hireGoldMultiplier: 1.5,
  /** Genoa hires at par. */
  genoaGoldMultiplier: 1.0,
  /** Mercenaries eat 0 grain when raised but ×2 upkeep thereafter. */
  mercUpkeepMultiplier: 2,
  /** Unsold company is hired by a random NPC minor on a d6 <= this. */
  npcHireRoll: 2,
} as const;

// ---------------------------------------------------------------------------
// §4 Economy: tax, market, trade
// ---------------------------------------------------------------------------

/** Gold multiplier per taxation posture (§4.2). */
export const TAX_MULTIPLIERS: Record<TaxPosture, number> = {
  [TaxPosture.LENIENT]: 0.75,
  [TaxPosture.NORMAL]: 1.0,
  [TaxPosture.HEAVY]: 1.5,
};

/** Per-province revolt roll under heavy tax (§4.2). Revolt on d6 <= roll. */
export const TAX_REVOLT = {
  /** Heavy tax: 1-in-6 revolt check per over-taxed province. */
  heavyRevoltRoll: 1,
  /** Lenient tax grants this much unrest resistance. */
  lenientUnrestResist: 1,
} as const;

/** Market conversion ratios, give:get expressed as "give per 1 get" (§4.3). */
export const MARKET_RATIOS = {
  base: 3,
  market: 2,
  port: 2,
  bazaar: 1,
  /** gold↔port specialty. */
  specialty: 1,
} as const;

/** Trade route income formula constants (§5.2). */
export const TRADE = {
  baseRouteGold: 2,
  /** +1 per controlled sea hop. */
  controlledHopBonus: 1,
  /** ×0.5 (round down) if any hop is blockaded. */
  blockadeMultiplier: 0.5,
  /** = 0 if any hop is severed. */
  severedIncome: 0,
  /** ×1.5 (round down) for Venice/Genoa. */
  maritimeMultiplier: 1.5,
  /** Port tiers range 0..3. */
  maxPortTier: 3,
  /** Unescorted merchant sunk on a d6 <= this (piracy). */
  piracySinkRoll: 2,
} as const;

// ---------------------------------------------------------------------------
// §11.5 Vassals & minors
// ---------------------------------------------------------------------------

/** Vassalage bribe/roll/benefit constants (§11.5). */
export const VASSAL = {
  /** Bribe = bribeBase + bribePerGarrison × garrison-unit-count. */
  bribeBase: 8,
  bribePerGarrison: 4,
  /** Vassal on 1d6 + prestige-tier − garrison-tier >= rollTarget. */
  rollTarget: 4,
  /** Standing NAP or marriage bribe grants +1 to the roll. */
  napBonus: 1,
  marriageBribeBonus: 1,
  marriageBribeGold: 4,
  /** Half the bribe is refunded on a failed attempt. */
  failRefundFraction: 0.5,
  /** Vassal tribute = province yields × this each Income. */
  tributeFraction: 0.5,
  /** Free levy call cadence and size. */
  levyEveryRounds: 2,
  levyBase: 2,
  levyPerTier: 1,
  /** Prestige per round from each vassal. */
  prestigePerRound: 1,
  /** Previously-conquered vassal revolts on a d6 <= this per trigger. */
  conqueredRevoltRoll: 2,
} as const;

// ---------------------------------------------------------------------------
// §13 Prestige & victory
// ---------------------------------------------------------------------------

/** Prestige source values (§13.1). Great works keyed by GreatWorkType. */
export const PRESTIGE_VALUES = {
  holdOwnCapitalPerRound: 1,
  holdEnemyCapitalPerRound: 3,
  holdKeyCityPerRound: 1,
  tradeMonopolyPerRound: 2,
  decisiveBattleWin: 1,
  winWar: 3,
  secretObjective: 4,
  royalMarriagePerRound: 2,
  betrayAlliance: -4,
  betrayNap: -2,
  betrayMarriage: -4,
  loseCapital: -3,
  vassalPerRound: 1,
  greatWork: {
    [GreatWorkType.HAGIA_SOPHIA]: 10,
    [GreatWorkType.THEODOSIAN_WALLS]: 6,
    [GreatWorkType.GREAT_UNIVERSITY]: 6,
    [GreatWorkType.GRAND_BAZAAR]: 5,
  } as Record<GreatWorkType, number>,
} as const;

/** Prestige victory threshold by player count (§13.2). */
export const PRESTIGE_THRESHOLDS: Record<number, number> = {
  2: 25,
  3: 30,
  4: 35,
  5: 35,
};

// ---------------------------------------------------------------------------
// §10 Turn structure, spy, stacking
// ---------------------------------------------------------------------------

/** Total rounds in a full game (§13.3). */
export const ROUNDS = 16;

/** Inclusive [firstRound, lastRound] of each era (§10 / EVENT_CARDS). */
export const ERA_BOUNDARIES: Record<1 | 2 | 3, [number, number]> = {
  1: [1, 5],
  2: [6, 10],
  3: [11, 16],
};

/** Base action budget per player per round (§10.0); University/card → +1. */
export const ACTIONS_PER_ROUND = 4;
export const UNIVERSITY_ACTION_BONUS = 1;

/**
 * Omen draw counts (resolves the circular §12/EVENT_CARDS gap). One shared
 * table Omen is drawn and resolved per round; games with >= 4 players also
 * reveal the next card as a telegraphed "gathering omen" (peeked, not resolved).
 */
export const OMEN_DRAW = {
  resolvedPerRound: 1,
  gatheringOmenMinPlayers: 4,
} as const;

/** Spy mission cost, target numbers and failure penalties (§10.7). */
export const SPY = {
  goldCost: 3,
  actionCost: 1,
  /** Base success on a d6 >= baseTarget. */
  baseTarget: 3,
  /** Rival University raises the target by this (harder). */
  universityPenalty: 1,
  /** Byzantium as target resists (+1 to the required roll). */
  byzantiumResist: 1,
  /** Prestige lost when an agent is captured. */
  captureFailPrestige: -1,
  /** Prestige lost when an Incite-Unrest agent is captured. */
  inciteUnrestFailPrestige: -2,
} as const;

/** Per-player stacking limits (§6.4). */
export const STACKING = {
  land: 8,
  city: 12,
  naval: 6,
} as const;

// ---------------------------------------------------------------------------
// Faction starting resource pools (§FACTIONS) — asymmetric.
// ---------------------------------------------------------------------------

/** Turn-1 treasury per faction (FACTIONS.md). */
export const FACTION_STARTING_RESOURCES: Record<Faction, ResourceBundle> = {
  [Faction.BYZANTIUM]: { gold: 5, grain: 4, timber: 1, stone: 2, faith: 5 },
  [Faction.OTTOMAN]: { gold: 6, grain: 7, timber: 3, stone: 3, faith: 2 },
  [Faction.VENICE]: { gold: 9, grain: 4, timber: 5, stone: 3, faith: 1 },
  [Faction.GENOA]: { gold: 8, grain: 3, timber: 4, stone: 3, faith: 1 },
  [Faction.HUNGARY]: { gold: 6, grain: 6, timber: 5, stone: 4, faith: 3 },
};
