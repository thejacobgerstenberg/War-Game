/**
 * diplomacy.test.ts — DIPLOMACY & NPC-MINORS subsystem (§11, §11.5).
 *
 * Covers each treaty type + accept lifecycle, the break-prestige penalties and
 * betrayal count, the reputation threshold (2 betrayals → −1 diplomacy rolls),
 * the royal-marriage casus belli → state.wars (§11); and the vassalize bribe
 * formula, success/failure roll, vassal tribute/levy/prestige, and conquered-
 * vassal revolt roll (§11.5).
 */
import { describe, it, expect } from "vitest";
import {
  Faction,
  TreatyType,
  UnitType,
  type DiplomacyAction,
  type GameState,
  type ResourceBundle,
  type VassalizeAction,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { applyDiplomacy, applyVassalize, runRevolts } from "../diplomacy.js";
import { EngineError } from "../actions.js";
import { PRESTIGE_VALUES, VASSAL } from "../balance.js";
import { makeRng } from "../rng.js";

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

function fresh(): GameState {
  return structuredClone(createInitialState("ROOM01", seats, 12345));
}

/** Predict the very next d6 the engine will draw from the current cursor. */
function nextDie(state: GameState): number {
  return makeRng(state.rngSeed, state.rngCursor).rollD6();
}

function propose(
  player: string,
  treatyType: TreatyType,
  target: string,
  extra: { tribute?: Partial<ResourceBundle>; expiresRound?: number } = {},
): DiplomacyAction {
  return {
    type: "DIPLOMACY",
    player,
    diplomacy: { kind: "PROPOSE", treatyType, targetPlayerId: target, ...extra },
  };
}

function accept(player: string, treatyType: TreatyType, initiator: string): DiplomacyAction {
  return {
    type: "DIPLOMACY",
    player,
    diplomacy: { kind: "ACCEPT", treatyType, targetPlayerId: initiator },
  };
}

function renounce(player: string, treatyType: TreatyType, other: string): DiplomacyAction {
  return {
    type: "DIPLOMACY",
    player,
    diplomacy: { kind: "RENOUNCE", treatyType, targetPlayerId: other },
  };
}

/** Propose from `a` and accept by `b`, returning the concluded state. */
function conclude(state: GameState, type: TreatyType, a = "p1", b = "p2"): GameState {
  return applyDiplomacy(applyDiplomacy(state, propose(a, type, b)), accept(b, type, a));
}

const minorById = (s: GameState, id: string) => s.minors.find((m) => m.id === id)!;

// ---------------------------------------------------------------------------
// §11 Treaty lifecycle (propose → accept)
// ---------------------------------------------------------------------------

describe("applyDiplomacy — §11 treaty conclusion", () => {
  it("PROPOSE parks a pending offer; ACCEPT writes the treaty onto BOTH parties", () => {
    const proposed = applyDiplomacy(fresh(), propose("p1", TreatyType.ALLIANCE, "p2"));
    expect(proposed.activeModifiers.some((m) => m.kind === "treaty_proposal")).toBe(true);

    const done = applyDiplomacy(proposed, accept("p2", TreatyType.ALLIANCE, "p1"));
    const t1 = done.players[0].treaties;
    const t2 = done.players[1].treaties;
    expect(t1).toHaveLength(1);
    expect(t2).toHaveLength(1);
    expect(t1[0].type).toBe(TreatyType.ALLIANCE);
    expect(t1[0].parties).toEqual(["p1", "p2"]);
    // The proposal is consumed on accept.
    expect(done.activeModifiers.some((m) => m.kind === "treaty_proposal")).toBe(false);
  });

  it("ACCEPT with no matching proposal throws NO_PROPOSAL", () => {
    expect(() => applyDiplomacy(fresh(), accept("p2", TreatyType.NAP, "p1"))).toThrow(
      EngineError,
    );
  });

  it("§11 NAP defaults to a 3-round term", () => {
    const s = fresh();
    const done = conclude(s, TreatyType.NAP);
    expect(done.players[0].treaties[0].expiresRound).toBe(s.round + 3);
  });

  it("§11 TRIBUTE records the proposer as payer and the accepter as payee", () => {
    const s = fresh();
    const proposed = applyDiplomacy(
      s,
      propose("p1", TreatyType.TRIBUTE, "p2", { tribute: { gold: 2 } }),
    );
    const done = applyDiplomacy(proposed, accept("p2", TreatyType.TRIBUTE, "p1"));
    const t = done.players[0].treaties[0];
    expect(t.type).toBe(TreatyType.TRIBUTE);
    expect(t.payerId).toBe("p1");
    expect(t.tributeFrom).toBe("p1");
    expect(t.tributeTo).toBe("p2");
    expect(t.tribute).toEqual({ gold: 2 });
  });
});

// ---------------------------------------------------------------------------
// §11 Break penalties + betrayal count + casus belli
// ---------------------------------------------------------------------------

describe("applyDiplomacy — §11 break penalties", () => {
  it("breaking an ALLIANCE costs −4 prestige and flags a betrayal", () => {
    const s = conclude(fresh(), TreatyType.ALLIANCE);
    const before = s.players[0].prestige;
    const out = applyDiplomacy(s, renounce("p1", TreatyType.ALLIANCE, "p2"));
    expect(out.players[0].prestige).toBe(before + PRESTIGE_VALUES.betrayAlliance); // −4
    expect(out.players[0].betrayals).toBe(1);
    expect(out.players[0].treaties).toHaveLength(0);
    expect(out.players[1].treaties).toHaveLength(0); // removed from both
    expect(out.log.some((l) => l.type === "betrayal")).toBe(true);
  });

  it("breaking a NAP costs −2 prestige", () => {
    const s = conclude(fresh(), TreatyType.NAP);
    const before = s.players[0].prestige;
    const out = applyDiplomacy(s, renounce("p1", TreatyType.NAP, "p2"));
    expect(out.players[0].prestige).toBe(before + PRESTIGE_VALUES.betrayNap); // −2
    expect(out.players[0].betrayals).toBe(1);
  });

  it("§11 breaking a ROYAL_MARRIAGE costs −4 AND grants the jilted power a casus belli (state.wars)", () => {
    const s = conclude(fresh(), TreatyType.ROYAL_MARRIAGE);
    const before = s.players[0].prestige;
    expect(s.wars).toHaveLength(0);
    const out = applyDiplomacy(s, renounce("p1", TreatyType.ROYAL_MARRIAGE, "p2"));
    expect(out.players[0].prestige).toBe(before + PRESTIGE_VALUES.betrayMarriage); // −4
    expect(out.wars).toHaveLength(1);
    // The jilted power (p2) is the aggrieved belligerent.
    expect(out.wars[0]).toMatchObject({ a: "p2", b: "p1" });
  });

  it("§11 TRIBUTE renounce is free (no prestige loss, no betrayal count)", () => {
    const s = conclude(fresh(), TreatyType.TRIBUTE);
    const before = s.players[0].prestige;
    const out = applyDiplomacy(s, renounce("p1", TreatyType.TRIBUTE, "p2"));
    expect(out.players[0].prestige).toBe(before);
    expect(out.players[0].betrayals).toBe(0);
    expect(out.players[0].treaties).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §11 Reputation: two betrayals → −1 to diplomacy (vassalize) rolls
// ---------------------------------------------------------------------------

describe("applyDiplomacy — §11 betrayal threshold", () => {
  it("reaches 2 betrayals after two perfidies and marks reputation in the log", () => {
    let s = conclude(fresh(), TreatyType.ALLIANCE);
    s = conclude(s, TreatyType.NAP);
    s = applyDiplomacy(s, renounce("p1", TreatyType.ALLIANCE, "p2"));
    s = applyDiplomacy(s, renounce("p1", TreatyType.NAP, "p2"));
    expect(s.players[0].betrayals).toBe(2);
    const lastBetrayal = [...s.log].reverse().find((l) => l.type === "betrayal");
    expect(lastBetrayal?.data?.reputation).toBe(true);
  });

  it("the reputation −1 penalty lowers the vassalize roll below the base case", () => {
    // Ragusa: tier 2, garrison 1. Give p1 tier-5 prestige so the roll is
    // die + 5 − 2 (+/− modifiers); a 2-betrayal player rolls one lower.
    const base = fresh();
    base.players[0].prestige = 50;
    base.players[0].treasury.gold = 100;
    const die = nextDie(base); // both branches share the same next cursor
    const cleanRoll = die + 5 - minorById(base, "ragusa").tier;

    const rep = structuredClone(base);
    rep.players[0].betrayals = 2;
    const action: VassalizeAction = { type: "VASSALIZE", player: "p1", minorId: "ragusa" };
    const out = applyVassalize(rep, action);
    const logged = [...out.log].reverse().find((l) => l.type === "diplomacy");
    expect(logged?.data?.roll).toBe(cleanRoll - 1); // §11 reputation −1
  });
});

// ---------------------------------------------------------------------------
// §11.5 Vassalize: bribe formula, roll, success/failure
// ---------------------------------------------------------------------------

describe("applyVassalize — §11.5 bribe & roll", () => {
  it("charges the 8 + 4×garrison bribe (ragusa garrison 1 → 12 gold)", () => {
    const s = fresh();
    s.players[0].prestige = 50; // guarantee success regardless of the die
    s.players[0].treasury.gold = 100;
    const expectedBribe = VASSAL.bribeBase + VASSAL.bribePerGarrison * 1; // 12
    const out = applyVassalize(s, { type: "VASSALIZE", player: "p1", minorId: "ragusa" });
    // Success: no refund, so exactly the bribe was spent.
    expect(out.players[0].treasury.gold).toBe(100 - expectedBribe);
  });

  it("the +4 marriage bribe raises the cost and adds +1 to the roll", () => {
    const s = fresh();
    s.players[0].prestige = 50;
    s.players[0].treasury.gold = 100;
    const die = nextDie(s);
    const out = applyVassalize(s, {
      type: "VASSALIZE",
      player: "p1",
      minorId: "ragusa",
      marriageBribe: true,
    });
    const expectedBribe =
      VASSAL.bribeBase + VASSAL.bribePerGarrison * 1 + VASSAL.marriageBribeGold; // 16
    expect(out.players[0].treasury.gold).toBe(100 - expectedBribe);
    const logged = [...out.log].reverse().find((l) => l.type === "diplomacy");
    expect(logged?.data?.roll).toBe(die + 5 - 2 + VASSAL.marriageBribeBonus);
  });

  it("on success binds the minor and advances the RNG cursor (§11.5)", () => {
    const s = fresh();
    s.players[0].prestige = 50;
    s.players[0].treasury.gold = 100;
    const out = applyVassalize(s, { type: "VASSALIZE", player: "p1", minorId: "ragusa" });
    expect(minorById(out, "ragusa").vassalOf).toBe("p1");
    expect(out.players[0].vassals).toContain("ragusa");
    expect(out.rngCursor).toBe(s.rngCursor + 1); // one die consumed
  });

  it("on failure half-refunds the bribe and leaves the minor free (§11.5)", () => {
    // Rhodes: tier 3, garrison 3, bribe = 8 + 12 = 20. With prestige 0 the roll is
    // die − 3 ≤ 3 < rollTarget(4), so failure is guaranteed.
    const s = fresh();
    s.players[0].prestige = 0;
    s.players[0].treasury.gold = 100;
    const bribe = VASSAL.bribeBase + VASSAL.bribePerGarrison * 3; // 20
    const out = applyVassalize(s, { type: "VASSALIZE", player: "p1", minorId: "rhodes" });
    expect(minorById(out, "rhodes").vassalOf).toBeNull();
    const refund = Math.floor(bribe * VASSAL.failRefundFraction); // 10
    expect(out.players[0].treasury.gold).toBe(100 - bribe + refund);
  });

  it("rejects an unaffordable bribe and an already-vassalised minor", () => {
    const poor = fresh();
    poor.players[0].treasury.gold = 0;
    expect(() =>
      applyVassalize(poor, { type: "VASSALIZE", player: "p1", minorId: "ragusa" }),
    ).toThrow(EngineError);

    const taken = fresh();
    minorById(taken, "ragusa").vassalOf = "p2";
    expect(() =>
      applyVassalize(taken, { type: "VASSALIZE", player: "p1", minorId: "ragusa" }),
    ).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------------------
// §11.5 runRevolts: vassal tribute, levy, prestige, and revolts
// ---------------------------------------------------------------------------

/** Turn `ragusa` into a bribed vassal of p1 with the levy call already due. */
function withVassalRagusa(s: GameState): GameState {
  const state = structuredClone(s);
  const minor = minorById(state, "ragusa");
  minor.vassalOf = "p1";
  minor.conquered = false;
  minor.roundsUntilLevy = 0; // levy call due this round
  state.players[0].vassals = ["ragusa"];
  return state;
}

describe("runRevolts — §11.5 vassal benefits", () => {
  it("pays the overlord the vassal's yields ×0.5 as tribute", () => {
    const s = withVassalRagusa(fresh());
    const prov = s.provinces.find((p) => p.id === "ragusa")!;
    const goldBefore = s.players[0].treasury.gold;
    const out = runRevolts(s);
    const expectedGold = Math.floor((prov.yields.gold ?? 0) * VASSAL.tributeFraction);
    expect(out.players[0].treasury.gold).toBe(goldBefore + expectedGold);
  });

  it("grants +1 prestige/round per vassal", () => {
    const s = withVassalRagusa(fresh());
    const before = s.players[0].prestige;
    const out = runRevolts(s);
    expect(out.players[0].prestige).toBe(before + VASSAL.prestigePerRound);
  });

  it("raises a free 2 + garrison-tier LEVY stack when the levy call is due", () => {
    const s = withVassalRagusa(fresh()); // ragusa tier 2
    const out = runRevolts(s);
    const army = out.armies.find((a) => a.ownerId === "p1" && a.locationId === "ragusa");
    const expected = VASSAL.levyBase + VASSAL.levyPerTier * minorById(s, "ragusa").tier; // 2 + 2
    expect(army?.units[UnitType.LEVY]).toBe(expected);
    // Cadence resets; no second levy next round.
    expect(minorById(out, "ragusa").roundsUntilLevy).toBe(VASSAL.levyEveryRounds);
  });

  it("holds the levy until the cadence elapses", () => {
    const s = withVassalRagusa(fresh());
    minorById(s, "ragusa").roundsUntilLevy = 2;
    const out = runRevolts(s);
    expect(out.armies.some((a) => a.locationId === "ragusa")).toBe(false);
    expect(minorById(out, "ragusa").roundsUntilLevy).toBe(1);
  });
});

describe("runRevolts — §11 royal-marriage prestige", () => {
  it("grants +2 prestige/round to BOTH marriage partners", () => {
    const s = conclude(fresh(), TreatyType.ROYAL_MARRIAGE);
    const p1 = s.players[0].prestige;
    const p2 = s.players[1].prestige;
    const out = runRevolts(s);
    expect(out.players[0].prestige).toBe(p1 + PRESTIGE_VALUES.royalMarriagePerRound);
    expect(out.players[1].prestige).toBe(p2 + PRESTIGE_VALUES.royalMarriagePerRound);
  });
});

describe("runRevolts — §11.5 revolts", () => {
  it("a minor-flagged revolt modifier frees a conquered vassal outright", () => {
    const s = fresh();
    const minor = minorById(s, "ragusa");
    minor.vassalOf = "p1";
    minor.conquered = true;
    s.players[0].vassals = ["ragusa"];
    s.activeModifiers = [
      { id: "rev1", scope: "round", kind: "vassal_revolt", data: { minorId: "ragusa" } },
    ];
    const out = runRevolts(s);
    expect(minorById(out, "ragusa").vassalOf).toBeNull();
    expect(out.players[0].vassals).not.toContain("ragusa");
    expect(out.log.some((l) => l.type === "betrayal")).toBe(true);
  });

  it("a faction-targeted trigger rolls the conquered-vassal revolt (1d6 ≤ 2)", () => {
    const s = fresh();
    const minor = minorById(s, "ragusa");
    minor.vassalOf = "p1";
    minor.conquered = true;
    s.players[0].vassals = ["ragusa"];
    s.activeModifiers = [
      {
        id: "rev2",
        scope: "round",
        kind: "revolt",
        target: { faction: Faction.BYZANTIUM },
      },
    ];
    const die = nextDie(s);
    const out = runRevolts(s);
    const revolted = minorById(out, "ragusa").vassalOf === null;
    expect(revolted).toBe(die <= VASSAL.conqueredRevoltRoll);
    // Determinism: the revolt roll advanced and persisted the cursor.
    expect(out.rngCursor).toBe(s.rngCursor + 1);
  });

  it("leaves a BRIBED vassal untouched by a trigger (only the sword breeds revolt)", () => {
    const s = withVassalRagusa(fresh()); // conquered = false
    s.activeModifiers = [
      {
        id: "rev3",
        scope: "round",
        kind: "revolt",
        target: { faction: Faction.BYZANTIUM },
      },
    ];
    const out = runRevolts(s);
    expect(minorById(out, "ragusa").vassalOf).toBe("p1");
  });
});
