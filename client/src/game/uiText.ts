/**
 * In-voice UI copy, lifted VERBATIM from the narrative contract:
 *   - lore/ui-text.md      (menus, buttons, tooltips, phases, errors, endings)
 *   - design/mockups/game.html (action-bar order labels, phase-track names)
 *
 * RULE: all user-facing text comes from those sources. Add strings here by
 * quoting them exactly; never invent copy where real copy exists. Where the
 * two sources differ (they name the phase track and some orders differently)
 * BOTH are provided and the choice is documented — the mockup labels are what
 * game.html ships, the ui-text names are the chronicle voice.
 */
import { Faction, GamePhase } from "@imperium/shared";
import type { OrderKind } from "./types";

/** Faction display names (lore/ui-text.md §2 faction seats). */
export const FACTION_NAME: Record<Faction, string> = {
  [Faction.BYZANTIUM]: "Byzantium",
  [Faction.OTTOMAN]: "The Ottomans",
  [Faction.VENICE]: "Venice",
  [Faction.GENOA]: "Genoa",
  [Faction.HUNGARY]: "Hungary",
};

/* --------------------------------------------------------------------------
 * Phases. The engine has six play phases; the display track (game.html §2)
 * shows five steps: Income · Muster · Campaign · Council · Twilight.
 * Engine order: INCOME -> RECRUITMENT -> MOVEMENT -> DIPLOMACY -> COMBAT -> END,
 * so COMBAT (battle resolution) maps onto step 3 alongside DIPLOMACY to keep
 * the track monotonic (it never jumps backwards mid-round).
 * ------------------------------------------------------------------------ */

/** The five display steps of the phase track, in order (game.html). */
export const PHASE_TRACK_STEPS = [
  "Income",
  "Muster",
  "Campaign",
  "Council",
  "Twilight",
] as const;

/** Engine phase -> phase-track step index (0..4); LOBBY -> -1. */
export const PHASE_STEP_INDEX: Record<GamePhase, number> = {
  [GamePhase.LOBBY]: -1,
  [GamePhase.INCOME]: 0,
  [GamePhase.RECRUITMENT]: 1,
  [GamePhase.MOVEMENT]: 2,
  [GamePhase.DIPLOMACY]: 3,
  [GamePhase.COMBAT]: 3,
  [GamePhase.END]: 4,
};

/** Chronicle-voice phase names (lore/ui-text.md §6). */
export const PHASE_NAME: Record<GamePhase, string> = {
  [GamePhase.LOBBY]: "The Powers Assemble",
  [GamePhase.INCOME]: "The Reckoning",
  [GamePhase.RECRUITMENT]: "The Levy",
  [GamePhase.MOVEMENT]: "The March",
  [GamePhase.DIPLOMACY]: "The Court",
  [GamePhase.COMBAT]: "The March",
  [GamePhase.END]: "The Chronicle",
};

/** Phase banners, shown as each phase opens (lore/ui-text.md §6). */
export const PHASE_BANNER: Partial<Record<GamePhase, string>> = {
  [GamePhase.INCOME]: "The Reckoning begins. Count what the realm has gathered.",
  [GamePhase.RECRUITMENT]: "The Levy is called. Raise your hosts.",
  [GamePhase.MOVEMENT]: "The March is upon us. Let the banners move.",
  [GamePhase.DIPLOMACY]: "The Court is in session. Let ambassadors speak.",
  [GamePhase.END]: "The Chronicle is written. The round is ended.",
};

/** Turn banners (lore/ui-text.md §6). `TURN_BANNER_OTHER(faction)` varies. */
export const TURN_BANNER_MINE = "It is your turn. The realm awaits your word.";
export function turnBannerFor(factionName: string): string {
  return `The turn passes to ${factionName}.`;
}

/* --------------------------------------------------------------------------
 * Action bar orders (design/mockups/game.html callout 11 — the eight orders)
 * with their hover glosses (title attributes from the same file).
 * ------------------------------------------------------------------------ */
export const ORDER_LABEL: Record<OrderKind, string> = {
  muster: "Muster",
  march: "March",
  raise: "Raise",
  traffic: "Traffic",
  parley: "Parley",
  whisper: "Whisper",
  stratagem: "Play a Stratagem",
};

export const ORDER_GLOSS: Record<OrderKind, string> = {
  muster: "Recruit levies in a province you hold",
  march: "Move a host or fleet",
  raise: "Raise walls, harbors and holy houses",
  traffic: "Trade on the routes and in the counting-house",
  parley: "Send envoys; make and break pacts",
  whisper: "Set your agents listening at a rival's court",
  stratagem: "Play a tactic card from your hand",
};

export const YIELD_LABEL = "Yield the Floor";
export const YIELD_GLOSS = "End your turn; the council passes to the next throne";

