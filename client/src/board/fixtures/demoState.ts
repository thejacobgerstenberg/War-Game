/**
 * Demo fixture for the /board-demo route: the five great powers seated with
 * their docs/MAP.md §4 "Starting Ownership Summary" holdings (MAP.md:157-169),
 * keyed by the canonical MAP.md province/sea-zone ids.
 * Returns fresh objects on every call — callers and tests mutate freely.
 */
import { Faction, GamePhase, UnitType } from "@imperium/shared";
import type {
  Army,
  Fleet,
  GameState,
  Player,
  Province,
  ResourceBundle,
} from "@imperium/shared";
import type { BoardOverlayState, DemoSetup } from "../types";
import { BOARD_PROVINCES, BOARD_SEA_ZONES } from "../mapData";

function bundle(
  gold: number,
  grain: number,
  timber: number,
  marble: number,
  faith: number,
): ResourceBundle {
  return { gold, grain, timber, marble, faith };
}

/** Fills all 7 UnitType keys so the Record<UnitType, number> shape is total. */
function units(partial: Partial<Record<UnitType, number>>): Record<UnitType, number> {
  return {
    [UnitType.LEVY]: 0,
    [UnitType.INFANTRY]: 0,
    [UnitType.CAVALRY]: 0,
    [UnitType.ARCHER]: 0,
    [UnitType.SIEGE]: 0,
    [UnitType.GALLEY]: 0,
    [UnitType.WARSHIP]: 0,
    ...partial,
  };
}

/**
 * Starting ownership, verbatim from docs/MAP.md §4 (lines 159-163):
 * - Byzantium (MAP.md:159): constantinople, selymbria, lemnos, thessalonica, morea
 * - Ottomans  (MAP.md:160): edirne, gallipoli, philippopolis, sofia, bithynia, bursa, nicaea
 * - Venice    (MAP.md:161): venice, dalmatia, corfu, negroponte, crete, modon
 * - Genoa     (MAP.md:162): genoa, pera, chios, lesbos, kaffa
 * - Hungary   (MAP.md:163): buda, belgrade, transylvania, croatia
 * The 28 remaining provinces start Independent (ownerId null), MAP.md:164-169.
 */
const OWNER_BY_PROVINCE: Readonly<Record<string, string>> = {
  constantinople: "p-byzantium",
  selymbria: "p-byzantium",
  lemnos: "p-byzantium",
  thessalonica: "p-byzantium",
  morea: "p-byzantium",
  edirne: "p-ottoman",
  gallipoli: "p-ottoman",
  philippopolis: "p-ottoman",
  sofia: "p-ottoman",
  bithynia: "p-ottoman",
  bursa: "p-ottoman",
  nicaea: "p-ottoman",
  venice: "p-venice",
  dalmatia: "p-venice",
  corfu: "p-venice",
  negroponte: "p-venice",
  crete: "p-venice",
  modon: "p-venice",
  genoa: "p-genoa",
  pera: "p-genoa",
  chios: "p-genoa",
  lesbos: "p-genoa",
  kaffa: "p-genoa",
  buda: "p-hungary",
  belgrade: "p-hungary",
  transylvania: "p-hungary",
  croatia: "p-hungary",
};

