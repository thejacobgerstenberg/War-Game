/**
 * TEST-ONLY env knobs (docs/ARCHITECTURE.md, Operations — env-var table):
 * `GAME_SEED` (deterministic RNG seed override) and `PRESTIGE_TARGET`
 * (victory-threshold override carried as `GameState.prestigeTarget`). Both are
 * resolved in `LobbyManager.startGame` so the engine stays pure; both default
 * off and ignore garbage values.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Faction } from "@imperium/shared";
import {
  gameSeedFromEnv,
  prestigeTargetFromEnv,
  LobbyManager,
} from "../lobbyManager.js";

const ENV_KEYS = ["GAME_SEED", "PRESTIGE_TARGET"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** Create → join → pick factions → start a 2-player game; returns the state. */
function startTwoPlayerGame(lobby = new LobbyManager()) {
  const { room, player: host } = lobby.createGame("Basil");
  const { player: guest } = lobby.joinGame(room.code, "Murad");
  lobby.pickFaction(room.code, host.id, Faction.BYZANTIUM);
  lobby.pickFaction(room.code, guest.id, Faction.OTTOMAN);
  return lobby.startGame(room.code, host.id).state;
}

describe("gameSeedFromEnv", () => {
  it("returns null when GAME_SEED is unset or blank", () => {
    expect(gameSeedFromEnv({})).toBeNull();
    expect(gameSeedFromEnv({ GAME_SEED: "  " })).toBeNull();
  });

  it("parses a valid 32-bit unsigned integer", () => {
    expect(gameSeedFromEnv({ GAME_SEED: "0" })).toBe(0);
    expect(gameSeedFromEnv({ GAME_SEED: "424242" })).toBe(424242);
    expect(gameSeedFromEnv({ GAME_SEED: "4294967295" })).toBe(0xffffffff);
  });

  it("ignores garbage / out-of-range values (crypto-random fallback)", () => {
    expect(gameSeedFromEnv({ GAME_SEED: "banana" })).toBeNull();
    expect(gameSeedFromEnv({ GAME_SEED: "-1" })).toBeNull();
    expect(gameSeedFromEnv({ GAME_SEED: "4294967296" })).toBeNull();
    expect(gameSeedFromEnv({ GAME_SEED: "1.5" })).toBeNull();
  });
});

describe("prestigeTargetFromEnv", () => {
  it("returns null when PRESTIGE_TARGET is unset or blank", () => {
    expect(prestigeTargetFromEnv({})).toBeNull();
    expect(prestigeTargetFromEnv({ PRESTIGE_TARGET: "" })).toBeNull();
  });

  it("parses a positive integer", () => {
    expect(prestigeTargetFromEnv({ PRESTIGE_TARGET: "8" })).toBe(8);
    expect(prestigeTargetFromEnv({ PRESTIGE_TARGET: "72" })).toBe(72);
  });

  it("ignores garbage / non-positive values (ratified thresholds used)", () => {
    expect(prestigeTargetFromEnv({ PRESTIGE_TARGET: "0" })).toBeNull();
    expect(prestigeTargetFromEnv({ PRESTIGE_TARGET: "-5" })).toBeNull();
    expect(prestigeTargetFromEnv({ PRESTIGE_TARGET: "lots" })).toBeNull();
    expect(prestigeTargetFromEnv({ PRESTIGE_TARGET: "7.5" })).toBeNull();
  });
});

describe("LobbyManager.startGame with test knobs", () => {
  it("GAME_SEED forces the game's rngSeed and makes games reproducible", () => {
    process.env.GAME_SEED = "424242";
    const a = startTwoPlayerGame();
    const b = startTwoPlayerGame();

    expect(a.rngSeed).toBe(424242);
    expect(b.rngSeed).toBe(424242);
    // Same seed → identical shuffles regardless of (random) room codes.
    expect(a.omenDeck).toEqual(b.omenDeck);
    expect(a.tacticDeck).toEqual(b.tacticDeck);
  });

  it("garbage GAME_SEED falls back to a crypto-random seed", () => {
    process.env.GAME_SEED = "banana";
    const state = startTwoPlayerGame();
    expect(Number.isInteger(state.rngSeed)).toBe(true);
    // Astronomically unlikely to collide with the poisoned value 0 twice;
    // the real assertion is simply "did not throw and produced a valid seed".
    expect(state.rngSeed).toBeGreaterThanOrEqual(0);
    expect(state.rngSeed).toBeLessThanOrEqual(0xffffffff);
  });

  it("PRESTIGE_TARGET rides on state as prestigeTarget", () => {
    process.env.PRESTIGE_TARGET = "8";
    const state = startTwoPlayerGame();
    expect(state.prestigeTarget).toBe(8);
  });

  it("without the knobs, prestigeTarget is absent and the seed is random", () => {
    const state = startTwoPlayerGame();
    expect(state.prestigeTarget).toBeUndefined();
    expect(Number.isInteger(state.rngSeed)).toBe(true);
  });
});
