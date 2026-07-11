/**
 * diplomacy.ts — treaties, vassalage and revolts subsystem (stubbed).
 *
 * Owns §11 (alliances, NAPs, tribute, royal marriage, betrayal penalties),
 * §11.5 (vassalize an NPC minor, vassal benefits) and revolt resolution.
 * Constants come from balance.VASSAL / PRESTIGE_VALUES. Phase-level functions
 * derive their RNG from GameState; the reducer-dispatched functions do not roll.
 * Pure throughout.
 */
import type { GameAction, GameState } from "@imperium/shared";

/**
 * Apply a DIPLOMACY action (§11): propose/accept/renounce a treaty, set up
 * tribute or a royal marriage. Renouncing an ALLIANCE/MARRIAGE applies the
 * betrayal prestige penalty and increments the actor's betrayal count. Pure.
 */
export function applyDiplomacy(state: GameState, action: GameAction): GameState {
  // TODO(diplomacy): mutate player.treaties + prestige per §11.
  void action;
  return state;
}

/**
 * Apply a VASSALIZE action (§11.5): pay the bribe (8 + 4×garrison), roll
 * 1d6 + prestige-tier − garrison-tier vs VASSAL.rollTarget, and on success bind
 * the minor as a vassal. Half-refund on failure. Derives RNG from state. Pure.
 */
export function applyVassalize(state: GameState, action: GameAction): GameState {
  // TODO(diplomacy): bribe, roll (makeRng from state), bind/return refund.
  void action;
  return state;
}

/**
 * Resolve pending revolts (§4.2 over-tax, §11.5 vassal revolts): roll each at
 * the appropriate threshold, flip revolting provinces to neutral / free vassals,
 * and log. Derives RNG from state and writes the cursor back. Pure.
 */
export function runRevolts(state: GameState): GameState {
  // TODO(diplomacy): heavy-tax and vassal revolt checks.
  return state;
}
