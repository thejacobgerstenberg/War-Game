# RULES_MODEL — assumptions the balance sim makes

This documents every mechanic as the simulation implements it, so the engine
team can diff it against the real rules. All numbers live in
`src/rules.ts` (`CONFIG`); this file explains the *shape* of each mechanic.
CANON = `docs/GAME_DESIGN.md` on `feature/design-and-scaffold`; section
references (§) below point there. Coordinator rulings R1-R4 (2026-07-11)
made the canon combat kernel authoritative and added the Great Bombard
event, sea resupply, and the canon prestige income sources.

## Round structure (16 rounds = years, ~1 round/year 1438–1453 flavor)

1. **Event** — one global event card per round. Model: card has a kind
   (`gold | grain | units | prestige`), a target (`all | random | leader`),
   and a uniform-random magnitude within `CONFIG.events` bounds, drawn via
   the seeded RNG. No persistent/multi-round events in v1. **Era III fixed
   card**: at the start of round `siege.greatBombard.availableFromRound`
   (9) the card **`great-bombard-forged`** is revealed (the canon Omen deck
   is era-weighted, so the card reliably appears when Era III opens); see
   "Great Bombard" below.
2. **Income & upkeep** — each faction collects province yields (+ market
   buildings, + trade routes × faction trade multiplier, + capital bonus),
   then pays upkeep: **grain per unit** (canon §4.4; mercenaries eat ×2
   grain per §6.2) and gold for galley crews (sim divergence — canon galleys
   also eat grain). Grain can be bought/sold at `economy.grainMarket` rates
   during this phase. Treasury never goes negative (`goldFloor`): whatever
   cannot be paid triggers desertion — unpaid galley crews and unfed units
   desert (`grainShortfallDesertionFraction` 25% per shortfall round).
   **Skeleton-garrison rule (rules-visible)**: peacetime desertion (and
   negative unit events) never removes the LAST combatant of a walled
   province's garrison — a militia mans the walls, so an insolvent power
   cannot lose a fortress to a walk-in occupation. Siege starvation is
   unaffected and can still empty a garrison.
3. **Actions** — each player takes `actionsPerTurn` (4) actions:
   recruit / move-attack / build / trade / diplomacy / play card / pass.
   Recruit caps per action are `recruit.perAction`. Mercenaries muster
   instantly (usable this round); all other units arrive at end of round.
4. **Battles resolve**, then **cleanup** (prestige scoring, siege advance,
   sudden-death check).

## Units (5-unit roster mapped onto canon §6.1 CVs)

| sim unit | canon analogue | CV atk | CV def | gold | grain upkeep |
|---|---|---|---|---|---|
| levy | LEVY | 1 | 1 | 2 | 1 |
| professional | INFANTRY | 2 | 3 | 5 | 1 |
| mercenary | free company (CAVALRY-grade attack) | 3 | 2 | 6 | **2** (canon ×2 merc upkeep) |
| siegeEngine | SIEGE | — | — | 12 | 2 |
| galley | GALLEY | 2 | 2 | 8 | 0 (+1 gold crew) |

Mercenary economics follow canon §6.2: ≈×1.5 gold to raise, **grain** (not
gold) upkeep at ×2, instant muster, desert-first when unpaid. The sim has no
ARCHER/CAVALRY/WARSHIP (divergence-appendix item, ruling R6); the mercenary
carries the "shock attacker" role that canon gives cavalry. Faction quality
identity flows through cost multipliers and starting rosters (Ottoman
quantity: 75% troop costs; Hungarian levy swarms: 50% levy cost +2 per
recruit action; Byzantine quality: professional-heavy start behind the best
walls).

## Combat (src/combat.ts) — CANON KERNEL (§7, ruling R1)

Per battle round:

- **Every combatant unit rolls 1d6** and hits on
  `roll >= clamp(7 − CV − mods, 2, 6)` (§7.1). CV is per unit type and side
  (`cvAttack` / `cvDefense`). Combatants = levy + professional + mercenary +
  galley; siege engines never roll and are destroyed/captured if their army
  is wiped or routs.
- **Modifiers act in threshold space** (each +1 = hit one pip easier):
  - attacker: tactic card ±1, amphibious/strait `riverCrossingPenalty` −1
    (§7.3), escalade −1 when assaulting unbreached walls (§8.2.4);
  - defender: terrain +1 in hills/mountains/forest (§7.3, integer), wall
    bonus (binary, see below), tactic card ±1;
  - **outnumbering 2:1 in a round grants the larger side +1** (§7.3).
- **Both sides roll simultaneously**; each hit removes one enemy unit,
  lowest-value first: levy → mercenary → professional → galley. (Canon lets
  the loser choose; the sim fixes the default order.)
