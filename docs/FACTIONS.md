# IMPERIUM: Twilight of Empires — FACTIONS

The five great powers. Each is deliberately **asymmetric** — different economy, army, unique units,
powers and hidden objectives. All starting provinces are exact IDs from `MAP.md` and match its
Starting Ownership Summary. Event references point to `EVENT_CARDS.md`.

**Reading the stat blocks**

- **Starting Resources** — a pool of 🪙 gold / 🌾 grain / 🪵 timber / 🪨 stone / ✝️ faith at turn 1.
- **Starting Army** — units already on the board, listed by province.
- **Unit shorthand:** *levy* (cheap conscript), *inf* (professional infantry), *cav* (cavalry/knights),
  *merc* (mercenary), *siege* (bombard/trebuchet), *war galley*, *merchant galley*.
- **Secret Objectives** — each faction is dealt **3**; they are hidden victory goals scored at game end
  (round 16) unless the sudden-death rule (hold `constantinople` two rounds) ends the game first. A player
  need not complete all three; each contributes prestige/points per `GAME_DESIGN.md`.

**Unique units and the engine roster.** Every named unique unit is a **variant of a base
`UnitType`** from `GAME_DESIGN.md` §6.1 — army/fleet stacks store it under that base type
(`units: Record<UnitType, number>`), with the powers described in each faction's *Unique
Units* entry layered on top. Unless its entry says otherwise, a unique unit uses its base
type's raise cost, CV and upkeep.

| Unique unit | Faction | Base `UnitType` |
|---|---|---|
| Varangian Guard | Byzantium | `INFANTRY` |
| Greek-Fire Dromon | Byzantium | `WARSHIP` |
| Janissary | Ottomans | `INFANTRY` |
| Ghazi Akıncı | Ottomans | `CAVALRY` |
| Great Bombard | Ottomans | `SIEGE` |
| Stradioti | Venice | `CAVALRY` |
| Great Galley (Galeazza) | Venice | `WARSHIP` |
| Genoese Crossbowmen | Genoa | `ARCHER` |
| Carrack (Nave) | Genoa | `WARSHIP` |
| Black Army (Fekete Sereg) | Hungary | `INFANTRY` |
| Banderial Knights | Hungary | `CAVALRY` |

The generic `WARSHIP` ("great galley / carrack", `GAME_DESIGN.md` §6.1) is buildable by
**every** faction; Venice's *Galeazza* and Genoa's *Carrack* are those factions' named
WARSHIP variants, not separate hull types.

---

## ✝️ BYZANTIUM — *The Queen of Cities, at twilight*

> Heir of Rome and Constantine, the Empire is now little more than its walls. One incomparable city,
> a fistful of scattered lands, a treasury of relics and a thousand years of pride. Survive — and perhaps,
> by God's grace, restore what was lost.

- **Capital:** `constantinople`
- **Starting Provinces (5):** `constantinople`, `selymbria`, `lemnos`, `thessalonica`, `morea`
- **Starting Resources:** 🪙 5 · 🌾 4 · 🪵 1 · 🪨 2 · ✝️ 5 *(faith-rich, poor economy, wealth locked in the city)*
- **Starting Army:**
  - `constantinople`: 2 inf, **1 Varangian Guard**, 1 war galley (Golden Horn) — behind the **T5 Theodosian Walls**
  - `thessalonica`: 1 inf, 1 levy (behind T3 walls)
  - `morea`: 1 levy
  - `lemnos`: 1 levy
  - `selymbria`: 1 levy

### Unique Units
- **Varangian Guard** *(elite guard infantry).* The emperor's axe-bearers. Very strong on the **defense of
  a walled city**; may only be **raised in `constantinople`** and is expensive (🪙+🌾). Does not rout while
  the emperor lives.
- **Greek-Fire Dromon** *(unique war galley).* Carries siphon fire: +combat versus enemy fleets and can
  **burn a besieging fleet** in a friendly port's sea zone. Built only at `constantinople` or `thessalonica`.

### Unique Powers
1. **Theodosian Walls.** `constantinople` starts at wall **Tier 5** (16 Wall HP, defender +4 —
   `GAME_DESIGN.md` §8.1) and **auto-repels the first two siege rounds** each time it is besieged
   (defenders sally; no bombardment damage those rounds). Only a **Great Bombard** (see Ottomans / event
   *The Great Bombard Forged*) rolls enough wall damage to batter them down quickly (double wall-damage
   dice, `GAME_DESIGN.md` §8.2).
2. **Hagia Sophia.** `constantinople` yields **+2 ✝️ faith/round** on top of its listed yield. Byzantium may
   spend faith to **sway Orthodox neutrals** (`serbia`, `trebizond`, `wallachia`, `epirus`, `thessaly`, `athens`)
   toward neutrality or alliance instead of paying gold.
