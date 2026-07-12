/**
 * events/index.test.ts — EVENTS RESOLUTION subsystem (GAME_DESIGN §12,
 * EVENT_CARDS.md).
 *
 * Covers the Omen-phase plumbing (§12 / EVENT_CARDS "Draw rules"): deterministic
 * draw from a seeded RNG, era-transition retire/shuffle across the Era I/II/III
 * boundaries, empty-deck reshuffle, the 4–5 player "gathering omen" reveal
 * (CONTRACT §9 item 9 / balance.OMEN_DRAW), a spread of representative card
 * effects (incl. #34 Great Bombard SPAWN — delta 3 corrected model — and #46 Fall
 * of Constantinople sudden death), and that Standing/Persistent cards register an
 * ActiveModifier on the side-channel. Cited card numbers reference EVENT_CARDS.md.
 */
import { describe, it, expect } from "vitest";
import { Faction, TerrainType, UnitType, type GameState } from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { neighborsOf } from "../adjacency.js";
import { applyIncomePhase } from "../economy.js";
import { WALL_TIERS } from "../balance.js";
import { drawOmen, resolveCard } from "./index.js";
import { omenCardId, OMEN_CARD_BY_ID } from "./cards.js";

const SEED = 777;

const seats4: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
  { id: "p3", name: "Foscari", faction: Faction.VENICE, isHost: false },
  { id: "p4", name: "Adorno", faction: Faction.GENOA, isHost: false },
];

const seats2: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

const seats2NoOttoman: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p3", name: "Foscari", faction: Faction.VENICE, isHost: false },
];

function fresh(seats: SeatInput[]): GameState {
  return structuredClone(createInitialState("ROOM77", seats, SEED));
}

function player(state: GameState, id: string) {
  return state.players.find((p) => p.id === id)!;
}

/** A full UnitType record with `counts` applied over zeroes (test fixture). */
function unitsWith(counts: Partial<Record<UnitType, number>>): Record<UnitType, number> {
  const u = {} as Record<UnitType, number>;
  for (const t of Object.values(UnitType)) u[t] = counts[t] ?? 0;
  return u;
}

/** Land-stack size an owner has at a province (generic + variant counts). */
function landUnitsAt(state: GameState, ownerId: string, provId: string): number {
  let n = 0;
  for (const a of state.armies) {
    if (a.ownerId !== ownerId || a.locationId !== provId) continue;
    for (const t of Object.values(UnitType)) n += a.units[t] ?? 0;
    for (const v of a.variants ?? []) n += v.count;
  }
  return n;
}

/** Pack `provId` with `n` p2 levies (replacing p2's armies there) — §6.4 fixture. */
function packProvince(state: GameState, provId: string, n: number): GameState {
  return {
    ...state,
    armies: [
      ...state.armies.filter((a) => !(a.ownerId === "p2" && a.locationId === provId)),
      {
        id: `fill-${provId}`,
        ownerId: "p2",
        locationId: provId,
        units: unitsWith({ [UnitType.LEVY]: n }),
        variants: [],
      },
    ],
  };
}

/** Pack the Ottoman (p2) capital edirne to the §6.4 city/capital cap of 12. */
function withFullOttomanCapital(state: GameState): GameState {
  return packProvince(state, "edirne", 12);
}

// ---------------------------------------------------------------------------
// §12 / EVENT_CARDS "Draw rules" — deterministic draw
// ---------------------------------------------------------------------------

