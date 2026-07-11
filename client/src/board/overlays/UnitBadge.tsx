import { FACTION_COLOR } from "../types";
import type { UnitBadgeProps } from "../types";

const INK = "#2B2118";
const NEUTRAL_FILL = "#8a7c60";

export function UnitBadge({ x, y, faction, count, selected }: UnitBadgeProps): JSX.Element {
  const fill = faction !== null ? FACTION_COLOR[faction] : NEUTRAL_FILL;
  return (
    <g
      transform={`translate(${x} ${y})`}
      className="ov-army"
      data-testid="ov-army"
      aria-label={`army: ${count} unit${count === 1 ? "" : "s"}`}
    >
      {selected ? (
        <rect x={-14} y={-16} width={28} height={32} rx={6} fill="none" stroke="#c9a227" strokeWidth={2.5} />
      ) : null}
      <rect x={-11} y={-13} width={22} height={26} rx={4} fill={fill} stroke={INK} strokeWidth={2} />
      <text x={0} y={4.5} textAnchor="middle" fontSize={13} fontWeight="bold" fill="#F0E6D2">
        {count}
      </text>
    </g>
  );
}
