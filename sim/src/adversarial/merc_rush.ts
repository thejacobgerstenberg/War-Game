/**
 * ADVERSARIAL policy "merc-rush" (exploit hunter, not a shipping agent).
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
 *  - 'cycle'  : spends EVERY gold coin on new mercenaries each round. Wages
 *               come due at next round's upkeep before actions; whatever the
 *               treasury cannot cover deserts unpaid (100%). This is the
 *               "hire for one battle, stiff them, repeat" abuse — the engine
 *               cannot refuse payment while gold exists, so the only way to
 *               cycle is to be broke at upkeep, which this variant guarantees.
 *  - 'honest' : identical, but before hiring it reserves next round's full
 *               mercenary wage bill (net of estimated gold income) so hired
 *               mercs are actually paid and retained.
 *
 * Everything here goes through the public Game action/read API. Helper
 * heuristics (tryAttack / tryRelief / consolidation) are copied from
 * sim/src/agents.ts because that module does not export them; no shared file
 * is modified.
 */

import type { FactionId } from '../types';
import { FACTION_IDS } from '../types';
import { CONFIG } from '../rules';
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

/** Total mercenaries this faction currently pays (garrisons + siege camps). */
function totalMercs(g: Game, f: FactionId): number {
  let n = 0;
  for (const pid of g.ownedProvinces(f)) n += g.province(pid).garrison.mercenary;
  for (const p of PROVINCES) {
    const s = g.siegeAt(p.id);
    if (s && s.attacker === f) n += s.army.mercenary;
  }
  return n;
}

/**
 * Hire mercenaries at the staging province.
 * cycle : hire as many as gold allows (up to per-action cap) — leaves the
 *         treasury empty by design so surplus mercs desert unpaid next upkeep.
 * honest: hire only what next round's wage bill (net of estimated income)
 *         still lets us pay.
 */
function tryRecruitMercs(g: Game, f: FactionId, honest: boolean): boolean {
  const fs = g.faction(f);
  const cost = unitGoldCost(f, 'mercenary');
  const cap = CONFIG.recruit.perAction.mercenary;
  let n = Math.min(cap, Math.floor(fs.gold / cost));
  if (n <= 0) return false;
  if (honest) {
    const wage = CONFIG.units.mercenary.goldUpkeep;
    const income = g.estGoldIncome(f);
    const mercs = totalMercs(g, f);
    while (n > 0) {
      const reserveNeeded = Math.max(0, wage * (mercs + n) - income);
      if (fs.gold - n * cost >= reserveNeeded) break;
      n--;
    }
    if (n <= 0) return false;
  }
  const where = stagingProvince(g, f);
  if (!where) return false;
  return g.actRecruit(f, where, 'mercenary', n);
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

function mercRushTurn(g: Game, f: FactionId, honest: boolean): void {
  while (g.actionsLeft > 0) {
    if (tryRelief(g, f)) continue;
    if (tryBuyBombard(g, f, 5)) continue;
    if (g.round <= 3) {
      // all-in opening: hire first (instant), strike with whatever action is left
      if (tryRecruitMercs(g, f, honest)) continue;
      if (tryAttack(g, f, ATTACK_OPTS)) continue;
    } else {
      if (tryAttack(g, f, ATTACK_OPTS)) continue;
      if (tryRecruitEngine(g, f)) continue;
      if (tryRecruitMercs(g, f, honest)) continue;
    }
    if (tryConsolidate(g, f)) continue;
    if (tryMoveToFront(g, f)) continue;
    if (tryOpenRoute(g, f)) continue;
    g.actPass(f);
  }
}

export function makeMercRushAgent(variant: MercVariant): Agent {
  return {
    // the engine only reads .siege from the agent besides takeTurn; the name
    // field is typed as PolicyName, so reuse 'rusher' (closest shipping label)
    name: 'rusher',
    siege: MERC_SIEGE_PREFS,
    takeTurn: (game, faction) => mercRushTurn(game, faction, variant === 'honest'),
  };
}
