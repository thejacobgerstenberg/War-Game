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
 *    (seaZones[].blockadedBy). Beneath the strip a charter form dispatches
 *    TRADE kind "ROUTE" (§5.1): both ends owned coastal ports, the sea-zone
 *    path charted client-side over the board adjacency graph, one action,
 *    and a GALLEY merchantman required (economy.ts assigns the first).
 *
 * Opened by OverlayManager on intent {type:"market"}.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { GameState, Player, Province, ResourceBundle } from "@imperium/shared";
import {
  BuildingType,
  Faction,
  GamePhase,
  GreatWorkType,
  TaxPosture,
  UnitType,
} from "@imperium/shared";
import { Button, IconChip, Modal, useToast } from "../../ui";
import { useAudio } from "../../audio/AudioProvider";
import { useGame } from "../GameProvider";
import { useFreshLogEntries } from "../useFreshLog";
import {
  isSeaZoneId,
  myBudgetRemaining,
  neighborsOf,
  playerById,
  provinceById,
  seaZoneById,
} from "../selectors";
import { ACTION_ERROR_COPY, BUTTONS } from "../uiText";
import {
  FreeCompanies,
  numberWord,
  numberWordCap,
  STORE_SHORT,
  TreasuryStrip,
} from "./MercAuctionModal";
import "./market.css";
import "./market-routes.css";

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

/** A completed Grand Bazaar stands in this province. */
function bazaarDone(p: Province): boolean {
  return p.greatWorks.some(
    (g) =>
      g.type === GreatWorkType.GRAND_BAZAAR &&
      g.progress >= GRAND_BAZAAR_ROUNDS,
  );
}

function computeTradeRates(state: GameState, my: Player): TradeRates {
  const owned = state.provinces.filter((p) => p.ownerId === my.id);
  const maritime =
    my.faction === Faction.VENICE || my.faction === Faction.GENOA;

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
 * Charter a lane — TRADE kind "ROUTE" (economy.ts::applyTrade §5.1). The
 * engine takes the two owned coastal ports and an ordered sea-zone path; the
 * client charts the shortest path over the board's adjacency graph (the same
 * MAP.md graph the server validates against).
 * ------------------------------------------------------------------------- */

/**
 * Shortest sea-zone path joining two coastal provinces, or null when no sea
 * road connects them. BFS over BOARD_ADJACENCY restricted to sea zones; the
 * returned path is ordered from the `fromId` shore to the `toId` shore, ready
 * for TradeAction.trade.seaZonePath.
 */
function chartLane(fromId: string, toId: string): string[] | null {
  const startZones = neighborsOf(fromId).filter(isSeaZoneId);
  const goalZones = new Set(neighborsOf(toId).filter(isSeaZoneId));
  if (startZones.length === 0 || goalZones.size === 0) return null;
  // prev maps each reached zone to the zone it was reached from (null = start).
  const prev = new Map<string, string | null>();
  const queue: string[] = [];
  for (const z of startZones) {
    prev.set(z, null);
    queue.push(z);
  }
  for (let i = 0; i < queue.length; i++) {
    const zone = queue[i];
    if (goalZones.has(zone)) {
      const path: string[] = [];
      for (let cur: string | null = zone; cur !== null; cur = prev.get(cur) ?? null) {
        path.unshift(cur);
      }
      return path;
    }
    for (const n of neighborsOf(zone)) {
      if (isSeaZoneId(n) && !prev.has(n)) {
        prev.set(n, zone);
        queue.push(n);
      }
    }
  }
  return null;
}

/**
 * Projected gold of a charted lane each Income phase, before piracy/severing.
 * PROVENANCE: server/src/engine/economy.ts::routeIncome + portTier and
 * balance.ts TRADE { baseRouteGold: 2, controlledHopBonus: 1,
 * blockadeMultiplier: 0.5, maritimeMultiplier: 1.5 } — re-copy when tuned.
 * Simplification (matches the routes-held strip above): a hop counts as
 * blockaded when blockadedBy is anyone but me; allied blockades and the
 * severed-escort check are left to the server, hence the "~" in the copy.
 */
