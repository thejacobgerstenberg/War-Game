# IMPERIUM: Twilight of Empires — MAP

**The board: Mediterranean, Balkans, Anatolia, Black Sea, Italy & the Levant edge, c. 1400–1453.**

This is the canonical province registry. Every province ID here is authoritative; `FACTIONS.md`
and `EVENT_CARDS.md` reference these exact IDs. IDs are kebab-case (e.g. `constantinople`).

- **55 land provinces** across 8 broad regions.
- **12 named sea zones** for fleet movement, trade and blockade.
- A fully connected adjacency graph. Italy connects to the East only by sea; the Bosphorus
  bridges Europe and Asia at Constantinople.

---

## 1. Resource Legend

Five resources. **Gold** and **Grain** are the core economy; the other three build things.

| Resource | Symbol | Used for |
|----------|--------|----------|
| **Gold** | 🪙 | Raise & pay all units (esp. mercenaries, Janissaries, knights); buildings; bribes; loans |
| **Grain** | 🌾 | Sustain armies each round (upkeep); population; famine is deadly |
| **Timber** | 🪵 | War galleys, merchant galleys, siege engines, wall repairs |
| **Stone** | 🪨 | Walls & fortresses (raise/repair wall tiers), great works, stone-throwing siege engines. Includes marble/silver where noted |
| **Faith** | ✝️ | Church income; sway Orthodox/Catholic neutrals; call crusades; indulgences → gold; prestige |

Each land province lists a **Primary Yield** (produced every round it is controlled and unpillaged)
and often a **Secondary Yield** (smaller amount). Ports additionally enable trade gold (see Venice/Genoa).

## 2. Terrain Legend

| Terrain | Typical yield lean | Movement note |
|---------|--------------------|---------------|
| **city** | gold/faith (trade & population) | Usually walled; the prestige nodes |
| **plains** | grain | Open; fast cavalry country |
| **hills** | grain/stone/gold(silver) | Slows movement slightly |
| **mountains** | timber/stone | Hard to move through; strong on defense |
| **forest** | timber | Slows movement; ambush terrain |
| **coast** | grain(fishing)/gold(trade) | Always a port; embark/disembark fleets |

**Walled City tier** = fortification grade **T1** (light wall) to **T5** (Theodosian Walls). Each tier
maps to a Wall-HP pool and defender bonus in `GAME_DESIGN.md` §8.1; siege engines batter Wall HP down
(a city may be assaulted before breach at the escalade penalty), and a lost tier is rebuilt with 🪨 stone
via the Build action.

---

## 3. Province Registry (55 land provinces)

Prestige/Value nodes (high-value economic & scoring cities) are flagged in **Notes** as `HV(n)`.

