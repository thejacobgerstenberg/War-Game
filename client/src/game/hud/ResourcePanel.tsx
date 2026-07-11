/**
 * ResourcePanel — HUD feature area. Implements game.html callouts 4–5:
 *
 *  - "The Treasury": the five stores (Gold, Grain, Timber, Marble, Faith),
 *    icon + word + count, always all three (colorblind-safe — README §3).
 *    Hover/focus a chip for the seasonal income breakdown by province;
 *    `.is-short` (crimson rim + in-voice reason) marks a store that cannot
 *    bear the order currently armed in the action bar.
 *  - The tithe posture (TaxPosture; §4.2 gold multiplier mirrored for
 *    display) — task contract "tax posture indicator".
 *  - "Renown": the full nought-to-twenty prestige track with a crest marker
 *    for EVERY seated power, plus the victory threshold for this table
 *    (mirrored from the engine's balance.PRESTIGE_THRESHOLDS).
 *  - "The Powers Assemble": seat chips — crest + faction word + player name,
 *    prestige count, whose turn it is, and per-seat connection state.
 *  - A persistent connection notice while the socket is down.
 *
 * Data: useGame() -> me().treasury/prestige/tax, every player's prestige/
 * connected for the shared track and seat chips; useSelection().armedOrder
 * for the is-short wiring. Copy: lore/ui-text.md §2/§4/§5/§7 via uiText or
 * quoted verbatim below.
 */
import { useEffect, useMemo, useState } from "react";
import { TaxPosture } from "@imperium/shared";
import type { Player, ResourceBundle } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { useSelection } from "../SelectionContext";
import { Panel, Tooltip, ICON_URL, CREST_URL } from "../../ui";
import {
  CONNECTION,
  FACTION_NAME,
  RESOURCE_TOOLTIP,
  TURN_BANNER_MINE,
  turnBannerFor,
} from "../uiText";
import { activePlayerId as selectActivePlayerId, me, provincesOf } from "../selectors";
import { FACTION_SLUG } from "../../board/types";
import { getSocket } from "../../socket";
import type { OrderKind } from "../types";
import "./hud.css";

/** The five stores, in the Treasury rail's display order (game.html). */
const STORES = ["gold", "grain", "timber", "marble", "faith"] as const;
type StoreKey = (typeof STORES)[number];

const STORE_LABEL: Record<StoreKey, string> = {
  gold: "Gold",
  grain: "Grain",
  timber: "Timber",
  marble: "Marble",
  faith: "Faith",
};

/** In-voice "cannot bear the order" reasons (lore/ui-text.md §7, 1–5). */
const SHORT_REASON: Record<StoreKey, string> = {
  gold: "Not enough gold in the treasury.",
  grain: "The granaries are bare — no grain to spare.",
  timber: "The woodyards are empty — no timber for keel, wall, or engine.",
  marble: "The quarries have given their last — no marble for the work.",
  faith: "The people's faith will not stretch so far.",
};

/**
 * DISPLAY MIRROR of server/src/engine/balance.ts PRESTIGE_THRESHOLDS (§13.2)
 * — the prestige a crown must reach to close the reckoning early, by seated
 * player count. The engine remains authoritative; re-mirror when rebalanced.
 */
const PRESTIGE_THRESHOLD_BY_PLAYER_COUNT: Record<number, number> = {
  2: 72,
  3: 78,
  4: 80,
  5: 80,
};
const PRESTIGE_THRESHOLD_FALLBACK = 80;

/** DISPLAY MIRROR of balance.TAX_MULTIPLIERS (§4.2 — gold income only). */
const TAX_DISPLAY: Record<TaxPosture, { word: string; multiplier: string }> = {
  [TaxPosture.LENIENT]: { word: "Lenient", multiplier: "×0.75" },
  [TaxPosture.NORMAL]: { word: "Normal", multiplier: "×1" },
  [TaxPosture.HEAVY]: { word: "Heavy", multiplier: "×1.5" },
};

/**
 * DISPLAY MIRROR of the armed order's up-front cost, for the `.is-short`
 * rim: Muster = one levy (balance.UNIT_STATS[LEVY].cost), Raise = the
 * cheapest building (balance.BUILDING_COSTS[BARRACKS]). The other orders
 * spend no store up front. The engine remains authoritative on rejection.
 */
