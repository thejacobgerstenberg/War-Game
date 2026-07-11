/**
 * Per-player-count victory-threshold sweep (npm run sim:thresholds).
 *
 * Derives VICTORY_THRESHOLD_BY_PLAYER_COUNT empirically, one player count
 * per invocation (PLAYERS=<2|3|4|5>), with the same pacing criteria used
 * for the 5-player 84 -> 80 derivation (TUNING_LOG errata round):
 *
 *   median ending round 12-16, <10% of games end before round 11,
 *   threshold-decided share 35-75%, sudden death <15%;
 *   tie-break toward ~55% threshold-decided.
 *
 * Faction-subset protocol (no pairing bias): game i plays
 * subset  = COMBINATIONS[i % C(5,n)]           (all C(5,n) faction subsets,
 *                                               lexicographic in FACTION_IDS)
 * rotated by floor(i / C(5,n)) % n             (every seat-order rotation),
 * so one full cycle of C(5,n)*n games covers every subset x rotation exactly
 * once; batch sizes are whole multiples of the cycle. Unseated factions'
 * starting provinces are independent/neutral garrisons (see game.ts
 * constructor + RULES_MODEL.md "Player counts"). Policies rotate through
 * POLICY_NAMES by game index and are assigned to seats by a seeded shuffle
 * (same scheme as fullgame.ts). Game i seeds from BASE_SEED + i; every
 * candidate threshold replays the SAME seeds (paired comparison), and the
 * chosen threshold is re-measured on a fresh-seed confirm batch.
 *
 * Phases per run:
 *   1. EXPLORE  — threshold 999 (unreachable): measures leader-prestige
 *      accrual quantiles per round to place the candidate range.
 *   2. SWEEP    — THRESHOLDS env (comma list) or an auto-derived 7-candidate
 *      range from the explore quantiles; >= 1000 games per candidate.
 *   3. CONFIRM  — fresh-seed batch (~2x) at the selected threshold; this is
 *      what the recommendation, accrual multiple, and per-subset
 *      (degenerate-pair) stats are quoted from.
 *
 * Results MERGE into sim/results/thresholds.json under perCount[<n>], so the
 * four counts can be produced by four invocations.
 *
 * Env: PLAYERS=<2..5> (default 5), SEED, GAMES (per candidate),
 * EXPLORE_GAMES, CONFIRM_GAMES, THRESHOLDS=<comma list>, SMOKE=1.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName, type VictoryType } from '../game';
import { makeAgent } from '../agents';
import { fmt, isSmoke, pct, table, writeResults } from '../util';

// ------------------------------------------------------------------- env

const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

const PLAYERS = envInt('PLAYERS') ?? 5;
if (PLAYERS < CONFIG.game.playersMin || PLAYERS > CONFIG.game.playersMax) {
  throw new Error(`PLAYERS must be ${CONFIG.game.playersMin}..${CONFIG.game.playersMax}`);
}
const BASE_SEED = envInt('SEED') ?? 14_530_000;
const EXPLORE_THRESHOLD = 999; // unreachable: games run to cap / SD / elimination

// ------------------------------------------------- subset x seat protocol

/** All C(5,n) faction subsets, lexicographic in FACTION_IDS order. */
function combinations(n: number): FactionId[][] {
  const out: FactionId[][] = [];
  const pick = (start: number, cur: FactionId[]): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i < FACTION_IDS.length; i++) {
      cur.push(FACTION_IDS[i]);
      pick(i + 1, cur);
      cur.pop();
    }
  };
  pick(0, []);
  return out;
}

const COMBINATIONS = combinations(PLAYERS);
const CYCLE = COMBINATIONS.length * PLAYERS; // subsets x seat rotations

/** Smallest multiple of the subset x rotation cycle >= want. */
const cycleAligned = (want: number): number => Math.ceil(want / CYCLE) * CYCLE;

