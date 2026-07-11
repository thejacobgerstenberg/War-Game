/**
 * ADVERSARIAL RUNNER: Constantinople sudden-death beeline (cple-beeline)
 * against the FINAL canon-kernel config.
 *
 * Scenarios (each N games, per-game seed = BASE_SEED + i, seats rotated):
 *   solo_ottoman  : Ottomans beeline overland from Edirne; other four
 *                   factions play the four standard policies (seeded shuffle).
 *   solo_genoa    : Genoa beelines overland from Pera + Pera-harbor blockade.
 *   solo_venice   : Venice beelines amphibiously via a Lemnos staging hop.
 *   duo_gangup    : Ottomans AND Genoa both beeline; the remaining three
 *                   factions get 3 of the 4 standard policies.
 *   guard_ottoman : solo_ottoman but Byzantium plays the dedicated DEFENDER
 *                   (byz_guard) — tests the tuning log's "agent limitation"
 *                   dismissal of the 70%+ SD result.
 *   guard_genoa   : same counterfactual for the Genoa line.
 *
 * Measures per scenario: sudden-death rate (overall / by beeliner), SD
 * completion-round distribution + earliest, capture rounds, siege-start
 * rounds, blockade coverage, garrison size at siege start (capture-path
 * decomposition), Byzantium eliminated-before-round-8 rate, game length.
 *
 * EXPLOIT THRESHOLDS (hunt brief):
 *   - sudden death > 20% with ONE beeliner
 *   - capture-and-hold completes before round 9 (SD win with rounds <= 8)
 *     in > 10% of games
 *   - Byzantium eliminated before round 8 in > 15% of games
 *
 * Env: GAMES=<n> SEED=<n> SMOKE=1
 * Usage: cd sim && npx tsx src/adversarial/run_cple_beeline.ts
 */

import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName, type VictoryType } from '../game';
import { makeAgent } from '../agents';
import { isSmoke, pct, table, writeResults } from '../util';
import { makeByzGuardAgent } from './byz_guard';
import {
  freshTelemetry,
  makeBeelineAgent,
  type BeelineOptions,
  type BeelineTelemetry,
} from './cple_beeline';

const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};
const BASE_SEED = envInt('SEED') ?? 311002;
const N_GAMES = envInt('GAMES') ?? (isSmoke() ? 40 : 600);

// -------------------------------------------------------------- scenarios

interface Scenario {
  name: string;
  beeliners: Partial<Record<FactionId, BeelineOptions>>;
  byzGuard?: boolean;
  /** Counterfactual: run with treason-at-the-gate removed from the deck
   *  (runtime CONFIG mutation; rules.ts untouched) to isolate the card's
   *  contribution from the blockade-starvation clock. */
  noTreason?: boolean;
}

const OTTO_OPTS: BeelineOptions = { launchMin: 5, launchBy: 1 };
const GENOA_OPTS: BeelineOptions = { launchMin: 4, launchBy: 2 };
const VENICE_OPTS: BeelineOptions = { staging: 'lemnos', launchMin: 5, launchBy: 3 };

const SCENARIOS: Scenario[] = [
  { name: 'solo_ottoman', beeliners: { ottomans: OTTO_OPTS } },
  { name: 'solo_genoa', beeliners: { genoa: GENOA_OPTS } },
  { name: 'solo_venice', beeliners: { venice: VENICE_OPTS } },
  { name: 'duo_gangup', beeliners: { ottomans: OTTO_OPTS, genoa: GENOA_OPTS } },
  { name: 'guard_ottoman', beeliners: { ottomans: OTTO_OPTS }, byzGuard: true },
  { name: 'guard_genoa', beeliners: { genoa: GENOA_OPTS }, byzGuard: true },
  { name: 'solo_ottoman_noTreason', beeliners: { ottomans: OTTO_OPTS }, noTreason: true },
  { name: 'guard_ottoman_noTreason', beeliners: { ottomans: OTTO_OPTS }, byzGuard: true, noTreason: true },
];

