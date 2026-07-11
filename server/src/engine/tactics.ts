/**
 * tactics.ts — the tactic-deck subsystem: draw / hold / play / resolve (§7.7).
 *
 * The tactic deck is the card layer of combat (GAME_DESIGN §7.7). Players draw
 * one tactic card during the Income phase (Universities add draws), hold a hidden
 * hand pruned to `TACTIC_HAND_LIMIT` at Cleanup, and play at most one card per
 * side per battle round. Battle-scoped cards register their printed effect as a
 * battle-scoped {@link ActiveModifier} (kind per CONTRACT2 §12.10) that combat.ts
 * reads; non-battle cards apply a direct economy/diplomacy effect. Cards that read
 * "remove from game" (`greek-fire`, `treason-at-the-gate`) go to `tacticRemoved`;
 * all others go to `tacticDiscard`, reshuffled when the draw pile empties.
 *
 * PURITY: no wall-clock / Math.random. Determinism: draw/reshuffle build an RNG
 * from `(state.rngSeed, state.rngCursor)` and write the advanced cursor back;
 * combat-time entry points (`playTactic`) take the caller's `rng` as a parameter
 * (roundLoop owns the COMBAT cursor). Prestige for won engagements is NOT posted
 * here — that stays with combat/diplomacy (`prestige_pending`, CONTRACT2 §12.8).
 */
import {
  BuildingType,
  GreatWorkType,
  type ActiveModifier,
  type GameState,
  type PendingBattle,
  type Player,
  type Province,
  type ResourceBundle,
  type TacticCardId,
} from "@imperium/shared";
import { EngineError } from "./actions.js";
import { GREAT_WORK_COSTS, TACTIC, TACTIC_HAND_LIMIT } from "./balance.js";
import { appendLog } from "./logEntry.js";
import { addModifier } from "./modifiers.js";
import { makeRng, type Rng } from "./rng.js";
import {
  TACTIC_CARD_BY_ID,
  type TacticEffectData,
  type TacticEffectTag,
} from "./tactics/cards.js";

export { TACTIC_CARDS, TACTIC_CARD_BY_ID, buildTacticDeck } from "./tactics/cards.js";

/** The side of a battle a tactic is played for. */
export type BattleSide = "attacker" | "defender";

/**
 * Context threaded into {@link resolveTacticEffect}. Extends the CONTRACT2 §12.9
 * proposal with the optional rival/province targets a handful of non-battle cards
 * need (`the-pay-chest-taken`, `a-death-in-the-palace`, `chain-across-the-horn`),
 * plumbed by the PLAY_TACTIC reducer / play-card action.
 */
