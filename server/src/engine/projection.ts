/**
 * Fog-of-war state projection (docs/ARCHITECTURE.md §4.3, §5.3).
 *
 * The server holds ONE authoritative {@link GameState} per room, but a client
 * must never receive another player's secrets, the undrawn ordering of the
 * decks, or the RNG bookkeeping that reconstructs both. {@link projectStateFor}
 * is a PURE transform: given the full state and the id of the player the view is
 * FOR, it returns a new `GameState` that is safe to serialise to that one
 * client. It never mutates its input — public, unredacted structures are shared
 * by reference (the projection is written to the wire immediately and never
 * mutated), so it is a deep-safe *read* view.
 *
 * ## Redaction shape (what a non-owner / everyone sees)
 *
 * For every player that is NOT `playerId`:
 *   - `objectives` → an array of the SAME length whose every entry is the
 *     placeholder `{ id: "hidden", description: "Sealed objective",
 *     provinceRefs: [], prestige: 0 }`. The client renders "N sealed
 *     objectives" from the length; no predicate/progress leaks.
 *   - `hand` → an array of the SAME length of identical back-only cards
 *     `{ id: "hidden", name: "Hidden card", description: "", cost: {} }`
 *     (hand size — the array length — is public; card identities are not).
 *   - `tacticHand` → an array of the SAME length of the redacted tactic id
 *     `"hidden"` (count public, identities hidden); left `undefined` if the
 *     source seat had none.
 *
 * For EVERY client (including the owner — nobody may peek the next draw), the
 * undrawn DECK ORDERINGS are flattened to counts:
 *   - `omenDeck` → array of `"hidden"` of the same length (count preserved).
 *   - `eraDecksRemaining` → each present era's array flattened the same way.
 *   - `tacticDeck` → array of the redacted tactic id `"hidden"`, same length.
 * Discards / removed piles (`omenDiscard`, `tacticDiscard`, `tacticRemoved`)
 * are already-revealed public information and pass through untouched.
 *
 * Also redacted for EVERYONE (these reconstruct hidden info the redactions above
 * are meant to protect — ARCHITECTURE §4.3, "a tampered client cannot forge a
 * dice result or peek at a secret objective"):
 *   - `rngSeed` / `rngCursor` → flattened to `0`. The seed re-derives the ENTIRE
 *     shuffle (omenDeck THEN tacticDeck), and `(seed, cursor)` pre-computes every
 *     upcoming combat/spy/merc/revolt roll — so shipping either defeats the deck
 *     redaction above and forges dice. The `seed` embedded in the `game_start`
 *     log entry's `data` is scrubbed for the same reason (see {@link projectLog}).
 *
 * Per-seat (actor-scoped) redactions:
 *   - `log` → entries flagged with a `data.visibleTo` whitelist (actor-only spy
 *     intel — a rival's secret objective text, the next Omen card) are delivered
 *     ONLY to the listed seats; every other seat's chronicle omits them entirely.
 *   - `pendingBattles[*].attackerTactics` / `defenderTactics` → a belligerent
 *     sees only its OWN committed tactic ids; the opposing side's committed
 *     tactics are flattened to same-length `"hidden"` stubs (count public,
 *     identities hidden), so a rival cannot counter a tactic committed but not
 *     yet revealed. Non-participants see both sides hidden.
 *
 * The requesting player's OWN `objectives` / `hand` / `tacticHand` are fully
 * present. All other public info (provinces, armies, fleets, prestige, treasury,
 * wars, mercMarket, minors, siege/board state) is preserved intact for everyone.
 */
import {
  asTacticCardId,
  type Card,
  type GameLogEntry,
  type GameState,
  type PendingBattle,
  type Player,
  type SecretObjective,
  type TacticCardId,
} from "@imperium/shared";

/** The single redacted-objective placeholder (cloned per slot so nothing is shared-mutable). */
const HIDDEN_OBJECTIVE: SecretObjective = {
  id: "hidden",
  description: "Sealed objective",
  provinceRefs: [],
  prestige: 0,
};

/** The single back-only card placeholder (cloned per slot). */
const HIDDEN_CARD: Card = {
  id: "hidden",
  name: "Hidden card",
  description: "",
  cost: {},
};

/** Redacted deck token for the Omen/event decks (a plain, immutable string). */
const HIDDEN_OMEN_CARD = "hidden";

/** Redacted deck token for the tactic decks (branded, immutable string). */
const HIDDEN_TACTIC_CARD: TacticCardId = asTacticCardId("hidden");

/**
 * Neutral value substituted for `rngSeed` / `rngCursor` on every projection.
 * The real values reconstruct the deck shuffle and every future roll, so they
 * NEVER reach a client (ARCHITECTURE §4.3); the authoritative state keeps them.
 */
const REDACTED_RNG = 0;

