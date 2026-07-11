/**
 * projection.hidden-intel.test.ts — adversarial coverage for the three
 * hidden-info leaks the projection must close (docs/ARCHITECTURE.md §4.3, §5.3):
 *
 *  1. SPY LOG INTEL — `applySpy` appends actor-scoped chronicle entries flagged
 *     `data.secret`/`data.visibleTo:[spy]` carrying a RIVAL'S SECRET OBJECTIVE
 *     text (OBJECTIVE) or the undrawn top Omen card (OMEN). The projection must
 *     deliver those entries ONLY to the spy; every other seat's log omits them.
 *  2. RNG SEED / CURSOR — the seed re-derives the whole deck shuffle and every
 *     future roll, so `rngSeed`/`rngCursor` (top-level AND the seed embedded in
 *     the `game_start` log entry) must never reach a client.
 *  3. PENDING-BATTLE TACTICS — `PendingBattle.attackerTactics`/`defenderTactics`
 *     are committed-but-unrevealed; each belligerent may see only its own side's
 *     committed ids, never the opponent's.
 *
 * These exercise REAL engine output (`applySpy`) plus a hand-built pending
 * battle, then hunt the serialised projection for the secret.
 */
import { describe, it, expect } from "vitest";
import {
  Faction,
  SpyMission,
  asTacticCardId,
  type GameState,
  type PendingBattle,
  type SpyAction,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { applySpy } from "../spy.js";
import { makeRng } from "../rng.js";
import { projectStateFor } from "../projection.js";

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
  { id: "p3", name: "Janos", faction: Faction.HUNGARY, isHost: false },
];

function fresh(): GameState {
  return structuredClone(createInitialState("ROOM01", seats, 12345));
}

/** Return a copy of `state` whose RNG cursor makes the next d6 roll `desired`. */
function atRoll(state: GameState, desired: number): GameState {
  for (let c = state.rngCursor; c < state.rngCursor + 4096; c += 1) {
    if (makeRng(state.rngSeed, c).rollD6() === desired) {
      return { ...state, rngCursor: c };
    }
  }
  throw new Error(`no cursor produces a roll of ${desired}`);
}

const omen = (player: string): SpyAction => ({
  type: "SPY",
  player,
  mission: SpyMission.OMEN,
});
const objective = (player: string, targetPlayerId: string): SpyAction => ({
  type: "SPY",
  player,
  mission: SpyMission.OBJECTIVE,
  targetPlayerId,
});

describe("projection — spy intel is delivered ONLY to the acting seat", () => {
  it("OMEN: only the spy learns the top Omen card; rivals' logs omit the entry", () => {
    const s = atRoll(fresh(), 6); // roll 6 ≥ base target 3 → success
    const top = s.omenDeck[0];
    const after = applySpy(s, omen("p1"));

    // The spy (p1) sees the peek entry, with the real card id.
    const spyView = projectStateFor(after, "p1");
    const spyEntry = spyView.log.find(
      (e) => (e.data as { omenTopCardId?: string })?.omenTopCardId === top,
    );
    expect(spyEntry).toBeDefined();

    // Every other seat: the entry is GONE and the card id appears nowhere.
    for (const rival of ["p2", "p3"]) {
      const view = projectStateFor(after, rival);
      const leaked = view.log.some(
        (e) => (e.data as { omenTopCardId?: string })?.omenTopCardId === top,
      );
      expect(leaked).toBe(false);
      expect(JSON.stringify(view)).not.toContain(top);
    }
  });

  it("OBJECTIVE: a rival's secret objective text reaches only the spy", () => {
    const s = atRoll(fresh(), 6);
    const after = applySpy(s, objective("p1", "p2")); // p1 spies on p2

    // The spy (p1) sees the uncovered objective description.
    const spyView = projectStateFor(after, "p1");
    const spyEntry = spyView.log.find(
      (e) => (e.data as { objectiveDescription?: string })?.objectiveDescription,
    );
    expect(spyEntry).toBeDefined();
    const stolenDesc = (spyEntry!.data as { objectiveDescription: string })
      .objectiveDescription;
    expect(stolenDesc).toBeTruthy();

    // The victim (p2) never even learns it was spied on: the entry is absent.
    const victimView = projectStateFor(after, "p2");
    const victimSeesEntry = victimView.log.some(
      (e) =>
        (e.data as { objectiveId?: string })?.objectiveId !== undefined &&
        (e.data as { secret?: boolean })?.secret === true,
    );
    expect(victimSeesEntry).toBe(false);

    // A bystander (p3) sees neither the entry nor the objective text anywhere
    // (p3 cannot see p2's objectives, so the description must not appear at all).
    const bystanderView = projectStateFor(after, "p3");
    expect(JSON.stringify(bystanderView)).not.toContain(stolenDesc);
  });
});

