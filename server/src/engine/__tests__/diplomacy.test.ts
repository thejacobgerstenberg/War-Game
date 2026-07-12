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
  type DeclareWarAction,
  type DiplomacyAction,
  type GameState,
  type ResourceBundle,
  type VassalizeAction,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import {
  applyDiplomacy,
  applyVassalize,
  declareWar,
  resolveWar,
  runRevolts,
} from "../diplomacy.js";
import { scorePrestige } from "../prestige.js";
import { EngineError } from "../actions.js";
import { PRESTIGE_VALUES, UNJUSTIFIED_WAR_PRESTIGE, VASSAL } from "../balance.js";
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

describe("applyDiplomacy — §11 break penalties (posted as prestige_pending)", () => {
  /** The prestige_pending posted against `playerId`, if any (CONTRACT2 §12.8). */
  const pendingFor = (s: GameState, playerId: string) =>
    s.activeModifiers.find(
      (m) => m.kind === "prestige_pending" && m.data?.playerId === playerId,
    );

  it("breaking an ALLIANCE POSTS a −4 prestige_pending and flags a betrayal (§11/§13.1)", () => {
    const s = conclude(fresh(), TreatyType.ALLIANCE);
    const before = s.players[0].prestige;
    const out = applyDiplomacy(s, renounce("p1", TreatyType.ALLIANCE, "p2"));
    // CONTRACT2 §12.8: prestige is NOT mutated directly; the penalty rides a
    // round-scoped prestige_pending that scorePrestige consumes at Cleanup.
    expect(out.players[0].prestige).toBe(before);
    const pend = pendingFor(out, "p1");
    expect(pend?.value).toBe(PRESTIGE_VALUES.betrayAlliance); // −4
    expect(pend?.scope).toBe("round");
    expect(pend?.data?.reason).toBe("betrayAlliance");
    expect(out.players[0].betrayals).toBe(1);
    expect(out.players[0].treaties).toHaveLength(0);
    expect(out.players[1].treaties).toHaveLength(0); // removed from both
    expect(out.log.some((l) => l.type === "betrayal")).toBe(true);
  });

  it("breaking a NAP POSTS a −2 prestige_pending", () => {
    const s = conclude(fresh(), TreatyType.NAP);
    const before = s.players[0].prestige;
    const out = applyDiplomacy(s, renounce("p1", TreatyType.NAP, "p2"));
    expect(out.players[0].prestige).toBe(before); // not mutated directly
    expect(pendingFor(out, "p1")?.value).toBe(PRESTIGE_VALUES.betrayNap); // −2
    expect(out.players[0].betrayals).toBe(1);
  });

  it("§11 breaking a ROYAL_MARRIAGE POSTS −4 pending AND grants the jilted power a casus belli (state.wars)", () => {
    const s = conclude(fresh(), TreatyType.ROYAL_MARRIAGE);
    const before = s.players[0].prestige;
    expect(s.wars).toHaveLength(0);
    const out = applyDiplomacy(s, renounce("p1", TreatyType.ROYAL_MARRIAGE, "p2"));
    expect(out.players[0].prestige).toBe(before); // not mutated directly
    expect(pendingFor(out, "p1")?.value).toBe(PRESTIGE_VALUES.betrayMarriage); // −4
    expect(out.wars).toHaveLength(1);
    // The jilted power (p2) is the aggrieved belligerent.
    expect(out.wars[0]).toMatchObject({ a: "p2", b: "p1" });
  });

  it("§11 TRIBUTE renounce is free (no prestige_pending, no betrayal count)", () => {
    const s = conclude(fresh(), TreatyType.TRIBUTE);
    const before = s.players[0].prestige;
    const out = applyDiplomacy(s, renounce("p1", TreatyType.TRIBUTE, "p2"));
    expect(out.players[0].prestige).toBe(before);
    expect(pendingFor(out, "p1")).toBeUndefined();
    expect(out.players[0].betrayals).toBe(0);
    expect(out.players[0].treaties).toHaveLength(0);
  });

  it("§11/§13.1 the posted betrayal penalty is consumed ONCE by scorePrestige at Cleanup", () => {
    // Isolation: a control cleanup (no renounce) vs. one after the renounce differ
    // ONLY by the −4 pending — identical capital/key-city scoring in both — so the
    // gap is exactly the betrayal penalty, proving the round-trip and no double-count.
    const concluded = conclude(fresh(), TreatyType.ALLIANCE);
    const control = scorePrestige(concluded).players[0].prestige;
    const renounced = applyDiplomacy(concluded, renounce("p1", TreatyType.ALLIANCE, "p2"));
    const scored = scorePrestige(renounced);
    expect(scored.players[0].prestige).toBe(control + PRESTIGE_VALUES.betrayAlliance); // −4 once
    expect(scored.activeModifiers.some((m) => m.kind === "prestige_pending")).toBe(false);
    // A negative penalty is NOT folded into the conquest track.
    expect(scored.players[0].conquestPrestige ?? 0).toBe(0);
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
    // Ragusa: garrison 1 → garrison-tier ⌊1/2⌋ = 0 (CANON §11.5). p1 prestige 50 →
    // prestige-tier ⌊50/10⌋ capped at 2, so the base roll is die + 2 − 0; a
    // 2-betrayal player rolls one lower.
    const base = fresh();
    base.players[0].prestige = 50;
    base.players[0].treasury.gold = 100;
    const die = nextDie(base); // both branches share the same next cursor
    const cleanRoll =
      die + 2 - Math.floor(minorById(base, "ragusa").garrison / 2); // die + 2 − 0

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
    // §11.5 (CANON): prestige-tier ⌊50/10⌋ capped at 2; ragusa garrison-tier ⌊1/2⌋ = 0.
    expect(logged?.data?.roll).toBe(die + 2 - 0 + VASSAL.marriageBribeBonus);
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
    // Rhodes: garrison 3 → garrison-tier ⌊3/2⌋ = 1 (CANON §11.5), bribe = 8 + 12 = 20.
    // With prestige 0 the roll is die − 1; seed 12345's next die is 3 → roll 2 <
    // rollTarget(4), a guaranteed failure. (Old baseline used the wall tier 3.)
    const s = fresh();
    s.players[0].prestige = 0;
    s.players[0].treasury.gold = 100;
    const die = nextDie(s);
    const roll = die - Math.floor(minorById(s, "rhodes").garrison / 2); // die − 1
    expect(roll).toBeLessThan(VASSAL.rollTarget); // pin the guaranteed-failure setup
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
    const s = withVassalRagusa(fresh()); // ragusa garrison 1 → garrison-tier ⌊1/2⌋ = 0
    const out = runRevolts(s);
    const army = out.armies.find((a) => a.ownerId === "p1" && a.locationId === "ragusa");
    // §11.5 (CANON): size = levyBase + levyPerTier × ⌊garrison/2⌋ = 2 + 1×0 = 2
    // (NOT the authored wall tier 2). Clamped to §6.4 stacking room (ample here).
    const expected =
      VASSAL.levyBase + VASSAL.levyPerTier * Math.floor(minorById(s, "ragusa").garrison / 2);
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

  it("§6.4 clamps the free levy to remaining stacking room at the capital (FL-02)", () => {
    // Ragusa is a CITY (cap 12). Pre-stack p1 to one below the cap so only 1 slot
    // remains; the 2-unit levy must clamp to 1 and never breach the §6.4 limit.
    const zeroUnits = () =>
      Object.fromEntries(Object.values(UnitType).map((t) => [t, 0])) as Record<
        UnitType,
        number
      >;
    const s = withVassalRagusa(fresh());
    s.armies = [
      ...s.armies,
      {
        id: "pre",
        ownerId: "p1",
        locationId: "ragusa",
        units: { ...zeroUnits(), [UnitType.INFANTRY]: 11 },
      },
    ];
    const out = runRevolts(s);
    const total = out.armies
      .filter((a) => a.ownerId === "p1" && a.locationId === "ragusa")
      .reduce(
        (acc, a) => acc + Object.values(a.units).reduce((n, c) => n + c, 0),
        0,
      );
    expect(total).toBe(12); // exactly the city cap — never 13
    expect(total).toBeLessThanOrEqual(12);
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

// ---------------------------------------------------------------------------
// §11.5 / CANON #7: vassal tribute is ×0.5 UNIFORM across all resources
// ---------------------------------------------------------------------------

describe("runRevolts — §11.5/CANON #7 vassal tribute is ×0.5 UNIFORM", () => {
  it("renders EVERY resource type at ×0.5 (floored), not gold alone", () => {
    const s = withVassalRagusa(fresh());
    // Author a multi-resource yield so uniformity is observable across keys.
    const prov = s.provinces.find((p) => p.id === "ragusa")!;
    prov.yields = { gold: 4, grain: 4, timber: 2, marble: 3, faith: 0 };
    const t0 = { ...s.players[0].treasury };
    const t1 = runRevolts(s).players[0].treasury;
    expect(t1.gold - t0.gold).toBe(2); // ⌊4×0.5⌋
    expect(t1.grain - t0.grain).toBe(2); // ⌊4×0.5⌋
    expect(t1.timber - t0.timber).toBe(1); // ⌊2×0.5⌋
    expect(t1.marble - t0.marble).toBe(1); // ⌊3×0.5⌋
    // tributeFraction is applied identically to every key — no resource is exempt.
    expect(VASSAL.tributeFraction).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// §11 War START (declareWar) — diplomacy owns the WarState
// ---------------------------------------------------------------------------

describe("declareWar — §11 war START (diplomacy-owned)", () => {
  const war = (player: string, target: Faction): DeclareWarAction => ({
    type: "DECLARE_WAR",
    player,
    target,
  });

  it("opens a WarState against the target faction's player (de-duplicated)", () => {
    const s = fresh();
    expect(s.wars).toHaveLength(0);
    const out = declareWar(s, war("p1", Faction.OTTOMAN));
    expect(out.wars).toContainEqual({ a: "p1", b: "p2", startedRound: s.round });
    // A second declaration does not add a duplicate war.
    const again = declareWar(out, war("p1", Faction.OTTOMAN));
    expect(again.wars.filter((w) => w.a === "p1" && w.b === "p2")).toHaveLength(1);
    expect(out.log.some((l) => l.type === "diplomacy")).toBe(true);
  });

  it("rejects declaring war on your own faction (BAD_TARGET)", () => {
    expect(() => declareWar(fresh(), war("p1", Faction.BYZANTIUM))).toThrowError(
      expect.objectContaining({ code: "BAD_TARGET" }),
    );
  });

  it("rejects declaring war on an unseated faction (NO_TARGET)", () => {
    expect(() => declareWar(fresh(), war("p1", Faction.VENICE))).toThrowError(
      expect.objectContaining({ code: "NO_TARGET" }),
    );
  });
});

// ---------------------------------------------------------------------------
// §11 delta 5 — unjustified-war prestige cost (posted as prestige_pending)
// ---------------------------------------------------------------------------

describe("declareWar — §11 delta 5 unjustified-war cost", () => {
  /** The prestige_pending posted against `playerId`, if any (CONTRACT2 §12.8). */
  const pendingFor = (s: GameState, playerId: string) =>
    s.activeModifiers.find(
      (m) => m.kind === "prestige_pending" && m.data?.playerId === playerId,
    );

  const declareWarAction = (
    player: string,
    target: Faction,
    justification?: DeclareWarAction["justification"],
  ): DeclareWarAction => ({ type: "DECLARE_WAR", player, target, justification });

  it("an UNJUSTIFIED DECLARE_WAR posts a −1 prestige_pending on the declarer (not a direct mutation)", () => {
    const s = fresh();
    const before = s.players[0].prestige;
    // No justification → unjustified war (§11 delta 5).
    const out = declareWar(s, declareWarAction("p1", Faction.OTTOMAN));
    // Prestige is NOT mutated directly; the −1 rides a round-scoped prestige_pending.
    expect(out.players[0].prestige).toBe(before);
    const pend = pendingFor(out, "p1");
    expect(pend?.value).toBe(-UNJUSTIFIED_WAR_PRESTIGE); // −1
    expect(pend?.scope).toBe("round");
    expect(pend?.data?.reason).toBe("unjustified_war");
    // target = the declarer's faction.
    expect(pend?.target?.faction).toBe(Faction.BYZANTIUM);
    // War bookkeeping still happens.
    expect(out.wars).toContainEqual({ a: "p1", b: "p2", startedRound: s.round });
  });

  it("scorePrestige consumes the unjustified-war −1 ONCE and never folds it into the conquest track", () => {
    const control = scorePrestige(fresh()).players[0].prestige;
    const declared = declareWar(fresh(), declareWarAction("p1", Faction.OTTOMAN));
    const scored = scorePrestige(declared);
    expect(scored.players[0].prestige).toBe(control - UNJUSTIFIED_WAR_PRESTIGE); // −1 once
    expect(scored.activeModifiers.some((m) => m.kind === "prestige_pending")).toBe(false);
    // A negative penalty is NOT folded into the conquest track (prestige.ts value>0 gate).
    expect(scored.players[0].conquestPrestige ?? 0).toBe(0);
  });

  it.each(["claim", "crusade"] as const)(
    "a JUSTIFIED (%s) DECLARE_WAR posts NO prestige_pending and costs nothing",
    (justification) => {
      const s = fresh();
      const before = s.players[0].prestige;
      const out = declareWar(s, declareWarAction("p1", Faction.OTTOMAN, justification));
      expect(pendingFor(out, "p1")).toBeUndefined();
      expect(out.players[0].prestige).toBe(before);
      expect(out.wars).toContainEqual({ a: "p1", b: "p2", startedRound: s.round });
      const logged = [...out.log].reverse().find((l) => l.type === "diplomacy");
      expect(logged?.data?.justified).toBe(true);
      expect(logged?.data?.unjustifiedPenalty).toBe(0);
    },
  );

  it("vassal-defense is justified ONLY when the declarer actually holds a vassal", () => {
    // No vassal held → the claim is implausible → unjustified (still costs −1).
    const noVassal = declareWar(
      fresh(),
      declareWarAction("p1", Faction.OTTOMAN, "vassal-defense"),
    );
    expect(pendingFor(noVassal, "p1")?.value).toBe(-UNJUSTIFIED_WAR_PRESTIGE);

    // Holding a vassal makes the same justification valid → no cost.
    const held = fresh();
    minorById(held, "ragusa").vassalOf = "p1";
    held.players[0].vassals = ["ragusa"];
    const out = declareWar(held, declareWarAction("p1", Faction.OTTOMAN, "vassal-defense"));
    expect(pendingFor(out, "p1")).toBeUndefined();
  });

  it("re-declaring an existing war levies NO fresh unjustified-war penalty (single, deduped)", () => {
    const first = declareWar(fresh(), declareWarAction("p1", Faction.OTTOMAN));
    expect(pendingFor(first, "p1")?.value).toBe(-UNJUSTIFIED_WAR_PRESTIGE);
    // Second unjustified declaration against the same target adds no new pending.
    const again = declareWar(first, declareWarAction("p1", Faction.OTTOMAN));
    const penalties = again.activeModifiers.filter(
      (m) =>
        m.kind === "prestige_pending" &&
        m.data?.playerId === "p1" &&
        m.data?.reason === "unjustified_war",
    );
    expect(penalties).toHaveLength(1);
    expect(again.wars.filter((w) => w.a === "p1" && w.b === "p2")).toHaveLength(1);
  });

  it("the delta-5 war cost is INDEPENDENT of the §11 alliance-break penalty (both fire, distinct reasons)", () => {
    // Existing alliance-break penalty (−4) still fires unchanged...
    const s = conclude(fresh(), TreatyType.ALLIANCE);
    const broken = applyDiplomacy(s, renounce("p1", TreatyType.ALLIANCE, "p2"));
    const breakPend = broken.activeModifiers.find(
      (m) =>
        m.kind === "prestige_pending" &&
        m.data?.playerId === "p1" &&
        m.data?.reason === "betrayAlliance",
    );
    expect(breakPend?.value).toBe(PRESTIGE_VALUES.betrayAlliance); // −4, intact
    // ...and an unjustified DECLARE_WAR on top posts its own distinct −1 pending.
    const warred = declareWar(broken, declareWarAction("p1", Faction.OTTOMAN));
    const warPend = warred.activeModifiers.filter(
      (m) =>
        m.kind === "prestige_pending" &&
        m.data?.playerId === "p1" &&
        m.data?.reason === "unjustified_war",
    );
    expect(warPend).toHaveLength(1);
    expect(warPend[0].value).toBe(-UNJUSTIFIED_WAR_PRESTIGE); // −1
    // The alliance-break −4 is still present and separate from the war −1.
    expect(
      warred.activeModifiers.filter(
        (m) => m.kind === "prestige_pending" && m.data?.playerId === "p1",
      ),
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §13.1 War END (resolveWar) — win-war +3 as prestige_pending
// ---------------------------------------------------------------------------

describe("resolveWar — §13.1 war END + win-war prestige_pending", () => {
  // Declare with a valid casus belli (delta 5): these cases exercise war END /
  // peace, so a JUSTIFIED declaration keeps the setup free of the unjustified-war
  // −1 prestige_pending and lets the "no award" assertions stay clean.
  const declare = (): GameState =>
    declareWar(fresh(), {
      type: "DECLARE_WAR",
      player: "p1",
      target: Faction.OTTOMAN,
      justification: "claim",
    });

  it("ends the war and POSTS a +3 win-war prestige_pending to the victor (not a direct mutation)", () => {
    const s = declare();
    expect(s.wars).toHaveLength(1);
    const before = s.players[1].prestige;
    const out = resolveWar(s, "p1", "p2", "p2");
    expect(out.wars).toHaveLength(0);
    expect(out.players[1].prestige).toBe(before); // pending, not mutated
    const pend = out.activeModifiers.find(
      (m) => m.kind === "prestige_pending" && m.data?.playerId === "p2",
    );
    expect(pend?.value).toBe(PRESTIGE_VALUES.winWar); // +3
    expect(pend?.scope).toBe("round");
    expect(pend?.data?.reason).toBe("win_war");
  });

  it("scorePrestige folds the +3 win-war award into prestige AND the conquest track", () => {
    const s = resolveWar(declare(), "p1", "p2", "p2");
    const control = scorePrestige(declare()).players[1]; // no war-win award
    const scored = scorePrestige(s).players[1];
    expect(scored.prestige).toBe(control.prestige + PRESTIGE_VALUES.winWar);
    expect(scored.conquestPrestige ?? 0).toBe(PRESTIGE_VALUES.winWar); // conquest-track
  });

  it("ends a war with no forced victor (mutual peace) and posts no award", () => {
    const out = resolveWar(declare(), "p1", "p2");
    expect(out.wars).toHaveLength(0);
    expect(out.activeModifiers.some((m) => m.kind === "prestige_pending")).toBe(false);
  });

  it("is a no-op when the pair is not at war", () => {
    const s = fresh();
    const out = resolveWar(s, "p1", "p2", "p1");
    expect(out.wars).toHaveLength(0);
    expect(out.activeModifiers.some((m) => m.kind === "prestige_pending")).toBe(false);
    expect(out.log).toEqual(s.log); // no chronicle entry
  });
});

// ---------------------------------------------------------------------------
// §13.1 Tribute forces peace: ACCEPT between belligerents ends the war
// ---------------------------------------------------------------------------

describe("applyDiplomacy ACCEPT — §13.1 tribute forces peace (war END)", () => {
  // Justified declaration (delta 5) so the war-END/peace assertions below are not
  // perturbed by the unjustified-war −1 prestige_pending.
  const declare = (): GameState =>
    declareWar(fresh(), {
      type: "DECLARE_WAR",
      player: "p1",
      target: Faction.OTTOMAN,
      justification: "claim",
    });

  it("concluding a TRIBUTE between belligerents ends the war and awards the PAYEE +3", () => {
    let s = declare();
    expect(s.wars).toHaveLength(1);
    // p1 (payer) sues for peace; p2 (payee) forces tribute → p2 wins the war.
    s = applyDiplomacy(s, propose("p1", TreatyType.TRIBUTE, "p2", { tribute: { gold: 2 } }));
    const out = applyDiplomacy(s, accept("p2", TreatyType.TRIBUTE, "p1"));
    expect(out.wars).toHaveLength(0);
    const pend = out.activeModifiers.find(
      (m) => m.kind === "prestige_pending" && m.data?.playerId === "p2",
    );
    expect(pend?.value).toBe(PRESTIGE_VALUES.winWar); // +3 to the payee
    expect(pend?.data?.reason).toBe("win_war");
  });

  it("concluding a NAP between belligerents ends the war with NO forced victor", () => {
    let s = declare();
    s = applyDiplomacy(s, propose("p1", TreatyType.NAP, "p2"));
    const out = applyDiplomacy(s, accept("p2", TreatyType.NAP, "p1"));
    expect(out.wars).toHaveLength(0); // peace made
    expect(out.activeModifiers.some((m) => m.kind === "prestige_pending")).toBe(false);
  });

  it("concluding an ALLIANCE between belligerents ends the war (allies cannot be at war)", () => {
    let s = declare();
    s = applyDiplomacy(s, propose("p1", TreatyType.ALLIANCE, "p2"));
    const out = applyDiplomacy(s, accept("p2", TreatyType.ALLIANCE, "p1"));
    expect(out.wars).toHaveLength(0); // §11 alliance ⇒ cannot attack each other
    expect(out.activeModifiers.some((m) => m.kind === "prestige_pending")).toBe(false);
  });
});
