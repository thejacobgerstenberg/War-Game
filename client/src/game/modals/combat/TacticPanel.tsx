/**
 * TacticPanel — combat.html zone 5: the tactic hand while a battle is
 * pending. Playable cards carry the gold rim and a "Play the Card" button
 * (dispatches PLAY_TACTIC, plays card_flip); withheld cards dim to 0.5 and
 * state their reason in voice, visible AND on hover/focus (README §1).
 *
 * §7.7 order of declaration: the attacker commits first, then the defender —
 * the rubric above the hand says whose seal the field awaits. The projection
 * shows only YOUR side's committed tactic ids; the rival's arrive as
 * "hidden" stubs and render face-down (sealed).
 */
import type { PendingBattle, TacticCardId } from "@imperium/shared";
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
            const reason = withheldReason(card, domain, myRole, locationName, treasury);
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
