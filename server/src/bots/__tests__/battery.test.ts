/**
 * AI-opponent INTEGRATION BATTERY — full bot-vs-bot games through the real
 * engine via BotPlayer + createEngineSubmit (the exact validated action path
 * the socket dispatch will use; see botGauntlet.ts).
 *
 * Covers:
 *  (a) full games at every player count 2–5 × difficulty mixes (all-EASY,
 *      all-NORMAL, all-HARD, mixed) — every game must end legally (victory
 *      or the round-16 "1453" endgame) with zero invalid submissions
 *      (fallbackPasses stays 0) and zero gauntlet-invariant violations;
 *  (b) determinism — same (gameSeed, botSeeds) twice → byte-identical action
 *      log, advisor log and final state; different seeds → different logs;
 *  (c) fuzz — ≥10,000 bot-chosen actions across randomized games (varying
 *      player counts, seeds and difficulty rotations): 100% accepted by
 *      engine validation, the BotPlayer fallback counter stays 0;
 *  (e) pacing — 'instant' completes a full 5-bot game fast without touching
 *      the scheduler; DEFAULT_PACING draws every delay from its window and a
 *      whole turn's delays stay far inside the 90s turn-timer budget.
 *
 * (d) difficulty ordering lives in difficultyOrdering.test.ts.
 */
import { describe, expect, it } from "vitest";
import { GamePhase, type GameState } from "@imperium/shared";
import { createInitialState } from "../../engine/gameState.js";
import { advancePhase } from "../../engine/roundLoop.js";
import { makeSeats } from "../../engine/__tests__/gauntletHarness.js";
import { BotPlayer, createEngineSubmit } from "../botPlayer.js";
import { hashCombine } from "../rng.js";
import { personaForFaction } from "../personality.js";
import { DEFAULT_PACING, Difficulty } from "../types.js";
import { runBotGame, type BotGameReport } from "./botGauntlet.js";

const MIXES: Record<string, readonly Difficulty[]> = {
  "all-EASY": [Difficulty.EASY],
  "all-NORMAL": [Difficulty.NORMAL],
  "all-HARD": [Difficulty.HARD],
  "mixed-E/N/H": [Difficulty.EASY, Difficulty.NORMAL, Difficulty.HARD],
};

/** A finished game must be a legal end state with a clean submission record. */
function expectLegalEnd(r: BotGameReport): void {
  expect(r.deadlock).toBeNull();
  expect(["winner", "round16"]).toContain(r.endedReason);
  // Both end reasons produce a §13 winner (round-16 falls back to highest
  // prestige with key-city/gold tiebreaks — decideWinner never returns null
  // at the endgame).
  expect(r.winner).not.toBeNull();
  expect(r.actionsSubmitted).toBeGreaterThan(0);
  // Zero invalid submissions: no bot ever ran out of engine-legal candidates.
  expect(r.fallbackPasses).toBe(0);
  expect(r.violations).toEqual([]);
}

describe("bots battery (a) — full games, all player counts × difficulty mixes", () => {
  for (const numPlayers of [2, 3, 4, 5]) {
    for (const [mixName, difficulties] of Object.entries(MIXES)) {
      it(
        `${numPlayers}p ${mixName} reaches a legal end state with zero invalid submissions`,
        async () => {
          const report = await runBotGame({
            numPlayers,
            gameSeed: hashCombine(0xba77e12, numPlayers, mixName.length),
            difficulties,
            checkInvariants: true,
          });
          expectLegalEnd(report);
        },
        60_000,
      );
    }
  }
});

