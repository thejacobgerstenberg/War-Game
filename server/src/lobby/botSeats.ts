/**
 * Lobby-side bot seating — the thin hook between the lobby and `../bots/`.
 *
 * Responsibilities:
 *   1. `add_bot` (HOST-ONLY, lobby only): seat a synthetic
 *      {@link LobbyPlayerState} so `startGame` turns it into an engine seat
 *      like any human. The bot takes the first unclaimed faction and is
 *      named after that faction's historical ruler.
 *   2. `remove_bot` (HOST-ONLY, lobby only).
 *   3. Abandoned-seat takeover: once a game has started, a DISCONNECTED
 *      human seat is taken over by a NORMAL bot after `BOT_TAKEOVER_ROUNDS`
 *      game rounds (env-configured; disabled when unset). The human keeps
 *      their sessionToken — on rejoin the seat is released back to them.
 *
 * Host-only checks mirror the `startGame` precedent ("Only the host can
 * start the game."). This module never touches GameState — driving a bot
 * seat in a live game is `../bots/botPlayer.ts`'s job, hooked in by
 * whichever module implements the `game_action` dispatch loop (it should
 * call {@link BotRoster.evaluateTakeovers} whenever the round advances).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Faction } from "@imperium/shared";
import { Difficulty, DEFAULT_PACING, type BotConfig } from "../bots/types.js";
import { personaForFaction } from "../bots/personality.js";
import { seedFromString } from "../bots/rng.js";
import {
  LobbyError,
  MAX_PLAYERS,
  type LobbyPlayerState,
  type Room,
} from "./lobbyManager.js";

/** Env var: game rounds a human seat may sit disconnected before takeover. */
export const BOT_TAKEOVER_ROUNDS_ENV = "BOT_TAKEOVER_ROUNDS";

/**
 * Parse {@link BOT_TAKEOVER_ROUNDS_ENV}: a positive integer enables takeover
 * after that many rounds; unset/garbage/non-positive disables it (null).
 */
export function botTakeoverRoundsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[BOT_TAKEOVER_ROUNDS_ENV];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Roster entry for one bot-controlled seat. */
export interface BotSeatRecord {
  playerId: string;
  difficulty: Difficulty;
  /** True when this seat was a human's, taken over after disconnect. */
  viaTakeover: boolean;
}

/** Result of one takeover sweep. */
export interface TakeoverSweep {
  /** Seats newly converted to bot control this sweep. */
  takenOver: string[];
  /** Taken-over seats returned to their reconnected humans this sweep. */
  released: string[];
}

/**
 * Derive the deterministic {@link BotConfig} for a seat. `botSeed` hashes the
 * seat's player id, so a game replays identically from `(rngSeed, playerId)`.
 */
export function makeBotConfig(
  playerId: string,
  difficulty: Difficulty,
  pacing: BotConfig["pacing"] = DEFAULT_PACING,
): BotConfig {
  return { difficulty, botSeed: seedFromString(playerId), pacing };
}

/**
 * Tracks which seats (across all rooms) are bot-controlled, and the
 * takeover countdown for disconnected humans. Transport-agnostic; the
 * socket layer translates thrown {@link LobbyError}s into `error_msg`.
 */
export class BotRoster {
  private readonly seats = new Map<string, BotSeatRecord>();
  /** playerId → round at which the human was first seen disconnected. */
  private readonly disconnectedSince = new Map<string, number>();

  /** True when the seat is currently bot-controlled. */
  isBot(playerId: string): boolean {
    return this.seats.has(playerId);
  }

  /** Roster record for a bot seat, if any. */
  getSeat(playerId: string): BotSeatRecord | undefined {
    return this.seats.get(playerId);
  }

  /** All bot-controlled seats currently in a room. */
  botsInRoom(room: Room): LobbyPlayerState[] {
    return room.players.filter((p) => this.seats.has(p.id));
  }

