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
import { BuildingType, GamePhase, type Faction, type GameState } from "@imperium/shared";
import {
  ACTIONS_PER_ROUND,
  ERA_BOUNDARIES,
  ROUNDS,
  UNIVERSITY_ACTION_BONUS,
} from "./balance.js";
import { makeRng } from "./rng.js";
import { drawOmen } from "./events/index.js";
import { applyIncomePhase } from "./economy.js";
import { resolveBattle, resolveNaval, resolveSiege } from "./combat.js";
import { runRevolts } from "./diplomacy.js";
import { refreshMercMarket } from "./mercenaries.js";
import { scorePrestige, checkVictory } from "./prestige.js";
import { drawTactic, discardToHandLimit } from "./tactics.js";
import { expireRoundModifiers } from "./modifiers.js";

/** The era (1|2|3) that a given round belongs to (§10 / EVENT_CARDS). */
export function eraForRound(round: number): 1 | 2 | 3 {
  for (const era of [1, 2, 3] as const) {
    const [first, last] = ERA_BOUNDARIES[era];
    if (round >= first && round <= last) return era;
  }
  return 3;
}

/**
 * Reset every player's per-round action budget (§10.0): 4 base, +1 if the player
 * owns a University province, +1 per card-posted 'action_bonus' modifier.
 */
function resetActionBudgets(state: GameState): GameState {
  const bonusFor = (playerId: string, faction: Faction | null): number => {
    let bonus = 0;
    // §10.0 a University raises the budget to 5.
    const hasUniversity = state.provinces.some(
      (prov) =>
        prov.ownerId === playerId &&
        prov.buildings.includes(BuildingType.UNIVERSITY),
    );
    if (hasUniversity) bonus += UNIVERSITY_ACTION_BONUS;
    // §10.0 certain cards can also grant an extra action (side-channel).
    for (const mod of state.activeModifiers) {
      if (mod.kind !== "action_bonus") continue;
      if (
        mod.data?.playerId === playerId ||
        (faction != null && mod.target?.faction === faction)
      ) {
        bonus += mod.value ?? 1;
      }
    }
    return bonus;
  };
  return {
    ...state,
    players: state.players.map((p) => ({
      ...p,
      actionsRemaining: ACTIONS_PER_ROUND + bonusFor(p.id, p.faction),
    })),
  };
}

/**
 * §13.4 turn-order reshuffle: re-sort `turnOrder` so the lowest-prestige power
 * acts first (initiative to the underdog; tiebreak fewer provinces, then id for
 * determinism) and reset the active-player pointer to the head of the order.
 */
function sortTurnOrder(state: GameState): GameState {
  const provinceCount = (playerId: string): number =>
    state.provinces.filter((prov) => prov.ownerId === playerId).length;
  const prestigeOf = (playerId: string): number =>
    state.players.find((p) => p.id === playerId)?.prestige ?? 0;

  const turnOrder = [...state.turnOrder].sort((a, b) => {
    if (prestigeOf(a) !== prestigeOf(b)) return prestigeOf(a) - prestigeOf(b);
    if (provinceCount(a) !== provinceCount(b)) return provinceCount(a) - provinceCount(b);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return { ...state, turnOrder, activePlayerIndex: 0 };
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
      // §13 per-round reset (flagged bug): clear the per-round prestige scratch at
      // the head of every round so it does not accumulate across rounds. The value
      // accrued during round N (income/diplomacy/END scorePrestige) is read for the
      // round-N END summary, then wiped here as round N+1 opens.
      let next: GameState = {
        ...state,
        players: state.players.map((p) => ({ ...p, prestigeThisRound: 0 })),
      };
      // §10 phase-table ordering: Omen → tactic draw → income → upkeep.
      // 1) Omen sub-phase sits at the front of INCOME (§10 phase 1): draw+resolve one card.
      next = drawOmen(next);
      // 2) §7.7 tactic draw: each player draws 1 tactic card (+University bonuses)
      //    during Income, BEFORE income/upkeep is credited (CONTRACT2 §12.9). Draw
      //    order follows the roster; drawTactic derives/persists the rng cursor.
      for (const id of next.players.map((p) => p.id)) {
        next = drawTactic(next, id);
      }
      // 3) §10 phase 2: credit income then upkeep + starvation. applyIncomePhase
      //    already runs upkeep + starvation internally (§4.4), so upkeep is not
      //    invoked again here (that would double-charge grain).
      next = applyIncomePhase(next);
      // §13.4 initiative to the underdog: lowest prestige acts first this round.
      // (Equivalent to the §13.4 cleanup reshuffle — prestige is unchanged between
      // END and the next INCOME — and this placement also orders the first round.)
      next = sortTurnOrder(next);
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
      // §10 phase 5 cleanup, ordered so `prestige_pending` is CONSUMED before it
      // EXPIRES (no double-count, CONTRACT2 §12.8): scorePrestige → runRevolts →
      // checkVictory → expireRoundModifiers. Tactic hands are pruned here too (§7.7).
      // 1) §13.1 score per-round prestige + consume conquest-track prestige_pending.
      let next = scorePrestige(state);
      // 2) §11.5 conquered-minor / heavy-tax revolts.
      next = runRevolts(next);
      // 3) §7.7 cleanup: discard each hand down to TACTIC_HAND_LIMIT.
      for (const id of next.players.map((p) => p.id)) {
        next = discardToHandLimit(next, id);
      }
      // 4) §13.2 victory is checked ONLY at cleanup (never mid-round).
      const winner = checkVictory(next);
      // 5) Expire round-scoped modifiers AFTER scorePrestige has consumed the
      //    prestige_pending awards. scope:'round' modifiers and any whose
      //    expiresRound<=round lapse; persistent trade-route modifiers survive.
      next = expireRoundModifiers(next);
      if (winner || next.round >= ROUNDS) {
        // §13.2 threshold reached, or §13.3 round-16 "1453" endgame: game ends.
        return { ...next, phase: GamePhase.END, winner: winner ?? next.winner };
      }
      const round = next.round + 1;
      // §6.3 refresh the mercenary market for the new round.
      next = refreshMercMarket(next);
      return {
        ...next,
        phase: GamePhase.INCOME,
        round,
        turn: round,
        // §10 era boundaries (era 1: r1–5, era 2: r6–10, era 3: r11–16).
        era: eraForRound(round),
      };
    }

    default:
      return state;
  }
}
