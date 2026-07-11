/**
 * Hand-authored map: 56 land provinces + 12 sea zones covering the
 * Mediterranean/Balkans theater, 1400-1453. Historical plausibility over
 * precision. Adjacency is authored as edge lists and expanded symmetrically,
 * so it cannot be asymmetric by typo; validateMap() checks everything else.
 *
 * Wall tiers, starting holdings, treasuries, and garrisons are aligned to
 * the FINAL canon (2b42386): MAP.md walled-cities T1-T5 table and the
 * FACTIONS.md faction sheets, mapped onto this sim map's province set
 * (canon selymbria ~ mesembria, thessalonica ~ salonica, dalmatia ~ zara,
 * konya ~ karaman, kaffa ~ caffa; canon bithynia is folded into nicaea).
 * Non-canon filler provinces (friuli, tuscany, apulia, corsica, macedonia,
 * moldavia, vidin, nicopolis, slavonia, banat, upper_hungary) start
 * Independent with light walls.
 */

import type {
  Army,
  FactionId,
  FactionStart,
  Province,
  SeaZone,
  Terrain,
  TradeRoute,
  WallTier,
  Yields,
} from './types';
import { CONFIG } from './rules';
import { armyOf } from './combat';

// ------------------------------------------------------------- authoring

interface ProvinceSpec {
  name: string;
  owner: FactionId | null;
  terrain: Terrain;
  wall: WallTier;
  key?: boolean;
  /** [gold, grain, timber, marble, faith] */
  y: [number, number, number, number, number];
  /** Sea zones this province coasts (implies port when non-empty). */
  coasts?: string[];
}

