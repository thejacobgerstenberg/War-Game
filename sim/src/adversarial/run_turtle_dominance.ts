/**
 * ADVERSARIAL runner: turtle-dominance exploit hunt.
 *
 * Three experiments (base seed 111003, all deterministic):
 *
 *  A. all-turtle mirror (default 400 games): all five factions run the
 *     shipping 'turtler' policy. Question: does anyone actually win, or do
 *     these games limp to the round-16 cap in a near-tie (winner margin
 *     < 2 prestige over the best surviving rival)?
 *     Seed = 311003 + i, seat order rotates i%5.
 *
 *  B. lone turtler vs 4 aggressive seats (default 250 games x 5 factions
 *     per arm): the turtler rotates through every faction; the other four
 *     seats run
 *       arm 'aggr': 2x rusher + 2x opportunist (pure aggression), or
 *       arm 'std' : rusher/trader/opportunist + a rotating duplicate
 *     shuffled per game with fork(97). Question: does the lone turtle
 *     free-ride on the wars around it to > 40% overall?
 *     Seed = 311003 + 100000*(factionIdx+1) + i (same seeds in both arms).
 *
 *  C. trade-max turtle as Venice / as Genoa (default 600 games per faction
 *     per arm): the adversarial agents from turtle_dominance.ts.
 *       arm 'tradeMax'    : stacks routes + great works, never attacks;
 *       arm 'monopolyMax' : same, plus snipes NEUTRAL route endpoints to
 *                           convert open routes into +2/round monopolies
 *                           (final-canon prestige economy: route prestige 0,
 *                           monopoly 2) and neutral objective provinces.
 *     Control arms run the shipping 'turtler' and the shipping 'trader' in
 *     the same seat on identical seeds. The other four seats run the four
 *     standard policies (one each, fork(97) shuffle). Question: does
 *     passive trade-prestige stacking exceed 50%?
 *     Seed = 311003 + 600000 + i (venice), 311003 + 700000 + i (genoa).
 *
 * EXPLOIT THRESHOLDS (hunt brief):
 *   - pure turtle > 40% overall in experiment B;
 *   - > 30% of all-turtle games end at the cap in a near-tie (margin < 2);
 *   - trade-max Venice or Genoa > 50% in experiment C.
 *
 * Run:  npx tsx src/adversarial/run_turtle_dominance.ts     (from sim/)
 * Env:  GAMES_A / GAMES_B / GAMES_C override counts; SMOKE=1 tiny runs.
 * Writes sim/results/adversarial_turtle_dominance.json.
 */

import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type GameResult, type PolicyName, type VictoryType } from '../game';
import { makeAgent } from '../agents';
import { isSmoke, pct, table, writeResults } from '../util';
import { makeMonopolyMaxAgent, makeTradeMaxTurtleAgent } from './turtle_dominance';

const BASE_SEED = 311003;
const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};
const N_A = envInt('GAMES_A') ?? (isSmoke() ? 30 : 400); // all-turtle games
const N_B = envInt('GAMES_B') ?? (isSmoke() ? 10 : 250); // per faction per arm
const N_C = envInt('GAMES_C') ?? (isSmoke() ? 20 : 600); // per faction per arm

const t0 = performance.now();

// -------------------------------------------------------------- shared bits

/** Winner's prestige margin over the best OTHER faction still alive. */
function winnerMargin(res: GameResult): number {
  let best = -Infinity;
  for (const f of FACTION_IDS) {
    if (f === res.winner || res.eliminated[f] !== undefined) continue;
    best = Math.max(best, res.finalPrestige[f]);
  }
  return best === -Infinity ? Infinity : res.finalPrestige[res.winner] - best;
}

function newVT(): Record<VictoryType, number> {
  return { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 };
}

// =================================================== A. all-turtle mirror

