/**
 * EVERY tunable number in the simulation lives in this single CONFIG object.
 * Balance sweeps mutate a copy of this; nothing else in sim/ hardcodes rules
 * numbers. Map data (yields, walls, starts) lives in map.ts but must respect
 * the authoring bounds declared here.
 *
 * Combat/siege numbers follow docs/GAME_DESIGN.md (canon) §6-§8 unless a
 * comment says otherwise; divergences are documented in RULES_MODEL.md.
 */

import type { FactionId, Terrain, UnitType } from './types';

export interface UnitStats {
  goldCost: number; // gold to recruit one unit
  grainUpkeep: number; // grain per round per unit (canon: all upkeep is grain; mercs pay x2)
  goldUpkeep: number; // gold per round per unit (galley crews only; canon pays grain — divergence kept for the naval economy)
  cvAttack: number; // combat value when attacking (canon §6.1 "CV atk")
  cvDefense: number; // combat value when defending (canon §6.1 "CV def")
}

export interface FactionMods {
  unitGoldCostMult: number; // multiplier on professional/mercenary/siegeEngine gold cost
  levyGoldCostMult: number; // multiplier on levy gold cost
  levyRecruitBonus: number; // extra levies allowed per recruit action
  tradeIncomeMult: number; // multiplier on trade route income
  capitalExtraGold: number; // extra gold per round while holding the home capital
}

