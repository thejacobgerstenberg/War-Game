/**
 * chronicle.ts — pure builders that stitch the end-of-game Chronicle from
 * state.log, per the chronicle text contract:
 *
 *   "At match end the engine walks the log, matches each notable moment to an
 *    event template, fills the {braces}, and picks one of three variants."
 *      — design/mockups/chronicle.html (header comment)
 *
 * COPY PROVENANCE (all template strings are VERBATIM, nothing invented):
 *  - Event templates + epilogue win/lose sets: lore/chronicle/TEMPLATES.md.
 *  - Fixed framing (opener, colophon, chapter titles, era headings, pill and
 *    fate labels): design/mockups/chronicle.html (the Phase 3 contract for
 *    this screen; the sample-match numbers there are parameterised here).
 *  - Rulers & capitals: lore/factions/*.md ("Ruler (c.1440)" sections and the
 *    "Capital:" lines). Coin names: lore/ui-text.md preamble (ducats /
 *    hyperpyra / akçe; neutral "gold" where no coin is noted — Hungary).
 *
 * Template rules honoured (TEMPLATES.md): numbers are spelled as words in
 * prose; {round}/{prestige}/{year} braces are counters and may be numerals
 * (rounds render as Roman counters per the mockup). Variant choice is
 * deterministic (log-entry counter modulo three) so every client at the
 * table reads the same chronicle.
 *
 * The one grammatical transform applied after filling: "The Ottomans" is a
 * plural subject, so third-person-singular verbs immediately after the name
 * are conjugated (the mockup does the same: "the Ottomans outpace Venice and
 * stand first in Prestige").
 */
import { Faction } from "@imperium/shared";
import type { GameLogEntry, GameState, Player } from "@imperium/shared";
import { FACTION_NAME } from "../uiText";
import { toRoman } from "../../ui";
import { OMEN_CARDS, artFor, flavorFor } from "../cards/eventCardData";
import type { OmenCardEntry } from "../cards/eventCardData";

/* --------------------------------------------------------------------------
 * Faction reference data (lore/factions/*.md; coin: lore/ui-text.md preamble)
 * ------------------------------------------------------------------------ */

/** Rulers, verbatim from lore/factions/<faction>.md "Ruler (c.1440)". */
export const FACTION_RULER: Record<Faction, string> = {
  [Faction.BYZANTIUM]: "John VIII Palaiologos",
  [Faction.OTTOMAN]: "Murad II",
  [Faction.VENICE]: "Francesco Foscari",
  [Faction.GENOA]: "Tommaso di Campofregoso",
  [Faction.HUNGARY]: "Vladislaus I (Ulászló)",
};

/** Capitals, verbatim from lore/factions/<faction>.md "Capital:" lines. */
export const FACTION_CAPITAL: Record<Faction, string> = {
  [Faction.BYZANTIUM]: "Constantinople",
  [Faction.OTTOMAN]: "Adrianople (Edirne)",
  [Faction.VENICE]: "Venice",
  [Faction.GENOA]: "Genoa",
  [Faction.HUNGARY]: "Buda",
};

/** Faction coin (lore/ui-text.md: ducats/hyperpyra/akçe; neutral "gold"). */
export const FACTION_COIN: Record<Faction, string> = {
  [Faction.BYZANTIUM]: "hyperpyra",
  [Faction.OTTOMAN]: "akçe",
  [Faction.VENICE]: "ducats",
  [Faction.GENOA]: "ducats",
  [Faction.HUNGARY]: "gold",
};

/* --------------------------------------------------------------------------
 * Rounds, eras & years. Era boundaries per §10 (era 1: r1–5, 2: r6–10,
 * 3: r11–16); the year anchors reproduce chronicle.html's era headings
 * (Anno 1400–1420 / 1421–1444 / 1445–1453) across the 16-round calendar.
 * ------------------------------------------------------------------------ */

export type Era = 1 | 2 | 3;

export function eraOfRound(round: number): Era {
  if (round <= 5) return 1;
  if (round <= 10) return 2;
  return 3;
}

const ROUND_YEAR: readonly number[] = [
  1400, 1405, 1410, 1415, 1420, // era I  (rounds 1–5)
  1421, 1427, 1433, 1439, 1444, // era II (rounds 6–10)
  1445, 1447, 1449, 1451, 1452, 1453, // era III (rounds 11–16)
];

/** Calendar year for a round (1..16), clamped. */
export function yearForRound(round: number): number {
  const idx = Math.min(Math.max(Math.floor(round), 1), 16) - 1;
  return ROUND_YEAR[idx];
}