| ID | Name | Region | Terrain | Primary | Secondary | Port? | Walls | Starting Owner | Notes |
|----|------|--------|---------|---------|-----------|-------|-------|----------------|-------|
| `constantinople` | Constantinople | Thrace / Marmara | city | 🪙 gold | ✝️ faith | Y | **T5** | **Byzantium** | Capital. Theodosian Walls. **HV(5)**. Sudden-death objective. |
| `selymbria` | Selymbria | Thrace | coast | 🌾 grain | — | Y | — | **Byzantium** | Byzantine buffer on the Marmara shore. |
| `pera` | Pera (Galata) | Bosphorus | city | 🪙 gold | — | Y | T1 | **Genoa** | Genoese enclave across the Golden Horn from Constantinople. |
| `edirne` | Edirne (Adrianople) | Thrace | plains | 🌾 grain | 🪙 gold | N | T3 | **Ottomans** | Ottoman European capital. |
| `gallipoli` | Gallipoli | Thrace / Dardanelles | coast | 🌾 grain | 🪵 timber | Y | T2 | **Ottomans** | Controls the Dardanelles; Ottoman naval base. |
| `philippopolis` | Philippopolis (Plovdiv) | Bulgaria | plains | 🌾 grain | — | N | — | **Ottomans** | Thracian road hub. |
| `sofia` | Sofia | Bulgaria | hills | 🌾 grain | 🪨 stone | N | — | **Ottomans** | Balkan crossroads. |
| `varna` | Varna | Bulgaria (coast) | coast | 🌾 grain | 🪙 gold | Y | T1 | Independent | Battlefield of 1444. |
| `wallachia` | Wallachia | Danube | plains | 🌾 grain | 🪵 timber | N | — | Independent | Voivodship; Danube frontier. NPC minor. |
| `serbia` | Serbia (Smederevo) | Serbia | hills | 🪙 gold | 🪨 stone | N | T2 | Independent | Despotate; Novo Brdo silver. NPC minor. |
| `bosnia` | Bosnia | Bosnia | mountains | 🪨 stone | 🪵 timber | N | T1 | Independent | Silver & lead; heretic frontier. |
| `albania` | Albania (Krujë) | Albania | mountains | 🪵 timber | 🪨 stone | Y | T1 | Independent | Highland clans (Skanderbeg country). |
| `epirus` | Epirus (Arta) | NW Greece | mountains | 🪵 timber | 🌾 grain | Y | — | Independent | Despotate of Epirus. |
| `thessaly` | Thessaly (Larissa) | Greece | plains | 🌾 grain | — | N | — | Independent | Fertile plain. |
| `thessalonica` | Thessalonica | Macedonia | city | 🪙 gold | ✝️ faith | Y | T3 | **Byzantium** | Second Byzantine city. **HV(3)**. |
| `athens` | Athens | Greece | city | 🪨 stone | ✝️ faith | Y | T2 | Independent | Duchy of Athens (Acciaioli). **HV(3)**. Marble. |
| `morea` | Morea (Mistra) | Peloponnese | hills | 🌾 grain | ✝️ faith | N | T2 | **Byzantium** | Despotate of the Morea; Mistra. |
| `modon` | Modon & Coron | Peloponnese | coast | 🪙 gold | 🌾 grain | Y | T1 | **Venice** | "The eyes of the Republic." |
| `venice` | Venice | Veneto | city | 🪙 gold | 🪵 timber | Y | T3 | **Venice** | Capital; the Arsenal. **HV(4)**. |
| `milan` | Milan | Lombardy | plains | 🪙 gold | 🪨 stone | N | T2 | Independent | Armorers & condottieri (Duchy of Milan). |
| `genoa` | Genoa | Liguria | city | 🪙 gold | 🪨 stone | Y | T3 | **Genoa** | Capital; the Bank of St George. **HV(4)**. |
| `rome` | Rome | Latium | city | ✝️ faith | 🪙 gold | Y | T4 | Independent | Papal States. **HV(4)**. Source of indulgences & crusades. |
| `naples` | Naples | Campania | city | 🌾 grain | 🪙 gold | Y | T3 | Independent | Aragonese kingdom. **HV(3)**. |
| `sicily` | Sicily (Palermo) | Sicily | coast | 🌾 grain | 🪙 gold | Y | T2 | Independent | Aragon's granary. |
| `tunis` | Tunis | Ifriqiya | coast | 🪙 gold | 🌾 grain | Y | T1 | Independent | Hafsid corsair nest. |
| `dalmatia` | Dalmatia (Zara/Split) | Dalmatia | coast | 🪵 timber | 🪨 stone | Y | T1 | **Venice** | Arsenal oak & stone. |
| `ragusa` | Ragusa | Dalmatia | city | 🪙 gold | — | Y | T2 | Independent | Merchant republic; tribute-payer. NPC minor. |
| `croatia` | Croatia (Zagreb) | Croatia | forest | 🪵 timber | 🌾 grain | N | — | **Hungary** | Frontier march. |
| `buda` | Buda | Hungary | city | 🪙 gold | 🌾 grain | R | T3 | **Hungary** | Capital; Danube river port. |
| `belgrade` | Belgrade (Nándorfehérvár) | Danube | city | 🌾 grain | 🪨 stone | R | **T4** | **Hungary** | Key Danube fortress guarding the Balkans. |
| `transylvania` | Transylvania | Carpathia | forest | 🪙 gold | 🪵 timber | N | T1 | **Hungary** | Gold & salt mines. |
| `bithynia` | Bithynia (Nicomedia) | NW Anatolia | hills | 🌾 grain | 🪵 timber | Y | — | **Ottomans** | Asian shore of the Bosphorus. |
| `bursa` | Bursa | NW Anatolia | hills | 🪙 gold | 🌾 grain | N | T3 | **Ottomans** | First Ottoman capital; silk. |
| `nicaea` | Nicaea (İznik) | NW Anatolia | city | 🌾 grain | ✝️ faith | N | T2 | **Ottomans** | Council city; lake fortress. |
| `ankara` | Ankara | Central Anatolia | plains | 🌾 grain | 🪨 stone | N | T1 | Independent | Post-Timur contested; angora wool. NPC minor (Karaman league). |
| `konya` | Konya | S-Central Anatolia | plains | 🌾 grain | 🪨 stone | N | T1 | Independent | Karaman beylik seat. NPC minor. |
| `kastamonu` | Kastamonu | N Anatolia | mountains | 🪵 timber | 🪨 stone | N | — | Independent | Candar / İsfendiyar beylik. |
| `sinope` | Sinope | N Anatolia | coast | 🪵 timber | 🪙 gold | Y | T1 | Independent | Black Sea shipyards. |
| `smyrna` | Smyrna (İzmir) | W Anatolia | coast | 🪙 gold | 🌾 grain | Y | T1 | Independent | Aydın beylik port. |
| `antalya` | Antalya (Attaleia) | S Anatolia | coast | 🌾 grain | 🪙 gold | Y | — | Independent | Teke coast. |
| `trebizond` | Trebizond | Pontus | city | 🪙 gold | ✝️ faith | Y | T3 | Independent | Empire of Trebizond. **HV(3)**. Silk terminus. NPC minor. |
| `aleppo` | Aleppo | Levant | plains | 🪙 gold | 🌾 grain | N | T1 | Independent | Mamluk caravan city. |
| `antioch` | Antioch | Levant | coast | 🌾 grain | 🪙 gold | Y | T1 | Independent | Mamluk frontier. |
| `damascus`? — *(not used)* | — | — | — | — | — | — | — | — | *(Levant folded into Aleppo/Cairo)* |
| `cairo` | Cairo | Egypt | city | 🪙 gold | ✝️ faith | N | T2 | Independent | Mamluk capital. **HV(3)**. |
| `alexandria` | Alexandria | Egypt | coast | 🌾 grain | 🪙 gold | Y | T2 | Independent | Nile grain + spice. **HV(3)**. |
| `cyprus` | Cyprus | E Mediterranean | coast | 🪙 gold | 🌾 grain | Y | T2 | Independent | Lusignan kingdom; sugar & wine. |
| `rhodes` | Rhodes | Dodecanese | coast | 🪙 gold | ✝️ faith | Y | T3 | Independent | Knights Hospitaller. NPC minor. |
| `chios` | Chios | Aegean | coast | 🪙 gold | — | Y | T1 | **Genoa** | Mastic & alum; the Maona. |
| `lesbos` | Lesbos (Mytilene) | Aegean | hills | 🪵 timber | 🪙 gold | Y | T1 | **Genoa** | Gattilusio lordship. |
| `lemnos` | Lemnos | Aegean | plains | 🌾 grain | — | Y | T1 | **Byzantium** | Byzantine granary isle. |
| `negroponte` | Negroponte (Euboea) | Aegean | coast | 🌾 grain | 🪙 gold | Y | T2 | **Venice** | Venetian bailo's seat. |
| `naxos` | Naxos | Cyclades | hills | 🪙 gold | 🪨 stone | Y | T1 | Independent | Duchy of the Archipelago; marble. |
| `crete` | Crete (Candia) | Sea of Crete | hills | 🪙 gold | 🌾 grain | Y | T2 | **Venice** | **HV(3)**. Wine; Arsenal timber depot. |
| `corfu` | Corfu | Ionian | coast | 🪙 gold | 🌾 grain | Y | T2 | **Venice** | Venetian gate of the Adriatic. |
| `kaffa` | Kaffa (Caffa) | Crimea | city | 🪙 gold | 🌾 grain | Y | T2 | **Genoa** | Black Sea colony. **HV(3)**. Grain & slave trade. |

