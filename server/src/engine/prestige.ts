/**
 * prestige.ts — prestige scoring and victory checks (§13).
 *
 * Owns §13: the per-round prestige accrual scored at Cleanup/END (capitals, key
 * cities, trade monopoly), one-time achievement awards (secret objectives,
 * decisive battles, won wars), the −3 lose-capital penalty, the Constantinople
 * sudden-death tracker, and the victory threshold / round-16 endgame checks.
 * Every number is read from balance.PRESTIGE_VALUES / PRESTIGE_THRESHOLDS. Pure.
 *
 * Coordination (to avoid double-counting §13.1 sources already awarded by a
 * sibling subsystem within the same END cleanup — see the final report):
 *  - Great-work completion prestige (+5..+10) is awarded once by
 *    economy.completeGreatWork at build time; scorePrestige does NOT re-award it.
 *  - Betrayal penalties (−2..−4) are applied by diplomacy.applyDiplomacy at the
 *    moment of renunciation; scorePrestige does NOT re-apply them.
 *  - Vassal (+1/round) and royal-marriage (+2/round) prestige are awarded by
 *    diplomacy.runRevolts (which roundLoop runs immediately after scorePrestige
 *    in the same END phase); scorePrestige does NOT re-award them.
 * scorePrestige owns only the sources no other subsystem accrues.
 */
import type { Faction, GameState, Player } from "@imperium/shared";
import { PRESTIGE_THRESHOLDS, PRESTIGE_VALUES, ROUNDS } from "./balance.js";
import { appendLog } from "./logEntry.js";
import { neighborsOf } from "./adjacency.js";

/** The City whose capture arms the §13.3 sudden-death clock. */
const CONSTANTINOPLE_ID = "constantinople";

/** §13.3 sudden death: a foreign power holding the City through two cleanups. */
const SUDDEN_DEATH_ROUNDS = 2;

function clone(state: GameState): GameState {
  return structuredClone(state) as GameState;
}

function playerById(state: GameState, id: string | null | undefined): Player | undefined {
  if (!id) return undefined;
  return state.players.find((p) => p.id === id);
}

function playerByFaction(state: GameState, faction: Faction | null | undefined): Player | undefined {
  if (!faction) return undefined;
  return state.players.find((p) => p.faction === faction);
}

/** Count of high-value ("key city") provinces a player controls (§13.3 tiebreak). */
function keyCityCount(state: GameState, playerId: string): number {
  return state.provinces.filter(
    (p) => p.ownerId === playerId && (p.highValue ?? 0) > 0,
  ).length;
}

/**
 * §13.1 trade monopoly: control most ports of a sea (a strict majority of the
 * owned coastal provinces bordering a sea zone), or a card-posted explicit
 * 'trade_monopoly' modifier. The "both ends of a major route" clause is not
 * computable without route/port-tier data on Province (see NEEDS-FROM-INTEGRATOR).
 */
function hasTradeMonopoly(state: GameState, playerId: string): boolean {
  // Explicit hook: a card/economy-posted trade-monopoly modifier for this player.
  const byModifier = state.activeModifiers.some(
    (m) =>
      m.kind === "trade_monopoly" &&
      (m.data?.playerId === playerId ||
        (m.target?.faction != null &&
          playerByFaction(state, m.target.faction)?.id === playerId)),
  );
  if (byModifier) return true;

  // Sea majority: strict majority of a sea's owned coastal ports.
  for (const zone of state.seaZones) {
    const portOwners: string[] = [];
    for (const neighbourId of neighborsOf(zone.id)) {
      const prov = state.provinces.find((p) => p.id === neighbourId);
      if (prov && prov.coastal && prov.ownerId) portOwners.push(prov.ownerId);
    }
    if (portOwners.length < 2) continue; // a single port is not a monopoly
    const mine = portOwners.filter((o) => o === playerId).length;
    if (mine * 2 > portOwners.length) return true; // strict majority
  }
  return false;
}

// ---------------------------------------------------------------------------
// scorePrestige — per-round accrual at Cleanup/END (§13.1)
// ---------------------------------------------------------------------------

/**
 * Accrue per-round prestige for every player at cleanup (§13.1) and record a
 * prestige_change log entry per player. Also updates the Constantinople
 * sudden-death tracker (§13.3). Does not itself declare a winner. Pure.
 */
