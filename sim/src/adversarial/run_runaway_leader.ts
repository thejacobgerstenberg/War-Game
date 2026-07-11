/**
 * ADVERSARIAL runner: runaway-leader / snowball dynamics hunt vs the
 * FINAL-canon retuned config (threshold 82, canon §13.1 prestige sources).
 *
 * Runs three arms over the SAME per-game seeds (base seed 311004, game i
 * uses seed 311004+i) with the adversarial copy of the shared policies
 * (runaway_leader.ts):
 *
 *   arm "pressureOn"     — leader-pressure bonus active (verbatim shared logic)
 *   arm "pressureOff"    — prestigeLeader() forced to null (the +5 anti-leader
 *                          targeting bonus never fires)
 *   arm "pressureStrong" — candidate fix (activate at 0.4*threshold, +10)
 *
 * Per game we record per-round prestige (GameResult.prestigeByRound), the
 * winner, and per-round key-city counts (instrumented agent wrapper).
 *
 * Metrics / exploit criteria:
 *   - P(round-r prestige leader wins) for r in {4,6,8,10,12}, among games
 *     that reach round r with a unique alive leader. EXPLOIT if r=8 > 70%.
 *   - P(win | faction holds >=2 key cities at end of round 6). EXPLOIT if
 *     > 75%. (Also >=3 keys and r8-margin buckets.)
 *   - Leader-pressure effectiveness: scoring hits AND decision changes
 *     (did the +5 ever change WHICH province gets attacked?), plus
 *     same-seed paired winner diffs ON vs OFF. EXPLOIT if it is a no-op.
 *   - Secret-objective reveal (+4, scored at GAME END only): among
 *     cap-decided games, how often the apparent (pre-reveal) round-16
 *     prestige leader LOSES after objectives are revealed. EXPLOIT if
 *     flips > 30% of cap-decided games (kingmaker lottery).
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
const BASE_SEED = envInt('SEED') ?? 311_004;
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
  changed: number; // attack decisions changed by the bonus during this game
}

interface ObjectiveStats {
  capGames: number; // games decided at the round cap (objective reveal matters)
  capUniqueLeader: number; // ...with a unique pre-reveal prestige leader
  capPreRevealTies: number; // pre-reveal tie for the lead among survivors
  flips: number; // unique pre-reveal leader did NOT win after reveal
  flipWinnerGainedObjective: number; // in flips, the actual winner scored objective prestige
  gamesAnyObjectiveScored: number; // any faction completed >=1 objective (cap games)
  objectivesScoredTotal: number; // completed objectives SCORED across cap games (E4: up to 3/faction)
  // ---- E4 per-objective completion telemetry (ALL games, surviving factions) ----
  objectiveSlotsAllGames: number; // 3 per surviving faction per game
  objectivesCompletedAllGames: number; // objective provinces held at game end
  completedCountHist: Record<number, number>; // surviving faction-games by completed count 0..3
}

interface ArmResult {
  arm: string;
  games: number;
  scoringHits: number;
  attackPicks: number;
  decisionsChanged: number;
  gamesWithHits: number;
  gamesWithChanged: number;
  perGame: PerGame[];
  victoryTypes: Record<VictoryType, number>;
  byFaction: Record<FactionId, Tally>;
  byPolicy: Record<PolicyName, Tally>;
  leader: LeaderStat[];
  r8MarginBuckets: Array<{ minMargin: number; games: number; wins: number }>;
  keys2AtR6: Tally; // faction-instances holding >=2 key cities at end of r6
  keys3AtR6: Tally;
  keys2AtR6AndLeaderR8: Tally; // both conditions on the same faction
  objective: ObjectiveStats;
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
  const objective: ObjectiveStats = {
    capGames: 0, capUniqueLeader: 0, capPreRevealTies: 0, flips: 0,
    flipWinnerGainedObjective: 0, gamesAnyObjectiveScored: 0, objectivesScoredTotal: 0,
    objectiveSlotsAllGames: 0, objectivesCompletedAllGames: 0,
    completedCountHist: { 0: 0, 1: 0, 2: 0, 3: 0 },
  };
  const lengths: number[] = [];
  const perGame: PerGame[] = [];
  let gamesWithHits = 0;
  let gamesWithChanged = 0;

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
    const changedBefore = pressureStats.decisionsChanged;
    const game = new Game(BASE_SEED + i, agents, seatOrder);
    const res = game.run();
    const hits = pressureStats.scoringHits - hitsBefore;
    const changed = pressureStats.decisionsChanged - changedBefore;
    if (hits > 0) gamesWithHits++;
    if (changed > 0) gamesWithChanged++;
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

    perGame.push({ winner: res.winner, r8Leader, hits, changed });

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

    // ---- E4 per-objective completion (ALL games; surviving factions):
    // GameResult.objectivesCompleted = objective provinces held at game end
    // (0..3), computed even when the game ends by threshold/SD.
    for (const f of FACTION_IDS) {
      if (res.eliminated[f] !== undefined) continue;
      const n = res.objectivesCompleted[f];
      objective.objectiveSlotsAllGames += 3;
      objective.objectivesCompletedAllGames += n;
      objective.completedCountHist[n] = (objective.completedCountHist[n] ?? 0) + 1;
    }

    // ---- secret-objective reveal flips (cap-decided games only).
    // prestigeByRound holds PRE-reveal totals (cleanup pushes before run()
    // reveals objectives); finalPrestige is POST-reveal. The delta per
    // faction is the objective bonus (E4: 0 to +12, +4 per objective).
    if (res.victoryType === 'cap') {
      objective.capGames++;
      const alive = FACTION_IDS.filter((f) => res.eliminated[f] === undefined);
      let scoredAny = false;
      for (const f of alive) {
        const pre = res.prestigeByRound[f][res.prestigeByRound[f].length - 1];
        const delta = res.finalPrestige[f] - pre;
        if (delta > 0) {
          scoredAny = true;
          objective.objectivesScoredTotal += Math.round(delta / CONFIG.prestige.secretObjective);
        }
      }
      if (scoredAny) objective.gamesAnyObjectiveScored++;
      let best: FactionId | null = null;
      let bestP = -Infinity;
      let second = -Infinity;
      for (const f of alive) {
        const pre = res.prestigeByRound[f][res.prestigeByRound[f].length - 1];
        if (pre > bestP) {
          second = bestP;
          bestP = pre;
          best = f;
        } else if (pre > second) {
          second = pre;
        }
      }
      if (best === null || bestP === second) {
        objective.capPreRevealTies++;
      } else {
        objective.capUniqueLeader++;
        if (best !== res.winner) {
          objective.flips++;
          const winPre = res.prestigeByRound[res.winner][res.prestigeByRound[res.winner].length - 1];
          if (res.finalPrestige[res.winner] > winPre) objective.flipWinnerGainedObjective++;
        }
      }
    }
  }

  lengths.sort((a, b) => a - b);
  return {
    arm,
    games: N_GAMES,
    scoringHits: pressureStats.scoringHits,
    attackPicks: pressureStats.attackPicks,
    decisionsChanged: pressureStats.decisionsChanged,
    gamesWithHits,
    gamesWithChanged,
    perGame,
    victoryTypes,
    byFaction,
    byPolicy,
    leader,
    r8MarginBuckets,
    keys2AtR6,
    keys3AtR6,
    keys2AtR6AndLeaderR8,
    objective,
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
  console.log(`\n=== arm ${a.arm} — ${a.games} games; pressure: hits ${a.scoringHits}, ` +
    `attackPicks ${a.attackPicks}, decisionsChanged ${a.decisionsChanged} (in ${a.gamesWithChanged} games) ===`);
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
  const o = a.objective;
  console.log(
    `objective reveal (cap games ${o.capGames}): uniqueLeader ${o.capUniqueLeader}, preTies ${o.capPreRevealTies}, ` +
    `FLIPS ${o.flips} (${o.capUniqueLeader > 0 ? pct(o.flips / o.capUniqueLeader) : '-'} of unique-leader cap games; ` +
    `${o.capGames > 0 ? pct(o.flips / o.capGames) : '-'} of all cap games); ` +
    `flips where winner scored objective prestige: ${o.flipWinnerGainedObjective}; ` +
    `objectives SCORED (cap games): ${o.objectivesScoredTotal} in ${o.gamesAnyObjectiveScored} games`,
  );
  console.log(
    `objective completion (E4, all games, surviving factions): ` +
    `${o.objectivesCompletedAllGames}/${o.objectiveSlotsAllGames} slots = ` +
    `${pct(o.objectivesCompletedAllGames / Math.max(1, o.objectiveSlotsAllGames))} per-objective; ` +
    `count hist 0/1/2/3: ${o.completedCountHist[0]}/${o.completedCountHist[1]}/${o.completedCountHist[2]}/${o.completedCountHist[3]}`,
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

console.log(`runaway-leader adversarial run — base seed ${BASE_SEED}, ${N_GAMES} games/arm, ` +
  `threshold ${CONFIG.prestige.victoryThreshold}, ${elapsedMs}ms${isSmoke() ? ' (SMOKE)' : ''}`);
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
let winnerDiffersWithChanged = 0;
const hitGames = { n: 0, onLeaderWins: 0, offLeaderWins: 0 };
for (let i = 0; i < N_GAMES; i++) {
  const a = on.perGame[i];
  const b = off.perGame[i];
  if (a.winner !== b.winner) {
    winnerDiffers++;
    if (a.changed > 0) winnerDiffersWithChanged++;
  }
  if (a.hits > 0 && a.r8Leader !== null) {
    hitGames.n++;
    if (a.winner === a.r8Leader) hitGames.onLeaderWins++;
    if (b.winner === a.r8Leader) hitGames.offLeaderWins++;
  }
}
let winnerDiffersStrong = 0;
for (let i = 0; i < N_GAMES; i++) {
  if (strong.perGame[i].winner !== off.perGame[i].winner) winnerDiffersStrong++;
}

const flipShare = (a: ArmResult) =>
  a.objective.capUniqueLeader > 0 ? a.objective.flips / a.objective.capUniqueLeader : 0;

console.log('\n--- exploit checks ---');
console.log(`P(r8 leader wins), pressure ON : ${pct(p8on)}  (threshold: exploit if >70%)`);
console.log(`P(win | >=2 keys @r6), ON      : ${pct(rate(on.keys2AtR6))}  (exploit if >75%)`);
console.log(`leader-pressure delta on P(r8 leader wins): ${pct(p8on - p8off)} (ON - OFF)`);
console.log(`pressure decision changes ON: ${on.decisionsChanged}/${on.attackPicks} attack picks ` +
  `(${pct(on.decisionsChanged / Math.max(1, on.attackPicks))}), in ${on.gamesWithChanged}/${N_GAMES} games`);
console.log(`same-seed winner differs ON vs OFF: ${winnerDiffers}/${N_GAMES} (${pct(winnerDiffers / N_GAMES)}), of which with changed decisions: ${winnerDiffersWithChanged}`);
console.log(`same-seed winner differs STRONG vs OFF: ${winnerDiffersStrong}/${N_GAMES} (${pct(winnerDiffersStrong / N_GAMES)})`);
console.log(`within ON-hit games (n=${hitGames.n}): r8 leader wins ON ${pct(hitGames.onLeaderWins / Math.max(1, hitGames.n))} vs OFF ${pct(hitGames.offLeaderWins / Math.max(1, hitGames.n))}`);
console.log(`candidate fix arm 'strong' (0.4*threshold, +10): P(r8 leader wins) ${pct(p8strong)} vs ON ${pct(p8on)}; ` +
  `decision changes ${strong.decisionsChanged} in ${strong.gamesWithChanged} games`);
console.log(`objective-reveal flips (ON): ${on.objective.flips}/${on.objective.capUniqueLeader} unique-leader cap games ` +
  `(${pct(flipShare(on))})  (exploit if >30%)`);

writeResults('adversarial_runaway_leader', {
  config: {
    baseSeed: BASE_SEED,
    gamesPerArm: N_GAMES,
    smoke: isSmoke(),
    elapsedMs,
    victoryThreshold: CONFIG.prestige.victoryThreshold,
    secretObjective: CONFIG.prestige.secretObjective,
    exploitCriteria: {
      r8LeaderWins: '>0.70',
      twoKeysByR6Wins: '>0.75',
      leaderPressureNoOp: 'ON vs OFF delta ~0 and/or decisionsChanged ~0',
      objectiveRevealFlips: '>0.30 of cap-decided games',
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
    winnerDiffersWithChanged,
    winnerDiffersStrongVsOff: winnerDiffersStrong,
    gamesWithHitsOn: on.gamesWithHits,
    gamesWithChangedOn: on.gamesWithChanged,
    hitGames,
  },
  summary: {
    p_r8_leader_wins_on: p8on,
    p_r8_leader_wins_off: p8off,
    p_r8_leader_wins_strong: p8strong,
    p_win_given_2keys_r6_on: rate(on.keys2AtR6),
    p_win_given_2keys_r6_off: rate(off.keys2AtR6),
    p_win_given_3keys_r6_on: rate(on.keys3AtR6),
    objectiveFlipShare_on: flipShare(on),
    objectiveFlipShare_off: flipShare(off),
    perObjectiveCompletionRate_on:
      on.objective.objectivesCompletedAllGames / Math.max(1, on.objective.objectiveSlotsAllGames),
    objectiveCompletedCountHist_on: on.objective.completedCountHist,
    leaderPressure: {
      scoringHits: { on: on.scoringHits, off: off.scoringHits, strong: strong.scoringHits },
      decisionsChanged: { on: on.decisionsChanged, off: off.decisionsChanged, strong: strong.decisionsChanged },
      attackPicks: { on: on.attackPicks, off: off.attackPicks, strong: strong.attackPicks },
    },
  },
});
console.log('\nResults written to sim/results/adversarial_runaway_leader.json');
