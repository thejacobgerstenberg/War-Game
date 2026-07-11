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
  GREAT_BOMBARD_ASSAULT_DICE,
  SIEGE,
  SIEGE_ENGINES_FIGHT_AT_BREACH,
  STACKING,
  UNIQUE_UNIT_OVERRIDES,
  UNIT_STATS,
  WALL_TIERS,
} from "./balance.js";
import { appendLog, type LogInput } from "./logEntry.js";
import { neighborsOf } from "./adjacency.js";
import { addModifier, getModifiers, removeModifier, sumModifierValues } from "./modifiers.js";
import { playTactic } from "./tactics/index.js";
// Card DATA is imported from the data-only module (not the subsystem barrel) so
// combat can classify queued cards (reaction vs proactive, §7.7) without a
// runtime dependency on the tactic resolver itself.
import { TACTIC_CARD_BY_ID } from "./tactics/cards.js";

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
   * §7.2 step 1 / §8.4 assault row (RAW canon): true on a siege ASSAULT, where the
   * besieger's SIEGE engines (and an emplaced Great Bombard) roll their OWN attack
   * dice that ADD to the storming troops' hits (see {@link rollSiegeEngineHits}).
   * Absent/false for field and naval battles (SIEGE lends no field dice, §6.1), so
   * their RNG streams are untouched.
   */
  siegeEnginesActive?: boolean;
  /**
   * §7.2 step 1 / §8.4: when true the SIEGE engine dice roll in EVERY assault round
   * INCLUDING at a breach (wallsHp = 0). When false they fall silent once the wall
   * is breached. Sourced from balance.SIEGE_ENGINES_FIGHT_AT_BREACH.
   */
  siegeEnginesFightAtBreach?: boolean;
  /**
   * §8.4: dice threshold modifier for the engine dice — the standard SIEGE
   * +3-vs-walls (balance.SIEGE.bombardVsWalls). With SIEGE CV 0 this resolves to a
   * hit on d6 >= clamp(7 − 0 − 3, 2, 6) = 4+ (parity with the balance sim).
   */
  siegeEngineMod?: number;
  /** §8.4 delta 3: whether an emplaced Great Bombard is past its emplacement round. */
  bombardEmplaced?: boolean;
  /** §8.4: assault dice an emplaced Great Bombard adds (balance.GREAT_BOMBARD_ASSAULT_DICE). */
  bombardAssaultDice?: number;
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
  /**
   * §7.7 Feigned Retreat: the side withdrew VOLUNTARILY before dice — the battle
   * ended with no pursuit. Distinct from a rout: no pursuit hits, no rout entry in
   * the casualty report, and the "winner" holds the field by cession (no
   * decisive-battle/sack credit).
   */
  attackerWithdrew?: boolean;
  defenderWithdrew?: boolean;
}

