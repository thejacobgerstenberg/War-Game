/**
 * HARD policy — a bounded prestige-line evaluator.
 *
 * Every candidate action is scored in PRESTIGE-EQUIVALENT units against the
 * explicit §13 prestige sources, then the single best-ranked slate for this
 * one action slot is returned (greedy over scored candidates — no tree
 * search, every generator and scorer is O(map size), so the policy fits the
 * turn timer even instant-paced):
 *
 *  - TERRITORY STREAMS: own/enemy capitals (+1/+3 per round), key cities
 *    (+1/round), the §13 conquest track for walled captures (+2/+3), all
 *    weighted over a short holding horizon.
 *  - TRADE MONOPOLIES: the §13.1 sea-majority computation is replicated
 *    read-only (strict majority of owned coastal ports around a sea zone);
 *    captures that CREATE a monopoly and fleet moves / walls that DEFEND one
 *    score its diminishing MONOPOLY_PRESTIGE stream (Venice/Genoa
 *    `tradeFocus` raises the defensive weighting).
 *  - GREAT WORKS: continuing an in-progress work scores its completion
 *    prestige over the rounds remaining (near-complete works dominate a
 *    slot); new works start only with the treasury reserve intact and enough
 *    rounds left to finish.
 *  - SECRET OBJECTIVES (own only — fair play): captures that advance an
 *    allOf/anyOf/minProvinces clause and faith acquisition toward a
 *    minFaith clause earn a share of the objective's prestige.
 *  - SIEGE TIMING: a walled, defended target is attacked only when a
 *    breach-or-starve plan exists — grain math (3 base hold-out rounds, +2
 *    Granary), SEA RESUPPLY (a coastal city cannot starve unless EVERY
 *    adjacent sea zone is held by our uncontested war fleets — GD §8.2.3),
 *    the T5 masonry cap (intact Theodosian walls take max 1 HP/round without
 *    the Great Bombard) and the Bombard's 1-round EMPLACEMENT delay before
 *    it may fire. War-fleet moves that close a besieged port's supply zones
 *    score as siege support.
 *  - TACTIC CARDS at high-leverage combats only (capital / HV(3)+ province,
 *    a siege, or a large committed stack): timing/domain/side-matched cards
 *    from the bot's OWN hand are offered as free candidates.
 *  - SPY when information value is high: OBJECTIVE against the prestige
 *    leader (once per rival — previous successes are read from the bot's own
 *    log intel), UNREST on the leader's best province; both expectation-
 *    weighted by the §10.7 success roll (University / Byzantium resistance).
 *  - FACTION LINES (persona biases, HARD strength): Ottoman
 *    `constantinopleObsession` (Era III, only when militarily sane — breach
 *    plan or open walls), Venice/Genoa `tradeFocus` monopoly defence + trade
 *    routes, Byzantium `tributePreference` bribe-over-war (a TRIBUTE
 *    proposal to a looming stronger attacker instead of fighting), Hungary
 *    `crusadePreference` crusade-justified wars on the Ottoman.
 *
 * Treaty honour: partners (any live treaty) are never attacked. Determinism:
 * the only RNG draw is one seeded shuffle used as the tie-break under the
 * stable score sort. Fair play: reads only table-public state, the bot's own
 * treasury/hand/objectives and its own log intel — never a rival's hand,
 * objectives or deck order.
 */
import {
  BuildingType,
  Faction,
  GreatWorkType,
  SpyMission,
  TerrainType,
  TreatyType,
  UnitType,
  type Army,
  type Fleet,
  type GameAction,
  type GameState,
  type PendingBattle,
  type Player,
  type Province,
  type ResourceBundle,
  type TacticCardId,
} from "@imperium/shared";
import { neighborsOf } from "../../engine/adjacency.js";
import {
  CONQUEST_PRESTIGE,
  GREAT_WORK_COSTS,
  MERC_COMPANIES,
  MERC_MARKET,
  MONOPOLY_PRESTIGE,
  PRESTIGE_THRESHOLDS,
  ROUNDS,
  SIEGE,
  SPY,
  STACKING,
  TRADE,
  UNIQUE_UNIT_OVERRIDES,
  UNIT_STATS,
  VASSAL,
  WALL_TIERS,
} from "../../engine/balance.js";
import { TACTIC_CARD_BY_ID } from "../../engine/tactics.js";
import type { PersonaBiases } from "../personality.js";
import { Difficulty, type Policy, type PolicyContext } from "../types.js";
import {
  acceptActionFor,
  buildCandidates,
  convertCandidates,
  moveCandidates,
  pendingTreatyProposals,
  proposalPendingBetween,
  recruitBustsStackLimit,
  recruitCandidates,
} from "./candidates.js";

/** Ranked candidates offered to the driver per action slot. */
const CANDIDATE_SLICE = 16;
/** Rounds a captured stream is assumed to keep paying (capped by game end). */
const HOLD_HORIZON = 4;
/** Attack odds gate: attack when atk ≥ (GATE − relief·warAppetite) × def. */
const ODDS_GATE_BASE = 1.45;
const ODDS_GATE_WAR_RELIEF = 0.5;
/** A siege plan must land within this many rounds to be worth opening. */
const SIEGE_MAX_ROUNDS = 4;
/** Gold kept back before starting great works / spy missions. */
const GOLD_RESERVE = 3;
/** Era III Constantinople bonus for an obsessed (Ottoman) HARD bot. */
const OBSESSION_BONUS = 6;
/** Committed-units threshold that makes any battle "high leverage". */
const TACTIC_STAKE_UNITS = 5;

/** Neutral biases when the seat has no persona yet. */
const DEFAULT_BIASES: PersonaBiases = {
  warAppetite: 0.5,
  tributePreference: 0.4,
  tradeFocus: 0.4,
  defensiveness: 0.5,
  crusadePreference: 0.2,
  constantinopleObsession: false,
};

const RESOURCE_KEYS = ["gold", "grain", "timber", "marble", "faith"] as const;
const CONSTANTINOPLE = "constantinople";

type MoveA = Extract<GameAction, { type: "MOVE" }>;
type RecruitA = Extract<GameAction, { type: "RECRUIT" }>;
type BuildA = Extract<GameAction, { type: "BUILD" }>;
type TradeA = Extract<GameAction, { type: "TRADE" }>;

/** Everything precomputed once per decision slot. */
interface HardCtx {
  state: Readonly<GameState>;
  me: Player;
  biases: PersonaBiases;
  difficulty: Difficulty;
  /** min(HOLD_HORIZON, rounds left) — stream multiplier. */
  horizon: number;
  /** Player ids covered by any live treaty (never attacked). */
  partners: Set<string>;
  /**
   * When each partner's protection ends: the LATEST `expiresRound` across
   * live treaties with them, or null for an indefinite treaty. Partners
   * whose cover lapses within 2 rounds count as threats again.
   */
  partnerExpiry: Map<string, number | null>;
  /** Player ids currently at war with me. */
  atWar: Set<string>;
  provinceById: Map<string, Province>;
  seaZoneIds: Set<string>;
  myProvinceIds: Set<string>;
  /** Provinces I currently besiege or assault (siege support targets). */
  mySiegeTargets: Set<string>;
  prestigeLeader: Player | null;
  threshold: number;
  /** A siege-train build-up is currently wanted (see buildContext). */
  siegeNeed: boolean;
  /** War-fleet build-up wanted (blockade gap / contested monopoly sea). */
  navalNeed: boolean;
  /** Marble is the binding constraint on a wanted great work. */
  wantsMarble: boolean;
  /**
   * Stack-space escrow for the merc auction: heads of companies this bot
   * currently stands high bidder on (they field at `mercFieldLocId` at
   * cleanup, and mercenaries.ts does NOT enforce the §3.2 cap there — the
   * bidder must keep the room free).
   */
  mercReservedHeads: number;
  /** Where a won company would field (capital, else first owned CITY). */
  mercFieldLocId: string | null;
}

// ---------------------------------------------------------------------------
// Strength & map helpers (variant-aware — HARD reads the unique-unit deltas)
// ---------------------------------------------------------------------------

function stackAtk(stack: Army | Fleet): number {
  let n = 0;
  for (const t of Object.values(UnitType)) n += (stack.units[t] ?? 0) * UNIT_STATS[t].atk;
  for (const v of stack.variants ?? []) {
    const def = UNIQUE_UNIT_OVERRIDES[v.variant];
    n += v.count * (UNIT_STATS[v.base].atk + (def?.atkMod ?? 0));
  }
  return n;
}

function stackDef(stack: Army | Fleet): number {
  let n = 0;
  for (const t of Object.values(UnitType)) n += (stack.units[t] ?? 0) * UNIT_STATS[t].def;
  for (const v of stack.variants ?? []) {
    const def = UNIQUE_UNIT_OVERRIDES[v.variant];
    n += v.count * (UNIT_STATS[v.base].def + (def?.defMod ?? 0));
  }
  return n;
}

function unitCount(stack: Army | Fleet): number {
  let n = 0;
  for (const t of Object.values(UnitType)) n += stack.units[t] ?? 0;
  for (const v of stack.variants ?? []) n += v.count;
  return n;
}

function siegeUnitsIn(stack: Army | Fleet): number {
  let n = stack.units[UnitType.SIEGE] ?? 0;
  for (const v of stack.variants ?? []) if (v.base === UnitType.SIEGE) n += v.count;
  return n;
}

/** A player's total field strength (armies + fleets, attack values). */
function totalStrength(state: Readonly<GameState>, playerId: string): number {
  let n = 0;
  for (const a of state.armies) if (a.ownerId === playerId) n += stackAtk(a);
  for (const f of state.fleets) if (f.ownerId === playerId) n += stackAtk(f);
  return n;
}

