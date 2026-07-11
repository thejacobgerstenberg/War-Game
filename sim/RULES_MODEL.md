# RULES_MODEL — assumptions the balance sim makes

This documents every mechanic as the simulation implements it, so the engine
team can diff it against the real rules. All numbers live in
`src/rules.ts` (`CONFIG`); this file explains the *shape* of each mechanic.

## Round structure (16 rounds = years, ~1 round/year 1438–1453 flavor)

1. **Event** — one global event card per round. Model: card has a kind
   (`gold | grain | units | prestige`), a target (`all | random | leader`),
   and a uniform-random magnitude within `CONFIG.events` bounds, drawn via
   the seeded RNG. No persistent/multi-round events in v1.
2. **Income & upkeep** — each faction collects province yields (+ market
   buildings, + trade routes × faction trade multiplier, + capital bonus),
   then pays upkeep: grain per unit, gold for mercenaries (wages) and
   galleys (crews). Grain can be bought/sold at
   `economy.grainMarket` rates during this phase. Treasury never goes
   negative (`goldFloor`): whatever cannot be paid triggers desertion —
   unpaid mercenaries desert 100%, unfed units desert at
   `grainShortfallDesertionFraction` (25%) per shortfall round.
3. **Actions** — each player takes `actionsPerTurn` (4) actions:
   recruit / move-attack / build / trade / diplomacy / play card / pass.
   Recruit caps per action are `recruit.perAction`. Mercenaries muster
   instantly (usable this round); all other units arrive at end of round.
4. **Battles resolve**, then **cleanup** (prestige scoring, siege attrition,
   sudden-death check).

## Combat (src/combat.ts)

Risk-style. Per battle round:

- Attacker rolls `min(3, combatants)` d6; defender rolls `min(2, combatants)`.
  Combatants = levy + professional + mercenary + galley. Siege engines never
  roll and are destroyed/captured if their army is wiped out.
- Every die is shifted by a per-side float bonus:
  - attacker: flat bonuses (tactic card ±1, events) + **army quality**;
  - defender: flat bonuses + **terrain** + **effective wall bonus** + quality.
  - Army quality = average of `units.*.quality` over combatants
    (levy 0.0, professional 1.0, mercenary 1.0, galley 0.5).
- Sorted dice compared pairwise (highest vs highest, 2nd vs 2nd). Each lost
  comparison = 1 unit casualty. **Defender wins ties.**
- Casualty order (fixed): levy → mercenary → professional → galley.
- Battle ends when a side is destroyed, when the attacker falls to ≤ 35%
  (`retreatFraction`) of its starting combatants (counts as defender win),
  or after `combat.maxRounds` rounds (stalemate; a siege just continues).
- River/strait assault: attacker takes `riverCrossingPenalty` (−1) as a
  negative `attackerBonus`.
- Naval battles use the same kernel with galley armies and no terrain/walls.

## Walls & sieges

- Wall tiers 0–3 give the defender a die bonus (`walls.tierBonus` = 0/1/2/3).
  Constantinople's Theodosian Walls add `theodosianBonus` (+1.5) on top of
  tier 3 → +4.5 intact.
- Walls have hitpoints: `tier × hitpointsPerTier` (4), Theodosian +4 (16 total
  for Constantinople). The die bonus scales **linearly** with remaining
  hitpoints (`effectiveWallBonus`), so bombardment gradually softens a city.
- Siege procedure per round while an army besieges a walled province:
  1. Each siege engine deals `engineDamagePerRound` (1) wall damage, at most
     `maxEffectiveEngines` (3) engines counting. The **Great Bombard**
     (buildable from round 9, 30 gold, one-off) adds 4 damage/round.
  2. Garrison starves: loses 6% per round (rounded stochastically), doubled
     if every coast of the province is blockaded by enemy galleys.
  3. Besieger loses 3% per round to disease.
  4. The attacker may **assault** at any time (walls need not be breached);
     the current effective wall bonus applies to the defender's dice.
- Consequence: intact Constantinople (+4.5 walls, on plains) is effectively
  unassailable; with the Great Bombard from round ~9–10 its 16 wall
  hitpoints fall in ~2–3 siege rounds, making a round-11+ capture plausible —
  matching the spec anchor.

## Economy & map

- Resources: gold, grain (core); timber, marble, faith (secondary, used by
  buildings). Province yields are authored in `map.ts` within the bounds in
  `CONFIG.yields`.
- Buildings (one action + costs): **market** (+2 gold/round in province),
  **wall upgrade** (+1 tier, max 3), **great work** (one-off +5 prestige).
- Trade routes are authored port-pairs in `map.ts` with a gold income and a
  sea-zone path; an enemy fleet in any zone on the path cuts the route
  (`blockadeCancels`). A faction profits from at most
  `maxRoutesPerFaction` (3) routes; Venice ×1.5 and Genoa ×1.4 income.
- Faction flavor multipliers (`CONFIG.factions`): Ottomans pay 75% for all
  troops; Hungary pays 50% for levies and recruits +2 levies per recruit
  action; Byzantium's capital yields +4 extra gold/round while held.
- Starting treasuries/garrisons (`map.ts FACTION_STARTS`) are tuned so grain
  upkeep ≈ starting grain income (±2, coverable via the grain market).
- Neutral provinces defend with `2 + 2×wallTier` levies (+2 professionals in
  key cities).

## Prestige & victory

- Per round-end: +1 per key city held (Constantinople counts +1 extra),
  +0.5 per open trade route.
- One-off: great work +5, war won +3, secret objective +6.
- Win immediately at `victoryThreshold` (50, initial guess) prestige, else
  highest prestige after round 16.
- **Sudden death**: hold Constantinople for 2 consecutive full rounds → win.

## Deliberate simplifications (v1)

- One global event per round, no event hand management.
- Diplomacy modeled as a policy action (non-aggression targeting), no formal
  alliance rules yet.
- Tactic cards abstracted to a ±1 die swing when a policy chooses to play one.
- Movement is 1 province (or 1 sea zone per galley move) per move action;
  sea transport requires 1 galley per 2 land units (assumption).
- Secret objectives modeled as "hold N specific provinces by round R" checks.
