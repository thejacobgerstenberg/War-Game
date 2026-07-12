/**
 * Local offline dispatcher (spec §4) — the in-page replacement for the socket
 * transport. Owns the authoritative GameState and runs the engine in-memory:
 *
 *   createInitialState -> (validate inside) applyAction -> advancePhase -> checkVictory
 *
 * exposing the exact socket-compatible event surface (game_started,
 * state_update, action_rejected, error_msg) plus three offline-only events
 * (turn_change, bot_status, game_over).
 *
 * Hidden-info discipline: EVERY state payload delivered to the UI is projected
 * for the current viewer seat via projectStateForSeat — the full state leaves
 * this module only through getAuthoritativeState() (debug/EndScreen) and
 * GameOverPayload.finalState (game over, secrets revealed).
 *
 * Determinism: the ONE permitted nondeterminism is the initial seed pick when
 * config.seed is omitted; it is stored and readable via getConfig().seed so a
 * game is reproducible from (seed, seat configs).
 */
import {
  GamePhase,
  type Faction,
  type GameAction,
  type GameState,
} from "@imperium/shared";
import {
  EngineError,
  advancePhase,
  applyAction,
  checkVictory,
  createInitialState,
  type SeatInput,
} from "./engine/index";
import { createBotRunner } from "./botRunner";
import { projectStateForSeat } from "./projection";
import {
  DEFAULT_BOT_PACING,
  MAX_PUMP_STEPS,
  MAX_BOTS_SOLO,
  MAX_SEATS,
  MIN_BOTS_SOLO,
  MIN_SEATS,
  ROUND_LIMIT,
  seatIdForIndex,
  type CreateOfflineDispatcher,
  type GameOverPayload,
  type GameOverReason,
  type OfflineBotRunner,
  type OfflineDispatcher,
  type OfflineDispatcherEvents,
  type OfflineEventName,
  type OfflineGameConfig,
  type RankingEntry,
  type SeatDescriptor,
} from "./types";

/** Phases forming the shared action window (mirrors the engine gate). */
const ACTION_WINDOW = new Set<GamePhase>([
  GamePhase.RECRUITMENT,
  GamePhase.MOVEMENT,
  GamePhase.DIPLOMACY,
]);

