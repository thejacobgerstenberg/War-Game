/**
 * actions.ts — the pure validating reducer.
 *
 * `applyAction(state, action)` is the single entry point for every player
 * command. It validates legality (issuer exists, phase legality, action budget,
 * and — for the subsystems — adjacency / resource sufficiency), then dispatches
 * to the owning subsystem function and returns a NEW GameState.
 *
 * ERROR CONVENTION (frozen): illegal actions throw an {@link EngineError} with a
 * machine-readable `code` and human `message`. The transport layer wraps
 * `applyAction` in try/catch and emits `action_rejected { reason, code }` to the
 * issuing socket; a thrown error never mutates state. Successful actions return
 * the next state. (This is why the signature is `=> GameState`, not a result
 * union.)
 *
 * This file owns RECRUIT (§6.2), MOVE/ATTACK (§6.4/§7/§10.2) and PASS in
 * addition to the reducer dispatch table, budget accounting and error
 * convention; the remaining action bodies live in their subsystem files.
 */
import {
  BuildingType,
  Faction,
  GamePhase,
  TaxPosture,
  TerrainType,
  TreatyType,
  UnitType,
  type Army,
  type Fleet,
  type GameAction,
  type GameState,
  type MoveAction,
  type PendingBattle,
  type Player,
  type Province,
  type ResourceBundle,
} from "@imperium/shared";
import {
  MERC_MARKET,
  STACKING,
  TERRAIN_MOVE_COST,
  UNIQUE_UNIT_OVERRIDES,
  UNIT_STATS,
} from "./balance.js";
import { areAdjacent } from "./adjacency.js";
import { appendLog } from "./logEntry.js";
import { applyBuild, applyTrade } from "./economy.js";
import { applyDiplomacy, applyVassalize } from "./diplomacy.js";
import { applySpy } from "./spy.js";
import { applyMercBid } from "./mercenaries.js";
import { resolveCard } from "./events/index.js";
import { advancePhase } from "./roundLoop.js";

/** A typed, rejectable engine error (see the module-level error convention). */
export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

/** Phases during which players may spend budgeted actions (§10.0). */
const ACTION_PHASES: ReadonlySet<GamePhase> = new Set([
  GamePhase.RECRUITMENT,
  GamePhase.MOVEMENT,
  GamePhase.DIPLOMACY,
]);

const RESOURCE_KEYS = ["gold", "grain", "timber", "stone", "faith"] as const;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Look up a player by id or throw. */
function requirePlayer(state: GameState, playerId: string): Player {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    throw new EngineError("UNKNOWN_PLAYER", `No such player: ${playerId}`);
  }
  return player;
}

/** Assert the game is in an action phase and the player has budget; deduct one. */
function spendAction(state: GameState, playerId: string): GameState {
  if (!ACTION_PHASES.has(state.phase)) {
    throw new EngineError(
      "WRONG_PHASE",
      `Cannot act during the ${state.phase} phase.`,
    );
  }
  const player = requirePlayer(state, playerId);
  if (player.actionsRemaining <= 0) {
    throw new EngineError("NO_ACTIONS", `${player.name} has no actions left.`);
  }
  return {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, actionsRemaining: p.actionsRemaining - 1 } : p,
    ),
  };
}

function zeroUnits(): Record<UnitType, number> {
  const u = {} as Record<UnitType, number>;
  for (const t of Object.values(UnitType)) u[t] = 0;
  return u;
}

function emptyBundle(): ResourceBundle {
  return { gold: 0, grain: 0, timber: 0, stone: 0, faith: 0 };
}

/** Live units (generic + variant) in a stack. */
function realCount(stack: Army | Fleet): number {
  let n = 0;
  for (const t of Object.values(UnitType)) n += stack.units[t] ?? 0;
  for (const v of stack.variants ?? []) n += v.count;
  return n;
}