/** War-fleet (GALLEY/WARSHIP) unit count a player keeps in a sea zone. */
function warFleetUnitsIn(
  state: Readonly<GameState>,
  zoneId: string,
  ownerId: string,
): number {
  let n = 0;
  for (const f of state.fleets) {
    if (f.ownerId !== ownerId || f.locationId !== zoneId) continue;
    n += (f.units[UnitType.GALLEY] ?? 0) + (f.units[UnitType.WARSHIP] ?? 0);
    for (const v of f.variants ?? []) n += v.count;
  }
  return n;
}

/** Static + standing defence of a province against me (walls, garrison, stacks). */
function defenceAt(hc: HardCtx, prov: Province): number {
  const wallBonus = prov.walls.hp > 0 ? (WALL_TIERS[prov.walls.tier]?.defBonus ?? 0) : 0;
  let n = (prov.garrison ?? 0) + wallBonus;
  for (const a of hc.state.armies) {
    if (a.locationId === prov.id && a.ownerId !== hc.me.id && !hc.partners.has(a.ownerId)) {
      n += stackDef(a);
    }
  }
  return n;
}

/** Enemy attack strength adjacent to one of my provinces (threat pressure). */
function threatAt(hc: HardCtx, provId: string): number {
  let n = 0;
  for (const nb of neighborsOf(provId)) {
    for (const a of hc.state.armies) {
      if (
        a.locationId === nb &&
        a.ownerId !== hc.me.id &&
        !hc.partners.has(a.ownerId)
      ) {
        n += stackAtk(a);
      }
    }
  }
  return n;
}

/** My standing defence in an owned province (stacks + garrison + walls). */
function myDefenceAt(hc: HardCtx, prov: Province): number {
  const wallBonus = prov.walls.hp > 0 ? (WALL_TIERS[prov.walls.tier]?.defBonus ?? 0) : 0;
  let n = (prov.garrison ?? 0) + wallBonus;
  for (const a of hc.state.armies) {
    if (a.locationId === prov.id && a.ownerId === hc.me.id) n += stackDef(a);
  }
  return n;
}

/** A partner whose treaty cover lapses within `rounds` is a threat again. */
function partnerCoverLapsing(hc: HardCtx, playerId: string, rounds = 2): boolean {
  if (!hc.partners.has(playerId)) return true; // not a partner at all
  const expiry = hc.partnerExpiry.get(playerId);
  return expiry !== null && expiry !== undefined && expiry <= hc.state.round + rounds;
}

/**
 * RIVAL attack strength within TWO steps of a province — the rush warning
 * used by the home-anchor rules. Only PLAYER armies count (minor garrisons
 * sit still; they never march on a capital). Partners whose treaty lapses
 * within two rounds count at full strength: a NAP about to expire stops
 * shielding NOTHING, and the garrison must already be manned when it does.
 */
function threatNear(hc: HardCtx, provId: string): number {
  const ring = new Set<string>();
  for (const nb of neighborsOf(provId)) {
    ring.add(nb);
    for (const nb2 of neighborsOf(nb)) ring.add(nb2);
  }
  ring.delete(provId);
  const playerIds = new Set(hc.state.players.map((p) => p.id));
  let n = 0;
  for (const a of hc.state.armies) {
    if (a.ownerId === hc.me.id) continue;
    if (!playerIds.has(a.ownerId)) continue;
    if (!partnerCoverLapsing(hc, a.ownerId)) continue;
    if (ring.has(a.locationId)) n += stackAtk(a);
  }
  return n;
}

/** A province whose holding stream we must not gift away (capital/key city). */
function isStreamProvince(prov: Province): boolean {
  return prov.isCapitalOf !== undefined || (prov.highValue ?? 0) > 0;
}

/** My unit heads standing in a province (armies only, garrison excluded). */
function myUnitsAt(hc: HardCtx, provId: string): number {
  let n = 0;
  for (const a of hc.state.armies) {
    if (a.ownerId === hc.me.id && a.locationId === provId) n += unitCount(a);
  }
  return n;
}

/**
 * Would adding `extraHeads` to a province overflow the §3.2 city cap once
 * the merc companies we stand high bidder on field there at cleanup?
 */
function bustsMercEscrow(hc: HardCtx, provId: string, extraHeads: number): boolean {
  if (hc.mercReservedHeads === 0 || provId !== hc.mercFieldLocId) return false;
  return myUnitsAt(hc, provId) + hc.mercReservedHeads + extraHeads > STACKING.city;
}

// ---------------------------------------------------------------------------
// Prestige-line valuation
// ---------------------------------------------------------------------------

/** Per-round holding stream of a province, in prestige units, over the horizon. */
function holdStreamValue(hc: HardCtx, prov: Province): number {
  let perRound = 0;
  if (prov.isCapitalOf !== undefined) {
    perRound += prov.isCapitalOf === hc.me.faction ? 1 : CONQUEST_PRESTIGE.holdEnemyCapitalPerRound;
  } else if ((prov.highValue ?? 0) > 0) {
    perRound += 1;
  }
  const y = prov.yields;
  const econ = Math.min(2, 0.25 * (2 * y.gold + y.grain + y.timber + y.marble + y.faith));
  return perRound * hc.horizon + econ;
}

/**
 * §13.1 trade-monopoly count via sea-port majorities (replicates the scorer's
 * public computation, read-only). `extraOwned` evaluates a hypothetical
 * capture of that province by `playerId`.
 */
function monopolyCount(
  hc: HardCtx,
  playerId: string,
  extraOwned?: string,
): number {
  let count = 0;
  for (const zone of hc.state.seaZones) {
    const portOwners: string[] = [];
    for (const nb of neighborsOf(zone.id)) {
      const prov = hc.provinceById.get(nb);
      if (!prov || !prov.coastal) continue;
      const owner = prov.id === extraOwned ? playerId : prov.ownerId;
      if (owner) portOwners.push(owner);
    }
    if (portOwners.length < 2) continue;
    const mine = portOwners.filter((o) => o === playerId).length;
    if (mine * 2 > portOwners.length) count += 1;
  }
  return count;
}

/** Diminishing monopoly prestige per round for a monopoly count. */
function monopolyPrestige(count: number): number {
  if (count <= 0) return 0;
  return MONOPOLY_PRESTIGE.first + MONOPOLY_PRESTIGE.additional * (count - 1);
}

/** Marginal per-round monopoly prestige from capturing `provId`. */
function monopolyDelta(hc: HardCtx, provId: string): number {
  const prov = hc.provinceById.get(provId);
  if (!prov?.coastal) return 0;
  const before = monopolyPrestige(monopolyCount(hc, hc.me.id));
  const after = monopolyPrestige(monopolyCount(hc, hc.me.id, provId));
  return Math.max(0, after - before);
}

/** Share of my own secret objectives' prestige advanced by taking `provId`. */
function objectiveCaptureBonus(hc: HardCtx, provId: string): number {
  let bonus = 0;
  const owned = (id: string): boolean =>
    hc.provinceById.get(id)?.ownerId === hc.me.id;
  for (const obj of hc.me.objectives) {
    if (obj.completed) continue;
    const refs = [...(obj.provinceRefs ?? []), ...(obj.allOf ?? [])];
    const missing = refs.filter((id) => !owned(id));
    if (missing.includes(provId)) {
      bonus += (obj.prestige * 0.9) / Math.max(1, missing.length);
    }
    const anyOf = obj.anyOf ?? [];
    if (anyOf.length > 0 && !anyOf.some(owned) && anyOf.includes(provId)) {
      bonus += obj.prestige * 0.5;
    }
    if (obj.minProvinces !== undefined) {
      const held = hc.state.provinces.filter((p) => p.ownerId === hc.me.id).length;
      if (held < obj.minProvinces) {
        bonus += (obj.prestige * 0.25) / Math.max(1, obj.minProvinces - held);
      }
    }
  }
  return bonus;
}

// ---------------------------------------------------------------------------
// Siege timing — grain math, sea resupply, masonry cap, Bombard emplacement
// ---------------------------------------------------------------------------

interface SiegePlan {
  feasible: boolean;
  /** Estimated rounds until the city falls (breach or starve). */
  rounds: number;
}

/**
 * Can this walled target realistically be taken, and how fast? Combines the
 * §8.2 bombardment math (avg ~2 wall HP per SIEGE unit die), the §8.3 T5
 * masonry cap (1 HP/round total without the Great Bombard), the Bombard's
 * two dice + cap lift with its 1-round emplacement delay (delta 3), and the
 * §8.2.3 starvation clock with GRANARY and SEA-RESUPPLY awareness (a coastal
 * city starves only while EVERY adjacent sea zone is enemy-controlled — so
 * it only counts here when all its zones are already held by my uncontested
 * war fleets).
 */
