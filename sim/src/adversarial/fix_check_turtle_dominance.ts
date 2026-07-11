/**
 * Fix verification for the turtle-dominance hunt: which CONFIG change breaks
 * the trade-max / trader Genoa (and near-miss Venice) passive dominance found
 * by run_turtle_dominance.ts — without wrecking the fullgame balance targets?
 *
 * For each candidate scenario this script reports
 *  (1) experiment-C replication (same seeds: 111003 + 600000/700000 + i) for
 *      the tradeMax and ctrlTrader arms in the venice/genoa seats, and
 *  (2) a fullgame target check (fullgame.ts scheme, seeds 111003+900000+i):
 *      per-faction and per-policy win rates + victory-type split.
 *
 * NOTE: game.ts awards great-work prestige from CONFIG.prestige.greatWork;
 * CONFIG.buildings.greatWork.prestige is a duplicate knob the engine never
 * reads (verified: mutating it changes nothing). Scenarios below mutate the
 * live knob. All mutations are in-memory only; CONFIG is restored after each
 * scenario.
 *
 * Run:  npx tsx src/adversarial/fix_check_turtle_dominance.ts   (from sim/)
 * Env:  GAMES (default 600 per cell), FULLGAMES (default 800 per scenario).
 */

import { readFileSync } from 'node:fs';
import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName, type VictoryType } from '../game';
import { makeAgent } from '../agents';
import { isSmoke, pct, table, writeResults } from '../util';
import { makeTradeMaxTurtleAgent } from './turtle_dominance';

const BASE_SEED = 111003;
const N = process.env.GAMES ? Number.parseInt(process.env.GAMES, 10) : isSmoke() ? 20 : 600;
const NFULL = process.env.FULLGAMES ? Number.parseInt(process.env.FULLGAMES, 10) : isSmoke() ? 40 : 800;
const ARMS = ['tradeMax', 'ctrlTrader'] as const;
const SEATS: FactionId[] = ['venice', 'genoa'];

interface Scenario {
  name: string;
  apply: () => void;
  restore: () => void;
}

const scenarios: Scenario[] = [
  {
    name: 'baseline',
    apply: () => {},
    restore: () => {},
  },
  {
    name: 'routeP .45 + gwP 5->3',
    apply: () => {
      CONFIG.prestige.tradeRoutePerRound = 0.45;
      CONFIG.prestige.greatWork = 3;
    },
    restore: () => {
      CONFIG.prestige.tradeRoutePerRound = 0.6;
      CONFIG.prestige.greatWork = 5;
    },
  },
  {
    name: 'maxRoutes 3->2',
    apply: () => (CONFIG.trade.maxRoutesPerFaction = 2),
    restore: () => (CONFIG.trade.maxRoutesPerFaction = 3),
  },
  {
    name: 'routeP .4 + gwP 3 + keyCityP 1.5->1.25',
    apply: () => {
      CONFIG.prestige.tradeRoutePerRound = 0.4;
      CONFIG.prestige.greatWork = 3;
      CONFIG.prestige.keyCityPerRound = 1.25;
    },
    restore: () => {
      CONFIG.prestige.tradeRoutePerRound = 0.6;
      CONFIG.prestige.greatWork = 5;
      CONFIG.prestige.keyCityPerRound = 1.5;
    },
  },
];

const fixCheck: Record<string, unknown> = {};

for (const sc of scenarios) {
  sc.apply();
  console.log(`\n===== scenario: ${sc.name} =====`);

  // ---- (1) experiment C replication
  const rows: Array<Array<string | number>> = [];
  const scOut: Record<string, unknown> = {};
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
          agents[f] = f === seat ? (arm === 'tradeMax' ? makeTradeMaxTurtleAgent() : makeAgent('trader')) : makeAgent(pool[j++]);
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
  console.log(
    `fullgame(${NFULL}): faction ` +
      FACTION_IDS.map((f) => `${f} ${pct(byFaction[f] / NFULL, 0)}`).join(', '),
  );
  console.log(
    '            policy  ' +
      POLICY_NAMES.map((p) => `${p} ${pct(byPolicy[p].wins / byPolicy[p].games, 0)}`).join(', '),
  );
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
  fixCheck[sc.name] = scOut;

  sc.restore();
}

// Append the fix sweep to the hunt's results file (created by
// run_turtle_dominance.ts; run that first).
try {
  const existing = JSON.parse(
    readFileSync(new URL('../../results/adversarial_turtle_dominance.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  existing.fixCheck = {
    note: 'experiment-C replication + fullgame target check per candidate CONFIG mutation (in-memory only)',
    gamesPerCell: N,
    fullgamesPerScenario: NFULL,
    scenarios: fixCheck,
  };
  writeResults('adversarial_turtle_dominance', existing);
  console.log('\nfixCheck section appended to sim/results/adversarial_turtle_dominance.json');
} catch {
  writeResults('adversarial_turtle_dominance_fixcheck', fixCheck);
  console.log('\nmain results file missing; wrote adversarial_turtle_dominance_fixcheck.json');
}
