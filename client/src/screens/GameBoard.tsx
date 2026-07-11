/**
 * GameBoard — the in-game campaign screen (design/mockups/game.html).
 * FOUNDATION-OWNED SHELL: the CSS-grid app shell (top bar / left rail / map
 * / right rail / action bar), the real <Board> mount, and the overlay slots.
 * Every region is a feature-agent component (stubs today) — feature agents
 * fill their component bodies and DO NOT edit this shell; slot/layout
 * changes go through the foundation.
 *
 * Shell (one viewport tall, nothing scrolls but designated inner regions):
 *   "top  top  top"     TopBar (round, era, phase track, breath-timer)
 *   "left map  right"   ResourcePanel | Board+overlays | ProvinceInspector
 *   "bar  bar  bar"     ActionBar (the eight orders + deed pips)
 * Map overlay slots: event toast (top-right), advisor (bottom-left),
 * chronicle drawer (right edge), tactic tray (bottom-center).
 * Modals route through game/OverlayManager.
 *
 * Contexts (already provided): useGame (GameProvider is mounted by App),
 * SelectionProvider + OverlayProvider are mounted HERE.
 */
import { useMemo } from "react";
import type { Faction } from "@imperium/shared";
import { Board } from "../board/Board";
import type { BoardOverlayState } from "../board/types";
import { BOARD_MAP } from "../board/mapData";
import { useGame } from "../game/GameProvider";
import { SelectionProvider, useSelection } from "../game/SelectionContext";
import { OverlayProvider } from "../game/OverlayManager";
import { TopBar } from "../game/hud/TopBar";
import { ResourcePanel } from "../game/hud/ResourcePanel";
import { ProvinceInspector } from "../game/inspect/ProvinceInspector";
import { ActionBar } from "../game/actions/ActionBar";
import { EventCardReveal } from "../game/cards/EventCardReveal";
import { TacticHandTray } from "../game/cards/TacticHandTray";
import { GameLogDrawer } from "../game/log/GameLogDrawer";
import { AdvisorBubble } from "../game/advisor/AdvisorBubble";
/* AUDIO-A11Y AGENT integration (see HANDOFF-audio-a11y-findings.md): the
   Steward's Chamber door + the Scribe's Aids store that feeds the Board's
   colorblind prop. Only these imports and the two marked lines below. */
import { SettingsPanel } from "../settings/SettingsPanel";
import { useUiSettings } from "../settings/settingsStore";
import "../styles/gameBoard.css";

export function GameBoard(): JSX.Element {
  return (
    <SelectionProvider>
      <OverlayProvider>
        <GameBoardShell />
      </OverlayProvider>
    </SelectionProvider>
  );
}

function GameBoardShell(): JSX.Element {
  return (
    <div className="gb-shell theme-night">
      <h1 className="visually-hidden">The Campaign Board</h1>
      <TopBar />

      <aside className="gb-side gb-left">
        <ResourcePanel />
      </aside>

      <main className="gb-map" aria-label="The campaign map">
        <BoardMount />
        <div className="gb-slot gb-slot-event">
          <EventCardReveal />
        </div>
        <div className="gb-slot gb-slot-drawer">
          <GameLogDrawer />
        </div>
        <div className="gb-slot gb-slot-advisor">
          {/* TODO(advisor agent): drive the line from game state/tutorial. */}
          <AdvisorBubble line={null} />
        </div>
        <div className="gb-slot gb-slot-tray">
          <TacticHandTray />
        </div>
        {/* AUDIO-A11Y AGENT: settings door (self-positioned, top-left). */}
        <SettingsPanel />
      </main>

      <aside className="gb-side gb-right">
        <ProvinceInspector />
      </aside>

      <ActionBar />
    </div>
  );
}

/** The real interactive board, wired to the selection context. */
function BoardMount(): JSX.Element {
  const { gameState } = useGame();
  const { selection, setSelection, setHover } = useSelection();
  // AUDIO-A11Y AGENT: the Scribe's Aids toggle drives the board hatching.
  const { colorblind } = useUiSettings();

  // Board-local overlay state (sieges + wall tiers) from the shared state.
  const overlays = useMemo<BoardOverlayState>(() => {
    const factionByPlayerId = new Map<string, Faction>();
    for (const p of gameState.players) {
      if (p.faction !== null) factionByPlayerId.set(p.id, p.faction);
    }
    const sieges = gameState.siegeStates.flatMap((siege) => {
      const besiegerFaction = factionByPlayerId.get(siege.besiegerId);
      return besiegerFaction !== undefined
        ? [{ provinceId: siege.provinceId, besiegerFaction }]
        : [];
    });
    const walls: Record<string, number> = {};
    for (const province of gameState.provinces) {
      if (province.walls.tier > 0) walls[province.id] = province.walls.tier;
    }
    return { sieges, walls };
  }, [gameState.siegeStates, gameState.provinces, gameState.players]);

  return (
    <Board
      mapData={BOARD_MAP}
      gameState={gameState}
      selection={selection}
      onSelect={setSelection}
      onHoverChange={setHover}
      overlays={overlays}
      colorblind={colorblind} // AUDIO-A11Y AGENT: Scribe's Aids wiring
    />
  );
}
