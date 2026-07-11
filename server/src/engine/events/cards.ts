/**
 * events/cards.ts — the Omen deck: data + per-card effect functions.
 *
 * Encodes all 46 event cards from docs/EVENT_CARDS.md across three era decks
 * (16 / 17 / 13). Each card carries:
 *   - a stable id (`omen-N`, the id that flows through `state.omenDeck` and
 *     `resolveCard`) plus a readable `slug`,
 *   - the printed metadata (name, tag, era, duration, targeting, faction lock),
 *   - a structured `effects` record of the exact numeric fields from the table
 *     (resource/prestige deltas, unit/garrison spawns, wall shifts, modifiers,
 *     unlocks), and
 *   - a pure `effect(state, ctx) => state` implementing the printed effect
 *     against the FROZEN GameState / rng / log API.
 *
 * The frozen contract exports (`CardTag`, `CardDuration`, `OmenCardDef`,
 * `OMEN_CARDS`, `OMEN_CARDS_BY_ERA`, `OMEN_CARD_BY_ID`, `omenCardId`) are kept
 * intact and DERIVED from the rich table below so `gameState.ts` (which imports
 * `OMEN_CARDS_BY_ERA`) and the barrel re-export keep working unchanged.
 *
 * Effect functions are pure: they never mutate their input, read all randomness
 * from `ctx.rng`, and log via `appendLog`. Where the printed effect needs a
 * subsystem the events agent finalises later (crusade/naval resolution, region
 * tables, round-scoped modifier storage, auctions, army-stack spawning), the
 * effect applies the directly-representable numeric deltas and logs the rest;
 * every such reading is listed in {@link AMBIGUITIES}.
 */
import type { GameState, Player, Province, ResourceBundle } from "@imperium/shared";
import { Faction, TerrainType, UnitType } from "@imperium/shared";
import type { Rng } from "../rng.js";
import { appendLog } from "../logEntry.js";
import { WALL_TIERS } from "../balance.js";

// ---------------------------------------------------------------------------
// FROZEN contract types (unchanged shapes)
// ---------------------------------------------------------------------------

/** A card's broad tag (EVENT_CARDS.md). */
export type CardTag = "Good" | "Ill" | "Mixed" | "Omen";

/** Frozen duration enum consumed by the deck plumbing. */
export type CardDuration = "Immediate" | "Held" | "Standing";

/** Static definition of an Omen card (frozen contract shape). */
export interface OmenCardDef {
  id: string;
  /** Card number 1..46 as printed in EVENT_CARDS.md. */
  n: number;
  name: string;
  tag: CardTag;
  era: 1 | 2 | 3;
  duration: CardDuration;
  /** Faction the card is specific to (treated as neutral if no valid target). */
  factionSpecific?: Faction;
}

/** Helper to build a card id from its number. */
export const omenCardId = (n: number): string => `omen-${n}`;

// ---------------------------------------------------------------------------
// Rich event-card model (data + effect fn)
// ---------------------------------------------------------------------------

/**
 * Printed duration, richer than the frozen {@link CardDuration}:
 * - IMMEDIATE  — resolves the round it is drawn.
 * - PERSISTENT — a timed modifier lasting a fixed number of rounds.
 * - GRANT      — hands the drawer/players a one-time option or unit to spend.
 * - HELD       — kept by the drawer to play on a later turn.
 * - STANDING   — a lasting map modifier (rest of game / until cancelled).
 */
export type EventDuration = "IMMEDIATE" | "PERSISTENT" | "GRANT" | "HELD" | "STANDING";

/** What the card's printed effect is pointed at. */
export type EventTargeting =
  | "GLOBAL"
  | "DRAWER"
  | "PLAYER"
  | "PROVINCE"
  | "FACTION"
  | "MINOR"
  | "SEA_ZONE"
  | "NONE";

/**
 * The exact numeric fields drawn from the EVENT_CARDS.md table. All optional;
 * a card only fills the fields it uses. This is the authoritative machine-
 * readable copy of the printed numbers (the effect fn applies the subset the
 * frozen state can currently store; the rest are here for the events agent).
 */
export interface EventEffectSpec {
  goldDelta?: number;
  grainDelta?: number;
  timberDelta?: number;
  stoneDelta?: number;
  faithDelta?: number;
  prestigeDelta?: number;
  /** Units spawned (modelled as garrison increments in the effect fn today). */
  spawnUnits?: Partial<Record<UnitType, number>>;
  /** Wall-tier shift applied to the targeted city (negative = damage). */
  wallTierDelta?: number;
  /** Static garrison shift on the targeted province/minor. */
  garrisonDelta?: number;
  /** Levy/merc morale modifier for the round (read by combat). */
  moraleDelta?: number;
  /** Land movement modifier for the round (read by movement). */
  moveDelta?: number;
  /** Grain upkeep modifier for the round (read by economy). */
  upkeepDelta?: number;
  /** Siege progress modifier for the round (read by siege resolution). */
  siegeDelta?: number;
  /** Trade gold modifier for the round (read by economy/trade). */
  tradeDelta?: number;
  /** How many rounds a PERSISTENT/STANDING modifier lasts (0 = permanent). */
  durationRounds?: number;
  /** Province ids the card names/targets. */
  provinces?: string[];
  /** Sea-zone ids the card names/targets. */
  seaZones?: string[];
  /** Minor-state ids the card names/targets. */
  minors?: string[];
  /** Capability the card unlocks (e.g. "GREAT_BOMBARD"). */
  unlock?: string;
  /** True for endgame sudden-death trigger (#46). */
  suddenDeath?: boolean;
}

/**
 * Context handed to an effect fn. `drawerId` is the player who drew the card
 * (the "drawing faction" in the flavor text); it may be null for pure table
 * omens. `rng` is derived by the caller from `state.rngSeed`/`rngCursor`; the
 * caller writes the advanced cursor back after the effect returns.
 */
export interface EventEffectContext {
  drawerId: string | null;
  rng: Rng;
  /** Province the drawer chose to target, if the card asks for one. */
  targetProvinceId?: string;
  /** Player the drawer chose to target, if the card asks for one. */
  targetPlayerId?: string;
  /** Free-form choice token (e.g. region "Anatolia", "ACCEPT"/"REFUSE"). */
  choice?: string;
}

/** A pure card effect: returns a new GameState, never mutating the input. */
export type EventEffect = (state: GameState, ctx: EventEffectContext) => GameState;

/** Full rich definition of an event card. */
export interface EventCard extends OmenCardDef {
  /** Readable stable slug (kebab-case), parallel to the `omen-N` id. */
  slug: string;
  /** Rich printed duration (see {@link EventDuration}). */
  eventDuration: EventDuration;
  targeting: EventTargeting;
  effects: EventEffectSpec;
  effect: EventEffect;
}

// ---------------------------------------------------------------------------
// Pure immutable helpers
// ---------------------------------------------------------------------------

function addRes(t: ResourceBundle, d: Partial<ResourceBundle>): ResourceBundle {
  return {
    gold: Math.max(0, t.gold + (d.gold ?? 0)),
    grain: Math.max(0, t.grain + (d.grain ?? 0)),
    timber: Math.max(0, t.timber + (d.timber ?? 0)),
    marble: Math.max(0, t.marble + (d.marble ?? 0)),
    faith: Math.max(0, t.faith + (d.faith ?? 0)),
  };
}

function mapPlayerId(state: GameState, id: string, fn: (p: Player) => Player): GameState {
  return { ...state, players: state.players.map((p) => (p.id === id ? fn(p) : p)) };
}

function mapProvince(state: GameState, id: string, fn: (p: Province) => Province): GameState {
  return { ...state, provinces: state.provinces.map((pr) => (pr.id === id ? fn(pr) : pr)) };
}

function findProvince(state: GameState, id: string): Province | undefined {
  return state.provinces.find((p) => p.id === id);
}

function controllerId(state: GameState, provinceId: string): string | null {
  return findProvince(state, provinceId)?.ownerId ?? null;
}

function playerByFaction(state: GameState, faction: Faction): Player | null {
  return state.players.find((p) => p.faction === faction) ?? null;
}

function factionInPlay(state: GameState, faction: Faction): boolean {
  return state.players.some((p) => p.faction === faction);
}

/** Number of provinces a faction controls (a crude strength proxy). */
function factionProvinceCount(state: GameState, faction: Faction): number {
  const pl = playerByFaction(state, faction);
  if (!pl) return -1;
  return state.provinces.filter((p) => p.ownerId === pl.id).length;
}

function grantRes(state: GameState, playerId: string, d: Partial<ResourceBundle>): GameState {
  return mapPlayerId(state, playerId, (p) => ({ ...p, treasury: addRes(p.treasury, d) }));
}

function grantPrestige(state: GameState, playerId: string, delta: number): GameState {
  return mapPlayerId(state, playerId, (p) => ({ ...p, prestige: p.prestige + delta }));
}

/** Grant a resource bundle to whichever player controls each named province. */
function grantToControllers(
  state: GameState,
  provinceIds: string[],
  d: Partial<ResourceBundle>,
): GameState {
  let s = state;
  for (const pid of provinceIds) {
    const owner = controllerId(s, pid);
    if (owner) s = grantRes(s, owner, d);
  }
  return s;
}

/** Shift a province's wall tier by `delta`, re-deriving hp from WALL_TIERS. */
function shiftWall(prov: Province, delta: number): Province {
  const tier = Math.max(0, Math.min(3, prov.walls.tier + delta));
  const hp = WALL_TIERS[tier]?.hp ?? 0;
  return { ...prov, walls: { tier, hp } };
}

