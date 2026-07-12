/**
 * Adjacency queries over the strategic map graph.
 */
import { ADJACENCY, SEA_ZONES } from "./mapData.js";

/** All neighbours (provinces and sea zones) of a given location id. */
export function neighborsOf(id: string): string[] {
  return ADJACENCY[id] ? [...ADJACENCY[id]] : [];
}

/** True if two locations share an edge in the map graph. */
export function areAdjacent(a: string, b: string): boolean {
  const neighbours = ADJACENCY[a];
  return neighbours ? neighbours.includes(b) : false;
}

/** Canonical sea-zone id set (static board data). */
const SEA_ZONE_IDS: ReadonlySet<string> = new Set(SEA_ZONES.map((z) => z.id));

/**
 * True when a province has at least one province↔sea-zone ADJACENCY edge —
 * the "borders a sea" predicate (MINORS-FOLLOWUP-PREP). This is DISTINCT from
 * `Province.port` (MAP.md "Port?" = Y): morea/thessaly/wallachia/kastamonu
 * border seas without being ports. Use `bordersSea` for physical sea access
 * (amphibious eligibility, sea-resupply lanes, fleets putting in at a shore);
 * use `Province.port` for harbor infrastructure (port tiers §5.2, trade-route
 * endpoints, minPorts/morePortsThan objectives, maritime trade ratios).
 * Derived from the static canonical board, so it needs no GameState.
 */
export function bordersSea(provinceId: string): boolean {
  const neighbours = ADJACENCY[provinceId];
  return neighbours ? neighbours.some((n) => SEA_ZONE_IDS.has(n)) : false;
}
