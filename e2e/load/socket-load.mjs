/**
 * Socket.IO load test for the IMPERIUM lobby server (plain Node, no Playwright).
 *
 * What it does:
 *   1. Builds @imperium/shared, then spawns the REAL server entrypoint
 *      (`node --import tsx server/src/index.ts`) on a dedicated port with a
 *      short ROOM_TTL_SECONDS, so the production room reaper actually runs
 *      (createApp() owns the reaper since the scaffold fixes, but spawning
 *      the entrypoint also exercises env parsing and graceful shutdown).
 *   2. Load phase: ROOMS x PLAYERS_PER_ROOM sockets join concurrently.
 *      Measures connect latency (io() -> 'connect') and pick_faction RTT
 *      (emit -> the lobby_update that reflects the pick); reports p50/p95.
 *      Factions are assigned deterministically by seat index (5 seats,
 *      5 factions) so no pick is ever contested — this tests transport, not
 *      contention. Any error_msg is therefore a failure.
 *   3. Dropped-events assertion: every expected event must arrive within a
 *      generous timeout — per room 1 create ack + 4 join acks (both are the
 *      `game_created` event), every client sees a 5-player lobby_update, and
 *      every pick is confirmed. Any shortfall fails the run with details.
 *   4. Reaper check: all players of DISCONNECT_ROOMS rooms drop their sockets
 *      without leave_game (seats held -> room "empty" -> reaped after TTL);
 *      all players of LEAVE_ROOMS rooms send leave_game (room deleted
 *      immediately when the last player leaves). Verified via the `rooms`
 *      count on GET /healthz: 50 -> 40 (after leaves) -> 30 (after reap).
 *   5. Writes e2e/load/LOAD_REPORT.md and exits 0 on success, 1 on failure.
 *
 * Run from the repo root:  npm run test:load
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

// ---------------------------------------------------------------- config ---

const CONFIG = {
  port: 4620, // dedicated; e2e uses 4610/5610, dev uses 8080/5173
  roomTtlSeconds: 2, // ROOM_TTL_SECONDS for the spawned server (reap sweep = min(TTL,60)s)
  rooms: 50,
  playersPerRoom: 5, // matches the 5 factions -> contention-free picks
  disconnectRooms: 10, // reaped by the TTL reaper after sockets drop
  leaveRooms: 10, // deleted immediately via leave_game
  eventTimeoutMs: 30_000, // generous per-await timeout for the load phase
  reapDeadlineMs: 15_000, // TTL(2s) + sweep interval(2s) + generous slack
  bootTimeoutMs: 30_000,
  globalWatchdogMs: 180_000, // hard bound on total runtime
};

const SERVER_URL = `http://localhost:${CONFIG.port}`;
const FACTIONS = ["BYZANTIUM", "OTTOMAN", "VENICE", "GENOA", "HUNGARY"];

// Wire protocol (shared/src/protocol/socket.ts). NOTE: join_game is acked
// with the same `game_created` event as create_game.
const EV = {
  CREATE_GAME: "create_game",
  JOIN_GAME: "join_game",
  PICK_FACTION: "pick_faction",
  LEAVE_GAME: "leave_game",
  GAME_CREATED: "game_created",
  LOBBY_UPDATE: "lobby_update",
  ERROR_MSG: "error_msg",
};

const loadDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(loadDir, "..", "..");
const serverDir = path.join(repoRoot, "server");
const REPORT_PATH = path.join(loadDir, "LOAD_REPORT.md");

// --------------------------------------------------------------- helpers ---

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[idx];
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? NaN,
  };
}

const ms = (v) => `${v.toFixed(1)} ms`;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timeout after ${timeoutMs}ms: ${label}`)),
        timeoutMs,
      );
    }),
  ]);
}

async function healthz() {
  const res = await fetch(`${SERVER_URL}/healthz`);
  if (!res.ok) throw new Error(`GET /healthz -> HTTP ${res.status}`);
  return res.json(); // { status, rooms, uptime }
}

async function pollHealthzRooms(expected, deadlineMs, label) {
  const startedAt = Date.now();
  let last = NaN;
  while (Date.now() - startedAt < deadlineMs) {
    last = (await healthz()).rooms;
    if (last === expected) return { ok: true, rooms: last };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, rooms: last, label };
}

// ----------------------------------------------------------- server boot ---

function buildShared() {
  console.log("[boot] building @imperium/shared ...");
  const res = spawnSync("npm", ["run", "build", "--workspace", "@imperium/shared"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`shared build failed:\n${res.stdout}\n${res.stderr}`);
  }
}

function spawnServer() {
  // The entrypoint's isMain guard now path.resolve()s argv[1], so a relative
  // entry would also work — keep the absolute path anyway for clarity.
  const entry = path.join(serverDir, "src", "index.ts");
  const child = spawn("node", ["--import", "tsx", entry], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(CONFIG.port),
      ROOM_TTL_SECONDS: String(CONFIG.roomTtlSeconds),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  const capture = (chunk) => {
    logs.push(chunk.toString());
    if (logs.length > 500) logs.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return { child, logs };
}

async function waitForServer(child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CONFIG.bootTimeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`server exited during boot (code ${child.exitCode})`);
    }
    try {
      const body = await healthz();
      if (body.status === "ok") return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not answer /healthz within ${CONFIG.bootTimeoutMs}ms`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM"); // exercises graceful shutdown; exits 0 once drained
  await withTimeout(
    new Promise((resolve) => child.once("exit", resolve)),
    10_000,
    "server shutdown",
  ).catch(() => child.kill("SIGKILL"));
}

// ------------------------------------------------------------ load phase ---

/**
 * One client = one socket + latched listeners. Listeners are attached before
 * any emit so no broadcast can be missed. `lobbyWaiters` are predicates
 * resolved against every incoming lobby_update (including buffered ones).
 */
