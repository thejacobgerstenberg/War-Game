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
  type CreateGamePayload,
  type GameAction,
  type GameActionPayload,
  type GameActionType,
  type JoinGamePayload,
  type PickFactionPayload,
  type RejoinGamePayload,
} from "@imperium/shared";

export const PLAYER_NAME_MAX_LENGTH = 32;
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
export const SESSION_TOKEN_MAX_LENGTH = 128;
/** Player ids are crypto UUIDs (36 chars); anything past this is garbage. */
export const PLAYER_ID_MAX_LENGTH = 64;

/**
 * Every discriminant the engine reducer accepts, mirroring the frozen
 * {@link GameAction} union (shared/src/types/actions.ts). An action whose
 * `type` is not in this set is rejected before it can reach the engine.
 */
const GAME_ACTION_TYPES: ReadonlySet<GameActionType> = new Set<GameActionType>([
  "RECRUIT",
  "MOVE",
  "BUILD",
  "TRADE",
  "DIPLOMACY",
  "VASSALIZE",
  "PLAY_CARD",
  "PLAY_TACTIC",
  "DECLARE_WAR",
  "LEVY_CALL",
  "SPY",
  "MERC_BID",
  "SET_TAX",
  "PASS",
  "ADVANCE_PHASE",
]);

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

export function parsePickFactionPayload(
  raw: unknown,
): ValidationResult<PickFactionPayload> {
  if (!isRecord(raw)) return fail("Malformed pick_faction payload.");
  if (!isFaction(raw.faction)) {
    return fail("Unknown faction.");
  }
  return pass({ faction: raw.faction });
}

/** True when `value` is a known {@link GameActionType} discriminant. */
function isGameActionType(value: unknown): value is GameActionType {
  return (
    typeof value === "string" &&
    GAME_ACTION_TYPES.has(value as GameActionType)
  );
}

/** A player id must be a non-empty, length-bounded string. */
function isValidPlayerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PLAYER_ID_MAX_LENGTH
  );
}

/**
 * Guard for the in-game `game_action` envelope, mirroring the lobby guards:
 * `roomCode` must be a valid code, `sessionToken` a non-empty bounded string,
 * and `action` an object whose `type` is a known {@link GameAction} discriminant
 * carrying a `player` id (optional only for the engine/host-driven
 * `ADVANCE_PHASE`). The per-variant payload (province ids, unit counts, …) is
 * NOT re-validated here — the pure reducer (`engine/actions.ts::applyAction`) is
 * the authority on action legality and throws a typed `EngineError`; this guard
 * exists only to reject a malformed or unknown-type envelope before dispatch.
 */
export function parseGameActionPayload(
  raw: unknown,
): ValidationResult<GameActionPayload> {
  if (!isRecord(raw)) return fail("Malformed game_action payload.");
  const roomCode = validateRoomCode(raw.roomCode);
  if (!roomCode.ok) return roomCode;
  const sessionToken = validateSessionToken(raw.sessionToken);
  if (!sessionToken.ok) return sessionToken;
  if (!isRecord(raw.action)) return fail("Malformed game action.");

  const action = raw.action;
  if (!isGameActionType(action.type)) {
    return fail("Unknown game action type.");
  }
  // Every action names its issuing player; only ADVANCE_PHASE may omit it.
  if (action.type === "ADVANCE_PHASE") {
    if (action.player !== undefined && !isValidPlayerId(action.player)) {
      return fail("Invalid action player.");
    }
    // Optional idempotency guard fields (the round/phase the client saw).
    if (
      action.fromRound !== undefined &&
      (typeof action.fromRound !== "number" ||
        !Number.isInteger(action.fromRound))
    ) {
      return fail("Malformed game action.");
    }
    if (action.fromPhase !== undefined && typeof action.fromPhase !== "string") {
      return fail("Malformed game action.");
    }
  } else if (!isValidPlayerId(action.player)) {
    return fail("A game action must name its player.");
  }

  return pass({
    roomCode: roomCode.value,
    sessionToken: sessionToken.value,
    // The envelope is validated; the reducer validates the variant payload.
    action: action as unknown as GameAction,
  });
}
