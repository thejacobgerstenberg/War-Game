/**
 * Monte-Carlo siege sweep (npm run sim:siege) — FINAL canon rules (2b42386).
 *
 * 1. Grid: wall tier T1-T5 x garrison size 2-12 x siege engines 0-6, a fixed
 *    strong attacker stack of 12 professionals, LANDLOCKED city (starvation
 *    proceeds: 3 grain stores, then 1 unit/round). Per cell: capture
 *    probability, expected rounds-to-capture, capture-reason split, mean
 *    attacker losses. (T5 landlocked shows the canon §8.3 masonry cap:
 *    engines tick 1 HP/round; capture comes by starvation.)
 *
 * 2. Direct-assault sweep (T5a evidence): attacker stacks 1-12 professionals
 *    assault the INTACT T5 Theodosian Walls (defender +4, attacker escalade
 *    -1) — single battles, no siege. Target: win prob < 2% everywhere.
 *
 * 3. Constantinople scenarios (T5b-T5d): T5 Theodosian Walls (16 HP, +4),
 *    garrison 6-10 professionals, attacker 12 professionals + 4 mercenaries
 *    + 3 siege engines, all four combinations of Great Bombard x naval
 *    blockade. The city is COASTAL: unblockaded => sea-resupplied, no
 *    starvation (canon §8.2.3); vs intact T5 an ordinary train deals at most
 *    1 wall HP/round (canon §8.3) — only the Great Bombard (2 wall-damage
 *    dice, cap lifted for the train; canon §8.4) breaches them in time.
 *    P(capture within k siege rounds) for k = 1..12.
 *
 * Targets (T5):
 *   a) direct assault on intact Theodosian walls: < 2% for any stack 1-12
 *   b) no Bombard + NO blockade: capture within 12 siege rounds < 10%
 *   c) no Bombard + FULL blockade: starve-out works, median capture >= 6
 *   d) with Bombard: capture within 4 siege rounds (2-4 window) > 50%
 *
 * Writes sim/results/siege.json. SMOKE=1 cuts iterations 20000 -> 500.
 */

import { create } from '../rng';
import { CONFIG } from '../rules';
import { armyOf, effectiveWallBonus, modifiers, resolveBattle } from '../combat';
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
const TIERS = [1, 2, 3, 4, 5] as const;
const GARRISONS = [2, 4, 6, 8, 10, 12] as const;
const ENGINES = [0, 1, 2, 3, 4, 5, 6] as const;
const CPLE_GARRISONS = [6, 8, 10] as const;
const CPLE_MAX_K = DEFAULT_SIEGE_POLICY.maxSiegeRounds; // 12
// Grand assault army for the Constantinople scenarios: line infantry,
// free-company shock troops, and a full siege train.
const CPLE_ATTACKER = { professional: 12, mercenary: 4, siegeEngine: 3 } as const;

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

/** Median siege round of capture (among captures), from the histogram. */
function medianCaptureRound(captureRounds: number[]): number | null {
  const total = captureRounds.reduce((s, x) => s + x, 0);
  if (total === 0) return null;
  let cum = 0;
  for (let r = 0; r < captureRounds.length; r++) {
    cum += captureRounds[r];
    if (cum >= total / 2) return r + 1;
  }
  return captureRounds.length;
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
        wallTier: tier, // T5 row: canon §8.3 masonry cap applies
        theodosian: false,
        terrain: 'plains',
        hasGreatBombard: false,
        blockaded: false,
        coastal: false, // landlocked: fully invested, starvation proceeds
      };
      const { stats } = simulateCell(setup, ITERS, cellSeed);
      grid.push({ tier, garrison, engines, ...stats });
    }
  }
}

// ---------------------------------------- direct assault on intact walls (T5a)

interface AssaultRow {
  attackers: number;
  /** winProb[garrison index] per CPLE_GARRISONS */
  winProb: number[];
}

