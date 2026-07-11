/**
 * HARD policy tests — the bounded prestige-line evaluator.
 *
 * Covers: the Policy contract (legal action shapes, determinism, budget
 * gate), end-to-end legality against real engine states through BotPlayer +
 * createEngineSubmit (fuzzed seeds, 2p and 5p), and the characteristic HARD
 * behaviours: great-work continuation, siege timing against the T5 masonry
 * cap (Great Bombard awareness) and sea-resupply blockade support, Ottoman
 * Era III Constantinople obsession gated on military sanity, Venice trade
 * routes, Byzantine bribe-over-war tribute proposals, high-information-value
 * spy missions (with own-log dedupe), tactic cards at high-leverage combats,
 * favourable treaty ACCEPTs, and treaty honour.
 */
import { describe, expect, it } from "vitest";
import {
  Faction,
  GamePhase,
  GreatWorkType,
  SpyMission,
  TreatyType,
  UnitType,
  asTacticCardId,
  type Army,
  type GameAction,
  type GameState,
} from "@imperium/shared";
import { applyAction } from "../../../engine/actions.js";
import { createInitialState } from "../../../engine/gameState.js";
import { advancePhase } from "../../../engine/roundLoop.js";
import { makeSeats } from "../../../engine/__tests__/gauntletHarness.js";
import { BotPlayer, createEngineSubmit } from "../../botPlayer.js";
import { makeBotRng } from "../../rng.js";
import { personaForFaction } from "../../personality.js";
import { Difficulty, type PolicyContext } from "../../types.js";
import { hardPolicy } from "../hard.js";

const GAME_SEED = 20260711;

/** A real engine state advanced into the action window (RECRUITMENT). */
function stateAtActionWindow(seed = GAME_SEED, players = 2): GameState {
  let state = createInitialState("HARDTS", makeSeats(players), seed);
  let guard = 0;
  while (state.phase !== GamePhase.RECRUITMENT) {
    state = advancePhase(state);
    if ((guard += 1) > 10) throw new Error("never reached RECRUITMENT");
  }
  return state;
}

/** Build a PolicyContext for a seat, with the seat's faction persona. */
function ctxFor(
  state: GameState,
  playerId: string,
  botSeed: number,
): PolicyContext {
  const me = state.players.find((p) => p.id === playerId);
  if (!me) throw new Error(`no player ${playerId}`);
  return {
    state,
    botPlayerId: playerId,
    rng: makeBotRng(GAME_SEED, botSeed, state.round),
    difficulty: Difficulty.HARD,
    persona: personaForFaction(me.faction ?? Faction.BYZANTIUM),
  };
}

/** Deep-clone a state for fixture surgery (test setup only — bots never mutate). */
function mutate(state: GameState, edit: (draft: GameState) => void): GameState {
  const draft = structuredClone(state) as GameState;
  edit(draft);
  return draft;
}

function zeroUnits(): Record<UnitType, number> {
  const u = {} as Record<UnitType, number>;
  for (const t of Object.values(UnitType)) u[t] = 0;
  return u;
}

/** A hand-built army stack for fixture surgery. */
function mkArmy(
  id: string,
  ownerId: string,
  locationId: string,
  units: Partial<Record<UnitType, number>>,
): Army {
  return { id, ownerId, locationId, units: { ...zeroUnits(), ...units }, variants: [] };
}

/** Everything the HARD policy is allowed to offer (never PASS/ADVANCE_PHASE). */
const ALLOWED = new Set([
  "MOVE",
  "RECRUIT",
  "BUILD",
  "TRADE",
  "DIPLOMACY",
  "SPY",
  "VASSALIZE",
  "DECLARE_WAR",
  "LEVY_CALL",
  "PLAY_TACTIC",
  "MERC_BID", // free §6.3 auction action, like PLAY_TACTIC
]);