> **Note on the registry:** the line for `damascus` is deliberately marked *not used* — the Syrian
> interior is folded into `aleppo` and `cairo` to keep the Mamluk edge compact. **The board is 55 live
> land provinces** (every row above except the `damascus` placeholder). `buda` and `belgrade` are marked
> **R** for *river port* (Danube): they can build/berth fleets on the river but are **not** on any sea zone
> and cannot be reached by seagoing fleets.

### High-Value Nodes & Walled Cities (quick reference)

**Prestige / high-value cities:** `constantinople` HV(5); `venice`, `genoa`, `rome` HV(4);
`thessalonica`, `athens`, `trebizond`, `crete`, `cairo`, `alexandria`, `naples`, `kaffa` HV(3).

**Walled cities by tier (siege defense):**

| Tier | Cities |
|------|--------|
| **T5** | `constantinople` |
| **T4** | `belgrade`, `rome` |
| **T3** | `edirne`, `bursa`, `thessalonica`, `rhodes`, `trebizond`, `venice`, `genoa`, `buda`, `naples` |
| **T2** | `nicaea`, `athens`, `morea`, `serbia`, `cairo`, `alexandria`, `cyprus`, `gallipoli`, `negroponte`, `corfu`, `crete`, `ragusa`, `milan`, `sicily`, `kaffa` |
| **T1** | `pera`, `varna`, `bosnia`, `albania`, `modon`, `dalmatia`, `ankara`, `konya`, `sinope`, `smyrna`, `aleppo`, `antioch`, `chios`, `lesbos`, `lemnos`, `naxos`, `transylvania`, `tunis` |

