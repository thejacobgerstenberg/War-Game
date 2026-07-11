import type { IdDiff } from "./types";

/**
 * Pure diff of the two id spaces: map data vs SVG shapes.
 * `missingInSvg` = data ids with no SVG shape; `extraInSvg` = SVG shapes
 * with no data. Both sorted ascending and deduped.
 */
export function diffIds(svgIds: Iterable<string>, dataIds: Iterable<string>): IdDiff {
  const svg = new Set(svgIds);
  const data = new Set(dataIds);
  const missingInSvg = [...data].filter((id) => !svg.has(id)).sort();
  const extraInSvg = [...svg].filter((id) => !data.has(id)).sort();
  return { missingInSvg, extraInSvg };
}

/**
 * Dev-only console report of id drift, in both directions. No-op when the
 * diff is empty or outside dev builds. Id drift is expected (the SVG id
 * scheme differs from other datasets) — it must never break rendering, so
 * this never throws.
 */
export function reportIdDiff(label: string, diff: IdDiff): void {
  if (diff.missingInSvg.length === 0 && diff.extraInSvg.length === 0) return;
  if (!import.meta.env.DEV) return;
  try {
    console.warn(
      `[board] id drift (${label}): ${diff.missingInSvg.length} data id(s) missing in SVG, ` +
        `${diff.extraInSvg.length} SVG shape(s) without data`,
    );
    console.table([
      ...diff.missingInSvg.map((id) => ({ id, problem: "missing in SVG" })),
      ...diff.extraInSvg.map((id) => ({ id, problem: "no data for SVG shape" })),
    ]);
  } catch {
    // Reporting is best-effort; a broken console must not take the board down.
  }
}
