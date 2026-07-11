/**
 * In-memory lobby/room management. This module is deliberately transport
 * agnostic: it knows nothing about Socket.IO. The socket layer in index.ts
 * translates its results and thrown {@link LobbyError}s into wire events.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  Faction,
  type GameState,
  type LobbyUpdatePayload,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../engine/gameState.js";
import { log } from "../log.js";
import { isFaction, PLAYER_NAME_MAX_LENGTH } from "../validate.js";

/** Domain error surfaced to clients as `error_msg`. */
export class LobbyError extends Error {}

/** A player as tracked inside a lobby (superset of the wire roster row). */
export interface LobbyPlayerState {
  id: string;
  name: string;
  faction: Faction | null;
  isHost: boolean;
  connected: boolean;
  /**
   * Per-player crypto-random secret issued on create/join and returned to the
   * client in its `game_created` ack. Presenting it in `rejoin_game` reclaims
   * this seat; it is NEVER included in broadcast payloads.
   */
  sessionToken: string;
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
   * ROOM_TTL_SECONDS reaper (docs/ARCHITECTURE.md, Operations — env-var
   * table; deploy/OPERATIONS.md §2 arrives with PR #4 and mirrors it).
   */
  emptySince: number | null;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ROOM_CODE_LENGTH = 6;
const MIN_PLAYERS_TO_START = 2;
/** Max seats per room (docs/ARCHITECTURE.md §6). */
export const MAX_PLAYERS = 5;

/** Crypto-random, URL-safe session token (192 bits). */
function generateSessionToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Crypto-random 32-bit game seed. The seed drives the ENTIRE deck shuffle and
 * every roll, so it must be UNPREDICTABLE: `createInitialState` otherwise falls
 * back to `hashSeed(roomCode)`, and the room code is public (shown in the lobby,
 * shared to join), which would let anyone who knows the code reconstruct the
 * "hidden" deck ordering — defeating the fog-of-war projection. Randomising it
 * here (transport layer; the engine stays pure and merely receives the seed)
 * closes that root cause; the seed is never broadcast (see engine/projection.ts).
 */
function generateGameSeed(): number {
  return randomBytes(4).readUInt32LE(0);
}

/**
 * TEST-ONLY knob (docs/ARCHITECTURE.md, Operations — test-only knobs): when
 * `GAME_SEED` is set to a valid 32-bit unsigned integer, every game started by
 * this process uses that seed instead of {@link generateGameSeed}. This makes
 * whole games byte-for-byte reproducible (deck order, every roll), which the
 * Playwright E2E suite depends on. It also makes the "hidden" deck ordering
 * reconstructable by anyone who knows the seed — NEVER set it in production;
 * a loud `test_knob_active` warning is logged on every game start while it is
 * active. Garbage values are ignored (crypto-random fallback) with a warning.
 */
export function gameSeedFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.GAME_SEED;
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    log(
      "warn",
      "test_knob_invalid",
      `GAME_SEED=${raw.slice(0, 32)} is not a 32-bit unsigned integer; ignored (crypto-random seed used)`,
    );
    return null;
  }
  return value;
}

/**
 * TEST-ONLY knob (documented beside GAME_SEED): when `PRESTIGE_TARGET` is set
 * to a positive integer, games started by this process carry it as
 * `GameState.prestigeTarget`, and `prestige.decideWinner` uses it instead of
 * the ratified §13.2 `balance.PRESTIGE_THRESHOLDS`. Lets an E2E run reach a
 * REAL engine victory (checked at Cleanup as always) within a few rounds.
 * Default off; loudly logged while active; garbage values ignored with a
 * warning. The engine stays pure — the value rides on state from creation.
 */
