import { FACTION_COLOR } from "../types";
import type { FleetBadgeProps } from "../types";

const INK = "#2B2118";
const NEUTRAL_FILL = "#8a7c60";
const PARCHMENT = "#F0E6D2";

export function FleetBadge({ x, y, faction, count, selected }: FleetBadgeProps): JSX.Element {
  const fill = faction !== null ? FACTION_COLOR[faction] : NEUTRAL_FILL;
  return (
    <g
      transform={`translate(${x} ${y})`}
      className="ov-fleet"
      data-testid="ov-fleet"
      aria-label={`fleet: ${count} ship${count === 1 ? "" : "s"}`}
    >
      {selected ? <circle r={16} fill="none" stroke="#c9a227" strokeWidth={2.5} /> : null}
      <circle r={13} fill={fill} stroke={INK} strokeWidth={2} />
      <path d="M-7,1 L7,1 L4,5 L-4,5 Z" fill={PARCHMENT} stroke={INK} strokeWidth={1} />
      <path d="M0,-8 L6,0 L0,0 Z" fill={PARCHMENT} stroke={INK} strokeWidth={1} />
      <circle cx={9} cy={-9} r={6} fill={INK} stroke={PARCHMENT} strokeWidth={1} />
      <text x={9} y={-5.5} textAnchor="middle" fontSize={9} fontWeight="bold" fill={PARCHMENT}>
        {count}
      </text>
    </g>
  );
}
