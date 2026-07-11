# IMPERIUM — Staging Validation Report

- **Date:** 2026-07-11
- **Branch:** `deploy/staging-validation` (created from `origin/main`)
- **Validated SHA:** `c3060cf672eedfbbf70eaab9e7750494590b7c02` (main)
- **Contract document:** `deploy/OPERATIONS.md`
- **Evidence:** every claim below cites a verbatim capture under the session scratchpad,
  `…/scratchpad/staging-evidence/` (one file per check, plus two lobby screenshots).
  The raw server captures `server-run{1,2,3}.log`/`.exit` live one level up, directly in
  `…/scratchpad/`. Filenames below are relative to `staging-evidence/`.

---

## 1. What was validated, and how (container path: **no-containers**)

The goal was to prove the production deployment path defined in `deploy/`: the server
container's runtime contract (`/healthz` JSON, env-driven config, SIGTERM drain with
`server_shutdown` broadcast, JSON stdout logs, room reaper) and the client container's
single-origin topology (nginx serves the SPA and proxies `/socket.io/` + `/healthz` to
`server:8080`).

**Container path used: no-containers (approximation).** Neither `ghcr-pull` nor
`local-build` was possible in this environment:

- Docker Engine 29.3.1 runs fine locally (daemon started manually, `dockerd.log`), but the
  org agent proxy **denies CONNECT at policy level to the blob CDN hosts of both
  registries** — `pkg-containers.githubusercontent.com` (GHCR) and
  `production.cloudfront.docker.com` (Docker Hub) both return `403 Forbidden` on layer
  download, while manifest fetches succeed (`ghcr-pull.txt`, `hub-node-pull.txt`). This
  blocks image pulls *and* local builds (which need base images `node:20-slim` and
  `nginxinc/nginx-unprivileged:1.27-alpine`).
- Per `/root/.ccr/README.md`, this class of egress-allowlist block is to be **reported to
  an admin, not worked around**. It has been routed accordingly (see §5).
- CI images for the exact validated SHA **do exist on GHCR**: `build-images.yml` run #10
  completed with conclusion `success` on head SHA `c3060cf672` at 2026-07-11T20:11:56Z.
  Only local pull-through is blocked.

**Approximation used instead** (higher fidelity than the initial facts-file plan):

- **Client:** built *exactly as `deploy/docker-compose.yml` builds it* — production Vite
  build with `VITE_SERVER_URL=""` (same-origin) — and served on `:3000` by a
  scratchpad-only vite preview config (`scratchpad/preview-proxy.config.mjs`) that
  WS-proxies `/socket.io/` and `/healthz` to the server on `:8080`, mirroring
  `deploy/nginx.conf`'s single-origin topology.
- **Server:** `server/dist` run under Node with the **exact compose env**
  (`NODE_ENV=production PORT=8080 CORS_ORIGIN=http://localhost:3000
  ROOM_TTL_SECONDS=3600 LOG_LEVEL=info`) via `scratchpad/run-server.sh`, which also
  records exit codes (stand-in for `docker inspect .State.ExitCode`).
- `kill -TERM` stands in for `docker stop` (same signal); wrapper-captured stdout stands
  in for `docker compose logs`.

**What this approximation did NOT validate** (stated plainly): the Dockerfiles
themselves; actual nginx binary/config execution (headers, gzip, caching, upstream DNS
resolution of `server:8080`); container users, healthchecks, and restart policies. These
require a rerun of the containerized path
(`docker compose -f deploy/docker-compose.yml up --build -d`) once registry egress is
allowlisted.

---

## 2. Versions and SHAs

