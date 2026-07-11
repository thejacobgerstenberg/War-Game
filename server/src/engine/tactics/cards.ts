/**
 * tactics/cards.ts — the tactic deck: data + deck construction (GAME_DESIGN §7.7).
 *
 * The 24 ratified tactic designs (48 physical copies) exactly per the §7.7
 * ratified table: 8 Common ×3, 8 Uncommon ×2, 8 Rare ×1. The docs table prints
 * only 23 designs (deck 47); CANON clarification 2 restores the 24th — the
 * rejected `the-guns-of-orban` was re-flavored IN PLACE as the 8th rare
 * `master-founders-hired` (mechanics identical to the retired card), returning
 * the deck to 48. The `the-guns-of-orban` slug is retired and is NOT present.
 *
 * Tactic slugs are their OWN keyspace ({@link TacticCardId}), distinct from event
 * slugs — build ids with {@link asTacticCardId} (e.g. `asTacticCardId("greek-fire")`).
 * `papal-indulgence` / `chain-across-the-horn` legitimately exist in BOTH decks;
 * the nominal brand keeps a tactic id un-interchangeable with an event string.
 *
 * Each card carries a structured `data` payload the resolver (`../tactics.ts`
 * `resolveTacticEffect`) switches on to post the right combat/siege ActiveModifier
 * or apply a direct economy effect. `data` is intentionally verbose so the
 * mechanical effect is data-driven (balance-tunable) rather than hardcoded.
 */
import type { TacticCard, TacticCardId } from "@imperium/shared";
import { asTacticCardId } from "@imperium/shared";
import type { Rng } from "../rng.js";

/** Rarity tier → physical copies in the shuffled deck (§7.7 distribution). */
const COPIES = { common: 3, uncommon: 2, rare: 1 } as const;

/** The structured effect tag the resolver switches on (see `../tactics.ts`). */
export type TacticEffectTag =
  | "melee_dice" // +N melee dice to a side (combat_mod)
  | "reroll" // reroll dice in a battle/siege round (combat_mod / siege_mod)
  | "gain_resource" // add resources to the player's treasury
  | "steal_gold" // take gold from a rival treasury
  | "peek_hand" // reveal a rival's tactic hand (information; no state effect)
  | "wall_bonus_zero" // an assault ignores the defender's wall bonus (wall_mod)
  | "temp_wall" // defender gains a temporary +N wall-grade bonus (combat_mod)
  | "siege_bombard" // +N wall-damage dice in a siege round (siege_mod)
  | "night_sortie" // besieged garrison: no depletion; besieger loses 1 (siege_mod)
  | "sails_relief" // besieged coastal city: no depletion under blockade + restore (siege_mod)
  | "treason" // besieged 2+ rounds: city falls without an assault (siege_mod)
  | "greek_fire" // fleet battle: win outright, destroy enemy naval (combat_mod)
  | "feigned_retreat" // withdraw whole stack before dice; battle ends (morale)
  | "holy_war" // +N melee dice in EVERY battle until next turn (combat_mod)
  | "truce" // truce with one rival until next turn (truce modifier)
  | "amphibious_immune" // a coastal province cannot be amphibiously assaulted (wall_mod)
  | "forced_march" // rider on a Move: +1 province, no besiege/assault (move_mod)
  | "intercept"; // reaction: cancel a rival's tactic card (cancel_tactic)

/** Narrowed shape of {@link TacticCard.data} for tactic cards authored here. */
export interface TacticEffectData {
  tier: "common" | "uncommon" | "rare";
  effect: TacticEffectTag;
  /** Battle domain the card is legal in ("land" | "fleet" | "any" | "siege"). */
  domain?: "land" | "fleet" | "any" | "siege";
  /** Which side of the battle the effect benefits (default: the player's side). */
  side?: "attacker" | "defender";
  /** Signed magnitude (extra dice, temp-wall grade, siege damage dice, …). */
  value?: number;
  /** Resource kind for `gain_resource`. */
  resource?: "gold" | "grain" | "faith";
  /** Reroll mode for `reroll`. */
  rerollMode?: "lowest" | "any" | "one";
  /** Printed gold cost still paid on play (§10.6). */
  costGold?: number;
  /** Printed faith cost still paid on play. */
  costFaith?: number;
  /** Whether the effect touches every battle the player fights (`holy_war`). */
  allBattles?: boolean;
}

