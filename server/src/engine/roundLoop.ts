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
import {
  GamePhase,
  type Faction,
  type GameState,
  type UnitType,
  type UnitVariantStack,
} from "@imperium/shared";
import {
  ACTIONS_PER_ROUND,
  ERA_BOUNDARIES,
  ROUNDS,
  WALL_REPAIR_PER_ROUND,
  WALL_TIERS,
} from "./balance.js";
import { makeRng } from "./rng.js";
import { appendLog } from "./logEntry.js";
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
 * Reset every player's per-round action budget (§9.1 / §10.0): base 4, +1 per
 * card-posted 'action_bonus' modifier. Only "certain cards" may raise the budget
 * to 5 (§10.0). FL-11 / CANON #2: the University does NOT grant a 5th action — its
 * documented effect (§9.1) is a +1 tactic-card DRAW, implemented in tactics.ts
 * (`universityDrawBonus`); the former University action bonus here was a fabricated
 * rule and has been removed.
 */
function resetActionBudgets(state: GameState): GameState {
  const bonusFor = (playerId: string, faction: Faction | null): number => {
    let bonus = 0;
    // §10.0 certain cards can grant an extra action (side-channel).
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
 * §13.4 turn-order reshuffle — the CATCH-UP lever. Re-sort `turnOrder` so the
 * "lowest-prestige power acts first next round" (§13.4, verbatim: "initiative to
 * the underdog"); §13.4 tiebreak is "fewer provinces". A final id comparison is a
 * §14 determinism-only tiebreak (reached ONLY when prestige AND province count are
 * equal), making the ordering total and reproducible — it does not alter the
 * §13.4 rule. The active-player pointer resets to the head of the fresh order.
 * §13.4 ratifies exactly this lowest-prestige-first order: NO first-player token,
 * NO extra-action bonus — the whole catch-up is the initiative reshuffle itself.
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

/**
 * §6.4 / §10 phase-5 deferred occupation flip. When a stack marches unopposed
 * into an empty enemy/neutral province, `actions.ts::relocate` moves the stack
 * WITHOUT flipping `ownerId` and records a `pendingOccupations` entry. At END
 * cleanup we flip `ownerId` to the occupant for every entry that is still
 * occupied-and-uncontested (occupant still has live units there and no rival
 * stack contests the tile), then clear the queue. A contested tile would have
 * queued a battle resolved in COMBAT, so by cleanup an uncontested hold flips.
 */
function flipPendingOccupations(state: GameState): GameState {
  const pending = state.pendingOccupations ?? [];
  if (pending.length === 0) return state;

  const stackCount = (
    units: Record<UnitType, number>,
    variants?: UnitVariantStack[],
  ): number =>
    Object.values(units).reduce((s, n) => s + (n ?? 0), 0) +
    (variants?.reduce((s, v) => s + v.count, 0) ?? 0);

  const provinces = state.provinces.map((prov) => {
    const entry = pending.find((e) => e.provinceId === prov.id);
    if (!entry) return prov;
    // Still occupied: the occupant has at least one live unit in the province.
    const occupantHolds = state.armies.some(
      (a) => a.ownerId === entry.occupantId && a.locationId === prov.id && stackCount(a.units, a.variants) > 0,
    );
    // Uncontested: no rival (non-occupant) stack contests the tile.
    const contested = state.armies.some(
      (a) => a.ownerId !== entry.occupantId && a.locationId === prov.id && stackCount(a.units, a.variants) > 0,
    );
    if (!occupantHolds || contested) return prov;
    // §6.4 occupation of an undefended enemy/neutral tile resolves at cleanup.
    return { ...prov, ownerId: entry.occupantId, garrison: 0 };
  });

  // Clear the queue — every pending occupation is resolved (flipped or dropped).
  return { ...state, provinces, pendingOccupations: [] };
}

/**
 * §8.1 / §8.2.5 PER-ROUND WALL REPAIR (marshal major "walls only repair on
 * siege-lift, not per round"): every province whose walls are damaged AND not
 * under an ACTIVE siege (no live `siegeStates` entry) regains
 * {@link WALL_REPAIR_PER_ROUND} (+1) Wall HP, clamped to its tier maximum
 * ({@link WALL_TIERS}). §8.1: "HP damage *within* a tier heals at +1 HP/round
 * out of siege (§8.2.5)" — a standing per-round rule, not a lift-moment event.
 * Applied at the head of INCOME (§10 phase 1-2 upkeep bookkeeping): repair for
 * a round happens once, before that round's action window can declare new
 * sieges, and it never double-counts the combat subsystem's §8.2.5 lift tick
 * ("walls begin to repair"), which fires inside COMBAT when the siege breaks.
 */
function repairWalls(state: GameState): GameState {
  let changed = false;
  const provinces = state.provinces.map((prov) => {
    if (prov.walls.tier === 0) return prov;
    const maxHp = WALL_TIERS[prov.walls.tier]?.hp ?? prov.walls.hp;
    if (prov.walls.hp >= maxHp) return prov;
    // §8.2.5: no repair while a live siege invests the city.
    if (state.siegeStates.some((s) => s.provinceId === prov.id)) return prov;
    changed = true;
    return {
      ...prov,
      walls: {
        ...prov.walls,
        hp: Math.min(maxHp, prov.walls.hp + WALL_REPAIR_PER_ROUND),
      },
    };
  });
  return changed ? { ...state, provinces } : state;
}

/**
 * COMBAT-phase ERROR CONTAINMENT (marshal major "a failing queued tactic throws
 * inside auto-COMBAT and crashes phase advance" — roundLoop belt-and-braces over
 * combat.ts's per-tactic containment): an unexpected throw from ONE battle/siege
 * resolution is logged and that engagement skipped; the phase still advances and
 * the remaining engagements still resolve. This guards ONLY the automatic
 * COMBAT resolution path — EngineError validation in the ACTION (reducer) path
 * is never masked here.
 */
function containResolutionFailure(
  state: GameState,
  kind: "battle" | "siege",
  id: string,
  actors: string[],
  target: string | undefined,
  err: unknown,
): GameState {
  const message = err instanceof Error ? err.message : String(err);
  return appendLog(state, {
    round: state.round,
    phase: state.phase,
    type: kind,
    actors,
    targets: target ? [target] : [],
    message: `A ${kind} resolution failed and was skipped (${id}): ${message}`,
    data: { contained: true, kind, id, error: message },
  });
}

/** Resolve every pending battle, naval engagement and siege for the round. */
function resolveCombatPhase(state: GameState): GameState {
  // ONE rng stream for the whole phase; the advanced cursor is persisted below
  // so every die (battles, sieges, rerolls) is a pure function of (seed, cursor).
  const rng = makeRng(state.rngSeed, state.rngCursor);
  let next = state;

  for (const battle of state.pendingBattles) {
    try {
      const result = battle.seaZoneId
        ? resolveNaval(next, battle, rng)
        : resolveBattle(next, battle, rng);
      next = result.state;
    } catch (err) {
      next = containResolutionFailure(
        next,
        "battle",
        battle.id,
        [battle.attackerId, ...(battle.defenderId ? [battle.defenderId] : [])],
        battle.provinceId ?? battle.seaZoneId,
        err,
      );
    }
  }
  // §8.2 step 1: iterate the POST-battle siege list — combat.ts::resolveSiege
  // opens with the siege-lock recomputation (besiegers counted from physical
  // unit locations; a relief battle above may have just destroyed them), so the
  // lock is re-derived immediately before each siege resolves.
  for (const siege of [...next.siegeStates]) {
    try {
      next = resolveSiege(next, siege, rng).state;
    } catch (err) {
      next = containResolutionFailure(
        next,
        "siege",
        siege.id ?? siege.provinceId,
        [siege.besiegerId],
        siege.provinceId,
        err,
      );
    }
  }

  return { ...next, rngCursor: rng.cursor };
}

/**
 * §8.2 step 4 / STAGE-B-PREP §2.3: assault declarations are strictly per-round.
 * combat.ts consumes+clears the flag when it resolves a siege; the round loop
 * clears it here for EVERY surviving siege after COMBAT (belt and braces — a
 * contained/skipped resolution must not leave a stale declaration that would
 * auto-assault next round). Both the `siegeStates` entry and its per-province
 * `siege` mirror are cleared.
 */
function clearAssaultDeclarations(state: GameState): GameState {
  const staleSiege = state.siegeStates.some((s) => s.assaultDeclared === true);
  const staleMirror = state.provinces.some((p) => p.siege?.assaultDeclared === true);
  if (!staleSiege && !staleMirror) return state;
  return {
    ...state,
    siegeStates: state.siegeStates.map((s) =>
      s.assaultDeclared === true ? { ...s, assaultDeclared: false } : s,
    ),
    provinces: state.provinces.map((p) =>
      p.siege?.assaultDeclared === true
        ? { ...p, siege: { ...p.siege, assaultDeclared: false } }
        : p,
    ),
  };
}

/**
 * §7.7 48-card tactic-deck conservation (marshal minor, roundLoop:210): cards
 * still QUEUED on a pending battle when COMBAT ends were paid for at PLAY_TACTIC
 * but never resolved (the battle ended in fewer rounds than cards queued, or a
 * contained failure skipped the engagement). Clearing `pendingBattles` without
 * sweeping them would leak them out of the 48-card economy — so they are swept
 * into `tacticDiscard` (unresolved ⇒ never "remove from game") with a log line.
 */
function sweepUnresolvedTactics(state: GameState): GameState {
  const leaked = state.pendingBattles.flatMap((pb) => [
    ...(pb.attackerTactics ?? []),
    ...(pb.defenderTactics ?? []),
  ]);
  if (leaked.length === 0) return state;
  const swept: GameState = {
    ...state,
    tacticDiscard: [...(state.tacticDiscard ?? []), ...leaked],
  };
  return appendLog(swept, {
    round: swept.round,
    phase: swept.phase,
    type: "event_card",
    actors: [],
    data: { deck: "tactic", action: "sweep_unresolved", cards: leaked },
    message: `${leaked.length} queued tactic card(s) left unresolved at COMBAT end are discarded.`,
  });
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
      // 3b) §8.1/§8.2.5 per-round wall repair (marshal major): every damaged,
      //     un-besieged wall regains WALL_REPAIR_PER_ROUND HP up to its tier max.
      next = repairWalls(next);
      // §13.4 catch-up: re-apply the underdog-first order at the head of the round.
      // The CANONICAL §13.4 reshuffle is settled at CLEANUP (see the END case) on
      // the final scored prestige; this INCOME re-sort (a) seeds ROUND 1, which has
      // no preceding cleanup, and (b) re-orders after the Omen sub-phase, which may
      // shift prestige/holdings, so players act in true lowest-prestige-first order
      // for the round they are about to play (also the round-head behaviour pinned
      // by actions.test.ts §13.4).
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
      // Resolution order: battles (incl. relief) → siege-lock recompute + siege
      // resolution (inside resolveSiege) — then the per-round bookkeeping below.
      let next = resolveCombatPhase(state);
      // §7.7 sweep queued-but-unresolved tactic cards BEFORE pendingBattles is
      // cleared (48-card conservation, marshal minor roundLoop:210).
      next = sweepUnresolvedTactics(next);
      // §8.2 step 4: assault declarations never carry over — clear after COMBAT.
      next = clearAssaultDeclarations(next);
      return { ...next, phase: GamePhase.END, pendingBattles: [] };
    }

    case GamePhase.END: {
      // §10 phase 5 cleanup, ordered so `prestige_pending` is CONSUMED before it
      // EXPIRES (no double-count, CONTRACT2 §12.8): scorePrestige → runRevolts →
      // checkVictory → expireRoundModifiers. Tactic hands are pruned here too (§7.7).
      // 0) §6.4 / §10 phase-5: flip ownership of provinces still occupied-and-
      //    uncontested BEFORE scoring, so newly-held tiles count toward prestige
      //    and victory this cleanup. (MOVE-time deferral lives in actions.ts.)
      let next = flipPendingOccupations(state);
      // 1) §13.1 score per-round prestige + consume conquest-track prestige_pending.
      next = scorePrestige(next);
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
      // §13.4 "At cleanup, `turnOrder` is re-sorted so the lowest-prestige power
      // acts first next round" — the catch-up lever, settled HERE at cleanup on the
      // freshly-scored prestige (step 1 scorePrestige) and post-revolt province
      // counts (step 2 runRevolts). This is the canonical §13.4 placement; it runs
      // AFTER the four-step cleanup order (scorePrestige → runRevolts → checkVictory
      // → expireRoundModifiers), leaving that order intact, and ONLY in the
      // round-advance branch (a game that just ended has no "next round" to reorder).
      next = sortTurnOrder(next);
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
