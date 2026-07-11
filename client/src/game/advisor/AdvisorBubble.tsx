/**
 * AdvisorBubble — the court counsellor's seat (game.html callout 13).
 *
 * Bottom-left above the action bar: ONE counsellor speaks at a time, named
 * and attributed, crest beside the bubble; new counsel replaces old; click
 * (or Enter/Space) the bubble to dismiss. Non-blocking and rate-limited.
 *
 * Two modes:
 *  - CONTROLLED: a parent passes `line` (the tutorial or the endgame can
 *    speak through this seat) — rendered as given, `onDismiss` honoured.
 *  - SELF-DRIVEN (the GameBoard mounts it with line={null}): counsel is
 *    chosen from the playing faction's own advisor roster
 *    (lore/factions/*.md sample lines, situation-tagged) plus the
 *    lore/tutorial/tips.md idle tips, triggered by game state:
 *      war declared on you · siege begun (yours, either side) · ally
 *      betrayed you · victory near (renown at three quarters of the table's
 *      victory threshold, balance §13.2) · low gold
 *      · an omen struck · phase-tagged idle tips on your turn.
 *    Rate limits: urgent counsel may replace the seat at most every few
 *    breaths; commentary and idle tips wait far longer. Each trigger key
 *    fires once.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { GamePhase } from "@imperium/shared";
import type { GameState } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { me, isMyTurn, provinceById } from "../selectors";
import { prestigeThreshold } from "../prestige";
import { CREST_URL } from "../../ui";
import { advisorFor, tipsFor } from "./advisorLines";
import type { CounselTag, TipTag } from "./advisorLines";
import "./advisor.css";

export interface AdvisorLine {
  /** The counsel itself, in voice. */
  text: string;
  /** Attribution, e.g. "Demetrios Choumnos, Grand Logothete". */
  cite: string;
}

export interface AdvisorBubbleProps {
  /** Controlled counsel; null/undefined lets the seat drive itself. */
  line?: AdvisorLine | null;
  onDismiss?: () => void;
  className?: string;
}

/**
 * Fraction of the table's victory threshold (balance §13.2, mirrored by
 * game/prestige.ts) at which "victory near" counsel fires. The mockup-era
 * flat 15 assumed the stale 0–20 track; 15/20 = three quarters of the way.
 */
const VICTORY_NEAR_FRACTION = 0.75;
/** Treasury gold at or below which the "low gold" counsel fires. */
const LOW_GOLD = 3;

/** Minimum quiet time before counsel of each urgency may speak (ms). */
const GAP_URGENT = 8_000; // war / siege / betrayal / victory near
const GAP_CONCERN = 45_000; // low gold
const GAP_COMMENT = 60_000; // an omen struck
const GAP_IDLE = 90_000; // idle tips

const PHASE_TIP_TAG: Record<GamePhase, TipTag> = {
  [GamePhase.LOBBY]: "any",
  [GamePhase.INCOME]: "income",
  [GamePhase.RECRUITMENT]: "muster",
  [GamePhase.MOVEMENT]: "campaign",
  [GamePhase.DIPLOMACY]: "diplomacy",
  [GamePhase.COMBAT]: "siege",
  [GamePhase.END]: "any",
};

export function AdvisorBubble(props: AdvisorBubbleProps): JSX.Element | null {
  const { line, onDismiss, className } = props;
  const driven = useDrivenCounsel(line == null);

  const active = line ?? driven.line;
  const dismiss = line != null ? onDismiss : driven.dismiss;
  const faction = driven.faction;

  if (active == null) return null;
  return (
    <div className={["adv-seat", className ?? ""].filter(Boolean).join(" ")}>
      {faction !== null && (
        <figure className="adv-crest" aria-hidden="true">
          <img src={CREST_URL[faction]} alt="" />
        </figure>
      )}
      <button
        type="button"
        className="advisor-bubble"
        onClick={dismiss}
        aria-label={`Counsel from ${active.cite}. Dismiss the counsel.`}
      >
        {active.text}
        <cite>— {active.cite}</cite>
      </button>
    </div>
  );
}

interface Candidate {
  tag: CounselTag;
  key: string;
  gap: number;
}

