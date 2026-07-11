/**
 * HIDDEN-INFORMATION E2E — fog-of-war verified at the WIRE level, not just
 * the DOM (server/src/engine/projection.ts is the contract under test,
 * exercised through the REAL stack: server :4610 + vite :5610, two browser
 * contexts, seeded game GAME_SEED=424242 per e2e/playwright.config.ts).
 *
 * Mechanism: both pages get a transport-level wire tap (helpers/game.ts,
 * "hidden-info additions") installed via addInitScript BEFORE any app script
 * runs — window.WebSocket is subclassed to record every incoming frame, and
 * XHR/fetch responses on /socket.io/ URLs are recorded too (socket.io v4
 * STARTS on HTTP long-polling before the ws upgrade, so a ws-only tap would
 * miss the game_started snapshot). Everything the server ever sent to a page
 * is then greppable from the test as raw frame text.
 *
 * Ground truth comes from Alice's OWN side (her seat arrives unredacted to
 * her): her objective ids + descriptions and tactic-card ids are read from
 * her wire frames and CROSS-CHECKED against what her DOM actually renders
 * (Sealed Ambitions panel text, tactic tray card names mapped back to engine
 * ids). A control assertion proves the tap captures those exact strings on
 * Alice's wire — so the "absent from Bob" checks below can never pass
 * vacuously against an empty or broken capture.
 *
 * Then, on Bob's side, we assert:
 *   (1) WIRE: none of Alice's concrete objective ids/descriptions, hand card
 *       ids/names, or tactic ids appear in ANY frame Bob ever received
 *       (tactic ids Bob legitimately holds himself, or that sit in the
 *       public discard/removed piles, are excluded from the secret set);
 *   (2) WIRE: Bob's view of Alice is same-length sealed stubs — objectives
 *       {id:"hidden", description:"Sealed objective"}, hand cards
 *       {id:"hidden", name:"Hidden card"}, tacticHand entries "hidden" —
 *       with array lengths exactly matching Alice's real (count-public);
 *   (3) WIRE: rngSeed/rngCursor are 0 in every projected state either seat
 *       received, and no frame carries a "seed" field or the real seed value
 *       (the game_start log entry's seed is scrubbed server-side);
 *   (4) DOM: Bob's page never renders Alice's secrets, and his Sealed
 *       Ambitions panel shows the rival as a count ("3 sealed"), not text.
 *
 * NOTE on Player.hand: the engine currently never puts a card INTO any hand
 * (server/src/engine/actions.ts only ever removes on PLAY_CARD), so the hand
 * legs run against empty arrays — the loops and length-parity assertions are
 * real and become load-bearing the moment a card-acquisition path lands.
 *
 * Playbook beats used (e2e-playbook.md, seed 424242): R1 Income -> Muster
 * (draws: Alice "Treason at the Gate", Bob "Forced March"), Alice musters
 * 1 Infantry at Constantinople, Bob 1 Levy at Edirne, run to R2 Muster
 * (draws: Alice +"Locked Shields", Bob +"The Hexamilion Manned") — leaving
 * each seat 3 secret objectives + 2 tactics, disjoint between seats.
 */
import { test, expect } from "@playwright/test";
import {
  advancePhases,
  createTwoPlayerGameWireTapped,
  expectPhase,
  expectRound,
  onward,
  readWireFrames,
  recruit,
  shoot,
  TACTIC_NAME_TO_ID,
  wireGameStates,
  wirePlayerByName,
} from "./helpers/game.js";

/** ObjectivesPanel door + dialog (client/src/game/objectives/ObjectivesPanel.tsx). */
const AMBITIONS_DOOR = "Open The Sealed Ambitions";
const AMBITIONS_TITLE = "The Sealed Ambitions";

/** Projection stub constants (server/src/engine/projection.ts). */
const HIDDEN_ID = "hidden";
const SEALED_OBJECTIVE_TEXT = "Sealed objective";
const HIDDEN_CARD_NAME = "Hidden card";

/** Engine id -> display name (reverse of the helpers' verbatim table). */
const TACTIC_ID_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(TACTIC_NAME_TO_ID).map(([name, id]) => [id, name]),
);