| Item | Value |
|---|---|
| Validated git SHA (main / branch base) | `c3060cf672eedfbbf70eaab9e7750494590b7c02` |
| GHCR CI images for this SHA | `build-images.yml` run #10, head `c3060cf672`, `completed`/`success`, 2026-07-11T20:11:56Z (image digests not retrievable locally — blob pull blocked) |
| Local build artifacts validated | server: `server/dist` (tsc build at c3060cf6); client bundle: `/assets/index-DILMrHhA.js`, `/assets/index-FE054mxp.css` (vite production build, `VITE_SERVER_URL=""`) |
| Docker Engine (client + server) | 29.3.1 (Community), containerd snapshotter, overlayfs — daemon healthy but unused for the checks (registry egress blocked) |
| Docker Compose plugin | v5.1.1 |
| Node runtime | Node 20+ per repo contract; server run with `NODE_ENV=production` |
| Browser for e2e | Chromium rev 1194 (`/opt/pw-browsers`, no downloads), Playwright, two isolated contexts |

---

## 3. Check-by-check results

All 7 checks **pass**, all via the no-containers approximation (each evidence file is
headed `APPROXIMATED, NOT CONTAINERIZED`).

| # | Check | Result | Evidence (file + key verbatim quote) |
|---|---|---|---|
| 1 | `healthz-shape` | **PASS** (approximated) | `healthz-shape.txt` — HTTP 200 on **both** `:3000` (proxy) and `:8080` (direct), body `{"status":"ok","rooms":0,"uptime":50}`, `content-type: application/json; charset=utf-8`. Node assertion: keys exactly `rooms,status,uptime`, `status==="ok"`, `rooms` integer, `uptime` number — `ASSERT PASS … (exit 0)` for both URLs. The real `nginx.conf /healthz` location was not executed; only its topology was reproduced. |
| 2 | `lobby-e2e` | **PASS** (approximated) | `lobby-e2e.txt` + screenshots `lobby-e2e-contextA.png` / `lobby-e2e-contextB.png`. Context A (Aldric) created room, 6-char code `IUWVUR` captured from the lobby UI; context B (Isabeau) joined by typing it. Both rosters (verbatim innerText): `Aldric · host / BYZANTIUM / Isabeau / OTTOMAN`. Screenshots visually verified: host view with Start Game enabled; guest view "Awaiting the host…". |
| 3 | `ws-upgrade` | **PASS** (approximated — proven through the vite-preview stand-in, not nginx itself) | `ws-upgrade.txt` — both contexts' WebSockets at `ws://localhost:3000/socket.io/?EIO=4&transport=websocket` (same-origin `:3000`); engine.io upgrade handshake frames `2probe` → `3probe` → `5` captured, game frames flowing (Playwright only surfaces a websocket after the 101 handshake). All 8 `/socket.io/` polling requests target `localhost:3000`; `network requests to localhost:8080 from either context: 0 (PASS — none)`. |
| 4 | `no-hardcoded-origin` | **PASS** (approximated — bundle served by vite preview, but built exactly as compose builds it, `VITE_SERVER_URL=""`) | `no-hardcoded-origin.txt` — `grep -c 'localhost:8080'` = `0` in both `/assets/index-DILMrHhA.js` and `/assets/index-FE054mxp.css` (`grep exit code: 1 (1 = no match = PASS)`). The dev-only fallback literal in `client/src/socket.ts` is tree-shaken out of the production bundle. |
| 5 | `sigterm-drain` | **PASS** (approximated — `kill -TERM` for `docker stop`, wrapper exit code for `docker inspect`) | `sigterm-drain.txt` — with both clients connected and listeners armed **before** signalling: (a) both received `42["server_shutdown",{"reconnectAfterMs":5000}]` ~13 ms after SIGTERM; (b) server logged, all as single-line JSON: `"SIGTERM: new rooms refused, server_shutdown broadcast, draining up to 20s"` → `"drain complete: all sockets disconnected"` → `"server closed, exiting 0"`; (c) exit code `0` recorded 3.4 s after SIGTERM — inside the 20 s drain window and 25 s compose `stop_grace_period`. The full three-part assertion (client `server_shutdown` frames + JSON log sequence + exit 0) is evidenced for run 2; runs 1 and 3 corroborate the JSON log sequence + exit 0 only (run 3 had no connected clients). |
| 6 | `reaper` | **PASS** (approximated — `ROOM_TTL_SECONDS=10` as process env via scratchpad wrapper; committed compose untouched) | `reaper.txt` — room `RBQNKJ` created via socket.io through the `:3000` proxy (`/healthz` rooms 0→1), socket disconnected, and 11.1 s later: `{"ts":"2026-07-11T20:26:36.526Z","level":"info","roomCode":"RBQNKJ","event":"room_reaped","msg":"empty room reaped after ROOM_TTL_SECONDS=10"}`; `/healthz` rooms back to 0. |
| 7 | `log-shape` | **PASS** (approximated — wrapper-captured stdout for `docker compose logs`) | `log-shape.txt` — 20/20 lines across three server runs (≥5 required) parse as single-line JSON with ISO-8601 `ts`, `level` ∈ {debug,info,warn,error}, string `event`/`msg`, and 6-char `roomCode` exactly on room-scoped events, per OPERATIONS.md §6. Sample: `{"ts":"2026-07-11T20:22:02.728Z","level":"info","event":"server_started","msg":"IMPERIUM server listening on 0.0.0.0:8080"}`. Events observed: `server_started`, `room_created`, `player_joined`, `player_disconnected`, `room_reaped`, `shutdown`. 0 failures. |

