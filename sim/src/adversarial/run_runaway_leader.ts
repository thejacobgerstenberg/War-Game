/**
 * ADVERSARIAL runner: runaway-leader / snowball dynamics hunt.
 *
 * Runs two arms over the SAME per-game seeds (base seed 111004, game i uses
 * seed 111004+i) with the adversarial copy of the shared policies
 * (runaway_leader.ts):
 *
 *   arm "pressureOn"  — leader-pressure bonus active (verbatim shared logic)
 *   arm "pressureOff" — prestigeLeader() forced to null (the +5 anti-leader
 *                       targeting bonus never fires)
 *
 * Per game we record per-round prestige (from GameResult.prestigeByRound)
 * and per-round key-city counts (instrumented agent wrapper). Metrics:
 *
 *   - P(round-r prestige leader wins) for r in {4,6,8,10,12}, among games
 *     that reach round r with a unique alive leader. EXPLOIT if r=8 > 70%.
 *   - P(win | faction holds >=2 key cities at end of round 6). EXPLOIT if
 *     > 75%. (Also reported for >=3 keys and with margin buckets at r8.)
 *   - Leader-pressure effectiveness: leader win rate / faction / policy
 *     deltas between arms plus a count of how often the +5 bonus actually
 *     fired in target scoring. EXPLOIT if the mechanism is a no-op.
 *
 * Usage: cd sim && npx tsx src/adversarial/run_runaway_leader.ts
 * Env: GAMES=<n> SEED=<n> SMOKE=1. Writes
 * sim/results/adversarial_runaway_leader.json.
 */

import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName, type VictoryType } from '../game';
import { isSmoke, pct, table, writeResults } from '../util';
import {
  makeInstrumentedAgent,
  newRecorder,
  pressureStats,
  resetPressureStats,
  setLeaderPressure,
  type PressureMode,
} from './runaway_leader';

const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};
const BASE_SEED = envInt('SEED') ?? 111_004;
const N_GAMES = envInt('GAMES') ?? (isSmoke() ? 60 : 2000);
const LEADER_ROUNDS = [4, 6, 8, 10, 12] as const;

// ------------------------------------------------------------ arm metrics

interface Tally {
  wins: number;
  games: number;
}
const tally = (): Tally => ({ wins: 0, games: 0 });
const rate = (t: Tally) => (t.games > 0 ? t.wins / t.games : 0);

interface LeaderStat {
  round: number;
  eligibleGames: number; // games reaching the round
  uniqueLeader: number; // ...with a strict unique alive leader
  leaderWins: number;
  ties: number;
  marginSum: number;
}

interface PerGame {
  winner: FactionId;
  r8Leader: FactionId | null;
  hits: number; // leader +5 scoring evaluations during this game
}

interface ArmResult {
  arm: string;
  games: number;
  scoringHits: number;
  gamesWithHits: number;
  perGame: PerGame[];
  victoryTypes: Record<VictoryType, number>;
  byFaction: Record<FactionId, Tally>;
  byPolicy: Record<PolicyName, Tally>;
  leader: LeaderStat[];
  // margin-bucketed round-8 leader stats: [minMargin, uniqueLeaderGames, wins]
  r8MarginBuckets: Array<{ minMargin: number; games: number; wins: number }>;
  keys2AtR6: Tally; // faction-instances holding >=2 key cities at end of r6
  keys3AtR6: Tally;
  keys2AtR6AndLeaderR8: Tally; // both conditions on the same faction
  medianRounds: number;
}

