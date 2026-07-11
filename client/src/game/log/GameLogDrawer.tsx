/**
 * GameLogDrawer — "The Chronicle" (game.html callout 14).
 *
 * Right-edge vertical gilded tab; closed shows only the tab; open lays a
 * parchment strip OVER the map (the gb-slot-drawer slot bounds it — the
 * shell does not reflow). Newest entries first, each under a
 * "Round VII — Campaign" rubric (the mockup's phase-track step names);
 * page_turn on open; auto-scrolls to the newest entry; filterable by round
 * and by kind of deed.
 *
 * Data: state.log (GameLogEntry[]). The projection has ALREADY removed
 * entries whose data.visibleTo excludes this seat — everything present is
 * yours to show. Where a lore/chronicle/TEMPLATES.md template can be filled
 * from an entry's structured data (war declarations), the drawer renders the
 * chronicle phrasing; every other entry shows the engine's own line.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Faction, GameLogEntry, GameLogType } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { useAudio } from "../../audio/AudioProvider";
import { toRoman } from "../../ui";
import { FACTION_NAME, PHASE_NAME, PHASE_STEP_INDEX, PHASE_TRACK_STEPS } from "../uiText";
import { factionOf } from "../selectors";
import type { GameState } from "@imperium/shared";
import "./logDrawer.css";

export interface GameLogDrawerProps {
  /** Open on mount (default closed). */
  defaultOpen?: boolean;
  className?: string;
}

/** Kind-of-deed filters (each groups related GameLogType values). */
const TYPE_FILTERS: ReadonlyArray<{ key: string; label: string; types: readonly GameLogType[] }> = [
  { key: "omens", label: "Omens", types: ["event_card"] },
  { key: "war", label: "Battle & Siege", types: ["battle", "siege"] },
  { key: "court", label: "The Court", types: ["diplomacy", "betrayal", "spy"] },
  { key: "ledger", label: "The Ledger", types: ["trade", "mercenary", "build", "recruit"] },
  {
    key: "renown",
    label: "Renown",
    types: ["prestige_change", "victory", "phase", "game_start", "game_end"],
  },
];

/** Cap the rendered list; the chronicle can grow long over sixteen rounds. */
const MAX_RENDERED = 250;

export function GameLogDrawer({ defaultOpen, className }: GameLogDrawerProps): JSX.Element {
  const { gameState } = useGame();
  const { playSfx } = useAudio();
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [roundFilter, setRoundFilter] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    setOpen((was) => {
      if (!was) playSfx("page_turn");
      return !was;
    });
  };

  const entries = useMemo(() => {
    const allowed =
      typeFilter === "all"
        ? null
        : new Set(TYPE_FILTERS.find((f) => f.key === typeFilter)?.types ?? []);
    const filtered = gameState.log.filter(
      (e) =>
        (allowed === null || allowed.has(e.type)) &&
        (roundFilter === null || e.round === roundFilter),
    );
    return filtered.slice(-MAX_RENDERED).reverse(); // newest first
  }, [gameState.log, typeFilter, roundFilter]);

  // Auto-scroll: newest entries sit at the top of the strip — return there
  // whenever the chronicle grows while open.
  const logLength = gameState.log.length;
  useEffect(() => {
    if (open && scrollRef.current !== null) scrollRef.current.scrollTop = 0;
  }, [logLength, open, typeFilter, roundFilter]);

  const rounds: number[] = [];
  for (let r = gameState.round; r >= 1; r -= 1) rounds.push(r);

  return (
    <aside
      className={["chr-drawer", className ?? ""].filter(Boolean).join(" ")}
      aria-label="The chronicle of the match"
    >
      {open && (
        <div className="chr-body">
          <div className="chr-filters">
            <button
              type="button"
              className="chr-filter"
              aria-pressed={typeFilter === "all"}
              onClick={() => setTypeFilter("all")}
            >
              All
            </button>
            {TYPE_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className="chr-filter"
                aria-pressed={typeFilter === f.key}
                onClick={() => setTypeFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
            <label className="visually-hidden" htmlFor="chr-round-select">
              Show a single round
            </label>
            <select
              id="chr-round-select"
              className="chr-round-select"
              value={roundFilter === null ? "all" : String(roundFilter)}
              onChange={(e) =>
                setRoundFilter(e.target.value === "all" ? null : Number(e.target.value))
              }
            >
              <option value="all">All rounds</option>
              {rounds.map((r) => (
                <option key={r} value={r}>
                  Round {toRoman(r)}
                </option>
              ))}
            </select>
          </div>
          <div className="chr-scroll" ref={scrollRef}>
            {entries.length === 0 ? (
              <p className="chr-empty">The page is blank; the deeds are yet to come.</p>
            ) : (
              <ol reversed>
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <span className="chr-when">{rubricFor(entry)}</span>
                    {chronicleLine(entry, gameState)}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
      <button type="button" className="chr-tab" aria-expanded={open} onClick={toggle}>
        The Chronicle
      </button>
    </aside>
  );
}

/** "Round VII — Campaign" (mockup phase-track step names; LOBBY entries use
 *  the chronicle-voice phase name). */
function rubricFor(entry: GameLogEntry): string {
  const step = PHASE_STEP_INDEX[entry.phase];
  const phaseName = step >= 0 ? PHASE_TRACK_STEPS[step] : PHASE_NAME[entry.phase];
  return `Round ${toRoman(entry.round)} — ${phaseName}`;
}

/**
 * Render an entry through the lore/chronicle/TEMPLATES.md phrasing where the
 * structured data can fill a template; otherwise the engine's own message.
 * Currently: "War declared" (diplomacy entries carrying the declare-war
 * payload — actor faction + data.target).
 */
function chronicleLine(entry: GameLogEntry, state: GameState): string {
  if (
    entry.type === "diplomacy" &&
    entry.data !== undefined &&
    "justified" in entry.data &&
    entry.data["alreadyAtWar"] === false &&
    entry.actors.length > 0
  ) {
    const actorFaction = factionOf(state, entry.actors[0]);
    const target = entry.data["target"];
    if (
      actorFaction !== null &&
      typeof target === "string" &&
      target in FACTION_NAME
    ) {
      // TEMPLATES.md "War declared", variant one — the only variant whose
      // placeholders the log data can fill.
      return `The pretense of peace is spent. ${FACTION_NAME[actorFaction]} looses its hosts upon ${FACTION_NAME[target as Faction]}, and the field is open between them.`;
    }
  }
  return entry.message;
}
