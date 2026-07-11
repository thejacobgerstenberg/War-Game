/**
 * BuildMenu — the "Raise" order's build sheet for one owned province
 * (game.html callout 10's "Strengthen the Walls" door; opened by
 * OverlayManager on intent {type:"build", provinceId}).
 *
 * Ordinary buildings (GAME_DESIGN §9.1) build in one action; the Walls row
 * upgrades the fortification tier (engine WALL_BUILD_COST, tier by tier);
 * Great Works (§9.2) are multi-round: pay up front, then invest one Build
 * action per round until complete. Costs/prerequisites are display mirrors
 * of server/src/engine/balance.ts (see ./costs.ts) — the server remains
 * authoritative and rejects drift with an in-voice toast.
 *
 * Two-step commit: choose a row (aria-pressed), then "Set the Seal" ->
 * dispatch({type:"BUILD", player, provinceId, building|greatWork}) +
 * quill_scratch. Unaffordable/duplicate rows keep their place at 0.45
 * opacity with the in-voice store reason (lore/ui-text.md §7).
 */
import { useState } from "react";
import { BuildingType, GamePhase, GreatWorkType } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { useAudio } from "../../audio/AudioProvider";
import { Modal, Button, IconChip, toRoman } from "../../ui";
import { me, provinceById } from "../selectors";
import { sealAwaiting } from "./commitFlourish";
import { ACTION_ERROR_COPY, BUTTONS, CONNECTION, PHASE_BANNER } from "../uiText";
import {
  BUILDING_COST,
  BUILDING_GLOSS,
  BUILDING_NAME,
  BUILDING_ORDER,
  GREAT_WORK,
  GREAT_WORK_ORDER,
  MAX_WALL_TIER,
  RESOURCE_LABEL,
  RESOURCE_SHORT_REASON,
  WALL_COST,
  WALL_TIER_STATS,
  costEntries,
  shortStores,
} from "./costs";
import type { CostBundle } from "./costs";
import "./actions.css";

export interface BuildMenuProps {
  /** The owned province being built in. */
  provinceId: string;
  onClose: () => void;
}

type Choice =
  | { kind: "building"; building: BuildingType }
  | { kind: "greatWork"; work: GreatWorkType };

