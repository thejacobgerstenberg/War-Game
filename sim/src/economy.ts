/**
 * Economy solvency/curve model for IMPERIUM.
 *
 * Simulates per-faction gold/grain (+timber/marble/faith) stocks and flows
 * over 16 rounds under three deterministic spending archetypes:
 *   - rush        : max sustainable army immediately (mercs+professionals
 *                   first), expands on a configurable conquest schedule.
 *   - tradeTurtle : markets + trade routes, minimal defense, income subject
 *                   to a route-raid risk haircut.
 *   - balanced    : half military / half economy, slower conquest schedule.
 *
 * No combat is simulated; conquest is abstracted as a deterministic casualty
 * haircut against the authored neutral garrison of the next expansion target.
 * The model is fully deterministic (no RNG draws), so runs are reproducible
 * by construction; all shared-core contracts (CONFIG, map, army helpers) are
 * respected.
 */

import type { Army, FactionId, StrategyProfile, UnitType } from './types';
import { FACTION_IDS } from './types';
import { CONFIG, type Config } from './rules';
import { armyOf, combatants, emptyArmy, removeCasualties, totalUnits } from './combat';
import { FACTION_STARTS, PROVINCES, PROVINCE_BY_ID, TRADE_ROUTES } from './map';

// ------------------------------------------------------------------ options

export interface EconOptions {
  /** Rusher conquers +1 province every this many rounds... */
  rushConquestEveryRounds: number;
  /** ...starting from this round. */
  rushConquestStartRound: number;
  /** Balanced conquest cadence (rounds per province). */
  balancedConquestEveryRounds: number;
  balancedConquestStartRound: number;
  /** Fraction of turtle trade-route income lost to raids/blockades. */
  routeRaidHaircut: number;
  /** Attacker units lost per neutral garrison combatant (plus wall factor). */
  conquestLossPerDefender: number;
  /** Extra loss factor per wall tier of the target. */
  conquestLossPerWallTier: number;
  /** Required attacker:garrison combatant ratio to attempt a conquest. */
  conquestStrengthRatio: number;
}

export const DEFAULT_ECON_OPTIONS: EconOptions = {
  rushConquestEveryRounds: 2,
  rushConquestStartRound: 3,
  balancedConquestEveryRounds: 3,
  balancedConquestStartRound: 4,
  routeRaidHaircut: 0.15,
  conquestLossPerDefender: 0.7,
  conquestLossPerWallTier: 0.3,
  conquestStrengthRatio: 2.0,
};

// ------------------------------------------------------------------ records

export interface RoundRecord {
  round: number;
  goldIncome: number;
  grainIncome: number;
  goldUpkeep: number;
  grainUpkeep: number;
  goldStock: number;
  grainStock: number;
  armyTotal: number;
  combatants: number;
  /** Gold income minus gold wages minus grain purchased at market. */
  netGoldIncome: number;
  /** Units feedable from this round's grain income + gold slack. */
  supportable: number;
  provinces: number;
  markets: number;
  routes: number;
  deserted: number;
}

export interface EconRunResult {
  faction: FactionId;
  archetype: StrategyProfile;
  rounds: RoundRecord[];
  insolvencyRound: number | null;
  maxArmyFielded: number;
  maxArmySupportable: number;
  strikePowerRound5: number;
  finalGoldIncome: number;
  finalNetIncome: number;
  finalGoldStock: number;
  finalArmy: number;
  provincesEnd: number;
  greatWorks: number;
  totalDeserted: number;
}

// --------------------------------------------------------- expansion orders

const CAPITALS: Record<FactionId, string> = {
  byzantium: 'constantinople',
  ottomans: 'edirne',
  venice: 'venice',
  genoa: 'genoa',
  hungary: 'buda',
};

/**
 * Deterministic BFS expansion order over neutral provinces, layer by layer
 * from the faction's starting holdings; within a layer richest (gold+grain)
 * first, id as tiebreak. Map data is static so this is precomputed once.
 */
