/**
 * roundLoop.ts — the phase/turn state machine (skeleton).
 *
 * `advancePhase` walks the five conceptual phases of a round
 * (Omen → Income → action phases → Combat → Cleanup, §10) by delegating to the
 * subsystem functions. The delegated functions are currently stubs that return
 * state unchanged, so this file establishes the *orchestration contract* and the
 * per-round action-budget bookkeeping; subsystem agents fill in their own file.
 *
 * Pure: the COMBAT phase owns a single RNG stream (seed+cursor from state) and
 * writes the advanced cursor back into the returned state.
 */
import { GamePhase, type GameState } from "@imperium/shared";
import { ACTIONS_PER_ROUND, ERA_BOUNDARIES, ROUNDS } from "./balance.js";
import { makeRng } from "./rng.js";
import { drawOmen } from "./events/index.js";
import { applyIncomePhase } from "./economy.js";
import { resolveBattle, resolveNaval, resolveSiege } from "./combat.js";
import { runRevolts } from "./diplomacy.js";
import { refreshMercMarket } from "./mercenaries.js";
import { scorePrestige, checkVictory } from "./prestige.js";

/** The era (1|2|3) that a given round belongs to (§10 / EVENT_CARDS). */
export function eraForRound(round: number): 1 | 2 | 3 {
  for (const era of [1, 2, 3] as const) {
    const [first, last] = ERA_BOUNDARIES[era];
    if (round >= first && round <= last) return era;
  }
  return 3;
}

/** Reset every player's per-round action budget (§10.0). */
function resetActionBudgets(state: GameState): GameState {
  // TODO(roundLoop): add University/card bonuses (UNIVERSITY_ACTION_BONUS).
  return {
    ...state,
    players: state.players.map((p) => ({
      ...p,
      actionsRemaining: ACTIONS_PER_ROUND,
    })),
  };
}

/** Resolve every pending battle, naval engagement and siege for the round. */
function resolveCombatPhase(state: GameState): GameState {
  const rng = makeRng(state.rngSeed, state.rngCursor);
  let next = state;

  for (const battle of state.pendingBattles) {
    const result = battle.seaZoneId
      ? resolveNaval(next, battle, rng)
      : resolveBattle(next, battle, rng);
    next = result.state;
  }
  for (const siege of state.siegeStates) {
    next = resolveSiege(next, siege, rng).state;
  }

  return { ...next, rngCursor: rng.cursor };
}

/**
 * Advance the game one phase. Returns a new GameState. The action phases
 * (RECRUITMENT/MOVEMENT/DIPLOMACY) are driven by player {@link GameAction}s via
 * the reducer; `advancePhase` transitions between them and runs the automatic
 * phases (Omen+Income, Combat, Cleanup) by calling the subsystems.
 */
export function advancePhase(state: GameState): GameState {
  switch (state.phase) {
    case GamePhase.LOBBY:
      return { ...state, phase: GamePhase.INCOME };

    case GamePhase.INCOME: {
      // Omen sub-phase sits at the front of INCOME (§10 phase 1), then income.
      let next = drawOmen(state);
      next = applyIncomePhase(next);
      next = resetActionBudgets(next);
      return { ...next, phase: GamePhase.RECRUITMENT };
    }

    case GamePhase.RECRUITMENT:
      return { ...state, phase: GamePhase.MOVEMENT };

    case GamePhase.MOVEMENT:
      return { ...state, phase: GamePhase.DIPLOMACY };

    case GamePhase.DIPLOMACY:
      return { ...state, phase: GamePhase.COMBAT };

    case GamePhase.COMBAT: {
      const next = resolveCombatPhase(state);
      return { ...next, phase: GamePhase.END, pendingBattles: [] };
    }

    case GamePhase.END: {
      // Cleanup: score prestige, resolve revolts, check victory, refresh merc
      // market, then roll into the next round (or end the game at round 16).
      let next = scorePrestige(state);
      next = runRevolts(next);
      const winner = checkVictory(next);
      if (winner || next.round >= ROUNDS) {
        return { ...next, phase: GamePhase.END, winner: winner ?? next.winner };
      }
      const round = next.round + 1;
      next = refreshMercMarket(next);
      return {
        ...next,
        phase: GamePhase.INCOME,
        round,
        turn: round,
        era: eraForRound(round),
      };
    }

    default:
      return state;
  }
}
