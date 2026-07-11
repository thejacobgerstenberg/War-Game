/**
 * Full-game engine for IMPERIUM (see RULES_MODEL.md). One Game = one 5-player
 * match on the authored map. Round structure:
 *   event -> income & upkeep (insolvency => desertion) -> 4 actions/player
 *   -> queued battles resolve -> multi-round sieges advance -> cleanup
 *   (muster, grain sale, prestige, war peace, objectives) -> victory checks.
 *
 * Battles reuse resolveBattle from combat.ts; siege bombardment/attrition
 * reuse helpers from siege.ts. Sieges keep continuation state across rounds
 * (wall damage lives on the province; the besieging army in a Siege record).
 * All randomness flows through forked streams of the seeded game RNG.
 *
 * Simplifications (documented for the engine team):
 * - Movement: 1 province per move action (land adjacency incl. straits), or
 *   port-to-port within the same / an adjacent sea zone with 1 galley escort
 *   per 2 land units. Galleys never move over land.
 * - Diplomacy is not modeled as an action; wars start implicitly when a
 *   player attacks another player and end after 3 quiet rounds (net-capture
 *   leader gets warWon prestige). Eliminating a player also grants warWon
 *   prestige to the conqueror.
 * - Tactic cards (canon §7.7, 23 ratified designs / 47-card deck): each
 *   faction draws 1/round in the income window (hand cap 4, lowest-priority
 *   discard). Instant cards resolve on draw. In each battle/assault a side
 *   plays its best applicable card (max ONE per side per battle — canon
 *   allows one per battle ROUND; bounded-policy simplification). The
 *   Intercepted Letter cancels the rival's played card. Siege-scoped cards
 *   (Night Sortie, Sails from the West, Treason at the Gate) fire in the
 *   siege phase. 'unmodeled' cards are dead draws. See RULES_MODEL.md.
 * - One global event per round, uniform magnitude within CONFIG.events.
 * - Secret objective: hold 3 nearby provinces (seeded pick); revealed and
 *   scored (+4) at GAME END only (canon §13.1) — it never speeds up a
 *   threshold win.
 * - A province under siege yields nothing, cannot recruit, and its garrison
 *   cannot move; relief armies fight the besieger in the field.
 */

import type { Army, BattleResult, CombatModifiers, FactionId, PrestigeLedger, UnitType } from './types';
import { FACTION_IDS, UNIT_TYPES } from './types';
import { CONFIG, statsFor, type TacticCardDef, type TacticScope } from './rules';
import { create, type RNG } from './rng';
import {
  combatants,
  copyArmy,
  effectiveWallBonus,
  emptyArmy,
  modifiers,
  removeCasualties,
  resolveBattle,
} from './combat';
import { rollBombardment, wallHitpoints } from './siege';
import {
  FACTION_STARTS,
  PROVINCE_BY_ID,
  PROVINCES,
  SEA_ZONE_BY_ID,
  STRAIT_EDGES,
  TRADE_ROUTES,
  neutralGarrison,
} from './map';

// ----------------------------------------------------------------- policies

export type PolicyName = 'rusher' | 'trader' | 'turtler' | 'opportunist';
export const POLICY_NAMES: readonly PolicyName[] = ['rusher', 'trader', 'turtler', 'opportunist'];

/** Per-policy siege behavior (consulted by the engine each siege round). */
export interface SiegePrefs {
  /** Assault once the effective wall bonus is battered to <= this. */
  assaultWallThreshold: number;
  /** ...or the garrison has starved to <= this many combatants. */
  assaultGarrisonMax: number;
  /** Required besieger:garrison combatant ratio before assaulting. */
  strengthRatio: number;
  /** From this game round, assault at a relaxed wall threshold (+1.5). */
  desperationRound: number;
}

/** One legal-action interface: any policy can drive any faction. */
export interface Agent {
  name: PolicyName;
  siege: SiegePrefs;
  /** Spend game.actionsLeft actions via the act* API; must terminate. */
  takeTurn(game: Game, faction: FactionId): void;
}

// -------------------------------------------------------------------- state

export interface ProvinceState {
  id: string;
  owner: FactionId | null; // null = neutral minor power
  garrison: Army;
  wallTier: number; // authored tier + upgrades (max 3)
  wallDamage: number; // persists between sieges (no repair modeled)
  market: boolean;
}

export interface FactionState {
  id: FactionId;
  alive: boolean;
  eliminatedRound: number | null;
  gold: number;
  grain: number;
  timber: number;
  marble: number;
  faith: number;
  routes: string[]; // opened trade route ids (<= maxRoutesPerFaction)
  hasGreatBombard: boolean;
  hand: string[]; // tactic-card slugs held (canon §7.7; cap CONFIG.cards.handLimit)
  ledger: PrestigeLedger;
  /** Secret objective (revealed & scored at GAME END only, canon §13.1). */
  objective: { provinces: string[]; deadline: number; done: boolean };
  cpleHold: number; // consecutive round-ends holding Constantinople
}

interface Siege {
  provinceId: string;
  attacker: FactionId;
  army: Army;
  origin: string; // retreat destination if the siege is lifted
  rounds: number;
  /** Grain stores left in the besieged city (canon §8.2.3); refilled while sea-resupplied (R3). */
  stores: number;
}

interface PendingAttack {
  faction: FactionId;
  from: string;
  to: string;
  army: Army;
  crossPenalty: boolean; // strait or amphibious assault
}

interface PendingRecruit {
  faction: FactionId;
  province: string;
  unit: UnitType;
  count: number;
}

interface WarState {
  lastCombatRound: number;
  captures: Record<string, number>;
}

export type VictoryType = 'threshold' | 'cap' | 'suddenDeath' | 'elimination';

export interface GameResult {
  seed: number;
  rounds: number;
  winner: FactionId;
  victoryType: VictoryType;
  finalPrestige: Record<FactionId, number>;
  /** ledger total at each round end (frozen after elimination). */
  prestigeByRound: Record<FactionId, number[]>;
  eliminated: Partial<Record<FactionId, number>>; // faction -> round
  battles: number;
  assaults: number;
}

// -------------------------------------------------------- static map tables

export const CAPITALS: Record<FactionId, string> = {
  byzantium: 'constantinople',
  ottomans: 'edirne',
  venice: 'venice',
  genoa: 'genoa',
  hungary: 'buda',
};

/** Card scopes applicable per battle context (see rules.ts TacticScope). */
const LAND_ATTACK_SCOPES: readonly TacticScope[] = ['landBattle'];
const LAND_DEFENSE_SCOPES: readonly TacticScope[] = ['landBattle', 'landDefense'];
const UNWALLED_DEFENSE_SCOPES: readonly TacticScope[] = ['landBattle', 'landDefense', 'unwalledDefense'];
const ASSAULT_ATTACK_SCOPES: readonly TacticScope[] = ['landBattle', 'assault'];

const STRAIT_KEYS = new Set<string>();
for (const [a, b] of STRAIT_EDGES) {
  STRAIT_KEYS.add(`${a}|${b}`);
  STRAIT_KEYS.add(`${b}|${a}`);
}

/** Port -> ports reachable in one sea move (same or adjacent zone). */
function buildSeaNeighbors(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const ports = PROVINCES.filter((p) => p.port);
  for (const p of ports) {
    const zones = new Set<string>(p.coasts);
    for (const z of p.coasts) for (const az of SEA_ZONE_BY_ID.get(z)!.adjacentZones) zones.add(az);
    const near: string[] = [];
    for (const q of ports) {
      if (q.id === p.id) continue;
      if (q.coasts.some((z) => zones.has(z))) near.push(q.id);
    }
    out.set(p.id, near);
  }
  return out;
}
const SEA_NEIGHBORS: Map<string, string[]> = buildSeaNeighbors();

export interface Reach {
  to: string;
  sea: boolean; // needs galley escort
}

/** Province -> every province reachable in one move/attack action. */
function buildReach(): Map<string, Reach[]> {
  const out = new Map<string, Reach[]>();
  for (const p of PROVINCES) {
    const seen = new Set<string>();
    const list: Reach[] = [];
    for (const a of p.adjacentProvinces) {
      if (!seen.has(a)) {
        seen.add(a);
        list.push({ to: a, sea: false });
      }
    }
    for (const a of SEA_NEIGHBORS.get(p.id) ?? []) {
      if (!seen.has(a)) {
        seen.add(a);
        list.push({ to: a, sea: true });
      }
    }
    out.set(p.id, list);
  }
  return out;
}
const REACH: Map<string, Reach[]> = buildReach();

