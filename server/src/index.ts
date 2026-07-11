/**
 * HTTP + Socket.IO entrypoint. Wires the transport-agnostic {@link LobbyManager}
 * to the shared socket protocol and implements the production ops contract
 * (deploy/OPERATIONS.md): `GET /healthz`, env-var configuration, the
 * empty-room reaper sweep, structured JSON logging, and SIGTERM/SIGINT
 * graceful shutdown.
 */
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import {
  SOCKET_EVENTS,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@imperium/shared";
import { LobbyManager, LobbyError, MAX_PLAYERS } from "./lobby/lobbyManager.js";
import { log } from "./log.js";
import {
  parseCreateGamePayload,
  parseJoinGamePayload,
  parsePickFactionPayload,
  parseRejoinGamePayload,
} from "./validate.js";

type ImperiumServer = Server<ClientToServerEvents, ServerToClientEvents>;

/** Env defaults live in code so a bare `node dist/index.js` boots (§2). */
const DEFAULT_PORT = 8080;
const DEFAULT_ROOM_TTL_SECONDS = 3600;
/** Graceful-shutdown drain window (§3): force close after this long. */
const DRAIN_TIMEOUT_MS = 20_000;
const DRAIN_POLL_MS = 250;
/** Reconnect hint sent with `server_shutdown` (§3). */
const RECONNECT_AFTER_MS = 5_000;

/** Read a positive-integer env var, falling back on unset/garbage values. */
function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Parse `CORS_ORIGIN` (comma-separated origin list, entries trimmed) into a
 * value usable by both the Express cors middleware and the socket.io `cors`
 * config (§2 — the same list MUST gate both layers). When unset: deny
 * cross-origin in production; default to the local Vite dev client otherwise.
 */
export function parseCorsOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] | false {
  const raw = env.CORS_ORIGIN;
  if (raw !== undefined) {
    const origins = raw
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
    return origins.length > 0 ? origins : false;
  }
  return env.NODE_ENV === "production" ? false : ["http://localhost:5173"];
}

/** Options for {@link createApp}; overridable for tests. */
export interface CreateAppOptions {
  /** Empty-room TTL; defaults to the ROOM_TTL_SECONDS env var (§2). */
  roomTtlSeconds?: number;
  /** Reaper sweep cadence; defaults to min(roomTtlSeconds, 60) seconds. */
  reapIntervalMs?: number;
}

