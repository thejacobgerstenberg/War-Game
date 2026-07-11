/**
 * tactics.test.ts — the tactic-deck subsystem (draw / hold / play / resolve, §7.7).
 *
 * Covers: draw (base + University bonus) into the hidden hand; reshuffle of the
 * discard when the draw pile empties WITHOUT mixing in the removed pile; Cleanup
 * hand-limit prune; queue → play flow; greek-fire routed to `tacticRemoved` (and
 * a second card discarded) after play; and that representative cards post the
 * expected battle-/siege-scoped ActiveModifier for combat.ts to read.
 *
 * Marshal-review B3 coverage (per play path, CONSUMPTION asserted as STATE /
 * dice-outcome deltas, not mere modifier posting):
 * - battle path: queue legality (play path / domain / side / hexamilion
 *   precondition), per-ROUND (not per-battle) limit;
 * - siege path (`playSiegeTactic` vs an active SiegeState): night-sortie and
 *   sails-from-the-west with-card-vs-without `resolveSiege` deltas (same seed),
 *   treason gates + cost + removal;
 * - global path (`playGlobalTactic`): papal-indulgence gold→faith delta,
 *   treasury transfers, hand reveal, targeted-modifier validation, and
 *   wrong-target-mode rejections.
 */
import { describe, it, expect } from "vitest";
import {
  BuildingType,
  Faction,
  UnitType,
  asTacticCardId,
  type GameState,
  type PendingBattle,
  type Player,
  type TacticCardId,
} from "@imperium/shared";
import { createInitialState, emptyUnits, type SeatInput } from "./gameState.js";
import { resolveSiege } from "./combat.js";
import { getModifiers } from "./modifiers.js";
import { makeRng } from "./rng.js";
import { TACTIC_HAND_LIMIT, TREASON_GATE } from "./balance.js";
import {
  drawTactic,
  discardToHandLimit,
  playGlobalTactic,
  playSiegeTactic,
  queueTactic,
  playTactic,
  resolveTacticEffect,
} from "./tactics.js";

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

function fresh(): GameState {
  return structuredClone(createInitialState("ROOM01", seats, 12345));
}

function player(state: GameState, id: string): Player {
  const p = state.players.find((pl) => pl.id === id);
  if (!p) throw new Error(`no player ${id}`);
  return p;
}

const tid = (s: string): TacticCardId => asTacticCardId(s);

/** Give a player a hand of the named tactic slugs. */
function withHand(state: GameState, id: string, slugs: string[]): GameState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.id === id ? { ...p, tacticHand: slugs.map(tid) } : p,
    ),
  };
}

/** A minimal land battle at a province the given players contest. */
function landBattle(provinceId: string): PendingBattle {
  return {
    id: "b1",
    provinceId,
    attackerId: "p2",
    defenderId: "p1",
    attackerStackIds: ["a-atk"],
    defenderStackIds: ["a-def"],
  };
}

describe("drawTactic (§7.7)", () => {
  it("draws one card into the hidden hand and advances the deck", () => {
    const s0 = fresh();
    const before = s0.tacticDeck?.length ?? 0;
    const s1 = drawTactic(s0, "p1");
    expect(player(s1, "p1").tacticHand).toHaveLength(1);
    expect(s1.tacticDeck?.length).toBe(before - 1);
  });

  it("adds the University draw bonus (§9.1)", () => {
    let s0 = fresh();
    // Give p1 a University in one owned province.
    const owned = s0.provinces.find((p) => p.ownerId === "p1");
    if (!owned) throw new Error("no p1 province");
    s0 = {
      ...s0,
      provinces: s0.provinces.map((p) =>
        p.id === owned.id ? { ...p, buildings: [...p.buildings, BuildingType.UNIVERSITY] } : p,
      ),
    };
    const s1 = drawTactic(s0, "p1");
    expect(player(s1, "p1").tacticHand).toHaveLength(2); // 1 base + 1 University
  });

  it("reshuffles the discard when the deck empties — never the removed pile", () => {
    let s0 = fresh();
    s0 = {
      ...s0,
      tacticDeck: [],
      tacticDiscard: [tid("veterans-of-the-border"), tid("locked-shields"), tid("forced-march")],
      tacticRemoved: [tid("greek-fire")],
    };
    const s1 = drawTactic(s0, "p1");
    const drawn = player(s1, "p1").tacticHand ?? [];
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).not.toBe(tid("greek-fire")); // removed pile stays out
    expect(s1.tacticRemoved).toEqual([tid("greek-fire")]);
    expect(s1.tacticDeck?.length).toBe(2); // 3 reshuffled − 1 drawn
    expect(s1.tacticDiscard).toEqual([]);
    expect(s1.rngCursor).toBeGreaterThan(s0.rngCursor); // reshuffle consumed the cursor
  });

  it("stops drawing when both deck and discard are exhausted", () => {
    let s0 = fresh();
    s0 = { ...s0, tacticDeck: [tid("forced-march")], tacticDiscard: [] };
    // University-boosted p1 wants 2 but only 1 card exists.
    const owned = s0.provinces.find((p) => p.ownerId === "p1")!;
    s0 = {
      ...s0,
      provinces: s0.provinces.map((p) =>
        p.id === owned.id ? { ...p, buildings: [...p.buildings, BuildingType.UNIVERSITY] } : p,
      ),
    };
    const s1 = drawTactic(s0, "p1");
    expect(player(s1, "p1").tacticHand).toHaveLength(1);
    expect(s1.tacticDeck).toEqual([]);
  });
});

