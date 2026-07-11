/**
 * GreatWorksModal — "The Great Works": the four multi-round prestige
 * constructions (GreatWorkType), dispatched as BUILD actions.
 *
 * Engine reality mirrored here (server/src/engine/economy.ts::applyBuild +
 * balance.GREAT_WORK_COSTS):
 *  - The FIRST invest pays the work's full cost up front and counts one deed
 *    of building; every further invest is one more deed, no further cost.
 *  - A work is complete when its invested deeds reach its round count; the
 *    engine then pays the one-time Prestige and applies the effect
 *    (Theodosian Walls set the province to the top wall tier: 16 wall
 *    points, defence +4).
 *  - Any province you own may host a work; only ownership gates the site.
 *  - church_bell on completion (watched from state.log below).
 *
 * Copy: lore/tutorial/tips.md (the marble and walls lines), lore/ui-text.md
 * §3/§7. Opened by OverlayManager on intent {type:"greatWorks", provinceId?}.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GamePhase, GreatWorkType } from "@imperium/shared";
import type { GameLogEntry, Province, ResourceBundle } from "@imperium/shared";
import { Button, IconChip, Modal, toRoman, useToast } from "../../ui";
import type { ResourceIconName } from "../../ui";
import { useAudio } from "../../audio/AudioProvider";
import { useGame } from "../GameProvider";
import { isMyTurn, provinceById } from "../selectors";
import { ACTION_ERROR_COPY, BUTTONS, FACTION_NAME } from "../uiText";
import "./court.css";

/* ---------------------------------------------------------------------------
 * Vendored engine numbers (client may not import server code).
 * PROVENANCE: server/src/engine/balance.ts GREAT_WORK_COSTS — costs, build
 * rounds (deeds), one-time completion prestige — and the effect behavior in
 * economy.ts (completeGreatWork: Theodosian Walls → tier 5, 16 HP / +4;
 * Grand Bazaar → best trade ratio, +3 gold per route from its port;
 * Great University effects "+2-card-draw-per-round" / "tactic-reroll-aura";
 * Hagia Sophia effects "unlock-byzantine-cards"). Re-copy when tuned.
 * ------------------------------------------------------------------------- */
interface WorkDef {
  type: GreatWorkType;
  name: string;
  cost: Partial<ResourceBundle>;
  rounds: number;
  prestige: number;
  /** Mechanical effect, stated plainly from the engine's effect tags. */
  effect: string;
  /** True color of the age, quoted from lore/tutorial/tips.md where it exists. */
  flavor?: string;
}

const WORKS: readonly WorkDef[] = [
  {
    type: GreatWorkType.HAGIA_SOPHIA,
    name: "Hagia Sophia",
    cost: { gold: 20, marble: 10, faith: 8 },
    rounds: 3,
    prestige: 10,
    effect: "A restoration for the ages; it opens the Byzantine cards.",
  },
  {
    type: GreatWorkType.THEODOSIAN_WALLS,
    name: "The Theodosian Walls",
    cost: { gold: 15, marble: 12 },
    rounds: 2,
    prestige: 6,
    effect:
      "Raises the province's walls to the highest tier — sixteen wall points and a defence of four.",
    flavor:
      "The Theodosian walls turned armies away for a thousand years: a ditch, an outer wall, an inner wall, and a proverb that the City does not fall.",
  },
  {
    type: GreatWorkType.GREAT_UNIVERSITY,
    name: "The Great University",
    cost: { gold: 18, marble: 8, faith: 4 },
    rounds: 3,
    prestige: 6,
    effect: "Two more cards drawn each round, and a reroll about your stratagems.",
  },
  {
    type: GreatWorkType.GRAND_BAZAAR,
    name: "The Grand Bazaar",
    cost: { gold: 16, timber: 6, marble: 6 },
    rounds: 2,
    prestige: 5,
    effect:
      "The best ratio in the counting-house, and three Gold more on every route from its port.",
  },
];

/** ui-text.md §7 shortfall lines, per store. */
const SHORT_REASON: Record<ResourceIconName, string> = {
  gold: "Not enough gold in the treasury.",
  grain: "The granaries are bare — no grain to spare.",
  timber: "The woodyards are empty — no timber for keel, wall, or engine.",
  marble: "The quarries have given their last — no marble for the work.",
  faith: "The people's faith will not stretch so far.",
};
const STORE_LABEL: Record<ResourceIconName, string> = {
  gold: "Gold",
  grain: "Grain",
  timber: "Timber",
  marble: "Marble",
  faith: "Faith",
};
const STORES: readonly ResourceIconName[] = ["gold", "grain", "timber", "marble", "faith"];

