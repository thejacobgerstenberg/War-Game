/**
 * Client-side tactic-card registry — cards area.
 *
 * PROVENANCE (all copy is real, nothing invented):
 *  - id / name / tier / timing / effect: transcribed VERBATIM from the
 *    engine's ratified deck, server/src/engine/tactics/cards.ts (the client
 *    must never import server code). The effect lines there are the RATIFIED
 *    rules text (lore/tactics/cards.md's effect lines were "proposed —
 *    design to ratify"; the engine table is what actually resolves).
 *  - flavor: parsed at module load from
 *    client/src/assets/cards/tactic-cards.md, a byte-copy of
 *    lore/tactics/cards.md (the italic line under each card name).
 *  - frame: client/src/assets/cards/tactic-card.svg is a byte-copy of
 *    art/cards/tactic-card.svg (CC0, feature/visual-assets).
 */
import type { TacticCardId } from "@imperium/shared";
import { asTacticCardId } from "@imperium/shared";
import tacticLoreRaw from "../../assets/cards/tactic-cards.md?raw";
import tacticFrameRaw from "../../assets/cards/tactic-card.svg?raw";
import { frameToUrl } from "./eventCardData";

export type TacticTier = "common" | "uncommon" | "rare";

export interface TacticCardEntry {
  id: TacticCardId;
  name: string;
  tier: TacticTier;
  /** When it may be played (engine timing key). */
  timing: "move" | "battle" | "assault" | "siege" | "play-card" | "reaction";
  /** Ratified printed effect (verbatim from the engine deck). */
  effect: string;
  /** True for cards that leave the game after resolving. */
  removedFromGameOnPlay?: boolean;
}

/**
 * The tactic hand limit (engine balance.TACTIC_HAND_LIMIT = 3; mirrored here
 * because the client may not import server code). Pruning to the limit is
 * server-side at Cleanup — the tray only narrates it.
 */
