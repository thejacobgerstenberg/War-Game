/**
 * Construction of a fresh {@link GameState} from a set of seated players,
 * projected onto the sample map in {@link mapData}.
 *
 * This constructor initialises every growth field (RNG, prestige, objectives,
 * treaties, minors, merc market, Omen decks, wall/building/great-work province
 * fields, and the monotonic counters) so the engine subsystems have a complete,
 * typed state to build against. The Data phase swaps in the canonical map,
 * faction rosters and minor garrisons using the same shapes.
 */
import {
  Faction,
  GamePhase,
  TaxPosture,
  UnitType,
  type Card,
  type GameState,
  type Player,
  type Province,
  type Treaty,
} from "@imperium/shared";
import { NPC_MINORS, PROVINCES, SEA_ZONES } from "./mapData.js";
import {
  ACTIONS_PER_ROUND,
  FACTION_STARTING_RESOURCES,
} from "./balance.js";
import {
  buildFactionForces,
  startingObjectives,
  startingWallState,
} from "./factions.js";
import { OMEN_CARDS_BY_ERA } from "./events/cards.js";
import { makeRng } from "./rng.js";
import { appendLog } from "./logEntry.js";

/** Minimal descriptor needed to seat a player into a new game. */
export interface SeatInput {
  id: string;
  name: string;
  faction: Faction;
  isHost: boolean;
}

/** A zeroed unit record covering every {@link UnitType}. */
export function emptyUnits(): Record<UnitType, number> {
  const units = {} as Record<UnitType, number>;
  for (const type of Object.values(UnitType)) units[type] = 0;
  return units;
}

/**
 * Deterministic 32-bit hash of a string, used to derive a stable default seed
 * from the room code when no explicit seed is supplied (keeps the engine pure —
 * no Math.random). Same room code → same game.
 */
function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Build the initial, ready-to-play state.
 *
 * - Provinces are owned by whichever seated player holds their starting
 *   faction; unclaimed factions leave their provinces neutral.
 * - Each seated player receives one starting army (a small garrison) at the
 *   first province they own, which is what income/upkeep charges against.
 * - `seed` drives all determinism; when omitted it is derived from `roomCode`.
 */
export function createInitialState(
  roomCode: string,
  seats: SeatInput[],
  seed?: number,
): GameState {
  const rngSeed = seed ?? hashSeed(roomCode);

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
    // Walls (and garrison/highValue/isCapitalOf/minorId) are authored on the
    // canonical map (docs/MAP.md); fall back to the faction's Theodosian-tier
    // data only if the map omits them, then to unwalled.
    walls: p.walls
      ? { ...p.walls }
      : p.startingFaction
        ? startingWallState(p.startingFaction, p.id)
        : { tier: 0, hp: 0 },
    buildings: [],
    greatWorks: [],
    ...(p.siege ? { siege: p.siege } : {}),
    ...(p.garrison !== undefined ? { garrison: p.garrison } : {}),
    ...(p.isCapitalOf ? { isCapitalOf: p.isCapitalOf } : {}),
    ...(p.highValue !== undefined ? { highValue: p.highValue } : {}),
    ...(p.minorId ? { minorId: p.minorId } : {}),
  }));

  const players: Player[] = seats.map((seat) => ({
    id: seat.id,
    name: seat.name,
    faction: seat.faction,
    isHost: seat.isHost,
    connected: true,
    treasury: { ...FACTION_STARTING_RESOURCES[seat.faction] },
    hand: [] as Card[],
    prestige: 0,
    objectives: startingObjectives(seat.faction),
    tax: TaxPosture.NORMAL,
    treaties: [] as Treaty[],
    vassals: [] as string[],
    betrayals: 0,
    actionsRemaining: ACTIONS_PER_ROUND,
  }));

  // Asymmetric starting armies & fleets per province (docs/FACTIONS.md), placed
  // by the factions helper. Forces whose province is absent from the current
  // board or not owned by the seated player are skipped.
  const { armies, fleets } = buildFactionForces(provinces, factionToPlayerId);

  // Seed the Omen deck for Era I (shuffled by the RNG); stash the later eras.
  const rng = makeRng(rngSeed, 0);
  const omenDeck = rng.shuffle(OMEN_CARDS_BY_ERA[1]);

  const base: GameState = {
    roomCode,
    phase: GamePhase.INCOME,
    turn: 1,
    round: 1,
    era: 1,
    activePlayerIndex: 0,
    turnOrder: seats.map((s) => s.id),
    players,
    provinces,
    seaZones: SEA_ZONES.map((s) => ({ ...s, position: { ...s.position } })),
    armies,
    fleets,
    omenDeck,
    omenDiscard: [],
    eraDecksRemaining: {
      2: [...OMEN_CARDS_BY_ERA[2]],
      3: [...OMEN_CARDS_BY_ERA[3]],
    },
    mercMarket: [],
    minors: NPC_MINORS.map((m) => ({ ...m, provinceIds: [...m.provinceIds] })),
    pendingBattles: [],
    siegeStates: [],
    constantinopleHold: { faction: null, rounds: 0 },
    rngSeed,
    rngCursor: rng.cursor,
    logCounter: 0,
    clock: 0,
    log: [],
  };

  // The one existing game_start entry, now id- and timestamp-stamped.
  return appendLog(base, {
    round: 1,
    phase: GamePhase.INCOME,
    type: "game_start",
    actors: seats.map((s) => s.id),
    message: `The game begins in room ${roomCode} with ${seats.length} rival powers.`,
    data: {
      factions: seats.map((s) => s.faction),
      seed: rngSeed,
    },
  });
}
