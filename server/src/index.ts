/**
 * HTTP + Socket.IO entrypoint. Wires the transport-agnostic {@link LobbyManager}
 * to the shared socket protocol and implements the production ops contract
 * (docs/ARCHITECTURE.md, Operations section; deploy/OPERATIONS.md arrives
 * with PR #4 and mirrors it): `GET /healthz`, env-var configuration, the
 * empty-room reaper sweep, structured JSON logging, and SIGTERM/SIGINT
 * graceful shutdown.
 */
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { Server, type DefaultEventsMap } from "socket.io";
import {
  SOCKET_EVENTS,
  type ClientToServerEvents,
  type GameState,
  type ServerToClientEvents,
} from "@imperium/shared";
import {
  applyAction,
  advancePhase,
  EngineError,
  projectStateFor,
} from "./engine/index.js";
import { LobbyManager, LobbyError, MAX_PLAYERS } from "./lobby/lobbyManager.js";
import { log } from "./log.js";
import {
  parseCreateGamePayload,
  parseGameActionPayload,
  parseJoinGamePayload,
  parsePickFactionPayload,
  parseRejoinGamePayload,
} from "./validate.js";

/**
 * Per-socket state the transport tracks so a per-seat projection can be sent to
 * every connected client in a room (fog of war — the raw state is never
 * broadcast). `playerId` is the seat this socket is acting as.
 */
interface SocketData {
  playerId: string | null;
  roomCode: string | null;
}

type ImperiumServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  DefaultEventsMap,
  SocketData
>;

/** Default per-turn action budget in seconds (§10; TURN_SECONDS overrides). */
const DEFAULT_TURN_SECONDS = 120;

/**
 * Resolve the per-turn timer budget from `TURN_SECONDS`. Returns null when
 * timers are disabled (`TURN_SECONDS=off` or `0`, e.g. hot-seat/casual play),
 * else a positive whole-second budget (default {@link DEFAULT_TURN_SECONDS}).
 */
function turnSecondsFromEnv(): number | null {
  const raw = process.env.TURN_SECONDS;
  if (raw !== undefined) {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "off" || trimmed === "0" || trimmed === "false") {
      return null;
    }
  }
  return envInt("TURN_SECONDS", DEFAULT_TURN_SECONDS);
}

