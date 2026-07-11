import { describe, it, expect } from "vitest";
import { areAdjacent, neighborsOf } from "../adjacency.js";
import { ADJACENCY, PROVINCES, SEA_ZONES } from "../mapData.js";

describe("adjacency", () => {
  it("reports known neighbours of Constantinople", () => {
    const neighbours = neighborsOf("constantinople");
    expect(neighbours).toContain("adrianople");
    expect(neighbours).toContain("sea_marmara");
    expect(neighbours).toContain("sea_black");
  });

  it("is symmetric for every edge in the graph", () => {
    for (const [id, neighbours] of Object.entries(ADJACENCY)) {
      for (const other of neighbours) {
        expect(
          areAdjacent(other, id),
          `${id} -> ${other} but not ${other} -> ${id}`,
        ).toBe(true);
      }
    }
  });

  it("returns false for non-adjacent locations", () => {
    expect(areAdjacent("belgrade", "smyrna")).toBe(false);
    expect(areAdjacent("constantinople", "athens")).toBe(false);
  });

  it("returns an empty array for unknown ids", () => {
    expect(neighborsOf("atlantis")).toEqual([]);
    expect(areAdjacent("atlantis", "belgrade")).toBe(false);
  });

  it("never lists a location as adjacent to itself", () => {
    for (const id of Object.keys(ADJACENCY)) {
      expect(areAdjacent(id, id)).toBe(false);
    }
  });

  it("has an adjacency entry for every province and sea zone", () => {
    for (const p of PROVINCES) expect(ADJACENCY[p.id]).toBeDefined();
    for (const s of SEA_ZONES) expect(ADJACENCY[s.id]).toBeDefined();
  });

  it("connects every coastal province to at least one sea zone", () => {
    const seaIds = new Set(SEA_ZONES.map((s) => s.id));
    for (const p of PROVINCES) {
      if (!p.coastal) continue;
      const touchesSea = neighborsOf(p.id).some((n) => seaIds.has(n));
      expect(touchesSea, `${p.id} is coastal but touches no sea`).toBe(true);
    }
  });
});
