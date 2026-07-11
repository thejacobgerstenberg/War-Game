/**
 * Client-side Omen (event) card registry — cards area.
 *
 * PROVENANCE (all copy is real, nothing invented):
 *  - id / slug / name / tag / era / duration: transcribed VERBATIM from the
 *    engine's public card table, server/src/engine/events/cards.ts (the
 *    client must never import server code, so the printed metadata is
 *    mirrored here; ids are the `omen-N` values that flow through
 *    state.omenDeck / state.omenDiscard).
 *  - tagline: the "Historical flavor & trigger" column of docs/EVENT_CARDS.md,
 *    verbatim (trigger notes omitted).
 *  - flavor: parsed at module load from client/src/assets/cards/flavor.md,
 *    a byte-copy of lore/events/flavor.md (join on `flavorSlug` — the lore
 *    file's heading slugs differ from the engine slugs for a handful of
 *    cards; the mapping below follows docs/EVENT_CARDS.md §"Unreconciled").
 *  - art: client/src/assets/cards/events/*.svg are byte-copies of
 *    art/illustrations/events/*.svg (CC0 — see art/illustrations/CREDITS.md);
 *    art/illustrations/events/MANIFEST.md binds 20 of the 46 slugs
 *    (filename = MANIFEST slug). Unbound cards fall back to the event frame
 *    (client/src/assets/cards/event-card.svg, byte-copy of
 *    art/cards/event-card.svg) + flavor text.
 *  - era deck names: docs/EVENT_CARDS.md ("Omens of Peace" / "Omens of War" /
 *    "Omens of the End").
 */
import flavorRaw from "../../assets/cards/flavor.md?raw";
import eventFrameRaw from "../../assets/cards/event-card.svg?raw";

/** Card tag as printed (docs/EVENT_CARDS.md "Type" column, coarse). */
export type OmenTag = "Good" | "Ill" | "Mixed" | "Omen";

export interface OmenCardEntry {
  /** Engine id — `omen-N`, the value found in state.omenDiscard. */
  id: string;
  /** Card number 1..46 as printed. */
  n: number;
  /** Engine slug (server/src/engine/events/cards.ts). */
  slug: string;
  name: string;
  tag: OmenTag;
  era: 1 | 2 | 3;
  duration: "Immediate" | "Held" | "Standing";
  /** docs/EVENT_CARDS.md historical-flavor line (the toast's one-liner). */
  tagline: string;
  /** Heading slug in lore/events/flavor.md (differs from `slug` for some). */
  flavorSlug: string;
  /** MANIFEST art slug (= vendored filename) when an illustration exists. */
  artSlug?: string;
}

/** Era deck names, verbatim from docs/EVENT_CARDS.md. */
export const ERA_DECK_NAME: Record<1 | 2 | 3, string> = {
  1: "Omens of Peace",
  2: "Omens of War",
  3: "Omens of the End",
};

 
const T: ReadonlyArray<
  [number, string, string, OmenTag, 1 | 2 | 3, OmenCardEntry["duration"], string, string, string?]
