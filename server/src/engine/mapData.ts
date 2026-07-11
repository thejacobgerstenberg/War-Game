/**
 * mapData.ts — the CANONICAL strategic board of IMPERIUM: Twilight of Empires.
 *
 * This is the authoritative in-engine encoding of docs/MAP.md: 55 land
 * provinces across 8 regions, 12 named sea zones, and the 6 NPC minor states.
 * Every province id is kebab-case and matches MAP.md exactly (the `damascus`
 * "not used" row is intentionally omitted). Numbers that come from the balance
 * table (wall HP tiers) are read from balance.ts, never hardcoded.
 *
 * PROVINCES and SEA_ZONES describe the board. ADJACENCY is the derived,
 * symmetric neighbour graph spanning both land provinces and sea zones,
 * expanded from the undirected EDGES list (MAP.md §6–§8).
 *
 * Yields are derived from balance.TERRAIN_YIELDS for each province's terrain,
 * plus small hand-authored bonuses for named high-value trade/faith cities
 * (constantinople, venice, genoa, rome, thessalonica, ...). Faith is a yield
 * but non-tradeable per docs. Bonuses are noted inline where they apply.
 */
import {
  Faction,
  TerrainType,
  type NpcMinor,
  type Province,
  type SeaZone,
  type WallState,
} from "@imperium/shared";
import { MAP_WALL_TIER, WALL_TIERS } from "./balance.js";

/**
 * Map-authoring shape: a province plus who starts holding it. `ownerId`,
 * `buildings` and `greatWorks` are runtime state filled by
 * {@link createInitialState}; everything else (including `walls`, `garrison`,
 * `highValue`, `isCapitalOf`, `minorId`) is authored here on the canonical map.
 */
export interface MapProvince
  extends Omit<Province, "ownerId" | "buildings" | "greatWorks"> {
  startingFaction: Faction | null;
}

/**
 * Translate a MAP.md siege tier (T0..T5) into the runtime HP wall model.
 * MAP_WALL_TIER maps T1–T5 → HP-model tier {1,2,3}; WALL_TIERS supplies the HP
 * (0/6/10/16) and defence bonus (+0/+2/+3/+4). Constantinople's Theodosian T5
 * resolves to HP-tier 3 (16 HP / +4) — the tier the Great Bombard targets.
 */
function wall(mapTier: number): WallState {
  const hpTier = MAP_WALL_TIER[mapTier] ?? 0;
  return { tier: hpTier, hp: WALL_TIERS[hpTier].hp };
}

/**
 * The 55 land provinces (MAP.md §3). Positions are centroids in a 0–100 square
 * viewBox for the client renderer: x grows west→east, y grows north→south, so
 * Italy sits at low x, the Levant/Pontus at high x, Hungary/Black Sea at low y,
 * Egypt/Maghreb at high y.
 */
