/**
 * Monte-Carlo siege sweep (npm run sim:siege).
 *
 * Grid: wall tier 1-3 x garrison size 2-12 x siege engines 0-6, a fixed
 * strong attacker stack of 12 professionals. Per cell: capture probability,
 * expected rounds-to-capture, capture-reason split, mean attacker losses.
 *
 * Plus the Constantinople scenario: Theodosian walls (tier 3 + theodosian
 * bonus, 16 wall hitpoints), garrison 6-10 professionals, attacker 12
 * professionals + 2 siege engines, with and without the Great Bombard:
 * P(capture within k siege rounds) for k = 1..8.
 *
 * Writes sim/results/siege.json. SMOKE=1 cuts iterations 20000 -> 500.
 */

import { create } from '../rng';
import { CONFIG } from '../rules';
import { armyOf } from '../combat';
import {
  DEFAULT_SIEGE_POLICY,
  runSiege,
  wallHitpoints,
  type SiegeOutcome,
  type SiegeSetup,
} from '../siege';
import { fmt, isSmoke, pct, table, writeResults } from '../util';

const SEED = 20260711;
const ITERS = isSmoke() ? 500 : 20000;

const ATTACKER_PROFESSIONALS = 12;
const TIERS = [1, 2, 3] as const;
const GARRISONS = [2, 4, 6, 8, 10, 12] as const;
const ENGINES = [0, 1, 2, 3, 4, 5, 6] as const;
const CPLE_GARRISONS = [6, 8, 10] as const;
const CPLE_MAX_K = 8;

interface CellStats {
  tier: number;
  garrison: number;
  engines: number;
  iterations: number;
  captureProb: number;
  expectedRoundsToCapture: number | null; // mean siege rounds | captured
  capturedByAssault: number; // fraction of all sieges
  capturedByStarvation: number;
  abandoned: number;
  timeout: number;
  meanAttackerLosses: number;
}

function simulateCell(setup: SiegeSetup, iters: number, seed: number): {
  stats: Omit<CellStats, 'tier' | 'garrison' | 'engines'>;
  captureRounds: number[]; // histogram: captureRounds[r] = captures at round r+1
} {
  const rng = create(seed);
  let captures = 0;
  let roundsSum = 0;
  let byAssault = 0;
  let byStarvation = 0;
  let abandoned = 0;
  let timeout = 0;
  let attLossSum = 0;
  const captureRounds = new Array<number>(DEFAULT_SIEGE_POLICY.maxSiegeRounds).fill(0);

  for (let i = 0; i < iters; i++) {
    const out: SiegeOutcome = runSiege(setup, DEFAULT_SIEGE_POLICY, rng.fork(i));
    attLossSum += out.attackerLosses;
    if (out.captured) {
      captures++;
      roundsSum += out.rounds;
      captureRounds[out.rounds - 1]++;
      if (out.reason === 'assault') byAssault++;
      else byStarvation++;
    } else if (out.reason === 'abandoned') abandoned++;
    else timeout++;
  }

  return {
    stats: {
      iterations: iters,
      captureProb: captures / iters,
      expectedRoundsToCapture: captures > 0 ? roundsSum / captures : null,
      capturedByAssault: byAssault / iters,
      capturedByStarvation: byStarvation / iters,
      abandoned: abandoned / iters,
      timeout: timeout / iters,
      meanAttackerLosses: attLossSum / iters,
    },
    captureRounds,
  };
}

// ------------------------------------------------------------- grid sweep

const t0 = Date.now();
const grid: CellStats[] = [];
let cellSeed = SEED;

for (const tier of TIERS) {
  for (const garrison of GARRISONS) {
    for (const engines of ENGINES) {
      cellSeed++;
      const setup: SiegeSetup = {
        attacker: armyOf({ professional: ATTACKER_PROFESSIONALS, siegeEngine: engines }),
        defender: armyOf({ professional: garrison }),
        wallTier: tier,
        theodosian: false,
        terrain: 'plains',
        hasGreatBombard: false,
        blockaded: false,
      };
      const { stats } = simulateCell(setup, ITERS, cellSeed);
      grid.push({ tier, garrison, engines, ...stats });
    }
  }
}

// ----------------------------------------------- Constantinople scenarios

interface CpleCurve {
  garrison: number;
  greatBombard: boolean;
  iterations: number;
  captureProb: number;
  expectedRoundsToCapture: number | null;
  pCaptureWithinK: number[]; // index k-1 => P(capture within k siege rounds), k=1..8
}

const cple: CpleCurve[] = [];
for (const bombard of [false, true]) {
  for (const garrison of CPLE_GARRISONS) {
    cellSeed++;
    const setup: SiegeSetup = {
      attacker: armyOf({ professional: ATTACKER_PROFESSIONALS, siegeEngine: 2 }),
      defender: armyOf({ professional: garrison }),
      wallTier: 3,
      theodosian: true,
      terrain: 'plains', // Constantinople is a plains province
      hasGreatBombard: bombard,
      blockaded: false,
    };
    const { stats, captureRounds } = simulateCell(setup, ITERS, cellSeed);
    const withinK: number[] = [];
    let cum = 0;
    for (let k = 1; k <= CPLE_MAX_K; k++) {
      cum += captureRounds[k - 1];
      withinK.push(cum / ITERS);
    }
    cple.push({
      garrison,
      greatBombard: bombard,
      iterations: ITERS,
      captureProb: stats.captureProb,
      expectedRoundsToCapture: stats.expectedRoundsToCapture,
      pCaptureWithinK: withinK,
    });
  }
}