/**
 * How a string looks INSIDE a JSON wire frame (body of JSON.stringify,
 * without the surrounding quotes) — e.g. embedded quotes become \".
 */
function asWireText(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

test("fog of war: Alice's secrets never reach Bob's wire or DOM; counts survive as sealed stubs; RNG seed is scrubbed", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const game = await createTwoPlayerGameWireTapped(browser);
  try {
    const alice = game.host.page; // Byzantium, host
    const bob = game.guest.page; // The Ottomans

    // ---- Round I: Income -> Muster (both seats draw their first tactic) --
    await onward(alice);
    await expectPhase(alice, "Muster");
    await expect(alice.locator(".card-tactic")).toHaveCount(1);

    // Several real actions by both seats (playbook beats 3-4).
    await recruit(alice, "Constantinople", { INFANTRY: 1 });
    await recruit(bob, "Edirne (Adrianople)", { LEVY: 1 });

    // ---- Rest of Round I, then Round II Income -> Muster (second draws) --
    await advancePhases(alice, 5); // Campaign, Council, Council(COMBAT), Twilight+cleanup -> R2 Income
    await expectRound(alice, "II");
    await onward(alice); // -> R2 Muster: second tactic draw for both seats
    await expectPhase(alice, "Muster");
    await expect(alice.locator(".card-tactic")).toHaveCount(2);
    // Bob's page must have processed the same snapshot before we read taps.
    await expectRound(bob, "II");
    await expectPhase(bob, "Muster");
    await expect(bob.locator(".card-tactic")).toHaveCount(2);

    // =====================================================================
    // A-side ground truth — what Alice's own page DOES show (DOM), cross-
    // checked against what her own wire carried.
    // =====================================================================
    await alice.getByRole("button", { name: AMBITIONS_DOOR }).click();
    const aliceDialog = alice.getByRole("dialog", { name: AMBITIONS_TITLE });
    await expect(aliceDialog).toBeVisible();
    const aliceDomObjectives = await aliceDialog
      .locator(".obj-list .obj-desc")
      .allTextContents();
    expect(aliceDomObjectives, "Alice sees her three real objectives").toHaveLength(3);
    for (const desc of aliceDomObjectives) {
      expect(desc.trim().length, `objective text is concrete, not a stub: "${desc}"`).toBeGreaterThan(10);
      expect(desc).not.toContain(SEALED_OBJECTIVE_TEXT);
    }
    await shoot(alice, "hidden-01-a-sealed-ambitions", testInfo);
    await alice.keyboard.press("Escape");
    await expect(aliceDialog).toBeHidden();

    const aliceDomTacticNames = (
      await alice.locator(".card-tactic-name").allTextContents()
    ).map((n) => n.trim());
    expect(aliceDomTacticNames, "Alice's tray shows two named tactic cards").toHaveLength(2);
    const aliceDomTacticIds = aliceDomTacticNames.map((name) => {
      const id = TACTIC_NAME_TO_ID[name];
      expect(id, `DOM tactic name "${name}" maps to an engine card id`).toBeTruthy();
      return id;
    });

    // Alice's OWN wire: her seat arrives unredacted to her.
    const framesA = await readWireFrames(alice);
    const statesA = wireGameStates(framesA);
    expect(statesA.length, "Alice's tap captured projected game states").toBeGreaterThan(0);
    const aliceWire = wirePlayerByName(statesA[statesA.length - 1], "Alice");
    const aliceWireObjIds = aliceWire.objectives.map((o) => o.id);
    const aliceWireObjDescs = aliceWire.objectives.map((o) => o.description);
    const aliceWireTacticIds = aliceWire.tacticHand ?? [];
    const aliceHandCards = aliceWire.hand;
    expect(aliceWireObjIds).toHaveLength(3);
    for (const id of aliceWireObjIds) expect(id).not.toBe(HIDDEN_ID);

    // CROSS-CHECK: DOM text == wire text, exactly (both directions, as sets).
    expect([...aliceDomObjectives].sort()).toEqual([...aliceWireObjDescs].sort());
    // CROSS-CHECK: DOM card names map back to exactly the wire tactic ids.
    expect([...aliceDomTacticIds].sort()).toEqual([...aliceWireTacticIds].sort());

    // CONTROL: the tap really captures the wire — Alice's own frames MUST
    // contain her secrets verbatim, or every "absent from Bob" assertion
    // below would pass vacuously against a broken/empty capture.
    const corpusA = framesA.join("\n");
    for (const desc of aliceWireObjDescs) {
      expect(corpusA, `control: Alice's own frames carry her objective text "${desc}"`).toContain(asWireText(desc));
    }
    for (const id of aliceWireObjIds) {
      expect(corpusA, `control: Alice's own frames carry her objective id "${id}"`).toContain(`"${id}"`);
    }
    for (const id of aliceWireTacticIds) {
      expect(corpusA, `control: Alice's own frames carry her tactic id "${id}"`).toContain(`"${id}"`);
    }

    // =====================================================================
    // B-side WIRE assertions — grep EVERYTHING the server ever sent Bob.
    // =====================================================================
    const framesB = await readWireFrames(bob);
    const corpusB = framesB.join("\n");
    const statesB = wireGameStates(framesB);
    expect(statesB.length, "Bob's tap captured projected game states").toBeGreaterThan(0);
    const lastStateB = statesB[statesB.length - 1];
    const bobWire = wirePlayerByName(lastStateB, "Bob");
    const aliceSeenByBob = wirePlayerByName(lastStateB, "Alice");

    // Tactic ids that may legitimately appear on Bob's wire (his own hand,
    // or the public discard/removed piles) are excluded from the secret set.
    const publiclyKnowableTacticIds = new Set<string>([
      ...(bobWire.tacticHand ?? []),
      ...(lastStateB.tacticDiscard ?? []),
      ...(lastStateB.tacticRemoved ?? []),
    ]);
    const secretTacticIds = aliceWireTacticIds.filter(
      (id) => !publiclyKnowableTacticIds.has(id),
    );
    expect(
      secretTacticIds.length,
      "seeded draws leave Alice holding at least one tactic Bob cannot legitimately know",
    ).toBeGreaterThan(0);

    // (1a) Alice's objective ids and descriptions: NEVER in Bob's frames.
    for (const id of aliceWireObjIds) {
      expect(corpusB, `LEAK: Alice's objective id "${id}" reached Bob's wire`).not.toContain(`"${id}"`);
    }
    for (const desc of aliceWireObjDescs) {
      expect(corpusB, `LEAK: Alice's objective text reached Bob's wire: "${desc}"`).not.toContain(asWireText(desc));
    }
    // (1b) Alice's tactic ids (and display names — names should never ride
    // the wire for ANY seat; they are client-side data keyed by id).
    for (const id of secretTacticIds) {
      expect(corpusB, `LEAK: Alice's tactic id "${id}" reached Bob's wire`).not.toContain(`"${id}"`);
    }
    for (const name of aliceDomTacticNames) {
      expect(corpusB, `LEAK: tactic display name "${name}" reached Bob's wire`).not.toContain(asWireText(name));
    }
    // (1c) Alice's hand card ids/names (empty today — see file header; the
    // loop is the contract and bites as soon as cards can enter a hand).
    for (const card of aliceHandCards) {
      expect(corpusB, `LEAK: Alice's hand card id "${card.id}" reached Bob's wire`).not.toContain(`"${card.id}"`);
      expect(corpusB, `LEAK: Alice's hand card name "${card.name}" reached Bob's wire`).not.toContain(asWireText(card.name));
    }

    // (2) Bob's projected view of Alice: same-length sealed stubs (counts
    // are public, identities are not).
    expect(aliceSeenByBob.objectives, "objective COUNT is public").toHaveLength(aliceWire.objectives.length);
    for (const stub of aliceSeenByBob.objectives) {
      expect(stub.id).toBe(HIDDEN_ID);
      expect(stub.description).toBe(SEALED_OBJECTIVE_TEXT);
    }
    expect(aliceSeenByBob.hand, "hand COUNT is public").toHaveLength(aliceHandCards.length);
    for (const stub of aliceSeenByBob.hand) {
      expect(stub.id).toBe(HIDDEN_ID);
      expect(stub.name).toBe(HIDDEN_CARD_NAME);
    }
    expect(aliceSeenByBob.tacticHand ?? [], "tactic-hand COUNT is public").toHaveLength(aliceWireTacticIds.length);
    for (const stub of aliceSeenByBob.tacticHand ?? []) {
      expect(stub).toBe(HIDDEN_ID);
    }

    // (3) RNG bookkeeping: zeroed in every projected state EITHER seat got,
    // and no frame carries a raw "seed" field or the real seed value (the
    // game_start log entry's data.seed is scrubbed by the projection).
    for (const s of statesB) {
      expect(s.rngSeed ?? 0, "rngSeed is 0/absent in every state on Bob's wire").toBe(0);
      expect(s.rngCursor ?? 0, "rngCursor is 0/absent in every state on Bob's wire").toBe(0);
    }
    for (const s of statesA) {
      expect(s.rngSeed ?? 0, "rngSeed is 0/absent on Alice's wire too (redacted for everyone)").toBe(0);
      expect(s.rngCursor ?? 0).toBe(0);
    }
    for (const [who, corpus] of [["Bob", corpusB], ["Alice", corpusA]] as const) {
      expect(corpus, `nonzero rngSeed on ${who}'s wire`).not.toMatch(/"rngSeed"\s*:\s*[1-9]/);
      expect(corpus, `nonzero rngCursor on ${who}'s wire`).not.toMatch(/"rngCursor"\s*:\s*[1-9]/);
      expect(corpus, `raw "seed" field on ${who}'s wire (game_start log scrub)`).not.toMatch(/"seed"\s*:/);
      expect(corpus, `the real GAME_SEED value on ${who}'s wire`).not.toMatch(/"(rngSeed|rngCursor|seed)"\s*:\s*424242/);
    }

    // =====================================================================
    // B-side DOM assertions — Bob's page renders stubs/counts, never text.
    // =====================================================================
    await bob.getByRole("button", { name: AMBITIONS_DOOR }).click();
    const bobDialog = bob.getByRole("dialog", { name: AMBITIONS_TITLE });
    await expect(bobDialog).toBeVisible();
    const aliceRivalRow = bobDialog.locator(".obj-rival", { hasText: "Alice" });
    await expect(aliceRivalRow).toContainText("Byzantium");
    // The projection's same-length stub array IS the public count.
    await expect(aliceRivalRow.locator(".obj-rival-sealed")).toHaveText(/3\s*sealed/);
    // No Whisper missions were run: Bob has no uncovered-intel lines at all.
    await expect(bobDialog.locator(".obj-intel")).toHaveCount(0);
    await shoot(bob, "hidden-02-b-rivals-sealed", testInfo);
    const bobDialogText = await bobDialog.innerText();
    for (const desc of aliceWireObjDescs) {
      expect(bobDialogText, "LEAK (DOM): Alice's objective text in Bob's Sealed Ambitions panel").not.toContain(desc);
    }
    await bob.keyboard.press("Escape");
    await expect(bobDialog).toBeHidden();

    // Whole-page sweep: nothing anywhere on Bob's page renders Alice's
    // objective texts or the names of tactics only Alice holds.
    const bobBodyText = await bob.locator("body").innerText();
    for (const desc of aliceWireObjDescs) {
      expect(bobBodyText, `LEAK (DOM): objective text rendered on Bob's page: "${desc}"`).not.toContain(desc);
    }
    for (const id of secretTacticIds) {
      const name = TACTIC_ID_TO_NAME[id];
      expect(bobBodyText, `LEAK (DOM): rival tactic "${name}" rendered on Bob's page`).not.toContain(name);
      expect(bobBodyText, `LEAK (DOM): rival tactic id "${id}" rendered on Bob's page`).not.toContain(id);
    }
  } finally {
    await game.close();
  }
});