function shiftGarrison(prov: Province, delta: number): Province {
  return { ...prov, garrison: Math.max(0, (prov.garrison ?? 0) + delta) };
}

/** Add `delta` to a minor state's garrison (models levy spawns for minors). */
function shiftMinorGarrison(state: GameState, minorId: string, delta: number): GameState {
  return {
    ...state,
    minors: state.minors.map((m) =>
      m.id === minorId ? { ...m, garrison: Math.max(0, m.garrison + delta) } : m,
    ),
  };
}

/** Set a minor's vassalOf pointer (null to free it). */
function setMinorVassal(state: GameState, minorId: string, lordPlayerId: string | null): GameState {
  return {
    ...state,
    minors: state.minors.map((m) => (m.id === minorId ? { ...m, vassalOf: lordPlayerId } : m)),
  };
}

/** Set a province's owner (null = Independent/neutral). */
function setProvinceOwner(state: GameState, provinceId: string, ownerId: string | null): GameState {
  return mapProvince(state, provinceId, (p) => ({ ...p, ownerId }));
}

function eventLog(
  state: GameState,
  ctx: EventEffectContext,
  message: string,
  data?: Record<string, unknown>,
): GameState {
  return appendLog(state, {
    round: state.round,
    phase: state.phase,
    type: "event_card",
    actors: ctx.drawerId ? [ctx.drawerId] : [],
    data,
    message,
  });
}

// Named province / sea groups referenced by the cards -----------------------
const SILK_ROAD = ["trebizond", "bursa", "aleppo", "kaffa"];
const INTERREGNUM_ANATOLIA = ["ankara", "nicaea", "bursa"];
const INTERREGNUM_EUROPE = ["sofia", "philippopolis"];
const BEYLIKS = ["ankara", "konya", "kastamonu"];
const ANATOLIAN_ALLIANCE_TARGETS = ["bursa", "nicaea"];
const EARTHQUAKE_CITIES = ["constantinople", "gallipoli", "rhodes", "thessalonica"];
const CORSAIR_SEAS = ["sicilian-channel", "eastern-mediterranean", "aegean"];
const FROZEN_SEAS = ["black-sea-west", "black-sea-east", "sea-of-azov"];
const BYZ_CIVIL_WAR_PROVINCES = ["thessalonica", "morea", "selymbria"];
const RELIC_PROVINCES = ["constantinople", "thessalonica", "rome", "morea", "nicaea"];
// Coarse regional plains lists (no region tag exists on Province; see AMBIGUITIES).
const ANATOLIA_PLAINS = ["bursa", "nicaea", "ankara", "konya", "kastamonu", "antalya", "smyrna"];
const BALKAN_PLAINS = ["sofia", "philippopolis", "serbia", "wallachia", "varna", "belgrade"];

const CHRISTIAN_FACTIONS: Faction[] = [
  Faction.BYZANTIUM,
  Faction.VENICE,
  Faction.GENOA,
  Faction.HUNGARY,
];

/** Pick a card-named target with a random fallback, seeded from ctx.rng. */
function pickFrom(ctx: EventEffectContext, options: string[]): string {
  if (ctx.choice && options.includes(ctx.choice)) return ctx.choice;
  if (ctx.targetProvinceId && options.includes(ctx.targetProvinceId)) return ctx.targetProvinceId;
  const idx = (ctx.rng.rollD6() - 1) % options.length;
  return options[idx];
}

// ---------------------------------------------------------------------------
// Per-card effect functions (e1 .. e46)
// ---------------------------------------------------------------------------

// #1 Bumper Harvest — every plains/grain-primary province +1 grain to its holder.
const e1: EventEffect = (state, ctx) => {
  const plains = state.provinces.filter((p) => p.terrain === TerrainType.PLAINS).map((p) => p.id);
  let s = grantToControllers(state, plains, { grain: 1 });
  return eventLog(s, ctx, "Bumper Harvest: +1 grain from every plains province; grain sells favourably.");
};

// #2 Hard Winter — round modifiers (upkeep +1, move −1, sieges halt); 3 seas freeze.
const e2: EventEffect = (state, ctx) =>
  eventLog(state, ctx, "Hard Winter: +1 grain upkeep, land movement −1, sieges make no progress; Black Sea and Azov freeze.", {
    upkeepDelta: 1,
    moveDelta: -1,
    frozenSeas: FROZEN_SEAS,
  });

// #3 Silk Road Caravan — holders of the caravan cities +3 gold.
const e3: EventEffect = (state, ctx) => {
  const s = grantToControllers(state, SILK_ROAD, { gold: 3 });
  return eventLog(s, ctx, "Silk Road Caravan: +3 gold to holders of Trebizond/Bursa/Aleppo/Kaffa.");
};

// #4 Papal Indulgence — GRANT: drawer converts up to 3 faith→3 gold this round.
const e4: EventEffect = (state, ctx) => {
  if (!ctx.drawerId) return eventLog(state, ctx, "Papal Indulgence offered, but no faction claimed it.");
  const drawer = state.players.find((p) => p.id === ctx.drawerId);
  const faith = drawer ? Math.min(3, drawer.treasury.faith) : 0;
  const canFreeLevy =
    drawer && (drawer.faction === Faction.HUNGARY || drawer.faction === Faction.BYZANTIUM);
  if (canFreeLevy && ctx.choice === "LEVY") {
    // Spend the faith to raise 1 free levy (modelled at the drawer's capital).
    const s = grantRes(state, ctx.drawerId, { faith: -Math.min(3, faith) });
    return eventLog(s, ctx, "Papal Indulgence: faith spent to raise 1 free levy.", { spawnUnits: { LEVY: 1 } });
  }
  const s = grantRes(state, ctx.drawerId, { faith: -faith, gold: faith });
  return eventLog(s, ctx, `Papal Indulgence: converted ${faith} faith to ${faith} gold.`);
};

// #5 Imperial Coronation — drawer +2 prestige, +2 gold, levies +1 morale (1 round).
const e5: EventEffect = (state, ctx) => {
  if (!ctx.drawerId) return eventLog(state, ctx, "Imperial Coronation with no sovereign to crown.");
  let s = grantPrestige(state, ctx.drawerId, 2);
  s = grantRes(s, ctx.drawerId, { gold: 2 });
  return eventLog(s, ctx, "Imperial Coronation: +2 prestige, +2 gold, levies +1 morale this round.", { moraleDelta: 1 });
};

// #6 Comet Omen — all levies −1 morale except drawer's (+1).
const e6: EventEffect = (state, ctx) =>
  eventLog(state, ctx, "Comet Omen: every levy fights at −1 morale this round (drawer's levies +1).", {
    moraleDelta: -1,
    drawerMoraleDelta: 1,
  });

// #7 Ottoman Interregnum — Ottoman loses 2 provinces to Independent, −2 prestige, no recruit.
const e7: EventEffect = (state, ctx) => {
  const ott = playerByFaction(state, Faction.OTTOMAN);
  if (!ott) return eventLog(state, ctx, "Ottoman Interregnum drawn with no Ottoman in play — treated as a neutral omen.");
  let s: GameState = state;
  const anat = INTERREGNUM_ANATOLIA.find((id) => controllerId(s, id) === ott.id);
  const euro = INTERREGNUM_EUROPE.find((id) => controllerId(s, id) === ott.id);
  if (anat) s = setProvinceOwner(s, anat, null);
  if (euro) s = setProvinceOwner(s, euro, null);
  s = grantPrestige(s, ott.id, -2);
  return eventLog(s, ctx, "Ottoman Interregnum: two provinces fall to Independent, Ottoman −2 prestige, no recruit next round.", {
    lostProvinces: [anat, euro].filter(Boolean),
    noRecruitNextRound: ott.id,
  });
};

// #8 Timurid Shadow — beyliks +1 levy each turn hostile; one Ottoman province raided −2 gold.
const e8: EventEffect = (state, ctx) => {
  const ott = playerByFaction(state, Faction.OTTOMAN);
  if (!ott) return eventLog(state, ctx, "Timurid Shadow drawn with no Ottoman in play — treated as a neutral omen.");
  let s: GameState = state;
  for (const b of BEYLIKS) {
    // Beyliks that are minor provinces gain garrison; else province garrison +1.
    if (s.minors.some((m) => m.provinceIds.includes(b))) {
      const minor = s.minors.find((m) => m.provinceIds.includes(b))!;
      s = shiftMinorGarrison(s, minor.id, 1);
    } else if (findProvince(s, b)) {
      s = mapProvince(s, b, (p) => shiftGarrison(p, 1));
    }
  }
  const raided = INTERREGNUM_ANATOLIA.find((id) => controllerId(s, id) === ott.id);
  if (raided) s = grantRes(s, ott.id, { gold: -2 });
  return eventLog(s, ctx, "Timurid Shadow: Anatolian beyliks arm and turn hostile; one Ottoman province raided (−2 gold, 0 yield next round).", {
    raided,
    zeroYieldNextRound: raided,
  });
};

// #9 Discovery of Alum — chios holder gains a permanent +2 gold/round (STANDING).
const e9: EventEffect = (state, ctx) => {
  const owner = controllerId(state, "chios");
  let s = owner ? grantRes(state, owner, { gold: 2 }) : state;
  return eventLog(s, ctx, "Discovery of Alum: whoever holds Chios gains a standing +2 gold/round (dye monopoly).", {
    standing: true,
    perRoundGold: 2,
    province: "chios",
  });
};

