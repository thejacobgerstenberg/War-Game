/**
 * THE core dice kernel. Every other module (siege, pacing, full game,
 * Monte-Carlo sweeps) resolves fights through resolveCombatRound /
 * resolveBattle. Hot path: NO allocation inside the round loop.
 *
 * Combat model (documented in RULES_MODEL.md):
 * - Risk-style: attacker rolls up to 3 d6, defender up to 2 d6 per round.
 * - Each die is shifted by a per-side float bonus:
 *     attacker shift = mods.attackerBonus + qualityBonus(attacker)
 *     defender shift = mods.defenderBonus + mods.terrainBonus
 *                    + mods.wallBonus    + qualityBonus(defender)
 *   qualityBonus is the army's average unit quality (CONFIG.units.*.quality),
 *   so a pure-professional army adds +1.0 to each of its dice, a pure-levy
 *   army adds +0.0, mixed armies fall in between.
 * - Highest attacker die vs highest defender die, then 2nd vs 2nd (if both
 *   sides rolled >= 2 dice). Loser of each comparison loses 1 unit; the
 *   defender wins exact ties (CONFIG.combat.defenderWinsTies).
 * - Casualties are removed cheapest-blood-first: levy, then mercenary, then
 *   professional, then galley. Siege engines never fight and are destroyed
 *   if their army is wiped out.
 * - resolveBattle loops rounds until a side is destroyed, the attacker's
 *   combatants fall to/below retreatFraction of the starting force (counts
 *   as a defender win), or maxRounds pass (stalemate — e.g. siege drags on).
 *
 * MUTATION WARNING: both Army objects are mutated in place.
 * ALIASING WARNING: resolveCombatRound returns a module-level reused
 * RoundLosses object — read it immediately, never store it.
 */

import type {
  Army,
  BattleOptions,
  BattleResult,
  CombatModifiers,
  RoundLosses,
} from './types';
import { CONFIG } from './rules';
import type { RNG } from './rng';

// ------------------------------------------------------------ army helpers

export function emptyArmy(): Army {
  return { levy: 0, professional: 0, mercenary: 0, siegeEngine: 0, galley: 0 };
}

export function armyOf(partial: Partial<Army>): Army {
  return {
    levy: partial.levy ?? 0,
    professional: partial.professional ?? 0,
    mercenary: partial.mercenary ?? 0,
    siegeEngine: partial.siegeEngine ?? 0,
    galley: partial.galley ?? 0,
  };
}

export function copyArmy(a: Army): Army {
  return { levy: a.levy, professional: a.professional, mercenary: a.mercenary, siegeEngine: a.siegeEngine, galley: a.galley };
}

/** Units that roll/absorb dice (everything except siege engines). */
export function combatants(a: Army): number {
  return a.levy + a.professional + a.mercenary + a.galley;
}

export function totalUnits(a: Army): number {
  return combatants(a) + a.siegeEngine;
}

/** Average unit quality of the army's combatants => die-value shift. */
export function qualityBonus(a: Army): number {
  const n = combatants(a);
  if (n === 0) return 0;
  const u = CONFIG.units;
  return (
    (a.levy * u.levy.quality +
      a.professional * u.professional.quality +
      a.mercenary * u.mercenary.quality +
      a.galley * u.galley.quality) /
    n
  );
}

/**
 * Remove n combatant casualties in fixed order: levy, mercenary,
 * professional, galley. Returns how many were actually removed.
 */
export function removeCasualties(a: Army, n: number): number {
  let r = n;
  let k = a.levy < r ? a.levy : r;
  a.levy -= k;
  r -= k;
  k = a.mercenary < r ? a.mercenary : r;
  a.mercenary -= k;
  r -= k;
  k = a.professional < r ? a.professional : r;
  a.professional -= k;
  r -= k;
  k = a.galley < r ? a.galley : r;
  a.galley -= k;
  r -= k;
  return n - r;
}

// -------------------------------------------------------------- modifiers

export const NO_MODIFIERS: Readonly<CombatModifiers> = {
  attackerBonus: 0,
  defenderBonus: 0,
  terrainBonus: 0,
  wallBonus: 0,
};

export function modifiers(partial: Partial<CombatModifiers>): CombatModifiers {
  return {
    attackerBonus: partial.attackerBonus ?? 0,
    defenderBonus: partial.defenderBonus ?? 0,
    terrainBonus: partial.terrainBonus ?? 0,
    wallBonus: partial.wallBonus ?? 0,
    attackerDiceCap: partial.attackerDiceCap,
    defenderDiceCap: partial.defenderDiceCap,
  };
}

/**
 * Defender die bonus contributed by walls, after siege damage.
 * Intact bonus = tierBonus[tier] (+ theodosianBonus for Constantinople);
 * hitpoints = tier * hitpointsPerTier (+ theodosianExtraHitpoints);
 * the bonus scales linearly with remaining hitpoints.
 */
export function effectiveWallBonus(
  wallTier: number,
  theodosian: boolean,
  wallDamage: number,
): number {
  if (wallTier <= 0) return 0;
  const w = CONFIG.walls;
  const base = w.tierBonus[wallTier] + (theodosian ? w.theodosianBonus : 0);
  const hp = wallTier * w.hitpointsPerTier + (theodosian ? w.theodosianExtraHitpoints : 0);
  const remaining = hp - wallDamage;
  if (remaining <= 0) return 0;
  return (base * remaining) / hp;
}

