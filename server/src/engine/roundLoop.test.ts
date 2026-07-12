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
import { describe, it, expect, vi } from "vitest";
import {
  BuildingType,
  Faction,
  GamePhase,
  UnitType,
  asTacticCardId,
  type Army,
  type GameState,
  type PendingBattle,
  type SiegeState,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "./gameState.js";
import { advancePhase } from "./roundLoop.js";
import { WALL_TIERS, WALL_REPAIR_PER_ROUND } from "./balance.js";
import type { Rng } from "./rng.js";

// COMBAT-containment injection: pass-through mock of the combat subsystem that
// throws ONLY for the sentinel id "inject-throw" (no real fixture uses it), so
// every other test in this file exercises the REAL resolvers unchanged.
vi.mock("./combat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./combat.js")>();
  return {
    ...actual,
    resolveBattle: (state: GameState, battle: PendingBattle, rng: Rng) => {
      if (battle.id === "inject-throw") throw new Error("injected battle failure");
      return actual.resolveBattle(state, battle, rng);
    },
    resolveSiege: (state: GameState, siege: SiegeState, rng: Rng) => {
      if (siege.id === "inject-throw") throw new Error("injected siege failure");
      return actual.resolveSiege(state, siege, rng);
    },
  };
});

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

/** A minimal valid SiegeState for fixtures (spread-override what a test needs). */
function siegeEntry(provinceId: string, over: Partial<SiegeState> = {}): SiegeState {
  return {
    provinceId,
    besiegerId: "p2",
    besiegingArmyIds: ["bes-1"],
    roundsElapsed: 1,
    grainStores: 3,
    breached: false,
    circumvallated: true,
    ...over,
  };
}

/** fresh() with the Omen sub-phase neutralised (no card to perturb walls/state). */
function freshNoOmen(): GameState {
  const s = fresh();
  return { ...s, omenDeck: [], omenDiscard: [], eraDecksRemaining: {} };
}

describe("§8.1/§8.2.5 — per-round wall repair (marshal major: not only on siege-lift)", () => {
  it("a damaged, un-besieged wall regains +1 HP each round at INCOME, clamped to tier max", () => {
    const s = freshNoOmen();
    const prov = s.provinces.find((p) => !p.port && !p.isCapitalOf)!;
    prov.walls = { tier: 2, hp: WALL_TIERS[2].hp - 2 }; // 4 of 6
    const hpOf = (st: GameState): number => st.provinces.find((p) => p.id === prov.id)!.walls.hp;

    // Round 1 INCOME: +WALL_REPAIR_PER_ROUND (no siege anywhere near it).
    let next = advancePhase(s);
    expect(next.phase).toBe(GamePhase.RECRUITMENT);
    expect(hpOf(next)).toBe(WALL_TIERS[2].hp - 2 + WALL_REPAIR_PER_ROUND); // 5

    // Next round's INCOME: back to tier max.
    next = advancePhase({ ...next, phase: GamePhase.INCOME });
    expect(hpOf(next)).toBe(WALL_TIERS[2].hp); // 6 — fully healed

    // And a healthy wall is CLAMPED at max, never over-repaired.
    next = advancePhase({ ...next, phase: GamePhase.INCOME });
    expect(hpOf(next)).toBe(WALL_TIERS[2].hp);
  });

  it("a wall under an ACTIVE siege does NOT repair", () => {
    const s = freshNoOmen();
    const prov = s.provinces.find((p) => !p.port && !p.isCapitalOf)!;
    prov.ownerId = "p1";
    prov.walls = { tier: 2, hp: 3 };
    s.armies.push(army("bes-1", "p2", prov.id, 5));
    s.siegeStates = [siegeEntry(prov.id)];
    prov.siege = { ...s.siegeStates[0] };

    const next = advancePhase(s); // INCOME work runs
    const after = next.provinces.find((p) => p.id === prov.id)!;
    expect(after.walls.hp).toBe(3); // besieged → §8.2.5 repair suppressed
  });

  it("repair resumes once the siege lifts (besiegers marched away)", () => {
    const s = freshNoOmen();
    const prov = s.provinces.find((p) => !p.port && !p.isCapitalOf)!;
    prov.ownerId = "p1";
    prov.walls = { tier: 2, hp: 3 };
    // The besieging army is NOT in the province (marched away): §8.2 step-1 siege
    // lock recomputation inside resolveSiege finds no besiegers → the siege LIFTS.
    s.siegeStates = [siegeEntry(prov.id, { besiegingArmyIds: ["ghost-army"] })];
    prov.siege = { ...s.siegeStates[0] };

    const afterCombat = advancePhase({ ...s, phase: GamePhase.COMBAT });
    expect(afterCombat.phase).toBe(GamePhase.END);
    expect(afterCombat.siegeStates).toHaveLength(0); // siege lifted
    const lifted = afterCombat.provinces.find((p) => p.id === prov.id)!;
    expect(lifted.walls.hp).toBe(3 + WALL_REPAIR_PER_ROUND); // §8.2.5 lift tick (combat)

    // The following round's INCOME: per-round repair has RESUMED.
    const afterIncome = advancePhase({ ...afterCombat, phase: GamePhase.INCOME });
    const healed = afterIncome.provinces.find((p) => p.id === prov.id)!;
    expect(healed.walls.hp).toBe(3 + 2 * WALL_REPAIR_PER_ROUND);
  });
});

