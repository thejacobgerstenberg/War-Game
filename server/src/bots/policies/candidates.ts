/**
 * Shared plausible-candidate generation for bot policies.
 *
 * Mirrors the legality-probe idiom of the gauntlet harness
 * (`engine/__tests__/gauntletHarness.ts`): construct PLAUSIBLE actions from
 * public state, let the engine's own validation be the final arbiter (the
 * driver tries candidates in order and treats an `EngineError` as "try the
 * next one"). Everything generated here is a BUDGETED action type, so a
 * policy built purely on these candidates always terminates the driver's
 * spend-down loop (each accepted action decrements `actionsRemaining`).
 *
 * Reads only exported engine data (map adjacency, balance tables) — never
 * private internals — and only table-public state (fair-play contract in
 * `../types.ts`).
 */
import {
  BuildingType,
  TerrainType,
  TreatyType,
  UnitType,
  type GameAction,
  type GameState,
  type Player,
} from "@imperium/shared";
import { neighborsOf } from "../../engine/adjacency.js";
import { BUILDING_COSTS, STACKING, UNIT_STATS } from "../../engine/balance.js";

const RESOURCE_KEYS = ["gold", "grain", "timber", "marble", "faith"] as const;
type ResKey = (typeof RESOURCE_KEYS)[number];

function canAfford(
  player: Player,
  cost: Partial<Record<ResKey, number>>,
): boolean {
  return RESOURCE_KEYS.every((k) => player.treasury[k] >= (cost[k] ?? 0));
}

function stackSize(units: Partial<Record<UnitType, number>>): number {
  let n = 0;
  for (const t of Object.values(UnitType)) n += units[t] ?? 0;
  return n;
}

/** Real heads in a stack (units + named variants). */
function realCount(stack: {
  units: Partial<Record<UnitType, number>>;
  variants?: { count: number }[];
}): number {
  let n = stackSize(stack.units);
  for (const v of stack.variants ?? []) n += v.count;
  return n;
}

/**
 * Would moving `moving` onto `locationId` bust the §3.2 per-player stacking
 * limit (8 land / 12 city / 6 naval)? A pre-filter so ranked slates don't
 * fill up with STACK_LIMIT probe rejections.
 */
function bustsStackLimit(
  state: Readonly<GameState>,
  moving: { id: string; ownerId: string },
  movingCount: number,
  locationId: string,
  naval: boolean,
): boolean {
  let limit: number;
  if (naval) limit = STACKING.naval;
  else {
    const prov = state.provinces.find((p) => p.id === locationId);
    const city =
      prov !== undefined &&
      (prov.terrain === TerrainType.CITY || prov.isCapitalOf !== undefined);
    limit = city ? STACKING.city : STACKING.land;
  }
  let count = movingCount;
  const stacks: readonly { id: string; ownerId: string; locationId: string; units: Partial<Record<UnitType, number>>; variants?: { count: number }[] }[] =
    naval ? state.fleets : state.armies;
  for (const s of stacks) {
    if (s.ownerId !== moving.ownerId || s.id === moving.id) continue;
    if (s.locationId !== locationId) continue;
    count += realCount(s);
  }
  return count > limit;
}

/** One-step MOVE candidates for every non-empty stack the player owns. */
export function moveCandidates(
  state: Readonly<GameState>,
  player: Player,
): GameAction[] {
  const out: GameAction[] = [];
  const provinceIds = new Set(state.provinces.map((p) => p.id));
  const seaZoneIds = new Set(state.seaZones.map((z) => z.id));
  for (const army of state.armies) {
    if (army.ownerId !== player.id) continue;
    const heads = realCount(army);
    if (heads === 0) continue;
    for (const nb of neighborsOf(army.locationId)) {
      if (!provinceIds.has(nb)) continue; // land stacks stay on land
      if (bustsStackLimit(state, army, heads, nb, false)) continue;
      out.push({ type: "MOVE", player: player.id, stackId: army.id, toId: nb });
    }
  }
  for (const fleet of state.fleets) {
    if (fleet.ownerId !== player.id) continue;
    const heads = realCount(fleet);
    if (heads === 0) continue;
    for (const nb of neighborsOf(fleet.locationId)) {
      if (!seaZoneIds.has(nb)) continue; // fleets stay at sea
      if (bustsStackLimit(state, fleet, heads, nb, true)) continue;
      out.push({
        type: "MOVE",
        player: player.id,
        stackId: fleet.id,
        toId: nb,
        naval: true,
      });
    }
  }
  return out;
}

/**
 * Would recruiting one more land unit at `prov` bust the §3.2 stacking cap?
 * (Pre-filter for the same reason as {@link bustsStackLimit}.)
 */
export function recruitBustsStackLimit(
  state: Readonly<GameState>,
  playerId: string,
  prov: { id: string; terrain: TerrainType; isCapitalOf?: unknown },
): boolean {
  const city = prov.terrain === TerrainType.CITY || prov.isCapitalOf !== undefined;
  const limit = city ? STACKING.city : STACKING.land;
  let count = 1;
  for (const a of state.armies) {
    if (a.ownerId === playerId && a.locationId === prov.id) count += realCount(a);
  }
  return count > limit;
}

