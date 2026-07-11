# E2E & Load Test Harness

Black-box tests for the IMPERIUM lobby stack: a Playwright suite that drives
the real React client against the real server, and a plain-Node socket.io
load test that hammers the server transport directly and verifies the room
reaper. Nothing in here touches `server/`, `client/`, or `shared/` source —
both harnesses boot the actual code paths.

## What the harness covers

### Playwright E2E suite (`e2e/tests/lobby.spec.ts`)

Six scenarios, driven through the real client UI (home → create/join →
faction pick → lobby → game board), against the real server:

| # | Scenario | Status |
| --- | --- | --- |
| (a) | Host creates a game and sees a 6-char `A-Z0-9` room code | active |
| (b) | Second player joins by code; both browser contexts see both names in the roster | active |
| (c) | Faction exclusivity: second player's BYZANTIUM button is disabled ("Taken by …") once claimed | active |
| (d) | Host starts the game; both clients leave the lobby for the game board ("Theatre of War · Turn 1") | active |
| (e) | Rejoin: reloading a player's tab auto-rejoins the same seat via the stored session token | active |
| (e2) | Rejoin after start: reloading mid-game resumes on the game board | active |

**How rejoin works (and how (e)/(e2) exercise it):** the server acks
create/join with a per-player crypto-random `sessionToken`; the client
persists `{roomCode, playerId, sessionToken}` in sessionStorage (key
`imperium.session`, `client/src/session.ts`) and on every socket connect
auto-emits `rejoin_game {roomCode, sessionToken}` (`App.tsx` attemptRejoin).
`page.reload()` in the same tab keeps sessionStorage, so the fresh page
reclaims the same seat — same playerId, faction retained, no ghost
duplicate; other clients see the seat flip through `(disconnected)` and
back (`LobbyPlayer.connected` is on the wire). Post-start, the server
replays `game_started` + `state_update` to the rejoining socket, which is
what (e2) asserts. Same-name `join_game` is deliberately NOT a reclaim — it
is a clean "name taken" rejection.

Suite-wide notes: fonts are self-hosted (`client/public/fonts`), so no
network-blocking fixture is needed. Tests run serially (`workers: 1`)
against one shared in-memory server; each test creates its own room.

### Socket.IO load test (`e2e/load/socket-load.mjs`)

Plain Node + `socket.io-client` — no Playwright, no browser. It spawns the
**real server entrypoint** (`node --import tsx server/src/index.ts`) rather
than an in-process `createApp()`, so env parsing, the ROOM_TTL reaper
(owned by `createApp` since the scaffold fixes) and graceful shutdown are
all exercised as deployed. All 5 seats per room (the `MAX_PLAYERS = 5` cap
exactly) use names unique within the room, so the now-enforced cap and
"name taken" rejection are never tripped.

Coverage:

- **Load:** 50 rooms × 5 players = 250 concurrent websocket clients doing
  create → join → assemble → pick_faction. Factions are assigned
  deterministically by seat index (5 seats, 5 factions) so picks are never
  contested — the test measures transport, not contention.
- **Latency metrics:** connect latency (`io()` → `'connect'`) and
  pick_faction RTT (emit → the `lobby_update` reflecting the pick), reported
  as p50/p95/max.
- **Dropped-events assertion:** every expected event must arrive — per room
  1 create ack + 4 join acks (both arrive as `game_created`; the server acks
  `join_game` with the *same* event name), every client must see a 5-player
  `lobby_update`, every pick must be confirmed, and zero `error_msg`s are
  tolerated. Any shortfall after a generous timeout fails the run.
- **Reaper verification** via `GET /healthz`'s `rooms` count: 10 rooms
  teardown by `leave_game` (the last leave deletes the room synchronously);
  10 rooms teardown by bare `socket.disconnect()` (seats held → room has 0
  connected players → `emptySince` set → deleted by the periodic
  `reapEmptyRooms(ROOM_TTL_SECONDS)` sweep, interval `min(TTL, 60)s`). The
  run boots the server with `ROOM_TTL_SECONDS=2` so the reap is observable
  in seconds, and asserts rooms go 50 → 40 → 30 while the 30 rooms with live
  sockets survive.

Each run writes `e2e/load/LOAD_REPORT.md` (config, percentiles, event
accounting, reaper counts, PASS/FAIL per section). The committed copy is a
sample from a green run.

## How to run locally

From the repo root:

```sh
npm install           # once
npm run test:e2e      # Playwright suite (boots server + vite client itself)
npm run test:load     # socket.io load test (boots the server itself)
```

Both commands are self-contained: they build `@imperium/shared` and boot the
stack on their own dedicated ports, so they can run alongside a dev
`npm run dev` session.

### Browser note (important)

This environment ships **pre-installed** browsers at
`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` (chromium-1194).
`@playwright/test` is pinned to **1.56.1** in the root `package.json`
because that release expects exactly chromium revision 1194. Do not bump the
pin casually, and **never run `playwright install`** here — just run the
tests with `PLAYWRIGHT_BROWSERS_PATH` pointing at the pre-installed
browsers.

### Ports

| Port | Used by |
| --- | --- |
| 8080 | dev server default (`PORT` env; not used by tests) |
| 5173 | dev vite client (not used by tests) |
| 4610 | E2E server (`e2e/playwright.config.ts`, probed via `/healthz`) |
| 5610 | E2E vite client (`--strictPort`) |
| 4620 | load-test server (`ROOM_TTL_SECONDS=2`) |
| 4599 | `server/scripts/smoke.mjs` (separate, older smoke script) |

## CI wire-up proposal (NOT applied on this branch)

> **Proposal only.** `.github/` is owned by the CI workstream and is
> deliberately not edited on `feature/e2e`. The snippet below is what the CI
> workstream should add to `.github/workflows/ci.yml` on `feature/ci`, where
> a `detect` job already exposes `has_node` / `has_client` outputs.

```yaml
  e2e:
    needs: detect
    if: needs.detect.outputs.has_node == 'true' && needs.detect.outputs.has_client == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm ci
      # On GitHub-hosted runners there is no pre-installed browser cache, so
      # this is the one environment where installing IS correct — and it
      # installs exactly the chromium matching the pinned @playwright/test.
      - name: Install Playwright chromium
        run: npx playwright install --with-deps chromium
      - name: E2E tests (Playwright)
        run: npm run test:e2e
      - name: Load test (socket.io)
        run: npm run test:load
      - name: Upload Playwright traces
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-traces
          path: |
            e2e/test-results/
            e2e/load/LOAD_REPORT.md
          retention-days: 7
```

Notes for the CI workstream:

- Traces/screenshots are only produced on failure
  (`trace: "retain-on-failure"`, `screenshot: "only-on-failure"` in
  `e2e/playwright.config.ts`), so the upload step is gated on `failure()`.
- The load test bounds its own runtime (~3 min watchdog) and exits non-zero
  with a failure summary, so no extra `timeout-minutes` gymnastics are
  needed, though `timeout-minutes: 15` on the job is a sensible belt.
- If the runner environment ever provides pre-installed browsers (like this
  dev environment does), replace the install step with
  `PLAYWRIGHT_BROWSERS_PATH=...` and drop `playwright install`.