// ------------------------------------------------------------- aggregation

interface ScenarioStats {
  name: string;
  games: number;
  baseSeed: number;
  beelinerFactions: FactionId[];
  byzGuard: boolean;
  noTreason: boolean;
  options: Partial<Record<FactionId, BeelineOptions>>;
  suddenDeath: { count: number; rate: number; byBeeliner: number; byBeelinerRate: number };
  beelinerWins: { count: number; rate: number; byType: Record<VictoryType, number> };
  sdCompletionRounds: Record<number, number>;
  sdEarliestRound: number | null;
  sdBeforeRound9: { count: number; rate: number };
  captureRounds: Record<number, number>;
  captureBeforeRound8: { count: number; rate: number };
  captureEver: { count: number; rate: number };
  siegeStartRounds: Record<number, number>;
  /** capture-path decomposition */
  garrisonAtSiegeStart: Record<number, number>;
  sdGarrisonAtSiegeStart: Record<number, number>;
  blockadeCoverage: { meanShare: number; sdWinsWithBlockade: number };
  sdWithTreasonHeld: number;
  sdWallsIntactAtLastObs: number;
  byzEliminated: { count: number; rate: number; beforeRound8: number; beforeRound8Rate: number };
  victoryTypes: Record<VictoryType, number>;
  gameLength: { median: number; mean: number; histogram: Record<number, number> };
  winRateByFaction: Record<FactionId, number>;
}