const P: Record<string, ProvinceSpec> = {
  // ---- Italy ----
  // Venice's marble lives in Venetian Dalmatia (Istrian stone via Zara), not
  // on the safe lagoon: the great-work engine works from round 1 but its
  // source is a mainland border province rivals can actually contest.
  venice: { name: 'Venice', owner: 'venice', terrain: 'plains', wall: 3, key: true, y: [5, 1, 0, 1, 1], coasts: ['adriatic_north'] }, // marble 0 -> 1 (engine-reconciliation retune): canon §9.2 works need 6-12 marble — the round-91 "source from Dalmatia" trim assumed 4-marble generic works and starved Venice's work engine (win rate 3.3%), see TUNING_LOG
  friuli: { name: 'Friuli', owner: null, terrain: 'plains', wall: 0, y: [1, 2, 2, 0, 0], coasts: ['adriatic_north'] },
  milan: { name: 'Milan', owner: null, terrain: 'plains', wall: 2, y: [4, 3, 0, 0, 0] },
  genoa: { name: 'Genoa', owner: 'genoa', terrain: 'hills', wall: 3, key: true, y: [5, 1, 1, 1, 1], coasts: ['ligurian'] }, // marble 0 -> 1 (engine-reconciliation retune, same rationale as venice: canon §9.2 marble prices), see TUNING_LOG
  tuscany: { name: 'Tuscany', owner: null, terrain: 'hills', wall: 1, y: [3, 2, 0, 2, 0], coasts: ['ligurian'] },
  rome: { name: 'Rome', owner: null, terrain: 'plains', wall: 4, key: true, y: [3, 2, 0, 1, 2], coasts: ['tyrrhenian'] }, // canon T4 great fortress
  naples: { name: 'Naples', owner: null, terrain: 'plains', wall: 3, y: [3, 3, 0, 0, 0], coasts: ['tyrrhenian'] },
  apulia: { name: 'Apulia', owner: null, terrain: 'plains', wall: 0, y: [2, 3, 0, 0, 0], coasts: ['adriatic_south', 'ionian'] },
  sicily: { name: 'Sicily', owner: null, terrain: 'plains', wall: 2, y: [3, 4, 0, 0, 0], coasts: ['tyrrhenian', 'ionian'] },
  corsica: { name: 'Corsica', owner: null, terrain: 'mountains', wall: 0, y: [1, 1, 2, 1, 0], coasts: ['ligurian', 'tyrrhenian'] }, // non-canon filler; canon Genoa holds pera instead
  // ---- Western Balkans ----
  ragusa: { name: 'Ragusa', owner: null, terrain: 'hills', wall: 2, key: true, y: [4, 1, 0, 0, 0], coasts: ['adriatic_south'] },
  zara: { name: 'Zara', owner: 'venice', terrain: 'hills', wall: 1, y: [2, 1, 1, 1, 0], coasts: ['adriatic_north'] }, // canon dalmatia
  croatia: { name: 'Croatia', owner: 'hungary', terrain: 'hills', wall: 0, y: [1, 2, 1, 0, 0], coasts: ['adriatic_north'] },
  slavonia: { name: 'Slavonia', owner: null, terrain: 'plains', wall: 0, y: [1, 3, 0, 0, 0] },
  bosnia: { name: 'Bosnia', owner: null, terrain: 'mountains', wall: 1, y: [2, 1, 2, 0, 0] },
  serbia: { name: 'Serbia', owner: null, terrain: 'hills', wall: 2, y: [3, 2, 0, 0, 0] }, // canon T2 (Smederevo)
  albania: { name: 'Albania', owner: null, terrain: 'mountains', wall: 1, y: [1, 1, 0, 0, 0], coasts: ['adriatic_south'] },
  epirus: { name: 'Epirus', owner: null, terrain: 'mountains', wall: 0, y: [1, 1, 0, 0, 0], coasts: ['ionian'] },
  athens: { name: 'Athens', owner: null, terrain: 'plains', wall: 2, key: true, y: [2, 1, 0, 2, 1], coasts: ['aegean_south'] },
  morea: { name: 'Morea', owner: 'byzantium', terrain: 'hills', wall: 2, y: [2, 3, 0, 1, 0], coasts: ['ionian', 'sea_of_crete'] },
  modon: { name: 'Modon & Coron', owner: 'venice', terrain: 'hills', wall: 1, y: [2, 1, 0, 0, 0], coasts: ['ionian', 'sea_of_crete'] }, // canon Venetian modon
  // ---- Hungary & lower Danube ----
  buda: { name: 'Buda', owner: 'hungary', terrain: 'plains', wall: 3, key: true, y: [3, 3, 0, 0, 1] }, // gold 4 -> 3: final Hungary trim (30.7% -> band, see TUNING_LOG)
  belgrade: { name: 'Belgrade', owner: 'hungary', terrain: 'plains', wall: 4, y: [1, 2, 0, 0, 0] }, // canon T4 Danube fortress; marble 1 -> 0 (Hungary great-work trim, see TUNING_LOG)
  upper_hungary: { name: 'Upper Hungary', owner: null, terrain: 'mountains', wall: 0, y: [3, 1, 1, 1, 0] },
  transylvania: { name: 'Transylvania', owner: 'hungary', terrain: 'mountains', wall: 1, y: [2, 2, 2, 0, 0] },
  banat: { name: 'Banat', owner: null, terrain: 'plains', wall: 0, y: [1, 3, 0, 0, 0] },
  moldavia: { name: 'Moldavia', owner: null, terrain: 'plains', wall: 0, y: [1, 3, 0, 0, 0], coasts: ['black_sea_west'] },
  wallachia: { name: 'Wallachia', owner: null, terrain: 'plains', wall: 0, y: [2, 4, 0, 0, 0] }, // gold 1 -> 2 (retune r2): breaks the serbia/wallachia gold+grain tie so the Danube expansion order takes the unwalled breadbasket before T2 Smederevo — the alphabetical tie-break sent Hungary's FIRST conquest into 6 casualties at r3 (see TUNING_LOG)
  vidin: { name: 'Vidin', owner: null, terrain: 'hills', wall: 1, y: [1, 2, 0, 0, 0] },
  nicopolis: { name: 'Nicopolis', owner: null, terrain: 'plains', wall: 1, y: [1, 2, 0, 0, 0] },
  mesembria: { name: 'Mesembria', owner: 'byzantium', terrain: 'plains', wall: 1, y: [2, 3, 0, 0, 0], coasts: ['black_sea_west'] }, // canon selymbria (Byzantine buffer)
  // ---- Ottoman Balkans & Thrace ----
  sofia: { name: 'Sofia', owner: 'ottomans', terrain: 'hills', wall: 0, y: [2, 2, 0, 0, 0] },
  philippopolis: { name: 'Philippopolis', owner: 'ottomans', terrain: 'plains', wall: 0, y: [2, 3, 0, 0, 0] },
  macedonia: { name: 'Macedonia', owner: null, terrain: 'hills', wall: 0, y: [1, 2, 0, 0, 0] },
  // Salonica = canon thessalonica: Byzantine second city behind T3 walls.
  salonica: { name: 'Salonica', owner: 'byzantium', terrain: 'plains', wall: 3, key: true, y: [4, 2, 0, 0, 1], coasts: ['aegean_north'] },
  edirne: { name: 'Edirne', owner: 'ottomans', terrain: 'plains', wall: 3, key: true, y: [3, 3, 0, 0, 1] },
  gallipoli: { name: 'Gallipoli', owner: 'ottomans', terrain: 'plains', wall: 2, y: [2, 1, 0, 0, 0], coasts: ['aegean_north', 'sea_of_marmara'] },
  constantinople: { name: 'Constantinople', owner: 'byzantium', terrain: 'plains', wall: 5, key: true, y: [5, 2, 0, 1, 2], coasts: ['sea_of_marmara', 'black_sea_west'] }, // T5 Theodosian Walls
  pera: { name: 'Pera (Galata)', owner: 'genoa', terrain: 'plains', wall: 1, y: [2, 0, 0, 1, 0], coasts: ['sea_of_marmara', 'black_sea_west'] }, // canon Genoese enclave on the Horn; marble = Proconnesian entrepot — Genoa's great-work source lives on the warpath (parity with Venice's Zara); gold 3 -> 2 in the adversarial fix round (Genoa ceiling trim after the §5.2 blockade fix made trade income more robust)
  // ---- Anatolia ----
  bursa: { name: 'Bursa', owner: 'ottomans', terrain: 'plains', wall: 3, y: [4, 2, 0, 1, 0], coasts: ['sea_of_marmara'] }, // gold 3 -> 4 in the adversarial fix round (silk-road terminus; Ottoman floor re-lift after the §8.2.3 harbor fixes slowed the siege game)
  nicaea: { name: 'Nicaea', owner: 'ottomans', terrain: 'hills', wall: 2, y: [2, 2, 0, 0, 0] }, // canon nicaea + bithynia folded
  smyrna: { name: 'Smyrna', owner: null, terrain: 'plains', wall: 1, y: [3, 2, 0, 0, 0], coasts: ['aegean_south'] }, // canon Independent (Aydin beylik)
  ankara: { name: 'Ankara', owner: null, terrain: 'plains', wall: 1, y: [2, 2, 0, 0, 0] }, // canon Independent (Karaman league)
  karaman: { name: 'Karaman', owner: null, terrain: 'mountains', wall: 1, y: [2, 2, 0, 0, 0] }, // canon konya
  attaleia: { name: 'Attaleia', owner: null, terrain: 'hills', wall: 0, y: [2, 1, 1, 0, 0], coasts: ['eastern_med'] },
  sinope: { name: 'Sinope', owner: null, terrain: 'hills', wall: 1, y: [2, 1, 1, 0, 0], coasts: ['black_sea_east'] },
  // Trebizond: the Komnenos empire was separate from Constantinople — neutral key city.
  trebizond: { name: 'Trebizond', owner: null, terrain: 'mountains', wall: 3, key: true, y: [3, 1, 0, 0, 1], coasts: ['black_sea_east'] },
  // ---- Islands & overseas colonies ----
  crete: { name: 'Crete', owner: 'venice', terrain: 'hills', wall: 2, y: [3, 2, 0, 0, 0], coasts: ['sea_of_crete', 'eastern_med'] },
  negroponte: { name: 'Negroponte', owner: 'venice', terrain: 'plains', wall: 2, y: [2, 1, 0, 0, 0], coasts: ['aegean_south'] },
  corfu: { name: 'Corfu', owner: 'venice', terrain: 'hills', wall: 2, y: [2, 1, 0, 0, 0], coasts: ['ionian', 'adriatic_south'] },
  chios: { name: 'Chios', owner: 'genoa', terrain: 'hills', wall: 1, y: [2, 1, 0, 0, 0], coasts: ['aegean_south'] }, // gold 3 -> 2: colonial extraction trimmed (Genoa ran away on great works funded by an untouchable surplus)
  lesbos: { name: 'Lesbos', owner: 'genoa', terrain: 'hills', wall: 1, y: [2, 1, 0, 0, 0], coasts: ['aegean_north'] },
  lemnos: { name: 'Lemnos', owner: 'byzantium', terrain: 'plains', wall: 1, y: [1, 2, 0, 0, 0], coasts: ['aegean_north'] }, // canon Byzantine granary isle
  rhodes: { name: 'Rhodes', owner: null, terrain: 'hills', wall: 3, y: [2, 1, 0, 0, 2], coasts: ['aegean_south', 'eastern_med'] }, // canon T3 (Hospitallers)
  cyprus: { name: 'Cyprus', owner: null, terrain: 'plains', wall: 2, y: [3, 2, 1, 0, 0], coasts: ['eastern_med'] },
  caffa: { name: 'Caffa', owner: 'genoa', terrain: 'plains', wall: 2, y: [3, 2, 0, 0, 0], coasts: ['black_sea_east'] }, // canon kaffa; gold 4 -> 3 (same Genoa great-work trim as chios)
};

