/**
 * EASY policy tests — greedy short-horizon with deliberate imperfection.
 *
 * Covers: legality of every offered candidate against fuzzed REAL engine
 * states (driven end-to-end through BotPlayer + createEngineSubmit),
 * determinism, the fair-play/action-shape contract, and the characteristic
 * EASY behaviours: weak-target preference, income-first builds, bail-out
 * conversions when broke, NAP acceptance, rare NAP initiation, and the
 * seeded ~25% take-the-2nd/3rd-best imperfection.
 */
import { describe, expect, it } from "vitest";
import {
  BuildingType,
  Faction,
  GamePhase,
  TreatyType,
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
import { easyPolicy } from "../easy.js";

const GAME_SEED = 20260711;

/** A real engine state advanced into the action window (RECRUITMENT). */
function stateAtActionWindow(seed = GAME_SEED, players = 2): GameState {
  let state = createInitialState("EASYTS", makeSeats(players), seed);
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
    difficulty: Difficulty.EASY,
    persona: personaForFaction(me.faction ?? Faction.BYZANTIUM),
  };
}

/** Deep-clone a state for fixture surgery (test setup only — bots never mutate). */
function mutate(state: GameState, edit: (draft: GameState) => void): GameState {
  const draft = structuredClone(state) as GameState;
  edit(draft);
  return draft;
}

const BUDGETED = new Set(["MOVE", "RECRUIT", "BUILD", "TRADE", "DIPLOMACY"]);

