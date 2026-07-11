/**
 * Full-game Monte-Carlo (npm run sim:fullgame).
 *
 * Runs 5-player games with all five factions. Every game fields each of the
 * four policies at least once plus one duplicate (rotating across games so
 * each policy gets exactly N_GAMES/4 duplicates); the assignment of policies
 * to factions is a seeded per-game shuffle so every faction sees every policy
 * mix (a fixed rotation like (i+j)%4 keeps seat-relative pairings constant
 * and confounds the per-faction policy stats). Seat order rotates by i%5.
 * Game i seeds from BASE_SEED + i.
 *
 * Reports: win rate per faction / per policy / per faction-policy pair,
 * game-length distribution, victory-type split, sudden-death rate,
 * eliminations per faction with average elimination round, and average
 * prestige per round per faction. Writes sim/results/fullgame.json.
 *
 * SMOKE=1: 40 games. Full scale: 1000 games.
 */

import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName, type VictoryType } from '../game';
import { makeAgent } from '../agents';
import { bar, fmt, isSmoke, pct, table, writeResults } from '../util';

// Env overrides (for independent verification): GAMES=<n> SEED=<n>
const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};
const BASE_SEED = envInt('SEED') ?? 14_530_000;
const N_GAMES = envInt('GAMES') ?? (isSmoke() ? 40 : 1000);

// ------------------------------------------------------------- aggregation

interface Tally {
  wins: number;
  games: number;
}
const t0 = performance.now();

const byFaction: Record<FactionId, Tally> = Object.fromEntries(
  FACTION_IDS.map((f) => [f, { wins: 0, games: 0 }]),
) as Record<FactionId, Tally>;
const byPolicy: Record<PolicyName, Tally> = Object.fromEntries(
  POLICY_NAMES.map((p) => [p, { wins: 0, games: 0 }]),
) as Record<PolicyName, Tally>;
const byPair: Record<FactionId, Record<PolicyName, Tally>> = Object.fromEntries(
  FACTION_IDS.map((f) => [
    f,
    Object.fromEntries(POLICY_NAMES.map((p) => [p, { wins: 0, games: 0 }])),
  ]),
) as Record<FactionId, Record<PolicyName, Tally>>;

const lengthHist: Record<number, number> = {};
const victoryTypes: Record<VictoryType, number> = { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 };
const elimCount: Record<FactionId, number> = Object.fromEntries(FACTION_IDS.map((f) => [f, 0])) as Record<FactionId, number>;
const elimRoundSum: Record<FactionId, number> = Object.fromEntries(FACTION_IDS.map((f) => [f, 0])) as Record<FactionId, number>;
// prestige sums per faction per round index (0-based), with sample counts
const prestigeSum: Record<FactionId, number[]> = Object.fromEntries(FACTION_IDS.map((f) => [f, [] as number[]])) as unknown as Record<FactionId, number[]>;
const prestigeN: Record<FactionId, number[]> = Object.fromEntries(FACTION_IDS.map((f) => [f, [] as number[]])) as unknown as Record<FactionId, number[]>;

let roundsSum = 0;
let battlesSum = 0;
const allLengths: number[] = [];

// -------------------------------------------------------------- game loop

for (let i = 0; i < N_GAMES; i++) {
  const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
  const policyOf = {} as Record<FactionId, PolicyName>;
  const agents = {} as Record<FactionId, Agent>;
  const pool: PolicyName[] = [...POLICY_NAMES, POLICY_NAMES[i % POLICY_NAMES.length]];
  create(BASE_SEED + i).fork(97).shuffle(pool);
  FACTION_IDS.forEach((f, j) => {
    policyOf[f] = pool[j];
    agents[f] = makeAgent(policyOf[f]);
  });

  const game = new Game(BASE_SEED + i, agents, seatOrder);
  const res = game.run();

  for (const f of FACTION_IDS) {
    byFaction[f].games++;
    byPolicy[policyOf[f]].games++;
    byPair[f][policyOf[f]].games++;
  }
  byFaction[res.winner].wins++;
  byPolicy[policyOf[res.winner]].wins++;
  byPair[res.winner][policyOf[res.winner]].wins++;

  lengthHist[res.rounds] = (lengthHist[res.rounds] ?? 0) + 1;
  allLengths.push(res.rounds);
  roundsSum += res.rounds;
  battlesSum += res.battles;
  victoryTypes[res.victoryType]++;

  for (const [f, round] of Object.entries(res.eliminated) as Array<[FactionId, number]>) {
    elimCount[f]++;
    elimRoundSum[f] += round;
  }
  for (const f of FACTION_IDS) {
    const series = res.prestigeByRound[f];
    for (let r = 0; r < series.length; r++) {
      prestigeSum[f][r] = (prestigeSum[f][r] ?? 0) + series[r];
      prestigeN[f][r] = (prestigeN[f][r] ?? 0) + 1;
    }
  }
}

const elapsedMs = performance.now() - t0;

// ----------------------------------------------------------------- results

allLengths.sort((a, b) => a - b);
const median = allLengths[Math.floor(allLengths.length / 2)];

const avgPrestigeByRound = {} as Record<FactionId, number[]>;
for (const f of FACTION_IDS) {
  avgPrestigeByRound[f] = prestigeSum[f].map((s, r) => s / prestigeN[f][r]);
}

const rate = (t: Tally) => (t.games > 0 ? t.wins / t.games : 0);