// #10 Marriage Alliance — HELD: drawer takes 3 gold dowry (or NAP / discounted vassal).
const e10: EventEffect = (state, ctx) => {
  if (!ctx.drawerId) return eventLog(state, ctx, "Marriage Alliance with no suitor.");
  const s = grantRes(state, ctx.drawerId, { gold: 3 });
  return eventLog(s, ctx, "Marriage Alliance: 3 gold dowry taken; drawer may form a 2-round NAP or vassalise a minor at −50% tribute.", {
    napRounds: 2,
    vassalTributeDiscount: 0.5,
  });
};

// #11 Corsair Raid — a coastal province on a southern sea loses 2 gold + 1 galley; sea blockaded.
const e11: EventEffect = (state, ctx) => {
  const coastal = state.provinces.find(
    (p) => p.coastal && p.ownerId && CORSAIR_SEAS.some(() => true),
  );
  let s: GameState = state;
  if (coastal?.ownerId) s = grantRes(s, coastal.ownerId, { gold: -2 });
  const sea = pickFrom(ctx, CORSAIR_SEAS);
  return eventLog(s, ctx, "Corsair Raid: a coastal province loses 2 gold and a merchant galley; the sea zone is corsair-blockaded (trade −1) until cleared.", {
    province: coastal?.id,
    seaZone: sea,
    tradeDelta: -1,
  });
};

// #12 Serbian Despotate Submits — serbia vassalises to stronger of Hungary/Ottoman, else garrison +1.
const e12: EventEffect = (state, ctx) => {
  const hun = factionProvinceCount(state, Faction.HUNGARY);
  const ott = factionProvinceCount(state, Faction.OTTOMAN);
  const lordFaction = hun < 0 && ott < 0 ? null : hun >= ott ? Faction.HUNGARY : Faction.OTTOMAN;
  if (!lordFaction) {
    const s = mapProvince(state, "serbia", (p) => shiftGarrison(p, 1));
    return eventLog(s, ctx, "Serbian Despotate: neither Hungary nor Ottoman qualifies; Serbia stays Independent (garrison +1).");
  }
  const lord = playerByFaction(state, lordFaction)!;
  let s = setMinorVassal(state, "serbia", lord.id);
  s = grantRes(s, lord.id, { gold: 2 });
  return eventLog(s, ctx, `Serbian Despotate submits to ${lordFaction} (+2 gold tribute, +1 levy/round to the lord).`, {
    lord: lord.id,
    tributeGold: 2,
    levyPerRound: 1,
  });
};

// #13 Ragusan Tribute — strongest naval power (Venice default) +3 gold, may take ragusa as vassal.
const e13: EventEffect = (state, ctx) => {
  const lordFaction = factionInPlay(state, Faction.VENICE)
    ? Faction.VENICE
    : factionInPlay(state, Faction.GENOA)
      ? Faction.GENOA
      : null;
  if (!lordFaction) return eventLog(state, ctx, "Ragusan Tribute offered, but no maritime power is present — neutral.");
  const lord = playerByFaction(state, lordFaction)!;
  let s = grantRes(state, lord.id, { gold: 3 });
  s = setMinorVassal(s, "ragusa", lord.id);
  return eventLog(s, ctx, `Ragusan Tribute: ${lordFaction} gains 3 gold and takes Ragusa as a tribute-vassal without a siege.`);
};

// #14 Plague of Locusts — chosen region's plains −2 grain this round.
const e14: EventEffect = (state, ctx) => {
  const region = ctx.choice === "BALKANS" ? BALKAN_PLAINS : ANATOLIA_PLAINS;
  const label = ctx.choice === "BALKANS" ? "the Balkans" : "Anatolia";
  const s = grantToControllers(state, region, { grain: -2 });
  return eventLog(s, ctx, `Plague of Locusts devours the fields of ${label}: every plains province there −2 grain this round.`);
};

// #15 Hussite Handgunners for Hire — GRANT: any faction may hire a merc handgunner; Genoa no brokerage.
const e15: EventEffect = (state, ctx) =>
  eventLog(state, ctx, "Hussite Handgunners for Hire: a mercenary handgunner unit may be hired for gold this round; Genoa earns no brokerage.", {
    hireable: "HANDGUNNER",
    genoaBrokerage: 0,
  });

// #16 Fall of a Beylik — chosen beylik garrison −1, or submits as a vassal.
const e16: EventEffect = (state, ctx) => {
  const target = pickFrom(ctx, ["smyrna", "antalya", "kastamonu"]);
  let s: GameState = state;
  const minor = s.minors.find((m) => m.provinceIds.includes(target));
  if (minor) s = shiftMinorGarrison(s, minor.id, -1);
  else if (findProvince(s, target)) s = mapProvince(s, target, (p) => shiftGarrison(p, -1));
  return eventLog(s, ctx, `Fall of a Beylik: ${target} garrison −1 (ripe for conquest) or it submits to the strongest adjacent power.`);
};

// #17 Council of Florence — Byzantium chooses Union (aid, −2 faith/round ×2, −1 prestige) or Refuse.
const e17: EventEffect = (state, ctx) => {
  const byz = playerByFaction(state, Faction.BYZANTIUM);
  if (!byz) return eventLog(state, ctx, "Council of Florence with no Byzantium in play — treated as a neutral omen.");
  if (ctx.choice === "ACCEPT") {
    let s = grantPrestige(state, byz.id, -1);
    s = grantRes(s, byz.id, { faith: -2 });
    return eventLog(s, ctx, "Council of Florence: Byzantium ACCEPTS Union — Western aid, but −2 faith/round for 2 rounds and −1 prestige.", {
      faithPerRound: -2,
      durationRounds: 2,
    });
  }
  return eventLog(state, ctx, "Council of Florence: Byzantium REFUSES Union — keeps its faith income and pursues 'Faith of the Fathers'.");
};

// #18 Venetian–Genoese War — STANDING (2 rounds): forced fights; both −2 trade; neutrals +1 gold.
const e18: EventEffect = (state, ctx) => {
  if (!factionInPlay(state, Faction.VENICE) || !factionInPlay(state, Faction.GENOA)) {
    return eventLog(state, ctx, "Venetian–Genoese War drawn without both republics present — treated as a neutral omen.");
  }
  let s: GameState = state;
  for (const f of [Faction.VENICE, Faction.GENOA]) {
    const pl = playerByFaction(s, f);
    if (pl) s = grantRes(s, pl.id, { gold: -2 });
  }
  for (const pl of s.players) {
    if (pl.faction && pl.faction !== Faction.VENICE && pl.faction !== Faction.GENOA) {
      s = grantRes(s, pl.id, { gold: 1 });
    }
  }
  return eventLog(s, ctx, "Venetian–Genoese War: for 2 rounds Venice and Genoa must fight where they meet (−2 trade each); non-maritime factions +1 gold. Ended early by Peace of Turin.", {
    standing: true,
    durationRounds: 2,
  });
};

// #19 Hunyadi's Long Campaign — Hungary land +1, one extra Balkan move, may rally Serbia/Wallachia.
const e19: EventEffect = (state, ctx) => {
  const hun = playerByFaction(state, Faction.HUNGARY);
  if (!hun) return eventLog(state, ctx, "Hunyadi's Long Campaign with no Hungary in play — treated as a neutral omen.");
  return eventLog(state, ctx, "Hunyadi's Long Campaign: Hungarian land units fight at +1 and gain one extra Balkan move; Serbia and Wallachia may rally as temporary allies.", {
    moraleDelta: 1,
    extraMove: 1,
    tempAllies: ["serbia", "wallachia"],
  });
};

// #20 Varna Crusade — a crusade at Varna/Belgrade vs the Ottoman (resolution handed to combat).
const e20: EventEffect = (state, ctx) =>
  eventLog(state, ctx, "Varna Crusade: Christian factions may commit to a Crusader army at Varna/Belgrade. Win → joiners split +3 prestige and may take Varna/Sofia; Ottoman win → Ottoman +3 prestige and Hungary loses its Black Army.", {
    prestigeOnWin: 3,
    ottomanPrestigeOnWin: 3,
    musterProvinces: ["varna", "belgrade"],
  });

// #21 Fall of Thessalonica — wall −1, garrison −1; Ottoman may capture at −50% siege cost.
const e21: EventEffect = (state, ctx) => {
  const owner = controllerId(state, "thessalonica");
  if (owner == null) return eventLog(state, ctx, "Fall of Thessalonica: the city is unclaimed — treated as a neutral omen.");
  let s = mapProvince(state, "thessalonica", (p) => shiftGarrison(shiftWall(p, -1), -1));
  const ownerPlayer = s.players.find((p) => p.id === owner);
  if (ownerPlayer?.faction === Faction.VENICE) s = grantRes(s, owner, { gold: -3 });
  return eventLog(s, ctx, "Fall of Thessalonica: wall tier −1, garrison −1; an adjacent Ottoman may capture it at −50% siege cost (Venetian holder also −3 gold).", {
    siegeCostMultiplier: 0.5,
  });
};

// #22 Mercenary Revolt — factions that can't cover merc/Janissary/Black Army upkeep: desert + pillage.
const e22: EventEffect = (state, ctx) =>
  eventLog(state, ctx, "Mercenary Revolt: any faction that cannot cover its mercenary/Janissary/Black Army gold upkeep this round loses those units, which pillage their province (−2 gold, 0 yield next round).", {
    pillageGold: -2,
  });

