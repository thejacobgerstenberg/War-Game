/**
 * Runner for the "faction-floor" adversarial hunt (see faction_floor.ts).
 *
 *   cd sim && npx tsx src/adversarial/run_faction_floor.ts
 *
 * SMOKE=1 shrinks game counts for a quick wiring check.
 * Env overrides: GAMES=<n per grid config> XGAMES=<n per extreme field>
 *                SEED=<base seed>.
 * Writes sim/results/adversarial_faction_floor.json.
 */

import { FACTION_IDS, type FactionId } from '../types';
import { POLICY_NAMES, type PolicyName } from '../game';
import { isSmoke, pct, table, writeResults } from '../util';
import {
  runConfig,
  runExtreme,
  type ConfigResult,
  type ExtremeResult,
  type FieldKind,
} from './faction_floor';

const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

const BASE_SEED = envInt('SEED') ?? 111006;
const N_GRID = envInt('GAMES') ?? (isSmoke() ? 20 : 300);
const N_EXTREME = envInt('XGAMES') ?? (isSmoke() ? 40 : 1000);

const FIELDS: readonly FieldKind[] = ['mixed', 'allRusher', 'allTrader', 'allOpportunist'];

// Exploit thresholds from the hunt brief.
const FLOOR = 0.05; // faction win rate below this in a plausible config = DOA
const CEILING = 0.55; // faction+policy above this vs the neutral field = auto-pick
const MEDIAN_MIN = 9; // extreme field median length below this = broken ending
const CAP_CLOSE_MAX = 0.4; // extreme field share of margin<2 cap tiebreaks above this = broken

const t0 = performance.now();

// ------------------------------------------------------------------- grid

const grid: ConfigResult[] = [];
let cfgId = 1;
for (const f of FACTION_IDS) {
  for (const p of POLICY_NAMES) {
    for (const field of FIELDS) {
      grid.push(runConfig(f, p, field, N_GRID, BASE_SEED, cfgId++));
    }
  }
}

// -------------------------------------------------------- extreme fields

const extremes: ExtremeResult[] = [];
for (const p of POLICY_NAMES) {
  extremes.push(runExtreme(p, N_EXTREME, BASE_SEED, 1000 + extremes.length));
}

const elapsedMs = performance.now() - t0;

// ----------------------------------------------------------------- flags

interface Flag {
  kind: 'floor' | 'ceiling' | 'ending';
  detail: string;
}
const flags: Flag[] = [];

for (const r of grid) {
  if (r.focalWinRate < FLOOR) {
    flags.push({
      kind: 'floor',
      detail:
        `${r.focalFaction}+${r.focalPolicy} vs ${r.field}: ${pct(r.focalWinRate)} ` +
        `(${r.focalWins}/${r.games}, elim ${pct(r.focalElimRate)})`,
    });
  }
  if (r.field === 'mixed' && r.focalWinRate > CEILING) {
    flags.push({
      kind: 'ceiling',
      detail: `${r.focalFaction}+${r.focalPolicy} vs mixed field: ${pct(r.focalWinRate)} (${r.focalWins}/${r.games})`,
    });
  }
}
for (const x of extremes) {
  if (x.medianRounds < MEDIAN_MIN) {
    flags.push({ kind: 'ending', detail: `all-5-${x.policy}: median length ${x.medianRounds} (<${MEDIAN_MIN})` });
  }
  if (x.capCloseMarginRate > CAP_CLOSE_MAX) {
    flags.push({
      kind: 'ending',
      detail: `all-5-${x.policy}: ${pct(x.capCloseMarginRate)} of games are cap tiebreaks with margin<2`,
    });
  }
}

// --------------------------------------------------------------- results

const byFaction = {} as Record<FactionId, Record<PolicyName, Record<FieldKind, ConfigResult>>>;
for (const r of grid) {
  byFaction[r.focalFaction] ??= {} as Record<PolicyName, Record<FieldKind, ConfigResult>>;
  byFaction[r.focalFaction][r.focalPolicy] ??= {} as Record<FieldKind, ConfigResult>;
  byFaction[r.focalFaction][r.focalPolicy][r.field] = r;
}

const results = {
  hunt: 'faction_floor',
  config: {
    baseSeed: BASE_SEED,
    gamesPerGridConfig: N_GRID,
    gamesPerExtremeField: N_EXTREME,
    gridConfigs: grid.length,
    fields: FIELDS,
    smoke: isSmoke(),
    elapsedMs: Math.round(elapsedMs),
    thresholds: { floor: FLOOR, ceiling: CEILING, medianMin: MEDIAN_MIN, capCloseMax: CAP_CLOSE_MAX },
  },
  grid: byFaction,
  extremes,
  flags,
};

const outPath = writeResults('adversarial_faction_floor', results);

// ----------------------------------------------------------------- report

console.log(
  `faction-floor hunt — ${grid.length} grid configs x ${N_GRID} games + ` +
    `${extremes.length} extreme fields x ${N_EXTREME} games, base seed ${BASE_SEED}, ` +
    `${(elapsedMs / 1000).toFixed(1)}s${isSmoke() ? ' (SMOKE)' : ''}`,
);

for (const field of FIELDS) {
  console.log(`\nFocal win rate vs field=${field} (rows: faction, cols: focal policy):`);
  console.log(
    table(
      ['faction', ...POLICY_NAMES],
      FACTION_IDS.map((f) => [
        f,
        ...POLICY_NAMES.map((p) => {
          const r = byFaction[f][p][field];
          return `${pct(r.focalWinRate, 1)} (elim ${pct(r.focalElimRate, 0)})`;
        }),
      ]),
    ),
  );
}

console.log('\nExtreme monoculture fields:');
console.log(
  table(
    ['field', 'median', 'mean', 'early(<r11)', 'threshold', 'cap', 'suddenDeath', 'capMargin<2'],
    extremes.map((x) => [
      `all-5-${x.policy}`,
      x.medianRounds,
      x.meanRounds.toFixed(2),
      pct(x.earlyEndRate),
      pct(x.victoryRates.threshold),
      pct(x.victoryRates.cap),
      pct(x.victoryRates.suddenDeath),
      pct(x.capCloseMarginRate),
    ]),
  ),
);

console.log('\nExtreme field wins by faction:');
console.log(
  table(
    ['field', ...FACTION_IDS],
    extremes.map((x) => [`all-5-${x.policy}`, ...FACTION_IDS.map((f) => x.winsByFaction[f])]),
  ),
);

if (flags.length > 0) {
  console.log('\nEXPLOIT FLAGS:');
  for (const fl of flags) console.log(`  ! [${fl.kind}] ${fl.detail}`);
} else {
  console.log('\nNo exploit flags at the configured thresholds.');
}

console.log(`\nResults written to ${outPath}`);
