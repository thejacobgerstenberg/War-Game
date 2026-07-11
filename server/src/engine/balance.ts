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
  [TerrainType.PLAINS]: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 },
  [TerrainType.HILLS]: { gold: 1, grain: 0, timber: 0, marble: 1, faith: 0 },
  [TerrainType.MOUNTAINS]: { gold: 0, grain: 0, timber: 0, marble: 2, faith: 0 },
  [TerrainType.FOREST]: { gold: 0, grain: 1, timber: 2, marble: 0, faith: 0 },
  [TerrainType.COAST]: { gold: 1, grain: 1, timber: 0, marble: 0, faith: 0 },
  [TerrainType.CITY]: { gold: 3, grain: 0, timber: 0, marble: 0, faith: 1 },
  [TerrainType.DESERT]: { gold: 1, grain: 0, timber: 0, marble: 0, faith: 0 },
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
    cost: { gold: 8, marble: 2, timber: 2 },
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
    // §2.3 economy: gold 6 (base INFANTRY is gold 4). grain-cost/upkeep unchanged.
    cost: { gold: 6 },
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
    // §2.3 economy: gold 5 (base INFANTRY gold 4); donative pay = 1 gold, 0 grain upkeep.
    cost: { gold: 5 },
    goldUpkeep: 1,
    grainUpkeep: 0,
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
    // §2.3 economy: Venice Arsenal timber cost 1 (overrides base timber; gold unchanged).
    cost: { timber: 1 },
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
    // §2.3 economy: gold 5 (base INFANTRY gold 4); gold-paid = 1 gold, 0 grain upkeep.
    cost: { gold: 5 },
    goldUpkeep: 1,
    grainUpkeep: 0,
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
  /**
   * FL-10 — the Varangian Remnant free company's elite heads (§6.3). NOT one of
   * the 10 faction uniques: it is the stat-override backing the `VARANGIAN_REMNANT`
   * variant that `MERC_COMPANIES.VARANGIAN_REMNANT` fields. `defMod:+1` reaches
   * combat's effective-stat lookup (combat.ts uses `def.defMod` on DEFENCE only —
   * `atkMod` is absent, so no attack bonus). `recruitProvinces: []` makes it
   * unrecruitable (fielded via the merc auction only, never RECRUIT). BYZANTIUM is
   * flavour metadata; the auction is faction-agnostic.
   */
  VARANGIAN_REMNANT: {
    variant: "VARANGIAN_REMNANT",
    base: UnitType.INFANTRY,
    name: "Varangian Remnant",
    faction: Faction.BYZANTIUM,
    defMod: 1,
    abilities: ["elite-mercenary", "wall-defense", "no-rout"],
    recruitProvinces: [],
  },
};

// ---------------------------------------------------------------------------
// §9 Buildings & Great Works
// ---------------------------------------------------------------------------