// #23 Janissary Discontent — Ottoman pays 3 gold donative or Janissaries fight −1, no assault.
const e23: EventEffect = (state, ctx) => {
  const ott = playerByFaction(state, Faction.OTTOMAN);
  if (!ott) return eventLog(state, ctx, "Janissary Discontent with no Ottoman in play — treated as a neutral omen.");
  if (ctx.choice === "REFUSE") {
    return eventLog(state, ctx, "Janissary Discontent: donative refused — Janissaries fight at −1 and may not assault walls next round.", {
      moraleDelta: -1,
    });
  }
  const canPay = ott.treasury.gold >= 3;
  if (canPay) {
    const s = grantRes(state, ott.id, { gold: -3 });
    return eventLog(s, ctx, "Janissary Discontent: Ottoman pays the 3 gold donative and keeps the corps content.");
  }
  return eventLog(state, ctx, "Janissary Discontent: Ottoman cannot pay the donative — Janissaries fight at −1 and may not assault walls next round.", {
    moraleDelta: -1,
  });
};

// #24 Wallachian Revolt — vassal Wallachia breaks free, spawns 2 levy + 1 light cav, raids ex-lord.
const e24: EventEffect = (state, ctx) => {
  const wal = state.minors.find((m) => m.id === "wallachia");
  if (!wal || wal.vassalOf == null) {
    return eventLog(state, ctx, "Wallachian Revolt drawn while Wallachia is no one's vassal — treated as a neutral omen.");
  }
  const exLord = wal.vassalOf;
  let s = setMinorVassal(state, "wallachia", null);
  s = shiftMinorGarrison(s, "wallachia", 3); // 2 levy + 1 light cavalry
  s = setProvinceOwner(s, "wallachia", null);
  // Raid one adjacent province of the former lord.
  const raided = s.provinces.find((p) => p.ownerId === exLord);
  if (raided?.ownerId) s = grantRes(s, raided.ownerId, { gold: -2 });
  return eventLog(s, ctx, "Wallachian Revolt: Wallachia breaks free (spawns 2 levy + 1 light cavalry) and raids its former lord (−2 gold, 0 yield next round).", {
    exLord,
    raided: raided?.id,
    spawnUnits: { LEVY: 2, CAVALRY: 1 },
  });
};

// #25 Earthquake — one walled city wall tier −1.
const e25: EventEffect = (state, ctx) => {
  const target = pickFrom(ctx, EARTHQUAKE_CITIES);
  const s = mapProvince(state, target, (p) => shiftWall(p, -1));
  return eventLog(s, ctx, `Earthquake: ${target} loses a wall tier (repairable later with marble).`);
};

// #26 The Grain Fleet Is Lost — target coastal faction −3 grain + 1 galley, else a levy starves.
const e26: EventEffect = (state, ctx) => {
  const targetId =
    ctx.targetPlayerId ??
    controllerId(state, "constantinople") ??
    state.players.find((p) => p.faction)?.id ??
    null;
  if (!targetId) return eventLog(state, ctx, "The Grain Fleet Is Lost, but there was no fleet to lose.");
  const target = state.players.find((p) => p.id === targetId)!;
  if (target.treasury.grain >= 3) {
    const s = grantRes(state, targetId, { grain: -3 });
    return eventLog(s, ctx, "The Grain Fleet Is Lost: target loses 3 grain and a merchant galley.", { loseGalley: 1 });
  }
  return eventLog(state, ctx, "The Grain Fleet Is Lost: target cannot pay in grain — a levy starves (removed).", { starveLevy: 1 });
};

// #27 Fire of the Arsenal — targeted maritime power can't build fleets 1 round, −2 timber, −1 galley.
const e27: EventEffect = (state, ctx) => {
  const target =
    (ctx.targetPlayerId && state.players.find((p) => p.id === ctx.targetPlayerId)) ||
    playerByFaction(state, Faction.VENICE) ||
    playerByFaction(state, Faction.GENOA);
  if (!target) return eventLog(state, ctx, "Fire of the Arsenal with no maritime power to strike — neutral.");
  const s = grantRes(state, target.id, { timber: -2 });
  return eventLog(s, ctx, "Fire of the Arsenal: the maritime power cannot build fleets for 1 round, loses a galley under construction and −2 timber.", {
    noFleetBuildRounds: 1,
    loseGalley: 1,
  });
};

// #28 Papal Interdict — the last Christian-attacker loses all faith income 2 rounds, no crusade.
const e28: EventEffect = (state, ctx) => {
  const targetId = ctx.targetPlayerId ?? null;
  if (!targetId) {
    return eventLog(state, ctx, "Papal Interdict: no faction has lately struck a fellow Christian — treated as a neutral omen.", {
      faithIncomeMultiplier: 0,
      durationRounds: 2,
    });
  }
  return eventLog(state, ctx, "Papal Interdict: target loses all faith income for 2 rounds, cannot call a Crusade, and −25% to diplomacy/sieges vs Christian neutrals.", {
    faithIncomeMultiplier: 0,
    durationRounds: 2,
    penaltyVsChristianNeutrals: -0.25,
  });
};

// #29 Schism — all faith income halved next round; Byzantium/Hungary/Rome-holder −1 prestige.
const e29: EventEffect = (state, ctx) => {
  let s: GameState = state;
  const byz = playerByFaction(s, Faction.BYZANTIUM);
  const hun = playerByFaction(s, Faction.HUNGARY);
  const romeOwner = controllerId(s, "rome");
  if (byz) s = grantPrestige(s, byz.id, -1);
  if (hun) s = grantPrestige(s, hun.id, -1);
  if (romeOwner && romeOwner !== byz?.id && romeOwner !== hun?.id) s = grantPrestige(s, romeOwner, -1);
  return eventLog(s, ctx, "Schism: all faith income halved next round; faith-reliant factions each −1 prestige.", {
    faithIncomeMultiplier: 0.5,
    durationRounds: 1,
  });
};

// #30 Mamluk Embargo — E-Med trade +1 cost / −1 yield; Venice and Genoa each −2 gold.
const e30: EventEffect = (state, ctx) => {
  let s: GameState = state;
  for (const f of [Faction.VENICE, Faction.GENOA]) {
    const pl = playerByFaction(s, f);
    if (pl) s = grantRes(s, pl.id, { gold: -2 });
  }
  return eventLog(s, ctx, "Mamluk Embargo: trade through the Eastern Mediterranean costs +1 and yields −1 this round; Venice and Genoa each −2 gold; a Mamluk force threatens Cyprus.", {
    seaZone: "eastern-mediterranean",
    tradeDelta: -1,
  });
};

// #31 Anatolian Alliance — beyliks +1 levy each, coordinated attack; Ottoman fights −1 there.
const e31: EffectPlaceholder = (state, ctx) => {
  const ott = playerByFaction(state, Faction.OTTOMAN);
  if (!ott) return eventLog(state, ctx, "Anatolian Alliance drawn with no Ottoman in play — treated as a neutral omen.");
  let s: GameState = state;
  const karaman = s.minors.find((m) => m.id === "karaman");
  if (karaman) s = shiftMinorGarrison(s, "karaman", 2); // ankara + konya, +1 levy each
  const target = ANATOLIAN_ALLIANCE_TARGETS.find((id) => controllerId(s, id) === ott.id);
  return eventLog(s, ctx, "Anatolian Alliance: the Karaman League arms and attacks an Ottoman Anatolian province; the Ottoman fights at −1 there this round.", {
    target,
    moraleDelta: -1,
  });
};

// #32 Hexamilion Rebuilt — morea holder may spend marble: +1 wall tier, +1 def vs Athens (STANDING).
const e32: EventEffect = (state, ctx) => {
  const owner = controllerId(state, "morea");
  if (owner == null) return eventLog(state, ctx, "Hexamilion Rebuilt: Morea is unclaimed — neutral.");
  const holder = state.players.find((p) => p.id === owner);
  const canPay = (holder?.treasury.marble ?? 0) >= 2;
  if (!canPay) return eventLog(state, ctx, "Hexamilion Rebuilt: Morea's holder cannot spare the marble to fortify.");
  let s = grantRes(state, owner, { marble: -2 });
  s = mapProvince(s, "morea", (p) => shiftWall(p, 1));
  return eventLog(s, ctx, "Hexamilion Rebuilt at Corinth: Morea gains +1 wall tier and +1 defence vs any land attack from Athens for the rest of the game (until breached).", {
    standing: true,
  });
};

// #33 Knights of Rhodes Sortie — sweep two seas of corsairs, −1 to an enemy fleet; blocks next Corsair Raid.
const e33: EventEffect = (state, ctx) => {
  const rhodesOwner = controllerId(state, "rhodes");
  const rhodesMinor = state.minors.find((m) => m.id === "rhodes");
  const heldByKnightsOrCatholic =
    (rhodesMinor && rhodesMinor.vassalOf == null) ||
    (rhodesOwner != null &&
      CHRISTIAN_FACTIONS.includes(
        state.players.find((p) => p.id === rhodesOwner)?.faction ?? Faction.OTTOMAN,
      ));
  if (!heldByKnightsOrCatholic) {
    return eventLog(state, ctx, "Knights of Rhodes Sortie: Rhodes is not held by the Knights or a Catholic power — neutral.");
  }
  return eventLog(state, ctx, "Knights of Rhodes Sortie: Hospitaller galleys sweep the Sea of Crete and Eastern Mediterranean clear of corsairs, damage one enemy/Mamluk fleet (−1 strength), and block the next Corsair Raid.", {
    seaZones: ["sea-of-crete", "eastern-mediterranean"],
    blocksCorsairRaid: true,
  });
};

