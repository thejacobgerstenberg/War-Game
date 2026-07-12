/**
 * tactics/index.ts — barrel for the tactic-deck subsystem (§7.7).
 *
 * PREP2 scaffolding. Re-exports the tactic card data + deck builder. The tactic
 * agent adds the play/draw/resolve subsystem functions here (see CONTRACT2 for the
 * proposed signatures: `drawTactic`, `playTactic`, `resolveTacticEffect`, …) and
 * the integrator wires this barrel into `engine/index.ts`.
 */
export * from "./cards.js";
// The tactic subsystem (draw/queue/play/resolve) lives in the sibling flat file
// `../tactics.ts`; surface it through this barrel so combat/roundLoop/actions can
// import `playTactic`, `drawTactic`, etc. from `./tactics/index.js`.
export {
  drawTactic,
  discardToHandLimit,
  queueTactic,
  playTactic,
  playSiegeTactic,
  playGlobalTactic,
  resolveTacticEffect,
  type BattleSide,
  type TacticEffectContext,
} from "../tactics.js";
