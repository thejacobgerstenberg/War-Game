import type { HoverInfo, HoverStore } from "./types";

/**
 * Plain closure store: ProvinceLayer writes on native pointer events, the
 * Tooltip island subscribes via useSyncExternalStore. Hover never touches
 * Board's render cycle.
 */
export function createHoverStore(): HoverStore {
  let current: HoverInfo | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      if (next === current) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
