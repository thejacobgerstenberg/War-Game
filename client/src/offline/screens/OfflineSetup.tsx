/**
 * Offline game setup (spec §6).
 *  - hotseat: player count 2–5, per-player name + faction dropdown.
 *  - solo: your name + faction, bot count 1–4, per-bot difficulty select;
 *    bot factions auto-assigned from the unclaimed Faction enum values in
 *    declaration order, named "<Faction> (Bot)".
 * Emits seats in turn order (human first in solo). Enforces unique factions,
 * non-empty names, 2–5 seats — the dispatcher re-validates as a guard.
 */
import { useState } from "react";
import { Faction } from "@imperium/shared";
import {
  BOT_DIFFICULTIES,
  MAX_BOTS_SOLO,
  MAX_SEATS,
  MIN_BOTS_SOLO,
  MIN_SEATS,
  type BotDifficulty,
  type OfflineGameConfig,
  type OfflineMode,
  type SeatConfig,
} from "../types";

const FACTIONS: readonly Faction[] = Object.values(Faction);

function factionLabel(faction: Faction): string {
  return faction.charAt(0) + faction.slice(1).toLowerCase();
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

interface OfflineSetupProps {
  mode: OfflineMode;
  error: string | null;
  onStart: (config: OfflineGameConfig) => void;
  onBack: () => void;
}

export function OfflineSetup({ mode, error, onStart, onBack }: OfflineSetupProps) {
  // Slot 0 doubles as the solo human seat; slots 0..playerCount-1 are the
  // hotseat seats. Defaults are unique factions in declaration order.
  const [playerCount, setPlayerCount] = useState(MIN_SEATS);
  const [names, setNames] = useState<string[]>(() =>
    range(1, MAX_SEATS).map((n) => `Player ${n}`),
  );
  const [factions, setFactions] = useState<Faction[]>(() => [...FACTIONS]);
  const [botCount, setBotCount] = useState(MIN_BOTS_SOLO);
  const [difficulties, setDifficulties] = useState<BotDifficulty[]>(() =>
    Array.from({ length: MAX_BOTS_SOLO }, () => "NORMAL" as BotDifficulty),
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const setName = (i: number, value: string) =>
    setNames((prev) => prev.map((n, j) => (j === i ? value : n)));
  const setFaction = (i: number, value: Faction) =>
    setFactions((prev) => prev.map((f, j) => (j === i ? value : f)));
  const setDifficulty = (i: number, value: BotDifficulty) =>
    setDifficulties((prev) => prev.map((d, j) => (j === i ? value : d)));

  /** Bot factions in solo mode: unclaimed factions, declaration order. */
  const unclaimed = FACTIONS.filter((f) => f !== factions[0]);

  const buildConfig = (): OfflineGameConfig | null => {
    if (mode === "hotseat") {
      const seats: SeatConfig[] = [];
      for (let i = 0; i < playerCount; i++) {
        const name = names[i].trim();
        if (!name) {
          setLocalError(`Player ${i + 1} needs a name.`);
          return null;
        }
        seats.push({ kind: "human", name, faction: factions[i] });
      }
      const picked = new Set(seats.map((s) => s.faction));
      if (picked.size !== seats.length) {
        setLocalError("Each player must lead a different faction.");
        return null;
      }
      return { mode, seats };
    }

    // solo — human first in turn order, then bots.
    const name = names[0].trim();
    if (!name) {
      setLocalError("You need a name, commander.");
      return null;
    }
    const seats: SeatConfig[] = [{ kind: "human", name, faction: factions[0] }];
    for (let i = 0; i < botCount; i++) {
      seats.push({
        kind: "bot",
        name: `${factionLabel(unclaimed[i])} (Bot)`,
        faction: unclaimed[i],
        difficulty: difficulties[i],
      });
    }
    return { mode, seats };
  };

  const submit = () => {
    setLocalError(null);
    const config = buildConfig();
    if (config) onStart(config);
  };

  const shownError = localError ?? error;

  return (
    <div className="imp-center">
      <h1>{mode === "hotseat" ? "Hotseat Campaign" : "Solo Campaign"}</h1>
      <div className="imp-subtitle">
        {mode === "hotseat"
          ? "One device, passed around the table."
          : "You against the machine."}
      </div>

      <div className="imp-panel imp-col" style={{ minWidth: 340, maxWidth: 560 }}>
        {mode === "hotseat" ? (
          <>
            <label className="imp-row" style={{ justifyContent: "space-between" }}>
              <span>Players</span>
              <select
                value={playerCount}
                onChange={(e) => setPlayerCount(Number(e.target.value))}
              >
                {range(MIN_SEATS, MAX_SEATS).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {range(0, playerCount - 1).map((i) => (
              <div key={i} className="imp-row" style={{ flexWrap: "nowrap" }}>
                <input
                  style={{ flex: "1 1 auto", minWidth: 0 }}
                  value={names[i]}
                  maxLength={24}
                  onChange={(e) => setName(i, e.target.value)}
                  placeholder={`Player ${i + 1}`}
                />
                <select
                  value={factions[i]}
                  onChange={(e) => setFaction(i, e.target.value as Faction)}
                >
                  {FACTIONS.map((f) => (
                    <option key={f} value={f}>
                      {factionLabel(f)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="imp-row" style={{ flexWrap: "nowrap" }}>
              <input
                style={{ flex: "1 1 auto", minWidth: 0 }}
                value={names[0]}
                maxLength={24}
                onChange={(e) => setName(0, e.target.value)}
                placeholder="Your name"
              />
              <select
                value={factions[0]}
                onChange={(e) => setFaction(0, e.target.value as Faction)}
              >
                {FACTIONS.map((f) => (
                  <option key={f} value={f}>
                    {factionLabel(f)}
                  </option>
                ))}
              </select>
            </div>
            <label className="imp-row" style={{ justifyContent: "space-between" }}>
              <span>Opponents</span>
              <select
                value={botCount}
                onChange={(e) => setBotCount(Number(e.target.value))}
              >
                {range(MIN_BOTS_SOLO, MAX_BOTS_SOLO).map((n) => (
                  <option key={n} value={n}>
                    {n} bot{n > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
            </label>
            {range(0, botCount - 1).map((i) => (
              <div
                key={i}
                className="imp-row"
                style={{ justifyContent: "space-between" }}
              >
                <span>{factionLabel(unclaimed[i])} (Bot)</span>
                <select
                  value={difficulties[i]}
                  onChange={(e) => setDifficulty(i, e.target.value as BotDifficulty)}
                >
                  {BOT_DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>
                      {d.charAt(0) + d.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </>
        )}

        {shownError && <div className="imp-error">{shownError}</div>}
      </div>

      <div className="imp-row">
        <button className="ghost" onClick={onBack}>
          Back
        </button>
        <button onClick={submit}>Begin Campaign</button>
      </div>
    </div>
  );
}
