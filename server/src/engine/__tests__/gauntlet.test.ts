/**
 * gauntlet.test.ts — the FAST Integration Gauntlet (CI subset, target a few sec).
 *
 * Drives full 16-round IMPERIUM games (2..5 players) with deterministic bots and
 * asserts a battery of cross-cutting invariants after every applied mutation. The
 * heavy 200-game fuzz lives in `server/scripts/gauntlet.mjs`
 * (`node --import tsx scripts/gauntlet.mjs`). All logic lives in
 * `./gauntletHarness.ts`; this file only runs a bounded subset and asserts.
 *
 * STACKING INVARIANT (FL-02, now FIXED): vassal LEVIES previously bypassed the
 * §6.4 land stacking limit — `diplomacy.runRevolts` (auto levy every
 * `VASSAL.levyEveryRounds`) and `actions.applyLevyCall` (manual LEVY_CALL) both
 * added LEVY onto the overlord's stack at the vassalised minor's capital with no
 * stacking check, so a long-held vassal could accumulate past the 8-land cap.
 * Both levy paths now clamp to remaining capacity (RECRUIT/MOVE already enforced
 * the cap). This suite asserts ZERO stacking violations — the former
 * vassal-levy quarantine has been removed now that the fuzz gauntlet reports 0/200.
 */
import { describe, it, expect } from "vitest";
import {
  runGame,
  determinismCheck,
  type GameReport,
  type Strategy,
} from "./gauntletHarness.js";

const STRATEGIES: Strategy[] = ["aggressive", "trader", "turtle", "random"];

describe("Integration Gauntlet — scripted full games (2..5 players)", () => {
  // 5-player 16-round games under each scripted strategy, plus 2p/3p/4p games.
  const configs: { np: number; strat: Strategy }[] = [];
  for (const np of [2, 3, 4, 5]) {
    for (const strat of ["aggressive", "trader", "turtle"] as Strategy[]) {
      configs.push({ np, strat });
    }
  }

  for (const { np, strat } of configs) {
    it(`${np}-player ${strat} game runs to completion without crashing`, () => {
      const seed = 7000 + np * 31 + strat.length;
      const r = runGame({ numPlayers: np, seed, strategy: strat, checkInvariants: true });

      // No crash (a non-EngineError thrown by applyAction/advancePhase).
      expect(r.crash, r.crash ? `${r.crash.where} ${r.crash.errorName}: ${r.crash.message}\n${r.crash.stack}` : "").toBeNull();
      // No deadlock (phase machine always progressed).
      expect(r.deadlock, r.deadlock ?? "").toBeNull();
      // Reached a terminal state (a winner, or the round-16 endgame).
      expect(["winner", "round16"]).toContain(r.endedReason);
      expect(r.finalRound).toBeLessThanOrEqual(16);

      // FL-02 fixed: ZERO invariant violations tolerated (stacking now enforced
      // on the levy paths too).
      expect(
        r.violations,
        `unexpected invariant violations:\n${r.violations.map((v) => `  [${v.invariant}] ${v.detail} @${v.phase} r${v.round} after ${v.action}`).join("\n")}`,
      ).toEqual([]);
    });
  }
});

describe("Integration Gauntlet — bounded fuzz (invariants every mutation)", () => {
  it("16 randomized games throw nothing and hold all invariants (a)-(h) incl. stacking", () => {
    const reports: GameReport[] = [];
    for (let i = 0; i < 16; i += 1) {
      const np = 2 + (i % 4);
      const strat = STRATEGIES[i % STRATEGIES.length];
      const seed = (900000 + i * 2654435761) >>> 0;
      reports.push(runGame({ numPlayers: np, seed, strategy: strat, checkInvariants: true }));
    }

    const crashed = reports.filter((r) => r.crash);
    expect(
      crashed,
      crashed.map((r) => `seed=${r.seed}: ${r.crash?.where} ${r.crash?.errorName}: ${r.crash?.message}`).join("\n"),
    ).toEqual([]);

    const deadlocked = reports.filter((r) => r.deadlock);
    expect(
      deadlocked,
      deadlocked.map((r) => `seed=${r.seed}: ${r.deadlock}`).join("\n"),
    ).toEqual([]);

    // FL-02 fixed: no stacking (or any) invariant breach is tolerated.
    const unexpected: string[] = [];
    for (const r of reports) {
      for (const v of r.violations) {
        unexpected.push(`seed=${r.seed} ${r.numPlayers}p ${r.strategy}: [${v.invariant}] ${v.detail} @${v.phase} r${v.round}`);
      }
    }
    expect(unexpected, unexpected.join("\n")).toEqual([]);

    // Every game reached a terminal state.
    for (const r of reports) {
      expect(["winner", "round16"], `seed=${r.seed} ended ${r.endedReason}`).toContain(r.endedReason);
    }
  });
});

describe("Integration Gauntlet — determinism (same seed → byte-identical final state)", () => {
  const cases: { np: number; strat: Strategy }[] = [
    { np: 2, strat: "aggressive" },
    { np: 3, strat: "random" },
    { np: 4, strat: "trader" },
    { np: 5, strat: "turtle" },
  ];
  for (const { np, strat } of cases) {
    it(`${np}-player ${strat} game is deterministic across two runs`, () => {
      const d = determinismCheck({ numPlayers: np, seed: 4242 + np, strategy: strat });
      expect(d.identical, d.firstDiff ?? "").toBe(true);
    });
  }
});

describe("Integration Gauntlet — FL-02 regression guard (vassal-levy stacking fixed)", () => {
  it("the §6.4 land-stacking limit holds on the seeds that used to breach it", () => {
    // Seeds previously observed to vassalise & hold Serbia long enough for levies
    // to pile past the 8-land cap. With FL-02's levy clamp they must now be clean.
    const seeds = [2802462286, 3724942645, 374037157].map((s) => s >>> 0);
    for (const seed of seeds) {
      const np = 3 + (seed % 2);
      const r = runGame({ numPlayers: np, seed, strategy: "trader", checkInvariants: true });
      const stacking = r.violations.filter((x) => x.invariant.startsWith("h:stack-limit"));
      expect(
        stacking,
        `seed=${seed}: stacking breach after FL-02 fix:\n${stacking.map((v) => `  ${v.detail} @${v.phase} r${v.round}`).join("\n")}`,
      ).toEqual([]);
    }
  });
});
