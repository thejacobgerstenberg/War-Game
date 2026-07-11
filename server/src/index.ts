/**
 * HTTP + Socket.IO entrypoint. Wires the transport-agnostic {@link LobbyManager}
 * to the shared socket protocol and implements the production ops contract
 * (deploy/OPERATIONS.md): `GET /healthz`, env-var configuration, the
 * empty-room reaper sweep, structured JSON logging, and SIGTERM/SIGINT
 * graceful shutdown.
 */
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import {
  SOCKET_EVENTS,
  type ClientToServerEvents,
  type CreateGamePayload,
  type JoinGamePayload,
  type PickFactionPayload,
  type ServerToClientEvents,
} from "@imperium/shared";
import { LobbyManager, LobbyError } from "./lobby/lobbyManager.js";
import { log } from "./log.js";

type ImperiumServer = Server<ClientToServerEvents, ServerToClientEvents>;

/** Env defaults live in code so a bare `node dist/index.js` boots (§2). */
const DEFAULT_PORT = 8080;
const DEFAULT_ROOM_TTL_SECONDS = 3600;
/** Max seats per room (docs/ARCHITECTURE.md §6). */
const MAX_PLAYERS = 5;
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

export function createApp() {
  const corsOrigins = parseCorsOrigins();
  const lobby = new LobbyManager();

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

    socket.on(
      SOCKET_EVENTS.CREATE_GAME,
      ({ playerName }: CreateGamePayload) => {
        try {
          const { room, player } = lobby.createGame(playerName);
          playerId = player.id;
          roomCode = room.code;
          socket.join(room.code);
          socket.emit(SOCKET_EVENTS.GAME_CREATED, {
            roomCode: room.code,
            playerId: player.id,
          });
          broadcastLobby(room.code);
          log(
            "info",
            "room_created",
            `room created by ${player.name} (2-${MAX_PLAYERS} players)`,
            { roomCode: room.code },
          );
        } catch (err) {
          emitError(errMessage(err));
        }
      },
    );

    socket.on(
      SOCKET_EVENTS.JOIN_GAME,
      ({ roomCode: code, playerName }: JoinGamePayload) => {
        try {
          const { room, player } = lobby.joinGame(code, playerName);
          playerId = player.id;
          roomCode = room.code;
          socket.join(room.code);
          socket.emit(SOCKET_EVENTS.GAME_CREATED, {
            roomCode: room.code,
            playerId: player.id,
          });
          broadcastLobby(room.code);
          log(
            "info",
            "player_joined",
            `${player.name} joined (${room.players.length}/${MAX_PLAYERS} seats filled)`,
            { roomCode: room.code },
          );
        } catch (err) {
          emitError(errMessage(err));
        }
      },
    );

    socket.on(
      SOCKET_EVENTS.PICK_FACTION,
      ({ faction }: PickFactionPayload) => {
        if (!roomCode || !playerId) {
          return emitError("You are not in a game.");
        }
        try {
          lobby.pickFaction(roomCode, playerId, faction);
          broadcastLobby(roomCode);
        } catch (err) {
          emitError(errMessage(err));
        }
      },
    );

    socket.on(SOCKET_EVENTS.START_GAME, () => {
      if (!roomCode || !playerId) {
        return emitError("You are not in a game.");
      }
      try {
        const { state } = lobby.startGame(roomCode, playerId);
        broadcastLobby(roomCode);
        io.to(roomCode).emit(SOCKET_EVENTS.GAME_STARTED, { state });
        log(
          "info",
          "game_started",
          `game started with ${state.players.length} players`,
          { roomCode },
        );
      } catch (err) {
        emitError(errMessage(err));
      }
    });

    socket.on(SOCKET_EVENTS.LEAVE_GAME, () => {
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
    });

    socket.on("disconnect", () => {
      if (playerId) lobby.markDisconnected(playerId);
      if (roomCode) {
        broadcastLobby(roomCode);
        log("info", "player_disconnected", "socket disconnected; seat held", {
          roomCode,
        });
      }
    });
  });

  return { app, httpServer, io, lobby };
}

function errMessage(err: unknown): string {
  if (err instanceof LobbyError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected server error.";
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
const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const PORT = envInt("PORT", DEFAULT_PORT);
  const ROOM_TTL_SECONDS = envInt("ROOM_TTL_SECONDS", DEFAULT_ROOM_TTL_SECONDS);

  const { httpServer, io, lobby } = createApp();

  // Periodic empty-room reap (§2 ROOM_TTL_SECONDS). LobbyManager owns the
  // eligibility logic; this sweep just ticks it and logs the results.
  const sweepMs = Math.min(ROOM_TTL_SECONDS, 60) * 1000;
  const reaper = setInterval(() => {
    for (const code of lobby.reapEmptyRooms(ROOM_TTL_SECONDS)) {
      log(
        "info",
        "room_reaped",
        `empty room reaped after ROOM_TTL_SECONDS=${ROOM_TTL_SECONDS}`,
        { roomCode: code },
      );
    }
  }, sweepMs);
  reaper.unref();

  // Bind 0.0.0.0 (§2): loopback binds are invisible to container networking.
  httpServer.listen(PORT, "0.0.0.0", () => {
    log("info", "server_started", `IMPERIUM server listening on 0.0.0.0:${PORT}`);
  });

  // Graceful shutdown (§3). SIGINT is handled identically to SIGTERM.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reaper);

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
