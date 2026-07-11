/**
 * Fix verification for the turtle-dominance hunt vs the FINAL canon config
 * (seed 311003 protocol). The hunt (run_turtle_dominance.ts) found:
 *   - monopolyMax venice 60.7% / genoa 56.5%, tradeMax genoa 53.7%,
 *     shipping trader genoa 56.8% (all > the 50% exploit bar), and
 *   - 43.3% of all-turtle games end in a near-tie (margin < 2).
 * The passive prestige engine under final canon = trade MONOPOLY +2/round
 * (route prestige is 0) + key city 1/round + own capital 1/round + great
 * works 5 — enough to idle to ~73-79 avg vs threshold 82; converting one
 * extra neutral route endpoint (Smyrna/Cyprus/Ragusa) tips it over.
 *
 * Which CONFIG change breaks the passive dominance without wrecking the
 * fullgame targets? For each candidate scenario this reports
 *  (1) experiment-C replication (same seeds: 311003 + 600000/700000 + i)
 *      for the tradeMax / monopolyMax / ctrlTrader arms in venice/genoa,
 *  (2) a fullgame target check (fullgame scheme, seeds 311003 + 900000 + i):
 *      per-faction + per-policy win rates, victory types, median length,
 *  (3) an all-turtle near-tie check (seeds 311003 + i, mirror protocol).
 *
 * All mutations are in-memory only; original values are captured from the
 * live CONFIG before the sweep and restored after each scenario.
 *
 * Run:  npx tsx src/adversarial/fix_check_turtle_dominance.ts   (from sim/)
 * Env:  GAMES (default 600/cell), FULLGAMES (default 1000), TURTLEGAMES
 *       (default 400), SMOKE=1 tiny runs.
 */

import { readFileSync } from 'node:fs';
import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type GameResult, type PolicyName, type VictoryType } from '../game';
import { makeAgent } from '../agents';
import { isSmoke, pct, table, writeResults } from '../util';
import { makeMonopolyMaxAgent, makeTradeMaxTurtleAgent } from './turtle_dominance';

const BASE_SEED = 311003;
const N = process.env.GAMES ? Number.parseInt(process.env.GAMES, 10) : isSmoke() ? 20 : 600;
const NFULL = process.env.FULLGAMES ? Number.parseInt(process.env.FULLGAMES, 10) : isSmoke() ? 40 : 1000;
const NTURTLE = process.env.TURTLEGAMES ? Number.parseInt(process.env.TURTLEGAMES, 10) : isSmoke() ? 30 : 400;
const ARMS = ['tradeMax', 'monopolyMax', 'ctrlTrader'] as const;
const SEATS: FactionId[] = ['venice', 'genoa'];

// live knob snapshot (single source of truth for restore)
const ORIG = {
  tradeMonopolyPerRound: CONFIG.prestige.tradeMonopolyPerRound,
  greatWork: CONFIG.prestige.greatWork,
  keyCityPerRound: CONFIG.prestige.keyCityPerRound,
  victoryThreshold: CONFIG.prestige.victoryThreshold,
};
function restoreAll(): void {
  CONFIG.prestige.tradeMonopolyPerRound = ORIG.tradeMonopolyPerRound;
  CONFIG.prestige.greatWork = ORIG.greatWork;
  CONFIG.prestige.keyCityPerRound = ORIG.keyCityPerRound;
  CONFIG.prestige.victoryThreshold = ORIG.victoryThreshold;
}

interface Scenario {
  name: string;
  apply: () => void;
}

const scenarios: Scenario[] = [
  { name: 'baseline', apply: () => {} },
  { name: 'monopolyP 2->1.5', apply: () => (CONFIG.prestige.tradeMonopolyPerRound = 1.5) },
  { name: 'monopolyP 2->1', apply: () => (CONFIG.prestige.tradeMonopolyPerRound = 1) },
  {
    name: 'monopolyP 2->1 + gwP 5->4',
    apply: () => {
      CONFIG.prestige.tradeMonopolyPerRound = 1;
      CONFIG.prestige.greatWork = 4;
    },
  },
];

/** Winner's prestige margin over the best OTHER surviving faction. */
function winnerMargin(res: GameResult): number {
  let best = -Infinity;
  for (const f of FACTION_IDS) {
    if (f === res.winner || res.eliminated[f] !== undefined) continue;
    best = Math.max(best, res.finalPrestige[f]);
  }
  return best === -Infinity ? Infinity : res.finalPrestige[res.winner] - best;
}

const fixCheck: Record<string, unknown> = {};

