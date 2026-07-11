/**
 * Seeded PRNG for the whole simulation package (mulberry32).
 *
 * HARD RULE: every module draws randomness through an RNG created here.
 * Math.random is banned everywhere in sim/.
 *
 * mulberry32 is a 32-bit state generator: extremely fast, allocation-free
 * per draw, and good enough statistically for Monte-Carlo game balance work.
 */

export interface RNG {
  /** The seed this stream was created with (for logging/reproducibility). */
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). n must be a positive integer. */
  int(n: number): number;
  /** Uniform integer in [min, max] inclusive. */
  range(min: number, max: number): number;
  /** Standard die: uniform integer 1..6. */
  d6(): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform pick from a non-empty array. */
  pick<T>(arr: readonly T[]): T;
  /** In-place Fisher-Yates shuffle; returns the same array. */
  shuffle<T>(arr: T[]): T[];
  /**
   * Derive an independent, deterministic child stream (e.g. one per game
   * in a Monte-Carlo batch). Same (seed, streamId) => same child stream.
   */
  fork(streamId: number): RNG;
}

/** Cheap integer scramble used to derive fork seeds (splitmix32 finalizer). */
function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** Create a seeded RNG stream. Same seed => identical sequence, forever. */
export function create(seed: number): RNG {
  let s = seed >>> 0;

  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: RNG = {
    seed: seed >>> 0,
    next,
    int(n: number): number {
      return (next() * n) | 0;
    },
    range(min: number, max: number): number {
      return min + ((next() * (max - min + 1)) | 0);
    },
    d6(): number {
      return ((next() * 6) | 0) + 1;
    },
    chance(p: number): boolean {
      return next() < p;
    },
    pick<T>(arr: readonly T[]): T {
      return arr[(next() * arr.length) | 0];
    },
    shuffle<T>(arr: T[]): T[] {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = (next() * (i + 1)) | 0;
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    },
    fork(streamId: number): RNG {
      return create(mix(seed >>> 0, streamId));
    },
  };
  return rng;
}
