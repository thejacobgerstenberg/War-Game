/**
 * economy.ts — income, upkeep, trade and building subsystem.
 *
 * Owns the Income phase (§4.1), taxation (§4.2), market/route trade (§4.3/§5),
 * upkeep & starvation (§4.4), and building/great-work construction (§9). Reads
 * every number from balance.ts. Functions are pure and return new GameState
 * (except {@link computeIncome}, a read-only projection).
 */
import {
  BuildingType,
  Faction,
  GreatWorkType,
  TaxPosture,
  TerrainType,
  TreatyType,
  UnitType,
  type Army,
  type Fleet,
  type GameAction,
  type GameState,
  type Player,
  type Province,
  type ResourceBundle,
} from "@imperium/shared";
import {
  BUILDING_COSTS,
  BUILDING_EFFECTS,
  DESERTION_ORDER,
  FACTION_LEVY_ECONOMY,
  GREAT_WORK_COSTS,
  MARKET_RATIOS,
  MAX_BUILDABLE_WALL_TIER,
  MERC_REVOLT_PILLAGE,
  MERC_UPKEEP_MULTIPLIER,
  TAX_MULTIPLIERS,
  TAX_REVOLT,
  TRADE,
  UNIT_STATS,
  UNIQUE_UNIT_OVERRIDES,
  WALL_BUILD_COST,
  WALL_TIERS,
} from "./balance.js";
import { areAdjacent } from "./adjacency.js";
import { appendLog } from "./logEntry.js";
import { getModifiers, removeModifier, sumModifierValues } from "./modifiers.js";
import { makeRng } from "./rng.js";
import { EngineError } from "./actions.js";

// ---------------------------------------------------------------------------
// Small resource / lookup helpers
// ---------------------------------------------------------------------------

const RESOURCE_KEYS = ["gold", "grain", "timber", "marble", "faith"] as const;

function emptyBundle(): ResourceBundle {
  return { gold: 0, grain: 0, timber: 0, marble: 0, faith: 0 };
}

function addInto(target: ResourceBundle, add: Partial<ResourceBundle>): void {
  for (const k of RESOURCE_KEYS) target[k] += add[k] ?? 0;
}

function playerById(state: GameState, id: string | null): Player | undefined {
  if (!id) return undefined;
  return state.players.find((p) => p.id === id);
}

function ownedProvinces(state: GameState, playerId: string): Province[] {
  return state.provinces.filter((prov) => prov.ownerId === playerId);
}

/** ALLIANCE treaty check (used for controlled/escorted sea hops, §5.2). */
function areAllied(state: GameState, a: string, b: string): boolean {
  if (a === b) return true;
  const pa = playerById(state, a);
  if (!pa) return false;
  return pa.treaties.some(
    (t) =>
      t.type === TreatyType.ALLIANCE &&
      t.parties.includes(a) &&
      t.parties.includes(b),
  );
}

/** Venice/Genoa get the ×1.5 maritime route bonus (§5.2). */
function isMaritimeFaction(faction: Faction | null): boolean {
  return faction === Faction.VENICE || faction === Faction.GENOA;
}

/**
 * Port tier 0..3 used by the trade-route formula (§5.2). Derived from the port's
 * MAP HV flag per the §5.2 band table: HV(4)+ port = 3, HV(3) port = 2, any other
 * (coastal) port = 1; a non-port (non-coastal) province scores 0. Replaces the old
 * `clamp(highValue, 0, 3)`, which over-counted HV3 ports (3 vs doc 2) and
 * under-counted ordinary ports (0 vs doc 1) — see FL-09 / the §5.2 Venice↔Crete
 * worked example.
 */
function portTier(prov: Province): number {
  if (!prov.coastal) return 0; // §5.2: only ports carry a tier; guard non-ports
  const hv = prov.highValue ?? 0;
  if (hv >= 4) return 3; // §5.2 HV(4)+ port
  if (hv === 3) return 2; // §5.2 HV(3) port
  return 1; // §5.2 any other port
}

/** A great work counts as completed once its progress reaches its round count. */
function hasCompletedGreatWork(prov: Province, type: GreatWorkType): boolean {
  const need = GREAT_WORK_COSTS[type].rounds;
  return prov.greatWorks.some((g) => g.type === type && g.progress >= need);
}

/** True when an incite-unrest ('no_income') modifier suppresses a province. */
function isIncomeSuppressed(state: GameState, provinceId: string): boolean {
  return getModifiers(state, "no_income", { provinceId }).length > 0;
}

/**
 * Resolve a faction's faith-income modifiers into an additive delta and a list
 * of multiplicative factors (§4.1 / §13, CONTRACT2 §12.10). Two readers coexist:
 *
 *  - `faith_income` with a numeric `value` and NO `data.multiplier` is ADDITIVE
 *    (a faith yield delta — e.g. a shrine/relic bonus).
 *  - a MULTIPLICATIVE effect (e.g. #28 Papal Interdict's faith ×0, which an
 *    additive sum can never zero) is read either from a dedicated `faith_mult`
 *    kind, or from a `faith_income` modifier carrying `data.multiplier` (the form
 *    the events subsystem currently posts for the Interdict — see events/index.ts
 *    case 28: `kind:'faith_income', value:0, data:{multiplier:0}`).
 */
function faithModifiers(
  state: GameState,
  faction: Faction,
): { add: number; mults: number[] } {
  let add = 0;
  const mults: number[] = [];
  for (const m of getModifiers(state, "faith_income", { faction })) {
    const mult = m.data?.multiplier;
    if (mult !== undefined && mult !== null) {
      mults.push(Number(mult)); // multiplicative faith_income (Interdict ×0 path)
    } else {
      add += m.value ?? 0; // additive faith yield delta
    }
  }
  // Dedicated multiplicative kind (coordination target for events; CONTRACT2 §12.10).
  for (const m of getModifiers(state, "faith_mult", { faction })) {
    mults.push(m.value ?? 1);
  }
  return { add, mults };
}

/**
 * Flat per-round gold from `kind:'income'` modifiers this player collects
 * (EVENT_CARDS #9 Discovery of Alum +2 🪙/round; #39 Relic Discovered +1 🪙/round
 * pilgrimage; CONTRACT2 §12.10 `income → economy`). These modifiers are meant to
 * fire EVERY Income phase (a permanent per-round yield), not once on the draw
 * round — no subsystem read them before, so the bonus applied only once.
 *
 * A province-targeted modifier (#9 targets `chios`) pays the province's current
 * controller; a faction-targeted modifier pays that faction. Untargeted income
 * modifiers are ignored (no global-income grant is defined; see
 * NEEDS-FROM-INTEGRATOR re: #39 posting no target). Applied post-tax as a flat
 * monopoly/pilgrimage yield (a fixed +N gold/round, not scaled by tax posture).
 */
function incomeModifierGold(state: GameState, player: Player): number {
  let gold = 0;
  for (const m of getModifiers(state, "income")) {
    const t = m.target;
    if (t?.provinceId) {
      const prov = state.provinces.find((p) => p.id === t.provinceId);
      if (!prov || prov.ownerId !== player.id) continue; // controller only
    } else if (t?.faction) {
      if (!player.faction || t.faction !== player.faction) continue;
    } else {
      continue; // untargeted income modifier: no global grant defined
    }
    const perRound = (m.data?.perRoundGold as number | undefined) ?? m.value ?? 0;
    gold += perRound;
  }
  return gold;
}

