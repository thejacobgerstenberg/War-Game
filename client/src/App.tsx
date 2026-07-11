import { useEffect, useRef, useState } from "react";
import {
  SOCKET_EVENTS,
  type Faction,
  type GameState,
  type LobbyPlayer,
} from "@imperium/shared";
import { getSocket } from "./socket";
import { clearSession, loadSession, saveSession } from "./session";
import { Home } from "./screens/Home";
import { CreateJoin } from "./screens/CreateJoin";
import { FactionPick } from "./screens/FactionPick";
import { Lobby } from "./screens/Lobby";
import { GameBoard } from "./screens/GameBoard";
import { GameProvider } from "./game/GameProvider";
import { ToastProvider } from "./ui";
import { AudioProvider } from "./audio/AudioProvider";
import "./styles/tokens.css";
import "./styles/base.css";

type Screen = "home" | "createJoin" | "factionPick" | "lobby" | "game";
type Mode = "create" | "join";

export function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [mode, setMode] = useState<Mode>("create");
  const [roomCode, setRoomCode] = useState<string>("");
  const [playerId, setPlayerId] = useState<string>("");
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True between emitting rejoin_game and its outcome, so error_msg can be
  // recognised as a rejoin failure (=> clear stored creds).
  const rejoinPending = useRef(false);

  useEffect(() => {
    const socket = getSocket();

    // Reclaim our seat with the stored session (page load with saved creds,
    // and every socket.io reconnect after a drop).
    const attemptRejoin = () => {
      const session = loadSession();
      if (!session) return;
      rejoinPending.current = true;
      setRoomCode(session.roomCode);
      setPlayerId(session.playerId);
      socket.emit(SOCKET_EVENTS.REJOIN_GAME, {
        roomCode: session.roomCode,
        sessionToken: session.sessionToken,
      });
    };

    socket.on(SOCKET_EVENTS.GAME_CREATED, ({ roomCode, playerId, sessionToken }) => {
      saveSession({ roomCode, playerId, sessionToken });
      setRoomCode(roomCode);
      setPlayerId(playerId);
      setError(null);
      setScreen("factionPick");
    });

    socket.on(SOCKET_EVENTS.LOBBY_UPDATE, (payload) => {
      setRoomCode(payload.roomCode);
      setPlayers(payload.players);
      if (rejoinPending.current) {
        // Rejoin succeeded (we only receive room broadcasts once reattached).
        rejoinPending.current = false;
        // After a full page reload we are still on "home": resume in the
        // lobby; game_started follows immediately for started games.
        setScreen((s) => (s === "home" ? "lobby" : s));
      }
    });

    socket.on(SOCKET_EVENTS.GAME_STARTED, ({ state }) => {
      rejoinPending.current = false;
      setGameState(state);
      setError(null);
      setScreen("game");
    });

    socket.on(SOCKET_EVENTS.STATE_UPDATE, ({ state }) => {
      setGameState(state);
    });

    socket.on(SOCKET_EVENTS.ERROR_MSG, ({ message }) => {
      if (rejoinPending.current) {
        // Rejoin was refused (room reaped / token invalid): drop stale creds.
        rejoinPending.current = false;
        clearSession();
      }
      setError(message);
    });

    socket.on("connect", attemptRejoin);
    if (socket.connected) attemptRejoin();

    return () => {
      socket.off(SOCKET_EVENTS.GAME_CREATED);
      socket.off(SOCKET_EVENTS.LOBBY_UPDATE);
      socket.off(SOCKET_EVENTS.GAME_STARTED);
      socket.off(SOCKET_EVENTS.STATE_UPDATE);
      socket.off(SOCKET_EVENTS.ERROR_MSG);
      socket.off("connect", attemptRejoin);
    };
  }, []);

  const me = players.find((p) => p.id === playerId) ?? null;

  const startCreateJoin = (m: Mode) => {
    setMode(m);
    setError(null);
    setScreen("createJoin");
  };

  const submitCreateJoin = (name: string, code?: string) => {
    const socket = getSocket();
    setError(null);
    if (mode === "create") {
      socket.emit(SOCKET_EVENTS.CREATE_GAME, { playerName: name });
    } else {
      socket.emit(SOCKET_EVENTS.JOIN_GAME, {
        roomCode: (code ?? "").toUpperCase(),
        playerName: name,
      });
    }
  };

  const pickFaction = (faction: Faction) => {
    getSocket().emit(SOCKET_EVENTS.PICK_FACTION, { faction });
  };

  const startGame = () => {
    getSocket().emit(SOCKET_EVENTS.START_GAME);
  };

  const renderScreen = () => {
    switch (screen) {
      case "home":
        return <Home onCreate={() => startCreateJoin("create")} onJoin={() => startCreateJoin("join")} />;
      case "createJoin":
        return (
          <CreateJoin
            mode={mode}
            error={error}
            onSubmit={submitCreateJoin}
            onBack={() => setScreen("home")}
          />
        );
      case "factionPick":
        return (
          <FactionPick
            players={players}
            myFaction={me?.faction ?? null}
            error={error}
            onPick={pickFaction}
            onContinue={() => setScreen("lobby")}
          />
        );
      case "lobby":
        return (
          <Lobby
            roomCode={roomCode}
            players={players}
            isHost={me?.isHost ?? false}
            error={error}
            onStart={startGame}
            onBackToFactions={() => setScreen("factionPick")}
          />
        );
      case "game":
        // GameProvider owns the live in-game state from here on; App's
        // gameState only seeds it (and keeps this branch mounted).
        return gameState ? (
          <GameProvider initialState={gameState} myPlayerId={playerId} roomCode={roomCode}>
            <GameBoard />
          </GameProvider>
        ) : null;
    }
  };

  return (
    <ToastProvider>
      <AudioProvider>{renderScreen()}</AudioProvider>
    </ToastProvider>
  );
}
