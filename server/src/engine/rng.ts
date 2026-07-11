/**
 * Deterministic, seedable RNG for the pure engine.
 *
 * All randomness in the engine flows through this module — never `Math.random`
 * or `Date.now`. An {@link Rng} is constructed from a seed and a cursor; each
 * drawn value is a pure function of `(seed, cursor)`, so reconstructing a
 * generator with `makeRng(seed, savedCursor)` continues the identical sequence.
 * Callers that need to persist progress read `rng.cursor` back into
 * `GameState.rngCursor` after use.
 *
 * Implementation: mulberry32 avalanche over a 32-bit state mixed from
 * `(seed, cursor)` on every step.
 */

/** A live random-number generator. Mutates its own `cursor` as values are drawn. */
export interface Rng {
  /** The immutable seed this generator was created from. */
  readonly seed: number;
  /** Advancing position in the stream; write this back into state after use. */
  cursor: number;
  /** Next float in [0, 1). */
  next(): number;
  /** Roll a single six-sided die (1..6). */
  rollD6(): number;
  /** Roll `n` six-sided dice, returning each result. */
  rollDice(n: number): number[];
  /** Fisher–Yates shuffle producing a new array (does not mutate the input). */
  shuffle<T>(array: readonly T[]): T[];
}

/** Mix a seed and cursor into a 32-bit state and avalanche it into [0,1). */
function sample(seed: number, cursor: number): number {
  let t = (((seed ^ 0x9e3779b9) >>> 0) + Math.imul(cursor + 1, 0x6d2b79f5)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Build an {@link Rng}. `cursor` defaults to 0. Every {@link Rng.next} call
 * consumes exactly one cursor position, and the value drawn depends only on
 * `(seed, cursor)` — never on how many draws preceded it — so the stream is
 * fully replayable from any persisted cursor.
 */
export function makeRng(seed: number, cursor = 0): Rng {
  let localCursor = cursor;

  const rng: Rng = {
    seed,
    get cursor() {
      return localCursor;
    },
    set cursor(v: number) {
      localCursor = v;
    },
    next(): number {
      const value = sample(seed, localCursor);
      localCursor += 1;
      return value;
    },
    rollD6(): number {
      return Math.floor(rng.next() * 6) + 1;
    },
    rollDice(n: number): number[] {
      const out: number[] = [];
      for (let i = 0; i < n; i += 1) out.push(rng.rollD6());
      return out;
    },
    shuffle<T>(array: readonly T[]): T[] {
      const out = [...array];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng.next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
  };
  return rng;
}
