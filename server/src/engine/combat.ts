/**
 * combat.ts — battle, siege and naval resolution subsystem.
 *
 * Owns §7 (field combat), §8 (sieges) and §7.6 (naval). All dice come from the
 * {@link Rng} passed in by the caller (roundLoop), which owns cursor bookkeeping
 * so a whole COMBAT phase advances one shared RNG stream. Every modifier/table
 * is read from balance.ts. Pure: the input state is deep-cloned (structuredClone)
 * and never mutated; the advanced rng cursor is written onto the returned state.
 */
import {
  BuildingType,
  Faction,
  TerrainType,
  UnitType,
  type Army,
  type Fleet,
  type GameState,
  type PendingBattle,
  type Province,
  type SiegeState,
  type UnitVariantStack,
} from "@imperium/shared";
import type { Rng } from "./rng.js";
import {
  COMBAT_MODS,
  SIEGE,
  UNIQUE_UNIT_OVERRIDES,
  UNIT_STATS,
  WALL_TIERS,
} from "./balance.js";
import { appendLog } from "./logEntry.js";
import { neighborsOf } from "./adjacency.js";
import { sumModifierValues } from "./modifiers.js";

/** Per-side casualty tally, keyed by stack id. */
export interface CasualtyReport {
  /** Units removed per stack id. */
  losses: Record<string, number>;
  /** Stack ids that routed. */
  routed: string[];
}

/** Outcome of a resolved land or naval battle. */
export interface BattleResult {
  /** New state with casualties, ownership flips and log entries applied. */
  state: GameState;
  /** Winning player id, or null on mutual annihilation / stalemate. */
  winnerId: string | null;
  /** Number of combat rounds fought. */
  rounds: number;
  attacker: CasualtyReport;
  defender: CasualtyReport;
}

/** Outcome of a siege round or assault. */
export interface SiegeResult {
  state: GameState;
  /** True if the city was captured this resolution. */
  captured: boolean;
  /** Wall HP remaining after this resolution. */
  wallHpRemaining: number;
}

// ---------------------------------------------------------------------------
// Internal working model
// ---------------------------------------------------------------------------

type Role = "attacker" | "defender";
type Step = "ranged" | "melee";

/** A mutable per-battle copy of a stack; written back to state at the end. */
interface Working {
  id: string;
  ownerId: string;
  units: Record<UnitType, number>;
  variants: UnitVariantStack[];
  /** Synthetic garrison (write survivors back to province.garrison). */
  garrison?: boolean;
  /** Province the synthetic garrison belongs to. */
  provinceRef?: string;
}

/** Everything the round engine needs; `attackers`/`defenders` are mutated. */
interface BattleCtx {
  attackers: Working[];
  defenders: Working[];
  attackerOwnerId: string;
  defenderOwnerId: string | null;
  terrain?: TerrainType;
  /** Wall HP standing at the point of resolution (0 = none / breached). */
  wallsHp: number;
  wallDefBonus: number;
  amphibious: boolean;
  /** Unit types that fire in the pre-melee ranged step. */
  rangedTypes: UnitType[];
  isNaval: boolean;
  provinceId?: string;
  seaZoneId?: string;
  attackerFaction: Faction | null;
  defenderFaction: Faction | null;
}

interface EngineOutcome {
  rounds: number;
  attackerRouted: boolean;
  defenderRouted: boolean;
  attackerRetreatTo?: string;
  defenderRetreatTo?: string;
}

/** Casualty-removal priority: lowest field value first (§7.1). */
const CASUALTY_ORDER: UnitType[] = [
  UnitType.LEVY,
  UnitType.ARCHER,
  UnitType.INFANTRY,
  UnitType.CAVALRY,
  UnitType.SIEGE,
  UnitType.GALLEY,
  UnitType.WARSHIP,
];

