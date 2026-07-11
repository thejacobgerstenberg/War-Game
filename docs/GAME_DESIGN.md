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
**1400 to 1453** — sixteen rounds, each spanning three to four years of the
century's history. When the last round ends the walls of Constantinople either
still stand, or they do not.

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
`{gold, grain, timber, marble, faith}`.

| Terrain | Base yield | Move cost | Combat note |
|---|---|---|---|
| `PLAINS` | grain 2, gold 1 | 1 | open; cavalry bonus applies |
| `HILLS` | marble 1, gold 1 | 1 | defender **+1** |
| `MOUNTAINS` | marble 2 | 2 | defender **+1**, no cavalry bonus |
| `FOREST` | timber 2, grain 1 | 1 | defender **+1**, negates attacker cavalry bonus |
| `COAST` | grain 1, gold 1 | 1 | amphibious assault: attacker **−1**; enables ports/trade |
| `CITY` | gold 3, faith 1 | 1 | may hold walls & great works; garrison bonus |

> **Note on resource names.** The secondary building resource is **Marble**,
> stored in the `marble` field of
> [`ResourceBundle`](../shared/src/types/gameState.ts). Rules text, tables, UI,
> and code all say *Marble*; older drafts called the resource "stone". "Faith"
> is a non-tradeable prestige/religion resource (see §4).

### 3.2 Key cities

A handful of named **key cities** — exactly the provinces flagged `HV(n)` in
[`MAP.md`](./MAP.md)'s registry (Constantinople HV(5); Venice, Genoa, Rome HV(4);
Thessalonica, Athens, Trebizond, Crete, Cairo, Alexandria, Naples, Kaffa HV(3)) —
carry extra yields, prestige value, and pre-built walls. They are the prestige
anchors of the map and the "key cities" scored in §13.1. Full list and stats:
[`MAP.md`](./MAP.md).

---

## 4. Resources & Economy

Five resources drive everything, modelled as `ResourceBundle`:

| Resource | Tier | Primary use |
|---|---|---|
| **Gold** | Core | Recruit units, build, bribe, buy in markets, pay tribute |
| **Grain** | Core | Sustain armies (upkeep); starvation if short |
| **Timber** | Secondary | Ships, shipyards, granaries, siege engines |
| **Marble** | Secondary | Walls, universities, great works |
| **Faith** | Secondary | Churches, great works, some cards; feeds prestige |

### 4.1 Income

During the **Income & upkeep** phase each round, every player collects the summed
yields of all owned provinces into their treasury. This is the engine function
[`computeIncome(state, playerId)`](../server/src/engine/income.ts) →
`ResourceBundle`.

```
income(player) = Σ province.yields  for province where province.ownerId == player.id
                 + Σ building.yieldBonus
                 + Σ tradeRouteIncome        (see §5)
```

> The shipped `computeIncome` implements the first term and already **nets the
> army's grain upkeep (§4.4) out of the grain yield**; the building and
> trade-route terms are added with those systems.

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
            + portTier(A) + portTier(B)  // each port’s tier 0–3, derived from MAP.md's HV flags:
                                         //   HV(4)+ port = 3, HV(3) port = 2, any other port = 1
            + controlledSeaHops          // +1 per sea zone on the route you or an ally control

then:
  if any hop is BLOCKADED by an enemy war fleet:  routeIncome ×= 0.5  (round down)
  if any hop is SEVERED (enemy fleet + no friendly escort):  routeIncome = 0
  if faction is VENICE or GENOA:  routeIncome ×= 1.5  (merchant bonus, round down)
