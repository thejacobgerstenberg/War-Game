/**
 * Pacing / victory-threshold sweep (npm run sim:pacing).
 *
 * Simulates 5-player games of stochastic prestige accrual (one player per
 * archetype + one random duplicate), summarizes per-archetype accrual
 * curves, sweeps the victory threshold over 15-60, and recommends the
 * threshold whose pacing hits the design targets:
 *   - median game-ending round in 12-16,
 *   - <10% of games end before round 11,
 *   - 40-70% of games decided by threshold (rest by round-16 highest).
 *
 * Writes sim/results/pacing.json. SMOKE=1 cuts games 10000 -> 500.
 */

import { create } from '../rng';
import { CONFIG } from '../rules';
import {
  ARCHETYPE_NAMES,
  ARCHETYPES,
  evaluateThreshold,
  recommend,
  simulateGame,
  summarizeCurves,
  type AccrualCurve,
  type ArchetypeName,
  type GameTrajectories,
  type SweepRow,
} from '../pacing';
import { bar, fmt, isSmoke, pct, table, writeResults } from '../util';

const SEED = 14530529;
const N_GAMES = isSmoke() ? 500 : 10000; // 5 players/game => >=N_GAMES trajectories per archetype
const THRESHOLD_MIN = 15;
const THRESHOLD_MAX = 85; // extended: conquest one-offs push leader curves into the 70s
const ROUNDS = CONFIG.game.maxRounds;

const t0 = Date.now();

// ------------------------------------------------------------ simulate games

const root = create(SEED);
const games: GameTrajectories[] = [];
// per archetype, per round: collected cumulative-prestige samples
const samples: Record<ArchetypeName, number[][]> = {
  rusher: [],
  trader: [],
  turtler: [],
  opportunist: [],
};
for (const a of ARCHETYPE_NAMES) {
  samples[a] = Array.from({ length: ROUNDS }, () => []);
}

for (let g = 0; g < N_GAMES; g++) {
  const game = simulateGame(CONFIG, root.fork(g));
  games.push(game);
  for (let i = 0; i < game.archetypes.length; i++) {
    const perRound = samples[game.archetypes[i]];
    for (let r = 0; r < ROUNDS; r++) perRound[r].push(game.trajectories[i][r]);
  }
}

const curves: AccrualCurve[] = ARCHETYPE_NAMES.map((a) => summarizeCurves(a, samples[a]));

// -------------------------------------------------------------- sweep + pick

const sweep: SweepRow[] = [];
for (let t = THRESHOLD_MIN; t <= THRESHOLD_MAX; t++) {
  sweep.push(evaluateThreshold(games, t));
}
const recommendation = recommend(sweep);

// ------------------------------------------------------------------- report

const elapsedMs = Date.now() - t0;

console.log(
  `PACING / PRESTIGE THRESHOLD MODEL  seed=${SEED}  games=${N_GAMES}` +
    `  (5 players/game)${isSmoke() ? ' (SMOKE)' : ''}`,
);
console.log(
  `prestige config: keyCity ${CONFIG.prestige.keyCityPerRound}/rnd ` +
    `(+${CONFIG.prestige.constantinopleExtraPerRound} Cple), route ` +
    `${CONFIG.prestige.tradeRoutePerRound}/rnd, greatWork ${CONFIG.prestige.greatWork}, ` +
    `warWon ${CONFIG.prestige.warWon}, objective ${CONFIG.prestige.secretObjective}, ` +
    `current victoryThreshold ${CONFIG.prestige.victoryThreshold}`,
);
console.log();

// --- accrual curves: ASCII chart (mean cumulative prestige by round) ---
const chartMax = Math.max(...curves.map((c) => c.mean[ROUNDS - 1]));
console.log('MEAN CUMULATIVE PRESTIGE BY ROUND');
for (const c of curves) {
  console.log(`  ${c.archetype} (n=${c.samples})`);
  for (let r = 0; r < ROUNDS; r++) {
    console.log(
      `    r${String(r + 1).padStart(2)} |${bar(c.mean[r], chartMax, 40)}| ` +
        `${fmt(c.mean[r], 1).padStart(5)}  (p10 ${fmt(c.p10[r], 0)} / p50 ${fmt(
          c.p50[r],
          0,
        )} / p90 ${fmt(c.p90[r], 0)})`,
    );
  }
  console.log();
}

console.log('MEAN CUMULATIVE PRESTIGE (table)');
console.log(
  table(
    ['round', ...ARCHETYPE_NAMES],
    Array.from({ length: ROUNDS }, (_, r) => [
      String(r + 1),
      ...curves.map((c) => fmt(c.mean[r], 1)),
    ]),
  ),
);
console.log();

// --- threshold sweep table (every 5, plus the recommended value) ---
const printThresholds = new Set<number>();
for (let t = THRESHOLD_MIN; t <= THRESHOLD_MAX; t += 5) printThresholds.add(t);
printThresholds.add(recommendation.threshold);
const printRows = sweep.filter((r) => printThresholds.has(r.threshold));

console.log('THRESHOLD SWEEP');
console.log(
  table(
    [
      'threshold',
      'medianEnd',
      'meanEnd',
      'end<r11',
      'byThreshold',
      'byR16cap',
      'P(r8 leader wins)',
    ],
    printRows.map((r) => [
      r.threshold === recommendation.threshold ? `${r.threshold} <==` : String(r.threshold),
      r.medianEndRound,
      fmt(r.meanEndRound, 1),
      pct(r.shareEndedBeforeRound11),
      pct(r.shareDecidedByThreshold),
      pct(r.shareDecidedByCap),
      pct(r.pRound8LeaderWins),
    ]),
  ),
);
console.log();

console.log(
  `RECOMMENDATION: victoryThreshold = ${recommendation.threshold}` +
    `${recommendation.meetsAllCriteria ? '' : '  (criteria NOT fully met)'}`,
);
console.log(`  ${recommendation.reasoning}`);
console.log();

// end-round distribution at the recommended threshold
const rec = recommendation.metrics;
console.log(`GAME-ENDING ROUND DISTRIBUTION AT THRESHOLD ${rec.threshold}`);
const maxCount = Math.max(...rec.endRoundCounts);
for (let r = 0; r < ROUNDS; r++) {
  console.log(
    `  r${String(r + 1).padStart(2)} |${bar(rec.endRoundCounts[r], maxCount, 40)}| ` +
      pct(rec.endRoundCounts[r] / N_GAMES),
  );
}
console.log();

// ------------------------------------------------------------------ results

const path = writeResults('pacing', {
  meta: {
    seed: SEED,
    games: N_GAMES,
    playersPerGame: 5,
    rounds: ROUNDS,
    smoke: isSmoke(),
    elapsedMs,
    thresholdRange: [THRESHOLD_MIN, THRESHOLD_MAX],
    prestigeConfig: CONFIG.prestige,
    eventPrestigeMagnitude: CONFIG.events.prestigeMagnitude,
    model:
      '5-player games (each archetype once + one random duplicate); stochastic ' +
      'accrual from key cities, Constantinople extra, trade routes (raidable), ' +
      'great works (jittered schedule), wars won, secret objectives (mid/late ' +
      'hazard window), prestige event cards; threshold win = first player ' +
      'crossing, else highest prestige at the round-16 cap.',
  },
  archetypes: ARCHETYPES,
  accrualCurves: curves,
  sweep,
  recommendation,
});
console.log(`wrote ${path}  (${fmt(elapsedMs / 1000, 1)}s)`);
