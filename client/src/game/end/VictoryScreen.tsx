/**
 * VictoryScreen — the full-screen reckoning when state.winner is set, per
 * design/mockups/chronicle.html + lore/ui-text.md §8–§9.
 *
 * Zones (chronicle.html): (1) winner banner — victor's crest in a gilded
 * roundel on porphyry, the verdict pill ("Sudden Death · The Reckoning
 * Closed at the Walls" / "The Track Has Judged"), the viewer's victory or
 * defeat copy (eliminated vs outshone variants) and the victor's win
 * epilogue as the quote; (2) The Final Reckoning — the standings table,
 * winner row gilded AND marked by the laurel pill (never color alone);
 * (3) The Epilogues — one line per power (win set for the victor, lose sets
 * for the rest), in standings order; (4–5) the illuminated Chronicle
 * (end/Chronicle.tsx); (6) closing actions — "Bind the Volume" (print the
 * book; quill_scratch + the "So it is written." triumph toast) and
 * "Close the Book" (onClose, back to the board).
 *
 * Audio (README §4 / AUDIO_DESIGN §2): horn_fanfare entering as victor,
 * defeat_drum for the fallen; page_turn on "Read the Chronicle".
 *
 * Routed by OverlayManager when state.winner !== undefined (top priority).
 */
import { useEffect, useRef } from "react";
import { Faction } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { useAudio } from "../../audio/AudioProvider";
import { Button, CREST_URL, ICON_URL, Modal, Panel, useToast } from "../../ui";
import { FACTION_SLUG } from "../../board/types";
import { me } from "../selectors";
import { DEFEAT, FACTION_NAME, VICTORY } from "../uiText";
import {
  FACTION_RULER,
  epilogueFor,
  isEliminated,
  standingsOf,
  victoryKindOf,
} from "./chronicle";
import type { StandingRow, VictoryKind } from "./chronicle";
import { Chronicle } from "./Chronicle";
import "./end.css";

export interface VictoryScreenProps {
  winner: Faction;
  onClose: () => void;
}

/** Deterministic epilogue variant: same for every client at the table. */
function epilogueVariant(roundsPlayed: number, seatIndex: number): number {
  return Math.abs(roundsPlayed + seatIndex) % 3;
}

/** The verdict pill, per victory kind (chronicle.html zone 1 + legend). */
function verdictPill(kind: VictoryKind): string {
  return kind === "sudden"
    ? "Sudden Death · The Reckoning Closed at the Walls"
    : "The Track Has Judged";
}

/** "have/has" agreement for the banner sub-line ("The Ottomans" is plural). */
function takenLine(winner: Faction, kind: VictoryKind): string {
  const name = FACTION_NAME[winner];
  const plural = winner === Faction.OTTOMAN;
  if (kind === "sudden") {
    return `${name} ${plural ? "have" : "has"} taken the City`;
  }
  return `${name} ${plural ? "stand" : "stands"} first in Prestige`;
}

