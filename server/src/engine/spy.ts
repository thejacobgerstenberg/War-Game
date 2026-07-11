/**
 * spy.ts — the espionage subsystem (stubbed).
 *
 * Owns §10.7: a spy mission costs 1 action + 3 gold and succeeds on a d6 roll
 * modified by the target's University / Byzantium resistance. On failure the
 * agent is captured (prestige penalty, target notified). Reads balance.SPY.
 * Derives RNG from state and writes the cursor back. Pure.
 */
import type { GameAction, GameState } from "@imperium/shared";

/**
 * Apply a SPY action: charge 3 gold, roll against the mission target number,
 * and on success apply the mission effect (peek Omen / view objective / incite
 * unrest) or on failure apply the capture prestige penalty. Pure.
 */
export function applySpy(state: GameState, action: GameAction): GameState {
  // TODO(spy): charge cost, roll (makeRng from state), apply effect or penalty.
  void action;
  return state;
}
