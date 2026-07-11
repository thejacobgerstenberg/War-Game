# OPERATIONS.md — Production Contract: deploy ⇄ server/client teams

**IMPERIUM: Twilight of Empires** — server-authoritative socket.io game server
(Node 20 + Express), 2–5 players per room, all room state **in-memory on one
process**. This document is the contract the scaffold team implements against
and the deploy layer (Dockerfiles, `fly.toml`, `docker-compose.yml`) is built
against. Names below are **canonical** — use them exactly; do not invent
variants (`/health`, `HTTP_PORT`, `SERVER_SHUTDOWN`, etc.).

> **Scaffold status (2026-07-11, per deploy recon):** the scaffold branch has
> not landed anywhere — `origin/main` contains only `.gitignore`. There is no
> `package.json`, no server entry file, no `/healthz`, no env-var reads, no
> shutdown handler. **The scaffold currently satisfies NONE of this contract.**
> Every "Status" line below is therefore an ask; the crisp list of asks is in
> [§9](#9-contract-status-what-the-scaffold-already-satisfies-vs-asks).

---

## 1. Health: `GET /healthz` — REQUIRED

**Status: REQUIRED — does not exist in scaffold yet.**
TODO(scaffold): implement `GET /healthz` on the Express app exactly as specified below; no server code exists on main at all.

```
GET /healthz  ->  200 OK, Content-Type: application/json

{"status":"ok","rooms":<int>,"uptime":<seconds>}
```

- `status` — literal string `"ok"` when the process is serving.
- `rooms` — integer count of currently live rooms (an O(1) read, e.g.
  `roomsMap.size`).
- `uptime` — seconds since process start (e.g. `Math.floor(process.uptime())`).

Rules:

- **No auth.** The platform probes it anonymously.
- **Cheap: must respond in < 100 ms and must not touch game logic** — no turn
  resolution, no room iteration, no I/O. If the event loop is blocked by game
  code, the check failing is the *correct* signal; the handler itself must
  never be the slow part.
- Same HTTP port as everything else (`PORT`); no separate admin port.

Consumers (already wired, all probing this exact endpoint):

| Consumer | Where | Cadence |
| --- | --- | --- |
| Docker `HEALTHCHECK` | `deploy/Dockerfile.server` | every 30s, 5s timeout, 3 retries, 15s start period |
| Fly.io platform check | `deploy/fly.toml` `[checks.healthz]` | every 15s, 5s timeout, 10s grace |
| Compose healthcheck | `deploy/docker-compose.yml` `services.server.healthcheck` | every 30s |

A Fly deploy only goes live once this check passes — **the server is
undeployable until `/healthz` exists.**

## 2. Environment variables

The server reads all configuration from these variables. Canonical set:

| Name | Type | Default | Consumer | Notes |
| --- | --- | --- | --- | --- |
| `PORT` | int | `8080` (in containers) | server | HTTP + socket.io listen port. **The server MUST read `PORT` and bind `0.0.0.0`** (not `127.0.0.1`/`localhost`) — containers route traffic to the container IP, and a loopback bind fails every health check and all player traffic. |
| `NODE_ENV` | string | `production` (in containers) | server, build | Standard Node semantics. Deploy images set it in the runtime stage. |
| `CORS_ORIGIN` | string (comma-separated origins) | *(unset — deny cross-origin)* | server | Allowed origins for socket.io/http. **MUST gate both the Express CORS middleware AND the socket.io server `cors` config** — they are configured separately in code and it is a classic bug to set only one. Split on `,`, trim entries. Example: `https://imperium-game.fly.dev,https://imperium.example.com`. |
| `ROOM_TTL_SECONDS` | int | `3600` | server | Empty rooms are reaped after this many seconds. Reaper must log `room_reaped` (see §6). |
| `LOG_LEVEL` | string | `info` | server | Minimum level emitted (`debug`\|`info`\|`warn`\|`error`). |

Rules:

- Unknown/extra env vars must be ignored, never fatal.
- Defaults live **in code** (the table above), so a bare `node server/dist/index.js`
  boots; deploy configs (`fly.toml [env]`, compose `environment:`) restate them
  explicitly for legibility.
- No other configuration channels (no config files, no CLI flags) for these
  values — env vars only, so every platform can set them the same way.

TODO(scaffold): server reads none of these variables today (no server code exists) — implement `PORT` (bind `0.0.0.0`), `NODE_ENV`, `CORS_ORIGIN` (gating both Express CORS and socket.io `cors`), `ROOM_TTL_SECONDS` (empty-room reaper), and `LOG_LEVEL` with the exact names and defaults in the table above.

## 3. Graceful shutdown (SIGTERM)

Platform deploys, restarts, and host migrations deliver **SIGTERM** to PID 1.
Without a handler, Node dies instantly and every live game is silently killed
mid-turn. The deploy layer already guarantees the signal reaches the process
(`CMD` in exec form so node is PID 1; Fly `kill_signal = "SIGTERM"`,
`kill_timeout = "30s"`; compose `stop_grace_period: 25s` — both > the 20s drain
window below).

**Status: not implemented.**
TODO(scaffold): implement the SIGTERM sequence below in the server entrypoint.

Implementable sequence, in order:

1. **On SIGTERM: stop accepting new rooms.** Set a `shuttingDown` flag;
   `create_room` requests are refused with a "server restarting, retry shortly"
   error. Existing rooms keep playing. (Optionally also return non-`ok` from
   `/healthz` here so the platform stops routing new traffic — nice-to-have,
   not required.)
2. **Broadcast a `server_shutdown` socket event to all connected sockets**,
   with a reconnect hint payload:
   ```json
   { "reconnectAfterMs": 5000 }
   ```
   Clients use this to show "server restarting…" and schedule a reconnect
   attempt (see §4). The event name is canonical: `server_shutdown`, lowercase
   snake_case.
3. **Drain: wait up to 20s** for in-flight turns to resolve. Poll (or await)
   until no room has a turn mid-resolution, or the 20s deadline passes —
   whichever comes first. Do not start new turn timers during the drain.
4. **Close** the socket.io server and the HTTP server, then **`process.exit(0)`.**
   Exit code 0 always — a drained shutdown is a success, and non-zero exits
   trip platform crash-loop detection.

Also handle **SIGINT** identically (local `Ctrl-C` in `docker compose` doubles
as a free test of this path).

Why: this is the difference between "deploys are invisible to players between
turns" and "every deploy kills every live match with no warning". Note the
limits honestly: the drain protects *in-flight turns*, not whole games —
in-memory room state still dies with the process until persistence exists (§7).

## 4. Reconnect expectations

- **Client:** socket.io's default auto-reconnect (exponential backoff) is
  acceptable — do not disable it. On receiving `server_shutdown`, the client
  should surface a "reconnecting…" state and honor `reconnectAfterMs` as the
  initial retry delay.
- **Server:** a socket disconnect is **not** a player leaving. Keep the
  disconnected player's slot in the room for a grace window — **suggested
  120s** — during which the player is marked `disconnected` but their seat,
  state, and turn order are preserved. The grace window must be ≤
  `ROOM_TTL_SECONDS`; a room whose players are *all* gone becomes "empty" and
  enters the `ROOM_TTL_SECONDS` reaping clock (§2).
  TODO(scaffold): disconnect grace window not implemented (no server code exists) — implement a 120s per-player grace period tied to room membership.
- **Rejoin:** the client rejoins with the 6-char room code **plus a session
  token the server issues on join** (opaque random string, stored client-side,
  presented on reconnect). Room code alone is not enough — anyone with the
  code could hijack a seat.
  TODO(scaffold): session token not implemented yet — server must issue a per-player session token on join and require it (room code + token) to re-attach a socket to an existing player slot.
- **Blunt truth about restarts:** reconnect logic only survives *network*
  blips and same-process socket drops. **A deployment restart WILL drop all
  in-memory state — every live game is lost — until persistence exists (§7).**
  The graceful shutdown in §3 makes that loss orderly (players get
  `server_shutdown` and in-flight turns finish); it does not make it survivable.
  Do not promise players otherwise.

## 5. Scaling: one instance, period

**One game room lives on exactly one server instance.** State is in-memory and
socket.io connections terminate on the process that holds it. Consequences:

- **Run exactly ONE instance.** On Fly: `fly scale count 1` (the committed
  `deploy/fly.toml` already pins `min_machines_running = 1`,
  `auto_stop_machines = false`). Scale **up** (memory, CPU size), never
  **out**.
- **Sticky sessions are NOT sufficient** for correctness across instances.
  Stickiness only pins a *connection*; it does nothing for two players of the
  same room landing on different instances (each instance would hold a
  different, partial copy of "the" room), and socket.io's long-polling
  handshake additionally breaks without it. Correct multi-instance operation
  requires **a shared socket.io adapter (socket.io-redis) AND a shared/routed
  state store** — stickiness alone gives you split-brain rooms that look fine
  in a 1-browser test.
- **Scaling beyond 1 instance is a project, not a knob.** Do not "just bump
  count" during an incident; it makes things worse (rooms silently shard).

When we outgrow one instance, the path is:

1. **socket.io Redis adapter** (`@socket.io/redis-adapter`) so events fan out
   across instances.
2. **Room-affinity routing** so all sockets of a room land on the instance
   that owns it (on Fly, `fly-replay`/`fly-force-instance-id` is the
   primitive; see `deploy/README.md` host comparison).
3. **Persistence** (§7) so room ownership can move between instances and
   survive restarts.

All three before count > 1. Until then: one region, one machine, more RAM.

## 6. Logging

Single-line JSON to **stdout**, one object per line (platform log shippers and
`grep` both depend on one-event-per-line). Canonical shape:

```
{ts, level, roomCode?, event, msg}
```

- `ts` — ISO-8601 UTC timestamp.
- `level` — `debug` | `info` | `warn` | `error`; gated by `LOG_LEVEL` (§2).
- `roomCode` — the 6-char room code, present only when the event concerns a
  room.
- `event` — machine-readable snake_case event name.
- `msg` — short human-readable message. Extra context keys are allowed after
  these; the five canonical keys must keep these exact names.

Example lines (canonical event names — use these where applicable):

```json
{"ts":"2026-07-11T14:02:11.412Z","level":"info","roomCode":"K7QF2X","event":"room_created","msg":"room created by Aldric (2-5 players)"}
{"ts":"2026-07-11T14:02:39.006Z","level":"info","roomCode":"K7QF2X","event":"player_joined","msg":"Isabeau joined (3/5 seats filled)"}
{"ts":"2026-07-11T14:11:53.771Z","level":"info","roomCode":"K7QF2X","event":"turn_resolved","msg":"turn 4 resolved in 213ms"}
{"ts":"2026-07-11T15:12:00.030Z","level":"info","roomCode":"Q2VN8L","event":"room_reaped","msg":"empty room reaped after ROOM_TTL_SECONDS=3600"}
{"ts":"2026-07-11T16:40:02.900Z","level":"info","event":"shutdown","msg":"SIGTERM: new rooms refused, server_shutdown broadcast, draining up to 20s"}
```

Rules:

- **No PII beyond player display names.** No emails, no IPs at `info` level,
  no fingerprints.
- **No secrets in logs, ever** — no tokens (including the §4 session token),
  no env dumps, no `CORS_ORIGIN`-adjacent header spew.
- No multi-line stack traces at `info`; errors go on one line
  (`level:"error"`, stack collapsed or in an extra key).

TODO(scaffold): no logger exists — implement a single-line JSON stdout logger with the exact `{ts, level, roomCode?, event, msg}` shape, gated by `LOG_LEVEL`, emitting at least the five canonical events above.

## 7. Backup / persistence story — FUTURE, NOT YET IMPLEMENTED

**Today: none.** All state is in-memory. Restarts, deploys, crashes, and host
migrations lose every live game. **This is accepted for the playtest phase**
— §3 makes the loss orderly, §4 tells players the truth, and nothing in this
section blocks v1 deployment.

When persistence lands (suggested: **SQLite file on a platform volume** for
one instance, or **Postgres via a platform addon** if we want it managed), the
contract becomes:

- **Snapshot room state on turn boundaries** — a turn boundary is the natural
  consistency point (no mid-resolution partial state). Serialize the full room
  (players, map state, turn number, RNG seed) keyed by `roomCode`.
- **Restore on boot** — on startup, load non-expired snapshots and mark their
  players `disconnected` pending rejoin via room code + session token (§4).
- **Backups:** daily volume snapshot (SQLite on Fly: `fly volumes snapshots`)
  or daily `pg_dump` (Postgres), **retention 7 days**.
- `/healthz` stays cheap — it must not touch the store.

Until this section is implemented, treat every deploy as "all games end now"
and schedule deploys accordingly (off-peak, after announcing in-game via the
§3 broadcast).

## 8. Incident quickies

**See logs**

```sh
fly logs -c deploy/fly.toml                                  # live tail (prod)
fly logs -c deploy/fly.toml | grep '"roomCode":"K7QF2X"'     # one room
docker compose -f deploy/docker-compose.yml logs -f server   # local stack
```

**Restart**

```sh
fly machine list -c deploy/fly.toml          # get <machine-id>
fly machine restart <machine-id> -c deploy/fly.toml
```

Remember: a restart **loses all live games** (§7). It sends SIGTERM first, so
the §3 drain applies.

**Roll back one release**

```sh
fly releases -c deploy/fly.toml              # list releases; note the previous
                                             # release's image reference
fly deploy -c deploy/fly.toml --image <registry.fly.io/imperium-game@sha256:...>
```

Redeploying the previous image is the rollback — Fly keeps the image refs in
`fly releases`. (No `fly rollback` command; `--image` is the mechanism.)

**Health check failing — triage in this order**

1. **Is the process up?** `fly status -c deploy/fly.toml` / `fly machine list`.
   Crash-looping → step 2; running but unhealthy → step 3.
2. **Read the crash:** `fly logs`. Usual suspects: listen error (`EADDRINUSE`,
   or bound to `127.0.0.1` instead of `0.0.0.0` — §2), missing build output
   (`Cannot find module server/dist/index.js`), non-zero exit from an unhandled
   rejection.
3. **Probe from inside the machine**, bypassing the platform proxy:
   `fly ssh console -c deploy/fly.toml` then
   `curl -sS http://localhost:8080/healthz`. Works inside but fails outside →
   port/config mismatch (`PORT` env vs `internal_port` in `fly.toml` vs
   `[checks]` port — all must be 8080). Fails inside → app bug, go to 4.
4. **Slow, not dead?** If `/healthz` responds but takes > the 5s check timeout,
   the event loop is blocked — almost always game logic, since the handler
   itself touches none (§1). Look for a hot room in the logs (`turn_resolved`
   durations climbing) before blaming the check.
5. **Started with the last deploy?** Roll back one release (above), then debug
   the bad image offline.
6. **Local repro:** `docker compose -f deploy/docker-compose.yml up --build`,
   then `curl -fsS http://localhost:3000/healthz` (nginx proxies to the
   server) — same image, same contract, no platform in the way.

## 9. Contract status: what the scaffold already satisfies vs. asks

Per the deploy recon (2026-07-11): the scaffold branch never reached the
remote; `origin/main` contains only `.gitignore`. **Items already satisfied:
NONE.** Every contract item below is an open ask on the scaffold team. The
contract itself (names, shapes, defaults) is canonical and final — only the
implementations are pending.

| # | Contract item | Scaffold status | Ask |
| --- | --- | --- | --- |
| 1 | `GET /healthz` → `200 {"status":"ok","rooms":<int>,"uptime":<seconds>}`, <100ms, no game logic | Missing | TODO(scaffold): implement `/healthz` exactly as §1 — Fly deploys fail their health check until it exists. |
| 2 | Read `PORT` (default 8080), bind `0.0.0.0` | Missing | TODO(scaffold): read `PORT` and bind `0.0.0.0` — loopback binds are invisible to containers. |
| 3 | `CORS_ORIGIN` gates Express CORS **and** socket.io `cors` | Missing | TODO(scaffold): parse comma-separated `CORS_ORIGIN` and apply it to both layers. |
| 4 | `ROOM_TTL_SECONDS` empty-room reaper (default 3600) | Missing | TODO(scaffold): implement the reaper; log `room_reaped`. |
| 5 | `LOG_LEVEL` + single-line JSON stdout logs `{ts, level, roomCode?, event, msg}` | Missing | TODO(scaffold): implement the §6 logger and canonical event names. |
| 6 | socket.io at default `/socket.io/` on the same HTTP port as Express | Missing | TODO(scaffold): attach socket.io to the Express HTTP server; do not customize the path. |
| 7 | SIGTERM graceful shutdown (refuse new rooms → broadcast `server_shutdown` `{reconnectAfterMs}` → ≤20s drain → exit 0) | Missing | TODO(scaffold): implement the §3 sequence; keep node as PID 1 (deploy images already ensure this). |
| 8 | Disconnect grace window (120s) + rejoin via room code **and** server-issued session token | Missing | TODO(scaffold): issue a session token on join; hold disconnected seats 120s; require code+token to re-attach. |
| 9 | Serve built client same-origin with SPA fallback when `SERVE_CLIENT` is set (v1 single-app path, see `deploy/README.md` §8) | In flight | Lands from the game-client workstream (`feature/game-client`): `express.static` + `index.html` fallback gated on `SERVE_CLIENT=<absolute dist path>` (unset/empty = static serving fully disabled; confirmed contract, frozen with the game-client workstream). Deploy side is done: `deploy/Dockerfile.server` ships `client/dist` and bakes `SERVE_CLIENT=/app/client/dist`. |

Not asks (deploy-layer facts the scaffold can rely on): SIGTERM is delivered
with ≥25s before SIGKILL; `PORT=8080`, `NODE_ENV=production`,
`ROOM_TTL_SECONDS=3600`, `LOG_LEVEL=info` are set by `deploy/fly.toml` and
`deploy/docker-compose.yml`; `CORS_ORIGIN` is set per-environment; exactly one
instance runs in production.

---

*Companion docs: `deploy/README.md` (host evaluation + Fly runbook),
`deploy/Dockerfile.server`, `deploy/docker-compose.yml`, `deploy/fly.toml`.*
