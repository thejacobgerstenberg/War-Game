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
import { CONFIG, statsFor } from '../rules';
import { combatants } from '../combat';
import { PROVINCE_BY_ID, TRADE_ROUTES } from '../map';
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

// ===========================================================================
// MONOPOLY-MAX turtle (final-canon variant of the hunt).
//
// Under the retuned canon config, per-route prestige is 0 and the passive
// prestige lever is the §13.1 trade MONOPOLY: +2/round for every open route
// whose BOTH endpoints you own. Venice/Genoa each start with exactly one
// (venice_crete / genoa_caffa) — by design (map.ts comment). But several
// routes have a NEUTRAL second endpoint:
//   genoa:  chios_smyrna  -> Smyrna    (T1 walls, 3 levies)
//           trebizond_caffa -> Trebizond (T3 key city, 5 levies + 2 prof)
//   venice: crete_cyprus  -> Cyprus    (T2 walls, 4 levies)
//           ragusa_venice -> Ragusa    (T2 key city, 4 levies + 2 prof)
// Capturing one converts an open route into a second/third +2/round monopoly
// (plus key-city +1/round where applicable) while never fighting a PLAYER —
// i.e. it stays inside the "passive turtle" envelope the hunt targets.
//
// The agent = trade-max turtle + monopoly-endpoint sniping of NEUTRALS only
// (+ neutral secret-objective pickups en route, since those pay +4 at cap).
// ===========================================================================

// Assault small neutral cities promptly instead of camping for years.
const MONOPOLY_MAX_SIEGE_PREFS: SiegePrefs = {
  assaultWallThreshold: 2.0, // T1/T2 walls: assault at full bonus
  assaultGarrisonMax: 4,
  strengthRatio: 1.4,
  desperationRound: 11,
};

/**
 * Solvency-guarded recruit (agents.ts recruitAt), EXCEPT that a rich
 * merchant republic willingly runs a gold-funded grain deficit: the engine
 * auto-buys shortfall grain at 2g/grain during upkeep, so spare treasury
 * over a 20-gold reserve is counted as feeding capacity across a 6-round
 * campaign horizon. (The shipping agents' hard grainHeadroom>=1 gate is what
 * kept Venice — whose 8 starting galleys eat its whole grain income — from
 * ever recruiting at 400 idle gold; see hunt trace.)
 */
function recruitGuarded(g: Game, f: FactionId, pid: string, unit: UnitType): boolean {
  let cap = CONFIG.recruit.perAction[unit];
  if (unit === 'levy') cap += CONFIG.factions[f].levyRecruitBonus;
  const fs = g.faction(f);
  const perUnitGrain = statsFor(f, unit).grainUpkeep;
  if (perUnitGrain > 0) {
    const goldSpare = Math.max(0, fs.gold - g.goldNeedOf(f) - 10);
    const boughtGrainPerRound = goldSpare / (CONFIG.economy.grainMarket.buyGoldPerGrain * 4);
    const affordable = Math.floor((g.grainHeadroom(f) + boughtGrainPerRound) / perUnitGrain);
    if (affordable < cap) cap = affordable;
    if (cap <= 0) return false;
  }
  const cost = unitGoldCost(f, unit);
  if (cost > 0) {
    const affordable = Math.floor((fs.gold - g.goldNeedOf(f)) / cost);
    if (affordable < cap) cap = affordable;
    if (cap <= 0) return false;
  }
  return g.actRecruit(f, pid, unit, cap);
}

/**
 * Neutral provinces whose capture completes a monopoly for f:
 * routes where f owns exactly one endpoint and the other is neutral, and
 * the route is already open or a slot is free to open it.
 */
function monopolyTargets(g: Game, f: FactionId): string[] {
  const fs = g.faction(f);
  const out: string[] = [];
  for (const r of TRADE_ROUTES) {
    const ownA = g.province(r.a).owner === f;
    const ownB = g.province(r.b).owner === f;
    if (ownA === ownB) continue; // both ends (done) or neither (not ours)
    if (!fs.routes.includes(r.id) && fs.routes.length >= CONFIG.trade.maxRoutesPerFaction) continue;
    const other = ownA ? r.b : r.a;
    if (g.province(other).owner === null && !out.includes(other)) out.push(other);
  }
  return out;
}

/** Neutral secret-objective provinces (pay +4 at the round-16 reveal). */
function neutralObjectiveTargets(g: Game, f: FactionId): string[] {
  const fs = g.faction(f);
  if (fs.objective.done) return [];
  return fs.objective.provinces.filter((pid) => g.province(pid).owner === null);
}

/** Open the route that maximizes monopoly prestige, then income. */
function tryOpenRouteMonopolyFirst(g: Game, f: FactionId): boolean {
  const cands = g.routeCandidates(f);
  if (cands.length === 0) return false;
  const score = (r: (typeof cands)[number]): number => {
    const ownA = g.province(r.a).owner === f;
    const ownB = g.province(r.b).owner === f;
    if (ownA && ownB) return 100 + r.income; // instant +2/round monopoly
    const other = ownA ? r.b : r.a;
    if (g.province(other).owner === null) return 50 + r.income; // convertible by sniping
    return r.income;
  };
  const best = [...cands].sort((x, y) => score(y) - score(x))[0];
  return g.actOpenRoute(f, best.id);
}