export const PROVINCES: MapProvince[] = [
  // --- Thrace / Marmara / Bosphorus -------------------------------------
  {
    id: "constantinople",
    name: "Constantinople",
    terrain: TerrainType.CITY,
    // city base (gold3/faith1) + capital HV(5) bonus: +3 gold, +2 grain, +1 marble, +3 faith
    yields: { gold: 6, grain: 2, timber: 0, marble: 1, faith: 4 },
    coastal: true,
    position: { x: 52, y: 34 },
    startingFaction: Faction.BYZANTIUM,
    walls: wall(5),
    isCapitalOf: Faction.BYZANTIUM,
    highValue: 5,
  },
  {
    id: "selymbria",
    name: "Selymbria",
    terrain: TerrainType.COAST,
    yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 48, y: 33 },
    startingFaction: Faction.BYZANTIUM,
    walls: wall(0),
  },
  {
    id: "pera",
    name: "Pera (Galata)",
    terrain: TerrainType.CITY,
    // Genoese trade enclave: primary gold only (no faith node); +1 gold, faith dropped
    yields: { gold: 4, grain: 0, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 52, y: 31 },
    startingFaction: Faction.GENOA,
    walls: wall(1),
  },
  {
    id: "edirne",
    name: "Edirne (Adrianople)",
    terrain: TerrainType.PLAINS,
    // Ottoman European capital: +1 gold, +1 grain
    yields: { gold: 2, grain: 3, timber: 0, marble: 0, faith: 0 },
    coastal: false,
    position: { x: 44, y: 29 },
    startingFaction: Faction.OTTOMAN,
    walls: wall(3),
    isCapitalOf: Faction.OTTOMAN,
  },
  {
    id: "gallipoli",
    name: "Gallipoli",
    terrain: TerrainType.COAST,
    // Ottoman naval base gating the Dardanelles: +1 grain, +1 timber
    yields: { gold: 1, grain: 2, timber: 1, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 46, y: 39 },
    startingFaction: Faction.OTTOMAN,
    walls: wall(2),
  },
  // --- Bulgaria / Danube -------------------------------------------------
  {
    id: "philippopolis",
    name: "Philippopolis (Plovdiv)",
    terrain: TerrainType.PLAINS,
    yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: false,
    position: { x: 40, y: 27 },
    startingFaction: Faction.OTTOMAN,
    walls: wall(0),
  },
  {
    id: "sofia",
    name: "Sofia",
    terrain: TerrainType.HILLS,
    // hills base (gold1/stone1) + grain crossroads: +1 grain
    yields: { gold: 1, grain: 1, timber: 0, marble: 1, faith: 0 },
    coastal: false,
    position: { x: 36, y: 25 },
    startingFaction: Faction.OTTOMAN,
    walls: wall(0),
  },
  {
    id: "varna",
    name: "Varna",
    terrain: TerrainType.COAST,
    yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 44, y: 21 },
    startingFaction: null,
    walls: wall(1),
    garrison: 1,
  },
  {
    id: "wallachia",
    name: "Wallachia",
    terrain: TerrainType.PLAINS,
    // raider frontier: +1 timber
    yields: { gold: 1, grain: 2, timber: 1, marble: 0, faith: 0 },
    coastal: false,
    position: { x: 40, y: 14 },
    startingFaction: null,
    walls: wall(0),
    minorId: "wallachia",
    garrison: 3,
  },
  {
    id: "serbia",
    name: "Serbia (Smederevo)",
    terrain: TerrainType.HILLS,
    // Novo Brdo silver: +1 gold
    yields: { gold: 2, grain: 0, timber: 0, marble: 1, faith: 0 },
    coastal: false,
    position: { x: 28, y: 20 },
    startingFaction: null,
    walls: wall(2),
    minorId: "serbia",
    garrison: 3,
  },
  {
    id: "bosnia",
    name: "Bosnia",
    terrain: TerrainType.MOUNTAINS,
    // silver & lead: mountains base stone2 + timber
    yields: { gold: 0, grain: 0, timber: 1, marble: 2, faith: 0 },
    coastal: false,
    position: { x: 24, y: 24 },
    startingFaction: null,
    walls: wall(1),
    garrison: 1,
  },
  {
    id: "albania",
    name: "Albania (Krujë)",
    terrain: TerrainType.MOUNTAINS,
    // primary timber highland: timber2, stone1
    yields: { gold: 0, grain: 0, timber: 2, marble: 1, faith: 0 },
    coastal: true,
    position: { x: 26, y: 34 },
    startingFaction: null,
    walls: wall(1),
    garrison: 1,
  },
  {
    id: "epirus",
    name: "Epirus (Arta)",
    terrain: TerrainType.MOUNTAINS,
    // primary timber, secondary grain
    yields: { gold: 0, grain: 1, timber: 2, marble: 1, faith: 0 },
    coastal: true,
    position: { x: 28, y: 40 },
    startingFaction: null,
    walls: wall(0),
    garrison: 1,
  },
  // --- Greece / Macedonia ------------------------------------------------
  {
    id: "thessaly",
    name: "Thessaly (Larissa)",
    terrain: TerrainType.PLAINS,
    // fertile plain: +1 grain
    yields: { gold: 1, grain: 3, timber: 0, marble: 0, faith: 0 },
    coastal: false,
    position: { x: 32, y: 44 },
    startingFaction: null,
    walls: wall(0),
    garrison: 1,
  },
  {
    id: "thessalonica",
    name: "Thessalonica",
    terrain: TerrainType.CITY,
    // second Byzantine city HV(3): +1 gold, +1 grain, +1 faith
    yields: { gold: 4, grain: 1, timber: 0, marble: 0, faith: 2 },
    coastal: true,
    position: { x: 34, y: 38 },
    startingFaction: Faction.BYZANTIUM,
    walls: wall(3),
    highValue: 3,
  },
  {
    id: "athens",
    name: "Athens",
    terrain: TerrainType.CITY,
    // Acciaioli duchy HV(3), marble: gold reduced, +2 marble, +1 faith
    yields: { gold: 2, grain: 0, timber: 0, marble: 2, faith: 2 },
    coastal: true,
    position: { x: 36, y: 52 },
    startingFaction: null,
    walls: wall(2),
    highValue: 3,
    garrison: 2,
  },
  {
    id: "morea",
    name: "Morea (Mistra)",
    terrain: TerrainType.HILLS,
    // Despotate of the Morea: +1 grain, +1 faith
    yields: { gold: 1, grain: 1, timber: 0, marble: 1, faith: 1 },
    coastal: false,
    position: { x: 32, y: 58 },
    startingFaction: Faction.BYZANTIUM,
    walls: wall(2),
  },
  {
    id: "modon",
    name: "Modon & Coron",
    terrain: TerrainType.COAST,
    // "eyes of the Republic": +1 gold
    yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 30, y: 60 },
    startingFaction: Faction.VENICE,
    walls: wall(1),
  },
  // --- Italy -------------------------------------------------------------
  {
    id: "venice",
    name: "Venice",
    terrain: TerrainType.CITY,
    // capital, the Arsenal HV(4): +2 gold, +1 grain, +2 timber
    yields: { gold: 5, grain: 1, timber: 2, marble: 0, faith: 1 },
    coastal: true,
    position: { x: 12, y: 20 },
    startingFaction: Faction.VENICE,
    walls: wall(3),
    isCapitalOf: Faction.VENICE,
    highValue: 4,
  },
  {
    id: "milan",
    name: "Milan",
    terrain: TerrainType.PLAINS,
    // armorers & condottieri: +1 gold, +1 marble
    yields: { gold: 2, grain: 2, timber: 0, marble: 1, faith: 0 },
    coastal: false,
    position: { x: 8, y: 22 },
    startingFaction: null,
    walls: wall(2),
    garrison: 1,
  },
  {
    id: "genoa",
    name: "Genoa",
    terrain: TerrainType.CITY,
    // capital, Bank of St George HV(4): +2 gold, +1 marble
    yields: { gold: 5, grain: 0, timber: 0, marble: 1, faith: 1 },
    coastal: true,
    position: { x: 8, y: 29 },
    startingFaction: Faction.GENOA,
    walls: wall(3),
    isCapitalOf: Faction.GENOA,
    highValue: 4,
  },
  {
    id: "rome",
    name: "Rome",
    terrain: TerrainType.CITY,
    // Papacy HV(4): primary faith, secondary gold: +3 faith
    yields: { gold: 3, grain: 0, timber: 0, marble: 0, faith: 4 },
    coastal: true,
    position: { x: 12, y: 35 },
    startingFaction: null,
    walls: wall(4),
    highValue: 4,
    garrison: 2,
  },
  {
    id: "naples",
    name: "Naples",
    terrain: TerrainType.CITY,
    // Aragonese kingdom HV(3): primary grain, secondary gold
    yields: { gold: 3, grain: 3, timber: 0, marble: 0, faith: 1 },
    coastal: true,
    position: { x: 15, y: 41 },
    startingFaction: null,
    walls: wall(3),
    highValue: 3,
    garrison: 2,
  },
  {
    id: "sicily",
    name: "Sicily (Palermo)",
    terrain: TerrainType.COAST,
    // Aragon's granary: +1 gold, +2 grain
    yields: { gold: 2, grain: 3, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 15, y: 50 },
    startingFaction: null,
    walls: wall(2),
    garrison: 1,
  },
  {
    id: "tunis",
    name: "Tunis",
    terrain: TerrainType.DESERT,
    // Hafsid corsair nest: desert base gold1 + caravan gold, +1 grain
    yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 10, y: 62 },
    startingFaction: null,
    walls: wall(1),
    garrison: 1,
  },
  // --- Dalmatia / Croatia / Hungary -------------------------------------
  {
    id: "dalmatia",
    name: "Dalmatia (Zara/Split)",
    terrain: TerrainType.COAST,
    // Arsenal oak & marble: +2 timber, +1 marble
    yields: { gold: 1, grain: 1, timber: 2, marble: 1, faith: 0 },
    coastal: true,
    position: { x: 20, y: 28 },
    startingFaction: Faction.VENICE,
    walls: wall(1),
  },
  {
    id: "ragusa",
    name: "Ragusa",
    terrain: TerrainType.CITY,
    // merchant republic, tribute-payer: primary gold only, faith dropped
    yields: { gold: 4, grain: 1, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 22, y: 33 },
    startingFaction: null,
    walls: wall(2),
    minorId: "ragusa",
    garrison: 1,
  },
  {
    id: "croatia",
    name: "Croatia (Zagreb)",
    terrain: TerrainType.FOREST,
    // frontier march: forest base grain1/timber2
    yields: { gold: 0, grain: 1, timber: 2, marble: 0, faith: 0 },
    coastal: false,
    position: { x: 20, y: 18 },
    startingFaction: Faction.HUNGARY,
    walls: wall(0),
  },
  {
    id: "buda",
    name: "Buda",
    terrain: TerrainType.CITY,
    // capital, Danube river port (not sea-reachable): +1 gold, +2 grain
    yields: { gold: 4, grain: 2, timber: 0, marble: 0, faith: 1 },
    coastal: false,
    position: { x: 22, y: 10 },
    startingFaction: Faction.HUNGARY,
    walls: wall(3),
    isCapitalOf: Faction.HUNGARY,
  },
  {
    id: "belgrade",
    name: "Belgrade (Nándorfehérvár)",
    terrain: TerrainType.CITY,
    // key Danube fortress, river port: primary grain, secondary marble
    yields: { gold: 2, grain: 3, timber: 0, marble: 1, faith: 1 },
    coastal: false,
    position: { x: 26, y: 16 },
    startingFaction: Faction.HUNGARY,
    walls: wall(4),
  },
  {
    id: "transylvania",
    name: "Transylvania",
    terrain: TerrainType.FOREST,
    // gold & salt mines: +2 gold
    yields: { gold: 2, grain: 1, timber: 2, marble: 0, faith: 0 },
    coastal: false,
    position: { x: 32, y: 10 },
    startingFaction: Faction.HUNGARY,
    walls: wall(1),
  },
  // --- NW / Central / N Anatolia ----------------------------------------
  {
    id: "bithynia",
    name: "Bithynia (Nicomedia)",
    terrain: TerrainType.HILLS,
    // Asian shore of the Bosphorus: primary grain, secondary timber
    yields: { gold: 1, grain: 2, timber: 1, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 56, y: 36 },
    startingFaction: Faction.OTTOMAN,
    walls: wall(0),
  },
  {
    id: "bursa",
    name: "Bursa",
    terrain: TerrainType.HILLS,
    // first Ottoman capital, silk: +2 gold, +1 grain
    yields: { gold: 3, grain: 1, timber: 0, marble: 1, faith: 0 },
    coastal: false,
    position: { x: 58, y: 41 },
    startingFaction: Faction.OTTOMAN,
    walls: wall(3),
  },
  {
    id: "nicaea",
    name: "Nicaea (İznik)",
    terrain: TerrainType.CITY,
    // council city, lake fortress: primary grain, secondary faith
    yields: { gold: 2, grain: 2, timber: 0, marble: 0, faith: 2 },
    coastal: false,
    position: { x: 58, y: 38 },
    startingFaction: Faction.OTTOMAN,
    walls: wall(2),
  },
  {
    id: "ankara",
    name: "Ankara",
    terrain: TerrainType.PLAINS,
    // angora wool, Karaman league: primary grain, secondary marble
    yields: { gold: 1, grain: 2, timber: 0, marble: 1, faith: 0 },
    coastal: false,
    position: { x: 66, y: 40 },
    startingFaction: null,
    walls: wall(1),
    minorId: "karaman",
    garrison: 2,
  },
  {
    id: "konya",
    name: "Konya",
    terrain: TerrainType.PLAINS,
    // Karaman beylik seat: primary grain, secondary marble
    yields: { gold: 1, grain: 2, timber: 0, marble: 1, faith: 0 },
    coastal: false,
    position: { x: 68, y: 48 },
    startingFaction: null,
    walls: wall(1),
    minorId: "karaman",
    garrison: 3,
  },
  {
    id: "kastamonu",
    name: "Kastamonu",
    terrain: TerrainType.MOUNTAINS,
    // Candar / İsfendiyar beylik: primary timber, secondary marble
    yields: { gold: 0, grain: 0, timber: 2, marble: 1, faith: 0 },
    coastal: false,
    position: { x: 70, y: 32 },
    startingFaction: null,
    walls: wall(0),
    garrison: 1,
  },
  {
    id: "sinope",
    name: "Sinope",
    terrain: TerrainType.COAST,
    // Black Sea shipyards: +1 gold, +2 timber
    yields: { gold: 2, grain: 1, timber: 2, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 74, y: 30 },
    startingFaction: null,
    walls: wall(1),
    garrison: 1,
  },
  // --- W / S Anatolia ----------------------------------------------------
  {
    id: "smyrna",
    name: "Smyrna (İzmir)",
    terrain: TerrainType.COAST,
    // Aydın beylik port: +1 gold, +1 grain
    yields: { gold: 2, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 54, y: 50 },
    startingFaction: null,
    walls: wall(1),
    garrison: 1,
  },
  {
    id: "antalya",
    name: "Antalya (Attaleia)",
    terrain: TerrainType.COAST,
    // Teke coast: +1 gold, +1 grain (registry lists no walls)
    yields: { gold: 2, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 64, y: 55 },
    startingFaction: null,
    walls: wall(0),
    garrison: 1,
  },
  // --- Pontus ------------------------------------------------------------
  {
    id: "trebizond",
    name: "Trebizond",
    terrain: TerrainType.CITY,
    // Empire of Trebizond HV(3), silk terminus: +1 gold, +1 grain, +1 faith
    yields: { gold: 4, grain: 1, timber: 0, marble: 0, faith: 2 },
    coastal: true,
    position: { x: 86, y: 30 },
    startingFaction: null,
    walls: wall(3),
    highValue: 3,
    minorId: "trebizond",
    garrison: 2,
  },
  // --- Levant / Egypt ----------------------------------------------------
  {
    id: "aleppo",
    name: "Aleppo",
    terrain: TerrainType.PLAINS,
    // Mamluk caravan city: +2 gold
    yields: { gold: 3, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: false,
    position: { x: 78, y: 52 },
    startingFaction: null,
    walls: wall(1),
    garrison: 1,
  },
  {
    id: "antioch",
    name: "Antioch",
    terrain: TerrainType.COAST,
    // Mamluk frontier: +1 gold, +1 grain
    yields: { gold: 2, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 74, y: 56 },
    startingFaction: null,
    walls: wall(1),
    garrison: 1,
  },
  {
    id: "cairo",
    name: "Cairo",
    terrain: TerrainType.DESERT,
    // Mamluk capital HV(3): desert base gold1 + +3 gold, +1 grain, +2 faith
    yields: { gold: 4, grain: 1, timber: 0, marble: 0, faith: 2 },
    coastal: false,
    position: { x: 72, y: 72 },
    startingFaction: null,
    walls: wall(2),
    highValue: 3,
    garrison: 2,
  },
  {
    id: "alexandria",
    name: "Alexandria",
    terrain: TerrainType.COAST,
    // Nile grain + spice HV(3): +2 gold, +2 grain
    yields: { gold: 3, grain: 3, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 68, y: 68 },
    startingFaction: null,
    walls: wall(2),
    highValue: 3,
    garrison: 2,
  },
  // --- E Mediterranean / Aegean islands ---------------------------------
  {
    id: "cyprus",
    name: "Cyprus",
    terrain: TerrainType.COAST,
    // Lusignan kingdom, sugar & wine: +2 gold, +1 grain
    yields: { gold: 3, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 68, y: 60 },
    startingFaction: null,
    walls: wall(2),
    garrison: 1,
  },
  {
    id: "rhodes",
    name: "Rhodes",
    terrain: TerrainType.COAST,
    // Knights Hospitaller: +2 gold, +2 faith
    yields: { gold: 3, grain: 1, timber: 0, marble: 0, faith: 2 },
    coastal: true,
    position: { x: 54, y: 60 },
    startingFaction: null,
    walls: wall(3),
    minorId: "rhodes",
    garrison: 3,
  },
  {
    id: "chios",
    name: "Chios",
    terrain: TerrainType.COAST,
    // mastic & alum, the Maona: +2 gold
    yields: { gold: 3, grain: 1, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 50, y: 52 },
    startingFaction: Faction.GENOA,
    walls: wall(1),
  },
  {
    id: "lesbos",
    name: "Lesbos (Mytilene)",
    terrain: TerrainType.HILLS,
    // Gattilusio lordship: primary timber, secondary gold
    yields: { gold: 2, grain: 0, timber: 2, marble: 1, faith: 0 },
    coastal: true,
    position: { x: 50, y: 46 },
    startingFaction: Faction.GENOA,
    walls: wall(1),
  },
  {
    id: "lemnos",
    name: "Lemnos",
    terrain: TerrainType.PLAINS,
    // Byzantine granary isle: +1 grain
    yields: { gold: 1, grain: 3, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 44, y: 44 },
    startingFaction: Faction.BYZANTIUM,
    walls: wall(1),
  },
  {
    id: "negroponte",
    name: "Negroponte (Euboea)",
    terrain: TerrainType.COAST,
    // Venetian bailo's seat: +1 gold, +1 grain
    yields: { gold: 2, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 40, y: 50 },
    startingFaction: Faction.VENICE,
    walls: wall(2),
  },
  {
    id: "naxos",
    name: "Naxos",
    terrain: TerrainType.HILLS,
    // Duchy of the Archipelago, marble: +1 gold, +1 marble
    yields: { gold: 2, grain: 0, timber: 0, marble: 2, faith: 0 },
    coastal: true,
    position: { x: 46, y: 58 },
    startingFaction: null,
    walls: wall(1),
    garrison: 1,
  },
  {
    id: "crete",
    name: "Crete (Candia)",
    terrain: TerrainType.HILLS,
    // HV(3), wine & Arsenal timber depot: +2 gold, +2 grain
    yields: { gold: 3, grain: 2, timber: 0, marble: 1, faith: 0 },
    coastal: true,
    position: { x: 44, y: 66 },
    startingFaction: Faction.VENICE,
    walls: wall(2),
    highValue: 3,
  },
  {
    id: "corfu",
    name: "Corfu",
    terrain: TerrainType.COAST,
    // Venetian gate of the Adriatic: +1 gold, +1 grain
    yields: { gold: 2, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 26, y: 44 },
    startingFaction: Faction.VENICE,
    walls: wall(2),
  },
  // --- Crimea / Black Sea ------------------------------------------------
  {
    id: "kaffa",
    name: "Kaffa (Caffa)",
    terrain: TerrainType.CITY,
    // Genoese Black Sea colony HV(3), grain & slave trade: +1 gold, +2 grain, faith dropped
    yields: { gold: 4, grain: 2, timber: 0, marble: 0, faith: 0 },
    coastal: true,
    position: { x: 66, y: 12 },
    startingFaction: Faction.GENOA,
    walls: wall(2),
    highValue: 3,
  },
];

