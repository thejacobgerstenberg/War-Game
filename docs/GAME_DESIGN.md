# IMPERIUM: Twilight of Empires — Game Design (Master Rulebook)

> The master systems document. Numbers here are authoritative and meant to be
> implemented verbatim by the rules engine (`server/src/engine/`). Where full
> data lives elsewhere it is deferred to a sibling doc:
> [`MAP.md`](./MAP.md), [`FACTIONS.md`](./FACTIONS.md),
> [`EVENT_CARDS.md`](./EVENT_CARDS.md). UI treatment lives in
> [`UI_DESIGN.md`](./UI_DESIGN.md); the technical plan in
> [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. Premise & Setting

It is the twilight of the Roman world. The year is 1400. The Queen of Cities,
Constantinople, is a shrunken jewel ringed by the rising crescent of the Ottoman
Sultanate. The merchant republics of **Venice** and **Genoa** fight a cold war
across the sea lanes for the spice, silk and grain of the Levant. **Hungary**
holds the Danube as the shield of Latin Christendom. And the **Byzantine**
emperor schemes to buy, wed, and pray his way to one more century.

**IMPERIUM: Twilight of Empires** is a turn-based grand-strategy board game for
**2–5 players**. Each player is a great power with a capital, an asymmetric
economy, a war machine, and three secret ambitions. The clock runs from
**1400 to 1453** — sixteen years, sixteen rounds. When the last round ends the
walls of Constantinople either still stand, or they do not.

The game blends three classic loops:

* **A Catan-like economy** — provinces are resource tiles you tax each year.
* **A Risk-like war** — armies and fleets clash with modified dice.
* **A Diplomacy-like table** — alliances, marriages, tribute, and betrayal.

Target session length: **60–120 minutes** (≈ 4–8 minutes per player-round).

---

## 2. Players & Factions

Two to five players, each a distinct great power. Powers are **asymmetric**:
they start with different provinces, treasuries, unit rosters, bonuses, and a
private deck of **three secret objectives**. Only a summary appears here — full
starting positions, faction bonuses, unique units and objective cards live in
[`FACTIONS.md`](./FACTIONS.md).

| Faction | Capital | Archetype | Signature strength |
|---|---|---|---|
| **Byzantium** | Constantinople | Besieged empire, faith & diplomacy | Great Walls, Hagia Sophia, imperial legitimacy |
| **Ottomans** | Edirne (Adrianople) | Expansionist land power | Cheap levies, elite siege bombards, momentum |
| **Venice** | Venice | Thalassocracy, trade & gold | Best merchant fleets, trade-ratio ports |
| **Genoa** | Genoa | Mercantile rival, mercenaries | Colonies, cheap mercenaries, banking |
| **Hungary** | Buda | Christian bulwark, heavy cavalry | Strong knights, defensive terrain, crusades |

Faction identity is enforced by the [`Faction`](../shared/src/types/gameState.ts)
enum in shared types (`BYZANTIUM`, `OTTOMAN`, `VENICE`, `GENOA`, `HUNGARY`).

---

## 3. The Map & Provinces

The strategic map is the Eastern Mediterranean, Balkans, Anatolia and the Italian
maritime republics: roughly **48–56 land provinces** plus **~12 sea zones**. The
complete province/sea-zone list, adjacency graph and starting ownership is in
[`MAP.md`](./MAP.md); this section defines the **rules** provinces obey.

Each province is a tile with a **terrain type** and a per-turn **resource yield**
(Catan-style), an owner (or neutral), and a coastal flag. Sea zones connect
coastal provinces and carry fleets and trade.

### 3.1 Terrain & base yields

Terrain is the [`TerrainType`](../shared/src/types/gameState.ts) enum. Base yield
is the province's default; named/key cities and buildings modify it (see
`MAP.md`). All yields are a [`ResourceBundle`](../shared/src/types/gameState.ts)
`{gold, grain, timber, stone, faith}`.

| Terrain | Base yield | Move cost | Combat note |
|---|---|---|---|
| `PLAINS` | grain 2, gold 1 | 1 | open; cavalry bonus applies |
| `HILLS` | stone 1, gold 1 | 1 | defender **+1** |
| `MOUNTAINS` | stone 2 | 2 | defender **+1**, no cavalry bonus |
| `FOREST` | timber 2, grain 1 | 1 | defender **+1**, negates attacker cavalry bonus |
| `COAST` | grain 1, gold 1 | 1 | amphibious assault: attacker **−1**; enables ports/trade |
| `CITY` | gold 3, faith 1 | 1 | may hold walls & great works; garrison bonus |