const ERA_FIRST_ROUND: Record<Era, number> = { 1: 1, 2: 6, 3: 11 };
const ERA_LAST_ROUND: Record<Era, number> = { 1: 5, 2: 10, 3: 16 };

/** Era chapter titles (design/mockups/chronicle.html zone 4/5). */
export const ERA_TITLE: Record<Era, string> = {
  1: "The Gathering Storm",
  2: "Oaths and Ashes",
  3: "The Reckoning",
};

/** "Era the First/Second/Third" ordinals (chronicle.html era headings). */
const ERA_ORDINAL: Record<Era, string> = {
  1: "Era the First",
  2: "Era the Second",
  3: "Era the Third",
};

/* --------------------------------------------------------------------------
 * Numbers as words ("Spell numbers as words in prose" — TEMPLATES.md).
 * ------------------------------------------------------------------------ */

const ONES = [
  "nought", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
] as const;
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty"] as const;

/** English word for a small count (0..69), for prose per the template rules. */
export function numberWord(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v < 20) return ONES[v];
  if (v < 70) {
    const t = Math.floor(v / 10);
    const o = v % 10;
    return o === 0 ? TENS[t] : `${TENS[t]}-${ONES[o]}`;
  }
  return String(v);
}

/* --------------------------------------------------------------------------
 * Victory-kind classification (mirrors the engine's decideWinner precedence:
 * sudden death > prestige threshold > round-16 highest — server/src/engine/
 * prestige.ts; thresholds from server/src/engine/balance.ts
 * PRESTIGE_THRESHOLDS {2:72, 3:78, 4:80, 5:80}).
 * ------------------------------------------------------------------------ */

export type VictoryKind = "sudden" | "threshold" | "years";

const SUDDEN_DEATH_ROUNDS = 2;
const PRESTIGE_THRESHOLDS: Record<number, number> = { 2: 72, 3: 78, 4: 80, 5: 80 };

/** How the game ended, or null while it is still running. */
export function victoryKindOf(state: GameState): VictoryKind | null {
  const winner = state.winner;
  if (winner === undefined) return null;
  const cple = state.provinces.find((p) => p.id === "constantinople");
  const rightful = cple?.isCapitalOf ?? null;
  const hold = state.constantinopleHold;
  if (
    hold.faction === winner &&
    winner !== rightful &&
    hold.rounds >= SUDDEN_DEATH_ROUNDS
  ) {
    return "sudden";
  }
  const threshold = PRESTIGE_THRESHOLDS[state.players.length] ?? 80;
  const winnerPlayer = state.players.find((p) => p.faction === winner);
  if (winnerPlayer && winnerPlayer.prestige >= threshold) return "threshold";
  return "years";
}

/* --------------------------------------------------------------------------
 * Standings — the Final Reckoning table rows.
 * ------------------------------------------------------------------------ */

export interface StandingRow {
  player: Player;
  faction: Faction;
  prestige: number;
  /** Provinces still under this banner (nought = the banner is struck). */
  provinces: number;
  isWinner: boolean;
  eliminated: boolean;
}

/** True when a seated player holds no province (their banner is struck). */
export function isEliminated(state: GameState, playerId: string): boolean {
  return !state.provinces.some((p) => p.ownerId === playerId);
}

/**
 * Final standings: winner first (the engine's decision outranks the raw
 * track), then prestige, then most provinces, then most gold — the client
 * mirror of the §13.3 tiebreak.
 */
export function standingsOf(state: GameState): StandingRow[] {
  const seated = state.players.filter(
    (p): p is Player & { faction: Faction } => p.faction != null,
  );
  const rows: StandingRow[] = seated.map((p) => ({
    player: p,
    faction: p.faction,
    prestige: p.prestige,
    provinces: state.provinces.filter((x) => x.ownerId === p.id).length,
    isWinner: state.winner !== undefined && p.faction === state.winner,
    eliminated: isEliminated(state, p.id),
  }));
  return rows.sort((a, b) => {
    if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
    if (b.prestige !== a.prestige) return b.prestige - a.prestige;
    if (b.provinces !== a.provinces) return b.provinces - a.provinces;
    return b.player.treasury.gold - a.player.treasury.gold;
  });
}

/* --------------------------------------------------------------------------
 * Templates — VERBATIM from lore/chronicle/TEMPLATES.md (three variants each).
 * ------------------------------------------------------------------------ */

