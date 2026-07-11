import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Screenshots/evidence land under the harness's gitignored e2e/test-results
// dir by default; QA runs override with BOARD_SHOTS_DIR to collect evidence
// outside the repo. No __dirname here: the workspace is ESM
// ("type":"module"), so derive it from import.meta.url.
const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR =
  process.env.BOARD_SHOTS_DIR ??
  path.join(SPEC_DIR, "..", "..", "test-results", "board-output");

// The canon-id fixture SVG (a test asset, not art) is served to the page via
// route interception and mounted through the Board's `svgUrl` override.
const FIXTURE_SVG_PATH = path.join(SPEC_DIR, "fixtures", "canon-board.svg");
const FIXTURE_SVG_URL = "/e2e/canon-board.svg";

// docs/MAP.md canon (55 provinces / 12 seas) vs the vendored hand-drawn
// board.svg (53 old region ids / 12 old sea ids): the expected drift until
// the rebuilt canon-id art board lands. 17 province ids and 3 sea ids
// coincide between the schemes.
const EXPECTED_DRIFT = {
  provinces: { missingInSvg: 38, extraInSvg: 36 },
  seaZones: { missingInSvg: 9, extraInSvg: 9 },
};

function shot(name: string): string {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  return path.join(SHOTS_DIR, name);
}

async function openDemo(page: Page): Promise<void> {
  await page.goto("/board-demo");
  await expect(page.locator("svg#board")).toBeVisible();
  // The vendored SVG still carries the retired 53-region + 12-sea id scheme.
  await expect(page.locator("#board-provinces path")).toHaveCount(53);
  await expect(page.locator("#board-seas path")).toHaveCount(12);
}

async function openFixtureDemo(page: Page): Promise<void> {
  await page.route(`**${FIXTURE_SVG_URL}`, (route) =>
    route.fulfill({ path: FIXTURE_SVG_PATH, contentType: "image/svg+xml" }),
  );
  await page.goto(`/board-demo?svgUrl=${encodeURIComponent(FIXTURE_SVG_URL)}`);
  await expect(page.locator("svg#board")).toBeVisible();
  await expect(page.locator("#board-provinces path")).toHaveCount(10);
  await expect(page.locator("#board-seas path")).toHaveCount(3);
}

/**
 * Find a client-space point where the shape itself is the topmost hit target.
 * Playwright's default center point is unreliable on the map: concave province
 * paths, city decorations and sea labels can cover a shape's bbox center.
 * Scans the shape's bounding box and returns the hit closest to its center.
 */
async function pointOnShape(page: Page, id: string): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate((shapeId) => {
    const el = document.getElementById(shapeId);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const steps = 32;
    let best: { x: number; y: number; d: number } | null = null;
    for (let iy = 1; iy < steps; iy++) {
      for (let ix = 1; ix < steps; ix++) {
        const x = rect.left + (rect.width * ix) / steps;
        const y = rect.top + (rect.height * iy) / steps;
        const hit = document.elementFromPoint(x, y);
        if (hit !== el) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (best === null || d < best.d) best = { x, y, d };
      }
    }
    return best === null ? null : { x: best.x, y: best.y };
  }, id);
  expect(pt, `no pointer-reachable point found on #${id}`).not.toBeNull();
  return pt as { x: number; y: number };
}

test.describe.configure({ mode: "serial" });

// The root harness project uses Desktop Chrome's default 1280x720; the board
// evidence shots and hit-scan geometry were built against the desktop size
// the retired client-local config used, so pin it per-suite here.
test.use({ viewport: { width: 1440, height: 900 } });

