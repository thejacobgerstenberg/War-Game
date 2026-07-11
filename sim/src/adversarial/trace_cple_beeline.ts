/**
 * ADVERSARIAL DEBUG TRACE: run one solo-Ottoman-beeline game and print the
 * state of Constantinople (owner, garrison, wall damage, siege camp) plus the
 * beeliner economy at the start of every Ottoman turn. Used to eyeball that
 * the beeline exploit uses only legal engine behavior.
 *
 * Usage: cd sim && npx tsx src/adversarial/trace_cple_beeline.ts [seed]
 */

import { FACTION_IDS, type FactionId } from '../types';
import { create } from '../rng';
import { combatants } from '../combat';
import { Game, POLICY_NAMES, type Agent, type PolicyName } from '../game';
import { makeAgent } from '../agents';
import { freshTelemetry, makeBeelineAgent } from './cple_beeline';

const seed = Number.parseInt(process.argv[2] ?? '111002', 10);

const pool: PolicyName[] = [...POLICY_NAMES];
create(seed).fork(97).shuffle(pool);
const agents = {} as Record<FactionId, Agent>;
const tel = freshTelemetry();
let pi = 0;
for (const f of FACTION_IDS) {
  agents[f] = f === 'ottomans'
    ? makeBeelineAgent(f, { launchMin: 8, launchBy: 2, recruitStyle: 'prof' }, tel)
    : makeAgent(pool[pi++]);
}

// wrap the beeliner turn with a state dump
const inner = agents.ottomans.takeTurn;
agents.ottomans.takeTurn = (g: Game, f: FactionId) => {
  const p = g.province('constantinople');
  const s = g.siegeAt('constantinople');
  const fs = g.faction(f);
  const fmtArmy = (a: { levy: number; professional: number; mercenary: number; siegeEngine: number; galley: number }) =>
    `L${a.levy} P${a.professional} M${a.mercenary} E${a.siegeEngine} G${a.galley}`;
  console.log(
    `r${String(g.round).padStart(2)} | cple owner=${p.owner} garrison[${fmtArmy(p.garrison)}]=${combatants(p.garrison)} ` +
      `wallDmg=${p.wallDamage} wallBonus=${g.wallBonusAt('constantinople').toFixed(2)} | ` +
      (s ? `siege by ${s.attacker} r${s.rounds} camp[${fmtArmy(s.army)}]=${combatants(s.army)} | ` : 'no siege | ') +
      `otto gold=${fs.gold.toFixed(1)} grain=${fs.grain.toFixed(1)} grainNeed=${g.grainNeedOf(f)}`,
  );
  inner(g, f);
};

const res = new Game(seed, agents, FACTION_IDS.slice()).run();
console.log('\nresult:', JSON.stringify({
  winner: res.winner, type: res.victoryType, rounds: res.rounds,
  finalPrestige: res.finalPrestige, eliminated: res.eliminated,
  telemetry: tel,
}, null, 1));