describe("bots battery (b) — determinism", () => {
  const config = {
    numPlayers: 3,
    gameSeed: 20260711,
    difficulties: [Difficulty.EASY, Difficulty.NORMAL, Difficulty.HARD],
    botSeeds: [11, 22, 33],
    collectLog: true,
  } as const;

  it(
    "same (gameSeed, botSeeds) → identical full game log, twice",
    async () => {
      const a = await runBotGame(config);
      const b = await runBotGame(config);
      expect(a.actionLog).toEqual(b.actionLog);
      expect(a.advisorLog).toEqual(b.advisorLog);
      expect(JSON.stringify(a.finalState)).toBe(JSON.stringify(b.finalState));
      expect(a.actionLog.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "a different gameSeed produces a different game log",
    async () => {
      const a = await runBotGame(config);
      const b = await runBotGame({ ...config, gameSeed: 20260712 });
      expect(a.actionLog.join("\n")).not.toBe(b.actionLog.join("\n"));
    },
    60_000,
  );

  it(
    "different botSeeds (same gameSeed) produce a different game log",
    async () => {
      const a = await runBotGame(config);
      const b = await runBotGame({ ...config, botSeeds: [44, 55, 66] });
      expect(a.actionLog.join("\n")).not.toBe(b.actionLog.join("\n"));
    },
    60_000,
  );
});

describe("bots battery (c) — fuzz: 10,000 engine-validated bot actions", () => {
  it(
    "every bot-chosen action passes engine validation (fallback counter stays 0)",
    async () => {
      const rotation = [Difficulty.EASY, Difficulty.NORMAL, Difficulty.HARD];
      let actions = 0;
      let fallbacks = 0;
      let games = 0;
      for (let i = 0; actions < 10_000; i += 1) {
        const numPlayers = 2 + (i % 4);
        const difficulties = [0, 1, 2, 3, 4].map(
          (k) => rotation[(i + k) % rotation.length],
        );
        const report = await runBotGame({
          numPlayers,
          gameSeed: hashCombine(0xf00d, i),
          difficulties,
        });
        expect(report.deadlock).toBeNull();
        actions += report.actionsSubmitted;
        fallbacks += report.fallbackPasses;
        games += 1;
      }
      expect(actions).toBeGreaterThanOrEqual(10_000);
      expect(fallbacks).toBe(0);
      console.info(
        `[battery:fuzz] ${actions} accepted actions across ${games} games, 0 fallbacks`,
      );
    },
    300_000,
  );
});

describe("bots battery (e) — pacing", () => {
  it(
    "'instant' pacing finishes a full 5-bot game fast and never touches the scheduler",
    async () => {
      let schedulerCalls = 0;
      const t0 = Date.now();
      const report = await runBotGame({
        numPlayers: 5,
        gameSeed: 0xace,
        difficulties: [Difficulty.EASY, Difficulty.NORMAL, Difficulty.HARD],
        pacing: "instant",
        scheduler: () => {
          schedulerCalls += 1;
          return Promise.resolve();
        },
      });
      const elapsed = Date.now() - t0;
      expect(report.deadlock).toBeNull();
      expect(report.fallbackPasses).toBe(0);
      expect(schedulerCalls).toBe(0);
      // A full 16-round 5-bot game runs in well under a second in practice;
      // 30s is a very generous CI bound that still catches pathological work.
      expect(elapsed).toBeLessThan(30_000);
    },
    60_000,
  );

  it("DEFAULT_PACING keeps a whole turn's delays inside the 90s turn budget (mock timer)", async () => {
    // Drive one real action window with the default human-feeling pacing and
    // a capturing mock scheduler (no wall-clock waits).
    let state: GameState = createInitialState("PACE01", makeSeats(2), 7);
    let guard = 0;
    while (state.phase !== GamePhase.RECRUITMENT) {
      state = advancePhase(state);
      if ((guard += 1) > 10) throw new Error("never reached RECRUITMENT");
    }
    const submit = createEngineSubmit(
      () => state,
      (next) => {
        state = next;
      },
    );
    const perTurnDelays: number[][] = [];
    for (const seatId of [...state.turnOrder]) {
      const seat = state.players.find((p) => p.id === seatId);
      if (!seat) continue;
      const delays: number[] = [];
      const bot = new BotPlayer({
        playerId: seatId,
        gameSeed: 7,
        config: {
          difficulty: Difficulty.HARD,
          botSeed: hashCombine(7, seatId.length),
          pacing: DEFAULT_PACING,
        },
        submit,
        persona: seat.faction ? personaForFaction(seat.faction) : undefined,
        scheduler: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      });
      await bot.takeTurn(state);
      expect(bot.stats.actionsSubmitted).toBeGreaterThan(0);
      perTurnDelays.push(delays);
    }
    for (const delays of perTurnDelays) {
      expect(delays.length).toBeGreaterThan(0);
      for (const ms of delays) {
        expect(ms).toBeGreaterThanOrEqual(DEFAULT_PACING.minMs);
        expect(ms).toBeLessThanOrEqual(DEFAULT_PACING.maxMs);
      }
      // docs/ARCHITECTURE.md §10 sizes the action clock at 90s per player —
      // the whole turn's pacing must fit comfortably inside it.
      const total = delays.reduce((a, b) => a + b, 0);
      expect(total).toBeLessThan(90_000);
    }
  });
});
