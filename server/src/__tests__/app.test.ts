/**
 * Regression tests for the createApp-owned reaper lifecycle. The original
 * defect: the ROOM_TTL sweep lived only in the entrypoint isMain block (whose
 * guard also never matched a relative argv[1]), so any in-process boot —
 * tests, the smoke script, embedding — never reaped empty rooms.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp } from "../index.js";

type App = ReturnType<typeof createApp>;

let app: App | null = null;

afterEach(async () => {
  if (app) {
    app.stopReaper();
    await new Promise<void>((resolve) => {
      app!.io.close(() => resolve());
    });
    app = null;
  }
  vi.useRealTimers();
});

describe("createApp-managed room reaper", () => {
  it("reaps empty rooms on a plain in-process boot (no entrypoint involved)", () => {
    // Fake Date + interval timers BEFORE createApp so the LobbyManager clock
    // and the sweep interval both run on virtual time.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    app = createApp({ roomTtlSeconds: 5, reapIntervalMs: 1000 });

    const { room, player } = app.lobby.createGame("Basil");
    app.lobby.markDisconnected(player.id); // room now has 0 connected players

    vi.advanceTimersByTime(4000); // sweeps ran, TTL not yet elapsed
    expect(app.lobby.getRoom(room.code)).toBeDefined();

    vi.advanceTimersByTime(2000); // past the 5s TTL
    expect(app.lobby.getRoom(room.code)).toBeUndefined();
    expect(app.lobby.roomCount).toBe(0);
  });

  it("never reaps rooms that still have a connected player", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    app = createApp({ roomTtlSeconds: 5, reapIntervalMs: 1000 });

    const { room } = app.lobby.createGame("Basil");
    vi.advanceTimersByTime(60_000);
    expect(app.lobby.getRoom(room.code)).toBeDefined();
  });

  it("stopReaper halts the sweep and startReaper resumes it", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    app = createApp({ roomTtlSeconds: 5, reapIntervalMs: 1000 });
    app.stopReaper();

    const { room, player } = app.lobby.createGame("Basil");
    app.lobby.markDisconnected(player.id);

    vi.advanceTimersByTime(60_000); // way past TTL, but no sweep is running
    expect(app.lobby.getRoom(room.code)).toBeDefined();

    app.startReaper();
    vi.advanceTimersByTime(1000); // first sweep after restart reaps it
    expect(app.lobby.getRoom(room.code)).toBeUndefined();
  });
});
