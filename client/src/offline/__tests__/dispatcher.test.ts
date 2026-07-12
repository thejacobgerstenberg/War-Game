/**
 * Offline dispatcher acceptance tests (spec §8):
 *  1. solo 1-bot game (pacing "instant") reaches game_over or round > 1 without hang;
 *  2. hotseat handover event fires (requiresHandover) and setViewerSeat re-projects;
 *  3. projection hides rival hidden info (hands/objectives/decks/rng).
 */
import { describe, expect, it } from "vitest";
import { Faction, GamePhase, type GameState } from "@imperium/shared";
import { createInitialState } from "../engine/index";
import { projectStateForSeat } from "../projection";
import { createOfflineDispatcher } from "../dispatcher";
import {
  HIDDEN_CARD_ID,
  type GameOverPayload,
  type OfflineGameConfig,
  type TurnChangePayload,
} from "../types";

const ACTION_WINDOW = new Set<GamePhase>([
  GamePhase.RECRUITMENT,
  GamePhase.MOVEMENT,
  GamePhase.DIPLOMACY,
]);

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createOfflineDispatcher", () => {
  it("solo vs one EASY bot progresses (game_over or round > 1) without hanging", async () => {
    const config: OfflineGameConfig = {
      mode: "solo",
      seats: [
        { kind: "human", name: "Ada", faction: Faction.BYZANTIUM },
        { kind: "bot", name: "Bot", faction: Faction.OTTOMAN, difficulty: "EASY" },
      ],
      seed: 12345,
      botPacing: "instant",
    };
    const dispatcher = createOfflineDispatcher(config);
    expect(dispatcher.getConfig().seed).toBe(12345);
    expect(dispatcher.getViewerSeatId()).toBe("seat-1");

    let result: GameOverPayload | null = null;
    dispatcher.on("game_over", (payload) => {
      result = payload;
    });
    dispatcher.start();
    dispatcher.start(); // idempotent — must not double-create

    // Drive the human seat: PASS whenever seat-1 is active inside the window.
    for (let i = 0; i < 20_000; i += 1) {
      if (result !== null) break;
      const s = dispatcher.getAuthoritativeState();
      if (s !== null && s.round > 2) break;
      if (
        s !== null &&
        ACTION_WINDOW.has(s.phase) &&
        s.turnOrder[s.activePlayerIndex] === "seat-1"
      ) {
        dispatcher.submit({ type: "PASS", player: "" });
      }
      await tick();
    }

    const finalRound =
      result !== null
        ? (result as GameOverPayload).finalState.round
        : dispatcher.getAuthoritativeState()!.round;
    expect(result !== null || finalRound > 1).toBe(true);
    dispatcher.destroy();
    dispatcher.destroy(); // safe to call twice
  });

  it("hotseat: turn_change with requiresHandover fires and setViewerSeat re-projects", async () => {
    const config: OfflineGameConfig = {
      mode: "hotseat",
      seats: [
        { kind: "human", name: "Ada", faction: Faction.VENICE },
        { kind: "human", name: "Bea", faction: Faction.GENOA },
      ],
      seed: 777,
      botPacing: "instant",
    };
    const dispatcher = createOfflineDispatcher(config);
    const turnChanges: TurnChangePayload[] = [];
    const stateUpdates: GameState[] = [];
    dispatcher.on("turn_change", (payload) => turnChanges.push(payload));
    dispatcher.on("state_update", (payload) => stateUpdates.push(payload.state));
    dispatcher.start();
    await tick();

    // seat-1 passes its window; seat-2 (human, not the viewer) becomes active.
    let handover: TurnChangePayload | undefined;
    for (let i = 0; i < 100 && handover === undefined; i += 1) {
      const s = dispatcher.getAuthoritativeState()!;
      if (
        ACTION_WINDOW.has(s.phase) &&
        s.turnOrder[s.activePlayerIndex] === "seat-1"
      ) {
        dispatcher.submit({ type: "PASS", player: "" });
      }
      handover = turnChanges.find((t) => t.requiresHandover);
      await tick();
    }

    expect(handover).toBeDefined();
    expect(handover!.activeSeatId).toBe("seat-2");
    expect(handover!.activeSeatName).toBe("Bea");

    // Handover confirm: projection target switches to seat-2.
    const updatesBefore = stateUpdates.length;
    dispatcher.setViewerSeat("seat-2");
    expect(dispatcher.getViewerSeatId()).toBe("seat-2");
    expect(stateUpdates.length).toBe(updatesBefore + 1);
    const reprojected = stateUpdates[stateUpdates.length - 1]!;
    const auth = dispatcher.getAuthoritativeState()!;
    const authSeat2 = auth.players.find((p) => p.id === "seat-2")!;
    const projSeat2 = reprojected.players.find((p) => p.id === "seat-2")!;
    // New viewer sees their own secrets...
    expect(projSeat2.objectives).toEqual(authSeat2.objectives);
    // ...but not seat-1's.
    expect(reprojected.players.find((p) => p.id === "seat-1")!.objectives).toEqual([]);
    dispatcher.destroy();
  });

  it("projectStateForSeat hides rival hands/objectives, decks, and rng internals", () => {
    const state = createInitialState(
      "OFFLINE",
      [
        { id: "seat-1", name: "Ada", faction: Faction.BYZANTIUM, isHost: true },
        { id: "seat-2", name: "Bot", faction: Faction.OTTOMAN, isHost: false },
      ],
      42,
    );
    // Sanity: there ARE secrets to hide (objectives dealt at creation).
    const rival = state.players.find((p) => p.id === "seat-2")!;
    expect(rival.objectives.length).toBeGreaterThan(0);
    expect(state.omenDeck.length).toBeGreaterThan(0);

    const projected = projectStateForSeat(state, "seat-1");

    // Input state is never mutated.
    expect(state.players.find((p) => p.id === "seat-2")!.objectives.length)
      .toBeGreaterThan(0);
    expect(state.rngSeed).toBe(42);

    expect(projected.rngSeed).toBe(0);
    expect(projected.rngCursor).toBe(0);
    expect(projected.omenDeck).toHaveLength(state.omenDeck.length);
    expect(projected.omenDeck.every((id) => id === HIDDEN_CARD_ID)).toBe(true);
    expect(projected.omenDiscard).toEqual(state.omenDiscard); // public pile kept
    for (const era of [1, 2, 3] as const) {
      const deck = state.eraDecksRemaining[era];
      const projDeck = projected.eraDecksRemaining[era];
      if (deck === undefined) {
        expect(projDeck).toBeUndefined();
      } else {
        expect(projDeck).toHaveLength(deck.length);
        expect(projDeck!.every((id) => id === HIDDEN_CARD_ID)).toBe(true);
      }
    }
    if (state.tacticDeck !== undefined) {
      expect(projected.tacticDeck).toHaveLength(state.tacticDeck.length);
      expect(
        projected.tacticDeck!.every((id) => (id as string) === HIDDEN_CARD_ID),
      ).toBe(true);
    }

    const projRival = projected.players.find((p) => p.id === "seat-2")!;
    expect(projRival.hand).toEqual([]);
    expect(projRival.objectives).toEqual([]);
    if (rival.tacticHand !== undefined) {
      expect(projRival.tacticHand).toEqual([]);
    }
    // Viewer's own player object is untouched (same reference — structural sharing).
    expect(projected.players.find((p) => p.id === "seat-1")).toBe(
      state.players.find((p) => p.id === "seat-1"),
    );
    // Public fields survive.
    expect(projRival.prestige).toBe(rival.prestige);
    expect(projRival.treasury).toEqual(rival.treasury);
  });
});