export function createDemoState(): DemoSetup {
  // Treasuries are the FACTIONS.md starting resources (g/gr/t/m/f).
  const players: Player[] = [
    {
      id: "p-byzantium",
      name: "Basileus",
      faction: Faction.BYZANTIUM,
      isHost: true,
      connected: true,
      treasury: bundle(5, 4, 1, 2, 5),
      hand: [],
    },
    {
      id: "p-ottoman",
      name: "Sultan",
      faction: Faction.OTTOMAN,
      isHost: false,
      connected: true,
      treasury: bundle(6, 7, 3, 3, 2),
      hand: [],
    },
    {
      id: "p-venice",
      name: "Doge of Venice",
      faction: Faction.VENICE,
      isHost: false,
      connected: true,
      treasury: bundle(9, 4, 5, 3, 1),
      hand: [],
    },
    {
      id: "p-genoa",
      name: "Doge of Genoa",
      faction: Faction.GENOA,
      isHost: false,
      connected: true,
      treasury: bundle(8, 3, 4, 3, 1),
      hand: [],
    },
    {
      id: "p-hungary",
      name: "King of Hungary",
      faction: Faction.HUNGARY,
      isHost: false,
      connected: true,
      treasury: bundle(6, 6, 5, 4, 3),
      hand: [],
    },
  ];

  // position is a placeholder: the Board places everything by SVG centroid,
  // never by Province.position (0-100 space, unused on the board).
  const provinces: Province[] = BOARD_PROVINCES.map((p) => ({
    id: p.id,
    name: p.name,
    terrain: p.terrain,
    yields: { ...p.yields },
    ownerId: OWNER_BY_PROVINCE[p.id] ?? null,
    coastal: p.coastal,
    position: { x: 50, y: 50 },
  }));

  const seaZones = BOARD_SEA_ZONES.map((s) => ({
    id: s.id,
    name: s.name,
    position: { x: 50, y: 50 },
  }));

  const armies: Army[] = [
    {
      id: "a-byz-1",
      ownerId: "p-byzantium",
      locationId: "constantinople",
      units: units({ [UnitType.INFANTRY]: 3, [UnitType.LEVY]: 1 }),
    },
    {
      id: "a-byz-2",
      ownerId: "p-byzantium",
      locationId: "morea",
      units: units({ [UnitType.LEVY]: 1 }),
    },
    {
      id: "a-ott-1",
      ownerId: "p-ottoman",
      locationId: "bithynia",
      units: units({ [UnitType.LEVY]: 2, [UnitType.INFANTRY]: 1, [UnitType.CAVALRY]: 1 }),
    },
    {
      // The siege train mustered at the Ottoman European capital
      // (edirne, MAP.md:74) for the siege of Constantinople below.
      id: "a-ott-2",
      ownerId: "p-ottoman",
      locationId: "edirne",
      units: units({ [UnitType.LEVY]: 3, [UnitType.SIEGE]: 1 }),
    },
    {
      id: "a-ven-1",
      ownerId: "p-venice",
      locationId: "crete",
      units: units({ [UnitType.INFANTRY]: 1 }),
    },
    {
      id: "a-gen-1",
      ownerId: "p-genoa",
      locationId: "kaffa",
      units: units({ [UnitType.LEVY]: 1, [UnitType.INFANTRY]: 1 }),
    },
    {
      id: "a-hun-1",
      ownerId: "p-hungary",
      locationId: "buda",
      units: units({ [UnitType.LEVY]: 2, [UnitType.INFANTRY]: 1, [UnitType.CAVALRY]: 1 }),
    },
    {
      id: "a-hun-2",
      ownerId: "p-hungary",
      locationId: "croatia",
      units: units({ [UnitType.LEVY]: 1 }),
    },
  ];

  const fleets: Fleet[] = [
    {
      // Venice's home water — "the Gulf", MAP.md:289.
      id: "f-ven-1",
      ownerId: "p-venice",
      locationId: "adriatic",
      units: units({ [UnitType.GALLEY]: 2, [UnitType.WARSHIP]: 1 }),
    },
    {
      // Genoa guards the Bosphorus chokepoint off Pera (MAP.md:283).
      id: "f-gen-1",
      ownerId: "p-genoa",
      locationId: "bosphorus",
      units: units({ [UnitType.WARSHIP]: 2 }),
    },
  ];

  const gameState: GameState = {
    roomCode: "DEMO1",
    phase: GamePhase.MOVEMENT,
    turn: 3,
    activePlayerIndex: 0,
    turnOrder: ["p-byzantium", "p-ottoman", "p-venice", "p-genoa", "p-hungary"],
    players,
    provinces,
    seaZones,
    armies,
    fleets,
    log: [],
  };

  // Siege of Constantinople, 1453 — MAP.md:71 ("Sudden-death objective").
  // Wall tiers from MAP.md §3 quick reference (lines 143-145):
  // T5 constantinople; T4 belgrade, rome; T3 venice, genoa, buda.
  const overlays: BoardOverlayState = {
    sieges: [{ provinceId: "constantinople", besiegerFaction: Faction.OTTOMAN }],
    walls: { constantinople: 5, belgrade: 4, rome: 4, venice: 3, genoa: 3, buda: 3 },
  };

  return { gameState, overlays };
}
