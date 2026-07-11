/**
 * Wire-level regression tests for the rejoin/session-token flow and lobby
 * caps, run against the real HTTP + Socket.IO stack from createApp().
 *
 * These exist because the original defects were transport-layer gaps that
 * LobbyManager unit tests could not catch: reconnect() existed but no socket
 * event invoked it, and MAX_PLAYERS was only mentioned in log strings.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connectClient, type Socket } from "socket.io-client";
import {
  SOCKET_EVENTS,
  type GameCreatedPayload,
  type LobbyUpdatePayload,
} from "@imperium/shared";
import { createApp } from "../index.js";

type App = ReturnType<typeof createApp>;

let app: App;
let port: number;
let clients: Socket[] = [];

function connect(): Socket {
  const socket = connectClient(`http://localhost:${port}`, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  clients.push(socket);
  return socket;
}

/** Resolve on the next occurrence of `event`, or reject after `ms`. */
function once<T>(socket: Socket, event: string, ms = 4000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for '${event}'`)),
      ms,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Resolve on the first `event` payload matching `pred`, or reject after `ms`. */
function until<T>(
  socket: Socket,
  event: string,
  pred: (payload: T) => boolean,
  ms = 4000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for matching '${event}'`));
    }, ms);
    const handler = (payload: T) => {
      if (pred(payload)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      }
    };
    socket.on(event, handler);
  });
}

/** create_game and await the ack. */
async function createGame(
  socket: Socket,
  playerName: string,
): Promise<GameCreatedPayload> {
  const ack = once<GameCreatedPayload>(socket, SOCKET_EVENTS.GAME_CREATED);
  socket.emit(SOCKET_EVENTS.CREATE_GAME, { playerName });
  return ack;
}

/** join_game and await the ack. */
async function joinGame(
  socket: Socket,
  roomCode: string,
  playerName: string,
): Promise<GameCreatedPayload> {
  const ack = once<GameCreatedPayload>(socket, SOCKET_EVENTS.GAME_CREATED);
  socket.emit(SOCKET_EVENTS.JOIN_GAME, { roomCode, playerName });
  return ack;
}

beforeEach(async () => {
  app = createApp();
  await new Promise<void>((resolve) => {
    app.httpServer.listen(0, resolve);
  });
  port = (app.httpServer.address() as AddressInfo).port;
  clients = [];
});

afterEach(async () => {
  for (const client of clients) client.disconnect();
  app.stopReaper();
  await new Promise<void>((resolve) => {
    app.io.close(() => resolve());
  });
});

