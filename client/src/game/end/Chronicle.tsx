/**
 * Chronicle — THE ILLUMINATED CHRONICLE (design/mockups/chronicle.html
 * zones 4–5): the written record of the match, stitched from state.log via
 * the template contract in lore/chronicle/TEMPLATES.md (see ./chronicle.ts
 * for the pure builder and all copy provenance).
 *
 * Layout per the mockup: a parchment double-page spread with a shadowed
 * spine, ornamental drop cap, justified body, era chapters ("Era the First ·
 * Rounds I–V · Anno 1400–1420"), marginalia highlights (key battles, storms,
 * great works), the closing plate (the era-ending omen's illustration with
 * its flavor text as caption), the colophon, and "The Age at a Glance" —
 * the era timeline rail of the omens that mattered. Each pip is a button
 * (keyboard-reachable) that opens that omen's record inline (its flavor and
 * the engine's resolved reading), per the mockup legend ("Tapping a pip
 * opens that event's reveal record").
 *
 * Print-friendly: end.css carries @media print rules so "Bind the Volume"
 * can commit the book to paper/PDF.
 */
import { useMemo, useState } from "react";
import type { GameLogEntry } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { ICON_URL, toRoman } from "../../ui";
import { buildChronicle, numberWord, yearForRound } from "./chronicle";
import type { EraChapter, OmenPip } from "./chronicle";
import "./end.css";

export interface ChronicleProps {
  /** Render a specific log (e.g. a replay); defaults to the live game's. */
  log?: readonly GameLogEntry[];
  className?: string;
}

export function Chronicle({ log, className }: ChronicleProps): JSX.Element {
  const { gameState } = useGame();
  const entries = log ?? gameState.log;
  const doc = useMemo(
    () => buildChronicle(gameState, entries),
    [gameState, entries],
  );

  // Split chapters across the two pages of the spread: the final era (and
  // the plate + colophon) belongs to the right-hand page, as in the mockup.
  const rightChapters: EraChapter[] =
    doc.chapters.length > 1 ? [doc.chapters[doc.chapters.length - 1]] : [];
  const leftChapters: EraChapter[] =
    doc.chapters.length > 1 ? doc.chapters.slice(0, -1) : doc.chapters;

  const eraWord = numberWord(doc.erasSpanned);
  const spreadTitle =
    doc.erasSpanned === 1
      ? "The Chronicle of a Game"
      : `The Chronicle of a Game,\nin ${capitalise(eraWord)} Eras`;

  return (
    <article
      className={joinClasses("end-chronicle", className)}
      aria-label="The chronicle of the game"
    >
      <section className="end-book" aria-label="The written chronicle">
        <div className="end-page end-chronicle-body">
          <header className="end-chapter-head">
            <span className="end-ornament" aria-hidden="true">
              ✦ ❦ ✦
            </span>
            <h2 className="end-book-title">
              {spreadTitle.split("\n").map((part, i) => (
                <span key={i} className="end-book-title-line">
                  {part}
                </span>
              ))}
            </h2>
            <p className="rubric">
              Set down fair by the scribes, who saw it all and wagered nothing.
            </p>
          </header>

          <p className="end-opener">
            <span className="end-drop-cap" aria-hidden="true">
              {doc.opener.charAt(0)}
            </span>
            {doc.opener.slice(1)}
          </p>

          {leftChapters.map((chapter) => (
            <ChapterBlock key={chapter.era} chapter={chapter} />
          ))}
        </div>

        <div className="end-page end-chronicle-body">
          {rightChapters.map((chapter) => (
            <ChapterBlock key={chapter.era} chapter={chapter} />
          ))}

          <p className="end-era-when">
            Round {toRoman(doc.roundsPlayed)} · Anno {yearForRound(doc.roundsPlayed)}
          </p>

          {doc.plate !== null && (
            <figure className="end-plate">
              <img src={doc.plate.art} alt={doc.plate.alt} />
              <figcaption className="end-plate-caption">
                “{doc.plate.caption}”
              </figcaption>
            </figure>
          )}

          <p className="end-colophon">❦ {doc.colophon} ❦</p>
        </div>
      </section>

      <section className="end-glance" aria-label="The age at a glance">
        <h2 className="end-glance-title display-caps">The Age at a Glance</h2>
        <p className="rubric end-glance-rubric">
          {capitalise(numberWord(doc.omenCount))} omens that mattered, strung
          upon {eraWord} {doc.erasSpanned === 1 ? "era" : "eras"}.
        </p>
        <div className="end-era-rail">
          {doc.chapters.map((chapter) => (
            <EraRailPanel
              key={chapter.era}
              chapter={chapter}
              pips={doc.pips.filter((p) => p.era === chapter.era)}
            />
          ))}
        </div>
      </section>
    </article>
  );
}

/* -------------------------------------------------------------------------- */

function ChapterBlock({ chapter }: { chapter: EraChapter }): JSX.Element {
  return (
    <section aria-label={`${chapter.title} — ${chapter.when}`}>
      <p className="end-era-when">{chapter.when}</p>
      <h3 className="end-chapter-title">{chapter.title}</h3>
      {chapter.paragraphs.map((text, i) => (
        <p key={i}>{text}</p>
      ))}
      {chapter.highlights.length > 0 && (
        <ul className="end-marginalia" aria-label="Deeds of note in this era">
          {chapter.highlights.map((h) => (
            <li key={h.key} className="end-marginalia-item">
              <img
                className="end-marginalia-icon"
                src={ICON_URL[h.icon]}
                alt=""
                aria-hidden="true"
              />
              <span>
                {h.label} · Round {toRoman(h.round)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EraRailPanel({
  chapter,
  pips,
}: {
  chapter: EraChapter;
  pips: OmenPip[];
}): JSX.Element {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <section
      className="panel panel--parchment end-rail-panel"
      aria-label={`Era ${toRoman(chapter.era)} · ${chapter.title}`}
    >
      <h4 className="end-rail-title display-caps">
        Era {toRoman(chapter.era)} · {chapter.title}
      </h4>
      {pips.length === 0 ? (
        <p className="rubric">No omen of this era troubled the chronicle.</p>
      ) : (
        <ol className="end-pip-list">
          {pips.map((pip) => {
            const open = openKey === pip.key;
            return (
              <li
                key={pip.key}
                className={pip.fatal ? "end-pip end-pip--fatal" : "end-pip"}
              >
                <button
                  type="button"
                  className="end-pip-button"
                  aria-expanded={open}
                  onClick={() => setOpenKey(open ? null : pip.key)}
                >
                  <span className="end-pip-art" aria-hidden="true">
                    {pip.art !== null ? (
                      <img src={pip.art} alt="" />
                    ) : (
                      <span className="end-pip-art-blank">✦</span>
                    )}
                  </span>
                  <span className="end-pip-text">
                    <span className="end-pip-name">
                      {pip.card.name}
                      {pip.fatal ? " — the age ends" : ""}
                    </span>
                    <span className="end-pip-when">
                      Round {toRoman(pip.round)} · {pip.year}
                    </span>
                  </span>
                </button>
                {open && (
                  <div className="end-pip-record">
                    {pip.flavor !== null && (
                      <p className="end-pip-flavor">“{pip.flavor}”</p>
                    )}
                    <p className="end-pip-reading">{pip.reading}</p>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function joinClasses(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
