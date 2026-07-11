import type { Point } from "./types";

/** Lowercase (relative) path commands the pair-scan below cannot evaluate. */
const RELATIVE_COMMAND_RE = /[mlhvcsqta]/;

/**
 * Pure fallback for environments without SVG layout (jsdom in unit tests,
 * detached SVG roots): scan every absolute coordinate pair in a path's `d`
 * and return the center of their bounding box. board.svg paths are plain
 * absolute `M/L … Z` pair sequences, so this matches getBBox closely.
 *
 * Relative commands (lowercase m/l/…) encode deltas, not coordinates —
 * treating their pairs as absolute would silently mis-place the center, so
 * such paths bail to null instead (documented fallback: the element simply
 * gets no centroid and overlay tokens skip it).
 * Returns null when no coordinate pair is found.
 */
export function pathBoundsCenter(d: string): Point | null {
  if (RELATIVE_COMMAND_RE.test(d)) return null;
  const pairRe = /(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const match of d.matchAll(pairRe)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    found = true;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!found) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function bboxCenter(el: SVGGraphicsElement): Point | null {
  // jsdom does not implement getBBox at all; browsers can throw on
  // not-rendered elements. Either way we fall back to pathBoundsCenter.
  if (typeof el.getBBox !== "function") return null;
  try {
    const box = el.getBBox();
    if (box.width === 0 && box.height === 0) return null;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  } catch {
    return null;
  }
}

/**
 * Centroids (bounding-box centers) for every province and sea-zone path,
 * keyed by SVG id, in board.svg user space (0–1600 × 0–1000). Elements with
 * no resolvable center are skipped — never throws.
 */
export function computeCentroids(svgRoot: SVGSVGElement): Map<string, Point> {
  const centroids = new Map<string, Point>();
  const paths = svgRoot.querySelectorAll<SVGPathElement>(
    "#board-provinces path[id], #board-seas path[id]",
  );
  for (const el of Array.from(paths)) {
    const center = bboxCenter(el) ?? pathBoundsCenter(el.getAttribute("d") ?? "");
    if (center) centroids.set(el.id, center);
  }
  return centroids;
}
