import { Faction } from "@imperium/shared";
import { FACTION_SLUG, factionPatternId } from "./types";
import boardSvgRaw from "./assets/board.svg?raw";

const SVG_NS = "http://www.w3.org/2000/svg";

function parseTemplate(): SVGSVGElement {
  const doc = new DOMParser().parseFromString(boardSvgRaw, "image/svg+xml");
  // A vendored build asset failing to parse is a programming error.
  if (doc.querySelector("parsererror")) {
    throw new Error("board.svg failed to parse as image/svg+xml");
  }
  return doc.documentElement as unknown as SVGSVGElement;
}

// Parsed once at module scope; every caller gets a deep clone (React 18
// StrictMode double-mounts, and two Board instances must not share a node).
const TEMPLATE = parseTemplate();

export function loadBoardSvg(): SVGSVGElement {
  const svg = TEMPLATE.cloneNode(true) as SVGSVGElement;
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.display = "block";
  return svg;
}

/** Province/sea-zone path ids in document order. */
export function collectShapeIds(svg: SVGSVGElement): {
  provinceIds: string[];
  seaZoneIds: string[];
} {
  const ids = (selector: string): string[] =>
    Array.from(svg.querySelectorAll<SVGPathElement>(selector)).map((el) => el.id);
  return {
    provinceIds: ids("#board-provinces path[id]"),
    seaZoneIds: ids("#board-seas path[id]"),
  };
}

type Attrs = Record<string, string>;

function make(doc: Document, name: string, attrs: Attrs): Element {
  const el = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

const INK = "#2B2118";
const MOTIF_STROKE: Attrs = {
  fill: "none",
  stroke: INK,
  "stroke-width": "1.2",
  opacity: ".8",
};

/** Ink motif per faction slug so faction is never color alone (UI_DESIGN §7). */
function motifNodes(doc: Document, slug: string): Element[] {
  switch (slug) {
    case "byzantium": // crosshatch
      return [
        make(doc, "path", { d: "M0,0 L12,12", ...MOTIF_STROKE }),
        make(doc, "path", { d: "M12,0 L0,12", ...MOTIF_STROKE }),
      ];
    case "ottomans": // crescent-dot
      return [
        make(doc, "circle", { cx: "6", cy: "6", r: "2.5", ...MOTIF_STROKE }),
        make(doc, "circle", { cx: "9", cy: "3", r: "1", fill: INK, opacity: ".8" }),
      ];
    case "venice": // wave
      return [make(doc, "path", { d: "M0,6 Q3,2 6,6 T12,6", ...MOTIF_STROKE })];
    case "genoa": // check
      return [
        make(doc, "rect", { x: "0", y: "0", width: "6", height: "6", fill: INK, opacity: ".35" }),
        make(doc, "rect", { x: "6", y: "6", width: "6", height: "6", fill: INK, opacity: ".35" }),
      ];
    default: // hungary: stripe
      return [
        make(doc, "path", { d: "M-2,8 L8,-2", ...MOTIF_STROKE }),
        make(doc, "path", { d: "M4,14 L14,4", ...MOTIF_STROKE }),
      ];
  }
}

/**
 * Inject the five facPattern-* colorblind patterns into the svg's <defs>.
 * art/patterns/ does not exist on any branch, so the inline fallback is
 * always used. Idempotent — safe to call on every mount.
 */
export function ensureFactionPatterns(svg: SVGSVGElement): void {
  if (svg.querySelector("#facPattern-byzantium")) return;
  const doc = svg.ownerDocument;
  let defs: Element | null = svg.querySelector("defs");
  if (!defs) {
    defs = make(doc, "defs", {});
    svg.appendChild(defs);
  }
  for (const faction of Object.values(Faction)) {
    const slug = FACTION_SLUG[faction];
    const pattern = make(doc, "pattern", {
      id: factionPatternId(faction),
      patternUnits: "userSpaceOnUse",
      width: "12",
      height: "12",
    });
    // Tile background carries the faction color, motif carries the texture.
    pattern.appendChild(
      make(doc, "rect", { width: "12", height: "12", fill: `var(--faction-${slug})` }),
    );
    for (const node of motifNodes(doc, slug)) pattern.appendChild(node);
    defs.appendChild(pattern);
  }
}
