/**
 * Four scripted policies behind the single legal-action Agent interface
 * (game.ts). Any policy can drive any faction; the runner rotates the
 * assignment deterministically across games.
 *
 *  - rusher      : max army, attacks the weakest valuable neighbor, beelines
 *                  key cities, buys the Great Bombard for Constantinople.
 *  - trader      : opens routes, builds markets, keeps galleys, defends and
 *                  counterattacks only in wars it did not start; grabs only
 *                  trivially-weak neutrals.
 *  - turtler     : fortifies, tall economy, great works; tiny early expansion.
 *  - opportunist : adaptive — snipes its secret objective, hits weakened
 *                  players, balances economy and military.
 *
 * All decisions are heuristics over the Game read API; every state change
 * goes through the act* legal-action methods (which validate and consume
 * actions). Exploration randomness comes from game.agentRng (seeded).
 */

import type { FactionId, UnitType } from './types';
import { CONFIG, statsFor } from './rules';
import { combatants } from './combat';
import { PROVINCE_BY_ID } from './map';
import {
  armyPower,
  CAPITALS,
  unitGoldCost,
  type Agent,
  type Game,
  type PolicyName,
  type SiegePrefs,
} from './game';

// ------------------------------------------------------------ siege prefs

const SIEGE_PREFS: Record<PolicyName, SiegePrefs> = {
  rusher: { assaultWallThreshold: 1.5, assaultGarrisonMax: 3, strengthRatio: 1.2, desperationRound: 13 },
  trader: { assaultWallThreshold: 0.75, assaultGarrisonMax: 2, strengthRatio: 1.6, desperationRound: 15 },
  turtler: { assaultWallThreshold: 0.75, assaultGarrisonMax: 2, strengthRatio: 1.6, desperationRound: 15 },
  opportunist: { assaultWallThreshold: 1.2, assaultGarrisonMax: 3, strengthRatio: 1.3, desperationRound: 12 },
};

// ------------------------------------------------------------- primitives

/** Value of grabbing a province (attack target scoring). */
function targetValue(g: Game, f: FactionId, pid: string): number {
  const prov = PROVINCE_BY_ID.get(pid)!;
  let v = prov.yields.gold + 0.5 * prov.yields.grain + 0.3 * (prov.yields.timber + prov.yields.marble + prov.yields.faith);
  if (prov.keyCity) v += 6;
  if (pid === 'constantinople') v += 5;
  const fs = g.faction(f);
  if (!fs.objective.done && g.round <= fs.objective.deadline && fs.objective.provinces.includes(pid)) v += 8;
  const owner = g.province(pid).owner;
  if (owner && owner !== f) {
    v += 1.5; // hurting a rival is worth something
    if (owner === prestigeLeader(g, f)) v += 5; // slow down the runaway leader
  }
  return v;
}

/**
 * The prestige leader (excluding f) if it is pulling ahead. Activation at
 * 0.4x threshold (~r6-8) so anti-leader pressure exists while the race is
 * still open — the old 0.6x gate only fired ~r11+, after threshold races
 * were decided (runaway-leader hunter: provably inert).
 */
function prestigeLeader(g: Game, f: FactionId): FactionId | null {
  let leader: FactionId | null = null;
  let best = 0.4 * CONFIG.prestige.victoryThreshold; // only worry when pulling ahead
  for (const other of ['byzantium', 'ottomans', 'venice', 'genoa', 'hungary'] as FactionId[]) {
    if (other === f || !g.faction(other).alive) continue;
    const t = g.faction(other).ledger.total;
    if (t > best) {
      best = t;
      leader = other;
    }
  }
  return leader;
}

/** Defenders to leave behind when attacking out of pid. */
function garrisonToLeave(g: Game, f: FactionId, pid: string): number {
  return PROVINCE_BY_ID.get(pid)!.keyCity || pid === CAPITALS[f] ? 2 : 1;
}

interface AttackOpts {
  /** Required power ratio vs defenseScore for unwalled targets. */
  minRatio: number;
  /** Required power ratio vs raw garrison power to invest a walled city. */
  walledRatio: number;
  /** Restrict targets: neutrals always allowed; players only per this. */
  players: 'any' | 'warOnly' | 'none';
  /** Only these provinces qualify (objective sniping); null = all. */
  onlyTargets?: readonly string[] | null;
  /** Minimum combatants a stack needs before it may attack at all. */
  minStack?: number;
}

