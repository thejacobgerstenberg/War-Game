/**
 * E2E tests for the IMPERIUM lobby flow, driven through the real client UI
 * (client/src/screens/*) against the real server (server/src/index.ts).
 *
 * UI flow under test (client/src/App.tsx):
 *   home -> createJoin -> factionPick ("Choose Your Power")
 *        -> lobby ("War Council", room code in .imp-code)
 *        -> game ("Theatre of War · Turn N") on `game_started`.
 *
 * Notes on the scaffold's contract that shape these tests:
 *   - The server acks BOTH create_game and join_game with a `game_created`
 *     event, which the client handles by navigating to the faction screen.
 *   - The room code is only rendered on the Lobby screen, and "To the Lobby"
 *     is gated on having picked a faction — so "room code visible" requires
 *     create -> pick faction -> continue.
 *   - Faction exclusivity surfaces in the UI as a disabled faction button
 *     labelled "Taken by <name>" (FactionPick.tsx), driven by lobby_update.
 */
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

/**
 * client/src/theme.css `@import`s Google Fonts. In sandboxed/offline CI that
 * request hangs until a network timeout (~13s) before the page `load` event
 * fires, adding a flat delay to every fresh browser context. Abort external
 * font requests at the context level — the UI under test doesn't need them.
 */
const EXTERNAL_FONTS_RE = /fonts\.(googleapis|gstatic)\.com/;

async function blockExternalFonts(context: BrowserContext): Promise<void> {
  await context.route(EXTERNAL_FONTS_RE, (route) => route.abort());
}

const test = base.extend({
  context: async ({ context }, use) => {
    await blockExternalFonts(context);
    await use(context);
  },
});

/** Drive home -> "Create Game" -> name form; lands on the faction screen. */
async function createGame(page: Page, playerName: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create Game" }).click();
  await page.getByLabel("Your name").fill(playerName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose Your Power" }),
  ).toBeVisible();
}

/** Drive home -> "Join Game" -> name+code form; lands on the faction screen. */
async function joinGame(
  page: Page,
  playerName: string,
  roomCode: string,
): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Join Game" }).click();
  await page.getByLabel("Your name").fill(playerName);
  await page.getByLabel("Room code").fill(roomCode);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose Your Power" }),
  ).toBeVisible();
}

/** Pick a faction on the "Choose Your Power" screen. */
async function pickFaction(page: Page, faction: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(faction) }).click();
}

/** Continue from the faction screen into the lobby ("War Council"). */
async function continueToLobby(page: Page): Promise<void> {
  await page.getByRole("button", { name: "To the Lobby" }).click();
  await expect(
    page.getByRole("heading", { name: "War Council" }),
  ).toBeVisible();
}

/** Read the room code shown on the Lobby screen. */
async function readRoomCode(page: Page): Promise<string> {
  const codeEl = page.locator(".imp-code");
  await expect(codeEl).toHaveText(ROOM_CODE_RE);
  return (await codeEl.innerText()).trim();
}

/** Open a second, isolated browser context (a second "player's browser"). */
async function newPlayer(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await blockExternalFonts(context);
  const page = await context.newPage();
  return { context, page };
}

test("(a) host creates a game and sees a 6-char A-Z0-9 room code", async ({
  page,
}) => {
  await createGame(page, "Alice");
  // The room code is only rendered on the Lobby screen, which is gated on
  // having picked a faction.
  await pickFaction(page, "BYZANTIUM");
  await continueToLobby(page);

  const code = await readRoomCode(page);
  expect(code).toMatch(ROOM_CODE_RE);
});

test("(b) second player joins by code; both contexts see both names in the roster", async ({
  page,
  browser,
}) => {
  await createGame(page, "Alice");
  await pickFaction(page, "BYZANTIUM");
  await continueToLobby(page);
  const code = await readRoomCode(page);

  const p2 = await newPlayer(browser);
  try {
    await joinGame(p2.page, "Bob", code);
    await pickFaction(p2.page, "OTTOMAN");
    await continueToLobby(p2.page);

    for (const p of [page, p2.page]) {
      // Roster rows render as "<name>[ · host]" (Lobby.tsx).
      await expect(p.getByText("Alice · host")).toBeVisible();
      await expect(p.getByText("Bob", { exact: true })).toBeVisible();
    }
  } finally {
    await p2.context.close();
  }
});

