/**
 * THE GAUNTLET — one full seeded 2-player campaign through the REAL UI.
 *
 * Follows scratchpad/e2e-playbook.md VERBATIM (seed 424242, PRESTIGE_TARGET
 * 12, TURN_SECONDS=off — all pinned in e2e/playwright.config.ts webServer
 * env): Alice=Byzantium (host) vs Bob=The Ottomans, three full rounds ending
 * in a REAL engine victory (Byzantium 20 v 10 at Round III's cleanup).
 *
 * Exercised through visible UI, with per-beat assertions:
 *   create/join/pick/start -> Round I Income
 *   RECRUIT   (muster tray steppers; host strength III->IV in the inspector;
 *              gold 18->14; a deed pip spent)
 *   MOVE+ATTACK (Bob's Edirne->Selymbria march seals, declares the battle,
 *              CombatModal auto-opens on BOTH seats)
 *   TACTIC    (gating only: attacker-declares-first prompt on Bob, defender
 *              prompt on Alice; per the playbook THE SEEDED ROUND-I BATTLE
 *              HAS NO PLAYABLE TACTIC — Forced March is a March-rider,
 *              Treason at the Gate is siege-only — so this spec asserts the
 *              withheld rendering from each side's hand panel and NO card is
 *              played here. The actual PLAY_TACTIC path — a card played
 *              through the CombatModal, sealed face-down for the rival, and
 *              resolved by the engine into the battle — is exercised
 *              end-to-end by tactic.spec.ts, which engineers a Round-II
 *              battle where The Hexamilion Manned IS playable.)
 *   COMBAT    (dice cascade + reckoning strip via "Review the Reckoning",
 *              "The Day Is Yours", +1 Prestige, Selymbria flips Ottoman)
 *   MERC      (Bob raises the purse to 14, the round-robin auto-opens for
 *              Alice, Alice passes, the company fields at Edirne)
 *   EVENT     (omen toast -> full card with real flavor text -> acknowledge)
 *   PHASES    (host-gated Onward each round, ConfirmModal inside windows)
 *   VICTORY   (end screens on both seats, the Final Reckoning table)
 *   CHRONICLE (era chapter, real province/faction names, omen glance rail)
 *
 * Console errors are collected on BOTH pages from before first paint with NO
 * allow-list; the final test asserts none accumulated.
 *
 * Serial: one shared game; every test depends on the one before it.
 */