const aVictory = newVT();
const aWinsByFaction: Record<FactionId, number> = Object.fromEntries(FACTION_IDS.map((f) => [f, 0])) as Record<FactionId, number>;
const aMargins: number[] = [];
let aCapGames = 0;
let aCapNearTies = 0; // cap-decided AND margin < 2
let aNearTiesAnyType = 0; // margin < 2 regardless of victory type
let aThresholdGames = 0;
let aRoundsSum = 0;
let aBattlesSum = 0;
let aWinnerPrestigeSum = 0;

for (let i = 0; i < N_A; i++) {
  const seed = BASE_SEED + i;
  const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
  const agents = {} as Record<FactionId, Agent>;
  for (const f of FACTION_IDS) agents[f] = makeAgent('turtler');
  const res = new Game(seed, agents, seatOrder).run();

  aVictory[res.victoryType]++;
  aWinsByFaction[res.winner]++;
  aRoundsSum += res.rounds;
  aBattlesSum += res.battles;
  aWinnerPrestigeSum += res.finalPrestige[res.winner];
  const m = winnerMargin(res);
  aMargins.push(m);
  if (m < 2) aNearTiesAnyType++;
  if (res.victoryType === 'cap') {
    aCapGames++;
    if (m < 2) aCapNearTies++;
  }
  if (res.victoryType === 'threshold') aThresholdGames++;
}

// ============================== B. lone turtler vs aggressive/standard field

type BArm = 'aggr' | 'std';
const B_ARMS: BArm[] = ['aggr', 'std'];

interface BStats {
  games: number;
  wins: number;
  winTypes: Record<VictoryType, number>;
  eliminated: number;
  prestigeSum: number;
  roundsSum: number;
}
const bStats: Record<BArm, Record<FactionId, BStats>> = Object.fromEntries(
  B_ARMS.map((a) => [
    a,
    Object.fromEntries(
      FACTION_IDS.map((f) => [f, { games: 0, wins: 0, winTypes: newVT(), eliminated: 0, prestigeSum: 0, roundsSum: 0 }]),
    ),
  ]),
) as Record<BArm, Record<FactionId, BStats>>;

for (const arm of B_ARMS) {
  FACTION_IDS.forEach((turtleFaction, fi) => {
    for (let i = 0; i < N_B; i++) {
      const seed = BASE_SEED + 100_000 * (fi + 1) + i;
      const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
      const pool: PolicyName[] =
        arm === 'aggr'
          ? ['rusher', 'rusher', 'opportunist', 'opportunist']
          : (() => {
              const base: PolicyName[] = ['rusher', 'trader', 'opportunist'];
              return [...base, base[i % base.length]];
            })();
      create(seed).fork(97).shuffle(pool);
      const agents = {} as Record<FactionId, Agent>;
      let j = 0;
      for (const f of FACTION_IDS) {
        agents[f] = f === turtleFaction ? makeAgent('turtler') : makeAgent(pool[j++]);
      }
      const res = new Game(seed, agents, seatOrder).run();
      const s = bStats[arm][turtleFaction];
      s.games++;
      s.roundsSum += res.rounds;
      s.prestigeSum += res.finalPrestige[turtleFaction];
      if (res.winner === turtleFaction) {
        s.wins++;
        s.winTypes[res.victoryType]++;
      }
      if (res.eliminated[turtleFaction] !== undefined) s.eliminated++;
    }
  });
}

// ============================== C. trade-max turtle as Venice and as Genoa

type CArm = 'tradeMax' | 'monopolyMax' | 'ctrlTurtler' | 'ctrlTrader';
const C_ARMS: CArm[] = ['tradeMax', 'monopolyMax', 'ctrlTurtler', 'ctrlTrader'];
const C_FACTIONS: FactionId[] = ['venice', 'genoa'];

function cAgent(arm: CArm): Agent {
  if (arm === 'tradeMax') return makeTradeMaxTurtleAgent();
  if (arm === 'monopolyMax') return makeMonopolyMaxAgent();
  return makeAgent(arm === 'ctrlTurtler' ? 'turtler' : 'trader');
}