/**
 * Plague penalty to a player's income this Income phase (EVENT_CARDS #35 Black
 * Death Returns: for 2 rounds every CITY and high-value province produces −1 🌾
 * and −1 🪙; CONTRACT2 §12.10 `plague → economy`). The `kind:'plague'` modifier
 * (`data:{grain:-1,gold:-1}`, `expiresRound = round+1`) had no reader, so only the
 * card's draw-round hit landed and the 2nd round was silently dropped (FL-19).
 *
 * Each live plague modifier applies its `data.grain`/`data.gold` delta once per
 * qualifying province the player controls (terrain CITY or highValue > 0). Deltas
 * are signed (already negative for the penalty), so callers ADD them to income.
 */
function plaguePenalty(
  state: GameState,
  player: Player,
): { grain: number; gold: number } {
  const mods = getModifiers(state, "plague");
  if (mods.length === 0) return { grain: 0, gold: 0 };
  let qualifying = 0;
  for (const prov of ownedProvinces(state, player.id)) {
    if (prov.terrain === TerrainType.CITY || (prov.highValue ?? 0) > 0) {
      qualifying += 1;
    }
  }
  if (qualifying === 0) return { grain: 0, gold: 0 };
  let grain = 0;
  let gold = 0;
  for (const m of mods) {
    grain += ((m.data?.grain as number | undefined) ?? 0) * qualifying;
    gold += ((m.data?.gold as number | undefined) ?? 0) * qualifying;
  }
  return { grain, gold };
}

// ---------------------------------------------------------------------------
// Specialty 1:1 trade lane (§4.3 / §5)
// ---------------------------------------------------------------------------

/** Tradeable non-gold, non-faith resources (faith is never tradeable, §4.3). */
type SpecialtyKey = "grain" | "timber" | "marble";
/** Tie-break priority when a port's dominant secondary yield is ambiguous. */
const SPECIALTY_KEYS: SpecialtyKey[] = ["timber", "marble", "grain"];

/**
 * The "port's specialty" good (§4.3 trade-ratio table). The docs name the lane
 * ("1:1 for gold↔the port's specialty") but never enumerate a per-faction good,
 * so it is derived self-containedly as the port's dominant secondary yield (the
 * resource, other than gold/faith, that the province produces most of). See the
 * PR ambiguity note.
 */
function portSpecialty(prov: Province): SpecialtyKey {
  let best: SpecialtyKey = SPECIALTY_KEYS[0];
  let bestVal = -1;
  for (const k of SPECIALTY_KEYS) {
    const v = prov.yields[k] ?? 0;
    if (v > bestVal) {
      bestVal = v;
      best = k;
    }
  }
  return best;
}

/** Owned ports that grant a specialty 1:1 lane (§4.3), with their specialty good. */
function specialtyPorts(
  state: GameState,
  player: Player,
): { prov: Province; specialty: SpecialtyKey }[] {
  const out: { prov: Province; specialty: SpecialtyKey }[] = [];
  for (const prov of ownedProvinces(state, player.id)) {
    // §4.3 trade-ratio port: Venice/Genoa at a coastal port, or a Grand Bazaar.
    const qualifies =
      (isMaritimeFaction(player.faction) && prov.coastal) ||
      hasCompletedGreatWork(prov, GreatWorkType.GRAND_BAZAAR);
    if (qualifies) out.push({ prov, specialty: portSpecialty(prov) });
  }
  return out;
}

/**
 * §4.3/§5 specialty lane: Venice/Genoa (at their own port) and Grand-Bazaar
 * holders trade **gold↔the port's specialty good at 1:1**. Returns
 * `MARKET_RATIOS.specialty` when `give`/`get` is exactly a pure gold↔specialty
 * swap on a qualifying port, else `null` (the ordinary ratio stands).
 */
function specialtyLaneRatio(
  state: GameState,
  player: Player,
  give: Partial<ResourceBundle>,
  get: Partial<ResourceBundle>,
): number | null {
  const ports = specialtyPorts(state, player);
  if (ports.length === 0) return null;
  const giveKeys = RESOURCE_KEYS.filter((k) => (give[k] ?? 0) > 0);
  const getKeys = RESOURCE_KEYS.filter((k) => (get[k] ?? 0) > 0);
  const all = new Set<string>([...giveKeys, ...getKeys]);
  // Must be a pure two-resource swap where exactly one side is gold.
  if (all.size !== 2 || !all.has("gold")) return null;
  const goldGive = giveKeys.length === 1 && giveKeys[0] === "gold";
  const goldGet = getKeys.length === 1 && getKeys[0] === "gold";
  if (!goldGive && !goldGet) return null;
  const other = [...all].find((k) => k !== "gold") as SpecialtyKey | undefined;
  if (!other) return null;
  return ports.some((p) => p.specialty === other) ? MARKET_RATIOS.specialty : null;
}

// ---------------------------------------------------------------------------
// Trade routes (stored on the ActiveModifier side-channel; see NEEDS-FROM-INTEGRATOR)
// ---------------------------------------------------------------------------

interface TradeRoute {
  modifierId: string;
  ownerId: string;
  fromProvinceId: string;
  toProvinceId: string;
  seaZonePath: string[];
  fleetId?: string;
}

/** Read every persisted trade route (kind='trade_route') off the side-channel. */
function tradeRoutesFor(state: GameState, ownerId: string): TradeRoute[] {
  const out: TradeRoute[] = [];
  for (const mod of getModifiers(state, "trade_route")) {
    const d = mod.data ?? {};
    if (d.ownerId !== ownerId) continue;
    out.push({
      modifierId: mod.id,
      ownerId: String(d.ownerId),
      fromProvinceId: String(d.fromProvinceId),
      toProvinceId: String(d.toProvinceId),
      seaZonePath: Array.isArray(d.seaZonePath) ? (d.seaZonePath as string[]) : [],
      fleetId: d.fleetId ? String(d.fleetId) : undefined,
    });
  }
  return out;
}

/**
 * True when `ownerId` (or an ally) has a war fleet — GALLEY or WARSHIP, §5.3 —
 * physically present in the given sea zone. Shared predicate for escort checks
 * AND the §5.2 controlled-hop bonus (marshal economy major: "control" of a sea
 * hop requires a friendly fleet PRESENT, never nominal control of empty water).
 */
function friendlyWarFleetInZone(
  state: GameState,
  ownerId: string,
  zoneId: string,
): boolean {
  return state.fleets.some(
    (f) =>
      f.locationId === zoneId &&
      (f.ownerId === ownerId || areAllied(state, ownerId, f.ownerId)) &&
      ((f.units[UnitType.WARSHIP] ?? 0) > 0 ||
        (f.units[UnitType.GALLEY] ?? 0) > 0),
  );
}

/**
 * True when the route owner has a friendly war fleet escorting a hop. §5.3 defines
 * a war fleet as GALLEY *or* WARSHIP, so a galley escort also prevents piracy
 * (FL-15) — aligned to the severed-escort check below, which already accepts both.
 */
function routeEscorted(state: GameState, route: TradeRoute): boolean {
  return route.seaZonePath.some((zoneId) =>
    friendlyWarFleetInZone(state, route.ownerId, zoneId),
  );
}

/**
 * Gold income of a single route this Income phase (§5.2), before piracy. Applies
 * the port tiers, controlled-hop bonus, Grand-Bazaar port bonus, blockade ×0.5
 * (floor), severed = 0, and the Venice/Genoa ×1.5 (floor) maritime multiplier.
 */
