/**
 * prestige.ts — prestige scoring and victory checks (stubbed).
 *
 * Owns §13: per-round prestige accrual (capitals, key cities, monopolies,
 * marriages, vassals), one-time awards (great works, wars, objectives), and the
 * victory threshold / sudden-death / round-16 endgame checks. Reads
 * balance.PRESTIGE_VALUES / PRESTIGE_THRESHOLDS. Pure.
 */
import { Faction, type GameState } from "@imperium/shared";

/**
 * Accrue per-round prestige for every player at cleanup (§13.1) and record
 * prestige_change log entries. Does not itself declare a winner. Pure.
 */
export function scorePrestige(state: GameState): GameState {
  // TODO(prestige): sum §13.1 sources into each player.prestige.
  return state;
}

/**
 * Check for a winner (§13.2/§13.3): prestige threshold by player count, the
 * Constantinople sudden-death hold, or highest prestige at round 16. Returns the
 * winning faction or null if the game continues. Read-only.
 */
export function checkVictory(state: GameState): Faction | null {
  // TODO(prestige): threshold + sudden-death + round-16 tiebreaks.
  void Faction;
  void state;
  return null;
}
