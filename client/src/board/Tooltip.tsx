import { useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { ResourceBundle } from "@imperium/shared";
import type { TooltipProps } from "./types";

const OFFSET = 14;
/** Flip to the other side of the cursor within this many px of a viewport edge. */
const FLIP_MARGIN = 180;

const RESOURCE_ORDER: ReadonlyArray<keyof ResourceBundle> = [
  "gold",
  "grain",
  "timber",
  "marble",
  "faith",
];

function yieldSummary(yields: ResourceBundle): string {
  return RESOURCE_ORDER.filter((key) => yields[key] !== 0)
    .map((key) => `${yields[key]} ${key}`)
    .join(" · ");
}

function titleCaseId(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function Tooltip(props: TooltipProps): JSX.Element | null {
  const { gameState, hoverStore } = props;
  const hover = useSyncExternalStore(hoverStore.subscribe, hoverStore.get);
  if (hover === null) return null;

  const flipX = hover.clientX > window.innerWidth - FLIP_MARGIN;
  const flipY = hover.clientY > window.innerHeight - FLIP_MARGIN;
  const transform =
    `${flipX ? "translateX(-100%)" : ""} ${flipY ? "translateY(-100%)" : ""}`.trim();
  const style: CSSProperties = {
    left: flipX ? hover.clientX - OFFSET : hover.clientX + OFFSET,
    top: flipY ? hover.clientY - OFFSET : hover.clientY + OFFSET,
    transform: transform === "" ? undefined : transform,
  };

  // Props-driven data only; an SVG-only region without gameState data still
  // gets a tooltip ("no data") — never throw.
  let name: string;
  let sub: string;
  let yields: string | null = null;
  const province =
    hover.kind === "province"
      ? gameState.provinces.find((p) => p.id === hover.id)
      : undefined;
  const seaZone =
    hover.kind === "sea"
      ? gameState.seaZones.find((s) => s.id === hover.id)
      : undefined;
  if (province) {
    name = province.name;
    sub = province.terrain.toLowerCase();
    const summary = yieldSummary(province.yields);
    yields = summary === "" ? null : summary;
  } else if (seaZone) {
    name = seaZone.name;
    sub = "sea zone";
  } else {
    name = titleCaseId(hover.id);
    sub = "no data";
  }

  return (
    <div className="board-tooltip" style={style} role="tooltip">
      <div className="board-tooltip-name">{name}</div>
      <div className="board-tooltip-sub">{sub}</div>
      {yields === null ? null : <div className="board-tooltip-yields">{yields}</div>}
    </div>
  );
}
