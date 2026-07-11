/**
 * prestige.ts — prestige scoring and victory checks (§13).
 *
 * Owns §13: the per-round prestige accrual scored at Cleanup/END (own/enemy
 * capitals, key cities, trade monopoly), the −3 lose-capital penalty, the §13
 * conquest-prestige track (consumed from `prestige_pending` modifiers posted by
 * combat/diplomacy), the game-end secret-objective reveal (+4 each), the
 * Constantinople sudden-death tracker, and the victory threshold / round-16
 * endgame checks. Every number is read from balance.PRESTIGE_VALUES /
 * PRESTIGE_THRESHOLDS. Pure.
 *
 * Coordination (to avoid double-counting §13.1 sources awarded by a sibling
 * subsystem — see the final report):
 *  - One-time CONQUEST awards (§13.1: decisive battle +1, outnumbered win +1,
 *    take walled city +2/+3, win war +3) are POSTED by combat/diplomacy as
 *    `ActiveModifier { kind:"prestige_pending", scope:"round", value, target.faction }`
 *    (CONTRACT2 §12.8). scorePrestige CONSUMES them ONCE at Cleanup and folds the
 *    value into both `Player.prestige` and `Player.conquestPrestige`; it defensively
 *    removes them so a missed roundLoop `expireRoundModifiers` cannot double-count.
 *    scorePrestige NEVER scans combat logs for these (that would double-count with
 *    the posted modifiers) and combat NEVER mutates prestige directly.
 *  - Great-work completion prestige (+5..+10) is awarded once by
 *    economy.completeGreatWork at build time; scorePrestige does NOT re-award it.
 *  - Betrayal penalties (−2..−4) are applied by diplomacy.applyDiplomacy at the
 *    moment of renunciation; scorePrestige does NOT re-apply them.
 *  - Vassal (+1/round) and royal-marriage (+2/round) prestige are awarded by
 *    diplomacy.runRevolts (which roundLoop runs immediately after scorePrestige
 *    in the same END phase); scorePrestige does NOT re-award them.
 * scorePrestige owns only the sources no other subsystem accrues: capitals held,
 * key cities held, trade monopoly, the lose-capital penalty, the sudden-death
 * tracker, the prestige_pending consumption, and the game-end objective reveal.
 */
import {
  GamePhase,
  type Faction,
  type GameState,
  type Player,
  type SecretObjective,
} from "@imperium/shared";
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
// Secret-objective predicate evaluation (FACTIONS.md / §13.1) — FL-06/07/08
// ---------------------------------------------------------------------------

/**
 * FL-08 (FACTIONS Byz #3 / §13.1) + CANON CLARIFICATION (coordinator ruling 1):
 * "Hagia Sophia intact" NO LONGER means a completed HAGIA_SOPHIA great work. The
 * Hagia Sophia is a STANDING building now, not a build target for this objective;
 * the great-work gate is removed entirely. Instead "intact" = the player still
 * holds CONSTANTINOPLE at game end AND that City was never SACKED (captured by
 * assault/storm). A starvation-surrender does not sack (RATIFY-PREP: Province.sacked
 * is set only on assault-capture), so a City that changed hands by storm — even if
 * retaken — is no longer intact. Read-only.
 */
function constantinopleIntact(state: GameState, player: Player): boolean {
  const cple = state.provinces.find((p) => p.id === CONSTANTINOPLE_ID);
  if (!cple || cple.ownerId !== player.id) return false;
  return cple.sacked !== true;
}

/**
 * FL-08 (FACTIONS Byz #3 / §13.1): did this player resolve the Council of
 * Florence in the Union's favour? Prep4 wired the canonical boolean
 * `Player.acceptedChurchUnion` (set by the events subsystem when Omen #17 is
 * resolved `choice:"ACCEPT"`). Absence/false ⇒ the player REFUSED the Union,
 * which is the doc default (FIX-PREP2: undefined = refused).
 */
function acceptedChurchUnion(player: Player): boolean {
  return player.acceptedChurchUnion === true;
}

/**
 * FL-07 (FACTIONS Ottoman #3): number of high-value cities this player has sacked
 * over the game. Prep4 wired the canonical counter `Player.sackedHighValueCities`
 * (incremented by combat.ts on capture of an enemy high-value city; absent ⇒ 0).
 */
function countSackedHighValueCities(player: Player): number {
  return player.sackedHighValueCities ?? 0;
}

/**
 * Evaluate a secret objective's completion predicate (FACTIONS.md / §13.1),
 * supporting the extended SecretObjective model (FL-06/07/08). All present clause
 * groups must hold (AND between groups), EXCEPT:
 *  - `anyOf` is an OR *within* its own territorial group (FL-06);
 *  - the "imperial scale" gates `minProvinces` / `sackedHighValueCities` are
 *    ALTERNATIVES to each other (FL-07: ≥15 provinces OR ≥3 HV cities sacked).
 * Legacy `provinceRefs` is treated as an implicit all-of group. Read-only.
 */
