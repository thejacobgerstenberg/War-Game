/**
 * Offline bot runner (spec §5) — owns one vendored BotPlayer per bot seat and
 * drives consecutive bot turns while a bot holds the engine's active turn.
 *
 * Discipline:
 * - Every bot action flows through `createEngineSubmit(hooks.getState, commit)`
 *   — the validated applyAction path; bots have no state-mutating shortcut.
 * - The runner NEVER calls advancePhase — phase transitions belong to the
 *   dispatcher's pump (single owner).
 * - Bots receive the FULL authoritative state (facts §3 / spec §3: redaction
 *   for bots is a PR #27 follow-up; same posture here).
 * - No path loops forever: every iteration either changes state (engine
 *   progress), force-PASSes a wedged bot, or returns; MAX_BOT_ACTIONS_PER_TURN
 *   caps a whole stint, and the dispatcher's MAX_PUMP_STEPS backstops that.
 */
import { GamePhase, type GameState } from "@imperium/shared";
import { checkVictory } from "./engine/index";
import {
  BotPlayer,
  createEngineSubmit,
  type Scheduler,
  type SubmitFn,
} from "./bots/index";
import { Difficulty } from "./bots/types";
import { hashCombine, seedFromString } from "./bots/rng";
import {
  MAX_BOT_ACTIONS_PER_TURN,
  ROUND_LIMIT,
  type BotRunResult,
  type BotRunnerOptions,
  type CreateBotRunner,
  type OfflineBotRunner,
  type SeatDescriptor,
} from "./types";

/** Phases forming the shared action window (mirrors the engine gate). */
const ACTION_WINDOW = new Set<GamePhase>([
  GamePhase.RECRUITMENT,
  GamePhase.MOVEMENT,
  GamePhase.DIPLOMACY,
]);

function difficultyOf(seat: SeatDescriptor): Difficulty {
  switch (seat.difficulty) {
    case "EASY":
      return Difficulty.EASY;
    case "NORMAL":
      return Difficulty.NORMAL;
    case "HARD":
      return Difficulty.HARD;
    default:
      throw new Error(
        `Bot seat ${seat.id} has no valid difficulty (got ${String(seat.difficulty)})`,
      );
  }
}

export const createBotRunner: CreateBotRunner = (
  options: BotRunnerOptions,
): OfflineBotRunner => {
  const { gameSeed, seats, pacing, hooks } = options;
  let destroyed = false;

  // Pending pacing sleeps, flushed on destroy() so an in-flight delay resolves
  // promptly into a no-op return instead of keeping the game loop alive.
  const pendingSleeps = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
  const scheduler: Scheduler = (ms) =>
    new Promise<void>((resolve) => {
      if (destroyed || ms <= 0) {
        resolve();
        return;
      }
      const entry = {
        timer: setTimeout(() => {
          pendingSleeps.delete(entry);
          resolve();
        }, ms),
        resolve,
      };
      pendingSleeps.add(entry);
    });

  // Count every engine commit the bots produce (actions AND yield-passes) —
  // the stint cap must see all of them, not just budgeted actions.
  let commitCount = 0;
  const countingCommit = (next: GameState): void => {
    if (destroyed) return; // never mutate the dispatcher after teardown
    commitCount += 1;
    // "onSnapshot via hooks wiring" (spec §4.3): every commit is broadcast to
    // every bot so each always decides on the latest authoritative state.
    for (const bot of bots.values()) bot.onSnapshot(next);
    hooks.commit(next);
  };
  const submit: SubmitFn = createEngineSubmit(hooks.getState, countingCommit);

  const bots = new Map<string, BotPlayer>();
  for (const seat of seats) {
    if (seat.kind !== "bot") {
      throw new Error(`createBotRunner given non-bot seat ${seat.id}`);
    }
    bots.set(
      seat.id,
      new BotPlayer({
        playerId: seat.id,
        gameSeed,
        config: {
          difficulty: difficultyOf(seat),
          // Deterministic per (game, seat): replayable from the game seed alone.
          botSeed: hashCombine(gameSeed, seedFromString(seat.id)),
          pacing,
        },
        submit,
        scheduler,
        log: hooks.log,
      }),
    );
  }

  async function runWhileBotActive(): Promise<BotRunResult> {
    let actionsThisCall = 0;
    const stintCap = MAX_BOT_ACTIONS_PER_TURN * Math.max(1, bots.size);

    for (;;) {
      if (destroyed) return { status: "human_turn" }; // no-op: dispatcher is tearing down

      const state = hooks.getState();
      const activeId = state.turnOrder[state.activePlayerIndex];
      const bot = activeId !== undefined ? bots.get(activeId) : undefined;
      if (!bot) return { status: "human_turn" };

      if (checkVictory(state) !== null || state.round > ROUND_LIMIT) {
        return { status: "game_over" };
      }
      if (!ACTION_WINDOW.has(state.phase)) return { status: "window_done" };

      // Engine pointer semantics (actions.ts::advanceTurnPointer): the pointer
      // only rests on a seat with 0 budget when EVERY seat's budget is spent —
      // the window is done and the dispatcher must issue ADVANCE_PHASE.
      const activeBudget =
        state.players.find((p) => p.id === activeId)?.actionsRemaining ?? 0;
      if (activeBudget <= 0) return { status: "window_done" };

      const before = state;
      const commitsBefore = commitCount;
      hooks.onStatus?.({ seatId: activeId!, name: botName(activeId!), thinking: true });
      await bot.takeTurn(before);
      hooks.onStatus?.({ seatId: activeId!, name: botName(activeId!), thinking: false });
      if (destroyed) return { status: "human_turn" };

      actionsThisCall += commitCount - commitsBefore;
      if (actionsThisCall > stintCap) return { status: "limit_reached" };

      if (hooks.getState() === before) {
        // The bot neither acted nor passed (takeTurn normally yields with a
        // real PASS) — force a PASS so the turn pointer cannot wedge.
        const result = await submit({ type: "PASS", player: activeId! });
        actionsThisCall += 1;
        if (!result.ok) return { status: "limit_reached" };
      }
    }
  }

  function botName(seatId: string): string {
    return seats.find((s) => s.id === seatId)?.name ?? seatId;
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    for (const entry of pendingSleeps) {
      clearTimeout(entry.timer);
      entry.resolve();
    }
    pendingSleeps.clear();
  }

  return { runWhileBotActive, destroy };
};