function expansionOrder(faction: FactionId): string[] {
  const owned = new Set(PROVINCES.filter((p) => p.initialOwner === faction).map((p) => p.id));
  const order: string[] = [];
  const seen = new Set(owned);
  let frontier = [...owned];
  while (frontier.length > 0) {
    const layer: string[] = [];
    for (const id of frontier) {
      for (const adj of PROVINCE_BY_ID.get(id)!.adjacentProvinces) {
        if (seen.has(adj)) continue;
        seen.add(adj);
        const p = PROVINCE_BY_ID.get(adj)!;
        if (p.initialOwner === null) layer.push(adj);
        // provinces owned by other players are walls for this model: skip
      }
    }
    layer.sort((a, b) => {
      const pa = PROVINCE_BY_ID.get(a)!.yields;
      const pb = PROVINCE_BY_ID.get(b)!.yields;
      const va = pa.gold + pa.grain;
      const vb = pb.gold + pb.grain;
      return vb !== va ? vb - va : a < b ? -1 : 1;
    });
    order.push(...layer);
    frontier = layer;
  }
  return order;
}

const EXPANSION_ORDER: Record<FactionId, string[]> = Object.fromEntries(
  FACTION_IDS.map((f) => [f, expansionOrder(f)]),
) as Record<FactionId, string[]>;

/** Neutral garrison sized from the given (possibly swept) config. */
function neutralGarrisonFor(cfg: Config, provinceId: string): Army {
  const p = PROVINCE_BY_ID.get(provinceId)!;
  const n = cfg.neutrals;
  return armyOf({
    levy: n.baseLevies + n.leviesPerWallTier * p.wallTier,
    professional: p.keyCity ? n.professionalsIfKeyCity : 0,
  });
}

// ------------------------------------------------------------------- engine

interface EconState {
  gold: number;
  grain: number;
  timber: number;
  marble: number;
  faith: number;
  army: Army;
  provinces: Set<string>;
  markets: number;
  routesOpen: Set<string>;
  greatWorks: number;
  conquestsDone: number;
  expansionIdx: number;
  insolvencyRound: number | null;
  totalDeserted: number;
}

function initState(faction: FactionId): EconState {
  const start = FACTION_STARTS[faction];
  const army = emptyArmy();
  for (const g of Object.values(start.garrisons)) {
    for (const t of Object.keys(army) as UnitType[]) army[t] += g[t];
  }
  return {
    gold: start.treasury.gold,
    grain: start.treasury.grain,
    timber: 0,
    marble: 0,
    faith: 0,
    army,
    provinces: new Set(PROVINCES.filter((p) => p.initialOwner === faction).map((p) => p.id)),
    markets: 0,
    routesOpen: new Set(),
    greatWorks: 0,
    conquestsDone: 0,
    expansionIdx: 0,
    insolvencyRound: null,
    totalDeserted: 0,
  };
}

function unitGoldCost(cfg: Config, faction: FactionId, t: UnitType): number {
  const mods = cfg.factions[faction];
  const base = cfg.units[t].goldCost;
  if (t === 'levy') return base * mods.levyGoldCostMult;
  if (t === 'professional' || t === 'mercenary' || t === 'siegeEngine') {
    return base * mods.unitGoldCostMult;
  }
  return base; // galleys: standard price for everyone
}

function grainNeed(cfg: Config, a: Army): number {
  let n = 0;
  for (const t of Object.keys(a) as UnitType[]) n += a[t] * cfg.units[t].grainUpkeep;
  return n;
}

function goldNeed(cfg: Config, a: Army): number {
  let n = 0;
  for (const t of Object.keys(a) as UnitType[]) n += a[t] * cfg.units[t].goldUpkeep;
  return n;
}

interface Income {
  gold: number;
  grain: number;
  timber: number;
  marble: number;
  faith: number;
}

function computeIncome(
  cfg: Config,
  faction: FactionId,
  s: EconState,
  archetype: StrategyProfile,
  opts: EconOptions,
): Income {
  const inc: Income = { gold: 0, grain: 0, timber: 0, marble: 0, faith: 0 };
  for (const pid of s.provinces) {
    const y = PROVINCE_BY_ID.get(pid)!.yields;
    inc.gold += y.gold;
    inc.grain += y.grain;
    inc.timber += y.timber;
    inc.marble += y.marble;
    inc.faith += y.faith;
  }
  if (s.provinces.has(CAPITALS[faction])) inc.gold += cfg.factions[faction].capitalExtraGold;
  inc.gold += s.markets * cfg.buildings.market.extraGoldPerRound;
  // trade routes: authored income scaled by routeIncomeBase relative to the
  // shipped default (so sweeping routeIncomeBase moves all routes), times the
  // faction trade multiplier; turtles take the raid-risk haircut.
  const routeScale = cfg.trade.routeIncomeBase / CONFIG.trade.routeIncomeBase;
  let trade = 0;
  for (const rid of s.routesOpen) {
    const r = TRADE_ROUTES.find((x) => x.id === rid)!;
    trade += r.income * routeScale;
  }
  trade *= cfg.factions[faction].tradeIncomeMult;
  if (archetype === 'tradeTurtle') trade *= 1 - opts.routeRaidHaircut;
  inc.gold += trade;
  return inc;
}

