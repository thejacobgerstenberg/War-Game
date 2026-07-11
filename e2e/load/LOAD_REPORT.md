# Socket.IO Load Test Report

Produced by `npm run test:load` (`e2e/load/socket-load.mjs`). This file is a
committed sample from a green run; re-running the script overwrites it.

## Configuration

| Setting | Value |
| --- | --- |
| Server | `node --import tsx server/src/index.ts` (real entrypoint, real reaper) |
| Port | 4620 |
| ROOM_TTL_SECONDS | 2 |
| Rooms | 50 |
| Players per room | 5 (= 5 factions, contention-free picks) |
| Total sockets | 250 |
| Disconnect-only rooms (reaper path) | 10 |
| leave_game rooms (immediate delete path) | 10 |
| Transport | websocket only, forceNew |

## Load phase — PASS

| Metric | p50 | p95 | max | samples |
| --- | --- | --- | --- | --- |
| Connect latency (io() -> 'connect') | 244.9 ms | 261.8 ms | 262.8 ms | 250 |
| pick_faction RTT (emit -> confirming lobby_update) | 24.3 ms | 56.3 ms | 62.8 ms | 250 |

## Dropped-events assertion — PASS

| Event | Expected | Received |
| --- | --- | --- |
| socket 'connect' | 250 | 250 |
| game_created acks (1 create + 4 joins per room) | 250 | 250 |
| full 5-player lobby_update seen (per client) | 250 | 250 |
| pick_faction confirmations (per client) | 250 | 250 |
| error_msg (unexpected — picks are contention-free) | 0 | 0 |

Total lobby_update broadcasts received across all clients: 2100.

## Reaper check — PASS

| Checkpoint | Rooms (GET /healthz) | Expected |
| --- | --- | --- |
| After load phase (before teardown) | 50 | 50 |
| After 10 rooms fully leave_game (immediate delete) | 40 | 40 |
| After 10 rooms disconnect + TTL reap (ROOM_TTL_SECONDS=2) | 30 | 30 |

Semantics verified: `leave_game` by the last player deletes the room
synchronously in `LobbyManager.leaveGame`; a bare socket disconnect only
marks seats disconnected (`markDisconnected` sets `emptySince` once zero
players are connected), and the entrypoint's periodic sweep
(`lobby.reapEmptyRooms(ROOM_TTL_SECONDS)`, interval `min(TTL, 60)s`)
deletes the room after the TTL elapses. Rooms with live sockets are never
reaped.

## Verdict: PASS
