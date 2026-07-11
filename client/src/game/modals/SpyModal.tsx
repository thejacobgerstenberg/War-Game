/**
 * SpyModal — "The Whisperers": the Whisper order (SPY action).
 *
 * Engine reality mirrored here (server/src/engine/spy.ts + balance.SPY):
 *  - A mission costs 1 deed + 3 gold, paid whether it prospers or fails.
 *  - One d6 roll, success on ≥ 3; a rival that owns a University raises the
 *    needed cast by 1, and Byzantium as the target resists (+1) — both stack.
 *  - Missions: OMEN peeks the top Omen card; OBJECTIVE unseals one rival's
 *    hidden ambition; UNREST stirs an enemy province so it yields nothing
 *    next Income.
 *  - Capture: −1 Prestige (−2 for incite unrest), and the target is warned.
 *  - Results return as log entries whose data.visibleTo names only you —
 *    the projection strips them from every other court. Rendered below as
 *    "The Whisper Returns".
 *
 * Copy: lore/tutorial/script.md steps 18–19 (mission glosses quoted from the
 * Grand Logothete's counsel), lore/ui-text.md §7 for shortfalls.
 *
 * Opened by OverlayManager on intent {type:"spy", targetPlayerId?}.
 */
import { useMemo, useState } from "react";
import { BuildingType, Faction, GamePhase, SpyMission } from "@imperium/shared";
import type { GameLogEntry, GameState, Player } from "@imperium/shared";
import { Button, CREST_URL, IconChip, Modal, toRoman } from "../../ui";
import { useAudio } from "../../audio/AudioProvider";
import { useGame } from "../GameProvider";
import { isMyTurn, provinceById } from "../selectors";
import { ACTION_ERROR_COPY, BUTTONS, FACTION_NAME, PHASE_NAME } from "../uiText";
import "./court.css";

/* ---------------------------------------------------------------------------
 * Vendored engine numbers (client may not import server code).
 * PROVENANCE: server/src/engine/balance.ts SPY { goldCost 3, baseTarget 3,
 * universityPenalty 1, byzantiumResist 1, captureFailPrestige −1,
 * inciteUnrestFailPrestige −2 }. Re-copy when tuned.
 * ------------------------------------------------------------------------- */
const SPY = {
  goldCost: 3,
  baseTarget: 3,
  universityPenalty: 1,
  byzantiumResist: 1,
  captureFailPrestige: -1,
  inciteUnrestFailPrestige: -2,
} as const;