/** The one permitted nondeterminism (spec §4.1): fresh seed when none given. */
function freshSeed(): number {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

function validateConfig(config: OfflineGameConfig): void {
  const { mode, seats } = config;
  if (seats.length < MIN_SEATS || seats.length > MAX_SEATS) {
    throw new Error(
      `Offline game needs ${MIN_SEATS}-${MAX_SEATS} seats, got ${seats.length}`,
    );
  }
  const humans = seats.filter((s) => s.kind === "human").length;
  const botCount = seats.length - humans;
  if (mode === "hotseat" && botCount !== 0) {
    throw new Error("Hotseat mode requires every seat to be human");
  }
  if (mode === "solo") {
    if (humans !== 1) {
      throw new Error(`Solo mode requires exactly one human seat, got ${humans}`);
    }
    if (botCount < MIN_BOTS_SOLO || botCount > MAX_BOTS_SOLO) {
      throw new Error(
        `Solo mode requires ${MIN_BOTS_SOLO}-${MAX_BOTS_SOLO} bots, got ${botCount}`,
      );
    }
  }
  const factions = new Set<Faction>();
  for (const seat of seats) {
    if (!seat.faction) throw new Error(`Seat "${seat.name}" has no faction`);
    if (factions.has(seat.faction)) {
      throw new Error(`Faction ${seat.faction} picked more than once`);
    }
    factions.add(seat.faction);
  }
}

export const createOfflineDispatcher: CreateOfflineDispatcher = (
  config: OfflineGameConfig,
): OfflineDispatcher => {
  validateConfig(config);

  const seed = config.seed ?? freshSeed();
  const resolvedConfig: Readonly<OfflineGameConfig> & { seed: number } =
    Object.freeze({ ...config, seats: [...config.seats], seed });

  const seats: SeatDescriptor[] = config.seats.map((seat, i) => ({
    id: seatIdForIndex(i),
    name: seat.name,
    faction: seat.faction,
    kind: seat.kind,
    ...(seat.kind === "bot" ? { difficulty: seat.difficulty } : {}),
    turnIndex: i,
  }));
  const seatById = new Map(seats.map((s) => [s.id, s]));

  // --- event emitter (socket-shaped, local) --------------------------------
  const handlers = new Map<OfflineEventName, Set<(payload: never) => void>>();
  function emit<E extends OfflineEventName>(
    event: E,
    payload: Parameters<OfflineDispatcherEvents[E]>[0],
  ): void {
    const set = handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      (handler as (p: typeof payload) => void)(payload);
    }
  }

  // --- game state ----------------------------------------------------------
  let state: GameState | null = null;
  let started = false;
  let over = false;
  let destroyed = false;
  let viewerSeatId = seats.find((s) => s.kind === "human")!.id;
  let lastTurnKey: string | null = null;

  const botRunner: OfflineBotRunner = createBotRunner({
    gameSeed: seed,
    seats: seats.filter((s) => s.kind === "bot"),
    pacing: config.botPacing ?? DEFAULT_BOT_PACING,
    hooks: {
      getState: () => {
        if (!state) throw new Error("Bot runner started before game state exists");
        return state;
      },
      commit: (next) => commit(next),
      onStatus: (payload) => emit("bot_status", payload),
    },
  });

  // --- single commit path (spec §4.3) --------------------------------------
  function commit(next: GameState): void {
    if (destroyed || over) return;
    state = next;
    emit("state_update", { state: projectStateForSeat(next, viewerSeatId) });

    const activeSeatId = next.turnOrder[next.activePlayerIndex];
    if (activeSeatId === undefined) return;
    const turnKey = `${activeSeatId}|${next.phase}|${next.round}`;
    if (turnKey === lastTurnKey) return;
    lastTurnKey = turnKey;
    const seat = seatById.get(activeSeatId);
    const player = next.players.find((p) => p.id === activeSeatId);
    emit("turn_change", {
      activeSeatId,
      activeSeatName: seat?.name ?? activeSeatId,
      activeFaction: player?.faction ?? seat?.faction ?? null,
      phase: next.phase,
      round: next.round,
      requiresHandover:
        config.mode === "hotseat" &&
        seat?.kind === "human" &&
        activeSeatId !== viewerSeatId,
    });
  }

  // --- terminal path (spec §4.6) -------------------------------------------
  function endGame(reason: GameOverReason, winnerFaction?: Faction): void {
    if (over || destroyed || !state) return;
    over = true;
    const finalState = state;

    const ranking: RankingEntry[] = seats
      .map((seat) => {
        const player = finalState.players.find((p) => p.id === seat.id);
        return {
          seatId: seat.id,
          name: seat.name,
          faction: player?.faction ?? seat.faction ?? null,
          prestige: player?.prestige ?? 0,
          isBot: seat.kind === "bot",
        };
      })
      .sort((a, b) => {
        if (b.prestige !== a.prestige) return b.prestige - a.prestige;
        return (
          seatById.get(a.seatId)!.turnIndex - seatById.get(b.seatId)!.turnIndex
        );
      });

    let winnerSeatId: string | null = null;
    let winner: Faction | null = winnerFaction ?? null;
    if (reason === "VICTORY" && winnerFaction) {
      winnerSeatId =
        ranking.find((r) => r.faction === winnerFaction)?.seatId ?? null;
    } else if (reason === "ROUND_LIMIT") {
      winnerSeatId = ranking[0]?.seatId ?? null;
      winner = ranking[0]?.faction ?? null;
    } // STALEMATE: both stay null

    const payload: GameOverPayload = {
      reason,
      winnerFaction: winner,
      winnerSeatId,
      ranking,
      finalState, // FULL unprojected state — game over, secrets revealed
    };
    emit("game_over", payload);
  }

  // --- drive loop (spec §4.4): async, single-flight, re-entrant coalesce ----
  let pumping = false;
  let pumpQueued = false;

  async function pump(): Promise<void> {
    if (pumping) {
      pumpQueued = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpQueued = false;
        await pumpLoop();
      } while (pumpQueued && !destroyed && !over);
    } finally {
      pumping = false;
    }
  }

  async function pumpLoop(): Promise<void> {
    let steps = 0;
    for (;;) {
      if (destroyed || over || !state) return;
      if (++steps > MAX_PUMP_STEPS) {
        endGame("STALEMATE"); // hard safety — should never trip
        return;
      }
      const winner = checkVictory(state);
      if (winner !== null) {
        endGame("VICTORY", winner);
        return;
      }
      if (state.round > ROUND_LIMIT) {
        endGame("ROUND_LIMIT");
        return;
      }
      if (!ACTION_WINDOW.has(state.phase)) {
        // INCOME / COMBAT / END resolve deterministically inside the engine.
        commit(advancePhase(state));
        continue;
      }
      const activeSeatId = state.turnOrder[state.activePlayerIndex];
      const seat =
        activeSeatId !== undefined ? seatById.get(activeSeatId) : undefined;
      const activeBudget =
        state.players.find((p) => p.id === activeSeatId)?.actionsRemaining ?? 0;
      if (seat?.kind === "bot" && activeBudget > 0) {
        const result = await botRunner.runWhileBotActive();
        if (destroyed || over) return;
        if (result.status === "limit_reached") {
          endGame("STALEMATE");
          return;
        }
        continue;
      }
      // Active seat is human, OR the pointer rests on a spent seat (engine
      // pointer semantics: that means EVERY budget is spent). Try the
      // engine-gated phase advance. It succeeds only when every seat's window
      // is genuinely done (WINDOW_NOT_DONE gate), so no human turn is ever
      // skipped; while a human still holds actions we WAIT for submit().
      try {
        commit(applyAction(state, { type: "ADVANCE_PHASE" }));
        continue;
      } catch (err) {
        if (err instanceof EngineError) {
          if (err.code !== "WINDOW_NOT_DONE") {
            emit("error_msg", { message: err.message });
          }
          return; // WAIT — resume on the next successful submit()
        }
        throw err; // engine bug — fail loud
      }
    }
  }

  // --- public surface -------------------------------------------------------
  const dispatcher: OfflineDispatcher = {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as (payload: never) => void);
    },

    off(event, handler) {
      const set = handlers.get(event);
      if (!set) return;
      if (handler === undefined) set.clear();
      else set.delete(handler as (payload: never) => void);
    },

    start() {
      if (started || destroyed) return; // idempotent
      started = true;
      const seatInputs: SeatInput[] = seats.map((seat, i) => ({
        id: seat.id,
        name: seat.name,
        faction: seat.faction,
        isHost: i === 0,
      }));
      // Room code is cosmetic: the explicit seed always wins over hashSeed().
      state = createInitialState("OFFLINE", seatInputs, seed);
      emit("game_started", {
        state: projectStateForSeat(state, viewerSeatId),
      });
      void pump();
    },

    submit(action: GameAction) {
      if (!started || over || destroyed || !state) {
        emit("error_msg", { message: "Game is not in progress." });
        return;
      }
      // Force the actor: never trust the UI. The engine's OUT_OF_TURN check
      // then rejects off-turn submissions.
      const dispatched = { ...action, player: viewerSeatId } as GameAction;
      try {
        commit(applyAction(state, dispatched));
        void pump();
      } catch (err) {
        if (err instanceof EngineError) {
          // Thrown errors never mutate state (engine contract).
          emit("action_rejected", { reason: err.message, code: err.code });
          emit("error_msg", { message: err.message });
          return;
        }
        throw err; // non-EngineError = bug — fail loud
      }
    },

    setViewerSeat(seatId: string) {
      const seat = seatById.get(seatId);
      if (!seat) throw new Error(`Unknown seat id: ${seatId}`);
      viewerSeatId = seatId;
      if (state && !destroyed) {
        emit("state_update", { state: projectStateForSeat(state, seatId) });
      }
    },

    getViewerSeatId: () => viewerSeatId,
    getSeats: () => seats,
    getAuthoritativeState: () => state,
    getConfig: () => resolvedConfig,

    destroy() {
      if (destroyed) return; // safe to call twice
      destroyed = true;
      botRunner.destroy();
      handlers.clear();
    },
  };

  return dispatcher;
};
