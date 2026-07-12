/**
 * Minimal in-game control surface (spec §6). No action UI exists anywhere in
 * the repo yet; without this the game could not progress. Shows round, phase,
 * active seat (+ bot "thinking…" pulse), the viewer's remaining actions and
 * gold; offers PASS, END PHASE and the free SET_TAX action. Richer actions
 * (recruit/move/build/…) are out of scope v1.
 *
 * The dispatcher overwrites action.player with the viewer seat id, so all
 * submissions pass player: "" (spec §4.5).
 */
import { useEffect, useState } from "react";
import { GamePhase, TaxPosture, type GameState } from "@imperium/shared";
import { useOfflineDispatcher } from "../dispatcherContext";
import { OFFLINE_EVENTS, type BotStatusPayload } from "../types";

const ACTION_WINDOW: readonly GamePhase[] = [
  GamePhase.RECRUITMENT,
  GamePhase.MOVEMENT,
  GamePhase.DIPLOMACY,
];

interface OfflineActionBarProps {
  /** Viewer-projected state (same object OfflineApp hands to GameBoard). */
  state: GameState;
}

export function OfflineActionBar({ state }: OfflineActionBarProps) {
  const { dispatcher, viewerSeatId } = useOfflineDispatcher();
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [thinkingBot, setThinkingBot] = useState<BotStatusPayload | null>(null);

  useEffect(() => {
    const onRejected = ({ reason }: { reason: string }) => setInlineError(reason);
    const onErrorMsg = ({ message }: { message: string }) => setInlineError(message);
    // Any successful state transition clears the last rejection.
    const onStateUpdate = () => setInlineError(null);
    const onBotStatus = (payload: BotStatusPayload) => {
      setThinkingBot((prev) =>
        payload.thinking
          ? payload
          : prev && prev.seatId === payload.seatId
            ? null
            : prev,
      );
    };
    dispatcher.on(OFFLINE_EVENTS.ACTION_REJECTED, onRejected);
    dispatcher.on(OFFLINE_EVENTS.ERROR_MSG, onErrorMsg);
    dispatcher.on(OFFLINE_EVENTS.STATE_UPDATE, onStateUpdate);
    dispatcher.on(OFFLINE_EVENTS.BOT_STATUS, onBotStatus);
    return () => {
      dispatcher.off(OFFLINE_EVENTS.ACTION_REJECTED, onRejected);
      dispatcher.off(OFFLINE_EVENTS.ERROR_MSG, onErrorMsg);
      dispatcher.off(OFFLINE_EVENTS.STATE_UPDATE, onStateUpdate);
      dispatcher.off(OFFLINE_EVENTS.BOT_STATUS, onBotStatus);
    };
  }, [dispatcher]);

  const activeSeatId = state.turnOrder[state.activePlayerIndex] ?? "";
  const seats = dispatcher.getSeats();
  const activeSeat = seats.find((s) => s.id === activeSeatId);
  const viewer = state.players.find((p) => p.id === viewerSeatId);
  const isViewerTurn = activeSeatId === viewerSeatId;
  const inActionWindow = ACTION_WINDOW.includes(state.phase);

  return (
    <div className="imp-panel offline-actionbar">
      <div className="imp-row" style={{ justifyContent: "flex-start" }}>
        <span>
          <strong>Round {state.round}</strong> · {state.phase}
        </span>
        <span>
          Active: <strong>{activeSeat?.name ?? activeSeatId}</strong>
          {activeSeat?.kind === "bot" && thinkingBot ? " — thinking…" : ""}
        </span>
        {viewer && (
          <span>
            You: {viewer.actionsRemaining} action
            {viewer.actionsRemaining === 1 ? "" : "s"} · {viewer.treasury.gold}g
          </span>
        )}
      </div>
      <div className="imp-row" style={{ justifyContent: "flex-start" }}>
        <button
          disabled={!isViewerTurn || !inActionWindow}
          onClick={() => dispatcher.submit({ type: "PASS", player: "" })}
        >
          Pass
        </button>
        <button
          className="ghost"
          onClick={() => dispatcher.submit({ type: "ADVANCE_PHASE" })}
        >
          End Phase
        </button>
        {viewer && (
          <label className="imp-row" style={{ gap: "0.4rem" }}>
            <span>Tax</span>
            <select
              value={viewer.tax}
              onChange={(e) =>
                dispatcher.submit({
                  type: "SET_TAX",
                  player: "",
                  posture: e.target.value as TaxPosture,
                })
              }
            >
              {Object.values(TaxPosture).map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0) + t.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        )}
        {inlineError && <span className="imp-error">{inlineError}</span>}
      </div>
    </div>
  );
}
