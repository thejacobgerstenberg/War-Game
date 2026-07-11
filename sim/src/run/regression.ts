/**
 * sim:regression — deterministic balance-regression gate over the six
 * adversarial exploit hunts (called by .github/workflows/balance-regression.yml
 * via `npm run sim:regression --if-present`).
 *
 * SCALE: each runner executes at the COMMITTED evidence scale and base seed
 * (the exact protocol behind the sim/results/adversarial_*.json artifacts):
 *
 *   cple_beeline     GAMES=1000            seed 311002
 *   merc_rush        GAMES=500/fac/variant seed 311001 (genoa x2)
 *   runaway_leader   GAMES=2000/arm        seed 311004
 *   turtle_dominance 400 / 250 / 600       seed 311003 (defaults)
 *   economy_exploit  400 / 1000 / 1000     seed 311005 (defaults)
 *   faction_floor    GAMES=300 XGAMES=1000 seed 111006
 *
 * All seeds are fixed, so a run at unchanged code reproduces the committed
 * evidence numbers exactly (zero sampling flake; verified byte-identical
 * modulo config.elapsedMs). Measured: 153 s wall-clock on 4 cores (runners
 * execute in parallel; ~5.7 min single-threaded) — well under the
 * ~15-minute CI line; see the runtimes line under the verdict table.
 *
 * BARS: two kinds, both encoded below —
 *   - hunt-brief bars that PASS outright at the shipped config (beeline
 *     <=20%/<=10%, lone-turtle <=40%, merc absolute lines, runaway 2-keys /
 *     objective-flip lines, floor endings) are enforced verbatim;
 *   - metrics that are adjudicated-open in TUNING_REPORT §4/§5 (turtle
 *     monoculture ceilings >50% = §5 items 1-2, merc paired z 3.35 = §5
 *     item 7, runaway r8 predictivity 70.8% = §5 item 3, genoa+trader
 *     mixed ceiling = archetype-agent limitation) get a REGRESSION line at
 *     baseline + headroom instead — the gate fails only if the accepted
 *     wart WORSENS materially, not because it exists.
 *
 * Runner outputs are redirected to sim/out/regression/ (SIM_RESULTS_DIR
 * override in util.ts) so the committed sim/results/ evidence is never
 * touched; the CI workflow archives sim/out/**. Exit 1 if any bar fails.
 *
 * Usage: cd sim && npm run sim:regression
 */

import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pct, table } from '../util';

const SIM_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(SIM_ROOT, 'out', 'regression');
const TSX = join(SIM_ROOT, 'node_modules', '.bin', 'tsx');

interface RunnerSpec {
  hunt: string;
  script: string;
  env: Record<string, string>;
  /** results JSON basename the runner writes (into OUT_DIR). */
  json: string;
}

const RUNNERS: RunnerSpec[] = [
  { hunt: 'cple_beeline', script: 'src/adversarial/run_cple_beeline.ts', env: { GAMES: '1000' }, json: 'adversarial_cple_beeline' },
  { hunt: 'merc_rush', script: 'src/adversarial/run_merc_rush.ts', env: { GAMES: '500' }, json: 'adversarial_merc_rush' },
  { hunt: 'runaway_leader', script: 'src/adversarial/run_runaway_leader.ts', env: { GAMES: '2000' }, json: 'adversarial_runaway_leader' },
  { hunt: 'turtle_dominance', script: 'src/adversarial/run_turtle_dominance.ts', env: {}, json: 'adversarial_turtle_dominance' },
  { hunt: 'economy_exploit', script: 'src/adversarial/run_economy_exploit.ts', env: {}, json: 'adversarial_economy_exploit' },
  { hunt: 'faction_floor', script: 'src/adversarial/run_faction_floor.ts', env: { GAMES: '300', XGAMES: '1000' }, json: 'adversarial_faction_floor' },
];

// ------------------------------------------------------------ child running

interface RunOutcome {
  spec: RunnerSpec;
  code: number;
  elapsedMs: number;
  output: string;
}