function runArm(arm: string, pressure: PressureMode): ArmResult {
  setLeaderPressure(pressure);
  resetPressureStats();

  const byFaction = Object.fromEntries(FACTION_IDS.map((f) => [f, tally()])) as Record<FactionId, Tally>;
  const byPolicy = Object.fromEntries(POLICY_NAMES.map((p) => [p, tally()])) as Record<PolicyName, Tally>;
  const victoryTypes: Record<VictoryType, number> = { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 };
  const leader: LeaderStat[] = LEADER_ROUNDS.map((r) => ({
    round: r, eligibleGames: 0, uniqueLeader: 0, leaderWins: 0, ties: 0, marginSum: 0,
  }));
  const marginMins = [0, 3, 6, 10];
  const r8MarginBuckets = marginMins.map((m) => ({ minMargin: m, games: 0, wins: 0 }));
  const keys2AtR6 = tally();
  const keys3AtR6 = tally();
  const keys2AtR6AndLeaderR8 = tally();
  const lengths: number[] = [];
  const perGame: PerGame[] = [];
  let gamesWithHits = 0;

  for (let i = 0; i < N_GAMES; i++) {
    // identical wiring to run/fullgame.ts, reseeded from BASE_SEED
    const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
    const pool: PolicyName[] = [...POLICY_NAMES, POLICY_NAMES[i % POLICY_NAMES.length]];
    create(BASE_SEED + i).fork(97).shuffle(pool);
    const policyOf = {} as Record<FactionId, PolicyName>;
    const agents = {} as Record<FactionId, Agent>;
    const rec = newRecorder();
    FACTION_IDS.forEach((f, j) => {
      policyOf[f] = pool[j];
      agents[f] = makeInstrumentedAgent(pool[j], rec);
    });

    const hitsBefore = pressureStats.scoringHits;
    const game = new Game(BASE_SEED + i, agents, seatOrder);
    const res = game.run();
    const hits = pressureStats.scoringHits - hitsBefore;
    if (hits > 0) gamesWithHits++;
    lengths.push(res.rounds);
    victoryTypes[res.victoryType]++;
    for (const f of FACTION_IDS) {
      byFaction[f].games++;
      byPolicy[policyOf[f]].games++;
    }
    byFaction[res.winner].wins++;
    byPolicy[policyOf[res.winner]].wins++;

    // ---- prestige-leader-at-round-r wins?
    const aliveAt = (f: FactionId, r: number) => {
      const e = res.eliminated[f];
      return e === undefined || e > r;
    };
    let r8Leader: FactionId | null = null;
    for (const ls of leader) {
      const r = ls.round;
      if (res.rounds < r) continue; // prestigeByRound index r-1 must exist
      ls.eligibleGames++;
      let best: FactionId | null = null;
      let bestP = -Infinity;
      let second = -Infinity;
      for (const f of FACTION_IDS) {
        if (!aliveAt(f, r)) continue;
        const p = res.prestigeByRound[f][r - 1];
        if (p > bestP) {
          second = bestP;
          bestP = p;
          best = f;
        } else if (p > second) {
          second = p;
        }
      }
      if (best === null || bestP === second) {
        ls.ties++;
        continue;
      }
      ls.uniqueLeader++;
      const margin = bestP - second;
      ls.marginSum += margin;
      if (best === res.winner) ls.leaderWins++;
      if (r === 8) {
        r8Leader = best;
        for (const b of r8MarginBuckets) {
          if (margin >= b.minMargin) {
            b.games++;
            if (best === res.winner) b.wins++;
          }
        }
      }
    }

    perGame.push({ winner: res.winner, r8Leader, hits });

    // ---- key cities at end of round 6
    const k6 = rec.keyCitiesAtRoundEnd[6];
    if (k6) {
      for (const f of FACTION_IDS) {
        if (k6[f] >= 2) {
          keys2AtR6.games++;
          if (f === res.winner) keys2AtR6.wins++;
          if (r8Leader === f) {
            keys2AtR6AndLeaderR8.games++;
            if (f === res.winner) keys2AtR6AndLeaderR8.wins++;
          }
        }
        if (k6[f] >= 3) {
          keys3AtR6.games++;
          if (f === res.winner) keys3AtR6.wins++;
        }
      }
    }
  }

  lengths.sort((a, b) => a - b);
  return {
    arm,
    games: N_GAMES,
    scoringHits: pressureStats.scoringHits,
    gamesWithHits,
    perGame,
    victoryTypes,
    byFaction,
    byPolicy,
    leader,
    r8MarginBuckets,
    keys2AtR6,
    keys3AtR6,
    keys2AtR6AndLeaderR8,
    medianRounds: lengths[Math.floor(lengths.length / 2)],
  };
}

// -------------------------------------------------------------------- run

const t0 = performance.now();
const on = runArm('pressureOn', 'on');
const off = runArm('pressureOff', 'off');
const strong = runArm('pressureStrong', 'strong');
setLeaderPressure('on');
const elapsedMs = Math.round(performance.now() - t0);

// ----------------------------------------------------------------- report

function reportArm(a: ArmResult): void {
  console.log(`\n=== arm ${a.arm} — ${a.games} games, leader +5 scoring hits: ${a.scoringHits} ===`);
  console.log(table(
    ['round', 'eligible', 'uniqueLeader', 'ties', 'P(leader wins)', 'avgMargin'],
    a.leader.map((l) => [
      l.round, l.eligibleGames, l.uniqueLeader, l.ties,
      l.uniqueLeader > 0 ? pct(l.leaderWins / l.uniqueLeader) : '-',
      l.uniqueLeader > 0 ? (l.marginSum / l.uniqueLeader).toFixed(1) : '-',
    ]),
  ));
  console.log(table(
    ['r8 margin >=', 'games', 'P(leader wins)'],
    a.r8MarginBuckets.map((b) => [b.minMargin, b.games, b.games > 0 ? pct(b.wins / b.games) : '-']),
  ));
  console.log(
    `keys>=2 @r6: ${a.keys2AtR6.wins}/${a.keys2AtR6.games} (${pct(rate(a.keys2AtR6))})  ` +
    `keys>=3 @r6: ${a.keys3AtR6.wins}/${a.keys3AtR6.games} (${pct(rate(a.keys3AtR6))})  ` +
    `keys>=2 & r8-leader: ${a.keys2AtR6AndLeaderR8.wins}/${a.keys2AtR6AndLeaderR8.games} (${pct(rate(a.keys2AtR6AndLeaderR8))})`,
  );
  console.log(table(
    ['faction', 'winRate', '|', 'policy', 'winRate'],
    FACTION_IDS.map((f, i) => [
      f, pct(rate(a.byFaction[f])), '|',
      POLICY_NAMES[i] ?? '', POLICY_NAMES[i] ? pct(rate(a.byPolicy[POLICY_NAMES[i]])) : '',
    ]),
  ));
  const vt = a.victoryTypes;
  console.log(`victory types: threshold ${vt.threshold}, cap ${vt.cap}, suddenDeath ${vt.suddenDeath}, elimination ${vt.elimination}; median rounds ${a.medianRounds}`);
}