/** Build one {@link TacticCard} record from its slug, name, tier and effect data. */
function card(
  slug: string,
  name: string,
  effect: string,
  data: TacticEffectData,
  opts: { timing?: string; removedFromGameOnPlay?: boolean } = {},
): TacticCard {
  return {
    id: asTacticCardId(slug),
    name,
    copies: COPIES[data.tier],
    effect,
    timing: opts.timing,
    removedFromGameOnPlay: opts.removedFromGameOnPlay,
    data: data as unknown as Record<string, unknown>,
  };
}

/**
 * The 24 ratified tactic designs (48 copies), authored EXACTLY from the §7.7
 * table (plus the re-flavored 8th rare `master-founders-hired`). Order is
 * Common (×3) → Uncommon (×2) → Rare (×1).
 */
export const TACTIC_CARDS: TacticCard[] = [
  // ---- 8 Common (×3 = 24 copies) --------------------------------------------
  card(
    "forced-march",
    "Forced March",
    "Rider on one of your Move actions: that army moves +1 province; it may not Besiege or Assault this round.",
    { tier: "common", effect: "forced_march", value: 1 },
    { timing: "move" },
  ),
  card(
    "veterans-of-the-border",
    "Veterans of the Border",
    "One land battle: your side rolls +1 die in each melee step.",
    { tier: "common", effect: "melee_dice", domain: "land", value: 1 },
    { timing: "battle" },
  ),
  card(
    "pilot-of-the-narrows",
    "The Pilot of the Narrows",
    "One fleet battle: your side rolls +1 die in each melee step.",
    { tier: "common", effect: "melee_dice", domain: "fleet", value: 1 },
    { timing: "battle" },
  ),
  card(
    "ladders-and-fascines",
    "Ladders and Fascines",
    "In one round of a siege assault, reroll one of your dice.",
    { tier: "common", effect: "reroll", domain: "siege", rerollMode: "one", value: 1 },
    { timing: "assault" },
  ),
  card(
    "the-counting-house",
    "A Good Season at the Counting-House",
    "Gain 2 gold.",
    { tier: "common", effect: "gain_resource", resource: "gold", value: 2 },
    { timing: "play-card" },
  ),
  card(
    "grain-barges-of-the-danube",
    "Grain Barges of the Danube",
    "Gain 2 grain.",
    { tier: "common", effect: "gain_resource", resource: "grain", value: 2 },
    { timing: "play-card" },
  ),
  card(
    "ears-in-the-bazaar",
    "Ears in the Bazaar",
    "Look at all tactic cards held by one rival.",
    { tier: "common", effect: "peek_hand" },
    { timing: "play-card" },
  ),
  card(
    "locked-shields",
    "Locked Shields",
    "One land battle in which you defend: reroll your lowest die in each melee step.",
    {
      tier: "common",
      effect: "reroll",
      domain: "land",
      side: "defender",
      rerollMode: "lowest",
      value: 1,
    },
    { timing: "battle" },
  ),
  // ---- 8 Uncommon (×2 = 16 copies) ------------------------------------------
  card(
    "feigned-retreat",
    "Feigned Retreat",
    "At the start of any battle round, before dice: withdraw your whole stack to an adjacent friendly or empty province. The battle ends; no pursuit.",
    { tier: "uncommon", effect: "feigned_retreat", domain: "land" },
    { timing: "battle" },
  ),
  card(
    "night-sortie",
    "Night Sortie",
    "One round of a siege against your city: the garrison suffers no store depletion or hunger loss; instead the besieger loses 1 unit (weakest first).",
    { tier: "uncommon", effect: "night_sortie", domain: "siege", side: "defender" },
    { timing: "siege" },
  ),
  card(
    "bribed-gatekeeper",
    "The Bribed Gatekeeper",
    "One assault you launch this round: the defender's wall bonus is 0 (Wall HP unchanged; escalade -1 still applies).",
    { tier: "uncommon", effect: "wall_bonus_zero", domain: "siege", side: "attacker" },
    { timing: "assault" },
  ),
  card(
    "chain-across-the-horn",
    "The Chain Across the Horn",
    "One coastal province you hold cannot be the target of an amphibious assault until the start of your next turn.",
    { tier: "uncommon", effect: "amphibious_immune" },
    { timing: "play-card" },
  ),
  card(
    "condottieri-contract",
    "Condottieri Contract",
    "Pay 2 gold: one land battle — your side rolls +2 dice in each melee step.",
    { tier: "uncommon", effect: "melee_dice", domain: "land", value: 2, costGold: 2 },
    { timing: "battle" },
  ),
  card(
    "papal-indulgence",
    "Papal Indulgence",
    "Pay 2 gold: gain 3 faith (the sole sanctioned gold->faith conversion).",
    {
      tier: "uncommon",
      effect: "gain_resource",
      resource: "faith",
      value: 3,
      costGold: 2,
    },
    { timing: "play-card" },
  ),
  card(
    "the-intercepted-letter",
    "The Intercepted Letter",
    "Reaction — play as a rival plays a tactic card: cancel it. Both cards are discarded.",
    { tier: "uncommon", effect: "intercept" },
    { timing: "reaction" },
  ),
  card(
    "the-hexamilion-manned",
    "The Hexamilion Manned",
    "One land battle you defend in an unwalled province: gain defender +2 (a temporary T2-grade wall bonus; creates no Wall HP; does not stack with real walls).",
    { tier: "uncommon", effect: "temp_wall", domain: "land", side: "defender", value: 2 },
    { timing: "battle" },
  ),
  // ---- 8 Rare (×1 = 8 copies) -----------------------------------------------
  card(
    "greek-fire",
    "Greek Fire",
    "Before dice in a fleet battle you are fighting: win it outright — all enemy naval units in the zone are destroyed. Then discard one other tactic card from your hand and remove this card from the game.",
    { tier: "rare", effect: "greek_fire", domain: "fleet" },
    { timing: "battle", removedFromGameOnPlay: true },
  ),
  card(
    "treason-at-the-gate",
    "Treason at the Gate",
    "Pay 4 gold. Play on a walled city you have besieged for 2+ consecutive rounds: the city falls without an assault — its garrison surrenders and you occupy it, walls at current HP. Remove this card from the game.",
    { tier: "rare", effect: "treason", domain: "siege", side: "attacker", costGold: 4 },
    { timing: "siege", removedFromGameOnPlay: true },
  ),
  card(
    "the-pay-chest-taken",
    "The Pay Chest Taken",
    "Take up to 3 gold from one rival's treasury (never more than they hold).",
    { tier: "rare", effect: "steal_gold", value: 3 },
    { timing: "play-card" },
  ),
  card(
    "holy-war-proclaimed",
    "Holy War Proclaimed",
    "Pay 2 faith: until the start of your next turn, your side rolls +1 die in each melee step of every battle you fight.",
    {
      tier: "rare",
      effect: "holy_war",
      domain: "any",
      value: 1,
      costFaith: 2,
      allBattles: true,
    },
    { timing: "play-card" },
  ),
  card(
    "sails-from-the-west",
    "Sails from the West",
    "Play while a coastal city you hold is besieged: this round its stores do not deplete and it takes no hunger loss — even under full naval blockade — and restore 2 depleted grain stores.",
    { tier: "rare", effect: "sails_relief", domain: "siege", side: "defender", value: 2 },
    { timing: "siege" },
  ),
  card(
    "a-death-in-the-palace",
    "A Death in the Palace",
    "Name one rival: a truce binds you both until the start of your next turn — neither may declare a new battle, assault, or siege against the other.",
    { tier: "rare", effect: "truce" },
    { timing: "play-card" },
  ),
  card(
    "the-white-knights-stroke",
    "The White Knight's Stroke",
    "In one round of a land battle, reroll any of your dice once (keep the second results).",
    { tier: "rare", effect: "reroll", domain: "land", rerollMode: "any", value: 1 },
    { timing: "battle" },
  ),
  // 8th rare — CANON clarification 2: `the-guns-of-orban` re-flavored IN PLACE as
  // `master-founders-hired` (mechanics identical). GD §8.4 note: the guns were
  // rejected as a duplicate of the capturable Great Bombard; re-flavored to the
  // gun-founders' craft rather than the gun itself, it refills the rare slot.
  card(
    "master-founders-hired",
    "Master Founders Hired",
    "Play in one round of a siege you conduct: your gun-founders cast and fire a great cannon — roll +2 additional Wall-HP damage dice this round.",
    { tier: "rare", effect: "siege_bombard", domain: "siege", side: "attacker", value: 2 },
    { timing: "siege" },
  ),
];

/** Slug → design lookup (built from {@link TACTIC_CARDS}). */
export const TACTIC_CARD_BY_ID: Record<string, TacticCard> = Object.fromEntries(
  TACTIC_CARDS.map((c) => [c.id, c]),
);

/**
 * Build the tactic draw deck: expand each design into `copies` physical cards and
 * shuffle with the seeded RNG (§7.7 / §14). Pure — consumes the passed `rng`
 * (advances its cursor; the caller persists `rng.cursor` back into state).
 */
export function buildTacticDeck(rng: Rng): TacticCardId[] {
  const deck: TacticCardId[] = [];
  for (const card of TACTIC_CARDS) {
    for (let i = 0; i < card.copies; i += 1) deck.push(card.id);
  }
  return rng.shuffle(deck);
}
