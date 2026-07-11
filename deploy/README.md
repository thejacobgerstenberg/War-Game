# Hosting Evaluation & Runbook — IMPERIUM: Twilight of Empires

Server-authoritative socket.io game server (Node 20 + Express), 2-5 players per
room, **all room state in-memory on one process**. This document evaluates hosts,
recommends one, and gives the exact path from merged code to a shareable URL.

> **Scaffold status (2026-07-11):** the game scaffold has **not** merged to
> `main` yet — there is no `server/`, `client/`, or root `package.json` on the
> base branch. Everything below is written against the canonical production
> contract (recapped next). Anything that depends on scaffold decisions that
> have not landed is flagged inline with a scaffold-TODO marker.

## The canonical production contract (what any host must satisfy)

- Server listens on **`PORT`** (default **8080** in containers).
- Env vars: **`PORT`**, **`NODE_ENV`**, **`CORS_ORIGIN`** (comma-separated
  allowed origins for socket.io/http), **`ROOM_TTL_SECONDS`** (default `3600`;
  empty rooms reaped after this), **`LOG_LEVEL`** (default `"info"`).
- Health: **`GET /healthz`** → `200` JSON
  `{"status":"ok","rooms":<int>,"uptime":<seconds>}` — no auth, cheap, used by
  platform health checks.
- socket.io at the default path **`/socket.io/`** on the **same HTTP port** as
  Express.
- Graceful shutdown: on **SIGTERM** stop accepting new rooms, broadcast a
  `server_shutdown` socket event with a reconnect hint, wait up to **20s** for
  in-flight turns, exit 0. (Host must allow ≥20s between SIGTERM and SIGKILL.)
- **One game room lives on exactly one server instance** (in-memory state):
  no horizontal scaling of a single room; **scale = 1 instance** until a
  room-affinity layer exists.
- Logs: single-line JSON to stdout: `{ts, level, roomCode?, event, msg}`.

## Host comparison: Fly.io vs Railway vs Render

| Dimension | Fly.io | Railway | Render |
| --- | --- | --- | --- |
| **WebSocket support** | First-class; long-lived connections through the Fly proxy with no special config. | Works out of the box; no special config. | Works out of the box on web services. |
| **Sticky sessions / affinity** | No cookie-based stickiness, but `fly-replay`/`fly-force-instance-id` can pin requests to a machine — a real primitive for a future room-affinity layer. | None; multiple replicas are load-balanced with no affinity control. | None; no session-affinity option on its load balancer. |
| **Why we don't care (yet)** | We pin **1 instance total** (in-memory rooms), so affinity is moot for v1. It only matters when we go multi-instance, where socket.io would additionally need a pub/sub adapter (e.g. Redis) *and* sticky routing for the long-polling handshake. Fly is the only one of the three with a usable pinning primitive for that future. | Same 1-instance reality. | Same 1-instance reality. |
| **Free/cheap tier reality** | No free tier for new orgs (pay-as-you-go). `shared-cpu-1x` 512MB always-on ≈ **$3–4/mo** (+ small egress); historically invoices under ~$5 were waived. Machines *can* scale to zero — we deliberately disable that. | No persistent free tier: one-time ~$5 trial credit, then Hobby **$5/mo** which includes $5 of usage; ~0.5 vCPU/512MB always-on lands roughly **$5–10/mo**. | Free web services **spin down after ~15 min idle** with ~50s cold starts — disqualifying for live matches. Cheapest always-on: Starter ≈ **$7/mo** (0.5 CPU / 512MB). |
| **Regions (EU + US)** | 30+ regions incl. `fra`, `ams`, `lhr`, `cdg` (EU) and `iad`, `ord`, `sjc`, `lax` (US). You pick per app. | Fewer regions; has US East/West and an EU (Amsterdam-area) region on paid plans. | Frankfurt (EU) + Oregon/Ohio/Virginia (US) + Singapore. |
| **Dockerfile deploy** | Native and primary path; builds on a remote builder or local Docker; config (`fly.toml`) lives in-repo. | Supported (auto-detected Dockerfile), alongside Nixpacks/Railpack buildpacks. | Supported natively alongside buildpack-style builds. |
| **TLS / custom domain** | Free managed Let's Encrypt certs via `fly certs add`; `*.fly.dev` URL with TLS out of the box. | Free automatic TLS; `*.up.railway.app` URL + custom domains. | Free automatic TLS; `*.onrender.com` URL + custom domains. |
| **Deploy speed** | Fast: remote builder + rolling machine update, typically 1–3 min after the first (cached) build. | Very fast and lowest-friction of the three; ~1–3 min. | Historically the slowest builds of the three; a few minutes, and free-tier builds can queue. |

