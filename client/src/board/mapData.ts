import type { Faction, GameState } from "@imperium/shared";
import type { Adjacency, BoardMapData, BoardProvince, BoardSeaZone } from "./types";
import { CANON_ADJACENCY, CANON_PROVINCES, CANON_SEA_ZONES } from "./mapData.generated";

/**
 * Board dataset keyed by the canonical docs/MAP.md id scheme: 55 city-named
 * land provinces + 12 sea zones. All map data is derived from MAP.md by
 * tools/genMapData.ts into mapData.generated.ts — this module is a thin
 * adapter that keeps the board's stable API shape on top of it.
 *
 * NOTE: the vendored assets/board.svg still uses the retired hand-drawn
 * region id scheme; the id-diff reporter (idDiff.ts) surfaces that expected
 * drift until the rebuilt canon-id board art lands.
 */

// Richer canon records (region/port/walls/hv/startingOwner) for callers
// that need more than the BoardProvince shape (fixtures, dev panels).
export { CANON_ADJACENCY, CANON_PROVINCES, CANON_SEA_ZONES } from "./mapData.generated";
export type { CanonProvince, CanonSeaZone } from "./mapData.generated";

const SEA_ZONE_ID_SET: ReadonlySet<string> = new Set(CANON_SEA_ZONES.map((s) => s.id));

export const BOARD_ADJACENCY: Adjacency = CANON_ADJACENCY;

export function isSeaZoneId(id: string): boolean {
  return SEA_ZONE_ID_SET.has(id);
}

export function neighborsOf(id: string): readonly string[] {
  return BOARD_ADJACENCY[id] ?? [];
}

export const BOARD_PROVINCES: readonly BoardProvince[] = CANON_PROVINCES.map(
  ({ id, name, terrain, yields, coastal }) => ({ id, name, terrain, yields, coastal }),
);

export const BOARD_SEA_ZONES: readonly BoardSeaZone[] = CANON_SEA_ZONES.map(
  ({ id, name }) => ({ id, name }),
);

export const BOARD_MAP: BoardMapData = {
  provinces: BOARD_PROVINCES,
  seaZones: BOARD_SEA_ZONES,
  adjacency: BOARD_ADJACENCY,
};

/**
 * Legal one-step move targets from a location, mirroring the engine's
 * applyMove (server/src/engine/actions.ts): armies move province→province
 * (strait edges included), fleets move province↔sea and sea↔sea — a fleet in
 * port may put to sea past an army garrisoning the same province, and a fleet
 * at sea may put into any bordering harbor (every province touching a sea
 * zone is coastal by construction). Armies never enter sea zones (crossing
 * water is the March order's amphibious `transportFleetId` flag, not a sea
 * step). When both an army and a fleet stand at `fromId` the result is the
 * UNION of both target sets. Ownership never filters. Result preserves
 * adjacency order. Empty/unknown location → [].
 */
export function legalMoveTargets(state: GameState, fromId: string): string[] {
  const hasArmy = state.armies.some((army) => army.locationId === fromId);
  const hasFleet = state.fleets.some((fleet) => fleet.locationId === fromId);
  if (isSeaZoneId(fromId)) {
    // Only fleets stand at sea: adjacent zones (sail on) + harbors (put in).
    return hasFleet ? [...neighborsOf(fromId)] : [];
  }
  if (!hasArmy && !hasFleet) return [];
  return neighborsOf(fromId).filter((n) => (isSeaZoneId(n) ? hasFleet : hasArmy));
}

/** player id → faction, skipping players who have not picked a faction. */
export function factionByPlayer(state: GameState): Map<string, Faction> {
  const byPlayer = new Map<string, Faction>();
  for (const player of state.players) {
    if (player.faction !== null) byPlayer.set(player.id, player.faction);
  }
  return byPlayer;
}

/** province id → owning faction (null when unowned or owner unresolvable). */
export function provinceOwnerFaction(state: GameState): Map<string, Faction | null> {
  const byPlayer = factionByPlayer(state);
  const owners = new Map<string, Faction | null>();
  for (const province of state.provinces) {
    owners.set(
      province.id,
      province.ownerId !== null ? (byPlayer.get(province.ownerId) ?? null) : null,
    );
  }
  return owners;
}
