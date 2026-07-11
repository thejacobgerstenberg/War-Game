import type { WallsMarkerProps } from "../types";

const INK = "#2B2118";
const PARCHMENT = "#F0E6D2";

export function WallsMarker({ x, y, tier }: WallsMarkerProps): JSX.Element {
  return (
    <g
      transform={`translate(${x} ${y})`}
      className="ov-walls"
      data-testid="ov-walls"
      aria-label={`walls tier ${tier}`}
    >
      <rect x={-13} y={-5} width={26} height={10} fill={PARCHMENT} stroke={INK} strokeWidth={1.5} />
      <rect x={-13} y={-9} width={5} height={4} fill={PARCHMENT} stroke={INK} strokeWidth={1.5} />
      <rect x={-2.5} y={-9} width={5} height={4} fill={PARCHMENT} stroke={INK} strokeWidth={1.5} />
      <rect x={8} y={-9} width={5} height={4} fill={PARCHMENT} stroke={INK} strokeWidth={1.5} />
      <text x={0} y={15} textAnchor="middle" fontSize={10} fontWeight="bold" fill={INK}>
        {`T${tier}`}
      </text>
    </g>
  );
}