/**
 * Pay upkeep from stocks: gold wages first (galleys, then mercenaries; the
 * unpaid fraction deserts), then grain (shortfall bought at market rate,
 * remainder triggers desertion). Returns desertions and gold spent on grain.
 */
function payUpkeep(cfg: Config, s: EconState, round: number): { deserted: number; grainGold: number } {
  let deserted = 0;
  let grainGold = 0;
  // ---- gold wages
  const galleyWage = s.army.galley * cfg.units.galley.goldUpkeep;
  const mercWage = s.army.mercenary * cfg.units.mercenary.goldUpkeep;
  if (s.gold >= galleyWage + mercWage) {
    s.gold -= galleyWage + mercWage;
  } else {
    // pay galleys first, then as many mercs as possible; the rest desert
    let g = s.gold;
    if (g >= galleyWage) {
      g -= galleyWage;
    } else {
      const perGalley = cfg.units.galley.goldUpkeep;
      const paidGalleys = perGalley > 0 ? Math.floor(g / perGalley) : s.army.galley;
      g -= paidGalleys * perGalley;
      const lost = s.army.galley - paidGalleys;
      s.army.galley = paidGalleys;
      deserted += lost;
    }
    const perMerc = cfg.units.mercenary.goldUpkeep;
    const paidMercs = perMerc > 0 ? Math.min(s.army.mercenary, Math.floor(g / perMerc)) : s.army.mercenary;
    g -= paidMercs * perMerc;
    const unpaid = s.army.mercenary - paidMercs;
    const lostMercs = Math.ceil(unpaid * cfg.economy.unpaidMercDesertionFraction);
    s.army.mercenary -= lostMercs;
    deserted += lostMercs;
    s.gold = Math.max(cfg.economy.goldFloor, g);
  }
  // ---- grain
  const need = grainNeed(cfg, s.army);
  if (s.grain >= need) {
    s.grain -= need;
  } else {
    let shortfall = need - s.grain;
    s.grain = 0;
    const buyPrice = cfg.economy.grainMarket.buyGoldPerGrain;
    const buyable = Math.min(Math.ceil(shortfall), Math.floor(s.gold / buyPrice));
    s.gold -= buyable * buyPrice;
    grainGold += buyable * buyPrice;
    shortfall -= buyable;
    if (shortfall > 0) {
      const unfed = Math.ceil(shortfall); // ~1 grain per unit
      const lost = Math.ceil(unfed * cfg.economy.grainShortfallDesertionFraction);
      deserted += removeCasualties(s.army, lost);
    }
  }
  if (deserted > 0 && s.insolvencyRound === null) s.insolvencyRound = round;
  s.totalDeserted += deserted;
  return { deserted, grainGold };
}

/**
 * Recruiting sustainability: affordable now, and the projected next round
 * (current income levels) can cover wages and feed the army without draining
 * more than half the grain stock or running structural gold deficit.
 */
function canSustain(cfg: Config, s: EconState, inc: Income, extra: Partial<Army>, cost: number): boolean {
  if (s.gold < cost) return false;
  const proj = { ...s.army };
  for (const [t, n] of Object.entries(extra)) proj[t as UnitType] += n ?? 0;
  const nextGold = goldNeed(cfg, proj);
  const nextGrain = grainNeed(cfg, proj);
  const goldAfter = s.gold - cost;
  const netGold = inc.gold - nextGold;
  if (netGold < 0 && goldAfter + 2 * netGold < 0) return false; // structural deficit, <2 rounds of buffer
  // feed the projected army from steady-state income only (stocks are a
  // buffer, not a plan): grain income plus gold slack spent at market rate
  const goldSlack = Math.max(0, netGold);
  const feedable = inc.grain + goldSlack / cfg.economy.grainMarket.buyGoldPerGrain;
  return nextGrain <= feedable;
}