/** Land adjacency (symmetric; expanded below). */
const LAND_EDGES: Array<[string, string]> = [
  // Italy
  ['venice', 'friuli'], ['venice', 'milan'], ['milan', 'genoa'], ['milan', 'tuscany'],
  ['genoa', 'tuscany'], ['tuscany', 'rome'], ['rome', 'naples'], ['naples', 'apulia'],
  // Italy <-> western Balkans (land route around the head of the Adriatic)
  ['friuli', 'croatia'],
  // Western Balkans
  ['zara', 'croatia'], ['zara', 'bosnia'], ['croatia', 'slavonia'], ['croatia', 'bosnia'],
  ['slavonia', 'bosnia'], ['bosnia', 'serbia'], ['bosnia', 'ragusa'], ['ragusa', 'albania'],
  ['albania', 'serbia'], ['albania', 'epirus'], ['albania', 'macedonia'],
  ['epirus', 'macedonia'], ['epirus', 'athens'], ['athens', 'morea'], ['athens', 'salonica'],
  ['morea', 'modon'],
  // Hungary & Danube
  ['buda', 'upper_hungary'], ['buda', 'slavonia'], ['buda', 'banat'], ['buda', 'transylvania'],
  ['buda', 'belgrade'],
  ['belgrade', 'banat'], ['belgrade', 'serbia'], ['belgrade', 'bosnia'], ['belgrade', 'vidin'],
  ['upper_hungary', 'transylvania'], ['transylvania', 'moldavia'], ['transylvania', 'wallachia'],
  ['transylvania', 'banat'], ['banat', 'slavonia'], ['banat', 'serbia'], ['banat', 'wallachia'],
  ['serbia', 'vidin'], ['serbia', 'macedonia'], ['serbia', 'sofia'],
  ['vidin', 'wallachia'], ['vidin', 'nicopolis'], ['vidin', 'sofia'],
  ['wallachia', 'moldavia'], ['wallachia', 'nicopolis'],
  ['nicopolis', 'mesembria'], ['nicopolis', 'sofia'], ['nicopolis', 'philippopolis'],
  ['mesembria', 'constantinople'], ['mesembria', 'edirne'],
  // Ottoman Balkans & Thrace
  ['sofia', 'philippopolis'], ['sofia', 'macedonia'],
  ['philippopolis', 'edirne'], ['philippopolis', 'macedonia'],
  ['macedonia', 'salonica'],
  ['edirne', 'gallipoli'], ['edirne', 'constantinople'],
  ['constantinople', 'pera'], // Golden Horn (canon: adjacent city faces)
  // Anatolia
  ['bursa', 'nicaea'], ['bursa', 'smyrna'], ['nicaea', 'ankara'], ['nicaea', 'smyrna'],
  ['smyrna', 'attaleia'], ['attaleia', 'karaman'], ['karaman', 'ankara'],
  ['ankara', 'sinope'], ['sinope', 'trebizond'],
  // Bridge at Chalcis
  ['negroponte', 'athens'],
];