```

**Worked example.** Venice runs Venice (tier 3) ↔ Crete (tier 2) across 3
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
| `SIEGE` | Bombards / trebuchets | gold 8, marble 2, timber 2 | 1 | 0* | 1 | 1 | Weak in field; **+3 vs walls**; bombards in sieges |
| `GALLEY` | War / merchant galley | gold 5, timber 2 | 1 | 2 | 2 | 2 | Naval; can **transport** 1 army; acts as merchantman |
| `WARSHIP` | Great galley / carrack | gold 8, timber 3 | 1 | 3 | 3 | 2 | Naval; blockade/escort superiority |

`*` `SIEGE` contributes no offensive dice in a **field** battle but adds its **+3
vs walls** in sieges.

One **unique siege engine — the Great Bombard —** exists outside this roster. It
cannot be recruited; it enters play only through the Era III omen
`great-bombard-forged` and is governed by §8.4.

Every other named **unique unit** — Varangian Guard, Greek-Fire Dromon,
Janissary, Ghazi Akıncı, Stradioti, Great Galley (Galeazza), Genoese
Crossbowmen, Carrack (Nave), Black Army, Banderial Knights — is a **faction
variant of a base type above**: it uses its base type's raise cost, CV and
upkeep unless its entry says otherwise. The full unit → base-type mapping and
each variant's layered powers live in [`FACTIONS.md`](./FACTIONS.md) (*Unique
units and the engine roster*).

### 6.2 Recruitment

**Recruit** is an action (§10.1). You may raise units in any owned province that
is a **capital**, a **`CITY`**, or has a recruitment building (Barracks) —
naval units require a **Shipyard** province. Pay the full cost from the treasury.

* **Mercenaries** — any land unit may instead be **hired as a mercenary**: pay
  **×1.5 gold, 0 grain** to raise, available immediately even outside recruitment
  buildings, but they carry **×2 grain upkeep** and **desert first** if unpaid
  (§4.4). Genoa hires mercenaries at the normal ×1.0 gold rate (ordinary hiring
  only — bid-market bids, §6.3, are not discounted).

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

| Company | Typical stack | Min bid |
|---|---|---|
| **Catalan Company** | 5 INFANTRY, 3 ARCHER | 12 gold |
| **Company of St. George** | 4 INFANTRY, 3 CAVALRY | 14 gold |
| **The Almogavars** | 6 LEVY, 2 CAVALRY, 1 SIEGE | 10 gold |
| **Varangian Remnant** | 4 INFANTRY, 2 CAVALRY (elite: +1 CV def) | 16 gold |

The four companies above are the **complete company deck** for the base game.

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
| City walls (defender) | defender **+1 … +4** by wall tier (§8.1), while Wall HP > 0 |
| Escalade (assaulting un-breached walls) | attacker **−1** |
| Tactic card | as printed — see §7.7 (typ. **+1 die**, a reroll, or a wall-bonus change) |
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
Defender rolls 3 INF (`7−3−1=3+`), 2 LEVY (`7−1−1=5+`), 2 ARCHER (5+).
→ INF {5,2,4}=2 hits, LEVY {6,1}=1 hit, ARCHER {3,2}=0 → **3 hits**.
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
* **Morale modifiers** — effects phrased as **±1 morale** (event cards, the
  Church, §9.1) apply to this rout check: each +1 morale adds 1 to the side's
  rout-check die (routing less likely), each −1 subtracts 1, for any side
  containing affected units.
* **Pursuit** — if a side routs and the enemy has `CAVALRY`, each cavalry inflicts
  1 automatic pursuit hit on the fleeing stack.

### 7.6 Naval combat

Identical hit rules using naval CVs in a **sea zone**. There is no terrain; there
are no walls. The winner controls the zone (enabling blockade §5.3) and may pursue
into an adjacent zone. `GALLEY` transports carrying an army are destroyed with
their cargo if the fleet is wiped out.

### 7.7 Tactic cards

Tactic cards are the card layer of combat — held surprises that bend a battle
without replacing the dice. The shared **tactic deck** holds **48 cards over 24
designs** (8 Common ×3, 8 Uncommon ×2, 8 Rare ×1), shuffled with the seeded RNG
(§14).

**Drawing & holding.**

* Each player draws **1 tactic card** during the **Income & upkeep** phase,
  after the Omen resolves. A **University** adds **+1** draw/round; the **Great
  University** adds **+2** (§9.1–§9.2). Omen **Grant** cards (§12) add specific
  cards on top of these draws.
* **Hand limit: 3 tactic cards.** Discard down to 3 at Cleanup. Hands are hidden.
* When the draw pile empties, **reshuffle the discard pile**. Cards that read
  *remove from game* never return.

**Playing.**

* A card scoped to a **battle, assault, or siege** is played **during that
  engagement** in the Battle phase at **no action cost**; any printed resource
  cost is still paid (§10.6). Each side may play **at most one tactic card per
  battle round**; *The Intercepted Letter* is a **reaction** and exempt from
  this limit.
* A card with **no battle scope** is played with the **Play-card action**
  (§10.6). Exception: *Forced March* is played as a free rider on one of your
  Move actions.
* **"+N dice"** — extra dice granted by a card are rolled in your **melee
  step**, at the hit threshold of **one participating unit of your choice**
  (chosen when the card is played). They obey the normal 2–6 clamp (§7.1).
* **Rerolls** — no die may be rerolled more than once. The Great University's
  *tactic reroll aura* (§9.2): once per battle, its owner may reroll **one** of
  their dice as if by a tactic card (the once-per-die rule still applies).

**The 24 ratified cards.**

| Slug | Card | Tier (copies) | Final effect |
|---|---|---|---|
| `forced-march` | Forced March | Common ×3 | Rider on one of your Move actions: that army moves **+1 province**; it may not *Besiege* or *Assault* this round. |
| `veterans-of-the-border` | Veterans of the Border | Common ×3 | One land battle: your side rolls **+1 die** in each melee step. |
| `pilot-of-the-narrows` | The Pilot of the Narrows | Common ×3 | One fleet battle: your side rolls **+1 die** in each melee step. |
| `ladders-and-fascines` | Ladders and Fascines | Common ×3 | In one round of a siege assault, **reroll one** of your dice. |
| `the-counting-house` | A Good Season at the Counting-House | Common ×3 | Gain **2 gold**. |
| `grain-barges-of-the-danube` | Grain Barges of the Danube | Common ×3 | Gain **2 grain**. |
| `ears-in-the-bazaar` | Ears in the Bazaar | Common ×3 | Look at all tactic cards held by **one rival**. |
| `locked-shields` | Locked Shields | Common ×3 | One land battle in which you **defend**: reroll your **lowest die** in each melee step. |
| `feigned-retreat` | Feigned Retreat | Uncommon ×2 | At the start of any battle round, before dice: withdraw your whole stack to an adjacent friendly or empty province. The battle ends; **no pursuit** (§7.5). |
| `night-sortie` | Night Sortie | Uncommon ×2 | One round of a siege against your city: the garrison suffers **no store depletion or hunger loss**; instead the **besieger loses 1 unit** (weakest first). |
| `bribed-gatekeeper` | The Bribed Gatekeeper | Uncommon ×2 | One assault you launch this round: the defender's **wall bonus is 0** (Wall HP unchanged; escalade −1 still applies). |
| `chain-across-the-horn` | The Chain Across the Horn | Uncommon ×2 | One coastal province you hold cannot be the target of an **amphibious assault** until the start of your next turn. |
| `condottieri-contract` | Condottieri Contract | Uncommon ×2 | Pay **2 gold**: one land battle — your side rolls **+2 dice** in each melee step. |
| `papal-indulgence` | Papal Indulgence | Uncommon ×2 | Pay **2 gold**: gain **3 faith** (the sole sanctioned gold→faith conversion — markets never trade faith, §4). |
| `the-intercepted-letter` | The Intercepted Letter | Uncommon ×2 | **Reaction** — play as a rival plays a tactic card: **cancel it**. Both cards are discarded. |
| `the-hexamilion-manned` | The Hexamilion Manned | Uncommon ×2 | One land battle you defend in an **unwalled** province: gain **defender +2** (a temporary T2-grade wall bonus; creates no Wall HP; does not stack with real walls). |
| `greek-fire` | Greek Fire | Rare ×1 | Before dice in a fleet battle you are fighting: **win it outright** — all enemy naval units in the zone are destroyed (transports and cargo with them, §7.6). Then **discard one other tactic card** from your hand and **remove this card from the game**. |
| `master-founders-hired` | Master Founders Hired | Rare ×1 | One siege you are pressing, for **one full round**: the defender's **wall bonus is 0** (Wall HP unchanged; escalade −1 still applies) and your side rolls **+1 die** in each melee step of the assault. Hires the founders, not the gun: creates **no siege engine** and never interacts with the **Great Bombard**, which stays unique per §8.4. |
| `treason-at-the-gate` | Treason at the Gate | Rare ×1 | Pay **4 gold**. Playable on a walled city you have besieged for **2+ consecutive rounds**, counting **only siege rounds from game round 6 onward** toward that requirement (so the earliest legal play is **round 7**), whose garrison holds **4 or fewer units**: the city **falls without an assault** — its garrison surrenders (removed) and you occupy it, walls at their current HP. **Remove this card from the game.** |
| `the-pay-chest-taken` | The Pay Chest Taken | Rare ×1 | Take **up to 3 gold** from one rival's treasury (never more than they hold). |
| `holy-war-proclaimed` | Holy War Proclaimed | Rare ×1 | Pay **2 faith**: until the start of your next turn, your side rolls **+1 die** in each melee step of **every** battle you fight. |
| `sails-from-the-west` | Sails from the West | Rare ×1 | Play while a coastal city you hold is besieged: this round its stores do **not** deplete and it takes no hunger loss — **even under full naval blockade** (§8.2) — and **restore 2 depleted grain stores** (up to its maximum). |
| `a-death-in-the-palace` | A Death in the Palace | Rare ×1 | Name one rival: a **truce** binds you both until the start of your next turn — neither may declare a new battle, assault, or siege against the other (engagements already joined continue). |
| `the-white-knights-stroke` | The White Knight's Stroke | Rare ×1 | In one round of a land battle, **reroll any of your dice** once (keep the second results). |

**Deck distribution.**

| Tier | Designs | Copies each | Cards |
|---|---|---|---|
| Common | 8 | 3 | 24 |
| Uncommon | 8 | 2 | 16 |
| Rare | 8 | 1 | 8 |
| **Tactic deck** | **24** | — | **48** |

> One proposed rare, `the-guns-of-orban`, was **rejected**: it would put the
> same historical gun in the game twice — once as the unique, capturable
> **Great Bombard** (§8.4, granted by the `great-bombard-forged` omen) and once
> as a replayable one-shot card. Its slot is filled by the re-flavor
> `master-founders-hired`, which hires the gun-founders rather than fielding
> the gun and so leaves the Bombard's uniqueness intact.

Rares appear once each, and *Greek Fire* and *Treason at the Gate* additionally
remove themselves from the game — their moments happen at most once per
campaign.

---

## 8. Sieges

Taking a **walled city** is a **multi-turn** operation, not a single battle.

### 8.1 Wall tiers & HP

Walls are graded in **tiers T1–T5** — the `Walls` column of [`MAP.md`](./MAP.md)'s
registry. Each tier maps to a Wall-HP pool and a defender bonus:

| Wall tier | Wall HP | Defender bonus | Notes |
|---|---|---|---|
| — (palisade / none) | 0 | — | Open province |
| **T1** (light wall) | 3 | +1 | |
| **T2** | 6 | +2 | Buildable: **Walls Lv1** (§9.1) |
| **T3** | 10 | +3 | Buildable: **Walls Lv2** (§9.1) |
| **T4** (great fortress) | 13 | +4 | e.g. `belgrade`, `rome` |
| **T5 — Theodosian Walls** | 16 | +4 | Constantinople great work (§8.3, §9.2) |

Card/event effects phrased as **"wall tier ±1"** move the city one row on this
table (its Wall HP is set to the new tier's maximum). A tier lost this way is
rebuilt with the Build action's wall upgrade (gold + marble, §9.1); HP damage
*within* a tier heals at +1 HP/round out of siege (§8.2.5).

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
   **Sea resupply** — a besieged **coastal** city depletes stores **only while
   under naval blockade**. In any round where at least one sea zone adjacent to
   the city is *not* controlled by an enemy war fleet (an enemy
   `GALLEY`/`WARSHIP` present and uncontested by a friendly war fleet — §5.3,
   §7.6), supply ships slip in: **no store is depleted and hunger losses never
   begin** (bombardment and assault proceed normally). Only when **every**
   adjacent sea zone is enemy-controlled does a port starve like an inland city.
   *Design intent:* a land army alone can never starve out a port — command of
   the sea is the key to Constantinople, whose two adjacent zones (`bosphorus`
   and `sea-of-marmara`, per `MAP.md`) must **both** be closed before the City
   hungers.
4. **Assault** — the attacker may **assault** at any time (a Move/Attack action):
   * If Wall HP > 0 → defender keeps the full wall bonus **and** attacker suffers
     **escalade −1**.
   * If Wall HP = 0 (breach) → normal field-battle odds, no wall bonus.
   * Combat then resolves as §7. Winning the assault **captures the city**.
5. **Relief** — a friendly/allied army may **march to relieve**: it attacks the
   besiegers in a field battle. If the besiegers lose or retreat, the **siege is
   broken** and walls begin to slowly repair (+1 HP/round out of siege, up to max).

**Percentage siege/diplomacy modifiers** — card and faction effects phrased as a
**±25% / ±50%** modifier to sieges or diplomacy translate to dice: every 25% is
**1 pip** on the relevant rolls (wall-damage, assault, or diplomacy/vassalize
rolls). E.g. *"capture at −50% siege cost"* = **+2** to the attacker's
wall-damage and assault rolls; *"−25% to its sieges"* = **−1** to its rolls.

### 8.3 Constantinople

Constantinople begins with **Theodosian Walls (tier T5: 16 HP, +4)**. Its capture
triggers the **sudden-death** victory check (§13.3). Byzantium may spend a great
work to keep them in repair; a lapsed empire lets them crumble to T3.

**T5 masonry** — against an intact tier-T5 wall an ordinary siege train is
nearly futile: the attacker's combined `SIEGE` bombardment inflicts a **maximum
of 1 Wall HP per round** (in total, regardless of how many siege units roll or
what they roll). At that rate the Theodosian circuit (16 HP) absorbs sixteen
rounds of battery — the entire game. Intact Theodosian Walls are therefore
**effectively unbreachable until the Great Bombard is forged** (§8.4) — which is
the design intent.

### 8.4 The Great Bombard

The **Great Bombard** — Orban's monster gun — is a **unique siege engine**: one
exists per game, and only if the Era III omen **`great-bombard-forged`**
([`EVENT_CARDS.md`](./EVENT_CARDS.md) #34) is drawn. When that card resolves,
the Bombard enters play **at no cost** in the recipient's capital (or any owned
`CITY`): the **Ottoman** player receives it if in play; otherwise the card
auctions it (gold + marble bids) to the highest bidder, per the card text. It
cannot be recruited, rebuilt, or duplicated.

The Great Bombard counts against the §6.4 stacking limit like any other unit
(PR #11 TUNING_REPORT §2.8). If the recipient's capital is already at the
stacking cap (§6.4) when the Bombard is forged, it instead enters play in the recipient's **adjacent owned
province with the most remaining stacking room** — falling back to **any owned
province with room**, and if none exists, placement is **deferred** until one
does (engine parity ruling).

| Attribute | Rule |
|---|---|
| **Entry** | Free, via `great-bombard-forged` only (Era III); **one per game** |
| **Upkeep** | **3 grain**/round. If unpaid it never deserts — it falls **silent** instead (no bombardment next round) |
| **Movement** | **1 province per round**, consuming a full Move action, regardless of terrain move cost; it may **not** enter `MOUNTAINS`; it cannot benefit from extra-movement effects (e.g. *Forced March*) |
| **Naval transport** | Never by ordinary transport. A fleet containing at least one `GALLEY` may spend its **entire Move action** carrying the Bombard **alone** (no army cargo) exactly **one sea zone**; if that fleet is destroyed at sea the Bombard **sinks** (removed from game) |
| **Field battle** | Rolls **no dice** (as `SIEGE`) |
| **Assault** | Adds the standard `SIEGE` **+3 vs walls** |
| **Emplacement** | On arriving at a siege the Bombard needs **one full round of emplacement** before it fires: it rolls **no** wall-damage dice the round it arrives, and counts as **emplaced** from the following round |
| **Bombardment** | Once emplaced, rolls **two wall-damage dice** per siege round (§8.2 step 2) — up to **6 Wall HP/round**. It **ignores the T5 masonry cap** (§8.3), and while it is emplaced against a wall the cap is **lifted for the entire besieging train** |
| **Capture** | If the stack escorting it is destroyed, routs, or surrenders — or the city it garrisons falls — the Bombard is **never destroyed by battle**: it transfers **intact to the victor as loot**. The captor may instead **spike it** (remove it from the game) at the moment of capture |

**Balance intent.** Before the Bombard exists, an intact T5 wall loses at most
1 HP/round — unbreachable in practice. With it, the Bombard averages ~4 HP/round
(two wall-damage dice) and un-caps the rest of the train, so the Bombard plus
one ordinary `SIEGE` unit averages ~6 HP/round: a fresh **16-HP Theodosian
circuit opens in ~3 rounds** of sustained bombardment once the gun is emplaced
(~4 rounds from its arrival). Whoever owns the gun
holds the key to the City; whoever destroys its escort **takes the key**.

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
| **Market** | gold 4, marble 2 | Trade ratio 2:1; **+1 gold/round** here |
| **Granary** | gold 4, timber 3 | +2 grain storage; **+2 siege hold-out rounds**; softens starvation |
| **Shipyard** | gold 6, timber 4 | Build `GALLEY`/`WARSHIP` here; +1 fleet cap |
| **Church / Mosque** | gold 5, marble 3, faith 1 | **+1 faith/round**; defenders in this province get **+1 morale** (§7.5) |
| **Walls Lv1** | gold 5, marble 4 | Wall tier T2: Wall HP 6, defender +2 |
| **Walls Lv2** (upgrade) | gold 8, marble 6 | Wall tier T3: Wall HP 10, defender +3 |
| **University** | gold 10, marble 4, faith 2 | **+1 tactic-card draw per round** (§7.7); minor prestige |

### 9.2 Great Works (prestige)

| Great Work | Cost | Rounds | Effect | Prestige |
|---|---|---|---|---|
| **Hagia Sophia Repair** | gold 20, marble 10, faith 8 | 3 | Endowment/restoration of the **standing** Great Church (see note below); unlocks unique Byzantine cards | **+10** |
| **Theodosian Walls** (Grand Walls) | gold 15, marble 12 | 2 | Wall tier T5: Wall HP 16, defender +4 | **+6** |
| **Great University** | gold 18, marble 8, faith 4 | 3 | +2 tactic-card draws/round; tactic reroll aura (§7.7) | **+6** |
| **Grand Bazaar** | gold 16, timber 6, marble 6 | 2 | Trade-ratio port (§4.3): **2 : 1** conversions, **1 : 1** for gold↔this port's specialty; **+3 gold/route** from this port | **+5** |

> **Hagia Sophia — clarification (ratified ruling).** The Great Church **starts
> the game intact** and yields its **+2 faith/round from round 1** — that income
> is the standing building's own (Byzantium's *Hagia Sophia* unique power,
> `FACTIONS.md`), not a product of the great work. The great work above does
> **not** construct the building: it is an **endowment/restoration** of the
> standing church, granting its **+10 prestige** (and the Byzantine card
> unlocks) only. For the *Faith of the Fathers* objective (`FACTIONS.md`),
> "intact" means **never captured by assault**: a successful assault on
> `constantinople` sets a permanent **sack flag** that voids the objective; a
> starvation **surrender** (§8.2) does **not** set the sack flag.

Great Works are the primary **engine of prestige** for a builder-focused player
and the flavour spine of the setting (Byzantium repairing the Great Church,
Venice raising the Bazaar, Hungary walling the Danube).

---

## 10. Turn Structure

Each **round represents 3–4 years** of the 1400 → 1453 span (16 rounds; the UI
displays a fixed round → year mapping). A round runs five
phases. The engine's finer-grained [`GamePhase`](../shared/src/types/gameState.ts)
enum (`INCOME`, `RECRUITMENT`, `MOVEMENT`, `COMBAT`, `DIPLOMACY`, `END`) is the
state-machine realisation of these five conceptual phases.

| # | Conceptual phase | Engine `GamePhase`(s) | What happens |
|---|---|---|---|
| 1 | **Omen** | (front of `INCOME`) | The table draws & resolves **one** event card from the current era's Omen deck (§12) |
| 2 | **Income & upkeep** | `INCOME` | Collect province yields net of grain upkeep (`computeIncome`), resolve starvation (§4) |
| 3 | **Action phases** | `RECRUITMENT` → `MOVEMENT` → `DIPLOMACY` | In turn order, each player spends **4 actions** (§10.0) |
| 4 | **Battle resolution** | `COMBAT` | Resolve all declared battles, assaults, sieges, naval clashes (§7, §8) |
| 5 | **Cleanup / reshuffle** | `END` | Flip contested ownership, score prestige, check victory, **re-sort turn order by prestige** |

### 10.0 The action economy (4 actions)

Each player receives **4 actions** per round (certain cards
can raise this to 5). Actions may be spent in **any mix and any order** from the
list below — the engine's `RECRUITMENT` → `MOVEMENT` → `DIPLOMACY` phases
together form the player's single **action window** and do **not** gate which
action types may be played when (see `ARCHITECTURE.md` §10). A Move
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
for battles; political cards resolve immediately. Drawing, holding, and playing
tactic cards — including which plays cost this action and which are free during
battle — is governed by §7.7.

### 10.7 Spy (light espionage)

Spend **1 action + 3 gold** to dispatch an agent and choose **one** mission.
Each mission first requires a **success roll** of **1d6 ≥ 3** (base 4-in-6). The
target may lengthen the odds: a rival with a **University** imposes **−1** (you
then need `≥ 4`), and Byzantium as the *target* resists with a **+1** (needs
`≥ 4`, or `≥ 5` vs a University rival) thanks to its long tradition of palace
intrigue.

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
  claimant attack without the unjustified-war penalty (below) and scores **+1**
  extra prestige for wins in that war.
* **Unjustified war** — opening a war **without a casus belli** costs
  **−1 prestige**, scored at that Cleanup (§13.1). Treaty-break penalties (table
  above) still apply on top if the attack also broke a standing treaty.

### 11.5 NPC Minor States

Between the great powers sit **six neutral minor states** — small realms holding
one or two provinces with a standing garrison, but no player. They are prizes to
be **conquered** by the sword or **vassalized** by the purse. The exact set,
provinces and garrison sizes are fixed by [`MAP.md`](./MAP.md) §5; the canonical
roster is: **Serbia**, **Wallachia**, the **Karaman League** (`ankara` +
`konya`), **Trebizond**, the **Knights of Rhodes**, and the **Republic of
Ragusa**.

**Two paths to control:**

* **Conquest** — attack and defeat the minor's garrison like any defender
  (§7–§8; several minors sit in defensible terrain or behind T2–T3 walls
  (`MAP.md` §5), so this is **costly** and may take a siege). On victory the minor's provinces flip to
  the conqueror as normal territory. Conquest scores the usual battle prestige but
  earns the minor's **enmity** — see revolts below.

* **Vassalize** (Diplomacy action) — instead of fighting, **buy loyalty**. Spend
  **1 Diplomacy action** and pay the minor an **up-front bribe** of `8 gold +
  4 × (garrison unit count)`; then roll **1d6 + your prestige-tier − the minor's
  garrison tier**, where **prestige-tier** = `⌊your prestige ÷ 10⌋` (capped at 2)
  and **garrison tier** = `⌊garrison unit count ÷ 2⌋`. On **≥ 4** the minor
  becomes your **vassal**. A **royal-marriage-adjacent bribe** (paying an extra
  +4 gold) grants **+1** to the roll — minors hold no treaties, so no pact can
  sweeten the odds, only coin. On failure the bribe is **half-refunded** and you
  may retry next round.

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

The Omen deck is split into **three era decks** — **Era I** (rounds 1–5),
**Era II** (rounds 6–10), **Era III** (rounds 11–16) — each shuffled separately.
At the start of each round the table draws **one card** from the current era's
deck and resolves it, **regardless of player count**; with **4–5 players** the
*next* card is additionally revealed face-up as a telegraphed "gathering omen".
Cards come in three durations:

* **Immediate** — resolve now and discard (a good/bad harvest, a comet, a plague
  outbreak, a mercenary company for hire).
* **Persistent** — stays in play for a number of rounds (a schism halving faith, a
  trade boom, a hard winter doubling upkeep).
* **Grant** — adds a **tactic** (§7.7) or **political** card to the drawer's
  `hand` for later use (a papal indulgence, a clever stratagem).

The era split does the weighting: the early decks skew opportunity and the late
deck (1440s+) skews crisis, dramatising the gathering storm around
Constantinople. The full card list and text live in
[`EVENT_CARDS.md`](./EVENT_CARDS.md); the engine only needs the deck definitions
and a **seeded RNG** to draw deterministically (see
[`ARCHITECTURE.md`](./ARCHITECTURE.md) §Rules-engine).

---

## 13. Prestige & Victory

**Prestige points** are the sole victory currency. They are scored in the
**Cleanup** phase (§10, phase 5).

### 13.1 Prestige table

| Source | Prestige |
|---|---|
| Hold **your own capital** | **+1** / round (passive) |
| Hold an **enemy capital** | **+3** / round |
| Hold a named **key city** (any `HV(n)` city — §3.2) | **+1** each / round |
| **Trade monopoly** (control both ends of a major route, or most ports of a sea) | **+2** / round for your **first** monopoly; **+1** / round for each additional one (diminishing) |
| Complete a **Great Work** | **+5 … +10** once (per §9.2) |
| Win a **decisive battle** (attacker or defender wipes/routs the enemy) | **+1** |
| Win a **war** (force peace, tribute, or vassalage) | **+3** |
| Take a **walled city** (T1+) by storm or siege | **+2** (**+3** if T4–T5) |
| Win a field battle **outnumbered** (enemy's starting stack larger than yours) | **+1** (stacks with the decisive-battle award) |
| Complete a **secret objective** | **+4** each — hidden; revealed & scored only at **game end** (§13.3; 3 per faction, see `FACTIONS.md`) |
| Royal-marriage bond, per round it holds | **+2** |
| **Betray** a treaty | **−2 … −4** (§11) |
| Open an **unjustified war** (no casus belli — §11) | **−1** |
| **Lose your capital** | **−3** |

### 13.2 Victory threshold

The game ends at the **Cleanup** (§10, phase 5) in which a player reaches the
**prestige threshold**, scaled to player count — all prestige is scored at
Cleanup (§13), so Cleanup is the only point where victory is checked. Victory
thresholds are **balance-owned constants**, ratified in `sim/TUNING_REPORT.md`
§2 (balance retune, PR #11 TUNING_REPORT); `server/src/engine/balance.ts` will
hold these constants once the engine lands. Current values: **72 / 75 / 80 / 78**
for 2 / 3 / 4 / 5 players:

| Players | Threshold |
|---|---|
| 2 | **72** |
| 3 | **75** |
| 4 | **80** |
| 5 | **78** |

### 13.3 The 1453 endgame & sudden death

* **Round 16 ("1453")** — if no one has hit the threshold, the game ends after
  round 16's cleanup and the **highest prestige wins** (tiebreak: most key cities,
  then most gold).
* **Sudden death — the Fall of Constantinople** — if any power **captures
  Constantinople and holds it through two full cleanup phases** (2 rounds), it
  wins **immediately**, regardless of prestige. If the sudden-death condition
  and the prestige threshold (§13.2) both trigger in the **same Cleanup**, the
  **capture of Constantinople outranks the threshold** — the City's captor wins.
  This is the game's dramatic spine:
  every faction's clock is really counting down to whether the City stands.

### 13.4 Turn-order reshuffle

At cleanup, `turnOrder` is **re-sorted so the lowest-prestige power acts first**
next round (initiative to the underdog; tiebreak: fewer provinces). This is a
deliberate **catch-up** lever that keeps a runaway leader in reach and the table
tense to the final year.

---

## 14. Balance & Session-Length Notes

* **Length** — 16 rounds × 4 actions × 2–5 players lands at **60–120 min**.
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
