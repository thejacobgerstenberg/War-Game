/**
 * Per-unique-unit ECONOMY A/B (engine reconciliation, 2026-07-11).
 *
 * The engine (feature/engine-core balance.ts) models the 10 faction unique
 * units as COMBAT-STAT deltas over their base UnitType only
 * (UNIQUE_UNIT_OVERRIDES: atkMod/defMod/ability tags) — every unit is bought
 * and fed at its BASE UnitType cost/upkeep. The sim additionally carries
 * per-unique ECONOMY deltas (FACTION_UNIT_OVERRIDES cost/upkeep fields). The
 * engine asks whether that per-unique economy is worth new engine structure.
 *
 * Arm A — current sim: per-unique costs/upkeep active (Varangian 6g,
 *         Janissary 5g + 1 gold-pay + 0 grain, Black Army likewise,
 *         Galeazza timber −1, Hungarian levy 1g, Genoa merc 6g
 *         (×1.5 surcharge waived), devshirme levies 0 grain).
 * Arm B — engine shape: BASE costs/upkeep for every faction's units; all
 *         combat CVs (and every other CONFIG value) unchanged.
 *         NOTE: genoa professional stays 3g in BOTH arms — its base unit in
 *         the engine roster is ARCHER (base cost 3g), so 3g IS the base cost,
 *         not a per-unique economy delta.
 *
 * 2,000 games/arm (GAMES env overrides), IDENTICAL seeds per game index in
 * both arms (game i seeds from BASE_SEED + i with the same seat rotation and
 * policy shuffle), so the delta is paired. Binomial s.e. per arm at 2,000
 * games ≈ sqrt(0.2×0.8/2000) ≈ 0.9pp; treat ~1.1pp (and pairwise ~1.3pp on
 * the delta, conservatively unpaired) as the noise floor.
 *
 * Writes sim/results/unique_economy_ab.json.
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

/** Snapshot of the per-unique economy fields arm B strips. */
const fu = CONFIG.factionUnits;
const ARM_A_SNAPSHOT = JSON.parse(JSON.stringify(fu)) as typeof fu;

/**
 * Arm B: engine shape — base costs/upkeep everywhere, combat CVs untouched.
 * Explicit per-field strip (kept in sync with rules.ts FACTION_UNIT_OVERRIDES).
 */
function applyEngineShape(): void {
  fu.byzantium.professional.goldCost = CONFIG.units.professional.goldCost; // Varangian 6g -> 4g
  fu.ottomans.levy.grainUpkeep = CONFIG.units.levy.grainUpkeep; // devshirme 0 -> 1 grain
  fu.ottomans.professional.goldCost = CONFIG.units.professional.goldCost; // Janissary 5g -> 4g
  fu.ottomans.professional.grainUpkeep = CONFIG.units.professional.grainUpkeep; // 0 -> 1 grain
  fu.ottomans.professional.goldUpkeep = CONFIG.units.professional.goldUpkeep; // 1 -> 0 gold (donative pay off)
  fu.venice.galley.timberCost = CONFIG.units.galley.timberCost; // Galeazza 1 -> 2 timber
  fu.genoa.mercenary.goldCost = CONFIG.units.mercenary.goldCost; // surcharge waiver off: 6g -> 9g
  // genoa.professional.goldCost 3 KEPT: base ARCHER cost in the engine roster.
  fu.hungary.levy.goldCost = CONFIG.units.levy.goldCost; // strongest levies 1g -> 2g
  fu.hungary.professional.goldCost = CONFIG.units.professional.goldCost; // Black Army 5g -> 4g
  fu.hungary.professional.grainUpkeep = CONFIG.units.professional.grainUpkeep; // 0 -> 1 grain
  fu.hungary.professional.goldUpkeep = CONFIG.units.professional.goldUpkeep; // 1 -> 0 gold
}

function restoreArmA(): void {
  for (const f of FACTION_IDS) {
    for (const t of Object.keys(fu[f]) as Array<keyof (typeof fu)[FactionId]>) {
      Object.assign(fu[f][t], ARM_A_SNAPSHOT[f][t]);
    }
  }
}

// ---------------------------------------------------------------- game loop

