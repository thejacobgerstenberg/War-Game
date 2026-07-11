/**
 * RECONNECT — disconnect + rejoin restores the FULL game view, two ways.
 *
 * A seeded 2-player game (playbook seats: Alice=Byzantium host, Bob=The
 * Ottomans) is played through Round I into Round II so the state is rich
 * before anything drops: a recruit on each side, Bob's march on Selymbria and
 * its resolved battle (province flipped, army relocated, prestige moved), a
 * chronicle full of entries, tactic cards in both hands.
 *
 * Then player A (Alice, the host) is disconnected two ways:
 *
 *   1. PAGE RELOAD — sessionStorage keeps {roomCode, playerId, sessionToken}
 *      (client/src/session.ts); on the fresh page's socket "connect" App.tsx
 *      emits rejoin_game, and the server replays game_started + a fog-of-war
 *      state_snapshot for HER seat. The spec snapshots the visible view
 *      BEFORE the reload (round/phase, treasury, her OWN sealed ambitions and
 *      tactic hand, board ownership/strength, the whole chronicle) and
 *      asserts the restored view matches EXACTLY.
 *
 *   2. NETWORK DROP — context.setOffline(true) + severing the live WebSocket
 *      (Chromium's offline emulation does not kill an established socket;
 *      see installSocketTracker in helpers/game.ts), wait, setOffline(false).
 *      socket.io auto-reconnects and App.tsx re-emits rejoin_game on the SAME
 *      page. Because the SPA keeps its last in-memory state through an
 *      outage, "the view matches" alone would be VACUOUS here (it would pass
 *      even if the rejoin sent nothing). So the spec makes the world move on
 *      while Alice is dark — Bob seals a recruit at Edirne — asserts her
 *      view is provably STALE during the outage, and then asserts the rejoin
 *      snapshot delivers the deed she missed (Edirne's new host + the new
 *      chronicle line), plus a literal state_snapshot on her wire tap.
 *
 * Both ways also assert Bob's view was UNDISTURBED, and that Bob's client was
 * TOLD about Alice's connection flip (lobby_update on his wire — the server
 * broadcasts the roster with connected:false/true on disconnect/rejoin).
 *
 * TURN TIMER: the e2e server runs TURN_SECONDS=off (playwright.config.ts), so
 * no turn_timer ever rides the wire and the TopBar hourglass must stay absent
 * — including after a rejoin (the server's rejoin path re-sends the CURRENT
 * deadline only when a timer is actually armed; server/src/index.ts and its
 * protocol tests cover the do-not-reset contract). This spec asserts the
 * wire carried NO turn_timer and the hourglass never appears, so a rejoin can
 * never conjure a bogus reset countdown out of nothing.
 *
 * Serial: one shared game; every test depends on the one before it.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  advancePhases,
  closeCombatModal,
  closeDialog,
  createTwoPlayerGameWireTapped,
  expectGold,
  expectPhase,
  expectRound,
  installSocketTracker,
  marchOrder,
  onward,
  readChronicleLines,
  readWireFrames,
  recruit,
  selectProvince,
  severLiveSockets,
  shoot,
  wireLobbyUpdates,
  wireStateSnapshots,
  wireTurnTimers,
  type TwoPlayerGame,
} from "./helpers/game.js";

/** ObjectivesPanel door + dialog (client/src/game/objectives/ObjectivesPanel.tsx). */
const AMBITIONS_DOOR = "Open The Sealed Ambitions";
const AMBITIONS_TITLE = "The Sealed Ambitions";

/** Connection notices, VERBATIM from client/src/game/uiText.ts CONNECTION. */
const CONNECTION_LOST = "The herald cannot reach the table — the connection is lost.";
const CONNECTION_RESTORED = "The messenger returns; the table is restored.";

/** Known treasuries at Round II Income under seed 424242 (playbook):
 *  Alice 5 +13 income -4 infantry = 14; Bob 6 +11 income -2 levy = 15. */