/** The Server->Client events that carry a per-seat projected {state} payload. */
type StatePushEvent =
  | typeof SOCKET_EVENTS.GAME_STARTED
  | typeof SOCKET_EVENTS.STATE_SNAPSHOT
  | typeof SOCKET_EVENTS.STATE_UPDATE;

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

  /**
   * Live per-turn timers, keyed by room code. `deadline` (epoch ms) lets a
   * mid-game rejoiner be told the CURRENT deadline without resetting it. Defined
   * ahead of the reaper so a reaped room's timer is torn down with it.
   */
  interface TurnTimer {
    timeout: NodeJS.Timeout;
    deadline: number;
    turnSeconds: number;
  }
  const turnTimers = new Map<string, TurnTimer>();
  const clearTurnTimer = (code: string): void => {
    const timer = turnTimers.get(code);
    if (timer) {
      clearTimeout(timer.timeout);
      turnTimers.delete(code);
    }
  };
  const stopAllTurnTimers = (): void => {
    for (const timer of turnTimers.values()) clearTimeout(timer.timeout);
    turnTimers.clear();
  };

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
        clearTurnTimer(code);
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
    ServerToClientEvents,
    DefaultEventsMap,
    SocketData
  >(httpServer, {
    cors: { origin: corsOrigins, methods: ["GET", "POST"] },
  });

  /**
   * Broadcast an authoritative game state to a room as a PER-SEAT projection:
   * each connected socket receives `projectStateFor(state, itsOwnSeat)` so no
   * client ever sees another player's hand/objectives or the deck ordering. A
   * seatless socket (should not occur in a started room) gets a fully-hidden
   * view. Single-node, in-memory rooms → the local socket map is authoritative.
   */
  const pushState = (
    code: string,
    state: GameState,
    event: StatePushEvent,
  ): void => {
    const members = io.sockets.adapter.rooms.get(code);
    if (!members) return;
    for (const socketId of members) {
      const member = io.sockets.sockets.get(socketId);
      if (!member) continue;
      const view = projectStateFor(state, member.data.playerId ?? "");
      const payload = { state: view };
      // Emit the concrete event so socket.io keeps the payload strongly typed.
      if (event === SOCKET_EVENTS.GAME_STARTED) {
        member.emit(SOCKET_EVENTS.GAME_STARTED, payload);
      } else if (event === SOCKET_EVENTS.STATE_SNAPSHOT) {
        member.emit(SOCKET_EVENTS.STATE_SNAPSHOT, payload);
      } else {
        member.emit(SOCKET_EVENTS.STATE_UPDATE, payload);
      }
    }
  };

  /** Emit the current countdown tick for a room's active player. */
  const emitTurnTimer = (
    code: string,
    state: GameState,
    deadline: number,
    turnSeconds: number,
  ): void => {
    io.to(code).emit(SOCKET_EVENTS.TURN_TIMER, {
      roomCode: code,
      activePlayerId: state.turnOrder[state.activePlayerIndex] ?? null,
      deadline,
      turnSeconds,
    });
  };

  /**
   * Fired when the active player's clock expires: auto-advance the phase and
   * rebroadcast, then arm the next turn. ADVANCE_PHASE is the correct idle
   * progression here — the engine's action window is RECRUITMENT/MOVEMENT/
   * DIPLOMACY and advancePhase steps through them and runs the automatic phases;
   * PASS only zeroes a player's action budget WITHIN a phase and would not move
   * the game forward on its own. Never throws (a socket/timer callback must not
   * crash the process).
   */
  const onTurnTimeout = (code: string): void => {
    try {
      const room = lobby.getRoom(code);
      if (!room || !room.startedByHost || !room.state) {
        clearTurnTimer(code);
        return;
      }
      const next = advancePhase(room.state);
      room.state = next;
      log(
        "info",
        "turn_timeout",
        "active player's clock expired; phase auto-advanced",
        { roomCode: code },
      );
      pushState(code, next, SOCKET_EVENTS.STATE_UPDATE);
      if (next.winner) {
        clearTurnTimer(code);
        return;
      }
      scheduleTurnTimer(code);
    } catch (err) {
      clearTurnTimer(code);
      log(
        "error",
        "turn_timer_error",
        err instanceof Error ? err.message : String(err),
        { roomCode: code },
      );
    }
  };

  /**
   * Arm (or re-arm) the per-turn timer for a room and announce it via
   * `turn_timer`. No-op when timers are disabled, the game has not started, or
   * the game is over. The timeout is `unref`'d so it never keeps the process
   * alive on its own.
   */
  const scheduleTurnTimer = (code: string): void => {
    clearTurnTimer(code);
    const turnSeconds = turnSecondsFromEnv();
    if (turnSeconds === null) return;
    const room = lobby.getRoom(code);
    if (!room || !room.startedByHost || !room.state || room.state.winner) {
      return;
    }
    const deadline = Date.now() + turnSeconds * 1000;
    const timeout = setTimeout(() => onTurnTimeout(code), turnSeconds * 1000);
    timeout.unref();
    turnTimers.set(code, { timeout, deadline, turnSeconds });
    emitTurnTimer(code, room.state, deadline, turnSeconds);
  };

  io.on("connection", (socket) => {
    socket.data.playerId = null;
    socket.data.roomCode = null;
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
        socket.data.playerId = player.id;
        socket.data.roomCode = room.code;
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
        socket.data.playerId = player.id;
        socket.data.roomCode = room.code;
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
        socket.data.playerId = player.id;
        socket.data.roomCode = room.code;
        socket.join(room.code);
        // Everyone (including the rejoiner) sees the seat flip connected.
        broadcastLobby(room.code);
        if (room.startedByHost && room.state) {
          // Mid-game resume: replay game_started for screen routing, then the
          // authoritative snapshot — BOTH fog-of-war projected for THIS seat, so
          // a rejoiner never receives rivals' secrets or the deck ordering. The
          // legacy state_update is also re-sent (same projection) to preserve the
          // established rejoin contract for clients that key resume off it.
          const view = () => projectStateFor(room.state as GameState, player.id);
          socket.emit(SOCKET_EVENTS.GAME_STARTED, { state: view() });
          socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, { state: view() });
          socket.emit(SOCKET_EVENTS.STATE_UPDATE, { state: view() });
          // Hand the rejoiner the CURRENT countdown (do not reset the deadline).
          const timer = turnTimers.get(room.code);
          if (timer) {
            socket.emit(SOCKET_EVENTS.TURN_TIMER, {
              roomCode: room.code,
              activePlayerId:
                room.state.turnOrder[room.state.activePlayerIndex] ?? null,
              deadline: timer.deadline,
              turnSeconds: timer.turnSeconds,
            });
          }
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
        // Per-seat projected initial state (never the raw state — it carries
        // every player's secret objectives, hands and the deck ordering).
        pushState(roomCode, state, SOCKET_EVENTS.GAME_STARTED);
        // Arm the first turn's clock (§10).
        scheduleTurnTimer(roomCode);
        log(
          "info",
          "game_started",
          `game started with ${state.players.length} players`,
          { roomCode },
        );
      }),
    );

    socket.on(
      SOCKET_EVENTS.GAME_ACTION,
      boundary(SOCKET_EVENTS.GAME_ACTION, (raw) => {
        const parsed = parseGameActionPayload(raw);
        if (!parsed.ok) return emitError(parsed.error);
        const { roomCode: code, sessionToken, action } = parsed.value;

        const room = lobby.getRoom(code);
        if (!room || !room.startedByHost || !room.state) {
          socket.emit(SOCKET_EVENTS.ACTION_REJECTED, {
            reason: "That game is not in progress.",
            code: "NO_GAME",
          });
          return;
        }

        // Identity: the sessionToken MUST map to a seated player, and (except
        // for the engine/host-driven ADVANCE_PHASE, whose player is optional)
        // the action's `player` MUST be that same seat — no seat/identity
        // spoofing. Never trust the client's claimed player id.
        const seat = room.players.find((p) => p.sessionToken === sessionToken);
        if (!seat) {
          socket.emit(SOCKET_EVENTS.ACTION_REJECTED, {
            reason: "Invalid session token for this game.",
            code: "BAD_SESSION",
          });
          return;
        }
        if (action.player !== undefined && action.player !== seat.id) {
          socket.emit(SOCKET_EVENTS.ACTION_REJECTED, {
            reason: "You may only issue actions for your own seat.",
            code: "SEAT_SPOOF",
          });
          return;
        }

        // ADVANCE_PHASE authorization: the phase machine is engine-driven (the
        // turn timer calls advancePhase directly) or HOST-driven — mirroring
        // lobbyManager.startGame's host check. The engine's advancePhase is a
        // pure, actorless state transition, so this transport boundary is the
        // ONLY gate; without it any seated player could loop ADVANCE_PHASE and
        // blast the table through all 16 rounds (omens, combats, victory) or
        // close a phase mid-turn to void the other seats' remaining deeds.
        if (action.type === "ADVANCE_PHASE" && !seat.isHost) {
          socket.emit(SOCKET_EVENTS.ACTION_REJECTED, {
            reason: "The host alone may move the years onward.",
            code: "NOT_HOST",
          });
          log("warn", "advance_phase_denied", "non-host ADVANCE_PHASE refused", {
            roomCode: code,
            socketEvent: SOCKET_EVENTS.GAME_ACTION,
          });
          return;
        }

        // ADVANCE_PHASE idempotency (the Onward race): the host may ask the
        // table to move on, and the turn timer can beat them to it. When the
        // action carries the round/phase the client was looking at and the
        // authoritative state has already moved past it, the request is
        // ALREADY satisfied — stepping the machine again would silently skip
        // a phase for the whole room. Resync the issuing seat (a snapshot
        // clears its pending flag) and stop; this is a race, not an offence,
        // so no action_rejected toast.
        if (
          action.type === "ADVANCE_PHASE" &&
          ((action.fromRound !== undefined &&
            action.fromRound !== room.state.round) ||
            (action.fromPhase !== undefined &&
              action.fromPhase !== room.state.phase))
        ) {
          socket.emit(SOCKET_EVENTS.STATE_SNAPSHOT, {
            state: projectStateFor(room.state, seat.id),
          });
          log(
            "info",
            "advance_phase_stale",
            "stale ADVANCE_PHASE ignored (table already moved on); seat resynced",
            { roomCode: code },
          );
          return;
        }

        // Dispatch to the pure engine. ADVANCE_PHASE runs the phase/turn state
        // machine; everything else is a budgeted/validated reducer action.
        let nextState: GameState;
        try {
          nextState =
            action.type === "ADVANCE_PHASE"
              ? advancePhase(room.state)
              : applyAction(room.state, action);
        } catch (err) {
          if (err instanceof EngineError) {
            // Rejected actions answer the ISSUING socket only, never the room.
            socket.emit(SOCKET_EVENTS.ACTION_REJECTED, {
              reason: err.message,
              code: err.code,
            });
            log("warn", "action_rejected", err.message, {
              roomCode: code,
              socketEvent: SOCKET_EVENTS.GAME_ACTION,
            });
            return;
          }
          throw err; // Unexpected: let the boundary answer a generic error.
        }

        room.state = nextState;
        // Broadcast each seat its OWN fog-of-war projection (never raw state).
        pushState(code, nextState, SOCKET_EVENTS.STATE_UPDATE);
        // Re-arm the clock for the (possibly new) active player, or stop it when
        // the game has ended.
        if (nextState.winner) clearTurnTimer(code);
        else scheduleTurnTimer(code);
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
        // If that emptied and dropped the room, tear its timer down with it.
        if (!lobby.getRoom(code)) clearTurnTimer(code);
        log("info", "player_left", `${name ?? "player"} left`, {
          roomCode: code,
        });
        playerId = null;
        roomCode = null;
        socket.data.playerId = null;
        socket.data.roomCode = null;
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

  return {
    app,
    httpServer,
    io,
    lobby,
    startReaper,
    stopReaper,
    stopAllTurnTimers,
  };
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
  const { httpServer, io, lobby, stopReaper, stopAllTurnTimers } = createApp();

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
    // Tear down every per-turn timer so nothing fires mid-drain.
    stopAllTurnTimers();

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