const NUMBER_WORDS = ["nought", "one", "two", "three", "four", "five", "six"] as const;
function numberWord(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

export interface GreatWorksModalProps {
  /** Preselected site, when the door was a province card. */
  provinceId?: string;
  onClose: () => void;
}

export function GreatWorksModal({ provinceId, onClose }: GreatWorksModalProps): JSX.Element {
  const { gameState, myPlayerId, dispatch, pendingAction, timer } = useGame();
  const { playSfx } = useAudio();
  const toast = useToast();

  const my = gameState.players.find((p) => p.id === myPlayerId) ?? null;
  const myProvinces = useMemo(
    () => gameState.provinces.filter((p) => p.ownerId === myPlayerId),
    [gameState.provinces, myPlayerId],
  );

  const [chosenWork, setChosenWork] = useState<GreatWorkType | null>(null);
  const [siteId, setSiteId] = useState<string | null>(() => {
    const pre = provinceId ? provinceById(gameState, provinceId) : null;
    return pre && pre.ownerId === myPlayerId ? pre.id : myProvinces[0]?.id ?? null;
  });
  const site = siteId ? provinceById(gameState, siteId) : null;

  /* ---- act gating: BUILD is a budgeted deed in the action window. ----------- */
  const myTurn = isMyTurn(gameState, myPlayerId, timer);
  const inWindow =
    gameState.phase === GamePhase.RECRUITMENT ||
    gameState.phase === GamePhase.MOVEMENT ||
    gameState.phase === GamePhase.DIPLOMACY;
  const deeds = my?.actionsRemaining ?? 0;
  const actReason = !myTurn
    ? ACTION_ERROR_COPY.NOT_YOUR_TURN
    : !inWindow
      ? "You wait upon another court. Be patient."
      : deeds <= 0
        ? ACTION_ERROR_COPY.NO_ACTIONS
        : undefined;

  /* ---- progress bookkeeping -------------------------------------------------- */
  /** Provinces (anyone's) hosting this work, with invested deeds. */
  const sitesOf = (
    type: GreatWorkType,
  ): { prov: Province; progress: number; done: boolean }[] => {
    const def = WORKS.find((w) => w.type === type)!;
    const out: { prov: Province; progress: number; done: boolean }[] = [];
    for (const prov of gameState.provinces) {
      const g = prov.greatWorks.find((x) => x.type === type);
      if (g) out.push({ prov, progress: g.progress, done: g.progress >= def.rounds });
    }
    return out;
  };

  const siteProgress = (type: GreatWorkType): number | null => {
    const g = site?.greatWorks.find((x) => x.type === type);
    return g ? g.progress : null;
  };

  const canAfford = (cost: Partial<ResourceBundle>): boolean =>
    STORES.every((k) => (my?.treasury[k] ?? 0) >= (cost[k] ?? 0));

  const shortStore = (cost: Partial<ResourceBundle>): ResourceIconName | null =>
    STORES.find((k) => (my?.treasury[k] ?? 0) < (cost[k] ?? 0)) ?? null;

  const seal = (): void => {
    if (!chosenWork || !siteId) return;
    playSfx("quill_scratch");
    dispatch({
      type: "BUILD",
      player: myPlayerId,
      provinceId: siteId,
      greatWork: chosenWork,
    });
  };

  /* ---- completion flourish: church_bell when MY work finishes (engine log). -- */
  const lastSeenLog = useRef<string | null>(null);
  useEffect(() => {
    const latest = gameState.log[gameState.log.length - 1] ?? null;
    if (lastSeenLog.current === null) {
      lastSeenLog.current = latest?.id ?? "";
      return;
    }
    const fresh: GameLogEntry[] = [];
    for (let i = gameState.log.length - 1; i >= 0; i--) {
      const e = gameState.log[i];
      if (e.id === lastSeenLog.current) break;
      fresh.push(e);
    }
    lastSeenLog.current = latest?.id ?? lastSeenLog.current;
    for (const e of fresh) {
      if (
        e.type === "build" &&
        e.actors.includes(myPlayerId) &&
        e.data?.greatWork !== undefined &&
        typeof e.data?.prestige === "number"
      ) {
        playSfx("church_bell");
        toast.triumph("Your standing rises. The chronicle takes note.");
      }
    }
  }, [gameState.log, myPlayerId, playSfx, toast]);

  /* ---- render ------------------------------------------------------------------ */
  const chosenDef = WORKS.find((w) => w.type === chosenWork) ?? null;
  const chosenSiteProgress = chosenWork ? siteProgress(chosenWork) : null;
  const begun = chosenSiteProgress !== null;
  const finishedAtSite =
    chosenDef !== null && chosenSiteProgress !== null && chosenSiteProgress >= chosenDef.rounds;
  const affordable = chosenDef === null || begun || canAfford(chosenDef.cost);

  const sealReason =
    actReason ??
    (chosenWork === null
      ? "Choose a work to raise first."
      : site === null
        ? "Choose a province upon the map."
        : finishedAtSite
          ? "The work stands complete; the chronicle has it already."
          : !affordable && chosenDef
            ? SHORT_REASON[shortStore(chosenDef.cost) ?? "gold"]
            : undefined);

  return (
    <Modal title="The Great Works" onClose={onClose} wide>
      <p className="rubric">
        Marble builds nothing that fights and everything that lasts. Buy it when the wars go
        quiet.
      </p>

      {/* The site. */}
      <div className="gw-site-row">
        <label className="dip-composer-label" htmlFor="gw-site">
          The site
        </label>
        {myProvinces.length === 0 ? (
          <span className="rubric">No province flies your banner; there is nowhere to build.</span>
        ) : (
          <select
            id="gw-site"
            className="dip-field"
            value={siteId ?? ""}
            onChange={(e) => {
              setSiteId(e.target.value === "" ? null : e.target.value);
            }}
          >
            {myProvinces.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="rubric">
          The first deed buys the stone; each further deed is labor alone.
        </span>
      </div>

      {/* The four works. */}
      <div className="gw-works">
        {WORKS.map((w) => {
          const progressHere = siteProgress(w.type);
          const elsewhere = sitesOf(w.type).filter((s) => s.prov.id !== siteId);
          const short = shortStore(w.cost);
          return (
            <button
              key={w.type}
              type="button"
              className="gw-card"
              aria-pressed={chosenWork === w.type}
              onClick={() => {
                playSfx("ui_click");
                setChosenWork(w.type);
              }}
            >
              <span className="gw-name">
                {w.name}
                <IconChip icon="prestige" label="Prestige" value={`+${w.prestige}`} />
                <span className="gw-rounds">
                  {numberWord(w.rounds)} deeds of building
                </span>
              </span>
              <p className="gw-effect">{w.effect}</p>
              {w.flavor !== undefined && <p className="gw-effect rubric">{w.flavor}</p>}
              <span className="gw-cost-row">
                {STORES.filter((k) => (w.cost[k] ?? 0) > 0).map((k) => (
                  <IconChip
                    key={k}
                    icon={k}
                    label={STORE_LABEL[k]}
                    value={w.cost[k] ?? 0}
                    short={progressHere === null && short === k}
                    shortReason={SHORT_REASON[k]}
                  />
                ))}
              </span>
              {progressHere !== null && site && (
                <p className="gw-progress-line">
                  {progressHere >= w.rounds ? (
                    <>Complete at {site.name}. The chronicle has it.</>
                  ) : (
                    <>
                      Under way at {site.name} —{" "}
                      <span className="gw-progress-pips" aria-hidden="true">
                        {"●".repeat(progressHere)}
                        {"○".repeat(Math.max(0, w.rounds - progressHere))}
                      </span>{" "}
                      {toRoman(progressHere)} of {toRoman(w.rounds)} deeds done
                    </>
                  )}
                </p>
              )}
              {elsewhere.map((s) => {
                const owner = gameState.players.find((p) => p.id === s.prov.ownerId);
                const ownerName = owner
                  ? owner.faction
                    ? FACTION_NAME[owner.faction]
                    : owner.name
                  : "no crown";
                return (
                  <p key={s.prov.id} className="gw-progress-line">
                    {s.done ? "Complete" : `Under way (${toRoman(s.progress)} of ${toRoman(w.rounds)})`} at{" "}
                    {s.prov.name}, under the banner of {ownerName}.
                  </p>
                );
              })}
            </button>
          );
        })}
      </div>

      {chosenDef && begun && !finishedAtSite && (
        <p className="rubric">
          The stone is bought; this deed is labor alone. {toRoman(chosenSiteProgress ?? 0)} of{" "}
          {toRoman(chosenDef.rounds)} deeds stand done at {site?.name ?? "the site"}.
        </p>
      )}

      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          {BUTTONS.close}
        </Button>
        <Button
          variant="primary"
          onClick={seal}
          disabled={pendingAction || chosenWork === null || site === null || finishedAtSite}
          disabledReason={sealReason}
        >
          {BUTTONS.setTheSeal}
        </Button>
      </div>
    </Modal>
  );
}
