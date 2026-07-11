/**
 * ADVERSARIAL policy "merc-rush" (exploit hunter, not a shipping agent).
 * Updated for the FINAL canon-rules config (commit 3d9ff32 retune):
 * mercenaries are CV 3/2 cavalry hired at x1.5 gold (9g; Genoa surcharge
 * WAIVED -> 6g), 0 grain to raise, INSTANT muster, x2 grain upkeep (4/round),
 * goldUpkeep 0. Desertion is grain-driven: at upkeep the engine force-buys
 * missing grain at 2g/grain from whatever gold is left, then unfed units
 * desert (mercenaries FIRST, 1 merc per 4 grain of shortfall — i.e. every
 * unfed merc walks).
 *
 * Degenerate all-in mercenary opening:
 *  - Rounds 1-3: every action recruits maximum mercenaries (instant muster)
 *    at the biggest border stack; leftover actions attack immediately with
 *    the freshly-hired muscle (mercs fight the same round they are hired).
 *  - Round 4+: attack continuously at aggressive odds, topping up with more
 *    mercenaries whenever gold allows; buys siege engines only when a walled
 *    target is adjacent, and the Great Bombard when available.
 *
 * Two variants answer the merc-cycling question:
 *  - 'cycle'  : spends EVERY gold coin on new mercenaries each round. The
 *               engine cannot be stiffed while solvent (it force-buys grain
 *               at upkeep before letting anyone starve), so the only way to
 *               cycle is to be broke at upkeep — this variant guarantees it:
 *               hire for one battle, let the surplus starve out unpaid,
 *               rehire from fresh income. Mercs raised this way cost ~9g
 *               (6g Genoa) per round of service instead of 9g + 4 grain/rnd.
 *  - 'honest' : identical, but before hiring it reserves enough resources
 *               (grain on hand + grain income + gold at the 2g/grain forced-
 *               market rate) to actually FEED the whole merc roster next
 *               upkeep, so hired mercs are retained.
 *
 * Everything here goes through the public Game action/read API. Helper
 * heuristics (tryAttack / tryRelief / consolidation) are copied from
 * sim/src/agents.ts because that module does not export them; no shared file
 * is modified.
 */

import type { FactionId } from '../types';
import { FACTION_IDS } from '../types';
import { CONFIG, statsFor } from '../rules';
import { combatants } from '../combat';
import { PROVINCE_BY_ID, PROVINCES } from '../map';
import {
  armyPower,
  CAPITALS,
  unitGoldCost,
  type Agent,
  type Game,
  type SiegePrefs,
} from '../game';

export type MercVariant = 'cycle' | 'honest';

/** Per-game telemetry the runner can inspect (reset each game). */
export interface MercCounters {
  hired: number; // mercenaries recruited over the game
  peakMercs: number; // max merc roster observed at any of our turn starts
}

export function newMercCounters(): MercCounters {
  return { hired: 0, peakMercs: 0 };
}

// Aggressive siege behavior (same numbers as the shipping rusher policy).
const MERC_SIEGE_PREFS: SiegePrefs = {
  assaultWallThreshold: 1.5,
  assaultGarrisonMax: 3,
  strengthRatio: 1.2,
  desperationRound: 13,
};

// ---------------------------------------------------------------------------
// Helpers copied (minimal glue) from sim/src/agents.ts — unexported there.
// ---------------------------------------------------------------------------

function targetValue(g: Game, f: FactionId, pid: string): number {
  const prov = PROVINCE_BY_ID.get(pid)!;
  let v =
    prov.yields.gold +
    0.5 * prov.yields.grain +
    0.3 * (prov.yields.timber + prov.yields.marble + prov.yields.faith);
  if (prov.keyCity) v += 6;
  if (pid === 'constantinople') v += 5;
  const fs = g.faction(f);
  if (!fs.objective.done && g.round <= fs.objective.deadline && fs.objective.provinces.includes(pid)) v += 8;
  const owner = g.province(pid).owner;
  if (owner && owner !== f) {
    v += 1.5;
    if (owner === prestigeLeader(g, f)) v += 5;
  }
  return v;
}

