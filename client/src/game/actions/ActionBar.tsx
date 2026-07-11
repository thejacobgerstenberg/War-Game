/**
 * ActionBar — game.html callout 11: the eight orders — Muster, March, Raise,
 * Traffic, Parley, Whisper, Play a Stratagem, Yield the Floor — plus the deed
 * pips (4 per campaign) and the free Levy the Tithe (SET_TAX) order.
 *
 * Contract (design/mockups/game.html + HANDOFF area 3):
 *  - ONE order armed at a time (gold fill + aria-pressed); arming sets the
 *    map's click-meaning via useSelection().armedOrder.
 *  - Orders are two-step: choose target(s) in the tray, then commit with
 *    "Set the Seal" -> useGame().dispatch(action) + quill_scratch sfx.
 *  - Muster: unit-type picker with the engine's real raise costs (mirrored in
 *    ./costs.ts) -> RECRUIT. March: select the host's province (the Board
 *    shades legalMoveTargets gold), then a legal destination -> MOVE (with an
 *    optional Lay Siege flag against a walled foe). Raise: an owned province
 *    opens the build sheet (BuildMenu via the overlay router). Traffic /
 *    Parley / Whisper are the doors into the Counting-House / Court of
 *    Envoys / spy overlays. Levy the Tithe -> SET_TAX (free, un-budgeted).
 *  - Yield the Floor is quiet-styled and ALWAYS confirms (ConfirmModal) ->
 *    PASS. At nought deeds every order but Yield disables with the in-voice
 *    reason; outside the action window (INCOME/COMBAT/END) the phase banner
 *    is the reason and "Onward" (ADVANCE_PHASE) moves the table forward.
 *  - ui_click on every order button; everything keyboard-reachable; Escape
 *    inside a tray disarms it.
 */
import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  BuildingType,
  GamePhase,
  TaxPosture,
  TerrainType,
  UnitType,
  Faction,
} from "@imperium/shared";
import type { GameState, ResourceBundle, UnitCounts } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { useSelection } from "../SelectionContext";
import { useOverlay } from "../OverlayManager";
import { useAudio } from "../../audio/AudioProvider";
import { Button, ConfirmModal, IconChip, PipBudget, ICON_URL, toRoman } from "../../ui";
import {
  isSeaZoneId,
  legalMoveTargets,
  me,
  myBudgetRemaining,
  myStacks,
  provinceById,
  seaZoneById,
} from "../selectors";
import {
  ACTION_ERROR_COPY,
  CONNECTION,
  BUTTONS,
  ORDER_GLOSS,
  ORDER_LABEL,
  PHASE_BANNER,
  YIELD_GLOSS,
  YIELD_LABEL,
} from "../uiText";
import type { OrderKind } from "../types";
import {
  ACTIONS_PER_ROUND,
  LAND_UNITS,
  MERC_GENOA_GOLD_MULTIPLIER,
  MERC_HIRE_GOLD_MULTIPLIER,
  NAVAL_UNITS,
  RESOURCE_LABEL,
  RESOURCE_SHORT_REASON,
  TAX_GLOSS,
  TAX_LABEL,
  TAX_ORDER,
  UNIT_COST,
  UNIT_NAME,
  UNIT_ROLE,
  costEntries,
  costText,
  shortStores,
} from "./costs";
import "./actions.css";

/** The seven armable orders in bar order (game.html callout 11). */
const ORDERS: readonly OrderKind[] = [
  "muster",
  "march",
  "raise",
  "traffic",
  "parley",
  "whisper",
  "stratagem",
];

/** Prompt shown while an armed order waits on a map selection. */
const CHOOSE_PROMPT = "Choose a province upon the map.";

/** The engine's action window (server ACTION_PHASES). */
function inActionWindow(phase: GamePhase): boolean {
  return (
    phase === GamePhase.RECRUITMENT ||
    phase === GamePhase.MOVEMENT ||
    phase === GamePhase.DIPLOMACY
  );
}

