import { useEffect, useId, useMemo, useState } from "react";
import type { BoardProps, Point } from "./types";
import { ownerClass } from "./types";
import { factionByPlayer, legalMoveTargets, provinceOwnerFaction } from "./mapData";
import { collectShapeIds } from "./svg";
import { computeCentroids } from "./centroids";
import { diffIds, reportIdDiff } from "./idDiff";
import { usePanZoom } from "./usePanZoom";
import { createHoverStore } from "./hoverStore";
import { ProvinceLayer, SHAPE_SELECTOR } from "./ProvinceLayer";
import { Tooltip } from "./Tooltip";
import { OverlayLayer } from "./overlays/OverlayLayer";
import "./board.css";

export function Board(props: BoardProps): JSX.Element {
  const {
    mapData,
    gameState,
    selection,
    onSelect,
    onHoverChange,
    colorblind,
    className,
    overlays,
    svgUrl,
    onIdDiff,
  } = props;

  const [svgRoot, setSvgRoot] = useState<SVGSVGElement | null>(null);
  const hoverStore = useMemo(createHoverStore, []);
  const panZoom = usePanZoom();
  const keyboardHintId = useId();

  // Memo deps below are pinned by spec §3.3 (narrower than gameState itself
  // so pan/zoom-irrelevant state changes don't recompute derived maps).
  const byPlayer = useMemo(
    () => factionByPlayer(gameState),
    [gameState.players],
  );

  const ownerFaction = useMemo(
    () => provinceOwnerFaction(gameState),
    [gameState.provinces, gameState.players],
  );

  const ownerClassById = useMemo(() => {
    const byId = new Map<string, string | null>();
    for (const [id, faction] of ownerFaction) {
      byId.set(id, faction === null ? null : ownerClass(faction));
    }
    return byId;
  }, [ownerFaction]);

  const moveTargets = useMemo(
    () => (selection === null ? [] : legalMoveTargets(gameState, selection)),
    [selection, gameState.armies, gameState.fleets],
  );

  const centroids = useMemo(
    () => (svgRoot ? computeCentroids(svgRoot) : new Map<string, Point>()),
    [svgRoot],
  );

  // Id drift diff: data ids without SVG shapes render nothing. The console
  // report (reportIdDiff) is a no-op outside import.meta.env.DEV and never
  // throws; onIdDiff additionally hands the diff to the parent (the demo
  // page surfaces the counts so an SVG swap is verifiable at a glance).
  useEffect(() => {
    if (!svgRoot) return;
    const { provinceIds, seaZoneIds } = collectShapeIds(svgRoot);
    const provinces = diffIds(provinceIds, mapData.provinces.map((p) => p.id));
    const seaZones = diffIds(seaZoneIds, mapData.seaZones.map((s) => s.id));
    reportIdDiff("provinces", provinces);
    reportIdDiff("sea zones", seaZones);
    onIdDiff?.({ provinces, seaZones });
  }, [svgRoot, mapData, onIdDiff]);

  // Accessible names: ProvinceLayer makes each shape a focusable button with
  // the raw id as a fallback label; here the canon display names from mapData
  // replace them (unknown/retired ids keep the id so they're still announced).
  useEffect(() => {
    if (!svgRoot) return;
    const nameById = new Map<string, string>();
    for (const p of mapData.provinces) nameById.set(p.id, p.name);
    for (const s of mapData.seaZones) nameById.set(s.id, s.name);
    for (const el of svgRoot.querySelectorAll<SVGPathElement>(SHAPE_SELECTOR)) {
      const name = nameById.get(el.id);
      if (name !== undefined) el.setAttribute("aria-label", name);
    }
  }, [svgRoot, mapData]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selection !== null) onSelect(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, onSelect]);

  return (
    <div className={`board-root${className ? ` ${className}` : ""}`}>
      {/* Keyboard contract (finding: board was mouse-only). The viewport is a
          tab stop so pan/zoom works before any shape has focus; the hint is
          read by screen readers via aria-describedby. Label per the locked
          mockup (design/mockups/game.html: aria-label="The campaign map"). */}
      <p id={keyboardHintId} className="board-kbd-hint">
        Arrow keys move the map; plus and minus draw it nearer or farther. Tab
        moves among provinces and seas; Enter or Space selects one; Escape
        clears the selection.
      </p>
      <div
        ref={panZoom.viewportRef}
        className="board-viewport"
        tabIndex={0}
        role="region"
        aria-label="The campaign map"
        aria-describedby={keyboardHintId}
      >
        <div ref={panZoom.contentRef} className="board-content">
          <ProvinceLayer
            svgUrl={svgUrl}
            ownerClassById={ownerClassById}
            selection={selection}
            moveTargets={moveTargets}
            colorblind={colorblind ?? false}
            hoverStore={hoverStore}
            onSvgReady={setSvgRoot}
            onSelect={onSelect}
            onHoverChange={onHoverChange}
            shouldIgnoreClick={panZoom.wasDragged}
          />
          <OverlayLayer
            svgRoot={svgRoot}
            centroids={centroids}
            gameState={gameState}
            overlays={overlays}
            factionByPlayer={byPlayer}
            selection={selection}
          />
        </div>
      </div>
      <Tooltip gameState={gameState} hoverStore={hoverStore} />
    </div>
  );
}