/** Common button labels (lore/ui-text.md §3). */
export const BUTTONS = {
  confirm: "So Be It",
  cancel: "Think Again",
  endTurn: "Rest the Banner",
  undo: "Recall the Order",
  pass: "Hold, and Watch",
  continue: "Onward",
  back: "Return",
  close: "Draw the Curtain",
  setTheSeal: "Set the Seal",
} as const;

/* --------------------------------------------------------------------------
 * Resource & prestige tooltips (lore/ui-text.md §4) — one line each.
 * ------------------------------------------------------------------------ */
export const RESOURCE_TOOLTIP = {
  gold: "The treasury's lifeblood. It pays the levies, buys the peace, and quiets the discontented — ducats, hyperpyra, or akçe, all melt to the same use.",
  grain:
    "The bread of hosts and cities alike. Empty granaries breed thin soldiers and thinner loyalty.",
  timber:
    "Keel and siege-engine, rafter and palisade — whatever a realm would build, sail, or batter down begins in the woodyard.",
  marble:
    "Cut for churches, monuments, and the tombs of the great — the stone in which a crown writes its name for the ages.",
  faith:
    "Piety and the right to rule, bound as one. It hallows a crown, blesses a war, and steadies a people when the walls shake.",
  prestige:
    "Your renown before God and history. Cities won, foes humbled, and faith upheld raise your standing; the crown of greatest Prestige when the years run out is remembered above all others.",
} as const;

/* --------------------------------------------------------------------------
 * Rejection copy. The server's action_rejected carries {reason, code?}.
 * Where an engine code has a matching line in lore/ui-text.md §7, show that
 * line; otherwise fall back to the server's reason text.
 * ------------------------------------------------------------------------ */
export const ACTION_ERROR_COPY: Readonly<Partial<Record<string, string>>> = {
  NO_ACTIONS: "You have spent your deeds this round. Rest the banner.",
  NOT_YOUR_TURN: "This deed is not yours to do — the turn belongs to another.",
  NOT_ADJACENT: "No path leads a host from here to there.",
  BAD_MOVE: "No path leads a host from here to there.",
  INSUFFICIENT_MOVEMENT: "That province lies too far for one march.",
  NO_TARGET: "There is no worthy target within reach.",
  BAD_TARGET: "There is no worthy target within reach.",
  INVALID_TARGET: "There is no worthy target within reach.",
  // TREASON_GATE is the engine's treason-at-the-gate SIEGE-TACTIC brake
  // (server/src/engine/tactics.ts::assertTreasonGate): garrison too strong to
  // suborn, or the siege laid too early. Voice follows TacticPanel's withheld
  // lines — it has nothing to do with truces.
  TREASON_GATE:
    "Treason finds no purchase at this gate — the garrison stands too strong to be suborned, or the siege was laid too early for a gatekeeper to turn his coat.",
  NO_TREATY: "You hold no pact with that crown to break.",
};

/** action_rejected -> the line the toast shows. */
export function rejectionCopy(reason: string, code?: string): string {
  if (code !== undefined) {
    const mapped = ACTION_ERROR_COPY[code];
    if (mapped !== undefined) return mapped;
  }
  return reason;
}

/** Connection copy (lore/ui-text.md §7, "The table & connection"). */
export const CONNECTION = {
  lost: "The herald cannot reach the table — the connection is lost.",
  restored: "The messenger returns; the table is restored.",
  waiting: "You wait upon another court. Be patient.",
} as const;

/* --------------------------------------------------------------------------
 * Victory / defeat (lore/ui-text.md §8–§9).
 * ------------------------------------------------------------------------ */
export const VICTORY = {
  heading: "The Years Are Run — and You Stand First",
  body: "Constantinople has met its hour, and the age of empires turns.\nWhen the dust of these fifty years settled, no crown shone brighter than yours.\nYour cities endured, your foes bent the knee, and your renown outlasted them all.\n\nThe chronicle closes with your name at its head. So it will be remembered.",
  footer: "Greatest in Prestige. Sovereign of the Twilight.",
  closeButton: "Close the Book",
  chronicleButton: "Read the Chronicle",
} as const;

export const DEFEAT = {
  headingEliminated: "Your Banner Is Struck",
  bodyEliminated:
    "Your last city has fallen and your hosts are scattered to the wind.\nThe lands that bore your crown now answer to another.\nHistory is unkind to the vanquished; it will spare you but a line.",
  headingOutshone: "The Years Are Run",
  bodyOutshone:
    "Constantinople has met its hour, and the age of empires turns.\nYou endured to the end — no small thing — yet a brighter crown eclipsed your own.\nAnother name stands first in the chronicle. Yours is set down beneath it.",
  footer: "Take heart. Empires fall, and are raised again.",
  closeButton: "Close the Book",
  chronicleButton: "Read the Chronicle",
} as const;
