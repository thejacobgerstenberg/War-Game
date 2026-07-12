/**
 * spy.ts — the espionage subsystem (§10.7).
 *
 * A SPY action costs 1 action (the budget is already spent by the reducer's
 * dispatch in actions.ts, via `spendAction`) + 3 gold. The agent then makes a
 * single success roll (1d6 ≥ base target 3). The rival being spied on can
 * lengthen the odds: a target that owns a University raises the required roll by
 * 1, and Byzantium as the target resists with a further +1 (both stack → need
 * ≥ 5 vs a Byzantine University rival). See balance.SPY for every number.
 *
 * Missions:
 *   (a) OMEN     — peek the top card of the current Omen deck (actor-only intel).
 *   (b) OBJECTIVE — view one chosen rival's secret objective (actor-only intel).
 *   (c) UNREST   — incite unrest: the target enemy province yields 0 next Income
 *                  (posted as a 'no_income' ActiveModifier the economy reads).
 *
 * On failure the agent is captured: −1 prestige (−2 for the aggressive incite
 * unrest), and the target is told an enemy spy was caught.
 *
 * Pure: derives its RNG from `(state.rngSeed, state.rngCursor)`, rolls once, and
 * writes the advanced cursor back onto the returned state.
 */
import {
  BuildingType,
  Faction,
  SpyMission,
  type GameAction,
  type GameState,
  type Player,
} from "@imperium/shared";
import { SPY } from "./balance.js";
import { appendLog } from "./logEntry.js";
import { makeRng } from "./rng.js";
import { EngineError } from "./actions.js";

/** Return a shallow-cloned player list with `id` replaced by `fn(player)`. */
function withPlayer(
  players: Player[],
  id: string,
  fn: (p: Player) => Player,
): Player[] {
  return players.map((p) => (p.id === id ? fn(p) : p));
}

/** True when `playerId` owns at least one province with a University (§9). */
function ownsUniversity(state: GameState, playerId: string): boolean {
  return state.provinces.some(
    (prov) =>
      prov.ownerId === playerId &&
      prov.buildings.includes(BuildingType.UNIVERSITY),
  );
}

/**
 * Apply a SPY action (§10.7): charge 3 gold, roll against the mission's target
 * number, and on success apply the mission effect (peek Omen / view a rival
 * objective / incite unrest); on failure apply the capture prestige penalty.
 * Returns a new GameState; the input is never mutated.
 */