/** The 12 named sea zones (MAP.md §7). */
export const SEA_ZONES: SeaZone[] = [
  {
    id: "bosphorus",
    name: "Bosphorus",
    position: { x: 53, y: 32 },
    straits: ["black-sea-west", "sea-of-marmara"],
  },
  {
    id: "sea-of-marmara",
    name: "Sea of Marmara",
    position: { x: 52, y: 40 },
    straits: ["aegean"], // Dardanelles, gated by gallipoli
  },
  { id: "aegean", name: "Aegean Sea", position: { x: 46, y: 52 } },
  { id: "sea-of-crete", name: "Sea of Crete", position: { x: 46, y: 64 } },
  {
    id: "eastern-mediterranean",
    name: "Eastern Mediterranean",
    position: { x: 62, y: 64 },
  },
  { id: "ionian", name: "Ionian Sea", position: { x: 28, y: 50 } },
  { id: "adriatic", name: "Adriatic Sea", position: { x: 22, y: 30 } },
  { id: "tyrrhenian", name: "Tyrrhenian Sea", position: { x: 14, y: 38 } },
  {
    id: "sicilian-channel",
    name: "Sicilian Channel",
    position: { x: 16, y: 56 },
  },
  { id: "black-sea-west", name: "Black Sea (West)", position: { x: 52, y: 18 } },
  { id: "black-sea-east", name: "Black Sea (East)", position: { x: 74, y: 20 } },
  { id: "sea-of-azov", name: "Sea of Azov", position: { x: 68, y: 8 } },
];