*(Where the registry lists “—” for a province’s Walls, it is an open/rural province with no defensive tier.)*

---

## 4. Starting Ownership Summary

Must match `FACTIONS.md` exactly.

| Faction | Capital | Starting Provinces (IDs) | Count |
|---------|---------|--------------------------|-------|
| **Byzantium** | `constantinople` | `constantinople`, `selymbria`, `lemnos`, `thessalonica`, `morea` | 5 |
| **Ottomans** | `edirne` | `edirne`, `gallipoli`, `philippopolis`, `sofia`, `bithynia`, `bursa`, `nicaea` | 7 |
| **Venice** | `venice` | `venice`, `dalmatia`, `corfu`, `negroponte`, `crete`, `modon` | 6 |
| **Genoa** | `genoa` | `genoa`, `pera`, `chios`, `lesbos`, `kaffa` | 5 |
| **Hungary** | `buda` | `buda`, `belgrade`, `transylvania`, `croatia` | 4 |
| **Independent / Neutral** | — | all 28 remaining provinces (below) | 28 |

**The 28 Independent provinces** (expansion space): `varna`, `wallachia`, `serbia`, `bosnia`,
`albania`, `epirus`, `thessaly`, `athens`, `milan`, `rome`, `naples`, `sicily`, `tunis`, `ragusa`,
`ankara`, `konya`, `kastamonu`, `sinope`, `smyrna`, `antalya`, `trebizond`, `aleppo`, `antioch`,
`cairo`, `alexandria`, `cyprus`, `rhodes`, `naxos`.

---

## 5. NPC Minor States

Six named neutral powers hold clusters of the Independent provinces with standing **garrisons**.
Players may **conquer** a minor's provinces (a costly military operation vs. the garrison + any walls),
or **vassalize** the minor through diplomacy/tribute. A vassal pays its lord **income (gold/grain)** and
supplies **levies**, but is fragile: certain Omen cards can trigger a **vassal revolt** (see
`EVENT_CARDS.md` — *Wallachian Revolt*, *Serbian Despotate Submits*, *Anatolian Alliance*).

