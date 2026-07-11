/**
 * ADVERSARIAL: Constantinople sudden-death beeline ("cple-beeline" hunter),
 * rebuilt for the FINAL canon-kernel config (2b42386 rules: T5 = 16 HP / +4
 * binary bonus, t5 masonry cap 1 HP/round, grain-stores starvation, R3 sea
 * resupply with per-zone galley-superiority blockade, Great Bombard r15).
 *
 * Uses ONLY the public legal-action API of game.ts — no engine edits.
 *
 * The win path under the canon kernel is NOT the walls (an ordinary train
 * cannot breach 16 HP at 1 HP/round in time) — it is the STARVATION CLOCK:
 *   1. invest Constantinople as early as possible (round 1-2);
 *   2. establish a full naval blockade (strict galley superiority in BOTH
 *      the Sea of Marmara and the West Black Sea; the defender's harbor
 *      fleet counts, so bring defenderGalleys+1 per zone — camp galleys
 *      count in every zone the city coasts, and galleys parked in an owned
 *      port that coasts a zone count too, e.g. Genoese Pera covers BOTH);
 *   3. stores (3) deplete, then the garrison starves 1 unit/round;
 *   4. escalade once the garrison is starved to <= 2, or wait for zero.
 *   Capture at cleanup R => hold R, R+1 => sudden death at round R+1.
 *
 * Faction lines:
 *   ottomans : overland from Edirne round 1 with the starting stack; feed
 *              the camp with 6-levy batches (devshirme levies cost 0 grain);
 *              deliver 2 galleys from Gallipoli by sea reinforcement.
 *   genoa    : overland from Pera (land-adjacent across the Golden Horn);
 *              cheap Crossbowmen (3g); blockade by stacking galleys in
 *              Pera's own harbor (coasts both of Constantinople's zones).
 *   venice   : amphibious with a staging hop (Lemnos: T1, 1-levy garrison,
 *              North Aegean port that sea-reaches Constantinople).
 */

import type { Army, FactionId, UnitType } from '../types';
import { CONFIG, statsFor } from '../rules';
import { combatants } from '../combat';
import { PROVINCE_BY_ID, SEA_ZONE_BY_ID } from '../map';
import { unitGoldCost, type Agent, type Game, type SiegePrefs } from '../game';

export const TARGET = 'constantinople';

// ------------------------------------------------------------- telemetry

export interface BeelineTelemetry {
  /** game.round when the agent first saw itself owning the target at turn start. */
  firstOwnedSeenRound: number | null;
  /** game.round when its own siege of the target was first seen at turn start. */
  siegeSeenRound: number | null;
  /** Garrison combatants inside the walls when our siege was first observed. */
  garrisonAtSiegeStart: number | null;
  /** Garrison combatants at the last turn-start observation while sieging. */
  lastGarrisonSeen: number | null;
  /** Wall damage at the last turn-start observation while sieging. */
  lastWallDamageSeen: number;
  /** Turn-start observations of our own target siege. */
  siegeObsRounds: number;
  /** ...of which the full naval blockade was up. */
  blockadedRounds: number;
  /** Lowest grain-stores value observed in the siege record. */
  minStoresSeen: number | null;
  /** We ever held treason-at-the-gate while besieging (engine auto-plays it). */
  treasonHeld: boolean;
}

export function freshTelemetry(): BeelineTelemetry {
  return {
    firstOwnedSeenRound: null,
    siegeSeenRound: null,
    garrisonAtSiegeStart: null,
    lastGarrisonSeen: null,
    lastWallDamageSeen: 0,
    siegeObsRounds: 0,
    blockadedRounds: 0,
    minStoresSeen: null,
    treasonHeld: false,
  };
}

export interface BeelineOptions {
  /** Intermediate objective when the target is unreachable from any owned
   *  province (Venice needs a North-Aegean staging port first). */
  staging?: string | null;
  /** Minimum fighters massed at the launch province before attacking. */
  launchMin?: number;
  /** From this round, launch with whatever is on hand (>= 4 fighters). */
  launchBy?: number;
  /** Legacy option (pre-canon-kernel agent); accepted and ignored. */
  recruitStyle?: 'merc' | 'prof';
  siegePrefs?: Partial<SiegePrefs>;
}

