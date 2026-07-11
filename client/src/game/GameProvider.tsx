/**
 * GameProvider — the client game runtime. Owns the live GameState received
 * from the server, the turn timer, and the single dispatch() path every
 * feature uses to issue GameActions.
 *
 * Socket contract (shared/src/protocol/socket.ts):
 *   - state_update / state_snapshot  -> replace gameState (server-authoritative;
 *     the state is the fog-of-war PROJECTION for THIS player — see game/types.ts)
 *   - turn_timer                     -> live countdown {activePlayerId, deadline, turnSeconds}
 *   - action_rejected                -> error toast (code mapped to lore voice)
 *   - server_shutdown                -> persistent error toast; socket.io auto-reconnects
 *   - game_started                   -> replace state (mid-game rejoin path)
 *
 * dispatch(action, options?) emits game_action {roomCode, sessionToken, action}
 * and holds pendingAction=true until the action's OUTCOME is known.
 *
 * PENDING-ACTION LATCH (double-dispatch guard): the action window is
 * SIMULTANEOUS, so state_update broadcasts caused by RIVAL actions land
 * between my dispatch and my own action's broadcast all the time. The wire
 * protocol carries no per-action ack, so a broadcast cannot be attributed to
 * my action by transport alone — a naive "clear on any broadcast" latch
 * re-arms commit buttons while my action is still in flight (double-BUILD
 * double-spend). Callers of dispatch() therefore pass `resolvedWhen`, a
 * content predicate over the projected state ("my bid is the standing high
 * bid", "the work's progress rose") that proves THEIR action was applied;
 * while it returns false, broadcasts update gameState but do NOT clear the
 * latch. The latch always clears on:
 *   - action_rejected  (sent to the issuing socket only — always mine),
 *   - state_snapshot   (direct-to-me resync; the server's stale-ADVANCE_PHASE
 *                       path relies on a snapshot clearing the pending flag),
 *   - disconnect, and
 *   - a safety timeout (predicate bugs must never wedge the UI shut).
 * Dispatches without `resolvedWhen` keep the legacy behaviour (any broadcast
 * clears) — correct for actions whose buttons cannot double-spend.
 *
 * RECONNECT: App.tsx owns the rejoin path — it emits rejoin_game with the
 * sessionStorage session on every socket "connect" (page load and every
 * socket.io reconnect). This provider deliberately does NOT re-emit rejoin;
 * it only listens for the state that follows. On reconnect while in-game it
 * shows the "table is restored" notice.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { SOCKET_EVENTS } from "@imperium/shared";
import type { GameAction, GameState } from "@imperium/shared";
import { getSocket } from "../socket";
import { loadSession } from "../session";
import { useToast } from "../ui";
import { CONNECTION, rejectionCopy } from "./uiText";
import type { TimerState } from "./types";

/**
 * Per-dispatch correlation options (see the PENDING-ACTION LATCH note above).
 */
export interface DispatchOptions {
  /**
   * Returns true when a broadcast state provably REFLECTS this action's
   * outcome (e.g. after MERC_BID: "I am the standing high bidder on that
   * company"). While it returns false, rival-caused broadcasts keep
   * pendingAction latched so commit buttons cannot double-fire an in-flight
   * order. Keep the predicate specific to something only YOUR action can
   * change — it runs against the fog-of-war projection you receive.
   */
  resolvedWhen?: (state: GameState) => boolean;
}

export interface GameContextValue {
  /** The latest server-authoritative (projected) game state. */
  gameState: GameState;
  /** My seat's player id. */
  myPlayerId: string;
  roomCode: string;
  /** Live turn countdown, or null when timers are off / between turns. */
  timer: TimerState | null;
  /**
   * True between dispatch() and that action's known outcome: a broadcast
   * satisfying the dispatch's `resolvedWhen` predicate (or ANY broadcast when
   * none was given), an action_rejected, a direct snapshot, a disconnect, or
   * the safety timeout.
   */
  pendingAction: boolean;
  /** Emit a GameAction to the server (roomCode/sessionToken attached). */
  dispatch: (action: GameAction, options?: DispatchOptions) => void;
}

const GameContext = createContext<GameContextValue | null>(null);

/**
 * Safety net for the pending latch: if a dispatch's `resolvedWhen` predicate
 * is wrong (or the server never answers at all) the latch self-clears after
 * this long, so a client bug can never wedge every commit button shut. A
 * healthy round trip resolves in well under a second; 8s is comfortably past
 * any real outcome without leaving the player stuck.
 */
const PENDING_SAFETY_MS = 8000;

export interface GameProviderProps {
  /** State to render until the first socket broadcast lands. */
  initialState: GameState;
  myPlayerId: string;
  roomCode: string;
  children: ReactNode;
}

