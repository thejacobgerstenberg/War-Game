/**
 * events/index.ts — the Omen deck subsystem.
 *
 * Owns the Omen phase: drawing from the current era deck, reshuffling discards,
 * retiring decks on era change, and resolving each card's effect. Randomness is
 * derived from GameState via makeRng; the full draw/reshuffle/gathering-omen
 * plumbing is finalised by the events subsystem agent. Card data and per-card
 * effect functions live in ./cards.ts.
 */
import type { GameState } from "@imperium/shared";
import { makeRng } from "../rng.js";
import { EVENT_EFFECT_BY_ID, type EventEffectContext } from "./cards.js";

export * from "./cards.js";

/**
 * Draw (and resolve) this round's Omen(s). One shared card is drawn and
 * resolved per round; games with >= 4 players additionally reveal the next card
 * as a telegraphed "gathering omen" (see balance.OMEN_DRAW). Reshuffles the
 * discard pile when the active deck empties.
 *
 * Pure: derives its RNG from `state.rngSeed`/`state.rngCursor` and writes the
 * advanced cursor back into the returned state. Heavy plumbing (reshuffle,
 * gathering omen, era retirement) is finalised by the events subsystem agent;
 * this trivial wiring draws the front card and resolves it via the data table.
 */
export function drawOmen(state: GameState): GameState {
  if (state.omenDeck.length === 0) return state;
  const [cardId, ...rest] = state.omenDeck;
  const drawn: GameState = {
    ...state,
    omenDeck: rest,
    omenDiscard: [...state.omenDiscard, cardId],
  };
  return resolveCard(drawn, cardId);
}

/**
 * Apply a single Omen/tactic card's effect to the state.
 *
 * Pure: builds an RNG from `state.rngSeed`/`rngCursor`, dispatches to the card's
 * effect fn (from EVENT_EFFECT_BY_ID), and writes the advanced cursor back. The
 * drawing faction is taken as the active player. Consent/choice/target inputs
 * (for cards that need them) are left unset here and are supplied by the action
 * layer via PLAY_CARD; the events subsystem agent finalises that routing.
 */
export function resolveCard(state: GameState, cardId: string): GameState {
  const effect = EVENT_EFFECT_BY_ID[cardId];
  if (!effect) return state;
  const rng = makeRng(state.rngSeed, state.rngCursor);
  const activeId = state.turnOrder[state.activePlayerIndex] ?? null;
  const ctx: EventEffectContext = { drawerId: activeId, rng };
  const next = effect(state, ctx);
  return { ...next, rngCursor: rng.cursor };
}