function makeClient(roomIndex, seatIndex, counters) {
  const t0 = performance.now();
  const socket = io(SERVER_URL, { transports: ["websocket"], forceNew: true });
  const client = {
    roomIndex,
    seatIndex,
    label: `room${roomIndex}/seat${seatIndex}`,
    socket,
    playerId: null,
    roomCode: null,
    lobbyUpdates: [],
    errors: [],
    connectLatency: null,
    connected: new Promise((resolve, reject) => {
      socket.once("connect", () => {
        client.connectLatency = performance.now() - t0;
        counters.connectsReceived++;
        resolve();
      });
      socket.once("connect_error", (err) =>
        reject(new Error(`${client.label} connect_error: ${err.message}`)),
      );
    }),
    waiters: [],
  };
  socket.on(EV.LOBBY_UPDATE, (payload) => {
    counters.lobbyUpdatesReceived++;
    client.lobbyUpdates.push(payload);
    client.waiters = client.waiters.filter((w) => !w(payload));
  });
  socket.on(EV.ERROR_MSG, ({ message }) => {
    counters.errorMsgsReceived++;
    client.errors.push(message);
  });
  return client;
}

/** Resolve when any (past or future) lobby_update satisfies `predicate`. */
function waitLobby(client, predicate, timeoutMs, label) {
  const hit = client.lobbyUpdates.find(predicate);
  if (hit) return Promise.resolve(hit);
  return withTimeout(
    new Promise((resolve) => {
      client.waiters.push((payload) => {
        if (!predicate(payload)) return false;
        resolve(payload);
        return true;
      });
    }),
    timeoutMs,
    `${client.label}: ${label}`,
  );
}

/** Emit `event` and resolve with the next matching `ackEvent` payload. */
function emitAndAwait(client, event, payload, ackEvent, timeoutMs, label) {
  return withTimeout(
    new Promise((resolve) => {
      client.socket.once(ackEvent, resolve);
      client.socket.emit(event, payload);
    }),
    timeoutMs,
    `${client.label}: ${label}`,
  );
}

