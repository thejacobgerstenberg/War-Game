/**
 * events/index.ts — the Omen deck subsystem (GAME_DESIGN §12 / EVENT_CARDS.md).
 *
 * Owns the Omen sub-phase that sits at the front of INCOME (§10 phase 1):
 *   - drawing one card from the current era's active deck (§12 "one card per
 *     round"), moving it to the discard, and resolving its effect;
 *   - reshuffling the discard when the active deck empties (EVENT_CARDS.md
 *     "when an era deck empties, reshuffle its discards");
 *   - retiring the previous era and shuffling in the new era deck when the round
 *     crosses an era boundary (Era I rounds 1–5 / II 6–10 / III 11–16);
 *   - for 4–5 player games, additionally revealing the *next* card as a
 *     telegraphed "gathering omen" (peeked, not resolved — CONTRACT §9 item 9 /
 *     balance.OMEN_DRAW);
 *   - posting an {@link ActiveModifier} for every Standing/Persistent/Held card
 *     so combat/economy/movement enforce the lasting effect, and arming the
 *     Constantinople sudden-death flag on #46.
 *
 * Pure: all randomness flows through a single {@link Rng} derived from
 * `state.rngSeed`/`state.rngCursor`; the advanced cursor is written back onto the
 * returned state so the next consumer continues the identical stream. Card data
 * and per-card effect functions live in ./cards.ts.
 */
import type { ActiveModifier, GameState } from "@imperium/shared";
import { Faction } from "@imperium/shared";
import { makeRng } from "../rng.js";
import { addModifier } from "../modifiers.js";
import { appendLog } from "../logEntry.js";
import { ERA_BOUNDARIES, OMEN_DRAW } from "../balance.js";
import {
  EVENT_CARD_BY_ID,
  EVENT_EFFECT_BY_ID,
  type EventCard,
  type EventEffectContext,
} from "./cards.js";

export * from "./cards.js";

/** True when some seated player currently plays `faction`. */
function factionInPlay(state: GameState, faction: Faction): boolean {
  return state.players.some((p) => p.faction === faction);
}

/**
 * The era (1|2|3) a round belongs to (§10 / EVENT_CARDS Era I 1–5 / II 6–10 /
 * III 11–16). Derived locally from balance.ERA_BOUNDARIES to avoid a module
 * cycle with roundLoop (which imports drawOmen); mirrors roundLoop.eraForRound.
 */
function eraForRound(round: number): 1 | 2 | 3 {
  for (const era of [1, 2, 3] as const) {
    const [first, last] = ERA_BOUNDARIES[era];
    if (round >= first && round <= last) return era;
  }
  return 3;
}

/**
 * Standing/Persistent/Held modifiers a durable Omen card posts onto the
 * `activeModifiers` side-channel. Immediate/Grant cards apply once inside their
 * effect fn and post nothing here. The effect fns themselves apply the
 * directly-representable one-time deltas (treasury/prestige/wall/garrison); this
 * side-channel carries the *lasting* part that later rounds/subsystems must read.
 *
 * `expiresRound = round + durationRounds − 1`: a card posted in round R lasting
 * D rounds is active during R … R+D−1 and lapses at that round's cleanup (see
 * modifiers.expireRoundModifiers, which drops mods with `expiresRound <= round`).
 * Rounds-scoped expiry itself is driven by roundLoop cleanup — see the
 * NEEDS-FROM-INTEGRATOR note.
 */
