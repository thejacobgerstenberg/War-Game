/**
 * mercenaries.ts — the mercenary bid market subsystem (§6.3).
 *
 * Owns the shared free-company market: revealing 2–3 named companies each round
 * (seeded RNG), turn-order raise-or-pass bidding, fielding the winning company
 * as mercenary-tagged units in the winner's capital or an owned CITY (a gold
 * sink), and handing unsold companies to a random NPC minor on a 1d6 ≤ 2 roll.
 *
 * CANON #6 / GD §6.2: the Genoa ×1.0-gold / waived-surcharge benefit is scoped to
 * ORDINARY mercenary hiring (the RECRUIT `mercenary` path, §6.2) — it does NOT
 * apply to bid-market bids. In this auction (§6.3) EVERY faction, Genoa included,
 * bids and pays at FACE VALUE: the winner pays exactly the winning bid in gold
 * (GD §6.3 step 3, "paying the winning bid in gold"). There is no ×1.5 premium
 * and no Genoa ×1.0 discount here — those live in the §6.2 ordinary-hire path.
 *
 * Every number is read from balance.MERC_COMPANIES / MERC_MARKET. Functions are
 * pure: they treat the input state as immutable and return a new GameState. The
 * only randomness (market composition, the NPC-hire roll) flows through the
 * seeded RNG derived from `state.rngSeed`/`state.rngCursor`, whose advanced
 * cursor is written back onto the returned state (determinism).
 *
 * Mercenary tag: fielded units are marked via a `mercenaries` map attached to
 * the Army stack (base + count), which is exactly what `economy.upkeep` /
 * `economy.grainDue` read to charge the ×2 grain, desert-first upkeep (§4.4).
 * That map is not (yet) a field on the shared `Army` type — it is attached via a
 * cast, mirroring how economy.ts reads it. See NEEDS-FROM-INTEGRATOR.
 */
import {
  GamePhase,
  TerrainType,
  UnitType,
  type GameAction,
  type GameState,
  type MercCompanyOffer,
  type Player,
  type Province,
} from "@imperium/shared";
import { MERC_COMPANIES, MERC_MARKET, type MercCompanyDef } from "./balance.js";
import { emptyUnits } from "./gameState.js";
import { appendLog } from "./logEntry.js";
import { makeRng, type Rng } from "./rng.js";
import { EngineError } from "./actions.js";

// ---------------------------------------------------------------------------
// Mercenary-tag helper (the field economy.upkeep reads; attached via cast)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Total unit heads in a company roster (generic units + named variants). */
function rosterSize(def: MercCompanyDef): number {
  let n = 0;
  for (const c of Object.values(def.roster)) n += c ?? 0;
  for (const v of def.variants ?? []) n += v.count;
  return n;
}

/**
 * The legal province a player may field a company in (§6.3): their capital, else
 * any owned CITY-terrain province. Undefined when the player controls neither.
 */
function fieldLocation(state: GameState, player: Player): Province | undefined {
  const capital = state.provinces.find(
    (p) =>
      p.ownerId === player.id &&
      player.faction != null &&
      p.isCapitalOf === player.faction,
  );
  if (capital) return capital;
  return state.provinces.find(
    (p) => p.ownerId === player.id && p.terrain === TerrainType.CITY,
  );
}

// ---------------------------------------------------------------------------
// Fielding the winner (gold sink + mercenary-tagged roster)
// ---------------------------------------------------------------------------

/**
 * Resolve an offer with a standing high bid: the winner pays the winning bid in
 * gold at FACE VALUE (GD §6.3 step 3 gold sink) and instantly fields the
 * company's roster as mercenary-tagged units in a legal city (capital or owned
 * CITY). Marks the offer sold. Per CANON #6 / GD §6.2 the Genoa ×1.0 benefit is
 * ordinary-hire-only, so NO faction multiplier is applied here — Genoa pays the
 * same face-value bid as everyone else. If the winner controls no legal city or
 * can no longer afford the bid, the company disperses (still marked resolved).
 * Deterministic — consumes no RNG. Pure.
 */