// ------------------------------------------------------------ round kernel

/** Reused result object — no allocation per round. Copy it if you keep it. */
const ROUND_LOSSES: RoundLosses = { attackerLosses: 0, defenderLosses: 0 };

/**
 * Resolve one round of dice. Mutates both armies (removes casualties).
 * Returns the module-level reused RoundLosses (see aliasing warning above).
 */
export function resolveCombatRound(
  attacker: Army,
  defender: Army,
  mods: CombatModifiers,
  rng: RNG,
): RoundLosses {
  ROUND_LOSSES.attackerLosses = 0;
  ROUND_LOSSES.defenderLosses = 0;

  const nAtt = combatants(attacker);
  const nDef = combatants(defender);
  if (nAtt === 0 || nDef === 0) return ROUND_LOSSES;

  const cc = CONFIG.combat;
  let diceA = nAtt < cc.attackerMaxDice ? nAtt : cc.attackerMaxDice;
  if (mods.attackerDiceCap !== undefined && mods.attackerDiceCap < diceA) diceA = mods.attackerDiceCap;
  let diceD = nDef < cc.defenderMaxDice ? nDef : cc.defenderMaxDice;
  if (mods.defenderDiceCap !== undefined && mods.defenderDiceCap < diceD) diceD = mods.defenderDiceCap;
  if (diceA <= 0 || diceD <= 0) return ROUND_LOSSES;

  // Roll and sort attacker dice descending (a1 >= a2 >= a3), no arrays.
  let a1 = rng.d6();
  let a2 = 0;
  let a3 = 0;
  if (diceA >= 2) a2 = rng.d6();
  if (diceA >= 3) a3 = rng.d6();
  let t: number;
  if (a2 > a1) { t = a1; a1 = a2; a2 = t; }
  if (a3 > a2) { t = a2; a2 = a3; a3 = t; }
  if (a2 > a1) { t = a1; a1 = a2; a2 = t; }

  // Roll and sort defender dice descending (d1 >= d2).
  let d1 = rng.d6();
  let d2 = 0;
  if (diceD >= 2) d2 = rng.d6();
  if (d2 > d1) { t = d1; d1 = d2; d2 = t; }

  const attShift = mods.attackerBonus + qualityBonus(attacker);
  const defShift = mods.defenderBonus + mods.terrainBonus + mods.wallBonus + qualityBonus(defender);

  let attLoss = 0;
  let defLoss = 0;
  if (cc.defenderWinsTies) {
    if (a1 + attShift > d1 + defShift) defLoss++; else attLoss++;
    if (diceA >= 2 && diceD >= 2) {
      if (a2 + attShift > d2 + defShift) defLoss++; else attLoss++;
    }
  } else {
    if (a1 + attShift >= d1 + defShift) defLoss++; else attLoss++;
    if (diceA >= 2 && diceD >= 2) {
      if (a2 + attShift >= d2 + defShift) defLoss++; else attLoss++;
    }
  }

  removeCasualties(attacker, attLoss);
  removeCasualties(defender, defLoss);
  ROUND_LOSSES.attackerLosses = attLoss;
  ROUND_LOSSES.defenderLosses = defLoss;
  return ROUND_LOSSES;
}

// ------------------------------------------------------------ full battle

/**
 * Fight until destruction, attacker retreat, or the round cap.
 * MUTATES both armies in place; returns a fresh BattleResult (one small
 * allocation per battle, none per round).
 */
export function resolveBattle(
  attacker: Army,
  defender: Army,
  mods: CombatModifiers,
  rng: RNG,
  opts?: BattleOptions,
): BattleResult {
  const cc = CONFIG.combat;
  const maxRounds = opts?.maxRounds ?? cc.maxRounds;
  const retreatFraction = opts?.retreatFraction ?? cc.retreatFraction;

  const att0 = combatants(attacker);
  const def0 = combatants(defender);
  const retreatFloor = att0 * retreatFraction;

  let rounds = 0;
  while (rounds < maxRounds) {
    const nA = combatants(attacker);
    if (nA === 0 || nA <= retreatFloor) break;
    if (combatants(defender) === 0) break;
    resolveCombatRound(attacker, defender, mods, rng);
    rounds++;
  }

  const nA = combatants(attacker);
  const nD = combatants(defender);
  let winner: BattleResult['winner'];
  if (nD === 0 && nA > 0) {
    winner = 'attacker';
    defender.siegeEngine = 0; // engines captured/destroyed with the army
  } else if (nA === 0) {
    winner = 'defender';
    attacker.siegeEngine = 0;
  } else if (nA <= retreatFloor) {
    winner = 'defender'; // attacker withdrew
  } else {
    winner = 'stalemate'; // round cap reached, both sides stand
  }

  return {
    winner,
    rounds,
    attackerLosses: att0 - nA,
    defenderLosses: def0 - nD,
    attackerRemaining: nA,
    defenderRemaining: nD,
  };
}
