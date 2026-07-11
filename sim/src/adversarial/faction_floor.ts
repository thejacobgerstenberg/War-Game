/**
 * ADVERSARIAL harness "faction-floor" (exploit hunter, not a shipping module).
 *
 * Stress-tests per-faction floors and ceilings against the tuned CONFIG:
 *
 *  - GRID: every (focal faction, focal policy) pair is run against four
 *    field compositions for the other 4 factions:
 *      mixed        : the other four factions get one each of the four
 *                     shipping policies (seeded per-game shuffle) — the
 *                     "neutral field" for BEST-configuration / auto-pick
 *                     checks;
 *      allRusher    : four rushers (e.g. Byzantium turtler vs 4 rushers);
 *      allTrader    : four traders (e.g. Hungary trader mirror-ish field);
 *      allOpportunist: four opportunists (e.g. Genoa vs 4 opportunists).
 *    This covers every named "plausible worst configuration" and every
 *    "faction + most synergistic policy vs a neutral field" ceiling case.
 *
 *  - EXTREME fields: all five seats play the SAME policy (rusher / trader /
 *    turtler / opportunist). Checks that a monoculture table still ends:
 *    median length, victory-type split, and the share of games decided only
 *    by the round-16 cap tiebreak with a prestige margin < 2.
 *
 * Exploit criteria (from the hunt brief):
 *  - floor : any faction < 5% win rate in a plausible configuration;
 *  - ceiling: any faction+policy pair > 55% vs the neutral (mixed) field;
 *  - ending: any extreme field with median length < 9 or > 40% of games
 *    decided by cap tiebreak with winner margin < 2.
 *
 * Uses only the public engine API (Game, makeAgent); no shared file touched.
 */

import { FACTION_IDS, type FactionId } from '../types';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName, type VictoryType } from '../game';
import { makeAgent } from '../agents';

export type FieldKind = 'mixed' | 'allRusher' | 'allTrader' | 'allTurtler' | 'allOpportunist';

const FIELD_POLICY: Record<Exclude<FieldKind, 'mixed'>, PolicyName> = {
  allRusher: 'rusher',
  allTrader: 'trader',
  allTurtler: 'turtler',
  allOpportunist: 'opportunist',
};

export interface ConfigResult {
  focalFaction: FactionId;
  focalPolicy: PolicyName;
  field: FieldKind;
  games: number;
  /** first per-game seed used (seeds are drawn sequentially from a fork). */
  firstSeed: number;
  focalWins: number;
  focalWinRate: number;
  focalEliminated: number;
  focalElimRate: number;
  victoryTypes: Record<VictoryType, number>;
  medianRounds: number;
  meanRounds: number;
  /** games ending at the round cap where the winner's margin over the best
   *  surviving rival was < 2 prestige (coin-flip cap tiebreaks). */
  capCloseMargin: number;
  capCloseMarginRate: number;
  /** focal wins split by how the focal faction won. */
  focalWinTypes: Record<VictoryType, number>;
}

export interface ExtremeResult {
  policy: PolicyName;
  games: number;
  firstSeed: number;
  medianRounds: number;
  meanRounds: number;
  earlyEndRate: number; // ended before round 11
  victoryTypes: Record<VictoryType, number>;
  victoryRates: Record<VictoryType, number>;
  capCloseMargin: number;
  capCloseMarginRate: number;
  winsByFaction: Record<FactionId, number>;
}