/**
 * Strait crossings: traversable land adjacencies across narrow water.
 * The full game applies CONFIG.combat.riverCrossingPenalty when attacking
 * across one, and may forbid crossing while an enemy fleet holds the zone.
 * Also included in normal adjacency below.
 */
export const STRAIT_EDGES: Array<[string, string]> = [
  ['gallipoli', 'bursa'], // Dardanelles
  ['constantinople', 'nicaea'], // Bosporus
];

interface SeaZoneSpec {
  name: string;
}

const S: Record<string, SeaZoneSpec> = {
  ligurian: { name: 'Ligurian Sea' },
  tyrrhenian: { name: 'Tyrrhenian Sea' },
  adriatic_north: { name: 'North Adriatic' },
  adriatic_south: { name: 'South Adriatic' },
  ionian: { name: 'Ionian Sea' },
  sea_of_crete: { name: 'Sea of Crete' },
  aegean_south: { name: 'South Aegean' },
  aegean_north: { name: 'North Aegean' },
  sea_of_marmara: { name: 'Sea of Marmara' },
  black_sea_west: { name: 'West Black Sea' },
  black_sea_east: { name: 'East Black Sea' },
  eastern_med: { name: 'Eastern Mediterranean' },
};

const SEA_EDGES: Array<[string, string]> = [
  ['ligurian', 'tyrrhenian'],
  ['tyrrhenian', 'ionian'],
  ['adriatic_north', 'adriatic_south'],
  ['adriatic_south', 'ionian'],
  ['ionian', 'sea_of_crete'],
  ['sea_of_crete', 'aegean_south'],
  ['sea_of_crete', 'eastern_med'],
  ['aegean_south', 'aegean_north'],
  ['aegean_south', 'eastern_med'],
  ['aegean_north', 'sea_of_marmara'],
  ['sea_of_marmara', 'black_sea_west'],
  ['black_sea_west', 'black_sea_east'],
];

