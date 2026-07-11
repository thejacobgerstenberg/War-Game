/**
 * ObjectivesPanel — "The Sealed Ambitions" (hidden-info/objectives area).
 *
 * The projection contract (game/types.ts) delivers MY objectives in full and
 * every rival's as same-length "Sealed objective" stubs; this panel is the
 * reader for both halves:
 *
 *   - a door button docked under the Steward's Chamber gear (top-left of the
 *     map, same self-positioned pattern as settings/SettingsPanel) opens
 *   - a modal listing my secret objectives — description, the Prestige each
 *     is worth (§13.2: revealed & scored only at game end), and a Fulfilled
 *     mark when the engine has scored one (SecretObjective.completed) —
 *   - plus every rival's sealed count (the stub arrays the projection was
 *     designed to expose) and any ambitions my Whisper agents have uncovered
 *     (SpyMission.OBJECTIVE log entries carry data.objectiveDescription,
 *     visibleTo me only — the projection strips everyone else's).
 *
 * COPY: the rubric lines are quoted VERBATIM from lore/tutorial/script.md
 * step-22-the-sealed-ambitions (highlight target `panel:objectives`); the
 * uncovered-intel line mirrors game/modals/SpyModal.tsx's reading of the same
 * log data; prestige tooltip from lore/ui-text.md §4 via uiText.
 *
 * Keyboard: the door is a real button; ui/Modal traps focus and closes on
 * Escape. Fulfilled is marked by glyph + word, never color alone (README §3).
 */
import { useMemo, useState } from "react";
import type { Faction, Player, SecretObjective } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { useAudio } from "../../audio/AudioProvider";
import { Button, Modal, Tooltip, ICON_URL, CREST_URL } from "../../ui";
import { FACTION_NAME, RESOURCE_TOOLTIP } from "../uiText";
import { isHidden } from "../types";
import { me } from "../selectors";
import { FACTION_SLUG } from "../../board/types";
import "./objectives.css";

/** lore/tutorial/script.md step-22 — the panel's in-voice name. */
const PANEL_TITLE = "The Sealed Ambitions";
/** lore/tutorial/script.md step-22, first sentence, verbatim. */
const MINE_RUBRIC =
  "Here are your sealed ambitions — three objectives known to you alone, each worth Prestige if it is fulfilled before the age closes.";
/** lore/tutorial/script.md step-22, remainder, verbatim. */
const RIVALS_RUBRIC =
  "Every prince at the table carries three of his own. Confess them to no man; God knows them already, and that is audience enough.";
/** Engine voice for a scored objective (prestige.ts "reveals a completed
 *  secret objective at game end") — one word for the list mark. */
const FULFILLED_WORD = "Fulfilled";

/** A seated player (faction picked) — same narrowing as ResourcePanel. */
type Seated = Player & { faction: Faction };

export interface ObjectivesPanelProps {
  className?: string;
}

