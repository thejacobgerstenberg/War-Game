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
  Faction,
  TerrainType,
  UnitType,
  type ActiveModifier,
  type Army,
  type Fleet,
  type GameState,
  type PendingBattle,
  type Province,
  type SiegeState,
  type TacticCardId,
  type UnitVariantStack,
} from "@imperium/shared";
import type { Rng } from "./rng.js";
import {
  COMBAT_MODS,
  CONQUEST_PRESTIGE,
  GREAT_BOMBARD,
  SIEGE,
  UNIQUE_UNIT_OVERRIDES,
  UNIT_STATS,
  WALL_TIERS,
} from "./balance.js";
import { appendLog } from "./logEntry.js";
import { neighborsOf } from "./adjacency.js";
import { addModifier, getModifiers, sumModifierValues } from "./modifiers.js";
import { playTactic } from "./tactics/index.js";

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
  /**
   * §8.4 assault row / §8.2 step 4 (FL-13): flat attacker bonus contributed by
   * storming SIEGE units (and an emplaced Great Bombard) vs a STANDING wall
   * during a siege assault. Applied by {@link attackerFlat} only while wallsHp>0;
   * absent for field/naval battles (SIEGE lends no field dice, §6.1).
   */
  siegeAssaultBonus?: number;
  amphibious: boolean;
  /** Unit types that fire in the pre-melee ranged step. */
  rangedTypes: UnitType[];
  isNaval: boolean;
  provinceId?: string;
  seaZoneId?: string;
  attackerFaction: Faction | null;
  defenderFaction: Faction | null;
  /**
   * The declared battle, when this engagement carries queued tactic cards
   * (§7.7). Absent for siege assaults (which are not `PendingBattle`s). Its
   * `attackerTactics`/`defenderTactics` arrays are LOCAL COPIES so consuming a
   * card per round never mutates the caller's input battle.
   */
  battle?: PendingBattle;
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
  // §8.4 assault row / §8.2 step 4 (FL-13): storming SIEGE units (incl. an
  // emplaced Great Bombard) add the standard SIEGE +3 vs a STANDING wall.
  if (ctx.wallsHp > 0 && ctx.siegeAssaultBonus) m += ctx.siegeAssaultBonus;
  // §7.3 outnumber ≥2:1 → larger side +1
  if (defTotal > 0 && atkTotal >= COMBAT_MODS.outnumberRatio * defTotal) {
    m += COMBAT_MODS.outnumber;
  }
  m += tacticMod(state, ctx.attackerFaction, ctx.provinceId, ctx.seaZoneId);
  return m;
}

/**
 * §7.7 / EVENT_CARDS #36 / CONTRACT2 §12.10 (FL-18): the defender's effective
 * wall bonus after `wall_mod` effects. A `wallBonusZero` modifier (the
 * `bribed-gatekeeper` tactic) nulls the bonus outright for this assault; the
 * summed signed values (EVENT_CARDS #36 "old-style walls −1 tier") shift it,
 * clamped ≥ 0. Read against the defender's faction + province so global (#36),
 * province-scoped (bribed-gatekeeper) and faction+province (chain) modifiers all
 * match. Called only while wallsHp > 0.
 */
function effectiveWallDefBonus(state: GameState, ctx: BattleCtx): number {
  const mods = getModifiers(state, "wall_mod", {
    faction: ctx.defenderFaction ?? undefined,
    provinceId: ctx.provinceId,
  });
  if (mods.some((m) => m.data?.wallBonusZero === true)) return 0;
  const delta = mods.reduce((acc, m) => acc + (m.value ?? 0), 0);
  return Math.max(0, ctx.wallDefBonus + delta);
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
  // §7.3 city walls +1…+4 while HP > 0, adjusted by any `wall_mod` in force
  // (FL-18): EVENT_CARDS #36 Gunpowder Revolution (old-style walls −1 tier) and
  // the `bribed-gatekeeper` tactic (wallBonusZero). Effective bonus clamped ≥ 0.
  if (ctx.wallsHp > 0) m += effectiveWallDefBonus(state, ctx);
  // §7.3 outnumber ≥2:1 → larger side +1
  if (atkTotal > 0 && defTotal >= COMBAT_MODS.outnumberRatio * atkTotal) {
    m += COMBAT_MODS.outnumber;
  }
  m += tacticMod(state, ctx.defenderFaction, ctx.provinceId, ctx.seaZoneId);
  return m;
}

