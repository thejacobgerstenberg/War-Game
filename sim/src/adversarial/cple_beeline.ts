/**
 * ADVERSARIAL: Constantinople beeline policy ("cple-beeline" hunter).
 *
 * A dedicated agent that ignores normal development and races to trigger the
 * sudden-death win (hold Constantinople 2 consecutive round-ends). It uses
 * ONLY the public legal-action API of game.ts — no engine edits.
 *
 * Ottoman overland line:
 *   R1  order 1 siege engine + professionals at Edirne, top off with instant
 *       mercenaries, attack Constantinople the moment the stack is big enough
 *       (usually round 1-2) => siege established, Byzantium's capital yields
 *       freeze and its garrison can no longer recruit or move.
 *   R2+ order the remaining engines (cap 3) and ferry them into the camp
 *       (attacking one's own siege merges immediately), ship 2 galleys from
 *       Gallipoli via sea reinforcement (escort galleys join the siege army;
 *       2 galleys >= Constantinople's 2 coasts => "fully blockaded" =>
 *       garrison attrition doubles to 12%/round and the Golden Horn resupply
 *       halving is bypassed), march idle home garrisons to Edirne and pump
 *       them in. Fighter recruiting is grain-gated so the economy never
 *       collapses; engines are exempt (they are the win condition).
 *   The engine's own per-siege-round assault check (SiegePrefs) fires once
 *       the 3 engines have battered the Theodosian walls low enough.
 *
 * Amphibious variant (Genoa from Caffa/Lesbos; Venice staging via Salonica):
 * sea attacks carry ceil(land/2) escort galleys straight into the siege camp,
 * so the blockade is automatic from siege round 1.
 */

import type { FactionId } from '../types';
import { CONFIG } from '../rules';
import { combatants } from '../combat';
import { PROVINCE_BY_ID } from '../map';
import { unitGoldCost, type Agent, type Game, type SiegePrefs } from '../game';

export const TARGET = 'constantinople';

export interface BeelineTelemetry {
  /** game.round when the agent first saw itself owning the target at turn start. */
  firstOwnedSeenRound: number | null;
  /** game.round when its own siege of the target was first seen at turn start. */
  siegeSeenRound: number | null;
}

export function freshTelemetry(): BeelineTelemetry {
  return { firstOwnedSeenRound: null, siegeSeenRound: null };
}

export interface BeelineOptions {
  /** Intermediate objective when the target is unreachable from any owned
   *  province (Venice needs an Aegean-North staging port first). */
  staging?: string | null;
  /** Minimum fighters massed at the launch province before attacking. */
  launchMin?: number;
  /** From this round, launch with whatever is on hand (>= 5 fighters). */
  launchBy?: number;
  /** Prefer instant mercenaries or cheap professionals when raising troops. */
  recruitStyle?: 'merc' | 'prof';
  siegePrefs?: Partial<SiegePrefs>;
}

// ---------------------------------------------------------------- helpers

function fighters(a: { levy: number; professional: number; mercenary: number }): number {
  return a.levy + a.professional + a.mercenary;
}

function wageNextRound(g: Game, f: FactionId): number {
  let mercs = 0;
  let galleys = 0;
  for (const pid of g.ownedProvinces(f)) {
    const a = g.province(pid).garrison;
    mercs += a.mercenary;
    galleys += a.galley;
  }
  for (const pid of [TARGET]) {
    const s = g.siegeAt(pid);
    if (s && s.attacker === f) {
      mercs += s.army.mercenary;
      galleys += s.army.galley;
    }
  }
  return mercs * CONFIG.units.mercenary.goldUpkeep + galleys * CONFIG.units.galley.goldUpkeep;
}

/** Gold spendable now without risking merc/galley desertion at next upkeep. */
function spendable(g: Game, f: FactionId): number {
  const reserve = Math.max(0, wageNextRound(g, f) - g.estGoldIncome(f)) + 4;
  return g.faction(f).gold - reserve;
}

