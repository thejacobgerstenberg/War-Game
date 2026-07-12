/**
 * Socket.IO wire protocol shared by server and client.
 *
 * Both sides import {@link SOCKET_EVENTS} and the payload interfaces below so
 * event names and shapes can never drift apart.
 */
import type { Faction, GameState } from "../types/gameState.js";
import type { GameAction } from "../types/actions.js";

/** Canonical event-name registry. */
export const SOCKET_EVENTS = {
  // Client -> Server
  CREATE_GAME: "create_game",
  JOIN_GAME: "join_game",
  REJOIN_GAME: "rejoin_game",
  PICK_FACTION: "pick_faction",
  START_GAME: "start_game",
  LEAVE_GAME: "leave_game",
  /** In-game player command, dispatched to the engine reducer. */
  GAME_ACTION: "game_action",
  /** Host-only: seat an AI opponent in the lobby. */
  ADD_BOT: "add_bot",
  /** Host-only: remove a bot seat (lobby only, before start). */
  REMOVE_BOT: "remove_bot",

  // Server -> Client
  GAME_CREATED: "game_created",
  LOBBY_UPDATE: "lobby_update",
  GAME_STARTED: "game_started",
  ERROR_MSG: "error_msg",
  STATE_UPDATE: "state_update",
  /** Full authoritative game state (post-action broadcast). */
  STATE_SNAPSHOT: "state_snapshot",
  /** A rejected {@link GameAction}, with a human-readable reason. */
  ACTION_REJECTED: "action_rejected",
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

/**
 * An in-game player command. The server validates `sessionToken` against the
 * seat, then dispatches `action` to the engine reducer. On success it
 * broadcasts a fresh {@link StateSnapshotPayload}; on rejection it replies with
 * {@link ActionRejectedPayload} to the issuing socket only.
 */
export interface GameActionPayload {
  roomCode: string;
  sessionToken: string;
  action: GameAction;
}

/** Difficulty tiers an AI opponent can be seated at. */
export type BotDifficulty = "EASY" | "NORMAL" | "HARD";

/**
 * Host-only request to seat an AI opponent. The server picks the bot's
 * faction (first unclaimed) and names it after that faction's historical
 * ruler; the new seat appears in the next `lobby_update` with `isBot: true`.
 */
export interface AddBotPayload {
  difficulty: BotDifficulty;
}

/** Host-only request to remove a bot seat (lobby only, before game start). */
export interface RemoveBotPayload {
  /** The bot seat's player id, as seen in `lobby_update`. */
  botPlayerId: string;
}

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
  /**
   * True for AI-opponent seats (host-added via `add_bot`, or a disconnected
   * human seat taken over by a bot). Absent/false for human seats.
   */
  isBot?: boolean;
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
 * Full authoritative snapshot after an action is applied. (A future phase may
 * add a `state_diff` variant; for now the engine broadcasts whole snapshots.)
 */
export interface StateSnapshotPayload {
  state: GameState;
}

/** Sent to the issuing socket when a {@link GameAction} is rejected. */
export interface ActionRejectedPayload {
  /** Human-readable reason (engine error message). */
  reason: string;
  /** Machine-readable engine error code, when available. */
  code?: string;
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
  [SOCKET_EVENTS.GAME_ACTION]: (payload: GameActionPayload) => void;
  [SOCKET_EVENTS.ADD_BOT]: (payload: AddBotPayload) => void;
  [SOCKET_EVENTS.REMOVE_BOT]: (payload: RemoveBotPayload) => void;
}

export interface ServerToClientEvents {
  [SOCKET_EVENTS.GAME_CREATED]: (payload: GameCreatedPayload) => void;
  [SOCKET_EVENTS.LOBBY_UPDATE]: (payload: LobbyUpdatePayload) => void;
  [SOCKET_EVENTS.GAME_STARTED]: (payload: GameStartedPayload) => void;
  [SOCKET_EVENTS.ERROR_MSG]: (payload: ErrorMsgPayload) => void;
  [SOCKET_EVENTS.STATE_UPDATE]: (payload: StateUpdatePayload) => void;
  [SOCKET_EVENTS.STATE_SNAPSHOT]: (payload: StateSnapshotPayload) => void;
  [SOCKET_EVENTS.ACTION_REJECTED]: (payload: ActionRejectedPayload) => void;
  [SOCKET_EVENTS.SERVER_SHUTDOWN]: (payload: ServerShutdownPayload) => void;
}