export function BuildMenu({ provinceId, onClose }: BuildMenuProps): JSX.Element {
  const { gameState, myPlayerId, dispatch, pendingAction } = useGame();
  const { playSfx } = useAudio();
  const [choice, setChoice] = useState<Choice | null>(null);

  const province = provinceById(gameState, provinceId);
  const my = me(gameState, myPlayerId);
  // "Lay the Foundation" — the Build label of lore/ui-text.md §3.
  const title = `Lay the Foundation — ${province?.name ?? provinceId}`;

  if (!province || !my || province.ownerId !== myPlayerId) {
    return (
      <Modal title="Lay the Foundation" onClose={onClose}>
        {/* In-voice (register of ui-text §7 error 11); the engine's modern
            string stays as the action_rejected fallback only. */}
        <p className="rubric">
          That province flies another&apos;s banner — the foundation must be
          laid on your own ground.
        </p>
        <div className="modal-actions">
          <Button variant="quiet" onClick={onClose}>
            {BUTTONS.close}
          </Button>
        </div>
      </Modal>
    );
  }

  const treasury = my.treasury;
  const inWindow =
    gameState.phase === GamePhase.RECRUITMENT ||
    gameState.phase === GamePhase.MOVEMENT ||
    gameState.phase === GamePhase.DIPLOMACY;
  const phaseReason = inWindow
    ? undefined
    : (PHASE_BANNER[gameState.phase] ?? CONNECTION.waiting);
  const budgetReason =
    my.actionsRemaining <= 0 ? ACTION_ERROR_COPY.NO_ACTIONS : undefined;

  /** First in-voice shortfall line for an unaffordable cost, else undefined. */
  const shortReason = (cost: CostBundle): string | undefined => {
    const short = shortStores(treasury, cost);
    return short.length > 0 ? RESOURCE_SHORT_REASON[short[0]] : undefined;
  };

  const costChips = (cost: CostBundle): JSX.Element => (
    <span className="act-build-cost" aria-hidden={false}>
      {costEntries(cost).map(([k, n]) => (
        <IconChip
          key={k}
          icon={k}
          label={RESOURCE_LABEL[k]}
          value={n}
          short={treasury[k] < n}
          shortReason={RESOURCE_SHORT_REASON[k]}
        />
      ))}
    </span>
  );

  const pick = (next: Choice): void => {
    playSfx("ui_click");
    setChoice((prev) =>
      prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? null : next,
    );
  };

  const isPicked = (next: Choice): boolean =>
    choice !== null && JSON.stringify(choice) === JSON.stringify(next);

  // -- Walls row: upgrade the tier, cost from WALL_COST[nextTier] ----------
  const wallTier = province.walls.tier;
  const nextTier = wallTier + 1;
  const wallCost = WALL_COST[nextTier];
  const wallStats = WALL_TIER_STATS[nextTier];
  const wallReason =
    wallTier >= MAX_WALL_TIER || wallCost === undefined
      ? "Walls are already at the maximum tier."
      : shortReason(wallCost);

  // -- Seal ------------------------------------------------------------------
  const chosenCost = ((): CostBundle | null => {
    if (choice === null) return null;
    if (choice.kind === "building") {
      return choice.building === BuildingType.WALLS ? (wallCost ?? {}) : BUILDING_COST[choice.building];
    }
    const inProgress = province.greatWorks.some((g) => g.type === choice.work);
    // Great works pay up front; continuing an investment costs no stores.
    return inProgress ? {} : GREAT_WORK[choice.work].cost;
  })();

  const sealReason =
    phaseReason ??
    budgetReason ??
    (choice === null
      ? "Choose a work to raise."
      : (shortReason(chosenCost ?? {}) ??
        (pendingAction ? CONNECTION.waiting : undefined)));

  const seal = (): void => {
    if (choice === null) return;
    // The commit flourish ("So it is written.") waits for the broadcast that
    // chronicles the build; the watcher lives in ActionBar (this sheet closes
    // on seal) — see ./commitFlourish.
    sealAwaiting.current = true;
    dispatch(
      choice.kind === "building"
        ? { type: "BUILD", player: myPlayerId, provinceId, building: choice.building }
        : { type: "BUILD", player: myPlayerId, provinceId, greatWork: choice.work },
    );
    playSfx("quill_scratch");
    onClose();
  };

  return (
    <Modal title={title} onClose={onClose} wide>
      <h3 className="act-build-section">Works and walls</h3>
      <ul className="act-build-rows">
        {BUILDING_ORDER.map((building) => {
          const built = province.buildings.includes(building);
          const reason = built
            ? `${province.name} already has a ${BUILDING_NAME[building]}.`
            : shortReason(BUILDING_COST[building]);
          return (
            <li key={building}>
              <Button
                className="act-build-row"
                selected={isPicked({ kind: "building", building })}
                disabledReason={reason}
                onClick={() => pick({ kind: "building", building })}
              >
                <span className="act-build-name">{BUILDING_NAME[building]}</span>
                <span className="act-build-gloss">
                  {built ? "Already raised here." : BUILDING_GLOSS[building]}
                </span>
                {!built && costChips(BUILDING_COST[building])}
              </Button>
            </li>
          );
        })}
        <li>
          <Button
            className="act-build-row"
            selected={isPicked({ kind: "building", building: BuildingType.WALLS })}
            disabledReason={wallReason}
            onClick={() => pick({ kind: "building", building: BuildingType.WALLS })}
          >
            <span className="act-build-name">
              Raise the Walls
              {wallCost !== undefined ? ` — Walls ${toRoman(nextTier)}` : ""}
            </span>
            <span className="act-build-gloss">
              {wallTier > 0 ? `Now Walls ${toRoman(wallTier)}. ` : ""}
              {wallCost !== undefined && wallStats !== undefined
                ? `Wall HP ${wallStats.hp}, defender +${wallStats.defBonus}`
                : ""}
            </span>
            {wallCost !== undefined && costChips(wallCost)}
          </Button>
        </li>
      </ul>

      <h3 className="act-build-section">Great Works</h3>
      <p className="rubric">
        Pay the cost up front, then invest one Build action each round until the
        work is complete. Abandoning forfeits the investment.
      </p>
      <ul className="act-build-rows">
        {GREAT_WORK_ORDER.map((work) => {
          const def = GREAT_WORK[work];
          const existing = province.greatWorks.find((g) => g.type === work);
          const complete = existing !== undefined && existing.progress >= def.rounds;
          const reason = complete
            ? `The ${def.name} at ${province.name} is already complete.`
            : existing !== undefined
              ? undefined // continuing the investment costs no stores
              : shortReason(def.cost);
          return (
            <li key={work}>
              <Button
                className="act-build-row"
                selected={isPicked({ kind: "greatWork", work })}
                disabledReason={reason}
                onClick={() => pick({ kind: "greatWork", work })}
              >
                <span className="act-build-name">{def.name}</span>
                <span className="act-build-gloss">
                  {complete
                    ? "Complete."
                    : existing !== undefined
                      ? `Season ${toRoman(existing.progress)} of ${toRoman(def.rounds)} — invest another Build action.`
                      : `${def.gloss} · ${def.rounds} rounds · +${def.prestige} Prestige`}
                </span>
                {existing === undefined && !complete && costChips(def.cost)}
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          {BUTTONS.close}
        </Button>
        <Button variant="primary" disabledReason={sealReason} onClick={seal}>
          {BUTTONS.setTheSeal}
        </Button>
      </div>
    </Modal>
  );
}
