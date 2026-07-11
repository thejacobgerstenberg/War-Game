/**
 * sim:test — pure unit assertions beyond the in-run smoke checks.
 * Plain tsx script, no test framework, no new deps; exits 1 on any failure.
 *
 * Covers (marshal-review fold-in round, 2026-07-11):
 *   - canon §7.1/§7.4 kernel worked examples + threshold clamp edge cases
 *   - §8.1 wall table and the binary breach rule
 *   - §6.4 stacking caps + headroom arithmetic (pure parts)
 *   - ERRATA E2 monopoly diminishing-returns prestige
 *   - §7.7 tactic-deck composition (24 designs / 48 cards) and the
 *     master-founders-hired definition
 *   - RNG / battle determinism
 *
 * Usage: cd sim && npm run sim:test
 */

import { CONFIG } from '../rules';
import {
  armyOf,
  copyArmy,
  effectiveWallBonus,
  hitThreshold,
  modifiers,
  resolveBattle,
} from '../combat';
import { landUnits, monopolyPrestige, stackCapOf } from '../game';
import { wallHitpoints } from '../siege';
import { create } from '../rng';

let failures = 0;
let checks = 0;

function eq(name: string, got: unknown, want: unknown): void {
  checks++;
  const ok = Number.isNaN(want as number) ? Number.isNaN(got as number) : got === want;
  if (!ok) {
    failures++;
    console.error(`  FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Kernel worked examples (canon §7.1/§7.4: threshold = clamp(7 - CV - mods, 2, 6))
// ---------------------------------------------------------------------------
console.log('kernel worked examples');
eq('CV 1, no mods -> 6+', hitThreshold(1, 0), 6);
eq('CV 2, no mods -> 5+', hitThreshold(2, 0), 5);
eq('CV 3, no mods -> 4+', hitThreshold(3, 0), 4);
// §7.4 worked example: INFANTRY CV 2 attacker "7-2-0 = 5+"
eq('worked ex: professional attacker -> 5+', hitThreshold(CONFIG.units.professional.cvAttack, 0), 5);
// §7.4: CV 1 defender + rough terrain "7-1-1 = 5+"
eq('worked ex: levy defender + hills -> 5+', hitThreshold(CONFIG.units.levy.cvDefense, CONFIG.combat.terrain.hills), 5);
// escalade -1 pushes a professional attacker to the ceiling
eq('escalade: CV 2 attacker at -1 -> 6+', hitThreshold(2, -CONFIG.siege.escaladePenalty), 6);

// ---------------------------------------------------------------------------
// 2. Threshold clamp edge cases (canon §7.1: nothing better than 2+, worse than 6+)
// ---------------------------------------------------------------------------
console.log('threshold clamp edges');
eq('floor: CV 3 + 4 mods -> 2+ (raw 0)', hitThreshold(3, 4), 2);
eq('floor exact: CV 3 + 2 mods -> 2+ (raw 2)', hitThreshold(3, 2), 2);
eq('floor: CV 6 + 10 mods stays 2+', hitThreshold(6, 10), 2);
eq('ceiling: CV 0, -2 mods -> 6+ (raw 9)', hitThreshold(0, -2), 6);
eq('ceiling exact: CV 1, 0 mods -> 6+ (raw 6)', hitThreshold(1, 0), 6);
eq('ceiling: CV -1 (hypothetical) -> 6+', hitThreshold(-1, 0), 6);
eq('interior untouched: CV 2 + 1 mod -> 4+', hitThreshold(2, 1), 4);

// ---------------------------------------------------------------------------
// 3. Wall table + binary breach (canon §8.1/§8)
// ---------------------------------------------------------------------------
console.log('wall table / breach rule');
const wantBonus = [0, 1, 2, 3, 4, 4];
const wantHp = [0, 3, 6, 10, 13, 16];
for (let t = 1; t <= 5; t++) {
  eq(`T${t} bonus`, effectiveWallBonus(t, t === 5, 0), wantBonus[t]);
  eq(`T${t} HP`, wallHitpoints(t, t === 5), wantHp[t]);
}
eq('T5 at 15 damage keeps full bonus', effectiveWallBonus(5, true, 15), 4);
eq('T5 at 16 damage is breached (bonus 0)', effectiveWallBonus(5, true, 16), 0);
eq('T0 has no bonus', effectiveWallBonus(0, false, 0), 0);

// ---------------------------------------------------------------------------
// 4. Stacking caps + headroom arithmetic (canon §6.4, pure parts)
// ---------------------------------------------------------------------------
console.log('stacking headroom math');
eq('landUnits counts levy+prof+merc+engine', landUnits(armyOf({ levy: 2, professional: 3, mercenary: 1, siegeEngine: 2 })), 8);
eq('landUnits excludes galleys (naval)', landUnits(armyOf({ levy: 2, galley: 4 })), 2);
eq('Constantinople (T5 CITY) caps at 12', stackCapOf('constantinople'), 12);
eq('capital caps at 12 (edirne)', stackCapOf('edirne'), 12);
eq('open-country province caps at 8', stackCapOf('epirus'), CONFIG.stacking.landPerProvince);
// headroom = cap - committed; excess cannot enter (clamped at action time)
const committed = landUnits(armyOf({ levy: 5, professional: 4 }));
eq('headroom at a 12-cap city with 9 committed = 3', stackCapOf('constantinople') - committed, 3);
eq('clamped reinforcement: min(request, headroom)', Math.min(5, stackCapOf('constantinople') - committed), 3);
eq('a full 8-stack has zero headroom in open country', CONFIG.stacking.landPerProvince - landUnits(armyOf({ levy: 8 })), 0);

// ---------------------------------------------------------------------------
// 5. ERRATA E2 monopoly diminishing-returns prestige (canon §13.1 + E2)
// ---------------------------------------------------------------------------
console.log('monopoly prestige (E2)');
eq('0 monopolies -> 0', monopolyPrestige(0), 0);
eq('1 monopoly -> +2', monopolyPrestige(1), 2);
eq('2 monopolies -> +3 (2+1)', monopolyPrestige(2), 3);
eq('3 monopolies -> +4 (2+1+1)', monopolyPrestige(3), 4);
eq(
  'formula tracks CONFIG levers',
  monopolyPrestige(4),
  CONFIG.prestige.tradeMonopolyPerRound + 3 * CONFIG.prestige.tradeMonopolyAdditionalPerRound,
);

// ---------------------------------------------------------------------------
// 6. Tactic deck composition (canon §7.7 — 24 designs, 48 cards)
// ---------------------------------------------------------------------------
console.log('tactic deck composition');
eq('24 designs', CONFIG.tacticCards.length, 24);
eq('48 cards', CONFIG.tacticCards.reduce((s, c) => s + c.copies, 0), 48);
const byTier = { common: 0, uncommon: 0, rare: 0 } as Record<string, number>;
for (const c of CONFIG.tacticCards) byTier[c.tier]++;
eq('8 common designs', byTier.common, 8);
eq('8 uncommon designs', byTier.uncommon, 8);
eq('8 rare designs', byTier.rare, 8);
eq('unique slugs', new Set(CONFIG.tacticCards.map((c) => c.slug)).size, 24);
const mf = CONFIG.tacticCards.find((c) => c.slug === 'master-founders-hired');
eq('master-founders-hired present', mf !== undefined, true);
eq('  rare x1', mf!.tier === 'rare' && mf!.copies === 1, true);
eq('  assault-scoped', mf!.scope, 'assault');
eq('  zeroes the wall bonus', mf!.zeroWallBonus, true);
eq('  +1 assault die', mf!.extraDice, 1);
eq('  whole-engagement (no first-round-only limit)', mf!.firstRoundOnly ?? false, false);
eq('  creates no siege engine / Bombard interaction', mf!.captureCity ?? false, false);

// ---------------------------------------------------------------------------
// 7. Determinism (same seed -> same battle transcript)
// ---------------------------------------------------------------------------
console.log('determinism');
{
  const mods = modifiers({ wallBonus: 4, attackerBonus: -1, siegeAssault: true, attackerExtraDice: 1 });
  const runOnce = (seed: number) => {
    const att = armyOf({ professional: 9, siegeEngine: 3 });
    const def = armyOf({ levy: 4, professional: 4 });
    const r = resolveBattle(copyArmy(att), copyArmy(def), mods, create(seed));
    return JSON.stringify(r);
  };
  eq('same seed -> identical battle result', runOnce(1453) === runOnce(1453), true);
  const a = create(99);
  const b = create(99);
  let same = true;
  for (let i = 0; i < 200; i++) if (a.next() !== b.next()) same = false;
  eq('rng stream reproducible', same, true);
}

// ---------------------------------------------------------------------------
console.log(`\nsim:test: ${checks - failures}/${checks} assertions passed`);
if (failures > 0) {
  console.error(`sim:test: FAIL (${failures} assertion(s))`);
  process.exit(1);
}
console.log('sim:test: OK');
