/**
 * HTTP + Socket.IO entrypoint. Wires the transport-agnostic {@link LobbyManager}
 * to the shared socket protocol.
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

const PORT = Number(process.env.PORT ?? 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

export function createApp() {
  const app = express();
  app.use(cors({ origin: CLIENT_ORIGIN }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", game: "IMPERIUM: Twilight of Empires" });
  });

  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    {
      cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
    },
  );

  const lobby = new LobbyManager();

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
      } catch (err) {
        emitError(errMessage(err));
      }
    });

    socket.on(SOCKET_EVENTS.LEAVE_GAME, () => {
      if (!roomCode || !playerId) return;
      const code = roomCode;
      lobby.leaveGame(code, playerId);
      socket.leave(code);
      broadcastLobby(code);
      playerId = null;
      roomCode = null;
    });

    socket.on("disconnect", () => {
      if (playerId) lobby.markDisconnected(playerId);
      if (roomCode) broadcastLobby(roomCode);
    });
  });

  return { app, httpServer, io, lobby };
}

function errMessage(err: unknown): string {
  if (err instanceof LobbyError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected server error.";
}

// Only start listening when run directly (not when imported by tests/smoke).
const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const { httpServer } = createApp();
  httpServer.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `IMPERIUM server listening on http://localhost:${PORT} (client origin ${CLIENT_ORIGIN})`,
    );
  });
}