/** One rolled die with the threshold it must meet, for the §7.7 reroll layer. */
interface RolledDie {
  roll: number;
  threshold: number;
  /** §7.7: no die may be rerolled more than once. */
  rerolled: boolean;
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

/**
 * Sum of FLAT tactic/event combat modifiers targeting this side (§7.3
 * activeModifiers). Marshal-review "+N dice" fix: modifiers flagged
 * `data.dice === true` are NOT a to-hit shift — they are N actual EXTRA DICE
 * rolled in the melee step (see {@link tacticExtraDice}), so they are excluded
 * here. Reroll grants (`data.reroll`) and the Greek Fire auto-win flag
 * (`data.autoWinNaval`) carry no flat value either and are likewise excluded.
 */
function tacticMod(
  state: GameState,
  faction: Faction | null,
  provinceId?: string,
  seaZoneId?: string,
): number {
  if (!faction) return 0;
  return getModifiers(state, "combat_mod", { faction, provinceId, seaZoneId })
    .filter(
      (m) =>
        m.data?.dice !== true &&
        m.data?.reroll === undefined &&
        m.data?.autoWinNaval !== true,
    )
    .reduce((acc, m) => acc + (m.value ?? 0), 0);
}

/** The faction fighting on `role`'s side of this battle. */
function sideFaction(ctx: BattleCtx, role: Role): Faction | null {
  return role === "attacker" ? ctx.attackerFaction : ctx.defenderFaction;
}

/** §7.7: a side-tagged modifier applies only to the side it was played for. */
function modMatchesSide(data: Record<string, unknown> | undefined, role: Role): boolean {
  const s = data?.side;
  return s === undefined || s === role;
}

/**
 * §7.7 "+N dice" CONSUMER (marshal combat cluster): total EXTRA melee dice this
 * side rolls this step, from `combat_mod` modifiers posted by the tactic
 * subsystem with `data.dice === true` (veterans-of-the-border, pilot-of-the-
 * narrows, condottieri-contract, holy-war-proclaimed, master-founders-hired's
 * assault die). Per §7.7 the dice recur "in each melee step" while the modifier
 * lives (it expires with the round).
 */
function tacticExtraDice(state: GameState, ctx: BattleCtx, role: Role): number {
  const faction = sideFaction(ctx, role);
  if (!faction) return 0;
  return getModifiers(state, "combat_mod", {
    faction,
    provinceId: ctx.provinceId,
    seaZoneId: ctx.seaZoneId,
  })
    .filter((m) => m.data?.dice === true && modMatchesSide(m.data, role))
    .reduce((acc, m) => acc + (m.value ?? 1), 0);
}

/**
 * §7.7 reroll CONSUMER (marshal combat cluster): the reroll grants in force for
 * this side — `combat_mod` (locked-shields, the-white-knights-stroke) and
 * `siege_mod` (ladders-and-fascines, siege assaults) modifiers carrying
 * `data.reroll`. Returned in activeModifiers order (deterministic).
 */
function tacticRerollMods(state: GameState, ctx: BattleCtx, role: Role): ActiveModifier[] {
  const faction = sideFaction(ctx, role);
  if (!faction) return [];
  const query = { faction, provinceId: ctx.provinceId, seaZoneId: ctx.seaZoneId };
  return [
    ...getModifiers(state, "combat_mod", query),
    ...getModifiers(state, "siege_mod", query),
  ].filter((m) => typeof m.data?.reroll === "string" && modMatchesSide(m.data, role));
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
  // §7.2 step 1 / §8.4 (RAW canon): the storming TROOPS get NO flat +3 here — the
  // +3-vs-walls now lives on the besieger's SIEGE engines' OWN dice, which roll
  // separately in {@link rollSiegeEngineHits} and ADD to the attacker's hits.
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
 * §8.4 (delta 3, 1-round emplacement): a freshly placed or relocated Great Bombard
 * cannot FIRE (bombard the walls) until the round AFTER it entered play. The
 * authoritative arrival clock is the {@link GameState.greatBombard} singleton's
 * `emplacedRound` (set by events on spawn and by combat on capture/re-emplacement):
 * the gun may bombard only once
 * `state.round >= emplacedRound + GREAT_BOMBARD.emplacementRounds`. When there is no
 * singleton tracker, or it does not describe the GB emplaced at THIS province, we
 * have no arrival clock and default to "emplaced" (back-compat with hand-built
 * fixtures that field a GREAT_BOMBARD variant without the tracker).
 */
function greatBombardEmplaced(state: GameState, prov: Province): boolean {
  const gb = state.greatBombard;
  if (!gb || !gb.inPlay || gb.provinceId !== prov.id) return true;
  return state.round >= gb.emplacedRound + GREAT_BOMBARD.emplacementRounds;
}

/**
 * §8.4 Upkeep row CONSUMER (marshal major "no silence-when-unpaid"): when the
 * owner could not pay the Bombard's 3-grain upkeep, economy.ts sets
 * `GameState.greatBombard.silenced` — the gun never deserts, it falls SILENT.
 * While silenced (and the tracker describes the gun emplaced at THIS province)
 * it rolls NO bombardment dice and NO assault dice; economy clears the flag the
 * next round upkeep is paid. Absent/mismatched tracker → not silenced.
 */
function greatBombardSilenced(state: GameState, prov: Province): boolean {
  const gb = state.greatBombard;
  return !!gb && gb.inPlay && gb.provinceId === prov.id && gb.silenced === true;
}

/** Ids of stacks on a side that carry a live GREAT_BOMBARD variant (§8.4). */
function bombardStacks(side: Working[]): Set<string> {
  const ids = new Set<string>();
  for (const w of side) {
    if (w.variants.some((v) => v.variant === GREAT_BOMBARD.variant && v.count > 0)) {
      ids.add(w.id);
    }
  }
  return ids;
}

/**
 * §8.4 (delta 3, capture-passes-intact): the Great Bombard is NEVER destroyed by
 * battle. When the DEFEATED side's escort stack that carried it is DESTROYED —
 * routed with no retreat, or wiped, so it no longer survives in `state.armies` with
 * the variant — the gun passes INTACT to the victor as loot: it is attached to a
 * surviving winner stack and the singleton {@link GameState.greatBombard} tracker is
 * re-homed to the new owner/province and RE-EMPLACED (a captured gun sits a fresh
 * emplacement round before it may fire again, per {@link greatBombardEmplaced}). A
 * loser stack that RETREATED intact keeps its gun (not a capture). Mutates and
 * returns the (already-cloned) state. `loserWorking` are the PRE-writeBack working
 * copies; `loserBombardIds` is {@link bombardStacks} captured before combat.
 */
function salvageBombardToVictor(
  state: GameState,
  loserWorking: Working[],
  loserBombardIds: Set<string>,
  winnerId: string | null,
  winnerStackIds: string[],
): GameState {
  if (!winnerId || loserBombardIds.size === 0) return state;
  // Did a GB-carrying loser stack get DESTROYED (rather than merely retreat intact)?
  let captured = 0;
  for (const w of loserWorking) {
    if (!loserBombardIds.has(w.id)) continue;
    const survivor = state.armies.find((a) => a.id === w.id);
    const kept = survivor?.variants?.some(
      (v) => v.variant === GREAT_BOMBARD.variant && v.count > 0,
    );
    if (!kept) captured += 1; // escort destroyed → the gun is loot, not scrap
  }
  if (captured === 0) return state;
  // Attach to a surviving winner stack; else re-home the tracker only (degenerate:
  // the victor kept no stack — e.g. a synthetic garrison held the city).
  const winnerArmy = state.armies.find(
    (a) => winnerStackIds.includes(a.id) && a.ownerId === winnerId && realCount(a) > 0,
  );
  if (winnerArmy) {
    const variants = (winnerArmy.variants ??= []);
    const existing = variants.find((v) => v.variant === GREAT_BOMBARD.variant);
    if (existing) existing.count += captured;
    else variants.push({ base: GREAT_BOMBARD.base, variant: GREAT_BOMBARD.variant, count: captured });
    state.greatBombard = {
      inPlay: true,
      ownerId: winnerId,
      provinceId: winnerArmy.locationId,
      emplacedRound: state.round,
    };
  } else if (state.greatBombard) {
    state.greatBombard = {
      ...state.greatBombard,
      inPlay: true,
      ownerId: winnerId,
      emplacedRound: state.round,
    };
  }
  return state;
}

/**
 * CANON sea-resupply rule (GD §8.2 / §8.2.3): a besieged COASTAL city cannot be
 * starved while at least one of its adjacent sea zones remains friendly/neutral —
 * an open lane keeps the garrison fed. Starvation resumes only once EVERY adjacent
 * sea zone is enemy-controlled (blockaded by someone other than the defender).
 *
 * §8.2.3 clarification (coordinator): sea-resupply SUSPENDS starvation ONLY. It
 * does NOT freeze naval/harbor action in the adjacent sea — the besieger may still
 * CONTEST the blockade and the defender may still receive HARBOR REINFORCEMENT via
 * an ordinary naval battle. This is honoured structurally: this predicate is read
 * SOLELY to gate the §8.2 step 3 starvation branch below; {@link resolveNaval}
 * (blockade contest / harbor reinforcement in the adjacent sea) is entirely
 * independent of it and is never blocked by an active resupply.
 */
function seaResupplyActive(state: GameState, prov: Province, defenderOwnerId: string | null): boolean {
  if (!prov.coastal) return false;
  const seaIds = new Set(state.seaZones.map((z) => z.id));
  const adjacentSeas = neighborsOf(prov.id).filter((n) => seaIds.has(n));
  if (adjacentSeas.length === 0) return false; // no sea lane → treat as landlocked
  for (const id of adjacentSeas) {
    // Sea-resupply FRESH (marshal major "sea-resupply keys off stale
    // blockadedBy"): enemy control is computed from the war fleets ACTUALLY
    // PRESENT in the zone at resolution time — an enemy GALLEY/WARSHIP present
    // and uncontested by a defender war fleet (§8.2 step 3 / §5.3) — never from
    // the stale `SeaZone.blockadedBy` bookkeeping field, so a phantom blockade
    // whose fleet has sailed away cannot starve a port.
    if (!zoneEnemyControlled(state, id, defenderOwnerId)) return true; // open lane feeds the city
  }
  return false; // every lane held by enemy war fleets → the garrison can starve
}

/** War-fleet units (GALLEY/WARSHIP, incl. naval variants) aboard a fleet (§5.3). */
function warUnitCount(f: Fleet): number {
  let n = (f.units[UnitType.GALLEY] ?? 0) + (f.units[UnitType.WARSHIP] ?? 0);
  for (const v of f.variants ?? []) {
    if (v.base === UnitType.GALLEY || v.base === UnitType.WARSHIP) n += v.count;
  }
  return n;
}

/**
 * §8.2 step 3 / §5.3: a sea zone is ENEMY-CONTROLLED for the besieged defender
 * when at least one non-defender war fleet is PHYSICALLY in the zone and no
 * defender war fleet contests it. Computed live from `state.fleets`.
 */
function zoneEnemyControlled(
  state: GameState,
  zoneId: string,
  defenderOwnerId: string | null,
): boolean {
  let enemy = 0;
  let friendly = 0;
  for (const f of state.fleets) {
    if (f.locationId !== zoneId) continue;
    const war = warUnitCount(f);
    if (war === 0) continue;
    if (defenderOwnerId !== null && f.ownerId === defenderOwnerId) friendly += war;
    else enemy += war;
  }
  return enemy > 0 && friendly === 0;
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
 * §7.7: true for a REACTION card (`the-intercepted-letter`) — never played
 * proactively, exempt from the 1/side/round limit, and consumed only in
 * response to a rival's played card. Unknown ids classify as non-reactions.
 */
function isInterceptCard(cardId: TacticCardId): boolean {
  const data = TACTIC_CARD_BY_ID[cardId]?.data as { effect?: string } | undefined;
  return data?.effect === "intercept";
}

/** Splice the first NON-reaction card out of a (local) queue, FIFO. */
function takeFirstPlayable(queue: TacticCardId[] | undefined): TacticCardId | undefined {
  if (!queue) return undefined;
  const idx = queue.findIndex((c) => !isInterceptCard(c));
  return idx === -1 ? undefined : queue.splice(idx, 1)[0];
}

/** Splice a queued intercept reaction out of a (local) queue, if any. */
function takeIntercept(queue: TacticCardId[] | undefined): TacticCardId | undefined {
  if (!queue) return undefined;
  const idx = queue.findIndex((c) => isInterceptCard(c));
  return idx === -1 ? undefined : queue.splice(idx, 1)[0];
}

/**
 * Remove `cardId` from the live battle's queue on `state` (one copy) and route
 * it to `tacticDiscard` WITHOUT resolving its effect, with a log entry. Used for
 * (a) a card cancelled by `the-intercepted-letter` — §7.7 "both cards are
 * discarded" — and (b) the ERROR-CONTAINMENT path (a queued card whose
 * resolution threw is skipped, discarded and logged; the battle continues).
 */
function discardQueuedTactic(
  state: GameState,
  battleId: string,
  side: Role,
  cardId: TacticCardId,
  reason: string,
): GameState {
  const next: GameState = {
    ...state,
    pendingBattles: state.pendingBattles.map((pb) => {
      if (pb.id !== battleId) return pb;
      const key = side === "attacker" ? "attackerTactics" : "defenderTactics";
      const q = pb[key] ?? [];
      const i = q.indexOf(cardId);
      if (i === -1) return pb;
      return { ...pb, [key]: [...q.slice(0, i), ...q.slice(i + 1)] };
    }),
    tacticDiscard: [...(state.tacticDiscard ?? []), cardId],
  };
  return appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "event_card",
    actors: [],
    data: { deck: "tactic", action: "discard_unresolved", card: cardId, side, reason },
    message: `Tactic "${cardId}" is discarded unresolved (${reason}).`,
  });
}

/**
 * ERROR CONTAINMENT (marshal major "a failing queued tactic crashes the COMBAT
 * phase"): resolve one tactic via the tactic subsystem, but NEVER let a throwing
 * card take the phase down. On failure the card is skipped — removed from the
 * queue, discarded, logged — and the battle continues deterministically (the
 * failed resolution consumed no rng: `playTactic` throws before any draw).
 */
function safePlayTactic(
  state: GameState,
  battle: PendingBattle,
  side: Role,
  cardId: TacticCardId,
  rng: Rng,
): GameState {
  try {
    return playTactic(state, battle, side, cardId, rng);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return discardQueuedTactic(state, battle.id, side, cardId, `tactic_error: ${message}`);
  }
}

/**
 * §7.7 tactic step, run at the top of every battle round: the attacker declares
 * first, then the defender; each side plays ≤1 proactive card per battle round
 * (FIFO from its LOCAL queue — the caller's input battle is never mutated).
 *
 * INTERCEPTED-LETTER CONSUMER (marshal combat cluster): when a side plays a card
 * and the OPPOSING queue holds `the-intercepted-letter`, the reaction fires —
 * the played card is CANCELLED (discarded WITHOUT effect; §7.7 "both cards are
 * discarded") and the letter itself resolves (retiring to the discard pile). A
 * letter with nothing to react to stays queued. Every resolution is wrapped in
 * {@link safePlayTactic} containment.
 */
function playRoundTactics(state: GameState, ctx: BattleCtx, rng: Rng): GameState {
  const battle = ctx.battle;
  if (!battle) return state;
  let s = state;
  for (const side of ["attacker", "defender"] as const) {
    const own = side === "attacker" ? battle.attackerTactics : battle.defenderTactics;
    const opp = side === "attacker" ? battle.defenderTactics : battle.attackerTactics;
    const oppSide: Role = side === "attacker" ? "defender" : "attacker";
    const cardId = takeFirstPlayable(own);
    if (cardId === undefined) continue;
    const interceptId = takeIntercept(opp);
    if (interceptId !== undefined) {
      // §7.7 reaction: the rival's letter cancels this card — no effect, both discard.
      s = discardQueuedTactic(s, battle.id, side, cardId, "cancelled by the-intercepted-letter");
      s = safePlayTactic(s, battle, oppSide, interceptId, rng);
    } else {
      s = safePlayTactic(s, battle, side, cardId, rng);
    }
  }
  return s;
}

/** §7.1 hit threshold for one homogeneous group: clamp(7 − CV − mods, 2, 6). */
function groupThreshold(
  cv: number,
  type: UnitType,
  role: Role,
  flatMod: number,
  ctx: BattleCtx,
): number {
  // §7.3 cavalry charge +1 on PLAINS (attacker only; negated off plains).
  const charge =
    role === "attacker" && type === UnitType.CAVALRY && ctx.terrain === TerrainType.PLAINS
      ? COMBAT_MODS.cavalryCharge
      : 0;
  return clamp(
    COMBAT_MODS.hitBase - cv - flatMod - charge,
    COMBAT_MODS.hitClampMin,
    COMBAT_MODS.hitClampMax,
  );
}

/**
 * Roll every participating die for a side this step (deterministic stack/type
 * iteration — RNG order identical to the pre-Stage-B kernel for a card-free
 * battle) and return each die with its threshold, plus the BEST (lowest)
 * threshold among the side's participating units — the §7.7 "unit of your
 * choice" a "+N dice" card's extra dice roll at (deterministic stand-in for the
 * player's optimal pick).
 */
function rollSideDice(
  side: Working[],
  role: Role,
  step: Step,
  flatMod: number,
  ctx: BattleCtx,
  rng: Rng,
): { dice: RolledDie[]; bestThreshold: number | null } {
  const dice: RolledDie[] = [];
  let best: number | null = null;
  const push = (count: number, threshold: number): void => {
    if (best === null || threshold < best) best = threshold;
    for (const roll of rng.rollDice(count)) dice.push({ roll, threshold, rerolled: false });
  };
  for (const stack of side) {
    for (const type of CASUALTY_ORDER) {
      const count = stack.units[type] ?? 0;
      if (count <= 0 || !participates(type, step, ctx)) continue;
      push(count, groupThreshold(baseCv(type, role), type, role, flatMod, ctx));
    }
    for (const v of stack.variants) {
      if (v.count <= 0 || !participates(v.base, step, ctx)) continue;
      // §FACTIONS: variant effective CV = base CV + unique-unit stat delta.
      const def = UNIQUE_UNIT_OVERRIDES[v.variant];
      const delta = role === "attacker" ? def?.atkMod ?? 0 : def?.defMod ?? 0;
      push(v.count, groupThreshold(baseCv(v.base, role) + delta, v.base, role, flatMod, ctx));
    }
  }
  return { dice, bestThreshold: best };
}

/** Total hits a side scores in the RANGED step (no §7.7 dice/reroll layer). */
function generateHits(
  _state: GameState,
  side: Working[],
  role: Role,
  step: Step,
  flatMod: number,
  ctx: BattleCtx,
  rng: Rng,
): number {
  const { dice } = rollSideDice(side, role, step, flatMod, ctx, rng);
  return dice.filter((d) => d.roll >= d.threshold).length;
}

/**
 * §7.7 CONSUMERS — a side's MELEE step: roll the normal dice, then
 *   1. "+N dice" cards ({@link tacticExtraDice}): N actual EXTRA DICE drawn from
 *      the same rng stream at the best participating unit's threshold (§7.7
 *      "at the hit threshold of one participating unit of your choice", 2–6
 *      clamp already applied). NOT a to-hit shift (marshal fix).
 *   2. Reroll cards ({@link tacticRerollMods}): rerolls draw the NEXT values
 *      from the same stream (deterministic). Modes — "one" (ladders-and-
 *      fascines): reroll the first missed die; "any" (the-white-knights-stroke):
 *      reroll every missed die once; "lowest" (locked-shields): reroll the
 *      side's lowest die when it is a miss, recurring each melee step. §7.7: no
 *      die is ever rerolled twice; hits are never rerolled (optimal play).
 *      One-round modes ("one"/"any") are CONSUMED — removed from
 *      activeModifiers — the first step they actually reroll; "lowest" persists
 *      for the battle and lapses with the round.
 * A card-free battle draws exactly the pre-Stage-B sequence (stream-preserving).
 * Returns the hits plus the (possibly new) state with consumed grants removed.
 */
function meleeSideHits(
  state: GameState,
  side: Working[],
  role: Role,
  flatMod: number,
  ctx: BattleCtx,
  rng: Rng,
): { hits: number; state: GameState } {
  const { dice, bestThreshold } = rollSideDice(side, role, "melee", flatMod, ctx, rng);
  let s = state;
  if (bestThreshold !== null) {
    const extra = tacticExtraDice(s, ctx, role);
    if (extra > 0) {
      for (const roll of rng.rollDice(extra)) {
        dice.push({ roll, threshold: bestThreshold, rerolled: false });
      }
    }
  }
  for (const mod of tacticRerollMods(s, ctx, role)) {
    const mode = mod.data?.reroll;
    let used = false;
    if (mode === "one") {
      const i = dice.findIndex((d) => !d.rerolled && d.roll < d.threshold);
      if (i >= 0) {
        dice[i] = { roll: rng.rollD6(), threshold: dice[i].threshold, rerolled: true };
        used = true;
      }
    } else if (mode === "any") {
      for (let i = 0; i < dice.length; i += 1) {
        const d = dice[i];
        if (!d.rerolled && d.roll < d.threshold) {
          dice[i] = { roll: rng.rollD6(), threshold: d.threshold, rerolled: true };
          used = true;
        }
      }
    } else if (mode === "lowest") {
      let low = -1;
      for (let i = 0; i < dice.length; i += 1) {
        if (!dice[i].rerolled && (low === -1 || dice[i].roll < dice[low].roll)) low = i;
      }
      if (low >= 0 && dice[low].roll < dice[low].threshold) {
        dice[low] = { roll: rng.rollD6(), threshold: dice[low].threshold, rerolled: true };
      }
    }
    // "one"/"any" are one-round grants: consume on first actual use.
    if (used && mode !== "lowest") s = removeModifier(s, mod.id);
  }
  return { hits: dice.filter((d) => d.roll >= d.threshold).length, state: s };
}

/**
 * §7.2 step 1 / §8.4 assault row (RAW canon): the number of assault dice the
 * besieger's SIEGE engines roll THIS round. Each generic SIEGE unit (plain or a
 * non-Bombard SIEGE variant) rolls ONE die; an emplaced Great Bombard adds
 * {@link BattleCtx.bombardAssaultDice} dice. Counted from the LIVE attacker stacks
 * each round so engines destroyed mid-storm stop rolling. Returns 0 when this is
 * not a siege assault, or at a breach when {@link BattleCtx.siegeEnginesFightAtBreach}
 * is false.
 */
function siegeEngineDiceCount(ctx: BattleCtx): number {
  if (!ctx.siegeEnginesActive) return 0;
  if (ctx.wallsHp <= 0 && !ctx.siegeEnginesFightAtBreach) return 0;
  let dice = 0;
  for (const w of ctx.attackers) {
    dice += w.units[UnitType.SIEGE] ?? 0;
    for (const v of w.variants) {
      if (v.base !== UnitType.SIEGE) continue;
      if (v.variant === GREAT_BOMBARD.variant) {
        // Only an EMPLACED Bombard contributes its assault die(s) (§8.4 delta 3).
        if (ctx.bombardEmplaced) dice += v.count * (ctx.bombardAssaultDice ?? 0);
      } else {
        dice += v.count; // a generic SIEGE variant rolls one die like a plain SIEGE
      }
    }
  }
  return dice;
}

/**
 * Roll `dice` SIEGE-engine assault dice at the §8.4 engine threshold and return the
 * hits. Uses the SAME §7.1 kernel: hit on d6 >= clamp(7 − CV − mod, 2, 6) where
 * CV = UNIT_STATS[SIEGE].combatValue (0) and mod = the +3-vs-walls
 * ({@link BattleCtx.siegeEngineMod}), so engines hit on 4+ — parity with the
 * balance sim's derived "CV 0 + 3, hit on 4+" curve. `dice` is precomputed by
 * {@link siegeEngineDiceCount}; a 0 count consumes NO rng (stream-preserving for
 * every non-siege battle and for sieges with no engines).
 */
function rollSiegeEngineHits(dice: number, ctx: BattleCtx, rng: Rng): number {
  if (dice <= 0) return 0;
  const cv = UNIT_STATS[UnitType.SIEGE].combatValue;
  const threshold = clamp(
    COMBAT_MODS.hitBase - cv - (ctx.siegeEngineMod ?? 0),
    COMBAT_MODS.hitClampMin,
    COMBAT_MODS.hitClampMax,
  );
  let hits = 0;
  for (const r of rng.rollDice(dice)) if (r >= threshold) hits += 1;
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

/** §6.4 stacking cap for a province: 12 for a CITY/capital, else 8 ordinary land. */
function landStackingCap(state: GameState, provId: string): number {
  const prov = state.provinces.find((p) => p.id === provId);
  return prov && (prov.terrain === TerrainType.CITY || prov.isCapitalOf !== undefined)
    ? STACKING.city
    : STACKING.land;
}

/**
 * §6.4 land-stacking room remaining for `ownerId` at province `provId`: the cap
 * (12 city/capital, else 8) minus the units the owner already has stacked there.
 * Never negative. Used to clamp a rout retreat so it can never over-stack the
 * destination (mirrors the FL-02 vassal-levy clamp in diplomacy.ts).
 */
function landStackingRoom(state: GameState, ownerId: string, provId: string): number {
  const current = state.armies
    .filter((a) => a.ownerId === ownerId && a.locationId === provId)
    .reduce((acc, a) => acc + realCount(a), 0);
  return Math.max(0, landStackingCap(state, provId) - current);
}

/**
 * First adjacent land province owned by `ownerId` or empty and with §6.4 stacking
 * room to spare, for a rout retreat (§7.5 / GD §7 "else surrenders"). Neighbours
 * are scanned in the deterministic map-graph order; a province with ZERO remaining
 * capacity is skipped in favour of the next eligible one. Returns undefined when no
 * adjacent friendly/empty province has any room — the whole routed stack surrenders.
 */
function findRetreat(
  state: GameState,
  ownerId: string | null,
  fromId?: string,
): string | undefined {
  if (!ownerId || !fromId) return undefined;
  for (const n of neighborsOf(fromId)) {
    const prov = state.provinces.find((p) => p.id === n);
    if (!prov) continue; // skip sea zones
    if (prov.ownerId !== ownerId && prov.ownerId !== null) continue;
    // §6.4: only retreat where the destination can accept at least one unit.
    if (landStackingRoom(state, ownerId, n) > 0) return n;
  }
  return undefined;
}

/** §6.4/§7 log entry for units lost when a rout retreat overflows the destination cap. */
function retreatOverflowLog(
  state: GameState,
  ownerId: string | null,
  retreatTo: string | undefined,
  count: number,
): LogInput {
  const prov = retreatTo ? state.provinces.find((p) => p.id === retreatTo) : undefined;
  return {
    round: state.round,
    phase: state.phase,
    type: "battle",
    actors: ownerId ? [ownerId] : [],
    targets: retreatTo ? [retreatTo] : [],
    message: `§6.4: ${count} routed unit(s) could not fit into ${
      prov?.name ?? retreatTo ?? "the retreat"
    } and surrendered.`,
    data: { retreatOverflowSurrendered: count, retreatTo },
  };
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
  let attackerWithdrew = false;
  let defenderWithdrew = false;
  const cap = 50; // guard against pathological non-terminating stalemates

  if (attackerInitial === 0 || defenderInitial === 0) {
    return { outcome: { rounds: 0, attackerRouted, defenderRouted }, state: s };
  }

  while (rounds < cap) {
    rounds += 1;

    // 0. Tactic step (§7.7): attacker declares first, then defender; ≤1 card per
    // side per battle round (the intercepted-letter reaction rides on the rival's
    // play). Posted modifiers apply from this round onward; a throwing card is
    // contained (skipped + discarded), never crashing the COMBAT phase.
    if (ctx.battle) {
      s = playRoundTactics(s, ctx, rng);
    }

    // 0a. §7.7 Feigned Retreat CONSUMER (marshal combat cluster) — "at the start
    // of any battle round, BEFORE dice: withdraw your whole stack to an adjacent
    // friendly or empty province. The battle ends; NO pursuit." Reads the
    // `morale{retreat:true}` modifier the tactic posts, consumes it, relocates
    // via the §7.5 retreat pathfinder and ends the battle with no dice and no
    // pursuit hits. Land PendingBattles only (the card is land-domain).
    if (!ctx.isNaval && ctx.battle) {
      for (const role of ["attacker", "defender"] as const) {
        const faction = sideFaction(ctx, role);
        if (!faction) continue;
        const mod = getModifiers(s, "morale", { faction, provinceId: ctx.provinceId }).find(
          (m) => m.data?.retreat === true && modMatchesSide(m.data, role),
        );
        if (!mod) continue;
        s = removeModifier(s, mod.id); // consumed whether or not a path exists
        const ownerId = role === "attacker" ? ctx.attackerOwnerId : ctx.defenderOwnerId;
        const dest = findRetreat(s, ownerId, ctx.provinceId);
        if (dest === undefined) continue; // nowhere to withdraw to — fight on
        if (role === "attacker") {
          attackerWithdrew = true;
          attackerRetreatTo = dest;
        } else {
          defenderWithdrew = true;
          defenderRetreatTo = dest;
        }
      }
      if (attackerWithdrew || defenderWithdrew) break; // battle ends before dice
    }

    // 0b. §7.7 Greek Fire CONSUMER (marshal combat cluster) — "before dice in a
    // fleet battle you are fighting: win it outright — all enemy naval units in
    // the zone are destroyed." Reads the `combat_mod{autoWinNaval:true}` modifier
    // the tactic posts, consumes it and wipes the opposing side with NO dice.
    // Attacker precedence when (degenerately) both sides hold one.
    if (ctx.isNaval) {
      const autoWin = (role: Role): ActiveModifier | undefined => {
        const faction = sideFaction(ctx, role);
        if (!faction) return undefined;
        return getModifiers(s, "combat_mod", { faction, seaZoneId: ctx.seaZoneId }).find(
          (m) => m.data?.autoWinNaval === true && modMatchesSide(m.data, role),
        );
      };
      const wipe = (side: Working[]): void => {
        for (const w of side) {
          w.units = zeroUnits();
          w.variants = [];
        }
      };
      const atkWin = autoWin("attacker");
      const defWin = atkWin === undefined ? autoWin("defender") : undefined;
      if (atkWin) {
        s = removeModifier(s, atkWin.id);
        wipe(ctx.defenders);
        break;
      }
      if (defWin) {
        s = removeModifier(s, defWin.id);
        wipe(ctx.attackers);
        break;
      }
    }

    // 1. Ranged step (§7.2 step 1): ARCHERs fire, and — in a siege assault (§8.4) —
    // the besieger's SIEGE engines / emplaced Great Bombard roll their OWN dice at
    // the +3-vs-walls engine threshold, ADDING to the attacker's hits (breach
    // included). All hits are computed pre-removal (simultaneous). The engine dice
    // are counted from the LIVE besiegers each round; a 0 count consumes no rng, so
    // field/naval battles keep their exact stream.
    const engineDice = siegeEngineDiceCount(ctx);
    if (ctx.rangedTypes.length > 0 || engineDice > 0) {
      const at = sideTotal(ctx.attackers);
      const dt = sideTotal(ctx.defenders);
      const af = attackerFlat(s, ctx, at, dt);
      const df = defenderFlat(s, ctx, at, dt);
      let ah =
        ctx.rangedTypes.length > 0
          ? generateHits(s, ctx.attackers, "attacker", "ranged", af, ctx, rng)
          : 0;
      // §7.2 step 1 / §8.4: SIEGE engines roll here, after the attacker's archers.
      ah += rollSiegeEngineHits(engineDice, ctx, rng);
      const dh =
        ctx.rangedTypes.length > 0
          ? generateHits(s, ctx.defenders, "defender", "ranged", df, ctx, rng)
          : 0;
      removeCasualties(ctx.defenders, ah);
      removeCasualties(ctx.attackers, dh);
      if (sideTotal(ctx.attackers) === 0 || sideTotal(ctx.defenders) === 0) break;
    }

    // 2. Melee step (§7.2): both sides roll simultaneously. §7.7 "+N dice" and
    // reroll grants apply here (attacker's extra/reroll draws precede the
    // defender's normal dice — deterministic; a card-free battle draws the exact
    // pre-Stage-B sequence). Consumed one-shot rerolls thread through `s`.
    {
      const at = sideTotal(ctx.attackers);
      const dt = sideTotal(ctx.defenders);
      const af = attackerFlat(s, ctx, at, dt);
      const df = defenderFlat(s, ctx, at, dt);
      const atkMelee = meleeSideHits(s, ctx.attackers, "attacker", af, ctx, rng);
      s = atkMelee.state;
      const defMelee = meleeSideHits(s, ctx.defenders, "defender", df, ctx, rng);
      s = defMelee.state;
      // 3. Apply casualties (§7.2).
      removeCasualties(ctx.defenders, atkMelee.hits);
      removeCasualties(ctx.attackers, defMelee.hits);
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
    outcome: {
      rounds,
      attackerRouted,
      defenderRouted,
      attackerRetreatTo,
      defenderRetreatTo,
      attackerWithdrew,
      defenderWithdrew,
    },
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

/**
 * Write surviving working stacks back onto the (cloned) state and prune empties.
 *
 * §6.4 rout retreat: when a routed land stack retreats into `retreatTo`, it may
 * only add units up to that province's REMAINING stacking room (cap − units the
 * owner already has there, 12 city/capital else 8). Units that do not fit
 * SURRENDER (are removed), per GD §7 "…else surrenders". Room is consumed across
 * all of this side's retreating stacks so their combined arrival can never breach
 * the cap. Returns the number of units surrendered to overflow (0 when everything
 * fit, or when there was no capacity-limited retreat).
 */
function writeBack(
  state: GameState,
  side: Working[],
  kind: "army" | "fleet",
  routed: boolean,
  retreatTo: string | undefined,
): number {
  let surrendered = 0;
  // Remaining §6.4 room at the retreat destination, shared across this side's
  // stacks. Sea retreats never occur (naval has no rout), so this only bites land.
  let room =
    kind === "army" && routed && retreatTo && side.length > 0
      ? landStackingRoom(state, side[0].ownerId, retreatTo)
      : Number.POSITIVE_INFINITY;
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
    } else if (routed && retreatTo) {
      // §6.4/§7: retreat as many as fit; any overflow surrenders. Overflow is shed
      // lowest-value-first (§7.1 casualty order) via removeCasualties on this stack.
      const total = stackTotal(w);
      const fit = Math.max(0, Math.min(total, room));
      const overflow = total - fit;
      if (overflow > 0) removeCasualties([w], overflow);
      surrendered += overflow;
      room -= fit;
      s.units = w.units;
      s.variants = w.variants;
      s.locationId = retreatTo;
    } else {
      s.units = w.units;
      s.variants = w.variants;
    }
  }
  if (kind === "army") {
    state.armies = state.armies.filter((a) => realCount(a) > 0);
  } else {
    state.fleets = state.fleets.filter((f) => realCount(f) > 0);
  }
  return surrendered;
}

/**
 * §8.2 / §13.1 / FACTIONS Ottoman Secret Objective #3 "Ghazi Empire" — apply a
 * SACK to a city captured by ASSAULT (a breach/escalade storm or a field-assault
 * that carries the city). Per the coordinator ratification (RULING: only ASSAULT
 * captures sack — a starvation-SURRENDER never does), this:
 *   1. marks the province `sacked = true` (read by prestige for the Byzantine
 *      "Hagia Sophia intact" objective and by economy to stop the standing Hagia
 *      Sophia faith once Constantinople is no longer intact); and
 *   2. when the city is an ENEMY high-value node (`province.highValue` truthy — on
 *      the canonical map every HV node is authored HV(3)+, so truthy ≡ the doc's
 *      "HV(3)+ nodes"), increments the capturing player's `sackedHighValueCities`
 *      counter (the Ghazi Empire clause, CONTRACT2 FIX-PREP2).
 * Reconciles the earlier FL-07 behaviour, which incremented the HV counter on ANY
 * capture: it is now restricted to sacks (assault captures) only. MUST be called
 * BEFORE {@link captureProvince} flips ownership, so the pre-capture owner still
 * reads as the enemy. Returns true when a HIGH-VALUE sack was counted (drives the
 * log's `data.sacked` / Ghazi Empire counter).
 */
function applySack(state: GameState, prov: Province, capturerId: string): boolean {
  prov.sacked = true; // §8.2: an assault capture always sacks the city
  if (!prov.highValue) return false; // not a high-value node → no counter tick
  if (prov.ownerId === capturerId) return false; // never a sack of your own city
  const cap = state.players.find((pl) => pl.id === capturerId);
  if (!cap) return false;
  cap.sackedHighValueCities = (cap.sackedHighValueCities ?? 0) + 1;
  return true;
}

/**
 * §8.2 step 1 (FL-12): investing a standing-walled city is the ONLY point a
 * {@link SiegeState} is first constructed. A MOVE that declares a siege
 * (`PendingBattle.isSiege`) does NOT resolve as an immediate field assault — it
 * circumvallates the city and seeds the hold-out so resolveSiege's store-driven
 * starvation (§8.2 step 3) has a starting value. Hold-out = base 3 rounds, +2 with
 * a Granary, folded straight into the INITIAL `grainStores` (NOT a parallel
 * holdout constant). No dice are rolled, so the rng cursor is unchanged
 * (deterministic); bombardment/assault begin on the NEXT COMBAT phase. Idempotent:
 * a reinforcing siege move folds its stacks into the existing siege.
 */
function investSiege(
  state: GameState,
  battle: PendingBattle,
  prov: Province,
  rng: Rng,
): BattleResult {
  const emptyReport: CasualtyReport = { losses: {}, routed: [] };
  const existing = state.siegeStates.find((s) => s.provinceId === prov.id);
  if (existing) {
    for (const id of battle.attackerStackIds) {
      if (!existing.besiegingArmyIds.includes(id)) existing.besiegingArmyIds.push(id);
    }
    prov.siege = { ...existing };
  } else {
    // §8.2 step 3: grainStores = default 3 (SIEGE.baseHoldoutRounds) + 2 with a
    // Granary (SIEGE.granaryBonusRounds).
    const hasGranary = prov.buildings.includes(BuildingType.GRANARY);
    const grainStores =
      SIEGE.baseHoldoutRounds + (hasGranary ? SIEGE.granaryBonusRounds : 0);
    const siege: SiegeState = {
      provinceId: prov.id,
      besiegerId: battle.attackerId,
      besiegingArmyIds: [...battle.attackerStackIds],
      roundsElapsed: 0,
      grainStores,
      breached: false,
      circumvallated: true,
    };
    state.siegeStates = [...state.siegeStates, siege];
    prov.siege = { ...siege };
  }
  const out = appendLog(state, {
    round: state.round,
    phase: state.phase,
    type: "siege",
    actors: [battle.attackerId, ...(battle.defenderId ? [battle.defenderId] : [])],
    targets: [prov.id],
    message: `${battle.attackerId} invests ${prov.name}; the siege begins.`,
    data: { invested: true, grainStores: prov.siege?.grainStores },
  });
  return {
    state: { ...out, rngCursor: rng.cursor },
    winnerId: null,
    rounds: 0,
    attacker: emptyReport,
    defender: emptyReport,
  };
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

  // §8.2 step 1 (FL-12): a MOVE that DECLARES a siege on a standing-walled city
  // invests it rather than storming immediately. Create the SiegeState here (its
  // sole construction point) seeded with grainStores, so resolveSiege's
  // store-driven starvation has a starting value. No dice → rng cursor unchanged.
  if ((battle.isSiege ?? false) && prov && prov.walls.hp > 0) {
    return investSiege(next, battle, prov, rng);
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

  // §8.4 delta 3 (capture-passes-intact): record which stacks carry the Great
  // Bombard BEFORE combat mutates the working copies, so a destroyed escort can
  // hand the gun to the victor after writeBack.
  const atkBombardIds = bombardStacks(attackers);
  const defBombardIds = bombardStacks(defenders);

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
  // §7.5/§7.7: a side left the field by ROUT or by a Feigned-Retreat WITHDRAWAL.
  const atkFled = outcome.attackerRouted || (outcome.attackerWithdrew ?? false);
  const defFled = outcome.defenderRouted || (outcome.defenderWithdrew ?? false);
  let winnerId: string | null = null;
  if (atkFled && !defFled) {
    winnerId = battle.defenderId; // §7.5 attacker fled the field
  } else if (defFled && !atkFled) {
    winnerId = battle.attackerId; // §7.5 defender fled → attacker holds
  } else if (!atkFled && !defFled) {
    if (atkAlive > 0 && defAlive === 0) winnerId = battle.attackerId;
    else if (defAlive > 0 && atkAlive === 0) winnerId = battle.defenderId;
  }
  // §7.7 Feigned Retreat: the field was CEDED, not won by arms — no
  // decisive-battle/outnumbered/walled-city prestige and no sack below.
  const wonByCession =
    (winnerId === battle.attackerId && (outcome.defenderWithdrew ?? false)) ||
    (winnerId === battle.defenderId && (outcome.attackerWithdrew ?? false));

  const atkSurrendered = writeBack(post, attackers, "army", atkFled, outcome.attackerRetreatTo);
  const defSurrendered = writeBack(post, defenders, "army", defFled, outcome.defenderRetreatTo);
  // §6.4: log any units that could not fit into the retreat destination and surrendered.
  if (atkSurrendered > 0) {
    post = appendLog(post, retreatOverflowLog(post, battle.attackerId, outcome.attackerRetreatTo, atkSurrendered));
  }
  if (defSurrendered > 0) {
    post = appendLog(post, retreatOverflowLog(post, battle.defenderId, outcome.defenderRetreatTo, defSurrendered));
  }

  // §8.4 delta 3 (capture-passes-intact): a defeated GB-carrying stack does NOT
  // lose the gun — it passes INTACT to the victor. Runs on the post-writeBack state
  // (which has already removed the destroyed loser stack + its variant), attaching
  // the gun to a surviving winner stack and re-homing the singleton tracker. Covers
  // both a field battle and a relief that defeats a besieging GB stack (relief is a
  // field battle where the besieger is the defender).
  if (winnerId === battle.attackerId) {
    post = salvageBombardToVictor(post, defenders, defBombardIds, winnerId, battle.attackerStackIds);
  } else if (winnerId === battle.defenderId) {
    post = salvageBombardToVictor(post, attackers, atkBombardIds, winnerId, battle.defenderStackIds);
  }

  // §7: winner takes the province if the attacker prevails in a field battle.
  let captured = false;
  let sacked = false;
  const capturedTier = provPost?.walls.tier ?? 0;
  if (winnerId === battle.attackerId && !atkFled && provPost) {
    // §8.2 / §13.1 / FACTIONS Ottoman #3: a won field battle that carries the
    // city IS a field-ASSAULT capture → it SACKS the city (RULING: assault
    // captures sack; only starvation-surrender does not). applySack marks
    // provPost.sacked and, if high-value, feeds the Ghazi Empire counter. Called
    // BEFORE the ownership flip so the pre-capture owner still reads as the enemy.
    // (An uncontested occupation, handled above, never reaches here → never sacks.
    // §7.7: a Feigned-Retreat CESSION captures but is no assault → never sacks.)
    if (!wonByCession) sacked = applySack(post, provPost, battle.attackerId);
    captureProvince(post, provPost, battle.attackerId);
    captured = true;
  }

  // §13 conquest-prestige signals — POST as prestige_pending (CONTRACT2 §12.8);
  // the prestige subsystem consumes these at Cleanup. Never mutate prestige here.
  const pending: Record<string, number> = {};
  if (winnerId && !wonByCession) {
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
      // §7.7 Feigned Retreat: voluntary withdrawals (no pursuit, no rout).
      attackerWithdrew: outcome.attackerWithdrew ?? false,
      defenderWithdrew: outcome.defenderWithdrew ?? false,
      prestigePending: pending,
      // §13.1 / FACTIONS Ottoman #3 (FL-07): true when this capture sacked an
      // enemy high-value city (drives the Ghazi Empire counter).
      sacked,
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
 * Advance a siege one round (§8): circumvallation lock (physical besieger
 * recomputation), treason-at-the-gate consumption, SIEGE bombardment of the
 * walls, garrison starvation, then — ONLY when the besieger declared one via
 * SIEGE_ASSAULT (`SiegeState.assaultDeclared`, §8.2 step 4) — an assault. If the
 * besieging force is gone (a successful relief, or it marched away — the siege
 * lock), the siege is lifted and walls begin to repair (§8.2.5). Pure.
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

  // §8.2 step 1 SIEGE LOCK (marshal major "marched-away army keeps besieging
  // remotely"): the besieging set is RECOMPUTED each round from unit LOCATIONS —
  // only stacks of the besieger physically standing in the besieged province
  // count. A stack that marched away (or changed hands) drops out; if none
  // remain the siege LIFTS below (walls begin repair, §8.2.5) — there is no
  // remote besieging.
  const besiegers = next.armies
    .filter(
      (a) =>
        siege.besiegingArmyIds.includes(a.id) &&
        a.locationId === siege.provinceId &&
        a.ownerId === siege.besiegerId,
    )
    .map(toWorking);

  // §8.4 delta 3 (capture-passes-intact): record whether the besieging escort
  // carries the Great Bombard BEFORE the assault mutates it, so if that escort is
  // destroyed during the storm (and the city does NOT fall) the gun passes to the
  // surviving defender rather than being lost with the scrap.
  const besiegerBombardIds = bombardStacks(besiegers);

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

  const defenderFaction = factionOf(next, prov.ownerId);
  const besiegerFaction = factionOf(next, siege.besiegerId);

  // 1b. §7.7 TREASON-AT-THE-GATE CONSUMER (marshal combat cluster): when the
  // besieger's played treason card posted a `siege_mod{autoCapture:true}` (its
  // TREASON_GATE double-brake was enforced at play, delta 1), the city FALLS
  // WITHOUT AN ASSAULT this siege round: the garrison surrenders (removed), the
  // besieger occupies, walls stay at their CURRENT HP, and no dice are rolled.
  // Not a sack (no storm) — but taking a walled city by siege still scores the
  // §13.1 conquest award. The modifier is consumed (removed) here.
  const treasonMods = besiegerFaction
    ? getModifiers(next, "siege_mod", { faction: besiegerFaction, provinceId: prov.id }).filter(
        (m) => m.data?.autoCapture === true,
      )
    : [];
  if (treasonMods.length > 0) {
    const consumedIds = new Set(treasonMods.map((m) => m.id));
    next.activeModifiers = next.activeModifiers.filter((m) => !consumedIds.has(m.id));
    // The garrison surrenders: province garrison and any defender stacks inside
    // the walls are removed (§7.7 card text "its garrison surrenders").
    for (const a of next.armies) {
      if (a.ownerId === prov.ownerId && a.locationId === prov.id) {
        a.units = zeroUnits();
        a.variants = [];
      }
    }
    next.armies = next.armies.filter((a) => realCount(a) > 0);
    const wallTier = prov.walls.tier;
    const wallHp = prov.walls.hp; // "walls at their current HP" — untouched
    captureProvince(next, prov, siege.besiegerId);
    let scored = next;
    if (wallTier > 0) {
      const award =
        wallTier >= 4 ? CONQUEST_PRESTIGE.takeWalledCityHighTier : CONQUEST_PRESTIGE.takeWalledCity;
      scored = postPrestigePending(scored, besiegerFaction, award, "take_walled_city", prov.id);
    }
    const out = appendLog(scored, {
      round: scored.round,
      phase: scored.phase,
      type: "siege",
      actors: [siege.besiegerId],
      targets: [prov.id],
      message: `Treason at the gate: ${prov.name} falls to ${siege.besiegerId} without an assault.`,
      data: { treason: true, captured: true, wallHp, sacked: false },
    });
    return { state: { ...out, rngCursor: rng.cursor }, captured: true, wallHpRemaining: wallHp };
  }

  // 2. Bombardment (§8.2.2 / §8.4) — generic SIEGE units roll 1 die each; a Great
  // Bombard (§8.4) rolls GREAT_BOMBARD.bombardDice dice once emplaced, and lifts the
  // §8.3 T5 masonry cap for the whole train.
  // §8.4: the AUTHORIZATION for enhanced fire is the PHYSICAL PRESENCE of a
  // GREAT_BOMBARD variant piece in the besieging train. That variant can only ever
  // enter play via the one-per-game Omen #34 spawn (into GameState.greatBombard +
  // a GREAT_BOMBARD unit in a province), so carrying it IS the authorization — there
  // is no separate `Player.greatBombardUnlocked` flag / `unlock` modifier to consult.
  // §8.4 delta 3 (1-round emplacement): a freshly placed/relocated Great Bombard
  // cannot FIRE until the round AFTER it entered play. A not-yet-emplaced piece
  // contributes NO bombardment this round (it does not even fire as a plain gun — it
  // is still emplacing). The arrival clock is GameState.greatBombard.emplacedRound;
  // an absent/mismatched tracker defaults to emplaced (back-compat with fixtures).
  const bombardEmplaced = greatBombardEmplaced(next, prov);
  // §8.4 GB SILENCE (economy sets greatBombard.silenced on unpaid upkeep; combat
  // consumes it): a silenced gun fires NEITHER bombardment nor assault dice this
  // round — and, firing nothing, it does not lift the §8.3 T5 masonry cap.
  const bombardSilenced = greatBombardSilenced(next, prov);
  const bombardMayFire = bombardEmplaced && !bombardSilenced;
  let genericGuns = 0;
  let greatBombards = 0;
  for (const w of besiegers) {
    genericGuns += w.units[UnitType.SIEGE] ?? 0;
    for (const v of w.variants) {
      if (v.base !== UnitType.SIEGE) continue;
      if (v.variant === GREAT_BOMBARD.variant) {
        // §8.4: an EMPLACED, un-silenced Great Bombard fires enhanced (its
        // presence authorizes it); before it is emplaced (delta 3), or while
        // silenced (§8.4 Upkeep), it cannot bombard the walls this round.
        if (bombardMayFire) greatBombards += v.count;
      } else {
        genericGuns += v.count;
      }
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
  // protected. An emplaced Great Bombard lifts the cap for the WHOLE besieging train
  // (§8.4). `greatBombards` is > 0 only when a GREAT_BOMBARD piece is present + emplaced.
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
  // RULING: a city is SACKED only when captured by ASSAULT (a breach/escalade
  // storm), NOT when its garrison is starved into surrender. This flag records
  // WHICH path took the city so only assault captures apply {@link applySack}.
  let capturedByAssault = false;
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
    // Starvation-SURRENDER: the garrison was starved (§8.2 step 3) to nothing
    // before any assault this round. The city falls WITHOUT a storm, so it is
    // captured but NOT sacked (capturedByAssault stays false).
    captured = true;
  } else if (live.assaultDeclared !== true) {
    // §8.2 step 4 CHOSEN ASSAULT (marshal major "sieges auto-assault every
    // round"): an assault resolves ONLY when the besieger DECLARED one this
    // round via the budgeted SIEGE_ASSAULT action (SiegeState.assaultDeclared,
    // STAGE-B-PREP §2). An undeclared siege round is bombardment + starvation
    // only — the walls tick and the garrison hungers, but no storm is fought.
  } else if (assaultTroops === 0) {
    // No storming troops: no assault this round (walls/garrison untouched by combat).
  } else {
    // §7.2 step 1 / §8.4 assault row (RAW canon): the storming TROOPS fight at
    // field odds (vs the standing wall's defBonus + escalade −1 while HP>0, at
    // field odds once breached) with NO flat +3. IN ADDITION the besieger's SIEGE
    // engines and an emplaced Great Bombard roll their OWN dice at the +3-vs-walls
    // engine threshold (hit on 4+), ADDING to the attacker's hits — in every
    // assault round, breach included (SIEGE_ENGINES_FIGHT_AT_BREACH). `bombardEmplaced`
    // was computed for the bombardment step above and is reused here.
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
      // §7.2 step 1 / §8.4: the besieger's engines roll their own assault dice.
      siegeEnginesActive: true,
      siegeEnginesFightAtBreach: SIEGE_ENGINES_FIGHT_AT_BREACH,
      siegeEngineMod: SIEGE.bombardVsWalls,
      // §8.4: a silenced Bombard adds no assault dice either (GB silence).
      bombardEmplaced: bombardMayFire,
      bombardAssaultDice: GREAT_BOMBARD_ASSAULT_DICE,
    };
    // No PendingBattle drives a siege assault (ctx.battle undefined), so no tactic
    // is PLAYED mid-assault; but the §7.7 reroll layer may CONSUME a one-shot
    // siege_mod reroll grant (ladders-and-fascines), so the threaded state's
    // activeModifiers are copied back onto the working clone (all other fields
    // are shared references — removeModifier shallow-copies).
    const engine = runEngine(next, ctx, rng);
    next.activeModifiers = engine.state.activeModifiers;
    const outcome = engine.outcome;
    assaultRounds = outcome.rounds;
    defRouted = outcome.defenderRouted;
    defRetreat = outcome.defenderRetreatTo;
    if (
      sideTotal(besiegers) > 0 &&
      !outcome.attackerRouted &&
      (sideTotal(defenders) === 0 || outcome.defenderRouted)
    ) {
      // Carried by STORM: this is an ASSAULT capture → it sacks the city.
      captured = true;
      capturedByAssault = true;
    }
  }
  // Persist garrison casualties (starvation and/or assault) and besieger losses.
  // Capture the defending owner BEFORE captureProvince may flip ownership, so any
  // §6.4 retreat-overflow surrender is attributed to the routed defender.
  const siegeDefenderId = prov.ownerId;
  const defSurrendered = writeBack(next, defenders, "army", defRouted, defRetreat);
  writeBack(next, besiegers, "army", false, undefined);

  // §8.4 delta 3 (capture-passes-intact): if the besieging escort carrying the
  // Great Bombard was DESTROYED in the assault and the city did NOT fall, the gun is
  // loot for the surviving defender (the victor), not scrap. (When the city falls
  // the besieger holds the field and keeps its gun, so this only fires on !captured.)
  if (!captured && besiegerBombardIds.size > 0) {
    const defenderStackIds = defenders.filter((w) => !w.garrison).map((w) => w.id);
    salvageBombardToVictor(next, besiegers, besiegerBombardIds, prov.ownerId, defenderStackIds);
  }

  const capturedTier = prov.walls.tier;
  let sacked = false;
  if (captured) {
    // §8.2 / §13.1 / FACTIONS Ottoman #3: STORMING an enemy high-value city is a
    // sack; a starvation-SURRENDER (capturedByAssault === false) transfers
    // ownership WITHOUT sacking and WITHOUT ticking the Ghazi counter (RULING).
    // When it is a sack, apply it BEFORE the ownership flip so the pre-capture
    // owner still reads as the enemy.
    if (capturedByAssault) {
      sacked = applySack(next, prov, siege.besiegerId);
    }
    captureProvince(next, prov, siege.besiegerId);
  } else {
    // §8.2 step 4 CHOSEN ASSAULT: the declaration is consumed by this round's
    // resolution — clear it so it never carries over (roundLoop also clears
    // after COMBAT; this is the consumption side, belt and braces).
    live.assaultDeclared = false;
    // Mirror updated siege progress back onto state.
    prov.siege = { ...live };
    const idx = next.siegeStates.findIndex((s) => s.provinceId === prov.id);
    if (idx >= 0) next.siegeStates[idx] = { ...live };
    else next.siegeStates.push({ ...live });
  }

  // §13 conquest-prestige on a storm — POST prestige_pending (CONTRACT2 §12.8),
  // consumed by the prestige subsystem at Cleanup. Never mutate prestige here.
  let scored = next;
  // §6.4: log any routed defender units that could not fit into the retreat and surrendered.
  if (defSurrendered > 0) {
    scored = appendLog(scored, retreatOverflowLog(scored, siegeDefenderId, defRetreat, defSurrendered));
  }
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
      // §13.1 / FACTIONS Ottoman #3 (FL-07): true when the storm sacked an enemy
      // high-value city (drives the Ghazi Empire counter).
      sacked,
    },
  });

  return {
    state: { ...out, rngCursor: rng.cursor },
    captured,
    wallHpRemaining: prov.walls.hp,
  };
}
