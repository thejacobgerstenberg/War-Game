/**
 * Shared Playwright helpers for IMPERIUM game E2E (built on the real client
 * UI against the real server — no mocks).
 *
 * DETERMINISM (e2e/playwright.config.ts server env):
 *   - GAME_SEED=424242        every game this server starts uses this RNG
 *                             seed — deck order, tactic draws, dice, merc
 *                             offers are all replayable (see the PLAYBOOK).
 *   - PRESTIGE_TARGET=12      the §13.2 victory threshold is lowered so a
 *                             2-player game ends with a REAL engine victory
 *                             at round III's cleanup (BYZANTIUM wins 20 v 10
 *                             when the playbook is followed).
 *   - TURN_SECONDS=off        no breath-timer auto-advance racing slow CI.
 *   Both knobs are server-side test-only envs (docs/ARCHITECTURE.md,
 *   Operations — env-var table) and log a loud `test_knob_active` warning.
 *
 * BOARD FIXTURE: the vendored client board art still uses the retired
 * 53-region id scheme, so most canon provinces (constantinople, selymbria,
 * edirne, ...) have no clickable/visible shape on the real map. Two answers,
 * both used here:
 *   1. `selectProvince()` drives the ProvinceInspector's "Or seek it by
 *      name" picker + "Adjoining lands and waters" pills — selection with NO
 *      dependency on the SVG at all (this is the a11y path, and it is the
 *      primary mechanism all flow helpers use).
 *   2. `mountCanonBoard()` serves fixtures/canon-board-full.svg (all 55
 *      canon provinces + 12 seas as a schematic grid) through the GameBoard
 *      `?svgUrl=` test hook, so screenshots show ownership shading / unit
 *      badges / siege markers on real canon provinces. createTwoPlayerGame
 *      does this for you.
 *
 * PHASE MODEL (engine GamePhase -> TopBar step): INCOME="Income",
 * RECRUITMENT="Muster", MOVEMENT="Campaign", DIPLOMACY and COMBAT both
 * render "Council", END="Twilight". `onward()` (HOST-ONLY: ADVANCE_PHASE is
 * host-gated) advances exactly one engine phase and auto-answers the
 * ConfirmModal that interposes inside action windows.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { Browser, BrowserContext, Page, TestInfo } from "@playwright/test";

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The seed the e2e server is pinned to (playwright.config.ts webServer env). */
export const E2E_SEED = 424242;
/** The lowered §13.2 victory threshold the e2e server is pinned to. */
export const E2E_PRESTIGE_TARGET = 12;

/** Extra screenshot sink (besides testInfo attachments). Override with E2E_SHOTS_DIR. */
export const SHOTS_DIR =
  process.env.E2E_SHOTS_DIR ??
  path.join(HELPERS_DIR, "..", "..", "test-results", "game-shots");

/** Canon-id board fixture (see file header + fixtures/gen-canon-board.ts). */
export const CANON_BOARD_FIXTURE = path.join(
  HELPERS_DIR,
  "fixtures",
  "canon-board-full.svg",
);
/**
 * Pathname the fixture is served under. Deliberately extensionless: vite dev
 * 403s any page URL whose query mentions a `.svg` file outside its allow
 * list, and this URL rides in the `?svgUrl=` query of the app URL.
 */
export const CANON_BOARD_URL = "/e2e/canon-board";

/** Faction display names as the FactionPick buttons and TopBar render them. */
export const FACTION_LABEL = {
  BYZANTIUM: "Byzantium",
  OTTOMAN: "The Ottomans",
  VENICE: "Venice",
  GENOA: "Genoa",
  HUNGARY: "Hungary",
} as const;
export type FactionKey = keyof typeof FACTION_LABEL;

/** Muster-tray unit row labels (ActionBar MusterTray steppers). */
export const UNIT_LABEL = {
  LEVY: "Levy",
  INFANTRY: "Infantry",
  ARCHER: "Archer",
  CAVALRY: "Cavalry",
  SIEGE: "Siege Engine",
  GALLEY: "Galley",
  WARSHIP: "Warship",
} as const;
export type UnitKey = keyof typeof UNIT_LABEL;

