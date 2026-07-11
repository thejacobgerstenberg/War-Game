/**
 * roundLoop.test.ts — the phase/turn state machine (§10 turn structure, §13
 * prestige/victory). roundLoop was flagged SHAKY with no dedicated tests; this
 * file covers the wiring fixes made in this pass:
 *   - EXPIRE MODIFIERS at cleanup (round-scoped lapse, persistent survive).
 *   - PRESTIGE RESET of `prestigeThisRound` at the head of each round (INCOME).
 *   - TACTIC draw at Income + discard-to-limit at Cleanup (§7.7).
 *   - prestige_pending consumed (scorePrestige) THEN expired — no double-count.
 *   - era flip at rounds 6 and 11 (§10 era boundaries).
 *   - round-16 termination sets a winner (§13.3).
 *   - merc market refresh each round (§6.3) and full-round determinism (§14).
 */
import { describe, it, expect } from "vitest";
import {
  Faction,
  GamePhase,
  type ActiveModifier,
  type GameState,
  type TacticCardId,
} from "@imperium/shared";
import { asTacticCardId } from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { advancePhase, eraForRound } from "../roundLoop.js";

const seats: SeatInput[] = [
  { id: "p1", name: "Basil", faction: Faction.BYZANTIUM, isHost: true },
  { id: "p2", name: "Murad", faction: Faction.OTTOMAN, isHost: false },
];

/** A fresh, deterministic 2-player game (Byzantium vs Ottoman) at INCOME, r1. */
function fresh(seed = 12345): GameState {
  return structuredClone(createInitialState("ROOM01", seats, seed));
}

/** Apply `advancePhase` `n` times. */
function advanceN(s: GameState, n: number): GameState {
  let cur = s;
  for (let i = 0; i < n; i += 1) cur = advancePhase(cur);
  return cur;
}

/** One full round from INCOME back to the next round's INCOME (6 transitions). */
function fullRound(s: GameState): GameState {
  return advanceN(s, 6);
}

const p2Prestige = (s: GameState): number =>
  s.players.find((p) => p.id === "p2")!.prestige;

// ---------------------------------------------------------------------------
// eraForRound (§10 era boundaries: era1 r1–5, era2 r6–10, era3 r11–16)
// ---------------------------------------------------------------------------

describe("eraForRound (§10)", () => {
  it("maps rounds to eras and flips at 6 and 11", () => {
    expect([1, 5].map(eraForRound)).toEqual([1, 1]);
    expect([6, 10].map(eraForRound)).toEqual([2, 2]);
    expect([11, 16].map(eraForRound)).toEqual([3, 3]);
  });
});

// ---------------------------------------------------------------------------
// Phase machine (§10)
// ---------------------------------------------------------------------------

