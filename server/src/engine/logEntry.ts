/**
 * logEntry.ts — the chronicle log factory.
 *
 * Every {@link GameLogEntry} gets a deterministic id (`log-<counter>`) and a
 * monotonic logical timestamp, both sourced from GameState counters rather than
 * wall-clock time — keeping the engine pure and replays byte-identical.
 */
import type { GameLogEntry, GameState } from "@imperium/shared";

/** The caller-supplied fields of a log entry (id/timestamp are assigned here). */
export type LogInput = Omit<GameLogEntry, "id" | "timestamp">;

/**
 * Append a log entry to the state, assigning a deterministic id and monotonic
 * timestamp and bumping `logCounter` and `clock`. Returns a new GameState; the
 * input state is not mutated.
 */
export function appendLog(state: GameState, input: LogInput): GameState {
  const entry: GameLogEntry = {
    ...input,
    id: `log-${state.logCounter}`,
    timestamp: state.clock,
  };
  return {
    ...state,
    log: [...state.log, entry],
    logCounter: state.logCounter + 1,
    clock: state.clock + 1,
  };
}

/**
 * Build a single log entry against explicit counters (for constructing the very
 * first entry before a full GameState exists). Returns the entry plus the next
 * counter values.
 */
export function makeLogEntry(
  counters: { logCounter: number; clock: number },
  input: LogInput,
): { entry: GameLogEntry; logCounter: number; clock: number } {
  const entry: GameLogEntry = {
    ...input,
    id: `log-${counters.logCounter}`,
    timestamp: counters.clock,
  };
  return {
    entry,
    logCounter: counters.logCounter + 1,
    clock: counters.clock + 1,
  };
}
