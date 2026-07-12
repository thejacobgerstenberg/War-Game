/**
 * NORMAL policy — the sim's "opportunist" archetype (see sim/src/agents.ts on
 * feature/balance-sim), adapted to the ranked-candidate Policy contract.
 *
 * Heuristics, in the order they shape a slot's ranked slate:
 *   - expansion vs economy balance: a military weight rises with the round/era
 *     (and with threat pressure), an economy weight declines against it;
 *   - opportunistic attacks: MOVE into an adjacent enemy/neutral province only
 *     when the local force ratio clears an odds gate (persona `warAppetite`
 *     lowers the gate; weak neutrals get a discount, crusade targets a small
 *     one via `crusadePreference`);
 *   - defence of threatened high-value provinces: reinforcing MOVEs, garrison
 *     RECRUITs and WALLS builds, scaled by persona `defensiveness`. Threat and
 *     holding power are UNIT-based: walls and terrain only count where units
 *     or a garrison actually stand — a MOVE into undefended ground is an
 *     unopposed occupation (§7 / actions.ts), however high the walls. The own
 *     capital and key cities are HOME-ANCHORED against rival forces within
 *     two steps (losing the capital starts the §13.3 sudden-death clock), and
 *     retaking an enemy-held own capital gets a relaxed odds gate plus a large
 *     urgency bonus for the same reason;
 *   - treaty honour: ally (ALLIANCE) territory is never attacked directly —
 *     at most a DIPLOMACY RENOUNCE is offered when a capital-grade prize is
 *     exposed AND the prestige-adjusted payoff beats the −4 betrayal cost;
 *     NAP / ROYAL_MARRIAGE partners are attacked only under the same
 *     capital-grade + payoff test (persona `tributePreference` raises the
 *     required margin);
 *   - market smoothing: TRADE/CONVERT out of a surplus resource into a scarce
 *     one, probing the 2:1 market ratio first with a 3:1 base-ratio fallback;
 *   - great works: continue any in-progress work first (free), and start a new
 *     one from round {@link GREAT_WORK_START_ROUND} when the treasury keeps a
 *     gold reserve after paying.
 *
 * Persona biases are applied at MODERATE strength ({@link PERSONA_STRENGTH}):
 * every bias is pulled halfway toward the 0.5 neutral point before use, and
 * the HARD-only `constantinopleObsession` flag is ignored entirely.
 *
 * Fair play: reads only table-public state (map, stacks, treaties, prestige,
 * walls, garrisons) plus the bot's OWN treasury and OWN secret objectives —
 * never a rival's hand, objectives or deck order. Determinism: the only
 * randomness is a small ranking jitter drawn from the provided BotRng.
 * Every candidate is a BUDGETED action type, so the driver's spend-down loop
 * always terminates.
 */
import {
  BuildingType,
  Faction,
  GreatWorkType,
  TerrainType,
  TreatyType,
  UnitType,
  type Army,
  type GameAction,
  type GameState,
  type Player,
  type Province,
} from "@imperium/shared";
import { neighborsOf } from "../../engine/adjacency.js";
import { sumModifierValues } from "../../engine/modifiers.js";
import { recruitBustsStackLimit } from "./candidates.js";
import {
  BUILDING_COSTS,
  CONQUEST_PRESTIGE,
  GREAT_WORK_COSTS,
  PRESTIGE_THRESHOLDS,
  PRESTIGE_VALUES,
  ROUNDS,
  STACKING,
  TERRAIN_DEF_MOD,
  TERRAIN_MOVE_COST,
  UNIQUE_UNIT_OVERRIDES,
  UNIT_STATS,
  WALL_TIERS,
} from "../../engine/balance.js";
import type { Policy, PolicyContext } from "../types.js";
import type { FactionPersona } from "../personality.js";

/** How many ranked candidates to offer the driver per action slot. */
const CANDIDATE_SLICE = 12;

/** Moderate persona strength: biases are pulled halfway toward neutral. */
const PERSONA_STRENGTH = 0.5;

/** Gold that must remain in the treasury after starting a great work. */
const GREAT_WORK_GOLD_RESERVE = 6;

