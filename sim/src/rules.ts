/**
 * EVERY tunable number in the simulation lives in this single CONFIG object.
 * Balance sweeps mutate a copy of this; nothing else in sim/ hardcodes rules
 * numbers. Map data (yields, walls, starts) lives in map.ts but must respect
 * the authoring bounds declared here.
 *
 * Combat/siege/prestige numbers follow the FINAL canon docs at commit
 * 2b42386 (feature/design-and-scaffold): docs/GAME_DESIGN.md §6-§8, §13 and
 * docs/FACTIONS.md (unit mapping). Divergences are documented in
 * RULES_MODEL.md.
 */

import type { FactionId, Terrain, UnitType } from './types';

export interface UnitStats {
  goldCost: number; // gold to recruit one unit
  timberCost: number; // timber to recruit one unit (canon §6.1: SIEGE 2, GALLEY 2)
  marbleCost: number; // marble to recruit one unit (canon §6.1: SIEGE 2)
  grainUpkeep: number; // grain per round per unit (canon §4.4)
  goldUpkeep: number; // gold per round per unit (Janissary/Black Army donative pay)
  cvAttack: number; // combat value when attacking (canon §6.1 "CV atk")
  cvDefense: number; // combat value when defending (canon §6.1 "CV def")
}

export interface FactionMods {
  unitGoldCostMult: number; // multiplier on professional/mercenary/siegeEngine gold cost (tuning lever; canon costs live in factionUnits)
  levyGoldCostMult: number; // multiplier on levy gold cost (tuning lever)
  levyRecruitBonus: number; // extra levies allowed per recruit action (Ottoman devshirme: levies raised anywhere, in bulk)
  tradeIncomeMult: number; // multiplier on trade route income (canon §5.2: Venice/Genoa x1.5 merchant bonus)
  capitalExtraGold: number; // extra gold per round while holding the home capital
  cityCapturePrestige: number; // extra one-off prestige when taking a walled city (Ottoman Ghaza, FACTIONS)
}

// --------------------------------------------------------------- unit tables

/**
 * 5-slot roster mapped onto the FINAL canon tables (GD §6.1 + FACTIONS
 * "Unique units and the engine roster"):
 *   levy         -> LEVY      (2g, 1 grain, CV 1/1)
 *   professional -> the faction's unique LINE unit (INFANTRY variant; see
 *                   FACTION_UNIT_OVERRIDES below)
 *   mercenary    -> a hired free company at CAVALRY stats (6g, CV 3/2) with
 *                   the canon §6.2 mercenary terms: x1.5 gold to raise
 *                   (9g), x2 grain upkeep (4), instant muster, desert-first
 *   siegeEngine  -> SIEGE     (8g + 2 timber + 2 marble, 1 grain, no field
 *                   dice, +3 vs walls on an escalade, bombards in sieges)
 *   galley       -> GALLEY    (5g + 2 timber, 1 grain, CV 2/2), blended with
 *                   the faction's WARSHIP variant where FACTIONS gives one
 */
const BASE_UNITS = {
  levy: { goldCost: 2, timberCost: 0, marbleCost: 0, grainUpkeep: 1, goldUpkeep: 0, cvAttack: 1, cvDefense: 1 },
  professional: { goldCost: 4, timberCost: 0, marbleCost: 0, grainUpkeep: 1, goldUpkeep: 0, cvAttack: 2, cvDefense: 3 },
  mercenary: { goldCost: 9, timberCost: 0, marbleCost: 0, grainUpkeep: 4, goldUpkeep: 0, cvAttack: 3, cvDefense: 2 },
  siegeEngine: { goldCost: 8, timberCost: 2, marbleCost: 2, grainUpkeep: 1, goldUpkeep: 0, cvAttack: 0, cvDefense: 0 },
  galley: { goldCost: 5, timberCost: 2, marbleCost: 0, grainUpkeep: 1, goldUpkeep: 0, cvAttack: 2, cvDefense: 2 },
} satisfies Record<UnitType, UnitStats>;

