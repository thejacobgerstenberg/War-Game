/// <reference types="node" />
/**
 * Drift guard: mapData.generated.ts must be the exact output of running
 * tools/genMapData.ts against the current docs/MAP.md. If MAP.md changes
 * without regeneration (or the generated file is hand-edited), this fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generate, parseMapMd, validate } from "../tools/genMapData";
import { CANON_ADJACENCY, CANON_PROVINCES, CANON_SEA_ZONES } from "../mapData.generated";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP_MD_PATH = resolve(HERE, "../../../../docs/MAP.md");
const GENERATED_PATH = resolve(HERE, "../mapData.generated.ts");

const mapMd = readFileSync(MAP_MD_PATH, "utf8");

describe("mapData.generated.ts drift guard", () => {
  it("matches a fresh regeneration from docs/MAP.md byte for byte", () => {
    const committed = readFileSync(GENERATED_PATH, "utf8");
    expect(
      committed,
      "mapData.generated.ts is stale — run `npm run gen:map` in client/ " +
        "after changing docs/MAP.md",
    ).toBe(generate(mapMd));
  });

  it("parses exactly 55 provinces and 12 sea zones from MAP.md", () => {
    const parsed = parseMapMd(mapMd);
    expect(parsed.provinces).toHaveLength(55);
    expect(parsed.seaZones).toHaveLength(12);
    // validate() rechecks symmetry, cross-table consistency, port flags.
    expect(() => validate(parsed)).not.toThrow();
  });

  it("committed module carries 55 provinces and 12 sea zones", () => {
    expect(CANON_PROVINCES).toHaveLength(55);
    expect(CANON_SEA_ZONES).toHaveLength(12);
  });

  it("committed adjacency is symmetric over all 67 ids", () => {
    const ids = Object.keys(CANON_ADJACENCY);
    expect(ids).toHaveLength(67);
    for (const [a, neighbors] of Object.entries(CANON_ADJACENCY)) {
      for (const b of neighbors) {
        expect(CANON_ADJACENCY[b], `${a} -> ${b} has no reverse edge`).toContain(a);
      }
    }
  });

  it("skips the deliberate damascus placeholder row", () => {
    // MAP.md carries a struck-through `damascus` row marked "not used";
    // the parser must not count it as a 56th province.
    expect(mapMd).toContain("`damascus`");
    expect(CANON_PROVINCES.some((p) => p.id === "damascus")).toBe(false);
  });
});