export function applySpy(state: GameState, action: GameAction): GameState {
  if (action.type !== "SPY") {
    throw new EngineError("UNKNOWN_ACTION", "applySpy requires a SPY action.");
  }

  const spy = state.players.find((p) => p.id === action.player);
  if (!spy) {
    throw new EngineError("UNKNOWN_PLAYER", `No such player: ${action.player}.`);
  }

  // --- Resolve the rival being spied on (drives the target-number modifiers) ---
  // §10.7 OMEN peeks the shared deck — there is no rival. OBJECTIVE names the
  // rival directly; UNREST derives the rival from the target province's owner.
  let rival: Player | undefined;
  let targetProvinceId: string | undefined;

  if (action.mission === SpyMission.OBJECTIVE) {
    if (!action.targetPlayerId) {
      throw new EngineError(
        "INVALID_TARGET",
        "OBJECTIVE spy mission requires a targetPlayerId.",
      );
    }
    if (action.targetPlayerId === spy.id) {
      throw new EngineError(
        "INVALID_TARGET",
        "Cannot spy on your own objectives.",
      );
    }
    rival = state.players.find((p) => p.id === action.targetPlayerId);
    if (!rival) {
      throw new EngineError(
        "INVALID_TARGET",
        `No such rival: ${action.targetPlayerId}.`,
      );
    }
  } else if (action.mission === SpyMission.UNREST) {
    if (!action.targetProvinceId) {
      throw new EngineError(
        "INVALID_TARGET",
        "UNREST spy mission requires a targetProvinceId.",
      );
    }
    const prov = state.provinces.find((p) => p.id === action.targetProvinceId);
    if (!prov) {
      throw new EngineError(
        "INVALID_TARGET",
        `No such province: ${action.targetProvinceId}.`,
      );
    }
    if (!prov.ownerId || prov.ownerId === spy.id) {
      throw new EngineError(
        "INVALID_TARGET",
        "Incite unrest must target an enemy-owned province.",
      );
    }
    targetProvinceId = prov.id;
    rival = state.players.find((p) => p.id === prov.ownerId);
  } else if (action.mission !== SpyMission.OMEN) {
    throw new EngineError("UNKNOWN_ACTION", "Unknown spy mission.");
  }

  // --- Cost: 3 gold, paid whether the mission succeeds or fails (§10.7). ---
  if (spy.treasury.gold < SPY.goldCost) {
    throw new EngineError(
      "INSUFFICIENT_RESOURCES",
      `Spy mission costs ${SPY.goldCost} gold; ${spy.name} has ${spy.treasury.gold}.`,
    );
  }

  // --- Success roll: 1d6 ≥ target number (§10.7). ---
  const rng = makeRng(state.rngSeed, state.rngCursor);
  const roll = rng.rollD6();

  // §10.7 base success on d6 ≥ 3. A rival that owns a University makes it harder
  // (+1), and Byzantium as the target resists (+1); both stack (≥ 5 worst case).
  let targetNumber = SPY.baseTarget;
  const rivalHasUniversity = rival ? ownsUniversity(state, rival.id) : false;
  const rivalIsByzantium = rival?.faction === Faction.BYZANTIUM;
  if (rivalHasUniversity) targetNumber += SPY.universityPenalty; // §10.7 rival University → harder
  if (rivalIsByzantium) targetNumber += SPY.byzantiumResist; // §10.7 Byzantium target resists
  const success = roll >= targetNumber;

  // Charge the gold up front (paid regardless of the outcome).
  let next: GameState = {
    ...state,
    players: withPlayer(state.players, spy.id, (p) => ({
      ...p,
      treasury: { ...p.treasury, gold: p.treasury.gold - SPY.goldCost },
    })),
    rngCursor: rng.cursor,
  };

  const rollData = {
    mission: action.mission,
    roll,
    targetNumber,
    rivalHasUniversity,
    rivalIsByzantium,
    goldSpent: SPY.goldCost,
  };

  if (!success) {
    // §10.7 capture: −1 prestige (−2 for incite unrest); the target is warned.
    const prestigeLoss =
      action.mission === SpyMission.UNREST
        ? SPY.inciteUnrestFailPrestige
        : SPY.captureFailPrestige;
    next = {
      ...next,
      players: withPlayer(next.players, spy.id, (p) => ({
        ...p,
        prestige: p.prestige + prestigeLoss,
      })),
    };
    next = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "spy",
      actors: [spy.id],
      targets: rival ? [rival.id] : [],
      // The target learns an enemy spy was caught, but not the intended mission.
      data: { ...rollData, captured: true, prestigeDelta: prestigeLoss },
      message: `${spy.name}'s agent was captured (rolled ${roll}, needed ${targetNumber}); ${prestigeLoss} prestige.`,
    });
    return next;
  }

  // --- Success: apply the chosen mission's effect (§10.7 table). ---
  switch (action.mission) {
    case SpyMission.OMEN: {
      // §10.7 (a) Read the Omens: peek the top card of the current deck. Intel
      // is for the acting player only — marked actor-scoped for the transport
      // layer to filter (see NEEDS-FROM-INTEGRATOR: no per-player intel field).
      const topCardId = next.omenDeck.length > 0 ? next.omenDeck[0] : null;
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "spy",
        actors: [spy.id],
        targets: [],
        data: {
          ...rollData,
          captured: false,
          omenTopCardId: topCardId,
          secret: true,
          visibleTo: [spy.id],
        },
        message:
          topCardId !== null
            ? `${spy.name}'s agent read the top Omen of the deck.`
            : `${spy.name}'s agent found the Omen deck empty.`,
      });
      return next;
    }

    case SpyMission.OBJECTIVE: {
      // §10.7 (b) Uncover an agenda: view one chosen rival's secret objective.
      // Reveal the first still-open objective (else the first dealt). Actor-only
      // intel — flagged secret/visibleTo for the transport layer to filter.
      const target = rival as Player;
      const objective =
        target.objectives.find((o) => !o.completed) ?? target.objectives[0];
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "spy",
        actors: [spy.id],
        targets: [target.id],
        data: {
          ...rollData,
          captured: false,
          objectiveId: objective ? objective.id : null,
          objectiveDescription: objective ? objective.description : null,
          secret: true,
          visibleTo: [spy.id],
        },
        message: objective
          ? `${spy.name}'s agent uncovered ${target.name}'s secret objective.`
          : `${spy.name}'s agent found ${target.name} holds no secret objective.`,
      });
      return next;
    }

    case SpyMission.UNREST: {
      // §10.7 (c) Incite unrest: the target province yields 0 next Income. Posted
      // as a 'no_income' ActiveModifier keyed to the province — economy.ts reads
      // it via getModifiers(state,'no_income',{provinceId}). Scoped to lapse after
      // the next Income (expiresRound = round+1; roundLoop must expire modifiers).
      const provId = targetProvinceId as string;
      const target = rival as Player;
      const modId = `spy:no_income:${provId}:r${next.round}:${spy.id}`;
      next = {
        ...next,
        activeModifiers: [
          ...next.activeModifiers,
          {
            id: modId,
            scope: "persistent",
            kind: "no_income",
            target: { provinceId: provId },
            value: 0,
            expiresRound: next.round + 1,
            data: { source: "spy_incite_unrest", spyId: spy.id },
          },
        ],
      };
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "spy",
        actors: [spy.id],
        targets: [provId, target.id],
        data: { ...rollData, captured: false, suppressedProvinceId: provId },
        message: `${spy.name}'s agent incited unrest in ${provId}; it will yield nothing next Income.`,
      });
      return next;
    }

    default: {
      // Exhaustiveness guard — validated above, so unreachable.
      throw new EngineError("UNKNOWN_ACTION", "Unknown spy mission.");
    }
  }
}
