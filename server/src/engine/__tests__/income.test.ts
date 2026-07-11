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

    // Byzantium (canonical map) starts owning constantinople + selymbria +
    // thessalonica + morea + lemnos.
    // gold:   6 + 1 + 4 + 1 + 1 = 13
    // timber: 0 + 0 + 0 + 0 + 0 = 0
    // marble:  1 + 0 + 0 + 1 + 0 = 2
    // faith:  4 + 0 + 2 + 1 + 0 = 7
    expect(income.gold).toBe(13);
    expect(income.timber).toBe(0);
    expect(income.marble).toBe(2);
    expect(income.faith).toBe(7);
  });

  it("subtracts army grain upkeep from grain yield", () => {
    const state = createInitialState("ROOM01", seats);
    // Byzantium gross grain yield: 2 + 2 + 1 + 1 + 3 = 9. Starting armies total
    // 7 units => 7 grain upkeep => net 2.
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
    // Ottoman (canonical map) owns edirne + gallipoli + philippopolis + sofia +
    // bithynia + bursa + nicaea.
    // gold:  2 + 1 + 1 + 1 + 1 + 3 + 2 = 11
    // grain: (3 + 2 + 2 + 1 + 2 + 1 + 2) - 11 upkeep = 13 - 11 = 2
    expect(income.gold).toBe(11);
    expect(income.grain).toBe(2);
  });

  it("yields nothing (and no upkeep) for a player owning no provinces", () => {
    const state = createInitialState("ROOM01", seats);
    const income = computeIncome(state, "ghost");
    expect(income).toEqual({
      gold: 0,
      grain: 0,
      timber: 0,
      marble: 0,
      faith: 0,
    });
  });
});
