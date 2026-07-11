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
  GREAT_WORK_COSTS,
  MARKET_RATIOS,
  MERC_UPKEEP_MULTIPLIER,
  TAX_MULTIPLIERS,
  TAX_REVOLT,
  TRADE,
  UNIT_STATS,
  WALL_BUILD_COST,
  WALL_TIERS,
} from "./balance.js";
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
 * Port tier 0..3 used by the trade-route formula (§5.2). No dedicated port-tier
 * field exists on Province, so it is derived from `highValue` (the prestige-node
 * weight), clamped to [0, TRADE.maxPortTier]. See NEEDS-FROM-INTEGRATOR.
 */
function portTier(prov: Province): number {
  return Math.max(0, Math.min(TRADE.maxPortTier, prov.highValue ?? 0));
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

/** True when the route owner has a friendly war fleet (WARSHIP) escorting a hop. */
function routeEscorted(state: GameState, route: TradeRoute): boolean {
  return state.fleets.some(
    (f) =>
      route.seaZonePath.includes(f.locationId) &&
      (f.ownerId === route.ownerId ||
        areAllied(state, route.ownerId, f.ownerId)) &&
      (f.units[UnitType.WARSHIP] ?? 0) > 0,
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
      const escortHere = state.fleets.some(
        (f) =>
          f.locationId === zoneId &&
          (f.ownerId === route.ownerId ||
            areAllied(state, route.ownerId, f.ownerId)) &&
          ((f.units[UnitType.WARSHIP] ?? 0) > 0 ||
            (f.units[UnitType.GALLEY] ?? 0) > 0),
      );
      if (!escortHere) anySevered = true;
    } else {
      // §5.2 +1 per sea zone you or an ally control.
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

/** Grain a player owes this Income phase: Σ unit upkeep (mercenaries ×2, §4.4). */
function grainDue(state: GameState, playerId: string): number {
  let due = 0;
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
      const per = UNIT_STATS[u].grainUpkeep;
      due += regular * per + mercs * per * MERC_UPKEEP_MULTIPLIER; // §4.4 merc double
    }
    for (const v of stack.variants ?? []) {
      due += v.count * UNIT_STATS[v.base].grainUpkeep;
    }
  }
  return due;
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
      // §9.2 Hagia Sophia: +2 faith/round once completed.
      if (hasCompletedGreatWork(prov, GreatWorkType.HAGIA_SOPHIA)) {
        income.faith += 2;
      }
    }

    // §5.2 trade-route gold (before piracy).
    for (const route of tradeRoutesFor(state, player.id)) {
      income.gold += routeIncome(state, route);
    }

    // Card-posted faith income side-channel (kind='faith_income').
    if (player.faction) {
      income.faith += sumModifierValues(state, "faith_income", {
        faction: player.faction,
      });
    }

    // §4.2 taxation multiplier applies to gold only (floor fractional gold).
    income.gold = Math.floor(income.gold * TAX_MULTIPLIERS[player.tax]);

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

    const record = (u: UnitType, n: number) => {
      deserted[u] = (deserted[u] ?? 0) + n;
    };

    // Phase A: mercenaries desert FIRST and at DOUBLE rate (§4.4) — for each
    // mercenary that covers its upkeep, a second of the same type also flees.
    for (const u of DESERTION_ORDER) {
      const per = UNIT_STATS[u].grainUpkeep;
      for (const stack of stacks) {
        const m = stack.mercenaries;
        while (deficit > 0 && mercCount(stack, u) > 0) {
          stack.units[u] -= 1;
          if (m) m[u] = (m[u] ?? 0) - 1;
          record(u, 1);
          deficit -= per;
          // Double-rate penalty: a second mercenary of this type also deserts.
          if (mercCount(stack, u) > 0) {
            stack.units[u] -= 1;
            if (m) m[u] = (m[u] ?? 0) - 1;
            record(u, 1);
          }
        }
        if (deficit <= 0) break;
      }
      if (deficit <= 0) break;
    }

    // Phase B: regular units desert lowest-value first (§4.4).
    if (deficit > 0) {
      for (const u of DESERTION_ORDER) {
        const per = UNIT_STATS[u].grainUpkeep;
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

    const totalDeserted = Object.values(deserted).reduce(
      (acc, n) => acc + (n ?? 0),
      0,
    );
    if (totalDeserted > 0) {
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "phase",
        actors: [player.id],
        message: `${player.name} cannot feed the host: ${totalDeserted} unit(s) desert to starvation.`,
        data: { deserted },
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
    ratio = Math.min(ratio, MARKET_RATIOS.bazaar); // 1:1 best ratio
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
    const ratio = bestMarketRatio(state, player);
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
  for (const zoneId of trade.seaZonePath) {
    if (!state.seaZones.some((z) => z.id === zoneId)) {
      throw new EngineError("BAD_TRADE", `Unknown sea zone: ${zoneId}.`);
    }
  }
  // §5.1 a route needs a merchantman (GALLEY) assigned.
  const merchant = state.fleets.find(
    (f) => f.ownerId === player.id && (f.units[UnitType.GALLEY] ?? 0) > 0,
  );
  if (!merchant) {
    throw new EngineError(
      "INSUFFICIENT_RESOURCES",
      "A GALLEY merchantman is required to run a trade route.",
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
      // §8.1/§9 walls upgrade the fortification tier (0→1→2→3).
      const nextTier = province.walls.tier + 1;
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
  if (type === GreatWorkType.THEODOSIAN_WALLS) {
    province.walls = { tier: 3, hp: WALL_TIERS[3].hp };
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