/** Build cost per building (§9). WALLS cost is the Lv1 build; see WALL_BUILD_COST. */
export const BUILDING_COSTS: Record<BuildingType, Partial<ResourceBundle>> = {
  [BuildingType.BARRACKS]: { gold: 4, timber: 2 },
  [BuildingType.MARKET]: { gold: 4, marble: 2 },
  [BuildingType.GRANARY]: { gold: 4, timber: 3 },
  [BuildingType.SHIPYARD]: { gold: 6, timber: 4 },
  [BuildingType.TEMPLE]: { gold: 5, marble: 3, faith: 1 },
  [BuildingType.WALLS]: { gold: 5, marble: 4 },
  [BuildingType.UNIVERSITY]: { gold: 10, marble: 4, faith: 2 },
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
    cost: { gold: 20, marble: 10, faith: 8 },
    rounds: 3,
    prestige: 10,
    // RULING 1: the great work is a PRESTIGE-ONLY restoration/endowment. The
    // historic +2 faith/round is NOT sourced here — it is a STANDING yield of the
    // intact Hagia Sophia at Constantinople from round 1 (see economy.ts §9.2).
    effects: ["unlock-byzantine-cards"],
  },
  [GreatWorkType.THEODOSIAN_WALLS]: {
    cost: { gold: 15, marble: 12 },
    rounds: 2,
    prestige: 6,
    effects: ["wall-hp-16", "def+4"],
  },
  [GreatWorkType.GREAT_UNIVERSITY]: {
    cost: { gold: 18, marble: 8, faith: 4 },
    rounds: 3,
    prestige: 6,
    effects: ["+2-card-draw-per-round", "tactic-reroll-aura"],
  },
  [GreatWorkType.GRAND_BAZAAR]: {
    cost: { gold: 16, timber: 6, marble: 6 },
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
 * Five-tier wall model (§8.1 / CANON #4 — supersedes the previously-frozen
 * collapsed 4-HP-tier model in CONTRACT §9(5)). Keyed directly by the MAP.md
 * siege tier T0..T5, each mapping to a DISTINCT (hp, defBonus):
 *   T0 none, T1 3/+1, T2 6/+2, T3 10/+3, T4 13/+4, T5 16/+4 (Theodosian).
 * The "Walls Lv1 / Lv2" buildings correspond to T2 / T3 (CANON #4). Because the
 * keyspace is now the MAP tier itself, {@link MAP_WALL_TIER} is the identity map
 * and `WallState.tier` stores the MAP tier directly.
 */
export const WALL_TIERS: Record<number, WallTier> = {
  0: { hp: 0, defBonus: 0 },
  1: { hp: 3, defBonus: 1 },
  2: { hp: 6, defBonus: 2 },
  3: { hp: 10, defBonus: 3 },
  4: { hp: 13, defBonus: 4 },
  5: { hp: 16, defBonus: 4 }, // T5 Theodosian (Constantinople)
};

/**
 * MAP.md siege tiers T0..T5 → wall-model tier. Now the IDENTITY map: all five
 * ratified MAP tiers keep their own distinct (hp, defBonus) rather than being
 * folded into 4 HP-tiers (CANON #4 supersedes CONTRACT §9(5)). Kept as an
 * explicit table so `mapData.ts::wall()` and `factions.ts::startingWallState`
 * continue to compose MAP_WALL_TIER → WALL_TIERS unchanged.
 * T5 (Constantinople) is the Theodosian tier that the Great Bombard targets;
 * high-tier prestige (§13.1) is T4–T5 ⇔ tier ≥ 4.
 */
export const MAP_WALL_TIER: Record<number, number> = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
};

/**
 * Cost to build/upgrade walls to a given wall-model tier (§9). Keyed by the
 * 5-tier keyspace; the WALLS building reaches the Lv1/Lv2 tiers (T2/T3) and the
 * two great-fortress tiers (T4/T5) are authored on the map / raised as the
 * Theodosian great work. (Tier progression/gating is subsystem logic in
 * economy.ts — this table only supplies the costs.)
 */
export const WALL_BUILD_COST: Record<number, Partial<ResourceBundle>> = {
  1: { gold: 4, marble: 3 },
  2: { gold: 5, marble: 4 },
  3: { gold: 8, marble: 6 },
  4: { gold: 12, marble: 9 },
  5: { gold: 15, marble: 12 }, // Theodosian (also a great work)
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

// ---------------------------------------------------------------------------
// §7.7 Tactic cards
// ---------------------------------------------------------------------------

/**
 * Max tactic cards a player may hold; discard down to this at Cleanup (§7.7 / CANON).
 * hand limit = 3 per coordinator ratification (CANON); §2.9 table row (4) is stale/GD §7.7 docs error.
 */
export const TACTIC_HAND_LIMIT = 3;

/**
 * Tactic-deck timing/composition constants (§7.7 / CANON clarification 2).
 * The per-design copy DATA lives in `engine/tactics/cards.ts` (tactic agent);
 * these are the deck-wide rules the round loop / combat layer read.
 */
export const TACTIC = {
  /** Cards a player draws each Income phase (before University bonuses). */
  drawPerIncome: 1,
  /** Hand limit (mirrors {@link TACTIC_HAND_LIMIT}); = 3 per coordinator ratification (CANON), §2.9 row (4) is stale. */
  handLimit: 3,
  /** Max tactic cards a side may play per battle ROUND (reactions exempt). */
  maxPlaysPerBattleRound: 1,
  /** University adds this many extra tactic draws per round (§9.1). */
  universityDrawBonus: 1,
  /** Great University adds this many extra tactic draws per round (§9.2). */
  greatUniversityDrawBonus: 2,
  /** Physical deck size once all 24 designs are shipped (48 copies). */
  deckSize: 48,
  /** Unique tactic designs (CANON: 24, incl. `master-founders-hired` rare #8). */
  uniqueDesigns: 24,
} as const;

/**
 * delta 1 (ratified `treason-at-the-gate` tactic). The card may be played ONLY
 * against a besieged walled city whose garrison is `<= maxGarrison`, AND its
 * required "2+ consecutive siege rounds" clock may start no earlier than game
 * round `minGameRound` (early-game treason is disallowed). Consumed by the tactics
 * subsystem when validating/resolving the card (structured so the §2 tuning table
 * can overwrite the values).
 */
export const TREASON_GATE = {
  /** Max defending garrison the card may be played against. */
  maxGarrison: 4,
  /** Earliest game round the consecutive-siege clock may begin. */
  minGameRound: 6,
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
  /**
   * §8.3 masonry cap: max total Wall-HP an ORDINARY siege train (no unlocked
   * Great Bombard) may inflict per round against an INTACT T5/Theodosian wall
   * (whole train, not per unit). A Great Bombard emplaced in the besieging train
   * lifts this cap (see {@link GREAT_BOMBARD.ignoresMasonryCap}). This is a
   * property of the intact wall, NOT of the defender's faction (FL-01).
   */
  t5MasonryCapPerRound: 1,
  /**
   * @deprecated FL-01 / CANON #4: T5 protection is the masonry cap
   * ({@link SIEGE.t5MasonryCapPerRound}), a property of the intact wall — NOT a
   * Byzantine-faction 2-round auto-repel. Retained only so combat.ts still
   * typechecks until the combat agent removes its use; do not key new logic on it.
   */
  byzantineAutoRepelRounds: 2,
  /** Ottoman Great Bombard damages up to this many T5 wall tiers per round. */
  greatBombardTierDamage: 2,
  /** Walls repair this many HP per round when out of siege. */
  wallRepairPerRound: 1,
} as const;

// ---------------------------------------------------------------------------
// §8.4 The Great Bombard — standalone siege engine (the 11th unit), unlock-gated
// ---------------------------------------------------------------------------

/**
 * The Great Bombard (§8.4): one per game, entering only via the Era III Omen
 * `great-bombard-forged` (EVENT_CARDS.md #34). Modelled as a reserved
 * `UnitVariantStack` variant tag (base `SIEGE`), consistent with the 10 faction
 * uniques — it is NOT a `UnitType` member and NOT recruitable. Its per-die wall
 * damage reuses `SIEGE.bombardDamage`; it rolls `bombardDice` dice per round.
 *
 * delta 3 (CANON correction): the piece is SPAWNED directly on event #34 resolution
 * (placed in the Ottoman capital, else auctioned) and tracked on
 * `GameState.greatBombard` — there is NO "unlock then RECRUIT" acquisition path.
 * `recruitable:false`/`onePerGame:true` stay true in the new model; the COMBAT
 * stats (`bombardDice`, `bombardVsWalls`, `ignoresMasonryCap`, `maxWallDamagePerRound`)
 * are UNCHANGED. Only the acquisition/gating semantics changed.
 */
export const GREAT_BOMBARD = {
  /** Reserved {@link UnitVariantStack.variant} tag; base type is SIEGE. */
  variant: "GREAT_BOMBARD",
  base: UnitType.SIEGE,
  /** Free entry — no recruit cost (spawned by the Omen only). */
  cost: {} as Partial<ResourceBundle>,
  /** Grain upkeep/round; if unpaid it falls SILENT (no bombard) — it never deserts. */
  grainUpkeep: 3,
  /** Wall-damage dice rolled per siege round (§8.2 step 2); each uses SIEGE.bombardDamage. */
  bombardDice: 2,
  /** Practical ceiling of Wall HP removed per round (2 dice × up to 3). */
  maxWallDamagePerRound: 6,
  /** Adds this to assault dice vs walls (standard SIEGE +3). */
  bombardVsWalls: 3,
  /** Ignores the T5 masonry cap (§8.3) and un-caps the whole besieging train. */
  ignoresMasonryCap: true,
  /** Exactly one exists per game. */
  onePerGame: true,
  /** Cannot be recruited, rebuilt or duplicated (spawned by event #34 only). */
  recruitable: false,
  /**
   * delta 3: rounds a freshly-placed/relocated Bombard must sit EMPLACED before it
   * may first fire (bombard) — it cannot bombard the round it arrives at a wall.
   * Combat gates the first bombardment on
   * `state.round >= greatBombard.emplacedRound + emplacementRounds`.
   */
  emplacementRounds: 1,
  /**
   * @deprecated delta 3 — the Bombard is no longer "unlocked" for a recruit; event
   * #34 SPAWNS the piece and the events subsystem sets `GameState.greatBombard`.
   * Retained (data-only, not consumed as gating) for provenance / the events log;
   * do not key acquisition on it. The forging card is still EVENT_CARDS.md #34.
   */
  unlockOmenId: "omen-34",
  /** Moves 1 province/round (a full Move action); may NOT enter MOUNTAINS. */
  movePerRound: 1,
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
    // FL-10: the whole company is elite — fielded as named `VARANGIAN_REMNANT`
    // variant stacks (not plain roster units) so combat applies the +1 DEF from
    // UNIQUE_UNIT_OVERRIDES.VARANGIAN_REMNANT. Roster is empty to avoid
    // double-counting; `rosterSize` still totals 6 heads via `variants`.
    roster: {},
    variants: [
      { base: UnitType.INFANTRY, variant: "VARANGIAN_REMNANT", count: 4 },
      { base: UnitType.CAVALRY, variant: "VARANGIAN_REMNANT", count: 2 },
    ],
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

/**
 * delta 5 (unpaid-mercenary desertion). When a mercenary company deserts because
 * its upkeep went unpaid (§4.4), the departing mercs PILLAGE the host province:
 * this much gold is stripped from the province's owner as the mercs sack their way
 * out. A flat magnitude (structured so the §2 tuning table can overwrite it).
 * Consumed by economy.ts (`upkeep`) when it processes an unpaid-merc desertion.
 */
export const MERC_REVOLT_PILLAGE = {
  /** Gold pillaged from the host province owner on unpaid-merc desertion. */
  pillageGold: 2,
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
  /**
   * DA-1 (§4.3, CANON CLARIFICATION 3) — Grand Bazaar GENERAL trade ratio = 2:1
   * (2 give per 1 get), NOT a universal 1:1. The specialty gold↔specialty lane
   * stays 1:1 via `specialty` below; economy.ts `bestMarketRatio` uses this 2:1
   * general ratio and relies on the `specialty` 1:1 for the specialty lane.
   */
  bazaar: 2,
  /** gold↔port specialty (the Grand Bazaar's specialty-lane 1:1). */
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
// §11 Diplomacy
// ---------------------------------------------------------------------------

/**
 * delta 5 (§11 "Casus belli"). Prestige LOST for declaring war WITHOUT a valid
 * justification (a `claim` / `crusade` / `vassal-defense` / `ally-call` on the
 * DECLARE_WAR action). A justified war costs nothing here and additionally grants
 * the §11 casus-belli +1-per-win bonus. Consumed by diplomacy.ts (applied when a
 * DECLARE_WAR resolves with an absent/invalid justification) + actions.ts (validate
 * the claim). Positive magnitude = prestige subtracted.
 */
export const UNJUSTIFIED_WAR_PRESTIGE = 1;

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
  /**
   * §11.5 garrison tier = ⌊garrison-unit-count ÷ garrisonTierDivisor⌋ (FL-05/FL-17).
   * The vassalize roll subtracts this garrison tier, and the free-levy size adds
   * `levyPerTier` per garrison tier — both computed from the divisor, NOT from the
   * authored wall (`minor.tier`) which CANON §11.5 supersedes.
   */
  garrisonTierDivisor: 2,
  /**
   * §11.5 prestige tier = min(prestigeTierCap, ⌊prestige ÷ 10⌋) (FL-16). The
   * vassalize roll adds the CAPPED prestige tier so high-prestige players still
   * roll rather than auto-succeed.
   */
  prestigeTierCap: 2,
  /**
   * @deprecated DA-2 (§11.5, CANON CLARIFICATION 3) — DROPPED. Minors hold no
   * treaties in the model, so a "standing NAP with a minor" is undefined; the
   * clause is removed. Set to 0 so any lingering reader is a no-op; the export is
   * KEPT (=0) so diplomacy.ts still compiles until its agent deletes the use.
   */
  napBonus: 0,
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

/**
 * delta 2 (ratified DIMINISHING trade-monopoly prestige). §13.1's flat "+2/round
 * per monopolised route" is superseded: a player scores `first` prestige for their
 * FIRST monopolised major route/sea each Cleanup and `additional` for EACH further
 * monopoly that round (diminishing, not flat +2 each). Consumed by prestige.ts when
 * scoring the trade-monopoly row. (`PRESTIGE_VALUES.tradeMonopolyPerRound` = 2 is
 * kept for back-compat = the `first` value; prestige.ts should read this block.)
 */
export const MONOPOLY_PRESTIGE = {
  /** Prestige for the first monopolised route/sea this round. */
  first: 2,
  /** Prestige for each additional monopoly beyond the first (diminishing). */
  additional: 1,
} as const;

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

/**
 * §13 conquest prestige track: the conquest-related rows of the §13.1 table,
 * grouped for the prestige subsystem. Battle/war/hold awards mirror the values in
 * {@link PRESTIGE_VALUES}; the walled-city rows are the §13.1 storm/siege awards.
 * See CONTRACT2 for the exact §13 scoring rule these encode.
 */
export const CONQUEST_PRESTIGE = {
  /** Take a walled city (T1+) by storm or siege. */
  takeWalledCity: 2,
  /**
   * A taken city that is T4–T5 scores this instead. With the 5-tier keyspace
   * (CANON #4) `WallState.tier` IS the MAP tier, so "high tier" ⇔ `walls.tier >= 4`
   * (was HP-tier ≥ 2 under the old collapsed model). §13.1 high-tier prestige.
   */
  takeWalledCityHighTier: 3,
  /** Win a decisive battle (attacker or defender wipes/routs the enemy). */
  decisiveBattle: 1,
  /** Win a field battle while outnumbered (stacks with the decisive award). */
  outnumberedWin: 1,
  /** Win a war (force peace, tribute, or vassalage). */
  winWar: 3,
  /** Hold an enemy capital, per round (passive). */
  holdEnemyCapitalPerRound: 3,
} as const;

/**
 * Prestige victory threshold by player count (§13.2). RATIFIED balance §2.13
 * (VICTORY_THRESHOLD_BY_PLAYER_COUNT): the pre-tuning 25/30/35 placeholders are
 * superseded — final prestige sources (conquest rows + monopoly/capital income)
 * raise total inflow far beyond them. Values re-derived empirically per count at
 * the engine-reconciliation config (results/thresholds.json); each sits at
 * ≈14.9–15.3× that count's mean winner accrual/round. The canon §9.2 per-work
 * prestige adoption lowered winner accrual, so the 5-player VICTORY_THRESHOLD
 * fell 80 → 78 (and the pre-reconciliation 72/78/80/80 transcription is
 * superseded by 71/74/76/78). Checked at Cleanup only.
 */
export const PRESTIGE_THRESHOLDS: Record<number, number> = {
  2: 71,
  3: 74,
  4: 76,
  5: 78,
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

/** Base action budget per player per round (§10.0); only certain CARDS → 5. */
export const ACTIONS_PER_ROUND = 4;
/**
 * @deprecated FL-11 / CANON #2 — the University grants a +1 TACTIC-CARD DRAW
 * (see {@link TACTIC.universityDrawBonus}), NOT a 5th action. Only card-posted
 * `action_bonus` modifiers may raise the budget to 5. This constant is now 0 so
 * the still-present `resetActionBudgets` branch in roundLoop.ts is a no-op; the
 * roundLoop agent should delete that branch + this export (one-line removal).
 */
export const UNIVERSITY_ACTION_BONUS = 0;

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
  [Faction.BYZANTIUM]: { gold: 5, grain: 4, timber: 1, marble: 2, faith: 5 },
  [Faction.OTTOMAN]: { gold: 6, grain: 7, timber: 3, marble: 3, faith: 2 },
  [Faction.VENICE]: { gold: 9, grain: 4, timber: 5, marble: 3, faith: 1 },
  [Faction.GENOA]: { gold: 8, grain: 3, timber: 4, marble: 3, faith: 1 },
  [Faction.HUNGARY]: { gold: 6, grain: 6, timber: 5, marble: 4, faith: 3 },
};

/**
 * faction-scoped base-LEVY economy (devshirme / strongest-levies) — balance A/B PR #11 @d332061.
 *
 * A per-faction override on the BASE LEVY unit only (UnitType.LEVY, no unique
 * variant). `cost` merges COMPONENT-WISE over UNIT_STATS[LEVY].cost — a resource
 * PRESENT in the override wins via `??`, absent components fall through to the base
 * (the same merge pattern as the per-unique UNIQUE_UNIT_OVERRIDES `cost`), so a
 * Hungary levy costs gold 1 (override) + grain 1 (base). `grainUpkeep` REPLACES the
 * base LEVY grain upkeep for that faction's base levies (`??` so an explicit 0 —
 * the Ottoman devshirme rate — wins over the base 1). Affects ONLY base LEVY units:
 * never other unit types, never unique variants, never mercenary/variant upkeep.
 * Data-only and tunable — the §2 balance table may overwrite these values.
 */
export const FACTION_LEVY_ECONOMY: Partial<
  Record<Faction, { cost?: Partial<ResourceBundle>; grainUpkeep?: number }>
> = {
  [Faction.OTTOMAN]: { grainUpkeep: 0 },
  [Faction.HUNGARY]: { cost: { gold: 1 } },
};
