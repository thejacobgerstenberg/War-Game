/**
 * Bot RNG determinism tests.
 *
 * The bot decision stream must be a pure function of (gameSeed, botSeed,
 * round) — never Math.random/Date.now, never the engine's (rngSeed,
 * rngCursor) stream (drawing from that would desync replays; see
 * docs/ARCHITECTURE.md determinism rules and the gauntlet-harness precedent
 * of a separate mulberry32).
 */
import { describe, expect, it } from "vitest";
import {
  botRngFromSeed,
  hashCombine,
  makeBotRng,
  seedFromString,
} from "../rng.js";

function draw(n: number, rng: { next(): number }): number[] {
  return Array.from({ length: n }, () => rng.next());
}

describe("bots/rng — determinism", () => {
  it("replays identically for the same (gameSeed, botSeed, round)", () => {
    const a = makeBotRng(12345, 777, 4);
    const b = makeBotRng(12345, 777, 4);
    expect(draw(32, a)).toEqual(draw(32, b));
  });

  it("diverges across botSeed, gameSeed and round", () => {
    const base = draw(16, makeBotRng(12345, 777, 4));
    expect(draw(16, makeBotRng(12345, 778, 4))).not.toEqual(base);
    expect(draw(16, makeBotRng(12346, 777, 4))).not.toEqual(base);
    expect(draw(16, makeBotRng(12345, 777, 5))).not.toEqual(base);
  });

  it("emits floats in [0, 1) and ints in [0, max)", () => {
    const rng = makeBotRng(1, 2, 3);
    for (let i = 0; i < 200; i += 1) {
      const f = rng.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = rng.int(6);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);
    }
    expect(rng.int(0)).toBe(0);
    expect(rng.int(-3)).toBe(0);
  });

  it("pick/chance edge cases are total", () => {
    const rng = makeBotRng(9, 9, 9);
    expect(rng.pick([])).toBeUndefined();
    expect(rng.pick(["only"])).toBe("only");
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
  });

  it("shuffle is deterministic, non-mutating, and a permutation", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const frozen = [...input];
    const a = makeBotRng(42, 1, 1).shuffle(input);
    const b = makeBotRng(42, 1, 1).shuffle(input);
    expect(input).toEqual(frozen); // no mutation
    expect(a).toEqual(b); // deterministic
    expect([...a].sort((x, y) => x - y)).toEqual(frozen); // permutation
  });
});

describe("bots/rng — stream splitting", () => {
  it("split is stable regardless of how much the parent has drawn", () => {
    const parentA = makeBotRng(100, 200, 3);
    draw(17, parentA); // consume an arbitrary amount first
    const childA = parentA.split("attack-order");

    const parentB = makeBotRng(100, 200, 3); // fresh, nothing drawn
    const childB = parentB.split("attack-order");

    expect(draw(16, childA)).toEqual(draw(16, childB));
  });

  it("different labels produce independent streams", () => {
    const parent = makeBotRng(100, 200, 3);
    const a = draw(16, parent.split("attack-order"));
    const b = draw(16, parent.split("advisor"));
    expect(a).not.toEqual(b);
  });

  it("children do not disturb the parent stream", () => {
    const lone = makeBotRng(5, 6, 7);
    const before = draw(8, lone);

    const parent = makeBotRng(5, 6, 7);
    parent.split("x"); // splitting draws nothing from the parent
    expect(draw(8, parent)).toEqual(before);
  });
});

describe("bots/rng — seed derivation helpers", () => {
  it("seedFromString is stable and discriminates", () => {
    const id = "3f2c9a4e-bot-seat";
    expect(seedFromString(id)).toBe(seedFromString(id));
    expect(seedFromString(id)).not.toBe(seedFromString(`${id}!`));
    expect(Number.isInteger(seedFromString(id))).toBe(true);
  });

  it("hashCombine is order-sensitive and stable", () => {
    expect(hashCombine(1, 2, 3)).toBe(hashCombine(1, 2, 3));
    expect(hashCombine(1, 2, 3)).not.toBe(hashCombine(3, 2, 1));
  });

  it("botRngFromSeed replays from a raw 32-bit seed", () => {
    expect(draw(8, botRngFromSeed(0xdeadbeef))).toEqual(
      draw(8, botRngFromSeed(0xdeadbeef)),
    );
  });
});
