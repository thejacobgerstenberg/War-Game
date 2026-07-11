import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PanZoomApi, PanZoomOptions } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Pan/zoom over a viewport/content div pair. All gesture state lives in refs
 * and the transform is written straight to contentRef via rAF — zero React
 * state updates during frames (spec §3.1/§3.2).
 */
export function usePanZoom(options?: PanZoomOptions): PanZoomApi {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const draggedRef = useRef(false);
  const travelRef = useRef(0);
  const rafRef = useRef(0);

  // Listeners bind once but must read the latest clamp bounds. Synced in an
  // effect (not the render body) so a discarded concurrent render never
  // leaks its options into the live listeners.
  const minScale = options?.minScale ?? 1;
  const maxScale = options?.maxScale ?? 8;
  const boundsRef = useRef({ minScale, maxScale });
  useEffect(() => {
    boundsRef.current = { minScale, maxScale };
  }, [minScale, maxScale]);

  const scheduleWrite = useCallback(() => {
    if (rafRef.current !== 0) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = contentRef.current;
      if (!el) return;
      const { x, y, scale } = transformRef.current;
      el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const pointers = pointersRef.current;

    /** Zoom toward a client-space anchor, clamped; keeps the anchor fixed. */
    const applyZoom = (clientX: number, clientY: number, targetScale: number) => {
      const t = transformRef.current;
      const { minScale, maxScale } = boundsRef.current;
      const next = clamp(targetScale, minScale, maxScale);
      if (next === t.scale) return;
      const rect = viewport.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const ratio = next / t.scale;
      t.x = px - (px - t.x) * ratio;
      t.y = py - (py - t.y) * ratio;
      t.scale = next;
      scheduleWrite();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      applyZoom(e.clientX, e.clientY, transformRef.current.scale * factor);
    };

    // Keyboard pan/zoom (a11y finding: gestures were wheel/pointer-only).
    // Bound on the viewport, so it also catches keys bubbling up from the
    // focusable province shapes inside it. Modified keys are left alone
    // (browser zoom, tab switching, etc.).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = transformRef.current;
      const step = 60;
      switch (e.key) {
        case "ArrowLeft":
          t.x += step;
          break;
        case "ArrowRight":
          t.x -= step;
          break;
        case "ArrowUp":
          t.y += step;
          break;
        case "ArrowDown":
          t.y -= step;
          break;
        case "+":
        case "=":
        case "-":
        case "_": {
          const rect = viewport.getBoundingClientRect();
          const zoomIn = e.key === "+" || e.key === "=";
          e.preventDefault();
          applyZoom(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
            t.scale * (zoomIn ? 1.25 : 0.8),
          );
          return;
        }
        default:
          return;
      }
      e.preventDefault();
      scheduleWrite();
    };

    // Focusing an off-screen shape makes the browser scroll this
    // overflow-hidden viewport to reveal it, which would silently desync
    // the CSS transform. Fold that scroll into the pan instead, so
    // keyboard focus pans the map like everyone else.
    const onScroll = () => {
      const t = transformRef.current;
      if (viewport.scrollLeft === 0 && viewport.scrollTop === 0) return;
      t.x -= viewport.scrollLeft;
      t.y -= viewport.scrollTop;
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
      scheduleWrite();
    };

    // Capture only once a drag is real: capturing on pointerdown would
    // retarget the synthesized click to the viewport and break selection.
    const capturePointer = (pointerId: number) => {
      try {
        if (!viewport.hasPointerCapture(pointerId)) {
          viewport.setPointerCapture(pointerId);
        }
      } catch {
        // Pointer already ended — nothing to capture.
      }
    };

    // No preventDefault here: click synthesis must survive for selection.
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (pointers.size === 0) {
        draggedRef.current = false;
        travelRef.current = 0;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        draggedRef.current = true;
        for (const id of pointers.keys()) capturePointer(id);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const entry = pointers.get(e.pointerId);
      if (!entry) return;
      // Stale-entry recovery: capture is deferred until real drag travel, so
      // a press released where no listener saw the pointerup (fast flick out
      // of the viewport, alt-tab, release outside the window) leaves an
      // entry behind. A tracked pointer moving with no buttons down means
      // exactly that — end the phantom gesture instead of panning.
      if (e.buttons === 0) {
        endPointer(e.pointerId);
        return;
      }
      const prevX = entry.x;
      const prevY = entry.y;
      entry.x = e.clientX;
      entry.y = e.clientY;

      const t = transformRef.current;
      if (pointers.size === 1) {
        const dx = e.clientX - prevX;
        const dy = e.clientY - prevY;
        travelRef.current += Math.abs(dx) + Math.abs(dy);
        if (travelRef.current > 4) {
          draggedRef.current = true;
          capturePointer(e.pointerId);
        }
        t.x += dx;
        t.y += dy;
        scheduleWrite();
      } else if (pointers.size === 2) {
        draggedRef.current = true;
        let other: { x: number; y: number } | undefined;
        for (const [id, p] of pointers) {
          if (id !== e.pointerId) other = p;
        }
        if (!other) return;
        const prevDist = Math.hypot(prevX - other.x, prevY - other.y);
        const curDist = Math.hypot(entry.x - other.x, entry.y - other.y);
        const prevMidX = (prevX + other.x) / 2;
        const prevMidY = (prevY + other.y) / 2;
        const curMidX = (entry.x + other.x) / 2;
        const curMidY = (entry.y + other.y) / 2;
        if (prevDist > 0 && curDist > 0) {
          applyZoom(curMidX, curMidY, t.scale * (curDist / prevDist));
        }
        t.x += curMidX - prevMidX;
        t.y += curMidY - prevMidY;
        scheduleWrite();
      }
    };

    const endPointer = (pointerId: number) => {
      if (!pointers.delete(pointerId)) return;
      if (viewport.hasPointerCapture(pointerId)) {
        viewport.releasePointerCapture(pointerId);
      }
    };

    const onPointerEnd = (e: PointerEvent) => {
      endPointer(e.pointerId);
    };

    // Focus loss (alt-tab, devtools) can eat the pointerup entirely.
    const onWindowBlur = () => {
      for (const id of [...pointers.keys()]) endPointer(id);
    };

    // Native listeners: React synthetic wheel handlers are passive.
    // pointerup/pointercancel live on window: an uncaptured gesture (travel
    // ≤ 4px, capture deferred for click synthesis) can end outside the
    // viewport, and its pointerup never reaches viewport listeners.
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("keydown", onKeyDown);
    viewport.addEventListener("scroll", onScroll);
    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("blur", onWindowBlur);
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      pointers.clear();
    };
  }, [scheduleWrite]);

  const wasDragged = useCallback(() => draggedRef.current, []);

  const reset = useCallback(() => {
    transformRef.current = { x: 0, y: 0, scale: 1 };
    scheduleWrite();
  }, [scheduleWrite]);

  return useMemo(
    () => ({ viewportRef, contentRef, wasDragged, reset }),
    [wasDragged, reset],
  );
}
