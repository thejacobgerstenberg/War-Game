/**
 * Verification pass for the faction-floor hunt: re-runs the flagged /
 * borderline grid cells at 1000 games each with FRESH per-game seeds
 * (fork ids 5000+, disjoint from the 1..80 grid forks), so the confirmation
 * is out-of-sample relative to the discovery run.
 *
 *   cd sim && npx tsx src/adversarial/run_faction_floor_verify.ts
 *
 * Merges a "verification" section into
 * sim/results/adversarial_faction_floor.json.
 */

import { readFileSync } from 'node:fs';
import type { FactionId } from '../types';
import type { PolicyName } from '../game';
import { isSmoke, pct, table, writeResults } from '../util';
import { runConfig, type ConfigResult, type FieldKind } from './faction_floor';

const BASE_SEED = process.env.SEED ? Number.parseInt(process.env.SEED, 10) : 111006;
const N = process.env.GAMES ? Number.parseInt(process.env.GAMES, 10) : isSmoke() ? 30 : 1000;

interface Cell {
  faction: FactionId;
  policy: PolicyName;
  field: FieldKind;
  why: 'ceiling' | 'floor';
}

const CELLS: Cell[] = [
  // ceiling candidates (auto-pick suspects)
  { faction: 'genoa', policy: 'trader', field: 'mixed', why: 'ceiling' },
  { faction: 'venice', policy: 'trader', field: 'mixed', why: 'ceiling' },
  { faction: 'venice', policy: 'trader', field: 'allTrader', why: 'ceiling' },
  { faction: 'byzantium', policy: 'rusher', field: 'allRusher', why: 'ceiling' },
  { faction: 'byzantium', policy: 'rusher', field: 'allOpportunist', why: 'ceiling' },
  { faction: 'byzantium', policy: 'rusher', field: 'mixed', why: 'ceiling' },
  // floor candidates (dead-on-arrival suspects in plausible configs)
  { faction: 'byzantium', policy: 'turtler', field: 'allRusher', why: 'floor' },
  { faction: 'byzantium', policy: 'turtler', field: 'mixed', why: 'floor' },
  { faction: 'ottomans', policy: 'trader', field: 'mixed', why: 'floor' },
  { faction: 'ottomans', policy: 'turtler', field: 'mixed', why: 'floor' },
  { faction: 'venice', policy: 'opportunist', field: 'mixed', why: 'floor' },
  { faction: 'genoa', policy: 'opportunist', field: 'mixed', why: 'floor' },
  { faction: 'hungary', policy: 'trader', field: 'allTrader', why: 'floor' },
  { faction: 'genoa', policy: 'rusher', field: 'allRusher', why: 'floor' },
];

const t0 = performance.now();
const out: Array<ConfigResult & { why: string }> = [];
CELLS.forEach((c, i) => {
  out.push({ ...runConfig(c.faction, c.policy, c.field, N, BASE_SEED, 5000 + i), why: c.why });
});
const elapsedMs = performance.now() - t0;

// merge into the existing results file
const path = new URL('../../results/adversarial_faction_floor.json', import.meta.url);
let existing: Record<string, unknown> = {};
try {
  existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
} catch {
  /* discovery run missing: write verification alone */
}
existing.verification = {
  gamesPerCell: N,
  baseSeed: BASE_SEED,
  forkIds: `5000..${5000 + CELLS.length - 1}`,
  elapsedMs: Math.round(elapsedMs),
  cells: out,
};
const outPath = writeResults('adversarial_faction_floor', existing);

console.log(`faction-floor verification — ${CELLS.length} cells x ${N} games, base seed ${BASE_SEED}, ${(elapsedMs / 1000).toFixed(1)}s`);
console.log(
  table(
    ['cell', 'why', 'winRate', 'wins/games', 'elim', 'winTypes t/c/sd', 'median'],
    out.map((r) => [
      `${r.focalFaction}+${r.focalPolicy} vs ${r.field}`,
      r.why,
      pct(r.focalWinRate),
      `${r.focalWins}/${r.games}`,
      pct(r.focalElimRate, 1),
      `${r.focalWinTypes.threshold}/${r.focalWinTypes.cap}/${r.focalWinTypes.suddenDeath}`,
      r.medianRounds,
    ]),
  ),
);
console.log(`\nResults merged into ${outPath}`);
