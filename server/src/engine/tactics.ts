/**
 * tactics.ts — the tactic-deck subsystem: draw / hold / play / resolve (§7.7).
 *
 * The tactic deck is the card layer of combat (GAME_DESIGN §7.7). Players draw
 * one tactic card during the Income phase (Universities add draws), hold a hidden
 * hand pruned to `TACTIC_HAND_LIMIT` at Cleanup, and play at most one card per
 * side per battle ROUND (§7.7 "Playing" — the limit is per battle round, not per
 * battle: combat's tactic step consumes at most one queued card per side each
 * round). Cards that read "remove from game" (`greek-fire`,
 * `treason-at-the-gate`) go to `tacticRemoved`; all others go to `tacticDiscard`,
 * reshuffled when the draw pile empties.
 *
 * Marshal-review B3 — every one of the 24 designs has exactly one PLAY PATH
 * (published as `TacticEffectData.playPath` / {@link TACTIC_PLAY_PATH}):
 * - `"battle"` — queued into a `PendingBattle` by {@link queueTactic}
 *   (PLAY_TACTIC.battleId) and resolved by combat via {@link playTactic};
 *   the printed effect is a battle-scoped {@link ActiveModifier} combat reads.
 * - `"siege"`  — played against an ACTIVE `SiegeState` by
 *   {@link playSiegeTactic} (PLAY_TACTIC.siegeProvinceId); resolves at once into
 *   round-scoped siege/wall modifiers that `resolveSiege` consumes THIS round
 *   (the modifiers themselves are the queue — SiegeState carries no tactics
 *   array, and none is needed).
 * - `"global"` — no engagement: {@link playGlobalTactic} resolves the printed
 *   effect IMMEDIATELY (direct state delta or a faction-wide modifier).
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
import { bordersSea } from "./adjacency.js";
import { EngineError } from "./actions.js";
import { GREAT_WORK_COSTS, TACTIC, TACTIC_HAND_LIMIT, TREASON_GATE } from "./balance.js";
import { appendLog } from "./logEntry.js";
import { addModifier } from "./modifiers.js";
import { makeRng, type Rng } from "./rng.js";
import {
  TACTIC_CARD_BY_ID,
  type TacticEffectData,
  type TacticEffectTag,
} from "./tactics/cards.js";

export {
  TACTIC_CARDS,
  TACTIC_CARD_BY_ID,
  TACTIC_PLAY_PATH,
  buildTacticDeck,
  tacticPlayPath,
  type TacticPlayPath,
} from "./tactics/cards.js";

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
  /**
   * B3 siege target mode: the province of the ACTIVE `SiegeState` this card is
   * played against (no `PendingBattle` exists). Scopes the posted siege/wall
   * modifiers when `battle` is absent.
   */
  siegeProvinceId?: string;
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

/** True when `cardId` is a treason-effect card (e.g. `treason-at-the-gate`). */
function isTreasonCard(cardId: TacticCardId): boolean {
  const card = TACTIC_CARD_BY_ID[cardId];
  const data = card?.data as unknown as TacticEffectData | undefined;
  return data?.effect === "treason";
}

/**
 * DELTA 1 — treason-at-the-gate DOUBLE brake (GAME_DESIGN §7.7 "Treason at the
 * Gate" + coordinator ratification, delta 1). The treason tactic is playable
 * against a besieged city ONLY when BOTH gates hold (numbers from
 * `balance.TREASON_GATE`, not hardcoded):
 *   (a) the besieged province garrison is `<= TREASON_GATE.maxGarrison` (a large
 *       garrison cannot be suborned); AND
 *   (b) the siege's consecutive-siege-round clock did NOT start before game round
 *       `TREASON_GATE.minGameRound` — i.e. the siege BEGAN at/after that round.
 *       The start round is `state.round - siege.roundsElapsed` (roundsElapsed
 *       counts consecutive siege rounds since the siege was laid); a siege that
 *       started earlier cannot host treason.
 * Enforced at BOTH declaration ({@link queueTactic} / {@link playSiegeTactic})
 * and resolution ({@link playTactic}), where the target province + current round
 * are known. Throws `EngineError("TREASON_GATE", …)` when either gate fails.
 */