const N_GAMES = cycleAligned(envInt('GAMES') ?? (isSmoke() ? 2 * CYCLE : 1000));
const N_EXPLORE = cycleAligned(envInt('EXPLORE_GAMES') ?? (isSmoke() ? 2 * CYCLE : 1000));
const N_CONFIRM = cycleAligned(envInt('CONFIRM_GAMES') ?? (isSmoke() ? 2 * CYCLE : 2000));

/** Deterministic seat order for game i: subset by index, then rotation. */
function seatOrderFor(i: number): FactionId[] {
  const subset = COMBINATIONS[i % COMBINATIONS.length];
  const rot = Math.floor(i / COMBINATIONS.length) % PLAYERS;
  return subset.map((_, k) => subset[(k + rot) % PLAYERS]);
}

// ------------------------------------------------------------- batch run

interface BatchStats {
  threshold: number;
  games: number;
  baseSeed: number;
  medianEnd: number;
  meanEnd: number;
  preR11Share: number; // games ending in round <= 10
  victoryShares: Record<VictoryType, number>;
  suddenDeathShare: number;
  thresholdShare: number;
  meanWinnerFinalPrestige: number;
  /** mean over games of winnerFinalPrestige / rounds (§2.13 accrual form). */
  meanWinnerAccrualPerRound: number;
  winRateByFaction: Record<FactionId, { wins: number; games: number; rate: number }>;
  /** subset key "a+b+..." -> per-faction wins and total games. */
  bySubset: Record<string, { games: number; wins: Partial<Record<FactionId, number>> }>;
  /** leader (max seated) prestige quantiles at end of rounds 8..16 (games reaching the round). */
  leaderQuantilesByRound: Record<number, { n: number; p25: number; p50: number; p75: number; p90: number }>;
  lengthHistogram: Record<number, number>;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function runBatch(threshold: number, games: number, baseSeed: number): BatchStats {
  const saved = CONFIG.prestige.victoryThreshold;
  CONFIG.prestige.victoryThreshold = threshold;
  const lengths: number[] = [];
  const lengthHistogram: Record<number, number> = {};
  const victoryCounts: Record<VictoryType, number> = { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 };
  const byFaction = Object.fromEntries(FACTION_IDS.map((f) => [f, { wins: 0, games: 0 }])) as Record<FactionId, { wins: number; games: number }>;
  const bySubset: BatchStats['bySubset'] = {};
  const leaderAt: Record<number, number[]> = {};
  for (let r = 8; r <= CONFIG.game.maxRounds; r++) leaderAt[r] = [];
  let winnerFinalSum = 0;
  let winnerAccrualSum = 0;
  let preR11 = 0;

  for (let i = 0; i < games; i++) {
    const seatOrder = seatOrderFor(i);
    // policy pool rotates through POLICY_NAMES by game index, seeded shuffle
    // assigns pool -> seats (fullgame.ts scheme, truncated to PLAYERS seats)
    const pool: PolicyName[] = Array.from({ length: PLAYERS }, (_, k) => POLICY_NAMES[(i + k) % POLICY_NAMES.length]);
    create(baseSeed + i).fork(97).shuffle(pool);
    const agents = {} as Record<FactionId, Agent>;
    for (const f of FACTION_IDS) agents[f] = makeAgent('opportunist'); // unseated: never consulted
    seatOrder.forEach((f, j) => {
      agents[f] = makeAgent(pool[j]);
    });

    const res = new Game(baseSeed + i, agents, seatOrder).run();

    lengths.push(res.rounds);
    lengthHistogram[res.rounds] = (lengthHistogram[res.rounds] ?? 0) + 1;
    if (res.rounds <= 10) preR11++;
    victoryCounts[res.victoryType]++;
    winnerFinalSum += res.finalPrestige[res.winner];
    winnerAccrualSum += res.finalPrestige[res.winner] / res.rounds;

    const subsetKey = [...seatOrder].sort().join('+');
    const sub = (bySubset[subsetKey] ??= { games: 0, wins: {} });
    sub.games++;
    sub.wins[res.winner] = (sub.wins[res.winner] ?? 0) + 1;
    for (const f of seatOrder) byFaction[f].games++;
    byFaction[res.winner].wins++;

    for (let r = 8; r <= res.rounds; r++) {
      let leader = 0;
      for (const f of seatOrder) {
        const v = res.prestigeByRound[f][r - 1];
        if (v !== undefined && v > leader) leader = v;
      }
      leaderAt[r].push(leader);
    }
  }
  CONFIG.prestige.victoryThreshold = saved;

  lengths.sort((a, b) => a - b);
  const leaderQuantilesByRound: BatchStats['leaderQuantilesByRound'] = {};
  for (let r = 8; r <= CONFIG.game.maxRounds; r++) {
    const xs = leaderAt[r].sort((a, b) => a - b);
    leaderQuantilesByRound[r] = {
      n: xs.length,
      p25: quantile(xs, 0.25),
      p50: quantile(xs, 0.5),
      p75: quantile(xs, 0.75),
      p90: quantile(xs, 0.9),
    };
  }
  return {
    threshold,
    games,
    baseSeed,
    medianEnd: lengths[Math.floor(lengths.length / 2)],
    meanEnd: lengths.reduce((a, b) => a + b, 0) / games,
    preR11Share: preR11 / games,
    victoryShares: Object.fromEntries(
      (Object.keys(victoryCounts) as VictoryType[]).map((k) => [k, victoryCounts[k] / games]),
    ) as Record<VictoryType, number>,
    suddenDeathShare: victoryCounts.suddenDeath / games,
    thresholdShare: victoryCounts.threshold / games,
    meanWinnerFinalPrestige: winnerFinalSum / games,
    meanWinnerAccrualPerRound: winnerAccrualSum / games,
    winRateByFaction: Object.fromEntries(
      FACTION_IDS.map((f) => [f, { ...byFaction[f], rate: byFaction[f].games > 0 ? byFaction[f].wins / byFaction[f].games : 0 }]),
    ) as BatchStats['winRateByFaction'],
    bySubset,
    leaderQuantilesByRound,
    lengthHistogram,
  };
}

// ------------------------------------------------------ selection criteria

const CRITERIA = {
  medianEndMin: 12,
  medianEndMax: 16,
  preR11Max: 0.10,
  thresholdShareMin: 0.35,
  thresholdShareMax: 0.75,
  suddenDeathMax: 0.15,
  thresholdShareIdeal: 0.55, // tie-break target
};

function passes(s: BatchStats): boolean {
  return (
    s.medianEnd >= CRITERIA.medianEndMin &&
    s.medianEnd <= CRITERIA.medianEndMax &&
    s.preR11Share < CRITERIA.preR11Max &&
    s.thresholdShare >= CRITERIA.thresholdShareMin &&
    s.thresholdShare <= CRITERIA.thresholdShareMax &&
    s.suddenDeathShare < CRITERIA.suddenDeathMax
  );
}

// --------------------------------------------------------------- phases

const t0 = performance.now();
console.log(
  `IMPERIUM threshold sweep — ${PLAYERS} players, ${COMBINATIONS.length} subsets x ${PLAYERS} rotations ` +
  `(cycle ${CYCLE}), base seed ${BASE_SEED}${isSmoke() ? ' (SMOKE)' : ''}`,
);

// 1. explore: unreachable threshold -> accrual curves
console.log(`\n[explore] ${N_EXPLORE} games at threshold ${EXPLORE_THRESHOLD} (unreachable)...`);
const explore = runBatch(EXPLORE_THRESHOLD, N_EXPLORE, BASE_SEED);
console.log('leader prestige quantiles by round (games reaching the round):');
console.log(
  table(
    ['round', 'n', 'p25', 'p50', 'p75', 'p90'],
    Object.entries(explore.leaderQuantilesByRound)
      .filter(([r]) => Number(r) >= 10)
      .map(([r, q]) => [r, q.n, q.p25, q.p50, q.p75, q.p90]),
  ),
);

// 2. sweep candidates: THRESHOLDS env, else auto-derived from the explore
// quantiles — from where leaders land mid-window (p50 @ r13, floored above
// the pre-r11 hazard p90 @ r10) up to p75 @ r16, 7 evenly spaced integers.
let candidates: number[];
if (process.env.THRESHOLDS) {
  candidates = process.env.THRESHOLDS.split(',').map((s) => Number.parseInt(s.trim(), 10));
} else {
  const lo = Math.max(explore.leaderQuantilesByRound[13].p50, explore.leaderQuantilesByRound[10].p90 + 1);
  const hi = Math.max(lo + 6, explore.leaderQuantilesByRound[16].p75);
  candidates = Array.from({ length: 7 }, (_, k) => Math.round(lo + (k * (hi - lo)) / 6));
  candidates = [...new Set(candidates)];
}
console.log(`\n[sweep] candidates: ${candidates.join(', ')} — ${N_GAMES} games each (paired seeds)`);

const sweep: BatchStats[] = [];
for (const c of candidates) {
  const s = runBatch(c, N_GAMES, BASE_SEED);
  sweep.push(s);
  console.log(
    `  T=${String(c).padStart(3)}  medianEnd ${s.medianEnd}  preR11 ${pct(s.preR11Share)}  ` +
    `threshold ${pct(s.thresholdShare)}  SD ${pct(s.suddenDeathShare)}  cap ${pct(s.victoryShares.cap)}  ` +
    `elim ${pct(s.victoryShares.elimination)}  ${passes(s) ? 'PASS' : 'fail'}`,
  );
}

const passing = sweep.filter(passes);
if (passing.length === 0) {
  console.log('\nNO CANDIDATE PASSES ALL CRITERIA — widen THRESHOLDS and rerun.');
}
const chosen = (passing.length > 0 ? passing : sweep).reduce((best, s) => {
  const d = Math.abs(s.thresholdShare - CRITERIA.thresholdShareIdeal);
  const bd = Math.abs(best.thresholdShare - CRITERIA.thresholdShareIdeal);
  return d < bd || (d === bd && s.threshold < best.threshold) ? s : best;
});

// 3. confirm on a fresh seed at the chosen threshold
const CONFIRM_SEED = BASE_SEED + 60_000_000 + PLAYERS;
console.log(`\n[confirm] threshold ${chosen.threshold}, ${N_CONFIRM} games, fresh seed ${CONFIRM_SEED}...`);
const confirm = runBatch(chosen.threshold, N_CONFIRM, CONFIRM_SEED);
console.log(
  `  medianEnd ${confirm.medianEnd}  preR11 ${pct(confirm.preR11Share)}  threshold ${pct(confirm.thresholdShare)}  ` +
  `SD ${pct(confirm.suddenDeathShare)}  cap ${pct(confirm.victoryShares.cap)}  elim ${pct(confirm.victoryShares.elimination)}  ${passes(confirm) ? 'PASS' : 'FAIL'}`,
);
const accrualMultiple = chosen.threshold / confirm.meanWinnerAccrualPerRound;
console.log(
  `  winner accrual ${fmt(confirm.meanWinnerAccrualPerRound, 3)}/round ` +
  `(mean winner final ${fmt(confirm.meanWinnerFinalPrestige, 1)}) -> threshold = ${fmt(accrualMultiple, 1)}x accrual/round`,
);

console.log('\nWin rate by faction (confirm batch; seats are NOT balance-tuned at 2-4p):');
console.log(
  table(
    ['faction', 'wins', 'games', 'rate'],
    FACTION_IDS.filter((f) => confirm.winRateByFaction[f].games > 0).map((f) => {
      const t = confirm.winRateByFaction[f];
      return [f, t.wins, t.games, pct(t.rate)];
    }),
  ),
);

// degenerate-subset scan (confirm batch): any faction winning >70% of a subset
const degenerate: Array<{ subset: string; faction: FactionId; rate: number; games: number }> = [];
for (const [key, sub] of Object.entries(confirm.bySubset)) {
  for (const [f, w] of Object.entries(sub.wins) as Array<[FactionId, number]>) {
    if (sub.games >= 20 && w / sub.games > 0.7) degenerate.push({ subset: key, faction: f, rate: w / sub.games, games: sub.games });
  }
}
degenerate.sort((a, b) => b.rate - a.rate);
if (degenerate.length > 0) {
  console.log('\nDEGENERATE SUBSETS (one faction >70% of the matchup):');
  for (const d of degenerate) console.log(`  ! ${d.subset}: ${d.faction} wins ${pct(d.rate)} of ${d.games} games`);
} else {
  console.log('\nNo subset has a faction above 70% (confirm batch).');
}

const elapsedMs = performance.now() - t0;

// ------------------------------------------------------------- persistence

const outFile = join(process.cwd(), 'results', 'thresholds.json');
let merged: Record<string, unknown> = {};
if (existsSync(outFile)) {
  try {
    merged = JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, unknown>;
  } catch {
    merged = {};
  }
}
merged.criteria = CRITERIA;
merged.protocol = {
  subsets: 'all C(5,n) faction combinations x all n seat rotations, cycled by game index',
  policies: 'POLICY_NAMES rotated by game index, seeded shuffle onto seats',
  seeds: 'game i = baseSeed + i; sweep candidates share seeds (paired); confirm batch uses a fresh seed',
  exploreThreshold: EXPLORE_THRESHOLD,
};
const perCount = (merged.perCount ??= {}) as Record<string, unknown>;
perCount[String(PLAYERS)] = {
  players: PLAYERS,
  smoke: isSmoke(),
  cycle: CYCLE,
  gamesPerCandidate: N_GAMES,
  elapsedMs: Math.round(elapsedMs),
  explore: {
    games: N_EXPLORE,
    baseSeed: BASE_SEED,
    leaderQuantilesByRound: explore.leaderQuantilesByRound,
    victoryShares: explore.victoryShares,
    medianEnd: explore.medianEnd,
  },
  sweep: sweep.map((s) => ({
    threshold: s.threshold,
    games: s.games,
    baseSeed: s.baseSeed,
    medianEnd: s.medianEnd,
    meanEnd: s.meanEnd,
    preR11Share: s.preR11Share,
    thresholdShare: s.thresholdShare,
    suddenDeathShare: s.suddenDeathShare,
    victoryShares: s.victoryShares,
    passes: passes(s),
  })),
  recommendation: {
    threshold: chosen.threshold,
    passesAllCriteria: passing.length > 0,
    accrualMultiple,
    meanWinnerAccrualPerRound: confirm.meanWinnerAccrualPerRound,
    meanWinnerFinalPrestige: confirm.meanWinnerFinalPrestige,
  },
  confirm: {
    games: N_CONFIRM,
    baseSeed: CONFIRM_SEED,
    medianEnd: confirm.medianEnd,
    meanEnd: confirm.meanEnd,
    preR11Share: confirm.preR11Share,
    thresholdShare: confirm.thresholdShare,
    suddenDeathShare: confirm.suddenDeathShare,
    victoryShares: confirm.victoryShares,
    lengthHistogram: confirm.lengthHistogram,
    winRateByFaction: confirm.winRateByFaction,
    bySubset: confirm.bySubset,
    degenerateSubsets: degenerate,
  },
};
const outPath = writeResults('thresholds', merged);
console.log(`\nRecommended ${PLAYERS}-player threshold: ${chosen.threshold} (${fmt(accrualMultiple, 1)}x winner accrual/round)`);
console.log(`Results merged into ${outPath} (${(elapsedMs / 1000).toFixed(1)}s)`);
