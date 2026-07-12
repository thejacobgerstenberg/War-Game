/**
 * Barrel for the AI-opponents module.
 *
 * Transport-free: nothing under `bots/` imports socket.io. The lobby-side
 * seat hook lives with the lobby (`../lobby/botSeats.ts`).
 */
export * from "./types.js";
export * from "./rng.js";
export * from "./personality.js";
export * from "./botPlayer.js";
export * from "./policies/index.js";
