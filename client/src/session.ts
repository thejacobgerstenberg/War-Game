/**
 * Session persistence for reconnects. The server issues a per-player
 * sessionToken in the `game_created` ack; storing it (plus roomCode and
 * playerId) in sessionStorage lets this tab reclaim its seat with
 * `rejoin_game` after a socket drop or page reload.
 */
export interface StoredSession {
  roomCode: string;
  playerId: string;
  sessionToken: string;
}

const KEY = "imperium.session";

export function saveSession(session: StoredSession): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable (private mode/quota): rejoin simply won't persist.
  }
}

export function loadSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StoredSession).roomCode === "string" &&
      typeof (parsed as StoredSession).playerId === "string" &&
      typeof (parsed as StoredSession).sessionToken === "string"
    ) {
      return parsed as StoredSession;
    }
  } catch {
    // Fall through: treat unreadable/corrupt entries as absent.
  }
  return null;
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Ignore: nothing to clear if storage is unavailable.
  }
}
