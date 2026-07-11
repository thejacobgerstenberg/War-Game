import { memo, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Army, Faction, Fleet } from "@imperium/shared";
import type { BoardOverlayState, OverlayLayerProps, Point } from "../types";
import { FleetBadge } from "./FleetBadge";
import { SiegeMarker } from "./SiegeMarker";
import { UnitBadge } from "./UnitBadge";
import { WallsMarker } from "./WallsMarker";

const SVG_NS = "http://www.w3.org/2000/svg";

interface OverlayItemsProps {
  centroids: ReadonlyMap<string, Point>;
  armies: readonly Army[];
  fleets: readonly Fleet[];
  overlays: BoardOverlayState | undefined;
  factionByPlayer: ReadonlyMap<string, Faction>;
  selection: string | null;
}

function groupByLocation<T extends { locationId: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.locationId);
    if (list) {
      list.push(item);
    } else {
      groups.set(item.locationId, [item]);
    }
  }
  return groups;
}

function unitCount(units: Record<string, number>): number {
  return Object.values(units).reduce((sum, n) => sum + n, 0);
}

/** The only overlay subtree that re-renders on game-state change; pan/zoom never touches it. */
const OverlayItems = memo(function OverlayItems({
  centroids,
  armies,
  fleets,
  overlays,
  factionByPlayer,
  selection,
}: OverlayItemsProps): JSX.Element {
  const nodes: JSX.Element[] = [];

  for (const [locationId, group] of groupByLocation(armies)) {
    const c = centroids.get(locationId);
    if (!c) continue; // missing SVG shape: render nothing, never throw
    const n = group.length;
    group.forEach((army, i) => {
      nodes.push(
        <UnitBadge
          key={army.id}
          x={c.x + 18 * i - 9 * (n - 1)}
          y={c.y}
          faction={factionByPlayer.get(army.ownerId) ?? null}
          count={unitCount(army.units)}
          selected={locationId === selection}
        />,
      );
    });
  }

  for (const [locationId, group] of groupByLocation(fleets)) {
    const c = centroids.get(locationId);
    if (!c) continue;
    const n = group.length;
    group.forEach((fleet, i) => {
      nodes.push(
        <FleetBadge
          key={fleet.id}
          x={c.x + 18 * i - 9 * (n - 1)}
          y={c.y}
          faction={factionByPlayer.get(fleet.ownerId) ?? null}
          count={unitCount(fleet.units)}
          selected={locationId === selection}
        />,
      );
    });
  }

  for (const siege of overlays?.sieges ?? []) {
    const c = centroids.get(siege.provinceId);
    if (!c) continue;
    nodes.push(
      <SiegeMarker key={`siege-${siege.provinceId}`} x={c.x} y={c.y} faction={siege.besiegerFaction} />,
    );
  }

  for (const [provinceId, tier] of Object.entries(overlays?.walls ?? {})) {
    const c = centroids.get(provinceId);
    if (!c) continue;
    nodes.push(<WallsMarker key={`walls-${provinceId}`} x={c.x} y={c.y - 26} tier={tier} />);
  }

  return <>{nodes}</>;
});

export function OverlayLayer({
  svgRoot,
  centroids,
  gameState,
  overlays,
  factionByPlayer,
  selection,
}: OverlayLayerProps): JSX.Element | null {
  const [group, setGroup] = useState<SVGGElement | null>(null);

  useLayoutEffect(() => {
    if (!svgRoot) {
      setGroup(null);
      return;
    }
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("id", "board-overlay-layer");
    // Overlays must never steal province hover/click or pan gestures.
    g.setAttribute("pointer-events", "none");
    svgRoot.appendChild(g);
    setGroup(g);
    return () => {
      g.remove();
    };
  }, [svgRoot]);

  if (!svgRoot || centroids.size === 0 || !group) {
    return null;
  }

  return createPortal(
    <OverlayItems
      centroids={centroids}
      armies={gameState.armies}
      fleets={gameState.fleets}
      overlays={overlays}
      factionByPlayer={factionByPlayer}
      selection={selection}
    />,
    group,
  );
}
