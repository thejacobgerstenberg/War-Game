# IMPERIUM balance sim

Standalone Monte-Carlo balance harness for **IMPERIUM: Twilight of Empires**.
It implements the FINAL canon rules (docs at commit `2b42386` on
`feature/design-and-scaffold`: `GAME_DESIGN.md`, `FACTIONS.md`, `MAP.md`,
`EVENT_CARDS.md`) as a fast, fully deterministic simulation, and uses it to
tune every balance number the engine will ship.

**Start here:**

- **[TUNING_REPORT.md](./TUNING_REPORT.md)** — the deliverable: recommended
  values for every tunable (with proposed `server/src/engine/balance.ts` key
  names), the evidence behind each, the adversarial audit, and the
  NEEDS-RULES-CHANGE register.
- **[RULES_MODEL.md](./RULES_MODEL.md)** — every mechanic as the sim
  implements it, with canon § references, deliberate simplifications,
  gap-fills, and guardrails. Diff this against the real rules.
- **[TUNING_LOG.md](./TUNING_LOG.md)** — append-only history of every tuning
  iteration (old-kernel rounds, canon re-derivation, retune rounds, the
  adversarial fix round) with before/after metrics.

No game code outside `sim/` is touched or imported; the only dependencies are
`tsx` and `typescript`.

## Layout

```
sim/
├── src/
│   ├── rules.ts        CONFIG — every tunable number (source of truth)
│   ├── map.ts          56 provinces, 12 sea zones, trade routes, faction starts
│   ├── types.ts        shared types
│   ├── rng.ts          seeded, forkable RNG (all randomness flows through it)
│   ├── combat.ts       canon §7 per-unit d6 kernel (walls, cards, rout)
│   ├── siege.ts        canon §8 siege engine (stores, sea resupply, Bombard)
│   ├── economy.ts      income/upkeep projections
│   ├── game.ts         full-game loop (omens, actions, battles, prestige, victory)
│   ├── agents.ts       scripted policies: rusher / trader / turtler / opportunist
│   ├── run/            the five sim entrypoints + smoke + report
│   └── adversarial/    six exploit hunters + fix-check probes
├── results/            committed JSON outputs of full-scale runs
├── RULES_MODEL.md      mechanics as modeled (canon diff)
├── TUNING_LOG.md       tuning history
└── TUNING_REPORT.md    recommended numbers + evidence (the deliverable)
```

## Running

```bash
cd sim
npm install
```

| Command | What it does | Full-scale runtime |
|---|---|---|
| `npm run sim:smoke` | `SMOKE=1` pass of all five sims — small sizes, asserts the canon §7.4 worked-example kernel checks; use in CI | seconds |
| `npm run sim:full` | all five sims at full scale (alias of `sim:all`) | ~3 min total |
| `npm run sim:combat` | combat Monte-Carlo: 12×12 attacker/defender grids × modifier sets, 100k trials/cell | ~2 min |
| `npm run sim:siege` | siege module: wall tiers × garrisons × engines + the Constantinople scenarios (Bombard/blockade), 20k iters/cell | ~13 s |
| `npm run sim:economy` | per-faction × archetype solvency/strike projections + price sweep | ~1 s |
| `npm run sim:pacing` | prestige-accrual trajectory model + victory-threshold sweep | ~1 s |
| `npm run sim:fullgame` | full 5-player games, all factions × shuffled policies | ~10 s / 3,000 games |
| `npm run sim:report` | read-only headline summary of whatever is in `results/` — never simulates | instant |

Each sim writes `results/<name>.json` and prints a human-readable summary.
The adversarial hunters are run directly
(`npx tsx src/adversarial/run_<hunt>.ts`) and write
`results/adversarial_<hunt>.json`.

### SMOKE / GAMES / SEED

- `SMOKE=1` — tiny sizes for every module (what `sim:smoke` sets).
- `GAMES=<n> SEED=<n>` — fullgame only: override game count and base seed for
  independent verification. Defaults: 1,000 games, seed 14530000
  (40 games under SMOKE).

Everything is deterministic in (GAMES, SEED): game *i* seeds from
`SEED + i`, policy assignment is a seeded shuffle, and no wall-clock entropy
enters the sim. Re-running with the same parameters reproduces the committed
JSONs bit-identically.

### Regenerating the report numbers

The committed `results/` were produced at the shipped CONFIG by:

```bash
npm run sim:combat && npm run sim:siege && npm run sim:economy && npm run sim:pacing
GAMES=3000 SEED=24681357 npm run sim:fullgame      # committed results/fullgame.json
GAMES=5000 SEED=987654321 npm run sim:fullgame     # the independent 5,000-game verify quoted in TUNING_REPORT §1
npx tsx src/adversarial/run_cple_beeline.ts        # and the other five run_*.ts hunters
npm run sim:report
```

(Note the last `sim:fullgame` you run overwrites `results/fullgame.json` —
the committed file is the 3,000-game fresh-seed final run.)

## Balance targets (all green — see TUNING_REPORT §1)

- **T1** every faction wins 12–30% of 5-player games
- **T2** every policy wins 10–40% of seats
- **T3** median game ends rounds 12–16, <10% before round 11, 40–70%
  threshold-decided
- **T4** sudden death (Fall of Constantinople) decides 1–15% of games, never
  before round 10
- **T5** Constantinople capture curves: intact-assault <2%, un-blockaded
  un-Bombarded capture <10% in 12 rounds, blockade starve-out median ≥6
  rounds, with-Bombard capture ≤4 rounds >50%
- **T6** every faction × archetype stays solvent through round 16 and can
  field a credible strike force by rounds 4–5