function projectedLaneGold(
  state: GameState,
  my: Player,
  from: Province,
  to: Province,
  lane: readonly string[],
): { gold: number; blockaded: boolean } {
  // economy.ts::portTier — §5.2 port tiers off the highValue weight.
  const tier = (p: Province): number => {
    if (!p.coastal) return 0;
    const hv = p.highValue ?? 0;
    if (hv >= 4) return 3;
    if (hv === 3) return 2;
    return 1;
  };
  let controlled = 0;
  let blockaded = false;
  for (const zoneId of lane) {
    const zone = seaZoneById(state, zoneId);
    if (zone?.blockadedBy != null && zone.blockadedBy !== my.id) {
      blockaded = true;
    } else {
      controlled += 1; // §5.2 +1 per unblockaded hop
    }
  }
  let gold = 2 + tier(from) + tier(to) + controlled; // TRADE.baseRouteGold = 2
  if (bazaarDone(from) || bazaarDone(to)) gold += 3; // §9 Grand Bazaar port
  if (blockaded) gold = Math.floor(gold * 0.5); // TRADE.blockadeMultiplier
  if (my.faction === Faction.VENICE || my.faction === Faction.GENOA) {
    gold = Math.floor(gold * 1.5); // TRADE.maritimeMultiplier
  }
  return { gold: Math.max(0, gold), blockaded };
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
  // Charter-a-lane picks (TRADE kind "ROUTE"): the two owned ports.
  const [routeFrom, setRouteFrom] = useState<string>("");
  const [routeTo, setRouteTo] = useState<string>("");
  const { bargain, onBargain } = props;

  const my = playerById(gameState, myPlayerId);
  const rates = useMemo(
    () => (my ? computeTradeRates(gameState, my) : null),
    [gameState, my],
  );

  /* ---- confirmation flourishes ------------------------------------------------
   * dispatch() is fire-and-forget; the server may still refuse (stale turn,
   * phase change). The triumph toast and the coin_purse are the mockup's
   * confirmation of the DEED, so they wait for the state broadcast that
   * chronicles it — mirroring GreatWorksModal's completion flourish. */
  const awaitingTrade = useRef(false);
  const awaitingRoute = useRef(false);
  useFreshLogEntries((entries) => {
    if (!awaitingTrade.current && !awaitingRoute.current) return;
    for (const e of entries) {
      if (e.type !== "trade" || !e.actors.includes(myPlayerId)) continue;
      // The CONVERT chronicle line (economy.ts::applyTrade): type "trade",
      // my seat among the actors, data {give, get, ratio}.
      if (awaitingTrade.current && e.data?.give !== undefined) {
        awaitingTrade.current = false;
        playSfx("coin_purse");
        toast.triumph("So it is written.");
        onBargain(null);
      }
      // The ROUTE chronicle line: data {routeIncome, route: modifierId}.
      if (awaitingRoute.current && e.data?.route !== undefined) {
        awaitingRoute.current = false;
        playSfx("coin_purse");
        toast.triumph("The charter is sealed; the lane is open.");
        setRouteFrom("");
        setRouteTo("");
      }
    }
  });

  // SET_TAX writes no chronicle line (actions.ts): the confirmation is the
  // posture itself coming back changed in the next broadcast.
  const awaitingTax = useRef<TaxPosture | null>(null);
  const myTax = my?.tax;
  useEffect(() => {
    if (awaitingTax.current !== null && myTax === awaitingTax.current) {
      awaitingTax.current = null;
      setPosture(null);
      toast.triumph("So it is written.");
    }
  }, [myTax, toast]);

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
    // quill_scratch belongs to the seal-press itself (design contract); the
    // coin_purse and the triumph toast wait for the server's chronicle line.
    playSfx("quill_scratch");
    awaitingTrade.current = true;
    dispatch({
      type: "TRADE",
      player: myPlayerId,
      trade: {
        kind: "CONVERT",
        give: { [b.give]: b.lots * b.ratio },
        get: { [b.get]: b.lots },
      },
    });
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

  // ---- Charter a lane (TRADE kind "ROUTE") ---------------------------------
  const myPorts = gameState.provinces
    .filter((p) => p.ownerId === myPlayerId && p.coastal)
    .sort((a, b) => a.name.localeCompare(b.name));
  // §5.1 a route needs a GALLEY merchantman (economy.ts assigns the first).
  const hasMerchantman = gameState.fleets.some(
    (f) =>
      f.ownerId === myPlayerId && (f.units[UnitType.GALLEY] ?? 0) > 0,
  );
  const fromPort = routeFrom ? provinceById(gameState, routeFrom) : null;
  const toPort = routeTo ? provinceById(gameState, routeTo) : null;
  // Charted fresh each render: a BFS over the board's 12 sea zones is cheap,
  // and a useMemo here would sit below the `!my` early return (hooks rule).
  const lane =
    routeFrom && routeTo && routeFrom !== routeTo
      ? chartLane(routeFrom, routeTo)
      : null;
  const laneHeld = routes.some((m) => {
    const a = m.data?.fromProvinceId;
    const b = m.data?.toProvinceId;
    return (
      (a === routeFrom && b === routeTo) || (a === routeTo && b === routeFrom)
    );
  });
  const projected =
    lane && fromPort && toPort
      ? projectedLaneGold(gameState, my, fromPort, toPort, lane)
      : null;
  const charterBar =
    phaseBar ??
    budgetBar ??
    (!hasMerchantman
      ? "No galley merchantman flies your colors; a lane needs a ship."
      : !routeFrom || !routeTo
        ? "Name both ports of the lane."
        : laneHeld
          ? "The house already keeps that lane."
          : lane === null
            ? "No sea road joins those two ports."
            : undefined);

  const sealCharter = (): void => {
    if (!lane || !routeFrom || !routeTo) return;
    // quill_scratch on the seal-press; the coin_purse and the herald's toast
    // wait for the server's chronicle line, as with a bargain struck.
    playSfx("quill_scratch");
    awaitingRoute.current = true;
    dispatch({
      type: "TRADE",
      player: myPlayerId,
      trade: {
        kind: "ROUTE",
        fromProvinceId: routeFrom,
        toProvinceId: routeTo,
        seaZonePath: lane,
      },
    });
  };

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
              awaitingTax.current = posture;
              dispatch({ type: "SET_TAX", player: myPlayerId, posture });
              // The triumph toast follows the broadcast that carries the new
              // posture; a rejection surfaces GameProvider's error toast only.
            }}
          >
            Gather the Tithe
          </Button>
        </div>
      </section>

      {/* ZONE 8 · The routes held — and the charter that opens a new one */}
      <section className="mkt-section" aria-label="The routes held">
        <div className="mkt-route-strip">
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

        {/* Charter a lane — the TRADE "ROUTE" order. */}
        {myPorts.length < 2 ? (
          <p className="mkt-house-note">
            A charter asks two ports under your banner; the house cannot open
            a lane from one shore alone.
          </p>
        ) : (
          <div className="mkt-charter" aria-label="Charter a lane">
            <span className="mkt-charter-label">Charter a lane:</span>
            <label className="mkt-charter-label" htmlFor="mkt-charter-from">
              from
            </label>
            <select
              id="mkt-charter-from"
              className="mkt-charter-field"
              aria-label="The port the lane departs"
              value={routeFrom}
              onChange={(e) => setRouteFrom(e.target.value)}
            >
              <option value="">Choose a port</option>
              {myPorts
                .filter((p) => p.id !== routeTo)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <label className="mkt-charter-label" htmlFor="mkt-charter-to">
              to
            </label>
            <select
              id="mkt-charter-to"
              className="mkt-charter-field"
              aria-label="The port the lane makes for"
              value={routeTo}
              onChange={(e) => setRouteTo(e.target.value)}
            >
              <option value="">Choose a port</option>
              {myPorts
                .filter((p) => p.id !== routeFrom)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <span className="mkt-charter-seal">
              <Button
                variant="primary"
                disabled={pendingAction}
                disabledReason={charterBar}
                onClick={sealCharter}
              >
                {BUTTONS.setTheSeal}
              </Button>
            </span>
            <p className="mkt-charter-lane" aria-live="polite">
              {lane && projected ? (
                <>
                  The lane runs{" "}
                  {lane
                    .map((zoneId) => seaZoneById(gameState, zoneId)?.name ?? zoneId)
                    .join(", then ")}
                  {" — some "}
                  {numberWord(projected.gold)} Gold at each Reckoning
                  {projected.blockaded
                    ? ", while a blockade sits upon the water"
                    : ""}
                  . The charter costs one deed and sets a galley merchantman
                  upon the lane.
                </>
              ) : (
                <>
                  Name two of your ports and the house charts the sea road
                  between them. A charter costs one deed and asks a galley
                  merchantman; the lane pays gold at each Reckoning.
                </>
              )}
            </p>
            {charterBar !== undefined && routeFrom !== "" && routeTo !== "" && (
              <p className="mkt-exchange-reason" style={{ flexBasis: "100%" }}>
                {charterBar}
              </p>
            )}
          </div>
        )}
      </section>
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