function zeroUnits(): Record<UnitType, number> {
  const u = {} as Record<UnitType, number>;
  for (const t of Object.values(UnitType)) u[t] = 0;
  return u;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function factionOf(state: GameState, ownerId: string | null): Faction | null {
  if (!ownerId) return null;
  const p = state.players.find((pl) => pl.id === ownerId);
  return p ? p.faction : null;
}

function toWorking(stack: Army | Fleet): Working {
  return {
    id: stack.id,
    ownerId: stack.ownerId,
    units: { ...zeroUnits(), ...stack.units },
    variants: (stack.variants ?? []).map((v) => ({ ...v })),
  };
}

/** Total live units in a working stack (generic + variant). */
function stackTotal(w: Working): number {
  let n = 0;
  for (const t of CASUALTY_ORDER) n += w.units[t] ?? 0;
  for (const v of w.variants) n += v.count;
  return n;
}

/** Total live units in a real Army/Fleet (generic + variant). */
function realCount(stack: Army | Fleet): number {
  let n = 0;
  for (const t of Object.values(UnitType)) n += stack.units[t] ?? 0;
  for (const v of stack.variants ?? []) n += v.count;
  return n;
}

function sideTotal(side: Working[]): number {
  return side.reduce((acc, w) => acc + stackTotal(w), 0);
}

/** Count CAVALRY (generic + variant) on a side — drives pursuit hits (§7.5). */
function cavalryCount(side: Working[]): number {
  let n = 0;
  for (const w of side) {
    n += w.units[UnitType.CAVALRY] ?? 0;
    for (const v of w.variants) if (v.base === UnitType.CAVALRY) n += v.count;
  }
  return n;
}

/** A unit type participates this step: ranged types pre-melee, non-SIEGE in melee. */
function participates(type: UnitType, step: Step, ctx: BattleCtx): boolean {
  if (step === "ranged") return ctx.rangedTypes.includes(type);
  // §6.1: SIEGE contributes no offensive dice in a field battle.
  return type !== UnitType.SIEGE;
}

/** Base combat value for a role: attack CV for attackers, defence CV for defenders. */
function baseCv(type: UnitType, role: Role): number {
  const stat = UNIT_STATS[type];
  return role === "attacker" ? stat.atk : stat.def;
}

/** Sum of tactic-card combat modifiers targeting this side (§7.3 activeModifiers). */
function tacticMod(
  state: GameState,
  faction: Faction | null,
  provinceId?: string,
  seaZoneId?: string,
): number {
  if (!faction) return 0;
  return sumModifierValues(state, "combat_mod", { faction, provinceId, seaZoneId });
}

/** Signed flat modifier applied to the attacking side this step. */
function attackerFlat(
  state: GameState,
  ctx: BattleCtx,
  atkTotal: number,
  defTotal: number,
): number {
  let m = 0;
  if (ctx.amphibious) m += COMBAT_MODS.amphibiousAttacker; // §7.3 amphibious −1
  if (ctx.wallsHp > 0) m += COMBAT_MODS.escalade; // §7.3 escalade −1 vs un-breached walls
  // §7.3 outnumber ≥2:1 → larger side +1
  if (defTotal > 0 && atkTotal >= COMBAT_MODS.outnumberRatio * defTotal) {
    m += COMBAT_MODS.outnumber;
  }
  m += tacticMod(state, ctx.attackerFaction, ctx.provinceId, ctx.seaZoneId);
  return m;
}

/** Signed flat modifier applied to the defending side this step. */
function defenderFlat(
  state: GameState,
  ctx: BattleCtx,
  atkTotal: number,
  defTotal: number,
): number {
  let m = 0;
  // §7.3 defender +1 in hills/mountains/forest.
  if (
    ctx.terrain === TerrainType.HILLS ||
    ctx.terrain === TerrainType.MOUNTAINS ||
    ctx.terrain === TerrainType.FOREST
  ) {
    m += COMBAT_MODS.defensiveTerrain;
  }
  // §7.3 city walls +2/+3/+4 while HP > 0.
  if (ctx.wallsHp > 0) m += ctx.wallDefBonus;
  // §7.3 outnumber ≥2:1 → larger side +1
  if (atkTotal > 0 && defTotal >= COMBAT_MODS.outnumberRatio * atkTotal) {
    m += COMBAT_MODS.outnumber;
  }
  m += tacticMod(state, ctx.defenderFaction, ctx.provinceId, ctx.seaZoneId);
  return m;
}

/** Roll one homogeneous dice group and count hits under the §7.1 hit rule. */
function rollGroup(
  count: number,
  cv: number,
  type: UnitType,
  role: Role,
  flatMod: number,
  ctx: BattleCtx,
  rng: Rng,
): number {
  // §7.3 cavalry charge +1 on PLAINS (attacker only; negated off plains).
  const charge =
    role === "attacker" && type === UnitType.CAVALRY && ctx.terrain === TerrainType.PLAINS
      ? COMBAT_MODS.cavalryCharge
      : 0;
  // §7.1 hit on d6 ≥ clamp(7 − CV − mods, 2, 6).
  const threshold = clamp(
    COMBAT_MODS.hitBase - cv - flatMod - charge,
    COMBAT_MODS.hitClampMin,
    COMBAT_MODS.hitClampMax,
  );
  const rolls = rng.rollDice(count);
  let hits = 0;
  for (const r of rolls) if (r >= threshold) hits += 1;
  return hits;
}

/** Total hits a side scores this step (deterministic stack/type iteration). */
function generateHits(
  _state: GameState,
  side: Working[],
  role: Role,
  step: Step,
  flatMod: number,
  ctx: BattleCtx,
  rng: Rng,
): number {
  let hits = 0;
  for (const stack of side) {
    for (const type of CASUALTY_ORDER) {
      const count = stack.units[type] ?? 0;
      if (count <= 0 || !participates(type, step, ctx)) continue;
      hits += rollGroup(count, baseCv(type, role), type, role, flatMod, ctx, rng);
    }
    for (const v of stack.variants) {
      if (v.count <= 0 || !participates(v.base, step, ctx)) continue;
      // §FACTIONS: variant effective CV = base CV + unique-unit stat delta.
      const def = UNIQUE_UNIT_OVERRIDES[v.variant];
      const delta = role === "attacker" ? def?.atkMod ?? 0 : def?.defMod ?? 0;
      hits += rollGroup(v.count, baseCv(v.base, role) + delta, v.base, role, flatMod, ctx, rng);
    }
  }
  return hits;
}

/** Remove `n` units from a side, lowest-value first, generic before variant (§7.1). */
function removeCasualties(side: Working[], n: number): void {
  let remaining = n;
  for (const type of CASUALTY_ORDER) {
    if (remaining <= 0) break;
    for (const stack of side) {
      if (remaining <= 0) break;
      const take = Math.min(stack.units[type] ?? 0, remaining);
      stack.units[type] -= take;
      remaining -= take;
    }
  }
  if (remaining > 0) {
    // Elite variants absorb losses last.
    for (const stack of side) {
      for (const v of stack.variants) {
        if (remaining <= 0) break;
        const take = Math.min(v.count, remaining);
        v.count -= take;
        remaining -= take;
      }
    }
  }
}

/** First adjacent land province owned by `ownerId` or empty, for a retreat (§7.5). */
function findRetreat(
  state: GameState,
  ownerId: string | null,
  fromId?: string,
): string | undefined {
  if (!ownerId || !fromId) return undefined;
  for (const n of neighborsOf(fromId)) {
    const prov = state.provinces.find((p) => p.id === n);
    if (!prov) continue; // skip sea zones
    if (prov.ownerId === ownerId || prov.ownerId === null) return n;
  }
  return undefined;
}

/**
 * Core §7.2 round loop shared by field battles, naval battles and siege
 * assaults. Mutates `ctx.attackers`/`ctx.defenders` in place; reads `state`
 * only for tactic modifiers and retreat adjacency.
 */
function runEngine(state: GameState, ctx: BattleCtx, rng: Rng): EngineOutcome {
  const attackerInitial = sideTotal(ctx.attackers);
  const defenderInitial = sideTotal(ctx.defenders);
  let rounds = 0;
  let attackerRouted = false;
  let defenderRouted = false;
  let attackerRetreatTo: string | undefined;
  let defenderRetreatTo: string | undefined;
  const cap = 50; // guard against pathological non-terminating stalemates

  if (attackerInitial === 0 || defenderInitial === 0) {
    return { rounds: 0, attackerRouted, defenderRouted };
  }

  while (rounds < cap) {
    rounds += 1;

    // 1. Ranged step (§7.2): compute both sides' hits pre-removal (simultaneous).
    if (ctx.rangedTypes.length > 0) {
      const at = sideTotal(ctx.attackers);
      const dt = sideTotal(ctx.defenders);
      const af = attackerFlat(state, ctx, at, dt);
      const df = defenderFlat(state, ctx, at, dt);
      const ah = generateHits(state, ctx.attackers, "attacker", "ranged", af, ctx, rng);
      const dh = generateHits(state, ctx.defenders, "defender", "ranged", df, ctx, rng);
      removeCasualties(ctx.defenders, ah);
      removeCasualties(ctx.attackers, dh);
      if (sideTotal(ctx.attackers) === 0 || sideTotal(ctx.defenders) === 0) break;
    }

    // 2. Melee step (§7.2): both sides roll simultaneously.
    {
      const at = sideTotal(ctx.attackers);
      const dt = sideTotal(ctx.defenders);
      const af = attackerFlat(state, ctx, at, dt);
      const df = defenderFlat(state, ctx, at, dt);
      const ah = generateHits(state, ctx.attackers, "attacker", "melee", af, ctx, rng);
      const dh = generateHits(state, ctx.defenders, "defender", "melee", df, ctx, rng);
      // 3. Apply casualties (§7.2).
      removeCasualties(ctx.defenders, ah);
      removeCasualties(ctx.attackers, dh);
    }

    const at = sideTotal(ctx.attackers);
    const dt = sideTotal(ctx.defenders);
    if (at === 0 || dt === 0) break;

    // 4. Morale / rout check (§7.5). Naval combat has no rout.
    if (!ctx.isNaval) {
      let routed = false;
      // §7.5 rout if a side lost ≥50% of its starting stack, on d6 ≤ 3.
      if (1 - at / attackerInitial >= COMBAT_MODS.routLossFraction) {
        if (rng.rollD6() <= COMBAT_MODS.routThreshold) {
          attackerRouted = true;
          routed = true;
        }
      }
      if (1 - dt / defenderInitial >= COMBAT_MODS.routLossFraction) {
        if (rng.rollD6() <= COMBAT_MODS.routThreshold) {
          defenderRouted = true;
          routed = true;
        }
      }
      if (attackerRouted) {
        // §7.5 pursuit: each enemy CAVALRY inflicts 1 automatic hit.
        removeCasualties(ctx.attackers, cavalryCount(ctx.defenders));
        attackerRetreatTo = findRetreat(state, ctx.attackerOwnerId, ctx.provinceId);
      }
      if (defenderRouted) {
        removeCasualties(ctx.defenders, cavalryCount(ctx.attackers));
        defenderRetreatTo = findRetreat(state, ctx.defenderOwnerId, ctx.provinceId);
      }
      if (routed) break;
    }
  }

  return { rounds, attackerRouted, defenderRouted, attackerRetreatTo, defenderRetreatTo };
}

/** Build a casualty report from before/after totals. */
function report(
  side: Working[],
  initial: Map<string, number>,
  routed: boolean,
): CasualtyReport {
  const losses: Record<string, number> = {};
  for (const w of side) {
    const before = initial.get(w.id) ?? 0;
    losses[w.id] = Math.max(0, before - stackTotal(w));
  }
  return { losses, routed: routed ? side.map((w) => w.id) : [] };
}

/** Write surviving working stacks back onto the (cloned) state and prune empties. */
function writeBack(
  state: GameState,
  side: Working[],
  kind: "army" | "fleet",
  routed: boolean,
  retreatTo: string | undefined,
): void {
  for (const w of side) {
    if (w.garrison) {
      const prov = state.provinces.find((p) => p.id === w.provinceRef);
      if (prov) prov.garrison = routed && !retreatTo ? 0 : stackTotal(w);
      continue;
    }
    const list = kind === "army" ? state.armies : state.fleets;
    const s = list.find((x) => x.id === w.id);
    if (!s) continue;
    if (routed && !retreatTo) {
      // §7.5 no retreat available → the routed stack surrenders (removed).
      s.units = zeroUnits();
      s.variants = [];
    } else {
      s.units = w.units;
      s.variants = w.variants;
      if (routed && retreatTo) s.locationId = retreatTo;
    }
  }
  if (kind === "army") {
    state.armies = state.armies.filter((a) => realCount(a) > 0);
  } else {
    state.fleets = state.fleets.filter((f) => realCount(f) > 0);
  }
}

/** Flip province ownership after a capture, clearing garrison/siege and the C'ple flag. */
function captureProvince(state: GameState, prov: Province, newOwnerId: string): void {
  prov.ownerId = newOwnerId;
  prov.garrison = 0;
  delete prov.siege;
  state.siegeStates = state.siegeStates.filter((s) => s.provinceId !== prov.id);
  // §8.3 Constantinople's capture arms the sudden-death check (prestige owns the win).
  if (prov.id === "constantinople") {
    state.constantinopleHold = { faction: factionOf(state, newOwnerId), rounds: 0 };
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Resolve a declared land battle (§7): ranged step, simultaneous melee,
 * casualties (lowest-value first), morale/rout, repeat. Applies terrain, walls,
 * charge, amphibious, escalade and outnumber modifiers from balance.COMBAT_MODS.
 */
export function resolveBattle(
  state: GameState,
  battle: PendingBattle,
  rng: Rng,
): BattleResult {
  const next = structuredClone(state) as GameState;
  const prov = battle.provinceId
    ? next.provinces.find((p) => p.id === battle.provinceId)
    : undefined;

  const attackers = next.armies
    .filter((a) => battle.attackerStackIds.includes(a.id))
    .map(toWorking);

  const defenders: Working[] = next.armies
    .filter((a) => battle.defenderStackIds.includes(a.id))
    .map(toWorking);
  // Neutral/minor garrison stands in as INFANTRY-equivalent defenders.
  if (defenders.length === 0 && prov && (prov.garrison ?? 0) > 0) {
    const units = zeroUnits();
    units[UnitType.INFANTRY] = prov.garrison ?? 0;
    defenders.push({
      id: `garrison-${prov.id}`,
      ownerId: prov.ownerId ?? "neutral",
      units,
      variants: [],
      garrison: true,
      provinceRef: prov.id,
    });
  }

  const emptyReport: CasualtyReport = { losses: {}, routed: [] };

  // Uncontested move → occupation (§6.4); no dice consumed.
  if (defenders.length === 0 || sideTotal(defenders) === 0) {
    if (prov && sideTotal(attackers) > 0) {
      captureProvince(next, prov, battle.attackerId);
    }
    let out = next;
    if (prov) {
      out = appendLog(out, {
        round: out.round,
        phase: out.phase,
        type: "battle",
        actors: [battle.attackerId],
        targets: [prov.id],
        message: `${battle.attackerId} occupies ${prov.name} unopposed.`,
        data: { rounds: 0 },
      });
    }
    return {
      state: { ...out, rngCursor: rng.cursor },
      winnerId: sideTotal(attackers) > 0 ? battle.attackerId : null,
      rounds: 0,
      attacker: emptyReport,
      defender: emptyReport,
    };
  }

  const atkInitial = new Map(attackers.map((w): [string, number] => [w.id, stackTotal(w)]));
  const defInitial = new Map(defenders.map((w): [string, number] => [w.id, stackTotal(w)]));

  const wallsHp = prov?.walls.hp ?? 0;
  const wallDefBonus = prov ? WALL_TIERS[prov.walls.tier]?.defBonus ?? 0 : 0;

  const ctx: BattleCtx = {
    attackers,
    defenders,
    attackerOwnerId: battle.attackerId,
    defenderOwnerId: battle.defenderId,
    terrain: prov?.terrain,
    wallsHp,
    wallDefBonus,
    amphibious: battle.amphibious ?? false,
    rangedTypes: [UnitType.ARCHER],
    isNaval: false,
    provinceId: battle.provinceId,
    attackerFaction: factionOf(next, battle.attackerId),
    defenderFaction: factionOf(next, battle.defenderId),
  };

  const outcome = runEngine(next, ctx, rng);

  const atkAlive = sideTotal(attackers);
  const defAlive = sideTotal(defenders);
  let winnerId: string | null = null;
  if (outcome.attackerRouted && !outcome.defenderRouted) {
    winnerId = battle.defenderId; // §7.5 attacker fled the field
  } else if (outcome.defenderRouted && !outcome.attackerRouted) {
    winnerId = battle.attackerId; // §7.5 defender fled → attacker holds
  } else if (!outcome.attackerRouted && !outcome.defenderRouted) {
    if (atkAlive > 0 && defAlive === 0) winnerId = battle.attackerId;
    else if (defAlive > 0 && atkAlive === 0) winnerId = battle.defenderId;
  }

  writeBack(next, attackers, "army", outcome.attackerRouted, outcome.attackerRetreatTo);
  writeBack(next, defenders, "army", outcome.defenderRouted, outcome.defenderRetreatTo);

  // §7: winner takes the province if the attacker prevails in a field battle.
  if (winnerId === battle.attackerId && !outcome.attackerRouted && prov) {
    captureProvince(next, prov, battle.attackerId);
  }

  const attackerReport = report(attackers, atkInitial, outcome.attackerRouted);
  const defenderReport = report(defenders, defInitial, outcome.defenderRouted);

  let logged = appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "battle",
    actors: [battle.attackerId, ...(battle.defenderId ? [battle.defenderId] : [])],
    targets: prov ? [prov.id] : [],
    message: prov
      ? `Battle at ${prov.name}: ${winnerId ?? "no one"} prevails after ${outcome.rounds} round(s).`
      : `Battle resolved after ${outcome.rounds} round(s).`,
    data: {
      rounds: outcome.rounds,
      winnerId,
      attackerLosses: attackerReport.losses,
      defenderLosses: defenderReport.losses,
      attackerRouted: outcome.attackerRouted,
      defenderRouted: outcome.defenderRouted,
    },
  });
  logged = { ...logged, rngCursor: rng.cursor };

  return {
    state: logged,
    winnerId,
    rounds: outcome.rounds,
    attacker: attackerReport,
    defender: defenderReport,
  };
}

/**
 * Resolve a naval battle in a sea zone (§7.6): naval CVs, no terrain/walls,
 * winner controls the zone (enabling blockade §5.3). Transport cargo is lost
 * with a wiped fleet upstream. Pure.
 */
export function resolveNaval(
  state: GameState,
  battle: PendingBattle,
  rng: Rng,
): BattleResult {
  const next = structuredClone(state) as GameState;
  const zone = battle.seaZoneId
    ? next.seaZones.find((z) => z.id === battle.seaZoneId)
    : undefined;

  const attackers = next.fleets
    .filter((f) => battle.attackerStackIds.includes(f.id))
    .map(toWorking);
  const defenders = next.fleets
    .filter((f) => battle.defenderStackIds.includes(f.id))
    .map(toWorking);

  const emptyReport: CasualtyReport = { losses: {}, routed: [] };

  if (defenders.length === 0 || sideTotal(defenders) === 0) {
    // Uncontested sea zone → attacker controls it.
    if (zone && sideTotal(attackers) > 0) zone.blockadedBy = battle.attackerId;
    let out = next;
    if (zone) {
      out = appendLog(out, {
        round: out.round,
        phase: out.phase,
        type: "battle",
        actors: [battle.attackerId],
        targets: [zone.id],
        message: `${battle.attackerId} sails into ${zone.name} unopposed.`,
        data: { rounds: 0, naval: true },
      });
    }
    return {
      state: { ...out, rngCursor: rng.cursor },
      winnerId: sideTotal(attackers) > 0 ? battle.attackerId : null,
      rounds: 0,
      attacker: emptyReport,
      defender: emptyReport,
    };
  }

  const atkInitial = new Map(attackers.map((w): [string, number] => [w.id, stackTotal(w)]));
  const defInitial = new Map(defenders.map((w): [string, number] => [w.id, stackTotal(w)]));

  const ctx: BattleCtx = {
    attackers,
    defenders,
    attackerOwnerId: battle.attackerId,
    defenderOwnerId: battle.defenderId,
    wallsHp: 0,
    wallDefBonus: 0,
    amphibious: false,
    rangedTypes: [], // §7.6 no ranged/terrain/walls at sea
    isNaval: true,
    seaZoneId: battle.seaZoneId,
    attackerFaction: factionOf(next, battle.attackerId),
    defenderFaction: factionOf(next, battle.defenderId),
  };

  const outcome = runEngine(next, ctx, rng);

  const atkAlive = sideTotal(attackers);
  const defAlive = sideTotal(defenders);
  let winnerId: string | null = null;
  if (atkAlive > 0 && defAlive === 0) winnerId = battle.attackerId;
  else if (defAlive > 0 && atkAlive === 0) winnerId = battle.defenderId;

  writeBack(next, attackers, "fleet", false, undefined);
  writeBack(next, defenders, "fleet", false, undefined);

  // §7.6 the winner controls the zone (enabling blockade).
  if (zone && winnerId) zone.blockadedBy = winnerId;

  const attackerReport = report(attackers, atkInitial, false);
  const defenderReport = report(defenders, defInitial, false);

  let logged = appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "battle",
    actors: [battle.attackerId, ...(battle.defenderId ? [battle.defenderId] : [])],
    targets: zone ? [zone.id] : [],
    message: zone
      ? `Naval battle in ${zone.name}: ${winnerId ?? "no one"} controls the zone after ${outcome.rounds} round(s).`
      : `Naval battle resolved after ${outcome.rounds} round(s).`,
    data: {
      rounds: outcome.rounds,
      winnerId,
      naval: true,
      attackerLosses: attackerReport.losses,
      defenderLosses: defenderReport.losses,
    },
  });
  logged = { ...logged, rngCursor: rng.cursor };

  return {
    state: logged,
    winnerId,
    rounds: outcome.rounds,
    attacker: attackerReport,
    defender: defenderReport,
  };
}