/**
 * The 6 NPC minor states (MAP.md §5). Garrison is a headcount of standing
 * defenders; tier is the minor's fortification/difficulty tier (its walled
 * seat's MAP tier). All start un-vassalized.
 */
export const NPC_MINORS: NpcMinor[] = [
  {
    id: "serbia",
    name: "Despotate of Serbia",
    provinceIds: ["serbia"],
    garrison: 3, // 2 levies + 1 professional infantry, behind T2 walls
    tier: 2,
    vassalOf: null,
  },
  {
    id: "wallachia",
    name: "Voivodship of Wallachia",
    provinceIds: ["wallachia"],
    garrison: 3, // 2 levies + 1 light cavalry; volatile, revolt-prone
    tier: 1,
    vassalOf: null,
  },
  {
    id: "trebizond",
    name: "Empire of Trebizond",
    provinceIds: ["trebizond"],
    garrison: 2, // 1 professional infantry + 1 war galley, behind T3 walls
    tier: 3,
    vassalOf: null,
  },
  {
    id: "karaman",
    name: "Karaman League",
    provinceIds: ["ankara", "konya"],
    garrison: 5, // 2 levies each (4) + 1 light cavalry
    tier: 1,
    vassalOf: null,
  },
  {
    id: "rhodes",
    name: "Knights of Rhodes (Hospitallers)",
    provinceIds: ["rhodes"],
    garrison: 3, // 2 professional infantry + 1 war galley, behind T3 walls
    tier: 3,
    vassalOf: null,
  },
  {
    id: "ragusa",
    name: "Republic of Ragusa",
    provinceIds: ["ragusa"],
    garrison: 1, // 1 levy, behind T2 walls; the easiest vassal
    tier: 2,
    vassalOf: null,
  },
];

