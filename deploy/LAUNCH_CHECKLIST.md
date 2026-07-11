# Launch Checklist — main → live URL on Fly.io

Terse operator checklist. The full runbook with rationale is
[`deploy/README.md`](./README.md); the operational contract is
[`deploy/OPERATIONS.md`](./OPERATIONS.md). Run every command from the
**repo root** on a fresh pull of `main`. Steps tagged **[USER]** need the
account owner's own credentials (Fly account, DNS registrar) and cannot be
done by anyone else; **[ANY OPERATOR]** steps need only a checkout and an
authenticated `flyctl`.

## 1. Prereqs

- [ ] 1.1 **[USER]** Create a Fly.io account (`fly auth signup`) with a payment
      method on file — Fly has no free tier for new orgs (~$3–4/mo for this
      config; re-verify pricing, see README "VERIFY AT DEPLOY TIME").
- [ ] 1.2 **[USER]** Install flyctl: `brew install flyctl` (macOS) or
      `curl -L https://fly.io/install.sh | sh` (Linux).
- [ ] 1.3 **[USER]** Authenticate: `fly auth login`.
- [ ] 1.4 **[ANY OPERATOR]** `git pull` merged `main`; confirm `deploy/fly.toml`
      and `deploy/Dockerfile.server` are present.

## 2. App create (no deploy yet)

- [ ] 2.1 **[ANY OPERATOR]** Decide the real app name — the committed
      `app = "imperium-game"` in `deploy/fly.toml` is a placeholder and app
      names are globally unique.
- [ ] 2.2 **[ANY OPERATOR]** `fly launch --no-deploy -c deploy/fly.toml` —
      pick app name + org at the prompts. If your flyctl version writes a
      fresh `./fly.toml` instead of honoring `-c`, use
      `fly apps create <your-app-name>` and keep the committed config
      authoritative.
- [ ] 2.3 **[ANY OPERATOR]** Set `app = "<your-app-name>"` in `deploy/fly.toml`
      and commit it.
- [ ] 2.4 **[ANY OPERATOR]** Confirm region: `primary_region = "fra"`
      (Frankfurt) is committed; switch to `"iad"` (Ashburn) for a US-centered
      player base. Pick ONE — rooms are in-memory on a single machine, so this
      sets latency for every player in a match.

## 3. Secrets / env

Already baked into `deploy/fly.toml` `[env]` — do **not** re-set as secrets:
`PORT=8080`, `NODE_ENV=production`, `ROOM_TTL_SECONDS=3600`, `LOG_LEVEL=info`.

- [ ] 3.1 **[ANY OPERATOR]** Set `CORS_ORIGIN` to the real app URL (it is
      deliberately not in `[env]`):

      ```sh
      fly secrets set -c deploy/fly.toml CORS_ORIGIN="https://<your-app-name>.fly.dev"
      ```

      If the client is hosted on another origin, comma-separate all of them:

      ```sh
      fly secrets set -c deploy/fly.toml \
        CORS_ORIGIN="https://<your-app-name>.fly.dev,https://imperium.example.com"
      ```

