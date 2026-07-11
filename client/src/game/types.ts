/**
 * Shared client-side game types + fog-of-war helpers.
 *
 * PROJECTION CONTRACT (what the server actually sends each client):
 *  - other players' objectives  -> same-length stubs
 *      { id: "hidden", description: "Sealed objective", provinceRefs: [], prestige: 0 }
 *  - other players' hand        -> { id: "hidden", name: "Hidden card", ... } stubs
 *  - other players' tacticHand  -> "hidden" ids
 *  - omenDeck / tacticDeck / eraDecksRemaining -> "hidden" placeholders (counts only)
 *  - rngSeed / rngCursor        -> zeroed
 *  - log entries whose data.visibleTo excludes you -> absent
 *  - pendingBattles             -> only YOUR side's committed tactic ids;
 *                                  the opponent's are "hidden" stubs
 * YOUR OWN hand/tacticHand/objectives arrive in full. Render "hidden"
 * entries face-down/sealed — never as empty or missing.
 */
import type { Card, TurnTimerPayload } from "@imperium/shared";

/** The sentinel id the projection substitutes for concealed cards/objectives. */
export const HIDDEN_ID = "hidden";

/** True for a projection-concealed id ("hidden" deck/hand/objective stubs). */
export function isHidden(id: string): boolean {
  return id === HIDDEN_ID;
}

/** True when a projected card is a face-down stub belonging to a rival. */
export function isHiddenCard(card: Pick<Card, "id">): boolean {
  return isHidden(card.id);
}

/** The active turn clock, as delivered by the server's turn_timer event. */
export type TimerState = Pick<
  TurnTimerPayload,
  "activePlayerId" | "deadline" | "turnSeconds"
>;

/**
 * The eight orders of the action bar (game.html callout 11). Exactly one is
 * armed at a time; arming an order sets the map's click-meaning. "yield"
 * (Yield the Floor) is not armable — it commits immediately via confirm.
 */
export type OrderKind =
  | "muster"     /* RECRUIT   */
  | "march"      /* MOVE      */
  | "raise"      /* BUILD     */
  | "traffic"    /* TRADE     */
  | "parley"     /* DIPLOMACY */
  | "whisper"    /* SPY       */
  | "stratagem"; /* PLAY_TACTIC / PLAY_CARD */

/**
 * A locally-requested overlay (the OverlayManager also opens overlays from
 * game state: pendingBattles -> combat, live merc auction -> auction,
 * winner -> victory; those need no intent).
 */
export type OverlayIntent =
  | { type: "build"; provinceId: string }
  | { type: "greatWorks"; provinceId?: string }
  | { type: "market" }
  | { type: "diplomacy"; targetPlayerId?: string }
  | { type: "spy"; targetPlayerId?: string };
