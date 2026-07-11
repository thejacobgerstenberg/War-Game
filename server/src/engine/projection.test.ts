/**
 * projection.test.ts — fog-of-war state projection (ARCHITECTURE §4.3, §5.3).
 *
 * Verifies that {@link projectStateFor}:
 *  - fully preserves the REQUESTING player's own objectives / hand / tacticHand;
 *  - redacts every OTHER player's objectives / hand / tacticHand to same-length
 *    hidden stubs (count public, contents hidden);
 *  - flattens the undrawn omen / era / tactic deck ORDERINGS to hidden stacks
 *    for everyone (nobody may peek the next draw);
 *  - leaves all public info (provinces, armies, treasury, prestige, log …)
 *    intact; and
 *  - never mutates the input state (purity).
 */
import { describe, it, expect } from "vitest";
import {
  Faction,
  asTacticCardId,
  type Card,
  type GameState,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "./gameState.js";
import { projectStateFor } from "./projection.js";

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

const card = (id: string): Card => ({
  id,
  name: `Card ${id}`,
  description: "secret",
  cost: { gold: 1 },
});

/** A fresh state seeded with non-trivial hidden holdings for both players. */
function fixture(): GameState {
  const state = structuredClone(createInitialState("ROOM01", seats, 12345));
  // Give each seat some hand + tactic-hand cards so redaction is observable.
  state.players[0].hand = [card("byz-a"), card("byz-b")];
  state.players[1].hand = [card("ott-a"), card("ott-b"), card("ott-c")];
  state.players[0].tacticHand = [asTacticCardId("t-byz-1")];
  state.players[1].tacticHand = [
    asTacticCardId("t-ott-1"),
    asTacticCardId("t-ott-2"),
  ];
  // Ensure the decks whose ordering must be hidden are non-empty.
  state.omenDeck = ["omen-1", "omen-2", "omen-3"];
  state.eraDecksRemaining = { 2: ["e2-a", "e2-b"], 3: ["e3-a"] };
  state.tacticDeck = [asTacticCardId("deck-1"), asTacticCardId("deck-2")];
  return state;
}

const allHidden = (ids: readonly string[]): boolean =>
  ids.every((id) => id === "hidden");

describe("projectStateFor", () => {
  it("preserves the requesting player's own secret holdings", () => {
    const state = fixture();
    const view = projectStateFor(state, "p1");
    const me = view.players.find((p) => p.id === "p1")!;
    expect(me.objectives).toEqual(state.players[0].objectives);
    expect(me.hand).toEqual(state.players[0].hand);
    expect(me.tacticHand).toEqual(state.players[0].tacticHand);
  });

  it("redacts other players' objectives to same-length hidden stubs", () => {
    const state = fixture();
    const view = projectStateFor(state, "p1");
    const them = view.players.find((p) => p.id === "p2")!;
    expect(them.objectives).toHaveLength(state.players[1].objectives.length);
    for (const obj of them.objectives) {
      expect(obj.id).toBe("hidden");
      expect(obj.provinceRefs).toEqual([]);
      expect(obj.prestige).toBe(0);
    }
    // Nothing of the real objective survives.
    const realIds = state.players[1].objectives.map((o) => o.id);
    expect(them.objectives.some((o) => realIds.includes(o.id))).toBe(false);
  });

  it("redacts other players' hand and tacticHand, preserving counts", () => {
    const state = fixture();
    const view = projectStateFor(state, "p1");
    const them = view.players.find((p) => p.id === "p2")!;
    expect(them.hand).toHaveLength(3);
    expect(them.hand.every((c) => c.id === "hidden")).toBe(true);
    expect(them.tacticHand).toHaveLength(2);
    expect(allHidden(them.tacticHand as unknown as string[])).toBe(true);
  });

  it("leaves a redacted seat's public fields intact", () => {
    const state = fixture();
    const view = projectStateFor(state, "p1");
    const them = view.players.find((p) => p.id === "p2")!;
    expect(them.name).toBe("Murad");
    expect(them.faction).toBe(Faction.OTTOMAN);
    expect(them.treasury).toEqual(state.players[1].treasury);
    expect(them.prestige).toBe(state.players[1].prestige);
    expect(them.tax).toBe(state.players[1].tax);
  });

  it("hides the undrawn deck orderings from everyone (including the owner)", () => {
    const state = fixture();
    for (const seat of ["p1", "p2"]) {
      const view = projectStateFor(state, seat);
      expect(view.omenDeck).toHaveLength(3);
      expect(allHidden(view.omenDeck)).toBe(true);
      expect(view.eraDecksRemaining[2]).toHaveLength(2);
      expect(view.eraDecksRemaining[3]).toHaveLength(1);
      expect(allHidden(view.eraDecksRemaining[2]!)).toBe(true);
      expect(allHidden(view.eraDecksRemaining[3]!)).toBe(true);
      expect(view.tacticDeck).toHaveLength(2);
      expect(allHidden(view.tacticDeck as unknown as string[])).toBe(true);
    }
  });

  it("preserves public board and log state", () => {
    const state = fixture();
    const view = projectStateFor(state, "p1");
    expect(view.provinces).toEqual(state.provinces);
    expect(view.armies).toEqual(state.armies);
    expect(view.fleets).toEqual(state.fleets);
    // The chronicle is preserved verbatim EXCEPT the RNG seed is scrubbed from
    // the game_start entry (it would let a client re-derive every shuffle/roll).
    const expectedLog = structuredClone(state.log);
    for (const entry of expectedLog) if (entry.data) delete entry.data.seed;
    expect(view.log).toEqual(expectedLog);
    expect(state.log[0].data?.seed).toBeDefined(); // sanity: source really has it
    expect(view.log[0].data?.seed).toBeUndefined();
    expect(view.roomCode).toBe(state.roomCode);
    expect(view.omenDiscard).toEqual(state.omenDiscard);
  });

  it("redacts the RNG seed and cursor from every seat's view", () => {
    const state = fixture();
    for (const seat of ["p1", "p2", "__nobody__"]) {
      const view = projectStateFor(state, seat);
      expect(view.rngSeed).toBe(0);
      expect(view.rngCursor).toBe(0);
      // The real seed must not survive anywhere on the wire.
      expect(JSON.stringify(view)).not.toContain(String(state.rngSeed));
    }
  });

  it("does not mutate the input state", () => {
    const state = fixture();
    const before = structuredClone(state);
    projectStateFor(state, "p1");
    expect(state).toEqual(before);
  });

  it("hides every seat when the requester is unknown (seatless socket)", () => {
    const state = fixture();
    const view = projectStateFor(state, "__nobody__");
    for (const p of view.players) {
      expect(p.hand.every((c) => c.id === "hidden")).toBe(true);
      expect(p.objectives.every((o) => o.id === "hidden")).toBe(true);
    }
  });
});