function siegePlan(hc: HardCtx, dest: Province, moving: Army | Fleet): SiegePlan {
  const wallHp = dest.walls.hp;
  if (wallHp <= 0) return { feasible: true, rounds: 0 };

  // --- Breach clock -------------------------------------------------------
  let train = siegeUnitsIn(moving);
  for (const a of hc.state.armies) {
    if (a.ownerId === hc.me.id && a.locationId === dest.id) train += siegeUnitsIn(a);
  }
  const gb = hc.state.greatBombard;
  const bombardHere =
    gb?.inPlay === true &&
    gb.ownerId === hc.me.id &&
    gb.provinceId !== null &&
    (gb.provinceId === dest.id || neighborsOf(dest.id).includes(gb.provinceId));
  // Not yet emplaced against this wall → it sits out (at least) the first round.
  const bombardDelay = bombardHere && gb !== undefined && gb.provinceId !== dest.id ? 1 : 0;

  let perRound: number;
  if (dest.walls.tier >= 5 && !bombardHere) {
    perRound = train > 0 ? SIEGE.t5MasonryCapPerRound : 0; // §8.3 masonry cap
  } else {
    perRound = train * 2 + (bombardHere ? 4 : 0); // avg of the damage die ≈ 2
  }
  const breachRounds =
    perRound > 0 ? Math.ceil(wallHp / perRound) + bombardDelay : Number.POSITIVE_INFINITY;

  // --- Starvation clock (grain math + sea resupply) ------------------------
  const holdout =
    SIEGE.baseHoldoutRounds +
    (dest.buildings.includes(BuildingType.GRANARY) ? SIEGE.granaryBonusRounds : 0);
  let canStarve = true;
  if (dest.coastal) {
    const zones = neighborsOf(dest.id).filter((id) => hc.seaZoneIds.has(id));
    // §8.2.3: supply slips in through ANY zone not enemy-controlled. Only when
    // every adjacent zone already holds my uncontested war fleet does the port
    // starve like an inland city.
    canStarve =
      zones.length > 0 &&
      zones.every((z) => {
        if (warFleetUnitsIn(hc.state, z, hc.me.id) === 0) return false;
        const defenderId = dest.ownerId;
        return defenderId === null || warFleetUnitsIn(hc.state, z, defenderId) === 0;
      });
  }
  const starveRounds = canStarve ? holdout + 1 : Number.POSITIVE_INFINITY;

  const rounds = Math.min(breachRounds, starveRounds);
  const remaining = ROUNDS - hc.state.round;
  return { feasible: rounds <= SIEGE_MAX_ROUNDS && rounds <= remaining, rounds };
}

// ---------------------------------------------------------------------------
// Scoring — one prestige-equivalent number per candidate
// ---------------------------------------------------------------------------

function scoreLandMove(hc: HardCtx, action: MoveA): number {
  const dest = hc.provinceById.get(action.toId);
  if (!dest) return 0.02;
  const moving = hc.state.armies.find((a) => a.id === action.stackId);
  if (!moving) return 0.02;

  // HOME ANCHOR: never march defence out of a stream province (own capital /
  // key city) that a rival force within two steps could then overrun — a rush
  // walks in "unopposed" and the holding stream flips to it. This was HARD's
  // fatal leak vs the EASY rusher: it traded its own +1..+3/round streams for
  // a one-shot capture elsewhere. The province must keep at least 60% of the
  // nearby rival strength after the stack departs.
  const origin = hc.provinceById.get(moving.locationId);
  if (origin && origin.ownerId === hc.me.id && isStreamProvince(origin)) {
    const remaining = myDefenceAt(hc, origin) - stackDef(moving);
    if (remaining < 0.6 * threatNear(hc, origin.id)) return 0.01;
  }

  // Reinforcement of my own ground: worth it where a stream is threatened.
  if (dest.ownerId === hc.me.id) {
    if (bustsMercEscrow(hc, dest.id, unitCount(moving))) {
      return 0.02; // keep room for the company we stand high bidder on
    }
    // Stream provinces look two steps out (come home BEFORE the rush is
    // adjacent); ordinary ground only reacts to adjacent threats. The own
    // CAPITAL weighs the whole approaching force — losing it is -3 prestige
    // plus a +3/round stream gifted to the invader.
    const nearFactor =
      dest.isCapitalOf === hc.me.faction ? 1.0 : isStreamProvince(dest) ? 0.6 : 0;
    const threat = Math.max(threatAt(hc, dest.id), nearFactor * threatNear(hc, dest.id));
    if (threat <= 0) return 0.1;
    // Already safe → no oscillation: two stacks must never ping-pong between
    // a pair of covered stream provinces burning the whole budget.
    if (myDefenceAt(hc, dest) >= threat) return 0.08;
    const shortfall = threat / Math.max(1, myDefenceAt(hc, dest));
    const streamWorth =
      holdStreamValue(hc, dest) +
      (dest.coastal && monopolyCount(hc, hc.me.id) > 0 ? hc.biases.tradeFocus * 2 : 0);
    return Math.max(
      0.1,
      Math.min(shortfall, 1.5) *
        streamWorth *
        (isStreamProvince(dest) ? 0.45 : 0.3) *
        (0.5 + hc.biases.defensiveness),
    );
  }

  // Never attack a treaty partner's ground or stacks (treaty honour).
  const attack = stackAtk(moving);
  const defence = defenceAt(hc, dest);
  const enemyPresent = hc.state.armies.some(
    (a) =>
      a.locationId === dest.id && a.ownerId !== hc.me.id && !hc.partners.has(a.ownerId),
  );
  const hostileOwner = dest.ownerId !== null && dest.ownerId !== hc.me.id;
  const defended = enemyPresent || ((dest.garrison ?? 0) > 0 && (hostileOwner || dest.ownerId === null));

  let captureVal =
    holdStreamValue(hc, dest) +
    objectiveCaptureBonus(hc, dest.id) +
    monopolyDelta(hc, dest.id) * hc.horizon;
  if (dest.walls.tier >= 1 && defended) {
    captureVal +=
      dest.walls.tier >= 4
        ? CONQUEST_PRESTIGE.takeWalledCityHighTier
        : CONQUEST_PRESTIGE.takeWalledCity;
  }
  if (dest.ownerId !== null && hc.atWar.has(dest.ownerId)) {
    captureVal += 0.8; // progress toward the §13.1 win-war +3
  }
  if (defended) {
    // §13.1 decisive battle win pays +1 on its own — a favourable battle is
    // prestige even before the ground it wins.
    captureVal += Math.min(1, attack / (2 * Math.max(1, defence)));
  }

  // Ottoman Era III line: the Red Apple, when militarily sane (HARD only).
  const obsessed =
    hc.difficulty === Difficulty.HARD &&
    hc.biases.constantinopleObsession &&
    hc.state.era === 3 &&
    dest.id === CONSTANTINOPLE;

  if (!defended) {
    // Unopposed occupation (ownership flips at cleanup).
    return Math.max(0.05, captureVal * 0.9 + (obsessed ? OBSESSION_BONUS : 0));
  }

  // Walled + defended → only with a workable siege plan.
  if (dest.walls.hp > 0) {
    const plan = siegePlan(hc, dest, moving);
    if (!plan.feasible) return 0.03;
    captureVal = captureVal * (1 - 0.12 * plan.rounds) + (obsessed ? OBSESSION_BONUS : 0);
  } else if (obsessed) {
    captureVal += OBSESSION_BONUS;
  }

  const gate = ODDS_GATE_BASE - ODDS_GATE_WAR_RELIEF * hc.biases.warAppetite;
  const odds = attack / Math.max(1, defence);
  if (odds < gate) return 0.04;

  let score = captureVal * Math.min(1.3, odds / gate);
  // Hungary's crusade window: press the declared crusade against the Ottoman.
  const ownerFaction = hc.state.players.find((p) => p.id === dest.ownerId)?.faction;
  if (
    ownerFaction === Faction.OTTOMAN &&
    dest.ownerId !== null &&
    hc.atWar.has(dest.ownerId) &&
    hc.biases.crusadePreference >= 0.6
  ) {
    score += hc.biases.crusadePreference * 1.5;
  }
  return Math.max(0.05, score);
}

function scoreNavalMove(hc: HardCtx, action: MoveA): number {
  const zoneId = action.toId;
  const enemyFleetUnits = hc.state.fleets
    .filter(
      (f) =>
        f.locationId === zoneId &&
        f.ownerId !== hc.me.id &&
        !hc.partners.has(f.ownerId),
    )
    .reduce((acc, f) => acc + unitCount(f), 0);
  const moving = hc.state.fleets.find((f) => f.id === action.stackId);
  const myPower = moving ? stackAtk(moving) : 0;

  // Siege support: closing a supply zone of a coastal city I am besieging
  // (sea-resupply denial is what makes the grain clock run — §8.2.3).
  for (const target of hc.mySiegeTargets) {
    if (!neighborsOf(target).includes(zoneId)) continue;
    if (warFleetUnitsIn(hc.state, zoneId, hc.me.id) > 0) break; // already held
    if (enemyFleetUnits === 0 || myPower > enemyFleetUnits) return 2.6;
  }

  // Monopoly defence: contest enemy war fleets loitering in a sea whose ports
  // I dominate (Venice/Genoa signature — scaled by tradeFocus).
  if (enemyFleetUnits > 0) {
    const portOwners: string[] = [];
    for (const nb of neighborsOf(zoneId)) {
      const prov = hc.provinceById.get(nb);
      if (prov?.coastal && prov.ownerId) portOwners.push(prov.ownerId);
    }
    const mine = portOwners.filter((o) => o === hc.me.id).length;
    const monopolySea = portOwners.length >= 2 && mine * 2 > portOwners.length;
    const onMyRoute = hc.state.activeModifiers.some(
      (m) =>
        m.kind === "trade_route" &&
        m.data?.ownerId === hc.me.id &&
        Array.isArray(m.data?.seaZonePath) &&
        (m.data.seaZonePath as string[]).includes(zoneId),
    );
    if ((monopolySea || onMyRoute) && myPower >= enemyFleetUnits) {
      return (
        (monopolySea ? MONOPOLY_PRESTIGE.first * 0.4 * hc.horizon * 0.5 : 1.2) +
        hc.biases.tradeFocus * 1.5
      );
    }
    return 0.08; // outmatched or nothing at stake
  }
  return 0.12 + 0.15 * hc.biases.tradeFocus;
}

