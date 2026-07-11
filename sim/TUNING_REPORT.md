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

All six balance targets are green at the shipped CONFIG
(`victoryThreshold: 84`). Primary evidence is the independent 5,000-game
verification run at the shipped config (`GAMES=5000 SEED=987654321`,
re-executed at HEAD — see the provenance note in §7); the committed
`results/fullgame.json` holds the 3,000-game fresh-seed final run
(`GAMES=3000 SEED=24681357`) and was reproduced bit-identically by re-running
the harness (see §7).

| Headline metric | 5,000-game verify (primary) | 3,000-game final (committed) | Target |
|---|---|---|---|
| Byzantium win rate | **19.6%** | 18.9% | 12–30% |
| Ottomans win rate | **14.2%** | 13.9% | 12–30% |
| Venice win rate | **14.6%** | 13.0% | 12–30% |
| Genoa win rate | **26.8%** | 27.8% | 12–30% |
| Hungary win rate | **24.9%** | 26.5% | 12–30% |
| Policy: rusher / trader / turtler / opportunist | **13.6 / 26.4 / 18.5 / 21.6%** | 12.5 / 25.7 / 19.2 / 22.6% | each 10–40% |
| Median end round (mean) | **16** (15.53) | 16 (15.51) | 12–16 |
| Games ending before round 11 | **0.4%** | 0.3% | <10% |
| Games ending rounds 12–16 | **98.9%** | 99.0% | — |
| Victory split: threshold / cap / sudden death | **43.8 / 48.0 / 8.2%** | 44.2 / 47.8 / 8.0% | threshold 40–70%, SD 1–15% |
| Sudden-death completions | **all 408 at round 16** | **all 240 at round 16** | none before r10 |
| Eliminations | **0** | 0 | no early kingmaker deaths |
| Constantinople: intact-T5 assault, worst case | — | **0.31%** (siege module) | <2% |
| Constantinople: no Bombard + no blockade, 12 siege rounds | — | **0.0%** | <10% |
| Constantinople: full blockade starve-out, median round | — | **7 / 9 / 11** (garrison 6/8/10) | ≥6 |
| Constantinople: with Great Bombard, capture ≤4 rounds | — | **94.5–100%** | >50% |
| Economy: solvency / rush credibility | — | **15/15 solvent, 5/5 strike ≥8** | all pass |

**Three sentences for the engine lead.**

1. Transcribe §2 verbatim into `balance.ts`: every number is either a direct
   canon value (§-cited) or a sim-validated tuning of a value canon
   explicitly left to this report (the victory threshold, the Great Bombard
   omen round, map yields/routes) — the game is balanced *as a system*, so
   change values only in pairs with a re-run of `npm run sim:full`.
