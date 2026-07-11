/**
 * Construction of a fresh {@link GameState} from a set of seated players,
 * projected onto the sample map in {@link mapData}.
 */
import {
  Faction,
  GamePhase,
  UnitType,
  type Army,
  type Card,
  type GameLogEntry,
  type GameState,
  type Player,
  type Province,
  type ResourceBundle,
} from "@imperium/shared";
import { PROVINCES, SEA_ZONES } from "./mapData.js";

/** Minimal descriptor needed to seat a player into a new game. */
export interface SeatInput {
  id: string;
  name: string;
  faction: Faction;
  isHost: boolean;
}

const STARTING_TREASURY: ResourceBundle = {
  gold: 10,
  grain: 8,
  timber: 4,
  stone: 4,
  faith: 2,
};

/** A zeroed unit record covering every {@link UnitType}. */
export function emptyUnits(): Record<UnitType, number> {
  const units = {} as Record<UnitType, number>;
  for (const type of Object.values(UnitType)) units[type] = 0;
  return units;
}

/**
 * Build the initial, ready-to-play state.
 *
 * - Provinces are owned by whichever seated player holds their starting
 *   faction; unclaimed factions leave their provinces neutral.
 * - Each seated player receives one starting army (a small garrison) at the
 *   first province they own, which is what {@link computeIncome} charges upkeep
 *   against.
 */
export function createInitialState(
  roomCode: string,
  seats: SeatInput[],
): GameState {
  const factionToPlayerId = new Map<Faction, string>();
  for (const seat of seats) factionToPlayerId.set(seat.faction, seat.id);

  const provinces: Province[] = PROVINCES.map((p) => ({
    id: p.id,
    name: p.name,
    terrain: p.terrain,
    yields: { ...p.yields },
    coastal: p.coastal,
    position: { ...p.position },
    ownerId: p.startingFaction
      ? factionToPlayerId.get(p.startingFaction) ?? null
      : null,
  }));

  const players: Player[] = seats.map((seat) => ({
    id: seat.id,
    name: seat.name,
    faction: seat.faction,
    isHost: seat.isHost,
    connected: true,
    treasury: { ...STARTING_TREASURY },
    hand: [] as Card[],
  }));

  const armies: Army[] = [];
  for (const seat of seats) {
    const home = provinces.find((p) => p.ownerId === seat.id);
    if (!home) continue;
    const units = emptyUnits();
    units[UnitType.INFANTRY] = 2;
    units[UnitType.LEVY] = 1;
    armies.push({
      id: `army_${seat.id}`,
      ownerId: seat.id,
      locationId: home.id,
      units,
    });
  }

  const log: GameLogEntry[] = [
    {
      round: 1,
      phase: GamePhase.INCOME,
      type: "game_start",
      actors: seats.map((s) => s.id),
      message: `The game begins in room ${roomCode} with ${seats.length} rival powers.`,
      data: {
        factions: seats.map((s) => s.faction),
      },
    },
  ];

  return {
    roomCode,
    phase: GamePhase.INCOME,
    turn: 1,
    activePlayerIndex: 0,
    turnOrder: seats.map((s) => s.id),
    players,
    provinces,
    seaZones: SEA_ZONES.map((s) => ({ ...s, position: { ...s.position } })),
    armies,
    fleets: [],
    log,
  };
}