const results = {
  config: {
    games: N_GAMES,
    baseSeed: BASE_SEED,
    smoke: isSmoke(),
    maxRounds: CONFIG.game.maxRounds,
    victoryThreshold: CONFIG.prestige.victoryThreshold,
    policies: POLICY_NAMES,
    elapsedMs: Math.round(elapsedMs),
  },
  winRates: {
    byFaction: Object.fromEntries(
      FACTION_IDS.map((f) => [f, { ...byFaction[f], rate: rate(byFaction[f]) }]),
    ),
    byPolicy: Object.fromEntries(
      POLICY_NAMES.map((p) => [p, { ...byPolicy[p], rate: rate(byPolicy[p]) }]),
    ),
    byFactionPolicy: Object.fromEntries(
      FACTION_IDS.map((f) => [
        f,
        Object.fromEntries(
          POLICY_NAMES.map((p) => [p, { ...byPair[f][p], rate: rate(byPair[f][p]) }]),
        ),
      ]),
    ),
  },
  gameLength: {
    histogram: lengthHist,
    mean: roundsSum / N_GAMES,
    median,
  },
  victoryTypes: {
    counts: victoryTypes,
    rates: Object.fromEntries(
      (Object.keys(victoryTypes) as VictoryType[]).map((k) => [k, victoryTypes[k] / N_GAMES]),
    ),
  },
  suddenDeathRate: victoryTypes.suddenDeath / N_GAMES,
  eliminations: Object.fromEntries(
    FACTION_IDS.map((f) => [
      f,
      {
        count: elimCount[f],
        rate: elimCount[f] / N_GAMES,
        avgRound: elimCount[f] > 0 ? elimRoundSum[f] / elimCount[f] : null,
      },
    ]),
  ),
  avgPrestigeByRound,
  meanBattlesPerGame: battlesSum / N_GAMES,
};

const outPath = writeResults('fullgame', results);

// ----------------------------------------------------------------- report

console.log(`IMPERIUM full-game simulation — ${N_GAMES} games${isSmoke() ? ' (SMOKE)' : ''}, ` +
  `base seed ${BASE_SEED}, ${(elapsedMs / 1000).toFixed(1)}s (${(elapsedMs / N_GAMES).toFixed(1)} ms/game)`);

console.log('\nWin rate by faction:');
console.log(
  table(
    ['faction', 'wins', 'games', 'rate', ''],
    FACTION_IDS.map((f) => [f, byFaction[f].wins, byFaction[f].games, pct(rate(byFaction[f])), bar(rate(byFaction[f]), 0.5, 25)]),
  ),
);

console.log('\nWin rate by policy:');
console.log(
  table(
    ['policy', 'wins', 'games', 'rate', ''],
    POLICY_NAMES.map((p) => [p, byPolicy[p].wins, byPolicy[p].games, pct(rate(byPolicy[p])), bar(rate(byPolicy[p]), 0.5, 25)]),
  ),
);

console.log('\nWin rate by faction x policy (wins/games):');
console.log(
  table(
    ['faction', ...POLICY_NAMES],
    FACTION_IDS.map((f) => [
      f,
      ...POLICY_NAMES.map((p) => `${byPair[f][p].wins}/${byPair[f][p].games} (${pct(rate(byPair[f][p]), 0)})`),
    ]),
  ),
);

console.log('\nVictory types:');
console.log(
  table(
    ['type', 'count', 'rate'],
    (Object.keys(victoryTypes) as VictoryType[]).map((k) => [k, victoryTypes[k], pct(victoryTypes[k] / N_GAMES)]),
  ),
);

console.log(`\nGame length: mean ${fmt(roundsSum / N_GAMES)} rounds, median ${median}`);
const maxCount = Math.max(...Object.values(lengthHist));
for (let r = 1; r <= CONFIG.game.maxRounds; r++) {
  if (lengthHist[r]) console.log(`  r${String(r).padStart(2)}  ${bar(lengthHist[r], maxCount, 30)} ${lengthHist[r]}`);
}

console.log('\nEliminations:');
console.log(
  table(
    ['faction', 'eliminated', 'rate', 'avgRound'],
    FACTION_IDS.map((f) => [
      f,
      elimCount[f],
      pct(elimCount[f] / N_GAMES),
      elimCount[f] > 0 ? fmt(elimRoundSum[f] / elimCount[f], 1) : '-',
    ]),
  ),
);

console.log('\nAvg prestige by round (r4/r8/r12/r16):');
console.log(
  table(
    ['faction', 'r4', 'r8', 'r12', 'r16'],
    FACTION_IDS.map((f) => {
      const s = avgPrestigeByRound[f];
      const at = (r: number) => (s[r - 1] !== undefined ? fmt(s[r - 1], 1) : '-');
      return [f, at(4), at(8), at(12), at(16)];
    }),
  ),
);

// sanity flags (report, do not tune)
const flags: string[] = [];
for (const f of FACTION_IDS) {
  const r = rate(byFaction[f]);
  if (r === 0) flags.push(`faction ${f} never wins`);
  if (r > 0.6) flags.push(`faction ${f} wins ${pct(r)} (>60%)`);
}
if (victoryTypes.suddenDeath / N_GAMES > 0.15) flags.push(`sudden-death rate ${pct(victoryTypes.suddenDeath / N_GAMES)} exceeds 15% target`);
if (flags.length > 0) {
  console.log('\nSANITY FLAGS:');
  for (const s of flags) console.log(`  ! ${s}`);
}

console.log(`\nResults written to ${outPath}`);