async function runRoom(roomIndex, counters, failures) {
  const T = CONFIG.eventTimeoutMs;
  const clients = [];
  for (let seat = 0; seat < CONFIG.playersPerRoom; seat++) {
    clients.push(makeClient(roomIndex, seat, counters));
  }
  await Promise.all(clients.map((c) => c.connected));

  // Seat 0 creates; the ack (game_created) carries the room code.
  const creator = clients[0];
  const created = await emitAndAwait(
    creator,
    EV.CREATE_GAME,
    { playerName: `P${roomIndex}-0` },
    EV.GAME_CREATED,
    T,
    "create_game ack",
  );
  counters.gameCreatedReceived++;
  creator.playerId = created.playerId;
  creator.roomCode = created.roomCode;
  if (!/^[A-Z0-9]{6}$/.test(created.roomCode)) {
    failures.push(`${creator.label}: bad room code ${created.roomCode}`);
  }

  // Seats 1..4 join concurrently. Join is ALSO acked with game_created.
  await Promise.all(
    clients.slice(1).map(async (client) => {
      const ack = await emitAndAwait(
        client,
        EV.JOIN_GAME,
        { roomCode: created.roomCode, playerName: `P${roomIndex}-${client.seatIndex}` },
        EV.GAME_CREATED,
        T,
        "join_game ack",
      );
      counters.gameCreatedReceived++;
      client.playerId = ack.playerId;
      client.roomCode = ack.roomCode;
    }),
  );

  // Assembly: every client must observe a 5-player roster.
  await Promise.all(
    clients.map(async (client) => {
      await waitLobby(
        client,
        (p) => p.players.length === CONFIG.playersPerRoom,
        T,
        "full 5-player lobby_update",
      );
      counters.fullRosterReceived++;
    }),
  );

  // Pick phase: deterministic faction per seat index -> zero contention.
  // RTT = pick_faction emit -> lobby_update showing OUR pick.
  await Promise.all(
    clients.map(async (client) => {
      const faction = FACTIONS[client.seatIndex];
      const t0 = performance.now();
      const confirmed = waitLobby(
        client,
        (p) =>
          p.players.some(
            (pl) => pl.id === client.playerId && pl.faction === faction,
          ),
        T,
        `lobby_update confirming ${faction}`,
      );
      client.socket.emit(EV.PICK_FACTION, { faction });
      await confirmed;
      client.pickRtt = performance.now() - t0;
      counters.pickConfirmsReceived++;
    }),
  );

  return clients;
}

// ---------------------------------------------------------------- report ---

function fmtStats(s) {
  return `n=${s.n}, p50=${ms(s.p50)}, p95=${ms(s.p95)}, max=${ms(s.max)}`;
}

function writeReport(r) {
  const verdict = (ok) => (ok ? "PASS" : "FAIL");
  const lines = [
    "# Socket.IO Load Test Report",
    "",
    "Produced by `npm run test:load` (`e2e/load/socket-load.mjs`). This file is a",
    "committed sample from a green run; re-running the script overwrites it.",
    "",
    "## Configuration",
    "",
    "| Setting | Value |",
    "| --- | --- |",
    `| Server | \`node --import tsx server/src/index.ts\` (real entrypoint, real reaper) |`,
    `| Port | ${CONFIG.port} |`,
    `| ROOM_TTL_SECONDS | ${CONFIG.roomTtlSeconds} |`,
    `| Rooms | ${CONFIG.rooms} |`,
    `| Players per room | ${CONFIG.playersPerRoom} (= 5 factions, contention-free picks) |`,
    `| Total sockets | ${CONFIG.rooms * CONFIG.playersPerRoom} |`,
    `| Disconnect-only rooms (reaper path) | ${CONFIG.disconnectRooms} |`,
    `| leave_game rooms (immediate delete path) | ${CONFIG.leaveRooms} |`,
    `| Transport | websocket only, forceNew |`,
    "",
    `## Load phase — ${verdict(r.loadOk)}`,
    "",
    "| Metric | p50 | p95 | max | samples |",
    "| --- | --- | --- | --- | --- |",
    `| Connect latency (io() -> 'connect') | ${ms(r.connect.p50)} | ${ms(r.connect.p95)} | ${ms(r.connect.max)} | ${r.connect.n} |`,
    `| pick_faction RTT (emit -> confirming lobby_update) | ${ms(r.rtt.p50)} | ${ms(r.rtt.p95)} | ${ms(r.rtt.max)} | ${r.rtt.n} |`,
    "",
    `## Dropped-events assertion — ${verdict(r.eventsOk)}`,
    "",
    "| Event | Expected | Received |",
    "| --- | --- | --- |",
    `| socket 'connect' | ${r.expected.connects} | ${r.counters.connectsReceived} |`,
    `| game_created acks (1 create + 4 joins per room) | ${r.expected.gameCreated} | ${r.counters.gameCreatedReceived} |`,
    `| full 5-player lobby_update seen (per client) | ${r.expected.fullRoster} | ${r.counters.fullRosterReceived} |`,
    `| pick_faction confirmations (per client) | ${r.expected.pickConfirms} | ${r.counters.pickConfirmsReceived} |`,
    `| error_msg (unexpected — picks are contention-free) | 0 | ${r.counters.errorMsgsReceived} |`,
    "",
    `Total lobby_update broadcasts received across all clients: ${r.counters.lobbyUpdatesReceived}.`,
    "",
    `## Reaper check — ${verdict(r.reaperOk)}`,
    "",
    "| Checkpoint | Rooms (GET /healthz) | Expected |",
    "| --- | --- | --- |",
    `| After load phase (before teardown) | ${r.roomsBefore} | ${CONFIG.rooms} |`,
    `| After ${CONFIG.leaveRooms} rooms fully leave_game (immediate delete) | ${r.roomsAfterLeave} | ${CONFIG.rooms - CONFIG.leaveRooms} |`,
    `| After ${CONFIG.disconnectRooms} rooms disconnect + TTL reap (ROOM_TTL_SECONDS=${CONFIG.roomTtlSeconds}) | ${r.roomsAfterReap} | ${CONFIG.rooms - CONFIG.leaveRooms - CONFIG.disconnectRooms} |`,
    "",
    "Semantics verified: `leave_game` by the last player deletes the room",
    "synchronously in `LobbyManager.leaveGame`; a bare socket disconnect only",
    "marks seats disconnected (`markDisconnected` sets `emptySince` once zero",
    "players are connected), and the entrypoint's periodic sweep",
    "(`lobby.reapEmptyRooms(ROOM_TTL_SECONDS)`, interval `min(TTL, 60)s`)",
    "deletes the room after the TTL elapses. Rooms with live sockets are never",
    "reaped.",
    "",
    `## Verdict: ${verdict(r.allOk)}`,
    "",
  ];
  if (r.failures.length > 0) {
    lines.push("## Failure details", "");
    for (const f of r.failures.slice(0, 50)) lines.push(`- ${f}`);
    lines.push("");
  }
  writeFileSync(REPORT_PATH, lines.join("\n"));
}