describe("discardToHandLimit (§7.7 Cleanup)", () => {
  it("prunes the hand to TACTIC_HAND_LIMIT, discarding the overflow", () => {
    const over = ["forced-march", "veterans-of-the-border", "locked-shields", "the-counting-house", "grain-barges-of-the-danube"];
    let s0 = withHand(fresh(), "p1", over);
    s0 = { ...s0, tacticDiscard: [] };
    const s1 = discardToHandLimit(s0, "p1");
    expect(player(s1, "p1").tacticHand).toHaveLength(TACTIC_HAND_LIMIT);
    expect(s1.tacticDiscard).toHaveLength(over.length - TACTIC_HAND_LIMIT);
    // The kept cards are the first three; the overflow went to discard.
    expect(player(s1, "p1").tacticHand).toEqual(over.slice(0, TACTIC_HAND_LIMIT).map(tid));
    expect(s1.tacticDiscard).toEqual(over.slice(TACTIC_HAND_LIMIT).map(tid));
  });

  it("is a no-op at or under the limit", () => {
    const s0 = withHand(fresh(), "p1", ["forced-march", "locked-shields"]);
    const s1 = discardToHandLimit(s0, "p1");
    expect(s1).toBe(s0);
  });
});

describe("queueTactic (§7.7 declaration)", () => {
  it("moves a held card onto the battle's side queue", () => {
    let s0 = withHand(fresh(), "p1", ["locked-shields"]);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] };
    const s1 = queueTactic(s0, "b1", "defender", tid("locked-shields"));
    expect(player(s1, "p1").tacticHand).toEqual([]);
    expect(s1.pendingBattles[0].defenderTactics).toEqual([tid("locked-shields")]);
  });

  it("rejects a card the side does not hold", () => {
    let s0 = withHand(fresh(), "p1", []);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] };
    expect(() => queueTactic(s0, "b1", "defender", tid("locked-shields"))).toThrow();
  });

  it("allows queueing several cards — §7.7 prints the limit PER BATTLE ROUND, not per battle (marshal minor)", () => {
    // GD §7.7 "Playing": "Each side may play at most one tactic card per battle
    // ROUND". The per-round cap is enforced where cards are CONSUMED (combat's
    // tactic step takes at most one queued card per side each battle round);
    // declaration may stockpile several for a multi-round battle.
    let s0 = withHand(fresh(), "p1", ["locked-shields", "the-white-knights-stroke"]);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] };
    const s1 = queueTactic(s0, "b1", "defender", tid("locked-shields"));
    const s2 = queueTactic(s1, "b1", "defender", tid("the-white-knights-stroke"));
    expect(s2.pendingBattles[0].defenderTactics).toEqual([
      tid("locked-shields"),
      tid("the-white-knights-stroke"),
    ]);
    expect(player(s2, "p1").tacticHand).toEqual([]);
  });

  it("rejects a GLOBAL card queued into a battle (B3 wrong target mode)", () => {
    let s0 = withHand(fresh(), "p1", ["papal-indulgence"]);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] };
    expect(() => queueTactic(s0, "b1", "defender", tid("papal-indulgence"))).toThrow(
      /no battle scope/,
    );
  });

  it("rejects a SIEGE card queued into a plain field battle (B3 wrong target mode)", () => {
    let s0 = withHand(fresh(), "p1", ["night-sortie"]);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] }; // no isSiege
    expect(() => queueTactic(s0, "b1", "defender", tid("night-sortie"))).toThrow(
      /siege-scoped/,
    );
  });

  it("enforces domain legality: a fleet card in a land battle and vice versa (SS7)", () => {
    // pilot-of-the-narrows (fleet) into a LAND battle.
    let s0 = withHand(fresh(), "p2", ["pilot-of-the-narrows"]);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] };
    expect(() => queueTactic(s0, "b1", "attacker", tid("pilot-of-the-narrows"))).toThrow(
      /fleet battle/,
    );
    // veterans-of-the-border (land) into a FLEET battle.
    let s1 = withHand(fresh(), "p1", ["veterans-of-the-border"]);
    s1 = {
      ...s1,
      pendingBattles: [
        {
          id: "b1",
          seaZoneId: "sea-of-marmara",
          attackerId: "p1",
          defenderId: "p2",
          attackerStackIds: ["f-atk"],
          defenderStackIds: ["f-def"],
        },
      ],
    };
    expect(() => queueTactic(s1, "b1", "attacker", tid("veterans-of-the-border"))).toThrow(
      /land engagement/,
    );
  });

  it("enforces the printed side restriction (locked-shields is defender-only)", () => {
    let s0 = withHand(fresh(), "p2", ["locked-shields"]);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] };
    expect(() => queueTactic(s0, "b1", "attacker", tid("locked-shields"))).toThrow(
      /defender/,
    );
  });

  it("the-hexamilion-manned only defends an UNWALLED province (§7.7 precondition, SS7)", () => {
    // Constantinople is walled (T5) → rejected.
    let s0 = withHand(fresh(), "p1", ["the-hexamilion-manned"]);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] };
    expect(() => queueTactic(s0, "b1", "defender", tid("the-hexamilion-manned"))).toThrow(
      /UNWALLED/,
    );
    // Strip the walls → allowed.
    const s1 = {
      ...s0,
      provinces: s0.provinces.map((p) =>
        p.id === "constantinople" ? { ...p, walls: { tier: 0, hp: 0 } } : p,
      ),
    };
    const s2 = queueTactic(s1, "b1", "defender", tid("the-hexamilion-manned"));
    expect(s2.pendingBattles[0].defenderTactics).toEqual([tid("the-hexamilion-manned")]);
  });
});