> **Note on resource names.** The secondary resource "stone/marble" is stored in
> the single `stone` field of `ResourceBundle`; the flavor term *marble* is used
> for great-work costs but is mechanically the same resource. "Faith" is a
> non-tradeable prestige/religion resource (see §4).

### 3.2 Key cities

A handful of named cities (Constantinople, Thessalonica, Smyrna, Ragusa,
Famagusta, Belgrade, …) carry extra yields, prestige value, and pre-built walls.
They are the prestige anchors of the map. Full list and stats: [`MAP.md`](./MAP.md).

---

## 4. Resources & Economy

Five resources drive everything, modelled as `ResourceBundle`:

| Resource | Tier | Primary use |
|---|---|---|
| **Gold** | Core | Recruit units, build, bribe, buy in markets, pay tribute |
| **Grain** | Core | Sustain armies (upkeep); starvation if short |
| **Timber** | Secondary | Ships, shipyards, granaries, siege engines |
| **Stone / marble** | Secondary | Walls, universities, great works |
| **Faith** | Secondary | Churches, great works, some cards; feeds prestige |

### 4.1 Income

During the **Income & upkeep** phase each round, every player collects the summed
yields of all owned provinces into their treasury. This is the engine function
[`computeIncome(state, playerId)`](../shared/src/types/gameState.ts) →
`ResourceBundle`.

```
income(player) = Σ province.yields  for province where province.ownerId == player.id
                 + Σ building.yieldBonus
                 + Σ tradeRouteIncome        (see §5)
```

### 4.2 Taxation

Players may set a **tax posture** on their realm (a free choice each Income phase):

| Posture | Gold modifier | Risk |
|---|---|---|
| Lenient | ×0.75 gold | +1 unrest resistance |
| Normal | ×1.0 gold | — |
| Heavy | ×1.5 gold | Unrest: 1-in-6 province revolt check per over-taxed year |

A revolting province flips to **neutral** and must be re-taken.

### 4.3 Markets & the trade ratio

Any player may convert resources to gold (or between resources) at a **market
ratio**. The ratio improves with infrastructure:

| Where | Ratio (give : get) |
|---|---|
| No market (base) | **3 : 1** |
| Market building | **2 : 1** |
| Trade-ratio port (Venice/Genoa bonus, or Grand Bazaar) | **2 : 1**, and **1 : 1** for gold↔the port's specialty |

Conversion is a **Trade action** (§10.3).

### 4.4 Upkeep & starvation

Every mobilized unit eats **grain** each Income phase (see roster §6.1). Upkeep is
paid automatically from the treasury after income is collected:

```
grainDue = Σ unit.upkeepGrain  over all of a player's armies & fleets
```

If `treasury.grain >= grainDue`: pay it, done.
If short by `d` grain: resolve **starvation**:

1. Convert any stored grain first.
2. For each `1` grain still owed, one unit **deserts** (is removed), lowest-value
   first (LEVY → ARCHER → INFANTRY → CAVALRY → SIEGE), each unit removed offsets
   its own upkeep.
3. **Mercenary** units (see §6.2) desert *first* and at double rate if unpaid.

Starvation makes over-extension self-correcting and gives grain-rich terrain
strategic weight.

---

## 5. Trade & Sea Travel

Sea zones ([`SeaZone`](../shared/src/types/gameState.ts)) are the arteries of
wealth. Fleets travel them; **trade routes** run gold along them.

### 5.1 Merchant fleets & routes

A **trade route** links two **owned ports** (coastal `CITY`/`COAST` provinces)
through a chain of sea zones ("hops"). A player **establishes** a route with a
Trade action by assigning a fleet (a `GALLEY`, acting as merchantman) to it; the
route then pays gold every Income phase while it remains **unbroken**.

### 5.2 Gold-generation formula

```
routeIncome = BASE_ROUTE_GOLD            // = 2
            + portTier(A) + portTier(B)  // each port’s tier 0–3, from MAP.md
            + controlledSeaHops          // +1 per sea zone on the route you or an ally control

then:
  if any hop is BLOCKADED by an enemy war fleet:  routeIncome ×= 0.5  (round down)
  if any hop is SEVERED (enemy fleet + no friendly escort):  routeIncome = 0
  if faction is VENICE or GENOA:  routeIncome ×= 1.5  (merchant bonus, round down)
```