// ----------------------------------------------------------- target checks

const noBomb = cple.filter((c) => !c.greatBombard);
const withBomb = cple.filter((c) => c.greatBombard);
// Target 1: WITHOUT bombard, strong stack (12 prof + 2 engines) <10% within 3 rounds.
const worstNoBombWithin3 = Math.max(...noBomb.map((c) => c.pCaptureWithinK[2]));
const target1Met = worstNoBombWithin3 < 0.10;
// Target 2: WITH bombard, capture within 4 rounds (i.e. inside the 2-4 window) >50%.
const worstWithBombWithin4 = Math.min(...withBomb.map((c) => c.pCaptureWithinK[3]));
const target2Met = worstWithBombWithin4 > 0.50;

// ----------------------------------------------------------------- report

const elapsedMs = Date.now() - t0;

const REP_GARRISON = 6; // representative garrison for the printed tier x engines tables
const cell = (tier: number, engines: number) =>
  grid.find((c) => c.tier === tier && c.garrison === REP_GARRISON && c.engines === engines)!;

console.log(`SIEGE MONTE CARLO  seed=${SEED}  iters/cell=${ITERS}${isSmoke() ? ' (SMOKE)' : ''}`);
console.log(`attacker = ${ATTACKER_PROFESSIONALS} professionals (+engines), garrison = professionals, plains, no blockade`);
console.log(`policy: assault when wall bonus <= ${DEFAULT_SIEGE_POLICY.assaultWallThreshold} or garrison <= ${DEFAULT_SIEGE_POLICY.assaultGarrisonMax}; give up after ${DEFAULT_SIEGE_POLICY.maxSiegeRounds} rounds`);
console.log();

console.log(`EXPECTED ROUNDS TO CAPTURE (garrison=${REP_GARRISON}) — '-' = never captured`);
console.log(
  table(
    ['tier\\engines', ...ENGINES.map(String)],
    TIERS.map((t) => [
      `tier ${t}`,
      ...ENGINES.map((e) => {
        const c = cell(t, e);
        return c.expectedRoundsToCapture === null ? '-' : fmt(c.expectedRoundsToCapture, 1);
      }),
    ]),
  ),
);
console.log();

console.log(`CAPTURE PROBABILITY (garrison=${REP_GARRISON})`);
console.log(
  table(
    ['tier\\engines', ...ENGINES.map(String)],
    TIERS.map((t) => [`tier ${t}`, ...ENGINES.map((e) => pct(cell(t, e).captureProb))]),
  ),
);
console.log();

console.log(`CONSTANTINOPLE (Theodosian walls, ${wallHitpoints(3, true)} hp): P(capture within k siege rounds)`);
console.log(`attacker = ${ATTACKER_PROFESSIONALS} professionals + 2 siege engines`);
console.log(
  table(
    ['scenario', ...Array.from({ length: CPLE_MAX_K }, (_, i) => `k=${i + 1}`), 'E[rounds]'],
    cple.map((c) => [
      `${c.greatBombard ? 'BOMBARD' : 'no bomb'} g=${c.garrison}`,
      ...c.pCaptureWithinK.map((p) => pct(p)),
      c.expectedRoundsToCapture === null ? '-' : fmt(c.expectedRoundsToCapture, 1),
    ]),
  ),
);
console.log();

console.log('TARGETS');
console.log(`  without Bombard, P(capture <=3 rounds) < 10%: worst=${pct(worstNoBombWithin3)}  ${target1Met ? 'MET' : 'MISSED'}`);
console.log(`  with Bombard, P(capture <=4 rounds) > 50%:    worst=${pct(worstWithBombWithin4)}  ${target2Met ? 'MET' : 'MISSED'}`);
console.log();

const path = writeResults('siege', {
  meta: {
    seed: SEED,
    iterationsPerCell: ITERS,
    smoke: isSmoke(),
    elapsedMs,
    attacker: `${ATTACKER_PROFESSIONALS} professionals + <engines> siege engines`,
    garrisonComposition: 'professionals',
    terrain: 'plains',
    blockaded: false,
    policy: DEFAULT_SIEGE_POLICY,
    config: { walls: CONFIG.walls, siege: CONFIG.siege, combat: CONFIG.combat },
    note: 'Great Bombard scenarios assume game round >= siege.greatBombard.availableFromRound',
  },
  grid,
  constantinople: cple,
  targets: {
    noBombardWithin3Under10pct: { worst: worstNoBombWithin3, met: target1Met },
    withBombardWithin4Over50pct: { worst: worstWithBombWithin4, met: target2Met },
  },
});
console.log(`wrote ${path}  (${fmt(elapsedMs / 1000, 1)}s)`);