function runScenario(sc: Scenario, nGames: number, baseSeed: number): ScenarioStats {
  const beelinerFactions = Object.keys(sc.beeliners) as FactionId[];
  const stats: ScenarioStats = {
    name: sc.name,
    games: nGames,
    baseSeed,
    beelinerFactions,
    byzGuard: sc.byzGuard === true,
    noTreason: sc.noTreason === true,
    options: sc.beeliners,
    suddenDeath: { count: 0, rate: 0, byBeeliner: 0, byBeelinerRate: 0 },
    beelinerWins: { count: 0, rate: 0, byType: { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 } },
    sdCompletionRounds: {},
    sdEarliestRound: null,
    sdBeforeRound9: { count: 0, rate: 0 },
    captureRounds: {},
    captureBeforeRound8: { count: 0, rate: 0 },
    captureEver: { count: 0, rate: 0 },
    siegeStartRounds: {},
    garrisonAtSiegeStart: {},
    sdGarrisonAtSiegeStart: {},
    blockadeCoverage: { meanShare: 0, sdWinsWithBlockade: 0 },
    sdWithTreasonHeld: 0,
    sdWallsIntactAtLastObs: 0,
    byzEliminated: { count: 0, rate: 0, beforeRound8: 0, beforeRound8Rate: 0 },
    victoryTypes: { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 },
    gameLength: { median: 0, mean: 0, histogram: {} },
    winRateByFaction: { byzantium: 0, ottomans: 0, venice: 0, genoa: 0, hungary: 0 },
  };
  const lengths: number[] = [];
  let blockadeShareSum = 0;
  let blockadeShareN = 0;

  for (let i = 0; i < nGames; i++) {
    const seed = baseSeed + i;
    const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
    const pool: PolicyName[] = [...POLICY_NAMES];
    create(seed).fork(97).shuffle(pool);
    const agents = {} as Record<FactionId, Agent>;
    const tels: Partial<Record<FactionId, BeelineTelemetry>> = {};
    let pi = 0;
    for (const f of FACTION_IDS) {
      const beOpts = sc.beeliners[f];
      if (beOpts) {
        const tel = freshTelemetry();
        tels[f] = tel;
        agents[f] = makeBeelineAgent(f, beOpts, tel);
      } else if (sc.byzGuard && f === 'byzantium') {
        agents[f] = makeByzGuardAgent();
      } else {
        agents[f] = makeAgent(pool[pi++ % pool.length]);
      }
    }

    const res = new Game(seed, agents, seatOrder).run();

    stats.victoryTypes[res.victoryType]++;
    lengths.push(res.rounds);
    stats.gameLength.histogram[res.rounds] = (stats.gameLength.histogram[res.rounds] ?? 0) + 1;
    stats.winRateByFaction[res.winner]++;

    const winnerIsBeeliner = beelinerFactions.includes(res.winner);
    if (winnerIsBeeliner) {
      stats.beelinerWins.count++;
      stats.beelinerWins.byType[res.victoryType]++;
    }
    if (res.victoryType === 'suddenDeath') {
      stats.suddenDeath.count++;
      if (winnerIsBeeliner) stats.suddenDeath.byBeeliner++;
      stats.sdCompletionRounds[res.rounds] = (stats.sdCompletionRounds[res.rounds] ?? 0) + 1;
      if (stats.sdEarliestRound === null || res.rounds < stats.sdEarliestRound) stats.sdEarliestRound = res.rounds;
      if (res.rounds <= 8) stats.sdBeforeRound9.count++;
      if (winnerIsBeeliner) {
        const t = tels[res.winner]!;
        if (t.siegeObsRounds > 0 && t.blockadedRounds > 0) stats.blockadeCoverage.sdWinsWithBlockade++;
        if (t.treasonHeld) stats.sdWithTreasonHeld++;
        if (t.lastWallDamageSeen < 16) stats.sdWallsIntactAtLastObs++;
        if (t.garrisonAtSiegeStart !== null) {
          stats.sdGarrisonAtSiegeStart[t.garrisonAtSiegeStart] =
            (stats.sdGarrisonAtSiegeStart[t.garrisonAtSiegeStart] ?? 0) + 1;
        }
      }
    }

    // earliest beeliner capture round (telemetry sees ownership at the next
    // turn start; an SD win is capture at res.rounds-1 by construction).
    let capture: number | null = null;
    for (const f of beelinerFactions) {
      const t = tels[f]!;
      let c: number | null = t.firstOwnedSeenRound !== null ? t.firstOwnedSeenRound - 1 : null;
      if (res.victoryType === 'suddenDeath' && res.winner === f) {
        const c2 = res.rounds - 1;
        c = c === null ? c2 : Math.min(c, c2);
      }
      if (c !== null && (capture === null || c < capture)) capture = c;
      if (t.siegeSeenRound !== null) {
        const s = t.siegeSeenRound - 1;
        stats.siegeStartRounds[s] = (stats.siegeStartRounds[s] ?? 0) + 1;
        if (t.garrisonAtSiegeStart !== null) {
          stats.garrisonAtSiegeStart[t.garrisonAtSiegeStart] =
            (stats.garrisonAtSiegeStart[t.garrisonAtSiegeStart] ?? 0) + 1;
        }
      }
      if (t.siegeObsRounds > 0) {
        blockadeShareSum += t.blockadedRounds / t.siegeObsRounds;
        blockadeShareN++;
      }
    }
    if (capture !== null) {
      stats.captureEver.count++;
      stats.captureRounds[capture] = (stats.captureRounds[capture] ?? 0) + 1;
      if (capture < 8) stats.captureBeforeRound8.count++;
    }

    const byzElim = res.eliminated.byzantium;
    if (byzElim !== undefined) {
      stats.byzEliminated.count++;
      if (byzElim < 8) stats.byzEliminated.beforeRound8++;
    }
  }

  lengths.sort((a, b) => a - b);
  stats.gameLength.median = lengths[Math.floor(lengths.length / 2)];
  stats.gameLength.mean = lengths.reduce((a, b) => a + b, 0) / nGames;
  stats.suddenDeath.rate = stats.suddenDeath.count / nGames;
  stats.suddenDeath.byBeelinerRate = stats.suddenDeath.byBeeliner / nGames;
  stats.beelinerWins.rate = stats.beelinerWins.count / nGames;
  stats.sdBeforeRound9.rate = stats.sdBeforeRound9.count / nGames;
  stats.captureBeforeRound8.rate = stats.captureBeforeRound8.count / nGames;
  stats.captureEver.rate = stats.captureEver.count / nGames;
  stats.byzEliminated.rate = stats.byzEliminated.count / nGames;
  stats.byzEliminated.beforeRound8Rate = stats.byzEliminated.beforeRound8 / nGames;
  stats.blockadeCoverage.meanShare = blockadeShareN > 0 ? blockadeShareSum / blockadeShareN : 0;
  for (const f of FACTION_IDS) stats.winRateByFaction[f] /= nGames;
  return stats;
}

