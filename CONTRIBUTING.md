# Contributing to IMPERIUM: Twilight of Empires

A browser-based, real-time multiplayer strategy game of rival empires clashing at the close of an age. Thanks for helping build it — this guide covers how we organize work, run the game, and what CI expects from each part of the project.

## Branch-per-workstream model

We develop in parallel across independent workstreams, each living on its own long-lived branch. Every branch is cut from `main`, and each workstream stays inside the directories it owns. Open your PRs as **drafts** while work is in progress and keep changes scoped to your workstream so branches merge cleanly.

| Branch | Owns | What it is |
| --- | --- | --- |
| `feature/design-and-scaffold` | `server/`, `client/`, `shared/` | The TypeScript monorepo: `server/` (Node + socket.io game server), `client/` (React + Vite frontend), `shared/` (types shared across both). Server tests run on vitest. |
| `feature/visual-assets` | `art/` | Game art as SVGs. |
| `feature/balance-sim` | `sim/` | TypeScript balance simulations for tuning game math. |
| `feature/audio-assets` | `audio/` | Audio files plus `audio/CREDITS.md`. |
| `feature/narrative` | `lore/` | World and story lore as markdown. |
| `feature/ci` | `.github/` | CI workflows and repo configuration (this workstream). |

A few ground rules:

- Branch from `main` and rebase on it periodically.
- Open **draft** PRs early so others can see what's coming.
- Touch only your workstream's directories — this keeps merges painless and reviews focused.

## Running the game locally

> **Forthcoming.** Once `feature/design-and-scaffold` merges, the root `README` becomes the source of truth for setup and running — defer to it.

The intended flow, once the scaffold lands, is:

```sh
nvm use          # respects .nvmrc (Node 20 LTS)
npm install      # installs all workspaces from the root (npm workspaces)
npm run dev      # runs the server and client together
```

Until the scaffold merges, treat the above as the target rather than a working recipe.

## CI & quality gates

CI is designed so partial scaffolds still pass — jobs use guards and `--if-present` so a workstream that hasn't landed its scripts yet won't turn the build red. Here's what runs and what each job expects:

- **detect** — Feature detection. Inspects the repo to decide which downstream jobs have work to do, so empty or not-yet-scaffolded areas are skipped rather than failed.
- **code** — Runs `npm ci`, then `typecheck`, `lint`, `build`, and `vitest`, each via `--if-present`. Partial scaffolds pass because missing scripts are simply skipped.
- **sim** — Installs `sim/` dependencies and runs `sim:smoke` as a fast smoke run to catch obvious breakage without waiting on a full suite.
- **assets** — Validates media:
  - SVGs: `xmllint` confirms every SVG parses and that ids are unique within each file.
  - Audio: `ffprobe` validates each file, enforces the size budget (5 MB for music, 200 KB for sfx), and checks that `audio/CREDITS.md` lists every audio file.
- **docs** — Internal markdown link check across `docs/` and `lore/` (relative links must resolve).

There's also a scheduled **balance-regression** workflow (manual `workflow_dispatch` plus a weekly cron) that runs the full sim suite and uploads a balance report as a build artifact.

### What CI expects from each workstream

- **Monorepo (`feature/design-and-scaffold`)** — Expose `typecheck`, `lint`, `build`, and `test` npm scripts (they run via `--if-present`, so add them as they become real).
- **Sim (`feature/balance-sim`)** — Provide a fast `sim:smoke` script for PR CI, and ideally `sim:full` / `sim:report` for the scheduled balance job.
- **Audio (`feature/audio-assets`)** — Keep `audio/CREDITS.md` current (every audio file must be listed) and respect the size budgets (5 MB music / 200 KB sfx).
- **Art (`feature/visual-assets`)** — Ship well-formed SVGs with ids that are unique within each file.
- **Docs & lore (`feature/narrative` and docs authors)** — Use relative internal links so the docs link check passes.

## Welcome aboard

Keep PRs small, describe the before/after in plain language, and don't hesitate to open a draft to get early eyes on your work. Happy building.