const T_WAR_DECLARED = [
  "The pretense of peace is spent. {faction} looses its hosts upon {rival}, and the field is open between them.",
  "In the year {year}, from {capital}, {ruler} proclaims open war upon {rival}. The truce is ash; the levies muster.",
  "No herald softens it: {faction} takes the field against {rival}. Let {province} run red.",
] as const;

const T_CITY_FALLS = [
  "{city} is taken. {faction}'s banners climb the walls, and {rival} counts the loss in stone and blood.",
  "When the siege has done its work, {city} opens its gates to {faction}. The keys pass, and the garrison of {rival} is no more.",
  "The walls of {city} hold no longer. {faction} enters as master, and {rival} is poorer by a city.",
] as const;

const T_BETRAYAL = [
  "So much for sworn faith: {faction} breaks the pact with {rival} and turns the dagger inward.",
  "The seal is broken by {ruler}'s own hand. Where there stood a pact with {rival_ruler}, now there is only the field.",
  "{faction} keeps the truce with {rival} exactly until it is useful to break it. Today it breaks.",
] as const;

const T_VASSAL_REVOLT = [
  "{vassal} will kneel no longer. The yoke of {overlord} is thrown off, and revolt runs through {province}.",
  "The tribute stops; the banners rise. {vassal} revolts against {overlord} and reclaims its own name.",
  "{overlord} kept a vassal, not a friend. {vassal} remembers the difference and rises in revolt.",
] as const;

const T_MONOPOLY = [
  "Every ledger now runs through {faction}. The trade of {province} answers to no one else, and rivals pay the toll.",
  "{faction} closes its fist on the trade of {province}. What flows, flows for it, and the {coin} flow after.",
  "The markets bow to one master. {faction} seizes the monopoly of {province}, and {rival} is shut out of the counting-house.",
] as const;

const T_LEAD_CHANGE = [
  "The standing shifts in round {round}: {faction} outpaces {rival} and stands first in Prestige, {prestige} to its name.",
  "Renown finds a new favorite. {faction} overtakes {rival} and stands first in Prestige.",
  "{rival} led, and leads no longer. {faction} claims the foremost seat, with {prestige} Prestige in hand.",
] as const;

const T_SUDDEN_DEATH = [
  "Constantinople falls, and with it the age. {faction} stands within the walls, and where the City ends, the chronicle can hold no more.",
  "The Queen of Cities is taken. When Constantinople falls to {faction}, nothing further remains to contest — the reckoning is closed.",
  "The last wall of the world gives way. {faction} enters Constantinople, and the fall of the City closes the reckoning.",
] as const;