describe("playTactic / resolveTacticEffect — modifiers (§7.7 / CONTRACT2 §12.10)", () => {
  const rng = makeRng(1);

  it("veterans-of-the-border posts a +1 combat_mod scoped to the battle", () => {
    let s0 = withHand(fresh(), "p2", ["veterans-of-the-border"]);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] };
    const s1 = playTactic(s0, s0.pendingBattles[0], "attacker", tid("veterans-of-the-border"), rng);
    const mods = getModifiers(s1, "combat_mod", { faction: Faction.OTTOMAN, provinceId: "constantinople" });
    expect(mods).toHaveLength(1);
    expect(mods[0].value).toBe(1);
    expect(mods[0].data?.dice).toBe(true);
    expect(mods[0].scope).toBe("round");
    // The card left the hand and went to the discard (not removed).
    expect(player(s1, "p2").tacticHand).toEqual([]);
    expect(s1.tacticDiscard).toContain(tid("veterans-of-the-border"));
  });

  it("master-founders-hired cancels the wall bonus AND adds a +1 assault die (RULING 4)", () => {
    // lore/tactics/cards.md (PR #8 ## Rare): "In one siege, cancel the wall bonus
    // for one full round and add 1 die to your assault." Mechanic = the ratified
    // bribed-gatekeeper wall-bonus cancel PLUS a +1 assault die; NOT the previously
    // invented "+2 wall-HP damage dice" siege_mod.
    let s0 = withHand(fresh(), "p2", ["master-founders-hired"]);
    s0 = { ...s0, pendingBattles: [{ ...landBattle("constantinople"), isSiege: true }] };
    const s1 = playTactic(s0, s0.pendingBattles[0], "attacker", tid("master-founders-hired"), rng);
    // 1) Wall bonus nulled for this assault (same posting as bribed-gatekeeper).
    const wallMods = getModifiers(s1, "wall_mod", { provinceId: "constantinople" });
    expect(wallMods.some((m) => m.data?.wallBonusZero === true)).toBe(true);
    // 2) +1 assault die → attacker combat_mod at the besieged province.
    const combatMods = getModifiers(s1, "combat_mod", {
      faction: Faction.OTTOMAN,
      provinceId: "constantinople",
    });
    expect(combatMods).toHaveLength(1);
    expect(combatMods[0].value).toBe(1);
    expect(combatMods[0].data?.dice).toBe(true);
    // The old invented "+2 wall-HP damage dice" siege_mod is gone.
    const siegeMods = getModifiers(s1, "siege_mod", {
      faction: Faction.OTTOMAN,
      provinceId: "constantinople",
    });
    expect(siegeMods).toHaveLength(0);
  });

  it("bribed-gatekeeper posts a wall_mod nulling the defender's wall bonus", () => {
    let s0 = withHand(fresh(), "p2", ["bribed-gatekeeper"]);
    s0 = { ...s0, pendingBattles: [{ ...landBattle("constantinople"), isSiege: true }] };
    const s1 = playTactic(s0, s0.pendingBattles[0], "attacker", tid("bribed-gatekeeper"), rng);
    const mods = getModifiers(s1, "wall_mod", { provinceId: "constantinople" });
    expect(mods.some((m) => m.data?.wallBonusZero === true)).toBe(true);
  });

  it("condottieri-contract charges its 2-gold printed cost", () => {
    let s0 = withHand(fresh(), "p2", ["condottieri-contract"]);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] };
    const goldBefore = player(s0, "p2").treasury.gold;
    const s1 = playTactic(s0, s0.pendingBattles[0], "attacker", tid("condottieri-contract"), rng);
    expect(player(s1, "p2").treasury.gold).toBe(goldBefore - 2);
    const mods = getModifiers(s1, "combat_mod", { faction: Faction.OTTOMAN, provinceId: "constantinople" });
    expect(mods[0].value).toBe(2);
  });

  it("the-counting-house adds 2 gold and discards", () => {
    const s0 = withHand(fresh(), "p1", ["the-counting-house"]);
    const goldBefore = player(s0, "p1").treasury.gold;
    const s1 = resolveTacticEffect(s0, tid("the-counting-house"), { playerId: "p1", rng });
    expect(player(s1, "p1").treasury.gold).toBe(goldBefore + 2);
    expect(s1.tacticDiscard).toContain(tid("the-counting-house"));
  });

  it("greek-fire wins the fleet outright, is removed, and discards one other card", () => {
    let s0 = withHand(fresh(), "p1", ["greek-fire", "forced-march"]);
    s0 = {
      ...s0,
      pendingBattles: [
        {
          id: "b1",
          seaZoneId: "sea-of-marmara",
          attackerId: "p1",
          defenderId: "p2",
          attackerStackIds: ["f-atk"],
          defenderStackIds: ["f-def"],
          isNaval: true,
        },
      ],
    };
    const s1 = playTactic(s0, s0.pendingBattles[0], "attacker", tid("greek-fire"), rng);
    const mods = getModifiers(s1, "combat_mod", { faction: Faction.BYZANTIUM, seaZoneId: "sea-of-marmara" });
    expect(mods.some((m) => m.data?.autoWinNaval === true)).toBe(true);
    // greek-fire removed from game; the OTHER card discarded; hand now empty.
    expect(s1.tacticRemoved).toContain(tid("greek-fire"));
    expect(s1.tacticDiscard).toContain(tid("forced-march"));
    expect(player(s1, "p1").tacticHand).toEqual([]);
  });

  it("the-pay-chest-taken transfers up to 3 gold, capped at what the rival holds", () => {
    let s0 = withHand(fresh(), "p1", ["the-pay-chest-taken", "the-pay-chest-taken"]);
    // Cap test: shrink p2's gold to 1.
    s0 = {
      ...s0,
      players: s0.players.map((p) =>
        p.id === "p2" ? { ...p, treasury: { ...p.treasury, gold: 1 } } : p,
      ),
    };
    const thiefBefore = player(s0, "p1").treasury.gold;
    const s1 = resolveTacticEffect(s0, tid("the-pay-chest-taken"), {
      playerId: "p1",
      targetPlayerId: "p2",
      rng,
    });
    expect(player(s1, "p2").treasury.gold).toBe(0);
    expect(player(s1, "p1").treasury.gold).toBe(thiefBefore + 1);
  });
});

