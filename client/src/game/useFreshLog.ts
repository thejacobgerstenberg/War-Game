/**
 * useFreshLogEntries — the client's confirmation channel.
 *
 * dispatch() is fire-and-forget (GameProvider): the server answers with a
 * state broadcast on success or action_rejected on failure. Success feedback
 * (triumph toasts, coin_purse / church_bell flourishes) must therefore be
 * keyed off the NEW chronicle entries in the next broadcast — never played
 * optimistically at dispatch time — or a rejected action would show a triumph
 * toast chased by a persistent error toast.
 *
 * This factors out the watcher GreatWorksModal's completion flourish uses:
 * on mount the current log tail is the baseline (nothing already chronicled
 * is reported); every time state.log grows, the handler receives the entries
 * appended since the last broadcast, in chronicle order. Entries the fog-of-war
 * projection hides from this player (data.visibleTo) simply never appear.
 */
import { useEffect, useRef } from "react";
import type { GameLogEntry } from "@imperium/shared";
import { useGame } from "./GameProvider";

export function useFreshLogEntries(
  onFresh: (entries: readonly GameLogEntry[]) => void,
): void {
  const { gameState } = useGame();
  // The handler lives in a ref so a new closure each render never re-arms
  // the effect; only a genuinely grown log fires it.
  const handler = useRef(onFresh);
  handler.current = onFresh;
  const lastSeen = useRef<string | null>(null);

  useEffect(() => {
    const log = gameState.log;
    const latest = log[log.length - 1] ?? null;
    if (lastSeen.current === null) {
      // First render: baseline at the current tail ("" when the log is empty,
      // so anything appended later counts as fresh).
      lastSeen.current = latest?.id ?? "";
      return;
    }
    const fresh: GameLogEntry[] = [];
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.id === lastSeen.current) break;
      fresh.push(e);
    }
    lastSeen.current = latest?.id ?? lastSeen.current;
    if (fresh.length > 0) handler.current(fresh.reverse());
  }, [gameState.log]);
}