/**
 * Find the best (value-weighted, feasible) attack from any owned stack and
 * execute it. Also reinforces own sieges when adjacent troops are idle.
 */
function tryAttack(g: Game, f: FactionId, o: AttackOpts): boolean {
  const minStack = o.minStack ?? 4;
  const leader = prestigeLeader(g, f); // anti-snowball: leader targets get relaxed odds gates
  let bestFrom = '';
  let bestTo = '';
  let bestScore = -Infinity;
  let bestWalled = false;
  for (const from of g.ownedProvinces(f)) {
    if (g.isBesieged(from)) continue;
    const garr = g.province(from).garrison;
    const n = combatants(garr) - garr.galley; // galleys only escort
    const leave = garrisonToLeave(g, f, from);
    if (n - leave < 3 || n + garr.galley < minStack) continue;
    const myPower = armyPower(garr);
    for (const r of g.reachableFrom(from)) {
      const t = g.province(r.to);
      if (t.owner === f) {
        // reinforce own siege next door with idle troops
        const s = g.siegeAt(r.to);
        if (s && s.attacker === f) {
          /* handled via siege reinforcement below (owner!==f case) */
        }
        continue;
      }
      const s = g.siegeAt(r.to);
      if (s && s.attacker !== f) continue; // someone else's siege: stay out
      if (t.owner !== null) {
        if (o.players === 'none') continue;
        if (o.players === 'warOnly' && !g.atWar(f, t.owner)) continue;
      }
      if (o.onlyTargets && !o.onlyTargets.includes(r.to)) continue;
      if (r.sea) {
        const land = garr.levy + garr.professional + garr.mercenary;
        if (garr.galley < Math.ceil(Math.min(land, n) / 2)) continue;
      }
      const walled = t.wallTier > 0 && combatants(t.garrison) > 0 && !(s && s.attacker === f);
      // Leader pressure must change FEASIBILITY, not just target ordering:
      // the +5 targetValue bonus alone was measured inert (0.2% decision
      // changes) because leader provinces never passed the odds gates.
      const gateScale = t.owner !== null && t.owner === leader ? 0.85 : 1;
      let feasible: boolean;
      if (s && s.attacker === f) {
        feasible = n >= 2; // reinforcing an existing siege is cheap
      } else if (walled) {
        feasible = myPower >= o.walledRatio * gateScale * (armyPower(t.garrison) + 1);
        // Tier-5 fortresses (the Theodosian Walls) are a siege tar pit
        // without the Great Bombard: the canon §8.3 masonry cap limits an
        // ordinary train to 1 wall HP/round and the open sea feeds the city
        // (§8.2.3). Stay away unless we own the Bombard.
        if (t.wallTier >= 5 && g.wallBonusAt(r.to) > 0 && !g.faction(f).hasGreatBombard) feasible = false;
      } else {
        feasible = myPower >= o.minRatio * gateScale * g.defenseScore(r.to);
      }
      if (!feasible) continue;
      const score = targetValue(g, f, r.to) - (walled ? 2 : 0) - (r.sea ? 1 : 0);
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
      const n = combatants(garr) - garr.galley - 1; // leave a caretaker
      if (n >= 2 && g.actAttack(f, bestFrom, pid, n)) return true;
    }
    // No field relief available: run troops in through an open harbor
    // (canon §8.2.3 sea resupply — the Giustiniani ferry).
    if (g.harborOpen(pid) && tryFerryIn(g, f, pid)) return true;
  }
  return false;
}

/** Ferry spare fighters by sea into an own besieged sea-resupplied city. */
function tryFerryIn(g: Game, f: FactionId, pid: string): boolean {
  let bestFrom = '';
  let bestN = 0;
  for (const r of g.reachableFrom(pid)) {
    if (!r.sea) continue;
    const q = g.province(r.to);
    if (q.owner !== f || g.isBesieged(r.to)) continue;
    const garr = q.garrison;
    const spare = combatants(garr) - garr.galley - garrisonToLeave(g, f, r.to);
    const n = Math.min(spare, 2 * garr.galley); // 1 galley escorts 2 land units
    if (n > bestN) {
      bestN = n;
      bestFrom = r.to;
    }
  }
  return bestN >= 2 && g.actMove(f, bestFrom, pid, bestN);
}