export function createApp(options: CreateAppOptions = {}) {
  const corsOrigins = parseCorsOrigins();
  const lobby = new LobbyManager();

  // Periodic empty-room reap (§2 ROOM_TTL_SECONDS). LobbyManager owns the
  // eligibility logic; this sweep just ticks it and logs the results. It is
  // owned by createApp so every boot path (entrypoint, tests, smoke) reaps.
  const roomTtlSeconds =
    options.roomTtlSeconds ?? envInt("ROOM_TTL_SECONDS", DEFAULT_ROOM_TTL_SECONDS);
  const reapIntervalMs =
    options.reapIntervalMs ?? Math.min(roomTtlSeconds, 60) * 1000;
  let reaper: NodeJS.Timeout | null = null;
  const startReaper = () => {
    if (reaper) return;
    reaper = setInterval(() => {
      for (const code of lobby.reapEmptyRooms(roomTtlSeconds)) {
        log(
          "info",
          "room_reaped",
          `empty room reaped after ROOM_TTL_SECONDS=${roomTtlSeconds}`,
          { roomCode: code },
        );
      }
    }, reapIntervalMs);
    reaper.unref();
  };
  const stopReaper = () => {
    if (reaper) {
      clearInterval(reaper);
      reaper = null;
    }
  };
  startReaper();

  const app = express();
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json());

  // Health probe (§1): cheap O(1) reads only — no game logic, no I/O.
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      rooms: lobby.roomCount,
      uptime: Math.floor(process.uptime()),
    });
  });

  const httpServer = createServer(app);
  const io: ImperiumServer = new Server<
    ClientToServerEvents,
    ServerToClientEvents
  >(httpServer, {
    cors: { origin: corsOrigins, methods: ["GET", "POST"] },
  });

  io.on("connection", (socket) => {
    // Track which player this socket is acting as, for disconnect handling.
    let playerId: string | null = null;
    let roomCode: string | null = null;

    const emitError = (message: string) => {
      socket.emit(SOCKET_EVENTS.ERROR_MSG, { message });
    };

    const broadcastLobby = (code: string) => {
      const room = lobby.getRoom(code);
      if (room) {
        io.to(code).emit(
          SOCKET_EVENTS.LOBBY_UPDATE,
          LobbyManager.toLobbyUpdate(room),
        );
      }
    };

    /**
     * Top-level error boundary for socket handlers: a socket event must NEVER
     * crash the process (socket.io v4 does not catch listener throws — an
     * unguarded exception here is an unauthenticated remote kill).
     *
     * The wrapped handler receives the raw first emit argument as `unknown`
     * (never destructured in param position, so a payload-less emit cannot
     * throw before we run); extra junk arguments are dropped. Any throw is
     * answered to the emitting socket as `error_msg` — LobbyError messages
     * verbatim, anything unexpected as a generic line so internals never
     * leak — and logged as a single-line JSON entry.
     */
    const boundary =
      (event: string, handler: (payload: unknown) => void) =>
      (...args: unknown[]): void => {
        try {
          handler(args[0]);
        } catch (err) {
          if (err instanceof LobbyError) {
            emitError(err.message);
            log("warn", "socket_event_rejected", err.message, {
              ...(roomCode ? { roomCode } : {}),
              socketEvent: event,
            });
          } else {
            emitError("Unexpected server error.");
            log(
              "error",
              "socket_handler_error",
              err instanceof Error ? err.message : String(err),
              {
                ...(roomCode ? { roomCode } : {}),
                socketEvent: event,
                ...(err instanceof Error && err.stack
                  ? { stack: err.stack }
                  : {}),
              },
            );
          }
        }
      };

    socket.on(
      SOCKET_EVENTS.CREATE_GAME,
      boundary(SOCKET_EVENTS.CREATE_GAME, (raw) => {
        const parsed = parseCreateGamePayload(raw);
        if (!parsed.ok) return emitError(parsed.error);
        const { room, player } = lobby.createGame(parsed.value.playerName);
        playerId = player.id;
        roomCode = room.code;
        socket.join(room.code);
        socket.emit(SOCKET_EVENTS.GAME_CREATED, {
          roomCode: room.code,
          playerId: player.id,
          sessionToken: player.sessionToken,
        });
        broadcastLobby(room.code);
        log(
          "info",
          "room_created",
          `room created by ${player.name} (2-${MAX_PLAYERS} players)`,
          { roomCode: room.code },
        );
      }),
    );

    socket.on(
      SOCKET_EVENTS.JOIN_GAME,
      boundary(SOCKET_EVENTS.JOIN_GAME, (raw) => {
        const parsed = parseJoinGamePayload(raw);
        if (!parsed.ok) return emitError(parsed.error);
        const { room, player } = lobby.joinGame(
          parsed.value.roomCode,
          parsed.value.playerName,
        );
        playerId = player.id;
        roomCode = room.code;
        socket.join(room.code);
        socket.emit(SOCKET_EVENTS.GAME_CREATED, {
          roomCode: room.code,
          playerId: player.id,
          sessionToken: player.sessionToken,
        });
        broadcastLobby(room.code);
        log(
          "info",
          "player_joined",
          `${player.name} joined (${room.players.length}/${MAX_PLAYERS} seats filled)`,
          { roomCode: room.code },
        );
      }),
    );

    socket.on(
      SOCKET_EVENTS.REJOIN_GAME,
      boundary(SOCKET_EVENTS.REJOIN_GAME, (raw) => {
        const parsed = parseRejoinGamePayload(raw);
        if (!parsed.ok) return emitError(parsed.error);
        const { room, player } = lobby.rejoinGame(
          parsed.value.roomCode,
          parsed.value.sessionToken,
        );
        playerId = player.id;
        roomCode = room.code;
        socket.join(room.code);
        // Everyone (including the rejoiner) sees the seat flip connected.
        broadcastLobby(room.code);
        if (room.startedByHost && room.state) {
          // Mid-game resume: replay game_started for screen routing, then
          // the authoritative snapshot. Per-action state_update broadcasts
          // arrive with the action engine (engine/actions.ts reducer).
          socket.emit(SOCKET_EVENTS.GAME_STARTED, { state: room.state });
          socket.emit(SOCKET_EVENTS.STATE_UPDATE, { state: room.state });
        }
        log(
          "info",
          "player_rejoined",
          `${player.name} reattached to their seat`,
          { roomCode: room.code },
        );
      }),
    );

    socket.on(
      SOCKET_EVENTS.PICK_FACTION,
      boundary(SOCKET_EVENTS.PICK_FACTION, (raw) => {
        const parsed = parsePickFactionPayload(raw);
        if (!parsed.ok) return emitError(parsed.error);
        if (!roomCode || !playerId) {
          return emitError("You are not in a game.");
        }
        lobby.pickFaction(roomCode, playerId, parsed.value.faction);
        broadcastLobby(roomCode);
      }),
    );

    // start_game/leave_game carry no payload; junk arguments are ignored.
    socket.on(
      SOCKET_EVENTS.START_GAME,
      boundary(SOCKET_EVENTS.START_GAME, () => {
        if (!roomCode || !playerId) {
          return emitError("You are not in a game.");
        }
        const { state } = lobby.startGame(roomCode, playerId);
        broadcastLobby(roomCode);
        io.to(roomCode).emit(SOCKET_EVENTS.GAME_STARTED, { state });
        log(
          "info",
          "game_started",
          `game started with ${state.players.length} players`,
          { roomCode },
        );
      }),
    );

    socket.on(
      SOCKET_EVENTS.LEAVE_GAME,
      boundary(SOCKET_EVENTS.LEAVE_GAME, () => {
        if (!roomCode || !playerId) return;
        const code = roomCode;
        const name = lobby
          .getRoom(code)
          ?.players.find((p) => p.id === playerId)?.name;
        lobby.leaveGame(code, playerId);
        socket.leave(code);
        broadcastLobby(code);
        log("info", "player_left", `${name ?? "player"} left`, {
          roomCode: code,
        });
        playerId = null;
        roomCode = null;
      }),
    );

    socket.on("disconnect", () => {
      // No emitError here — the socket is already gone; just never throw.
      try {
        if (playerId) lobby.markDisconnected(playerId);
        if (roomCode) {
          broadcastLobby(roomCode);
          log("info", "player_disconnected", "socket disconnected; seat held", {
            roomCode,
          });
        }
      } catch (err) {
        log(
          "error",
          "socket_handler_error",
          err instanceof Error ? err.message : String(err),
          { ...(roomCode ? { roomCode } : {}), socketEvent: "disconnect" },
        );
      }
    });
  });

  return { app, httpServer, io, lobby, startReaper, stopReaper };
}

