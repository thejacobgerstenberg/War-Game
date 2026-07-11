/**
 * Per-turn economic income for a player: the sum of owned-province yields, less
 * the grain upkeep of that player's standing armies.
 */
import {
  EMPTY_RESOURCES,
  type GameState,
  type ResourceBundle,
} from "@imperium/shared";

/** Grain consumed per unit, per turn. */
export const UPKEEP_GRAIN_PER_UNIT = 1;

/** Total unit count across all of a player's armies. */
export function totalArmyUnits(state: GameState, playerId: string): number {
  let count = 0;
  for (const army of state.armies) {
    if (army.ownerId !== playerId) continue;
    for (const n of Object.values(army.units)) count += n;
  }
  return count;
}

/**
 * Compute net income for {@link playerId}.
 *
 * Gold/timber/stone/faith are the raw sums of owned province yields. Grain is
 * the raw grain yield minus the army's grain upkeep, and may be negative when a
 * player fields more troops than their provinces can feed.
 */
export function computeIncome(
  state: GameState,
  playerId: string,
): ResourceBundle {
  const income: ResourceBundle = { ...EMPTY_RESOURCES };

  for (const province of state.provinces) {
    if (province.ownerId !== playerId) continue;
    income.gold += province.yields.gold;
    income.grain += province.yields.grain;
    income.timber += province.yields.timber;
    income.stone += province.yields.stone;
    income.faith += province.yields.faith;
  }

  const upkeep = totalArmyUnits(state, playerId) * UPKEEP_GRAIN_PER_UNIT;
  income.grain -= upkeep;

  return income;
}
