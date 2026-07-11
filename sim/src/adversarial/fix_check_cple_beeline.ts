/**
 * ADVERSARIAL FIX CHECK: re-run the solo-Ottoman Constantinople beeline with
 * candidate CONFIG mutations (applied at runtime; rules.ts is NOT edited) to
 * see which numeric change kills the exploit.
 *
 * NOTE (canon kernel swap): the original variants targeted the pre-canon
 * percentage-attrition siege model. They have been remapped to the nearest
 * canon-kernel equivalents; results in adversarial_cple_beeline.json that
 * predate the swap were produced under the old model.
 *
 * Candidates:
 *   base          : tuned config as-is (control)
 *   hp28          : walls.theodosianExtraHitpoints 0 -> 12 (cple wall HP 16 -> 28)
 *   hp40          : walls.theodosianExtraHitpoints 0 -> 24 (cple wall HP 16 -> 40)
 *   hp28+stores5  : hp28 + grain stores 3 -> 5 (slower starve under blockade)
 *   hp28+hold3    : hp28 + sudden-death hold 2 -> 3 rounds
 *   hp28+hold3+noResupply : + disable R3 sea resupply entirely
 *
 * Usage: cd sim && GAMES=500 npx tsx src/adversarial/fix_check_cple_beeline.ts
 */

import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName } from '../game';
import { makeAgent } from '../agents';
import { pct } from '../util';
import { makeBeelineAgent } from './cple_beeline';

const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const BASE_SEED = envInt('SEED') ?? 111002;
const N = envInt('GAMES') ?? 500;

interface Variant {
  name: string;
  apply(): void;
  revert(): void;
}

const origHp = CONFIG.walls.theodosianExtraHitpoints;
const origStores = CONFIG.siege.grainStoresRounds;
const origHold = CONFIG.game.suddenDeathHoldRounds;
const origResup = CONFIG.siege.seaResupplyEnabled;

const variants: Variant[] = [
  { name: 'base', apply() {}, revert() {} },
  {
    name: 'hp28',
    apply() { CONFIG.walls.theodosianExtraHitpoints = 12; },
    revert() { CONFIG.walls.theodosianExtraHitpoints = origHp; },
  },
  {
    name: 'hp40',
    apply() { CONFIG.walls.theodosianExtraHitpoints = 24; },
    revert() { CONFIG.walls.theodosianExtraHitpoints = origHp; },
  },
  {
    name: 'hp28+stores5',
    apply() {
      CONFIG.walls.theodosianExtraHitpoints = 12;
      CONFIG.siege.grainStoresRounds = 5;
    },
    revert() {
      CONFIG.walls.theodosianExtraHitpoints = origHp;
      CONFIG.siege.grainStoresRounds = origStores;
    },
  },
  {
    name: 'hp28+hold3',
    apply() {
      CONFIG.walls.theodosianExtraHitpoints = 12;
      CONFIG.game.suddenDeathHoldRounds = 3;
    },
    revert() {
      CONFIG.walls.theodosianExtraHitpoints = origHp;
      CONFIG.game.suddenDeathHoldRounds = origHold;
    },
  },
  {
    name: 'hp28+hold3+noResupply',
    apply() {
      CONFIG.walls.theodosianExtraHitpoints = 12;
      CONFIG.game.suddenDeathHoldRounds = 3;
      CONFIG.siege.seaResupplyEnabled = false;
    },
    revert() {
      CONFIG.walls.theodosianExtraHitpoints = origHp;
      CONFIG.game.suddenDeathHoldRounds = origHold;
      CONFIG.siege.seaResupplyEnabled = origResup;
    },
  },
];

const summaries: Array<Record<string, unknown>> = [];

for (const v of variants) {
  v.apply();
  let sd = 0;
  let sdBeeliner = 0;
  let sdByR8 = 0;
  let beeWins = 0;
  const lengths: number[] = [];
  const capHist: Record<number, number> = {};
  for (let i = 0; i < N; i++) {
    const seed = BASE_SEED + i;
    const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
    const pool: PolicyName[] = [...POLICY_NAMES];
    create(seed).fork(97).shuffle(pool);
    const agents = {} as Record<FactionId, Agent>;
    let pi = 0;
    for (const f of FACTION_IDS) {
      agents[f] = f === 'ottomans'
        ? makeBeelineAgent(f, { launchMin: 8, launchBy: 2, recruitStyle: 'prof' })
        : makeAgent(pool[pi++]);
    }
    const res = new Game(seed, agents, seatOrder).run();
    lengths.push(res.rounds);
    if (res.winner === 'ottomans') beeWins++;
    if (res.victoryType === 'suddenDeath') {
      sd++;
      if (res.winner === 'ottomans') sdBeeliner++;
      if (res.rounds <= 8) sdByR8++;
      const cap = res.rounds - 1;
      capHist[cap] = (capHist[cap] ?? 0) + 1;
    }
  }
  v.revert();
  lengths.sort((a, b) => a - b);
  const summary = {
    variant: v.name,
    games: N,
    baseSeed: BASE_SEED,
    suddenDeathRate: sd / N,
    suddenDeathByBeelinerRate: sdBeeliner / N,
    sdCompleteByRound8Rate: sdByR8 / N,
    beelinerWinRate: beeWins / N,
    medianLength: lengths[Math.floor(N / 2)],
    sdCaptureRounds: capHist,
  };
  summaries.push(summary);
  console.log(
    `${v.name.padEnd(12)} sd=${pct(sd / N)} (beeliner ${pct(sdBeeliner / N)})  sd<=r8=${pct(sdByR8 / N)}  ` +
      `beelinerWins=${pct(beeWins / N)}  medianLen=${lengths[Math.floor(N / 2)]}  capRounds=${JSON.stringify(capHist)}`,
  );
}

// merge into the adversarial results file (preserve the scenario runs)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results', 'adversarial_cple_beeline.json');
const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};
existing.fixCheck = {
  note: 'solo_ottoman beeline re-run under candidate CONFIG mutations (applied at runtime; rules.ts untouched)',
  variants: summaries,
};
writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n');
console.log(`fixCheck merged into ${outPath}`);
