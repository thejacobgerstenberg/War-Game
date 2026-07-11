/**
 * BotPlayer — the driver that owns one bot seat and turns a {@link Policy}
 * into submitted actions.
 *
 * TRANSPORT-FREE by design: the bot submits every action through an injected
 * {@link SubmitFn}, the same validated path a socket `game_action` handler
 * uses (validate → `applyAction` → commit-or-reject). PR #10 does not ship a
 * `game_action` handler yet, so v1 rooms run bots in-process via
 * {@link createEngineSubmit}; when the socket dispatch lands, the identical
 * SubmitFn shape wraps it with zero changes here.
 *
 * TURN DISCIPLINE: the reducer deliberately does NOT enforce whose turn it
 * is inside the shared RECRUITMENT/MOVEMENT/DIPLOMACY action window (CANON
 * #9 — `spendAction` gates only phase + budget). Whoever owns the room's
 * game loop must therefore serialize seats (gauntlet precedent: iterate
 * `state.turnOrder`, and re-read it each round — `sortTurnOrder` re-sorts by
 * prestige at INCOME and END) and call {@link BotPlayer.takeTurn} for each
 * bot seat in order.
 *
 * TIMER: docs/ARCHITECTURE.md §10's 90s action clock has no code yet. Pacing
 * here is config ({@link import("./types.js").DEFAULT_PACING}, `'instant'`
 * in tests) and is sized to always finish a full budget well inside 90s.
 */
import { GamePhase, type GameAction, type GameState } from "@imperium/shared";
import { applyAction, EngineError } from "../engine/actions.js";
import { PRESTIGE_THRESHOLDS } from "../engine/balance.js";
import { makeBotRng } from "./rng.js";
import {
  advisorLineFor,
  type FactionPersona,
} from "./personality.js";
import {
  DEFAULT_PACING,
  type AdvisorLineListener,
  type AdvisorSituation,
  type BotConfig,
  type Policy,
} from "./types.js";
import { policyForDifficulty } from "./policies/index.js";

/** Result of one submitted action — mirrors STATE_SNAPSHOT / ACTION_REJECTED. */
export type SubmitResult =
  | { ok: true; state: GameState }
  | { ok: false; reason: string; code?: string };

/**
 * The single gateway a bot may use to act. Implementations MUST route
 * through the validated reducer (`applyAction`) — never hand a bot a
 * state-mutating shortcut.
 */
export type SubmitFn = (action: GameAction) => SubmitResult | Promise<SubmitResult>;

/** Injectable delay primitive; tests pass an instant/capturing scheduler. */
export type Scheduler = (ms: number) => Promise<void>;