function scoreRecruit(hc: HardCtx, action: RecruitA): number {
  const prov = hc.provinceById.get(action.provinceId);
  if (!prov) return 0.02;
  if (bustsMercEscrow(hc, prov.id, 1)) return 0.02; // keep room for the company
  const milWeight =
    0.55 + 0.45 * (hc.state.round / ROUNDS) + Math.min(0.5, threatAt(hc, prov.id) * 0.05);
  // Home-defence urgency: a stream province (capital/key city) with less
  // standing defence than the rival force within two steps MUST garrison up
  // (the flip side of the home anchor in scoreLandMove). Defence is worth
  // what the attacker would gain: the holding stream itself plus the
  // conquest award — so the boost scales with the stream's value.
  let homeShortfall = 0;
  if (isStreamProvince(prov)) {
    const gap = threatNear(hc, prov.id) - myDefenceAt(hc, prov);
    if (gap > 0) {
      homeShortfall =
        Math.min(1.6, gap * 0.3) * (1 + 0.5 * holdStreamValue(hc, prov));
    }
  }
  // Grain solvency: land units eat ~1 grain/round (§4.4) and a host the
  // fields cannot SUSTAIN deserts — casual recruiting is damped hard once
  // upkeep outruns grain income with the granary low. A MULTIPLIER, not a
  // floor: emergency home defence (homeShortfall) and an urgently needed
  // siege train still surface, ranked below the grain fix (scoreConvert
  // prices the crisis buy above 2.5).
  let grainDamp = 1;
  if (homeShortfall === 0) {
    let upkeep = 0;
    for (const a of hc.state.armies) if (a.ownerId === hc.me.id) upkeep += unitCount(a);
    let grainYield = 0;
    for (const p of hc.state.provinces) {
      if (p.ownerId === hc.me.id) grainYield += p.yields.grain;
    }
    if (grainYield < upkeep + 1 && hc.me.treasury.grain < upkeep * 1.5) grainDamp = 0.25;
  }
  let score = 0.3 + homeShortfall;
  for (const t of Object.values(UnitType)) {
    const count = action.units[t] ?? 0;
    if (count <= 0) continue;
    const stats = UNIT_STATS[t];
    if (t === UnitType.SIEGE) {
      // Strategic war-machine needs stay above the grain damp: a siege train
      // is bought for a specific window, not as standing upkeep.
      score += hc.siegeNeed ? 2.4 + (hc.biases.constantinopleObsession ? 1.2 : 0) : 0.15;
    } else if (t === UnitType.WARSHIP) {
      score += hc.navalNeed ? 2.0 : (0.4 + hc.biases.tradeFocus * 0.6) * grainDamp;
    } else if (t === UnitType.GALLEY) {
      score += 0.5 + hc.biases.tradeFocus * 1.2;
    } else {
      const value =
        stats.atk + stats.def * (0.4 + 0.6 * hc.biases.defensiveness);
      const goldCost = stats.cost.gold ?? 1;
      score += (count * value * milWeight * grainDamp) / Math.max(1, goldCost);
    }
  }
  return score;
}

function scoreBuild(hc: HardCtx, action: BuildA): number {
  const prov = hc.provinceById.get(action.provinceId);
  if (!prov) return 0.02;

  if (action.greatWork) {
    const def = GREAT_WORK_COSTS[action.greatWork];
    const existing = prov.greatWorks.find((g) => g.type === action.greatWork);
    if (existing && existing.progress < def.rounds) {
      // Continuing pays the full completion prestige over the rounds left.
      return (1.2 * def.prestige) / Math.max(1, def.rounds - existing.progress);
    }
    return (0.7 * def.prestige) / def.rounds;
  }

  if (!action.building) return 0.02;
  const econWeight = 1.2 - 0.6 * (hc.state.round / ROUNDS);
  const threatened = threatAt(hc, prov.id) > myDefenceAt(hc, prov);
  const stream = prov.isCapitalOf !== undefined || (prov.highValue ?? 0) > 0;
  switch (action.building) {
    case BuildingType.MARKET:
      return 1.0 * econWeight + 0.4;
    case BuildingType.WALLS: {
      let s = 0.4 + (threatened && stream ? 2.0 * hc.biases.defensiveness : 0.3 * hc.biases.defensiveness);
      // Monopoly-port defence (Venice/Genoa keep their ports walled).
      if (prov.coastal && monopolyCount(hc, hc.me.id) > 0) s += hc.biases.tradeFocus;
      return s;
    }
    case BuildingType.GRANARY:
      return prov.isCapitalOf !== undefined
        ? 0.5 + hc.biases.defensiveness // +2 siege hold-out on the capital
        : 0.35;
    case BuildingType.TEMPLE: {
      const wantsFaith = hc.me.objectives.some(
        (o) => !o.completed && o.minFaith !== undefined && hc.me.treasury.faith < o.minFaith,
      );
      return wantsFaith ? 1.9 : 0.5;
    }
    case BuildingType.UNIVERSITY:
      return 0.9; // +1 tactic draw per round: HARD plays its tactics
    case BuildingType.SHIPYARD:
      return 0.4 + hc.biases.tradeFocus * 0.9;
    case BuildingType.BARRACKS: {
      const musters =
        prov.isCapitalOf !== undefined || prov.terrain === TerrainType.CITY;
      return musters ? 0.2 : 1.1;
    }
    default:
      return 0.3;
  }
}

function scoreConvert(hc: HardCtx, action: TradeA): number {
  const trade = action.trade;
  if (trade.kind !== "CONVERT") return 0.02;
  const giveKey = RESOURCE_KEYS.find((k) => (trade.give[k] ?? 0) > 0);
  const getKey = RESOURCE_KEYS.find((k) => (trade.get[k] ?? 0) > 0);
  if (!giveKey || !getKey) return 0.02;
  if (hc.me.treasury[giveKey] < 4) return 0.02; // keep a working reserve
  // Approximate grain upkeep: every land unit eats ~1/round.
  let upkeep = 0;
  for (const a of hc.state.armies) if (a.ownerId === hc.me.id) upkeep += unitCount(a);
  if (giveKey === "grain" && hc.me.treasury.grain < upkeep + 2) return 0.02;
  if (getKey === "gold" && hc.me.treasury.gold < 4) return 2.1;
  if (getKey === "grain") {
    // Desertion maths (§4.4 unfed hosts desert — and a deserted wall is an
    // open wall): if the granary after next income will not cover upkeep,
    // buy grain NOW; feeding the garrison outranks any capture.
    let grainYield = 0;
    for (const p of hc.state.provinces) {
      if (p.ownerId === hc.me.id) grainYield += p.yields.grain;
    }
    const projected = hc.me.treasury.grain - upkeep + grainYield;
    if (hc.me.treasury.grain < upkeep) {
      return 2.5 + Math.min(2.5, (upkeep - hc.me.treasury.grain) * 0.5);
    }
    if (projected < upkeep) return 2.2;
  }
  if (getKey === "marble" && hc.wantsMarble && hc.me.treasury.gold >= 8) return 1.1;
  return 0.03;
}

function scoreAction(hc: HardCtx, action: GameAction): number {
  switch (action.type) {
    case "MOVE":
      return action.naval === true ? scoreNavalMove(hc, action) : scoreLandMove(hc, action);
    case "RECRUIT":
      return scoreRecruit(hc, action);
    case "BUILD":
      return scoreBuild(hc, action);
    case "TRADE":
      return action.trade.kind === "ROUTE"
        ? scoreRoute(hc, action)
        : scoreConvert(hc, action);
    case "SPY":
      return scoreSpy(hc, action);
    case "VASSALIZE":
      return scoreVassalize(hc, action);
    case "DECLARE_WAR":
      return 1.6 + hc.biases.crusadePreference * 2;
    case "DIPLOMACY": {
      // NAP/TRIBUTE proposals (napProposals / tributeProposals). A defensive
      // NAP while a stream province is EXPOSED is the single highest-leverage
      // action on the board — one action that can cancel an entire offensive.
      if (
        action.diplomacy.kind === "PROPOSE" &&
        action.diplomacy.treatyType === TreatyType.NAP
      ) {
        const exposed = hc.state.provinces.some(
          (p) =>
            p.ownerId === hc.me.id &&
            isStreamProvince(p) &&
            threatNear(hc, p.id) > myDefenceAt(hc, p),
        );
        return exposed ? 6.5 + hc.biases.defensiveness : 3.4;
      }
      if (action.diplomacy.kind === "RENOUNCE") {
        // Only generated when the pact is escorting its holder to victory
        // (renounceActions) — breaking it is the highest-value use of an
        // action short of an emergency NAP.
        return 5.5;
      }
      return 2.4 + hc.biases.tributePreference + hc.biases.defensiveness * 0.5;
    }
    case "LEVY_CALL":
      return 1.0 + 0.5 * (hc.state.round / ROUNDS);
    default:
      return 0.1;
  }
}

// ---------------------------------------------------------------------------
// HARD-specific budgeted generators
// ---------------------------------------------------------------------------

function canAfford(me: Player, cost: Partial<ResourceBundle>): boolean {
  return RESOURCE_KEYS.every((k) => me.treasury[k] >= (cost[k] ?? 0));
}

/** SIEGE / WARSHIP recruits (the shared pool only raises line troops). */
function warMachineRecruits(hc: HardCtx): GameAction[] {
  const out: GameAction[] = [];
  for (const prov of hc.state.provinces) {
    if (prov.ownerId !== hc.me.id) continue;
    const musters =
      prov.isCapitalOf !== undefined ||
      prov.terrain === TerrainType.CITY ||
      prov.buildings.includes(BuildingType.BARRACKS);
    if (
      musters &&
      hc.siegeNeed &&
      canAfford(hc.me, UNIT_STATS[UnitType.SIEGE].cost) &&
      !recruitBustsStackLimit(hc.state, hc.me.id, prov) // §3.2 pre-filter
    ) {
      out.push({
        type: "RECRUIT",
        player: hc.me.id,
        provinceId: prov.id,
        units: { [UnitType.SIEGE]: 1 },
      });
    }
    if (
      prov.buildings.includes(BuildingType.SHIPYARD) &&
      canAfford(hc.me, UNIT_STATS[UnitType.WARSHIP].cost)
    ) {
      out.push({
        type: "RECRUIT",
        player: hc.me.id,
        provinceId: prov.id,
        units: { [UnitType.WARSHIP]: 1 },
      });
    }
  }
  return out;
}

