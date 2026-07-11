/**
 * TopBar — HUD feature area. Implements design/mockups/game.html callouts
 * 1–3: round counter + era banner (read-only chrome), the five-step phase
 * track (Income · Muster · Campaign · Council · Twilight; past = .is-done,
 * current = .is-current, hover/focus = one-line in-voice tooltip, never
 * clickable), and the breath-timer (hourglass + live sand gauge draining
 * against timer.deadline, breaths in Roman numerals, crimson + one pulse per
 * breath under ten breaths, NO clock digits anywhere) plus whose turn it is
 * (crest + faction word; the turn banner lines from lore/ui-text.md §6).
 *
 * Data: useGame() -> gameState.round/era/phase + timer {deadline,
 * turnSeconds, activePlayerId}. Phase mapping: uiText.PHASE_STEP_INDEX /
 * PHASE_TRACK_STEPS. Audio: round start plays church_bell; an era change
 * plays horn_fanfare over the church_bell tail (audio/AUDIO_DESIGN.md §2).
 * Auto-yield at nought breaths is server-side — this bar only renders.
 */
import { useEffect, useRef, useState } from "react";
import { useGame } from "../GameProvider";
import { useAudio } from "../../audio/AudioProvider";
import { toRoman, eraLabel, Tooltip, ICON_URL, CREST_URL } from "../../ui";
import type { IconName } from "../../ui";
import {
  FACTION_NAME,
  PHASE_STEP_INDEX,
  PHASE_TRACK_STEPS,
  TURN_BANNER_MINE,
  turnBannerFor,
} from "../uiText";
import { activePlayerId as selectActivePlayerId, playerById } from "../selectors";
import { FACTION_SLUG } from "../../board/types";
import type { TimerState } from "../types";
import "./hud.css";

/** One breath = three seconds (the foundation's breath arithmetic). */
const BREATH_MS = 3_000;

/** Under ten breaths the gauge turns crimson and pulses (game.html §3,
 *  mobile-notes.html: "crimson under ten breaths"). */
const LOW_BREATHS = 10;

type TrackStep = (typeof PHASE_TRACK_STEPS)[number];

/**
 * One-line in-voice phase tooltips: the chronicle phase name and its gloss,
 * VERBATIM from lore/ui-text.md §6 "Phases of the Turn" (joined with an em
 * dash in the mockup's tooltip shape, cf. game.html legend callout 2).
 */
const PHASE_TOOLTIP: Record<TrackStep, string> = {
  Income:
    "The Reckoning — income and supply are counted; treasuries fill, granaries empty.",
  Muster: "The Levy — fresh hosts are mustered and the ranks are swelled.",
  Campaign:
    "The March — hosts move, cities are besieged, and battle is joined upon the field.",
  Council:
    "The Court — pacts are sealed, truces offered, tribute sent, and foundations laid.",
  Twilight:
    "The Chronicle — the deeds of the round are set down, and Prestige is weighed.",
};

/**
 * Phase glyphs per game.html: Income reuses phase-income; Muster, Campaign
 * and Council reuse phase-action / phase-battle / phase-omen as stand-ins.
 * The Twilight glyph is commissioned — its path is reserved at
 * art/icons/phase-twilight.svg and renders as a labeled fallback until the
 * art session delivers it.
 */
const PHASE_GLYPH: Record<TrackStep, IconName | null> = {
  Income: "phase-income",
  Muster: "phase-action",
  Campaign: "phase-battle",
  Council: "phase-omen",
  Twilight: null,
};

/**
 * Era banner epithets. game.html/diplomacy.html fix Era II as
 * "Era II — Crises"; Eras I and III take the matching descriptors from the
 * era headings of lore/events/flavor.md ("Era I — rounds 1–5 (minor)",
 * "Era II — rounds 6–10 (crises)", "Era III — rounds 11–16 (existential)"),
 * title-cased in the mockup's banner shape.
 */
const ERA_EPITHET: Record<1 | 2 | 3, string> = {
  1: "Minor",
  2: "Crises",
  3: "Existential",
};

/**
 * Live breath-timer readout, animated with requestAnimationFrame against
 * timer.deadline. State only changes when a displayed value (whole percent
 * of sand, whole breaths) changes, so the bar does not re-render at 60fps.
 */