> The full **vassalage / tribute / revolt rules** live in `GAME_DESIGN.md` (owned by another worker),
> including the uniform vassal benefits (yields ×0.5 tribute + the levy call — `GAME_DESIGN.md` §11.5).
> This section only defines **which minors exist, what they hold, and their garrisons.**

| Minor State | Provinces held | Garrison (starting) | Flavor |
|-------------|----------------|---------------------|--------|
| **Despotate of Serbia** | `serbia` | 2 levies + 1 professional infantry, behind T2 walls (Smederevo) | Torn between Hungary and the Ottomans; silver of Novo Brdo. |
| **Voivodship of Wallachia** | `wallachia` | 2 levies + 1 light cavalry | Danube frontier; volatile, revolt-prone. |
| **Empire of Trebizond** | `trebizond` | 1 professional infantry + 1 war galley, behind T3 walls | Last Greek empire in the east; silk terminus, sea-reliant. |
| **Karaman League** | `ankara`, `konya` | 2 levies each (4 total) + 1 light cavalry | Anatolian beyliks; natural anti-Ottoman bloc. |
| **Knights of Rhodes (Hospitallers)** | `rhodes` | 2 professional infantry + 1 war galley, behind T3 walls | Crusader order; very hard to conquer, rarely vassalizes (Catholic only). |
| **Republic of Ragusa** | `ragusa` | 1 levy, behind T2 walls | Merchant city that buys its safety; the easiest vassal, pure gold. |

Remaining Independent provinces (e.g. `cairo`/`alexandria`/`aleppo`/`antioch` = **Mamluk Egypt**,
`athens` = **Duchy of Athens**, `naples`/`sicily` = **Aragon**, `rome` = **Papacy**, `tunis` = **Hafsids**)
are unaligned neutrals with a light garrison (1–2 levies, plus their listed walls) and are **not**
vassalizable minors in the base game — they are conquest targets or, for `rome`, a faith/diplomacy actor.

---

## 6. Land Adjacency

Land neighbors are bidirectional. **(strait)** marks a narrow-water crossing that armies may cross as
if adjacent (Bosphorus, Strait of Messina). Sea zones a province borders are listed for fleet access.