// -------------------------------------------------------------- expansion

function buildProvinces(): Province[] {
  const out: Province[] = [];
  for (const [id, spec] of Object.entries(P)) {
    const [gold, grain, timber, marble, faith] = spec.y;
    const yields: Yields = { gold, grain, timber, marble, faith };
    out.push({
      id,
      name: spec.name,
      initialOwner: spec.owner,
      terrain: spec.terrain,
      wallTier: spec.wall,
      theodosianWalls: id === 'constantinople',
      keyCity: spec.key === true,
      port: (spec.coasts?.length ?? 0) > 0,
      yields,
      adjacentProvinces: [],
      coasts: spec.coasts ? [...spec.coasts] : [],
    });
  }
  return out;
}

export const PROVINCES: Province[] = buildProvinces();
export const PROVINCE_BY_ID: ReadonlyMap<string, Province> = new Map(
  PROVINCES.map((p) => [p.id, p]),
);

for (const [a, b] of [...LAND_EDGES, ...STRAIT_EDGES]) {
  const pa = PROVINCE_BY_ID.get(a);
  const pb = PROVINCE_BY_ID.get(b);
  if (!pa || !pb) throw new Error(`map.ts: land edge references unknown province: ${a}-${b}`);
  pa.adjacentProvinces.push(b);
  pb.adjacentProvinces.push(a);
}

export const SEA_ZONES: SeaZone[] = Object.entries(S).map(([id, spec]) => ({
  id,
  name: spec.name,
  adjacentZones: [],
  coastalProvinces: [],
}));
export const SEA_ZONE_BY_ID: ReadonlyMap<string, SeaZone> = new Map(
  SEA_ZONES.map((z) => [z.id, z]),
);

for (const [a, b] of SEA_EDGES) {
  const za = SEA_ZONE_BY_ID.get(a);
  const zb = SEA_ZONE_BY_ID.get(b);
  if (!za || !zb) throw new Error(`map.ts: sea edge references unknown zone: ${a}-${b}`);
  za.adjacentZones.push(b);
  zb.adjacentZones.push(a);
}

for (const p of PROVINCES) {
  for (const zid of p.coasts) {
    const z = SEA_ZONE_BY_ID.get(zid);
    if (!z) throw new Error(`map.ts: province ${p.id} coasts unknown zone ${zid}`);
    z.coastalProvinces.push(p.id);
  }
}

export const KEY_CITY_IDS: string[] = PROVINCES.filter((p) => p.keyCity).map((p) => p.id);

// ------------------------------------------------------------ trade routes

