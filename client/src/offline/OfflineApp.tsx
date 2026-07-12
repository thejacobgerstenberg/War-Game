/**
 * Offline application shell (spec §6). Replaces App.tsx's socket wiring
 * wholesale: gathers an OfflineGameConfig from the setup screens, hands it to
 * createOfflineDispatcher (Author A), and wires the dispatcher's socket-shaped
 * events (game_started / state_update / error_msg) plus the offline-only ones
 * (turn_change / bot_status / game_over) into the screen state machine.
 *
 * Screens: modeSelect -> setup -> game <-> handover -> end.
 * Hotseat privacy invariant (spec §4.7): on turn_change{requiresHandover} the
 * board is UNMOUNTED and PrivacyScreen rendered instead; the next seat's
 * projection is requested (setViewerSeat) only after its player confirms.
 */
import { useCallback, useRef, useState } from "react";
import type { GameState } from "@imperium/shared";
import { GameBoard } from "../screens/GameBoard";
import { createOfflineDispatcher } from "./dispatcher";
import { OfflineDispatcherContext } from "./dispatcherContext";
import {
  OFFLINE_EVENTS,
  type GameOverPayload,
  type OfflineDispatcher,
  type OfflineGameConfig,
  type OfflineMode,
  type TurnChangePayload,
} from "./types";
import { ModeSelect } from "./screens/ModeSelect";
import { OfflineSetup } from "./screens/OfflineSetup";
import { PrivacyScreen } from "./screens/PrivacyScreen";
import { OfflineActionBar } from "./screens/OfflineActionBar";
import { EndScreen } from "./screens/EndScreen";
import "./offline.css";

type OfflineScreen = "modeSelect" | "setup" | "game" | "handover" | "end";

export function OfflineApp() {
  const [screen, setScreen] = useState<OfflineScreen>("modeSelect");
  const [mode, setMode] = useState<OfflineMode>("hotseat");
  const [viewState, setViewState] = useState<GameState | null>(null); // always a projection
  const [viewerSeatId, setViewerSeatId] = useState<string>("");
  const [pendingHandover, setPendingHandover] =
    useState<TurnChangePayload | null>(null);
  const [result, setResult] = useState<GameOverPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ref, not state: the dispatcher is created inside an event handler and its
  // synchronous game_started must not race a setState round-trip. OfflineApp
  // is the root component and never unmounts, so no unmount cleanup is needed
  // (and none is wanted: a StrictMode dev double-effect would kill the game).
  const dispatcherRef = useRef<OfflineDispatcher | null>(null);

  const chooseMode = (m: OfflineMode) => {
    setMode(m);
    setError(null);
    setScreen("setup");
  };

  const startGame = useCallback((config: OfflineGameConfig) => {
    setError(null);
    let dispatcher: OfflineDispatcher;
    try {
      dispatcher = createOfflineDispatcher(config);
    } catch (e) {
      // Construction guard tripped (setup validation should prevent this).
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    dispatcher.on(OFFLINE_EVENTS.GAME_STARTED, ({ state }) => {
      setViewState(state);
      setError(null);
    });
    dispatcher.on(OFFLINE_EVENTS.STATE_UPDATE, ({ state }) => {
      setViewState(state);
    });
    dispatcher.on(OFFLINE_EVENTS.ERROR_MSG, ({ message }) => {
      setError(message);
    });
    dispatcher.on(OFFLINE_EVENTS.TURN_CHANGE, (payload) => {
      if (!payload.requiresHandover) return;
      setPendingHandover(payload);
      // Never regress from the end screen (game_over is terminal).
      setScreen((s) => (s === "end" ? s : "handover"));
    });
    dispatcher.on(OFFLINE_EVENTS.GAME_OVER, (payload) => {
      setResult(payload);
      setPendingHandover(null);
      setScreen("end");
    });

    dispatcherRef.current = dispatcher;
    setViewerSeatId(dispatcher.getViewerSeatId());
    setResult(null);
    setPendingHandover(null);
    setScreen("game");
    dispatcher.start(); // emits game_started synchronously -> setViewState
  }, []);

  const confirmHandover = () => {
    const dispatcher = dispatcherRef.current;
    if (!dispatcher || !pendingHandover) return;
    // Re-emits state_update projected for the new viewer BEFORE the board
    // remounts below — the old seat's projection is never rendered to B.
    dispatcher.setViewerSeat(pendingHandover.activeSeatId);
    setViewerSeatId(pendingHandover.activeSeatId);
    setPendingHandover(null);
    setScreen("game");
  };

  const newGame = () => {
    dispatcherRef.current?.destroy();
    dispatcherRef.current = null;
    setViewState(null);
    setViewerSeatId("");
    setPendingHandover(null);
    setResult(null);
    setError(null);
    setScreen("modeSelect");
  };

  switch (screen) {
    case "modeSelect":
      return (
        <ModeSelect
          onHotseat={() => chooseMode("hotseat")}
          onSolo={() => chooseMode("solo")}
        />
      );
    case "setup":
      return (
        <OfflineSetup
          mode={mode}
          error={error}
          onStart={startGame}
          onBack={() => {
            setError(null);
            setScreen("modeSelect");
          }}
        />
      );
    case "handover":
      // PrivacyScreen INSTEAD of the board (unmount, not overlay): viewState
      // still holds the PREVIOUS seat's projection here and must not render.
      return pendingHandover ? (
        <PrivacyScreen
          nextPlayerName={pendingHandover.activeSeatName}
          nextFaction={pendingHandover.activeFaction}
          onConfirm={confirmHandover}
        />
      ) : null;
    case "game": {
      const dispatcher = dispatcherRef.current;
      if (!dispatcher || !viewState) return null;
      return (
        <OfflineDispatcherContext.Provider value={{ dispatcher, viewerSeatId }}>
          <div className="offline-game">
            <OfflineActionBar state={viewState} />
            <div className="offline-board">
              <GameBoard state={viewState} />
            </div>
          </div>
        </OfflineDispatcherContext.Provider>
      );
    }
    case "end":
      return result ? <EndScreen result={result} onNewGame={newGame} /> : null;
  }
}
