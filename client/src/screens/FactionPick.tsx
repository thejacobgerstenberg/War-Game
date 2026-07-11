import { Faction, type LobbyPlayer } from "@imperium/shared";

interface FactionPickProps {
  players: LobbyPlayer[];
  myFaction: Faction | null;
  error: string | null;
  onPick: (faction: Faction) => void;
  onContinue: () => void;
}

// Faction seat lines, verbatim from lore/ui-text.md ("Choose your faction"),
// split at the em-dash for display: <strong>name</strong> — epithet.
const FACTION_SEATS: Record<Faction, { name: string; epithet: string }> = {
  [Faction.BYZANTIUM]: {
    name: "Byzantium",
    epithet: "the Purple, from Constantinople.",
  },
  [Faction.OTTOMAN]: {
    name: "The Ottomans",
    epithet: "the Sublime Porte, from Adrianople (Edirne).",
  },
  [Faction.VENICE]: {
    name: "Venice",
    epithet: "the Most Serene Republic, from her lagoon.",
  },
  [Faction.GENOA]: {
    name: "Genoa",
    epithet: "La Superba, from her harbor of stone.",
  },
  [Faction.HUNGARY]: {
    name: "Hungary",
    epithet: "the Crown of Saint Stephen, from Buda.",
  },
};

// Seat states, verbatim from lore/ui-text.md ("Seat states").
const SEAT_AVAILABLE = "This throne stands empty. Claim it.";
const SEAT_TAKEN_OTHER = "Claimed by another house.";
const SEAT_TAKEN_MINE = "Your banner flies here.";

export function FactionPick({
  players,
  myFaction,
  error,
  onPick,
  onContinue,
}: FactionPickProps) {
  const takenBy = new Map<Faction, string>();
  for (const p of players) {
    if (p.faction) takenBy.set(p.faction, p.name);
  }

  return (
    <div className="imp-center">
      <h2>Under which banner will you ride?</h2>
      {/* role="alert" so screen readers announce server rejections (e.g. seat
          already claimed) the moment the banner appears — pre-game screens have
          no toast rack, so this div is the only error surface. */}
      {error && (
        <div className="imp-error" role="alert">
          {error}
        </div>
      )}
      <div
        className="imp-row"
        style={{ maxWidth: 760, alignItems: "stretch" }}
      >
        {Object.values(Faction).map((faction) => {
          const seat = FACTION_SEATS[faction];
          const owner = takenBy.get(faction);
          const isMine = myFaction === faction;
          const takenByOther = owner !== undefined && !isMine;
          const seatState = isMine
            ? SEAT_TAKEN_MINE
            : takenByOther
              ? SEAT_TAKEN_OTHER
              : SEAT_AVAILABLE;
          return (
            <button
              key={faction}
              className={isMine ? "" : "ghost"}
              disabled={takenByOther}
              aria-pressed={isMine}
              aria-label={`${seat.name} — ${seat.epithet} ${seatState}`}
              onClick={() => onPick(faction)}
              style={{
                width: 210,
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "1rem",
              }}
            >
              <strong>{seat.name}</strong>
              <span
                style={{
                  fontFamily: "var(--font-body)",
                  textTransform: "none",
                  letterSpacing: 0,
                  fontSize: "0.9rem",
                }}
              >
                {seat.epithet}
              </span>
              <em
                style={{
                  fontFamily: "var(--font-body)",
                  textTransform: "none",
                  letterSpacing: 0,
                  fontSize: "0.85rem",
                }}
              >
                {seatState}
              </em>
            </button>
          );
        })}
      </div>
      <div className="imp-row">
        <button disabled={!myFaction} onClick={onContinue}>
          Onward
        </button>
      </div>
    </div>
  );
}