/** Recruit up to a full action of `t`, unit by unit while sustainable. Returns units bought. */
function recruitAction(cfg: Config, faction: FactionId, s: EconState, inc: Income, t: UnitType): number {
  let cap = cfg.recruit.perAction[t];
  if (t === 'levy') cap += cfg.factions[faction].levyRecruitBonus;
  const cost = unitGoldCost(cfg, faction, t);
  let bought = 0;
  while (bought < cap && canSustain(cfg, s, inc, { [t]: 1 }, cost)) {
    s.gold -= cost;
    s.army[t] += 1;
    bought++;
  }
  return bought;
}

/** Attempt the next scheduled conquest. Returns true if a province was taken. */
function attemptConquest(cfg: Config, faction: FactionId, s: EconState, opts: EconOptions): boolean {
  const order = EXPANSION_ORDER[faction];
  if (s.expansionIdx >= order.length) return false;
  const target = order[s.expansionIdx];
  const p = PROVINCE_BY_ID.get(target)!;
  const garrison = neutralGarrisonFor(cfg, target);
  const gStrength = combatants(garrison);
  if (combatants(s.army) < gStrength * opts.conquestStrengthRatio) return false; // too weak; retry next round
  const losses = Math.ceil(gStrength * (opts.conquestLossPerDefender + opts.conquestLossPerWallTier * p.wallTier));
  removeCasualties(s.army, losses);
  s.provinces.add(target);
  s.expansionIdx++;
  s.conquestsDone++;
  return true;
}

function openRouteAction(cfg: Config, s: EconState): boolean {
  if (s.routesOpen.size >= cfg.trade.maxRoutesPerFaction) return false;
  const candidates = TRADE_ROUTES.filter(
    (r) => !s.routesOpen.has(r.id) && (s.provinces.has(r.a) || s.provinces.has(r.b)),
  ).sort((x, y) => y.income - x.income || (x.id < y.id ? -1 : 1));
  if (candidates.length === 0) return false;
  s.routesOpen.add(candidates[0].id);
  return true;
}

function buildMarketAction(cfg: Config, s: EconState): boolean {
  const m = cfg.buildings.market;
  if (s.markets >= s.provinces.size) return false; // one per province
  if (s.gold < m.goldCost || s.timber < m.timberCost) return false;
  s.gold -= m.goldCost;
  s.timber -= m.timberCost;
  s.markets++;
  return true;
}

function buildGreatWorkAction(cfg: Config, s: EconState): boolean {
  const g = cfg.buildings.greatWork;
  if (s.gold < g.goldCost + 15 || s.marble < g.marbleCost || s.faith < g.faithCost) return false;
  s.gold -= g.goldCost;
  s.marble -= g.marbleCost;
  s.faith -= g.faithCost;
  s.greatWorks++;
  return true;
}

// ------------------------------------------------------------------- driver

