/**
 * Hotseat handover gate (spec §6 / §4.7). Full-viewport OPAQUE panel rendered
 * INSTEAD of the board (OfflineApp unmounts GameBoard on screen "handover"),
 * so the incoming player sees nothing of the outgoing player's projection.
 * Shows only "Pass the device to <name>." + the confirm button; OfflineApp
 * calls dispatcher.setViewerSeat(...) on confirm and only then re-mounts the
 * board with the new seat's projection.
 */
import type { Faction } from "@imperium/shared";

interface PrivacyScreenProps {
  nextPlayerName: string;
  nextFaction: Faction | null;
  onConfirm: () => void;
}

function factionLabel(faction: Faction): string {
  return faction.charAt(0) + faction.slice(1).toLowerCase();
}

export function PrivacyScreen({
  nextPlayerName,
  nextFaction,
  onConfirm,
}: PrivacyScreenProps) {
  return (
    <div className="offline-privacy">
      <h1>
        Pass the device to {nextPlayerName}
        {nextFaction ? ` of ${factionLabel(nextFaction)}` : ""}.
      </h1>
      <button onClick={onConfirm}>I am {nextPlayerName}</button>
    </div>
  );
}
