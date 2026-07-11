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
  hitThreshold,
  modifiers,
  resolveBattle,
} from '../combat';
import { wallHitpoints } from '../siege';
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

// ---- Canon combat-kernel assertions (2b42386 docs/GAME_DESIGN.md §6-§8) ----
// Encodes the doc's worked threshold math and tables as hard checks.
const kernelChecks: Array<[string, number, number]> = [
  // §7.1: "CV 1 hits on 6 (1/6), CV 2 on 5+ (2/6), CV 3 on 4+ (3/6)"
  ['CV 1, no mods -> 6+', hitThreshold(1, 0), 6],
  ['CV 2, no mods -> 5+', hitThreshold(2, 0), 5],
  ['CV 3, no mods -> 4+', hitThreshold(3, 0), 4],
  // §7.4 worked example: attacker INFANTRY CV 2 hit on "7-2-0 = 5+"
  ['worked ex: CV 2 attacker, 0 mods -> 5+', hitThreshold(CONFIG.units.professional.cvAttack, 0), 5],
  // §7.4: CV 1 defender + terrain 1 -> "7-1-1 = 5+"
  ['worked ex: CV 1 defender + hills -> 5+', hitThreshold(CONFIG.units.levy.cvDefense, CONFIG.combat.terrain.hills), 5],
  // §7.4 melee: defender INF "7-3-1 = 3+"
  ['worked ex: CV 3 defender + hills -> 3+', hitThreshold(CONFIG.units.professional.cvDefense, CONFIG.combat.terrain.hills), 3],
  // §7.1 clamp: thresholds never leave [2, 6]
  ['clamp floor: CV 3 + wall 4 -> 2+', hitThreshold(3, 4), 2],
  ['clamp ceiling: CV 0 with -2 mods -> 6', hitThreshold(0, -2), 6],
  ['escalade: CV 2 attacker at -1 -> 6', hitThreshold(2, -CONFIG.siege.escaladePenalty), 6],
  // §8.1 wall table T1-T5: 3/+1, 6/+2, 10/+3, 13/+4, 16/+4 (T5 = Theodosian)
  ['wall T1 bonus', effectiveWallBonus(1, false, 0), 1],
  ['wall T2 bonus', effectiveWallBonus(2, false, 0), 2],
  ['wall T3 bonus', effectiveWallBonus(3, false, 0), 3],
  ['wall T4 bonus', effectiveWallBonus(4, false, 0), 4],
  ['wall T5 (Theodosian) bonus', effectiveWallBonus(5, true, 0), 4],
  ['wall T1 HP', wallHitpoints(1, false), 3],
  ['wall T2 HP', wallHitpoints(2, false), 6],
  ['wall T3 HP', wallHitpoints(3, false), 10],
  ['wall T4 HP', wallHitpoints(4, false), 13],
  ['wall T5 (Theodosian) HP', wallHitpoints(5, true), 16],
  // §8: the bonus is binary — full until breach, zero at breach
  ['damaged Theodosian keeps full bonus', effectiveWallBonus(5, true, 15), 4],
  ['breached Theodosian has no bonus', effectiveWallBonus(5, true, 16), 0],
  // FACTIONS unique-unit CV overrides (2b42386 FACTIONS.md mapping)
  ['Hungarian levy (+1 combat) attacks on 5+', hitThreshold(CONFIG.factionUnits.hungary.levy.cvAttack, 0), 5],
  ['Hungarian levy costs 2-1=1 gold', CONFIG.factionUnits.hungary.levy.goldCost, 1],
  ['Ottoman levy eats no grain (devshirme)', CONFIG.factionUnits.ottomans.levy.grainUpkeep, 0],
  ['Janissary attacks on 4+ (CV 3)', hitThreshold(CONFIG.factionUnits.ottomans.professional.cvAttack, 0), 4],
  ['Varangian Guard defends on 3+ (CV 4)', hitThreshold(CONFIG.factionUnits.byzantium.professional.cvDefense, 0), 3],
  ['Black Army attacks on 4+ (CV 3)', hitThreshold(CONFIG.factionUnits.hungary.professional.cvAttack, 0), 4],
  ['Genoese merc surcharge waived (6g = base CAVALRY cost)', CONFIG.factionUnits.genoa.mercenary.goldCost, 6],
  ['base mercenary = CAVALRY x1.5 gold (9g)', CONFIG.units.mercenary.goldCost, 9],
  ['base mercenary = x2 grain upkeep (4)', CONFIG.units.mercenary.grainUpkeep, 4],
  // §8.3/§8.4: T5 masonry cap and the Great Bombard's two wall-damage dice
  ['T5 masonry cap = 1 HP/round', CONFIG.siege.t5MasonryCapPerRound, 1],
  ['Great Bombard rolls 2 wall-damage dice', CONFIG.siege.greatBombard.damageDice, 2],
];
// §7.7 ratified tactic deck: 23 designs, 47 cards (8 common x3, 8 uncommon x2, 7 rare x1)
const designs = CONFIG.tacticCards.length;
const deckSize = CONFIG.tacticCards.reduce((s, c) => s + c.copies, 0);
const byTier = { common: 0, uncommon: 0, rare: 0 } as Record<string, number>;
for (const c of CONFIG.tacticCards) byTier[c.tier]++;
kernelChecks.push(
  ['tactic designs = 23', designs, 23],
  ['tactic deck = 47 cards', deckSize, 47],
  ['8 common designs', byTier.common, 8],
  ['8 uncommon designs', byTier.uncommon, 8],
  ['7 rare designs', byTier.rare, 7],
);
let kernelFails = 0;
for (const [name, got, want] of kernelChecks) {
  const ok = got === want;
  if (!ok) kernelFails++;
  if (!ok) console.log(`  CANON CHECK FAIL: ${name}: got ${got}, want ${want}`);
}
console.log(`\nCanon kernel checks: ${kernelChecks.length - kernelFails}/${kernelChecks.length} passed`);