  /**
   * HOST-ONLY, lobby-only: seat a new bot. Picks the first unclaimed
   * faction (enum order) and names the seat after its historical ruler.
   */
  addBot(
    room: Room,
    requestingPlayerId: string,
    difficulty: Difficulty,
  ): LobbyPlayerState {
    const requester = room.players.find((p) => p.id === requestingPlayerId);
    if (!requester) throw new LobbyError("You are not seated in this game.");
    if (!requester.isHost) {
      throw new LobbyError("Only the host can add a bot.");
    }
    if (room.startedByHost) {
      throw new LobbyError("Bots can only be added before the game starts.");
    }
    if (room.players.length >= MAX_PLAYERS) {
      throw new LobbyError(`That game is full (max ${MAX_PLAYERS} players).`);
    }

    const taken = new Set(
      room.players
        .map((p) => p.faction)
        .filter((f): f is Faction => f !== null),
    );
    const faction = Object.values(Faction).find((f) => !taken.has(f));
    if (!faction) {
      throw new LobbyError("Every faction is already claimed.");
    }

    const persona = personaForFaction(faction);
    const nameTaken = (name: string): boolean =>
      room.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
    const name = nameTaken(persona.rulerName)
      ? `${persona.rulerName} (AI)`
      : persona.rulerName;

    const bot: LobbyPlayerState = {
      id: randomUUID(),
      name,
      faction,
      isHost: false,
      // Bot seats are always "connected" (they never drop a socket) but do
      // not keep an abandoned room alive — see LobbyManager.refreshEmptySince.
      connected: true,
      // Never handed out: no client can rejoin as this seat.
      sessionToken: randomBytes(24).toString("base64url"),
      isBot: true,
    };
    room.players.push(bot);
    this.seats.set(bot.id, {
      playerId: bot.id,
      difficulty,
      viaTakeover: false,
    });
    return bot;
  }

  /** HOST-ONLY, lobby-only: remove a host-added bot seat. */
  removeBot(
    room: Room,
    requestingPlayerId: string,
    botPlayerId: string,
  ): void {
    const requester = room.players.find((p) => p.id === requestingPlayerId);
    if (!requester) throw new LobbyError("You are not seated in this game.");
    if (!requester.isHost) {
      throw new LobbyError("Only the host can remove a bot.");
    }
    if (room.startedByHost) {
      throw new LobbyError("Bots can only be removed before the game starts.");
    }
    const idx = room.players.findIndex((p) => p.id === botPlayerId);
    if (idx === -1 || !this.seats.has(botPlayerId)) {
      throw new LobbyError("That seat is not a bot.");
    }
    room.players.splice(idx, 1);
    this.seats.delete(botPlayerId);
  }

  /**
   * Abandoned-seat sweep — call whenever the game round advances (the future
   * `game_action` dispatch loop owns the call site).
   *
   * A human seat that has been disconnected for `takeoverRounds` full game
   * rounds is taken over by a NORMAL bot (`viaTakeover: true`); a taken-over
   * seat whose human reconnected (rejoin_game) is released back. Pass
   * `takeoverRounds = null` (the env default when unset) to disable — the
   * sweep then only clears stale countdowns.
   */
  evaluateTakeovers(room: Room, takeoverRounds: number | null): TakeoverSweep {
    const sweep: TakeoverSweep = { takenOver: [], released: [] };
    if (!room.startedByHost || !room.state) return sweep;
    const round = room.state.round;

    for (const player of room.players) {
      const record = this.seats.get(player.id);

      // Release: a taken-over seat whose human has reconnected.
      if (record?.viaTakeover && player.connected) {
        this.seats.delete(player.id);
        player.isBot = false;
        sweep.released.push(player.id);
        continue;
      }
      if (record) continue; // host-added bots never count down

      if (player.connected) {
        this.disconnectedSince.delete(player.id);
        continue;
      }

      // Disconnected human: start/advance the countdown.
      const since = this.disconnectedSince.get(player.id);
      if (since === undefined) {
        this.disconnectedSince.set(player.id, round);
        continue;
      }
      if (takeoverRounds !== null && round - since >= takeoverRounds) {
        this.disconnectedSince.delete(player.id);
        this.seats.set(player.id, {
          playerId: player.id,
          difficulty: Difficulty.NORMAL,
          viaTakeover: true,
        });
        player.isBot = true;
        sweep.takenOver.push(player.id);
      }
    }
    return sweep;
  }

  /** Drop all roster/countdown entries for a room (call when it is reaped). */
  forgetRoom(room: Room): void {
    for (const player of room.players) {
      this.seats.delete(player.id);
      this.disconnectedSince.delete(player.id);
    }
  }
}