export function scorePrestige(state: GameState): GameState {
  let next = clone(state);

  // Per-player, per-source breakdown for the chronicle line.
  const breakdown: Record<string, Record<string, number>> = {};
  const award = (playerId: string, source: string, amount: number): void => {
    if (!amount) return;
    const p = playerById(next, playerId);
    if (!p) return;
    p.prestige += amount;
    // Consistent with economy/diplomacy: accumulate this-round scratch. (The
    // per-round reset is a roundLoop/INCOME concern — see the report.)
    p.prestigeThisRound = (p.prestigeThisRound ?? 0) + amount;
    const sources = breakdown[playerId] ?? (breakdown[playerId] = {});
    sources[source] = (sources[source] ?? 0) + amount;
  };

  // --- 1) Capitals & key cities held (§13.1 +1 own / +3 enemy / +1 key) -----
  for (const prov of next.provinces) {
    const owner = playerById(next, prov.ownerId);
    if (prov.isCapitalOf && owner) {
      if (owner.faction === prov.isCapitalOf) {
        // §13.1 hold your own capital → +1/round.
        award(owner.id, "ownCapital", PRESTIGE_VALUES.holdOwnCapitalPerRound);
      } else {
        // §13.1 hold an enemy capital → +3/round.
        award(owner.id, "enemyCapital", PRESTIGE_VALUES.holdEnemyCapitalPerRound);
      }
    }
    // §13.1 hold a named key city → +1 each/round. Capitals are scored above as
    // capitals, not additionally as key cities (avoids double-scoring the City).
    if (!prov.isCapitalOf && (prov.highValue ?? 0) > 0 && owner) {
      award(owner.id, "keyCity", PRESTIGE_VALUES.holdKeyCityPerRound);
    }
  }

  // --- 2) Trade monopoly (§13.1 +2/round) ----------------------------------
  for (const player of next.players) {
    if (hasTradeMonopoly(next, player.id)) {
      award(player.id, "tradeMonopoly", PRESTIGE_VALUES.tradeMonopolyPerRound);
    }
  }

  // --- 3) Secret objectives completed, once (§13.1 +4 each) ----------------
  const completedObjectives: { playerId: string; objectiveId: string; prestige: number }[] = [];
  for (const player of next.players) {
    for (const obj of player.objectives) {
      if (obj.completed) continue;
      if (obj.provinceRefs.length === 0) continue;
      const satisfied = obj.provinceRefs.every(
        (ref) => next.provinces.find((p) => p.id === ref)?.ownerId === player.id,
      );
      if (!satisfied) continue;
      obj.completed = true; // one-time: never re-scored
      award(player.id, "secretObjective", obj.prestige);
      completedObjectives.push({ playerId: player.id, objectiveId: obj.id, prestige: obj.prestige });
    }
  }

  // --- 4) Decisive battles & won wars this round ---------------------------
  // §13.1 decisive battle (+1): a battle this round with a winner (a wipe/rout),
  // or a siege stormed this round. Only this round's combat entries are scanned.
  for (const entry of next.log) {
    if (entry.round !== next.round) continue;
    if (entry.type === "battle") {
      const winnerId = entry.data?.winnerId;
      if (typeof winnerId === "string" && winnerId) {
        award(winnerId, "decisiveBattle", PRESTIGE_VALUES.decisiveBattleWin);
      }
    } else if (entry.type === "siege" && entry.data?.captured === true) {
      const besiegerId = entry.actors[0];
      if (besiegerId) award(besiegerId, "decisiveBattle", PRESTIGE_VALUES.decisiveBattleWin);
    }
  }

  // §13.1 win a war (+3): awarded via a 'war_won' modifier posted by whoever
  // resolves a war (force peace/tribute/vassalage). One-time; cleared here.
  for (const mod of next.activeModifiers) {
    if (mod.kind !== "war_won") continue;
    const winnerId = mod.data?.playerId
      ? String(mod.data.playerId)
      : playerByFaction(next, mod.target?.faction)?.id;
    if (winnerId) award(winnerId, "winWar", PRESTIGE_VALUES.winWar);
  }
  next.activeModifiers = next.activeModifiers.filter((m) => m.kind !== "war_won");

  // --- 5) Lose your own capital this round (§13.1 −3) ----------------------
  const penalisedCapitals = new Set<string>();
  for (const entry of next.log) {
    if (entry.round !== next.round) continue;
    let capturedProvId: string | undefined;
    let dispossessedId: string | undefined; // precise loser, when known
    let captorId: string | undefined;

    if (entry.type === "battle" && typeof entry.data?.winnerId === "string") {
      const winnerId = String(entry.data.winnerId);
      const attackerId = entry.actors[0];
      // Combat captures a province when the ATTACKER wins the field battle.
      if (winnerId === attackerId && entry.targets && entry.targets.length > 0) {
        capturedProvId = entry.targets[0];
        captorId = winnerId;
        dispossessedId = entry.actors[1]; // the defender (previous owner)
      }
    } else if (entry.type === "siege" && entry.data?.captured === true) {
      capturedProvId = entry.targets?.[0];
      captorId = entry.actors[0];
      // Siege logs do not name the dispossessed defender; inferred below.
    }

    if (!capturedProvId || penalisedCapitals.has(capturedProvId)) continue;
    const prov = next.provinces.find((p) => p.id === capturedProvId);
    if (!prov?.isCapitalOf) continue;

    // Only the capital's RIGHTFUL faction suffers "lose your capital".
    const rightful = playerByFaction(next, prov.isCapitalOf);
    if (!rightful || rightful.id === captorId) continue;
    // For a battle we can confirm the rightful owner was the loser; for a siege
    // we fall back to the rightful-faction heuristic.
    if (dispossessedId !== undefined && dispossessedId !== rightful.id) continue;
    award(rightful.id, "loseCapital", PRESTIGE_VALUES.loseCapital);
    penalisedCapitals.add(capturedProvId);
  }

  // --- 6) Constantinople sudden-death tracker (§13.3) ----------------------
  const cple = next.provinces.find((p) => p.id === CONSTANTINOPLE_ID);
  if (cple) {
    const holder = playerById(next, cple.ownerId);
    const holderFaction = holder?.faction ?? null;
    const rightful = cple.isCapitalOf ?? null;
    const tracked = next.constantinopleHold;
    if (holderFaction && holderFaction !== rightful) {
      // A foreign power holds the City — advance the sudden-death clock.
      next.constantinopleHold =
        tracked.faction === holderFaction
          ? { faction: holderFaction, rounds: tracked.rounds + 1 }
          : { faction: holderFaction, rounds: 1 };
    } else {
      // Rightful owner holds it, it is neutral, or empty — clock disarmed/reset.
      next.constantinopleHold = { faction: null, rounds: 0 };
    }
  }

  // --- 7) Emit chronicle entries -------------------------------------------
  for (const oc of completedObjectives) {
    const p = playerById(next, oc.playerId);
    next = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "prestige_change",
      actors: [oc.playerId],
      message: `${p?.name ?? oc.playerId} completes a secret objective (+${oc.prestige} prestige).`,
      data: { objectiveId: oc.objectiveId, prestige: oc.prestige, source: "secretObjective" },
    });
  }
  for (const player of next.players) {
    const detail = breakdown[player.id];
    if (!detail) continue;
    const netGain = Object.values(detail).reduce((a, b) => a + b, 0);
    next = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "prestige_change",
      actors: [player.id],
      message: `${player.name} scores ${netGain >= 0 ? "+" : ""}${netGain} prestige this cleanup (now ${player.prestige}).`,
      data: { sources: detail, netGain, total: player.prestige },
    });
  }

  return next;
}

