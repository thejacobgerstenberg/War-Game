# IMPERIUM: Twilight of Empires

A browser strategy game set in the late Roman/Byzantine world (~1400–1453).
Byzantium, the Ottomans, Venice, Genoa and Hungary contend for the ruins of
empire across the Aegean and the Balkans.

This repository is a TypeScript **npm-workspaces monorepo**:

| Workspace            | Package             | Role                                             |
| -------------------- | ------------------- | ------------------------------------------------ |
| `shared/`            | `@imperium/shared`  | Game-state types + the Socket.IO wire protocol.  |
| `server/`            | `@imperium/server`  | Express + Socket.IO server, lobby, game engine.  |
| `client/`            | `@imperium/client`  | React + Vite client (screens + themed map stub). |

## Prerequisites

- **Node.js ≥ 20** (developed on Node 22)
- **npm ≥ 10** (workspaces)

## Install

```bash
npm install
```

A single install at the repo root wires up all three workspaces.

## Develop

```bash
npm run dev
```

This builds `@imperium/shared`, then starts:

- the **server** on <http://localhost:4000> (override with `PORT`), and
- the **client** on <http://localhost:5173> (Vite).

The client talks to the server via `VITE_SERVER_URL` (default
`http://localhost:4000`).

## Test

```bash
npm test          # runs the server's vitest suite (engine + lobby)
npm run typecheck # type-checks every workspace
```

There is also an end-to-end socket smoke test that boots the server and drives a
full lobby flow with two clients:

```bash
cd server && node --import tsx scripts/smoke.mjs
```

## Build

```bash
npm run build     # builds shared, server (tsc), and client (vite)
```

## Architecture

- `shared/` is the single source of truth for game types and the socket
  protocol; both server and client import it so the contract can never drift.
- `server/src/engine/` is a **pure, tested** module: map data, adjacency, income
  and initial-state construction, with no transport dependencies.
- `server/src/lobby/` manages rooms in memory and is likewise transport
  agnostic; `server/src/index.ts` is the only place that touches Socket.IO.
- `client/src/` is a small screen-router React app (Home → Create/Join →
  Faction Pick → Lobby → Game Board) built on the theme tokens in `theme.css`.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the fuller design, and
`docs/MAP.md` for the canonical map (the engine currently ships a representative
sample of it).