> = [
  [1, "bumper-harvest", "Bumper Harvest", "Good", 1, "Immediate", "A golden year across the granaries.", "good-harvest", "good-harvest"],
  [2, "hard-winter", "Hard Winter", "Ill", 1, "Immediate", "The hardest winter in living memory.", "famine-winter", "famine-winter"],
  [3, "silk-road-caravan", "Silk Road Caravan", "Good", 1, "Immediate", "The great caravan reaches the sea.", "silk-road-caravan", "silk-road-caravan"],
  [4, "papal-indulgence", "Papal Indulgence", "Good", 1, "Immediate", "Rome grants remission of sins for coin.", "papal-indulgence"],
  [5, "imperial-coronation", "Imperial Coronation", "Good", 1, "Immediate", "A sovereign is crowned, a sultan girded with the sword.", "imperial-coronation"],
  [6, "comet-omen", "Comet Omen", "Omen", 1, "Immediate", "A blazing star troubles the heavens.", "comet-omen"],
  [7, "ottoman-interregnum", "Ottoman Interregnum", "Ill", 1, "Immediate", "The sons of Bayezid turn on one another.", "ottoman-interregnum"],
  [8, "timurid-shadow", "Timurid Shadow", "Ill", 1, "Immediate", "The long shadow of Ankara still falls on Anatolia.", "timur-shadow", "timur-shadow"],
  [9, "discovery-of-alum", "Discovery of Alum", "Good", 1, "Standing", "Rich alum found at Phocaea and Chios.", "discovery-of-alum"],
  [10, "marriage-alliance", "Marriage Alliance", "Good", 1, "Held", "A dynastic wedding binds two courts.", "marriage-alliance"],
  [11, "corsair-raid", "Corsair Raid", "Ill", 1, "Immediate", "Barbary galliots slip out of Tunis.", "corsair-raid"],
  [12, "serbian-despotate-submits", "Serbian Despotate Submits", "Mixed", 1, "Immediate", "Đurađ Branković bends to the stronger neighbour.", "serbian-despotate-submits"],
  [13, "ragusan-tribute", "Ragusan Tribute", "Good", 1, "Immediate", "Ragusa buys its peace, as it always has.", "ragusan-tribute"],
  [14, "plague-of-locusts", "Plague of Locusts", "Ill", 1, "Immediate", "A black cloud devours the fields.", "plague-of-locusts"],
  [15, "hussite-handgunners", "Hussite Handgunners for Hire", "Good", 1, "Immediate", "Bohemian gunners and their wagon-forts seek employ.", "hussite-mercenaries", "hussite-mercenaries"],
  [16, "fall-of-a-beylik", "Fall of a Beylik", "Mixed", 1, "Immediate", "An Anatolian emirate collapses into feud.", "fall-of-a-beylik"],
  [17, "council-of-florence", "Council of Florence", "Mixed", 2, "Immediate", "1439 — East and West proclaim one Church.", "council-of-florence", "council-of-florence"],
  [18, "venetian-genoese-war", "Venetian–Genoese War", "Ill", 2, "Standing", "The old rivalry flares from Chios to the Golden Horn.", "genoese-venetian-war", "genoese-venetian-war"],
  [19, "hunyadi-long-campaign", "Hunyadi's Long Campaign", "Good", 2, "Immediate", "1443 — the White Knight drives deep into the Balkans.", "long-campaign", "long-campaign"],
  [20, "varna-crusade", "Varna Crusade", "Mixed", 2, "Immediate", "1444 — the crusading host marches to the Black Sea.", "varna-crusade", "varna-crusade"],
  [21, "fall-of-thessalonica", "Fall of Thessalonica", "Ill", 2, "Immediate", "1430 — the great city of Macedonia is stormed.", "fall-of-thessalonica", "fall-of-thessalonica"],
  [22, "mercenary-revolt", "Mercenary Revolt", "Ill", 2, "Immediate", "“No pay, no peace.”", "mercenary-revolt", "mercenary-revolt"],
  [23, "janissary-discontent", "Janissary Discontent", "Ill", 2, "Immediate", "The Janissaries overturn their kettles and demand a donative.", "janissary-discontent"],
  [24, "wallachian-revolt", "Wallachian Revolt", "Ill", 2, "Immediate", "The voivode raises the country against his overlord.", "wallachian-revolt"],
  [25, "earthquake", "Earthquake", "Ill", 2, "Immediate", "The earth heaves; towers crack and fall.", "walls-earthquake", "walls-earthquake"],
  [26, "grain-fleet-lost", "The Grain Fleet Is Lost", "Ill", 2, "Immediate", "A storm — or a corsair — takes the grain convoy.", "grain-fleet-lost"],
  [27, "fire-of-the-arsenal", "Fire of the Arsenal", "Ill", 2, "Immediate", "Fire races through the shipyards.", "fire-of-the-arsenal"],
  [28, "papal-interdict", "Papal Interdict", "Ill", 2, "Immediate", "Rome lays a faction under interdict.", "papal-interdict"],
  [29, "schism", "Schism", "Ill", 2, "Immediate", "Rival popes; a Church divided against itself.", "schism"],
  [30, "mamluk-embargo", "Mamluk Embargo", "Ill", 2, "Immediate", "Cairo shuts the spice road and raises the tariff.", "mamluk-embargo"],
  [31, "anatolian-alliance", "Anatolian Alliance", "Ill", 2, "Immediate", "Karaman and the beyliks league against the Porte.", "anatolian-alliance"],
  [32, "hexamilion-rebuilt", "Hexamilion Rebuilt at Corinth", "Good", 2, "Standing", "The wall across the Isthmus rises again.", "hexamilion-wall", "hexamilion-wall"],
  [33, "knights-of-rhodes-sortie", "Knights of Rhodes Sortie", "Good", 2, "Immediate", "The Hospitaller galleys ride out of Rhodes.", "knights-of-rhodes-sortie"],
  [34, "great-bombard-forged", "The Great Bombard Forged", "Good", 3, "Immediate", "Orban casts the monster cannon before the walls.", "great-bombard-forged", "great-bombard-forged"],
  [35, "black-death-returns", "Black Death Returns", "Ill", 3, "Immediate", "Pestilence rides the trade roads once more.", "black-death-returns", "black-death-returns"],
  [36, "gunpowder-revolution", "Gunpowder Revolution", "Mixed", 3, "Standing", "The age of the cannon dawns for all.", "gunpowder-revolution"],
  [37, "final-crusade", "The Final Crusade", "Mixed", 3, "Immediate", "Christendom's last appeal before the City falls.", "final-crusade"],
  [38, "pilgrimage-jubilee", "Pilgrimage / Jubilee Year", "Good", 3, "Immediate", "1450 — the Holy Year fills Rome with pilgrims.", "pilgrim-season", "pilgrim-season"],
  [39, "relic-discovered", "Relic Discovered", "Good", 3, "Standing", "A saint's relic is unearthed; pilgrims flock.", "relics-of-the-saints", "relics-of-the-saints"],
  [40, "drought", "Drought", "Ill", 3, "Immediate", "The rains fail; the Nile runs low.", "drought"],
  [41, "financial-crisis", "Financial Crisis", "Ill", 3, "Immediate", "Credit collapses; the great banks close their doors.", "financial-crisis"],
  [42, "byzantine-civil-war", "Byzantine Civil War", "Ill", 3, "Immediate", "A Palaiologos pretender raises his standard.", "byzantine-civil-war"],
  [43, "peace-of-turin", "Peace of Turin", "Good", 3, "Immediate", "The maritime republics are brought to terms.", "peace-of-turin"],
  [44, "great-comet-1453", "The Great Comet of 1453", "Omen", 3, "Immediate", "A vast comet hangs over the doomed City — an omen of the end.", "omen-in-the-sky", "omen-in-the-sky"],
  [45, "genoese-loan-called-in", "Genoese Loan Called In", "Ill", 3, "Immediate", "The Bank of St George presents its final account.", "bank-of-saint-george", "bank-of-saint-george"],
  [46, "fall-of-constantinople", "The Fall of Constantinople", "Mixed", 3, "Immediate", "The Ottoman guns speak; an age ends.", "fall-of-constantinople", "fall-of-constantinople"],
];
 