/** Continue in-progress great works; start one when reserve + time allow. */
function greatWorkBuilds(hc: HardCtx): GameAction[] {
  const out: GameAction[] = [];
  let haveInProgress = false;
  for (const prov of hc.state.provinces) {
    if (prov.ownerId !== hc.me.id) continue;
    for (const gw of prov.greatWorks) {
      const def = GREAT_WORK_COSTS[gw.type];
      if (gw.progress >= def.rounds) continue;
      haveInProgress = true;
      out.push({ type: "BUILD", player: hc.me.id, provinceId: prov.id, greatWork: gw.type });
    }
  }
  if (haveInProgress) return out; // one project at a time
  const remaining = ROUNDS - hc.state.round;
  for (const prov of hc.state.provinces) {
    if (prov.ownerId !== hc.me.id) continue;
    for (const type of Object.values(GreatWorkType)) {
      if (prov.greatWorks.some((g) => g.type === type)) continue;
      const def = GREAT_WORK_COSTS[type];
      if (remaining < def.rounds + 1) continue;
      if (!canAfford(hc.me, def.cost)) continue;
      if (hc.me.treasury.gold - (def.cost.gold ?? 0) < GOLD_RESERVE) continue;
      out.push({ type: "BUILD", player: hc.me.id, provinceId: prov.id, greatWork: type });
    }
  }
  return out;
}

