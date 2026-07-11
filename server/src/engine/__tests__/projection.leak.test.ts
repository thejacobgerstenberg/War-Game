/**
 * projection.leak.test.ts — HIDDEN-INFO LEAK HUNT for the fog-of-war projection.
 *
 * This is an ADVERSARIAL companion to projection.test.ts. It builds a full
 * THREE-player game via `createInitialState`, deals real secret objectives plus
 * concrete hand / tactic-hand cards to every seat, then projects the state for
 * ONE player (A) and hunts for any leak of the OTHER two players' (B, C) secrets
 * or of the undrawn deck orderings.
 *
 * A leak here is a confidentiality breach of the server-authoritative contract
 * (docs/ARCHITECTURE.md §4.3, §5.3): the wire payload sent to A must contain
 * NONE of B's or C's concrete objectives, hand cards, or tactic-hand cards, and
 * must not reveal the concrete NEXT cards of the omen / tactic decks — while A's
 * OWN secrets survive intact and all public board state is preserved.
 *
 * The strongest check is the DEEP SERIALISATION SCAN: `projectStateFor` returns
 * exactly what gets JSON-serialised onto the socket, so we stringify the whole
 * projection and assert not one of B's/C's secret tokens appears ANYWHERE in it
 * (catching leaks in nested/unexpected fields, not just the ones we thought to
 * assert on individually).
 */