/** All 46 Omen cards, in printed order. */
export const OMEN_CARDS: OmenCardEntry[] = T.map(
  ([n, slug, name, tag, era, duration, tagline, flavorSlug, artSlug]) => ({
    id: `omen-${n}`,
    n,
    slug,
    name,
    tag,
    era,
    duration,
    tagline,
    flavorSlug,
    artSlug,
  }),
);

/** `omen-N` id → card entry. */
export const OMEN_CARD_BY_ID: Record<string, OmenCardEntry> = Object.fromEntries(
  OMEN_CARDS.map((c) => [c.id, c]),
);

/* --------------------------------------------------------------------------
 * Flavor text — parsed from the vendored byte-copy of lore/events/flavor.md
 * so the copy stays verbatim by construction. Sections are `### slug`
 * headings followed by one paragraph.
 * ------------------------------------------------------------------------ */
function parseFlavor(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const sections = raw.split(/\n### /).slice(1);
  for (const section of sections) {
    const newline = section.indexOf("\n");
    if (newline === -1) continue;
    const slug = section.slice(0, newline).trim();
    // Paragraph = everything up to the next heading/rule, joined and trimmed.
    const body = section
      .slice(newline + 1)
      .split(/\n(?:#|---|\*\*)/)[0]
      .replace(/\s+/g, " ")
      .trim();
    if (slug && body) out[slug] = body;
  }
  return out;
}

const FLAVOR_BY_SLUG: Record<string, string> = parseFlavor(flavorRaw);

/** Flavor paragraph for a card (verbatim lore/events/flavor.md), if any. */
export function flavorFor(card: OmenCardEntry): string | null {
  return FLAVOR_BY_SLUG[card.flavorSlug] ?? null;
}

/* --------------------------------------------------------------------------
 * Illustrations — the 20 MANIFEST-bound vignettes, vendored. Unbound cards
 * get the event frame + flavor only.
 * ------------------------------------------------------------------------ */
const EVENT_ART_MODULES = import.meta.glob("../../assets/cards/events/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

const EVENT_ART_BY_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(EVENT_ART_MODULES).map(([path, url]) => {
    const file = path.split("/").pop() ?? path;
    return [file.replace(/\.svg$/, ""), url];
  }),
);

/** Illustration URL for a card, or null when the MANIFEST binds none. */
export function artFor(card: OmenCardEntry): string | null {
  if (card.artSlug === undefined) return null;
  return EVENT_ART_BY_SLUG[card.artSlug] ?? null;
}

/**
 * The frame SVGs ship with template placeholder text ("TITLE", "Body text
 * line 1"…, id="…-slot…") meant to be replaced by the renderer. The client
 * lays REAL text over the frame, so the placeholder <text> nodes are
 * stripped and the cleaned frame served as a data URI.
 */
export function frameToUrl(svgSource: string): string {
  const stripped = svgSource.replace(/<text id="[^"]*-slot[^"]*"[\s\S]*?<\/text>/g, "");
  // encodeURIComponent leaves ' ( ) unescaped, which breaks CSS url(...);
  // escape them too so the data URI survives inline background-image use.
  const encoded = encodeURIComponent(stripped)
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  return `data:image/svg+xml,${encoded}`;
}

/** The event-card frame (art/cards/event-card.svg), the no-art fallback. */
export const EVENT_FRAME_URL: string = frameToUrl(eventFrameRaw);
