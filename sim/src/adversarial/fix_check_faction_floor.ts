/**
 * Fix verification for the faction-floor hunt.
 *
 * Confirmed exploit: genoa+trader vs a neutral mixed field wins 64.9%
 * (>55% auto-pick). Trade prestige/income is the driver (573/649 wins are
 * threshold wins). This script tests candidate CONFIG mutations (in-memory
 * only, restored afterwards) against:
 *   (1) genoa+trader vs mixed and venice+trader vs mixed at N games
 *       (fresh fork ids 6000+), and
 *   (2) a fullgame.ts-style target check (NFULL games, seeds BASE+900000+i):
 *       per-faction / per-policy win rates, victory-type split, median length
 *       — so the fix does not break T1/T2/T3.
 *
 *   cd sim && npx tsx src/adversarial/fix_check_faction_floor.ts
 */

import { readFileSync } from 'node:fs';
import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName, type VictoryType } from '../game';
import { makeAgent } from '../agents';
import { isSmoke, pct, table, writeResults } from '../util';
import { runConfig } from './faction_floor';

const BASE_SEED = process.env.SEED ? Number.parseInt(process.env.SEED, 10) : 111006;
const N = process.env.GAMES ? Number.parseInt(process.env.GAMES, 10) : isSmoke() ? 30 : 1000;
const NFULL = process.env.FULLGAMES ? Number.parseInt(process.env.FULLGAMES, 10) : isSmoke() ? 40 : 800;

interface Scenario {
  name: string;
  apply: () => void;
  restore: () => void;
}

const scenarios: Scenario[] = [
  { name: 'baseline', apply: () => {}, restore: () => {} },
  {
    name: 'routeP 0.6->0.5',
    apply: () => {
      CONFIG.prestige.tradeRoutePerRound = 0.5;
    },
    restore: () => {
      CONFIG.prestige.tradeRoutePerRound = 0.6;
    },
  },
  {
    name: 'genoaTrade 1.4->1.25',
    apply: () => {
      CONFIG.factions.genoa.tradeIncomeMult = 1.25;
    },
    restore: () => {
      CONFIG.factions.genoa.tradeIncomeMult = 1.4;
    },
  },
  {
    name: 'routeP 0.5 + genoaTrade 1.25',
    apply: () => {
      CONFIG.prestige.tradeRoutePerRound = 0.5;
      CONFIG.factions.genoa.tradeIncomeMult = 1.25;
    },
    restore: () => {
      CONFIG.prestige.tradeRoutePerRound = 0.6;
      CONFIG.factions.genoa.tradeIncomeMult = 1.4;
    },
  },
  {
    name: 'greatWorkP -1 each',
    apply: () => {
      // per-work prestige since the engine reconciliation (canon §9.2)
      CONFIG.buildings.greatWorks.forEach((w) => (w.prestige = Math.max(1, w.prestige - 1)));
    },
    restore: () => {
      const canon: Record<string, number> = { grandBazaar: 5, theodosianWalls: 6, greatUniversity: 6, hagiaSophia: 10 };
      CONFIG.buildings.greatWorks.forEach((w) => (w.prestige = canon[w.id] ?? w.prestige));
    },
  },
  {
    name: 'threshold 70->78',
    apply: () => {
      CONFIG.prestige.victoryThreshold = 78;
    },
    restore: () => {
      CONFIG.prestige.victoryThreshold = 70;
    },
  },
  {
    name: 'maxRoutes 3->2',
    apply: () => {
      CONFIG.trade.maxRoutesPerFaction = 2;
    },
    restore: () => {
      CONFIG.trade.maxRoutesPerFaction = 3;
    },
  },
  {
    name: 'maxRoutes 2 + threshold 66',
    apply: () => {
      CONFIG.trade.maxRoutesPerFaction = 2;
      CONFIG.prestige.victoryThreshold = 66;
    },
    restore: () => {
      CONFIG.trade.maxRoutesPerFaction = 3;
      CONFIG.prestige.victoryThreshold = 70;
    },
  },
  {
    name: 'maxRoutes 2 + keyCityP 1.75',
    apply: () => {
      CONFIG.trade.maxRoutesPerFaction = 2;
      CONFIG.prestige.keyCityPerRound = 1.75;
    },
    restore: () => {
      CONFIG.trade.maxRoutesPerFaction = 3;
      CONFIG.prestige.keyCityPerRound = 1.5;
    },
  },
  {
    name: 'maxR2 + thr66 + captureP 1.5',
    apply: () => {
      CONFIG.trade.maxRoutesPerFaction = 2;
      CONFIG.prestige.victoryThreshold = 66;
      CONFIG.prestige.provinceCapture = 1.5;
    },
    restore: () => {
      CONFIG.trade.maxRoutesPerFaction = 3;
      CONFIG.prestige.victoryThreshold = 70;
      CONFIG.prestige.provinceCapture = 2;
    },
  },
  {
    name: 'maxR2 + thr66 + warWon 6->4',
    apply: () => {
      CONFIG.trade.maxRoutesPerFaction = 2;
      CONFIG.prestige.victoryThreshold = 66;
      CONFIG.prestige.warWon = 4;
    },
    restore: () => {
      CONFIG.trade.maxRoutesPerFaction = 3;
      CONFIG.prestige.victoryThreshold = 70;
      CONFIG.prestige.warWon = 6;
    },
  },
  {
    name: 'maxR2 + thr66 + byzCapGold 0',
    apply: () => {
      CONFIG.trade.maxRoutesPerFaction = 2;
      CONFIG.prestige.victoryThreshold = 66;
      CONFIG.factions.byzantium.capitalExtraGold = 0;
    },
    restore: () => {
      CONFIG.trade.maxRoutesPerFaction = 3;
      CONFIG.prestige.victoryThreshold = 70;
      CONFIG.factions.byzantium.capitalExtraGold = 2;
    },
  },
];

