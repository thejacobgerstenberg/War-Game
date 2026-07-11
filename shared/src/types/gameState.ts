/**
 * Core game-state types for IMPERIUM: Twilight of Empires.
 *
 * These types are shared verbatim between the server engine and the browser
 * client, so the wire representation of a game is a plain, serialisable
 * {@link GameState}.
 *
 * This file is the FROZEN type contract that every engine subsystem builds
 * against. See scratchpad/CONTRACT.md for the authoritative field-by-field
 * description and the design decisions behind the growth fields added here.
 */

/** The playable powers of the late Roman/Byzantine world (~1400–1453). */
export enum Faction {
  BYZANTIUM = "BYZANTIUM",
  OTTOMAN = "OTTOMAN",
  VENICE = "VENICE",
  GENOA = "GENOA",
  HUNGARY = "HUNGARY",
}

/** Terrain of a land province, affecting yields and movement. */
export enum TerrainType {
  PLAINS = "PLAINS",
  HILLS = "HILLS",
  MOUNTAINS = "MOUNTAINS",
  FOREST = "FOREST",
  COAST = "COAST",
  CITY = "CITY",
  /** Arid Egypt/Levant edge (Cairo, Alexandria, Tunis). Trade-city gold, no grain. */
  DESERT = "DESERT",
}

/**
 * Recruitable unit archetypes. Only these seven generic types exist; the ten
 * named faction unique units are modelled as a generic {@link UnitType} plus a
 * `variant` tag (see {@link UnitVariantStack}) whose stat deltas live in
 * balance.ts (UNIQUE_UNIT_OVERRIDES). No unique unit is ever a UnitType member.
 */
export enum UnitType {
  LEVY = "LEVY",
  INFANTRY = "INFANTRY",
  CAVALRY = "CAVALRY",
  ARCHER = "ARCHER",
  SIEGE = "SIEGE",
  GALLEY = "GALLEY",
  WARSHIP = "WARSHIP",
}

/** Ordinary constructions a player may raise in an owned province. */
export enum BuildingType {
  BARRACKS = "BARRACKS",
  MARKET = "MARKET",
  GRANARY = "GRANARY",
  SHIPYARD = "SHIPYARD",
  /** Church or Mosque (faith building). */
  TEMPLE = "TEMPLE",
  WALLS = "WALLS",
  UNIVERSITY = "UNIVERSITY",
}

/** Multi-round prestige constructions (paid up front, invested over rounds). */
export enum GreatWorkType {
  HAGIA_SOPHIA = "HAGIA_SOPHIA",
  THEODOSIAN_WALLS = "THEODOSIAN_WALLS",
  GREAT_UNIVERSITY = "GREAT_UNIVERSITY",
  GRAND_BAZAAR = "GRAND_BAZAAR",
}

/** Taxation posture chosen each Income phase (see balance.TAX_MULTIPLIERS). */
export enum TaxPosture {
  LENIENT = "LENIENT",
  NORMAL = "NORMAL",
  HEAVY = "HEAVY",
}

/** Diplomatic instrument type. */
export enum TreatyType {
  ALLIANCE = "ALLIANCE",
  NAP = "NAP",
  TRIBUTE = "TRIBUTE",
  ROYAL_MARRIAGE = "ROYAL_MARRIAGE",
}

/** Spy mission kind (see GAME_DESIGN §10.7). */
export enum SpyMission {
  /** Peek the top Omen card. */
  OMEN = "OMEN",
  /** View one rival secret objective. */
  OBJECTIVE = "OBJECTIVE",
  /** Target enemy province yields 0 next Income. */
  UNREST = "UNREST",
}

/** High-level turn phases. The Omen sub-phase lives at the front of INCOME. */
export enum GamePhase {
  LOBBY = "LOBBY",
  INCOME = "INCOME",
  RECRUITMENT = "RECRUITMENT",
  MOVEMENT = "MOVEMENT",
  COMBAT = "COMBAT",
  DIPLOMACY = "DIPLOMACY",
  END = "END",
}