/** ALLIANCE treaty check (a non-ally destination triggers battle, §6.4). */
function areAllied(state: GameState, a: string, b: string | null): boolean {
  if (!b) return false;
  if (a === b) return true;
  const pa = state.players.find((p) => p.id === a);
  if (!pa) return false;
  return pa.treaties.some(
    (t) =>
      t.type === TreatyType.ALLIANCE &&
      t.parties.includes(a) &&
      t.parties.includes(b),
  );
}

/** A CITY or a capital province takes the larger (12) stacking limit (§6.4). */
function isCityProvince(prov: Province): boolean {
  return prov.terrain === TerrainType.CITY || prov.isCapitalOf !== undefined;
}

/**
 * A stack's movement allowance for a single MOVE step (§3.1/§6.4): the pace of
 * its SLOWEST live unit (cavalry mv2, most land units mv1, naval mv2), applying
 * any unique-unit `mvMod`. Entering a province costs TERRAIN_MOVE_COST[terrain].
 */
function stackMovePoints(stack: Army | Fleet): number {
  let min = Number.POSITIVE_INFINITY;
  for (const t of Object.values(UnitType)) {
    if ((stack.units[t] ?? 0) > 0) min = Math.min(min, UNIT_STATS[t].mv);
  }
  for (const v of stack.variants ?? []) {
    if (v.count > 0) {
      const def = UNIQUE_UNIT_OVERRIDES[v.variant];
      min = Math.min(min, UNIT_STATS[v.base].mv + (def?.mvMod ?? 0));
    }
  }
  return Number.isFinite(min) ? min : 0;
}

/** Total units a player already has stacked at a location (land or naval). */
function ownUnitsAt(
  state: GameState,
  playerId: string,
  locationId: string,
  naval: boolean,
): number {
  const list: (Army | Fleet)[] = naval ? state.fleets : state.armies;
  return list
    .filter((s) => s.ownerId === playerId && s.locationId === locationId)
    .reduce((acc, s) => acc + realCount(s), 0);
}

// ---------------------------------------------------------------------------
// RECRUIT (§6.2)
// ---------------------------------------------------------------------------

/**
 * Raise units (and/or unique variants) in one owned province (§6.2). Validates
 * the recruitment location (capital / CITY / Barracks for land, Shipyard for
 * naval; mercenaries may raise anywhere), pays the UNIT_STATS cost from the
 * treasury (mercenaries: ×1.5 gold — Genoa ×1.0 — and 0 grain), and enforces the
 * per-player stacking limit (§6.4). Assumes the reducer has spent the action.
 */
