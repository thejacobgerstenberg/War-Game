/**
 * Wire-level regression tests for socket payload validation and the handler
 * error boundary (security defect: unvalidated client payloads could throw
 * inside socket.io listeners — which socket.io v4 does NOT catch — and kill
 * the process: an unauthenticated remote DoS).
 *
 * For EVERY client -> server event we fire undefined/null/empty-object/
 * wrong-typed/oversized payloads plus junk extra events, assert the server
 * answers `error_msg` (or deliberately ignores), and — the actual point —
 * assert the server REMAINS SERVING by completing a fresh valid create/join
 * afterwards on the same process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connectClient, type Socket } from "socket.io-client";
import {
  Faction,
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

/** Emit `event` with `args` and await the error_msg answer. */
async function expectErrorFor(
  socket: Socket,
  event: string,
  ...args: unknown[]
): Promise<string> {
  const err = once<{ message: string }>(socket, SOCKET_EVENTS.ERROR_MSG);
  socket.emit(event, ...args);
  const { message } = await err;
  expect(message).toBeTypeOf("string");
  expect(message.length).toBeGreaterThan(0);
  return message;
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

/**
 * The liveness probe: a brand-new socket must still be able to complete a
 * full valid create + join round-trip. If a prior malformed emit had killed
 * (or wedged) the process, this times out and fails the test.
 */
async function expectStillServing(): Promise<void> {
  const probe = connect();
  const created = await createGame(probe, "LivenessProbe");
  expect(created.roomCode).toMatch(/^[A-Z0-9]{6}$/);
  const joiner = connect();
  const ack = once<GameCreatedPayload>(joiner, SOCKET_EVENTS.GAME_CREATED);
  joiner.emit(SOCKET_EVENTS.JOIN_GAME, {
    roomCode: created.roomCode,
    playerName: "ProbeGuest",
  });
  expect((await ack).roomCode).toBe(created.roomCode);
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

/** Payload shapes every event must survive. `[]` means emit with no args. */
const MALFORMED: Array<{ label: string; args: unknown[] }> = [
  { label: "no payload at all (undefined)", args: [] },
  { label: "null", args: [null] },
  { label: "empty object", args: [{}] },
  { label: "a bare string", args: ["junk"] },
  { label: "a number", args: [42] },
  { label: "an array", args: [[1, 2, 3]] },
];

describe("create_game payload validation (wire)", () => {
  it.each(MALFORMED)("answers error_msg for $label", async ({ args }) => {
    const socket = connect();
    await expectErrorFor(socket, SOCKET_EVENTS.CREATE_GAME, ...args);
    await expectStillServing();
  });

  it("rejects wrong-typed, empty, and oversized playerName values", async () => {
    const socket = connect();
    await expectErrorFor(socket, SOCKET_EVENTS.CREATE_GAME, {
      playerName: 12345,
    });
    await expectErrorFor(socket, SOCKET_EVENTS.CREATE_GAME, {
      playerName: { nested: "object" },
    });
    await expectErrorFor(socket, SOCKET_EVENTS.CREATE_GAME, {
      playerName: "   ",
    });
    const tooLong = await expectErrorFor(socket, SOCKET_EVENTS.CREATE_GAME, {
      playerName: "x".repeat(33),
    });
    expect(tooLong).toMatch(/32 characters/);
    await expectErrorFor(socket, SOCKET_EVENTS.CREATE_GAME, {
      playerName: "x".repeat(100_000),
    });
    expect(app.lobby.roomCount).toBe(0); // nothing leaked into the lobby
    await expectStillServing();
  });
});

describe("join_game payload validation (wire)", () => {
  it.each(MALFORMED)("answers error_msg for $label", async ({ args }) => {
    const socket = connect();
    await expectErrorFor(socket, SOCKET_EVENTS.JOIN_GAME, ...args);
    await expectStillServing();
  });

  it("rejects missing/wrong-typed/oversized roomCode and playerName", async () => {
    const host = connect();
    const created = await createGame(host, "Alice");

    const socket = connect();
    await expectErrorFor(socket, SOCKET_EVENTS.JOIN_GAME, {
      playerName: "Bob", // roomCode missing
    });
    await expectErrorFor(socket, SOCKET_EVENTS.JOIN_GAME, {
      roomCode: created.roomCode, // playerName missing
    });
    await expectErrorFor(socket, SOCKET_EVENTS.JOIN_GAME, {
      roomCode: 123456,
      playerName: "Bob",
    });
    await expectErrorFor(socket, SOCKET_EVENTS.JOIN_GAME, {
      roomCode: "ABC-12", // 6 chars but not [A-Z0-9]
      playerName: "Bob",
    });
    await expectErrorFor(socket, SOCKET_EVENTS.JOIN_GAME, {
      roomCode: "TOOLONG",
      playerName: "Bob",
    });
    await expectErrorFor(socket, SOCKET_EVENTS.JOIN_GAME, {
      roomCode: "Z".repeat(100_000),
      playerName: "Bob",
    });
    await expectErrorFor(socket, SOCKET_EVENTS.JOIN_GAME, {
      roomCode: created.roomCode,
      playerName: "x".repeat(33),
    });
    expect(app.lobby.getRoom(created.roomCode)!.players).toHaveLength(1);
    await expectStillServing();
  });

  it("still accepts a lowercase room code (normalised, not rejected)", async () => {
    const host = connect();
    const created = await createGame(host, "Alice");
    const guest = connect();
    const ack = once<GameCreatedPayload>(guest, SOCKET_EVENTS.GAME_CREATED);
    guest.emit(SOCKET_EVENTS.JOIN_GAME, {
      roomCode: created.roomCode.toLowerCase(),
      playerName: "Bob",
    });
    expect((await ack).roomCode).toBe(created.roomCode);
  });
});

describe("rejoin_game payload validation (wire)", () => {
  it.each(MALFORMED)("answers error_msg for $label", async ({ args }) => {
    const socket = connect();
    await expectErrorFor(socket, SOCKET_EVENTS.REJOIN_GAME, ...args);
    await expectStillServing();
  });

  it("rejects missing/wrong-typed/oversized sessionToken values", async () => {
    const host = connect();
    const created = await createGame(host, "Alice");

    const socket = connect();
    await expectErrorFor(socket, SOCKET_EVENTS.REJOIN_GAME, {
      roomCode: created.roomCode, // sessionToken missing
    });
    await expectErrorFor(socket, SOCKET_EVENTS.REJOIN_GAME, {
      roomCode: created.roomCode,
      sessionToken: 42,
    });
    await expectErrorFor(socket, SOCKET_EVENTS.REJOIN_GAME, {
      roomCode: created.roomCode,
      sessionToken: "",
    });
    await expectErrorFor(socket, SOCKET_EVENTS.REJOIN_GAME, {
      roomCode: created.roomCode,
      sessionToken: "t".repeat(100_000),
    });
    await expectErrorFor(socket, SOCKET_EVENTS.REJOIN_GAME, {
      sessionToken: created.sessionToken, // roomCode missing
    });
    expect(app.lobby.getRoom(created.roomCode)!.players).toHaveLength(1);
    await expectStillServing();
  });
});

describe("pick_faction payload validation (wire)", () => {
  it.each(MALFORMED)("answers error_msg for $label", async ({ args }) => {
    const socket = connect();
    await createGame(socket, "Alice"); // in a room, so validation is reached
    await expectErrorFor(socket, SOCKET_EVENTS.PICK_FACTION, ...args);
    await expectStillServing();
  });

  it("rejects wrong-typed and oversized faction values", async () => {
    const socket = connect();
    await createGame(socket, "Alice");
    await expectErrorFor(socket, SOCKET_EVENTS.PICK_FACTION, { faction: 7 });
    await expectErrorFor(socket, SOCKET_EVENTS.PICK_FACTION, {
      faction: { evil: true },
    });
    await expectErrorFor(socket, SOCKET_EVENTS.PICK_FACTION, {
      faction: "B".repeat(100_000),
    });
    await expectStillServing();
  });

  it("answers error_msg when not in a game", async () => {
    const socket = connect();
    const msg = await expectErrorFor(socket, SOCKET_EVENTS.PICK_FACTION, {
      faction: Faction.BYZANTIUM,
    });
    expect(msg).toMatch(/not in a game/i);
    await expectStillServing();
  });
});

describe("start_game / leave_game junk-argument hardening (wire)", () => {
  it("start_game ignores junk args and answers error_msg when not in a game", async () => {
    const socket = connect();
    const msg = await expectErrorFor(
      socket,
      SOCKET_EVENTS.START_GAME,
      { evil: "payload" },
      "extra",
      42,
    );
    expect(msg).toMatch(/not in a game/i);
    await expectStillServing();
  });

  it("start_game with junk args from a seated host still runs the normal domain checks", async () => {
    const socket = connect();
    await createGame(socket, "Alice");
    const msg = await expectErrorFor(socket, SOCKET_EVENTS.START_GAME, {
      players: 999,
    });
    expect(msg).toMatch(/at least 2 players/i);
    await expectStillServing();
  });

  it("leave_game with junk args is ignored for a roomless socket and works for a seated one", async () => {
    const stranger = connect();
    stranger.emit(SOCKET_EVENTS.LEAVE_GAME, { junk: true }, null, "x");

    const host = connect();
    const created = await createGame(host, "Alice");
    const guest = connect();
    const guestAck = once<GameCreatedPayload>(guest, SOCKET_EVENTS.GAME_CREATED);
    guest.emit(SOCKET_EVENTS.JOIN_GAME, {
      roomCode: created.roomCode,
      playerName: "Bob",
    });
    await guestAck;

    const hostSawLeave = until<LobbyUpdatePayload>(
      host,
      SOCKET_EVENTS.LOBBY_UPDATE,
      (u) => u.players.length === 1,
    );
    guest.emit(SOCKET_EVENTS.LEAVE_GAME, ["junk"], { extra: 1 });
    const update = await hostSawLeave;
    expect(update.players).toHaveLength(1);
    await expectStillServing();
  });
});

describe("junk extra events (wire)", () => {
  it("ignores unknown event names and keeps serving", async () => {
    const socket = connect();
    socket.emit("hack_the_server", { boom: true });
    socket.emit("__proto__", { polluted: true });
    socket.emit("constructor", "constructor");
    socket.emit("state_update", { state: null }); // server->client name, sent backwards
    socket.emit("", null);
    await expectStillServing();
    expect(app.lobby.roomCount).toBeGreaterThan(0); // probe room only
  });

  it("survives a rapid burst of malformed emits across every event", async () => {
    const socket = connect();
    const events = [
      SOCKET_EVENTS.CREATE_GAME,
      SOCKET_EVENTS.JOIN_GAME,
      SOCKET_EVENTS.REJOIN_GAME,
      SOCKET_EVENTS.PICK_FACTION,
      SOCKET_EVENTS.START_GAME,
      SOCKET_EVENTS.LEAVE_GAME,
    ];
    for (const event of events) {
      for (const { args } of MALFORMED) {
        socket.emit(event, ...args);
      }
    }
    await expectStillServing();
  });
});

describe("faction injection (wire) — defect 2", () => {
  it("rejects a non-enum faction and never broadcasts it in lobby_update", async () => {
    const host = connect();
    const created = await createGame(host, "Alice");
    const guest = connect();
    const guestAck = once<GameCreatedPayload>(guest, SOCKET_EVENTS.GAME_CREATED);
    guest.emit(SOCKET_EVENTS.JOIN_GAME, {
      roomCode: created.roomCode,
      playerName: "Bob",
    });
    await guestAck;

    // Record every lobby_update the guest ever sees.
    const seenUpdates: LobbyUpdatePayload[] = [];
    guest.on(SOCKET_EVENTS.LOBBY_UPDATE, (u: LobbyUpdatePayload) => {
      seenUpdates.push(u);
    });

    // Host attempts the injection; only the host hears the rejection.
    const msg = await expectErrorFor(host, SOCKET_EVENTS.PICK_FACTION, {
      faction: "SPARTA<script>alert(1)</script>",
    });
    expect(msg).toMatch(/unknown faction/i);

    // A valid pick afterwards proves the room still works, and gives us a
    // guaranteed post-injection lobby_update to inspect.
    const validPick = once<LobbyUpdatePayload>(
      guest,
      SOCKET_EVENTS.LOBBY_UPDATE,
    );
    host.emit(SOCKET_EVENTS.PICK_FACTION, { faction: Faction.BYZANTIUM });
    const update = await validPick;
    const alice = update.players.find((p) => p.name === "Alice")!;
    expect(alice.faction).toBe(Faction.BYZANTIUM);

    // No update ever carried anything outside the canonical enum (or null).
    const allowed = new Set<string | null>([...Object.values(Faction), null]);
    for (const u of seenUpdates) {
      for (const p of u.players) {
        expect(allowed.has(p.faction)).toBe(true);
      }
    }
    // And the server-side seat was never polluted.
    const room = app.lobby.getRoom(created.roomCode)!;
    for (const p of room.players) {
      expect(allowed.has(p.faction)).toBe(true);
    }
  });
});