export const TRADE_ROUTES: TradeRoute[] = [
  { id: 'venice_constantinople', a: 'venice', b: 'constantinople', seaZones: ['adriatic_north', 'adriatic_south', 'ionian', 'sea_of_crete', 'aegean_south', 'aegean_north', 'sea_of_marmara'], income: 4 },
  { id: 'genoa_caffa', a: 'genoa', b: 'caffa', seaZones: ['ligurian', 'tyrrhenian', 'ionian', 'sea_of_crete', 'aegean_south', 'aegean_north', 'sea_of_marmara', 'black_sea_west', 'black_sea_east'], income: 3 },
  // Each maritime republic gets exactly ONE owned-both-ends route at setup
  // (venice_crete / genoa_caffa): the canon §13.1 monopoly +2/round is a
  // setup constant for them, and further monopolies must be conquered
  // (Genoa's old second freebie genoa_chios made it a +4/round runaway).
  { id: 'venice_crete', a: 'venice', b: 'crete', seaZones: ['adriatic_north', 'adriatic_south', 'ionian', 'sea_of_crete'], income: 4 },
  { id: 'chios_smyrna', a: 'chios', b: 'smyrna', seaZones: ['aegean_south'], income: 2 },
  { id: 'ragusa_venice', a: 'ragusa', b: 'venice', seaZones: ['adriatic_south', 'adriatic_north'], income: 2 },
  { id: 'crete_cyprus', a: 'crete', b: 'cyprus', seaZones: ['eastern_med'], income: 3 },
  { id: 'trebizond_caffa', a: 'trebizond', b: 'caffa', seaZones: ['black_sea_east'], income: 2 },
  // Overland caravan routes (R9 Option A, ratified): 60-75% of flagship sea
  // income (4). Army-blockade on the path is NOT modeled (routeBlockaded is
  // naval-only) — divergence noted in RULES_MODEL.md. The Buda corridors give
  // landlocked Hungary access to trade prestige/income. buda_belgrade is
  // the Danube run Hungary owns end-to-end at setup (its §13.1 monopoly,
  // parity with venice_crete / genoa_caffa) — but all Hungarian caravans sit
  // at the 60% floor of the R9 band (2 vs flagship sea 4 x 0.75 = 3) and
  // Belgrade yields no marble, or Hungary runs away (41-42%, TUNING_LOG).
  // (buda_ragusa removed: taking T2 Ragusa handed Hungary a cheap SECOND
  //  monopoly — its opportunist won 72% of seats that way, TUNING_LOG.)
  { id: 'buda_venice', a: 'buda', b: 'venice', seaZones: [], income: 2, overland: true },
  { id: 'buda_belgrade', a: 'buda', b: 'belgrade', seaZones: [], income: 2, overland: true },
  // Silk Road terminus at Bursa (Ottoman caravan trade).
  { id: 'bursa_ankara', a: 'bursa', b: 'ankara', seaZones: [], income: 4, overland: true },
];

// -------------------------------------------------------------- starts

/**
 * Starting treasuries and garrisons = the FINAL canon FACTIONS.md sheets
 * (2b42386), mapped onto the sim's 5-slot roster: inf / unique line
 * infantry / cavalry -> professional; war & merchant galleys -> galley.
 * Treasuries are the canon starting resource pools (gold/grain/timber/
 * marble/faith).
 */
export const FACTION_STARTS: Record<FactionId, FactionStart> = {
  byzantium: {
    treasury: { gold: 5, grain: 4, timber: 1, marble: 2, faith: 5 },
    garrisons: {
      constantinople: armyOf({ professional: 3, galley: 1 }), // 2 inf + Varangian Guard + war galley
      salonica: armyOf({ levy: 1, professional: 1 }),
      morea: armyOf({ levy: 1 }),
      lemnos: armyOf({ levy: 1 }),
      mesembria: armyOf({ levy: 1 }), // canon selymbria
    },
  },
  ottomans: {
    treasury: { gold: 6, grain: 7, timber: 3, marble: 3, faith: 2 },
    garrisons: {
      edirne: armyOf({ levy: 3, professional: 2 }), // 3 levy + cav + Ghazi Akinci
      bursa: armyOf({ levy: 2, professional: 1 }), // 2 levy + Janissary
      gallipoli: armyOf({ levy: 1, galley: 1 }),
      nicaea: armyOf({ levy: 1 }), // canon nicaea + bithynia folded
      sofia: armyOf({ levy: 1 }),
      philippopolis: armyOf({ levy: 1 }),
    },
  },
  venice: {
    treasury: { gold: 9, grain: 4, timber: 5, marble: 3, faith: 1 },
    garrisons: {
      venice: armyOf({ professional: 1, galley: 5 }), // 3 war + 2 merchant galleys + Stradioti
      crete: armyOf({ professional: 1, galley: 1 }),
      negroponte: armyOf({ galley: 1 }),
      corfu: armyOf({ galley: 1 }),
      modon: armyOf({ galley: 1 }),
      zara: armyOf({ levy: 1 }), // canon dalmatia
    },
  },
  genoa: {
    treasury: { gold: 8, grain: 3, timber: 4, marble: 3, faith: 1 },
    garrisons: {
      genoa: armyOf({ professional: 2, galley: 3 }), // 2 Crossbowmen + 2 war + 1 merchant galley
      chios: armyOf({ professional: 1, galley: 1 }),
      caffa: armyOf({ levy: 1, galley: 1 }), // canon kaffa
      pera: armyOf({ professional: 1 }),
      lesbos: armyOf({ levy: 1 }),
    },
  },
  hungary: {
    treasury: { gold: 6, grain: 6, timber: 5, marble: 4, faith: 3 },
    garrisons: {
      buda: armyOf({ levy: 2, professional: 2 }), // 2 levy + Black Army + cav
      belgrade: armyOf({ levy: 2, professional: 1 }), // fortress garrison behind T4 walls
      transylvania: armyOf({ levy: 2 }),
      croatia: armyOf({ levy: 1 }),
    },
  },
};

