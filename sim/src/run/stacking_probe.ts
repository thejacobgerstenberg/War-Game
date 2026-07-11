/**
 * §6.4 / §7.5 stacking-and-rout VERIFICATION probe.
 *
 * Since the stacking round (2026-07-11) the sim ENFORCES canon §6.4 RAW —
 * 8 land units per player per province, 12 in a CITY/capital (proxy:
 * authored walls or a faction capital; engine-matched reading, camps
 * co-located per (owner, province)) — at every entry point (recruit, move,
 * attack-stack assembly, siege reinforcement) and §7.5 rout/withdrawal
 * retreat pathing with headroom-clamped admission and OVERFLOW SURRENDER
 * (game.ts retreatCapped). This probe verifies the invariants hold over
 * committed full games and measures how often the §7.5 surrender rule
 * actually binds:
 *
 *  - attack stacks at battle commit vs the destination's cap  (expect 0 over)
 *  - player-owned garrisons, per battle phase                 (expect 0 over)
 *  - siege camps vs the invested province's cap               (expect 0 over)
 *  - retreat merges: admitted vs surrendered land units (live §7.5 rule)
 *
 * It wraps two Game internals (`resolveBattles` to sample state at commit
 * time, `retreatCapped` to observe every §7.5 retreat) without consuming
 * RNG, so trajectories are bit-identical to an uninstrumented run.
 *
 * Run: npx tsx src/run/stacking_probe.ts   (env GAMES=<n> SEED=<n>)
 * Defaults: 1000 games, seed 24681357 — the first 1000 games of the
 * committed results/fullgame.json population. Writes
 * results/stacking_probe.json.
 */

import { FACTION_IDS, type Army, type FactionId } from '../types';
import { create } from '../rng';
import { Game, POLICY_NAMES, landUnits, stackCapOf, type Agent, type PolicyName } from '../game';
import { makeAgent } from '../agents';
import { fmt, isSmoke, pct, table, writeResults } from '../util';

const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};
const BASE_SEED = envInt('SEED') ?? 24_681_357;
const N_GAMES = envInt('GAMES') ?? (isSmoke() ? 40 : 1000);

// ------------------------------------------------------------------ counters

/** Attack armies at battle commit (the phase's pendingAttacks queue). */
const attacks = { n: 0, over8: 0, overDestCap: 0, maxSize: 0, sizeSum: 0 };
/** All owned garrisons sampled once per battle phase (occupancy). */
const occupancy = { n: 0, overCap: 0 };
/** Siege camps (besieger stacks co-located on the invested province). */
const camps = { n: 0, overCap: 0, atCap: 0 };
/** Every §7.5 retreat (rout, withdrawal, siege lift): admission vs surrender. */
const retreats = { n: 0, retreatingUnits: 0, admitted: 0, surrendered: 0, withSurrender: 0, fullSurrenders: 0 };

let phases = 0;
let violations = 0;
let gamesWithSurrender = 0;

// -------------------------------------------------------------- game loop

const t0 = performance.now();
for (let i = 0; i < N_GAMES; i++) {
  const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
  const agents = {} as Record<FactionId, Agent>;
  const pool: PolicyName[] = [...POLICY_NAMES, POLICY_NAMES[i % POLICY_NAMES.length]];
  create(BASE_SEED + i).fork(97).shuffle(pool);
  FACTION_IDS.forEach((f, j) => {
    agents[f] = makeAgent(pool[j]);
  });

  const game = new Game(BASE_SEED + i, agents, seatOrder);
  let surrenderedThisGame = false;

  // Instrumentation: wrap two internals on THIS instance. Own properties
  // shadow the prototype methods at every `this.` call site; the wrappers
  // only read state / results before delegating, so mechanics and RNG are
  // untouched.
  const g = game as unknown as {
    resolveBattles(): void;
    retreatCapped(f: FactionId, origin: string | null, army: Army, battlefield: string): { admitted: number; surrendered: number };
    pendingAttacks: Array<{ faction: FactionId; from: string; to: string; army: Army }>;
  };

  const origResolveBattles = g.resolveBattles.bind(game);
  g.resolveBattles = () => {
    phases++;
    // 1. Committed attack stacks vs the destination's canon cap.
    for (const pa of g.pendingAttacks) {
      const size = landUnits(pa.army);
      if (size === 0) continue;
      attacks.n++;
      attacks.sizeSum += size;
      if (size > attacks.maxSize) attacks.maxSize = size;
      if (size > 8) attacks.over8++;
      if (size > stackCapOf(pa.to)) {
        attacks.overDestCap++;
        violations++;
      }
    }
    // 2. Occupancy: every owned garrison, once per battle phase.
    for (const [pid, p] of game.provinces) {
      if (p.owner === null) continue;
      const size = landUnits(p.garrison);
      if (size === 0) continue;
      occupancy.n++;
      if (size > stackCapOf(pid)) {
        occupancy.overCap++;
        violations++;
      }
    }
    // 3. Siege camps: the besieger stack co-locates on the invested province.
    for (const [pid, s] of game.sieges) {
      const size = landUnits(s.army);
      if (size === 0) continue;
      camps.n++;
      if (size > stackCapOf(pid)) {
        camps.overCap++;
        violations++;
      } else if (size === stackCapOf(pid)) camps.atCap++;
    }
    origResolveBattles();
  };

  const origRetreatCapped = g.retreatCapped.bind(game);
  g.retreatCapped = (f: FactionId, origin: string | null, army: Army, battlefield: string) => {
    const retreating = landUnits(army);
    const out = origRetreatCapped(f, origin, army, battlefield);
    if (retreating > 0) {
      retreats.n++;
      retreats.retreatingUnits += retreating;
      retreats.admitted += out.admitted;
      retreats.surrendered += out.surrendered;
      if (out.surrendered > 0) {
        retreats.withSurrender++;
        surrenderedThisGame = true;
      }
      if (out.admitted === 0 && out.surrendered > 0) retreats.fullSurrenders++;
    }
    return out;
  };

  game.run();
  if (surrenderedThisGame) gamesWithSurrender++;
}
const elapsedMs = performance.now() - t0;

