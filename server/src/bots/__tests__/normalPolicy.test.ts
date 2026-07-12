/**
 * NORMAL policy ("normal-opportunist") tests.
 *
 * Covers: fair candidate shape over fuzzed REAL engine states (budgeted types
 * only, engine-legal probes), determinism, and the characteristic heuristics —
 * opportunistic odds-gated attacks, treaty honour (NAP/ALLIANCE) with the
 * capital-grade betrayal exception, defence of threatened high-value
 * provinces, market smoothing with a base-ratio fallback, great-work starts
 * gated on a safe treasury, and moderate persona-bias application.
 *
 * Crafted scenarios start from a real `createInitialState` board and reshape
 * ownership/stacks structurally — pure test-fixture setup; the policy itself
 * only ever reads state and emits actions.
 */
import { describe, expect, it } from "vitest";
import {
  Faction,
  GamePhase,
  GreatWorkType,
  TerrainType,
  TreatyType,
  UnitType,
  type Army,
  type GameAction,
  type GameState,
  type Province,
} from "@imperium/shared";
import { createInitialState } from "../../engine/gameState.js";
import { advancePhase } from "../../engine/roundLoop.js";
import { applyAction, EngineError } from "../../engine/actions.js";
import { neighborsOf } from "../../engine/adjacency.js";
import { makeSeats } from "../../engine/__tests__/gauntletHarness.js";
import { BotPlayer, createEngineSubmit } from "../botPlayer.js";
import { makeBotRng } from "../rng.js";
import { personaForFaction } from "../personality.js";
import { normalPolicy } from "../policies/normal.js";
import { Difficulty, type PolicyContext } from "../types.js";
import type { FactionPersona } from "../personality.js";

const GAME_SEED = 424242;

const BUDGETED = new Set<GameAction["type"]>([
  "MOVE",
  "RECRUIT",
  "BUILD",
  "TRADE",
  "DIPLOMACY",
  "VASSALIZE",
  "SPY",
  "DECLARE_WAR",
  "LEVY_CALL",
]);

/** A real engine state advanced into the action window (RECRUITMENT). */
function atWindow(seed = GAME_SEED): GameState {
  let state = createInitialState("NRMTST", makeSeats(2), seed);
  let guard = 0;
  while (state.phase !== GamePhase.RECRUITMENT) {
    state = advancePhase(state);
    if ((guard += 1) > 10) throw new Error("never reached RECRUITMENT");
  }
  return state;
}

function ctxFor(
  state: GameState,
  playerId: string,
  opts: { botSeed?: number; persona?: FactionPersona } = {},
): PolicyContext {
  return {
    state,
    botPlayerId: playerId,
    rng: makeBotRng(GAME_SEED, opts.botSeed ?? 7, state.round),
    difficulty: Difficulty.NORMAL,
    ...(opts.persona ? { persona: opts.persona } : {}),
  };
}

function units(partial: Partial<Record<UnitType, number>>): Record<UnitType, number> {
  const u = {} as Record<UnitType, number>;
  for (const t of Object.values(UnitType)) u[t] = partial[t] ?? 0;
  return u;
}

/** First adjacent pair of non-capital land provinces on the real map. */
function landPair(state: GameState): [Province, Province] {
  const byId = new Map(state.provinces.map((p) => [p.id, p]));
  for (const a of state.provinces) {
    if (a.isCapitalOf !== undefined) continue;
    for (const nb of neighborsOf(a.id)) {
      const b = byId.get(nb);
      if (b && b.isCapitalOf === undefined) return [a, b];
    }
  }
  throw new Error("no adjacent land pair on the map");
}

function addTreaty(state: GameState, type: TreatyType, aId: string, bId: string): string {
  const id = `t-${type}-test`;
  const treaty = { id, type, parties: [aId, bId], expiresRound: null };
  for (const p of state.players) {
    if (p.id === aId || p.id === bId) p.treaties = [...p.treaties, { ...treaty }];
  }
  return id;
}