/**
 * Per-faction unique-unit overrides (FACTIONS mapping table; a unique unit
 * uses its base type's stats "unless its entry says otherwise"):
 *  - byzantium professional = Varangian Guard (elite guard infantry: "very
 *    strong on the defense of a walled city ... expensive") -> CV 2/4, 6g.
 *  - ottomans levy = devshirme levies ("cost -1 grain to sustain") -> 0 grain;
 *    professional = Janissary ("strong on the assault ... and in open battle,
 *    paid only in gold") -> CV 3/3, 5g, 1 gold (no grain) upkeep.
 *  - venice galley = Galeazza / Arsenal ("dominates a sea zone, +combat vs
 *    ordinary galleys; galleys cost -1 timber") -> CV 3/3, 1 timber.
 *  - genoa professional = Genoese Crossbowmen (ARCHER base: 3g, elite ranged
 *    whose §7.2 first-strike volley + "wall defense" is folded into CV 2/2 in
 *    this melee-only kernel); mercenary at x1.0 gold (surcharge WAIVED, not a
 *    discount — Mercenary Brokers); galley = Carrack -> CV def 3.
 *  - hungary levy = "Strongest Levies" (+1 combat, -1 gold) -> CV 2/2, 1g;
 *    professional = Black Army (gunpowder elite "very strong in open battle
 *    and assault", gold-paid) -> CV 3/3, 5g, 1 gold (no grain) upkeep.
 */
const FACTION_UNIT_OVERRIDES: Record<FactionId, Partial<Record<UnitType, Partial<UnitStats>>>> = {
  byzantium: {
    professional: { goldCost: 6, cvDefense: 4 },
  },
  ottomans: {
    levy: { grainUpkeep: 0 },
    professional: { goldCost: 5, cvAttack: 3, grainUpkeep: 0, goldUpkeep: 1 },
  },
  venice: {
    galley: { timberCost: 1, cvAttack: 3, cvDefense: 3 },
  },
  genoa: {
    professional: { goldCost: 3, cvDefense: 2 },
    mercenary: { goldCost: 6 },
    galley: { cvDefense: 3 },
  },
  hungary: {
    levy: { goldCost: 1, cvAttack: 2, cvDefense: 2 },
    professional: { goldCost: 5, cvAttack: 3, grainUpkeep: 0, goldUpkeep: 1 },
  },
};

const UNIT_TYPE_LIST: readonly UnitType[] = ['levy', 'professional', 'mercenary', 'siegeEngine', 'galley'];
const FACTION_ID_LIST: readonly FactionId[] = ['byzantium', 'ottomans', 'venice', 'genoa', 'hungary'];

/** Fully materialized per-faction stat tables (base + overrides). */
function materializeFactionUnits(): Record<FactionId, Record<UnitType, UnitStats>> {
  const out = {} as Record<FactionId, Record<UnitType, UnitStats>>;
  for (const f of FACTION_ID_LIST) {
    const table = {} as Record<UnitType, UnitStats>;
    for (const t of UNIT_TYPE_LIST) {
      table[t] = { ...BASE_UNITS[t], ...(FACTION_UNIT_OVERRIDES[f][t] ?? {}) };
    }
    out[f] = table;
  }
  return out;
}

// --------------------------------------------------------------- tactic cards

export type TacticTier = 'common' | 'uncommon' | 'rare';

/**
 * How a card is applied by the sim ('unmodeled' cards are dead draws — they
 * occupy hand slots and are discarded on overflow; see RULES_MODEL.md):
 *  - landBattle      : any land field battle, either role
 *  - landDefense     : land battle in which the holder DEFENDS
 *  - assault         : an assault the holder LAUNCHES against walls
 *  - unwalledDefense : defense of an unwalled province
 *  - siegeDefense    : played by the OWNER of a besieged city (siege round)
 *  - siegeAttack     : played by the BESIEGER (siege round)
 *  - instant         : resolves immediately when drawn (resource swing)
 *  - reaction        : The Intercepted Letter (cancels the rival's card)
 *  - unmodeled       : movement/info/naval-only/diplomatic — outside the sim
 */