// ---------------------------------------------------------------------------
// Real demo: the vendored hand-drawn SVG with the RETIRED id scheme. Canon
// map data no longer matches it, so the id-diff must report exactly the
// known drift — this is how the eventual canon-SVG swap stays verifiable.
// ---------------------------------------------------------------------------
test.describe("board demo — vendored SVG (expected id drift)", () => {
  test("id-diff panel and dev reporter surface the canon-vs-SVG drift", async ({
    page,
  }) => {
    const consoleLines: string[] = [];
    page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));

    await openDemo(page);
    // Let StrictMode double-mount effects settle before reading the console.
    await page.waitForTimeout(250);

    // The dev panel shows the diff counts computed by the mounted Board.
    await expect(page.getByTestId("id-diff-provinces")).toHaveText(
      `provinces: ${EXPECTED_DRIFT.provinces.missingInSvg} data-only / ` +
        `${EXPECTED_DRIFT.provinces.extraInSvg} svg-only`,
    );
    await expect(page.getByTestId("id-diff-seas")).toHaveText(
      `seas: ${EXPECTED_DRIFT.seaZones.missingInSvg} data-only / ` +
        `${EXPECTED_DRIFT.seaZones.extraInSvg} svg-only`,
    );

    // The dev console reporter fired for both id spaces with the same counts.
    const drift = consoleLines.filter((l) => l.includes("[board] id drift"));
    expect(drift.length).toBeGreaterThan(0);
    expect(
      drift.some((l) =>
        l.includes(
          `(provinces): ${EXPECTED_DRIFT.provinces.missingInSvg} data id(s) missing in SVG, ` +
            `${EXPECTED_DRIFT.provinces.extraInSvg} SVG shape(s) without data`,
        ),
      ),
      `no province drift line in:\n${drift.join("\n")}`,
    ).toBe(true);
    expect(
      drift.some((l) =>
        l.includes(
          `(sea zones): ${EXPECTED_DRIFT.seaZones.missingInSvg} data id(s) missing in SVG, ` +
            `${EXPECTED_DRIFT.seaZones.extraInSvg} SVG shape(s) without data`,
        ),
      ),
      `no sea-zone drift line in:\n${drift.join("\n")}`,
    ).toBe(true);

    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(SHOTS_DIR, "id-diff.txt"),
      [
        "# Mount-time id-diff — /board-demo (vendored old-scheme SVG)",
        "",
        "Canon mapData (docs/MAP.md: 55 provinces / 12 seas) vs the retired",
        "hand-drawn board.svg (53 regions / 12 seas). Expected drift:",
        `  provinces: ${JSON.stringify(EXPECTED_DRIFT.provinces)}`,
        `  sea zones: ${JSON.stringify(EXPECTED_DRIFT.seaZones)}`,
        "",
        "Console reporter lines:",
        ...drift.map((l) => `  ${l}`),
        "",
      ].join("\n"),
    );
  });

  test("selection still works on data-less SVG shapes (id-based, no data required)", async ({
    page,
  }) => {
    await openDemo(page);
    const pt = await pointOnShape(page, "thrace");
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#thrace")).toHaveClass(/\bis-selected\b/);
    // "thrace" is not a canon id, so it has no game data: no move targets...
    await expect(page.locator(".is-move-target")).toHaveCount(0);
    // ...and the tooltip renders its no-data fallback.
    await page.mouse.move(pt.x, pt.y + 4);
    const tooltip = page.locator(".board-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator(".board-tooltip-sub")).toHaveText("no data");
    // Clicking the selected shape again toggles the selection off.
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#thrace")).not.toHaveClass(/\bis-selected\b/);
  });

  test("a lost pointerup never leaves the board stuck to the cursor", async ({
    page,
  }) => {
    await openDemo(page);
    const transform = () =>
      page.evaluate(
        () =>
          document.querySelector<HTMLElement>(".board-content")?.style.transform ?? "",
      );
    const before = await transform();

    // Failure mode 1: the press is seen by the viewport but the release
    // happens outside it (fast flick out / release past the window edge).
    // The window-level pointerup listener must clear the gesture, so the
    // following button-up hover moves must NOT pan the board.
    await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".board-viewport")!;
      const base = { bubbles: true, pointerId: 7, pointerType: "mouse", isPrimary: true };
      viewport.dispatchEvent(
        new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: 200, clientY: 200 }),
      );
      document.body.dispatchEvent(
        new PointerEvent("pointerup", { ...base, clientX: -40, clientY: 200 }),
      );
      for (let i = 1; i <= 5; i++) {
        viewport.dispatchEvent(
          new PointerEvent("pointermove", { ...base, buttons: 0, clientX: 200 + i * 30, clientY: 200 + i * 20 }),
        );
      }
    });
    await page.waitForTimeout(60); // an erroneous pan would flush via rAF
    expect(await transform()).toBe(before);

    // Failure mode 2: pointerup lost entirely (alt-tab, browser ate it).
    // The e.buttons === 0 guard must drop the stale entry on the next
    // hover move instead of panning.
    await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".board-viewport")!;
      const base = { bubbles: true, pointerId: 9, pointerType: "mouse", isPrimary: true };
      viewport.dispatchEvent(
        new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: 320, clientY: 300 }),
      );
      for (let i = 1; i <= 5; i++) {
        viewport.dispatchEvent(
          new PointerEvent("pointermove", { ...base, buttons: 0, clientX: 320 + i * 30, clientY: 300 + i * 20 }),
        );
      }
    });
    await page.waitForTimeout(60);
    expect(await transform()).toBe(before);

    // Recovery: the next real click still selects (dragged not stuck true,
    // click not swallowed by shouldIgnoreClick).
    const pt = await pointOnShape(page, "thrace");
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#thrace")).toHaveClass(/\bis-selected\b/);
  });

  test("perf: a 60-event wheel+drag burst never re-renders the province layer", async ({
    page,
  }) => {
    await openDemo(page);
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    // Center of the board area (the aside control panel is the right 280px).
    const cx = (viewport!.width - 280) / 2;
    const cy = viewport!.height / 2;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(100);

    const before = await page.evaluate(() => ({
      renders: (window as unknown as { __provinceLayerRenders?: number })
        .__provinceLayerRenders,
      transform:
        document.querySelector<HTMLElement>(".board-content")?.style.transform ?? "",
    }));
    expect(typeof before.renders).toBe("number");
    expect(before.renders!).toBeGreaterThan(0);

    // Frame cadence recorder (rAF timestamps) running through the burst.
    await page.evaluate(() => {
      const w = window as unknown as {
        __frameStamps: number[];
        __frameStop: boolean;
      };
      w.__frameStamps = [];
      w.__frameStop = false;
      const loop = (t: number) => {
        w.__frameStamps.push(t);
        if (!w.__frameStop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });

    // Burst: 30 wheel-zoom events + a 30-move drag pan = 60+ input events.
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, i % 3 === 2 ? 60 : -60);
    }
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(cx + i * 4, cy + Math.sin(i / 4) * 40);
    }
    await page.mouse.up();
    await page.waitForTimeout(120); // let the last rAF write flush

    const stamps = (await page.evaluate(() => {
      const w = window as unknown as {
        __frameStamps: number[];
        __frameStop: boolean;
      };
      w.__frameStop = true;
      return w.__frameStamps;
    })) as number[];

    const after = await page.evaluate(() => ({
      renders: (window as unknown as { __provinceLayerRenders?: number })
        .__provinceLayerRenders,
      transform:
        document.querySelector<HTMLElement>(".board-content")?.style.transform ?? "",
    }));

    // The wrapper transform DID change...
    expect(after.transform).not.toBe(before.transform);
    expect(after.transform).toContain("scale(");
    // ...while the ProvinceLayer component body never re-executed.
    expect(after.renders).toBe(before.renders);

    // Approximate frame cadence during the burst (informational).
    const deltas = stamps.slice(1).map((t, i) => t - stamps[i]);
    if (deltas.length > 0) {
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const max = Math.max(...deltas);
      test.info().annotations.push({
        type: "frame-cadence",
        description: `frames=${stamps.length} avg=${avg.toFixed(2)}ms max=${max.toFixed(2)}ms (~${(1000 / avg).toFixed(0)} fps)`,
      });
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(SHOTS_DIR, "frame-cadence.txt"),
        `wheel+drag burst: ${stamps.length} rAF frames, avg ${avg.toFixed(2)}ms, ` +
          `max ${max.toFixed(2)}ms (~${(1000 / avg).toFixed(0)} fps)\n` +
          `provinceLayer renders before/after: ${before.renders}/${after.renders}\n` +
          `transform before: "${before.transform}"\ntransform after:  "${after.transform}"\n`,
      );
    }
  });

  test("evidence screenshots at desktop and 1024 widths", async ({ page }) => {
    await openDemo(page);
    await page.waitForTimeout(300); // fonts + overlay settle
    await page.screenshot({ path: shot("demo-desktop.png") });

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("demo-1024.png") });
  });
});

