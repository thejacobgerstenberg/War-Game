/**
 * EventCardReveal — game.html callout 12 (cards area).
 *
 * The event-card toast docks TOP-RIGHT of the map (the gb-slot-event slot
 * positions it; ordinary notices keep the top-center rack): thumbnail +
 * title + one line; informational toasts yield after about five seconds;
 * clicking opens the FULL card (frame + illustration + rules + flavor);
 * at most ONE event toast at a time; card_flip on arrival.
 *
 * Detection: a new Omen is revealed when state.omenDiscard grows — its last
 * element is the drawn `omen-N` id (the discard pile is public in the
 * projection; the deck itself is "hidden" stubs). The matching
 * `type:"event_card"` log entry (the effect fn's message) supplies the
 * resolved rules line. The baseline is taken on mount so reconnects do not
 * replay history.
 *
 * Copy/art provenance: see eventCardData.ts (docs/EVENT_CARDS.md taglines,
 * lore/events/flavor.md flavor, MANIFEST-bound vignettes, event frame).
 */
import { useEffect, useRef, useState } from "react";
import { useGame } from "../GameProvider";
import { useAudio } from "../../audio/AudioProvider";
import { Button, Modal, eraLabel } from "../../ui";
import { BUTTONS } from "../uiText";
import {
  ERA_DECK_NAME,
  EVENT_FRAME_URL,
  OMEN_CARD_BY_ID,
  artFor,
  flavorFor,
} from "./eventCardData";
import type { OmenCardEntry } from "./eventCardData";
import "./cards.css";

export interface EventCardRevealProps {
  className?: string;
}

/** How long an informational event toast holds before yielding (ms). */
const TOAST_HOLD_MS = 5000;

export function EventCardReveal({ className }: EventCardRevealProps): JSX.Element | null {
  const { gameState } = useGame();
  const { playSfx } = useAudio();

  // Baseline the discard depth on mount; only NEW draws toast.
  const seenDepth = useRef<number | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const discard = gameState.omenDiscard;

  useEffect(() => {
    if (seenDepth.current === null) {
      seenDepth.current = discard.length;
      return;
    }
    if (discard.length > seenDepth.current) {
      seenDepth.current = discard.length;
      const drawn = discard[discard.length - 1];
      if (typeof drawn === "string" && OMEN_CARD_BY_ID[drawn] !== undefined) {
        setRevealedId(drawn); // one at a time: newest replaces older
        setExpanded(false);
        playSfx("card_flip");
      }
    } else {
      seenDepth.current = discard.length;
    }
  }, [discard, playSfx]);

  // Informational toasts yield after ~5s (unless the full card is open).
  useEffect(() => {
    if (revealedId === null || expanded) return;
    const timer = window.setTimeout(() => setRevealedId(null), TOAST_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [revealedId, expanded]);

  if (revealedId === null) return null;
  const card = OMEN_CARD_BY_ID[revealedId];
  if (card === undefined) return null;

  const art = artFor(card);
  const dismiss = () => {
    setExpanded(false);
    setRevealedId(null);
  };

  return (
    <div className={className} role="status" aria-live="polite">
      {!expanded && (
        <button
          type="button"
          className="toast card-event-toast"
          onClick={() => setExpanded(true)}
          aria-label={`An omen is drawn: ${card.name}. Open the card.`}
        >
          <span className="card-thumb" aria-hidden="true">
            <img src={art ?? EVENT_FRAME_URL} alt="" />
          </span>
          <span>
            <b>{card.name}</b> — {card.tagline}
          </span>
        </button>
      )}
      {expanded && (
        <EventCardModal card={card} art={art} onClose={dismiss} />
      )}
    </div>
  );
}

/** The full card: frame + era ring + illustration + rules + flavor. */
function EventCardModal(props: {
  card: OmenCardEntry;
  art: string | null;
  onClose: () => void;
}): JSX.Element {
  const { card, art, onClose } = props;
  const { gameState } = useGame();
  const flavor = flavorFor(card);
  const rules = resolvedRulesLine(gameState.log, card) ?? card.tagline;

  return (
    <Modal title={card.name} onClose={onClose}>
      <div
        className={`card-face card-era-${card.era}`}
        style={{ backgroundImage: `url(${EVENT_FRAME_URL})` }}
      >
        <h3 className="card-name">{card.name}</h3>
        <div className="card-art">
          {/* Unbound cards keep the frame's own laurel-motif window
              (MANIFEST binds 20 of 46) — the flavor carries the card. */}
          {art !== null && <img src={art} alt="" />}
        </div>
        <div className="card-body">
          <p className="card-rules">{rules}</p>
          {flavor !== null && <p className="card-flavor">{flavor}</p>}
        </div>
        <div className="card-foot">
          <span>{card.tag}</span>
          <span>
            {eraLabel(card.era)} — {ERA_DECK_NAME[card.era]}
          </span>
        </div>
      </div>
      <p className="card-reveal-caption rubric">{card.tagline}</p>
      <div className="modal-actions">
        <Button variant="primary" onClick={onClose}>
          {BUTTONS.close}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * The engine logs each Omen's resolution as an `event_card` entry whose
 * message names the card (e.g. "Bumper Harvest: +1 grain from every plains
 * province…"). Find the newest such line for the revealed card.
 */
function resolvedRulesLine(
  log: ReadonlyArray<{ type: string; message: string }>,
  card: OmenCardEntry,
): string | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const entry = log[i];
    if (entry.type === "event_card" && entry.message.includes(card.name)) {
      return entry.message;
    }
  }
  return null;
}