function applyRecruit(state: GameState, action: GameAction): GameState {
  if (action.type !== "RECRUIT") {
    throw new EngineError("UNKNOWN_ACTION", "applyRecruit requires RECRUIT.");
  }
  const player = requirePlayer(state, action.player);
  const prov = state.provinces.find((p) => p.id === action.provinceId);
  if (!prov) throw new EngineError("BAD_RECRUIT", "No such province.");
  if (prov.ownerId !== player.id) {
    throw new EngineError("NOT_OWNER", "Can only recruit in owned provinces.");
  }

  const variants = action.variants ?? [];
  const mercenary = action.mercenary === true;

  // Tally requested land/naval counts and validate variant legality (§6.2/§FACTIONS).
  let landCount = 0;
  let navalCount = 0;
  for (const [type, n] of Object.entries(action.units) as [UnitType, number][]) {
    if (!n || n <= 0) continue;
    if (UNIT_STATS[type].naval) navalCount += n;
    else landCount += n;
  }
  for (const v of variants) {
    if (v.count <= 0) continue;
    const def = UNIQUE_UNIT_OVERRIDES[v.variant];
    if (!def) throw new EngineError("BAD_RECRUIT", `Unknown variant ${v.variant}.`);
    if (player.faction !== def.faction) {
      throw new EngineError("BAD_RECRUIT", `${def.name} is not a ${player.faction} unit.`);
    }
    if (def.recruitProvinces && !def.recruitProvinces.includes(prov.id)) {
      throw new EngineError("BAD_RECRUIT", `${def.name} cannot be raised at ${prov.name}.`);
    }
    if (UNIT_STATS[def.base].naval) navalCount += v.count;
    else landCount += v.count;
  }
  if (landCount === 0 && navalCount === 0) {
    throw new EngineError("BAD_RECRUIT", "Recruit order is empty.");
  }

  // §6.2 recruitment-location legality.
  const isCapital = prov.isCapitalOf !== undefined;
  const canRaiseLand =
    mercenary || isCapital || prov.terrain === TerrainType.CITY ||
    prov.buildings.includes(BuildingType.BARRACKS);
  if (landCount > 0 && !canRaiseLand) {
    throw new EngineError(
      "BAD_RECRUIT",
      `${prov.name} cannot raise land units (needs capital/CITY/Barracks).`,
    );
  }
  if (navalCount > 0 && !prov.buildings.includes(BuildingType.SHIPYARD)) {
    throw new EngineError("BAD_RECRUIT", `${prov.name} needs a Shipyard for naval units.`);
  }

  // §6.2 cost — mercenaries pay ×1.5 gold (Genoa ×1.0) and 0 grain; land only.
  const mercGoldMult =
    player.faction === Faction.GENOA
      ? MERC_MARKET.genoaGoldMultiplier
      : MERC_MARKET.hireGoldMultiplier;
  const cost = emptyBundle();
  const addUnitCost = (base: UnitType, n: number): void => {
    const stat = UNIT_STATS[base];
    const merc = mercenary && !stat.naval;
    for (const k of RESOURCE_KEYS) {
      const per = stat.cost[k] ?? 0;
      if (per === 0) continue;
      if (merc && k === "gold") cost.gold += Math.ceil(per * n * mercGoldMult);
      else if (merc && k === "grain") continue; // §6.2 mercenaries eat 0 grain to raise
      else cost[k] += per * n;
    }
  };
  for (const [type, n] of Object.entries(action.units) as [UnitType, number][]) {
    if (n && n > 0) addUnitCost(type, n);
  }
  for (const v of variants) if (v.count > 0) addUnitCost(v.base, v.count);

  for (const k of RESOURCE_KEYS) {
    if (player.treasury[k] < cost[k]) {
      throw new EngineError(
        "INSUFFICIENT_RESOURCES",
        `${player.name} cannot afford this recruitment (${k}).`,
      );
    }
  }

  // §6.4 stacking limits (per player, per location).
  if (landCount > 0) {
    const limit = isCityProvince(prov) ? STACKING.city : STACKING.land;
    if (ownUnitsAt(state, player.id, prov.id, false) + landCount > limit) {
      throw new EngineError("STACK_LIMIT", `Stacking limit (${limit} land) exceeded at ${prov.name}.`);
    }
  }
  if (navalCount > 0) {
    if (ownUnitsAt(state, player.id, prov.id, true) + navalCount > STACKING.naval) {
      throw new EngineError("STACK_LIMIT", `Stacking limit (${STACKING.naval} naval) exceeded at ${prov.name}.`);
    }
  }

  // Apply: pay, then merge into the player's stack(s) at the province.
  const next = structuredClone(state) as GameState;
  const p = next.players.find((x) => x.id === action.player)!;
  for (const k of RESOURCE_KEYS) p.treasury[k] -= cost[k];

  const findOrMake = (naval: boolean): Army | Fleet => {
    const list: (Army | Fleet)[] = naval ? next.fleets : next.armies;
    const existing = list.find(
      (s) => s.ownerId === player.id && s.locationId === prov.id,
    );
    if (existing) return existing;
    const created: Army | Fleet = {
      id: `${naval ? "fleet" : "army"}-${player.id}-${prov.id}-${next.logCounter}`,
      ownerId: player.id,
      locationId: prov.id,
      units: zeroUnits(),
      variants: [],
    };
    list.push(created);
    return created;
  };

  const markMerc = (stack: Army | Fleet, type: UnitType, n: number): void => {
    const s = stack as Army & { mercenaries?: Partial<Record<UnitType, number>> };
    if (!s.mercenaries) s.mercenaries = {};
    s.mercenaries[type] = (s.mercenaries[type] ?? 0) + n;
  };

  for (const [type, n] of Object.entries(action.units) as [UnitType, number][]) {
    if (!n || n <= 0) continue;
    const naval = UNIT_STATS[type].naval;
    const stack = findOrMake(naval);
    stack.units[type] = (stack.units[type] ?? 0) + n;
    if (mercenary && !naval) markMerc(stack, type, n);
  }
  for (const v of variants) {
    if (v.count <= 0) continue;
    const naval = UNIT_STATS[v.base].naval;
    const stack = findOrMake(naval);
    if (!stack.variants) stack.variants = [];
    const found = stack.variants.find((x) => x.variant === v.variant);
    if (found) found.count += v.count;
    else stack.variants.push({ base: v.base, variant: v.variant, count: v.count });
  }

  return appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "recruit",
    actors: [action.player],
    targets: [prov.id],
    message: `${player.name} recruits ${landCount + navalCount} unit(s) at ${prov.name}${
      mercenary ? " (mercenaries)" : ""
    }.`,
    data: { units: action.units, variants, mercenary, cost },
  });
}