export type TacticScope =
  | 'landBattle'
  | 'landDefense'
  | 'assault'
  | 'unwalledDefense'
  | 'siegeDefense'
  | 'siegeAttack'
  | 'instant'
  | 'reaction'
  | 'unmodeled';

export interface TacticCardDef {
  slug: string;
  tier: TacticTier;
  copies: number;
  scope: TacticScope;
  /** Play preference & hand-overflow keep priority (higher = better). */
  priority: number;
  costGold?: number;
  costFaith?: number;
  removeFromGame?: boolean;
  // -- combat effects (threshold-space handled by kernel fields) --
  extraDice?: number; // "+N dice" rolled in the melee step (canon §7.7)
  rerollsPerRound?: number; // missed dice rerolled per round (approximates canon rerolls)
  firstRoundOnly?: boolean; // effect applies only in the first battle round ("one round of ...")
  zeroWallBonus?: boolean; // Bribed Gatekeeper: wall bonus 0 (escalade -1 still applies)
  flatDefenderBonus?: number; // Hexamilion Manned: defender +2 in an unwalled province
  // -- instant effects --
  gainGold?: number;
  gainGrain?: number;
  gainFaith?: number;
  stealGold?: number; // Pay Chest: take up to N gold from the prestige leader
  // -- siege effects --
  siegeNoDepletion?: boolean; // this round: no store depletion / hunger loss
  besiegerLosesUnits?: number; // Night Sortie: besieger loses N (weakest first)
  restoreStores?: number; // Sails from the West: restore up to N depleted stores
  captureCity?: boolean; // Treason at the Gate
  minSiegeRounds?: number; // ...requires this many consecutive siege rounds
}

/**
 * The 23 RATIFIED tactic-card designs at their FINAL magnitudes
 * (GD §7.7 table, 2b42386). Deck = 47 cards: Common x3, Uncommon x2, Rare x1.
 */
