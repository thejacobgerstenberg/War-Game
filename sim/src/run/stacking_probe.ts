/**
 * §6.4 / §7 stacking-rout exposure probe (read-only instrumentation).
 *
 * Canon §6.4 caps a province at 8 land units per player (12 in a CITY /
 * capital); the engine enforces (post-fix) that a ROUTED stack retreats only
 * up to the destination's remaining stacking headroom and the OVERFLOW
 * SURRENDERS (§7). The sim models neither: garrisons are uncapped and
 * post-battle survivors merge into the origin garrison unconditionally
 * (`returnHome`), while routed DEFENDER survivors disperse outright.
 *
 * This probe measures how much that divergence is EXERCISED in committed
 * full games, without changing any mechanics: it wraps two Game internals
 * (`resolveBattles` to sample stacks at battle commit time, `returnHome` to
 * observe every post-battle/siege retreat merge) and counts stacks that
 * exceed the canon cap. It consumes no RNG, so game trajectories are
 * bit-identical to an uninstrumented run at the same seeds.
 *
 * CITY/capital proxy: the sim map has no CITY terrain, so cap 12 is applied
 * to provinces with AUTHORED walls (wallTier >= 1) or a faction capital;
 * everything else caps at 8. Land units = levy + professional + mercenary +
 * siege engines. Sea-zone stacking (6 naval) is not probed: the sim keeps
 * galleys in port garrisons and has no at-sea stacks.
 *
 * Run: npx tsx src/run/stacking_probe.ts   (env GAMES=<n> SEED=<n>)
 * Defaults: 1000 games, seed 24681357 — the first 1000 games of the
 * committed results/fullgame.json population. Writes
 * results/stacking_probe.json.
 */

import { FACTION_IDS, type Army, type FactionId } from '../types';
import { create } from '../rng';
import { CAPITALS, Game, POLICY_NAMES, type Agent, type PolicyName } from '../game';
import { makeAgent } from '../agents';
import { PROVINCE_BY_ID } from '../map';
import { fmt, isSmoke, pct, table, writeResults } from '../util';

const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};
const BASE_SEED = envInt('SEED') ?? 24_681_357;
const N_GAMES = envInt('GAMES') ?? (isSmoke() ? 40 : 1000);

const CAPITAL_IDS = new Set<string>(Object.values(CAPITALS));
const landUnits = (a: Army): number => a.levy + a.professional + a.mercenary + a.siegeEngine;
/** Canon §6.4 cap under the sim's CITY/capital proxy (authored walls or capital). */
const capOf = (pid: string): number =>
  PROVINCE_BY_ID.get(pid)!.wallTier >= 1 || CAPITAL_IDS.has(pid) ? 12 : 8;

// ------------------------------------------------------------------ counters

/** Attack armies at battle commit (the phase's pendingAttacks queue). */
const attacks = { n: 0, over8: 0, overDestCap: 0, overflowUnits: 0, maxSize: 0, sizeSum: 0 };
/** Player-owned defending garrisons of attacked provinces (per phase, deduped). */
const defenders = { n: 0, overCap: 0 };
/** Every post-battle/siege-lift retreat merge into an owned origin (returnHome). */
const retreats = { n: 0, overCap: 0, overflowUnits: 0, returningUnits: 0 };
/** All owned garrisons sampled once per battle phase (occupancy). */
const occupancy = { n: 0, overCap: 0, over8: 0 };
/** Siege camps (besieger stacks investing a province) sampled per phase. */
const camps = { n: 0, overCap: 0 };