// #34 The Great Bombard Forged — Ottoman unlocks the Great Bombard (else auction). STANDING.
const e34: EventEffect = (state, ctx) => {
  const ott = playerByFaction(state, Faction.OTTOMAN);
  if (ott) {
    return eventLog(state, ctx, "The Great Bombard Forged: the Ottoman unlocks and may build the Great Bombard (damages even Tier-5 walls by up to 2 tiers/round).", {
      standing: true,
      unlock: "GREAT_BOMBARD",
      grantedTo: ott.id,
    });
  }
  return eventLog(state, ctx, "The Great Bombard Forged: no Ottoman in play — Orban sells to the highest bidder (gold + marble auction), granting them one bombard.", {
    standing: true,
    unlock: "GREAT_BOMBARD",
    auction: true,
  });
};

// #35 Black Death Returns — PERSISTENT 2 rounds: cities/HV −1 grain −1 gold; cull 1 per 3 levy/inf.
const e35: EventEffect = (state, ctx) => {
  let s: GameState = state;
  const affected = s.provinces.filter(
    (p) => p.terrain === TerrainType.CITY || (p.highValue ?? 0) > 0,
  );
  for (const prov of affected) {
    if (prov.ownerId) s = grantRes(s, prov.ownerId, { grain: -1, gold: -1 });
  }
  return eventLog(s, ctx, "Black Death Returns: for 2 rounds every city and high-value province produces −1 grain and −1 gold; each faction destroys 1 levy/infantry per 3 it fields (densest provinces first).", {
    durationRounds: 2,
    cullRatio: 3,
  });
};

// #36 Gunpowder Revolution — STANDING: bombards/handgunners −1 cost +1 siege; marble walls −1 tier.
const e36: EventEffect = (state, ctx) =>
  eventLog(state, ctx, "Gunpowder Revolution: for the rest of the game bombards and handgunners cost −1 and gain +1 siege, but marble walls defend at −1 tier against them.", {
    standing: true,
    siegeDelta: 1,
    wallTierDelta: -1,
  });

// #37 The Final Crusade — Christian pool vs any Ottoman city; success +4 prestige, abstainers −1.
const e37: EventEffect = (state, ctx) =>
  eventLog(state, ctx, "The Final Crusade: all Christian factions may pool units against an Ottoman-held city. Success → +4 prestige to joiners and the city changes hands; abstaining Christians each −1 prestige.", {
    prestigeOnWin: 4,
    abstainPrestige: -1,
  });

// #38 Pilgrimage / Jubilee Year — Rome holder +3 gold +2 faith; every Christian faction +1 faith.
const e38: EventEffect = (state, ctx) => {
  let s: GameState = state;
  const romeOwner = controllerId(s, "rome");
  if (romeOwner) s = grantRes(s, romeOwner, { gold: 3, faith: 2 });
  for (const f of CHRISTIAN_FACTIONS) {
    const pl = playerByFaction(s, f);
    if (pl) s = grantRes(s, pl.id, { faith: 1 });
  }
  return eventLog(s, ctx, "Pilgrimage / Jubilee Year: the Rome holder gains +3 gold and +2 faith; every Christian faction +1 faith this round.");
};

// #39 Relic Discovered — chosen faith province +2 faith now, +1 gold/round (STANDING), +1 prestige.
const e39: EventEffect = (state, ctx) => {
  const drawer = ctx.drawerId ? state.players.find((p) => p.id === ctx.drawerId) : null;
  const held = RELIC_PROVINCES.filter((id) => drawer && controllerId(state, id) === drawer.id);
  const target = ctx.targetProvinceId && held.includes(ctx.targetProvinceId) ? ctx.targetProvinceId : held[0];
  if (!drawer || !target) {
    return eventLog(state, ctx, "Relic Discovered, but the drawer holds no faith-yielding province to enshrine it — neutral.");
  }
  let s = grantRes(state, drawer.id, { faith: 2 });
  s = grantPrestige(s, drawer.id, 1);
  return eventLog(s, ctx, `Relic Discovered at ${target}: +2 faith now, a standing +1 gold/round pilgrimage, and +1 prestige.`, {
    standing: true,
    perRoundGold: 1,
    province: target,
  });
};

// #40 Drought — all desert/plains −1 grain; Alexandria and Cairo −2 grain (low Nile).
const e40: EventEffect = (state, ctx) => {
  let s: GameState = state;
  const arid = s.provinces
    .filter((p) => p.terrain === TerrainType.DESERT || p.terrain === TerrainType.PLAINS)
    .map((p) => p.id)
    .filter((id) => id !== "alexandria" && id !== "cairo");
  s = grantToControllers(s, arid, { grain: -1 });
  s = grantToControllers(s, ["alexandria", "cairo"], { grain: -2 });
  return eventLog(s, ctx, "Drought: every desert and plains province −1 grain; Alexandria and Cairo −2 grain (a low Nile).");
};

// #41 Financial Crisis — loans frozen; debtors pay 1 gold; hoarders (>20 gold) taxed −2 gold.
const e41: EventEffect = (state, ctx) => {
  let s: GameState = state;
  for (const pl of s.players) {
    if (pl.treasury.gold > 20) s = grantRes(s, pl.id, { gold: -2 });
  }
  return eventLog(s, ctx, "Financial Crisis (Bank Run): Genoese loans frozen this round; every debtor pays a 1 gold penalty; any faction hoarding >20 gold is taxed −2 gold.", {
    debtPenaltyGold: -1,
    hoardThreshold: 20,
  });
};

// #42 Byzantine Civil War — Byzantium loses a province to a pretender unless it pays 4 gold.
const e42: EventEffect = (state, ctx) => {
  const byz = playerByFaction(state, Faction.BYZANTIUM);
  if (!byz) return eventLog(state, ctx, "Byzantine Civil War with no Byzantium in play — treated as a neutral omen.");
  if (ctx.choice === "PAY" && byz.treasury.gold >= 4) {
    const s = grantRes(state, byz.id, { gold: -4 });
    return eventLog(s, ctx, "Byzantine Civil War: Byzantium pays 4 gold to buy off the Palaiologos pretender.");
  }
  const lost = BYZ_CIVIL_WAR_PROVINCES.find((id) => controllerId(state, id) === byz.id);
  let s: GameState = state;
  if (lost) s = setProvinceOwner(s, lost, null);
  return eventLog(s, ctx, "Byzantine Civil War: a pretender seizes a Byzantine province (now Independent) — Byzantium did not buy off the claimant.", {
    lost,
    buyoffGold: 4,
  });
};

// #43 Peace of Turin — ends the Venetian–Genoese War; both +1 gold.
const e43: EventEffect = (state, ctx) => {
  let s: GameState = state;
  for (const f of [Faction.VENICE, Faction.GENOA]) {
    const pl = playerByFaction(s, f);
    if (pl) s = grantRes(s, pl.id, { gold: 1 });
  }
  return eventLog(s, ctx, "Peace of Turin: the Venetian–Genoese War (#18) ends — both republics regain full trade income and each gains +1 gold.", {
    cancels: omenCardId(18),
  });
};

// #44 The Great Comet of 1453 — all levies/mercs −1 morale, all sieges +1; lowest-prestige +1.
const e44: EventEffect = (state, ctx) => {
  let s: GameState = state;
  const contenders = s.players.filter((p) => p.faction);
  if (contenders.length > 0) {
    const lowest = contenders.reduce((a, b) => (b.prestige < a.prestige ? b : a));
    s = grantPrestige(s, lowest.id, 1);
  }
  return eventLog(s, ctx, "The Great Comet of 1453: map-wide dread — every faction's levies and mercs −1 morale, all sieges +1; the lowest-prestige faction rallies (+1 prestige).", {
    moraleDelta: -1,
    siegeDelta: 1,
  });
};

// #45 Genoese Loan Called In — Genoa names a debtor: pay 4 gold or cede province/1 prestige; else Genoa +2.
const e45: EventEffect = (state, ctx) => {
  const genoa = playerByFaction(state, Faction.GENOA);
  if (!genoa) return eventLog(state, ctx, "Genoese Loan Called In with no Genoa in play — treated as a neutral omen.");
  const debtorId = ctx.targetPlayerId ?? null;
  if (!debtorId) {
    const s = grantRes(state, genoa.id, { gold: 2 });
    return eventLog(s, ctx, "Genoese Loan Called In: no faction is in debt — the Bank of St George collects +2 gold interest.");
  }
  const debtor = state.players.find((p) => p.id === debtorId);
  if (debtor && debtor.treasury.gold >= 4 && ctx.choice !== "CEDE") {
    let s = grantRes(state, debtorId, { gold: -4 });
    s = grantRes(s, genoa.id, { gold: 4 });
    return eventLog(s, ctx, "Genoese Loan Called In: the debtor pays Genoa 4 gold.");
  }
  let s = grantPrestige(state, debtorId, -1);
  s = grantPrestige(s, genoa.id, 1);
  return eventLog(s, ctx, "Genoese Loan Called In: the debtor cannot pay — cedes 1 prestige (or a province) to Genoa.", {
    cedeGold: 4,
  });
};

