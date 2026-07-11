/**
 * A small but representative slice of the strategic map: the Aegean / Marmara
 * theatre on the eve of 1453. This is a working sample for the engine; the full
 * canonical map lives in docs/MAP.md — every province and sea-zone id below
 * exists verbatim in the MAP.md registry.
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
    yields: { gold: 6, grain: 2, timber: 0, marble: 1, faith: 3 },
    coastal: true,
    position: { x: 55, y: 35 },
    startingFaction: Faction.BYZANTIUM,
  },
  {
    id: "thessalonica",
    name: "Thessalonica",
    terrain: TerrainType.COAST,
    yields: { gold: 3, grain: 2, timber: 1, marble: 0, faith: 2 },
    coastal: true,
    position: { x: 28, y: 42 },
    startingFaction: Faction.BYZANTIUM,
  },
  {
    id: "morea",
    name: "Morea (Mistra)",
    terrain: TerrainType.HILLS,
    yields: { gold: 2, grain: 1, timber: 0, marble: 2, faith: 2 },
    coastal: true,
    position: { x: 28, y: 78 },
    startingFaction: Faction.BYZANTIUM,
  },
  {
    id: "edirne",
    name: "Edirne (Adrianople)",
    terrain: TerrainType.PLAINS,
    yields: { gold: 3, grain: 4, timber: 1, marble: 0, faith: 0 },
    coastal: false,
    position: { x: 42, y: 30 },
    startingFaction: Faction.OTTOMAN,
  },
  {
    id: "gallipoli",
    name: "Gallipoli",
    terrain: TerrainType.COAST,
    yields: { gold: 3, grain: 1, timber: 2, marble: 1, faith: 0 },
    coastal: true,
    position: { x: 48, y: 46 },
    startingFaction: Faction.OTTOMAN,
  },
  {
    id: "bursa",
    name: "Bursa",
    terrain: TerrainType.HILLS,
    yields: { gold: 4, grain: 2, timber: 1, marble: 1, faith: 1 },
    coastal: true,
    position: { x: 66, y: 47 },
    startingFaction: Faction.OTTOMAN,
  },
  {
    id: "smyrna",
    name: "Smyrna (İzmir)",
    terrain: TerrainType.COAST,
    yields: { gold: 4, grain: 2, timber: 1, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 62, y: 63 },
    startingFaction: Faction.GENOA,
  },
  {
    id: "negroponte",
    name: "Negroponte (Euboea)",
    terrain: TerrainType.COAST,
    yields: { gold: 3, grain: 1, timber: 1, marble: 1, faith: 0 },
    coastal: true,
    position: { x: 40, y: 60 },
    startingFaction: Faction.VENICE,
  },
  {
    id: "athens",
    name: "Athens",
    terrain: TerrainType.COAST,
    yields: { gold: 2, grain: 2, timber: 0, marble: 2, faith: 1 },
    coastal: true,
    position: { x: 34, y: 68 },
    startingFaction: Faction.VENICE,
  },
  {
    id: "belgrade",
    name: "Belgrade (Nándorfehérvár)",
    terrain: TerrainType.PLAINS,
    yields: { gold: 3, grain: 3, timber: 2, marble: 1, faith: 1 },
    coastal: false,
    position: { x: 15, y: 15 },
    startingFaction: Faction.HUNGARY,
  },
];

/** Navigable sea zones (ids per docs/MAP.md §7). */
export const SEA_ZONES: SeaZone[] = [
  {
    id: "sea-of-marmara",
    name: "Sea of Marmara",
    position: { x: 54, y: 44 },
  },
  { id: "aegean", name: "Aegean Sea", position: { x: 45, y: 62 } },
  { id: "bosphorus", name: "Bosphorus", position: { x: 58, y: 29 } },
  {
    id: "black-sea-west",
    name: "Black Sea (West)",
    position: { x: 66, y: 18 },
  },
];

/**
 * Undirected edge list. Every pair is expanded into a symmetric adjacency map
 * below, so callers never have to worry about direction.
 *
 * All sea edges mirror docs/MAP.md §7 exactly. Land edges marked "compressed
 * corridor" collapse a chain of MAP.md provinces that are not part of this
 * sample (e.g. selymbria, thessaly, sofia/serbia) into a single edge.
 */
const EDGES: ReadonlyArray<readonly [string, string]> = [
  // Land borders (canonical in MAP.md §6)
  ["edirne", "thessalonica"],
  ["edirne", "gallipoli"],
  ["athens", "morea"],
  ["bursa", "smyrna"],
  // Land borders (compressed corridors through provinces not in this sample)
  ["belgrade", "edirne"], // via serbia/sofia/philippopolis
  ["belgrade", "thessalonica"], // via serbia/sofia
  ["edirne", "constantinople"], // via selymbria
  ["thessalonica", "athens"], // via thessaly
  // Sea zone <-> coastal province (MAP.md §7)
  ["sea-of-marmara", "constantinople"],
  ["sea-of-marmara", "gallipoli"],
  ["sea-of-marmara", "bursa"],
  ["bosphorus", "constantinople"],
  ["aegean", "thessalonica"],
  ["aegean", "gallipoli"],
  ["aegean", "negroponte"],
  ["aegean", "athens"],
  ["aegean", "morea"],
  ["aegean", "smyrna"],
  // Sea zone <-> sea zone (straits, MAP.md §7–8)
  ["sea-of-marmara", "aegean"], // Dardanelles, gated by gallipoli
  ["bosphorus", "sea-of-marmara"],
  ["bosphorus", "black-sea-west"],
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