/**
 * The five tradeable/consumable resources. Every economic figure in the game
 * is expressed as a {@link ResourceBundle}. "marble" == stone. Faith is
 * non-tradeable.
 */
export interface ResourceBundle {
  gold: number;
  grain: number;
  timber: number;
  marble: number;
  faith: number;
}

/** Current fortification of a province, in the HP wall model (see WALL_TIERS). */
export interface WallState {
  /** HP-model tier: 0 none, 1 Walls Lv1, 2 Walls Lv2, 3 Theodosian. */
  tier: number;
  /** Remaining wall hit points; 0 = breached. */
  hp: number;
}

/** In-progress great work occupying a province. */
export interface GreatWorkProgress {
  type: GreatWorkType;
  /** Build actions invested so far; complete when progress >= required rounds. */
  progress: number;
}

/** A land region: the atomic unit of ownership and income. */
export interface Province {
  id: string;
  name: string;
  terrain: TerrainType;
  /** Per-turn resource yield of this province. */
  yields: ResourceBundle;
  /** Owning player id, or null if unowned/neutral. */
  ownerId: string | null;
  /** True for coastal provinces that border a sea zone. */
  coastal: boolean;
  /** Rendering hint: centroid on the strategic map (0–100 viewBox space). */
  position: { x: number; y: number };
  /** Fortification state; tier 0 / hp 0 when unwalled. */
  walls: WallState;
  /** Constructed buildings present in this province. */
  buildings: BuildingType[];
  /** Great works completed or under construction here. */
  greatWorks: GreatWorkProgress[];
  /** Active siege against this province, if any. */
  siege?: SiegeState;
  /** Static garrison strength (neutrals/minors defend with this). */
  garrison?: number;
  /** Set when this province is a faction capital. */
  isCapitalOf?: Faction;
  /** Prestige-node weight (high-value city); 0/undefined for ordinary land. */
  highValue?: number;
  /** Id of the owning NPC minor state, if this is a minor's province. */
  minorId?: string;
}

/** A navigable stretch of water connecting coastal provinces. */
export interface SeaZone {
  id: string;
  name: string;
  position: { x: number; y: number };
  /** Player id whose war fleet currently blockades this zone, if any. */
  blockadedBy?: string | null;
  /** Ids of provinces/zones this zone is a gated strait between (e.g. Dardanelles). */
  straits?: string[];
}

/**
 * A named unique unit occupying part of a stack. The unit is mechanically a
 * generic {@link UnitType} (`base`) whose stat overrides and abilities are
 * resolved from balance.UNIQUE_UNIT_OVERRIDES via `variant`.
 */
export interface UnitVariantStack {
  base: UnitType;
  /** Key into balance.UNIQUE_UNIT_OVERRIDES (e.g. "VARANGIAN_GUARD"). */
  variant: string;
  count: number;
}

/** A stack of land units occupying a province. */
export interface Army {
  id: string;
  ownerId: string;
  locationId: string;
  /** Generic units by type. */
  units: Record<UnitType, number>;
  /** Named unique units carried in this stack (data-driven stat overrides). */
  variants?: UnitVariantStack[];
}

/** A stack of naval units occupying a sea zone or coastal province. */
export interface Fleet {
  id: string;
  ownerId: string;
  locationId: string;
  units: Record<UnitType, number>;
  variants?: UnitVariantStack[];
}

/** A political/event card held or played by a player. */
export interface Card {
  id: string;
  name: string;
  description: string;
  cost: Partial<ResourceBundle>;
}

/** A hidden victory goal dealt to a player (3 per faction, scored at game end). */
export interface SecretObjective {
  id: string;
  description: string;
  /** Province ids referenced by the objective's completion test. */
  provinceRefs: string[];
  /** Prestige awarded on completion. */
  prestige: number;
  completed?: boolean;
}

