# RULES_MODEL — assumptions the balance sim makes

This documents every mechanic as the simulation implements it, so the engine
team can diff it against the real rules. All numbers live in
`src/rules.ts` (`CONFIG`); this file explains the *shape* of each mechanic.

**CANON = the FINAL docs at commit `2b42386` on `feature/design-and-scaffold`**:
`docs/GAME_DESIGN.md` (GD), `docs/FACTIONS.md`, `docs/MAP.md`,
`docs/EVENT_CARDS.md`. Section references (§) point to GD unless noted.
This revision is the **final canon re-derivation** (coordinator rulings
R1-R11, 2026-07-11): per-unit d6 kernel with per-faction unique-unit CVs,
walls T1-T5, the 23 ratified tactic cards, sea resupply, the Great Bombard
omen, and the canon §13.1 prestige table.

## Round structure (16 rounds, 1400–1453; §10)

1. **Omen** — exactly ONE event card per table per round (§12). Model: an
   abstract card with a kind (`gold | grain | units | prestige`), a target
   (`all | random | leader`), and a uniform-random magnitude within
   `CONFIG.events` bounds (the three era decks and persistent cards are not
   itemized). **Era III**: when round `siege.greatBombard.availableFromRound`
   (11 — Era III opens at round 11, §12) begins, the omen
   **`great-bombard-forged`** (EVENT_CARDS #34) resolves — see "Great
   Bombard" below. *AI-knowledge simplification*: the 4–5-player face-up
   "gathering omen" preview (§12) is unmodeled — scripted agents gain no
   information from omens either way.
2. **Income & upkeep** — each faction collects province yields (+ market
   buildings, + trade routes × faction trade multiplier, + capital bonus),
   then pays upkeep from its per-faction unit tables: **grain per unit**
   (§4.4; mercenaries ×2 grain per §6.2; Ottoman levies 0 grain per
   FACTIONS "Devshirme") and **gold donatives** for gold-paid elites
   (Janissaries, Black Army — FACTIONS). Unpaid mercenaries desert FIRST
   (§4.4), then unfed units desert lowest-value first. Treasury never goes
   negative (`goldFloor`). **Skeleton-garrison rule (rules-visible)**:
   peacetime desertion (and negative unit events) never removes the LAST
   combatant of a walled province's garrison — an insolvent power cannot
   lose a fortress to a walk-in occupation. Siege starvation is unaffected.
   Each faction also **draws 1 tactic card** in this window (§7.7).
3. **Actions** — exactly **4 actions** per player (§10.0), any mix and
   order (not phase-gated): recruit / move-attack / build / trade / pass.
   Cards that raise the allotment to 5 are unmodeled (sensitivity note:
   +25% tempo for the holder in those rounds). Recruit caps per action are
   `recruit.perAction`; mercenaries muster instantly (§6.2); all other
   units arrive at end of round.
4. **Battles resolve**, then sieges advance, then **Cleanup**: prestige
   scoring, war-quiet peace checks, and **ALL victory checks** (threshold
   crossing, sudden-death hold counting, round-16 scoring) happen at
   Cleanup only (§13.2, §10 phase 5).

## Units (5-slot roster ← canon GD §6.1 + FACTIONS unique-unit mapping)

Base tables (neutral garrisons use these):

| sim unit | canon base | CV atk/def | cost | upkeep |
|---|---|---|---|---|
| levy | LEVY | 1/1 | 2g | 1 grain |
| professional | INFANTRY | 2/3 | 4g | 1 grain |
| mercenary | hired free company at CAVALRY stats, §6.2 merc terms | 3/2 | 9g (= 6g × 1.5) | 4 grain (= 2 × 2) |
| siegeEngine | SIEGE | 0/0 (+3 vs walls) | 8g + 2 timber + 2 marble | 1 grain |
| galley | GALLEY | 2/2 | 5g + 2 timber | 1 grain |

**Per-faction overrides** (`CONFIG.factionUnits`; FACTIONS: a unique unit
uses base stats "unless its entry says otherwise" — entries that say
otherwise are modeled as CV/cost deltas):

| faction | slot | represents | override |
|---|---|---|---|
| byzantium | professional | Varangian Guard | CV 2/**4**, 6g (elite, expensive, wall-defense) |
| ottomans | levy | devshirme levies | **0 grain** upkeep ("cost −1 grain to sustain"); +2 levies per recruit action (raised anywhere) |
| ottomans | professional | Janissary | CV **3**/3, 5g, paid **1 gold** (0 grain) — donative pay |
| venice | galley | Galeazza / Arsenal | CV **3/3**, timber cost −1 |
| genoa | professional | Genoese Crossbowmen | 3g (ARCHER base cost), CV 2/**2** — the §7.2 ranged first-strike and "wall defense" folded into CV (no ranged pre-step in the kernel) |
| genoa | mercenary | Mercenary Brokers | **6g** — the ×1.5 surcharge WAIVED (not a discount; bid market unmodeled) |
| genoa | galley | Carrack | CV 2/**3** |
| hungary | levy | "Strongest Levies" | CV **2/2**, **1g** (canon: +1 combat, −1 gold) |
| hungary | professional | Black Army | CV **3**/3, 5g, paid **1 gold** (0 grain) |

Not statted as separate slots: ARCHER (folded into Genoa's professional),
CAVALRY (the mercenary slot carries the shock-cavalry role; Ghazi Akıncı /
Stradioti / Banderial Knights start-of-game cavalry maps to professional),
WARSHIP (blended into the galley slot; Venetian/Genoese overrides carry the
Galeazza/Carrack edge). Cavalry charge/pursuit, Greek-Fire Dromon, and
Crossbowmen brokerage income are unmodeled (divergence appendix).

## Combat (src/combat.ts) — CANON KERNEL (§7)

Per battle round:

- **Every combatant unit rolls 1d6** and hits on
  `roll >= clamp(7 − CV − mods, 2, 6)` (§7.1). CV comes from the side's
  per-faction table (`mods.attackerFaction` / `defenderFaction`; null =
  neutral base table). Combatants = levy + professional + mercenary +
  galley; siege engines never roll in the field.
- **Modifiers act in threshold space** (each +1 = hit one pip easier):
  - attacker: amphibious/strait `riverCrossingPenalty` −1 (§7.3), escalade
    −1 when assaulting unbreached walls (§8.2.4);
  - defender: terrain +1 in hills/mountains/forest (§7.3), wall bonus
    (binary, see walls), Hexamilion card +2;
  - **outnumbering 2:1 in a round grants the larger side +1** (§7.3).
- **Siege engines in an escalade** (§6.1 "SIEGE +3 vs walls"): while the
  attacker assaults UNBREACHED walls (wallBonus > 0), each siege engine
  rolls at CV 0 + `siegeEngineEscaladeBonus` (3). At field odds (breach,
  §8.2.4) they are idle, per the §6.1 field rule.
- **Tactic cards** (§7.7) enter the kernel as `*ExtraDice` ("+N dice",
  rolled in the melee step at the side's best participating threshold —
  canon: threshold of one participating unit of your choice) and
  `*Rerolls` (N missed dice rerolled once each per round, same threshold);
  `*FirstRoundOnly` models "in one round of..." cards (played round 1).
- **Both sides roll simultaneously**; each hit removes one enemy unit,
  lowest-value first: levy → professional → mercenary → galley (§4.4 value
  order; canon lets the loser choose — the sim fixes the default).
- **Rout (§7.5)**: a side that has lost ≥ 50% (`routLossFraction`) of its
  starting stack rolls 1d6 each round and routs on ≤ 3 (`routOn`).
  Survivors disperse (no retreat pathing). If both would rout, the
  defender holds. Cavalry pursuit and ±1 morale effects are unmodeled.
- The attacker voluntarily withdraws at ≤ 35% (`retreatFraction`) of its
  starting combatants; battles cap at `combat.maxRounds` (stalemate).
- `BattleResult.decisive` = the loser was wiped or routed (feeds the §13.1
  decisive-battle prestige); withdrawals are not decisive.
- Naval battles use the same kernel with galley CVs and no terrain/walls.

**Canon gaps filled (kernel-level, CONFIG-switchable):**

1. **No ranged pre-step** — canon §7.2 gives ARCHER (and SIEGE in sieges)
   a pre-melee volley; the 5-slot roster has no archer, so all units roll
   in one simultaneous step (Genoa's crossbow CV override compensates).
2. **Outnumber bonus does not apply while assaulting unbreached walls**
   (`outnumberVsWalls: false`) — numbers give no frontage on an escalade.
3. **Garrisons behind unbreached walls do not rout**
   (`defenderRoutsBehindWalls: false`) — they have nowhere to flee.
4. **Battlement cover** (`wallCoverSaveOn: 3`): while the walls stand, each
   hit on the garrison is deflected on 1d6 ≤ 3. Without this, the clamp
   floor (everything hits on 6s) lets a 12-stack grind out a small garrison
   through intact Theodosian walls well above the T5a 2% ceiling.
   Board implementation: "while the walls stand, garrison casualties are
   ignored on 1-3". Applies at every tier, so intact-wall assaults at ANY
   tier are strongly gated toward breaching first.

Gap-fills 2-4 exist because canon's clamp floor saturates: against a
professional (CV def 3) garrison, wall tiers +2/+3/+4 all clamp the defender
to 2+ and the attacker to 6 — tiers differentiate through wall HP (siege
length), starvation, and vs low-CV garrisons, not through assault odds.

## Tactic cards (§7.7) — the 23 RATIFIED designs

`CONFIG.tacticCards` encodes all 23 ratified designs at their FINAL
magnitudes; the deck is 47 cards (Common ×3 / Uncommon ×2 / Rare ×1),
seeded-shuffled, discards reshuffled, `remove from game` respected
(Greek Fire, Treason at the Gate).

**Full-game bounded policy (documented simplifications):**

- 1 draw/faction/round in the Income window (University +1 / Great
  University +2 draws unmodeled). Hand cap 4; overflow discards the
  lowest-priority card (canon discards at Cleanup).
- **Instant resource cards resolve on draw** (Counting-House +2g, Grain
  Barges +2 grain, Papal Indulgence 2g→3 faith, Pay Chest steals up to 3g
  from the prestige leader).
- In each battle/assault, a side plays its **single best applicable card**
  (priority-ordered, costs paid) — at most ONE card per side per battle;
  canon allows one per battle ROUND, so the sim slightly under-plays cards.
  **The Intercepted Letter** is a reaction: it cancels the rival's played
  card (both discarded) and is exempt from the one-card limit.
- Effects modeled per card: Veterans of the Border / Pilot (+1 die),
  Condottieri Contract (+2 dice, 2g), Holy War Proclaimed (+1 die, 2 faith
  — canon grants it for EVERY battle until your next turn; modeled as one
  battle, an underestimate), Locked Shields (reroll 1/round on defense),
  Ladders and Fascines (reroll 1, first round of an assault), The White
  Knight's Stroke (reroll 3, first round), The Bribed Gatekeeper (wall
  bonus 0 for one assault; escalade −1 still applies), The Hexamilion
  Manned (defender +2 in an unwalled province), Night Sortie (siege round:
  no store depletion, besieger −1 unit), Sails from the West (no depletion
  even under full blockade, +2 stores restored), Treason at the Gate (4g
  after 2+ siege rounds: the city falls, card removed from game).
- **Unmodeled (dead draws, still occupy deck/hand slots)**: Forced March
  (movement rider), The Pilot of the Narrows (fleet battles — the sim has
  no pure fleet battles; note: this is a Common ×3), Ears in the Bazaar
  (hidden information), Feigned Retreat (pre-dice withdrawal), Chain
  Across the Horn (amphibious denial), Greek Fire (fleet auto-win),
  A Death in the Palace (truce). 15 of 47 cards are dead in the sim —
  the measured card-layer impact is therefore a mild UNDERestimate.
- Combat-MC evidence (results/combat.json): the modifier sets
  `attVeterans` (+1 die, the median ratified combat card),
  `attCondottieri` (+2 dice, the strongest straight dice card),
  `defLockedShields` (defensive reroll) and `bribedGatekeeperT3` (wall
  bonus zeroed on a T3 assault) quantify the ratified magnitudes.

## Walls & sieges (canon §8) — T1-T5

- **Wall table (§8.1), five tiers**: bonus `[+1, +2, +3, +4, +4]`, HP
  `[3, 6, 10, 13, 16]` for T1..T5. **T5 = the Theodosian Walls**
  (Constantinople starts there; Belgrade and Rome are authored T4). The
  defender bonus is **binary**: full while wall HP > 0, zero at breach.
  The Build action upgrades walls to at most **T3** (§9.1 Walls Lv2);
  T4/T5 are authored (the Theodosian great work is not buildable in-sim).
  Wall repair out of siege (+1 HP/round, §8.2.5) is NOT modeled; damage
  persists between sieges.
- Siege procedure per round while an army besieges a walled province:
  1. **Bombardment** (§8.2.2): each siege engine rolls one wall-damage die
     (1-2→1, 3-4→2, 5-6→3 HP); at most `maxEffectiveEngines` (3) engines
     count (sim divergence — canon is uncapped). **T5 masonry (§8.3)**:
     against an intact tier-5 wall an ordinary train inflicts at most
     `t5MasonryCapPerRound` (1) HP per round IN TOTAL — sixteen rounds to
     open the Theodosian circuit, i.e. effectively unbreachable.
  2. **Starvation** (§8.2.3): the city holds `grainStoresRounds` (3) siege
     rounds (Granary +2 unmodeled); at 0 stores the garrison loses 1
     unit/round, weakest first. **Sea resupply (§8.2.3)**: a besieged
     COASTAL city depletes stores ONLY while under naval blockade =
     hostile fleet control of EVERY adjacent sea zone; otherwise stores
     refill and hunger never begins. In the full game, zone control =
     attacker galleys (owned ports coasting the zone + siege-camp fleets)
     strictly exceeding the defender's, per zone. Landlocked cities are
     always fully invested. Blockade-then-starve is the intended
     naval-siege interplay — Venetian/Genoese/Ottoman fleets (and the
     naval CV overrides) are the key to Constantinople.
  3. Besieger loses 3% per round to disease (sim divergence; kept as the
     anti-infinite-siege pressure).
  4. The attacker may **assault** at any time: full wall bonus to the
     defender while HP > 0 plus **escalade −1** to the attacker (§8.2.4);
     at 0 HP (breach) the fight is at field odds. Siege engines add their
     §6.1 "+3 vs walls" dice during an escalade.
- **The Great Bombard (GD §8.4, EVENT_CARDS #34)**: unique, one per game,
  never recruited. Enters when the Era III omen `great-bombard-forged`
  resolves (round `availableFromRound`, 11): the **Ottoman player receives
  it FREE if alive** (canon); otherwise it is auctioned — sim rule: the
  richest faction able to pay `goldCost` (40) takes it (retried each round
  while unclaimed; `actBuyBombard` is the explicit fallback). It rolls
  **2 wall-damage dice** per siege round (~4 HP avg, max 6) and **lifts the
  T5 masonry cap for the whole besieging train**. In the full game its
  owner deploys it at their most valuable siege (Constantinople first).
  Unmodeled: 3-grain upkeep/silence, 1-province movement, no-mountains,
  sink-on-transport-loss, capture-as-loot (it stays with its owner).
- **Byzantine unique power NOT modeled**: FACTIONS gives Constantinople an
  auto-repel of the first two siege rounds (no bombardment damage). This
  would push the T5d capture window from ~2-4 to ~4-6 siege rounds —
  flagged as a sensitivity note for the engine team; the T5 targets were
  calibrated without it per the coordinator's target spec.
- Calibrated consequence (full-scale results/siege.json, 20k iters/cell):
  (a) direct assault on the intact T5 walls: ≤ ~0.1% win for any stack
  1-12 vs garrisons 6-10; (b) no Bombard + no blockade: 0% capture within
  12 siege rounds (sea resupply + masonry cap); (c) no Bombard + full
  blockade: starve-out works (≥ 99%), median capture at siege round 7/9/11
  for garrisons 6/8/10; (d) with the Bombard: breach on siege round 2 and
  capture within 2-4 rounds with ≥ 95% probability — a round-13-to-15 fall
  of the City when the omen lands at round 11, matching the 1453 anchor.

## Economy & map

- Resources: gold, grain (core); timber, marble, faith (secondary).
  Recruiting pays canon resource costs (siege engines timber+marble,
  galleys timber). Province yields are authored in `map.ts` within
  `CONFIG.yields` bounds.
- Buildings (one action + costs): **market** (+2 gold/round in province),
  **wall upgrade** (+1 tier, max T3), **great work** (one-off +5 prestige —
  the sim's generic stand-in for the §9.2 Great Works, which canon scores
  at +5..+10 and gates behind multi-round builds; multi-round investment
  unmodeled).
- Trade routes are authored port-pairs in `map.ts` with a gold income and a
  sea-zone path; an enemy fleet in any zone on the path cuts the route
  (`blockadeCancels`). A faction profits from at most `maxRoutesPerFaction`
  (3); **Venice and Genoa ×1.5** (canon §5.2 merchant bonus). The full §5.2
  route-income formula (port tiers, per-hop control) stays unmodeled
  (divergence appendix).
- **Overland caravan routes** (rules-visible, Hungary-floor option A):
  routes marked `overland: true` connect land provinces, cross no sea
  zones, and can never be blockaded by fleets. Authored: Buda-Ragusa,
  Buda-Venice, Bursa-Ankara.
- **Faction sheets = canon FACTIONS.md**: starting provinces (mapped ids:
  selymbria→mesembria, thessalonica→salonica, dalmatia→zara, konya→karaman,
  kaffa→caffa; bithynia folded into nicaea; canon-absent filler provinces
  start Independent), canon treasuries (gold/grain/timber/marble/faith)
  and starting armies (cavalry→professional, war/merchant galleys→galley).
  Wall tiers follow MAP.md's walled-cities table (Constantinople T5,
  Belgrade/Rome T4, etc.). Byzantium keeps `capitalExtraGold` 2 (Hagia
  Sophia income proxy); Ottomans get `cityCapturePrestige` +1 (Ghaza).
- Neutral provinces defend with `2 + 1×wallTier` levies (+2 professionals
  in key cities) — a coarse stand-in for MAP.md §5's minor-state garrisons.
- NOT modeled (divergence appendix, R10): mercenary bid market auctions,
  spies, NPC vassals (vassal income = province yields ×0.5 uniform),
  tax postures, 3:1/2:1 market ratios (the sim uses flat
  `grainMarket` buy/sell rates), canon trade formula details.

## Prestige & victory (canon §13.1 at 2b42386)

- Per round-end **income**: own capital +1; each enemy capital +3; each
  key city +1; trade monopoly (open route with BOTH endpoints owned) +2.
  Per-route prestige is 0 (canon has none; `tradeRoutePerRound` kept as a
  lever).
- One-off **conquest/wars track**: decisive battle (loser wiped/routed) +1;
  win a field battle outnumbered +1 (stacks); take a walled city BY FORCE
  (storm, starvation, or treachery — walk-ins score nothing) +2, or +3 for
  T4-T5; win a war +3 (war goes quiet with a net-capture lead, or a player
  is eliminated); lose your own capital −3; great work +5.
- **Secret objectives: +4 each, scored at GAME END only** (canon §13.1) —
  they count for the round-16 highest-prestige comparison and can never
  trigger an early threshold win. Sim objective = hold 3 seeded nearby
  provinces at game end. The pacing model applies the same end-scoring.
- NOT modeled: royal marriage (+2/round to both — worth up to ~+24-32 over
  a game; re-sweep the threshold when diplomacy lands), betrayal penalties,
  spy prestige losses, ±1 morale effects, turn-order-by-prestige catch-up
  (§13.4 — fixed rotating seat order instead).
- Win at `victoryThreshold` prestige **checked at Cleanup only**, else
  highest prestige after round 16. **The threshold number is owned by the
  TUNING_REPORT** (canon §13.2's 35 is a pre-tuning placeholder; the
  current 70 predates the canon-source re-derivation and WILL move).
- **Sudden death**: a non-Byzantine power holding Constantinople through 2
  consecutive Cleanups wins immediately (§13.3).

## Deliberate simplifications (v1)

- One abstract omen per table per round; era decks/persistent cards are not
  itemized (the great-bombard omen is the one modeled era card).
- Diplomacy: no alliances/NAPs/marriage/tribute; wars are implicit.
- Movement is 1 province (or 1 sea hop between ports) per move action; sea
  transport needs 1 galley per 2 land units (assumption).
- No standing at-sea fleets: sea-zone control is computed from galleys in
  ports coasting the zone (+ siege-camp fleets). Canon's blockade/escort
  duels (§5.3, §7.6) reduce to this superiority count; there are no pure
  fleet battles (hence Pilot of the Narrows / Greek Fire are dead cards).
- Secret objectives modeled as "hold 3 specific provinces at game end".
- Scripted agents refuse to besiege an intact T5 fortress until they own
  the Great Bombard, matching the siege-module capture curves; rushers
  garrison threatened core provinces before attacking and open trade
  routes with idle actions.