interface CStats {
  games: number;
  wins: number;
  winTypes: Record<VictoryType, number>;
  eliminated: number;
  prestigeSum: number;
  greatWorkPrestigeSum: number;
  tradePrestigeSum: number;
  keyCityPrestigeSum: number;
  capitalPrestigeSum: number;
  conquestPrestigeSum: number;
  objectivePrestigeSum: number;
  roundsSum: number;
}
const cStats: Record<CArm, Record<FactionId, CStats>> = Object.fromEntries(
  C_ARMS.map((a) => [
    a,
    Object.fromEntries(
      C_FACTIONS.map((f) => [
        f,
        {
          games: 0, wins: 0, winTypes: newVT(), eliminated: 0, prestigeSum: 0,
          greatWorkPrestigeSum: 0, tradePrestigeSum: 0, keyCityPrestigeSum: 0,
          capitalPrestigeSum: 0, conquestPrestigeSum: 0, objectivePrestigeSum: 0, roundsSum: 0,
        },
      ]),
    ),
  ]),
) as Record<CArm, Record<FactionId, CStats>>;

for (const arm of C_ARMS) {
  C_FACTIONS.forEach((advFaction) => {
    const off = advFaction === 'venice' ? 600_000 : 700_000;
    for (let i = 0; i < N_C; i++) {
      const seed = BASE_SEED + off + i;
      const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
      const pool: PolicyName[] = [...POLICY_NAMES];
      create(seed).fork(97).shuffle(pool);
      const agents = {} as Record<FactionId, Agent>;
      let j = 0;
      for (const f of FACTION_IDS) {
        agents[f] = f === advFaction ? cAgent(arm) : makeAgent(pool[j++]);
      }
      const game = new Game(seed, agents, seatOrder);
      const res = game.run();
      const s = cStats[arm][advFaction];
      s.games++;
      s.roundsSum += res.rounds;
      s.prestigeSum += res.finalPrestige[advFaction];
      const led = game.faction(advFaction).ledger;
      s.greatWorkPrestigeSum += led.greatWorks;
      s.tradePrestigeSum += led.tradeRoutes;
      s.keyCityPrestigeSum += led.keyCities;
      s.capitalPrestigeSum += led.capitals;
      s.conquestPrestigeSum += led.conquests;
      s.objectivePrestigeSum += led.objectives;
      if (res.winner === advFaction) {
        s.wins++;
        s.winTypes[res.victoryType]++;
      }
      if (res.eliminated[advFaction] !== undefined) s.eliminated++;
    }
  });
}

const elapsedMs = performance.now() - t0;

// ------------------------------------------------------------------ analysis

aMargins.sort((x, y) => x - y);
const finiteMargins = aMargins.filter((m) => Number.isFinite(m));
const medMargin = finiteMargins[Math.floor(finiteMargins.length / 2)] ?? null;

const bOverall = (arm: BArm) => {
  let g = 0;
  let w = 0;
  for (const f of FACTION_IDS) {
    g += bStats[arm][f].games;
    w += bStats[arm][f].wins;
  }
  return { games: g, wins: w, rate: g > 0 ? w / g : 0 };
};

const exploitFlags: string[] = [];
if (aNearTiesAnyType / N_A > 0.3) {
  exploitFlags.push(`all-turtle near-ties (margin<2, any victory type): ${pct(aNearTiesAnyType / N_A)} of games > 30%`);
}
if (aCapNearTies / N_A > 0.3) {
  exploitFlags.push(`all-turtle cap near-ties (margin<2 at the cap): ${pct(aCapNearTies / N_A)} of games > 30%`);
}
for (const arm of B_ARMS) {
  const o = bOverall(arm);
  if (o.rate > 0.4) exploitFlags.push(`lone turtler (${arm} field) overall ${pct(o.rate)} > 40%`);
}
for (const arm of ['tradeMax', 'monopolyMax'] as const) {
  for (const f of C_FACTIONS) {
    const s = cStats[arm][f];
    const r = s.wins / s.games;
    if (r > 0.5) exploitFlags.push(`${arm} turtle as ${f}: ${pct(r)} > 50%`);
  }
}