const theodosianWallBonus = effectiveWallBonus(5, true, 0); // T5 = Theodosian Walls (+4)
const assaultMods = modifiers({
  attackerBonus: -CONFIG.siege.escaladePenalty, // canon §8.2.4 escalade
  terrainBonus: CONFIG.combat.terrain.plains,
  wallBonus: theodosianWallBonus,
});
const directAssault: AssaultRow[] = [];
for (let a = 1; a <= 12; a++) {
  const row: AssaultRow = { attackers: a, winProb: [] };
  for (const garrison of CPLE_GARRISONS) {
    cellSeed++;
    const rng = create(cellSeed);
    let wins = 0;
    for (let i = 0; i < ITERS; i++) {
      const att = armyOf({ professional: a });
      const def = armyOf({ professional: garrison });
      if (resolveBattle(att, def, assaultMods, rng).winner === 'attacker') wins++;
    }
    row.winProb.push(wins / ITERS);
  }
  directAssault.push(row);
}
const worstDirectAssault = Math.max(...directAssault.flatMap((r) => r.winProb));

// ----------------------------------------------- Constantinople scenarios

interface CpleCurve {
  garrison: number;
  greatBombard: boolean;
  blockaded: boolean;
  iterations: number;
  captureProb: number;
  expectedRoundsToCapture: number | null;
  medianRoundsToCapture: number | null;
  capturedByAssault: number;
  capturedByStarvation: number;
  pCaptureWithinK: number[]; // index k-1 => P(capture within k siege rounds), k=1..12
}

const cple: CpleCurve[] = [];
for (const bombard of [false, true]) {
  for (const blockaded of [false, true]) {
    for (const garrison of CPLE_GARRISONS) {
      cellSeed++;
      const setup: SiegeSetup = {
        attacker: armyOf(CPLE_ATTACKER),
        defender: armyOf({ professional: garrison }),
        wallTier: 5, // T5 Theodosian Walls (16 HP, +4; canon §8.1/§8.3)
        theodosian: true,
        terrain: 'plains', // Constantinople is a plains province
        hasGreatBombard: bombard,
        blockaded,
        coastal: true, // the Golden Horn: unblockaded => sea-resupplied (canon §8.2.3)
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
        blockaded,
        iterations: ITERS,
        captureProb: stats.captureProb,
        expectedRoundsToCapture: stats.expectedRoundsToCapture,
        medianRoundsToCapture: medianCaptureRound(captureRounds),
        capturedByAssault: stats.capturedByAssault,
        capturedByStarvation: stats.capturedByStarvation,
        pCaptureWithinK: withinK,
      });
    }
  }
}

// ----------------------------------------------------------- target checks

const noBombNoBlock = cple.filter((c) => !c.greatBombard && !c.blockaded);
const noBombBlock = cple.filter((c) => !c.greatBombard && c.blockaded);
const withBombNoBlock = cple.filter((c) => c.greatBombard && !c.blockaded);

// T5a: direct assault on intact Theodosian walls < 2% for any stack 1-12.
const t5aMet = worstDirectAssault < 0.02;
// T5b: no Bombard + NO blockade: capture within 12 siege rounds < 10%.
const worstNoBombNoBlock12 = Math.max(...noBombNoBlock.map((c) => c.pCaptureWithinK[11]));
const t5bMet = worstNoBombNoBlock12 < 0.10;
// T5c: no Bombard + FULL blockade: starve-out works (capture prob within the
// 12-round policy horizon is substantial) AND median rounds-to-capture >= 6.
const minBlockCapture = Math.min(...noBombBlock.map((c) => c.captureProb));
const minBlockMedian = Math.min(...noBombBlock.map((c) => c.medianRoundsToCapture ?? Infinity));
const t5cMet = minBlockCapture > 0.5 && minBlockMedian >= 6;
// T5d: with Bombard (unblockaded): capture within 4 siege rounds > 50%.
const worstWithBomb4 = Math.min(...withBombNoBlock.map((c) => c.pCaptureWithinK[3]));
const t5dMet = worstWithBomb4 > 0.50;

// ----------------------------------------------------------------- report

const elapsedMs = Date.now() - t0;

const REP_GARRISON = 6; // representative garrison for the printed tier x engines tables
const cell = (tier: number, engines: number) =>
  grid.find((c) => c.tier === tier && c.garrison === REP_GARRISON && c.engines === engines)!;

console.log(`SIEGE MONTE CARLO  seed=${SEED}  iters/cell=${ITERS}${isSmoke() ? ' (SMOKE)' : ''}`);
console.log(`grid attacker = ${ATTACKER_PROFESSIONALS} professionals (+engines), garrison = professionals, plains, landlocked`);
console.log(`policy: assault when wall bonus <= ${DEFAULT_SIEGE_POLICY.assaultWallThreshold} (breach) or garrison <= ${DEFAULT_SIEGE_POLICY.assaultGarrisonMax}; give up after ${DEFAULT_SIEGE_POLICY.maxSiegeRounds} rounds`);
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

