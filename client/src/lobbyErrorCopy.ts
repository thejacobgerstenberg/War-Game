/**
 * Pre-game (lobby-path) error copy, in voice.
 *
 * The server answers create/join/rejoin/pick_faction/start_game failures with
 * `error_msg { message }` — plain English with NO machine code (unlike the
 * in-game `action_rejected {reason, code?}`, which game/uiText.ts::
 * rejectionCopy maps by code). So this module maps the server's known message
 * TEXTS to the canonical lines of lore/ui-text.md §2 "Lobby & Matchmaking"
 * (plus §7 where it fits); anything unrecognised falls back to the server's
 * own text, mirroring rejectionCopy's documented fallback rule.
 *
 * Server message provenance (keep in sync if the server copy changes):
 *   - server/src/lobby/lobbyManager.ts  (LobbyError throws)
 *   - server/src/validate.ts            (payload guards)
 *   - server/src/index.ts               (emitError call sites)
 */

/* --------------------------------------------------------------------------
 * The lore lines (quoted VERBATIM — never invent copy where real copy exists).
 * ------------------------------------------------------------------------ */

/** lore/ui-text.md §2 Codes / joining — "(bad code)". */
const BAD_CODE = "No game answers to that seal.";
/** lore/ui-text.md §2 lobby toasts. */
const HOST_ONLY = "The host alone may open the campaign.";
/** lore/ui-text.md §2 waiting for players. */
const TABLE_NOT_FULL = "The table is not yet full. We wait upon latecomers.";
/** lore/ui-text.md §2 seat states — "Taken by another". */
const SEAT_TAKEN = "Claimed by another house.";
/** lore/ui-text.md §7 the table & connection (line 19). */
const TABLE_UNREACHABLE =
  "The herald cannot reach the table — the connection is lost.";

/* --------------------------------------------------------------------------
 * Composed lines. lore/ui-text.md has NO canonical line for these cases, so
 * each is built from established §2 diction ("thrones are filled" counts
 * pattern with its "(counts adjust)" licence; "Open the Campaign"; "take your
 * seat"; "latecomers"). Replace with canonical copy if lore ever adds it.
 * ------------------------------------------------------------------------ */

/** No lore line for a started game; composed from §2 "Open the Campaign" + "latecomers". */
const ALREADY_STARTED =
  "That campaign is already opened. The table admits no latecomers.";
/** §2 thrones-count pattern ("counts adjust") at its maximum: the game is full. */
const TABLE_FULL = "Five thrones are filled. None sits empty.";
/** No lore line for a duplicate claimant name; composed, keeping the server's rejoin advice. */
const NAME_TAKEN =
  "Another claimant already bears that name at this table. If you were parted from the game, rejoin from the tab where you first took your seat.";
/** No lore line for an unreadable request; composed from §2 herald diction. */
const ILL_WRIT = "The herald could not read that summons. Try once more.";

/* --------------------------------------------------------------------------
 * Server-message -> lore-line mapping.
 * ------------------------------------------------------------------------ */

/** Fixed server messages, matched exactly. */
const EXACT: Readonly<Record<string, string>> = {
  // validate.ts — room-code guards (a code that cannot name a game is a bad code).
  "A room code is required.": BAD_CODE,
  "Room codes are exactly 6 letters or digits.": BAD_CODE,
  // lobbyManager.ts:290
  "Only the host can start the game.": HOST_ONLY,
  // lobbyManager.ts:199
  "That game has already started.": ALREADY_STARTED,
  // lobbyManager.ts:165 — create_game refused during graceful shutdown.
  "Server restarting, retry shortly.": TABLE_UNREACHABLE,
  // validate.ts — malformed envelopes (unreachable from this client, but the
  // wire is hostile territory and these MUST never surface in raw English).
  "Malformed create_game payload.": ILL_WRIT,
  "Malformed join_game payload.": ILL_WRIT,
  "Malformed rejoin_game payload.": ILL_WRIT,
  "Malformed pick_faction payload.": ILL_WRIT,
};

/** Server messages that interpolate values, matched by pattern. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // lobbyManager.ts:197/235/263/285 — `No game found with code ${roomCode}.`
  [/^No game found with code /, BAD_CODE],
  // lobbyManager.ts:293 — `At least ${MIN_PLAYERS_TO_START} players are required to start.`
  [/^At least \d+ players are required to start\.$/, TABLE_NOT_FULL],
  // lobbyManager.ts:209 — `That game is full (max ${MAX_PLAYERS} players).`
  [/^That game is full /, TABLE_FULL],
  // lobbyManager.ts:272 — `${faction} has already been chosen.`
  [/ has already been chosen\.$/, SEAT_TAKEN],
  // lobbyManager.ts:204 — `That name is already taken in this game. …`
  [/^That name is already taken in this game\./, NAME_TAKEN],
];

/**
 * error_msg -> the line the pre-game screens show. Unknown messages (session
 * token / not-seated desyncs, "Unexpected server error.") pass through
 * verbatim, exactly as rejectionCopy falls back to the server's reason.
 */
export function lobbyErrorCopy(message: string): string {
  const exact = EXACT[message];
  if (exact !== undefined) return exact;
  for (const [pattern, line] of PATTERNS) {
    if (pattern.test(message)) return line;
  }
  return message;
}
