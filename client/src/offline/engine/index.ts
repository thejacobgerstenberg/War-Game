/**
 * Engine access shim for the offline build. The engine (server/src/engine, main @ b05b213)
 * has ZERO Node deps (facts §1) and bundles as-is. ALL offline modules import engine symbols
 * from THIS file only — never reach into server/src directly elsewhere.
 *
 * NOTE: `server/src/engine/index.ts` does not re-export `tactics.js`, but the vendored
 * HARD bot policy needs `TACTIC_CARD_BY_ID`. It is re-exported here explicitly so the
 * shim stays the single engine entry point (the engine barrel itself is not edited).
 */
export * from "../../../../server/src/engine/index.js";
export { TACTIC_CARD_BY_ID } from "../../../../server/src/engine/tactics.js";
