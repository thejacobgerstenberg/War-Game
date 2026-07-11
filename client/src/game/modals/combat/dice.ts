/**
 * Dice assets + deterministic face derivation for the battle cascade.
 *
 * ART PROVENANCE: client/src/assets/combat/dice-1..6.svg are byte-for-byte
 * copies of art/ui/dice-1..6.svg (feature/visual-assets, CC0) — the same
 * vendoring pattern as client/src/assets/icons (see ui/icons.ts).
 *
 * ENGINE REALITY (server/src/engine/combat.ts): battles resolve server-side
 * from a seeded RNG stream, but the PROJECTED state a client receives zeroes
 * rngSeed/rngCursor and the battle log entry carries only AGGREGATES —
 * rounds, winnerId, per-stack losses, rout flags. Individual die values are
 * never transmitted. The cascade therefore renders the engine's REAL facts
 * (how many fought, how many hits stood = enemy casualties, who routed, who
 * won) and derives the pip faces DETERMINISTICALLY from a stable hash of
 * (battle id, side, die index) — identical on every client and every replay,
 * never Math.random(). Hit dice always show 5 or 6, misses 1–4, honouring
 * the printed rule "A die of five or six strikes home."
 */
import dice1Url from "../../../assets/combat/dice-1.svg";
import dice2Url from "../../../assets/combat/dice-2.svg";
import dice3Url from "../../../assets/combat/dice-3.svg";
import dice4Url from "../../../assets/combat/dice-4.svg";
import dice5Url from "../../../assets/combat/dice-5.svg";
import dice6Url from "../../../assets/combat/dice-6.svg";

/** Die face value -> vendored art URL (art/ui/dice-N.svg). */
export const DICE_URL: Record<number, string> = {
  1: dice1Url,
  2: dice2Url,
  3: dice3Url,
  4: dice4Url,
  5: dice5Url,
  6: dice6Url,
};

/** One rendered die of the cascade. */
export interface DieFace {
  /** Face value 1..6 (5 and 6 strike home). */
  value: number;
  /** True when this die is one of the hits that stood. */
  hit: boolean;
}

/** FNV-1a 32-bit string hash — stable across sessions and clients. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Cap on rendered dice per row — readability, per the mockup's scale. */
export const MAX_DICE_PER_ROW = 10;

/**
 * Derive a row of the cascade: `count` dice of which exactly `hits` struck
 * home. Hit positions and miss faces are spread by the hash so the row reads
 * naturally, but the same seed always yields the same row.
 */
export function deriveDice(seed: string, count: number, hits: number): DieFace[] {
  const n = Math.max(0, Math.min(count, MAX_DICE_PER_ROW));
  const h = Math.max(0, Math.min(hits, n));
  // Choose h hit positions via a deterministic Fisher–Yates over indices.
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = fnv1a(`${seed}:swap:${i}`) % (i + 1);
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const hitAt = new Set(order.slice(0, h));
  return Array.from({ length: n }, (_, i) => {
    const roll = fnv1a(`${seed}:die:${i}`);
    return hitAt.has(i)
      ? { value: 5 + (roll % 2), hit: true } // 5 or 6
      : { value: 1 + (roll % 4), hit: false }; // 1..4
  });
}

/** True when the viewer prefers reduced motion (dice settle instantly). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
