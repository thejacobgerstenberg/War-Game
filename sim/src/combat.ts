/**
 * THE core dice kernel. Every other module (siege, pacing, full game,
 * Monte-Carlo sweeps) resolves fights through resolveCombatRound /
 * resolveBattle. Hot path: NO allocation inside the round loop.
 *
 * Combat model = FINAL canon docs/GAME_DESIGN.md §7 at 2b42386 (documented
 * in RULES_MODEL.md):
 * - Every combatant unit rolls 1d6 per combat round and HITS on
 *     roll >= clamp(hitBase - CV - mods, thresholdMin, thresholdMax)
 *   with hitBase 7 and clamp [2, 6] (canon §7.1). CV is per unit type and
 *   side; player factions roll with their unique-unit tables
 *   (CONFIG.factionUnits via mods.attackerFaction / defenderFaction),
 *   neutrals with the base CONFIG.units table.
 * - Modifiers act in THRESHOLD space. Attacker mods = mods.attackerBonus
 *   (amphibious/strait -1, escalade -1) + outnumber bonus. Defender mods =
 *   mods.defenderBonus + mods.terrainBonus + mods.wallBonus + outnumber
 *   bonus. Outnumbering 2:1 in a round grants +1 (canon §7.3); gap-fill:
 *   no outnumber bonus while assaulting unbreached walls.
 * - Tactic cards (canon §7.7) enter as mods.*ExtraDice ("+N dice", rolled
 *   in the melee step at the side's best participating threshold) and
 *   mods.*Rerolls (missed dice rerolled, once each, at the same
 *   threshold); *FirstRoundOnly limits "one round of..." cards.
 * - While assaulting UNBREACHED walls (mods.wallBonus > 0) the attacker's
 *   siege engines roll at CV 0 + siegeEngineEscaladeBonus (canon §6.1
 *   "SIEGE +3 vs walls"); at field odds (breach) they are idle.
 * - Both sides roll SIMULTANEOUSLY; every hit removes one enemy unit,
 *   lowest-value first: levy, then professional, then mercenary, then
 *   galley (canon §4.4 value order — the merc slot is CAVALRY-grade).
 *   Siege engines never fight in the line and are destroyed if their army
 *   is wiped out. (No ARCHER slot, so canon's ranged pre-step (§7.2.1) is
 *   folded into unit CVs — see RULES_MODEL.md.)
 * - Rout (§7.5): after casualties, a side that has lost >= routLossFraction
 *   (50%) of its starting stack rolls 1d6 and routs on <= routOn (3).
 *   A routing side loses the battle; its survivors disperse (no retreat
 *   pathing in the kernel). Cavalry pursuit is unmodeled.
 *   Gap-fill: a garrison behind unbreached walls does not rout.
 * - resolveBattle loops rounds until a side is destroyed or routs, the
 *   attacker's combatants fall to/below retreatFraction of the starting
 *   force (voluntary withdrawal — counts as a defender win), or maxRounds
 *   pass (stalemate — e.g. a siege drags on). result.decisive marks a
 *   loser wiped or routed (canon §13.1 decisive-battle prestige).
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
  UnitType,
} from './types';
import { CONFIG, statsFor } from './rules';
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

/**
 * Remove n combatant casualties in canon value order (§4.4): levy,
 * professional, mercenary (CAVALRY-grade), galley. Returns how many were
 * actually removed.
 */
export function removeCasualties(a: Army, n: number): number {
  let r = n;
  let k = a.levy < r ? a.levy : r;
  a.levy -= k;
  r -= k;
  k = a.professional < r ? a.professional : r;
  a.professional -= k;
  r -= k;
  k = a.mercenary < r ? a.mercenary : r;
  a.mercenary -= k;
  r -= k;
  k = a.galley < r ? a.galley : r;
  a.galley -= k;
  r -= k;
  return n - r;
}

// -------------------------------------------------------------- thresholds

/**
 * Canon §7.1 hit threshold for a unit of combat value `cv` with `mods`
 * threshold-space modifiers helping it: clamp(7 - cv - mods, 2, 6).
 * The unit hits on a d6 roll >= the returned value.
 */
export function hitThreshold(cv: number, mods: number): number {
  const cc = CONFIG.combat;
  const t = cc.hitBase - cv - mods;
  return t < cc.thresholdMin ? cc.thresholdMin : t > cc.thresholdMax ? cc.thresholdMax : t;
}

/** Roll `count` d6 and count hits at `threshold`+ (no allocation). */
function rollHits(count: number, threshold: number, rng: RNG): number {
  let hits = 0;
  for (let i = 0; i < count; i++) if (rng.d6() >= threshold) hits++;
  return hits;
}

// -------------------------------------------------------------- modifiers

