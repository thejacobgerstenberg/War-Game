/**
 * EVERY tunable number in the simulation lives in this single CONFIG object.
 * Balance sweeps mutate a copy of this; nothing else in sim/ hardcodes rules
 * numbers. Map data (yields, walls, starts) lives in map.ts but must respect
 * the authoring bounds declared here.
 */

import type { FactionId, Terrain, UnitType } from './types';

export interface UnitStats {
  goldCost: number; // gold to recruit one unit
  grainUpkeep: number; // grain per round per unit
  goldUpkeep: number; // gold per round per unit (mercenary wages, galley crews)
  quality: number; // die-value shift contributed per unit (averaged over the army)
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

  units: {
    levy: { goldCost: 2, grainUpkeep: 1, goldUpkeep: 0, quality: 0.0 }, // cheap chaff
    professional: { goldCost: 5, grainUpkeep: 1, goldUpkeep: 0, quality: 1.0 }, // solid line troops
    mercenary: { goldCost: 4, grainUpkeep: 1, goldUpkeep: 2, quality: 1.0 }, // instant but gold-hungry
    siegeEngine: { goldCost: 12, grainUpkeep: 2, goldUpkeep: 0, quality: 0.0 }, // never rolls dice; degrades walls
    galley: { goldCost: 8, grainUpkeep: 0, goldUpkeep: 1, quality: 0.5 }, // sea unit; paid crews
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

  combat: {
    attackerMaxDice: 3, // Risk-style: attacker rolls up to 3
    defenderMaxDice: 2, // defender rolls up to 2
    defenderWinsTies: true, // classic Risk tie rule
    retreatFraction: 0.35, // attacker auto-retreats at/below this fraction of starting combatants
    maxRounds: 25, // battle round cap => stalemate (siege continues instead)
    tacticCardSwing: 1, // die shift a single tactic card grants (+1 own side)
    terrain: { plains: 0, hills: 0.5, mountains: 1, forest: 0.5, marsh: 0.5 } satisfies Record<Terrain, number>, // defender die bonus by terrain
    riverCrossingPenalty: 1, // subtracted from attacker dice when attacking across a river/strait
  },

  walls: {
    tierBonus: [0, 1, 2, 3], // defender die bonus by wall tier 0..3 (intact)
    theodosianBonus: 1.5, // Constantinople extra on top of tier 3
    hitpointsPerTier: 4, // damage points needed to fully erase one tier of bonus
    theodosianExtraHitpoints: 8, // extra hitpoints for the Theodosian Walls
  },

  siege: {
    engineDamagePerRound: 1, // wall hitpoints removed per siege engine per siege round
    maxEffectiveEngines: 3, // engines beyond this add no damage (crowding)
    garrisonAttritionPerRound: 0.06, // fraction of besieged garrison lost per round (starvation)
    besiegerAttritionPerRound: 0.03, // fraction of besieging army lost per round (disease)
    assaultAllowedAnytime: true, // may assault intact walls (at full wall bonus)
    seaBlockadeDoublesAttrition: true, // blockading every coast doubles garrison attrition
    cpleSeaResupplyAttritionMult: 0.5, // Constantinople (Golden Horn) starves at this multiplier unless blockaded
    greatBombard: {
      availableFromRound: 12, // cannot be built before this round
      goldCost: 40, // one-off purchase price
      damagePerRound: 4, // wall hitpoints per round (stacks with regular engines)
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

  prestige: {
    keyCityPerRound: 1.5, // per key city held at round end
    constantinopleExtraPerRound: 0, // Constantinople counts extra on top (0: its reward is sudden death + yields)
    tradeRoutePerRound: 0.6, // per open trade route at round end
    greatWork: 5, // one-off on completion
    provinceCapture: 2, // one-off conquest-track prestige per province captured (any owner)
    keyCityCapture: 5, // one-off sack/triumph bonus when a key city is taken from any owner (incl. neutrals)
    warWon: 6, // one-off when an enemy sues for peace / is eliminated from a war
    secretObjective: 6, // one-off on completing the secret objective
    victoryThreshold: 70, // reach this prestige => immediate win (idle engines alone must not suffice)
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