import { describe, it, expect } from "vitest";
import {
  Faction,
  asTacticCardId,
  type Card,
  type GameState,
  type Player,
  type SecretObjective,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { projectStateFor } from "../projection.js";

// Three distinct factions → three distinct sets of real secret objectives.
const seats: SeatInput[] = [
  { id: "A", name: "Alexios", faction: Faction.BYZANTIUM, isHost: true },
  { id: "B", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
  { id: "C", name: "Janos", faction: Faction.HUNGARY, isHost: false },
];

/** A hand card whose every string field is a unique, greppable sentinel. */
const secretCard = (owner: string, n: number): Card => ({
  id: `HANDID_${owner}_${n}`,
  name: `HANDNAME_${owner}_${n}`,
  description: `HANDDESC_${owner}_${n}_must_never_reach_a_rival`,
  cost: { gold: n },
});

/**
 * A fully seeded 3-player game: real dealt objectives (from the faction data)
 * plus concrete, sentinel-tagged hands and tactic hands for every seat.
 */
function dealtGame(): GameState {
  const state = structuredClone(createInitialState("LEAK01", seats, 20260711));
  const [a, b, c] = state.players;
  // Concrete hands (distinct sizes so a length-vs-content confusion is visible).
  a.hand = [secretCard("A", 1), secretCard("A", 2)];
  b.hand = [secretCard("B", 1), secretCard("B", 2), secretCard("B", 3)];
  c.hand = [secretCard("C", 1)];
  // Concrete tactic hands (branded ids, sentinel-tagged per owner).
  a.tacticHand = [asTacticCardId("TAC_A_1")];
  b.tacticHand = [asTacticCardId("TAC_B_1"), asTacticCardId("TAC_B_2")];
  c.tacticHand = [
    asTacticCardId("TAC_C_1"),
    asTacticCardId("TAC_C_2"),
    asTacticCardId("TAC_C_3"),
  ];
  return state;
}

const seatOf = (s: GameState, id: string): Player =>
  s.players.find((p) => p.id === id)!;

/** Every distinct secret string that must NEVER appear in a rival's view. */
function secretTokensOf(p: Player): string[] {
  const tokens: string[] = [];
  for (const o of p.objectives) {
    tokens.push(o.id, o.description); // real dealt-objective identity + text
  }
  for (const card of p.hand) {
    tokens.push(card.id, card.name, card.description);
  }
  for (const t of p.tacticHand ?? []) tokens.push(t as unknown as string);
  // Guard against a degenerate token that would false-positive on the redactor.
  return tokens.filter((t) => t && t !== "hidden");
}

describe("projection leak hunt — 3-player game, view for A", () => {
  it("DEEP SCAN: no B or C secret token appears anywhere in A's serialised view", () => {
    const state = dealtGame();
    const view = projectStateFor(state, "A");
    const wire = JSON.stringify(view);

    const rivalSecrets = [
      ...secretTokensOf(seatOf(state, "B")),
      ...secretTokensOf(seatOf(state, "C")),
    ];
    // Sanity: the fixture actually produced secrets to hunt for.
    expect(rivalSecrets.length).toBeGreaterThan(0);

    const leaked = rivalSecrets.filter((tok) => wire.includes(tok));
    expect(leaked).toEqual([]);
  });

  it("redacts B's and C's concrete objectives (id + description + predicate fields)", () => {
    const state = dealtGame();
    const view = projectStateFor(state, "A");

    for (const rival of ["B", "C"]) {
      const src = seatOf(state, rival);
      const proj = seatOf(view, rival);
      // Count is public, contents are not.
      expect(proj.objectives).toHaveLength(src.objectives.length);
      const realIds = new Set(src.objectives.map((o) => o.id));
      const realDescs = new Set(src.objectives.map((o) => o.description));
      for (const o of proj.objectives) {
        expect(o.id).toBe("hidden");
        expect(realIds.has(o.id)).toBe(false);
        expect(realDescs.has(o.description)).toBe(false);
        expect(o.provinceRefs).toEqual([]);
        expect(o.prestige).toBe(0);
        // No richer predicate field survives to hint at the goal.
        const richKeys: (keyof SecretObjective)[] = [
          "allOf",
          "anyOf",
          "minProvinces",
          "requiresHagiaSophia",
          "minFaith",
          "refusedChurchUnion",
          "sackedHighValueCities",
          "completed",
        ];
        for (const k of richKeys) expect(o[k]).toBeUndefined();
      }
    }
  });

  it("redacts B's and C's concrete hand cards, preserving only the count", () => {
    const state = dealtGame();
    const view = projectStateFor(state, "A");

    for (const rival of ["B", "C"]) {
      const src = seatOf(state, rival);
      const proj = seatOf(view, rival);
      expect(proj.hand).toHaveLength(src.hand.length);
      for (const card of proj.hand) {
        expect(card.id).toBe("hidden");
        expect(card.name).toBe("Hidden card");
        expect(card.description).toBe("");
      }
      // None of the real ids/names survive.
      const realIds = new Set(src.hand.map((c) => c.id));
      expect(proj.hand.some((c) => realIds.has(c.id))).toBe(false);
    }
  });

  it("redacts B's and C's concrete tactic-hand cards, preserving only the count", () => {
    const state = dealtGame();
    const view = projectStateFor(state, "A");

    for (const rival of ["B", "C"]) {
      const src = seatOf(state, rival);
      const proj = seatOf(view, rival);
      expect(proj.tacticHand).toHaveLength(src.tacticHand!.length);
      const projIds = (proj.tacticHand ?? []).map((t) => t as unknown as string);
      expect(projIds.every((id) => id === "hidden")).toBe(true);
      const realIds = new Set(
        src.tacticHand!.map((t) => t as unknown as string),
      );
      expect(projIds.some((id) => realIds.has(id))).toBe(false);
    }
  });

  it("does NOT reveal the concrete next cards of the omen / era / tactic decks", () => {
    const state = dealtGame();
    // Capture the real next-to-draw cards before projecting.
    const nextOmen = state.omenDeck[0];
    const nextTactic = state.tacticDeck![0] as unknown as string;
    const nextEra2 = state.eraDecksRemaining[2]![0];
    const nextEra3 = state.eraDecksRemaining[3]![0];
    // These fixtures must actually be populated for the check to mean anything.
    expect(nextOmen).toBeDefined();
    expect(nextTactic).toBeDefined();

    const view = projectStateFor(state, "A");

    // Ordering counts are preserved; every entry is the redaction token.
    expect(view.omenDeck).toHaveLength(state.omenDeck.length);
    expect(view.omenDeck.every((c) => c === "hidden")).toBe(true);
    expect(view.omenDeck.includes(nextOmen)).toBe(false);

    const projTactic = (view.tacticDeck ?? []).map((t) => t as unknown as string);
    expect(projTactic).toHaveLength(state.tacticDeck!.length);
    expect(projTactic.every((c) => c === "hidden")).toBe(true);
    expect(projTactic.includes(nextTactic)).toBe(false);

    expect(view.eraDecksRemaining[2]!.every((c) => c === "hidden")).toBe(true);
    expect(view.eraDecksRemaining[3]!.every((c) => c === "hidden")).toBe(true);
    expect(view.eraDecksRemaining[2]!.includes(nextEra2)).toBe(false);
    expect(view.eraDecksRemaining[3]!.includes(nextEra3)).toBe(false);
  });

  it("also hides the deck orderings from A itself (A may not peek its own next draw)", () => {
    const state = dealtGame();
    const nextOmen = state.omenDeck[0];
    const view = projectStateFor(state, "A");
    // A is the requester, yet the undrawn ordering is still flattened.
    expect(view.omenDeck.every((c) => c === "hidden")).toBe(true);
    expect(view.omenDeck.includes(nextOmen)).toBe(false);
  });

  it("keeps A's OWN objectives, hand, and tactic hand fully intact", () => {
    const state = dealtGame();
    const view = projectStateFor(state, "A");
    const me = seatOf(view, "A");
    const src = seatOf(state, "A");
    expect(me.objectives).toEqual(src.objectives);
    expect(me.hand).toEqual(src.hand);
    expect(me.tacticHand).toEqual(src.tacticHand);
    // And A's own secrets DO appear on the wire (sanity: not over-redacted).
    const wire = JSON.stringify(view);
    for (const tok of secretTokensOf(src)) {
      expect(wire.includes(tok)).toBe(true);
    }
  });

  it("preserves public board, resource, prestige and log state", () => {
    const state = dealtGame();
    const view = projectStateFor(state, "A");

    // Global public structures pass through unchanged.
    expect(view.provinces).toEqual(state.provinces);
    expect(view.armies).toEqual(state.armies);
    expect(view.fleets).toEqual(state.fleets);
    expect(view.seaZones).toEqual(state.seaZones);
    // Public chronicle passes through EXCEPT the RNG seed scrubbed from game_start.
    const expectedLog = structuredClone(state.log);
    for (const entry of expectedLog) if (entry.data) delete entry.data.seed;
    expect(view.log).toEqual(expectedLog);
    expect(view.mercMarket).toEqual(state.mercMarket);
    expect(view.minors).toEqual(state.minors);
    expect(view.wars).toEqual(state.wars);
    expect(view.omenDiscard).toEqual(state.omenDiscard);
    expect(view.roomCode).toBe(state.roomCode);
    expect(view.phase).toBe(state.phase);
    expect(view.round).toBe(state.round);
    expect(view.turnOrder).toEqual(state.turnOrder);

    // Per-seat PUBLIC fields of the redacted rivals survive (not over-redacted).
    for (const rival of ["B", "C"]) {
      const src = seatOf(state, rival);
      const proj = seatOf(view, rival);
      expect(proj.name).toBe(src.name);
      expect(proj.faction).toBe(src.faction);
      expect(proj.treasury).toEqual(src.treasury);
      expect(proj.prestige).toBe(src.prestige);
      expect(proj.tax).toBe(src.tax);
      expect(proj.connected).toBe(src.connected);
    }
  });

  it("does not mutate the authoritative input state (purity)", () => {
    const state = dealtGame();
    const before = structuredClone(state);
    projectStateFor(state, "A");
    expect(state).toEqual(before);
  });

  it("hides EVERY seat's secrets for a seatless / spectator requester id", () => {
    const state = dealtGame();
    const view = projectStateFor(state, "__spectator__");
    for (const p of view.players) {
      expect(p.objectives.every((o) => o.id === "hidden")).toBe(true);
      expect(p.hand.every((c) => c.id === "hidden")).toBe(true);
      expect(
        (p.tacticHand ?? []).every((t) => (t as unknown as string) === "hidden"),
      ).toBe(true);
    }
    // No player's real secrets leak to a non-seat viewer.
    const wire = JSON.stringify(view);
    for (const id of ["A", "B", "C"]) {
      for (const tok of secretTokensOf(seatOf(state, id))) {
        expect(wire.includes(tok)).toBe(false);
      }
    }
  });
});