function useBreathTimer(
  timer: TimerState | null,
): { sandPercent: number; breaths: number } | null {
  const [display, setDisplay] = useState<{ sandPercent: number; breaths: number } | null>(
    null,
  );

  useEffect(() => {
    if (timer === null) {
      setDisplay(null);
      return;
    }
    let raf = 0;
    let lastSand = -1;
    let lastBreaths = -1;
    const tick = () => {
      const remainingMs = Math.max(0, timer.deadline - Date.now());
      const fraction = Math.max(
        0,
        Math.min(1, remainingMs / (timer.turnSeconds * 1000)),
      );
      const sandPercent = Math.round(fraction * 100);
      const breaths = Math.ceil(remainingMs / BREATH_MS);
      if (sandPercent !== lastSand || breaths !== lastBreaths) {
        lastSand = sandPercent;
        lastBreaths = breaths;
        setDisplay({ sandPercent, breaths });
      }
      if (remainingMs > 0) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [timer]);

  return display;
}

export interface TopBarProps {
  className?: string;
}

export function TopBar({ className }: TopBarProps): JSX.Element {
  const { gameState, timer, myPlayerId } = useGame();
  const { playSfx } = useAudio();
  const stepIndex = PHASE_STEP_INDEX[gameState.phase];
  const breath = useBreathTimer(timer);

  // Round/era audio cues (AUDIO_DESIGN §2): church_bell at each round's
  // start; horn_fanfare over the church_bell tail when the era turns. No cue
  // on first mount (joining mid-game is not a new round).
  const prevReign = useRef<{ round: number; era: number } | null>(null);
  useEffect(() => {
    const prev = prevReign.current;
    prevReign.current = { round: gameState.round, era: gameState.era };
    if (prev === null) return;
    if (gameState.era !== prev.era) {
      playSfx("church_bell");
      playSfx("horn_fanfare");
    } else if (gameState.round !== prev.round) {
      playSfx("church_bell");
    }
  }, [gameState.round, gameState.era, playSfx]);

  // Whose turn: the transport timer is the authoritative live signal;
  // otherwise derive from turnOrder.
  const turnPlayerId = timer?.activePlayerId ?? selectActivePlayerId(gameState);
  const turnPlayer = turnPlayerId !== null ? playerById(gameState, turnPlayerId) : null;
  const turnFaction = turnPlayer?.faction ?? null;
  const isMine = turnPlayer !== null && turnPlayer.id === myPlayerId;
  const turnBanner =
    turnPlayer === null
      ? null
      : isMine
        ? TURN_BANNER_MINE
        : turnBannerFor(
            turnFaction !== null ? FACTION_NAME[turnFaction] : turnPlayer.name,
          );

  const isLow = breath !== null && breath.breaths < LOW_BREATHS;

  return (
    <header
      className={["gb-top", className ?? ""].filter(Boolean).join(" ")}
      aria-label="Round, era, phases and the breath-timer"
    >
      <div className="reign">
        <div className="round-counter">
          Round <b>{toRoman(gameState.round)}</b>
        </div>
        <div className={`era-banner hud-era-${gameState.era}`}>
          {eraLabel(gameState.era)} — {ERA_EPITHET[gameState.era]}
        </div>
      </div>

      <ol className="phase-track" aria-label="The five phases of the round">
        {PHASE_TRACK_STEPS.map((name, i) => {
          const glyph = PHASE_GLYPH[name];
          return (
            <li
              key={name}
              className={`phase${i < stepIndex ? " is-done" : ""}${
                i === stepIndex ? " is-current" : ""
              }`}
              {...(i === stepIndex ? { "aria-current": "step" as const } : {})}
            >
              <Tooltip label={PHASE_TOOLTIP[name]}>
                <span className="hud-phase-body" tabIndex={0}>
                  {glyph !== null ? (
                    <span className="phase-glyph" aria-hidden="true">
                      <img src={ICON_URL[glyph]} alt="" />
                    </span>
                  ) : (
                    /* Commissioned glyph (art/icons/phase-twilight.svg
                       reserved): labeled hatched fallback per the mockup. */
                    <span
                      className="phase-glyph hud-glyph-fallback"
                      aria-hidden="true"
                    >
                      Twilight
                    </span>
                  )}
                  <span className="phase-name">{name}</span>
                </span>
              </Tooltip>
            </li>
          );
        })}
      </ol>

      {turnPlayer !== null && turnFaction !== null && turnBanner !== null && (
        <Tooltip label={turnBanner}>
          <span
            className={`hud-turn${isMine ? " is-me" : ""}`}
            data-faction={FACTION_SLUG[turnFaction]}
            tabIndex={0}
            aria-label={turnBanner}
          >
            <img
              className="hud-turn-crest"
              src={CREST_URL[turnFaction]}
              alt=""
            />
            <span className="hud-turn-name">{FACTION_NAME[turnFaction]}</span>
          </span>
        </Tooltip>
      )}

      {timer !== null && breath !== null && (
        <div
          className={`turn-timer${isLow ? " is-low" : ""}`}
          aria-label="Time remaining in the turn"
        >
          <span className="hourglass" aria-hidden="true">
            ⧗
          </span>
          <span className="sand-gauge" aria-hidden="true">
            <span className="sand" style={{ width: `${breath.sandPercent}%` }} />
          </span>
          <span className="breaths">
            {breath.breaths > 0
              ? `${toRoman(breath.breaths)} breaths remain`
              : "Nought breaths remain"}
          </span>
        </div>
      )}
    </header>
  );
}
