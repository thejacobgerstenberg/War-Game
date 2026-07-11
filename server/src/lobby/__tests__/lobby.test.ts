import { describe, it, expect, beforeEach } from "vitest";
import { Faction } from "@imperium/shared";
import { LobbyManager, LobbyError } from "../lobbyManager.js";

describe("LobbyManager", () => {
  let lobby: LobbyManager;

  beforeEach(() => {
    lobby = new LobbyManager();
  });

  it("creates a game with a 6-char uppercase room code and a host", () => {
    const { room, player } = lobby.createGame("Basil");
    expect(room.code).toHaveLength(6);
    expect(room.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(player.isHost).toBe(true);
    expect(player.name).toBe("Basil");
    expect(room.players).toHaveLength(1);
  });

  it("rejects creating a game without a name", () => {
    expect(() => lobby.createGame("   ")).toThrow(LobbyError);
  });

  it("adds a player on join", () => {
    const { room } = lobby.createGame("Basil");
    const { player } = lobby.joinGame(room.code, "Murad");
    expect(player.isHost).toBe(false);
    expect(lobby.getRoom(room.code)!.players).toHaveLength(2);
  });

  it("joins case-insensitively by room code", () => {
    const { room } = lobby.createGame("Basil");
    const joined = lobby.joinGame(room.code.toLowerCase(), "Murad");
    expect(joined.room.code).toBe(room.code);
  });

  it("throws when joining a non-existent room", () => {
    expect(() => lobby.joinGame("ZZZZZZ", "Nobody")).toThrow(LobbyError);
  });

  it("lets a player pick an open faction", () => {
    const { room, player } = lobby.createGame("Basil");
    lobby.pickFaction(room.code, player.id, Faction.BYZANTIUM);
    expect(lobby.getRoom(room.code)!.players[0].faction).toBe(
      Faction.BYZANTIUM,
    );
  });

  it("rejects a faction already taken by another player", () => {
    const { room, player: host } = lobby.createGame("Basil");
    const { player: guest } = lobby.joinGame(room.code, "Murad");

    lobby.pickFaction(room.code, host.id, Faction.BYZANTIUM);
    expect(() =>
      lobby.pickFaction(room.code, guest.id, Faction.BYZANTIUM),
    ).toThrow(/already been chosen/i);
  });

  it("allows a player to re-select their own faction", () => {
    const { room, player } = lobby.createGame("Basil");
    lobby.pickFaction(room.code, player.id, Faction.BYZANTIUM);
    // Re-picking the same faction must not throw.
    expect(() =>
      lobby.pickFaction(room.code, player.id, Faction.BYZANTIUM),
    ).not.toThrow();
  });

  it("requires the host to start the game", () => {
    const { room, player: host } = lobby.createGame("Basil");
    const { player: guest } = lobby.joinGame(room.code, "Murad");
    lobby.pickFaction(room.code, host.id, Faction.BYZANTIUM);
    lobby.pickFaction(room.code, guest.id, Faction.OTTOMAN);

    expect(() => lobby.startGame(room.code, guest.id)).toThrow(
      /only the host/i,
    );
  });

  it("requires at least two players to start", () => {
    const { room, player } = lobby.createGame("Basil");
    expect(() => lobby.startGame(room.code, player.id)).toThrow(
      /at least 2/i,
    );
  });

  it("starts a valid game and produces initial state", () => {
    const { room, player: host } = lobby.createGame("Basil");
    const { player: guest } = lobby.joinGame(room.code, "Murad");
    lobby.pickFaction(room.code, host.id, Faction.BYZANTIUM);
    lobby.pickFaction(room.code, guest.id, Faction.OTTOMAN);

    const { state } = lobby.startGame(room.code, host.id);
    expect(state.players).toHaveLength(2);
    expect(state.roomCode).toBe(room.code);
    expect(lobby.getRoom(room.code)!.startedByHost).toBe(true);
    // The chronicle is seeded with the opening entry.
    expect(state.log).toHaveLength(1);
    expect(state.log[0].type).toBe("game_start");
  });

  it("reassigns host and drops empty rooms on leave", () => {
    const { room, player: host } = lobby.createGame("Basil");
    const { player: guest } = lobby.joinGame(room.code, "Murad");

    lobby.leaveGame(room.code, host.id);
    // Host left -> guest is promoted.
    expect(lobby.getRoom(room.code)!.players[0].id).toBe(guest.id);
    expect(lobby.getRoom(room.code)!.players[0].isHost).toBe(true);

    lobby.leaveGame(room.code, guest.id);
    // Room is now empty and removed.
    expect(lobby.getRoom(room.code)).toBeUndefined();
  });

  it("supports reconnect by player id", () => {
    const { room, player } = lobby.createGame("Basil");
    lobby.markDisconnected(player.id);
    expect(lobby.getRoom(room.code)!.players[0].connected).toBe(false);

    const rec = lobby.reconnect(player.id);
    expect(rec).not.toBeNull();
    expect(rec!.player.connected).toBe(true);
  });

  it("projects a room into a lobby_update payload", () => {
    const { room, player } = lobby.createGame("Basil");
    lobby.pickFaction(room.code, player.id, Faction.VENICE);
    const payload = LobbyManager.toLobbyUpdate(lobby.getRoom(room.code)!);
    expect(payload.roomCode).toBe(room.code);
    expect(payload.players[0]).toEqual({
      id: player.id,
      name: "Basil",
      faction: Faction.VENICE,
      isHost: true,
    });
    expect(payload.startedByHost).toBe(false);
  });
});
