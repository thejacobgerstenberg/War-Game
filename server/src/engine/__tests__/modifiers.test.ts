/**
 * modifiers.test.ts — the active-modifier side-channel helpers (CONTRACT2 §12.10).
 *
 * Covers the query/aggregate helpers (`getModifiers`, `sumModifierValues`),
 * add/remove, and — the flagged bug this pass fixes — `expireRoundModifiers`
 * cleanup semantics (§10 phase 5): round-scoped effects lapse each round while
 * persistent trade-route modifiers survive, and `expiresRound<=round` retires
 * timed persistent/game modifiers.
 */
import { describe, it, expect } from "vitest";
import { Faction, type ActiveModifier, type GameState } from "@imperium/shared";
import {
  getModifiers,
  sumModifierValues,
  addModifier,
  removeModifier,
  expireRoundModifiers,
} from "../modifiers.js";

/** Minimal state the modifier helpers actually read (round + activeModifiers). */
function mk(round: number, activeModifiers: ActiveModifier[]): GameState {
  return { round, activeModifiers } as unknown as GameState;
}

function mod(over: Partial<ActiveModifier> & Pick<ActiveModifier, "id">): ActiveModifier {
  return { scope: "round", kind: "combat_mod", ...over };
}

describe("getModifiers / sumModifierValues (query + aggregate)", () => {
  const state = mk(1, [
    mod({ id: "a", kind: "combat_mod", value: 1, target: { faction: Faction.BYZANTIUM } }),
    mod({ id: "b", kind: "combat_mod", value: 2 }), // global
    mod({ id: "c", kind: "combat_mod", value: 5, target: { faction: Faction.OTTOMAN } }),
    mod({ id: "d", kind: "siege_mod", value: 9 }),
  ]);

  it("filters by kind", () => {
    expect(getModifiers(state, "siege_mod").map((m) => m.id)).toEqual(["d"]);
  });

  it("a global (no-target) modifier matches any target query", () => {
    const hits = getModifiers(state, "combat_mod", { faction: Faction.BYZANTIUM });
    // 'a' (byz) + 'b' (global); 'c' (ottoman) excluded.
    expect(hits.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("sumModifierValues adds matching values (missing value = 0)", () => {
    expect(sumModifierValues(state, "combat_mod", { faction: Faction.OTTOMAN })).toBe(7); // c(5)+b(2)
  });
});

describe("addModifier / removeModifier are immutable", () => {
  it("addModifier returns a new state with the modifier appended", () => {
    const s0 = mk(1, []);
    const s1 = addModifier(s0, mod({ id: "x", value: 1 }));
    expect(s0.activeModifiers).toHaveLength(0); // input untouched
    expect(s1.activeModifiers.map((m) => m.id)).toEqual(["x"]);
  });

  it("removeModifier drops by id, leaving others", () => {
    const s0 = mk(1, [mod({ id: "x" }), mod({ id: "y" })]);
    const s1 = removeModifier(s0, "x");
    expect(s1.activeModifiers.map((m) => m.id)).toEqual(["y"]);
    expect(s0.activeModifiers).toHaveLength(2); // input untouched
  });
});

describe("expireRoundModifiers (§10 phase 5 cleanup)", () => {
  it("drops scope:'round' modifiers but keeps scope:'persistent' (trade routes survive)", () => {
    const s = mk(3, [
      mod({ id: "round-effect", scope: "round", value: 1 }),
      mod({ id: "trade-route", scope: "persistent", kind: "trade_mod", value: 2 }),
      mod({ id: "game-unlock", scope: "game", kind: "unlock" }),
    ]);
    const after = expireRoundModifiers(s);
    expect(after.activeModifiers.map((m) => m.id).sort()).toEqual(["game-unlock", "trade-route"]);
  });

  it("retires a persistent modifier whose expiresRound<=round; keeps future ones", () => {
    const s = mk(5, [
      mod({ id: "lapsed", scope: "persistent", expiresRound: 5 }), // active through r5 → drop at r5 cleanup
      mod({ id: "still-live", scope: "persistent", expiresRound: 6 }),
    ]);
    const after = expireRoundModifiers(s);
    expect(after.activeModifiers.map((m) => m.id)).toEqual(["still-live"]);
  });

  it("expires round-scoped prestige_pending (already-consumed awards) — CONTRACT2 §12.8", () => {
    const s = mk(4, [
      mod({
        id: "pp",
        scope: "round",
        kind: "prestige_pending",
        value: 3,
        target: { faction: Faction.OTTOMAN },
      }),
    ]);
    expect(expireRoundModifiers(s).activeModifiers).toHaveLength(0);
  });

  it("returns the SAME reference when nothing lapses (no churn)", () => {
    const s = mk(2, [mod({ id: "keep", scope: "persistent", kind: "trade_mod" })]);
    expect(expireRoundModifiers(s)).toBe(s);
  });
});
