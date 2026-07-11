/**
 * Core game-state types for IMPERIUM: Twilight of Empires.
 *
 * These types are shared verbatim between the server engine and the browser
 * client, so the wire representation of a game is a plain, serialisable
 * {@link GameState}.
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
}

/** Recruitable unit archetypes. */
export enum UnitType {
  LEVY = "LEVY",
  INFANTRY = "INFANTRY",
  CAVALRY = "CAVALRY",
  ARCHER = "ARCHER",
  SIEGE = "SIEGE",
  GALLEY = "GALLEY",
  WARSHIP = "WARSHIP",
}

/** High-level turn phases. */
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
 * is expressed as a {@link ResourceBundle}.
 */
export interface ResourceBundle {
  gold: number;
  grain: number;
  timber: number;
  stone: number;
  faith: number;
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
}

/** A navigable stretch of water connecting coastal provinces. */
export interface SeaZone {
  id: string;
  name: string;
  position: { x: number; y: number };
}

/** A stack of land units occupying a province. */
export interface Army {
  id: string;
  ownerId: string;
  locationId: string;
  units: Record<UnitType, number>;
}

/** A stack of naval units occupying a sea zone or coastal province. */
export interface Fleet {
  id: string;
  ownerId: string;
  locationId: string;
  units: Record<UnitType, number>;
}

/** A political/event card held or played by a player. */
export interface Card {
  id: string;
  name: string;
  description: string;
  cost: Partial<ResourceBundle>;
}

/**
 * Kinds of noteworthy occurrence recorded in the game log. The log is kept from
 * the very first turn because it powers the end-of-game "chronicle" recap.
 */
export type GameLogEventType =
  | "battle"
  | "siege"
  | "betrayal"
  | "event_card"
  | "prestige_change"
  | "trade"
  | "diplomacy"
  | "recruit"
  | "build"
  | "game_start"
  | "game_end";

/** A single structured entry in the game chronicle. */
export interface GameLogEntry {
  round: number;
  phase: GamePhase;
  type: GameLogEventType;
  /** Player/faction ids responsible for the event. */
  actors: string[];
  /** Province/player ids the event acted upon. */
  targets?: string[];
  /** Free-form structured payload for later rendering/analytics. */
  data?: Record<string, unknown>;
  /** Human-readable chronicle line. */
  message: string;
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
}

/** The complete, serialisable state of a single game. */
export interface GameState {
  roomCode: string;
  phase: GamePhase;
  turn: number;
  /** Index into {@link turnOrder} of the player whose turn it is. */
  activePlayerIndex: number;
  turnOrder: string[];
  players: Player[];
  provinces: Province[];
  seaZones: SeaZone[];
  armies: Army[];
  fleets: Fleet[];
  /** Structured chronicle of everything that has happened this game. */
  log: GameLogEntry[];
}

/** A zero-filled resource bundle helper. */
export const EMPTY_RESOURCES: ResourceBundle = {
  gold: 0,
  grain: 0,
  timber: 0,
  stone: 0,
  faith: 0,
};