/** Owned, unbesieged provinces that reach `target` in one action, by mode. */
function sources(g: Game, f: FactionId, target: string): { land: string[]; sea: string[] } {
  const land: string[] = [];
  const sea: string[] = [];
  for (const pid of g.ownedProvinces(f)) {
    if (g.isBesieged(pid)) continue;
    for (const r of g.reachableFrom(pid)) {
      if (r.to !== target) continue;
      (r.sea ? sea : land).push(pid);
    }
  }
  return { land, sea };
}

function bestBy(ids: string[], score: (pid: string) => number): string | null {
  let best: string | null = null;
  let bestS = -Infinity;
  for (const pid of ids) {
    const s = score(pid);
    if (s > bestS) {
      bestS = s;
      best = pid;
    }
  }
  return best;
}

function tryOpenRoute(g: Game, f: FactionId): boolean {
  const cands = g.routeCandidates(f);
  return cands.length > 0 && g.actOpenRoute(f, cands[0].id);
}

// ------------------------------------------------------------------ agent

export function makeBeelineAgent(
  faction: FactionId,
  opts: BeelineOptions = {},
  tel?: BeelineTelemetry,
): Agent {
  const launchMin = opts.launchMin ?? 8;
  const launchBy = opts.launchBy ?? 2;
  const style = opts.recruitStyle ?? 'prof';
  const prefs: SiegePrefs = {
    assaultWallThreshold: 1.3,
    assaultGarrisonMax: 2,
    strengthRatio: 1.5,
    desperationRound: 12,
    ...opts.siegePrefs,
  };
  let enginesOrdered = 0; // lifetime engine orders (pendings are invisible)

  /** Gold to hold back for outstanding siege-engine orders (the win clock). */
  function engineReserve(g: Game, f: FactionId): number {
    return enginesOrdered < CONFIG.siege.maxEffectiveEngines ? unitGoldCost(f, 'siegeEngine') : 0;
  }

  /** Recruit fighters at pid honoring grain headroom; mercs also wage-gated. */
  function recruitFighters(g: Game, f: FactionId, pid: string, allowMerc: boolean): boolean {
    // strict grain gate: sustained income must cover the bigger army, so the
    // treasury is not bled dry buying grain (engines need the gold).
    if (g.estGrainIncome(f) - g.grainNeedOf(f) < 1) return false;
    const sp = spendable(g, f) - engineReserve(g, f);
    const order: Array<'merc' | 'prof'> = style === 'merc' ? ['merc', 'prof'] : ['prof', 'merc'];
    for (const o of order) {
      if (o === 'merc') {
        if (!allowMerc) continue;
        if (sp >= unitGoldCost(f, 'mercenary') && g.actRecruit(f, pid, 'mercenary', 3)) return true;
      } else {
        if (sp >= unitGoldCost(f, 'professional') && g.actRecruit(f, pid, 'professional', 2)) return true;
      }
    }
    if (f === 'hungary' && sp >= unitGoldCost(f, 'levy') && g.actRecruit(f, pid, 'levy', 6)) return true;
    return false;
  }

  /** March the biggest idle interior stack one step toward `to` (rally). */
  function marchToward(g: Game, f: FactionId, to: string): boolean {
    let from = '';
    let bestSpare = 0;
    for (const pid of g.ownedProvinces(f)) {
      if (pid === to || g.isBesieged(pid)) continue;
      const garr = g.province(pid).garrison;
      const spare = fighters(garr) - 1;
      if (spare > bestSpare && g.nextStepTo(f, pid, to)) {
        bestSpare = spare;
        from = pid;
      }
    }
    if (!from) return false;
    const step = g.nextStepTo(f, from, to)!;
    const garr = g.province(from).garrison;
    return g.actMove(f, from, step, fighters(garr) - 1, garr.siegeEngine > 0);
  }

  function takeTurn(g: Game, f: FactionId): void {
    if (tel) {
      const owner = g.province(TARGET).owner;
      if (owner === f && tel.firstOwnedSeenRound === null) tel.firstOwnedSeenRound = g.round;
      const s0 = g.siegeAt(TARGET);
      if (s0 && s0.attacker === f && tel.siegeSeenRound === null) tel.siegeSeenRound = g.round;
    }
    let guard = 0;
    while (g.actionsLeft > 0 && guard++ < 40) {
      if (step(g, f)) continue;
      g.actPass(f);
    }
    while (g.actionsLeft > 0) g.actPass(f);
  }

  /** One action; returns false to pass. */
  function step(g: Game, f: FactionId): boolean {
    const tp = g.province(TARGET);
    const siege = g.siegeAt(TARGET);

    // ---- HOLD phase: we own Constantinople; sit tight for 2 round-ends.
    if (tp.owner === f) {
      if (!g.isBesieged(TARGET)) {
        const sp = spendable(g, f);
        if (sp >= unitGoldCost(f, 'mercenary') && g.actRecruit(f, TARGET, 'mercenary', 3)) return true;
        if (sp >= unitGoldCost(f, 'professional') && g.actRecruit(f, TARGET, 'professional', 2)) return true;
      }
      if (tryOpenRoute(g, f)) return true;
      return false;
    }

    // ---- Rival (non-Byzantine) siege on the target: build up nearby, wait.
    if (siege && siege.attacker !== f) {
      const near = sources(g, f, TARGET);
      const pid = bestBy([...near.land, ...near.sea], (x) => fighters(g.province(x).garrison));
      if (pid && recruitFighters(g, f, pid, true)) return true;
      if (tryOpenRoute(g, f)) return true;
      return false;
    }

    // ---- Objective: the target, or the staging city on the way to it.
    let objective = TARGET;
    let objSiege = siege;
    if (!siege) {
      const direct = sources(g, f, TARGET);
      if (direct.land.length === 0 && direct.sea.length === 0 && opts.staging) {
        const st = g.province(opts.staging);
        if (st.owner !== f) {
          objective = opts.staging;
          const s2 = g.siegeAt(opts.staging);
          objSiege = s2 && s2.attacker === f ? s2 : null;
        }
      }
    }

    const src = sources(g, f, objective);

    // ---- FEED an existing siege of ours.
    if (objSiege && objSiege.attacker === f) {
      const army = objSiege.army;
      const coasts = PROVINCE_BY_ID.get(objective)!.coasts.length;
      const maxEng = CONFIG.siege.maxEffectiveEngines;

      // 1. late siege: buy the Great Bombard.
      if (
        g.round >= CONFIG.siege.greatBombard.availableFromRound &&
        !g.faction(f).hasGreatBombard &&
        g.faction(f).gold >= CONFIG.siege.greatBombard.goldCost + 4 &&
        g.actBuyBombard(f)
      ) return true;

      // 2. ferry engines waiting at any source into the camp.
      if (army.siegeEngine < maxEng) {
        for (const pid of src.land) {
          const garr = g.province(pid).garrison;
          if (garr.siegeEngine > 0 && fighters(garr) >= 1) {
            const n = Math.max(1, fighters(garr) - 1);
            if (g.actAttack(f, pid, objective, n, garr.siegeEngine)) return true;
          }
        }
        for (const pid of src.sea) {
          const garr = g.province(pid).garrison;
          if (garr.siegeEngine > 0 && fighters(garr) >= 1) {
            const landN = Math.min(fighters(garr), 3);
            if (garr.galley >= Math.ceil((landN + garr.siegeEngine) / 2) &&
                g.actAttack(f, pid, objective, landN, garr.siegeEngine)) return true;
          }
        }
      }

      // 3. order engines (up to 3 lifetime) at the strongest source.
      if (enginesOrdered < maxEng && army.siegeEngine < maxEng) {
        const where =
          bestBy(src.land, (pid) => fighters(g.province(pid).garrison)) ??
          bestBy(src.sea, (pid) => fighters(g.province(pid).garrison));
        if (where) {
          if (spendable(g, f) >= unitGoldCost(f, 'siegeEngine') && g.actRecruit(f, where, 'siegeEngine', 1)) {
            enginesOrdered++;
            return true;
          }
          // keep a ferryman at the engine yard
          if (fighters(g.province(where).garrison) < 2 && g.grainHeadroom(f) >= 1 &&
              spendable(g, f) >= unitGoldCost(f, 'levy') && g.actRecruit(f, where, 'levy', 2)) return true;
        }
      }

      // 4. blockade: deliver >= coasts escort galleys via sea reinforcement.
      if (coasts > 0 && army.galley < coasts) {
        for (const pid of src.sea) {
          const garr = g.province(pid).garrison;
          const landN = Math.min(fighters(garr), 2 * coasts);
          if (landN >= Math.max(1, 2 * coasts - 1) && garr.galley >= Math.ceil(landN / 2)) {
            if (g.actAttack(f, pid, objective, landN, 0)) return true;
          }
        }
        const port = bestBy(src.sea, (pid) => g.province(pid).garrison.galley);
        if (port) {
          const garr = g.province(port).garrison;
          if (garr.galley < coasts && spendable(g, f) >= CONFIG.units.galley.goldCost &&
              g.actRecruit(f, port, 'galley', 2)) return true;
          if (fighters(garr) < Math.max(1, 2 * coasts - 1) && recruitFighters(g, f, port, true)) return true;
        }
      }

      // 5. troop pump: keep the camp strong enough to assault.
      const want = Math.max(12, 2 * combatants(g.province(objective).garrison) + 4);
      if (combatants(army) < want) {
        // 5a. throw adjacent spare fighters in (land first, then sea).
        const pumpL = bestBy(src.land, (pid) => fighters(g.province(pid).garrison));
        if (pumpL) {
          const garr = g.province(pumpL).garrison;
          const spare = fighters(garr) - 1;
          if (spare >= 3 && g.actAttack(f, pumpL, objective, spare, 0)) return true;
        }
        const pumpS = bestBy(src.sea, (pid) => fighters(g.province(pid).garrison));
        if (pumpS) {
          const garr = g.province(pumpS).garrison;
          const spare = fighters(garr) - 1;
          if (spare >= 3 && garr.galley >= Math.ceil(spare / 2) &&
              g.actAttack(f, pumpS, objective, spare, 0)) return true;
        }
        // 5b. march idle interior garrisons toward the main source.
        const rally = pumpL ?? pumpS;
        if (rally && marchToward(g, f, rally)) return true;
        // 5c. recruit fresh fighters at the source (grain-gated).
        if (rally && recruitFighters(g, f, rally, true)) return true;
      }

      if (tryOpenRoute(g, f)) return true;
      return false;
    }

    // ---- LAUNCH phase: no siege yet — mass at a source and attack.
    if (src.land.length > 0) {
      const from = bestBy(src.land, (pid) => fighters(g.province(pid).garrison))!;
      const garr = g.province(from).garrison;
      const n = fighters(garr);
      const lastChance = g.actionsLeft === 1 && g.round >= launchBy && n >= 5;
      if (n >= launchMin || lastChance) {
        if (g.actAttack(f, from, objective, n, garr.siegeEngine)) return true;
      }
      if (enginesOrdered < 2 && spendable(g, f) >= unitGoldCost(f, 'siegeEngine') &&
          g.actRecruit(f, from, 'siegeEngine', 1)) {
        enginesOrdered++;
        return true;
      }
      if (recruitFighters(g, f, from, true)) return true;
      if (marchToward(g, f, from)) return true;
      if (tryOpenRoute(g, f)) return true;
      return false;
    }
    if (src.sea.length > 0) {
      const from = bestBy(src.sea, (pid) => 2 * fighters(g.province(pid).garrison) + g.province(pid).garrison.galley)!;
      const garr = g.province(from).garrison;
      const n = fighters(garr);
      const enough = garr.galley >= Math.ceil(n / 2);
      const lastChance = g.actionsLeft === 1 && g.round >= launchBy + 1 && n >= 5;
      if ((n >= launchMin || lastChance) && enough) {
        if (g.actAttack(f, from, objective, n, garr.siegeEngine)) return true;
      }
      if (garr.galley < Math.ceil(Math.max(n, launchMin) / 2) &&
          spendable(g, f) >= CONFIG.units.galley.goldCost && g.actRecruit(f, from, 'galley', 2)) return true;
      if (n < launchMin && recruitFighters(g, f, from, true)) return true;
      if (marchToward(g, f, from)) return true;
      if (tryOpenRoute(g, f)) return true;
      return false;
    }

    // Nothing reachable (staging lost / landlocked): idle usefully.
    if (tryOpenRoute(g, f)) return true;
    return false;
  }

  void faction;
  return { name: 'rusher', siege: prefs, takeTurn };
}
