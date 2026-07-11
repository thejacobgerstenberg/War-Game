/**
 * CombatModal — feature area 4 (combat), per design/mockups/combat.html.
 *
 * Two acts, one dialog:
 *  1. THE BATTLE JOINED (battle still in state.pendingBattles): the armies
 *     arrayed (crest, role pill, unit chips, commander line), the modifiers
 *     readout (walls, terrain, weight of numbers — engine magnitudes), the
 *     siege state where one stands, and the tactic hand (attacker declares
 *     first; the rival's committed cards arrive as "hidden" stubs and render
 *     sealed). PLAY_TACTIC is dispatched from the hand; resolution itself is
 *     ENGINE-driven when the COMBAT phase runs.
 *  2. THE RECKONING (battle resolved; its chronicle entry is in state.log):
 *     the dice cascade animates (≤400ms tumble, instant under
 *     prefers-reduced-motion, skippable via "Let the Blow Fall"), then the
 *     reckoning strip, then the result banner (victory laurel / defeat
 *     crimson / neutral porphyry). Dice COUNTS/hits/casualties/rout/winner
 *     are the engine's real numbers from the log entry; pip faces are
 *     derived deterministically (see combat/dice.ts — the projection never
 *     transmits per-die values).
 *
 * Audio (AUDIO_DESIGN + mockup README §4): sword_clash on open,
 * battle_distant loop, music scene BATTLE while open (GAME on close),
 * dice_roll at the cast, bombard_shot when siege guns speak, horn_fanfare /
 * defeat_drum under the banner, card_flip on a tactic play.
 *
 * Routed by OverlayManager whenever state.pendingBattles has an undismissed
 * battle — and kept open with a snapshot through the resolution broadcast so
 * this act 2 can play (see OverlayManager's combat note).
 */
import { useEffect, useRef, useState } from "react";
import type { PendingBattle } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { useAudio } from "../../audio/AudioProvider";
import { Modal, Button, ICON_URL, toRoman } from "../../ui";
import { factionOf, provinceById, seaZoneById } from "../selectors";
import { BUTTONS, FACTION_NAME } from "../uiText";
import { ArmiesArrayed } from "./combat/ArmiesArrayed";
import { DiceCascade } from "./combat/DiceCascade";
import { TacticPanel } from "./combat/TacticPanel";
import { findResolution, initialStrength, sideStrength } from "./combat/resolution";
import type { BattleOutcome } from "./combat/resolution";
import { prefersReducedMotion } from "./combat/dice";
import "./combat/combat.css";

export interface CombatModalProps {
  battle: PendingBattle;
  onClose: () => void;
}

/** Reveal stages of the reckoning. */
type Stage = "cast" | "reckon" | "banner";

/**
 * Modifier rows for the readout (combat.html zone 4). Magnitudes mirror the
 * engine's balance.COMBAT_MODS / WALL_TIERS (server-authoritative; shown here
 * in the design vocabulary — dice, hits, the wall bonus).
 */
interface ModifierRow {
  glyph: string;
  name: string;
  side: "attacker" | "defender";
  text: string;
}

const WALL_DEF_BONUS: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 4 };