- **Rout (§7.5)**: after casualties, a side that has lost ≥ 50%
  (`routLossFraction`) of its starting stack rolls 1d6 each round and routs
  on ≤ 3 (`routOn`). A routing side loses the battle; survivors disperse
  (the kernel does no retreat pathing). If both would rout, the defender
  holds the field. No cavalry in the roster ⇒ no pursuit hits.
- The attacker voluntarily withdraws at ≤ 35% (`retreatFraction`) of its
  starting combatants (stands in for canon's voluntary retreat); battles cap
  at `combat.maxRounds` (stalemate — a siege just continues).
- Naval battles use the same kernel with galley CVs and no terrain/walls.

**Canon gaps filled (kernel-level, CONFIG-switchable):**

1. **No ranged pre-step** — canon §7.2 gives ARCHER (and SIEGE in sieges) a
   pre-melee volley; the sim roster has no archer, so all units roll in one
   simultaneous step. Revisit if the 7-unit roster lands.
2. **Outnumber bonus does not apply while assaulting unbreached walls**
   (`outnumberVsWalls: false`) — numbers give no frontage on an escalade.
3. **Garrisons behind unbreached walls do not rout**
   (`defenderRoutsBehindWalls: false`) — they have nowhere to flee.
4. **Battlement cover** (`wallCoverSaveOn: 3`): while the walls stand, each
   hit on the garrison is deflected on 1d6 ≤ 3. Without this, the clamp
   floor (everything hits on 6s) lets a 12-stack grind out a 6-man garrison
   through intact Theodosian walls ~6% of the time, violating T5a (<2%).
   Board implementation: "while the walls stand, garrison casualties are
   ignored on 1-3".

Gap-fills 2-4 exist because canon's clamp floor saturates: against a
professional (CV def 3) garrison, wall tiers +2/+3/+4 all clamp the defender
to 2+ and the attacker to 6 — tiers differentiate through wall HP (siege
length), starvation, and vs low-CV garrisons, not through assault odds.

Tactic cards remain a ±1 threshold swing. **Guardrail (rules-visible)**: a
±1 swing moves a 6v4 open-field battle 51.5% → 68.1% (attacker card) or
31.7% (defender card) — the physical rules must cap tactic cards at ONE per
side per battle; the full-game sim does not model tactic-card actions.

## Walls & sieges (canon §8, rulings R2 + R3)

- Wall table (canon §8.1): tier bonus `[0, +2, +3, +4]`, wall HP
  `[0, 6, 10, 16]`. Sim tier 3 = Theodosian-class great walls;
  Constantinople starts there (16 HP, +4). The defender bonus is **binary**:
  full while wall HP > 0, zero at breach (no linear scaling — canon).
- Siege procedure per round while an army besieges a walled province:
  1. **Bombardment** (canon §8.2.2): each siege engine rolls 1d6 → 1-2 = 1,
     3-4 = 2, 5-6 = 3 wall HP; at most `maxEffectiveEngines` (3) engines
     count (sim divergence — canon is uncapped). **Ruling R2**: ordinary
     engines deal `theodosianEngineDamageMult` (0) × damage to
     Theodosian-class walls — only the **Great Bombard** cracks them.
  2. **Starvation** (canon §8.2.3): the city holds `grainStoresRounds` (3)
     siege rounds; once stores are gone the garrison loses
     `starvationUnitsPerRound` (1) unit per round, weakest first.
     **Sea resupply (ruling R3)**: a besieged COASTAL walled city whose
     adjacent sea zones are NOT all enemy-controlled refills its stores
     every round and never starves. **Blockade** requires hostile galley
     superiority in EVERY adjacent sea zone (in the full game: attacker
     galleys in owned ports coasting the zone + the siege camp's galleys
     vs the defender's, including the garrison's own harbor fleet).
     Landlocked cities are always fully invested. Blockade-then-starve is
     the intended naval-siege interplay — this is why Venetian/Genoese/
     Ottoman fleets matter.
  3. Besieger loses 3% per round to disease (sim divergence; canon has no
     besieger attrition — kept as the anti-infinite-siege pressure).
  4. The attacker may **assault** at any time: current wall bonus applies to
     the defender, **escalade −1** to the attacker while walls are
     unbreached (canon §8.2.4), plus gap-fills 2-4 above.
- Wall repair (+1 HP/round out of siege, canon §8.2.5) is NOT modeled; wall
  damage persists between sieges.
- **The Great Bombard (ruling R2)**: unique siege engine entering via the
  Era III event card **`great-bombard-forged`**, revealed at round
  `availableFromRound` (9). From then on the FIRST faction to spend a build
  action + `goldCost` (40) owns the one and only Bombard. It deals a flat
  `damagePerRound` (6) wall HP per siege round (ignores Theodosian
  resistance): intact Theodosian walls (16 HP) breach during siege round 3.
- Consequence (calibrated, T5 — see results/siege.json):
  (a) direct assault on intact Theodosian walls: ≤ ~0.2% win for any
  attacker stack 1-12 vs garrisons 6-10; (b) without the Bombard and
  without a blockade Constantinople is UNTAKEABLE (sea resupply + engine
  immunity ⇒ 0% in 12 siege rounds); (c) with a full blockade the city
  starves out with median capture at siege round 7/9/11 for garrisons
  6/8/10; (d) with the Bombard the walls fall round 3 and capture lands in
  siege rounds 3-4 with 86-100% probability — a round-12-to-14 fall of the
  City, matching the 1453 anchor.

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
- **Overland caravan routes** (rules-visible): routes marked
  `overland: true` connect two land provinces (endpoints need not be ports),
  cross no sea zones, and can never be blockaded by fleets. Authored: the
  Buda-Ragusa and Buda-Venice corridors (landlocked Hungary's trade access)
  and the Bursa-Ankara Silk Road terminus (Ottoman caravan trade).
- Faction flavor multipliers (`CONFIG.factions`): Ottomans pay 75% for all
  troops; Hungary pays 50% for levies and recruits +2 levies per recruit
  action; Byzantium's capital yields +2 extra gold/round while held.
- Map ownership notes (1438 setup): Salonica (Venetian 1423-30, Ottoman
  after) and Trebizond (the separate Komnenos empire) are **neutral key
  cities**, not Byzantine — Byzantium starts as the historical rump state:
  Constantinople, Morea, Mesembria.
- Starting treasuries/garrisons (`map.ts FACTION_STARTS`) are tuned so grain
  upkeep ≈ starting grain income (±2, coverable via the grain market).
- Neutral provinces defend with `2 + 2×wallTier` levies (+2 professionals in
  key cities).

## Prestige & victory (ruling R4: union of sim track + canon §13.1 sources)

- Per round-end **income** (canon §13.1 values):
  - **own capital held: +1** (canon)
  - **each enemy capital held: +3** (canon)
  - **each key city held: +1** (canon; was 1.5 pre-swap)
  - **trade monopoly** — an open route with BOTH endpoint provinces owned:
    **+2** (canon; the sim's proxy for "control both ends of a major route")
  - each open trade route: +0.6 (sim source, kept)
- One-off (sim conquest/wars-won track, kept per R4): great work +5, war
  won +6, secret objective +6, **province capture +2**, **key-city capture
  +5** (sack/triumph, applies against neutrals too).
- NOT modeled from canon §13.1: royal marriage (+2/round to both partners
  while it holds — diplomacy is not simulated), decisive battle (+1),
  betrayal (−2…−4), lose-your-capital (−3). **Marriage sensitivity note**:
  a standing marriage is worth up to +2/round ≈ +24-32 over a full game —
  comparable to holding 2 key cities. When diplomacy lands in the engine,
  the victory threshold must be re-swept; treat the sim's threshold as
  calibrated for a marriage-less table. Turn-order-by-prestige catch-up
  (§13.4) is also unmodeled (the sim uses fixed rotating seat order).
- Win immediately at `victoryThreshold` prestige, else highest prestige
  after round 16. **The threshold number is owned by the tuning report**
  and MUST be recalibrated against the new kernel + sources (the pre-swap
  70 is now too low: capitals/monopolies add ~1.5-4 prestige/round/player).
- **Sudden death**: hold Constantinople for 2 consecutive full rounds → win
  (canon §13.3; sim checks non-Byzantine holders).

## Deliberate simplifications (v1)

- One global event per round, no event hand management (canon: per-player
  era-weighted Omen draws with persistent cards). The great-bombard-forged
  card is the one deterministic "era card" the sim models.
- Diplomacy modeled as a policy action (non-aggression targeting), no formal
  alliance rules, no marriage (see sensitivity note above).
- Tactic cards abstracted to a ±1 threshold swing (see guardrail above).
- Movement is 1 province (or 1 sea zone per galley move) per move action;
  sea transport requires 1 galley per 2 land units (assumption).
- No standing at-sea fleets: sea-zone control is computed from galleys in
  ports coasting the zone (+ siege-camp fleets). Canon's blockade/escort
  duels (§5.3, §7.6) reduce to this superiority count.
- Secret objectives modeled as "hold N specific provinces by round R"
  checks. Observed completion rate in full games is ≈0% — the objective
  mechanic likely needs a redesign (see TUNING_LOG round 1).
- Scripted agents refuse to besiege a Theodosian-class fortress (intact
  wall bonus ≥ 4) until they own the Great Bombard, matching the siege
  module capture curves; rushers garrison threatened core provinces before
  attacking and open trade routes with idle actions.
