import { useState } from "react";

interface CreateJoinProps {
  mode: "create" | "join";
  error: string | null;
  onSubmit: (name: string, roomCode?: string) => void;
  onBack: () => void;
}

export function CreateJoin({ mode, error, onSubmit, onBack }: CreateJoinProps) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const canSubmit =
    name.trim().length > 0 && (mode === "create" || code.trim().length === 6);

  return (
    <div className="imp-center">
      <h2>{mode === "create" ? "Found Your Realm" : "Join a Realm"}</h2>
      <div className="imp-panel imp-col" style={{ minWidth: 320 }}>
        <label className="imp-col" style={{ alignItems: "stretch" }}>
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Constantine"
            maxLength={24}
            autoFocus
          />
        </label>

        {mode === "join" && (
          <label className="imp-col" style={{ alignItems: "stretch" }}>
            <span>Room code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="6 characters"
              maxLength={6}
              style={{ letterSpacing: "0.2em", textTransform: "uppercase" }}
            />
          </label>
        )}

        {error && <div className="imp-error">{error}</div>}

        <div className="imp-row">
          <button className="ghost" onClick={onBack}>
            Back
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => onSubmit(name.trim(), code.trim())}
          >
            {mode === "create" ? "Create" : "Join"}
          </button>
        </div>
      </div>
    </div>
  );
}