describe("drawOmen — deterministic draw (§12, seeded RNG)", () => {
  it("draws the same card and produces byte-identical state from a fixed seed", () => {
    const a = drawOmen(fresh(seats2));
    const b = drawOmen(fresh(seats2));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("moves exactly one card from the deck to the discard and advances the RNG cursor", () => {
    const before = fresh(seats2);
    const after = drawOmen(before);
    expect(after.omenDeck.length).toBe(before.omenDeck.length - 1);
    // The drawn card is the front of the pre-draw deck, now on top of the discard.
    expect(after.omenDiscard[after.omenDiscard.length - 1]).toBe(before.omenDeck[0]);
    expect(after.rngCursor).toBeGreaterThanOrEqual(before.rngCursor);
  });

  it("draws only from the current era's deck (Era I in round 1)", () => {
    const after = drawOmen(fresh(seats2));
    const drawn = after.omenDiscard[after.omenDiscard.length - 1];
    expect(OMEN_CARD_BY_ID[drawn].era).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// EVENT_CARDS "on entering the next era, retire the previous deck" (Era I→II→III)
// ---------------------------------------------------------------------------

describe("drawOmen — era transition retire + shuffle (EVENT_CARDS deck structure)", () => {
  it("retires Era I and shuffles in the Era II deck when round 6 begins", () => {
    const s = fresh(seats2);
    // Simulate roundLoop having advanced into Era II with Era I leftovers around.
    s.round = 6;
    s.turn = 6;
    s.era = 2;
    s.omenDiscard = [omenCardId(1)]; // an Era I card that must be retired
    const after = drawOmen(s);

    // Era II deck is now active (17 cards − 1 drawn) and the key is consumed.
    expect(after.eraDecksRemaining[2]).toBeUndefined();
    expect(after.eraDecksRemaining[3]).toBeDefined();
    // The drawn card is Era II; no Era I card survives in deck or discard.
    const drawn = after.omenDiscard[after.omenDiscard.length - 1];
    expect(OMEN_CARD_BY_ID[drawn].era).toBe(2);
    expect(after.omenDeck).not.toContain(omenCardId(1));
    expect(after.omenDiscard).not.toContain(omenCardId(1));
    expect(after.omenDeck.every((id) => OMEN_CARD_BY_ID[id].era === 2)).toBe(true);
    expect(after.omenDeck.length).toBe(16);
  });

  it("retires Era II and activates Era III at round 11", () => {
    const s = fresh(seats2);
    s.round = 11;
    s.turn = 11;
    s.era = 3;
    // Pretend Era II was the active deck being retired.
    s.omenDeck = [omenCardId(17), omenCardId(18)];
    s.omenDiscard = [omenCardId(19)];
    s.eraDecksRemaining = { 3: [...s.eraDecksRemaining[3]!] };
    const after = drawOmen(s);
    expect(after.eraDecksRemaining[3]).toBeUndefined();
    const drawn = after.omenDiscard[after.omenDiscard.length - 1];
    expect(OMEN_CARD_BY_ID[drawn].era).toBe(3);
    expect(after.omenDeck.every((id) => OMEN_CARD_BY_ID[id].era === 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EVENT_CARDS "when an era deck empties, reshuffle its discards"
// ---------------------------------------------------------------------------

describe("drawOmen — empty-deck reshuffle (EVENT_CARDS draw rules)", () => {
  it("reshuffles the discard pile back into the deck when it empties", () => {
    const s = fresh(seats2);
    s.omenDeck = [];
    s.omenDiscard = [omenCardId(1), omenCardId(2), omenCardId(3), omenCardId(4), omenCardId(5)];
    const after = drawOmen(s);
    // Reshuffled 5 discards into the deck, then drew 1: deck 4, discard 1.
    expect(after.omenDeck.length).toBe(4);
    expect(after.omenDiscard.length).toBe(1);
    expect(after.log.some((e) => /reshuffled/i.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CONTRACT §9 item 9 / balance.OMEN_DRAW — 4–5 player "gathering omen"
// ---------------------------------------------------------------------------

describe("drawOmen — 4–5 player gathering omen (CONTRACT §9 item 9)", () => {
  it("reveals (peeks) the next card as a gathering omen for a 4-player game", () => {
    const after = drawOmen(fresh(seats4));
    const gathering = after.log.find((e) => e.data && "gatheringOmen" in e.data);
    expect(gathering).toBeDefined();
    // Peeked, not resolved: the gathering card is still on top of the live deck.
    expect(after.omenDeck[0]).toBe(gathering!.data!.gatheringOmen);
  });

  it("does NOT reveal a gathering omen for a 2-player game", () => {
    const after = drawOmen(fresh(seats2));
    expect(after.log.some((e) => e.data && "gatheringOmen" in e.data)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Representative card effects (EVENT_CARDS #3, #5, #34, #38, #46)
// ---------------------------------------------------------------------------

describe("resolveCard — representative card effects", () => {
  it("#5 Imperial Coronation grants the drawer +2 prestige and +2 gold", () => {
    const s = fresh(seats4); // drawer = active player p1 (Byzantium)
    const goldBefore = player(s, "p1").treasury.gold;
    const after = resolveCard(s, omenCardId(5));
    expect(player(after, "p1").prestige).toBe(2);
    expect(player(after, "p1").treasury.gold).toBe(goldBefore + 2);
  });

  it("#3 Silk Road Caravan grants +3 gold to the holder of Bursa (Ottoman)", () => {
    const s = fresh(seats4);
    const before = player(s, "p2").treasury.gold;
    const after = resolveCard(s, omenCardId(3));
    expect(player(after, "p2").treasury.gold).toBe(before + 3);
  });

  it("#38 Pilgrimage / Jubilee Year grants +1 faith to every Christian faction, not the Ottoman", () => {
    const s = fresh(seats4);
    const byzFaith = player(s, "p1").treasury.faith;
    const ottFaith = player(s, "p2").treasury.faith;
    const venFaith = player(s, "p3").treasury.faith;
    const after = resolveCard(s, omenCardId(38));
    expect(player(after, "p1").treasury.faith).toBe(byzFaith + 1); // Byzantium
    expect(player(after, "p3").treasury.faith).toBe(venFaith + 1); // Venice
    expect(player(after, "p2").treasury.faith).toBe(ottFaith); // Ottoman unchanged
  });

  // delta 3 (CORRECTED CANON — merged PR #17 rules-delta docs "GREAT BOMBARD MODEL", GD §8.4,
  // EVENT_CARDS #34): #34 SPAWNS the Great Bombard immediately + free onto the
  // GameState.greatBombard singleton — no "unlock then RECRUIT" modifier any more.
  it("#34 with the Ottoman in play spawns the Great Bombard FREE in the Ottoman capital (edirne), inPlay + emplacedRound set", () => {
    const s = fresh(seats4); // Ottoman = p2
    s.round = 11; // Era III round the card is drawn in
    const after = resolveCard(s, omenCardId(34));
    // Singleton tracker: in play, owned by the Ottoman, emplaced this round.
    expect(after.greatBombard!.inPlay).toBe(true);
    expect(after.greatBombard!.ownerId).toBe("p2");
    expect(after.greatBombard!.provinceId).toBe("edirne"); // Ottoman capital
    expect(after.greatBombard!.emplacedRound).toBe(11);
    // The GREAT_BOMBARD variant piece (base SIEGE) is emplaced at the capital.
    const piece = after.armies.find((a) =>
      (a.variants ?? []).some((v) => v.variant === "GREAT_BOMBARD" && v.count > 0),
    );
    expect(piece).toBeDefined();
    expect(piece!.ownerId).toBe("p2");
    expect(piece!.locationId).toBe("edirne");
    expect(piece!.variants!.find((v) => v.variant === "GREAT_BOMBARD")!.base).toBe(UnitType.SIEGE);
    // Retired model: no `kind:"unlock"` modifier is posted any more.
    expect(after.activeModifiers.some((m) => m.kind === "unlock")).toBe(false);
  });

  it("#34 with no Ottoman in play auctions the Bombard to the highest gold+marble holder, placed in their capital", () => {
    const s = fresh(seats2NoOttoman); // p1 Byzantium, p3 Venice
    // Make Venice (p3) the clear highest combined gold+marble holder.
    player(s, "p3").treasury.gold += 50;
    player(s, "p1").treasury.gold = 0;
    player(s, "p1").treasury.marble = 0;
    const after = resolveCard(s, omenCardId(34));
    expect(after.greatBombard!.inPlay).toBe(true);
    expect(after.greatBombard!.ownerId).toBe("p3"); // Venice won the auction
    expect(after.greatBombard!.provinceId).toBe("venice"); // Venice's capital
    const piece = after.armies.find((a) =>
      (a.variants ?? []).some((v) => v.variant === "GREAT_BOMBARD" && v.count > 0),
    );
    expect(piece!.ownerId).toBe("p3");
    expect(piece!.locationId).toBe("venice");
    // The effect fn logs Orban's auction.
    expect(after.log.some((e) => /auction|highest bidder/i.test(e.message))).toBe(true);
    expect(after.activeModifiers.some((m) => m.kind === "unlock")).toBe(false);
  });

  it("#34 auction ties break by turn order (earliest seated wins)", () => {
    const s = fresh(seats2NoOttoman); // p1 Byzantium (earlier in turn order), p3 Venice
    // Force an exact gold+marble tie between p1 and p3.
    for (const id of ["p1", "p3"]) {
      player(s, id).treasury.gold = 10;
      player(s, id).treasury.marble = 5;
    }
    const after = resolveCard(s, omenCardId(34));
    // p1 precedes p3 in turnOrder → wins the tie.
    expect(s.turnOrder.indexOf("p1")).toBeLessThan(s.turnOrder.indexOf("p3"));
    expect(after.greatBombard!.ownerId).toBe("p1");
  });

  it("#34 resolving a SECOND time does NOT spawn a second Great Bombard (exactly one per game)", () => {
    const s = fresh(seats4);
    s.round = 11;
    const once = resolveCard(s, omenCardId(34));
    const firstOwner = once.greatBombard!.ownerId;
    const firstProvince = once.greatBombard!.provinceId;
    // A reshuffle edge re-draws #34 in a later round; the guard makes it a no-op.
    const twice = resolveCard({ ...once, round: 14 }, omenCardId(34));
    // Still exactly one piece, unchanged owner/emplacement (not re-emplaced to r14).
    const pieces = twice.armies.filter((a) =>
      (a.variants ?? []).some((v) => v.variant === "GREAT_BOMBARD" && v.count > 0),
    );
    expect(pieces.length).toBe(1);
    expect(twice.greatBombard!.ownerId).toBe(firstOwner);
    expect(twice.greatBombard!.provinceId).toBe(firstProvince);
    expect(twice.greatBombard!.emplacedRound).toBe(11); // NOT re-set to 14
    expect(twice.log.some((e) => e.data && "alreadyInPlay" in e.data)).toBe(true);
  });

  // §6.4 over-stacking guard (regression: the forge used to over-stack a full
  // capital 12→13) + GD §8.4 placement widening (marshal answer-key major): canon
  // reads "capital (or any owned CITY)". When the Ottoman capital is at the §6.4
  // cap, the gun must be emplaced in an OWNED CITY-terrain province with room —
  // Nicaea, the Ottomans' only owned CITY — never on top of the cap.
  it("#34 forge with the Ottoman capital FULL (12/12) emplaces the gun in an owned CITY (nicaea), leaving the capital at 12 (§8.4 capital-OR-owned-CITY)", () => {
    const s = withFullOttomanCapital(fresh(seats4)); // Ottoman = p2, capital edirne
    s.round = 11;
    expect(landUnitsAt(s, "p2", "edirne")).toBe(12); // capital packed to the §6.4 cap
    const after = resolveCard(s, omenCardId(34));
    expect(after.greatBombard!.inPlay).toBe(true);
    expect(after.greatBombard!.ownerId).toBe("p2");
    // §8.4 "or any owned CITY": placed in Nicaea (owned, CITY terrain) — the CITY
    // preference beats mere capital-adjacency (nicaea is NOT an edirne neighbour).
    const dest = after.greatBombard!.provinceId!;
    expect(dest).toBe("nicaea");
    expect(after.provinces.find((p) => p.id === dest)!.terrain).toBe(TerrainType.CITY);
    expect(after.provinces.find((p) => p.id === dest)!.ownerId).toBe("p2");
    expect(neighborsOf("edirne")).not.toContain(dest);
    expect(player(after, "p2").faction).toBe(Faction.OTTOMAN);
    // §6.4 respected everywhere: the CITY destination stays within its cap (12)...
    expect(landUnitsAt(after, "p2", dest)).toBeLessThanOrEqual(12);
    // ...and the capital is NOT over-stacked — it stays at 12 (the pre-fix bug → 13).
    expect(landUnitsAt(after, "p2", "edirne")).toBe(12);
    // The one GREAT_BOMBARD piece sits at the destination, not the capital.
    const piece = after.armies.find((a) =>
      (a.variants ?? []).some((v) => v.variant === "GREAT_BOMBARD" && v.count > 0),
    );
    expect(piece!.locationId).toBe(dest);
    expect(piece!.locationId).not.toBe("edirne");
  });

  // §6.4 safety fallback below the two printed homes (§8.4): capital AND every
  // owned CITY full → an owned province adjacent to the capital with the most
  // room (tie → lowest id: gallipoli/philippopolis both hold 1 starting levy).
  it("#34 forge with the capital AND the only owned CITY full falls back to an adjacent owned province (gallipoli)", () => {
    let s = withFullOttomanCapital(fresh(seats4));
    s = packProvince(s, "nicaea", 12); // fill the only Ottoman-owned CITY to its cap
    s.round = 11;
    const after = resolveCard(s, omenCardId(34));
    expect(after.greatBombard!.inPlay).toBe(true);
    const dest = after.greatBombard!.provinceId!;
    expect(dest).toBe("gallipoli");
    expect(neighborsOf("edirne")).toContain(dest);
    // Neither printed home was over-stacked past §6.4.
    expect(landUnitsAt(after, "p2", "edirne")).toBe(12);
    expect(landUnitsAt(after, "p2", "nicaea")).toBe(12);
  });

  it("#34 forge with room in the capital still emplaces the gun in the capital (behaviour unchanged)", () => {
    const s = fresh(seats4); // edirne holds 5 starting p2 units → room for the gun
    s.round = 11;
    expect(landUnitsAt(s, "p2", "edirne")).toBeLessThan(12);
    const after = resolveCard(s, omenCardId(34));
    expect(after.greatBombard!.inPlay).toBe(true);
    expect(after.greatBombard!.provinceId).toBe("edirne"); // capital, as before
  });

  it("#34 forge placement is deterministic — same seed/state → same emplacement province", () => {
    const build = () => {
      const s = withFullOttomanCapital(fresh(seats4));
      s.round = 11;
      return resolveCard(s, omenCardId(34)).greatBombard!.provinceId;
    };
    const first = build();
    expect(build()).toBe(first);
    // §8.4 capital-OR-owned-CITY: the full capital defers to the one owned CITY.
    expect(first).toBe("nicaea");
  });

  it("#28 Papal Interdict does NOT post a global faith modifier (EVENT_CARDS Era II #28 targets one faction)", () => {
    // Without an interdicted target (ctx.targetPlayerId), the neutral-omen path
    // must leave NO faith_income modifier on the board — the pre-fix bug posted
    // an untargeted faith_income {value:0, multiplier:0} that economy read as
    // global and used to zero every seated faction's faith income.
    const after = resolveCard(fresh(seats4), omenCardId(28));
    const faithMod = after.activeModifiers.find(
      (m) => m.sourceCardId === omenCardId(28) && m.kind === "faith_income",
    );
    expect(faithMod).toBeUndefined();
    // Any faith_income modifier that ever IS posted for #28 must be faction-scoped.
    expect(
      after.activeModifiers.some(
        (m) => m.kind === "faith_income" && m.target?.faction === undefined,
      ),
    ).toBe(false);
  });

  it("#28 Papal Interdict scopes the faith modifier to the interdicted faction ALONE when a target is threaded (FL-03)", () => {
    // resolveCard now accepts the PLAY_CARD target; interdict p2 (Ottoman). The
    // faith_income modifier must bite ONLY the Ottoman — not every seated faction.
    const s = fresh(seats4); // drawer = p1 (Byzantium)
    const after = resolveCard(s, omenCardId(28), { targetPlayerId: "p2" });
    const faithMod = after.activeModifiers.find(
      (m) => m.sourceCardId === omenCardId(28) && m.kind === "faith_income",
    );
    expect(faithMod).toBeDefined();
    expect(faithMod!.value).toBe(0);
    expect(faithMod!.target!.faction).toBe(Faction.OTTOMAN);
    // It bites only the target: the drawer's own (Byzantine) faith is not scoped.
    expect(faithMod!.target!.faction).not.toBe(Faction.BYZANTIUM);
  });

  it("#17 Council of Florence ACCEPT sets acceptedChurchUnion on the acting Byzantine player (FL-08)", () => {
    const s = fresh(seats4); // Byzantium = p1
    expect(player(s, "p1").acceptedChurchUnion).toBeUndefined();
    const accepted = resolveCard(s, omenCardId(17), { choice: "ACCEPT" });
    expect(player(accepted, "p1").acceptedChurchUnion).toBe(true);
    // REFUSE (or any non-ACCEPT choice) leaves the flag falsy = Church Union refused.
    const refused = resolveCard(s, omenCardId(17), { choice: "REFUSE" });
    expect(player(refused, "p1").acceptedChurchUnion).toBeFalsy();
  });

  it("#46 The Fall of Constantinople awards +5 prestige to the Byzantine holder and arms sudden death", () => {
    const s = fresh(seats4); // Byzantium (p1) still holds Constantinople
    const after = resolveCard(s, omenCardId(46));
    expect(player(after, "p1").prestige).toBe(5);
    expect(after.constantinopleHold.faction).toBe(Faction.BYZANTIUM);
    const sd = after.activeModifiers.find((m) => m.kind === "sudden_death");
    expect(sd).toBeDefined();
    expect(sd!.scope).toBe("game");
    expect(sd!.data!.province).toBe("constantinople");
  });
});

// ---------------------------------------------------------------------------
// Standing / Persistent cards register ActiveModifiers (EVENT_CARDS #9,#18,#35,#36)
// ---------------------------------------------------------------------------

describe("resolveCard — durable cards register an ActiveModifier", () => {
  it("#9 Discovery of Alum posts a standing +2 gold/round income modifier on Chios and does NOT double-apply on the draw round (FL-04)", () => {
    const s = fresh(seats4); // Chios starts Genoese (p4)
    const chiosOwner = s.provinces.find((p) => p.id === "chios")!.ownerId!;
    const goldBefore = player(s, chiosOwner).treasury.gold;
    const after = resolveCard(s, omenCardId(9));
    const mod = after.activeModifiers.find((m) => m.sourceCardId === omenCardId(9));
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe("income");
    expect(mod!.value).toBe(2);
    expect(mod!.scope).toBe("game");
    expect(mod!.target!.provinceId).toBe("chios");
    // FL-04: the +2 🪙/round is delivered by the economy income reader EACH live
    // round (incl. round 1), not granted immediately here — the Chios holder's gold
    // is unchanged on the draw round so the bonus is not applied twice.
    expect(player(after, chiosOwner).treasury.gold).toBe(goldBefore);
  });

  it("#18 Venetian–Genoese War posts a 2-round persistent trade modifier with an expiry", () => {
    const s = fresh(seats4); // both republics present
    s.round = 6;
    const after = resolveCard(s, omenCardId(18));
    const mod = after.activeModifiers.find((m) => m.sourceCardId === omenCardId(18));
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe("trade_mod");
    expect(mod!.scope).toBe("persistent");
    // Posted round 6, lasts 2 rounds → active 6..7, lapses at end of round 7.
    expect(mod!.expiresRound).toBe(7);
  });

  it("#35 Black Death Returns posts a 2-round persistent plague modifier and does NOT hit yields immediately (FL-19)", () => {
    const s = fresh(seats4);
    s.round = 11;
    // Byzantium (p1) holds Constantinople, a CITY the plague afflicts.
    const grainBefore = player(s, "p1").treasury.grain;
    const goldBefore = player(s, "p1").treasury.gold;
    const after = resolveCard(s, omenCardId(35));
    const mod = after.activeModifiers.find((m) => m.sourceCardId === omenCardId(35));
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe("plague");
    expect(mod!.scope).toBe("persistent");
    expect(mod!.expiresRound).toBe(12);
    // FL-19: the −1 🌾/−1 🪙 per city/HV province is applied by the economy plague
    // reader each live round (both rounds), NOT immediately — no treasury change on
    // the draw round, so the draw round is not double-penalised.
    expect(player(after, "p1").treasury.grain).toBe(grainBefore);
    expect(player(after, "p1").treasury.gold).toBe(goldBefore);
  });

  it("#39 Relic Discovered posts a FACTION-targeted +1 gold/round income modifier (FL-19b)", () => {
    const s = fresh(seats4); // drawer = active p1 (Byzantium), holds relic provinces
    const after = resolveCard(s, omenCardId(39));
    const mod = after.activeModifiers.find((m) => m.sourceCardId === omenCardId(39));
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe("income");
    expect(mod!.value).toBe(1);
    expect(mod!.scope).toBe("game");
    // FL-19b: economy's income reader ignores untargeted modifiers, so #39 must be
    // scoped to the enshrining/owning faction (the drawer) to be attributed.
    expect(mod!.target!.faction).toBe(Faction.BYZANTIUM);
  });

  it("#36 Gunpowder Revolution posts standing siege (+1) and wall (−1) modifiers", () => {
    const after = resolveCard(fresh(seats4), omenCardId(36));
    const siege = after.activeModifiers.find(
      (m) => m.sourceCardId === omenCardId(36) && m.kind === "siege_mod",
    );
    const wall = after.activeModifiers.find(
      (m) => m.sourceCardId === omenCardId(36) && m.kind === "wall_mod",
    );
    expect(siege?.value).toBe(1);
    expect(siege?.scope).toBe("game");
    expect(wall?.value).toBe(-1);
    expect(wall?.scope).toBe("game");
  });

  it("an Immediate card (#1 Bumper Harvest) posts no durable modifier", () => {
    const after = resolveCard(fresh(seats4), omenCardId(1));
    expect(after.activeModifiers.some((m) => m.sourceCardId === omenCardId(1))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Marshal events-major fixes: #25 5-tier wall shift, #11 corsair predicate,
// #17/#29 faith effects CONSUMED by economy (EVENT_CARDS.md #25/#11/#17/#29)
// ---------------------------------------------------------------------------

describe("#25 Earthquake — wall shifts move exactly the printed amount in the 5-tier model (GD §8.1)", () => {
  it("drops Constantinople's T5 Theodosian walls ONE tier (5→4), not two (pre-fix clamp bug)", () => {
    const s = fresh(seats4);
    const before = s.provinces.find((p) => p.id === "constantinople")!;
    expect(before.walls.tier).toBe(5); // T5 Theodosian, 16 HP (CANON #4)
    expect(before.walls.hp).toBe(WALL_TIERS[5].hp);
    const after = resolveCard(s, omenCardId(25), { choice: "constantinople" });
    const prov = after.provinces.find((p) => p.id === "constantinople")!;
    // Printed effect: "wall tier −1". The old clamp pinned to the retired 4-tier
    // model's tier 3, so a T5 wall dropped TWO tiers (5→3).
    expect(prov.walls.tier).toBe(4);
    expect(prov.walls.hp).toBe(WALL_TIERS[4].hp);
  });
});

describe("#11 Corsair Raid — victim predicate selects a named-sea shore province (EVENT_CARDS #11)", () => {
  it("raids an OWNED coastal province bordering the raided corsair sea — never Constantinople (pre-fix vacuous predicate)", () => {
    const s = fresh(seats4);
    const after = resolveCard(s, omenCardId(11));
    const entry = after.log.find((e) => /Corsair Raid/.test(e.message))!;
    expect(entry).toBeDefined();
    const zone = entry.data!.seaZone as string;
    const victimId = entry.data!.province as string;
    expect(["sicilian-channel", "eastern-mediterranean", "aegean"]).toContain(zone);
    // The victim fronts the raided sea (province↔sea ADJACENCY edge) …
    expect(victimId).toBeDefined();
    expect(neighborsOf(victimId)).toContain(zone);
    const victim = s.provinces.find((p) => p.id === victimId)!;
    expect(victim.coastal).toBe(true);
    expect(victim.ownerId).not.toBeNull();
    // … which Constantinople (Marmara/Bosphorus) does not — the pre-fix predicate
    // was vacuously true and ALWAYS struck Constantinople.
    expect(victimId).not.toBe("constantinople");
    // STATE delta, not just a log: the victim's owner lost exactly 2 gold.
    expect(player(after, victim.ownerId!).treasury.gold).toBe(
      player(s, victim.ownerId!).treasury.gold - 2,
    );
  });

  it("is deterministic — same seed/state raids the same province and sea", () => {
    const run = () => {
      const after = resolveCard(fresh(seats4), omenCardId(11));
      const entry = after.log.find((e) => /Corsair Raid/.test(e.message))!;
      return `${entry.data!.province}@${entry.data!.seaZone}`;
    };
    expect(run()).toBe(run());
  });
});

describe("#17 Council of Florence — faith effect CONSUMED by economy (EVENT_CARDS #17)", () => {
  it("ACCEPT posts a BYZANTIUM-targeted faith_income −2 (2 rounds) with no immediate treasury hit", () => {
    const s = fresh(seats4); // Byzantium = p1, round 1
    const faithBefore = player(s, "p1").treasury.faith;
    const accepted = resolveCard(s, omenCardId(17), { choice: "ACCEPT" });
    // No immediate treasury hit — the recurrence is delivered by the modifier
    // (FL-04 pattern; the omen resolves at the front of INCOME).
    expect(player(accepted, "p1").treasury.faith).toBe(faithBefore);
    const mod = accepted.activeModifiers.find(
      (m) => m.sourceCardId === omenCardId(17) && m.kind === "faith_income",
    )!;
    expect(mod).toBeDefined();
    expect(mod.value).toBe(-2);
    expect(mod.target!.faction).toBe(Faction.BYZANTIUM);
    // durationRounds 2, posted round 1 → live rounds 1..2, lapses at round 2 cleanup.
    expect(mod.expiresRound).toBe(2);
  });

  it("CONSUMPTION: after ACCEPT the next Income phase credits Byzantium −2 faith; the Ottoman is untouched", () => {
    const s = fresh(seats4);
    const base = applyIncomePhase(s);
    const byzBaseGain = player(base, "p1").treasury.faith - player(s, "p1").treasury.faith;
    const ottBaseGain = player(base, "p2").treasury.faith - player(s, "p2").treasury.faith;
    expect(byzBaseGain).toBeGreaterThan(2); // Byzantium is the faith faction
    const accepted = resolveCard(s, omenCardId(17), { choice: "ACCEPT" });
    const income = applyIncomePhase(accepted);
    const byzGain =
      player(income, "p1").treasury.faith - player(accepted, "p1").treasury.faith;
    const ottGain =
      player(income, "p2").treasury.faith - player(accepted, "p2").treasury.faith;
    // The printed −2 ✝️/round actually lands on Byzantium's income…
    expect(byzGain).toBe(byzBaseGain - 2);
    // …and ONLY on Byzantium (the modifier is faction-targeted).
    expect(ottGain).toBe(ottBaseGain);
  });

  it("REFUSE posts no faith modifier and leaves Byzantine faith income whole", () => {
    const s = fresh(seats4);
    const refused = resolveCard(s, omenCardId(17), { choice: "REFUSE" });
    expect(
      refused.activeModifiers.some(
        (m) => m.sourceCardId === omenCardId(17) && m.kind === "faith_income",
      ),
    ).toBe(false);
    const base = applyIncomePhase(s);
    const income = applyIncomePhase(refused);
    const baseGain = player(base, "p1").treasury.faith - player(s, "p1").treasury.faith;
    const gain = player(income, "p1").treasury.faith - player(refused, "p1").treasury.faith;
    expect(gain).toBe(baseGain);
  });
});

describe("#29 Schism — faith halving CONSUMED by economy (EVENT_CARDS #29)", () => {
  it("posts a faction-targeted faith_mult ×0.5 for EVERY seated faction, round-scoped", () => {
    const s = fresh(seats4);
    const after = resolveCard(s, omenCardId(29));
    const mods = after.activeModifiers.filter(
      (m) => m.sourceCardId === omenCardId(29) && m.kind === "faith_mult",
    );
    expect(mods).toHaveLength(4);
    for (const mod of mods) {
      expect(mod.value).toBe(0.5);
      expect(mod.scope).toBe("round"); // lapses at this round's cleanup
    }
    const targeted = new Set(mods.map((m) => m.target!.faction));
    expect(targeted).toEqual(
      new Set([Faction.BYZANTIUM, Faction.OTTOMAN, Faction.VENICE, Faction.GENOA]),
    );
  });

  it("CONSUMPTION: the Income phase after the Schism credits every faction HALF its faith (floored)", () => {
    const s = fresh(seats4);
    const base = applyIncomePhase(s);
    const schism = resolveCard(s, omenCardId(29));
    const income = applyIncomePhase(schism);
    for (const id of ["p1", "p2", "p3", "p4"]) {
      const baseGain = player(base, id).treasury.faith - player(s, id).treasury.faith;
      const gain = player(income, id).treasury.faith - player(schism, id).treasury.faith;
      // "All ✝️ income halved" actually lands in the treasury (state delta).
      expect(gain).toBe(Math.floor(baseGain * 0.5));
    }
    // The halving is a real cut for the faith faction, not a vacuous 0 → 0.
    const byzBaseGain = player(base, "p1").treasury.faith - player(s, "p1").treasury.faith;
    expect(byzBaseGain).toBeGreaterThan(Math.floor(byzBaseGain * 0.5));
  });

  it("still applies the printed −1 prestige to the faith-reliant factions", () => {
    const s = fresh(seats4);
    const after = resolveCard(s, omenCardId(29));
    expect(player(after, "p1").prestige).toBe(-1); // Byzantium
    expect(player(after, "p3").prestige).toBe(0); // Venice not faith-reliant
  });
});