- [ ] 3.2 **[ANY OPERATOR]** Only if you need to override the baked-in
      defaults (normally you don't):

      ```sh
      fly secrets set -c deploy/fly.toml ROOM_TTL_SECONDS=3600 LOG_LEVEL=info
      ```

      Secrets override `[env]` values of the same name, so these rotate
      without a config commit.

## 4. Volumes

- [ ] 4.1 **[ANY OPERATOR]** None — do not create any. The server is stateless
      by design: all room state is in-memory, so a restart drops in-flight
      games and there is nothing worth persisting to disk.

## 5. Deploy

- [ ] 5.1 **[ANY OPERATOR]** From the repo root (build context must be the
      repo root so the Dockerfile can see `server/`, `shared/`, and the root
      `package.json`):

      ```sh
      fly deploy -c deploy/fly.toml --dockerfile deploy/Dockerfile.server
      ```

- [ ] 5.2 **[ANY OPERATOR]** Expected duration: first deploy ~5–10 min (cold image layers on the
      remote builder); subsequent deploys ~1–3 min from cache.
- [ ] 5.3 **[ANY OPERATOR]** Healthy output looks like: build pushes the image, one machine
      updates, the `[checks.healthz]` check (GET `/healthz` every 15s, 10s
      grace) flips to **passing** — flyctl prints something like
      `Machine <id> update finished: success` / `1 passing` and exits 0. A
      deploy stuck on a failing health check means the server never answered
      `/healthz` on port 8080 — check `fly logs -c deploy/fly.toml`.

## 6. Custom domain + certs (optional)

- [ ] 6.1 **[USER]** `fly certs add imperium.example.com -c deploy/fly.toml`
- [ ] 6.2 **[USER]** `fly certs show imperium.example.com -c deploy/fly.toml`
      → create the shown `A`/`AAAA` records (or `CNAME` to
      `<your-app-name>.fly.dev`) at your DNS provider. Let's Encrypt issues
      automatically once DNS resolves (minutes to ~1 hour).
- [ ] 6.3 **[USER]** Add the new origin to `CORS_ORIGIN` (comma-separated) via
      `fly secrets set` — see 3.1. `force_https = true` in the config already
      redirects plain HTTP.

## 7. Post-deploy smoke (mirror the staging checks)

These mirror the staging rehearsal recorded in `deploy/STAGING_REPORT.md` —
use it as the reference for expected shapes and behavior.

- [ ] 7.1 **[ANY OPERATOR]** Health:

      ```sh
      curl -fsS https://<your-app-name>.fly.dev/healthz
      # expect: {"status":"ok","rooms":<int>,"uptime":<seconds>}
      ```

- [ ] 7.2 **[ANY OPERATOR]** Open the game URL in two separate browsers (or
      one normal + one private window), create a room in the first, join from
      the second with the 6-char room code, and play a turn.
- [ ] 7.3 **[ANY OPERATOR]** In devtools → Network → WS: confirm a socket.io
      connection on `/socket.io/` upgraded to WebSocket (101) on the same
      origin, with heartbeat frames flowing (~every 25s).
- [ ] 7.4 **[ANY OPERATOR]** `fly logs -c deploy/fly.toml` — single-line JSON
      (`{ts, level, roomCode?, event, msg}`), no error-level spam.

## 8. Rollback

- [ ] 8.1 **[ANY OPERATOR]** Bad release (crash loop, failing health check,
      broken gameplay): find the last good image and redeploy it:

      ```sh
      fly releases list -c deploy/fly.toml
      fly deploy -c deploy/fly.toml --image <previous-image-ref>
      ```

- [ ] 8.2 **[ANY OPERATOR]** Prefer `fly apps restart <your-app-name>` instead
      when the *code* is fine but the process is wedged (memory bloat, stuck
      event loop) — it's faster and skips a build. Either way, a
      restart/redeploy **drops all in-memory rooms**: players lose in-flight
      games, so if matches are live, wait for the SIGTERM drain
      (`kill_timeout = "30s"`, `server_shutdown` broadcast) to do its job
      rather than force-killing.

## Known deltas between the staging rehearsal and Fly

- **Client serving architecture differs.** The staging/local-compose stack
  runs **two** containers: an unprivileged nginx (`deploy/Dockerfile.client` +
  `deploy/nginx.conf`) serving the SPA and reverse-proxying `/socket.io/` +
  `/healthz` to the server, same-origin. The Fly deploy above is the README's
  **single-app** decision (step 8, primary path): one machine built from
  `deploy/Dockerfile.server` only — no nginx layer, no proxy hop.
- **Consequence today:** `deploy/Dockerfile.server` contains no client build
  stage and the server does not (yet) serve `client/dist` statically, so the
  Fly URL serves the API, socket, and `/healthz` — **not the game UI** —
  until the README step 8 follow-up (Express `express.static(client/dist)` +
  SPA fallback + Dockerfile client stage) lands. Until then, host the built
  client elsewhere and add its origin to `CORS_ORIGIN` (see 3.1).
- Minor: staging used compose's `stop_grace_period: 25s`; Fly uses
  `kill_timeout = "30s"`. Both satisfy the ≥20s SIGTERM drain contract.
- See `deploy/STAGING_REPORT.md` for exactly what the rehearsal did and did
  not cover in this environment.