// ------------------------------------------------------------------- main

const t0 = performance.now();
const all: ScenarioStats[] = [];
const fullDeck = [...CONFIG.tacticCards];
for (const sc of SCENARIOS) {
  if (sc.noTreason) {
    CONFIG.tacticCards.length = 0;
    CONFIG.tacticCards.push(...fullDeck.filter((c) => c.slug !== 'treason-at-the-gate'));
  }
  const s = runScenario(sc, N_GAMES, BASE_SEED);
  if (sc.noTreason) {
    CONFIG.tacticCards.length = 0;
    CONFIG.tacticCards.push(...fullDeck);
  }
  all.push(s);

  console.log(`\n=== ${s.name} — ${s.games} games, seeds ${s.baseSeed}..${s.baseSeed + s.games - 1}${s.byzGuard ? ' [BYZ GUARD]' : ''}${s.noTreason ? ' [NO TREASON CARD]' : ''} ===`);
  console.log(`  beeliners: ${s.beelinerFactions.join(', ')}`);
  console.log(`  sudden death: ${s.suddenDeath.count} (${pct(s.suddenDeath.rate)}), by beeliner ${s.suddenDeath.byBeeliner} (${pct(s.suddenDeath.byBeelinerRate)})`);
  console.log(`  beeliner wins: ${s.beelinerWins.count} (${pct(s.beelinerWins.rate)})  types: ${JSON.stringify(s.beelinerWins.byType)}`);
  console.log(`  SD earliest round: ${s.sdEarliestRound}; completes <= round 8: ${s.sdBeforeRound9.count} (${pct(s.sdBeforeRound9.rate)})`);
  console.log(`  SD completion rounds: ${JSON.stringify(s.sdCompletionRounds)}`);
  console.log(`  cple captured by beeliner ever: ${s.captureEver.count} (${pct(s.captureEver.rate)}); capture < round 8: ${s.captureBeforeRound8.count} (${pct(s.captureBeforeRound8.rate)})`);
  console.log(`  capture rounds: ${JSON.stringify(s.captureRounds)}`);
  console.log(`  siege established rounds: ${JSON.stringify(s.siegeStartRounds)}`);
  console.log(`  garrison @ siege start (all sieges): ${JSON.stringify(s.garrisonAtSiegeStart)}`);
  console.log(`  garrison @ siege start (SD wins):    ${JSON.stringify(s.sdGarrisonAtSiegeStart)}`);
  console.log(`  blockade coverage: mean ${pct(s.blockadeCoverage.meanShare)}; SD wins w/ blockade ${s.blockadeCoverage.sdWinsWithBlockade}; treason-held SD ${s.sdWithTreasonHeld}; walls intact @ last obs ${s.sdWallsIntactAtLastObs}`);
  console.log(`  byz eliminated: ${s.byzEliminated.count} (${pct(s.byzEliminated.rate)}); before r8: ${s.byzEliminated.beforeRound8} (${pct(s.byzEliminated.beforeRound8Rate)})`);
  console.log(`  victory types: ${JSON.stringify(s.victoryTypes)}`);
  console.log(`  game length: median ${s.gameLength.median}, mean ${s.gameLength.mean.toFixed(1)}`);
  console.log(
    '\n' +
      table(
        ['faction', 'winRate'],
        FACTION_IDS.map((f) => [
          f + (s.beelinerFactions.includes(f) ? ' (BEE)' : '') + (s.byzGuard && f === 'byzantium' ? ' (GUARD)' : ''),
          pct(s.winRateByFaction[f]),
        ]),
      ),
  );
}

