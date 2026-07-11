import { useEffect, useMemo, useState } from "react";
import type { BoardProps, Point } from "./types";
import { ownerClass } from "./types";
import { factionByPlayer, legalMoveTargets, provinceOwnerFaction } from "./mapData";
import { collectShapeIds } from "./svg";
import { computeCentroids } from "./centroids";
import { diffIds, reportIdDiff } from "./idDiff";
import { usePanZoom } from "./usePanZoom";
import { createHoverStore } from "./hoverStore";
import { ProvinceLayer } from "./ProvinceLayer";
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
  } = props;

  const [svgRoot, setSvgRoot] = useState<SVGSVGElement | null>(null);
  const hoverStore = useMemo(createHoverStore, []);
  const panZoom = usePanZoom();

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

  // Dev-only id drift report: data ids without SVG shapes render nothing;
  // reportIdDiff is a no-op outside import.meta.env.DEV and never throws.
  useEffect(() => {
    if (!svgRoot) return;
    const { provinceIds, seaZoneIds } = collectShapeIds(svgRoot);
    reportIdDiff(
      "provinces",
      diffIds(provinceIds, mapData.provinces.map((p) => p.id)),
    );
    reportIdDiff(
      "sea zones",
      diffIds(seaZoneIds, mapData.seaZones.map((s) => s.id)),
    );
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
      <div ref={panZoom.viewportRef} className="board-viewport">
        <div ref={panZoom.contentRef} className="board-content">
          <ProvinceLayer
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