function routeIncome(state: GameState, route: TradeRoute): number {
  const from = state.provinces.find((p) => p.id === route.fromProvinceId);
  const to = state.provinces.find((p) => p.id === route.toProvinceId);
  if (!from || !to) return 0;

  let controlled = 0;
  let anyBlockaded = false;
  let anySevered = false;
  for (const zoneId of route.seaZonePath) {
    const zone = state.seaZones.find((z) => z.id === zoneId);
    const blockedBy = zone?.blockadedBy ?? null;
    const enemyBlock =
      blockedBy != null &&
      blockedBy !== route.ownerId &&
      !areAllied(state, route.ownerId, blockedBy);
    if (enemyBlock) {
      anyBlockaded = true;
      // §5.2 severed = enemy fleet on the hop with no friendly escort.
      if (!friendlyWarFleetInZone(state, route.ownerId, zoneId)) {
        anySevered = true;
      }
    } else if (friendlyWarFleetInZone(state, route.ownerId, zoneId)) {
      // §5.2 +1 per CONTROLLED sea hop (marshal economy major): control demands
      // a friendly (own or allied) war fleet PRESENT in the zone — empty,
      // unblockaded water is merely open sea and pays no bonus.
      controlled += 1;
    }
  }

  // §5.2 base + portTier(A) + portTier(B) + controlledSeaHops.
  let income = TRADE.baseRouteGold + portTier(from) + portTier(to) + controlled;
  // §9 Grand Bazaar: +3 gold per route from that port.
  if (
    hasCompletedGreatWork(from, GreatWorkType.GRAND_BAZAAR) ||
    hasCompletedGreatWork(to, GreatWorkType.GRAND_BAZAAR)
  ) {
    income += 3;
  }

  if (anySevered) return TRADE.severedIncome; // §5.2 severed => 0
  if (anyBlockaded) income = Math.floor(income * TRADE.blockadeMultiplier); // ×0.5 floor
  const owner = playerById(state, route.ownerId);
  if (isMaritimeFaction(owner?.faction ?? null)) {
    income = Math.floor(income * TRADE.maritimeMultiplier); // ×1.5 floor
  }
  return Math.max(0, income);
}

// ---------------------------------------------------------------------------
// Upkeep bookkeeping
// ---------------------------------------------------------------------------

/**
 * Mercenary count of a unit type in a stack (§6.3). Reads the typed
 * {@link Army.mercenaries} tag map, clamped to the actual unit count.
 */
function mercCount(stack: Army | Fleet, u: UnitType): number {
  const m = stack.mercenaries;
  return Math.max(0, Math.min(stack.units[u] ?? 0, m?.[u] ?? 0));
}

/**
 * FL-10 (§4.4 / §6.3): a fielded VARIANT head is a §4.4 mercenary iff its
 * UNIQUE_UNIT_OVERRIDES entry carries the `elite-mercenary` ability — the tag
 * mercenaries.ts `fieldCompany` stamps on auction-fielded elite companies (e.g.
 * the Varangian Remnant, `variant:"VARANGIAN_REMNANT"`). Such heads pay double
 * grain upkeep and desert first, exactly like generic mercenary-tagged units;
 * the 10 ordinary faction uniques are NOT mercenaries and pay the regular rate.
 * (Variant heads live in `stack.variants`, not the UnitType-keyed `mercenaries`
 * map, so they must be recognised here rather than via `mercCount`.)
 */
function isMercVariant(variant: string): boolean {
  return (
    UNIQUE_UNIT_OVERRIDES[variant]?.abilities.includes("elite-mercenary") ?? false
  );
}

/**
 * §2.3 PER-UNIQUE ECONOMY OVERRIDE — effective GRAIN upkeep of a variant head.
 * A unique whose UNIQUE_UNIT_OVERRIDES entry carries `grainUpkeep` is charged
 * that value (e.g. Janissary / Black Army = 0 grain — they draw a gold donative
 * instead, see {@link variantGoldUpkeep}); absent = the base UnitType grain
 * upkeep. `??` keeps an explicit override of 0 (never falls through to base).
 */
function variantGrainUpkeep(variant: string, base: UnitType): number {
  return UNIQUE_UNIT_OVERRIDES[variant]?.grainUpkeep ?? UNIT_STATS[base].grainUpkeep;
}

/**
 * §2.3 PER-UNIQUE ECONOMY OVERRIDE — per-unit GOLD upkeep (donative pay) of a
 * variant head. Only uniques with a `goldUpkeep` override draw gold each upkeep
 * (Janissary / Black Army = 1 gold, "gold-paid" §2.3 units); base units and all
 * other uniques owe none. Charged in the {@link upkeep} gold-upkeep path (§4.4).
 */
function variantGoldUpkeep(variant: string): number {
  return UNIQUE_UNIT_OVERRIDES[variant]?.goldUpkeep ?? 0;
}

/**
 * Gold a player owes this upkeep from §2.3 gold-paid uniques (donative pay).
 * Mercenary variant heads pay the ×2 rate here too (kept intact, §4.4), though
 * no current merc unique carries `goldUpkeep`. Base units never owe gold upkeep.
 */
function goldUpkeepDue(state: GameState, playerId: string): number {
  let due = 0;
  const stacks: (Army | Fleet)[] = [
    ...state.armies.filter((a) => a.ownerId === playerId),
    ...state.fleets.filter((f) => f.ownerId === playerId),
  ];
  for (const stack of stacks) {
    for (const v of stack.variants ?? []) {
      const per = variantGoldUpkeep(v.variant);
      if (per <= 0) continue;
      const mult = isMercVariant(v.variant) ? MERC_UPKEEP_MULTIPLIER : 1;
      due += v.count * per * mult;
    }
  }
  return Math.max(0, due);
}

/**
 * faction-scoped base-LEVY economy (devshirme / strongest-levies) — balance A/B
 * PR #11 @d332061. Effective GRAIN upkeep of a BASE unit for a faction: a base LEVY
 * reads FACTION_LEVY_ECONOMY[faction].grainUpkeep when defined (`??` so an explicit
 * 0 — the Ottoman devshirme rate — wins over the base 1); every other base unit,
 * and any player with no faction, keeps UNIT_STATS[u].grainUpkeep. Shared by
 * {@link grainDue} and the starvation-desertion relief so the ledger stays balanced
 * (a 0-grain levy contributes nothing to the bill AND relieves nothing on desert).
 * Only the base LEVY rate is faction-scoped; variant/mercenary upkeep is untouched.
 */
function baseGrainUpkeep(u: UnitType, faction: Faction | null): number {
  if (u === UnitType.LEVY && faction != null) {
    return FACTION_LEVY_ECONOMY[faction]?.grainUpkeep ?? UNIT_STATS[u].grainUpkeep;
  }
  return UNIT_STATS[u].grainUpkeep;
}