// Empirical hit-rate check: CV 2 must hit ~1/3 of rolls (5+).
{
  const r = create(7);
  let hits = 0;
  const N = 60000;
  const t = hitThreshold(2, 0);
  for (let i = 0; i < N; i++) if (r.d6() >= t) hits++;
  const p = hits / N;
  const ok = Math.abs(p - 1 / 3) < 0.01;
  if (!ok) kernelFails++;
  console.log(`Empirical P(hit | CV 2): ${(100 * p).toFixed(2)}% (expect ~33.3%) ${ok ? 'OK' : 'FAIL'}`);
}

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
  { name: '10 prof vs 4 prof, T2 wall assault', att: armyOf({ professional: 10 }), def: armyOf({ professional: 4 }), mods: modifiers({ attackerBonus: -CONFIG.siege.escaladePenalty, wallBonus: effectiveWallBonus(2, false, 0) }) },
  { name: '12 prof vs 4 garrison, T5 Theodosian intact', att: armyOf({ professional: 12 }), def: armyOf({ levy: 2, professional: 2 }), mods: modifiers({ attackerBonus: -CONFIG.siege.escaladePenalty, wallBonus: effectiveWallBonus(5, true, 0) }) },
  { name: '12 prof vs 4 garrison, T5 Theodosian breached', att: armyOf({ professional: 12 }), def: armyOf({ levy: 2, professional: 2 }), mods: modifiers({ wallBonus: effectiveWallBonus(5, true, 16) }) },
  { name: '20 levy vs 10 prof + Locked Shields (reroll 1)', att: armyOf({ levy: 20 }), def: armyOf({ professional: 10 }), mods: modifiers({ defenderRerolls: 1 }) },
  { name: '6 att +Veterans (+1 die) vs 6 prof', att: armyOf({ professional: 6 }), def: armyOf({ professional: 6 }), mods: modifiers({ attackerExtraDice: 1 }) },
  { name: 'Janissaries 6 vs Varangians 6 (faction CVs)', att: armyOf({ professional: 6 }), def: armyOf({ professional: 6 }), mods: modifiers({ attackerFaction: 'ottomans', defenderFaction: 'byzantium' }) },
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

const fail = !same || problems.length > 0 || kernelFails > 0;
console.log(fail ? '\nSMOKE: FAIL' : '\nSMOKE: OK');
if (fail) process.exit(1);
