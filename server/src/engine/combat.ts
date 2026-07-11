/**
 * combat.ts — battle, siege and naval resolution subsystem (stubbed).
 *
 * Owns §7 (field combat), §8 (sieges) and §7.6 (naval). All dice come from the
 * {@link Rng} passed in by the caller (roundLoop), which owns cursor bookkeeping
 * so a whole COMBAT phase advances one shared RNG stream. Every modifier/table
 * is read from balance.ts. Pure: no mutation of the input state.
 */
import type { GameState, PendingBattle, SiegeState } from "@imperium/shared";
import type { Rng } from "./rng.js";

/** Per-side casualty tally, keyed by stack id. */
export interface CasualtyReport {
  /** Units removed per stack id. */
  losses: Record<string, number>;
  /** Stack ids that routed. */
  routed: string[];
}

/** Outcome of a resolved land or naval battle. */
export interface BattleResult {
  /** New state with casualties, ownership flips and log entries applied. */
  state: GameState;
  /** Winning player id, or null on mutual annihilation / stalemate. */
  winnerId: string | null;
  /** Number of combat rounds fought. */
  rounds: number;
  attacker: CasualtyReport;
  defender: CasualtyReport;
}

/** Outcome of a siege round or assault. */
export interface SiegeResult {
  state: GameState;
  /** True if the city was captured this resolution. */
  captured: boolean;
  /** Wall HP remaining after this resolution. */
  wallHpRemaining: number;
}

/**
 * Resolve a declared land battle (§7): ranged step, simultaneous melee,
 * casualties (lowest-value first), morale/rout, repeat. Applies terrain, walls,
 * charge, amphibious, escalade and outnumber modifiers from balance.COMBAT_MODS.
 */
export function resolveBattle(
  state: GameState,
  battle: PendingBattle,
  rng: Rng,
): BattleResult {
  // TODO(combat): implement the §7 round loop using rng.rollDice.
  void battle;
  void rng;
  return {
    state,
    winnerId: null,
    rounds: 0,
    attacker: { losses: {}, routed: [] },
    defender: { losses: {}, routed: [] },
  };
}

/**
 * Resolve one siege round or assault against a walled province (§8):
 * circumvallation, bombardment (SIEGE bombard table), garrison starvation, and
 * assault odds while walls stand (escalade / wall bonus). Pure.
 */
export function resolveSiege(
  state: GameState,
  siege: SiegeState,
  rng: Rng,
): SiegeResult {
  // TODO(combat): bombardment + starvation + assault per §8.
  void siege;
  void rng;
  return { state, captured: false, wallHpRemaining: 0 };
}

/**
 * Resolve a naval battle in a sea zone (§7.6): naval CVs, no terrain/walls,
 * winner controls the zone (enabling blockade) and may pursue. Pure.
 */
export function resolveNaval(
  state: GameState,
  battle: PendingBattle,
  rng: Rng,
): BattleResult {
  // TODO(combat): naval hit rules; transport cargo lost with the fleet.
  void battle;
  void rng;
  return {
    state,
    winnerId: null,
    rounds: 0,
    attacker: { losses: {}, routed: [] },
    defender: { losses: {}, routed: [] },
  };
}