/** Grain a player owes this Income phase: Σ unit upkeep (mercenaries ×2, §4.4). */
function grainDue(state: GameState, playerId: string): number {
  let due = 0;
  const player = playerById(state, playerId);
  const faction = player?.faction ?? null;
  const stacks: (Army | Fleet)[] = [
    ...state.armies.filter((a) => a.ownerId === playerId),
    ...state.fleets.filter((f) => f.ownerId === playerId),
  ];
  for (const stack of stacks) {
    for (const u of Object.values(UnitType)) {
      const total = stack.units[u] ?? 0;
      if (total <= 0) continue;
      const mercs = mercCount(stack, u);
      const regular = total - mercs;
      // §LEVY faction lever (PR #11 @d332061): a base LEVY owes this faction's
      // grain rate (Ottoman devshirme = 0); other base units keep UNIT_STATS.
      const per = baseGrainUpkeep(u, faction);
      due += regular * per + mercs * per * MERC_UPKEEP_MULTIPLIER; // §4.4 merc double
    }
    for (const v of stack.variants ?? []) {
      // §2.3 per-unique override: a variant whose UNIQUE_UNIT_OVERRIDES entry
      // carries `grainUpkeep` is charged THAT amount, not the base UnitType
      // upkeep (e.g. Janissary / Black Army = 0 grain — they draw a gold
      // donative instead; see the gold-upkeep path in `upkeep`). Absent = base.
      // §4.4/§6.3 FL-10: elite-mercenary variant heads (e.g. the Varangian
      // Remnant) owe DOUBLE grain upkeep like any mercenary; the 10 ordinary
      // faction uniques pay the (per-unique or base) regular rate.
      const per = variantGrainUpkeep(v.variant, v.base);
      const mult = isMercVariant(v.variant) ? MERC_UPKEEP_MULTIPLIER : 1;
      due += v.count * per * mult;
    }
  }
  // §4.4 event/tactic upkeep delta: an 'upkeep_mod' modifier (CONTRACT2 §12.10)
  // adds to (or, if negative, relieves) the grain a faction owes this phase.
  if (player?.faction) {
    due += sumModifierValues(state, "upkeep_mod", { faction: player.faction });
  }
  return Math.max(0, due);
}

// ---------------------------------------------------------------------------
// computeIncome — read-only projection (§4.1)
// ---------------------------------------------------------------------------

/**
 * Project income for every player without mutating state (§4.1). Sums owned
 * province yields, building bonuses, tax multiplier and trade-route gold, and
 * reports each player's grain shortfall for the upkeep step.
 */
export function computeIncome(state: GameState): IncomeResult {
  const perPlayer: Record<string, ResourceBundle> = {};
  const shortfall: Record<string, number> = {};

  for (const player of state.players) {
    const income = emptyBundle();

    for (const prov of ownedProvinces(state, player.id)) {
      // §10.7 incite-unrest: a suppressed province yields nothing this Income.
      if (isIncomeSuppressed(state, prov.id)) continue;
      addInto(income, prov.yields); // §4.1 Σ province yields
      // §9.1 building yield bonuses (Market +1 gold, Temple +1 faith).
      for (const b of prov.buildings) {
        const bonus = BUILDING_EFFECTS[b].yieldBonus;
        if (bonus) addInto(income, bonus);
      }
      // §9.2/FACTIONS §Hagia Sophia (RULING 1, aligned per the marshal
      // answer-key major "RULING 1 over-reaches ratified"): the great church
      // STARTS INTACT and Constantinople yields a STANDING +2 faith/round from
      // round 1, on top of its listed yield, INDEPENDENT of the HAGIA_SOPHIA
      // great work (which is a prestige-only restoration/endowment, NOT the
      // source of this faith). The ratified "never sacked" condition gates ONLY
      // the "Faith of the Fathers" secret OBJECTIVE (prestige.ts) — it does NOT
      // gate this income, so the previous `!prov.sacked` gate here was an
      // over-reach and is removed.
      if (prov.id === "constantinople") {
        income.faith += 2;
      }
    }

    // §5.2 trade-route gold (before piracy).
    let routeGold = 0;
    for (const route of tradeRoutesFor(state, player.id)) {
      routeGold += routeIncome(state, route);
    }
    // §5.2 event/tactic 'trade_mod' delta on route gold (CONTRACT2 §12.10) —
    // e.g. #18 Venetian–Genoese War (−2 trade). Floored at 0 (never negative gold).
    if (player.faction) {
      routeGold += sumModifierValues(state, "trade_mod", {
        faction: player.faction,
      });
    }
    income.gold += Math.max(0, routeGold);

    // §4.1/§13 faith income modifiers (kind='faith_income'/'faith_mult'): additive
    // yield deltas plus multiplicative effects (#28 Papal Interdict faith ×0).
    if (player.faction) {
      const { add, mults } = faithModifiers(state, player.faction);
      income.faith += add;
      for (const mult of mults) income.faith = Math.floor(income.faith * mult);
      income.faith = Math.max(0, income.faith);
    }

    // §4.2 taxation multiplier applies to gold only (floor fractional gold).
    income.gold = Math.floor(income.gold * TAX_MULTIPLIERS[player.tax]);

    // §4.1 permanent per-round income modifiers (#9 Discovery of Alum, #39 Relic
    // pilgrimage): flat +N gold/round, applied post-tax (EVENT_CARDS #9/#39).
    income.gold += incomeModifierGold(state, player);

    // EVENT_CARDS #35 Black Death: −1 grain/−1 gold per controlled CITY/high-value
    // province, each round the plague modifier is live (both rounds now land).
    const plague = plaguePenalty(state, player);
    income.gold += plague.gold;
    income.grain += plague.grain;

    // §4.1 income is a non-negative yield: the plague penalty reduces production
    // down to (never below) zero, so a credited bundle can never drive a treasury
    // negative outside the documented debt rule.
    income.gold = Math.max(0, income.gold);
    income.grain = Math.max(0, income.grain);

    perPlayer[player.id] = income;
    // Grain shortfall after adding this income to current stores (§4.4).
    const due = grainDue(state, player.id);
    shortfall[player.id] = Math.max(
      0,
      due - (player.treasury.grain + income.grain),
    );
  }

  return { perPlayer, shortfall };
}

// ---------------------------------------------------------------------------
// applyIncomePhase — credit income, piracy, upkeep, heavy-tax revolts (§4)
// ---------------------------------------------------------------------------

/**
 * Resolve the whole Income phase: resolve piracy on unescorted merchant routes,
 * credit computed income into treasuries, run {@link upkeep} (grain + starvation
 * desertion), and roll the Heavy-tax 1-in-6 revolt check. Consumes the seeded
 * RNG and writes the advanced cursor back onto the returned state. Pure.
 */