**Worked example.** Venice runs Venice (tier 3) ↔ Famagusta (tier 2) across 3
controlled sea hops, unblockaded:
`(2 + 3 + 2 + 3) × 1.5 = 10 × 1.5 = 15 gold/round`. If Genoa blockades one hop
with a warship: `10 × 0.5 = 5`, then `×1.5 = 7 gold`.

### 5.3 Blockade & piracy

* **Blockade** — an enemy war fleet (`GALLEY`/`WARSHIP`) occupying a sea zone on
  your route halves (or with escort superiority, severs) that route until
  cleared by a naval battle (§7.6).
* **Piracy** — some Omen cards and neutral corsairs raid **unescorted** merchant
  fleets: the fleet loses that round's route income and, on a failed 1d6 ≤ 2
  check, the merchant galley is sunk. A war fleet in the same zone escorts and
  prevents this.
* **Amphibious transport** — a `GALLEY` may carry **one army stack** across sea
  zones (a naval Move action), landing it in a friendly or contested coastal
  province (amphibious assault, attacker −1, §7.4).

---

## 6. Military

Units are the [`UnitType`](../shared/src/types/gameState.ts) enum. Land units
form [`Army`](../shared/src/types/gameState.ts) stacks; naval units form
[`Fleet`](../shared/src/types/gameState.ts) stacks. Each stack stores counts as
`units: Record<UnitType, number>`.

### 6.1 Unit roster

Combat values (**CV**) feed the dice system (§7): a unit **hits** on a d6 roll
`≥ (7 − CV − modifiers)`, clamped to the `2..6` range. Higher CV = hits more
often. Upkeep is grain per round.

| Unit (`UnitType`) | Role | Raise cost | Upkeep (grain) | CV atk | CV def | Move | Special |
|---|---|---|---|---|---|---|---|
| `LEVY` | Peasant militia | gold 2, grain 1 | 1 | 1 | 1 | 1 | Cheap; disbands cheaply; no map upkeep in home province |
| `INFANTRY` | Professional men-at-arms | gold 4, grain 1 | 1 | 2 | 3 | 1 | Backbone; best defender-to-cost |
| `ARCHER` | Missile troops | gold 3, grain 1 | 1 | 2 | 1 | 1 | **Ranged**: fires in pre-round (§7.2) |
| `CAVALRY` | Knights / sipahi | gold 6, grain 2 | 2 | 3 | 2 | 2 | **Charge** +1 atk on `PLAINS`; pursuit on rout |
| `SIEGE` | Bombards / trebuchets | gold 8, stone 2, timber 2 | 1 | 0* | 1 | 1 | Weak in field; **+3 vs walls**; bombards in sieges |
| `GALLEY` | War / merchant galley | gold 5, timber 2 | 1 | 2 | 2 | 2 | Naval; can **transport** 1 army; acts as merchantman |
| `WARSHIP` | Great galley / carrack | gold 8, timber 3 | 1 | 3 | 3 | 2 | Naval; blockade/escort superiority |

`*` `SIEGE` contributes no offensive dice in a **field** battle but adds its **+3
vs walls** in sieges.

### 6.2 Recruitment

**Recruit** is an action (§10.1). You may raise units in any owned province that
is a **capital**, a **`CITY`**, or has a recruitment building (Barracks) —
naval units require a **Shipyard** province. Pay the full cost from the treasury.

* **Mercenaries** — any land unit may instead be **hired as a mercenary**: pay
  **×1.5 gold, 0 grain** to raise, available immediately even outside recruitment
  buildings, but they carry **×2 grain upkeep** and **desert first** if unpaid
  (§4.4). Genoa hires mercenaries at the normal ×1.0 gold rate.

### 6.3 The Mercenary Bid Market

Beyond ordinary hiring, each round a shared **mercenary market row** offers
**2–3 named free companies** — famous, pre-built stacks of veterans available to
the highest bidder. This is a deliberate **gold sink** and a point of direct
player interaction.

**Procedure** (resolved during the Omen/Income window, before action phases):

1. The engine reveals 2–3 **companies** face-up in the market row (drawn from the
   company deck, seeded RNG). Each company lists its stack (e.g., *5 INFANTRY +
   3 ARCHER*), a **minimum bid**, and a flavour name.
2. **Bidding proceeds in turn order.** On your bid step you may **raise** the
   current high bid (in whole gold, at least +1) or **pass**. Bidding continues
   round-robin among non-passed players until only one bidder remains.