export function VictoryScreen({ winner, onClose }: VictoryScreenProps): JSX.Element {
  const { gameState, myPlayerId } = useGame();
  const { playSfx } = useAudio();
  const toast = useToast();

  const kind = victoryKindOf(gameState) ?? "years";
  const mine = me(gameState, myPlayerId);
  const iWon = mine?.faction === winner;
  const struck = mine !== null && !iWon && isEliminated(gameState, myPlayerId);

  // lore/ui-text.md §8 (victory) / §9 (defeat: eliminated vs outshone).
  const copy = iWon
    ? {
        heading: VICTORY.heading,
        body: VICTORY.body,
        footer: VICTORY.footer,
        closeButton: VICTORY.closeButton,
        chronicleButton: VICTORY.chronicleButton,
      }
    : {
        heading: struck ? DEFEAT.headingEliminated : DEFEAT.headingOutshone,
        body: struck ? DEFEAT.bodyEliminated : DEFEAT.bodyOutshone,
        footer: DEFEAT.footer,
        closeButton: DEFEAT.closeButton,
        chronicleButton: DEFEAT.chronicleButton,
      };

  // horn_fanfare for the victor, defeat_drum for the fallen — once.
  const fanfarePlayed = useRef(false);
  useEffect(() => {
    if (fanfarePlayed.current) return;
    fanfarePlayed.current = true;
    playSfx(iWon ? "horn_fanfare" : "defeat_drum");
  }, [iWon, playSfx]);

  const rows = standingsOf(gameState);
  const roundsPlayed = Math.max(1, gameState.round);

  // The victor's WIN epilogue is the banner quote (chronicle.html zone 1).
  const winnerRow = rows.find((r) => r.isWinner) ?? null;
  const winnerQuote =
    winnerRow !== null
      ? epilogueLine(winnerRow.faction, true, epilogueVariant(roundsPlayed, 0))
      : null;

  const bookRef = useRef<HTMLDivElement>(null);
  const readChronicle = (): void => {
    playSfx("page_turn");
    bookRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const bindVolume = (): void => {
    playSfx("quill_scratch");
    // "So it is written." — chronicle.html legend (zone 6): triumph toast.
    toast.triumph("So it is written.");
    // Commit the volume to paper/PDF (end.css @media print shows the book).
    window.print();
  };

  return (
    <Modal title={copy.heading} onClose={onClose} wide className="end-screen">
      <header
        className="end-victory-head"
        data-faction={FACTION_SLUG[winner]}
      >
        <span className="pill pill--gold end-verdict-pill">{verdictPill(kind)}</span>
        <figure className="end-victory-crest">
          <img
            src={CREST_URL[winner]}
            alt={`Crest of ${FACTION_NAME[winner]}, the victors`}
          />
        </figure>
        <h1 className="end-victory-title">{copy.heading}</h1>
        <p className="end-victory-sub display-caps">— {takenLine(winner, kind)} —</p>
        {winnerQuote !== null && (
          <p className="end-victory-quote">“{winnerQuote}”</p>
        )}
        <div className="end-victory-body">
          {copy.body.split("\n\n").map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
        <p className="end-victory-footer display-caps">{copy.footer}</p>
        <div className="end-victory-actions">
          <Button variant="primary" onClick={readChronicle}>
            {copy.chronicleButton}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {copy.closeButton}
          </Button>
        </div>
      </header>

      <div className="end-main">
        <div className="end-verdict-grid">
          <Panel
            variant="parchment"
            className="end-standings-panel"
            ariaLabel="The final reckoning of Prestige"
          >
            <h2 className="panel-title end-panel-title">
              <img
                className="end-title-icon"
                src={ICON_URL.prestige}
                alt=""
                aria-hidden="true"
              />{" "}
              The Final Reckoning
            </h2>
            <div className="end-table-scroll">
              <table className="table end-standings">
                <thead>
                  <tr>
                    <th scope="col">Seat</th>
                    <th scope="col">Power</th>
                    <th scope="col">Ruler</th>
                    <th scope="col" className="num">
                      Prestige
                    </th>
                    <th scope="col">Fate</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <StandingTr key={row.player.id} row={row} seat={i + 1} kind={kind} />
                  ))}
                </tbody>
              </table>
            </div>
            {kind === "sudden" && (
              <p className="end-standings-note">
                The fall of the City ends the reckoning outright, whoever holds
                the walls when they break. Had Constantinople stood, the track
                would have judged; the walls judged first.
              </p>
            )}
          </Panel>

          <Panel title="The Epilogues" className="end-epilogues-panel">
            <ul className="end-epilogue-list">
              {rows.map((row, i) => (
                <li key={row.player.id} data-faction={FACTION_SLUG[row.faction]}>
                  <figure className="end-epilogue-crest">
                    <img
                      src={CREST_URL[row.faction]}
                      alt={`Crest of ${FACTION_NAME[row.faction]}`}
                    />
                  </figure>
                  <div>
                    <b className="end-epilogue-name">
                      {FACTION_NAME[row.faction]}.
                    </b>
                    <p className="end-epilogue-line">
                      {epilogueLine(
                        row.faction,
                        row.isWinner,
                        epilogueVariant(roundsPlayed, i),
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <hr className="end-rule" />

        <div ref={bookRef} className="end-book-anchor">
          <Chronicle />
        </div>

        <hr className="end-rule" />

        <section className="end-bind-row" aria-label="Closing actions">
          <Button variant="primary" onClick={bindVolume} className="end-grand">
            <span aria-hidden="true">❦</span> Bind the Volume
          </Button>
          <Button variant="quiet" onClick={onClose} className="end-grand">
            {copy.closeButton}
          </Button>
        </section>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

function StandingTr({
  row,
  seat,
  kind,
}: {
  row: StandingRow;
  seat: number;
  kind: VictoryKind;
}): JSX.Element {
  return (
    <tr
      className={row.isWinner ? "end-standing-first" : undefined}
      data-faction={FACTION_SLUG[row.faction]}
    >
      <td className="end-seat">{romanSeat(seat)}</td>
      <td>
        <span className="faction-swatch" aria-hidden="true" />{" "}
        {FACTION_NAME[row.faction]}
        <span className="end-player-name"> · {row.player.name}</span>
      </td>
      <td>{FACTION_RULER[row.faction]}</td>
      <td className="num">{row.prestige}</td>
      <td>
        {row.isWinner ? (
          <span className="pill pill--laurel">
            {kind === "sudden" ? "Victor — the City taken" : "Victor — first in Prestige"}
          </span>
        ) : row.eliminated ? (
          <span className="pill pill--crimson">Fallen — the banner struck</span>
        ) : (
          <span className="end-fate-quiet">Endured to the end</span>
        )}
      </td>
    </tr>
  );
}

const ROMAN_SEAT = ["I", "II", "III", "IV", "V", "VI"] as const;
function romanSeat(seat: number): string {
  return ROMAN_SEAT[seat - 1] ?? String(seat);
}

/** Epilogue line for a power (win/lose sets live in ./chronicle.ts). */
function epilogueLine(faction: Faction, won: boolean, variant: number): string {
  return epilogueFor(faction, won, variant);
}
