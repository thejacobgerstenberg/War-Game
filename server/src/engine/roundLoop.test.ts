/**
 * roundLoop.test.ts — the phase/turn state machine (§9.1/§10).
 *
 * Covers the two FL fixes owned by roundLoop.ts:
 *  - FL-11 (§9.1/§10.0, CANON #2): the per-round action budget is base 4 even for
 *    a University owner (the University gives a tactic-card DRAW, not a 5th
 *    action); only a card-posted `action_bonus` modifier may raise it to 5.
 *  - FL-21 (§6.4/§10 phase-5): a province occupied-and-uncontested flips ownership
 *    at END cleanup, NOT mid-MOVE, driven by the `pendingOccupations` queue.
 *  - §13.4 (clarification): the turn-order CATCH-UP reshuffle — at cleanup,
 *    `turnOrder` is re-sorted so the lowest-prestige power acts first next round
 *    (tiebreak: fewer provinces). No first-player token / action bonus; just the
 *    initiative reshuffle, settled AT cleanup on the freshly-scored prestige.
 */
import { describe, it, expect } from "vitest";
import {
  BuildingType,
  Faction,
  GamePhase,
  UnitType,
  type Army,
  type GameState,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "./gameState.js";
import { advancePhase } from "./roundLoop.js";

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

function fresh(): GameState {
  return structuredClone(createInitialState("ROOM01", seats, 12345));
}

const zeroUnits = (): Record<UnitType, number> => ({
  [UnitType.LEVY]: 0,
  [UnitType.INFANTRY]: 0,
  [UnitType.CAVALRY]: 0,
  [UnitType.ARCHER]: 0,
  [UnitType.SIEGE]: 0,
  [UnitType.GALLEY]: 0,
  [UnitType.WARSHIP]: 0,
});

/** A land stack of `infantry` INFANTRY at `locationId` owned by `ownerId`. */
function army(id: string, ownerId: string, locationId: string, infantry: number): Army {
  return {
    id,
    ownerId,
    locationId,
    units: { ...zeroUnits(), [UnitType.INFANTRY]: infantry },
  };
}

function actionsOf(state: GameState, id: string): number {
  const p = state.players.find((pl) => pl.id === id);
  if (!p) throw new Error(`no player ${id}`);
  return p.actionsRemaining;
}

describe("FL-11 — action budget (§9.1/§10.0, CANON #2)", () => {
  it("owning a University does NOT grant a 5th action; budget stays base 4", () => {
    const state = fresh();
    // Give p1 a University on a province it owns (its former +1-action source).
    const owned = state.provinces.find((prov) => prov.ownerId === "p1");
    if (!owned) throw new Error("p1 owns no province");
    owned.buildings = [BuildingType.UNIVERSITY];

    // advancePhase(INCOME) runs resetActionBudgets on the way to RECRUITMENT.
    const next = advancePhase(state);
    expect(next.phase).toBe(GamePhase.RECRUITMENT);
    // FL-11: base 4, NOT 5 — the old University action bonus is gone.
    expect(actionsOf(next, "p1")).toBe(4);
  });

  it("a card-posted action_bonus modifier is the only way to reach 5", () => {
    let state = fresh();
    state = {
      ...state,
      activeModifiers: [
        {
          id: "card:action_bonus",
          scope: "round",
          kind: "action_bonus",
          value: 1,
          data: { playerId: "p1" },
        },
      ],
    };
    const next = advancePhase(state);
    // §10.0: certain cards raise the budget to 5; p2 (no modifier) stays at 4.
    expect(actionsOf(next, "p1")).toBe(5);
    expect(actionsOf(next, "p2")).toBe(4);
  });
});

describe("FL-21 — deferred occupation flip (§6.4/§10 phase-5)", () => {
  /** Set up a pending occupation: p1's stack sits in an empty tile owned by p2. */
  function withPendingOccupation(base: GameState, provId: string): GameState {
    const state = structuredClone(base);
    const prov = state.provinces.find((p) => p.id === provId)!;
    prov.ownerId = "p2";
    prov.garrison = 0;
    state.armies.push(army("a1", "p1", provId, 3));
    state.pendingOccupations = [
      { provinceId: provId, occupantId: "p1", sinceRound: state.round },
    ];
    return state;
  }

  it("does NOT flip ownership mid-MOVE (RECRUITMENT/MOVEMENT/DIPLOMACY)", () => {
    const base = fresh();
    const provId = base.provinces[0].id;
    let state = withPendingOccupation(base, provId);
    state = { ...state, phase: GamePhase.MOVEMENT };

    const next = advancePhase(state); // MOVEMENT → DIPLOMACY
    const prov = next.provinces.find((p) => p.id === provId)!;
    // Ownership is still p2's; the queue is untouched until END cleanup.
    expect(prov.ownerId).toBe("p2");
    expect(next.pendingOccupations).toHaveLength(1);
  });

  it("flips an occupied, uncontested empty province at END cleanup", () => {
    const base = fresh();
    const provId = base.provinces[0].id;
    let state = withPendingOccupation(base, provId);
    state = { ...state, phase: GamePhase.END };

    const next = advancePhase(state);
    const prov = next.provinces.find((p) => p.id === provId)!;
    // §6.4: ownership resolves to the occupant at cleanup; queue is cleared.
    expect(prov.ownerId).toBe("p1");
    expect(prov.garrison ?? 0).toBe(0);
    expect(next.pendingOccupations ?? []).toHaveLength(0);
  });

  it("does NOT flip a contested tile (a rival stack is present), but clears the queue", () => {
    const base = fresh();
    const provId = base.provinces[0].id;
    let state = withPendingOccupation(base, provId);
    // A rival p2 stack contests the tile.
    state.armies.push(army("a2", "p2", provId, 2));
    state = { ...state, phase: GamePhase.END };

    const next = advancePhase(state);
    const prov = next.provinces.find((p) => p.id === provId)!;
    expect(prov.ownerId).toBe("p2"); // contested → no flip
    expect(next.pendingOccupations ?? []).toHaveLength(0); // resolved either way
  });

  it("does NOT flip if the occupant no longer holds the tile", () => {
    const base = fresh();
    const provId = base.provinces[0].id;
    const state = structuredClone(base);
    const prov = state.provinces.find((p) => p.id === provId)!;
    prov.ownerId = "p2";
    // No p1 army present (the occupier moved on / was destroyed). provinces[0] is
    // constantinople, which seeds a p1 starting garrison stack — clear any stack
    // at the tile so the "occupant no longer holds" branch is genuinely exercised.
    state.armies = state.armies.filter((a) => a.locationId !== provId);
    state.pendingOccupations = [
      { provinceId: provId, occupantId: "p1", sinceRound: state.round },
    ];
    const ended = advancePhase({ ...state, phase: GamePhase.END });
    const p = ended.provinces.find((x) => x.id === provId)!;
    expect(p.ownerId).toBe("p2");
    expect(ended.pendingOccupations ?? []).toHaveLength(0);
  });
});

describe("§13.4 — turn-order catch-up reshuffle", () => {
  const prov = (s: GameState, id: string): number =>
    s.provinces.filter((p) => p.ownerId === id).length;

  it("re-sorts turnOrder lowest-prestige-first AT cleanup (before the next INCOME runs)", () => {
    // §13.4: "At cleanup, turnOrder is re-sorted so the lowest-prestige power acts
    // first next round." A single END→INCOME advance runs the CLEANUP block but NOT
    // the INCOME block (that fires on the following advance), so any reshuffle we
    // observe here was performed by the cleanup catch-up lever, not by INCOME.
    let s = fresh();
    // Strip holdings so END scorePrestige adds ~nothing and no one crosses the 2p
    // win threshold (25) — isolates the §13.4 reshuffle from scoring/victory.
    s.provinces.forEach((p) => (p.ownerId = null));
    s.players.find((p) => p.id === "p2")!.prestige = 12; // p2 leads (below 25)
    s.players.find((p) => p.id === "p1")!.prestige = 0; // p1 is the underdog
    s = { ...s, phase: GamePhase.END };

    const after = advancePhase(s); // END cleanup → INCOME of round 2
    expect(after.phase).toBe(GamePhase.INCOME); // round advanced (no victory)
    expect(after.round).toBe(2);
    // §13.4 initiative to the underdog: the lowest-prestige power (p1) acts first,
    // and the active-player pointer is reset to the head of the fresh order.
    expect(after.turnOrder[0]).toBe("p1");
    expect(after.activePlayerIndex).toBe(0);
  });

  it("§13.4 tiebreak: on equal prestige the power with FEWER provinces acts first", () => {
    // Neutralise the Omen sub-phase (no card to resolve) so prestige stays exactly
    // as set through the INCOME reshuffle; INCOME does not run scorePrestige.
    let s = fresh();
    s = { ...s, omenDeck: [], omenDiscard: [], eraDecksRemaining: {} };
    // Equal prestige (0 = 0) forces the §13.4 tiebreak = fewer provinces. Reassign
    // provinces so p2 (the LATER seat) trails on count — proving the order comes
    // from the province tiebreak, not the original seat order.
    let moved = 0;
    for (const p of s.provinces) {
      if (p.ownerId === "p2" && moved < 4) {
        p.ownerId = "p1";
        moved += 1;
      }
    }
    expect(prov(s, "p2")).toBeLessThan(prov(s, "p1")); // p2 now holds fewer

    const after = advancePhase(s); // INCOME reshuffle applies §13.4
    expect(after.turnOrder[0]).toBe("p2"); // fewer provinces ⇒ acts first
    expect(after.turnOrder).toEqual(["p2", "p1"]);
  });

  it("§13.4 confirms the ratified rule only — no extra action / first-player token", () => {
    // The catch-up is the initiative reshuffle itself: the trailing player does NOT
    // gain a bonus action or a persistent token, only the earlier slot in turnOrder.
    let s = fresh();
    s.provinces.forEach((p) => (p.ownerId = null));
    s.players.find((p) => p.id === "p2")!.prestige = 12;
    s.players.find((p) => p.id === "p1")!.prestige = 0;
    s = { ...s, phase: GamePhase.END };

    const after = advancePhase(s); // END → INCOME
    const p1 = after.players.find((p) => p.id === "p1")!;
    const p2 = after.players.find((p) => p.id === "p2")!;
    // Budgets are equal (still base 4 after the next INCOME resets them) — the
    // reshuffle grants NO action bonus. The lead survives in prestige; only the
    // turn slot changed.
    expect(p2.prestige).toBe(12); // no scoring perturbation (stripped holdings)
    expect(p1.prestige).toBe(0);
    // No first-player token field is introduced; the whole mechanic is the order.
    expect(after.turnOrder).toEqual(["p1", "p2"]);
  });
});