3. The **winner immediately fields** the company in their capital (or any owned
   `CITY`), paying the winning bid in gold. The company enters as **mercenary
   units** (×2 grain upkeep, desert-first — §4.4, §6.2).
4. **Unsold companies** (all players passed at or above the minimum) **leave**;
   an unsold company has a **1-in-3 chance (1d6 ≤ 2)** to be **hired by a random
   NPC minor state** (§11.5) instead, strengthening that minor's garrison —
   pass at your peril.

| Company (examples) | Typical stack | Min bid |
|---|---|---|
| **Catalan Company** | 5 INFANTRY, 3 ARCHER | 12 gold |
| **Company of St. George** | 4 INFANTRY, 3 CAVALRY | 14 gold |
| **The Almogavars** | 6 LEVY, 2 CAVALRY, 1 SIEGE | 10 gold |
| **Varangian Remnant** | 4 INFANTRY, 2 CAVALRY (elite: +1 CV def) | 16 gold |

Full company deck and stats: [`EVENT_CARDS.md`](./EVENT_CARDS.md) /
[`FACTIONS.md`](./FACTIONS.md).

### 6.4 Movement & stacking

* A unit moves up to its **Move** value in province move-cost (§3.1) along the
  adjacency graph ([`areAdjacent`](../shared/src/types/gameState.ts)) as a **Move
  action** (one action moves one army or fleet).
* Entering a province held by a non-ally with units → **battle is declared**,
  resolved in the Battle phase (§10, §7).
* Entering an **empty** enemy/neutral province → **occupation** (ownership flips
  at cleanup unless contested).
* **Stacking limit** — a province may hold up to **8 land units** per player
  (12 in a `CITY`/capital); a sea zone up to **6 naval units** per player.
  Excess units cannot enter.

---

## 7. Combat System

Combat is **Risk-esque modified dice**, resolved in **rounds**. A battle occurs
when opposing stacks share a province (land) or sea zone (naval).

### 7.1 The hit rule

Each participating unit rolls **1d6** per combat round. It scores a **hit** if:

```
roll  ≥  hitThreshold
hitThreshold = clamp( 7 − CV − modifiers , 2 , 6 )
```

So CV 1 hits on 6 (1/6), CV 2 on 5+ (2/6), CV 3 on 4+ (3/6). Each **modifier**
(terrain, walls, tactic cards) lowers the threshold by its value (easier to hit).
Every **hit removes one enemy unit**; the losing owner removes **lowest-value
first** by default (configurable in the assault action).

### 7.2 Round sequence

1. **Ranged step** — only `ARCHER` (and, in sieges, `SIEGE`) roll. Their hits
   remove enemy units **before melee** (missiles strike first). Defenders behind
   walls ignore the first breach's worth of ranged (§8).
2. **Melee step** — all remaining units on **both** sides roll simultaneously.
3. **Apply casualties** — both sides remove units equal to hits taken.
4. **Morale / rout check** (§7.5).
5. If both sides remain and neither retreats, **repeat** from step 1.

### 7.3 Modifiers summary

| Source | Modifier |
|---|---|
| Defender in `HILLS` / `MOUNTAINS` / `FOREST` | defender **+1** |
| Attacker amphibious (from sea) | attacker **−1** |
| Cavalry charge on `PLAINS` (attacker) | attacker cavalry **+1** |
| Forest / mountains vs cavalry | cavalry bonus **negated** |
| City walls (defender) | defender **+2** (Lv1) / **+3** (Lv2) / **+4** (Theodosian), while Wall HP > 0 |
| Escalade (assaulting un-breached walls) | attacker **−1** |
| Tactic card | as printed (typ. **+1** to all rolls, or reroll misses) |
| Outnumbering 2:1 in a round | larger side **+1** |

### 7.4 Worked example (field battle)

**Ottoman attacker** enters a Byzantine **HILLS** province:

* Attacker: 4 `INFANTRY` (CV atk 2), 2 `ARCHER` (CV atk 2, ranged), 2 `CAVALRY`
  (CV atk 3; no charge — hills negate it), 1 `SIEGE` (no field dice).
* Defender: 3 `INFANTRY` (CV def 3), 2 `ARCHER` (CV def 1, ranged), 3 `LEVY`
  (CV def 1). Terrain gives defender **+1**.

