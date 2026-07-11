/**
 * Shared types for the IMPERIUM balance simulation package.
 * Pure type declarations plus a couple of const id lists — no logic here.
 */

// ---------------------------------------------------------------- factions

export type FactionId = 'byzantium' | 'ottomans' | 'venice' | 'genoa' | 'hungary';

export const FACTION_IDS: readonly FactionId[] = [
  'byzantium',
  'ottomans',
  'venice',
  'genoa',
  'hungary',
] as const;

// ------------------------------------------------------------------- units

export type UnitType = 'levy' | 'professional' | 'mercenary' | 'siegeEngine' | 'galley';

export const UNIT_TYPES: readonly UnitType[] = [
  'levy',
  'professional',
  'mercenary',
  'siegeEngine',
  'galley',
] as const;

/** An army/garrison is just a count per unit type. Always all five keys. */
export interface Army {
  levy: number;
  professional: number;
  mercenary: number;
  siegeEngine: number;
  galley: number;
}

// --------------------------------------------------------------- resources

export type Resource = 'gold' | 'grain' | 'timber' | 'marble' | 'faith';

export interface Yields {
  gold: number;
  grain: number;
  timber: number;
  marble: number;
  faith: number;
}

// --------------------------------------------------------------------- map

export type Terrain = 'plains' | 'hills' | 'mountains' | 'forest' | 'marsh';

export type WallTier = 0 | 1 | 2 | 3;

export interface Province {
  id: string;
  name: string;
  /** null = neutral (garrisoned by minor powers at setup). */
  initialOwner: FactionId | null;
  terrain: Terrain;
  wallTier: WallTier;
  /** Only Constantinople: extra wall bonus + extra wall hitpoints. */
  theodosianWalls: boolean;
  keyCity: boolean;
  /** Has a harbor: can build galleys, be a trade-route endpoint, be blockaded. */
  port: boolean;
  yields: Yields;
  /** Land adjacency (ids). Symmetric; built from an edge list in map.ts. */
  adjacentProvinces: string[];
  /** Sea zones this province touches (ids). Empty for landlocked. */
  coasts: string[];
}

export interface SeaZone {
  id: string;
  name: string;
  /** Sea-to-sea adjacency (ids). Symmetric. */
  adjacentZones: string[];
  /** Province ids that coast this zone (derived from Province.coasts). */
  coastalProvinces: string[];
}

export interface TradeRoute {
  id: string;
  /** Endpoint province ids; both must be ports unless the route is overland. */
  a: string;
  b: string;
  /** Sea zones the route passes through; an enemy fleet here can cut it. */
  seaZones: string[];
  /** Gold per round while the route is open and owned. */
  income: number;
  /**
   * Overland caravan route: endpoints need not be ports, seaZones is empty,
   * and the route can never be blockaded by fleets.
   */
  overland?: boolean;
}

export interface FactionStart {
  treasury: { gold: number; grain: number };
  /** Starting garrisons keyed by province id (must be initially owned). */
  garrisons: Record<string, Army>;
}

// ------------------------------------------------------------------ combat

/**
 * All die-value shifts applied in a battle. Positive numbers help the side
 * they belong to. Quality bonuses of the armies are computed by combat.ts
 * and are NOT part of these modifiers.
 */
export interface CombatModifiers {
  /** Flat attacker die shift (tactic cards, general, event effects). */
  attackerBonus: number;
  /** Flat defender die shift (tactic cards, general, event effects). */
  defenderBonus: number;
  /** Defensive terrain shift added to defender dice (see CONFIG.combat.terrain). */
  terrainBonus: number;
  /** Effective wall shift added to defender dice (0 in field battles). */
  wallBonus: number;
  /** Optional cap on attacker dice (e.g. assault through a narrow breach). */
  attackerDiceCap?: number;
  /** Optional cap on defender dice. */
  defenderDiceCap?: number;
}

/** Per-round casualty report. NOTE: combat.ts reuses one instance (no alloc). */
export interface RoundLosses {
  attackerLosses: number;
  defenderLosses: number;
}

export interface BattleOptions {
  /** Battle round cap; past it the result is 'stalemate'. */
  maxRounds?: number;
  /** Attacker retreats when combatants fall to/below this fraction of start. */
  retreatFraction?: number;
}

export interface BattleResult {
  /** 'defender' includes the attacker-retreated case. */
  winner: 'attacker' | 'defender' | 'stalemate';
  rounds: number;
  /** Combatant units lost (siege engines not counted; see combat.ts docs). */
  attackerLosses: number;
  defenderLosses: number;
  attackerRemaining: number;
  defenderRemaining: number;
}

// ------------------------------------------------------------------- siege

export interface SiegeState {
  provinceId: string;
  attackerFaction: FactionId;
  defenderFaction: FactionId | null;
  /** Accumulated wall damage in hitpoints (see CONFIG.walls.hitpointsPerTier). */
  wallDamage: number;
  /** Full rounds this siege has been maintained (drives attrition). */
  roundsBesieged: number;
  /** The one-off Great Bombard is on site (available late game). */
  hasGreatBombard: boolean;
}

// ------------------------------------------------------- actions & policy

export type ActionType =
  | 'recruit'
  | 'move'
  | 'attack'
  | 'build'
  | 'trade'
  | 'diplomacy'
  | 'playCard'
  | 'pass';

export type BuildType = 'market' | 'wallUpgrade' | 'greatWork';

/** Loose action shape for the full-game module; interpret fields per type. */
export interface Action {
  type: ActionType;
  faction: FactionId;
  /** Province or sea-zone the action originates from / targets. */
  from?: string;
  to?: string;
  unit?: UnitType;
  count?: number;
  build?: BuildType;
  routeId?: string;
}

/** Canonical strategy archetypes the balance targets talk about. */
export type StrategyProfile = 'rush' | 'tradeTurtle' | 'balanced';

/** Knobs an AI policy exposes so the full-game sim can sweep strategies. */
export interface PolicyWeights {
  /** 0..1 — how eagerly to declare war / press attacks. */
  aggression: number;
  /** 0..1 — priority of markets/trade/great works over troops. */
  economyFocus: number;
  /** 0..1 — priority of galleys and sea control. */
  navalFocus: number;
  /** 0..1 — expand into neutrals vs consolidate/fortify. */
  expansion: number;
}

// ------------------------------------------------------------------ events

export type EventKind = 'gold' | 'grain' | 'units' | 'prestige';

/** One global event card drawn per round; magnitude within CONFIG.events bounds. */
export interface EventCard {
  id: string;
  kind: EventKind;
  /** Who it hits: everyone, one random faction, or the prestige leader. */
  target: 'all' | 'random' | 'leader';
  magnitude: number;
  description?: string;
}

// ---------------------------------------------------------------- prestige

/** Per-faction prestige bookkeeping for pacing/full-game sims. */
export interface PrestigeLedger {
  keyCities: number;
  tradeRoutes: number;
  greatWorks: number;
  /** Conquest track: one-off prestige per province captured. */
  conquests: number;
  warsWon: number;
  objectives: number;
  events: number;
  total: number;
}