export function applyIncomePhase(state: GameState): GameState {
  const rng = makeRng(state.rngSeed, state.rngCursor);
  let next = structuredClone(state) as GameState;

  // 1) Piracy: unescorted merchant fleets risk being sunk (§5.3). Resolved first
  //    so a sunk route contributes no income when we recompute below.
  for (const player of next.players) {
    for (const route of tradeRoutesFor(next, player.id)) {
      if (routeEscorted(next, route)) continue; // war fleet escort prevents piracy
      if (rng.rollD6() > TRADE.piracySinkRoll) continue; // §5.3 sink on 1d6 <= 2
      // Sink one merchant galley from the route's fleet and drop the route.
      const fleet = route.fleetId
        ? next.fleets.find((f) => f.id === route.fleetId)
        : undefined;
      if (fleet && (fleet.units[UnitType.GALLEY] ?? 0) > 0) {
        fleet.units[UnitType.GALLEY] -= 1;
      }
      next = removeModifier(next, route.modifierId);
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "trade",
        actors: [player.id],
        targets: [route.fromProvinceId, route.toProvinceId],
        message: `A merchant galley of ${player.name} was lost to piracy; the ${route.fromProvinceId}→${route.toProvinceId} route is broken.`,
        data: { route: route.modifierId },
      });
    }
  }

  // 2) Credit income (computed on the post-piracy state).
  const result = computeIncome(next);
  for (const player of next.players) {
    const inc = result.perPlayer[player.id];
    if (!inc) continue;
    addInto(player.treasury, inc);
    next = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "trade",
      actors: [player.id],
      message: `${player.name} collects income: +${inc.gold} gold, +${inc.grain} grain, +${inc.faith} faith.`,
      data: { income: inc, tax: player.tax },
    });
  }

  // 3) Upkeep & starvation (§4.4).
  next = upkeep(next);

  // 4) Heavy-tax revolt check: 1-in-6 per over-taxed owned province (§4.2).
  for (const player of next.players) {
    if (player.tax !== TaxPosture.HEAVY) continue;
    for (const prov of next.provinces) {
      if (prov.ownerId !== player.id) continue;
      if (rng.rollD6() > TAX_REVOLT.heavyRevoltRoll) continue; // revolt on d6 <= 1
      prov.ownerId = null; // §4.2 revolting province flips to neutral
      // No dedicated 'revolt'/'unrest' GameLogType exists (see NEEDS-FROM-INTEGRATOR);
      // 'phase' is the closest generic member for this Income-phase upheaval.
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "phase",
        actors: [player.id],
        targets: [prov.id],
        message: `${prov.name} revolts under heavy taxation and turns neutral.`,
        data: { reason: "heavy_tax_revolt" },
      });
    }
  }

  next.rngCursor = rng.cursor; // determinism: persist advanced cursor
  return next;
}

// ---------------------------------------------------------------------------
// upkeep — grain payment + starvation desertion (§4.4)
// ---------------------------------------------------------------------------

/**
 * Pay grain upkeep for all armies/fleets and resolve starvation desertion. Grain
 * stores are spent first; on shortfall units desert in DESERTION_ORDER
 * (LEVY→ARCHER→INFANTRY→CAVALRY→SIEGE), with mercenaries deserting first and at
 * double rate (§4.4). Pure; does not consume the RNG (deterministic order).
 */
export function upkeep(state: GameState): GameState {
  let next = structuredClone(state) as GameState;

  for (const player of next.players) {
    const due = grainDue(next, player.id);
    if (due <= 0) continue;

    if (player.treasury.grain >= due) {
      player.treasury.grain -= due; // §4.4 pay upkeep from stores
      continue;
    }

    // Short by `deficit` grain: spend all stores, then desert to cover the rest.
    let deficit = due - player.treasury.grain;
    player.treasury.grain = 0;

    const stacks: (Army | Fleet)[] = [
      ...next.armies.filter((a) => a.ownerId === player.id),
      ...next.fleets.filter((f) => f.ownerId === player.id),
    ];
    const deserted: Partial<Record<UnitType, number>> = {};
    // DELTA 5 (§4.4/§11): host provinces where an UNPAID mercenary deserted this
    // upkeep. The departing company PILLAGES its host on the way out — collected
    // here (Phase A only) and settled after desertion resolves. Populated ONLY by
    // mercenary desertion, never by ordinary (Phase B) desertion.
    const pillagedHosts = new Set<string>();

    const record = (u: UnitType, n: number) => {
      deserted[u] = (deserted[u] ?? 0) + n;
    };

    // Phase A: mercenaries desert FIRST and at DOUBLE rate (§4.4). A mercenary's
    // upkeep is MERC_UPKEEP_MULTIPLIER × the base (that ×2 is already counted in
    // grainDue), so each mercenary that deserts relieves its own doubled upkeep
    // from the outstanding deficit. This keeps the ledger balanced (the merc
    // train that created the doubled shortfall is exactly what unwinds it) rather
    // than culling a phantom second unit per grain owed.
    for (const u of DESERTION_ORDER) {
      // §LEVY faction lever (PR #11 @d332061): relief per deserting merc uses this
      // faction's base grain rate ×2 (mirrors grainDue). A 0-grain base levy
      // (Ottoman devshirme) relieves nothing, so it never deserts for grain.
      const per = baseGrainUpkeep(u, player.faction) * MERC_UPKEEP_MULTIPLIER;
      if (per <= 0) continue;
      for (const stack of stacks) {
        const m = stack.mercenaries;
        // Generic mercenary-tagged units of this type desert first (×2 relief).
        while (deficit > 0 && mercCount(stack, u) > 0) {
          stack.units[u] -= 1;
          if (m) m[u] = (m[u] ?? 0) - 1;
          record(u, 1);
          pillagedHosts.add(stack.locationId); // DELTA 5: merc deserts → pillage host
          deficit -= per;
        }
        // §4.4/§6.3 FL-10: elite-mercenary VARIANT heads of this base type also
        // desert first, at the same doubled rate. They are NOT in the UnitType-
        // keyed `mercenaries` map (which clamps to generic `units`), so scan the
        // stack's `variants` explicitly — e.g. Varangian Remnant INFANTRY/CAVALRY
        // heads leave before any regular unit does.
        if (deficit > 0) {
          for (const v of stack.variants ?? []) {
            if (v.base !== u || !isMercVariant(v.variant)) continue;
            while (deficit > 0 && v.count > 0) {
              v.count -= 1;
              record(u, 1);
              pillagedHosts.add(stack.locationId); // DELTA 5: merc deserts → pillage host
              deficit -= per;
            }
            if (deficit <= 0) break;
          }
        }
        if (deficit <= 0) break;
      }
      if (deficit <= 0) break;
    }

    // Phase B: regular units desert lowest-value first (§4.4).
    if (deficit > 0) {
      for (const u of DESERTION_ORDER) {
        // §LEVY faction lever (PR #11 @d332061): a base LEVY relieves this faction's
        // grain rate (Ottoman devshirme = 0). A 0-grain unit relieves nothing, so it
        // never deserts for grain (and the loop can never stall on a 0-relief unit).
        const per = baseGrainUpkeep(u, player.faction);
        if (per <= 0) continue;
        for (const stack of stacks) {
          while (deficit > 0 && (stack.units[u] ?? 0) > 0) {
            stack.units[u] -= 1;
            record(u, 1);
            deficit -= per;
          }
          if (deficit <= 0) break;
        }
        if (deficit <= 0) break;
      }
    }

    // Drop any variant stack fully emptied by desertion (FL-10 tidy-up).
    for (const stack of stacks) {
      if (stack.variants) stack.variants = stack.variants.filter((v) => v.count > 0);
    }

    const totalDeserted = Object.values(deserted).reduce(
      (acc, n) => acc + (n ?? 0),
      0,
    );
    if (totalDeserted > 0) {
      // No dedicated 'desertion' GameLogType exists; 'mercenary' is the closest
      // military-economy member (mercenaries desert first at double rate, §4.4).
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "mercenary",
        actors: [player.id],
        message: `${player.name} cannot feed the host: ${totalDeserted} unit(s) desert to starvation.`,
        data: { deserted },
      });
    }

    // DELTA 5 (§4.4/§11, delta 5): unpaid mercenaries that DESERTED this upkeep
    // PILLAGE the province that hosted them — MERC_REVOLT_PILLAGE.pillageGold is
    // stripped from each host province's OWNER (clamped at 0) as the departing
    // company sacks its way out. Fires ONLY for mercenary (Phase A) desertion —
    // `pillagedHosts` is never populated by ordinary Phase B desertion. A neutral
    // (owner-less) host has no controller to rob, so it is skipped.
    for (const provId of pillagedHosts) {
      const prov = next.provinces.find((pr) => pr.id === provId);
      if (!prov) continue;
      const victim = playerById(next, prov.ownerId);
      if (!victim) continue; // §4.4 neutral host: no controller to pillage
      const before = victim.treasury.gold;
      victim.treasury.gold = Math.max(0, before - MERC_REVOLT_PILLAGE.pillageGold);
      const stripped = before - victim.treasury.gold;
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "mercenary",
        actors: [player.id],
        targets: [prov.id],
        message: `Deserting mercenaries pillage ${prov.name}, stripping ${stripped} gold from ${victim.name}.`,
        data: { pillageGold: stripped, province: prov.id, victim: victim.id },
      });
    }
  }

  // --- Gold upkeep (§2.3 donative pay / §4.4) --------------------------------
  // A unique VARIANT head carrying a `goldUpkeep` override (Janissary, Black
  // Army — the "gold-paid" §2.3 units) draws GOLD each upkeep instead of grain.
  // Deduct it from the treasury; on shortfall the unpaid gold-paid troops mutiny
  // and desert until the deficit clears — the §4.4 desertion consequence applied
  // to the gold ledger (grain has its own path above). Mercenary variant heads
  // pay the ×2 rate here too (kept intact). Runs as a SEPARATE player loop after
  // the grain settlement so a fed-on-grain army still answers its donative.
  // (appendLog uses a shallow spread, so `next.players` identity — and thus the
  // in-place treasury/variant mutations — survives each grain-loop appendLog.)
  for (const player of next.players) {
    const due = goldUpkeepDue(next, player.id);
    if (due <= 0) continue;

    if (player.treasury.gold >= due) {
      player.treasury.gold -= due; // §2.3 pay the donative from the treasury
      continue;
    }

    // Short by `deficit` gold: spend all gold, then mutiny to cover the rest.
    let deficit = due - player.treasury.gold;
    player.treasury.gold = 0;

    const stacks: (Army | Fleet)[] = [
      ...next.armies.filter((a) => a.ownerId === player.id),
      ...next.fleets.filter((f) => f.ownerId === player.id),
    ];
    const mutinied: Partial<Record<UnitType, number>> = {};

    // §4.4 desert lowest-value first among the GOLD-PAYING variant heads. Only
    // variant heads with a `goldUpkeep` override are gold-paid, so ordinary
    // units and non-gold uniques are never touched by a donative shortfall.
    for (const u of DESERTION_ORDER) {
      for (const stack of stacks) {
        for (const v of stack.variants ?? []) {
          if (v.base !== u) continue;
          const per = variantGoldUpkeep(v.variant);
          if (per <= 0) continue;
          const mult = isMercVariant(v.variant) ? MERC_UPKEEP_MULTIPLIER : 1;
          while (deficit > 0 && v.count > 0) {
            v.count -= 1;
            mutinied[u] = (mutinied[u] ?? 0) + 1;
            deficit -= per * mult; // each mutineer relieves its own donative
          }
          if (deficit <= 0) break;
        }
        if (deficit <= 0) break;
      }
      if (deficit <= 0) break;
    }

    // Drop any variant stack fully emptied by the mutiny.
    for (const stack of stacks) {
      if (stack.variants) stack.variants = stack.variants.filter((v) => v.count > 0);
    }

    const totalMutinied = Object.values(mutinied).reduce(
      (acc, n) => acc + (n ?? 0),
      0,
    );
    if (totalMutinied > 0) {
      // No dedicated 'desertion' GameLogType exists; 'mercenary' is the closest
      // military-economy member (gold-paid troops mutiny when the donative fails).
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "mercenary",
        actors: [player.id],
        message: `${player.name} cannot pay the donative: ${totalMutinied} gold-paid unit(s) mutiny and desert.`,
        data: { mutinied, unpaid: "gold" },
      });
    }
  }

  return next;
}

