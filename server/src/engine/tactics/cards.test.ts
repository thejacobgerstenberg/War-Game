/**
 * tactics/cards.test.ts — the ratified tactic deck DATA (GAME_DESIGN §7.7).
 *
 * Asserts the exact §7.7 composition (24 unique designs / 48 physical copies via
 * the 8×3 / 8×2 / 8×1 tier distribution), the CANON clarification-2 re-flavor
 * (`master-founders-hired` present as the 8th rare, `the-guns-of-orban` retired),
 * the greek-fire / treason remove-from-game flags, and that `buildTacticDeck` is
 * deterministic (same seed → identical order) and reads every design's copies.
 */
import { describe, it, expect } from "vitest";
import { makeRng } from "../rng.js";
import { TACTIC_CARDS, TACTIC_CARD_BY_ID, buildTacticDeck } from "./cards.js";

describe("tactic deck composition (§7.7)", () => {
  it("has 24 unique designs", () => {
    expect(TACTIC_CARDS).toHaveLength(24);
    expect(new Set(TACTIC_CARDS.map((c) => c.id)).size).toBe(24);
  });

  it("totals 48 physical copies", () => {
    const total = TACTIC_CARDS.reduce((n, c) => n + c.copies, 0);
    expect(total).toBe(48);
  });

  it("distributes 8 Common ×3, 8 Uncommon ×2, 8 Rare ×1", () => {
    const byCopies = { 3: 0, 2: 0, 1: 0 } as Record<number, number>;
    for (const c of TACTIC_CARDS) byCopies[c.copies] = (byCopies[c.copies] ?? 0) + 1;
    expect(byCopies[3]).toBe(8); // Common
    expect(byCopies[2]).toBe(8); // Uncommon
    expect(byCopies[1]).toBe(8); // Rare
  });

  it("re-flavors the 8th rare as master-founders-hired and retires the-guns-of-orban", () => {
    expect(TACTIC_CARD_BY_ID["master-founders-hired"]).toBeDefined();
    expect(TACTIC_CARD_BY_ID["master-founders-hired"]?.copies).toBe(1);
    expect(TACTIC_CARD_BY_ID["the-guns-of-orban"]).toBeUndefined();
  });

  it("aligns master-founders-hired to the authoritative lore/tactics/cards.md effect (RULING 4)", () => {
    const mfh = TACTIC_CARD_BY_ID["master-founders-hired"];
    // Effect string is byte-identical to lore/tactics/cards.md (## Rare entry).
    expect(mfh?.effect).toBe(
      "In one siege, cancel the wall bonus for one full round and add 1 die to your assault.",
    );
    // Mechanic: the ratified bribed-gatekeeper wall-bonus cancel PLUS a +1 assault die.
    const data = mfh?.data as {
      effect?: string;
      domain?: string;
      side?: string;
      assaultDice?: number;
      value?: number;
    };
    expect(data?.effect).toBe("wall_bonus_zero"); // same tag as bribed-gatekeeper
    expect(TACTIC_CARD_BY_ID["bribed-gatekeeper"]?.data).toMatchObject({ effect: "wall_bonus_zero" });
    expect(data?.domain).toBe("siege");
    expect(data?.side).toBe("attacker");
    expect(data?.assaultDice).toBe(1);
    // The previously-invented "+2 wall-HP damage dice" mechanic is gone.
    expect(data?.effect).not.toBe("siege_bombard");
    expect(data?.value).toBeUndefined();
    expect(mfh?.effect).not.toMatch(/Wall-HP damage dice/i);
  });

  it("flags greek-fire and treason-at-the-gate as removed-from-game", () => {
    expect(TACTIC_CARD_BY_ID["greek-fire"]?.removedFromGameOnPlay).toBe(true);
    expect(TACTIC_CARD_BY_ID["treason-at-the-gate"]?.removedFromGameOnPlay).toBe(true);
    // A common card is NOT removed.
    expect(TACTIC_CARD_BY_ID["forced-march"]?.removedFromGameOnPlay).toBeFalsy();
  });

  it("carries printed cost data where §7.7 prints one", () => {
    expect((TACTIC_CARD_BY_ID["condottieri-contract"]?.data as { costGold?: number })?.costGold).toBe(2);
    expect((TACTIC_CARD_BY_ID["papal-indulgence"]?.data as { costGold?: number })?.costGold).toBe(2);
    expect((TACTIC_CARD_BY_ID["holy-war-proclaimed"]?.data as { costFaith?: number })?.costFaith).toBe(2);
    expect((TACTIC_CARD_BY_ID["treason-at-the-gate"]?.data as { costGold?: number })?.costGold).toBe(4);
  });
});

describe("buildTacticDeck (§7.7 / §14)", () => {
  it("expands to exactly 48 cards covering every design's copies", () => {
    const deck = buildTacticDeck(makeRng(999));
    expect(deck).toHaveLength(48);
    for (const c of TACTIC_CARDS) {
      const n = deck.filter((id) => id === c.id).length;
      expect(n).toBe(c.copies);
    }
  });

  it("is deterministic: same seed → identical order", () => {
    const a = buildTacticDeck(makeRng(4242));
    const b = buildTacticDeck(makeRng(4242));
    expect(a).toEqual(b);
  });

  it("different seeds generally give a different order", () => {
    const a = buildTacticDeck(makeRng(1));
    const b = buildTacticDeck(makeRng(2));
    expect(a).not.toEqual(b);
  });

  it("advances the rng cursor by 47 swaps (Fisher–Yates over 48 entries)", () => {
    const rng = makeRng(7);
    buildTacticDeck(rng);
    expect(rng.cursor).toBe(47);
  });
});
