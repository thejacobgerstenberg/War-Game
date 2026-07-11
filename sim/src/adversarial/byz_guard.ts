/**
 * ADVERSARIAL DIAGNOSTIC: a dedicated Byzantine DEFENDER for the
 * Constantinople sudden-death hunt.
 *
 * The tuning log dismisses the beeline's 70%+ sudden-death rate as an
 * "agent limitation" (standard policies strip the capital garrison). This
 * agent is the counterfactual: it plays Byzantium purely to deny the
 * sudden-death win, using only the public legal-action API:
 *
 *   - While Constantinople is owned and NOT yet besieged, it stuffs the
 *     garrison with levies (cheap starvation-clock soak: every levy inside
 *     the walls is one more siege round) and Varangians (CV def 4).
 *     Recruits ordered the round the siege lands still muster at cleanup.
 *   - While besieged, it builds a relief army in Mesembria (the only
 *     land-adjacent Byzantine province) and attacks the siege camp when it
 *     has the numbers advantage (a relief win deletes the siege and the
 *     relief force enters the city).
 *   - It never attacks out of Constantinople and never consolidates the
 *     capital garrison away.
 *
 * If the beeline still completes early sudden deaths against THIS agent,
 * the hole is in the rules numbers, not the agents.
 */

import type { FactionId, UnitType } from '../types';
import { CONFIG, statsFor } from '../rules';
import { combatants } from '../combat';
import { armyPower, unitGoldCost, type Agent, type Game } from '../game';

const CPLE = 'constantinople';
const RELIEF_BASE = 'mesembria';

/** Grain-aware recruit of up to one action's worth of `unit` at pid. */
function recruit(g: Game, f: FactionId, pid: string, unit: UnitType): boolean {
  const st = statsFor(f, unit);
  let cap = CONFIG.recruit.perAction[unit] + (unit === 'levy' ? CONFIG.factions[f].levyRecruitBonus : 0);
  if (st.grainUpkeep > 0) {
    // allow dipping 1 into headroom — the engine buys shortfall grain with gold
    cap = Math.min(cap, Math.floor(g.grainHeadroom(f) / st.grainUpkeep + 1));
  }
  const cost = unitGoldCost(f, unit);
  if (cost > 0) cap = Math.min(cap, Math.floor((g.faction(f).gold - g.goldNeedOf(f)) / cost));
  return cap >= 1 && g.actRecruit(f, pid, unit, cap);
}

function stockGarrison(g: Game, f: FactionId, pid: string, targetSize: number): boolean {
  const p = g.province(pid);
  if (p.owner !== f || (g.isBesieged(pid) && !g.harborOpen(pid))) return false;
  const n = combatants(p.garrison);
  if (n >= targetSize) return false;
  // levies first (cheap soak), Varangians once there is a levy cushion
  if (p.garrison.levy < 8 && recruit(g, f, pid, 'levy')) return true;
  if (recruit(g, f, pid, 'professional')) return true;
  return recruit(g, f, pid, 'levy');
}

function tryOpenRoute(g: Game, f: FactionId): boolean {
  const cands = g.routeCandidates(f);
  return cands.length > 0 && g.actOpenRoute(f, cands[0].id);
}

export function makeByzGuardAgent(): Agent {
  function takeTurn(g: Game, f: FactionId): void {
    let guard = 0;
    while (g.actionsLeft > 0 && guard++ < 40) {
      if (step(g, f)) continue;
      g.actPass(f);
    }
    while (g.actionsLeft > 0) g.actPass(f);
  }

  function step(g: Game, f: FactionId): boolean {
    const cple = g.province(CPLE);
    const siege = g.siegeAt(CPLE);

    // 1. capital lost: try to take it back with everything Mesembria has.
    if (cple.owner !== f) {
      const m = g.province(RELIEF_BASE);
      if (m.owner === f && !g.isBesieged(RELIEF_BASE)) {
        const n = combatants(m.garrison) - m.garrison.galley;
        if (n >= 6 && n >= 1.2 * combatants(cple.garrison) &&
            g.actAttack(f, RELIEF_BASE, CPLE, n, m.garrison.siegeEngine)) return true;
        if (stockGarrison(g, f, RELIEF_BASE, 14)) return true;
      }
      if (tryOpenRoute(g, f)) return true;
      return false;
    }

    // 2. besieged: reinforce through the open harbor (canon §8.2.3 sea
    //    resupply — recruit inside + ferry from sea-adjacent ports), keep a
    //    relief force at Mesembria, hit the camp with an edge.
    if (siege) {
      if (g.harborOpen(CPLE)) {
        if (stockGarrison(g, f, CPLE, 16)) return true;
        // ferry spare fighters in from any sea-adjacent owned port
        for (const r of g.reachableFrom(CPLE)) {
          if (!r.sea) continue;
          const q = g.province(r.to);
          if (q.owner !== f || g.isBesieged(r.to)) continue;
          const spare = combatants(q.garrison) - q.garrison.galley - 1;
          const n = Math.min(spare, 2 * q.garrison.galley);
          if (n >= 2 && g.actMove(f, r.to, CPLE, n)) return true;
        }
      }
      const m = g.province(RELIEF_BASE);
      if (m.owner === f && !g.isBesieged(RELIEF_BASE)) {
        const my = m.garrison;
        const n = combatants(my) - my.galley;
        if (n >= 5 && armyPower(my) >= 1.15 * armyPower(siege.army) &&
            g.actAttack(f, RELIEF_BASE, CPLE, n, 0)) return true;
        if (stockGarrison(g, f, RELIEF_BASE, 16)) return true;
      }
      if (tryOpenRoute(g, f)) return true;
      return false;
    }

    // 3. peace (or the round the siege lands — pending recruits still
    //    muster): stuff the capital, then the relief base.
    if (stockGarrison(g, f, CPLE, 14)) return true;
    if (stockGarrison(g, f, RELIEF_BASE, 8)) return true;
    if (tryOpenRoute(g, f)) return true;
    return false;
  }

  return {
    name: 'turtler',
    siege: { assaultWallThreshold: 0.75, assaultGarrisonMax: 2, strengthRatio: 1.6, desperationRound: 15 },
    takeTurn,
  };
}