function prestigeLeader(g: Game, f: FactionId): FactionId | null {
  let leader: FactionId | null = null;
  let best = 0.6 * CONFIG.prestige.victoryThreshold;
  for (const other of FACTION_IDS) {
    if (other === f || !g.faction(other).alive) continue;
    const t = g.faction(other).ledger.total;
    if (t > best) {
      best = t;
      leader = other;
    }
  }
  return leader;
}

function garrisonToLeave(g: Game, f: FactionId, pid: string): number {
  return PROVINCE_BY_ID.get(pid)!.keyCity || pid === CAPITALS[f] ? 2 : 1;
}

interface AttackOpts {
  minRatio: number;
  walledRatio: number;
  players: 'any' | 'warOnly' | 'none';
  onlyTargets?: readonly string[] | null;
  minStack?: number;
}

function tryAttack(g: Game, f: FactionId, o: AttackOpts): boolean {
  const minStack = o.minStack ?? 4;
  let bestFrom = '';
  let bestTo = '';
  let bestScore = -Infinity;
  let bestWalled = false;
  for (const from of g.ownedProvinces(f)) {
    if (g.isBesieged(from)) continue;
    const garr = g.province(from).garrison;
    const n = combatants(garr) - garr.galley;
    const leave = garrisonToLeave(g, f, from);
    if (n - leave < 3 || n + garr.galley < minStack) continue;
    const myPower = armyPower(garr);
    for (const r of g.reachableFrom(from)) {
      const t = g.province(r.to);
      if (t.owner === f) continue;
      const s = g.siegeAt(r.to);
      if (s && s.attacker !== f) continue;
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
      let feasible: boolean;
      if (s && s.attacker === f) {
        feasible = n >= 2;
      } else if (walled) {
        feasible = myPower >= o.walledRatio * (armyPower(t.garrison) + 1);
        if (g.wallBonusAt(r.to) >= 3 && !g.faction(f).hasGreatBombard) feasible = false;
      } else {
        feasible = myPower >= o.minRatio * g.defenseScore(r.to);
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

function tryConsolidate(g: Game, f: FactionId): boolean {
  const rally = rallyPoint(g, f);
  if (!rally) return false;
  let from = '';
  let bestSpare = 1;
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

function tryBuyBombard(g: Game, f: FactionId, goldReserve: number): boolean {
  const gb = CONFIG.siege.greatBombard;
  if (g.round < gb.availableFromRound) return false;
  const fs = g.faction(f);
  if (fs.hasGreatBombard || fs.gold < gb.goldCost + goldReserve) return false;
  const cple = g.province('constantinople');
  if (cple.owner === f) return false;
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
  return useful && g.actBuyBombard(f);
}

// ---------------------------------------------------------------------------
// Merc-rush specific logic
// ---------------------------------------------------------------------------

/** Border province with the biggest stack (mercs muster here, instantly). */
function stagingProvince(g: Game, f: FactionId): string | null {
  let where: string | null = null;
  let bestN = -1;
  for (const pid of g.borderOf(f)) {
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
  }
  return where;
}

/** Mercenaries this faction currently feeds (garrisons + siege camps). */
function totalMercs(g: Game, f: FactionId): number {
  let n = 0;
  for (const pid of g.ownedProvinces(f)) n += g.province(pid).garrison.mercenary;
  for (const p of PROVINCES) {
    const s = g.siegeAt(p.id);
    if (s && s.attacker === f) n += s.army.mercenary;
  }
  return n;
}

/** Grain the NON-merc part of the roster eats per round (faction tables). */
function nonMercGrainNeed(g: Game, f: FactionId): number {
  let need = 0;
  const add = (a: { levy: number; professional: number; siegeEngine: number; galley: number }) => {
    need +=
      a.levy * statsFor(f, 'levy').grainUpkeep +
      a.professional * statsFor(f, 'professional').grainUpkeep +
      a.siegeEngine * statsFor(f, 'siegeEngine').grainUpkeep +
      a.galley * statsFor(f, 'galley').grainUpkeep;
  };
  for (const pid of g.ownedProvinces(f)) add(g.province(pid).garrison);
  for (const p of PROVINCES) {
    const s = g.siegeAt(p.id);
    if (s && s.attacker === f) add(s.army);
  }
  return need;
}

/**
 * Hire mercenaries at the staging province.
 * cycle : hire as many as gold allows (up to the per-action cap of 3) — the
 *         treasury is left empty by design, so at next upkeep the engine's
 *         forced grain-buy runs out and the surplus mercs desert unfed.
 * honest: hire only what next round's grain bill can still cover, counting
 *         grain on hand, grain income, and gold convertible at the forced
 *         market rate (buyGoldPerGrain).
 */
function tryRecruitMercs(g: Game, f: FactionId, honest: boolean, counters?: MercCounters): boolean {
  const fs = g.faction(f);
  const cost = unitGoldCost(f, 'mercenary');
  const cap = CONFIG.recruit.perAction.mercenary;
  let n = Math.min(cap, Math.floor(fs.gold / cost));
  if (n <= 0) return false;
  if (honest) {
    const mercGrainEach = statsFor(f, 'mercenary').grainUpkeep;
    const buyRate = CONFIG.economy.grainMarket.buyGoldPerGrain;
    const mercs = totalMercs(g, f);
    const grainAvail = fs.grain + g.estGrainIncome(f) - nonMercGrainNeed(g, f);
    const goldIncome = g.estGoldIncome(f);
    while (n > 0) {
      const grainBill = mercGrainEach * (mercs + n);
      const deficit = Math.max(0, grainBill - grainAvail);
      const goldReserve = Math.max(0, deficit * buyRate - goldIncome);
      if (fs.gold - n * cost >= goldReserve) break;
      n--;
    }
    if (n <= 0) return false;
  }
  const where = stagingProvince(g, f);
  if (!where) return false;
  const ok = g.actRecruit(f, where, 'mercenary', n);
  if (ok && counters) counters.hired += n;
  return ok;
}

/** One siege engine when a defended walled target is adjacent (round 4+). */
function tryRecruitEngine(g: Game, f: FactionId): boolean {
  if (g.round < 4) return false;
  let engines = 0;
  for (const pid of g.ownedProvinces(f)) engines += g.province(pid).garrison.siegeEngine;
  for (const p of PROVINCES) {
    const s = g.siegeAt(p.id);
    if (s && s.attacker === f) engines += s.army.siegeEngine;
  }
  if (engines >= CONFIG.siege.maxEffectiveEngines) return false;
  const where = stagingProvince(g, f);
  if (!where) return false;
  for (const r of g.reachableFrom(where)) {
    const t = g.province(r.to);
    if (t.owner !== f && t.wallTier > 0 && combatants(t.garrison) > 0) {
      return g.actRecruit(f, where, 'siegeEngine', 1);
    }
  }
  return false;
}

const ATTACK_OPTS: AttackOpts = { minRatio: 1.3, walledRatio: 1.8, players: 'any' };

function mercRushTurn(g: Game, f: FactionId, honest: boolean, counters?: MercCounters): void {
  if (counters) counters.peakMercs = Math.max(counters.peakMercs, totalMercs(g, f));
  while (g.actionsLeft > 0) {
    if (tryRelief(g, f)) continue;
    if (tryBuyBombard(g, f, 5)) continue;
    if (g.round <= 3) {
      // all-in opening: hire first (instant), strike with whatever action is left
      if (tryRecruitMercs(g, f, honest, counters)) continue;
      if (tryAttack(g, f, ATTACK_OPTS)) continue;
    } else {
      if (tryAttack(g, f, ATTACK_OPTS)) continue;
      if (tryRecruitEngine(g, f)) continue;
      if (tryRecruitMercs(g, f, honest, counters)) continue;
    }
    if (tryConsolidate(g, f)) continue;
    if (tryMoveToFront(g, f)) continue;
    if (tryOpenRoute(g, f)) continue;
    g.actPass(f);
  }
}

export function makeMercRushAgent(variant: MercVariant, counters?: MercCounters): Agent {
  return {
    // the engine only reads .siege from the agent besides takeTurn; the name
    // field is typed as PolicyName, so reuse 'rusher' (closest shipping label)
    name: 'rusher',
    siege: MERC_SIEGE_PREFS,
    takeTurn: (game, faction) => mercRushTurn(game, faction, variant === 'honest', counters),
  };
}