/**
 * Undirected edge list (MAP.md §6–§8). Every pair is expanded into a symmetric
 * adjacency map below, so callers never worry about direction. Covers land
 * borders (incl. the Bosphorus, Messina, Golden Horn and Dardanelles crossings),
 * province↔sea-zone access, and sea-zone↔sea-zone straits.
 */
const EDGES: ReadonlyArray<readonly [string, string]> = [
  // --- Land borders (§6) ------------------------------------------------
  ["constantinople", "selymbria"],
  ["constantinople", "pera"], // Golden Horn (adjacent city faces)
  ["constantinople", "bithynia"], // Bosphorus strait crossing
  ["selymbria", "edirne"],
  ["edirne", "philippopolis"],
  ["edirne", "gallipoli"],
  ["edirne", "thessalonica"],
  ["philippopolis", "sofia"],
  ["philippopolis", "varna"],
  ["sofia", "serbia"],
  ["sofia", "thessalonica"],
  ["varna", "wallachia"],
  ["wallachia", "serbia"],
  ["wallachia", "transylvania"],
  ["wallachia", "belgrade"],
  ["serbia", "bosnia"],
  ["serbia", "belgrade"],
  ["serbia", "albania"],
  ["bosnia", "croatia"],
  ["bosnia", "dalmatia"],
  ["bosnia", "ragusa"],
  ["bosnia", "belgrade"],
  ["albania", "epirus"],
  ["albania", "ragusa"],
  ["epirus", "thessaly"],
  ["thessaly", "thessalonica"],
  ["thessaly", "athens"],
  ["athens", "morea"],
  ["morea", "modon"],
  ["belgrade", "buda"],
  ["buda", "transylvania"],
  ["buda", "croatia"],
  ["croatia", "dalmatia"],
  ["dalmatia", "ragusa"],
  ["venice", "milan"],
  ["milan", "genoa"],
  ["milan", "rome"],
  ["genoa", "rome"],
  ["rome", "naples"],
  ["naples", "sicily"], // Strait of Messina crossing
  ["bithynia", "bursa"],
  ["bithynia", "nicaea"],
  ["bursa", "nicaea"],
  ["bursa", "smyrna"],
  ["bursa", "ankara"],
  ["nicaea", "ankara"],
  ["ankara", "konya"],
  ["ankara", "kastamonu"],
  ["kastamonu", "sinope"],
  ["sinope", "trebizond"],
  ["konya", "antalya"],
  ["konya", "aleppo"],
  ["konya", "smyrna"],
  ["aleppo", "antioch"],
  ["aleppo", "cairo"],
  ["cairo", "alexandria"],

  // --- Province ↔ sea zone (§6 "Sea Zones" column) ----------------------
  ["constantinople", "bosphorus"],
  ["constantinople", "sea-of-marmara"],
  ["selymbria", "sea-of-marmara"],
  ["pera", "bosphorus"],
  ["gallipoli", "sea-of-marmara"],
  ["gallipoli", "aegean"],
  ["varna", "black-sea-west"],
  ["wallachia", "black-sea-west"],
  ["albania", "ionian"],
  ["epirus", "ionian"],
  ["thessaly", "aegean"],
  ["thessalonica", "aegean"],
  ["athens", "aegean"],
  ["morea", "aegean"],
  ["morea", "sea-of-crete"],
  ["morea", "ionian"],
  ["modon", "sea-of-crete"],
  ["modon", "ionian"],
  ["dalmatia", "adriatic"],
  ["ragusa", "adriatic"],
  ["ragusa", "ionian"],
  ["venice", "adriatic"],
  ["genoa", "tyrrhenian"],
  ["rome", "tyrrhenian"],
  ["naples", "tyrrhenian"],
  ["naples", "ionian"],
  ["sicily", "tyrrhenian"],
  ["sicily", "sicilian-channel"],
  ["sicily", "ionian"],
  ["tunis", "sicilian-channel"],
  ["tunis", "eastern-mediterranean"],
  ["bithynia", "bosphorus"],
  ["bithynia", "sea-of-marmara"],
  ["bursa", "sea-of-marmara"],
  ["kastamonu", "black-sea-east"],
  ["sinope", "black-sea-east"],
  ["trebizond", "black-sea-east"],
  ["smyrna", "aegean"],
  ["antalya", "eastern-mediterranean"],
  ["antioch", "eastern-mediterranean"],
  ["alexandria", "eastern-mediterranean"],
  ["cyprus", "eastern-mediterranean"],
  ["rhodes", "sea-of-crete"],
  ["rhodes", "eastern-mediterranean"],
  ["chios", "aegean"],
  ["lesbos", "aegean"],
  ["lemnos", "aegean"],
  ["negroponte", "aegean"],
  ["naxos", "aegean"],
  ["naxos", "sea-of-crete"],
  ["crete", "sea-of-crete"],
  ["corfu", "ionian"],
  ["corfu", "adriatic"],
  ["kaffa", "black-sea-west"],
  ["kaffa", "black-sea-east"],
  ["kaffa", "sea-of-azov"],

  // --- Sea zone ↔ sea zone straits (§7 "Connects To") -------------------
  ["bosphorus", "sea-of-marmara"],
  ["bosphorus", "black-sea-west"],
  ["sea-of-marmara", "aegean"], // Dardanelles at gallipoli
  ["aegean", "sea-of-crete"],
  ["sea-of-crete", "eastern-mediterranean"],
  ["sea-of-crete", "ionian"],
  ["eastern-mediterranean", "sicilian-channel"],
  ["ionian", "adriatic"],
  ["ionian", "sicilian-channel"],
  ["ionian", "tyrrhenian"],
  ["tyrrhenian", "sicilian-channel"],
  ["black-sea-west", "black-sea-east"],
  ["black-sea-east", "sea-of-azov"],
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