/** Setup garrison of a neutral province (minor powers defend themselves). */
export function neutralGarrison(p: Province): Army {
  const n = CONFIG.neutrals;
  return armyOf({
    levy: n.baseLevies + n.leviesPerWallTier * p.wallTier,
    professional: p.keyCity ? n.professionalsIfKeyCity : 0,
  });
}

// ------------------------------------------------------------- validation

/** Returns a list of problems (empty = map is consistent). */
export function validateMap(): string[] {
  const problems: string[] = [];
  const y = CONFIG.yields;
  const bounds: Array<[keyof Yields, readonly [number, number]]> = [
    ['gold', y.gold], ['grain', y.grain], ['timber', y.timber], ['marble', y.marble], ['faith', y.faith],
  ];
  for (const p of PROVINCES) {
    for (const [res, [lo, hi]] of bounds) {
      const v = p.yields[res];
      if (v < lo || v > hi) problems.push(`${p.id}: ${res} yield ${v} outside [${lo},${hi}]`);
    }
    if (p.keyCity && p.yields.gold < y.keyCityGoldMin) {
      problems.push(`${p.id}: key city gold ${p.yields.gold} < min ${y.keyCityGoldMin}`);
    }
    for (const a of p.adjacentProvinces) {
      const q = PROVINCE_BY_ID.get(a);
      if (!q) problems.push(`${p.id}: adjacent to unknown ${a}`);
      else if (!q.adjacentProvinces.includes(p.id)) problems.push(`${p.id}<->${a}: asymmetric adjacency`);
    }
    if (new Set(p.adjacentProvinces).size !== p.adjacentProvinces.length) {
      problems.push(`${p.id}: duplicate adjacency entries`);
    }
  }
  for (const z of SEA_ZONES) {
    for (const a of z.adjacentZones) {
      const q = SEA_ZONE_BY_ID.get(a);
      if (!q) problems.push(`${z.id}: adjacent to unknown zone ${a}`);
      else if (!q.adjacentZones.includes(z.id)) problems.push(`${z.id}<->${a}: asymmetric sea adjacency`);
    }
  }
  for (const r of TRADE_ROUTES) {
    for (const end of [r.a, r.b]) {
      const p = PROVINCE_BY_ID.get(end);
      if (!p) problems.push(`route ${r.id}: unknown endpoint ${end}`);
      else if (!r.overland && !p.port) problems.push(`route ${r.id}: endpoint ${end} is not a port`);
    }
    if (r.overland && r.seaZones.length > 0) {
      problems.push(`route ${r.id}: overland route must not have sea zones`);
    }
    for (let i = 0; i < r.seaZones.length; i++) {
      const z = SEA_ZONE_BY_ID.get(r.seaZones[i]);
      if (!z) { problems.push(`route ${r.id}: unknown zone ${r.seaZones[i]}`); continue; }
      if (i > 0 && !z.adjacentZones.includes(r.seaZones[i - 1])) {
        problems.push(`route ${r.id}: zones ${r.seaZones[i - 1]} -> ${r.seaZones[i]} not adjacent`);
      }
    }
  }
  for (const [fid, start] of Object.entries(FACTION_STARTS) as Array<[FactionId, FactionStart]>) {
    for (const pid of Object.keys(start.garrisons)) {
      const p = PROVINCE_BY_ID.get(pid);
      if (!p) problems.push(`${fid}: garrison in unknown province ${pid}`);
      else if (p.initialOwner !== fid) problems.push(`${fid}: garrison in ${pid} owned by ${p.initialOwner}`);
    }
  }
  return problems;
}