function emptyVictory(): Record<VictoryType, number> {
  return { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Winner's prestige margin over the best OTHER surviving faction. */
function capMargin(res: ReturnType<Game['run']>): number {
  let best = -Infinity;
  for (const f of FACTION_IDS) {
    if (f === res.winner) continue;
    if (res.eliminated[f] !== undefined) continue;
    if (res.finalPrestige[f] > best) best = res.finalPrestige[f];
  }
  return best === -Infinity ? Infinity : res.finalPrestige[res.winner] - best;
}

/**
 * Run one grid configuration: `focal` faction plays `focalPolicy`; the other
 * four factions are populated per `field`. Seat order rotates each game so
 * the focal faction sees every seat. Per-game seeds are drawn from
 * create(baseSeed).fork(cfgId).
 */
export function runConfig(
  focal: FactionId,
  focalPolicy: PolicyName,
  field: FieldKind,
  nGames: number,
  baseSeed: number,
  cfgId: number,
): ConfigResult {
  const seedRng = create(baseSeed).fork(cfgId);
  const others = FACTION_IDS.filter((f) => f !== focal);
  let firstSeed = 0;
  let focalWins = 0;
  let focalElim = 0;
  let capClose = 0;
  const vt = emptyVictory();
  const fwt = emptyVictory();
  const lengths: number[] = [];
  let roundsSum = 0;

  for (let i = 0; i < nGames; i++) {
    const gameSeed = (seedRng.next() * 0x7fffffff) | 0;
    if (i === 0) firstSeed = gameSeed;
    const agents = {} as Record<FactionId, Agent>;
    agents[focal] = makeAgent(focalPolicy);
    if (field === 'mixed') {
      const pool: PolicyName[] = [...POLICY_NAMES];
      create(gameSeed).fork(97).shuffle(pool);
      others.forEach((f, j) => (agents[f] = makeAgent(pool[j])));
    } else {
      for (const f of others) agents[f] = makeAgent(FIELD_POLICY[field]);
    }
    const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
    const res = new Game(gameSeed, agents, seatOrder).run();

    if (res.winner === focal) {
      focalWins++;
      fwt[res.victoryType]++;
    }
    if (res.eliminated[focal] !== undefined) focalElim++;
    vt[res.victoryType]++;
    lengths.push(res.rounds);
    roundsSum += res.rounds;
    if (res.victoryType === 'cap' && capMargin(res) < 2) capClose++;
  }

  return {
    focalFaction: focal,
    focalPolicy,
    field,
    games: nGames,
    firstSeed,
    focalWins,
    focalWinRate: focalWins / nGames,
    focalEliminated: focalElim,
    focalElimRate: focalElim / nGames,
    victoryTypes: vt,
    medianRounds: median(lengths),
    meanRounds: roundsSum / nGames,
    capCloseMargin: capClose,
    capCloseMarginRate: capClose / nGames,
    focalWinTypes: fwt,
  };
}

/** All five seats play the same policy (extreme monoculture field). */
export function runExtreme(
  policy: PolicyName,
  nGames: number,
  baseSeed: number,
  cfgId: number,
): ExtremeResult {
  const seedRng = create(baseSeed).fork(cfgId);
  let firstSeed = 0;
  let capClose = 0;
  let early = 0;
  const vt = emptyVictory();
  const wins = Object.fromEntries(FACTION_IDS.map((f) => [f, 0])) as Record<FactionId, number>;
  const lengths: number[] = [];
  let roundsSum = 0;

  for (let i = 0; i < nGames; i++) {
    const gameSeed = (seedRng.next() * 0x7fffffff) | 0;
    if (i === 0) firstSeed = gameSeed;
    const agents = {} as Record<FactionId, Agent>;
    for (const f of FACTION_IDS) agents[f] = makeAgent(policy);
    const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
    const res = new Game(gameSeed, agents, seatOrder).run();

    wins[res.winner]++;
    vt[res.victoryType]++;
    lengths.push(res.rounds);
    roundsSum += res.rounds;
    if (res.rounds < 11) early++;
    if (res.victoryType === 'cap' && capMargin(res) < 2) capClose++;
  }

  const rates = {} as Record<VictoryType, number>;
  for (const k of Object.keys(vt) as VictoryType[]) rates[k] = vt[k] / nGames;

  return {
    policy,
    games: nGames,
    firstSeed,
    medianRounds: median(lengths),
    meanRounds: roundsSum / nGames,
    earlyEndRate: early / nGames,
    victoryTypes: vt,
    victoryRates: rates,
    capCloseMargin: capClose,
    capCloseMarginRate: capClose / nGames,
    winsByFaction: wins,
  };
}
