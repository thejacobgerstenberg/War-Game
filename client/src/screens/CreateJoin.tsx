import { useState } from "react";

interface CreateJoinProps {
  mode: "create" | "join";
  error: string | null;
  onSubmit: (name: string, roomCode?: string) => void;
  onBack: () => void;
}

/**
 * Copy provenance (no invented copy where real copy exists):
 * - Create path heading/rubric/button: design/mockups/home.html "Convene a Game" card.
 * - Join heading: lore/ui-text.md §1 "Answer the Summons".
 * - Join rubric: lore/ui-text.md §2 Codes/joining — "Present your seal to join
 *   a game already convened." (join-by-code field prompt).
 * - Code hint: design/mockups/home.html code-entry — "Letters only, as the
 *   herald spoke them. Great or small, it is all one."
 * - Join submit: home.html "Take Your Seat"; Back: ui-text.md §3 "Return".
 * - Name placeholder "Godfrey of the March": example claimant name from
 *   design/mockups/lobby.html seat cards (no canonical name-field prompt exists).
 */
export function CreateJoin({ mode, error, onSubmit, onBack }: CreateJoinProps) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const canSubmit =
    name.trim().length > 0 && (mode === "create" || code.trim().length === 6);

  return (
    <div className="imp-center">
      <h2>{mode === "create" ? "Convene a Game" : "Answer the Summons"}</h2>
      <p className="imp-subtitle" style={{ maxWidth: 380, textAlign: "center" }}>
        {mode === "create"
          ? "Summon rival princes to your table. You set the seats; whether they dare to fill them is their affair."
          : "Present your seal to join a game already convened."}
      </p>
      <div className="imp-panel imp-col" style={{ minWidth: 320 }}>
        <label className="imp-col" style={{ alignItems: "stretch" }}>
          <span>Your Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Godfrey of the March"
            maxLength={24}
            autoFocus
          />
        </label>

        {mode === "join" && (
          <label className="imp-col" style={{ alignItems: "stretch" }}>
            <span>Summons Code</span>
            <input
              value={code}
              onChange={(e) =>
                // "Great or small, it is all one" — case-fold; letters only,
                // as the herald spoke them.
                setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))
              }
              maxLength={6}
              aria-label="Summons code, six letters"
              style={{ letterSpacing: "0.2em", textTransform: "uppercase" }}
            />
            <span
              style={{
                fontStyle: "italic",
                fontSize: "0.85em",
                color: "var(--imp-parchment-shade)",
              }}
            >
              Letters only, as the herald spoke them. Great or small, it is all
              one.
            </span>
          </label>
        )}

        {/* role="alert" so screen readers announce a bad room code / server
            rejection when it appears — no toast rack exists pre-game. */}
        {error && (
          <div className="imp-error" role="alert">
            {error}
          </div>
        )}

        <div className="imp-row">
          <button className="ghost" onClick={onBack}>
            Return
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => onSubmit(name.trim(), code.trim())}
          >
            {mode === "create" ? "Convene a Game" : "Take Your Seat"}
          </button>
        </div>
      </div>
    </div>
  );
}