function objectiveSatisfied(state: GameState, player: Player, obj: SecretObjective): boolean {
  const owns = (id: string): boolean =>
    state.provinces.find((p) => p.id === id)?.ownerId === player.id;

  // Territorial all-of (FL-06): legacy provinceRefs + explicit allOf — all held.
  const allRefs = [...(obj.provinceRefs ?? []), ...(obj.allOf ?? [])];
  if (allRefs.length > 0 && !allRefs.every(owns)) return false;

  // Territorial or-clause (FL-06): at least one of anyOf held.
  const hasAnyOf = (obj.anyOf?.length ?? 0) > 0;
  if (hasAnyOf && !obj.anyOf!.some(owns)) return false;

  // Faith threshold (FL-08): finish with ≥ minFaith banked.
  if (obj.minFaith !== undefined && (player.treasury.faith ?? 0) < obj.minFaith) {
    return false;
  }

  // "Hagia Sophia intact" (FL-08 + coordinator ruling 1): hold Constantinople and
  // it was never sacked (assault-captured). The requiresHagiaSophia flag is retained
  // as the switch for this gate; its meaning is now "Constantinople not sacked", NOT
  // completion of the HAGIA_SOPHIA great work (great-work gate removed).
  if (obj.requiresHagiaSophia && !constantinopleIntact(state, player)) return false;

  // Refused Church Union (FL-08): never resolved Council of Florence for the Union
  // (reads Prep4's Player.acceptedChurchUnion; undefined/false = refused).
  if (obj.refusedChurchUnion && acceptedChurchUnion(player)) return false;

  // Imperial-scale gates (FL-07) — ALTERNATIVES (OR) to one another.
  const scaleGates: boolean[] = [];
  if (obj.minProvinces !== undefined) {
    const count = state.provinces.filter((p) => p.ownerId === player.id).length;
    scaleGates.push(count >= obj.minProvinces);
  }
  if (obj.sackedHighValueCities !== undefined) {
    scaleGates.push(countSackedHighValueCities(player) >= obj.sackedHighValueCities);
  }
  if (scaleGates.length > 0 && !scaleGates.some(Boolean)) return false;

  // A degenerate objective with no clauses at all never auto-completes.
  const hasClause =
    allRefs.length > 0 ||
    hasAnyOf ||
    obj.minFaith !== undefined ||
    obj.requiresHagiaSophia === true ||
    obj.refusedChurchUnion === true ||
    scaleGates.length > 0;
  return hasClause;
}

// ---------------------------------------------------------------------------
// decideWinner — the §13.2/§13.3 endgame predicate (phase-agnostic core)
// ---------------------------------------------------------------------------

/**
 * The pure endgame decision shared by {@link checkVictory} (which gates it on the
 * Cleanup phase per §13.2) and {@link scorePrestige} (which uses it as a boolean
 * "does this cleanup end the game?" gate for the §13.3 objective reveal).
 *
 * Precedence (§13.3, documented explicitly):
 *   1. SUDDEN DEATH — a foreign power holding Constantinople through two cleanups
 *      wins immediately, regardless of prestige.
 *   2. PRESTIGE THRESHOLD — any player at/over the player-count threshold; if
 *      several cross the same cleanup, the highest prestige takes it.
 *   3. ROUND 16 ("1453") — otherwise, at the final round, the highest prestige.
 * Ties break on most key cities, then most gold. Read-only.
 */
