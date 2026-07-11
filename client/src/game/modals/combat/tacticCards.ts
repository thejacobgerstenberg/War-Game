/**
 * Client-side tactic-card catalog for the battle modal (combat feature area).
 *
 * COPY PROVENANCE: `name`, `flavor` and `effect` are quoted VERBATIM from
 * lore/tactics/cards.md (the narrative contract for the 24-card tactic deck).
 * Mechanics metadata (`timing`, `domain`, `side`, costs) MIRRORS the ratified
 * engine data in server/src/engine/tactics/cards.ts — the server stays
 * authoritative (an illegal play is rejected there); this metadata only drives
 * the playable/withheld presentation of the hand inside a battle.
 * NEVER import server code into the client (HANDOFF §1).
 */
import type { TacticCardId } from "@imperium/shared";

/** When a tactic may be committed (engine `TacticCard.timing`). */
export type TacticTiming =
  | "battle"
  | "assault"
  | "siege"
  | "play-card"
  | "reaction"
  | "move";

/** Battle domain a tactic is legal in (engine `TacticEffectData.domain`). */
export type TacticDomain = "land" | "fleet" | "siege" | "any";

export interface TacticCardInfo {
  id: string;
  name: string;
  /** One line of italic flavor (lore/tactics/cards.md, verbatim). */
  flavor: string;
  /** The printed effect line (lore/tactics/cards.md, verbatim). */
  effect: string;
  tier: "common" | "uncommon" | "rare";
  timing: TacticTiming;
  domain?: TacticDomain;
  /** Which battle role may commit it (absent = either side). */
  side?: "attacker" | "defender";
  costGold?: number;
  costFaith?: number;
}

