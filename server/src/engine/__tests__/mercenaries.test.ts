/**
 * mercenaries.test.ts — MERCENARY bid market subsystem (§6.3).
 *
 * Covers the seeded market refresh (composition determinism + reset bids),
 * turn-order raise-or-pass bidding validation, the gold sink + instant fielding
 * of the winning company into a legal city with the mercenary upkeep tag, the
 * Genoa no-premium discount, gold-sufficiency validation, and the unsold →
 * random NPC-minor hire roll (§6.3 / §11.5 / §4.4).
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
import { MERC_COMPANIES, MERC_MARKET } from "../balance.js";

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

/** Put a single unbid company offer into the market. */
function offer(companyId: string): MercCompanyOffer {
  return { companyId, currentBid: 0, highBidderId: null, sold: false };
}

function bid(player: string, companyId: string, amount: number): MercBidAction {
  return { type: "MERC_BID", player, companyId, bid: amount };
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

  it("pays the winning bid × premium as a gold sink and fields the roster in the capital", () => {
    const s = closingAuction(byzOtt);
    const out = applyMercBid(s, bid("p1", "CATALAN", 12));

    // §6.3 non-Genoa pays the ×1.5 premium on the bid: floor(12 × 1.5) = 18.
    expect(out.players[0].treasury.gold).toBe(100 - 18);

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

  it("applies the Genoa no-premium discount (×1.0) to the winning bid (§6.3)", () => {
    const s = closingAuction(genoaOtt);
    const out = applyMercBid(s, bid("p1", "CATALAN", 12));
    // §6.3 Genoa pays ×1.0: floor(12 × 1.0) = 12, vs 18 for a premium faction.
    expect(out.players[0].treasury.gold).toBe(100 - 12);
    const capital = out.provinces.find(
      (p) => p.isCapitalOf === Faction.GENOA && p.ownerId === "p1",
    )!;
    const army = out.armies.find(
      (a) => a.ownerId === "p1" && a.locationId === capital.id,
    ) as (Army & MercTagged) | undefined;
    expect(army?.mercenaries?.[UnitType.INFANTRY]).toBe(5);
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