/** The self-driving counsel engine (active only when uncontrolled). */
function useDrivenCounsel(enabled: boolean): {
  line: AdvisorLine | null;
  dismiss: () => void;
  faction: ReturnType<typeof factionOfMe>;
} {
  const { gameState, myPlayerId, timer } = useGame();
  const [current, setCurrent] = useState<AdvisorLine | null>(null);

  const faction = factionOfMe(gameState, myPlayerId);
  const advisor = faction !== null ? advisorFor(faction) : null;

  // Trigger memory (survives re-renders; baselined on mount so a reconnect
  // does not replay the whole history as counsel).
  const baselineLog = useRef<number | null>(null);
  const seenSieges = useRef<Set<string>>(new Set());
  const fired = useRef<Set<string>>(new Set());
  const lastShownAt = useRef<number>(0);
  const rotation = useRef<Map<string, number>>(new Map());
  const stateRef = useRef(gameState);
  stateRef.current = gameState;

  const speak = useCallback(
    (tag: CounselTag) => {
      if (advisor === null) return;
      const pool = advisor.lines.filter((l) => l.tag === tag);
      if (pool.length === 0) return;
      const n = rotation.current.get(tag) ?? 0;
      rotation.current.set(tag, n + 1);
      setCurrent({ text: pool[n % pool.length].text, cite: advisor.cite });
      lastShownAt.current = Date.now();
    },
    [advisor],
  );

  // State-driven triggers.
  useEffect(() => {
    if (!enabled || advisor === null) return;
    const state = gameState;

    if (baselineLog.current === null) {
      baselineLog.current = state.log.length;
      for (const s of state.siegeStates) seenSieges.current.add(s.provinceId);
      return;
    }

    const candidates: Candidate[] = [];

    // New chronicle entries since last look.
    const newEntries = state.log.slice(baselineLog.current);
    baselineLog.current = state.log.length;
    for (const entry of newEntries) {
      const targetsMe = entry.targets?.includes(myPlayerId) === true;
      if (
        entry.type === "diplomacy" &&
        entry.data !== undefined &&
        "justified" in entry.data &&
        targetsMe
      ) {
        candidates.push({ tag: "war declared on you", key: `war:${entry.id}`, gap: GAP_URGENT });
      }
      if (entry.type === "betrayal" && targetsMe) {
        candidates.push({ tag: "ally betrayed you", key: `betray:${entry.id}`, gap: GAP_URGENT });
      }
      if (
        entry.type === "event_card" &&
        entry.data?.["deck"] !== "tactic" &&
        entry.data?.["gatheringOmen"] === undefined
      ) {
        candidates.push({ tag: "event card struck", key: `omen:${entry.id}`, gap: GAP_COMMENT });
      }
    }

    // Sieges: new siege involving me (either side of the wall).
    for (const siege of state.siegeStates) {
      if (seenSieges.current.has(siege.provinceId)) continue;
      seenSieges.current.add(siege.provinceId);
      const mine =
        siege.besiegerId === myPlayerId ||
        provinceById(state, siege.provinceId)?.ownerId === myPlayerId;
      if (mine) {
        candidates.push({ tag: "siege begun", key: `siege:${siege.provinceId}`, gap: GAP_URGENT });
      }
    }

    const my = me(state, myPlayerId);
    if (
      my !== null &&
      my.prestige >= Math.ceil(prestigeThreshold(state) * VICTORY_NEAR_FRACTION)
    ) {
      candidates.push({ tag: "victory near", key: "victory-near", gap: GAP_URGENT });
    }
    if (my !== null && my.treasury.gold <= LOW_GOLD) {
      candidates.push({ tag: "low gold", key: `low-gold:r${state.round}`, gap: GAP_CONCERN });
    }

    // Most urgent first (smallest gap); one line per pass; each key once.
    const now = Date.now();
    candidates.sort((a, b) => a.gap - b.gap);
    for (const c of candidates) {
      if (fired.current.has(c.key)) continue;
      if (now - lastShownAt.current < c.gap) continue;
      fired.current.add(c.key);
      speak(c.tag);
      break;
    }
  }, [enabled, advisor, gameState, myPlayerId, speak]);

  // Idle tips: on your turn, after a long quiet, a phase-tagged tip.
  useEffect(() => {
    if (!enabled || advisor === null) return;
    const tick = window.setInterval(() => {
      const state = stateRef.current;
      if (Date.now() - lastShownAt.current < GAP_IDLE) return;
      if (!isMyTurn(state, myPlayerId, timer)) return;
      const pool = tipsFor(PHASE_TIP_TAG[state.phase]);
      if (pool.length === 0) return;
      const n = rotation.current.get("tip") ?? 0;
      rotation.current.set("tip", n + 1);
      setCurrent({ text: pool[n % pool.length].text, cite: advisor.cite });
      lastShownAt.current = Date.now();
    }, 15_000);
    return () => window.clearInterval(tick);
  }, [enabled, advisor, myPlayerId, timer]);

  const dismiss = useCallback(() => setCurrent(null), []);

  return { line: enabled ? current : null, dismiss, faction };
}

function factionOfMe(state: GameState, myPlayerId: string) {
  return me(state, myPlayerId)?.faction ?? null;
}