/**
 * Resolve true once every socket has disconnected, or false when the
 * `deadlineMs` drain window elapses first (§3 step 3).
 */
function waitForSocketDrain(
  io: ImperiumServer,
  deadlineMs: number,
): Promise<boolean> {
  if (io.of("/").sockets.size === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (io.of("/").sockets.size === 0) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - startedAt >= deadlineMs) {
        clearInterval(poll);
        resolve(false);
      }
    }, DRAIN_POLL_MS);
  });
}

// Only start listening when run directly (not when imported by tests/smoke).
// Compare resolved filesystem paths on both sides: argv[1] may be relative
// (`node dist/index.js`), so a naive `file://${argv[1]}` URL never matched.
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const PORT = envInt("PORT", DEFAULT_PORT);

  // createApp owns the ROOM_TTL_SECONDS reaper lifecycle (started by default).
  const { httpServer, io, lobby, stopReaper } = createApp();

  // Bind 0.0.0.0 (§2): loopback binds are invisible to container networking.
  httpServer.listen(PORT, "0.0.0.0", () => {
    log("info", "server_started", `IMPERIUM server listening on 0.0.0.0:${PORT}`);
  });

  // Graceful shutdown (§3). SIGINT is handled identically to SIGTERM.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopReaper();

    // 1. Stop accepting new rooms: create_game now answers with error_msg.
    lobby.beginShutdown();

    // 2. Tell every connected client we are going away, with a reconnect hint.
    io.emit(SOCKET_EVENTS.SERVER_SHUTDOWN, {
      reconnectAfterMs: RECONNECT_AFTER_MS,
    });
    log(
      "info",
      "shutdown",
      `${signal}: new rooms refused, server_shutdown broadcast, draining up to ${DRAIN_TIMEOUT_MS / 1000}s`,
    );

    // 3. Drain: close as soon as all sockets disconnect, force at the deadline.
    const drained = await waitForSocketDrain(io, DRAIN_TIMEOUT_MS);
    log(
      "info",
      "shutdown",
      drained
        ? "drain complete: all sockets disconnected"
        : `drain deadline reached after ${DRAIN_TIMEOUT_MS / 1000}s, forcing close`,
    );

    // 4. Close socket.io + HTTP, then exit 0 — a drained shutdown is a
    // success; non-zero exits trip platform crash-loop detection.
    io.close(() => {
      log("info", "shutdown", "server closed, exiting 0");
      process.exit(0);
    });
    // Safety net: never hang past close; still a successful shutdown.
    setTimeout(() => process.exit(0), 2_000);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
