/**
 * THE STRATAGEM PLAYED — a tactic card is genuinely played through the UI and
 * resolved by the engine into a battle.
 *
 * The gauntlet (game-flow.spec.ts) can only assert the WITHHELD rendering:
 * under seed 424242 the Round-I battle finds no playable card in either hand
 * (Forced March is a March-rider, Treason at the Gate is siege-only). This
 * spec engineers the battle where one IS playable, so PLAY_TACTIC is
 * dispatched from the CombatModal hand, queued on the pending battle, sealed
 * face-down on the rival's wire, and resolved by the engine when COMBAT runs.
 *
 * The seeded script (headlessly verified against the engine, seed 424242,
 * exact same action order as the playbook through Round I):
 *   - Round I replays the playbook: both recruits, Bob's Edirne -> Selymbria
 *     march, the battle resolves, Selymbria flips Ottoman ("The Ottomans —
 *     VI" = 5 units + the Ghazi Akinci).
 *   - Round II draws: Alice +Locked Shields, Bob +The Hexamilion Manned
 *     (hands II of III). The tactic deck is shuffled once at game creation,
 *     so these draws are fixed by the seed.
 *   - Round II Campaign: ALICE marches Constantinople -> Selymbria (her 3
 *     Infantry + the Varangian Guard, strength IV) onto Bob's host. Bob now
 *     DEFENDS a LAND battle in an UNWALLED province — exactly The Hexamilion
 *     Manned's window (defender +2, a temporary T2-grade wall bonus). His
 *     Forced March stays withheld; Alice's whole hand stays withheld
 *     (Treason: siege-only; Locked Shields: defender-side, and she attacks).
 *   - Bob clicks "Play the Card": the card leaves his hand ("Stratagems in
 *     hand — I of III"), the committed pill mounts on his modal, and ALICE'S
 *     modal shows one SEALED face-down stub — the projection redacts the
 *     rival's committed card ids (fog of war on the wire).
 *   - The engine resolves the battle in COMBAT with the tactic's modifier in
 *     force: Bob prevails in 1 round, Selymbria holds ("The Ottomans — V"
 *     after his single loss), Alice's broken column retires its remnant to
 *     Constantinople ("Byzantium — I" where IV marched out), and the
 *     chronicle carries both engine lines — Bob readies "The Hexamilion
 *     Manned" / Bob plays "The Hexamilion Manned". The card is discarded,
 *     not returned: his hand stays I of III. (Outcome values are pinned to
 *     the seeded e2e server, GAME_SEED=424242 — the same replayable-seed
 *     mechanism every other spec pins to.)
 *
 * Serial: one shared game; every test depends on the one before it.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  advancePhases,
  closeCombatModal,
  closeDialog,
  createTwoPlayerGame,
  expectGold,
  expectPhase,
  expectRound,
  marchOrder,
  onward,
  readChronicleLines,
  recruit,
  selectProvince,
  shoot,
  type TwoPlayerGame,
} from "./helpers/game.js";

const HEXAMILION = "The Hexamilion Manned";

test.describe.serial("the stratagem played — a tactic card turns a battle", () => {
  let game: TwoPlayerGame;
  let alice: Page; // Byzantium, host — Round II's ATTACKER.
  let bob: Page; // The Ottomans — Round II's DEFENDER, who plays the card.

  test.beforeAll(async ({ browser }) => {
    game = await createTwoPlayerGame(browser);
    alice = game.host.page;
    bob = game.guest.page;
  });

  test.afterAll(async () => {
    await game?.close();
  });

  test("Round I replays the playbook: recruits, Bob takes Selymbria", async () => {
    test.setTimeout(120_000);

    // Income -> Muster (omen resolves; each seat draws its first stratagem).
    await onward(alice);
    await expectPhase(alice, "Muster");
    for (const p of [alice, bob]) {
      await expect(p.getByText("Stratagems in hand — I of III")).toBeVisible();
    }

    // The playbook musters, verbatim (keeps the RNG cursor on the verified path).
    await recruit(alice, "Constantinople", { INFANTRY: 1 }); // 18 -> 14 gold
    await recruit(bob, "Edirne (Adrianople)", { LEVY: 1 }); // 17 -> 15 gold
    await expectGold(alice, 14);
    await expectGold(bob, 15);

    // Muster -> Campaign; Bob's march declares the Round-I battle.
    await onward(alice);
    await expectPhase(bob, "Campaign");
    await marchOrder(bob, "Edirne (Adrianople)", "Selymbria");
    await expect(
      bob.getByRole("dialog", { name: "The Field at Selymbria" }),
    ).toBeVisible();

    // Alice clears her auto-opened modal so the host can advance; Bob's
    // resolves and closes on the victory banner.
    await closeDialog(alice);
    await advancePhases(alice, 3); // Council, Council(COMBAT) -> Twilight
    await expect(
      bob
        .getByRole("dialog", { name: "The Field at Selymbria" })
        .getByRole("heading", { name: "The Day Is Yours" }),
    ).toBeVisible({ timeout: 20_000 });
    await closeCombatModal(bob);
    await expectPhase(alice, "Twilight");

    // Twilight -> cleanup -> Round II Income; the board is set for the play:
    // Bob's six-strong column garrisons unwalled Selymbria.
    await onward(alice);
    for (const p of [alice, bob]) {
      await expectRound(p, "II");
      await expectPhase(p, "Income");
    }
    await selectProvince(alice, "Selymbria");
    await expect(alice.locator(".gb-right")).toContainText(
      "Under the banner of The Ottomans",
    );
    await expect(alice.locator(".insp-hosts")).toContainText("The Ottomans — VI");
  });

  test("Round II: Alice marches on Selymbria and Bob's card is PLAYABLE", async ({}, testInfo) => {
    test.setTimeout(120_000);

    // Income -> Muster: the Round-II draws land (Alice +Locked Shields, Bob
    // +The Hexamilion Manned — fixed by the seed's one-time deck shuffle).
    await onward(alice);
    for (const p of [alice, bob]) {
      await expectPhase(p, "Muster");
      await expect(p.getByText("Stratagems in hand — II of III")).toBeVisible();
    }

    // Muster -> Campaign; ALICE attacks this time: Constantinople -> Selymbria.
    await onward(alice);
    for (const p of [alice, bob]) await expectPhase(p, "Campaign");
    await marchOrder(alice, "Constantinople", "Selymbria");

    // The CombatModal auto-opens on both seats; Alice is the ATTACKER now.
    const aliceModal = alice.getByRole("dialog", { name: "The Field at Selymbria" });
    await expect(aliceModal).toBeVisible();
    await expect(aliceModal).toContainText(
      "Byzantium gives battle against The Ottomans",
    );
    // Her whole hand is withheld — she attacks, on the open field:
    await expect(aliceModal).toContainText("Locked Shields");
    await expect(aliceModal).toContainText(
      "Withheld — this stratagem serves the defender, and this day you attack.",
    );
    await expect(aliceModal).toContainText("Treason at the Gate");
    await expect(
      aliceModal.getByRole("button", { name: "Play the Card" }),
    ).toHaveCount(0);

    // Bob DEFENDS a land battle in an unwalled province: The Hexamilion
    // Manned is the one playable card at this table — gold rim, live button.
    const bobModal = bob.getByRole("dialog", { name: "The Field at Selymbria" });
    await expect(bobModal).toBeVisible();
    await expect(bobModal).toContainText(
      "The attacker declares first; then the defender may answer.",
    );
    const hexCard = bobModal.locator(".cbt-card", { hasText: HEXAMILION });
    await expect(hexCard).toHaveClass(/is-playable/);
    await expect(hexCard.getByRole("button", { name: "Play the Card" })).toBeVisible();
    // His other card stays withheld (a March-rider, not a battle card):
    await expect(bobModal).toContainText(
      "Withheld — this card rides with a March order, not into a joined battle.",
    );
    await shoot(bob, "tactic-01-playable-card", testInfo);
  });

  test("the card is played: committed on his seal, sealed face-down on hers", async ({}, testInfo) => {
    test.setTimeout(120_000);

    const bobModal = bob.getByRole("dialog", { name: "The Field at Selymbria" });
    await bobModal
      .locator(".cbt-card", { hasText: HEXAMILION })
      .getByRole("button", { name: "Play the Card" })
      .click();

    // PLAY_TACTIC applied: the card moves from Bob's hand onto the battle —
    // the committed pill mounts, the hand card (and its button) are gone, and
    // the tray behind the modal counts I of III.
    await expect(
      bobModal.locator(".cbt-committed .pill", { hasText: HEXAMILION }),
    ).toBeVisible();
    await expect(bobModal.locator(".cbt-card", { hasText: HEXAMILION })).toHaveCount(0);
    await expect(
      bobModal.getByRole("button", { name: "Play the Card" }),
    ).toHaveCount(0);
    await expect(bob.getByText("Stratagems in hand — I of III")).toBeVisible();
    await shoot(bob, "tactic-02-committed", testInfo);

    // FOG OF WAR on the wire: Alice's projection carries the COUNT of Bob's
    // committed stratagems but never the face — her modal shows one sealed,
    // face-down stub and no card name.
    const aliceModal = alice.getByRole("dialog", { name: "The Field at Selymbria" });
    await expect(
      aliceModal.getByRole("img", {
        name: "A sealed stratagem of The Ottomans, face down",
      }),
    ).toBeVisible();
    await expect(aliceModal.locator(".cbt-sealed")).toHaveCount(1);
    await expect(aliceModal).not.toContainText(HEXAMILION);
    await shoot(alice, "tactic-03-sealed-for-rival", testInfo);
  });

  test("the engine resolves the battle with the stratagem in force", async ({}, testInfo) => {
    test.setTimeout(120_000);

    // Alice clears her modal so the host can advance; Bob keeps his open to
    // watch the reckoning.
    await closeDialog(alice);
    await advancePhases(alice, 3); // Council, Council(COMBAT) -> Twilight

    // Headlessly pinned under seed 424242: with the defender's +2 in force,
    // Bob prevails in one round and holds Selymbria.
    const bobModal = bob.getByRole("dialog", { name: "The Field at Selymbria" });
    await expect(
      bobModal.getByRole("heading", { name: "The Day Is Yours" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(bobModal).toContainText("Selymbria is held");
    await shoot(bob, "tactic-04-resolution", testInfo);
    await closeCombatModal(bob); // "So It Is Written"
    await expectPhase(alice, "Twilight");

    // The board tells the tale (seed-pinned): Selymbria still Ottoman (V
    // after his single loss); Alice's column breaks and its remnant retires
    // to Constantinople (I where IV marched out).
    await selectProvince(alice, "Selymbria");
    await expect(alice.locator(".gb-right")).toContainText(
      "Under the banner of The Ottomans",
    );
    await expect(alice.locator(".insp-hosts")).toContainText("The Ottomans — V");
    await selectProvince(alice, "Constantinople");
    await expect(alice.locator(".insp-hosts")).toContainText("Byzantium — I");

    // The chronicle carries BOTH engine lines for the card — the declaration
    // (queueTactic) and the combat-time resolution (playTactic):
    const chronicle = (await readChronicleLines(bob)).join("\n");
    expect(chronicle).toContain('Bob readies "The Hexamilion Manned"');
    expect(chronicle).toContain('Bob plays "The Hexamilion Manned"');

    // Played means SPENT: the card went to the discard, not back to his hand.
    await expect(bob.getByText("Stratagems in hand — I of III")).toBeVisible();
    await shoot(alice, "tactic-05-aftermath", testInfo);
  });
});
