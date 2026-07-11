/**
 * E2E tests for the IMPERIUM lobby flow, driven through the real client UI
 * (client/src/screens/*) against the real server (server/src/index.ts).
 *
 * UI flow under test (client/src/App.tsx, lore copy per lore/ui-text.md):
 *   home ("Convene a Game" / "Answer a Summons")
 *     -> createJoin ("Convene a Game" / "Take Your Seat")
 *     -> factionPick ("Under which banner will you ride?")
 *     -> lobby ("The Gathering Hall", room code in .imp-code)
 *     -> game (the .gb-shell campaign board) on `game_started`.
 * All flow driving lives in ./helpers/game.ts — specs assert, helpers drive.
 *
 * Notes on the contract that shapes these tests:
 *   - The server acks BOTH create_game and join_game with a `game_created`
 *     event, which the client handles by navigating to the faction screen.
 *   - The room code (6 chars of A-Z0-9) is only rendered on the Gathering
 *     Hall screen, which is gated on having picked a faction.
 *   - Faction exclusivity surfaces as a disabled faction button whose
 *     accessible name ends "Claimed by another house." (FactionPick.tsx),
 *     driven by lobby_update.
 *   - Rejoin is TOKEN-based: the `game_created` ack carries a crypto-random
 *     `sessionToken` persisted in sessionStorage (key "imperium.session");
 *     on every socket connect the client auto-emits `rejoin_game` from the
 *     stored session (App.tsx attemptRejoin), so a reload in the SAME tab
 *     reclaims the same seat — including after game start, where the server
 *     replays `game_started` + a state snapshot to route the client back to
 *     the board.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import {
  createGameToLobby,
  joinGameToLobby,
  readRoomCode,
  mountCanonBoard,
} from "./helpers/game.js";

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

/** Open a second, isolated browser context (a second "player's browser"). */
async function newPlayer(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await mountCanonBoard(page);
  return { page, close: () => context.close() };
}

test("(a) host creates a game and sees a 6-char A-Z0-9 room code", async ({
  page,
}) => {
  await mountCanonBoard(page);
  await createGameToLobby(page, "Alice", "BYZANTIUM");
  const code = await readRoomCode(page);
  expect(code).toMatch(ROOM_CODE_RE);
});

test("(b) second player joins by code; both contexts see both names in the roster", async ({
  page,
  browser,
}) => {
  await mountCanonBoard(page);
  await createGameToLobby(page, "Alice", "BYZANTIUM");
  const code = await readRoomCode(page);

  const p2 = await newPlayer(browser);
  try {
    await joinGameToLobby(p2.page, "Bob", code, "OTTOMAN");
    for (const p of [page, p2.page]) {
      // Roster rows render "<name>[ · Host of the Hall]" (Lobby.tsx).
      await expect(p.getByText("Alice · Host of the Hall")).toBeVisible();
      await expect(p.getByText("Bob", { exact: true })).toBeVisible();
    }
  } finally {
    await p2.close();
  }
});

test("(c) faction exclusivity: second player cannot take BYZANTIUM once claimed", async ({
  page,
  browser,
}) => {
  await mountCanonBoard(page);
  await createGameToLobby(page, "Alice", "BYZANTIUM");
  const code = await readRoomCode(page);

  const p2 = await newPlayer(browser);
  try {
    // Drive Bob only to the faction screen so the claimed seat is inspectable.
    await p2.page.goto("/");
    await p2.page.getByRole("button", { name: "Answer a Summons" }).click();
    await p2.page.getByLabel("Your Name").fill("Bob");
    await p2.page.getByLabel("Summons code, six characters").fill(code);
    await p2.page.getByRole("button", { name: "Take Your Seat" }).click();

    // The claimed throne is a disabled button announcing the claim
    // (FactionPick.tsx seat states), driven by lobby_update.
    const byzantium = p2.page.getByRole("button", { name: /^Byzantium/ });
    await expect(byzantium).toHaveAccessibleName(/Claimed by another house/);
    await expect(byzantium).toBeDisabled();

    // Bob takes the Ottomans instead; the roster shows one seat per faction.
    await p2.page.getByRole("button", { name: /^The Ottomans/ }).click();
    await p2.page.getByRole("button", { name: "Onward" }).click();
    const roster = p2.page.locator(".imp-panel");
    await expect(
      roster.locator(".imp-row", { hasText: "Alice · Host of the Hall" }),
    ).toContainText("Byzantium");
    await expect(roster.locator(".imp-row", { hasText: "Bob" })).toContainText(
      "The Ottomans",
    );
    await expect(roster.getByText("Byzantium", { exact: true })).toHaveCount(1);
  } finally {
    await p2.close();
  }
});

