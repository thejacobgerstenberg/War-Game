/**
 * BotPlayer driver tests.
 *
 * Verifies the submit-path contract (everything routes through the injected
 * SubmitFn — the same validated reducer path the socket layer will use),
 * budget discipline (CANON #9 shared action window), the ranked-candidate
 * legality-probe idiom, the safe-PASS fallback, pacing injection, and full
 * determinism against the real engine.
 */
import { describe, expect, it } from "vitest";
import {
  Faction,
  GamePhase,
  type GameAction,
  type GameState,
} from "@imperium/shared";
import { createInitialState } from "../../engine/gameState.js";
import { advancePhase } from "../../engine/roundLoop.js";
import { makeSeats } from "../../engine/__tests__/gauntletHarness.js";
import {
  BotPlayer,
  createEngineSubmit,
  type SubmitFn,
  type SubmitResult,
} from "../botPlayer.js";
import { Difficulty, type BotConfig, type Policy } from "../types.js";
import { personaForFaction } from "../personality.js";

const GAME_SEED = 20260711;

/** A real engine state advanced into the action window (RECRUITMENT). */
function stateAtActionWindow(seed = GAME_SEED): GameState {
  let state = createInitialState("BOTTST", makeSeats(2), seed);
  let guard = 0;
  while (state.phase !== GamePhase.RECRUITMENT) {
    state = advancePhase(state);
    if ((guard += 1) > 10) throw new Error("never reached RECRUITMENT");
  }
  return state;
}

function config(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    difficulty: Difficulty.NORMAL,
    botSeed: 99,
    pacing: "instant",
    ...overrides,
  };
}

/** Structurally decrement a player's action budget (no engine involved). */
function decrement(state: GameState, playerId: string): GameState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, actionsRemaining: p.actionsRemaining - 1 } : p,
    ),
  };
}

/** A policy that always offers the given candidate factory's output. */
function policyOf(
  choose: (playerId: string) => readonly GameAction[],
): Policy {
  return {
    name: "scripted",
    chooseAction: (ctx) => choose(ctx.botPlayerId),
  };
}

const dummyAction = (player: string): GameAction => ({
  type: "SET_TAX",
  player,
  posture: "NORMAL" as never, // payload irrelevant: submit is mocked
});