/** Mirror of the engine's recruit cost (mercs: ×1.5 gold — Genoa ×1.0 — 0 grain). */
function recruitCost(
  units: UnitCounts,
  mercenary: boolean,
  faction: Faction | null,
): Partial<ResourceBundle> {
  const mult =
    faction === Faction.GENOA ? MERC_GENOA_GOLD_MULTIPLIER : MERC_HIRE_GOLD_MULTIPLIER;
  const total: Partial<ResourceBundle> = {};
  for (const [type, n] of Object.entries(units) as [UnitType, number][]) {
    if (!n || n <= 0) continue;
    const naval = NAVAL_UNITS.includes(type);
    const merc = mercenary && !naval;
    for (const [k, per] of costEntries(UNIT_COST[type])) {
      if (merc && k === "grain") continue;
      const amount = merc && k === "gold" ? Math.ceil(per * n * mult) : per * n;
      total[k] = (total[k] ?? 0) + amount;
    }
  }
  return total;
}

export interface ActionBarProps {
  className?: string;
}

export function ActionBar({ className }: ActionBarProps): JSX.Element {
  const { gameState, myPlayerId, dispatch, pendingAction } = useGame();
  const { selection, armedOrder, setArmedOrder } = useSelection();
  const overlay = useOverlay();
  const { playSfx } = useAudio();

  const my = me(gameState, myPlayerId);
  const remaining = myBudgetRemaining(gameState, myPlayerId);
  const phase = gameState.phase;
  const windowOpen = inActionWindow(phase);

  const [titheOpen, setTitheOpen] = useState(false);
  const [confirmYield, setConfirmYield] = useState(false);

  // -- In-voice unavailability reasons (design contract: disabled = reason) --
  const phaseReason = windowOpen ? undefined : (PHASE_BANNER[phase] ?? CONNECTION.waiting);
  const budgetReason = remaining <= 0 ? ACTION_ERROR_COPY.NO_ACTIONS : undefined;
  const orderReason = phaseReason ?? budgetReason;

  // Stratagems are free but need a battle of mine and a card in hand.
  const inMyBattle = gameState.pendingBattles.some(
    (b) => b.attackerId === myPlayerId || b.defenderId === myPlayerId,
  );
  const tacticCards = my?.tacticHand?.length ?? 0;
  const stratagemReason =
    !inMyBattle || tacticCards === 0 ? ACTION_ERROR_COPY.NO_TARGET : undefined;

  const arm = (order: OrderKind): void => {
    playSfx("ui_click");
    setTitheOpen(false);
    setArmedOrder(armedOrder === order ? null : order);
  };
  const openDoor = (order: OrderKind): void => {
    playSfx("ui_click");
    setTitheOpen(false);
    setArmedOrder(null);
    if (order === "traffic") overlay.open({ type: "market" });
    else if (order === "parley") overlay.open({ type: "diplomacy" });
    else if (order === "whisper") overlay.open({ type: "spy" });
  };

  // Raise: once an owned province is selected, open its build sheet and disarm.
  useEffect(() => {
    if (armedOrder !== "raise" || selection === null) return;
    const prov = provinceById(gameState, selection);
    if (prov && prov.ownerId === myPlayerId) {
      overlay.open({ type: "build", provinceId: prov.id });
      setArmedOrder(null);
    }
  }, [armedOrder, selection, gameState, myPlayerId, overlay, setArmedOrder]);

  const onOrderClick = (order: OrderKind): void => {
    if (order === "traffic" || order === "parley" || order === "whisper") openDoor(order);
    else arm(order);
  };

  const reasonFor = (order: OrderKind): string | undefined => {
    if (order === "stratagem") return orderReason ?? stratagemReason;
    return orderReason;
  };

  const glyphFor = (order: OrderKind): JSX.Element | undefined => {
    // Only the shipped glyphs (art/icons); the rest are commissioned — the
    // visible label carries the naming until they land (game.html note).
    if (order === "muster") return <img src={ICON_URL.army} alt="" />;
    if (order === "traffic") return <img src={ICON_URL.gold} alt="" />;
    return undefined;
  };

  const disarm = (): void => setArmedOrder(null);
  const trayKeys = (e: ReactKeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      disarm();
      setTitheOpen(false);
    }
  };

  return (
    <footer
      className={["gb-bar", className ?? ""].filter(Boolean).join(" ")}
      aria-label="The orders of the campaign"
      onKeyDown={trayKeys}
    >
      {ORDERS.map((order) => (
        <Button
          key={order}
          selected={armedOrder === order}
          title={ORDER_GLOSS[order]}
          disabledReason={reasonFor(order)}
          icon={glyphFor(order)}
          onClick={() => onOrderClick(order)}
        >
          {ORDER_LABEL[order]}
        </Button>
      ))}

      {/* Levy the Tithe — SET_TAX is free and un-budgeted (engine reality). */}
      <Button
        variant="quiet"
        selected={titheOpen}
        title="Wring gold from your provinces."
        onClick={() => {
          playSfx("ui_click");
          setArmedOrder(null);
          setTitheOpen((open) => !open);
        }}
      >
        Levy the Tithe
      </Button>

      <Button
        variant="quiet"
        title={YIELD_GLOSS}
        onClick={() => {
          playSfx("ui_click");
          setConfirmYield(true);
        }}
      >
        {YIELD_LABEL}
      </Button>

      {/* Outside the action window, ADVANCE_PHASE is how the table moves on. */}
      {!windowOpen && phase !== GamePhase.LOBBY && gameState.winner === undefined && (
        <Button
          variant="quiet"
          title={PHASE_BANNER[phase]}
          disabledReason={pendingAction ? CONNECTION.waiting : undefined}
          onClick={() => {
            playSfx("ui_click");
            dispatch({ type: "ADVANCE_PHASE", player: myPlayerId });
          }}
        >
          {BUTTONS.continue}
        </Button>
      )}

      <PipBudget total={ACTIONS_PER_ROUND} remaining={remaining} />

      {armedOrder === "muster" && (
        <MusterTray
          gameState={gameState}
          myPlayerId={myPlayerId}
          selection={selection}
          pendingAction={pendingAction}
          onSeal={(action) => {
            dispatch(action);
            playSfx("quill_scratch");
            disarm();
          }}
          onCancel={() => {
            playSfx("ui_click");
            disarm();
          }}
        />
      )}

      {armedOrder === "march" && (
        <MarchTray
          gameState={gameState}
          myPlayerId={myPlayerId}
          selection={selection}
          pendingAction={pendingAction}
          onSeal={(action, naval) => {
            dispatch(action);
            playSfx("quill_scratch");
            if (naval) playSfx("ship_creak");
            disarm();
          }}
          onCancel={() => {
            playSfx("ui_click");
            disarm();
          }}
        />
      )}

      {armedOrder === "raise" && (
        <div className="act-tray" role="region" aria-label={ORDER_LABEL.raise}>
          <span className="act-tray-title">{ORDER_LABEL.raise}</span>
          <span className="rubric">
            {selection !== null &&
            provinceById(gameState, selection) !== null &&
            provinceById(gameState, selection)?.ownerId !== myPlayerId
              ? "Can only build in owned provinces."
              : CHOOSE_PROMPT}
          </span>
          <span className="act-seal">
            <Button variant="quiet" onClick={() => { playSfx("ui_click"); disarm(); }}>
              {BUTTONS.cancel}
            </Button>
          </span>
        </div>
      )}

      {armedOrder === "stratagem" && (
        <div className="act-tray" role="region" aria-label={ORDER_LABEL.stratagem}>
          <span className="act-tray-title">{ORDER_LABEL.stratagem}</span>
          <span className="rubric">{ORDER_GLOSS.stratagem}</span>
          <span>Cards in hand: {tacticCards === 0 ? "nought" : toRoman(tacticCards)}</span>
          <span className="act-seal">
            <Button variant="quiet" onClick={() => { playSfx("ui_click"); disarm(); }}>
              {BUTTONS.cancel}
            </Button>
          </span>
        </div>
      )}

      {titheOpen && my && (
        <TitheTray
          current={my.tax}
          pendingAction={pendingAction}
          onSeal={(posture) => {
            dispatch({ type: "SET_TAX", player: myPlayerId, posture });
            playSfx("quill_scratch");
            setTitheOpen(false);
          }}
          onCancel={() => {
            playSfx("ui_click");
            setTitheOpen(false);
          }}
        />
      )}

      {confirmYield && (
        <ConfirmModal
          title={YIELD_LABEL}
          consequence={YIELD_GLOSS}
          confirmLabel={YIELD_LABEL}
          cancelLabel={BUTTONS.cancel}
          onConfirm={() => {
            setConfirmYield(false);
            dispatch({ type: "PASS", player: myPlayerId });
            playSfx("quill_scratch");
          }}
          onCancel={() => setConfirmYield(false)}
        />
      )}
    </footer>
  );
}