**Ranged step.**
Attacker archers: hit on `7−2−0 = 5+`. 2 dice → roll {5,2} → **1 hit**.
Defender archers: hit on `7−1−1(terrain) = 5+`. 2 dice → roll {6,4} → **1 hit**.
Casualties: defender loses 1 `LEVY`; attacker loses 1 `ARCHER`.

**Melee step.**
Attacker rolls 4 INF (5+), 2 CAV (4+), 1 ARCHER (5+) — SIEGE idle.
→ INF {6,5,3,4}=2 hits, CAV {4,2}=1 hit, ARCHER {5}=1 hit → **4 hits**.
Defender rolls 3 INF (`7−3−1=3+`), 2 LEVY (`7−1−1=5+`), 1 ARCHER (5+).
→ INF {5,2,4}=2 hits, LEVY {6,1}=1 hit, ARCHER {3}=0 → **3 hits**.
Casualties: defender removes 4 lowest-value (2 LEVY, then 2 ARCHER-then-INF per
rule) → down to 3 INF; attacker removes 3 lowest (1 ARCHER, 2 INFANTRY).

**Morale check** (§7.5): defender lost 5 of 8 (>50%) → **rout check**.

### 7.5 Retreat & rout

* **Voluntary retreat** — between rounds the **attacker** may retreat to the
  province they came from (if still friendly/empty); a **defender** may retreat to
  an adjacent friendly/empty province, ceding the contested tile.
* **Rout check** — a side that lost **≥ 50% of its starting stack this battle**
  rolls 1d6; it **routs** on `roll ≤ 3`. Routing units retreat to an adjacent
  friendly/empty province; if none exists they **surrender** (removed).
* **Pursuit** — if a side routs and the enemy has `CAVALRY`, each cavalry inflicts
  1 automatic pursuit hit on the fleeing stack.

### 7.6 Naval combat

Identical hit rules using naval CVs in a **sea zone**. There is no terrain; there
are no walls. The winner controls the zone (enabling blockade §5.3) and may pursue
into an adjacent zone. `GALLEY` transports carrying an army are destroyed with
their cargo if the fleet is wiped out.

---

## 8. Sieges

Taking a **walled city** is a **multi-turn** operation, not a single battle.

### 8.1 Wall HP

| Wall level | Wall HP | Defender bonus |
|---|---|---|
| Palisade / none | 0 | — |
| Walls Lv1 | 6 | +2 |
| Walls Lv2 | 10 | +3 |
| **Theodosian Walls** (Constantinople great work) | 16 | +4 |

### 8.2 Siege lifecycle

1. **Circumvallation** — an attacker declares a **siege** by moving an army into
   (or adjacent to) the city and choosing *Besiege*. The besieging army is
   **locked**: it cannot move or take other Move actions while the siege holds.
   A player may not besiege and field-fight elsewhere with the same stack.
2. **Bombardment** (each round the siege persists) — every `SIEGE` unit rolls 1d6
   of wall damage: `1–2 → 1 HP`, `3–4 → 2 HP`, `5–6 → 3 HP`. Wall HP cannot go
   below 0; at **0 HP the wall is breached**.
3. **Starvation of the garrison** — a besieged city holds `grainStores` rounds
   (default 3, +2 with a **Granary**). Each round of siege depletes 1 store; once
   stores hit 0, the garrison loses **1 unit per round** to hunger, weakest first.
4. **Assault** — the attacker may **assault** at any time (a Move/Attack action):
   * If Wall HP > 0 → defender keeps the full wall bonus **and** attacker suffers
     **escalade −1**.
   * If Wall HP = 0 (breach) → normal field-battle odds, no wall bonus.
   * Combat then resolves as §7. Winning the assault **captures the city**.
5. **Relief** — a friendly/allied army may **march to relieve**: it attacks the
   besiegers in a field battle. If the besiegers lose or retreat, the **siege is
   broken** and walls begin to slowly repair (+1 HP/round out of siege, up to max).

### 8.3 Constantinople

Constantinople begins with **Theodosian Walls (16 HP, +4)**. Its capture triggers
the **sudden-death** victory check (§11.3). Byzantium may spend a great work to
keep them in repair; a lapsed empire lets them crumble to Lv2.

---

## 9. Buildings & Great Works

Built with the **Build action** (§10.4) in an owned province. Ordinary buildings
finish in one action; **Great Works** are large, prestige-bearing projects that
take **multiple rounds** to complete (pay cost up front, then invest 1 Build
action per round for the listed duration; abandoning forfeits the investment).

### 9.1 Buildings

