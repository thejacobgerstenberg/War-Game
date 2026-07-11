/**
 * Advisor counsel — data layer (advisor area).
 *
 * PROVENANCE (all copy is real, parsed VERBATIM at module load):
 *  - client/src/assets/advisor/{byzantium,ottomans,venice,genoa,hungary}.md
 *    are byte-copies of lore/factions/*.md. Each file's "## Advisors" section
 *    lists named counsellors with situation-tagged sample lines
 *    ("1. <line> [low gold]"). The FIRST counsellor of each faction speaks
 *    through the bubble (game.html callout 13 shows exactly this seat —
 *    Demetrios Choumnos for Byzantium).
 *  - client/src/assets/advisor/tips.md is a byte-copy of lore/tutorial/tips.md
 *    ("N. [phase] tip"); the tutorial/tips voice speaks through the same
 *    advisor seat (lore/tutorial/script.md "Speaker convention").
 */
import { Faction } from "@imperium/shared";
import byzantiumRaw from "../../assets/advisor/byzantium.md?raw";
import ottomansRaw from "../../assets/advisor/ottomans.md?raw";
import veniceRaw from "../../assets/advisor/venice.md?raw";
import genoaRaw from "../../assets/advisor/genoa.md?raw";
import hungaryRaw from "../../assets/advisor/hungary.md?raw";
import tipsRaw from "../../assets/advisor/tips.md?raw";

/** The situation tags used in lore/factions/*.md sample lines. */
export type CounselTag =
  | "low gold"
  | "war declared on you"
  | "siege begun"
  | "ally betrayed you"
  | "victory near"
  | "event card struck"
  | "idle/flavor";

export interface CounselLine {
  text: string;
  tag: CounselTag;
}

export interface FactionAdvisor {
  /** Attribution, e.g. "Demetrios Choumnos, Grand Logothete". */
  cite: string;
  lines: CounselLine[];
}

const KNOWN_TAGS: readonly CounselTag[] = [
  "low gold",
  "war declared on you",
  "siege begun",
  "ally betrayed you",
  "victory near",
  "event card struck",
  "idle/flavor",
];

/**
 * Parse the FIRST advisor of a faction lore file: the first `### Name, Title`
 * heading after `## Advisors`, and its numbered `N. line [tag]` entries.
 */
function parseFirstAdvisor(raw: string): FactionAdvisor | null {
  const advisorsAt = raw.indexOf("## Advisors");
  if (advisorsAt === -1) return null;
  const after = raw.slice(advisorsAt);
  const firstHeading = after.indexOf("### ");
  if (firstHeading === -1) return null;
  const section = after.slice(firstHeading + 4);
  const headingEnd = section.indexOf("\n");
  if (headingEnd === -1) return null;
  const cite = section.slice(0, headingEnd).trim();
  // Lines run until the NEXT advisor heading.
  const bodyEnd = section.indexOf("\n### ");
  const body = bodyEnd === -1 ? section : section.slice(0, bodyEnd);

  const lines: CounselLine[] = [];
  for (const rawLine of body.split("\n")) {
    const m = /^\d+\.\s+(.*)\s+\[([^\]]+)\]\s*$/.exec(rawLine.trim());
    if (m === null) continue;
    const tag = m[2].trim() as CounselTag;
    if (!KNOWN_TAGS.includes(tag)) continue;
    lines.push({ text: m[1].trim(), tag });
  }
  return lines.length > 0 ? { cite, lines } : null;
}

const RAW_BY_FACTION: Record<Faction, string> = {
  [Faction.BYZANTIUM]: byzantiumRaw,
  [Faction.OTTOMAN]: ottomansRaw,
  [Faction.VENICE]: veniceRaw,
  [Faction.GENOA]: genoaRaw,
  [Faction.HUNGARY]: hungaryRaw,
};

const ADVISOR_CACHE = new Map<Faction, FactionAdvisor | null>();

/** The faction's court counsellor (first advisor of its lore file). */
export function advisorFor(faction: Faction): FactionAdvisor | null {
  if (!ADVISOR_CACHE.has(faction)) {
    ADVISOR_CACHE.set(faction, parseFirstAdvisor(RAW_BY_FACTION[faction]));
  }
  return ADVISOR_CACHE.get(faction) ?? null;
}

/* --------------------------------------------------------------------------
 * Tips — lore/tutorial/tips.md, "N. [phase] text".
 * ------------------------------------------------------------------------ */
export type TipTag =
  | "income"
  | "muster"
  | "campaign"
  | "siege"
  | "diplomacy"
  | "market"
  | "any";

export interface TipLine {
  text: string;
  tag: TipTag;
}

const TIP_TAGS: readonly TipTag[] = [
  "income",
  "muster",
  "campaign",
  "siege",
  "diplomacy",
  "market",
  "any",
];

function parseTips(raw: string): TipLine[] {
  const out: TipLine[] = [];
  for (const rawLine of raw.split("\n")) {
    const m = /^\d+\.\s+\[([^\]]+)\]\s+(.*)$/.exec(rawLine.trim());
    if (m === null) continue;
    const tag = m[1].trim() as TipTag;
    if (!TIP_TAGS.includes(tag)) continue;
    out.push({ text: m[2].trim(), tag });
  }
  return out;
}

/** The forty loading/idle tips, phase-tagged. */
export const TIPS: TipLine[] = parseTips(tipsRaw);

/** Tips serving a phase tag (its own tag + the `[any]` pool). */
export function tipsFor(tag: TipTag): TipLine[] {
  return TIPS.filter((t) => t.tag === tag || t.tag === "any");
}
