/**
 * factions.ts — the asymmetric per-faction start data (docs/FACTIONS.md).
 *
 * This is pure authored data + small pure builders. It encodes, for each of the
 * five great powers:
 *   - the Turn-1 treasury (sourced from balance.FACTION_STARTING_RESOURCES so
 *     there is a single numeric source of truth),
 *   - the starting armies / fleets per province (province ids are canonical
 *     docs/MAP.md kebab ids), including their named unique-unit variants,
 *   - the 10 unique unit profiles (balance.UNIQUE_UNIT_OVERRIDES + FACTIONS.md
 *     ability text),
 *   - the 3 unique faction powers (structured effect tags + prose), and
 *   - the 3 secret objectives (SecretObjective with exact provinceRefs).
 *
 * The builders {@link buildFactionForces} and {@link startingWallState} let
 * gameState.createInitialState consume this data. They are tolerant of the
 * current placeholder map: any authored force whose province is absent from the
 * live board (or not owned by the seated player) is simply skipped, so this data
 * already targets the canonical 55-province map that the Data phase swaps in.
 *
 * Unique units are NOT UnitType enum members: they are a generic `base`
 * UnitType carried as a UnitVariantStack whose stat deltas + abilities live in
 * balance.UNIQUE_UNIT_OVERRIDES (CONTRACT §9.4).
 */
import {
  Faction,
  UnitType,
  type Army,
  type Fleet,
  type Province,
  type ResourceBundle,
  type SecretObjective,
  type UniqueUnitDef,
  type UnitVariantStack,
  type WallState,
} from "@imperium/shared";
import {
  FACTION_STARTING_RESOURCES,
  MAP_WALL_TIER,
  UNIQUE_UNIT_OVERRIDES,
  WALL_TIERS,
} from "./balance.js";

// ---------------------------------------------------------------------------
// Unique unit profiles (10) — balance deltas + FACTIONS.md ability prose
// ---------------------------------------------------------------------------

/** A unique-unit override (from balance) enriched with FACTIONS.md prose. */
export interface UniqueUnitProfile extends UniqueUnitDef {
  /** Human-readable description of the unit and its edge (FACTIONS.md). */
  description: string;
}

/**
 * The 10 named unique units, keyed by variant. Each entry is exactly the
 * balance.UNIQUE_UNIT_OVERRIDES def (base UnitType + atk/def/mv deltas + ability
 * tags + recruit provinces) plus a prose `description`. Effective stats are
 * UNIT_STATS[base] + the deltas; the reducer reads the deltas from balance.
 */
