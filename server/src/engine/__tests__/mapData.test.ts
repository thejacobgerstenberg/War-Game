/**
 * mapData.test.ts — canonical-board registry guards (docs/MAP.md §3).
 *
 * Marshal review of PR #10 flagged two provinces whose authored terrain
 * diverged from the MAP.md §3 registry:
 *  - MAJOR: `cairo` authored DESERT, registry says **city** (Mamluk capital,
 *    T2 walls, HV(3)). As DESERT it could never be besieged — actions.ts keys
 *    `isSiege` on `TerrainType.CITY` — and lost every city behaviour.
 *  - MINOR: `tunis` authored DESERT, registry says **coast** (Hafsid corsair
 *    nest, coastal Y, T1).
 *
 * These tests lock the registry alignment AND (per the marshal's meta note on
 * posting-only assertions) exercise the real OUTCOME delta: marching on a
 * garrisoned Cairo now queues a PendingBattle with `isSiege: true`, and a
 * move-1 stack may enter it at all (CITY move cost 1; DESERT cost 2 rejected
 * mv-1 stacks with INSUFFICIENT_MOVEMENT).
 */
import { describe, it, expect } from "vitest";
import {
  Faction,
  GamePhase,
  TerrainType,
  UnitType,
  type GameState,
  type MoveAction,
} from "@imperium/shared";
import { createInitialState, emptyUnits, type SeatInput } from "../gameState.js";
import { applyAction } from "../actions.js";
import { PROVINCES } from "../mapData.js";
import {
  MAP_WALL_TIER,
  TERRAIN_MOVE_COST,
  TERRAIN_YIELDS,
  UNIT_STATS,
  WALL_TIERS,
} from "../balance.js";

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

function findProv(id: string) {
  const prov = PROVINCES.find((p) => p.id === id);
  expect(prov, `${id} missing from PROVINCES`).toBeDefined();
  return prov!;
}

// ---------------------------------------------------------------------------
// MAP.md §3 registry alignment (marshal map MAJOR: cairo; MINOR: tunis)
// ---------------------------------------------------------------------------

describe("MAP.md §3 registry — cairo (marshal map MAJOR)", () => {
  const cairo = findProv("cairo");

  it("is a CITY per the registry row (was mis-authored DESERT)", () => {
    // MAP.md §3: | `cairo` | Cairo | Levant & Egypt | city | gold | faith | N | T2 | Independent | Mamluk capital. HV(3). |
    expect(cairo.terrain).toBe(TerrainType.CITY);
    expect(cairo.port).toBe(false); // registry Port? = N
    expect(cairo.highValue).toBe(3); // HV(3)
    expect(cairo.garrison).toBe(2);
  });

  it("keeps its registry T2 walls (besiegeable masonry)", () => {
    const hpTier = MAP_WALL_TIER[2];
    expect(cairo.walls.tier).toBe(hpTier);
    expect(cairo.walls.hp).toBe(WALL_TIERS[hpTier].hp);
    expect(cairo.walls.hp).toBeGreaterThan(0); // walls.hp>0 is half the isSiege gate
  });

  it("yields = CITY base (balance.TERRAIN_YIELDS) + HV(3) bonuses (+1g/+1grain/+1faith), like the other HV(3) cities", () => {
    // City base gold3/faith1 + the thessalonica/trebizond HV(3) bonus shape.
    const base = TERRAIN_YIELDS[TerrainType.CITY];
    expect(cairo.yields).toEqual({
      gold: base.gold + 1,
      grain: base.grain + 1,
      timber: 0,
      marble: 0,
      faith: base.faith + 1,
    });
    // Pin the concrete numbers so economy fixtures stay honest: 4/1/0/0/2.
    expect(cairo.yields).toEqual({ gold: 4, grain: 1, timber: 0, marble: 0, faith: 2 });
    // Same authored totals as its HV(3) CITY siblings.
    expect(findProv("thessalonica").yields).toEqual(cairo.yields);
    expect(findProv("trebizond").yields).toEqual(cairo.yields);
  });
});