/**
 * Advance a siege one round (§8): circumvallation lock, SIEGE bombardment of the
 * walls, garrison starvation, then an assault. If the besieging force has been
 * eliminated (a successful relief, §8.2.5), the siege is lifted and walls begin
 * to repair. Pure. See the module notes for the auto-assault modelling decision.
 */
export function resolveSiege(
  state: GameState,
  siege: SiegeState,
  rng: Rng,
): SiegeResult {
  const next = structuredClone(state) as GameState;
  const prov = next.provinces.find((p) => p.id === siege.provinceId);
  const live =
    next.siegeStates.find((s) => s.provinceId === siege.provinceId) ??
    (structuredClone(siege) as SiegeState);

  if (!prov) {
    return { state: { ...next, rngCursor: rng.cursor }, captured: false, wallHpRemaining: 0 };
  }

  const besiegers = next.armies
    .filter((a) => siege.besiegingArmyIds.includes(a.id))
    .map(toWorking);

  // §8.2.5 Relief succeeded: no besieging troops remain → lift siege, repair walls.
  if (besiegers.length === 0 || sideTotal(besiegers) === 0) {
    const maxHp = WALL_TIERS[prov.walls.tier]?.hp ?? prov.walls.hp;
    prov.walls.hp = Math.min(maxHp, prov.walls.hp + SIEGE.wallRepairPerRound);
    delete prov.siege;
    next.siegeStates = next.siegeStates.filter((s) => s.provinceId !== prov.id);
    const out = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "siege",
      actors: [siege.besiegerId],
      targets: [prov.id],
      message: `The siege of ${prov.name} is lifted; the walls begin to repair.`,
      data: { wallHp: prov.walls.hp, lifted: true },
    });
    return { state: { ...out, rngCursor: rng.cursor }, captured: false, wallHpRemaining: prov.walls.hp };
  }

  // 1. Circumvallation (§8.2.1) — lock the besieger in place.
  live.circumvallated = true;
  live.roundsElapsed += 1;

  // 2. Bombardment (§8.2.2) — every SIEGE unit rolls 1d6 of wall damage.
  const defenderFaction = factionOf(next, prov.ownerId);
  // §8.3 Byzantine Theodosian Walls auto-repel the first rounds of bombardment.
  const autoRepel =
    defenderFaction === Faction.BYZANTIUM &&
    prov.walls.tier === 3 &&
    live.roundsElapsed <= SIEGE.byzantineAutoRepelRounds;
  let siegeGuns = 0;
  for (const w of besiegers) {
    siegeGuns += w.units[UnitType.SIEGE] ?? 0;
    for (const v of w.variants) if (v.base === UnitType.SIEGE) siegeGuns += v.count;
  }
  let wallDamage = 0;
  if (siegeGuns > 0) {
    for (const roll of rng.rollDice(siegeGuns)) {
      wallDamage += SIEGE.bombardDamage[roll] ?? 0;
    }
  }
  if (autoRepel) wallDamage = 0;
  prov.walls.hp = Math.max(0, prov.walls.hp - wallDamage);
  if (prov.walls.hp === 0) live.breached = true;
  live.wallHp = prov.walls.hp;

  // 3. Garrison starvation (§8.2.3) — hold `base (+2 Granary)` rounds, then starve.
  const hasGranary = prov.buildings.includes(BuildingType.GRANARY);
  const holdout = SIEGE.baseHoldoutRounds + (hasGranary ? SIEGE.granaryBonusRounds : 0);
  if (live.grainStores > 0) live.grainStores -= 1;

  // Assemble the garrison defenders (real stacks + synthetic province garrison).
  const defenders: Working[] = next.armies
    .filter((a) => a.ownerId === prov.ownerId && a.locationId === prov.id)
    .map(toWorking);
  if ((prov.garrison ?? 0) > 0) {
    const units = zeroUnits();
    units[UnitType.INFANTRY] = prov.garrison ?? 0;
    defenders.push({
      id: `garrison-${prov.id}`,
      ownerId: prov.ownerId ?? "neutral",
      units,
      variants: [],
      garrison: true,
      provinceRef: prov.id,
    });
  }

  let starved = 0;
  if (live.roundsElapsed > holdout) {
    starved = SIEGE.starvationLossPerRound;
    removeCasualties(defenders, starved); // §8.2.3 weakest first
    live.starvationCounter = (live.starvationCounter ?? 0) + 1;
  }

  // 4. Assault (§8.2.4): besieger storms the garrison, walls + escalade if standing.
  let captured = false;
  let assaultRounds = 0;
  let defRouted = false;
  let defRetreat: string | undefined;
  // §8.2.4 An assault requires storming troops; a pure bombardment/blockade force
  // (SIEGE-only) cannot storm the walls — it merely reduces via bombardment and
  // starvation. Count the besieger's non-SIEGE (assault-capable) strength.
  let assaultTroops = 0;
  for (const w of besiegers) {
    for (const t of CASUALTY_ORDER) if (t !== UnitType.SIEGE) assaultTroops += w.units[t] ?? 0;
    for (const v of w.variants) if (v.base !== UnitType.SIEGE) assaultTroops += v.count;
  }
  if (sideTotal(defenders) === 0) {
    // Starved / bombarded into submission before the assault.
    captured = true;
  } else if (assaultTroops === 0) {
    // No storming troops: no assault this round (walls/garrison untouched by combat).
  } else {
    const ctx: BattleCtx = {
      attackers: besiegers,
      defenders,
      attackerOwnerId: siege.besiegerId,
      defenderOwnerId: prov.ownerId,
      terrain: prov.terrain,
      wallsHp: prov.walls.hp, // §8.2.4 wall bonus + escalade only while HP > 0
      wallDefBonus: WALL_TIERS[prov.walls.tier]?.defBonus ?? 0,
      amphibious: false,
      rangedTypes: [UnitType.ARCHER],
      isNaval: false,
      provinceId: prov.id,
      attackerFaction: factionOf(next, siege.besiegerId),
      defenderFaction,
    };
    const outcome = runEngine(next, ctx, rng);
    assaultRounds = outcome.rounds;
    defRouted = outcome.defenderRouted;
    defRetreat = outcome.defenderRetreatTo;
    if (
      sideTotal(besiegers) > 0 &&
      !outcome.attackerRouted &&
      (sideTotal(defenders) === 0 || outcome.defenderRouted)
    ) {
      captured = true;
    }
  }
  // Persist garrison casualties (starvation and/or assault) and besieger losses.
  writeBack(next, defenders, "army", defRouted, defRetreat);
  writeBack(next, besiegers, "army", false, undefined);

  if (captured) {
    captureProvince(next, prov, siege.besiegerId);
  } else {
    // Mirror updated siege progress back onto state.
    prov.siege = { ...live };
    const idx = next.siegeStates.findIndex((s) => s.provinceId === prov.id);
    if (idx >= 0) next.siegeStates[idx] = { ...live };
    else next.siegeStates.push({ ...live });
  }

  const out = appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "siege",
    actors: [siege.besiegerId],
    targets: [prov.id],
    message: captured
      ? `${siege.besiegerId} storms ${prov.name}!`
      : `Siege of ${prov.name}: walls at ${prov.walls.hp} HP after round ${live.roundsElapsed}.`,
    data: {
      wallHp: prov.walls.hp,
      wallDamage,
      starved,
      captured,
      breached: live.breached,
      assaultRounds,
    },
  });

  return {
    state: { ...out, rngCursor: rng.cursor },
    captured,
    wallHpRemaining: prov.walls.hp,
  };
}
