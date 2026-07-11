/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Generated from docs/MAP.md (the canonical map registry) by
 * src/board/tools/genMapData.ts. Regenerate after any MAP.md change:
 *   npm run gen:map        (client workspace)
 *   npx tsx src/board/tools/genMapData.ts
 *
 * Yield quantification: primary yield = 2, secondary = 1 (see the
 * generator). The drift-guard test fails when this file is stale.
 */
import { TerrainType } from "@imperium/shared";
import type { ResourceBundle } from "@imperium/shared";

/** A land province exactly as docs/MAP.md §3 + §6 define it. */
export interface CanonProvince {
  id: string;
  name: string;
  region: string;
  terrain: TerrainType;
  yields: ResourceBundle;
  /** "Y" port, "N" no harbor, "R" Danube river port (no sea zone). */
  port: "Y" | "N" | "R";
  /** Wall tier 1-5, or null for open/rural provinces. */
  walls: number | null;
  /** High-value node weight HV(n), or null. */
  hv: number | null;
  /** One of the five great powers, or null for Independent. */
  startingOwner: string | null;
  /** True iff the province borders at least one sea zone. */
  coastal: boolean;
}

export interface CanonSeaZone {
  id: string;
  name: string;
}

/** The 55 land provinces, in MAP.md §3 registry order. */
export const CANON_PROVINCES: readonly CanonProvince[] = [
  { id: "constantinople", name: "Constantinople", region: "Thrace & Constantinople", terrain: TerrainType.CITY, yields: { gold: 2, grain: 0, timber: 0, marble: 0, faith: 1 }, port: "Y", walls: 5, hv: 5, startingOwner: "Byzantium", coastal: true },
  { id: "selymbria", name: "Selymbria", region: "Thrace & Constantinople", terrain: TerrainType.COAST, yields: { gold: 0, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: null, hv: null, startingOwner: "Byzantium", coastal: true },
  { id: "pera", name: "Pera (Galata)", region: "Thrace & Constantinople", terrain: TerrainType.CITY, yields: { gold: 2, grain: 0, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: "Genoa", coastal: true },
  { id: "edirne", name: "Edirne (Adrianople)", region: "Thrace & Constantinople", terrain: TerrainType.PLAINS, yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "N", walls: 3, hv: null, startingOwner: "Ottomans", coastal: false },
  { id: "gallipoli", name: "Gallipoli", region: "Thrace & Constantinople", terrain: TerrainType.COAST, yields: { gold: 0, grain: 2, timber: 1, marble: 0, faith: 0 }, port: "Y", walls: 2, hv: null, startingOwner: "Ottomans", coastal: true },
  { id: "philippopolis", name: "Philippopolis (Plovdiv)", region: "Balkans", terrain: TerrainType.PLAINS, yields: { gold: 0, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "N", walls: null, hv: null, startingOwner: "Ottomans", coastal: false },
  { id: "sofia", name: "Sofia", region: "Balkans", terrain: TerrainType.HILLS, yields: { gold: 0, grain: 2, timber: 0, marble: 1, faith: 0 }, port: "N", walls: null, hv: null, startingOwner: "Ottomans", coastal: false },
  { id: "varna", name: "Varna", region: "Black Sea", terrain: TerrainType.COAST, yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: null, coastal: true },
  { id: "wallachia", name: "Wallachia", region: "Balkans", terrain: TerrainType.PLAINS, yields: { gold: 0, grain: 2, timber: 1, marble: 0, faith: 0 }, port: "N", walls: null, hv: null, startingOwner: null, coastal: true },
  { id: "serbia", name: "Serbia (Smederevo)", region: "Balkans", terrain: TerrainType.HILLS, yields: { gold: 2, grain: 0, timber: 0, marble: 1, faith: 0 }, port: "N", walls: 2, hv: null, startingOwner: null, coastal: false },
  { id: "bosnia", name: "Bosnia", region: "Balkans", terrain: TerrainType.MOUNTAINS, yields: { gold: 0, grain: 0, timber: 1, marble: 2, faith: 0 }, port: "N", walls: 1, hv: null, startingOwner: null, coastal: false },
  { id: "albania", name: "Albania (Krujë)", region: "Balkans", terrain: TerrainType.MOUNTAINS, yields: { gold: 0, grain: 0, timber: 2, marble: 1, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: null, coastal: true },
  { id: "epirus", name: "Epirus (Arta)", region: "Greece & Aegean", terrain: TerrainType.MOUNTAINS, yields: { gold: 0, grain: 1, timber: 2, marble: 0, faith: 0 }, port: "Y", walls: null, hv: null, startingOwner: null, coastal: true },
  { id: "thessaly", name: "Thessaly (Larissa)", region: "Greece & Aegean", terrain: TerrainType.PLAINS, yields: { gold: 0, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "N", walls: null, hv: null, startingOwner: null, coastal: true },
  { id: "thessalonica", name: "Thessalonica", region: "Greece & Aegean", terrain: TerrainType.CITY, yields: { gold: 2, grain: 0, timber: 0, marble: 0, faith: 1 }, port: "Y", walls: 3, hv: 3, startingOwner: "Byzantium", coastal: true },
  { id: "athens", name: "Athens", region: "Greece & Aegean", terrain: TerrainType.CITY, yields: { gold: 0, grain: 0, timber: 0, marble: 2, faith: 1 }, port: "Y", walls: 2, hv: 3, startingOwner: null, coastal: true },
  { id: "morea", name: "Morea (Mistra)", region: "Greece & Aegean", terrain: TerrainType.HILLS, yields: { gold: 0, grain: 2, timber: 0, marble: 0, faith: 1 }, port: "N", walls: 2, hv: null, startingOwner: "Byzantium", coastal: true },
  { id: "modon", name: "Modon & Coron", region: "Greece & Aegean", terrain: TerrainType.COAST, yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: "Venice", coastal: true },
  { id: "venice", name: "Venice", region: "Italy", terrain: TerrainType.CITY, yields: { gold: 2, grain: 0, timber: 1, marble: 0, faith: 0 }, port: "Y", walls: 3, hv: 4, startingOwner: "Venice", coastal: true },
  { id: "milan", name: "Milan", region: "Italy", terrain: TerrainType.PLAINS, yields: { gold: 2, grain: 0, timber: 0, marble: 1, faith: 0 }, port: "N", walls: 2, hv: null, startingOwner: null, coastal: false },
  { id: "genoa", name: "Genoa", region: "Italy", terrain: TerrainType.CITY, yields: { gold: 2, grain: 0, timber: 0, marble: 1, faith: 0 }, port: "Y", walls: 3, hv: 4, startingOwner: "Genoa", coastal: true },
  { id: "rome", name: "Rome", region: "Italy", terrain: TerrainType.CITY, yields: { gold: 1, grain: 0, timber: 0, marble: 0, faith: 2 }, port: "Y", walls: 4, hv: 4, startingOwner: null, coastal: true },
  { id: "naples", name: "Naples", region: "Italy", terrain: TerrainType.CITY, yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 3, hv: 3, startingOwner: null, coastal: true },
  { id: "sicily", name: "Sicily (Palermo)", region: "Western Mediterranean", terrain: TerrainType.COAST, yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 2, hv: null, startingOwner: null, coastal: true },
  { id: "tunis", name: "Tunis", region: "Western Mediterranean", terrain: TerrainType.COAST, yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: null, coastal: true },
  { id: "dalmatia", name: "Dalmatia (Zara/Split)", region: "Balkans", terrain: TerrainType.COAST, yields: { gold: 0, grain: 0, timber: 2, marble: 1, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: "Venice", coastal: true },
  { id: "ragusa", name: "Ragusa", region: "Balkans", terrain: TerrainType.CITY, yields: { gold: 2, grain: 0, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 2, hv: null, startingOwner: null, coastal: true },
  { id: "croatia", name: "Croatia (Zagreb)", region: "Balkans", terrain: TerrainType.FOREST, yields: { gold: 0, grain: 1, timber: 2, marble: 0, faith: 0 }, port: "N", walls: null, hv: null, startingOwner: "Hungary", coastal: false },
  { id: "buda", name: "Buda", region: "Balkans", terrain: TerrainType.CITY, yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 }, port: "R", walls: 3, hv: null, startingOwner: "Hungary", coastal: false },
  { id: "belgrade", name: "Belgrade (Nándorfehérvár)", region: "Balkans", terrain: TerrainType.CITY, yields: { gold: 0, grain: 2, timber: 0, marble: 1, faith: 0 }, port: "R", walls: 4, hv: null, startingOwner: "Hungary", coastal: false },
  { id: "transylvania", name: "Transylvania", region: "Balkans", terrain: TerrainType.FOREST, yields: { gold: 2, grain: 0, timber: 1, marble: 0, faith: 0 }, port: "N", walls: 1, hv: null, startingOwner: "Hungary", coastal: false },
  { id: "bithynia", name: "Bithynia (Nicomedia)", region: "Anatolia", terrain: TerrainType.HILLS, yields: { gold: 0, grain: 2, timber: 1, marble: 0, faith: 0 }, port: "Y", walls: null, hv: null, startingOwner: "Ottomans", coastal: true },
  { id: "bursa", name: "Bursa", region: "Anatolia", terrain: TerrainType.HILLS, yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 }, port: "N", walls: 3, hv: null, startingOwner: "Ottomans", coastal: true },
  { id: "nicaea", name: "Nicaea (İznik)", region: "Anatolia", terrain: TerrainType.CITY, yields: { gold: 0, grain: 2, timber: 0, marble: 0, faith: 1 }, port: "N", walls: 2, hv: null, startingOwner: "Ottomans", coastal: false },
  { id: "ankara", name: "Ankara", region: "Anatolia", terrain: TerrainType.PLAINS, yields: { gold: 0, grain: 2, timber: 0, marble: 1, faith: 0 }, port: "N", walls: 1, hv: null, startingOwner: null, coastal: false },
  { id: "konya", name: "Konya", region: "Anatolia", terrain: TerrainType.PLAINS, yields: { gold: 0, grain: 2, timber: 0, marble: 1, faith: 0 }, port: "N", walls: 1, hv: null, startingOwner: null, coastal: false },
  { id: "kastamonu", name: "Kastamonu", region: "Anatolia", terrain: TerrainType.MOUNTAINS, yields: { gold: 0, grain: 0, timber: 2, marble: 1, faith: 0 }, port: "N", walls: null, hv: null, startingOwner: null, coastal: true },
  { id: "sinope", name: "Sinope", region: "Black Sea", terrain: TerrainType.COAST, yields: { gold: 1, grain: 0, timber: 2, marble: 0, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: null, coastal: true },
  { id: "smyrna", name: "Smyrna (İzmir)", region: "Anatolia", terrain: TerrainType.COAST, yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: null, coastal: true },
  { id: "antalya", name: "Antalya (Attaleia)", region: "Anatolia", terrain: TerrainType.COAST, yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: null, hv: null, startingOwner: null, coastal: true },
  { id: "trebizond", name: "Trebizond", region: "Black Sea", terrain: TerrainType.CITY, yields: { gold: 2, grain: 0, timber: 0, marble: 0, faith: 1 }, port: "Y", walls: 3, hv: 3, startingOwner: null, coastal: true },
  { id: "aleppo", name: "Aleppo", region: "Levant & Egypt", terrain: TerrainType.PLAINS, yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 }, port: "N", walls: 1, hv: null, startingOwner: null, coastal: false },
  { id: "antioch", name: "Antioch", region: "Levant & Egypt", terrain: TerrainType.COAST, yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: null, coastal: true },
  { id: "cairo", name: "Cairo", region: "Levant & Egypt", terrain: TerrainType.CITY, yields: { gold: 2, grain: 0, timber: 0, marble: 0, faith: 1 }, port: "N", walls: 2, hv: 3, startingOwner: null, coastal: false },
  { id: "alexandria", name: "Alexandria", region: "Levant & Egypt", terrain: TerrainType.COAST, yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 2, hv: 3, startingOwner: null, coastal: true },
  { id: "cyprus", name: "Cyprus", region: "Levant & Egypt", terrain: TerrainType.COAST, yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 2, hv: null, startingOwner: null, coastal: true },
  { id: "rhodes", name: "Rhodes", region: "Greece & Aegean", terrain: TerrainType.COAST, yields: { gold: 2, grain: 0, timber: 0, marble: 0, faith: 1 }, port: "Y", walls: 3, hv: null, startingOwner: null, coastal: true },
  { id: "chios", name: "Chios", region: "Greece & Aegean", terrain: TerrainType.COAST, yields: { gold: 2, grain: 0, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: "Genoa", coastal: true },
  { id: "lesbos", name: "Lesbos (Mytilene)", region: "Greece & Aegean", terrain: TerrainType.HILLS, yields: { gold: 1, grain: 0, timber: 2, marble: 0, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: "Genoa", coastal: true },
  { id: "lemnos", name: "Lemnos", region: "Greece & Aegean", terrain: TerrainType.PLAINS, yields: { gold: 0, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: "Byzantium", coastal: true },
  { id: "negroponte", name: "Negroponte (Euboea)", region: "Greece & Aegean", terrain: TerrainType.COAST, yields: { gold: 1, grain: 2, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 2, hv: null, startingOwner: "Venice", coastal: true },
  { id: "naxos", name: "Naxos", region: "Greece & Aegean", terrain: TerrainType.HILLS, yields: { gold: 2, grain: 0, timber: 0, marble: 1, faith: 0 }, port: "Y", walls: 1, hv: null, startingOwner: null, coastal: true },
  { id: "crete", name: "Crete (Candia)", region: "Greece & Aegean", terrain: TerrainType.HILLS, yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 2, hv: 3, startingOwner: "Venice", coastal: true },
  { id: "corfu", name: "Corfu", region: "Greece & Aegean", terrain: TerrainType.COAST, yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 2, hv: null, startingOwner: "Venice", coastal: true },
  { id: "kaffa", name: "Kaffa (Caffa)", region: "Black Sea", terrain: TerrainType.CITY, yields: { gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 }, port: "Y", walls: 2, hv: 3, startingOwner: "Genoa", coastal: true },
];

/** The 12 sea zones, in MAP.md §7 order. */
export const CANON_SEA_ZONES: readonly CanonSeaZone[] = [
  { id: "bosphorus", name: "Bosphorus" },
  { id: "sea-of-marmara", name: "Sea of Marmara" },
  { id: "aegean", name: "Aegean" },
  { id: "sea-of-crete", name: "Sea of Crete" },
  { id: "eastern-mediterranean", name: "Eastern Mediterranean" },
  { id: "ionian", name: "Ionian" },
  { id: "adriatic", name: "Adriatic" },
  { id: "tyrrhenian", name: "Tyrrhenian" },
  { id: "sicilian-channel", name: "Sicilian Channel" },
  { id: "black-sea-west", name: "Black Sea West" },
  { id: "black-sea-east", name: "Black Sea East" },
  { id: "sea-of-azov", name: "Sea of Azov" },
];

/**
 * Symmetric adjacency over all 67 ids. Province rows list land
 * neighbors (straits included) then bordering sea zones; sea rows
 * list connected zones then coastal provinces. MAP.md §6/§7 order.
 */
export const CANON_ADJACENCY: Readonly<Record<string, readonly string[]>> = {
  "constantinople": ["selymbria", "pera", "bithynia", "bosphorus", "sea-of-marmara"],
  "selymbria": ["constantinople", "edirne", "sea-of-marmara"],
  "pera": ["constantinople", "bosphorus"],
  "edirne": ["selymbria", "philippopolis", "gallipoli", "thessalonica"],
  "gallipoli": ["edirne", "sea-of-marmara", "aegean"],
  "philippopolis": ["edirne", "sofia", "varna"],
  "sofia": ["philippopolis", "serbia", "thessalonica"],
  "varna": ["philippopolis", "wallachia", "black-sea-west"],
  "wallachia": ["varna", "serbia", "transylvania", "belgrade", "black-sea-west"],
  "serbia": ["sofia", "bosnia", "belgrade", "wallachia", "albania"],
  "bosnia": ["serbia", "croatia", "dalmatia", "ragusa", "belgrade"],
  "albania": ["serbia", "epirus", "ragusa", "ionian"],
  "epirus": ["albania", "thessaly", "ionian"],
  "thessaly": ["epirus", "thessalonica", "athens", "aegean"],
  "thessalonica": ["edirne", "sofia", "thessaly", "aegean"],
  "athens": ["thessaly", "morea", "aegean"],
  "morea": ["athens", "modon", "aegean", "sea-of-crete", "ionian"],
  "modon": ["morea", "sea-of-crete", "ionian"],
  "venice": ["milan", "adriatic"],
  "milan": ["venice", "genoa", "rome"],
  "genoa": ["milan", "rome", "tyrrhenian"],
  "rome": ["milan", "genoa", "naples", "tyrrhenian"],
  "naples": ["rome", "sicily", "tyrrhenian", "ionian"],
  "sicily": ["naples", "tyrrhenian", "sicilian-channel", "ionian"],
  "tunis": ["sicilian-channel", "eastern-mediterranean"],
  "dalmatia": ["croatia", "bosnia", "ragusa", "adriatic"],
  "ragusa": ["dalmatia", "bosnia", "albania", "adriatic", "ionian"],
  "croatia": ["buda", "dalmatia", "bosnia"],
  "buda": ["belgrade", "transylvania", "croatia"],
  "belgrade": ["buda", "serbia", "bosnia", "wallachia"],
  "transylvania": ["buda", "wallachia"],
  "bithynia": ["constantinople", "bursa", "nicaea", "bosphorus", "sea-of-marmara"],
  "bursa": ["bithynia", "nicaea", "smyrna", "ankara", "sea-of-marmara"],
  "nicaea": ["bithynia", "bursa", "ankara"],
  "ankara": ["nicaea", "bursa", "konya", "kastamonu"],
  "konya": ["ankara", "antalya", "aleppo", "smyrna"],
  "kastamonu": ["ankara", "sinope", "black-sea-east"],
  "sinope": ["kastamonu", "trebizond", "black-sea-east"],
  "smyrna": ["bursa", "konya", "aegean"],
  "antalya": ["konya", "eastern-mediterranean"],
  "trebizond": ["sinope", "black-sea-east"],
  "aleppo": ["konya", "antioch", "cairo"],
  "antioch": ["aleppo", "eastern-mediterranean"],
  "cairo": ["aleppo", "alexandria"],
  "alexandria": ["cairo", "eastern-mediterranean"],
  "cyprus": ["eastern-mediterranean"],
  "rhodes": ["sea-of-crete", "eastern-mediterranean"],
  "chios": ["aegean"],
  "lesbos": ["aegean"],
  "lemnos": ["aegean"],
  "negroponte": ["aegean"],
  "naxos": ["aegean", "sea-of-crete"],
  "crete": ["sea-of-crete"],
  "corfu": ["ionian", "adriatic"],
  "kaffa": ["black-sea-west", "black-sea-east", "sea-of-azov"],
  "bosphorus": ["sea-of-marmara", "black-sea-west", "constantinople", "pera", "bithynia"],
  "sea-of-marmara": ["bosphorus", "aegean", "constantinople", "selymbria", "gallipoli", "bithynia", "bursa"],
  "aegean": ["sea-of-marmara", "sea-of-crete", "gallipoli", "lemnos", "lesbos", "chios", "smyrna", "thessalonica", "thessaly", "athens", "negroponte", "naxos", "morea"],
  "sea-of-crete": ["aegean", "eastern-mediterranean", "ionian", "crete", "naxos", "rhodes", "morea", "modon"],
  "eastern-mediterranean": ["sea-of-crete", "sicilian-channel", "rhodes", "cyprus", "antioch", "antalya", "alexandria", "tunis"],
  "ionian": ["sea-of-crete", "adriatic", "sicilian-channel", "tyrrhenian", "corfu", "epirus", "albania", "ragusa", "modon", "morea", "naples", "sicily"],
  "adriatic": ["ionian", "venice", "dalmatia", "ragusa", "corfu"],
  "tyrrhenian": ["ionian", "sicilian-channel", "genoa", "rome", "naples", "sicily"],
  "sicilian-channel": ["tyrrhenian", "ionian", "eastern-mediterranean", "sicily", "tunis"],
  "black-sea-west": ["bosphorus", "black-sea-east", "varna", "wallachia", "kaffa"],
  "black-sea-east": ["black-sea-west", "sea-of-azov", "sinope", "trebizond", "kastamonu", "kaffa"],
  "sea-of-azov": ["black-sea-east", "kaffa"],
};
