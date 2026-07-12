/**
 * Offline "socket context" shim (spec §6). The real client has no socket
 * context — App.tsx wires the singleton socket by hand — so the offline
 * equivalent is this thin React context that hands in-game components the
 * local dispatcher (and the current viewer seat) without prop-drilling.
 */
import { createContext, useContext } from "react";
import type { OfflineDispatcher } from "./types";

export interface OfflineCtx {
  dispatcher: OfflineDispatcher;
  /** Seat id whose projection the UI is currently rendering. */
  viewerSeatId: string;
}

export const OfflineDispatcherContext = createContext<OfflineCtx | null>(null);

/** Throws outside the provider — in-game components must never run detached. */
export function useOfflineDispatcher(): OfflineCtx {
  const ctx = useContext(OfflineDispatcherContext);
  if (ctx === null) {
    throw new Error(
      "useOfflineDispatcher() must be used inside <OfflineDispatcherContext.Provider>",
    );
  }
  return ctx;
}