export const FACTION_UNIQUE_UNITS: Record<string, UniqueUnitProfile> = {
  VARANGIAN_GUARD: {
    ...UNIQUE_UNIT_OVERRIDES.VARANGIAN_GUARD,
    description:
      "The emperor's axe-bearing elite guard. Very strong defending a walled " +
      "city; may only be raised in constantinople, is expensive (gold+grain), " +
      "and does not rout while the emperor lives.",
  },
  GREEK_FIRE_DROMON: {
    ...UNIQUE_UNIT_OVERRIDES.GREEK_FIRE_DROMON,
    description:
      "Unique war galley carrying siphon fire: +combat versus enemy fleets and " +
      "can burn a besieging fleet in a friendly port's sea zone. Built only at " +
      "constantinople or thessalonica.",
  },
  JANISSARY: {
    ...UNIQUE_UNIT_OVERRIDES.JANISSARY,
    description:
      "Elite slave-soldiers of the Porte: strong assaulting walls and in open " +
      "battle, but paid only in gold (donative) — if unpaid they grow mutinous. " +
      "Raised at edirne or bursa.",
  },
  GHAZI_AKINCI: {
    ...UNIQUE_UNIT_OVERRIDES.GHAZI_AKINCI,
    description:
      "Cheap light raider cavalry: pillages an adjacent enemy or neutral " +
      "province for gold, ignores rough-terrain movement penalties, and screens " +
      "the main army.",
  },
  STRADIOTI: {
    ...UNIQUE_UNIT_OVERRIDES.STRADIOTI,
    description:
      "Balkan marine light cavalry (Albanian/Greek horsemen) who embark on " +
      "galleys to raid enemy coasts then re-embark. Excellent hit-and-run on " +
      "ports; weak in a stand-up land battle.",
  },
  GREAT_GALLEY: {
    ...UNIQUE_UNIT_OVERRIDES.GREAT_GALLEY,
    description:
      "The Arsenal's masterwork heavy war galley (Galeazza): dominates a sea " +
      "zone, +combat versus ordinary galleys, and carries a bombard for coastal " +
      "siege support.",
  },
  GENOESE_CROSSBOWMEN: {
    ...UNIQUE_UNIT_OVERRIDES.GENOESE_CROSSBOWMEN,
    description:
      "The most sought-after crossbows in Europe: strong ranged combat and wall " +
      "defense. Genoa may sell them to any other faction or neutral for gold, " +
      "earning income whenever they are hired.",
  },
  CARRACK: {
    ...UNIQUE_UNIT_OVERRIDES.CARRACK,
    description:
      "Heavy sailing merchantman (Nave): tough, long-range transport & trade " +
      "ship that hauls more cargo and troops than a galley and can run a " +
      "blockade on a die, keeping the Black Sea lifeline open.",
  },
  BLACK_ARMY: {
    ...UNIQUE_UNIT_OVERRIDES.BLACK_ARMY,
    description:
      "Elite standing gunpowder infantry + handgunners (Fekete Sereg): very " +
      "strong in open battle and assault, paid in gold (no gold, no Black Army).",
  },
  BANDERIAL_KNIGHTS: {
    ...UNIQUE_UNIT_OVERRIDES.BANDERIAL_KNIGHTS,
    description:
      "The barons' armored heavy shock cavalry: devastating charge on plains, " +
      "the map's premier cavalry; less effective in mountains and sieges.",
  },
};

// ---------------------------------------------------------------------------
// Faction powers & starting-force data shapes
// ---------------------------------------------------------------------------

/** One of a faction's three unique powers: structured tags + prose. */
export interface FactionPower {
  /** Stable kebab id. */
  id: string;
  /** Display name. */
  name: string;
  /** Prose description (FACTIONS.md). */
  description: string;
  /** Machine-readable effect tags for subsystems to key on. */
  effects: string[];
  /** Province/neutral ids the power specifically references, if any. */
  provinceRefs?: string[];
}

/**
 * A single authored starting stack. `domain` picks Army (land) vs Fleet
 * (naval); a province that starts with both (e.g. constantinople: infantry +
 * a Golden Horn galley) is expressed as two force defs at the same province.
 */
export interface StartingForceDef {
  provinceId: string;
  domain: "land" | "naval";
  /** Generic units by type. */
  units: Partial<Record<UnitType, number>>;
  /** Named unique-unit variants in this stack. */
  variants?: UnitVariantStack[];
}

/** The full asymmetric start block for one faction. */
export interface FactionStart {
  faction: Faction;
  /** Capital province id (docs/MAP.md). */
  capital: string;
  /** All starting province ids (docs/MAP.md, matches Starting Ownership). */
  provinces: string[];
  /** Turn-1 treasury (sourced from balance.FACTION_STARTING_RESOURCES). */
  treasury: ResourceBundle;
  /** Starting armies/fleets per province, including unique variants. */
  forces: StartingForceDef[];
  /** Variant keys of this faction's two unique units. */
  uniqueUnitKeys: string[];
  /** The three unique powers. */
  powers: FactionPower[];
  /** The three secret objectives (prestige 4 each). */
  objectives: SecretObjective[];
  /**
   * Starting wall tiers keyed by province id, in docs/MAP.md T-tier space
   * (1..5). Applied via MAP_WALL_TIER → HP-model tier by startingWallState.
   */
  startingWalls?: Record<string, number>;
}

/** Prestige awarded by every secret objective (CONTRACT / PRESTIGE_VALUES). */
const OBJECTIVE_PRESTIGE = 4;