export function GameProvider(props: GameProviderProps): JSX.Element {
  const { initialState, myPlayerId, roomCode, children } = props;
  const toast = useToast();

  const [gameState, setGameState] = useState<GameState>(initialState);
  const [timer, setTimer] = useState<TimerState | null>(null);
  const [pendingAction, setPendingAction] = useState(false);
  // The in-flight action's correlation predicate (null = legacy "any
  // broadcast resolves it"). A ref, not state: broadcast handlers must see
  // the CURRENT flight synchronously, never a stale render's.
  const inFlight = useRef<{
    resolvedWhen: ((state: GameState) => boolean) | null;
  } | null>(null);
  const pendingSafety = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set after a server_shutdown/disconnect so the next connect can announce
  // the restored table.
  const wasDisconnected = useRef(false);

  /** Resolve the in-flight action: drop the latch and its safety timer. */
  const clearPending = useCallback(() => {
    inFlight.current = null;
    if (pendingSafety.current !== null) {
      clearTimeout(pendingSafety.current);
      pendingSafety.current = null;
    }
    setPendingAction(false);
  }, []);

  // Never leave a safety timer running past unmount.
  useEffect(
    () => () => {
      if (pendingSafety.current !== null) clearTimeout(pendingSafety.current);
    },
    [],
  );

  useEffect(() => {
    const socket = getSocket();

    // Room broadcast (state_update / game_started): may have been caused by a
    // RIVAL's action, so it clears the pending latch only when the in-flight
    // dispatch's predicate confirms MY action is reflected (or no predicate
    // was given — legacy behaviour).
    const onState = ({ state }: { state: GameState }) => {
      setGameState(state);
      const flight = inFlight.current;
      if (
        flight === null ||
        flight.resolvedWhen === null ||
        flight.resolvedWhen(state)
      ) {
        clearPending();
      }
    };
    // Direct-to-this-socket snapshot (rejoin, stale-ADVANCE_PHASE resync):
    // always an answer to ME, so it always clears the latch — the server's
    // stale-advance path counts on that.
    const onSnapshot = ({ state }: { state: GameState }) => {
      setGameState(state);
      clearPending();
    };
    const onTimer = (payload: {
      roomCode: string;
      activePlayerId: string | null;
      deadline: number;
      turnSeconds: number;
    }) => {
      if (payload.roomCode !== roomCode) return;
      setTimer({
        activePlayerId: payload.activePlayerId,
        deadline: payload.deadline,
        turnSeconds: payload.turnSeconds,
      });
    };
    const onRejected = ({ reason, code }: { reason: string; code?: string }) => {
      clearPending();
      toast.error(rejectionCopy(reason, code));
    };
    const onShutdown = () => {
      wasDisconnected.current = true;
      toast.error(CONNECTION.lost);
    };
    const onDisconnect = () => {
      wasDisconnected.current = true;
      clearPending();
    };
    const onConnect = () => {
      // App.tsx emits rejoin_game here; we only announce the recovery.
      if (wasDisconnected.current) {
        wasDisconnected.current = false;
        toast.info(CONNECTION.restored);
      }
    };

    socket.on(SOCKET_EVENTS.STATE_UPDATE, onState);
    socket.on(SOCKET_EVENTS.STATE_SNAPSHOT, onSnapshot);
    socket.on(SOCKET_EVENTS.GAME_STARTED, onState);
    socket.on(SOCKET_EVENTS.TURN_TIMER, onTimer);
    socket.on(SOCKET_EVENTS.ACTION_REJECTED, onRejected);
    socket.on(SOCKET_EVENTS.SERVER_SHUTDOWN, onShutdown);
    socket.on("disconnect", onDisconnect);
    socket.on("connect", onConnect);

    return () => {
      socket.off(SOCKET_EVENTS.STATE_UPDATE, onState);
      socket.off(SOCKET_EVENTS.STATE_SNAPSHOT, onSnapshot);
      socket.off(SOCKET_EVENTS.GAME_STARTED, onState);
      socket.off(SOCKET_EVENTS.TURN_TIMER, onTimer);
      socket.off(SOCKET_EVENTS.ACTION_REJECTED, onRejected);
      socket.off(SOCKET_EVENTS.SERVER_SHUTDOWN, onShutdown);
      socket.off("disconnect", onDisconnect);
      socket.off("connect", onConnect);
    };
  }, [roomCode, toast, clearPending]);

  const dispatch = useCallback(
    (action: GameAction, options?: DispatchOptions) => {
      const session = loadSession();
      if (!session || session.roomCode !== roomCode) {
        toast.error(CONNECTION.lost);
        return;
      }
      // Arm the latch BEFORE emitting so no handler can observe an emitted-
      // but-unlatched window. A caller's `resolvedWhen` keeps the latch held
      // through rival-caused broadcasts (see PENDING-ACTION LATCH above).
      inFlight.current = { resolvedWhen: options?.resolvedWhen ?? null };
      if (pendingSafety.current !== null) clearTimeout(pendingSafety.current);
      pendingSafety.current = setTimeout(clearPending, PENDING_SAFETY_MS);
      setPendingAction(true);
      getSocket().emit(SOCKET_EVENTS.GAME_ACTION, {
        roomCode,
        sessionToken: session.sessionToken,
        action,
      });
    },
    [roomCode, toast, clearPending],
  );

  const value = useMemo<GameContextValue>(
    () => ({ gameState, myPlayerId, roomCode, timer, pendingAction, dispatch }),
    [gameState, myPlayerId, roomCode, timer, pendingAction, dispatch],
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

/** Access the game runtime. Must be rendered inside <GameProvider>. */
export function useGame(): GameContextValue {
  const value = useContext(GameContext);
  if (!value) {
    throw new Error("useGame must be used within <GameProvider>");
  }
  return value;
}
