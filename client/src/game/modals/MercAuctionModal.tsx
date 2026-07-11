/**
 * MercAuctionModal — "The Free Companies": the §6.3 mercenary bid market of
 * design/mockups/market.html, wired to the DA-3 TRUE round-robin auction in
 * server/src/engine/mercenaries.ts.
 *
 * Engine reality (mercenaries.ts / balance.ts, mirrored here):
 *  - 2–3 named companies stand the block each round (`state.mercMarket`).
 *  - Opening bid ≥ the company's minBid; a raise must better the standing bid
 *    by ≥ 1 gold (MERC_MARKET.minBidRaise). The bidder must hold the gold.
 *  - `offer.activeBidderId` = whose turn it is in the round-robin (undefined
 *    until the first raise/pass — anyone may open). `offer.passedPlayerIds` =
 *    players out of this offer's auction; a pass is PERMANENT.
 *  - The auction closes when one non-passed bidder remains: the survivor pays
 *    the standing bid at face value and fields the roster at once. A company
 *    nobody bid on may take NPC service when the market refreshes.
 *
 * Actions:
 *   raise: dispatch({ type: "MERC_BID", player, companyId, bid })
 *   pass:  dispatch({ type: "MERC_BID", player, companyId, bid: 0, pass: true })
 *
 * Routed by OverlayManager while selectors.isMercAuctionLive(state) is true;
 * the same company grid is reachable pre-auction from MarketModal's "The Free
 * Companies" leaf (this file exports the shared pieces).
 */
import { useRef, useState } from "react";
import type { MercCompanyOffer, Player, ResourceBundle } from "@imperium/shared";
import { UnitType } from "@imperium/shared";
import {
  Button,
  ConfirmModal,
  CREST_URL,
  IconChip,
  ICON_URL,
  Modal,
  RESOURCE_ICONS,
  useToast,
} from "../../ui";
import { useAudio } from "../../audio/AudioProvider";
import { useGame } from "../GameProvider";
import { playerById } from "../selectors";
import { useFreshLogEntries } from "../useFreshLog";
import { BUTTONS, FACTION_NAME, TURN_BANNER_MINE, turnBannerFor } from "../uiText";
// PROVENANCE: client/src/assets/market/company-card.svg is a byte copy of
// art/cards/event-card.svg (the parchment/Greek-key card frame). Imported raw
// so the frame's TITLE / body / type slots can carry the live company stats.
import companyCardRaw from "../../assets/market/company-card.svg?raw";
import "./market.css";

/* ---------------------------------------------------------------------------
 * Vendored balance data (client may not import server code).
 * PROVENANCE: server/src/engine/balance.ts — MERC_COMPANIES + MERC_MARKET
 * (§6.3). Re-copy when the balance table is tuned; companyIds are stable.
 * ------------------------------------------------------------------------- */

/** MERC_MARKET.minBidRaise — the minimum whole-gold raise over a standing bid. */
const MIN_BID_RAISE = 1;

interface MercCompanyInfo {
  name: string;
  /** Minimum opening bid, in gold. */
  minBid: number;
  /** Fielded roster (variants folded into their base UnitType). */
  roster: Partial<Record<UnitType, number>>;
  /** Varangian Remnant: fields as named elite heads (+1 in defence). */
  elite?: boolean;
}

const MERC_COMPANY_INFO: Record<string, MercCompanyInfo> = {
  CATALAN: {
    name: "Catalan Company",
    minBid: 12,
    roster: { [UnitType.INFANTRY]: 5, [UnitType.ARCHER]: 3 },
  },
  ST_GEORGE: {
    name: "Company of St George",
    minBid: 14,
    roster: { [UnitType.INFANTRY]: 4, [UnitType.CAVALRY]: 3 },
  },
  ALMOGAVARS: {
    name: "The Almogavars",
    minBid: 10,
    roster: { [UnitType.LEVY]: 6, [UnitType.CAVALRY]: 2, [UnitType.SIEGE]: 1 },
  },
  VARANGIAN_REMNANT: {
    name: "Varangian Remnant",
    minBid: 16,
    roster: { [UnitType.INFANTRY]: 4, [UnitType.CAVALRY]: 2 },
    elite: true,
  },
};

/** Company display data, tolerant of companies added server-side later. */
export function companyInfo(companyId: string): MercCompanyInfo {
  return (
    MERC_COMPANY_INFO[companyId] ?? { name: companyId, minBid: 1, roster: {} }
  );
}

