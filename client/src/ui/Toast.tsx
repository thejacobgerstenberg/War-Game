/**
 * Toast system — heralds' notices (design contract, mockups.css §10 +
 * README §2): rack fixed top-center, newest on top, AT MOST 3 visible;
 * informational toasts yield after ~5 seconds; ERRORS PERSIST until
 * dismissed. Variants: info (gold rule), error (crimson), triumph (laurel).
 *
 * Usage:
 *   const toast = useToast();
 *   toast.info("The pact is sealed.");
 *   toast.error("Not enough gold in the treasury.");
 *   toast.triumph("The city has fallen. Its keys are yours.");
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export type ToastKind = "info" | "error" | "triumph";

export interface ToastOptions {
  /** Auto-dismiss delay in ms for non-errors (default 5000). */
  durationMs?: number;
}

export interface ToastEntry {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface ToastApi {
  show: (kind: ToastKind, text: string, options?: ToastOptions) => void;
  info: (text: string, options?: ToastOptions) => void;
  error: (text: string) => void;
  triumph: (text: string, options?: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const MAX_VISIBLE = 3;
const DEFAULT_DURATION_MS = 5000;

/**
 * Breathing room between the game top bar and the rack: matches the
 * --space-2 (8px) gap of the gb-shell grid (styles/tokens.css).
 */
const RACK_CLEARANCE_PX = 8;

/**
 * README §2: the rack sits top-center, BELOW the phase track. On the game
 * screen the phase track lives inside the .gb-top header, so the rack must
 * clear the header's bottom edge — otherwise a persistent error toast
 * occludes the phase track and round counter. The header's height is
 * content-driven (and changes at the mobile breakpoint), so we measure it
 * instead of hardcoding an offset. Screens without a .gb-top (home, lobby)
 * return null and the CSS default top (--space-5, per mockups.css §10)
 * applies.
 */
function measureRackTop(): number | null {
  const topBar = document.querySelector(".gb-top");
  if (!topBar) return null;
  return Math.round(topBar.getBoundingClientRect().bottom) + RACK_CLEARANCE_PX;
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [rackTop, setRackTop] = useState<number | null>(null);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // While toasts are visible, keep the rack below the .gb-top header (see
  // measureRackTop). Layout effect so the first toast paints in the right
  // place; observers track header resize/appearance for persistent errors
  // that outlive a screen change. Idle when the rack is empty.
  const rackVisible = toasts.length > 0;
  useLayoutEffect(() => {
    if (!rackVisible) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const top = measureRackTop();
      setRackTop((prev) => (prev === top ? prev : top));
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", schedule);
    // Catches the top bar mounting/unmounting or growing (e.g. the phase
    // track wrapping at the mobile breakpoint) while a toast persists.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [rackVisible]);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (kind: ToastKind, text: string, options?: ToastOptions) => {
      const id = nextId.current++;
      setToasts((prev) => {
        // Newest on top; cap at MAX_VISIBLE by shedding the oldest
        // non-error first, then (only if all are errors) the oldest error.
        let next = [{ id, kind, text }, ...prev];
        while (next.length > MAX_VISIBLE) {
          const idxFromEnd = [...next].reverse().findIndex((t) => t.kind !== "error");
          const dropIdx = idxFromEnd === -1 ? next.length - 1 : next.length - 1 - idxFromEnd;
          const [dropped] = next.splice(dropIdx, 1);
          const timer = timers.current.get(dropped.id);
          if (timer !== undefined) {
            clearTimeout(timer);
            timers.current.delete(dropped.id);
          }
          next = [...next];
        }
        return next;
      });
      if (kind !== "error") {
        const timer = setTimeout(
          () => dismiss(id),
          options?.durationMs ?? DEFAULT_DURATION_MS,
        );
        timers.current.set(id, timer);
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      info: (text, options) => show("info", text, options),
      error: (text) => show("error", text),
      triumph: (text, options) => show("triumph", text, options),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          className="toast-rack"
          aria-live="polite"
          style={rackTop === null ? undefined : { top: rackTop }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast${t.kind === "error" ? " toast--error" : ""}${
                t.kind === "triumph" ? " toast--triumph" : ""
              }`}
              role={t.kind === "error" ? "alert" : "status"}
            >
              <span>{t.text}</span>
              <button
                type="button"
                className="toast-dismiss"
                aria-label="Draw the Curtain"
                title="Draw the Curtain"
                onClick={() => dismiss(t.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/** Access the toast rack. Must be rendered inside <ToastProvider>. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error("useToast must be used within <ToastProvider>");
  }
  return api;
}
