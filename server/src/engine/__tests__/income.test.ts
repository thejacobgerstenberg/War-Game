import { describe, it, expect } from "vitest";
import { Faction, UnitType } from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { computeIncome, UPKEEP_GRAIN_PER_UNIT } from "../income.js";

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

describe("computeIncome", () => {
  it("sums the yields of owned provinces (non-grain resources)", () => {
    const state = createInitialState("ROOM01", seats);
    const income = computeIncome(state, "p1");

    // Byzantium starts owning Constantinople + Thessalonica + Mystras.
    // gold: 6 + 3 + 2 = 11
    // timber: 0 + 1 + 0 = 1
    // stone: 1 + 0 + 2 = 3
    // faith: 3 + 2 + 2 = 7
    expect(income.gold).toBe(11);
    expect(income.timber).toBe(1);
    expect(income.stone).toBe(3);
    expect(income.faith).toBe(7);
  });

  it("subtracts army grain upkeep from grain yield", () => {
    const state = createInitialState("ROOM01", seats);
    // Byzantium grain yield: 2 + 2 + 1 = 5. Starting army = 2 INF + 1 LEVY = 3
    // units => 3 grain upkeep => net 2.
    const income = computeIncome(state, "p1");
    expect(income.grain).toBe(2);
  });

  it("charges more upkeep as armies grow", () => {
    const state = createInitialState("ROOM01", seats);
    const army = state.armies.find((a) => a.ownerId === "p1")!;
    const before = computeIncome(state, "p1").grain;

    army.units[UnitType.CAVALRY] += 4;
    const after = computeIncome(state, "p1").grain;

    expect(after).toBe(before - 4 * UPKEEP_GRAIN_PER_UNIT);
  });

  it("computes the Ottoman player's income independently", () => {
    const state = createInitialState("ROOM01", seats);
    const income = computeIncome(state, "p2");
    // Ottoman owns Adrianople + Gallipoli + Bursa.
    // gold: 3 + 3 + 4 = 10 ; grain: (4 + 1 + 2) - 3 upkeep = 4
    expect(income.gold).toBe(10);
    expect(income.grain).toBe(4);
  });

  it("yields nothing (and no upkeep) for a player owning no provinces", () => {
    const state = createInitialState("ROOM01", seats);
    const income = computeIncome(state, "ghost");
    expect(income).toEqual({
      gold: 0,
      grain: 0,
      timber: 0,
      stone: 0,
      faith: 0,
    });
  });
});