3. **Reconquista of the Romans.** Byzantium holds a standing **claim** on former imperial cities —
   `nicaea`, `bursa`, `athens`, `trebizond`, `thessaly` — and pays **−25% cost** to besiege/capture them.
   It may also **bribe an attacker to stand down** for gold (buys one round of peace on a single front).

### Secret Objectives (dealt 3)
1. **Queen of Cities.** Control `constantinople` at game end (round 16). *(Survival — the core Byzantine dream.)*
2. **Restoration of the Empire.** Simultaneously control `thessalonica`, `morea`, **and** at least one of
   `nicaea` / `athens` (a reborn imperial spine on both shores of the Aegean).
3. **Faith of the Fathers.** Hold `constantinople` (with Hagia Sophia intact) and finish the game with
   **≥ 15 ✝️ faith banked**, having **refused Church Union** (never resolved *Council of Florence* in the
   Union's favor). *Defiant Orthodoxy.*

---

## ☪️ OTTOMANS — *The Rising Sultanate*

> From Edirne the tuğ is planted toward the West and the tekbir sounds at dawn. Levies without number,
> the finest slave-soldiers in the world, and one obsession above all: the red apple, Constantinople.

- **Capital:** `edirne`
- **Starting Provinces (7):** `edirne`, `gallipoli`, `philippopolis`, `sofia`, `bithynia`, `bursa`, `nicaea`
- **Starting Resources:** 🪙 6 · 🌾 7 · 🪵 3 · 🪨 3 · ✝️ 2 *(grain-rich to feed huge levy armies; strong land, weak early navy)*
- **Starting Army:**
  - `edirne`: 3 levy, 1 cav, **1 Ghazi Akıncı**
  - `bursa`: 2 levy, **1 Janissary**
  - `gallipoli`: 1 levy, 1 war galley
  - `nicaea`: 1 levy
  - `sofia`: 1 levy
  - `bithynia`: 1 levy
  - `philippopolis`: 1 levy

### Unique Units
- **Janissary** *(elite professional infantry).* Slave-soldiers of the Porte: strong on the **assault** of
  walls and in open battle, but paid only in **🪙 gold** (donative) — if unpaid they grow mutinous
  (see event *Janissary Discontent*). Raised at `edirne` or `bursa`.
- **Ghazi Akıncı** *(light raider cavalry).* Fast raiders who **pillage** an adjacent enemy or neutral
  province for 🪙 gold, ignore rough-terrain movement penalties, and screen the main army. Cheap.

### Unique Powers
1. **Devshirme & the Timariots.** *Levies cost −1 🌾 to sustain* and can be **raised in one turn in any owned
   province**. The Ottoman fields the largest, cheapest land army on the map.
2. **The Great Bombard.** From round 6 onward (or immediately via event *The Great Bombard Forged*) the
   Ottoman may build **Orban's Great Bombard** — a super-siege engine (a `SIEGE` variant) that rolls
   **double wall-damage dice** (up to 6 Wall HP/round, `GAME_DESIGN.md` §8.2) — enough to batter down even
   the Tier-5 Theodosian Walls, and the only reliable answer to them. Slow, costly (🪙+🪨), fragile
   in open battle.
3. **Ghaza (Holy Raid).** Razzias against **neutral beyliks and Christian frontier provinces** cost −25% and
   return extra 🪙 plunder; the Ottoman gains a small prestige bump each time it takes a new city.

### Secret Objectives (dealt 3)
1. **Fetih (The Conquest).** Capture `constantinople` and hold it — the supreme prize (also the game's
   sudden-death condition if held two rounds).
2. **Sword of Two Continents.** Simultaneously control both shores: `gallipoli` **and** `bithynia` **and**
   `bursa`, plus unify Anatolia by holding `ankara` and `konya`.
3. **Ghazi Empire.** Control **≥ 15 provinces** at game end, or **sack three high-value cities**
   (`HV(3)`+ nodes) over the course of the game.

---

## 🦁 VENICE — *La Serenissima, Queen of the Sea*

> The Republic keeps no borders it cannot reach by keel. From the Arsenal come galleys by the dozen;
> from Crete, Negroponte and the Golden Horn come the profits of the world. Rome is a memory — trade is
> forever.

- **Capital:** `venice`
- **Starting Provinces (6):** `venice`, `dalmatia`, `corfu`, `negroponte`, `crete`, `modon`
- **Starting Resources:** 🪙 9 · 🌾 4 · 🪵 5 · 🪨 3 · ✝️ 1 *(richest treasury; Arsenal timber; thin on land troops)*
- **Starting Army:**
  - `venice`: 3 war galley, 2 merchant galley, **1 Stradioti**
  - `crete`: 1 war galley, 1 inf (marine)
  - `negroponte`: 1 war galley
  - `corfu`: 1 war galley
  - `modon`: 1 merchant galley
  - `dalmatia`: 1 levy

### Unique Units
- **Stradioti** *(Balkan marine light cavalry).* Hired Albanian/Greek horsemen who **embark on galleys** and
  raid enemy coasts, then re-embark. Excellent for hit-and-run on ports; weak in a stand-up land battle.
- **Great Galley (Galeazza)** *(heavy war galley).* The Arsenal's masterwork: dominates a sea zone,
  +combat versus ordinary galleys, and carries a bombard for **coastal siege support**.

### Unique Powers
1. **Empire of Trade.** Venice earns **+1 🪙 per controlled port** each round, and **+1 🪙 per sea zone kept
   free of enemy fleets** that links two of its ports (a live trade route). Merchant galleys moving between
   owned ports generate gold.
2. **The Arsenal.** War & merchant galleys cost **−1 🪵 timber**, and Venice may **build up to 2 fleets per
   round at `venice`** (others build one). Vulnerable to event *Fire of the Arsenal*.
3. **Stato da Màr (Colonial Administration).** Island/port colonies (`crete`, `negroponte`, `corfu`, `modon`,
   `cyprus`, `naxos`, `chios` if taken) yield **+1 🪙** and are **−50% garrison cost**. Venice can **blockade**
   an enemy port and **wins ties in sea combat**.

### Secret Objectives (dealt 3)
1. **Stato da Màr.** Control **8 ports**, mandatorily including `crete`, `negroponte`, and `corfu`.
2. **Monopoly of the Straits.** Control or **blockade the `bosphorus`** (hold `constantinople`/`pera`, or keep
   a fleet there) **and** control any **3 Aegean islands** (`lemnos`/`lesbos`/`chios`/`naxos`/`negroponte`).
3. **Queen of the Adriatic.** Control **every port on the `adriatic`** (`venice`, `dalmatia`, `corfu`, and
   `ragusa`) **and** either destroy a Genoese fleet or seize a Genoese colony (`pera`/`chios`/`lesbos`/`kaffa`).

---

## ⚓ GENOA — *La Superba, the Bankers of the East*

> Where Venice keeps an empire of galleys, Genoa keeps an empire of ledgers. The Bank of St George funds
> kings and the Black Sea colonies feed Christendom. Let the Lion of St Mark roar — the griffin counts the
> coin.

- **Capital:** `genoa`
- **Starting Provinces (5):** `genoa`, `pera`, `chios`, `lesbos`, `kaffa`
- **Starting Resources:** 🪙 8 · 🌾 3 · 🪵 4 · 🪨 3 · ✝️ 1 *(deep purse & credit; scattered colonies; grain-poor)*
- **Starting Army:**
  - `genoa`: 2 war galley, 1 merchant galley, **2 Genoese Crossbowmen**
  - `chios`: 1 war galley, 1 Genoese Crossbowman
  - `kaffa`: 1 war galley, 1 levy
  - `pera`: 1 Genoese Crossbowman
  - `lesbos`: 1 levy

### Unique Units
- **Genoese Crossbowmen** *(elite ranged mercenary infantry).* The most sought-after crossbows in Europe:
  strong ranged combat and wall defense. Uniquely, Genoa may **sell them to any other faction or neutral for
  🪙 gold**, earning income whenever they are hired (see event *Hussite Handgunners for Hire* for the rival
  option).
- **Carrack (Nave)** *(heavy sailing merchantman).* Tough, long-range transport & trade ship: hauls more
  cargo and troops than a galley and can **run a blockade** on a die, keeping the Black Sea lifeline open.

### Unique Powers
1. **Banco di San Giorgio (Banking).** Genoa may take an **instant loan** (gain 🪙 now, repay with interest
   later) and may **lend gold to other factions/neutrals**, creating a debt it can later **call in** (event
   *Genoese Loan Called In*) for gold, provinces, or prestige. Hoards the map's liquid capital.
2. **Colonies of the Black Sea.** `kaffa` and `chios` are **major trade engines** — each yields **+2 🪙** and
   Genoa holds a **monopoly on alum & mastic** (`chios`) and Pontic grain (`kaffa`), boosted by event
   *Discovery of Alum*. Colonies **resupply Genoese fleets** at range.
3. **Mercenary Brokers.** Genoa hires mercenaries at the **normal ×1.0 gold rate** (no ×1.5 mercenary
   surcharge — `GAME_DESIGN.md` §6.2) and profits by brokering **Crossbowmen** to
   others; its fleets get **+1 combat when defending a colony's sea zone**.

### Secret Objectives (dealt 3)
1. **Dominium Maris (Black Sea).** Control `kaffa` **and** `chios` **and** at least one other Black Sea/Aegean
   port, while keeping `black-sea-west`/`black-sea-east` free of enemy blockade at game end.
2. **Bankers of Kings.** Finish with **≥ 25 🪙 gold banked** *and* have **at least two other factions in debt
   to you** (outstanding loans), or simply hold the most gold of any player at game end.
3. **Overshadow the Lion.** Hold **more ports than Venice** at game end, **or** capture any Venetian colony
   (`crete`/`negroponte`/`corfu`/`modon`/`dalmatia`).

---

## 🛡️ HUNGARY — *Antemurale Christianitatis, the Bulwark of Christendom*

> On the Danube the last great Christian army of the East stands guard. Where the Cross is threatened,
> Hungary answers — with the Black Army, with the banners of the barons, and, when Rome calls, with Crusade.

- **Capital:** `buda`
- **Starting Provinces (4):** `buda`, `belgrade`, `transylvania`, `croatia`
- **Starting Resources:** 🪙 6 · 🌾 6 · 🪵 5 · 🪨 4 · ✝️ 3 *(strong land economy; essentially no navy — river ports only)*
- **Starting Army:**
  - `buda`: 2 levy, **1 Black Army (Fekete Sereg)**, 1 cav
  - `belgrade`: 2 levy, 1 inf (fortress garrison, behind **T4 walls**)
  - `transylvania`: 2 levy
  - `croatia`: 1 levy

### Unique Units
- **Black Army (Fekete Sereg)** *(elite standing infantry + handgunners).* A professional gunpowder army:
  very strong in open battle and assault, paid in **🪙 gold** (no gold, no Black Army). Represents Hunyadi's
  and later Matthias's mercenary core.
- **Banderial Knights** *(heavy shock cavalry).* The barons' armored horse: devastating charge on `plains`,
  the map's premier cavalry; less effective in `mountains`/sieges.

### Unique Powers
1. **Call the Crusade.** With **papal support** (spend ✝️ faith, +bonus if a friendly power holds `rome`)
   Hungary may **declare a Crusade** against the Ottomans: it gains temporary **Crusader levies**, a faith &
   prestige surge, and may **rally Christian neutrals** (`serbia`, `bosnia`, `wallachia`, `albania`) to march
   with it for the campaign (see events *Varna Crusade*, *Hunyadi's Long Campaign*).
2. **Strongest Levies.** Hungarian **levies get +1 combat** and cost **−1 🪙** — the best militia on the board,
   ideal for the Balkan land war.
3. **Danube Fortresses & Papal Support.** `belgrade` (T4) and `buda` (T3) gain **+1 defense** versus Ottoman
   sieges; Hungary earns steady ✝️ faith and may convert **indulgences → gold** to fund armies (event
   *Papal Indulgence*).

### Secret Objectives (dealt 3)
1. **Antemurale Christianitatis.** Hold **both `belgrade` and `buda`** at game end, and never let the Ottomans
   capture either during the game. *(The bulwark holds.)*
2. **Crusader.** Win a major battle against the Ottomans at **`varna`** (or another Balkan front) **and**
   control **three** Balkan neutral provinces (`serbia`, `bosnia`, `wallachia`, `albania`).
3. **Defender of the Faith.** Lead a Crusade that captures a Muslim-held city (`edirne`/`sofia`/`bursa`),
   **or** ensure `constantinople` remains in Christian hands at game end.

---

## Asymmetry at a Glance

| Faction | Economic lean | Military lean | Signature edge | Chief weakness |
|---------|---------------|---------------|----------------|----------------|
| **Byzantium** | Faith-rich, gold-poor | One impregnable city | Theodosian Walls, Hagia Sophia, reconquest claims | Tiny, fragmented territory |
| **Ottomans** | Grain-rich | Massed cheap land army | Cheap levies, Janissaries, Great Bombard | Weak early navy, Janissary/interregnum risk |
| **Venice** | Richest gold | Dominant navy | Arsenal, trade routes, colonies | Few land troops, Genoa rivalry |
| **Genoa** | Deep credit/gold | Strong navy + crossbows | Banking/loans, Black Sea colonies | Grain-poor, exposed long lifeline |
| **Hungary** | Strong land/timber | Best land levies + knights | Crusade, Black Army, Danube forts | Landlocked-ish (no sea navy) |

> **Balance note for the build:** turn order and per-round resource drip are set in `GAME_DESIGN.md`.
> These starting pools assume a 2–5 player game where unclaimed great powers are run as passive AI holding
> only their capital cluster.
