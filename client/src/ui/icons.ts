/**
 * Vendored art URLs for the client UI.
 *
 * PROVENANCE: client/src/assets/icons/* and client/src/assets/crests/* are
 * byte-for-byte copies of art/icons/* and art/crests/* (feature/visual-assets,
 * CC0 — see art/ STYLE_GUIDE). Same vendoring pattern as
 * client/src/board/assets/board.svg. When the art is revised upstream,
 * re-copy; filenames are stable.
 *
 * All icons draw with `currentColor`, so an <img> renders them ink-on-
 * transparent; recolor by inlining or by the owner-* classes on the board.
 */
import armyUrl from "../assets/icons/army.svg";
import faithUrl from "../assets/icons/faith.svg";
import fleetUrl from "../assets/icons/fleet.svg";
import goldUrl from "../assets/icons/gold.svg";
import grainUrl from "../assets/icons/grain.svg";
import marbleUrl from "../assets/icons/marble.svg";
import prestigeUrl from "../assets/icons/prestige.svg";
import siegeUrl from "../assets/icons/siege.svg";
import timberUrl from "../assets/icons/timber.svg";
import phaseActionUrl from "../assets/icons/phase-action.svg";
import phaseBattleUrl from "../assets/icons/phase-battle.svg";
import phaseIncomeUrl from "../assets/icons/phase-income.svg";
import phaseOmenUrl from "../assets/icons/phase-omen.svg";

import crestByzantiumUrl from "../assets/crests/byzantium.svg";
import crestGenoaUrl from "../assets/crests/genoa.svg";
import crestHungaryUrl from "../assets/crests/hungary.svg";
import crestOttomansUrl from "../assets/crests/ottomans.svg";
import crestVeniceUrl from "../assets/crests/venice.svg";

import { Faction } from "@imperium/shared";

/** Every icon shipped in art/icons (13). */
export type IconName =
  | "army"
  | "faith"
  | "fleet"
  | "gold"
  | "grain"
  | "marble"
  | "prestige"
  | "siege"
  | "timber"
  | "phase-action"
  | "phase-battle"
  | "phase-income"
  | "phase-omen";

export const ICON_URL: Record<IconName, string> = {
  army: armyUrl,
  faith: faithUrl,
  fleet: fleetUrl,
  gold: goldUrl,
  grain: grainUrl,
  marble: marbleUrl,
  prestige: prestigeUrl,
  siege: siegeUrl,
  timber: timberUrl,
  "phase-action": phaseActionUrl,
  "phase-battle": phaseBattleUrl,
  "phase-income": phaseIncomeUrl,
  "phase-omen": phaseOmenUrl,
};

/** Faction crest URLs, keyed by the shared Faction enum. */
export const CREST_URL: Record<Faction, string> = {
  [Faction.BYZANTIUM]: crestByzantiumUrl,
  [Faction.OTTOMAN]: crestOttomansUrl,
  [Faction.VENICE]: crestVeniceUrl,
  [Faction.GENOA]: crestGenoaUrl,
  [Faction.HUNGARY]: crestHungaryUrl,
};

/** The five resource icons in display order (mockups' Treasury rail). */
export const RESOURCE_ICONS = [
  "gold",
  "grain",
  "timber",
  "marble",
  "faith",
] as const satisfies readonly IconName[];

export type ResourceIconName = (typeof RESOURCE_ICONS)[number];
