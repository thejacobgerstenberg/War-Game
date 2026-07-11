/**
 * Monte-Carlo combat matchup grids (FINAL canon kernel, 2b42386).
 *
 * For every army-size pairing 1..12 attackers vs 1..12 defenders we run
 * resolveBattle() many times and record attacker win probability plus mean
 * losses on both sides, across modifier sets:
 *   openField, riverCrossing, hills, wall1..wall5 (intact, escalade -1),
 *   plus RATIFIED tactic cards at their final magnitudes (canon §7.7):
 *   attVeterans (+1 die, the median combat card), attCondottieri (+2 dice,
 *   the strongest straight combat card), defLockedShields (reroll 1/round
 *   on defense), and bribedGatekeeperT3 (wall bonus zeroed on a T3 assault).
 * Reference composition is pure professional troops on both sides; an extra
 * open-field grid with a pure-LEVY attacker vs professional defender
 * quantifies the unit-quality gap, and a janissaryVsVarangian grid shows
 * the per-faction CV overrides (Ottoman 3/3 attack vs Byzantine 2/4 guard).
 *
 * Output: sim/results/combat.json + a few readable ASCII slices with sanity
 * assertions (bigger armies win more; every defender bonus lowers attacker
 * win prob; tier-5 wall coin-flip attacker:defender ratio).
 *
 * Run from sim/:  npx tsx src/run/combat_mc.ts     (>=100k trials/cell)
 *          SMOKE=1 npx tsx src/run/combat_mc.ts    (2k trials/cell)
 */

import type { Army, CombatModifiers, FactionId, UnitType } from '../types';
import { CONFIG } from '../rules';
import {
  armyOf,
  effectiveWallBonus,
  modifiers,
  NO_MODIFIERS,
  resolveBattle,
} from '../combat';
import { create } from '../rng';
import { isSmoke, pct, fmt, table, writeResults } from '../util';

// ------------------------------------------------------------ configuration

const SEED = 0xc0ba7; // "combat"
const MAX_SIZE = 12;
const SMOKE = isSmoke();
const TRIALS = SMOKE ? 2000 : 100_000;

interface ModifierSet {
  id: string;
  description: string;
  mods: CombatModifiers;
}

const cc = CONFIG.combat;
const escalade = -CONFIG.siege.escaladePenalty; // canon §8.2.4: assaulting unbreached walls

const wallSet = (tier: 1 | 2 | 3 | 4 | 5): ModifierSet => ({
  id: `wall${tier}`,
  description:
    `direct assault on intact T${tier} walls (defender +${CONFIG.walls.tierBonus[tier]}, escalade ${escalade})` +
    (tier === 5 ? ' — the Theodosian Walls' : ''),
  mods: modifiers({ attackerBonus: escalade, wallBonus: effectiveWallBonus(tier, tier === 5, 0) }),
});

const MODIFIER_SETS: ModifierSet[] = [
  {
    id: 'openField',
    description: 'no modifiers (plains, no walls, no cards)',
    mods: modifiers(NO_MODIFIERS),
  },
  {
    id: 'riverCrossing',
    description: `attacking across a strait / amphibiously: attacker ${-cc.riverCrossingPenalty} (threshold space)`,
    mods: modifiers({ attackerBonus: -cc.riverCrossingPenalty }),
  },
  {
    id: 'hills',
    description: `defender in hills/mountains/forest: defender +${cc.terrain.hills} (canon §7.3)`,
    mods: modifiers({ terrainBonus: cc.terrain.hills }),
  },
  wallSet(1),
  wallSet(2),
  wallSet(3),
  wallSet(4),
  wallSet(5),
  {
    id: 'attVeterans',
    description: 'attacker plays Veterans of the Border (ratified median combat card: +1 die per melee round)',
    mods: modifiers({ attackerExtraDice: 1 }),
  },
  {
    id: 'attCondottieri',
    description: 'attacker plays Condottieri Contract (strongest ratified dice card: +2 dice per melee round, 2 gold)',
    mods: modifiers({ attackerExtraDice: 2 }),
  },
  {
    id: 'defLockedShields',
    description: 'defender plays Locked Shields (ratified: reroll 1 missed die per melee round on defense)',
    mods: modifiers({ defenderRerolls: 1 }),
  },
  {
    id: 'bribedGatekeeperT3',
    description: 'assault on intact T3 walls with The Bribed Gatekeeper (ratified: wall bonus 0; escalade -1 still applies)',
    mods: modifiers({ attackerBonus: escalade, wallBonus: 0 }),
  },
];

// ------------------------------------------------------------ grid runner

interface Grid {
  /** winProb[a-1][d-1] = attacker win probability for a vs d. */
  winProb: number[][];
  meanAttackerLosses: number[][];
  meanDefenderLosses: number[][];
  meanAttackerSurvivors: number[][];
  meanDefenderSurvivors: number[][];
}

