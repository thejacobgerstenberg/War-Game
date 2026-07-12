/**
 * Lobby bot-seat hook tests: host-only add/remove, ruler naming, faction
 * assignment, reaper interaction (bot seats never keep a room alive), and
 * the BOT_TAKEOVER_ROUNDS abandoned-seat countdown.
 */
import { describe, expect, it } from "vitest";
import { Faction } from "@imperium/shared";
import { LobbyError, LobbyManager, type Room } from "../lobbyManager.js";
import {
  BotRoster,
  botTakeoverRoundsFromEnv,
  makeBotConfig,
} from "../botSeats.js";
import { Difficulty } from "../../bots/types.js";

/** A lobby with a host (+ optional second human), plus a roster. */
function setup(withSecondHuman = true) {
  let nowMs = 1_000_000;
  const lobby = new LobbyManager({ now: () => nowMs });
  const advance = (ms: number): void => {
    nowMs += ms;
  };
  const { room, player: host } = lobby.createGame("Alice");
  const guest = withSecondHuman
    ? lobby.joinGame(room.code, "Bob").player
    : null;
  const roster = new BotRoster();
  return { lobby, room, host, guest, roster, advance };
}

describe("botSeats — add_bot", () => {
  it("host seats a bot named after the first unclaimed faction's ruler", () => {
    const { room, host, roster } = setup();
    const bot = roster.addBot(room, host.id, Difficulty.EASY);

    expect(bot.isBot).toBe(true);
    expect(bot.isHost).toBe(false);
    expect(bot.connected).toBe(true);
    expect(bot.faction).toBe(Faction.BYZANTIUM); // first unclaimed, enum order
    expect(bot.name).toBe("John VIII Palaiologos");
    expect(room.players).toContain(bot);
    expect(roster.isBot(bot.id)).toBe(true);
    expect(roster.getSeat(bot.id)?.difficulty).toBe(Difficulty.EASY);
    expect(roster.getSeat(bot.id)?.viaTakeover).toBe(false);
  });

  it("skips factions already claimed by players", () => {
    const { lobby, room, host, roster } = setup();
    lobby.pickFaction(room.code, host.id, Faction.BYZANTIUM);
    const bot = roster.addBot(room, host.id, Difficulty.NORMAL);
    expect(bot.faction).toBe(Faction.OTTOMAN);
    expect(bot.name).toBe("Murad II");
  });

  it("suffixes the ruler name when a human already took it", () => {
    let nowMs = 0;
    const lobby = new LobbyManager({ now: () => nowMs++ });
    const { room, player: host } = lobby.createGame("Murad II");
    lobby.pickFaction(room.code, host.id, Faction.BYZANTIUM);
    const roster = new BotRoster();
    const bot = roster.addBot(room, host.id, Difficulty.NORMAL);
    expect(bot.faction).toBe(Faction.OTTOMAN);
    expect(bot.name).toBe("Murad II (AI)");
  });

  it("is host-only", () => {
    const { room, guest, roster } = setup();
    expect(() => roster.addBot(room, guest!.id, Difficulty.EASY)).toThrow(
      LobbyError,
    );
    expect(() => roster.addBot(room, "not-seated", Difficulty.EASY)).toThrow(
      LobbyError,
    );
    expect(roster.botsInRoom(room)).toHaveLength(0);
  });

  it("is rejected after the game has started", () => {
    const { lobby, room, host, roster } = setup();
    lobby.startGame(room.code, host.id);
    expect(() => roster.addBot(room, host.id, Difficulty.HARD)).toThrow(
      /before the game starts/,
    );
  });

  it("respects the room's max-seat limit", () => {
    const { room, host, roster } = setup();
    // 2 humans + 3 bots = 5 seats (the max).
    roster.addBot(room, host.id, Difficulty.EASY);
    roster.addBot(room, host.id, Difficulty.EASY);
    roster.addBot(room, host.id, Difficulty.EASY);
    expect(room.players).toHaveLength(5);
    expect(() => roster.addBot(room, host.id, Difficulty.EASY)).toThrow(
      /full/,
    );
  });

  it("bot seats become real engine seats via the normal startGame path", () => {
    const { lobby, room, host, roster } = setup();
    const bot = roster.addBot(room, host.id, Difficulty.NORMAL);
    const { state } = lobby.startGame(room.code, host.id);
    const enginePlayer = state.players.find((p) => p.id === bot.id);
    expect(enginePlayer).toBeDefined();
    expect(enginePlayer?.faction).toBe(bot.faction);
    expect(enginePlayer?.isHost).toBe(false);
  });

  it("marks bot seats in the lobby_update wire projection", () => {
    const { room, host, roster } = setup();
    const bot = roster.addBot(room, host.id, Difficulty.NORMAL);
    const update = LobbyManager.toLobbyUpdate(room);
    const botRow = update.players.find((p) => p.id === bot.id);
    const humanRow = update.players.find((p) => p.id === host.id);
    expect(botRow?.isBot).toBe(true);
    expect(humanRow?.isBot).toBeUndefined();
    // sessionToken must never leak onto the wire.
    expect(JSON.stringify(update)).not.toContain(bot.sessionToken);
  });
});