// ----------------------------------------------------------------- results

const share = (x: number, n: number) => (n > 0 ? x / n : 0);

const results = {
  config: {
    games: N_GAMES,
    baseSeed: BASE_SEED,
    smoke: isSmoke(),
    landCap: 8,
    cityCap: 12,
    cityProxy: 'authored wallTier >= 1 or faction capital (engine isCityProvince)',
    mode: 'verification (caps ENFORCED since the stacking round, 2026-07-11)',
    elapsedMs: Math.round(elapsedMs),
  },
  battlePhasesSampled: phases,
  capViolations: violations,
  attackStacks: {
    total: attacks.n,
    meanSize: share(attacks.sizeSum, attacks.n),
    maxSize: attacks.maxSize,
    over8: attacks.over8,
    over8Share: share(attacks.over8, attacks.n),
    overDestCap: attacks.overDestCap,
  },
  garrisonOccupancy: {
    samples: occupancy.n,
    overCap: occupancy.overCap,
  },
  siegeCamps: {
    samples: camps.n,
    overCap: camps.overCap,
    atCap: camps.atCap,
    atCapShare: share(camps.atCap, camps.n),
  },
  retreats: {
    total: retreats.n,
    retreatingUnits: retreats.retreatingUnits,
    admittedUnits: retreats.admitted,
    surrenderedUnits: retreats.surrendered,
    surrenderedUnitShare: share(retreats.surrendered, retreats.retreatingUnits),
    retreatsWithSurrender: retreats.withSurrender,
    retreatsWithSurrenderShare: share(retreats.withSurrender, retreats.n),
    fullSurrenders: retreats.fullSurrenders,
  },
  gamesWithSurrender,
  gamesWithSurrenderShare: share(gamesWithSurrender, N_GAMES),
};

const outPath = writeResults('stacking_probe', results);

// ------------------------------------------------------------------ report

console.log(
  `IMPERIUM §6.4/§7.5 stacking VERIFICATION probe — ${N_GAMES} games${isSmoke() ? ' (SMOKE)' : ''}, ` +
    `base seed ${BASE_SEED}, ${(elapsedMs / 1000).toFixed(1)}s`,
);
console.log(`Caps enforced: 8 land units, 12 in walled/capital provinces. ${phases} battle phases sampled.\n`);

console.log(
  table(
    ['population', 'samples', 'over cap'],
    [
      ['attack stacks (vs dest cap)', attacks.n, attacks.overDestCap],
      ['owned garrisons (per phase)', occupancy.n, occupancy.overCap],
      ['siege camps (per phase)', camps.n, camps.overCap],
    ],
  ),
);

console.log(
  `\nAttack stacks: mean ${fmt(share(attacks.sizeSum, attacks.n), 2)} land units, max ${attacks.maxSize}; ` +
    `${pct(share(attacks.over8, attacks.n), 2)} above 8 (legal only into CITY/capital, cap 12).`,
);
console.log(
  `Siege camps at their cap: ${camps.atCap}/${camps.n} (${pct(share(camps.atCap, camps.n), 1)}).`,
);
console.log(
  `§7.5 retreats: ${retreats.n} (${retreats.retreatingUnits} land units) — admitted ${retreats.admitted}, ` +
    `SURRENDERED ${retreats.surrendered} (${pct(share(retreats.surrendered, retreats.retreatingUnits), 2)}); ` +
    `${retreats.withSurrender} retreats clipped (${retreats.fullSurrenders} full surrenders).`,
);
console.log(
  `Games with any §7.5 surrender: ${gamesWithSurrender}/${N_GAMES} (${pct(share(gamesWithSurrender, N_GAMES), 1)}).`,
);
console.log(violations === 0 ? '\nINVARIANT HOLDS: 0 over-cap stacks anywhere.' : `\n!! ${violations} CAP VIOLATIONS — §6.4 enforcement is leaking.`);
console.log(`\nResults written to ${outPath}`);