/** Affordable single-unit RECRUIT candidates in owned muster provinces. */
export function recruitCandidates(
  state: Readonly<GameState>,
  player: Player,
): GameAction[] {
  const out: GameAction[] = [];
  const landTypes = [
    UnitType.LEVY,
    UnitType.INFANTRY,
    UnitType.ARCHER,
    UnitType.CAVALRY,
  ];
  for (const prov of state.provinces) {
    if (prov.ownerId !== player.id) continue;
    const canMusterLand =
      prov.isCapitalOf !== undefined ||
      prov.terrain === TerrainType.CITY ||
      prov.buildings.includes(BuildingType.BARRACKS);
    // The §3.2 pre-filter applies to LAND musters only (a GALLEY joins a
    // fleet, whose 6-cap the engine still arbitrates via the probe).
    if (canMusterLand && !recruitBustsStackLimit(state, player.id, prov)) {
      for (const t of landTypes) {
        if (!canAfford(player, UNIT_STATS[t].cost)) continue;
        out.push({
          type: "RECRUIT",
          player: player.id,
          provinceId: prov.id,
          units: { [t]: 1 },
        });
      }
    }
    if (
      prov.buildings.includes(BuildingType.SHIPYARD) &&
      canAfford(player, UNIT_STATS[UnitType.GALLEY].cost)
    ) {
      out.push({
        type: "RECRUIT",
        player: player.id,
        provinceId: prov.id,
        units: { [UnitType.GALLEY]: 1 },
      });
    }
  }
  return out;
}

/** Affordable BUILD candidates for buildings absent from owned provinces. */
export function buildCandidates(
  state: Readonly<GameState>,
  player: Player,
): GameAction[] {
  const out: GameAction[] = [];
  for (const prov of state.provinces) {
    if (prov.ownerId !== player.id) continue;
    for (const b of Object.values(BuildingType)) {
      if (prov.buildings.includes(b)) continue;
      if (!canAfford(player, BUILDING_COSTS[b] as Partial<Record<ResKey, number>>))
        continue;
      out.push({
        type: "BUILD",
        player: player.id,
        provinceId: prov.id,
        building: b,
      });
    }
  }
  return out;
}

/** Ratio-safe 2-for-1 CONVERT trades out of any plentiful resource. */
export function convertCandidates(
  _state: Readonly<GameState>,
  player: Player,
): GameAction[] {
  const out: GameAction[] = [];
  const rich = RESOURCE_KEYS.filter(
    (k) => k !== "faith" && player.treasury[k] >= 2,
  );
  for (const give of rich) {
    for (const get of RESOURCE_KEYS) {
      if (get === give || get === "faith") continue;
      out.push({
        type: "TRADE",
        player: player.id,
        trade: { kind: "CONVERT", give: { [give]: 2 }, get: { [get]: 1 } },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Treaty-proposal side-channel (engine/diplomacy.ts posts PROPOSE as an
// activeModifiers entry with kind:'treaty_proposal'). This is the ONE place
// in bots/ that knows that modifier's shape — policies consume the typed
// view below instead of reading raw modifier data.
// ---------------------------------------------------------------------------

/** A treaty proposal currently pending on the engine's modifier side-channel. */
export interface PendingTreatyProposal {
  /** The modifier id — pass as `treatyId` in a DIPLOMACY ACCEPT payload. */
  id: string;
  proposerId: string;
  accepterId: string;
  treatyType: TreatyType;
}

const TREATY_TYPE_VALUES = new Set<string>(Object.values(TreatyType));

/** All well-formed pending treaty proposals in the state, in modifier order. */
export function pendingTreatyProposals(
  state: Readonly<GameState>,
): PendingTreatyProposal[] {
  const out: PendingTreatyProposal[] = [];
  for (const m of state.activeModifiers) {
    if (m.kind !== "treaty_proposal") continue;
    const proposerId = m.data?.proposerId;
    const accepterId = m.data?.accepterId;
    const treatyType = m.data?.treatyType;
    if (typeof proposerId !== "string" || typeof accepterId !== "string") {
      continue;
    }
    if (typeof treatyType !== "string" || !TREATY_TYPE_VALUES.has(treatyType)) {
      continue;
    }
    out.push({
      id: m.id,
      proposerId,
      accepterId,
      treatyType: treatyType as TreatyType,
    });
  }
  return out;
}

/**
 * True when a proposal is already pending between the two players in either
 * direction (optionally restricted to one treaty type).
 */
export function proposalPendingBetween(
  state: Readonly<GameState>,
  a: string,
  b: string,
  treatyType?: TreatyType,
): boolean {
  return pendingTreatyProposals(state).some(
    (p) =>
      (treatyType === undefined || p.treatyType === treatyType) &&
      ((p.proposerId === a && p.accepterId === b) ||
        (p.proposerId === b && p.accepterId === a)),
  );
}

/** The free DIPLOMACY ACCEPT action answering a pending proposal. */
export function acceptActionFor(p: PendingTreatyProposal): GameAction {
  return {
    type: "DIPLOMACY",
    player: p.accepterId,
    diplomacy: {
      kind: "ACCEPT",
      treatyType: p.treatyType,
      targetPlayerId: p.proposerId,
      treatyId: p.id,
    },
  };
}

/**
 * The union of all budgeted candidate kinds this module knows how to build.
 * Placeholder policies shuffle this; real policies will rank slices of it.
 */
export function budgetedCandidates(
  state: Readonly<GameState>,
  player: Player,
): GameAction[] {
  return [
    ...moveCandidates(state, player),
    ...recruitCandidates(state, player),
    ...buildCandidates(state, player),
    ...convertCandidates(state, player),
  ];
}
