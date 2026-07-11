/**
 * Ops-contract tests for LobbyManager (deploy/OPERATIONS.md):
 * the ROOM_TTL_SECONDS empty-room reaper (§2) driven by an injected clock,
 * and shutdown mode refusing new rooms (§3 step 1).
 */
import { describe, it, expect } from "vitest";
import { LobbyManager, LobbyError } from "../lobbyManager.js";

const TTL_SECONDS = 3600;

/** A LobbyManager on a fake, manually-advanced clock. */
function makeLobby() {
  let nowMs = 1_000_000;
  const lobby = new LobbyManager({ now: () => nowMs });
  return {
    lobby,
    advanceSeconds: (s: number) => {
      nowMs += s * 1000;
    },
  };
}

describe("LobbyManager empty-room reaper", () => {
  it("never reaps a room that has a connected player", () => {
    const { lobby, advanceSeconds } = makeLobby();
    const { room } = lobby.createGame("Basil");

    advanceSeconds(TTL_SECONDS * 10);
    expect(lobby.reapEmptyRooms(TTL_SECONDS)).toEqual([]);
    expect(lobby.getRoom(room.code)).toBeDefined();
  });

  it("does not reap an emptied room before the TTL elapses", () => {
    const { lobby, advanceSeconds } = makeLobby();
    const { room, player } = lobby.createGame("Basil");
    lobby.markDisconnected(player.id); // room now has 0 connected players

    advanceSeconds(TTL_SECONDS - 1);
    expect(lobby.reapEmptyRooms(TTL_SECONDS)).toEqual([]);
    expect(lobby.getRoom(room.code)).toBeDefined();
  });

  it("reaps a room that has been empty for the full TTL", () => {
    const { lobby, advanceSeconds } = makeLobby();
    const { room, player } = lobby.createGame("Basil");
    lobby.markDisconnected(player.id);

    advanceSeconds(TTL_SECONDS + 1);
    expect(lobby.reapEmptyRooms(TTL_SECONDS)).toEqual([room.code]);
    expect(lobby.getRoom(room.code)).toBeUndefined();
    expect(lobby.roomCount).toBe(0);
  });

  it("a reconnect resets the empty clock", () => {
    const { lobby, advanceSeconds } = makeLobby();
    const { room, player } = lobby.createGame("Basil");
    lobby.markDisconnected(player.id);

    advanceSeconds(TTL_SECONDS - 10);
    lobby.reconnect(player.id); // room is live again
    advanceSeconds(20); // would be past the original deadline
    expect(lobby.reapEmptyRooms(TTL_SECONDS)).toEqual([]);
    expect(lobby.getRoom(room.code)).toBeDefined();

    // Disconnecting again restarts the TTL from scratch.
    lobby.markDisconnected(player.id);
    advanceSeconds(TTL_SECONDS - 1);
    expect(lobby.reapEmptyRooms(TTL_SECONDS)).toEqual([]);
    advanceSeconds(1);
    expect(lobby.reapEmptyRooms(TTL_SECONDS)).toEqual([room.code]);
  });

  it("only reaps rooms whose own TTL has elapsed", () => {
    const { lobby, advanceSeconds } = makeLobby();
    const { room: oldRoom, player: p1 } = lobby.createGame("Basil");
    lobby.markDisconnected(p1.id);

    advanceSeconds(TTL_SECONDS / 2);
    const { room: newRoom, player: p2 } = lobby.createGame("Murad");
    lobby.markDisconnected(p2.id);

    advanceSeconds(TTL_SECONDS / 2);
    expect(lobby.reapEmptyRooms(TTL_SECONDS)).toEqual([oldRoom.code]);
    expect(lobby.getRoom(newRoom.code)).toBeDefined();
  });
});

describe("LobbyManager shutdown mode", () => {
  it("is not shutting down by default", () => {
    const lobby = new LobbyManager();
    expect(lobby.isShuttingDown).toBe(false);
  });

  it("refuses create_game once shutdown begins", () => {
    const lobby = new LobbyManager();
    lobby.beginShutdown();
    expect(lobby.isShuttingDown).toBe(true);
    expect(() => lobby.createGame("Basil")).toThrow(LobbyError);
    expect(() => lobby.createGame("Basil")).toThrow(/restarting/i);
  });

  it("existing rooms keep playing during shutdown", () => {
    const lobby = new LobbyManager();
    const { room, player: host } = lobby.createGame("Basil");
    lobby.beginShutdown();

    // Joining and starting an existing room still works — only new rooms
    // are refused (OPERATIONS.md §3: "Existing rooms keep playing").
    const { player: guest } = lobby.joinGame(room.code, "Murad");
    expect(guest.id).toBeTruthy();
    const { state } = lobby.startGame(room.code, host.id);
    expect(state.players).toHaveLength(2);
  });
});
