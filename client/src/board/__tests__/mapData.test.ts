import { describe, expect, it } from "vitest";
import { TerrainType } from "@imperium/shared";
import {
  BOARD_ADJACENCY,
  BOARD_MAP,
  BOARD_PROVINCES,
  BOARD_SEA_ZONES,
  isSeaZoneId,
  neighborsOf,
} from "../mapData";

// The board.svg id contract (board-spec §1) — the single source of truth.
const EXPECTED_PROVINCE_IDS = [
  "albania", "apulia", "armenia", "attica", "aydin", "bithynia", "bosnia",
  "bulgaria", "calabria", "cappadocia", "caria", "cilicia", "corsica",
  "crete", "crimea", "croatia", "cyprus", "cyrenaica", "dalmatia", "dobruja",
  "egypt", "epirus", "euboea", "galatia", "hungary", "karaman", "latium",
  "liguria", "lombardy", "lycia", "lydia", "macedonia", "moldavia", "morea",
  "pamphylia", "paphlagonia", "phrygia", "pontus", "rhodes", "sardinia",
  "serbia", "sicily", "slavonia", "thessaly", "thrace", "transylvania",
  "trebizond", "tripolitania", "tunis", "tuscany", "venetia", "wallachia",
  "zeta",
];

const EXPECTED_SEA_ZONE_IDS = [
  "adriatic-sea", "aegean-sea", "black-sea", "cilician-sea", "ionian-sea",
  "levantine-sea", "libyan-sea", "ligurian-sea", "sea-of-azov",
  "sea-of-crete", "sea-of-marmara", "tyrrhenian-sea",
];

const ALL_IDS = [...EXPECTED_PROVINCE_IDS, ...EXPECTED_SEA_ZONE_IDS];

describe("id space", () => {
  it("has exactly the 53 board.svg province ids", () => {
    expect(BOARD_PROVINCES.map((p) => p.id).sort()).toEqual(
      [...EXPECTED_PROVINCE_IDS].sort(),
    );
  });

  it("has exactly the 12 board.svg sea-zone ids", () => {
    expect(BOARD_SEA_ZONES.map((s) => s.id).sort()).toEqual(
      [...EXPECTED_SEA_ZONE_IDS].sort(),
    );
  });

  it("isSeaZoneId is true for all sea ids and false for all province ids", () => {
    for (const id of EXPECTED_SEA_ZONE_IDS) expect(isSeaZoneId(id)).toBe(true);
    for (const id of EXPECTED_PROVINCE_IDS) expect(isSeaZoneId(id)).toBe(false);
    expect(isSeaZoneId("sea_marmara")).toBe(false); // server-sample id, not ours
  });

  it("BOARD_MAP bundles the same provinces, sea zones, and adjacency", () => {
    expect(BOARD_MAP.provinces).toBe(BOARD_PROVINCES);
    expect(BOARD_MAP.seaZones).toBe(BOARD_SEA_ZONES);
    expect(BOARD_MAP.adjacency).toBe(BOARD_ADJACENCY);
  });
});

describe("adjacency invariants", () => {
  it("keys are exactly the 65 ids", () => {
    expect(Object.keys(BOARD_ADJACENCY).sort()).toEqual([...ALL_IDS].sort());
  });

  it("every neighbor id is one of the 65 ids", () => {
    const known = new Set(ALL_IDS);
    for (const [id, neighbors] of Object.entries(BOARD_ADJACENCY)) {
      for (const n of neighbors) {
        expect(known.has(n), `${id} -> unknown neighbor ${n}`).toBe(true);
      }
    }
  });

  it("is symmetric", () => {
    for (const [a, neighbors] of Object.entries(BOARD_ADJACENCY)) {
      for (const b of neighbors) {
        expect(BOARD_ADJACENCY[b], `${a} -> ${b} has no reverse edge`).toContain(a);
      }
    }
  });

  it("has no self-edges", () => {
    for (const [id, neighbors] of Object.entries(BOARD_ADJACENCY)) {
      expect(neighbors, `${id} lists itself`).not.toContain(id);
    }
  });

  it("has no duplicate neighbors", () => {
    for (const [id, neighbors] of Object.entries(BOARD_ADJACENCY)) {
      expect(new Set(neighbors).size, `${id} has duplicate neighbors`).toBe(
        neighbors.length,
      );
    }
  });

  it("neighborsOf returns the adjacency row, and [] for unknown ids", () => {
    expect(neighborsOf("thrace")).toEqual(BOARD_ADJACENCY["thrace"]);
    expect(neighborsOf("atlantis")).toEqual([]);
  });

  it("every sea zone has at least one neighbor", () => {
    for (const id of EXPECTED_SEA_ZONE_IDS) {
      expect(neighborsOf(id).length, `${id} is isolated`).toBeGreaterThan(0);
    }
  });
});

describe("province data invariants", () => {
  it("coastal is true iff the province has a sea-zone neighbor", () => {
    for (const p of BOARD_PROVINCES) {
      const hasSeaNeighbor = neighborsOf(p.id).some(isSeaZoneId);
      expect(p.coastal, `${p.id} coastal flag disagrees with adjacency`).toBe(
        hasSeaNeighbor,
      );
    }
  });

  it("marks exactly the five capital regions as CITY", () => {
    const cities = BOARD_PROVINCES.filter((p) => p.terrain === TerrainType.CITY)
      .map((p) => p.id)
      .sort();
    expect(cities).toEqual(["hungary", "latium", "liguria", "thrace", "venetia"]);
  });

  it("every CITY region yields gold >= 4", () => {
    for (const p of BOARD_PROVINCES) {
      if (p.terrain !== TerrainType.CITY) continue;
      expect(p.yields.gold, `${p.id} city gold too low`).toBeGreaterThanOrEqual(4);
    }
  });

  it("yields are small non-negative bundles (each field 0-6)", () => {
    for (const p of BOARD_PROVINCES) {
      for (const [field, value] of Object.entries(p.yields)) {
        expect(value, `${p.id}.${field}`).toBeGreaterThanOrEqual(0);
        expect(value, `${p.id}.${field}`).toBeLessThanOrEqual(6);
      }
    }
  });

  it("every province and sea zone has a non-empty display name", () => {
    for (const p of BOARD_PROVINCES) expect(p.name.length).toBeGreaterThan(0);
    for (const s of BOARD_SEA_ZONES) expect(s.name.length).toBeGreaterThan(0);
    // Title-casing convention spot checks.
    expect(BOARD_PROVINCES.find((p) => p.id === "thrace")?.name).toBe("Thrace");
    expect(BOARD_SEA_ZONES.find((s) => s.id === "sea-of-crete")?.name).toBe(
      "Sea of Crete",
    );
  });
});
