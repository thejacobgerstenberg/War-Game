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
 * is expressed as a {@link ResourceBundle}. Faith is non-tradeable.
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
  /**
   * True once this city has been SACKED — captured by ASSAULT (storm), as opposed
   * to a starvation-surrender (which does NOT sack). Set by the combat subsystem on
   * assault-capture; read by prestige.ts for the Byzantine "Faith of the Fathers"
   * never-sacked ("Hagia Sophia intact") objective and by economy.ts to stop the
   * standing Hagia Sophia faith yield once Constantinople is no longer intact
   * (RULING 1 — see scratchpad/CONTRACT.md RATIFY-PREP). Initialised to false.
   */
  sacked?: boolean;
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
  /**
   * How many of this stack's generic {@link units} are mercenary-tagged, by type
   * (§6.3). Mercenaries pay double grain upkeep (§4.4) and desert first. A count
   * never exceeds the matching `units` entry; absent means none are mercenaries.
   */
  mercenaries?: Partial<Record<UnitType, number>>;
}

/** A stack of naval units occupying a sea zone or coastal province. */
export interface Fleet {
  id: string;
  ownerId: string;
  locationId: string;
  units: Record<UnitType, number>;
  variants?: UnitVariantStack[];
  /** Mercenary-tagged generic units by type (§6.3); see {@link Army.mercenaries}. */
  mercenaries?: Partial<Record<UnitType, number>>;
}

/** A political/event card held or played by a player. */
export interface Card {
  id: string;
  name: string;
  description: string;
  cost: Partial<ResourceBundle>;
}

// ---------------------------------------------------------------------------
// Distinct card keyspaces (CANON clarification 2)
// ---------------------------------------------------------------------------

/**
 * Nominal id of an **Omen/event-deck** card. Event and tactic slugs live in
 * SEPARATE keyspaces — `papal-indulgence` and `chain-across-the-horn` legitimately
 * exist in BOTH decks — so their ids are branded distinctly and are NOT a shared
 * string-union: a cross-deck slug collision can never silently become a bug.
 *
 * A raw string is NOT assignable to a branded id without {@link asEventCardId};
 * a branded id IS assignable back to `string`, so it flows through the frozen
 * events subsystem (whose `omenDeck`/`resolveCard` still speak `string`) unchanged.
 */
export type EventCardId = string & { readonly __cardDeck: "event" };

/** Nominal id of a **tactic-deck** card (distinct keyspace from {@link EventCardId}). */
export type TacticCardId = string & { readonly __cardDeck: "tactic" };

/** Cast a raw slug/id to an {@link EventCardId} (events-subsystem boundary helper). */
export const asEventCardId = (id: string): EventCardId => id as EventCardId;

/** Cast a raw slug/id to a {@link TacticCardId} (tactic-subsystem boundary helper). */
export const asTacticCardId = (id: string): TacticCardId => id as TacticCardId;

/**
 * A tactic-deck card design (§7.7). The full 24-design / 48-copy DATA lives in
 * the server (`engine/tactics/cards.ts`, authored by the tactic agent); this is
 * the shared shape both the engine and client build against.
 */
export interface TacticCard {
  /** Namespaced tactic slug (distinct keyspace — see {@link TacticCardId}). */
  id: TacticCardId;
  name: string;
  /** Physical copies of this design in the shuffled 48-card deck. */
  copies: number;
  /** Printed effect text (human-readable). */
  effect: string;
  /** When it may be played (e.g. "battle" | "assault" | "siege" | "play-card" | "reaction"). */
  timing?: string;
  /** True for cards that leave the game after resolving (e.g. `greek-fire`). */
  removedFromGameOnPlay?: boolean;
  /** Structured effect payload for the tactic resolver. */
  data?: Record<string, unknown>;
}

