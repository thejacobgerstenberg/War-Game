/**
 * Hand-rolled runtime guards for every client -> server socket payload.
 *
 * Socket.IO delivers whatever bytes a client sends: payloads may be missing,
 * null, wrong-typed, oversized, or otherwise hostile. Nothing in this module
 * throws — each parser returns a {@link ValidationResult} and the socket layer
 * answers failures with `error_msg`. Field rules:
 *
 * - `playerName`: string, 1–32 chars after trimming (returned trimmed).
 * - `roomCode`: exactly 6 of [A-Z0-9] after trim + uppercase normalisation
 *   (lowercase codes keep working, matching LobbyManager's case-insensitive
 *   lookup).
 * - `sessionToken`: non-empty string, bounded length (ours are 32 chars of
 *   base64url; anything past {@link SESSION_TOKEN_MAX_LENGTH} is garbage).
 * - `faction`: one of the five canonical {@link Faction} enum values.
 *
 * Parsers return a fresh object containing only the known fields, so junk
 * extra properties never travel further into the server.
 */
import {
  Faction,
  type AddBotPayload,
  type BotDifficulty,
  type CreateGamePayload,
  type JoinGamePayload,
  type PickFactionPayload,
  type RejoinGamePayload,
  type RemoveBotPayload,
} from "@imperium/shared";

export const PLAYER_NAME_MAX_LENGTH = 32;
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
export const SESSION_TOKEN_MAX_LENGTH = 128;

/** Result of a payload guard; `error` is safe to relay as `error_msg`. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

function pass<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

/** Non-null object (arrays excluded) — the only shape a payload may have. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is one of the five canonical {@link Faction} ids. */
export function isFaction(value: unknown): value is Faction {
  return (
    typeof value === "string" &&
    (Object.values(Faction) as string[]).includes(value)
  );
}

function validatePlayerName(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return fail("A player name is required.");
  }
  const name = value.trim();
  if (name.length === 0) return fail("A player name is required.");
  if (name.length > PLAYER_NAME_MAX_LENGTH) {
    return fail(
      `Player names are limited to ${PLAYER_NAME_MAX_LENGTH} characters.`,
    );
  }
  return pass(name);
}

function validateRoomCode(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return fail("A room code is required.");
  }
  const code = value.trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) {
    return fail("Room codes are exactly 6 letters or digits.");
  }
  return pass(code);
}

function validateSessionToken(value: unknown): ValidationResult<string> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SESSION_TOKEN_MAX_LENGTH
  ) {
    return fail("Invalid session token.");
  }
  return pass(value);
}

export function parseCreateGamePayload(
  raw: unknown,
): ValidationResult<CreateGamePayload> {
  if (!isRecord(raw)) return fail("Malformed create_game payload.");
  const playerName = validatePlayerName(raw.playerName);
  if (!playerName.ok) return playerName;
  return pass({ playerName: playerName.value });
}

export function parseJoinGamePayload(
  raw: unknown,
): ValidationResult<JoinGamePayload> {
  if (!isRecord(raw)) return fail("Malformed join_game payload.");
  const roomCode = validateRoomCode(raw.roomCode);
  if (!roomCode.ok) return roomCode;
  const playerName = validatePlayerName(raw.playerName);
  if (!playerName.ok) return playerName;
  return pass({ roomCode: roomCode.value, playerName: playerName.value });
}

export function parseRejoinGamePayload(
  raw: unknown,
): ValidationResult<RejoinGamePayload> {
  if (!isRecord(raw)) return fail("Malformed rejoin_game payload.");
  const roomCode = validateRoomCode(raw.roomCode);
  if (!roomCode.ok) return roomCode;
  const sessionToken = validateSessionToken(raw.sessionToken);
  if (!sessionToken.ok) return sessionToken;
  return pass({ roomCode: roomCode.value, sessionToken: sessionToken.value });
}

/** The canonical bot difficulty tiers (mirrors shared `BotDifficulty`). */
export const BOT_DIFFICULTIES = ["EASY", "NORMAL", "HARD"] as const;

/** Player-id fields are UUIDs (36 chars); anything far past that is garbage. */
export const PLAYER_ID_MAX_LENGTH = 64;

/** True when `value` is a canonical {@link BotDifficulty}. */
export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return (
    typeof value === "string" &&
    (BOT_DIFFICULTIES as readonly string[]).includes(value)
  );
}

export function parseAddBotPayload(
  raw: unknown,
): ValidationResult<AddBotPayload> {
  if (!isRecord(raw)) return fail("Malformed add_bot payload.");
  if (!isBotDifficulty(raw.difficulty)) {
    return fail("Bot difficulty must be EASY, NORMAL or HARD.");
  }
  return pass({ difficulty: raw.difficulty });
}

export function parseRemoveBotPayload(
  raw: unknown,
): ValidationResult<RemoveBotPayload> {
  if (!isRecord(raw)) return fail("Malformed remove_bot payload.");
  const id = raw.botPlayerId;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > PLAYER_ID_MAX_LENGTH
  ) {
    return fail("A bot player id is required.");
  }
  return pass({ botPlayerId: id });
}

export function parsePickFactionPayload(
  raw: unknown,
): ValidationResult<PickFactionPayload> {
  if (!isRecord(raw)) return fail("Malformed pick_faction payload.");
  if (!isFaction(raw.faction)) {
    return fail("Unknown faction.");
  }
  return pass({ faction: raw.faction });
}