export interface TacticEffectContext {
  /** Player id playing the card (the beneficiary). */
  playerId: string;
  /** The battle this card is played into, if battle-scoped. */
  battle?: PendingBattle;
  /** Which side of `battle` the player is on. */
  side?: BattleSide;
  /** RNG the caller owns (combat cursor / phase cursor). */
  rng: Rng;
  /** Rival targeted by `steal_gold` / `truce`. */
  targetPlayerId?: string;
  /** Province targeted by `amphibious_immune` (a coastal city the player holds). */
  targetProvinceId?: string;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function playerOf(state: GameState, id: string): Player {
  const p = state.players.find((pl) => pl.id === id);
  if (!p) throw new EngineError("UNKNOWN_PLAYER", `no player ${id}`);
  return p;
}

function battleOf(state: GameState, battleId: string): PendingBattle {
  const b = state.pendingBattles.find((pb) => pb.id === battleId);
  if (!b) throw new EngineError("UNKNOWN_BATTLE", `no pending battle ${battleId}`);
  return b;
}

/** The player on the given side of a battle. */
function sidePlayerId(battle: PendingBattle, side: BattleSide): string {
  const id = side === "attacker" ? battle.attackerId : battle.defenderId;
  if (!id) throw new EngineError("NO_SIDE_PLAYER", `battle ${battle.id} has no ${side}`);
  return id;
}

function cardData(cardId: TacticCardId): TacticEffectData {
  const card = TACTIC_CARD_BY_ID[cardId];
  if (!card) throw new EngineError("UNKNOWN_TACTIC", `unknown tactic ${cardId}`);
  return card.data as unknown as TacticEffectData;
}

/** A great work counts as completed once its progress reaches its round count. */
function hasCompletedGreatWork(prov: Province, type: GreatWorkType): boolean {
  const need = GREAT_WORK_COSTS[type].rounds;
  return prov.greatWorks.some((g) => g.type === type && g.progress >= need);
}

/** Extra tactic draws this player earns from Universities (§7.7 / §9.1–§9.2). */
function universityDrawBonus(state: GameState, playerId: string): number {
  const owned = state.provinces.filter((p) => p.ownerId === playerId);
  let bonus = 0;
  if (owned.some((p) => p.buildings.includes(BuildingType.UNIVERSITY))) {
    bonus += TACTIC.universityDrawBonus;
  }
  if (owned.some((p) => hasCompletedGreatWork(p, GreatWorkType.GREAT_UNIVERSITY))) {
    bonus += TACTIC.greatUniversityDrawBonus;
  }
  return bonus;
}

/** Replace one player in the roster (immutable). */
function withPlayer(state: GameState, next: Player): GameState {
  return { ...state, players: state.players.map((p) => (p.id === next.id ? next : p)) };
}

// ---------------------------------------------------------------------------
// draw / discard
// ---------------------------------------------------------------------------

/**
 * Draw tactic cards into `playerId`'s hand (§7.7): 1 base draw plus University
 * bonuses. When the draw pile empties mid-draw, reshuffle `tacticDiscard` into
 * `tacticDeck` — `tacticRemoved` is NEVER mixed back in. Deterministic: derives
 * one RNG from `(rngSeed, rngCursor)` for any reshuffles and writes the advanced
 * cursor back. Returns a new state.
 */
export function drawTactic(state: GameState, playerId: string): GameState {
  const player = playerOf(state, playerId);
  const count = TACTIC.drawPerIncome + universityDrawBonus(state, playerId);

  let deck = [...(state.tacticDeck ?? [])];
  let discard = [...(state.tacticDiscard ?? [])];
  const removed = state.tacticRemoved ?? [];
  const hand = [...(player.tacticHand ?? [])];
  const rng = makeRng(state.rngSeed, state.rngCursor);
  const drawn: TacticCardId[] = [];

  for (let i = 0; i < count; i += 1) {
    if (deck.length === 0) {
      // §7.7: reshuffle the discard when the draw pile empties; removed cards stay out.
      if (discard.length === 0) break; // deck AND discard exhausted — nothing to draw.
      deck = rng.shuffle(discard);
      discard = [];
    }
    const card = deck.shift();
    if (card === undefined) break;
    hand.push(card);
    drawn.push(card);
  }

  let next: GameState = {
    ...state,
    tacticDeck: deck,
    tacticDiscard: discard,
    tacticRemoved: removed,
    rngCursor: rng.cursor,
  };
  next = withPlayer(next, { ...player, tacticHand: hand });

  if (drawn.length > 0) {
    // Hand contents are hidden; log only the count (player-visible bookkeeping).
    next = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "event_card",
      actors: [playerId],
      data: { deck: "tactic", action: "draw", count: drawn.length },
      message: `${player.name} draws ${drawn.length} tactic card${drawn.length === 1 ? "" : "s"}`,
    });
  }
  return next;
}

/**
 * Prune `playerId`'s hand to `TACTIC_HAND_LIMIT` at Cleanup (§7.7), moving the
 * overflow (most-recently-drawn kept last → discarded first) onto `tacticDiscard`.
 * roundLoop owns calling this each Cleanup. Returns a new state (unchanged when at
 * or under the limit).
 */