// ------------------------------------------------------------ army helpers

function mergeArmy(into: Army, from: Army): void {
  into.levy += from.levy;
  into.professional += from.professional;
  into.mercenary += from.mercenary;
  into.siegeEngine += from.siegeEngine;
  into.galley += from.galley;
}

/** Fighting weight used by threat/target heuristics (not by the dice). */
export function armyPower(a: Army): number {
  return a.levy + 2 * (a.professional + a.mercenary) + 1.5 * a.galley;
}

/** Stochastically-rounded attrition losses (same model as siege.ts). */
function attritionLosses(n: number, fraction: number, rng: RNG): number {
  if (n <= 0 || fraction <= 0) return 0;
  const x = n * fraction;
  const lo = Math.floor(x);
  return lo + (rng.chance(x - lo) ? 1 : 0);
}

/** Grain upkeep of one army under `faction`'s unit tables (canon §4.4). */
function grainUpkeepOf(faction: FactionId, a: Army): number {
  let n = 0;
  for (const t of UNIT_TYPES) n += a[t] * statsFor(faction, t).grainUpkeep;
  return n;
}

/** Gold wage of one army (Janissary/Black Army donatives etc.). */
function goldWageOf(faction: FactionId, a: Army): number {
  let n = 0;
  for (const t of UNIT_TYPES) n += a[t] * statsFor(faction, t).goldUpkeep;
  return n;
}

export function unitGoldCost(faction: FactionId, t: UnitType): number {
  const mods = CONFIG.factions[faction];
  const base = statsFor(faction, t).goldCost; // per-faction canon costs (FACTIONS mapping)
  if (t === 'levy') return base * mods.levyGoldCostMult;
  if (t === 'professional' || t === 'mercenary' || t === 'siegeEngine') {
    return base * mods.unitGoldCostMult;
  }
  return base; // galleys: no cost multiplier lever
}

function emptyLedger(): PrestigeLedger {
  return { capitals: 0, keyCities: 0, tradeRoutes: 0, greatWorks: 0, conquests: 0, warsWon: 0, objectives: 0, events: 0, total: 0 };
}

// -------------------------------------------------------------------- game

export class Game {
  readonly seed: number;
  round = 0;
  readonly provinces = new Map<string, ProvinceState>();
  readonly factions: Record<FactionId, FactionState>;
  readonly sieges = new Map<string, Siege>();
  readonly seatOrder: FactionId[];

  actionsLeft = 0;
  battles = 0;
  assaults = 0;
  winner: FactionId | null = null;
  victoryType: VictoryType | null = null;
  /** The Era III Omen card `great-bombard-forged` has been revealed (R2). */
  bombardForged = false;

  /** Agents may draw exploration randomness from this stream. */
  readonly agentRng: RNG;

  private readonly agents: Record<FactionId, Agent>;
  private readonly rngEvent: RNG;
  private readonly rngCombat: RNG;
  private readonly rngCards: RNG;
  private currentFaction: FactionId | null = null;
  private pendingAttacks: PendingAttack[] = [];
  private pendingRecruits: PendingRecruit[] = [];
  private readonly wars = new Map<string, WarState>();
  private readonly prestigeByRound: Record<FactionId, number[]>;
  /** Tactic deck (canon §7.7): 47 slugs, seeded shuffle, reshuffled discard. */
  private deck: string[] = [];
  private discardPile: string[] = [];
  private readonly cardBySlug = new Map<string, TacticCardDef>();

  constructor(seed: number, agents: Record<FactionId, Agent>, seatOrder: FactionId[]) {
    this.seed = seed;
    this.agents = agents;
    this.seatOrder = seatOrder;
    const root = create(seed);
    this.rngEvent = root.fork(1);
    this.rngCombat = root.fork(2);
    this.agentRng = root.fork(3);
    const rngSetup = root.fork(4);
    this.rngCards = root.fork(5);

    for (const c of CONFIG.tacticCards) {
      this.cardBySlug.set(c.slug, c);
      for (let i = 0; i < c.copies; i++) this.deck.push(c.slug);
    }
    this.rngCards.shuffle(this.deck);

    for (const p of PROVINCES) {
      const start = p.initialOwner ? FACTION_STARTS[p.initialOwner].garrisons[p.id] : undefined;
      this.provinces.set(p.id, {
        id: p.id,
        owner: p.initialOwner,
        garrison: start ? copyArmy(start) : p.initialOwner ? emptyArmy() : neutralGarrison(p),
        wallTier: p.wallTier,
        wallDamage: 0,
        market: false,
      });
    }

    this.factions = {} as Record<FactionId, FactionState>;
    this.prestigeByRound = {} as Record<FactionId, number[]>;
    for (const f of FACTION_IDS) {
      const t = FACTION_STARTS[f].treasury;
      this.factions[f] = {
        id: f,
        alive: true,
        eliminatedRound: null,
        gold: t.gold,
        grain: t.grain,
        timber: t.timber,
        marble: t.marble,
        faith: t.faith,
        routes: [],
        hasGreatBombard: false,
        hand: [],
        ledger: emptyLedger(),
        // canon: objectives are hidden goals verified at GAME END (round 16)
        objective: { provinces: this.pickObjective(f, rngSetup), deadline: CONFIG.game.maxRounds, done: false },
        cpleHold: 0,
      };
      this.prestigeByRound[f] = [];
    }
  }