export const TACTIC_INFO: Record<string, TacticCardInfo> = {
  "forced-march": {
    id: "forced-march",
    name: "Forced March",
    flavor: "The drums sounded before dawn, and the column ate two days' road in one.",
    effect:
      "One of your hosts moves 1 additional province this turn; it may not lay siege on arrival.",
    tier: "common",
    timing: "move",
  },
  "veterans-of-the-border": {
    id: "veterans-of-the-border",
    name: "Veterans of the Border",
    flavor: "They had fought on this ground before, and the ground remembered them.",
    effect: "Add 1 die to one of your hosts in a single land battle.",
    tier: "common",
    timing: "battle",
    domain: "land",
  },
  "pilot-of-the-narrows": {
    id: "pilot-of-the-narrows",
    name: "The Pilot of the Narrows",
    flavor: "He had run the strait in fog and in dark, and knew where the current turned.",
    effect: "Add 1 die in a single fleet battle.",
    tier: "common",
    timing: "battle",
    domain: "fleet",
  },
  "ladders-and-fascines": {
    id: "ladders-and-fascines",
    name: "Ladders and Fascines",
    flavor: "The ditch was filled by night; by morning the ladders stood against the sky.",
    effect: "Reroll one of your dice in a single siege assault round.",
    tier: "common",
    timing: "assault",
    domain: "siege",
  },
  "the-counting-house": {
    id: "the-counting-house",
    name: "A Good Season at the Counting-House",
    flavor: "The ledgers closed fat that year, and the factor permitted himself one smile.",
    effect: "Gain 2 Gold when played.",
    tier: "common",
    timing: "play-card",
  },
  "grain-barges-of-the-danube": {
    id: "grain-barges-of-the-danube",
    name: "Grain Barges of the Danube",
    flavor: "The barges rode low in the water, heavy with the harvest of the plain.",
    effect: "Gain 2 Grain when played.",
    tier: "common",
    timing: "play-card",
  },
  "ears-in-the-bazaar": {
    id: "ears-in-the-bazaar",
    name: "Ears in the Bazaar",
    flavor: "Every price in the market was known to him, and some of those prices were men.",
    effect: "Look at all tactic cards held by one rival.",
    tier: "common",
    timing: "play-card",
  },
  "locked-shields": {
    id: "locked-shields",
    name: "Locked Shields",
    flavor: "The line bent, and held, and the charge broke on it like water on stone.",
    effect: "When one of your hosts defends in a land battle, reroll your lowest die.",
    tier: "common",
    timing: "battle",
    domain: "land",
    side: "defender",
  },
  "feigned-retreat": {
    id: "feigned-retreat",
    name: "Feigned Retreat",
    flavor: "They fled just badly enough to be believed.",
    effect:
      "In one land battle, before hits are dealt, withdraw your host in good order to an adjacent province you control; the battle ends.",
    tier: "uncommon",
    timing: "battle",
    domain: "land",
  },
  "night-sortie": {
    id: "night-sortie",
    name: "Night Sortie",
    flavor: "The gate opened without a torch, and the besiegers' fires went out one by one.",
    effect:
      "For one round, siege attrition falls upon the besieger instead of the besieged.",
    tier: "uncommon",
    timing: "siege",
    domain: "siege",
    side: "defender",
  },
  "bribed-gatekeeper": {
    id: "bribed-gatekeeper",
    name: "The Bribed Gatekeeper",
    flavor: "His price was forty ducats and a fast horse. The wall's price was higher.",
    effect: "Cancel the wall bonus for one round of a siege you are pressing.",
    tier: "uncommon",
    timing: "assault",
    domain: "siege",
    side: "attacker",
  },
  "chain-across-the-horn": {
    id: "chain-across-the-horn",
    name: "The Chain Across the Horn",
    flavor: "Iron lay across the water, and the whole sea stopped to consider it.",
    effect:
      "One port province you hold cannot be attacked by sea until the start of your next turn.",
    tier: "uncommon",
    timing: "play-card",
  },
  "condottieri-contract": {
    id: "condottieri-contract",
    name: "Condottieri Contract",
    flavor:
      "He read the contract twice, signed it once, and fought precisely as long as he was paid.",
    effect: "Spend 2 Gold: add 2 dice to one of your hosts in a single land battle.",
    tier: "uncommon",
    timing: "battle",
    domain: "land",
    costGold: 2,
  },
  "papal-indulgence": {
    id: "papal-indulgence",
    name: "Papal Indulgence",
    flavor: "Grace, the legate explained, had a schedule of fees.",
    effect: "Spend 2 Gold: gain 3 Faith.",
    tier: "uncommon",
    timing: "play-card",
    costGold: 2,
  },
  "the-intercepted-letter": {
    id: "the-intercepted-letter",
    name: "The Intercepted Letter",
    flavor: "The courier reached the wrong camp — which was, for somebody, the right one.",
    effect: "Cancel a tactic card as a rival plays it; discard both cards.",
    tier: "uncommon",
    timing: "reaction",
  },
  "the-hexamilion-manned": {
    id: "the-hexamilion-manned",
    name: "The Hexamilion Manned",
    flavor:
      "Six miles of stone across the Isthmus, and for one night every yard of it awake.",
    effect:
      "One of your hosts defending a province gains the wall bonus for a single land battle.",
    tier: "uncommon",
    timing: "battle",
    domain: "land",
    side: "defender",
  },
  "greek-fire": {
    id: "greek-fire",
    name: "Greek Fire",
    flavor: "The sea itself burned, and water would not put it out.",
    effect:
      "Win one fleet battle outright, before any dice are cast; then discard this card.",
    tier: "rare",
    timing: "battle",
    domain: "fleet",
  },
  "master-founders-hired": {
    id: "master-founders-hired",
    name: "Master Founders Hired",
    flavor:
      "Men who cast thunder in bronze did not come cheap; the treasury paid, and did not haggle.",
    effect:
      "In one siege, cancel the wall bonus for one full round and add 1 die to your assault.",
    tier: "rare",
    timing: "assault",
    domain: "siege",
    side: "attacker",
  },
  "treason-at-the-gate": {
    id: "treason-at-the-gate",
    name: "Treason at the Gate",
    flavor: "The Kerkoporta stood open a hand's breadth, and an empire passed through it.",
    effect:
      "End a siege you have pressed for at least 2 rounds: the province falls without a final assault; then discard this card.",
    tier: "rare",
    timing: "siege",
    domain: "siege",
    side: "attacker",
    costGold: 4,
  },
  "the-pay-chest-taken": {
    id: "the-pay-chest-taken",
    name: "The Pay Chest Taken",
    flavor: "The escort was loyal; the road was long; the chest was very heavy.",
    effect: "Take 3 Gold from one rival's treasury and add it to your own.",
    tier: "rare",
    timing: "play-card",
  },
  "holy-war-proclaimed": {
    id: "holy-war-proclaimed",
    name: "Holy War Proclaimed",
    flavor:
      "Rome preached the cross, the Porte proclaimed the ghaza, and Heaven was claimed by every banner in the field.",
    effect:
      "Spend 2 Faith: all your hosts add 1 die in every battle until the start of your next turn.",
    tier: "rare",
    timing: "battle",
    domain: "any",
    costFaith: 2,
  },
  "sails-from-the-west": {
    id: "sails-from-the-west",
    name: "Sails from the West",
    flavor: "Four hulls against a hundred, and the wind, for once, chose the four.",
    effect:
      "Play when a port province you hold is under siege: siege attrition ceases this round, and you gain 2 Grain.",
    tier: "rare",
    timing: "siege",
    domain: "siege",
    side: "defender",
  },
  "a-death-in-the-palace": {
    id: "a-death-in-the-palace",
    name: "A Death in the Palace",
    flavor: "The drums fell silent at Adrianople, and every war paused to count the heirs.",
    effect:
      "Name one rival: a truce holds between you until the start of your next turn; no new battles or sieges may begin between your forces and theirs.",
    tier: "rare",
    timing: "play-card",
  },
  "the-white-knights-stroke": {
    id: "the-white-knights-stroke",
    name: "The White Knight's Stroke",
    flavor: "Where his banner turned, the battle turned with it.",
    effect: "In one land battle, reroll all of your dice once; keep the second result.",
    tier: "rare",
    timing: "battle",
    domain: "land",
  },
};

/** Catalog lookup with a face-value fallback for slugs the catalog lacks. */
export function tacticInfo(id: TacticCardId | string): TacticCardInfo {
  return (
    TACTIC_INFO[id] ?? {
      id,
      name: String(id)
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
      flavor: "",
      effect: "",
      tier: "common",
      timing: "battle",
    }
  );
}