// #46 The Fall of Constantinople — +5 prestige to the holder's faction; sudden-death check.
const e46: EventEffect = (state, ctx) => {
  const owner = controllerId(state, "constantinople");
  const holder = owner ? state.players.find((p) => p.id === owner) : null;
  const holderFaction = holder?.faction ?? null;
  let s: GameState = state;
  if (holderFaction === Faction.BYZANTIUM) {
    s = grantPrestige(s, owner!, 5);
    s = eventLog(s, ctx, "The Fall of Constantinople (1453): the City is still Byzantine at round 16 — Byzantium +5 prestige (history defied) and fulfils 'Queen of Cities'.", {
      suddenDeath: true,
    });
  } else if (holderFaction === Faction.OTTOMAN) {
    s = grantPrestige(s, owner!, 5);
    s = eventLog(s, ctx, "The Fall of Constantinople (1453): the City has fallen to the Ottoman — Ottoman +5 prestige and 'Fetih' is scored.", {
      suddenDeath: true,
    });
  } else {
    s = eventLog(s, ctx, "The Fall of Constantinople (1453): the City is in third-party hands — sudden-death check triggered.", {
      suddenDeath: true,
    });
  }
  return {
    ...s,
    constantinopleHold: {
      faction: holderFaction,
      rounds: s.constantinopleHold.faction === holderFaction ? s.constantinopleHold.rounds : 0,
    },
  };
};

// Local alias so #31's signature reads clearly; identical to EventEffect.
type EffectPlaceholder = EventEffect;

// ---------------------------------------------------------------------------
// The 46 cards — data + effect references
// ---------------------------------------------------------------------------

/** Authoritative rich table: all 46 event cards with their effect functions. */
export const EVENT_CARDS: EventCard[] = [
  // ===== Era I — Omens of Peace (rounds 1–5) · 16 cards =====
  { id: omenCardId(1), n: 1, slug: "bumper-harvest", name: "Bumper Harvest", tag: "Good", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { grainDelta: 1 }, effect: e1 },
  { id: omenCardId(2), n: 2, slug: "hard-winter", name: "Hard Winter", tag: "Ill", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { upkeepDelta: 1, moveDelta: -1, siegeDelta: 0, seaZones: FROZEN_SEAS }, effect: e2 },
  { id: omenCardId(3), n: 3, slug: "silk-road-caravan", name: "Silk Road Caravan", tag: "Good", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "PROVINCE", effects: { goldDelta: 3, provinces: SILK_ROAD }, effect: e3 },
  { id: omenCardId(4), n: 4, slug: "papal-indulgence", name: "Papal Indulgence", tag: "Good", era: 1, duration: "Immediate", eventDuration: "GRANT", targeting: "DRAWER", effects: { faithDelta: -3, goldDelta: 3, spawnUnits: { LEVY: 1 } }, effect: e4 },
  { id: omenCardId(5), n: 5, slug: "imperial-coronation", name: "Imperial Coronation", tag: "Good", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "DRAWER", effects: { prestigeDelta: 2, goldDelta: 2, moraleDelta: 1 }, effect: e5 },
  { id: omenCardId(6), n: 6, slug: "comet-omen", name: "Comet Omen", tag: "Omen", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { moraleDelta: -1 }, effect: e6 },
  { id: omenCardId(7), n: 7, slug: "ottoman-interregnum", name: "Ottoman Interregnum", tag: "Ill", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "FACTION", factionSpecific: Faction.OTTOMAN, effects: { prestigeDelta: -2, provinces: [...INTERREGNUM_ANATOLIA, ...INTERREGNUM_EUROPE] }, effect: e7 },
  { id: omenCardId(8), n: 8, slug: "timurid-shadow", name: "Timurid Shadow", tag: "Ill", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "FACTION", factionSpecific: Faction.OTTOMAN, effects: { goldDelta: -2, spawnUnits: { LEVY: 1 }, provinces: BEYLIKS }, effect: e8 },
  { id: omenCardId(9), n: 9, slug: "discovery-of-alum", name: "Discovery of Alum", tag: "Good", era: 1, duration: "Standing", eventDuration: "STANDING", targeting: "PROVINCE", effects: { goldDelta: 2, durationRounds: 0, provinces: ["chios"] }, effect: e9 },
  { id: omenCardId(10), n: 10, slug: "marriage-alliance", name: "Marriage Alliance", tag: "Good", era: 1, duration: "Held", eventDuration: "HELD", targeting: "DRAWER", effects: { goldDelta: 3 }, effect: e10 },
  { id: omenCardId(11), n: 11, slug: "corsair-raid", name: "Corsair Raid", tag: "Ill", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "SEA_ZONE", effects: { goldDelta: -2, tradeDelta: -1, seaZones: CORSAIR_SEAS }, effect: e11 },
  { id: omenCardId(12), n: 12, slug: "serbian-despotate-submits", name: "Serbian Despotate Submits", tag: "Mixed", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "MINOR", effects: { goldDelta: 2, garrisonDelta: 1, minors: ["serbia"] }, effect: e12 },
  { id: omenCardId(13), n: 13, slug: "ragusan-tribute", name: "Ragusan Tribute", tag: "Good", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "MINOR", effects: { goldDelta: 3, minors: ["ragusa"] }, effect: e13 },
  { id: omenCardId(14), n: 14, slug: "plague-of-locusts", name: "Plague of Locusts", tag: "Ill", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { grainDelta: -2 }, effect: e14 },
  { id: omenCardId(15), n: 15, slug: "hussite-handgunners", name: "Hussite Handgunners for Hire", tag: "Good", era: 1, duration: "Immediate", eventDuration: "GRANT", targeting: "GLOBAL", effects: {}, effect: e15 },
  { id: omenCardId(16), n: 16, slug: "fall-of-a-beylik", name: "Fall of a Beylik", tag: "Mixed", era: 1, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "MINOR", effects: { garrisonDelta: -1, provinces: ["smyrna", "antalya", "kastamonu"] }, effect: e16 },

  // ===== Era II — Omens of War (rounds 6–10) · 17 cards =====
  { id: omenCardId(17), n: 17, slug: "council-of-florence", name: "Council of Florence", tag: "Mixed", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "FACTION", factionSpecific: Faction.BYZANTIUM, effects: { faithDelta: -2, prestigeDelta: -1, durationRounds: 2 }, effect: e17 },
  { id: omenCardId(18), n: 18, slug: "venetian-genoese-war", name: "Venetian–Genoese War", tag: "Ill", era: 2, duration: "Standing", eventDuration: "STANDING", targeting: "PLAYER", effects: { goldDelta: -2, tradeDelta: -2, durationRounds: 2 }, effect: e18 },
  { id: omenCardId(19), n: 19, slug: "hunyadi-long-campaign", name: "Hunyadi's Long Campaign", tag: "Good", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "FACTION", factionSpecific: Faction.HUNGARY, effects: { moraleDelta: 1, moveDelta: 1 }, effect: e19 },
  { id: omenCardId(20), n: 20, slug: "varna-crusade", name: "Varna Crusade", tag: "Mixed", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "PROVINCE", effects: { prestigeDelta: 3, provinces: ["varna", "belgrade", "sofia"] }, effect: e20 },
  { id: omenCardId(21), n: 21, slug: "fall-of-thessalonica", name: "Fall of Thessalonica", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "PROVINCE", effects: { wallTierDelta: -1, garrisonDelta: -1, goldDelta: -3, provinces: ["thessalonica"] }, effect: e21 },
  { id: omenCardId(22), n: 22, slug: "mercenary-revolt", name: "Mercenary Revolt", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { goldDelta: -2 }, effect: e22 },
  { id: omenCardId(23), n: 23, slug: "janissary-discontent", name: "Janissary Discontent", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "FACTION", factionSpecific: Faction.OTTOMAN, effects: { goldDelta: -3, moraleDelta: -1 }, effect: e23 },
  { id: omenCardId(24), n: 24, slug: "wallachian-revolt", name: "Wallachian Revolt", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "MINOR", effects: { goldDelta: -2, spawnUnits: { LEVY: 2, CAVALRY: 1 }, minors: ["wallachia"] }, effect: e24 },
  { id: omenCardId(25), n: 25, slug: "earthquake", name: "Earthquake", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "PROVINCE", effects: { wallTierDelta: -1, provinces: EARTHQUAKE_CITIES }, effect: e25 },
  { id: omenCardId(26), n: 26, slug: "grain-fleet-lost", name: "The Grain Fleet Is Lost", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "PLAYER", effects: { grainDelta: -3 }, effect: e26 },
  { id: omenCardId(27), n: 27, slug: "fire-of-the-arsenal", name: "Fire of the Arsenal", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "PLAYER", effects: { timberDelta: -2 }, effect: e27 },
  { id: omenCardId(28), n: 28, slug: "papal-interdict", name: "Papal Interdict", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "PERSISTENT", targeting: "PLAYER", effects: { faithDelta: 0, durationRounds: 2 }, effect: e28 },
  { id: omenCardId(29), n: 29, slug: "schism", name: "Schism", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { prestigeDelta: -1, durationRounds: 1 }, effect: e29 },
  { id: omenCardId(30), n: 30, slug: "mamluk-embargo", name: "Mamluk Embargo", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "SEA_ZONE", effects: { goldDelta: -2, tradeDelta: -1, seaZones: ["eastern-mediterranean"] }, effect: e30 },
  { id: omenCardId(31), n: 31, slug: "anatolian-alliance", name: "Anatolian Alliance", tag: "Ill", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "FACTION", factionSpecific: Faction.OTTOMAN, effects: { spawnUnits: { LEVY: 1 }, moraleDelta: -1, provinces: ANATOLIAN_ALLIANCE_TARGETS }, effect: e31 },
  { id: omenCardId(32), n: 32, slug: "hexamilion-rebuilt", name: "Hexamilion Rebuilt at Corinth", tag: "Good", era: 2, duration: "Standing", eventDuration: "STANDING", targeting: "PROVINCE", effects: { wallTierDelta: 1, stoneDelta: -2, provinces: ["morea"] }, effect: e32 },
  { id: omenCardId(33), n: 33, slug: "knights-of-rhodes-sortie", name: "Knights of Rhodes Sortie", tag: "Good", era: 2, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "SEA_ZONE", effects: { seaZones: ["sea-of-crete", "eastern-mediterranean"] }, effect: e33 },

  // ===== Era III — Omens of the End (rounds 11–16) · 13 cards =====
  { id: omenCardId(34), n: 34, slug: "great-bombard-forged", name: "The Great Bombard Forged", tag: "Good", era: 3, duration: "Standing", eventDuration: "STANDING", targeting: "FACTION", factionSpecific: Faction.OTTOMAN, effects: { unlock: "GREAT_BOMBARD", wallTierDelta: -2 }, effect: e34 },
  { id: omenCardId(35), n: 35, slug: "black-death-returns", name: "Black Death Returns", tag: "Ill", era: 3, duration: "Immediate", eventDuration: "PERSISTENT", targeting: "GLOBAL", effects: { grainDelta: -1, goldDelta: -1, durationRounds: 2 }, effect: e35 },
  { id: omenCardId(36), n: 36, slug: "gunpowder-revolution", name: "Gunpowder Revolution", tag: "Mixed", era: 3, duration: "Standing", eventDuration: "STANDING", targeting: "GLOBAL", effects: { siegeDelta: 1, wallTierDelta: -1, durationRounds: 0 }, effect: e36 },
  { id: omenCardId(37), n: 37, slug: "final-crusade", name: "The Final Crusade", tag: "Mixed", era: 3, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { prestigeDelta: 4 }, effect: e37 },
  { id: omenCardId(38), n: 38, slug: "pilgrimage-jubilee", name: "Pilgrimage / Jubilee Year", tag: "Good", era: 3, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { goldDelta: 3, faithDelta: 2, provinces: ["rome"] }, effect: e38 },
  { id: omenCardId(39), n: 39, slug: "relic-discovered", name: "Relic Discovered", tag: "Good", era: 3, duration: "Standing", eventDuration: "STANDING", targeting: "PROVINCE", effects: { faithDelta: 2, prestigeDelta: 1, provinces: RELIC_PROVINCES }, effect: e39 },
  { id: omenCardId(40), n: 40, slug: "drought", name: "Drought", tag: "Ill", era: 3, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { grainDelta: -1, provinces: ["alexandria", "cairo"] }, effect: e40 },
  { id: omenCardId(41), n: 41, slug: "financial-crisis", name: "Financial Crisis", tag: "Ill", era: 3, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { goldDelta: -2 }, effect: e41 },
  { id: omenCardId(42), n: 42, slug: "byzantine-civil-war", name: "Byzantine Civil War", tag: "Ill", era: 3, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "FACTION", factionSpecific: Faction.BYZANTIUM, effects: { goldDelta: -4, provinces: BYZ_CIVIL_WAR_PROVINCES }, effect: e42 },
  { id: omenCardId(43), n: 43, slug: "peace-of-turin", name: "Peace of Turin", tag: "Good", era: 3, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "PLAYER", effects: { goldDelta: 1 }, effect: e43 },
  { id: omenCardId(44), n: 44, slug: "great-comet-1453", name: "The Great Comet of 1453", tag: "Omen", era: 3, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "GLOBAL", effects: { moraleDelta: -1, siegeDelta: 1, prestigeDelta: 1 }, effect: e44 },
  { id: omenCardId(45), n: 45, slug: "genoese-loan-called-in", name: "Genoese Loan Called In", tag: "Ill", era: 3, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "PLAYER", effects: { goldDelta: -4, prestigeDelta: -1 }, effect: e45 },
  { id: omenCardId(46), n: 46, slug: "fall-of-constantinople", name: "The Fall of Constantinople", tag: "Mixed", era: 3, duration: "Immediate", eventDuration: "IMMEDIATE", targeting: "PROVINCE", effects: { prestigeDelta: 5, suddenDeath: true, provinces: ["constantinople"] }, effect: e46 },
];