describe("bots/policies/hard — contract", () => {
  it("offers only allowed candidate types, all issued by the bot", () => {
    for (let seed = 1; seed <= 8; seed += 1) {
      const state = stateAtActionWindow(seed, seed % 2 === 0 ? 5 : 2);
      for (const p of state.players) {
        const candidates = hardPolicy.chooseAction(ctxFor(state, p.id, seed));
        for (const a of candidates) {
          expect(ALLOWED.has(a.type)).toBe(true);
          expect(a.player).toBe(p.id);
        }
      }
    }
  });

  it("is deterministic: the same context yields the identical candidate list", () => {
    const state = stateAtActionWindow();
    const a = hardPolicy.chooseAction(ctxFor(state, "p1", 7));
    const b = hardPolicy.chooseAction(ctxFor(state, "p1", 7));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it("returns no candidates once the action budget is spent", () => {
    const state = mutate(stateAtActionWindow(), (draft) => {
      const me = draft.players.find((p) => p.id === "p1");
      if (me) me.actionsRemaining = 0;
    });
    expect(hardPolicy.chooseAction(ctxFor(state, "p1", 7))).toHaveLength(0);
  });

  it("drives real engine games without a single fallback pass (fuzzed seeds)", async () => {
    const runs: Array<[number, number]> = [
      [3, 2],
      [17, 2],
      [101, 5],
      [4242, 2],
      [909090, 5],
    ];
    for (const [seed, players] of runs) {
      let state = stateAtActionWindow(seed, players);
      const commit = (next: GameState): void => {
        state = next;
      };
      for (const seatId of state.turnOrder) {
        const seat = state.players.find((p) => p.id === seatId);
        const bot = new BotPlayer({
          playerId: seatId,
          gameSeed: seed,
          config: {
            difficulty: Difficulty.HARD,
            botSeed: 700 + seed,
            pacing: "instant",
          },
          policy: hardPolicy,
          persona: personaForFaction(seat?.faction ?? Faction.BYZANTIUM),
          submit: createEngineSubmit(() => state, commit),
        });
        await bot.takeTurn(state);
        expect(bot.stats.fallbackPasses).toBe(0);
        expect(bot.stats.actionsSubmitted).toBeGreaterThan(0);
      }
      for (const p of state.players) {
        expect(p.actionsRemaining).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("never offers a move onto a treaty partner's province (treaty honour)", () => {
    const state = mutate(stateAtActionWindow(), (draft) => {
      const treaty = {
        id: "nap-1",
        type: TreatyType.NAP,
        parties: ["p1", "p2"],
        startedRound: draft.round,
        expiresRound: null,
      };
      for (const p of draft.players) p.treaties = [treaty];
    });
    const p2Owned = new Set(
      state.provinces.filter((p) => p.ownerId === "p2").map((p) => p.id),
    );
    for (let botSeed = 0; botSeed < 20; botSeed += 1) {
      for (const a of hardPolicy.chooseAction(ctxFor(state, "p1", botSeed))) {
        if (a.type === "MOVE") expect(p2Owned.has(a.toId)).toBe(false);
      }
    }
  });
});

describe("bots/policies/hard — prestige line", () => {
  it("continues a near-complete great work ahead of everything else", () => {
    // Armies removed on BOTH sides: with a rival force looming, the policy
    // now (correctly) ranks emergency home defence and a defensive NAP above
    // the bazaar — this test is about the prestige line in peacetime.
    const state = mutate(stateAtActionWindow(), (draft) => {
      draft.armies = [];
      draft.fleets = draft.fleets.filter((f) => f.ownerId !== "p1");
      const selymbria = draft.provinces.find((p) => p.id === "selymbria");
      if (selymbria) {
        selymbria.greatWorks = [{ type: GreatWorkType.GRAND_BAZAAR, progress: 1 }];
      }
    });
    for (let botSeed = 0; botSeed < 20; botSeed += 1) {
      const [first] = hardPolicy.chooseAction(ctxFor(state, "p1", botSeed));
      expect(first).toBeDefined();
      if (first?.type !== "BUILD") throw new Error(`expected BUILD, got ${first?.type}`);
      expect(first.greatWork).toBe(GreatWorkType.GRAND_BAZAAR);
      expect(first.provinceId).toBe("selymbria");
    }
  });

  it("does not start a great work that would drain the gold reserve", () => {
    // GRAND_BAZAAR costs gold 16 / timber 6 / marble 6. gold 18 leaves 2 < the
    // reserve → not offered; gold 25 → offered.
    const base = mutate(stateAtActionWindow(), (draft) => {
      // Threat-neutral (see above): this test isolates the reserve gate.
      draft.armies = [];
      draft.fleets = draft.fleets.filter((f) => f.ownerId !== "p1");
      const me = draft.players.find((p) => p.id === "p1");
      if (me) me.treasury = { gold: 18, grain: 6, timber: 6, marble: 6, faith: 2 };
    });
    const startsBazaar = (s: GameState): boolean =>
      hardPolicy
        .chooseAction(ctxFor(s, "p1", 7))
        .some((a) => a.type === "BUILD" && a.greatWork !== undefined);
    expect(startsBazaar(base)).toBe(false);
    const rich = mutate(base, (draft) => {
      const me = draft.players.find((p) => p.id === "p1");
      if (me) me.treasury.gold = 25;
    });
    expect(startsBazaar(rich)).toBe(true);
  });
});

describe("bots/policies/hard — siege timing & the Ottoman line", () => {
  /** Era III state with a strong Ottoman stack on the Bosphorus shore. */
  function eraThree(edit?: (draft: GameState) => void): GameState {
    return mutate(stateAtActionWindow(), (draft) => {
      draft.round = 12;
      draft.turn = 12;
      draft.era = 3;
      draft.armies = draft.armies.filter((a) => a.ownerId !== "p2");
      draft.armies.push(
        mkArmy("army-p2-host", "p2", "bithynia", {
          [UnitType.CAVALRY]: 8,
          [UnitType.SIEGE]: 1,
        }),
      );
      edit?.(draft);
    });
  }

  it("refuses the T5 assault without the Great Bombard (masonry cap)", () => {
    // Constantinople: intact Theodosian walls, both supply zones open — no
    // breach and no starvation plan exists, so the move is never offered first.
    const state = eraThree();
    for (let botSeed = 0; botSeed < 15; botSeed += 1) {
      const [first] = hardPolicy.chooseAction(ctxFor(state, "p2", botSeed));
      expect(first).toBeDefined();
      expect(first?.type === "MOVE" && first.toId === "constantinople").toBe(false);
    }
  });

  it("marches on Constantinople once its own Great Bombard is emplaced nearby", () => {
    const state = eraThree((draft) => {
      draft.greatBombard = {
        inPlay: true,
        ownerId: "p2",
        provinceId: "bithynia",
        emplacedRound: 11,
      };
    });
    for (let botSeed = 0; botSeed < 15; botSeed += 1) {
      const [first] = hardPolicy.chooseAction(ctxFor(state, "p2", botSeed));
      expect(first).toBeDefined();
      if (first?.type !== "MOVE") throw new Error(`expected MOVE, got ${first?.type}`);
      expect(first.toId).toBe("constantinople");
    }
  });

  it("moves war fleets to close a besieged port's supply zones (sea resupply)", () => {
    // p2 besieges Constantinople; its war fleet sits one zone away. Closing
    // `bosphorus` denies resupply — it must outrank every other naval move.
    const state = mutate(stateAtActionWindow(), (draft) => {
      draft.siegeStates = [
        {
          provinceId: "constantinople",
          besiegerId: "p2",
          besiegingArmyIds: [],
          roundsElapsed: 1,
          grainStores: 3,
          breached: false,
          circumvallated: true,
        },
      ];
      draft.fleets = draft.fleets.filter((f) => f.ownerId !== "p2");
      draft.fleets.push({
        id: "fleet-p2-marmara",
        ownerId: "p2",
        locationId: "sea-of-marmara",
        units: { ...zeroUnits(), [UnitType.WARSHIP]: 2 },
        variants: [],
      });
    });
    for (let botSeed = 0; botSeed < 15; botSeed += 1) {
      const candidates = hardPolicy.chooseAction(ctxFor(state, "p2", botSeed));
      const navalMoves = candidates.filter(
        (a): a is Extract<GameAction, { type: "MOVE" }> =>
          a.type === "MOVE" && a.naval === true,
      );
      expect(navalMoves.length).toBeGreaterThan(0);
      expect(navalMoves[0].toId).toBe("bosphorus");
    }
  });

  it("builds a siege train once the obsession window approaches (Era II+)", () => {
    const state = mutate(stateAtActionWindow(), (draft) => {
      draft.round = 6;
      draft.turn = 6;
      draft.era = 2;
      const me = draft.players.find((p) => p.id === "p2");
      if (me) me.treasury = { gold: 12, grain: 6, timber: 3, marble: 3, faith: 2 };
    });
    for (let botSeed = 0; botSeed < 10; botSeed += 1) {
      const candidates = hardPolicy.chooseAction(ctxFor(state, "p2", botSeed));
      const siegeIdx = candidates.findIndex(
        (a) => a.type === "RECRUIT" && (a.units[UnitType.SIEGE] ?? 0) > 0,
      );
      const levyIdx = candidates.findIndex(
        (a) => a.type === "RECRUIT" && (a.units[UnitType.LEVY] ?? 0) > 0,
      );
      expect(siegeIdx).toBeGreaterThanOrEqual(0);
      if (levyIdx >= 0) expect(siegeIdx).toBeLessThan(levyIdx);
    }
  });
});

describe("bots/policies/hard — faction lines", () => {
  it("Venice opens a trade route between its ports", () => {
    const state = stateAtActionWindow(GAME_SEED, 5);
    const candidates = hardPolicy.chooseAction(ctxFor(state, "p3", 7));
    const route = candidates.find(
      (a) => a.type === "TRADE" && a.trade.kind === "ROUTE",
    );
    expect(route).toBeDefined();
    if (route?.type !== "TRADE" || route.trade.kind !== "ROUTE") {
      throw new Error("expected a ROUTE trade");
    }
    const owned = new Set(
      state.provinces.filter((p) => p.ownerId === "p3").map((p) => p.id),
    );
    expect(owned.has(route.trade.fromProvinceId)).toBe(true);
    expect(owned.has(route.trade.toProvinceId)).toBe(true);
    expect(route.trade.seaZonePath.length).toBeGreaterThan(0);
  });

  it("Byzantium offers tribute to a looming stronger attacker (bribe over war)", () => {
    const state = mutate(stateAtActionWindow(), (draft) => {
      draft.armies.push(
        mkArmy("army-p2-doorstep", "p2", "pera", { [UnitType.CAVALRY]: 8 }),
      );
    });
    for (let botSeed = 0; botSeed < 10; botSeed += 1) {
      const candidates = hardPolicy.chooseAction(ctxFor(state, "p1", botSeed));
      const bribe = candidates.find(
        (a) =>
          a.type === "DIPLOMACY" &&
          a.diplomacy.kind === "PROPOSE" &&
          a.diplomacy.treatyType === TreatyType.TRIBUTE &&
          a.diplomacy.targetPlayerId === "p2",
      );
      expect(bribe).toBeDefined();
      if (bribe?.type !== "DIPLOMACY") throw new Error("expected DIPLOMACY");
      expect((bribe.diplomacy.tribute?.gold ?? 0) > 0).toBe(true);
    }
  });

  it("Hungary declares a crusade-justified war on the Ottoman when it can press", () => {
    const state = mutate(stateAtActionWindow(GAME_SEED, 5), (draft) => {
      // A Hungarian host at Serbia — bordering unwalled Ottoman Sofia — with
      // crushing local odds, so a crusade can actually be pressed.
      draft.armies.push(
        mkArmy("army-p5-host", "p5", "serbia", { [UnitType.CAVALRY]: 8 }),
      );
    });
    // Find any DECLARE_WAR crusade candidate against the Ottoman faction.
    let seen = false;
    for (let botSeed = 0; botSeed < 10 && !seen; botSeed += 1) {
      const candidates = hardPolicy.chooseAction(ctxFor(state, "p5", botSeed));
      seen = candidates.some(
        (a) =>
          a.type === "DECLARE_WAR" &&
          a.target === Faction.OTTOMAN &&
          a.justification === "crusade",
      );
    }
    expect(seen).toBe(true);
  });
});

describe("bots/policies/hard — espionage", () => {
  /** p2 leads the prestige race by a wide margin. */
  function withLeader(edit?: (draft: GameState) => void): GameState {
    return mutate(stateAtActionWindow(), (draft) => {
      // Strip BOTH sides' field forces so the slate is dominated neither by
      // move noise nor by (correct) emergency home defence against a rival
      // host looming two steps from an armyless capital.
      draft.armies = [];
      draft.fleets = draft.fleets.filter((f) => f.ownerId !== "p1");
      const rival = draft.players.find((p) => p.id === "p2");
      if (rival) rival.prestige = 50;
      const me = draft.players.find((p) => p.id === "p1");
      if (me) me.treasury.gold = 10;
      edit?.(draft);
    });
  }

  it("spies on the prestige leader when the information value is high", () => {
    const candidates = hardPolicy.chooseAction(ctxFor(withLeader(), "p1", 7));
    const objective = candidates.find(
      (a) => a.type === "SPY" && a.mission === SpyMission.OBJECTIVE,
    );
    expect(objective).toBeDefined();
    if (objective?.type !== "SPY") throw new Error("expected SPY");
    expect(objective.targetPlayerId).toBe("p2");
  });

  it("does not repeat an OBJECTIVE mission it already succeeded at (own intel)", () => {
    const state = withLeader((draft) => {
      draft.log.push({
        id: "log-spy-1",
        round: 1,
        phase: draft.phase,
        type: "spy",
        actors: ["p1"],
        targets: ["p2"],
        data: { captured: false, objectiveId: "obj-x", secret: true, visibleTo: ["p1"] },
        message: "p1's agent uncovered p2's secret objective.",
        timestamp: 1,
      });
    });
    const candidates = hardPolicy.chooseAction(ctxFor(state, "p1", 7));
    expect(
      candidates.some((a) => a.type === "SPY" && a.mission === SpyMission.OBJECTIVE),
    ).toBe(false);
    // The suppression mission is still on the table against a runaway leader.
    expect(
      candidates.some((a) => a.type === "SPY" && a.mission === SpyMission.UNREST),
    ).toBe(true);
  });

  it("keeps its agents home when gold is short (cost + reserve)", () => {
    const state = withLeader((draft) => {
      const me = draft.players.find((p) => p.id === "p1");
      if (me) me.treasury.gold = 5;
    });
    const candidates = hardPolicy.chooseAction(ctxFor(state, "p1", 7));
    expect(candidates.some((a) => a.type === "SPY")).toBe(false);
  });
});

describe("bots/policies/hard — tactics & diplomacy", () => {
  /** Park a pending land battle at Constantinople with p1 defending. */
  function withBattle(hand: string[], meAttacker = false): GameState {
    return mutate(stateAtActionWindow(), (draft) => {
      const me = draft.players.find((p) => p.id === "p1");
      if (me) me.tacticHand = hand.map(asTacticCardId);
      draft.armies.push(
        mkArmy("army-p2-storm", "p2", "constantinople", { [UnitType.INFANTRY]: 6 }),
      );
      draft.pendingBattles = [
        {
          id: "pb-test",
          provinceId: "constantinople",
          attackerId: meAttacker ? "p1" : "p2",
          defenderId: meAttacker ? "p2" : "p1",
          attackerStackIds: ["army-p2-storm"],
          defenderStackIds: ["army-p1-constantinople"],
          isNaval: false,
          isSiege: false,
        },
      ];
    });
  }

  it("plays a matching tactic card into a high-leverage battle first", () => {
    const [first] = hardPolicy.chooseAction(
      ctxFor(withBattle(["veterans-of-the-border"]), "p1", 7),
    );
    expect(first).toBeDefined();
    if (first?.type !== "PLAY_TACTIC") {
      throw new Error(`expected PLAY_TACTIC, got ${first?.type}`);
    }
    expect(first.battleId).toBe("pb-test");
    expect(first.cardId).toBe("veterans-of-the-border");
  });

  it("respects a card's printed side: no defender-only card as attacker", () => {
    const candidates = hardPolicy.chooseAction(
      ctxFor(withBattle(["locked-shields"], true), "p1", 7),
    );
    expect(candidates.some((a) => a.type === "PLAY_TACTIC")).toBe(false);
  });

  it("accepts an incoming TRIBUTE first, and the engine concludes the treaty", () => {
    const state = mutate(stateAtActionWindow(), (draft) => {
      draft.activeModifiers.push({
        id: "treaty-test-1",
        scope: "persistent",
        kind: "treaty_proposal",
        data: {
          treatyId: "treaty-test-1",
          proposerId: "p2",
          accepterId: "p1",
          treatyType: TreatyType.TRIBUTE,
          tribute: { gold: 1 },
          expiresRound: null,
        },
      });
    });
    const [first] = hardPolicy.chooseAction(ctxFor(state, "p1", 7));
    expect(first).toBeDefined();
    if (first?.type !== "DIPLOMACY") throw new Error("expected DIPLOMACY first");
    expect(first.diplomacy.kind).toBe("ACCEPT");
    expect(first.diplomacy.treatyType).toBe(TreatyType.TRIBUTE);

    const next = applyAction(state, first as GameAction);
    const me = next.players.find((p) => p.id === "p1");
    expect(
      me?.treaties.some(
        (t) => t.type === TreatyType.TRIBUTE && t.parties.includes("p2"),
      ),
    ).toBe(true);
  });

  it("declines a NAP from a far weaker rival when its appetite for war is high", () => {
    // p1 (proposer) is stripped bare; hungry Ottoman p2 sees no reason to sign.
    const state = mutate(stateAtActionWindow(), (draft) => {
      draft.armies = draft.armies.filter((a) => a.ownerId !== "p1");
      draft.fleets = draft.fleets.filter((f) => f.ownerId !== "p1");
      draft.activeModifiers.push({
        id: "treaty-test-2",
        scope: "persistent",
        kind: "treaty_proposal",
        data: {
          treatyId: "treaty-test-2",
          proposerId: "p1",
          accepterId: "p2",
          treatyType: TreatyType.NAP,
          tribute: null,
          expiresRound: null,
        },
      });
    });
    for (const a of hardPolicy.chooseAction(ctxFor(state, "p2", 7))) {
      if (a.type === "DIPLOMACY") expect(a.diplomacy.kind).not.toBe("ACCEPT");
    }
  });
});