// ---------------------------------------------------------------------------
// MOVE / ATTACK (§6.4, §7, §10.2)
// ---------------------------------------------------------------------------

/**
 * Move one army or fleet one step along the adjacency graph (§6.4). Validates
 * adjacency (straits included), the slowest-unit movement allowance against
 * TERRAIN_MOVE_COST (§3.1), and the destination stacking limit. Entering a tile
 * defended by a non-ally (units or garrison) queues a {@link PendingBattle} for
 * the COMBAT phase instead of resolving inline; otherwise the stack relocates
 * and may flip ownership of an empty enemy/neutral province (§6.4 occupation).
 * Assumes the reducer has spent the action.
 */
function applyMove(state: GameState, action: GameAction): GameState {
  if (action.type !== "MOVE") {
    throw new EngineError("UNKNOWN_ACTION", "applyMove requires MOVE.");
  }
  const player = requirePlayer(state, action.player);
  const isNaval = action.naval === true;
  const stacks: (Army | Fleet)[] = isNaval ? state.fleets : state.armies;
  const stack = stacks.find((s) => s.id === action.stackId);
  if (!stack) throw new EngineError("UNKNOWN_STACK", `No such stack: ${action.stackId}.`);
  if (stack.ownerId !== player.id) {
    throw new EngineError("NOT_OWNER", "Cannot move another player's stack.");
  }

  // §6.4 adjacency (ADJACENCY includes strait edges).
  if (!areAdjacent(stack.locationId, action.toId)) {
    throw new EngineError(
      "NOT_ADJACENT",
      `${action.toId} is not adjacent to ${stack.locationId}.`,
    );
  }

  const destProv = state.provinces.find((p) => p.id === action.toId);
  const destZone = state.seaZones.find((z) => z.id === action.toId);
  if (!destProv && !destZone) {
    throw new EngineError("BAD_MOVE", `Unknown destination: ${action.toId}.`);
  }

  // §3.1 movement allowance: slowest unit must afford the terrain move cost.
  const mp = stackMovePoints(stack);
  if (mp <= 0) throw new EngineError("BAD_MOVE", "An empty stack cannot move.");
  const moveCost = destProv ? TERRAIN_MOVE_COST[destProv.terrain] : 1;
  if (moveCost > mp) {
    throw new EngineError(
      "INSUFFICIENT_MOVEMENT",
      `${action.toId} costs ${moveCost} to enter; the stack moves ${mp}.`,
    );
  }

  // §6.4 stacking limit at the destination (own units only).
  const moving = realCount(stack);
  const stackLimit = isNaval
    ? STACKING.naval
    : destProv && isCityProvince(destProv)
      ? STACKING.city
      : STACKING.land;
  if (ownUnitsAt(state, player.id, action.toId, isNaval) + moving > stackLimit) {
    throw new EngineError(
      "STACK_LIMIT",
      `Stacking limit (${stackLimit}) exceeded at ${action.toId}.`,
    );
  }

  // --- Detect defenders ----------------------------------------------------
  if (isNaval) {
    const enemyFleets = state.fleets.filter(
      (f) =>
        f.locationId === action.toId &&
        f.ownerId !== player.id &&
        !areAllied(state, player.id, f.ownerId) &&
        realCount(f) > 0,
    );
    if (enemyFleets.length > 0) {
      return queueBattle(state, action, player, {
        seaZoneId: action.toId,
        defenderId: enemyFleets[0].ownerId,
        defenderStackIds: enemyFleets.map((f) => f.id),
        isNaval: true,
        amphibious: false,
        isSiege: false,
      });
    }
    return relocate(state, action, player, false);
  }

  const prov = destProv!;
  const enemyArmies = state.armies.filter(
    (a) =>
      a.locationId === action.toId &&
      a.ownerId !== player.id &&
      !areAllied(state, player.id, a.ownerId) &&
      realCount(a) > 0,
  );
  const ownerHostile =
    prov.ownerId !== null &&
    prov.ownerId !== player.id &&
    !areAllied(state, player.id, prov.ownerId);
  const garrisonDefends =
    (prov.garrison ?? 0) > 0 && (prov.ownerId === null || ownerHostile);

  if (enemyArmies.length > 0 || garrisonDefends) {
    // §7/§8 a defended tile queues a battle; a walled CITY assault is a siege.
    return queueBattle(state, action, player, {
      provinceId: prov.id,
      defenderId: enemyArmies[0]?.ownerId ?? prov.ownerId ?? null,
      defenderStackIds: enemyArmies.map((a) => a.id),
      isNaval: false,
      amphibious: action.transportFleetId !== undefined,
      isSiege: prov.walls.hp > 0 && prov.terrain === TerrainType.CITY,
    });
  }

  // §6.4 empty tile → relocate; flip an empty enemy/neutral province.
  return relocate(state, action, player, ownerHostile || prov.ownerId === null);
}

