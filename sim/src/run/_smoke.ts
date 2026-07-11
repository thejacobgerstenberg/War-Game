/**
 * Scaffold smoke test: exercises rng + combat + map + util.
 * Run from sim/:  npx tsx src/run/_smoke.ts
 * Not part of the sim:* script contract; kept as a quick sanity harness.
 */

import { create } from '../rng';
import {
  armyOf,
  combatants,
  copyArmy,
  effectiveWallBonus,
  modifiers,
  resolveBattle,
} from '../combat';
import {
  FACTION_STARTS,
  PROVINCES,
  PROVINCE_BY_ID,
  SEA_ZONES,
  KEY_CITY_IDS,
  TRADE_ROUTES,
  validateMap,
  neutralGarrison,
} from '../map';
import { CONFIG } from '../rules';
import { pct, table } from '../util';
import type { Army, CombatModifiers } from '../types';

const rng = create(1453);

// ---- RNG determinism ----
const a = create(42);
const b = create(42);
let same = true;
for (let i = 0; i < 1000; i++) if (a.next() !== b.next()) same = false;
console.log(`RNG determinism (seed 42, 1000 draws): ${same ? 'OK' : 'FAIL'}`);
const counts = [0, 0, 0, 0, 0, 0];
for (let i = 0; i < 60000; i++) counts[rng.d6() - 1]++;
console.log(`d6 distribution over 60000 rolls: ${counts.join(' / ')} (expect ~10000 each)`);

// ---- Map sanity ----
const problems = validateMap();
console.log(`\nMap: ${PROVINCES.length} provinces, ${SEA_ZONES.length} sea zones, ` +
  `${KEY_CITY_IDS.length} key cities, ${TRADE_ROUTES.length} trade routes`);
console.log(`validateMap: ${problems.length === 0 ? 'OK' : 'PROBLEMS:\n  ' + problems.join('\n  ')}`);
for (const [fid, start] of Object.entries(FACTION_STARTS)) {
  const owned = PROVINCES.filter((p) => p.initialOwner === fid).length;
  console.log(`  ${fid}: ${owned} provinces, ${start.treasury.gold} gold, ${start.treasury.grain} grain`);
}
const cons = PROVINCE_BY_ID.get('constantinople')!;
console.log(`  Constantinople intact wall bonus: +${effectiveWallBonus(cons.wallTier, true, 0)}`);
console.log(`  neutral Ragusa garrison: ${JSON.stringify(neutralGarrison(PROVINCE_BY_ID.get('ragusa')!))}`);

// ---- Combat kernel: batches of battles at different sizes/modifiers ----
interface Scenario {
  name: string;
  att: Army;
  def: Army;
  mods: CombatModifiers;
}

const scenarios: Scenario[] = [
  { name: '5 levy vs 3 levy (field)', att: armyOf({ levy: 5 }), def: armyOf({ levy: 3 }), mods: modifiers({}) },
  { name: '6 prof vs 6 levy (field)', att: armyOf({ professional: 6 }), def: armyOf({ levy: 6 }), mods: modifiers({}) },
  { name: '8 mixed vs 5 prof, hills', att: armyOf({ levy: 4, professional: 2, mercenary: 2 }), def: armyOf({ professional: 5 }), mods: modifiers({ terrainBonus: CONFIG.combat.terrain.hills }) },
  { name: '10 prof vs 4 prof, tier-2 wall', att: armyOf({ professional: 10 }), def: armyOf({ professional: 4 }), mods: modifiers({ wallBonus: effectiveWallBonus(2, false, 0) }) },
  { name: '12 prof vs 4 garrison, Theodosian intact', att: armyOf({ professional: 12 }), def: armyOf({ levy: 2, professional: 2 }), mods: modifiers({ wallBonus: effectiveWallBonus(3, true, 0) }) },
  { name: '12 prof vs 4 garrison, Theodosian breached', att: armyOf({ professional: 12 }), def: armyOf({ levy: 2, professional: 2 }), mods: modifiers({ wallBonus: effectiveWallBonus(3, true, 16) }) },
  { name: '20 levy vs 10 prof + tactic card', att: armyOf({ levy: 20 }), def: armyOf({ professional: 10 }), mods: modifiers({ defenderBonus: CONFIG.combat.tacticCardSwing }) },
  { name: '4 galley vs 3 galley (sea)', att: armyOf({ galley: 4 }), def: armyOf({ galley: 3 }), mods: modifiers({}) },
];

const N = 20000;
const rows: Array<Array<string | number>> = [];
for (let s = 0; s < scenarios.length; s++) {
  const sc = scenarios[s];
  const bat = rng.fork(s + 1);
  let attWins = 0;
  let rounds = 0;
  let attLossSum = 0;
  let defLossSum = 0;
  for (let i = 0; i < N; i++) {
    const att = copyArmy(sc.att);
    const def = copyArmy(sc.def);
    const r = resolveBattle(att, def, sc.mods, bat);
    if (r.winner === 'attacker') attWins++;
    rounds += r.rounds;
    attLossSum += r.attackerLosses;
    defLossSum += r.defenderLosses;
  }
  rows.push([sc.name, pct(attWins / N), (rounds / N).toFixed(1), (attLossSum / N).toFixed(1), (defLossSum / N).toFixed(1)]);
}
console.log(`\nBattle Monte-Carlo (${N} battles each):`);
console.log(table(['scenario', 'attWin', 'avgRounds', 'attLoss', 'defLoss'], rows));

// ---- Throughput sanity (kernel is the hot path) ----
const perf = rng.fork(999);
const t0 = performance.now();
let wins = 0;
const M = 200000;
for (let i = 0; i < M; i++) {
  const att = armyOf({ professional: 8, levy: 4 });
  const def = armyOf({ professional: 5, levy: 3 });
  if (resolveBattle(att, def, modifiers({ terrainBonus: 0.5 }), perf).winner === 'attacker') wins++;
}
const dt = performance.now() - t0;
console.log(`\nThroughput: ${M} battles in ${dt.toFixed(0)} ms (${Math.round(M / (dt / 1000))} battles/s), attWin ${pct(wins / M)}`);

const fail = !same || problems.length > 0;
console.log(fail ? '\nSMOKE: FAIL' : '\nSMOKE: OK');
if (fail) process.exit(1);
