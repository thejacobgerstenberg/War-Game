/**
 * economy.ts — income, upkeep, trade and building subsystem (stubbed).
 *
 * Owns the Income phase (§4.1), taxation (§4.2), market/route trade (§4.3/§5),
 * upkeep & starvation (§4.4), and building/great-work construction (§9). Reads
 * every number from balance.ts. Functions are pure and return new GameState
 * (except {@link computeIncome}, a read-only projection).
 */
import type { GameAction, GameState, ResourceBundle } from "@imperium/shared";

/** Result of projecting each player's income for the round. */
export interface IncomeResult {
  /** Net income bundle by player id (province yields + buildings + routes − tax). */
  perPlayer: Record<string, ResourceBundle>;
  /** Grain shortfall by player id (positive = grain owed after stores). */
  shortfall: Record<string, number>;
}

/**
 * Project income for every player without mutating state (§4.1). Sums owned
 * province yields, building bonuses, tax multiplier and trade-route gold, and
 * reports each player's grain shortfall for the upkeep step.
 */
export function computeIncome(state: GameState): IncomeResult {
  // TODO(economy): full §4.1 income with buildings, routes and tax posture.
  const perPlayer: Record<string, ResourceBundle> = {};
  const shortfall: Record<string, number> = {};
  for (const p of state.players) {
    perPlayer[p.id] = { gold: 0, grain: 0, timber: 0, stone: 0, faith: 0 };
    shortfall[p.id] = 0;
  }
  return { perPlayer, shortfall };
}

/**
 * Resolve the whole Income phase: credit income into treasuries, run
 * {@link upkeep} (grain payment + starvation desertion), pay tribute treaties,
 * and log the results. Pure.
 */
export function applyIncomePhase(state: GameState): GameState {
  // TODO(economy): credit computeIncome, then upkeep + tribute settlement.
  return state;
}

/**
 * Pay grain upkeep for all armies/fleets and resolve starvation desertion in
 * DESERTION_ORDER (mercenaries first, at double rate) per §4.4. Pure.
 */
export function upkeep(state: GameState): GameState {
  // TODO(economy): grain due, convert stores, desert lowest-value first.
  return state;
}

/**
 * Apply a TRADE action: a market conversion (CONVERT) or a trade-route
 * establishment/reassignment (ROUTE), validated against MARKET_RATIOS / TRADE.
 * Pure. Assumes the action has already passed legality checks in the reducer.
 */
export function applyTrade(state: GameState, action: GameAction): GameState {
  // TODO(economy): CONVERT at applicable ratio | ROUTE income setup.
  void action;
  return state;
}

/**
 * Apply a BUILD action: construct a building or invest a round into a great
 * work (§9), charging the cost from balance.BUILDING_COSTS / GREAT_WORK_COSTS.
 * Pure.
 */
export function applyBuild(state: GameState, action: GameAction): GameState {
  // TODO(economy): deduct cost, add BuildingType | advance GreatWorkProgress.
  void action;
  return state;
}