| Building | Cost | Effect |
|---|---|---|
| **Barracks** | gold 4, timber 2 | Enables land recruitment in this province |
| **Market** | gold 4, stone 2 | Trade ratio 2:1; **+1 gold/round** here |
| **Granary** | gold 4, timber 3 | +2 grain storage; **+2 siege hold-out rounds**; softens starvation |
| **Shipyard** | gold 6, timber 4 | Build `GALLEY`/`WARSHIP` here; +1 fleet cap |
| **Church / Mosque** | gold 5, stone 3, faith 1 | **+1 faith/round**; supports morale |
| **Walls Lv1** | gold 5, stone 4 | Wall HP 6, defender +2 |
| **Walls Lv2** (upgrade) | gold 8, stone 6 | Wall HP 10, defender +3 |
| **University** | gold 10, stone 4, faith 2 | **+1 tactic/omen card draw per round**; minor prestige |

### 9.2 Great Works (prestige)

| Great Work | Cost | Rounds | Effect | Prestige |
|---|---|---|---|---|
| **Hagia Sophia Repair** | gold 20, stone 10, faith 8 | 3 | +2 faith/round; unlocks unique Byzantine cards | **+10** |
| **Theodosian Walls** (Grand Walls) | gold 15, stone 12 | 2 | Wall HP 16, defender +4 | **+6** |
| **Great University** | gold 18, stone 8, faith 4 | 3 | +2 card draw/round; tactic reroll aura | **+6** |
| **Grand Bazaar** | gold 16, timber 6, stone 6 | 2 | Best trade ratio; **+3 gold/route** from this port | **+5** |

Great Works are the primary **engine of prestige** for a builder-focused player
and the flavour spine of the setting (Byzantium repairing the Great Church,
Venice raising the Bazaar, Hungary walling the Danube).

---

## 10. Turn Structure

Each **round is one year** (1400 → 1453 across 16 rounds). A round runs five
phases. The engine's finer-grained [`GamePhase`](../shared/src/types/gameState.ts)
enum (`INCOME`, `RECRUITMENT`, `MOVEMENT`, `COMBAT`, `DIPLOMACY`, `END`) is the
state-machine realisation of these five conceptual phases.

| # | Conceptual phase | Engine `GamePhase`(s) | What happens |
|---|---|---|---|
| 1 | **Omen** | (front of `INCOME`) | Each active power draws & resolves an event card from the Omen deck (§12) |
| 2 | **Income & upkeep** | `INCOME` | Collect province yields (`computeIncome`), pay grain upkeep, resolve starvation (§4) |
| 3 | **Action phases** | `RECRUITMENT` → `MOVEMENT` → `DIPLOMACY` | In turn order, each player spends **~4 actions** (§10.0) |
| 4 | **Battle resolution** | `COMBAT` | Resolve all declared battles, assaults, sieges, naval clashes (§7, §8) |
| 5 | **Cleanup / reshuffle** | `END` | Flip contested ownership, score prestige, check victory, **re-sort turn order by prestige** |

### 10.0 The action economy (~4 actions)

Each player receives **4 actions** per round (a **University** or certain cards
can raise this to 5). Actions may be spent in any mix from the list below; a Move
that starts a battle **queues** it for the Battle phase.

### 10.1 Recruit
Raise units (or hire mercenaries) in a valid province; pay costs (§6.2). One
action recruits **one province's worth** of purchases (batch).

### 10.2 Move / Attack
Move one army or one fleet along adjacency within its Move budget (§6.4). Entering
a defended province declares a battle; choosing *Besiege* or *Assault* against a
walled city drives the siege lifecycle (§8).

### 10.3 Trade
Either **convert** resources at your market ratio (§4.3), or **establish/reassign**
a trade route with a fleet (§5). One action per conversion or route change.

### 10.4 Build
Construct a building, upgrade walls, or invest one round into a Great Work (§9).

### 10.5 Diplomacy
Propose, accept, or renounce a treaty; pay tribute; arrange a royal marriage
(§11). Proposing and accepting are each an action for the initiating player;
the responder answers for free.

### 10.6 Play card
Play a held political or tactic [`Card`](../shared/src/types/gameState.ts) from
your `hand`; pay its `cost` (a `Partial<ResourceBundle>`). Tactic cards are held
for battles; political cards resolve immediately.

### 10.7 Spy (light espionage)

