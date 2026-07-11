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
    // a-byz-1 sits in constantinople, which also borders two sea zones.
    const targets = legalMoveTargets(state, "constantinople");
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((id) => !isSeaZoneId(id))).toBe(true);
  });

  it("crosses the Bosphorus strait: constantinople army can target bithynia", () => {
    const state = demoGameState();
    expect(legalMoveTargets(state, "constantinople")).toEqual([
      "selymbria", "pera", "bithynia",
    ]);
  });

  it("equals neighborsOf filtered to non-sea ids, preserving adjacency order", () => {
    const state = demoGameState();
    for (const from of ["constantinople", "bithynia", "buda"]) {
      expect(legalMoveTargets(state, from)).toEqual(
        neighborsOf(from).filter((n) => !isSeaZoneId(n)),
      );
    }
  });

  it("excludes sea zones for an army-only coastal province (armies never sail)", () => {
    const state = demoGameState();
    const seaNeighbors = neighborsOf("constantinople").filter(isSeaZoneId);
    expect(seaNeighbors.length).toBeGreaterThan(0); // sanity: it is coastal
    const targets = legalMoveTargets(state, "constantinople");
    for (const sea of seaNeighbors) expect(targets).not.toContain(sea);
  });

  it("does not filter targets by ownership", () => {
    const state = demoGameState();
    // a-ott-1 sits in bithynia (Ottoman); constantinople is enemy-held
    // (p-byzantium), bursa is own: both must still be legal targets.
    const targets = legalMoveTargets(state, "bithynia");
    const ownerOf = (id: string): string | null =>
      state.provinces.find((p) => p.id === id)?.ownerId ?? null;
    expect(ownerOf("constantinople")).toBe("p-byzantium");
    expect(ownerOf("bursa")).toBe("p-ottoman");
    expect(targets).toContain("constantinople");
    expect(targets).toContain("bursa");
  });
});

describe("legalMoveTargets — fleets (province ↔ sea ↔ sea)", () => {
  it("offers adjacent zones AND bordering harbors for a fleet at sea", () => {
    const state = demoGameState();
    // f-gen-1 sits in the bosphorus, which also touches three provinces:
    // the engine accepts both sea→sea and sea→province naval steps.
    const targets = legalMoveTargets(state, "bosphorus");
    expect(targets).toEqual(neighborsOf("bosphorus"));
    expect(targets.some(isSeaZoneId)).toBe(true);
    expect(targets.some((n) => !isSeaZoneId(n))).toBe(true);
  });

  it("includes adjacent coastal provinces (a fleet may put into harbor)", () => {
    const state = demoGameState();
    const landNeighbors = neighborsOf("adriatic").filter((n) => !isSeaZoneId(n));
    expect(landNeighbors.length).toBeGreaterThan(0); // sanity: coast exists
    const targets = legalMoveTargets(state, "adriatic"); // f-ven-1
    for (const land of landNeighbors) expect(targets).toContain(land);
    expect(targets).toContain("ionian");
  });

  it("offers only sea zones for a fleet alone in port (fleets never march)", () => {
    const state = demoGameState();
    state.fleets[0].locationId = "ragusa"; // f-ven-1 puts into an empty harbor
    expect(legalMoveTargets(state, "ragusa")).toEqual(
      neighborsOf("ragusa").filter(isSeaZoneId),
    );
  });
});

describe("legalMoveTargets — shared locations and empty cases", () => {
  it("unions land and sea targets when an army and a fleet share a port", () => {
    const state = demoGameState();
    state.fleets[0].locationId = "constantinople"; // f-ven-1 alongside a-byz-1
    // The army's land neighbors AND the fleet's sea neighbors, in adjacency
    // order — the fleet is no longer stranded by the garrison in its port.
    expect(legalMoveTargets(state, "constantinople")).toEqual(
      neighborsOf("constantinople"),
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
    expect(legalMoveTargets(state, "thrace")).toEqual([]); // retired SVG id
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
    expect(legalMoveTargets(state, "constantinople")).toEqual([]);
    expect(legalMoveTargets(state, "adriatic")).toEqual([]);
  });
});
