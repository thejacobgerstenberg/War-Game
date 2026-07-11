/**
 * Debug trace for the turtle-dominance hunt: run one seed with the tradeMax
 * vs monopolyMax agent in a given seat and print per-round routes/ledger of
 * the adversarial seat, to verify the monopoly sniping actually fires.
 *
 * Run: npx tsx src/adversarial/trace_turtle_dominance.ts [seed] [seat]
 */

import { FACTION_IDS, type FactionId } from '../types';
import { create } from '../rng';
import { Game, POLICY_NAMES, type Agent, type PolicyName } from '../game';
import { makeAgent } from '../agents';
import { makeMonopolyMaxAgent, makeTradeMaxTurtleAgent } from './turtle_dominance';

const seed = Number.parseInt(process.argv[2] ?? '911003', 10);
const seat = (process.argv[3] ?? 'venice') as FactionId;

for (const arm of ['tradeMax', 'monopolyMax'] as const) {
  const seatOrder = [...FACTION_IDS];
  const pool: PolicyName[] = [...POLICY_NAMES];
  create(seed).fork(97).shuffle(pool);
  const agents = {} as Record<FactionId, Agent>;
  let j = 0;
  for (const f of FACTION_IDS) {
    agents[f] = f === seat ? (arm === 'tradeMax' ? makeTradeMaxTurtleAgent() : makeMonopolyMaxAgent()) : makeAgent(pool[j++]);
  }
  const game = new Game(seed, agents, seatOrder);
  // wrap the seat agent to log
  const inner = agents[seat].takeTurn.bind(agents[seat]);
  agents[seat].takeTurn = (g, f) => {
    inner(g, f);
    const fs = g.faction(f);
    const owned = g.ownedProvinces(f);
    console.log(
      `${arm} r${g.round}: routes=[${fs.routes}] owned=${owned.length} gold=${fs.gold.toFixed(0)} ` +
        `led(trade=${fs.ledger.tradeRoutes.toFixed(1)},gw=${fs.ledger.greatWorks},conq=${fs.ledger.conquests},total=${fs.ledger.total.toFixed(1)})`,
    );
  };
  const res = game.run();
  console.log(`${arm}: winner=${res.winner} type=${res.victoryType} rounds=${res.rounds} seatPrestige=${res.finalPrestige[seat]}\n`);
}
