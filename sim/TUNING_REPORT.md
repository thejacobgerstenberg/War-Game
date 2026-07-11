# TUNING_REPORT — IMPERIUM: Twilight of Empires balance simulation

**Deliverable of the balance-sim workstream.** All rules mechanics follow the
FINAL canon docs at commit `2b42386` (`feature/design-and-scaffold`):
`docs/GAME_DESIGN.md` (cited as §n), `docs/FACTIONS.md`, `docs/MAP.md`,
`docs/EVENT_CARDS.md`. Mechanics *shapes* are documented in
[`RULES_MODEL.md`](./RULES_MODEL.md); the tuning history is
[`TUNING_LOG.md`](./TUNING_LOG.md); the machine-readable source of truth for
every number below is [`src/rules.ts`](./src/rules.ts) (`CONFIG`) plus
[`src/map.ts`](./src/map.ts). Every statistic in this report was read back
from the committed, executed artifacts in [`results/`](./results/) — nothing
is estimated.

**How to transcribe into `server/src/engine/balance.ts`** (file does not exist
yet): the proposed key names below follow the conventions already visible in
PR #5's engine code — flat `UPPER_SNAKE_CASE` exported constants (cf. the
existing `UPKEEP_GRAIN_PER_UNIT` in `income.ts`), `Record<UnitType, …>` /
`Record<Faction, …>` collections, resources as `ResourceBundle`. Two mapping
caveats: the shared enum spells `OTTOMAN` (sim `ottomans`), and the
`ResourceBundle` field is `stone` until PR #5's stone→marble rename lands
(sim uses `marble` throughout, matching the intended canon).

---

## 1. Executive summary

**This revision implements the RATIFIED ERRATA E1–E5 (coordinator,
2026-07-11)** — Treason-at-the-Gate gates, diminishing monopoly prestige,
the Great Bombard canon draw model + emplacement, three independent secret
objectives, and betrayal/aggression costs — and re-measures everything at
the retuned CONFIG (`victoryThreshold: 80`, single-lever retune 84 → 80
after the E2 monopoly nerf lowered winner accrual). All six balance targets
are green. Primary evidence is the independent 5,000-game verification run
(`GAMES=5000 SEED=987654321`); the committed `results/fullgame.json` holds
the 3,000-game fresh-seed final run (`GAMES=3000 SEED=24681357`) — see §7.

| Headline metric | 5,000-game verify (primary) | 3,000-game final (committed) | Target |
|---|---|---|---|
| Byzantium win rate | **18.2%** | 17.7% | 12–30% |
| Ottomans win rate | **17.0%** | 17.3% | 12–30% |
| Venice win rate | **13.2%** | 12.3% | 12–30% |
| Genoa win rate | **25.3%** | 26.3% | 12–30% |
| Hungary win rate | **26.3%** | 26.4% | 12–30% |
| Policy: rusher / trader / turtler / opportunist | **14.9 / 26.5 / 16.5 / 22.2%** | 13.9 / 25.7 / 17.7 / 22.7% | each 10–40% |
| Median end round (mean) | **16** (15.07) | 15 (15.03) | 12–16 |
| Games ending before round 11 | **0.5%** | 0.5% | <10% |
| Victory split: threshold / cap / sudden death | **57.5 / 30.6 / 11.9%** | 57.6 / 30.2 / 12.3% | threshold 40–70%, SD 1–15% |
| Sudden-death completions | all r12+ | **all 368 at r12–16** | none before r10; **<15% (errata brief)** |
| Eliminations | **0** | 0 | no early kingmaker deaths |
| Constantinople: intact-T5 assault, worst case | — | **0.31%** (siege module) | <2% |
| Constantinople: no Bombard + no blockade, 12 siege rounds | — | **0.0%** | <10% |
| Constantinople: full blockade starve-out, median round | — | **7 / 9 / 11** (garrison 6/8/10) | ≥6 |
| Constantinople: with Great Bombard, capture ≤4 rounds after its FIRST SHOT (E3 re-derived: siege rounds ≤5) | — | **91.7–100%** | >50% |
| Economy: solvency / rush credibility | — | **15/15 solvent, 5/5 strike ≥8** | all pass |

**Three sentences for the engine lead.**

1. Transcribe §2 verbatim into `balance.ts`: every number is either a direct
   canon value (§-cited), a RATIFIED errata value (E1–E5, 2026-07-11), or a
   sim-validated tuning of a value canon explicitly left to this report (the
   victory threshold, map yields/routes) — the game is balanced *as a
   system*, so change values only in pairs with a re-run of
   `npm run sim:full`.
2. The former round-15 Bombard divergence is GONE: the Bombard now follows
   the canon Era III draw (seeded uniform rounds 11–16) with a 1-round
   emplacement (E3), and the sudden-death band holds at 11.9–12.3% (<15%);
   the remaining deliberate deltas are the **map/trade deltas in
   §2.10/§2.12** (one setup monopoly per trade-identity faction, Hungary's
   ratified overland Danube corridor).
3. The Treason-at-the-Gate errata (E1) closed the last HIGH register item —
   every beeline hunt bar now passes (worst one-beeliner SD 16.2% ≤20%,
   ≤r8 8.3% ≤10%); the remaining register items (§5) are design follow-ups
   (trade-seat monoculture ceiling, all-turtle near-ties, victory-check
   ordering), none exploit-grade.

---

## 2. RECOMMENDED NUMBERS

Format: proposed `balance.ts` key | recommended value | evidence
("artifact + statistic"). Sim CONFIG paths are given where the mapping is not
obvious. "GUARDRAIL" marks sim-only clamps the engine must **not** ship as
rules (they mark where the sim is coarser than the game — see RULES_MODEL.md
GUARDRAILS).

### 2.1 Game shell

| Key | Value | Evidence |
|---|---|---|
| `MAX_ROUNDS` | 16 | canon §10 (1400–1453); fullgame median end r16 |
| `ACTIONS_PER_ROUND` | 4 | canon §10.0; pacing green (T3) at 4 |
| `SUDDEN_DEATH_HOLD_ROUNDS` | 2 | canon §13.3; fullgame SD 11.9–12.3% at the errata config (1–15% band; errata brief <15%) |
| `PLAYERS_MIN` / `PLAYERS_MAX` | 2 / 5 | sim supports 2–5; **all balance evidence is 5-player** (see §2.13 threshold note) |

### 2.2 Unit stats — base table (`UNIT_STATS: Record<UnitType, …>`)