// ---------------------------------------------------------------------------
// applyTrade — market conversion (§4.3) and trade-route setup (§5)
// ---------------------------------------------------------------------------

/** Best (lowest) market give:get ratio available to a player (§4.3). */
function bestMarketRatio(state: GameState, player: Player): number {
  let ratio: number = MARKET_RATIOS.base; // 3:1 with no infrastructure
  const provs = ownedProvinces(state, player.id);
  if (provs.some((p) => p.buildings.includes(BuildingType.MARKET))) {
    ratio = Math.min(ratio, MARKET_RATIOS.market); // 2:1
  }
  if (
    isMaritimeFaction(player.faction) &&
    provs.some((p) => p.coastal)
  ) {
    ratio = Math.min(ratio, MARKET_RATIOS.port); // 2:1 trade-ratio port
  }
  if (
    provs.some((p) => hasCompletedGreatWork(p, GreatWorkType.GRAND_BAZAAR))
  ) {
    // DA-1 (§4.3, CANON CLARIFICATION 3): a Grand Bazaar trades GENERAL goods at
    // 2:1 (MARKET_RATIOS.bazaar, raised 1→2 by FIX-PREP2), NOT a universal 1:1.
    // The owner's specialty good still trades 1:1, but via the SEPARATE specialty
    // lane (specialtyLaneRatio / MARKET_RATIOS.specialty, applied in applyTrade),
    // never through this general ratio.
    ratio = Math.min(ratio, MARKET_RATIOS.bazaar); // 2:1 general
  }
  return ratio;
}

function bundleTotal(b: Partial<ResourceBundle>): number {
  return RESOURCE_KEYS.reduce((acc, k) => acc + (b[k] ?? 0), 0);
}

/**
 * Apply a TRADE action: a market conversion (CONVERT) or a trade-route
 * establishment (ROUTE). Assumes the action budget has already been spent by the
 * reducer. Throws {@link EngineError} on illegal trades. Pure.
 */
