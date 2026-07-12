/**
 * Offline single-file build — shared cross-author types.
 *
 * FROZEN by scratchpad offline-spec.md (architect, 2026-07-12). Three parallel
 * authors code against this file:
 *   A: dispatcher.ts / botRunner.ts / projection.ts / bots vendor / engine shim
 *   B: OfflineApp + mode/setup/privacy/end screens + dispatcher context
 *   C: vite.offline.config.ts + offline.html + fonts + build script
 * Do NOT edit without orchestrator sign-off — interface drift breaks parallel work.
 *
 * Design notes (see offline-spec.md for the normative text):
 * - Event names deliberately mirror the real socket protocol (game_started,
 *   state_update, action_rejected, error_msg) so UI wiring ports 1:1 from
 *   App.tsx; three offline-only events are added (turn_change, bot_status,
 *   game_over).
 * - Every GameState delivered through dispatcher events is PROJECTED for the
 *   current viewer seat (rival hands/objectives and deck order redacted) —
 *   except GameOverPayload.finalState, which is the full state (game over).
 */
import type {
  ActionRejectedPayload,
  ErrorMsgPayload,
  Faction,
  GameAction,
  GamePhase,
  GameStartedPayload,
  GameState,
  StateUpdatePayload,
} from "@imperium/shared";

// ---------------------------------------------------------------------------
// Game configuration (produced by the setup screens, consumed by the dispatcher)
// ---------------------------------------------------------------------------

export type OfflineMode = "hotseat" | "solo";

/**
 * String-literal mirror of the vendored bots `Difficulty` enum (same string
 * values, wire-compatible). types.ts must not import from the vendored bots
 * package, which Author A creates in parallel.
 */
export type BotDifficulty = "EASY" | "NORMAL" | "HARD";

export const BOT_DIFFICULTIES: readonly BotDifficulty[] = [
  "EASY",
  "NORMAL",
  "HARD",
];

/** Mirror of bots PacingConfig: randomized think-delay window, or no delay. */
export interface PacingWindow {
  minMs: number;
  maxMs: number;
}
export type BotPacing = PacingWindow | "instant";

/** Snappier than the server default {800,2500} — local play, no suspense needed. */
export const DEFAULT_BOT_PACING: PacingWindow = { minMs: 150, maxMs: 400 };

export interface HumanSeatConfig {
  kind: "human";
  name: string;
  faction: Faction;
}

export interface BotSeatConfig {
  kind: "bot";
  name: string;
  faction: Faction;
  difficulty: BotDifficulty;
}

export type SeatConfig = HumanSeatConfig | BotSeatConfig;

export interface OfflineGameConfig {
  mode: OfflineMode;
  /**
   * 2..5 seats, in TURN ORDER (index 0 goes first and is the nominal "host").
   * hotseat: every seat kind "human". solo: exactly one human + 1..4 bots.
   * Factions must be unique.
   */
  seats: SeatConfig[];
  /**
   * Engine seed. Omitted => dispatcher picks a fresh random seed at start()
   * (the one permitted nondeterminism; readable back via getConfig().seed).
   */
  seed?: number;
  /** Bot think-delay; defaults to DEFAULT_BOT_PACING. Use "instant" in tests. */
  botPacing?: BotPacing;
}

export const MIN_SEATS = 2;
export const MAX_SEATS = 5;
export const MIN_BOTS_SOLO = 1;
export const MAX_BOTS_SOLO = 4;

/** Seat ids are "seat-1".."seat-5" in config.seats order (== turnOrder). */
export const SEAT_ID_PREFIX = "seat-";
export function seatIdForIndex(index: number): string {
  return `${SEAT_ID_PREFIX}${index + 1}`;
}

