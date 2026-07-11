/**
 * Display formatting helpers shared across the game UI.
 *
 * Design contract (game.html): rounds, host strengths, breaths and pip
 * captions are shown in ROMAN numerals — "No clock digits anywhere."
 */

const ROMAN_TABLE: ReadonlyArray<readonly [number, string]> = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

/**
 * Roman numeral for a positive integer. Zero renders in the chronicle voice
 * as "nought" contexts — callers show "0"-as-word themselves; here 0 → "0"
 * so counters never disappear. Negative/NaN clamp to "0".
 */
export function toRoman(n: number): string {
  const value = Math.floor(n);
  if (!Number.isFinite(value) || value <= 0) return "0";
  let rest = value;
  let out = "";
  for (const [weight, glyph] of ROMAN_TABLE) {
    while (rest >= weight) {
      out += glyph;
      rest -= weight;
    }
  }
  return out;
}

/** Era number (1|2|3) to its display banner, e.g. "Era II". */
export function eraLabel(era: 1 | 2 | 3): string {
  return `Era ${toRoman(era)}`;
}
