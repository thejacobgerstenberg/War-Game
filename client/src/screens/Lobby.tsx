import { type LobbyPlayer } from "@imperium/shared";

interface LobbyProps {
  roomCode: string;
  players: LobbyPlayer[];
  isHost: boolean;
  error: string | null;
  onStart: () => void;
  onBackToFactions: () => void;
}

export function Lobby({
  roomCode,
  players,
  isHost,
  error,
  onStart,
  onBackToFactions,
}: LobbyProps) {
  const canStart = isHost && players.length >= 2;

  return (
    <div className="imp-center">
      <h2>War Council</h2>
      <div className="imp-subtitle">Share this code to summon rivals</div>
      <div className="imp-code">{roomCode}</div>

      <div className="imp-panel imp-col" style={{ minWidth: 340 }}>
        {players.map((p) => (
          <div
            key={p.id}
            className="imp-row"
            style={{ justifyContent: "space-between", width: "100%" }}
          >
            <span>
              {p.name}
              {p.isHost ? " · host" : ""}
            </span>
            <span style={{ color: "var(--imp-gold-soft)" }}>
              {p.faction ?? "choosing…"}
            </span>
          </div>
        ))}
      </div>

      {error && <div className="imp-error">{error}</div>}

      <div className="imp-row">
        <button className="ghost" onClick={onBackToFactions}>
          Change Faction
        </button>
        {isHost ? (
          <button disabled={!canStart} onClick={onStart}>
            Start Game
          </button>
        ) : (
          <span className="imp-subtitle">Awaiting the host…</span>
        )}
      </div>
      {isHost && !canStart && (
        <div className="imp-subtitle">At least two powers must be seated.</div>
      )}
    </div>
  );
}