// ---------------------------------------------------------------------------
// checkVictory — threshold / sudden-death / round-16 endgame (§13.2 / §13.3)
// ---------------------------------------------------------------------------

/**
 * Check for a winner (§13.2 / §13.3). Precedence: sudden death (a foreign power
 * holding Constantinople through two cleanups) wins immediately regardless of
 * prestige; else any player at/over the player-count prestige threshold wins (if
 * several cross the same cleanup, highest prestige wins); else, at round 16, the
 * highest prestige wins. Ties break on most key cities, then most gold. Returns
 * the winning faction, or null if the game continues. Read-only.
 */
export function checkVictory(state: GameState): Faction | null {
  const playerCount = state.players.length;
  // §13.2 threshold by player count (2→25, 3→30, 4–5→35).
  const threshold = PRESTIGE_THRESHOLDS[playerCount] ?? 35;

  /** Highest prestige; tiebreak most key cities, then most gold (§13.3). */
  const pickBest = (candidates: Player[]): Player | null => {
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => {
      if (b.prestige !== a.prestige) return b.prestige - a.prestige;
      const keyDiff = keyCityCount(state, b.id) - keyCityCount(state, a.id);
      if (keyDiff !== 0) return keyDiff;
      return b.treasury.gold - a.treasury.gold;
    })[0];
  };

  // 1) Sudden death (§13.3) — foreign holder of the City for two cleanups.
  const cple = state.provinces.find((p) => p.id === CONSTANTINOPLE_ID);
  const rightful = cple?.isCapitalOf ?? null;
  const hold = state.constantinopleHold;
  if (hold.faction && hold.faction !== rightful && hold.rounds >= SUDDEN_DEATH_ROUNDS) {
    return hold.faction;
  }

  // 2) Prestige threshold (§13.2) — checked every cleanup.
  const crossers = state.players.filter(
    (p) => p.faction != null && p.prestige >= threshold,
  );
  if (crossers.length > 0) {
    return pickBest(crossers)?.faction ?? null;
  }

  // 3) Round 16 "1453" endgame (§13.3) — highest prestige takes it.
  if (state.round >= ROUNDS) {
    const seated = state.players.filter((p) => p.faction != null);
    return pickBest(seated)?.faction ?? null;
  }

  return null;
}
