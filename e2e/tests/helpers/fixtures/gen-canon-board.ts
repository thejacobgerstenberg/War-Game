/**
 * Generator for canon-board-full.svg — the full canon-id board fixture used
 * by the game E2E helpers (e2e/tests/helpers/game.ts).
 *
 * The vendored client board art (client/src/board/assets/board.svg) still
 * carries the retired 53-region id scheme, so most canon provinces
 * (constantinople, selymbria, edirne, ...) have no clickable shape on the
 * real map. Until the canon-id art lands, game E2E mounts this schematic
 * grid through the GameBoard `?svgUrl=` test hook: every docs/MAP.md
 * province and sea zone becomes one non-overlapping cell (click-safe — no
 * concave paths or occluding decorations), ids straight from the engine's
 * canonical mapData.
 *
 * Regenerate after map changes:
 *   npx tsx --tsconfig server/tsconfig.json e2e/tests/helpers/fixtures/gen-canon-board.ts
 * (run from the repo root; @imperium/shared must be built).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { PROVINCES, SEA_ZONES } from "../../../../server/src/engine/mapData.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "canon-board-full.svg");

const CELL_W = 110, CELL_H = 64, GAP = 8, COLS = 8;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const cellPath = (x: number, y: number): string =>
  `M ${x} ${y} h ${CELL_W} v ${CELL_H} h ${-CELL_W} Z`;

let provPaths = "", provLabels = "";
PROVINCES.forEach((p, i) => {
  const x = GAP + (i % COLS) * (CELL_W + GAP);
  const y = GAP + Math.floor(i / COLS) * (CELL_H + GAP);
  provPaths += `    <path id="${p.id}" d="${cellPath(x, y)}" fill="#d8cdb4" stroke="#2B2118" stroke-width="1.5"/>\n`;
  provLabels += `    <text x="${x + 6}" y="${y + 20}" font-size="11" pointer-events="none" fill="#2B2118">${esc(p.name.split(" (")[0]).slice(0, 16)}</text>\n`;
});
const provRows = Math.ceil(PROVINCES.length / COLS);
const seaY0 = GAP + provRows * (CELL_H + GAP) + 24;
let seaPaths = "", seaLabels = "";
SEA_ZONES.forEach((s, i) => {
  const x = GAP + (i % COLS) * (CELL_W + GAP);
  const y = seaY0 + Math.floor(i / COLS) * (CELL_H + GAP);
  seaPaths += `    <path id="${s.id}" d="${cellPath(x, y)}" fill="#b8c8d8" stroke="#2B2118" stroke-width="1.5"/>\n`;
  seaLabels += `    <text x="${x + 6}" y="${y + 20}" font-size="11" pointer-events="none" fill="#1a2a3a">${esc(s.name).slice(0, 16)}</text>\n`;
});
const seaRows = Math.ceil(SEA_ZONES.length / COLS);
const W = GAP + COLS * (CELL_W + GAP);
const H = seaY0 + seaRows * (CELL_H + GAP) + GAP;

const svg = `<svg id="board" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <!-- GENERATED e2e fixture — do not hand-edit; see gen-canon-board.ts
       alongside this file. Full canon id scheme (docs/MAP.md): ${PROVINCES.length}
       provinces + ${SEA_ZONES.length} sea zones as a click-safe schematic grid. A TEST
       ASSET, not art: mounted via the GameBoard ?svgUrl= test hook because
       the vendored board.svg still uses the retired region id scheme. -->
  <rect x="0" y="0" width="${W}" height="${H}" fill="#efe7d3"/>
  <g id="board-seas">
${seaPaths}  </g>
  <g id="board-provinces">
${provPaths}  </g>
  <g id="board-labels" pointer-events="none">
${provLabels}${seaLabels}  </g>
</svg>
`;
writeFileSync(OUT, svg);
console.log(`wrote ${OUT}: ${PROVINCES.length} provinces, ${SEA_ZONES.length} seas, ${W}x${H}`);
