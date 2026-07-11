import { useEffect, useState } from "react";
import {
  SOCKET_EVENTS,
  type Faction,
  type GameState,
  type LobbyPlayer,
} from "@imperium/shared";
import { getSocket } from "./socket";
import { Home } from "./screens/Home";
import { CreateJoin } from "./screens/CreateJoin";
import { FactionPick } from "./screens/FactionPick";
import { Lobby } from "./screens/Lobby";
import { GameBoard } from "./screens/GameBoard";

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

  useEffect(() => {
    const socket = getSocket();

    socket.on(SOCKET_EVENTS.GAME_CREATED, ({ roomCode, playerId }) => {
      setRoomCode(roomCode);
      setPlayerId(playerId);
      setError(null);
      setScreen("factionPick");
    });

    socket.on(SOCKET_EVENTS.LOBBY_UPDATE, (payload) => {
      setRoomCode(payload.roomCode);
      setPlayers(payload.players);
    });

    socket.on(SOCKET_EVENTS.GAME_STARTED, ({ state }) => {
      setGameState(state);
      setError(null);
      setScreen("game");
    });

    socket.on(SOCKET_EVENTS.STATE_UPDATE, ({ state }) => {
      setGameState(state);
    });

    socket.on(SOCKET_EVENTS.ERROR_MSG, ({ message }) => {
      setError(message);
    });

    return () => {
      socket.off(SOCKET_EVENTS.GAME_CREATED);
      socket.off(SOCKET_EVENTS.LOBBY_UPDATE);
      socket.off(SOCKET_EVENTS.GAME_STARTED);
      socket.off(SOCKET_EVENTS.STATE_UPDATE);
      socket.off(SOCKET_EVENTS.ERROR_MSG);
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
      return gameState ? <GameBoard state={gameState} /> : null;
  }
}
