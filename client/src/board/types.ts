/**
 * Shared type foundation for the interactive board (client/src/board/**).
 *
 * ARCHITECT-OWNED — no board author may edit this file. Every cross-module
 * interface lives here so the six parallel modules type-check together.
 * Game-engine types come from @imperium/shared and are never redefined.
 */
import { Faction } from "@imperium/shared";
import type { GameState, ResourceBundle, TerrainType } from "@imperium/shared";
import type { RefObject } from "react";

/** A point in board.svg user space (viewBox "0 0 1600 1000"). */
export interface Point {
  x: number;
  y: number;
}

export type LocationKind = "province" | "sea";

/** Static per-region display data, keyed by board.svg path ids (NOT MAP.md canon ids). */
export interface BoardProvince {
  id: string;
  name: string;
  terrain: TerrainType;
  yields: ResourceBundle;
  coastal: boolean;
}

export interface BoardSeaZone {
  id: string;
  name: string;
}

/** Symmetric neighbour graph over board.svg province + sea-zone ids. */
export type Adjacency = Readonly<Record<string, readonly string[]>>;

export interface BoardMapData {
  provinces: readonly BoardProvince[];
  seaZones: readonly BoardSeaZone[];
  adjacency: Adjacency;
}

/** Board-local overlay state that the shared GameState cannot express yet. */
export interface BoardOverlayState {
  sieges: ReadonlyArray<{ provinceId: string; besiegerFaction: Faction }>;
  /** Wall tier per province id; only fortified provinces are present. */
  walls: Readonly<Record<string, number>>;
}

export interface HoverInfo {
  id: string;
  kind: LocationKind;
  /** Viewport (client) coordinates, for fixed-position tooltip placement. */
  clientX: number;
  clientY: number;
}

/**
 * Minimal external store: ProvinceLayer writes, Tooltip subscribes via
 * useSyncExternalStore. Keeps hover updates out of Board's render cycle.
 */
export interface HoverStore {
  get(): HoverInfo | null;
  set(next: HoverInfo | null): void;
  subscribe(listener: () => void): () => void;
}

export interface IdDiff {
  missingInSvg: string[];
  extraInSvg: string[];
}

export interface BoardProps {
  mapData: BoardMapData;
  gameState: GameState;
  /** Selected province/sea-zone id — fully controlled by the parent. */
  selection: string | null;
  onSelect: (id: string | null) => void;
  onHoverChange?: (hover: HoverInfo | null) => void;
  colorblind?: boolean;
  className?: string;
  overlays?: BoardOverlayState;
}

export interface PanZoomOptions {
  /** Clamp bounds for scale. Defaults: min 1, max 8. */
  minScale?: number;
  maxScale?: number;
}

export interface PanZoomApi {
  /** Attach to the overflow-hidden outer element; gesture listeners bind here. */
  viewportRef: RefObject<HTMLDivElement>;
  /** Attach to the transformed inner element (transform-origin must be 0 0). */
  contentRef: RefObject<HTMLDivElement>;
  /** True when the pointer gesture that just ended moved > 4px (suppresses click-select). */
  wasDragged: () => boolean;
  /** Reset transform to identity. */
  reset: () => void;
}

export interface ProvinceLayerProps {
  /** province id -> "owner-<slug>" class, or null for unowned. */
  ownerClassById: ReadonlyMap<string, string | null>;
  selection: string | null;
  moveTargets: readonly string[];
  colorblind: boolean;
  hoverStore: HoverStore;
  /** Fired once after the SVG is appended to the DOM (StrictMode-safe). */
  onSvgReady: (svg: SVGSVGElement | null) => void;
  onSelect: (id: string | null) => void;
  onHoverChange?: (hover: HoverInfo | null) => void;
  /** Query pan/zoom drag state; when true, the click after pointerup is ignored. */
  shouldIgnoreClick: () => boolean;
}

export interface TooltipProps {
  gameState: GameState;
  hoverStore: HoverStore;
}

export interface OverlayLayerProps {
  /** The mounted board SVG, or null before ProvinceLayer reports ready. */
  svgRoot: SVGSVGElement | null;
  /** board.svg user-space centroids keyed by province/sea-zone id. */
  centroids: ReadonlyMap<string, Point>;
  gameState: GameState;
  overlays?: BoardOverlayState;
  /** player id -> faction, precomputed by Board. */
  factionByPlayer: ReadonlyMap<string, Faction>;
  selection: string | null;
}

export interface UnitBadgeProps {
  x: number;
  y: number;
  faction: Faction | null;
  /** Total units in the army. */
  count: number;
  selected?: boolean;
}

export interface FleetBadgeProps {
  x: number;
  y: number;
  faction: Faction | null;
  count: number;
  selected?: boolean;
}

export interface SiegeMarkerProps {
  x: number;
  y: number;
  faction: Faction;
}

export interface WallsMarkerProps {
  x: number;
  y: number;
  tier: number;
}

/** Fixture bundle returned by fixtures/demoState.ts. */
export interface DemoSetup {
  gameState: GameState;
  overlays: BoardOverlayState;
}

/**
 * Faction -> slug used by BOTH the owner-* CSS classes and the
 * facPattern-* pattern ids. NOTE plural "ottomans" — this is the PR #6
 * board.svg contract and intentionally differs from Faction.OTTOMAN.
 */
export const FACTION_SLUG: Record<Faction, string> = {
  [Faction.BYZANTIUM]: "byzantium",
  [Faction.OTTOMAN]: "ottomans",
  [Faction.VENICE]: "venice",
  [Faction.GENOA]: "genoa",
  [Faction.HUNGARY]: "hungary",
};

export function ownerClass(faction: Faction): string {
  return `owner-${FACTION_SLUG[faction]}`;
}

export function factionPatternId(faction: Faction): string {
  return `facPattern-${FACTION_SLUG[faction]}`;
}

/** Faction fill colors as defined on svg#board (kept for HTML UI chips only). */
export const FACTION_COLOR: Record<Faction, string> = {
  [Faction.BYZANTIUM]: "#4B1F3F",
  [Faction.OTTOMAN]: "#7A1F2B",
  [Faction.VENICE]: "#1F4E79",
  [Faction.GENOA]: "#C9A227",
  [Faction.HUNGARY]: "#4A5D3A",
};