/**
 * §7.5 morale shift from event/tactic `morale` modifiers: a positive value makes
 * the side steadier (LOWERS its rout threshold, so `d6 <= threshold` fires less
 * often); negative makes it flightier. Read per faction + location.
 */
function moraleShift(state: GameState, faction: Faction | null, ctx: BattleCtx): number {
  if (!faction) return 0;
  return sumModifierValues(state, "morale", {
    faction,
    provinceId: ctx.provinceId,
    seaZoneId: ctx.seaZoneId,
  });
}

/**
 * §8.4 Great Bombard unlock check. Per CONTRACT2 §12.6 the flag
 * `Player.greatBombardUnlocked` is canonical; the equivalent Omen #34 side-channel
 * is a `kind:"unlock"` modifier carrying `data.unlock === "GREAT_BOMBARD"`.
 */
function greatBombardUnlocked(state: GameState, playerId: string): boolean {
  const p = state.players.find((pl) => pl.id === playerId);
  if (p?.greatBombardUnlocked) return true;
  const fac = factionOf(state, playerId);
  const unlocks = getModifiers(state, "unlock", fac ? { faction: fac } : undefined);
  return unlocks.some((m) => m.data?.unlock === GREAT_BOMBARD.variant);
}

/**
 * CANON sea-resupply rule (GD §8.2): a besieged COASTAL city cannot be starved
 * while at least one of its adjacent sea zones remains friendly/neutral — an open
 * lane keeps the garrison fed. Starvation resumes only once EVERY adjacent sea
 * zone is enemy-controlled (blockaded by someone other than the defender).
 */
function seaResupplyActive(state: GameState, prov: Province, defenderOwnerId: string | null): boolean {
  if (!prov.coastal) return false;
  const seaIds = new Set(state.seaZones.map((z) => z.id));
  const adjacentSeas = neighborsOf(prov.id).filter((n) => seaIds.has(n));
  if (adjacentSeas.length === 0) return false; // no sea lane → treat as landlocked
  for (const id of adjacentSeas) {
    const z = state.seaZones.find((zz) => zz.id === id);
    if (!z) continue;
    const enemyControlled = z.blockadedBy != null && z.blockadedBy !== defenderOwnerId;
    if (!enemyControlled) return true; // one open lane resupplies the city
  }
  return false; // all lanes blockaded by the enemy → the garrison can starve
}

/**
 * §13 conquest track — post a one-time prestige award as a round-scoped
 * `prestige_pending` modifier (CONTRACT2 §12.8). The prestige subsystem CONSUMES
 * these at Cleanup; combat NEVER mutates `Player.prestige` directly (avoids the
 * double-count). Returns a new state.
 */
function postPrestigePending(
  state: GameState,
  faction: Faction | null,
  value: number,
  reason: string,
  provinceId?: string,
): GameState {
  if (!faction || value === 0) return state;
  const mod: ActiveModifier = {
    id: `prestige-pending-${state.round}-${reason}-${state.activeModifiers.length}`,
    scope: "round",
    kind: "prestige_pending",
    target: provinceId ? { faction, provinceId } : { faction },
    value,
    data: { reason, source: "combat" },
  };
  return addModifier(state, mod);
}

/**
 * §7.7 tactic step: consume at most ONE queued tactic for `side` from the (local)
 * battle queue and resolve it via the tactic subsystem's frozen `playTactic`.
 * Called attacker-first, then defender, at the top of every battle round, so a
 * side may play ≤1 card per battle round. Returns the (possibly new) state; if no
 * card is queued it returns the same reference untouched.
 */