export function ObjectivesPanel({ className }: ObjectivesPanelProps): JSX.Element {
  const { gameState, myPlayerId } = useGame();
  const { playSfx } = useAudio();
  const [open, setOpen] = useState(false);

  const my = me(gameState, myPlayerId);
  const myObjectives: SecretObjective[] = my?.objectives ?? [];

  const rivals = gameState.players.filter(
    (p): p is Seated => p.faction !== null && p.id !== myPlayerId,
  );

  // Whisper intel: SpyMission.OBJECTIVE appends a `spy` log entry with
  // data.objectiveDescription + targets:[rivalId], visibleTo:[me]. The
  // projection already removes entries I may not see, so anything present
  // here is mine. De-duplicated per rival (re-running the mission on the
  // same still-open objective repeats the same text).
  const intelByRival = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of gameState.log) {
      if (entry.type !== "spy") continue;
      const desc = entry.data?.objectiveDescription;
      if (typeof desc !== "string") continue;
      const target = entry.targets?.[0];
      if (target === undefined) continue;
      const list = map.get(target) ?? [];
      if (!list.includes(desc)) {
        list.push(desc);
        map.set(target, list);
      }
    }
    return map;
  }, [gameState.log]);

  return (
    /* Tutorial highlight anchor: lore/tutorial/script.md step-22 targets
       `panel:objectives`. */
    <div
      className={["obj-door-slot", className ?? ""].filter(Boolean).join(" ")}
      data-tutorial-anchor="panel:objectives"
    >
      <Tooltip label={`${PANEL_TITLE} — ${MINE_RUBRIC}`}>
        <Button
          variant="quiet"
          className="obj-door"
          aria-label={`Open ${PANEL_TITLE}`}
          aria-haspopup="dialog"
          onClick={() => {
            // AUDIO_DESIGN §2: browsing cards/pages = page_turn.
            playSfx("page_turn");
            setOpen(true);
          }}
          icon={<img src={ICON_URL.prestige} alt="" />}
        >
          <span className="visually-hidden">{PANEL_TITLE}</span>
        </Button>
      </Tooltip>

      {open && (
        <Modal
          title={PANEL_TITLE}
          onClose={() => {
            playSfx("ui_click");
            setOpen(false);
          }}
        >
          <section className="obj-section" aria-label="Your sealed ambitions">
            <p className="rubric obj-rubric">{MINE_RUBRIC}</p>
            {myObjectives.length === 0 ? (
              <p className="obj-empty">The seal is not yet cut — no ambitions have been dealt.</p>
            ) : (
              <ol className="obj-list">
                {myObjectives.map((objective, index) => (
                  <ObjectiveRow key={`${objective.id}:${index}`} objective={objective} />
                ))}
              </ol>
            )}
          </section>

          <section className="obj-section" aria-label="The rivals' sealed ambitions">
            <h3 className="obj-heading">The Other Princes</h3>
            <p className="rubric obj-rubric">{RIVALS_RUBRIC}</p>
            <ul className="obj-rivals">
              {rivals.map((rival) => {
                const sealedCount = rival.objectives.length;
                const uncovered = intelByRival.get(rival.id) ?? [];
                const readout = [
                  `${FACTION_NAME[rival.faction]}, ${rival.name}: ${sealedCount} sealed ambition${
                    sealedCount === 1 ? "" : "s"
                  }`,
                  ...uncovered.map((line) => `Uncovered — the sealed ambition reads: ${line}`),
                ].join(". ");
                return (
                  <li
                    key={rival.id}
                    className="obj-rival"
                    data-faction={FACTION_SLUG[rival.faction]}
                    aria-label={readout}
                  >
                    <div className="obj-rival-head">
                      <img className="obj-rival-crest" src={CREST_URL[rival.faction]} alt="" />
                      <span className="obj-rival-names">
                        <span className="obj-rival-faction">{FACTION_NAME[rival.faction]}</span>
                        <span className="obj-rival-name">{rival.name}</span>
                      </span>
                      {/* The projection's same-length stub array IS the count. */}
                      <span
                        className="obj-rival-sealed"
                        title="Sealed objective"
                        aria-hidden="true"
                      >
                        <b>{sealedCount}</b> sealed
                      </span>
                    </div>
                    {/* Whisper intel — same reading as SpyModal's log line. */}
                    {uncovered.map((line) => (
                      <p key={line} className="obj-intel" aria-hidden="true">
                        The sealed ambition reads: &ldquo;{line}&rdquo;
                      </p>
                    ))}
                  </li>
                );
              })}
            </ul>
          </section>
        </Modal>
      )}
    </div>
  );
}

/** One of my objectives: description, its Prestige worth, fulfilled mark. */
function ObjectiveRow({ objective }: { objective: SecretObjective }): JSX.Element {
  // Defensive: a "hidden" stub is a rival's face-down card — mine arrive in
  // full, but if one ever appears here, render it sealed rather than blank.
  const sealed = isHidden(objective.id);
  const fulfilled = objective.completed === true;
  const readout = [
    objective.description,
    `worth ${objective.prestige} Prestige`,
    fulfilled ? FULFILLED_WORD : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <li
      className={[
        "obj-item",
        sealed ? "obj-item--sealed" : "",
        fulfilled ? "is-fulfilled" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={readout}
    >
      <span className="obj-desc" aria-hidden="true">
        {objective.description}
      </span>
      <span className="obj-marks" aria-hidden="true">
        {fulfilled && (
          /* Glyph + word, never color alone (design/mockups/README §3). */
          <span className="obj-fulfilled">✓ {FULFILLED_WORD}</span>
        )}
        <span className="obj-worth" title={RESOURCE_TOOLTIP.prestige}>
          <img src={ICON_URL.prestige} alt="" />
          {objective.prestige}
        </span>
      </span>
    </li>
  );
}
