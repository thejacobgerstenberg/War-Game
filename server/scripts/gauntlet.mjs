/**
 * gauntlet.mjs — the HEAVY standalone Integration Gauntlet runner.
 *
 * Runs the full ~200-game randomized fuzz plus the scripted full-game battery
 * with per-mutation invariant checks and a determinism replay, then prints a
 * detailed report. This is the "everything" run; the vitest file
 * (server/src/engine/__tests__/gauntlet.test.ts) runs a fast subset for CI.
 *
 * Run from the server workspace:
 *   node --import tsx scripts/gauntlet.mjs
 *   node --import tsx scripts/gauntlet.mjs 500   # override fuzz game count
 */
import {
  runGame,
  determinismCheck,
} from "../src/engine/__tests__/gauntletHarness.ts";

const FUZZ_GAMES = Number(process.argv[2] ?? 200);
const STRATEGIES = ["aggressive", "trader", "turtle", "random"];

let crashes = [];
let violations = [];
let deadlocks = [];
let completed = 0;
let determinismFailures = [];

function record(report) {
  if (report.crash) crashes.push(report);
  if (report.deadlock) deadlocks.push(report);
  if (report.violations.length) violations.push(report);
  if (report.completed) completed += 1;
}

console.log(`\n=== SCRIPTED FULL GAMES ===`);
const scriptedResults = [];
for (const np of [2, 3, 4, 5]) {
  for (const strat of ["aggressive", "trader", "turtle"]) {
    const seed = 1000 + np * 10 + strat.length;
    const r = runGame({ numPlayers: np, seed, strategy: strat, checkInvariants: true });
    scriptedResults.push(r);
    record(r);
    console.log(
      `  ${np}p ${strat.padEnd(10)} seed=${seed} -> ${r.endedReason.padEnd(9)} ` +
        `round=${r.finalRound} winner=${r.winner ?? "-"} ` +
        `actions=${r.actionsApplied} probes=${r.engineErrorProbes} ` +
        `violations=${r.violations.length}` +
        (r.crash ? ` CRASH(${r.crash.errorName})` : "") +
        (r.deadlock ? ` DEADLOCK` : ""),
    );
  }
}

console.log(`\n=== DETERMINISM (same seed x2, byte-identical final state) ===`);
for (const np of [2, 3, 4, 5]) {
  for (const strat of STRATEGIES) {
    const seed = 5000 + np * 7 + strat.length;
    const d = determinismCheck({ numPlayers: np, seed, strategy: strat });
    if (!d.identical) {
      determinismFailures.push({ np, strat, seed, ...d });
      console.log(`  ${np}p ${strat} seed=${seed} -> NON-DETERMINISTIC: ${d.firstDiff}`);
    }
  }
}
if (determinismFailures.length === 0) console.log(`  all 16 (np x strategy) determinism runs byte-identical`);

console.log(`\n=== FUZZ (${FUZZ_GAMES} randomized games, invariants every mutation) ===`);
const t0 = Date.now();
for (let i = 0; i < FUZZ_GAMES; i += 1) {
  const np = 2 + (i % 4);
  const strat = STRATEGIES[i % STRATEGIES.length];
  const seed = 100000 + i * 2654435761;
  const r = runGame({ numPlayers: np, seed: seed >>> 0, strategy: strat, checkInvariants: true });
  record(r);
  if (r.crash || r.deadlock || r.violations.length) {
    console.log(
      `  [game ${i}] ${np}p ${strat} seed=${seed >>> 0} -> ${r.endedReason}` +
        (r.crash ? ` CRASH ${r.crash.errorName}: ${r.crash.message}` : "") +
        (r.deadlock ? ` DEADLOCK: ${r.deadlock}` : "") +
        (r.violations.length ? ` VIOLATIONS(${r.violations.length}): ${r.violations[0].invariant} ${r.violations[0].detail}` : ""),
    );
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const totalGames = scriptedResults.length + FUZZ_GAMES;
console.log(`\n================ GAUNTLET SUMMARY ================`);
console.log(`  total games run     : ${totalGames} (${scriptedResults.length} scripted + ${FUZZ_GAMES} fuzz)`);
console.log(`  completed (no crash): ${completed}`);
console.log(`  crashes             : ${crashes.length}`);
console.log(`  deadlocks           : ${deadlocks.length}`);
console.log(`  invariant games     : ${violations.length}`);
console.log(`  determinism failures: ${determinismFailures.length}`);
console.log(`  fuzz wall time      : ${elapsed}s`);

if (crashes.length) {
  console.log(`\n--- CRASH DETAIL (first 5) ---`);
  for (const r of crashes.slice(0, 5)) {
    console.log(
      `  seed=${r.seed} ${r.numPlayers}p ${r.strategy}: ${r.crash.where} threw ` +
        `${r.crash.errorName} at phase=${r.crash.phase} round=${r.crash.round}\n` +
        `    message: ${r.crash.message}\n` +
        `    action : ${r.crash.action ?? "(advancePhase)"}\n` +
        `    stack  : ${(r.crash.stack ?? "").split("\n").slice(0, 4).join("\n             ")}`,
    );
  }
}
if (violations.length) {
  console.log(`\n--- INVARIANT VIOLATION DETAIL (first 10 games, first violation each) ---`);
  for (const r of violations.slice(0, 10)) {
    const v = r.violations[0];
    console.log(
      `  seed=${r.seed} ${r.numPlayers}p ${r.strategy}: [${v.invariant}] ${v.detail} ` +
        `(phase=${v.phase} round=${v.round} step=${v.step})\n    after: ${v.action}` +
        (r.violations.length > 1 ? `\n    (+${r.violations.length - 1} more in this game)` : ""),
    );
  }
}
if (deadlocks.length) {
  console.log(`\n--- DEADLOCK DETAIL (first 5) ---`);
  for (const r of deadlocks.slice(0, 5)) {
    console.log(`  seed=${r.seed} ${r.numPlayers}p ${r.strategy}: ${r.deadlock}`);
  }
}

const clean = !crashes.length && !deadlocks.length && !violations.length && !determinismFailures.length;
console.log(`\n${clean ? "CLEAN BILL — no crashes, deadlocks, violations, or nondeterminism." : "GAUNTLET FOUND ISSUES (see above)."}`);
process.exit(clean ? 0 : 1);
