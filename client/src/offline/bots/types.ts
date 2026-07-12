/**
 * VENDORED from server/src/bots/types.ts @ 9009d5262afd983392c565e1d5e51bbdf31da92b
 * (PR #27 "Server: AI opponents", branch feature/ai-opponents — not on main yet).
 * Local changes: (1) engine imports rewritten to the offline engine shim;
 * (2) `.coastal` -> `.port` (main #28 renamed Province.coastal to Province.port);
 * (3) nothing else. Do not add logic here; upstream replaces this after #27 merges.
 */
/**
 * AI-opponent core contracts.
 *
 * A bot is: a seat (lobby-level, see `../lobby/botSeats.ts`) + a
 * {@link Policy} (pure decision function) + a `BotPlayer` driver
 * (`./botPlayer.ts`) that submits the policy's choices through the SAME
 * validated reducer path (`applyAction`) the socket layer uses. Bots never
 * mutate `GameState` directly and never reach into engine internals.
 *
 * FAIR-PLAY CONTRACT (no redaction layer exists yet — STATE_SNAPSHOT is the
 * whole state): a Policy receives the full authoritative {@link GameState}
 * but MUST self-restrict to information a human player at the table could
 * see. Concretely, a policy must not read:
 *   - other players' `hand` / `tacticHand` CONTENTS (lengths are public),
 *   - other players' `objectives` (secret),
 *   - `omenDeck` / `tacticDeck` ORDER (draw-pile contents are hidden).
 * Everything else (map, stacks, treasuries' public effects, prestige, log)
 * is table-public per GAME_DESIGN and fair game.
 *
 * DETERMINISM CONTRACT: all policy randomness comes from the provided
 * {@link BotRng} (derived from game seed + bot seed + round). No
 * `Math.random`, no `Date.now`, and NEVER the engine Rng (advancing
 * `rngCursor` outside the reducer desyncs replays).
 */
import type { GameAction, GameState, Faction } from "@imperium/shared";
import type { BotRng } from "./rng.js";
import type { FactionPersona } from "./personality.js";

/** Bot difficulty ladder. Values are wire-compatible with `BotDifficulty`. */
export enum Difficulty {
  EASY = "EASY",
  NORMAL = "NORMAL",
  HARD = "HARD",
}

/** Human-feeling delay window applied before each submitted action. */
export interface PacingWindow {
  minMs: number;
  maxMs: number;
}

/** `'instant'` (tests) skips all delays. */
export type PacingConfig = PacingWindow | "instant";

/**
 * Default pacing: a short human-feeling jitter. Must always leave a full
 * action budget comfortably inside the (future, docs/ARCHITECTURE.md §10)
 * 90s per-player action clock: 4 actions x 2.5s worst case = 10s.
 */
export const DEFAULT_PACING: PacingWindow = { minMs: 800, maxMs: 2500 };

/** Per-bot configuration. */
export interface BotConfig {
  difficulty: Difficulty;
  /**
   * This bot's own PRNG seed, combined with `GameState.rngSeed` and the round
   * to derive its decision stream (see `makeBotRng`). Callers wanting a
   * stable per-seat seed can use `seedFromString(playerId)`.
   */
  botSeed: number;
  pacing: PacingConfig;
}

/** Everything a {@link Policy} may consult for one decision. */
export interface PolicyContext {
  /**
   * Authoritative snapshot. Treat as deeply read-only (the reducer is pure;
   * mutating this would corrupt the room). Subject to the fair-play contract
   * in the module header.
   */
  state: Readonly<GameState>;
  /** The engine `Player.id` of the seat this policy controls. */
  botPlayerId: string;
  /** Deterministic decision stream for this (game, bot, round). */
  rng: BotRng;
  difficulty: Difficulty;
  /** Faction persona (ruler, diplomacy biases); set once the seat has a faction. */
  persona?: FactionPersona;
}

/**
 * A pure decision function: one call = one action slot.
 *
 * Returns a RANKED candidate list for the bot's next single action. The
 * driver submits candidates in order through the validated reducer path and
 * commits the first one the engine accepts (the standard legality-probe
 * idiom — there is no `legalActions(state)` enumerator). Returning an empty
 * list ends the bot's turn for this action window: the driver stops asking
 * and, if budget remains, yields the seat with a real PASS (the engine's
 * turn pointer only advances past a seat whose budget is spent).
 *
 * Termination rule: while the bot still has budget, candidates should be
 * BUDGETED action types (RECRUIT/MOVE/BUILD/TRADE/DIPLOMACY-PROPOSE/
 * VASSALIZE/SPY/DECLARE_WAR/LEVY_CALL) so each accepted action decrements
 * `actionsRemaining` and the spend-down loop provably ends. Free actions
 * (PLAY_CARD, SET_TAX, …) are allowed but bounded by the driver's per-turn
 * iteration cap. Never return ADVANCE_PHASE or PASS (the driver owns those).
 */
export interface Policy {
  /** Short stable name for logs/tests (e.g. "easy-random"). */
  readonly name: string;
  chooseAction(ctx: PolicyContext): readonly GameAction[];
}

/**
 * Situations an advisor may comment on. Keys mirror the situation tags in
 * `lore/factions/*.md` sample lines (`[low gold]`, `[siege begun]`, …).
 */
export type AdvisorSituation =
  | "low_gold"
  | "war_declared_on_you"
  | "siege_begun"
  | "ally_betrayed_you"
  | "victory_near"
  | "event_struck"
  | "idle";

/**
 * A short in-character line a bot emits as table-talk. There is no chat
 * system; this is a HOOK — the transport/client MAY render these (e.g. as a
 * toast beside the bot's seat) or ignore them entirely. Emission is
 * deterministic (drawn from the bot's own RNG stream).
 */
export interface AdvisorLine {
  /** The bot seat speaking. */
  playerId: string;
  faction: Faction;
  /** Display name of the speaker (the faction's advisor, per lore). */
  speaker: string;
  situation: AdvisorSituation;
  text: string;
}

/** Callback invoked whenever a bot produces an {@link AdvisorLine}. */
export type AdvisorLineListener = (line: AdvisorLine) => void;