test("(c) faction exclusivity: second player cannot take BYZANTIUM once claimed", async ({
  page,
  browser,
}) => {
  await createGame(page, "Alice");
  await pickFaction(page, "BYZANTIUM");
  await continueToLobby(page);
  const code = await readRoomCode(page);

  const p2 = await newPlayer(browser);
  try {
    await joinGame(p2.page, "Bob", code);

    // The rejection surfaces in the UI as a disabled BYZANTIUM button
    // labelled "Taken by Alice" (FactionPick.tsx), driven by lobby_update —
    // the client blocks the pick before it can even reach the server.
    const byzantium = p2.page.getByRole("button", { name: /BYZANTIUM/ });
    await expect(byzantium).toContainText("Taken by Alice");
    await expect(byzantium).toBeDisabled();

    // And the lobby roster shows only Alice holding BYZANTIUM.
    await pickFaction(p2.page, "OTTOMAN");
    await continueToLobby(p2.page);
    const roster = p2.page.locator(".imp-panel");
    await expect(
      roster.locator(".imp-row", { hasText: "Alice · host" }),
    ).toContainText("BYZANTIUM");
    await expect(
      roster.locator(".imp-row", { hasText: "Bob" }),
    ).toContainText("OTTOMAN");
    await expect(roster.getByText("BYZANTIUM")).toHaveCount(1);
  } finally {
    await p2.context.close();
  }
});

test("(d) host starts the game and both clients leave the lobby for the game board", async ({
  page,
  browser,
}) => {
  await createGame(page, "Alice");
  await pickFaction(page, "BYZANTIUM");
  await continueToLobby(page);
  const code = await readRoomCode(page);

  const p2 = await newPlayer(browser);
  try {
    await joinGame(p2.page, "Bob", code);
    await pickFaction(p2.page, "OTTOMAN");
    await continueToLobby(p2.page);

    // Both players seated -> host's Start Game becomes enabled.
    const start = page.getByRole("button", { name: "Start Game" });
    await expect(start).toBeEnabled();
    await start.click();

    // `game_started` flips both clients to the GameBoard screen.
    for (const p of [page, p2.page]) {
      await expect(
        p.getByRole("heading", { name: /Theatre of War · Turn 1/ }),
      ).toBeVisible();
      await expect(p.getByRole("heading", { name: "Powers" })).toBeVisible();
      await expect(
        p.getByRole("heading", { name: "War Council" }),
      ).toBeHidden();
    }
  } finally {
    await p2.context.close();
  }
});

/**
 * (e) REJOIN — intentionally test.fixme: the scaffold has NO wired rejoin path.
 *
 * Discovered behavior (server/src/index.ts + server/src/lobby/lobbyManager.ts
 * at branch head ac73c8a):
 *   - `LobbyManager.reconnect(playerId)` exists (lobbyManager.ts:261) and is
 *     unit-tested, but NO socket event ever invokes it — rejoin is not
 *     reachable over the wire.
 *   - There are no session tokens; the client holds `playerId` only in React
 *     state, so a closed tab/context loses its identity permanently.
 *   - On disconnect the server merely flips the seat's server-side
 *     `connected` flag (index.ts `socket.on("disconnect")` ->
 *     `lobby.markDisconnected`); the seat is held forever, and the wire
 *     `LobbyPlayer` row has no `connected` field so other clients can't even
 *     see the drop.
 *   - Re-joining via the UI join flow with the SAME name does NOT reclaim the
 *     seat: `joinGame()` (lobbyManager.ts:159) unconditionally pushes a brand
 *     new player with a fresh UUID, so the roster ends up with TWO "Bob"
 *     rows — the ghost disconnected seat plus the new one, without the
 *     original faction. Empirically confirmed against the running stack: the
 *     host roster after a same-name re-join reads
 *     ["Alice · host BYZANTIUM", "Bob OTTOMAN", "Bob choosing…"] with no
 *     error surfaced to the re-joiner.
 *   - After the game has started, join_game is rejected outright with
 *     "That game has already started." — so mid-game rejoin is impossible.
 *
 * What the scaffold needs before this test can be enabled: a session token
 * (or name-based reclaim) in JoinGamePayload, a socket event wired to
 *  `LobbyManager.reconnect`, and join-after-start allowed for reclaims.
 *
 * The body below encodes the behavior a sensible rejoin should have.
 */
test.fixme("(e) rejoin: a disconnected player can reclaim their seat with the same name and code", async ({
  page,
  browser,
}) => {
  await createGame(page, "Alice");
  await pickFaction(page, "BYZANTIUM");
  await continueToLobby(page);
  const code = await readRoomCode(page);

  // Bob joins, picks a faction, then drops (context close = socket disconnect).
  const p2 = await newPlayer(browser);
  await joinGame(p2.page, "Bob", code);
  await pickFaction(p2.page, "OTTOMAN");
  await continueToLobby(p2.page);
  await p2.context.close();

  // Bob returns in a fresh context and rejoins with the same name + code.
  const p3 = await newPlayer(browser);
  try {
    await joinGame(p3.page, "Bob", code);
    await pickFaction(p3.page, "OTTOMAN"); // should still be his
    await continueToLobby(p3.page);

    // Expected on a real rejoin: exactly one Bob row, faction retained,
    // on both clients — no ghost duplicate seat.
    for (const p of [page, p3.page]) {
      const roster = p.locator(".imp-panel");
      await expect(roster.getByText("Bob", { exact: true })).toHaveCount(1);
      await expect(
        roster.locator(".imp-row", { hasText: "Bob" }),
      ).toContainText("OTTOMAN");
    }
  } finally {
    await p3.context.close();
  }
});
