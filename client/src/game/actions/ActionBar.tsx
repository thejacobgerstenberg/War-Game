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
 *    optional Lay Siege flag against a walled foe, and an optional From the
 *    Sea carry — transportFleetId — when a galley fleet of mine lies in a sea
 *    zone bordering both shores of the march). Raise: an owned province
 *    opens the build sheet (BuildMenu via the overlay router). Traffic /
 *    Parley / Whisper are the doors into the Counting-House / Court of
 *    Envoys / spy overlays. Levy the Tithe -> SET_TAX (free, un-budgeted).
 *  - Yield the Floor is quiet-styled and ALWAYS confirms (ConfirmModal) ->
 *    PASS. At nought deeds every order but Yield disables with the in-voice
 *    reason; outside the action window (INCOME/COMBAT/END) the phase banner
 *    is the reason. "Onward" (ADVANCE_PHASE) moves the table forward: direct
 *    outside the window, confirm-gated inside it (it is the only exit from an
 *    action phase when turn timers are off, e.g. hot-seat). The action carries
 *    fromRound/fromPhase so a raced double-Onward is a server-side no-op.
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
import type {
  Fleet,
  GameState,
  RecruitVariant,
  ResourceBundle,
  UnitCounts,
} from "@imperium/shared";
import { useGame } from "../GameProvider";
import { useSelection } from "../SelectionContext";
import { useOverlay } from "../OverlayManager";
import { useAudio } from "../../audio/AudioProvider";
import {
  Button,
  ConfirmModal,
  IconChip,
  PipBudget,
  ICON_URL,
  toRoman,
  useToast,
} from "../../ui";
import { useFreshLogEntries } from "../useFreshLog";
import { sealAwaiting } from "./commitFlourish";
import {
  isSeaZoneId,
  legalMoveTargets,
  me,
  myBudgetRemaining,
  myStacks,
  neighborsOf,
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
  PHASE_NAME,
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
  factionUniqueUnits,
  shortStores,
} from "./costs";
import type { UniqueUnitDisplay } from "./costs";
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

/* In-voice legality reasons (register of lore/ui-text.md §7 errors 6 and 11;
   no exact lore line exists for these cases, so these are authored in the
   same voice — the engine's modern strings are kept for action_rejected
   fallback only, per the COPY contract). */
const NOT_OWNED_BUILD =
  "That province flies another's banner — the foundation must be laid on your own ground.";
const NOT_OWNED_MUSTER =
  "That province flies another's banner — levies muster only on your own ground.";
const EMPTY_MUSTER_ROLL =
  "The muster roll is empty — name at least one company to raise.";

/** Gloss on Onward while an action window is open (it moves the WHOLE table). */
const ONWARD_GLOSS =
  "Close the phase for the whole table and move the game onward.";

/** Consequence line for the Onward confirm inside an action window. */
const onwardConsequence = (phase: GamePhase): string =>
  `${PHASE_NAME[phase]} closes for every crown at the table, spent deeds or no.`;

/** The engine's action window (server ACTION_PHASES). */
function inActionWindow(phase: GamePhase): boolean {
  return (
    phase === GamePhase.RECRUITMENT ||
    phase === GamePhase.MOVEMENT ||
    phase === GamePhase.DIPLOMACY
  );
}

/** One costed line of a muster order: a generic batch, or a named variant. */
interface MusterLine {
  base: UnitType;
  count: number;
}

/**
 * Mirror of the engine's recruit cost (mercs: ×1.5 gold — Genoa ×1.0 — 0
 * grain). Named variants cost their BASE unit (applyRecruit's addUnitCost).
 * Costed per LINE — each generic type and each variant separately — so the
 * mercenary-gold Math.ceil rounds exactly as the engine does.
 */