> **⚠️ VERIFY AT DEPLOY TIME** — this environment cannot reach vendor sites, and
> prices/free tiers change often. Before deploying, re-check on the vendors'
> pricing/docs pages:
> 1. Fly.io: current `shared-cpu-1x` per-GB-RAM pricing, whether the
>    small-invoice waiver (<~$5) still exists, egress $/GB, and the current
>    `fly.toml` schema for `[checks]` / `[http_service]` / `[[vm]]`.
> 2. Railway: trial credit amount, Hobby plan price and included usage,
>    per-GB-min/vCPU-min usage rates, which regions are available on which plan.
> 3. Render: free-tier spin-down policy (idle minutes, cold-start time, monthly
>    hour cap), Starter plan price and machine size.
> 4. All three: SIGTERM grace period (must be ≥ our 20s drain window; on Fly we
>    set `kill_timeout = "30s"` in `deploy/fly.toml`).
> 5. All three: WebSocket idle-connection timeout on their proxies (socket.io
>    heartbeats every 25s by default, which normally keeps connections alive).

## Recommendation: Fly.io (primary), Railway (runner-up)

**Fly.io** is the best fit: it deploys our real Dockerfile with an in-repo,
reviewable config (`deploy/fly.toml`), treats long-lived WebSocket connections
as a first-class citizen, and its explicit machine model (`count = 1`,
`auto_stop_machines = false`, `min_machines_running = 1`) makes our hard
"one instance, never sleep" constraint a three-line config instead of a
support-ticket conversation. It has both EU and US regions so we can put the
single machine where the players are, and `fly-replay` gives us a credible
path to multi-instance room affinity later without changing hosts. **Render's
free tier spins down idle services** — fatal mid-match — and its paid tier
buys us nothing Fly doesn't do cheaper; **Railway** is the pleasant low-friction
runner-up (great DX, Dockerfile support, EU region) but offers less explicit
control over instance count/sleep semantics and no affinity primitive for the
future. If Fly onboarding ever becomes a blocker, Railway is the fallback and
this Dockerfile works there unchanged.

## Fly.io runbook

All commands run from the **repo root**. The committed config is
`deploy/fly.toml`; the server image is built from `deploy/Dockerfile.server`
with the **repo root as build context** (so the build can see `server/`,
`shared/`, and the root `package.json`).

### 0. Prereqs

- The merged scaffold implements the contract above (`/healthz`, `PORT`,
  SIGTERM drain). `TODO(scaffold):` none of this exists on `main` yet — do not
  deploy before the scaffold lands; the health check will fail the deploy.
- Docker running locally only if you want local builds; Fly's remote builder
  works without it.

### 1. Install flyctl and authenticate

```sh
# macOS
brew install flyctl
# Linux
curl -L https://fly.io/install.sh | sh

fly auth signup   # first time — or:
fly auth login
```

### 2. Create the app (no deploy yet)

```sh
fly launch --no-deploy -c deploy/fly.toml
```

Pick the real app name and org when prompted (the committed placeholder is
`imperium-game`; app names are globally unique). If your flyctl version
insists on writing a fresh `./fly.toml` instead of honoring `-c`, use the
equivalent explicit form and keep our committed config authoritative:

```sh
fly apps create <your-app-name>
```