---

## 4. deploy/ fixes applied during validation

**None.** No changes to `deploy/` were required — all committed configs
(`docker-compose.yml`, `nginx.conf`, Dockerfiles' build recipe as reproduced) behaved as
specified. The git working tree on `deploy/staging-validation` remained clean throughout;
the branch adds only two files, this report and `deploy/LAUNCH_CHECKLIST.md`.

---

## 5. Deviations & routed issues

**Server/client defects found:** none. Server and client behavior matched
`OPERATIONS.md` on every check; nothing was routed to the coordinator as a code defect.

**Deviations from the intended validation path:**

1. **Containers could not run at all** (the central deviation). The org agent proxy
   denies CONNECT to the GHCR and Docker Hub blob CDN hosts (`403 Forbidden` on layer
   downloads; manifests fetch fine — see `ghcr-pull.txt`, `hub-node-pull.txt`,
   `staging-facts.md`). This is an **egress-allowlist gap, routed to the org admin** per
   `/root/.ccr/README.md` ("reported, not worked around") — not a repo defect. Until
   allowlisted, no session in this environment can pull or build images.
2. Consequently, checks 1–7 validate the **application contract and the single-origin
   topology**, not the container packaging. Not exercised: Dockerfile builds, the actual
   nginx binary and `deploy/nginx.conf` execution (headers, gzip, caching, upstream
   resolution of `server:8080` over the compose network), unprivileged container users,
   compose healthchecks and restart policies.
3. `ROOM_TTL_SECONDS=10` for the reaper check was applied as a wrapper process env
   (scratchpad-only); the committed compose value (`3600`) was not modified.

---

## 6. Conclusion

**The application-level production contract is proven; the container packaging is not
yet proven end-to-end.**

Everything the running system is contractually required to do — `/healthz` shape,
same-origin lobby e2e with two real browsers, WebSocket upgrade through a single-origin
proxy, no hardcoded server origin in the production bundle, SIGTERM drain with
`server_shutdown` broadcast and exit 0 within the grace period, TTL room reaping, and
strict JSON stdout logging — passed with verbatim evidence, at the exact SHA
(`c3060cf6`) for which CI has already published green container images.

**Caveats, plainly:** every check ran via the no-containers approximation. The
Dockerfiles, nginx execution, container users, healthchecks, and restart policies remain
unvalidated in this environment. The production path should be declared fully proven
only after one containerized rerun —
`docker compose -f deploy/docker-compose.yml up --build -d` plus a re-execution of these
seven checks — once the registry blob CDN hosts are added to the proxy allowlist.
Given that the same SHA's images built green in CI and the reproduced topology matched
`nginx.conf`/compose exactly, the residual risk is confined to packaging, not behavior.