import { test, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import {
  collectPageErrors,
  createGameToLobby,
  expectGold,
  expectPhase,
  expectRound,
  joinGameToLobby,
  marchOrder,
  mercBidFloor,
  mercPass,
  mountCanonBoard,
  onward,
  advancePhases,
  readDeedsRemaining,
  readRoomCode,
  readTheChronicle,
  recruit,
  sealConfirm,
  selectProvince,
  shoot,
  awaitEndScreen,
  closeDialog,
  closeCombatModal,
} from "./helpers/game.js";

test.describe.serial("the gauntlet — a full seeded campaign", () => {
  let hostContext: BrowserContext;
  let guestContext: BrowserContext;
  let alice: Page; // Byzantium, host — the only seat that may Onward.
  let bob: Page; // The Ottomans.
  let aliceErrors: string[];
  let bobErrors: string[];

  test.beforeAll(async ({ browser }) => {
    hostContext = await browser.newContext();
    guestContext = await browser.newContext();
    alice = await hostContext.newPage();
    bob = await guestContext.newPage();
    // Error collectors go on BEFORE the first goto — nothing is allow-listed.
    aliceErrors = collectPageErrors(alice);
    bobErrors = collectPageErrors(bob);
    await mountCanonBoard(alice);
    await mountCanonBoard(bob);
  });

  test.afterAll(async () => {
    await hostContext?.close();
    await guestContext?.close();
  });

  /** The triumph toast that confirms a sealed deed ("So it is written."). */
  const sealedToast = (page: Page) =>
    page.locator(".toast--triumph", { hasText: "So it is written." }).first();

  test("the table is set: create, join, pick banners, open the campaign", async (
    {},
    testInfo,
  ) => {
    await createGameToLobby(alice, "Alice", "BYZANTIUM");
    const roomCode = await readRoomCode(alice);
    await joinGameToLobby(bob, "Bob", roomCode, "OTTOMAN");

    // Both seats visible in the Gathering Hall before the campaign opens.
    await expect(alice.getByText("Alice · Host of the Hall")).toBeVisible();
    await expect(alice.getByText("Bob", { exact: true })).toBeVisible();
    await shoot(alice, "01-lobby", testInfo);

    await alice.getByRole("button", { name: "Open the Campaign" }).click();
    await expect(alice.locator(".gb-shell")).toBeVisible();
    await expect(bob.locator(".gb-shell")).toBeVisible();

    // Round I · Income on both seats; orders closed (disabled buttons carry
    // the in-voice reason as their title); four deeds banked.
    for (const p of [alice, bob]) {
      await expectRound(p, "I");
      await expectPhase(p, "Income");
      const muster = p.getByRole("button", { name: "Muster", exact: true });
      await expect(muster).toHaveAttribute("aria-disabled", "true");
      await expect(muster).toHaveAttribute("title", /The Reckoning begins/);
    }
    expect(await readDeedsRemaining(alice)).toBe(4);
    await expectGold(alice, 5);
    await expectGold(bob, 6);
    await shoot(alice, "02-income-r1", testInfo);
  });

  test("Round I · Muster: the omen is revealed and both hosts levy", async (
    {},
    testInfo,
  ) => {
    // Income -> Muster is a direct advance (no confirm); the omen toast only
    // holds five seconds, so click Onward raw and seize the toast at once.
    await alice.getByRole("button", { name: "Onward" }).click();
    const omenToast = alice.getByRole("button", { name: /Discovery of Alum/ });
    await omenToast.click();

    // EVENT: the full card carries the real rules line and flavor text.
    const omenCard = alice.getByRole("dialog", { name: "Discovery of Alum" });
    await expect(omenCard).toBeVisible();
    await expect(omenCard.locator(".card-flavor")).toContainText("Phocaea");
    await expect(omenCard.locator(".card-rules")).not.toBeEmpty();
    await shoot(alice, "03-omen-reveal-r1", testInfo);
    await closeDialog(alice); // acknowledge — "Draw the Curtain"

    for (const p of [alice, bob]) {
      await expectPhase(p, "Muster");
      // Each seat drew a stratagem with the omen (I of the III-card limit).
      await expect(p.getByText("Stratagems in hand — I of III")).toBeVisible();
    }
    // Income credited: Alice 5 -> 18 gold, Bob 6 -> 17.
    await expectGold(alice, 18);
    await expectGold(bob, 17);

    // RECRUIT (Alice, through the muster tray): Constantinople holds 2
    // Infantry + the Varangian Guard (host strength III) before the levy.
    await alice.getByRole("button", { name: "Muster", exact: true }).click();
    await selectProvince(alice, "Constantinople");
    await expect(alice.locator(".insp-hosts")).toContainText("Byzantium — III");
    await expect(alice.getByText("Varangian Guard")).toBeVisible();
    await alice
      .getByRole("button", { name: "More Infantry", exact: true })
      .click();
    await shoot(alice, "04-muster-tray", testInfo);
    await sealConfirm(alice);
    await expect(sealedToast(alice)).toBeVisible();

    // The unit appears in the inspector, the pip is spent, the gold is paid.
    await expect(alice.locator(".insp-hosts")).toContainText("Byzantium — IV");
    expect(await readDeedsRemaining(alice)).toBe(3);
    await expectGold(alice, 14);

    // RECRUIT (Bob): one Levy at Edirne — the host that will march.
    await recruit(bob, "Edirne (Adrianople)", { LEVY: 1 });
    await expect(sealedToast(bob)).toBeVisible();
    await expect(bob.locator(".insp-hosts")).toContainText("The Ottomans — VI");
    expect(await readDeedsRemaining(bob)).toBe(3);
    await expectGold(bob, 15);
  });

  test("Round I · Campaign: the march on Selymbria declares a battle", async (
    {},
    testInfo,
  ) => {
    await onward(alice); // Muster -> Campaign (ConfirmModal interposes)
    for (const p of [alice, bob]) await expectPhase(p, "Campaign");
    await shoot(alice, "05-movement-r1", testInfo);

    // MOVE + ATTACK: Bob seals a march onto Alice's lone levy.
    await marchOrder(bob, "Edirne (Adrianople)", "Selymbria");

    // The CombatModal auto-opens on BOTH seats.
    const bobModal = bob.getByRole("dialog", { name: "The Field at Selymbria" });
    await expect(bobModal).toBeVisible();
    await expect(bobModal).toContainText(
      "The Ottomans gives battle against Byzantium",
    );
    await expect(bobModal).toContainText("Weight of Numbers");
    await expect(bobModal).toContainText("attacker +1 each round");

    // TACTIC — attacker prompt first. The seeded hands hold no card playable
    // in this field battle (playbook): Forced March renders WITHHELD with its
    // reason, in the hand panel, rather than a "Play the Card" button.
    await expect(bobModal).toContainText(
      "The attacker declares first. The field awaits your seal.",
    );
    await expect(bobModal).toContainText("Forced March");
    await expect(bobModal).toContainText(
      "Withheld — this card rides with a March order, not into a joined battle.",
    );
    await expect(
      bobModal.getByRole("button", { name: "Play the Card" }),
    ).toHaveCount(0);
    await shoot(bob, "06-combat-modal-declared", testInfo);

    // …then the defender's prompt on Alice's seat, her siege-only card held.
    const aliceModal = alice.getByRole("dialog", {
      name: "The Field at Selymbria",
    });
    await expect(aliceModal).toBeVisible();
    await expect(aliceModal).toContainText(
      "The attacker declares first; then the defender may answer.",
    );
    await expect(aliceModal).toContainText("Treason at the Gate");
    // Treason at the Gate is an attacker-side siege card; the side gate
    // withholds it first on the defending seat.
    await expect(aliceModal).toContainText(
      "Withheld — this stratagem serves the attacker, and this day you defend.",
    );

    // The march cost Bob a deed (3 -> 2, read beneath the modal).
    expect(await readDeedsRemaining(bob)).toBe(2);

    // Alice must clear her modal so the host can reach Onward; Bob keeps his
    // open to watch the dice.
    await closeDialog(alice);
  });

  test("Round I · the reckoning: dice fall and Selymbria changes banners", async (
    {},
    testInfo,
  ) => {
    await onward(alice); // Campaign -> Council (DIPLOMACY), confirmed
    await expectPhase(alice, "Council");
    await shoot(alice, "05b-council-r1", testInfo);
    await onward(alice); // Council -> COMBAT (track still reads Council)
    await onward(alice); // COMBAT -> Twilight — the battle resolves here.

    // Bob's kept-open modal plays act 2: cascade, then the victory banner.
    const bobModal = bob.getByRole("dialog", { name: "The Field at Selymbria" });
    await expect(
      bobModal.getByRole("heading", { name: "The Day Is Yours" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(bobModal).toContainText("Selymbria is taken");
    await expect(bobModal.getByText("+1 Prestige")).toBeVisible();

    // The dice cascade: bring the reckoning back up and read it whole.
    await bobModal.getByRole("button", { name: "Review the Reckoning" }).click();
    await expect(
      bobModal.getByRole("group", { name: /Attacker's dice — The Ottomans/ }),
    ).toBeVisible();
    await expect(
      bobModal.getByRole("group", { name: /Defender's dice — Byzantium/ }),
    ).toBeVisible();
    await expect(bobModal.locator(".cbt-die").first()).toBeVisible();
    await expect(bobModal).toContainText(
      "A die of five or six strikes home. Each hit that stands fells one levy.",
    );
    await shoot(bob, "07-combat-resolution", testInfo);
    await closeCombatModal(bob); // "So It Is Written"

    for (const p of [alice, bob]) await expectPhase(p, "Twilight");
    await shoot(alice, "07b-twilight-r1", testInfo);

    // The army relocated: Selymbria now flies the Ottoman banner and hosts
    // the six-strong column that marched from Edirne.
    await selectProvince(alice, "Selymbria");
    await expect(alice.locator(".gb-right")).toContainText(
      "Under the banner of The Ottomans",
    );
    await expect(alice.locator(".insp-hosts")).toContainText(
      "The Ottomans — VI",
    );

    await onward(alice); // Twilight -> cleanup -> Round II Income
    for (const p of [alice, bob]) {
      await expectRound(p, "II");
      await expectPhase(p, "Income");
    }
  });

  test("Round II: the free companies come to the block", async ({}, testInfo) => {
    // Income -> Muster (direct); the Round II omen toast follows at once.
    await alice.getByRole("button", { name: "Onward" }).click();
    await expect(
      alice.getByRole("button", { name: /Silk Road Caravan/ }),
    ).toBeVisible();
    for (const p of [alice, bob]) {
      await expectPhase(p, "Muster");
      await expect(p.getByText("Stratagems in hand — II of III")).toBeVisible();
    }
    await expectGold(alice, 26);
    await expectGold(bob, 30);

    // MERC MARKET: Bob opens Traffic and raises the floor on the Company of
    // St George (opening purse 14 gold) — un-budgeted, no deed spent.
    await mercBidFloor(bob, "Company of St George");
    // The raise makes the round-robin live: the auction modal auto-routes on
    // BOTH seats (Bob's Traffic modal is swapped for it). Bob's purse stands
    // highest and the block cries his bid; the gold leaves the vault only
    // when the hammer falls.
    await expect(
      bob.locator(".mkt-company", { hasText: "Company of St George" }),
    ).toContainText("Your purse of fourteen Gold stands highest");
    await expect(
      bob.getByText("Bob bids 14 gold for the Company of St George."),
    ).toBeVisible();

    // The round-robin is live: the auction modal auto-opens for Alice.
    const auction = alice.getByRole("dialog", { name: "The Free Companies" });
    await expect(auction).toBeVisible({ timeout: 10_000 });
    await expect(auction).toContainText("Company of St George");
    await shoot(alice, "08-merc-auction", testInfo);

    // Alice passes ("Hold, and Watch" + its not-recalled confirm); one purse
    // stands -> sold to Bob at 14, and the auto-modal deroutes.
    await mercPass(alice, "Company of St George");
    await expect(auction).toBeHidden({ timeout: 10_000 });

    // Sold to Bob at 14: the survivor pays at the hammer (30 -> 16). Close
    // whatever Traffic modal still stands on Bob's seat, then verify the
    // company fielded at Edirne (4 Infantry + 3 Cavalry — strength VII).
    await expectGold(bob, 16);
    if (await bob.getByRole("dialog").isVisible().catch(() => false)) {
      await closeDialog(bob);
    }
    await selectProvince(bob, "Edirne (Adrianople)");
    await expect(bob.locator(".insp-hosts")).toContainText(
      "The Ottomans — VII",
    );

    await shoot(alice, "09-midgame-board-r2", testInfo);

    // Muster -> Campaign -> Council -> Council(COMBAT) -> Twilight -> cleanup.
    await advancePhases(alice, 5);
    for (const p of [alice, bob]) {
      await expectRound(p, "III");
      await expectPhase(p, "Income");
    }
  });

  test("Round III: the years run out and Byzantium stands first", async (
    {},
    testInfo,
  ) => {
    // No player actions needed: six advances carry Round III to its cleanup,
    // where scorePrestige crosses PRESTIGE_TARGET=12 and checkVictory fires.
    await advancePhases(alice, 6);

    expect(await awaitEndScreen(alice)).toBe(true); // the victor's heading
    expect(await awaitEndScreen(bob)).toBe(false); // outshone, not struck

    const end = alice.getByRole("dialog", { name: /The Years Are Run/ });
    await expect(end.getByText("The Track Has Judged")).toBeVisible();
    await expect(end).toContainText("Byzantium stands first in Prestige");

    // The Final Reckoning — the real engine tallies, 20 v 10.
    const byzRow = end.locator(".end-standings tbody tr", {
      hasText: "Byzantium",
    });
    await expect(byzRow).toContainText("Alice");
    await expect(byzRow).toContainText("20");
    await expect(byzRow).toContainText("Victor — first in Prestige");
    const ottoRow = end.locator(".end-standings tbody tr", {
      hasText: "The Ottomans",
    });
    await expect(ottoRow).toContainText("Bob");
    await expect(ottoRow).toContainText("10");
    await expect(ottoRow).toContainText("Endured to the end");

    // Bob's seat sees the outshone defeat copy.
    const bobEnd = bob.getByRole("dialog", { name: /The Years Are Run/ });
    await expect(bobEnd).toContainText("a brighter crown eclipsed your own");

    await shoot(alice, "10-victory", testInfo);
  });

  test("the chronicle is read: era chapters, real names, the age at a glance", async (
    {},
    testInfo,
  ) => {
    await readTheChronicle(alice); // "Read the Chronicle" -> the book heading

    const end = alice.getByRole("dialog", { name: /The Years Are Run/ });
    const book = end.locator(".end-chronicle");

    // One era played -> one chapter, the Era I title (exact: the glance
    // rail's "Era I · The Gathering Storm" heading also matches loosely).
    await expect(
      book.getByRole("heading", { name: "The Gathering Storm", exact: true }),
    ).toBeVisible();
    // Real names from the game thread the book: the era chapter's deed of
    // note records the round-I battle at the real province.
    await expect(book).toContainText("The battle of Selymbria · Round I");
    await expect(book).toContainText(
      "the true chronicle of two powers in a failing age",
    );

    // Around the book: the standings and epilogues panels carry the real
    // faction names.
    await expect(
      end.getByRole("heading", { name: "The Final Reckoning" }),
    ).toBeVisible();
    await expect(
      end.getByRole("heading", { name: "The Epilogues" }),
    ).toBeVisible();
    const epilogues = end.locator(".end-epilogue-list");
    await expect(epilogues).toContainText("Byzantium");
    await expect(epilogues).toContainText("The Ottomans");

    // The Age at a Glance: all three omens of the campaign, in order.
    await expect(
      book.getByRole("heading", { name: "The Age at a Glance" }),
    ).toBeVisible();
    const pip = (name: string) =>
      book.locator(".end-pip-button", { hasText: name });
    await expect(pip("Discovery of Alum")).toContainText("Round I · 1400");
    await expect(pip("Silk Road Caravan")).toContainText("Round II · 1405");
    await expect(pip("Comet Omen")).toContainText("Round III · 1410");
    // A pip opens to its record — flavor and reading.
    await pip("Discovery of Alum").click();
    await expect(book.locator(".end-pip-flavor")).toContainText("Phocaea");

    await expect(
      end.getByRole("button", { name: "Bind the Volume" }),
    ).toBeVisible();
    await expect(
      end.getByRole("button", { name: "Close the Book" }).first(),
    ).toBeVisible();
    await shoot(alice, "11-chronicle", testInfo);
  });

  test("no console errors accumulated on either page", async () => {
    // NO allow-list: any console.error or uncaught exception on either seat
    // across the whole campaign fails the gauntlet.
    expect(aliceErrors).toEqual([]);
    expect(bobErrors).toEqual([]);
  });
});
