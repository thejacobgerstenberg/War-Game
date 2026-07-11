/**
 * Prestige display helpers shared by the Renown track (hud/ResourcePanel),
 * the advisor's "victory near" trigger (advisor/AdvisorBubble), and any
 * other seat that reasons about the victory threshold.
 *
 * DISPLAY MIRROR of server/src/engine/balance.ts PRESTIGE_THRESHOLDS (§13.2)
 * — the prestige a crown must reach to close the reckoning early, by seated
 * player count. The engine remains authoritative; re-mirror when rebalanced.
 *
 * NOTE (mockup adaptation): design/mockups/game.html callout 5 drew the
 * Renown track "nought to twenty", which predates the ratified §13.2
 * thresholds (72/78/80/80). The client keeps the mockup's 21-notch geometry
 * (so the gilded 5n+1 milestone rhythm in base.css still lands on notches
 * 5/10/15/20) but relabels the notches proportionally from nought to this
 * table's threshold.
 */
import type { GameState } from "@imperium/shared";

const PRESTIGE_THRESHOLD_BY_PLAYER_COUNT: Record<number, number> = {
  2: 72,
  3: 78,
  4: 80,
  5: 80,
};
const PRESTIGE_THRESHOLD_FALLBACK = 80;

/** The victory threshold for this table (by seated player count). */
export function prestigeThreshold(state: GameState): number {
  return (
    PRESTIGE_THRESHOLD_BY_PLAYER_COUNT[state.players.length] ??
    PRESTIGE_THRESHOLD_FALLBACK
  );
}

/**
 * The Renown track's segment count: 21 notches (0..TRACK_SEGMENTS), the
 * mockup's geometry, relabelled 0..threshold.
 */
export const TRACK_SEGMENTS = 20;

/** The prestige value notch `i` (0..TRACK_SEGMENTS) stands for. */
export function notchValue(i: number, threshold: number): number {
  if (i >= TRACK_SEGMENTS) return threshold;
  return Math.round((i * threshold) / TRACK_SEGMENTS);
}

/**
 * The notch a crest sits on: the last notch whose value the player has
 * reached (floor semantics — the marker never overstates renown), pinned to
 * the final notch once the threshold itself is met.
 */
export function notchForPrestige(prestige: number, threshold: number): number {
  for (let i = TRACK_SEGMENTS; i > 0; i--) {
    if (prestige >= notchValue(i, threshold)) return i;
  }
  return 0;
}