function playSideTactic(
  state: GameState,
  ctx: BattleCtx,
  side: Role,
  rng: Rng,
): GameState {
  const battle = ctx.battle;
  if (!battle) return state;
  const queue: TacticCardId[] | undefined =
    side === "attacker" ? battle.attackerTactics : battle.defenderTactics;
  if (!queue || queue.length === 0) return state;
  const cardId = queue.shift(); // consume from the LOCAL copy (input never mutated)
  if (!cardId) return state;
  return playTactic(state, battle, side, cardId, rng);
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
 * assaults. Mutates `ctx.attackers`/`ctx.defenders` in place; reads `state` for
 * combat/morale modifiers and retreat adjacency. Because a tactic played this
 * round (§7.7) posts fresh modifiers, `state` is THREADED: the tactic hook may
 * return a new state, which is used for the rest of the round and returned to the
 * caller alongside the {@link EngineOutcome} (so posted modifiers survive).
 */
function runEngine(
  state: GameState,
  ctx: BattleCtx,
  rng: Rng,
): { outcome: EngineOutcome; state: GameState } {
  let s = state;
  const attackerInitial = sideTotal(ctx.attackers);
  const defenderInitial = sideTotal(ctx.defenders);
  let rounds = 0;
  let attackerRouted = false;
  let defenderRouted = false;
  let attackerRetreatTo: string | undefined;
  let defenderRetreatTo: string | undefined;
  const cap = 50; // guard against pathological non-terminating stalemates

  if (attackerInitial === 0 || defenderInitial === 0) {
    return { outcome: { rounds: 0, attackerRouted, defenderRouted }, state: s };
  }

  while (rounds < cap) {
    rounds += 1;

    // 0. Tactic step (§7.7): attacker declares first, then defender; ≤1 card per
    // side per battle round. Posted modifiers apply from this round onward.
    if (ctx.battle) {
      s = playSideTactic(s, ctx, "attacker", rng);
      s = playSideTactic(s, ctx, "defender", rng);
    }

    // 1. Ranged step (§7.2): compute both sides' hits pre-removal (simultaneous).
    if (ctx.rangedTypes.length > 0) {
      const at = sideTotal(ctx.attackers);
      const dt = sideTotal(ctx.defenders);
      const af = attackerFlat(s, ctx, at, dt);
      const df = defenderFlat(s, ctx, at, dt);
      const ah = generateHits(s, ctx.attackers, "attacker", "ranged", af, ctx, rng);
      const dh = generateHits(s, ctx.defenders, "defender", "ranged", df, ctx, rng);
      removeCasualties(ctx.defenders, ah);
      removeCasualties(ctx.attackers, dh);
      if (sideTotal(ctx.attackers) === 0 || sideTotal(ctx.defenders) === 0) break;
    }

    // 2. Melee step (§7.2): both sides roll simultaneously.
    {
      const at = sideTotal(ctx.attackers);
      const dt = sideTotal(ctx.defenders);
      const af = attackerFlat(s, ctx, at, dt);
      const df = defenderFlat(s, ctx, at, dt);
      const ah = generateHits(s, ctx.attackers, "attacker", "melee", af, ctx, rng);
      const dh = generateHits(s, ctx.defenders, "defender", "melee", df, ctx, rng);
      // 3. Apply casualties (§7.2).
      removeCasualties(ctx.defenders, ah);
      removeCasualties(ctx.attackers, dh);
    }

    const at = sideTotal(ctx.attackers);
    const dt = sideTotal(ctx.defenders);
    if (at === 0 || dt === 0) break;

    // 4. Morale / rout check (§7.5). Naval combat has no rout. A `morale`
    // modifier shifts the rout threshold per side (steadier = harder to rout).
    if (!ctx.isNaval) {
      let routed = false;
      const atkRoutThreshold = clamp(
        COMBAT_MODS.routThreshold - moraleShift(s, ctx.attackerFaction, ctx),
        0,
        6,
      );
      const defRoutThreshold = clamp(
        COMBAT_MODS.routThreshold - moraleShift(s, ctx.defenderFaction, ctx),
        0,
        6,
      );
      // §7.5 rout if a side lost ≥50% of its starting stack, on d6 ≤ threshold.
      if (1 - at / attackerInitial >= COMBAT_MODS.routLossFraction) {
        if (rng.rollD6() <= atkRoutThreshold) {
          attackerRouted = true;
          routed = true;
        }
      }
      if (1 - dt / defenderInitial >= COMBAT_MODS.routLossFraction) {
        if (rng.rollD6() <= defRoutThreshold) {
          defenderRouted = true;
          routed = true;
        }
      }
      if (attackerRouted) {
        // §7.5 pursuit: each enemy CAVALRY inflicts 1 automatic hit.
        removeCasualties(ctx.attackers, cavalryCount(ctx.defenders));
        attackerRetreatTo = findRetreat(s, ctx.attackerOwnerId, ctx.provinceId);
      }
      if (defenderRouted) {
        removeCasualties(ctx.defenders, cavalryCount(ctx.attackers));
        defenderRetreatTo = findRetreat(s, ctx.defenderOwnerId, ctx.provinceId);
      }
      if (routed) break;
    }
  }

  return {
    outcome: { rounds, attackerRouted, defenderRouted, attackerRetreatTo, defenderRetreatTo },
    state: s,
  };
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

  // §7.7 Chain Across the Horn (FL-18 / CONTRACT2 §12.10): a coastal province the
  // defender holds cannot be the target of an amphibious assault while a
  // `wall_mod{amphibiousImmune}` is in force. The amphibious approach is repelled
  // without resolving — no dice, no capture (mirrors the freeze_sea guard).
  if ((battle.amphibious ?? false) && prov) {
    const defFac = factionOf(next, battle.defenderId);
    const immune = getModifiers(next, "wall_mod", {
      faction: defFac ?? undefined,
      provinceId: prov.id,
    }).some((m) => m.data?.amphibiousImmune === true);
    if (immune) {
      const out = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "battle",
        actors: [battle.attackerId, ...(battle.defenderId ? [battle.defenderId] : [])],
        targets: [prov.id],
        message: `The chain across the harbour bars an amphibious assault on ${prov.name}.`,
        data: { rounds: 0, amphibiousBarred: true },
      });
      return {
        state: { ...out, rngCursor: rng.cursor },
        winnerId: null,
        rounds: 0,
        attacker: emptyReport,
        defender: emptyReport,
      };
    }
  }

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
    // §7.7 LOCAL copies of the queued tactics: consuming one/round here never
    // mutates the caller's input battle (purity).
    battle: {
      ...battle,
      attackerTactics: [...(battle.attackerTactics ?? [])],
      defenderTactics: [...(battle.defenderTactics ?? [])],
    },
  };

  const engine = runEngine(next, ctx, rng);
  const outcome = engine.outcome;
  // A tactic (§7.7) may have posted modifiers → thread the resulting state and
  // re-locate the province on it before ownership/capture writes.
  let post = engine.state;
  const provPost = battle.provinceId
    ? post.provinces.find((p) => p.id === battle.provinceId)
    : undefined;

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

  writeBack(post, attackers, "army", outcome.attackerRouted, outcome.attackerRetreatTo);
  writeBack(post, defenders, "army", outcome.defenderRouted, outcome.defenderRetreatTo);

  // §7: winner takes the province if the attacker prevails in a field battle.
  let captured = false;
  const capturedTier = provPost?.walls.tier ?? 0;
  if (winnerId === battle.attackerId && !outcome.attackerRouted && provPost) {
    captureProvince(post, provPost, battle.attackerId);
    captured = true;
  }

  // §13 conquest-prestige signals — POST as prestige_pending (CONTRACT2 §12.8);
  // the prestige subsystem consumes these at Cleanup. Never mutate prestige here.
  const pending: Record<string, number> = {};
  if (winnerId) {
    const winnerFaction = factionOf(post, winnerId);
    // §13.1 decisive battle (a wipe/rout) → +1.
    post = postPrestigePending(
      post,
      winnerFaction,
      CONQUEST_PRESTIGE.decisiveBattle,
      "decisive_battle",
      provPost?.id,
    );
    pending.decisiveBattle = CONQUEST_PRESTIGE.decisiveBattle;
    // §13.1 win a field battle outnumbered (loser's starting stack larger) → +1.
    const sumMap = (m: Map<string, number>): number =>
      [...m.values()].reduce((a, b) => a + b, 0);
    const winnerStart = winnerId === battle.attackerId ? sumMap(atkInitial) : sumMap(defInitial);
    const loserStart = winnerId === battle.attackerId ? sumMap(defInitial) : sumMap(atkInitial);
    if (loserStart > winnerStart) {
      post = postPrestigePending(
        post,
        winnerFaction,
        CONQUEST_PRESTIGE.outnumberedWin,
        "outnumbered_win",
        provPost?.id,
      );
      pending.outnumberedWin = CONQUEST_PRESTIGE.outnumberedWin;
    }
    // §13.1 take a walled city (T1+) by storm → +2, or +3 at MAP tier ≥ 4 (T4–T5).
    // FL-14: with the restored 5-tier keyspace, "high tier" is tier ≥ 4 (was ≥ 2
    // under the collapsed 4-HP-tier model).
    if (captured && capturedTier > 0) {
      const award =
        capturedTier >= 4
          ? CONQUEST_PRESTIGE.takeWalledCityHighTier
          : CONQUEST_PRESTIGE.takeWalledCity;
      post = postPrestigePending(post, winnerFaction, award, "take_walled_city", provPost?.id);
      pending.takeWalledCity = award;
    }
  }

  const attackerReport = report(attackers, atkInitial, outcome.attackerRouted);
  const defenderReport = report(defenders, defInitial, outcome.defenderRouted);

  let logged = appendLog(post, {
    round: post.round,
    phase: post.phase,
    type: "battle",
    actors: [battle.attackerId, ...(battle.defenderId ? [battle.defenderId] : [])],
    targets: provPost ? [provPost.id] : [],
    message: provPost
      ? `Battle at ${provPost.name}: ${winnerId ?? "no one"} prevails after ${outcome.rounds} round(s).`
      : `Battle resolved after ${outcome.rounds} round(s).`,
    data: {
      rounds: outcome.rounds,
      winnerId,
      attackerLosses: attackerReport.losses,
      defenderLosses: defenderReport.losses,
      attackerRouted: outcome.attackerRouted,
      defenderRouted: outcome.defenderRouted,
      prestigePending: pending,
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

  const emptyReport: CasualtyReport = { losses: {}, routed: [] };

  // §7.6 / CONTRACT2 §12.10 `freeze_sea`: a frozen sea zone cannot be fought in
  // (movement enforces the freeze; combat at minimum refuses to resolve here).
  if (
    battle.seaZoneId &&
    getModifiers(next, "freeze_sea", { seaZoneId: battle.seaZoneId }).length > 0
  ) {
    let out = next;
    if (zone) {
      out = appendLog(out, {
        round: out.round,
        phase: out.phase,
        type: "battle",
        actors: [battle.attackerId],
        targets: [zone.id],
        message: `Ice locks ${zone.name}; no naval battle is fought.`,
        data: { rounds: 0, naval: true, frozen: true },
      });
    }
    return {
      state: { ...out, rngCursor: rng.cursor },
      winnerId: null,
      rounds: 0,
      attacker: emptyReport,
      defender: emptyReport,
    };
  }

  const attackers = next.fleets
    .filter((f) => battle.attackerStackIds.includes(f.id))
    .map(toWorking);
  const defenders = next.fleets
    .filter((f) => battle.defenderStackIds.includes(f.id))
    .map(toWorking);

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
    // §7.7 LOCAL copies of the queued tactics (never mutate the input battle).
    battle: {
      ...battle,
      attackerTactics: [...(battle.attackerTactics ?? [])],
      defenderTactics: [...(battle.defenderTactics ?? [])],
    },
  };

  const engine = runEngine(next, ctx, rng);
  const outcome = engine.outcome;
  let post = engine.state;
  const zonePost = battle.seaZoneId
    ? post.seaZones.find((z) => z.id === battle.seaZoneId)
    : undefined;

  const atkAlive = sideTotal(attackers);
  const defAlive = sideTotal(defenders);
  let winnerId: string | null = null;
  if (atkAlive > 0 && defAlive === 0) winnerId = battle.attackerId;
  else if (defAlive > 0 && atkAlive === 0) winnerId = battle.defenderId;

  writeBack(post, attackers, "fleet", false, undefined);
  writeBack(post, defenders, "fleet", false, undefined);

  // §7.6 the winner controls the zone (enabling blockade).
  if (zonePost && winnerId) zonePost.blockadedBy = winnerId;

  // §13.1 decisive naval battle (one side wiped) → +1 prestige_pending.
  const pending: Record<string, number> = {};
  if (winnerId) {
    post = postPrestigePending(
      post,
      factionOf(post, winnerId),
      CONQUEST_PRESTIGE.decisiveBattle,
      "decisive_battle",
    );
    pending.decisiveBattle = CONQUEST_PRESTIGE.decisiveBattle;
  }

  const attackerReport = report(attackers, atkInitial, false);
  const defenderReport = report(defenders, defInitial, false);

  let logged = appendLog(post, {
    round: post.round,
    phase: post.phase,
    type: "battle",
    actors: [battle.attackerId, ...(battle.defenderId ? [battle.defenderId] : [])],
    targets: zonePost ? [zonePost.id] : [],
    message: zonePost
      ? `Naval battle in ${zonePost.name}: ${winnerId ?? "no one"} controls the zone after ${outcome.rounds} round(s).`
      : `Naval battle resolved after ${outcome.rounds} round(s).`,
    data: {
      rounds: outcome.rounds,
      winnerId,
      naval: true,
      attackerLosses: attackerReport.losses,
      defenderLosses: defenderReport.losses,
      prestigePending: pending,
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

  // 2. Bombardment (§8.2.2 / §8.4) — generic SIEGE units roll 1 die each; a Great
  // Bombard (§8.4) rolls GREAT_BOMBARD.bombardDice dice when its owner has it
  // unlocked, and lifts the §8.3 T5 masonry cap for the whole train.
  const defenderFaction = factionOf(next, prov.ownerId);
  const besiegerFaction = factionOf(next, siege.besiegerId);
  // §8.4 CONTRACT2 §12.6: enhanced fire only if the besieger has the Bombard unlocked.
  const bombardUnlocked = greatBombardUnlocked(next, siege.besiegerId);
  let genericGuns = 0;
  let greatBombards = 0;
  for (const w of besiegers) {
    genericGuns += w.units[UnitType.SIEGE] ?? 0;
    for (const v of w.variants) {
      if (v.base !== UnitType.SIEGE) continue;
      // §8.4 an UNLOCKED Great Bombard fires enhanced; a locked one is a plain gun.
      if (v.variant === GREAT_BOMBARD.variant && bombardUnlocked) greatBombards += v.count;
      else genericGuns += v.count;
    }
  }
  // Generic guns roll first (keeps the deterministic bombardment RNG order).
  let genericDamage = 0;
  if (genericGuns > 0) {
    for (const roll of rng.rollDice(genericGuns)) genericDamage += SIEGE.bombardDamage[roll] ?? 0;
  }
  // §8.3 T5 masonry cap (FL-01): against an INTACT tier-T5 (Theodosian) wall an
  // ORDINARY siege train inflicts at most SIEGE.t5MasonryCapPerRound Wall-HP per
  // round IN TOTAL (not per unit). This is a property of the intact wall, NOT of
  // the defender's faction — a non-Byzantine holder of Constantinople is equally
  // protected. An emplaced UNLOCKED Great Bombard lifts the cap for the WHOLE
  // besieging train (§8.4). `greatBombards` is > 0 only when unlocked.
  const intactT5Wall = prov.walls.tier === 5 && prov.walls.hp > 0;
  const masonryCapLifted = greatBombards > 0;
  if (intactT5Wall && !masonryCapLifted) {
    genericDamage = Math.min(genericDamage, SIEGE.t5MasonryCapPerRound);
  }
  // §8.4 Great Bombard: bombardDice per piece, capped per round, ignores the cap.
  let greatBombardDamage = 0;
  for (let i = 0; i < greatBombards; i += 1) {
    let piece = 0;
    for (const roll of rng.rollDice(GREAT_BOMBARD.bombardDice)) {
      piece += SIEGE.bombardDamage[roll] ?? 0;
    }
    greatBombardDamage += Math.min(piece, GREAT_BOMBARD.maxWallDamagePerRound);
  }
  // §8 / CONTRACT2 §12.10 `siege_mod` — event/tactic bombardment tweak (signed).
  const siegeMod = besiegerFaction
    ? sumModifierValues(next, "siege_mod", { faction: besiegerFaction, provinceId: prov.id })
    : 0;
  let wallDamage = genericDamage + greatBombardDamage;
  if ((genericGuns > 0 || greatBombards > 0) && siegeMod !== 0) {
    wallDamage = Math.max(0, wallDamage + siegeMod);
  }
  prov.walls.hp = Math.max(0, prov.walls.hp - wallDamage);
  if (prov.walls.hp === 0) live.breached = true;
  live.wallHp = prov.walls.hp;
  // §8 multi-round progression tags: circumvallate → bombard → assault.
  live.phase = live.breached ? "assault" : "bombard";
  live.roundsBesieged = live.roundsElapsed;

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

  // 3. Garrison starvation (§8.2 step 3, FL-12) — driven off live.grainStores.
  // The Granary's +2 is folded into the INITIAL grainStores at siege creation
  // (§9.1), NOT a parallel holdout constant. Each blockaded round with no
  // store-preserving effect depletes 1 store; once stores hit 0 the garrison
  // loses SIEGE.starvationLossPerRound/round (weakest first).
  //
  // CANON sea-resupply (GD §8.2): a COASTAL city with an open (friendly/neutral)
  // adjacent sea lane never depletes or hungers — only a fully enemy-controlled
  // sea allows it to starve.
  const resupplied = seaResupplyActive(next, prov, prov.ownerId);
  // §7.7 defender-side store-preserving siege_mods (Night Sortie / Sails from the
  // West): `noDepletion` halts depletion & hunger this round; `restoreGrain`
  // (Sails) returns depleted stores even under full blockade; `besiegerLoses`
  // (Night Sortie) costs the besieger units.
  const storeMods = defenderFaction
    ? getModifiers(next, "siege_mod", { faction: defenderFaction, provinceId: prov.id })
    : [];
  const noDepletion = storeMods.some((m) => m.data?.noDepletion === true);
  const restoreGrain = storeMods.reduce(
    (acc, m) => acc + (typeof m.data?.restoreGrain === "number" ? (m.data.restoreGrain as number) : 0),
    0,
  );
  const besiegerLoses = storeMods.reduce(
    (acc, m) => acc + (typeof m.data?.besiegerLoses === "number" ? (m.data.besiegerLoses as number) : 0),
    0,
  );
  if (restoreGrain > 0) live.grainStores += restoreGrain; // §7.7 Sails from the West
  if (besiegerLoses > 0) removeCasualties(besiegers, besiegerLoses); // §7.7 Night Sortie
  let starved = 0;
  if (!resupplied && !noDepletion) {
    if (live.grainStores <= 0) {
      starved = SIEGE.starvationLossPerRound;
      removeCasualties(defenders, starved); // §8.2 step 3 weakest first
      live.starvationCounter = (live.starvationCounter ?? 0) + 1;
    } else {
      live.grainStores -= 1;
    }
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
    // §8.4 assault row / §8.2 step 4 (FL-13): storming SIEGE units (and an
    // emplaced Great Bombard) lend the standard SIEGE +3 vs a standing wall.
    const hasBombardSupport = besiegers.some((w) =>
      w.variants.some((v) => v.variant === GREAT_BOMBARD.variant && v.count > 0),
    );
    const hasGenericSiegeSupport = besiegers.some(
      (w) =>
        (w.units[UnitType.SIEGE] ?? 0) > 0 ||
        w.variants.some(
          (v) => v.base === UnitType.SIEGE && v.variant !== GREAT_BOMBARD.variant && v.count > 0,
        ),
    );
    const siegeAssaultBonus = hasBombardSupport
      ? GREAT_BOMBARD.bombardVsWalls
      : hasGenericSiegeSupport
        ? SIEGE.bombardVsWalls
        : 0;
    const ctx: BattleCtx = {
      attackers: besiegers,
      defenders,
      attackerOwnerId: siege.besiegerId,
      defenderOwnerId: prov.ownerId,
      terrain: prov.terrain,
      wallsHp: prov.walls.hp, // §8.2.4 wall bonus + escalade only while HP > 0
      wallDefBonus: WALL_TIERS[prov.walls.tier]?.defBonus ?? 0,
      siegeAssaultBonus,
      amphibious: false,
      rangedTypes: [UnitType.ARCHER],
      isNaval: false,
      provinceId: prov.id,
      attackerFaction: factionOf(next, siege.besiegerId),
      defenderFaction,
    };
    // No PendingBattle drives a siege assault (ctx.battle undefined), so no tactic
    // is played and runEngine returns the same state reference.
    const outcome = runEngine(next, ctx, rng).outcome;
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

  const capturedTier = prov.walls.tier;
  if (captured) {
    captureProvince(next, prov, siege.besiegerId);
  } else {
    // Mirror updated siege progress back onto state.
    prov.siege = { ...live };
    const idx = next.siegeStates.findIndex((s) => s.provinceId === prov.id);
    if (idx >= 0) next.siegeStates[idx] = { ...live };
    else next.siegeStates.push({ ...live });
  }

  // §13 conquest-prestige on a storm — POST prestige_pending (CONTRACT2 §12.8),
  // consumed by the prestige subsystem at Cleanup. Never mutate prestige here.
  let scored = next;
  const pending: Record<string, number> = {};
  if (captured) {
    const bf = factionOf(scored, siege.besiegerId);
    // §13.1 storming a defended city is a decisive result → +1.
    scored = postPrestigePending(scored, bf, CONQUEST_PRESTIGE.decisiveBattle, "decisive_battle", prov.id);
    pending.decisiveBattle = CONQUEST_PRESTIGE.decisiveBattle;
    // §13.1 take a walled city (T1+) by siege → +2, or +3 at MAP tier ≥ 4 (T4–T5).
    // FL-14: "high tier" is tier ≥ 4 under the restored 5-tier keyspace.
    if (capturedTier > 0) {
      const award =
        capturedTier >= 4
          ? CONQUEST_PRESTIGE.takeWalledCityHighTier
          : CONQUEST_PRESTIGE.takeWalledCity;
      scored = postPrestigePending(scored, bf, award, "take_walled_city", prov.id);
      pending.takeWalledCity = award;
    }
  }

  const out = appendLog(scored, {
    round: scored.round,
    phase: scored.phase,
    type: "siege",
    actors: [siege.besiegerId],
    targets: [prov.id],
    message: captured
      ? `${siege.besiegerId} storms ${prov.name}!`
      : `Siege of ${prov.name}: walls at ${prov.walls.hp} HP after round ${live.roundsElapsed}.`,
    data: {
      wallHp: prov.walls.hp,
      wallDamage,
      genericDamage,
      greatBombardDamage,
      starved,
      resupplied,
      captured,
      breached: live.breached,
      assaultRounds,
      prestigePending: pending,
    },
  });

  return {
    state: { ...out, rngCursor: rng.cursor },
    captured,
    wallHpRemaining: prov.walls.hp,
  };
}
