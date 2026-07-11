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
 *   - Rejoin is TOKEN-based: the `game_created` ack carries a crypto-random
 *     `sessionToken` which the client persists in sessionStorage (key
 *     "imperium.session", client/src/session.ts). On every socket connect the
 *     client auto-emits `rejoin_game {roomCode, sessionToken}` from the stored
 *     session (App.tsx attemptRejoin), so a page reload in the SAME tab
 *     reclaims the same seat — including after game start, where the server
 *     replays `game_started` + `state_update` to route the client back to the
 *     board. Fonts are self-hosted (client/public/fonts), so no external
 *     requests need blocking.
 */
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

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
 * (e) REJOIN (token-based). The `game_created` ack carries a per-player
 * crypto-random sessionToken; the client stores {roomCode, playerId,
 * sessionToken} in sessionStorage (key "imperium.session"). A `page.reload()`
 * in the SAME tab keeps sessionStorage, so on the fresh page's first socket
 * connect the client auto-emits `rejoin_game {roomCode, sessionToken}`
 * (App.tsx attemptRejoin) and the server reattaches the SAME seat — same
 * playerId, same faction, no ghost duplicate. While Bob's tab is reloading,
 * his seat shows "(disconnected)" on the host's roster (LobbyPlayer.connected
 * is now on the wire); after the rejoin it flips back.
 *
 * Note: deliberately reload rather than close-context-and-rejoin-by-name —
 * sessionStorage is per-tab, and same-name join_game is now a clean
 * "name taken" rejection, not a reclaim.
 */
test("(e) rejoin: reloading a player's tab auto-rejoins the same seat via the stored session token", async ({
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

    // Pre-drop sanity: the host sees Bob seated with his faction.
    await expect(
      page.locator(".imp-panel .imp-row", { hasText: "Bob" }),
    ).toContainText("OTTOMAN");

    // Reload Bob's tab: socket drops, sessionStorage survives, the client
    // auto-rejoins on connect and (from the fresh "home" screen) resumes
    // straight into the lobby on the first lobby_update.
    await p2.page.reload();

    // Bob lands back in the SAME lobby...
    await expect(
      p2.page.getByRole("heading", { name: "War Council" }),
    ).toBeVisible();
    expect(await readRoomCode(p2.page)).toBe(code);

    // ...with the SAME seat: exactly one Bob row, faction retained, seat
    // marked connected again — on BOTH clients, with no duplicate ghost.
    for (const p of [page, p2.page]) {
      const roster = p.locator(".imp-panel");
      await expect(roster.getByText("Bob", { exact: true })).toHaveCount(1);
      await expect(
        roster.locator(".imp-row", { hasText: "Bob" }),
      ).toContainText("OTTOMAN");
      await expect(roster.getByText("(disconnected)")).toHaveCount(0);
      await expect(roster.locator(".imp-row")).toHaveCount(2);
    }
  } finally {
    await p2.context.close();
  }
});

/**
 * (e2) REJOIN AFTER START. `rejoin_game` works post-start too: the server
 * reattaches the seat and replays `game_started` + a `state_update` snapshot
 * to the rejoining socket, so a reloaded tab routes straight back to the
 * game board.
 */
test("(e2) rejoin after start: reloading a player's tab mid-game resumes on the game board", async ({
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

    await page.getByRole("button", { name: "Start Game" }).click();
    for (const p of [page, p2.page]) {
      await expect(
        p.getByRole("heading", { name: /Theatre of War · Turn 1/ }),
      ).toBeVisible();
    }

    // Reload Bob mid-game: auto-rejoin reattaches the seat, and the replayed
    // game_started/state_update land him back on the board (not the lobby).
    await p2.page.reload();
    await expect(
      p2.page.getByRole("heading", { name: /Theatre of War · Turn 1/ }),
    ).toBeVisible();
    await expect(
      p2.page.getByRole("heading", { name: "War Council" }),
    ).toBeHidden();
  } finally {
    await p2.context.close();
  }
});