export function discardToHandLimit(state: GameState, playerId: string): GameState {
  const player = playerOf(state, playerId);
  const hand = player.tacticHand ?? [];
  if (hand.length <= TACTIC_HAND_LIMIT) return state;

  const keep = hand.slice(0, TACTIC_HAND_LIMIT);
  const dumped = hand.slice(TACTIC_HAND_LIMIT);
  let next = withPlayer(state, { ...player, tacticHand: keep });
  next = { ...next, tacticDiscard: [...(next.tacticDiscard ?? []), ...dumped] };
  next = appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "event_card",
    actors: [playerId],
    data: { deck: "tactic", action: "discard_to_limit", count: dumped.length },
    message: `${player.name} discards ${dumped.length} tactic card${dumped.length === 1 ? "" : "s"} to the hand limit`,
  });
  return next;
}

// ---------------------------------------------------------------------------
// queue (declaration) / play (resolution)
// ---------------------------------------------------------------------------

/**
 * PLAY_TACTIC reducer target (§7.7 / CONTRACT2 §12.9): validate `cardId` is in the
 * side player's hand and the side has not exceeded `maxPlaysPerBattleRound` (the
 * `the-intercepted-letter` reaction is exempt), then move the card from hand onto
 * `PendingBattle.{attacker,defender}Tactics`. The card is resolved later by
 * {@link playTactic} during combat. Returns a new state.
 */
export function queueTactic(
  state: GameState,
  battleId: string,
  side: BattleSide,
  cardId: TacticCardId,
): GameState {
  const battle = battleOf(state, battleId);
  const playerId = sidePlayerId(battle, side);
  const player = playerOf(state, playerId);
  const hand = player.tacticHand ?? [];
  if (!hand.includes(cardId)) {
    throw new EngineError("TACTIC_NOT_IN_HAND", `${playerId} does not hold tactic ${cardId}`);
  }

  const card = TACTIC_CARD_BY_ID[cardId];
  const queued = (side === "attacker" ? battle.attackerTactics : battle.defenderTactics) ?? [];
  const isReaction = card?.timing === "reaction";
  if (!isReaction && queued.length >= TACTIC.maxPlaysPerBattleRound) {
    throw new EngineError(
      "TACTIC_LIMIT",
      `${side} already played ${queued.length} tactic(s) this battle round`,
    );
  }

  // Remove ONE copy from hand and queue it on the battle.
  const idx = hand.indexOf(cardId);
  const nextHand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
  const nextQueue = [...queued, cardId];
  const nextBattle: PendingBattle =
    side === "attacker"
      ? { ...battle, attackerTactics: nextQueue }
      : { ...battle, defenderTactics: nextQueue };

  let next = withPlayer(state, { ...player, tacticHand: nextHand });
  next = {
    ...next,
    pendingBattles: next.pendingBattles.map((pb) => (pb.id === battle.id ? nextBattle : pb)),
  };
  next = appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "event_card",
    actors: [playerId],
    targets: battle.provinceId ? [battle.provinceId] : battle.seaZoneId ? [battle.seaZoneId] : [],
    data: { deck: "tactic", action: "queue", card: cardId, side },
    message: `${player.name} readies "${card?.name ?? cardId}"`,
  });
  return next;
}

/**
 * Resolve a tactic during combat (§7.7): validate the card is held/queued by the
 * side player, remove it from the queue (or hand), and register its printed effect
 * via {@link resolveTacticEffect} (which routes it to discard/removed). combat.ts
 * calls this in the battle round; `rng` is the caller-owned combat stream.
 * Returns a new state.
 */
