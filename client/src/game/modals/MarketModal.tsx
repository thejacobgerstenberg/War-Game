/**
 * MarketModal — "The Market" of design/mockups/market.html: two leaves under
 * one roof. "The Free Companies" is the §6.3 mercenary block (shared with the
 * auto-routed MercAuctionModal); "The Counting-House" is the TRADE/SET_TAX
 * ledger, wired to server/src/engine/economy.ts::applyTrade.
 *
 * Engine reality mirrored here (economy.ts / balance.ts):
 *  - CONVERT ratio (give per 1 get): base 3:1; 2:1 with a MARKET building, a
 *    coastal port as Venice/Genoa, or a completed Grand Bazaar; event
 *    `trade_mod` modifiers improve/worsen it, floored at 1:1; a pure
 *    gold<->specialty swap at a qualifying port trades 1:1 (the specialty is
 *    the port's dominant non-gold yield). Faith is never tradeable.
 *  - A CONVERT costs one action and is legal only in the action phases
 *    (RECRUITMENT / MOVEMENT / DIPLOMACY — the Levy, the March, the Court).
 *  - SET_TAX is free and un-phased: LENIENT x0.75 gold (+1 unrest resist),
 *    NORMAL x1.0, HEAVY x1.5 (each province checks revolt on d6 <= 1).
 *  - Trade routes live on state.activeModifiers (kind "trade_route"); the
 *    mockup's zone 8 strip lists the routes held and flags blockaded lanes
 *    (seaZones[].blockadedBy).
 *
 * Opened by OverlayManager on intent {type:"market"}.
 */
import { useMemo, useState } from "react";
import type { GameState, Player, ResourceBundle } from "@imperium/shared";
import { BuildingType, Faction, GamePhase, GreatWorkType, TaxPosture } from "@imperium/shared";
import { Button, IconChip, Modal, useToast } from "../../ui";
import { useAudio } from "../../audio/AudioProvider";
import { useGame } from "../GameProvider";
import { myBudgetRemaining, playerById, provinceById } from "../selectors";
import { ACTION_ERROR_COPY, BUTTONS } from "../uiText";
import {
  FreeCompanies,
  numberWord,
  numberWordCap,
  STORE_SHORT,
  TreasuryStrip,
} from "./MercAuctionModal";
import "./market.css";

/* ---------------------------------------------------------------------------
 * Vendored trade math (client may not import server code).
 * PROVENANCE: server/src/engine/economy.ts (bestMarketRatio, portSpecialty,
 * specialtyPorts, specialtyLaneRatio) + balance.ts MARKET_RATIOS
 * { base: 3, market: 2, port: 2, bazaar: 2, specialty: 1 } and
 * GREAT_WORK_COSTS.GRAND_BAZAAR.rounds = 2. Re-copy when tuned.
 * ------------------------------------------------------------------------- */

type TradeGood = "grain" | "timber" | "marble";
const TRADE_GOODS: readonly TradeGood[] = ["grain", "timber", "marble"];
/** Tie-break priority for a port's dominant secondary yield (economy.ts). */
const SPECIALTY_KEYS: readonly TradeGood[] = ["timber", "marble", "grain"];
const GRAND_BAZAAR_ROUNDS = 2;

const GOOD_LABEL: Record<TradeGood | "gold", string> = {
  gold: "Gold",
  grain: "Grain",
  timber: "Timber",
  marble: "Marble",
};

interface TradeRates {
  /** General give-per-1-get ratio after buildings/ports/modifiers (>= 1). */
  general: number;
  /** Goods that trade gold<->good at 1:1 via a qualifying specialty port. */
  specialties: ReadonlySet<TradeGood>;
}