function fieldCompany(state: GameState, companyId: string): GameState {
  const next = structuredClone(state) as GameState;
  const offer = next.mercMarket.find((o) => o.companyId === companyId && !o.sold);
  if (!offer || offer.highBidderId == null) return state; // nothing to resolve
  const def = MERC_COMPANIES[companyId];
  const winner = next.players.find((p) => p.id === offer.highBidderId);
  if (!def || !winner) return state;

  // GD §6.3 step 3: the winner pays the winning bid in gold, face value. No ×1.5
  // premium and no Genoa ×1.0 discount in the auction (CANON #6 / §6.2 — those
  // multipliers belong to the §6.2 ordinary-hire RECRUIT path, not the market).
  const price = offer.currentBid;
  const loc = fieldLocation(next, winner);

  if (!loc || winner.treasury.gold < price) {
    // §6.3 no legal city to field in (or the purse can no longer cover the
    // winning bid): the company disperses and the bid lapses.
    offer.sold = true;
    return appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "mercenary",
      actors: [winner.id],
      targets: [companyId],
      message: `${def.name} finds no city to garrison and disperses; ${winner.name}'s bid lapses.`,
      data: { companyId, bid: offer.currentBid, price, fielded: false },
    });
  }

  winner.treasury.gold -= price; // §6.3 the winning bid is a gold sink
  offer.sold = true;

  // Merge into an existing stack the winner already holds at the city, else a
  // new army; tag every fielded head as a mercenary for the ×2/desert-first
  // upkeep economy.upkeep applies (§4.4).
  let army = next.armies.find(
    (a) => a.ownerId === winner.id && a.locationId === loc.id,
  );
  if (!army) {
    army = {
      id: `merc-${winner.id}-${loc.id}-r${next.round}`,
      ownerId: winner.id,
      locationId: loc.id,
      units: emptyUnits(),
      variants: [],
    };
    next.armies.push(army);
  }
  if (!army.mercenaries) army.mercenaries = {};

  // Generic roster heads: field as plain units and tag them mercenary for the
  // §4.4 ×2 / desert-first upkeep the mercenaries map drives (economy.mercCount).
  for (const [key, count] of Object.entries(def.roster)) {
    const u = key as UnitType;
    const c = count ?? 0;
    army.units[u] = (army.units[u] ?? 0) + c;
    army.mercenaries[u] = (army.mercenaries[u] ?? 0) + c;
  }
  // §6.3 (GD line 304) FL-10: elite companies (the Varangian Remnant) field as
  // named UnitVariantStack heads, NOT plain roster units, so combat's variant
  // effective-CV lookup applies the +1 DEF from UNIQUE_UNIT_OVERRIDES on defence
  // (combat.ts reads def.defMod on the defender role). These heads ARE mercenaries
  // for §4.4 (double upkeep / desert-first): their variant carries the
  // `elite-mercenary` ability tag. The current `mercenaries` map is keyed by
  // UnitType and clamped to generic `units`, so it cannot tag variant heads —
  // economy must recognise `elite-mercenary` variants as mercenaries for §4.4.
  // See NEEDS-FROM-INTEGRATOR (economy.ts grainDue / upkeep desertion).
  for (const v of def.variants ?? []) {
    army.variants = army.variants ?? [];
    army.variants.push({ ...v });
  }

  return appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "mercenary",
    actors: [winner.id],
    targets: [companyId, loc.id],
    message: `${winner.name} hires ${def.name} for ${price} gold; the company musters at ${loc.name}.`,
    data: { companyId, bid: offer.currentBid, price, location: loc.id, fielded: true },
  });
}

// ---------------------------------------------------------------------------
// Unsold companies → random NPC minor (§6.3 / §11.5)
// ---------------------------------------------------------------------------

/**
 * Resolve an unsold company (all players passed): on a 1d6 ≤ npcHireRoll it is
 * hired by a random NPC minor, strengthening that minor's garrison by the
 * roster's head count (§6.3 / §11.5); otherwise it simply leaves. Consumes the
 * shared RNG (the caller persists the cursor). Pure.
 */
