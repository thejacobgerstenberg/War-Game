/**
 * Minimal structured logger (docs/ARCHITECTURE.md, Operations — "Logging";
 * deploy/OPERATIONS.md §6 arrives with PR #4 and mirrors it).
 *
 * Emits single-line JSON objects to stdout with the canonical shape
 * `{ts, level, roomCode?, event, msg}`; extra context keys are appended after
 * the canonical five. Emission is gated by the `LOG_LEVEL` env var
 * (`debug` | `info` | `warn` | `error`, default `info`). Never log secrets or
 * PII beyond player display names.
 */

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Minimum level emitted; unknown LOG_LEVEL values fall back to `info`. */
function minLevelRank(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return LEVEL_RANK[isLogLevel(raw) ? raw : "info"];
}

/** Optional per-line context. `roomCode` is canonical; other keys are extras. */
export interface LogFields {
  roomCode?: string;
  [key: string]: unknown;
}

/**
 * Write one JSON log line to stdout.
 *
 * @param level  Severity, gated by `LOG_LEVEL`.
 * @param event  Machine-readable snake_case event name (e.g. `room_created`).
 * @param msg    Short human-readable message.
 * @param fields Optional `roomCode` plus any extra context keys.
 */
export function log(
  level: LogLevel,
  event: string,
  msg: string,
  fields: LogFields = {},
): void {
  if (LEVEL_RANK[level] < minLevelRank()) return;
  const { roomCode, ...extra } = fields;
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level };
  if (roomCode !== undefined) line.roomCode = roomCode;
  line.event = event;
  line.msg = msg;
  Object.assign(line, extra);
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