/** Recruit defenders into the most threatened own province. */
function tryDefend(g: Game, f: FactionId, cushion = 1.0): boolean {
  if (g.grainHeadroom(f) < 1) return false;
  let worstPid = '';
  let worstGap = 0;
  for (const pid of g.ownedProvinces(f)) {
    if (g.isBesieged(pid) && !g.harborOpen(pid)) continue; // sea-resupplied city: recruit inside
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

function pickDefUnit(g: Game, f: FactionId): UnitType {
  const fs = g.faction(f);
  if (f === 'hungary') return 'levy';
  if (fs.gold >= 2 * unitGoldCost(f, 'professional') * CONFIG.recruit.perAction.professional) return 'professional';
  return 'levy';
}

function recruitAt(g: Game, f: FactionId, pid: string, unit: UnitType): boolean {
  let cap = CONFIG.recruit.perAction[unit];
  if (unit === 'levy') cap += CONFIG.factions[f].levyRecruitBonus;
  // Solvency guards: never recruit a batch the grain economy cannot feed
  // (mercenaries eat x2 grain per canon §6.2 — a full merc batch can sink a
  // small faction), and always keep enough gold back for the standing wage
  // bill (unpaid gold-paid troops desert and can strip a garrison bare).
  const perUnitGrain = statsFor(f, unit).grainUpkeep;
  if (perUnitGrain > 0) {
    const affordable = Math.floor(g.grainHeadroom(f) / perUnitGrain);
    if (affordable < cap) cap = affordable;
    if (cap <= 0) return false;
  }
  const cost = unitGoldCost(f, unit);
  if (cost > 0) {
    const affordable = Math.floor((g.faction(f).gold - g.goldNeedOf(f)) / cost);
    if (affordable < cap) cap = affordable;
    if (cap <= 0) return false;
  }
  return g.actRecruit(f, pid, unit, cap);
}

/** Military build-up at the biggest border stack (or the capital). */
function tryRecruitMilitary(g: Game, f: FactionId, aggressive: boolean): boolean {
  if (g.grainHeadroom(f) < 1) return false;
  const fs = g.faction(f);
  const border = g.borderOf(f);
  let where = '';
  let bestN = -1;
  for (const pid of border) {
    if (g.isBesieged(pid)) continue;
    const n = combatants(g.province(pid).garrison);
    if (n > bestN) {
      bestN = n;
      where = pid;
    }
  }
  if (!where) {
    const cap = CAPITALS[f];
    if (g.province(cap).owner === f && !g.isBesieged(cap)) where = cap;
    else return false;
  }
  // engines when a walled target is next door and we field fewer than 3
  let engines = 0;
  for (const a of g.ownedProvinces(f)) engines += g.province(a).garrison.siegeEngine;
  if (engines < CONFIG.siege.maxEffectiveEngines) {
    for (const r of g.reachableFrom(where)) {
      const t = g.province(r.to);
      if (t.owner !== f && t.wallTier > 0 && combatants(t.garrison) > 0) {
        if (g.actRecruit(f, where, 'siegeEngine', 1)) return true;
        break;
      }
    }
  }
  let unit: UnitType;
  if (f === 'hungary') unit = 'levy';
  else if (aggressive && fs.gold >= 24 && g.warsOf(f).length > 0) unit = 'mercenary'; // instant muscle mid-war
  else if (fs.gold >= unitGoldCost(f, 'professional') * 2) unit = 'professional';
  else unit = 'levy';
  return recruitAt(g, f, where, unit);
}

/** The border province holding the faction's strongest stack (rally point). */
function rallyPoint(g: Game, f: FactionId): string | null {
  let best: string | null = null;
  let bestPw = -1;
  for (const pid of g.borderOf(f)) {
    if (g.isBesieged(pid)) continue;
    const pw = armyPower(g.province(pid).garrison);
    if (pw > bestPw) {
      bestPw = pw;
      best = pid;
    }
  }
  return best;
}

/**
 * Mass troops: march the biggest secondary stack one step toward the rally
 * point so attacks come from one large army instead of scattered garrisons.
 */
function tryConsolidate(g: Game, f: FactionId): boolean {
  const rally = rallyPoint(g, f);
  if (!rally) return false;
  let from = '';
  let bestSpare = 1; // need at least 2 spare units to bother
  for (const pid of g.ownedProvinces(f)) {
    if (pid === rally || g.isBesieged(pid)) continue;
    const garr = g.province(pid).garrison;
    const spare = combatants(garr) - garr.galley + garr.siegeEngine - garrisonToLeave(g, f, pid);
    if (spare > bestSpare) {
      bestSpare = spare;
      from = pid;
    }
  }
  if (!from) return false;
  const step = g.nextStepTo(f, from, rally);
  if (!step) return false;
  const garr = g.province(from).garrison;
  const n = combatants(garr) - garr.galley - garrisonToLeave(g, f, from);
  return n > 0 && g.actMove(f, from, step, n, true);
}

/** March an interior stack one step toward the border. */
function tryMoveToFront(g: Game, f: FactionId): boolean {
  const border = new Set(g.borderOf(f));
  for (const pid of g.ownedProvinces(f)) {
    if (border.has(pid) || g.isBesieged(pid)) continue;
    const garr = g.province(pid).garrison;
    if (combatants(garr) - garr.galley + garr.siegeEngine < 2) continue;
    const step = g.nextStepToward(f, pid);
    if (step && g.actMove(f, pid, step, combatants(garr), true)) return true;
  }
  return false;
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

function tryWallUpgrade(g: Game, f: FactionId, goldReserve: number): boolean {
  const fs = g.faction(f);
  const w = CONFIG.buildings.wallUpgrade;
  if (fs.gold < w.goldCost + goldReserve || fs.timber < w.timberCost || fs.marble < w.marbleCost) return false;
  const spots = g
    .borderOf(f)
    .filter((pid) => g.province(pid).wallTier < CONFIG.walls.maxBuildableTier && !g.isBesieged(pid))
    .sort((a, b) => targetValue(g, f, b) - targetValue(g, f, a));
  return spots.length > 0 && g.actBuild(f, spots[0], 'wallUpgrade');
}

/** Buy the Great Bombard when Constantinople is a realistic target. */
function tryBuyBombard(g: Game, f: FactionId, goldReserve: number): boolean {
  const gb = CONFIG.siege.greatBombard;
  if (!g.bombardForged) return false; // E3: the omen is a per-game seeded draw (rounds 11-16), not a fixed round
  const fs = g.faction(f);
  if (fs.hasGreatBombard || fs.gold < gb.goldCost + goldReserve) return false;
  const cple = g.province('constantinople');
  if (cple.owner === f) return false;
  // worthwhile if we besiege it, border it, or besiege any walled city
  if (g.siegeAt('constantinople')?.attacker === f) return g.actBuyBombard(f);
  let useful = false;
  for (const pid of g.ownedProvinces(f)) {
    const s = g.siegeAt(pid);
    if (s && s.attacker === f) useful = true;
    for (const r of g.reachableFrom(pid)) {
      const t = g.province(r.to);
      if (t.owner !== f && t.wallTier >= 2) useful = true;
    }
    if (useful) break;
  }
  for (const s of ['constantinople'] as const) {
    const siege = g.siegeAt(s);
    if (siege && siege.attacker === f) useful = true;
  }
  return useful && g.actBuyBombard(f);
}

/** Keep a small fleet at the best port (traders protect their routes). */
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

/** Total fielded power of a faction (for "hit the weakened player"). */
function factionPower(g: Game, f: FactionId): number {
  let pw = 0;
  for (const pid of g.ownedProvinces(f)) pw += armyPower(g.province(pid).garrison);
  return pw;
}

// ---------------------------------------------------------------- policies

function rusherTurn(g: Game, f: FactionId): void {
  while (g.actionsLeft > 0) {
    if (tryBuyBombard(g, f, 5)) continue;
    if (tryRelief(g, f)) continue;
    if (tryDefend(g, f, 1.0)) continue; // keep the core intact before pressing on
    if (tryAttack(g, f, { minRatio: 1.4, walledRatio: 2.0, players: 'any' })) continue;
    if (tryRecruitMilitary(g, f, true)) continue;
    if (tryConsolidate(g, f)) continue;
    if (tryMoveToFront(g, f)) continue;
    if (tryOpenRoute(g, f)) continue; // idle actions: free prestige/income
    g.actPass(f);
  }
}

function traderTurn(g: Game, f: FactionId): void {
  const atWar = g.warsOf(f).length > 0;
  while (g.actionsLeft > 0) {
    if (tryRelief(g, f)) continue;
    if (atWar && tryDefend(g, f, 1.2)) continue;
    if (tryOpenRoute(g, f)) continue;
    if (tryMarket(g, f, 8)) continue;
    if (tryRecruitGalleys(g, f, 3 + g.faction(f).routes.length, 10)) continue;
    if (tryDefend(g, f, 1.1)) continue;
    // counterattack in wars we are in; otherwise only trivially-weak neutrals
    if (atWar && tryAttack(g, f, { minRatio: 1.8, walledRatio: 2.5, players: 'warOnly' })) continue;
    if (tryAttack(g, f, { minRatio: 2.5, walledRatio: 3.5, players: 'none' })) continue;
    if (g.round >= 7 && tryGreatWork(g, f, 10)) continue;
    if (combatantsOf(g, f) < 2 * g.ownedProvinces(f).length && tryRecruitMilitary(g, f, false)) continue;
    g.actPass(f);
  }
}

function turtlerTurn(g: Game, f: FactionId): void {
  while (g.actionsLeft > 0) {
    if (tryRelief(g, f)) continue;
    if (tryDefend(g, f, 1.2)) continue;
    if (g.round >= 5 && tryGreatWork(g, f, 8)) continue;
    if (tryMarket(g, f, 12)) continue;
    if (tryOpenRoute(g, f)) continue;
    if (tryWallUpgrade(g, f, 10)) continue;
    if (g.round <= 6 && tryAttack(g, f, { minRatio: 2.5, walledRatio: 4.0, players: 'none' })) continue;
    if (combatantsOf(g, f) < 2.5 * g.ownedProvinces(f).length && tryRecruitMilitary(g, f, false)) continue;
    g.actPass(f);
  }
}

function opportunistTurn(g: Game, f: FactionId): void {
  const fs = g.faction(f);
  // weakest surviving rival (by fielded power) is fair game at lower odds
  let weakest: FactionId | null = null;
  let weakestPw = Infinity;
  for (const other of ['byzantium', 'ottomans', 'venice', 'genoa', 'hungary'] as FactionId[]) {
    if (other === f || !g.faction(other).alive) continue;
    const pw = factionPower(g, other);
    if (pw < weakestPw) {
      weakestPw = pw;
      weakest = other;
    }
  }
  while (g.actionsLeft > 0) {
    if (tryRelief(g, f)) continue;
    // snipe secret objective provinces
    if (!fs.objective.done && g.round <= fs.objective.deadline &&
        tryAttack(g, f, { minRatio: 1.5, walledRatio: 2.2, players: 'any', onlyTargets: fs.objective.provinces })) continue;
    if (tryBuyBombard(g, f, 12)) continue;
    // hit the weakened player harder, everyone else at safer odds
    if (weakest && myProvincesBorder(g, f, weakest) &&
        tryAttack(g, f, { minRatio: 1.4, walledRatio: 1.8, players: 'any', onlyTargets: g.ownedProvinces(weakest) })) continue;
    if (tryAttack(g, f, { minRatio: 1.8, walledRatio: 2.4, players: 'any' })) continue;
    if (g.estGoldIncome(f) < 14 && (tryMarket(g, f, 10) || tryOpenRoute(g, f))) continue;
    if (tryDefend(g, f, 1.1)) continue;
    if (g.round >= 8 && tryGreatWork(g, f, 15)) continue;
    if (tryRecruitMilitary(g, f, true)) continue;
    if (tryConsolidate(g, f)) continue;
    if (tryMoveToFront(g, f)) continue;
    g.actPass(f);
  }
}

function combatantsOf(g: Game, f: FactionId): number {
  let n = 0;
  for (const pid of g.ownedProvinces(f)) n += combatants(g.province(pid).garrison);
  return n;
}

function myProvincesBorder(g: Game, f: FactionId, other: FactionId): boolean {
  for (const pid of g.ownedProvinces(f)) {
    for (const r of g.reachableFrom(pid)) {
      if (g.province(r.to).owner === other) return true;
    }
  }
  return false;
}

// ----------------------------------------------------------------- factory

const TURNS: Record<PolicyName, (g: Game, f: FactionId) => void> = {
  rusher: rusherTurn,
  trader: traderTurn,
  turtler: turtlerTurn,
  opportunist: opportunistTurn,
};

export function makeAgent(name: PolicyName): Agent {
  return {
    name,
    siege: SIEGE_PREFS[name],
    takeTurn: (game, faction) => TURNS[name](game, faction),
  };
}
