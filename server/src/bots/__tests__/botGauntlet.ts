/**
 * botGauntlet.ts — full bot-vs-bot game runner for the AI-opponent battery.
 *
 * The BotPlayer counterpart of `engine/__tests__/gauntletHarness.ts` (same
 * loop discipline, same invariant checker, same failure taxonomy) — but the
 * seats are driven by the REAL difficulty policies through the REAL
 * `BotPlayer` driver and `createEngineSubmit`, i.e. the exact validated
 * action path a socket `game_action` handler will use. Nothing here mutates
 * GameState directly.
 *
 * Shared by:
 *   - src/bots/__tests__/battery.test.ts        (full games / determinism /
 *                                                fuzz / pacing)
 *   - src/bots/__tests__/difficultyOrdering.test.ts (E/N/H win matrices)
 */
import { GamePhase, type Faction, type GameState } from "@imperium/shared";
import { createInitialState } from "../../engine/gameState.js";
import { advancePhase } from "../../engine/roundLoop.js";
import { ROUNDS } from "../../engine/balance.js";
import {
  checkInvariants,
  makeSeats,
  type Violation,
} from "../../engine/__tests__/gauntletHarness.js";
import {
  BotPlayer,
  createEngineSubmit,
  type Scheduler,
  type SubmitFn,
} from "../botPlayer.js";
import { hashCombine } from "../rng.js";
import { personaForFaction } from "../personality.js";
import type { Difficulty, PacingConfig } from "../types.js";

/** Options for one full bot-vs-bot game. */
export interface BotGameOptions {
  /** 2–5 seats (factions assigned in the fixed gauntlet order). */
  numPlayers: number;
  /** The engine's `rngSeed` AND one leg of every bot's decision stream. */
  gameSeed: number;
  /**
   * Per-seat difficulty, index-aligned with the seats. Shorter arrays wrap
   * (so `[EASY]` means all-EASY, `[EASY, HARD]` alternates, …).
   */
  difficulties: readonly Difficulty[];
  /**
   * Per-seat bot seeds. Defaults to `hashCombine(gameSeed, seatIndex)` so a
   * game is fully replayable from (gameSeed, difficulties) alone.
   */
  botSeeds?: readonly number[];
  /** Defaults to `"instant"` (no delays) for test speed. */
  pacing?: PacingConfig;
  /** Injectable delay primitive, forwarded to every BotPlayer. */
  scheduler?: Scheduler;
  /** Run the gauntlet invariant battery after every accepted action. */
  checkInvariants?: boolean;
  /** Record every accepted action + advisor line (for determinism diffs). */
  collectLog?: boolean;
  /** Cap the game at fewer rounds (mid-game state factories). */
  maxRounds?: number;
}

/** Outcome + counters of one full bot-vs-bot game. */
export interface BotGameReport {
  gameSeed: number;
  numPlayers: number;
  difficulties: Difficulty[];
  endedReason: "winner" | "round16" | "deadlock" | "maxRounds";
  winner: Faction | null;
  /** Seat index (into the seat order) of the winner, or null. */
  winnerSeat: number | null;
  /** Difficulty of the winning seat, or null. */
  winnerDifficulty: Difficulty | null;
  finalRound: number;
  /** Sum over all bots of engine-ACCEPTED actions. */
  actionsSubmitted: number;
  /** Sum of in-slot candidate rejections (sanctioned legality probes). */
  probeRejections: number;
  /** Sum of whole-slate rejections — MUST stay 0 for well-formed policies. */
  fallbackPasses: number;
  violations: Violation[];
  deadlock: string | null;
  /** JSON of every accepted action, in submission order (collectLog). */
  actionLog: string[];
  /** Advisor table-talk, in emission order (collectLog). */
  advisorLog: string[];
  finalState: GameState;
}

/**
 * Drive one full game (INCOME → … → END × rounds) with a BotPlayer on every
 * seat. Turn discipline follows the gauntlet precedent: the driver serializes
 * seats over `state.turnOrder` once per round at RECRUITMENT (the shared
 * CANON #9 action window), then advances the phase machine.
 */