const elapsedMs = Math.round(performance.now() - t0);

// ---- verdict vs the hunt-brief thresholds (solo/duo scenarios only; the
//      guard_* and *_noTreason scenarios are decomposition counterfactuals)
const briefScenarios = all.filter((s) => !s.byzGuard && !s.noTreason);
const breaches: string[] = [];
for (const s of briefScenarios) {
  if (s.beelinerFactions.length === 1 && s.suddenDeath.byBeelinerRate > 0.2) {
    breaches.push(`${s.name}: SD by beeliner ${pct(s.suddenDeath.byBeelinerRate)} > 20%`);
  }
  if (s.sdBeforeRound9.rate > 0.1) {
    breaches.push(`${s.name}: SD completes <= r8 in ${pct(s.sdBeforeRound9.rate)} > 10%`);
  }
  if (s.byzEliminated.beforeRound8Rate > 0.15) {
    breaches.push(`${s.name}: byz dead before r8 ${pct(s.byzEliminated.beforeRound8Rate)} > 15%`);
  }
}

const results = {
  config: { games: N_GAMES, baseSeed: BASE_SEED, smoke: isSmoke(), elapsedMs },
  thresholds: {
    exploitIfSuddenDeathOneBeelinerOver: 0.2,
    exploitIfSdCompleteBeforeRound9Over: 0.1,
    exploitIfByzDeadBeforeRound8Over: 0.15,
  },
  verdict: {
    exploit: breaches.length > 0,
    breaches,
    decomposition:
      'POST-ERRATA decomposition (ratified errata round, 2026-07-11; see TUNING_LOG). TREASON-AT-THE-GATE now carries BOTH ' +
      'ratified E1 gates: playable only vs a garrison of <= 4 units, AND its 2-consecutive-siege-round clock counts only ' +
      'siege rounds in game round >= 6. The GREAT BOMBARD (E3) is now a per-game seeded omen draw uniform over rounds 11-16 ' +
      'with a 1-siege-round emplacement before it fires. Consequences vs the pre-errata grid (was SD 18.8-23.8% one beeliner, ' +
      '<=r8 11-17%): all brief bars now PASS — solo_ottoman 16.2%/8.3%, solo_genoa 13.2%/5.9%, solo_venice 6.2%/0.6%, ' +
      'duo 17.7%/8.2% vs the <=20%/<=10% bars. Treason still supplies most SD wins in undefended-Byzantium arms (the 4-unit ' +
      'start garrison satisfies the <=4 gate when Byzantium never reinforces), but the r6 clock gate pushes captures to r7+ ' +
      'and the guard counterfactual collapses to 7.3%/0.0% (was 23.8%/16.6%) — a garrison kept above 4 units turns the card ' +
      'off entirely (guard_genoa 0.0%). The noTreason counterfactual arms are no longer 0.0% (2.8-7.0%): that residue is the ' +
      'E3 Bombard draw landing r11-13 and opening the walls legitimately — the same late-game Bombard SD the fullgame T4 band ' +
      '(measured 11.9-13.7%, all completions r12+) prices in. The four pre-errata engine fixes (RAW blockade contest, harbor ' +
      'reinforcement, besieged-garrison insolvency exemption, omen unit-loss floor 3) remain in force.',
  },
  scenarios: all,
};
const outPath = writeResults('adversarial_cple_beeline', results);
console.log(`\nResults written to ${outPath} (${elapsedMs} ms)`);