/** fullgame.ts scheme: rotating seats, per-game shuffled policy pool. */
function fullgameCheck(nGames: number) {
  const byFaction = Object.fromEntries(FACTION_IDS.map((f) => [f, 0])) as Record<FactionId, number>;
  const byPolicy = Object.fromEntries(POLICY_NAMES.map((p) => [p, 0])) as Record<PolicyName, number>;
  const vt: Record<VictoryType, number> = { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 };
  const lengths: number[] = [];
  for (let i = 0; i < nGames; i++) {
    const seed = BASE_SEED + 900000 + i;
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
    byPolicy[policyOf[res.winner]]++;
    vt[res.victoryType]++;
    lengths.push(res.rounds);
  }
  lengths.sort((a, b) => a - b);
  return {
    games: nGames,
    factionWinRates: Object.fromEntries(FACTION_IDS.map((f) => [f, byFaction[f] / nGames])),
    policyWinRates: Object.fromEntries(POLICY_NAMES.map((p) => [p, byPolicy[p] / nGames])),
    victoryTypeRates: Object.fromEntries(
      (Object.keys(vt) as VictoryType[]).map((k) => [k, vt[k] / nGames]),
    ),
    medianLength: lengths[Math.floor(lengths.length / 2)],
  };
}

const t0 = performance.now();
const results: Record<string, unknown> = {};
scenarios.forEach((sc, si) => {
  sc.apply();
  try {
    const genoa = runConfig('genoa', 'trader', 'mixed', N, BASE_SEED, 6000 + si * 10);
    const venice = runConfig('venice', 'trader', 'mixed', N, BASE_SEED, 6001 + si * 10);
    const byz = runConfig('byzantium', 'rusher', 'mixed', N, BASE_SEED, 6002 + si * 10);
    const full = fullgameCheck(NFULL);
    results[sc.name] = {
      genoaTraderMixed: { rate: genoa.focalWinRate, wins: genoa.focalWins, games: genoa.games, winTypes: genoa.focalWinTypes },
      veniceTraderMixed: { rate: venice.focalWinRate, wins: venice.focalWins, games: venice.games },
      byzRusherMixed: { rate: byz.focalWinRate, wins: byz.focalWins, games: byz.games },
      fullgame: full,
    };
    console.log(
      `${sc.name.padEnd(30)} genoa+trader ${pct(genoa.focalWinRate)}  venice+trader ${pct(venice.focalWinRate)}  byz+rusher ${pct(byz.focalWinRate)}  ` +
        `full: trader ${pct((full.policyWinRates as Record<string, number>).trader)}, ` +
        `genoa ${pct((full.factionWinRates as Record<string, number>).genoa)}, ` +
        `threshold ${pct((full.victoryTypeRates as Record<string, number>).threshold)}, median ${full.medianLength}`,
    );
  } finally {
    sc.restore();
  }
});
const elapsedMs = performance.now() - t0;

// merge into the results file
const path = new URL('../../results/adversarial_faction_floor.json', import.meta.url);
let existing: Record<string, unknown> = {};
try {
  existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
} catch {
  /* fine */
}
existing.fixCheck = {
  note: 'in-memory CONFIG mutations, restored after each scenario; grid cells use fork ids 6000+, fullgame seeds BASE+900000+i',
  gamesPerCell: N,
  fullgamesPerScenario: NFULL,
  baseSeed: BASE_SEED,
  elapsedMs: Math.round(elapsedMs),
  scenarios: results,
};
const outPath = writeResults('adversarial_faction_floor', existing);
console.log(`\n${(elapsedMs / 1000).toFixed(1)}s. Results merged into ${outPath}`);
