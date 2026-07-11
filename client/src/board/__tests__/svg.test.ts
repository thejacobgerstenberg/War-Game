import { describe, expect, it } from "vitest";
import { collectShapeIds, ensureFactionPatterns, loadBoardSvg } from "../svg";

const PATTERN_IDS = [
  "facPattern-byzantium",
  "facPattern-ottomans",
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
    const firstThrace = first.querySelector("#thrace");
    const secondThrace = second.querySelector("#thrace");
    expect(firstThrace).not.toBeNull();
    expect(secondThrace).not.toBeNull();
    expect(firstThrace).not.toBe(secondThrace);
    // Mutating one clone must not leak into the other.
    firstThrace?.setAttribute("class", "province owner-byzantium");
    expect(secondThrace?.getAttribute("class")).not.toContain("owner-byzantium");
  });
});

describe("collectShapeIds", () => {
  it("finds the 53 province and 12 sea-zone shape ids", () => {
    const { provinceIds, seaZoneIds } = collectShapeIds(loadBoardSvg());
    expect(provinceIds).toHaveLength(53);
    expect(seaZoneIds).toHaveLength(12);
    expect(provinceIds).toContain("thrace");
    expect(seaZoneIds).toContain("sea-of-marmara");
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