/* ==========================================================================
   Muster — RECRUIT: unit-type picker with real costs, two-step seal.
   ========================================================================== */

interface MusterTrayProps {
  gameState: GameState;
  myPlayerId: string;
  selection: string | null;
  pendingAction: boolean;
  onSeal: (action: {
    type: "RECRUIT";
    player: string;
    provinceId: string;
    units: UnitCounts;
    mercenary?: boolean;
  }) => void;
  onCancel: () => void;
}

function MusterTray(props: MusterTrayProps): JSX.Element {
  const { gameState, myPlayerId, selection, pendingAction, onSeal, onCancel } = props;
  const [counts, setCounts] = useState<UnitCounts>({});
  const [mercenary, setMercenary] = useState(false);

  const prov = selection !== null ? provinceById(gameState, selection) : null;
  const owned = prov !== null && prov.ownerId === myPlayerId;

  // A new province wipes the muster roll.
  useEffect(() => {
    setCounts({});
    setMercenary(false);
  }, [selection]);

  if (!owned || prov === null) {
    return (
      <div className="act-tray" role="region" aria-label={ORDER_LABEL.muster}>
        <span className="act-tray-title">{ORDER_LABEL.muster}</span>
        <span className="rubric">
          {prov !== null ? "Can only recruit in owned provinces." : CHOOSE_PROMPT}
        </span>
        <span className="act-seal">
          <Button variant="quiet" onClick={onCancel}>
            {BUTTONS.cancel}
          </Button>
        </span>
      </div>
    );
  }

  const my = me(gameState, myPlayerId);
  const faction = my?.faction ?? null;

  // §6.2 recruitment-location legality (mirrors the engine's applyRecruit).
  const canRaiseLand =
    mercenary ||
    prov.isCapitalOf !== undefined ||
    prov.terrain === TerrainType.CITY ||
    prov.buildings.includes(BuildingType.BARRACKS);
  const canRaiseNaval = prov.buildings.includes(BuildingType.SHIPYARD);

  const landReason = canRaiseLand
    ? undefined
    : `${prov.name} cannot raise land units — a capital, a city, or a Barracks is needed.`;
  const navalReason = canRaiseNaval
    ? undefined
    : `${prov.name} needs a Shipyard for naval units.`;

  const total = recruitCost(counts, mercenary, faction);
  const totalUnits = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  const short = my ? shortStores(my.treasury, total) : [];

  const sealReason =
    totalUnits === 0
      ? "Recruit order is empty."
      : short.length > 0
        ? RESOURCE_SHORT_REASON[short[0]]
        : pendingAction
          ? CONNECTION.waiting
          : undefined;

  const bump = (type: UnitType, delta: number): void => {
    setCounts((prev) => {
      const next = Math.max(0, (prev[type] ?? 0) + delta);
      return { ...prev, [type]: next };
    });
  };

  const unitRow = (type: UnitType, addReason: string | undefined): JSX.Element => {
    const n = counts[type] ?? 0;
    return (
      <li key={type} className="act-unit">
        <span className="act-unit-name" title={UNIT_ROLE[type]}>
          {UNIT_NAME[type]}
        </span>
        <span className="act-unit-cost">{costText(UNIT_COST[type])}</span>
        <span className="act-stepper" role="group" aria-label={UNIT_NAME[type]}>
          <Button
            variant="quiet"
            aria-label={`Fewer ${UNIT_NAME[type]}`}
            disabled={n === 0}
            onClick={() => bump(type, -1)}
          >
            −
          </Button>
          <span className="act-count" aria-live="polite">
            {n}
          </span>
          <Button
            variant="quiet"
            aria-label={`More ${UNIT_NAME[type]}`}
            disabledReason={addReason}
            onClick={() => bump(type, +1)}
          >
            +
          </Button>
        </span>
      </li>
    );
  };

  return (
    <div className="act-tray" role="region" aria-label={ORDER_LABEL.muster}>
      <span className="act-tray-title">
        {ORDER_LABEL.muster} — {prov.name}
      </span>
      <ul className="act-units">
        {LAND_UNITS.map((t) => unitRow(t, landReason))}
        {NAVAL_UNITS.map((t) => unitRow(t, navalReason))}
      </ul>
      <label className="act-check">
        <input
          type="checkbox"
          checked={mercenary}
          onChange={(e) => setMercenary(e.target.checked)}
        />
        Hire as mercenaries
        <span className="act-check-gloss">
          ×1.5 gold, no grain to raise; double upkeep, and they desert first
        </span>
      </label>
      {totalUnits > 0 && (
        <span className="act-total" aria-label="The muster's full cost">
          {costEntries(total).map(([k, n]) => (
            <IconChip
              key={k}
              icon={k}
              label={RESOURCE_LABEL[k]}
              value={n}
              short={short.includes(k)}
              shortReason={RESOURCE_SHORT_REASON[k]}
            />
          ))}
        </span>
      )}
      <span className="act-seal">
        <Button variant="quiet" onClick={onCancel}>
          {BUTTONS.cancel}
        </Button>
        <Button
          variant="primary"
          disabledReason={sealReason}
          onClick={() =>
            onSeal({
              type: "RECRUIT",
              player: myPlayerId,
              provinceId: prov.id,
              units: counts,
              ...(mercenary ? { mercenary: true } : {}),
            })
          }
        >
          {BUTTONS.setTheSeal}
        </Button>
      </span>
    </div>
  );
}

