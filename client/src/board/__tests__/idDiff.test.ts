import { afterEach, describe, expect, it, vi } from "vitest";
import { diffIds, reportIdDiff } from "../idDiff";

describe("diffIds", () => {
  it("returns empty diffs for identical id sets", () => {
    expect(diffIds(["a", "b", "c"], ["a", "b", "c"])).toEqual({
      missingInSvg: [],
      extraInSvg: [],
    });
  });

  it("reports data ids absent from the SVG (missingInSvg)", () => {
    const diff = diffIds(["a", "b"], ["a", "b", "constantinople"]);
    expect(diff.missingInSvg).toEqual(["constantinople"]);
    expect(diff.extraInSvg).toEqual([]);
  });

  it("reports SVG shapes with no data (extraInSvg)", () => {
    const diff = diffIds(["a", "b", "zeta"], ["a"]);
    expect(diff.missingInSvg).toEqual([]);
    expect(diff.extraInSvg).toEqual(["b", "zeta"]);
  });

  it("reports drift in both directions at once for disjoint sets", () => {
    const diff = diffIds(["thrace", "morea"], ["sea_marmara", "mystras"]);
    expect(diff.missingInSvg).toEqual(["mystras", "sea_marmara"]);
    expect(diff.extraInSvg).toEqual(["morea", "thrace"]);
  });

  it("dedupes duplicated ids on both sides", () => {
    const diff = diffIds(["a", "a", "b", "b"], ["c", "c", "a"]);
    expect(diff.missingInSvg).toEqual(["c"]);
    expect(diff.extraInSvg).toEqual(["b"]);
  });

  it("sorts both result arrays ascending regardless of input order", () => {
    const diff = diffIds(["z", "m", "a"], ["y", "b", "x"]);
    expect(diff.missingInSvg).toEqual(["b", "x", "y"]);
    expect(diff.extraInSvg).toEqual(["a", "m", "z"]);
  });

  it("accepts arbitrary iterables (Sets), not just arrays", () => {
    const diff = diffIds(new Set(["a", "b"]), new Set(["b", "c"]));
    expect(diff.missingInSvg).toEqual(["c"]);
    expect(diff.extraInSvg).toEqual(["a"]);
  });
});

describe("reportIdDiff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is silent (and does not throw) for an empty diff", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const table = vi.spyOn(console, "table").mockImplementation(() => {});
    expect(() =>
      reportIdDiff("provinces", { missingInSvg: [], extraInSvg: [] }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(table).not.toHaveBeenCalled();
  });

  it("does not throw on a non-empty diff (both directions)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
    expect(() =>
      reportIdDiff("sea zones", {
        missingInSvg: ["sea_marmara"],
        extraInSvg: ["libyan-sea", "ligurian-sea"],
      }),
    ).not.toThrow();
  });

  it("never throws even when the console itself throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("broken console");
    });
    vi.spyOn(console, "table").mockImplementation(() => {
      throw new Error("broken console");
    });
    expect(() =>
      reportIdDiff("provinces", { missingInSvg: ["x"], extraInSvg: [] }),
    ).not.toThrow();
  });
});