describe("bots/BotPlayer — submit path and budget", () => {
  it("submits one action per budget point through the injected path, then stops", async () => {
    const start = stateAtActionWindow();
    const me = start.players[0];
    const submitted: GameAction[] = [];
    let current = start;

    const submit: SubmitFn = (action) => {
      submitted.push(action);
      current = decrement(current, me.id);
      return { ok: true, state: current };
    };

    const bot = new BotPlayer({
      playerId: me.id,
      gameSeed: GAME_SEED,
      config: config(),
      submit,
      policy: policyOf((pid) => [dummyAction(pid)]),
    });

    const after = await bot.takeTurn(start);
    expect(submitted).toHaveLength(me.actionsRemaining); // base budget (4)
    expect(submitted.every((a) => a.player === me.id)).toBe(true);
    expect(bot.stats.actionsSubmitted).toBe(me.actionsRemaining);
    expect(bot.stats.fallbackPasses).toBe(0);
    expect(
      after?.players.find((p) => p.id === me.id)?.actionsRemaining,
    ).toBe(0);
  });

  it("yields with a PASS when the policy ends its turn with budget remaining", async () => {
    // Engine turn-order contract: the window pointer only advances past a
    // seat whose budget hits 0, so a bot whose policy is done must cede the
    // turn with a real PASS (not silently strand the pointer on itself).
    const start = stateAtActionWindow();
    const me = start.players[0];
    const submitted: GameAction[] = [];
    const submit: SubmitFn = (action) => {
      submitted.push(action);
      if (action.type !== "PASS") throw new Error("only PASS may be submitted");
      return {
        ok: true,
        state: {
          ...start,
          players: start.players.map((p) =>
            p.id === me.id ? { ...p, actionsRemaining: 0 } : p,
          ),
        },
      };
    };
    const bot = new BotPlayer({
      playerId: me.id,
      gameSeed: GAME_SEED,
      config: config(),
      submit,
      policy: policyOf(() => []),
    });
    const after = await bot.takeTurn(start);
    expect(bot.stats.actionsSubmitted).toBe(0);
    expect(bot.stats.fallbackPasses).toBe(0);
    expect(bot.stats.yieldPasses).toBe(1);
    expect(submitted).toEqual([{ type: "PASS", player: me.id }]);
    expect(
      after?.players.find((p) => p.id === me.id)?.actionsRemaining,
    ).toBe(0);
  });

  it("declines to act while another seat holds the active turn", async () => {
    const start = stateAtActionWindow();
    // Pick the seat the window pointer is NOT resting on.
    const activeId = start.turnOrder[start.activePlayerIndex];
    const me = start.players.find((p) => p.id !== activeId);
    if (!me) throw new Error("test needs two seats");
    const submit: SubmitFn = () => {
      throw new Error("must not be called out of turn");
    };
    const bot = new BotPlayer({
      playerId: me.id,
      gameSeed: GAME_SEED,
      config: config(),
      submit,
      policy: policyOf((pid) => [dummyAction(pid)]),
    });
    const after = await bot.takeTurn(start);
    expect(bot.stats.actionsSubmitted).toBe(0);
    expect(bot.stats.yieldPasses).toBe(0);
    expect(after).toBe(start);
  });

  it("does nothing outside the RECRUITMENT/MOVEMENT/DIPLOMACY window", async () => {
    // COMBAT is not part of the shared action window (CANON #9).
    const state: GameState = {
      ...stateAtActionWindow(),
      phase: GamePhase.COMBAT,
    };
    const me = state.players[0];
    let calls = 0;
    const bot = new BotPlayer({
      playerId: me.id,
      gameSeed: GAME_SEED,
      config: config(),
      submit: () => {
        calls += 1;
        return { ok: false, reason: "no" };
      },
      policy: policyOf((pid) => [dummyAction(pid)]),
    });
    const after = await bot.takeTurn(state);
    expect(calls).toBe(0);
    expect(after).toBe(state);
  });

  it("tries ranked candidates in order and counts probe rejections", async () => {
    const start = stateAtActionWindow();
    const me = start.players[0];
    const seen: GameAction[] = [];
    let turns = 0;
    let current = start;

    const submit: SubmitFn = (action): SubmitResult => {
      seen.push(action);
      // Reject the first candidate of each slot, accept the second.
      if (seen.length % 2 === 1) {
        return { ok: false, reason: "illegal", code: "BAD_BUILD" };
      }
      current = decrement(current, me.id);
      return { ok: true, state: current };
    };

    const bot = new BotPlayer({
      playerId: me.id,
      gameSeed: GAME_SEED,
      config: config(),
      submit,
      policy: policyOf((pid) => {
        turns += 1;
        return turns <= 2 ? [dummyAction(pid), dummyAction(pid)] : [];
      }),
    });

    await bot.takeTurn(start);
    expect(bot.stats.actionsSubmitted).toBe(2);
    expect(bot.stats.probeRejections).toBe(2);
    expect(bot.stats.fallbackPasses).toBe(0);
  });

  it("falls back to a safe PASS when every candidate is rejected", async () => {
    const start = stateAtActionWindow();
    const me = start.players[0];
    const submitted: GameAction[] = [];

    const submit: SubmitFn = (action): SubmitResult => {
      submitted.push(action);
      if (action.type === "PASS") {
        return {
          ok: true,
          state: {
            ...start,
            players: start.players.map((p) =>
              p.id === me.id ? { ...p, actionsRemaining: 0 } : p,
            ),
          },
        };
      }
      return { ok: false, reason: "illegal", code: "WRONG_PHASE" };
    };

    const bot = new BotPlayer({
      playerId: me.id,
      gameSeed: GAME_SEED,
      config: config(),
      submit,
      policy: policyOf((pid) => [dummyAction(pid), dummyAction(pid)]),
    });

    const after = await bot.takeTurn(start);
    expect(bot.stats.fallbackPasses).toBe(1);
    expect(submitted.at(-1)?.type).toBe("PASS");
    expect(
      after?.players.find((p) => p.id === me.id)?.actionsRemaining,
    ).toBe(0);
  });
});