function assertTreasonGate(state: GameState, provinceId: string | undefined): void {
  const prov = provinceId ? state.provinces.find((p) => p.id === provinceId) : undefined;

  // Gate (a): garrison brake.
  const garrison = prov?.garrison ?? 0;
  if (garrison > TREASON_GATE.maxGarrison) {
    throw new EngineError(
      "TREASON_GATE",
      `treason-at-the-gate needs the garrison <= ${TREASON_GATE.maxGarrison} (found ${garrison})`,
    );
  }

  // Gate (b): the siege must exist and its clock must have begun no earlier than
  // TREASON_GATE.minGameRound.
  const siege = provinceId
    ? state.siegeStates.find((s) => s.provinceId === provinceId)
    : undefined;
  if (!siege) {
    throw new EngineError(
      "TREASON_GATE",
      `treason-at-the-gate requires an active siege of ${provinceId ?? "the target province"}`,
    );
  }
  const siegeStartRound = state.round - siege.roundsElapsed;
  if (siegeStartRound < TREASON_GATE.minGameRound) {
    throw new EngineError(
      "TREASON_GATE",
      `treason-at-the-gate: the siege began at round ${siegeStartRound}, before the earliest permitted round ${TREASON_GATE.minGameRound}`,
    );
  }
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
 * Marshal B3 + SS7 (tactics minor): declaration-time legality of a tactic played
 * into a BATTLE engagement (`PendingBattle`). Checks, in order:
 * - play path: `"global"` cards never target an engagement, `"siege"` cards only
 *   a declared siege-assault battle (`isSiege`) → `TACTIC_WRONG_TARGET`;
 * - domain legality (SS7): fleet cards need a sea-zone battle, land/siege cards
 *   a province battle → `TACTIC_WRONG_DOMAIN`;
 * - printed side restriction (e.g. `locked-shields` defender-only) →
 *   `TACTIC_WRONG_SIDE`;
 * - `temp_wall` (the-hexamilion-manned) only defends an UNWALLED province — §7.7
 *   "does not stack with real walls" → `TACTIC_PRECONDITION`;
 * - DELTA 1 treason double-brake ({@link assertTreasonGate}).
 */
function assertBattleLegality(
  state: GameState,
  battle: PendingBattle,
  side: BattleSide,
  cardId: TacticCardId,
): void {
  const data = cardData(cardId);
  if (data.playPath === "global") {
    throw new EngineError(
      "TACTIC_WRONG_TARGET",
      `${cardId} has no battle scope — play it with the Play-card path (§7.7/§10.6)`,
    );
  }
  if (data.playPath === "siege" && !battle.isSiege) {
    throw new EngineError(
      "TACTIC_WRONG_TARGET",
      `${cardId} is siege-scoped — play it against an active siege, not a field battle`,
    );
  }
  if (data.domain === "fleet" && !battle.seaZoneId) {
    throw new EngineError("TACTIC_WRONG_DOMAIN", `${cardId} is legal only in a fleet battle`);
  }
  if ((data.domain === "land" || data.domain === "siege") && !battle.provinceId) {
    throw new EngineError("TACTIC_WRONG_DOMAIN", `${cardId} is legal only in a land engagement`);
  }
  if (data.side && data.side !== side) {
    throw new EngineError(
      "TACTIC_WRONG_SIDE",
      `${cardId} may only be played by the ${data.side}`,
    );
  }
  if (data.effect === "temp_wall" && battle.provinceId) {
    const prov = state.provinces.find((p) => p.id === battle.provinceId);
    if (prov && prov.walls.tier > 0) {
      throw new EngineError(
        "TACTIC_PRECONDITION",
        `the-hexamilion-manned defends only an UNWALLED province (§7.7); ${prov.id} has T${prov.walls.tier} walls`,
      );
    }
  }
  // DELTA 1 (GD §7.7 + ratification): treason double-brake at declaration time.
  if (isTreasonCard(cardId)) assertTreasonGate(state, battle.provinceId);
}

/**
 * PLAY_TACTIC reducer target, battle mode (§7.7 / CONTRACT2 §12.9 / marshal B3):
 * validate `cardId` is in the side player's hand and legal for this battle
 * ({@link assertBattleLegality}), then move the card from hand onto
 * `PendingBattle.{attacker,defender}Tactics`. The card is resolved later by
 * {@link playTactic} during combat.
 *
 * LIMIT (marshal minor, GD §7.7 "Playing"): the printed limit is "at most one
 * tactic card per battle ROUND" — per ROUND, not per battle. Declaration may
 * therefore queue several cards; combat's tactic step (`playSideTactic`) consumes
 * at most `TACTIC.maxPlaysPerBattleRound` (=1) per side each battle round, which
 * is where the §7.7 cap is enforced. The former whole-battle queue cap is gone.
 * Returns a new state.
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
  assertBattleLegality(state, battle, side, cardId);
  const queued = (side === "attacker" ? battle.attackerTactics : battle.defenderTactics) ?? [];

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

  // DELTA 1 (GD §7.7 + ratification): re-enforce the treason double-brake at
  // resolution time (before charging any printed cost), in case state changed
  // between declaration and combat.
  if (isTreasonCard(cardId)) assertTreasonGate(state, live.provinceId);

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

/**
 * Optional rival/province refinements accompanying a PLAY_TACTIC
 * (STAGE-B-PREP §1: `targetPlayerId`/`targetProvinceId` may accompany any mode).
 */
export interface TacticTargetOpts {
  /** Rival named by the card (`ears-in-the-bazaar`, `the-pay-chest-taken`, `a-death-in-the-palace`). */
  targetPlayerId?: string;
  /** Province named by the card (`chain-across-the-horn`). */
  targetProvinceId?: string;
}

/**
 * Marshal B3, target mode 2 (SIEGE) — PLAY_TACTIC.siegeProvinceId: play a
 * siege-scoped card (`night-sortie`, `treason-at-the-gate`, `sails-from-the-west`,
 * `bribed-gatekeeper`, `ladders-and-fascines`, `master-founders-hired`) against
 * the ACTIVE `SiegeState` for `siegeProvinceId`. Validates: an active siege
 * exists (`NO_SUCH_SIEGE`); the player is a party to it — besieger plays as
 * attacker, the besieged owner as defender (`NOT_BELLIGERENT`); the card is
 * siege-scoped (`TACTIC_WRONG_TARGET`) and side-legal (`TACTIC_WRONG_SIDE`);
 * the DELTA-1 treason double-brake.
 *
 * The card resolves IMMEDIATELY: its printed effect is posted as round-scoped
 * siege/wall {@link ActiveModifier}s targeted at the besieged province — the
 * modifiers themselves are the queue that combat's `resolveSiege` consumes in
 * this round's COMBAT phase (SiegeState needs no tactics array). Deterministic:
 * derives one RNG from `(rngSeed, rngCursor)` and writes the cursor back.
 * Returns a new state.
 */
export function playSiegeTactic(
  state: GameState,
  playerId: string,
  siegeProvinceId: string,
  cardId: TacticCardId,
  opts: TacticTargetOpts = {},
): GameState {
  const player = playerOf(state, playerId);
  const data = cardData(cardId);
  const siege = state.siegeStates.find((s) => s.provinceId === siegeProvinceId);
  if (!siege) {
    throw new EngineError("NO_SUCH_SIEGE", `no active siege of ${siegeProvinceId}`);
  }
  if (data.playPath !== "siege") {
    throw new EngineError(
      "TACTIC_WRONG_TARGET",
      `${cardId} is not siege-scoped (play path: ${data.playPath})`,
    );
  }
  const prov = state.provinces.find((p) => p.id === siegeProvinceId);
  let side: BattleSide;
  if (siege.besiegerId === playerId) side = "attacker";
  else if (prov?.ownerId === playerId) side = "defender";
  else {
    throw new EngineError(
      "NOT_BELLIGERENT",
      `${playerId} is neither besieger nor besieged at ${siegeProvinceId}`,
    );
  }
  if (data.side && data.side !== side) {
    throw new EngineError("TACTIC_WRONG_SIDE", `${cardId} may only be played by the ${data.side}`);
  }
  const hand = player.tacticHand ?? [];
  if (!hand.includes(cardId)) {
    throw new EngineError("TACTIC_NOT_IN_HAND", `${playerId} does not hold tactic ${cardId}`);
  }
  // DELTA 1 (GD §7.7 + ratification): treason double-brake vs the live siege.
  if (isTreasonCard(cardId)) assertTreasonGate(state, siegeProvinceId);

  // Remove ONE copy from hand, then resolve at once (cursor convention §4).
  const idx = hand.indexOf(cardId);
  let next = withPlayer(state, {
    ...player,
    tacticHand: [...hand.slice(0, idx), ...hand.slice(idx + 1)],
  });
  const rng = makeRng(next.rngSeed, next.rngCursor);
  next = resolveTacticEffect(next, cardId, {
    playerId,
    side,
    siegeProvinceId,
    rng,
    targetPlayerId: opts.targetPlayerId,
    targetProvinceId: opts.targetProvinceId,
  });
  return { ...next, rngCursor: rng.cursor };
}

/**
 * Marshal B3, target mode 3 (GLOBAL/IMMEDIATE) — PLAY_TACTIC with neither
 * `battleId` nor `siegeProvinceId`: play a card with no battle scope
 * (`papal-indulgence`, `the-counting-house`, `grain-barges-of-the-danube`,
 * `ears-in-the-bazaar`, `the-pay-chest-taken`, `holy-war-proclaimed`,
 * `a-death-in-the-palace`, `chain-across-the-horn`, `forced-march`). The printed
 * effect resolves IMMEDIATELY — a direct state delta (treasury transfers, hand
 * reveal) or a faction-wide modifier (`combat_mod` holy-war, `truce`,
 * `wall_mod` amphibious immunity, `move_mod` forced-march rider) — and the card
 * goes to discard/removed. Battle-/siege-scoped cards are rejected with
 * `TACTIC_WRONG_TARGET` (they need an engagement). Deterministic: derives one
 * RNG from `(rngSeed, rngCursor)` and writes the cursor back. Returns a new state.
 */
export function playGlobalTactic(
  state: GameState,
  playerId: string,
  cardId: TacticCardId,
  opts: TacticTargetOpts = {},
): GameState {
  const player = playerOf(state, playerId);
  const data = cardData(cardId);
  if (data.playPath !== "global") {
    throw new EngineError(
      "TACTIC_WRONG_TARGET",
      `${cardId} is ${data.playPath}-scoped — play it into that engagement (§7.7)`,
    );
  }
  const hand = player.tacticHand ?? [];
  if (!hand.includes(cardId)) {
    throw new EngineError("TACTIC_NOT_IN_HAND", `${playerId} does not hold tactic ${cardId}`);
  }

  // Remove ONE copy from hand, then resolve at once (cursor convention §4).
  const idx = hand.indexOf(cardId);
  let next = withPlayer(state, {
    ...player,
    tacticHand: [...hand.slice(0, idx), ...hand.slice(idx + 1)],
  });
  const rng = makeRng(next.rngSeed, next.rngCursor);
  next = resolveTacticEffect(next, cardId, {
    playerId,
    rng,
    targetPlayerId: opts.targetPlayerId,
    targetProvinceId: opts.targetProvinceId,
  });
  return { ...next, rngCursor: rng.cursor };
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
  // province — narrowing the modifier to exactly this battle / siege (B3: siege
  // mode carries no PendingBattle, the SiegeState's province scopes it instead).
  const battle = ctx.battle;
  const provinceId = battle?.provinceId ?? ctx.siegeProvinceId;
  const seaZoneId = battle?.seaZoneId;
  // B3 global cards: extra card-specific log payload (e.g. the peeked hand).
  let extraLogData: Record<string, unknown> = {};
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
      // RULING 4 — master-founders-hired: the ratified mechanic is
      // bribed-gatekeeper's wall-bonus cancel PLUS a +1 assault die (per
      // lore/tactics/cards.md, PR #8 ## Rare). When the card carries
      // `assaultDice`, also post the attacker combat_mod so the assault gets the
      // extra die (modelled as a +N attacker CV, as veterans-of-the-border does).
      if (data.assaultDice) {
        next = postModifier(next, cardId, "combat_mod", {
          value: data.assaultDice,
          target: battleTarget,
          data: { dice: true, side: ctx.side },
        });
      }
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
    case "amphibious_immune": {
      // §7.7 Chain Across the Horn: "one coastal province YOU HOLD cannot be the
      // target of an amphibious assault". B3: validate the named province.
      if (!ctx.targetProvinceId) {
        throw new EngineError("NO_TARGET", "chain-across-the-horn needs a target province");
      }
      const chained = next.provinces.find((p) => p.id === ctx.targetProvinceId);
      // CALL-SITE DECISION (coastal→port rename): amphibious-assault
      // eligibility is the PHYSICAL "borders a sea" predicate (bordersSea) —
      // any shore province can be amphibiously assaulted, so any held shore
      // province is a legal chain target; harbor status is irrelevant.
      if (!chained || chained.ownerId !== ctx.playerId || !bordersSea(chained.id)) {
        throw new EngineError(
          "BAD_TARGET",
          "chain-across-the-horn targets a sea-bordering province the player holds",
        );
      }
      next = postModifier(next, cardId, "wall_mod", {
        target: { faction, provinceId: ctx.targetProvinceId },
        data: { amphibiousImmune: true },
      });
      break;
    }
    case "forced_march":
      // §7.7 Forced March: rider on a Move — +1 province, no besiege/assault.
      next = postModifier(next, cardId, "move_mod", {
        value: data.value ?? 1,
        target: { faction },
        data: { moveBonus: data.value ?? 1, noSiege: true, noAssault: true },
      });
      break;
    case "truce":
      // §7.7 A Death in the Palace: "NAME ONE RIVAL — a truce binds you both
      // until the start of your next turn". B3: the rival target is mandatory.
      if (!ctx.targetPlayerId) {
        throw new EngineError("NO_TARGET", "a-death-in-the-palace needs a rival target");
      }
      if (ctx.targetPlayerId === ctx.playerId) {
        throw new EngineError("BAD_TARGET", "cannot declare a truce with yourself");
      }
      playerOf(next, ctx.targetPlayerId); // must exist (throws UNKNOWN_PLAYER)
      next = postModifier(next, cardId, "truce", {
        data: { parties: [ctx.playerId, ctx.targetPlayerId] },
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
    case "peek_hand": {
      // §7.7 Ears in the Bazaar: "look at all tactic cards held by ONE RIVAL".
      // B3 consumable form: the revealed hand rides in the log entry's data
      // (visible to the playing seat; transport redaction is the socket layer's).
      if (!ctx.targetPlayerId) {
        throw new EngineError("NO_TARGET", "ears-in-the-bazaar needs a rival target");
      }
      if (ctx.targetPlayerId === ctx.playerId) {
        throw new EngineError("BAD_TARGET", "cannot peek at your own hand");
      }
      const rival = playerOf(next, ctx.targetPlayerId);
      extraLogData = { revealedHand: [...(rival.tacticHand ?? [])], revealedTo: ctx.playerId };
      break;
    }
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
      ...extraLogData,
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