/** An active diplomatic agreement. */
export interface Treaty {
  id: string;
  type: TreatyType;
  /** Player ids party to the treaty. */
  parties: string[];
  /** Round the treaty was concluded (for duration/casus-belli bookkeeping). */
  startedRound?: number;
  /** Round at which the treaty lapses; null = indefinite. */
  expiresRound: number | null;
  /** For TRIBUTE: the bundle paid each Income phase. */
  tribute?: Partial<ResourceBundle>;
  /** For TRIBUTE: player id of the payer. */
  payerId?: string;
  /** For TRIBUTE: player id paying the tribute (explicit direction). */
  tributeFrom?: string;
  /** For TRIBUTE: player id receiving the tribute. */
  tributeTo?: string;
  /** For TRIBUTE: flat gold amount per Income phase (convenience alt to `tribute`). */
  tributeAmount?: number;
}

/** A neutral NPC minor state (Serbia, Ragusa, Knights of Rhodes, …). */
export interface NpcMinor {
  id: string;
  name: string;
  /** Province ids controlled by this minor. */
  provinceIds: string[];
  /** Garrison unit count defending the minor. */
  garrison: number;
  /** Garrison strength tier (used in the vassalize roll). */
  tier: number;
  /** Player id this minor is a vassal of, or null if independent. */
  vassalOf: string | null;
  /** True if it was conquered by force (higher revolt risk on triggers). */
  conquered?: boolean;
  /** Rounds until this vassal may next answer a levy call. */
  levyCooldown?: number;
  /** Rounds until this minor next raises a levy for its overlord (alias of levyCooldown). */
  roundsUntilLevy?: number;
}

/** An open bid on a free mercenary company in the round's merc market. */
export interface MercCompanyOffer {
  /** Key into balance.MERC_COMPANIES. */
  companyId: string;
  /** Highest current whole-gold bid. */
  currentBid: number;
  /** Player id of the current high bidder, or null if unbid. */
  highBidderId: string | null;
  /** True once resolved (fielded or handed to an NPC minor). */
  sold: boolean;
}

/** An in-progress siege of a walled province. */
export interface SiegeState {
  /** Stable siege id (optional; assign when the combat subsystem needs a handle). */
  id?: string;
  provinceId: string;
  /** Player id of the besieging power. */
  besiegerId: string;
  /** Army ids locked into the siege (circumvallation). */
  besiegingArmyIds: string[];
  /** Siege rounds elapsed. */
  roundsElapsed: number;
  /** Rounds the province has been under siege (alias of roundsElapsed for the combat subsystem). */
  roundsBesieged?: number;
  /** Remaining garrison hold-out rounds before starvation begins. */
  grainStores: number;
  /** Accumulated starvation ticks once grain stores are exhausted. */
  starvationCounter?: number;
  /** Current wall HP snapshot mirrored onto the siege (optional convenience). */
  wallHp?: number;
  /** True once wall HP has reached 0. */
  breached: boolean;
  /** True once the besieging army is locked in place. */
  circumvallated: boolean;
  /** Free-form siege phase tag (e.g. "invest" | "bombard" | "assault"). */
  phase?: string;
}

/** A battle declared this round, resolved during the COMBAT phase. */
export interface PendingBattle {
  id: string;
  /** Land battle location (mutually exclusive with seaZoneId). */
  provinceId?: string;
  /** Naval battle location. */
  seaZoneId?: string;
  attackerId: string;
  /** Defending player id, or null for an unowned/neutral-garrison tile. */
  defenderId: string | null;
  /** Army/fleet ids on each side. */
  attackerStackIds: string[];
  defenderStackIds: string[];
  /** Aggregate attacking unit stack (same shape as Army/Fleet.units) — optional
   *  convenience for subsystems that pre-resolve the committed force. */
  attackingUnits?: Record<UnitType, number>;
  /** True for a sea-zone engagement (complements isSiege; mirrors seaZoneId). */
  isNaval?: boolean;
  /** Attacker arrived from a sea zone (amphibious −1). */
  amphibious?: boolean;
  /** This battle is an assault on walls (drives siege resolution). */
  isSiege?: boolean;
}

