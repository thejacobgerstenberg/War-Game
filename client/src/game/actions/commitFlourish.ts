/**
 * Shared latch for the commit flourish (design/mockups/README §2: "'So it is
 * written.' — order committed, triumph variant").
 *
 * dispatch() is fire-and-forget, so the triumph toast must wait for the state
 * broadcast whose chronicle carries the sealed order — never fire
 * optimistically at dispatch time (the server may still refuse). The trays
 * that seal RECRUIT / MOVE (ActionBar) and BUILD (BuildMenu) set this latch
 * at seal time; the watcher lives in ActionBar (mounted for the whole game
 * screen — BuildMenu closes on seal, so it cannot host its own), which
 * matches fresh log entries of mine and raises the toast.
 *
 * A module-level ref, not context: BuildMenu unmounts before the broadcast
 * lands, and the two writers + one reader do not warrant a provider.
 */
export const sealAwaiting: { current: boolean } = { current: false };