// ---------------------------------------------------------------------------
// Derived registries — FROZEN contract exports + convenience lookups
// ---------------------------------------------------------------------------

/** Frozen-shape card registry (derived from the rich table). */
export const OMEN_CARDS: OmenCardDef[] = EVENT_CARDS.map((c) => ({
  id: c.id,
  n: c.n,
  name: c.name,
  tag: c.tag,
  era: c.era,
  duration: c.duration,
  ...(c.factionSpecific ? { factionSpecific: c.factionSpecific } : {}),
}));

/** Card ids grouped by era, in printed order (pre-shuffle). */
export const OMEN_CARDS_BY_ERA: Record<1 | 2 | 3, string[]> = {
  1: EVENT_CARDS.filter((c) => c.era === 1).map((c) => c.id),
  2: EVENT_CARDS.filter((c) => c.era === 2).map((c) => c.id),
  3: EVENT_CARDS.filter((c) => c.era === 3).map((c) => c.id),
};

/** Explicit per-era decks (aliases of OMEN_CARDS_BY_ERA). */
export const ERA_I: string[] = OMEN_CARDS_BY_ERA[1];
export const ERA_II: string[] = OMEN_CARDS_BY_ERA[2];
export const ERA_III: string[] = OMEN_CARDS_BY_ERA[3];

/** Lookup a frozen card definition by id. */
export const OMEN_CARD_BY_ID: Record<string, OmenCardDef> = Object.fromEntries(
  OMEN_CARDS.map((c) => [c.id, c]),
);

/** Lookup a rich card (data + effect) by id. */
export const EVENT_CARD_BY_ID: Record<string, EventCard> = Object.fromEntries(
  EVENT_CARDS.map((c) => [c.id, c]),
);

/** Effect-function table keyed by card id (used by resolveCard). */
export const EVENT_EFFECT_BY_ID: Record<string, EventEffect> = Object.fromEntries(
  EVENT_CARDS.map((c) => [c.id, c.effect]),
);

// ---------------------------------------------------------------------------
// Ambiguities — best-reading interpretations, for the PR ambiguity list
// ---------------------------------------------------------------------------

/** One flagged interpretation where the printed card left room to read it. */
export interface CardAmbiguity {
  id: string;
  card: string;
  interpretation: string;
}

/**
 * Best-reading calls made while encoding the deck. These feed the PR ambiguity
 * list; the events subsystem may revisit any of them.
 */
