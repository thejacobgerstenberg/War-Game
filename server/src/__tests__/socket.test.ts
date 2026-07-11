/**
 * Wire-level regression tests for the rejoin/session-token flow, lobby caps,
 * the in-game `game_action` protocol (identity checks, engine rejections,
 * per-seat fog-of-war projection at the wire) and the per-turn timer,
 * run against the real HTTP + Socket.IO stack from createApp().
 *
 * These exist because the original defects were transport-layer gaps that
 * LobbyManager/engine unit tests could not catch: reconnect() existed but no
 * socket event invoked it, MAX_PLAYERS was only mentioned in log strings, and
 * projection was only verified at the engine level (never on the actual
 * emitted payloads).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connectClient, type Socket } from "socket.io-client";
import {
  GamePhase,
  SOCKET_EVENTS,
  TaxPosture,
  type ActionRejectedPayload,
  type GameCreatedPayload,
  type GameState,
  type LobbyUpdatePayload,
  type TurnTimerPayload,
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
  app.stopAllTurnTimers();
  await new Promise<void>((resolve) => {
    app.io.close(() => resolve());
  });
});

/** Record every future `event` payload on `socket` (for absence assertions). */
function collect<T>(socket: Socket, event: string): T[] {
  const seen: T[] = [];
  socket.on(event, (payload: T) => {
    seen.push(payload);
  });
  return seen;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` passes or `ms` elapses (for eventually-true assertions). */
async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await sleep(25);
  }
}

/**
 * Create + join + start a 2-player game, returning both initial projections.
 * turn_timer collectors are attached BEFORE start_game because the initial arm
 * is emitted in the same tick as game_started — a listener added afterwards
 * misses it.
 */
async function startTwoPlayerGame(): Promise<{
  host: Socket;
  guest: Socket;
  hostAck: GameCreatedPayload;
  guestAck: GameCreatedPayload;
  hostStarted: { state: GameState };
  guestStarted: { state: GameState };
  hostTimers: TurnTimerPayload[];
  guestTimers: TurnTimerPayload[];
}> {
  const host = connect();
  const hostAck = await createGame(host, "Alice");
  const guest = connect();
  const guestAck = await joinGame(guest, hostAck.roomCode, "Bob");
  const hostTimers = collect<TurnTimerPayload>(host, SOCKET_EVENTS.TURN_TIMER);
  const guestTimers = collect<TurnTimerPayload>(
    guest,
    SOCKET_EVENTS.TURN_TIMER,
  );
  const hs = once<{ state: GameState }>(host, SOCKET_EVENTS.GAME_STARTED);
  const gs = once<{ state: GameState }>(guest, SOCKET_EVENTS.GAME_STARTED);
  host.emit(SOCKET_EVENTS.START_GAME);
  const [hostStarted, guestStarted] = await Promise.all([hs, gs]);
  return {
    host,
    guest,
    hostAck,
    guestAck,
    hostStarted,
    guestStarted,
    hostTimers,
    guestTimers,
  };
}

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

describe("game_action dispatch & rejection codes (wire)", () => {
  it("answers action_rejected NO_GAME for an unknown room and for a lobby not yet started", async () => {
    const socket = connect();
    // Unknown room.
    let rejected = once<ActionRejectedPayload>(
      socket,
      SOCKET_EVENTS.ACTION_REJECTED,
    );
    socket.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: "ZZZZ99",
      sessionToken: "whatever",
      action: { type: "ADVANCE_PHASE" },
    });
    expect((await rejected).code).toBe("NO_GAME");

    // Real room + real token, but the game has not started.
    const created = await createGame(socket, "Alice");
    rejected = once<ActionRejectedPayload>(
      socket,
      SOCKET_EVENTS.ACTION_REJECTED,
    );
    socket.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: created.roomCode,
      sessionToken: created.sessionToken,
      action: { type: "ADVANCE_PHASE" },
    });
    const notStarted = await rejected;
    expect(notStarted.code).toBe("NO_GAME");
    expect(notStarted.reason).toMatch(/not in progress/i);
  });

  it("answers action_rejected BAD_SESSION for a token that maps to no seat", async () => {
    const { host, hostAck } = await startTwoPlayerGame();
    const rejected = once<ActionRejectedPayload>(
      host,
      SOCKET_EVENTS.ACTION_REJECTED,
    );
    host.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: hostAck.roomCode,
      sessionToken: "not-a-real-token",
      action: { type: "ADVANCE_PHASE" },
    });
    const payload = await rejected;
    expect(payload.code).toBe("BAD_SESSION");
    expect(payload.reason).toMatch(/invalid session token/i);
    // Nothing was dispatched to the engine.
    expect(app.lobby.getRoom(hostAck.roomCode)!.state!.phase).toBe(
      GamePhase.INCOME,
    );
  });

  it("answers action_rejected SEAT_SPOOF when the action names another seat", async () => {
    const { host, hostAck, guestAck } = await startTwoPlayerGame();
    const rejected = once<ActionRejectedPayload>(
      host,
      SOCKET_EVENTS.ACTION_REJECTED,
    );
    // Host's valid token, but the action claims to be the guest's seat.
    host.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: hostAck.roomCode,
      sessionToken: hostAck.sessionToken,
      action: {
        type: "SET_TAX",
        player: guestAck.playerId,
        posture: TaxPosture.HEAVY,
      },
    });
    const payload = await rejected;
    expect(payload.code).toBe("SEAT_SPOOF");
    expect(payload.reason).toMatch(/your own seat/i);
    // The spoof never reached the engine: the guest's tax is untouched.
    const guestSeat = app.lobby
      .getRoom(hostAck.roomCode)!
      .state!.players.find((p) => p.id === guestAck.playerId)!;
    expect(guestSeat.tax).toBe(TaxPosture.NORMAL);
  });

  it("EngineError becomes action_rejected with the engine code, to the issuer ONLY", async () => {
    const { host, guest, hostAck } = await startTwoPlayerGame();
    const guestRejections = collect<ActionRejectedPayload>(
      guest,
      SOCKET_EVENTS.ACTION_REJECTED,
    );
    const guestUpdates = collect<{ state: GameState }>(
      guest,
      SOCKET_EVENTS.STATE_UPDATE,
    );

    // RECRUIT is budget-gated: in the INCOME phase spendAction throws
    // EngineError("WRONG_PHASE") before any recruit validation runs.
    const rejected = once<ActionRejectedPayload>(
      host,
      SOCKET_EVENTS.ACTION_REJECTED,
    );
    host.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: hostAck.roomCode,
      sessionToken: hostAck.sessionToken,
      action: { type: "RECRUIT", player: hostAck.playerId, provinceId: "x", units: {} },
    });
    const payload = await rejected;
    expect(payload.code).toBe("WRONG_PHASE");
    expect(payload.reason).toMatch(/income phase/i);

    // A rejected action changes nothing and reaches nobody else. The
    // follow-up SUCCESSFUL action both proves the room still works and
    // guarantees (by ordering) that no earlier broadcast was in flight.
    const guestSaw = once<{ state: GameState }>(
      guest,
      SOCKET_EVENTS.STATE_UPDATE,
    );
    host.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: hostAck.roomCode,
      sessionToken: hostAck.sessionToken,
      action: {
        type: "SET_TAX",
        player: hostAck.playerId,
        posture: TaxPosture.HEAVY,
      },
    });
    await guestSaw;
    expect(guestRejections).toHaveLength(0);
    expect(guestUpdates).toHaveLength(1); // only the successful SET_TAX
  });

  it("a successful action broadcasts a per-seat PROJECTED state_update to every seat", async () => {
    const { host, guest, hostAck, guestAck } = await startTwoPlayerGame();

    const hostSaw = once<{ state: GameState }>(host, SOCKET_EVENTS.STATE_UPDATE);
    const guestSaw = once<{ state: GameState }>(
      guest,
      SOCKET_EVENTS.STATE_UPDATE,
    );
    host.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: hostAck.roomCode,
      sessionToken: hostAck.sessionToken,
      action: {
        type: "SET_TAX",
        player: hostAck.playerId,
        posture: TaxPosture.HEAVY,
      },
    });
    const [hostView, guestView] = await Promise.all([hostSaw, guestSaw]);

    // The public effect reaches both seats.
    for (const view of [hostView, guestView]) {
      const alice = view.state.players.find((p) => p.id === hostAck.playerId)!;
      expect(alice.tax).toBe(TaxPosture.HEAVY);
    }

    // Fog of war at the wire: each seat sees its OWN objectives, the rival's
    // are same-length sealed stubs, and the RNG/deck ordering is redacted.
    const ownObjectives = hostView.state.players.find(
      (p) => p.id === hostAck.playerId,
    )!.objectives;
    expect(ownObjectives.length).toBeGreaterThan(0);
    expect(ownObjectives.every((o) => o.id !== "hidden")).toBe(true);

    const rivalSeenByGuest = guestView.state.players.find(
      (p) => p.id === hostAck.playerId,
    )!;
    expect(rivalSeenByGuest.objectives).toHaveLength(ownObjectives.length);
    for (const o of rivalSeenByGuest.objectives) {
      expect(o.id).toBe("hidden");
      expect(o.description).toBe("Sealed objective");
      expect(o.prestige).toBe(0);
    }
    const guestOwn = guestView.state.players.find(
      (p) => p.id === guestAck.playerId,
    )!;
    expect(guestOwn.objectives.every((o) => o.id !== "hidden")).toBe(true);

    for (const view of [hostView, guestView]) {
      expect(view.state.rngSeed).toBe(0);
      expect(view.state.rngCursor).toBe(0);
      expect(view.state.omenDeck.every((c) => c === "hidden")).toBe(true);
    }

    // The projection is per-wire only: the authoritative server state still
    // carries the real secrets.
    const authoritative = app.lobby.getRoom(hostAck.roomCode)!.state!;
    expect(authoritative.rngSeed).not.toBe(0);
    expect(authoritative.omenDeck.some((c) => c !== "hidden")).toBe(true);
  });

  it("the initial game_started push is per-seat projected too", async () => {
    const { hostAck, guestAck, hostStarted, guestStarted } =
      await startTwoPlayerGame();

    const hostOwn = hostStarted.state.players.find(
      (p) => p.id === hostAck.playerId,
    )!;
    const guestAsSeenByHost = hostStarted.state.players.find(
      (p) => p.id === guestAck.playerId,
    )!;
    expect(hostOwn.objectives.every((o) => o.id !== "hidden")).toBe(true);
    expect(
      guestAsSeenByHost.objectives.every((o) => o.id === "hidden"),
    ).toBe(true);

    const guestOwn = guestStarted.state.players.find(
      (p) => p.id === guestAck.playerId,
    )!;
    const hostAsSeenByGuest = guestStarted.state.players.find(
      (p) => p.id === hostAck.playerId,
    )!;
    expect(guestOwn.objectives.every((o) => o.id !== "hidden")).toBe(true);
    expect(
      hostAsSeenByGuest.objectives.every((o) => o.id === "hidden"),
    ).toBe(true);

    for (const view of [hostStarted, guestStarted]) {
      expect(view.state.rngSeed).toBe(0);
      expect(view.state.rngCursor).toBe(0);
    }
  });

  it("a stale ADVANCE_PHASE resyncs the issuer with state_snapshot instead of stepping the phase", async () => {
    const { host, guest, hostAck } = await startTwoPlayerGame();
    const guestSnapshotOrUpdate: unknown[] = [];
    guest.on(SOCKET_EVENTS.STATE_SNAPSHOT, (p: unknown) => {
      guestSnapshotOrUpdate.push(p);
    });
    guest.on(SOCKET_EVENTS.STATE_UPDATE, (p: unknown) => {
      guestSnapshotOrUpdate.push(p);
    });
    const hostRejections = collect<ActionRejectedPayload>(
      host,
      SOCKET_EVENTS.ACTION_REJECTED,
    );

    // The table is at round 1 / INCOME; the client claims it saw MOVEMENT.
    const resync = once<{ state: GameState }>(
      host,
      SOCKET_EVENTS.STATE_SNAPSHOT,
    );
    host.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: hostAck.roomCode,
      sessionToken: hostAck.sessionToken,
      action: {
        type: "ADVANCE_PHASE",
        player: hostAck.playerId,
        fromRound: 1,
        fromPhase: GamePhase.MOVEMENT,
      },
    });
    const snapshot = await resync;
    expect(snapshot.state.phase).toBe(GamePhase.INCOME); // not advanced
    expect(app.lobby.getRoom(hostAck.roomCode)!.state!.phase).toBe(
      GamePhase.INCOME,
    );
    await sleep(150);
    expect(hostRejections).toHaveLength(0); // a race, not an offence
    expect(guestSnapshotOrUpdate).toHaveLength(0); // issuer-only resync

    // A MATCHING guard advances for the whole room.
    const hostSaw = once<{ state: GameState }>(host, SOCKET_EVENTS.STATE_UPDATE);
    const guestSaw = once<{ state: GameState }>(
      guest,
      SOCKET_EVENTS.STATE_UPDATE,
    );
    host.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: hostAck.roomCode,
      sessionToken: hostAck.sessionToken,
      action: {
        type: "ADVANCE_PHASE",
        player: hostAck.playerId,
        fromRound: 1,
        fromPhase: GamePhase.INCOME,
      },
    });
    const [hostView, guestView] = await Promise.all([hostSaw, guestSaw]);
    expect(hostView.state.phase).toBe(GamePhase.RECRUITMENT);
    expect(guestView.state.phase).toBe(GamePhase.RECRUITMENT);
  });
});

describe("turn timer (wire)", () => {
  let savedTurnSeconds: string | undefined;
  beforeEach(() => {
    savedTurnSeconds = process.env.TURN_SECONDS;
  });
  afterEach(() => {
    if (savedTurnSeconds === undefined) delete process.env.TURN_SECONDS;
    else process.env.TURN_SECONDS = savedTurnSeconds;
  });

  it("arms on game start: every seat hears turn_timer with the active player and deadline", async () => {
    process.env.TURN_SECONDS = "90";
    const host = connect();
    const hostAck = await createGame(host, "Alice");
    const guest = connect();
    await joinGame(guest, hostAck.roomCode, "Bob");

    const before = Date.now();
    const hostTimer = once<TurnTimerPayload>(host, SOCKET_EVENTS.TURN_TIMER);
    const guestTimer = once<TurnTimerPayload>(guest, SOCKET_EVENTS.TURN_TIMER);
    host.emit(SOCKET_EVENTS.START_GAME);
    const [ht, gt] = await Promise.all([hostTimer, guestTimer]);

    for (const timer of [ht, gt]) {
      expect(timer.roomCode).toBe(hostAck.roomCode);
      expect(timer.turnSeconds).toBe(90);
      expect(timer.activePlayerId).toBe(hostAck.playerId); // turnOrder[0]
      expect(timer.deadline).toBeGreaterThan(before + 85_000);
      expect(timer.deadline).toBeLessThanOrEqual(Date.now() + 90_000);
    }
  });

  it("re-arms with a fresh deadline after every successful action", async () => {
    process.env.TURN_SECONDS = "90";
    const { host, hostAck, hostTimers } = await startTwoPlayerGame();
    await waitFor(() => hostTimers.length >= 1);
    const first = hostTimers[0]!;
    await sleep(30); // let the clock move so the next deadline must differ

    const updated = once<{ state: GameState }>(host, SOCKET_EVENTS.STATE_UPDATE);
    host.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: hostAck.roomCode,
      sessionToken: hostAck.sessionToken,
      action: { type: "ADVANCE_PHASE", player: hostAck.playerId },
    });
    await updated;
    await waitFor(() => hostTimers.length >= 2);
    expect(hostTimers.length).toBeGreaterThanOrEqual(2);
    const rearmed = hostTimers[hostTimers.length - 1]!;
    expect(rearmed.deadline).toBeGreaterThan(first.deadline);
    expect(rearmed.turnSeconds).toBe(90);
  });

  it("rejoin hands back the CURRENT deadline without resetting it", async () => {
    process.env.TURN_SECONDS = "90";
    const { guest, hostAck, guestAck, hostTimers } = await startTwoPlayerGame();
    await waitFor(() => hostTimers.length >= 1);
    const armed = hostTimers[0]!;

    // Guest drops and comes back on a fresh socket.
    guest.disconnect();
    const returning = connect();
    const rejoinTimer = once<TurnTimerPayload>(
      returning,
      SOCKET_EVENTS.TURN_TIMER,
    );
    returning.emit(SOCKET_EVENTS.REJOIN_GAME, {
      roomCode: hostAck.roomCode,
      sessionToken: guestAck.sessionToken,
    });
    const timer = await rejoinTimer;
    expect(timer.deadline).toBe(armed.deadline); // the SAME countdown
    expect(timer.turnSeconds).toBe(armed.turnSeconds);
    expect(timer.activePlayerId).toBe(hostAck.playerId);
  });

  it("TURN_SECONDS=off disables the clock entirely (no turn_timer, actions still flow)", async () => {
    process.env.TURN_SECONDS = "off";
    const { host, guest, hostAck, hostTimers, guestTimers } =
      await startTwoPlayerGame();

    const updated = once<{ state: GameState }>(guest, SOCKET_EVENTS.STATE_UPDATE);
    host.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: hostAck.roomCode,
      sessionToken: hostAck.sessionToken,
      action: { type: "ADVANCE_PHASE", player: hostAck.playerId },
    });
    expect((await updated).state.phase).toBe(GamePhase.RECRUITMENT);
    await sleep(250);
    expect(hostTimers).toHaveLength(0);
    expect(guestTimers).toHaveLength(0);
  });

  it("an expired clock auto-advances the phase for the room and re-arms", async () => {
    process.env.TURN_SECONDS = "1";
    const host = connect();
    const hostAck = await createGame(host, "Alice");
    const guest = connect();
    await joinGame(guest, hostAck.roomCode, "Bob");

    const timers = collect<TurnTimerPayload>(host, SOCKET_EVENTS.TURN_TIMER);
    const autoAdvanced = until<{ state: GameState }>(
      guest,
      SOCKET_EVENTS.STATE_UPDATE,
      (u) => u.state.phase === GamePhase.RECRUITMENT,
      4000,
    );
    host.emit(SOCKET_EVENTS.START_GAME);
    // NO client sends any action; the 1s clock fires and moves the table on.
    const view = await autoAdvanced;
    expect(view.state.phase).toBe(GamePhase.RECRUITMENT);
    // The next turn's clock was armed after the timeout (initial arm + re-arm).
    const rearmDeadline = Date.now() + 3000;
    while (timers.length < 2 && Date.now() < rearmDeadline) {
      await sleep(25);
    }
    expect(timers.length).toBeGreaterThanOrEqual(2);
    expect(app.lobby.getRoom(hostAck.roomCode)!.state!.phase).toBe(
      GamePhase.RECRUITMENT,
    );
  });

  it("stops the clock when the game ends (no re-arm once a winner is set)", async () => {
    process.env.TURN_SECONDS = "90";
    const { host, guest, hostAck, hostTimers } = await startTwoPlayerGame();
    await waitFor(() => hostTimers.length >= 1); // the initial arm
    expect(hostTimers).toHaveLength(1);

    // Force a finished game, then take one more (successful) action.
    const room = app.lobby.getRoom(hostAck.roomCode)!;
    const winnerFaction = room.state!.players.find(
      (p) => p.id === hostAck.playerId,
    )!.faction!;
    room.state = { ...room.state!, winner: winnerFaction };
    const updated = once<{ state: GameState }>(guest, SOCKET_EVENTS.STATE_UPDATE);
    host.emit(SOCKET_EVENTS.GAME_ACTION, {
      roomCode: hostAck.roomCode,
      sessionToken: hostAck.sessionToken,
      action: { type: "ADVANCE_PHASE", player: hostAck.playerId },
    });
    expect((await updated).state.winner).toBe(winnerFaction);
    await sleep(250);
    expect(hostTimers).toHaveLength(1); // clock cleared, never re-armed
  });

  it("reaping an abandoned started room tears down its state and timer", async () => {
    process.env.TURN_SECONDS = "1";
    // Dedicated app so an aggressive TTL/sweep cannot disturb other tests.
    const app2 = createApp({ roomTtlSeconds: 0, reapIntervalMs: 25 });
    await new Promise<void>((resolve) => {
      app2.httpServer.listen(0, resolve);
    });
    const port2 = (app2.httpServer.address() as AddressInfo).port;
    const connect2 = (): Socket => {
      const socket = connectClient(`http://localhost:${port2}`, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
      });
      clients.push(socket);
      return socket;
    };
    try {
      const host = connect2();
      const ackPromise = once<GameCreatedPayload>(
        host,
        SOCKET_EVENTS.GAME_CREATED,
      );
      host.emit(SOCKET_EVENTS.CREATE_GAME, { playerName: "Alice" });
      const hostAck = await ackPromise;
      const guest = connect2();
      const guestAckPromise = once<GameCreatedPayload>(
        guest,
        SOCKET_EVENTS.GAME_CREATED,
      );
      guest.emit(SOCKET_EVENTS.JOIN_GAME, {
        roomCode: hostAck.roomCode,
        playerName: "Bob",
      });
      await guestAckPromise;
      const started = once<{ state: GameState }>(
        host,
        SOCKET_EVENTS.GAME_STARTED,
      );
      const armed = once<TurnTimerPayload>(host, SOCKET_EVENTS.TURN_TIMER);
      host.emit(SOCKET_EVENTS.START_GAME);
      await Promise.all([started, armed]); // the timer IS armed

      // Everyone leaves; the sweep must reap the room (and its timer with it).
      host.disconnect();
      guest.disconnect();
      const deadline = Date.now() + 3000;
      while (app2.lobby.getRoom(hostAck.roomCode) && Date.now() < deadline) {
        await sleep(25);
      }
      expect(app2.lobby.getRoom(hostAck.roomCode)).toBeUndefined();

      // Let the (1s) turn clock's original fire time pass: a dangling timer on
      // a reaped room must not resurrect state or crash the process.
      await sleep(1100);
      expect(app2.lobby.roomCount).toBe(0);
    } finally {
      app2.stopReaper();
      app2.stopAllTurnTimers();
      await new Promise<void>((resolve) => {
        app2.io.close(() => resolve());
      });
    }
  });
});
