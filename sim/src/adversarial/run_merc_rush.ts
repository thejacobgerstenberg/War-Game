/**
 * ADVERSARIAL runner: merc-rush exploit hunt (see merc_rush.ts).
 *
 * Design: 5-player games. One designated seat runs the adversarial policy,
 * the other four factions each run one of the four standard policies
 * (rusher/trader/turtler/opportunist), shuffled per game with the same
 * fork(97) scheme fullgame.ts uses. The adversarial seat is rotated through
 * all five factions; N games per faction per variant.
 *
 * Variants sharing identical per-game seeds (paired comparison):
 *   cycle   — all-in mercs, treasury deliberately emptied so unpaid mercs
 *             desert (merc-cycling abuse)
 *   honest  — same strategy but reserves next round's merc wage bill
 *   control — the shipping 'rusher' policy in the same seat (baseline: how
 *             much of any edge is merc abuse vs plain aggression)
 *
 * Exploit thresholds (from the hunt brief):
 *   - merc-rush wins > 40% as any single faction, or
 *   - beats the field average by > 2x (p > 2*(1-p)/4  =>  p > 33.3%), or
 *   - cycling clearly dominates honest upkeep.
 *
 * Run:  npx tsx src/adversarial/run_merc_rush.ts        (from sim/)
 * Env:  GAMES=<n per faction per variant> (default 500; SMOKE=1 => 40)
 * Base seed 111001; game seed = 111001 + factionIdx*100000 + i (identical
 * across variants). Writes sim/results/adversarial_merc_rush.json.
 */

import { FACTION_IDS, type FactionId } from '../types';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName, type VictoryType } from '../game';
import { makeAgent } from '../agents';
import { isSmoke, pct, table, writeResults } from '../util';
import { makeMercRushAgent } from './merc_rush';

const BASE_SEED = 111001;
const envGames = process.env.GAMES ? Number.parseInt(process.env.GAMES, 10) : undefined;
const N_PER_FACTION = envGames ?? (isSmoke() ? 40 : 500);

type Variant = 'cycle' | 'honest' | 'control';
const VARIANTS: Variant[] = ['cycle', 'honest', 'control'];

function advAgent(v: Variant): Agent {
  if (v === 'control') return makeAgent('rusher');
  return makeMercRushAgent(v);
}

interface SeatStats {
  games: number;
  wins: number;
  winTypes: Record<VictoryType, number>;
  suddenDeathWins: number;
  eliminated: number;
  elimRoundSum: number;
  roundsSum: number;
  prestigeSum: number; // adversarial seat's final prestige
}

function newStats(): SeatStats {
  return {
    games: 0,
    wins: 0,
    winTypes: { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 },
    suddenDeathWins: 0,
    eliminated: 0,
    elimRoundSum: 0,
    roundsSum: 0,
    prestigeSum: 0,
  };
}

const t0 = performance.now();

// stats[variant][faction]
const stats: Record<Variant, Record<FactionId, SeatStats>> = Object.fromEntries(
  VARIANTS.map((v) => [v, Object.fromEntries(FACTION_IDS.map((f) => [f, newStats()]))]),
) as Record<Variant, Record<FactionId, SeatStats>>;

// win flag per (variant, faction, i) for the paired cycle-vs-honest analysis
const winFlag: Record<Variant, Record<FactionId, boolean[]>> = Object.fromEntries(
  VARIANTS.map((v) => [v, Object.fromEntries(FACTION_IDS.map((f) => [f, [] as boolean[]]))]),
) as Record<Variant, Record<FactionId, boolean[]>>;

// opponent-policy wins when facing the cycle variant (who beats merc-rush?)
const oppPolicyWinsVsCycle: Record<PolicyName, number> = { rusher: 0, trader: 0, turtler: 0, opportunist: 0 };

for (const variant of VARIANTS) {
  FACTION_IDS.forEach((mercFaction, fi) => {
    for (let i = 0; i < N_PER_FACTION; i++) {
      const seed = BASE_SEED + fi * 100_000 + i;
      const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
      // the four standard policies, shuffled deterministically, fill the
      // other four seats in FACTION_IDS order
      const pool: PolicyName[] = [...POLICY_NAMES];
      create(seed).fork(97).shuffle(pool);
      const agents = {} as Record<FactionId, Agent>;
      const policyOf = {} as Record<FactionId, PolicyName | 'ADV'>;
      let j = 0;
      for (const f of FACTION_IDS) {
        if (f === mercFaction) {
          agents[f] = advAgent(variant);
          policyOf[f] = 'ADV';
        } else {
          agents[f] = makeAgent(pool[j]);
          policyOf[f] = pool[j];
          j++;
        }
      }

      const res = new Game(seed, agents, seatOrder).run();

      const s = stats[variant][mercFaction];
      s.games++;
      s.roundsSum += res.rounds;
      s.prestigeSum += res.finalPrestige[mercFaction];
      const won = res.winner === mercFaction;
      winFlag[variant][mercFaction].push(won);
      if (won) {
        s.wins++;
        s.winTypes[res.victoryType]++;
        if (res.victoryType === 'suddenDeath') s.suddenDeathWins++;
      } else if (variant === 'cycle') {
        oppPolicyWinsVsCycle[policyOf[res.winner] as PolicyName]++;
      }
      if (res.eliminated[mercFaction] !== undefined) {
        s.eliminated++;
        s.elimRoundSum += res.eliminated[mercFaction]!;
      }
    }
  });
}

const elapsedMs = performance.now() - t0;

// ------------------------------------------------------------------ analysis