/* ==========================================================================
   March — MOVE: source (my host) -> legal target (Board shades them gold)
   -> optional Lay Siege -> seal.
   ========================================================================== */

interface MarchTrayProps {
  gameState: GameState;
  myPlayerId: string;
  selection: string | null;
  pendingAction: boolean;
  onSeal: (
    action: {
      type: "MOVE";
      player: string;
      stackId: string;
      toId: string;
      naval?: boolean;
      declareSiege?: boolean;
    },
    naval: boolean,
  ) => void;
  onCancel: () => void;
}

function MarchTray(props: MarchTrayProps): JSX.Element {
  const { gameState, myPlayerId, selection, pendingAction, onSeal, onCancel } = props;
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [siege, setSiege] = useState(false);

  const { armies, fleets } = myStacks(gameState, myPlayerId);
  const hasStackAt = (id: string): boolean =>
    armies.some((a) => a.locationId === id) || fleets.some((f) => f.locationId === id);

  // Interpret map selections: first my host's province, then a legal target.
  useEffect(() => {
    if (selection === null) return;
    const { armies: myArmies, fleets: myFleets } = myStacks(gameState, myPlayerId);
    const mineAt = (id: string): boolean =>
      myArmies.some((a) => a.locationId === id) ||
      myFleets.some((f) => f.locationId === id);
    if (from === null) {
      if (mineAt(selection)) setFrom(selection);
      return;
    }
    if (selection === from) return;
    if (legalMoveTargets(gameState, from).includes(selection)) {
      setTo(selection);
      setSiege(false);
      return;
    }
    if (mineAt(selection)) {
      setFrom(selection);
      setTo(null);
      setSiege(false);
    }
  }, [selection, from, gameState, myPlayerId]);

  const nameOf = (id: string): string =>
    provinceById(gameState, id)?.name ?? seaZoneById(gameState, id)?.name ?? id;

  const toSea = to !== null && isSeaZoneId(to);
  const stack = (() => {
    if (from === null) return null;
    const army = armies.find((a) => a.locationId === from) ?? null;
    const fleet = fleets.find((f) => f.locationId === from) ?? null;
    if (to === null) return army ?? fleet;
    return toSea ? fleet : (army ?? fleet);
  })();
  const naval = stack !== null && fleets.some((f) => f.id === stack.id);

  const target = to !== null ? provinceById(gameState, to) : null;
  const canSiege =
    target !== null && target.walls.tier > 0 && target.ownerId !== myPlayerId;

  const sealReason =
    from === null || stack === null
      ? CHOOSE_PROMPT
      : to === null
        ? "There is no worthy target within reach."
        : pendingAction
          ? CONNECTION.waiting
          : undefined;

  return (
    <div className="act-tray" role="region" aria-label={ORDER_LABEL.march}>
      <span className="act-tray-title">{ORDER_LABEL.march}</span>
      {from === null ? (
        <span className="rubric">
          {selection !== null && !hasStackAt(selection)
            ? "No host of yours stands there. " + CHOOSE_PROMPT
            : CHOOSE_PROMPT}
        </span>
      ) : (
        <span className="act-leg">
          <span className="pill">From {nameOf(from)}</span>
          {to !== null ? (
            <span className="pill pill--gold">to {nameOf(to)}</span>
          ) : (
            <span className="rubric">The gold-shaded lands lie within one march.</span>
          )}
        </span>
      )}
      {canSiege && (
        <label className="act-check">
          <input
            type="checkbox"
            checked={siege}
            onChange={(e) => setSiege(e.target.checked)}
          />
          Lay Siege
          <span className="act-check-gloss">
            Ring a fortified city and starve it out.
          </span>
        </label>
      )}
      <span className="act-seal">
        <Button variant="quiet" onClick={onCancel}>
          {BUTTONS.cancel}
        </Button>
        <Button
          variant="primary"
          disabledReason={sealReason}
          onClick={() => {
            if (from === null || to === null || stack === null) return;
            onSeal(
              {
                type: "MOVE",
                player: myPlayerId,
                stackId: stack.id,
                toId: to,
                ...(naval ? { naval: true } : {}),
                ...(siege ? { declareSiege: true } : {}),
              },
              naval,
            );
          }}
        >
          {BUTTONS.setTheSeal}
        </Button>
      </span>
    </div>
  );
}

