/**
 * Pure GameState selectors for the client. All map/adjacency knowledge comes
 * from the board's client-side dataset (client/src/board/mapData) — NEVER
 * import server code into the client.
 */
import type {
  Army,
  Faction,
  Fleet,
  GamePhase,
  Player,
  Province,
  SeaZone,
  UnitType,
} from "@imperium/shared";
import type { GameState } from "@imperium/shared";
import type { TimerState } from "./types";

// Re-exported board helpers: the canonical 55-province/12-sea dataset the
// <Board> renders, its adjacency graph, and the legal one-step move helper.
export {
  BOARD_MAP,
  BOARD_ADJACENCY,
  isSeaZoneId,
  neighborsOf,
  legalMoveTargets,
  factionByPlayer,
  provinceOwnerFaction,
} from "../board/mapData";

/** The seated player with this id, or null (also null for the empty id). */
export function playerById(state: GameState, playerId: string): Player | null {
  if (playerId === "") return null;
  return state.players.find((p) => p.id === playerId) ?? null;
}

/** My own Player row (full hand/objectives — the projection reveals mine). */
export function me(state: GameState, myPlayerId: string): Player | null {
  return playerById(state, myPlayerId);
}

/** Faction of a player id, or null when unseated/unpicked. */
export function factionOf(state: GameState, playerId: string): Faction | null {
  return playerById(state, playerId)?.faction ?? null;
}

/** Actions left in my 4-pip budget this round (0 when not seated). */
export function myBudgetRemaining(state: GameState, myPlayerId: string): number {
  return me(state, myPlayerId)?.actionsRemaining ?? 0;
}

/** The engine phase currently in force. */
export function currentPhase(state: GameState): GamePhase {
  return state.phase;
}

/** Player id whose turn it is per turnOrder/activePlayerIndex, or null. */
export function activePlayerId(state: GameState): string | null {
  return state.turnOrder[state.activePlayerIndex] ?? null;
}

/**
 * True when it is my turn. The transport turn_timer (when present) is the
 * authoritative live signal; otherwise derive from turnOrder.
 */
export function isMyTurn(
  state: GameState,
  myPlayerId: string,
  timer?: TimerState | null,
): boolean {
  if (timer && timer.activePlayerId !== null) {
    return timer.activePlayerId === myPlayerId;
  }
  return activePlayerId(state) === myPlayerId;
}

/** Province by id, or null. */
export function provinceById(state: GameState, id: string): Province | null {
  return state.provinces.find((p) => p.id === id) ?? null;
}

/** Sea zone by id, or null. */
export function seaZoneById(state: GameState, id: string): SeaZone | null {
  return state.seaZones.find((s) => s.id === id) ?? null;
}

/** All provinces owned by a player. */
export function provincesOf(state: GameState, playerId: string): Province[] {
  return state.provinces.filter((p) => p.ownerId === playerId);
}

/** True when the province is owned by this player. */
export function ownsProvince(
  state: GameState,
  playerId: string,
  provinceId: string,
): boolean {
  return provinceById(state, provinceId)?.ownerId === playerId;
}

/** Armies standing in a province. */
export function armiesAt(state: GameState, locationId: string): Army[] {
  return state.armies.filter((a) => a.locationId === locationId);
}

/** Fleets standing in a sea zone or coastal province. */
export function fleetsAt(state: GameState, locationId: string): Fleet[] {
  return state.fleets.filter((f) => f.locationId === locationId);
}

/** Total unit count of a stack's generic units. */
export function unitCount(units: Record<UnitType, number>): number {
  return Object.values(units).reduce((sum, n) => sum + n, 0);
}

/** My armies/fleets (for stack pickers and the March order). */
export function myStacks(
  state: GameState,
  myPlayerId: string,
): { armies: Army[]; fleets: Fleet[] } {
  return {
    armies: state.armies.filter((a) => a.ownerId === myPlayerId),
    fleets: state.fleets.filter((f) => f.ownerId === myPlayerId),
  };
}

/** True once the game has a winner (drives the VictoryScreen overlay). */
export function isGameOver(state: GameState): boolean {
  return state.winner !== undefined;
}

/**
 * True while a mercenary auction is actively in progress: an unsold offer
 * with a live round-robin bidder. (Offers merely LISTED for the round do not
 * force the auction modal open.)
 */
export function isMercAuctionLive(state: GameState): boolean {
  return state.mercMarket.some(
    (o) => !o.sold && o.activeBidderId !== undefined && o.activeBidderId !== null,
  );
}

/** The first unresolved battle I am party to, else the first pending battle. */
export function nextPendingBattle(state: GameState, myPlayerId: string) {
  const mine = state.pendingBattles.find(
    (b) => b.attackerId === myPlayerId || b.defenderId === myPlayerId,
  );
  return mine ?? state.pendingBattles[0] ?? null;
}