function runGrid(
  attackerUnit: UnitType,
  defenderUnit: UnitType,
  mods: CombatModifiers,
  streamBase: number,
): Grid {
  const winProb: number[][] = [];
  const mAL: number[][] = [];
  const mDL: number[][] = [];
  const mAS: number[][] = [];
  const mDS: number[][] = [];
  const root = create(SEED);
  const attacker: Army = armyOf({});
  const defender: Army = armyOf({});

  for (let a = 1; a <= MAX_SIZE; a++) {
    winProb.push([]);
    mAL.push([]);
    mDL.push([]);
    mAS.push([]);
    mDS.push([]);
    for (let d = 1; d <= MAX_SIZE; d++) {
      const rng = root.fork(streamBase * 10_000 + a * 100 + d);
      let wins = 0;
      let aLoss = 0;
      let dLoss = 0;
      let aSurv = 0;
      let dSurv = 0;
      for (let t = 0; t < TRIALS; t++) {
        // Reset the reusable army objects (resolveBattle mutates them).
        attacker.levy = 0;
        attacker.professional = 0;
        attacker.mercenary = 0;
        attacker.galley = 0;
        attacker[attackerUnit] = a;
        defender.levy = 0;
        defender.professional = 0;
        defender.mercenary = 0;
        defender.galley = 0;
        defender[defenderUnit] = d;
        const r = resolveBattle(attacker, defender, mods, rng);
        if (r.winner === 'attacker') wins++;
        aLoss += r.attackerLosses;
        dLoss += r.defenderLosses;
        aSurv += r.attackerRemaining;
        dSurv += r.defenderRemaining;
      }
      const inv = 1 / TRIALS;
      winProb[a - 1].push(wins * inv);
      mAL[a - 1].push(aLoss * inv);
      mDL[a - 1].push(dLoss * inv);
      mAS[a - 1].push(aSurv * inv);
      mDS[a - 1].push(dSurv * inv);
    }
  }
  return {
    winProb,
    meanAttackerLosses: mAL,
    meanDefenderLosses: mDL,
    meanAttackerSurvivors: mAS,
    meanDefenderSurvivors: mDS,
  };
}

// ------------------------------------------------------------ run all grids

console.log(
  `combat_mc: ${MODIFIER_SETS.length} modifier sets + levy & faction grids, ` +
    `${MAX_SIZE}x${MAX_SIZE} cells, ${TRIALS} trials/cell` +
    (SMOKE ? ' [SMOKE]' : ''),
);

const t0 = Date.now();
const grids: Record<string, Grid> = {};
MODIFIER_SETS.forEach((set, i) => {
  const gt = Date.now();
  grids[set.id] = runGrid('professional', 'professional', set.mods, i + 1);
  console.log(`  ${set.id.padEnd(18)} done in ${((Date.now() - gt) / 1000).toFixed(1)}s`);
});
const gtLevy = Date.now();
const levyGrid = runGrid('levy', 'professional', modifiers(NO_MODIFIERS), 99);
console.log(`  ${'levyVsProf'.padEnd(18)} done in ${((Date.now() - gtLevy) / 1000).toFixed(1)}s`);
// Faction asymmetry grid (FACTIONS unique-unit CVs): Janissary (3/3) attacks
// Varangian Guard (2/4) in the open field.
const gtFaction = Date.now();
const factionGrid = runGrid(
  'professional',
  'professional',
  modifiers({ attackerFaction: 'ottomans' as FactionId, defenderFaction: 'byzantium' as FactionId }),
  98,
);
console.log(`  ${'janVsVarangian'.padEnd(18)} done in ${((Date.now() - gtFaction) / 1000).toFixed(1)}s`);
const elapsedSec = (Date.now() - t0) / 1000;

// ------------------------------------------------------------ sanity checks

// Tolerance for Monte-Carlo noise on a difference of two adjacent cells.
const TOL = 5 * Math.sqrt(0.5 / TRIALS);

interface Violation {
  check: string;
  detail: string;
  delta: number;
}
const violations: Violation[] = [];

function checkMonotone(id: string, g: Grid): void {
  for (let d = 0; d < MAX_SIZE; d++) {
    for (let a = 1; a < MAX_SIZE; a++) {
      const delta = g.winProb[a][d] - g.winProb[a - 1][d];
      if (delta < -TOL) {
        violations.push({
          check: 'biggerAttackerWinsMore',
          detail: `${id}: ${a + 1}v${d + 1} < ${a}v${d + 1}`,
          delta,
        });
      }
    }
  }
  for (let a = 0; a < MAX_SIZE; a++) {
    for (let d = 1; d < MAX_SIZE; d++) {
      const delta = g.winProb[a][d - 1] - g.winProb[a][d];
      if (delta < -TOL) {
        violations.push({
          check: 'biggerDefenderWinsMore',
          detail: `${id}: att ${a + 1} vs def ${d + 1} beats vs def ${d}`,
          delta,
        });
      }
    }
  }
}

