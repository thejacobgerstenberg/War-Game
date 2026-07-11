/**
 * Demo fixture for the /board-demo route: 5 seated factions with a
 * MAP.md-plausible opening translated onto the board.svg region id scheme
 * (the SVG uses geographic regions, not MAP.md's city-based canon ids).
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
  stone: number,
  faith: number,
): ResourceBundle {
  return { gold, grain, timber, stone, faith };
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
 * Starting ownership, docs/MAP.md §4 "Starting Ownership Summary"
 * (lines 140–146) mapped to SVG regions:
 * - Byzantium (MAP.md:142): constantinople/selymbria → thrace,
 *   thessalonica → macedonia, morea → morea.
 * - Ottomans (MAP.md:143): bithynia/bursa/nicaea → bithynia,
 *   philippopolis/sofia → bulgaria; phrygia + galatia stand in for the
 *   early Ottoman Anatolian heartland.
 * - Venice (MAP.md:144): venice → venetia, dalmatia → dalmatia,
 *   crete → crete, negroponte → euboea.
 * - Genoa (MAP.md:145): genoa → liguria, kaffa → crimea; corsica was a
 *   Genoese possession in period.
 * - Hungary (MAP.md:146): buda → hungary, croatia → croatia,
 *   transylvania → transylvania; belgrade's march → slavonia.
 * Everything else starts Independent (ownerId null), per MAP.md §5.
 */
const OWNER_BY_PROVINCE: Readonly<Record<string, string>> = {
  thrace: "p-byzantium",
  macedonia: "p-byzantium",
  morea: "p-byzantium",
  bithynia: "p-ottoman",
  bulgaria: "p-ottoman",
  phrygia: "p-ottoman",
  galatia: "p-ottoman",
  venetia: "p-venice",
  dalmatia: "p-venice",
  crete: "p-venice",
  euboea: "p-venice",
  liguria: "p-genoa",
  corsica: "p-genoa",
  crimea: "p-genoa",
  hungary: "p-hungary",
  croatia: "p-hungary",
  transylvania: "p-hungary",
  slavonia: "p-hungary",
};

export function createDemoState(): DemoSetup {
  // Treasuries are the FACTIONS.md starting resources (g/gr/t/s/f).
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
  // never by Province.position (0–100 space, unused on the board).
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
      locationId: "thrace",
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
      id: "a-ott-2",
      ownerId: "p-ottoman",
      locationId: "bulgaria",
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
      locationId: "crimea",
      units: units({ [UnitType.LEVY]: 1, [UnitType.INFANTRY]: 1 }),
    },
    {
      id: "a-hun-1",
      ownerId: "p-hungary",
      locationId: "hungary",
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
      id: "f-ven-1",
      ownerId: "p-venice",
      locationId: "adriatic-sea",
      units: units({ [UnitType.GALLEY]: 2, [UnitType.WARSHIP]: 1 }),
    },
    {
      id: "f-gen-1",
      ownerId: "p-genoa",
      locationId: "ligurian-sea",
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

  // Siege of Constantinople, 1453 — MAP.md:54 ("Sudden-death objective");
  // constantinople sits in the SVG's thrace region.
  // Wall tiers, MAP.md §3: constantinople T5 (line 54) → thrace;
  // belgrade T4 (line 83) → serbia (its Danube frontier region here);
  // venice T3 (line 72) → venetia; genoa T3 (line 74) → liguria;
  // buda T3 (line 82) → hungary.
  const overlays: BoardOverlayState = {
    sieges: [{ provinceId: "thrace", besiegerFaction: Faction.OTTOMAN }],
    walls: { thrace: 5, serbia: 4, venetia: 3, liguria: 3, hungary: 3 },
  };

  return { gameState, overlays };
}
