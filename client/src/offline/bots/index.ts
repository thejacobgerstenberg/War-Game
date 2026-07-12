/**
 * VENDORED from server/src/bots/index.ts @ 9009d5262afd983392c565e1d5e51bbdf31da92b
 * (PR #27 "Server: AI opponents", branch feature/ai-opponents — not on main yet).
 * Local changes: (1) engine imports rewritten to the offline engine shim;
 * (2) `.coastal` -> `.port` (main #28 renamed Province.coastal to Province.port);
 * (3) nothing else. Do not add logic here; upstream replaces this after #27 merges.
 */
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
