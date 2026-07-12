/**
 * VENDORED from server/src/bots/personality.ts @ 9009d5262afd983392c565e1d5e51bbdf31da92b
 * (PR #27 "Server: AI opponents", branch feature/ai-opponents — not on main yet).
 * Local changes: (1) engine imports rewritten to the offline engine shim;
 * (2) `.coastal` -> `.port` (main #28 renamed Province.coastal to Province.port);
 * (3) nothing else. Do not add logic here; upstream replaces this after #27 merges.
 */
/**
 * Faction personas for AI opponents.
 *
 * Ruler names, mottos and advisor voices come verbatim from
 * `lore/factions/*.md` (origin/main — the "Ruler (c.1440)" and advisor
 * sample-line sections). Bots are seated under their ruler's name; advisor
 * lines are ready-made table-talk the client MAY render (see
 * {@link import("./types.js").AdvisorLine}).
 *
 * `biases` are POLICY-VISIBLE numeric knobs: policies read them to skew
 * decisions per faction (they are hints, never hard rules — a policy stays
 * free to ignore them). Difficulty-conditional quirks (e.g. the Ottoman
 * Constantinople obsession) are flagged here and gated on
 * {@link import("./types.js").Difficulty} inside the policy.
 */
import { Faction } from "@imperium/shared";
import type { BotRng } from "./rng.js";
import type { AdvisorLine, AdvisorSituation } from "./types.js";

/**
 * Numeric decision biases, all hints in [0, 1] unless noted. Policies decide
 * how (and whether) to apply them.
 */
export interface PersonaBiases {
  /** Eagerness to DECLARE_WAR / attack (0 = never willingly, 1 = rusher). */
  warAppetite: number;
  /**
   * Preference for buying enemies off (tribute treaties, vassal marriage
   * bribes) over fighting them. Byzantium's signature move.
   */
  tributePreference: number;
  /** Weight on trade routes/markets and on defending them once owned. */
  tradeFocus: number;
  /** Weight on walls/garrisons/home defence. */
  defensiveness: number;
  /**
   * Favor wars carrying a "crusade" justification (Hungary: strike when the
   * crusade window opens rather than at raw odds).
   */
  crusadePreference: number;
  /**
   * HARD only: Ottoman bots prioritise besieging Constantinople in Era III
   * when it is militarily sane. Ignored below HARD.
   */
  constantinopleObsession: boolean;
}

/** A full faction persona: identity + biases + advisor voice. */
export interface FactionPersona {
  faction: Faction;
  /** Bot display name in the lobby (fits PLAYER_NAME_MAX_LENGTH). */
  rulerName: string;
  /** One-line persona, from the lore "Ruler (c.1440)" blurb. */
  epithet: string;
  motto: string;
  /** The advisor who voices this bot's table-talk. */
  advisorName: string;
  biases: PersonaBiases;
  /** Situation-keyed advisor lines (verbatim from lore sample lines). */
  advisorLines: Partial<Record<AdvisorSituation, readonly string[]>>;
}