const TACTIC_CARDS: TacticCardDef[] = [
  // ---- Common (8 designs x 3) ----
  { slug: 'forced-march', tier: 'common', copies: 3, scope: 'unmodeled', priority: 0 }, // move +1 province (movement layer unmodeled)
  { slug: 'veterans-of-the-border', tier: 'common', copies: 3, scope: 'landBattle', priority: 4, extraDice: 1 },
  { slug: 'pilot-of-the-narrows', tier: 'common', copies: 3, scope: 'unmodeled', priority: 0 }, // fleet battle +1 die (no pure fleet battles in sim)
  { slug: 'ladders-and-fascines', tier: 'common', copies: 3, scope: 'assault', priority: 3, rerollsPerRound: 1, firstRoundOnly: true },
  { slug: 'the-counting-house', tier: 'common', copies: 3, scope: 'instant', priority: 1, gainGold: 2 },
  { slug: 'grain-barges-of-the-danube', tier: 'common', copies: 3, scope: 'instant', priority: 1, gainGrain: 2 },
  { slug: 'ears-in-the-bazaar', tier: 'common', copies: 3, scope: 'unmodeled', priority: 0 }, // information (hidden hands unmodeled)
  { slug: 'locked-shields', tier: 'common', copies: 3, scope: 'landDefense', priority: 4, rerollsPerRound: 1 },
  // ---- Uncommon (8 designs x 2) ----
  { slug: 'feigned-retreat', tier: 'uncommon', copies: 2, scope: 'unmodeled', priority: 0 }, // pre-dice withdrawal (no retreat pathing in kernel)
  { slug: 'night-sortie', tier: 'uncommon', copies: 2, scope: 'siegeDefense', priority: 6, siegeNoDepletion: true, besiegerLosesUnits: 1 },
  { slug: 'bribed-gatekeeper', tier: 'uncommon', copies: 2, scope: 'assault', priority: 8, zeroWallBonus: true },
  { slug: 'chain-across-the-horn', tier: 'uncommon', copies: 2, scope: 'unmodeled', priority: 0 }, // blocks one amphibious assault
  { slug: 'condottieri-contract', tier: 'uncommon', copies: 2, scope: 'landBattle', priority: 7, costGold: 2, extraDice: 2 },
  { slug: 'papal-indulgence', tier: 'uncommon', copies: 2, scope: 'instant', priority: 1, costGold: 2, gainFaith: 3 },
  { slug: 'the-intercepted-letter', tier: 'uncommon', copies: 2, scope: 'reaction', priority: 9 },
  { slug: 'the-hexamilion-manned', tier: 'uncommon', copies: 2, scope: 'unwalledDefense', priority: 6, flatDefenderBonus: 2 },
  // ---- Rare (7 designs x 1) ----
  { slug: 'greek-fire', tier: 'rare', copies: 1, scope: 'unmodeled', priority: 0, removeFromGame: true }, // fleet-battle auto-win (no pure fleet battles in sim)
  { slug: 'treason-at-the-gate', tier: 'rare', copies: 1, scope: 'siegeAttack', priority: 10, costGold: 4, captureCity: true, minSiegeRounds: 2, removeFromGame: true },
  { slug: 'the-pay-chest-taken', tier: 'rare', copies: 1, scope: 'instant', priority: 1, stealGold: 3 },
  { slug: 'holy-war-proclaimed', tier: 'rare', copies: 1, scope: 'landBattle', priority: 6, costFaith: 2, extraDice: 1 }, // canon: every battle until next turn; sim: one battle (approximation)
  { slug: 'sails-from-the-west', tier: 'rare', copies: 1, scope: 'siegeDefense', priority: 8, siegeNoDepletion: true, restoreStores: 2 },
  { slug: 'a-death-in-the-palace', tier: 'rare', copies: 1, scope: 'unmodeled', priority: 0 }, // one-round truce (diplomacy unmodeled)
  { slug: 'the-white-knights-stroke', tier: 'rare', copies: 1, scope: 'landBattle', priority: 5, rerollsPerRound: 3, firstRoundOnly: true },
];

// --------------------------------------------------------------------- CONFIG

