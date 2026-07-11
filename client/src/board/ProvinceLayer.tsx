import { useLayoutEffect, useRef } from "react";
import type { HoverInfo, LocationKind, ProvinceLayerProps } from "./types";
import { ensureFactionPatterns, loadBoardSvg, loadBoardSvgFromUrl } from "./svg";

interface ShapeHit {
  el: SVGPathElement;
  id: string;
  kind: LocationKind;
}

const SHAPE_SELECTOR = "#board-provinces path[id], #board-seas path[id]";

declare global {
  interface Window {
    /** Dev-only e2e perf probe: ProvinceLayer body execution count. */
    __provinceLayerRenders?: number;
  }
}

function shapeFromEvent(e: Event): ShapeHit | null {
  const target = e.target;
  if (!(target instanceof Element)) return null;
  const el = target.closest<SVGPathElement>("path.province, path.sea-zone");
  if (!el || el.id === "") return null;
  const kind: LocationKind = el.classList.contains("sea-zone") ? "sea" : "province";
  return { el, id: el.id, kind };
}

/**
 * Mounts the board SVG once (the vendored asset, or an alternate fetched
 * from `svgUrl`) and drives all province/sea-zone visual state imperatively
 * (direct class writes, native delegated listeners) so hover and pan/zoom
 * frames never enter React's render cycle.
 */
