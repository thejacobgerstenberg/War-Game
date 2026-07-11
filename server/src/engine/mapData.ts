/**
 * A small but representative slice of the strategic map: the Aegean / Marmara
 * theatre on the eve of 1453. This is a working sample for the engine; the full
 * canonical map lives in docs/MAP.md.
 *
 * PROVINCES and SEA_ZONES describe the board. ADJACENCY is the derived,
 * symmetric neighbour graph spanning both land provinces and sea zones.
 */
import {
  Faction,
  TerrainType,
  type Province,
  type SeaZone,
} from "@imperium/shared";

/** Map-authoring shape: a province plus who starts holding it. */
export interface MapProvince extends Omit<Province, "ownerId"> {
  startingFaction: Faction | null;
}

/**
 * Land provinces. Positions are centroids in a 0–100 square viewBox used by the
 * client map renderer (north-west origin).
 */
export const PROVINCES: MapProvince[] = [
  {
    id: "constantinople",
    name: "Constantinople",
    terrain: TerrainType.CITY,
    yields: { gold: 6, grain: 2, timber: 0, stone: 1, faith: 3 },
    coastal: true,
    position: { x: 55, y: 35 },
    startingFaction: Faction.BYZANTIUM,
  },
  {
    id: "thessalonica",
    name: "Thessalonica",
    terrain: TerrainType.COAST,
    yields: { gold: 3, grain: 2, timber: 1, stone: 0, faith: 2 },
    coastal: true,
    position: { x: 28, y: 42 },
    startingFaction: Faction.BYZANTIUM,
  },
  {
    id: "mystras",
    name: "Mystras",
    terrain: TerrainType.HILLS,
    yields: { gold: 2, grain: 1, timber: 0, stone: 2, faith: 2 },
    coastal: true,
    position: { x: 28, y: 78 },
    startingFaction: Faction.BYZANTIUM,
  },
  {
    id: "adrianople",
    name: "Adrianople",
    terrain: TerrainType.PLAINS,
    yields: { gold: 3, grain: 4, timber: 1, stone: 0, faith: 0 },
    coastal: false,
    position: { x: 42, y: 30 },
    startingFaction: Faction.OTTOMAN,
  },
  {
    id: "gallipoli",
    name: "Gallipoli",
    terrain: TerrainType.COAST,
    yields: { gold: 3, grain: 1, timber: 2, stone: 1, faith: 0 },
    coastal: true,
    position: { x: 48, y: 46 },
    startingFaction: Faction.OTTOMAN,
  },
  {
    id: "bursa",
    name: "Bursa",
    terrain: TerrainType.HILLS,
    yields: { gold: 4, grain: 2, timber: 1, stone: 1, faith: 1 },
    coastal: true,
    position: { x: 66, y: 47 },
    startingFaction: Faction.OTTOMAN,
  },
  {
    id: "smyrna",
    name: "Smyrna",
    terrain: TerrainType.COAST,
    yields: { gold: 4, grain: 2, timber: 1, stone: 0, faith: 0 },
    coastal: true,
    position: { x: 62, y: 63 },
    startingFaction: Faction.GENOA,
  },
  {
    id: "negroponte",
    name: "Negroponte",
    terrain: TerrainType.COAST,
    yields: { gold: 3, grain: 1, timber: 1, stone: 1, faith: 0 },
    coastal: true,
    position: { x: 40, y: 60 },
    startingFaction: Faction.VENICE,
  },
  {
    id: "athens",
    name: "Athens",
    terrain: TerrainType.COAST,
    yields: { gold: 2, grain: 2, timber: 0, stone: 2, faith: 1 },
    coastal: true,
    position: { x: 34, y: 68 },
    startingFaction: Faction.VENICE,
  },
  {
    id: "belgrade",
    name: "Belgrade",
    terrain: TerrainType.PLAINS,
    yields: { gold: 3, grain: 3, timber: 2, stone: 1, faith: 1 },
    coastal: false,
    position: { x: 15, y: 15 },
    startingFaction: Faction.HUNGARY,
  },
];

/** Navigable sea zones. */
export const SEA_ZONES: SeaZone[] = [
  { id: "sea_marmara", name: "Sea of Marmara", position: { x: 54, y: 44 } },
  { id: "sea_aegean", name: "Aegean Sea", position: { x: 45, y: 62 } },
  { id: "sea_black", name: "Black Sea", position: { x: 62, y: 22 } },
];

/**
 * Undirected edge list. Every pair is expanded into a symmetric adjacency map
 * below, so callers never have to worry about direction.
 */
const EDGES: ReadonlyArray<readonly [string, string]> = [
  // Land borders
  ["belgrade", "adrianople"],
  ["belgrade", "thessalonica"],
  ["adrianople", "thessalonica"],
  ["adrianople", "constantinople"],
  ["adrianople", "gallipoli"],
  ["thessalonica", "athens"],
  ["athens", "mystras"],
  ["athens", "negroponte"],
  ["bursa", "smyrna"],
  // Sea zone <-> coastal province
  ["sea_marmara", "constantinople"],
  ["sea_marmara", "gallipoli"],
  ["sea_marmara", "bursa"],
  ["sea_aegean", "thessalonica"],
  ["sea_aegean", "gallipoli"],
  ["sea_aegean", "negroponte"],
  ["sea_aegean", "athens"],
  ["sea_aegean", "mystras"],
  ["sea_aegean", "smyrna"],
  ["sea_black", "constantinople"],
  // Sea zone <-> sea zone (straits)
  ["sea_marmara", "sea_black"],
  ["sea_marmara", "sea_aegean"],
];

function buildAdjacency(): Record<string, string[]> {
  const adjacency: Record<string, string[]> = {};
  const allIds = [
    ...PROVINCES.map((p) => p.id),
    ...SEA_ZONES.map((s) => s.id),
  ];
  for (const id of allIds) adjacency[id] = [];

  const link = (a: string, b: string) => {
    if (!adjacency[a]) adjacency[a] = [];
    if (!adjacency[a].includes(b)) adjacency[a].push(b);
  };

  for (const [a, b] of EDGES) {
    link(a, b);
    link(b, a);
  }
  return adjacency;
}

/** Symmetric neighbour graph keyed by province/sea-zone id. */
export const ADJACENCY: Record<string, string[]> = buildAdjacency();