export const CONFIG = {
  game: {
    maxRounds: 16, // hard game end (1400-1453, canon §10); highest prestige wins at the cap
    actionsPerTurn: 4, // canon §10.0: exactly 4 actions, any mix/order (cards can raise to 5 — unmodeled, sensitivity note)
    playersMin: 2, // supported player counts
    playersMax: 5,
    suddenDeathHoldRounds: 2, // hold Constantinople through this many cleanups => instant win (canon §13.3)
  },

  units: BASE_UNITS,

  /**
   * Per-faction unit stat tables (canon FACTIONS unique-unit mapping),
   * materialized base+override. Combat, upkeep, and recruiting read THESE
   * for player factions; neutral garrisons use the base `units` table.
   * NOTE for sweeps: mutating `units` does NOT propagate here — sweep axes
   * must touch both (see economy.ts sweepAxes).
   */
  factionUnits: materializeFactionUnits(),

  recruit: {
    perAction: { levy: 4, professional: 2, mercenary: 3, siegeEngine: 1, galley: 2 } satisfies Record<UnitType, number>, // max units of that type per recruit action
    mercsArriveInstantly: true, // canon §6.2: mercenaries available immediately; others muster at end of round
  },

  factions: {
    byzantium: { unitGoldCostMult: 1.0, levyGoldCostMult: 1.0, levyRecruitBonus: 0, tradeIncomeMult: 1.0, capitalExtraGold: 2, cityCapturePrestige: 0 }, // rich capital (Hagia Sophia income proxy)
    ottomans: { unitGoldCostMult: 1.0, levyGoldCostMult: 1.0, levyRecruitBonus: 2, tradeIncomeMult: 1.0, capitalExtraGold: 0, cityCapturePrestige: 1 }, // devshirme levy bulk + Ghaza city-capture prestige
    venice: { unitGoldCostMult: 1.0, levyGoldCostMult: 1.0, levyRecruitBonus: 0, tradeIncomeMult: 1.5, capitalExtraGold: 0, cityCapturePrestige: 0 }, // canon §5.2 merchant x1.5
    genoa: { unitGoldCostMult: 1.0, levyGoldCostMult: 1.0, levyRecruitBonus: 0, tradeIncomeMult: 1.5, capitalExtraGold: 0, cityCapturePrestige: 0 }, // canon §5.2 merchant x1.5
    hungary: { unitGoldCostMult: 1.0, levyGoldCostMult: 1.0, levyRecruitBonus: 0, tradeIncomeMult: 1.0, capitalExtraGold: 0, cityCapturePrestige: 0 }, // quality levies (see factionUnits)
  } satisfies Record<FactionId, FactionMods>,

  /**
   * Canon kernel (§7.1): every unit rolls 1d6 per combat round and hits on
   *   roll >= clamp(hitBase - CV - mods, thresholdMin, thresholdMax).
   * Modifiers act in THRESHOLD space (each +1 makes that side hit 1 pip
   * easier); casualties are simultaneous, lowest-value units die first
   * (canon §4.4 value order: levy -> professional -> mercenary -> galley).
   */
  combat: {
    hitBase: 7, // threshold = clamp(hitBase - CV - mods, min, max)
    thresholdMin: 2, // canon clamp floor: nothing hits better than 2+
    thresholdMax: 6, // canon clamp ceiling: nothing hits worse than 6
    outnumberRatio: 2, // outnumbering the enemy by this ratio in a round...
    outnumberBonus: 1, // ...grants the larger side +1 (canon §7.3)
    outnumberVsWalls: false, // gap-fill: numbers grant no bonus while assaulting UNBREACHED walls (no frontage on an escalade)
    routLossFraction: 0.5, // a side that lost >= this fraction of its starting stack checks morale (§7.5)
    routOn: 3, // ...and routs on 1d6 <= this
    defenderRoutsBehindWalls: false, // gap-fill: a garrison behind unbreached walls has nowhere to flee and does not rout
    wallCoverSaveOn: 3, // gap-fill: while walls are UNBREACHED, each hit on the garrison is deflected on 1d6 <= this (battlement cover); 0 disables
    retreatFraction: 0.35, // attacker voluntarily withdraws at/below this fraction of starting combatants
    maxRounds: 25, // battle round cap => stalemate (siege continues instead)
    siegeEngineEscaladeBonus: 3, // canon §6.1: SIEGE "+3 vs walls" — engines roll at CV 0+3 while assaulting UNBREACHED walls (idle at field odds)
    terrain: { plains: 0, hills: 1, mountains: 1, forest: 1, marsh: 1 } satisfies Record<Terrain, number>, // defender threshold bonus (canon §7.3: +1 in rough terrain)
    riverCrossingPenalty: 1, // attacker -1 when attacking across a strait / amphibiously (canon §7.3 "amphibious")
  },

  /**
   * Canon wall table (§8.1), five tiers T1-T5:
   *   T1 3 HP/+1 · T2 6 HP/+2 · T3 10 HP/+3 · T4 13 HP/+4 · T5 16 HP/+4.
   * T5 = the Theodosian Walls (Constantinople). The defender bonus is
   * BINARY: full while wall HP > 0, gone at breach. theodosianExtra* are
   * legacy tuning levers on the Constantinople flag (0 = pure canon).
   */
  walls: {
    tierBonus: [0, 1, 2, 3, 4, 4], // defender threshold bonus by wall tier 0..5 while unbreached
    tierHitpoints: [0, 3, 6, 10, 13, 16], // wall HP by tier (canon §8.1)
    theodosianBonus: 0, // extra threshold bonus for the Theodosian flag (canon: none — T5 IS +4)
    theodosianExtraHitpoints: 0, // extra wall HP for the Theodosian flag (canon: none — T5 IS 16)
    maxBuildableTier: 3, // Build action upgrades stop at T3 (canon §9.1 Walls Lv2); T4/T5 are authored/great-work walls
  },

  siege: {
    engineDamageDie: [1, 1, 2, 2, 3, 3], // wall HP per siege-engine wall-damage die, indexed by d6-1 (canon §8.2.2: 1-2 -> 1, 3-4 -> 2, 5-6 -> 3)
    maxEffectiveEngines: 3, // engines beyond this add no damage (crowding; sim divergence — canon is uncapped)
    t5MasonryCapPerRound: 1, // canon §8.3: vs an INTACT tier-5 wall an ordinary siege train inflicts at most this many wall HP per round IN TOTAL
    grainStoresRounds: 3, // a besieged city holds this many siege rounds before starving (canon §8.2.3; Granary +2 unmodeled)
    starvationUnitsPerRound: 1, // garrison units lost per round once stores are gone (canon §8.2.3)
    besiegerAttritionPerRound: 0.03, // fraction of besieging army lost per round (disease; sim divergence — canon has none)
    escaladePenalty: 1, // attacker -1 when assaulting unbreached walls (canon §8.2.4)
    assaultAllowedAnytime: true, // may assault intact walls (at full wall bonus + escalade)
    /**
     * Sea resupply (canon §8.2.3): a besieged COASTAL walled city depletes
     * stores ONLY while under naval blockade. Blockade requires hostile
     * fleet control of EVERY adjacent sea zone; otherwise supply ships slip
     * in — no depletion, hunger never begins. Landlocked cities are always
     * fully invested.
     */
    seaResupplyEnabled: true,
    /**
     * The Great Bombard (canon GD §8.4 / EVENT_CARDS #34): unique siege
     * engine entering via the Era III omen `great-bombard-forged`
     * (Era III = rounds 11-16; the sim reveals the card when Era III
     * opens). On reveal the OTTOMAN player receives it free if alive
     * (canon); otherwise it is auctioned — sim rule: the richest faction
     * that can pay goldCost takes it (retried each round while unclaimed).
     * It rolls `damageDice` wall-damage dice per siege round and LIFTS the
     * T5 masonry cap for the whole besieging train.
     */
    greatBombard: {
      availableFromRound: 11, // the round the great-bombard-forged Omen is revealed (Era III opens; canon §12)
      goldCost: 40, // auction price when no Ottoman is in play (canon: Ottoman gets it free)
      damageDice: 2, // wall-damage dice per siege round (canon §8.4: up to 6 HP/round, ~4 avg)
    },
  },

  /**
   * Tactic cards (canon §7.7): 23 ratified designs, 47-card deck
   * (Common x3 / Uncommon x2 / Rare x1). Battle-scoped cards are free to
   * play (printed resource costs still paid); at most ONE card per side per
   * battle in the sim (canon allows one per battle ROUND — bounded-policy
   * simplification, documented in RULES_MODEL.md).
   */
  tacticCards: TACTIC_CARDS,
  cards: {
    drawsPerRound: 1, // canon §7.7: 1 draw per Income phase (University draws unmodeled)
    handLimit: 4, // canon §7.7: discard down to 4 at Cleanup
  },

  yields: {
    // authoring bounds for map.ts per-province yields (min, max inclusive)
    gold: [0, 5] as const,
    grain: [0, 4] as const,
    timber: [0, 2] as const,
    marble: [0, 2] as const,
    faith: [0, 2] as const,
    keyCityGoldMin: 2, // key cities must yield at least this much gold
  },

  buildings: {
    market: { goldCost: 8, timberCost: 2, extraGoldPerRound: 2 }, // one per province
    wallUpgrade: { goldCost: 10, timberCost: 2, marbleCost: 1 }, // +1 wall tier, max walls.maxBuildableTier
    greatWork: { goldCost: 25, marbleCost: 4, faithCost: 2, prestige: 5 }, // one-off prestige monument
  },

  trade: {
    routeIncomeBase: 3, // default gold/round for a route (map routes may override)
    maxRoutesPerFaction: 3, // open routes a faction can profit from simultaneously
    blockadeCancels: true, // enemy fleet in any route sea zone cuts the income
  },

  economy: {
    grainMarket: { buyGoldPerGrain: 2, sellGoldPerGrain: 1 }, // convert at these rates during income phase
    grainShortfallDesertionFraction: 0.25, // fraction of unfed units that desert each round
    unpaidMercDesertionFraction: 1.0, // unpaid mercenaries all desert immediately (canon §4.4: desert first)
    goldFloor: 0, // treasury can't go negative; unpayable upkeep triggers desertion instead
  },

  events: {
    // one global omen card per table per round (canon §12); uniform magnitude within these bounds
    goldMagnitude: [-6, 6] as const, // windfall / extortion
    grainMagnitude: [-4, 4] as const, // harvest / famine
    unitMagnitude: [-3, 3] as const, // volunteers / plague-desertion
    prestigeMagnitude: [-2, 2] as const, // crusade fervor / scandal
  },

  /**
   * Prestige sources = canon §13.1 (2b42386). Royal marriage (+2/round),
   * betrayal penalties, and per-battle morale effects stay unmodeled —
   * see RULES_MODEL.md sensitivity notes. THRESHOLD is owned by the
   * TUNING_REPORT (canon §13.2 lists pre-tuning placeholders).
   */
  prestige: {
    ownCapitalPerRound: 1, // canon §13.1: hold your own capital
    enemyCapitalPerRound: 3, // canon §13.1: hold an enemy capital
    keyCityPerRound: 1, // canon §13.1: per named key city held at round end
    constantinopleExtraPerRound: 0, // Constantinople extra on top (0: its reward is sudden death + yields)
    tradeRoutePerRound: 0, // canon §13.1 has NO per-route prestige (kept as a tuning lever, default 0)
    tradeMonopolyPerRound: 2, // canon §13.1: open route with BOTH endpoints owned
    greatWork: 5, // one-off on completion (canon §9.2: +5..+10; sim's generic great work = +5)
    decisiveBattle: 1, // canon §13.1: win a decisive battle (enemy wiped or routed)
    outnumberedWin: 1, // canon §13.1: win a field battle outnumbered (stacks with decisive)
    walledCityCapture: 2, // canon §13.1: take a walled city (T1-T3) by storm or siege
    walledCityCaptureHighTier: 3, // canon §13.1: ... +3 if T4-T5
    provinceCapture: 0, // one-off per ANY captured province (canon: none — kept as a tuning lever, default 0)
    warWon: 3, // canon §13.1: win a war (force peace / eliminate)
    loseCapital: -3, // canon §13.1: lose your own capital
    secretObjective: 4, // canon §13.1: +4 each, hidden, scored at GAME END only
    victoryThreshold: 70, // reach this prestige at Cleanup => immediate win. PLACEHOLDER — the TUNING_REPORT owns this number (recalibrate vs canon sources)
  },

  neutrals: {
    baseLevies: 2, // neutral province garrison: base levies...
    leviesPerWallTier: 1, // ...plus this many per wall tier (T1-T5)
    professionalsIfKeyCity: 2, // key-city neutrals also get professionals
  },
};

export type Config = typeof CONFIG;

/** Stats for a unit of `faction` (null/undefined = neutral -> base table). */
export function statsFor(faction: FactionId | null | undefined, t: UnitType): UnitStats {
  return faction ? CONFIG.factionUnits[faction][t] : CONFIG.units[t];
}

/** Same lookup against an explicit (possibly swept/cloned) config. */
export function unitStatsOf(cfg: Config, faction: FactionId | null | undefined, t: UnitType): UnitStats {
  return faction ? cfg.factionUnits[faction][t] : cfg.units[t];
}

/** Deep-copy CONFIG so sweep runners can mutate numbers without aliasing. */
export function cloneConfig(): Config {
  return JSON.parse(JSON.stringify(CONFIG)) as Config;
}