describe("treason-at-the-gate double-brake (DELTA 1, GD §7.7 + ratification)", () => {
  const rng = makeRng(1);
  const { maxGarrison, minGameRound } = TREASON_GATE; // 4, 6

  /**
   * p2 (Ottoman) besieges constantinople (p1). `garrison` sets the defender
   * garrison; the siege's consecutive-round clock started at
   * `round - roundsElapsed`. p2 holds treason-at-the-gate and enough gold for its
   * printed cost. Battle "b1" is the (siege) assault.
   */
  function treasonSetup(opts: { round: number; roundsElapsed: number; garrison: number }): GameState {
    let s = withHand(fresh(), "p2", ["treason-at-the-gate"]);
    s = {
      ...s,
      round: opts.round,
      provinces: s.provinces.map((p) =>
        p.id === "constantinople" ? { ...p, ownerId: "p1", garrison: opts.garrison } : p,
      ),
      players: s.players.map((p) =>
        p.id === "p2" ? { ...p, treasury: { ...p.treasury, gold: 20 } } : p,
      ),
      siegeStates: [
        {
          provinceId: "constantinople",
          besiegerId: "p2",
          besiegingArmyIds: ["a2"],
          roundsElapsed: opts.roundsElapsed,
          grainStores: 0,
          breached: false,
          circumvallated: true,
        },
      ],
      pendingBattles: [
        {
          id: "b1",
          provinceId: "constantinople",
          attackerId: "p2",
          defenderId: "p1",
          attackerStackIds: ["a2"],
          defenderStackIds: ["a-def"],
          isSiege: true,
        },
      ],
    };
    return s;
  }

  it("allows treason when garrison <= max AND the siege began at/after minGameRound", () => {
    // round 8, elapsed 2 → siege started round 6 (== minGameRound); garrison 3 (<= 4).
    const s0 = treasonSetup({ round: minGameRound + 2, roundsElapsed: 2, garrison: maxGarrison - 1 });
    const s1 = queueTactic(s0, "b1", "attacker", tid("treason-at-the-gate"));
    expect(s1.pendingBattles[0].attackerTactics).toEqual([tid("treason-at-the-gate")]);
    expect(player(s1, "p2").tacticHand).toEqual([]);

    // And it resolves: playTactic posts the siege_mod autoCapture and removes the card.
    const s2 = playTactic(s0, s0.pendingBattles[0], "attacker", tid("treason-at-the-gate"), rng);
    const mods = getModifiers(s2, "siege_mod", { faction: Faction.OTTOMAN, provinceId: "constantinople" });
    expect(mods.some((m) => m.data?.autoCapture === true)).toBe(true);
    expect(s2.tacticRemoved).toContain(tid("treason-at-the-gate"));
  });

  it("rejects treason against a garrison larger than maxGarrison", () => {
    // garrison 5 (> 4); siege timing is otherwise valid (started round 6).
    const s0 = treasonSetup({ round: minGameRound + 2, roundsElapsed: 2, garrison: maxGarrison + 1 });
    expect(() => queueTactic(s0, "b1", "attacker", tid("treason-at-the-gate"))).toThrow(/garrison/);
    // Enforced at play time too (before the card's cost is charged).
    expect(() =>
      playTactic(s0, s0.pendingBattles[0], "attacker", tid("treason-at-the-gate"), rng),
    ).toThrow(/garrison/);
  });

  it("rejects treason when the siege clock started before minGameRound", () => {
    // round 6, elapsed 2 → siege started round 4 (< 6); garrison 3 (<= 4).
    const s0 = treasonSetup({ round: minGameRound, roundsElapsed: 2, garrison: maxGarrison - 1 });
    expect(() => queueTactic(s0, "b1", "attacker", tid("treason-at-the-gate"))).toThrow(/round/);
    expect(() =>
      playTactic(s0, s0.pendingBattles[0], "attacker", tid("treason-at-the-gate"), rng),
    ).toThrow(/round/);
  });

  it("allows a non-treason card without invoking the siege gate", () => {
    // veterans-of-the-border on the same siege battle: no garrison/clock check.
    let s0 = treasonSetup({ round: 2, roundsElapsed: 0, garrison: maxGarrison + 3 });
    s0 = withHand(s0, "p2", ["veterans-of-the-border"]);
    const s1 = queueTactic(s0, "b1", "attacker", tid("veterans-of-the-border"));
    expect(s1.pendingBattles[0].attackerTactics).toEqual([tid("veterans-of-the-border")]);
  });
});