function resolveUnsold(state: GameState, companyId: string, rng: Rng): GameState {
  const def = MERC_COMPANIES[companyId];
  const roll = rng.rollD6(); // §6.3 1-in-3 chance (1d6 ≤ 2)
  if (roll > MERC_MARKET.npcHireRoll || state.minors.length === 0) {
    return appendLog(state, {
      round: state.round,
      phase: state.phase,
      type: "mercenary",
      actors: [],
      targets: [companyId],
      message: `${def?.name ?? companyId} finds no paymaster and disbands.`,
      data: { companyId, roll, hired: false },
    });
  }
  const next = structuredClone(state) as GameState;
  const idx = Math.floor(rng.next() * next.minors.length);
  const minor = next.minors[idx];
  const added = rosterSize(def);
  minor.garrison += added; // §11.5 the minor's garrison is reinforced
  return appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "mercenary",
    actors: [minor.id],
    targets: [companyId],
    message: `${def.name} takes service with ${minor.name}, reinforcing its garrison (+${added}).`,
    data: { companyId, roll, hired: true, minorId: minor.id, garrison: minor.garrison },
  });
}

// ---------------------------------------------------------------------------
// refreshMercMarket — resolve the outgoing row, then seed a fresh one (§6.3)
// ---------------------------------------------------------------------------

/**
 * Refresh the round's mercenary market (§6.3). First resolves the outgoing row:
 * every offer with a standing high bid is fielded to its winner (gold sink), and
 * every truly unbid offer rolls the NPC-hire check. Then reveals 2–3 fresh,
 * unbid company offers chosen via the seeded RNG. Derives the RNG from state and
 * writes the advanced cursor back onto the returned state. Pure.
 */
export function refreshMercMarket(state: GameState): GameState {
  const rng = makeRng(state.rngSeed, state.rngCursor);
  let next: GameState = state;

  // 1) Resolve the outgoing market row.
  for (const offer of state.mercMarket) {
    if (offer.sold) continue;
    if (offer.highBidderId != null) {
      next = fieldCompany(next, offer.companyId); // standing bid wins (no RNG)
    } else {
      next = resolveUnsold(next, offer.companyId, rng); // unbid → NPC roll
    }
  }

  // 2) Seed 2–3 fresh companies (§6.3): pick a count in [min,max], then that many
  //    distinct companies from the company deck via the seeded RNG. Bids reset.
  const span =
    MERC_MARKET.maxCompaniesPerRound - MERC_MARKET.minCompaniesPerRound + 1;
  const count = MERC_MARKET.minCompaniesPerRound + Math.floor(rng.next() * span);
  const companyIds = rng.shuffle(Object.keys(MERC_COMPANIES)).slice(0, count);
  const offers: MercCompanyOffer[] = companyIds.map((companyId) => ({
    companyId,
    currentBid: 0,
    highBidderId: null,
    sold: false,
    // DA-3 (§6.3 step 2, CANON CLARIFICATION 3): each offer runs a true round-robin
    // voluntary-pass auction. Seed the pass set empty and leave the round-robin
    // pointer DELIBERATELY unset: this refresh runs at END cleanup BEFORE the
    // §13.4 turn-order re-sort (roundLoop), so seeding turnOrder[0] here would
    // pin a STALE opener. applyMercBid derives the expected opening bidder
    // lazily from the current turn order and the first raise/pass populates the
    // pointer (marshal minors, mercenaries.ts:434). Prep4 added these fields.
    passedPlayerIds: [],
    activeBidderId: undefined,
  }));

  // New top-level object (never mutate the input); persist the advanced cursor.
  next = { ...next, mercMarket: offers, rngCursor: rng.cursor };
  return appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "mercenary",
    actors: [],
    targets: companyIds,
    message: `The mercenary market opens with ${count} free ${
      count === 1 ? "company" : "companies"
    } for hire.`,
    data: { companies: companyIds },
  });
}

// ---------------------------------------------------------------------------
// Round-robin auction close (§6.3 step 2 / CANON CLARIFICATION 3, DA-3)
// ---------------------------------------------------------------------------