export const CONFIG = {
  game: {
    maxRounds: 16, // hard game end (years 1438..1453 flavor); highest prestige wins
    actionsPerTurn: 4, // actions each player takes per round
    playersMin: 2, // supported player counts
    playersMax: 5,
    suddenDeathHoldRounds: 2, // hold Constantinople this many consecutive full rounds => instant win
  },

  /**
   * 5-unit roster mapped onto the canon 7-unit CV table (§6.1):
   *   levy         -> LEVY      (CV 1/1)
   *   professional -> INFANTRY  (CV 2/3, "best defender-to-cost")
   *   mercenary    -> free company shock troops, CAVALRY-grade attack (CV 3/2)
   *   siegeEngine  -> SIEGE     (no field dice; bombards walls)
   *   galley       -> GALLEY    (CV 2/2, naval)
   * Faction quality identity flows through cost mults + starting rosters:
   * Ottoman quantity = cheap troops & levy swarms, Byzantine quality =
   * professional-heavy starting garrisons behind the best walls.
   */
  units: {
    levy: { goldCost: 2, grainUpkeep: 1, goldUpkeep: 0, cvAttack: 1, cvDefense: 1 }, // cheap chaff
    professional: { goldCost: 5, grainUpkeep: 1, goldUpkeep: 0, cvAttack: 2, cvDefense: 3 }, // solid line troops
    mercenary: { goldCost: 6, grainUpkeep: 2, goldUpkeep: 0, cvAttack: 3, cvDefense: 2 }, // instant shock troops; x1.5 gold, x2 grain (canon §6.2)
    siegeEngine: { goldCost: 12, grainUpkeep: 2, goldUpkeep: 0, cvAttack: 0, cvDefense: 0 }, // never rolls dice; degrades walls
    galley: { goldCost: 8, grainUpkeep: 0, goldUpkeep: 1, cvAttack: 2, cvDefense: 2 }, // sea unit; paid crews
  } satisfies Record<UnitType, UnitStats>,

  recruit: {
    perAction: { levy: 4, professional: 2, mercenary: 3, siegeEngine: 1, galley: 2 } satisfies Record<UnitType, number>, // max units of that type per recruit action
    mercsArriveInstantly: true, // mercenaries usable this round; others muster at end of round
  },

  factions: {
    byzantium: { unitGoldCostMult: 1.0, levyGoldCostMult: 1.0, levyRecruitBonus: 0, tradeIncomeMult: 1.0, capitalExtraGold: 2 }, // rich capital
    ottomans: { unitGoldCostMult: 0.75, levyGoldCostMult: 0.75, levyRecruitBonus: 0, tradeIncomeMult: 1.0, capitalExtraGold: 0 }, // cheap troops
    venice: { unitGoldCostMult: 1.0, levyGoldCostMult: 1.0, levyRecruitBonus: 0, tradeIncomeMult: 1.5, capitalExtraGold: 0 }, // trade empire
    genoa: { unitGoldCostMult: 1.0, levyGoldCostMult: 1.0, levyRecruitBonus: 0, tradeIncomeMult: 1.4, capitalExtraGold: 0 }, // trade empire
    hungary: { unitGoldCostMult: 1.0, levyGoldCostMult: 0.5, levyRecruitBonus: 2, tradeIncomeMult: 1.0, capitalExtraGold: 0 }, // levy swarms
  } satisfies Record<FactionId, FactionMods>,

  /**
   * Canon kernel (§7.1): every unit rolls 1d6 per combat round and hits on
   *   roll >= clamp(hitBase - CV - mods, thresholdMin, thresholdMax).
   * Modifiers act in THRESHOLD space (each +1 makes that side hit 1 pip
   * easier); casualties are simultaneous, lowest-value units die first.
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
    tacticCardSwing: 1, // threshold shift a single tactic card grants (+1 own side; MUST be capped at 1 card/side)
    terrain: { plains: 0, hills: 1, mountains: 1, forest: 1, marsh: 1 } satisfies Record<Terrain, number>, // defender threshold bonus (canon §7.3: +1 in rough terrain)
    riverCrossingPenalty: 1, // attacker -1 when attacking across a strait / amphibiously (canon §7.3 "amphibious")
  },

  /**
   * Canon wall table (§8.1): Lv1 6 HP/+2, Lv2 10 HP/+3, Theodosian 16 HP/+4.
   * The defender bonus is BINARY: full while wall HP > 0, gone at breach.
   * Sim tier 3 = Theodosian-class great walls (Constantinople starts there).
   */
  walls: {
    tierBonus: [0, 2, 3, 4], // defender threshold bonus by wall tier 0..3 while unbreached
    tierHitpoints: [0, 6, 10, 16], // wall HP by tier (canon §8.1)
    theodosianBonus: 0, // extra threshold bonus for the Theodosian flag (canon: none — tier 3 IS +4)
    theodosianExtraHitpoints: 0, // extra wall HP for the Theodosian flag (canon: none — tier 3 IS 16)
  },

  siege: {
    engineDamageDie: [1, 1, 2, 2, 3, 3], // wall HP per siege engine per round, indexed by d6-1 (canon §8.2: 1-2→1, 3-4→2, 5-6→3)
    maxEffectiveEngines: 3, // engines beyond this add no damage (crowding; sim divergence — canon is uncapped)
    theodosianEngineDamageMult: 0, // ordinary engines vs Theodosian-class (tier 3) walls: damage multiplier. 0 = only the Great Bombard cracks them (ruling R2)
    grainStoresRounds: 3, // a besieged city holds this many siege rounds before starving (canon §8.2.3)
    starvationUnitsPerRound: 1, // garrison units lost per round once stores are gone (canon §8.2.3)
    besiegerAttritionPerRound: 0.03, // fraction of besieging army lost per round (disease; sim divergence — canon has none)
    escaladePenalty: 1, // attacker -1 when assaulting unbreached walls (canon §8.2.4)
    assaultAllowedAnytime: true, // may assault intact walls (at full wall bonus + escalade)
    /**
     * Sea resupply (ruling R3): a besieged COASTAL walled city whose adjacent
     * sea zones are not all enemy-controlled cannot be starved — grain stores
     * refill each round. Blockade requires hostile fleet superiority in EVERY
     * adjacent sea zone. Landlocked cities are always fully invested.
     */
    seaResupplyEnabled: true,
    /**
     * The Great Bombard (ruling R2): unique siege engine, enters play via the
     * Era III event card `great-bombard-forged` revealed at the start of
     * availableFromRound. From then on the FIRST faction to pay goldCost
     * (build action) owns it — one per game.
     */
    greatBombard: {
      availableFromRound: 9, // round the great-bombard-forged Omen card is revealed (Era III)
      goldCost: 40, // one-off purchase price (first buyer takes it)
      damagePerRound: 6, // wall HP per siege round (ignores theodosianEngineDamageMult; breaches 16 HP in ~3 rounds)
    },
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
    wallUpgrade: { goldCost: 10, timberCost: 2, marbleCost: 1 }, // +1 wall tier, max tier 3
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
    unpaidMercDesertionFraction: 1.0, // unpaid mercenaries all desert immediately
    goldFloor: 0, // treasury can't go negative; unpayable upkeep triggers desertion instead
  },

  events: {
    // one global event card per round; uniform magnitude within these bounds
    goldMagnitude: [-6, 6] as const, // windfall / extortion
    grainMagnitude: [-4, 4] as const, // harvest / famine
    unitMagnitude: [-3, 3] as const, // volunteers / plague-desertion
    prestigeMagnitude: [-2, 2] as const, // crusade fervor / scandal
  },

  /**
   * Prestige sources = union of the sim conquest/wars-won track and the canon
   * §13.1 income sources (capitals, key cities, trade monopolies). Royal
   * marriage (+2/round in canon) stays unmodeled — see RULES_MODEL.md for the
   * sensitivity note. THRESHOLD is owned by the tuning report.
   */
  prestige: {
    ownCapitalPerRound: 1, // canon §13.1: hold your own capital
    enemyCapitalPerRound: 3, // canon §13.1: hold an enemy capital
    keyCityPerRound: 1, // canon §13.1: per named key city held at round end
    constantinopleExtraPerRound: 0, // Constantinople extra on top (0: its reward is sudden death + yields)
    tradeRoutePerRound: 0.6, // per open trade route at round end (sim source)
    tradeMonopolyPerRound: 2, // canon §13.1: open route with BOTH endpoints owned
    greatWork: 5, // one-off on completion
    provinceCapture: 2, // one-off conquest-track prestige per province captured (any owner)
    keyCityCapture: 5, // one-off sack/triumph bonus when a key city is taken from any owner (incl. neutrals)
    warWon: 6, // one-off when an enemy sues for peace / is eliminated from a war
    secretObjective: 6, // one-off on completing the secret objective
    victoryThreshold: 70, // reach this prestige => immediate win (recalibrate vs new sources in the tuning phase)
  },

  neutrals: {
    baseLevies: 2, // neutral province garrison: base levies...
    leviesPerWallTier: 2, // ...plus this many per wall tier
    professionalsIfKeyCity: 2, // key-city neutrals also get professionals
  },
};

export type Config = typeof CONFIG;

/** Deep-copy CONFIG so sweep runners can mutate numbers without aliasing. */
export function cloneConfig(): Config {
  return JSON.parse(JSON.stringify(CONFIG)) as Config;
}