/* ==========================================================================
   Levy the Tithe — SET_TAX posture picker (free; engine does not budget it).
   ========================================================================== */

interface TitheTrayProps {
  current: TaxPosture;
  pendingAction: boolean;
  onSeal: (posture: TaxPosture) => void;
  onCancel: () => void;
}

function TitheTray(props: TitheTrayProps): JSX.Element {
  const { current, pendingAction, onSeal, onCancel } = props;
  const [draft, setDraft] = useState<TaxPosture>(current);

  return (
    <div className="act-tray" role="region" aria-label="Levy the Tithe">
      <span className="act-tray-title">Levy the Tithe</span>
      <span className="rubric">Wring gold from your provinces.</span>
      {TAX_ORDER.map((posture) => (
        <Button
          key={posture}
          variant="quiet"
          selected={draft === posture}
          title={TAX_GLOSS[posture]}
          onClick={() => setDraft(posture)}
        >
          {TAX_LABEL[posture]}
          {posture === current ? " (the standing tithe)" : ""}
        </Button>
      ))}
      <span className="act-seal">
        <Button variant="quiet" onClick={onCancel}>
          {BUTTONS.cancel}
        </Button>
        <Button
          variant="primary"
          disabledReason={pendingAction ? CONNECTION.waiting : undefined}
          onClick={() => onSeal(draft)}
        >
          {BUTTONS.setTheSeal}
        </Button>
      </span>
    </div>
  );
}