export function prestigeTargetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.PRESTIGE_TARGET;
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    log(
      "warn",
      "test_knob_invalid",
      `PRESTIGE_TARGET=${raw.slice(0, 32)} is not a positive integer; ignored (ratified §13.2 thresholds used)`,
    );
    return null;
  }
  return value;
}

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
   * Enter shutdown mode (SIGTERM/SIGINT — docs/ARCHITECTURE.md, Operations,
   * "Graceful shutdown"; deploy/OPERATIONS.md §3 arrives with PR #4 and
   * mirrors it): new rooms are refused with a LobbyError while existing
   * rooms keep playing.
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
        // crypto.randomInt: room codes are capability-ish (they gate joins),
        // so they must not come from a predictable Math.random() stream.
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  /** Create a new room hosted by the given player. */
  createGame(playerName: string): { room: Room; player: LobbyPlayerState } {
    if (this.shuttingDown) {
      throw new LobbyError("Server restarting, retry shortly.");
    }
    const name = normalizePlayerName(playerName);

    const code = this.generateRoomCode();
    const player: LobbyPlayerState = {
      id: randomUUID(),
      name,
      faction: null,
      isHost: true,
      connected: true,
      sessionToken: generateSessionToken(),
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
    const name = normalizePlayerName(playerName);

    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) throw new LobbyError(`No game found with code ${roomCode}.`);
    if (room.startedByHost) {
      throw new LobbyError("That game has already started.");
    }
    // A same-name join is a clean rejection, never a silent duplicate seat.
    // Reclaiming an existing seat goes through rejoinGame (sessionToken).
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new LobbyError(
        `That name is already taken in this game. If you were disconnected, rejoin from your original browser tab.`,
      );
    }
    if (room.players.length >= MAX_PLAYERS) {
      throw new LobbyError(`That game is full (max ${MAX_PLAYERS} players).`);
    }

    const player: LobbyPlayerState = {
      id: randomUUID(),
      name,
      faction: null,
      isHost: false,
      connected: true,
      sessionToken: generateSessionToken(),
    };
    room.players.push(player);
    this.refreshEmptySince(room);
    return { room, player };
  }

  /**
   * Reattach a returning player to their existing seat by session token.
   * Unlike joinGame this never creates a seat and is allowed after game
   * start. Throws LobbyError on unknown room or token mismatch.
   */
  rejoinGame(
    roomCode: string,
    sessionToken: string,
  ): { room: Room; player: LobbyPlayerState } {
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) throw new LobbyError(`No game found with code ${roomCode}.`);

    const player = room.players.find((p) => p.sessionToken === sessionToken);
    if (!player) {
      throw new LobbyError("Invalid session token for this game.");
    }

    player.connected = true;
    this.refreshEmptySince(room);
    return { room, player };
  }

  /** Claim a faction, rejecting any already taken by another player. */
  pickFaction(
    roomCode: string,
    playerId: string,
    faction: Faction,
  ): { room: Room } {
    // Canonical-enum check lives HERE, not just in the socket layer: no
    // transport may ever get an arbitrary string assigned to a seat and
    // broadcast to every player via lobby_update.
    if (!isFaction(faction)) {
      throw new LobbyError(
        `Unknown faction: ${String(faction).slice(0, 32)}`,
      );
    }

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

    // Inject an unpredictable seed (NOT the public-room-code default) so the
    // deck ordering cannot be reconstructed from the room code alone. The two
    // TEST-ONLY env knobs below (GAME_SEED / PRESTIGE_TARGET) are default-off
    // and warn loudly whenever they shape a game — never set in production.
    const seedOverride = gameSeedFromEnv();
    if (seedOverride !== null) {
      log(
        "warn",
        "test_knob_active",
        `GAME_SEED=${seedOverride} — TEST-ONLY deterministic seed override active; games are reproducible and deck order is NOT secret. Never set in production.`,
        { roomCode: room.code },
      );
    }
    const prestigeTarget = prestigeTargetFromEnv();
    if (prestigeTarget !== null) {
      log(
        "warn",
        "test_knob_active",
        `PRESTIGE_TARGET=${prestigeTarget} — TEST-ONLY victory-threshold override active; §13.2 ratified thresholds are bypassed. Never set in production.`,
        { roomCode: room.code },
      );
    }
    const state = createInitialState(
      room.code,
      seats,
      seedOverride ?? generateGameSeed(),
      prestigeTarget !== null ? { prestigeTarget } : undefined,
    );
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

  /** Project a room into the `lobby_update` wire payload (no sessionToken). */
  static toLobbyUpdate(room: Room): LobbyUpdatePayload {
    return {
      roomCode: room.code,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        faction: p.faction,
        isHost: p.isHost,
        connected: p.connected,
      })),
      startedByHost: room.startedByHost,
    };
  }
}

/**
 * Trim and bound a display name (1–{@link PLAYER_NAME_MAX_LENGTH} chars).
 * Enforced here — not only in the socket guards — so every transport and
 * internal caller gets the same limits.
 */
function normalizePlayerName(playerName: string): string {
  const name = typeof playerName === "string" ? playerName.trim() : "";
  if (!name) throw new LobbyError("A player name is required.");
  if (name.length > PLAYER_NAME_MAX_LENGTH) {
    throw new LobbyError(
      `Player names are limited to ${PLAYER_NAME_MAX_LENGTH} characters.`,
    );
  }
  return name;
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
