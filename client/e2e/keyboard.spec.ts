/**
 * Keyboard access to the board (a11y-keyboard finding): every province and
 * sea-zone shape must be a real tab stop with an accessible name, Enter or
 * Space must toggle selection, Escape must clear it, and pan/zoom must have
 * keyboard equivalents — a keyboard-only player has to be able to make the
 * FIRST selection on the map, not just navigate after a mouse click.
 *
 * Runs against the vendored-SVG demo at /board-demo (same mount as
 * board.spec.ts).
 */
import { expect, test } from "@playwright/test";

test("keyboard alone can focus, select, and pan the board", async ({ page }) => {
  await page.goto("/board-demo");
  await expect(page.locator("svg#board")).toBeVisible();

  // Every shape is decorated as a focusable button.
  const shapes = page.locator("svg#board path[role='button'][tabindex='0']");
  await expect(shapes).toHaveCount(53 + 12); // vendored provinces + seas

  // Walk Tab from the top of the page until a shape has focus (demo controls
  // and the viewport region come first in the tab order).
  let focusedId = "";
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName.toLowerCase() ?? "", id: el?.id ?? "" };
    });
    if (info.tag === "path" && info.id !== "") {
      focusedId = info.id;
      break;
    }
  }
  expect(focusedId, "Tab never reached a board shape").not.toBe("");

  const focused = page.locator(`svg#board [id="${focusedId}"]`);
  await expect(focused).toHaveAttribute("aria-label", /.+/);
  await expect(focused).toHaveAttribute("aria-pressed", "false");

  // Enter selects; Escape clears; Space selects again.
  await page.keyboard.press("Enter");
  await expect(focused).toHaveAttribute("aria-pressed", "true");
  await expect(focused).toHaveClass(/\bis-selected\b/);

  await page.keyboard.press("Escape");
  await expect(focused).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".is-selected")).toHaveCount(0);

  await page.keyboard.press(" ");
  await expect(focused).toHaveAttribute("aria-pressed", "true");

  // Arrow keys pan (transform changes), "+" zooms in.
  const content = page.locator(".board-content");
  const before = await content.evaluate((el) => el.style.transform);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => content.evaluate((el) => el.style.transform))
    .not.toBe(before);

  await page.keyboard.press("+");
  await expect
    .poll(() => content.evaluate((el) => el.style.transform))
    .toContain("scale(1.25)");
});