/** Epilogue win/lose sets, VERBATIM (lore/chronicle/TEMPLATES.md §Epilogues). */
const EPILOGUES: Record<Faction, { win: readonly string[]; lose: readonly string[] }> = {
  [Faction.BYZANTIUM]: {
    win: [
      "Against every reckoning, the City holds. The double walls stand unbroken, the Golden Horn stays Roman, and {ruler} rules on where all foretold ruin. Twilight, and yet no night.",
      "Constantinople endures. The last heir of the Caesars keeps his throne beside the Bosporus, and the empire that was a rumor becomes, once more, a fact.",
      "The siege lifts, the relief comes, the impossible is done. {faction} outlives its own eulogy, and the purple is not folded away after all.",
    ],
    lose: [
      "The walls that guarded Christendom for a thousand years are breached at last. Constantinople falls, {ruler} with it, and the long Roman evening is over.",
      "The Queen of Cities kneels. The cross comes down from the great church, and what was Byzantium passes into memory and lament.",
      "It ends where it was always going to end: at the Theodosian walls, under the smoke of the Golden Horn. {faction} is no more, and an age closes with it.",
    ],
  },
  [Faction.OTTOMAN]: {
    win: [
      "The crescent rises over the Golden Horn. {ruler} takes Constantinople, the two continents are stitched into one dominion, and the Sublime Porte becomes the center of the world.",
      "What was besieged for generations is won in a season. {faction} enters the Queen of Cities as master, and the Roman evening gives way to a new imperial dawn.",
      "From Adrianople (Edirne) to the Bosporus, the road is now all one realm. The City is taken, and {ruler} is hailed conqueror beneath the great dome.",
    ],
    lose: [
      "The siege breaks upon the walls it could not climb. The hosts fall back toward Adrianople (Edirne), and the Porte's great design is undone for a generation.",
      "The tide that seemed unstoppable is stopped. {faction} spends its strength before the City and comes away with ash, and {ruler} counts the cost in the empty camps.",
      "The crescent does not rise this day. The Bosporus stays contested, the conquest deferred, and {ruler} rides home to a court that expected an empire.",
    ],
  },
  [Faction.VENICE]: {
    win: [
      "The Serenissima is mistress of the sea. Every galley pays her toll, every ledger closes in her favor, and the ducat rules where the sword could not.",
      "Venice counts, and Venice wins. The routes run gold into the lagoon, the rivals are shut from the counting-house, and {ruler} presides over an empire of the ledger.",
      "The lion of Saint Mark stands over the wharves of the world. {faction} takes the age not by conquest but by commerce, and the ducats have the last word.",
    ],
    lose: [
      "The lagoon cannot save the ledger. Venice's galleys are scattered, her monopolies broken, and the Serenissima learns that even the sea can be lost.",
      "The counting-house falls silent. The routes that fed the lagoon feed a rival now, and {faction} watches its ducats sail under another's flag.",
      "The lion of Saint Mark is caged. Trade slips the Republic's grasp, the treasury thins, and Venice yields the sea it thought its own.",
    ],
  },
  [Faction.GENOA]: {
    win: [
      "Genoa the proud outlasts her every rival. The banks of the Ligurian shore fund the age, the Black Sea colonies answer to no one else, and the ducat bends to Genoese account.",
      "The Superba earns her name. {faction} masters the counting-house and the colony alike, and Venice herself must trade on Genoese terms.",
      "From Pera to the Ligurian sea, the ledgers all run home to Genoa. {ruler} presides over a maritime empire that owes nothing and is owed much.",
    ],
    lose: [
      "Genoa is eclipsed. The colonies slip away, the banks fall quiet, and the Superba yields her seat at the world's table to the lion of Saint Mark.",
      "The Ligurian pride is humbled. {faction}'s galleys thin, her monopolies pass to rivals, and Genoa learns what it is to be second at sea.",
      "The counting-house of Genoa closes its books at a loss. The colonies answer to another flag now, and {ruler} rules a shore, not an empire.",
    ],
  },
  [Faction.HUNGARY]: {
    win: [
      "The frontier holds. The crown of Saint Stephen stands as the shield of the West, the crescent breaks upon the Danube, and {ruler} is hailed defender of Christendom.",
      "Hungary is the wall that does not fall. {faction} keeps the marches, turns back the siege, and the bells of Buda ring for a border kept whole.",
      "The bulwark stands unbroken. From Buda, {ruler} holds the line that others only prayed for, and the West sleeps easier for Hungarian steel.",
    ],
    lose: [
      "The frontier gives way. The marches are overrun, Buda's bells fall silent, and the shield of Christendom is beaten from Hungary's arm.",
      "The wall is breached. {faction}'s hosts are broken on the plain, the crown of Saint Stephen is contested, and the border the West relied upon is a border no longer.",
      "The bulwark fails. {ruler} spends the kingdom's strength and cannot hold the Danube; the marches are lost, and with them the shield of the West.",
    ],
  },
};

/* --------------------------------------------------------------------------
 * Filling, variants & the Ottoman plural conjugation.
 * ------------------------------------------------------------------------ */

/** Deterministic 0..2 variant from a log-entry id ("log-<counter>"). */
function variantOf(id: string): number {
  const digits = id.replace(/\D/g, "");
  const n = digits.length > 0 ? Number.parseInt(digits, 10) : id.length;
  return Math.abs(n) % 3;
}

function fill(template: string, slots: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in slots ? String(slots[key]) : whole,
  );
}

/** Singular→plural forms for verbs the templates place after {faction}. */
const PLURAL_VERB: Record<string, string> = {
  looses: "loose",
  takes: "take",
  enters: "enter",
  breaks: "break",
  keeps: "keep",
  closes: "close",
  seizes: "seize",
  outpaces: "outpace",
  overtakes: "overtake",
  claims: "claim",
  stands: "stand",
  spends: "spend",
  masters: "master",
  counts: "count",
  watches: "watch",
  yields: "yield",
  is: "are",
};

/**
 * "The Ottomans" is a plural subject: conjugate the verb directly after the
 * name (the mockup's own usage: "the Ottomans outpace Venice and stand
 * first"). Possessives after the conjugated verb become "their".
 */