const ORDER_COST: Partial<Record<OrderKind, Partial<ResourceBundle>>> = {
  muster: { gold: 2, grain: 1 },
  raise: { gold: 4, timber: 2 },
};

/** The prestige track runs nought to twenty (game.html callout 5). */
const TRACK_MAX = 20;

/** True while the socket can reach the table (drives the herald notice). */
function useSocketConnected(): boolean {
  const [connected, setConnected] = useState<boolean>(() => getSocket().connected);
  useEffect(() => {
    const socket = getSocket();
    const onConnect = (): void => setConnected(true);
    const onDisconnect = (): void => setConnected(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, []);
  return connected;
}

export interface ResourcePanelProps {
  className?: string;
}

export function ResourcePanel({ className }: ResourcePanelProps): JSX.Element {
  const { gameState, myPlayerId } = useGame();
  const { armedOrder } = useSelection();
  const connected = useSocketConnected();

  const my = me(gameState, myPlayerId);
  const treasury = my?.treasury ?? { gold: 0, grain: 0, timber: 0, marble: 0, faith: 0 };
  const armedCost = armedOrder !== null ? ORDER_COST[armedOrder] : undefined;

  // Seasonal income by store, derived from my provinces' per-turn yields
  // (Province.yields). Buildings/routes/tithe land server-side at Income;
  // this is the base "yields each season" readout of the province card.
  const income = useMemo(() => {
    const mine = provincesOf(gameState, myPlayerId);
    const totals: Record<StoreKey, number> = {
      gold: 0,
      grain: 0,
      timber: 0,
      marble: 0,
      faith: 0,
    };
    const lines: Record<StoreKey, string[]> = {
      gold: [],
      grain: [],
      timber: [],
      marble: [],
      faith: [],
    };
    for (const province of mine) {
      for (const key of STORES) {
        const n = province.yields[key];
        if (n > 0) {
          totals[key] += n;
          lines[key].push(`${province.name} ${n}`);
        }
      }
    }
    return { totals, lines };
  }, [gameState, myPlayerId]);

  const seated = gameState.players.filter(
    (p): p is Player & { faction: NonNullable<Player["faction"]> } => p.faction !== null,
  );
  const threshold =
    PRESTIGE_THRESHOLD_BY_PLAYER_COUNT[gameState.players.length] ??
    PRESTIGE_THRESHOLD_FALLBACK;
  const turnPlayerId = selectActivePlayerId(gameState);

  return (
    <div className={["stack", className ?? ""].filter(Boolean).join(" ")}>
      {!connected && (
        <p className="hud-connection" role="status">
          {CONNECTION.lost}
        </p>
      )}

      <Panel title="The Treasury" ariaLabel="The treasury" className="hud-treasury">
        <div className="stack" style={{ gap: "var(--space-2)" }}>
          {STORES.map((key) => {
            const need = armedCost?.[key];
            const short = need !== undefined && treasury[key] < need;
            const breakdown =
              income.lines[key].length > 0
                ? ` Yields each season: ${income.lines[key].slice(0, 6).join(" · ")}${
                    income.lines[key].length > 6 ? " · …" : ""
                  }.`
                : "";
            return (
              <Tooltip key={key} label={`${RESOURCE_TOOLTIP[key]}${breakdown}`}>
                <span
                  className={`resource-chip${short ? " is-short" : ""}`}
                  tabIndex={0}
                  title={short ? SHORT_REASON[key] : undefined}
                >
                  <span className="chip-icon" aria-hidden="true">
                    <img src={ICON_URL[key]} alt="" />
                  </span>
                  <span className="name">{STORE_LABEL[key]}</span>
                  {income.totals[key] > 0 && (
                    <span className="hud-delta">+{income.totals[key]}</span>
                  )}
                  <b className="value">{treasury[key]}</b>
                </span>
              </Tooltip>
            );
          })}

          {/* The tithe posture (tax; §4.2 gold multiplier, display mirror). */}
          {my !== null && (
            <Tooltip label="Levy the Tithe — Wring gold from your provinces.">
              <span className="resource-chip hud-tithe" tabIndex={0}>
                <span className="chip-icon" aria-hidden="true">
                  <img src={ICON_URL.gold} alt="" />
                </span>
                <span className="name">The Tithe</span>
                <b className="value">
                  {TAX_DISPLAY[my.tax].word} {TAX_DISPLAY[my.tax].multiplier}
                </b>
              </span>
            </Tooltip>
          )}
        </div>
      </Panel>

      <Panel ariaLabel="The Prestige track" className="hud-renown">
        <h2 className="panel-title hud-renown-title">
          <span className="hud-title-icon" aria-hidden="true">
            <img src={ICON_URL.prestige} alt="" />
          </span>
          <Tooltip label={RESOURCE_TOOLTIP.prestige}>
            <span tabIndex={0}>Renown</span>
          </Tooltip>
        </h2>

        <ol className="prestige-track hud-prestige" aria-label="Prestige, nought to twenty">
          {Array.from({ length: TRACK_MAX + 1 }, (_, notch) => {
            const holders = seated.filter(
              (p) => Math.max(0, Math.min(TRACK_MAX, p.prestige)) === notch,
            );
            return (
              <li
                key={notch}
                className={`notch${holders.length > 0 ? " is-held" : ""}`}
              >
                {notch}
                {holders.map((p) => {
                  const delta = p.prestigeThisRound ?? 0;
                  const stands = `${FACTION_NAME[p.faction]} stands at ${p.prestige}${
                    delta !== 0 ? ` (${delta > 0 ? "+" : ""}${delta} this round)` : ""
                  }`;
                  return (
                    <span key={p.id} className="marker" title={stands}>
                      <img src={CREST_URL[p.faction]} alt={stands} />
                    </span>
                  );
                })}
              </li>
            );
          })}
        </ol>

        {/* Victory threshold for this table — mirrored from the engine's
            balance.PRESTIGE_THRESHOLDS; the line is game.html's legend with
            the count adjusted to the engine's real number. */}
        <p className="rubric hud-renown-note">
          First to {threshold} — or the fall of the City — closes the reckoning.
        </p>
        <p className="rubric hud-renown-note" style={{ fontStyle: "italic" }}>
          The regard of the world — won or squandered, never spent.
        </p>
      </Panel>

      <Panel title="The Powers Assemble" ariaLabel="The seated powers">
        <ul className="hud-powers">
          {seated.map((p) => {
            const isTurn = p.id === turnPlayerId;
            const isMe = p.id === myPlayerId;
            const banner = isMe ? TURN_BANNER_MINE : turnBannerFor(FACTION_NAME[p.faction]);
            const readout = [
              `${p.name}, ${FACTION_NAME[p.faction]}, prestige ${p.prestige}`,
              isMe ? "Your banner flies here." : "",
              isTurn ? banner : "",
              !p.connected ? CONNECTION.lost : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <li
                key={p.id}
                data-faction={FACTION_SLUG[p.faction]}
                className={[
                  isTurn ? "is-active" : "",
                  !p.connected ? "is-away" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                tabIndex={0}
                aria-label={readout}
                {...(isTurn ? { "aria-current": "true" as const } : {})}
              >
                <img className="hud-power-crest" src={CREST_URL[p.faction]} alt="" />
                <span className="hud-power-names">
                  <span className="hud-power-faction">{FACTION_NAME[p.faction]}</span>
                  <span className="hud-power-name" title={isMe ? "Your banner flies here." : p.name}>
                    {p.name}
                  </span>
                </span>
                <span className="hud-power-marks">
                  {!p.connected && (
                    <span className="hud-power-away" title={CONNECTION.lost} aria-hidden="true">
                      ✕
                    </span>
                  )}
                  {isTurn && (
                    <span className="hud-power-turn" title={banner} aria-hidden="true">
                      ⧗
                    </span>
                  )}
                  <span className="hud-power-prestige" title={RESOURCE_TOOLTIP.prestige}>
                    <img src={ICON_URL.prestige} alt="" aria-hidden="true" />
                    {p.prestige}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
