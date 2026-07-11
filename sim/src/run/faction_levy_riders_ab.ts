/**
 * Faction-wide base-LEVY economy rider A/B (engine question, 2026-07-11).
 *
 * The engine team is considering a per-faction LEVY override lever and asks
 * whether the two faction-wide base-LEVY economy riders are load-bearing or
 * sub-noise at the current final config:
 *   - Ottoman devshirme:            base LEVY grain upkeep 0 (base is 1)
 *   - Hungarian "Strongest Levies": base LEVY gold cost   1 (base is 2)
 *
 * Four arms, everything else at the current final CONFIG (combat CVs, the
 * Hungarian levy CV 2/2, and all other unique-economy deltas UNCHANGED):
 *   A. baseline — both riders on (must reproduce committed fullgame stats
 *      within noise; identical protocol/seed to unique_economy_ab arm A)
 *   B. devshirme off  — Ottoman levies pay 1 grain upkeep
 *   C. cheap-levies off — Hungarian levies cost 2g
 *   D. both off
 *
 * 2,000 games/arm (GAMES env overrides), IDENTICAL seeds per game index in
 * every arm (game i seeds from BASE_SEED + i with the same seat rotation and
 * policy shuffle), so deltas are paired. Binomial s.e. per arm at 2,000 games
 * ≈ sqrt(0.2×0.8/2000) ≈ 0.9pp; treat ~1.0pp per arm (and conservatively
 * ~1.3pp unpaired on a delta) as the noise floor.
 *
 * Writes sim/results/faction_levy_riders_ab.json.
 */

import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName } from '../game';
import { makeAgent } from '../agents';
import { isSmoke, pct, table, writeResults } from '../util';

const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};
const BASE_SEED = envInt('SEED') ?? 14_530_000;
const N_GAMES = envInt('GAMES') ?? (isSmoke() ? 40 : 2000);

// ---------------------------------------------------------------- arm setup

const fu = CONFIG.factionUnits;
const DEVSHIRME_ON = fu.ottomans.levy.grainUpkeep; // 0 (rider on)
const CHEAP_LEVIES_ON = fu.hungary.levy.goldCost; // 1 (rider on)
const BASE_LEVY_GRAIN = CONFIG.units.levy.grainUpkeep; // 1
const BASE_LEVY_GOLD = CONFIG.units.levy.goldCost; // 2

interface ArmSpec {
  key: 'A' | 'B' | 'C' | 'D';
  label: string;
  devshirme: boolean; // Ottoman levy grain upkeep 0 rider active
  cheapLevies: boolean; // Hungarian levy 1g rider active
}
const ARMS: ArmSpec[] = [
  { key: 'A', label: 'baseline: both riders on (current final CONFIG)', devshirme: true, cheapLevies: true },
  { key: 'B', label: 'devshirme off: ottoman levy grain upkeep 0 -> 1', devshirme: false, cheapLevies: true },
  { key: 'C', label: 'cheap-levies off: hungarian levy gold 1 -> 2', devshirme: true, cheapLevies: false },
  { key: 'D', label: 'both riders off', devshirme: false, cheapLevies: false },
];

function applyArm(a: ArmSpec): void {
  fu.ottomans.levy.grainUpkeep = a.devshirme ? DEVSHIRME_ON : BASE_LEVY_GRAIN;
  fu.hungary.levy.goldCost = a.cheapLevies ? CHEAP_LEVIES_ON : BASE_LEVY_GOLD;
}

function restoreBaseline(): void {
  fu.ottomans.levy.grainUpkeep = DEVSHIRME_ON;
  fu.hungary.levy.goldCost = CHEAP_LEVIES_ON;
}

// ---------------------------------------------------------------- game loop

interface ArmResult {
  wins: Record<FactionId, number>;
  winRate: Record<FactionId, number>;
  byPolicyWins: Record<PolicyName, number>;
  /** wins[faction][policy] — each faction plays each policy in ~N/4 games. */
  byFactionPolicyWins: Record<FactionId, Record<PolicyName, number>>;
  suddenDeathWinsByFaction: Record<FactionId, number>;
  medianEndRound: number;
  meanEndRound: number;
  suddenDeathRate: number;
}

