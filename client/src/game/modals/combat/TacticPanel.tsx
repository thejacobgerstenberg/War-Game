/**
 * TacticPanel — combat.html zone 5: the tactic hand while a battle is
 * pending. Playable cards carry the gold rim and a "Play the Card" button
 * (dispatches PLAY_TACTIC, plays card_flip); withheld cards dim to 0.5 and
 * state their reason in voice, visible AND on hover/focus (README §1).
 *
 * The withheld logic mirrors the engine's declaration-time gates so the button
 * never offers a play the server would reject: one stratagem per side per
 * battle round (balance.TACTIC.maxPlaysPerBattleRound, reactions exempt) and
 * the treason-at-the-gate double brake (balance.TREASON_GATE: garrison cap +
 * earliest siege-start round). The server remains authoritative.
 *
 * §7.7 order of declaration: the attacker commits first, then the defender —
 * the rubric above the hand says whose seal the field awaits. The projection
 * shows only YOUR side's committed tactic ids; the rival's arrive as
 * "hidden" stubs and render face-down (sealed).
 */
import type { GameState, PendingBattle, TacticCardId } from "@imperium/shared";
import { useGame } from "../../GameProvider";
import { useAudio } from "../../../audio/AudioProvider";
import { Button, ICON_URL } from "../../../ui";
import { me } from "../../selectors";
import { tacticInfo } from "./tacticCards";
import type { TacticCardInfo } from "./tacticCards";

export interface TacticPanelProps {
  battle: PendingBattle;
  myRole: "attacker" | "defender" | null;
  /** Display name of the battlefield (province or sea zone). */
  locationName: string;
  /** Display names for the committed-tactics line. */
  rivalName: string;
}

type BattleDomain = "land" | "fleet" | "siege";

function battleDomain(battle: PendingBattle): BattleDomain {
  if (battle.seaZoneId !== undefined) return "fleet";
  if (battle.isSiege === true) return "siege";
  return "land";
}

// -- Engine-rule mirrors (server stays authoritative; NEVER import server code,
//    HANDOFF §1). These only drive the playable/withheld presentation.

/** Mirrors server/src/engine/balance.ts `TACTIC.maxPlaysPerBattleRound` (=1, reactions exempt). */
const MAX_PLAYS_PER_BATTLE_ROUND = 1;

/** Mirrors server/src/engine/balance.ts `TREASON_GATE` (delta 1, ratified). */
const TREASON_GATE = {
  /** Max defending garrison the card may be played against. */
  maxGarrison: 4,
  /** Earliest game round the consecutive-siege clock may begin. */
  minGameRound: 6,
} as const;

/**
 * Mirrors server tactics.ts `isTreasonCard` (engine keys on the card's
 * `data.effect === "treason"`); treason-at-the-gate is the only treason-effect
 * design in the ratified 24-card deck.
 */
function isTreasonCard(cardId: string): boolean {
  return cardId === "treason-at-the-gate";
}

/**
 * Mirrors server tactics.ts `assertTreasonGate` (DELTA 1 double-brake, enforced
 * at declaration): (a) besieged garrison <= TREASON_GATE.maxGarrison, (b) an
 * active siege whose clock began no earlier than TREASON_GATE.minGameRound.
 * Returns the withheld line in voice, or null when the gate holds.
 */
function treasonWithheldReason(
  battle: PendingBattle,
  state: GameState,
  locationName: string,
): string | null {
  const provinceId = battle.provinceId;
  const prov =
    provinceId !== undefined ? state.provinces.find((p) => p.id === provinceId) : undefined;

  // Gate (a): a large garrison cannot be suborned.
  const garrison = prov?.garrison ?? 0;
  if (garrison > TREASON_GATE.maxGarrison) {
    return "Withheld — the garrison stands too strong to be suborned; a smaller watch might be bought.";
  }

  // Gate (b): an active siege, laid no earlier than the permitted round.
  const siege =
    provinceId !== undefined
      ? state.siegeStates.find((s) => s.provinceId === provinceId)
      : undefined;
  if (siege === undefined) {
    return `Withheld — treason needs a gate long watched; no siege grips ${locationName}.`;
  }
  const siegeStartRound = state.round - siege.roundsElapsed;
  if (siegeStartRound < TREASON_GATE.minGameRound) {
    return "Withheld — this siege was laid too early in the war; no gatekeeper will yet turn his coat.";
  }
  return null;
}

/**
 * Why a held card cannot be committed to THIS battle, in voice (modeled on
 * the withheld lines design/mockups/combat.html ships), or null if playable.
 */
