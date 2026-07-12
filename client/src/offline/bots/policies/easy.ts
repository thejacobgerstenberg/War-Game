/**
 * VENDORED from server/src/bots/policies/easy.ts @ 9009d5262afd983392c565e1d5e51bbdf31da92b
 * (PR #27 "Server: AI opponents", branch feature/ai-opponents — not on main yet).
 * Local changes: (1) engine imports rewritten to the offline engine shim;
 * (2) `.coastal` -> `.port` (main #28 renamed Province.coastal to Province.port);
 * (3) nothing else. Do not add logic here; upstream replaces this after #27 merges.
 */
/**
 * EASY policy — greedy short-horizon with deliberate imperfection.
 *
 * The sim's "rusher" archetype, softened (see sim/src/agents.ts prior art on
 * feature/balance-sim): pick the locally best-looking action each slot —
 * immediate income, adjacent weak targets, the cheapest useful build — with
 * no lookahead and no solvency planning. Characteristics:
 *
 *  - GREEDY RANKING: every budgeted candidate from the shared pool is scored
 *    by a one-step value function (province yields for expansion moves, combat
 *    value per gold for recruits, usefulness per cost for builds, bail-out
 *    conversions when broke) and offered best-first.
 *  - DELIBERATE MISTAKES: with probability {@link MISTAKE_RATE} (seeded) the
 *    2nd- or 3rd-ranked candidate is promoted over the best one. Threat
 *    assessment is crude on purpose (raw stat sums; unique-unit stat deltas
 *    and combat modifiers are ignored — no real odds gate).
 *  - SIEGES: attacking a walled city is allowed (the engine queues the siege),
 *    but the policy never PLANS a siege beyond starting it — no siege-train
 *    building, no reinforcement of ongoing sieges, no assault timing.
 *  - IGNORED ENTIRELY: trade-route monopolies, great works and the prestige
 *    race (candidates.ts generates neither; UNIVERSITY is scored near zero).
 *  - DIPLOMACY: ACCEPTS every NAP proposed to it (a free action, offered ahead
 *    of the budgeted pick); RARELY initiates a NAP of its own (small seeded
 *    chance, shrinking with the persona's war appetite). It does not betray:
 *    moves into a treaty partner's province are filtered out.
 *  - PERSONA BIASES (hints, light touch — see personality.ts): `warAppetite`
 *    scales how much enemy defences deter an attack and the NAP-initiation
 *    rate; `defensiveness` weights defender stats in recruit scoring and
 *    defensive builds; `tradeFocus` nudges shipyards and idle fleet moves.
 *
 * Determinism: every random draw (NAP-initiation chance, tie-break shuffle,
 * imperfection) comes from `ctx.rng` in a fixed order. Fair play: reads only
 * table-public state (map, stacks, treasuries, treaties, and treaty proposals
 * addressed to this bot on the modifier side-channel).
 */