export function playTactic(
  state: GameState,
  battle: PendingBattle,
  side: BattleSide,
  cardId: TacticCardId,
  rng: Rng,
): GameState {
  const live = battleOf(state, battle.id); // trust current state, not a stale copy.
  const playerId = sidePlayerId(live, side);
  const player = playerOf(state, playerId);

  const queued = (side === "attacker" ? live.attackerTactics : live.defenderTactics) ?? [];
  const inQueue = queued.includes(cardId);
  const hand = player.tacticHand ?? [];
  const inHand = hand.includes(cardId);
  if (!inQueue && !inHand) {
    throw new EngineError("TACTIC_NOT_PLAYABLE", `${playerId} cannot play tactic ${cardId}`);
  }

  let next = state;
  if (inQueue) {
    const idx = queued.indexOf(cardId);
    const nextQueue = [...queued.slice(0, idx), ...queued.slice(idx + 1)];
    const nextBattle: PendingBattle =
      side === "attacker"
        ? { ...live, attackerTactics: nextQueue }
        : { ...live, defenderTactics: nextQueue };
    next = {
      ...next,
      pendingBattles: next.pendingBattles.map((pb) => (pb.id === live.id ? nextBattle : pb)),
    };
  } else {
    const idx = hand.indexOf(cardId);
    const nextHand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
    next = withPlayer(next, { ...player, tacticHand: nextHand });
  }

  return resolveTacticEffect(next, cardId, { playerId, battle: live, side, rng });
}

// ---------------------------------------------------------------------------
// effect resolution
// ---------------------------------------------------------------------------

/** Post one battle/siege-scoped modifier and return the new state. */
function postModifier(
  state: GameState,
  cardId: TacticCardId,
  kind: string,
  opts: {
    value?: number;
    target?: ActiveModifier["target"];
    data?: Record<string, unknown>;
    scope?: ActiveModifier["scope"];
  },
): GameState {
  const mod: ActiveModifier = {
    id: `tactic:${cardId}:${kind}:${state.clock}`,
    sourceCardId: cardId,
    scope: opts.scope ?? "round",
    kind,
    ...(opts.value !== undefined ? { value: opts.value } : {}),
    ...(opts.target ? { target: opts.target } : {}),
    data: { ...(opts.data ?? {}), tactic: cardId },
  };
  return addModifier(state, mod);
}

/** Charge a card's printed gold/faith cost to the player (§10.6). */
function payCost(state: GameState, playerId: string, data: TacticEffectData): GameState {
  const gold = data.costGold ?? 0;
  const faith = data.costFaith ?? 0;
  if (gold === 0 && faith === 0) return state;
  const player = playerOf(state, playerId);
  if (player.treasury.gold < gold || player.treasury.faith < faith) {
    throw new EngineError(
      "INSUFFICIENT_RESOURCES",
      `cannot pay tactic cost (gold ${gold}, faith ${faith})`,
    );
  }
  const treasury: ResourceBundle = {
    ...player.treasury,
    gold: player.treasury.gold - gold,
    faith: player.treasury.faith - faith,
  };
  return withPlayer(state, { ...player, treasury });
}

/** Route a played card to the discard (or removed-from-game) pile. */
function retireCard(state: GameState, cardId: TacticCardId): GameState {
  const card = TACTIC_CARD_BY_ID[cardId];
  if (card?.removedFromGameOnPlay) {
    return { ...state, tacticRemoved: [...(state.tacticRemoved ?? []), cardId] };
  }
  return { ...state, tacticDiscard: [...(state.tacticDiscard ?? []), cardId] };
}

/**
 * Apply one card's printed effect (§7.7). Battle-scoped cards post a battle-scoped
 * {@link ActiveModifier} of the kind combat.ts reads (CONTRACT2 §12.10); economy /
 * diplomacy cards apply directly. Every card is then routed to
 * `tacticDiscard`/`tacticRemoved` by {@link retireCard}. Printed resource costs
 * are charged first. Returns a new state.
 */