function runOne(spec: RunnerSpec): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(TSX, [spec.script], {
      cwd: SIM_ROOT,
      env: { ...process.env, ...spec.env, SIM_RESULTS_DIR: OUT_DIR, SMOKE: '' },
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('close', (code) =>
      resolve({ spec, code: code ?? 1, elapsedMs: Math.round(performance.now() - t0), output }),
    );
  });
}

/** Run all specs with bounded concurrency, printing each report as it lands. */
async function runAll(specs: RunnerSpec[], concurrency: number): Promise<RunOutcome[]> {
  const queue = [...specs];
  const done: RunOutcome[] = [];
  async function worker(): Promise<void> {
    for (;;) {
      const spec = queue.shift();
      if (!spec) return;
      console.log(`[regression] ${spec.hunt} started (${JSON.stringify(spec.env)})`);
      const r = await runOne(spec);
      console.log(`\n===== ${spec.hunt} (exit ${r.code}, ${(r.elapsedMs / 1000).toFixed(1)}s) =====`);
      console.log(r.output.trimEnd());
      done.push(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, worker));
  return done;
}

// ------------------------------------------------------------------- bars

interface Bar {
  hunt: string;
  bar: string;
  value: number;
  /** pass iff value <= limit (or >= when floor=true) */
  limit: number;
  floor?: boolean;
  /** hunt-brief bar vs regression line on an adjudicated-open wart */
  kind: 'brief' | 'regression';
  fmt?: (x: number) => string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function readJson(name: string): Json {
  return JSON.parse(readFileSync(join(OUT_DIR, `${name}.json`), 'utf8'));
}

function evalBars(): Bar[] {
  const bars: Bar[] = [];
  const p = (x: number) => pct(x);

  // ---- 1. Constantinople beeline (hunt-brief bars, all PASS at ship) ----
  const bee = readJson('adversarial_cple_beeline');
  const brief = bee.scenarios.filter((s: Json) => !s.byzGuard && !s.noTreason);
  const solo = brief.filter((s: Json) => s.beelinerFactions.length === 1);
  bars.push(
    { hunt: 'cple_beeline', bar: 'max SD by single beeliner', value: Math.max(...solo.map((s: Json) => s.suddenDeath.byBeelinerRate)), limit: 0.2, kind: 'brief', fmt: p },
    { hunt: 'cple_beeline', bar: 'max SD completing <= r8', value: Math.max(...brief.map((s: Json) => s.sdBeforeRound9.rate)), limit: 0.1, kind: 'brief', fmt: p },
    { hunt: 'cple_beeline', bar: 'max Byz eliminated < r8', value: Math.max(...brief.map((s: Json) => s.byzEliminated.beforeRound8Rate)), limit: 0.15, kind: 'brief', fmt: p },
  );

  // ---- 2. Mercenary rush ----
  const merc = readJson('adversarial_merc_rush');
  let mercMax = 0;
  for (const v of ['cycle', 'honest']) {
    for (const f of Object.keys(merc.byVariantFaction[v])) {
      mercMax = Math.max(mercMax, merc.byVariantFaction[v][f].rate);
    }
  }
  bars.push(
    // 33.3% = beats the 4-seat field average by 2x; also dominates the 40% line
    { hunt: 'merc_rush', bar: 'max single-faction rate (cycle/honest)', value: mercMax, limit: 1 / 3, kind: 'brief', fmt: p },
    // paired stiffing gradient: z 3.35 at ship is adjudicated-open (§5 item 7)
    { hunt: 'merc_rush', bar: 'paired cycle-vs-honest z (§5 item 7)', value: merc.pairedSameSeed.cycleVsHonest.z, limit: 5, kind: 'regression', fmt: (x) => x.toFixed(2) },
  );

  // ---- 3. Runaway leader ----
  const run = readJson('adversarial_runaway_leader');
  bars.push(
    // 70.8% at ship sits 0.8pp over the 70% hunt line — adjudicated §5 item 3
    { hunt: 'runaway_leader', bar: 'P(r8 leader wins) (§5 item 3)', value: run.summary.p_r8_leader_wins_on, limit: 0.75, kind: 'regression', fmt: p },
    { hunt: 'runaway_leader', bar: 'P(win | 2 keys @ r6)', value: run.summary.p_win_given_2keys_r6_on, limit: 0.75, kind: 'brief', fmt: p },
    { hunt: 'runaway_leader', bar: 'objective-reveal flip share', value: run.summary.objectiveFlipShare_on, limit: 0.3, kind: 'brief', fmt: p },
  );

  // ---- 4. Turtle dominance ----
  const tur = readJson('adversarial_turtle_dominance');
  const lone = Math.max(...Object.values(tur.loneTurtler).map((a: Json) => a.overall.rate));
  let mono = 0;
  for (const arm of ['tradeMax', 'monopolyMax']) {
    for (const f of Object.keys(tur.tradeMaxTurtle[arm])) {
      mono = Math.max(mono, tur.tradeMaxTurtle[arm][f].rate);
    }
  }
  bars.push(
    { hunt: 'turtle_dominance', bar: 'lone turtler overall', value: lone, limit: 0.4, kind: 'brief', fmt: p },
    // >50% monoculture ceilings are adjudicated-open (§5 items 1-2; ship max 61.3%)
    { hunt: 'turtle_dominance', bar: 'max monoculture ceiling (§5 items 1-2)', value: mono, limit: 0.67, kind: 'regression', fmt: p },
    // all-turtle mirror near-ties: 57.8% at ship, open item 1
    { hunt: 'turtle_dominance', bar: 'all-turtle near-tie share (§5 item 1)', value: tur.allTurtle.nearTieShareAnyType, limit: 0.7, kind: 'regression', fmt: p },
  );

  // ---- 5. Economy exploit ----
  const eco = readJson('adversarial_economy_exploit');
  const floodMax = Math.max(
    ...Object.values(eco.levyFlood).map((f: Json) => f.winRateDeltaVsBestPolicy as number),
  );
  const griefed = eco.blockade.griefGenoa.byFaction.genoa.rate;
  const noBlock = eco.blockade.griefGenoaNoBlockade.byFaction.genoa.rate;
  const omenMax = Math.max(
    ...Object.values(eco.incomeTelemetry.byFaction).map((f: Json) => f.maxGoldEventOverMean as number),
  );
  bars.push(
    { hunt: 'economy_exploit', bar: 'max levy-flood delta vs best honest policy', value: floodMax, limit: 0.05, kind: 'brief', fmt: (x) => (100 * x).toFixed(1) + 'pp' },
    { hunt: 'economy_exploit', bar: 'blockade-mechanism attribution (noBlockade - grief)', value: noBlock - griefed, limit: 0.05, kind: 'brief', fmt: (x) => (100 * x).toFixed(1) + 'pp' },
    { hunt: 'economy_exploit', bar: 'passive-picket griefer win rate', value: eco.blockade.griefGenoaPassive.byFaction.ottomans.rate, limit: 0.02, kind: 'brief', fmt: p },
    { hunt: 'economy_exploit', bar: 'max omen swing / mean round income', value: omenMax, limit: 1.5, kind: 'brief', fmt: (x) => x.toFixed(2) + 'x' },
  );

  // ---- 6. Faction floor ----
  const flo = readJson('adversarial_faction_floor');
  let worstBest = 1; // min over factions of (best mixed-field policy win rate)
  let elimMax = 0;
  let mixedCeil = 0;
  for (const fac of Object.keys(flo.grid)) {
    let best = 0;
    for (const pol of Object.keys(flo.grid[fac])) {
      for (const field of Object.keys(flo.grid[fac][pol])) {
        const cell = flo.grid[fac][pol][field];
        elimMax = Math.max(elimMax, cell.focalElimRate);
        if (field === 'mixed') {
          best = Math.max(best, cell.focalWinRate);
          mixedCeil = Math.max(mixedCeil, cell.focalWinRate);
        }
      }
    }
    worstBest = Math.min(worstBest, best);
  }
  const medMin = Math.min(...flo.extremes.map((x: Json) => x.medianRounds));
  const turtleExtreme = flo.extremes.find((x: Json) => x.policy === 'turtler');
  const capCloseOther = Math.max(
    ...flo.extremes.filter((x: Json) => x.policy !== 'turtler').map((x: Json) => x.capCloseMarginRate),
  );
  bars.push(
    { hunt: 'faction_floor', bar: 'worst faction best-policy vs mixed field', value: worstBest, limit: 0.1, floor: true, kind: 'brief', fmt: p },
    { hunt: 'faction_floor', bar: 'max grid-cell elimination rate', value: elimMax, limit: 0.05, kind: 'brief', fmt: p },
    // genoa+trader 68.3% at ship — adjudicated archetype-agent limitation
    { hunt: 'faction_floor', bar: 'max mixed-field cell ceiling (archetype note)', value: mixedCeil, limit: 0.75, kind: 'regression', fmt: p },
    { hunt: 'faction_floor', bar: 'min extreme-field median length', value: medMin, limit: 9, floor: true, kind: 'brief', fmt: (x) => String(x) },
    // all-5-turtler margin<2 endings 58.0% at ship — §5 item 1
    { hunt: 'faction_floor', bar: 'all-turtler cap near-ties (§5 item 1)', value: turtleExtreme.capCloseMarginRate, limit: 0.7, kind: 'regression', fmt: p },
    { hunt: 'faction_floor', bar: 'max non-turtler extreme cap near-ties', value: capCloseOther, limit: 0.4, kind: 'brief', fmt: p },
  );

  return bars;
}

// ------------------------------------------------------------------- main

const t0 = performance.now();
mkdirSync(OUT_DIR, { recursive: true });
const concurrency = Math.max(1, Math.min(cpus().length, 4));
console.log(`sim:regression — six adversarial hunts at committed scale/seeds, concurrency ${concurrency}`);
console.log(`outputs -> ${OUT_DIR} (committed sim/results/ untouched)\n`);

const outcomes = await runAll(RUNNERS, concurrency);
const crashed = outcomes.filter((o) => o.code !== 0);
for (const c of crashed) console.error(`\nRUNNER CRASHED: ${c.spec.hunt} exited ${c.spec.script} with code ${c.code}`);

let bars: Bar[] = [];
let evalError: unknown = null;
if (crashed.length === 0) {
  try {
    bars = evalBars();
  } catch (e) {
    evalError = e;
  }
}

const failures = bars.filter((b) => (b.floor ? b.value < b.limit : b.value > b.limit));
const elapsed = ((performance.now() - t0) / 1000).toFixed(0);

console.log(`\n===== REGRESSION VERDICT (${elapsed}s total) =====\n`);
console.log(
  table(
    ['hunt', 'bar', 'value', 'limit', 'kind', 'status'],
    bars.map((b) => [
      b.hunt,
      b.bar,
      (b.fmt ?? String)(b.value),
      (b.floor ? '>= ' : '<= ') + (b.fmt ?? String)(b.limit),
      b.kind,
      (b.floor ? b.value >= b.limit : b.value <= b.limit) ? 'PASS' : 'FAIL',
    ]),
  ),
);
console.log(
  `\nruntimes: ${outcomes
    .map((o) => `${o.spec.hunt} ${(o.elapsedMs / 1000).toFixed(0)}s`)
    .join(', ')}`,
);

if (crashed.length > 0) {
  console.error(`\nsim:regression: FAIL (${crashed.length} runner(s) crashed)`);
  process.exit(1);
}
if (evalError) {
  console.error('\nsim:regression: FAIL (bar evaluation error)', evalError);
  process.exit(1);
}
if (failures.length > 0) {
  console.error(`\nsim:regression: FAIL — ${failures.length} bar(s) regressed:`);
  for (const f of failures) {
    console.error(`  ! ${f.hunt}: ${f.bar} = ${(f.fmt ?? String)(f.value)} vs ${f.floor ? '>=' : '<='} ${(f.fmt ?? String)(f.limit)}`);
  }
  process.exit(1);
}
console.log('\nsim:regression: PASS — no adversarial bar regressed.');