export function applyTrade(state: GameState, action: GameAction): GameState {
  if (action.type !== "TRADE") {
    throw new EngineError("UNKNOWN_ACTION", "applyTrade requires a TRADE action.");
  }
  const player = playerById(state, action.player);
  if (!player) throw new EngineError("UNKNOWN_PLAYER", "No such player.");
  const trade = action.trade;

  if (trade.kind === "CONVERT") {
    // AUTHORITY MAJOR (marshal review: "TRADE CONVERT accepts negative
    // components — mints faith / negative treasuries"): every component of give
    // AND get must be a non-negative integer. A negative give component would be
    // CREDITED to the treasury (`treasury -= give`), letting a client mint faith
    // (which the >0 faith gate below never sees) or gold while the signed totals
    // still balance; fractional amounts would corrupt integer treasuries.
    for (const k of RESOURCE_KEYS) {
      const g = trade.give[k] ?? 0;
      const r = trade.get[k] ?? 0;
      if (!Number.isInteger(g) || g < 0 || !Number.isInteger(r) || r < 0) {
        throw new EngineError(
          "BAD_TRADE",
          `Trade components must be non-negative integers (${k}).`,
        );
      }
    }
    // §4.3 faith is non-tradeable.
    if ((trade.give.faith ?? 0) > 0 || (trade.get.faith ?? 0) > 0) {
      throw new EngineError(
        "FAITH_NOT_TRADEABLE",
        "Faith cannot be traded at market.",
      );
    }
    const giveTotal = bundleTotal(trade.give);
    const getTotal = bundleTotal(trade.get);
    if (getTotal <= 0 || giveTotal <= 0) {
      throw new EngineError("BAD_TRADE", "Trade must give and get resources.");
    }
    let ratio = bestMarketRatio(state, player);
    // §4.3 event/tactic 'trade_mod' ratio delta (CONTRACT2 §12.10): positive
    // improves the ratio, negative worsens it; never better than the 1:1 hard
    // floor. DA-1 raised MARKET_RATIOS.bazaar to the 2:1 GENERAL ratio, so the
    // true 1:1 floor is now MARKET_RATIOS.specialty (was bazaar).
    if (player.faction) {
      const tradeMod = sumModifierValues(state, "trade_mod", {
        faction: player.faction,
      });
      ratio = Math.max(MARKET_RATIOS.specialty, ratio - tradeMod);
    }
    // §4.3/§5 specialty 1:1 lane: Venice/Genoa (own port) & Grand Bazaar trade
    // gold↔the port's specialty good at 1:1.
    const specialty = specialtyLaneRatio(state, player, trade.give, trade.get);
    if (specialty !== null) ratio = Math.min(ratio, specialty);
    if (giveTotal < getTotal * ratio) {
      throw new EngineError(
        "BAD_TRADE",
        `Market ratio ${ratio}:1 needs ${getTotal * ratio} given for ${getTotal}.`,
      );
    }
    // Validate the treasury actually holds what is being given.
    for (const k of RESOURCE_KEYS) {
      if ((trade.give[k] ?? 0) > player.treasury[k]) {
        throw new EngineError(
          "INSUFFICIENT_RESOURCES",
          `${player.name} lacks ${k} for this trade.`,
        );
      }
    }
    const next = structuredClone(state) as GameState;
    const p = playerById(next, action.player)!;
    for (const k of RESOURCE_KEYS) {
      p.treasury[k] -= trade.give[k] ?? 0;
      p.treasury[k] += trade.get[k] ?? 0;
    }
    return appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "trade",
      actors: [action.player],
      message: `${player.name} converts resources at the market (${ratio}:1).`,
      data: { give: trade.give, get: trade.get, ratio },
    });
  }

  // trade.kind === "ROUTE": establish a trade route between two owned ports.
  const from = state.provinces.find((p) => p.id === trade.fromProvinceId);
  const to = state.provinces.find((p) => p.id === trade.toProvinceId);
  if (!from || !to) {
    throw new EngineError("BAD_TRADE", "Route endpoints must be real provinces.");
  }
  if (from.ownerId !== player.id || to.ownerId !== player.id) {
    throw new EngineError("NOT_OWNER", "Both ports of a route must be owned.");
  }
  // §5.1 routes link owned coastal ports.
  if (!from.coastal || !to.coastal) {
    throw new EngineError("BAD_TRADE", "Route endpoints must be coastal ports.");
  }
  // B1 (§5.2, marshal blocker): the seaZonePath MUST be validated before a
  // route is created — an unvalidated path let a client mint unbounded route
  // income (+1/zone, ×1.5 Venice/Genoa) from fabricated geography.
  const path = trade.seaZonePath;
  // B1(a-pre): a sea route sails through at least one real sea zone.
  if (path.length === 0) {
    throw new EngineError(
      "BAD_ROUTE_PATH",
      "A trade route needs at least one sea zone in its path.",
    );
  }
  for (const zoneId of path) {
    if (!state.seaZones.some((z) => z.id === zoneId)) {
      throw new EngineError("BAD_ROUTE_PATH", `Unknown sea zone: ${zoneId}.`);
    }
  }
  // B1(b): the from-port must border the FIRST zone, the to-port the LAST.
  if (!areAdjacent(trade.fromProvinceId, path[0])) {
    throw new EngineError(
      "BAD_ROUTE_PATH",
      `${from.name} does not border the sea zone ${path[0]}.`,
    );
  }
  if (!areAdjacent(trade.toProvinceId, path[path.length - 1])) {
    throw new EngineError(
      "BAD_ROUTE_PATH",
      `${to.name} does not border the sea zone ${path[path.length - 1]}.`,
    );
  }
  // B1(a): the zones form a connected chain — each consecutive pair must share
  // a sea adjacency edge (mapData §7 "Connects To" straits).
  for (let i = 1; i < path.length; i += 1) {
    if (!areAdjacent(path[i - 1], path[i])) {
      throw new EngineError(
        "BAD_ROUTE_PATH",
        `Sea zones ${path[i - 1]} and ${path[i]} are not connected.`,
      );
    }
  }
  // B1(c): reject a duplicate route for the same {from,to} port pair (in either
  // direction — A→B and B→A are the same trade lane).
  for (const mod of getModifiers(state, "trade_route")) {
    const d = mod.data ?? {};
    const sameForward =
      d.fromProvinceId === trade.fromProvinceId &&
      d.toProvinceId === trade.toProvinceId;
    const sameReversed =
      d.fromProvinceId === trade.toProvinceId &&
      d.toProvinceId === trade.fromProvinceId;
    if (sameForward || sameReversed) {
      throw new EngineError(
        "DUP_ROUTE",
        `A trade route between ${from.name} and ${to.name} already exists.`,
      );
    }
  }
  // B1(d): every route must be backed by a DISTINCT friendly GALLEY fleet. The
  // backing fleetId is recorded on the route modifier; a galley fleet already
  // backing another route (any owner's — ids are global) cannot back a second.
  const busyFleetIds = new Set<string>();
  for (const mod of getModifiers(state, "trade_route")) {
    const fid = mod.data?.fleetId;
    if (fid) busyFleetIds.add(String(fid));
  }
  const galleyFleets = state.fleets.filter(
    (f) => f.ownerId === player.id && (f.units[UnitType.GALLEY] ?? 0) > 0,
  );
  if (galleyFleets.length === 0) {
    throw new EngineError(
      "NO_GALLEY",
      "A GALLEY merchantman is required to run a trade route.",
    );
  }
  const merchant = galleyFleets.find((f) => !busyFleetIds.has(f.id));
  if (!merchant) {
    throw new EngineError(
      "GALLEY_BUSY",
      "Every GALLEY fleet already backs another trade route; a distinct galley is required per route.",
    );
  }

  const next = structuredClone(state) as GameState;
  const modId = `trade_route-${next.logCounter}`;
  next.activeModifiers = [
    ...next.activeModifiers,
    {
      id: modId,
      scope: "persistent",
      kind: "trade_route",
      value: 0,
      data: {
        ownerId: player.id,
        fromProvinceId: trade.fromProvinceId,
        toProvinceId: trade.toProvinceId,
        seaZonePath: trade.seaZonePath,
        fleetId: merchant.id,
      },
    },
  ];
  const projected = routeIncome(next, {
    modifierId: modId,
    ownerId: player.id,
    fromProvinceId: trade.fromProvinceId,
    toProvinceId: trade.toProvinceId,
    seaZonePath: trade.seaZonePath,
    fleetId: merchant.id,
  });
  return appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "trade",
    actors: [action.player],
    targets: [trade.fromProvinceId, trade.toProvinceId],
    message: `${player.name} establishes a trade route ${from.name}→${to.name} (~${projected} gold/round).`,
    data: { routeIncome: projected, route: modId },
  });
}

