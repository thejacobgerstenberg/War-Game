import { describe, expect, it } from "vitest";
import { TerrainType } from "@imperium/shared";
import {
  BOARD_ADJACENCY,
  BOARD_MAP,
  BOARD_PROVINCES,
  BOARD_SEA_ZONES,
  CANON_PROVINCES,
  isSeaZoneId,
  neighborsOf,
} from "../mapData";

// The canonical docs/MAP.md id contract — 55 land provinces (§3) and
// 12 sea zones (§7). The single source of truth for every board id.
const EXPECTED_PROVINCE_IDS = [
  // Thrace & Constantinople
  "constantinople", "selymbria", "pera", "edirne", "gallipoli",
  // Balkans
  "philippopolis", "sofia", "wallachia", "serbia", "bosnia", "albania",
  "croatia", "buda", "belgrade", "transylvania", "dalmatia", "ragusa",
  // Thrace approaches & Greece & Aegean
  "epirus", "thessaly", "thessalonica", "athens", "morea", "modon",
  "negroponte", "chios", "lesbos", "lemnos", "naxos", "crete", "corfu",
  "rhodes",
  // Italy & Western Mediterranean
  "venice", "milan", "genoa", "rome", "naples", "sicily", "tunis",
  // Anatolia
  "bithynia", "bursa", "nicaea", "ankara", "konya", "kastamonu", "smyrna",
  "antalya",
  // Black Sea
  "varna", "sinope", "trebizond", "kaffa",
  // Levant & Egypt
  "aleppo", "antioch", "cairo", "alexandria", "cyprus",
];

const EXPECTED_SEA_ZONE_IDS = [
  "bosphorus", "sea-of-marmara", "aegean", "sea-of-crete",
  "eastern-mediterranean", "ionian", "adriatic", "tyrrhenian",
  "sicilian-channel", "black-sea-west", "black-sea-east", "sea-of-azov",
];

const ALL_IDS = [...EXPECTED_PROVINCE_IDS, ...EXPECTED_SEA_ZONE_IDS];

describe("id space", () => {
  it("has exactly the 55 canonical MAP.md province ids", () => {
    expect(EXPECTED_PROVINCE_IDS).toHaveLength(55);
    expect(BOARD_PROVINCES.map((p) => p.id).sort()).toEqual(
      [...EXPECTED_PROVINCE_IDS].sort(),
    );
  });

  it("has exactly the 12 canonical MAP.md sea-zone ids", () => {
    expect(BOARD_SEA_ZONES.map((s) => s.id).sort()).toEqual(
      [...EXPECTED_SEA_ZONE_IDS].sort(),
    );
  });

  it("isSeaZoneId is true for all sea ids and false for all province ids", () => {
    for (const id of EXPECTED_SEA_ZONE_IDS) expect(isSeaZoneId(id)).toBe(true);
    for (const id of EXPECTED_PROVINCE_IDS) expect(isSeaZoneId(id)).toBe(false);
    expect(isSeaZoneId("black-sea")).toBe(false); // retired hand-drawn SVG id
    expect(isSeaZoneId("sea_marmara")).toBe(false); // server-sample id, not ours
  });

  it("BOARD_MAP bundles the same provinces, sea zones, and adjacency", () => {
    expect(BOARD_MAP.provinces).toBe(BOARD_PROVINCES);
    expect(BOARD_MAP.seaZones).toBe(BOARD_SEA_ZONES);
    expect(BOARD_MAP.adjacency).toBe(BOARD_ADJACENCY);
  });
});

describe("adjacency invariants", () => {
  it("keys are exactly the 67 ids", () => {
    expect(Object.keys(BOARD_ADJACENCY).sort()).toEqual([...ALL_IDS].sort());
  });

  it("every neighbor id is one of the 67 ids", () => {
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
    expect(neighborsOf("constantinople")).toEqual(BOARD_ADJACENCY["constantinople"]);
    expect(neighborsOf("atlantis")).toEqual([]);
    expect(neighborsOf("thrace")).toEqual([]); // retired SVG region id
  });

  it("every sea zone has at least one neighbor", () => {
    for (const id of EXPECTED_SEA_ZONE_IDS) {
      expect(neighborsOf(id).length, `${id} is isolated`).toBeGreaterThan(0);
    }
  });

  it("encodes the MAP.md §8 straits as land adjacency", () => {
    // Bosphorus: constantinople <-> bithynia; Messina: naples <-> sicily.
    expect(neighborsOf("constantinople")).toContain("bithynia");
    expect(neighborsOf("bithynia")).toContain("constantinople");
    expect(neighborsOf("naples")).toContain("sicily");
    expect(neighborsOf("sicily")).toContain("naples");
  });

  it("keeps the Danube river ports off every sea zone (MAP.md §3 note)", () => {
    expect(neighborsOf("buda").some(isSeaZoneId)).toBe(false);
    expect(neighborsOf("belgrade").some(isSeaZoneId)).toBe(false);
  });

  it("matches MAP.md §6 for Constantinople exactly", () => {
    expect(neighborsOf("constantinople")).toEqual([
      "selymbria", "pera", "bithynia", "bosphorus", "sea-of-marmara",
    ]);
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

  it("marks exactly the 15 MAP.md city-terrain provinces as CITY", () => {
    const cities = BOARD_PROVINCES.filter((p) => p.terrain === TerrainType.CITY)
      .map((p) => p.id)
      .sort();
    expect(cities).toEqual([
      "athens", "belgrade", "buda", "cairo", "constantinople", "genoa",
      "kaffa", "naples", "nicaea", "pera", "ragusa", "rome",
      "thessalonica", "trebizond", "venice",
    ]);
  });

  it("yields follow the primary=2 / secondary=1 quantification", () => {
    for (const p of BOARD_PROVINCES) {
      const values = Object.values(p.yields).sort((a, b) => b - a);
      expect(values[0], `${p.id} primary yield`).toBe(2);
      expect([0, 1], `${p.id} secondary yield`).toContain(values[1]);
      expect(values.slice(2).every((v) => v === 0), `${p.id} extra yields`).toBe(true);
    }
  });

  it("exposes MAP.md port and wall data on the canon records", () => {
    const byId = new Map(CANON_PROVINCES.map((p) => [p.id, p]));
    expect(byId.get("constantinople")).toMatchObject({
      port: "Y", walls: 5, hv: 5, startingOwner: "Byzantium",
    });
    expect(byId.get("buda")).toMatchObject({ port: "R", walls: 3 });
    // The five deliberate coastal non-ports (MAP.md §7 note).
    for (const id of ["wallachia", "thessaly", "morea", "bursa", "kastamonu"]) {
      expect(byId.get(id), id).toMatchObject({ port: "N", coastal: true });
    }
  });

  it("every province and sea zone has a non-empty display name", () => {
    for (const p of BOARD_PROVINCES) expect(p.name.length).toBeGreaterThan(0);
    for (const s of BOARD_SEA_ZONES) expect(s.name.length).toBeGreaterThan(0);
    // Naming convention spot checks.
    expect(BOARD_PROVINCES.find((p) => p.id === "constantinople")?.name).toBe(
      "Constantinople",
    );
    expect(BOARD_PROVINCES.find((p) => p.id === "edirne")?.name).toBe(
      "Edirne (Adrianople)",
    );
    expect(BOARD_SEA_ZONES.find((s) => s.id === "sea-of-marmara")?.name).toBe(
      "Sea of Marmara",
    );
  });
});