export const NO_MODIFIERS: Readonly<CombatModifiers> = {
  attackerBonus: 0,
  defenderBonus: 0,
  terrainBonus: 0,
  wallBonus: 0,
  attackerExtraDice: 0,
  defenderExtraDice: 0,
  attackerRerolls: 0,
  defenderRerolls: 0,
};

export function modifiers(partial: Partial<CombatModifiers>): CombatModifiers {
  return {
    attackerBonus: partial.attackerBonus ?? 0,
    defenderBonus: partial.defenderBonus ?? 0,
    terrainBonus: partial.terrainBonus ?? 0,
    wallBonus: partial.wallBonus ?? 0,
    attackerExtraDice: partial.attackerExtraDice ?? 0,
    defenderExtraDice: partial.defenderExtraDice ?? 0,
    attackerRerolls: partial.attackerRerolls ?? 0,
    defenderRerolls: partial.defenderRerolls ?? 0,
    attackerFirstRoundOnly: partial.attackerFirstRoundOnly,
    defenderFirstRoundOnly: partial.defenderFirstRoundOnly,
    attackerFaction: partial.attackerFaction,
    defenderFaction: partial.defenderFaction,
  };
}

/**
 * Defender threshold bonus contributed by walls, after siege damage.
 * Canon §7.3/§8: the bonus is BINARY — the full tier bonus while wall
 * hitpoints remain, zero once the wall is breached (damage >= hitpoints).
 * `theodosian` only adds the legacy extra-HP/bonus levers (0 = canon).
 */
export function effectiveWallBonus(
  wallTier: number,
  theodosian: boolean,
  wallDamage: number,
): number {
  if (wallTier <= 0) return 0;
  const w = CONFIG.walls;
  const hp = w.tierHitpoints[wallTier] + (theodosian ? w.theodosianExtraHitpoints : 0);
  if (wallDamage >= hp) return 0; // breached
  return w.tierBonus[wallTier] + (theodosian ? w.theodosianBonus : 0);
}

// ------------------------------------------------------------ round kernel

/** Reused result object — no allocation per round. Copy it if you keep it. */
const ROUND_LOSSES: RoundLosses = { attackerLosses: 0, defenderLosses: 0 };

const SIDE_UNIT_TYPES: readonly UnitType[] = ['levy', 'professional', 'mercenary', 'galley'];

/**
 * Resolve one round of dice (canon melee step: both sides simultaneous).
 * `battleRound` is 0-based (used by first-round-only card effects).
 * Mutates both armies (removes casualties). Returns the module-level reused
 * RoundLosses (see aliasing warning above).
 */