Then set `app = "<your-app-name>"` in `deploy/fly.toml` and commit it.
Region is already pinned in the config (`primary_region = "fra"`; use `iad`
for a US-centered player base).

### 3. Set env / secrets (canonical names, exactly)

Non-secret defaults are already committed in `deploy/fly.toml` under `[env]`:
`PORT=8080`, `NODE_ENV=production`, `ROOM_TTL_SECONDS=3600`, `LOG_LEVEL=info`.

`CORS_ORIGIN` depends on where the client lives, so set it per-app:

```sh
# v1 single-container (client served same-origin by the server — see step 8):
fly secrets set -c deploy/fly.toml CORS_ORIGIN="https://<your-app-name>.fly.dev"

# If the client is hosted elsewhere, comma-separate all allowed origins:
fly secrets set -c deploy/fly.toml \
  CORS_ORIGIN="https://<your-app-name>.fly.dev,https://imperium.example.com"
```

Secrets override `[env]` values of the same name, so `CORS_ORIGIN` can be
rotated without a config commit.

### 4. Deploy

```sh
fly deploy -c deploy/fly.toml --dockerfile deploy/Dockerfile.server
```

First build is the slowest (image layers cold); subsequent deploys reuse the
cache. The deploy only goes live once the `/healthz` check in `[checks]`
passes (GET every 15s, 10s grace after boot).

### 5. Verify

```sh
curl -fsS https://<your-app-name>.fly.dev/healthz
# expect: {"status":"ok","rooms":0,"uptime":<seconds>}
```

Then the real test: open two browser tabs, create a room, join it from the
second tab with the 6-char room code. The socket.io connection uses the
default `/socket.io/` path on the same origin/port — no extra Fly config
needed.

### 6. Logs

```sh
fly logs -c deploy/fly.toml          # live tail
```

Expect single-line JSON per the contract: `{ts, level, roomCode?, event, msg}`.
Filter by room: `fly logs -c deploy/fly.toml | grep '"roomCode":"ABC123"'`.

### 7. Scaling — memory, never count

```sh
fly scale count 1 -c deploy/fly.toml      # assert the invariant (already the config default)
fly scale memory 1024 -c deploy/fly.toml  # when rooms/RSS grow, bump RAM
```

**Never set count above 1.** Rooms are in-memory; a second machine would mean
players in the same room land on different processes with different (missing)
state, and socket.io long-polling handshakes would also need sticky routing.
Scale **up** (memory, then CPU size), not **out**, until a room-affinity layer
exists. `auto_stop_machines = false` in the config keeps the machine from
sleeping mid-match — that is deliberate and costs a few $/mo more than
scale-to-zero.

### 8. Serving the static client

Two options; **pick the single-container path for v1**:

- **Primary (v1): one container serves everything.** Express statically serves
  the built client (`client/dist`) with an `index.html` SPA fallback, so the
  game is same-origin with the socket — no CORS pain (`CORS_ORIGIN` is just the
  app's own origin), one URL, one deploy, one TLS cert.
  `TODO(scaffold):` the scaffolded server does not yet have the
  `express.static(client/dist)` + SPA-fallback wiring (no server code exists on
  `main` at all) — file a follow-up on the scaffold to add it, and extend
  `deploy/Dockerfile.server` with a client build stage that copies
  `client/dist` into the runtime image (today that Dockerfile builds `shared/`
  + `server/` only). Until both land, the Fly app serves only the API/socket
  and `/healthz`.
  `TODO(scaffold):` `client/dist` assumes the Vite default `outDir`; verify
  once `client/vite.config.*` lands.
- **Alternative: nginx in front (what local compose does today).**
  `deploy/Dockerfile.client` builds the SPA into an nginx image whose config
  (`deploy/nginx.conf`) serves the static files and reverse-proxies
  `/socket.io/` and `/healthz` to the Node server — still same-origin for the
  browser, plus gzip/caching control. On Fly this means either two processes
  in one machine or two apps with internal networking: more moving parts than
  our scale justifies. Keep it for local prod-like testing; revisit only if
  static-asset serving measurably loads the Node process.

### 9. Custom domain + TLS

```sh
fly certs add imperium.example.com -c deploy/fly.toml
fly certs show imperium.example.com -c deploy/fly.toml   # shows the DNS records to create
```

Create the `A`/`AAAA` records (or a `CNAME` to `<your-app-name>.fly.dev`) at
your DNS provider; the Let's Encrypt cert issues automatically once DNS
resolves (minutes to ~an hour). Then **add the new origin to `CORS_ORIGIN`**
(comma-separated) via `fly secrets set` — see step 3. `force_https = true` in
the config redirects any plain-HTTP hits.

## Local prod-like test

Before (or instead of) pushing to Fly, run the production images locally. From
the repo root:

```sh
docker compose -f deploy/docker-compose.yml up --build
```

This starts two services (see `deploy/docker-compose.yml`): the game server
(internal port 8080, deliberately not published to the host) and an nginx
client at `http://localhost:3000` that serves the SPA and proxies
`/socket.io/` and `/healthz` to the server, same-origin. Verify with

```sh
curl -fsS http://localhost:3000/healthz
```

then play a two-tab match at `http://localhost:3000`. To hit the server
directly on `localhost:8080`, uncomment the `ports:` mapping on the `server`
service in the compose file. Note it is `docker compose` (the v2 plugin — this
environment has v5.1.1); the standalone `docker-compose` binary is not
installed here. `Ctrl-C` sends SIGTERM (compose grants a 25s
`stop_grace_period`), which doubles as a cheap check of the 20s
graceful-shutdown drain — watch for the `server_shutdown` broadcast in the
logs.

## Time-to-live: "code merged" → shareable URL (< 1 hour)

Assumes the scaffold has merged AND the single-container static-serving
follow-up from step 8 has landed (otherwise the Fly URL serves only the
API/socket, not the game UI).

| # | Step | Est. |
| --- | --- | --- |
| 1 | `git pull` merged `main`; confirm `deploy/` files present | 2 min |
| 2 | Local prod-like smoke: `docker compose -f deploy/docker-compose.yml up --build`, curl `http://localhost:3000/healthz`, 2-tab room join | 10 min |
| 3 | Install flyctl + `fly auth login` (first time only) | 5 min |
| 4 | `fly launch --no-deploy -c deploy/fly.toml` (name + org), commit real app name | 3 min |
| 5 | `fly secrets set CORS_ORIGIN=...` | 2 min |
| 6 | `fly deploy -c deploy/fly.toml --dockerfile deploy/Dockerfile.server` (first build is the slow one) | 8 min |
| 7 | `curl https://<app>.fly.dev/healthz`; create + join a room from two devices | 5 min |
| 8 | `fly logs` sanity pass (JSON lines, no error-level spam) | 3 min |
|   | **Total to shareable `https://<app>.fly.dev`** | **~38 min** |
|   | Optional: custom domain + cert (`fly certs add`, DNS, extend `CORS_ORIGIN`) | +10–15 min (DNS-bound) |

## File map

| File | Purpose |
| --- | --- |
| `deploy/README.md` | This document. |
| `deploy/fly.toml` | Committed Fly.io config (region, env defaults, health check, 1-machine scaling, no-sleep policy). |
| `deploy/Dockerfile.server` | Production server image (builds `shared/` + `server/`); build context = repo root. |
| `deploy/Dockerfile.client` | SPA build served by nginx — used by local compose and by the "nginx in front" alternative (step 8). |
| `deploy/nginx.conf` | nginx site config for the client image: serves the SPA, proxies `/socket.io/` + `/healthz` to the server. |
| `deploy/docker-compose.yml` | Local prod-like two-service stack (server + nginx client on `localhost:3000`). |
| `deploy/dockerignore` | Staged `.dockerignore` — copy to repo root when adopting (root is owned by the scaffold team). |

CI: image builds are handled by the adopted workflow in `.github/workflows/build-images.yml` (owned by the CI workstream, originally proposed by this workstream; see PR #1).