// ------------------------------------------------------------------ main ---

async function main() {
  const counters = {
    connectsReceived: 0,
    gameCreatedReceived: 0,
    lobbyUpdatesReceived: 0,
    fullRosterReceived: 0,
    pickConfirmsReceived: 0,
    errorMsgsReceived: 0,
  };
  const failures = [];
  const totalSockets = CONFIG.rooms * CONFIG.playersPerRoom;
  const expected = {
    connects: totalSockets,
    gameCreated: totalSockets, // 1 create ack + 4 join acks per room
    fullRoster: totalSockets,
    pickConfirms: totalSockets,
  };

  buildShared();
  const { child, logs } = spawnServer();
  let allClients = [];

  try {
    await waitForServer(child);
    console.log(`[boot] server up on :${CONFIG.port} (ROOM_TTL_SECONDS=${CONFIG.roomTtlSeconds})`);

    // ---- load phase: all rooms concurrently -----------------------------
    console.log(`[load] ${CONFIG.rooms} rooms x ${CONFIG.playersPerRoom} players = ${totalSockets} sockets ...`);
    const t0 = performance.now();
    const roomResults = await Promise.allSettled(
      Array.from({ length: CONFIG.rooms }, (_, i) => runRoom(i, counters, failures)),
    );
    const loadWallMs = performance.now() - t0;
    const roomClients = [];
    roomResults.forEach((res, i) => {
      if (res.status === "fulfilled") {
        roomClients[i] = res.value;
        allClients.push(...res.value);
      } else {
        roomClients[i] = null;
        failures.push(`room${i}: ${res.reason.message}`);
      }
    });
    for (const c of allClients) {
      for (const e of c.errors) failures.push(`${c.label}: unexpected error_msg "${e}"`);
    }
    console.log(`[load] phase complete in ${(loadWallMs / 1000).toFixed(1)}s`);

    const connect = stats(allClients.map((c) => c.connectLatency).filter((v) => v !== null));
    const rtt = stats(allClients.map((c) => c.pickRtt).filter((v) => v !== undefined));

    const eventsOk =
      counters.connectsReceived === expected.connects &&
      counters.gameCreatedReceived === expected.gameCreated &&
      counters.fullRosterReceived === expected.fullRoster &&
      counters.pickConfirmsReceived === expected.pickConfirms &&
      counters.errorMsgsReceived === 0;
    const loadOk = roomResults.every((r) => r.status === "fulfilled") && eventsOk;
    if (!eventsOk) {
      failures.push(
        `event shortfall: connects ${counters.connectsReceived}/${expected.connects}, ` +
          `game_created ${counters.gameCreatedReceived}/${expected.gameCreated}, ` +
          `full rosters ${counters.fullRosterReceived}/${expected.fullRoster}, ` +
          `pick confirms ${counters.pickConfirmsReceived}/${expected.pickConfirms}, ` +
          `error_msg ${counters.errorMsgsReceived}/0`,
      );
    }

    // ---- reaper phase ----------------------------------------------------
    const roomsBefore = (await healthz()).rooms;
    console.log(`[reap] /healthz rooms before teardown: ${roomsBefore}`);

    // Rooms [disconnectRooms, disconnectRooms+leaveRooms): everyone leave_game.
    // The last leave deletes the room synchronously server-side.
    for (let i = CONFIG.disconnectRooms; i < CONFIG.disconnectRooms + CONFIG.leaveRooms; i++) {
      for (const c of roomClients[i] ?? []) c.socket.emit(EV.LEAVE_GAME);
    }
    const afterLeave = await pollHealthzRooms(
      CONFIG.rooms - CONFIG.leaveRooms,
      10_000,
      "rooms after leave_game teardown",
    );
    console.log(`[reap] rooms after leave_game x${CONFIG.leaveRooms} rooms: ${afterLeave.rooms}`);
    // Their sockets are no longer in any room; drop them.
    for (let i = CONFIG.disconnectRooms; i < CONFIG.disconnectRooms + CONFIG.leaveRooms; i++) {
      for (const c of roomClients[i] ?? []) c.socket.disconnect();
    }

    // Rooms [0, disconnectRooms): bare disconnects, NO leave_game -> seats
    // held, room becomes "empty" and must be TTL-reaped by the sweep.
    for (let i = 0; i < CONFIG.disconnectRooms; i++) {
      for (const c of roomClients[i] ?? []) c.socket.disconnect();
    }
    const afterReap = await pollHealthzRooms(
      CONFIG.rooms - CONFIG.leaveRooms - CONFIG.disconnectRooms,
      CONFIG.reapDeadlineMs,
      "rooms after TTL reap",
    );
    console.log(`[reap] rooms after disconnect x${CONFIG.disconnectRooms} rooms + TTL reap: ${afterReap.rooms}`);

    const reaperOk =
      roomsBefore === CONFIG.rooms && afterLeave.ok && afterReap.ok;
    if (roomsBefore !== CONFIG.rooms) {
      failures.push(`healthz rooms before teardown: ${roomsBefore}, expected ${CONFIG.rooms}`);
    }
    if (!afterLeave.ok) {
      failures.push(
        `rooms after leave_game: ${afterLeave.rooms}, expected ${CONFIG.rooms - CONFIG.leaveRooms} within 10s`,
      );
    }
    if (!afterReap.ok) {
      failures.push(
        `rooms after TTL reap: ${afterReap.rooms}, expected ${CONFIG.rooms - CONFIG.leaveRooms - CONFIG.disconnectRooms} within ${CONFIG.reapDeadlineMs}ms`,
      );
    }

    const allOk = loadOk && eventsOk && reaperOk;
    writeReport({
      loadOk,
      eventsOk,
      reaperOk,
      allOk,
      connect,
      rtt,
      counters,
      expected,
      roomsBefore,
      roomsAfterLeave: afterLeave.rooms,
      roomsAfterReap: afterReap.rooms,
      failures,
    });

    // ---- summary ----------------------------------------------------------
    console.log("");
    console.log(`connect latency: ${fmtStats(connect)}`);
    console.log(`pick_faction RTT: ${fmtStats(rtt)}`);
    console.log(
      `events: connects ${counters.connectsReceived}/${expected.connects}, ` +
        `game_created ${counters.gameCreatedReceived}/${expected.gameCreated}, ` +
        `full rosters ${counters.fullRosterReceived}/${expected.fullRoster}, ` +
        `pick confirms ${counters.pickConfirmsReceived}/${expected.pickConfirms}, ` +
        `error_msg ${counters.errorMsgsReceived}/0`,
    );
    console.log(
      `reaper: rooms ${roomsBefore} -> ${afterLeave.rooms} (leave_game) -> ${afterReap.rooms} (TTL reap)`,
    );
    console.log(`report: ${path.relative(repoRoot, REPORT_PATH)}`);

    if (!allOk) {
      console.error(`\nLOAD TEST FAILED (${failures.length} issue(s)):`);
      for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
      if (failures.length > 20) console.error(`  ... and ${failures.length - 20} more (see LOAD_REPORT.md)`);
      process.exitCode = 1;
    } else {
      console.log("\nLOAD TEST PASSED");
    }
  } catch (err) {
    console.error("\nLOAD TEST FAILED:", err);
    console.error("--- last server logs ---");
    console.error(logs.slice(-30).join(""));
    process.exitCode = 1;
  } finally {
    for (const c of allClients) {
      if (c.socket.connected) c.socket.disconnect();
    }
    await stopServer(child);
  }
}

const watchdog = setTimeout(() => {
  console.error(`\nLOAD TEST FAILED: global watchdog (${CONFIG.globalWatchdogMs}ms) exceeded`);
  process.exit(1);
}, CONFIG.globalWatchdogMs);
watchdog.unref();

main();
