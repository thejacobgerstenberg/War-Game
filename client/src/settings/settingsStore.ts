/**
 * UI settings store — "The Scribe's Aids" (design/mockups/README.md §3).
 *
 * A tiny framework-free external store (useSyncExternalStore-shaped) for the
 * colorblind toggle, persisted at localStorage "imperium.settings.v1" and
 * applied app-wide by stamping the `colorblind` class on <body>:
 *
 *   - base.css §"Faction swatch" hatches every `[data-faction]` swatch under
 *     a `.colorblind` ancestor (pattern chips app-wide);
 *   - the board's own `colorblind` prop (Board → ProvinceLayer, which
 *     hatches provinces with the facPattern-* defs) is wired from this store
 *     in GameBoard's BoardMount.
 *
 * The rule, absolute (README §3): color is never the only channel.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "imperium.settings.v1";

export interface UiSettings {
  /** "The Scribe's Aids" — heraldic pattern overlays atop faction hues. */
  colorblind: boolean;
}

function load(): UiSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return { colorblind: (parsed as Partial<UiSettings>).colorblind === true };
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return { colorblind: false };
}

let settings: UiSettings =
  typeof window === "undefined" ? { colorblind: false } : load();

const listeners = new Set<() => void>();

/** Stamp the app-wide pattern channel (base.css `.colorblind` rules). */
function applyBodyClass(): void {
  if (typeof document === "undefined") return;
  document.body.classList.toggle("colorblind", settings.colorblind);
}

// Apply the persisted choice as soon as the store is loaded, so the lobby
// screens are hatched too, not just the game board.
applyBodyClass();

export function getUiSettings(): UiSettings {
  return settings;
}

export function subscribeUiSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setColorblind(colorblind: boolean): void {
  if (settings.colorblind === colorblind) return;
  settings = { ...settings, colorblind };
  applyBodyClass();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable — the choice still holds for this sitting */
  }
  for (const l of listeners) l();
}

/** React binding for the UI settings store. */
export function useUiSettings(): UiSettings {
  return useSyncExternalStore(subscribeUiSettings, getUiSettings, getUiSettings);
}
