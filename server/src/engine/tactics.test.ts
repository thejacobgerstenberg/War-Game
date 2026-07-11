/**
 * tactics.test.ts — the tactic-deck subsystem (draw / hold / play / resolve, §7.7).
 *
 * Covers: draw (base + University bonus) into the hidden hand; reshuffle of the
 * discard when the draw pile empties WITHOUT mixing in the removed pile; Cleanup
 * hand-limit prune; queue → play flow; greek-fire routed to `tacticRemoved` (and
 * a second card discarded) after play; and that representative cards post the
 * expected battle-/siege-scoped ActiveModifier for combat.ts to read.
 */
import { describe, it, expect } from "vitest";
import {
  BuildingType,
  Faction,
  asTacticCardId,
  type GameState,
  type PendingBattle,
  type Player,
  type TacticCardId,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "./gameState.js";
import { getModifiers } from "./modifiers.js";
import { makeRng } from "./rng.js";
import { TACTIC_HAND_LIMIT, TREASON_GATE } from "./balance.js";
import {
  drawTactic,
  discardToHandLimit,
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

  it("enforces at most one non-reaction card per side per battle round", () => {
    let s0 = withHand(fresh(), "p1", ["locked-shields", "veterans-of-the-border"]);
    s0 = { ...s0, pendingBattles: [landBattle("constantinople")] };
    const s1 = queueTactic(s0, "b1", "defender", tid("locked-shields"));
    expect(() => queueTactic(s1, "b1", "defender", tid("veterans-of-the-border"))).toThrow();
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
