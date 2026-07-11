/**
 * mercenaries.test.ts — MERCENARY bid market subsystem (§6.3).
 *
 * Covers the seeded market refresh (composition determinism + reset bids),
 * turn-order raise-or-pass bidding validation, the gold sink + instant fielding
 * of the winning company into a legal city with the mercenary upkeep tag,
 * face-value auction pricing (CANON #6 / §6.2: the Genoa ×1.0 benefit is
 * ordinary-hire-only, so bid-market bids are NOT discounted for Genoa —
 * everyone pays the winning bid at par), gold-sufficiency validation, and the
 * unsold → random NPC-minor hire roll (§6.3 / §11.5 / §4.4).
 */
import { describe, it, expect } from "vitest";
import {
  Faction,
  UnitType,
  type Army,
  type GameState,
  type MercBidAction,
  type MercCompanyOffer,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { applyMercBid, refreshMercMarket } from "../mercenaries.js";
import { EngineError } from "../actions.js";
import { makeRng } from "../rng.js";
import {
  MERC_COMPANIES,
  MERC_MARKET,
  UNIQUE_UNIT_OVERRIDES,
} from "../balance.js";

type MercTagged = { mercenaries?: Partial<Record<UnitType, number>> };

function game(seats: SeatInput[], seed = 12345): GameState {
  return structuredClone(createInitialState("ROOM01", seats, seed));
}

const byzOtt: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

const genoaOtt: SeatInput[] = [
  { id: "p1", name: "Doge", faction: Faction.GENOA, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

const threeSeat: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
  { id: "p3", name: "Doge", faction: Faction.VENICE, isHost: false },
];

/** Put a single unbid company offer into the market. */
function offer(companyId: string): MercCompanyOffer {
  return {
    companyId,
    currentBid: 0,
    highBidderId: null,
    sold: false,
    passedPlayerIds: [],
    activeBidderId: undefined,
  };
}

function bid(player: string, companyId: string, amount: number): MercBidAction {
  return { type: "MERC_BID", player, companyId, bid: amount };
}

/** A voluntary DA-3 pass (§6.3 step 2): the `bid` field is ignored when pass=true. */
function pass(player: string, companyId: string): MercBidAction {
  return { type: "MERC_BID", player, companyId, bid: 0, pass: true };
}

// ---------------------------------------------------------------------------
// §6.3 Market refresh — seeded composition + reset bids
// ---------------------------------------------------------------------------

describe("refreshMercMarket — §6.3 market composition", () => {
  it("reveals a deterministic 2–3 company row for a given seed/cursor", () => {
    const s = game(byzOtt);
    const a = refreshMercMarket(structuredClone(s));
    const b = refreshMercMarket(structuredClone(s));
    // Same seed + cursor ⇒ identical market and identical advanced cursor.
    expect(a.mercMarket).toEqual(b.mercMarket);
    expect(a.rngCursor).toBe(b.rngCursor);
  });

  it("populates 2–3 valid, unbid offers and advances the RNG cursor", () => {
    const s = game(byzOtt);
    const out = refreshMercMarket(s);
    expect(out.mercMarket.length).toBeGreaterThanOrEqual(
      MERC_MARKET.minCompaniesPerRound,
    );
    expect(out.mercMarket.length).toBeLessThanOrEqual(
      MERC_MARKET.maxCompaniesPerRound,
    );
    // Distinct, real companies, all reset to an unbid state (§6.3).
    const ids = out.mercMarket.map((o) => o.companyId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of out.mercMarket) {
      expect(MERC_COMPANIES[o.companyId]).toBeDefined();
      expect(o.currentBid).toBe(0);
      expect(o.highBidderId).toBeNull();
      expect(o.sold).toBe(false);
    }
    expect(out.rngCursor).toBeGreaterThan(s.rngCursor);
  });
});

// ---------------------------------------------------------------------------
// §6.3 Round-robin raise-or-pass bidding
// ---------------------------------------------------------------------------

describe("applyMercBid — §6.3 raise-or-pass bidding", () => {
  /** Two wealthy players so no auto-close fires mid-auction. */
  function auction(): GameState {
    const s = game(byzOtt);
    s.players[0].treasury.gold = 100;
    s.players[1].treasury.gold = 100;
    s.mercMarket = [offer("CATALAN")]; // minBid 12
    return s;
  }

  it("rejects an opening bid below the company minimum (§6.3)", () => {
    const s = auction();
    expect(() => applyMercBid(s, bid("p1", "CATALAN", 6))).toThrow(EngineError);
  });

  it("records an opening bid at or above the minimum", () => {
    const s = auction();
    const out = applyMercBid(s, bid("p1", "CATALAN", 12));
    const o = out.mercMarket.find((x) => x.companyId === "CATALAN")!;
    expect(o.currentBid).toBe(12);
    expect(o.highBidderId).toBe("p1");
    expect(o.sold).toBe(false); // rivals can still raise
  });

  it("rejects a non-raise (must exceed the high bid by ≥ minBidRaise)", () => {
    const s1 = applyMercBid(auction(), bid("p1", "CATALAN", 12));
    expect(() => applyMercBid(s1, bid("p2", "CATALAN", 12))).toThrow(EngineError);
  });

  it("accepts a legal raise and transfers the high bid", () => {
    const s1 = applyMercBid(auction(), bid("p1", "CATALAN", 12));
    const s2 = applyMercBid(s1, bid("p2", "CATALAN", 13));
    const o = s2.mercMarket.find((x) => x.companyId === "CATALAN")!;
    expect(o.currentBid).toBe(13);
    expect(o.highBidderId).toBe("p2");
    // The prior high bidder must now out-raise the new high bid.
    expect(() => applyMercBid(s2, bid("p1", "CATALAN", 13))).toThrow(EngineError);
  });

  it("rejects a bid on an unknown company", () => {
    expect(() => applyMercBid(auction(), bid("p1", "NOPE", 20))).toThrow(EngineError);
  });

  it("keeps the auction open while a rival can still out-raise (round-robin, §6.3 step 2)", () => {
    // Both players are wealthy: after each raise the offer stays live because the
    // other bidder can legally raise again.
    const s1 = applyMercBid(auction(), bid("p1", "CATALAN", 12));
    expect(s1.mercMarket[0].sold).toBe(false);
    const s2 = applyMercBid(s1, bid("p2", "CATALAN", 20));
    expect(s2.mercMarket[0].sold).toBe(false);
    expect(s2.mercMarket[0].currentBid).toBe(20);
    expect(s2.mercMarket[0].highBidderId).toBe("p2");
  });

  it("forced auto-pass: a rival who cannot afford the minimum raise is auto-passed and the auction closes (DA-3, §6.3 step 2)", () => {
    // CANON CLARIFICATION 3: affordability survives ONLY as an auto-pass. p1 rich,
    // p2 can cover 12 but not 12 + minBidRaise (=13), so on p1's opening bid p2 is
    // FORCED to pass → only one non-passed bidder remains → the auction closes and
    // the winner is fielded at face value (§6.3 step 3).
    const s = game(byzOtt);
    s.players[0].treasury.gold = 100;
    s.players[1].treasury.gold = 12;
    s.mercMarket = [offer("CATALAN")];
    const out = applyMercBid(s, bid("p1", "CATALAN", 12));
    expect(out.mercMarket[0].sold).toBe(true);
    expect(out.players[0].treasury.gold).toBe(100 - 12); // face value gold sink
    // p2 is recorded as a (forced) pass in the offer's round-robin pass set.
    expect(out.mercMarket[0].passedPlayerIds).toContain("p2");
    expect(out.mercMarket[0].passedPlayerIds).not.toContain("p1"); // the winner never passes
  });

  it("voluntary pass closes the auction when one non-passed bidder remains and fields the high bidder at face value (DA-3, §6.3 step 2)", () => {
    // Both players are wealthy, so nobody is auto-passed. p1 opens at 12; p2 could
    // out-raise but VOLUNTARILY passes → only p1 (the high bidder) remains → the
    // auction closes and p1 is fielded, paying the current high bid at face value.
    const s = game(byzOtt);
    s.players[0].treasury.gold = 100;
    s.players[1].treasury.gold = 100;
    s.mercMarket = [offer("CATALAN")];
    const s1 = applyMercBid(s, bid("p1", "CATALAN", 12));
    expect(s1.mercMarket[0].sold).toBe(false); // still open — p2 can raise
    const out = applyMercBid(s1, pass("p2", "CATALAN"));
    expect(out.mercMarket[0].sold).toBe(true); // one bidder remains → closed
    expect(out.mercMarket[0].passedPlayerIds).toContain("p2");
    expect(out.players[0].treasury.gold).toBe(100 - 12); // winner pays face value
  });

  it("a voluntary pass with rivals still active does NOT close the auction (round-robin, DA-3)", () => {
    // Three wealthy bidders: p1 opens, p3 passes, but p2 is still active → the
    // auction stays open and the round-robin pointer moves to the remaining rival.
    const s = game(threeSeat);
    s.players[0].treasury.gold = 100;
    s.players[1].treasury.gold = 100;
    s.players[2].treasury.gold = 100;
    s.mercMarket = [offer("CATALAN")];
    const s1 = applyMercBid(s, bid("p1", "CATALAN", 12));
    const out = applyMercBid(s1, pass("p3", "CATALAN"));
    expect(out.mercMarket[0].sold).toBe(false); // p2 still active → open
    expect(out.mercMarket[0].passedPlayerIds).toEqual(["p3"]);
    expect(out.mercMarket[0].highBidderId).toBe("p1");
    // Round-robin pointer: the next non-passed rival after the high bidder is p2.
    expect(out.mercMarket[0].activeBidderId).toBe("p2");
  });

  it("a passed player cannot re-enter the offer's round-robin (DA-3)", () => {
    const s = game(threeSeat);
    s.players.forEach((p) => (p.treasury.gold = 100));
    s.mercMarket = [offer("CATALAN")];
    const s1 = applyMercBid(s, bid("p1", "CATALAN", 12));
    const s2 = applyMercBid(s1, pass("p2", "CATALAN"));
    // p2 has withdrawn — a later bid from p2 is rejected (passing is permanent).
    expect(() => applyMercBid(s2, bid("p2", "CATALAN", 20))).toThrow(EngineError);
  });

  it("is deterministic and pure: bidding consumes no RNG and does not mutate the input", () => {
    const base = auction();
    const snapshot = structuredClone(base);
    const a = applyMercBid(base, bid("p1", "CATALAN", 15));
    const b = applyMercBid(structuredClone(base), bid("p1", "CATALAN", 15));
    // Identical results for identical inputs; the bid path draws no dice.
    expect(a.mercMarket).toEqual(b.mercMarket);
    expect(a.players[0].treasury.gold).toBe(b.players[0].treasury.gold);
    expect(a.rngCursor).toBe(base.rngCursor); // no cursor advance on a bid
    // Input left untouched (returns a new state).
    expect(base).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// §6.3 Gold sink + instant fielding into a legal city (§4.4 merc tag)
// ---------------------------------------------------------------------------

describe("applyMercBid — §6.3 fielding the winner", () => {
  /** A market where p2 is too poor to raise, so p1's bid closes the auction. */
  function closingAuction(seats: SeatInput[]): GameState {
    const s = game(seats);
    s.players[0].treasury.gold = 100;
    s.players[1].treasury.gold = 5; // cannot afford 12 + minBidRaise
    s.mercMarket = [offer("CATALAN")]; // 5 INF + 3 ARCH, minBid 12
    return s;
  }

  it("pays the winning bid at face value as a gold sink and fields the roster in the capital", () => {
    const s = closingAuction(byzOtt);
    const out = applyMercBid(s, bid("p1", "CATALAN", 12));

    // GD §6.3 step 3: the winner pays the winning bid in gold at FACE VALUE —
    // no ×1.5 premium in the auction (that is the §6.2 ordinary-hire path).
    expect(out.players[0].treasury.gold).toBe(100 - 12);

    // §6.3 the offer is resolved (sold) and cannot be re-bid.
    const o = out.mercMarket.find((x) => x.companyId === "CATALAN")!;
    expect(o.sold).toBe(true);
    expect(() => applyMercBid(out, bid("p1", "CATALAN", 20))).toThrow(EngineError);

    // §6.3 fielded in the Byzantine capital, tagged mercenary for §4.4 upkeep.
    const capital = out.provinces.find(
      (p) => p.isCapitalOf === Faction.BYZANTIUM && p.ownerId === "p1",
    )!;
    const army = out.armies.find(
      (a) => a.ownerId === "p1" && a.locationId === capital.id,
    ) as (Army & MercTagged) | undefined;
    expect(army).toBeDefined();
    expect(army!.mercenaries?.[UnitType.INFANTRY]).toBe(5);
    expect(army!.mercenaries?.[UnitType.ARCHER]).toBe(3);
    expect(army!.units[UnitType.INFANTRY]).toBeGreaterThanOrEqual(5);
    expect(army!.units[UnitType.ARCHER]).toBeGreaterThanOrEqual(3);
  });

  it("does NOT discount bid-market bids for Genoa — Genoa pays the same face value as everyone (CANON #6 / §6.2)", () => {
    const s = closingAuction(genoaOtt);
    const out = applyMercBid(s, bid("p1", "CATALAN", 12));
    // CANON #6 / §6.2: the Genoa ×1.0 benefit is ordinary-hire-only; in the
    // auction Genoa bids/pays at par like everyone else — floor(12) = 12.
    expect(out.players[0].treasury.gold).toBe(100 - 12);
    const capital = out.provinces.find(
      (p) => p.isCapitalOf === Faction.GENOA && p.ownerId === "p1",
    )!;
    const army = out.armies.find(
      (a) => a.ownerId === "p1" && a.locationId === capital.id,
    ) as (Army & MercTagged) | undefined;
    expect(army?.mercenaries?.[UnitType.INFANTRY]).toBe(5);
  });

  it("charges Genoa and a premium faction the identical face-value bid (no faction multiplier in the auction)", () => {
    // The core CANON #6 / §6.2 fix: the same winning bid costs the same gold
    // regardless of faction. Genoa gets no discount and Byzantium no premium.
    const byz = applyMercBid(closingAuction(byzOtt), bid("p1", "CATALAN", 12));
    const gen = applyMercBid(closingAuction(genoaOtt), bid("p1", "CATALAN", 12));
    const byzPaid = 100 - byz.players[0].treasury.gold;
    const genPaid = 100 - gen.players[0].treasury.gold;
    expect(byzPaid).toBe(12);
    expect(genPaid).toBe(12);
    expect(genPaid).toBe(byzPaid);
  });

  it("fields the Varangian Remnant as VARANGIAN_REMNANT variant heads carrying the elite +1 DEF (§6.3, FL-10)", () => {
    // §6.3 (GD line 304): the Varangian Remnant is elite — it must field as named
    // UnitVariantStack heads (base INFANTRY×4 + CAVALRY×2) so combat applies the
    // +1 DEF from UNIQUE_UNIT_OVERRIDES.VARANGIAN_REMNANT, NOT as plain roster
    // units (which would be byte-identical to ordinary troops, losing the bonus).
    const s = game(byzOtt);
    s.players[0].treasury.gold = 100;
    s.players[1].treasury.gold = 5; // cannot afford 16 + minBidRaise → auction closes
    s.mercMarket = [offer("VARANGIAN_REMNANT")]; // minBid 16, all-variant roster

    // The Byzantine capital already holds a starting army (INF×2 + a Varangian
    // GUARD variant); capture its generic counts so we can prove the Remnant adds
    // ZERO plain units — every hired head lands in `variants`.
    const capital = s.provinces.find(
      (p) => p.isCapitalOf === Faction.BYZANTIUM && p.ownerId === "p1",
    )!;
    const before = s.armies.find(
      (a) => a.ownerId === "p1" && a.locationId === capital.id,
    );
    const infBefore = before?.units[UnitType.INFANTRY] ?? 0;
    const cavBefore = before?.units[UnitType.CAVALRY] ?? 0;

    const out = applyMercBid(s, bid("p1", "VARANGIAN_REMNANT", 16));

    const o = out.mercMarket.find((x) => x.companyId === "VARANGIAN_REMNANT")!;
    expect(o.sold).toBe(true);
    expect(out.players[0].treasury.gold).toBe(100 - 16); // face-value gold sink

    const army = out.armies.find(
      (a) => a.ownerId === "p1" && a.locationId === capital.id,
    ) as (Army & MercTagged) | undefined;
    expect(army).toBeDefined();

    // Fielded as VARANGIAN_REMNANT variant heads (INFANTRY×4 + CAVALRY×2), not
    // generic units.
    const varangians = (army!.variants ?? []).filter(
      (v) => v.variant === "VARANGIAN_REMNANT",
    );
    const inf = varangians.find((v) => v.base === UnitType.INFANTRY);
    const cav = varangians.find((v) => v.base === UnitType.CAVALRY);
    expect(inf?.count).toBe(4);
    expect(cav?.count).toBe(2);

    // The variant's stat override carries the elite +1 defensive CV (applied on
    // defence by combat's variant effective-stat lookup, combat.ts).
    expect(UNIQUE_UNIT_OVERRIDES.VARANGIAN_REMNANT.defMod).toBe(1);

    // No plain INFANTRY/CAVALRY heads were added — the Remnant is all-variant.
    expect(army!.units[UnitType.INFANTRY] ?? 0).toBe(infBefore);
    expect(army!.units[UnitType.CAVALRY] ?? 0).toBe(cavBefore);
  });

  it("rejects a bid the player cannot cover in gold (§6.3)", () => {
    const s = game(byzOtt);
    s.players[0].treasury.gold = 11;
    s.players[1].treasury.gold = 100;
    s.mercMarket = [offer("ALMOGAVARS")]; // minBid 10
    // Opening bid 12 is a legal raise but exceeds the 11-gold purse.
    expect(() => applyMercBid(s, bid("p1", "ALMOGAVARS", 12))).toThrow(
      /gold/i,
    );
  });
});

// ---------------------------------------------------------------------------
// §6.3 / §11.5 Unsold company → random NPC minor
// ---------------------------------------------------------------------------

describe("refreshMercMarket — §6.3 unsold → NPC minor", () => {
  it("hands an unsold company to a random NPC minor on a 1d6 ≤ 2 roll", () => {
    const s = game(byzOtt);
    s.mercMarket = [offer("CATALAN")]; // 8 heads, no bids placed

    // The first RNG draw of the refresh is the unsold company's NPC-hire roll.
    const expectedRoll = makeRng(s.rngSeed, s.rngCursor).rollD6();
    const garrisonBefore = s.minors.reduce((n, m) => n + m.garrison, 0);
    const rosterHeads =
      (MERC_COMPANIES.CATALAN.roster[UnitType.INFANTRY] ?? 0) +
      (MERC_COMPANIES.CATALAN.roster[UnitType.ARCHER] ?? 0); // 8

    const out = refreshMercMarket(s);
    const garrisonAfter = out.minors.reduce((n, m) => n + m.garrison, 0);

    if (expectedRoll <= MERC_MARKET.npcHireRoll) {
      // §11.5 one minor's garrison is reinforced by the roster's head count.
      expect(garrisonAfter).toBe(garrisonBefore + rosterHeads);
    } else {
      expect(garrisonAfter).toBe(garrisonBefore); // company simply disbands
    }
    // A fresh row is always seeded afterwards.
    expect(out.mercMarket.length).toBeGreaterThanOrEqual(
      MERC_MARKET.minCompaniesPerRound,
    );
  });
});