/**
 * The ordered set of players eligible to bid on an offer: turn order (§6.3 step 2
 * "bidders take turns in turn-order"), filtered to seated players, with any player
 * missing from `turnOrder` appended defensively. Pure, deterministic.
 */
function biddersOf(state: GameState): string[] {
  const ids = state.players.map((p) => p.id);
  const order = state.turnOrder.filter((id) => ids.includes(id));
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return order;
}

/**
 * The next active (non-passed) bidder in cyclic turn order after the current high
 * bidder — the round-robin pointer (`activeBidderId`) whose turn it is to respond.
 * Undefined when nobody but the high bidder is still active. Pure.
 */
function nextActiveBidder(
  bidders: string[],
  active: Set<string>,
  highBidderId: string | null,
): string | undefined {
  const others = bidders.filter((id) => id !== highBidderId && active.has(id));
  if (others.length === 0) return undefined;
  if (highBidderId == null) return others[0];
  const start = bidders.indexOf(highBidderId);
  for (let k = 1; k <= bidders.length; k++) {
    const id = bidders[(start + k) % bidders.length];
    if (id !== highBidderId && active.has(id)) return id;
  }
  return others[0];
}

/**
 * Resolve one step of the §6.3 step 2 round-robin after a raise or pass has been
 * recorded on the offer:
 *  1. AUTO-PASS sweep — CANON CLARIFICATION 3 keeps affordability ONLY as an
 *     auto-pass: a still-active rival (not the high bidder) who cannot afford the
 *     minimum legal raise (`currentBid + minBidRaise`) is forced to pass.
 *  2. Advance the round-robin pointer (`activeBidderId`) to the next active bidder.
 *  3. CLOSE when only one non-passed bidder remains (§6.3 step 2). If that lone
 *     survivor is the high bidder, field the company at once — winner pays the
 *     current high bid at face value (step 3, gold sink). With no high bid yet
 *     (everyone else passed on an unopened offer) the offer is left unsold for the
 *     `refreshMercMarket` NPC-hire roll.
 * Pure, deterministic — consumes no RNG. `state` is already a working clone.
 */
function resolveAuctionRound(state: GameState, companyId: string): GameState {
  const offer = state.mercMarket.find((o) => o.companyId === companyId && !o.sold);
  if (!offer) return state;
  const passed = new Set(offer.passedPlayerIds ?? []);
  const bidders = biddersOf(state);

  // 1) Auto-pass sweep (affordability = forced pass ONLY, CANON CLARIFICATION 3).
  if (offer.highBidderId != null) {
    const minRaise = offer.currentBid + MERC_MARKET.minBidRaise;
    for (const id of bidders) {
      if (passed.has(id) || id === offer.highBidderId) continue;
      const p = state.players.find((x) => x.id === id);
      if (!p || p.treasury.gold < minRaise) passed.add(id); // cannot afford → forced pass
    }
  }
  offer.passedPlayerIds = [...passed];

  // 2) Active (non-passed) bidders + round-robin pointer.
  const active = new Set(bidders.filter((id) => !passed.has(id)));
  offer.activeBidderId = nextActiveBidder(bidders, active, offer.highBidderId);

  // 3) §6.3 step 2 close: only one non-passed bidder remains.
  if (active.size <= 1) {
    if (offer.highBidderId != null) {
      offer.activeBidderId = undefined;
      return fieldCompany(state, companyId); // step 3: winner pays face value, fields
    }
    // No bid ever placed → leave unsold; refreshMercMarket runs the NPC-hire roll.
  }
  return state;
}

// ---------------------------------------------------------------------------
// applyMercBid — round-robin raise-or-pass bidding (§6.3 step 2)
// ---------------------------------------------------------------------------

