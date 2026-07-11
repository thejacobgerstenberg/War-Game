import { FACTION_COLOR, FACTION_SLUG } from "../types";
import type { SiegeMarkerProps } from "../types";

const BLOOD = "#7B241C";

export function SiegeMarker({ x, y, faction }: SiegeMarkerProps): JSX.Element {
  return (
    <g
      transform={`translate(${x} ${y})`}
      className="ov-siege"
      data-testid="ov-siege"
      aria-label={`under siege by ${FACTION_SLUG[faction]}`}
    >
      <circle r={30} fill="none" stroke={BLOOD} strokeWidth={4} strokeDasharray="10 6" />
      {/* Besieger pennant on the ring — faction is never conveyed by ring color alone. */}
      <circle cx={0} cy={-30} r={4.5} fill={FACTION_COLOR[faction]} stroke="#2B2118" strokeWidth={1.2} />
    </g>
  );
}
