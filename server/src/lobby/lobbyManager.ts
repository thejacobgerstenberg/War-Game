/**
 * In-memory lobby/room management. This module is deliberately transport
 * agnostic: it knows nothing about Socket.IO. The socket layer in index.ts
 * translates its results and thrown {@link LobbyError}s into wire events.
 */
import { randomUUID } from "node:crypto";
import {
  Faction,
  type GameState,
  type LobbyUpdatePayload,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../engine/gameState.js";

/** Domain error surfaced to clients as `error_msg`. */
export class LobbyError extends Error {}

/** A player as tracked inside a lobby (superset of the wire roster row). */
export interface LobbyPlayerState {
  id: string;
  name: string;
  faction: Faction | null;
  isHost: boolean;
  connected: boolean;
}

/** A single game room. */
export interface Room {
  code: string;
  players: LobbyPlayerState[];
  startedByHost: boolean;
  state: GameState | null;
  /**
   * Epoch-ms timestamp of when the room last became empty (0 connected
   * players), or null while at least one player is connected. Drives the
   * ROOM_TTL_SECONDS reaper (deploy/OPERATIONS.md §2).
   */
  emptySince: number | null;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ROOM_CODE_LENGTH = 6;
const MIN_PLAYERS_TO_START = 2;

/** Constructor options; the clock is injectable for deterministic tests. */
export interface LobbyManagerOptions {
  /** Epoch-ms clock; defaults to Date.now. */
  now?: () => number;
}

export class LobbyManager {
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;
  private shuttingDown = false;

  constructor(options: LobbyManagerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Read-only lookup (used by the socket layer and tests). */
  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** O(1) live-room count, read by `GET /healthz`. */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** True once {@link beginShutdown} has been called. */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Enter shutdown mode (SIGTERM/SIGINT, deploy/OPERATIONS.md §3): new rooms
   * are refused with a LobbyError while existing rooms keep playing.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /**
   * Recompute a room's empty-since marker after any connectivity change.
   * A room is "empty" when it has zero connected players.
   */
  private refreshEmptySince(room: Room): void {
    if (room.players.some((p) => p.connected)) {
      room.emptySince = null;
    } else if (room.emptySince === null) {
      room.emptySince = this.now();
    }
  }

  /**
   * Delete every room that has been empty (0 connected players) for at least
   * `ttlSeconds`. Returns the reaped room codes so the caller can log
   * `room_reaped` for each. Called from a periodic sweep in index.ts.
   */
  reapEmptyRooms(ttlSeconds: number): string[] {
    const reaped: string[] = [];
    const ttlMs = ttlSeconds * 1000;
    for (const [code, room] of this.rooms) {
      if (room.emptySince !== null && this.now() - room.emptySince >= ttlMs) {
        this.rooms.delete(code);
        reaped.push(code);
      }
    }
    return reaped;
  }

  /** Find the room a given player belongs to, if any. */
  findRoomByPlayer(playerId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.players.some((p) => p.id === playerId)) return room;
    }
    return undefined;
  }

  private generateRoomCode(): string {
    let code = "";
    do {
      code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        const idx = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
        code += ROOM_CODE_ALPHABET[idx];
      }
    } while (this.rooms.has(code));
    return code;
  }

  /** Create a new room hosted by the given player. */
  createGame(playerName: string): { room: Room; player: LobbyPlayerState } {
    if (this.shuttingDown) {
      throw new LobbyError("Server restarting, retry shortly.");
    }
    const name = playerName.trim();
    if (!name) throw new LobbyError("A player name is required.");

    const code = this.generateRoomCode();
    const player: LobbyPlayerState = {
      id: randomUUID(),
      name,
      faction: null,
      isHost: true,
      connected: true,
    };
    const room: Room = {
      code,
      players: [player],
      startedByHost: false,
      state: null,
      emptySince: null,
    };
    this.rooms.set(code, room);
    return { room, player };
  }

  /** Add a player to an existing room. */
  joinGame(
    roomCode: string,
    playerName: string,
  ): { room: Room; player: LobbyPlayerState } {
    const name = playerName.trim();
    if (!name) throw new LobbyError("A player name is required.");

    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) throw new LobbyError(`No game found with code ${roomCode}.`);
    if (room.startedByHost) {
      throw new LobbyError("That game has already started.");
    }

    const player: LobbyPlayerState = {
      id: randomUUID(),
      name,
      faction: null,
      isHost: false,
      connected: true,
    };
    room.players.push(player);
    this.refreshEmptySince(room);
    return { room, player };
  }

  /** Claim a faction, rejecting any already taken by another player. */
  pickFaction(
    roomCode: string,
    playerId: string,
    faction: Faction,
  ): { room: Room } {
    const room = this.rooms.get(roomCode);
    if (!room) throw new LobbyError(`No game found with code ${roomCode}.`);

    const player = room.players.find((p) => p.id === playerId);
    if (!player) throw new LobbyError("You are not seated in this game.");

    const takenBy = room.players.find(
      (p) => p.faction === faction && p.id !== playerId,
    );
    if (takenBy) {
      throw new LobbyError(`${faction} has already been chosen.`);
    }

    player.faction = faction;
    return { room };
  }

  /** Start the game. Only the host may start, and only with enough players. */
  startGame(
    roomCode: string,
    playerId: string,
  ): { room: Room; state: GameState } {
    const room = this.rooms.get(roomCode);
    if (!room) throw new LobbyError(`No game found with code ${roomCode}.`);

    const player = room.players.find((p) => p.id === playerId);
    if (!player) throw new LobbyError("You are not seated in this game.");
    if (!player.isHost) {
      throw new LobbyError("Only the host can start the game.");
    }
    if (room.players.length < MIN_PLAYERS_TO_START) {
      throw new LobbyError(
        `At least ${MIN_PLAYERS_TO_START} players are required to start.`,
      );
    }

    const seats: SeatInput[] = room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      // Assign any player who never picked a faction a default open one.
      faction: p.faction ?? assignDefaultFaction(room.players, i),
      isHost: p.isHost,
    }));

    const state = createInitialState(room.code, seats);
    room.state = state;
    room.startedByHost = true;
    return { room, state };
  }

  /** Remove a player. Reassigns host if needed and drops empty rooms. */
  leaveGame(roomCode: string, playerId: string): { room: Room | null } {
    const room = this.rooms.get(roomCode);
    if (!room) return { room: null };

    const idx = room.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return { room };

    const [removed] = room.players.splice(idx, 1);
    if (room.players.length === 0) {
      this.rooms.delete(roomCode);
      return { room: null };
    }
    if (removed.isHost) {
      room.players[0].isHost = true;
    }
    this.refreshEmptySince(room);
    return { room };
  }

  /** Mark a returning player connected again (reconnect by player id). */
  reconnect(playerId: string): { room: Room; player: LobbyPlayerState } | null {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return null;
    const player = room.players.find((p) => p.id === playerId)!;
    player.connected = true;
    this.refreshEmptySince(room);
    return { room, player };
  }

  /** Mark a player disconnected without removing them (allows reconnect). */
  markDisconnected(playerId: string): Room | null {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return null;
    const player = room.players.find((p) => p.id === playerId)!;
    player.connected = false;
    this.refreshEmptySince(room);
    return room;
  }

  /** Project a room into the `lobby_update` wire payload. */
  static toLobbyUpdate(room: Room): LobbyUpdatePayload {
    return {
      roomCode: room.code,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        faction: p.faction,
        isHost: p.isHost,
      })),
      startedByHost: room.startedByHost,
    };
  }
}

/** Pick the first faction not yet claimed by an earlier seat. */
function assignDefaultFaction(
  players: LobbyPlayerState[],
  seatIndex: number,
): Faction {
  const taken = new Set(
    players
      .slice(0, seatIndex)
      .map((p) => p.faction)
      .filter((f): f is Faction => f !== null),
  );
  for (const faction of Object.values(Faction)) {
    if (!taken.has(faction)) return faction;
  }
  // Fallback (more players than factions): reuse the first faction.
  return Object.values(Faction)[0];
}