/**
 * Apply a MERC_BID action (§6.3 step 2, the TRUE round-robin voluntary-pass
 * auction ratified by CANON CLARIFICATION 3 / DA-3). A MERC_BID is either:
 *  - a RAISE — an opening bid ≥ the company minimum, or a raise of ≥ minBidRaise
 *    over the current high bid; the bidder must hold the gold. Records the new
 *    high bid and makes the issuer the high bidder.
 *  - a voluntary PASS (`action.pass === true`) — the issuer withdraws from this
 *    offer's round-robin (recorded in `passedPlayerIds`); `bid` is ignored.
 *
 * PHASE WINDOW (marshal minors, mercenaries.ts:434): a MERC_BID is only legal
 * during the §6.3 INCOME window — any other phase throws `WRONG_PHASE`.
 * DECISION: the existing contract-§8 `WRONG_PHASE` code is REUSED rather than
 * minting a `MERC_WRONG_PHASE` — transport/clients already handle it and the
 * rejection semantics ("this action is illegal in the current phase") are
 * identical. Only the PLAYER ACTION is gated: `refreshMercMarket`'s END-cleanup
 * resolution (standing-bid fielding, unsold → NPC-minor roll) is NOT phase-gated
 * and still resolves in whatever phase the round loop calls it.
 *
 * ROUND-ROBIN POINTER (same minors item): a raise or pass from anyone but the
 * offer's `activeBidderId` throws `MERC_OUT_OF_TURN` (before any clone — state
 * untouched). When the pointer is still unset (a freshly revealed offer — see
 * {@link refreshMercMarket}, which deliberately leaves it undefined because the
 * §13.4 turn-order re-sort runs AFTER the market refresh in cleanup), the
 * expected bidder is derived lazily from the CURRENT turn order:
 * {@link nextActiveBidder} over the non-passed bidders — i.e. the first
 * non-passed player in turn order on an unopened offer, or the next non-passed
 * rival after the high bidder on a hand-seeded one. Each accepted raise/pass
 * then advances the pointer via {@link resolveAuctionRound}, skipping passed
 * and auto-passed bidders.
 *
 * After the raise/pass is recorded the round-robin advances
 * ({@link resolveAuctionRound}): rivals who cannot afford the minimum legal raise
 * are AUTO-passed (affordability is retained ONLY as a forced pass — CANON
 * CLARIFICATION 3), and the auction CLOSES when only one non-passed bidder
 * remains, whereupon that lone survivor (the high bidder) is fielded at once and
 * pays the current high bid at FACE VALUE (§6.3 step 3, gold sink). Throws
 * {@link EngineError} on any illegal bid/pass. Pure — consumes no RNG.
 */