describe("projection — RNG seed/cursor never reach a client", () => {
  it("redacts rngSeed/rngCursor even after a spy advanced the cursor", () => {
    const s = atRoll(fresh(), 6);
    const after = applySpy(s, omen("p1")); // consumes a cursor step
    expect(after.rngCursor).toBeGreaterThan(0);
    for (const seat of ["p1", "p2", "p3"]) {
      const view = projectStateFor(after, seat);
      expect(view.rngSeed).toBe(0);
      expect(view.rngCursor).toBe(0);
      // The literal seed value (12345) must not survive on the wire, including
      // the copy the game_start log entry recorded in its data.
      expect(JSON.stringify(view)).not.toContain("12345");
    }
  });

  it("scrubs the seed embedded in the game_start log entry", () => {
    const state = fresh();
    expect(state.log[0].type).toBe("game_start");
    expect(state.log[0].data?.seed).toBe(state.rngSeed); // engine records it
    const view = projectStateFor(state, "p1");
    expect(view.log[0].type).toBe("game_start");
    expect(view.log[0].data?.seed).toBeUndefined();
  });
});

describe("projection — committed tactics are private to each belligerent", () => {
  const withBattle = (): GameState => {
    const s = fresh();
    const battle: PendingBattle = {
      id: "b1",
      provinceId: s.provinces[0].id,
      attackerId: "p1",
      defenderId: "p2",
      attackerStackIds: ["a-atk"],
      defenderStackIds: ["a-def"],
      attackerTactics: [asTacticCardId("ATK_SECRET_1"), asTacticCardId("ATK_SECRET_2")],
      defenderTactics: [asTacticCardId("DEF_SECRET_1")],
    };
    return { ...s, pendingBattles: [battle] };
  };

  it("the attacker sees its own tactics but the defender's are hidden", () => {
    const view = projectStateFor(withBattle(), "p1");
    const b = view.pendingBattles[0];
    expect(b.attackerTactics).toEqual([
      asTacticCardId("ATK_SECRET_1"),
      asTacticCardId("ATK_SECRET_2"),
    ]);
    expect(b.defenderTactics).toEqual([asTacticCardId("hidden")]);
    expect(JSON.stringify(view)).not.toContain("DEF_SECRET_1");
  });

  it("the defender sees its own tactics but the attacker's are hidden", () => {
    const view = projectStateFor(withBattle(), "p2");
    const b = view.pendingBattles[0];
    expect(b.defenderTactics).toEqual([asTacticCardId("DEF_SECRET_1")]);
    expect(b.attackerTactics).toEqual([
      asTacticCardId("hidden"),
      asTacticCardId("hidden"),
    ]);
    const wire = JSON.stringify(view);
    expect(wire).not.toContain("ATK_SECRET_1");
    expect(wire).not.toContain("ATK_SECRET_2");
  });

  it("a non-participant (spectator seat) sees both sides hidden", () => {
    const view = projectStateFor(withBattle(), "p3");
    const b = view.pendingBattles[0];
    expect(b.attackerTactics?.every((t) => (t as string) === "hidden")).toBe(true);
    expect(b.defenderTactics?.every((t) => (t as string) === "hidden")).toBe(true);
    const wire = JSON.stringify(view);
    expect(wire).not.toContain("ATK_SECRET_1");
    expect(wire).not.toContain("DEF_SECRET_1");
    // Counts are preserved (public), identities are not.
    expect(b.attackerTactics).toHaveLength(2);
    expect(b.defenderTactics).toHaveLength(1);
  });

  it("does not mutate the authoritative pending-battle tactics (purity)", () => {
    const state = withBattle();
    const before = structuredClone(state);
    projectStateFor(state, "p1");
    projectStateFor(state, "p2");
    projectStateFor(state, "p3");
    expect(state).toEqual(before);
  });
});