const ALICE_GOLD_R2 = 14;
const BOB_GOLD_R2 = 15;

/** Open the Sealed Ambitions panel and read MY objective descriptions. */
async function readOwnObjectives(page: Page): Promise<string[]> {
  await page.getByRole("button", { name: AMBITIONS_DOOR }).click();
  const dialog = page.getByRole("dialog", { name: AMBITIONS_TITLE });
  await expect(dialog).toBeVisible();
  const descs = await dialog.locator(".obj-list .obj-desc").allTextContents();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return descs.map((d) => d.trim());
}

/** Collapse layout linebreaks so innerText reads compare stably. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Select a province and read its inspector banner + host-strength lines. */
async function readProvince(
  page: Page,
  name: string,
): Promise<{ banner: string; hosts: string }> {
  await selectProvince(page, name);
  const right = page.locator(".gb-right");
  await expect(right.locator(".insp-hosts")).toBeVisible();
  const banner = flat(await right.locator(".insp-owner-name").first().innerText());
  const hosts = flat(await right.locator(".insp-hosts").innerText());
  return { banner, hosts };
}

/** Everything the reconnect assertions compare, read from ONE seat's UI. */
interface ViewSnapshot {
  round: string;
  phase: string;
  objectives: string[];
  tacticTray: string;
  selymbria: { banner: string; hosts: string };
  constantinople: { banner: string; hosts: string };
  chronicle: string[];
  powers: string;
}

/** Capture Alice's full visible game view (Round II Income quiet moment). */
async function captureView(page: Page): Promise<ViewSnapshot> {
  return {
    round: (await page.locator(".round-counter b").innerText()).trim(),
    phase: (
      await page.locator(".phase-track li.is-current .phase-name").innerText()
    ).trim(),
    objectives: await readOwnObjectives(page),
    tacticTray: flat(
      await page.locator(".card-tray", { hasText: "Stratagems in hand" }).innerText(),
    ),
    selymbria: await readProvince(page, "Selymbria"),
    constantinople: await readProvince(page, "Constantinople"),
    chronicle: await readChronicleLines(page),
    powers: flat(await page.locator(".hud-powers").innerText()),
  };
}