const results = {
  config: {
    baseSeed: BASE_SEED,
    smoke: isSmoke(),
    gamesA: N_A,
    gamesBPerFactionPerArm: N_B,
    gamesCPerFactionPerArm: N_C,
    victoryThreshold: CONFIG.prestige.victoryThreshold,
    elapsedMs: Math.round(elapsedMs),
    seedScheme: {
      A: 'seed = 311003 + i',
      B: 'seed = 311003 + 100000*(factionIdx+1) + i, same seeds in both arms',
      C: 'seed = 311003 + 600000 + i (venice) / + 700000 + i (genoa), same seeds in all arms',
    },
  },
  allTurtle: {
    games: N_A,
    victoryTypes: aVictory,
    winsByFaction: aWinsByFaction,
    meanRounds: aRoundsSum / N_A,
    meanBattles: aBattlesSum / N_A,
    meanWinnerPrestige: aWinnerPrestigeSum / N_A,
    capGames: aCapGames,
    thresholdGames: aThresholdGames,
    nearTiesAnyType: aNearTiesAnyType,
    nearTieShareAnyType: aNearTiesAnyType / N_A,
    capNearTies: aCapNearTies,
    capNearTieShareOfAllGames: aCapNearTies / N_A,
    capNearTieShareOfCapGames: aCapGames > 0 ? aCapNearTies / aCapGames : null,
    medianWinnerMargin: medMargin,
    marginDeciles: Array.from({ length: 11 }, (_, k) =>
      finiteMargins.length > 0 ? finiteMargins[Math.min(finiteMargins.length - 1, Math.floor((k / 10) * finiteMargins.length))] : null,
    ),
  },
  loneTurtler: Object.fromEntries(
    B_ARMS.map((arm) => [
      arm,
      {
        overall: bOverall(arm),
        byFaction: Object.fromEntries(
          FACTION_IDS.map((f) => {
            const s = bStats[arm][f];
            return [
              f,
              {
                games: s.games,
                wins: s.wins,
                rate: s.wins / s.games,
                winTypes: s.winTypes,
                eliminatedRate: s.eliminated / s.games,
                avgFinalPrestige: s.prestigeSum / s.games,
                avgRounds: s.roundsSum / s.games,
              },
            ];
          }),
        ),
      },
    ]),
  ),
  tradeMaxTurtle: Object.fromEntries(
    C_ARMS.map((arm) => [
      arm,
      Object.fromEntries(
        C_FACTIONS.map((f) => {
          const s = cStats[arm][f];
          return [
            f,
            {
              games: s.games,
              wins: s.wins,
              rate: s.wins / s.games,
              winTypes: s.winTypes,
              eliminatedRate: s.eliminated / s.games,
              avgFinalPrestige: s.prestigeSum / s.games,
              avgGreatWorkPrestige: s.greatWorkPrestigeSum / s.games,
              avgTradeRoutePrestige: s.tradePrestigeSum / s.games,
              avgKeyCityPrestige: s.keyCityPrestigeSum / s.games,
              avgCapitalPrestige: s.capitalPrestigeSum / s.games,
              avgConquestPrestige: s.conquestPrestigeSum / s.games,
              avgObjectivePrestige: s.objectivePrestigeSum / s.games,
              avgRounds: s.roundsSum / s.games,
            },
          ];
        }),
      ),
    ]),
  ),
  exploitThresholds: {
    loneTurtleOver40pct: 'flagged if crossed',
    allTurtleNearTieOver30pct: 'winner margin < 2 prestige',
    tradeMaxVeniceGenoaOver50pct: 'flagged if crossed',
  },
  exploitFlags,
};

