/**
 * spy.test.ts — SPY / espionage subsystem (§10.7).
 *
 * Covers the gold cost and INSUFFICIENT_RESOURCES guard, the 1d6 ≥ 3 success
 * threshold and BOTH target-number modifiers (rival University +1, Byzantium as
 * target +1, and the two stacked → need ≥ 5), each of the three missions'
 * on-success effects (peek Omen / view a rival objective / incite unrest posts a
 * 'no_income' modifier the economy honours), and the capture prestige penalties
 * (−1 base, −2 for incite unrest — paid alongside the gold, which is spent
 * regardless of outcome). All §10.7.
 */
import { describe, it, expect } from "vitest";
import {
  BuildingType,
  Faction,
  SpyMission,
  type GameState,
  type Player,
  type Province,
  type SpyAction,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { applySpy } from "../spy.js";
import { computeIncome } from "../economy.js";
import { getModifiers } from "../modifiers.js";
import { EngineError } from "../actions.js";
import { SPY } from "../balance.js";
import { makeRng } from "../rng.js";

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

function fresh(): GameState {
  return structuredClone(createInitialState("ROOM01", seats, 12345));
}

/** Return a copy of `state` whose RNG cursor makes the next d6 roll `desired`. */
function atRoll(state: GameState, desired: number): GameState {
  for (let c = state.rngCursor; c < state.rngCursor + 4096; c += 1) {
    if (makeRng(state.rngSeed, c).rollD6() === desired) {
      return { ...state, rngCursor: c };
    }
  }
  throw new Error(`no cursor produces a roll of ${desired}`);
}

function player(state: GameState, id: string): Player {
  const p = state.players.find((pl) => pl.id === id);
  if (!p) throw new Error(`no player ${id}`);
  return p;
}

/** First province owned by `ownerId`. */
function ownedProvince(state: GameState, ownerId: string): Province {
  const prov = state.provinces.find((p) => p.ownerId === ownerId);
  if (!prov) throw new Error(`no province owned by ${ownerId}`);
  return prov;
}

/** Give `ownerId` a University in one of their provinces (returns new state). */
function grantUniversity(state: GameState, ownerId: string): GameState {
  let done = false;
  return {
    ...state,
    provinces: state.provinces.map((p) => {
      if (!done && p.ownerId === ownerId) {
        done = true;
        return { ...p, buildings: [...p.buildings, BuildingType.UNIVERSITY] };
      }
      return p;
    }),
  };
}

const omen = (player: string): SpyAction => ({
  type: "SPY",
  player,
  mission: SpyMission.OMEN,
});
const objective = (player: string, targetPlayerId: string): SpyAction => ({
  type: "SPY",
  player,
  mission: SpyMission.OBJECTIVE,
  targetPlayerId,
});
const unrest = (player: string, targetProvinceId: string): SpyAction => ({
  type: "SPY",
  player,
  mission: SpyMission.UNREST,
  targetProvinceId,
});

describe("applySpy — cost (§10.7: 1 action + 3 gold)", () => {
  it("charges 3 gold on a successful mission", () => {
    const s = atRoll(fresh(), 6);
    const before = player(s, "p2").treasury.gold;
    const next = applySpy(s, omen("p2"));
    expect(player(next, "p2").treasury.gold).toBe(before - SPY.goldCost);
  });

  it("charges the 3 gold even when the agent is captured", () => {
    const s = atRoll(fresh(), 1); // 1 < base target 3 → failure
    const before = player(s, "p2").treasury.gold;
    const next = applySpy(s, omen("p2"));
    expect(player(next, "p2").treasury.gold).toBe(before - SPY.goldCost);
  });

  it("throws INSUFFICIENT_RESOURCES when the spy cannot afford 3 gold", () => {
    const base = fresh();
    const poor: GameState = {
      ...base,
      players: base.players.map((p) =>
        p.id === "p2"
          ? { ...p, treasury: { ...p.treasury, gold: SPY.goldCost - 1 } }
          : p,
      ),
    };
    expect(() => applySpy(atRoll(poor, 6), omen("p2"))).toThrow(EngineError);
  });
});

describe("applySpy — success threshold & modifiers (§10.7: 1d6 ≥ 3)", () => {
  it("base mission (no rival) succeeds on a 3 and fails on a 2", () => {
    expect(
      (applySpy(atRoll(fresh(), 3), omen("p2")).log.at(-1)?.data as {
        captured: boolean;
      }).captured,
    ).toBe(false);
    expect(
      (applySpy(atRoll(fresh(), 2), omen("p2")).log.at(-1)?.data as {
        captured: boolean;
      }).captured,
    ).toBe(true);
  });

  it("a rival University raises the target to 4 (§10.7: −1 → need ≥ 4)", () => {
    // p1 spies Ottoman p2, who owns a University: need ≥ 3 + universityPenalty.
    const s = grantUniversity(fresh(), "p2");
    const need = SPY.baseTarget + SPY.universityPenalty;
    const fail = applySpy(atRoll(s, need - 1), objective("p1", "p2"));
    const win = applySpy(atRoll(s, need), objective("p1", "p2"));
    expect((fail.log.at(-1)?.data as { captured: boolean }).captured).toBe(true);
    expect((win.log.at(-1)?.data as { captured: boolean }).captured).toBe(false);
    expect((win.log.at(-1)?.data as { targetNumber: number }).targetNumber).toBe(
      need,
    );
  });

  it("Byzantium as the target resists +1 (§10.7: need ≥ 4)", () => {
    // p2 spies Byzantine p1: need ≥ 3 + byzantiumResist.
    const need = SPY.baseTarget + SPY.byzantiumResist;
    const fail = applySpy(atRoll(fresh(), need - 1), objective("p2", "p1"));
    const win = applySpy(atRoll(fresh(), need), objective("p2", "p1"));
    expect((fail.log.at(-1)?.data as { captured: boolean }).captured).toBe(true);
    expect((win.log.at(-1)?.data as { captured: boolean }).captured).toBe(false);
  });

  it("Byzantium + University stack → need ≥ 5 (§10.7)", () => {
    const s = grantUniversity(fresh(), "p1"); // Byzantine p1 also owns a University
    const need = SPY.baseTarget + SPY.byzantiumResist + SPY.universityPenalty;
    expect(need).toBe(5);
    const fail = applySpy(atRoll(s, need - 1), objective("p2", "p1"));
    const win = applySpy(atRoll(s, need), objective("p2", "p1"));
    expect((fail.log.at(-1)?.data as { captured: boolean }).captured).toBe(true);
    expect((win.log.at(-1)?.data as { captured: boolean }).captured).toBe(false);
  });
});

describe("applySpy — mission effects (§10.7 (a)/(b)/(c))", () => {
  it("(a) OMEN peeks the top card of the current Omen deck (actor-scoped)", () => {
    const s = atRoll(fresh(), 6);
    const top = s.omenDeck[0];
    const next = applySpy(s, omen("p2"));
    const entry = next.log.at(-1)!;
    expect(entry.type).toBe("spy");
    expect(entry.actors).toEqual(["p2"]);
    expect((entry.data as { omenTopCardId: string }).omenTopCardId).toBe(top);
    expect((entry.data as { visibleTo: string[] }).visibleTo).toEqual(["p2"]);
    // Peeking does not consume the card.
    expect(next.omenDeck[0]).toBe(top);
  });

  it("(b) OBJECTIVE reveals one of the rival's secret objectives (actor-scoped)", () => {
    const s = atRoll(fresh(), 6); // p1 (no University/Byzantium on p1's target p2) needs 3
    const rivalObjectiveIds = player(s, "p2").objectives.map((o) => o.id);
    const next = applySpy(s, objective("p1", "p2"));
    const entry = next.log.at(-1)!;
    expect(entry.type).toBe("spy");
    expect(entry.targets).toEqual(["p2"]);
    expect(rivalObjectiveIds).toContain(
      (entry.data as { objectiveId: string }).objectiveId,
    );
    expect((entry.data as { visibleTo: string[] }).visibleTo).toEqual(["p1"]);
  });

  it("(c) UNREST posts a no_income modifier so the province yields 0 next Income", () => {
    const s = atRoll(fresh(), 6);
    const victim = ownedProvince(s, "p2"); // p1 incites unrest in an Ottoman province
    const baseline = computeIncome(s).perPlayer["p2"];
    const next = applySpy(s, unrest("p1", victim.id));

    // A no_income modifier is now posted against the province, lapsing next round.
    const mods = getModifiers(next, "no_income", { provinceId: victim.id });
    expect(mods).toHaveLength(1);
    expect(mods[0].expiresRound).toBe(next.round + 1);

    // The economy honours it: the owner's income strictly drops.
    const suppressed = computeIncome(next).perPlayer["p2"];
    const sum = (b: typeof baseline) =>
      b.gold + b.grain + b.timber + b.stone + b.faith;
    expect(sum(suppressed)).toBeLessThan(sum(baseline));

    const entry = next.log.at(-1)!;
    expect(entry.type).toBe("spy");
    expect(entry.targets).toContain(victim.id);
  });
});

describe("applySpy — capture penalties (§10.7)", () => {
  it("a captured agent costs the base −1 prestige on an info mission", () => {
    const s = atRoll(fresh(), 1);
    const before = player(s, "p2").prestige;
    const next = applySpy(s, omen("p2"));
    expect(player(next, "p2").prestige).toBe(before + SPY.captureFailPrestige);
    expect(SPY.captureFailPrestige).toBe(-1);
    expect(next.log.at(-1)?.type).toBe("spy");
  });

  it("a captured incite-unrest agent costs −2 prestige (§10.7)", () => {
    const s = atRoll(fresh(), 1);
    const victim = ownedProvince(s, "p2");
    const before = player(s, "p1").prestige;
    const next = applySpy(s, unrest("p1", victim.id));
    expect(player(next, "p1").prestige).toBe(before + SPY.inciteUnrestFailPrestige);
    expect(SPY.inciteUnrestFailPrestige).toBe(-2);
    // A failed incite posts no suppression modifier.
    expect(getModifiers(next, "no_income", { provinceId: victim.id })).toHaveLength(
      0,
    );
  });
});

describe("applySpy — validation & determinism", () => {
  it("rejects an OBJECTIVE mission with no target and self-targeting", () => {
    const s = atRoll(fresh(), 6);
    expect(() =>
      applySpy(s, { type: "SPY", player: "p2", mission: SpyMission.OBJECTIVE }),
    ).toThrow(EngineError);
    expect(() => applySpy(s, objective("p2", "p2"))).toThrow(EngineError);
  });

  it("rejects inciting unrest in an unowned or own province", () => {
    const s = atRoll(fresh(), 6);
    const own = ownedProvince(s, "p1");
    expect(() => applySpy(s, unrest("p1", own.id))).toThrow(EngineError);
    const neutral = s.provinces.find((p) => p.ownerId === null);
    if (neutral) {
      expect(() => applySpy(s, unrest("p1", neutral.id))).toThrow(EngineError);
    }
  });

  it("advances the RNG cursor by exactly one roll and writes it back", () => {
    const s = atRoll(fresh(), 6);
    const next = applySpy(s, omen("p2"));
    expect(next.rngCursor).toBe(s.rngCursor + 1);
  });
});