function computeTradeRates(state: GameState, my: Player): TradeRates {
  const owned = state.provinces.filter((p) => p.ownerId === my.id);
  const maritime =
    my.faction === Faction.VENICE || my.faction === Faction.GENOA;
  const bazaarDone = (p: (typeof owned)[number]): boolean =>
    p.greatWorks.some(
      (g) =>
        g.type === GreatWorkType.GRAND_BAZAAR &&
        g.progress >= GRAND_BAZAAR_ROUNDS,
    );

  let general = 3; // MARKET_RATIOS.base
  if (owned.some((p) => p.buildings.includes(BuildingType.MARKET))) {
    general = Math.min(general, 2); // MARKET_RATIOS.market
  }
  if (maritime && owned.some((p) => p.coastal)) {
    general = Math.min(general, 2); // MARKET_RATIOS.port
  }
  if (owned.some(bazaarDone)) {
    general = Math.min(general, 2); // MARKET_RATIOS.bazaar (general lane)
  }
  // Event 'trade_mod' delta, floored at the 1:1 hard floor (economy.ts).
  if (my.faction) {
    const tradeMod = state.activeModifiers
      .filter(
        (m) =>
          m.kind === "trade_mod" &&
          (m.target?.faction === undefined || m.target.faction === my.faction),
      )
      .reduce((acc, m) => acc + (m.value ?? 0), 0);
    general = Math.max(1, general - tradeMod);
  }

  // Specialty 1:1 lane: Venice/Genoa at an owned coastal port, or any
  // completed Grand Bazaar; the lane's good is the port's dominant yield.
  const specialties = new Set<TradeGood>();
  for (const p of owned) {
    if (!((maritime && p.coastal) || bazaarDone(p))) continue;
    let best: TradeGood = SPECIALTY_KEYS[0];
    let bestVal = -1;
    for (const k of SPECIALTY_KEYS) {
      const v = p.yields[k] ?? 0;
      if (v > bestVal) {
        bestVal = v;
        best = k;
      }
    }
    specialties.add(best);
  }
  return { general, specialties };
}

/* ---------------------------------------------------------------------------
 * The tithe — SET_TAX postures, narrating balance.TAX_MULTIPLIERS
 * (0.75 / 1.0 / 1.5) and TAX_REVOLT (heavy: revolt on d6 <= 1; lenient:
 * +1 unrest resistance).
 * ------------------------------------------------------------------------- */

const TAX_LABEL: Record<TaxPosture, string> = {
  [TaxPosture.LENIENT]: "Lenient",
  [TaxPosture.NORMAL]: "Customary",
  [TaxPosture.HEAVY]: "Heavy",
};

const TAX_DESC: Record<TaxPosture, string> = {
  [TaxPosture.LENIENT]:
    "Three parts in four are gathered; a gentle hand steadies restless provinces.",
  [TaxPosture.NORMAL]:
    "The full tithe, as custom sets it — neither grudged nor praised.",
  [TaxPosture.HEAVY]:
    "Half again the custom — and every province so wrung may rise in revolt.",
};

/** The engine's action-phase window (actions.ts ACTION_PHASES). */
const ACTION_PHASES: ReadonlySet<GamePhase> = new Set([
  GamePhase.RECRUITMENT,
  GamePhase.MOVEMENT,
  GamePhase.DIPLOMACY,
]);

/* ---------------------------------------------------------------------------
 * The Counting-House leaf — exchange rows, the bargain panel, the tithe and
 * the routes held.
 * ------------------------------------------------------------------------- */

interface Bargain {
  give: TradeGood | "gold";
  get: TradeGood | "gold";
  ratio: number;
  lots: number;
}