/** Persona table, one per faction. */
export const PERSONAS: Record<Faction, FactionPersona> = {
  [Faction.BYZANTIUM]: {
    faction: Faction.BYZANTIUM,
    rulerName: "John VIII Palaiologos",
    epithet:
      "Basileus and Autokrator of the Romans — heir to a thousand years, master of a single city.",
    motto: "The purple fades; the walls do not.",
    advisorName: "Demetrios Choumnos",
    biases: {
      warAppetite: 0.15,
      tributePreference: 0.9,
      tradeFocus: 0.4,
      defensiveness: 0.9,
      crusadePreference: 0.2,
      constantinopleObsession: false,
    },
    advisorLines: {
      low_gold: [
        "The treasury is a rumor, my lord. We have taxed the icons; soon we must sell their frames.",
      ],
      war_declared_on_you: [
        "War, then. Another creditor at the gate, this one armed. I will find the coin we do not have.",
      ],
      siege_begun: [
        "They dig their lines before the walls. Sieges are patient, my lord; so, God willing, are we.",
      ],
      ally_betrayed_you: [
        "Our friend has read the ledger and found us wanting. Betrayal is only arithmetic done early.",
      ],
      victory_near: [
        "Renown gathers at last. Strange, to weigh triumph on scales so long tipped toward ruin.",
      ],
      event_struck: [
        "Fresh tidings, and none of them cheap. I have learned to fear a courier's smile.",
      ],
      idle: [
        "The ledgers balance today, my lord — a small miracle, dutifully recorded.",
      ],
    },
  },
  [Faction.OTTOMAN]: {
    faction: Faction.OTTOMAN,
    rulerName: "Murad II",
    epithet:
      "Sultan of the ghazis — a cultured prince who would sooner read than reign; the crescent will not let him.",
    motto: "The crescent climbs; the Red Apple falls.",
    advisorName: "Yakub Pasha",
    biases: {
      warAppetite: 0.8,
      tributePreference: 0.3,
      tradeFocus: 0.3,
      defensiveness: 0.4,
      crusadePreference: 0.1,
      constantinopleObsession: true,
    },
    advisorLines: {
      low_gold: [
        "The treasury runs thin, my Sultan. Delay a season; the akçe fills faster than haste can spend it.",
      ],
      war_declared_on_you: [
        "War is declared upon us. Good — let them tire on the road; we take the field rested.",
      ],
      siege_begun: [
        "The siege is laid. A wall is patience made stone, my Sultan; outlast it, and the gate opens.",
      ],
      ally_betrayed_you: [
        "Our ally has broken faith. Note the name; the Porte keeps a long ledger, and collects in its own season.",
      ],
      victory_near: [
        "Victory nears, my Sultan. Do not grasp — receive. Ripe fruit falls to the steady, patient hand.",
      ],
      event_struck: [
        "The world shifts, my Sultan. A wise vizier does not curse the wind; he sets his sail to it.",
      ],
      idle: [
        "The frontier is quiet, my Sultan. Quiet is a bowstring drawn — hold it, and choose the moment.",
      ],
    },
  },
  [Faction.VENICE]: {
    faction: Faction.VENICE,
    rulerName: "Francesco Foscari",
    epithet:
      "Doge of Venice — the merchant-prince who made the Republic a power on land as well as at sea.",
    motto: "Venetians first, then Christians.",
    advisorName: "Sier Marco Barbo",
    biases: {
      warAppetite: 0.35,
      tributePreference: 0.4,
      tradeFocus: 0.95,
      defensiveness: 0.5,
      crusadePreference: 0.15,
      constantinopleObsession: false,
    },
    advisorLines: {
      low_gold: [
        "The treasury thins? A wealthy traitor will be found, and his estate will settle the account.",
      ],
      war_declared_on_you: [
        "War, and declared aloud? The work of men who wish to be seen. We prefer the sealed letter, the quiet vote, the man who does not return.",
      ],
      siege_begun: [
        "They dig their lines? Let them. The Ten dig within. Every gate has its price, and I am counting.",
      ],
      ally_betrayed_you: [
        "Your friend turned his coat. Note the name; I already have. Betrayal keeps, my lord. So do we.",
      ],
      victory_near: [
        "Renown within reach. Say nothing, sign nothing in daylight. It is at the very end that friends grow knives.",
      ],
      event_struck: [
        "A rumor reached the lion's mouth before it reached you. Do not ask how. Ask only what I advise.",
      ],
      idle: [
        "The convoys sail on time, my lord. When the sea is this calm, someone, somewhere, is paying for it.",
      ],
    },
  },
  [Faction.GENOA]: {
    faction: Faction.GENOA,
    rulerName: "Tommaso di Campofregoso",
    epithet:
      "Doge of Genoa — a Fregoso risen twice to the ducal chair in a city that trusts no ruler for long.",
    motto: "La Superba bows to none but the ledger.",
    advisorName: "Niccolò Spinola",
    biases: {
      warAppetite: 0.25,
      tributePreference: 0.5,
      tradeFocus: 0.95,
      defensiveness: 0.55,
      crusadePreference: 0.1,
      constantinopleObsession: false,
    },
    advisorLines: {
      low_gold: [
        "The treasury thins, my lord. Pera's customs still flow; lean on the Horn, not the harvest.",
      ],
      war_declared_on_you: [
        "War, and us wedged between Greek and Turk. I will keep Pera's gates open to both, and neither.",
      ],
      siege_begun: [
        "They ring the walls. Pera has weathered worse by smiling at besiegers and selling them bread.",
      ],
      ally_betrayed_you: [
        "Our friend turns coat. Here on the Horn, my lord, every neighbor is a friend until the tide turns.",
      ],
      victory_near: [
        "Renown ripens. Let me raise our banner over Pera slowly — the Sultan watches the Horn as closely as we.",
      ],
      event_struck: [
        "Fresh word across the water, my lord. On this shore, news is coin; I trade in it daily.",
      ],
      idle: [
        "Every account is kept, my lord. A city that trusts no ruler must at least trust the arithmetic.",
      ],
    },
  },
  [Faction.HUNGARY]: {
    faction: Faction.HUNGARY,
    rulerName: "Vladislaus I",
    epithet:
      "Boy-king of Hungary and Poland — the war is fought in his name, by another's hand.",
    motto: "The shield of Christendom holds the Danube.",
    advisorName: "John Hunyadi",
    biases: {
      warAppetite: 0.7,
      tributePreference: 0.2,
      tradeFocus: 0.25,
      defensiveness: 0.6,
      crusadePreference: 0.95,
      constantinopleObsession: false,
    },
    advisorLines: {
      low_gold: [
        "The treasury is empty, sire. So is my patience. A soldier fights on bread, not on promises.",
      ],
      war_declared_on_you: [
        "War, sire. Good. I would rather meet the Turk on the field than wait for him at Buda.",
        "Let them come, sire. The marches are my country; every pass is a trap I have already set.",
      ],
      siege_begun: [
        "The siege is set, sire. Walls fall to hunger sooner than to storm. Time is all I ask.",
        "They sit behind their walls, sire, and think stone is safety. Stone is a slower grave. Tighten the lines.",
      ],
      ally_betrayed_you: [
        "Betrayed, sire? Then I have one fewer man to thank and one more score to settle. Mark the name.",
      ],
      victory_near: [
        "The field is nearly ours, sire. Do not sound the recall now — a broken host that runs is destroyed.",
        "One more charge, sire, and the crescent breaks. I have waited my whole life for a day like this.",
      ],
      event_struck: [
        "The world has shifted under us, sire. I do not read omens. I read ground, and it still holds.",
      ],
      idle: [
        "My border riders know every ford from Belgrade to the Iron Gates. Point me at the Turk and stand aside.",
        "I do not fear the Turk, sire. I have beaten him in the snow and the mud. I will again.",
      ],
    },
  },
};

/** Look up the persona for a faction. */
export function personaForFaction(faction: Faction): FactionPersona {
  return PERSONAS[faction];
}

/**
 * Draw a deterministic advisor line for a situation (undefined when the
 * persona has no line for it). The draw consumes from `rng`, so pass a
 * dedicated split stream (e.g. `rng.split("advisor")`) to keep decision
 * streams unaffected by table-talk.
 */
export function advisorLineFor(
  persona: FactionPersona,
  playerId: string,
  situation: AdvisorSituation,
  rng: BotRng,
): AdvisorLine | undefined {
  const lines = persona.advisorLines[situation];
  if (!lines || lines.length === 0) return undefined;
  const text = rng.pick(lines);
  if (text === undefined) return undefined;
  return {
    playerId,
    faction: persona.faction,
    speaker: persona.advisorName,
    situation,
    text,
  };
}