describe("playSiegeTactic — B3 target mode 2 (siege cards vs an active SiegeState)", () => {
  /**
   * p1 (Byzantium) besieges Ottoman sofia (INLAND — no sea resupply) with a
   * SIEGE-only army (no storming troops → no assault, isolating the grain /
   * casualty deltas). Sofia holds a 2-unit garrison and `grainStores` stores.
   */
  function sofiaSiege(grainStores: number): GameState {
    let s = fresh();
    s = {
      ...s,
      provinces: s.provinces.map((p) =>
        p.id === "sofia" ? { ...p, garrison: 2 } : p,
      ),
      armies: [
        ...s.armies,
        {
          id: "a-besieger",
          ownerId: "p1",
          locationId: "sofia",
          units: { ...emptyUnits(), [UnitType.SIEGE]: 2 },
        },
      ],
      siegeStates: [
        {
          provinceId: "sofia",
          besiegerId: "p1",
          besiegingArmyIds: ["a-besieger"],
          roundsElapsed: 1,
          grainStores,
          breached: false,
          circumvallated: true,
        },
      ],
    };
    return s;
  }

  const besiegerTotal = (s: GameState): number => {
    const a = s.armies.find((x) => x.id === "a-besieger");
    return a ? Object.values(a.units).reduce((n, c) => n + c, 0) : 0;
  };

  it("night-sortie CONSUMPTION: same seed, with-card vs without — depletion halted, besieger loses 1 unit", () => {
    const s0 = sofiaSiege(1);

    // Control (no card): the round depletes 1 store; the besieger is untouched.
    const control = resolveSiege(s0, s0.siegeStates[0], makeRng(7)).state;
    expect(control.siegeStates[0]?.grainStores).toBe(0);
    expect(besiegerTotal(control)).toBe(2);

    // With night-sortie played by the BESIEGED OWNER (p2) against the SiegeState
    // — no PendingBattle exists (B3 siege target mode).
    const held = withHand(s0, "p2", ["night-sortie"]);
    const played = playSiegeTactic(held, "p2", "sofia", tid("night-sortie"));
    expect(player(played, "p2").tacticHand).toEqual([]);
    expect(played.tacticDiscard).toContain(tid("night-sortie"));

    const relieved = resolveSiege(played, played.siegeStates[0], makeRng(7)).state;
    // §7.7: "no store depletion or hunger loss; instead the besieger loses 1 unit".
    expect(relieved.siegeStates[0]?.grainStores).toBe(1); // NOT depleted
    expect(besiegerTotal(relieved)).toBe(1); // besieger lost 1 (weakest first)
  });

  it("sails-from-the-west CONSUMPTION: restores 2 depleted grain stores", () => {
    // p2 besieges coastal constantinople (p1); stores fully depleted.
    let s0 = fresh();
    s0 = {
      ...s0,
      provinces: s0.provinces.map((p) =>
        p.id === "constantinople" ? { ...p, garrison: 2 } : p,
      ),
      armies: [
        ...s0.armies,
        {
          id: "a-besieger",
          ownerId: "p2",
          locationId: "constantinople",
          units: { ...emptyUnits(), [UnitType.SIEGE]: 1 },
        },
      ],
      siegeStates: [
        {
          provinceId: "constantinople",
          besiegerId: "p2",
          besiegingArmyIds: ["a-besieger"],
          roundsElapsed: 1,
          grainStores: 0,
          breached: false,
          circumvallated: true,
        },
      ],
    };

    const control = resolveSiege(s0, s0.siegeStates[0], makeRng(3)).state;
    expect(control.siegeStates[0]?.grainStores).toBe(0);

    const held = withHand(s0, "p1", ["sails-from-the-west"]);
    const played = playSiegeTactic(held, "p1", "constantinople", tid("sails-from-the-west"));
    const relieved = resolveSiege(played, played.siegeStates[0], makeRng(3)).state;
    expect(relieved.siegeStates[0]?.grainStores).toBe(2); // §7.7 "restore 2 depleted grain stores"
  });

  it("treason-at-the-gate via siegeProvinceId: pays 4 gold, lands the autoCapture siege_mod, removed from game", () => {
    // Siege began at round 6 (round 8, elapsed 2), garrison 3 — both DELTA-1 gates pass.
    let s0 = fresh();
    s0 = {
      ...s0,
      round: TREASON_GATE.minGameRound + 2,
      provinces: s0.provinces.map((p) =>
        p.id === "constantinople" ? { ...p, garrison: 3 } : p,
      ),
      players: s0.players.map((p) =>
        p.id === "p2" ? { ...p, treasury: { ...p.treasury, gold: 20 } } : p,
      ),
      siegeStates: [
        {
          provinceId: "constantinople",
          besiegerId: "p2",
          besiegingArmyIds: ["a2"],
          roundsElapsed: 2,
          grainStores: 0,
          breached: false,
          circumvallated: true,
        },
      ],
    };
    const held = withHand(s0, "p2", ["treason-at-the-gate"]);
    const s1 = playSiegeTactic(held, "p2", "constantinople", tid("treason-at-the-gate"));
    expect(player(s1, "p2").treasury.gold).toBe(16); // printed 4-gold cost paid
    const mods = getModifiers(s1, "siege_mod", {
      faction: Faction.OTTOMAN,
      provinceId: "constantinople",
    });
    expect(mods.some((m) => m.data?.autoCapture === true)).toBe(true);
    expect(s1.tacticRemoved).toContain(tid("treason-at-the-gate"));
    expect(player(s1, "p2").tacticHand).toEqual([]);
  });

  it("enforces the DELTA-1 treason gates on the siege path too", () => {
    const base = (garrison: number, round: number, elapsed: number): GameState => {
      let s = withHand(fresh(), "p2", ["treason-at-the-gate"]);
      s = {
        ...s,
        round,
        provinces: s.provinces.map((p) =>
          p.id === "constantinople" ? { ...p, garrison } : p,
        ),
        players: s.players.map((p) =>
          p.id === "p2" ? { ...p, treasury: { ...p.treasury, gold: 20 } } : p,
        ),
        siegeStates: [
          {
            provinceId: "constantinople",
            besiegerId: "p2",
            besiegingArmyIds: ["a2"],
            roundsElapsed: elapsed,
            grainStores: 0,
            breached: false,
            circumvallated: true,
          },
        ],
      };
      return s;
    };
    // Garrison brake (5 > 4).
    expect(() =>
      playSiegeTactic(base(TREASON_GATE.maxGarrison + 1, TREASON_GATE.minGameRound + 2, 2), "p2", "constantinople", tid("treason-at-the-gate")),
    ).toThrow(/garrison/);
    // Clock brake (siege started round 4 < 6).
    expect(() =>
      playSiegeTactic(base(3, TREASON_GATE.minGameRound, 2), "p2", "constantinople", tid("treason-at-the-gate")),
    ).toThrow(/round/);
  });

  it("rejects wrong modes, wrong sides and missing sieges", () => {
    const s0 = sofiaSiege(1);
    // A battle card cannot use the siege path.
    const battleHeld = withHand(s0, "p1", ["veterans-of-the-border"]);
    expect(() =>
      playSiegeTactic(battleHeld, "p1", "sofia", tid("veterans-of-the-border")),
    ).toThrow(/not siege-scoped/);
    // night-sortie is defender-only: the BESIEGER may not play it.
    const wrongSide = withHand(s0, "p1", ["night-sortie"]);
    expect(() => playSiegeTactic(wrongSide, "p1", "sofia", tid("night-sortie"))).toThrow(
      /defender/,
    );
    // No active siege at the named province.
    const noSiege = withHand({ ...s0, siegeStates: [] }, "p2", ["night-sortie"]);
    expect(() => playSiegeTactic(noSiege, "p2", "sofia", tid("night-sortie"))).toThrow(
      /no active siege/,
    );
  });
});