/** Clone, relocate the moving stack, optionally flip an empty province (§6.4). */
function relocate(
  state: GameState,
  action: MoveAction,
  player: Player,
  flipOwnership: boolean,
): GameState {
  const isNaval = action.naval === true;
  const next = structuredClone(state) as GameState;
  const list: (Army | Fleet)[] = isNaval ? next.fleets : next.armies;
  const stack = list.find((s) => s.id === action.stackId)!;
  stack.locationId = action.toId;

  const prov = next.provinces.find((p) => p.id === action.toId);
  let occupied = false;
  if (!isNaval && prov && flipOwnership && prov.ownerId !== player.id) {
    prov.ownerId = player.id; // §6.4 occupation of an undefended enemy/neutral tile
    prov.garrison = 0;
    occupied = true;
  }

  return appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: occupied ? "battle" : "phase",
    actors: [action.player],
    targets: [action.toId],
    message: occupied
      ? `${player.name} occupies ${prov?.name ?? action.toId} unopposed.`
      : `${player.name} moves ${action.stackId} to ${action.toId}.`,
    data: { move: action.stackId, to: action.toId, occupied },
  });
}

/** Clone, advance the attacker into the tile, and push a PendingBattle (§7). */
function queueBattle(
  state: GameState,
  action: MoveAction,
  player: Player,
  spec: {
    provinceId?: string;
    seaZoneId?: string;
    defenderId: string | null;
    defenderStackIds: string[];
    isNaval: boolean;
    amphibious: boolean;
    isSiege: boolean;
  },
): GameState {
  const isNaval = action.naval === true;
  const next = structuredClone(state) as GameState;
  const list: (Army | Fleet)[] = isNaval ? next.fleets : next.armies;
  const stack = list.find((s) => s.id === action.stackId)!;
  // The attacker advances to the contested tile; COMBAT resolves the clash.
  stack.locationId = action.toId;

  const battle: PendingBattle = {
    id: `pb-${next.round}-${next.pendingBattles.length}-${action.stackId}`,
    ...(spec.provinceId ? { provinceId: spec.provinceId } : {}),
    ...(spec.seaZoneId ? { seaZoneId: spec.seaZoneId } : {}),
    attackerId: player.id,
    defenderId: spec.defenderId,
    attackerStackIds: [action.stackId],
    defenderStackIds: spec.defenderStackIds,
    isNaval: spec.isNaval,
    amphibious: spec.amphibious,
    isSiege: spec.isSiege,
  };
  next.pendingBattles = [...next.pendingBattles, battle];

  return appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "battle",
    actors: [player.id, ...(spec.defenderId ? [spec.defenderId] : [])],
    targets: [action.toId],
    message: `${player.name} advances on ${action.toId} — a ${
      spec.isSiege ? "siege" : spec.isNaval ? "naval battle" : "battle"
    } is declared.`,
    data: { battleId: battle.id, declared: true, isSiege: spec.isSiege, isNaval: spec.isNaval },
  });
}