// Convenience aliases for authoring the rosters.
const LEVY = UnitType.LEVY;
const INF = UnitType.INFANTRY;
const CAV = UnitType.CAVALRY;
const WAR = UnitType.WARSHIP; // "war galley"
const GAL = UnitType.GALLEY; // "merchant galley"

const v = (base: UnitType, variant: string, count: number): UnitVariantStack => ({
  base,
  variant,
  count,
});

// ---------------------------------------------------------------------------
// The five faction start blocks
// ---------------------------------------------------------------------------

export const FACTION_STARTS: Record<Faction, FactionStart> = {
  // -------------------------------------------------------------- BYZANTIUM
  [Faction.BYZANTIUM]: {
    faction: Faction.BYZANTIUM,
    capital: "constantinople",
    provinces: ["constantinople", "selymbria", "lemnos", "thessalonica", "morea"],
    treasury: { ...FACTION_STARTING_RESOURCES[Faction.BYZANTIUM] },
    startingWalls: { constantinople: 5, thessalonica: 3, morea: 2, lemnos: 1 },
    forces: [
      // constantinople: 2 inf, 1 Varangian Guard, 1 war galley (Golden Horn)
      { provinceId: "constantinople", domain: "land", units: { [INF]: 2 }, variants: [v(INF, "VARANGIAN_GUARD", 1)] },
      { provinceId: "constantinople", domain: "naval", units: { [WAR]: 1 } },
      // thessalonica: 1 inf, 1 levy (behind T3 walls)
      { provinceId: "thessalonica", domain: "land", units: { [INF]: 1, [LEVY]: 1 } },
      // morea: 1 levy
      { provinceId: "morea", domain: "land", units: { [LEVY]: 1 } },
      // lemnos: 1 levy
      { provinceId: "lemnos", domain: "land", units: { [LEVY]: 1 } },
      // selymbria: 1 levy
      { provinceId: "selymbria", domain: "land", units: { [LEVY]: 1 } },
    ],
    uniqueUnitKeys: ["VARANGIAN_GUARD", "GREEK_FIRE_DROMON"],
    powers: [
      {
        id: "theodosian-walls",
        name: "Theodosian Walls",
        description:
          "constantinople starts at wall Tier 5 and auto-repels the first two " +
          "siege rounds each time it is besieged (defenders sally). Only a Great " +
          "Bombard can damage its tier faster than one step per round.",
        effects: ["constantinople-wall-tier-5", "auto-repel-first-2-siege-rounds", "only-great-bombard-breaks-faster"],
        provinceRefs: ["constantinople"],
      },
      {
        id: "hagia-sophia",
        name: "Hagia Sophia",
        description:
          "constantinople yields +2 faith/round on top of its listed yield. " +
          "Byzantium may spend faith to sway Orthodox neutrals toward neutrality " +
          "or alliance instead of paying gold.",
        effects: ["constantinople-+2-faith-per-round", "spend-faith-to-sway-orthodox-neutrals"],
        provinceRefs: ["constantinople", "serbia", "trebizond", "wallachia", "morea", "athens"],
      },
      {
        id: "reconquista-of-the-romans",
        name: "Reconquista of the Romans",
        description:
          "Byzantium holds a standing claim on former imperial cities and pays " +
          "-25% cost to besiege/capture them. It may also bribe an attacker to " +
          "stand down for gold (one round of peace on a single front).",
        effects: ["-25%-siege-cost-vs-claimed-cities", "bribe-attacker-stand-down"],
        provinceRefs: ["nicaea", "bursa", "athens", "trebizond", "thessaly"],
      },
    ],
    objectives: [
      {
        id: "byz-queen-of-cities",
        description: "Queen of Cities: control constantinople at game end (round 16).",
        provinceRefs: ["constantinople"],
        prestige: OBJECTIVE_PRESTIGE,
      },
      {
        id: "byz-restoration-of-the-empire",
        description:
          "Restoration of the Empire: simultaneously control thessalonica, morea, and at " +
          "least one of nicaea / athens.",
        provinceRefs: ["thessalonica", "morea", "nicaea", "athens"],
        prestige: OBJECTIVE_PRESTIGE,
      },
      {
        id: "byz-faith-of-the-fathers",
        description:
          "Faith of the Fathers: hold constantinople (Hagia Sophia intact), finish with >= 15 " +
          "faith banked, having refused Church Union (never resolved Council of Florence in the " +
          "Union's favor).",
        provinceRefs: ["constantinople"],
        prestige: OBJECTIVE_PRESTIGE,
      },
    ],
  },

  // ---------------------------------------------------------------- OTTOMANS
  [Faction.OTTOMAN]: {
    faction: Faction.OTTOMAN,
    capital: "edirne",
    provinces: ["edirne", "gallipoli", "philippopolis", "sofia", "bithynia", "bursa", "nicaea"],
    treasury: { ...FACTION_STARTING_RESOURCES[Faction.OTTOMAN] },
    startingWalls: { edirne: 3, gallipoli: 2, bursa: 3, nicaea: 2 },
    forces: [
      // edirne: 3 levy, 1 cav, 1 Ghazi Akıncı
      { provinceId: "edirne", domain: "land", units: { [LEVY]: 3, [CAV]: 1 }, variants: [v(CAV, "GHAZI_AKINCI", 1)] },
      // bursa: 2 levy, 1 Janissary
      { provinceId: "bursa", domain: "land", units: { [LEVY]: 2 }, variants: [v(INF, "JANISSARY", 1)] },
      // gallipoli: 1 levy, 1 war galley
      { provinceId: "gallipoli", domain: "land", units: { [LEVY]: 1 } },
      { provinceId: "gallipoli", domain: "naval", units: { [WAR]: 1 } },
      // nicaea: 1 levy
      { provinceId: "nicaea", domain: "land", units: { [LEVY]: 1 } },
      // sofia: 1 levy
      { provinceId: "sofia", domain: "land", units: { [LEVY]: 1 } },
      // bithynia: 1 levy
      { provinceId: "bithynia", domain: "land", units: { [LEVY]: 1 } },
      // philippopolis: 1 levy
      { provinceId: "philippopolis", domain: "land", units: { [LEVY]: 1 } },
    ],
    uniqueUnitKeys: ["JANISSARY", "GHAZI_AKINCI"],
    powers: [
      {
        id: "devshirme-and-timariots",
        name: "Devshirme & the Timariots",
        description:
          "Levies cost -1 grain to sustain and can be raised in one turn in any " +
          "owned province. The Ottoman fields the largest, cheapest land army on " +
          "the map.",
        effects: ["levy-upkeep--1-grain", "levy-raise-any-owned-province-one-turn"],
      },
      {
        id: "the-great-bombard",
        name: "The Great Bombard",
        description:
          "From round 6 onward (or immediately via The Great Bombard Forged) the " +
          "Ottoman may build Orban's Great Bombard — a super-siege engine that " +
          "damages even Tier-5 walls by up to 2 tiers/round and is the only " +
          "reliable answer to the Theodosian Walls. Slow, costly, fragile in " +
          "open battle.",
        effects: ["build-great-bombard-from-round-6", "damage-t5-walls-up-to-2-tiers-per-round", "fragile-in-open-battle"],
      },
      {
        id: "ghaza-holy-raid",
        name: "Ghaza (Holy Raid)",
        description:
          "Razzias against neutral beyliks and Christian frontier provinces cost " +
          "-25% and return extra gold plunder; the Ottoman gains a small prestige " +
          "bump each time it takes a new city.",
        effects: ["-25%-raid-cost-vs-neutral-frontier", "extra-gold-plunder", "prestige-on-new-city"],
      },
    ],
    objectives: [
      {
        id: "ott-fetih",
        description:
          "Fetih (The Conquest): capture constantinople and hold it — the supreme prize (also the " +
          "game's sudden-death condition if held two rounds).",
        provinceRefs: ["constantinople"],
        prestige: OBJECTIVE_PRESTIGE,
      },
      {
        id: "ott-sword-of-two-continents",
        description:
          "Sword of Two Continents: simultaneously control gallipoli and bithynia and bursa, plus " +
          "unify Anatolia by holding ankara and konya.",
        provinceRefs: ["gallipoli", "bithynia", "bursa", "ankara", "konya"],
        prestige: OBJECTIVE_PRESTIGE,
      },
      {
        id: "ott-ghazi-empire",
        description:
          "Ghazi Empire: control >= 15 provinces at game end, or sack three high-value cities " +
          "(HV(3)+ nodes) over the course of the game.",
        provinceRefs: [],
        prestige: OBJECTIVE_PRESTIGE,
      },
    ],
  },

  // ------------------------------------------------------------------ VENICE
  [Faction.VENICE]: {
    faction: Faction.VENICE,
    capital: "venice",
    provinces: ["venice", "dalmatia", "corfu", "negroponte", "crete", "modon"],
    treasury: { ...FACTION_STARTING_RESOURCES[Faction.VENICE] },
    startingWalls: { venice: 3, negroponte: 2, corfu: 2, crete: 2, modon: 1, dalmatia: 1 },
    forces: [
      // venice: 3 war galley, 2 merchant galley, 1 Stradioti
      { provinceId: "venice", domain: "naval", units: { [WAR]: 3, [GAL]: 2 } },
      { provinceId: "venice", domain: "land", units: {}, variants: [v(CAV, "STRADIOTI", 1)] },
      // crete: 1 war galley, 1 inf (marine)
      { provinceId: "crete", domain: "naval", units: { [WAR]: 1 } },
      { provinceId: "crete", domain: "land", units: { [INF]: 1 } },
      // negroponte: 1 war galley
      { provinceId: "negroponte", domain: "naval", units: { [WAR]: 1 } },
      // corfu: 1 war galley
      { provinceId: "corfu", domain: "naval", units: { [WAR]: 1 } },
      // modon: 1 merchant galley
      { provinceId: "modon", domain: "naval", units: { [GAL]: 1 } },
      // dalmatia: 1 levy
      { provinceId: "dalmatia", domain: "land", units: { [LEVY]: 1 } },
    ],
    uniqueUnitKeys: ["STRADIOTI", "GREAT_GALLEY"],
    powers: [
      {
        id: "empire-of-trade",
        name: "Empire of Trade",
        description:
          "Venice earns +1 gold per controlled port each round, and +1 gold per " +
          "sea zone kept free of enemy fleets that links two of its ports. " +
          "Merchant galleys moving between owned ports generate gold.",
        effects: ["+1-gold-per-controlled-port", "+1-gold-per-clear-linking-sea-zone", "merchant-galley-route-gold"],
      },
      {
        id: "the-arsenal",
        name: "The Arsenal",
        description:
          "War & merchant galleys cost -1 timber, and Venice may build up to 2 " +
          "fleets per round at venice (others build one). Vulnerable to Fire of " +
          "the Arsenal.",
        effects: ["galley-cost--1-timber", "build-2-fleets-per-round-at-venice"],
        provinceRefs: ["venice"],
      },
      {
        id: "stato-da-mar",
        name: "Stato da Màr (Colonial Administration)",
        description:
          "Island/port colonies yield +1 gold and are -50% garrison cost. Venice " +
          "can blockade an enemy port and wins ties in sea combat.",
        effects: ["colony-+1-gold", "colony--50%-garrison-cost", "blockade-enemy-port", "win-sea-combat-ties"],
        provinceRefs: ["crete", "negroponte", "corfu", "modon", "cyprus", "naxos", "chios"],
      },
    ],
    objectives: [
      {
        id: "ven-stato-da-mar",
        description: "Stato da Màr: control 8 ports, mandatorily including crete, negroponte, and corfu.",
        provinceRefs: ["crete", "negroponte", "corfu"],
        prestige: OBJECTIVE_PRESTIGE,
      },
      {
        id: "ven-monopoly-of-the-straits",
        description:
          "Monopoly of the Straits: control or blockade the bosphorus (hold constantinople/pera, or " +
          "keep a fleet there) and control any 3 Aegean islands (lemnos/lesbos/chios/naxos/negroponte).",
        provinceRefs: ["bosphorus", "constantinople", "pera", "lemnos", "lesbos", "chios", "naxos", "negroponte"],
        prestige: OBJECTIVE_PRESTIGE,
      },
      {
        id: "ven-queen-of-the-adriatic",
        description:
          "Queen of the Adriatic: control every port on the adriatic (venice, dalmatia, corfu, ragusa) " +
          "and either destroy a Genoese fleet or seize a Genoese colony (pera/chios/lesbos/kaffa).",
        provinceRefs: ["adriatic", "venice", "dalmatia", "corfu", "ragusa", "pera", "chios", "lesbos", "kaffa"],
        prestige: OBJECTIVE_PRESTIGE,
      },
    ],
  },

  // ------------------------------------------------------------------- GENOA
  [Faction.GENOA]: {
    faction: Faction.GENOA,
    capital: "genoa",
    provinces: ["genoa", "pera", "chios", "lesbos", "kaffa"],
    treasury: { ...FACTION_STARTING_RESOURCES[Faction.GENOA] },
    startingWalls: { genoa: 3, pera: 1, chios: 1, lesbos: 1, kaffa: 2 },
    forces: [
      // genoa: 2 war galley, 1 merchant galley, 2 Genoese Crossbowmen
      { provinceId: "genoa", domain: "naval", units: { [WAR]: 2, [GAL]: 1 } },
      { provinceId: "genoa", domain: "land", units: {}, variants: [v(UnitType.ARCHER, "GENOESE_CROSSBOWMEN", 2)] },
      // chios: 1 war galley, 1 Genoese Crossbowman
      { provinceId: "chios", domain: "naval", units: { [WAR]: 1 } },
      { provinceId: "chios", domain: "land", units: {}, variants: [v(UnitType.ARCHER, "GENOESE_CROSSBOWMEN", 1)] },
      // kaffa: 1 war galley, 1 levy
      { provinceId: "kaffa", domain: "naval", units: { [WAR]: 1 } },
      { provinceId: "kaffa", domain: "land", units: { [LEVY]: 1 } },
      // pera: 1 Genoese Crossbowman
      { provinceId: "pera", domain: "land", units: {}, variants: [v(UnitType.ARCHER, "GENOESE_CROSSBOWMEN", 1)] },
      // lesbos: 1 levy
      { provinceId: "lesbos", domain: "land", units: { [LEVY]: 1 } },
    ],
    uniqueUnitKeys: ["GENOESE_CROSSBOWMEN", "CARRACK"],
    powers: [
      {
        id: "banco-di-san-giorgio",
        name: "Banco di San Giorgio (Banking)",
        description:
          "Genoa may take an instant loan (gain gold now, repay with interest " +
          "later) and may lend gold to other factions/neutrals, creating a debt " +
          "it can later call in (Genoese Loan Called In) for gold, provinces, or " +
          "prestige.",
        effects: ["instant-loan", "lend-gold-to-others", "call-in-debt"],
      },
      {
        id: "colonies-of-the-black-sea",
        name: "Colonies of the Black Sea",
        description:
          "kaffa and chios are major trade engines — each yields +2 gold and " +
          "Genoa holds a monopoly on alum & mastic (chios) and Pontic grain " +
          "(kaffa). Colonies resupply Genoese fleets at range.",
        effects: ["kaffa-+2-gold", "chios-+2-gold", "alum-mastic-pontic-monopoly", "colony-resupplies-fleets-at-range"],
        provinceRefs: ["kaffa", "chios"],
      },
      {
        id: "mercenary-brokers",
        name: "Mercenary Brokers",
        description:
          "Genoa hires mercenaries at -25% and profits by brokering Crossbowmen " +
          "to others; its fleets get +1 combat when defending a colony's sea zone.",
        effects: ["-25%-mercenary-hire", "broker-crossbowmen-for-gold", "+1-fleet-combat-defending-colony-sea-zone"],
      },
    ],
    objectives: [
      {
        id: "gen-dominium-maris",
        description:
          "Dominium Maris (Black Sea): control kaffa and chios and at least one other Black Sea/Aegean " +
          "port, while keeping black-sea-west/black-sea-east free of enemy blockade at game end.",
        provinceRefs: ["kaffa", "chios", "black-sea-west", "black-sea-east"],
        prestige: OBJECTIVE_PRESTIGE,
      },
      {
        id: "gen-bankers-of-kings",
        description:
          "Bankers of Kings: finish with >= 25 gold banked and have at least two other factions in debt " +
          "to you (outstanding loans), or simply hold the most gold of any player at game end.",
        provinceRefs: [],
        prestige: OBJECTIVE_PRESTIGE,
      },
      {
        id: "gen-overshadow-the-lion",
        description:
          "Overshadow the Lion: hold more ports than Venice at game end, or capture any Venetian colony " +
          "(crete/negroponte/corfu/modon/dalmatia).",
        provinceRefs: ["crete", "negroponte", "corfu", "modon", "dalmatia"],
        prestige: OBJECTIVE_PRESTIGE,
      },
    ],
  },

  // ----------------------------------------------------------------- HUNGARY
  [Faction.HUNGARY]: {
    faction: Faction.HUNGARY,
    capital: "buda",
    provinces: ["buda", "belgrade", "transylvania", "croatia"],
    treasury: { ...FACTION_STARTING_RESOURCES[Faction.HUNGARY] },
    startingWalls: { buda: 3, belgrade: 4, transylvania: 1 },
    forces: [
      // buda: 2 levy, 1 Black Army (Fekete Sereg), 1 cav
      { provinceId: "buda", domain: "land", units: { [LEVY]: 2, [CAV]: 1 }, variants: [v(INF, "BLACK_ARMY", 1)] },
      // belgrade: 2 levy, 1 inf (fortress garrison, behind T4 walls)
      { provinceId: "belgrade", domain: "land", units: { [LEVY]: 2, [INF]: 1 } },
      // transylvania: 2 levy
      { provinceId: "transylvania", domain: "land", units: { [LEVY]: 2 } },
      // croatia: 1 levy
      { provinceId: "croatia", domain: "land", units: { [LEVY]: 1 } },
    ],
    uniqueUnitKeys: ["BLACK_ARMY", "BANDERIAL_KNIGHTS"],
    powers: [
      {
        id: "call-the-crusade",
        name: "Call the Crusade",
        description:
          "With papal support (spend faith, +bonus if a friendly power holds " +
          "rome) Hungary may declare a Crusade against the Ottomans: it gains " +
          "temporary Crusader levies, a faith & prestige surge, and may rally " +
          "Christian neutrals to march with it for the campaign.",
        effects: ["spend-faith-declare-crusade-vs-ottomans", "bonus-if-friendly-holds-rome", "crusader-levies", "rally-christian-neutrals"],
        provinceRefs: ["rome", "serbia", "bosnia", "wallachia", "albania"],
      },
      {
        id: "strongest-levies",
        name: "Strongest Levies",
        description:
          "Hungarian levies get +1 combat and cost -1 gold — the best militia on " +
          "the board, ideal for the Balkan land war.",
        effects: ["levy-+1-combat", "levy-cost--1-gold"],
      },
      {
        id: "danube-fortresses-and-papal-support",
        name: "Danube Fortresses & Papal Support",
        description:
          "belgrade (T4) and buda (T3) gain +1 defense versus Ottoman sieges; " +
          "Hungary earns steady faith and may convert indulgences into gold to " +
          "fund armies.",
        effects: ["belgrade-+1-def-vs-ottoman-siege", "buda-+1-def-vs-ottoman-siege", "steady-faith-income", "indulgence-to-gold"],
        provinceRefs: ["belgrade", "buda"],
      },
    ],
    objectives: [
      {
        id: "hun-antemurale-christianitatis",
        description:
          "Antemurale Christianitatis: hold both belgrade and buda at game end, and never let the " +
          "Ottomans capture either during the game.",
        provinceRefs: ["belgrade", "buda"],
        prestige: OBJECTIVE_PRESTIGE,
      },
      {
        id: "hun-crusader",
        description:
          "Crusader: win a major battle against the Ottomans at varna (or another Balkan front) and " +
          "control three Balkan neutral provinces (serbia, bosnia, wallachia, albania).",
        provinceRefs: ["varna", "serbia", "bosnia", "wallachia", "albania"],
        prestige: OBJECTIVE_PRESTIGE,
      },
      {
        id: "hun-defender-of-the-faith",
        description:
          "Defender of the Faith: lead a Crusade that captures a Muslim-held city (edirne/sofia/bursa), " +
          "or ensure constantinople remains in Christian hands at game end.",
        provinceRefs: ["edirne", "sofia", "bursa", "constantinople"],
        prestige: OBJECTIVE_PRESTIGE,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Builders consumed by gameState.createInitialState
// ---------------------------------------------------------------------------

/** A zeroed unit record covering every {@link UnitType}. */
function zeroUnits(): Record<UnitType, number> {
  const units = {} as Record<UnitType, number>;
  for (const type of Object.values(UnitType)) units[type] = 0;
  return units;
}

/**
 * Resolve the starting {@link WallState} for a province owned at game start by
 * `faction`. Reads the faction's authored MAP-tier and maps it through
 * MAP_WALL_TIER → WALL_TIERS (the HP model). Returns tier-0 walls when the
 * faction/province has no authored fortification.
 */
export function startingWallState(faction: Faction, provinceId: string): WallState {
  const mapTier = FACTION_STARTS[faction]?.startingWalls?.[provinceId];
  if (mapTier === undefined) return { tier: 0, hp: 0 };
  const hpTier = MAP_WALL_TIER[mapTier] ?? 0;
  return { tier: hpTier, hp: WALL_TIERS[hpTier]?.hp ?? 0 };
}

/**
 * Build every faction's starting armies and fleets onto the live board.
 *
 * For each seated faction, its authored {@link StartingForceDef}s are placed at
 * their province only if that province currently exists on the board AND is
 * owned by the seated player. Forces for provinces absent from the placeholder
 * map are silently skipped — so this data already targets the canonical map the
 * Data phase swaps in, without breaking the current slice.
 *
 * Ids are deterministic: `army-<playerId>-<provinceId>` / `fleet-<...>`.
 */
export function buildFactionForces(
  provinces: Province[],
  factionToPlayerId: ReadonlyMap<Faction, string>,
): { armies: Army[]; fleets: Fleet[] } {
  const provinceById = new Map(provinces.map((p) => [p.id, p]));
  const armies: Army[] = [];
  const fleets: Fleet[] = [];

  for (const start of Object.values(FACTION_STARTS)) {
    const playerId = factionToPlayerId.get(start.faction);
    if (!playerId) continue; // faction not seated → run as passive AI elsewhere

    for (const def of start.forces) {
      const province = provinceById.get(def.provinceId);
      if (!province || province.ownerId !== playerId) continue;

      const units = zeroUnits();
      for (const [type, count] of Object.entries(def.units)) {
        units[type as UnitType] = count ?? 0;
      }
      const variants = def.variants?.map((s) => ({ ...s }));

      if (def.domain === "naval") {
        fleets.push({
          id: `fleet-${playerId}-${def.provinceId}`,
          ownerId: playerId,
          locationId: def.provinceId,
          units,
          ...(variants && variants.length ? { variants } : {}),
        });
      } else {
        armies.push({
          id: `army-${playerId}-${def.provinceId}`,
          ownerId: playerId,
          locationId: def.provinceId,
          units,
          ...(variants && variants.length ? { variants } : {}),
        });
      }
    }
  }

  return { armies, fleets };
}

/** Deep-clone a faction's three secret objectives for a fresh player. */
export function startingObjectives(faction: Faction): SecretObjective[] {
  return FACTION_STARTS[faction].objectives.map((o) => ({
    ...o,
    provinceRefs: [...o.provinceRefs],
    completed: false,
  }));
}