/**
 * A round/persistent effect side-channel posted mostly by event (Omen) cards and
 * read by the combat / economy / movement subsystems. This decouples "a card
 * happened" from "a subsystem reacts": a card calls `addModifier(...)`; the
 * relevant subsystem calls `getModifiers(state, kind, target?)` at the point it
 * needs the effect, and the round loop calls `expireRoundModifiers` at cleanup.
 * (Engine helpers live in `server/src/engine/modifiers.ts`.)
 *
 * `kind` is an open string so subsystems can add their own effect classes;
 * conventional values: 'combat_mod' | 'move_mod' | 'upkeep_mod' | 'faith_income'
 * | 'trade_mod' | 'freeze_sea' | 'no_recruit' | 'no_build' | 'siege_mod' | 'morale'.
 */
export interface ActiveModifier {
  /** Stable id (e.g. `<cardId>:<kind>` or an engine counter). */
  id: string;
  /** Omen/event card that posted this effect, if any. */
  sourceCardId?: string;
  /** Lifetime: one round, until explicitly cleared, or the whole game. */
  scope: "round" | "persistent" | "game";
  /** Effect class the reading subsystem switches on (open-ended; see above). */
  kind: string;
  /** Optional narrowing of who/where the effect applies to. */
  target?: { faction?: Faction; provinceId?: string; seaZoneId?: string };
  /** Signed magnitude the subsystem applies (e.g. +1 combat, −2 income). */
  value?: number;
  /** Arbitrary structured payload for richer effects. */
  data?: Record<string, unknown>;
  /** Round after which the modifier lapses (for `persistent`/`game` timers). */
  expiresRound?: number;
}

/** An active state of war between two players (for casus-belli / "win war +3"). */
export interface WarState {
  /** One belligerent player id. */
  a: string;
  /** The other belligerent player id. */
  b: string;
  /** Round the war was declared. */
  startedRound: number;
}

/**
 * Kinds of noteworthy occurrence recorded in the game log. Reconciled toward
 * ARCHITECTURE §9.1: a superset covering both the shipped variants and the new
 * spy/mercenary/victory/phase entries.
 */
export type GameLogType =
  | "phase"
  | "event_card"
  | "recruit"
  | "trade"
  | "battle"
  | "siege"
  | "diplomacy"
  | "betrayal"
  | "spy"
  | "prestige_change"
  | "mercenary"
  | "victory"
  | "build"
  | "game_start"
  | "game_end";

/** Back-compat alias for the pre-reconciliation name. */
export type GameLogEventType = GameLogType;

/** A single structured entry in the game chronicle. */
export interface GameLogEntry {
  /** Stable id, assigned by the engine log factory (deterministic counter). */
  id: string;
  round: number;
  phase: GamePhase;
  type: GameLogType;
  /** Player/faction/minor ids responsible for the event. */
  actors: string[];
  /** Province/player/sea-zone ids the event acted upon. */
  targets?: string[];
  /** Free-form structured payload (dice, casualties, HP, amounts, seed cursor…). */
  data?: Record<string, unknown>;
  /** Human-readable chronicle line. */
  message: string;
  /** Monotonic logical counter (engine-supplied; NOT wall-clock). */
  timestamp: number;
}