export function applyMercBid(state: GameState, action: GameAction): GameState {
  if (action.type !== "MERC_BID") {
    throw new EngineError(
      "UNKNOWN_ACTION",
      "applyMercBid requires a MERC_BID action.",
    );
  }
  const player = state.players.find((p) => p.id === action.player);
  if (!player) throw new EngineError("UNKNOWN_PLAYER", "No such player.");

  // §6.3 window gate (marshal minors, mercenaries.ts:434): bidding/passing is an
  // INCOME-phase flow. Reuses the contract-§8 WRONG_PHASE code (documented in the
  // fn docblock — no new MERC_WRONG_PHASE). Thrown before any clone: state untouched.
  if (state.phase !== GamePhase.INCOME) {
    throw new EngineError(
      "WRONG_PHASE",
      `MERC_BID is only legal during the INCOME phase (§6.3); the game is in ${state.phase}.`,
    );
  }

  const offer = state.mercMarket.find((o) => o.companyId === action.companyId);
  if (!offer) {
    throw new EngineError(
      "UNKNOWN_COMPANY",
      `No company ${action.companyId} in the market.`,
    );
  }
  if (offer.sold) {
    throw new EngineError(
      "MERC_CLOSED",
      `Bidding for ${action.companyId} has already closed.`,
    );
  }
  const def = MERC_COMPANIES[action.companyId];

  // §6.3 step 2: a bidder who has already passed is out of this offer's
  // round-robin and may not re-enter (voluntary passes are permanent — the
  // "one non-passed bidder remains" close only converges if passing is monotonic).
  const alreadyPassed = offer.passedPlayerIds ?? [];
  if (alreadyPassed.includes(player.id)) {
    throw new EngineError(
      "MERC_PASSED",
      `${player.name} has already passed on ${def.name} and cannot bid again.`,
    );
  }

  // §6.3 step 2 round-robin pointer (marshal minors, mercenaries.ts:434): only
  // the offer's active bidder may raise OR pass. With the pointer unset (fresh
  // offer — refreshMercMarket leaves it undefined so the §13.4 turn-order re-sort,
  // which runs AFTER the market refresh in cleanup, governs the new round's
  // opening bidder), derive it from the CURRENT turn order: the next non-passed
  // bidder after the high bidder, or the first non-passed player when unopened.
  // Thrown before any clone: a rejected out-of-turn bid leaves state untouched.
  const bidders = biddersOf(state);
  const expectedBidder =
    offer.activeBidderId ??
    nextActiveBidder(
      bidders,
      new Set(bidders.filter((id) => !alreadyPassed.includes(id))),
      offer.highBidderId,
    );
  if (expectedBidder !== undefined && expectedBidder !== player.id) {
    const expected = state.players.find((p) => p.id === expectedBidder);
    throw new EngineError(
      "MERC_OUT_OF_TURN",
      `It is ${expected?.name ?? expectedBidder}'s turn to raise or pass on ${def.name}, not ${player.name}'s.`,
    );
  }

  // -------------------------------------------------------------------------
  // Voluntary pass (DA-3): withdraw from the round-robin; the auction closes if
  // this leaves only one non-passed bidder (§6.3 step 2).
  // -------------------------------------------------------------------------
  if (action.pass === true) {
    let next = structuredClone(state) as GameState;
    const offerRef = next.mercMarket.find((o) => o.companyId === action.companyId)!;
    offerRef.passedPlayerIds = [...(offerRef.passedPlayerIds ?? []), player.id];
    next = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "mercenary",
      actors: [player.id],
      targets: [action.companyId],
      message: `${player.name} passes on the ${def.name}.`,
      data: { companyId: action.companyId, pass: true },
    });
    return resolveAuctionRound(next, action.companyId);
  }

  // -------------------------------------------------------------------------
  // Raise (opening bid or out-raise).
  // -------------------------------------------------------------------------
  const bid = action.bid;
  if (!Number.isInteger(bid) || bid <= 0) {
    throw new EngineError("BAD_MERC_BID", "A bid must be a positive whole-gold amount.");
  }

  // §6.3 opening bid ≥ the company minimum; a raise must exceed the high bid by
  // at least minBidRaise (a bidder unwilling/unable to do so should PASS instead).
  if (offer.highBidderId == null) {
    if (bid < def.minBid) {
      throw new EngineError(
        "BAD_MERC_BID",
        `The opening bid for ${def.name} must be at least ${def.minBid} gold.`,
      );
    }
  } else if (bid < offer.currentBid + MERC_MARKET.minBidRaise) {
    throw new EngineError(
      "BAD_MERC_BID",
      `A bid must raise the current ${offer.currentBid} by at least ${MERC_MARKET.minBidRaise} gold.`,
    );
  }

  // §6.3 the bidder must be able to cover the bid.
  if (player.treasury.gold < bid) {
    throw new EngineError(
      "INSUFFICIENT_RESOURCES",
      `${player.name} lacks the gold to bid ${bid}.`,
    );
  }

  let next = structuredClone(state) as GameState;
  const offerRef = next.mercMarket.find((o) => o.companyId === action.companyId)!;
  offerRef.currentBid = bid;
  offerRef.highBidderId = player.id;
  next = appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "mercenary",
    actors: [player.id],
    targets: [action.companyId],
    message: `${player.name} bids ${bid} gold for the ${def.name}.`,
    data: { companyId: action.companyId, bid },
  });

  // §6.3 step 2 (CANON CLARIFICATION 3 / DA-3): advance the true round-robin —
  // auto-pass rivals who cannot afford the minimum raise, then close the auction
  // (and field the winner at face value) when only one non-passed bidder remains.
  return resolveAuctionRound(next, action.companyId);
}