test("(d) host starts the game and both clients leave the lobby for the game board", async ({
  page,
  browser,
}) => {
  await mountCanonBoard(page);
  await createGameToLobby(page, "Alice", "BYZANTIUM");
  const code = await readRoomCode(page);

  const p2 = await newPlayer(browser);
  try {
    await joinGameToLobby(p2.page, "Bob", code, "OTTOMAN");

    // Both players seated -> the host's start button becomes enabled.
    const start = page.getByRole("button", { name: "Open the Campaign" });
    await expect(start).toBeEnabled();
    await start.click();

    // `game_started` flips both clients to the campaign board.
    for (const p of [page, p2.page]) {
      await expect(
        p.getByRole("heading", { name: "The Campaign Board" }),
      ).toBeVisible();
      await expect(
        p.getByRole("heading", { name: "The Gathering Hall" }),
      ).toBeHidden();
    }
  } finally {
    await p2.close();
  }
});

/**
 * (e) REJOIN (token-based). A `page.reload()` in the SAME tab keeps
 * sessionStorage, so on the fresh page's first socket connect the client
 * auto-emits `rejoin_game {roomCode, sessionToken}` and the server
 * reattaches the SAME seat — same playerId, same faction, no ghost seat.
 */
test("(e) rejoin: reloading a player's tab auto-rejoins the same seat via the stored session token", async ({
  page,
  browser,
}) => {
  await mountCanonBoard(page);
  await createGameToLobby(page, "Alice", "BYZANTIUM");
  const code = await readRoomCode(page);

  const p2 = await newPlayer(browser);
  try {
    await joinGameToLobby(p2.page, "Bob", code, "OTTOMAN");

    // Pre-drop sanity: the host sees Bob seated with his faction.
    await expect(
      page.locator(".imp-panel .imp-row", { hasText: "Bob" }),
    ).toContainText("The Ottomans");

    // Reload Bob's tab: socket drops, sessionStorage survives, the client
    // auto-rejoins on connect and resumes straight into the lobby.
    await p2.page.reload();
    await expect(
      p2.page.getByRole("heading", { name: "The Gathering Hall" }),
    ).toBeVisible();
    expect(await readRoomCode(p2.page)).toBe(code);

    // Same seat on BOTH clients: one Bob row, faction retained, connected.
    for (const p of [page, p2.page]) {
      const roster = p.locator(".imp-panel");
      await expect(roster.getByText("Bob", { exact: true })).toHaveCount(1);
      await expect(roster.locator(".imp-row", { hasText: "Bob" })).toContainText(
        "The Ottomans",
      );
      await expect(roster.getByText(/connection is lost/)).toHaveCount(0);
      await expect(roster.locator(".imp-row")).toHaveCount(2);
    }
  } finally {
    await p2.close();
  }
});

/**
 * (e2) REJOIN AFTER START: the server reattaches the seat and replays
 * `game_started` + a state snapshot, so a reloaded tab routes straight back
 * to the campaign board.
 */
test("(e2) rejoin after start: reloading a player's tab mid-game resumes on the game board", async ({
  page,
  browser,
}) => {
  await mountCanonBoard(page);
  await createGameToLobby(page, "Alice", "BYZANTIUM");
  const code = await readRoomCode(page);

  const p2 = await newPlayer(browser);
  try {
    await joinGameToLobby(p2.page, "Bob", code, "OTTOMAN");
    await page.getByRole("button", { name: "Open the Campaign" }).click();
    for (const p of [page, p2.page]) {
      await expect(p.locator(".gb-shell")).toBeVisible();
    }

    // Reload Bob mid-game: auto-rejoin reattaches the seat, and the replayed
    // game_started/state snapshot land him back on the board (not the lobby).
    await p2.page.reload();
    await expect(p2.page.locator(".gb-shell")).toBeVisible();
    await expect(
      p2.page.getByRole("heading", { name: "The Gathering Hall" }),
    ).toBeHidden();
  } finally {
    await p2.close();
  }
});