function runArm(): ArmResult {
  const wins = Object.fromEntries(FACTION_IDS.map((f) => [f, 0])) as Record<FactionId, number>;
  const byPolicyWins = Object.fromEntries(POLICY_NAMES.map((p) => [p, 0])) as Record<PolicyName, number>;
  const byFactionPolicyWins = Object.fromEntries(
    FACTION_IDS.map((f) => [f, Object.fromEntries(POLICY_NAMES.map((p) => [p, 0]))]),
  ) as Record<FactionId, Record<PolicyName, number>>;
  const sdWins = Object.fromEntries(FACTION_IDS.map((f) => [f, 0])) as Record<FactionId, number>;
  const lengths: number[] = [];
  let sd = 0;
  let roundsSum = 0;
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
    const res = new Game(BASE_SEED + i, agents, seatOrder).run();
    wins[res.winner]++;
    byPolicyWins[policyOf[res.winner]]++;
    byFactionPolicyWins[res.winner][policyOf[res.winner]]++;
    lengths.push(res.rounds);
    roundsSum += res.rounds;
    if (res.victoryType === 'suddenDeath') {
      sd++;
      sdWins[res.winner]++;
    }
  }
  lengths.sort((a, b) => a - b);
  return {
    wins,
    winRate: Object.fromEntries(FACTION_IDS.map((f) => [f, wins[f] / N_GAMES])) as Record<FactionId, number>,
    byPolicyWins,
    byFactionPolicyWins,
    suddenDeathWinsByFaction: sdWins,
    medianEndRound: lengths[Math.floor(lengths.length / 2)],
    meanEndRound: roundsSum / N_GAMES,
    suddenDeathRate: sd / N_GAMES,
  };
}

// --------------------------------------------------------------------- main

const t0 = performance.now();
console.log(
  `FACTION-LEVY RIDER A/B (devshirme, cheap levies) — ${N_GAMES} games/arm, base seed ${BASE_SEED}${isSmoke() ? ' (SMOKE)' : ''}`,
);

const results: Record<'A' | 'B' | 'C' | 'D', ArmResult> = {} as never;
for (const arm of ARMS) {
  console.log(`\nArm ${arm.key}: ${arm.label}...`);
  applyArm(arm);
  results[arm.key] = runArm();
}
restoreBaseline();

const se = (p: number) => Math.sqrt((p * (1 - p)) / N_GAMES);
const armA = results.A;
const deltaVsA = (arm: ArmResult) =>
  Object.fromEntries(
    FACTION_IDS.map((f) => [f, +((arm.winRate[f] - armA.winRate[f]) * 100).toFixed(2)]),
  ) as Record<FactionId, number>;

console.log('\nWin rate by faction (A=baseline, B=devshirme off, C=cheap-levies off, D=both off):');
console.log(
  table(
    ['faction', 'A', 'B', 'C', 'D', 'B-A pp', 'C-A pp', 'D-A pp', 'se/arm pp'],
    FACTION_IDS.map((f) => [
      f,
      pct(armA.winRate[f]),
      pct(results.B.winRate[f]),
      pct(results.C.winRate[f]),
      pct(results.D.winRate[f]),
      ((results.B.winRate[f] - armA.winRate[f]) * 100).toFixed(1),
      ((results.C.winRate[f] - armA.winRate[f]) * 100).toFixed(1),
      ((results.D.winRate[f] - armA.winRate[f]) * 100).toFixed(1),
      (se(armA.winRate[f]) * 100).toFixed(1),
    ]),
  ),
);
for (const k of ['A', 'B', 'C', 'D'] as const) {
  const r = results[k];
  console.log(
    `arm ${k}: SD ${pct(r.suddenDeathRate)} (ott SD wins ${r.suddenDeathWinsByFaction.ottomans}), median ${r.medianEndRound}, mean ${r.meanEndRound.toFixed(2)}, ` +
      `policies r/t/tu/o ${POLICY_NAMES.map((p) => r.byPolicyWins[p]).join('/')}, hungary-rusher wins ${r.byFactionPolicyWins.hungary.rusher}`,
  );
}

const out = {
  config: {
    gamesPerArm: N_GAMES,
    baseSeed: BASE_SEED,
    smoke: isSmoke(),
    pairedSeeds: true,
    protocol:
      'identical to unique_economy_ab (game i = seed BASE_SEED+i, rotated seats, fork(97) policy shuffle); arm A must reproduce unique_economy_ab arm A exactly and committed fullgame stats within noise',
    arms: Object.fromEntries(ARMS.map((a) => [a.key, a.label])),
    riders: {
      devshirme: `ottomans.levy.grainUpkeep ${DEVSHIRME_ON} (rider on) vs ${BASE_LEVY_GRAIN} (base)`,
      cheapLevies: `hungary.levy.goldCost ${CHEAP_LEVIES_ON} (rider on) vs ${BASE_LEVY_GOLD} (base)`,
    },
  },
  arms: results,
  deltaPpVsA: { B: deltaVsA(results.B), C: deltaVsA(results.C), D: deltaVsA(results.D) },
  sePerArmPp: Object.fromEntries(
    FACTION_IDS.map((f) => [f, +(se(armA.winRate[f]) * 100).toFixed(2)]),
  ),
  noiseFloorPp: +(Math.max(...FACTION_IDS.map((f) => se(armA.winRate[f]))) * 100).toFixed(2),
  elapsedMs: Math.round(performance.now() - t0),
};

const outPath = writeResults('faction_levy_riders_ab', out);
console.log(`\nResults written to ${outPath}`);
