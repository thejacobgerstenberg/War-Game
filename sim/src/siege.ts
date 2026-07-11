/**
 * Multi-round siege model, canon docs/GAME_DESIGN.md §8 (see RULES_MODEL.md
 * "Walls & sieges").
 *
 * An attacker invests a walled province. Each siege round:
 *   1. Bombardment — every siege engine rolls 1d6 of wall damage
 *      (1-2 → 1 HP, 3-4 → 2 HP, 5-6 → 3 HP; canon §8.2.2), at most
 *      maxEffectiveEngines engines counting. Ordinary engines vs
 *      Theodosian-class walls deal damage × theodosianEngineDamageMult
 *      (0 by default — ruling R2: only the Great Bombard cracks them).
 *      The Great Bombard adds a flat greatBombard.damagePerRound.
 *   2. Starvation — a blockaded (or landlocked) city depletes 1 grain store
 *      per round; once stores hit 0 the garrison loses
 *      starvationUnitsPerRound units per round, weakest first (canon
 *      §8.2.3). SEA RESUPPLY (ruling R3): a coastal city that is NOT fully
 *      blockaded refills its stores every round and never starves.
 *      The besieger loses besiegerAttritionPerRound to disease (sim
 *      divergence; canon has no besieger attrition).
 *   3. Assault decision — per the policy, the attacker either assaults
 *      (a full dice battle through combat.ts resolveBattle, with the wall
 *      bonus — full while unbreached, 0 after breach — plus terrain on the
 *      defender and the escalade penalty on the attacker while walls stand)
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
  theodosian: boolean; // Constantinople's Theodosian Walls (tier-3 flag)
  terrain: Terrain; // defender terrain bonus applies on assault
  hasGreatBombard: boolean; // assumes game round >= greatBombard.availableFromRound
  /**
   * Every adjacent sea zone is enemy-controlled (hostile fleet superiority).
   * Only meaningful for coastal cities; the full game computes this from
   * galley counts (see game.ts).
   */
  blockaded: boolean;
  /** City has a harbor: unblockaded => sea-resupplied, no starvation (R3). */
  coastal: boolean;
}

export interface SiegePolicy {
  /** Assault once the effective wall bonus has fallen to <= this (walls are binary: full tier bonus or 0 at breach). */
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

/** Total wall hitpoints for a tier (+ Theodosian extra). Canon §8.1. */
export function wallHitpoints(wallTier: number, theodosian: boolean): number {
  if (wallTier <= 0) return 0;
  const w = CONFIG.walls;
  return w.tierHitpoints[wallTier] + (theodosian ? w.theodosianExtraHitpoints : 0);
}

/**
 * Roll one siege round of bombardment damage (canon §8.2.2 dice).
 * Theodosian-class walls resist ordinary engines (theodosianEngineDamageMult);
 * the Great Bombard's flat damage ignores that resistance.
 */
export function rollBombardment(
  attacker: Army,
  hasGreatBombard: boolean,
  theodosian: boolean,
  rng: RNG,
): number {
  const s = CONFIG.siege;
  const engines = Math.min(attacker.siegeEngine, s.maxEffectiveEngines);
  let dmg = 0;
  for (let i = 0; i < engines; i++) dmg += s.engineDamageDie[rng.d6() - 1];
  if (theodosian) dmg *= s.theodosianEngineDamageMult;
  if (hasGreatBombard) dmg += s.greatBombard.damagePerRound;
  return dmg;
}

/** Mean bombardment damage per round (for heuristics/reports, no dice). */
export function expectedBombardmentPerRound(attacker: Army, hasGreatBombard: boolean, theodosian: boolean): number {
  const s = CONFIG.siege;
  const engines = Math.min(attacker.siegeEngine, s.maxEffectiveEngines);
  const die = s.engineDamageDie;
  let mean = 0;
  for (const d of die) mean += d;
  mean = (mean / die.length) * engines;
  if (theodosian) mean *= s.theodosianEngineDamageMult;
  return mean + (hasGreatBombard ? s.greatBombard.damagePerRound : 0);
}

/** Stochastically-rounded attrition: fraction of n, floor + chance(frac). */
function attritionLosses(n: number, fraction: number, rng: RNG): number {
  if (n <= 0 || fraction <= 0) return 0;
  const x = n * fraction;
  const lo = Math.floor(x);
  return lo + (rng.chance(x - lo) ? 1 : 0);
}

/** Remove starvation/attrition losses weakest-first (canon §8.2.3). */
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
  // R3: an unblockaded coastal city is sea-resupplied — it never starves.
  const canStarve = !(s.seaResupplyEnabled && setup.coastal && !setup.blockaded);

  let wallDamage = 0;
  let stores = s.grainStoresRounds;
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
    wallDamage = Math.min(hp, wallDamage + rollBombardment(att, setup.hasGreatBombard, setup.theodosian, rng));

    // 2. starvation & disease
    if (canStarve) {
      if (stores > 0) stores--;
      else applyAttrition(def, s.starvationUnitsPerRound);
    }
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
      const escalade = wallDamage < hp ? -s.escaladePenalty : 0; // canon §8.2.4
      const result = resolveBattle(
        att,
        def,
        modifiers({ attackerBonus: escalade, terrainBonus, wallBonus }),
        rng,
      );
      if (result.winner === 'attacker') return finish(true, round, 'assault');
      if (combatants(att) <= 2) return finish(false, round, 'abandoned');
      // failed assault or stalemate: the siege grinds on
    }
  }

  return finish(false, policy.maxSiegeRounds, 'timeout');
}