export async function runBotGame(opts: BotGameOptions): Promise<BotGameReport> {
  const seats = makeSeats(opts.numPlayers);
  const difficulties = seats.map(
    (_, i) => opts.difficulties[i % opts.difficulties.length],
  );
  const maxRounds = opts.maxRounds ?? ROUNDS;
  const doInv = opts.checkInvariants === true;
  const collect = opts.collectLog === true;

  let state = createInitialState(
    `B${(opts.gameSeed >>> 0).toString(36).toUpperCase()}`,
    seats,
    opts.gameSeed,
  );

  const violations: Violation[] = [];
  const actionLog: string[] = [];
  const advisorLog: string[] = [];
  let deadlock: string | null = null;
  let steps = 0;

  const baseSubmit = createEngineSubmit(
    () => state,
    (next) => {
      state = next;
    },
  );
  /** Wrap the engine submit with invariant checks + the action log. */
  const submit: SubmitFn = async (action) => {
    const prev = state;
    const result = await baseSubmit(action);
    if (result.ok) {
      if (doInv) {
        violations.push(...checkInvariants(prev, result.state, { step: steps, action }));
      }
      if (collect) actionLog.push(JSON.stringify(action));
    }
    return result;
  };

  const bots = seats.map(
    (seat, i) =>
      new BotPlayer({
        playerId: seat.id,
        gameSeed: opts.gameSeed,
        config: {
          difficulty: difficulties[i],
          botSeed: opts.botSeeds?.[i] ?? hashCombine(opts.gameSeed, i),
          pacing: opts.pacing ?? "instant",
        },
        submit,
        persona: seat.faction ? personaForFaction(seat.faction) : undefined,
        scheduler: opts.scheduler,
        onAdvisorLine: collect
          ? (line) => advisorLog.push(`${line.playerId}:${line.text}`)
          : undefined,
      }),
  );
  const botBySeat = new Map(bots.map((b) => [b.playerId, b]));

  const STEP_CAP = maxRounds * 8 + 200;
  while (true) {
    steps += 1;
    if (steps > STEP_CAP) {
      deadlock = `step cap ${STEP_CAP} exceeded at phase=${state.phase} round=${state.round}`;
      break;
    }

    // One shared action window per round: every bot spends its budget at
    // RECRUITMENT, serialized in turnOrder (re-read each round — sortTurnOrder
    // re-sorts by prestige at cleanup).
    if (state.phase === GamePhase.RECRUITMENT) {
      for (const seatId of [...state.turnOrder]) {
        const bot = botBySeat.get(seatId);
        if (bot) await bot.takeTurn(state);
      }
    }

    const before = { phase: state.phase, round: state.round };
    const advanced = advancePhase(state);
    if (doInv) {
      violations.push(...checkInvariants(state, advanced, { step: steps, action: null }));
    }
    state = advanced;

    // Terminal END (winner declared or round-16 endgame): phase+round frozen.
    if (
      before.phase === GamePhase.END &&
      state.phase === GamePhase.END &&
      state.round === before.round
    ) {
      break;
    }
    // Early stop for mid-game state factories.
    if (opts.maxRounds !== undefined && state.round > opts.maxRounds) break;
    // Progress guard.
    if (
      before.phase !== GamePhase.END &&
      state.phase === before.phase &&
      state.round === before.round
    ) {
      deadlock = `advancePhase made no progress from ${before.phase} (round ${before.round})`;
      break;
    }
  }

  const winner = state.winner ?? null;
  const winnerSeat = winner
    ? seats.findIndex((s) => s.faction === winner)
    : -1;
  let endedReason: BotGameReport["endedReason"];
  if (deadlock) endedReason = "deadlock";
  else if (opts.maxRounds !== undefined && opts.maxRounds < ROUNDS && !winner) {
    endedReason = "maxRounds";
  } else if (winner && state.round < ROUNDS) endedReason = "winner";
  else endedReason = "round16";

  return {
    gameSeed: opts.gameSeed,
    numPlayers: seats.length,
    difficulties,
    endedReason,
    winner,
    winnerSeat: winnerSeat >= 0 ? winnerSeat : null,
    winnerDifficulty: winnerSeat >= 0 ? difficulties[winnerSeat] : null,
    finalRound: state.round,
    actionsSubmitted: bots.reduce((n, b) => n + b.stats.actionsSubmitted, 0),
    probeRejections: bots.reduce((n, b) => n + b.stats.probeRejections, 0),
    fallbackPasses: bots.reduce((n, b) => n + b.stats.fallbackPasses, 0),
    violations,
    deadlock,
    actionLog,
    advisorLog,
    finalState: state,
  };
}

/** One cell of the pairwise win matrix. */
export interface MatchupResult {
  a: Difficulty;
  b: Difficulty;
  games: number;
  winsA: number;
  winsB: number;
}

/**
 * Head-to-head 2-player series: `games` full games with varied seeds, seat
 * sides alternating every game (seed parity) so neither difficulty owns a
 * faction. Every game must end legally with zero fallback passes — the
 * caller asserts on the returned totals.
 */
export async function runHeadToHead(
  a: Difficulty,
  b: Difficulty,
  games: number,
  seedBase: number,
): Promise<MatchupResult & { fallbackPasses: number; deadlocks: number }> {
  let winsA = 0;
  let winsB = 0;
  let fallbackPasses = 0;
  let deadlocks = 0;
  for (let i = 0; i < games; i += 1) {
    const aFirst = i % 2 === 0;
    const report = await runBotGame({
      numPlayers: 2,
      gameSeed: hashCombine(seedBase, i),
      difficulties: aFirst ? [a, b] : [b, a],
    });
    fallbackPasses += report.fallbackPasses;
    if (report.deadlock) deadlocks += 1;
    if (report.winnerSeat === null) continue;
    const seatIsA = aFirst ? report.winnerSeat === 0 : report.winnerSeat === 1;
    if (seatIsA) winsA += 1;
    else winsB += 1;
  }
  return { a, b, games, winsA, winsB, fallbackPasses, deadlocks };
}