| Province | Land Neighbors | Sea Zones |
|----------|----------------|-----------|
| `constantinople` | `selymbria`, `pera`, `bithynia` (strait) | `bosphorus`, `sea-of-marmara` |
| `selymbria` | `constantinople`, `edirne` | `sea-of-marmara` |
| `pera` | `constantinople` | `bosphorus` |
| `edirne` | `selymbria`, `philippopolis`, `gallipoli`, `thessalonica` | — |
| `gallipoli` | `edirne` | `sea-of-marmara`, `aegean` |
| `philippopolis` | `edirne`, `sofia`, `varna` | — |
| `sofia` | `philippopolis`, `serbia`, `thessalonica` | — |
| `varna` | `philippopolis`, `wallachia` | `black-sea-west` |
| `wallachia` | `varna`, `serbia`, `transylvania`, `belgrade` | `black-sea-west` |
| `serbia` | `sofia`, `bosnia`, `belgrade`, `wallachia`, `albania` | — |
| `bosnia` | `serbia`, `croatia`, `dalmatia`, `ragusa`, `belgrade` | — |
| `albania` | `serbia`, `epirus`, `ragusa` | `ionian` |
| `epirus` | `albania`, `thessaly` | `ionian` |
| `thessaly` | `epirus`, `thessalonica`, `athens` | `aegean` |
| `thessalonica` | `edirne`, `sofia`, `thessaly` | `aegean` |
| `athens` | `thessaly`, `morea` | `aegean` |
| `morea` | `athens`, `modon` | `aegean`, `sea-of-crete`, `ionian` |
| `modon` | `morea` | `sea-of-crete`, `ionian` |
| `belgrade` | `buda`, `serbia`, `bosnia`, `wallachia` | — (Danube river) |
| `buda` | `belgrade`, `transylvania`, `croatia` | — (Danube river) |
| `transylvania` | `buda`, `wallachia` | — |
| `croatia` | `buda`, `dalmatia`, `bosnia` | — |
| `dalmatia` | `croatia`, `bosnia`, `ragusa` | `adriatic` |
| `ragusa` | `dalmatia`, `bosnia`, `albania` | `adriatic`, `ionian` |
| `venice` | `milan` | `adriatic` |
| `milan` | `venice`, `genoa`, `rome` | — |
| `genoa` | `milan`, `rome` | `tyrrhenian` |
| `rome` | `milan`, `genoa`, `naples` | `tyrrhenian` |
| `naples` | `rome`, `sicily` (strait) | `tyrrhenian`, `ionian` |
| `sicily` | `naples` (strait) | `tyrrhenian`, `sicilian-channel`, `ionian` |
| `tunis` | — (Maghreb off-map) | `sicilian-channel`, `eastern-mediterranean` |
| `bithynia` | `constantinople` (strait), `bursa`, `nicaea` | `bosphorus`, `sea-of-marmara` |
| `bursa` | `bithynia`, `nicaea`, `smyrna`, `ankara` | `sea-of-marmara` |
| `nicaea` | `bithynia`, `bursa`, `ankara` | — |
| `ankara` | `nicaea`, `bursa`, `konya`, `kastamonu` | — |
| `kastamonu` | `ankara`, `sinope` | `black-sea-east` |
| `sinope` | `kastamonu`, `trebizond` | `black-sea-east` |
| `trebizond` | `sinope` | `black-sea-east` |
| `konya` | `ankara`, `antalya`, `aleppo`, `smyrna` | — |
| `smyrna` | `bursa`, `konya` | `aegean` |
| `antalya` | `konya` | `eastern-mediterranean` |
| `aleppo` | `konya`, `antioch`, `cairo` | — |
| `antioch` | `aleppo` | `eastern-mediterranean` |
| `cairo` | `aleppo`, `alexandria` | — |
| `alexandria` | `cairo` | `eastern-mediterranean` |
| `cyprus` | — (island) | `eastern-mediterranean` |
| `rhodes` | — (island) | `sea-of-crete`, `eastern-mediterranean` |
| `chios` | — (island) | `aegean` |
| `lesbos` | — (island) | `aegean` |
| `lemnos` | — (island) | `aegean` |
| `negroponte` | — (island) | `aegean` |
| `naxos` | — (island) | `aegean`, `sea-of-crete` |
| `crete` | — (island) | `sea-of-crete` |
| `corfu` | — (island) | `ionian`, `adriatic` |
| `kaffa` | — (Crimean steppe off-map) | `black-sea-west`, `black-sea-east`, `sea-of-azov` |

---

## 7. Sea Zones (12)

Fleets move between adjacent sea zones and may enter/leave any bordering port province. War galleys
fight for control of a zone; a zone controlled by an enemy fleet is **blockaded** (trade gold through it
is denied, and ports on it cannot be reinforced by sea).

