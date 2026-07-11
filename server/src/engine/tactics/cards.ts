/**
 * tactics/cards.ts — the tactic deck: data + deck construction (§7.7).
 *
 * PREP2 SCAFFOLDING ONLY. This file ships an EMPTY {@link TACTIC_CARDS} array plus
 * a real (data-driven) {@link buildTacticDeck} so the tree typechecks and
 * `createInitialState` can initialise `state.tacticDeck`. The tactic agent fills
 * `TACTIC_CARDS` with the 24 ratified designs (48 copies, incl. the rare
 * `master-founders-hired`; the `the-guns-of-orban` slug is retired) exactly from
 * the ratified GAME_DESIGN §7.7 table — WITHOUT changing these exports' shapes.
 *
 * Tactic slugs are their OWN keyspace ({@link TacticCardId}), distinct from event
 * slugs — build ids with {@link asTacticCardId} (e.g. `asTacticCardId("greek-fire")`).
 */
import type { TacticCard, TacticCardId } from "@imperium/shared";
import type { Rng } from "../rng.js";

/**
 * The 24 ratified tactic designs (48 copies). EMPTY placeholder — filled by the
 * tactic agent. Keep the {@link TacticCard} shape and `asTacticCardId` ids.
 */
export const TACTIC_CARDS: TacticCard[] = [];

/**
 * Build the tactic draw deck: expand each design into `copies` physical cards and
 * shuffle with the seeded RNG (§7.7 / §14). Pure — consumes the passed `rng`.
 * With the placeholder {@link TACTIC_CARDS} this returns `[]` (no cursor consumed).
 */
export function buildTacticDeck(rng: Rng): TacticCardId[] {
  const deck: TacticCardId[] = [];
  for (const card of TACTIC_CARDS) {
    for (let i = 0; i < card.copies; i += 1) deck.push(card.id);
  }
  return rng.shuffle(deck);
}