/**
 * Crafted attack scenario: my 6-INFANTRY stack in province `a` adjacent to an
 * enemy province `b` defended by `defInfantry` INFANTRY. Plains, no walls, no
 * garrison, no high value — the odds gate alone decides.
 */
function attackScenario(
  defInfantry: number,
  opts: { treaty?: TreatyType; myInfantry?: number; targetHighValue?: number } = {},
): { state: GameState; meId: string; target: Province } {
  const state = structuredClone(atWindow());
  const me = state.players[0];
  const foe = state.players[1];
  const [a, b] = landPair(state);
  a.ownerId = me.id;
  b.ownerId = foe.id;
  a.terrain = TerrainType.PLAINS;
  b.terrain = TerrainType.PLAINS;
  a.highValue = 0;
  b.highValue = opts.targetHighValue ?? 0;
  b.garrison = 0;
  b.walls = { tier: 0, hp: 0 };
  delete b.minorId;
  state.armies = state.armies.filter(
    (x) => x.locationId !== a.id && x.locationId !== b.id,
  );
  const mine: Army = {
    id: "att-1",
    ownerId: me.id,
    locationId: a.id,
    units: units({ [UnitType.INFANTRY]: opts.myInfantry ?? 6 }),
  };
  state.armies.push(mine);
  if (defInfantry > 0) {
    state.armies.push({
      id: "def-1",
      ownerId: foe.id,
      locationId: b.id,
      units: units({ [UnitType.INFANTRY]: defInfantry }),
    });
  }
  if (opts.treaty) addTreaty(state, opts.treaty, me.id, foe.id);
  return { state, meId: me.id, target: b };
}

const movesTo = (cands: readonly GameAction[], provId: string): GameAction[] =>
  cands.filter((c) => c.type === "MOVE" && c.toId === provId);

