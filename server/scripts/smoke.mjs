/**
 * End-to-end socket smoke test.
 *
 * Boots the real HTTP + Socket.IO server, connects two socket.io-client
 * sockets, and drives a full lobby flow: create -> join -> pick factions ->
 * host starts. Asserts both clients receive `game_started` with a valid state.
 *
 * Run from the server workspace:  node --import tsx scripts/smoke.mjs
 */
import { io } from "socket.io-client";
import { SOCKET_EVENTS } from "@imperium/shared";
import { createApp } from "../src/index.ts";

const PORT = 4599;

function connect() {
  return io(`http://localhost:${PORT}`, {
    transports: ["websocket"],
    forceNew: true,
  });
}

/** Resolve on the next occurrence of `event`, or reject after `ms`. */
function once(socket, event, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for '${event}'`)),
      ms,
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
  console.log(`  ok - ${message}`);
}

async function main() {
  const { httpServer } = createApp();
  await new Promise((res) => httpServer.listen(PORT, res));
  console.log(`smoke: server listening on :${PORT}`);

  const host = connect();
  const guest = connect();

  // 1. Host creates a game.
  host.emit(SOCKET_EVENTS.CREATE_GAME, { playerName: "Basil" });
  const created = await once(host, SOCKET_EVENTS.GAME_CREATED);
  assert(typeof created.roomCode === "string" && created.roomCode.length === 6, "host received a 6-char room code");
  assert(typeof created.playerId === "string" && created.playerId.length > 0, "host received a playerId");
  const roomCode = created.roomCode;

  // 2. Guest joins with the code.
  guest.emit(SOCKET_EVENTS.JOIN_GAME, { roomCode, playerName: "Murad" });
  const guestCreated = await once(guest, SOCKET_EVENTS.GAME_CREATED);
  assert(guestCreated.roomCode === roomCode, "guest joined the same room");

  // 3. Both pick factions. Wait for the lobby_update reflecting the guest.
  host.emit(SOCKET_EVENTS.PICK_FACTION, { faction: "BYZANTIUM" });
  guest.emit(SOCKET_EVENTS.PICK_FACTION, { faction: "OTTOMAN" });

  // 3b. A duplicate faction must be rejected with error_msg.
  const dupErrP = once(guest, SOCKET_EVENTS.ERROR_MSG);
  guest.emit(SOCKET_EVENTS.PICK_FACTION, { faction: "BYZANTIUM" });
  const dupErr = await dupErrP;
  assert(/already been chosen/i.test(dupErr.message), "duplicate faction rejected with error_msg");

  // 4. Host starts the game; both clients must receive game_started.
  const hostStarted = once(host, SOCKET_EVENTS.GAME_STARTED);
  const guestStarted = once(guest, SOCKET_EVENTS.GAME_STARTED);
  host.emit(SOCKET_EVENTS.START_GAME);

  const [hs, gs] = await Promise.all([hostStarted, guestStarted]);
  assert(hs.state.roomCode === roomCode, "host received game_started for the room");
  assert(gs.state.roomCode === roomCode, "guest received game_started for the room");
  assert(hs.state.players.length === 2, "started state has both players");
  assert(hs.state.provinces.length >= 8, "started state has the sample provinces");
  assert(hs.state.log.length === 1 && hs.state.log[0].type === "game_start", "chronicle seeded with game_start entry");

  // 5. A non-host start attempt must be rejected.
  const nonHostErrP = once(guest, SOCKET_EVENTS.ERROR_MSG);
  guest.emit(SOCKET_EVENTS.START_GAME);
  const nonHostErr = await nonHostErrP;
  assert(/only the host/i.test(nonHostErr.message), "non-host start rejected");

  host.close();
  guest.close();
  await new Promise((res) => httpServer.close(res));
  console.log("\nSMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err);
  process.exit(1);
});