function recruitCost(
  lines: readonly MusterLine[],
  mercenary: boolean,
  faction: Faction | null,
): Partial<ResourceBundle> {
  const mult =
    faction === Faction.GENOA ? MERC_GENOA_GOLD_MULTIPLIER : MERC_HIRE_GOLD_MULTIPLIER;
  const total: Partial<ResourceBundle> = {};
  for (const { base, count } of lines) {
    if (count <= 0) continue;
    const naval = NAVAL_UNITS.includes(base);
    const merc = mercenary && !naval;
    for (const [k, per] of costEntries(UNIT_COST[base])) {
      if (merc && k === "grain") continue;
      const amount = merc && k === "gold" ? Math.ceil(per * count * mult) : per * count;
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
  const toast = useToast();

  // Commit flourish (README §2): "So it is written." confirms the DEED, so it
  // waits for the broadcast whose chronicle carries my sealed order — never
  // fired optimistically at dispatch (the server may still refuse). RECRUIT
  // logs type "recruit"; BUILD logs type "build" (BuildMenu sets the shared
  // latch, see ./commitFlourish); MOVE logs data.move (type "battle" when the
  // march meets a foe, "phase" otherwise) — server actions.ts/economy.ts.
  useFreshLogEntries((entries) => {
    if (!sealAwaiting.current) return;
    for (const e of entries) {
      if (!e.actors.includes(myPlayerId)) continue;
      if (e.type === "recruit" || e.type === "build" || e.data?.move !== undefined) {
        sealAwaiting.current = false;
        toast.triumph("So it is written.");
        break;
      }
    }
  });

  const my = me(gameState, myPlayerId);
  const remaining = myBudgetRemaining(gameState, myPlayerId);
  const phase = gameState.phase;
  const windowOpen = inActionWindow(phase);

  const [titheOpen, setTitheOpen] = useState(false);
  const [confirmYield, setConfirmYield] = useState(false);
  const [confirmOnward, setConfirmOnward] = useState(false);

  // ADVANCE_PHASE carries the round/phase THIS client saw so the server can
  // treat a raced Onward (another seat's click, or the turn timer, landed
  // first) as already satisfied instead of skipping a second phase.
  const sendOnward = (): void => {
    dispatch({
      type: "ADVANCE_PHASE",
      player: myPlayerId,
      fromRound: gameState.round,
      fromPhase: phase,
    });
  };

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

      {/* Onward — ADVANCE_PHASE is how the table moves on. Outside the action
          window it fires directly; INSIDE an action window it is the only exit
          when timers are off (hot-seat) and it moves the WHOLE table, so it
          always confirms first (design contract: destructive = modal). */}
      {phase !== GamePhase.LOBBY && gameState.winner === undefined && (
        <Button
          variant="quiet"
          title={windowOpen ? ONWARD_GLOSS : PHASE_BANNER[phase]}
          disabledReason={pendingAction ? CONNECTION.waiting : undefined}
          onClick={() => {
            playSfx("ui_click");
            if (windowOpen) setConfirmOnward(true);
            else sendOnward();
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
            sealAwaiting.current = true;
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
            sealAwaiting.current = true;
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
              ? NOT_OWNED_BUILD
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

      {confirmOnward && (
        <ConfirmModal
          title={BUTTONS.continue}
          consequence={onwardConsequence(phase)}
          confirmLabel={BUTTONS.confirm}
          cancelLabel={BUTTONS.cancel}
          onConfirm={() => {
            setConfirmOnward(false);
            sendOnward();
            playSfx("quill_scratch");
          }}
          onCancel={() => setConfirmOnward(false)}
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
    variants?: RecruitVariant[];
    mercenary?: boolean;
  }) => void;
  onCancel: () => void;
}

function MusterTray(props: MusterTrayProps): JSX.Element {
  const { gameState, myPlayerId, selection, pendingAction, onSeal, onCancel } = props;
  const [counts, setCounts] = useState<UnitCounts>({});
  const [variantCounts, setVariantCounts] = useState<Record<string, number>>({});
  const [mercenary, setMercenary] = useState(false);

  const prov = selection !== null ? provinceById(gameState, selection) : null;
  const owned = prov !== null && prov.ownerId === myPlayerId;

  // A new province wipes the muster roll.
  useEffect(() => {
    setCounts({});
    setVariantCounts({});
    setMercenary(false);
  }, [selection]);

  if (!owned || prov === null) {
    return (
      <div className="act-tray" role="region" aria-label={ORDER_LABEL.muster}>
        <span className="act-tray-title">{ORDER_LABEL.muster}</span>
        <span className="rubric">
          {prov !== null ? NOT_OWNED_MUSTER : CHOOSE_PROMPT}
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

  // My faction's signature units (§FACTIONS; RecruitAction.variants).
  const uniques = factionUniqueUnits(faction);

  const lines: MusterLine[] = [
    ...(Object.entries(counts) as [UnitType, number][]).map(([base, n]) => ({
      base,
      count: n ?? 0,
    })),
    ...uniques.map((u) => ({ base: u.base, count: variantCounts[u.variant] ?? 0 })),
  ];
  const total = recruitCost(lines, mercenary, faction);
  const totalUnits = lines.reduce((sum, l) => sum + l.count, 0);
  const short = my ? shortStores(my.treasury, total) : [];

  const sealReason =
    totalUnits === 0
      ? EMPTY_MUSTER_ROLL
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
  const bumpVariant = (variant: string, delta: number): void => {
    setVariantCounts((prev) => ({
      ...prev,
      [variant]: Math.max(0, (prev[variant] ?? 0) + delta),
    }));
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

  // Signature-unit row (RECRUIT variants). Mirrors applyRecruit's gating: the
  // base unit's location legality PLUS the variant's recruitProvinces list.
  const placeName = (id: string): string => provinceById(gameState, id)?.name ?? id;
  const variantRow = (u: UniqueUnitDisplay): JSX.Element => {
    const n = variantCounts[u.variant] ?? 0;
    const naval = NAVAL_UNITS.includes(u.base);
    const gateReason =
      u.recruitProvinces !== undefined && !u.recruitProvinces.includes(prov.id)
        ? `${u.name} cannot be raised at ${prov.name} — only at ${u.recruitProvinces
            .map(placeName)
            .join(" or ")}.`
        : undefined;
    const addReason = gateReason ?? (naval ? navalReason : landReason);
    return (
      <li key={u.variant} className="act-unit act-unit--unique">
        <span className="act-unit-name" title={u.role}>
          {u.name}
        </span>
        <span className="act-unit-cost">{costText(UNIT_COST[u.base])}</span>
        <span className="act-stepper" role="group" aria-label={u.name}>
          <Button
            variant="quiet"
            aria-label={`Fewer ${u.name}`}
            disabled={n === 0}
            onClick={() => bumpVariant(u.variant, -1)}
          >
            −
          </Button>
          <span className="act-count" aria-live="polite">
            {n}
          </span>
          <Button
            variant="quiet"
            aria-label={`More ${u.name}`}
            disabledReason={addReason}
            onClick={() => bumpVariant(u.variant, +1)}
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
        {uniques.map(variantRow)}
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
          onClick={() => {
            const variants: RecruitVariant[] = uniques
              .filter((u) => (variantCounts[u.variant] ?? 0) > 0)
              .map((u) => ({
                base: u.base,
                variant: u.variant,
                count: variantCounts[u.variant] ?? 0,
              }));
            onSeal({
              type: "RECRUIT",
              player: myPlayerId,
              provinceId: prov.id,
              units: counts,
              ...(variants.length > 0 ? { variants } : {}),
              ...(mercenary ? { mercenary: true } : {}),
            });
          }}
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
      transportFleetId?: string;
      declareSiege?: boolean;
    },
    naval: boolean,
  ) => void;
  onCancel: () => void;
}

/**
 * §5.3 amphibious transport: my fleet holding at least one GALLEY (or a
 * galley-based unique variant) lying in a sea zone that borders BOTH shores of
 * a province→province march can carry the host, landing it "from the sea"
 * (MoveAction.transportFleetId → the engine's battle.amphibious, attacker −1).
 * Returns the first such fleet with the zone it sails, or null.
 */
function transportFor(
  myFleets: Fleet[],
  from: string | null,
  to: string | null,
): { fleet: Fleet; zoneId: string } | null {
  if (from === null || to === null) return null;
  if (isSeaZoneId(from) || isSeaZoneId(to)) return null;
  const fromSeas = new Set(neighborsOf(from).filter(isSeaZoneId));
  for (const zoneId of neighborsOf(to)) {
    if (!fromSeas.has(zoneId)) continue;
    const fleet = myFleets.find(
      (f) =>
        f.locationId === zoneId &&
        ((f.units[UnitType.GALLEY] ?? 0) > 0 ||
          (f.variants ?? []).some((v) => v.base === UnitType.GALLEY && v.count > 0)),
    );
    if (fleet) return { fleet, zoneId };
  }
  return null;
}

function MarchTray(props: MarchTrayProps): JSX.Element {
  const { gameState, myPlayerId, selection, pendingAction, onSeal, onCancel } = props;
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [siege, setSiege] = useState(false);
  const [bySea, setBySea] = useState(false);

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
      setBySea(false);
      return;
    }
    if (mineAt(selection)) {
      setFrom(selection);
      setTo(null);
      setSiege(false);
      setBySea(false);
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

  // Amphibious option: only for a MARCHING HOST (never a fleet move) whose
  // crossing a galley fleet of mine can carry (§5.3, docs/GAME_DESIGN.md).
  const transport = stack !== null && !naval ? transportFor(fleets, from, to) : null;

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
      {transport !== null && (
        <label className="act-check">
          <input
            type="checkbox"
            checked={bySea}
            onChange={(e) => setBySea(e.target.checked)}
          />
          From the Sea
          <span className="act-check-gloss">
            Your galleys upon {nameOf(transport.zoneId)} carry the host ashore;
            it comes under arms at −1.
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
            const amphibious = bySea && transport !== null;
            onSeal(
              {
                type: "MOVE",
                player: myPlayerId,
                stackId: stack.id,
                toId: to,
                ...(naval ? { naval: true } : {}),
                ...(amphibious ? { transportFleetId: transport.fleet.id } : {}),
                ...(siege ? { declareSiege: true } : {}),
              },
              naval || amphibious,
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
