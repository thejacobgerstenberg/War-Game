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
 * dispatch(action) emits game_action {roomCode, sessionToken, action} and
 * holds pendingAction=true until the next state broadcast or rejection.
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

export interface GameContextValue {
  /** The latest server-authoritative (projected) game state. */
  gameState: GameState;
  /** My seat's player id. */
  myPlayerId: string;
  roomCode: string;
  /** Live turn countdown, or null when timers are off / between turns. */
  timer: TimerState | null;
  /** True between dispatch() and the next state broadcast / rejection. */
  pendingAction: boolean;
  /** Emit a GameAction to the server (roomCode/sessionToken attached). */
  dispatch: (action: GameAction) => void;
}

const GameContext = createContext<GameContextValue | null>(null);

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
  // Set after a server_shutdown/disconnect so the next connect can announce
  // the restored table.
  const wasDisconnected = useRef(false);

  useEffect(() => {
    const socket = getSocket();

    const onState = ({ state }: { state: GameState }) => {
      setGameState(state);
      setPendingAction(false);
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
      setPendingAction(false);
      toast.error(rejectionCopy(reason, code));
    };
    const onShutdown = () => {
      wasDisconnected.current = true;
      toast.error(CONNECTION.lost);
    };
    const onDisconnect = () => {
      wasDisconnected.current = true;
      setPendingAction(false);
    };
    const onConnect = () => {
      // App.tsx emits rejoin_game here; we only announce the recovery.
      if (wasDisconnected.current) {
        wasDisconnected.current = false;
        toast.info(CONNECTION.restored);
      }
    };

    socket.on(SOCKET_EVENTS.STATE_UPDATE, onState);
    socket.on(SOCKET_EVENTS.STATE_SNAPSHOT, onState);
    socket.on(SOCKET_EVENTS.GAME_STARTED, onState);
    socket.on(SOCKET_EVENTS.TURN_TIMER, onTimer);
    socket.on(SOCKET_EVENTS.ACTION_REJECTED, onRejected);
    socket.on(SOCKET_EVENTS.SERVER_SHUTDOWN, onShutdown);
    socket.on("disconnect", onDisconnect);
    socket.on("connect", onConnect);

    return () => {
      socket.off(SOCKET_EVENTS.STATE_UPDATE, onState);
      socket.off(SOCKET_EVENTS.STATE_SNAPSHOT, onState);
      socket.off(SOCKET_EVENTS.GAME_STARTED, onState);
      socket.off(SOCKET_EVENTS.TURN_TIMER, onTimer);
      socket.off(SOCKET_EVENTS.ACTION_REJECTED, onRejected);
      socket.off(SOCKET_EVENTS.SERVER_SHUTDOWN, onShutdown);
      socket.off("disconnect", onDisconnect);
      socket.off("connect", onConnect);
    };
  }, [roomCode, toast]);

  const dispatch = useCallback(
    (action: GameAction) => {
      const session = loadSession();
      if (!session || session.roomCode !== roomCode) {
        toast.error(CONNECTION.lost);
        return;
      }
      setPendingAction(true);
      getSocket().emit(SOCKET_EVENTS.GAME_ACTION, {
        roomCode,
        sessionToken: session.sessionToken,
        action,
      });
    },
    [roomCode, toast],
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
