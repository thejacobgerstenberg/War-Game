/**
 * TacticHandTray — the player's tactic hand (cards area), fanned
 * bottom-center above the action bar (the gb-slot-tray slot positions it).
 *
 * YOUR hand arrives in full from the projection (rival hands are "hidden"
 * ids and never pass through here); card fronts are the vendored tactic
 * frame + the ratified effect text + lore flavor (see tacticCardData.ts).
 *
 * Play flow: tactics are played INTO a pending battle —
 *   dispatch({ type: "PLAY_TACTIC", player, battleId, cardId })
 * (free — not deed-budgeted; at most one per side per battle round, which
 * the ENGINE enforces). The play affordance is live only while a battle
 * prompt involving you is active (the same state.pendingBattles signal the
 * OverlayManager routes the CombatModal from); otherwise the tray is a hand
 * viewer with the in-voice reason on the disabled verb. Hand-limit pruning
 * happens server-side at Cleanup — the tray only narrates the count.
 * card_flip on draws and plays.
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { TacticCardId } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { useAudio } from "../../audio/AudioProvider";
import { me, nextPendingBattle } from "../selectors";
import { isHidden } from "../types";
import { Button, Modal, toRoman } from "../../ui";
import { ACTION_ERROR_COPY, BUTTONS, ORDER_LABEL } from "../uiText";
import {
  TACTIC_CARD_BY_ID,
  TACTIC_FRAME_URL,
  TACTIC_HAND_LIMIT,
  tacticFlavorFor,
} from "./tacticCardData";
import "./cards.css";

export interface TacticHandTrayProps {
  className?: string;
}

export function TacticHandTray({ className }: TacticHandTrayProps): JSX.Element | null {
  const { gameState, myPlayerId, dispatch, pendingAction } = useGame();
  const { playSfx } = useAudio();
  const [openCard, setOpenCard] = useState<TacticCardId | null>(null);

  const hand = (me(gameState, myPlayerId)?.tacticHand ?? []).filter((id) => !isHidden(id));

  // card_flip when the hand grows (a draw); baseline on mount.
  const prevCount = useRef<number | null>(null);
  useEffect(() => {
    if (prevCount.current !== null && hand.length > prevCount.current) {
      playSfx("card_flip");
    }
    prevCount.current = hand.length;
  }, [hand.length, playSfx]);

  // Close the detail if the shown card leaves the hand (played / pruned).
  useEffect(() => {
    if (openCard !== null && !hand.includes(openCard)) setOpenCard(null);
  }, [hand, openCard]);

  if (hand.length === 0) return null;

  // The battle prompt this tray may play into (yours only).
  const battle = nextPendingBattle(gameState, myPlayerId);
  const myBattle =
    battle !== null &&
    (battle.attackerId === myPlayerId || battle.defenderId === myPlayerId)
      ? battle
      : null;
  const myCommitted: readonly TacticCardId[] =
    myBattle === null
      ? []
      : myBattle.attackerId === myPlayerId
        ? (myBattle.attackerTactics ?? [])
        : (myBattle.defenderTactics ?? []);

  const overLimit = hand.length > TACTIC_HAND_LIMIT;
  const limitCaption = `${toRoman(hand.length)} of ${toRoman(TACTIC_HAND_LIMIT)}`;

  const playInto = (cardId: TacticCardId) => {
    if (myBattle === null) return;
    dispatch({ type: "PLAY_TACTIC", player: myPlayerId, battleId: myBattle.id, cardId });
    playSfx("card_flip");
    setOpenCard(null);
  };

  return (
    <div
      className={["card-tray", className ?? ""].filter(Boolean).join(" ")}
      role="group"
      aria-label={`Stratagems in hand: ${hand.length} of a limit of ${TACTIC_HAND_LIMIT}`}
    >
      <span
        className={["pill", "card-tray-caption", "card-hand-limit", overLimit ? "is-over" : ""]
          .filter(Boolean)
          .join(" ")}
        title={
          overLimit
            ? "The hand is over its limit; the surplus is discarded when the round's Chronicle is written."
            : undefined
        }
      >
        Stratagems in hand — {limitCaption}
      </span>
      <div className="card-fan">
        {hand.map((cardId, i) => {
          const design = TACTIC_CARD_BY_ID[cardId];
          const committed = myCommitted.includes(cardId);
          const tilt = (i - (hand.length - 1) / 2) * 5;
          return (
            <button
              key={`${cardId}:${i}`}
              type="button"
              className={["card-tactic", committed ? "is-committed" : ""]
                .filter(Boolean)
                .join(" ")}
              style={
                {
                  backgroundImage: `url(${TACTIC_FRAME_URL})`,
                  "--card-tilt": `${tilt}deg`,
                } as CSSProperties
              }
              aria-label={`${design?.name ?? cardId}${committed ? " — committed to the battle" : ""}. Open the card.`}
              onClick={() => setOpenCard(cardId)}
            >
              <span className="card-tactic-name">{design?.name ?? cardId}</span>
              <span className="card-tactic-effect" aria-hidden="true">
                {design?.effect ?? ""}
              </span>
              {committed && <span className="card-tactic-committed">Committed</span>}
            </button>
          );
        })}
      </div>

      {openCard !== null && (
        <TacticCardModal
          cardId={openCard}
          committed={myCommitted.includes(openCard)}
          canPlay={myBattle !== null}
          pendingAction={pendingAction}
          onPlay={() => playInto(openCard)}
          onClose={() => setOpenCard(null)}
        />
      )}
    </div>
  );
}

function TacticCardModal(props: {
  cardId: TacticCardId;
  committed: boolean;
  canPlay: boolean;
  pendingAction: boolean;
  onPlay: () => void;
  onClose: () => void;
}): JSX.Element {
  const { cardId, committed, canPlay, pendingAction, onPlay, onClose } = props;
  const design = TACTIC_CARD_BY_ID[cardId];
  const flavor = tacticFlavorFor(cardId);
  const name = design?.name ?? cardId;

  // In-voice reason the verb is unavailable (lore/ui-text.md §7).
  const disabledReason = !canPlay
    ? (ACTION_ERROR_COPY.NO_TARGET ?? "There is no worthy target within reach.")
    : pendingAction
      ? "You wait upon another court. Be patient."
      : undefined;

  return (
    <Modal title={name} onClose={onClose}>
      <div className="card-tactic-detail">
        <div
          className="card-face"
          style={{ backgroundImage: `url(${TACTIC_FRAME_URL})` }}
        >
          <h3 className="card-name">{name}</h3>
          <div className="card-body">
            {design !== undefined && <p className="card-rules">{design.effect}</p>}
            {flavor !== null && <p className="card-flavor">{flavor}</p>}
          </div>
          {design !== undefined && (
            <div className="card-foot">
              <span>{design.tier}</span>
              <span>{design.removedFromGameOnPlay === true ? "Once, and gone" : design.timing}</span>
            </div>
          )}
        </div>
      </div>
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          {BUTTONS.close}
        </Button>
        {committed ? (
          <span className="pill pill--gold">Committed to the battle</span>
        ) : (
          <Button variant="primary" onClick={onPlay} disabledReason={disabledReason}>
            {ORDER_LABEL.stratagem}
          </Button>
        )}
      </div>
    </Modal>
  );
}