| Sea Zone | Connects To (zones) | Provinces Touched | Piracy / Blockade Notes |
|----------|---------------------|-------------------|-------------------------|
| `bosphorus` | `sea-of-marmara`, `black-sea-west` | `constantinople`, `pera`, `bithynia` | The chokepoint. Whoever holds `constantinople` **or** a fleet here can toll/close the strait between Aegean and Black Sea. |
| `sea-of-marmara` | `bosphorus`, `aegean` (via Dardanelles at `gallipoli`) | `constantinople`, `selymbria`, `gallipoli`, `bithynia`, `bursa` | `gallipoli` gates the Dardanelles; an enemy fleet + Gallipoli garrison can seal Marmara. |
| `aegean` | `sea-of-marmara`, `sea-of-crete` | `gallipoli`, `lemnos`, `lesbos`, `chios`, `smyrna`, `thessalonica`, `thessaly`, `athens`, `negroponte`, `naxos`, `morea` | The great trade sea; heavy Venetian/Genoese contest. Corsair-prone. |
| `sea-of-crete` | `aegean`, `eastern-mediterranean`, `ionian` | `crete`, `naxos`, `rhodes`, `morea`, `modon` | Rhodian galleys police it; Hospitaller sorties can clear corsairs. |
| `eastern-mediterranean` | `sea-of-crete`, `sicilian-channel` | `rhodes`, `cyprus`, `antioch`, `antalya`, `alexandria`, `tunis` | Spice & pilgrim routes; Mamluk & Hafsid corsairs. Mamluk embargo can raise tolls here. |
| `ionian` | `sea-of-crete`, `adriatic`, `sicilian-channel`, `tyrrhenian` | `corfu`, `epirus`, `albania`, `ragusa`, `modon`, `morea`, `naples`, `sicily` | The seam between Greece and Italy; Otranto gateway to the Adriatic. |
| `adriatic` | `ionian` | `venice`, `dalmatia`, `ragusa`, `corfu` | "The Gulf" — Venice claims it as a mare clausum; strong Venetian home water. |
| `tyrrhenian` | `ionian`, `sicilian-channel` | `genoa`, `rome`, `naples`, `sicily` | Genoese & Aragonese waters; Catalan corsairs. |
| `sicilian-channel` | `tyrrhenian`, `ionian`, `eastern-mediterranean` | `sicily`, `tunis` | Narrows between Sicily and Africa; the main Barbary corsair lane. |
| `black-sea-west` | `bosphorus`, `black-sea-east` | `varna`, `wallachia`, `kaffa` | Entered only via the Bosphorus — closing the strait strands western Black Sea trade. |
| `black-sea-east` | `black-sea-west`, `sea-of-azov` | `sinope`, `trebizond`, `kastamonu`, `kaffa` | Genoese/Trapezuntine grain & silk. Freezes in the *Hard Winter* event. |
| `sea-of-azov` | `black-sea-east` | `kaffa` | Shallow northern gulf; grain & slave markets. Dead-end zone; frozen in winter. |

**Genoa's lifeline:** from `genoa` (Tyrrhenian) the shortest fleet route to `kaffa` is the long chain
`tyrrhenian → ionian → sea-of-crete → aegean → sea-of-marmara → bosphorus → black-sea-west` (a southern
detour runs via the `sicilian-channel` and `eastern-mediterranean`). Every route east funnels through
`sea-of-crete → aegean → sea-of-marmara → bosphorus`, so any hostile blockade on that chain (especially
the Bosphorus) throttles the Black Sea colonies — the strategic tension at the heart of the Genoese position.

---

## 8. Straits & Special Crossings

- **Bosphorus** — `constantinople` ↔ `bithynia` (army crossing); also the sea link
  `black-sea-west ↔ bosphorus ↔ sea-of-marmara`. Holding `constantinople` lets its owner deny the
  crossing to enemies.
- **Dardanelles** — the `sea-of-marmara ↔ aegean` link, gated by `gallipoli`.
- **Strait of Messina** — `naples` ↔ `sicily` (army crossing).
- **Golden Horn** — `constantinople` ↔ `pera` (adjacent city faces; a besieged Pera can be relieved
  only if its owner holds the Bosphorus).

## 9. Design Notes

- **Connectivity:** Italy (`venice`/`milan`/`genoa`/`rome`/`naples`) reaches the East only by sea —
  reinforcing the maritime powers' reach and the land powers' (Ottoman/Hungary) continental focus.
- **Byzantine fragmentation:** the five Byzantine provinces are scattered — `constantinople` (Marmara),
  `thessalonica` (Macedonia, ringed by Ottoman land), `morea` (Peloponnese), `lemnos` (Aegean isle),
  `selymbria` (Thracian buffer). They are hard to defend as a bloc, by design.
- **Chokepoints for scoring:** `bosphorus`, `gallipoli`/Dardanelles, and `sicilian-channel` are the
  strategic valves of the trade map; several faction objectives and event cards target them.
- **Board size:** 55 land provinces + 12 sea zones. 27 provinces start owned by the five great powers;
  28 remain Independent (of which 7, in 6 named minor states, carry standing garrisons).