for (const set of MODIFIER_SETS) checkMonotone(set.id, grids[set.id]);
checkMonotone('levyVsProf', levyGrid);
checkMonotone('janVsVarangian', factionGrid);

// Every defender-favoring modifier set must be <= openField cell-by-cell,
// and walls must order wall5 <= wall4 <= ... <= wall1 (T4/T5 share the +4
// bonus, so wall5 <= wall4 holds within tolerance — they differ via HP).
const defenderFavoring: Array<[string, string]> = [
  ['riverCrossing', 'openField'],
  ['hills', 'openField'],
  ['wall1', 'openField'],
  ['wall2', 'wall1'],
  ['wall3', 'wall2'],
  ['wall4', 'wall3'],
  ['wall5', 'wall4'],
  ['defLockedShields', 'openField'],
];
for (const [worse, better] of defenderFavoring) {
  for (let a = 0; a < MAX_SIZE; a++) {
    for (let d = 0; d < MAX_SIZE; d++) {
      const delta = grids[better].winProb[a][d] - grids[worse].winProb[a][d];
      if (delta < -TOL) {
        violations.push({
          check: 'defenderBonusLowersWinProb',
          detail: `${worse} > ${better} at ${a + 1}v${d + 1}`,
          delta,
        });
      }
    }
  }
}
// Attacker-favoring ratified cards must raise win prob vs their baseline:
// +1 die >= no card, +2 dice >= +1 die, Bribed Gatekeeper >= raw T3 assault.
const attackerFavoring: Array<[string, string]> = [
  ['openField', 'attVeterans'],
  ['attVeterans', 'attCondottieri'],
  ['wall3', 'bribedGatekeeperT3'],
];
for (const [worse, better] of attackerFavoring) {
  for (let a = 0; a < MAX_SIZE; a++) {
    for (let d = 0; d < MAX_SIZE; d++) {
      const delta = grids[better].winProb[a][d] - grids[worse].winProb[a][d];
      if (delta < -TOL) {
        violations.push({
          check: 'attackerCardRaisesWinProb',
          detail: `${better} < ${worse} at ${a + 1}v${d + 1}`,
          delta,
        });
      }
    }
  }
}
// Levy attacker must be strictly worse than professional attacker (quality gap).
for (let a = 0; a < MAX_SIZE; a++) {
  for (let d = 0; d < MAX_SIZE; d++) {
    const delta = grids.openField.winProb[a][d] - levyGrid.winProb[a][d];
    if (delta < -TOL) {
      violations.push({
        check: 'levyWeakerThanProfessional',
        detail: `levy attacker > prof attacker at ${a + 1}v${d + 1}`,
        delta,
      });
    }
  }
}

// Tier-5 coin-flip ratio: smallest (interpolated) attacker count whose win
// prob crosses 50% against d defenders behind the intact Theodosian Walls.
function coinFlipAttackers(g: Grid, d: number): number | null {
  const col = g.winProb.map((row) => row[d - 1]);
  if (col[0] >= 0.5) return 1;
  for (let a = 1; a < MAX_SIZE; a++) {
    if (col[a] >= 0.5) {
      const lo = col[a - 1];
      const hi = col[a];
      const frac = hi > lo ? (0.5 - lo) / (hi - lo) : 0;
      return a + frac; // interpolated size between a and a+1
    }
  }
  return null; // never reaches 50% within 1..12
}

const tier5Ratios: Array<{ defenders: number; coinFlipAttackers: number | null; ratio: number | null }> = [];
for (let d = 1; d <= MAX_SIZE; d++) {
  const a = coinFlipAttackers(grids.wall5, d);
  tier5Ratios.push({ defenders: d, coinFlipAttackers: a, ratio: a === null ? null : a / d });
}
const measurable = tier5Ratios.filter((r) => r.ratio !== null) as Array<{ defenders: number; coinFlipAttackers: number; ratio: number }>;
const tier5MeanRatio = measurable.length
  ? measurable.reduce((s, r) => s + r.ratio, 0) / measurable.length
  : null;

// ------------------------------------------------------------ ASCII slices

function diagRow(id: string, g: Grid): Array<string | number> {
  const row: Array<string | number> = [id];
  for (let n = 1; n <= MAX_SIZE; n++) row.push(pct(g.winProb[n - 1][n - 1]));
  return row;
}