let phases = 0;
let gamesWithAnyExposure = 0;

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
  let exposed = false;

  // Instrumentation: wrap two internals on THIS instance. Own properties
  // shadow the prototype methods at every `this.` call site; the wrappers
  // only read state before delegating, so mechanics and RNG are untouched.
  const g = game as unknown as {
    resolveBattles(): void;
    returnHome(f: FactionId, origin: string, army: Army): void;
    pendingAttacks: Array<{ faction: FactionId; from: string; to: string; army: Army }>;
  };

  const origResolveBattles = g.resolveBattles.bind(game);
  g.resolveBattles = () => {
    phases++;
    // 1. Committed attack stacks vs the destination's canon cap.
    const attackedPids = new Set<string>();
    for (const pa of g.pendingAttacks) {
      const size = landUnits(pa.army);
      if (size === 0) continue;
      attacks.n++;
      attacks.sizeSum += size;
      if (size > attacks.maxSize) attacks.maxSize = size;
      if (size > 8) attacks.over8++;
      const cap = capOf(pa.to);
      if (size > cap) {
        attacks.overDestCap++;
        attacks.overflowUnits += size - cap;
        exposed = true;
      }
      attackedPids.add(pa.to);
    }
    // 2. Player-owned defending garrisons of attacked provinces.
    for (const pid of attackedPids) {
      const p = game.provinces.get(pid)!;
      if (p.owner === null) continue; // neutral minors: not a per-player stack
      const size = landUnits(p.garrison);
      if (size === 0) continue;
      defenders.n++;
      if (size > capOf(pid)) {
        defenders.overCap++;
        exposed = true;
      }
    }
    // 3. Occupancy: every owned garrison, once per battle phase.
    for (const [pid, p] of game.provinces) {
      if (p.owner === null) continue;
      const size = landUnits(p.garrison);
      if (size === 0) continue;
      occupancy.n++;
      if (size > 8) occupancy.over8++;
      if (size > capOf(pid)) {
        occupancy.overCap++;
        exposed = true;
      }
    }
    // 4. Siege camps: the besieger stack sits in the invested province.
    for (const [pid, s] of game.sieges) {
      const size = landUnits(s.army);
      if (size === 0) continue;
      camps.n++;
      if (size > capOf(pid)) {
        camps.overCap++;
        exposed = true;
      }
    }
    origResolveBattles();
  };

  const origReturnHome = g.returnHome.bind(game);
  g.returnHome = (f: FactionId, origin: string, army: Army) => {
    // Observe BEFORE the merge: this is exactly the engine-fix site — a
    // retreating stack entering an owned province. Canon (§6.4 + §7 per the
    // engine fix) admits only up to the cap's remaining headroom; the
    // overflow surrenders. The sim merges unconditionally.
    const p = game.provinces.get(origin);
    const ret = landUnits(army);
    if (p && p.owner === f && ret > 0) {
      retreats.n++;
      retreats.returningUnits += ret;
      const cap = capOf(origin);
      const overflow = Math.min(ret, Math.max(0, landUnits(p.garrison) + ret - cap));
      if (overflow > 0) {
        retreats.overCap++;
        retreats.overflowUnits += overflow;
        exposed = true;
      }
    }
    origReturnHome(f, origin, army);
  };

  game.run();
  if (exposed) gamesWithAnyExposure++;
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
    cityProxy: 'authored wallTier >= 1 or faction capital',
    elapsedMs: Math.round(elapsedMs),
  },
  battlePhasesSampled: phases,
  attackStacks: {
    total: attacks.n,
    meanSize: share(attacks.sizeSum, attacks.n),
    maxSize: attacks.maxSize,
    over8: attacks.over8,
    over8Share: share(attacks.over8, attacks.n),
    overDestCap: attacks.overDestCap,
    overDestCapShare: share(attacks.overDestCap, attacks.n),
    overflowUnits: attacks.overflowUnits,
  },
  defenderGarrisons: {
    total: defenders.n,
    overCap: defenders.overCap,
    overCapShare: share(defenders.overCap, defenders.n),
  },
  retreatMerges: {
    total: retreats.n,
    returningUnits: retreats.returningUnits,
    overCap: retreats.overCap,
    overCapShare: share(retreats.overCap, retreats.n),
    overflowUnits: retreats.overflowUnits,
    overflowUnitShare: share(retreats.overflowUnits, retreats.returningUnits),
  },
  garrisonOccupancy: {
    samples: occupancy.n,
    over8: occupancy.over8,
    over8Share: share(occupancy.over8, occupancy.n),
    overCap: occupancy.overCap,
    overCapShare: share(occupancy.overCap, occupancy.n),
  },
  siegeCamps: {
    samples: camps.n,
    overCap: camps.overCap,
    overCapShare: share(camps.overCap, camps.n),
  },
  gamesWithAnyExposure,
  gamesWithAnyExposureShare: share(gamesWithAnyExposure, N_GAMES),
};

const outPath = writeResults('stacking_probe', results);

// ------------------------------------------------------------------ report

console.log(
  `IMPERIUM §6.4/§7 stacking exposure probe — ${N_GAMES} games${isSmoke() ? ' (SMOKE)' : ''}, ` +
    `base seed ${BASE_SEED}, ${(elapsedMs / 1000).toFixed(1)}s`,
);
console.log(`Cap proxy: 8 land units, 12 in walled/capital provinces. ${phases} battle phases sampled.\n`);

console.log(
  table(
    ['population', 'samples', 'over cap', 'share', 'overflow units'],
    [
      ['attack stacks (vs dest cap)', attacks.n, attacks.overDestCap, pct(share(attacks.overDestCap, attacks.n), 2), attacks.overflowUnits],
      ['defender garrisons (battles)', defenders.n, defenders.overCap, pct(share(defenders.overCap, defenders.n), 2), '-'],
      ['retreat merges (returnHome)', retreats.n, retreats.overCap, pct(share(retreats.overCap, retreats.n), 2), retreats.overflowUnits],
      ['owned garrisons (per phase)', occupancy.n, occupancy.overCap, pct(share(occupancy.overCap, occupancy.n), 2), '-'],
      ['siege camps (per phase)', camps.n, camps.overCap, pct(share(camps.overCap, camps.n), 2), '-'],
    ],
  ),
);

console.log(
  `\nAttack stacks: mean ${fmt(share(attacks.sizeSum, attacks.n), 2)} land units, max ${attacks.maxSize}; ` +
    `${pct(share(attacks.over8, attacks.n), 2)} exceed 8 regardless of destination.`,
);
console.log(
  `Retreat overflow (units canon-per-§7-fix would surrender): ${retreats.overflowUnits} of ` +
    `${retreats.returningUnits} returning land units (${pct(share(retreats.overflowUnits, retreats.returningUnits), 2)}).`,
);
console.log(
  `Games with any over-cap exposure: ${gamesWithAnyExposure}/${N_GAMES} (${pct(share(gamesWithAnyExposure, N_GAMES), 1)}).`,
);
console.log(`\nResults written to ${outPath}`);