test.describe.serial("reconnect — the seat is held and the table restored", () => {
  let game: TwoPlayerGame;
  let alice: Page; // Byzantium, host — the seat that disconnects.
  let bob: Page; // The Ottomans — the seat that must stay undisturbed.
  let preView: ViewSnapshot; // Alice's view captured before the reload.
  let bobLobbyBaseline = 0; // lobby_updates on Bob's wire before the reload.

  test.beforeAll(async ({ browser }) => {
    // Wire-tapped boot: Bob's tap proves the server TOLD him about Alice's
    // connection flips; Alice's tap proves no turn_timer follows her rejoin.
    game = await createTwoPlayerGameWireTapped(browser);
    alice = game.host.page;
    bob = game.guest.page;
  });

  test.afterAll(async () => {
    await game?.close();
  });

  test("Round I is played out so the state is rich: recruits, a march, a resolved battle", async () => {
    test.setTimeout(120_000);

    // Income -> Muster (the Round I omen resolves; both seats draw a tactic).
    await onward(alice);
    await expectPhase(alice, "Muster");
    await expect(alice.getByText("Stratagems in hand — I of III")).toBeVisible();

    // Sealed deeds on BOTH seats: treasuries move, armies grow.
    await recruit(alice, "Constantinople", { INFANTRY: 1 }); // 18 -> 14 gold
    await recruit(bob, "Edirne (Adrianople)", { LEVY: 1 }); // 17 -> 15 gold
    await expectGold(alice, ALICE_GOLD_R2);
    await expectGold(bob, BOB_GOLD_R2);

    // Muster -> Campaign; Bob marches onto Alice's lone levy at Selymbria.
    await onward(alice);
    await expectPhase(bob, "Campaign");
    await marchOrder(bob, "Edirne (Adrianople)", "Selymbria");
    await expect(
      bob.getByRole("dialog", { name: "The Field at Selymbria" }),
    ).toBeVisible();

    // Alice clears her auto-opened battle modal so the host can Onward; Bob
    // keeps his open to watch the resolution.
    await closeDialog(alice);
    await advancePhases(alice, 3); // Council, Council(COMBAT), -> Twilight (battle resolves)
    await expect(
      bob
        .getByRole("dialog", { name: "The Field at Selymbria" })
        .getByRole("heading", { name: "The Day Is Yours" }),
    ).toBeVisible({ timeout: 20_000 });
    await closeCombatModal(bob);
    await expectPhase(alice, "Twilight");

    // Twilight -> cleanup -> Round II Income: the rich, quiet moment every
    // reconnect test below leans on.
    await onward(alice);
    for (const p of [alice, bob]) {
      await expectRound(p, "II");
      await expectPhase(p, "Income");
    }
    await expectGold(alice, ALICE_GOLD_R2);
    await expectGold(bob, BOB_GOLD_R2);
  });

  test("page reload: the stored session rejoins and restores the full view", async ({}, testInfo) => {
    test.setTimeout(120_000);

    // ---- BEFORE: capture everything Alice can see. -----------------------
    preView = await captureView(alice);
    expect(preView.round).toBe("II");
    expect(preView.phase).toBe("Income");
    expect(preView.objectives).toHaveLength(3); // her OWN sealed ambitions, in full
    expect(preView.tacticTray).toContain("Stratagems in hand — I of III");
    // The battle's outcome is on the board she must get back:
    expect(preView.selymbria.banner).toBe("Under the banner of The Ottomans");
    expect(preView.selymbria.hosts).toContain("The Ottomans — VI");
    expect(preView.constantinople.hosts).toContain("Byzantium — IV");
    expect(preView.chronicle.length).toBeGreaterThan(5); // a real round's worth
    await shoot(alice, "reconnect-01-pre-reload", testInfo);

    bobLobbyBaseline = wireLobbyUpdates(await readWireFrames(bob)).length;

    // Arm the socket tracker for the NETWORK-DROP test: addInitScript takes
    // effect on the next navigation, i.e. on the very reload under test.
    await installSocketTracker(alice);

    // ---- DISCONNECT #1: full page reload. --------------------------------
    await alice.reload();

    // The app rejoins by itself: sessionStorage creds -> rejoin_game on
    // "connect" -> game_started + state_snapshot -> straight to the board.
    await expect(alice.locator(".gb-shell")).toBeVisible({ timeout: 15_000 });

    // ---- AFTER: the restored view matches the captured one EXACTLY. ------
    const postView = await captureView(alice);
    expect(postView).toEqual(preView);
    await expectGold(alice, ALICE_GOLD_R2); // treasury restored
    await shoot(alice, "reconnect-02-post-reload", testInfo);

    // No countdown was conjured by the rejoin: TURN_SECONDS=off, so the wire
    // must carry no turn_timer at all and the hourglass must stay absent.
    expect(wireTurnTimers(await readWireFrames(alice))).toHaveLength(0);
    await expect(alice.locator(".turn-timer")).toHaveCount(0);

    // ---- Bob was undisturbed... ------------------------------------------
    await expectRound(bob, "II");
    await expectPhase(bob, "Income");
    await expectGold(bob, BOB_GOLD_R2);
    await expect(bob.getByRole("dialog")).toHaveCount(0);

    // ...and his client was TOLD about Alice's flip: the reload's clean
    // socket close broadcasts lobby_update{Alice.connected:false}, the rejoin
    // broadcasts {connected:true} — in that order on Bob's wire.
    const aliceFlips = async (): Promise<boolean[]> =>
      wireLobbyUpdates(await readWireFrames(bob))
        .slice(bobLobbyBaseline)
        .map((u) => u.players.find((p) => p.name === "Alice")?.connected)
        .filter((c): c is boolean => typeof c === "boolean");
    await expect.poll(aliceFlips, { timeout: 10_000 }).toContain(false);
    await expect
      .poll(async () => (await aliceFlips()).at(-1), { timeout: 10_000 })
      .toBe(true);
    // KNOWN GAP (documented, not a spec failure): the in-game HUD's "Powers
    // Assemble" panel renders an away marker off gameState.players[].connected
    // (ResourcePanel .is-away), but the server only maintains `connected` on
    // the LOBBY roster — the game-state flag is set true at creation and never
    // flipped, so mid-game the marker cannot appear. When that is wired up,
    // flip this assertion to expect the marker during the outage.
    await expect(bob.locator(".hud-powers .is-away")).toHaveCount(0);
  });

  test("network drop: offline -> reconnect -> the snapshot restores a world that moved on", async ({}, testInfo) => {
    test.setTimeout(120_000);

    // VACUITY GUARD: on a network drop (unlike a reload) the SPA keeps its
    // last in-memory gameState, so simply re-asserting the same view after
    // reconnect would pass even if rejoin_game sent NO snapshot at all. This
    // test therefore (a) advances into Muster so a rival deed can land while
    // Alice is dark, (b) has Bob seal a recruit DURING the outage, (c) proves
    // Alice's view is stale while offline, and (d) proves the rejoin snapshot
    // delivers the deed she missed — knowledge her page can only have gotten
    // from the state_snapshot (broadcasts to her dead socket are lost).
    await expectRound(alice, "II");
    await expectPhase(alice, "Income");
    await onward(alice); // Income -> Muster; Round II income credits.
    for (const p of [alice, bob]) await expectPhase(p, "Muster");
    await expectGold(alice, 26); // 14 + 12 income (playbook Round II)
    await expectGold(bob, 30); // 15 + 15 income

    const preChronicle = await readChronicleLines(alice);
    // Edirne emptied when Bob's host marched on Selymbria in Round I:
    await selectProvince(alice, "Edirne (Adrianople)");
    await expect(alice.locator(".gb-right")).toContainText("No host stands here.");
    const aliceSnapshotsBefore = wireStateSnapshots(
      await readWireFrames(alice),
    ).length;
    const bobLobbyBefore = wireLobbyUpdates(await readWireFrames(bob)).length;

    // ---- DISCONNECT #2: the network goes away under a live socket. -------
    await game.host.context.setOffline(true);
    // Chromium's offline emulation leaves an established WebSocket breathing;
    // sever it to make the drop observable NOW (see helper docs). The tracker
    // was armed before the reload, so the post-reload socket is tracked.
    const severed = await severLiveSockets(alice);
    expect(severed).toBeGreaterThan(0);

    // Alice's client notices: the herald notice mounts in the left rail while
    // socket.io's reconnect attempts fail against the dead network.
    await expect(alice.locator(".hud-connection")).toHaveText(CONNECTION_LOST, {
      timeout: 10_000,
    });
    await shoot(alice, "reconnect-03-offline", testInfo);

    // ---- The world moves on without her: Bob seals a deed. ---------------
    await recruit(bob, "Edirne (Adrianople)", { LEVY: 1 }); // 30 -> 28 gold
    await expectGold(bob, 28);
    await expect(bob.locator(".insp-hosts")).toContainText("The Ottomans — I");

    // Alice's page still shows the STALE world — Edirne empty, chronicle
    // unchanged. (This is what makes the post-reconnect assertions below
    // non-vacuous: her in-memory view demonstrably does NOT contain the deed.)
    await selectProvince(alice, "Edirne (Adrianople)");
    await expect(alice.locator(".gb-right")).toContainText("No host stands here.");
    expect(await readChronicleLines(alice)).toEqual(preChronicle);

    // Bob, meanwhile, is untouched — his board still answers.
    await expectRound(bob, "II");
    await expectPhase(bob, "Muster");
    const bobSelymbria = await readProvince(bob, "Selymbria");
    expect(bobSelymbria.hosts).toContain("The Ottomans — VI");

    // Let a couple of reconnect attempts fail before the network returns.
    await alice.waitForTimeout(2_500);
    await game.host.context.setOffline(false);

    // ---- RECONNECT: socket.io retries, App re-emits rejoin_game. ---------
    // The client announces the recovery and drops the herald notice...
    await expect(alice.getByText(CONNECTION_RESTORED)).toBeVisible({
      timeout: 20_000,
    });
    await expect(alice.locator(".hud-connection")).toHaveCount(0);

    // ...a literal state_snapshot rode her wire (a rejoin path that sent
    // nothing could never satisfy this)...
    await expect
      .poll(
        async () => wireStateSnapshots(await readWireFrames(alice)).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(aliceSnapshotsBefore);

    // ...and that snapshot re-renders the table WITH the deed she missed:
    await expectRound(alice, "II");
    await expectPhase(alice, "Muster");
    await expectGold(alice, 26);
    await selectProvince(alice, "Edirne (Adrianople)");
    await expect(alice.locator(".insp-hosts")).toContainText("The Ottomans — I");
    const postChronicle = await readChronicleLines(alice);
    expect(postChronicle.length).toBeGreaterThan(preChronicle.length);
    expect(postChronicle.join("\n")).toContain(
      "Bob recruits 1 unit(s) at Edirne (Adrianople)",
    );
    // The untouched parts of her view are restored intact alongside it:
    const postSelymbria = await readProvince(alice, "Selymbria");
    expect(postSelymbria).toEqual(preView.selymbria);
    expect(await readOwnObjectives(alice)).toEqual(preView.objectives);

    // Still no conjured countdown after the in-place rejoin (TURN_SECONDS=off;
    // the current-deadline-not-reset contract is the server's, covered by its
    // protocol tests — here the wire must simply stay silent).
    expect(wireTurnTimers(await readWireFrames(alice))).toHaveLength(0);
    await expect(alice.locator(".turn-timer")).toHaveCount(0);
    await shoot(alice, "reconnect-04-restored", testInfo);

    // Bob's wire got the rejoin roster (Alice connected:true). The DROP may
    // or may not reach him promptly — the close frame raced the offline
    // switch, and absent it the server only learns via its ~45s ping timeout
    // — so only the rejoin broadcast is asserted for this disconnect flavour.
    await expect
      .poll(
        async () => {
          const updates = wireLobbyUpdates(await readWireFrames(bob)).slice(
            bobLobbyBefore,
          );
          const last = updates.at(-1);
          return (
            updates.length > 0 &&
            last?.players.find((p) => p.name === "Alice")?.connected === true
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await expectRound(bob, "II");
    await expectPhase(bob, "Muster");
  });

  test("the restored seat can still act: a deed seals and the host advances", async () => {
    test.setTimeout(120_000);

    // The rejoined socket + the sessionStorage token must still carry a
    // budgeted RECRUIT and a host-gated ADVANCE_PHASE end to end. (Round II
    // Muster: the network-drop test above already advanced Income -> Muster.)
    for (const p of [alice, bob]) await expectPhase(p, "Muster");
    await expectGold(alice, 26);

    await recruit(alice, "Constantinople", { LEVY: 1 }); // 26 -> 24
    await expect(
      alice.locator(".toast--triumph", { hasText: "So it is written." }).first(),
    ).toBeVisible();
    await expectGold(alice, 24);
    await expect(alice.locator(".insp-hosts")).toContainText("Byzantium — V");

    // And the host-gated advance still answers her seal: Muster -> Campaign.
    await onward(alice);
    for (const p of [alice, bob]) await expectPhase(p, "Campaign");
  });
});
