/**
 * Economy runner: per-faction x archetype 16-round solvency curves at CONFIG
 * defaults, plus a price-point sweep locating the region where all three
 * archetypes stay solvent and competitive for every faction.
 *
 *   npx tsx src/run/economy.ts           (full sweep: full factorial)
 *   SMOKE=1 npx tsx src/run/economy.ts   (defaults + one-at-a-time sweep)
 */

import { CONFIG, cloneConfig, type Config } from '../rules';
import { create } from '../rng';
import { bar, fmt, isSmoke, table, writeResults } from '../util';
import {
  ARCHETYPES,
  DEFAULT_ECON_OPTIONS,
  evaluateConfig,
  simulateEconomy,
  sweepAxes,
  type EconRunResult,
} from '../economy';
import { FACTION_IDS } from '../types';

// The economy model is deterministic; the seeded RNG is instantiated to pin
// the reproducibility contract (and for any future stochastic haircuts).
const rng = create(0xec0);
void rng;

const smoke = isSmoke();

// ------------------------------------------------------- baseline (defaults)

const baseline = evaluateConfig(CONFIG, DEFAULT_ECON_OPTIONS);

function curveReport(r: EconRunResult): void {
  const maxIncome = Math.max(...r.rounds.map((x) => x.goldIncome), 1);
  console.log(
    `\n  ${r.faction} / ${r.archetype}` +
      `  (insolvency: ${r.insolvencyRound ?? 'none'}, maxArmy fielded ${r.maxArmyFielded}, supportable ${r.maxArmySupportable})`,
  );
  console.log(
    table(
      ['rnd', 'goldInc', 'goldUpk', 'grainInc', 'grainUpk', 'gold', 'grain', 'army', 'prov', 'mkts', 'rts', 'des', 'income bar'],
      r.rounds.map((x) => [
        x.round,
        fmt(x.goldIncome, 1),
        fmt(x.goldUpkeep, 1),
        fmt(x.grainIncome, 1),
        fmt(x.grainUpkeep, 1),
        fmt(x.goldStock, 1),
        fmt(x.grainStock, 1),
        x.armyTotal,
        x.provinces,
        x.markets,
        x.routes,
        x.deserted,
        bar(x.goldIncome, maxIncome, 24),
      ]),
    )
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  );
}

console.log('=== IMPERIUM economy model: per-faction curves at CONFIG defaults ===');
for (const f of FACTION_IDS) {
  for (const a of ARCHETYPES) {
    curveReport(baseline.runs.find((r) => r.faction === f && r.archetype === a)!);
  }
}

console.log('\n=== Baseline criteria (CONFIG defaults) ===');
console.log(
  table(
    ['faction', 'solvent', 'rushR5', 'strike5', 'turtleStrong', 'turtleBounded', 'balancedMid', 'rushNet16', 'turtleNet16', 'balNet16'],
    baseline.factions.map((e) => [
      e.faction,
      e.solvent ? 'yes' : 'NO',
      e.rushCredibleR5 ? 'yes' : 'NO',
      fmt(e.strikePowerRound5, 1),
      e.turtleStrong ? 'yes' : 'NO',
      e.turtleBounded ? 'yes' : 'NO',
      e.balancedMid ? 'yes' : 'NO',
      fmt(e.rushNet16, 1),
      fmt(e.turtleNet16, 1),
      fmt(e.balancedNet16, 1),
    ]),
  ),
);
console.log(`baseline pass: ${baseline.pass}`);

// -------------------------------------------------------------------- sweep

interface SweepPoint {
  values: Record<string, number>;
  pass: boolean;
  failures: string[];
}

const axes = sweepAxes();

function runPoint(values: number[]): SweepPoint {
  const cfg: Config = cloneConfig();
  const rec: Record<string, number> = {};
  axes.forEach((ax, i) => {
    ax.apply(cfg, values[i]);
    rec[ax.name] = values[i];
  });
  const ev = evaluateConfig(cfg, DEFAULT_ECON_OPTIONS);
  const failures: string[] = [];
  for (const e of ev.factions) {
    if (!e.solvent) failures.push(`${e.faction}:insolvent`);
    if (!e.rushCredibleR5) failures.push(`${e.faction}:rushWeakR5`);
    if (!e.turtleStrong) failures.push(`${e.faction}:turtleWeak`);
    if (!e.turtleBounded) failures.push(`${e.faction}:turtleRunaway`);
    if (!e.balancedMid) failures.push(`${e.faction}:balancedLags`);
  }
  return { values: rec, pass: ev.pass, failures };
}

