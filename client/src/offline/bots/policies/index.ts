/**
 * VENDORED from server/src/bots/policies/index.ts @ 9009d5262afd983392c565e1d5e51bbdf31da92b
 * (PR #27 "Server: AI opponents", branch feature/ai-opponents — not on main yet).
 * Local changes: (1) engine imports rewritten to the offline engine shim;
 * (2) `.coastal` -> `.port` (main #28 renamed Province.coastal to Province.port);
 * (3) nothing else. Do not add logic here; upstream replaces this after #27 merges.
 */
/**
 * Policy registry: difficulty → {@link Policy}.
 *
 * Each difficulty's policy lives in its own file (easy.ts / normal.ts /
 * hard.ts, currently compiling placeholders) so parallel implementers each
 * own exactly one file. Shared candidate machinery is in candidates.ts.
 */
import { Difficulty, type Policy } from "../types.js";
import { easyPolicy } from "./easy.js";
import { normalPolicy } from "./normal.js";
import { hardPolicy } from "./hard.js";

export { easyPolicy } from "./easy.js";
export { normalPolicy } from "./normal.js";
export { hardPolicy } from "./hard.js";
export * from "./candidates.js";

/** Resolve the policy used for a difficulty tier. */
export function policyForDifficulty(difficulty: Difficulty): Policy {
  switch (difficulty) {
    case Difficulty.EASY:
      return easyPolicy;
    case Difficulty.HARD:
      return hardPolicy;
    case Difficulty.NORMAL:
    default:
      return normalPolicy;
  }
}
