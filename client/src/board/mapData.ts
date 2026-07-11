import { TerrainType } from "@imperium/shared";
import type { Faction, GameState, ResourceBundle } from "@imperium/shared";
import type { Adjacency, BoardMapData, BoardProvince, BoardSeaZone } from "./types";

/**
 * Board dataset keyed by the board.svg id scheme (geographic regions,
 * kebab-case) — NOT MAP.md canon ids and NOT the server sample ids.
 * Names/terrain/yields are plausible readings of docs/MAP.md onto the SVG
 * regions; the adjacency graph is a best reading of Mediterranean geography.
 */

/** [gold, grain, timber, stone, faith] */
type YieldTuple = readonly [number, number, number, number, number];

function bundle(yields: YieldTuple): ResourceBundle {
  const [gold, grain, timber, stone, faith] = yields;
  return { gold, grain, timber, stone, faith };
}

function titleCase(id: string): string {
  return id
    .split("-")
    .map((word) => (word === "of" ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

const { PLAINS, HILLS, MOUNTAINS, FOREST, COAST, CITY } = TerrainType;

// The 53 board.svg province ids (spec §1 order). CITY marks the five capital
// regions: thrace (Constantinople), venetia (Venice), liguria (Genoa),
// hungary (Buda), latium (Rome).
const PROVINCE_DEFS: ReadonlyArray<readonly [string, TerrainType, YieldTuple]> = [
  ["albania", MOUNTAINS, [1, 1, 1, 1, 1]],
  ["apulia", PLAINS, [2, 3, 1, 1, 1]],
  ["armenia", MOUNTAINS, [1, 1, 1, 2, 1]],
  ["attica", COAST, [2, 1, 0, 1, 2]],
  ["aydin", COAST, [2, 2, 0, 1, 1]],
  ["bithynia", HILLS, [2, 3, 1, 1, 1]],
  ["bosnia", MOUNTAINS, [2, 1, 2, 2, 1]],
  ["bulgaria", PLAINS, [2, 3, 1, 1, 1]],
  ["calabria", HILLS, [1, 2, 1, 1, 1]],
  ["cappadocia", MOUNTAINS, [1, 2, 0, 2, 1]],
  ["caria", HILLS, [1, 2, 1, 1, 1]],
  ["cilicia", PLAINS, [2, 3, 1, 1, 1]],
  ["corsica", COAST, [1, 1, 2, 1, 0]],
  ["crete", COAST, [2, 2, 1, 0, 1]],
  ["crimea", COAST, [3, 2, 0, 1, 1]],
  ["croatia", HILLS, [1, 2, 2, 1, 1]],
  ["cyprus", COAST, [2, 2, 1, 1, 2]],
  ["cyrenaica", PLAINS, [1, 2, 0, 0, 1]],
  ["dalmatia", COAST, [2, 1, 2, 2, 1]],
  ["dobruja", PLAINS, [1, 2, 0, 0, 1]],
  ["egypt", PLAINS, [4, 6, 0, 2, 2]],
  ["epirus", MOUNTAINS, [1, 1, 1, 1, 1]],
  ["euboea", COAST, [2, 1, 1, 0, 1]],
  ["galatia", PLAINS, [1, 2, 0, 1, 1]],
  ["hungary", CITY, [4, 3, 2, 1, 2]],
  ["karaman", MOUNTAINS, [1, 2, 1, 1, 1]],
  ["latium", CITY, [4, 1, 0, 2, 6]],
  ["liguria", CITY, [5, 1, 1, 1, 1]],
  ["lombardy", PLAINS, [3, 4, 1, 1, 1]],
  ["lycia", MOUNTAINS, [1, 1, 2, 1, 1]],
  ["lydia", PLAINS, [2, 3, 0, 1, 1]],
  ["macedonia", HILLS, [3, 2, 1, 1, 2]],
  ["moldavia", FOREST, [1, 3, 3, 0, 1]],
  ["morea", HILLS, [2, 2, 1, 1, 2]],
  ["pamphylia", PLAINS, [2, 2, 1, 0, 1]],
  ["paphlagonia", FOREST, [1, 1, 3, 1, 1]],
  ["phrygia", HILLS, [1, 2, 1, 1, 1]],
  ["pontus", MOUNTAINS, [1, 1, 2, 2, 1]],
  ["rhodes", COAST, [2, 1, 0, 1, 2]],
  ["sardinia", COAST, [1, 2, 1, 1, 0]],
  ["serbia", HILLS, [2, 2, 1, 2, 1]],
  ["sicily", COAST, [2, 4, 0, 1, 1]],
  ["slavonia", FOREST, [1, 2, 3, 0, 1]],
  ["thessaly", PLAINS, [1, 4, 0, 0, 1]],
  ["thrace", CITY, [6, 2, 0, 1, 3]],
  ["transylvania", MOUNTAINS, [3, 2, 3, 2, 1]],
  ["trebizond", HILLS, [3, 1, 1, 1, 2]],
  ["tripolitania", PLAINS, [1, 1, 0, 0, 1]],
  ["tunis", COAST, [3, 2, 0, 1, 1]],
  ["tuscany", HILLS, [3, 2, 1, 2, 2]],
  ["venetia", CITY, [6, 1, 1, 1, 2]],
  ["wallachia", PLAINS, [1, 4, 1, 0, 1]],
  ["zeta", MOUNTAINS, [1, 1, 1, 2, 1]],
];

const SEA_ZONE_IDS: readonly string[] = [
  "adriatic-sea",
  "aegean-sea",
  "black-sea",
  "cilician-sea",
  "ionian-sea",
  "levantine-sea",
  "libyan-sea",
  "ligurian-sea",
  "sea-of-azov",
  "sea-of-crete",
  "sea-of-marmara",
  "tyrrhenian-sea",
];

const SEA_ZONE_ID_SET: ReadonlySet<string> = new Set(SEA_ZONE_IDS);

// Undirected edges; the symmetric adjacency record is derived below.
// Straits count as land adjacency: thrace↔bithynia (Bosphorus),
// calabria↔sicily (Messina), attica↔euboea (Euripus).
const EDGES: ReadonlyArray<readonly [string, string]> = [
  // --- Italy ---
  ["liguria", "lombardy"],
  ["liguria", "tuscany"],
  ["lombardy", "venetia"],
  ["lombardy", "tuscany"],
  ["tuscany", "latium"],
  ["latium", "apulia"],
  ["latium", "calabria"],
  ["apulia", "calabria"],
  ["calabria", "sicily"],
  ["venetia", "croatia"],
  // --- Balkans & Carpathians ---
  ["croatia", "slavonia"],
  ["croatia", "bosnia"],
  ["croatia", "dalmatia"],
  ["croatia", "hungary"],
  ["slavonia", "hungary"],
  ["slavonia", "bosnia"],
  ["slavonia", "serbia"],
  ["hungary", "transylvania"],
  ["hungary", "serbia"],
  ["transylvania", "wallachia"],
  ["transylvania", "moldavia"],
  ["moldavia", "wallachia"],
  ["moldavia", "dobruja"],
  ["wallachia", "dobruja"],
  ["wallachia", "bulgaria"],
  ["wallachia", "serbia"],
  ["dobruja", "bulgaria"],
  ["bulgaria", "serbia"],
  ["bulgaria", "macedonia"],
  ["bulgaria", "thrace"],
  ["serbia", "bosnia"],
  ["serbia", "zeta"],
  ["serbia", "albania"],
  ["serbia", "macedonia"],
  ["bosnia", "dalmatia"],
  ["bosnia", "zeta"],
  ["dalmatia", "zeta"],
  ["zeta", "albania"],
  ["albania", "macedonia"],
  ["albania", "epirus"],
  ["macedonia", "thrace"],
  ["macedonia", "thessaly"],
  ["macedonia", "epirus"],
  ["epirus", "thessaly"],
  ["thessaly", "attica"],
  ["attica", "morea"],
  ["attica", "euboea"],
  // --- Anatolia ---
  ["thrace", "bithynia"],
  ["bithynia", "phrygia"],
  ["bithynia", "galatia"],
  ["bithynia", "paphlagonia"],
  ["bithynia", "lydia"],
  ["lydia", "phrygia"],
  ["lydia", "aydin"],
  ["lydia", "caria"],
  ["aydin", "caria"],
  ["aydin", "phrygia"],
  ["caria", "lycia"],
  ["lycia", "pamphylia"],
  ["pamphylia", "cilicia"],
  ["pamphylia", "karaman"],
  ["cilicia", "karaman"],
  ["cilicia", "cappadocia"],
  ["cilicia", "armenia"],
  ["karaman", "cappadocia"],
  ["karaman", "galatia"],
  ["karaman", "phrygia"],
  ["galatia", "phrygia"],
  ["galatia", "paphlagonia"],
  ["galatia", "cappadocia"],
  ["paphlagonia", "pontus"],
  ["pontus", "cappadocia"],
  ["pontus", "trebizond"],
  ["pontus", "armenia"],
  ["cappadocia", "armenia"],
  ["armenia", "trebizond"],
  // --- North Africa ---
  ["egypt", "cyrenaica"],
  ["cyrenaica", "tripolitania"],
  ["tripolitania", "tunis"],
  // --- Province ↔ sea zone (defines coastal) ---
  ["liguria", "ligurian-sea"],
  ["tuscany", "ligurian-sea"],
  ["corsica", "ligurian-sea"],
  ["tuscany", "tyrrhenian-sea"],
  ["latium", "tyrrhenian-sea"],
  ["calabria", "tyrrhenian-sea"],
  ["sicily", "tyrrhenian-sea"],
  ["sardinia", "tyrrhenian-sea"],
  ["corsica", "tyrrhenian-sea"],
  ["tunis", "tyrrhenian-sea"],
  ["venetia", "adriatic-sea"],
  ["apulia", "adriatic-sea"],
  ["dalmatia", "adriatic-sea"],
  ["zeta", "adriatic-sea"],
  ["albania", "adriatic-sea"],
  ["apulia", "ionian-sea"],
  ["calabria", "ionian-sea"],
  ["sicily", "ionian-sea"],
  ["epirus", "ionian-sea"],
  ["morea", "ionian-sea"],
  ["thrace", "aegean-sea"],
  ["macedonia", "aegean-sea"],
  ["thessaly", "aegean-sea"],
  ["attica", "aegean-sea"],
  ["euboea", "aegean-sea"],
  ["lydia", "aegean-sea"],
  ["aydin", "aegean-sea"],
  ["caria", "aegean-sea"],
  ["rhodes", "aegean-sea"],
  ["crete", "sea-of-crete"],
  ["morea", "sea-of-crete"],
  ["thrace", "sea-of-marmara"],
  ["bithynia", "sea-of-marmara"],
  ["thrace", "black-sea"],
  ["bithynia", "black-sea"],
  ["paphlagonia", "black-sea"],
  ["pontus", "black-sea"],
  ["trebizond", "black-sea"],
  ["bulgaria", "black-sea"],
  ["dobruja", "black-sea"],
  ["moldavia", "black-sea"],
  ["crimea", "black-sea"],
  ["crimea", "sea-of-azov"],
  ["lycia", "cilician-sea"],
  ["pamphylia", "cilician-sea"],
  ["cilicia", "cilician-sea"],
  ["cyprus", "cilician-sea"],
  ["rhodes", "cilician-sea"],
  ["cilicia", "levantine-sea"],
  ["cyprus", "levantine-sea"],
  ["egypt", "levantine-sea"],
  ["egypt", "libyan-sea"],
  ["cyrenaica", "libyan-sea"],
  ["tripolitania", "libyan-sea"],
  ["tunis", "libyan-sea"],
  ["crete", "libyan-sea"],
  // --- Sea zone ↔ sea zone ---
  ["ligurian-sea", "tyrrhenian-sea"],
  ["tyrrhenian-sea", "ionian-sea"],
  ["tyrrhenian-sea", "libyan-sea"],
  ["ionian-sea", "adriatic-sea"],
  ["ionian-sea", "libyan-sea"],
  ["ionian-sea", "sea-of-crete"],
  ["sea-of-crete", "aegean-sea"],
  ["sea-of-crete", "libyan-sea"],
  ["sea-of-crete", "cilician-sea"],
  ["aegean-sea", "sea-of-marmara"],
  ["sea-of-marmara", "black-sea"],
  ["black-sea", "sea-of-azov"],
  ["cilician-sea", "levantine-sea"],
  ["levantine-sea", "libyan-sea"],
];

function buildAdjacency(): Adjacency {
  const adjacency: Record<string, string[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const [id] of PROVINCE_DEFS) {
    adjacency[id] = [];
    seen[id] = new Set();
  }
  for (const id of SEA_ZONE_IDS) {
    adjacency[id] = [];
    seen[id] = new Set();
  }
  for (const [a, b] of EDGES) {
    // Guard the invariants (symmetric, no self-edges, no dupes, known ids)
    // even against an authoring slip in EDGES.
    if (a === b || !(a in adjacency) || !(b in adjacency)) continue;
    if (!seen[a].has(b)) {
      seen[a].add(b);
      adjacency[a].push(b);
    }
    if (!seen[b].has(a)) {
      seen[b].add(a);
      adjacency[b].push(a);
    }
  }
  return adjacency;
}

export const BOARD_ADJACENCY: Adjacency = buildAdjacency();

export function isSeaZoneId(id: string): boolean {
  return SEA_ZONE_ID_SET.has(id);
}

export function neighborsOf(id: string): readonly string[] {
  return BOARD_ADJACENCY[id] ?? [];
}

export const BOARD_PROVINCES: readonly BoardProvince[] = PROVINCE_DEFS.map(
  ([id, terrain, yields]) => ({
    id,
    name: titleCase(id),
    terrain,
    yields: bundle(yields),
    coastal: neighborsOf(id).some(isSeaZoneId),
  }),
);

export const BOARD_SEA_ZONES: readonly BoardSeaZone[] = SEA_ZONE_IDS.map((id) => ({
  id,
  name: titleCase(id),
}));

export const BOARD_MAP: BoardMapData = {
  provinces: BOARD_PROVINCES,
  seaZones: BOARD_SEA_ZONES,
  adjacency: BOARD_ADJACENCY,
};

/**
 * Legal one-step move targets from a location: armies move province→province,
 * fleets move sea→sea; no embarkation in this demo. Ownership never filters.
 * Result preserves adjacency order. Empty/unknown location → [].
 */
export function legalMoveTargets(state: GameState, fromId: string): string[] {
  if (state.armies.some((army) => army.locationId === fromId)) {
    return neighborsOf(fromId).filter((n) => !isSeaZoneId(n));
  }
  if (state.fleets.some((fleet) => fleet.locationId === fromId)) {
    return neighborsOf(fromId).filter((n) => isSeaZoneId(n));
  }
  return [];
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