describe("advancePhase — full round (§10)", () => {
  it("walks INCOME→…→END and increments the round", () => {
    let s = fresh();
    expect(s.phase).toBe(GamePhase.INCOME);
    expect(s.round).toBe(1);
    const seen: GamePhase[] = [];
    for (let i = 0; i < 6; i += 1) {
      s = advancePhase(s);
      seen.push(s.phase);
    }
    expect(seen).toEqual([
      GamePhase.RECRUITMENT,
      GamePhase.MOVEMENT,
      GamePhase.DIPLOMACY,
      GamePhase.COMBAT,
      GamePhase.END,
      GamePhase.INCOME,
    ]);
    expect(s.round).toBe(2);
    expect(s.turn).toBe(2);
    expect(s.winner).toBeUndefined();
  });

  it("§10 era flips to 2 entering round 6 and to 3 entering round 11", () => {
    let s = fresh();
    s.round = 5;
    s.turn = 5;
    s.era = 1;
    s = fullRound(s);
    expect(s.round).toBe(6);
    expect(s.era).toBe(2);

    s.round = 10;
    s.turn = 10;
    s.era = 2;
    s = fullRound(s);
    expect(s.round).toBe(11);
    expect(s.era).toBe(3);
  });

  it("§13.3 round-16 cleanup terminates and sets a winner", () => {
    let s = fresh();
    s.round = 16;
    s.turn = 16;
    s.era = 3;
    // INCOME→RECRUITMENT→MOVEMENT→DIPLOMACY→COMBAT→END (6th call runs the END case).
    s = advanceN(s, 6);
    expect(s.phase).toBe(GamePhase.END);
    expect(s.round).toBe(16); // does NOT roll over
    expect(s.winner).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PRESTIGE RESET (flagged bug) — §13
// ---------------------------------------------------------------------------

describe("prestigeThisRound reset (§13)", () => {
  it("clears the per-round scratch at the head of each round (INCOME)", () => {
    const s = fresh();
    s.players.forEach((p) => (p.prestigeThisRound = 99)); // stale carry-over
    const after = advancePhase(s); // INCOME → RECRUITMENT resets it
    for (const p of after.players) expect(p.prestigeThisRound).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EXPIRE MODIFIERS at cleanup (flagged bug) — §10 phase 5
// ---------------------------------------------------------------------------

describe("expire modifiers at cleanup (§10)", () => {
  it("drops a round-scoped modifier after one round; a persistent one survives", () => {
    const s = fresh();
    const rnd: ActiveModifier = { id: "rnd", scope: "round", kind: "combat_mod", value: 1 };
    const persist: ActiveModifier = {
      id: "persist",
      scope: "persistent",
      kind: "trade_mod",
      value: 2,
    };
    s.activeModifiers.push(rnd, persist);
    const after = fullRound(s); // INCOME r1 … END r1 (expire) … INCOME r2
    const ids = after.activeModifiers.map((m) => m.id);
    expect(ids).not.toContain("rnd"); // round-scoped lapsed at cleanup
    expect(ids).toContain("persist"); // persistent trade route survived
  });
});

// ---------------------------------------------------------------------------
// prestige_pending: consumed by scorePrestige THEN expired — no double count
// (CONTRACT2 §12.8, §13.1)
// ---------------------------------------------------------------------------

describe("prestige_pending consumed then expired (§13.1)", () => {
  const AWARD = 5;

  const withPending = (s: GameState): GameState => {
    s.activeModifiers.push({
      id: "pp",
      scope: "round",
      kind: "prestige_pending",
      value: AWARD,
      target: { faction: Faction.OTTOMAN },
      data: { reason: "decisiveBattle" },
    });
    return s;
  };

  it("scores the award exactly once and removes the modifier", () => {
    const s = withPending(fresh());
    const after = fullRound(s);
    // Consumed AND expired — never present to be re-scored next round.
    expect(after.activeModifiers.some((m) => m.kind === "prestige_pending")).toBe(false);
  });

  it("does not double-count the award on the following round", () => {
    // A/B differential over TWO rounds from the SAME seed: the only difference
    // is the injected prestige_pending, so p2's final-prestige gap isolates it.
    // Consumed once ⇒ gap == AWARD; a re-score bug (not expired) ⇒ gap == 2*AWARD.
    const withoutPending = p2Prestige(fullRound(fullRound(fresh())));
    const withOne = p2Prestige(fullRound(fullRound(withPending(fresh()))));
    expect(withOne - withoutPending).toBe(AWARD);
  });
});

// ---------------------------------------------------------------------------
// TACTIC draw at Income / discard-to-limit at Cleanup (§7.7)
// ---------------------------------------------------------------------------

describe("tactic draw + discard (§7.7)", () => {
  it("each player draws 1 tactic card during Income", () => {
    const s = fresh();
    expect(s.players.every((p) => (p.tacticHand ?? []).length === 0)).toBe(true);
    const after = advancePhase(s); // INCOME processing (Omen → tactic draw → income)
    for (const p of after.players) expect((p.tacticHand ?? []).length).toBe(1);
    // Draw came off the shared 48-card deck (2 players → 2 fewer, minus any drawn).
    expect((after.tacticDeck ?? []).length).toBe((s.tacticDeck ?? []).length - 2);
  });

  it("discards down to the hand limit (4) at Cleanup", () => {
    // TACTIC_HAND_LIMIT = 4 per balance §2 transcription (PR #11 @203a881, §2.9).
    const s = fresh();
    const fakes = ["a", "b", "c", "d", "e"].map((x) => asTacticCardId(x)) as TacticCardId[];
    s.players.find((p) => p.id === "p1")!.tacticHand = [...fakes]; // 5 pre-held
    const after = fullRound(s); // INCOME draws +1 (→6), END prunes to 4
    const hand = after.players.find((p) => p.id === "p1")!.tacticHand ?? [];
    expect(hand.length).toBe(4);
    // Overflow went onto the discard pile (nothing removed-from-game here).
    expect((after.tacticDiscard ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Merc market refresh each round (§6.3)
// ---------------------------------------------------------------------------

describe("merc market refresh (§6.3)", () => {
  it("seeds the market when a new round begins", () => {
    const s = fresh();
    expect(s.mercMarket).toHaveLength(0); // empty at game start
    const after = fullRound(s); // END → refreshMercMarket → INCOME r2
    expect(after.mercMarket.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism (§14) — same seed + same script → identical state
// ---------------------------------------------------------------------------

describe("determinism (§14)", () => {
  it("two full rounds from the same seed produce identical state", () => {
    const run = (): GameState => fullRound(fullRound(fresh(4242)));
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