export const AMBIGUITIES: CardAmbiguity[] = [
  {
    id: "GLOBAL:modifier-storage",
    card: "(systemic)",
    interpretation:
      "The frozen GameState has no field to store round-scoped or multi-round modifiers (levy/merc morale, land-movement, grain-upkeep, siege progress, faith-income multipliers, trade deltas, frozen seas, 'no recruit/build next round', standing per-round bonuses). Effect fns apply every directly-representable delta (treasury, prestige, wall tier, garrison, owner, vassal) and record the modifier numbers in the card's `effects` spec and in the log `data`. The events subsystem is expected to add a modifier side-channel; until then those modifiers are logged, not enforced.",
  },
  {
    id: "GLOBAL:duration-classification",
    card: "(systemic)",
    interpretation:
      "EVENT_CARDS.md only explicitly marks cards 'Held' or 'Standing'; it does not tag IMMEDIATE/PERSISTENT/GRANT. I classified: STANDING = cards whose text says 'Standing' (9, 18, 32, 34, 36, 39); PERSISTENT = timed multi-round effects with no 'Standing' marker (28 interdict 2 rds, 35 black death 2 rds); GRANT = one-time option/unit handouts (4 Papal Indulgence, 15 Hussite Handgunners); HELD = kept-to-play-later (10 Marriage Alliance); everything else IMMEDIATE. The frozen `duration` (Immediate|Held|Standing) folds GRANT/PERSISTENT→Immediate.",
  },
  {
    id: "GLOBAL:unit-spawns-as-garrison",
    card: "(systemic: 4, 8, 24, 31)",
    interpretation:
      "Cards that 'spawn N levy/cavalry' are modelled as garrison increments on the named minor/province, not as new Army stacks (GameState has no army-id counter here; stack creation belongs to the army subsystem). The exact unit counts are preserved in `effects.spawnUnits` and log data.",
  },
  {
    id: "omen-1",
    card: "Bumper Harvest",
    interpretation:
      "'every plains and grain-primary province' read as terrain === PLAINS. The 'each grain converted to gold yields +1' clause is a trade-rate modifier for the round and is logged, not applied (economy owns conversion).",
  },
  {
    id: "omen-4",
    card: "Papal Indulgence",
    interpretation:
      "Applied to the drawer only (the flavor says 'any faction holding a faith province', but one card resolves for one drawer under our one-omen-per-round model). Converts min(3, faith)→gold; if the drawer is Hungary/Byzantium and choice==='LEVY', spends the faith to grant 1 free levy instead. The generic 'any faction' clause is treated as drawer-scoped.",
  },
  {
    id: "omen-7",
    card: "Ottoman Interregnum",
    interpretation:
      "Drops the first Ottoman-owned province in {ankara,nicaea,bursa} and in {sofia,philippopolis} to Independent (ownerId=null). 'may not recruit next round' has no storage flag and is logged. Adjacent players 'seizing' freed provinces is left to normal movement.",
  },
  {
    id: "omen-8",
    card: "Timurid Shadow",
    interpretation:
      "Beyliks ankara/konya/kastamonu gain +1 garrison (minor garrison if they belong to a minor, else province garrison). The raided Ottoman province is the first Ottoman-owned of {ankara,nicaea,bursa}; −2 gold applied, '0 yield next round' logged.",
  },
  {
    id: "omen-9",
    card: "Discovery of Alum",
    interpretation:
      "Standing +2 gold/round modelled as an immediate +2 gold to the current Chios holder plus a logged standing modifier; the per-round recurrence is not yet enforced (no standing-modifier store).",
  },
  {
    id: "omen-10",
    card: "Marriage Alliance",
    interpretation:
      "Encoded as HELD; the resolved effect grants the 3-gold dowry to the drawer immediately and logs the NAP/discounted-vassal options (which need a consenting counterparty and the diplomacy subsystem).",
  },
  {
    id: "omen-11",
    card: "Corsair Raid",
    interpretation:
      "Targets the first owned coastal province (the doc's 'a coastal province on the southern shore' has no precise selector without full sea-adjacency); −2 gold applied, galley loss + sea blockade (trade −1) logged. Sea zone picked from the named three via rng.",
  },
  {
    id: "omen-12",
    card: "Serbian Despotate Submits",
    interpretation:
      "'stronger neighbour' resolved by province count (Hungary vs Ottoman); ties → Hungary. Adjacency is not checked (both are treated as adjacent to Serbia per the map). If neither faction is in play, Serbia stays Independent with garrison +1.",
  },
  {
    id: "omen-13",
    card: "Ragusan Tribute",
    interpretation:
      "'strongest adjacent naval power (Venice by default)' resolved as Venice if present, else Genoa, else neutral. Grants +3 gold and sets ragusa.vassalOf without a siege.",
  },
  {
    id: "omen-14",
    card: "Plague of Locusts",
    interpretation:
      "No region tag exists on Province, so Anatolia/Balkans use hardcoded plains-province lists (ANATOLIA_PLAINS / BALKAN_PLAINS). choice==='BALKANS' selects the Balkans; default is Anatolia. Each listed plains province −2 grain to its controller.",
  },
  {
    id: "omen-16",
    card: "Fall of a Beylik",
    interpretation:
      "Chosen (or rng-picked) target among smyrna/antalya/kastamonu gets garrison −1; the alternative 'submits as a vassal' branch is logged, not auto-applied (needs the vassalage subsystem and a chooser).",
  },
  {
    id: "omen-17",
    card: "Council of Florence",
    interpretation:
      "Byzantium's choice via ctx.choice: 'ACCEPT' applies −1 prestige and an immediate −2 faith (the '−2 faith/round for 2 rounds' recurrence logged); anything else = Refuse (no-op beyond a log). Western 'Crusader levy' hiring is left to recruitment.",
  },
  {
    id: "omen-18",
    card: "Venetian–Genoese War",
    interpretation:
      "Requires both Venice AND Genoa in play, else neutral. Applies −2 gold to each republic and +1 gold to every non-maritime faction immediately; the 'must fight for 2 rounds' forced-combat rule is logged as a standing modifier for combat to enforce. Cancellable by #43.",
  },
  {
    id: "omen-20",
    card: "Varna Crusade",
    interpretation:
      "Crusade muster/resolution is a combat-subsystem event; the effect fn only logs the muster provinces and the win/loss prestige swings (+3 joiners / +3 Ottoman) and the Black-Army-loss clause. No units are moved or battles pushed here.",
  },
  {
    id: "omen-21",
    card: "Fall of Thessalonica",
    interpretation:
      "Applies wall −1 and garrison −1 to Thessalonica unconditionally (the 'Ottoman army adjacent' trigger is not re-checked at resolution); Venetian holder also −3 gold; the −50% siege-cost clause is logged.",
  },
  {
    id: "omen-23",
    card: "Janissary Discontent",
    interpretation:
      "choice==='REFUSE' or insufficient gold → −1 Janissary morale (logged, no per-unit store); otherwise the Ottoman pays 3 gold. Auto-pays when affordable and no explicit refusal.",
  },
  {
    id: "omen-24",
    card: "Wallachian Revolt",
    interpretation:
      "Only fires if Wallachia is currently a vassal (minor.vassalOf != null), else neutral. Frees the minor, +3 garrison (2 levy + 1 light cavalry), sets the Wallachia province Independent, and raids the first province of the former lord (−2 gold).",
  },
  {
    id: "omen-25",
    card: "Earthquake",
    interpretation:
      "Target chosen via ctx.choice/targetProvinceId if it names one of constantinople/gallipoli/rhodes/thessalonica, else rng-randomised among them; wall tier −1.",
  },
  {
    id: "omen-26",
    card: "The Grain Fleet Is Lost",
    interpretation:
      "Target = ctx.targetPlayerId, else the Constantinople holder, else the first seated faction. −3 grain and a logged galley loss if affordable; otherwise a logged levy starvation. Actual galley/levy removal is deferred to the fleet/army subsystem.",
  },
  {
    id: "omen-28",
    card: "Papal Interdict",
    interpretation:
      "The 'last faction to attack a fellow Christian' trigger requires battle history not tracked here, so the target is taken from ctx.targetPlayerId; with none it is a neutral omen. All effects (faith income 0 for 2 rounds, no crusade, −25% vs Christian neutrals) are logged modifiers.",
  },
  {
    id: "omen-30",
    card: "Mamluk Embargo",
    interpretation:
      "Venice and Genoa each −2 gold applied immediately; the Eastern-Mediterranean trade cost/yield shift and the 'Mamluk force threatens Cyprus' clause are logged (no Mamluk NPC exists to spawn).",
  },
  {
    id: "omen-31",
    card: "Anatolian Alliance",
    interpretation:
      "Karaman League (minor 'karaman', provinces ankara+konya) gains +2 garrison (+1 levy each). The coordinated attack targets the first Ottoman-owned of {bursa,nicaea}; the Ottoman '−1 there this round' is logged.",
  },
  {
    id: "omen-32",
    card: "Hexamilion Rebuilt",
    interpretation:
      "Auto-fortifies only if the Morea holder can pay 2 marble (marble cost inferred; balance has no explicit number). Applies −2 marble and +1 wall tier; the standing '+1 def vs attacks from Athens' is logged.",
  },
  {
    id: "omen-33",
    card: "Knights of Rhodes Sortie",
    interpretation:
      "Fires only if Rhodes is the free Knights minor or held by a Catholic (Christian) player; else neutral. The corsair sweep, −1 enemy fleet strength, and 'blocks next Corsair Raid' are logged (fleet damage + the block flag need the naval/event stores).",
  },
  {
    id: "omen-34",
    card: "The Great Bombard Forged",
    interpretation:
      "If an Ottoman is in play, logs the GREAT_BOMBARD unlock granted to them (no unlock store yet). With no Ottoman, logs an auction (gold+marble) for the highest bidder — auction resolution belongs to the mercenary/market subsystem.",
  },
  {
    id: "omen-35",
    card: "Black Death Returns",
    interpretation:
      "Applies an immediate −1 grain/−1 gold to controllers of every CITY or highValue>0 province; the 2-round recurrence and the '1 levy/infantry culled per 3 fielded, densest first' cull are logged (cull needs army-subsystem removal).",
  },
  {
    id: "omen-37",
    card: "The Final Crusade",
    interpretation:
      "Pure combat/diplomacy event: the effect fn logs the +4 win prestige and −1 abstainer prestige but resolves no battle and moves no units (the crusade muster is driven by player actions + combat).",
  },
  {
    id: "omen-39",
    card: "Relic Discovered",
    interpretation:
      "Target = a faith-yielding province the drawer holds (ctx.targetProvinceId if valid, else the first held of constantinople/thessalonica/rome/morea/nicaea). +2 faith and +1 prestige now; the standing +1 gold/round pilgrimage is logged.",
  },
  {
    id: "omen-41",
    card: "Financial Crisis",
    interpretation:
      "Only the hoarding tax is enforced (any faction with >20 gold loses 2 gold). Loan-freeze and the per-debtor 1-gold penalty are logged, since no loan/debt ledger exists in the frozen state.",
  },
  {
    id: "omen-42",
    card: "Byzantine Civil War",
    interpretation:
      "choice==='PAY' with >=4 gold buys off the pretender (−4 gold). Otherwise the first Byzantine-owned of {thessalonica,morea,selymbria} goes Independent.",
  },
  {
    id: "omen-45",
    card: "Genoese Loan Called In",
    interpretation:
      "Debtor = ctx.targetPlayerId. With none, Genoa collects +2 gold interest. If the debtor has >=4 gold and choice!=='CEDE', they pay Genoa 4 gold; otherwise they cede 1 prestige to Genoa (province cession left to the caller).",
  },
  {
    id: "omen-46",
    card: "The Fall of Constantinople",
    interpretation:
      "Holder faction of 'constantinople' determines the +5 prestige recipient (Byzantium if still Byzantine, Ottoman if fallen, otherwise no prestige but sudden-death still triggers). Sets constantinopleHold.faction to the current holder (resetting the round count on a change of holder). The two-round sudden-death win is enforced by prestige/roundLoop, not here.",
  },
];