describe("botSeats — remove_bot", () => {
  it("host removes a bot seat", () => {
    const { room, host, roster } = setup();
    const bot = roster.addBot(room, host.id, Difficulty.EASY);
    roster.removeBot(room, host.id, bot.id);
    expect(room.players.find((p) => p.id === bot.id)).toBeUndefined();
    expect(roster.isBot(bot.id)).toBe(false);
  });

  it("is host-only and only removes actual bots", () => {
    const { room, host, guest, roster } = setup();
    const bot = roster.addBot(room, host.id, Difficulty.EASY);
    expect(() => roster.removeBot(room, guest!.id, bot.id)).toThrow(
      /Only the host/,
    );
    expect(() => roster.removeBot(room, host.id, guest!.id)).toThrow(
      /not a bot/,
    );
    expect(room.players.find((p) => p.id === bot.id)).toBeDefined();
  });

  it("is rejected after the game has started", () => {
    const { lobby, room, host, roster } = setup();
    const bot = roster.addBot(room, host.id, Difficulty.EASY);
    lobby.startGame(room.code, host.id);
    expect(() => roster.removeBot(room, host.id, bot.id)).toThrow(LobbyError);
  });
});

describe("botSeats — reaper interaction", () => {
  it("a room whose only connected seats are bots counts as empty", () => {
    const { lobby, room, host, guest, roster, advance } = setup();
    roster.addBot(room, host.id, Difficulty.NORMAL);

    expect(room.emptySince).toBeNull();
    lobby.markDisconnected(host.id);
    lobby.markDisconnected(guest!.id);
    // Both humans gone: the still-"connected" bot must not hold the room.
    expect(room.emptySince).not.toBeNull();

    advance(3600 * 1000);
    expect(lobby.reapEmptyRooms(3600)).toContain(room.code);
  });
});