describe("bots/BotPlayer — pacing", () => {
  it("draws each delay from the configured window via the injected scheduler", async () => {
    const start = stateAtActionWindow();
    const me = start.players[0];
    let current = start;
    const delays: number[] = [];

    const bot = new BotPlayer({
      playerId: me.id,
      gameSeed: GAME_SEED,
      config: config({ pacing: { minMs: 100, maxMs: 250 } }),
      submit: () => {
        current = decrement(current, me.id);
        return { ok: true, state: current };
      },
      scheduler: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      policy: policyOf((pid) => [dummyAction(pid)]),
    });

    await bot.takeTurn(start);
    expect(delays).toHaveLength(bot.stats.actionsSubmitted);
    for (const ms of delays) {
      expect(ms).toBeGreaterThanOrEqual(100);
      expect(ms).toBeLessThanOrEqual(250);
    }
  });

  it("never touches the scheduler when pacing is 'instant'", async () => {
    const start = stateAtActionWindow();
    const me = start.players[0];
    let current = start;
    let schedulerCalls = 0;

    const bot = new BotPlayer({
      playerId: me.id,
      gameSeed: GAME_SEED,
      config: config({ pacing: "instant" }),
      submit: () => {
        current = decrement(current, me.id);
        return { ok: true, state: current };
      },
      scheduler: () => {
        schedulerCalls += 1;
        return Promise.resolve();
      },
      policy: policyOf((pid) => [dummyAction(pid)]),
    });

    await bot.takeTurn(start);
    expect(bot.stats.actionsSubmitted).toBeGreaterThan(0);
    expect(schedulerCalls).toBe(0);
  });
});

describe("bots/BotPlayer — against the real engine", () => {
  /** Drive both bot seats through one action window via createEngineSubmit. */
  async function playOneWindow(): Promise<{
    state: GameState;
    stats: Array<{ submitted: number; fallbacks: number }>;
    advisorTexts: string[];
  }> {
    let state = stateAtActionWindow();
    const commit = (next: GameState): void => {
      state = next;
    };
    const advisorTexts: string[] = [];

    const bots = state.players.map(
      (p, i) =>
        new BotPlayer({
          playerId: p.id,
          gameSeed: GAME_SEED,
          config: config({ botSeed: 1000 + i }),
          submit: createEngineSubmit(() => state, commit),
          persona: personaForFaction(p.faction ?? Faction.BYZANTIUM),
          onAdvisorLine: (line) => advisorTexts.push(line.text),
        }),
    );
    const byId = new Map(bots.map((b) => [b.playerId, b]));

    // Serialize seats in turnOrder, exactly like the gauntlet harness — this
    // matches the engine's enforced turn gate (activePlayerIndex starts at
    // turnOrder[0] and advances as each seat spends or yields its budget).
    for (const seatId of state.turnOrder) {
      const bot = byId.get(seatId);
      if (bot) await bot.takeTurn(state);
    }

    return {
      state,
      stats: bots.map((b) => ({
        submitted: b.stats.actionsSubmitted,
        fallbacks: b.stats.fallbackPasses,
      })),
      advisorTexts,
    };
  }

  it("placeholder policies apply real accepted actions and spend budgets", async () => {
    const { state, stats } = await playOneWindow();
    for (const s of stats) expect(s.submitted).toBeGreaterThan(0);
    for (const p of state.players) {
      // Budget spent (or the policy ran out of candidates — never negative).
      expect(p.actionsRemaining).toBeGreaterThanOrEqual(0);
      expect(p.actionsRemaining).toBeLessThan(4);
    }
    // The engine, not the bot, owns the RNG cursor; bot play must have left
    // it valid and the state serialisable.
    expect(() => JSON.stringify(state)).not.toThrow();
  });

  it("is fully deterministic: two identical runs produce identical states", async () => {
    const a = await playOneWindow();
    const b = await playOneWindow();
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(a.stats).toEqual(b.stats);
    expect(a.advisorTexts).toEqual(b.advisorTexts);
  });
});