const defaultScheduler: Scheduler = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap the pure engine reducer as a {@link SubmitFn} for in-process rooms —
 * semantically identical to the future socket `game_action` handler:
 * `EngineError` → rejection `{reason, code}` (the wire's ACTION_REJECTED),
 * success → commit + fresh snapshot. Non-EngineError throws propagate (a
 * crash bug, mirroring the gauntlet's classification).
 */
export function createEngineSubmit(
  getState: () => GameState,
  commit: (next: GameState) => void,
): SubmitFn {
  return (action: GameAction): SubmitResult => {
    try {
      const next = applyAction(getState(), action);
      commit(next);
      return { ok: true, state: next };
    } catch (err) {
      if (err instanceof EngineError) {
        return { ok: false, reason: err.message, code: err.code };
      }
      throw err;
    }
  };
}

/** Phases forming the one type-agnostic action window (CANON #9). */
const ACTION_WINDOW = new Set<GamePhase>([
  GamePhase.RECRUITMENT,
  GamePhase.MOVEMENT,
  GamePhase.DIPLOMACY,
]);

/**
 * Extra iterations allowed past the action budget, so a policy may play a
 * bounded number of un-budgeted actions (PLAY_CARD, SET_TAX, …) per turn
 * without risking an unbounded loop.
 */
const FREE_ACTION_SLACK = 8;

/** Counters exposed for tests and ops dashboards. */
export interface BotStats {
  /** Actions the engine accepted. */
  actionsSubmitted: number;
  /** Candidate rejections inside a slot (expected legality probes). */
  probeRejections: number;
  /**
   * Times an ENTIRE candidate list was rejected — should never happen with a
   * well-formed policy; the bot logs it and falls back to a safe PASS.
   */
  fallbackPasses: number;
  /** Advisor lines emitted. */
  advisorLines: number;
}

/** Constructor options for {@link BotPlayer}. */
export interface BotPlayerOptions {
  /** Engine `Player.id` of the seat this bot controls. */
  playerId: string;
  /** The game's seed (`GameState.rngSeed`) — one leg of the decision stream. */
  gameSeed: number;
  config: BotConfig;
  /** The submit gateway (socket dispatch or {@link createEngineSubmit}). */
  submit: SubmitFn;
  /** Defaults to {@link policyForDifficulty} of `config.difficulty`. */
  policy?: Policy;
  persona?: FactionPersona;
  /** Injectable delay; defaults to real setTimeout. Ignored when pacing is 'instant'. */
  scheduler?: Scheduler;
  /** Optional table-talk sink (see {@link AdvisorLineListener}). */
  onAdvisorLine?: AdvisorLineListener;
  /** Diagnostic logger (defaults to silent). */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export class BotPlayer {
  readonly playerId: string;
  readonly config: BotConfig;
  readonly policy: Policy;
  readonly persona?: FactionPersona;

  private readonly gameSeed: number;
  private readonly submit: SubmitFn;
  private readonly scheduler: Scheduler;
  private readonly onAdvisorLine?: AdvisorLineListener;
  private readonly log: (message: string, data?: Record<string, unknown>) => void;

  private latestState: GameState | null = null;

  readonly stats: BotStats = {
    actionsSubmitted: 0,
    probeRejections: 0,
    fallbackPasses: 0,
    advisorLines: 0,
  };

  constructor(options: BotPlayerOptions) {
    this.playerId = options.playerId;
    this.config = options.config;
    this.policy = options.policy ?? policyForDifficulty(options.config.difficulty);
    this.persona = options.persona;
    this.gameSeed = options.gameSeed;
    this.submit = options.submit;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onAdvisorLine = options.onAdvisorLine;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Snapshot subscription hook: the room loop (or a future socket client)
   * feeds every authoritative state here so the bot always decides on the
   * latest state even when `takeTurn` is called without an argument.
   */
  onSnapshot(state: GameState): void {
    this.latestState = state;
  }

  /**
   * Play out this bot's share of the current action window: ask the policy
   * for one action slot at a time, submit ranked candidates through the
   * validated path, and stop when the budget is spent, the policy ends the
   * turn (empty candidate list), or the per-turn iteration cap is reached.
   *
   * Returns the last authoritative state this bot observed (callers use it
   * as the room's next state in in-process loops), or null when the bot has
   * never seen a state.
   */
  async takeTurn(state?: GameState): Promise<GameState | null> {
    let current = state ?? this.latestState;
    if (!current) return null;
    this.latestState = current;

    const me = current.players.find((p) => p.id === this.playerId);
    if (!me || !ACTION_WINDOW.has(current.phase)) return current;

    // Decision stream for this (game, bot, round); table-talk gets its own
    // split so emitting a line never shifts a decision.
    const rng = makeBotRng(this.gameSeed, this.config.botSeed, current.round);
    this.emitAdvisorLine(current, rng.split("advisor"));

    const cap = this.budgetOf(current) + FREE_ACTION_SLACK;
    for (let slot = 0; slot < cap; slot += 1) {
      if (this.budgetOf(current) <= 0) break;

      const candidates = this.policy.chooseAction({
        state: current,
        botPlayerId: this.playerId,
        rng,
        difficulty: this.config.difficulty,
        persona: this.persona,
      });
      if (candidates.length === 0) break; // policy ends its turn

      await this.pace(rng);

      let applied = false;
      for (const action of candidates) {
        const result = await this.submit(action);
        if (result.ok) {
          current = result.state;
          this.latestState = current;
          this.stats.actionsSubmitted += 1;
          applied = true;
          break;
        }
        this.stats.probeRejections += 1;
      }

      if (!applied) {
        // Every candidate rejected — should never happen with a well-formed
        // policy. Log it, fall back to a safe PASS, and end the turn.
        this.stats.fallbackPasses += 1;
        this.log("bot_fallback_pass", {
          playerId: this.playerId,
          policy: this.policy.name,
          round: current.round,
          phase: current.phase,
          candidates: candidates.length,
        });
        const pass = await this.submit({ type: "PASS", player: this.playerId });
        if (pass.ok) {
          current = pass.state;
          this.latestState = current;
        }
        break;
      }
    }
    return current;
  }

  private budgetOf(state: GameState): number {
    return (
      state.players.find((p) => p.id === this.playerId)?.actionsRemaining ?? 0
    );
  }

  /** Human-feeling delay before an action; 'instant' pacing skips entirely. */
  private async pace(rng: { next(): number }): Promise<void> {
    const pacing = this.config.pacing;
    if (pacing === "instant") return;
    const { minMs, maxMs } = pacing.minMs <= pacing.maxMs
      ? pacing
      : DEFAULT_PACING;
    const ms = Math.round(minMs + rng.next() * (maxMs - minMs));
    if (ms > 0) await this.scheduler(ms);
  }

  /** Deterministically emit at most one in-character line per turn. */
  private emitAdvisorLine(
    state: GameState,
    rng: Parameters<typeof advisorLineFor>[3],
  ): void {
    if (!this.onAdvisorLine || !this.persona) return;
    const me = state.players.find((p) => p.id === this.playerId);
    if (!me) return;

    let situation: AdvisorSituation | null = null;
    const threshold = PRESTIGE_THRESHOLDS[state.players.length];
    if (me.treasury.gold < 5) situation = "low_gold";
    else if (threshold !== undefined && me.prestige >= threshold - 10) {
      situation = "victory_near";
    } else if (rng.chance(0.25)) situation = "idle";

    if (!situation) return;
    const line = advisorLineFor(this.persona, this.playerId, situation, rng);
    if (line) {
      this.stats.advisorLines += 1;
      this.onAdvisorLine(line);
    }
  }
}