function buildCardModifiers(
  card: EventCard,
  state: GameState,
  targetFaction: Faction | null = null,
): ActiveModifier[] {
  const round = state.round;
  const d = card.effects.durationRounds ?? 0;
  const expires = round + Math.max(1, d) - 1;
  const mid = (suffix: string): string => `${card.id}:${suffix}`;

  // The drawer (active player) and its faction — the enshrining/owning faction for
  // drawer-scoped standing bonuses (FL-19b #39 Relic Discovered).
  const drawerId = state.turnOrder[state.activePlayerIndex] ?? null;
  const drawerFaction =
    drawerId != null ? (state.players.find((p) => p.id === drawerId)?.faction ?? null) : null;

  switch (card.n) {
    // #9 Discovery of Alum — STANDING: whoever holds Chios gains +2 gold/round.
    case 9:
      return [
        {
          id: mid("income"),
          sourceCardId: card.id,
          scope: "game",
          kind: "income",
          value: 2,
          target: { provinceId: "chios" },
          data: { perRoundGold: 2 },
        },
      ];
    // #10 Marriage Alliance — HELD: a 2-round NAP / −50% vassal option to spend.
    case 10:
      return [
        {
          id: mid("held"),
          sourceCardId: card.id,
          scope: "persistent",
          kind: "held",
          expiresRound: round + 1,
          data: { napRounds: 2, vassalTributeDiscount: 0.5 },
        },
      ];
    // #18 Venetian–Genoese War — STANDING 2 rounds: forced fights, −2 trade each.
    case 18:
      return [
        {
          id: mid("trade"),
          sourceCardId: card.id,
          scope: "persistent",
          kind: "trade_mod",
          value: -2,
          expiresRound: expires,
          data: { forcedFight: [Faction.VENICE, Faction.GENOA] },
        },
      ];
    // #28 Papal Interdict — PERSISTENT 2 rounds: faith income 0, no crusade.
    // EVENT_CARDS.md Era II #28 ("Target loses all ✝️ income for 2 rounds"):
    // the interdict falls on the INTERDICTED (target) faction ALONE, not every
    // seated player. Scope the faith_income modifier to `target:{faction}` so
    // economy's faith reader (getModifiers 'faith_income' filtered by faction)
    // zeroes only that faction — an untargeted modifier is treated as global by
    // appliesTo() and would wrongly zero everyone. On the neutral/no-target omen
    // path (no interdicted player) post nothing at all.
    case 28:
      if (!targetFaction) return [];
      return [
        {
          id: mid("faith"),
          sourceCardId: card.id,
          scope: "persistent",
          kind: "faith_income",
          value: 0,
          target: { faction: targetFaction },
          expiresRound: expires,
          data: { multiplier: 0, noCrusade: true },
        },
      ];
    // #32 Hexamilion Rebuilt — STANDING: +1 defence at Morea vs Athens.
    case 32:
      return [
        {
          id: mid("def"),
          sourceCardId: card.id,
          scope: "game",
          kind: "combat_mod",
          value: 1,
          target: { provinceId: "morea" },
          data: { vs: "athens" },
        },
      ];
    // #34 The Great Bombard Forged — STANDING: Ottoman unlocks the Great Bombard.
    // Only reached when an Ottoman is in play (guarded by the faction-target check
    // in resolveCard); with no Ottoman the effect logs an auction instead.
    case 34:
      return [
        {
          id: mid("unlock"),
          sourceCardId: card.id,
          scope: "game",
          kind: "unlock",
          target: { faction: Faction.OTTOMAN },
          data: { unlock: "GREAT_BOMBARD" },
        },
      ];
    // #35 Black Death Returns — PERSISTENT 2 rounds: cities/HV −1 grain/−1 gold, cull.
    case 35:
      return [
        {
          id: mid("plague"),
          sourceCardId: card.id,
          scope: "persistent",
          kind: "plague",
          expiresRound: expires,
          data: { grain: -1, gold: -1, cullRatio: 3 },
        },
      ];
    // #36 Gunpowder Revolution — STANDING (rest of game): +1 siege, walls −1 tier.
    case 36:
      return [
        {
          id: mid("siege"),
          sourceCardId: card.id,
          scope: "game",
          kind: "siege_mod",
          value: 1,
        },
        {
          id: mid("wall"),
          sourceCardId: card.id,
          scope: "game",
          kind: "wall_mod",
          value: -1,
        },
      ];
    // #39 Relic Discovered — STANDING: +1 gold/round pilgrimage at the enshrined
    // faith province (EVENT_CARDS.md #39). FL-19b: the `income` reader only pays a
    // TARGETED modifier (untargeted income mods are ignored — economy
    // incomeModifierGold), so scope this to the owning/target faction (the drawer
    // who enshrined the relic) so the +1 🪙/round is actually attributed each round.
    case 39:
      return [
        {
          id: mid("income"),
          sourceCardId: card.id,
          scope: "game",
          kind: "income",
          value: 1,
          ...(drawerFaction ? { target: { faction: drawerFaction } } : {}),
          data: { perRoundGold: 1 },
        },
      ];
    default:
      return [];
  }
}

