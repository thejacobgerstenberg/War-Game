import { useLayoutEffect, useRef, useState } from "react";

/**
 * On-map name-plate for the current selection (design contract, game.html
 * legend callout 7: "Selection also sets the ring-label name-plate — never
 * color alone"). Mirrors the mockup's `.province-select-ring .ring-label`:
 * gold plate, ink text + border, small-caps display face, hung just below
 * the selected shape. Rendered inside #board-overlay-layer, so it inherits
 * pointer-events:none and never steals hover/click from the shapes.
 *
 * Props are local to the overlays module (types.ts is architect-owned).
 */
interface SelectionLabelProps {
  /** Selected shape's centroid, in board.svg user space. */
  x: number;
  y: number;
  /** Display name (province/sea-zone name, or title-cased id fallback). */
  name: string;
}

const FONT_SIZE = 13;
const PLATE_HEIGHT = 19;
const PAD_X = 8;
/** Vertical drop below the centroid — clears unit badges (±16) and their selection ring. */
const DROP = 24;
/** Width guess per glyph until the real measurement lands (small-caps display face). */
const APPROX_CHAR_WIDTH = FONT_SIZE * 0.68;

export function SelectionLabel({ x, y, name }: SelectionLabelProps): JSX.Element {
  const textRef = useRef<SVGTextElement>(null);
  const [textWidth, setTextWidth] = useState<number | null>(null);

  // Size the plate to the rendered text. Runs on selection change only,
  // never per pan/zoom frame. getComputedTextLength is unavailable in
  // jsdom — keep the approximation on any failure, never throw.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el === null || typeof el.getComputedTextLength !== "function") return;
    try {
      const length = el.getComputedTextLength();
      if (Number.isFinite(length) && length > 0) setTextWidth(length);
    } catch {
      /* detached node or non-rendering environment: approximation stands */
    }
  }, [name]);

  const width = (textWidth ?? name.length * APPROX_CHAR_WIDTH) + PAD_X * 2;

  return (
    <g
      transform={`translate(${x} ${y + DROP})`}
      className="ov-selection-label"
      data-testid="ov-selection-label"
      aria-hidden="true"
    >
      <rect
        x={-width / 2}
        y={0}
        width={width}
        height={PLATE_HEIGHT}
        rx={3}
        fill="var(--gold, #c9a227)"
        stroke="var(--ink, #2b2118)"
        strokeWidth={1}
      />
      <text
        ref={textRef}
        x={0}
        y={PLATE_HEIGHT / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={FONT_SIZE}
        fill="var(--ink, #2b2118)"
      >
        {name}
      </text>
    </g>
  );
}
