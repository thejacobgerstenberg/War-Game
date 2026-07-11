/// <reference types="node" />
/**
 * Codegen: docs/MAP.md -> src/board/mapData.generated.ts
 *
 * docs/MAP.md is the single canonical map registry (55 land provinces +
 * 12 sea zones). This script parses its markdown tables — §3 Province
 * Registry, §6 Land Adjacency, §7 Sea Zones — validates the cross-table
 * invariants, and emits a typed TypeScript module. The board never
 * hand-maintains map data: edit MAP.md (scaffold-branch owners do),
 * then regenerate.
 *
 * Run from the client workspace:
 *   npm run gen:map
 * or directly:
 *   npx tsx src/board/tools/genMapData.ts
 *
 * The drift-guard test (__tests__/mapDataGenerated.test.ts) re-runs this
 * parser against docs/MAP.md and fails if the committed generated module
 * is stale.
 */

export const RESOURCE_KEYS = ["gold", "grain", "timber", "marble", "faith"] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

const TERRAIN_BY_WORD: Readonly<Record<string, string>> = {
  city: "CITY",
  plains: "PLAINS",
  hills: "HILLS",
  mountains: "MOUNTAINS",
  forest: "FOREST",
  coast: "COAST",
};

const OWNERS = ["Byzantium", "Ottomans", "Venice", "Genoa", "Hungary"] as const;

export interface ParsedProvince {
  id: string;
  name: string;
  region: string;
  /** TerrainType enum member name (e.g. "CITY"). */
  terrain: string;
  primary: ResourceKey;
  secondary: ResourceKey | null;
  port: "Y" | "N" | "R";
  /** Wall tier 1-5, or null for open/rural provinces. */
  walls: number | null;
  /** High-value node weight HV(n), or null. */
  hv: number | null;
  /** One of the five great powers, or null for Independent. */
  startingOwner: string | null;
  /** Land neighbors in MAP.md §6 order (straits included). */
  landNeighbors: string[];
  /** Bordering sea zones in MAP.md §6 order. */
  seaZones: string[];
}

export interface ParsedSeaZone {
  id: string;
  /** Adjacent sea zones in MAP.md §7 order. */
  connects: string[];
  /** Coastal provinces in MAP.md §7 order. */
  provincesTouched: string[];
}

export interface ParsedMap {
  provinces: ParsedProvince[];
  seaZones: ParsedSeaZone[];
}

/** Split a markdown table row into trimmed cell strings. */
function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** All backticked kebab-case ids in a cell, in order. */
function tickedIds(cell: string): string[] {
  return [...cell.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]);
}