describe("session tokens & rejoin_game (wire)", () => {
  it("acks create/join with a sessionToken and rejoin reattaches the seat with no ghost duplicate", async () => {
    const host = connect();
    const created = await createGame(host, "Alice");
    expect(created.sessionToken).toBeTruthy();

    const guest = connect();
    const guestAck = await joinGame(guest, created.roomCode, "Bob");
    expect(guestAck.sessionToken).toBeTruthy();
    expect(guestAck.sessionToken).not.toBe(created.sessionToken);

    // Guest drops: host sees the seat held but disconnected.
    const sawDrop = until<LobbyUpdatePayload>(
      host,
      SOCKET_EVENTS.LOBBY_UPDATE,
      (u) => u.players.some((p) => p.name === "Bob" && !p.connected),
    );
    guest.disconnect();
    const dropUpdate = await sawDrop;
    expect(dropUpdate.players).toHaveLength(2);

    // A fresh socket rejoins with the stored token.
    const returning = connect();
    const sawRejoin = until<LobbyUpdatePayload>(
      host,
      SOCKET_EVENTS.LOBBY_UPDATE,
      (u) => u.players.some((p) => p.name === "Bob" && p.connected),
    );
    const rejoinerUpdate = once<LobbyUpdatePayload>(
      returning,
      SOCKET_EVENTS.LOBBY_UPDATE,
    );
    returning.emit(SOCKET_EVENTS.REJOIN_GAME, {
      roomCode: created.roomCode,
      sessionToken: guestAck.sessionToken,
    });

    const [hostView, rejoinerView] = await Promise.all([
      sawRejoin,
      rejoinerUpdate,
    ]);
    for (const update of [hostView, rejoinerView]) {
      expect(update.players).toHaveLength(2); // no ghost seat
      const bob = update.players.find((p) => p.name === "Bob")!;
      expect(bob.id).toBe(guestAck.playerId); // the SAME seat
      expect(bob.connected).toBe(true);
    }
    expect(app.lobby.getRoom(created.roomCode)!.players).toHaveLength(2);
  });

  it("rejoin works after game start (with game_started + state_update); new joins stay rejected", async () => {
    const host = connect();
    const created = await createGame(host, "Alice");
    const guest = connect();
    const guestAck = await joinGame(guest, created.roomCode, "Bob");

    const hostStarted = once(host, SOCKET_EVENTS.GAME_STARTED);
    host.emit(SOCKET_EVENTS.START_GAME);
    await hostStarted;

    guest.disconnect();

    // A brand-new player still cannot join a started game.
    const latecomer = connect();
    const lateErr = once<{ message: string }>(
      latecomer,
      SOCKET_EVENTS.ERROR_MSG,
    );
    latecomer.emit(SOCKET_EVENTS.JOIN_GAME, {
      roomCode: created.roomCode,
      playerName: "Latecomer",
    });
    expect((await lateErr).message).toMatch(/already started/i);

    // But a valid token resumes: game_started + state_update with the
    // current full state.
    const returning = connect();
    const startedAgain = once<{ state: { roomCode: string } }>(
      returning,
      SOCKET_EVENTS.GAME_STARTED,
    );
    const stateUpdate = once<{ state: { roomCode: string; players: unknown[] } }>(
      returning,
      SOCKET_EVENTS.STATE_UPDATE,
    );
    returning.emit(SOCKET_EVENTS.REJOIN_GAME, {
      roomCode: created.roomCode,
      sessionToken: guestAck.sessionToken,
    });
    const [gs, su] = await Promise.all([startedAgain, stateUpdate]);
    expect(gs.state.roomCode).toBe(created.roomCode);
    expect(su.state.roomCode).toBe(created.roomCode);
    expect(su.state.players).toHaveLength(2);
    expect(app.lobby.getRoom(created.roomCode)!.players).toHaveLength(2);
  });

  it("rejects a rejoin with a wrong token", async () => {
    const host = connect();
    const created = await createGame(host, "Alice");

    const intruder = connect();
    const err = once<{ message: string }>(intruder, SOCKET_EVENTS.ERROR_MSG);
    intruder.emit(SOCKET_EVENTS.REJOIN_GAME, {
      roomCode: created.roomCode,
      sessionToken: "not-a-real-token",
    });
    expect((await err).message).toMatch(/invalid session token/i);
    expect(app.lobby.getRoom(created.roomCode)!.players).toHaveLength(1);
  });

  it("rejects a same-name join as name-taken instead of seating a ghost duplicate", async () => {
    const host = connect();
    const created = await createGame(host, "Alice");
    const guest = connect();
    await joinGame(guest, created.roomCode, "Bob");
    guest.disconnect(); // even a held (disconnected) seat keeps its name

    const impostor = connect();
    const err = once<{ message: string }>(impostor, SOCKET_EVENTS.ERROR_MSG);
    impostor.emit(SOCKET_EVENTS.JOIN_GAME, {
      roomCode: created.roomCode,
      playerName: "Bob",
    });
    expect((await err).message).toMatch(/name is already taken/i);
    expect(app.lobby.getRoom(created.roomCode)!.players).toHaveLength(2);
  });
});

describe("MAX_PLAYERS cap (wire)", () => {
  it("rejects the 6th join with error_msg", async () => {
    const host = connect();
    const created = await createGame(host, "P1");
    for (let i = 2; i <= 5; i++) {
      await joinGame(connect(), created.roomCode, `P${i}`);
    }
    expect(app.lobby.getRoom(created.roomCode)!.players).toHaveLength(5);

    const sixth = connect();
    const err = once<{ message: string }>(sixth, SOCKET_EVENTS.ERROR_MSG);
    sixth.emit(SOCKET_EVENTS.JOIN_GAME, {
      roomCode: created.roomCode,
      playerName: "P6",
    });
    expect((await err).message).toMatch(/full/i);
    expect(app.lobby.getRoom(created.roomCode)!.players).toHaveLength(5);
  });
});
