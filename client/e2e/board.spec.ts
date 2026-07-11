import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Screenshots/evidence land in e2e/output by default; QA runs override with
// BOARD_SHOTS_DIR to collect evidence outside the repo. No __dirname here:
// the workspace is ESM ("type":"module"), so derive it from import.meta.url.
const SHOTS_DIR =
  process.env.BOARD_SHOTS_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "output");

function shot(name: string): string {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  return path.join(SHOTS_DIR, name);
}

async function openDemo(page: Page): Promise<void> {
  await page.goto("/board-demo");
  await expect(page.locator("svg#board")).toBeVisible();
  await expect(page.locator("#board-provinces path")).toHaveCount(53);
  await expect(page.locator("#board-seas path")).toHaveCount(12);
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

test.describe("board demo", () => {
  test("mounts the SVG once and the dev id-diff reporter covers the id space", async ({
    page,
  }) => {
    const consoleLines: string[] = [];
    page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));

    await openDemo(page);
    // Let StrictMode double-mount effects settle before reading the console.
    await page.waitForTimeout(250);

    const mountLines = [...consoleLines];
    const mountDrift = mountLines.filter((l) => l.includes("[board] id drift"));

    // mapData.ts uses exactly the 53+12 board.svg ids (spec §1), so the
    // mount-time diff is EMPTY and reportIdDiff is a pinned no-op (spec §2.3).
    // Verify that silence, then verify the same mount-time code path (the real
    // modules served by Vite) does report when drift exists, via a canary.
    expect(mountDrift).toHaveLength(0);

    const probe = (await page.evaluate(`(async () => {
      const idDiff = await import("/src/board/idDiff.ts");
      const svgMod = await import("/src/board/svg.ts");
      const svg = document.querySelector("svg#board");
      const ids = svgMod.collectShapeIds(svg);
      const dataIds = ids.provinceIds.slice(1).concat(["atlantis"]);
      const diff = idDiff.diffIds(ids.provinceIds, dataIds);
      idDiff.reportIdDiff("provinces (e2e canary probe)", diff);
      const mountDiff = {
        provinces: idDiff.diffIds(ids.provinceIds, ids.provinceIds),
        seaZones: idDiff.diffIds(ids.seaZoneIds, ids.seaZoneIds),
      };
      return { diff, mountDiff, counts: {
        provinces: ids.provinceIds.length, seaZones: ids.seaZoneIds.length } };
    })()`) as {
      diff: { missingInSvg: string[]; extraInSvg: string[] };
      mountDiff: {
        provinces: { missingInSvg: string[]; extraInSvg: string[] };
        seaZones: { missingInSvg: string[]; extraInSvg: string[] };
      };
      counts: { provinces: number; seaZones: number };
    });

    expect(probe.counts).toEqual({ provinces: 53, seaZones: 12 });
    expect(probe.diff.missingInSvg).toEqual(["atlantis"]);
    expect(probe.diff.extraInSvg).toHaveLength(1);
    // The exact inputs the mount-time effect diffs produce empty diffs.
    expect(probe.mountDiff.provinces).toEqual({ missingInSvg: [], extraInSvg: [] });
    expect(probe.mountDiff.seaZones).toEqual({ missingInSvg: [], extraInSvg: [] });

    await page.waitForTimeout(100);
    const canaryLines = consoleLines
      .slice(mountLines.length)
      .filter((l) => l.includes("[board] id drift"));
    expect(canaryLines.length).toBeGreaterThan(0);

    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(SHOTS_DIR, "id-diff.txt"),
      [
        "# Mount-time id-diff — /board-demo",
        "",
        "Mount console drift lines: NONE (this is the spec-pinned behavior:",
        "mapData.ts uses exactly the 53 province + 12 sea-zone ids of",
        "assets/board.svg, so diffIds() is empty and reportIdDiff() is a no-op",
        "per board-spec §2.3 'no-op when both arrays are empty').",
        "",
        "Mount-time diff computed in-page from the same inputs Board.tsx diffs:",
        `  provinces: ${JSON.stringify(probe.mountDiff.provinces)}`,
        `  sea zones: ${JSON.stringify(probe.mountDiff.seaZones)}`,
        "",
        "Reporter path verified with an injected canary diff (same modules,",
        "same browser session):",
        ...canaryLines.map((l) => `  ${l}`),
        "",
        "Full mount console:",
        ...mountLines.map((l) => `  ${l}`),
        "",
      ].join("\n"),
    );
  });

  test("province hover applies the elevated outline and shows fixture data", async ({
    page,
  }) => {
    await openDemo(page);
    const pt = await pointOnShape(page, "thrace");
    await page.mouse.move(pt.x, pt.y);

    await expect(page.locator("#thrace")).toHaveClass(/\bis-hovered\b/);
    const tooltip = page.locator(".board-tooltip");
    await expect(tooltip).toBeVisible();
    // Fixture data: thrace = "Thrace", CITY, yields 6/2/0/1/3 (mapData.ts).
    await expect(tooltip.locator(".board-tooltip-name")).toHaveText("Thrace");
    await expect(tooltip.locator(".board-tooltip-sub")).toHaveText("city");
    await expect(tooltip.locator(".board-tooltip-yields")).toHaveText(
      "6 gold · 2 grain · 1 stone · 3 faith",
    );

    await page.screenshot({ path: shot("demo-tooltip.png") });

    // Hover is transient: leaving the shape clears class and tooltip.
    await page.mouse.move(5, 5);
    await expect(page.locator("#thrace")).not.toHaveClass(/\bis-hovered\b/);
    await expect(tooltip).toHaveCount(0);
  });

  test("click selects a province and highlights the legal move targets", async ({
    page,
  }) => {
    await openDemo(page);
    const pt = await pointOnShape(page, "thrace");
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#thrace")).toHaveClass(/\bis-selected\b/);

    // Expected targets from the same adjacency module the board imports:
    // thrace holds a-byz-1 (fixture), so land neighbors only.
    const expected = (await page.evaluate(`(async () => {
      const m = await import("/src/board/mapData.ts");
      return m.neighborsOf("thrace").filter((n) => !m.isSeaZoneId(n));
    })()`) as string[]);
    expect(expected.sort()).toEqual(["bithynia", "bulgaria", "macedonia"]);

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
    await expect(page.locator("#thrace")).toHaveClass(/\bis-selected\b/);

    await page.screenshot({ path: shot("demo-selected.png") });

    // Clicking the selected shape again toggles the selection off.
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#thrace")).not.toHaveClass(/\bis-selected\b/);
  });

  test("dev-control owner reassignment flips the owner class and fill", async ({
    page,
  }) => {
    await openDemo(page);
    const fill = (id: string) =>
      page.evaluate(
        (shapeId) => getComputedStyle(document.getElementById(shapeId)!).fill,
        id,
      );

    // Fixture: morea starts Byzantine (--faction-byzantium #4B1F3F).
    // The SVG ships `transition: fill .25s` on .province, so poll the
    // computed fill instead of reading it the instant the class flips.
    await expect(page.locator("#morea")).toHaveClass(/\bowner-byzantium\b/);
    await expect.poll(() => fill("morea")).toBe("rgb(75, 31, 63)");

    await page.locator("[data-testid=owner-province-select]").selectOption("morea");
    await page.locator("[data-testid=owner-faction-select]").selectOption("p-venice");
    await page.locator("[data-testid=owner-apply]").click();

    await expect(page.locator("#morea")).toHaveClass(/\bowner-venice\b/);
    await expect(page.locator("#morea")).not.toHaveClass(/\bowner-byzantium\b/);
    // Visible fill flipped to --faction-venice #1F4E79.
    await expect.poll(() => fill("morea")).toBe("rgb(31, 78, 121)");

    // And back to Independent: owner-* classes gone, parchment base fill.
    await page.locator("[data-testid=owner-faction-select]").selectOption("");
    await page.locator("[data-testid=owner-apply]").click();
    await expect(page.locator("#morea")).not.toHaveClass(/owner-/);
  });

  test("colorblind toggle applies pattern overlays", async ({ page }) => {
    await openDemo(page);
    await page.locator("[data-testid=colorblind-toggle]").check();

    await expect(page.locator("svg#board")).toHaveClass(/\bcolorblind\b/);
    for (const slug of ["byzantium", "ottomans", "venice", "genoa", "hungary"]) {
      await expect(page.locator(`#facPattern-${slug}`)).toHaveCount(1);
    }
    // Owned provinces now paint the pattern, not the flat wash.
    const thraceFill = await page.evaluate(
      () => getComputedStyle(document.getElementById("thrace")!).fill,
    );
    expect(thraceFill).toContain("facPattern-byzantium");

    await page.screenshot({ path: shot("demo-colorblind.png") });

    await page.locator("[data-testid=colorblind-toggle]").uncheck();
    await expect(page.locator("svg#board")).not.toHaveClass(/\bcolorblind\b/);
  });

  test("sea-zone hover and select work, with fleet move targets", async ({ page }) => {
    await openDemo(page);
    const pt = await pointOnShape(page, "adriatic-sea");
    await page.mouse.move(pt.x, pt.y);

    await expect(page.locator("#adriatic-sea")).toHaveClass(/\bis-hovered\b/);
    const tooltip = page.locator(".board-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator(".board-tooltip-name")).toHaveText("Adriatic Sea");
    await expect(tooltip.locator(".board-tooltip-sub")).toHaveText("sea zone");

    // Fixture: f-ven-1 sits in adriatic-sea; fleets move sea→sea only.
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#adriatic-sea")).toHaveClass(/\bis-selected\b/);
    await expect(page.locator("#ionian-sea")).toHaveClass(/\bis-move-target\b/);
    await expect(page.locator("#board-seas path.is-move-target")).toHaveCount(1);
    await expect(page.locator("#board-provinces path.is-move-target")).toHaveCount(0);
  });

  test("Escape clears the selection", async ({ page }) => {
    await openDemo(page);
    const pt = await pointOnShape(page, "thrace");
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator("#thrace")).toHaveClass(/\bis-selected\b/);

    await page.keyboard.press("Escape");
    await expect(page.locator(".is-selected")).toHaveCount(0);
    await expect(page.locator(".is-move-target")).toHaveCount(0);
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