describe("MAP.md §3 registry — tunis (marshal map MINOR)", () => {
  const tunis = findProv("tunis");

  it("is COAST per the registry row (was mis-authored DESERT)", () => {
    // MAP.md §3: | `tunis` | Tunis | Western Mediterranean | coast | gold | grain | Y | T1 | Independent | Hafsid corsair nest. |
    expect(tunis.terrain).toBe(TerrainType.COAST);
    expect(tunis.port).toBe(true); // registry Port? = Y
    expect(tunis.garrison).toBe(1);
    const hpTier = MAP_WALL_TIER[1]; // registry T1
    expect(tunis.walls.tier).toBe(hpTier);
    expect(tunis.walls.hp).toBe(WALL_TIERS[hpTier].hp);
  });

  it("yields = COAST base + corsair +1 gold (registry primary gold, secondary grain)", () => {
    const base = TERRAIN_YIELDS[TerrainType.COAST];
    expect(tunis.yields).toEqual({
      gold: base.gold + 1,
      grain: base.grain,
      timber: 0,
      marble: 0,
      faith: 0,
    });
    expect(tunis.yields).toEqual({ gold: 2, grain: 1, timber: 0, marble: 0, faith: 0 });
  });
});

// ---------------------------------------------------------------------------
// OUTCOME delta: Cairo is now besiegeable (the behaviour the DESERT
// mis-authoring destroyed) — assert the engine's real state change, not data.
// ---------------------------------------------------------------------------

describe("cairo city behaviours (engine outcome of the terrain fix)", () => {
  function stateWithArmyAtAleppo(): GameState {
    const s = structuredClone(createInitialState("ROOM01", seats, 42));
    s.phase = GamePhase.MOVEMENT;
    // Make p2 the acting seat regardless of turn-order enforcement.
    s.activePlayerIndex = Math.max(0, s.turnOrder.indexOf("p2"));
    const p2 = s.players.find((p) => p.id === "p2")!;
    p2.actionsRemaining = 4;
    // A move-1 stack (INFANTRY mv1): under the old DESERT authoring (move
    // cost 2) this stack could not even ENTER cairo.
    s.armies.push({
      id: "army-p2-aleppo",
      ownerId: "p2",
      locationId: "aleppo",
      units: { ...emptyUnits(), [UnitType.INFANTRY]: 2 },
    });
    return s;
  }

  it("marching on garrisoned Cairo queues a PendingBattle with isSiege: true", () => {
    const s = stateWithArmyAtAleppo();
    const battlesBefore = s.pendingBattles.length;

    const action: MoveAction = {
      type: "MOVE",
      player: "p2",
      stackId: "army-p2-aleppo",
      toId: "cairo",
    };
    const next = applyAction(s, action);

    // The attacker advanced into the tile and a SIEGE (not a field battle)
    // was queued — walls.hp>0 && terrain CITY (actions.ts isSiege gate).
    const army = next.armies.find((a) => a.id === "army-p2-aleppo")!;
    expect(army.locationId).toBe("cairo");
    expect(next.pendingBattles).toHaveLength(battlesBefore + 1);
    const battle = next.pendingBattles[next.pendingBattles.length - 1];
    expect(battle.provinceId).toBe("cairo");
    expect(battle.attackerId).toBe("p2");
    expect(battle.attackerStackIds).toContain("army-p2-aleppo");
    expect(battle.isSiege).toBe(true); // <- the marshal's map MAJOR, fixed
    // Cairo itself is untouched until COMBAT resolves: still independent,
    // garrison intact.
    const cairoNow = next.provinces.find((p) => p.id === "cairo")!;
    expect(cairoNow.ownerId).toBeNull();
    expect(cairoNow.garrison).toBe(2);
  });

  it("a move-1 stack can now ENTER Cairo (CITY move cost 1; DESERT's cost 2 rejected it)", () => {
    // The applyAction success above is the behavioural proof; pin the two
    // constants that make it so, from balance.ts (never hardcoded elsewhere).
    expect(UNIT_STATS[UnitType.INFANTRY].mv).toBe(1);
    expect(TERRAIN_MOVE_COST[TerrainType.CITY]).toBe(1);
    // DESERT itself is gone from TerrainType (nothing is authored desert after
    // the cairo/tunis registry fixes), so its cost row no longer exists to pin.
    expect((TerrainType as Record<string, string>)["DESERT"]).toBeUndefined();
  });
});