/**
 * A hidden victory goal dealt to a player (3 per faction, scored at game end).
 *
 * The legacy `provinceRefs` model (all-of, evaluated with `.every(owned)`) cannot
 * express OR-clauses or non-territorial conditions, so several ratified objectives
 * were mis-scored (FL-06 Restoration OR-clause, FL-07 Ghazi non-territorial,
 * FL-08 Faith-of-the-Fathers gated). The optional predicate fields below let
 * prestige.ts evaluate richer completion tests and factions.ts re-seed them.
 * All fields are optional and additive — an objective using only `provinceRefs`
 * keeps its original meaning (backward-compatible). When both `provinceRefs` and
 * the structured fields are present, the structured fields are the intended test.
 */
export interface SecretObjective {
  id: string;
  description: string;
  /**
   * Province ids ALL required by the objective (the original all-of test). Still
   * valid on its own; treated as an implicit `allOf` when the fields below are set.
   */
  provinceRefs: string[];
  /** Prestige awarded on completion. */
  prestige: number;
  completed?: boolean;
  /** Province ids that must ALL be controlled (explicit all-of group; FL-06). */
  allOf?: string[];
  /** Province ids of which at LEAST ONE must be controlled (or-clause; FL-06). */
  anyOf?: string[];
  /** Minimum number of provinces controlled at game end (FL-07 threshold). */
  minProvinces?: number;
  /** Requires Hagia Sophia present/intact in a held province (FL-08). */
  requiresHagiaSophia?: boolean;
  /** Minimum faith the player must finish with (FL-08). */
  minFaith?: number;
  /** Requires the player to have refused Church Union (FL-08 flag). */
  refusedChurchUnion?: boolean;
  /** Minimum count of high-value cities sacked over the game (FL-07 alternative). */
  sackedHighValueCities?: number;
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
  /**
   * DA-3 (§6.3 step 2, CANON CLARIFICATION 3) — true round-robin auction close.
   * Player ids that have voluntarily passed (or been auto-passed for inability to
   * afford the minimum raise) on THIS offer; the auction closes when only one
   * non-passed bidder remains (winner pays the current high bid at face value).
   * Optional so hand-built offer literals stay valid; the mercenaries subsystem
   * (`refreshMercMarket`) initialises it to `[]` when building each offer, and
   * `applyMercBid` pushes to it — treat absent as `[]`.
   */
  passedPlayerIds?: string[];
  /**
   * DA-3 — player id whose turn it is to act in the round-robin, or undefined when
   * the auction has no active bidder yet. The mercenaries subsystem advances this
   * as bids/passes come in.
   */
  activeBidderId?: string;
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
  /** Tactic cards the attacker has queued to play in this battle (§7.7). */
  attackerTactics?: TacticCardId[];
  /** Tactic cards the defender has queued to play in this battle (§7.7). */
  defenderTactics?: TacticCardId[];
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
 * | 'trade_mod' | 'freeze_sea' | 'no_recruit' | 'no_build' | 'siege_mod' | 'morale'
 * | 'income' | 'plague' | 'wall_mod' | 'unlock' | 'prestige_pending'. (FL-04/FL-19:
 * 'income' and 'plague' are ordinary open-string kinds — economy.ts reads them in
 * applyIncomePhase/computeIncome; no new type is required.)
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
  /**
   * Tactic cards held in hand (§7.7). One is drawn each Income phase; the hand is
   * pruned to `balance.TACTIC_HAND_LIMIT` at Cleanup. Optional so pre-existing
   * fixtures/test literals stay valid; `createInitialState` initialises it to `[]`.
   */
  tacticHand?: TacticCardId[];
  /**
   * @deprecated delta 3 (CANON GREAT BOMBARD correction). The Great Bombard is no
   * longer acquired via an "unlock then RECRUIT" path — the single piece is SPAWNED
   * directly by Omen event #34 (`great-bombard-forged`) and tracked on
   * {@link GameState.greatBombard}. This per-player boolean is retained ONLY so the
   * existing events/combat/actions code keeps compiling until those agents migrate
   * to the {@link GameState.greatBombard} singleton; do NOT key new acquisition
   * logic on it. Was: set by the actions layer from the Omen #34 `kind:'unlock'`
   * modifier (`data.unlock === "GREAT_BOMBARD"`) for the targeted faction.
   */
  greatBombardUnlocked?: boolean;
  /**
   * Cumulative conquest-derived prestige awarded to this player (§13 conquest track:
   * taken walled cities, decisive/outnumbered wins, wars, held enemy capitals).
   * A running total for the End-phase summary; the prestige subsystem also folds
   * these into `prestige`.
   */
  conquestPrestige?: number;
  /**
   * FL-08 (Byzantium secret objective "Faith of the Fathers") — true once this
   * player has ACCEPTED Church Union (Omen #17, resolved with `choice:"ACCEPT"`).
   * undefined/false = has NOT accepted = REFUSED. The events agent sets it true on
   * acceptance; prestige.ts reads "refused Church Union" as `!acceptedChurchUnion`.
   */
  acceptedChurchUnion?: boolean;
  /**
   * FL-07 (Ottoman secret objective "Ghazi Empire") — count of enemy high-value
   * cities this player has sacked/captured over the game. combat.ts increments it
   * on capture of an enemy high-value city; prestige.ts reads it for the
   * minProvinces-OR-sackedHighValueCities completion predicate. Initialised to 0
   * in `createInitialState`; treat absent as 0.
   */
  sackedHighValueCities?: number;
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
  /**
   * The tactic draw deck (§7.7): built from `TACTIC_CARDS` copies and shuffled by
   * the seeded RNG at game start; draw from the front each Income phase. Optional
   * so pre-existing GameState fixtures stay valid; initialised in `createInitialState`.
   */
  tacticDeck?: TacticCardId[];
  /** Tactic discard pile — reshuffled into `tacticDeck` when the deck empties. */
  tacticDiscard?: TacticCardId[];
  /** Tactic cards removed from the game (e.g. `greek-fire` after play; never return). */
  tacticRemoved?: TacticCardId[];
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
  /**
   * FL-21 — deferred occupations (§6.4 / §10 phase-5). When a stack marches
   * unopposed into an empty enemy/neutral province, `actions.ts::relocate` moves
   * the stack WITHOUT flipping `Province.ownerId` and records the pending
   * occupation here; the roundLoop END/cleanup step flips `ownerId` to
   * `occupantId` for entries still occupied-and-uncontested, then clears them.
   * `sinceRound` lets cleanup tell a fresh occupation from one that has stood.
   * Optional so hand-built GameState fixtures stay valid; `createInitialState`
   * initialises it to `[]`. THIS is the chosen deferred-occupation field (not
   * `Province.pendingOwnerId`) — actions.ts and roundLoop.ts must both use it.
   */
  pendingOccupations?: {
    provinceId: string;
    occupantId: string;
    sinceRound: number;
  }[];
  /** Round/persistent effect side-channel posted by cards, read by subsystems. */
  activeModifiers: ActiveModifier[];
  /** Constantinople sudden-death tracker. */
  constantinopleHold: { faction: Faction | null; rounds: number };
  /**
   * The one-per-game Great Bombard (§8.4), delta 3 (CANON correction). The piece is
   * SPAWNED by Omen event #34 (`great-bombard-forged`) — placed in the Ottoman
   * capital if the Ottoman is in play, else auctioned (gold + marble) — and NEVER
   * recruited or rebuilt. This singleton records the live piece:
   *   - `inPlay`        — has event #34 resolved and put the gun on the board;
   *   - `ownerId`       — player id currently holding it (transfers INTACT to a
   *                        victor if its escort/garrison is defeated), or null;
   *   - `provinceId`    — province the piece currently occupies, or null;
   *   - `emplacedRound` — the round it ENTERED its current emplacement; it cannot
   *                        fire (bombard) until `emplacedRound + GREAT_BOMBARD.
   *                        emplacementRounds` (the ratified 1-round emplacement).
   * Optional so pre-existing GameState fixtures/literals stay valid; initialised
   * NOT-in-play in `createInitialState`. Written by events (#34 spawn/placement) +
   * combat (capture-passes-intact, re-emplacement on move); read by combat (the
   * emplacement fire-gate) and actions.
   */
  greatBombard?: {
    inPlay: boolean;
    ownerId: string | null;
    provinceId: string | null;
    emplacedRound: number;
  };
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
