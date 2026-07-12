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