export interface PlayerHandle {
  context: BrowserContext;
  page: Page;
  name: string;
  faction: FactionKey;
}

export interface TwoPlayerGame {
  /** Seat 1 — created the room; the ONLY seat that may call onward(). */
  host: PlayerHandle;
  guest: PlayerHandle;
  roomCode: string;
  /** Close both contexts (call in finally / afterEach). */
  close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Board fixture mount
// ---------------------------------------------------------------------------

/**
 * Register the canon-board fixture route on a page. Must run BEFORE the
 * page's goto; pair with `appUrl()` so the GameBoard mounts the fixture.
 */
export async function mountCanonBoard(page: Page): Promise<void> {
  await page.route(
    (u) => u.pathname === CANON_BOARD_URL,
    (route) =>
      route.fulfill({ path: CANON_BOARD_FIXTURE, contentType: "image/svg+xml" }),
  );
}

/** App URL that arms the GameBoard `?svgUrl=` test hook. */
export function appUrl(): string {
  return `/?svgUrl=${CANON_BOARD_URL}`;
}

// ---------------------------------------------------------------------------
// Lobby flows (current lore copy — Home/CreateJoin/FactionPick/Lobby screens)
// ---------------------------------------------------------------------------

/** Home -> "Convene a Game" -> name -> faction pick; lands in the Gathering Hall. */
export async function createGameToLobby(
  page: Page,
  playerName: string,
  faction: FactionKey,
): Promise<void> {
  await page.goto(appUrl());
  await page.getByRole("button", { name: "Convene a Game" }).click();
  await page.getByLabel("Your Name").fill(playerName);
  await page.getByRole("button", { name: "Convene a Game" }).click();
  await expect(
    page.getByRole("heading", { name: "Under which banner will you ride?" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: new RegExp(`^${FACTION_LABEL[faction]}`) })
    .click();
  await page.getByRole("button", { name: "Onward" }).click();
  await expect(
    page.getByRole("heading", { name: "The Gathering Hall" }),
  ).toBeVisible();
}

/** Home -> "Answer a Summons" -> name+code -> faction pick -> Gathering Hall. */
export async function joinGameToLobby(
  page: Page,
  playerName: string,
  roomCode: string,
  faction: FactionKey,
): Promise<void> {
  await page.goto(appUrl());
  await page.getByRole("button", { name: "Answer a Summons" }).click();
  await page.getByLabel("Your Name").fill(playerName);
  await page.getByLabel("Summons code, six characters").fill(roomCode);
  await page.getByRole("button", { name: "Take Your Seat" }).click();
  await expect(
    page.getByRole("heading", { name: "Under which banner will you ride?" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: new RegExp(`^${FACTION_LABEL[faction]}`) })
    .click();
  await page.getByRole("button", { name: "Onward" }).click();
  await expect(
    page.getByRole("heading", { name: "The Gathering Hall" }),
  ).toBeVisible();
}

/** Read the 6-char A-Z0-9 room code off the Gathering Hall screen. */
export async function readRoomCode(page: Page): Promise<string> {
  const codeEl = page.locator(".imp-code");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{6}$/);
  return (await codeEl.innerText()).trim();
}

/**
 * Boot a complete seeded 2-player game onto the game board. Both pages have
 * the canon board fixture mounted and sit at Round I, Income. Defaults are
 * the PLAYBOOK seats: Alice=BYZANTIUM (host) vs Bob=OTTOMAN.
 */
export async function createTwoPlayerGame(
  browser: Browser,
  opts: {
    names?: [string, string];
    factions?: [FactionKey, FactionKey];
    /**
     * Runs on each fresh page BEFORE any navigation — the hook for
     * `page.addInitScript`-based instrumentation (wire tap, socket tracker)
     * that must be installed ahead of the first goto.
     */
    prepare?: (page: Page) => Promise<void>;
  } = {},
): Promise<TwoPlayerGame> {
  const [hostName, guestName] = opts.names ?? ["Alice", "Bob"];
  const [hostFaction, guestFaction] = opts.factions ?? ["BYZANTIUM", "OTTOMAN"];

  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const close = async (): Promise<void> => {
    await hostContext.close();
    await guestContext.close();
  };
  try {
    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();
    if (opts.prepare) {
      await opts.prepare(hostPage);
      await opts.prepare(guestPage);
    }
    await mountCanonBoard(hostPage);
    await mountCanonBoard(guestPage);

    await createGameToLobby(hostPage, hostName, hostFaction);
    const roomCode = await readRoomCode(hostPage);
    await joinGameToLobby(guestPage, guestName, roomCode, guestFaction);

    await hostPage.getByRole("button", { name: "Open the Campaign" }).click();
    await expect(hostPage.locator(".gb-shell")).toBeVisible();
    await expect(guestPage.locator(".gb-shell")).toBeVisible();

    return {
      host: { context: hostContext, page: hostPage, name: hostName, faction: hostFaction },
      guest: { context: guestContext, page: guestPage, name: guestName, faction: guestFaction },
      roomCode,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// State readers (visible UI only — the raw state never reaches the DOM)
// ---------------------------------------------------------------------------

/** Current phase-track step name: Income|Muster|Campaign|Council|Twilight. */
export async function readPhase(page: Page): Promise<string> {
  return (
    await page.locator(".phase-track li.is-current .phase-name").innerText()
  ).trim();
}

/** Current round as the TopBar Roman numeral ("I".."XVI"). */
export async function readRound(page: Page): Promise<string> {
  return (await page.locator(".round-counter b").innerText()).trim();
}

/** Wait until the TopBar shows the given step ("Muster") / round ("II"). */
export async function expectPhase(page: Page, step: string): Promise<void> {
  await expect(
    page.locator(".phase-track li.is-current .phase-name"),
  ).toHaveText(step);
}
export async function expectRound(page: Page, roman: string): Promise<void> {
  await expect(page.locator(".round-counter b")).toHaveText(roman);
}

/** Remaining deed pips, from the ActionBar's "Deeds this campaign" gauge. */
export async function readDeedsRemaining(page: Page): Promise<number> {
  const text = await page.locator(".gb-bar").innerText();
  const m = /([IVX]+|nought) of [IVX]+ remain/i.exec(text.replace(/\n/g, " "));
  if (!m) throw new Error(`no deeds gauge in action bar: ${text.slice(0, 120)}`);
  const roman = m[1].toUpperCase();
  if (roman === "NOUGHT") return 0;
  const values: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
  return values[roman] ?? 0;
}

// ---------------------------------------------------------------------------
// Selection (map-free primary path; the fixture map also works via click)
// ---------------------------------------------------------------------------

/**
 * Select a province/sea by its display name through the ProvinceInspector's
 * "Or seek it by name" picker. Clears any existing selection first (Escape on
 * the board viewport — armed orders in the ActionBar tray survive this).
 * Names are the canon display names, e.g. "Constantinople", "Selymbria",
 * "Edirne (Adrianople)", "Sea of Marmara".
 */
export async function selectProvince(page: Page, name: string): Promise<void> {
  const picker = page.getByLabel("Or seek it by name");
  if (!(await picker.isVisible().catch(() => false))) {
    await page.locator(".board-viewport").press("Escape");
    await picker.waitFor();
  }
  await picker.fill(name);
  await page
    .locator(".insp-picker-list")
    .getByRole("button", { name, exact: true })
    .click();
}

/**
 * With a province already selected, move the selection to a neighbor by
 * clicking its pill in the inspector's "Adjoining lands and waters" list.
 * This is how a March's destination is chosen without touching the map.
 */
export async function selectAdjacent(page: Page, name: string): Promise<void> {
  await page
    .locator(".gb-right")
    .getByRole("button", { name, exact: true })
    .click();
}

// ---------------------------------------------------------------------------
// Orders (two-step: arm -> target -> "Set the Seal")
// ---------------------------------------------------------------------------

/**
 * Arm an order from the ActionBar (`.gb-bar`, the "orders of the campaign"
 * footer). Scoped because the ProvinceInspector renders its OWN order
 * buttons for the selected province (e.g. "March" on a rival province,
 * "Muster" on an owned one), so a bare page-wide role query is ambiguous
 * whenever a province is still selected from an earlier step.
 */
async function armOrder(page: Page, name: string): Promise<void> {
  await page.locator(".gb-bar").getByRole("button", { name, exact: true }).click();
}

/** Click "Set the Seal" in the open order tray. */
export async function sealConfirm(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Set the Seal" }).click();
}

/**
 * Muster (RECRUIT): arm Muster, select an owned province, bump unit steppers,
 * seal. `units` maps UnitKey/unique-unit display name -> count.
 * Example: recruit(page, "Constantinople", { INFANTRY: 1 }).
 */
export async function recruit(
  page: Page,
  provinceName: string,
  units: Partial<Record<UnitKey, number>> & Record<string, number>,
): Promise<void> {
  await armOrder(page, "Muster");
  await selectProvince(page, provinceName);
  for (const [key, count] of Object.entries(units)) {
    const label = (UNIT_LABEL as Record<string, string>)[key] ?? key;
    const more = page.getByRole("button", { name: `More ${label}`, exact: true });
    for (let i = 0; i < (count ?? 0); i++) await more.click();
  }
  await sealConfirm(page);
}

/**
 * March (MOVE): arm March, select the host's province, then a legal
 * destination via the inspector adjacency pills, optionally tick "Lay Siege",
 * seal. Marching into a foe declares a battle (CombatModal opens for both
 * parties); into a walled foe with `siege` it lays a siege instead.
 */
export async function marchOrder(
  page: Page,
  fromName: string,
  toName: string,
  opts: { siege?: boolean } = {},
): Promise<void> {
  await armOrder(page, "March");
  await selectProvince(page, fromName);
  await selectAdjacent(page, toName);
  if (opts.siege) {
    await page.getByRole("checkbox", { name: /Lay Siege/ }).check();
  }
  await sealConfirm(page);
}

/**
 * HOST-ONLY. Advance exactly one engine phase ("Onward" -> ADVANCE_PHASE).
 * Inside an action window (Muster / Campaign / Council-as-DIPLOMACY) a
 * ConfirmModal interposes — answered automatically. The phase track cannot
 * distinguish DIPLOMACY from COMBAT (both display "Council"), hence the
 * opportunistic confirm rather than a phase-name check.
 */
export async function onward(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Onward" }).click();
  const confirm = page.getByRole("button", { name: "So Be It" });
  const interposed = await confirm
    .waitFor({ timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (interposed) await confirm.click();
}

/**
 * HOST-ONLY. Run the remainder of the CURRENT round to the next round's
 * Income (or to victory). From Income that is 6 onward()s: Income->Muster->
 * Campaign->Council(DIPLOMACY)->Council(COMBAT)->Twilight->cleanup.
 */
export async function advancePhases(page: Page, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) await onward(page);
}

// ---------------------------------------------------------------------------
// Modals & overlays
// ---------------------------------------------------------------------------

/** Close whatever auto/local modal dialog is open ("Draw the Curtain"). */
export async function closeDialog(page: Page): Promise<void> {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Draw the Curtain" })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}

/**
 * Close the resolved CombatModal via its result banner: the victor's banner
 * button is "So It Is Written", the loser's "Let the Scribes Be Kind"; an
 * unresolved (still-pending) modal only offers "Draw the Curtain".
 */
export async function closeCombatModal(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  const banner = dialog.getByRole("button", {
    name: /So It Is Written|Let the Scribes Be Kind/,
  });
  if (await banner.isVisible().catch(() => false)) {
    await banner.click();
  } else {
    await dialog.getByRole("button", { name: "Draw the Curtain" }).click();
  }
  await dialog.waitFor({ state: "hidden" });
}

/**
 * Open the Free Companies block (ActionBar "Traffic" -> companies leaf is the
 * default) and raise the floor bid on a company by its display name (e.g.
 * "Company of St George"). Bidding is un-budgeted (costs no deed).
 */
export async function mercBidFloor(page: Page, companyName: string): Promise<void> {
  await page.getByRole("button", { name: "Traffic", exact: true }).click();
  const card = page.locator(".mkt-company", { hasText: companyName });
  await card.getByRole("button", { name: "Raise the Purse" }).click();
}

/**
 * Pass on a company in the live auction (the MercAuctionModal auto-opens for
 * every seat once a round-robin is live). Confirms the "a pass is not
 * recalled" sub-dialog.
 */
export async function mercPass(page: Page, companyName: string): Promise<void> {
  const card = page.locator(".mkt-company", { hasText: companyName });
  await card.getByRole("button", { name: "Hold, and Watch" }).click();
  // Pass confirm sub-dialog (same button label).
  await page
    .getByRole("button", { name: "Hold, and Watch" })
    .last()
    .click()
    .catch(() => undefined);
}

/** Toggle the Chronicle drawer over the map. */
export async function openChronicleDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "The Chronicle" }).click();
}

// ---------------------------------------------------------------------------
// Endgame
// ---------------------------------------------------------------------------

/** The victor's end-screen heading; the loser's reads "The Years Are Run". */
export const VICTORY_HEADING = "The Years Are Run — and You Stand First";
export const DEFEAT_HEADING = "The Years Are Run";

/** Wait for the end screen; returns true when this seat is the victor. */
export async function awaitEndScreen(page: Page): Promise<boolean> {
  const dialog = page.getByRole("dialog", { name: /The Years Are Run/ });
  await dialog.waitFor({ timeout: 20_000 });
  return dialog
    .getByRole("heading", { name: VICTORY_HEADING })
    .first()
    .isVisible();
}

/** From the end screen, open the illuminated Chronicle. */
export async function readTheChronicle(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Read the Chronicle" }).click();
  await expect(
    page.getByRole("heading", { name: "The Chronicle of a Game" }),
  ).toBeVisible();
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

/**
 * Screenshot to BOTH the default playwright output (as a named attachment on
 * the test) and the shared shots dir (SHOTS_DIR / E2E_SHOTS_DIR). Name them
 * in playbook order: 01-lobby, 02-income-r1, ...
 */
export async function shoot(
  page: Page,
  name: string,
  testInfo?: TestInfo,
): Promise<string> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${name}.png`);
  const buffer = await page.screenshot({ path: file });
  if (testInfo) {
    await testInfo.attach(name, { body: buffer, contentType: "image/png" });
  }
  return file;
}

// ---------------------------------------------------------------------------
// gauntlet additions (game-flow.spec.ts) — additive only, nothing above moves
// ---------------------------------------------------------------------------

/**
 * The left-rail Treasury Gold chip (ResourcePanel `.hud-treasury`; the value
 * lives in `b.value`, the +delta preview in its own span). Scoped to the HUD
 * so an open market modal's TreasuryStrip cannot shadow it.
 */
function goldValueChip(page: Page) {
  return page
    .locator(".hud-treasury .resource-chip", { hasText: "Gold" })
    .locator("b.value");
}

/** Expect the left-rail Treasury Gold to settle at `value` (auto-retried). */
export async function expectGold(page: Page, value: number): Promise<void> {
  await expect(goldValueChip(page)).toHaveText(String(value));
}

/**
 * Start collecting console errors and uncaught page errors on a page.
 * Attach BEFORE the first goto; returns the live array. NO allow-list —
 * any entry that accumulates is a finding, and the gauntlet asserts the
 * array is empty at the end of the campaign.
 */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`[console.error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

// ---------------------------------------------------------------------------
// hidden-info additions (hidden-info.spec.ts) — additive only, nothing above moves
// ---------------------------------------------------------------------------

/**
 * WIRE TAP — records every socket.io frame the SERVER sends to a page, at the
 * transport level (below the socket.io client, so nothing the app layer does
 * can filter what we see). Installed via `page.addInitScript` BEFORE any app
 * script runs, it covers BOTH engine.io transports of socket.io-client v4:
 *   - WebSocket: subclass `window.WebSocket` and record every incoming
 *     `message` event's data;
 *   - HTTP long-polling (the transport every connection STARTS on before the
 *     ws upgrade): wrap XMLHttpRequest open/send and `fetch`, recording the
 *     response bodies of any request to a `/socket.io/` URL.
 * Every recorded incoming frame lands as a string in `window.__frames`.
 */
const WIRE_TAP_INIT = `
(() => {
  const frames = [];
  Object.defineProperty(window, "__frames", { value: frames });
  const push = (data) => {
    try {
      if (typeof data === "string") frames.push(data);
      else if (data instanceof ArrayBuffer) frames.push(new TextDecoder().decode(data));
    } catch (e) { /* never break the app under test */ }
  };
  // --- WebSocket transport ---
  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (ev) => push(ev.data));
    }
  };
  // --- XHR long-polling transport (engine.io's initial transport) ---
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__wiretapUrl = String(url);
    return nativeOpen.call(this, method, url, ...rest);
  };
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (typeof this.__wiretapUrl === "string" && this.__wiretapUrl.includes("/socket.io/")) {
      this.addEventListener("load", () => {
        try { push(this.responseText); } catch (e) { /* non-text responseType */ }
      });
    }
    return nativeSend.apply(this, args);
  };
  // --- fetch (engine.io polling fallback when XHR is unavailable) ---
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = "";
    try { url = typeof input === "string" ? input : String(input && input.url); } catch (e) { /* opaque */ }
    const p = nativeFetch.call(this, input, init);
    if (url.includes("/socket.io/")) {
      p.then((res) => { res.clone().text().then(push).catch(() => {}); }).catch(() => {});
    }
    return p;
  };
})();
`;

/** Install the wire tap. MUST run before the page's first `goto`. */
export async function installWireTap(page: Page): Promise<void> {
  await page.addInitScript(WIRE_TAP_INIT);
}

/** Read every incoming frame recorded so far on a tapped page. */
export async function readWireFrames(page: Page): Promise<string[]> {
  return (await page.evaluate("window.__frames || []")) as string[];
}

/** A parsed socket.io EVENT packet off the wire. */
export interface WireEvent {
  event: string;
  payload: unknown;
}

/**
 * Parse raw engine.io frames into socket.io events. Polling payloads join
 * packets with the \\u001e record separator; a socket.io EVENT packet is
 * engine.io MESSAGE ("4") + socket.io EVENT ("2") + an optional ack id, then
 * a JSON array [eventName, ...args]. Anything else (handshake, ping/pong,
 * CONNECT acks) is skipped.
 */
export function parseWireEvents(frames: string[]): WireEvent[] {
  const events: WireEvent[] = [];
  for (const frame of frames) {
    for (const packet of frame.split("\u001e")) {
      const idx = packet.indexOf("[");
      if (idx <= 0) continue;
      if (!/^42\d*$/.test(packet.slice(0, idx))) continue;
      try {
        const arr: unknown = JSON.parse(packet.slice(idx));
        if (Array.isArray(arr) && typeof arr[0] === "string") {
          events.push({ event: arr[0], payload: arr[1] });
        }
      } catch {
        /* not a JSON event payload — ignore */
      }
    }
  }
  return events;
}

/**
 * Loose wire-shape types — deliberately NOT imported from @imperium/shared.
 * These describe what is actually ON the wire; if the shared types and the
 * wire ever drift, the spec must keep testing the wire.
 */
export interface WireObjective {
  id: string;
  description: string;
  prestige: number;
}
export interface WireCard {
  id: string;
  name: string;
}
export interface WirePlayer {
  id: string;
  name: string;
  faction: string | null;
  objectives: WireObjective[];
  hand: WireCard[];
  tacticHand?: string[];
}
export interface WireGameState {
  players: WirePlayer[];
  rngSeed?: number;
  rngCursor?: number;
  tacticDiscard?: string[];
  tacticRemoved?: string[];
  log?: Array<{ type?: string; data?: Record<string, unknown> }>;
}

/** Event names whose payload carries a full projected game state. */
const WIRE_STATE_EVENTS = new Set([
  "game_started",
  "state_update",
  "state_snapshot",
]);

/** Every projected game state a tapped page has received, in wire order. */
export function wireGameStates(frames: string[]): WireGameState[] {
  const out: WireGameState[] = [];
  for (const { event, payload } of parseWireEvents(frames)) {
    if (!WIRE_STATE_EVENTS.has(event)) continue;
    const state = (payload as { state?: unknown } | undefined)?.state;
    if (state !== null && typeof state === "object") {
      out.push(state as WireGameState);
    }
  }
  return out;
}

/** Find a seat in a wire state by player display name (e.g. "Alice"). */
export function wirePlayerByName(
  state: WireGameState,
  name: string,
): WirePlayer {
  const player = state.players.find((p) => p.name === name);
  if (!player) throw new Error(`no player named ${name} in wire state`);
  return player;
}

/**
 * Tactic display-name -> engine card id, transcribed VERBATIM from
 * client/src/game/cards/tacticCardData.ts (which itself mirrors the ratified
 * engine deck, server/src/engine/tactics/cards.ts). Used to map card names
 * read from a player's DOM back to the ids that ride the wire — the wire
 * carries ONLY ids; names are client-side data. (Not imported from the client
 * module because its vite `?raw` asset imports don't resolve under the
 * playwright transpiler.)
 */
export const TACTIC_NAME_TO_ID: Record<string, string> = {
  "Forced March": "forced-march",
  "Veterans of the Border": "veterans-of-the-border",
  "The Pilot of the Narrows": "pilot-of-the-narrows",
  "Ladders and Fascines": "ladders-and-fascines",
  "A Good Season at the Counting-House": "the-counting-house",
  "Grain Barges of the Danube": "grain-barges-of-the-danube",
  "Ears in the Bazaar": "ears-in-the-bazaar",
  "Locked Shields": "locked-shields",
  "Feigned Retreat": "feigned-retreat",
  "Night Sortie": "night-sortie",
  "The Bribed Gatekeeper": "bribed-gatekeeper",
  "The Chain Across the Horn": "chain-across-the-horn",
  "Condottieri Contract": "condottieri-contract",
  "Papal Indulgence": "papal-indulgence",
  "The Intercepted Letter": "the-intercepted-letter",
  "The Hexamilion Manned": "the-hexamilion-manned",
  "Greek Fire": "greek-fire",
  "Treason at the Gate": "treason-at-the-gate",
  "The Pay Chest Taken": "the-pay-chest-taken",
  "Holy War Proclaimed": "holy-war-proclaimed",
  "Sails from the West": "sails-from-the-west",
  "A Death in the Palace": "a-death-in-the-palace",
  "The White Knight's Stroke": "the-white-knights-stroke",
  "Master Founders Hired": "master-founders-hired",
};

/**
 * createTwoPlayerGame with the wire tap installed on BOTH pages BEFORE any
 * navigation (addInitScript must precede the first goto — hence the `prepare`
 * hook rather than bolting the tap onto pages after boot). Identical boot
 * otherwise: canon board fixture, playbook seats Alice=BYZANTIUM(host) vs
 * Bob=OTTOMAN, both pages left at Round I, Income.
 */
export async function createTwoPlayerGameWireTapped(
  browser: Browser,
  opts: {
    names?: [string, string];
    factions?: [FactionKey, FactionKey];
  } = {},
): Promise<TwoPlayerGame> {
  return createTwoPlayerGame(browser, { ...opts, prepare: installWireTap });
}

// ---------------------------------------------------------------------------
// reconnect additions (reconnect.spec.ts) — additive only, nothing above moves
// ---------------------------------------------------------------------------

/**
 * SOCKET TRACKER — keeps a live reference to every WebSocket the page opens
 * (in `window.__liveSockets`) so a test can sever them on demand. Needed for
 * the network-drop simulation: Chromium's offline emulation
 * (`context.setOffline(true)`) blocks NEW requests but does NOT tear down an
 * ALREADY-ESTABLISHED WebSocket, and socket.io's own ping/pong would take
 * ~45s (pingInterval+pingTimeout) to notice — far too slow for a spec. A real
 * network loss errors the TCP stream promptly on both ends; closing the
 * browser-side socket while offline reproduces the client half of that
 * faithfully (transport close -> socket.io "disconnect" -> auto-reconnect,
 * which then FAILS against the offline network until it is restored).
 *
 * Composes with the wire tap: whichever init script runs last subclasses the
 * other's WebSocket subclass, so both records are kept.
 */
const SOCKET_TRACKER_INIT = `
(() => {
  const sockets = [];
  Object.defineProperty(window, "__liveSockets", { value: sockets });
  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(...args) {
      super(...args);
      sockets.push(this);
    }
  };
})();
`;

/**
 * Install the socket tracker. addInitScript applies from the page's NEXT
 * navigation — call before the first goto, or before a reload whose
 * post-reload page is the one you intend to sever.
 */
export async function installSocketTracker(page: Page): Promise<void> {
  await page.addInitScript(SOCKET_TRACKER_INIT);
}

/**
 * Close every open/connecting WebSocket the tracker has seen; returns how
 * many were severed. (0 is fine when the socket.io connection is still on
 * its initial long-polling transport — offline mode alone kills polling.)
 */
export async function severLiveSockets(page: Page): Promise<number> {
  const severed = await page.evaluate(`(() => {
    const sockets = window.__liveSockets || [];
    let n = 0;
    for (const ws of sockets) {
      if (ws.readyState === 0 || ws.readyState === 1) {
        try { ws.close(); n += 1; } catch (e) { /* already dying */ }
      }
    }
    return n;
  })()`);
  return severed as number;
}

/** A lobby_update roster row as it rides the wire (shared LobbyPlayer). */
export interface WireLobbyPlayer {
  id: string;
  name: string;
  faction: string | null;
  isHost: boolean;
  connected: boolean;
}
export interface WireLobbyUpdate {
  roomCode: string;
  players: WireLobbyPlayer[];
  startedByHost: boolean;
}

/**
 * Every lobby_update a tapped page has received, in wire order. The server
 * broadcasts one on every join/pick AND on every disconnect/rejoin (the seat's
 * `connected` flag flips), so this is how a spec proves a rival's page was
 * TOLD about a connection drop even where the in-game HUD does not render it.
 */
export function wireLobbyUpdates(frames: string[]): WireLobbyUpdate[] {
  return parseWireEvents(frames)
    .filter((e) => e.event === "lobby_update")
    .map((e) => e.payload as WireLobbyUpdate);
}

/**
 * Open the Chronicle drawer, read every rendered log line (newest first, as
 * the drawer shows them), and close the drawer again. The projection has
 * already filtered the log per-seat, so for one seat this must be IDENTICAL
 * before and after any disconnect/rejoin.
 */
export async function readChronicleLines(page: Page): Promise<string[]> {
  const tab = page.locator(".chr-tab");
  await tab.click();
  await page.locator(".chr-body").waitFor();
  const lines = await page.locator(".chr-scroll li").allTextContents();
  await tab.click();
  await page.locator(".chr-body").waitFor({ state: "hidden" });
  return lines.map((l) => l.trim());
}

/**
 * Every state_snapshot a tapped page has received, in wire order. A rejoin's
 * restored view MUST arrive on this event (server rejoin path) — counting
 * these lets a spec prove the snapshot really rode the wire, rather than the
 * page merely re-rendering state it already held in memory.
 */
export function wireStateSnapshots(frames: string[]): WireGameState[] {
  const out: WireGameState[] = [];
  for (const { event, payload } of parseWireEvents(frames)) {
    if (event !== "state_snapshot") continue;
    const state = (payload as { state?: unknown } | undefined)?.state;
    if (state !== null && typeof state === "object") {
      out.push(state as WireGameState);
    }
  }
  return out;
}

/** Every turn_timer payload a tapped page has received, in wire order. */
export function wireTurnTimers(
  frames: string[],
): Array<{ activePlayerId: string | null; deadline: number; turnSeconds: number }> {
  return parseWireEvents(frames)
    .filter((e) => e.event === "turn_timer")
    .map(
      (e) =>
        e.payload as {
          activePlayerId: string | null;
          deadline: number;
          turnSeconds: number;
        },
    );
}