export function simulateEconomy(
  faction: FactionId,
  archetype: StrategyProfile,
  cfg: Config = CONFIG,
  opts: EconOptions = DEFAULT_ECON_OPTIONS,
): EconRunResult {
  const s = initState(faction);
  const records: RoundRecord[] = [];
  let strikePowerRound5 = 0;
  const maxRounds = cfg.game.maxRounds;

  for (let round = 1; round <= maxRounds; round++) {
    // -- income phase
    const inc = computeIncome(cfg, faction, s, archetype, opts);
    s.gold += inc.gold;
    s.grain += inc.grain;
    s.timber += inc.timber;
    s.marble += inc.marble;
    s.faith += inc.faith;

    // -- upkeep phase
    const goldUp = goldNeed(cfg, s.army);
    const grainUp = grainNeed(cfg, s.army);
    const { deserted, grainGold } = payUpkeep(cfg, s, round);

    // -- action phase (4 actions, archetype policy)
    let actions = cfg.game.actionsPerTurn;
    const conquestsDue = (start: number, every: number) =>
      round >= start ? Math.floor((round - start) / every) + 1 : 0;

    if (archetype === 'rush') {
      if (s.conquestsDone < conquestsDue(opts.rushConquestStartRound, opts.rushConquestEveryRounds) && actions > 0) {
        if (attemptConquest(cfg, faction, s, opts)) actions--;
      }
      const priority: UnitType[] = ['mercenary', 'professional', 'levy'];
      let pi = 0;
      while (actions > 0 && pi < priority.length) {
        if (recruitAction(cfg, faction, s, inc, priority[pi]) > 0) actions--;
        else pi++;
      }
    } else if (archetype === 'tradeTurtle') {
      if (actions > 0 && openRouteAction(cfg, s)) actions--;
      if (actions > 0 && openRouteAction(cfg, s)) actions--;
      while (actions > 0 && buildMarketAction(cfg, s)) actions--;
      // minimal defense: keep ~1.5 combatants per province
      if (actions > 0 && combatants(s.army) < 1.5 * s.provinces.size) {
        if (recruitAction(cfg, faction, s, inc, 'levy') > 0) actions--;
      }
      if (actions > 0 && buildGreatWorkAction(cfg, s)) actions--;
    } else {
      // balanced: one economy action, slower conquest, steady recruiting
      if (s.conquestsDone < conquestsDue(opts.balancedConquestStartRound, opts.balancedConquestEveryRounds) && actions > 0) {
        if (attemptConquest(cfg, faction, s, opts)) actions--;
      }
      if (actions > 0 && (openRouteAction(cfg, s) || buildMarketAction(cfg, s))) actions--;
      if (actions > 0 && recruitAction(cfg, faction, s, inc, 'professional') > 0) actions--;
      if (actions > 0 && recruitAction(cfg, faction, s, inc, 'levy') > 0) actions--;
    }

    // -- cleanup: sell grain above a two-round reserve
    const reserve = 2 * grainNeed(cfg, s.army);
    if (s.grain > reserve) {
      const excess = Math.floor(s.grain - reserve);
      s.grain -= excess;
      s.gold += excess * cfg.economy.grainMarket.sellGoldPerGrain;
    }

    const netGoldSlack = Math.max(0, inc.gold - goldNeed(cfg, s.army));
    const supportable = Math.floor(inc.grain + netGoldSlack / cfg.economy.grainMarket.buyGoldPerGrain);
    records.push({
      round,
      goldIncome: inc.gold,
      grainIncome: inc.grain,
      goldUpkeep: goldUp,
      grainUpkeep: grainUp,
      netGoldIncome: inc.gold - goldUp - grainGold,
      goldStock: s.gold,
      grainStock: s.grain,
      armyTotal: totalUnits(s.army),
      combatants: combatants(s.army),
      supportable,
      provinces: s.provinces.size,
      markets: s.markets,
      routes: s.routesOpen.size,
      deserted,
    });
    if (round === 5) {
      strikePowerRound5 = s.army.professional + s.army.mercenary + 0.3 * s.army.levy;
    }
  }

  const last = records[records.length - 1];
  return {
    faction,
    archetype,
    rounds: records,
    insolvencyRound: s.insolvencyRound,
    maxArmyFielded: Math.max(...records.map((r) => r.armyTotal)),
    maxArmySupportable: Math.max(...records.map((r) => r.supportable)),
    strikePowerRound5,
    finalGoldIncome: last.goldIncome,
    finalNetIncome:
      records.slice(-3).reduce((acc, r) => acc + r.netGoldIncome, 0) / Math.min(3, records.length),
    finalGoldStock: last.goldStock,
    finalArmy: last.armyTotal,
    provincesEnd: last.provinces,
    greatWorks: s.greatWorks,
    totalDeserted: s.totalDeserted,
  };
}

// --------------------------------------------------------------- evaluation

export const ARCHETYPES: readonly StrategyProfile[] = ['rush', 'tradeTurtle', 'balanced'];

export interface FactionEval {
  faction: FactionId;
  solvent: boolean;
  rushCredibleR5: boolean;
  turtleStrong: boolean;
  turtleBounded: boolean;
  balancedMid: boolean;
  strikePowerRound5: number;
  rushIncome16: number;
  turtleIncome16: number;
  balancedIncome16: number;
  rushNet16: number;
  turtleNet16: number;
  balancedNet16: number;
}

export interface ConfigEval {
  runs: EconRunResult[];
  factions: FactionEval[];
  pass: boolean;
}