const NUMBER_WORDS = [
  "nought", "one", "two", "three", "four", "five", "six",
] as const;
function numberWord(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

/** Mission names + glosses. Glosses quote lore/tutorial/script.md step-18. */
const MISSIONS: readonly {
  mission: SpyMission;
  name: string;
  gloss: string;
}[] = [
  {
    mission: SpyMission.OMEN,
    name: "Read the Omens",
    gloss: "Read the coming omen before God turns the page.",
  },
  {
    mission: SpyMission.OBJECTIVE,
    name: "Unseal an Ambition",
    gloss: "Unseal one rival's hidden ambition.",
  },
  {
    mission: SpyMission.UNREST,
    name: "Stir Unrest",
    gloss: "Stir a province to unrest so it yields its master nothing.",
  },
];

/** Prettify a card slug for intel display (no client-side event-card data). */
function slugToName(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** §10.7 target-number modifiers, mirrored from spy.ts for the risk line. */
function ownsUniversity(state: GameState, playerId: string): boolean {
  return state.provinces.some(
    (p) => p.ownerId === playerId && p.buildings.includes(BuildingType.UNIVERSITY),
  );
}

export interface SpyModalProps {
  /** Pre-selected rival, when opened from a context that names one. */
  targetPlayerId?: string;
  onClose: () => void;
}

export function SpyModal({ targetPlayerId, onClose }: SpyModalProps): JSX.Element {
  const { gameState, myPlayerId, dispatch, pendingAction, timer } = useGame();
  const { playSfx } = useAudio();

  const my = gameState.players.find((p) => p.id === myPlayerId) ?? null;
  const rivals = gameState.players.filter((p) => p.id !== myPlayerId);

  const [mission, setMission] = useState<SpyMission | null>(null);
  const [rivalId, setRivalId] = useState<string | null>(targetPlayerId ?? null);
  const [provinceId, setProvinceId] = useState<string | null>(null);

  /* ---- act gating: SPY is a budgeted deed in the action window. ------------ */
  const myTurn = isMyTurn(gameState, myPlayerId, timer);
  const inWindow =
    gameState.phase === GamePhase.RECRUITMENT ||
    gameState.phase === GamePhase.MOVEMENT ||
    gameState.phase === GamePhase.DIPLOMACY;
  const deeds = my?.actionsRemaining ?? 0;
  const goldShort = (my?.treasury.gold ?? 0) < SPY.goldCost;
  const actReason = !myTurn
    ? ACTION_ERROR_COPY.NOT_YOUR_TURN
    : !inWindow
      ? "You wait upon another court. Be patient."
      : deeds <= 0
        ? ACTION_ERROR_COPY.NO_ACTIONS
        : goldShort
          ? "Not enough gold in the treasury."
          : undefined;

  /* ---- targets -------------------------------------------------------------- */
  const enemyProvinces = useMemo(
    () =>
      gameState.provinces.filter((p) => p.ownerId !== null && p.ownerId !== myPlayerId),
    [gameState.provinces, myPlayerId],
  );

  // The rival whose court lengthens the odds (spy.ts: OBJECTIVE names them,
  // UNREST derives them from the province owner, OMEN has none).
  const rival: Player | null =
    mission === SpyMission.OBJECTIVE
      ? rivals.find((r) => r.id === rivalId) ?? null
      : mission === SpyMission.UNREST && provinceId
        ? gameState.players.find(
            (p) => p.id === provinceById(gameState, provinceId)?.ownerId,
          ) ?? null
        : null;

  const targetNumber =
    SPY.baseTarget +
    (rival && ownsUniversity(gameState, rival.id) ? SPY.universityPenalty : 0) +
    (rival?.faction === Faction.BYZANTIUM ? SPY.byzantiumResist : 0);

  const capturePenalty =
    mission === SpyMission.UNREST ? SPY.inciteUnrestFailPrestige : SPY.captureFailPrestige;

  const targetChosen =
    mission === SpyMission.OMEN ||
    (mission === SpyMission.OBJECTIVE && rivalId !== null) ||
    (mission === SpyMission.UNREST && provinceId !== null);

  const seal = (): void => {
    if (!mission || !targetChosen) return;
    playSfx("quill_scratch");
    dispatch({
      type: "SPY",
      player: myPlayerId,
      mission,
      ...(mission === SpyMission.OBJECTIVE && rivalId ? { targetPlayerId: rivalId } : {}),
      ...(mission === SpyMission.UNREST && provinceId
        ? { targetProvinceId: provinceId }
        : {}),
    });
  };

  /* ---- intel: visibleTo-filtered log entries (mine survive projection). ----- */
  const myReports = useMemo(
    () =>
      gameState.log
        .filter((e: GameLogEntry) => e.type === "spy" && e.actors.includes(myPlayerId))
        .slice(-6)
        .reverse(),
    [gameState.log, myPlayerId],
  );
  const caughtAtMyCourt = useMemo(
    () =>
      gameState.log
        .filter(
          (e: GameLogEntry) =>
            e.type === "spy" &&
            !e.actors.includes(myPlayerId) &&
            (e.targets ?? []).includes(myPlayerId) &&
            e.data?.captured === true,
        )
        .slice(-3)
        .reverse(),
    [gameState.log, myPlayerId],
  );

  const intelLine = (e: GameLogEntry): string | null => {
    const d = e.data ?? {};
    if (d.captured === true) return null;
    if (typeof d.omenTopCardId === "string") {
      return `The top Omen of the deck: ${slugToName(d.omenTopCardId)}.`;
    }
    if (typeof d.objectiveDescription === "string") {
      return `The sealed ambition reads: "${d.objectiveDescription}"`;
    }
    if (typeof d.suppressedProvinceId === "string") {
      const prov = provinceById(gameState, d.suppressedProvinceId);
      return `${prov?.name ?? d.suppressedProvinceId} will yield its master nothing next Income.`;
    }
    return null;
  };

  return (
    <Modal title="The Whisperers" onClose={onClose}>
      <p className="rubric">
        &ldquo;I keep two ledgers, Majesty: one of coin, one of secrets. Send an agent to a
        rival court and choose his errand. It is cheaper than a war and far quieter than a
        truce.&rdquo;
      </p>

      {/* The errand — one of the three §10.7 missions. */}
      <div className="spy-missions" role="radiogroup" aria-label="The errand">
        {MISSIONS.map((m) => (
          <Button
            key={m.mission}
            className="spy-mission-btn"
            selected={mission === m.mission}
            onClick={() => {
              playSfx("ui_click");
              setMission(m.mission);
            }}
          >
            <span>
              <span className="spy-mission-name">{m.name}</span>
              <span className="spy-mission-gloss">{m.gloss}</span>
            </span>
          </Button>
        ))}
      </div>

      {/* Target pickers. */}
      {mission === SpyMission.OBJECTIVE && (
        <div className="dip-composer-row" role="radiogroup" aria-label="The rival court">
          <span className="dip-composer-label">The court</span>
          {rivals.map((r) => (
            <Button
              key={r.id}
              selected={rivalId === r.id}
              onClick={() => {
                playSfx("ui_click");
                setRivalId(r.id);
              }}
              icon={
                r.faction ? <img src={CREST_URL[r.faction]} alt="" /> : undefined
              }
            >
              {r.faction ? FACTION_NAME[r.faction] : r.name}
            </Button>
          ))}
        </div>
      )}
      {mission === SpyMission.UNREST && (
        <div className="dip-composer-row">
          <label className="dip-composer-label" htmlFor="spy-province">
            The province
          </label>
          <select
            id="spy-province"
            className="dip-field"
            value={provinceId ?? ""}
            onChange={(e) => setProvinceId(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">Choose a province upon the map</option>
            {enemyProvinces.map((p) => {
              const owner = gameState.players.find((x) => x.id === p.ownerId);
              const ownerName = owner
                ? owner.faction
                  ? FACTION_NAME[owner.faction]
                  : owner.name
                : "";
              return (
                <option key={p.id} value={p.id}>
                  {p.name} — {ownerName}
                </option>
              );
            })}
          </select>
        </div>
      )}

      {/* The price and the risk — real numbers from the engine. */}
      {mission !== null && (
        <>
          <div className="spy-cost-row">
            <IconChip
              icon="gold"
              label="Gold"
              value={SPY.goldCost}
              short={goldShort}
              shortReason="Not enough gold in the treasury."
            />
            <span className="rubric">and one deed, paid whether the errand prospers or fails.</span>
          </div>
          <p className="spy-risk">
            The errand prospers on a cast of {numberWord(targetNumber)} or better upon the
            die
            {rival
              ? ` — ${rival.faction ? FACTION_NAME[rival.faction] : rival.name}${
                  ownsUniversity(gameState, rival.id)
                    ? "'s University lengthens the odds"
                    : rival.faction === Faction.BYZANTIUM
                      ? " resists the whisperers"
                      : "'s court keeps no special watch"
                }${
                  ownsUniversity(gameState, rival.id) && rival.faction === Faction.BYZANTIUM
                    ? ", and Byzantium resists besides"
                    : ""
                }`
              : ""}
            . If the agent is captured, {numberWord(Math.abs(capturePenalty))} Prestige{" "}
            {Math.abs(capturePenalty) === 1 ? "is" : "are"} struck from your name, and the
            rival court is told.
          </p>
        </>
      )}

      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          {BUTTONS.close}
        </Button>
        <Button
          variant="primary"
          onClick={seal}
          disabled={pendingAction || mission === null || !targetChosen}
          disabledReason={
            actReason ??
            (mission === null
              ? "Choose the agent's errand first."
              : !targetChosen
                ? "Name the errand's target first."
                : undefined)
          }
        >
          {BUTTONS.setTheSeal}
        </Button>
      </div>

      {/* The Whisper Returns — visibleTo-filtered intel from the chronicle. */}
      {(myReports.length > 0 || caughtAtMyCourt.length > 0) && (
        <>
          <h3 className="dip-section-title">The Whisper Returns</h3>
          <p className="rubric">
            &ldquo;The whisper has come home; read it slowly. And remember that every court on
            this map keeps a man like mine — assume you are read in turn, and move
            accordingly.&rdquo;
          </p>
          <div className="spy-reports">
            {myReports.map((e) => (
              <div
                key={e.id}
                className={
                  e.data?.captured === true ? "spy-report spy-report--caught" : "spy-report"
                }
              >
                <span className="spy-report-when">
                  Round {toRoman(e.round)} — {PHASE_NAME[e.phase]}
                </span>
                {e.message}
                {intelLine(e) !== null && (
                  <p className="spy-report-intel">{intelLine(e)}</p>
                )}
              </div>
            ))}
            {caughtAtMyCourt.map((e) => (
              <div key={e.id} className="spy-report spy-report--caught">
                <span className="spy-report-when">
                  Round {toRoman(e.round)} — {PHASE_NAME[e.phase]}
                </span>
                An enemy agent was caught listening at your court.
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
