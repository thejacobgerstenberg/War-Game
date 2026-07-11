/**
 * ADVERSARIAL FIX CHECK: re-run the Constantinople beeline under candidate
 * CONFIG / map-start mutations (applied at runtime; rules.ts and map.ts are
 * NOT edited) to see which change kills the exploit.
 *
 * The 2026-07-11 hunt decomposed the beeline's captures into four paths
 * (see run_cple_beeline.ts / results verdict):
 *   A. standard-Byzantium collapse: the 4-unit canon garrison of a besieged
 *      capital can neither recruit nor be reinforced, and starves/escalades
 *      out by r4-8;
 *   B. treason-at-the-gate: auto-fires for any besieger after 2 siege
 *      rounds for 4 gold, regardless of garrison size;
 *   C. the raw blockade+starvation clock (stores 3 + 1 unit/round);
 *   D. round-1 plague Omen leaving 1 defender => round-1 escalade.
 *
 * Variants target those paths:
 *   base            : tuned config as-is (control)
 *   treasonLate     : treason-at-the-gate minSiegeRounds 2 -> 6, cost 4 -> 12 (B)
 *   stores6         : siege.grainStoresRounds 3 -> 6 (C)
 *   hold3           : game.suddenDeathHoldRounds 2 -> 3 (all)
 *   cpleStart10     : Byzantine start garrison in Constantinople
 *                     3 prof + 1 galley -> 5 prof + 3 levy + 2 galleys (A, C)
 *   combo           : treasonLate + stores6 + cpleStart10
 *   comboHold3      : combo + hold3
 *
 * Each variant runs BOTH the solo_ottoman protocol (standard policies for
 * the other four factions) and the guard_ottoman counterfactual (dedicated
 * Byzantine defender), so a fix must close the standard-protocol hole
 * without relying on perfect defensive play.
 *
 * Usage: cd sim && GAMES=500 npx tsx src/adversarial/fix_check_cple_beeline.ts
 */

import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { FACTION_STARTS } from '../map';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName } from '../game';
import { makeAgent } from '../agents';
import { pct } from '../util';
import { makeBeelineAgent } from './cple_beeline';
import { makeByzGuardAgent } from './byz_guard';

const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const BASE_SEED = envInt('SEED') ?? 311002;
const N = envInt('GAMES') ?? 500;

interface Variant {
  name: string;
  apply(): void;
  revert(): void;
}

const treason = CONFIG.tacticCards.find((c) => c.slug === 'treason-at-the-gate')!;
const origTreason = { minSiegeRounds: treason.minSiegeRounds, costGold: treason.costGold };
const origStores = CONFIG.siege.grainStoresRounds;
const origHold = CONFIG.game.suddenDeathHoldRounds;
const cpleStart = FACTION_STARTS.byzantium.garrisons.constantinople;
const origCple = { ...cpleStart };

const applyTreasonLate = () => { treason.minSiegeRounds = 6; treason.costGold = 12; };
const applyStores6 = () => { CONFIG.siege.grainStoresRounds = 6; };
const applyHold3 = () => { CONFIG.game.suddenDeathHoldRounds = 3; };
const applyCple10 = () => { cpleStart.professional = 5; cpleStart.levy = 3; cpleStart.galley = 2; };
const revertAll = () => {
  treason.minSiegeRounds = origTreason.minSiegeRounds;
  treason.costGold = origTreason.costGold;
  CONFIG.siege.grainStoresRounds = origStores;
  CONFIG.game.suddenDeathHoldRounds = origHold;
  Object.assign(cpleStart, origCple);
};

const variants: Variant[] = [
  { name: 'base', apply() {}, revert: revertAll },
  { name: 'treasonLate', apply: applyTreasonLate, revert: revertAll },
  { name: 'stores6', apply: applyStores6, revert: revertAll },
  { name: 'hold3', apply: applyHold3, revert: revertAll },
  { name: 'cpleStart10', apply: applyCple10, revert: revertAll },
  {
    name: 'combo',
    apply() { applyTreasonLate(); applyStores6(); applyCple10(); },
    revert: revertAll,
  },
  {
    name: 'comboHold3',
    apply() { applyTreasonLate(); applyStores6(); applyCple10(); applyHold3(); },
    revert: revertAll,
  },
];

interface ProtocolSummary {
  suddenDeathRate: number;
  suddenDeathByBeelinerRate: number;
  sdCompleteByRound8Rate: number;
  beelinerWinRate: number;
  medianLength: number;
  sdCaptureRounds: Record<number, number>;
}

function runProtocol(guard: boolean): ProtocolSummary {
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
      if (f === 'ottomans') agents[f] = makeBeelineAgent(f, { launchMin: 5, launchBy: 1 });
      else if (guard && f === 'byzantium') agents[f] = makeByzGuardAgent();
      else agents[f] = makeAgent(pool[pi++ % pool.length]);
    }
    const res = new Game(seed, agents, seatOrder).run();
    lengths.push(res.rounds);
    if (res.winner === 'ottomans') beeWins++;
    if (res.victoryType === 'suddenDeath') {
      sd++;
      if (res.winner === 'ottomans') sdBeeliner++;
      if (res.rounds <= 8) sdByR8++;
      const cap = res.rounds - CONFIG.game.suddenDeathHoldRounds + 1;
      capHist[cap] = (capHist[cap] ?? 0) + 1;
    }
  }
  lengths.sort((a, b) => a - b);
  return {
    suddenDeathRate: sd / N,
    suddenDeathByBeelinerRate: sdBeeliner / N,
    sdCompleteByRound8Rate: sdByR8 / N,
    beelinerWinRate: beeWins / N,
    medianLength: lengths[Math.floor(N / 2)],
    sdCaptureRounds: capHist,
  };
}

const summaries: Array<Record<string, unknown>> = [];

for (const v of variants) {
  v.apply();
  const std = runProtocol(false);
  const grd = runProtocol(true);
  v.revert();
  summaries.push({ variant: v.name, games: N, baseSeed: BASE_SEED, standardByz: std, guardByz: grd });
  console.log(
    `${v.name.padEnd(12)} std: sd=${pct(std.suddenDeathByBeelinerRate)} <=r8=${pct(std.sdCompleteByRound8Rate)} wins=${pct(std.beelinerWinRate)} medLen=${std.medianLength}  |  ` +
      `guard: sd=${pct(grd.suddenDeathByBeelinerRate)} <=r8=${pct(grd.sdCompleteByRound8Rate)}`,
  );
}

// merge into the adversarial results file (preserve the scenario runs)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results', 'adversarial_cple_beeline.json');
const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};
existing.fixCheck = {
  note: 'ottoman beeline re-run under candidate CONFIG/map-start mutations (runtime only; rules.ts/map.ts untouched); each variant runs the standard-policy protocol AND the dedicated-defender counterfactual',
  variants: summaries,
};
writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n');
console.log(`fixCheck merged into ${outPath}`);
