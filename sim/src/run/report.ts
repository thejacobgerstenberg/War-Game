/**
 * Headline summary of sim/results/*.json (npm run sim:report).
 *
 * Prints, from whichever result files exist:
 *  - fullgame: faction/policy win rates, game length, victory types,
 *    sudden-death rate, threshold-decided share
 *  - siege: Constantinople capture curves + T5 target checks
 *  - combat: kernel meta + sanity status
 *  - economy: baseline solvency verdict
 *  - pacing: recommended threshold
 *
 * Read-only: never runs simulations, never writes files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pct, fmt, table } from '../util';

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results');

function load(name: string): any | null {
  const p = join(RESULTS_DIR, `${name}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    console.log(`  (${name}.json exists but failed to parse)`);
    return null;
  }
}

console.log('=== IMPERIUM balance sim — headline report ===\n');

// ------------------------------------------------------------- fullgame
const fg = load('fullgame');
if (fg) {
  const smoke = fg.config?.smoke ? ' [SMOKE]' : '';
  console.log(`FULL GAME (${fg.config?.games} games, seed ${fg.config?.baseSeed}${smoke})`);
  const byFaction = fg.winRates?.byFaction ?? {};
  console.log(
    table(
      ['faction', 'winRate'],
      Object.keys(byFaction).map((f) => [f, pct(byFaction[f].rate)]),
    ),
  );
  const byPolicy = fg.winRates?.byPolicy ?? {};
  console.log(
    table(
      ['policy', 'winRate'],
      Object.keys(byPolicy).map((p) => [p, pct(byPolicy[p].rate)]),
    ),
  );
  console.log(
    `length: mean ${fmt(fg.gameLength?.mean ?? 0, 1)}, median ${fg.gameLength?.median}; ` +
      `victory: threshold ${pct(fg.victoryTypes?.rates?.threshold ?? 0)}, cap ${pct(fg.victoryTypes?.rates?.cap ?? 0)}, ` +
      `suddenDeath ${pct(fg.suddenDeathRate ?? 0)}, elimination ${pct(fg.victoryTypes?.rates?.elimination ?? 0)}`,
  );
  console.log();
} else {
  console.log('FULL GAME: no results (run npm run sim:fullgame)\n');
}

// ---------------------------------------------------------------- siege
const sg = load('siege');
if (sg) {
  console.log(`SIEGE (${sg.meta?.iterationsPerCell} iters/cell${sg.meta?.smoke ? ' [SMOKE]' : ''})`);
  const cple = sg.constantinople ?? [];
  if (cple.length > 0) {
    console.log('Constantinople capture curves (P within k rounds):');
    console.log(
      table(
        ['scenario', 'k=3', 'k=4', 'k=6', 'k=12', 'P(cap)', 'median'],
        cple.map((c: any) => [
          `${c.greatBombard ? 'BOMBARD' : 'no bomb'} ${c.blockaded ? 'BLOCKADE' : 'open sea'} g=${c.garrison}`,
          pct(c.pCaptureWithinK?.[2] ?? 0),
          pct(c.pCaptureWithinK?.[3] ?? 0),
          pct(c.pCaptureWithinK?.[5] ?? 0),
          pct(c.pCaptureWithinK?.[11] ?? c.captureProb ?? 0),
          pct(c.captureProb ?? 0),
          c.medianRoundsToCapture ?? '-',
        ]),
      ),
    );
  }
  const targets = sg.targets ?? {};
  for (const [k, v] of Object.entries<any>(targets)) {
    console.log(`  ${k}: ${v.met ? 'MET' : 'MISSED'}`);
  }
  console.log();
} else {
  console.log('SIEGE: no results (run npm run sim:siege)\n');
}

// --------------------------------------------------------------- combat
const cb = load('combat');
if (cb) {
  console.log(
    `COMBAT: ${cb.meta?.trialsPerCell} trials/cell${cb.meta?.smoke ? ' [SMOKE]' : ''}, ` +
      `sanity violations: ${cb.sanity?.violationCount ?? '?'} ` +
      `(${(cb.sanity?.violationCount ?? 1) === 0 ? 'all ordering checks passed' : 'SEE combat.json'})`,
  );
  const of = cb.sets?.openField?.winProb;
  if (of) console.log(`  open-field prof-vs-prof 6v6 attacker win: ${pct(of[5][5])}; 8v4: ${pct(of[7][3])}`);
  console.log();
} else {
  console.log('COMBAT: no results (run npm run sim:combat)\n');
}

// -------------------------------------------------------------- economy
const ec = load('economy');
if (ec) {
  const factions = ec.baseline?.factions ?? [];
  const insolvent = factions.filter((f: any) => !f.solvent).map((f: any) => f.faction);
  console.log(
    `ECONOMY: baseline ${ec.baseline?.pass ? 'PASS' : 'FAIL'}` +
      (insolvent.length ? ` (insolvent: ${insolvent.join(', ')})` : ' (all factions solvent through round 16)'),
  );
  console.log();
} else {
  console.log('ECONOMY: no results (run npm run sim:economy)\n');
}

// --------------------------------------------------------------- pacing
const pc = load('pacing');
if (pc) {
  const rec = pc.recommendation;
  if (rec) {
    console.log(
      `PACING: recommended threshold ${rec.threshold} ` +
        `(meets all criteria: ${rec.meetsAllCriteria ? 'yes' : 'NO'}) — fullgame is ground truth`,
    );
  }
  console.log();
} else {
  console.log('PACING: no results (run npm run sim:pacing)\n');
}