interface ArmResult {
  wins: Record<FactionId, number>;
  winRate: Record<FactionId, number>;
  byPolicyWins: Record<PolicyName, number>;
  medianEndRound: number;
  meanEndRound: number;
  suddenDeathRate: number;
}

function runArm(): ArmResult {
  const wins = Object.fromEntries(FACTION_IDS.map((f) => [f, 0])) as Record<FactionId, number>;
  const byPolicyWins = Object.fromEntries(POLICY_NAMES.map((p) => [p, 0])) as Record<PolicyName, number>;
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
    lengths.push(res.rounds);
    roundsSum += res.rounds;
    if (res.victoryType === 'suddenDeath') sd++;
  }
  lengths.sort((a, b) => a - b);
  return {
    wins,
    winRate: Object.fromEntries(FACTION_IDS.map((f) => [f, wins[f] / N_GAMES])) as Record<FactionId, number>,
    byPolicyWins,
    medianEndRound: lengths[Math.floor(lengths.length / 2)],
    meanEndRound: roundsSum / N_GAMES,
    suddenDeathRate: sd / N_GAMES,
  };
}

// --------------------------------------------------------------------- main

const t0 = performance.now();
console.log(`PER-UNIQUE ECONOMY A/B — ${N_GAMES} games/arm, base seed ${BASE_SEED}${isSmoke() ? ' (SMOKE)' : ''}`);

console.log('\nArm A: per-unique economy (current sim CONFIG)...');
const armA = runArm();
console.log('Arm B: engine shape (base costs/upkeep, CVs unchanged)...');
applyEngineShape();
const armB = runArm();
restoreArmA();

const se = (p: number) => Math.sqrt((p * (1 - p)) / N_GAMES);
const deltas = Object.fromEntries(
  FACTION_IDS.map((f) => [f, armB.winRate[f] - armA.winRate[f]]),
) as Record<FactionId, number>;
const noiseFloorPp = Math.max(...FACTION_IDS.map((f) => se(armA.winRate[f]))) * 100;

console.log('\nWin rate by faction (A = per-unique economy, B = engine shape):');
console.log(
  table(
    ['faction', 'armA', 'armB', 'delta B-A (pp)', 'se/arm (pp)'],
    FACTION_IDS.map((f) => [
      f,
      pct(armA.winRate[f]),
      pct(armB.winRate[f]),
      (deltas[f] * 100).toFixed(1),
      (se(armA.winRate[f]) * 100).toFixed(1),
    ]),
  ),
);
console.log(`\npacing: median end A ${armA.medianEndRound} / B ${armB.medianEndRound}; SD A ${pct(armA.suddenDeathRate)} / B ${pct(armB.suddenDeathRate)}`);

const results = {
  config: {
    gamesPerArm: N_GAMES,
    baseSeed: BASE_SEED,
    smoke: isSmoke(),
    pairedSeeds: true,
    armA: 'per-unique economy deltas active (sim FACTION_UNIT_OVERRIDES cost/upkeep fields)',
    armB: 'engine shape: base costs/upkeep for every faction unit; combat CVs unchanged; genoa professional stays 3g (base ARCHER cost)',
    strippedInArmB: [
      'byzantium professional (Varangian) 6g -> 4g',
      'ottomans levy (devshirme) grain 0 -> 1',
      'ottomans professional (Janissary) 5g -> 4g, upkeep 1 gold/0 grain -> 0 gold/1 grain',
      'venice galley (Galeazza) timber 1 -> 2',
      'genoa mercenary (broker waiver) 6g -> 9g',
      'hungary levy (strongest levies) 1g -> 2g',
      'hungary professional (Black Army) 5g -> 4g, upkeep 1 gold/0 grain -> 0 gold/1 grain',
    ],
  },
  armA,
  armB,
  deltaPp: Object.fromEntries(FACTION_IDS.map((f) => [f, +(deltas[f] * 100).toFixed(2)])),
  sePerArmPp: Object.fromEntries(FACTION_IDS.map((f) => [f, +(se(armA.winRate[f]) * 100).toFixed(2)])),
  noiseFloorPp: +noiseFloorPp.toFixed(2),
  elapsedMs: Math.round(performance.now() - t0),
};

const outPath = writeResults('unique_economy_ab', results);
console.log(`\nResults written to ${outPath}`);