/**
 * Draw (and resolve) this round's shared Omen. §12 / EVENT_CARDS.md draw rules:
 *
 *  1. On crossing into a not-yet-entered era, retire the previous era's cards and
 *     shuffle in the new era deck (the era whose deck still sits in
 *     `eraDecksRemaining`).
 *  2. If the active deck is empty, reshuffle its discards back into it.
 *  3. Draw the front card, move it to `omenDiscard`, and resolve its effect.
 *  4. For 4–5 player games, reveal the next card as a telegraphed "gathering
 *     omen" (balance.OMEN_DRAW.gatheringOmenMinPlayers) — peeked, not resolved.
 *
 * Pure: one RNG derived from state seed/cursor drives every shuffle; the advanced
 * cursor is threaded onto the returned state (and into resolveCard, which
 * continues the same stream).
 */
export function drawOmen(state: GameState): GameState {
  const rng = makeRng(state.rngSeed, state.rngCursor);
  let s: GameState = state;

  // (1) §12 era transition: retire the previous deck, shuffle in the new era's.
  const targetEra = eraForRound(state.round);
  const pending = state.eraDecksRemaining[targetEra];
  if (pending) {
    const shuffled = rng.shuffle(pending);
    const remaining: Partial<Record<1 | 2 | 3, string[]>> = { ...state.eraDecksRemaining };
    delete remaining[targetEra];
    s = {
      ...s,
      omenDeck: shuffled,
      omenDiscard: [],
      eraDecksRemaining: remaining,
      rngCursor: rng.cursor,
    };
    s = appendLog(s, {
      round: s.round,
      phase: s.phase,
      type: "event_card",
      actors: [],
      message: `Era ${targetEra} dawns: the omens of the previous age are retired and a fresh deck is shuffled in.`,
      data: { era: targetEra, deckSize: shuffled.length },
    });
  }

  // (2) Empty-deck reshuffle: shuffle the discards back into the active deck.
  if (s.omenDeck.length === 0 && s.omenDiscard.length > 0) {
    const reshuffled = rng.shuffle(s.omenDiscard);
    s = { ...s, omenDeck: reshuffled, omenDiscard: [], rngCursor: rng.cursor };
    s = appendLog(s, {
      round: s.round,
      phase: s.phase,
      type: "event_card",
      actors: [],
      message: "The Omen deck is exhausted; its discards are reshuffled.",
      data: { deckSize: reshuffled.length },
    });
  }

  // Nothing left to draw (defensive — the eras hold enough cards for 16 rounds).
  if (s.omenDeck.length === 0) {
    return { ...s, rngCursor: rng.cursor };
  }

  // (3) Draw the front card and move it to the discard pile.
  const [cardId, ...rest] = s.omenDeck;
  s = {
    ...s,
    omenDeck: rest,
    omenDiscard: [...s.omenDiscard, cardId],
    rngCursor: rng.cursor,
  };

  // (4) 4–5 player "gathering omen": telegraph (but do not resolve) the next card.
  if (s.players.length >= OMEN_DRAW.gatheringOmenMinPlayers && rest.length > 0) {
    const gathering = rest[0];
    s = appendLog(s, {
      round: s.round,
      phase: s.phase,
      type: "event_card",
      actors: [],
      targets: [gathering],
      message: `A gathering omen looms on the horizon: ${EVENT_CARD_BY_ID[gathering]?.name ?? gathering}.`,
      data: { gatheringOmen: gathering },
    });
  }

  return resolveCard(s, cardId);
}