console.log(`runaway-leader adversarial run — base seed ${BASE_SEED}, ${N_GAMES} games/arm, ${elapsedMs}ms${isSmoke() ? ' (SMOKE)' : ''}`);
reportArm(on);
reportArm(off);
reportArm(strong);

const p8 = (a: ArmResult) => {
  const l = a.leader.find((x) => x.round === 8)!;
  return l.leaderWins / Math.max(1, l.uniqueLeader);
};
const p8on = p8(on);
const p8off = p8(off);
const p8strong = p8(strong);

// ---- paired same-seed comparison: does the pressure toggle change anything?
let winnerDiffers = 0;
let winnerDiffersWithHits = 0;
const hitGames = { n: 0, onLeaderWins: 0, offLeaderWins: 0 };
for (let i = 0; i < N_GAMES; i++) {
  const a = on.perGame[i];
  const b = off.perGame[i];
  if (a.winner !== b.winner) {
    winnerDiffers++;
    if (a.hits > 0) winnerDiffersWithHits++;
  }
  if (a.hits > 0 && a.r8Leader !== null) {
    hitGames.n++;
    if (a.winner === a.r8Leader) hitGames.onLeaderWins++;
    if (b.winner === a.r8Leader) hitGames.offLeaderWins++;
  }
}

console.log('\n--- exploit checks ---');
console.log(`P(r8 leader wins), pressure ON : ${pct(p8on)}  (threshold: exploit if >70%)`);
console.log(`P(win | >=2 keys @r6), ON      : ${pct(rate(on.keys2AtR6))}  (exploit if >75%)`);
console.log(`leader-pressure delta on P(r8 leader wins): ${pct(p8on - p8off)} (ON - OFF); scoring hits ON=${on.scoringHits}, OFF=${off.scoringHits}`);
console.log(`games where +5 bonus ever fired (ON): ${on.gamesWithHits}/${N_GAMES} (${pct(on.gamesWithHits / N_GAMES)})`);
console.log(`same-seed winner differs ON vs OFF: ${winnerDiffers}/${N_GAMES} (${pct(winnerDiffers / N_GAMES)}), of which in hit-games: ${winnerDiffersWithHits}`);
console.log(`within ON-hit games (n=${hitGames.n}): r8 leader wins ON ${pct(hitGames.onLeaderWins / Math.max(1, hitGames.n))} vs OFF ${pct(hitGames.offLeaderWins / Math.max(1, hitGames.n))}`);
console.log(`candidate fix arm 'strong' (0.4*threshold, +10): P(r8 leader wins) ${pct(p8strong)} vs ON ${pct(p8on)}; hits ${strong.scoringHits} in ${strong.gamesWithHits} games`);

writeResults('adversarial_runaway_leader', {
  config: {
    baseSeed: BASE_SEED,
    gamesPerArm: N_GAMES,
    smoke: isSmoke(),
    elapsedMs,
    victoryThreshold: CONFIG.prestige.victoryThreshold,
    exploitCriteria: {
      r8LeaderWins: '>0.70',
      twoKeysByR6Wins: '>0.75',
      leaderPressureNoOp: 'ON vs OFF delta ~0 and/or scoringHits ~0',
    },
  },
  arms: {
    pressureOn: { ...on, perGame: undefined },
    pressureOff: { ...off, perGame: undefined },
    pressureStrong: { ...strong, perGame: undefined },
  },
  paired: {
    winnerDiffers,
    winnerDiffersRate: winnerDiffers / N_GAMES,
    winnerDiffersWithHits,
    gamesWithHitsOn: on.gamesWithHits,
    hitGames,
  },
  summary: {
    p_r8_leader_wins_on: p8on,
    p_r8_leader_wins_off: p8off,
    p_win_given_2keys_r6_on: rate(on.keys2AtR6),
    p_win_given_2keys_r6_off: rate(off.keys2AtR6),
    p_win_given_3keys_r6_on: rate(on.keys3AtR6),
    p_r8_leader_wins_strong: p8strong,
    leaderPressureScoringHits: { on: on.scoringHits, off: off.scoringHits, strong: strong.scoringHits },
  },
});
console.log('\nResults written to sim/results/adversarial_runaway_leader.json');
