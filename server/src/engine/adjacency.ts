/**
 * Adjacency queries over the strategic map graph.
 */
import { ADJACENCY } from "./mapData.js";

/** All neighbours (provinces and sea zones) of a given location id. */
export function neighborsOf(id: string): string[] {
  return ADJACENCY[id] ? [...ADJACENCY[id]] : [];
}

/** True if two locations share an edge in the map graph. */
export function areAdjacent(a: string, b: string): boolean {
  const neighbours = ADJACENCY[a];
  return neighbours ? neighbours.includes(b) : false;
}