Spend **1 action + 3 gold** to dispatch an agent and choose **one** mission.
Each mission first requires a **success roll** of **1d6 ≥ 3** (base 4-in-6). The
target may lengthen the odds: a rival with a **University** imposes **−1** (you
then need `≥ 4`), and Byzantium as the *target* resists with a **+1** (needs
`≥ 4`, or `≥ 5` vs a University rival) thanks to its intelligence tradition
(see [`FACTIONS.md`](./FACTIONS.md)).

| Mission | On success |
|---|---|
| **(a) Read the Omens** | Peek at the **top card of the Omen deck** (you learn it; you cannot change it) |
| **(b) Uncover an agenda** | Secretly **view one chosen rival's secret objective** card |
| **(c) Incite unrest** | A **target enemy province yields nothing** next Income phase (owner collects 0 from it) |

**On failure** the agent is **captured**: the mission fails, you **lose 1
prestige** (**2** for the more aggressive *incite unrest*), and the target is
told an enemy spy was caught. Espionage is cheap information and light disruption
— never a war-winner alone, but a wedge for the subtle player.

---

## 11. Diplomacy

Diplomacy is binding until broken, and **breaking it costs prestige** — betrayal
is powerful but never free.

| Instrument | Terms | Break penalty |
|---|---|---|
| **Alliance** | Cannot attack each other; shared map vision; may co-besiege & escort | **−4 prestige** to the betrayer + reputation flag |
| **Non-Aggression Pact (NAP)** | No attacks for a fixed term (default **3 rounds**) | **−2 prestige** if broken early |
| **Tribute** | One power pays the other a `ResourceBundle` each Income phase for peace/protection | Missed tribute = pact voids, no penalty to receiver |
| **Royal Marriage** | Strongest bond: alliance **+2 prestige/round** to both while it holds; creates a dynastic claim | **−4 prestige** + the jilted power gains a **casus belli** claim |

* **Reputation** — a power that has betrayed twice suffers a standing **−1** to all
  diplomacy proposals (others trust it less; some AI/objective cards react).
* **Casus belli** — a claim from a broken marriage or seized key city lets the
  claimant attack without the usual prestige cost and scores **+1** extra prestige
  for wins in that war.

### 11.5 NPC Minor States

Between the great powers sit **4–6 neutral minor states** — small realms with a
capital province and a standing garrison, but no player. They are prizes to be
**conquered** by the sword or **vassalized** by the purse. The exact set,
provinces and garrison sizes are fixed by [`MAP.md`](./MAP.md); the canonical
roster is: **Serbia**, **Wallachia**, **Karaman**, **Trebizond**, and the
**Knights of Rhodes** (a sixth, e.g. **Athens/Achaea**, is optional per player
count).

**Two paths to control:**

* **Conquest** — attack and defeat the minor's garrison like any defender
  (§7–§8; several minors sit in defensible terrain or behind Lv1 walls, so this
  is **costly** and may take a siege). On victory the minor's provinces flip to
  the conqueror as normal territory. Conquest scores the usual battle prestige but
  earns the minor's **enmity** — see revolts below.

* **Vassalize** (Diplomacy action) — instead of fighting, **buy loyalty**. Spend
  **1 Diplomacy action** and pay the minor an **up-front bribe** of `8 gold +
  4 × (garrison unit count)`; then roll **1d6 + your prestige-tier − garrison
  tier**. On **≥ 4** the minor becomes your **vassal**. A standing **NAP or
  royal-marriage-adjacent bribe** (paying an extra +4 gold) grants **+1** to the
  roll. On failure the bribe is **half-refunded** and you may retry next round.

**Vassal mechanics** (while a minor is your vassal):

| Benefit / duty | Effect |
|---|---|
| **Tribute income** | The vassal pays you **its province yields ×0.5** each Income phase (it keeps the rest) |
| **Levy call** | Once per **2 rounds** you may **call its levies**: gain a free stack of **2 LEVY (+1 per garrison tier)** raised in the vassal's capital |
| **Buffer** | The vassal's provinces are not yours to build on, but block enemy movement and screen your border |
| **Prestige** | Holding a vassal is worth **+1 prestige/round** (a peaceful key-city equivalent) |

**Vassal revolts** — vassalage is not permanent. A vassal **revolts** (reverts to
neutral, garrison restored) when triggered by: a **revolt Omen card**; your
**betrayal** of any treaty (perfidy is contagious); or if you **skip owed
protection** (fail to defend it when attacked in your presence). A revolting
vassal that was previously **conquered** (not bribed) revolts on a **1d6 ≤ 2**
check each time such a trigger fires — resentment runs deeper under the sword than
under the coin.