export function ProvinceLayer(props: ProvinceLayerProps): JSX.Element {
  // Render counter for the e2e perf assertion: pan/zoom/hover frames must
  // never re-execute this component body (spec §3.1). Dev builds only.
  if (import.meta.env.DEV && typeof window !== "undefined") {
    window.__provinceLayerRenders = (window.__provinceLayerRenders ?? 0) + 1;
  }

  const { svgUrl, ownerClassById, selection, moveTargets, colorblind } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Latest props for the once-attached native listeners.
  const propsRef = useRef(props);
  propsRef.current = props;

  /** Each shape's untouched SVG class string ("province", "province shaded", "sea-zone"). */
  const pristineRef = useRef(new Map<Element, string>());
  /** Last class string this layer computed per shape (hover token excluded). */
  const lastAppliedRef = useRef(new Map<Element, string>());
  const hoveredRef = useRef<ShapeHit | null>(null);
  const rafRef = useRef(0);
  const pendingPointRef = useRef<{ x: number; y: number } | null>(null);

  // Class sync: owner-* / is-selected / is-move-target for every shape.
  // Reads propsRef so it can also run right after an async SVG attach.
  // Writes only when the computed string changed; runs per state change,
  // never per frame. Data ids without an SVG shape simply never match — no-op.
  const syncClasses = (): void => {
    const svg = svgRef.current;
    if (svg === null) return;
    const current = propsRef.current;
    const targets = new Set(current.moveTargets);
    for (const el of svg.querySelectorAll<SVGPathElement>(SHAPE_SELECTOR)) {
      let pristine = pristineRef.current.get(el);
      if (pristine === undefined) {
        pristine = el.getAttribute("class") ?? "";
        pristineRef.current.set(el, pristine);
      }
      let next = pristine;
      const owner = current.ownerClassById.get(el.id);
      if (owner != null) next += ` ${owner}`;
      if (el.id === current.selection) next += " is-selected";
      if (targets.has(el.id)) next += " is-move-target";
      if (lastAppliedRef.current.get(el) === next) continue;
      lastAppliedRef.current.set(el, next);
      // is-hovered is owned by the pointer handlers; preserve a live token.
      el.setAttribute(
        "class",
        el.classList.contains("is-hovered") ? `${next} is-hovered` : next,
      );
    }
  };
  const syncClassesRef = useRef(syncClasses);
  syncClassesRef.current = syncClasses;

  // Mount: append the SVG (clone of the vendored template, or a fetched
  // svgUrl override), inject colorblind patterns, attach delegated pointer
  // listeners. StrictMode-safe (fresh clone per run; fetches are cached).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let cancelled = false;
    let detach: (() => void) | null = null;

    const attach = (svg: SVGSVGElement): void => {
      ensureFactionPatterns(svg);
      svgRef.current = svg;
      host.appendChild(svg);

      const setHover = (hit: ShapeHit | null, clientX: number, clientY: number) => {
        const prev = hoveredRef.current;
        if (prev !== null && prev.el !== hit?.el) prev.el.classList.remove("is-hovered");
        hoveredRef.current = hit;
        let info: HoverInfo | null = null;
        if (hit !== null) {
          hit.el.classList.add("is-hovered");
          info = { id: hit.id, kind: hit.kind, clientX, clientY };
        }
        propsRef.current.hoverStore.set(info);
        propsRef.current.onHoverChange?.(info);
      };

      const onPointerOver = (e: PointerEvent) => {
        const hit = shapeFromEvent(e);
        if (hit === null || hit.el === hoveredRef.current?.el) return;
        setHover(hit, e.clientX, e.clientY);
      };

      const onPointerOut = (e: PointerEvent) => {
        const hit = shapeFromEvent(e);
        if (hit === null || hit.el !== hoveredRef.current?.el) return;
        setHover(null, e.clientX, e.clientY);
      };

      // Tooltip tracking: rAF-throttled store writes; only the Tooltip island
      // subscribes, so this never re-renders Board.
      const onPointerMove = (e: PointerEvent) => {
        if (hoveredRef.current === null) return;
        pendingPointRef.current = { x: e.clientX, y: e.clientY };
        if (rafRef.current !== 0) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          const hovered = hoveredRef.current;
          const point = pendingPointRef.current;
          if (hovered === null || point === null) return;
          propsRef.current.hoverStore.set({
            id: hovered.id,
            kind: hovered.kind,
            clientX: point.x,
            clientY: point.y,
          });
        });
      };

      const onClick = (e: MouseEvent) => {
        // A pan gesture just ended — the synthesized click is not a selection.
        if (propsRef.current.shouldIgnoreClick()) return;
        const hit = shapeFromEvent(e);
        if (hit === null) {
          propsRef.current.onSelect(null);
          return;
        }
        propsRef.current.onSelect(hit.id === propsRef.current.selection ? null : hit.id);
      };

      svg.addEventListener("pointerover", onPointerOver);
      svg.addEventListener("pointerout", onPointerOut);
      svg.addEventListener("pointermove", onPointerMove);
      svg.addEventListener("click", onClick);

      // The class-sync/colorblind effects may have already run against a
      // null svg (async fetch path) — bring the fresh mount up to date.
      syncClassesRef.current();
      svg.classList.toggle("colorblind", propsRef.current.colorblind);

      propsRef.current.onSvgReady(svg);

      detach = () => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        hoveredRef.current = null;
        pendingPointRef.current = null;
        propsRef.current.hoverStore.set(null);
        pristineRef.current.clear();
        lastAppliedRef.current.clear();
        svg.remove();
        svgRef.current = null;
        propsRef.current.onSvgReady(null);
      };
    };

    if (svgUrl === undefined) {
      attach(loadBoardSvg());
    } else {
      loadBoardSvgFromUrl(svgUrl)
        .then((svg) => {
          if (!cancelled) attach(svg);
        })
        .catch((err: unknown) => {
          // A broken override must not take the page down; the board area
          // stays empty and the failure is visible in the console.
          console.error(`[board] failed to load board SVG from "${svgUrl}"`, err);
        });
    }

    return () => {
      cancelled = true;
      detach?.();
    };
  }, [svgUrl]);

  useLayoutEffect(syncClasses, [ownerClassById, selection, moveTargets]);

  useLayoutEffect(() => {
    svgRef.current?.classList.toggle("colorblind", colorblind);
  }, [colorblind]);

  return <div className="board-svg-host" ref={hostRef} />;
}