describe("§8.2 step 4 — COMBAT fights an assault ONLY when declared (SIEGE_ASSAULT)", () => {
  /**
   * Same seed, one bit flipped: a breached (Wall HP 0) inland city held by a
   * 1-unit garrison, besieged by 40 p2 infantry with NO siege engines — so an
   * undeclared round rolls ZERO dice (nothing to bombard with, no assault).
   */
  function besiegedFixture(assaultDeclared: boolean): GameState {
    const s = freshNoOmen();
    const prov = s.provinces.find((p) => !p.port && !p.isCapitalOf)!;
    prov.ownerId = "p1";
    prov.walls = { tier: 2, hp: 0 };
    prov.garrison = 1;
    s.armies = s.armies.filter((a) => a.locationId !== prov.id);
    s.armies.push(army("bes-1", "p2", prov.id, 40));
    s.siegeStates = [
      siegeEntry(prov.id, { breached: true, ...(assaultDeclared ? { assaultDeclared } : {}) }),
    ];
    prov.siege = { ...s.siegeStates[0] };
    return { ...s, phase: GamePhase.COMBAT };
  }
  const provId = (s: GameState): string => s.siegeStates[0].provinceId;

  it("an UNDECLARED siege round is passive: no assault dice, no storm — stores still deplete", () => {
    const before = besiegedFixture(false);
    const id = provId(before);
    const next = advancePhase(before);
    const prov = next.provinces.find((p) => p.id === id)!;
    expect(prov.ownerId).toBe("p1"); // city did NOT fall
    expect(prov.garrison).toBe(1); // garrison untouched — no storm was fought
    // Dice-outcome delta: NOTHING was rolled (no guns, no declared assault) —
    // the phase's rng cursor is byte-identical to the input state's.
    expect(next.rngCursor).toBe(before.rngCursor);
    // …but the siege still pressed passively: one grain store depleted (§8.2.3).
    expect(next.siegeStates[0]?.grainStores).toBe(2);
  });

  it("same seed WITH assaultDeclared: assault dice are rolled and the breach is stormed", () => {
    const undeclared = advancePhase(besiegedFixture(false));
    const before = besiegedFixture(true);
    const id = provId(before);
    const declared = advancePhase(before);
    // CONSUMPTION delta vs the undeclared twin: the assault actually consumed
    // dice from the one COMBAT rng stream…
    expect(declared.rngCursor).toBeGreaterThan(undeclared.rngCursor);
    // …and 40 infantry through a breach vs 1 garrison unit take the city (§8.2.4:
    // Wall HP 0 → field odds): ownership flips, the siege ends.
    const prov = declared.provinces.find((p) => p.id === id)!;
    expect(prov.ownerId).toBe("p2");
    expect(declared.siegeStates).toHaveLength(0);
    // The undeclared twin left ownership untouched (assault only when declared).
    expect(undeclared.provinces.find((p) => p.id === id)!.ownerId).toBe("p1");
  });
});