2. The two deliberate divergences from canon text that carry the balance are
   the **Great Bombard omen at round 15** (canon Era III opens at round 11;
   at r11 sudden death hits 23.7% of games vs the 1–15% target — §5 item 3)
   and the **map/trade deltas in §2.10/§2.12** (one setup monopoly per
   trade-identity faction, Hungary's ratified overland Danube corridor).
3. One ratified tactic card — **Treason at the Gate** — needs a text errata
   before dedicated Constantinople-beeline play is safe (residual 18.8–23.8%
   sudden death for a dedicated beeliner, 100% of it through that card in
   land-power arms; §4/§5 item 1); everything else in the adversarial suite
   is fixed and re-verified or filed as a design-level follow-up.

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
| `SUDDEN_DEATH_HOLD_ROUNDS` | 2 | canon §13.3; fullgame SD 8.0–8.2% in the 1–15% band |
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
| mercenary (hired CAVALRY) | 9 (= 6 × 1.5) | 0 | 0 | 4 (= 2 × 2) | 0 | 3/2 | canon §6.2 terms; adversarial_merc_rush.json: no exploit flags, cycle-vs-honest z = 1.81 (n.s.) |
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
| `OTTOMAN_LEVY_RECRUIT_BONUS` | +2 levies per recruit action | FACTIONS devshirme ("raised anywhere, in bulk"); ottomans 13.9–14.2% in band |
| `MERCS_ARRIVE_INSTANTLY` | true | canon §6.2 |

### 2.5 Faction modifiers (`FACTION_MODS: Record<Faction, …>`)

| Key | Value | Evidence |
|---|---|---|
| `TRADE_INCOME_MULT` | VENICE 1.5, GENOA 1.5, others 1.0 | canon §5.2 merchant bonus; trader policy 26.0% in band |
| `CAPITAL_EXTRA_GOLD` | BYZANTIUM 2, others 0 | Hagia Sophia income proxy; byzantium 18.9–19.6% in band (was 90.5% at old proxy 4) |
| `GHAZA_CITY_CAPTURE_PRESTIGE` | OTTOMAN **+2** per walled city taken (on top of §2.13 capture prestige), others 0 | FACTIONS Ghaza (canon +1; raised 1→2 in the adversarial fix round after the §8.2.3 harbor fixes slowed the Ottoman siege game — within the §14 asymmetry budget). Ottomans 10.0% → 13.9–14.2% |

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
| `GREAT_BOMBARD_REVEAL_ROUND` | **15** (omen `great-bombard-forged`; canon Era III opens r11 — **flagged**, §5 item 3) | TUNING_LOG retune-1 it2–4 SD sweep: r11 23.7% → r12 21.7% → r13 18.6% → r14 13.4% → r15 8.5–8.7% |
| `GREAT_BOMBARD_FREE_TO_OTTOMAN` | true; else auction — sim fallback: richest payer at `GREAT_BOMBARD_AUCTION_GOLD = 40` | canon §8.4 (card auctions gold+marble bids; sim simplifies) |
| `GREAT_BOMBARD_DAMAGE_DICE` | 2 wall-damage dice/round (~4 avg, max 6); **lifts the T5 masonry cap for the whole train** | canon §8.4; siege.json T5d: breach r2, capture ≤4 rounds 94.5–100% |

Unmodeled Bombard riders (ship per canon §8.4): 3-grain upkeep/silence,
1-province move, no mountains, sink-on-transport-loss, capture-as-loot.
Byzantine "auto-repel first two siege rounds" (FACTIONS) unmodeled —
sensitivity: shifts T5d capture from ~2–4 to ~4–6 siege rounds (§6).

### 2.9 Tactic cards (canon §7.7) — ratified magnitudes as fixed inputs

The 23 ratified designs at final magnitudes are encoded verbatim in
`CONFIG.tacticCards` (deck 47: Common ×3, Uncommon ×2, Rare ×1). **Magnitudes
were fixed inputs to tuning** — do not retune them; the one open errata is §5
item 1. Sim plays at most ONE card per side per battle (canon allows one per
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
| **Treason at the Gate** | R×1 | 4g after 2+ siege rounds: city falls; remove from game | **the §5-item-1 errata target** — beeline SD residual is 100% this card in land-power arms |
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
| `TRADE_MONOPOLY_PRESTIGE` | +2/round (open route, both endpoints owned) | canon §13.1; **known ceiling** — §5 item 2 |
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
| `PRESTIGE_TRADE_MONOPOLY` | +2/round | canon §13.1; ceiling flagged, §5 item 2 |
| `PRESTIGE_GREAT_WORK` | +5 once | §2.11 |
| `PRESTIGE_DECISIVE_BATTLE` | +1 | canon §13.1 (loser wiped or routed; withdrawals don't count) |
| `PRESTIGE_OUTNUMBERED_WIN` | +1 (stacks with decisive) | canon §13.1 |
| `PRESTIGE_WALLED_CITY_CAPTURE` | +2 (T1–T3), **+3 (T4–T5)** — BY FORCE only (walk-ins score nothing) | canon §13.1 |
| `PRESTIGE_WAR_WON` | +3 | canon §13.1 |
| `PRESTIGE_LOSE_CAPITAL` | −3 | canon §13.1 |
| `PRESTIGE_SECRET_OBJECTIVE` | **+4 each, scored at GAME END only** (counts for the round-16 comparison; can never trigger an early threshold win) | canon §13.1; dead channel at 1 objective — §5 item 4 |
| `GHAZA_CITY_CAPTURE_PRESTIGE` | OTTOMAN +2 | §2.5 |
| per-route prestige / per-province capture prestige / Constantinople extra | **0** (levers, off — canon has none) | retune: the conquest track (+2/province) was a pre-canon lever, removed |
| `TURN_ORDER` | re-sort each Cleanup, lowest prestige first (tiebreak fewer provinces) | canon §13.4; modeled since the fix round (runaway-leader hunt) |
| `CAP_TIEBREAK` | most key cities, then most gold | canon §13.3; modeled since the fix round |
| **`VICTORY_THRESHOLD`** | **84** (checked at Cleanup only) | see below |

**VICTORY_THRESHOLD = 84**, expressed both ways per the canon §13.2 handoff
("threshold supplied by balance TUNING_REPORT"):

- **Absolute: 84 prestige**, first checked at Cleanup (canon §13.2's 25/30/35
  are pre-tuning placeholders — the §13.1 conquest rows plus monopoly/capital
  income raise total inflow far beyond them).
- **As a multiple of winner accrual: 84 = 15.94× the mean winner
  prestige-accrual per round** — 5.269 prestige/round, computed over exactly
  the 3,000 committed `results/fullgame.json` games (mean of per-game
  final-prestige/rounds; mean winner final prestige 81.1 at mean end round
  15.51; the aggregate form 84 ÷ (81.1/15.51) = 16.07×). The 5,000-game
  verify measures 5.250/round → 16.00×, and retune-round-2 measured
  5.274/round on the default seed — the ratio is seed-stable at ~15.9–16.0×.
  If future rules changes move mean winner accrual, re-derive the absolute
  value from ~16× and re-verify T1–T4.
- Calibration lineage: 82 vs 84 A/B in the adversarial fix round — 84 was
  better on T1 margins and r8-leader predictivity, and trims the
  genoa/venice trader threshold ceiling after the §5.2 blockade-halving fix
  made trade income more robust.
- **Scope caveat: calibrated at 5 players only.** Canon scales the threshold
  by player count; 2–4-player values need their own fullgame runs (suggest
  keeping 84 for 4–5 and re-simming before shipping 2–3-player values).

### 2.14 Economy misc

| Key | Value | Evidence |
|---|---|---|
| `GRAIN_MARKET_BUY_GOLD_PER_GRAIN` / `SELL` | 2 / 1 | economy solvency 15/15 (canon §4.3's 3:1/2:1 generic ratios unmodeled, §6) |
| `GRAIN_SHORTFALL_DESERTION_FRACTION` | 0.25/round of unfed units | sim shape; canon §4.4 is 1 unit per grain short — same direction, different sharpness (§6) |
| `UNPAID_MERC_DESERTION` | 100%, desert first | canon §4.4/§6.2 |
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
omen has resolved):

| Scenario | garrison 6 | garrison 8 | garrison 10 |
|---|---|---|---|
| no Bombard, no blockade — capture ≤12 rounds | **0.0%** | 0.0% | 0.0% |
| full blockade, no Bombard — capture prob / median round | 100% / **7** | 99.97% / **9** | 99.89% / **11** |
| Great Bombard, open sea — capture ≤4 / median | 100% / 2 | 99.7% / 2 | **94.5%** / 2 |
| Great Bombard + blockade — capture ≤4 | 100% | 99.7% | 94.5% |

Targets: T5a intact-assault worst **0.31%** (<2%) · T5b **0.0%** (<10%) ·
T5c min capture 99.9%, min median **7** (≥6) · T5d worst **94.5%** (>50%).
With the omen at round 15, the City falls rounds 15–16 — the 1453 anchor.

Capture curves (garrison 8; P(capture ≤ k siege rounds); table + figure):

| k rounds | 1 | 2 | 3 | 4 | 8 | 9 | 10 | 12 |
|---|---|---|---|---|---|---|---|---|
| Great Bombard (open sea) | 91.0% | 99.4% | 99.7% | 99.7% | 99.7% | 99.7% | 99.7% | 99.7% |
| full blockade, no Bombard | 0 | 0 | 0 | 0 | 0 | 98.8% | 100% | 100% |
| no Bombard, no blockade | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

<svg viewBox="0 0 720 340" width="720" role="img" aria-label="Constantinople capture probability by siege round, garrison 8: Great Bombard reaches 99 percent by round 2; full blockade starves the city out at rounds 9 to 10; without either the city never falls." xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="720" height="340" fill="#fcfcfb"/>
  <text x="60" y="24" font-family="sans-serif" font-size="14" font-weight="bold" fill="#0b0b0b">Constantinople: P(capture &#8804; k siege rounds) — garrison 8, 20k iterations/cell</text>
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
  <!-- Great Bombard, open sea: (0,0) (1,.910) (2,.994) (3,.997) ... flat -->
  <polyline fill="none" stroke="#2a78d6" stroke-width="2" points="60,300 113,81.6 166,61.4 220,60.7 700,60.7"/>
  <!-- full blockade, no Bombard: 0 through k=8, (9,.988) (10,1.0) -->
  <polyline fill="none" stroke="#1baf7a" stroke-width="2" points="60,300 486,300 540,62.8 593,60 700,60"/>
  <!-- no Bombard, no blockade: flat 0 -->
  <polyline fill="none" stroke="#eda100" stroke-width="2" stroke-dasharray="6 3" points="60,299 700,299"/>
  <g font-family="sans-serif" font-size="12" font-weight="bold">
    <text x="230" y="52" fill="#2a78d6">Great Bombard (median capture round 2)</text>
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

Threshold sweep 15–85 over archetype accrual trajectories:
all-criteria window **75–81**, recommendation 78. At 84 it predicts median
end r16, 0% before r11, threshold-decided 29.3% — the engine measures
43.8–44.2%. The abstraction cannot model inter-player suppression and its
threshold-share estimate diverges from the engine at the top of the sweep;
it was used only for coarse windowing. **`fullgame` is ground truth for
pacing** (T3 measured there, both seeds green).

### 3.5 Full-game Monte-Carlo (`results/fullgame.json` + 5,000-game verify)

Faction × policy win rates (5,000-game verify, % of that faction's seats
with that policy):

| faction | rusher | trader | turtler | opportunist |
|---|---|---|---|---|
| byzantium | 14% | 14% | 12% | **39%** |
| ottomans | **31%** | 4% | 0% | 21% |
| venice | 1% | **32%** | 25% | 0% |
| genoa | 1% | **62%** | 44% | 0% |
| hungary | 20% | 20% | 12% | **48%** |

Aggregates are in band; the wide cell spread (dead corners: ottoman-turtler
0%, venice/genoa rusher+opportunist 0–1%; genoa-trader as the strongest cell,
consistent with §4.6's 60–64% ceiling flag) is a scripted-agent limitation
filed for faction-aware agents — no aggregate target covers cells.

Game length (5,000-game verify): median 16, mean 15.53.

```
r 9                                 6
r10                                 12
r11  ▎                              35
r12  ▌                              68
r13  █▌                             200
r14  ██▍                            315
r15  ████▎                          541
r16  ██████████████████████████████ 3823
```

Mean prestige by round (3,000-game committed run; survivor-averaged) against
the threshold — the average table does *not* cross 84, which is why 39–48%
of games go to the round-16 cap and only winners (mean final 81.1) get
threshold-close:

<svg viewBox="0 0 830 400" width="830" role="img" aria-label="Average prestige by round for the five factions rises roughly linearly from about 3.5 at round 1 to 59 to 72 at round 16, with Hungary highest throughout; the victory threshold 84 sits above every average curve." xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="830" height="400" fill="#fcfcfb"/>
  <text x="60" y="24" font-family="sans-serif" font-size="14" font-weight="bold" fill="#0b0b0b">Mean prestige by round vs VICTORY_THRESHOLD 84 (3,000 games, seed 24681357)</text>
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
  <!-- threshold 84 -->
  <line x1="60" y1="76" x2="700" y2="76" stroke="#52514e" stroke-width="1.5" stroke-dasharray="7 4"/>
  <text x="64" y="70" font-family="sans-serif" font-size="12" font-weight="bold" fill="#0b0b0b">VICTORY_THRESHOLD 84 (winners' mean final prestige: 81.1)</text>
  <!-- x(r) = 60 + (r-1)*42.667 ; y(v) = 356 - v*3.333 -->
  <polyline fill="none" stroke="#2a78d6" stroke-width="2" points="60,345.5 103,332.5 145,320.4 188,308.8 231,293.6 273,280.5 316,263.7 359,247.7 401,233.3 444,219.3 487,205.7 529,192.2 572,179.7 615,168.3 657,159.9 700,153.4"/>
  <polyline fill="none" stroke="#1baf7a" stroke-width="2" points="60,343.6 103,334.3 145,323.9 188,309.3 231,298.0 273,286.2 316,272.7 359,261.6 401,247.7 444,237.2 487,226.4 529,216.1 572,200.7 615,189.3 657,173.1 700,157.0"/>
  <polyline fill="none" stroke="#eda100" stroke-width="2" points="60,344.4 103,332.7 145,320.7 188,309.0 231,291.1 273,279.4 316,261.6 359,244.3 401,228.2 444,216.2 487,204.0 529,191.7 572,177.3 615,165.4 657,153.6 700,142.1"/>
  <polyline fill="none" stroke="#008300" stroke-width="2" points="60,344.3 103,332.5 145,320.8 188,309.0 231,291.8 273,277.6 316,257.3 359,243.6 401,227.5 444,211.3 487,198.6 529,185.8 572,169.9 615,158.1 657,148.1 700,138.9"/>
  <polyline fill="none" stroke="#4a3aa7" stroke-width="2" points="60,343.7 103,328.1 145,309.1 188,293.7 231,278.7 273,261.3 316,246.9 359,231.7 401,216.7 444,201.7 487,186.4 529,171.7 572,156.8 615,142.7 657,129.7 700,116.8"/>
  <g font-family="sans-serif" font-size="12" font-weight="bold">
    <text x="706" y="120" fill="#4a3aa7">Hungary 71.8</text>
    <text x="706" y="140" fill="#008300">Genoa 65.1</text>
    <text x="706" y="150" fill="#8a6500">Venice 64.2</text>
    <text x="706" y="163" fill="#2a78d6">Byzantium 60.8</text>
    <text x="706" y="177" fill="#0e7a54">Ottomans 59.7</text>
  </g>
</svg>

(Direct labels give each series' r16 mean; Hungary's high *average* is its
consistency — its win rate stays in band because averages, not wins, are
plotted. Mean battles/game: 11.5.)

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
| fresh-seed 3,000g, SEED=24681357 (84) | 18.9 | 13.9 | 13.0 | 27.8 | 26.5 |
| **verify 5,000g, SEED=987654321 (84)** | **19.6** | **14.2** | **14.6** | **26.8** | **24.9** |

---

## 4. Adversarial audit

Six exploit hunts were run against the final config (all JSONs regenerated at
the shipped CONFIG; pre-canon results were discarded as misleading).

### 4.1 Constantinople beeline (`adversarial_cple_beeline.json` — 1,000 games/arm, seed 311002)

A dedicated agent sells everything to besiege Constantinople from round 1.

| Arm | SD by beeliner | SD completes ≤ r8 |
|---|---|---|
| solo_ottoman | **22.6%** | 15.0% |
| solo_genoa | 18.8% | 11.4% |
| solo_venice | 6.5% | 1.3% |
| duo gang-up | 23.1% | 15.4% |
| guard_ottoman (Byz plays defensive guard) | 23.8% | 16.6% |
| guard_genoa | 17.5% | 10.9% |
| **solo/guard ottoman, Treason card removed** | **0.0%** | **0.0%** |

Fixed during the round (all canon-compliance corrections, then re-verified):
(1) **§8.2.3 RAW blockade contest** — 2 siege-camp galleys could previously
"blockade" Constantinople over its own harbor galley without the naval
battle canon requires (progression: 78.1% SD filed → 85.6% after an
unrelated fix exposed it → **38.2%** with the RAW contest); (2) **harbor
reinforcement** (`harborOpen` recruiting/ferrying); (3) **besieged-garrison
insolvency exemption**; (4) **omen unit-loss floor 3** at walled capitals —
final 22.6%. Every remaining SD win in the land-power arms holds
**Treason at the Gate** (`sdWithTreasonHeld == SD count`; noTreason
counterfactuals 0.0%, were 74.9%/28.9% for non-card paths pre-fix — i.e.
**beeline non-card paths 74.9% → 0.0%**). The venice arm's non-card SD wins
are the legitimate naval-blockade path working as designed. Residual breach
of the ≤20%/≤10% bars is 100% the ratified rare — **§5 item 1**, not a
numbers hole. Constantinople's authored 4-unit start garrison did not need
inflating after the fixes.

### 4.2 Trade-griefing / economy exploit (`adversarial_economy_exploit.json` — 1,000 games/arm, paired seeds 311005+)

Pre-fix, blockade *cancelled* route income: a single 5-gold picket galley
deleted a trader faction (trader-Genoa **0.1%** win under grief vs 49.8%
control). Fix: canon §5.2 halving (`BLOCKADE_INCOME_MULT 0.5`; only severed
routes yield 0). Post-fix: trader-Genoa under a dedicated Ottoman griefer
**36.6%** vs 51.3% control; with the blockade mechanism switched off
entirely, 37.1% — the mechanism itself now costs ~0.5pp, the rest is the war
pokes (a residual design wart, §5 item 5). A **passive-picket** griefer wins
0.0% (pure self-sacrifice; was self-profitable +25pt); a griefer that
commits to a real war (fight-back arm) beats Genoa 57.0/7.0 — that is a war,
not an exploit. Levy-flood: never beats the flooding faction's best honest
policy (max delta +0.1pp). Omen income swings measured 0.20–0.34× mean round
income (§2.15). **EXPLOIT DEAD.**

### 4.3 Mercenary rush (`adversarial_merc_rush.json` — 500 games/faction/variant, paired seeds 311001+)

Hire-mercs-for-one-battle-then-stiff-them ("cycle") vs honest upkeep: no
exploit thresholds crossed (no faction >40%, nobody beats field average
2×; overall cycle 5.7% vs honest 5.3%). Paired same-seed cycle-vs-honest
z = **1.81** (n.s., but the gradient exists) — documented wart, §5 item 5b.

### 4.4 Runaway leader (`adversarial_runaway_leader.json` — 2,000 games/arm, seed 311004)

Canon §13.4 turn order modeled (fix round) and agent leader-pressure
converted from an ordering-only bonus (measured inert: 0.2–0.3% decision
changes) to a feasibility relaxation (odds gates ×0.85 vs the leader).
Engagement is now real (142 changed decisions/arm vs 0 OFF), yet the
round-8 unique leader still wins **72.8%** (line 70%; STRONG probe 72.1%;
2-keys-at-r6 wins 19.2% vs the 75% line, so keys are not the driver;
objective reveals flip 0.0% of cap games). Residual is passive-prestige lead
stickiness — same design root as 4.5; **§5 item 2/8**.

### 4.5 Turtle dominance (`adversarial_turtle_dominance.json` — seed 311003)

All-five-turtle tables: 46.8–48.5% of games end with winner margin <2
(56.2% of cap-decided games) — the §13.3 tiebreak cannot separate margin-1
finishes. Monoculture protocols: monopoly-max turtler wins **66.2%** as
Venice / **61.7%** as Genoa (ledgers: routes+monopolies 31–34 prestige,
great works 13–19); shipping-trader Genoa seat 57–64%. The hunter's
fix-check proved every owned scalar cut (monopoly prestige, route incomes)
breaks T1/T3 — the knobs are canon-locked §13.1 values ⇒ design change
needed (**§5 item 2**), not tuning.

### 4.6 Faction floor (`adversarial_faction_floor.json` — 80 grid configs × 300 + 1,000-game verification cells, seeds 111006/311006)

30 flags, all cell-level (no aggregate target breached): ceiling
genoa+trader 63.7% vs a mixed field (60.3% at the 1,000-game verification;
57.9% vs all-rushers) and hungary+opportunist 50.5–60.9%; floors are the
dead faction×policy corners (ottoman-turtler 0.0%, venice/genoa
rusher+opportunist 0–1.3%) — an archetype-agent limitation (naval factions
have land-shaped rusher/opportunist scripts), filed as harness follow-up
(faction-aware agents), not a rules change. Eliminations 0 everywhere; no
cell dies by round 8.

---

## 5. NEEDS-RULES-CHANGE register

Findings the adversarial suite proved **un-fixable with owned CONFIG/map
numbers** (reproduced faithfully from RULES_MODEL.md's register, reordered by
priority; item 3 is this report's own divergence flag). Each needs a
canon/design decision and a re-verify.

**1. Treason at the Gate vs garrisoned capitals** (cple-beeline, HIGH
residual). With every other capture path closed (noTreason arms 0.0% SD),
the ratified rare alone still buys Constantinople in a round-1 siege:
SD 18.8–23.8% for one dedicated beeliner and ≤r8 completions 11–17% vs the
≤20%/≤10% bars — 100% of remaining SD wins hold the card
(results/adversarial_cple_beeline.json). Fix must touch card TEXT (the
magnitudes are ratified): **suggested gates** — require garrison ≤ 4 (the
gatekeeper can only open gates the garrison can't watch), and/or price it
4g + 2g per garrison unit, and/or count its "2+ siege rounds" only from game
round 6. Re-run the beeline suite after errata.

**2. Flat passive monopoly prestige** (turtle-dominance + faction-floor,
HIGH). +2/round per owned-both-ends route (canon §13.1) with zero risk gives
monopolyMax Venice **66.2%** / Genoa **61.7%** and shipping-trader Genoa
60–64% in-seat under monoculture protocols; every owned scalar cut breaks
T1/T3 (hunter fix-check; threshold 84 did not clear the genoa+trader
verification cell, 60.3%). Suggested errata: **diminishing returns** (+2
first monopoly, +1 each further) and/or an escort/at-risk requirement, plus
a competing gold→prestige sink; then re-tune `VICTORY_THRESHOLD`
(re-derive from the ~15.9× accrual multiple, §2.13).

**3. Great Bombard omen round: sim r15 vs canon Era III r11** (this
report's divergence flag; RULES_MODEL Omen note). Canon §12 opens Era III —
and EVENT_CARDS #34 — at round 11; a free Ottoman Bombard at r11 makes
5-player games a sudden-death coin flip: measured SD share **23.7% (r11)
→ 21.7 (r12) → 18.6 (r13) → 13.4 (r14) → 8.5–8.7% (r15)** vs the 1–15%
target band (TUNING_LOG canon-retune-1 it1–4, it13; every SD win in
instrumented runs held the Bombard). **If r11 is insisted on, SD rises to
~24%.** Alternatives if the design session wants an earlier gun (all
UNTESTED — each needs a fullgame re-run): (a) reveal at r11 as "forging
begins" with delivery 3–4 rounds later (equivalent to r14–15, reads
historically as Orban's casting); (b) r11 + `SUDDEN_DEATH_HOLD_ROUNDS` 2→3;
(c) r11 with no free Ottoman grant (auction only, steep price). The shipped
r15 keeps the 1453 anchor: omen r15 → City falls r15–16.

**4. Secret objectives are dead weight** (runaway-leader, LOW). 0.3%
completion, 0 end-reveal flips with ONE 3-province objective modeled; canon
grants THREE per faction (+12 hidden swing) — re-run the kingmaker/flip
measurement when 3-objective play is wired before quoting the no-flip result
at canon scale (§6). The +4-at-game-end scoring itself is correct canon and
shipped (§2.13).

**5. Betrayal/aggression costs unmodeled — two residual warts.**
(a) **Free perpetual war pokes** (economy-exploit): a 2-unit self-lifting
siege keeps a war (and route halving) alive indefinitely at ~0 cost because
canon §11's aggression/betrayal prestige penalties and tribute peace are
unmodeled; the §5.2 halving fix caps the damage (blockade attribution
~0.5pp) but pokes remain free harassment. (b) **Unpaid-merc desertion is
free** (merc-rush): hire-for-one-battle-then-stiff beats honest upkeep by
+0.6pp inside a 4.9%-win line (z = 1.81 — not significant, but the gradient
exists). Canon §13.1 reserves betrayal penalties; a −1 prestige on
unfed-merc desertion (or deserters-turn-brigand) would close (b); modeling
§11 war/peace costs closes (a). Pure-CONFIG mitigations punish honest play.

**6. Victory-check ordering**: sudden death currently outranks a
same-Cleanup threshold win (canon §13.3 "wins immediately, regardless of
prestige" — confirm intent for the engine's Cleanup resolver).

**7. All-turtle near-tie endings** (faction-floor/turtle): a 5-turtler table
ends 45–56% of games with winner margin <2 at the cap; the canon §13.3
tiebreak (key cities → gold, now modeled) cannot separate margin-1 finishes.
Follows from the same flat passive accrual as item 2.

**8. Runaway-leader brakes** (MEDIUM residual): §13.4 turn order is modeled
and agent leader-pressure changes real decisions, yet the r8 unique leader
wins 72.8% (line 70%) because leads are passive-prestige-driven — same root
as item 2. Canon's remaining catch-up levers (diplomacy gang-ups, betrayal
costs, late-era crisis weighting) are unmodeled; re-measure after item 2's
errata.

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
| 4 | **Royal marriage** (+2/round to both, §13.1) | Worth ~+24–32 prestige over a game to a stable pair — comparable to a monopoly. Directly inflates winner accrual: **re-sweep `VICTORY_THRESHOLD` when diplomacy lands** (start from 15.9× the new measured accrual). |
| 5 | **Diplomacy layer** (§11): alliances, NAPs, tribute peace, betrayal −2…−4 | Wars in-sim are implicit and free to start/keep warm (→ §5 item 5a). Betrayal costs and negotiated peace mostly *reduce* grief viability; expect trader floors to rise slightly. |
| 6 | **Fleet battles** (§7.6, §5.3 escort/sever duels) | Sim computes sea-zone presence from ported galleys; no pure fleet battles, so blockades vs fleet-holding ports are under-produced and 2 tactic cards (Pilot ×3, Greek Fire) are dead. The siege module measures the fully-blockaded case directly, so T5 targets stand; naval-identity factions (Venice) likely *gain* when real fleet combat lands. |
| 7 | **Movement/info tactic cards** (Forced March, Ears in the Bazaar, Feigned Retreat, Chain Across the Horn, A Death in the Palace) | 7 designs / 15 of 47 cards are dead draws in-sim → measured card-layer impact (§2.9) is an underestimate, and hand pressure (limit 4) is softer than it will be. Re-measure card impact in engine playtests. |
| 8 | **Secret objectives at canon scale**: canon = **3 per faction**; sim modeled **1** ("hold 3 seeded provinces at game end") | +12 hidden end-game swing vs the sim's +4. The measured "0 kingmaker flips" result (§4.4) is **not** valid at canon scale — re-measure with 3-objective play before relying on it (§5 item 4). |
| 9 | **Byzantine auto-repel power** (FACTIONS: first two siege rounds of Constantinople take no bombardment damage) | Shifts T5d capture from ~2–4 to ~4–6 siege rounds; with the r15 omen the City then falls r16 or not at all — would cut SD below the current 8.0–8.2% and strengthen Byzantium. T5 targets were calibrated without it per the coordinator's spec; re-run the siege module when implemented. |
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
npx tsx src/adversarial/run_cple_beeline.ts      # seed 311002
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

**Determinism note.** The committed JSONs have been reproduced
bit-identically: while preparing this report the committed 3,000-game
`fullgame.json` was replayed through the identical seeding path —
per-faction win tallies matched exactly (566/418/389/833/794), all 240
sudden-death completions landed at round 16, and the §2.13 accrual
statistics (5.269/round, winner mean 81.1) were measured over that replay.
`sim:report` renders headline numbers from the committed JSONs without
re-simulating.

**Verification-run provenance.** An earlier 5,000-game log at the same seed
(run between retune round 2 and the adversarial fix round, i.e. at
threshold 82 without the fix-round changes: byz 21.8 / ott 13.3 / ven 14.6 /
gen 23.5 / hun 26.7; threshold-decided 52.1%, SD 8.6%) verified the
*retune-2* config, not the shipped one. The §1 "5,000-game verify" column
is the re-execution of `GAMES=5000 SEED=987654321` at the shipped HEAD
config (byz 19.6 / ott 14.2 / ven 14.6 / gen 26.8 / hun 24.9; all six
targets green; all 408 sudden deaths complete at round 16). Both runs are
deterministic and reproducible from their seeds; both are in band — the
config is seed-robust across three independent seed sets (14530000,
24681357, 987654321).
