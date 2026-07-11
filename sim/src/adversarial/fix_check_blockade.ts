/**
 * Fix check for the BLOCKADE-GRIEFING finding
 * (npx tsx src/adversarial/fix_check_blockade.ts).
 *
 * Finding (run_economy_exploit.ts part D, seed 311005): a cheap Ottoman
 * galley picket + a 2-unit war-maintenance poke deletes trader-Genoa
 * (49.8% -> 0.1% win, paired seeds) with no working counterplay
 * (rusher-Genoa 0.0%; passive picket with ONE galley still 0.6%), while
 * doubling the griefer's own win rate. Root cause: trade.blockadeCancels
 * zeroes a route while ANY at-war enemy port on ANY of its sea zones holds
 * a single galley — sim divergence from canon §5.2, which HALVES blockaded
 * route income (x0.5) and zeroes only a SEVERED route, and much cruder
 * than the sim's own siege blockade (isSeaBlockaded), which requires
 * strict galley superiority per zone.
 *
 * Candidate fixes are applied by monkey-patching Game.prototype IN-PROCESS
 * ONLY (this file never edits shared sources):
 *   V1 "canonHalving"    : blockaded routes yield x0.5 income instead of 0
 *                          (canon §5.2; monopoly prestige unchanged).
 *   V2 "superiority"     : a zone only blockades the route if some at-war
 *                          enemy has STRICT galley superiority over the
 *                          route owner near that zone (mirror of the siege
 *                          module's isSeaBlockaded / galleysNearZone).
 *   V1+V2 "both"         : superiority test AND halving.
 *
 * For each patch: reruns the paired-seed part-D arms (control, griefGenoa,
 * griefGenoaPassive; seed = 311005 + 900000 + i) and a 1000-game
 * shipping-mix fullgame (seed = 311005 + 50000 + i, fullgame scheme) to
 * confirm T1/T2/T3/T4 still hold under the patch.
 *
 * Appends a fixChecks entry to sim/results/adversarial_economy_exploit.json.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACTION_IDS, type FactionId } from '../types';
import { CONFIG } from '../rules';
import { create } from '../rng';
import { SEA_ZONE_BY_ID, TRADE_ROUTES } from '../map';
import { Game, POLICY_NAMES, type Agent, type PolicyName, type VictoryType } from '../game';
import { makeAgent } from '../agents';
import { isSmoke, pct, fmt, table } from '../util';
import { makeBlockadeGrieferAgent, makeMinimalPicketAgent, makeRecordingAgent, type TurnRecord } from './economy_exploit';

const BASE_SEED = 311005;
const SMOKE = isSmoke();
const N_BLOCKADE = SMOKE ? 30 : 1000;
const N_FULL = SMOKE ? 30 : 1000;

// ---------------------------------------------------------------------------
// Monkey-patches (in-process only)
// ---------------------------------------------------------------------------

/** Structural view of Game internals reached by the in-process patches. */
interface AnyGame {
  routeBlockaded(owner: FactionId, zones: string[]): boolean;
  openRoutesOf(f: FactionId): typeof TRADE_ROUTES;
  faction(f: FactionId): { routes: string[] };
  warsOf(f: FactionId): FactionId[];
  siegeAt(pid: string): { attacker: FactionId; army: { galley: number } } | null;
  provinces: Map<string, { owner: FactionId | null; garrison: { galley: number } }>;
}

const proto = Game.prototype as unknown as AnyGame;
const origOpenRoutesOf = proto.openRoutesOf;
const origRouteBlockaded = proto.routeBlockaded;

/** Galleys `f` can bring to bear on a zone (mirror of game.ts galleysNearZone). */
function galleysNear(g: AnyGame, f: FactionId, zoneId: string): number {
  let n = 0;
  for (const pid of SEA_ZONE_BY_ID.get(zoneId)!.coastalProvinces) {
    const p = g.provinces.get(pid)!;
    if (p.owner === f) n += p.garrison.galley;
    const s = g.siegeAt(pid);
    if (s && s.attacker === f) n += s.army.galley;
  }
  return n;
}

function patchSuperiority(): void {
  proto.routeBlockaded = function (this: AnyGame, owner: FactionId, zones: string[]): boolean {
    for (const z of zones) {
      const mine = galleysNear(this, owner, z);
      for (const enemy of this.warsOf(owner)) {
        if (galleysNear(this, enemy, z) > mine) return true;
      }
    }
    return false;
  };
}