/** A seated participant in a game. */
export interface Player {
  id: string;
  name: string;
  faction: Faction | null;
  isHost: boolean;
  connected: boolean;
  treasury: ResourceBundle;
  hand: Card[];
  /** Accumulated prestige (victory currency). */
  prestige: number;
  /** The three hidden objectives dealt to this player. */
  objectives: SecretObjective[];
  /** Current taxation posture. */
  tax: TaxPosture;
  /** Treaties this player is party to. */
  treaties: Treaty[];
  /** Ids of NPC minors vassalised to this player. */
  vassals: string[];
  /** Count of treaties this player has broken (reputation). */
  betrayals: number;
  /** Actions left in the current round (budget bookkeeping). */
  actionsRemaining: number;
  /** Per-round prestige-accrual scratch: net prestige gained this round (reset
   *  each round by the prestige subsystem; used for the End-phase log/summary). */
  prestigeThisRound?: number;
}

/**
 * The complete, serialisable state of a single game. Growth fields beyond the
 * original scaffold support the economy, combat, diplomacy, mercenary, event
 * and prestige subsystems, plus deterministic RNG and monotonic counters.
 */
export interface GameState {
  roomCode: string;
  phase: GamePhase;
  /** Legacy turn counter, kept in lockstep with {@link round}. */
  turn: number;
  /** Current round, 1..16 → years 1400..1453. */
  round: number;
  /** Current era: I (1–5), II (6–10), III (11–16). */
  era: 1 | 2 | 3;
  /** Index into {@link turnOrder} of the player whose turn it is. */
  activePlayerIndex: number;
  turnOrder: string[];
  players: Player[];
  provinces: Province[];
  seaZones: SeaZone[];
  armies: Army[];
  fleets: Fleet[];
  /** Card ids remaining in the current era's active Omen deck (draw from front). */
  omenDeck: string[];
  /** Card ids discarded from the current era deck. */
  omenDiscard: string[];
  /** Card id lists for eras not yet entered (retired eras are deleted). */
  eraDecksRemaining: Partial<Record<1 | 2 | 3, string[]>>;
  /** Open bids in this round's mercenary market. */
  mercMarket: MercCompanyOffer[];
  /** NPC minor states on the board. */
  minors: NpcMinor[];
  /** Pending battles to resolve in the COMBAT phase. */
  pendingBattles: PendingBattle[];
  /** Active sieges (mirrors the per-province `siege` field). */
  siegeStates: SiegeState[];
  /** Active states of war (casus-belli, "win a war +3 prestige", peace checks). */
  wars: WarState[];
  /** Round/persistent effect side-channel posted by cards, read by subsystems. */
  activeModifiers: ActiveModifier[];
  /** Constantinople sudden-death tracker. */
  constantinopleHold: { faction: Faction | null; rounds: number };
  /** Winner faction once the game has ended. */
  winner?: Faction;
  /** Seed for the deterministic RNG. */
  rngSeed: number;
  /** Advancing cursor into the RNG stream. */
  rngCursor: number;
  /** Deterministic counter backing {@link GameLogEntry.id}. */
  logCounter: number;
  /** Monotonic logical clock backing {@link GameLogEntry.timestamp}. */
  clock: number;
  /** Structured chronicle of everything that has happened this game. */
  log: GameLogEntry[];
}

/**
 * Data-driven definition of a named unique unit: a generic `base` unit with
 * additive combat deltas and ability tags. Lives in balance.UNIQUE_UNIT_OVERRIDES;
 * the reducer resolves effective stats as UNIT_STATS[base] plus these deltas.
 */
export interface UniqueUnitDef {
  /** Variant key (matches {@link UnitVariantStack.variant}). */
  variant: string;
  base: UnitType;
  name: string;
  faction: Faction;
  /** Additive attack combat-value delta. */
  atkMod?: number;
  /** Additive defence combat-value delta. */
  defMod?: number;
  /** Additive movement delta. */
  mvMod?: number;
  /** Ability tags interpreted by the combat/economy subsystems. */
  abilities: string[];
  /** Province ids where this unit may be raised (undefined = anywhere legal). */
  recruitProvinces?: string[];
}

/** A zero-filled resource bundle helper. */
export const EMPTY_RESOURCES: ResourceBundle = {
  gold: 0,
  grain: 0,
  timber: 0,
  marble: 0,
  faith: 0,
};