/** BFS shortest sea-zone path between two coastal provinces (≤ 5 zones). */
function seaPath(hc: HardCtx, fromId: string, toId: string): string[] | null {
  const starts = neighborsOf(fromId).filter((z) => hc.seaZoneIds.has(z));
  const goals = new Set(neighborsOf(toId).filter((z) => hc.seaZoneIds.has(z)));
  if (starts.length === 0 || goals.size === 0) return null;
  const prev = new Map<string, string | null>();
  const queue: string[] = [];
  for (const s of starts) {
    if (!prev.has(s)) {
      prev.set(s, null);
      queue.push(s);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const zone = queue[qi];
    qi += 1;
    if (goals.has(zone)) {
      const path: string[] = [];
      let cur: string | null = zone;
      while (cur !== null) {
        path.unshift(cur);
        cur = prev.get(cur) ?? null;
      }
      return path;
    }
    if (path5Exceeded(prev, zone)) continue;
    for (const nb of neighborsOf(zone)) {
      if (!hc.seaZoneIds.has(nb) || prev.has(nb)) continue;
      prev.set(nb, zone);
      queue.push(nb);
    }
  }
  return null;
}

/** Depth guard for {@link seaPath}: stop expanding past 5 hops. */
function path5Exceeded(prev: Map<string, string | null>, zone: string): boolean {
  let depth = 0;
  let cur: string | null = zone;
  while (cur !== null && depth <= 5) {
    cur = prev.get(cur) ?? null;
    depth += 1;
  }
  return depth > 5;
}

/** New trade routes between my ports (needs a GALLEY; skips existing pairs). */
function tradeRouteActions(hc: HardCtx): TradeA[] {
  const galleys = hc.state.fleets
    .filter((f) => f.ownerId === hc.me.id)
    .reduce((acc, f) => acc + (f.units[UnitType.GALLEY] ?? 0), 0);
  if (galleys === 0) return [];
  const existing = new Set<string>();
  let routeCount = 0;
  for (const m of hc.state.activeModifiers) {
    if (m.kind !== "trade_route" || m.data?.ownerId !== hc.me.id) continue;
    routeCount += 1;
    const a = String(m.data?.fromProvinceId ?? "");
    const b = String(m.data?.toProvinceId ?? "");
    existing.add([a, b].sort().join("|"));
  }
  if (routeCount >= galleys) return []; // one merchantman per route, roughly
  const ports = hc.state.provinces.filter(
    (p) => p.ownerId === hc.me.id && p.coastal,
  );
  const out: TradeA[] = [];
  for (let i = 0; i < ports.length && out.length < 2; i += 1) {
    for (let j = i + 1; j < ports.length && out.length < 2; j += 1) {
      const key = [ports[i].id, ports[j].id].sort().join("|");
      if (existing.has(key)) continue;
      const path = seaPath(hc, ports[i].id, ports[j].id);
      if (!path) continue;
      out.push({
        type: "TRADE",
        player: hc.me.id,
        trade: {
          kind: "ROUTE",
          fromProvinceId: ports[i].id,
          toProvinceId: ports[j].id,
          seaZonePath: path,
        },
      });
    }
  }
  return out;
}

function scoreRoute(hc: HardCtx, action: TradeA): number {
  if (action.trade.kind !== "ROUTE") return 0.02;
  const hops = action.trade.seaZonePath.length;
  const maritime =
    hc.me.faction === Faction.VENICE || hc.me.faction === Faction.GENOA
      ? TRADE.maritimeMultiplier
      : 1;
  const goldPerRound = (TRADE.baseRouteGold + hops * 0.5) * maritime;
  return goldPerRound * 0.35 * (0.6 + hc.biases.tradeFocus);
}

/** §10.7 expected-success probability of a spy roll against `rival`. */
function spySuccessP(hc: HardCtx, rival: Player | undefined): number {
  let target = SPY.baseTarget;
  if (
    rival &&
    hc.state.provinces.some(
      (p) => p.ownerId === rival.id && p.buildings.includes(BuildingType.UNIVERSITY),
    )
  ) {
    target += SPY.universityPenalty;
  }
  if (rival?.faction === Faction.BYZANTIUM) target += SPY.byzantiumResist;
  return Math.max(0, Math.min(1, (7 - target) / 6));
}

/** Have I already uncovered this rival's objective? (my own log intel) */
function objectiveKnown(hc: HardCtx, rivalId: string): boolean {
  return hc.state.log.some(
    (e) =>
      e.type === "spy" &&
      e.actors[0] === hc.me.id &&
      e.data?.captured === false &&
      typeof e.data?.objectiveId === "string" &&
      (e.targets ?? []).includes(rivalId),
  );
}

/** SPY missions offered only when the information value is high. */
function spyActions(hc: HardCtx): GameAction[] {
  if (hc.me.treasury.gold < SPY.goldCost + GOLD_RESERVE) return [];
  const leader = hc.prestigeLeader;
  if (!leader) return [];
  const leading = leader.prestige - hc.me.prestige >= 8;
  const endgameNear = leader.prestige >= hc.threshold * 0.6;
  if (!leading && !endgameNear && !hc.atWar.has(leader.id)) return [];
  const out: GameAction[] = [];
  if (!objectiveKnown(hc, leader.id)) {
    out.push({
      type: "SPY",
      player: hc.me.id,
      mission: SpyMission.OBJECTIVE,
      targetPlayerId: leader.id,
    });
  }
  // Suppress the leader's richest province next Income.
  let best: Province | undefined;
  let bestYield = 0;
  for (const p of hc.state.provinces) {
    if (p.ownerId !== leader.id) continue;
    const y = p.yields;
    const total = 2 * y.gold + y.grain + y.timber + y.marble + y.faith;
    if (total > bestYield) {
      bestYield = total;
      best = p;
    }
  }
  if (best && (leading || hc.atWar.has(leader.id))) {
    out.push({
      type: "SPY",
      player: hc.me.id,
      mission: SpyMission.UNREST,
      targetProvinceId: best.id,
    });
  }
  return out;
}

function scoreSpy(hc: HardCtx, action: Extract<GameAction, { type: "SPY" }>): number {
  const rival = hc.state.players.find(
    (p) =>
      p.id === action.targetPlayerId ||
      (action.targetProvinceId !== undefined &&
        hc.provinceById.get(action.targetProvinceId)?.ownerId === p.id),
  );
  const p = spySuccessP(hc, rival);
  // A captured agent costs a REAL -2 prestige (§10.7) plus the wasted
  // action — price the full expected loss into both missions.
  const failCost = (1 - p) * 2.0;
  if (action.mission === SpyMission.OBJECTIVE) return 0.8 + 2.2 * p - failCost;
  if (action.mission === SpyMission.UNREST) {
    // Value scales with the income actually denied next round.
    const prov = action.targetProvinceId
      ? hc.provinceById.get(action.targetProvinceId)
      : undefined;
    const y = prov?.yields;
    const denied = y ? 2 * y.gold + y.grain + y.timber + y.marble + y.faith : 4;
    return (0.5 + denied * 0.3) * p - failCost;
  }
  return 0.3;
}

/** Vassalize reachable independent minors when the §11.5 roll favours us. */
function vassalizeActions(hc: HardCtx): GameAction[] {
  const out: GameAction[] = [];
  const myLocs = new Set<string>(hc.myProvinceIds);
  for (const a of hc.state.armies) if (a.ownerId === hc.me.id) myLocs.add(a.locationId);
  const prestigeTier = Math.min(
    VASSAL.prestigeTierCap,
    Math.floor(hc.me.prestige / 10),
  );
  const rep = hc.me.betrayals >= 2 ? 1 : 0;
  for (const minor of hc.state.minors) {
    if (minor.vassalOf !== null) continue;
    const reachable = minor.provinceIds.some((pid) =>
      neighborsOf(pid).some((nb) => myLocs.has(nb)),
    );
    if (!reachable) continue;
    const garrisonTier = Math.floor(minor.garrison / VASSAL.garrisonTierDivisor);
    const need = VASSAL.rollTarget - prestigeTier + garrisonTier + rep;
    const pPlain = Math.max(0, Math.min(6, 7 - need)) / 6;
    const pMarried = Math.max(0, Math.min(6, 7 - (need - VASSAL.marriageBribeBonus))) / 6;
    const bribe = VASSAL.bribeBase + VASSAL.bribePerGarrison * minor.garrison;
    const marriage =
      pMarried - pPlain >= 1 / 6 &&
      hc.me.treasury.gold >= bribe + VASSAL.marriageBribeGold + GOLD_RESERVE;
    const p = marriage ? pMarried : pPlain;
    const cost = bribe + (marriage ? VASSAL.marriageBribeGold : 0);
    if (p < 0.5 || hc.me.treasury.gold < cost + GOLD_RESERVE) continue;
    out.push({
      type: "VASSALIZE",
      player: hc.me.id,
      minorId: minor.id,
      ...(marriage ? { marriageBribe: true } : {}),
    });
  }
  return out;
}

function scoreVassalize(
  hc: HardCtx,
  action: Extract<GameAction, { type: "VASSALIZE" }>,
): number {
  const minor = hc.state.minors.find((m) => m.id === action.minorId);
  if (!minor) return 0.02;
  const prestigeTier = Math.min(VASSAL.prestigeTierCap, Math.floor(hc.me.prestige / 10));
  const garrisonTier = Math.floor(minor.garrison / VASSAL.garrisonTierDivisor);
  const mb = action.marriageBribe ? VASSAL.marriageBribeBonus : 0;
  const rep = hc.me.betrayals >= 2 ? 1 : 0;
  const need = VASSAL.rollTarget - prestigeTier + garrisonTier - mb + rep;
  const p = Math.max(0, Math.min(6, 7 - need)) / 6;
  return p * (VASSAL.prestigePerRound * hc.horizon + 1.5) * 0.7;
}

/** Justified DECLARE_WAR: Hungary's crusade window; claims on objective land. */
function declareWarActions(hc: HardCtx): GameAction[] {
  const out: GameAction[] = [];
  for (const rival of hc.state.players) {
    if (rival.id === hc.me.id || rival.faction === null) continue;
    if (hc.partners.has(rival.id) || hc.atWar.has(rival.id)) continue;
    // Only declare when an actual offensive is on the table: one of my stacks
    // adjacent to their ground with acceptable odds.
    const canPress = hc.state.armies.some((a) => {
      if (a.ownerId !== hc.me.id) return false;
      return neighborsOf(a.locationId).some((nb) => {
        const prov = hc.provinceById.get(nb);
        if (!prov || prov.ownerId !== rival.id) return false;
        if (prov.walls.hp > 0 && !siegePlan(hc, prov, a).feasible) return false;
        return stackAtk(a) >= 1.1 * defenceAt(hc, prov);
      });
    });
    if (!canPress) continue;
    if (rival.faction === Faction.OTTOMAN && hc.biases.crusadePreference >= 0.6) {
      out.push({
        type: "DECLARE_WAR",
        player: hc.me.id,
        target: rival.faction,
        justification: "crusade",
      });
    } else if (
      hc.biases.warAppetite >= 0.6 &&
      hc.me.objectives.some(
        (o) =>
          !o.completed &&
          [...(o.provinceRefs ?? []), ...(o.allOf ?? []), ...(o.anyOf ?? [])].some(
            (pid) => hc.provinceById.get(pid)?.ownerId === rival.id,
          ),
      )
    ) {
      // A genuine territorial claim: the rival squats on my objective land.
      out.push({
        type: "DECLARE_WAR",
        player: hc.me.id,
        target: rival.faction,
        justification: "claim",
      });
    }
  }
  return out;
}

/** Any pending proposal (either direction) between me and `otherId`? */
function proposalPending(hc: HardCtx, otherId: string): boolean {
  return proposalPendingBetween(hc.state, hc.me.id, otherId);
}

/**
 * Realized prestige pace → rounds until `player` crosses the §13.2
 * threshold (public scoreboard information only).
 */
function projectedRoundsToWin(hc: HardCtx, player: Player): number {
  const remaining = hc.threshold - player.prestige;
  if (remaining <= 0) return 0;
  const rate = player.prestige / Math.max(1, hc.state.round - 1);
  return remaining / Math.max(0.5, rate);
}

/**
 * Peace with `rival` locks in my loss: at realized pace they cross the
 * threshold clearly before I do, so a pact that forbids taking their
 * streams is just an escort to their victory.
 */
function peaceLocksMyLoss(hc: HardCtx, rival: Player): boolean {
  return projectedRoundsToWin(hc, rival) + 1 < projectedRoundsToWin(hc, hc.me);
}

/** Per-round §13.1 holding stream a player currently enjoys (approximate). */
function streamPerRound(hc: HardCtx, playerId: string): number {
  const player = hc.state.players.find((p) => p.id === playerId);
  let n = 0;
  for (const p of hc.state.provinces) {
    if (p.ownerId !== playerId) continue;
    if (p.isCapitalOf !== undefined) {
      n += p.isCapitalOf === player?.faction ? 1 : CONQUEST_PRESTIGE.holdEnemyCapitalPerRound;
    } else if ((p.highValue ?? 0) > 0) {
      n += 1;
    }
  }
  return n;
}

/**
 * Defensive NAP (realpolitik, Byzantium's oldest trick): when a rival force
 * looms over my stream provinces AND the PEACE RACE favours me (my per-round
 * §13.1 stream beats theirs), offer a non-aggression pact. If they accept,
 * the race is mine; if they decline or later betray (§11 penalties), nothing
 * is lost but the action. Also offered from plain mortal danger — peace now
 * beats a stormed capital.
 */
function napProposals(hc: HardCtx): GameAction[] {
  const out: GameAction[] = [];
  const myStream = streamPerRound(hc, hc.me.id);
  const myStreamProvinces = hc.state.provinces.filter(
    (p) => p.ownerId === hc.me.id && isStreamProvince(p),
  );
  if (myStreamProvinces.length === 0) return out;
  for (const rival of hc.state.players) {
    if (rival.id === hc.me.id) continue;
    // Renew a lapsing pact one round early (a NAP that expires mid-rush is
    // no pact at all); skip only partners whose cover still holds.
    if (hc.partners.has(rival.id) && !partnerCoverLapsing(hc, rival.id, 1)) continue;
    if (proposalPending(hc, rival.id)) continue;
    if (hc.atWar.has(rival.id)) continue; // an active war needs a war END, not a NAP
    if (peaceLocksMyLoss(hc, rival)) continue; // never escort them to victory
    // This rival's force within two steps of any stream province of mine.
    let looming = 0;
    let exposed = 0;
    for (const prov of myStreamProvinces) {
      const ring = new Set<string>();
      for (const nb of neighborsOf(prov.id)) {
        ring.add(nb);
        for (const nb2 of neighborsOf(nb)) ring.add(nb2);
      }
      let local = 0;
      for (const a of hc.state.armies) {
        if (a.ownerId === rival.id && ring.has(a.locationId)) local += stackAtk(a);
      }
      looming += local;
      if (local > myDefenceAt(hc, prov)) exposed += 1;
    }
    if (looming <= 0) continue;
    const raceFavoursMe = myStream >= streamPerRound(hc, rival.id) + 1;
    if (!raceFavoursMe && exposed === 0) continue;
    out.push({
      type: "DIPLOMACY",
      player: hc.me.id,
      diplomacy: {
        kind: "PROPOSE",
        treatyType: TreatyType.NAP,
        targetPlayerId: rival.id,
      },
    });
  }
  return out;
}

/**
 * Byzantium's signature bribe-over-war: when a much stronger neighbour looms
 * over a capital/key province, offer them TRIBUTE (proposer pays — §11)
 * rather than fight the odds. Gated on a high `tributePreference`.
 */
function tributeProposals(hc: HardCtx): GameAction[] {
  if (hc.biases.tributePreference < 0.65) return [];
  if (hc.me.treasury.gold < 2) return [];
  const out: GameAction[] = [];
  for (const rival of hc.state.players) {
    if (rival.id === hc.me.id) continue;
    if (hc.partners.has(rival.id) || proposalPending(hc, rival.id)) continue;
    let threat = 0;
    let defence = 0;
    for (const prov of hc.state.provinces) {
      if (prov.ownerId !== hc.me.id) continue;
      if (prov.isCapitalOf === undefined && (prov.highValue ?? 0) === 0) continue;
      const local = hc.state.armies
        .filter(
          (a) => a.ownerId === rival.id && neighborsOf(prov.id).includes(a.locationId),
        )
        .reduce((acc, a) => acc + stackAtk(a), 0);
      if (local > 0) {
        threat += local;
        defence += myDefenceAt(hc, prov);
      }
    }
    if (threat > 1.25 * Math.max(1, defence)) {
      out.push({
        type: "DIPLOMACY",
        player: hc.me.id,
        diplomacy: {
          kind: "PROPOSE",
          treatyType: TreatyType.TRIBUTE,
          targetPlayerId: rival.id,
          tribute: { gold: threat > 2 * Math.max(1, defence) ? 2 : 1 },
        },
      });
    }
  }
  return out;
}

/**
 * MERC_BID on the round's free companies (§6.3 — a FREE action, not budget
 * gated). A standing high bid fields the whole roster at the winner's
 * capital/city at cleanup for face value: at minBid that is by far the
 * cheapest muster in the game, and rival policies rarely contest the
 * auction. Gated on grain (mercs eat double, desert first — §4.4) unless a
 * stream province is in rush danger, when the company is emergency defence.
 * At most one raise per slot; once we stand as high bidder the offer is
 * skipped (and its gold is escrowed via reservedCommitments).
 */
function mercBids(hc: HardCtx): GameAction[] {
  if (hc.state.mercMarket.length === 0) return [];
  let upkeep = 0;
  for (const a of hc.state.armies) if (a.ownerId === hc.me.id) upkeep += unitCount(a);
  let grainYield = 0;
  for (const p of hc.state.provinces) {
    if (p.ownerId === hc.me.id) grainYield += p.yields.grain;
  }
  const emergency = hc.state.provinces.some(
    (p) =>
      p.ownerId === hc.me.id &&
      isStreamProvince(p) &&
      threatNear(hc, p.id) > myDefenceAt(hc, p),
  );
  // Where the engine would field a won company (mercenaries.ts
  // fieldLocation) is precomputed on the context; the auction does NOT
  // enforce the §3.2 stacking cap on fielding, so the bidder must keep the
  // room free — including for companies already bid on this round.
  if (hc.mercFieldLocId === null) return []; // a winning bid would just lapse
  const unitsAtField = myUnitsAt(hc, hc.mercFieldLocId);
  const out: GameAction[] = [];
  for (const offer of hc.state.mercMarket) {
    if (offer.sold || offer.highBidderId === hc.me.id) continue;
    const def = MERC_COMPANIES[offer.companyId];
    if (!def) continue;
    let heads = 0;
    for (const c of Object.values(def.roster)) heads += c ?? 0;
    for (const v of def.variants ?? []) heads += v.count;
    if (heads === 0) continue;
    if (unitsAtField + hc.mercReservedHeads + heads > STACKING.city) continue;
    const bid =
      offer.highBidderId === null
        ? def.minBid
        : offer.currentBid + MERC_MARKET.minBidRaise;
    if (bid > Math.ceil(heads * 2.5)) continue; // priced above troop value — walk away
    // hc.me.treasury is already net of escrowed commitments.
    if (hc.me.treasury.gold < bid + GOLD_RESERVE) continue;
    const grainOk = grainYield >= upkeep + 2 * heads;
    if (!emergency && !grainOk) continue;
    out.push({
      type: "MERC_BID",
      player: hc.me.id,
      companyId: offer.companyId,
      bid,
    });
    break; // one raise per slot
  }
  return out;
}

/**
 * RENOUNCE a NAP whose peace is escorting the partner to victory (§11: the
 * −2 break penalty is cheap against a rival streaming +5/round behind a
 * pact we may not touch). Alliances/marriages are kept — their break costs
 * −4 and their holders are usually not the runaway leader.
 */
function renounceActions(hc: HardCtx): GameAction[] {
  const out: GameAction[] = [];
  for (const t of hc.me.treaties) {
    if (t.expiresRound !== null && t.expiresRound < hc.state.round) continue;
    if (t.type !== TreatyType.NAP) continue;
    const otherId = t.parties.find((id) => id !== hc.me.id);
    const rival = hc.state.players.find((p) => p.id === otherId);
    if (!otherId || !rival) continue;
    if (!peaceLocksMyLoss(hc, rival)) continue;
    out.push({
      type: "DIPLOMACY",
      player: hc.me.id,
      diplomacy: {
        kind: "RENOUNCE",
        treatyType: t.type,
        targetPlayerId: otherId,
        treatyId: t.id,
      },
    });
  }
  return out;
}

/** LEVY_CALL for vassals off cooldown (free troops for one action). */
function levyCalls(hc: HardCtx): GameAction[] {
  const out: GameAction[] = [];
  for (const minor of hc.state.minors) {
    if (minor.vassalOf !== hc.me.id) continue;
    if ((minor.roundsUntilLevy ?? minor.levyCooldown ?? 0) > 0) continue;
    out.push({ type: "LEVY_CALL", player: hc.me.id, minorId: minor.id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Free actions — treaty ACCEPTs and tactic-card plays
// ---------------------------------------------------------------------------

/** Accept incoming proposals that read as favourable (ACCEPT is free). */
function acceptProposals(hc: HardCtx): GameAction[] {
  const out: GameAction[] = [];
  const myStrength = totalStrength(hc.state, hc.me.id);
  for (const proposal of pendingTreatyProposals(hc.state)) {
    if (proposal.accepterId !== hc.me.id) continue;
    const { proposerId, treatyType } = proposal;
    const proposer = hc.state.players.find((p) => p.id === proposerId);
    if (!proposer) continue;
    const theirStrength = totalStrength(hc.state, proposerId);
    let accept = false;
    if (treatyType === TreatyType.TRIBUTE) {
      accept = true; // they pay ME — and a live war ends in my favour (+3)
    } else if (treatyType === TreatyType.ROYAL_MARRIAGE) {
      accept = true; // +2 prestige/round stream
    } else if (treatyType === TreatyType.NAP) {
      // Decline when I am the hungry stronger side, and NEVER treaty-lock a
      // losing peace race: if their §13.1 stream clearly beats mine, war
      // (recapture) has to stay on the table.
      const hungry = hc.biases.warAppetite >= 0.7 && theirStrength < 0.6 * myStrength;
      const losingRace =
        streamPerRound(hc, proposerId) > streamPerRound(hc, hc.me.id) + 1 ||
        peaceLocksMyLoss(hc, proposer);
      accept = !hungry && !losingRace;
    } else if (treatyType === TreatyType.ALLIANCE) {
      const sharedEnemy = hc.state.wars.some(
        (w) =>
          (hc.atWar.has(w.a) && (w.a === proposerId || w.b === proposerId)) ||
          (hc.atWar.has(w.b) && (w.a === proposerId || w.b === proposerId)),
      );
      accept = sharedEnemy || theirStrength >= 0.9 * myStrength;
    }
    if (!accept) continue;
    out.push(acceptActionFor(proposal));
  }
  return out;
}

/** Fixed preference order for tactic slugs within a matching set. */
const TACTIC_PREFERENCE: readonly string[] = [
  "greek-fire",
  "master-founders-hired",
  "bribed-gatekeeper",
  "treason-at-the-gate",
  "condottieri-contract",
  "the-white-knights-stroke",
  "veterans-of-the-border",
  "pilot-of-the-narrows",
  "ladders-and-fascines",
  "locked-shields",
  "the-hexamilion-manned",
  "night-sortie",
  "sails-from-the-west",
];

/** Is this battle worth a card? Capital / HV(3)+ / siege / big committed stack. */
function battleLeverage(hc: HardCtx, battle: PendingBattle): boolean {
  if (battle.isSiege === true) return true;
  if (battle.provinceId) {
    const prov = hc.provinceById.get(battle.provinceId);
    if (prov && (prov.isCapitalOf !== undefined || (prov.highValue ?? 0) >= 3)) return true;
  }
  const mineIds = new Set(
    battle.attackerId === hc.me.id ? battle.attackerStackIds : battle.defenderStackIds,
  );
  let committed = 0;
  for (const s of [...hc.state.armies, ...hc.state.fleets]) {
    if (mineIds.has(s.id)) committed += unitCount(s);
  }
  return committed >= TACTIC_STAKE_UNITS;
}

/** PLAY_TACTIC candidates for high-leverage pending battles (free actions). */
function tacticPlays(hc: HardCtx): GameAction[] {
  const hand = hc.me.tacticHand ?? [];
  if (hand.length === 0) return [];
  const out: GameAction[] = [];
  for (const battle of hc.state.pendingBattles) {
    const side =
      battle.attackerId === hc.me.id
        ? "attacker"
        : battle.defenderId === hc.me.id
          ? "defender"
          : null;
    if (!side) continue;
    if (!battleLeverage(hc, battle)) continue;
    const queued = side === "attacker" ? battle.attackerTactics : battle.defenderTactics;
    if ((queued?.length ?? 0) > 0) continue; // §7.7 one per side per round

    const matches: TacticCardId[] = [];
    const seen = new Set<string>();
    for (const cardId of hand) {
      if (seen.has(cardId)) continue;
      seen.add(cardId);
      const card = TACTIC_CARD_BY_ID[cardId];
      if (!card) continue;
      const data = (card.data ?? {}) as { side?: string; domain?: string; costGold?: number };
      if (data.side !== undefined && data.side !== side) continue;
      // hc.me.treasury is already net of costs escrowed for previously
      // queued tactics (see reservedTacticCosts) — keep a 1-gold margin.
      if ((data.costGold ?? 0) > hc.me.treasury.gold - 1) continue;
      if (((data as { costFaith?: number }).costFaith ?? 0) > hc.me.treasury.faith) continue;
      const isSiegeBattle = battle.isSiege === true;
      const isNaval = battle.isNaval === true;
      if (isSiegeBattle) {
        if (card.timing !== "assault" && card.timing !== "siege") continue;
        // Treason needs its double gate (§7.7 delta 1) — skip implausible plays.
        if (cardId === "treason-at-the-gate") {
          const prov = battle.provinceId ? hc.provinceById.get(battle.provinceId) : undefined;
          const siege = prov?.siege;
          const besieged = siege?.roundsBesieged ?? siege?.roundsElapsed ?? 0;
          if (!prov || (prov.garrison ?? 0) > 4 || besieged < 2) continue;
        }
      } else if (isNaval) {
        if (card.timing !== "battle" || (data.domain !== undefined && data.domain !== "fleet")) {
          continue;
        }
      } else {
        if (card.timing !== "battle") continue;
        if (data.domain !== undefined && data.domain !== "land" && data.domain !== "any") continue;
        // The Hexamilion helps only an unwalled defender.
        if (cardId === "the-hexamilion-manned") {
          const prov = battle.provinceId ? hc.provinceById.get(battle.provinceId) : undefined;
          if (!prov || prov.walls.hp > 0) continue;
        }
      }
      matches.push(cardId);
    }
    matches.sort((a, b) => {
      const ia = TACTIC_PREFERENCE.indexOf(a);
      const ib = TACTIC_PREFERENCE.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    for (const cardId of matches.slice(0, 1)) {
      out.push({ type: "PLAY_TACTIC", player: hc.me.id, battleId: battle.id, cardId });
    }
    if (out.length >= 2) break; // bounded free plays per slot
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context assembly + the policy
// ---------------------------------------------------------------------------

/**
 * Gold/faith already committed but not yet charged by the engine:
 *   - tactics QUEUED on pending battles — the engine charges a tactic's
 *     printed cost at COMBAT resolution, not at PLAY_TACTIC time
 *     (engine/tactics.ts payCost), and THROWS if the purse fell short;
 *   - standing high MERC bids — the winning bid is paid at the market
 *     refresh (engine/mercenaries.ts fieldCompany); an unaffordable winner
 *     just loses the company, wasting the bid.
 * The policy escrows both by shrinking its EFFECTIVE treasury before any
 * candidate generation/scoring.
 */
function reservedCommitments(
  state: Readonly<GameState>,
  meId: string,
): { gold: number; faith: number } {
  let gold = 0;
  let faith = 0;
  for (const battle of state.pendingBattles) {
    const queued =
      battle.attackerId === meId
        ? battle.attackerTactics
        : battle.defenderId === meId
          ? battle.defenderTactics
          : undefined;
    for (const cardId of queued ?? []) {
      const data = (TACTIC_CARD_BY_ID[cardId]?.data ?? {}) as {
        costGold?: number;
        costFaith?: number;
      };
      gold += data.costGold ?? 0;
      faith += data.costFaith ?? 0;
    }
  }
  for (const offer of state.mercMarket) {
    if (!offer.sold && offer.highBidderId === meId) gold += offer.currentBid;
  }
  return { gold, faith };
}

function buildContext(ctx: PolicyContext, realMe: Player): HardCtx {
  const { state } = ctx;
  // Escrow queued tactic costs: every affordability check below (including
  // the shared candidate generators, which pre-filter on `me.treasury`) sees
  // the treasury MINUS what combat resolution will charge for queued cards.
  const reserved = reservedCommitments(state, realMe.id);
  const me: Player =
    reserved.gold === 0 && reserved.faith === 0
      ? realMe
      : {
          ...realMe,
          treasury: {
            ...realMe.treasury,
            gold: Math.max(0, realMe.treasury.gold - reserved.gold),
            faith: Math.max(0, realMe.treasury.faith - reserved.faith),
          },
        };
  const biases = ctx.persona?.biases ?? DEFAULT_BIASES;
  const partners = new Set<string>();
  const partnerExpiry = new Map<string, number | null>();
  for (const t of me.treaties) {
    if (t.expiresRound !== null && t.expiresRound < state.round) continue;
    for (const id of t.parties) {
      if (id === me.id) continue;
      partners.add(id);
      // Protection lasts until the LAST live treaty lapses (null = forever).
      const prev = partnerExpiry.get(id);
      if (prev === null) continue;
      if (t.expiresRound === null) partnerExpiry.set(id, null);
      else partnerExpiry.set(id, Math.max(prev ?? 0, t.expiresRound));
    }
  }
  const atWar = new Set<string>();
  for (const w of state.wars) {
    if (w.a === me.id) atWar.add(w.b);
    if (w.b === me.id) atWar.add(w.a);
  }
  const provinceById = new Map(state.provinces.map((p) => [p.id, p]));
  const seaZoneIds = new Set(state.seaZones.map((z) => z.id));
  const myProvinceIds = new Set(
    state.provinces.filter((p) => p.ownerId === me.id).map((p) => p.id),
  );
  const mySiegeTargets = new Set<string>();
  for (const s of state.siegeStates) {
    if (s.besiegerId === me.id) mySiegeTargets.add(s.provinceId);
  }
  for (const b of state.pendingBattles) {
    if (b.attackerId === me.id && b.isSiege === true && b.provinceId) {
      mySiegeTargets.add(b.provinceId);
    }
  }
  let prestigeLeader: Player | null = null;
  for (const p of state.players) {
    if (p.id === me.id) continue;
    if (!prestigeLeader || p.prestige > prestigeLeader.prestige) prestigeLeader = p;
  }
  const threshold = PRESTIGE_THRESHOLDS[state.players.length] ?? 35;

  const hc: HardCtx = {
    state,
    me,
    biases,
    difficulty: ctx.difficulty,
    horizon: Math.max(1, Math.min(HOLD_HORIZON, ROUNDS - state.round + 1)),
    partners,
    partnerExpiry,
    atWar,
    provinceById,
    seaZoneIds,
    myProvinceIds,
    mySiegeTargets,
    prestigeLeader,
    threshold,
    siegeNeed: false,
    navalNeed: false,
    wantsMarble: false,
    mercReservedHeads: 0,
    mercFieldLocId: null,
  };

  // Merc-auction stack-space escrow (see the HardCtx field docs).
  const fieldLoc =
    state.provinces.find(
      (p) => p.ownerId === me.id && p.isCapitalOf === me.faction,
    ) ?? state.provinces.find((p) => p.ownerId === me.id && p.terrain === TerrainType.CITY);
  hc.mercFieldLocId = fieldLoc?.id ?? null;
  for (const offer of state.mercMarket) {
    if (offer.sold || offer.highBidderId !== me.id) continue;
    const def = MERC_COMPANIES[offer.companyId];
    if (!def) continue;
    for (const c of Object.values(def.roster)) hc.mercReservedHeads += c ?? 0;
    for (const v of def.variants ?? []) hc.mercReservedHeads += v.count;
  }

  // Siege ambitions: an adjacent walled prestige target (or the obsession, from
  // Era II so the train is ready when Era III opens) with a thin siege train.
  let train = 0;
  for (const a of state.armies) if (a.ownerId === me.id) train += siegeUnitsIn(a);
  const wantsSiege =
    (biases.constantinopleObsession && ctx.difficulty === Difficulty.HARD && state.era >= 2) ||
    state.provinces.some(
      (p) =>
        p.ownerId !== me.id &&
        p.ownerId !== null &&
        !partners.has(p.ownerId) &&
        p.walls.tier >= 1 &&
        (p.isCapitalOf !== undefined || (p.highValue ?? 0) > 0) &&
        neighborsOf(p.id).some((nb) => myProvinceIds.has(nb)),
    );
  hc.siegeNeed = wantsSiege && train < 3;

  // Naval needs: an uncovered supply zone of a city I besiege, or enemy war
  // fleets inside a sea I monopolise.
  let navalNeed = false;
  for (const target of mySiegeTargets) {
    const prov = provinceById.get(target);
    if (!prov?.coastal) continue;
    const zones = neighborsOf(target).filter((z) => seaZoneIds.has(z));
    if (zones.some((z) => warFleetUnitsIn(state, z, me.id) === 0)) navalNeed = true;
  }
  if (!navalNeed && monopolyCount(hc, me.id) > 0) {
    navalNeed = state.fleets.some(
      (f) =>
        f.ownerId !== me.id &&
        !partners.has(f.ownerId) &&
        seaZoneIds.has(f.locationId) &&
        neighborsOf(f.locationId).some((nb) => {
          const p = provinceById.get(nb);
          return p?.coastal === true && p.ownerId === me.id;
        }),
    );
  }
  hc.navalNeed = navalNeed;

  hc.wantsMarble =
    me.treasury.marble < 4 &&
    Object.values(GreatWorkType).some((t) => {
      const def = GREAT_WORK_COSTS[t];
      return (def.cost.marble ?? 0) > me.treasury.marble;
    });

  return hc;
}

export const hardPolicy: Policy = {
  name: "hard-prestige",
  chooseAction(ctx: PolicyContext): readonly GameAction[] {
    const me = ctx.state.players.find((p) => p.id === ctx.botPlayerId);
    if (!me || me.actionsRemaining <= 0) return [];
    const hc = buildContext(ctx, me);

    // Free, bounded plays first: favourable ACCEPTs, then tactic cards at
    // high-leverage combats. Each is consumed by the engine once accepted, so
    // they never repeat across slots.
    const free: GameAction[] = [
      ...acceptProposals(hc),
      ...tacticPlays(hc),
      ...mercBids(hc),
    ];

    // Budgeted pool: the shared plausible candidates plus the HARD-specific
    // prestige-line generators. Treaty partners are never attacked.
    const pool: GameAction[] = [
      // NOTE: generators receive hc.me — the treasury there is net of gold/
      // faith escrowed for tactics already queued on pending battles, so no
      // candidate can spend money that combat resolution will charge.
      ...moveCandidates(ctx.state, hc.me).filter((a) => {
        if (a.type !== "MOVE") return true;
        const dest = hc.provinceById.get(a.toId);
        if (dest?.ownerId && dest.ownerId !== me.id && hc.partners.has(dest.ownerId)) {
          return false;
        }
        const stacks: readonly (Army | Fleet)[] =
          a.naval === true ? ctx.state.fleets : ctx.state.armies;
        return !stacks.some(
          (s) => s.locationId === a.toId && s.ownerId !== me.id && hc.partners.has(s.ownerId),
        );
      }),
      ...recruitCandidates(ctx.state, hc.me),
      ...warMachineRecruits(hc),
      ...buildCandidates(ctx.state, hc.me),
      ...greatWorkBuilds(hc),
      ...tradeRouteActions(hc),
      ...convertCandidates(ctx.state, hc.me),
      ...spyActions(hc),
      ...vassalizeActions(hc),
      ...declareWarActions(hc),
      ...napProposals(hc),
      ...renounceActions(hc),
      ...tributeProposals(hc),
      ...levyCalls(hc),
    ];

    // One seeded shuffle = the deterministic tie-break under the stable sort.
    const ranked = ctx.rng
      .shuffle(pool)
      .map((action) => ({ action, score: scoreAction(hc, action) }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.action);

    return [...free, ...ranked.slice(0, CANDIDATE_SLICE)];
  },
};