/* ---------------------------------------------------------------------------
 * Shared wording helpers (numbers in prose are spelled as words — lore/ui-text
 * preamble; tallies and counters keep bare numerals).
 * ------------------------------------------------------------------------- */

const NUMBER_WORDS = [
  "nought", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
] as const;

/** Spell a small count as a word ("seven"); larger sums keep the numeral. */
export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length
    ? NUMBER_WORDS[n]
    : String(n);
}

/** Sentence-leading variant ("Three Timber for one Gold"). */
export function numberWordCap(n: number): string {
  const w = numberWord(n);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

const UNIT_LABEL: Record<UnitType, string> = {
  [UnitType.LEVY]: "Levies",
  [UnitType.INFANTRY]: "Infantry",
  [UnitType.CAVALRY]: "Cavalry",
  [UnitType.ARCHER]: "Archers",
  [UnitType.SIEGE]: "Siege engines",
  [UnitType.GALLEY]: "Galleys",
  [UnitType.WARSHIP]: "Warships",
};

/** "5 Infantry · 3 Archers" — tallies wear bare numerals. */
function rosterLine(info: MercCompanyInfo): string {
  const parts = Object.entries(info.roster)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([u, n]) => `${n} ${UNIT_LABEL[u as UnitType]}`);
  return parts.join(" · ");
}

/** Total heads a company fields. */
function rosterHeads(info: MercCompanyInfo): number {
  return Object.values(info.roster).reduce((acc, n) => acc + (n ?? 0), 0);
}

/** The in-voice store-shortage reasons (lore/ui-text.md §7, verbatim). */
export const STORE_SHORT: Record<keyof ResourceBundle, string> = {
  gold: "Not enough gold in the treasury.",
  grain: "The granaries are bare — no grain to spare.",
  timber: "The woodyards are empty — no timber for keel, wall, or engine.",
  marble: "The quarries have given their last — no marble for the work.",
  faith: "The people's faith will not stretch so far.",
};

const RESOURCE_LABEL: Record<keyof ResourceBundle, string> = {
  gold: "Gold",
  grain: "Grain",
  timber: "Timber",
  marble: "Marble",
  faith: "Faith",
};

/* ---------------------------------------------------------------------------
 * TreasuryStrip — the shared treasury readout (mockup zone 1).
 * ------------------------------------------------------------------------- */

