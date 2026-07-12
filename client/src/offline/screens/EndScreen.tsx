/**
 * Victory / end-of-game screen (spec §6) — no end screen exists on main.
 * Banner + prestige ranking table from GameOverPayload, "New Game" resets
 * the whole offline flow (OfflineApp destroys the dispatcher).
 */
import type { Faction } from "@imperium/shared";
import type { GameOverPayload } from "../types";

interface EndScreenProps {
  result: GameOverPayload;
  onNewGame: () => void;
}

function factionLabel(faction: Faction | null): string {
  if (!faction) return "—";
  return faction.charAt(0) + faction.slice(1).toLowerCase();
}

export function EndScreen({ result, onNewGame }: EndScreenProps) {
  const winner =
    result.winnerSeatId !== null
      ? (result.ranking.find((r) => r.seatId === result.winnerSeatId) ?? null)
      : null;

  let banner: string;
  let subtitle: string;
  switch (result.reason) {
    case "VICTORY":
      banner = winner ? `${winner.name} is victorious!` : "Victory!";
      subtitle = winner
        ? `${factionLabel(winner.faction)} seizes the age.`
        : "";
      break;
    case "ROUND_LIMIT":
      banner = winner ? `${winner.name} wins the age!` : "The age ends.";
      subtitle = "16 rounds elapsed — highest prestige wins.";
      break;
    case "STALEMATE":
      banner = "Stalemate";
      subtitle = "The game ground to a halt with no victor.";
      break;
  }

  return (
    <div className="imp-center">
      <h1>{banner}</h1>
      {subtitle && <div className="imp-subtitle">{subtitle}</div>}

      <div className="imp-panel" style={{ minWidth: 340, maxWidth: 560 }}>
        <h3>Final Standing</h3>
        <table className="offline-ranking">
          <thead>
            <tr>
              <th>#</th>
              <th>Power</th>
              <th>Faction</th>
              <th>Prestige</th>
            </tr>
          </thead>
          <tbody>
            {result.ranking.map((entry, i) => (
              <tr
                key={entry.seatId}
                className={
                  entry.seatId === result.winnerSeatId ? "offline-winner" : undefined
                }
              >
                <td>{i + 1}</td>
                {/* Bot seat names already carry "(Bot)" (spec §6 setup); the
                    isBot flag needs no extra marker here. */}
                <td>{entry.name}</td>
                <td>{factionLabel(entry.faction)}</td>
                <td>{entry.prestige}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button onClick={onNewGame}>New Game</button>
    </div>
  );
}