/**
 * Apply a single Omen card's effect to the state (§12).
 *
 * Runs the card's pure effect fn (from EVENT_EFFECT_BY_ID) for the one-time,
 * directly-representable deltas, then:
 *   - posts the Standing/Persistent/Held {@link ActiveModifier}(s) the card
 *     leaves in play (see {@link buildCardModifiers}) so later subsystems enforce
 *     the lasting effect — unless the card is faction-specific and that faction
 *     is not in play (EVENT_CARDS.md: treated as a neutral no-op);
 *   - arms the Constantinople sudden-death flag for #46 (the effect fn already
 *     applies the +5 prestige and updates `constantinopleHold`; here we post the
 *     `sudden_death` modifier that prestige/checkVictory reads).
 *
 * Pure: derives its RNG from state seed/cursor and threads the advanced cursor
 * back. The drawing faction is the active player; choice/target inputs (for cards
 * that need them) arrive later via the PLAY_CARD action layer.
 */
export function resolveCard(
  state: GameState,
  cardId: string,
  ctxInput: { targetPlayerId?: string; targetProvinceId?: string; choice?: string } = {},
): GameState {
  const card = EVENT_CARD_BY_ID[cardId];
  const effect = EVENT_EFFECT_BY_ID[cardId];
  if (!card || !effect) return state;

  const rng = makeRng(state.rngSeed, state.rngCursor);
  const activeId = state.turnOrder[state.activePlayerIndex] ?? null;
  // FL-03 (EVENT_CARDS.md #28 Papal Interdict + other targeted cards): the
  // PLAY_CARD action layer (actions.ts) threads `targetPlayerId`/`targetProvinceId`/
  // `choice` here (PLAY_CARD carries them per CONTRACT §2). The Omen-draw path
  // (drawOmen) calls with no target, so the neutral-omen branches fire. Without
  // this, ctx.targetPlayerId was always undefined and #28's faith_income modifier
  // could never be scoped to the interdicted faction.
  const ctx: EventEffectContext = {
    drawerId: activeId,
    rng,
    targetPlayerId: ctxInput.targetPlayerId,
    targetProvinceId: ctxInput.targetProvinceId,
    choice: ctxInput.choice,
  };

  // EVENT_CARDS.md: a faction-specific card with no valid target resolves as a
  // neutral no-op — the effect fn logs the neutral reading; we skip its durable
  // modifiers so nothing lingers on the board.
  const hasTarget = !card.factionSpecific || factionInPlay(state, card.factionSpecific);

  let next = effect(state, ctx);
  next = { ...next, rngCursor: rng.cursor };

  // EVENT_CARDS.md Era II #28 (Papal Interdict): the interdict targets a single
  // player (ctx.targetPlayerId). Resolve that player's faction so the durable
  // faith_income modifier can be scoped to it — untargeted → economy zeroes
  // every faction. When no interdicted player is supplied the effect fn takes
  // the neutral-omen path and buildCardModifiers posts nothing for #28.
  const targetFaction =
    ctx.targetPlayerId != null
      ? (next.players.find((p) => p.id === ctx.targetPlayerId)?.faction ?? null)
      : null;

  if (hasTarget) {
    for (const mod of buildCardModifiers(card, next, targetFaction)) {
      next = addModifier(next, mod);
    }
  }

  // #46 The Fall of Constantinople — arm sudden death (§13.3). The +5 prestige
  // and constantinopleHold update live in the effect fn; the actual two-round
  // sudden-death win is enforced by prestige.checkVictory / roundLoop, which
  // reads this flag.
  if (card.n === 46) {
    next = addModifier(next, {
      id: `${card.id}:sudden-death`,
      sourceCardId: card.id,
      scope: "game",
      kind: "sudden_death",
      target: next.constantinopleHold.faction
        ? { faction: next.constantinopleHold.faction }
        : undefined,
      data: {
        holder: next.constantinopleHold.faction,
        armedRound: next.round,
        province: "constantinople",
      },
    });
  }

  return next;
}