// ---------------------------------------------------------------------------
// applyBuild — buildings, walls and multi-round great works (§9)
// ---------------------------------------------------------------------------

function canAfford(treasury: ResourceBundle, cost: Partial<ResourceBundle>): boolean {
  return RESOURCE_KEYS.every((k) => treasury[k] >= (cost[k] ?? 0));
}

function pay(treasury: ResourceBundle, cost: Partial<ResourceBundle>): void {
  for (const k of RESOURCE_KEYS) treasury[k] -= cost[k] ?? 0;
}

/**
 * Apply a BUILD action: construct a building, upgrade walls, or invest a round
 * into a great work (§9). Assumes the reducer has spent the action and asserted
 * that exactly one of building/greatWork is set. Throws {@link EngineError} on
 * an illegal build. Pure.
 */
export function applyBuild(state: GameState, action: GameAction): GameState {
  if (action.type !== "BUILD") {
    throw new EngineError("UNKNOWN_ACTION", "applyBuild requires a BUILD action.");
  }
  const player = playerById(state, action.player);
  if (!player) throw new EngineError("UNKNOWN_PLAYER", "No such player.");
  const prov = state.provinces.find((p) => p.id === action.provinceId);
  if (!prov) throw new EngineError("BAD_BUILD", "No such province.");
  if (prov.ownerId !== player.id) {
    throw new EngineError("NOT_OWNER", "Can only build in owned provinces.");
  }

  const next = structuredClone(state) as GameState;
  const p = playerById(next, action.player)!;
  const province = next.provinces.find((x) => x.id === action.provinceId)!;

  // --- Ordinary building (or walls upgrade) -------------------------------
  if (action.building) {
    if (action.building === BuildingType.WALLS) {
      // §8.1/§9.1 walls upgrade the fortification tier one step at a time.
      const nextTier = province.walls.tier + 1;
      // §9.1 (marshal economy major "ordinary BUILD raises walls to T4/T5"): the
      // ordinary BUILD ladder tops out at Walls Lv2 = T3. T4 is authored map
      // data only (belgrade/rome); T5 is the Theodosian Walls GREAT WORK only
      // (§9.2, completeGreatWork below). WALL_BUILD_COST rows 4/5 exist solely
      // for event/great-work rebuild pricing, never for the client BUILD action.
      if (nextTier > MAX_BUILDABLE_WALL_TIER) {
        throw new EngineError(
          "WALL_TIER_CAP",
          `Ordinary construction cannot raise walls above tier ${MAX_BUILDABLE_WALL_TIER} (§9.1); T5 is the Theodosian Walls great work.`,
        );
      }
      const cost = WALL_BUILD_COST[nextTier];
      if (!cost) {
        throw new EngineError("BAD_BUILD", "Walls are already at the maximum tier.");
      }
      if (!canAfford(p.treasury, cost)) {
        throw new EngineError(
          "INSUFFICIENT_RESOURCES",
          `${player.name} cannot afford walls tier ${nextTier}.`,
        );
      }
      pay(p.treasury, cost);
      province.walls = { tier: nextTier, hp: WALL_TIERS[nextTier].hp };
      return appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "build",
        actors: [action.player],
        targets: [province.id],
        message: `${player.name} raises walls to tier ${nextTier} at ${province.name}.`,
        data: { walls: province.walls },
      });
    }

    if (province.buildings.includes(action.building)) {
      throw new EngineError(
        "BAD_BUILD",
        `${province.name} already has a ${action.building}.`,
      );
    }
    const cost = BUILDING_COSTS[action.building];
    if (!canAfford(p.treasury, cost)) {
      throw new EngineError(
        "INSUFFICIENT_RESOURCES",
        `${player.name} cannot afford ${action.building}.`,
      );
    }
    pay(p.treasury, cost);
    province.buildings = [...province.buildings, action.building];
    return appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "build",
      actors: [action.player],
      targets: [province.id],
      message: `${player.name} builds a ${action.building} at ${province.name}.`,
      data: { building: action.building, cost },
    });
  }

  // --- Great work (multi-round) -------------------------------------------
  if (action.greatWork) {
    const def = GREAT_WORK_COSTS[action.greatWork];
    const existing = province.greatWorks.find((g) => g.type === action.greatWork);

    if (!existing) {
      // §9.2 first investment pays the full cost up front, then 1 round invested.
      if (!canAfford(p.treasury, def.cost)) {
        throw new EngineError(
          "INSUFFICIENT_RESOURCES",
          `${player.name} cannot afford the ${action.greatWork}.`,
        );
      }
      pay(p.treasury, def.cost);
      const progress = { type: action.greatWork, progress: 1 };
      province.greatWorks = [...province.greatWorks, progress];
      const done = progress.progress >= def.rounds;
      let out = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "build",
        actors: [action.player],
        targets: [province.id],
        message: `${player.name} begins the ${action.greatWork} at ${province.name} (1/${def.rounds}).`,
        data: { greatWork: action.greatWork, progress: 1, rounds: def.rounds },
      });
      if (done) out = completeGreatWork(out, action.player, province.id, action.greatWork);
      return out;
    }

    if (existing.progress >= def.rounds) {
      throw new EngineError(
        "BAD_BUILD",
        `The ${action.greatWork} at ${province.name} is already complete.`,
      );
    }
    // §9.2 invest one further Build action (no additional cost).
    existing.progress += 1;
    const done = existing.progress >= def.rounds;
    let out = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "build",
      actors: [action.player],
      targets: [province.id],
      message: `${player.name} advances the ${action.greatWork} at ${province.name} (${existing.progress}/${def.rounds}).`,
      data: { greatWork: action.greatWork, progress: existing.progress, rounds: def.rounds },
    });
    if (done) out = completeGreatWork(out, action.player, province.id, action.greatWork);
    return out;
  }

  throw new EngineError("BAD_BUILD", "BUILD requires a building or greatWork.");
}

/** Award prestige and apply completion effects for a finished great work (§9.2/§13). */
function completeGreatWork(
  state: GameState,
  playerId: string,
  provinceId: string,
  type: GreatWorkType,
): GameState {
  const def = GREAT_WORK_COSTS[type];
  const next = structuredClone(state) as GameState;
  const p = playerById(next, playerId)!;
  const province = next.provinces.find((x) => x.id === provinceId)!;

  p.prestige += def.prestige; // §13 one-time prestige on completion
  p.prestigeThisRound = (p.prestigeThisRound ?? 0) + def.prestige;

  // §9.2 Theodosian Walls completion sets the province to the top wall tier.
  // CANON #4 / FIX-PREP 5-tier keyspace: Theodosian = T5 (16 HP / +4), not the
  // collapsed HP-tier 3 (now 10 HP under the restored 5-tier table).
  if (type === GreatWorkType.THEODOSIAN_WALLS) {
    province.walls = { tier: 5, hp: WALL_TIERS[5].hp };
  }

  return appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "build",
    actors: [playerId],
    targets: [provinceId],
    message: `${p.name} completes the ${type} at ${province.name} (+${def.prestige} prestige).`,
    data: { greatWork: type, prestige: def.prestige },
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of projecting each player's income for the round. */
export interface IncomeResult {
  /** Net income bundle by player id (province yields + buildings + routes − tax). */
  perPlayer: Record<string, ResourceBundle>;
  /** Grain shortfall by player id (positive = grain owed after stores). */
  shortfall: Record<string, number>;
}