export function resolveCombatRound(
  attacker: Army,
  defender: Army,
  mods: CombatModifiers,
  rng: RNG,
  battleRound = 0,
): RoundLosses {
  ROUND_LOSSES.attackerLosses = 0;
  ROUND_LOSSES.defenderLosses = 0;

  const nAtt = combatants(attacker);
  const nDef = combatants(defender);
  if (nAtt === 0 || nDef === 0) return ROUND_LOSSES;

  const cc = CONFIG.combat;
  const aF = mods.attackerFaction ?? null;
  const dF = mods.defenderFaction ?? null;

  let attMods = mods.attackerBonus;
  let defMods = mods.defenderBonus + mods.terrainBonus + mods.wallBonus;
  // 2:1 outnumber bonus (canon §7.3); gap-fill: no numbers bonus while
  // assaulting unbreached walls (wallBonus > 0) unless configured otherwise.
  const outnumberApplies = mods.wallBonus <= 0 || cc.outnumberVsWalls;
  if (outnumberApplies) {
    if (nAtt >= cc.outnumberRatio * nDef) attMods += cc.outnumberBonus;
    else if (nDef >= cc.outnumberRatio * nAtt) defMods += cc.outnumberBonus;
  }

  // Attacker rolls (attack CVs), defender rolls (defense CVs) — simultaneous.
  let attHits = 0;
  let attDice = 0;
  let attBest = 7; // best (lowest) threshold among participating attacker units
  for (const t of SIDE_UNIT_TYPES) {
    const n = attacker[t];
    if (n === 0) continue;
    const th = hitThreshold(statsFor(aF, t).cvAttack, attMods);
    if (th < attBest) attBest = th;
    attHits += rollHits(n, th, rng);
    attDice += n;
  }
  // Canon §6.1: SIEGE "+3 vs walls" — engines roll while assaulting
  // UNBREACHED walls (escalade support); idle at field odds.
  if (mods.wallBonus > 0 && attacker.siegeEngine > 0) {
    const th = hitThreshold(cc.siegeEngineEscaladeBonus, attMods);
    attHits += rollHits(attacker.siegeEngine, th, rng);
    attDice += attacker.siegeEngine;
    if (th < attBest) attBest = th;
  }

  let defHits = 0;
  let defDice = 0;
  let defBest = 7;
  for (const t of SIDE_UNIT_TYPES) {
    const n = defender[t];
    if (n === 0) continue;
    const th = hitThreshold(statsFor(dF, t).cvDefense, defMods);
    if (th < defBest) defBest = th;
    defHits += rollHits(n, th, rng);
    defDice += n;
  }

  // Tactic-card layer (canon §7.7): "+N dice" at the side's best threshold,
  // then rerolls of missed dice (each die rerolled at most once).
  const attCardsLive = !mods.attackerFirstRoundOnly || battleRound === 0;
  const defCardsLive = !mods.defenderFirstRoundOnly || battleRound === 0;
  if (attCardsLive && mods.attackerExtraDice > 0) {
    attHits += rollHits(mods.attackerExtraDice, attBest, rng);
    attDice += mods.attackerExtraDice;
  }
  if (defCardsLive && mods.defenderExtraDice > 0) {
    defHits += rollHits(mods.defenderExtraDice, defBest, rng);
    defDice += mods.defenderExtraDice;
  }
  if (attCardsLive && mods.attackerRerolls > 0) {
    const misses = attDice - attHits;
    attHits += rollHits(misses < mods.attackerRerolls ? misses : mods.attackerRerolls, attBest, rng);
  }
  if (defCardsLive && mods.defenderRerolls > 0) {
    const misses = defDice - defHits;
    defHits += rollHits(misses < mods.defenderRerolls ? misses : mods.defenderRerolls, defBest, rng);
  }

  // Gap-fill (battlement cover): while the walls stand (wallBonus > 0), each
  // hit on the garrison is deflected on 1d6 <= wallCoverSaveOn.
  if (mods.wallBonus > 0 && cc.wallCoverSaveOn > 0 && attHits > 0) {
    let kept = 0;
    for (let i = 0; i < attHits; i++) if (rng.d6() > cc.wallCoverSaveOn) kept++;
    attHits = kept;
  }

  const attLoss = defHits < nAtt ? defHits : nAtt;
  const defLoss = attHits < nDef ? attHits : nDef;
  removeCasualties(attacker, attLoss);
  removeCasualties(defender, defLoss);
  ROUND_LOSSES.attackerLosses = attLoss;
  ROUND_LOSSES.defenderLosses = defLoss;
  return ROUND_LOSSES;
}

// ------------------------------------------------------------ full battle

/**
 * Fight until destruction, rout, attacker withdrawal, or the round cap.
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
  const attRoutAt = att0 * (1 - cc.routLossFraction); // rout check once at/below this
  const defRoutAt = def0 * (1 - cc.routLossFraction);

  let rounds = 0;
  let attRouted = false;
  let defRouted = false;
  while (rounds < maxRounds) {
    const nA = combatants(attacker);
    if (nA === 0 || nA <= retreatFloor) break;
    if (combatants(defender) === 0) break;
    resolveCombatRound(attacker, defender, mods, rng, rounds);
    rounds++;
    // Morale (canon §7.5): a side that lost >= 50% of its starting stack
    // rolls 1d6 each round; routs on <= 3. Checked simultaneously; if both
    // rout, the defender holds the field (attacker counts as repelled).
    // Gap-fill: a garrison behind UNBREACHED walls (wallBonus > 0) has
    // nowhere to flee and does not rout.
    const nA2 = combatants(attacker);
    const nD2 = combatants(defender);
    const defCanRout = mods.wallBonus <= 0 || cc.defenderRoutsBehindWalls;
    if (nA2 > 0 && nA2 <= attRoutAt && rng.d6() <= cc.routOn) attRouted = true;
    if (defCanRout && nD2 > 0 && nD2 <= defRoutAt && rng.d6() <= cc.routOn) defRouted = true;
    if (attRouted || defRouted) break;
  }

  const nA = combatants(attacker);
  const nD = combatants(defender);
  let winner: BattleResult['winner'];
  let decisive = false;
  if (attRouted || nA === 0 || nA <= retreatFloor) {
    winner = 'defender'; // attacker destroyed, routed, or withdrew
    decisive = attRouted || nA === 0; // withdrawal is NOT decisive (canon §13.1)
    if (nA === 0 || attRouted) attacker.siegeEngine = 0; // engines abandoned in the rout
  } else if (defRouted || nD === 0) {
    winner = 'attacker'; // defender destroyed or routed (survivors disperse)
    decisive = true;
    defender.siegeEngine = 0;
  } else {
    winner = 'stalemate'; // round cap reached, both sides stand
  }

  return {
    winner,
    decisive,
    rounds,
    attackerLosses: att0 - nA,
    defenderLosses: def0 - nD,
    attackerRemaining: nA,
    defenderRemaining: nD,
  };
}