/**
 * Attack a NEUTRAL monopoly/objective target from the strongest adjacent
 * owned stack when odds are overwhelming. Never touches player provinces.
 */
function trySnipeNeutralTarget(g: Game, f: FactionId, targets: readonly string[]): boolean {
  if (targets.length === 0) return false;
  let bestFrom = '';
  let bestTo = '';
  let bestScore = -Infinity;
  let bestWalled = false;
  for (const from of g.ownedProvinces(f)) {
    if (g.isBesieged(from)) continue;
    const garr = g.province(from).garrison;
    const n = combatants(garr) - garr.galley;
    const leave = garrisonToLeave(g, f, from);
    if (n - leave < 3) continue;
    const myPower = armyPower(garr);
    for (const r of g.reachableFrom(from)) {
      if (!targets.includes(r.to)) continue;
      const t = g.province(r.to);
      if (t.owner !== null) continue; // neutrals only, ever
      const s = g.siegeAt(r.to);
      if (s && s.attacker !== f) continue;
      if (r.sea) {
        const land = garr.levy + garr.professional + garr.mercenary;
        if (garr.galley < Math.ceil(Math.min(land, n) / 2)) continue;
      }
      const walled = t.wallTier > 0 && combatants(t.garrison) > 0 && !(s && s.attacker === f);
      let feasible: boolean;
      if (s && s.attacker === f) feasible = n >= 2; // reinforce own siege
      else if (walled) feasible = myPower >= 1.6 * (armyPower(t.garrison) + 1);
      else feasible = myPower >= 1.6 * g.defenseScore(r.to);
      if (!feasible) continue;
      const score = 10 - (walled ? 2 : 0) - (r.sea ? 1 : 0) + PROVINCE_BY_ID.get(r.to)!.yields.gold;
      if (score > bestScore) {
        bestScore = score;
        bestFrom = from;
        bestTo = r.to;
        bestWalled = walled;
      }
    }
  }
  if (bestScore === -Infinity) return false;
  const garr = g.province(bestFrom).garrison;
  const n = combatants(garr) - garr.galley;
  const leave = garrisonToLeave(g, f, bestFrom);
  return g.actAttack(f, bestFrom, bestTo, n - leave, bestWalled ? garr.siegeEngine : 0);
}

/**
 * Build the snipe force: recruit at the owned province nearest to a target
 * (adjacent staging point), plus galley escort for sea hops.
 */
function tryBuildStrike(g: Game, f: FactionId, targets: readonly string[]): boolean {
  if (targets.length === 0) return false;
  // find a staging province adjacent to some target
  let staging = '';
  let sea = false;
  for (const from of g.ownedProvinces(f)) {
    if (g.isBesieged(from)) continue;
    for (const r of g.reachableFrom(from)) {
      if (!targets.includes(r.to)) continue;
      if (g.province(r.to).owner !== null) continue;
      if (!staging || armyPower(g.province(from).garrison) > armyPower(g.province(staging).garrison)) {
        staging = from;
        sea = r.sea;
      }
    }
  }
  if (!staging) return false;
  const garr = g.province(staging).garrison;
  const land = garr.levy + garr.professional + garr.mercenary;
  if (sea && garr.galley < Math.ceil(land / 2) && PROVINCE_BY_ID.get(staging)!.port) {
    if (g.actRecruit(f, staging, 'galley', Math.ceil(land / 2) - garr.galley)) return true;
  }
  const unit: UnitType = f === 'hungary' ? 'levy' : 'professional';
  return recruitGuarded(g, f, staging, unit);
}

function monopolyMaxTurn(g: Game, f: FactionId): void {
  const fs = g.faction(f);
  // sniping stops the moment every openable route is a monopoly
  const targets = [...monopolyTargets(g, f), ...neutralObjectiveTargets(g, f)];
  const sniping = targets.length > 0 && g.round <= 12; // late captures don't pay back
  while (g.actionsLeft > 0) {
    if (tryRelief(g, f)) continue;
    if (tryDefend(g, f, 1.2)) continue;
    if (tryOpenRouteMonopolyFirst(g, f)) continue;
    if (sniping && trySnipeNeutralTarget(g, f, targets)) continue;
    if (sniping && tryBuildStrike(g, f, targets)) continue;
    if (tryGreatWork(g, f, sniping ? 25 : 0)) continue; // strike force gets first call on gold
    if (tryMarket(g, f, 12)) continue;
    if (tryRecruitGalleys(g, f, 2 + fs.routes.length, 8)) continue;
    if (trySurplusWallUpgrade(g, f, 15)) continue;
    if (tryGarrisonTopUp(g, f)) continue;
    g.actPass(f);
  }
}

export function makeMonopolyMaxAgent(): Agent {
  return {
    name: 'turtler',
    siege: MONOPOLY_MAX_SIEGE_PREFS,
    takeTurn: (game, faction) => monopolyMaxTurn(game, faction),
  };
}
