/**
 * Battery (d) — difficulty ordering.
 *
 * Head-to-heads over 200 full 2-player games each (varied seeds, seat sides
 * alternating every game so neither difficulty owns a faction):
 *   - HARD vs EASY: HARD must win MORE THAN 65%;
 *   - NORMAL vs EASY: NORMAL must win AT LEAST 60% (competence bound added
 *     with the post-turn-order NORMAL tuning; the ~70% upper edge is a tuning
 *     target, not an assertion);
 *   - HARD vs NORMAL: HARD must win AT LEAST 65% (ordering bound promoted
 *     with the HARD fortress-campaign/economy tuning — the previous
 *     inversion is fixed; observed 66–73% across three seed bases).
 *
 * Context for readers of the matrix: the 2p pairing (Byzantium vs Ottoman)
 * is heavily faction-imbalanced — in EASY-vs-EASY mirrors the Ottoman seat
 * wins ~84% — so a difficulty must overcome the map, not just the opponent,
 * to clear its bound with sides alternating.
 */
import { describe, expect, it } from "vitest";
import { Difficulty } from "../types.js";
import { runHeadToHead } from "./botGauntlet.js";

const GAMES = 200;
const SEED_BASE = 20260711;

describe("bots battery (d) — difficulty ordering", () => {
  it(
    `HARD beats EASY in >65% of ${GAMES} alternating-seat games`,
    async () => {
      const t0 = Date.now();
      const r = await runHeadToHead(Difficulty.HARD, Difficulty.EASY, GAMES, SEED_BASE);
      const elapsed = Date.now() - t0;
      // Hygiene: every game ended with a §13 winner, no deadlocks, and no
      // bot ever ran out of engine-legal candidates.
      expect(r.winsA + r.winsB).toBe(GAMES);
      expect(r.deadlocks).toBe(0);
      expect(r.fallbackPasses).toBe(0);
      expect(r.outOfTurnRejections).toBe(0);
      // The ordering assertion itself.
      expect(r.winsA / r.games).toBeGreaterThan(0.65);
      console.info(
        `[ordering] HARD vs EASY: ${r.winsA}-${r.winsB} (${((100 * r.winsA) / r.games).toFixed(1)}%) over ${GAMES} games in ${elapsed}ms`,
      );
    },
    600_000,
  );

  it(
    `NORMAL beats EASY in >=60% of ${GAMES} alternating-seat games`,
    async () => {
      const r = await runHeadToHead(Difficulty.NORMAL, Difficulty.EASY, GAMES, SEED_BASE);
      expect(r.winsA + r.winsB).toBe(GAMES);
      expect(r.deadlocks).toBe(0);
      expect(r.fallbackPasses).toBe(0);
      expect(r.outOfTurnRejections).toBe(0);
      // The ordering assertion: NORMAL's competence bound over EASY.
      expect(r.winsA / r.games).toBeGreaterThanOrEqual(0.6);
      console.info(
        `[ordering] NORMAL vs EASY: ${r.winsA}-${r.winsB} (${((100 * r.winsA) / r.games).toFixed(1)}%)`,
      );
    },
    600_000,
  );

  it(
    `HARD beats NORMAL in >=65% of ${GAMES} alternating-seat games`,
    async () => {
      // Bound promoted from recorded-only (the post-turn-order NORMAL tuning
      // had inverted this cell): HARD's fortress campaign (blockade →
      // §8.2.3 starvation → chosen SIEGE_ASSAULT storm), the retake of
      // §6.4-occupied own ground, the spy EV gate and the exact §4.4 grain
      // ledger (faction levy economics) restore the ladder — observed
      // 66–73% across three independent seed bases at 200 games each.
      const r = await runHeadToHead(Difficulty.HARD, Difficulty.NORMAL, GAMES, SEED_BASE);
      expect(r.winsA + r.winsB).toBe(GAMES);
      expect(r.deadlocks).toBe(0);
      expect(r.fallbackPasses).toBe(0);
      expect(r.outOfTurnRejections).toBe(0);
      // The ordering assertion: the top of the ladder holds again.
      expect(r.winsA / r.games).toBeGreaterThanOrEqual(0.65);
      console.info(
        `[ordering] HARD vs NORMAL: ${r.winsA}-${r.winsB} (${((100 * r.winsA) / r.games).toFixed(1)}%)`,
      );
    },
    600_000,
  );
});
