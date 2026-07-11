/**
 * Public entrypoint for the game engine.
 *
 * Re-exports the full engine surface: map/adjacency data, state construction,
 * the balance constants, the deterministic RNG, the log factory, the reducer and
 * every subsystem. NOTE: the legacy `income.ts` module is intentionally NOT
 * re-exported here — its `computeIncome(state, playerId)` would collide with the
 * new `economy.ts` `computeIncome(state)`; import it directly where needed
 * (only its own test does).
 */
export * from "./mapData.js";
export * from "./adjacency.js";
export * from "./balance.js";
export * from "./rng.js";
export * from "./logEntry.js";
export * from "./gameState.js";
export * from "./modifiers.js";
export * from "./factions.js";
export * from "./economy.js";
export * from "./combat.js";
export * from "./diplomacy.js";
export * from "./mercenaries.js";
export * from "./spy.js";
export * from "./prestige.js";
export * from "./roundLoop.js";
export * from "./actions.js";
export * from "./projection.js";
export * from "./events/index.js";