export const TACTIC_HAND_LIMIT = 3;

 
const T: ReadonlyArray<[string, string, TacticTier, TacticCardEntry["timing"], string, boolean?]> = [
  ["forced-march", "Forced March", "common", "move", "Rider on one of your Move actions: that army moves +1 province; it may not Besiege or Assault this round."],
  ["veterans-of-the-border", "Veterans of the Border", "common", "battle", "One land battle: your side rolls +1 die in each melee step."],
  ["pilot-of-the-narrows", "The Pilot of the Narrows", "common", "battle", "One fleet battle: your side rolls +1 die in each melee step."],
  ["ladders-and-fascines", "Ladders and Fascines", "common", "assault", "In one round of a siege assault, reroll one of your dice."],
  ["the-counting-house", "A Good Season at the Counting-House", "common", "play-card", "Gain 2 gold."],
  ["grain-barges-of-the-danube", "Grain Barges of the Danube", "common", "play-card", "Gain 2 grain."],
  ["ears-in-the-bazaar", "Ears in the Bazaar", "common", "play-card", "Look at all tactic cards held by one rival."],
  ["locked-shields", "Locked Shields", "common", "battle", "One land battle in which you defend: reroll your lowest die in each melee step."],
  ["feigned-retreat", "Feigned Retreat", "uncommon", "battle", "At the start of any battle round, before dice: withdraw your whole stack to an adjacent friendly or empty province. The battle ends; no pursuit."],
  ["night-sortie", "Night Sortie", "uncommon", "siege", "One round of a siege against your city: the garrison suffers no store depletion or hunger loss; instead the besieger loses 1 unit (weakest first)."],
  ["bribed-gatekeeper", "The Bribed Gatekeeper", "uncommon", "assault", "One assault you launch this round: the defender's wall bonus is 0 (Wall HP unchanged; escalade -1 still applies)."],
  ["chain-across-the-horn", "The Chain Across the Horn", "uncommon", "play-card", "One coastal province you hold cannot be the target of an amphibious assault until the start of your next turn."],
  ["condottieri-contract", "Condottieri Contract", "uncommon", "battle", "Pay 2 gold: one land battle — your side rolls +2 dice in each melee step."],
  ["papal-indulgence", "Papal Indulgence", "uncommon", "play-card", "Pay 2 gold: gain 3 faith (the sole sanctioned gold->faith conversion)."],
  ["the-intercepted-letter", "The Intercepted Letter", "uncommon", "reaction", "Reaction — play as a rival plays a tactic card: cancel it. Both cards are discarded."],
  ["the-hexamilion-manned", "The Hexamilion Manned", "uncommon", "battle", "One land battle you defend in an unwalled province: gain defender +2 (a temporary T2-grade wall bonus; creates no Wall HP; does not stack with real walls)."],
  ["greek-fire", "Greek Fire", "rare", "battle", "Before dice in a fleet battle you are fighting: win it outright — all enemy naval units in the zone are destroyed. Then discard one other tactic card from your hand and remove this card from the game.", true],
  ["treason-at-the-gate", "Treason at the Gate", "rare", "siege", "Pay 4 gold. Play on a walled city you have besieged for 2+ consecutive rounds: the city falls without an assault — its garrison surrenders and you occupy it, walls at current HP. Remove this card from the game.", true],
  ["the-pay-chest-taken", "The Pay Chest Taken", "rare", "play-card", "Take up to 3 gold from one rival's treasury (never more than they hold)."],
  ["holy-war-proclaimed", "Holy War Proclaimed", "rare", "play-card", "Pay 2 faith: until the start of your next turn, your side rolls +1 die in each melee step of every battle you fight."],
  ["sails-from-the-west", "Sails from the West", "rare", "siege", "Play while a coastal city you hold is besieged: this round its stores do not deplete and it takes no hunger loss — even under full naval blockade — and restore 2 depleted grain stores."],
  ["a-death-in-the-palace", "A Death in the Palace", "rare", "play-card", "Name one rival: a truce binds you both until the start of your next turn — neither may declare a new battle, assault, or siege against the other."],
  ["the-white-knights-stroke", "The White Knight's Stroke", "rare", "battle", "In one round of a land battle, reroll any of your dice once (keep the second results)."],
  ["master-founders-hired", "Master Founders Hired", "rare", "assault", "In one siege, cancel the wall bonus for one full round and add 1 die to your assault."],
];
 

/** The 24 tactic designs, in deck order (common → uncommon → rare). */
export const TACTIC_CARDS: TacticCardEntry[] = T.map(
  ([slug, name, tier, timing, effect, removedFromGameOnPlay]) => ({
    id: asTacticCardId(slug),
    name,
    tier,
    timing,
    effect,
    removedFromGameOnPlay,
  }),
);

/** Slug → design lookup. */
export const TACTIC_CARD_BY_ID: Record<string, TacticCardEntry> = Object.fromEntries(
  TACTIC_CARDS.map((c) => [c.id, c]),
);

/* --------------------------------------------------------------------------
 * Flavor — the italic line under each `### \`slug\`` heading of the vendored
 * lore/tactics/cards.md byte-copy, verbatim by construction.
 * ------------------------------------------------------------------------ */
function parseTacticFlavor(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const sections = raw.split(/\n### `/).slice(1);
  for (const section of sections) {
    const slugEnd = section.indexOf("`");
    if (slugEnd === -1) continue;
    const slug = section.slice(0, slugEnd);
    // The flavor line is the first *italic* (not **bold**) line of the block.
    const line = section
      .split("\n")
      .find((l) => /^\*[^*].*\*$/.test(l.trim()));
    if (line !== undefined) out[slug] = line.trim().replace(/^\*|\*$/g, "");
  }
  return out;
}

const TACTIC_FLAVOR_BY_SLUG: Record<string, string> = parseTacticFlavor(tacticLoreRaw);

/** Flavor line for a tactic card (verbatim lore/tactics/cards.md), if any. */
export function tacticFlavorFor(id: string): string | null {
  return TACTIC_FLAVOR_BY_SLUG[id] ?? null;
}

/** The tactic-card frame (art/cards/tactic-card.svg), placeholder-stripped. */
export const TACTIC_FRAME_URL: string = frameToUrl(tacticFrameRaw);