export function resolveTacticEffect(
  state: GameState,
  cardId: TacticCardId,
  ctx: TacticEffectContext,
): GameState {
  const data = cardData(cardId);
  const card = TACTIC_CARD_BY_ID[cardId];
  const beneficiary = playerOf(state, ctx.playerId);
  const faction = beneficiary.faction ?? undefined;

  let next = payCost(state, ctx.playerId, data);

  // Where the effect is scoped: a fleet card keys off the sea zone, otherwise the
  // province — narrowing the modifier to exactly this battle.
  const battle = ctx.battle;
  const provinceId = battle?.provinceId;
  const seaZoneId = battle?.seaZoneId;
  const battleTarget: ActiveModifier["target"] =
    data.domain === "fleet"
      ? { faction, seaZoneId }
      : { faction, provinceId };

  const effect: TacticEffectTag = data.effect;
  switch (effect) {
    case "melee_dice":
      // §7.3/§7.7: +N melee dice for this side of this battle → combat_mod.
      next = postModifier(next, cardId, "combat_mod", {
        value: data.value ?? 1,
        target: battleTarget,
        data: { dice: true, side: ctx.side },
      });
      break;
    case "reroll":
      // §7.7: reroll grant — siege assaults read siege_mod, field battles combat_mod.
      next = postModifier(next, cardId, data.domain === "siege" ? "siege_mod" : "combat_mod", {
        value: 0,
        target: data.domain === "siege" ? { faction, provinceId } : battleTarget,
        data: { reroll: data.rerollMode ?? "one", dice: data.value ?? 1, side: ctx.side },
      });
      break;
    case "temp_wall":
      // §7.7 Hexamilion Manned: temporary defender +N in an unwalled province.
      next = postModifier(next, cardId, "combat_mod", {
        value: data.value ?? 2,
        target: { faction, provinceId },
        data: { tempWall: true, side: "defender" },
      });
      break;
    case "wall_bonus_zero":
      // §7.7 Bribed Gatekeeper: this assault ignores the defender's wall bonus.
      next = postModifier(next, cardId, "wall_mod", {
        target: { provinceId },
        data: { wallBonusZero: true, attackerFaction: faction },
      });
      break;
    case "siege_bombard":
      // §7.7 Master Founders Hired: +N wall-damage dice this siege round.
      next = postModifier(next, cardId, "siege_mod", {
        value: data.value ?? 2,
        target: { faction, provinceId },
        data: { bombardDice: data.value ?? 2 },
      });
      break;
    case "night_sortie":
      // §7.7 Night Sortie: garrison unstarved this round; besieger loses 1 unit.
      next = postModifier(next, cardId, "siege_mod", {
        target: { faction, provinceId },
        data: { noDepletion: true, besiegerLoses: 1, side: "defender" },
      });
      break;
    case "sails_relief":
      // §7.7 Sails from the West: no depletion under blockade + restore grain.
      next = postModifier(next, cardId, "siege_mod", {
        value: data.value ?? 2,
        target: { faction, provinceId },
        data: { noDepletion: true, ignoreBlockade: true, restoreGrain: data.value ?? 2 },
      });
      break;
    case "treason":
      // §7.7 Treason at the Gate: besieged city falls without an assault.
      next = postModifier(next, cardId, "siege_mod", {
        target: { faction, provinceId },
        data: { autoCapture: true, minRounds: 2 },
      });
      break;
    case "greek_fire":
      // §7.7 Greek Fire: win the fleet battle outright; then discard one other card.
      next = postModifier(next, cardId, "combat_mod", {
        target: { faction, seaZoneId },
        data: { autoWinNaval: true },
      });
      next = discardOneOther(next, ctx.playerId, cardId);
      break;
    case "feigned_retreat":
      // §7.7 Feigned Retreat: withdraw whole stack; battle ends, no pursuit.
      next = postModifier(next, cardId, "morale", {
        target: battleTarget,
        data: { retreat: true, side: ctx.side },
      });
      break;
    case "holy_war":
      // §7.7 Holy War Proclaimed: +N melee dice in EVERY battle until next turn.
      next = postModifier(next, cardId, "combat_mod", {
        value: data.value ?? 1,
        target: { faction },
        data: { dice: true, allBattles: true },
      });
      break;
    case "amphibious_immune":
      // §7.7 Chain Across the Horn: a coastal province cannot be amphibiously assaulted.
      next = postModifier(next, cardId, "wall_mod", {
        target: { faction, provinceId: ctx.targetProvinceId },
        data: { amphibiousImmune: true },
      });
      break;
    case "forced_march":
      // §7.7 Forced March: rider on a Move — +1 province, no besiege/assault.
      next = postModifier(next, cardId, "move_mod", {
        value: data.value ?? 1,
        target: { faction },
        data: { moveBonus: data.value ?? 1, noSiege: true, noAssault: true },
      });
      break;
    case "truce":
      // §7.7 A Death in the Palace: a truce binds both players until next turn.
      next = postModifier(next, cardId, "truce", {
        target: { faction },
        data: {
          parties: ctx.targetPlayerId ? [ctx.playerId, ctx.targetPlayerId] : [ctx.playerId],
        },
      });
      break;
    case "intercept":
      // §7.7 The Intercepted Letter: reaction that cancels a rival's tactic card.
      next = postModifier(next, cardId, "cancel_tactic", {
        target: { faction },
        data: { reaction: true },
      });
      break;
    case "gain_resource":
      next = gainResource(next, ctx.playerId, data.resource ?? "gold", data.value ?? 0);
      break;
    case "steal_gold":
      next = stealGold(next, ctx.playerId, ctx.targetPlayerId, data.value ?? 0);
      break;
    case "peek_hand":
      // Pure information (hidden hand reveal); no state effect beyond the log.
      break;
    default: {
      const _never: never = effect;
      throw new EngineError("UNKNOWN_TACTIC", `unhandled tactic effect ${_never as string}`);
    }
  }

  next = retireCard(next, cardId);
  next = appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "event_card",
    actors: [ctx.playerId],
    targets: [
      ...(provinceId ? [provinceId] : []),
      ...(seaZoneId ? [seaZoneId] : []),
      ...(ctx.targetPlayerId ? [ctx.targetPlayerId] : []),
    ],
    data: {
      deck: "tactic",
      action: "play",
      card: cardId,
      effect,
      removed: card?.removedFromGameOnPlay ?? false,
    },
    message: `${beneficiary.name} plays "${card?.name ?? cardId}"`,
  });
  return next;
}