const rate = (s: SeatStats) => (s.games > 0 ? s.wins / s.games : 0);

function overall(v: Variant): { games: number; wins: number; rate: number } {
  let g = 0;
  let w = 0;
  for (const f of FACTION_IDS) {
    g += stats[v][f].games;
    w += stats[v][f].wins;
  }
  return { games: g, wins: w, rate: g > 0 ? w / g : 0 };
}

// paired cycle vs honest (identical seeds/opponents)
let cycleOnly = 0;
let honestOnly = 0;
let bothWin = 0;
let neitherWin = 0;
for (const f of FACTION_IDS) {
  for (let i = 0; i < N_PER_FACTION; i++) {
    const c = winFlag.cycle[f][i];
    const h = winFlag.honest[f][i];
    if (c && h) bothWin++;
    else if (c) cycleOnly++;
    else if (h) honestOnly++;
    else neitherWin++;
  }
}

const perFaction = (v: Variant) =>
  Object.fromEntries(
    FACTION_IDS.map((f) => {
      const s = stats[v][f];
      const p = rate(s);
      const fieldAvg = (1 - p) / 4; // average win rate of the other 4 seats
      return [
        f,
        {
          games: s.games,
          wins: s.wins,
          rate: p,
          fieldAvgOtherSeats: fieldAvg,
          ratioVsField: fieldAvg > 0 ? p / fieldAvg : null,
          winTypes: s.winTypes,
          suddenDeathWinRate: s.suddenDeathWins / s.games,
          eliminatedRate: s.eliminated / s.games,
          avgElimRound: s.eliminated > 0 ? s.elimRoundSum / s.eliminated : null,
          avgRounds: s.roundsSum / s.games,
          avgFinalPrestige: s.prestigeSum / s.games,
        },
      ];
    }),
  );

const exploitFlags: string[] = [];
for (const v of ['cycle', 'honest'] as Variant[]) {
  for (const f of FACTION_IDS) {
    const p = rate(stats[v][f]);
    if (p > 0.4) exploitFlags.push(`merc-rush(${v}) as ${f}: ${pct(p)} > 40%`);
    else if (p > 1 / 3) exploitFlags.push(`merc-rush(${v}) as ${f}: ${pct(p)} beats field avg by >2x`);
  }
}

const results = {
  config: {
    baseSeed: BASE_SEED,
    gamesPerFactionPerVariant: N_PER_FACTION,
    variants: VARIANTS,
    smoke: isSmoke(),
    elapsedMs: Math.round(elapsedMs),
    seedScheme: 'seed = 111001 + factionIdx*100000 + i, identical across variants (paired)',
    opponents: 'other four factions run rusher/trader/turtler/opportunist (one each, seeded shuffle fork(97))',
  },
  overall: Object.fromEntries(VARIANTS.map((v) => [v, overall(v)])),
  byVariantFaction: Object.fromEntries(VARIANTS.map((v) => [v, perFaction(v)])),
  pairedCycleVsHonest: {
    n: N_PER_FACTION * FACTION_IDS.length,
    cycleWinsHonestLoses: cycleOnly,
    honestWinsCycleLoses: honestOnly,
    bothWin,
    neitherWin,
  },
  opponentPolicyWinsVsCycle: oppPolicyWinsVsCycle,
  exploitThresholds: {
    singleFactionAbove40pct: 'flagged below if any',
    beatsFieldAvgBy2x: 'p > 2*(1-p)/4 i.e. p > 33.33%',
  },
  exploitFlags,
};

const outPath = writeResults('adversarial_merc_rush', results);

// ------------------------------------------------------------------- report

console.log(
  `merc-rush exploit hunt — ${N_PER_FACTION} games/faction/variant (${VARIANTS.length * FACTION_IDS.length * N_PER_FACTION} total), ` +
    `base seed ${BASE_SEED}, ${(elapsedMs / 1000).toFixed(1)}s`,
);

for (const v of VARIANTS) {
  console.log(`\n[${v}] adversarial-seat win rate by faction:`);
  console.log(
    table(
      ['faction', 'wins', 'games', 'rate', 'field-avg', 'ratio', 'SD-wins', 'elim%', 'avgPrestige'],
      FACTION_IDS.map((f) => {
        const s = stats[v][f];
        const p = rate(s);
        const fa = (1 - p) / 4;
        return [
          f,
          s.wins,
          s.games,
          pct(p),
          pct(fa),
          (p / fa).toFixed(2),
          s.suddenDeathWins,
          pct(s.eliminated / s.games, 0),
          (s.prestigeSum / s.games).toFixed(1),
        ];
      }),
    ),
  );
  const o = overall(v);
  console.log(`  overall: ${o.wins}/${o.games} = ${pct(o.rate)}`);
}

console.log('\nPaired cycle vs honest (same seeds):');
console.log(`  cycle-only wins ${cycleOnly}, honest-only wins ${honestOnly}, both ${bothWin}, neither ${neitherWin}`);

console.log('\nOpponent policy wins in games vs cycle variant:');
console.log(
  table(
    ['policy', 'wins'],
    (Object.keys(oppPolicyWinsVsCycle) as PolicyName[]).map((p) => [p, oppPolicyWinsVsCycle[p]]),
  ),
);

if (exploitFlags.length > 0) {
  console.log('\nEXPLOIT FLAGS:');
  for (const s of exploitFlags) console.log(`  ! ${s}`);
} else {
  console.log('\nNo exploit thresholds crossed.');
}

console.log(`\nResults written to ${outPath}`);