/** Earliest round to start a NEW great work (continuations are always on). */
const GREAT_WORK_START_ROUND = 6;

/** Treasury level at/below which a tradeable resource counts as scarce. */
const SCARCE_AT = 1;

/** Treasury level at/above which a tradeable resource counts as surplus. */
const SURPLUS_AT = 6;

/** Grain buffer required before non-urgent recruiting (solvency guard). */
const RECRUIT_GRAIN_FLOOR = 3;

/** Deterministic ranking jitter drawn from the bot RNG per candidate. */
const JITTER = 0.3;

const RESOURCE_KEYS = ["gold", "grain", "timber", "marble", "faith"] as const;
type ResKey = (typeof RESOURCE_KEYS)[number];
const TRADEABLE: readonly ResKey[] = ["gold", "grain", "timber", "marble"];

/** Persona knobs after moderation (all pulled toward 0.5 by PERSONA_STRENGTH). */
interface ModeratedBiases {
  warAppetite: number;
  tributePreference: number;
  tradeFocus: number;
  defensiveness: number;
  crusadePreference: number;
}

function moderatedBiases(persona?: FactionPersona): ModeratedBiases {
  const soften = (x: number | undefined): number =>
    x === undefined ? 0.5 : 0.5 + (x - 0.5) * PERSONA_STRENGTH;
  const b = persona?.biases;
  return {
    warAppetite: soften(b?.warAppetite),
    tributePreference: soften(b?.tributePreference),
    tradeFocus: soften(b?.tradeFocus),
    defensiveness: soften(b?.defensiveness),
    crusadePreference: soften(b?.crusadePreference),
  };
}

// ---------------------------------------------------------------------------
// Force estimation (public info: stacks, garrisons, walls, terrain)
// ---------------------------------------------------------------------------

function stackAttackPower(stack: Army): number {
  let power = 0;
  for (const t of Object.values(UnitType)) {
    power += (stack.units[t] ?? 0) * UNIT_STATS[t].atk;
  }
  for (const v of stack.variants ?? []) {
    const def = UNIQUE_UNIT_OVERRIDES[v.variant];
    power += v.count * Math.max(0, UNIT_STATS[v.base].atk + (def?.atkMod ?? 0));
  }
  return power;
}

function stackDefensePower(stack: Army): number {
  let power = 0;
  for (const t of Object.values(UnitType)) {
    power += (stack.units[t] ?? 0) * UNIT_STATS[t].def;
  }
  for (const v of stack.variants ?? []) {
    const def = UNIQUE_UNIT_OVERRIDES[v.variant];
    power += v.count * Math.max(0, UNIT_STATS[v.base].def + (def?.defMod ?? 0));
  }
  return power;
}

function stackSize(stack: Army): number {
  let n = 0;
  for (const t of Object.values(UnitType)) n += stack.units[t] ?? 0;
  for (const v of stack.variants ?? []) n += v.count;
  return n;
}

/**
 * Would landing `army` on `dest` bust the §3.2 per-player stacking limit
 * (8 land / 12 city)? Pre-filtered so ranked slates never end as a run of
 * STACK_LIMIT probe rejections (the driver would log a fallback pass).
 */
function bustsStackLimit(
  state: Readonly<GameState>,
  army: Army,
  dest: Province,
): boolean {
  const limit =
    dest.terrain === TerrainType.CITY || dest.isCapitalOf !== undefined
      ? STACKING.city
      : STACKING.land;
  let count = stackSize(army);
  for (const a of state.armies) {
    if (a.ownerId !== army.ownerId || a.id === army.id) continue;
    if (a.locationId === dest.id) count += stackSize(a);
  }
  return count > limit;
}

