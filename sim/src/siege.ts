/**
 * Multi-round siege model, FINAL canon docs/GAME_DESIGN.md §8 at 2b42386
 * (see RULES_MODEL.md "Walls & sieges").
 *
 * An attacker invests a walled province (walls T1-T5 per canon §8.1).
 * Each siege round:
 *   1. Bombardment — every siege engine rolls 1 wall-damage die
 *      (1-2 → 1 HP, 3-4 → 2 HP, 5-6 → 3 HP; canon §8.2.2), at most
 *      maxEffectiveEngines engines counting. T5 MASONRY (canon §8.3):
 *      against an intact tier-5 wall an ordinary train inflicts at most
 *      t5MasonryCapPerRound (1) HP per round IN TOTAL. The Great Bombard
 *      (canon §8.4) rolls greatBombard.damageDice (2) wall-damage dice AND
 *      lifts the T5 cap for the whole train — but only after a 1-siege-round
 *      EMPLACEMENT (errata E3): it deals no wall damage in siege round 1.
 *   2. Starvation — the city holds grainStoresRounds (3) stores; each fully
 *      invested round depletes one; at 0 the garrison loses
 *      starvationUnitsPerRound (1) unit per round, weakest first (canon
 *      §8.2.3). SEA RESUPPLY (canon §8.2.3): a coastal city depletes stores
 *      ONLY while every adjacent sea zone is enemy-controlled; otherwise
 *      stores refill and hunger never begins. The besieger loses
 *      besiegerAttritionPerRound to disease (sim divergence).
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
 * Tactic cards are NOT modeled at this module level (the full game plays
 * them); the module measures the raw wall/bombard/resupply mechanics.
 */

import type { Army, FactionId, Terrain } from './types';
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
  wallTier: number; // 0..5 (canon §8.1; 5 = Theodosian Walls)
  theodosian: boolean; // Constantinople flag (legacy extra-HP lever; T5 masonry comes from wallTier >= 5)
  terrain: Terrain; // defender terrain bonus applies on assault
  /**
   * The attacker owns the Great Bombard and brings it to this siege (E3: the
   * omen has been drawn — rounds 11-16 in the full game). Emplacement is
   * modeled: it fires only after greatBombard.emplacementRounds (1) full
   * siege rounds — no wall damage (and no masonry-cap lift) from it in siege
   * round 1.
   */
  hasGreatBombard: boolean;
  /**
   * Every adjacent sea zone is enemy-controlled (hostile fleet superiority).
   * Only meaningful for coastal cities; the full game computes this from
   * galley counts (see game.ts).
   */
  blockaded: boolean;
  /** City has a harbor: unblockaded => sea-resupplied, no starvation (canon §8.2.3). */
  coastal: boolean;
  /** Faction stat tables to roll with (undefined = base units). */
  attackerFaction?: FactionId | null;
  defenderFaction?: FactionId | null;
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

/** Total wall hitpoints for a tier 0..5 (+ legacy Theodosian extra). Canon §8.1. */
export function wallHitpoints(wallTier: number, theodosian: boolean): number {
  if (wallTier <= 0) return 0;
  const w = CONFIG.walls;
  return w.tierHitpoints[wallTier] + (theodosian ? w.theodosianExtraHitpoints : 0);
}

/**
 * Roll one siege round of bombardment damage (canon §8.2.2 dice).
 * `t5Masonry` (canon §8.3, wallTier >= 5): without the Great Bombard the
 * whole train inflicts at most t5MasonryCapPerRound HP; the Bombard rolls
 * damageDice wall-damage dice and lifts the cap for the entire train.
 */
export function rollBombardment(
  attacker: Army,
  hasGreatBombard: boolean,
  t5Masonry: boolean,
  rng: RNG,
): number {
  const s = CONFIG.siege;
  const engines = Math.min(attacker.siegeEngine, s.maxEffectiveEngines);
  let dmg = 0;
  for (let i = 0; i < engines; i++) dmg += s.engineDamageDie[rng.d6() - 1];
  if (t5Masonry && !hasGreatBombard && dmg > s.t5MasonryCapPerRound) dmg = s.t5MasonryCapPerRound;
  if (hasGreatBombard) {
    for (let i = 0; i < s.greatBombard.damageDice; i++) dmg += s.engineDamageDie[rng.d6() - 1];
  }
  return dmg;
}

/** Mean bombardment damage per round (for heuristics/reports, no dice). */
export function expectedBombardmentPerRound(attacker: Army, hasGreatBombard: boolean, t5Masonry: boolean): number {
  const s = CONFIG.siege;
  const engines = Math.min(attacker.siegeEngine, s.maxEffectiveEngines);
  const die = s.engineDamageDie;
  let dieMean = 0;
  for (const d of die) dieMean += d;
  dieMean /= die.length;
  let mean = dieMean * engines;
  if (t5Masonry && !hasGreatBombard && engines > 0) mean = Math.min(mean, s.t5MasonryCapPerRound);
  if (hasGreatBombard) mean += dieMean * s.greatBombard.damageDice;
  return mean;
}

/** Stochastically-rounded attrition: fraction of n, floor + chance(frac). */
function attritionLosses(n: number, fraction: number, rng: RNG): number {
  if (n <= 0 || fraction <= 0) return 0;
  const x = n * fraction;
  const lo = Math.floor(x);
  return lo + (rng.chance(x - lo) ? 1 : 0);
}

/** Remove starvation/attrition losses weakest-first (canon §8.2.3 / §4.4 value order). */
function applyAttrition(a: Army, losses: number): void {
  let r = losses;
  let k = Math.min(a.levy, r); a.levy -= k; r -= k;
  k = Math.min(a.professional, r); a.professional -= k; r -= k;
  k = Math.min(a.mercenary, r); a.mercenary -= k; r -= k;
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
  const t5Masonry = setup.wallTier >= 5;
  const terrainBonus = CONFIG.combat.terrain[setup.terrain];
  // Canon §8.2.3: an unblockaded coastal city is sea-resupplied — it never starves.
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
    // 1. bombardment. E3 emplacement: the Great Bombard is placed for
    //    emplacementRounds (1) full siege round(s) before it first fires.
    const bombardFires = setup.hasGreatBombard && round > s.greatBombard.emplacementRounds;
    wallDamage = Math.min(hp, wallDamage + rollBombardment(att, bombardFires, t5Masonry, rng));

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
        modifiers({
          attackerBonus: escalade,
          terrainBonus,
          wallBonus,
          attackerFaction: setup.attackerFaction,
          defenderFaction: setup.defenderFaction,
        }),
        rng,
      );
      if (result.winner === 'attacker') return finish(true, round, 'assault');
      if (combatants(att) <= 2) return finish(false, round, 'abandoned');
      // failed assault or stalemate: the siege grinds on
    }
  }

  return finish(false, policy.maxSiegeRounds, 'timeout');
}
