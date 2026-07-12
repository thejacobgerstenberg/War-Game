/**
 * VENDORED from server/src/bots/rng.ts @ 9009d5262afd983392c565e1d5e51bbdf31da92b
 * (PR #27 "Server: AI opponents", branch feature/ai-opponents — not on main yet).
 * Local changes: (1) engine imports rewritten to the offline engine shim;
 * (2) `.coastal` -> `.port` (main #28 renamed Province.coastal to Province.port);
 * (3) nothing else. Do not add logic here; upstream replaces this after #27 merges.
 */
/**
 * Deterministic PRNG for bot DECISIONS — deliberately separate from the
 * engine's own `(rngSeed, rngCursor)` stream.
 *
 * A bot must NEVER draw from the engine {@link import("../engine/rng.js").Rng}:
 * doing so would advance `GameState.rngCursor` and desync every replay.
 * Precedent: the gauntlet harness keeps its own mulberry32 stream for exactly
 * this reason. Bot code likewise must never touch `Math.random`/`Date.now` in
 * decision logic — all bot randomness flows through this module so a game is
 * fully replayable from `(gameSeed, botSeed)`.
 *
 * Streams are derived from `(gameSeed, botSeed, round)` so two bots in the
 * same game (different botSeed) and the same bot on different rounds never
 * share a sequence. {@link BotRng.split} derives a labelled child stream from
 * the parent's SEED (not its cursor), so a split is stable no matter how many
 * values were drawn from the parent before the split.
 */

/** A live deterministic generator for bot decisions. */
export interface BotRng {
  /** The 32-bit seed this stream was derived from (diagnostics/tests). */
  readonly seed: number;
  /** Next float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). Returns 0 for maxExclusive <= 0. */
  int(maxExclusive: number): number;
  /** Uniform pick from a list (undefined for an empty list). */
  pick<T>(items: readonly T[]): T | undefined;
  /** Fisher–Yates shuffle producing a NEW array (input is not mutated). */
  shuffle<T>(items: readonly T[]): T[];
  /** True with probability `p` (clamped to [0, 1]). */
  chance(p: number): boolean;
  /**
   * Derive an independent labelled child stream. Stable: the child depends
   * only on this stream's seed and the label, never on how many values have
   * already been drawn from the parent.
   */
  split(label: string): BotRng;
}

/** 32-bit FNV-1a over a string — stable label/id hashing. */
export function seedFromString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Avalanche-combine any number of 32-bit parts into one 32-bit seed. */
export function hashCombine(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const part of parts) {
    let k = (part >>> 0) ^ (part < 0 ? 0x55555555 : 0);
    k = Math.imul(k ^ (k >>> 16), 0x85ebca6b);
    k = Math.imul(k ^ (k >>> 13), 0xc2b2ae35);
    h = (Math.imul(h ^ (k ^ (k >>> 16)), 0x6d2b79f5) + 0x9e3779b9) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Build a {@link BotRng} directly from a 32-bit seed (mulberry32 core). */
export function botRngFromSeed(seed: number): BotRng {
  let a = seed >>> 0;
  const rng: BotRng = {
    seed: seed >>> 0,
    next(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(maxExclusive: number): number {
      if (maxExclusive <= 0) return 0;
      return Math.floor(rng.next() * maxExclusive);
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[rng.int(items.length)];
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = rng.int(i + 1);
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
    chance(p: number): boolean {
      if (p <= 0) return false;
      if (p >= 1) return true;
      return rng.next() < p;
    },
    split(label: string): BotRng {
      return botRngFromSeed(hashCombine(rng.seed, seedFromString(label)));
    },
  };
  return rng;
}

/**
 * The canonical bot stream: derived from the game seed (`GameState.rngSeed`),
 * this bot's own `botSeed` (see `BotConfig`), and the current round — so
 * every (game, bot, round) triple replays identically.
 */
export function makeBotRng(
  gameSeed: number,
  botSeed: number,
  round = 0,
): BotRng {
  return botRngFromSeed(hashCombine(gameSeed, botSeed, round));
}