/** Add resources to a player's treasury (§7.7 economy cards). */
function gainResource(
  state: GameState,
  playerId: string,
  resource: "gold" | "grain" | "faith",
  amount: number,
): GameState {
  if (amount === 0) return state;
  const player = playerOf(state, playerId);
  const treasury: ResourceBundle = {
    ...player.treasury,
    [resource]: player.treasury[resource] + amount,
  };
  return withPlayer(state, { ...player, treasury });
}

/**
 * §7.7 The Pay Chest Taken: transfer up to `amount` gold from a rival — never more
 * than the rival holds. Requires a rival target.
 */
function stealGold(
  state: GameState,
  playerId: string,
  rivalId: string | undefined,
  amount: number,
): GameState {
  if (!rivalId) throw new EngineError("NO_TARGET", "the-pay-chest-taken needs a rival target");
  if (rivalId === playerId) throw new EngineError("BAD_TARGET", "cannot target yourself");
  const rival = playerOf(state, rivalId);
  const taken = Math.min(amount, rival.treasury.gold);
  if (taken === 0) return state;
  let next = withPlayer(state, {
    ...rival,
    treasury: { ...rival.treasury, gold: rival.treasury.gold - taken },
  });
  const thief = playerOf(next, playerId);
  next = withPlayer(next, {
    ...thief,
    treasury: { ...thief.treasury, gold: thief.treasury.gold + taken },
  });
  return next;
}

/**
 * §7.7 Greek Fire: after winning, discard one OTHER tactic card from hand. Picks
 * deterministically (the first remaining card that is not this one).
 */
function discardOneOther(state: GameState, playerId: string, playedId: TacticCardId): GameState {
  const player = playerOf(state, playerId);
  const hand = player.tacticHand ?? [];
  const idx = hand.findIndex((c) => c !== playedId);
  if (idx === -1) return state; // no other card to discard.
  const discarded = hand[idx];
  const nextHand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
  let next = withPlayer(state, { ...player, tacticHand: nextHand });
  next = { ...next, tacticDiscard: [...(next.tacticDiscard ?? []), discarded] };
  return next;
}
