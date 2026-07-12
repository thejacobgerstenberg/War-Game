/**
 * Per-seat state projection for the offline build (spec §3).
 *
 * The engine has NO redaction (facts §3 — STATE_SNAPSHOT leaks everything), so
 * hidden-info discipline is enforced HERE, at the UI boundary: every GameState
 * the dispatcher hands to the UI passes through {@link projectStateForSeat}.
 *
 * Redactions (deck LENGTHS stay truthful, ids/secrets do not):
 *   - rngSeed / rngCursor            -> 0 (no peeking at future draws)
 *   - omenDeck                       -> HIDDEN_CARD_ID sentinels (same length)
 *   - eraDecksRemaining (each era)   -> HIDDEN_CARD_ID sentinels (same length)
 *   - tacticDeck                     -> HIDDEN_CARD_ID sentinels (same length)
 *   - rival players' hand / objectives / tacticHand -> emptied
 *   - omenDiscard / tacticDiscard / tacticRemoved   -> kept (public piles)
 *
 * Documented caveat: projected views lose rival hand-COUNTS (arrays emptied)
 * and deck ids are sentinels. The reused GameBoard renders neither, so nothing
 * breaks; any future hand-count UI extends this projection, not the engine.
 *
 * Pure: the input state is never mutated; the result is a structurally-shared
 * shallow clone (only redacted branches are copied).
 */
import type { GameState, Player, TacticCardId } from "@imperium/shared";
import { HIDDEN_CARD_ID } from "./types";

/** Same-length array of hidden-card sentinels. */
function hiddenIds(length: number): string[] {
  return new Array<string>(length).fill(HIDDEN_CARD_ID);
}

function projectPlayer(player: Player, seatId: string): Player {
  if (player.id === seatId) return player; // viewer sees their own secrets
  const redacted: Player = {
    ...player,
    hand: [],
    objectives: [],
  };
  // Optional field: only rewrite when present so fixtures stay shape-identical.
  if (player.tacticHand !== undefined) redacted.tacticHand = [];
  return redacted;
}

export function projectStateForSeat(state: GameState, seatId: string): GameState {
  const projected: GameState = {
    ...state,
    rngSeed: 0,
    rngCursor: 0,
    omenDeck: hiddenIds(state.omenDeck.length),
    players: state.players.map((p) => projectPlayer(p, seatId)),
  };

  // eraDecksRemaining: Partial<Record<1|2|3, string[]>> — redact each present era.
  const eras: GameState["eraDecksRemaining"] = {};
  for (const key of [1, 2, 3] as const) {
    const deck = state.eraDecksRemaining[key];
    if (deck !== undefined) eras[key] = hiddenIds(deck.length);
  }
  projected.eraDecksRemaining = eras;

  if (state.tacticDeck !== undefined) {
    // Sentinel ids are intentionally not real TacticCardIds; cast confined here (spec §3).
    projected.tacticDeck = hiddenIds(
      state.tacticDeck.length,
    ) as unknown as TacticCardId[];
  }

  return projected;
}