function CountingHouse(props: {
  bargain: Bargain | null;
  onBargain: (b: Bargain | null) => void;
}): JSX.Element | null {
  const { gameState, myPlayerId, pendingAction, dispatch } = useGame();
  const { playSfx } = useAudio();
  const toast = useToast();
  const [posture, setPosture] = useState<TaxPosture | null>(null);
  const { bargain, onBargain } = props;

  const my = playerById(gameState, myPlayerId);
  const rates = useMemo(
    () => (my ? computeTradeRates(gameState, my) : null),
    [gameState, my],
  );
  if (!my || !rates) return null;

  const ratioFor = (good: TradeGood): number =>
    rates.specialties.has(good) ? 1 : rates.general;

  // The six rows of the house: each good against gold, both ways.
  const rows = TRADE_GOODS.flatMap((good) => [
    { give: good as TradeGood | "gold", get: "gold" as const, ratio: ratioFor(good) },
    { give: "gold" as const, get: good as TradeGood | "gold", ratio: ratioFor(good) },
  ]);

  const budget = myBudgetRemaining(gameState, myPlayerId);
  const inWindow = ACTION_PHASES.has(gameState.phase);
  const phaseBar = inWindow
    ? undefined
    : "The house trades during the Levy, the March, and the Court.";
  const budgetBar =
    budget <= 0 ? ACTION_ERROR_COPY.NO_ACTIONS : undefined;

  const seal = (b: Bargain): void => {
    playSfx("quill_scratch");
    playSfx("coin_purse");
    dispatch({
      type: "TRADE",
      player: myPlayerId,
      trade: {
        kind: "CONVERT",
        give: { [b.give]: b.lots * b.ratio },
        get: { [b.get]: b.lots },
      },
    });
    toast.triumph("So it is written.");
    onBargain(null);
  };

  // ---- Routes held (mockup zone 8) ----------------------------------------
  const routes = gameState.activeModifiers.filter(
    (m) => m.kind === "trade_route" && m.data?.ownerId === myPlayerId,
  );
  const routeBits = routes.map((m) => {
    const fromId = m.data?.fromProvinceId as string | undefined;
    const toId = m.data?.toProvinceId as string | undefined;
    const path = (m.data?.seaZonePath as string[] | undefined) ?? [];
    const blockaded = path.some((zoneId) => {
      const zone = gameState.seaZones.find((z) => z.id === zoneId);
      return (
        zone?.blockadedBy != null && zone.blockadedBy !== myPlayerId
      );
    });
    const from = fromId ? provinceById(gameState, fromId)?.name ?? fromId : "?";
    const to = toId ? provinceById(gameState, toId)?.name ?? toId : "?";
    return { id: m.id, from, to, blockaded };
  });

  return (
    <>
      {/* ZONE 7 · The rates of the house */}
      <section className="mkt-section" aria-label="The rates of the house">
        <h3 className="mkt-section-title">The Rates of the House</h3>
        <p className="rubric">
          Send goods abroad and draw coin homeward. A bargain in this house
          costs one deed of the campaign.
        </p>
        <ul className="mkt-exchange-list">
          {rows.map((row) => {
            const need = row.ratio; // one lot's cost in the given store
            const have = my.treasury[row.give];
            const barred = have < need;
            const isSel =
              bargain !== null &&
              bargain.give === row.give &&
              bargain.get === row.get;
            return (
              <li
                key={`${row.give}-${row.get}`}
                className={[
                  "mkt-exchange-row",
                  barred ? "is-barred" : "",
                  isSel ? "is-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className="mkt-exchange-side">
                  <IconChip
                    icon={row.give}
                    label={GOOD_LABEL[row.give]}
                    hideLabel
                  />
                  {numberWordCap(row.ratio)} {GOOD_LABEL[row.give]}
                </span>
                <span className="mkt-exchange-for">for</span>
                <span className="mkt-exchange-side">
                  <IconChip
                    icon={row.get}
                    label={GOOD_LABEL[row.get]}
                    hideLabel
                  />
                  One {GOOD_LABEL[row.get]}
                </span>
                <span className="pill pill--gold mkt-rate-pill">
                  {numberWordCap(row.ratio)} {GOOD_LABEL[row.give]} for one{" "}
                  {GOOD_LABEL[row.get]}
                </span>
                {row.ratio === 1 && (
                  <span className="pill">The house's own lane — at par</span>
                )}
                <Button
                  selected={isSel}
                  disabledReason={barred ? STORE_SHORT[row.give] : undefined}
                  onClick={() => {
                    playSfx("ui_click");
                    onBargain(
                      isSel
                        ? null
                        : { give: row.give, get: row.get, ratio: row.ratio, lots: 1 },
                    );
                  }}
                  aria-label={`Strike the bargain: ${numberWord(row.ratio)} ${GOOD_LABEL[row.give]} for one ${GOOD_LABEL[row.get]}`}
                >
                  Strike the Bargain
                </Button>
                {barred && (
                  <p className="mkt-exchange-reason">{STORE_SHORT[row.give]}</p>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mkt-house-note">
          Faith is not for sale in any market; only Rome sells grace.
        </p>

        {/* The bargain panel — measure, preview of the vaults, seal */}
        {bargain !== null &&
          (() => {
            const give = bargain.lots * bargain.ratio;
            const maxLots = Math.floor(
              my.treasury[bargain.give] / bargain.ratio,
            );
            const affordBar =
              bargain.lots > maxLots ? STORE_SHORT[bargain.give] : undefined;
            const sealBar = phaseBar ?? budgetBar ?? affordBar;
            const after: ResourceBundle = { ...my.treasury };
            after[bargain.give] -= give;
            after[bargain.get] += bargain.lots;
            return (
              <div className="mkt-bargain" aria-label="The bargain in hand">
                <div className="mkt-bargain-row">
                  <span
                    className="mkt-stepper"
                    role="group"
                    aria-label="Set the measure of the bargain"
                  >
                    <button
                      type="button"
                      aria-label={`Take one ${GOOD_LABEL[bargain.get]} off the scales`}
                      disabled={bargain.lots <= 1}
                      onClick={() => {
                        playSfx("ui_click");
                        onBargain({ ...bargain, lots: bargain.lots - 1 });
                      }}
                    >
                      −
                    </button>
                    <b className="mkt-stepper-value">{bargain.lots}</b>
                    <button
                      type="button"
                      aria-label={`Add one ${GOOD_LABEL[bargain.get]} to the scales`}
                      disabled={bargain.lots >= maxLots}
                      onClick={() => {
                        playSfx("ui_click");
                        onBargain({ ...bargain, lots: bargain.lots + 1 });
                      }}
                    >
                      +
                    </button>
                  </span>
                  <span>
                    {numberWordCap(give)} {GOOD_LABEL[bargain.give]} for{" "}
                    {numberWord(bargain.lots)} {GOOD_LABEL[bargain.get]}.
                  </span>
                </div>
                <div className="mkt-preview">
                  <span className="mkt-preview-label">
                    The vaults as they would stand:
                  </span>
                  <IconChip icon="gold" label="Gold" value={after.gold} />
                  <IconChip icon="grain" label="Grain" value={after.grain} />
                  <IconChip icon="timber" label="Timber" value={after.timber} />
                  <IconChip icon="marble" label="Marble" value={after.marble} />
                  <IconChip icon="faith" label="Faith" value={after.faith} />
                </div>
                <div className="mkt-bargain-row">
                  <Button
                    variant="primary"
                    disabledReason={sealBar}
                    disabled={pendingAction}
                    onClick={() => seal(bargain)}
                  >
                    {BUTTONS.setTheSeal}
                  </Button>
                  <Button variant="quiet" onClick={() => onBargain(null)}>
                    {BUTTONS.cancel}
                  </Button>
                </div>
              </div>
            );
          })()}
      </section>

      {/* The tithe — SET_TAX posture selector */}
      <section className="mkt-section" aria-label="Levy the Tithe">
        <h3 className="mkt-section-title">Levy the Tithe</h3>
        <p className="rubric">
          Wring gold from your provinces. The tithe stands{" "}
          {TAX_LABEL[my.tax].toLowerCase()}; the posture set here governs the
          next Reckoning.
        </p>
        <div className="mkt-tax-options" role="group" aria-label="Tax posture">
          {Object.values(TaxPosture).map((p) => {
            const chosen = posture ?? my.tax;
            return (
              <Button
                key={p}
                selected={chosen === p}
                onClick={() => {
                  playSfx("ui_click");
                  setPosture(p);
                }}
              >
                <span className="mkt-tax-name">
                  {chosen === p ? "❧ " : ""}
                  {TAX_LABEL[p]}
                </span>
                <span className="mkt-tax-desc">{TAX_DESC[p]}</span>
              </Button>
            );
          })}
        </div>
        <div className="mkt-tax-commit">
          <Button
            variant="primary"
            disabled={pendingAction}
            disabledReason={
              posture === null || posture === my.tax
                ? "The tithe already stands so."
                : undefined
            }
            onClick={() => {
              if (posture === null) return;
              playSfx("quill_scratch");
              dispatch({ type: "SET_TAX", player: myPlayerId, posture });
              toast.triumph("So it is written.");
              setPosture(null);
            }}
          >
            Gather the Tithe
          </Button>
        </div>
      </section>

      {/* ZONE 8 · The routes held */}
      <div className="mkt-route-strip" aria-label="The routes held">
        <span className="mkt-route-label">Routes held:</span>
        {routeBits.length === 0 ? (
          <span className="mkt-house-note" style={{ margin: 0 }}>
            The house keeps no sea lanes this season.
          </span>
        ) : (
          <>
            {routeBits.map((r) => (
              <span
                key={r.id}
                className={r.blockaded ? "pill pill--crimson" : "pill pill--lapis"}
              >
                {r.from} to {r.to}
                {r.blockaded ? " — the lane is blockaded" : ""}
              </span>
            ))}
            <b className="mkt-route-total">
              {numberWordCap(routeBits.length)}{" "}
              {routeBits.length === 1 ? "route" : "routes"} held
            </b>
          </>
        )}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------------------
 * The modal proper — two leaves under one roof.
 * ------------------------------------------------------------------------- */

export interface MarketModalProps {
  onClose: () => void;
}

type Leaf = "companies" | "ledger";

export function MarketModal({ onClose }: MarketModalProps): JSX.Element {
  const { gameState } = useGame();
  const { playSfx } = useAudio();
  const [leaf, setLeaf] = useState<Leaf>("companies");
  // Lifted so the treasury strip can flag the store the bargain draws upon.
  const [bargain, setBargain] = useState<Bargain | null>(null);
  // While the pass ConfirmModal is up, this modal must not answer Escape.
  const [subDialog, setSubDialog] = useState(false);

  const need: Partial<ResourceBundle> | undefined =
    leaf === "ledger" && bargain !== null
      ? { [bargain.give]: bargain.lots * bargain.ratio }
      : undefined;

  const pickLeaf = (next: Leaf): void => {
    playSfx("ui_click");
    setLeaf(next);
  };

  const tabs: { id: Leaf; label: string }[] = [
    { id: "companies", label: "The Free Companies" },
    { id: "ledger", label: "The Counting-House" },
  ];

  return (
    <Modal title="The Market" onClose={onClose} wide dismissable={!subDialog}>
      <p className="rubric">
        Two doors under one roof: swords for hire at the first, ledgers at the
        second. Both open on Gold.
      </p>
      <TreasuryStrip need={need} />
      <div
        className="mkt-tabs"
        role="tablist"
        aria-label="The two leaves of the market"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const next: Leaf = leaf === "companies" ? "ledger" : "companies";
            pickLeaf(next);
            document.getElementById(`mkt-tab-${next}`)?.focus();
          }
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`mkt-tab-${t.id}`}
            aria-selected={leaf === t.id}
            aria-controls={`mkt-panel-${t.id}`}
            className="mkt-tab"
            onClick={() => pickLeaf(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`mkt-panel-${leaf}`}
        aria-labelledby={`mkt-tab-${leaf}`}
      >
        {leaf === "companies" ? (
          <>
            <p className="rubric">
              The mercenary market: companies of hired steel, honestly priced
              — which is more than one can say of most honest men. When the
              treasury is fuller than the muster rolls, hire; a company costs
              Gold for every turn it serves.
            </p>
            <FreeCompanies
              offers={gameState.mercMarket}
              onDialogToggle={setSubDialog}
            />
          </>
        ) : (
          <CountingHouse bargain={bargain} onBargain={setBargain} />
        )}
      </div>
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          {BUTTONS.close}
        </Button>
      </div>
    </Modal>
  );
}