  /** Secret objective: 3 provinces within 2 steps of the start, not owned. */
  private pickObjective(f: FactionId, rng: RNG): string[] {
    const owned = new Set(PROVINCES.filter((p) => p.initialOwner === f).map((p) => p.id));
    const candidates: string[] = [];
    const seen = new Set(owned);
    let frontier = [...owned];
    for (let d = 0; d < 2; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const r of REACH.get(id) ?? []) {
          if (seen.has(r.to)) continue;
          seen.add(r.to);
          candidates.push(r.to);
          next.push(r.to);
        }
      }
      frontier = next;
    }
    rng.shuffle(candidates);
    return candidates.slice(0, 3);
  }

  // ------------------------------------------------------------ round loop

  run(): GameResult {
    const maxRounds = CONFIG.game.maxRounds;
    for (let r = 1; r <= maxRounds; r++) {
      this.round = r;
      this.drawEvent();
      for (const f of this.seatOrder) {
        if (this.factions[f].alive) {
          this.collectIncome(f);
          this.payUpkeep(f);
          this.drawTacticCards(f); // canon §7.7: 1 draw in the Income window
        }
      }
      for (const f of this.seatOrder) {
        if (!this.factions[f].alive) continue;
        this.currentFaction = f;
        this.actionsLeft = CONFIG.game.actionsPerTurn;
        this.agents[f].takeTurn(this, f);
        this.actionsLeft = 0;
      }
      this.currentFaction = null;
      this.resolveBattles();
      this.resolveSieges();
      this.cleanup();
      if (this.checkVictory()) break;
    }
    if (!this.winner) {
      // canon §13.1: secret objectives are revealed & scored at GAME END
      // only (they count for the round-16 highest-prestige comparison; a
      // threshold/sudden-death win earlier ends the game before reveal).
      for (const f of FACTION_IDS) {
        const fs = this.factions[f];
        if (!fs.alive || fs.objective.provinces.length === 0) continue;
        if (fs.objective.provinces.every((pid) => this.provinces.get(pid)!.owner === f)) {
          fs.objective.done = true;
          fs.ledger.objectives += CONFIG.prestige.secretObjective;
          this.recomputeTotal(fs);
        }
      }
      // round cap: highest prestige among survivors wins
      let best: FactionId | null = null;
      for (const f of FACTION_IDS) {
        const fs = this.factions[f];
        if (!fs.alive) continue;
        if (best === null || fs.ledger.total > this.factions[best].ledger.total) best = f;
      }
      this.winner = best ?? FACTION_IDS[0];
      this.victoryType = 'cap';
    }
    const finalPrestige = {} as Record<FactionId, number>;
    const eliminated: Partial<Record<FactionId, number>> = {};
    for (const f of FACTION_IDS) {
      finalPrestige[f] = this.factions[f].ledger.total;
      if (this.factions[f].eliminatedRound !== null) eliminated[f] = this.factions[f].eliminatedRound!;
    }
    return {
      seed: this.seed,
      rounds: this.round,
      winner: this.winner,
      victoryType: this.victoryType!,
      finalPrestige,
      prestigeByRound: this.prestigeByRound,
      eliminated,
      battles: this.battles,
      assaults: this.assaults,
    };
  }

  // --------------------------------------------------------------- events

  private drawEvent(): void {
    // Era III card: `great-bombard-forged` (EVENT_CARDS #34) is revealed
    // when Era III opens (round availableFromRound). Canon GD §8.4: the
    // OTTOMAN player receives the unique Bombard FREE if in play; otherwise
    // it is auctioned — sim rule: the richest faction that can pay
    // goldCost takes it (retried each round while unclaimed; actBuyBombard
    // remains as an explicit-action fallback).
    const gb = CONFIG.siege.greatBombard;
    if (this.round >= gb.availableFromRound) {
      this.bombardForged = true;
      let claimed = false;
      for (const f of FACTION_IDS) if (this.factions[f].hasGreatBombard) claimed = true;
      if (!claimed) {
        if (this.factions.ottomans.alive) {
          this.factions.ottomans.hasGreatBombard = true;
        } else {
          let best: FactionId | null = null;
          for (const f of FACTION_IDS) {
            const fs = this.factions[f];
            if (fs.alive && fs.gold >= gb.goldCost && (best === null || fs.gold > this.factions[best].gold)) best = f;
          }
          if (best) {
            this.factions[best].gold -= gb.goldCost;
            this.factions[best].hasGreatBombard = true;
          }
        }
      }
    }
    const rng = this.rngEvent;
    const kind = rng.pick(['gold', 'grain', 'units', 'prestige'] as const);
    const target = rng.pick(['all', 'random', 'leader'] as const);
    const bounds =
      kind === 'gold' ? CONFIG.events.goldMagnitude :
      kind === 'grain' ? CONFIG.events.grainMagnitude :
      kind === 'units' ? CONFIG.events.unitMagnitude :
      CONFIG.events.prestigeMagnitude;
    const mag = rng.range(bounds[0], bounds[1]);
    if (mag === 0) return;
    const alive = FACTION_IDS.filter((f) => this.factions[f].alive);
    if (alive.length === 0) return;
    let hit: FactionId[];
    if (target === 'all') hit = alive;
    else if (target === 'random') hit = [rng.pick(alive)];
    else {
      let leader = alive[0];
      for (const f of alive) if (this.factions[f].ledger.total > this.factions[leader].ledger.total) leader = f;
      hit = [leader];
    }
    for (const f of hit) {
      const fs = this.factions[f];
      if (kind === 'gold') fs.gold = Math.max(0, fs.gold + mag);
      else if (kind === 'grain') fs.grain = Math.max(0, fs.grain + mag);
      else if (kind === 'prestige') {
        fs.ledger.events += mag;
        this.recomputeTotal(fs);
      } else {
        // units: volunteers muster at (or plague strikes) the biggest garrison.
        // Guardrail: an event never fully empties a garrison (leaves >= 1
        // combatant) — random plague opening a walled city's gates for a
        // walk-in capture is an artifact of the one-card event abstraction.
        const pid = this.provinces.get(CAPITALS[f])?.owner === f ? CAPITALS[f] : this.largestGarrison(f);
        if (!pid) continue;
        const g = this.provinces.get(pid)!.garrison;
        if (mag > 0) g.levy += mag;
        else removeCasualties(g, Math.min(-mag, Math.max(0, combatants(g) - 1)));
      }
    }
  }

  private largestGarrison(f: FactionId): string | null {
    let best: string | null = null;
    let bestN = -1;
    for (const p of this.provinces.values()) {
      if (p.owner !== f) continue;
      const n = combatants(p.garrison);
      if (n > bestN) {
        bestN = n;
        best = p.id;
      }
    }
    return best;
  }

  // ------------------------------------------------- tactic cards (canon §7.7)

  private drawFromDeck(): string | null {
    if (this.deck.length === 0 && this.discardPile.length > 0) {
      this.deck = this.discardPile; // reshuffle the discards (canon §7.7)
      this.discardPile = [];
      this.rngCards.shuffle(this.deck);
    }
    return this.deck.pop() ?? null;
  }

  /** Return a card to the discard pile unless it removes itself from the game. */
  private discardCard(card: TacticCardDef): void {
    if (!card.removeFromGame) this.discardPile.push(card.slug);
  }

  /** Income-phase draw: instants resolve on draw, the rest go to hand (cap 4). */
  private drawTacticCards(f: FactionId): void {
    const fs = this.factions[f];
    for (let i = 0; i < CONFIG.cards.drawsPerRound; i++) {
      const slug = this.drawFromDeck();
      if (!slug) break;
      const card = this.cardBySlug.get(slug)!;
      if (card.scope === 'instant') {
        this.resolveInstantCard(f, card);
        continue;
      }
      fs.hand.push(slug);
    }
    // hand limit (canon: discard down to 4 at Cleanup; sim discards on draw)
    while (fs.hand.length > CONFIG.cards.handLimit) {
      let worst = 0;
      for (let i = 1; i < fs.hand.length; i++) {
        if (this.cardBySlug.get(fs.hand[i])!.priority < this.cardBySlug.get(fs.hand[worst])!.priority) worst = i;
      }
      this.discardPile.push(fs.hand[worst]);
      fs.hand.splice(worst, 1);
    }
  }

  private resolveInstantCard(f: FactionId, card: TacticCardDef): void {
    const fs = this.factions[f];
    if (card.costGold && fs.gold < card.costGold) {
      this.discardCard(card); // cannot pay: fizzles
      return;
    }
    if (card.costGold) fs.gold -= card.costGold;
    if (card.costFaith) fs.faith -= card.costFaith;
    if (card.gainGold) fs.gold += card.gainGold;
    if (card.gainGrain) fs.grain += card.gainGrain;
    if (card.gainFaith) fs.faith += card.gainFaith;
    if (card.stealGold) {
      // The Pay Chest Taken: rob the prestige leader among living rivals
      let target: FactionId | null = null;
      for (const o of FACTION_IDS) {
        if (o === f || !this.factions[o].alive) continue;
        if (target === null || this.factions[o].ledger.total > this.factions[target].ledger.total) target = o;
      }
      if (target) {
        const take = Math.min(card.stealGold, this.factions[target].gold);
        this.factions[target].gold -= take;
        fs.gold += take;
      }
    }
    this.discardCard(card);
  }

  /** Index of `slug` in f's hand, or -1. */
  private handIndexOf(f: FactionId, slug: string): number {
    return this.factions[f].hand.indexOf(slug);
  }

  /** If f holds `slug`, play it (no cost check) and return its definition. */
  private takeCardIf(f: FactionId, slug: string): TacticCardDef | null {
    const i = this.handIndexOf(f, slug);
    if (i < 0) return null;
    this.factions[f].hand.splice(i, 1);
    const card = this.cardBySlug.get(slug)!;
    this.discardCard(card);
    return card;
  }

  /** Best affordable card in f's hand matching `scopes` (context-filtered). */
  private pickBattleCard(f: FactionId | null, scopes: readonly TacticScope[], wallBonus: number): TacticCardDef | null {
    if (!f) return null; // neutral garrisons hold no cards
    const fs = this.factions[f];
    let best: TacticCardDef | null = null;
    let bestIdx = -1;
    for (let i = 0; i < fs.hand.length; i++) {
      const c = this.cardBySlug.get(fs.hand[i])!;
      if (!scopes.includes(c.scope)) continue;
      if (c.zeroWallBonus && wallBonus <= 0) continue; // Bribed Gatekeeper is dead vs a breach
      if (c.costGold && fs.gold < c.costGold) continue;
      if (c.costFaith && fs.faith < c.costFaith) continue;
      if (best === null || c.priority > best.priority) {
        best = c;
        bestIdx = i;
      }
    }
    if (best !== null) {
      fs.hand.splice(bestIdx, 1);
      if (best.costGold) fs.gold -= best.costGold;
      if (best.costFaith) fs.faith -= best.costFaith;
      this.discardCard(best);
    }
    return best;
  }

  /**
   * Both sides commit at most ONE tactic card for this battle (bounded
   * policy; canon allows one per battle round). The Intercepted Letter is
   * a reaction: a side holding it cancels the rival's played card (both
   * cards discarded; the letter is exempt from the one-card limit).
   */
  private playBattleCards(
    att: FactionId | null,
    def: FactionId | null,
    attScopes: readonly TacticScope[],
    defScopes: readonly TacticScope[],
    wallBonus: number,
  ): { attCard: TacticCardDef | null; defCard: TacticCardDef | null } {
    let attCard = this.pickBattleCard(att, attScopes, wallBonus);
    let defCard = this.pickBattleCard(def, defScopes, 0);
    if (attCard && def && this.takeCardIf(def, 'the-intercepted-letter')) attCard = null;
    if (defCard && att && this.takeCardIf(att, 'the-intercepted-letter')) defCard = null;
    return { attCard, defCard };
  }

  /** Assemble kernel modifiers from base battle context + played cards. */
  private battleMods(
    base: Partial<CombatModifiers>,
    att: FactionId | null,
    def: FactionId | null,
    attCard: TacticCardDef | null,
    defCard: TacticCardDef | null,
  ): CombatModifiers {
    let wallBonus = base.wallBonus ?? 0;
    if (attCard?.zeroWallBonus && wallBonus > 0) wallBonus = 0; // Bribed Gatekeeper (escalade -1 still applies)
    return modifiers({
      attackerBonus: base.attackerBonus ?? 0,
      defenderBonus: (base.defenderBonus ?? 0) + (defCard?.flatDefenderBonus ?? 0),
      terrainBonus: base.terrainBonus ?? 0,
      wallBonus,
      attackerExtraDice: attCard?.extraDice ?? 0,
      defenderExtraDice: defCard?.extraDice ?? 0,
      attackerRerolls: attCard?.rerollsPerRound ?? 0,
      defenderRerolls: defCard?.rerollsPerRound ?? 0,
      attackerFirstRoundOnly: attCard?.firstRoundOnly,
      defenderFirstRoundOnly: defCard?.firstRoundOnly,
      attackerFaction: att,
      defenderFaction: def,
    });
  }

  /** Canon §13.1 battle prestige: decisive +1, outnumbered win +1. */
  private awardBattlePrestige(
    winner: FactionId | null,
    r: BattleResult,
    winnerStart: number,
    loserStart: number,
  ): void {
    if (!winner) return;
    let pts = 0;
    if (r.decisive) pts += CONFIG.prestige.decisiveBattle;
    if (winnerStart < loserStart) pts += CONFIG.prestige.outnumberedWin;
    if (pts !== 0) {
      const fs = this.factions[winner];
      fs.ledger.warsWon += pts;
      this.recomputeTotal(fs);
    }
  }

  // ------------------------------------------------------- income & upkeep

  private collectIncome(f: FactionId): void {
    const fs = this.factions[f];
    for (const p of this.provinces.values()) {
      if (p.owner !== f || this.sieges.has(p.id)) continue; // besieged: no yield
      const y = PROVINCE_BY_ID.get(p.id)!.yields;
      fs.gold += y.gold;
      fs.grain += y.grain;
      fs.timber += y.timber;
      fs.marble += y.marble;
      fs.faith += y.faith;
      if (p.market) fs.gold += CONFIG.buildings.market.extraGoldPerRound;
    }
    const cap = this.provinces.get(CAPITALS[f])!;
    if (cap.owner === f && !this.sieges.has(cap.id)) fs.gold += CONFIG.factions[f].capitalExtraGold;
    let trade = 0;
    for (const r of this.openRoutesOf(f)) trade += r.income;
    fs.gold += trade * CONFIG.factions[f].tradeIncomeMult;
  }

  /** All armies a faction feeds/pays: owned garrisons + its siege camps. */
  private armiesOf(f: FactionId): Army[] {
    const out: Army[] = [];
    for (const p of this.provinces.values()) if (p.owner === f) out.push(p.garrison);
    for (const s of this.sieges.values()) if (s.attacker === f) out.push(s.army);
    return out;
  }

  /**
   * Armies with a desertion floor: peacetime insolvency (unpaid crews,
   * grain shortfall) never removes the LAST combatant of a garrison in a
   * walled province — a skeleton militia mans the walls, so an insolvent
   * power cannot lose a fortress to a walk-in. Siege starvation
   * (resolveSieges) is unaffected and can still empty a garrison.
   */
  private armiesWithDesertionFloor(f: FactionId): Array<{ army: Army; floor: number }> {
    const out: Array<{ army: Army; floor: number }> = [];
    for (const p of this.provinces.values()) {
      if (p.owner === f) out.push({ army: p.garrison, floor: p.wallTier > 0 ? 1 : 0 });
    }
    for (const s of this.sieges.values()) if (s.attacker === f) out.push({ army: s.army, floor: 0 });
    return out;
  }

  private removeUnitAcross(armies: Array<{ army: Army; floor: number }>, t: UnitType, n: number): void {
    let r = n;
    for (const e of armies) {
      if (r <= 0) break;
      const spare = Math.max(0, combatants(e.army) - e.floor);
      const k = Math.min(e.army[t], r, spare);
      e.army[t] -= k;
      r -= k;
    }
  }

  private payUpkeep(f: FactionId): void {
    const fs = this.factions[f];
    const floored = this.armiesWithDesertionFloor(f);
    const armies = floored.map((e) => e.army);
    // ---- gold wages (per-faction tables: Janissary/Black Army donatives)
    let wage = 0;
    for (const a of armies) wage += goldWageOf(f, a);
    if (fs.gold >= wage) {
      fs.gold -= wage;
    } else {
      // short pay: professionals & crews are paid first; mercenaries desert
      // first (canon §4.4/§6.2), the rest of the unpaid follow
      let g = fs.gold;
      for (const t of ['professional', 'galley'] as const) {
        const per = statsFor(f, t).goldUpkeep;
        if (per <= 0) continue;
        let count = 0;
        for (const a of armies) count += a[t];
        const paid = Math.min(count, Math.floor(g / per));
        g -= paid * per;
        this.removeUnitAcross(floored, t, count - paid);
      }
      const perMerc = statsFor(f, 'mercenary').goldUpkeep;
      if (perMerc > 0) {
        let mercs = 0;
        for (const a of armies) mercs += a.mercenary;
        const paidMercs = Math.min(mercs, Math.floor(g / perMerc));
        g -= paidMercs * perMerc;
        this.removeUnitAcross(floored, 'mercenary', Math.ceil((mercs - paidMercs) * CONFIG.economy.unpaidMercDesertionFraction));
      }
      fs.gold = Math.max(CONFIG.economy.goldFloor, g);
    }
    // grain (recompute after wage desertions)
    let need = 0;
    for (const a of armies) need += grainUpkeepOf(f, a);
    if (fs.grain >= need) {
      fs.grain -= need;
    } else {
      let shortfall = need - fs.grain;
      fs.grain = 0;
      const price = CONFIG.economy.grainMarket.buyGoldPerGrain;
      const buyable = Math.min(Math.ceil(shortfall), Math.floor(fs.gold / price));
      fs.gold -= buyable * price;
      shortfall -= buyable;
      if (shortfall > 0) {
        const unfed = Math.ceil(shortfall);
        let lost = Math.ceil(unfed * CONFIG.economy.grainShortfallDesertionFraction);
        // canon §4.4: unfed MERCENARIES desert first...
        for (const e of floored) {
          if (lost <= 0) break;
          const spare = Math.max(0, combatants(e.army) - e.floor);
          const k = Math.min(e.army.mercenary, lost, spare);
          e.army.mercenary -= k;
          lost -= k;
        }
        // ...then lowest-value first
        for (const e of floored) {
          if (lost <= 0) break;
          const spare = Math.max(0, combatants(e.army) - e.floor);
          lost -= removeCasualties(e.army, Math.min(lost, spare));
        }
      }
    }
  }

  // -------------------------------------------------------------- war state

  private warKey(a: FactionId, b: FactionId): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  private touchWar(a: FactionId, b: FactionId): WarState {
    const key = this.warKey(a, b);
    let w = this.wars.get(key);
    if (!w) {
      w = { lastCombatRound: this.round, captures: { [a]: 0, [b]: 0 } };
      this.wars.set(key, w);
    }
    w.lastCombatRound = this.round;
    return w;
  }

  atWar(a: FactionId, b: FactionId): boolean {
    return this.wars.has(this.warKey(a, b));
  }

  warsOf(f: FactionId): FactionId[] {
    const out: FactionId[] = [];
    for (const key of this.wars.keys()) {
      const [a, b] = key.split('|') as [FactionId, FactionId];
      if (a === f) out.push(b);
      else if (b === f) out.push(a);
    }
    return out;
  }

  // ------------------------------------------------------------ action API

  private canAct(f: FactionId): boolean {
    return this.currentFaction === f && this.actionsLeft > 0 && this.factions[f].alive;
  }

  private consume(): void {
    this.actionsLeft--;
  }

  /** Reach entry from -> to, or null if not reachable in one action. */
  private reachEntry(from: string, to: string): Reach | null {
    for (const r of REACH.get(from) ?? []) if (r.to === to) return r;
    return null;
  }

  /**
   * Plan a detachment: `fighters` combat troops best-first, plus engines,
   * plus galley escort for sea moves (1 per 2 land units). Returns null if
   * the plan is empty or escort is unavailable. Mutates nothing.
   */
  private planForce(
    g: Army,
    fighters: number,
    engines: number,
    sea: boolean,
  ): Army | null {
    const out = emptyArmy();
    let want = Math.max(0, fighters);
    const take = (t: 'professional' | 'mercenary' | 'levy') => {
      const k = Math.min(g[t], want);
      out[t] = k;
      want -= k;
    };
    take('professional');
    take('mercenary');
    take('levy');
    out.siegeEngine = Math.min(g.siegeEngine, Math.max(0, engines));
    const land = out.levy + out.professional + out.mercenary + out.siegeEngine;
    if (land === 0) return null;
    if (sea) {
      const escort = Math.ceil(land / 2);
      if (g.galley < escort) return null;
      out.galley = escort;
    }
    return out;
  }

  private extract(g: Army, plan: Army): void {
    g.levy -= plan.levy;
    g.professional -= plan.professional;
    g.mercenary -= plan.mercenary;
    g.siegeEngine -= plan.siegeEngine;
    g.galley -= plan.galley;
  }

  actRecruit(f: FactionId, pid: string, unit: UnitType, count: number): boolean {
    if (!this.canAct(f)) return false;
    const p = this.provinces.get(pid);
    if (!p || p.owner !== f || this.sieges.has(pid)) return false;
    if (unit === 'galley' && !PROVINCE_BY_ID.get(pid)!.port) return false;
    const fs = this.factions[f];
    let cap = CONFIG.recruit.perAction[unit];
    if (unit === 'levy') cap += CONFIG.factions[f].levyRecruitBonus;
    const st = statsFor(f, unit);
    const cost = unitGoldCost(f, unit);
    let n = Math.min(count, cap, cost > 0 ? Math.floor(fs.gold / cost) : count);
    if (st.timberCost > 0) n = Math.min(n, Math.floor(fs.timber / st.timberCost));
    if (st.marbleCost > 0) n = Math.min(n, Math.floor(fs.marble / st.marbleCost));
    if (n <= 0) return false;
    fs.gold -= n * cost;
    fs.timber -= n * st.timberCost;
    fs.marble -= n * st.marbleCost;
    if (unit === 'mercenary' && CONFIG.recruit.mercsArriveInstantly) {
      p.garrison.mercenary += n;
    } else {
      this.pendingRecruits.push({ faction: f, province: pid, unit, count: n });
    }
    this.consume();
    return true;
  }

  /** Move within friendly territory (immediate). */
  actMove(f: FactionId, from: string, to: string, count: number, withEngines = false): boolean {
    if (!this.canAct(f)) return false;
    const pf = this.provinces.get(from);
    const pt = this.provinces.get(to);
    if (!pf || !pt || pf.owner !== f || pt.owner !== f) return false;
    if (this.sieges.has(from) || this.sieges.has(to)) return false;
    const reach = this.reachEntry(from, to);
    if (!reach) return false;
    const plan = this.planForce(pf.garrison, count, withEngines ? pf.garrison.siegeEngine : 0, reach.sea);
    if (!plan) return false;
    this.extract(pf.garrison, plan);
    mergeArmy(pt.garrison, plan);
    this.consume();
    return true;
  }

  /**
   * Attack an adjacent non-owned province (queued; resolves in the battle
   * phase) or reinforce an own siege (immediate merge). Relief of a province
   * besieged by another faction fights the besieger in the field.
   */
  actAttack(f: FactionId, from: string, to: string, count: number, engines = 0): boolean {
    if (!this.canAct(f)) return false;
    const pf = this.provinces.get(from);
    const pt = this.provinces.get(to);
    if (!pf || !pt || pf.owner !== f || this.sieges.has(from)) return false;
    const siege = this.sieges.get(to);
    if (pt.owner === f && (!siege || siege.attacker === f)) return false; // nothing to attack
    const reach = this.reachEntry(from, to);
    if (!reach) return false;
    const plan = this.planForce(pf.garrison, count, engines, reach.sea);
    if (!plan || combatants(plan) === 0) return false;
    this.extract(pf.garrison, plan);
    if (siege && siege.attacker === f) {
      mergeArmy(siege.army, plan); // reinforce own siege camp
      this.consume();
      return true;
    }
    if (pt.owner && pt.owner !== f) this.touchWar(f, pt.owner);
    this.pendingAttacks.push({
      faction: f,
      from,
      to,
      army: plan,
      crossPenalty: STRAIT_KEYS.has(`${from}|${to}`) || reach.sea,
    });
    this.consume();
    return true;
  }

  actBuild(f: FactionId, pid: string, build: 'market' | 'wallUpgrade' | 'greatWork'): boolean {
    if (!this.canAct(f)) return false;
    const p = this.provinces.get(pid);
    if (!p || p.owner !== f || this.sieges.has(pid)) return false;
    const fs = this.factions[f];
    const b = CONFIG.buildings;
    if (build === 'market') {
      if (p.market || fs.gold < b.market.goldCost || fs.timber < b.market.timberCost) return false;
      fs.gold -= b.market.goldCost;
      fs.timber -= b.market.timberCost;
      p.market = true;
    } else if (build === 'wallUpgrade') {
      if (p.wallTier >= CONFIG.walls.maxBuildableTier) return false; // canon §9.1: Build stops at T3
      if (fs.gold < b.wallUpgrade.goldCost || fs.timber < b.wallUpgrade.timberCost || fs.marble < b.wallUpgrade.marbleCost) return false;
      fs.gold -= b.wallUpgrade.goldCost;
      fs.timber -= b.wallUpgrade.timberCost;
      fs.marble -= b.wallUpgrade.marbleCost;
      p.wallTier++;
    } else {
      if (fs.gold < b.greatWork.goldCost || fs.marble < b.greatWork.marbleCost || fs.faith < b.greatWork.faithCost) return false;
      fs.gold -= b.greatWork.goldCost;
      fs.marble -= b.greatWork.marbleCost;
      fs.faith -= b.greatWork.faithCost;
      fs.ledger.greatWorks += CONFIG.prestige.greatWork;
      this.recomputeTotal(fs);
    }
    this.consume();
    return true;
  }

  /**
   * Claim the UNIQUE Great Bombard at its auction price (build action).
   * Normally the forge event auto-resolves the grant (Ottomans free, else
   * richest payer — canon GD §8.4); this action is the fallback when the
   * event found nobody able to pay.
   */
  actBuyBombard(f: FactionId): boolean {
    if (!this.canAct(f)) return false;
    const fs = this.factions[f];
    const gb = CONFIG.siege.greatBombard;
    if (!this.bombardForged || fs.gold < gb.goldCost) return false;
    for (const other of FACTION_IDS) if (this.factions[other].hasGreatBombard) return false; // unique: already claimed
    fs.gold -= gb.goldCost;
    fs.hasGreatBombard = true;
    this.consume();
    return true;
  }

  actOpenRoute(f: FactionId, routeId: string): boolean {
    if (!this.canAct(f)) return false;
    const fs = this.factions[f];
    if (fs.routes.length >= CONFIG.trade.maxRoutesPerFaction || fs.routes.includes(routeId)) return false;
    const r = TRADE_ROUTES.find((x) => x.id === routeId);
    if (!r) return false;
    const ownsEnd =
      this.provinces.get(r.a)!.owner === f || this.provinces.get(r.b)!.owner === f;
    if (!ownsEnd) return false;
    fs.routes.push(routeId);
    this.consume();
    return true;
  }

  actPass(f: FactionId): boolean {
    if (!this.canAct(f)) return false;
    this.consume();
    return true;
  }

  // ------------------------------------------------------- battle resolution

  private returnHome(f: FactionId, origin: string, army: Army): void {
    if (combatants(army) === 0) return;
    const p = this.provinces.get(origin);
    if (p && p.owner === f) mergeArmy(p.garrison, army);
    // else: retreat path lost, the force disperses
  }

  private resolveBattles(): void {
    const queue = this.pendingAttacks;
    this.pendingAttacks = [];
    for (const pa of queue) {
      if (!this.factions[pa.faction].alive || combatants(pa.army) === 0) continue;
      const p = this.provinces.get(pa.to)!;
      const prov = PROVINCE_BY_ID.get(pa.to)!;
      const siege = this.sieges.get(pa.to);
      if (siege && siege.attacker === pa.faction) {
        mergeArmy(siege.army, pa.army); // target got besieged by us earlier this phase
        continue;
      }
      if (siege) {
        // relief: fight the besieging army in the field
        this.battles++;
        this.touchWar(pa.faction, siege.attacker);
        const att0 = combatants(pa.army);
        const def0 = combatants(siege.army);
        const { attCard, defCard } = this.playBattleCards(
          pa.faction, siege.attacker, LAND_ATTACK_SCOPES, LAND_DEFENSE_SCOPES, 0);
        const r = resolveBattle(
          pa.army,
          siege.army,
          this.battleMods(
            {
              attackerBonus: pa.crossPenalty ? -CONFIG.combat.riverCrossingPenalty : 0,
              terrainBonus: CONFIG.combat.terrain[prov.terrain],
            },
            pa.faction, siege.attacker, attCard, defCard,
          ),
          this.rngCombat,
        );
        this.awardBattlePrestige(
          r.winner === 'attacker' ? pa.faction : r.winner === 'defender' ? siege.attacker : null,
          r,
          r.winner === 'attacker' ? att0 : def0,
          r.winner === 'attacker' ? def0 : att0,
        );
        if (r.winner === 'attacker') {
          this.sieges.delete(pa.to);
          if (p.owner === pa.faction) mergeArmy(p.garrison, pa.army); // enter the relieved city
          else this.returnHome(pa.faction, pa.from, pa.army);
        } else {
          this.returnHome(pa.faction, pa.from, pa.army);
        }
        continue;
      }
      if (p.owner === pa.faction) {
        mergeArmy(p.garrison, pa.army); // we captured it earlier this phase
        continue;
      }
      if (combatants(p.garrison) === 0) {
        p.garrison.siegeEngine = 0; // abandoned engines are destroyed
        this.capture(pa.to, pa.faction, pa.army, false); // walk-in occupation: no storm prestige
        continue;
      }
      if (p.wallTier > 0) {
        // walled and defended: invest the city (assault decided in siege phase)
        this.sieges.set(pa.to, {
          provinceId: pa.to,
          attacker: pa.faction,
          army: pa.army,
          origin: pa.from,
          rounds: 0,
          stores: CONFIG.siege.grainStoresRounds,
        });
        continue;
      }
      // open field battle (unwalled province)
      this.battles++;
      const att0 = combatants(pa.army);
      const def0 = combatants(p.garrison);
      const { attCard, defCard } = this.playBattleCards(
        pa.faction, p.owner, LAND_ATTACK_SCOPES, UNWALLED_DEFENSE_SCOPES, 0);
      const r = resolveBattle(
        pa.army,
        p.garrison,
        this.battleMods(
          {
            attackerBonus: pa.crossPenalty ? -CONFIG.combat.riverCrossingPenalty : 0,
            terrainBonus: CONFIG.combat.terrain[prov.terrain],
          },
          pa.faction, p.owner, attCard, defCard,
        ),
        this.rngCombat,
      );
      this.awardBattlePrestige(
        r.winner === 'attacker' ? pa.faction : r.winner === 'defender' ? p.owner : null,
        r,
        r.winner === 'attacker' ? att0 : def0,
        r.winner === 'attacker' ? def0 : att0,
      );
      if (r.winner === 'attacker') this.capture(pa.to, pa.faction, pa.army, true);
      else this.returnHome(pa.faction, pa.from, pa.army);
    }
  }

  /**
   * Flip ownership to f. `byForce` = the province fell to battle, assault,
   * starvation, or treachery (canon §13.1 "take a walled city by storm or
   * siege" — walk-in occupations of empty provinces score nothing).
   */
  private capture(pid: string, f: FactionId, army: Army, byForce: boolean): void {
    const p = this.provinces.get(pid)!;
    const prev = p.owner;
    p.owner = f;
    p.garrison = copyArmy(army);
    this.sieges.delete(pid);
    if (prev !== f) {
      const fs = this.factions[f];
      let pts = CONFIG.prestige.provinceCapture; // canon: 0 (tuning lever)
      if (byForce && p.wallTier >= 1) {
        // canon §13.1: walled city taken by storm or siege: +2 (+3 if T4-T5)
        pts += p.wallTier >= 4 ? CONFIG.prestige.walledCityCaptureHighTier : CONFIG.prestige.walledCityCapture;
        pts += CONFIG.factions[f].cityCapturePrestige; // Ottoman Ghaza bump
      }
      if (pts !== 0) {
        fs.ledger.conquests += pts;
        this.recomputeTotal(fs);
      }
    }
    if (prev && prev !== f) {
      if (CAPITALS[prev] === pid) {
        // canon §13.1: lose your capital: -3
        this.factions[prev].ledger.events += CONFIG.prestige.loseCapital;
        this.recomputeTotal(this.factions[prev]);
      }
      const w = this.touchWar(f, prev);
      w.captures[f] = (w.captures[f] ?? 0) + 1;
      let remaining = 0;
      for (const q of this.provinces.values()) if (q.owner === prev) remaining++;
      if (remaining === 0) this.eliminate(prev, f);
    }
  }

  private eliminate(loser: FactionId, conqueror: FactionId): void {
    const fs = this.factions[loser];
    fs.alive = false;
    fs.eliminatedRound = this.round;
    fs.routes = [];
    fs.cpleHold = 0;
    this.discardPile.push(...fs.hand); // a dead court's cards return to the pool
    fs.hand = [];
    for (const [pid, s] of [...this.sieges]) if (s.attacker === loser) this.sieges.delete(pid);
    for (const key of [...this.wars.keys()]) if (key.split('|').includes(loser)) this.wars.delete(key);
    const winner = this.factions[conqueror];
    winner.ledger.warsWon += CONFIG.prestige.warWon;
    this.recomputeTotal(winner);
  }

  // --------------------------------------------------------- siege advance

  private applyAttrition(a: Army, losses: number): void {
    // weakest first (canon §4.4 value order)
    let r = losses;
    let k = Math.min(a.levy, r); a.levy -= k; r -= k;
    k = Math.min(a.professional, r); a.professional -= k; r -= k;
    k = Math.min(a.mercenary, r); a.mercenary -= k; r -= k;
    k = Math.min(a.galley, r); a.galley -= k; r -= k;
  }

  /**
   * Galleys a faction can bring to bear on a sea zone: fleets in its owned
   * ports coasting the zone, plus the fleets of its siege camps at coastal
   * provinces of the zone. (No standing at-sea fleets are modeled.)
   */
  private galleysNearZone(f: FactionId, zoneId: string): number {
    let n = 0;
    for (const pid of SEA_ZONE_BY_ID.get(zoneId)!.coastalProvinces) {
      const p = this.provinces.get(pid)!;
      if (p.owner === f) n += p.garrison.galley;
      const s = this.sieges.get(pid);
      if (s && s.attacker === f) n += s.army.galley;
    }
    return n;
  }

  /**
   * R3 blockade test: the besieged coastal city is blockaded only if the
   * attacker has strict galley superiority over the defender in EVERY
   * adjacent sea zone. The defender's own harbor fleet counts (it holds the
   * boom); landlocked cities are always fully invested.
   */
  private isSeaBlockaded(pid: string, attacker: FactionId): boolean {
    const prov = PROVINCE_BY_ID.get(pid)!;
    if (prov.coasts.length === 0) return true; // landlocked: sealed by the land camp
    const owner = this.provinces.get(pid)!.owner;
    for (const z of prov.coasts) {
      const hostile = this.galleysNearZone(attacker, z);
      const friendly = owner ? this.galleysNearZone(owner, z) : 0;
      if (hostile <= friendly) return false; // zone not enemy-controlled
    }
    return true;
  }

  private resolveSieges(): void {
    // the unique Great Bombard: its owner deploys it at their juiciest siege
    const bombardAt = new Map<FactionId, string>();
    for (const [pid, s] of this.sieges) {
      if (!this.factions[s.attacker].hasGreatBombard) continue;
      const cur = bombardAt.get(s.attacker);
      if (cur === undefined || pid === 'constantinople') bombardAt.set(s.attacker, pid);
    }
    const sc = CONFIG.siege;
    for (const [pid, s] of [...this.sieges]) {
      if (!this.sieges.has(pid)) continue; // removed earlier this phase
      const fs = this.factions[s.attacker];
      if (!fs.alive) {
        this.sieges.delete(pid);
        continue;
      }
      const p = this.provinces.get(pid)!;
      const prov = PROVINCE_BY_ID.get(pid)!;
      s.rounds++;
      // 0. Treason at the Gate (canon §7.7): after 2+ consecutive siege
      //    rounds the besieger may buy the city outright.
      const treasonIdx = this.handIndexOf(s.attacker, 'treason-at-the-gate');
      if (treasonIdx >= 0) {
        const treason = this.cardBySlug.get('treason-at-the-gate')!;
        if (s.rounds >= (treason.minSiegeRounds ?? 2) && fs.gold >= (treason.costGold ?? 0)) {
          fs.hand.splice(treasonIdx, 1);
          fs.gold -= treason.costGold ?? 0;
          this.discardCard(treason); // removeFromGame: never returns
          p.garrison.siegeEngine = 0;
          this.capture(pid, s.attacker, s.army, true); // garrison surrenders, walls at current HP
          continue;
        }
      }
      // 1. bombardment (canon §8.2.2 dice; §8.3 T5 masonry cap — only the
      //    Great Bombard, canon §8.4, lifts it and adds its two dice)
      const hp = wallHitpoints(p.wallTier, prov.theodosianWalls);
      p.wallDamage = Math.min(
        hp,
        p.wallDamage + rollBombardment(s.army, bombardAt.get(s.attacker) === pid, p.wallTier >= 5, this.rngCombat),
      );
      // 2. starvation (canon §8.2.3 stores model) + besieger disease.
      //    Sea resupply: an unblockaded coastal city refills its stores.
      const blockaded = this.isSeaBlockaded(pid, s.attacker);
      if (sc.seaResupplyEnabled && prov.coasts.length > 0 && !blockaded) {
        s.stores = sc.grainStoresRounds; // resupplied over the open sea
      } else {
        // fully invested: the garrison may play its siege cards at the crunch
        let skipDepletion = false;
        if (p.owner && s.stores === 0) {
          const sails = prov.coasts.length > 0 ? this.takeCardIf(p.owner, 'sails-from-the-west') : null;
          if (sails) {
            skipDepletion = true; // blockade run: no depletion even under full blockade
            s.stores = Math.min(sc.grainStoresRounds, s.stores + (sails.restoreStores ?? 0));
          } else {
            const sortie = this.takeCardIf(p.owner, 'night-sortie');
            if (sortie) {
              skipDepletion = true;
              this.applyAttrition(s.army, sortie.besiegerLosesUnits ?? 1);
            }
          }
        }
        if (!skipDepletion) {
          if (s.stores > 0) s.stores--;
          else this.applyAttrition(p.garrison, sc.starvationUnitsPerRound);
        }
      }
      this.applyAttrition(s.army, attritionLosses(combatants(s.army), sc.besiegerAttritionPerRound, this.rngCombat));
      if (p.owner) this.touchWar(s.attacker, p.owner);
      if (combatants(p.garrison) === 0) {
        p.garrison.siegeEngine = 0;
        this.capture(pid, s.attacker, s.army, true); // starved out
        continue;
      }
      if (combatants(s.army) <= 2) {
        this.sieges.delete(pid); // camp too weak: lift the siege
        this.returnHome(s.attacker, s.origin, s.army);
        continue;
      }
      // 3. assault decision per the attacker's policy
      const prefs = this.agents[s.attacker].siege;
      const wallBonus = effectiveWallBonus(p.wallTier, prov.theodosianWalls, p.wallDamage);
      const desperate = this.round >= prefs.desperationRound;
      const strong = combatants(s.army) >= combatants(p.garrison) * prefs.strengthRatio;
      const want =
        sc.assaultAllowedAnytime &&
        strong &&
        (wallBonus <= prefs.assaultWallThreshold ||
          combatants(p.garrison) <= prefs.assaultGarrisonMax ||
          (desperate && wallBonus <= prefs.assaultWallThreshold + 1.5));
      if (!want) continue;
      this.assaults++;
      this.battles++;
      const escalade = p.wallDamage < hp ? -sc.escaladePenalty : 0; // canon §8.2.4
      const att0 = combatants(s.army);
      const def0 = combatants(p.garrison);
      const { attCard, defCard } = this.playBattleCards(
        s.attacker, p.owner, ASSAULT_ATTACK_SCOPES, LAND_DEFENSE_SCOPES, wallBonus);
      const r = resolveBattle(
        s.army,
        p.garrison,
        this.battleMods(
          { attackerBonus: escalade, terrainBonus: CONFIG.combat.terrain[prov.terrain], wallBonus },
          s.attacker, p.owner, attCard, defCard,
        ),
        this.rngCombat,
      );
      this.awardBattlePrestige(
        r.winner === 'attacker' ? s.attacker : r.winner === 'defender' ? p.owner : null,
        r,
        r.winner === 'attacker' ? att0 : def0,
        r.winner === 'attacker' ? def0 : att0,
      );
      if (r.winner === 'attacker') {
        p.garrison.siegeEngine = 0;
        this.capture(pid, s.attacker, s.army, true);
      } else if (combatants(s.army) <= 2) {
        this.sieges.delete(pid);
        this.returnHome(s.attacker, s.origin, s.army);
      }
      // failed assault with strength left: the siege grinds on
    }
  }

  // --------------------------------------------------------------- cleanup

  private recomputeTotal(fs: FactionState): void {
    const l = fs.ledger;
    l.total = l.capitals + l.keyCities + l.tradeRoutes + l.greatWorks + l.conquests + l.warsWon + l.objectives + l.events;
  }

  openRoutesOf(f: FactionId): typeof TRADE_ROUTES {
    const fs = this.factions[f];
    const out: typeof TRADE_ROUTES = [];
    for (const rid of fs.routes) {
      const r = TRADE_ROUTES.find((x) => x.id === rid)!;
      if (this.provinces.get(r.a)!.owner !== f && this.provinces.get(r.b)!.owner !== f) continue;
      if (CONFIG.trade.blockadeCancels && this.routeBlockaded(f, r.seaZones)) continue;
      out.push(r);
    }
    return out;
  }

  private routeBlockaded(owner: FactionId, zones: string[]): boolean {
    for (const enemy of this.warsOf(owner)) {
      for (const z of zones) {
        for (const pid of SEA_ZONE_BY_ID.get(z)!.coastalProvinces) {
          const p = this.provinces.get(pid)!;
          if (p.owner === enemy && p.garrison.galley > 0) return true;
        }
      }
    }
    return false;
  }

  private cleanup(): void {
    // muster end-of-round recruits (lost if the province changed hands)
    for (const r of this.pendingRecruits) {
      const p = this.provinces.get(r.province)!;
      if (p.owner === r.faction) p.garrison[r.unit] += r.count;
    }
    this.pendingRecruits = [];

    for (const f of FACTION_IDS) {
      const fs = this.factions[f];
      if (!fs.alive) continue;
      // sell grain above a two-round reserve
      let need = 0;
      for (const a of this.armiesOf(f)) need += grainUpkeepOf(f, a);
      if (fs.grain > 2 * need) {
        const excess = Math.floor(fs.grain - 2 * need);
        fs.grain -= excess;
        fs.gold += excess * CONFIG.economy.grainMarket.sellGoldPerGrain;
      }
      // prestige scoring (canon §13.1 income sources + sim route prestige)
      const pr = CONFIG.prestige;
      let keyCities = 0;
      for (const pid of KEY_IDS) if (this.provinces.get(pid)!.owner === f) keyCities++;
      let pts = keyCities * pr.keyCityPerRound;
      if (this.provinces.get('constantinople')!.owner === f) pts += pr.constantinopleExtraPerRound;
      fs.ledger.keyCities += pts;
      // capital income: own capital +1/round, each held enemy capital +3/round
      let capPts = 0;
      if (this.provinces.get(CAPITALS[f])!.owner === f) capPts += pr.ownCapitalPerRound;
      for (const other of FACTION_IDS) {
        if (other !== f && this.provinces.get(CAPITALS[other])!.owner === f) capPts += pr.enemyCapitalPerRound;
      }
      fs.ledger.capitals += capPts;
      // trade prestige: per open route, + canon monopoly when BOTH ends are owned
      const open = this.openRoutesOf(f);
      let monopolies = 0;
      for (const r of open) {
        if (this.provinces.get(r.a)!.owner === f && this.provinces.get(r.b)!.owner === f) monopolies++;
      }
      fs.ledger.tradeRoutes += open.length * pr.tradeRoutePerRound + monopolies * pr.tradeMonopolyPerRound;
      // secret objectives are NOT scored here — canon §13.1: revealed and
      // scored at GAME END only (see run()).
      this.recomputeTotal(fs);
    }

    // wars go quiet -> peace; net-capture leader "wins the war"
    for (const [key, w] of [...this.wars]) {
      const [a, b] = key.split('|') as [FactionId, FactionId];
      if (!this.factions[a].alive || !this.factions[b].alive) {
        this.wars.delete(key);
        continue;
      }
      if (this.round - w.lastCombatRound >= 3) {
        const net = (w.captures[a] ?? 0) - (w.captures[b] ?? 0);
        if (net !== 0) {
          const v = this.factions[net > 0 ? a : b];
          v.ledger.warsWon += CONFIG.prestige.warWon;
          this.recomputeTotal(v);
        }
        this.wars.delete(key);
      }
    }

    for (const f of FACTION_IDS) this.prestigeByRound[f].push(this.factions[f].ledger.total);
  }

  private checkVictory(): boolean {
    // sudden death: a non-Byzantine faction holds Constantinople 2 rounds
    const cpleOwner = this.provinces.get('constantinople')!.owner;
    for (const f of FACTION_IDS) {
      const fs = this.factions[f];
      fs.cpleHold = fs.alive && cpleOwner === f && f !== 'byzantium' ? fs.cpleHold + 1 : 0;
      if (fs.cpleHold >= CONFIG.game.suddenDeathHoldRounds) {
        this.winner = f;
        this.victoryType = 'suddenDeath';
        return true;
      }
    }
    // prestige threshold
    let best: FactionId | null = null;
    let aliveCount = 0;
    for (const f of FACTION_IDS) {
      const fs = this.factions[f];
      if (!fs.alive) continue;
      aliveCount++;
      if (fs.ledger.total >= CONFIG.prestige.victoryThreshold) {
        if (best === null || fs.ledger.total > this.factions[best].ledger.total) best = f;
      }
    }
    if (best) {
      this.winner = best;
      this.victoryType = 'threshold';
      return true;
    }
    if (aliveCount === 1) {
      this.winner = FACTION_IDS.find((f) => this.factions[f].alive)!;
      this.victoryType = 'elimination';
      return true;
    }
    return false;
  }

  // -------------------------------------------------- read API for agents

  faction(f: FactionId): FactionState {
    return this.factions[f];
  }

  province(pid: string): ProvinceState {
    return this.provinces.get(pid)!;
  }

  ownedProvinces(f: FactionId): string[] {
    const out: string[] = [];
    for (const p of this.provinces.values()) if (p.owner === f) out.push(p.id);
    return out;
  }

  reachableFrom(pid: string): readonly Reach[] {
    return REACH.get(pid) ?? [];
  }

  isBesieged(pid: string): boolean {
    return this.sieges.has(pid);
  }

  siegeAt(pid: string): { attacker: FactionId; army: Army; rounds: number } | null {
    const s = this.sieges.get(pid);
    return s ? { attacker: s.attacker, army: s.army, rounds: s.rounds } : null;
  }

  /** Garrison power scaled by terrain + current wall bonus (heuristic). */
  defenseScore(pid: string): number {
    const p = this.provinces.get(pid)!;
    const prov = PROVINCE_BY_ID.get(pid)!;
    const wall = effectiveWallBonus(p.wallTier, prov.theodosianWalls, p.wallDamage);
    const terr = CONFIG.combat.terrain[prov.terrain];
    return armyPower(p.garrison) * (1 + 0.35 * (terr + wall)) + 0.5;
  }

  wallBonusAt(pid: string): number {
    const p = this.provinces.get(pid)!;
    return effectiveWallBonus(p.wallTier, PROVINCE_BY_ID.get(pid)!.theodosianWalls, p.wallDamage);
  }

  /** Strongest hostile army power adjacent to pid (threat heuristic). */
  threatAt(pid: string): number {
    const me = this.provinces.get(pid)!.owner;
    let worst = 0;
    for (const r of REACH.get(pid) ?? []) {
      const q = this.provinces.get(r.to)!;
      if (q.owner === me || q.owner === null) continue;
      if (r.sea && q.garrison.galley === 0) continue;
      const pw = armyPower(q.garrison);
      if (pw > worst) worst = pw;
    }
    const s = this.sieges.get(pid);
    if (s) worst = Math.max(worst, armyPower(s.army));
    return worst;
  }

  estGrainIncome(f: FactionId): number {
    let n = 0;
    for (const p of this.provinces.values()) {
      if (p.owner === f && !this.sieges.has(p.id)) n += PROVINCE_BY_ID.get(p.id)!.yields.grain;
    }
    return n;
  }

  estGoldIncome(f: FactionId): number {
    let n = 0;
    for (const p of this.provinces.values()) {
      if (p.owner !== f || this.sieges.has(p.id)) continue;
      n += PROVINCE_BY_ID.get(p.id)!.yields.gold;
      if (p.market) n += CONFIG.buildings.market.extraGoldPerRound;
    }
    for (const r of this.openRoutesOf(f)) n += r.income * CONFIG.factions[f].tradeIncomeMult;
    if (this.provinces.get(CAPITALS[f])!.owner === f) n += CONFIG.factions[f].capitalExtraGold;
    return n;
  }

  grainNeedOf(f: FactionId): number {
    let need = 0;
    for (const a of this.armiesOf(f)) need += grainUpkeepOf(f, a);
    return need;
  }

  /** Gold wage bill per round (Janissary/Black Army donatives etc.). */
  goldNeedOf(f: FactionId): number {
    let need = 0;
    for (const a of this.armiesOf(f)) need += goldWageOf(f, a);
    return need;
  }

  /** Spare feeding capacity: income + a third of stock minus current need. */
  grainHeadroom(f: FactionId): number {
    const fs = this.factions[f];
    return this.estGrainIncome(f) + fs.grain / 3 - this.grainNeedOf(f);
  }

  routeCandidates(f: FactionId): typeof TRADE_ROUTES {
    const fs = this.factions[f];
    if (fs.routes.length >= CONFIG.trade.maxRoutesPerFaction) return [];
    return TRADE_ROUTES.filter(
      (r) =>
        !fs.routes.includes(r.id) &&
        (this.provinces.get(r.a)!.owner === f || this.provinces.get(r.b)!.owner === f),
    ).sort((x, y) => y.income - x.income || (x.id < y.id ? -1 : 1));
  }

  /** Owned provinces adjacent to at least one non-owned province. */
  borderOf(f: FactionId): string[] {
    const out: string[] = [];
    for (const p of this.provinces.values()) {
      if (p.owner !== f) continue;
      for (const r of REACH.get(p.id) ?? []) {
        if (this.provinces.get(r.to)!.owner !== f) {
          out.push(p.id);
          break;
        }
      }
    }
    return out;
  }

  /** First step of a shortest all-owned path from `from` to `to` (may use sea hops). */
  nextStepTo(f: FactionId, from: string, to: string): string | null {
    if (from === to) return null;
    const parent = new Map<string, string>();
    const queue = [from];
    const seen = new Set([from]);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const r of REACH.get(cur) ?? []) {
        if (seen.has(r.to)) continue;
        if (this.provinces.get(r.to)!.owner !== f) continue;
        seen.add(r.to);
        parent.set(r.to, cur);
        if (r.to === to) {
          let step = to;
          while (parent.get(step) !== from) step = parent.get(step)!;
          return step;
        }
        queue.push(r.to);
      }
    }
    return null;
  }

  /** First step of a shortest all-owned path from `from` to a border province. */
  nextStepToward(f: FactionId, from: string): string | null {
    const border = new Set(this.borderOf(f));
    if (border.has(from)) return null;
    const parent = new Map<string, string>();
    const queue = [from];
    const seen = new Set([from]);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const r of REACH.get(cur) ?? []) {
        if (seen.has(r.to)) continue;
        const q = this.provinces.get(r.to)!;
        if (q.owner !== f) continue;
        if (r.sea) continue; // land units cannot chain sea hops toward the front
        seen.add(r.to);
        parent.set(r.to, cur);
        if (border.has(r.to)) {
          let step = r.to;
          while (parent.get(step) !== from) step = parent.get(step)!;
          return step;
        }
        queue.push(r.to);
      }
    }
    return null;
  }
}

const KEY_IDS = PROVINCES.filter((p) => p.keyCity).map((p) => p.id);
