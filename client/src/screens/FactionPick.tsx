import { Faction, type LobbyPlayer } from "@imperium/shared";

interface FactionPickProps {
  players: LobbyPlayer[];
  myFaction: Faction | null;
  error: string | null;
  onPick: (faction: Faction) => void;
  onContinue: () => void;
}

const FACTION_BLURBS: Record<Faction, string> = {
  [Faction.BYZANTIUM]: "The Queen of Cities holds, for now.",
  [Faction.OTTOMAN]: "A young power, hungry and disciplined.",
  [Faction.VENICE]: "Coin and galleys rule the sea-lanes.",
  [Faction.GENOA]: "Rivals of Venice in every harbour.",
  [Faction.HUNGARY]: "The last shield of Latin Christendom.",
};

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
      <h2>Choose Your Power</h2>
      {error && <div className="imp-error">{error}</div>}
      <div
        className="imp-row"
        style={{ maxWidth: 760, alignItems: "stretch" }}
      >
        {Object.values(Faction).map((faction) => {
          const owner = takenBy.get(faction);
          const isMine = myFaction === faction;
          const takenByOther = owner !== undefined && !isMine;
          return (
            <button
              key={faction}
              className={isMine ? "" : "ghost"}
              disabled={takenByOther}
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
              <strong>{faction}</strong>
              <span
                style={{
                  fontFamily: "var(--font-body)",
                  textTransform: "none",
                  letterSpacing: 0,
                  fontSize: "0.9rem",
                }}
              >
                {FACTION_BLURBS[faction]}
              </span>
              {takenByOther && (
                <em
                  style={{
                    fontFamily: "var(--font-body)",
                    textTransform: "none",
                    letterSpacing: 0,
                    fontSize: "0.85rem",
                  }}
                >
                  Taken by {owner}
                </em>
              )}
            </button>
          );
        })}
      </div>
      <div className="imp-row">
        <button disabled={!myFaction} onClick={onContinue}>
          To the Lobby
        </button>
      </div>
    </div>
  );
}
