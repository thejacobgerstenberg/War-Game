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
import { runConfig, runExtreme, type ConfigResult, type FieldKind } from './faction_floor';

const BASE_SEED = process.env.SEED ? Number.parseInt(process.env.SEED, 10) : 311006;
const N = process.env.GAMES ? Number.parseInt(process.env.GAMES, 10) : isSmoke() ? 30 : 1000;

interface Cell {
  faction: FactionId;
  policy: PolicyName;
  field: FieldKind;
  why: 'ceiling' | 'floor';
}

// Flagged / borderline cells from the seed-311006 discovery run (final canon config).
const CELLS: Cell[] = [
  // ceiling candidates (auto-pick suspects)
  { faction: 'genoa', policy: 'trader', field: 'mixed', why: 'ceiling' }, // 58.3% discovery
  { faction: 'genoa', policy: 'trader', field: 'allRusher', why: 'ceiling' }, // 56.0%
  { faction: 'hungary', policy: 'opportunist', field: 'mixed', why: 'ceiling' }, // 49.3% borderline
  { faction: 'hungary', policy: 'opportunist', field: 'allOpportunist', why: 'ceiling' }, // 59.3%
  { faction: 'hungary', policy: 'opportunist', field: 'allRusher', why: 'ceiling' }, // 54.7% borderline
  // floor candidates (dead-on-arrival suspects in plausible configs)
  { faction: 'ottomans', policy: 'trader', field: 'mixed', why: 'floor' }, // 1.7%
  { faction: 'ottomans', policy: 'turtler', field: 'mixed', why: 'floor' }, // 0.0%
  { faction: 'venice', policy: 'rusher', field: 'mixed', why: 'floor' }, // 0.7%
  { faction: 'venice', policy: 'opportunist', field: 'mixed', why: 'floor' }, // 0.0%
  { faction: 'genoa', policy: 'rusher', field: 'mixed', why: 'floor' }, // 1.7%
  { faction: 'genoa', policy: 'opportunist', field: 'mixed', why: 'floor' }, // 0.0%
  { faction: 'hungary', policy: 'trader', field: 'allTrader', why: 'floor' }, // 1.3% (named worst config)
  { faction: 'byzantium', policy: 'turtler', field: 'allTrader', why: 'floor' }, // 3.7%
];

const t0 = performance.now();
const out: Array<ConfigResult & { why: string }> = [];
CELLS.forEach((c, i) => {
  out.push({ ...runConfig(c.faction, c.policy, c.field, N, BASE_SEED, 5000 + i), why: c.why });
});
// out-of-sample recheck of the all-5-turtler ending flag (fork 6000, disjoint
// from the discovery extremes at forks 1000+).
const turtlerExtreme = runExtreme('turtler', N, BASE_SEED, 6000);
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
  forkIds: `5000..${5000 + CELLS.length - 1} (+6000 extreme)`,
  elapsedMs: Math.round(elapsedMs),
  cells: out,
  turtlerExtreme,
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
console.log(
  `\nall-5-turtler recheck (fork 6000, ${turtlerExtreme.games} games): median ${turtlerExtreme.medianRounds}, ` +
    `cap ${pct(turtlerExtreme.victoryRates.cap)}, capMargin<2 ${pct(turtlerExtreme.capCloseMarginRate)}`,
);
console.log(`\nResults merged into ${outPath}`);