const points: SweepPoint[] = [];
const defaults = axes.map((a) => a.default);

if (smoke) {
  // smoke: defaults + one-at-a-time variations (13 points)
  points.push(runPoint(defaults));
  axes.forEach((ax, i) => {
    for (const v of ax.values) {
      if (v === ax.default) continue;
      const vs = [...defaults];
      vs[i] = v;
      points.push(runPoint(vs));
    }
  });
} else {
  // full factorial (3^6 = 729 points)
  const idx = new Array(axes.length).fill(0);
  for (;;) {
    points.push(runPoint(idx.map((k, i) => axes[i].values[k])));
    let i = 0;
    while (i < axes.length && ++idx[i] >= axes[i].values.length) idx[i++] = 0;
    if (i === axes.length) break;
  }
}

const passing = points.filter((p) => p.pass);

// viable region: per-axis set of values that appear in at least one passing point
const viableRegion: Record<string, number[]> = {};
for (const ax of axes) {
  viableRegion[ax.name] = ax.values.filter((v) => passing.some((p) => p.values[ax.name] === v));
}

// recommendation: passing point closest to defaults (normalized L2); defaults win ties
function distToDefault(p: SweepPoint): number {
  let d = 0;
  axes.forEach((ax) => {
    const span = Math.max(...ax.values) - Math.min(...ax.values) || 1;
    d += ((p.values[ax.name] - ax.default) / span) ** 2;
  });
  return d;
}
const recommended = passing.length > 0 ? [...passing].sort((a, b) => distToDefault(a) - distToDefault(b))[0] : null;

// most common failure modes, to guide tuning when region is empty/thin
const failureCounts = new Map<string, number>();
for (const p of points) for (const f of p.failures) failureCounts.set(f, (failureCounts.get(f) ?? 0) + 1);
const topFailures = [...failureCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

console.log(`\n=== Price-point sweep (${smoke ? 'SMOKE: one-at-a-time' : 'full factorial'}) ===`);
console.log(`points evaluated: ${points.length}, passing: ${passing.length}`);
console.log('\nviable values per axis (appearing in >=1 passing point):');
for (const ax of axes) {
  console.log(`  ${ax.name.padEnd(22)} [${viableRegion[ax.name].join(', ')}]  (default ${ax.default})`);
}
if (topFailures.length > 0) {
  console.log('\ntop failure modes across sweep:');
  for (const [f, n] of topFailures) console.log(`  ${f.padEnd(28)} ${n}`);
}

console.log('\n=== RECOMMENDATION ===');
if (recommended) {
  console.log('recommended price points (passing point nearest CONFIG defaults):');
  for (const ax of axes) {
    const v = recommended.values[ax.name];
    console.log(`  ${ax.name.padEnd(22)} ${fmt(v)}${v === ax.default ? '  (= default)' : `  (default ${ax.default})`}`);
  }
} else {
  console.log('NO passing point found; see top failure modes above.');
}

const outPath = writeResults('economy', {
  meta: {
    smoke,
    generated: new Date().toISOString(),
    options: DEFAULT_ECON_OPTIONS,
    criteria: {
      solvent: 'no desertion event in any archetype through round 16',
      rushCredibleR5: 'rush strike power (prof+merc+0.3*levy) >= 8 by end of round 5',
      turtleStrong: 'turtle net income (last-3-round avg) >= rush net AND >= 0.9x balanced net',
      turtleBounded: 'turtle gross gold income <= 1.3x balanced gross gold income',
      balancedMid: 'balanced net income >= 0.9x rush net',
    },
  },
  baseline: {
    pass: baseline.pass,
    factions: baseline.factions,
    curves: baseline.runs,
  },
  sweep: {
    axes: axes.map((a) => ({ name: a.name, values: a.values, default: a.default })),
    pointsEvaluated: points.length,
    passingCount: passing.length,
    passing: passing.map((p) => p.values),
    viableRegion,
    topFailures: topFailures.map(([mode, count]) => ({ mode, count })),
  },
  recommendation: recommended
    ? { pricePoints: recommended.values, note: 'passing sweep point nearest CONFIG defaults' }
    : { pricePoints: null, note: 'no sweep point satisfied all criteria' },
});
console.log(`\nresults written: ${outPath}`);