console.log('\n=== Attacker win prob, equal numbers (NvN), professionals both sides ===');
console.log(
  table(
    ['set', ...Array.from({ length: MAX_SIZE }, (_, i) => `${i + 1}v${i + 1}`)],
    [
      ...MODIFIER_SETS.map((s) => diagRow(s.id, grids[s.id])),
      diagRow('levyVsProf', levyGrid),
      diagRow('janVsVarangian', factionGrid),
    ],
  ),
);
console.log(
  'sanity: open-field NvN sits below 50% (canon: INFANTRY defends at CV 3 vs attacks at CV 2), and every defender bonus pushes it further down. NOTE: against high-CV defenders the clamp floor (2+) saturates, so wall tiers can look identical here — tiers differentiate through wall HP (siege length) and vs low-CV garrisons.',
);

console.log('\n=== 6 attackers vs 4 defenders across all modifier sets ===');
console.log(
  table(
    ['set', 'attWin', 'meanAttLoss', 'meanDefLoss', 'attSurv', 'defSurv'],
    [
      ...MODIFIER_SETS.map((s) => {
        const g = grids[s.id];
        return [
          s.id,
          pct(g.winProb[5][3]),
          fmt(g.meanAttackerLosses[5][3]),
          fmt(g.meanDefenderLosses[5][3]),
          fmt(g.meanAttackerSurvivors[5][3]),
          fmt(g.meanDefenderSurvivors[5][3]),
        ];
      }),
      [
        'levyVsProf',
        pct(levyGrid.winProb[5][3]),
        fmt(levyGrid.meanAttackerLosses[5][3]),
        fmt(levyGrid.meanDefenderLosses[5][3]),
        fmt(levyGrid.meanAttackerSurvivors[5][3]),
        fmt(levyGrid.meanDefenderSurvivors[5][3]),
      ],
    ],
  ),
);
console.log('sanity: 6v4 should be a clear favorite in the open and hopeless against intact professional-held walls (assault waits for the breach).');

console.log('\n=== Tier-5 (Theodosian) wall coin-flip ratio (attackers needed for ~50% direct assault) ===');
console.log(
  table(
    ['defenders', 'coinFlipAttackers', 'ratio'],
    tier5Ratios.map((r) => [
      r.defenders,
      r.coinFlipAttackers === null ? '>12' : fmt(r.coinFlipAttackers, 1),
      r.ratio === null ? '-' : fmt(r.ratio, 2),
    ]),
  ),
);
console.log(
  `mean measurable ratio: ${tier5MeanRatio === null ? 'n/a (never crosses 50% within 12)' : fmt(tier5MeanRatio, 2)}` +
    ' (canon target: intact T5 Theodosian Walls should NOT be assaultable — expect >12 across the board; breach first)',
);

console.log(
  `\nsanity violations beyond MC tolerance (${fmt(TOL, 4)}): ${violations.length}` +
    (violations.length ? '' : ' — all monotonicity and ordering checks passed'),
);
for (const v of violations.slice(0, 20)) {
  console.log(`  [${v.check}] ${v.detail} (delta ${fmt(v.delta, 4)})`);
}

// ------------------------------------------------------------ write results

const setsOut: Record<string, unknown> = {};
for (const set of MODIFIER_SETS) {
  setsOut[set.id] = { description: set.description, mods: set.mods, ...grids[set.id] };
}

const path = writeResults('combat', {
  meta: {
    module: 'combat_mc',
    seed: SEED,
    trialsPerCell: TRIALS,
    smoke: SMOKE,
    sizes: { min: 1, max: MAX_SIZE },
    composition: 'professional vs professional (levyVsProfessional grid: pure levy attacker, open field)',
    gridIndexing: 'winProb[attackerSize-1][defenderSize-1]',
    tacticCardSets: 'attVeterans/attCondottieri/defLockedShields/bribedGatekeeperT3 encode RATIFIED canon §7.7 cards at final magnitudes',
    elapsedSec,
    generatedAt: new Date().toISOString(),
  },
  sets: setsOut,
  levyVsProfessional: {
    description: 'pure levy attacker vs professional defender, open field (quality gap)',
    mods: modifiers(NO_MODIFIERS),
    ...levyGrid,
  },
  janissaryVsVarangian: {
    description: 'Ottoman professionals (Janissary 3/3) attack Byzantine professionals (Varangian Guard 2/4), open field — faction CV asymmetry',
    mods: modifiers({ attackerFaction: 'ottomans', defenderFaction: 'byzantium' }),
    ...factionGrid,
  },
  sanity: {
    tolerance: TOL,
    violationCount: violations.length,
    violations: violations.slice(0, 100),
    tier5CoinFlip: { perDefenderSize: tier5Ratios, meanRatio: tier5MeanRatio },
  },
});
console.log(`\nwrote ${path} in ${elapsedSec.toFixed(1)}s total`);

if (violations.length > 0) {
  console.error('SANITY FAILURE: combat grids violate monotonicity/ordering checks');
  process.exit(1);
}