// ---------------------------------------------------------------- helpers

function fighters(a: Army): number {
  return a.levy + a.professional + a.mercenary;
}

/** Gold wage bill + expected grain-purchase bill to protect before spending. */
function spendable(g: Game, f: FactionId): number {
  const fs = g.faction(f);
  const grainShort = Math.max(0, g.grainNeedOf(f) - g.estGrainIncome(f) - fs.grain);
  const reserve =
    Math.max(0, g.goldNeedOf(f) + grainShort * CONFIG.economy.grainMarket.buyGoldPerGrain - g.estGoldIncome(f)) + 2;
  return fs.gold - reserve;
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

// ------------------------------------------------------ blockade arithmetic

/** Galleys `who` brings to bear on `zone` (owned coastal ports + own camps). */
function galleysNearZone(g: Game, who: FactionId, zone: string): number {
  let n = 0;
  for (const pid of SEA_ZONE_BY_ID.get(zone)!.coastalProvinces) {
    const p = g.province(pid);
    if (p.owner === who) n += p.garrison.galley;
    const s = g.siegeAt(pid);
    if (s && s.attacker === who) n += s.army.galley;
  }
  return n;
}

/** Mirror of the engine's canon-RAW blockade test (enemy fleet present AND
 *  uncontested by any friendly war fleet, in every adjacent zone). */
export function blockadeUp(g: Game, f: FactionId, pid: string): boolean {
  const prov = PROVINCE_BY_ID.get(pid)!;
  if (prov.coasts.length === 0) return true;
  const owner = g.province(pid).owner;
  for (const z of prov.coasts) {
    const friendly = owner ? galleysNearZone(g, owner, z) : 0;
    if (galleysNearZone(g, f, z) === 0 || friendly > 0) return false;
  }
  return true;
}

/**
 * Extra galleys the SIEGE CAMP would need to close every zone, or Infinity
 * when a blockade is unattainable (canon-RAW contest: any friendly galley
 * near a zone keeps it contested — the sim has no fleet battles to sink
 * it, so blockade gold is wasted while the defender's fleet floats).
 */
function blockadeDeficit(g: Game, f: FactionId, pid: string): number {
  const prov = PROVINCE_BY_ID.get(pid)!;
  const owner = g.province(pid).owner;
  let need = 0;
  for (const z of prov.coasts) {
    const friendly = owner ? galleysNearZone(g, owner, z) : 0;
    if (friendly > 0) return Infinity; // contested: cannot be closed by numbers
    need = Math.max(need, 1 - galleysNearZone(g, f, z));
  }
  return need;
}

/** Owned unbesieged ports whose harbor covers EVERY coast zone of `pid`. */
function fullCoveragePorts(g: Game, f: FactionId, pid: string): string[] {
  const want = PROVINCE_BY_ID.get(pid)!.coasts;
  const out: string[] = [];
  for (const q of g.ownedProvinces(f)) {
    if (q === pid || g.isBesieged(q)) continue;
    const coasts = PROVINCE_BY_ID.get(q)!.coasts;
    if (want.every((z) => coasts.includes(z))) out.push(q);
  }
  return out;
}

// ------------------------------------------------------------------ agent

export function makeBeelineAgent(
  faction: FactionId,
  opts: BeelineOptions = {},
  tel?: BeelineTelemetry,
): Agent {
  const launchMin = opts.launchMin ?? 5;
  const launchBy = opts.launchBy ?? 3;
  const prefs: SiegePrefs = {
    // never assault on wall damage vs T5 (the masonry cap makes a breach a
    // r16 event); assault once starvation thins the garrison to <= 2.
    assaultWallThreshold: 1.0,
    assaultGarrisonMax: 2,
    strengthRatio: 1.5,
    desperationRound: 15,
    ...opts.siegePrefs,
  };

  const levyFaction = faction === 'ottomans' || faction === 'hungary';

  /** Recruit fighters at pid; grain-gated via headroom, wage-gated via spendable. */
  function recruitFighters(g: Game, f: FactionId, pid: string): boolean {
    const sp = spendable(g, f);
    const order: UnitType[] = levyFaction ? ['levy', 'professional'] : ['professional', 'levy'];
    for (const u of order) {
      const st = statsFor(f, u);
      let cap = CONFIG.recruit.perAction[u] + (u === 'levy' ? CONFIG.factions[f].levyRecruitBonus : 0);
      if (st.grainUpkeep > 0) {
        const fed = Math.floor(g.grainHeadroom(f) / st.grainUpkeep);
        // gold-financed grain: the upkeep engine buys shortfall grain at
        // 2g/unit (already reserved by spendable), so a healthy treasury may
        // run a modest deficit — 2 units/action while spendable stays >= 12.
        const goldFed = sp >= 12 ? 2 : 0;
        cap = Math.min(cap, Math.max(fed, goldFed));
      }
      const cost = unitGoldCost(f, u);
      if (cost > 0) cap = Math.min(cap, Math.floor(sp / cost));
      if (cap >= 1 && g.actRecruit(f, pid, u, cap)) return true;
    }
    return false;
  }

  /** Instant mercenaries (hold-the-city emergencies only; x2 grain upkeep). */
  function recruitMercs(g: Game, f: FactionId, pid: string): boolean {
    const cost = unitGoldCost(f, 'mercenary');
    const sp = spendable(g, f);
    const n = Math.min(CONFIG.recruit.perAction.mercenary, Math.floor(sp / Math.max(1, cost)));
    return n >= 1 && g.actRecruit(f, pid, 'mercenary', n);
  }

  /** March the biggest idle interior stack one step toward `to` (rally). */
  function marchToward(g: Game, f: FactionId, to: string): boolean {
    let from = '';
    let bestSpare = 1;
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

  /** Blockade upkeep while besieging `pid`: harbor stacking, then delivery. */
  function ensureBlockade(g: Game, f: FactionId, pid: string, campArmy: Army, src: { sea: string[] }): boolean {
    const deficit = blockadeDeficit(g, f, pid);
    if (deficit <= 0 || !Number.isFinite(deficit)) return false; // done, or unattainable: spend on troops instead
    const fs = g.faction(f);
    const st = statsFor(f, 'galley');
    // (a) a harbor covering every zone (Genoese Pera): just build there.
    for (const q of fullCoveragePorts(g, f, pid)) {
      if (fs.gold >= st.goldCost && fs.timber >= st.timberCost &&
          g.actRecruit(f, q, 'galley', Math.min(2, deficit))) return true;
    }
    // (b) deliver galleys into the camp by sea reinforcement (escort rule:
    //     ceil(land/2) galleys accompany the land detachment and merge).
    for (const q of src.sea) {
      const garr = g.province(q).garrison;
      const land = Math.min(fighters(garr), 2 * deficit);
      if (land >= 1 && garr.galley >= Math.ceil(land / 2) &&
          g.actAttack(f, q, pid, land, 0)) return true;
    }
    // (c) stage assets at the best sea source: galleys first, then carriers.
    const port = bestBy(src.sea, (q) => g.province(q).garrison.galley);
    if (port) {
      const garr = g.province(port).garrison;
      if (garr.galley < deficit + Math.ceil(fighters(garr) / 2) &&
          fs.gold >= st.goldCost && fs.timber >= st.timberCost &&
          g.actRecruit(f, port, 'galley', 2)) return true;
      if (fighters(garr) < 2 * deficit && recruitFighters(g, f, port)) return true;
    }
    void campArmy;
    return false;
  }

  function takeTurn(g: Game, f: FactionId): void {
    if (tel) {
      const tp = g.province(TARGET);
      if (tp.owner === f && tel.firstOwnedSeenRound === null) tel.firstOwnedSeenRound = g.round;
      const s0 = g.siegeAt(TARGET);
      if (s0 && s0.attacker === f) {
        if (tel.siegeSeenRound === null) {
          tel.siegeSeenRound = g.round;
          tel.garrisonAtSiegeStart = combatants(tp.garrison);
        }
        tel.siegeObsRounds++;
        tel.lastGarrisonSeen = combatants(tp.garrison);
        tel.lastWallDamageSeen = tp.wallDamage;
        if (blockadeUp(g, f, TARGET)) tel.blockadedRounds++;
        const raw = (g as unknown as { sieges: Map<string, { stores: number }> }).sieges.get(TARGET);
        if (raw && (tel.minStoresSeen === null || raw.stores < tel.minStoresSeen)) tel.minStoresSeen = raw.stores;
      }
      if (g.faction(f).hand.includes('treason-at-the-gate')) tel.treasonHeld = true;
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

    // ---- HOLD phase: we own Constantinople; survive 2 cleanups.
    if (tp.owner === f) {
      if (!g.isBesieged(TARGET)) {
        if (combatants(tp.garrison) < 12 && recruitMercs(g, f, TARGET)) return true;
        if (combatants(tp.garrison) < 12 && recruitFighters(g, f, TARGET)) return true;
      }
      if (tryOpenRoute(g, f)) return true;
      return false;
    }

    // ---- Rival (non-self) siege on the target: mass nearby and wait.
    if (siege && siege.attacker !== f) {
      const near = sources(g, f, TARGET);
      const pid = bestBy([...near.land, ...near.sea], (x) => fighters(g.province(x).garrison));
      if (pid && fighters(g.province(pid).garrison) < 14 && recruitFighters(g, f, pid)) return true;
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

      // 1. blockade first — the starvation clock does not tick without it.
      if (objective === TARGET && ensureBlockade(g, f, objective, army, src)) return true;

      // 2. troop pump: strong enough to assault the starved garrison and to
      //    shrug off relief sorties + 3%/round disease.
      const garrN = combatants(g.province(objective).garrison);
      const want = Math.min(24, Math.max(8, Math.ceil(garrN * prefs.strengthRatio) + 4));
      if (combatants(army) < want) {
        const pumpL = bestBy(src.land, (pid) => fighters(g.province(pid).garrison));
        if (pumpL) {
          const spare = fighters(g.province(pumpL).garrison) - 1;
          if (spare >= 2 && g.actAttack(f, pumpL, objective, spare, 0)) return true;
        }
        const pumpS = bestBy(src.sea, (pid) => fighters(g.province(pid).garrison));
        if (pumpS) {
          const garr = g.province(pumpS).garrison;
          const spare = fighters(garr) - 1;
          if (spare >= 2 && garr.galley >= Math.ceil(spare / 2) &&
              g.actAttack(f, pumpS, objective, spare, 0)) return true;
        }
        const rally = pumpL ?? pumpS;
        if (rally && recruitFighters(g, f, rally)) return true;
        if (rally && marchToward(g, f, rally)) return true;
      }

      if (tryOpenRoute(g, f)) return true;
      return false;
    }

    // ---- LAUNCH phase: no siege yet — mass at a source and attack.
    if (src.land.length > 0) {
      const from = bestBy(src.land, (pid) => fighters(g.province(pid).garrison))!;
      const garr = g.province(from).garrison;
      const n = fighters(garr);
      // camp must survive the <=2-combatant lift check + disease
      if (n >= launchMin || (g.round >= launchBy && n >= 4)) {
        if (g.actAttack(f, from, objective, n, garr.siegeEngine)) return true;
      }
      if (recruitFighters(g, f, from)) return true;
      if (marchToward(g, f, from)) return true;
      if (tryOpenRoute(g, f)) return true;
      return false;
    }
    if (src.sea.length > 0) {
      const from = bestBy(src.sea, (pid) => 2 * fighters(g.province(pid).garrison) + g.province(pid).garrison.galley)!;
      const garr = g.province(from).garrison;
      const n = fighters(garr);
      const enough = garr.galley >= Math.ceil(n / 2);
      if ((n >= launchMin || (g.round >= launchBy + 1 && n >= 4)) && enough) {
        if (g.actAttack(f, from, objective, n, garr.siegeEngine)) return true;
      }
      if (!enough || garr.galley < Math.ceil(Math.max(n, launchMin) / 2)) {
        const st = statsFor(f, 'galley');
        const fs = g.faction(f);
        if (fs.gold >= st.goldCost && fs.timber >= st.timberCost && g.actRecruit(f, from, 'galley', 2)) return true;
      }
      if (n < launchMin && recruitFighters(g, f, from)) return true;
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
