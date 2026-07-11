/**
 * actions.ts — the pure validating reducer.
 *
 * `applyAction(state, action)` is the single entry point for every player
 * command. It validates legality (issuer exists, phase legality, action budget,
 * and — for the subsystems — adjacency / resource sufficiency), then dispatches
 * to the owning subsystem function and returns a NEW GameState.
 *
 * ERROR CONVENTION (frozen): illegal actions throw an {@link EngineError} with a
 * machine-readable `code` and human `message`. The transport layer wraps
 * `applyAction` in try/catch and emits `action_rejected { reason, code }` to the
 * issuing socket; a thrown error never mutates state. Successful actions return
 * the next state. (This is why the signature is `=> GameState`, not a result
 * union.)
 *
 * Most subsystem bodies are stubs in this phase; the reducer's dispatch table,
 * budget accounting and error convention are the frozen contract.
 */
import {
  GamePhase,
  TaxPosture,
  type GameAction,
  type GameState,
  type Player,
} from "@imperium/shared";
import { applyBuild, applyTrade } from "./economy.js";
import { applyDiplomacy, applyVassalize } from "./diplomacy.js";
import { applySpy } from "./spy.js";
import { applyMercBid } from "./mercenaries.js";
import { resolveCard } from "./events/index.js";
import { advancePhase } from "./roundLoop.js";

/** A typed, rejectable engine error (see the module-level error convention). */
export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

/** Phases during which players may spend budgeted actions (§10.0). */
const ACTION_PHASES: ReadonlySet<GamePhase> = new Set([
  GamePhase.RECRUITMENT,
  GamePhase.MOVEMENT,
  GamePhase.DIPLOMACY,
]);

/** Look up a player by id or throw. */
function requirePlayer(state: GameState, playerId: string): Player {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    throw new EngineError("UNKNOWN_PLAYER", `No such player: ${playerId}`);
  }
  return player;
}

/** Assert the game is in an action phase and the player has budget; deduct one. */
function spendAction(state: GameState, playerId: string): GameState {
  if (!ACTION_PHASES.has(state.phase)) {
    throw new EngineError(
      "WRONG_PHASE",
      `Cannot act during the ${state.phase} phase.`,
    );
  }
  const player = requirePlayer(state, playerId);
  if (player.actionsRemaining <= 0) {
    throw new EngineError("NO_ACTIONS", `${player.name} has no actions left.`);
  }
  return {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, actionsRemaining: p.actionsRemaining - 1 } : p,
    ),
  };
}

/**
 * Validate and apply a single {@link GameAction}, returning a new GameState.
 * Throws {@link EngineError} on any illegality.
 */
export function applyAction(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "ADVANCE_PHASE":
      // Phase advancement is not budgeted; host/engine driven.
      return advancePhase(state);

    case "SET_TAX": {
      const player = requirePlayer(state, action.player);
      if (!Object.values(TaxPosture).includes(action.posture)) {
        throw new EngineError("BAD_TAX", `Invalid tax posture.`);
      }
      void player;
      return {
        ...state,
        players: state.players.map((p) =>
          p.id === action.player ? { ...p, tax: action.posture } : p,
        ),
      };
    }

    case "PASS": {
      requirePlayer(state, action.player);
      // Forfeit remaining actions this turn.
      return {
        ...state,
        players: state.players.map((p) =>
          p.id === action.player ? { ...p, actionsRemaining: 0 } : p,
        ),
      };
    }

    case "MERC_BID":
      // Bidding happens during the merc market window, not a budgeted action.
      requirePlayer(state, action.player);
      return applyMercBid(state, action);

    case "RECRUIT": {
      const next = spendAction(state, action.player);
      // TODO(economy/reducer): validate province ownership + Barracks/Shipyard,
      // deduct UNIT_STATS cost (×merc multiplier), add units/variants.
      return next;
    }

    case "MOVE": {
      const next = spendAction(state, action.player);
      // TODO(combat/reducer): validate adjacency + movement points + stacking;
      // relocate the stack or push a PendingBattle when entering a defended tile.
      return next;
    }

    case "BUILD": {
      const next = spendAction(state, action.player);
      if (!action.building && !action.greatWork) {
        throw new EngineError(
          "BAD_BUILD",
          "BUILD requires a building or greatWork.",
        );
      }
      return applyBuild(next, action);
    }

    case "TRADE": {
      const next = spendAction(state, action.player);
      return applyTrade(next, action);
    }

    case "DIPLOMACY": {
      // Propose/accept cost the initiator an action; responder is free (§10.0).
      const next =
        action.diplomacy.kind === "ACCEPT"
          ? state
          : spendAction(state, action.player);
      return applyDiplomacy(next, action);
    }

    case "VASSALIZE": {
      const next = spendAction(state, action.player);
      return applyVassalize(next, action);
    }

    case "SPY": {
      const next = spendAction(state, action.player);
      return applySpy(next, action);
    }

    case "PLAY_CARD": {
      requirePlayer(state, action.player);
      // TODO(events/reducer): verify the card is in hand; playing may be free.
      return resolveCard(state, action.cardId);
    }

    default: {
      // Exhaustiveness guard.
      const _never: never = action;
      void _never;
      throw new EngineError("UNKNOWN_ACTION", "Unrecognised action type.");
    }
  }
}