import {
  BuildingType,
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
import { BUILDING_COSTS, UNIT_STATS, WALL_TIERS } from "../../engine/index.js";
import type { BotRng } from "../rng.js";
import type { PersonaBiases } from "../personality.js";
import type { Policy, PolicyContext } from "../types.js";
import {
  acceptActionFor,
  budgetedCandidates,
  pendingTreatyProposals,
  proposalPendingBetween,
} from "./candidates.js";

/** How many ranked candidates to offer the driver per action slot. */
const CANDIDATE_SLICE = 10;

/** Probability of promoting the 2nd/3rd-ranked candidate over the best one. */
const MISTAKE_RATE = 0.25;

/** Per-slot chance of initiating a NAP is NAP_BASE + NAP_PEACE * (1 - warAppetite). */
const NAP_BASE = 0.02;
const NAP_PEACE = 0.04;

/** Gold below which bail-out conversions to gold look attractive. */
const LOW_GOLD = 4;
/** Grain below which conversions to grain look attractive. */
const LOW_GRAIN = 2;
/** Keep at least this much of a resource before trading it away. */
const CONVERT_RESERVE = 4;

/** Neutral biases used when the bot has no persona (e.g. faction not seated). */
const DEFAULT_BIASES: PersonaBiases = {
  warAppetite: 0.4,
  tributePreference: 0.4,
  tradeFocus: 0.4,
  defensiveness: 0.5,
  crusadePreference: 0.2,
  constantinopleObsession: false,
};

const RESOURCE_KEYS = ["gold", "grain", "timber", "marble", "faith"] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Total cost of a partial bundle, counting every resource as one gold. */
function bundleTotal(cost: Partial<ResourceBundle>): number {
  let n = 0;
  for (const k of RESOURCE_KEYS) n += cost[k] ?? 0;
  return n;
}

/** Ids of players this bot holds an unexpired treaty with (any type). */
function treatyPartnerIds(me: Player, round: number): Set<string> {
  const partners = new Set<string>();
  for (const t of me.treaties) {
    if (t.expiresRound !== null && t.expiresRound < round) continue;
    for (const id of t.parties) if (id !== me.id) partners.add(id);
  }
  return partners;
}

/** Crude attack strength of a stack: raw base atk sums (no modifiers — EASY). */
function attackStrength(stack: Army | Fleet): number {
  let n = 0;
  for (const t of Object.values(UnitType)) {
    n += (stack.units[t] ?? 0) * UNIT_STATS[t].atk;
  }
  for (const v of stack.variants ?? []) n += v.count * UNIT_STATS[v.base].atk;
  return n;
}

/** Crude defence strength of a stack: raw base def sums (no modifiers). */
function defenceStrength(stack: Army | Fleet): number {
  let n = 0;
  for (const t of Object.values(UnitType)) {
    n += (stack.units[t] ?? 0) * UNIT_STATS[t].def;
  }
  for (const v of stack.variants ?? []) n += v.count * UNIT_STATS[v.base].def;
  return n;
}

/** One-step income value of taking a province (gold weighted double). */
function provinceValue(prov: Province): number {
  const y = prov.yields;
  return (
    2 * y.gold +
    y.grain +
    y.timber +
    y.marble +
    y.faith +
    2 * (prov.highValue ?? 0) +
    (prov.isCapitalOf !== undefined ? 3 : 0)
  );
}

// ---------------------------------------------------------------------------
// Scoring — one greedy number per candidate, no lookahead
// ---------------------------------------------------------------------------

function scoreMove(
  action: Extract<GameAction, { type: "MOVE" }>,
  state: Readonly<GameState>,
  me: Player,
  biases: PersonaBiases,
): number {
  if (action.naval === true) {
    // Fleets drift toward whatever the shuffle favours; traders like the sea.
    return 0.3 + 0.2 * biases.tradeFocus;
  }
  const dest = state.provinces.find((p) => p.id === action.toId);
  if (!dest) return 0.05;
  if (dest.ownerId === me.id) return 0.2; // repositioning, low value

  const mine = state.armies.find((a) => a.id === action.stackId);
  const attack = mine ? attackStrength(mine) : 0;

  let defence = (dest.garrison ?? 0) + (WALL_TIERS[dest.walls.tier]?.defBonus ?? 0);
  for (const a of state.armies) {
    if (a.locationId === dest.id && a.ownerId !== me.id) {
      defence += defenceStrength(a);
    }
  }

  // Greedy: grab income now; weak targets shine, strong defences deter — the
  // more warlike the persona, the less they deter. Walls only enter via this
  // crude bonus (a walled target merely starts a siege; nothing is planned).
  const threat = Math.max(0, defence - attack);
  const hostileOwner = dest.ownerId !== null && dest.ownerId !== me.id;
  const score =
    provinceValue(dest) -
    threat * (1.5 - biases.warAppetite) +
    (hostileOwner ? biases.warAppetite : 0);
  return Math.max(0.05, score);
}

function scoreRecruit(
  action: Extract<GameAction, { type: "RECRUIT" }>,
  biases: PersonaBiases,
): number {
  let score = 0.8;
  for (const t of Object.values(UnitType)) {
    const count = action.units[t] ?? 0;
    if (count <= 0) continue;
    const stats = UNIT_STATS[t];
    const value = stats.atk + stats.def * (0.4 + 0.6 * biases.defensiveness);
    score += (count * value) / Math.max(1, bundleTotal(stats.cost) - (stats.cost.grain ?? 0));
  }
  return score;
}

/** "Cheapest useful build": immediate income first, enablers second. */
function buildUsefulness(
  building: BuildingType,
  prov: Province,
  biases: PersonaBiases,
): number {
  switch (building) {
    case BuildingType.MARKET:
      return 3; // +1 gold/round: the greedy favourite
    case BuildingType.BARRACKS: {
      const canMuster =
        prov.isCapitalOf !== undefined || prov.terrain === TerrainType.CITY;
      return canMuster ? 0.3 : 2.5; // useful only where nothing musters yet
    }
    case BuildingType.TEMPLE:
      return 1.5;
    case BuildingType.GRANARY:
      return 0.8 + biases.defensiveness;
    case BuildingType.WALLS:
      return 0.5 + 1.5 * biases.defensiveness;
    case BuildingType.SHIPYARD:
      return 0.8 + biases.tradeFocus;
    case BuildingType.UNIVERSITY:
      return 0.5; // prestige race — EASY does not play it
    default:
      return 0.5;
  }
}

function scoreBuild(
  action: Extract<GameAction, { type: "BUILD" }>,
  state: Readonly<GameState>,
  biases: PersonaBiases,
): number {
  if (!action.building) return 0.05; // great works: ignored by EASY
  const prov = state.provinces.find((p) => p.id === action.provinceId);
  if (!prov) return 0.05;
  const cost = Math.max(1, bundleTotal(BUILDING_COSTS[action.building]));
  return 0.5 + (buildUsefulness(action.building, prov, biases) * 3) / cost;
}

/** Conversions are bail-outs: only attractive when short on gold or grain. */
function scoreConvert(
  action: Extract<GameAction, { type: "TRADE" }>,
  me: Player,
): number {
  const trade = action.trade;
  if (trade.kind !== "CONVERT") return 0.05;
  const giveKey = RESOURCE_KEYS.find((k) => (trade.give[k] ?? 0) > 0);
  const getKey = RESOURCE_KEYS.find((k) => (trade.get[k] ?? 0) > 0);
  if (!giveKey || !getKey) return 0.05;
  if (me.treasury[giveKey] < CONVERT_RESERVE) return 0.05;
  if (getKey === "gold" && me.treasury.gold < LOW_GOLD) return 2.2;
  if (getKey === "grain" && me.treasury.grain < LOW_GRAIN) return 1.8;
  return 0.05;
}

function scoreAction(
  action: GameAction,
  state: Readonly<GameState>,
  me: Player,
  biases: PersonaBiases,
): number {
  switch (action.type) {
    case "MOVE":
      return scoreMove(action, state, me, biases);
    case "RECRUIT":
      return scoreRecruit(action, biases);
    case "BUILD":
      return scoreBuild(action, state, biases);
    case "TRADE":
      return scoreConvert(action, me);
    default:
      return 0.1;
  }
}

// ---------------------------------------------------------------------------
// Diplomacy — accept NAPs, never betray, rarely reach out
// ---------------------------------------------------------------------------

/** Free ACCEPT actions for every NAP currently proposed TO this bot. */
function napAccepts(state: Readonly<GameState>, me: Player): GameAction[] {
  return pendingTreatyProposals(state)
    .filter((p) => p.accepterId === me.id && p.treatyType === TreatyType.NAP)
    .map(acceptActionFor);
}

/**
 * Rarely (seeded) propose a NAP to a random rival not already covered by a
 * treaty or a pending proposal. The chance draw is unconditional so the
 * decision stream stays fixed regardless of who is eligible.
 */
function maybeProposeNap(
  state: Readonly<GameState>,
  me: Player,
  partners: Set<string>,
  biases: PersonaBiases,
  rng: BotRng,
): GameAction | undefined {
  const wants = rng.chance(NAP_BASE + NAP_PEACE * (1 - biases.warAppetite));
  const targets = state.players.filter(
    (p) =>
      p.id !== me.id &&
      !partners.has(p.id) &&
      !proposalPendingBetween(state, me.id, p.id, TreatyType.NAP),
  );
  if (!wants || targets.length === 0) return undefined;
  const target = rng.pick(targets);
  if (!target) return undefined;
  return {
    type: "DIPLOMACY",
    player: me.id,
    diplomacy: {
      kind: "PROPOSE",
      treatyType: TreatyType.NAP,
      targetPlayerId: target.id,
    },
  };
}

/** EASY honours its treaties: never move onto a treaty partner's province. */
function violatesTreaty(
  action: GameAction,
  state: Readonly<GameState>,
  partners: Set<string>,
): boolean {
  if (action.type !== "MOVE" || partners.size === 0) return false;
  const dest = state.provinces.find((p) => p.id === action.toId);
  if (dest && dest.ownerId !== null && partners.has(dest.ownerId)) return true;
  const stacks: readonly (Army | Fleet)[] =
    action.naval === true ? state.fleets : state.armies;
  return stacks.some(
    (s) => s.locationId === action.toId && partners.has(s.ownerId),
  );
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

export const easyPolicy: Policy = {
  name: "easy-greedy",
  chooseAction(ctx: PolicyContext): readonly GameAction[] {
    const { state, rng } = ctx;
    const me = state.players.find((p) => p.id === ctx.botPlayerId);
    if (!me || me.actionsRemaining <= 0) return [];

    const biases = ctx.persona?.biases ?? DEFAULT_BIASES;
    const partners = treatyPartnerIds(me, state.round);

    // Free actions first: accept every NAP on the table (removed from the
    // proposal side-channel once accepted, so this never repeats).
    const accepts = napAccepts(state, me);

    // Fixed draw order (chance → pick → shuffle → mistake) for determinism.
    const proposal = maybeProposeNap(state, me, partners, biases, rng);

    const pool = budgetedCandidates(state, me).filter(
      (a) => !violatesTreaty(a, state, partners),
    );

    // Seeded shuffle before a stable sort = seeded tie-breaks.
    const ranked = rng
      .shuffle(pool)
      .map((action) => ({ action, score: scoreAction(action, state, me, biases) }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.action);

    // Deliberate imperfection: sometimes take the 2nd/3rd-best instead.
    if (ranked.length >= 2 && rng.chance(MISTAKE_RATE)) {
      const j = 1 + rng.int(Math.min(2, ranked.length - 1));
      const [promoted] = ranked.splice(j, 1);
      ranked.unshift(promoted);
    }

    const budgeted = proposal ? [proposal, ...ranked] : ranked;
    return [...accepts, ...budgeted.slice(0, CANDIDATE_SLICE)];
  },
};