function decideWinner(state: GameState): Faction | null {
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

// ---------------------------------------------------------------------------
// scorePrestige — per-round accrual at Cleanup/END (§13.1) + conquest track
// ---------------------------------------------------------------------------

/**
 * Accrue per-round prestige for every player at cleanup (§13.1), consume the
 * conquest-track `prestige_pending` awards, reveal & score secret objectives if
 * this cleanup ends the game (§13.3), and record a prestige_change log entry per
 * player. Also updates the Constantinople sudden-death tracker (§13.3). Does not
 * itself declare a winner. Pure.
 */
export function scorePrestige(state: GameState): GameState {
  let next = clone(state);

  // Per-player, per-source breakdown for the chronicle line.
  const breakdown: Record<string, Record<string, number>> = {};
  const award = (
    playerId: string,
    source: string,
    amount: number,
    conquest = false,
  ): void => {
    if (!amount) return;
    const p = playerById(next, playerId);
    if (!p) return;
    p.prestige += amount;
    // §13 conquest track: fold conquest-derived prestige into the running total.
    if (conquest) p.conquestPrestige = (p.conquestPrestige ?? 0) + amount;
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
        // §13.1 hold an enemy capital → +3/round (a conquest-track source).
        award(owner.id, "enemyCapital", PRESTIGE_VALUES.holdEnemyCapitalPerRound, true);
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

  // --- 3) Conquest track: consume prestige_pending (§13 / CONTRACT2 §12.8) --
  // Combat (decisive battle +1, outnumbered win +1, take walled city +2/+3) and
  // diplomacy (win war +3) POST these as round-scoped `prestige_pending`
  // modifiers at the moment the result resolves. Consume each exactly ONCE, fold
  // into prestige + conquestPrestige, then remove them (defensive against a
  // roundLoop that forgets to `expireRoundModifiers`). We never also scan the
  // combat log for these — that would double-count (see module header).
  for (const mod of next.activeModifiers) {
    if (mod.kind !== "prestige_pending") continue;
    const winner =
      (typeof mod.data?.playerId === "string" && (mod.data.playerId as string)) ||
      playerByFaction(next, mod.target?.faction)?.id;
    if (!winner) continue;
    const value = mod.value ?? 0;
    if (!value) continue;
    const source = typeof mod.data?.reason === "string" ? (mod.data.reason as string) : "conquest";
    // prestige_pending is by convention a conquest-track delta (positive awards);
    // fold positive awards into conquestPrestige. `data.conquest === false` opts out.
    const isConquest = mod.data?.conquest !== false && value > 0;
    award(winner, source, value, isConquest);
  }
  next.activeModifiers = next.activeModifiers.filter((m) => m.kind !== "prestige_pending");

  // --- 4) Lose your own capital this round (§13.1 −3) ----------------------
  // Derived from this round's capture logs (the DEFENDER's negative penalty; the
  // captor's positive award arrives separately via prestige_pending, so there is
  // no double-count between the two).
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
    } else if (
      // §13.1 (FL-20): an UNCONTESTED occupation — the attacker marched into an
      // undefended province (no defender, no winnerId). It is still a capture, so
      // the dispossessed capital owner must take the −3. The producer
      // (actions.ts::relocate) tags the log `data.occupied === true`; the older
      // synthetic form used `data.rounds === 0` — accept either discriminator.
      entry.type === "battle" &&
      entry.data?.winnerId === undefined &&
      (entry.data?.occupied === true || entry.data?.rounds === 0) &&
      entry.targets !== undefined &&
      entry.targets.length > 0 &&
      entry.actors.length > 0
    ) {
      capturedProvId = entry.targets[0];
      captorId = entry.actors[0];
      dispossessedId = entry.actors[1]; // usually undefined (no defender named)
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

  // --- 5) Constantinople sudden-death tracker (§13.3) ----------------------
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

  // --- 6) Secret objectives — revealed & scored ONLY at game end (§13.1/§13.3)
  // CANON #10: objectives are hidden and never scored per-round; they are revealed
  // and scored (+prestige each, satisfied only) at the SINGLE cleanup that ends
  // the game. We use decideWinner on the CURRENT (pre-objective) prestige purely
  // as a "does this cleanup end the game?" gate — adding objective prestige can
  // only raise totals, so it can never un-end a game that decideWinner said ends,
  // keeping scorePrestige and the subsequent checkVictory consistent. At round 16
  // the objective reveal may legitimately swing the highest-prestige winner.
  const gameEnds = decideWinner(next) !== null || next.round >= ROUNDS;
  const revealedObjectives: { playerId: string; objectiveId: string; prestige: number }[] = [];
  if (gameEnds) {
    for (const player of next.players) {
      for (const obj of player.objectives) {
        if (obj.completed) continue;
        // FL-06/07/08: evaluate the full predicate (territorial all-of/any-of +
        // the non-territorial minProvinces/Hagia-Sophia/faith/church-union/sack
        // gates), not a bare provinceRefs.every() — the latter skipped
        // non-territorial objectives entirely and mis-scored OR-clauses.
        if (!objectiveSatisfied(next, player, obj)) continue;
        obj.completed = true; // revealed & scored once, at game end
        award(player.id, "secretObjective", obj.prestige);
        revealedObjectives.push({ playerId: player.id, objectiveId: obj.id, prestige: obj.prestige });
      }
    }
  }

  // --- 7) Emit chronicle entries -------------------------------------------
  for (const oc of revealedObjectives) {
    const p = playerById(next, oc.playerId);
    next = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "prestige_change",
      actors: [oc.playerId],
      message: `${p?.name ?? oc.playerId} reveals a completed secret objective at game end (+${oc.prestige} prestige).`,
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
 * Check for a winner (§13.2 / §13.3). Victory is evaluated **only at the Cleanup
 * (END) phase** (CANON #3 / §13.2: "Cleanup is the only point where victory is
 * checked"); called in any other phase this returns null so a mid-round threshold
 * crossing can never win. Delegates the actual decision to {@link decideWinner}
 * (precedence: sudden death > prestige threshold > round-16 highest; ties break on
 * most key cities, then most gold). Returns the winning faction, or null if the
 * game continues. Read-only.
 */
export function checkVictory(state: GameState): Faction | null {
  // CANON #3 / §13.2: only the Cleanup phase may declare a winner.
  if (state.phase !== GamePhase.END) return null;
  return decideWinner(state);
}
