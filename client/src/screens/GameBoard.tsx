import { Faction, type GameState } from "@imperium/shared";

interface GameBoardProps {
  state: GameState;
}

const FACTION_COLORS: Record<Faction, string> = {
  [Faction.BYZANTIUM]: "#7c2d54",
  [Faction.OTTOMAN]: "#2f6b4f",
  [Faction.VENICE]: "#c9a227",
  [Faction.GENOA]: "#a23b2e",
  [Faction.HUNGARY]: "#26619c",
};

const NEUTRAL = "#8a7c60";

/** Points of a small hexagon centred at (cx, cy) with radius r. */
function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`);
  }
  return pts.join(" ");
}

export function GameBoard({ state }: GameBoardProps) {
  const factionOf = (ownerId: string | null): Faction | null => {
    if (!ownerId) return null;
    return state.players.find((p) => p.id === ownerId)?.faction ?? null;
  };

  return (
    <div
      style={{
        display: "flex",
        gap: "1rem",
        padding: "1rem",
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      <div className="imp-panel" style={{ flex: "1 1 auto", minWidth: 0 }}>
        <h3>Theatre of War · Turn {state.turn}</h3>
        <svg
          viewBox="0 0 100 100"
          style={{
            width: "100%",
            height: "auto",
            aspectRatio: "1 / 1",
            border: "1px solid rgba(201,162,39,0.35)",
            borderRadius: 6,
            background:
              "radial-gradient(circle at 60% 30%, #1c3a5e, #12233a 70%)",
          }}
        >
          {/* Sea zones */}
          {state.seaZones.map((sea) => (
            <g key={sea.id}>
              <circle
                cx={sea.position.x}
                cy={sea.position.y}
                r={7}
                fill="var(--imp-lapis)"
                opacity={0.35}
              />
              <text
                x={sea.position.x}
                y={sea.position.y}
                textAnchor="middle"
                fontSize={2.2}
                fill="#cfe0f2"
                fontStyle="italic"
              >
                {sea.name}
              </text>
            </g>
          ))}

          {/* Provinces */}
          {state.provinces.map((prov) => {
            const faction = factionOf(prov.ownerId);
            const fill = faction ? FACTION_COLORS[faction] : NEUTRAL;
            return (
              <g key={prov.id}>
                <polygon
                  points={hexPoints(prov.position.x, prov.position.y, 5)}
                  fill={fill}
                  stroke="var(--imp-gold)"
                  strokeWidth={0.4}
                />
                <text
                  x={prov.position.x}
                  y={prov.position.y + 8}
                  textAnchor="middle"
                  fontSize={2.2}
                  fill="var(--imp-parchment)"
                >
                  {prov.name}
                </text>
              </g>
            );
          })}
        </svg>
        <p className="imp-subtitle">
          Placeholder strategic map — full cartography arrives in a later phase.
        </p>
      </div>

      <aside
        className="imp-panel imp-col"
        style={{ flex: "0 0 260px", alignSelf: "flex-start" }}
      >
        <h3>Powers</h3>
        {state.players.map((p) => (
          <div
            key={p.id}
            className="imp-row"
            style={{ justifyContent: "space-between", width: "100%" }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  background: p.faction ? FACTION_COLORS[p.faction] : NEUTRAL,
                  display: "inline-block",
                }}
              />
              {p.name}
            </span>
            <span style={{ color: "var(--imp-gold-soft)" }}>{p.faction}</span>
          </div>
        ))}

        <h3 style={{ marginTop: "1rem" }}>Phase</h3>
        <div className="imp-subtitle">{state.phase}</div>

        <h3 style={{ marginTop: "1rem" }}>Treasury</h3>
        {state.players.map((p) => (
          <div key={p.id} style={{ fontSize: "0.85rem" }}>
            <strong>{p.name}:</strong> {p.treasury.gold}g · {p.treasury.grain}{" "}
            grain · {p.treasury.faith} faith
          </div>
        ))}
      </aside>
    </div>
  );
}