// ---------------------------------------------------------------------------
// applyAction — the dispatch table
// ---------------------------------------------------------------------------

/**
 * Validate and apply a single {@link GameAction}, returning a new GameState.
 * Throws {@link EngineError} on any illegality.
 */
export function applyAction(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "ADVANCE_PHASE":
      // Phase advancement is not budgeted; host/engine driven.
      return advancePhase(state);

    case "SET_TAX": {
      const player = requirePlayer(state, action.player);
      if (!Object.values(TaxPosture).includes(action.posture)) {
        throw new EngineError("BAD_TAX", `Invalid tax posture.`);
      }
      void player;
      return {
        ...state,
        players: state.players.map((p) =>
          p.id === action.player ? { ...p, tax: action.posture } : p,
        ),
      };
    }

    case "PASS": {
      const player = requirePlayer(state, action.player);
      // §10 forfeit remaining actions this turn (yield the budget).
      const next = {
        ...state,
        players: state.players.map((p) =>
          p.id === action.player ? { ...p, actionsRemaining: 0 } : p,
        ),
      };
      return appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "phase",
        actors: [action.player],
        message: `${player.name} passes and yields the remaining actions.`,
        data: {},
      });
    }

    case "MERC_BID":
      // Bidding happens during the merc market window, not a budgeted action.
      requirePlayer(state, action.player);
      return applyMercBid(state, action);

    case "RECRUIT":
      return applyRecruit(spendAction(state, action.player), action);

    case "MOVE":
      return applyMove(spendAction(state, action.player), action);

    case "BUILD": {
      const next = spendAction(state, action.player);
      if (!action.building && !action.greatWork) {
        throw new EngineError(
          "BAD_BUILD",
          "BUILD requires a building or greatWork.",
        );
      }
      return applyBuild(next, action);
    }

    case "TRADE": {
      const next = spendAction(state, action.player);
      return applyTrade(next, action);
    }

    case "DIPLOMACY": {
      // Propose/accept cost the initiator an action; responder is free (§10.0).
      const next =
        action.diplomacy.kind === "ACCEPT"
          ? state
          : spendAction(state, action.player);
      return applyDiplomacy(next, action);
    }

    case "VASSALIZE": {
      const next = spendAction(state, action.player);
      return applyVassalize(next, action);
    }

    case "SPY": {
      const next = spendAction(state, action.player);
      return applySpy(next, action);
    }

    case "PLAY_CARD": {
      requirePlayer(state, action.player);
      // TODO(events/reducer): verify the card is in hand; playing may be free.
      return resolveCard(state, action.cardId);
    }

    default: {
      // Exhaustiveness guard.
      const _never: never = action;
      void _never;
      throw new EngineError("UNKNOWN_ACTION", "Unrecognised action type.");
    }
  }
}