export function CombatModal({ battle, onClose }: CombatModalProps): JSX.Element {
  const { gameState, myPlayerId } = useGame();
  const { playSfx, setMusicScene } = useAudio();

  const attackerFaction = factionOf(gameState, battle.attackerId);
  const defenderFaction =
    battle.defenderId !== null ? factionOf(gameState, battle.defenderId) : null;
  const attackerName =
    attackerFaction !== null ? FACTION_NAME[attackerFaction] : "An unknown host";
  const defenderName =
    defenderFaction !== null ? FACTION_NAME[defenderFaction] : "the garrison";

  const prov =
    battle.provinceId !== undefined ? provinceById(gameState, battle.provinceId) : null;
  const zone =
    battle.seaZoneId !== undefined ? seaZoneById(gameState, battle.seaZoneId) : null;
  const locationName = prov?.name ?? zone?.name ?? "the field";
  const title =
    zone !== null
      ? `The Battle of ${zone.name}`
      : battle.isSiege === true
        ? `The Siege of ${locationName}`
        : prov !== null
          ? `The Field at ${prov.name}`
          : "The Field of Battle";

  const myRole: "attacker" | "defender" | null =
    battle.attackerId === myPlayerId
      ? "attacker"
      : battle.defenderId === myPlayerId
        ? "defender"
        : null;

  const pending = gameState.pendingBattles.some((b) => b.id === battle.id);
  const outcome: BattleOutcome | null = pending ? null : findResolution(gameState, battle);

  // ---- Audio: battle scene while open, back to the campaign on close. ----
  useEffect(() => {
    setMusicScene("BATTLE");
    playSfx("sword_clash");
    playSfx("battle_distant");
    return () => setMusicScene("GAME");
  }, []);

  // ---- Reveal stage machine (runs once when the resolution arrives). ----
  const [stage, setStage] = useState<Stage | null>(null);
  const [showDiceAtBanner, setShowDiceAtBanner] = useState(false);
  const revealedFor = useRef<string | null>(null);
  const bannerSounded = useRef(false);
  useEffect(() => {
    if (outcome === null || revealedFor.current === outcome.entry.id) return;
    revealedFor.current = outcome.entry.id;
    const showsDice = outcome.kind === "field" || outcome.kind === "naval";
    if (showsDice) playSfx("dice_roll");
    if (outcome.kind === "siege" || outcome.kind === "invest") playSfx("bombard_shot");
    if (prefersReducedMotion() || !showsDice) {
      setStage("banner");
      return;
    }
    setStage("cast");
    const t1 = window.setTimeout(() => setStage("reckon"), 700);
    const t2 = window.setTimeout(() => setStage("banner"), 1700);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [outcome?.entry.id]);

  // ---- Banner sting: horn for my triumph, drum for my defeat. ----
  const result: "victory" | "defeat" | "neutral" =
    outcome === null || myRole === null || outcome.winnerId === null
      ? "neutral"
      : outcome.winnerId === myPlayerId
        ? "victory"
        : battle.attackerId === myPlayerId || battle.defenderId === myPlayerId
          ? "defeat"
          : "neutral";
  useEffect(() => {
    if (stage !== "banner" || outcome === null || bannerSounded.current) return;
    bannerSounded.current = true;
    if (result === "victory") playSfx("horn_fanfare");
    else if (result === "defeat") playSfx("defeat_drum");
  }, [stage, outcome === null]);

  // ---- Shared header ----
  const rubric = pending
    ? `Round ${toRoman(gameState.round)} · ${attackerName} gives battle against ${defenderName}${
        battle.isSiege === true ? " beneath the walls" : ""
      }${battle.amphibious === true ? ", coming from the sea" : ""}.`
    : `Round ${toRoman(gameState.round)} · The chronicle records what passed at ${locationName}.`;

  const header = (
    <header className="cbt-head">
      <p className="cbt-rubric">
        <img className="cbt-glyph" src={ICON_URL["phase-battle"]} alt="" />
        {rubric}
      </p>
    </header>
  );

  // ---- Armies arrayed (live strengths; casualties once resolved) ----
  const atk = sideStrength(gameState, battle, "attacker");
  const def = sideStrength(gameState, battle, "defender");
  const armies = (
    <ArmiesArrayed
      attacker={{
        role: "attacker",
        faction: attackerFaction,
        fallbackName: attackerName,
        units: atk.units,
        fallen: outcome?.attackerLosses,
      }}
      defender={{
        role: "defender",
        faction: defenderFaction,
        fallbackName: defenderName,
        units: def.units,
        fallen: outcome?.defenderLosses,
      }}
    />
  );

  return (
    <Modal
      title={title}
      onClose={onClose}
      dismissable={false}
      wide
      className="cbt-modal"
    >
      {header}
      {armies}
      <hr className="cbt-rule" />
      {pending ? (
        <PendingBody
          battle={battle}
          myRole={myRole}
          locationName={locationName}
          rivalName={myRole === "attacker" ? defenderName : attackerName}
          modifiers={buildModifiers(atk.total, def.total, battle, prov)}
          onClose={onClose}
          siege={
            prov?.siege !== undefined
              ? {
                  grainStores: prov.siege.grainStores,
                  rounds: prov.siege.roundsElapsed,
                  breached: prov.siege.breached,
                }
              : null
          }
          walls={prov !== null && prov.walls.tier > 0 ? prov.walls : null}
        />
      ) : outcome !== null ? (
        <ResolvedBody
          battle={battle}
          outcome={outcome}
          stage={
            stage ??
            // First paint before the reveal effect runs: dice kinds open on
            // the cast, everything else lands straight on the banner.
            (outcome.kind === "field" || outcome.kind === "naval" ? "cast" : "banner")
          }
          onSkip={() => setStage("banner")}
          showDiceAtBanner={showDiceAtBanner}
          onToggleDice={() => setShowDiceAtBanner((v) => !v)}
          result={result}
          names={{ attackerName, defenderName, locationName }}
          initial={{
            attacker: initialStrength(gameState, battle, "attacker", outcome.attackerLosses),
            defender: initialStrength(gameState, battle, "defender", outcome.defenderLosses),
          }}
          myLosses={
            myRole === "attacker"
              ? outcome.attackerLosses
              : myRole === "defender"
                ? outcome.defenderLosses
                : 0
          }
          onClose={onClose}
        />
      ) : (
        <>
          <p className="rubric">The chronicle records the clash; the field is quiet.</p>
          <div className="modal-actions">
            <Button variant="quiet" onClick={onClose}>
              {BUTTONS.close}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------------------
 * Act 1 — the battle joined, awaiting the engine's reckoning.
 * ------------------------------------------------------------------------ */

function buildModifiers(
  atkTotal: number,
  defTotal: number,
  battle: PendingBattle,
  prov: { terrain: string; walls: { tier: number; hp: number } } | null,
): ModifierRow[] {
  const rows: ModifierRow[] = [];
  if (prov !== null && prov.walls.tier > 0 && prov.walls.hp > 0) {
    const bonus = WALL_DEF_BONUS[prov.walls.tier] ?? 0;
    rows.push({
      glyph: "⛨",
      name: `Walls ${toRoman(prov.walls.tier)}`,
      side: "defender",
      text: `The defender stands behind standing walls: defender +${bonus} while the wall holds, and the attacker storms at −1 (escalade).`,
    });
  }
  if (
    prov !== null &&
    (prov.terrain === "HILLS" || prov.terrain === "MOUNTAINS" || prov.terrain === "FOREST")
  ) {
    rows.push({
      glyph: "⛨",
      name: "High Ground",
      side: "defender",
      text: "The defender holds broken country — hills, mountains or forest: defender +1 each round.",
    });
  }
  if (battle.amphibious === true) {
    rows.push({
      glyph: "≋",
      name: "From the Sea",
      side: "attacker",
      text: "The attacker comes ashore under arms: the attacker fights at −1 this battle.",
    });
  }
  if (defTotal > 0 && atkTotal >= 2 * defTotal) {
    rows.push({
      glyph: "⚔",
      name: "Weight of Numbers",
      side: "attacker",
      text: "The attacker outnumbers the defender two to one or more: attacker +1 each round.",
    });
  } else if (atkTotal > 0 && defTotal >= 2 * atkTotal) {
    rows.push({
      glyph: "⚔",
      name: "Weight of Numbers",
      side: "defender",
      text: "The defender outnumbers the attacker two to one or more: defender +1 each round.",
    });
  }
  if (prov !== null && prov.terrain === "PLAINS") {
    rows.push({
      glyph: "⚔",
      name: "Cavalry Charge",
      side: "attacker",
      text: "Open plain: charging horse strikes at +1 for the attacker.",
    });
  }
  return rows;
}

function PendingBody(props: {
  battle: PendingBattle;
  myRole: "attacker" | "defender" | null;
  locationName: string;
  rivalName: string;
  modifiers: ModifierRow[];
  siege: { grainStores: number; rounds: number; breached: boolean } | null;
  walls: { tier: number; hp: number } | null;
  onClose: () => void;
}): JSX.Element {
  const { battle, myRole, locationName, rivalName, modifiers, siege, walls, onClose } =
    props;
  return (
    <>
      {modifiers.length > 0 && (
        <>
          <section aria-label="Modifiers upon this battle">
            <ul className="cbt-modifiers">
              {modifiers.map((m) => (
                <li key={m.name}>
                  <span className="cbt-mod-glyph" aria-hidden="true">
                    {m.glyph}
                  </span>
                  <span className="cbt-mod-name">{m.name}</span>
                  <span className={`pill ${m.side === "attacker" ? "pill--gold" : "pill--lapis"}`}>
                    {m.side === "attacker" ? "Attacker" : "Defender"}
                  </span>
                  <span>{m.text}</span>
                </li>
              ))}
            </ul>
          </section>
          <hr className="cbt-rule" />
        </>
      )}

      {(siege !== null || (battle.isSiege === true && walls !== null)) && (
        <>
          <div className="cbt-siege" aria-label="The state of the siege">
            {walls !== null && (
              <span className="pill pill--lapis">
                ⛨ Walls {toRoman(walls.tier)}
                {walls.hp > 0 ? ` · ${walls.hp} of the wall stands` : " · breached"}
              </span>
            )}
            {siege !== null && (
              <>
                <span className="pill">
                  Besieged {siege.rounds === 1 ? "one round" : `${siege.rounds} rounds`}
                </span>
                <span className="pill">
                  {siege.grainStores > 0
                    ? `Stores for ${siege.grainStores} ${siege.grainStores === 1 ? "round" : "rounds"}`
                    : "The granaries are bare — no grain to spare."}
                </span>
                {siege.breached && <span className="pill pill--crimson">The wall is breached</span>}
              </>
            )}
          </div>
          <hr className="cbt-rule" />
        </>
      )}

      <TacticPanel
        battle={battle}
        myRole={myRole}
        locationName={locationName}
        rivalName={rivalName}
      />

      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose} title="Return to the board; the battle stands">
          {BUTTONS.close}
        </Button>
      </div>
    </>
  );
}

/* --------------------------------------------------------------------------
 * Act 2 — the reckoning: dice cascade, then the result banner.
 * ------------------------------------------------------------------------ */

function ResolvedBody(props: {
  battle: PendingBattle;
  outcome: BattleOutcome;
  stage: Stage;
  onSkip: () => void;
  showDiceAtBanner: boolean;
  onToggleDice: () => void;
  result: "victory" | "defeat" | "neutral";
  names: { attackerName: string; defenderName: string; locationName: string };
  initial: { attacker: number; defender: number };
  myLosses: number;
  onClose: () => void;
}): JSX.Element {
  const {
    battle,
    outcome,
    stage,
    onSkip,
    showDiceAtBanner,
    onToggleDice,
    result,
    names,
    initial,
    myLosses,
    onClose,
  } = props;
  const showsDice = outcome.kind === "field" || outcome.kind === "naval";
  const notes: string[] = [];
  if (outcome.rounds > 1) {
    notes.push(`So it goes for ${outcome.rounds} rounds of battle before the field is decided.`);
  }
  if (outcome.attackerRouted) {
    notes.push(`${names.attackerName}'s host breaks and is ridden down in the pursuit.`);
  }
  if (outcome.defenderRouted) {
    notes.push(`${names.defenderName}'s host breaks and is ridden down in the pursuit.`);
  }

  const diceVisible = showsDice && (stage !== "banner" || showDiceAtBanner);

  return (
    <>
      {diceVisible && (
        <DiceCascade
          attacker={{
            count: initial.attacker,
            hits: outcome.defenderLosses,
            seed: `${battle.id}:attacker`,
          }}
          defender={{
            count: initial.defender,
            hits: outcome.attackerLosses,
            seed: `${battle.id}:defender`,
          }}
          attackerName={names.attackerName}
          defenderName={names.defenderName}
          rolling={stage === "cast"}
          notes={notes}
          showReckoning={stage !== "cast"}
        />
      )}

      {stage !== "banner" ? (
        <div className="modal-actions">
          <Button variant="primary" onClick={onSkip}>
            Let the Blow Fall
          </Button>
        </div>
      ) : (
        <>
          {showsDice && showDiceAtBanner && <hr className="cbt-rule" />}
          <ResultBanner
            outcome={outcome}
            result={result}
            names={names}
            myLosses={myLosses}
            onClose={onClose}
          />
          {showsDice && (
            <div className="modal-actions">
              <Button variant="quiet" onClick={onToggleDice} aria-pressed={showDiceAtBanner}>
                Review the Reckoning
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

/** The one banner the table sees (combat.html zone 6). */
function ResultBanner(props: {
  outcome: BattleOutcome;
  result: "victory" | "defeat" | "neutral";
  names: { attackerName: string; defenderName: string; locationName: string };
  myLosses: number;
  onClose: () => void;
}): JSX.Element {
  const { outcome, result, names, myLosses, onClose } = props;
  const { attackerName, defenderName, locationName } = names;
  const winnerName =
    outcome.winnerId !== null
      ? outcome.entry.actors[0] === outcome.winnerId
        ? attackerName
        : defenderName
      : null;

  let heading: string;
  let body: string;
  let closeLabel: string;
  if (result === "victory") {
    heading = "The Day Is Yours";
    closeLabel = "So It Is Written";
    if (outcome.kind === "occupation") {
      // lore/ui-text.md §7 success toast, verbatim.
      body = "The city has fallen. Its keys are yours.";
    } else if (outcome.captured) {
      // lore/chronicle/TEMPLATES.md "City falls / captured", placeholders filled.
      body = `${locationName} is taken. Your banners climb the walls, and ${
        outcome.winnerId === outcome.entry.actors[0] ? defenderName : attackerName
      } counts the loss in stone and blood.`;
    } else if (outcome.kind === "naval") {
      body = `The enemy is swept from ${locationName}, and the sea lane answers to your banners.`;
    } else {
      // design/mockups/combat.html victory banner, placeholder filled.
      body = `The enemy host breaks and streams from the field. ${locationName} is held, and the chronicle will say so.`;
    }
  } else if (result === "defeat") {
    heading = "The Field Is Lost";
    closeLabel = "Let the Scribes Be Kind";
    // design/mockups/combat.html defeat banner, placeholders filled.
    body = `Your host breaks; what remains of it retires from the field. ${
      winnerName ?? "The enemy"
    } holds the ground, and the chronicle is theirs to write.`;
  } else {
    closeLabel = BUTTONS.close;
    switch (outcome.kind) {
      case "barred":
        heading = "The Chain Holds";
        body = `The chain across the harbour bars an amphibious assault on ${locationName}.`;
        break;
      case "frozen":
        heading = "The Sea Is Locked";
        body = `Ice locks ${locationName}; no naval battle is fought.`;
        break;
      case "invest":
        heading = "The Siege Begins";
        body = `${attackerName} invests ${locationName}; the siege begins.${
          outcome.grainStores !== undefined
            ? ` The garrison holds stores for ${outcome.grainStores} ${
                outcome.grainStores === 1 ? "round" : "rounds"
              }.`
            : ""
        }`;
        break;
      case "siege":
        heading = outcome.captured ? "The Walls Give Way" : "The Siege Grinds On";
        body = outcome.captured
          ? // lore/chronicle/TEMPLATES.md "City falls / captured", placeholders filled.
            `The walls of ${locationName} hold no longer. ${attackerName} enters as master, and ${defenderName} is poorer by a city.`
          : [
              outcome.wallDamage !== undefined && outcome.wallDamage > 0
                ? `The guns speak: the wall loses ${outcome.wallDamage}.`
                : "The guns are silent this round.",
              outcome.breached === true ? "The wall is breached; the storm may come." : null,
              outcome.starved !== undefined && outcome.starved > 0
                ? `Hunger takes ${outcome.starved} of the garrison.`
                : null,
              outcome.resupplied === true
                ? "An open sea lane keeps the garrison fed."
                : null,
              outcome.wallHp !== undefined
                ? `${outcome.wallHp} of the wall still stands.`
                : null,
            ]
              .filter((s): s is string => s !== null)
              .join(" ");
        break;
      case "occupation":
        heading = "The Ground Is Taken";
        body = `${attackerName} occupies ${locationName} unopposed.`;
        break;
      default:
        heading = "Night Parts the Hosts";
        body =
          outcome.winnerId === null
            ? "Neither host yields the field; the matter is deferred to another day."
            : `${winnerName ?? attackerName} prevails at ${locationName}. The chronicle takes note.`;
    }
  }

  return (
    <div
      className={`cbt-banner cbt-banner--${result}`}
      role="status"
      aria-label={`Battle result: ${heading}`}
    >
      {result === "victory" ? (
        <span className="cbt-banner-glyph">
          <img src={ICON_URL.prestige} alt="" />
        </span>
      ) : (
        <span className="cbt-banner-glyph" aria-hidden="true">
          {result === "defeat" ? "⚑" : "⛨"}
        </span>
      )}
      <div className="cbt-banner-body">
        <h3>{heading}</h3>
        <p>{body}</p>
      </div>
      {result === "victory" && outcome.prestige > 0 && (
        <span className="pill pill--gold">+{outcome.prestige} Prestige</span>
      )}
      {outcome.sacked && <span className="pill pill--crimson">The city is put to the sack</span>}
      {result === "defeat" && myLosses > 0 && (
        <span className="pill">
          {myLosses} {myLosses === 1 ? "levy falls" : "levies fall"}
        </span>
      )}
      <Button variant={result === "defeat" ? "default" : "primary"} onClick={onClose}>
        {closeLabel}
      </Button>
    </div>
  );
}