/** Slowest-unit move allowance (mirrors the reducer's §3.1 reading). */
function movePoints(stack: Army): number {
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

/**
 * Static defence of a province against ME: hostile stacks + garrison, with
 * walls and terrain counted ONLY where someone actually stands. A province
 * with no defending units and no garrison is occupied UNOPPOSED (§7 —
 * `actions.ts` only queues a battle/siege when units or a garrison defend),
 * so empty walls must not inflate the odds gate.
 */
function defensePowerAt(state: Readonly<GameState>, prov: Province, myId: string): number {
  let units = 0;
  for (const army of state.armies) {
    if (army.locationId !== prov.id || army.ownerId === myId) continue;
    units += stackDefensePower(army);
  }
  return mannedPower(prov, units, prov.garrison ?? 0);
}

/**
 * Holding power of a province manned by `units` defence plus `garrison`:
 * walls and terrain multiply a standing defence, but an UNMANNED province
 * (no units, no garrison) is a walk-in whatever the walls (§7).
 */
function mannedPower(prov: Province, units: number, garrison: number): number {
  if (units + garrison <= 0) return 0;
  let power = units + garrison + TERRAIN_DEF_MOD[prov.terrain];
  if (prov.walls.hp > 0) power += WALL_TIERS[prov.walls.tier]?.defBonus ?? 0;
  return power;
}

/**
 * My own HOLDING power in a province: stacks + garrison, plus walls/terrain
 * only while units or a garrison man them (same §7 reading as
 * {@link defensePowerAt} — an emptied walled city is a walk-in for a rival).
 */
function myDefenseAt(state: Readonly<GameState>, prov: Province, myId: string): number {
  let units = 0;
  for (const army of state.armies) {
    if (army.locationId !== prov.id || army.ownerId !== myId) continue;
    units += stackDefensePower(army);
  }
  return mannedPower(prov, units, prov.garrison ?? 0);
}

/** Largest hostile attack force in any single adjacent province. */
function threatAt(
  state: Readonly<GameState>,
  provId: string,
  myId: string,
  allies: ReadonlySet<string>,
): number {
  let worst = 0;
  for (const nb of neighborsOf(provId)) {
    let local = 0;
    for (const army of state.armies) {
      if (army.locationId !== nb) continue;
      if (army.ownerId === myId || allies.has(army.ownerId)) continue;
      local += stackAttackPower(army);
    }
    worst = Math.max(worst, local);
  }
  return worst;
}

/**
 * Rival PLAYER attack strength within TWO steps of a province — the rush
 * warning for home-anchored ground (a stack that marches out this round can
 * be punished by anything two steps away next round). Minor garrisons sit
 * still and never march on a capital, so only seated players count.
 */
function threatNear(
  state: Readonly<GameState>,
  provId: string,
  myId: string,
  allies: ReadonlySet<string>,
): number {
  const ring = new Set<string>();
  for (const nb of neighborsOf(provId)) {
    ring.add(nb);
    for (const nb2 of neighborsOf(nb)) ring.add(nb2);
  }
  ring.delete(provId);
  const playerIds = new Set(state.players.map((p) => p.id));
  let total = 0;
  for (const army of state.armies) {
    if (army.ownerId === myId || allies.has(army.ownerId)) continue;
    if (!playerIds.has(army.ownerId)) continue;
    if (ring.has(army.locationId)) total += stackAttackPower(army);
  }
  return total;
}

/** Ground whose loss bleeds a holding stream (own capital / key city). */
function isHomeAnchor(prov: Province, myFaction: Faction | null): boolean {
  return prov.isCapitalOf === myFaction || (prov.highValue ?? 0) >= 3;
}

// ---------------------------------------------------------------------------
// Treaties, value and prizes (public info)
// ---------------------------------------------------------------------------

/** The strongest live treaty binding me to `otherId` (ALLIANCE > marriage > NAP). */
function bindingTreatyWith(
  me: Player,
  otherId: string,
  round: number,
): { type: TreatyType; id: string } | null {
  const live = me.treaties.filter(
    (t) =>
      t.parties.includes(me.id) &&
      t.parties.includes(otherId) &&
      (t.expiresRound === null || t.expiresRound === undefined || t.expiresRound >= round),
  );
  const order = [TreatyType.ALLIANCE, TreatyType.ROYAL_MARRIAGE, TreatyType.NAP];
  for (const type of order) {
    const found = live.find((t) => t.type === type);
    if (found) return { type, id: found.id };
  }
  return null;
}

/** Ids of players I hold a live ALLIANCE with (their stacks are not threats). */
function allyIds(me: Player, round: number): Set<string> {
  const out = new Set<string>();
  for (const t of me.treaties) {
    if (t.type !== TreatyType.ALLIANCE) continue;
    if (t.expiresRound !== null && t.expiresRound !== undefined && t.expiresRound < round) continue;
    for (const p of t.parties) if (p !== me.id) out.add(p);
  }
  return out;
}

/** Board value of grabbing/holding a province (objective provinces boosted). */
function provinceValue(prov: Province, objectiveIds: ReadonlySet<string>): number {
  const y = prov.yields;
  let v = y.gold + 0.5 * y.grain + 0.3 * (y.timber + y.marble + y.faith);
  v += 2 * (prov.highValue ?? 0);
  if (prov.isCapitalOf !== undefined) v += 6;
  if (objectiveIds.has(prov.id)) v += 8;
  return v;
}

/** A prize worth breaking a treaty over: a capital or a top key city. */
function isCapitalGradePrize(prov: Province): boolean {
  return prov.isCapitalOf !== undefined || (prov.highValue ?? 0) >= 4;
}

/**
 * Prestige-adjusted betrayal payoff: expected conquest prestige of the prize,
 * scaled up as I close on the victory threshold, minus the §11 break penalty
 * and a persona margin (`tributePreference` — buy-them-off factions demand a
 * larger surplus before turning their coat). Positive ⇒ betrayal is on.
 */
function betrayalPayoff(
  state: Readonly<GameState>,
  me: Player,
  prov: Province,
  treatyType: TreatyType,
  biases: ModeratedBiases,
): number {
  let prize = 0;
  if (prov.walls.tier >= 1) {
    prize +=
      prov.walls.tier >= 4
        ? CONQUEST_PRESTIGE.takeWalledCityHighTier
        : CONQUEST_PRESTIGE.takeWalledCity;
  }
  if (prov.isCapitalOf !== undefined) prize += CONQUEST_PRESTIGE.holdEnemyCapitalPerRound;
  else if ((prov.highValue ?? 0) >= 3) prize += PRESTIGE_VALUES.holdKeyCityPerRound;

  const threshold = PRESTIGE_THRESHOLDS[state.players.length] ?? 76;
  const closeness = Math.min(1, Math.max(0, me.prestige / threshold));
  prize *= 1 + 0.5 * closeness;

  const penalty =
    treatyType === TreatyType.NAP
      ? -PRESTIGE_VALUES.betrayNap
      : -PRESTIGE_VALUES.betrayAlliance;
  const margin = 1 + 3 * biases.tributePreference;
  return prize - penalty - margin;
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

interface Scored {
  action: GameAction;
  score: number;
}

function canAfford(me: Player, cost: Partial<Record<ResKey, number>>): boolean {
  return RESOURCE_KEYS.every((k) => me.treasury[k] >= (cost[k] ?? 0));
}

/** Best affordable single unit for a role; null when nothing is affordable. */
function pickUnit(me: Player, order: readonly UnitType[]): UnitType | null {
  for (const t of order) {
    if (canAfford(me, UNIT_STATS[t].cost)) return t;
  }
  return null;
}

export const normalPolicy: Policy = {
  name: "normal-opportunist",
  chooseAction(ctx: PolicyContext): readonly GameAction[] {
    const { state } = ctx;
    const me = state.players.find((p) => p.id === ctx.botPlayerId);
    if (!me || me.actionsRemaining <= 0) return [];

    const biases = moderatedBiases(ctx.persona);
    const allies = allyIds(me, state.round);
    const provinceById = new Map(state.provinces.map((p) => [p.id, p]));

    // My own secret objectives are mine to read (fair-play contract).
    const objectiveIds = new Set<string>();
    for (const obj of me.objectives) {
      if (obj.completed) continue;
      for (const id of [...obj.provinceRefs, ...(obj.allOf ?? []), ...(obj.anyOf ?? [])]) {
        objectiveIds.add(id);
      }
    }

    const myFaction = me.faction ?? null;
    const mine = state.provinces.filter((p) => p.ownerId === me.id);
    const threat = new Map<string, number>();
    for (const prov of mine) {
      let t = threatAt(state, prov.id, me.id, allies);
      // Home ground watches TWO steps out: a rush must be met before it is
      // adjacent — the §13.3 sudden-death clock leaves no catch-up round for
      // the capital, and a key city gifts its holding stream when it flips.
      if (isHomeAnchor(prov, myFaction)) {
        const near = threatNear(state, prov.id, me.id, allies);
        t = Math.max(t, prov.isCapitalOf === myFaction ? near : 0.6 * near);
      }
      threat.set(prov.id, t);
    }
    const isThreatened = (prov: Province): boolean =>
      (threat.get(prov.id) ?? 0) > myDefenseAt(state, prov, me.id) * 0.9 &&
      (threat.get(prov.id) ?? 0) > 0;
    const threatenedIds = new Set(mine.filter(isThreatened).map((p) => p.id));

    // Round/era balance of army strength vs income growth. Threat to a
    // capital-grade holding pulls the weight toward the military side.
    const underPressure = mine.some(
      (p) =>
        threatenedIds.has(p.id) &&
        (p.isCapitalOf === me.faction || (p.highValue ?? 0) >= 3),
    );
    const progress = (state.round - 1) / (ROUNDS - 1);
    const military = Math.min(
      1,
      Math.max(
        0,
        0.3 + 0.45 * progress + 0.5 * (biases.warAppetite - 0.5) + (underPressure ? 0.15 : 0),
      ),
    );
    const economy = 1.15 - 0.6 * military;

    const out: Scored[] = [];
    const renouncedOwners = new Set<string>();

    // ---- MOVE: opportunistic attacks, expansion, and reinforcement --------
    for (const army of state.armies) {
      if (army.ownerId !== me.id || stackSize(army) === 0) continue;
      const from = provinceById.get(army.locationId);
      const mp = movePoints(army);
      if (mp <= 0) continue;
      const attack = stackAttackPower(army);
      // HOME ANCHOR: never march the defence out of the own capital / a key
      // city that a rival force within two steps could then overrun — an
      // emptied walled city is a walk-in (§7), and a fallen capital starts
      // the sudden-death clock. The ground must keep at least 60% of the
      // nearby rival strength after this stack departs. An anchored stack
      // holds — its ONE licence to move is the SALLY below: an odds-gated
      // strike on an adjacent province hosting the armies that pin it (a
      // frozen garrison otherwise watches its hinterland eaten piecemeal).
      let anchored = false;
      if (from !== undefined && from.ownerId === me.id && isHomeAnchor(from, myFaction)) {
        let unitsLeft = 0;
        for (const other of state.armies) {
          if (other.ownerId !== me.id || other.id === army.id) continue;
          if (other.locationId === from.id) unitsLeft += stackDefensePower(other);
        }
        const remaining = mannedPower(from, unitsLeft, from.garrison ?? 0);
        anchored = remaining < 0.6 * (threat.get(from.id) ?? 0);
      }

      for (const nb of neighborsOf(army.locationId)) {
        const dest = provinceById.get(nb);
        if (!dest) continue; // sea zones: NORMAL keeps its fleets home
        if (TERRAIN_MOVE_COST[dest.terrain] > mp) continue;
        if (bustsStackLimit(state, army, dest)) continue;
        if (anchored) {
          // Sally only: the destination must host a rival army that is part
          // of the pressure on this anchor. Everything else stays home.
          const hostsThreat = state.armies.some(
            (a) =>
              a.locationId === dest.id &&
              a.ownerId !== me.id &&
              !allies.has(a.ownerId) &&
              stackSize(a) > 0,
          );
          if (!hostsThreat) continue;
        }

        if (dest.ownerId === me.id) {
          // Reinforce a threatened own province from a calmer one. "Already
          // safe" guard: once the destination out-defends its threat, stop —
          // otherwise two stacks ping-pong between a covered pair of home
          // provinces and burn the whole budget shuttling.
          if (
            from !== undefined &&
            threatenedIds.has(dest.id) &&
            !threatenedIds.has(from.id) &&
            myDefenseAt(state, dest, me.id) < (threat.get(dest.id) ?? 0)
          ) {
            const score =
              (4 + 0.5 * provinceValue(dest, objectiveIds) + 0.3 * (threat.get(dest.id) ?? 0)) *
              (0.5 + biases.defensiveness);
            out.push({
              action: { type: "MOVE", player: me.id, stackId: army.id, toId: dest.id },
              score,
            });
          }
          continue;
        }

        const ownerId = dest.ownerId;
        const treaty = ownerId ? bindingTreatyWith(me, ownerId, state.round) : null;

        // ALLIANCE: never walk into ally land (the engine treats it as friendly
        // ground anyway). At most, offer a RENOUNCE when a capital-grade prize
        // is exposed and the prestige-adjusted payoff clears the −4.
        if (treaty?.type === TreatyType.ALLIANCE) {
          if (
            ownerId !== null &&
            !renouncedOwners.has(ownerId) &&
            isCapitalGradePrize(dest) &&
            attack >= defensePowerAt(state, dest, me.id) * 1.6
          ) {
            const payoff = betrayalPayoff(state, me, dest, treaty.type, biases);
            if (payoff > 0) {
              renouncedOwners.add(ownerId);
              out.push({
                action: {
                  type: "DIPLOMACY",
                  player: me.id,
                  diplomacy: {
                    kind: "RENOUNCE",
                    treatyType: TreatyType.ALLIANCE,
                    targetPlayerId: ownerId,
                    treatyId: treaty.id,
                  },
                },
                score: (3 + payoff) * (0.4 + 0.9 * military),
              });
            }
          }
          continue;
        }

        const defense = Math.max(1, defensePowerAt(state, dest, me.id));
        const ratio = attack / defense;
        const ownerFaction = ownerId
          ? state.players.find((p) => p.id === ownerId)?.faction
          : undefined;
        let needed = 1.7 - 0.8 * biases.warAppetite;
        if (ownerId === null || dest.minorId !== undefined) needed *= 0.85; // weak neutrals
        if (ownerFaction === Faction.OTTOMAN) {
          needed *= 1 - 0.2 * Math.max(0, biases.crusadePreference - 0.5); // crusade window
        }
        // Retaking the OWN capital races the §13.3 sudden-death clock (two
        // enemy cleanups lose the game outright): accept worse odds and rank
        // the counter-attack above any opportunistic grab.
        const retakesMyCapital = dest.isCapitalOf === myFaction;
        if (retakesMyCapital) needed *= 0.65;

        // NAP / ROYAL_MARRIAGE: honoured unless a capital-grade prize is
        // exposed and the prestige-adjusted payoff is positive; betrayals also
        // demand stiffer odds.
        if (treaty !== null) {
          if (!isCapitalGradePrize(dest)) continue;
          if (betrayalPayoff(state, me, dest, treaty.type, biases) <= 0) continue;
          needed *= 1.25;
        }

        if (ratio < needed) continue;
        const crusadeBonus =
          ownerFaction === Faction.OTTOMAN ? 2 * Math.max(0, biases.crusadePreference - 0.5) : 0;
        const score =
          (provinceValue(dest, objectiveIds) + 2.5 * Math.min(2, ratio - needed) + crusadeBonus) *
            (0.4 + 0.9 * military) +
          (retakesMyCapital ? 12 : 0);
        out.push({
          action: { type: "MOVE", player: me.id, stackId: army.id, toId: dest.id },
          score,
        });
      }
    }

    // ---- RECRUIT: garrison threatened provinces; grow the field army ------
    for (const prov of mine) {
      const canMusterLand =
        prov.isCapitalOf !== undefined ||
        prov.terrain === TerrainType.CITY ||
        prov.buildings.includes(BuildingType.BARRACKS);
      if (!canMusterLand) continue;
      // §3.2 stacking pre-filter — a full city cannot muster another head.
      if (recruitBustsStackLimit(state, me.id, prov)) continue;

      // Garrison urgency: an actively threatened province, or the OWN CAPITAL
      // still short of the rival strength standing ADJACENT (the two-step
      // watch belongs to the anchor; recruiting to it would turtle the whole
      // budget into one stack). It deliberately ignores the grain floor:
      // starving later beats losing the sudden-death capital now.
      const homeShort =
        prov.isCapitalOf === myFaction &&
        myDefenseAt(state, prov, me.id) < threatAt(state, prov.id, me.id, allies);
      if (threatenedIds.has(prov.id) || homeShort) {
        const unit = pickUnit(me, [UnitType.INFANTRY, UnitType.ARCHER, UnitType.LEVY]);
        if (unit) {
          const score =
            (6 +
              0.4 * provinceValue(prov, objectiveIds) +
              0.3 * (threat.get(prov.id) ?? 0)) *
            (0.5 + biases.defensiveness);
          out.push({
            action: { type: "RECRUIT", player: me.id, provinceId: prov.id, units: { [unit]: 1 } },
            score,
          });
        }
        continue;
      }

      // Solvency guard: no casual recruiting into a grain crisis.
      if (me.treasury.grain < RECRUIT_GRAIN_FLOOR) continue;
      const nearFront = neighborsOf(prov.id).some((nb) => {
        const n = provinceById.get(nb);
        return (
          n !== undefined &&
          n.ownerId !== me.id &&
          (n.ownerId !== null || (n.garrison ?? 0) > 0) &&
          (n.ownerId === null || !allies.has(n.ownerId))
        );
      });
      const order =
        military > 0.6
          ? [UnitType.CAVALRY, UnitType.INFANTRY, UnitType.ARCHER, UnitType.LEVY]
          : [UnitType.INFANTRY, UnitType.ARCHER, UnitType.LEVY];
      const unit = pickUnit(me, order);
      if (unit) {
        out.push({
          action: { type: "RECRUIT", player: me.id, provinceId: prov.id, units: { [unit]: 1 } },
          score: 2 + 5 * military + (nearFront ? 2 : 0),
        });
      }
    }

    // ---- BUILD: income growth, defence works ------------------------------
    for (const prov of mine) {
      const buildScore = (b: BuildingType): number | null => {
        if (prov.buildings.includes(b)) return null;
        if (!canAfford(me, BUILDING_COSTS[b] as Partial<Record<ResKey, number>>)) return null;
        switch (b) {
          case BuildingType.MARKET:
            return (4 + 3 * biases.tradeFocus) * economy;
          case BuildingType.GRANARY:
            return (2 + (me.treasury.grain <= 4 ? 2 : 0)) * economy;
          case BuildingType.SHIPYARD:
            return prov.coastal ? (1.5 + 3 * (biases.tradeFocus - 0.3)) * economy : null;
          case BuildingType.TEMPLE:
            return 1.5 * economy;
          case BuildingType.UNIVERSITY:
            return (state.era >= 2 ? 2.5 : 0.5) * economy;
          case BuildingType.BARRACKS:
            return 1.5 * economy;
          case BuildingType.WALLS: {
            // Walls read the tier ladder, not the flat building cost.
            if (prov.walls.tier >= 3) return null;
            if (!threatenedIds.has(prov.id) && (prov.highValue ?? 0) < 3) return null;
            return (2 + 0.4 * provinceValue(prov, objectiveIds)) * (0.5 + biases.defensiveness);
          }
          default:
            return null;
        }
      };
      for (const b of Object.values(BuildingType)) {
        const score = buildScore(b);
        if (score !== null && score > 0) {
          out.push({
            action: { type: "BUILD", player: me.id, provinceId: prov.id, building: b },
            score,
          });
        }
      }
    }

    // ---- BUILD great works: finish first, start only on a safe treasury ---
    let startedGreatWork = false;
    for (const prov of mine) {
      for (const gw of prov.greatWorks) {
        const def = GREAT_WORK_COSTS[gw.type];
        if (gw.progress >= def.rounds) continue;
        // Continuing costs nothing further — nearly always worth an action.
        out.push({
          action: { type: "BUILD", player: me.id, provinceId: prov.id, greatWork: gw.type },
          score: 14,
        });
        startedGreatWork = true;
      }
    }
    if (!startedGreatWork && state.round >= GREAT_WORK_START_ROUND && mine.length > 0) {
      const site =
        mine.find((p) => p.isCapitalOf === me.faction) ?? mine[0];
      for (const type of Object.values(GreatWorkType)) {
        if (site.greatWorks.some((g) => g.type === type)) continue;
        const def = GREAT_WORK_COSTS[type];
        if (!canAfford(me, def.cost as Partial<Record<ResKey, number>>)) continue;
        if (me.treasury.gold - (def.cost.gold ?? 0) < GREAT_WORK_GOLD_RESERVE) continue;
        out.push({
          action: { type: "BUILD", player: me.id, provinceId: site.id, greatWork: type },
          score: def.prestige * 0.8 * (0.5 + economy),
        });
      }
    }

    // ---- TRADE/CONVERT: smooth a scarce resource out of a surplus ---------
    // Events/tactics can WORSEN the market ratio below the 3:1 base
    // (economy.ts trade_mod, negative values) — compute the true worst-case
    // ratio so the slate never ends as a run of BAD_TRADE rejections.
    const tradeMod = me.faction
      ? sumModifierValues(state, "trade_mod", { faction: me.faction })
      : 0;
    const worstRatio = Math.min(6, Math.max(3, 3 - tradeMod));
    // Structural famine guard: when army upkeep (~1 grain/head/round, §4.4)
    // outruns grain INCOME, buying grain on the market only treadmills gold
    // into the same deficit next round — skip the smoothing and let the
    // recruit floor shrink the problem instead.
    let upkeepHeads = 0;
    for (const army of state.armies) {
      if (army.ownerId === me.id) upkeepHeads += stackSize(army);
    }
    let grainIncome = 0;
    for (const prov of mine) grainIncome += prov.yields.grain;
    const structuralFamine = grainIncome + 1 < upkeepHeads;
    for (const scarce of TRADEABLE) {
      if (me.treasury[scarce] > SCARCE_AT) continue;
      if (scarce === "grain" && structuralFamine) continue;
      // Only the OPERATIONAL currencies are worth buying at a 2:1 loss: gold
      // pays for everything and grain feeds recruiting. Stockpiling timber or
      // marble with no build in hand just treadmills actions and treasury —
      // the old full-cartesian smoothing burned ~40% of a game's budget.
      if (scarce !== "gold" && scarce !== "grain") continue;
      for (const surplus of TRADEABLE) {
        if (surplus === scarce || me.treasury[surplus] < SURPLUS_AT) continue;
        const score =
          (4 +
            (SCARCE_AT - me.treasury[scarce]) +
            0.2 * (me.treasury[surplus] - SURPLUS_AT)) *
          (0.5 + 0.5 * biases.tradeFocus) *
          economy;
        // Probe the 2:1 market ratio first; the 3:1 base-ratio trade is the
        // fallback the driver reaches when no Market/port discounts apply.
        // The fallback is offset by MORE than the ranking jitter so it can
        // never overtake its cheaper twin in the ranked slate.
        out.push({
          action: {
            type: "TRADE",
            player: me.id,
            trade: { kind: "CONVERT", give: { [surplus]: 2 }, get: { [scarce]: 1 } },
          },
          score,
        });
        if (me.treasury[surplus] >= SURPLUS_AT + 1) {
          out.push({
            action: {
              type: "TRADE",
              player: me.id,
              trade: { kind: "CONVERT", give: { [surplus]: 3 }, get: { [scarce]: 1 } },
            },
            score: score - (JITTER + 0.2),
          });
        }
        // Final fallback at the modifier-worsened ratio (4:1..6:1), offset
        // below both cheaper probes by more than the ranking jitter. Always
        // affordable: the surplus gate above guarantees ≥ SURPLUS_AT (6) ≥
        // worstRatio, and the alternative to this candidate is a wasted turn
        // slot, not a better trade.
        if (worstRatio > 3) {
          out.push({
            action: {
              type: "TRADE",
              player: me.id,
              trade: {
                kind: "CONVERT",
                give: { [surplus]: worstRatio },
                get: { [scarce]: 1 },
              },
            },
            score: score - 2 * (JITTER + 0.2),
          });
        }
      }
    }

    // ---- Rank: deterministic jitter for tie-breaks, then take the slice ---
    const ranked = out
      .filter((c) => c.score > 0)
      .map((c, i) => ({ ...c, score: c.score + JITTER * ctx.rng.next(), i }));
    ranked.sort((a, b) => b.score - a.score || a.i - b.i);
    return ranked.slice(0, CANDIDATE_SLICE).map((c) => c.action);
  },
};