describe("COMBAT containment — a throwing resolution never blocks advancePhase (marshal major)", () => {
  it("a throwing battle is skipped+logged; other engagements still resolve; queued tactics are swept to the discard", () => {
    const s = freshNoOmen();
    // Battle that will throw (sentinel id intercepted by the pass-through mock).
    const battleProv = s.provinces[1].id;
    const boom: PendingBattle = {
      id: "inject-throw",
      provinceId: battleProv,
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: [],
      defenderStackIds: [],
      attackerTactics: [asTacticCardId("feigned-retreat")],
    };
    s.pendingBattles = [boom];
    // A REAL siege alongside it that must still resolve (ghost besiegers → lift).
    const siegedProv = s.provinces.find((p) => !p.port && !p.isCapitalOf)!;
    siegedProv.ownerId = "p1";
    siegedProv.walls = { tier: 2, hp: 3 };
    s.siegeStates = [siegeEntry(siegedProv.id, { besiegingArmyIds: ["ghost-army"] })];

    const next = advancePhase({ ...s, phase: GamePhase.COMBAT });
    // The phase ADVANCED despite the throw; the battle queue is cleared.
    expect(next.phase).toBe(GamePhase.END);
    expect(next.pendingBattles).toHaveLength(0);
    // The failure was contained with a chronicle entry naming the engagement.
    const contained = next.log.find((l) => l.data?.contained === true);
    expect(contained).toBeDefined();
    expect(contained?.data?.id).toBe("inject-throw");
    expect(contained?.type).toBe("battle");
    // The sibling siege STILL resolved (lifted, §8.2.5 repair tick applied).
    expect(next.siegeStates).toHaveLength(0);
    expect(next.provinces.find((p) => p.id === siegedProv.id)!.walls.hp).toBe(4);
    // §7.7 48-card conservation: the queued-but-unresolved tactic card was swept
    // into tacticDiscard rather than vanishing with the cleared battle.
    expect(next.tacticDiscard).toContain(asTacticCardId("feigned-retreat"));
  });

  it("a throwing SIEGE is skipped+logged and its stale assault declaration is cleared by the round loop", () => {
    const s = freshNoOmen();
    const prov = s.provinces.find((p) => !p.port && !p.isCapitalOf)!;
    prov.ownerId = "p1";
    prov.walls = { tier: 2, hp: 6 };
    s.armies.push(army("bes-1", "p2", prov.id, 5));
    s.siegeStates = [siegeEntry(prov.id, { id: "inject-throw", assaultDeclared: true })];
    prov.siege = { ...s.siegeStates[0] };

    const next = advancePhase({ ...s, phase: GamePhase.COMBAT });
    expect(next.phase).toBe(GamePhase.END); // contained → phase still advanced
    const contained = next.log.find((l) => l.data?.contained === true);
    expect(contained?.type).toBe("siege");
    expect(contained?.data?.id).toBe("inject-throw");
    // Belt and braces (§8.2 step 4): combat NEVER consumed the declaration (it
    // threw), yet the round loop clears it — on the siege entry AND the mirror —
    // so a stale declaration cannot auto-assault next round.
    expect(next.siegeStates).toHaveLength(1);
    expect(next.siegeStates[0].assaultDeclared).toBe(false);
    expect(next.provinces.find((p) => p.id === prov.id)!.siege?.assaultDeclared).toBe(false);
  });
});