function withheldReason(
  card: TacticCardInfo,
  domain: BattleDomain,
  myRole: "attacker" | "defender",
  locationName: string,
  treasury: { gold: number; faith: number },
  /** My side's tactics already queued on this battle (projection shows my own). */
  committedCount: number,
  battle: PendingBattle,
  state: GameState,
): string | null {
  if (card.timing === "play-card") {
    return "Withheld — this card is played at court, not upon a joined field.";
  }
  if (card.timing === "reaction") {
    return "Withheld — this card answers a rival's stratagem; hold it until one is played.";
  }
  if (card.timing === "move") {
    return "Withheld — this card rides with a March order, not into a joined battle.";
  }
  if (card.side !== undefined && card.side !== myRole) {
    return card.side === "defender"
      ? "Withheld — this stratagem serves the defender, and this day you attack."
      : "Withheld — this stratagem serves the attacker, and this day you defend.";
  }
  const cardDomain = card.domain ?? "any";
  if (cardDomain !== "any") {
    if (cardDomain === "fleet" && domain !== "fleet") {
      return `Withheld — no fleet stands upon this field; the sea is far from ${locationName}.`;
    }
    if (cardDomain === "land" && domain !== "land") {
      return domain === "fleet"
        ? "Withheld — this is a battle of hulls and oars; no host stands ashore."
        : "Withheld — the hosts stand at a siege, not upon the open field.";
    }
    if (cardDomain === "siege" && domain !== "siege") {
      return domain === "land"
        ? "Withheld — this is a pitched battle, not a siege; there is no gate here to buy."
        : `Withheld — no fleet lays siege; the walls are far from ${locationName}.`;
    }
  }
  // DELTA 1: the treason double-brake, enforced by the engine at declaration
  // (server tactics.ts assertTreasonGate) — mirror it here in voice.
  if (isTreasonCard(card.id)) {
    const gate = treasonWithheldReason(battle, state, locationName);
    if (gate !== null) return gate;
  }
  // One stratagem per side per battle round (server balance.ts TACTIC
  // .maxPlaysPerBattleRound; reactions exempt, but those are withheld above).
  if (committedCount >= MAX_PLAYS_PER_BATTLE_ROUND) {
    return "Withheld — one stratagem per battle may be set beneath the seal, and yours is already committed.";
  }
  // Cost lines verbatim from lore/ui-text.md §7 (coin & resources).
  if (card.costGold !== undefined && treasury.gold < card.costGold) {
    return "Not enough gold in the treasury.";
  }
  if (card.costFaith !== undefined && treasury.faith < card.costFaith) {
    return "The people's faith will not stretch so far.";
  }
  return null;
}

export function TacticPanel(props: TacticPanelProps): JSX.Element | null {
  const { battle, myRole, locationName, rivalName } = props;
  const { gameState, myPlayerId, dispatch, pendingAction } = useGame();
  const { playSfx } = useAudio();

  // Spectators cannot commit stratagems into another crown's battle.
  if (myRole === null) return null;

  const self = me(gameState, myPlayerId);
  const hand: TacticCardId[] = self?.tacticHand ?? [];
  const treasury = { gold: self?.treasury.gold ?? 0, faith: self?.treasury.faith ?? 0 };
  const domain = battleDomain(battle);

  const mine = (myRole === "attacker" ? battle.attackerTactics : battle.defenderTactics) ?? [];
  const theirs =
    (myRole === "attacker" ? battle.defenderTactics : battle.attackerTactics) ?? [];
  // The projection replaces the rival's committed ids with "hidden" stubs —
  // the COUNT is public knowledge, the faces are not (render sealed).
  const theirsSealed = theirs.length;

  const play = (cardId: TacticCardId): void => {
    playSfx("card_flip");
    dispatch({ type: "PLAY_TACTIC", player: myPlayerId, battleId: battle.id, cardId });
  };

  const domainIcon =
    domain === "fleet" ? ICON_URL.fleet : domain === "siege" ? ICON_URL.siege : ICON_URL.army;

  return (
    <section aria-label="Your tactic hand">
      <p className="cbt-rubric">
        {myRole === "attacker"
          ? "The attacker declares first. The field awaits your seal."
          : theirsSealed > 0
            ? `${rivalName} has set a stratagem beneath the seal. The defender may answer.`
            : "The attacker declares first; then the defender may answer."}
      </p>

      {(mine.length > 0 || theirsSealed > 0) && (
        <div className="cbt-committed" aria-label="Stratagems committed to this battle">
          {mine.map((id, i) => (
            <span className="pill pill--gold" key={`${id}:${i}`}>
              ⚔ {tacticInfo(id).name}
            </span>
          ))}
          {Array.from({ length: theirsSealed }, (_, i) => (
            <span
              className="cbt-sealed"
              key={`sealed:${i}`}
              role="img"
              aria-label={`A sealed stratagem of ${rivalName}, face down`}
            >
              ✕
            </span>
          ))}
        </div>
      )}

      {hand.length === 0 ? (
        <p className="rubric">Your hand is empty; the field must be won with steel alone.</p>
      ) : (
        <div className="cbt-hand">
          {hand.map((id, i) => {
            const card = tacticInfo(id);
            const reason = withheldReason(
              card,
              domain,
              myRole,
              locationName,
              treasury,
              mine.length,
              battle,
              gameState,
            );
            const playable = reason === null;
            return (
              <article
                className={`cbt-card ${playable ? "is-playable" : "is-dimmed"}`}
                key={`${id}:${i}`}
                aria-disabled={playable ? undefined : true}
              >
                <h4>
                  <img src={playable ? domainIcon : ICON_URL.army} alt="" />
                  {card.name}
                </h4>
                {card.flavor !== "" && <p className="cbt-flavor">“{card.flavor}”</p>}
                {card.effect !== "" && (
                  <p className="cbt-effect">
                    <b>Effect:</b> {card.effect}
                  </p>
                )}
                {playable ? (
                  <Button
                    variant="primary"
                    onClick={() => play(id)}
                    disabledReason={
                      pendingAction ? "You wait upon another court. Be patient." : undefined
                    }
                  >
                    Play the Card
                  </Button>
                ) : (
                  <p className="cbt-withheld" title={reason}>
                    {reason}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
