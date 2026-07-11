/**
 * mercenaries.ts — the mercenary bid market subsystem (stubbed).
 *
 * Owns §6.3: revealing 2–3 named free companies each round (seeded), turn-order
 * bidding, fielding the winner's company, and handing unsold companies to a
 * random NPC minor. Reads balance.MERC_COMPANIES / MERC_MARKET. Pure.
 */
import type { GameAction, GameState } from "@imperium/shared";

/**
 * Refresh the round's mercenary market: pick 2–3 companies from
 * balance.MERC_COMPANIES using the state RNG and populate state.mercMarket with
 * fresh unbid offers. Any previously-unsold company is resolved (NPC hire roll)
 * first. Derives RNG from state and writes the cursor back. Pure.
 */
export function refreshMercMarket(state: GameState): GameState {
  // TODO(mercenaries): resolve prior offers, then seed 2–3 new companies.
  return state;
}

/**
 * Apply a MERC_BID action (§6.3): validate the raise (>= current + minRaise),
 * update the offer's high bid/bidder. Fielding the company happens when bidding
 * closes (all others pass). Pure.
 */
export function applyMercBid(state: GameState, action: GameAction): GameState {
  // TODO(mercenaries): validate + record bid; field company when bidding closes.
  void action;
  return state;
}
