/**
 * Battery (d) — difficulty ordering.
 *
 * HARD vs EASY head-to-head over 200 full 2-player games (varied seeds, seat
 * sides alternating every game so neither difficulty owns a faction): HARD
 * must win MORE THAN 65%. NORMAL vs EASY and HARD vs NORMAL are recorded for
 * the win-matrix report with no threshold assertion (per the battery spec —
 * only completion hygiene is asserted on those two).
 *
 * Context for readers of the matrix: the 2p pairing (Byzantium vs Ottoman)
 * is heavily faction-imbalanced — in EASY-vs-EASY mirrors the Ottoman seat
 * wins ~84% — so a difficulty must overcome the map, not just the opponent,
 * to clear 65% with sides alternating.
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
    `records NORMAL vs EASY over ${GAMES} games (report matrix, no threshold)`,
    async () => {
      const r = await runHeadToHead(Difficulty.NORMAL, Difficulty.EASY, GAMES, SEED_BASE);
      expect(r.winsA + r.winsB).toBe(GAMES);
      expect(r.deadlocks).toBe(0);
      expect(r.fallbackPasses).toBe(0);
      expect(r.outOfTurnRejections).toBe(0);
      console.info(
        `[ordering] NORMAL vs EASY: ${r.winsA}-${r.winsB} (${((100 * r.winsA) / r.games).toFixed(1)}%)`,
      );
    },
    600_000,
  );

  it(
    `records HARD vs NORMAL over ${GAMES} games (report matrix, no threshold)`,
    async () => {
      const r = await runHeadToHead(Difficulty.HARD, Difficulty.NORMAL, GAMES, SEED_BASE);
      expect(r.winsA + r.winsB).toBe(GAMES);
      expect(r.deadlocks).toBe(0);
      expect(r.fallbackPasses).toBe(0);
      expect(r.outOfTurnRejections).toBe(0);
      console.info(
        `[ordering] HARD vs NORMAL: ${r.winsA}-${r.winsB} (${((100 * r.winsA) / r.games).toFixed(1)}%)`,
      );
    },
    600_000,
  );
});