describe("botSeats — abandoned-seat takeover (BOT_TAKEOVER_ROUNDS)", () => {
  function startedRoom() {
    const ctx = setup();
    ctx.lobby.startGame(ctx.room.code, ctx.host.id);
    return ctx;
  }

  function setRound(room: Room, round: number): void {
    room.state = { ...room.state!, round };
  }

  it("takes over a human seat after N rounds disconnected, as a NORMAL bot", () => {
    const { lobby, room, guest, roster } = startedRoom();
    lobby.markDisconnected(guest!.id);

    // Round 1: countdown starts, no takeover yet.
    expect(roster.evaluateTakeovers(room, 2).takenOver).toEqual([]);
    // Round 2: only 1 full round elapsed — still held.
    setRound(room, 2);
    expect(roster.evaluateTakeovers(room, 2).takenOver).toEqual([]);
    // Round 3: 2 full rounds elapsed — the bot takes the seat.
    setRound(room, 3);
    const sweep = roster.evaluateTakeovers(room, 2);
    expect(sweep.takenOver).toEqual([guest!.id]);

    expect(roster.isBot(guest!.id)).toBe(true);
    expect(roster.getSeat(guest!.id)).toMatchObject({
      difficulty: Difficulty.NORMAL,
      viaTakeover: true,
    });
    expect(room.players.find((p) => p.id === guest!.id)?.isBot).toBe(true);
  });

  it("releases the seat back when the human rejoins", () => {
    const { lobby, room, guest, roster } = startedRoom();
    lobby.markDisconnected(guest!.id);
    roster.evaluateTakeovers(room, 1);
    setRound(room, 2);
    expect(roster.evaluateTakeovers(room, 1).takenOver).toEqual([guest!.id]);

    // Human reclaims the seat (sessionToken path works after start).
    lobby.rejoinGame(room.code, guest!.sessionToken);
    const sweep = roster.evaluateTakeovers(room, 1);
    expect(sweep.released).toEqual([guest!.id]);
    expect(roster.isBot(guest!.id)).toBe(false);
    expect(room.players.find((p) => p.id === guest!.id)?.isBot).toBe(false);
  });

  it("a reconnect before the deadline clears the countdown", () => {
    const { lobby, room, guest, roster } = startedRoom();
    lobby.markDisconnected(guest!.id);
    roster.evaluateTakeovers(room, 2); // countdown starts at round 1
    lobby.reconnect(guest!.id);
    roster.evaluateTakeovers(room, 2); // clears the countdown
    lobby.markDisconnected(guest!.id);
    setRound(room, 5);
    roster.evaluateTakeovers(room, 2); // countdown RESTARTS at round 5
    setRound(room, 6);
    expect(roster.evaluateTakeovers(room, 2).takenOver).toEqual([]);
    setRound(room, 7);
    expect(roster.evaluateTakeovers(room, 2).takenOver).toEqual([guest!.id]);
  });

  it("is disabled when the config is null (env unset)", () => {
    const { lobby, room, guest, roster } = startedRoom();
    lobby.markDisconnected(guest!.id);
    roster.evaluateTakeovers(room, null);
    setRound(room, 16);
    const sweep = roster.evaluateTakeovers(room, null);
    expect(sweep.takenOver).toEqual([]);
    expect(roster.isBot(guest!.id)).toBe(false);
  });

  it("never counts down host-added bots or unstarted rooms", () => {
    const { room, host, roster } = setup();
    const bot = roster.addBot(room, host.id, Difficulty.HARD);
    // Unstarted room: sweep is a no-op.
    expect(roster.evaluateTakeovers(room, 1)).toEqual({
      takenOver: [],
      released: [],
    });
    expect(roster.getSeat(bot.id)?.difficulty).toBe(Difficulty.HARD);
  });
});

describe("botSeats — configuration helpers", () => {
  it("botTakeoverRoundsFromEnv parses positive integers only", () => {
    expect(botTakeoverRoundsFromEnv({})).toBeNull();
    expect(botTakeoverRoundsFromEnv({ BOT_TAKEOVER_ROUNDS: "3" })).toBe(3);
    expect(botTakeoverRoundsFromEnv({ BOT_TAKEOVER_ROUNDS: "0" })).toBeNull();
    expect(botTakeoverRoundsFromEnv({ BOT_TAKEOVER_ROUNDS: "-2" })).toBeNull();
    expect(botTakeoverRoundsFromEnv({ BOT_TAKEOVER_ROUNDS: "2.5" })).toBeNull();
    expect(
      botTakeoverRoundsFromEnv({ BOT_TAKEOVER_ROUNDS: "garbage" }),
    ).toBeNull();
  });

  it("makeBotConfig derives a stable per-seat seed", () => {
    const a = makeBotConfig("seat-1", Difficulty.EASY);
    const b = makeBotConfig("seat-1", Difficulty.EASY);
    const c = makeBotConfig("seat-2", Difficulty.EASY);
    expect(a.botSeed).toBe(b.botSeed);
    expect(a.botSeed).not.toBe(c.botSeed);
    expect(a.pacing).toEqual({ minMs: 800, maxMs: 2500 });
  });
});