describe("playGlobalTactic — B3 target mode 3 (global/immediate cards)", () => {
  it("papal-indulgence CONSUMPTION: 2 gold actually becomes 3 faith (state delta)", () => {
    const s0 = withHand(fresh(), "p1", ["papal-indulgence"]);
    const before = player(s0, "p1").treasury;
    const s1 = playGlobalTactic(s0, "p1", tid("papal-indulgence"));
    const after = player(s1, "p1").treasury;
    expect(after.gold).toBe(before.gold - 2); // printed cost paid
    expect(after.faith).toBe(before.faith + 3); // the sole gold→faith conversion lands
    expect(player(s1, "p1").tacticHand).toEqual([]);
    expect(s1.tacticDiscard).toContain(tid("papal-indulgence"));
  });

  it("grain-barges-of-the-danube adds 2 grain immediately", () => {
    const s0 = withHand(fresh(), "p1", ["grain-barges-of-the-danube"]);
    const before = player(s0, "p1").treasury.grain;
    const s1 = playGlobalTactic(s0, "p1", tid("grain-barges-of-the-danube"));
    expect(player(s1, "p1").treasury.grain).toBe(before + 2);
  });

  it("the-pay-chest-taken transfers gold via the global path (rival target)", () => {
    let s0 = withHand(fresh(), "p1", ["the-pay-chest-taken"]);
    s0 = {
      ...s0,
      players: s0.players.map((p) =>
        p.id === "p2" ? { ...p, treasury: { ...p.treasury, gold: 5 } } : p,
      ),
    };
    const thiefBefore = player(s0, "p1").treasury.gold;
    const s1 = playGlobalTactic(s0, "p1", tid("the-pay-chest-taken"), { targetPlayerId: "p2" });
    expect(player(s1, "p2").treasury.gold).toBe(2); // 5 − 3
    expect(player(s1, "p1").treasury.gold).toBe(thiefBefore + 3);
  });

  it("ears-in-the-bazaar reveals the rival's hand in the play log (and requires a rival)", () => {
    let s0 = withHand(fresh(), "p1", ["ears-in-the-bazaar"]);
    s0 = withHand(s0, "p2", ["greek-fire", "night-sortie"]);
    const s1 = playGlobalTactic(s0, "p1", tid("ears-in-the-bazaar"), { targetPlayerId: "p2" });
    const entry = s1.log.at(-1);
    expect(entry?.data?.revealedHand).toEqual([tid("greek-fire"), tid("night-sortie")]);
    expect(entry?.data?.revealedTo).toBe("p1");
    // Rival hand untouched; the peek card itself discarded.
    expect(player(s1, "p2").tacticHand).toEqual([tid("greek-fire"), tid("night-sortie")]);
    expect(s1.tacticDiscard).toContain(tid("ears-in-the-bazaar"));
    // Target mandatory.
    expect(() => playGlobalTactic(s0, "p1", tid("ears-in-the-bazaar"))).toThrow(/rival/);
  });

  it("chain-across-the-horn shields an OWNED COASTAL province (amphibiousImmune wall_mod)", () => {
    const s0 = withHand(fresh(), "p1", ["chain-across-the-horn"]);
    const s1 = playGlobalTactic(s0, "p1", tid("chain-across-the-horn"), {
      targetProvinceId: "constantinople",
    });
    const mods = getModifiers(s1, "wall_mod", {
      faction: Faction.BYZANTIUM,
      provinceId: "constantinople",
    });
    expect(mods.some((m) => m.data?.amphibiousImmune === true)).toBe(true);
    // A rival-held province is rejected; so is a missing target.
    expect(() =>
      playGlobalTactic(s0, "p1", tid("chain-across-the-horn"), { targetProvinceId: "bursa" }),
    ).toThrow(/holds/);
    expect(() => playGlobalTactic(s0, "p1", tid("chain-across-the-horn"))).toThrow(/target/);
  });

  it("a-death-in-the-palace posts a truce binding BOTH named parties", () => {
    const s0 = withHand(fresh(), "p1", ["a-death-in-the-palace"]);
    const s1 = playGlobalTactic(s0, "p1", tid("a-death-in-the-palace"), {
      targetPlayerId: "p2",
    });
    const truces = getModifiers(s1, "truce");
    expect(truces).toHaveLength(1);
    expect(truces[0].data?.parties).toEqual(["p1", "p2"]);
    expect(truces[0].scope).toBe("round");
    // "Name one rival" — target mandatory, and never yourself.
    expect(() => playGlobalTactic(s0, "p1", tid("a-death-in-the-palace"))).toThrow(/rival/);
    expect(() =>
      playGlobalTactic(s0, "p1", tid("a-death-in-the-palace"), { targetPlayerId: "p1" }),
    ).toThrow(/yourself/);
  });

  it("holy-war-proclaimed pays 2 faith and reaches EVERY battle location (faction-wide combat_mod)", () => {
    let s0 = withHand(fresh(), "p1", ["holy-war-proclaimed"]);
    s0 = {
      ...s0,
      players: s0.players.map((p) =>
        p.id === "p1" ? { ...p, treasury: { ...p.treasury, faith: 5 } } : p,
      ),
    };
    const s1 = playGlobalTactic(s0, "p1", tid("holy-war-proclaimed"));
    expect(player(s1, "p1").treasury.faith).toBe(3); // printed 2-faith cost
    // The modifier is faction-targeted with NO location, so combat's tacticMod
    // query matches it at ANY province or sea zone (§7.7 "every battle").
    const atLand = getModifiers(s1, "combat_mod", {
      faction: Faction.BYZANTIUM,
      provinceId: "sofia",
    });
    const atSea = getModifiers(s1, "combat_mod", {
      faction: Faction.BYZANTIUM,
      seaZoneId: "aegean",
    });
    expect(atLand.some((m) => m.value === 1 && m.data?.dice === true)).toBe(true);
    expect(atSea.some((m) => m.value === 1 && m.data?.dice === true)).toBe(true);
  });

  it("forced-march posts the Move-rider move_mod (consumed by the MOVE handler)", () => {
    const s0 = withHand(fresh(), "p1", ["forced-march"]);
    const s1 = playGlobalTactic(s0, "p1", tid("forced-march"));
    const mods = getModifiers(s1, "move_mod", { faction: Faction.BYZANTIUM });
    expect(mods).toHaveLength(1);
    expect(mods[0].data).toMatchObject({ moveBonus: 1, noSiege: true, noAssault: true });
  });

  it("rejects engagement-scoped cards on the global path (B3 wrong target mode)", () => {
    const battleHeld = withHand(fresh(), "p1", ["veterans-of-the-border"]);
    expect(() => playGlobalTactic(battleHeld, "p1", tid("veterans-of-the-border"))).toThrow(
      /battle-scoped/,
    );
    const siegeHeld = withHand(fresh(), "p1", ["night-sortie"]);
    expect(() => playGlobalTactic(siegeHeld, "p1", tid("night-sortie"))).toThrow(
      /siege-scoped/,
    );
  });

  it("persists the rng cursor (determinism convention §4)", () => {
    const s0 = withHand(fresh(), "p1", ["the-counting-house"]);
    const s1 = playGlobalTactic(s0, "p1", tid("the-counting-house"));
    expect(typeof s1.rngCursor).toBe("number");
    expect(s1.rngCursor).toBeGreaterThanOrEqual(s0.rngCursor);
  });
});