/** Runtime seat descriptor exposed by the dispatcher (config + assigned id). */
export interface SeatDescriptor {
  id: string;
  name: string;
  faction: Faction;
  kind: "human" | "bot";
  /** Present iff kind === "bot". */
  difficulty?: BotDifficulty;
  /** Index into GameState.turnOrder (== index in config.seats). */
  turnIndex: number;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Sentinel written over hidden card ids (omenDeck / eraDecksRemaining /
 * tacticDeck) in projected states — deck LENGTHS stay truthful, ids do not.
 * UI must never dereference deck card ids from a projected state.
 */
export const HIDDEN_CARD_ID = "HIDDEN";

/** Implemented in projection.ts (Author A). Pure; input state never mutated. */
export type ProjectStateForSeat = (
  state: GameState,
  seatId: string,
) => GameState;

// ---------------------------------------------------------------------------
// Dispatcher events (server->client surface, local edition)
// ---------------------------------------------------------------------------

export const OFFLINE_EVENTS = {
  /** Same name/payload as the socket protocol; state is viewer-projected. */
  GAME_STARTED: "game_started",
  /** Same name/payload as the socket protocol; state is viewer-projected. */
  STATE_UPDATE: "state_update",
  /** Same name/payload as the socket protocol (EngineError reason + code). */
  ACTION_REJECTED: "action_rejected",
  /** Same name/payload as the socket protocol. */
  ERROR_MSG: "error_msg",
  /** Offline-only: active seat / phase / round changed. Drives hotseat handover. */
  TURN_CHANGE: "turn_change",
  /** Offline-only: a bot started/stopped thinking (spinner UX). */
  BOT_STATUS: "bot_status",
  /** Offline-only: terminal result. No further events follow. */
  GAME_OVER: "game_over",
} as const;

export type OfflineEventName =
  (typeof OFFLINE_EVENTS)[keyof typeof OFFLINE_EVENTS];

export interface TurnChangePayload {
  activeSeatId: string;
  activeSeatName: string;
  activeFaction: Faction | null;
  phase: GamePhase;
  round: number;
  /**
   * true iff mode === "hotseat" AND the newly active seat is human AND differs
   * from the current viewer seat: the UI must show PrivacyScreen and call
   * dispatcher.setViewerSeat(activeSeatId) on confirm.
   */
  requiresHandover: boolean;
}

export interface BotStatusPayload {
  seatId: string;
  name: string;
  thinking: boolean;
}

export type GameOverReason =
  /** checkVictory() returned a faction. */
  | "VICTORY"
  /** round exceeded ROUND_LIMIT; winner = highest prestige (turn-order tiebreak). */
  | "ROUND_LIMIT"
  /** Safety tripwire fired (no-progress deadlock / step cap). Should not happen. */
  | "STALEMATE";

export interface RankingEntry {
  seatId: string;
  name: string;
  faction: Faction | null;
  prestige: number;
  isBot: boolean;
}

export interface GameOverPayload {
  reason: GameOverReason;
  winnerFaction: Faction | null;
  winnerSeatId: string | null;
  /** All seats, best first (prestige desc, then turn order). */
  ranking: RankingEntry[];
  /** FULL unprojected final state — the game is over, secrets are revealed. */
  finalState: GameState;
}

export interface OfflineDispatcherEvents {
  game_started: (payload: GameStartedPayload) => void;
  state_update: (payload: StateUpdatePayload) => void;
  action_rejected: (payload: ActionRejectedPayload) => void;
  error_msg: (payload: ErrorMsgPayload) => void;
  turn_change: (payload: TurnChangePayload) => void;
  bot_status: (payload: BotStatusPayload) => void;
  game_over: (payload: GameOverPayload) => void;
}

// ---------------------------------------------------------------------------
// Dispatcher public interface (implemented in dispatcher.ts, Author A)
// ---------------------------------------------------------------------------

export interface OfflineDispatcher {
  on<E extends OfflineEventName>(
    event: E,
    handler: OfflineDispatcherEvents[E],
  ): void;
  /** Omit handler to remove every listener for the event. */
  off<E extends OfflineEventName>(
    event: E,
    handler?: OfflineDispatcherEvents[E],
  ): void;
  /** Creates the initial state and starts the drive loop. Idempotent. */
  start(): void;
  /**
   * Submit a human action for the CURRENT VIEWER seat. The dispatcher
   * overwrites action.player with the viewer seat id before applying, so
   * callers may leave player as "". Rejections surface as action_rejected
   * (and error_msg); they never throw and never mutate state.
   */
  submit(action: GameAction): void;
  /**
   * Hotseat handover confirm: switch whose projection the UI receives.
   * Immediately re-emits state_update projected for the new viewer.
   */
  setViewerSeat(seatId: string): void;
  getViewerSeatId(): string;
  getSeats(): readonly SeatDescriptor[];
  /** FULL authoritative state (null before start). Debug/EndScreen only — never render mid-game. */
  getAuthoritativeState(): GameState | null;
  /** Config as resolved at construction; seed is always concrete here. */
  getConfig(): Readonly<OfflineGameConfig> & { seed: number };
  /** Detach all listeners and stop bot activity. Safe to call twice. */
  destroy(): void;
}

export type CreateOfflineDispatcher = (
  config: OfflineGameConfig,
) => OfflineDispatcher;

// ---------------------------------------------------------------------------
// Bot runner (implemented in botRunner.ts, Author A)
// ---------------------------------------------------------------------------

export type BotRunStatus =
  /** A human seat is now active — dispatcher waits for submit(). */
  | "human_turn"
  /** All bot turns done and phase left the action window / awaits ADVANCE_PHASE. */
  | "window_done"
  /** Victory or round limit detected mid-run. */
  | "game_over"
  /** Safety cap tripped (see MAX_BOT_ACTIONS_PER_TURN) — dispatcher ends game as STALEMATE. */
  | "limit_reached";

export interface BotRunResult {
  status: BotRunStatus;
}

export interface BotRunnerHooks {
  /** Authoritative (unprojected) state. */
  getState(): GameState;
  /**
   * The dispatcher's single commit path: swaps authoritative state AND emits
   * the projected state_update / turn_change events. Every bot action lands
   * here via createEngineSubmit(getState, commit).
   */
  commit(next: GameState): void;
  onStatus?(payload: BotStatusPayload): void;
  log?(message: string, data?: Record<string, unknown>): void;
}

export interface BotRunnerOptions {
  /** Engine seed of the game; bot seeds derive from it + seat id (deterministic). */
  gameSeed: number;
  /** Bot seats only (kind === "bot"). */
  seats: readonly SeatDescriptor[];
  pacing: BotPacing;
  hooks: BotRunnerHooks;
}

export interface OfflineBotRunner {
  /**
   * Drives consecutive bot turns while a bot holds the active turn. Resolves
   * when a human becomes active, the action window completes, the game ends,
   * or a safety cap trips. Never runs concurrently with itself (single-flight;
   * the dispatcher's pump is the only caller).
   */
  runWhileBotActive(): Promise<BotRunResult>;
  /** Stop scheduling; an in-flight pacing delay resolves into a no-op. */
  destroy(): void;
}

export type CreateBotRunner = (options: BotRunnerOptions) => OfflineBotRunner;

// ---------------------------------------------------------------------------
// Safety limits (hard caps — no infinite loops, non-negotiable)
// ---------------------------------------------------------------------------

/** Game ends after this round (facts: ROUNDS = 16, years 1400-1453). */
export const ROUND_LIMIT = 16;

/**
 * Upper bound on actions one bot may attempt in a single active-turn stint
 * (engine budget is 4-5/round; 64 is pure headroom before declaring deadlock).
 */
export const MAX_BOT_ACTIONS_PER_TURN = 64;

/**
 * Upper bound on dispatcher pump() iterations per activation (phase advances +
 * bot stints). Tripping it ends the game with reason "STALEMATE".
 */
export const MAX_PUMP_STEPS = 500;