console.log('DIRECT ASSAULT vs INTACT THEODOSIAN WALLS (win prob; escalade -1, wall +4)');
console.log(
  table(
    ['attackers', ...CPLE_GARRISONS.map((g) => `garrison ${g}`)],
    directAssault.map((r) => [r.attackers, ...r.winProb.map((p) => pct(p, 2))]),
  ),
);
console.log();

console.log(`CONSTANTINOPLE (T5 Theodosian Walls, ${wallHitpoints(5, true)} hp, coastal): P(capture within k siege rounds)`);
console.log(`attacker = ${CPLE_ATTACKER.professional} professionals + ${CPLE_ATTACKER.mercenary} mercenaries + ${CPLE_ATTACKER.siegeEngine} siege engines`);
console.log(
  table(
    ['scenario', ...[1, 2, 3, 4, 6, 8, 10, 12].map((k) => `k=${k}`), 'P(cap)', 'median'],
    cple.map((c) => [
      `${c.greatBombard ? 'BOMBARD' : 'no bomb'} ${c.blockaded ? 'BLOCKADE' : 'open sea'} g=${c.garrison}`,
      ...[1, 2, 3, 4, 6, 8, 10, 12].map((k) => pct(c.pCaptureWithinK[k - 1])),
      pct(c.captureProb),
      c.medianRoundsToCapture === null ? '-' : String(c.medianRoundsToCapture),
    ]),
  ),
);
console.log();

console.log('TARGETS (T5)');
console.log(`  a) direct assault intact Theodosian < 2%:            worst=${pct(worstDirectAssault, 2)}  ${t5aMet ? 'MET' : 'MISSED'}`);
console.log(`  b) no Bombard + no blockade, capture <=12r < 10%:    worst=${pct(worstNoBombNoBlock12)}  ${t5bMet ? 'MET' : 'MISSED'}`);
console.log(`  c) no Bombard + blockade: starve works, median >= 6: minCap=${pct(minBlockCapture)} minMedian=${minBlockMedian}  ${t5cMet ? 'MET' : 'MISSED'}`);
console.log(`  d) with Bombard, capture <=4 rounds > 50%:           worst=${pct(worstWithBomb4)}  ${t5dMet ? 'MET' : 'MISSED'}`);
console.log();

const path = writeResults('siege', {
  meta: {
    seed: SEED,
    iterationsPerCell: ITERS,
    smoke: isSmoke(),
    elapsedMs,
    gridAttacker: `${ATTACKER_PROFESSIONALS} professionals + <engines> siege engines (landlocked city)`,
    cpleAttacker: CPLE_ATTACKER,
    garrisonComposition: 'professionals',
    terrain: 'plains',
    policy: DEFAULT_SIEGE_POLICY,
    config: { walls: CONFIG.walls, siege: CONFIG.siege, combat: CONFIG.combat },
    note: 'FINAL canon (2b42386): walls T1-T5, binary wall bonus, escalade -1, stores-then-starve, sea resupply (blockade = every adjacent zone enemy-held), T5 masonry cap 1 HP/round lifted by the Great Bombard (2 wall-damage dice). Bombard scenarios assume game round >= siege.greatBombard.availableFromRound.',
  },
  grid,
  directAssaultIntactTheodosian: {
    description: 'single battles: N professionals assault intact Theodosian walls (escalade -1, defender +4), garrisons per column',
    garrisons: CPLE_GARRISONS,
    rows: directAssault,
    worstWinProb: worstDirectAssault,
  },
  constantinople: cple,
  targets: {
    t5a_directAssaultUnder2pct: { worst: worstDirectAssault, met: t5aMet },
    t5b_noBombardNoBlockadeWithin12Under10pct: { worst: worstNoBombNoBlock12, met: t5bMet },
    t5c_blockadeStarveWorksMedianAtLeast6: { minCaptureProb: minBlockCapture, minMedianRounds: minBlockMedian, met: t5cMet },
    t5d_withBombardWithin4Over50pct: { worst: worstWithBomb4, met: t5dMet },
  },
});
console.log(`wrote ${path}  (${fmt(elapsedMs / 1000, 1)}s)`);
