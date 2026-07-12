/**
 * events/cards.test.ts — EVENT_CARDS.md canon LOCK tests.
 *
 * MARSHAL FIX (events major): 12 of 46 event data slugs had drifted from the
 * canonical slugs printed in docs/EVENT_CARDS.md (the era tables, cards #1–#46).
 * The slug is the stable join key to lore/events/flavor.md, so drift silently
 * breaks the lore join. This suite hardcodes the EXACT canonical slug set from
 * the doc — any future rename/typo in events/cards.ts fails here immediately.
 *
 * The `omen-N` id keyspace (frozen contract) and the per-era deck split
 * (16 / 17 / 13 — EVENT_CARDS.md "Omen Deck Structure") are locked alongside.
 * Slugs remain event-deck-namespaced (CANON CLARIFICATION 2: `EventCardId` vs
 * `TacticCardId` brands keep the keyspaces distinct; `papal-indulgence` legally
 * exists in both decks).
 */
import { describe, it, expect } from "vitest";
import { EVENT_CARDS, OMEN_CARDS, OMEN_CARDS_BY_ERA, omenCardId } from "./cards.js";

/**
 * The 46 canonical slugs, hardcoded VERBATIM from docs/EVENT_CARDS.md in printed
 * order (Era I table #1–#16, Era II table #17–#33, Era III table #34–#46).
 * Do NOT derive this list from cards.ts — it exists to catch drift there.
 */
const CANONICAL_SLUGS: readonly string[] = [
  // Era I — Omens of Peace (#1–#16)
  "good-harvest",
  "famine-winter",
  "silk-road-caravan",
  "papal-indulgence",
  "imperial-coronation",
  "comet-omen",
  "ottoman-interregnum",
  "timur-shadow",
  "discovery-of-alum",
  "marriage-alliance",
  "corsair-raid",
  "serbian-despotate-submits",
  "ragusan-tribute",
  "plague-of-locusts",
  "hussite-mercenaries",
  "fall-of-a-beylik",
  // Era II — Omens of War (#17–#33)
  "council-of-florence",
  "genoese-venetian-war",
  "long-campaign",
  "varna-crusade",
  "fall-of-thessalonica",
  "mercenary-revolt",
  "janissary-discontent",
  "wallachian-revolt",
  "walls-earthquake",
  "grain-fleet-lost",
  "fire-of-the-arsenal",
  "papal-interdict",
  "schism",
  "mamluk-embargo",
  "anatolian-alliance",
  "hexamilion-wall",
  "knights-of-rhodes-sortie",
  // Era III — Omens of the End (#34–#46)
  "great-bombard-forged",
  "black-death-returns",
  "gunpowder-revolution",
  "final-crusade",
  "pilgrim-season",
  "relics-of-the-saints",
  "drought",
  "financial-crisis",
  "byzantine-civil-war",
  "peace-of-turin",
  "omen-in-the-sky",
  "bank-of-saint-george",
  "fall-of-constantinople",
];

describe("EVENT_CARDS slug canon lock (docs/EVENT_CARDS.md #1–#46)", () => {
  it("carries EXACTLY the 46 canonical doc slugs, in printed card order", () => {
    expect(CANONICAL_SLUGS).toHaveLength(46);
    expect(EVENT_CARDS.map((c) => c.slug)).toEqual(CANONICAL_SLUGS);
  });

  it("slug #N sits on the card numbered N (slug↔printed-number join intact)", () => {
    for (const card of EVENT_CARDS) {
      expect(card.slug).toBe(CANONICAL_SLUGS[card.n - 1]);
    }
  });

  it("slugs are unique and kebab-case (stable lore join keys)", () => {
    const slugs = EVENT_CARDS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(46);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("ids remain the frozen omen-N keyspace, aligned with the printed numbers 1..46", () => {
    EVENT_CARDS.forEach((card, i) => {
      expect(card.n).toBe(i + 1);
      expect(card.id).toBe(omenCardId(card.n));
    });
    expect(OMEN_CARDS).toHaveLength(46);
  });

  it("era decks split 16 / 17 / 13 (EVENT_CARDS.md Omen Deck Structure)", () => {
    expect(OMEN_CARDS_BY_ERA[1]).toHaveLength(16);
    expect(OMEN_CARDS_BY_ERA[2]).toHaveLength(17);
    expect(OMEN_CARDS_BY_ERA[3]).toHaveLength(13);
  });
});