---

## 12. Event Cards (the Omen Deck)

At the start of each round every active power draws one card from the shared
**Omen deck** and resolves it. Cards come in three durations:

* **Immediate** — resolve now and discard (a good/bad harvest, a comet, a plague
  outbreak, a mercenary company for hire).
* **Persistent** — stays in play for a number of rounds (a schism halving faith, a
  trade boom, a hard winter doubling upkeep).
* **Grant** — adds a **tactic** or **political** card to the drawer's `hand` for
  later use (a papal indulgence, a clever stratagem).

The deck is weighted so early rounds skew opportunity and late rounds (1440s+)
skew crisis, dramatising the gathering storm around Constantinople. The full card
list, weights and text live in [`EVENT_CARDS.md`](./EVENT_CARDS.md); the engine
only needs the deck definition and a **seeded RNG** to draw deterministically
(see [`ARCHITECTURE.md`](./ARCHITECTURE.md) §Rules-engine).

---

## 13. Prestige & Victory

**Prestige points** are the sole victory currency. They are scored in the
**Cleanup** phase (§10, phase 5).

### 13.1 Prestige table

| Source | Prestige |
|---|---|
| Hold **your own capital** | **+1** / round (passive) |
| Hold an **enemy capital** | **+3** / round |
| Hold a named **key city** | **+1** each / round |
| **Trade monopoly** (control both ends of a major route, or most ports of a sea) | **+2** / round |
| Complete a **Great Work** | **+5 … +10** once (per §9.2) |
| Win a **decisive battle** (attacker or defender wipes/routs the enemy) | **+1** |
| Win a **war** (force peace, tribute, or vassalage) | **+3** |
| Complete a **secret objective** | **+4** each (3 per faction, see `FACTIONS.md`) |
| Royal-marriage bond, per round it holds | **+2** |
| **Betray** a treaty | **−2 … −4** (§11) |
| **Lose your capital** | **−3** |

### 13.2 Victory threshold

The game ends the instant a player reaches the **prestige threshold**, scaled to
player count (checked at cleanup):

| Players | Threshold |
|---|---|
| 2 | **25** |
| 3 | **30** |
| 4–5 | **35** |

### 13.3 The 1453 endgame & sudden death

* **Round 16 ("1453")** — if no one has hit the threshold, the game ends after
  round 16's cleanup and the **highest prestige wins** (tiebreak: most key cities,
  then most gold).
* **Sudden death — the Fall of Constantinople** — if any power **captures
  Constantinople and holds it through two full cleanup phases** (2 rounds), it
  wins **immediately**, regardless of prestige. This is the game's dramatic spine:
  every faction's clock is really counting down to whether the City stands.

### 13.4 Turn-order reshuffle

At cleanup, `turnOrder` is **re-sorted so the lowest-prestige power acts first**
next round (initiative to the underdog; tiebreak: fewer provinces). This is a
deliberate **catch-up** lever that keeps a runaway leader in reach and the table
tense to the final year.

---

## 14. Balance & Session-Length Notes

* **Length** — 16 rounds × ~4 actions × 2–5 players lands at **60–120 min**.
  Reduce to a **12-round** "short 1440–1453" scenario for a ~60-min game.
* **Catch-up levers** — (a) turn-order reshuffle (§13.4); (b) the Omen deck's
  late-game crisis weighting; (c) diplomacy ganging up on the leader is
  frictionless and *rewarded* (winning a war on the leader scores prestige).
* **Snowball guards** — heavy taxation risks revolt; over-recruiting starves;
  holding conquered key cities is passively rewarding but paints a target.
* **Asymmetry budget** — every faction bonus is worth roughly **+3 to +5
  effective prestige** over the game; secret objectives (`FACTIONS.md`) supply the
  personal, hidden agenda that makes each seat play differently.
* **Determinism** — all randomness (dice, Omen draws, revolt/starvation checks)
  runs through a **single seeded RNG on the authoritative server** so results are
  reproducible and cheat-proof (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)).

---

*See also:* [`MAP.md`](./MAP.md) · [`FACTIONS.md`](./FACTIONS.md) ·
[`EVENT_CARDS.md`](./EVENT_CARDS.md) · [`UI_DESIGN.md`](./UI_DESIGN.md) ·
[`ARCHITECTURE.md`](./ARCHITECTURE.md)