describe("bots/policies/normal — candidate hygiene over fuzzed states", () => {
  it("offers only budgeted action types, issued by the bot, within the slice", () => {
    for (const seed of [1, 7, 42, 99, 1234, 55555]) {
      const state = atWindow(seed);
      for (const player of state.players) {
        const cands = normalPolicy.chooseAction(ctxFor(state, player.id, { botSeed: seed }));
        expect(cands.length).toBeLessThanOrEqual(12);
        for (const c of cands) {
          expect(BUDGETED.has(c.type)).toBe(true);
          expect("player" in c && c.player).toBe(player.id);
        }
      }
    }
  });

  it("every non-empty slate contains at least one engine-legal action", () => {
    for (const seed of [3, 21, 777, 4321]) {
      const base = atWindow(seed);
      for (const player of base.players) {
        // The engine enforces window turn order (actions.ts
        // `requireActiveTurn`) and the BotPlayer driver only ever acts on its
        // own turn — so legality of a seat's slate is defined ON that seat's
        // turn: hand the seat the active pointer before probing.
        const state = structuredClone(base);
        state.activePlayerIndex = state.turnOrder.indexOf(player.id);
        expect(state.activePlayerIndex).toBeGreaterThanOrEqual(0);
        const cands = normalPolicy.chooseAction(ctxFor(state, player.id, { botSeed: seed }));
        expect(cands.length).toBeGreaterThan(0);
        const accepted = cands.some((c) => {
          try {
            applyAction(state, c);
            return true;
          } catch (err) {
            if (err instanceof EngineError) return false;
            throw err;
          }
        });
        expect(accepted).toBe(true);
      }
    }
  });

  it("returns [] when the bot has no actions remaining", () => {
    const state = structuredClone(atWindow());
    state.players[0].actionsRemaining = 0;
    expect(normalPolicy.chooseAction(ctxFor(state, state.players[0].id))).toEqual([]);
  });

  it("is deterministic: identical (state, botSeed) → identical slates", () => {
    const state = atWindow();
    const a = normalPolicy.chooseAction(ctxFor(state, state.players[0].id, { botSeed: 5 }));
    const b = normalPolicy.chooseAction(ctxFor(state, state.players[0].id, { botSeed: 5 }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("bots/policies/normal — opportunistic attacks", () => {
  it("attacks a weakly defended enemy neighbor when the force ratio is favorable", () => {
    const { state, meId, target } = attackScenario(1);
    const cands = normalPolicy.chooseAction(ctxFor(state, meId));
    expect(movesTo(cands, target.id).length).toBeGreaterThan(0);
  });

  it("declines the same attack against an overwhelming defender", () => {
    const { state, meId, target } = attackScenario(8);
    const cands = normalPolicy.chooseAction(ctxFor(state, meId));
    expect(movesTo(cands, target.id)).toEqual([]);
  });

  it("persona war appetite shifts the odds gate (Ottoman attacks, Byzantium holds)", () => {
    // 6 INFANTRY (atk 12) vs 3 INFANTRY (def 9) → ratio 1.33: between the
    // moderated Ottoman gate (~1.18) and the moderated Byzantine gate (~1.44).
    // highValue 3 keeps the borderline target competitive in the ranked slice
    // (below the capital-grade threshold of 4) so the GATE is what decides.
    const bold = attackScenario(3, { targetHighValue: 3 });
    const boldCands = normalPolicy.chooseAction(
      ctxFor(bold.state, bold.meId, { persona: personaForFaction(Faction.OTTOMAN) }),
    );
    expect(movesTo(boldCands, bold.target.id).length).toBeGreaterThan(0);

    const shy = attackScenario(3, { targetHighValue: 3 });
    const shyCands = normalPolicy.chooseAction(
      ctxFor(shy.state, shy.meId, { persona: personaForFaction(Faction.BYZANTIUM) }),
    );
    expect(movesTo(shyCands, shy.target.id)).toEqual([]);
  });
});

describe("bots/policies/normal — treaty honour and betrayal", () => {
  it("honors a NAP: no attack on an ordinary NAP-partner province", () => {
    const { state, meId, target } = attackScenario(1, { treaty: TreatyType.NAP });
    const cands = normalPolicy.chooseAction(ctxFor(state, meId));
    expect(movesTo(cands, target.id)).toEqual([]);
  });

  it("betrays a NAP for an exposed enemy capital (prestige payoff positive)", () => {
    const state = structuredClone(atWindow());
    const me = state.players[0];
    const foe = state.players[1];
    const capital = state.provinces.find((p) => p.isCapitalOf === Faction.OTTOMAN)!;
    const byId = new Map(state.provinces.map((p) => [p.id, p]));
    const staging = neighborsOf(capital.id)
      .map((id) => byId.get(id))
      .find((p): p is Province => p !== undefined)!;
    staging.ownerId = me.id;
    staging.terrain = TerrainType.PLAINS;
    staging.highValue = 0;
    capital.garrison = 0;
    state.armies = state.armies.filter(
      (x) => x.locationId !== staging.id && x.locationId !== capital.id,
    );
    state.armies.push({
      id: "att-cap",
      ownerId: me.id,
      locationId: staging.id,
      units: units({ [UnitType.INFANTRY]: 8 }),
    });
    addTreaty(state, TreatyType.NAP, me.id, foe.id);

    const cands = normalPolicy.chooseAction(ctxFor(state, me.id));
    expect(movesTo(cands, capital.id).length).toBeGreaterThan(0);
  });

  it("never attacks into ALLIANCE territory; renounces only for a worthwhile capital prize", () => {
    const setup = (prestige: number): { cands: readonly GameAction[]; foeId: string; state: GameState } => {
      const state = structuredClone(atWindow());
      const me = state.players[0];
      const foe = state.players[1];
      me.prestige = prestige;
      const capital = state.provinces.find((p) => p.isCapitalOf === Faction.OTTOMAN)!;
      const byId = new Map(state.provinces.map((p) => [p.id, p]));
      const staging = neighborsOf(capital.id)
        .map((id) => byId.get(id))
        .find((p): p is Province => p !== undefined)!;
      staging.ownerId = me.id;
      staging.terrain = TerrainType.PLAINS;
      staging.highValue = 0;
      capital.garrison = 0;
      state.armies = state.armies.filter(
        (x) => x.locationId !== staging.id && x.locationId !== capital.id,
      );
      state.armies.push({
        id: "att-ally",
        ownerId: me.id,
        locationId: staging.id,
        units: units({ [UnitType.INFANTRY]: 8 }),
      });
      addTreaty(state, TreatyType.ALLIANCE, me.id, foe.id);
      return { cands: normalPolicy.chooseAction(ctxFor(state, me.id)), foeId: foe.id, state };
    };

    // Low prestige: the −4 betrayal cost dominates — honour the alliance.
    const low = setup(0);
    const foeProvinces = new Set(
      low.state.provinces.filter((p) => p.ownerId === low.foeId).map((p) => p.id),
    );
    for (const c of low.cands) {
      if (c.type === "MOVE") expect(foeProvinces.has(c.toId)).toBe(false);
      if (c.type === "DIPLOMACY") expect(c.diplomacy.kind).not.toBe("RENOUNCE");
    }

    // Near the victory threshold the prestige-adjusted prize flips the payoff.
    const high = setup(60);
    const renounce = high.cands.find(
      (c) =>
        c.type === "DIPLOMACY" &&
        c.diplomacy.kind === "RENOUNCE" &&
        c.diplomacy.treatyType === TreatyType.ALLIANCE &&
        c.diplomacy.targetPlayerId === high.foeId,
    );
    expect(renounce).toBeDefined();
    for (const c of high.cands) {
      if (c.type === "MOVE") expect(foeProvinces.has(c.toId)).toBe(false);
    }
  });
});

describe("bots/policies/normal — defence of threatened high-value provinces", () => {
  it("garrisons its threatened capital near the top of the slate", () => {
    const state = structuredClone(atWindow());
    const me = state.players[0]; // BYZANTIUM
    const foe = state.players[1];
    const capital = state.provinces.find((p) => p.isCapitalOf === Faction.BYZANTIUM)!;
    const byId = new Map(state.provinces.map((p) => [p.id, p]));
    const staging = neighborsOf(capital.id)
      .map((id) => byId.get(id))
      .find((p): p is Province => p !== undefined)!;
    staging.ownerId = foe.id;
    state.armies = state.armies.filter(
      (x) => x.locationId !== capital.id && x.locationId !== staging.id,
    );
    state.armies.push({
      id: "def-cap",
      ownerId: me.id,
      locationId: capital.id,
      units: units({ [UnitType.LEVY]: 1 }),
    });
    state.armies.push({
      id: "threat-1",
      ownerId: foe.id,
      locationId: staging.id,
      units: units({ [UnitType.INFANTRY]: 8 }),
    });

    const cands = normalPolicy.chooseAction(ctxFor(state, me.id));
    const defensiveRank = cands.findIndex(
      (c) =>
        (c.type === "RECRUIT" && c.provinceId === capital.id) ||
        (c.type === "MOVE" && c.toId === capital.id) ||
        (c.type === "BUILD" && c.provinceId === capital.id),
    );
    expect(defensiveRank).toBeGreaterThanOrEqual(0);
    expect(defensiveRank).toBeLessThan(4);
  });
});

describe("bots/policies/normal — capital survival under the enforced turn order", () => {
  /**
   * Round-1-style board: my capital holds my only field army while a rival
   * host stands within two steps. Pre-tuning NORMAL marched out (walls made
   * the capital look safe) and was walked in on — the §13.3 sudden-death
   * root cause of the difficulty-ordering regression.
   */
  function capitalScenario(): {
    state: GameState;
    meId: string;
    capital: Province;
    staging: Province;
  } {
    const state = structuredClone(atWindow());
    const me = state.players[0]; // BYZANTIUM
    const foe = state.players[1];
    const capital = state.provinces.find((p) => p.isCapitalOf === Faction.BYZANTIUM)!;
    const byId = new Map(state.provinces.map((p) => [p.id, p]));
    const staging = neighborsOf(capital.id)
      .map((id) => byId.get(id))
      .find((p): p is Province => p !== undefined)!;
    staging.ownerId = foe.id;
    // Isolate the duel: only the holding stack and the rush exist, so the
    // anchor (and its sally licence) is exercised against exactly one army.
    state.armies = [
      {
        id: "cap-hold",
        ownerId: me.id,
        locationId: capital.id,
        units: units({ [UnitType.INFANTRY]: 3 }),
      },
      {
        id: "rush-1",
        ownerId: foe.id,
        locationId: staging.id,
        units: units({ [UnitType.INFANTRY]: 2 }),
      },
    ];
    return { state, meId: me.id, capital, staging };
  }

  it("home anchor: never marches the last capital defence out under a nearby rush", () => {
    const { state, meId, capital, staging } = capitalScenario();
    // Make the sally unattractive so holding is the only sane play.
    state.armies.find((a) => a.id === "rush-1")!.units = units({
      [UnitType.INFANTRY]: 8,
    });
    const cands = normalPolicy.chooseAction(ctxFor(state, meId));
    for (const c of cands) {
      if (c.type === "MOVE" && c.stackId === "cap-hold") {
        throw new Error(`anchored capital stack offered a move to ${c.toId}`);
      }
    }
    expect(cands.length).toBeGreaterThan(0);
    expect(capital.isCapitalOf).toBe(Faction.BYZANTIUM);
    expect(staging.ownerId).not.toBe(meId);
  });

  it("sally: the anchored capital stack may still strike the adjacent army pinning it", () => {
    const { state, meId, staging } = capitalScenario();
    // 3 INFANTRY (atk 6) vs 2 INFANTRY (def 6 + terrain) fails the gate; give
    // the garrison a clear edge so the odds-gated sally fires.
    state.armies.find((a) => a.id === "cap-hold")!.units = units({
      [UnitType.INFANTRY]: 6,
    });
    state.armies.find((a) => a.id === "rush-1")!.units = units({
      [UnitType.INFANTRY]: 1,
    });
    staging.terrain = TerrainType.PLAINS;
    staging.walls = { tier: 0, hp: 0 };
    staging.garrison = 0;
    const cands = normalPolicy.chooseAction(ctxFor(state, meId));
    const sally = cands.filter(
      (c) => c.type === "MOVE" && c.stackId === "cap-hold" && c.toId === staging.id,
    );
    expect(sally.length).toBeGreaterThan(0);
  });

  it("unmanned walls are a walk-in: attacks an empty high-walled province the old model refused", () => {
    const { state, meId, target } = attackScenario(0);
    target.walls = { tier: 4, hp: 13 }; // T4: defBonus +4, hp 13 — but unmanned
    target.garrison = 0;
    const cands = normalPolicy.chooseAction(ctxFor(state, meId));
    expect(movesTo(cands, target.id).length).toBeGreaterThan(0);
  });

  it("races the sudden-death clock: retakes its own enemy-held capital at odds it would not risk elsewhere", () => {
    const state = structuredClone(atWindow());
    const me = state.players[0]; // BYZANTIUM
    const foe = state.players[1];
    const capital = state.provinces.find((p) => p.isCapitalOf === Faction.BYZANTIUM)!;
    const byId = new Map(state.provinces.map((p) => [p.id, p]));
    const staging = neighborsOf(capital.id)
      .map((id) => byId.get(id))
      .find((p): p is Province => p !== undefined)!;
    capital.ownerId = foe.id; // the City has fallen
    capital.garrison = 0;
    staging.ownerId = me.id;
    state.armies = state.armies.filter(
      (x) => x.locationId !== capital.id && x.locationId !== staging.id,
    );
    state.armies.push({
      id: "retake-1",
      ownerId: me.id,
      locationId: staging.id,
      units: units({ [UnitType.INFANTRY]: 6 }),
    });
    // Occupier: 4 INFANTRY behind the walls — over the plain odds gate with
    // walls counted, inside it with the retake relief.
    state.armies.push({
      id: "occupier",
      ownerId: foe.id,
      locationId: capital.id,
      units: units({ [UnitType.INFANTRY]: 3 }),
    });
    const cands = normalPolicy.chooseAction(ctxFor(state, me.id));
    const retake = cands.findIndex((c) => c.type === "MOVE" && c.toId === capital.id);
    expect(retake).toBeGreaterThanOrEqual(0);
    expect(retake).toBeLessThan(3); // urgency bonus ranks it at the top
  });
});

describe("bots/policies/normal — market smoothing", () => {
  it("does not treadmill gold into a structural grain famine", () => {
    const state = structuredClone(atWindow());
    const me = state.players[0];
    // Upkeep far above grain income: a big host on a tiny grain base.
    state.armies.push({
      id: "horde",
      ownerId: me.id,
      locationId: state.provinces.find((p) => p.ownerId === me.id)!.id,
      units: units({ [UnitType.INFANTRY]: 8 }),
    });
    for (const prov of state.provinces) {
      if (prov.ownerId === me.id) prov.yields = { ...prov.yields, grain: 0 };
    }
    me.treasury = { gold: 12, grain: 0, timber: 2, marble: 2, faith: 2 };
    const cands = normalPolicy.chooseAction(ctxFor(state, me.id));
    const grainBuys = cands.filter(
      (c) =>
        c.type === "TRADE" &&
        c.trade.kind === "CONVERT" &&
        (c.trade.get.grain ?? 0) > 0,
    );
    expect(grainBuys).toEqual([]);
  });

  it("converts a surplus resource toward a scarce one, cheap ratio probed first", () => {
    const state = structuredClone(atWindow());
    const me = state.players[0];
    me.treasury = { gold: 0, grain: 4, timber: 9, marble: 2, faith: 3 };

    const cands = normalPolicy.chooseAction(ctxFor(state, me.id));
    const converts = cands.filter(
      (c) =>
        c.type === "TRADE" &&
        c.trade.kind === "CONVERT" &&
        (c.trade.get.gold ?? 0) > 0 &&
        (c.trade.give.timber ?? 0) > 0,
    );
    expect(converts.length).toBeGreaterThanOrEqual(2);
    const gives = converts.map((c) =>
      c.type === "TRADE" && c.trade.kind === "CONVERT" ? (c.trade.give.timber ?? 0) : 0,
    );
    // The 2-for-1 market probe must precede its 3-for-1 base-ratio fallback.
    expect(gives.indexOf(2)).toBeGreaterThanOrEqual(0);
    expect(gives.indexOf(3)).toBeGreaterThan(gives.indexOf(2));
  });

  it("does not trade when the treasury is balanced", () => {
    const state = structuredClone(atWindow());
    const me = state.players[0];
    me.treasury = { gold: 5, grain: 5, timber: 5, marble: 5, faith: 3 };
    const cands = normalPolicy.chooseAction(ctxFor(state, me.id));
    expect(cands.filter((c) => c.type === "TRADE")).toEqual([]);
  });
});

describe("bots/policies/normal — great works", () => {
  it("starts a great work only when the treasury keeps a safe gold reserve", () => {
    const rich = structuredClone(atWindow());
    rich.round = 8;
    rich.players[0].treasury = { gold: 40, grain: 6, timber: 10, marble: 15, faith: 10 };
    const richCands = normalPolicy.chooseAction(ctxFor(rich, rich.players[0].id));
    expect(
      richCands.some((c) => c.type === "BUILD" && c.greatWork !== undefined),
    ).toBe(true);

    const poor = structuredClone(atWindow());
    poor.round = 8;
    poor.players[0].treasury = { gold: 16, grain: 6, timber: 10, marble: 15, faith: 10 };
    const poorCands = normalPolicy.chooseAction(ctxFor(poor, poor.players[0].id));
    expect(
      poorCands.some((c) => c.type === "BUILD" && c.greatWork !== undefined),
    ).toBe(false);
  });

  it("does not start great works before the era gate, but always continues one in progress", () => {
    const early = structuredClone(atWindow());
    early.round = 2;
    early.players[0].treasury = { gold: 40, grain: 6, timber: 10, marble: 15, faith: 10 };
    const earlyCands = normalPolicy.chooseAction(ctxFor(early, early.players[0].id));
    expect(
      earlyCands.some((c) => c.type === "BUILD" && c.greatWork !== undefined),
    ).toBe(false);

    const cont = structuredClone(atWindow());
    cont.round = 2; // continuation ignores both the round gate and the reserve
    const me = cont.players[0];
    me.treasury = { gold: 2, grain: 2, timber: 1, marble: 1, faith: 1 };
    const site = cont.provinces.find((p) => p.ownerId === me.id)!;
    site.greatWorks = [{ type: GreatWorkType.GRAND_BAZAAR, progress: 1 }];
    const contCands = normalPolicy.chooseAction(ctxFor(cont, me.id));
    const continuation = contCands.find(
      (c) =>
        c.type === "BUILD" &&
        c.greatWork === GreatWorkType.GRAND_BAZAAR &&
        c.provinceId === site.id,
    );
    expect(continuation).toBeDefined();
  });
});

describe("bots/policies/normal — era weighting", () => {
  it("military candidates take a larger share of the top ranks late game", () => {
    const early = structuredClone(atWindow());
    early.round = 2;
    const late = structuredClone(atWindow());
    late.round = 12;
    const meId = early.players[0].id;
    const military = (cands: readonly GameAction[]): number =>
      cands.slice(0, 6).filter((c) => c.type === "MOVE" || c.type === "RECRUIT").length;
    const earlyCount = military(normalPolicy.chooseAction(ctxFor(early, meId)));
    const lateCount = military(normalPolicy.chooseAction(ctxFor(late, meId)));
    expect(lateCount).toBeGreaterThanOrEqual(earlyCount);
  });
});

describe("bots/policies/normal — full window against the real engine", () => {
  async function playWindow(seed: number): Promise<{
    state: GameState;
    stats: Array<{ submitted: number; fallbacks: number }>;
  }> {
    let state = atWindow(seed);
    const commit = (next: GameState): void => {
      state = next;
    };
    const bots = state.players.map(
      (p, i) =>
        new BotPlayer({
          playerId: p.id,
          gameSeed: seed,
          config: { difficulty: Difficulty.NORMAL, botSeed: 2000 + i, pacing: "instant" },
          submit: createEngineSubmit(() => state, commit),
          policy: normalPolicy,
          persona: personaForFaction(p.faction ?? Faction.BYZANTIUM),
        }),
    );
    const byId = new Map(bots.map((b) => [b.playerId, b]));
    for (const seatId of state.turnOrder) {
      const bot = byId.get(seatId);
      if (bot) await bot.takeTurn(state);
    }
    return {
      state,
      stats: bots.map((b) => ({
        submitted: b.stats.actionsSubmitted,
        fallbacks: b.stats.fallbackPasses,
      })),
    };
  }

  it("spends real actions with zero fallback passes across seeds", async () => {
    for (const seed of [11, 2026, 90210]) {
      const { state, stats } = await playWindow(seed);
      for (const s of stats) {
        expect(s.submitted).toBeGreaterThan(0);
        expect(s.fallbacks).toBe(0);
      }
      for (const p of state.players) {
        expect(p.actionsRemaining).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is byte-for-byte deterministic across identical runs", async () => {
    const a = await playWindow(31337);
    const b = await playWindow(31337);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(a.stats).toEqual(b.stats);
  });
});
