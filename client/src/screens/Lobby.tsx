import { type LobbyPlayer } from "@imperium/shared";
import { CONNECTION, FACTION_NAME } from "../game/uiText";

/* --------------------------------------------------------------------------
 * Lobby copy — quoted VERBATIM from the narrative contract:
 *   - lore/ui-text.md §2 "Lobby & Matchmaking"
 *   - design/mockups/lobby.html (screen heading, host pill)
 * Never invent copy where real copy exists.
 * ------------------------------------------------------------------------ */
const LOBBY_COPY = {
  /** design/mockups/lobby.html <h1>. */
  heading: "The Gathering Hall",
  /** design/mockups/lobby.html header rubric. */
  rubric: "Five seats, one age ending. The company assembles before the chronicle opens.",
  /** lore/ui-text.md §2 "Codes / joining" — precedes the join code. */
  codeLabel: "Bear this seal to those you would summon:",
  /** lore/ui-text.md §2 ready states — "Host starts the game". */
  start: "Open the Campaign",
  /** lore/ui-text.md §2 lobby toasts — shown to non-hosts in place of the button. */
  hostOnly: "The host alone may open the campaign.",
  /** lore/ui-text.md §2 "Waiting for players" — host sees this until two are seated. */
  tableNotFull: "The table is not yet full. We wait upon latecomers.",
  /** lore/ui-text.md §2 "Choose your faction" — doubles as the back-to-banners action. */
  changeBanner: "Under which banner will you ride?",
  /** design/mockups/lobby.html — the laurel pill on the host's seat. */
  hostPill: "Host of the Hall",
  /** lore/ui-text.md §2 ready states — a seat whose banner is not yet chosen. */
  notYetSworn: "Not Yet Sworn",
} as const;

/** lore/ui-text.md §2: "Two thrones are filled. Three sit empty." (counts adjust). */
const COUNT_WORD = ["No", "One", "Two", "Three", "Four", "Five"] as const;
function thronesLine(filled: number): string {
  const empty = Math.max(0, 5 - filled);
  const filledPart =
    filled === 1 ? "One throne is filled." : `${COUNT_WORD[filled] ?? filled} thrones are filled.`;
  if (empty === 0) return filledPart;
  const emptyPart = empty === 1 ? "One sits empty." : `${COUNT_WORD[empty] ?? empty} sit empty.`;
  return `${filledPart} ${emptyPart}`;
}

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
      <h2>{LOBBY_COPY.heading}</h2>
      <div className="imp-subtitle">{LOBBY_COPY.rubric}</div>
      <div className="imp-subtitle">{LOBBY_COPY.codeLabel}</div>
      <div className="imp-code">{roomCode}</div>

      <div className="imp-panel imp-col" style={{ minWidth: 340 }}>
        {players.map((p) => (
          <div
            key={p.id}
            className="imp-row"
            style={{
              justifyContent: "space-between",
              width: "100%",
              // Dim dropped players; their seat is held for rejoin.
              opacity: p.connected ? 1 : 0.5,
            }}
          >
            <span>
              {p.name}
              {p.isHost ? ` · ${LOBBY_COPY.hostPill}` : ""}
              {!p.connected && <em> — {CONNECTION.lost}</em>}
            </span>
            <span style={{ color: "var(--imp-gold-soft)" }}>
              {p.faction !== null ? FACTION_NAME[p.faction] : LOBBY_COPY.notYetSworn}
            </span>
          </div>
        ))}
        <div className="imp-subtitle">{thronesLine(players.length)}</div>
      </div>

      {/* role="alert" so screen readers announce lobby errors (e.g. start
          rejected) when the banner appears — no toast rack exists pre-game. */}
      {error && (
        <div className="imp-error" role="alert">
          {error}
        </div>
      )}

      <div className="imp-row">
        <button className="ghost" onClick={onBackToFactions}>
          {LOBBY_COPY.changeBanner}
        </button>
        {isHost ? (
          <button disabled={!canStart} onClick={onStart} title={!canStart ? LOBBY_COPY.tableNotFull : undefined}>
            {LOBBY_COPY.start}
          </button>
        ) : (
          <span className="imp-subtitle">{LOBBY_COPY.hostOnly}</span>
        )}
      </div>
      {isHost && !canStart && (
        <div className="imp-subtitle">{LOBBY_COPY.tableNotFull}</div>
      )}
    </div>
  );
}
