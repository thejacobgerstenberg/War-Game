import { describe, expect, it } from "vitest";
import { collectShapeIds, ensureFactionPatterns, loadBoardSvg } from "../svg";

const PATTERN_IDS = [
  "facPattern-byzantium",
  "facPattern-ottoman",
  "facPattern-venice",
  "facPattern-genoa",
  "facPattern-hungary",
];

describe("loadBoardSvg", () => {
  it("parses the vendored board.svg into an svg root", () => {
    const svg = loadBoardSvg();
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1600 1000");
    expect(svg.getAttribute("width")).toBe("100%");
    expect(svg.getAttribute("height")).toBe("100%");
  });

  it("returns a distinct deep clone per call (StrictMode-safe)", () => {
    const first = loadBoardSvg();
    const second = loadBoardSvg();
    expect(first).not.toBe(second);
    // Probe id derived from the SVG itself — exact id pins belong to the
    // drift spec, not here.
    const probeId = collectShapeIds(first).provinceIds[0];
    expect(probeId).toBeTruthy();
    const firstShape = first.querySelector(`#${probeId}`);
    const secondShape = second.querySelector(`#${probeId}`);
    expect(firstShape).not.toBeNull();
    expect(secondShape).not.toBeNull();
    expect(firstShape).not.toBe(secondShape);
    // Mutating one clone must not leak into the other.
    firstShape?.setAttribute("class", "province owner-byzantium");
    expect(secondShape?.getAttribute("class")).not.toContain("owner-byzantium");
  });
});

describe("collectShapeIds", () => {
  it("finds non-empty, non-overlapping province and sea-zone id sets", () => {
    const { provinceIds, seaZoneIds } = collectShapeIds(loadBoardSvg());
    expect(provinceIds.length).toBeGreaterThan(0);
    expect(seaZoneIds.length).toBeGreaterThan(0);
    // Every shape carries a non-empty id.
    expect(provinceIds.every((id) => id.length > 0)).toBe(true);
    expect(seaZoneIds.every((id) => id.length > 0)).toBe(true);
    // No overlap between the two id sets.
    const seas = new Set(seaZoneIds);
    expect(provinceIds.some((id) => seas.has(id))).toBe(false);
  });
});

describe("ensureFactionPatterns", () => {
  it("injects exactly the five facPattern-* patterns", () => {
    const svg = loadBoardSvg();
    ensureFactionPatterns(svg);
    for (const id of PATTERN_IDS) {
      const pattern = svg.querySelector(`#${id}`);
      expect(pattern, id).not.toBeNull();
      expect(pattern?.tagName.toLowerCase()).toBe("pattern");
    }
    expect(svg.querySelectorAll("pattern[id^='facPattern-']")).toHaveLength(5);
  });

  it("is idempotent — a second call adds nothing", () => {
    const svg = loadBoardSvg();
    ensureFactionPatterns(svg);
    ensureFactionPatterns(svg);
    expect(svg.querySelectorAll("pattern[id^='facPattern-']")).toHaveLength(5);
  });

  it("tiles carry the faction color so colorblind mode keeps color+texture", () => {
    const svg = loadBoardSvg();
    ensureFactionPatterns(svg);
    for (const id of PATTERN_IDS) {
      const slug = id.replace("facPattern-", "");
      const rect = svg.querySelector(`#${id} > rect`);
      expect(rect?.getAttribute("fill")).toBe(`var(--faction-${slug})`);
    }
  });
});