const outPath = writeResults('adversarial_turtle_dominance', results);

// ------------------------------------------------------------------- report

console.log(
  `turtle-dominance exploit hunt — base seed ${BASE_SEED}, ` +
    `A=${N_A} all-turtle, B=${N_B}x5x2 lone-turtle, C=${N_C}x2x4 trade/monopoly-max, ${(elapsedMs / 1000).toFixed(1)}s`,
);

console.log('\n[A] all-turtle mirror:');
console.log(
  table(
    ['metric', 'value'],
    [
      ['victory types', `threshold ${aVictory.threshold}, cap ${aVictory.cap}, suddenDeath ${aVictory.suddenDeath}, elim ${aVictory.elimination}`],
      ['mean rounds', (aRoundsSum / N_A).toFixed(2)],
      ['mean battles/game', (aBattlesSum / N_A).toFixed(1)],
      ['mean winner prestige', (aWinnerPrestigeSum / N_A).toFixed(1)],
      ['near-ties margin<2 (any type)', `${aNearTiesAnyType}/${N_A} = ${pct(aNearTiesAnyType / N_A)}`],
      ['near-ties margin<2 at cap', `${aCapNearTies}/${N_A} = ${pct(aCapNearTies / N_A)} (of cap games: ${aCapGames > 0 ? pct(aCapNearTies / aCapGames) : '-'})`],
      ['median winner margin', medMargin === null ? '-' : String(medMargin.toFixed(1))],
    ],
  ),
);
console.log('  wins by faction: ' + FACTION_IDS.map((f) => `${f} ${aWinsByFaction[f]}`).join(', '));

for (const arm of B_ARMS) {
  const o = bOverall(arm);
  console.log(`\n[B:${arm}] lone turtler vs ${arm === 'aggr' ? '2 rushers + 2 opportunists' : 'rusher/trader/opportunist+dup'}:`);
  console.log(
    table(
      ['faction', 'wins', 'games', 'rate', 'elim%', 'avgPrestige'],
      FACTION_IDS.map((f) => {
        const s = bStats[arm][f];
        return [f, s.wins, s.games, pct(s.wins / s.games), pct(s.eliminated / s.games, 0), (s.prestigeSum / s.games).toFixed(1)];
      }),
    ),
  );
  console.log(`  overall: ${o.wins}/${o.games} = ${pct(o.rate)}`);
}

console.log('\n[C] trade-max / monopoly-max turtle vs controls (same seeds):');
console.log(
  table(
    ['arm', 'faction', 'wins', 'games', 'rate', 'thr/cap/SD', 'elim%', 'avgPrestige', 'gwP', 'tradeP', 'keyP', 'capP', 'conqP', 'objP'],
    C_ARMS.flatMap((arm) =>
      C_FACTIONS.map((f) => {
        const s = cStats[arm][f];
        return [
          arm,
          f,
          s.wins,
          s.games,
          pct(s.wins / s.games),
          `${s.winTypes.threshold}/${s.winTypes.cap}/${s.winTypes.suddenDeath}`,
          pct(s.eliminated / s.games, 0),
          (s.prestigeSum / s.games).toFixed(1),
          (s.greatWorkPrestigeSum / s.games).toFixed(1),
          (s.tradePrestigeSum / s.games).toFixed(1),
          (s.keyCityPrestigeSum / s.games).toFixed(1),
          (s.capitalPrestigeSum / s.games).toFixed(1),
          (s.conquestPrestigeSum / s.games).toFixed(1),
          (s.objectivePrestigeSum / s.games).toFixed(1),
        ];
      }),
    ),
  ),
);

if (exploitFlags.length > 0) {
  console.log('\nEXPLOIT FLAGS:');
  for (const s of exploitFlags) console.log(`  ! ${s}`);
} else {
  console.log('\nNo exploit thresholds crossed.');
}

console.log(`\nResults written to ${outPath}`);