/** Redact one non-owner player's hidden holdings, preserving all public fields. */
function redactPlayer(player: Player): Player {
  return {
    ...player,
    objectives: player.objectives.map(() => ({ ...HIDDEN_OBJECTIVE })),
    hand: player.hand.map(() => ({ ...HIDDEN_CARD })),
    tacticHand:
      player.tacticHand === undefined
        ? undefined
        : player.tacticHand.map(() => HIDDEN_TACTIC_CARD),
  };
}

/** Flatten every present era's undrawn deck to a same-length hidden stack. */
function redactEraDecks(
  decks: GameState["eraDecksRemaining"],
): GameState["eraDecksRemaining"] {
  const out: GameState["eraDecksRemaining"] = {};
  for (const key of Object.keys(decks) as `${1 | 2 | 3}`[]) {
    const era = Number(key) as 1 | 2 | 3;
    const cards = decks[era];
    if (cards) out[era] = cards.map(() => HIDDEN_OMEN_CARD);
  }
  return out;
}

/**
 * Redact a pending battle's committed tactic ids for the seat `playerId`.
 * The attacker keeps its own `attackerTactics`, the defender keeps its own
 * `defenderTactics`; the opposing (or a spectator's) view flattens the array to
 * same-length `"hidden"` stubs so a committed-but-unrevealed tactic cannot be
 * countered. Returns the input battle by reference when nothing needs hiding.
 */
function redactBattleTactics(
  battle: PendingBattle,
  playerId: string,
): PendingBattle {
  const atk = battle.attackerTactics;
  const def = battle.defenderTactics;
  const hideAtk = battle.attackerId !== playerId && atk !== undefined;
  const hideDef = battle.defenderId !== playerId && def !== undefined;
  if (!hideAtk && !hideDef) return battle;
  const next: PendingBattle = { ...battle };
  if (hideAtk && atk) next.attackerTactics = atk.map(() => HIDDEN_TACTIC_CARD);
  if (hideDef && def) next.defenderTactics = def.map(() => HIDDEN_TACTIC_CARD);
  return next;
}

/**
 * True when a log entry is visible to `playerId`. An entry restricted with a
 * `data.visibleTo` whitelist (actor-scoped spy intel and any other secret entry)
 * is delivered ONLY to the listed seats; unflagged entries are public.
 */
function isLogEntryVisibleTo(entry: GameLogEntry, playerId: string): boolean {
  const visibleTo = entry.data?.visibleTo;
  if (Array.isArray(visibleTo)) return visibleTo.includes(playerId);
  return true;
}

/**
 * Strip wire-forbidden fields from a (visible) log entry's `data` — currently
 * the RNG `seed` the engine records on the `game_start` entry, which would let a
 * client re-derive every shuffle and roll. Returns the entry by reference when
 * there is nothing to scrub (so unaffected entries stay shared, not cloned).
 */
function scrubLogEntry(entry: GameLogEntry): GameLogEntry {
  if (entry.data && "seed" in entry.data) {
    const data = { ...entry.data };
    delete data.seed;
    return { ...entry, data };
  }
  return entry;
}

/**
 * Project the chronicle for `playerId`: drop entries not visible to this seat
 * (actor-scoped secrets) and scrub the seed from those that remain. Pure — the
 * source entries are shared by reference unless they must be rewritten.
 */
function projectLog(log: GameLogEntry[], playerId: string): GameLogEntry[] {
  const out: GameLogEntry[] = [];
  for (const entry of log) {
    if (!isLogEntryVisibleTo(entry, playerId)) continue;
    out.push(scrubLogEntry(entry));
  }
  return out;
}

/**
 * Project `state` into the fog-of-war view that is safe to send to `playerId`.
 * Pure: the input state is never mutated. See the module doc for the exact
 * redaction shape.
 */
export function projectStateFor(state: GameState, playerId: string): GameState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? p : redactPlayer(p),
    ),
    // Undrawn deck ORDERING is hidden from everyone (nobody peeks the next draw).
    omenDeck: state.omenDeck.map(() => HIDDEN_OMEN_CARD),
    eraDecksRemaining: redactEraDecks(state.eraDecksRemaining),
    ...(state.tacticDeck === undefined
      ? {}
      : { tacticDeck: state.tacticDeck.map(() => HIDDEN_TACTIC_CARD) }),
    // Committed-but-unrevealed tactics: each seat sees only its own side's ids.
    pendingBattles: state.pendingBattles.map((b) =>
      redactBattleTactics(b, playerId),
    ),
    // The RNG seed/cursor reconstruct the deck shuffle AND every upcoming roll,
    // so they never reach a client — neither the top-level fields nor the seed
    // the game_start entry embeds in the (per-seat filtered) log.
    rngSeed: REDACTED_RNG,
    rngCursor: REDACTED_RNG,
    log: projectLog(state.log, playerId),
  };
}
