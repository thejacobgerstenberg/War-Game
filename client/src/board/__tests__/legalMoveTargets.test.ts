import { describe, expect, it } from "vitest";
import type { GameState } from "@imperium/shared";
import { isSeaZoneId, legalMoveTargets, neighborsOf } from "../mapData";
import { createDemoState } from "../fixtures/demoState";

function demoGameState(): GameState {
  return createDemoState().gameState;
}

describe("legalMoveTargets — armies (province → province)", () => {
  it("returns only land neighbors for a province holding an army", () => {
    const state = demoGameState();
    // a-byz-1 sits in thrace, which also borders three sea zones.
    const targets = legalMoveTargets(state, "thrace");
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((id) => !isSeaZoneId(id))).toBe(true);
  });

  it("equals neighborsOf filtered to non-sea ids, preserving adjacency order", () => {
    const state = demoGameState();
    for (const from of ["thrace", "bithynia", "hungary"]) {
      expect(legalMoveTargets(state, from)).toEqual(
        neighborsOf(from).filter((n) => !isSeaZoneId(n)),
      );
    }
  });

  it("excludes sea zones even for a coastal province (no embarkation)", () => {
    const state = demoGameState();
    const seaNeighbors = neighborsOf("thrace").filter(isSeaZoneId);
    expect(seaNeighbors.length).toBeGreaterThan(0); // sanity: thrace is coastal
    const targets = legalMoveTargets(state, "thrace");
    for (const sea of seaNeighbors) expect(targets).not.toContain(sea);
  });

  it("does not filter targets by ownership", () => {
    const state = demoGameState();
    const targets = legalMoveTargets(state, "thrace");
    const ownerOf = (id: string): string | null =>
      state.provinces.find((p) => p.id === id)?.ownerId ?? null;
    // bulgaria is enemy-held (p-ottoman), macedonia is own (p-byzantium):
    // both must still be legal targets.
    expect(ownerOf("bulgaria")).toBe("p-ottoman");
    expect(ownerOf("macedonia")).toBe("p-byzantium");
    expect(targets).toContain("bulgaria");
    expect(targets).toContain("macedonia");
  });
});

describe("legalMoveTargets — fleets (sea → sea)", () => {
  it("returns only sea-zone neighbors for a sea zone holding a fleet", () => {
    const state = demoGameState();
    // f-ven-1 sits in adriatic-sea, which also borders five land provinces.
    const targets = legalMoveTargets(state, "adriatic-sea");
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every(isSeaZoneId)).toBe(true);
    expect(targets).toEqual(neighborsOf("adriatic-sea").filter(isSeaZoneId));
  });

  it("excludes adjacent land provinces (no disembarkation)", () => {
    const state = demoGameState();
    const landNeighbors = neighborsOf("ligurian-sea").filter((n) => !isSeaZoneId(n));
    expect(landNeighbors.length).toBeGreaterThan(0); // sanity: coast exists
    const targets = legalMoveTargets(state, "ligurian-sea"); // f-gen-1
    for (const land of landNeighbors) expect(targets).not.toContain(land);
  });
});

describe("legalMoveTargets — precedence and empty cases", () => {
  it("army rule wins when both an army and a fleet share a location", () => {
    const state = demoGameState();
    state.armies[0].locationId = "adriatic-sea"; // alongside f-ven-1
    expect(legalMoveTargets(state, "adriatic-sea")).toEqual(
      neighborsOf("adriatic-sea").filter((n) => !isSeaZoneId(n)),
    );
  });

  it("returns [] for a location with neither army nor fleet", () => {
    const state = demoGameState();
    // serbia is a real province with neighbors but no demo army.
    expect(neighborsOf("serbia").length).toBeGreaterThan(0);
    expect(legalMoveTargets(state, "serbia")).toEqual([]);
    expect(legalMoveTargets(state, "sea-of-azov")).toEqual([]);
  });

  it("returns [] for an unknown id", () => {
    const state = demoGameState();
    expect(legalMoveTargets(state, "atlantis")).toEqual([]);
    expect(legalMoveTargets(state, "")).toEqual([]);
  });

  it("returns [] when an army sits on an unknown id (no neighbors)", () => {
    const state = demoGameState();
    state.armies[0].locationId = "atlantis";
    expect(legalMoveTargets(state, "atlantis")).toEqual([]);
  });

  it("returns [] for everything when the state has no armies or fleets", () => {
    const state = demoGameState();
    state.armies = [];
    state.fleets = [];
    expect(legalMoveTargets(state, "thrace")).toEqual([]);
    expect(legalMoveTargets(state, "adriatic-sea")).toEqual([]);
  });
});
