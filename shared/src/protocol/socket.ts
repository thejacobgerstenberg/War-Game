/**
 * Socket.IO wire protocol shared by server and client.
 *
 * Both sides import {@link SOCKET_EVENTS} and the payload interfaces below so
 * event names and shapes can never drift apart.
 */
import type { Faction, GameState } from "../types/gameState.js";

/** Canonical event-name registry. */
export const SOCKET_EVENTS = {
  // Client -> Server
  CREATE_GAME: "create_game",
  JOIN_GAME: "join_game",
  REJOIN_GAME: "rejoin_game",
  PICK_FACTION: "pick_faction",
  START_GAME: "start_game",
  LEAVE_GAME: "leave_game",

  // Server -> Client
  GAME_CREATED: "game_created",
  LOBBY_UPDATE: "lobby_update",
  GAME_STARTED: "game_started",
  ERROR_MSG: "error_msg",
  STATE_UPDATE: "state_update",
  SERVER_SHUTDOWN: "server_shutdown",
} as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

// ---------------------------------------------------------------------------
// Client -> Server payloads
// ---------------------------------------------------------------------------

export interface CreateGamePayload {
  playerName: string;
}

export interface JoinGamePayload {
  roomCode: string;
  playerName: string;
}

/**
 * Reattach a returning socket to its existing seat. `sessionToken` is the
 * per-player secret issued in the `game_created` acknowledgment; unlike
 * `join_game`, a rejoin never creates a new seat and works after game start.
 */
export interface RejoinGamePayload {
  roomCode: string;
  sessionToken: string;
}

export interface PickFactionPayload {
  faction: Faction;
}

/** `start_game` and `leave_game` carry no payload. */
export type StartGamePayload = void;
export type LeaveGamePayload = void;

// ---------------------------------------------------------------------------
// Server -> Client payloads
// ---------------------------------------------------------------------------

export interface GameCreatedPayload {
  roomCode: string;
  playerId: string;
  /**
   * Per-player crypto-random secret. The client stores it (with roomCode and
   * playerId) and presents it in `rejoin_game` to reclaim this seat after a
   * disconnect or page reload.
   */
  sessionToken: string;
}

/** A single row in the lobby roster. */
export interface LobbyPlayer {
  id: string;
  name: string;
  faction: Faction | null;
  isHost: boolean;
  /** False while the seat's socket is dropped (seat held for rejoin). */
  connected: boolean;
}

export interface LobbyUpdatePayload {
  roomCode: string;
  players: LobbyPlayer[];
  startedByHost: boolean;
}

export interface GameStartedPayload {
  state: GameState;
}

export interface ErrorMsgPayload {
  message: string;
}

export interface StateUpdatePayload {
  state: GameState;
}

/**
 * Broadcast to every connected socket when the server begins a graceful
 * shutdown (SIGTERM/SIGINT). Clients should surface a "server restarting"
 * state and schedule their first reconnect attempt after `reconnectAfterMs`.
 */
export interface ServerShutdownPayload {
  /** Suggested initial reconnect delay, in milliseconds. */
  reconnectAfterMs: number;
}

/**
 * Strongly-typed maps of event name -> payload, usable to parameterise a
 * Socket.IO server/client (`Server<ClientToServerEvents, ServerToClientEvents>`).
 */
export interface ClientToServerEvents {
  [SOCKET_EVENTS.CREATE_GAME]: (payload: CreateGamePayload) => void;
  [SOCKET_EVENTS.JOIN_GAME]: (payload: JoinGamePayload) => void;
  [SOCKET_EVENTS.REJOIN_GAME]: (payload: RejoinGamePayload) => void;
  [SOCKET_EVENTS.PICK_FACTION]: (payload: PickFactionPayload) => void;
  [SOCKET_EVENTS.START_GAME]: () => void;
  [SOCKET_EVENTS.LEAVE_GAME]: () => void;
}

export interface ServerToClientEvents {
  [SOCKET_EVENTS.GAME_CREATED]: (payload: GameCreatedPayload) => void;
  [SOCKET_EVENTS.LOBBY_UPDATE]: (payload: LobbyUpdatePayload) => void;
  [SOCKET_EVENTS.GAME_STARTED]: (payload: GameStartedPayload) => void;
  [SOCKET_EVENTS.ERROR_MSG]: (payload: ErrorMsgPayload) => void;
  [SOCKET_EVENTS.STATE_UPDATE]: (payload: StateUpdatePayload) => void;
  [SOCKET_EVENTS.SERVER_SHUTDOWN]: (payload: ServerShutdownPayload) => void;
}