describe("bots/policies/easy — contract", () => {
  it("offers only budgeted/diplomacy candidates, all issued by the bot", () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const state = stateAtActionWindow(seed);
      for (const p of state.players) {
        const candidates = easyPolicy.chooseAction(ctxFor(state, p.id, seed));
        for (const a of candidates) {
          expect(BUDGETED.has(a.type)).toBe(true); // never PASS/ADVANCE_PHASE
          expect(a.player).toBe(p.id);
        }
      }
    }
  });

  it("is deterministic: the same context yields the identical candidate list", () => {
    const state = stateAtActionWindow();
    const a = easyPolicy.chooseAction(ctxFor(state, "p1", 7));
    const b = easyPolicy.chooseAction(ctxFor(state, "p1", 7));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it("returns no candidates once the action budget is spent", () => {
    const state = mutate(stateAtActionWindow(), (draft) => {
      const me = draft.players.find((p) => p.id === "p1");
      if (me) me.actionsRemaining = 0;
    });
    expect(easyPolicy.chooseAction(ctxFor(state, "p1", 7))).toHaveLength(0);
  });

  it("drives real engine games without a single fallback pass (fuzzed seeds)", async () => {
    for (const seed of [3, 17, 101, 4242, 909090]) {
      let state = stateAtActionWindow(seed);
      const commit = (next: GameState): void => {
        state = next;
      };
      for (const seatId of state.turnOrder) {
        const seat = state.players.find((p) => p.id === seatId);
        const bot = new BotPlayer({
          playerId: seatId,
          gameSeed: seed,
          config: {
            difficulty: Difficulty.EASY,
            botSeed: 500 + seed,
            pacing: "instant",
          },
          policy: easyPolicy,
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
});

describe("bots/policies/easy — greedy heuristics", () => {
  it("attacks the weak adjacent target, not the fortified one", () => {
    // p1's morea army borders athens (walled CITY) and modon (open COAST).
    // Beef up athens' garrison so it is unambiguously the strong target.
    const base = mutate(stateAtActionWindow(), (draft) => {
      draft.armies = draft.armies.filter(
        (a) => a.ownerId !== "p1" || a.id === "army-p1-morea",
      );
      const athens = draft.provinces.find((p) => p.id === "athens");
      if (athens) athens.garrison = 12;
    });
    for (let botSeed = 0; botSeed < 25; botSeed += 1) {
      const candidates = easyPolicy.chooseAction(ctxFor(base, "p1", botSeed));
      const moveTo = (id: string): number =>
        candidates.findIndex((a) => a.type === "MOVE" && a.toId === id);
      const modon = moveTo("modon");
      const athens = moveTo("athens");
      expect(modon).toBeGreaterThanOrEqual(0);
      if (athens >= 0) expect(modon).toBeLessThan(athens);
    }
  });

  it("never plans a siege: no MOVE candidate carries declareSiege", () => {
    for (let seed = 1; seed <= 6; seed += 1) {
      const state = stateAtActionWindow(seed);
      for (const p of state.players) {
        for (const a of easyPolicy.chooseAction(ctxFor(state, p.id, seed))) {
          if (a.type === "MOVE") expect(a.declareSiege).toBeUndefined();
        }
      }
    }
  });

  it("ranks the income building (MARKET) above UNIVERSITY every time", () => {
    // No armies → the ranking is builds/recruits/converts only.
    const state = mutate(stateAtActionWindow(), (draft) => {
      draft.armies = draft.armies.filter((a) => a.ownerId !== "p1");
      draft.fleets = draft.fleets.filter((f) => f.ownerId !== "p1");
      const me = draft.players.find((p) => p.id === "p1");
      if (me) {
        me.treasury = { gold: 30, grain: 6, timber: 0, marble: 12, faith: 6 };
      }
    });
    for (let botSeed = 0; botSeed < 25; botSeed += 1) {
      const candidates = easyPolicy.chooseAction(ctxFor(state, "p1", botSeed));
      const buildIdx = (b: string): number =>
        candidates.findIndex((a) => a.type === "BUILD" && a.building === b);
      const market = buildIdx("MARKET");
      const university = buildIdx("UNIVERSITY");
      expect(market).toBeGreaterThanOrEqual(0);
      if (university >= 0) expect(market).toBeLessThan(university);
    }
  });

  it("bails out to gold conversions when broke", () => {
    const state = mutate(stateAtActionWindow(), (draft) => {
      draft.armies = draft.armies.filter((a) => a.ownerId !== "p1");
      draft.fleets = draft.fleets.filter((f) => f.ownerId !== "p1");
      const me = draft.players.find((p) => p.id === "p1");
      if (me) {
        me.treasury = { gold: 1, grain: 9, timber: 9, marble: 9, faith: 0 };
      }
    });
    for (let botSeed = 0; botSeed < 25; botSeed += 1) {
      const candidates = easyPolicy.chooseAction(ctxFor(state, "p1", botSeed));
      // Skip a (rare) leading NAP proposal — the greedy pick follows it.
      const first = candidates.find((a) => a.type !== "DIPLOMACY");
      expect(first).toBeDefined();
      if (first?.type !== "TRADE" || first.trade.kind !== "CONVERT") {
        throw new Error(`expected a CONVERT first, got ${first?.type}`);
      }
      expect(first.trade.get.gold ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("bots/policies/easy — diplomacy", () => {
  /** Park a NAP proposal from p2 to p1 on the modifier side-channel. */
  function withNapProposal(state: GameState): GameState {
    return mutate(state, (draft) => {
      draft.activeModifiers = [
        ...draft.activeModifiers,
        {
          id: "treaty-test-1",
          scope: "persistent",
          kind: "treaty_proposal",
          data: {
            treatyId: "treaty-test-1",
            proposerId: "p2",
            accepterId: "p1",
            treatyType: TreatyType.NAP,
            tribute: null,
            expiresRound: null,
          },
        },
      ];
    });
  }

  it("accepts a pending NAP first, and the engine accepts the action", () => {
    const state = withNapProposal(stateAtActionWindow());
    const [first] = easyPolicy.chooseAction(ctxFor(state, "p1", 7));
    expect(first).toBeDefined();
    if (first?.type !== "DIPLOMACY") throw new Error("expected DIPLOMACY first");
    expect(first.diplomacy.kind).toBe("ACCEPT");
    expect(first.diplomacy.treatyType).toBe(TreatyType.NAP);
    expect(first.diplomacy.targetPlayerId).toBe("p2");

    const next = applyAction(state, first as GameAction);
    const me = next.players.find((p) => p.id === "p1");
    expect(
      me?.treaties.some(
        (t) => t.type === TreatyType.NAP && t.parties.includes("p2"),
      ),
    ).toBe(true);
    // ACCEPT is free — no budget spent.
    expect(me?.actionsRemaining).toBe(
      state.players.find((p) => p.id === "p1")?.actionsRemaining,
    );
  });

  it("does not re-offer an accept for a proposal aimed at someone else", () => {
    const state = withNapProposal(stateAtActionWindow());
    // p2 sees its OWN outgoing proposal — it must not try to accept it.
    for (const a of easyPolicy.chooseAction(ctxFor(state, "p2", 7))) {
      if (a.type === "DIPLOMACY") expect(a.diplomacy.kind).not.toBe("ACCEPT");
    }
  });

  it("initiates NAPs rarely (seeded, nonzero, well under half of slots)", () => {
    const state = stateAtActionWindow();
    let proposals = 0;
    const trials = 300;
    for (let botSeed = 0; botSeed < trials; botSeed += 1) {
      const candidates = easyPolicy.chooseAction(ctxFor(state, "p1", botSeed));
      if (
        candidates.some(
          (a) => a.type === "DIPLOMACY" && a.diplomacy.kind === "PROPOSE",
        )
      ) {
        proposals += 1;
      }
    }
    expect(proposals).toBeGreaterThan(0); // it does happen...
    expect(proposals).toBeLessThan(trials * 0.25); // ...but rarely
  });

  it("never offers a move onto a treaty partner's province", () => {
    // Give p1 a NAP with p2; every p2-owned destination must be filtered out.
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
    for (let botSeed = 0; botSeed < 25; botSeed += 1) {
      for (const a of easyPolicy.chooseAction(ctxFor(state, "p1", botSeed))) {
        if (a.type === "MOVE") expect(p2Owned.has(a.toId)).toBe(false);
      }
    }
  });
});

describe("bots/policies/easy — deliberate imperfection", () => {
  it("takes the 2nd/3rd-ranked action instead of the best ~25% of the time", () => {
    // Fixture with an unambiguous greedy best: one affordable MARKET
    // (score ~2.0) over grain bail-out converts (1.8); everything else far
    // behind. The only way MARKET is not first is the seeded mistake.
    const state = mutate(stateAtActionWindow(), (draft) => {
      draft.armies = draft.armies.filter((a) => a.ownerId !== "p1");
      draft.fleets = draft.fleets.filter((f) => f.ownerId !== "p1");
      const me = draft.players.find((p) => p.id === "p1");
      if (me) {
        // grain 0 → grain converts score 1.8; timber/faith 0 kills the
        // other builds; gold+marble afford MARKET and WALLS only.
        me.treasury = { gold: 30, grain: 0, timber: 0, marble: 30, faith: 0 };
      }
      // Leave p1 exactly one province so there is exactly one MARKET slot.
      let kept = false;
      for (const prov of draft.provinces) {
        if (prov.ownerId !== "p1") continue;
        if (!kept && prov.id === "selymbria") kept = true;
        else prov.ownerId = null;
      }
    });

    const trials = 400;
    let mistakes = 0;
    for (let botSeed = 0; botSeed < trials; botSeed += 1) {
      const candidates = easyPolicy.chooseAction(ctxFor(state, "p1", botSeed));
      // Skip a (rare) leading NAP proposal — the greedy pick follows it.
      const first = candidates.find((a) => a.type !== "DIPLOMACY");
      expect(first).toBeDefined();
      const isBest =
        first?.type === "BUILD" && first.building === BuildingType.MARKET;
      if (!isBest) {
        mistakes += 1;
        // A mistake is still a sensible runner-up (2nd/3rd: a grain convert).
        if (first?.type !== "TRADE" || first.trade.kind !== "CONVERT") {
          throw new Error(`mistake was not a runner-up: ${first?.type}`);
        }
        expect(first.trade.get.grain ?? 0).toBeGreaterThan(0);
      }
    }
    const rate = mistakes / trials;
    expect(rate).toBeGreaterThan(0.15);
    expect(rate).toBeLessThan(0.35);
  });
});