function agreePlural(text: string): string {
  const name = FACTION_NAME[Faction.OTTOMAN]; // "The Ottomans"
  if (!text.includes(name)) return text;
  return (
    text
      // Conjugate the verb after the name — but not when the name is a
      // prepositional object ("the garrison of The Ottomans is no more").
      .replace(new RegExp(`(?<!of )${name} (\\w+)`, "g"), (whole, verb: string) => {
        const plural = PLURAL_VERB[verb];
        return plural !== undefined ? `${name} ${plural}` : whole;
      })
      // "{rival} led, and leads no longer." (lead-change variant three).
      .replace(`${name} led, and leads`, `${name} led, and lead`)
      .replace(new RegExp(`(${name} \\w+) its `, "g"), "$1 their ")
  );
}

function line(template: string, slots: Record<string, string | number>): string {
  return agreePlural(fill(template, slots));
}

/**
 * One epilogue line for a power (TEMPLATES.md §Epilogues): the victor draws
 * from its win set, all others from lose. Variant 0..2, caller-deterministic.
 */
export function epilogueFor(faction: Faction, won: boolean, variant: number): string {
  const set = won ? EPILOGUES[faction].win : EPILOGUES[faction].lose;
  const template = set[Math.abs(Math.floor(variant)) % set.length];
  return line(template, {
    faction: FACTION_NAME[faction],
    ruler: FACTION_RULER[faction],
  });
}

/* --------------------------------------------------------------------------
 * Log walking — classify notable moments.
 * ------------------------------------------------------------------------ */

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

interface Names {
  /** Player id -> faction (seated players only). */
  factionOf: (playerId: string | undefined) => Faction | null;
  provinceName: (id: string | undefined) => string | null;
  seaName: (id: string | undefined) => string | null;
  minorName: (id: string | undefined) => string | null;
}

function namesOf(state: GameState): Names {
  const players = new Map(state.players.map((p) => [p.id, p.faction] as const));
  const provinces = new Map(state.provinces.map((p) => [p.id, p.name] as const));
  const seas = new Map(state.seaZones.map((s) => [s.id, s.name] as const));
  const minors = new Map(state.minors.map((m) => [m.id, m.name] as const));
  return {
    factionOf: (id) => (id !== undefined ? (players.get(id) ?? null) : null),
    provinceName: (id) => (id !== undefined ? (provinces.get(id) ?? null) : null),
    seaName: (id) => (id !== undefined ? (seas.get(id) ?? null) : null),
    minorName: (id) => (id !== undefined ? (minors.get(id) ?? null) : null),
  };
}

/** One prose sentence of the chronicle, placed in its era. */
interface ChronicleLine {
  key: string;
  round: number;
  era: Era;
  /** Lower = more worth keeping when an era runs long. */
  priority: number;
  text: string;
}

/** A marginalia highlight (key battles, storms, great works). */
export interface ChronicleHighlight {
  key: string;
  era: Era;
  round: number;
  icon: "army" | "siege" | "marble";
  label: string;
}

/** One omen pip on the era timeline rail. */
export interface OmenPip {
  key: string;
  era: Era;
  round: number;
  year: number;
  card: OmenCardEntry;
  art: string | null;
  flavor: string | null;
  /** The engine's resolved reading of the omen (the log line). */
  reading: string;
  fatal: boolean;
}

export interface EraChapter {
  era: Era;
  title: string;
  /** "Era the First · Rounds I–V · Anno 1400–1420" heading. */
  when: string;
  paragraphs: string[];
  highlights: ChronicleHighlight[];
}

export interface ChronicleDoc {
  opener: string;
  colophon: string;
  chapters: EraChapter[];
  pips: OmenPip[];
  /** The closing plate: the era-ending omen's illustration + flavor caption. */
  plate: { art: string; alt: string; caption: string } | null;
  roundsPlayed: number;
  erasSpanned: number;
  powers: number;
  /** "{Twelve} omens that mattered, strung upon {three} eras." counts. */
  omenCount: number;
}

/** Display names for the four Great Works (docs/GAME_DESIGN — canon names). */
const GREAT_WORK_NAME: Record<string, string> = {
  HAGIA_SOPHIA: "Hagia Sophia",
  THEODOSIAN_WALLS: "The Theodosian Walls",
  GREAT_UNIVERSITY: "The Great University",
  GRAND_BAZAAR: "The Grand Bazaar",
};

const MAX_LINES_PER_ERA = 6;
const MAX_HIGHLIGHTS_PER_ERA = 4;
const MAX_PIPS_PER_ERA = 4;

/**
 * Walk the projected log and stitch the chronicle document. Pure: same log +
 * state (names/winner) in, same document out, on every client.
 */
