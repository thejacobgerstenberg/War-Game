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
// applyMercBid — turn-order raise-or-pass bidding (§6.3)
// ---------------------------------------------------------------------------

/**
 * Apply a MERC_BID action (§6.3). Validates the raise (an opening bid ≥ the
 * company's minimum, or a raise of ≥ minBidRaise over the current high bid — a
 * player who does neither has effectively passed) and that the bidder holds the
 * gold, then records the new high bid. Bidding closes when no other player can
 * legally out-raise, at which point the winner is fielded immediately (gold sink
 * + instant fielding). Throws {@link EngineError} on any illegal bid. Pure.
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
  const bid = action.bid;
  if (!Number.isInteger(bid) || bid <= 0) {
    throw new EngineError("BAD_MERC_BID", "A bid must be a positive whole-gold amount.");
  }

  // §6.3 opening bid ≥ the company minimum; a raise must exceed the high bid by
  // at least minBidRaise. Failing either means the player has passed, not bid.
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

  // §6.3 step 2: bidding proceeds round-robin in turn order; each rival either
  // raises by ≥ minBidRaise or passes, and the auction closes when all but the
  // high bidder have passed, whereupon the winner is fielded at once (step 3).
  //
  // Proper pass tracking needs per-offer state (which rivals have passed / whose
  // turn it is) that the frozen `MercCompanyOffer` does not carry — see
  // NEEDS-FROM-INTEGRATOR. Deterministic fallback until those fields land: a rival
  // who cannot afford a legal raise (currentBid + minBidRaise) is treated as
  // having passed, so once no rival can out-raise the standing bid the auction
  // closes and the winner is fielded. This is pure and seed-independent.
  const someoneCanRaise = next.players.some(
    (p) => p.id !== player.id && p.treasury.gold >= bid + MERC_MARKET.minBidRaise,
  );
  if (!someoneCanRaise) {
    next = fieldCompany(next, action.companyId);
  }
  return next;
}