// ---------------------------------------------------------------------------
// Canon fixture: the same demo page with the canon-id test SVG injected via
// the Board's svgUrl override. Interactions run against MAP.md canon ids.
// ---------------------------------------------------------------------------
test.describe("board demo — canon-id fixture SVG", () => {
  test("mounts the fixture with zero svg-only drift", async ({ page }) => {
    await openFixtureDemo(page);
    // All 13 fixture ids are canon, so nothing is svg-only; the 45 provinces
    // and 9 seas not drawn in the fixture are data-only.
    await expect(page.getByTestId("id-diff-provinces")).toHaveText(
      "provinces: 45 data-only / 0 svg-only",
    );
    await expect(page.getByTestId("id-diff-seas")).toHaveText(
      "seas: 9 data-only / 0 svg-only",
    );
  });

  test("province hover shows canon MAP.md data in the tooltip", async ({ page }) => {
    await openFixtureDemo(page);
    const pt = await pointOnShape(page, "constantinople");
    await page.mouse.move(pt.x, pt.y);

    await expect(page.locator("#constantinople")).toHaveClass(/\bis-hovered\b/);
    const tooltip = page.locator(".board-tooltip");
    await expect(tooltip).toBeVisible();
    // Canon data: MAP.md constantinople = city, gold primary, faith secondary.
    await expect(tooltip.locator(".board-tooltip-name")).toHaveText("Constantinople");
    await expect(tooltip.locator(".board-tooltip-sub")).toHaveText("city");
    await expect(tooltip.locator(".board-tooltip-yields")).toHaveText(
      "2 gold · 1 faith",
    );

    await page.screenshot({ path: shot("fixture-tooltip.png") });

    // Hover is transient: leaving the shape clears class and tooltip.
    await page.mouse.move(5, 5);
    await expect(page.locator("#constantinople")).not.toHaveClass(/\bis-hovered\b/);
    await expect(tooltip).toHaveCount(0);
  });

  test("click selects constantinople and highlights canon move targets", async ({
    page,
  }) => {
    await openFixtureDemo(page);
    const pt = await pointOnShape(page, "constantinople");
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#constantinople")).toHaveClass(/\bis-selected\b/);

    // Fixture: a-byz-1 garrisons constantinople, so land neighbors only —
    // selymbria, pera, and bithynia across the Bosphorus strait (MAP.md §6).
    const expected = ["selymbria", "pera", "bithynia"];
    await expect(page.locator("#board-provinces path.is-move-target")).toHaveCount(
      expected.length,
    );
    for (const id of expected) {
      await expect(page.locator(`#${id}`)).toHaveClass(/\bis-move-target\b/);
    }
    // Armies never target sea zones.
    await expect(page.locator("#board-seas path.is-move-target")).toHaveCount(0);

    // Selection is persistent: it survives the pointer leaving the shape.
    await page.mouse.move(5, 5);
    await expect(page.locator("#constantinople")).toHaveClass(/\bis-selected\b/);

    await page.screenshot({ path: shot("fixture-selected.png") });

    // Clicking the selected shape again toggles the selection off.
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#constantinople")).not.toHaveClass(/\bis-selected\b/);
  });

  test("canon starting ownership paints the owner classes", async ({ page }) => {
    await openFixtureDemo(page);
    const fill = (id: string) =>
      page.evaluate(
        (shapeId) => getComputedStyle(document.getElementById(shapeId)!).fill,
        id,
      );

    // MAP.md §4 starts: constantinople Byzantine, venice Venetian,
    // pera/edirne per their factions; rome starts Independent.
    // Canon UI_DESIGN §2.1 heraldry: byzantium #7A2E2E.
    await expect(page.locator("#constantinople")).toHaveClass(/\bowner-byzantium\b/);
    await expect.poll(() => fill("constantinople")).toBe("rgb(122, 46, 46)");
    await expect(page.locator("#venice")).toHaveClass(/\bowner-venice\b/);
    await expect(page.locator("#pera")).toHaveClass(/\bowner-genoa\b/);
    await expect(page.locator("#edirne")).toHaveClass(/\bowner-ottoman\b/);
    await expect(page.locator("#rome")).not.toHaveClass(/owner-/);

    // Dev-control reassignment: hand rome to Venice, then back.
    await page.locator("[data-testid=owner-province-select]").selectOption("rome");
    await page.locator("[data-testid=owner-faction-select]").selectOption("p-venice");
    await page.locator("[data-testid=owner-apply]").click();
    // Canon UI_DESIGN §2.1 heraldry: venice #B4472A.
    await expect(page.locator("#rome")).toHaveClass(/\bowner-venice\b/);
    await expect.poll(() => fill("rome")).toBe("rgb(180, 71, 42)");

    await page.locator("[data-testid=owner-faction-select]").selectOption("");
    await page.locator("[data-testid=owner-apply]").click();
    await expect(page.locator("#rome")).not.toHaveClass(/owner-/);
  });

  test("colorblind toggle applies pattern overlays", async ({ page }) => {
    await openFixtureDemo(page);
    await page.locator("[data-testid=colorblind-toggle]").check();

    await expect(page.locator("svg#board")).toHaveClass(/\bcolorblind\b/);
    for (const slug of ["byzantium", "ottoman", "venice", "genoa", "hungary"]) {
      await expect(page.locator(`#facPattern-${slug}`)).toHaveCount(1);
    }
    // Owned provinces now paint the pattern, not the flat wash.
    const fill = await page.evaluate(
      () => getComputedStyle(document.getElementById("constantinople")!).fill,
    );
    expect(fill).toContain("facPattern-byzantium");

    await page.screenshot({ path: shot("fixture-colorblind.png") });

    await page.locator("[data-testid=colorblind-toggle]").uncheck();
    await expect(page.locator("svg#board")).not.toHaveClass(/\bcolorblind\b/);
  });

  test("sea-zone hover and select work, with fleet move targets", async ({ page }) => {
    await openFixtureDemo(page);
    const pt = await pointOnShape(page, "bosphorus");
    await page.mouse.move(pt.x, pt.y);

    await expect(page.locator("#bosphorus")).toHaveClass(/\bis-hovered\b/);
    const tooltip = page.locator(".board-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator(".board-tooltip-name")).toHaveText("Bosphorus");
    await expect(tooltip.locator(".board-tooltip-sub")).toHaveText("sea zone");

    // Fixture: f-gen-1 holds the bosphorus; fleets move sea→sea only. Canon
    // targets are sea-of-marmara and black-sea-west, but only sea-of-marmara
    // is drawn in the fixture — data ids without shapes highlight nothing.
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#bosphorus")).toHaveClass(/\bis-selected\b/);
    await expect(page.locator("#sea-of-marmara")).toHaveClass(/\bis-move-target\b/);
    await expect(page.locator("#board-seas path.is-move-target")).toHaveCount(1);
    await expect(page.locator("#board-provinces path.is-move-target")).toHaveCount(0);
  });

  test("Escape and the dev select button drive the controlled selection", async ({
    page,
  }) => {
    await openFixtureDemo(page);
    await page.locator("[data-testid=select-constantinople]").click();
    await expect(page.locator("#constantinople")).toHaveClass(/\bis-selected\b/);

    // Escape is scoped to the board container: with focus still on the
    // aside's dev button, it must NOT clear the selection...
    await page.keyboard.press("Escape");
    await expect(page.locator("#constantinople")).toHaveClass(/\bis-selected\b/);

    // ...but with focus on a board shape (they are tabbable buttons), it does.
    await page.locator("#constantinople").focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".is-selected")).toHaveCount(0);
    await expect(page.locator(".is-move-target")).toHaveCount(0);
  });
});