function patchHalving(): void {
  proto.openRoutesOf = function (this: AnyGame, f: FactionId): typeof TRADE_ROUTES {
    const fs = this.faction(f);
    const out: Array<(typeof TRADE_ROUTES)[number]> = [];
    for (const rid of fs.routes) {
      const r = TRADE_ROUTES.find((x) => x.id === rid)!;
      if (this.provinces.get(r.a)!.owner !== f && this.provinces.get(r.b)!.owner !== f) continue; // severed: 0
      const blocked = CONFIG.trade.blockadeIncomeMult !== 1 && this.routeBlockaded(f, r.seaZones);
      out.push(blocked ? { ...r, income: r.income * 0.5 } : r); // canon §5.2: blockade x0.5
    }
    return out;
  };
}

function unpatch(): void {
  proto.openRoutesOf = origOpenRoutesOf;
  proto.routeBlockaded = origRouteBlockaded;
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

interface Tally { games: number; wins: number }
const rate = (t: Tally) => t.wins / Math.max(1, t.games);

const victimZones = (victim: FactionId): string[] => {
  const zones = new Set<string>();
  const victimEnds: Record<string, FactionId | null> = {
    venice: 'venice', crete: 'venice', corfu: 'venice', negroponte: 'venice', zara: 'venice', modon: 'venice',
    genoa: 'genoa', chios: 'genoa', lesbos: 'genoa', caffa: 'genoa', pera: 'genoa',
  };
  for (const r of TRADE_ROUTES) {
    if ([r.a, r.b].some((e) => victimEnds[e] === victim)) for (const z of r.seaZones) zones.add(z);
  }
  return [...zones];
};

const FIXED_POLICY: Record<FactionId, PolicyName> = {
  byzantium: 'opportunist',
  ottomans: 'rusher',
  venice: 'trader',
  genoa: 'trader',
  hungary: 'rusher',
};

type BlockArm = 'control' | 'griefGenoa' | 'griefGenoaPassive';
const BLOCK_ARMS: BlockArm[] = ['control', 'griefGenoa', 'griefGenoaPassive'];

function runBlockadeArms(): Record<BlockArm, { byFaction: Record<FactionId, Tally>; genRoutes: number; genIncome: number; genTurns: number }> {
  const out = Object.fromEntries(
    BLOCK_ARMS.map((a) => [
      a,
      {
        byFaction: Object.fromEntries(FACTION_IDS.map((f) => [f, { games: 0, wins: 0 }])) as Record<FactionId, Tally>,
        genRoutes: 0,
        genIncome: 0,
        genTurns: 0,
      },
    ]),
  ) as Record<BlockArm, { byFaction: Record<FactionId, Tally>; genRoutes: number; genIncome: number; genTurns: number }>;
  for (let i = 0; i < N_BLOCKADE; i++) {
    const seed = BASE_SEED + 900_000 + i;
    const seatOrder = FACTION_IDS.map((_, k) => FACTION_IDS[(k + i) % FACTION_IDS.length]);
    for (const arm of BLOCK_ARMS) {
      const stats = out[arm];
      const sink = (f: FactionId, rec: TurnRecord): void => {
        if (f === 'genoa') {
          stats.genRoutes += rec.openRoutes;
          stats.genIncome += rec.goldIncome;
          stats.genTurns++;
        }
      };
      const agents = {} as Record<FactionId, Agent>;
      for (const f of FACTION_IDS) agents[f] = makeRecordingAgent(makeAgent(FIXED_POLICY[f]), sink);
      if (arm === 'griefGenoa') agents.ottomans = makeBlockadeGrieferAgent('genoa', victimZones('genoa'));
      if (arm === 'griefGenoaPassive') agents.ottomans = makeMinimalPicketAgent('genoa', victimZones('genoa'));
      const res = new Game(seed, agents, seatOrder).run();
      for (const f of FACTION_IDS) {
        stats.byFaction[f].games++;
        if (res.winner === f) stats.byFaction[f].wins++;
      }
    }
  }
  return out;
}

function runFullgame(): {
  byFaction: Record<FactionId, Tally>;
  byPolicy: Record<PolicyName, Tally>;
  victoryTypes: Record<VictoryType, number>;
  medianRounds: number;
  shareBeforeRound11: number;
  shareRounds12to16: number;
  suddenDeathShare: number;
} {
  const byFaction = Object.fromEntries(FACTION_IDS.map((f) => [f, { games: 0, wins: 0 }])) as Record<FactionId, Tally>;
  const byPolicy = Object.fromEntries(POLICY_NAMES.map((p) => [p, { games: 0, wins: 0 }])) as Record<PolicyName, Tally>;
  const victoryTypes: Record<VictoryType, number> = { threshold: 0, cap: 0, suddenDeath: 0, elimination: 0 };
  const lengths: number[] = [];
  for (let i = 0; i < N_FULL; i++) {
    const seed = BASE_SEED + 50_000 + i;
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
    for (const f of FACTION_IDS) {
      byFaction[f].games++;
      byPolicy[policyOf[f]].games++;
    }
    byFaction[res.winner].wins++;
    byPolicy[policyOf[res.winner]].wins++;
    victoryTypes[res.victoryType]++;
    lengths.push(res.rounds);
  }
  lengths.sort((a, b) => a - b);
  return {
    byFaction,
    byPolicy,
    victoryTypes,
    medianRounds: lengths[Math.floor(lengths.length / 2)],
    shareBeforeRound11: lengths.filter((r) => r < 11).length / lengths.length,
    shareRounds12to16: lengths.filter((r) => r >= 12 && r <= 16).length / lengths.length,
    suddenDeathShare: victoryTypes.suddenDeath / N_FULL,
  };
}

// ---------------------------------------------------------------------------
// Run each patch variant
// ---------------------------------------------------------------------------

type Variant = 'canonHalving' | 'superiority' | 'both';
const VARIANTS: Variant[] = ['canonHalving', 'superiority', 'both'];

console.log(`blockade fix check — base seed ${BASE_SEED}${SMOKE ? ' (SMOKE)' : ''}, ${N_BLOCKADE} games/arm`);

const variantOut: Record<string, unknown> = {};
for (const v of VARIANTS) {
  unpatch();
  if (v === 'canonHalving' || v === 'both') patchHalving();
  if (v === 'superiority' || v === 'both') patchSuperiority();
  const arms = runBlockadeArms();
  const full = runFullgame();
  console.log(`\n[${v}] blockade arms:`);
  console.log(
    table(
      ['arm', ...FACTION_IDS.map((f) => `${f} win`), 'gen rts/t', 'gen inc/t'],
      BLOCK_ARMS.map((a) => [
        a,
        ...FACTION_IDS.map((f) => pct(rate(arms[a].byFaction[f]))),
        fmt(arms[a].genRoutes / Math.max(1, arms[a].genTurns)),
        fmt(arms[a].genIncome / Math.max(1, arms[a].genTurns)),
      ]),
    ),
  );
  console.log(
    `[${v}] fullgame: ` +
      FACTION_IDS.map((f) => `${f} ${pct(rate(full.byFaction[f]))}`).join(', ') +
      ' | ' +
      POLICY_NAMES.map((p) => `${p} ${pct(rate(full.byPolicy[p]))}`).join(', ') +
      ` | median r${full.medianRounds}, <r11 ${pct(full.shareBeforeRound11)}, SD ${pct(full.suddenDeathShare)}`,
  );
  variantOut[v] = {
    blockadeArms: Object.fromEntries(
      BLOCK_ARMS.map((a) => [
        a,
        {
          byFaction: Object.fromEntries(FACTION_IDS.map((f) => [f, { ...arms[a].byFaction[f], rate: rate(arms[a].byFaction[f]) }])),
          genoaAvgOpenRoutesPerTurn: arms[a].genRoutes / Math.max(1, arms[a].genTurns),
          genoaAvgGoldIncomePerTurn: arms[a].genIncome / Math.max(1, arms[a].genTurns),
        },
      ]),
    ),
    fullgame: {
      byFaction: Object.fromEntries(FACTION_IDS.map((f) => [f, { ...full.byFaction[f], rate: rate(full.byFaction[f]) }])),
      byPolicy: Object.fromEntries(POLICY_NAMES.map((p) => [p, { ...full.byPolicy[p], rate: rate(full.byPolicy[p]) }])),
      victoryTypes: full.victoryTypes,
      medianRounds: full.medianRounds,
      shareBeforeRound11: full.shareBeforeRound11,
      shareRounds12to16: full.shareRounds12to16,
      suddenDeathShare: full.suddenDeathShare,
    },
  };
}
unpatch();

// ------------------------------------------------------------ append to json

const resultsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results', 'adversarial_economy_exploit.json');
try {
  const existing = JSON.parse(readFileSync(resultsPath, 'utf8')) as Record<string, unknown> & { fixChecks?: unknown[] };
  existing.fixChecks = existing.fixChecks ?? [];
  existing.fixChecks.push({
    finding: 'blockade-griefing',
    patchesTestedInProcessOnly: {
      canonHalving: 'openRoutesOf: blockaded route income x0.5 instead of 0 (canon §5.2)',
      superiority: 'routeBlockaded: zone blocks only on strict at-war galley superiority near the zone (mirror of siege isSeaBlockaded)',
      both: 'superiority AND halving',
    },
    seedScheme: {
      blockade: 'seed = 311005 + 900000 + i (same paired seeds as part D)',
      fullgame: 'seed = 311005 + 50000 + i, fullgame.ts assignment scheme',
    },
    gamesPerArm: N_BLOCKADE,
    fullgameGames: N_FULL,
    variants: variantOut,
  });
  writeFileSync(resultsPath, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\nfixCheck appended to ${resultsPath}`);
} catch (e) {
  console.log(`\ncould not append fixCheck to ${resultsPath}: ${String(e)}`);
}
