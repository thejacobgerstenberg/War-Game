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
omen, and the canon §13.1 prestige table — **plus the RATIFIED ERRATA E1-E5
(coordinator, 2026-07-11)**: E1 Treason-at-the-Gate gates (garrison ≤ 4,
siege clock counts only from game round 6), E2 diminishing monopoly prestige
(+2 first / +1 additional), E3 the Great Bombard canon draw model (per-game
seeded omen draw uniform over rounds 11-16) + 1-round emplacement, E4 three
independent secret objectives (+4 each), E5 betrayal/aggression costs
(unjustified-war −1 prestige; mercenary-revolt pillage on unpaid desertion).

## Round structure (16 rounds, 1400–1453; §10)

1. **Omen** — exactly ONE event card per table per round (§12). Model: an
   abstract card with a kind (`gold | grain | units | prestige`), a target
   (`all | random | leader`), and a uniform-random magnitude within
   `CONFIG.events` bounds (the three era decks and persistent cards are not
   itemized). **Era III / RATIFIED ERRATA E3 (2026-07-11)**: the omen
   **`great-bombard-forged`** (EVENT_CARDS #34) sits in the Era III deck at
   a uniformly random position — modeled as a per-game seeded draw round
   uniform over `[greatBombard.drawRoundMin, drawRoundMax]` = rounds 11-16
   (canon §12 Era III). This REPLACES the previous fixed r15 reveal (which
   was itself a tuning divergence from canon's r11 Era III opening); the
   sudden-death band is re-held instead by E3's 1-round emplacement, the E1
   treason gates, and the re-derived threshold (see TUNING_LOG errata
   round). See "Great Bombard" below. *AI-knowledge simplification*: the 4–5-player face-up
   "gathering omen" preview (§12) is unmodeled — scripted agents gain no
   information from omens either way. **Unit-loss guardrail**: a negative
   units omen never empties a garrison (leaves ≥ 1 combatant), and leaves
   **≥ 3 combatants in a walled capital or any besieged walled city** — a
   one-card plague must not convert a round-1 siege of Constantinople into
   a round-2 escalade + sudden death (adversarial fix round; artifact of
   the one-card event abstraction, see GUARDRAILS).
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
   lose a fortress to a walk-in occupation. **RATIFIED ERRATA E5b
   (2026-07-11; canon EVENT_CARDS #22 "Mercenary Revolt" pillage
   semantics)**: whenever unpaid/unfed MERCENARIES desert, they revolt and
   **pillage their host province** — the owner loses
   `economy.mercRevolt.pillageGold` (2) stored gold per pillaged province
   and the province **yields nothing next round**
   (`ProvinceState.pillagedUntilRound`). Deserting SIEGE-CAMP mercenaries
   have no host province of their owner to raze: only the gold is lost
   (documented gap — canon does not place camps in the pillage text).
   Gold-paid elites (Janissary/Black Army) deserting unpaid do NOT pillage
   (the errata scopes the revolt to mercenaries; canon card #22 also names
   elite pay — flagged as a residual gap for the engine).
   **Besieged walled garrisons
   are exempt from insolvency desertion entirely** (adversarial fix
   round): canon §8.2.3 makes the siege's stores/hunger clock the sole
   source of garrison hunger — a sea-resupplied city is fed by the supply
   ships, and a blockaded one already starves 1 unit/round. Without the
   exemption, the owner's treasury shortfall (worsened by the siege
   freezing the city's own income) deserted the garrison out from behind
   intact Theodosian walls, a back-door starvation the blockade rules
   forbid. Siege starvation is unaffected.
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
   Cleanup only (§13.2, §10 phase 5). Cleanup then **re-sorts turn order
   so the lowest-prestige power acts first** next round (canon §13.4
   catch-up lever; tiebreak: fewer provinces, then previous order) —
   modeled since the adversarial fix round (previously a fixed rotating
   seat order, a documented divergence).

## Player counts 2–5 (`Game` seat subsets; used by `src/run/thresholds.ts`)

- The engine supports **2–5 seated players** (`CONFIG.game.playersMin/Max`).
  `Game`'s `seatOrder` selects WHICH factions are seated: any faction absent
  from `seatOrder` is **unseated** — it never acts, holds no provinces, draws
  no cards, and is excluded from every victory comparison. Passing all five
  factions reproduces the 5-player game **bit-identically** (verified against
  the committed 3,000-game `results/fullgame.json`).
- **Unseated factions' starting provinces become independent/neutral
  garrisons under the exact same neutral rules as every other independent
  province** (`CONFIG.neutrals`: base levies + levies per wall tier +
  professionals if key city — NOT the faction's authored setup armies).
  Modeling choice, documented for the engine team: canon has no setup text
  for absent great powers; treating their homelands as ordinary minor powers
  (garrisoned, conquerable by force for the usual walled-capture prestige,
  yielding nothing to anyone until taken) is the smallest-rules reading and
  keeps the map economy comparable across player counts.
- **Sudden death is unchanged** (a non-Byzantine power holding
  Constantinople through 2 consecutive Cleanups wins immediately, §13.3),
  whether or not Byzantium is seated. In Byzantium-absent games
  Constantinople starts as a **neutral T5 fortress** (Theodosian walls +
  neutral garrison) — still a sudden-death target, just independently held.
- The Great Bombard omen grant falls back to the auction (richest payer)
  when the Ottomans are unseated, same as when they are eliminated.
- **Victory threshold is per player count** — see TUNING_REPORT §2.13
  `VICTORY_THRESHOLD_BY_PLAYER_COUNT` and `results/thresholds.json`
  (faction-subset sweep protocol: all C(5,n) subsets × seat rotations).
  2–4-player games were tuned for PACING ONLY; per-faction win-rate balance
  at 2–4 players was never a tuning target (TUNING_REPORT §2.13 caveats).

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
  Canon instead retreats routed units to an adjacent friendly/empty
  province — capped (per the engine's 2026-07-11 fix) by the
  destination's remaining §6.4 stacking headroom, with the overflow
  surrendering; see "Deliberate simplifications" for the measured
  exposure of skipping both halves.
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
  University +2 draws unmodeled). Hand cap 3 (RATIFIED, engine
  reconciliation 2026-07-11 — GD §7.7's "4" is a docs error); overflow
  discards the lowest-priority card (canon discards at Cleanup).
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
  even under full blockade, +2 stores restored), Treason at the Gate (4g:
  the city falls, card removed from game — **RATIFIED ERRATA E1
  (2026-07-11)**: playable only against a garrison of **≤ 4 units**, and
  its 2-consecutive-siege-round requirement counts **only siege rounds
  occurring in game round 6 or later** (`maxGarrison` /
  `siegeRoundsCountFromGameRound` on the card def; the engine tracks
  `Siege.treasonRounds`). This is the register-item-1 errata, ratified and
  re-measured — beeline SD 22.6% → 16.2%, ≤r8 15.0% → 8.3%, guard arm
  23.8% → 7.3%).
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
     hostile fleet control of EVERY adjacent sea zone. In the full game a
     zone is enemy-controlled per **canon §8.2.3 RAW: an enemy war fleet
     PRESENT and UNCONTESTED by a friendly war fleet** — any friendly
     galley near the zone (the city's own harbor fleet, or a squadron in
     a friendly port coasting the zone) contests it and keeps the supply
     lane open (adversarial fix round; the previous strict-superiority
     gap-fill let 2 siege-camp galleys "defeat" a defending harbor galley
     without the §7.6 naval battle canon requires, handing navy-poor land
     powers a full blockade of Constantinople from the camp itself).
     Consequence of the no-fleet-battles simplification: starving a
     defended harbor first requires eliminating its fleet through assault
     or the hunger clock (galleys die last, §4.4 order) — the sim
     under-produces blockades against fleet-holding ports; the siege
     module (results/siege.json) still measures the fully-blockaded case
     directly. Landlocked cities are always fully invested.
     **Harbor reinforcement (§8.2.3 corollary, `Game.harborOpen`)**: while
     a besieged coastal walled city is NOT under full blockade, its owner
     may still RECRUIT inside it and FERRY troops in by a sea move (the
     historical Giustiniani relief); only a full blockade (or a landlocked
     siege) seals the city — this makes the navy the real contest for
     Constantinople, per the §8.2.3 design-intent note.
  3. Besieger loses 3% per round to disease (sim divergence; kept as the
     anti-infinite-siege pressure).
  4. The attacker may **assault** at any time: full wall bonus to the
     defender while HP > 0 plus **escalade −1** to the attacker (§8.2.4);
     at 0 HP (breach) the fight is at field odds. Siege engines add their
     §6.1 "+3 vs walls" dice during an escalade.
- **The Great Bombard (GD §8.4, EVENT_CARDS #34; RATIFIED ERRATA E3,
  2026-07-11)**: unique, one per game, never recruited. Enters when the
  Era III omen `great-bombard-forged` resolves — **canon draw model**: the
  card occupies a uniformly random position in the Era III deck, modeled
  as a per-game seeded draw round uniform over rounds 11-16
  (`Game.bombardDrawRound`, its own RNG fork). The **Ottoman player
  receives it FREE if alive** (canon); otherwise it is auctioned — sim
  rule: the richest faction able to pay `goldCost` (40) takes it (retried
  each round while unclaimed; `actBuyBombard` is the explicit fallback).
  It rolls **2 wall-damage dice** per siege round (~4 HP avg, max 6) and
  **lifts the T5 masonry cap for the whole besieging train** — but only
  once EMPLACED (**E3**): after acquisition (or after moving to a
  different siege) it is placed for **1 full siege round before it first
  fires** — no wall damage from it, and no masonry-cap lift, during the
  emplacement round (`greatBombard.emplacementRounds`, tracked in
  `Game.bombardEmplacement`; the siege module applies the same rule). In
  the full game its owner deploys it at their most valuable siege
  (Constantinople first). Unmodeled: 3-grain upkeep/silence, 1-province
  movement, no-mountains, sink-on-transport-loss, capture-as-loot (it
  stays with its owner).
- **Byzantine unique power NOT modeled**: FACTIONS gives Constantinople an
  auto-repel of the first two siege rounds (no bombardment damage). This
  would push the T5d capture window from ~2-4 to ~4-6 siege rounds —
  flagged as a sensitivity note for the engine team; the T5 targets were
  calibrated without it per the coordinator's target spec.
- Calibrated consequence (full-scale results/siege.json, 20k iters/cell,
  errata E3 curve): (a) direct assault on the intact T5 walls: ≤ ~0.3% win
  for any stack 1-12 vs garrisons 6-10; (b) no Bombard + no blockade: 0%
  capture within 12 siege rounds (sea resupply + masonry cap); (c) no
  Bombard + full blockade: starve-out works (≥ 99.9%), median capture at
  siege round 7/9/11 for garrisons 6/8/10; (d) with the Bombard:
  emplacement in siege round 1, breach in rounds 2-3, capture at median
  siege round 3 — **capture within 4 rounds of its FIRST SHOT (siege
  rounds ≤ 5) with 91.7-100% probability** (the re-derived T5d target,
  >50%). With the omen drawn uniformly r11-16, the City falls ~r13-16 —
  the 1453 anchor holds in expectation (fullgame SD completions all r12+).

## Economy & map

- Resources: gold, grain (core); timber, marble, faith (secondary).
  Recruiting pays canon resource costs (siege engines timber+marble,
  galleys timber). Province yields are authored in `map.ts` within
  `CONFIG.yields` bounds.
- Buildings (one action + canon §9.1 costs since the engine
  reconciliation): **market** (4g + 2 marble; +1 gold/round in province),
  **wall upgrade** (+1 tier at the target tier's canon cost — T1 4g/3m,
  T2 5g/4m, T3 8g/6m; max T3), **great work** (the four canon §9.2 works
  at per-work costs and per-work prestige 10/6/6/5, each work once per
  faction, built greedily cheapest-first; canon's 2-3-round investment
  schedule unmodeled — one Build action completes a work).
- **Canon §4.3 market conversion (engine reconciliation)**: a Trade action
  buys ONE secondary resource (timber/marble/faith) with gold at 3:1, or
  2:1 once the faction owns a Market (`Game.actConvert`; §10.3 RAW "one
  action per conversion" = one lot). Gold->resource direction only. Agent
  discipline: trader/opportunist convert at most 1 lot/turn, turtler 2.
- Trade routes are authored port-pairs in `map.ts` with a gold income and a
  sea-zone path. **Blockade = canon §5.2 (adversarial fix round)**: an
  at-war enemy war fleet on any route zone HALVES the route's income
  (`trade.blockadeIncomeMult` 0.5); only a SEVERED route (neither endpoint
  owned) yields 0. Monopoly prestige (§13.1) follows endpoint ownership,
  not the blockade. (The pre-fix sim cancelled blockaded routes outright —
  a single 5g picket galley deleted a trader faction, 49.8% → 0.1% win;
  see TUNING_LOG.) A faction profits from at most `maxRoutesPerFaction`
  (3); **Venice and Genoa ×1.5** (canon §5.2 merchant bonus). The full §5.2
  route-income formula (port tiers, per-hop control) and §5.3 escort-severs
  stay unmodeled (divergence appendix).
- **Overland caravan routes** (rules-visible, Hungary-floor option A —
  ADOPTED, R9): routes marked `overland: true` connect land provinces,
  cross no sea zones, and can never be blockaded by fleets. Canon R9 makes
  them blockadable by hostile ARMIES on the path — army blockade is NOT
  modeled (routeBlockaded is naval-only): a divergence that flatters
  overland income slightly. Authored: Buda-Venice, Buda-Belgrade (both at
  income 2 = 60% floor of the R9 band vs the flagship sea income 4),
  Bursa-Ankara. Buda-Belgrade is Hungary's owned-both-ends §13.1 monopoly
  at setup — deliberate parity with venice_crete / genoa_caffa: exactly
  one setup monopoly per trade-identity faction, all further monopolies
  must be conquered (a second cheap one — e.g. the removed buda_ragusa +
  T2 Ragusa — made Hungary win 41-42% of games; see TUNING_LOG).
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
  tax postures, the resource->gold / specialty lanes of §4.3 (the
  gold->resource 3:1/2:1 direction IS modeled since the engine
  reconciliation; grain still uses the flat `grainMarket` buy/sell rates),
  canon trade formula details.

## Prestige & victory (canon §13.1 at 2b42386)

- Per round-end **income**: own capital +1; each enemy capital +3; each
  key city +1; trade monopoly (open route with BOTH endpoints owned) —
  **RATIFIED ERRATA E2 (2026-07-11): diminishing returns** — +2/round for
  the FIRST monopoly, **+1/round for each additional** simultaneous
  monopoly (`tradeMonopolyPerRound` / `tradeMonopolyAdditionalPerRound`);
  no escort requirement. Per-route prestige is 0 (canon has none;
  `tradeRoutePerRound` kept as a lever).
- One-off **conquest/wars track**: decisive battle (loser wiped/routed) +1;
  win a field battle outnumbered +1 (stacks); take a walled city BY FORCE
  (storm, starvation, or treachery — walk-ins score nothing) +2, or +3 for
  T4-T5; win a war +3 (war goes quiet with a net-capture lead, or a player
  is eliminated); lose your own capital −3; great works at canon per-work
  prestige (Hagia Sophia +10, Theodosian Walls +6, Great University +6,
  Grand Bazaar +5).
- **Secret objectives (RATIFIED ERRATA E4, 2026-07-11): THREE per faction
  (canon), +4 EACH scored INDEPENDENTLY at GAME END only** (canon §13.1) —
  they count for the round-16 highest-prestige comparison and can never
  trigger an early threshold win. Sim objective i = "hold seeded nearby
  province i at game end" (3 seeded provinces within 2 steps of the
  start); completion is tracked per objective
  (`GameResult.objectivesCompleted`, 0-3 per faction) in every game, even
  when an earlier threshold/SD win means the +4s are never scored. The
  pacing model applies the same 3-independent-objective end-scoring.
- **Turn-order-by-prestige catch-up (§13.4) IS modeled** (adversarial fix
  round): turn order re-sorts at every Cleanup, lowest prestige first
  (tiebreak: fewer provinces, then previous order).
- **RATIFIED ERRATA E5a (2026-07-11; canon §11 aggression-cost family)**:
  an attack that STARTS a war charges the aggressor **−1 prestige**
  (`prestige.unjustifiedWar`) unless justified. Canon §11's casus belli is
  richer (broken-marriage claims, seized key cities); the sim-level
  justification mapping is: (a) the target holds one of the aggressor's
  secret-objective provinces, (b) the target is the current prestige
  leader (no living faction has strictly more — canon §14 explicitly
  rewards ganging up on the leader), or (c) the target attacked the
  aggressor first at some point this game (tracked in
  `Game.attackedEver`). Attacks inside a live war are war-fighting, not
  declarations (no charge); an ongoing siege keeps its war alive, so a
  poke campaign is charged at most once per war. Alliance/NAP/marriage
  BREAK penalties (−2…−4) stay unmodeled — the sim has no treaties to
  break.
- NOT modeled: royal marriage (+2/round to both — worth up to ~+24-32 over
  a game; re-sweep the threshold when diplomacy lands), treaty-break
  betrayal penalties (no treaties in-sim), spy prestige losses, ±1 morale
  effects.
- Win at `victoryThreshold` prestige **checked at Cleanup only**, else
  highest prestige after round 16 with the **canon §13.3 tiebreak: most
  key cities, then most gold** (modeled since the adversarial fix round).
  **The threshold number is owned by the TUNING_REPORT** (canon §13.2's 35
  is a pre-tuning placeholder; current value 80 — 84 → 80 in the ratified
  errata round: the E2 monopoly nerf lowered winner accrual, see
  TUNING_LOG). Victory-check ordering: sudden death is tested
  BEFORE threshold at the same Cleanup (canon §13.3 "wins immediately,
  regardless of prestige" — flagged for design confirmation, see
  NEEDS-RULES-CHANGE).
- **Sudden death**: a non-Byzantine power holding Constantinople through 2
  consecutive Cleanups wins immediately (§13.3).

## Deliberate simplifications (v1)

- One abstract omen per table per round; era decks/persistent cards are not
  itemized (the great-bombard omen is the one modeled era card).
- Diplomacy: no alliances/NAPs/marriage/tribute; wars are implicit.
- Movement is 1 province (or 1 sea hop between ports) per move action; sea
  transport needs 1 galley per 2 land units (assumption).
- No standing at-sea fleets: sea-zone presence is computed from galleys in
  ports coasting the zone (+ siege-camp fleets). Canon's blockade/escort
  duels (§5.3, §7.6) reduce to: siege blockade = enemy fleet present AND
  no friendly fleet near the zone (canon §8.2.3 RAW contest); route
  blockade = any at-war enemy port/camp galley on a route zone, halving
  income (§5.2). There are no pure fleet battles (hence Pilot of the
  Narrows / Greek Fire are dead cards).
- **No §6.4 stacking limits** (canon: 8 land units per player per
  province, 12 in a CITY/capital, 6 naval per sea zone — "excess units
  cannot enter"): recruiting, moves, attack commits, siege camps and the
  post-battle/siege-lift `returnHome` merge are all uncapped, and the
  §7.5 rout path does no retreat pathing (see Combat above). Parity
  check vs the engine's 2026-07-11 rout-retreat fix ("retreat up to the
  destination's remaining cap, overflow surrenders"): the sim cannot
  reproduce the engine's over-stack bug — there is no cap to violate and
  no rout retreat to over-fill it — and the exact fix site is inert
  in-sim (1 of 2,074 returning land units, 0.05%, would surrender).
  The missing cap itself is exercised, though: 8.1% of committed attack
  stacks exceed the destination's cap and 35.5% of siege-camp samples
  exceed the invested city's cap (1,000 games, seed 24681357,
  `src/run/stacking_probe.ts` → `results/stacking_probe.json`).
  Divergence + sensitivity note: TUNING_REPORT §6 row 10. Deliberately
  NOT retrofitted — capping stacks invalidates the tuned big-stack
  siege/assault aggregates without an agent rework.
- Secret objectives modeled as 3 independent "hold this seeded province at
  game end" goals (+4 each, E4).
- Scripted agents refuse to besiege an intact T5 fortress until they own
  the Great Bombard, matching the siege-module capture curves; rushers
  garrison threatened core provinces before attacking and open trade
  routes with idle actions. Agents reinforce besieged sea-resupplied
  cities (recruit inside + ferry via `harborOpen`), and apply
  **leader pressure as a FEASIBILITY relaxation** (odds gates ×0.85 vs
  provinces of the prestige leader once anyone crosses 0.4× threshold) —
  the earlier ordering-only +5 target bonus was measured inert
  (runaway-leader hunt: 0.2% decision changes).

## GUARDRAILS (abstraction-artifact floors) & magnitude bounds

These are sim-only clamps that keep one-card/one-number abstractions from
manufacturing outcomes the full rules would not allow. The engine team
should NOT ship these as rules; they mark places where the sim is coarser
than the game.

- **Omen magnitudes** (`CONFIG.events`): gold ±6, grain ±4, units ±3,
  prestige ±2. Max gold swing = 0.20-0.35× a faction's mean round income
  (0.38-0.55× p10) — measured under the 1.5× "economy-warping" bar
  (adversarial economy hunt, results/adversarial_economy_exploit.json).
- **Tactic-card magnitudes** are the 23 RATIFIED designs verbatim (§7.7
  table at 2b42386) — magnitudes are fixed inputs to tuning. Measured
  combat impact: +1 die ≈ +8-11pp attacker win, +2 dice ≈ +14-16pp
  (results/combat.json attVeterans/attCondottieri vs openField).
- **Unit-loss omen floor**: ≥1 combatant in any garrison; ≥3 in a walled
  capital or besieged walled city (no plague-opens-the-gates artifacts).
- **Insolvency-desertion floor**: ≥1 combatant in walled provinces;
  besieged walled garrisons fully exempt (siege clock is the sole hunger
  source, canon §8.2.3).
- **Blockade counterplay (by construction)**: a trade blockade only halves
  route income (canon §5.2) and requires an at-war enemy fleet — income
  recovers the moment the war quiets; a siege blockade is broken by ONE
  friendly galley near either city zone (canon §8.2.3 contest), so a
  defended harbor cannot be starved without first destroying its fleet.

## NEEDS-RULES-CHANGE register (design decisions, not tunable numbers)

### RATIFIED + IMPLEMENTED (errata round, coordinator 2026-07-11)

Former register items resolved by the ratified errata E1-E5 and re-measured
at the final config (before → after; see TUNING_LOG errata round and
TUNING_REPORT §5 for the full evidence):

- **(was #1) Treason at the Gate** → **E1**: garrison ≤ 4 gate + the
  2-siege-round clock counts only from game round 6. Beeline grid:
  solo_ottoman SD 22.6% → **16.2%**, ≤r8 15.0% → **8.3%**; guard_ottoman
  23.8% → **7.3%**; all hunt-brief bars now PASS.
- **(was #2) Flat passive monopoly prestige** → **E2**: +2 first / +1 each
  additional monopoly, no escort requirement. monopolyMax Venice 66.2% →
  **57.5%**, Genoa 61.7% → **60.0%**; ceiling reduced but the trade-seat
  monoculture ceiling remains >50% (see open item 2 below).
- **(was #5a) Free perpetual war pokes** → **E5a**: unjustified war
  declaration −1 prestige. Pokes are now *priced* but the price binds once
  per war (an ongoing siege keeps the war alive), so a dedicated poke
  campaign still costs ≤1 prestige total — harassment damage stays bounded
  by the §5.2 halving (mechanism attribution 0.0pp at the errata config).
- **(was #7) Unpaid-merc desertion free** → **E5b**: mercenary revolt
  pillages the host province (−2 gold, yield 0 next round, canon
  EVENT_CARDS #22 semantics).
- **(was #8) Secret objectives dead weight** → **E4**: three independent
  +4 objectives. Per-objective completion 0.3% (all-3 combo) → **6.0%**
  per objective (≥1 completed in 15.5% of surviving faction-games);
  end-reveal flips 0.0% → **9.6%** of unique-leader cap games (live but
  far under the 30% kingmaker line).
- **E3 (this round's own divergence repair, was TUNING_REPORT §5 item 3)**:
  Great Bombard fixed-r15 reveal → canon draw model (uniform r11-16 seeded
  per game) + 1-round emplacement. Fullgame SD 8.0-8.2% → **11.9-13.7%**
  (<15% target), all completions r12+; threshold re-derived 84 → **80**.

### Still open (design decisions)

1. **All-turtle near-tie endings** (faction-floor/turtle): a 5-turtler
   table still ends 48.3% of games with winner margin <2 (73.7% of its
   cap-decided games) at the errata config. The canon §13.3 exact-tie
   tiebreak (key cities → gold, modeled) cannot separate margin-1
   finishes; passive accrual remains flat *within* a mirror table even
   with E2's diminishing monopolies.
2. **Trade-seat monoculture ceiling** (turtle-dominance residual): E2 cut
   monopolyMax Venice to 57.5% but Genoa's trader/monopolyMax seat still
   wins ~56-60% under monoculture protocols — the residual driver is
   trade INCOME (great-works funding) rather than monopoly prestige.
   Needs a competing gold→prestige sink or escort/at-risk trade rules.
3. **Runaway-leader brakes** (MEDIUM, improved): r8 unique-leader
   predictivity 72.8% → **69.4%** at the errata config (line 70%) — the
   E4 hidden +12 swing and E5a leader-target discount pulled it under the
   bar. Canon's remaining catch-up levers (diplomacy gang-ups, tribute
   peace, late-era crisis weighting) stay unmodeled.
4. **Victory-check ordering**: sudden death still outranks a same-Cleanup
   threshold win (canon §13.3 "immediately" — confirm intent).
5. **War pokes, residual** (LOW): E5a prices a war once; a poke every 2
   rounds keeps the same war warm indefinitely, so sustained harassment
   still costs ~1 prestige total. Full closure needs canon §11 tribute
   peace / reputation, not a one-off charge.
6. **Merc-revolt scope gap** (LOW): canon EVENT_CARDS #22 also pillages on
   unpaid Janissary/Black Army *gold* pay; E5b as ratified scopes the sim
   revolt to mercenaries. Engine should follow the card text.
