/**
 * ADVERSARIAL agent "trade-max turtle" (exploit hunter, not a shipping agent).
 *
 * Question: is pure turtling degenerate? Specifically, can a Venice/Genoa
 * player who never fights ANYTHING — stacking trade routes, markets and
 * great works while sitting behind walls — coast to the prestige threshold
 * (or the round-16 cap win) on passive income alone?
 *
 * The agent:
 *  - opens every reachable trade route (income-sorted) up to the cap of 3;
 *  - pumps great works with ZERO gold reserve the moment marble/faith allow
 *    (the shipping turtler waits until round 5 and reserves 8 gold);
 *  - builds markets on the best gold provinces;
 *  - keeps enough galleys to deter route blockades (2 + open routes);
 *  - recruits defensively only (threat-reactive + small standing garrison);
 *  - NEVER attacks anyone, not even weak neutrals (players: none, and even
 *    that branch is removed entirely — zero conquest prestige by design);
 *  - upgrades walls only with surplus marble (great works get marble first).
 *
 * Helper heuristics are copied from sim/src/agents.ts (unexported there);
 * no shared file is modified. Everything goes through the public Game API.
 */

import type { FactionId, UnitType } from '../types';
import { CONFIG } from '../rules';
import { combatants } from '../combat';
import { PROVINCE_BY_ID } from '../map';
import {
  armyPower,
  CAPITALS,
  unitGoldCost,
  type Agent,
  type Game,
  type SiegePrefs,
} from '../game';

// Same siege prefs as the shipping turtler (it never besieges anyway, but the
// engine reads .siege if a siege somehow exists).
const TRADE_MAX_SIEGE_PREFS: SiegePrefs = {
  assaultWallThreshold: 0.75,
  assaultGarrisonMax: 2,
  strengthRatio: 1.6,
  desperationRound: 15,
};

// ---------------------------------------------------------------------------
// Helpers copied (minimal glue) from sim/src/agents.ts — unexported there.
// ---------------------------------------------------------------------------

function garrisonToLeave(g: Game, f: FactionId, pid: string): number {
  return PROVINCE_BY_ID.get(pid)!.keyCity || pid === CAPITALS[f] ? 2 : 1;
}

/** Relieve an own besieged province with the strongest adjacent stack. */
function tryRelief(g: Game, f: FactionId): boolean {
  for (const pid of g.ownedProvinces(f)) {
    const s = g.siegeAt(pid);
    if (!s || s.attacker === f) continue;
    const enemyPower = armyPower(s.army);
    let bestFrom = '';
    let bestPower = 0;
    for (const r of g.reachableFrom(pid)) {
      const q = g.province(r.to);
      if (q.owner !== f || g.isBesieged(r.to)) continue;
      const pw = armyPower(q.garrison);
      if (pw > bestPower) {
        bestPower = pw;
        bestFrom = r.to;
      }
    }
    if (bestFrom && bestPower >= 1.25 * enemyPower) {
      const garr = g.province(bestFrom).garrison;
      const n = combatants(garr) - garr.galley - 1;
      if (n >= 2 && g.actAttack(f, bestFrom, pid, n)) return true;
    }
  }
  return false;
}

function pickDefUnit(g: Game, f: FactionId): UnitType {
  const fs = g.faction(f);
  if (f === 'hungary') return 'levy';
  if (fs.gold >= 2 * unitGoldCost(f, 'professional') * CONFIG.recruit.perAction.professional) return 'professional';
  return 'levy';
}

function recruitAt(g: Game, f: FactionId, pid: string, unit: UnitType): boolean {
  let cap = CONFIG.recruit.perAction[unit];
  if (unit === 'levy') cap += CONFIG.factions[f].levyRecruitBonus;
  return g.actRecruit(f, pid, unit, cap);
}

/** Recruit defenders into the most threatened own province. */
function tryDefend(g: Game, f: FactionId, cushion = 1.0): boolean {
  if (g.grainHeadroom(f) < 1) return false;
  let worstPid = '';
  let worstGap = 0;
  for (const pid of g.ownedProvinces(f)) {
    if (g.isBesieged(pid)) continue;
    const threat = g.threatAt(pid);
    if (threat <= 0) continue;
    const gap = threat * cushion - g.defenseScore(pid);
    if (gap > worstGap) {
      worstGap = gap;
      worstPid = pid;
    }
  }
  if (!worstPid) return false;
  return recruitAt(g, f, worstPid, pickDefUnit(g, f));
}

function tryOpenRoute(g: Game, f: FactionId): boolean {
  const cands = g.routeCandidates(f);
  return cands.length > 0 && g.actOpenRoute(f, cands[0].id);
}