function sectionOf(md: string, heading: string): string {
  const start = md.indexOf(heading);
  if (start === -1) throw new Error(`MAP.md section not found: ${heading}`);
  const rest = md.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

function parseResource(cell: string, where: string): ResourceKey {
  const m = cell.match(/\b(gold|grain|timber|marble|faith)\b/);
  if (!m) throw new Error(`unparseable resource cell "${cell}" (${where})`);
  return m[1] as ResourceKey;
}

export function parseMapMd(md: string): ParsedMap {
  // --- §3 Province Registry -------------------------------------------
  const registry = sectionOf(md, "## 3. Province Registry");
  const provinces: ParsedProvince[] = [];
  for (const line of registry.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const row = cells(line);
    if (row.length !== 10) continue; // regions table, walls table, separators
    // Registry data rows have a bare `id` first cell. The deliberate
    // `damascus` placeholder ("not used") does not match and is skipped.
    const idMatch = row[0].match(/^`([a-z-]+)`$/);
    if (!idMatch) continue;
    const [, name, region, terrainWord, primaryCell, secondaryCell, portCell, wallsCell, ownerCell, notes] =
      row;
    const terrain = TERRAIN_BY_WORD[terrainWord];
    if (!terrain) throw new Error(`unknown terrain "${terrainWord}" for ${idMatch[1]}`);
    const port = portCell as "Y" | "N" | "R";
    if (!["Y", "N", "R"].includes(port)) {
      throw new Error(`unknown port flag "${portCell}" for ${idMatch[1]}`);
    }
    const wallsMatch = wallsCell.match(/T([1-5])/);
    const owner = ownerCell.replace(/\*/g, "").trim();
    if (owner !== "Independent" && !OWNERS.includes(owner as (typeof OWNERS)[number])) {
      throw new Error(`unknown starting owner "${ownerCell}" for ${idMatch[1]}`);
    }
    const hvMatch = notes.match(/HV\((\d+)\)/);
    provinces.push({
      id: idMatch[1],
      name,
      region,
      terrain,
      primary: parseResource(primaryCell, `${idMatch[1]} primary`),
      secondary: secondaryCell === "—" ? null : parseResource(secondaryCell, `${idMatch[1]} secondary`),
      port,
      walls: wallsMatch ? Number(wallsMatch[1]) : null,
      hv: hvMatch ? Number(hvMatch[1]) : null,
      startingOwner: owner === "Independent" ? null : owner,
      landNeighbors: [],
      seaZones: [],
    });
  }

  // --- §7 Sea Zones (parsed before §6 so zone ids are known) ----------
  const seaSection = sectionOf(md, "## 7. Sea Zones");
  const seaRows: Array<{ id: string; connectsCell: string; touchedCell: string }> = [];
  for (const line of seaSection.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const row = cells(line);
    if (row.length !== 4) continue;
    const idMatch = row[0].match(/^`([a-z-]+)`$/);
    if (!idMatch) continue;
    seaRows.push({ id: idMatch[1], connectsCell: row[1], touchedCell: row[2] });
  }
  const zoneIds = new Set(seaRows.map((r) => r.id));
  const seaZones: ParsedSeaZone[] = seaRows.map((r) => ({
    id: r.id,
    // The Connects To cell may mention gating provinces in prose (e.g.
    // "via Dardanelles at `gallipoli`") — keep only real zone ids.
    connects: tickedIds(r.connectsCell).filter((id) => zoneIds.has(id)),
    provincesTouched: tickedIds(r.touchedCell),
  }));

  // --- §6 Land Adjacency ----------------------------------------------
  const adjSection = sectionOf(md, "## 6. Land Adjacency");
  const byId = new Map(provinces.map((p) => [p.id, p]));
  const adjacencyRows = new Set<string>();
  for (const line of adjSection.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const row = cells(line);
    if (row.length !== 3) continue;
    const idMatch = row[0].match(/^`([a-z-]+)`$/);
    if (!idMatch) continue;
    const province = byId.get(idMatch[1]);
    if (!province) throw new Error(`§6 row for unknown province \`${idMatch[1]}\``);
    // Neighbor cells list only province ids; sea cells only zone ids.
    // "— (island)" / "— (Danube river)" cells contain no backticks.
    province.landNeighbors = tickedIds(row[1]);
    province.seaZones = tickedIds(row[2]);
    adjacencyRows.add(province.id);
  }
  const missingAdjacency = provinces.filter((p) => !adjacencyRows.has(p.id));
  if (missingAdjacency.length > 0) {
    throw new Error(`§6 has no row for: ${missingAdjacency.map((p) => p.id).join(", ")}`);
  }

  return { provinces, seaZones };
}

/** Throws on any violated MAP.md invariant. */
export function validate(map: ParsedMap): void {
  const { provinces, seaZones } = map;
  const errors: string[] = [];

  if (provinces.length !== 55) errors.push(`expected 55 provinces, parsed ${provinces.length}`);
  if (seaZones.length !== 12) errors.push(`expected 12 sea zones, parsed ${seaZones.length}`);

  const provinceIds = new Set(provinces.map((p) => p.id));
  const zoneIds = new Set(seaZones.map((s) => s.id));
  if (provinceIds.size !== provinces.length) errors.push("duplicate province ids");
  if (zoneIds.size !== seaZones.length) errors.push("duplicate sea-zone ids");
  for (const id of provinceIds) {
    if (zoneIds.has(id)) errors.push(`id used as both province and sea zone: ${id}`);
  }

  const byId = new Map(provinces.map((p) => [p.id, p]));
  for (const p of provinces) {
    for (const n of p.landNeighbors) {
      const other = byId.get(n);
      if (!other) errors.push(`${p.id} -> unknown land neighbor ${n}`);
      else if (!other.landNeighbors.includes(p.id)) {
        errors.push(`asymmetric land edge: ${p.id} -> ${n} has no reverse`);
      }
    }
    if (p.landNeighbors.includes(p.id)) errors.push(`${p.id} lists itself as a neighbor`);
    for (const z of p.seaZones) {
      if (!zoneIds.has(z)) errors.push(`${p.id} -> unknown sea zone ${z}`);
    }
    if (p.port === "Y" && p.seaZones.length === 0) {
      errors.push(`${p.id} is Port=Y but touches no sea zone`);
    }
    if (p.port === "R" && p.seaZones.length !== 0) {
      errors.push(`${p.id} is a river port (R) but touches a sea zone`);
    }
  }

  const zoneById = new Map(seaZones.map((s) => [s.id, s]));
  for (const s of seaZones) {
    for (const c of s.connects) {
      const other = zoneById.get(c);
      if (!other) errors.push(`${s.id} -> unknown zone ${c}`);
      else if (!other.connects.includes(s.id)) {
        errors.push(`asymmetric zone edge: ${s.id} -> ${c} has no reverse`);
      }
    }
    // §7 "Provinces Touched" must agree exactly with §6 "Sea Zones".
    for (const pid of s.provincesTouched) {
      const p = byId.get(pid);
      if (!p) errors.push(`${s.id} touches unknown province ${pid}`);
      else if (!p.seaZones.includes(s.id)) {
        errors.push(`§7 says ${s.id} touches ${pid}, but §6 disagrees`);
      }
    }
  }
  for (const p of provinces) {
    for (const z of p.seaZones) {
      const zone = zoneById.get(z);
      if (zone && !zone.provincesTouched.includes(p.id)) {
        errors.push(`§6 says ${p.id} borders ${z}, but §7 disagrees`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`MAP.md validation failed:\n  ${errors.join("\n  ")}`);
  }
}

function titleCaseId(id: string): string {
  return id
    .split("-")
    .map((w) => (w === "of" ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function yieldsLiteral(p: ParsedProvince): string {
  // Deterministic yield quantification of the registry's Primary/Secondary
  // columns: primary = 2, secondary = 1, everything else 0.
  const amounts = RESOURCE_KEYS.map((key) => {
    if (key === p.primary) return `${key}: 2`;
    if (key === p.secondary) return `${key}: 1`;
    return `${key}: 0`;
  });
  return `{ ${amounts.join(", ")} }`;
}

const q = JSON.stringify;

export function renderModule(map: ParsedMap): string {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * GENERATED FILE — DO NOT EDIT BY HAND.");
  lines.push(" *");
  lines.push(" * Generated from docs/MAP.md (the canonical map registry) by");
  lines.push(" * src/board/tools/genMapData.ts. Regenerate after any MAP.md change:");
  lines.push(" *   npm run gen:map        (client workspace)");
  lines.push(" *   npx tsx src/board/tools/genMapData.ts");
  lines.push(" *");
  lines.push(" * Yield quantification: primary yield = 2, secondary = 1 (see the");
  lines.push(" * generator). The drift-guard test fails when this file is stale.");
  lines.push(" */");
  lines.push('import { TerrainType } from "@imperium/shared";');
  lines.push('import type { ResourceBundle } from "@imperium/shared";');
  lines.push("");
  lines.push("/** A land province exactly as docs/MAP.md §3 + §6 define it. */");
  lines.push("export interface CanonProvince {");
  lines.push("  id: string;");
  lines.push("  name: string;");
  lines.push("  region: string;");
  lines.push("  terrain: TerrainType;");
  lines.push("  yields: ResourceBundle;");
  lines.push('  /** "Y" port, "N" no harbor, "R" Danube river port (no sea zone). */');
  lines.push('  port: "Y" | "N" | "R";');
  lines.push("  /** Wall tier 1-5, or null for open/rural provinces. */");
  lines.push("  walls: number | null;");
  lines.push("  /** High-value node weight HV(n), or null. */");
  lines.push("  hv: number | null;");
  lines.push("  /** One of the five great powers, or null for Independent. */");
  lines.push("  startingOwner: string | null;");
  lines.push("  /** True iff the province borders at least one sea zone. */");
  lines.push("  coastal: boolean;");
  lines.push("}");
  lines.push("");
  lines.push("export interface CanonSeaZone {");
  lines.push("  id: string;");
  lines.push("  name: string;");
  lines.push("}");
  lines.push("");
  lines.push(`/** The ${map.provinces.length} land provinces, in MAP.md §3 registry order. */`);
  lines.push("export const CANON_PROVINCES: readonly CanonProvince[] = [");
  for (const p of map.provinces) {
    const fields = [
      `id: ${q(p.id)}`,
      `name: ${q(p.name)}`,
      `region: ${q(p.region)}`,
      `terrain: TerrainType.${p.terrain}`,
      `yields: ${yieldsLiteral(p)}`,
      `port: ${q(p.port)}`,
      `walls: ${p.walls ?? "null"}`,
      `hv: ${p.hv ?? "null"}`,
      `startingOwner: ${p.startingOwner === null ? "null" : q(p.startingOwner)}`,
      `coastal: ${p.seaZones.length > 0}`,
    ];
    lines.push(`  { ${fields.join(", ")} },`);
  }
  lines.push("];");
  lines.push("");
  lines.push(`/** The ${map.seaZones.length} sea zones, in MAP.md §7 order. */`);
  lines.push("export const CANON_SEA_ZONES: readonly CanonSeaZone[] = [");
  for (const s of map.seaZones) {
    lines.push(`  { id: ${q(s.id)}, name: ${q(titleCaseId(s.id))} },`);
  }
  lines.push("];");
  lines.push("");
  lines.push("/**");
  lines.push(" * Symmetric adjacency over all 67 ids. Province rows list land");
  lines.push(" * neighbors (straits included) then bordering sea zones; sea rows");
  lines.push(" * list connected zones then coastal provinces. MAP.md §6/§7 order.");
  lines.push(" */");
  lines.push("export const CANON_ADJACENCY: Readonly<Record<string, readonly string[]>> = {");
  for (const p of map.provinces) {
    const neighbors = [...p.landNeighbors, ...p.seaZones];
    lines.push(`  ${q(p.id)}: [${neighbors.map((n) => q(n)).join(", ")}],`);
  }
  for (const s of map.seaZones) {
    const neighbors = [...s.connects, ...s.provincesTouched];
    lines.push(`  ${q(s.id)}: [${neighbors.map((n) => q(n)).join(", ")}],`);
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

/** Parse + validate + render in one step (used by the drift-guard test). */
export function generate(md: string): string {
  const map = parseMapMd(md);
  validate(map);
  return renderModule(map);
}

// ---------------------------------------------------------------------------
// CLI entry point: regenerate src/board/mapData.generated.ts in place.
// Guarded so importing this module from the drift-guard test runs nothing.
// (This module is Node-only — the tsx CLI and vitest — never browser code.)
const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;

if (isCli) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mapMdPath = path.resolve(here, "../../../../docs/MAP.md");
  const outPath = path.resolve(here, "../mapData.generated.ts");
  const md = readFileSync(mapMdPath, "utf8");
  const output = generate(md);
  writeFileSync(outPath, output);
  const parsed = parseMapMd(md);
  console.log(
    `mapData.generated.ts written: ${parsed.provinces.length} provinces, ` +
      `${parsed.seaZones.length} sea zones (from ${mapMdPath})`,
  );
}
