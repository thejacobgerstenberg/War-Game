import { describe, expect, it } from "vitest";
import { computeCentroids, pathBoundsCenter } from "../centroids";

describe("pathBoundsCenter", () => {
  it("returns the bounding-box center of an absolute M/L…Z path", () => {
    expect(pathBoundsCenter("M0,0 L10,0 L10,10 L0,10 Z")).toEqual({ x: 5, y: 5 });
  });

  it("returns null for an empty d string", () => {
    expect(pathBoundsCenter("")).toBeNull();
  });

  it("returns null when the string has no coordinate pairs", () => {
    expect(pathBoundsCenter("Z")).toBeNull();
  });

  it("handles decimal and negative coordinates", () => {
    expect(pathBoundsCenter("M-10,-2.5 L10,2.5")).toEqual({ x: 0, y: 0 });
    expect(pathBoundsCenter("M1.5,2.5 L2.5,3.5")).toEqual({ x: 2, y: 3 });
  });

  it("handles space-separated pairs as well as comma-separated", () => {
    expect(pathBoundsCenter("M0 0 L4 0 L4 4 Z")).toEqual({ x: 2, y: 2 });
  });

  it("bails to null on relative (lowercase) commands instead of mis-parsing", () => {
    expect(pathBoundsCenter("m10,10 l5,0 l0,5 z")).toBeNull();
    expect(pathBoundsCenter("M0,0 l10,10 Z")).toBeNull();
    // lowercase z alone is a closepath with no coordinates — still fine.
    expect(pathBoundsCenter("M0,0 L4,0 L4,4 z")).toEqual({ x: 2, y: 2 });
  });
});

describe("computeCentroids", () => {
  const parse = (markup: string): SVGSVGElement =>
    new DOMParser().parseFromString(markup, "image/svg+xml")
      .documentElement as unknown as SVGSVGElement;

  const TINY_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">' +
    '<g id="board-provinces"><path id="a" d="M0,0 L4,0 L4,4 Z"/></g>' +
    '<g id="board-seas"><path id="s" d="M10,10 L14,10 L14,14 Z"/></g>' +
    "</svg>";

  it("computes centers for province and sea paths via the d-string fallback", () => {
    // jsdom has no getBBox, so this exercises the pathBoundsCenter fallback.
    const centroids = computeCentroids(parse(TINY_SVG));
    expect(centroids.size).toBe(2);
    expect(centroids.get("a")).toEqual({ x: 2, y: 2 });
    expect(centroids.get("s")).toEqual({ x: 12, y: 12 });
  });

  it("skips paths with no resolvable center instead of throwing", () => {
    const centroids = computeCentroids(
      parse(
        '<svg xmlns="http://www.w3.org/2000/svg">' +
          '<g id="board-provinces"><path id="empty" d=""/><path id="ok" d="M0,0 L2,2"/>' +
          '<path id="no-d"/></g><g id="board-seas"></g></svg>',
      ),
    );
    expect(centroids.has("empty")).toBe(false);
    expect(centroids.has("no-d")).toBe(false);
    expect(centroids.get("ok")).toEqual({ x: 1, y: 1 });
  });

  it("ignores paths outside #board-provinces and #board-seas", () => {
    const centroids = computeCentroids(
      parse(
        '<svg xmlns="http://www.w3.org/2000/svg">' +
          '<g id="board-frame"><path id="decor" d="M0,0 L8,8"/></g>' +
          '<g id="board-provinces"><path id="a" d="M0,0 L4,4"/></g></svg>',
      ),
    );
    expect(centroids.has("decor")).toBe(false);
    expect(centroids.has("a")).toBe(true);
  });

  it("prefers getBBox when the environment provides it", () => {
    const svg = parse(TINY_SVG);
    const path = svg.querySelector<SVGPathElement>("#a");
    if (!path) throw new Error("fixture path missing");
    // Simulate a browser: getBBox reports layout bounds that differ from the
    // d-string bounds, and must win over the fallback.
    (path as unknown as { getBBox: () => DOMRect }).getBBox = () =>
      ({ x: 100, y: 100, width: 10, height: 10 }) as DOMRect;
    const centroids = computeCentroids(svg);
    expect(centroids.get("a")).toEqual({ x: 105, y: 105 });
    expect(centroids.get("s")).toEqual({ x: 12, y: 12 });
  });

  it("falls back to the d string when getBBox throws or is degenerate", () => {
    const svg = parse(TINY_SVG);
    const a = svg.querySelector<SVGPathElement>("#a");
    const s = svg.querySelector<SVGPathElement>("#s");
    if (!a || !s) throw new Error("fixture paths missing");
    (a as unknown as { getBBox: () => DOMRect }).getBBox = () => {
      throw new Error("not rendered");
    };
    (s as unknown as { getBBox: () => DOMRect }).getBBox = () =>
      ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
    const centroids = computeCentroids(svg);
    expect(centroids.get("a")).toEqual({ x: 2, y: 2 });
    expect(centroids.get("s")).toEqual({ x: 12, y: 12 });
  });
});