function tryMarket(g: Game, f: FactionId, goldReserve: number): boolean {
  const fs = g.faction(f);
  const m = CONFIG.buildings.market;
  if (fs.gold < m.goldCost + goldReserve || fs.timber < m.timberCost) return false;
  const spots = g
    .ownedProvinces(f)
    .filter((pid) => !g.province(pid).market && !g.isBesieged(pid))
    .sort((a, b) => PROVINCE_BY_ID.get(b)!.yields.gold - PROVINCE_BY_ID.get(a)!.yields.gold);
  return spots.length > 0 && g.actBuild(f, spots[0], 'market');
}

function tryGreatWork(g: Game, f: FactionId, goldReserve: number): boolean {
  const fs = g.faction(f);
  const gw = CONFIG.buildings.greatWork;
  if (fs.gold < gw.goldCost + goldReserve || fs.marble < gw.marbleCost || fs.faith < gw.faithCost) return false;
  const spots = g.ownedProvinces(f).filter((pid) => !g.isBesieged(pid));
  return spots.length > 0 && g.actBuild(f, spots[0], 'greatWork');
}

/** Wall upgrade only with marble to spare beyond the next great work. */
function trySurplusWallUpgrade(g: Game, f: FactionId, goldReserve: number): boolean {
  const fs = g.faction(f);
  const w = CONFIG.buildings.wallUpgrade;
  if (fs.marble < CONFIG.buildings.greatWork.marbleCost + 2) return false; // marble feeds great works first
  if (fs.gold < w.goldCost + goldReserve || fs.timber < w.timberCost || fs.marble < w.marbleCost) return false;
  const spots = g
    .borderOf(f)
    .filter((pid) => g.province(pid).wallTier < 3 && !g.isBesieged(pid))
    .sort((a, b) => PROVINCE_BY_ID.get(b)!.yields.gold - PROVINCE_BY_ID.get(a)!.yields.gold);
  return spots.length > 0 && g.actBuild(f, spots[0], 'wallUpgrade');
}

/** Keep a route-deterrence fleet at the best port. */
function tryRecruitGalleys(g: Game, f: FactionId, wanted: number, goldReserve: number): boolean {
  const fs = g.faction(f);
  if (fs.gold < unitGoldCost(f, 'galley') + goldReserve) return false;
  let have = 0;
  const ports: string[] = [];
  for (const pid of g.ownedProvinces(f)) {
    have += g.province(pid).garrison.galley;
    if (PROVINCE_BY_ID.get(pid)!.port && !g.isBesieged(pid)) ports.push(pid);
  }
  if (have >= wanted || ports.length === 0) return false;
  ports.sort((a, b) => PROVINCE_BY_ID.get(b)!.yields.gold - PROVINCE_BY_ID.get(a)!.yields.gold);
  return g.actRecruit(f, ports[0], 'galley', Math.min(2, wanted - have));
}

/** Standing-garrison top-up at the weakest border province (never attacks). */
function tryGarrisonTopUp(g: Game, f: FactionId): boolean {
  if (g.grainHeadroom(f) < 1) return false;
  let n = 0;
  for (const pid of g.ownedProvinces(f)) n += combatants(g.province(pid).garrison);
  if (n >= 2.5 * g.ownedProvinces(f).length) return false;
  let where = '';
  let worst = Infinity;
  for (const pid of g.borderOf(f)) {
    if (g.isBesieged(pid)) continue;
    const k = combatants(g.province(pid).garrison);
    if (k < worst) {
      worst = k;
      where = pid;
    }
  }
  if (!where) {
    const cap = CAPITALS[f];
    if (g.province(cap).owner === f && !g.isBesieged(cap)) where = cap;
    else return false;
  }
  return recruitAt(g, f, where, pickDefUnit(g, f));
}

// ---------------------------------------------------------------------------
// Trade-max turtle turn
// ---------------------------------------------------------------------------

function tradeMaxTurn(g: Game, f: FactionId): void {
  const fs = g.faction(f);
  while (g.actionsLeft > 0) {
    if (tryRelief(g, f)) continue;
    if (tryDefend(g, f, 1.2)) continue;
    if (tryOpenRoute(g, f)) continue;
    if (tryGreatWork(g, f, 0)) continue; // zero reserve: prestige above all
    if (tryMarket(g, f, 12)) continue;
    if (tryRecruitGalleys(g, f, 2 + fs.routes.length, 8)) continue;
    if (trySurplusWallUpgrade(g, f, 15)) continue;
    if (tryGarrisonTopUp(g, f)) continue;
    g.actPass(f);
  }
}

export function makeTradeMaxTurtleAgent(): Agent {
  return {
    // engine only reads .siege and .takeTurn; name is typed PolicyName, so
    // reuse 'turtler' (closest shipping label)
    name: 'turtler',
    siege: TRADE_MAX_SIEGE_PREFS,
    takeTurn: (game, faction) => tradeMaxTurn(game, faction),
  };
}
