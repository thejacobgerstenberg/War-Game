/**
 * OverlayManager — decides which modal/overlay is open. Foundation-owned
 * ROUTING; the modal BODIES are feature-agent work (see the stubs in
 * game/modals/ and game/end/).
 *
 * Two sources, one winner (priority order):
 *   1. GAME STATE (auto overlays):
 *        state.winner            -> VictoryScreen
 *        state.pendingBattles[0] -> CombatModal        (mine first)
 *        live merc auction       -> MercAuctionModal   (selectors.isMercAuctionLive)
 *   2. LOCAL INTENTS via useOverlay().open(intent)  (game/types.ts OverlayIntent):
 *        build / greatWorks / market / diplomacy / spy
 *
 * Closing an auto overlay records its dismissal key (battle id / auction
 * round / victory) so it does not immediately reopen; a NEW battle or a new
 * round's auction gets a new key and opens again. Feature agents needing a
 * different policy change it HERE, not in the modal bodies.
 *
 * Combat policy (Area 4): an undismissed battle stays routed THROUGH its
 * resolution broadcast (snapshot of the last pending battle), so CombatModal
 * can play the dice cascade and result banner after the engine removes the
 * battle from state.pendingBattles. Closing it uses the same battle:<id> key.
 */
import { createContext, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PendingBattle } from "@imperium/shared";
import { useGame } from "./GameProvider";
import { isMercAuctionLive, nextPendingBattle } from "./selectors";
import type { OverlayIntent } from "./types";
import { CombatModal } from "./modals/CombatModal";
import { MercAuctionModal } from "./modals/MercAuctionModal";
import { MarketModal } from "./modals/MarketModal";
import { DiplomacyModal } from "./modals/DiplomacyModal";
import { SpyModal } from "./modals/SpyModal";
import { GreatWorksModal } from "./modals/GreatWorksModal";
import { BuildMenu } from "./actions/BuildMenu";
import { VictoryScreen } from "./end/VictoryScreen";

export interface OverlayContextValue {
  /** The locally-requested overlay, if any (auto overlays take precedence). */
  intent: OverlayIntent | null;
  /** Request an overlay (replaces any current intent). */
  open: (intent: OverlayIntent) => void;
  /** Close the visible overlay (auto overlays are remembered as dismissed). */
  close: () => void;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

export function OverlayProvider({ children }: { children: ReactNode }): JSX.Element {
  const [intent, setIntent] = useState<OverlayIntent | null>(null);
  // Dismissal keys of auto overlays the player has closed this session.
  const dismissed = useRef(new Set<string>());
  // Bump to re-render after a dismissal (the set is a ref).
  const [, setDismissTick] = useState(0);

  const { gameState, myPlayerId } = useGame();

  const pendingBattle = nextPendingBattle(gameState, myPlayerId);
  // COMBAT (Area 4) routing policy: a battle RESOLVES by vanishing from
  // state.pendingBattles in the same broadcast that appends its chronicle
  // entry — without a snapshot the CombatModal would unmount at the exact
  // moment it has the dice cascade + result banner to show. Keep the last
  // routed battle on screen after resolution until the player closes it
  // (same battle:<id> dismissal key); a NEW pending battle supersedes it.
  const lastBattleRef = useRef<PendingBattle | null>(null);
  if (pendingBattle) lastBattleRef.current = pendingBattle;
  const settled =
    !pendingBattle &&
    lastBattleRef.current &&
    !dismissed.current.has(`battle:${lastBattleRef.current.id}`)
      ? lastBattleRef.current
      : null;
  const battle = pendingBattle ?? settled;
  const auctionLive = isMercAuctionLive(gameState);

  const victoryKey = "victory";
  const battleKey = battle ? `battle:${battle.id}` : null;
  const auctionKey = `auction:r${gameState.round}`;

  type Active =
    | { kind: "victory" }
    | { kind: "battle" }
    | { kind: "auction" }
    | { kind: "intent"; intent: OverlayIntent }
    | null;

  const active: Active = (() => {
    if (gameState.winner !== undefined && !dismissed.current.has(victoryKey)) {
      return { kind: "victory" };
    }
    if (battle && battleKey && !dismissed.current.has(battleKey)) {
      return { kind: "battle" };
    }
    if (auctionLive && !dismissed.current.has(auctionKey)) {
      return { kind: "auction" };
    }
    if (intent) return { kind: "intent", intent };
    return null;
  })();

  const value = useMemo<OverlayContextValue>(
    () => ({
      intent,
      open: (next) => setIntent(next),
      close: () => {
        // Compute what is visible at close time and dismiss THAT.
        if (gameState.winner !== undefined && !dismissed.current.has(victoryKey)) {
          dismissed.current.add(victoryKey);
        } else if (battleKey && !dismissed.current.has(battleKey)) {
          dismissed.current.add(battleKey);
        } else if (auctionLive && !dismissed.current.has(auctionKey)) {
          dismissed.current.add(auctionKey);
        } else {
          setIntent(null);
          return;
        }
        setDismissTick((t) => t + 1);
      },
    }),
    [intent, gameState.winner, battleKey, auctionLive, auctionKey],
  );

  return (
    <OverlayContext.Provider value={value}>
      {children}
      {active?.kind === "victory" && gameState.winner !== undefined && (
        <VictoryScreen winner={gameState.winner} onClose={value.close} />
      )}
      {active?.kind === "battle" && battle && (
        <CombatModal battle={battle} onClose={value.close} />
      )}
      {active?.kind === "auction" && (
        <MercAuctionModal offers={gameState.mercMarket} onClose={value.close} />
      )}
      {active?.kind === "intent" && renderIntent(active.intent, value.close)}
    </OverlayContext.Provider>
  );
}

function renderIntent(intent: OverlayIntent, close: () => void): JSX.Element {
  switch (intent.type) {
    case "build":
      return <BuildMenu provinceId={intent.provinceId} onClose={close} />;
    case "greatWorks":
      return <GreatWorksModal provinceId={intent.provinceId} onClose={close} />;
    case "market":
      return <MarketModal onClose={close} />;
    case "diplomacy":
      return <DiplomacyModal targetPlayerId={intent.targetPlayerId} onClose={close} />;
    case "spy":
      return <SpyModal targetPlayerId={intent.targetPlayerId} onClose={close} />;
  }
}

/** Open/close overlays. Must be rendered inside <OverlayProvider>. */
export function useOverlay(): OverlayContextValue {
  const value = useContext(OverlayContext);
  if (!value) {
    throw new Error("useOverlay must be used within <OverlayProvider>");
  }
  return value;
}