Neutral garrisons use this table; player factions use §2.3. The sim's 5-slot
roster maps `levy→LEVY`, `professional→INFANTRY` (the faction's line unit),
`siegeEngine→SIEGE`, `galley→GALLEY`; `mercenary` is canon §6.2's *hiring
mode* applied to CAVALRY stats (there is no MERCENARY enum member — see the
multiplier keys below).

| Unit | `GOLD_COST` | `TIMBER_COST` | `MARBLE_COST` | `GRAIN_UPKEEP` | `GOLD_UPKEEP` | `CV_ATK/DEF` | Evidence |
|---|---|---|---|---|---|---|---|
| LEVY | 2 | 0 | 0 | 1 | 0 | 1/1 | canon §6.1; combat.json levyVsProfessional 6v4 = 26.1% (quality gap visible) |
| INFANTRY (professional) | 4 | 0 | 0 | 1 | 0 | 2/3 | canon §6.1; combat.json openField 6v4 = 52.2%, 6v6 = 13.1% (defender favored at parity) |
| mercenary (hired CAVALRY) | 9 (= 6 × 1.5) | 0 | 0 | 4 (= 2 × 2) | 0 | 3/2 | canon §6.2 terms; adversarial_merc_rush.json: no exploit flags, cycle-vs-honest z = 1.31 (n.s., E5b re-measure) |
| SIEGE | 8 | 2 | 2 | 1 | 0 | 0/0 (never rolls in the field) | canon §6.1; siege.json grid: engines drive E[capture] 7.3→2.2 rounds at T3 |
| GALLEY | 5 | 2 | 0 | 1 | 0 | 2/2 | canon §6.1; galley upkeep in grain per §4.4; economy.json strike incl. galleys 5/5 ≥8 |

Mercenary-mode multiplier keys (canonical form):
`MERC_GOLD_COST_MULT = 1.5`, `MERC_GRAIN_UPKEEP_MULT = 2`,
`MERC_DESERT_FIRST = true`, `MERCS_ARRIVE_INSTANTLY = true` (canon §6.2,
§4.4). The §6.3 bid market is unmodeled (§6 appendix).

### 2.3 Per-faction unit overrides (`FACTION_UNIT_OVERRIDES`)

Canon FACTIONS.md unique-unit mapping; only deltas from §2.2 are listed.
Combat asymmetry is measured: Janissary (3/3) attacking Varangian (2/4) wins
45.9% at 6v4 and 8.5% at 6v6 vs the 52.2%/13.1% symmetric baseline
(combat.json `janissaryVsVarangian` — elite defense beats elite attack at
parity, as designed).

| Faction | Slot | Represents | Override | Evidence |
|---|---|---|---|---|
| BYZANTIUM | INFANTRY | Varangian Guard | gold 6, CV 2/**4** | FACTIONS; combat.json faction grid above |
| OTTOMAN | LEVY | devshirme levies | grain upkeep **0** | FACTIONS "Devshirme"; economy.json ottomans solvent, strike 13.8 (highest) |
| OTTOMAN | INFANTRY | Janissary | gold 5, CV **3**/3, upkeep **1 gold, 0 grain** | FACTIONS (donative pay); fullgame ottoman-rusher 29% of its seats |
| VENICE | GALLEY | Galeazza / Arsenal | timber cost **1**, CV **3/3** | FACTIONS; venice strike (galleys counted) 11.6 ≥ 8 |
| GENOA | INFANTRY | Genoese Crossbowmen | gold **3**, CV 2/**2** (ARCHER folded into CV; no ranged pre-step) | FACTIONS; RULES_MODEL kernel gap-fill 1 |
| GENOA | mercenary | Mercenary Brokers | gold **6** (×1.5 surcharge **waived**, not a discount) | canon §6.2 "Genoa hires at ×1.0"; merc_rush clean |
| GENOA | GALLEY | Carrack | CV 2/**3** | FACTIONS; beeline solo_genoa blockade arms (§4) |
| HUNGARY | LEVY | "Strongest Levies" | gold **1**, CV **2/2** | FACTIONS (+1 combat, −1 gold); hungary strike 8.7 ≥ 8 |
| HUNGARY | INFANTRY | Black Army | gold 5, CV **3**/3, upkeep **1 gold, 0 grain** | FACTIONS; hungary 24.9–26.5% in band |

### 2.4 Recruiting (`RECRUIT_PER_ACTION` etc.)

| Key | Value | Evidence |
|---|---|---|
| `RECRUIT_PER_ACTION` | levy 4, INFANTRY 2, mercenary 3, SIEGE 1, GALLEY 2 | sim-validated throughput (canon has no per-type caps); economy T6 all-green at these rates |
| `OTTOMAN_LEVY_RECRUIT_BONUS` | +2 levies per recruit action | FACTIONS devshirme ("raised anywhere, in bulk"); ottomans 17.0–17.3% in band at the errata config |
| `MERCS_ARRIVE_INSTANTLY` | true | canon §6.2 |

### 2.5 Faction modifiers (`FACTION_MODS: Record<Faction, …>`)

| Key | Value | Evidence |
|---|---|---|
| `TRADE_INCOME_MULT` | VENICE 1.5, GENOA 1.5, others 1.0 | canon §5.2 merchant bonus; trader policy 25.7–26.5% in band |
| `CAPITAL_EXTRA_GOLD` | BYZANTIUM 2, others 0 | Hagia Sophia income proxy; byzantium 18.9–19.6% in band (was 90.5% at old proxy 4) |
| `GHAZA_CITY_CAPTURE_PRESTIGE` | OTTOMAN **+2** per walled city taken (on top of §2.13 capture prestige), others 0 | FACTIONS Ghaza (canon +1; raised 1→2 in the adversarial fix round after the §8.2.3 harbor fixes slowed the Ottoman siege game — within the §14 asymmetry budget). Ottomans 10.0% → 13.9–14.2%; 17.0–17.3% at the errata config (E3's earlier Bombard lifts the siege game — no further Ghaza retune needed) |

### 2.6 Combat kernel (canon §7)

Every combatant unit rolls 1d6, hits on
`roll ≥ clamp(HIT_THRESHOLD_BASE − CV − mods, HIT_THRESHOLD_MIN, HIT_THRESHOLD_MAX)`;
simultaneous casualties, lowest-value first (LEVY → INFANTRY → mercenary →
GALLEY, §4.4). The §7.4 worked example is asserted in `src/run/_smoke.ts`
(17 threshold checks).

| Key | Value | Evidence |
|---|---|---|
| `HIT_THRESHOLD_BASE` | 7 | canon §7.1 |
| `HIT_THRESHOLD_MIN` / `MAX` | 2 / 6 | canon §7.1 clamp; combat.json sanity: 0 monotonicity/ordering violations over 100k trials/cell |
| `OUTNUMBER_RATIO` / `OUTNUMBER_BONUS` | 2 / +1 | canon §7.3; combat.json 12v6 open field = 97.6% |
| `OUTNUMBER_VS_WALLS` | false — GUARDRAIL/gap-fill (no frontage on an escalade) | RULES_MODEL kernel gap-fill 2; needed for T5a 0.31% |
| `ROUT_LOSS_FRACTION` / `ROUT_ROLL_MAX` | 0.5 / routs on 1d6 ≤ 3 | canon §7.5 |
| `DEFENDER_ROUTS_BEHIND_WALLS` | false — gap-fill (nowhere to flee) | RULES_MODEL gap-fill 3 |
| `WALL_COVER_SAVE_ON` | 3 (hits on garrison deflected on 1d6 ≤ 3 while walls stand) — gap-fill vs clamp saturation | RULES_MODEL gap-fill 4; without it a 12-stack storms a 6-man T5 garrison ~6% (T5a fail) |
| `ATTACKER_WITHDRAW_FRACTION` | 0.35 | sim policy floor; keeps assault grids finite |
| `BATTLE_MAX_ROUNDS` | 25 (stalemate → siege continues) | sim bound; no timeout observed in siege grids |
| `SIEGE_ENGINE_ESCALADE_BONUS` | 3 (engines roll at CV 0+3 only while assaulting unbreached walls) | canon §6.1 "SIEGE +3 vs walls" |
| `TERRAIN_DEFENDER_BONUS` | plains 0; hills/mountains/forest **+1**; (sim marsh +1 — no canon terrain) | canon §7.3; combat.json hills 6v4 = 31.4% vs 52.2% open |
| `AMPHIBIOUS_PENALTY` | 1 (attacker −1 across strait / amphibious) | canon §7.3/§5.3; combat.json riverCrossing 6v4 = 25.5% |

### 2.7 Walls T1–T5 (canon §8.1) and escalade

Defender bonus is **binary**: full while wall HP > 0, zero at breach.

| Tier | `WALL_HP_BY_TIER` | `WALL_DEFENDER_BONUS_BY_TIER` | Notes |
|---|---|---|---|
| — | 0 | 0 | open province |
| T1 | 3 | +1 | |
| T2 | 6 | +2 | buildable (Walls Lv1) |
| T3 | 10 | +3 | buildable ceiling — `MAX_BUILDABLE_WALL_TIER = 3` (§9.1) |
| T4 | 13 | +4 | authored: Belgrade, Rome |
| T5 | 16 | +4 | Theodosian Walls — Constantinople only (§8.3) |

`ESCALADE_PENALTY = 1` (attacker −1 assaulting unbreached walls, §8.2.4);
`ASSAULT_ALLOWED_ANYTIME = true`. Evidence: combat.json wall sets — 6v4
attacker odds collapse 52.2% → 0.4% (T1) → 0.1% (T2–T5): with professional
garrisons the clamp saturates, so tiers differentiate via wall HP (siege
length) and starvation, not assault odds — by design. siege.json
`directAssaultIntactTheodosian` worst case 0.31% (T5a target <2%). No
Theodosian extras: `theodosianBonus`/`theodosianExtraHitpoints` = 0 (T5 *is*
the table row).

Not modeled (engine should ship canon): wall repair +1 HP/round out of siege
(§8.2.5).

### 2.8 Siege (canon §8.2–8.4)

| Key | Value | Evidence |
|---|---|---|
| `SIEGE_DAMAGE_DIE` | 1d6 → [1,1,2,2,3,3] wall HP | canon §8.2.2; siege.json grid T1–T4 E[capture] 1.0–2.7 rounds at 3 engines |
| `MAX_EFFECTIVE_ENGINES` | 3 (divergence — canon uncapped) | siege.json T3/g6: engines 3→6 leave capture% and E[rounds] flat (97.3%/2.2 at e3 ≈ e4–e6) — the cap binds nothing in practice but keeps engine-spam out of the agents |
| `T5_MASONRY_CAP_PER_ROUND` | 1 HP/round total vs intact T5 | canon §8.3; siege.json T5b: 0.0% capture in 12 rounds without the Bombard |
| `SIEGE_GRAIN_STORES_BASE` | 3 rounds (Granary +2 unmodeled) | canon §8.2.3; blockade starve medians 7/9/11 (T5c) |
| `STARVATION_UNITS_PER_ROUND` | 1, weakest first | canon §8.2.3 |
| `BESIEGER_ATTRITION_PER_ROUND` | 0.03 (divergence — canon has none; anti-infinite-siege pressure) | siege.json abandonment rates; keeps e0 sieges from parking forever |
| `SEA_RESUPPLY` | enabled: a besieged coastal city depletes stores **only under full naval blockade** | canon §8.2.3; T5b 0.0% |
| Blockade contest rule | a zone is enemy-controlled only if an enemy war fleet is **present and uncontested** by any friendly war fleet (RAW §8.2.3/§5.3) — one defending harbor galley keeps the lane open | adversarial fix: land-power camp-galley blockades removed; beeline SD 78.1% → 22.6% (§4) |
| Harbor reinforcement | while not fully blockaded, the owner may recruit inside and ferry troops in by sea (`Game.harborOpen`) | §8.2.3 corollary (Giustiniani relief); part of the same fix chain |
| `GREAT_BOMBARD_DRAW_ROUND_MIN` / `MAX` | **11 / 16** — RATIFIED ERRATA **E3**: the omen `great-bombard-forged` sits at a uniformly random position in the Era III deck; per-game seeded draw round uniform over rounds 11–16 (replaces the former fixed-r15 reveal divergence) | fullgame SD 11.9–12.3% (<15% errata brief; all completions r12+); TUNING_LOG errata round |
| `GREAT_BOMBARD_EMPLACEMENT_ROUNDS` | **1** — E3: after acquisition (or moving to a new siege) the Bombard is emplaced for 1 full siege round before it first fires (no wall damage / no masonry-cap lift from it that round) | siege.json E3 curve: k=2 ≈ 0.4%, k=3 = 68.3–98.3%; median capture siege round 3 (was 2) |
| `GREAT_BOMBARD_FREE_TO_OTTOMAN` | true; else auction — sim fallback: richest payer at `GREAT_BOMBARD_AUCTION_GOLD = 40` | canon §8.4 (card auctions gold+marble bids; sim simplifies) |
| `GREAT_BOMBARD_DAMAGE_DICE` | 2 wall-damage dice/round (~4 avg, max 6); **lifts the T5 masonry cap for the whole train** once emplaced | canon §8.4; siege.json T5d (E3 re-derived): capture ≤4 rounds after first shot 91.7–100% |

Unmodeled Bombard riders (ship per canon §8.4): 3-grain upkeep/silence,
1-province move, no mountains, sink-on-transport-loss, capture-as-loot.
Byzantine "auto-repel first two siege rounds" (FACTIONS) unmodeled —
sensitivity: shifts T5d capture from ~2–4 to ~4–6 siege rounds (§6).

### 2.9 Tactic cards (canon §7.7) — ratified magnitudes as fixed inputs

The 23 ratified designs at final magnitudes are encoded verbatim in
`CONFIG.tacticCards` (deck 47: Common ×3, Uncommon ×2, Rare ×1). **Magnitudes
were fixed inputs to tuning** — do not retune them; the one ratified errata
is E1 (Treason at the Gate, §5.A). Sim plays at most ONE card per side per battle (canon allows one per
battle *round* — the measured card impact is a mild underestimate).

Combat-relevant designs and measured impact (combat.json, 100k trials/cell,
vs openField 6v4 = 52.2%):

| Card | Tier×copies | Effect (sim encoding) | Measured 6v4 |
|---|---|---|---|
| Veterans of the Border | C×3 | +1 die | **58.6%** (+6.4pp) |
| Condottieri Contract | U×2 | +2 dice, 2g | **63.3%** (+11.1pp) |
| Locked Shields | C×3 | defender reroll 1/round | attacker → **36.2%** (−16.0pp) |
| The Bribed Gatekeeper | U×2 | wall bonus 0 for one assault (escalade −1 stands) | intact-T3 assault 0.1% → **25.7%** (= escalade-only odds) |
| Ladders and Fascines | C×3 | reroll 1, first assault round | (folded into assault grids) |
| The White Knight's Stroke | R×1 | reroll 3, first round | (see combat.json sets) |
| Holy War Proclaimed | R×1 | +1 die, 2 faith (canon: all battles until next turn; sim: one battle — underestimate) | ≈ Veterans |
| The Hexamilion Manned | U×2 | defender +2 in an unwalled province | threshold-space +2 |
| Night Sortie | U×2 | siege round: no store depletion, besieger −1 unit | siege-phase card |
| Sails from the West | R×1 | no depletion even under full blockade, +2 stores | siege-phase card |
| **Treason at the Gate** | R×1 | 4g: city falls; remove from game. **RATIFIED ERRATA E1**: playable only vs garrison ≤ 4 (`TREASON_MAX_GARRISON = 4`), and its 2-consecutive-siege-round clock counts only siege rounds in game round ≥ 6 (`TREASON_CLOCK_FROM_ROUND = 6`) | errata re-measure: beeline solo_ottoman SD 22.6%→16.2%, guard arm 23.8%→7.3%; all §4.1 bars pass — the former §5 item 1 is CLOSED |
| The Intercepted Letter | U×2 | reaction: cancels the rival's card | exempt from the one-card cap |
| Counting-House / Grain Barges / Papal Indulgence / Pay Chest | C×3/C×3/U×2/R×1 | instants: +2g / +2 grain / 2g→3 faith / steal ≤3g from prestige leader | resolve on draw |

**The 7 dead designs in the sim** (movement/info/naval/diplomacy scope —
15/47 cards occupy deck/hand slots but never fire, so measured card impact is
an *under*estimate): Forced March, The Pilot of the Narrows (C×3!), Ears in
the Bazaar, Feigned Retreat, Chain Across the Horn, Greek Fire, A Death in
the Palace. Re-measure the card layer when fleets/movement/diplomacy land
(§6).

Deck/hand keys: `CARD_DRAWS_PER_ROUND = 1` (University unmodeled),
`HAND_LIMIT = 4` (canon §7.7).

### 2.10 Province yields — bounds and tuned map deltas

Authoring bounds (`map.ts` is validated against these):
`YIELD_BOUNDS` gold [0,5], grain [0,4], timber [0,2], marble [0,2],
faith [0,2]; `KEY_CITY_GOLD_MIN = 2`.

Tuning-authored yield deltas the map must carry (all in `src/map.ts`; these
are load-bearing balance results, not flavor):

| Province | Delta | Why (evidence) |
|---|---|---|
| wallachia | gold **2** (was 1) | breaks the serbia/wallachia expansion tie so Hungary's first conquest takes the open breadbasket, not T2 Smederevo; hungary rush strike 6.1→8.7 ≥ 8 (economy T6; retune-2 it2) |
| pera | gold **2**, marble **1** | Genoa's great-work marble moved onto the warpath (parity with Venice's Zara); gold trimmed in the fix round (Genoa 30.2%→27.8%) |
| bursa | gold **4** (was 3) | Silk-Road terminus; Ottoman floor re-lift after the §8.2.3 harbor fixes (ottomans 10.0%→13.9–14.2%) |
| chios | gold **2** (was 3); caffa gold **3** (was 4) | colonial-surplus trim: Genoa's runaway was great-works funded by untouchable colonies (retune-1 it5/7) |
| venice | marble **0**; zara marble **1** | Venice's great-work engine sourced from contestable Dalmatia, not the lagoon (round-91: venice 32.4%→in band) |
| belgrade | marble **0**; buda gold **3** (was 4) | Hungary Option-A moderation (42.4%→in band; TUNING_LOG retune-1 it10–11) |
| constantinople grain 2, morea grain 3, mesembria grain 3 | rump-Byzantium grain floor | economy: Byz income ≥ upkeep for a credible strike force (old-kernel it17, still load-bearing) |
| salonica | Byzantine, T3, key | canon thessalonica (FACTIONS); trebizond stays a neutral T3 key city |

### 2.11 Buildings

Sim models a 3-building set (canon §9.1 lists 8 + four §9.2 Great Works with
multi-round builds — see §6). Validated values:

| Key | Value | Evidence |
|---|---|---|
| `MARKET_COST` / `MARKET_EXTRA_GOLD` | 8g + 2 timber / +2 gold/round | trader policy 26% in band |
| `WALL_UPGRADE_COST` | 10g + 2 timber + **1 marble** (+1 tier, max T3) | **marble 2→1 was a real tuning outcome**: at 2 marble, wall upgrades starved great works and the turtler policy fell below the 10% floor (9.3%); at 0 it overshot (turtler 20–22%, genoa 31.9%); at 1: turtler 10.9–19.2% across seeds (round-91 it3–4). If the engine uses canon §9.1 wall costs, preserve the *ratio*: wall-marble must stay well below great-work marble |
| `GREAT_WORK_COST` / `GREAT_WORK_PRESTIGE` | 25g + 4 marble + 2 faith / **+5** once | sim's generic stand-in for §9.2 (+5…+10, multi-round); monopolyMax ledger: greatWorks 13.1–19.3 avg prestige for the trade republics (turtle_dominance.json) |

### 2.12 Trade

| Key | Value | Evidence |
|---|---|---|
| `BASE_ROUTE_INCOME` | 3 (sim default; routes are authored per-pair below — canon §5.2's formula is unmodeled, §6) | economy income telemetry: mean gold/round byz 19.1 / ott 21.1 / ven 30.7 / gen 24.7 / hun 17.5 |
| `MAX_ROUTES_PER_FACTION` | 3 | trader 26% in band; venice/genoa avg open routes 2.8/turn (economy_exploit control) |
| `BLOCKADE_INCOME_MULT` | **0.5** — a blockaded route yields ×0.5; only a **severed** route (endpoint lost) yields 0 | canon §5.2 (adversarial fix, HIGH): pre-fix blockade *cancelled* routes and a single 5g picket galley deleted a trader faction — trader-Genoa under a dedicated Ottoman griefer 0.1% pre-fix → **36.6%** post-fix vs 51.3% control; blockade-mechanism attribution now ~0.5pp (36.6 vs 37.1 with the mechanism off); a passive-picket griefer wins **0.0%** (total self-sacrifice, was self-profitable) |
| `MERCHANT_FACTION_MULT` | 1.5 (Venice, Genoa) | canon §5.2 |
| `TRADE_MONOPOLY_PRESTIGE_FIRST` / `_ADDITIONAL` | **+2 first / +1 each additional** simultaneous monopoly — RATIFIED ERRATA **E2** (diminishing returns; no escort requirement) | errata re-measure: monopolyMax Venice 66.2%→57.5%, Genoa 61.7%→60.0% (§4.5); Venice/Genoa T1 held at threshold 80 |
| Overland caravan routes | ratified (R9 Option A): land-to-land, no sea zones, fleet-unblockadable; income = **60% of the comparable sea route** (the floor of the ratified 60–75% band; canon rules them army-blockadable — not modeled, flatters overland slightly) | Hungary floor fix: 3.9% → in band (22.7–26.5%); at 75% (3g) Hungary hit 41–42% — see §5 note and TUNING_LOG retune-1 it8–12 |

Authored route table (map.ts; income gold/round):

| Route | Income | Notes |
|---|---|---|
| venice_constantinople | 4 | flagship sea route |
| venice_crete | 4 | Venice's one setup monopoly |
| genoa_caffa | 3 | Genoa's one setup monopoly (trimmed 4→3) |
| chios_smyrna | 2 | replaced genoa_chios — Genoa's 2nd monopoly must be conquered (smyrna neutral); the setup double-monopoly made Genoa win 61.8–74.6% |
| ragusa_venice | 2 | |
| crete_cyprus | 3 | |
| trebizond_caffa | 2 | Genoese Black Sea |
| buda_venice | 2 (overland) | |
| **buda_belgrade** | **2 (overland)** | Hungary's one setup monopoly — the ratified Option-A lever; exactly one setup monopoly per trade-identity faction |
| bursa_ankara | 4 (overland) | Silk-Road terminus (Ottoman trader floor) |

(Removed during tuning: genoa_chios, buda_ragusa — each was a cheap second
monopoly worth +4 prestige/round and produced a 41–75% runaway;
salonica_constantinople, constantinople_caffa — Byzantine hub snowball.)

### 2.13 Prestige & victory (canon §13.1)

| Key | Value | Evidence |
|---|---|---|
| `PRESTIGE_OWN_CAPITAL` | +1/round | canon §13.1 |
| `PRESTIGE_ENEMY_CAPITAL` | +3/round | canon §13.1 |
| `PRESTIGE_KEY_CITY` | +1/round each | canon §13.1 (sim's old 1.5 reverted — capital income replaces the premium) |
| `PRESTIGE_TRADE_MONOPOLY_FIRST` / `_ADDITIONAL` | **+2 / +1** (E2 diminishing returns) | §2.12; ceiling reduced (§4.5), residual filed §5 |
| `PRESTIGE_GREAT_WORK` | +5 once | §2.11 |
| `PRESTIGE_DECISIVE_BATTLE` | +1 | canon §13.1 (loser wiped or routed; withdrawals don't count) |
| `PRESTIGE_OUTNUMBERED_WIN` | +1 (stacks with decisive) | canon §13.1 |
| `PRESTIGE_WALLED_CITY_CAPTURE` | +2 (T1–T3), **+3 (T4–T5)** — BY FORCE only (walk-ins score nothing) | canon §13.1 |
| `PRESTIGE_WAR_WON` | +3 | canon §13.1 |
| `PRESTIGE_LOSE_CAPITAL` | −3 | canon §13.1 |
| `PRESTIGE_SECRET_OBJECTIVE` | **+4 PER OBJECTIVE, INDEPENDENTLY; 3 objectives per faction; scored at GAME END only** — RATIFIED ERRATA **E4** (counts for the round-16 comparison; can never trigger an early threshold win) | canon §13.1 + FACTIONS (3 per faction); errata re-measure: per-objective completion 6.0%, end-reveal flips 9.6% of unique-leader cap games (§4.4) — the channel is live |
| `PRESTIGE_UNJUSTIFIED_WAR` | **−1** once, at war declaration, unless justified — RATIFIED ERRATA **E5a**. Sim justification mapping (engine should ship canon §11 casus belli): target holds one of your secret-objective provinces, OR target is the current prestige leader, OR target attacked you first this game | canon §11 aggression-cost family; measured 0.79 charges/game in fullgame; war-poke pricing §4.2 |
| `GHAZA_CITY_CAPTURE_PRESTIGE` | OTTOMAN +2 | §2.5 |
| per-route prestige / per-province capture prestige / Constantinople extra | **0** (levers, off — canon has none) | retune: the conquest track (+2/province) was a pre-canon lever, removed |
| `TURN_ORDER` | re-sort each Cleanup, lowest prestige first (tiebreak fewer provinces) | canon §13.4; modeled since the fix round (runaway-leader hunt) |
| `CAP_TIEBREAK` | most key cities, then most gold | canon §13.3; modeled since the fix round |
| **`VICTORY_THRESHOLD`** | **80** (checked at Cleanup only; 84 → 80 in the ratified errata round) | see below |

**VICTORY_THRESHOLD = 80**, expressed both ways per the canon §13.2 handoff
("threshold supplied by balance TUNING_REPORT"):

- **Absolute: 80 prestige**, first checked at Cleanup (canon §13.2's 25/30/35
  are pre-tuning placeholders — the §13.1 conquest rows plus monopoly/capital
  income raise total inflow far beyond them).
- **As a multiple of winner accrual: 80 = 15.16× the mean winner
  prestige-accrual per round** — 5.277 prestige/round, computed over exactly
  the 3,000 committed `results/fullgame.json` games (mean of per-game
  final-prestige/rounds; mean winner final prestige 78.7 at mean end round
  15.03; aggregate form 80 ÷ (78.7/15.03) = 15.29×). The pre-errata config
  sat at ~15.9–16.0×; the E2 monopoly nerf lowered accrual, so the multiple
  drifted to ~15.2–15.3×. If future rules changes move mean winner accrual,
  re-derive the absolute value from ~15–16× and re-verify T1–T4.
- Calibration lineage (errata round A/B at 1,000 games seed 14530000, then
  seed-verified at 3,000/5,000): **84** → threshold-decided 37.4% (T3 floor
  40% broken), SD 14.6%; **82** → 47.2%/13.7% but Venice 11.6% on the fresh
  seed (T1 floor broken); **80** → 57.5–57.6% threshold-decided, SD
  11.9–12.3%, Venice 12.3–13.4% across all three seeds — all bands green.
  Pacing window 78–84 (rec 81); 80 sits inside it.
- **Scope caveat: calibrated at 5 players only.** Canon scales the threshold
  by player count; 2–4-player values need their own fullgame runs (suggest
  keeping 80 for 4–5 and re-simming before shipping 2–3-player values).

### 2.14 Economy misc

| Key | Value | Evidence |
|---|---|---|
| `GRAIN_MARKET_BUY_GOLD_PER_GRAIN` / `SELL` | 2 / 1 | economy solvency 15/15 (canon §4.3's 3:1/2:1 generic ratios unmodeled, §6) |
| `GRAIN_SHORTFALL_DESERTION_FRACTION` | 0.25/round of unfed units | sim shape; canon §4.4 is 1 unit per grain short — same direction, different sharpness (§6) |
| `UNPAID_MERC_DESERTION` | 100%, desert first | canon §4.4/§6.2 |
| `MERC_REVOLT_PILLAGE_GOLD` / `_YIELD_ROUNDS` | **2 / 1** — RATIFIED ERRATA **E5b**: deserting unpaid/unfed mercenaries revolt and pillage their host province (owner −2 stored gold; province yields nothing next round). Camp deserters: gold only (no owner province — gap; canon card also pillages on unpaid Janissary/Black-Army pay, engine should follow card text) | canon EVENT_CARDS #22 "Mercenary Revolt" semantics; merc_rush re-measure: cycle-vs-honest z 1.81 → **1.31** (gradient shrunk, no exploit) |
| `GOLD_FLOOR` | 0 (treasury never negative; shortfall → desertion) | — |
| Skeleton-garrison rule | peacetime desertion / negative-unit events never remove the LAST combatant of a walled province's garrison; **besieged** walled garrisons are fully exempt from insolvency desertion (the siege stores clock is the sole hunger source, §8.2.3) | rules-visible fix: pre-fix, treasury shortfall deserted Constantinople's garrison from behind intact walls (walk-in falls at r5–7); beeline fix chain §4 |

### 2.15 Omen magnitudes (GUARDRAIL bounds for the event deck)

The sim abstracts §12's era decks as one card/round with bounded magnitudes.
EVENT_CARDS.md authors should keep single-card swings inside these measured
bounds:

| Key | Value | Evidence |
|---|---|---|
| `OMEN_GOLD_MAGNITUDE` | ±6 | max swing = 0.20–0.34× a faction's mean round income (0.38–0.55× p10) — under the 1.5× "economy-warping" bar (economy_exploit incomeTelemetry) |
| `OMEN_GRAIN_MAGNITUDE` | ±4 | gold-value ≤ 0.42× mean income |
| `OMEN_UNIT_MAGNITUDE` | ±3 | with the unit-loss floor below |
| `OMEN_PRESTIGE_MAGNITUDE` | ±2 | — |
| Unit-loss floor | ≥1 combatant in any garrison; **≥3 in a walled capital or besieged walled city** | GUARDRAIL (one-card abstraction artifact): a round-1 plague must not convert a siege of Constantinople into a round-2 escalade (beeline fix 4) |

### 2.16 Neutral garrisons

| Key | Value | Evidence |
|---|---|---|
| `NEUTRAL_BASE_LEVIES` | 2 | coarse stand-in for MAP.md minor-state garrisons; baseLevies 2→1 broke Venice's T1 band (reverted, retune-1 T6 sweep) |
| `NEUTRAL_LEVIES_PER_WALL_TIER` | +1/tier | — |
| `NEUTRAL_KEY_CITY_PROFESSIONALS` | +2 | — |

### 2.17 Faction starting sheets (canon FACTIONS.md)

Treasuries (`STARTING_TREASURY: Record<Faction, ResourceBundle>` — gold /
grain / timber / marble / faith):

| Faction | gold | grain | timber | marble | faith |
|---|---|---|---|---|---|
| BYZANTIUM | 5 | 4 | 1 | 2 | 5 |
| OTTOMAN | 6 | 7 | 3 | 3 | 2 |
| VENICE | 9 | 4 | 5 | 3 | 1 |
| GENOA | 8 | 3 | 4 | 3 | 1 |
| HUNGARY | 6 | 6 | 5 | 4 | 3 |

Starting provinces & garrisons (canon sheets mapped onto the sim map — canon
cavalry/unique infantry → INFANTRY slot, war/merchant galleys → GALLEY):

| Faction | Province (garrison) |
|---|---|
| BYZANTIUM | **constantinople** T5 key (3 INF incl. Varangian, 1 galley); salonica T3 key (1 levy, 1 INF); morea T2 (1 levy); lemnos (1 levy); mesembria T1 (1 levy) |
| OTTOMAN | **edirne** T3 key (3 levy, 2 INF); bursa T3 (2 levy, 1 INF); gallipoli T2 (1 levy, 1 galley); nicaea T2 (1 levy); sofia (1 levy); philippopolis (1 levy) |
| VENICE | **venice** T3 key (1 INF, 5 galleys); crete T2 (1 INF, 1 galley); negroponte T2 (1 galley); corfu T2 (1 galley); modon T1 (1 galley); zara T1 (1 levy) |
| GENOA | **genoa** T3 key (2 INF, 3 galleys); chios T1 (1 INF, 1 galley); caffa T2 (1 levy, 1 galley); pera T1 (1 INF); lesbos T1 (1 levy) |
| HUNGARY | **buda** T3 key (2 levy, 2 INF); belgrade **T4** (2 levy, 1 INF); transylvania T1 (2 levy); croatia (1 levy) |

Evidence: with these canon sheets, T1 green on two independent seeds
(fullgame.json + 5,000-game verify) and T6 economy green
(15/15 solvency, 5/5 rush credibility).

---

## 3. Evidence per model

### 3.1 Combat Monte-Carlo (`results/combat.json` — seed 789415, 100k trials/cell, 12×12 grids)

Attacker win probability, professional vs professional unless noted:

| Modifier set | 6v4 | 6v6 | 8v4 |
|---|---|---|---|
| open field | 52.2% | 13.1% | 93.8% |
| river/strait crossing (−1) | 25.5% | 3.2% | 83.7% |
| hills (+1 def) | 31.4% | 4.0% | 84.1% |
| walls T1 (intact, escalade) | 0.4% | 0.0% | 3.6% |
| walls T2–T5 (intact, escalade) | 0.1% | 0.0% | 1.1–1.2% |
| + Veterans (+1 die) | 58.6% | 17.2% | 95.1% |
| + Condottieri (+2 dice) | 63.3% | 21.4% | 95.8% |
| vs Locked Shields (def reroll) | 36.2% | 7.9% | 85.2% |
| Bribed Gatekeeper vs intact T3 | 25.7% | 3.1% | 83.8% |

Reading: parity favors the defender (6v6 = 13.1% — attrition + rout math);
meaningful attacks need ~3:2 odds or a card; intact walls are hopeless at
every tier against professional garrisons (clamp saturation — tiers
differentiate through siege length, §2.7). Faction asymmetry: Janissary
(3/3) vs Varangian (2/4) 6v4 = 45.9%, 6v6 = 8.5%. Levy stacks trade ~2:1
against professionals (levy 6v4 = 26.1%; 12v6 = 89.1%). Sanity: **0
monotonicity/ordering violations** across all grids; the tier-5 coin-flip
ratio is ~4.1–4.3 attackers per defender (only reachable for garrisons ≤ 2).

### 3.2 Siege module (`results/siege.json` — seed 20260711, 20k iterations/cell)

Constantinople scenarios (attacker 12 INF + 4 merc + 3 engines, professional
garrisons, T5 16 HP/+4, sea resupply active; Bombard scenarios assume the
omen has resolved and include the **E3 1-round emplacement** — the Bombard
first fires in siege round 2):

| Scenario | garrison 6 | garrison 8 | garrison 10 |
|---|---|---|---|
| no Bombard, no blockade — capture ≤12 rounds | **0.0%** | 0.0% | 0.0% |
| full blockade, no Bombard — capture prob / median round | 100% / **7** | 99.9% / **9** | 99.9% / **11** |
| Great Bombard, open sea — capture ≤5 (= 4 after first shot) / median | 100% / 3 | 99.2% / 3 | **90.7%** / 3 |
| Great Bombard + blockade — capture ≤5 | 100% | 99.6% | 94.1% |

Targets: T5a intact-assault worst **0.31%** (<2%) · T5b **0.0%** (<10%) ·
T5c min capture 99.9%, min median **7** (≥6) · **T5d (E3 re-derived: capture
within 2–4 siege rounds AFTER the Bombard first fires, i.e. k ≤ 5)** worst
**91.7%** at k≤5 open-sea (>50%; the JSON key is
`t5d_withBombardWithin4OfFirstFireOver50pct`). With the omen drawn uniform
r11–16, the City falls ~r13–16 — fullgame SD completions all r12+ (1453
anchor holds in expectation).

Capture curves (garrison 8; P(capture ≤ k siege rounds); E3 emplacement
visible as the k=1–2 flat start):

| k rounds | 1 | 2 | 3 | 4 | 5 | 8 | 9 | 10 | 12 |
|---|---|---|---|---|---|---|---|---|---|
| Great Bombard (open sea) | 0% | 0.4% | 91.1% | 99.2% | 99.4% | 99.4% | 99.4% | 99.4% | 99.4% |
| full blockade, no Bombard | 0 | 0 | 0 | 0 | 0 | 0 | 98.8% | 100% | 100% |
| no Bombard, no blockade | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

<svg viewBox="0 0 720 340" width="720" role="img" aria-label="Constantinople capture probability by siege round, garrison 8, with the errata E3 emplacement: the Great Bombard is emplaced through siege rounds 1 and 2, jumps to 91 percent at round 3 and 99 percent by round 4; full blockade starves the city out at rounds 9 to 10; without either the city never falls." xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="720" height="340" fill="#fcfcfb"/>
  <text x="60" y="24" font-family="sans-serif" font-size="14" font-weight="bold" fill="#0b0b0b">Constantinople: P(capture &#8804; k siege rounds) — garrison 8, E3 emplacement, 20k iterations/cell</text>
  <!-- gridlines -->
  <g stroke="#e4e3df" stroke-width="1">
    <line x1="60" y1="60" x2="700" y2="60"/><line x1="60" y1="120" x2="700" y2="120"/>
    <line x1="60" y1="180" x2="700" y2="180"/><line x1="60" y1="240" x2="700" y2="240"/>
  </g>
  <g font-family="sans-serif" font-size="11" fill="#52514e">
    <text x="52" y="64" text-anchor="end">100%</text><text x="52" y="124" text-anchor="end">75%</text>
    <text x="52" y="184" text-anchor="end">50%</text><text x="52" y="244" text-anchor="end">25%</text>
    <text x="52" y="304" text-anchor="end">0%</text>
  </g>
  <line x1="60" y1="300" x2="700" y2="300" stroke="#52514e" stroke-width="1"/>
  <g font-family="sans-serif" font-size="11" fill="#52514e" text-anchor="middle">
    <text x="60" y="318">0</text><text x="166" y="318">2</text><text x="273" y="318">4</text>
    <text x="380" y="318">6</text><text x="486" y="318">8</text><text x="593" y="318">10</text>
    <text x="700" y="318">12</text>
    <text x="380" y="334">siege rounds (k)</text>
  </g>
  <!-- Great Bombard, open sea (E3): (0,0) (1,0) (2,.004) (3,.911) (4,.992) (5,.994) ... flat -->
  <polyline fill="none" stroke="#2a78d6" stroke-width="2" points="60,300 113,300 166,299 220,81.4 273,61.9 326,61.4 700,61.4"/>
  <!-- full blockade, no Bombard: 0 through k=8, (9,.988) (10,1.0) -->
  <polyline fill="none" stroke="#1baf7a" stroke-width="2" points="60,300 486,300 540,62.8 593,60 700,60"/>
  <!-- no Bombard, no blockade: flat 0 -->
  <polyline fill="none" stroke="#eda100" stroke-width="2" stroke-dasharray="6 3" points="60,299 700,299"/>
  <g font-family="sans-serif" font-size="12" font-weight="bold">
    <text x="240" y="52" fill="#2a78d6">Great Bombard: 1-round emplacement, then median capture round 3</text>
    <text x="410" y="110" fill="#1baf7a">full blockade starve-out (median 9)</text>
    <text x="90" y="288" fill="#8a6500">no Bombard + no blockade: never falls (sea resupply + T5 masonry cap)</text>
  </g>
</svg>

Generic walled cities (landlocked grid, garrison 6, 12 INF + 3 engines):
capture 97.0–98.6% with E[rounds] T1 1.0 / T2 1.4 / T3 2.2 / T4 2.7 /
T5 7.1 — tiers price a siege in *time*. Engine-count sweep at T3
(E[capture rounds] 7.3 / 5.3 / 3.0 / 2.2 at 0/1/2/3 engines; flat at 4–6)
is the `MAX_EFFECTIVE_ENGINES = 3` evidence.

### 3.3 Economy module (`results/economy.json`)

Per-faction × archetype (rush / turtle / balanced) deterministic 16-round
projections at canon prices and treasuries:

- **Solvency: 15/15 cells** — no desertion event through round 16 (T6 first
  clause).
- **Rush credibility** (strike power = INF + merc + galley + 0.3×levy at its
  rounds-4/5 peak, target ≥8): byzantium **9.0**, ottomans **13.8**, venice
  **11.6**, genoa **11.0**, hungary **8.7** — 5/5 (T6 second clause).
- Income at r16 (gold/round, balanced archetype): byz 26, ott 32, ven 61.5,
  gen 55.5, hun 28 — the merchant ×1.5 is visible and intended.
- Non-T6 snapshot criteria that remain red (documented, not chased):
  byzantium/ottomans `balancedMid`, genoa `turtleStrong` — artifacts of the
  harness's deterministic expansion ordering, not rules numbers (the sweep
  therefore reports `pricePoints: null`); fullgame ground truth has every
  faction and policy in band.

### 3.4 Pacing abstraction (`results/pacing.json` — seed 14530529, 10k trajectory games)

Threshold sweep over archetype accrual trajectories (errata config: E2
diminishing monopolies + E4 three independent objectives in the model):
all-criteria window **78–84**, recommendation 81. The shipped 80 sits
inside the window; at 80 the abstraction predicts median end r16, 0%
before r11 — the engine measures threshold-decided 57.5–57.6%. The
abstraction cannot model inter-player suppression and its threshold-share
estimate diverges from the engine; it was used only for coarse windowing.
**`fullgame` is ground truth for pacing** (T3 measured there, all three
seeds green).

### 3.5 Full-game Monte-Carlo (`results/fullgame.json` + 5,000-game verify)

Faction × policy win rates (5,000-game verify at the errata config, % of
that faction's seats with that policy):

| faction | rusher | trader | turtler | opportunist |
|---|---|---|---|---|
| byzantium | 13% | 13% | 10% | **38%** |
| ottomans | **36%** | 6% | 0% | 26% |
| venice | 1% | **32%** | 21% | 0% |
| genoa | 1% | **60%** | 40% | 0% |
| hungary | 23% | 22% | 12% | **48%** |

Aggregates are in band; the wide cell spread (dead corners: ottoman-turtler
0%, venice/genoa rusher+opportunist 0–1%; genoa-trader as the strongest cell,
consistent with §4.6's ceiling flag) is a scripted-agent limitation
filed for faction-aware agents — no aggregate target covers cells.

Game length (3,000-game committed run at the errata config): median 15,
mean 15.03; the E3 earlier Bombard and threshold 80 pull some endings into
r12–15.

```
r 9                                 2
r10                                 13
r11                                 24
r12  ██▎                            115
r13  ████▊                          241
r14  ███████▉                       394
r15  ██████████████▎                713
r16  ██████████████████████████████ 1498
```

Mean prestige by round (3,000-game committed run at the errata config;
survivor-averaged) against the threshold — the average table does *not*
cross 80, which is why ~30% of games go to the round-16 cap and only
winners (mean final 78.7) get threshold-close:

<svg viewBox="0 0 830 400" width="830" role="img" aria-label="Average prestige by round for the five factions rises roughly linearly from about 3.5 at round 1 to 57 to 71 at round 16, with Hungary highest throughout; the victory threshold 80 sits above every average curve." xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="830" height="400" fill="#fcfcfb"/>
  <text x="60" y="24" font-family="sans-serif" font-size="14" font-weight="bold" fill="#0b0b0b">Mean prestige by round vs VICTORY_THRESHOLD 80 (3,000 games, seed 24681357, errata config)</text>
  <g stroke="#e4e3df" stroke-width="1">
    <line x1="60" y1="290" x2="700" y2="290"/><line x1="60" y1="223" x2="700" y2="223"/>
    <line x1="60" y1="157" x2="700" y2="157"/><line x1="60" y1="90" x2="700" y2="90"/>
  </g>
  <g font-family="sans-serif" font-size="11" fill="#52514e" text-anchor="end">
    <text x="52" y="360">0</text><text x="52" y="294">20</text><text x="52" y="227">40</text>
    <text x="52" y="161">60</text><text x="52" y="94">80</text>
  </g>
  <line x1="60" y1="356" x2="700" y2="356" stroke="#52514e" stroke-width="1"/>
  <g font-family="sans-serif" font-size="11" fill="#52514e" text-anchor="middle">
    <text x="60" y="374">r1</text><text x="231" y="374">r5</text><text x="402" y="374">r9</text>
    <text x="573" y="374">r13</text><text x="700" y="374">r16</text>
    <text x="380" y="392">round</text>
  </g>
  <!-- threshold 80 -->
  <line x1="60" y1="89.4" x2="700" y2="89.4" stroke="#52514e" stroke-width="1.5" stroke-dasharray="7 4"/>
  <text x="64" y="83" font-family="sans-serif" font-size="12" font-weight="bold" fill="#0b0b0b">VICTORY_THRESHOLD 80 (winners' mean final prestige: 78.7)</text>
  <!-- x(r) = 60 + (r-1)*42.667 ; y(v) = 356 - v*3.333 -->
  <polyline fill="none" stroke="#2a78d6" stroke-width="2" points="60,345.5 102.7,332.6 145.3,320.9 188,309.5 230.7,294.4 273.3,281.4 316,264.6 358.7,248.6 401.3,234.3 444,220.4 486.7,207.2 529.3,194.1 572,182.3 614.7,171.9 657.3,162.4 700,150.8"/>
  <polyline fill="none" stroke="#1baf7a" stroke-width="2" points="60,343.6 102.7,334.3 145.3,324.0 188,309.4 230.7,298.1 273.3,286.4 316,272.8 358.7,261.6 401.3,247.9 444,237.5 486.7,226.7 529.3,215.3 572,198.7 614.7,186.3 657.3,173.6 700,165.0"/>
  <polyline fill="none" stroke="#eda100" stroke-width="2" points="60,344.4 102.7,332.7 145.3,320.7 188,309.0 230.7,291.1 273.3,279.4 316,261.6 358.7,244.3 401.3,228.3 444,216.2 486.7,204.1 529.3,191.8 572,177.4 614.7,165.9 657.3,155.1 700,148.6"/>
  <polyline fill="none" stroke="#008300" stroke-width="2" points="60,344.3 102.7,332.6 145.3,320.8 188,309.0 230.7,291.8 273.3,277.6 316,257.3 358.7,243.6 401.3,227.4 444,211.3 486.7,198.5 529.3,185.8 572,170.6 614.7,159.8 657.3,152.1 700,150.3"/>
  <polyline fill="none" stroke="#4a3aa7" stroke-width="2" points="60,343.7 102.7,328.1 145.3,309.9 188,294.5 230.7,279.6 273.3,262.2 316,247.8 358.7,232.5 401.3,217.5 444,202.5 486.7,187.2 529.3,172.5 572,158.4 614.7,144.5 657.3,131.6 700,119.0"/>
  <g font-family="sans-serif" font-size="12" font-weight="bold">
    <text x="706" y="122" fill="#4a3aa7">Hungary 71.1</text>
    <text x="706" y="145" fill="#8a6500">Venice 62.2</text>
    <text x="706" y="158" fill="#008300">Genoa 61.7</text>
    <text x="706" y="171" fill="#2a78d6">Byzantium 61.6</text>
    <text x="706" y="184" fill="#0e7a54">Ottomans 57.3</text>
  </g>
</svg>

(Direct labels give each series' r16 mean; Hungary's high *average* is its
consistency — its win rate stays in band because averages, not wins, are
plotted. The E2 monopoly nerf is visible in the trade republics' flatter
late curves — Venice/Genoa r16 means fell ~2–3 points vs the pre-errata
figure. Mean battles/game: 11.5.)

**Win-rate evolution across tuning rounds** (fullgame, 1,000 games seed
14530000 unless noted; from TUNING_LOG):

| Stage (threshold) | byz | ott | ven | gen | hun |
|---|---|---|---|---|---|
| old-kernel baseline, commit a21058b (50) | **90.5** | 9.4 | 0 | 0 | 0.1 |
| old-kernel round-1 exit (70) | 14.5 | 15.4 | 29.4 | 19.3 | 21.4 |
| round-91 exit (70) | 16.8 | 14.9 | 19.7 | 24.7 | 23.9 |
| canon-kernel swap, stale threshold (70) | 19.5 | 17.1 | **0.0** | **61.8** | 1.6 |
| canon retune 1 final (82) | 21.5 | 13.6 | 15.5 | 24.6 | 24.8 |
| canon retune 2 final (82) | 21.6 | 13.4 | 15.7 | 24.5 | 24.8 |
| adversarial fix round final (84) | 19.7 | 14.4 | 14.5 | 27.8 | 23.6 |
| pre-errata fresh-seed 3,000g, SEED=24681357 (84) | 18.9 | 13.9 | 13.0 | 27.8 | 26.5 |
| pre-errata verify 5,000g, SEED=987654321 (84) | 19.6 | 14.2 | 14.6 | 26.8 | 24.9 |
| ratified errata round, 1,000g seed 14530000 (80) | 18.4 | 17.3 | 13.4 | 27.1 | 23.8 |
| **errata fresh-seed 3,000g, SEED=24681357 (80) — committed** | **17.7** | **17.3** | **12.3** | **26.3** | **26.4** |
| **errata verify 5,000g, SEED=987654321 (80)** | **18.2** | **17.0** | **13.2** | **25.3** | **26.3** |

---

## 4. Adversarial audit

Six exploit hunts were run against the final errata config (all JSONs
regenerated at the shipped CONFIG, base seeds unchanged; the four verdicts
affected by the errata — beeline, turtle-dominance, economy war-poke,
runaway-leader — are quoted before → after).

### 4.1 Constantinople beeline (`adversarial_cple_beeline.json` — 1,000 games/arm, seed 311002)

A dedicated agent sells everything to besiege Constantinople from round 1.
**Both E1 treason brakes active** (garrison ≤ 4, clock counts only from game
round 6); the Bombard follows the E3 draw model. Full grid, pre-errata →
errata:

| Arm | SD by beeliner | SD completes ≤ r8 |
|---|---|---|
| solo_ottoman | 22.6% → **16.2%** | 15.0% → **8.3%** |
| solo_genoa | 18.8% → **13.2%** | 11.4% → **5.9%** |
| solo_venice | 6.5% → **6.2%** | 1.3% → **0.6%** |
| duo gang-up | 23.1% → **17.7%** | 15.4% → **8.2%** |
| guard_ottoman (Byz plays defensive guard) | 23.8% → **7.3%** | 16.6% → **0.0%** |
| guard_genoa | 17.5% → **0.0%** | 10.9% → **0.0%** |
| solo_ottoman, Treason card removed | 0.0% → **2.8%** | 0.0% → **0.0%** |
| guard_ottoman, Treason card removed | 0.0% → **7.0%** | 0.0% → **0.0%** |

**Both hunt-brief bars now PASS everywhere** (SD ≤ 20% with one dedicated
beeliner; ≤ 10% completing by r8; Byzantium never eliminated before r8).
Treason still supplies most SD wins in undefended-Byzantium arms
(sdWithTreasonHeld 140/162 solo_ottoman) because Constantinople's authored
4-unit start garrison satisfies the ≤ 4 gate when Byzantium never
reinforces — but a defended city turns the card off entirely (guard arms
7.3%/0.0%, treason-held 18/0). The noTreason counterfactuals are no longer
0.0%: that residue (2.8–7.0%, earliest r15) is the E3 r11–16 Bombard draw
opening the walls legitimately — the same priced-in late-game SD as the
fullgame T4 band (11.9–12.3%, all completions r12+).

History: the pre-errata adversarial fix round had already closed the four
non-card capture paths (canon §8.2.3 RAW blockade contest, harbor
reinforcement, besieged-garrison insolvency exemption, omen unit-loss floor
3 — progression 78.1% SD → 22.6%), leaving the ratified rare as the sole
breach (filed as register item 1). The E1 errata closes it; Constantinople's
authored 4-unit start garrison still did not need inflating.

### 4.2 Trade-griefing / economy exploit (`adversarial_economy_exploit.json` — 1,000 games/arm, paired seeds 311005+)

Pre-fix, blockade *cancelled* route income: a single 5-gold picket galley
deleted a trader faction (trader-Genoa **0.1%** win under grief vs 49.8%
control). Fix: canon §5.2 halving (`BLOCKADE_INCOME_MULT 0.5`; only severed
routes yield 0). **Errata re-measure (E5a unjustified-war −1 + E5b pillage
active): is the 2-unit self-lifting war-poke still ~free?** Mostly yes —
but it is now *priced* and its damage remains bounded: trader-Genoa under
the dedicated Ottoman griefer wins **34.7%** vs 48.7% control (pre-errata
36.6% vs 51.3%); with the blockade mechanism switched off entirely, also
**34.7%** — the blockade mechanism's attribution is now **0.0pp** (was
~0.5pp), i.e. the entire victim delta is the war itself, not the picket.
E5a charges the poke campaign at war *declaration* only — an ongoing
2-unit siege keeps the same war warm, so a dedicated campaign costs ≤ ~1
prestige total (and is often free when the trader victim is the prestige
leader — a canon-intended gang-up-the-leader justification). Measured
fullgame-wide: 0.79 unjustified-war charges/game. The **passive-picket**
griefer still wins 0.0% (pure self-sacrifice); the fight-back arm is a
real war (57.7/7.7), not an exploit. E5b does not touch the poke line (no
mercenaries in a 2-unit poke). Levy-flood: never beats the flooding
faction's best honest policy (max delta +3.5pp for ottomans, inside its
own rusher line and within noise). Omen income swings measured 0.20–0.35×
mean round income (§2.15). **EXPLOIT DEAD; residual poke wart re-filed
(§5 still-open item 5: full closure needs canon §11 tribute peace, not a
one-off charge).**

### 4.3 Mercenary rush (`adversarial_merc_rush.json` — 500 games/faction/variant, paired seeds 311001+)

Hire-mercs-for-one-battle-then-stiff-them ("cycle") vs honest upkeep, with
**E5b merc-revolt pillage** now pricing every stiff (−2 gold + a pillaged
province round): no exploit thresholds crossed (overall cycle 6.3% vs
honest 6.0%, both far below the 13.3% control line). Paired same-seed
cycle-vs-honest z = 1.81 → **1.31** (well inside noise) — the stiffing
gradient shrank under the errata; former register item 7 is CLOSED (a
scope gap on Janissary/Black-Army pay remains, §5 still-open item 6).

### 4.4 Runaway leader (`adversarial_runaway_leader.json` — 2,000 games/arm, seed 311004)

**Errata re-measure (E4 three independent +4 objectives).** The round-8
unique leader now wins **69.4%** (pre-errata 72.8%; line 70% — under the
bar for the first time); 2-keys-at-r6 wins 18.5% vs the 75% line.
**Objective flips (kingmaker check): the end reveal now flips the apparent
round-16 leader in 53/553 = 9.6% of unique-leader cap-decided games**
(pre-errata 0.0% with the single all-3 objective) — a live, hidden endgame
channel, far below the 30% kingmaker-lottery bar; in every flip the actual
winner had scored objective prestige. **Per-objective completion: 6.0%**
(1,798/30,000 objective-slots across surviving faction-games; count
histogram 0/1/2/3 = 8,455/1,309/219/17 — ≥1 objective completed in 15.5%
of surviving faction-games; 459 objectives actually scored across 323 of
595 cap games). Leader-pressure engagement unchanged (131 changed
decisions/arm; ON−OFF r8 delta −0.4pp). Residual lead stickiness is now
*at* the line rather than over it — kept open as a design note (§5
still-open item 3).

### 4.5 Turtle dominance (`adversarial_turtle_dominance.json` — seed 311003)

**Errata re-measure (E2 diminishing monopoly prestige, +2 first / +1
additional).** Monoculture ceilings, pre-errata → errata: monopoly-max
turtler as Venice **66.2% → 57.5%**, as Genoa **61.7% → 60.0%**; trade-max
Venice 36.8%, Genoa 55.7%; shipping-trader control seat Venice 39.8%,
Genoa **60.0%** (pre-errata 57–64%). Ledgers show why the Genoa residual
survives E2: its trade prestige fell to ~29.5 avg but its great-works
prestige (19.0–19.7 — funded by trade INCOME, which E2 does not touch)
carries the seat. The Venice ceiling responded strongly; the Genoa
trade-seat monoculture ceiling is re-filed (§5 still-open item 2: needs a
competing gold→prestige sink or at-risk trade). All-five-turtle tables:
48.3% of games end with winner margin <2 (73.7% of its cap-decided games)
— unchanged class, §5 still-open item 1. Lone-turtle free-riding stays
dead (16.6–18.8% overall vs the 40% bar).

### 4.6 Faction floor (`adversarial_faction_floor.json` — 80 grid configs × 300 + 1,000-game verification cells, seeds 111006/311006)

Re-run at the errata config: flags remain cell-level only (no aggregate
target breached): ceiling genoa+trader 64.7% vs a mixed field and
hungary+opportunist cells; floors are the dead faction×policy corners
(ottoman-turtler 0.0%, venice/genoa rusher+opportunist 0–1.3%) — an
archetype-agent limitation (naval factions have land-shaped
rusher/opportunist scripts), filed as harness follow-up (faction-aware
agents), not a rules change. Eliminations 0 everywhere; no cell dies by
round 8.

---

## 5. NEEDS-RULES-CHANGE register

The register now has two parts: errata **ratified and re-measured** this
round (2026-07-11), and the still-open design decisions.

### 5.A Ratified + re-measured (coordinator errata E1–E5, 2026-07-11)

Each item: the former register finding, the ratified fix as implemented,
and the before → after evidence at the final config (threshold 80).

**E1 — Treason at the Gate** *(closes former item 1, HIGH)*. Ratified card
gates: playable only vs a garrison of **≤ 4 units**, and its "2+
consecutive siege rounds" counts **only siege rounds in game round ≥ 6**.
Re-measured (beeline suite, 1,000 games/arm, seed 311002): one-beeliner SD
22.6% → **16.2%** (bar ≤20%), ≤r8 completions 15.0% → **8.3%** (bar ≤10%),
guard arm 23.8% → **7.3%** — **all bars pass**; the exploit verdict flag is
now false.

**E2 — Monopoly prestige diminishing returns** *(closes former item 2's
errata half, HIGH)*. +2/round first monopoly, **+1/round each additional**;
no escort requirement. Re-measured (turtle-dominance, seed 311003):
monopolyMax Venice 66.2% → **57.5%**, Genoa 61.7% → **60.0%**. The
`VICTORY_THRESHOLD` was re-derived as the errata mandated (84 → **80**;
§2.13). Residual: the Genoa trade-seat ceiling is income-driven, not
monopoly-prestige-driven — re-filed as still-open item 2.

**E3 — Great Bombard canon draw model + emplacement** *(closes former item
3, this report's own divergence flag)*. The omen is drawn at a per-game
seeded round **uniform over rounds 11–16** (canon Era III deck position)
and the gun is **emplaced for 1 full siege round before it first fires**.
Re-measured: fullgame SD 8.0–8.2% → **11.9–12.3%** — inside both the 1–15%
band and the errata brief's <15%; all SD completions r12+; T5d re-derived
(capture within 2–4 siege rounds AFTER first fire >50%): worst **91.7%**,
median capture siege round 3.

**E4 — Three independent secret objectives** *(closes former item 4,
LOW)*. 3 per faction (canon), **+4 each independently** at game end.
Re-measured (runaway-leader, 2,000 games/arm, seed 311004): per-objective
completion 0.3% (all-3 combo) → **6.0%** per objective (≥1 completed in
15.5% of surviving faction-games; hist 0/1/2/3 = 8,455/1,309/219/17);
end-reveal flips 0.0% → **9.6%** of unique-leader cap games (live channel,
far under the 30% kingmaker bar); P(r8 leader wins) 72.8% → **69.4%**
(under the 70% line).

**E5a — Unjustified-war prestige cost** *(prices former item 5a)*.
Declaring war without justification costs **−1 prestige** (sim
justification mapping: target holds one of your objective provinces / is
the prestige leader / attacked you first — §2.13). Re-measured
(economy-exploit, seed 311005): the poke war is now priced (0.79
charges/game table-wide) but binds once per war — see still-open item 5.
Blockade-mechanism attribution 0.0pp; passive picket still 0.0% win.

**E5b — Mercenary-revolt pillage** *(closes former item 7, LOW)*. Unpaid/
unfed merc desertion pillages the host province (−2 stored gold, yield 0
next round — canon EVENT_CARDS #22). Re-measured (merc-rush, seed 311001):
cycle-vs-honest z = 1.81 → **1.31**; cycle 6.3% vs honest 6.0%, both far
under the 13.3% control — stiffing gradient inside noise.

### 5.B Still open (design decisions, none exploit-grade)

**1. All-turtle near-tie endings** (was item 7): 48.3% of 5-turtler games
end with winner margin <2 (73.7% of its cap-decided games); the §13.3
tiebreak cannot separate margin-1 finishes. Mirror-table passive accrual
stays flat even with E2.

**2. Trade-seat monoculture ceiling** (residual of item 2): monopolyMax /
shipping-trader Genoa still ~56–65% in-seat under monoculture protocols
(and genoa+trader 64.7% in the faction-floor mixed cell). Ledger
decomposition shows the driver is trade INCOME funding great works, not
monopoly prestige — needs a competing gold→prestige sink or at-risk trade
rules (escorts/piracy), plus faction-aware agents to confirm at harness
level.

**3. Runaway-leader brakes** (was item 8, MEDIUM → at-the-line): r8
unique-leader predictivity 69.4% (line 70%). Canon's remaining catch-up
levers (diplomacy gang-ups, tribute peace, late-era crisis weighting) are
unmodeled; re-measure when diplomacy lands.

**4. Victory-check ordering** (was item 6): sudden death still outranks a
same-Cleanup threshold win (canon §13.3 "wins immediately, regardless of
prestige" — confirm intent for the engine's Cleanup resolver).

**5. War pokes, residual** (was item 5a): E5a charges a declaration once;
an ongoing 2-unit siege keeps the same war warm indefinitely, so a
dedicated harassment campaign still costs ≤ ~1 prestige total (often 0
when the victim is the prestige leader). Full closure needs canon §11
tribute peace / reputation.

**6. Merc-revolt scope gap** (new, LOW): canon EVENT_CARDS #22 also
pillages on unpaid Janissary/Black-Army *gold* pay; E5b as ratified scopes
the sim revolt to mercenaries. The engine should follow the card text.

---

## 6. Model divergence appendix — vs GAME_DESIGN.md @ 2b42386

Canon systems the sim does **not** model. For each: what's missing and a
sensitivity note for when the engine (which will implement full canon) sees
different numbers.

| # | Unmodeled canon system | Sensitivity note |
|---|---|---|
| 1 | **Mercenary bid market** (§6.3): 2–3 named companies/round, turn-order auction, unsold → 1-in-3 hired by an NPC minor | A competitive gold sink + delayed neutral-garrison growth. Sim mercs use only §6.2 terms (9g/×2 grain). Expect slightly poorer rush treasuries and tougher late neutrals; re-check T6 strike and the beeline ≤r8 numbers when it lands. |
| 2 | **Spy actions** (§10.7): 1 action + 3g, 1d6 ≥ 3; peek omens / view objectives / incite unrest (province yields 0 next Income) | Canon calls it "never a war-winner". Incite-unrest is a targeted −1-province-income grief: worst case ≈ one more picket-class harassment channel (cf. §4.2's ~0.5pp mechanism attribution). Validate the 3g price point against griefer arms. |
| 3 | **NPC minor vassals** (§11.5): vassalize action (bribe 8g + 4×garrison, roll ≥4), **tribute = province yields ×0.5**/Income, levy call, +1 prestige/round, revolts | Adds a purchasable income+prestige channel that competes with conquest — mid-game gold gets more valuable and the conquest track less mandatory. Byz/Hun (high-prestige-tier, cash-poor) profiles shift most; re-run T1 and the accrual multiple (§2.13) when vassals land. |
| 4 | **Royal marriage** (+2/round to both, §13.1) | Worth ~+24–32 prestige over a game to a stable pair — comparable to a monopoly. Directly inflates winner accrual: **re-sweep `VICTORY_THRESHOLD` when diplomacy lands** (start from ~15.2× the new measured accrual, §2.13). |
| 5 | **Diplomacy layer** (§11): alliances, NAPs, tribute peace, treaty-break betrayal −2…−4 | Wars in-sim are implicit; E5a now prices an unjustified DECLARATION (−1) but treaties, tribute peace, and break penalties stay unmodeled (→ §5.B item 5). Negotiated peace mostly *reduces* grief viability; expect trader floors to rise slightly. |
| 6 | **Fleet battles** (§7.6, §5.3 escort/sever duels) | Sim computes sea-zone presence from ported galleys; no pure fleet battles, so blockades vs fleet-holding ports are under-produced and 2 tactic cards (Pilot ×3, Greek Fire) are dead. The siege module measures the fully-blockaded case directly, so T5 targets stand; naval-identity factions (Venice) likely *gain* when real fleet combat lands. |
| 7 | **Movement/info tactic cards** (Forced March, Ears in the Bazaar, Feigned Retreat, Chain Across the Horn, A Death in the Palace) | 7 designs / 15 of 47 cards are dead draws in-sim → measured card-layer impact (§2.9) is an underestimate, and hand pressure (limit 4) is softer than it will be. Re-measure card impact in engine playtests. |
| 8 | **Secret objectives: sim shape vs canon flavor**: E4's 3 independent objectives are modeled as "hold seeded province i at game end" ×3; canon/FACTIONS objectives are richer (faith goals, route goals, named conquests) | The +12 hidden swing and kingmaker channel are now measured (§4.4: 6.0% per-objective completion, 9.6% reveal flips); richer objective TYPES may change completion rates — re-check flip share when the real objective cards are authored. |
| 9 | **Byzantine auto-repel power** (FACTIONS: first two siege rounds of Constantinople take no bombardment damage) | Stacks with the E3 emplacement: first Bombard damage would slip from siege round 2 to ~4, shifting capture to ~5–7 siege rounds; with late draws (r14–16) the City then often survives to the cap — would cut SD below the current 11.9–12.3% and strengthen Byzantium. T5 targets were calibrated without it per the coordinator's spec; re-run the siege module when implemented. |
| 10 | Smaller gaps: tax postures (§4.2), 3:1/2:1 market ratios (§4.3), full §5.2 route-income formula + piracy, §6.4 stack limits, ARCHER/CAVALRY/WARSHIP as separate slots (§6.1), University/Granary and the 8-building §9.1 table, multi-round Great Works (§9.2), wall repair (§8.2.5), itemized era decks (§12), 4–5-player face-up omen preview, ±1 morale | Each individually second-order for the tuned aggregates (T1–T6); collectively they argue for a **regression re-run of `sim:full` against engine-measured accrual once the engine exists** — the balance-regression CI job (PR #1) expects exactly the `sim:smoke`/`sim:full`/`sim:report` scripts this package ships. |

---

## 7. Reproduction

All runs are deterministic given (GAMES, SEED): the RNG is seeded per game
(`seed = SEED + gameIndex`), policy assignment is a seeded shuffle, and no
wall-clock or platform entropy enters the simulation.

```bash
cd sim
npm install            # tsx + typescript only

npm run sim:smoke      # SMOKE=1 sim:all — fast CI pass (~seconds), asserts the §7.4 kernel checks
npm run sim:full       # = sim:all: combat, siege, economy, pacing, fullgame at full scale
npm run sim:report     # read-only headline summary of results/*.json (never simulates)

# individual modules
npm run sim:combat     # ~136 s  (100k trials/cell, seed 789415)
npm run sim:siege      # ~13 s   (20k iterations/cell, seed 20260711)
npm run sim:economy    # ~1 s    (deterministic projections + price sweep)
npm run sim:pacing     # ~0.6 s  (10k trajectory games, seed 14530529)
npm run sim:fullgame   # ~10 s / 3,000 games (≈3.2–3.4 ms/game)

# env overrides (fullgame): GAMES=<n> SEED=<n>
GAMES=3000 SEED=24681357  npm run sim:fullgame   # reproduces committed results/fullgame.json
GAMES=5000 SEED=987654321 npm run sim:fullgame   # the independent verification run quoted in §1

# adversarial suite (not in npm scripts; writes results/adversarial_*.json)
GAMES=1000 npx tsx src/adversarial/run_cple_beeline.ts   # seed 311002 (committed JSON is 1,000 games/arm)
npx tsx src/adversarial/run_economy_exploit.ts   # seed 311005
npx tsx src/adversarial/run_merc_rush.ts         # seed 311001
npx tsx src/adversarial/run_runaway_leader.ts    # seed 311004
npx tsx src/adversarial/run_turtle_dominance.ts  # seed 311003
npx tsx src/adversarial/run_faction_floor.ts     # seeds 111006 / 311006
```

Seeds used for the committed artifacts: fullgame **24681357** (3,000 games;
default without env overrides is 14530000/1,000); 5,000-game verify
**987654321**; combat 789415; siege 20260711; pacing 14530529; adversarial
311001–311006 + 111006 (per-file `config.baseSeed`).

**Determinism note.** All statistics in this report were read back from
executed runs at the shipped errata CONFIG (threshold 80). The committed
`fullgame.json` is the 3,000-game `SEED=24681357` run executed at that
config; the §2.13 accrual statistics (5.277/round, winner mean final 78.7,
multiple 15.16×) were measured over the same replayed games, and every
sudden-death completion in it lands at rounds 12–16. `sim:report` renders
headline numbers from the committed JSONs without re-simulating.

**Errata-round provenance (2026-07-11).** All `results/*.json` were
regenerated at the ratified-errata CONFIG (E1–E5 + `victoryThreshold: 80`)
with the base seeds unchanged: combat 789415 (kernel untouched — 0
violations), siege 20260711 (E3 emplacement curve, T5d re-derived),
economy, pacing (E2+E4 in the trajectory model, window 78–84), fullgame
24681357 (committed) — plus the independent `GAMES=5000 SEED=987654321`
verify quoted in §1 (byz 18.2 / ott 17.0 / ven 13.2 / gen 25.3 / hun 26.3;
threshold-decided 57.5%, SD 11.9%; all six targets green) and the default
`GAMES=1000 SEED=14530000` A/B runs recorded in TUNING_LOG. The six
adversarial JSONs were regenerated at the same config and seeds
(311001–311006 + 111006); the four errata-affected verdicts are quoted
before → after in §4. Pre-errata numbers cited for comparison come from
the previous committed artifacts (adversarial fix round, threshold 84).
The config is seed-robust across three independent seed sets (14530000,
24681357, 987654321).