for (const sc of scenarios) {
  restoreAll();
  sc.apply();
  console.log(`\n===== scenario: ${sc.name} =====`);
  const scOut: Record<string, unknown> = {};

  // ---- (1) experiment C replication
  const rows: Array<Array<string | number>> = [];
  for (const arm of ARMS) {
    for (const seat of SEATS) {
      const off = seat === 'venice' ? 600_000 : 700_000;
      let wins = 0;
      let thr = 0;
      let cap = 0;
      let prestigeSum = 0;
      for (let i = 0; i < N; i++) {
        const seed = BASE_SEED + off + i;
        const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
        const pool: PolicyName[] = [...POLICY_NAMES];
        create(seed).fork(97).shuffle(pool);
        const agents = {} as Record<FactionId, Agent>;
        let j = 0;
        for (const f of FACTION_IDS) {
          agents[f] =
            f === seat
              ? arm === 'tradeMax'
                ? makeTradeMaxTurtleAgent()
                : arm === 'monopolyMax'
                  ? makeMonopolyMaxAgent()
                  : makeAgent('trader')
              : makeAgent(pool[j++]);
        }
        const res = new Game(seed, agents, seatOrder).run();
        prestigeSum += res.finalPrestige[seat];
        if (res.winner === seat) {
          wins++;
          if (res.victoryType === 'threshold') thr++;
          if (res.victoryType === 'cap') cap++;
        }
      }
      rows.push([arm, seat, `${wins}/${N}`, pct(wins / N), `${thr}/${cap}`, (prestigeSum / N).toFixed(1)]);
      scOut[`${arm}_${seat}`] = { wins, games: N, rate: wins / N, thresholdWins: thr, capWins: cap, avgPrestige: prestigeSum / N };
    }
  }
  console.log(table(['arm', 'seat', 'wins', 'rate', 'thr/cap', 'avgPrestige'], rows));

  // ---- (2) fullgame target check
  const byFaction: Record<FactionId, number> = Object.fromEntries(FACTION_IDS.map((f) => [f, 0])) as Record<FactionId, number>;
  const byPolicy: Record<PolicyName, { wins: number; games: number }> = Object.fromEntries(
    POLICY_NAMES.map((p) => [p, { wins: 0, games: 0 }]),
  ) as Record<PolicyName, { wins: number; games: number }>;
  const vt: Record<VictoryType, number> = { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 };
  const lengths: number[] = [];
  for (let i = 0; i < NFULL; i++) {
    const seed = BASE_SEED + 900_000 + i;
    const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
    const pool: PolicyName[] = [...POLICY_NAMES, POLICY_NAMES[i % POLICY_NAMES.length]];
    create(seed).fork(97).shuffle(pool);
    const policyOf = {} as Record<FactionId, PolicyName>;
    const agents = {} as Record<FactionId, Agent>;
    FACTION_IDS.forEach((f, j) => {
      policyOf[f] = pool[j];
      agents[f] = makeAgent(pool[j]);
    });
    const res = new Game(seed, agents, seatOrder).run();
    byFaction[res.winner]++;
    for (const f of FACTION_IDS) byPolicy[policyOf[f]].games++;
    byPolicy[policyOf[res.winner]].wins++;
    vt[res.victoryType]++;
    lengths.push(res.rounds);
  }
  lengths.sort((a, b) => a - b);
  console.log(`fullgame(${NFULL}): faction ` + FACTION_IDS.map((f) => `${f} ${pct(byFaction[f] / NFULL, 0)}`).join(', '));
  console.log('            policy  ' + POLICY_NAMES.map((p) => `${p} ${pct(byPolicy[p].wins / byPolicy[p].games, 0)}`).join(', '));
  console.log(
    `            victory threshold ${pct(vt.threshold / NFULL, 0)}, cap ${pct(vt.cap / NFULL, 0)}, ` +
      `SD ${pct(vt.suddenDeath / NFULL, 0)}, elim ${pct(vt.elimination / NFULL, 0)}; median len ${lengths[Math.floor(NFULL / 2)]}`,
  );
  scOut.fullgame = {
    games: NFULL,
    factionWinRates: Object.fromEntries(FACTION_IDS.map((f) => [f, byFaction[f] / NFULL])),
    policyWinRates: Object.fromEntries(POLICY_NAMES.map((p) => [p, byPolicy[p].wins / byPolicy[p].games])),
    victoryTypeRates: Object.fromEntries((Object.keys(vt) as VictoryType[]).map((k) => [k, vt[k] / NFULL])),
    medianLength: lengths[Math.floor(NFULL / 2)],
  };

  // ---- (3) all-turtle near-tie check
  let nearTies = 0;
  let capGames = 0;
  for (let i = 0; i < NTURTLE; i++) {
    const seed = BASE_SEED + i;
    const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
    const agents = {} as Record<FactionId, Agent>;
    for (const f of FACTION_IDS) agents[f] = makeAgent('turtler');
    const res = new Game(seed, agents, seatOrder).run();
    if (winnerMargin(res) < 2) nearTies++;
    if (res.victoryType === 'cap') capGames++;
  }
  console.log(`all-turtle(${NTURTLE}): near-ties ${nearTies} = ${pct(nearTies / NTURTLE)}, cap games ${pct(capGames / NTURTLE)}`);
  scOut.allTurtle = { games: NTURTLE, nearTieShare: nearTies / NTURTLE, capShare: capGames / NTURTLE };

  fixCheck[sc.name] = scOut;
}
restoreAll();

// Append the fix sweep to the hunt's results file (created by
// run_turtle_dominance.ts; run that first).
try {
  const existing = JSON.parse(
    readFileSync(new URL('../../results/adversarial_turtle_dominance.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  existing.fixCheck = {
    note: 'experiment-C replication + fullgame target check + all-turtle near-tie check per candidate CONFIG mutation (in-memory only)',
    gamesPerCell: N,
    fullgamesPerScenario: NFULL,
    allTurtleGamesPerScenario: NTURTLE,
    scenarios: fixCheck,
  };
  writeResults('adversarial_turtle_dominance', existing);
  console.log('\nfixCheck section appended to sim/results/adversarial_turtle_dominance.json');
} catch {
  writeResults('adversarial_turtle_dominance_fixcheck', fixCheck);
  console.log('\nmain results file missing; wrote adversarial_turtle_dominance_fixcheck.json');
}