/**
 * Competitiveness criteria (per faction). "Net" income = gold income minus
 * gold wages minus gold spent buying grain (avg of last 3 rounds): the
 * disposable surplus each strategy can convert into prestige.
 *  - solvent          : no desertion event in any archetype through round 16
 *  - rushCredibleR5   : rush strike power (prof+merc+0.3*levy) >= 8 by round 5
 *  - turtleStrong     : turtle net >= rush net AND turtle net >= 0.9x balanced net
 *                       (pure economy play yields the biggest disposable surplus)
 *  - turtleBounded    : turtle GROSS income <= 1.3x balanced gross income
 *                       (turtling never outscales a normally-expanding economy)
 *  - balancedMid      : balanced net >= 0.9x rush net (fighting doesn't bankrupt)
 */
export function evaluateConfig(cfg: Config = CONFIG, opts: EconOptions = DEFAULT_ECON_OPTIONS): ConfigEval {
  const runs: EconRunResult[] = [];
  const factions: FactionEval[] = [];
  for (const f of FACTION_IDS) {
    const byArch = {} as Record<StrategyProfile, EconRunResult>;
    for (const a of ARCHETYPES) {
      const r = simulateEconomy(f, a, cfg, opts);
      byArch[a] = r;
      runs.push(r);
    }
    const rush = byArch.rush;
    const turtle = byArch.tradeTurtle;
    const bal = byArch.balanced;
    factions.push({
      faction: f,
      solvent: rush.insolvencyRound === null && turtle.insolvencyRound === null && bal.insolvencyRound === null,
      rushCredibleR5: rush.strikePowerRound5 >= 8,
      turtleStrong:
        turtle.finalNetIncome >= rush.finalNetIncome &&
        turtle.finalNetIncome >= 0.9 * bal.finalNetIncome,
      turtleBounded: turtle.finalGoldIncome <= 1.3 * bal.finalGoldIncome,
      balancedMid: bal.finalNetIncome >= 0.9 * rush.finalNetIncome,
      strikePowerRound5: rush.strikePowerRound5,
      rushIncome16: rush.finalGoldIncome,
      turtleIncome16: turtle.finalGoldIncome,
      balancedIncome16: bal.finalGoldIncome,
      rushNet16: rush.finalNetIncome,
      turtleNet16: turtle.finalNetIncome,
      balancedNet16: bal.finalNetIncome,
    });
  }
  const pass = factions.every(
    (e) => e.solvent && e.rushCredibleR5 && e.turtleStrong && e.turtleBounded && e.balancedMid,
  );
  return { runs, factions, pass };
}

// -------------------------------------------------------------------- sweep

export interface SweepAxis {
  name: string;
  values: number[];
  apply: (cfg: Config, v: number) => void;
  default: number;
}

/** Price-point sweep axes around the CONFIG defaults (>=3 values each). */
export function sweepAxes(): SweepAxis[] {
  return [
    {
      name: 'levyGoldCost',
      values: [1.5, 2, 3],
      default: CONFIG.units.levy.goldCost,
      apply: (c, v) => (c.units.levy.goldCost = v),
    },
    {
      name: 'professionalGoldCost',
      values: [4, 5, 6],
      default: CONFIG.units.professional.goldCost,
      apply: (c, v) => (c.units.professional.goldCost = v),
    },
    {
      name: 'mercenaryGoldCost',
      values: [3, 4, 5],
      default: CONFIG.units.mercenary.goldCost,
      apply: (c, v) => (c.units.mercenary.goldCost = v),
    },
    {
      name: 'grainUpkeepMult',
      values: [0.75, 1, 1.25],
      default: 1,
      apply: (c, v) => {
        c.units.levy.grainUpkeep = CONFIG.units.levy.grainUpkeep * v;
        c.units.professional.grainUpkeep = CONFIG.units.professional.grainUpkeep * v;
        c.units.mercenary.grainUpkeep = CONFIG.units.mercenary.grainUpkeep * v;
      },
    },
    {
      name: 'tradeRouteIncomeBase',
      values: [2, 3, 4],
      default: CONFIG.trade.routeIncomeBase,
      apply: (c, v) => (c.trade.routeIncomeBase = v),
    },
    {
      name: 'marketGoldCost',
      values: [6, 8, 10],
      default: CONFIG.buildings.market.goldCost,
      apply: (c, v) => (c.buildings.market.goldCost = v),
    },
  ];
}