export function buildChronicle(
  state: GameState,
  log: readonly GameLogEntry[],
): ChronicleDoc {
  const names = namesOf(state);
  const kind = victoryKindOf(state);
  const winner = state.winner;

  const roundsPlayed = Math.max(
    1,
    state.round,
    ...log.map((e) => e.round),
  );

  const lines: ChronicleLine[] = [];
  const highlights: ChronicleHighlight[] = [];
  const pips: OmenPip[] = [];

  /** Last known defender per province (from investments/battles there). */
  const lastDefenderAt = new Map<string, string>();
  /** First trade route already chronicled, per player. */
  const routeChronicled = new Set<string>();
  /** Omen card ids already turned into pips. */
  const pipSeen = new Set<string>();

  /** Per-round prestige totals (from the cleanup summaries) for lead changes. */
  const totalsByRound = new Map<number, Map<string, number>>();

  const factionSlots = (faction: Faction) => ({
    faction: FACTION_NAME[faction],
    ruler: FACTION_RULER[faction],
    capital: FACTION_CAPITAL[faction],
    coin: FACTION_COIN[faction],
  });

  for (const entry of log) {
    const era = eraOfRound(entry.round);
    const data = entry.data ?? {};
    const actor = entry.actors[0];
    const target = entry.targets?.[0];

    // Track who defends where (for the city-falls {rival} slot).
    if ((entry.type === "battle" || entry.type === "siege") && target !== undefined) {
      const defender = entry.actors[1];
      if (defender !== undefined && names.factionOf(defender) !== null) {
        lastDefenderAt.set(target, defender);
      }
    }

    switch (entry.type) {
      case "diplomacy": {
        // War declared (both engine paths carry data.justified + data.target).
        if (typeof data.justified === "boolean" && data.target !== undefined) {
          if (data.alreadyAtWar === true) break; // re-declaration: no new line
          const atkFac = names.factionOf(actor);
          const defFac = names.factionOf(target);
          if (atkFac === null || defFac === null) break;
          lines.push({
            key: entry.id,
            round: entry.round,
            era,
            priority: 1,
            text: line(T_WAR_DECLARED[variantOf(entry.id)], {
              ...factionSlots(atkFac),
              rival: FACTION_NAME[defFac],
              rival_ruler: FACTION_RULER[defFac],
              year: yearForRound(entry.round),
              // Variant three's field of blood: the defender's own capital.
              province: FACTION_CAPITAL[defFac],
            }),
          });
        }
        break;
      }

      case "betrayal": {
        const minorId = str(data.minorId);
        if (minorId !== null) {
          // Vassal revolt (an NPC minor throws off its overlord).
          const vassal = names.minorName(minorId);
          const overlordFac = names.factionOf(target);
          if (vassal === null || overlordFac === null) break;
          const minor = state.minors.find((m) => m.id === minorId);
          const province =
            names.provinceName(minor?.provinceIds[0]) ?? vassal;
          lines.push({
            key: entry.id,
            round: entry.round,
            era,
            priority: 3,
            text: line(T_VASSAL_REVOLT[variantOf(entry.id)], {
              vassal,
              overlord: FACTION_NAME[overlordFac],
              province,
            }),
          });
        } else if (str(data.treatyType) !== null) {
          // A pact broken between two crowns.
          const atkFac = names.factionOf(actor);
          const defFac = names.factionOf(target);
          if (atkFac === null || defFac === null) break;
          lines.push({
            key: entry.id,
            round: entry.round,
            era,
            priority: 2,
            text: line(T_BETRAYAL[variantOf(entry.id)], {
              ...factionSlots(atkFac),
              rival: FACTION_NAME[defFac],
              rival_ruler: FACTION_RULER[defFac],
            }),
          });
        }
        break;
      }

      case "siege": {
        const city = names.provinceName(target);
        if (city === null) break;
        if (data.captured === true) {
          const atkFac = names.factionOf(actor);
          const defFac = names.factionOf(lastDefenderAt.get(target ?? ""));
          if (atkFac !== null && defFac !== null && atkFac !== defFac) {
            lines.push({
              key: entry.id,
              round: entry.round,
              era,
              priority: 1,
              text: line(T_CITY_FALLS[variantOf(entry.id)], {
                ...factionSlots(atkFac),
                city,
                rival: FACTION_NAME[defFac],
              }),
            });
          }
          highlights.push({
            key: entry.id,
            era,
            round: entry.round,
            icon: "siege",
            label: `The storm of ${city}`,
          });
        } else if (data.invested === true) {
          highlights.push({
            key: entry.id,
            era,
            round: entry.round,
            icon: "siege",
            label: `The siege of ${city}`,
          });
        }
        break;
      }

      case "battle": {
        const winnerId = str(data.winnerId);
        const rounds = num(data.rounds) ?? 0;
        const place =
          names.provinceName(target) ?? names.seaName(target) ?? null;
        if (data.sacked === true && place !== null) {
          // A storming capture outside a formal siege: a city falls.
          const atkFac = names.factionOf(actor);
          const defFac = names.factionOf(entry.actors[1]);
          if (atkFac !== null && defFac !== null && atkFac !== defFac) {
            lines.push({
              key: entry.id,
              round: entry.round,
              era,
              priority: 1,
              text: line(T_CITY_FALLS[variantOf(entry.id)], {
                ...factionSlots(atkFac),
                city: place,
                rival: FACTION_NAME[defFac],
              }),
            });
          }
        }
        if (rounds > 0 && winnerId !== null && place !== null) {
          highlights.push({
            key: entry.id,
            era,
            round: entry.round,
            icon: "army",
            label:
              data.naval === true
                ? `The battle upon ${place}`
                : `The battle of ${place}`,
          });
        }
        break;
      }

      case "trade": {
        // A route established: the counting-house closes its fist (the
        // mockup's worked sample uses exactly this moment for the monopoly
        // template — "Venice closes its fist on the trade of Thrace").
        if (num(data.routeIncome) === null || actor === undefined) break;
        if (routeChronicled.has(actor)) break;
        const fac = names.factionOf(actor);
        if (fac === null) break;
        const m = /trade route (.+?)→/.exec(entry.message);
        const province = m?.[1] ?? null;
        if (province === null) break;
        routeChronicled.add(actor);
        // Variant three needs a {rival}; a route names none — use the first
        // two variants (Hungary's neutral coin word reads awkwardly in the
        // second, so Hungary keeps the first).
        const v = fac === Faction.HUNGARY ? 0 : variantOf(entry.id) % 2;
        lines.push({
          key: entry.id,
          round: entry.round,
          era,
          priority: 4,
          text: line(T_MONOPOLY[v], { ...factionSlots(fac), province }),
        });
        break;
      }

      case "prestige_change": {
        const total = num(data.total);
        if (total === null || actor === undefined) break;
        let byPlayer = totalsByRound.get(entry.round);
        if (byPlayer === undefined) {
          byPlayer = new Map<string, number>();
          totalsByRound.set(entry.round, byPlayer);
        }
        byPlayer.set(actor, total);
        break;
      }

      case "build": {
        const greatWork = str(data.greatWork);
        if (greatWork !== null && entry.message.includes("completes")) {
          const place = names.provinceName(target);
          const name = GREAT_WORK_NAME[greatWork] ?? greatWork;
          highlights.push({
            key: entry.id,
            era,
            round: entry.round,
            icon: "marble",
            label: place !== null ? `${name} raised at ${place}` : `${name} raised`,
          });
        }
        break;
      }

      case "event_card": {
        if (data.gatheringOmen !== undefined) break; // a telegraph, not a draw
        const card = OMEN_CARDS.find(
          (c) => !pipSeen.has(c.id) && entry.message.includes(c.name),
        );
        if (card === undefined) break;
        pipSeen.add(card.id);
        pips.push({
          key: entry.id,
          era,
          round: entry.round,
          year: yearForRound(entry.round),
          card,
          art: artFor(card),
          flavor: flavorFor(card),
          reading: entry.message,
          fatal: card.slug === "fall-of-constantinople",
        });
        break;
      }

      default:
        break;
    }
  }

  // ---- Prestige lead changes (from the cleanup summaries) -----------------
  let leader: string | null = null;
  const roundsWithTotals = [...totalsByRound.keys()].sort((a, b) => a - b);
  for (const round of roundsWithTotals) {
    const byPlayer = totalsByRound.get(round)!;
    let best: { id: string; total: number } | null = null;
    let tie = false;
    for (const [id, total] of byPlayer) {
      if (best === null || total > best.total) {
        best = { id, total };
        tie = false;
      } else if (total === best.total) {
        tie = true;
      }
    }
    if (best === null || tie) continue;
    if (leader !== null && best.id !== leader) {
      const newFac = names.factionOf(best.id);
      const oldFac = names.factionOf(leader);
      if (newFac !== null && oldFac !== null) {
        const key = `lead-${round}-${best.id}`;
        lines.push({
          key,
          round,
          era: eraOfRound(round),
          priority: 2,
          text: line(T_LEAD_CHANGE[variantOf(key)], {
            ...factionSlots(newFac),
            rival: FACTION_NAME[oldFac],
            round: toRoman(round),
            prestige: best.total,
          }),
        });
      }
    }
    leader = best.id;
  }

  // ---- Sudden-death closing line ------------------------------------------
  if (kind === "sudden" && winner !== undefined) {
    const key = `sudden-${roundsPlayed}`;
    lines.push({
      key,
      round: roundsPlayed,
      era: eraOfRound(roundsPlayed),
      priority: 0,
      text: line(T_SUDDEN_DEATH[variantOf(key)], {
        faction: FACTION_NAME[winner],
      }),
    });
  }

  // ---- Assemble era chapters ----------------------------------------------
  const erasSpanned = eraOfRound(roundsPlayed);
  const chapters: EraChapter[] = [];
  for (const era of [1, 2, 3] as const) {
    if (era > erasSpanned) break;
    const first = ERA_FIRST_ROUND[era];
    const last = Math.min(ERA_LAST_ROUND[era], roundsPlayed);
    const when =
      first === last
        ? `${ERA_ORDINAL[era]} · Round ${toRoman(first)} · Anno ${yearForRound(first)}`
        : `${ERA_ORDINAL[era]} · Rounds ${toRoman(first)}–${toRoman(last)} · Anno ${yearForRound(first)}–${yearForRound(last)}`;

    const eraLines = lines
      .filter((l) => l.era === era)
      .sort((a, b) => a.priority - b.priority || a.round - b.round)
      .slice(0, MAX_LINES_PER_ERA)
      .sort((a, b) => a.round - b.round);

    const eraHighlights = highlights
      .filter((h) => h.era === era)
      .slice(0, MAX_HIGHLIGHTS_PER_ERA);

    chapters.push({
      era,
      title: ERA_TITLE[era],
      when,
      paragraphs: eraLines.map((l) => l.text),
      highlights: eraHighlights,
    });
  }

  // ---- Era rail pips: the era's most consequential omens ------------------
  const railPips: OmenPip[] = [];
  for (const era of [1, 2, 3] as const) {
    const eraPips = pips.filter((p) => p.era === era);
    const ranked = [...eraPips].sort((a, b) => {
      if (a.fatal !== b.fatal) return a.fatal ? -1 : 1;
      const aArt = a.art !== null ? 0 : 1;
      const bArt = b.art !== null ? 0 : 1;
      if (aArt !== bArt) return aArt - bArt;
      return a.round - b.round;
    });
    railPips.push(
      ...ranked.slice(0, MAX_PIPS_PER_ERA).sort((a, b) => a.round - b.round),
    );
  }

  // ---- The closing plate ---------------------------------------------------
  const fatalPip = railPips.find((p) => p.fatal && p.art !== null);
  const lastArtPip = [...railPips].reverse().find((p) => p.art !== null);
  const platePip = fatalPip ?? lastArtPip ?? null;
  const plate =
    platePip !== null && platePip.art !== null && platePip.flavor !== null
      ? {
          art: platePip.art,
          alt: platePip.card.name,
          caption: platePip.flavor,
        }
      : null;

  // ---- Fixed framing (chronicle.html), numbers parameterised ---------------
  const powers = state.players.filter((p) => p.faction != null).length;
  const years = Math.max(1, yearForRound(roundsPlayed) - 1400);
  const cityFell =
    kind === "sudden" ||
    pips.some((p) => p.fatal);

  const opener =
    `Here begins the true chronicle of ${numberWord(powers)} powers in a ` +
    `failing age, from the first muster to ${
      cityFell ? "the fall of the City" : "the closing of the book"
    }, ${numberWord(roundsPlayed)} rounds in the playing and ${numberWord(years)} ` +
    `years in the telling.`;

  const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const colophon =
    `Here ends the chronicle of this game. ${capitalise(numberWord(roundsPlayed))} ` +
    `rounds were played; ${numberWord(powers)} powers contended; ${
      cityFell ? "one City fell" : "the track judged"
    }. The scribes beg pardon for all errors of the pen.`;

  return {
    opener,
    colophon,
    chapters,
    pips: railPips,
    plate,
    roundsPlayed,
    erasSpanned,
    powers,
    omenCount: railPips.length,
  };
}