export function TreasuryStrip(props: {
  /** Stores some lined-up purse/bargain asks for; short chips get the rim. */
  need?: Partial<ResourceBundle>;
}): JSX.Element | null {
  const { gameState, myPlayerId } = useGame();
  const my = playerById(gameState, myPlayerId);
  if (!my) return null;
  const holder = my.faction ? FACTION_NAME[my.faction] : my.name;
  return (
    <section
      className="panel panel--porphyry mkt-treasury"
      aria-label={`The treasury of ${holder}`}
    >
      <span className="mkt-treasury-title">The Treasury of {holder}</span>
      {RESOURCE_ICONS.map((k) => (
        <IconChip
          key={k}
          icon={k}
          label={RESOURCE_LABEL[k]}
          value={my.treasury[k]}
          short={my.treasury[k] < (props.need?.[k] ?? 0)}
          shortReason={STORE_SHORT[k]}
        />
      ))}
      <p className="mkt-treasury-hint">
        The vaults as they stand. Every purse and every bargain below draws
        upon them.
      </p>
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * The company card face — the art/cards frame with live stats in its slots.
 * ------------------------------------------------------------------------- */

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Fill the vendored card frame's title/body/type slots for one company. */
function companyCardSvg(companyId: string, info: MercCompanyInfo): string {
  // Namespace every internal id so several cards can stand on one page.
  let svg = companyCardRaw.replaceAll(
    "event-card-",
    `mkt-card-${companyId.toLowerCase()}-`,
  );
  const title = info.name.toUpperCase();
  const fontSize = title.length > 18 ? 10 : title.length > 13 ? 12 : 16;
  svg = svg.replace(
    'font-size="16" letter-spacing="2"',
    `font-size="${fontSize}" letter-spacing="1"`,
  );
  svg = svg.replace(">TITLE<", `>${escapeXml(title)}<`);
  svg = svg.replace(">EVENT<", ">FREE COMPANY<");
  const body = [
    rosterLine(info),
    `Opening bid ${info.minBid} Gold`,
    "Grain twofold each round it serves",
    info.elite ? "Elite — stands fast in defence" : "Unpaid, it deserts first",
  ];
  for (let i = 1; i <= 4; i++) {
    svg = svg.replace(
      `>Body text line ${i}<`,
      `>${escapeXml(body[i - 1] ?? "")}<`,
    );
  }
  return svg;
}

/* ---------------------------------------------------------------------------
 * FreeCompanies — the block itself (company cards + bid controls). Shared by
 * this modal and MarketModal's first leaf.
 * ------------------------------------------------------------------------- */

export function FreeCompanies(props: {
  offers: readonly MercCompanyOffer[];
  /**
   * Fired when the pass ConfirmModal opens/closes, so a host Modal can set
   * dismissable={false} while it is up (both traps listen for Escape on the
   * document; without this, Escape would fell host and confirm together).
   */
  onDialogToggle?: (open: boolean) => void;
}): JSX.Element {
  const { gameState, myPlayerId, pendingAction, dispatch } = useGame();
  const { playSfx } = useAudio();
  const toast = useToast();
  // Purse chosen per company (uncommitted; re-floored against rival raises).
  const [purses, setPurses] = useState<Record<string, number>>({});
  const [passTarget, setPassTargetRaw] = useState<string | null>(null);
  const setPassTarget = (id: string | null): void => {
    setPassTargetRaw(id);
    props.onDialogToggle?.(id !== null);
  };

  const my = playerById(gameState, myPlayerId);
  const gold = my?.treasury.gold ?? 0;
  const open = props.offers.filter((o) => !o.sold);

  /* ---- confirmation flourish --------------------------------------------------
   * dispatch() is fire-and-forget and a rival's raise may land first; the
   * triumph toast and the coin_purse confirm the DEED, so they wait for the
   * broadcast whose chronicle carries my bid (mercenaries.ts logs type
   * "mercenary", my seat among the actors, data {companyId, bid} — the hire /
   * disperse lines carry data.fielded and the pass line data.pass, excluded). */
  const awaitingBid = useRef(false);
  useFreshLogEntries((entries) => {
    if (!awaitingBid.current) return;
    for (const e of entries) {
      if (
        e.type === "mercenary" &&
        e.actors.includes(myPlayerId) &&
        typeof e.data?.bid === "number" &&
        e.data?.pass === undefined &&
        e.data?.fielded === undefined
      ) {
        awaitingBid.current = false;
        playSfx("coin_purse");
        toast.triumph("So it is written.");
        break;
      }
    }
  });

  const factionNameOf = (p: Player | null): string =>
    p ? (p.faction ? FACTION_NAME[p.faction] : p.name) : "another house";

  if (open.length === 0) {
    return (
      <p className="rubric">
        The block stands empty — no free company waits upon a paymaster this
        round.
      </p>
    );
  }

  const setPurse = (companyId: string, value: number): void => {
    playSfx("ui_click");
    setPurses((prev) => ({ ...prev, [companyId]: value }));
  };

  const raise = (companyId: string, bid: number): void => {
    // quill_scratch belongs to the press itself; coin_purse and the triumph
    // toast wait for the server to chronicle the bid (see watcher above).
    playSfx("quill_scratch");
    awaitingBid.current = true;
    // Correlation predicate for the pendingAction latch: rival-caused
    // broadcasts land while my bid is in flight, and must not re-arm the
    // button (double-click → two MERC_BIDs). The raise button is disabled
    // while I already stand highest, so "I am the high bidder on this
    // company" can only become true because THIS bid was applied.
    dispatch(
      { type: "MERC_BID", player: myPlayerId, companyId, bid },
      {
        resolvedWhen: (state) =>
          state.mercMarket.some(
            (o) => o.companyId === companyId && o.highBidderId === myPlayerId,
          ),
      },
    );
  };

  const pass = (companyId: string): void => {
    setPassTarget(null);
    // Latch predicate: the engine records my pass in the offer's
    // passedPlayerIds before any auction-close bookkeeping, so its presence
    // (or the offer having resolved entirely) proves the pass was applied.
    dispatch(
      {
        type: "MERC_BID",
        player: myPlayerId,
        companyId,
        bid: 0,
        pass: true,
      },
      {
        resolvedWhen: (state) =>
          state.mercMarket.some(
            (o) =>
              o.companyId === companyId &&
              (o.sold || (o.passedPlayerIds ?? []).includes(myPlayerId)),
          ),
      },
    );
  };

  return (
    <>
      <p className="mkt-note">
        The hammer falls when every purse but one is withdrawn; a company no
        one bids upon may take service with a lesser power when the round
        ends.
      </p>
      <section className="mkt-section" aria-label="The companies on the block">
        <h3 className="mkt-section-title">Upon the Block This Round</h3>
        <ul className="mkt-company-grid">
          {open.map((offer) => {
            const info = companyInfo(offer.companyId);
            const heads = rosterHeads(info);
            const floor =
              offer.highBidderId == null
                ? info.minBid
                : offer.currentBid + MIN_BID_RAISE;
            const passed = (offer.passedPlayerIds ?? []).includes(myPlayerId);
            const highBidder = offer.highBidderId
              ? playerById(gameState, offer.highBidderId)
              : null;
            const highMine = offer.highBidderId === myPlayerId;
            const activeBidder = offer.activeBidderId
              ? playerById(gameState, offer.activeBidderId)
              : null;
            const myWord =
              offer.activeBidderId === undefined ||
              offer.activeBidderId === myPlayerId;
            const purse = Math.min(
              Math.max(purses[offer.companyId] ?? floor, floor),
              Math.max(gold, floor),
            );

            // Why the purse cannot be raised right now, in voice (first hit).
            const bidBar = passed
              ? "You have passed upon this company; a pass is not recalled."
              : highMine
                ? "Your purse stands highest; await another's answer."
                : !myWord
                  ? `The word is with ${factionNameOf(activeBidder)}.`
                  : gold < floor
                    ? "The treasury cannot bear it."
                    : undefined;

            const passBar = passed
              ? "You have passed upon this company; a pass is not recalled."
              : highMine
                ? "Your purse stands highest; the block will not release you."
                : !myWord
                  ? `The word is with ${factionNameOf(activeBidder)}.`
                  : undefined;

            const passedNames = (offer.passedPlayerIds ?? [])
              .map((id) => factionNameOf(playerById(gameState, id)))
              .filter((n, i, all) => all.indexOf(n) === i);

            return (
              <li
                key={offer.companyId}
                className={
                  offer.activeBidderId === myPlayerId
                    ? "mkt-company is-live"
                    : "mkt-company"
                }
              >
                <span
                  className="mkt-cardface"
                  aria-hidden="true"
                  // The frame is decorative chrome; the stats it carries are
                  // repeated as real text in the list below.
                  dangerouslySetInnerHTML={{
                    __html: companyCardSvg(offer.companyId, info),
                  }}
                />
                <h4 className="mkt-company-name">{info.name}</h4>
                <ul className="mkt-stats">
                  <li>
                    <b className="mkt-term">Strength</b>
                    {Array.from({ length: heads }, (_, i) => (
                      <span key={i} className="mkt-die" aria-hidden="true" />
                    ))}{" "}
                    {numberWordCap(heads)} dice afield{" "}
                    <img
                      className="mkt-inline-icon"
                      src={ICON_URL.army}
                      alt=""
                    />
                    <br />
                    {rosterLine(info)}
                    {info.elite ? " — elite, stands fast in defence" : ""}
                  </li>
                  <li>
                    <b className="mkt-term">Upkeep</b>
                    <img
                      className="mkt-inline-icon"
                      src={ICON_URL.grain}
                      alt=""
                    />{" "}
                    Grain twofold each round it serves; unpaid, hired steel
                    deserts first.
                  </li>
                  <li>
                    <b className="mkt-term">Highest Bid</b>
                    {highBidder ? (
                      <span className="mkt-bid-line">
                        {highBidder.faction && (
                          <span className="mkt-crest">
                            <img
                              src={CREST_URL[highBidder.faction]}
                              alt={`Crest of ${FACTION_NAME[highBidder.faction]}`}
                            />
                          </span>
                        )}
                        {highMine
                          ? `Your purse of ${numberWord(offer.currentBid)} Gold stands highest`
                          : `${factionNameOf(highBidder)} bids ${numberWord(offer.currentBid)} Gold`}
                      </span>
                    ) : (
                      <span className="mkt-bid-line">
                        No purse yet opened — the hammer waits.
                      </span>
                    )}
                  </li>
                  {offer.activeBidderId !== undefined && (
                    <li>
                      <b className="mkt-term">The Word</b>
                      {offer.activeBidderId === myPlayerId
                        ? TURN_BANNER_MINE
                        : turnBannerFor(factionNameOf(activeBidder))}
                    </li>
                  )}
                  {passedNames.length > 0 && (
                    <li>
                      <b className="mkt-term">Withdrawn</b>
                      <span className="mkt-pass-pills">
                        {passedNames.map((n) => (
                          <span key={n} className="pill">
                            {n} passes
                          </span>
                        ))}
                      </span>
                    </li>
                  )}
                </ul>

                {!passed && (
                  <div className="mkt-bid-control">
                    <span
                      className="mkt-stepper"
                      role="group"
                      aria-label="Set your purse in Gold"
                    >
                      <button
                        type="button"
                        aria-label="Lighten the purse by one Gold"
                        disabled={purse <= floor || bidBar !== undefined}
                        onClick={() => setPurse(offer.companyId, purse - 1)}
                      >
                        −
                      </button>
                      <b className="mkt-stepper-value">{purse}</b>
                      <button
                        type="button"
                        aria-label="Weight the purse by one Gold"
                        disabled={purse >= gold || bidBar !== undefined}
                        onClick={() => setPurse(offer.companyId, purse + 1)}
                      >
                        +
                      </button>
                    </span>
                    <Button
                      variant="primary"
                      disabledReason={bidBar}
                      disabled={pendingAction}
                      onClick={() => raise(offer.companyId, purse)}
                    >
                      Raise the Purse
                    </Button>
                    <Button
                      variant="quiet"
                      disabledReason={passBar}
                      disabled={pendingAction}
                      onClick={() => setPassTarget(offer.companyId)}
                    >
                      {BUTTONS.pass}
                    </Button>
                    {bidBar === undefined && (
                      <p className="mkt-hint">
                        Your purse stands at {numberWord(purse)} Gold;{" "}
                        {offer.highBidderId == null
                          ? `it must open at ${numberWord(info.minBid)} or more.`
                          : `it must better the standing ${numberWord(offer.currentBid)}.`}{" "}
                        Until the purse is raised, the Gold stays in the vault.
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {passTarget !== null && (
        <ConfirmModal
          title={BUTTONS.pass}
          consequence={`Pass upon the ${companyInfo(passTarget).name}? A pass is not recalled — this block is closed to you until the hammer falls.`}
          confirmLabel={BUTTONS.pass}
          cancelLabel={BUTTONS.cancel}
          onConfirm={() => pass(passTarget)}
          onCancel={() => setPassTarget(null)}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------------------
 * The modal proper — auto-routed while the round-robin is live.
 * ------------------------------------------------------------------------- */

export interface MercAuctionModalProps {
  /** The full merc market for the round (sold and unsold offers). */
  offers: readonly MercCompanyOffer[];
  onClose: () => void;
}

export function MercAuctionModal({
  offers,
  onClose,
}: MercAuctionModalProps): JSX.Element {
  const { gameState } = useGame();
  // While the pass ConfirmModal is up, this modal must not answer Escape.
  const [subDialog, setSubDialog] = useState(false);

  // The cheapest way to stay in any auction — flags the gold chip short.
  const floors = offers
    .filter((o) => !o.sold)
    .map((o) =>
      o.highBidderId == null
        ? companyInfo(o.companyId).minBid
        : o.currentBid + MIN_BID_RAISE,
    );
  const need =
    floors.length > 0 ? { gold: Math.min(...floors) } : undefined;

  // The cries of the block — the mercenary lines of this round's chronicle.
  const cries = gameState.log
    .filter((e) => e.type === "mercenary" && e.round === gameState.round)
    .slice(-8);

  return (
    <Modal title="The Free Companies" onClose={onClose} wide dismissable={!subDialog}>
      <TreasuryStrip need={need} />
      <FreeCompanies offers={offers} onDialogToggle={setSubDialog} />
      {cries.length > 0 && (
        <section
          className="mkt-section mkt-log"
          aria-label="The cries of the block"
        >
          <h3 className="mkt-section-title">The Cries of the Block</h3>
          <ul>
            {cries.map((e) => (
              <li key={e.id}>{e.message}</li>
            ))}
          </ul>
        </section>
      )}
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          {BUTTONS.close}
        </Button>
      </div>
    </Modal>
  );
}
