/**
 * Dev-only harness for the interactive board, served at /board-demo.
 * All dev controls live here — the Board itself stays a controlled component.
 * Never imports ../socket or anything from screens/ (no socket connect).
 */
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Board } from "./Board";
import { BOARD_MAP, legalMoveTargets } from "./mapData";
import { createDemoState } from "./fixtures/demoState";
import type { DemoSetup } from "./types";

const rowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  marginBottom: "1rem",
};

export function DemoPage(): JSX.Element {
  const [demo, setDemo] = useState<DemoSetup>(createDemoState);
  const [selection, setSelection] = useState<string | null>(null);
  const [colorblind, setColorblind] = useState(false);

  const [ownerProvince, setOwnerProvince] = useState<string>(
    BOARD_MAP.provinces[0]?.id ?? "",
  );
  const [ownerPlayer, setOwnerPlayer] = useState<string>("");
  const [armyId, setArmyId] = useState<string>(
    () => demo.gameState.armies[0]?.id ?? "",
  );
  const [armyDest, setArmyDest] = useState<string>("");

  const selectedArmy = demo.gameState.armies.find((a) => a.id === armyId);
  const destOptions = useMemo(
    () =>
      selectedArmy ? legalMoveTargets(demo.gameState, selectedArmy.locationId) : [],
    [demo.gameState, selectedArmy],
  );
  // Keep the controlled dest valid when the army or the board changes.
  const dest = destOptions.includes(armyDest) ? armyDest : (destOptions[0] ?? "");

  function applyOwner(): void {
    setDemo((prev) => ({
      ...prev,
      gameState: {
        ...prev.gameState,
        provinces: prev.gameState.provinces.map((p) =>
          p.id === ownerProvince
            ? { ...p, ownerId: ownerPlayer === "" ? null : ownerPlayer }
            : p,
        ),
      },
    }));
  }

  function moveArmy(): void {
    if (!selectedArmy || dest === "") return;
    setDemo((prev) => ({
      ...prev,
      gameState: {
        ...prev.gameState,
        armies: prev.gameState.armies.map((a) =>
          a.id === armyId ? { ...a, locationId: dest } : a,
        ),
      },
    }));
  }

  function resetDemo(): void {
    setDemo(createDemoState());
    setSelection(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "row", height: "100vh" }}>
      <div style={{ flex: "1 1 auto", minWidth: 0, height: "100vh" }}>
        <Board
          mapData={BOARD_MAP}
          gameState={demo.gameState}
          overlays={demo.overlays}
          selection={selection}
          onSelect={setSelection}
          colorblind={colorblind}
          className="demo-board"
        />
      </div>
      <aside
        className="imp-panel"
        style={{
          width: "280px",
          flex: "0 0 280px",
          height: "100vh",
          overflowY: "auto",
          padding: "1rem",
          boxSizing: "border-box",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Board demo</h2>

        <div style={rowStyle}>
          <strong>Reassign owner</strong>
          <select
            data-testid="owner-province-select"
            value={ownerProvince}
            onChange={(e) => setOwnerProvince(e.target.value)}
          >
            {BOARD_MAP.provinces.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
          <select
            data-testid="owner-faction-select"
            value={ownerPlayer}
            onChange={(e) => setOwnerPlayer(e.target.value)}
          >
            <option value="">Independent</option>
            {demo.gameState.players.map((pl) => (
              <option key={pl.id} value={pl.id}>
                {pl.id}
              </option>
            ))}
          </select>
          <button data-testid="owner-apply" onClick={applyOwner}>
            Apply owner
          </button>
        </div>

        <div style={rowStyle}>
          <strong>Move army</strong>
          <select
            data-testid="army-select"
            value={armyId}
            onChange={(e) => setArmyId(e.target.value)}
          >
            {demo.gameState.armies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id} @ {a.locationId}
              </option>
            ))}
          </select>
          <select
            data-testid="army-dest-select"
            value={dest}
            onChange={(e) => setArmyDest(e.target.value)}
          >
            {destOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button data-testid="army-move" onClick={moveArmy}>
            Move army
          </button>
        </div>

        <div style={rowStyle}>
          <label>
            <input
              type="checkbox"
              data-testid="colorblind-toggle"
              checked={colorblind}
              onChange={(e) => setColorblind(e.target.checked)}
            />{" "}
            Colorblind mode
          </label>
        </div>

        <div style={rowStyle}>
          <button data-testid="select-thrace" onClick={() => setSelection("thrace")}>
            Select Thrace
          </button>
          <div>
            Selection: <code>{selection ?? "none"}</code>
          </div>
        </div>

        <div style={rowStyle}>
          <button data-testid="reset-demo" onClick={resetDemo}>
            Reset demo
          </button>
        </div>
      </aside>
    </div>
  );
}
