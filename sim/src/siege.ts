/**
 * Multi-round siege model (see RULES_MODEL.md "Walls & sieges").
 *
 * An attacker invests a walled province. Each siege round:
 *   1. Bombardment — every siege engine removes engineDamagePerRound wall
 *      hitpoints (at most maxEffectiveEngines engines count); the Great
 *      Bombard adds greatBombard.damagePerRound on top.
 *   2. Attrition — the garrison starves at garrisonAttritionPerRound
 *      (doubled when fully sea-blockaded); the besieger loses
 *      besiegerAttritionPerRound to disease. Fractions are rounded
 *      stochastically through the seeded RNG.
 *   3. Assault decision — per the policy, the attacker either assaults
 *      (a full dice battle through combat.ts resolveBattle, with the
 *      CURRENT effective wall bonus + terrain on the defender's dice)
 *      or maintains the siege for another round.
 *
 * The siege ends with capture (assault won, or garrison starved to zero),
 * abandonment (besieger reduced to nothing useful), or timeout.
 *
 * All dice go through the shared combat kernel; nothing is reimplemented.
 */

import type { Army, Terrain } from './types';
import type { RNG } from './rng';
import { CONFIG } from './rules';
import {
  combatants,
  copyArmy,
  effectiveWallBonus,
  modifiers,
  resolveBattle,
} from './combat';

// ------------------------------------------------------------------- types

export interface SiegeSetup {
  /** Besieging army (siegeEngine count drives bombardment). Not mutated. */
  attacker: Army;
  /** Garrison inside the walls. Not mutated. */
  defender: Army;
  wallTier: number; // 0..3
  theodosian: boolean; // Constantinople's Theodosian Walls
  terrain: Terrain; // defender terrain bonus applies on assault
  hasGreatBombard: boolean; // assumes game round >= greatBombard.availableFromRound
  blockaded: boolean; // every coast blockaded => garrison attrition doubled
  /** Constantinople's Golden Horn: unblockaded garrison is sea-resupplied (attrition halved). */
  seaResupplied?: boolean;
}

export interface SiegePolicy {
  /** Assault once the effective wall bonus has been battered to <= this. */
  assaultWallThreshold: number;
  /** ...or once starvation has thinned the garrison to <= this many combatants. */
  assaultGarrisonMax: number;
  /** Give up (timeout) after this many siege rounds. */
  maxSiegeRounds: number;
}

export const DEFAULT_SIEGE_POLICY: Readonly<SiegePolicy> = {
  assaultWallThreshold: 1.0,
  assaultGarrisonMax: 2,
  maxSiegeRounds: 12,
};

export type SiegeEndReason = 'assault' | 'starvation' | 'abandoned' | 'timeout';

export interface SiegeOutcome {
  captured: boolean;
  /** Siege rounds elapsed when the siege ended (capture round if captured). */
  rounds: number;
  reason: SiegeEndReason;
  assaults: number; // assault attempts made
  wallDamage: number; // total wall hitpoints removed
  attackerRemaining: number; // surviving attacker combatants
  defenderRemaining: number; // surviving defender combatants
  attackerLosses: number; // combatant losses (attrition + assaults)
  defenderLosses: number;
}

// ----------------------------------------------------------------- helpers

/** Total wall hitpoints for a tier (+ Theodosian extra). */
export function wallHitpoints(wallTier: number, theodosian: boolean): number {
  if (wallTier <= 0) return 0;
  const w = CONFIG.walls;
  return wallTier * w.hitpointsPerTier + (theodosian ? w.theodosianExtraHitpoints : 0);
}

/** Wall damage dealt per siege round by this attacker. */
export function bombardmentPerRound(attacker: Army, hasGreatBombard: boolean): number {
  const s = CONFIG.siege;
  const engines = Math.min(attacker.siegeEngine, s.maxEffectiveEngines);
  return engines * s.engineDamagePerRound + (hasGreatBombard ? s.greatBombard.damagePerRound : 0);
}

/** Stochastically-rounded attrition: fraction of n, floor + chance(frac). */
function attritionLosses(n: number, fraction: number, rng: RNG): number {
  if (n <= 0 || fraction <= 0) return 0;
  const x = n * fraction;
  const lo = Math.floor(x);
  return lo + (rng.chance(x - lo) ? 1 : 0);
}

/** Remove attrition losses cheapest-first (same order as combat casualties). */
function applyAttrition(a: Army, losses: number): void {
  let r = losses;
  let k = Math.min(a.levy, r); a.levy -= k; r -= k;
  k = Math.min(a.mercenary, r); a.mercenary -= k; r -= k;
  k = Math.min(a.professional, r); a.professional -= k; r -= k;
  k = Math.min(a.galley, r); a.galley -= k; r -= k;
}

// -------------------------------------------------------------- siege loop

/**
 * Run one full siege to its conclusion. Copies both armies (the setup's
 * armies are never mutated). All randomness flows through `rng`.
 */
export function runSiege(
  setup: SiegeSetup,
  policy: SiegePolicy = DEFAULT_SIEGE_POLICY,
  rng: RNG,
): SiegeOutcome {
  const s = CONFIG.siege;
  const att = copyArmy(setup.attacker);
  const def = copyArmy(setup.defender);
  const att0 = combatants(att);
  const def0 = combatants(def);
  const hp = wallHitpoints(setup.wallTier, setup.theodosian);
  const terrainBonus = CONFIG.combat.terrain[setup.terrain];
  const garrisonAttrition =
    s.garrisonAttritionPerRound *
    (setup.blockaded && s.seaBlockadeDoublesAttrition
      ? 2
      : setup.seaResupplied && !setup.blockaded
        ? s.cpleSeaResupplyAttritionMult
        : 1);

  let wallDamage = 0;
  let assaults = 0;

  const finish = (captured: boolean, rounds: number, reason: SiegeEndReason): SiegeOutcome => ({
    captured,
    rounds,
    reason,
    assaults,
    wallDamage,
    attackerRemaining: combatants(att),
    defenderRemaining: combatants(def),
    attackerLosses: att0 - combatants(att),
    defenderLosses: def0 - combatants(def),
  });

  for (let round = 1; round <= policy.maxSiegeRounds; round++) {
    // 1. bombardment
    wallDamage = Math.min(hp, wallDamage + bombardmentPerRound(att, setup.hasGreatBombard));

    // 2. attrition
    applyAttrition(def, attritionLosses(combatants(def), garrisonAttrition, rng));
    applyAttrition(att, attritionLosses(combatants(att), s.besiegerAttritionPerRound, rng));
    if (combatants(def) === 0) return finish(true, round, 'starvation');
    if (combatants(att) <= 2) return finish(false, round, 'abandoned');

    // 3. assault or maintain (assault allowed anytime per CONFIG)
    const wallBonus = effectiveWallBonus(setup.wallTier, setup.theodosian, wallDamage);
    const wantAssault =
      s.assaultAllowedAnytime &&
      (wallBonus <= policy.assaultWallThreshold ||
        combatants(def) <= policy.assaultGarrisonMax);
    if (wantAssault) {
      assaults++;
      const result = resolveBattle(att, def, modifiers({ terrainBonus, wallBonus }), rng);
      if (result.winner === 'attacker') return finish(true, round, 'assault');
      if (combatants(att) <= 2) return finish(false, round, 'abandoned');
      // failed assault or stalemate: the siege grinds on
    }
  }

  return finish(false, policy.maxSiegeRounds, 'timeout');
}
