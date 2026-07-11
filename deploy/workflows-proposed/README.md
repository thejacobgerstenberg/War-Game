# Proposed workflows (deploy workstream)

`build-images.yml` builds the production Docker images (`deploy/Dockerfile.server`,
`deploy/Dockerfile.client`) on every push to `main` (ignoring `audio/`, `art/`, `docs/`)
and on manual dispatch, pushing `ghcr.io/<owner>/<repo>/{server,client}:{latest,<sha>}`
to GHCR with the built-in `GITHUB_TOKEN` and GHA layer caching. It is build-only:
nothing auto-deploys — Fly deploys stay manual per the runbook in `deploy/README.md`.

Workflows here are inert: GitHub only runs files under `.github/workflows/`, which the
CI workstream owns. To adopt: `git mv deploy/workflows-proposed/build-images.yml
.github/workflows/` (reconciliation notes are in the file's header comment).
Having images in GHCR lets Fly later deploy pinned digests
(`fly deploy --image ghcr.io/...@sha256:...`) instead of rebuilding at deploy time.
