# IMPERIUM: Twilight of Empires — EVENT CARDS (The Omen Deck)

Each **round** (each round spans **3–4 years** of the 1400 → 1453 timeline — 16 rounds in all,
`GAME_DESIGN.md` §10), before players act, the game runs the **Omen Phase**: the active omen deck is
drawn from and the card resolves. Events reshape the map through the systems in `MAP.md` and `FACTIONS.md`
— resources, units, wall tiers, prestige, sea-zone blockades, crusades, loans and vassals.

Every card is tagged: **Good** (blessing), **Ill** (calamity), **Mixed** (a choice / cuts both ways),
or **Omen** (map-wide morale). Faction-specific cards name their target in the flavor line. Effects that
touch **vassals/minor states** cross-reference `MAP.md §5`; the full vassalage rules live in `GAME_DESIGN.md`.

Every card also carries a stable **`slug`** (kebab-case, unique) — the join key to its flavor text in
`lore/events/flavor.md` (PR #3). Where a card's concept matches a lore entry, the lore slug is adopted
verbatim; cards and lore slugs that do not yet line up are listed in the **Unreconciled** section at the
bottom of this file. Slugs are **namespaced per deck** — the omen (event) deck and the tactic deck
(`GAME_DESIGN.md` §7.7) are separate namespaces, so the same slug may legally appear in both
(e.g. `papal-indulgence`).

---

## Omen Deck Structure — three escalating eras

The deck is **not** one pile. It is split into **three era decks**, each shuffled separately, so the
mood of the game darkens as 1453 approaches. At the start of each round the game draws from the deck
matching the current era:

| Era | Rounds | Theme | Deck |
|-----|--------|-------|------|
| **Era I — Omens of Peace** | 1–5 | Economy & minor politics; harvests, trade, dynastic games, early Ottoman troubles | 16 cards |
| **Era II — Omens of War** | 6–10 | Wars & crises; crusades, schisms, revolts, sieges, embargoes | 17 cards |
| **Era III — Omens of the End** | 11–16 | Existential events; the Great Bombard, plague waves, the last crusade, the Fall | 13 cards |

**Draw rules**
- **One card** is drawn and resolved per round from the current era's deck, regardless of player count;
  with 4–5 players the *next* card is additionally revealed as a telegraphed "gathering omen"
  (`GAME_DESIGN.md` §12).
- Cards resolve immediately unless marked **Persistent** (a lasting modifier). *(A third duration,
  **Grant** — a card added to the drawer's hand — is defined in `GAME_DESIGN.md` §12; the base deck
  currently contains none.)*
- When an era deck empties, reshuffle its discards; on entering the next era, retire the previous deck.
- **Balance shifts by era:** Era I skews toward blessings (8 Good / 5 Ill / 3 Mixed–Omen), Era II is
  dominated by calamity (3 Good / 12 Ill / 2 Mixed), and Era III evens out again (4 Good / 5 Ill /
  4 Mixed–Omen) — the mood darkens sharply in the war years, and Era III's calamities are far heavier
  than Era I's.
- **Faction-specific cards** with no valid target in the current game (e.g. an Ottoman card in a
  Byzantium-vs-Venice duel) are treated as **neutral** minor events (redraw or apply the generic clause noted
  on the card).

---

## Era I — Omens of Peace (rounds 1–5) · 16 cards

| # | Card | Slug | Type | Historical flavor & trigger | Mechanical effect |
|---|------|------|------|------------------------------|-------------------|
| 1 | **Bumper Harvest** | `good-harvest` | Good | A golden year across the granaries. | This round every `plains` and grain-primary province produces **+1 🌾**; grain sells favorably (each 🌾 converted to 🪙 yields +1). |
| 2 | **Hard Winter** | `famine-winter` | Ill | The hardest winter in living memory. | This round: all armies pay **+1 🌾 upkeep** (attrition — any shortfall removes units per the starvation rule, `GAME_DESIGN.md` §4.4); **land movement −1**; **sieges make no progress**; `black-sea-west`, `black-sea-east` and `sea-of-azov` **freeze** (no fleet movement). |
| 3 | **Silk Road Caravan** | `silk-road-caravan` | Good | The great caravan reaches the sea. | Each controller of `trebizond`, `bursa`, `aleppo`, or `kaffa` gains **+3 🪙** this round. |
| 4 | **Papal Indulgence** | `papal-indulgence` | Good (faith) | Rome grants remission of sins for coin. | Any faction holding a faith-yielding province may convert up to **3 ✝️ → 3 🪙** this round. Hungary/Byzantium may instead spend that faith to raise **1 free levy**. |
| 5 | **Imperial Coronation** | `imperial-coronation` | Good (prestige) | A sovereign is crowned, a sultan girded with the sword. | Drawing faction: **+2 prestige**, a one-time **+2 🪙**, and its levies fight at **+1 morale** for 1 round. |
| 6 | **Comet Omen** | `comet-omen` | Omen | A blazing star troubles the heavens. | Superstition grips all armies: this round every levy fights at **−1 morale**, **except** the drawing faction's levies (**+1**, they read the sign as favorable). |
| 7 | **Ottoman Interregnum (Fetret Devri)** | `ottoman-interregnum` | Ill *(Ottoman)* | The sons of Bayezid turn on one another. *Trigger: Ottoman in play.* | Ottoman may **not recruit next round**; loses one Anatolian (`bithynia`/`nicaea`/`bursa`) **and** one European (`sofia`/`philippopolis`) province to Independent; **−2 prestige**. Adjacent players may seize the freed provinces. |
| 8 | **Timurid Shadow** | `timur-shadow` | Ill *(Ottoman)* | The long shadow of Ankara still falls on Anatolia. | The beyliks `ankara`, `konya`, `kastamonu` each gain **+1 levy** and turn hostile to the Ottoman; one Ottoman Anatolian province adjacent to a beylik is raided: **−2 🪙**, yields **0 next round**. |
| 9 | **Discovery of Alum** | `discovery-of-alum` | Good *(Genoa/trade)* | Rich alum found at Phocaea and Chios. | The controller of `chios` gains a **permanent +2 🪙/round** (dye-trade monopoly) for the rest of the game — whoever holds `chios`, now and later. **Persistent.** |
| 10 | **Marriage Alliance** | `marriage-alliance` | Good (diplomacy) | A dynastic wedding binds two courts. | Drawing faction may form a **2-round non-aggression pact** with a consenting player and take **3 🪙 dowry**; *or* vassalize an eligible minor (`serbia`/`ragusa`/`trebizond`) at **−50% tribute cost**. |
| 11 | **Corsair Raid** | `corsair-raid` | Ill | Barbary galliots slip out of Tunis. | A coastal province on the `sicilian-channel`/`eastern-mediterranean`/`aegean` shore loses **2 🪙** and one merchant galley (if present); that sea zone is **corsair-blockaded** (trade −1 🪙) until a war galley clears it. |
| 12 | **Serbian Despotate Submits** | `serbian-despotate-submits` | Mixed *(vassal)* | Đurađ Branković bends to the stronger neighbour. | `serbia` becomes a **vassal** of whichever of Hungary/Ottoman is adjacent and stronger (standard vassal benefits — `GAME_DESIGN.md` §11.5). If neither qualifies, `serbia` stays Independent and its garrison **+1**. *(See `MAP.md §5`.)* |
| 13 | **Ragusan Tribute** | `ragusan-tribute` | Good *(vassal)* | Ragusa buys its peace, as it always has. | `ragusa` offers tribute to the strongest adjacent naval power (Venice by default): that power gains **+3 🪙** this round and may take `ragusa` as a **tribute-vassal without a siege**. |
| 14 | **Plague of Locusts** | `plague-of-locusts` | Ill | A black cloud devours the fields. | Choose a region (**Anatolia** or **the Balkans**): every `plains` province there produces **−2 🌾** this round. |
| 15 | **Hussite Handgunners for Hire** | `hussite-mercenaries` | Good (merc) | Bohemian gunners and their wagon-forts seek employ. | Any faction may hire, for 🪙, one **mercenary Handgunner** unit (gunpowder infantry; +defense in a wagon-fort). This round the Genoese Crossbowmen market is undercut — **Genoa earns no brokerage**. |
| 16 | **Fall of a Beylik** | `fall-of-a-beylik` | Mixed *(minor)* | An Anatolian emirate collapses into feud. | Choose `smyrna`, `antalya`, or `kastamonu`: this round its garrison is **−1** (ripe for conquest), **or** its garrison disbands entirely, leaving the province open to **unopposed occupation** by an adjacent power *(these beyliks are not vassalizable minors — `MAP.md` §5)*. |

## Era II — Omens of War (rounds 6–10) · 17 cards

| # | Card | Slug | Type | Historical flavor & trigger | Mechanical effect |
|---|------|------|------|------------------------------|-------------------|
| 17 | **Council of Florence (Union of Churches)** | `council-of-florence` | Mixed *(Byzantium)* | 1439 — East and West proclaim one Church. | **Byzantium chooses.** *Accept Union:* gain Western aid (hire **Crusader levies** from a consenting Catholic player; +1 prestige with Hungary/Venice/Genoa) but the Orthodox populace revolts — **−2 ✝️/round for 2 rounds, −1 prestige**. *Refuse:* keep faith income and fulfil the objective *Faith of the Fathers*. |
| 18 | **Venetian–Genoese War** | `genoese-venetian-war` | Ill *(Venice & Genoa)* | The old rivalry flares from Chios to the Golden Horn. | For **2 rounds**, in any sea zone Venice and Genoa both occupy, their fleets **must fight**; each loses **−2 🪙 trade/round**. All non-maritime factions gain **+1 🪙** as trade reroutes. Ended early by card #43 *Peace of Turin*. **Persistent.** |
| 19 | **Hunyadi's Long Campaign** | `long-campaign` | Good *(Hungary)* | 1443 — the White Knight drives deep into the Balkans. | This round Hungarian land units fight at **+1** and may make **one extra move/attack** into a Balkan province; Hungary may rally `serbia` and `wallachia` as **temporary allies** for the campaign. |
| 20 | **Varna Crusade** | `varna-crusade` | Mixed | 1444 — the crusading host marches to the Black Sea. | Christian factions may commit units to a Crusader army at `varna`/`belgrade` and fight the Ottoman. **Crusade wins:** joiners split **+3 prestige** and may take `varna`/`sofia`. **Ottoman wins (Battle of Varna):** Ottoman **+3 prestige**, the crusading commander falls — Hungary loses its **Black Army** unit if present. |
| 21 | **Fall of Thessalonica** | `fall-of-thessalonica` | Ill *(holder of `thessalonica`)* | 1430 — the great city of Macedonia is stormed. *Trigger: an Ottoman army adjacent to `thessalonica`.* | `thessalonica` is assaulted: **wall tier −1**, garrison **−1**; an adjacent Ottoman may capture it at **−50% siege cost** this round. If Venice holds it, Venice loses **3 🪙**. |
| 22 | **Mercenary Revolt** | `mercenary-revolt` | Ill | "No pay, no peace." | Any faction that cannot cover its mercenaries' **🌾 grain upkeep** or its Janissary / Black Army **🪙 pay** this round: those units **desert** (removed) and **pillage** their province (**−2 🪙**, yield **0 next round**). |
| 23 | **Janissary Discontent** | `janissary-discontent` | Ill *(Ottoman)* | The Janissaries overturn their kettles and demand a donative. | Ottoman pays a **3 🪙 donative** this round, or every Janissary fights at **−1** and may **not assault walls next round**. |
| 24 | **Wallachian Revolt** | `wallachian-revolt` | Ill *(vassal)* | The voivode raises the country against his overlord. *Trigger: `wallachia` is a vassal.* | `wallachia` breaks free → becomes Independent, spawns **2 levy + 1 light cavalry**, and raids one adjacent province of its **former lord** (**−2 🪙**, yield **0 next round**). |
| 25 | **Earthquake** | `walls-earthquake` | Ill | The earth heaves; towers crack and fall. | Choose (or randomize among `constantinople`/`gallipoli`/`rhodes`/`thessalonica`) one walled city: **wall tier −1**, repairable later with 🪨 marble. *(As the quake that once gave Gallipoli to the Ottomans.)* |
| 26 | **The Grain Fleet Is Lost** | `grain-fleet-lost` | Ill | A storm — or a corsair — takes the grain convoy. | Target a coastal faction (or `constantinople`): it loses **3 🌾** and one **merchant galley**. If it cannot, a levy **starves** (removed). |
| 27 | **Fire of the Arsenal** | `fire-of-the-arsenal` | Ill *(Venice/Genoa)* | Fire races through the shipyards. | The targeted maritime power **cannot build fleets for 1 round**, loses one galley berthed in its capital's port or sea zone (if any), and **−2 🪵**. |
| 28 | **Papal Interdict** | `papal-interdict` | Ill *(political/faith)* | Rome lays a faction under interdict. *Trigger: the faction that last attacked a fellow Christian.* | Target loses **all ✝️ income for 2 rounds**, **cannot call a Crusade**, and Christian neutrals resist it (**−25%** to its diplomacy/sieges vs Christian neutrals). |
| 29 | **Schism** | `schism` | Ill *(faith)* | Rival popes; a Church divided against itself. | **All ✝️ income halved next round.** Faith-reliant factions (Byzantium, Hungary, holder of `rome`) each lose **1 prestige**. |
| 30 | **Mamluk Embargo** | `mamluk-embargo` | Ill *(trade)* | Cairo shuts the spice road and raises the tariff. | Trade through `eastern-mediterranean` costs **+1 🪙** and yields **−1** this round; Venice and Genoa each lose **2 🪙**. A Mamluk force may threaten `cyprus`. |
| 31 | **Anatolian Alliance** | `anatolian-alliance` | Ill *(Ottoman / minor)* | Karaman and the beyliks league against the Porte. *Trigger: Karaman League (`ankara`/`konya`) unconquered.* | The beyliks gain **+1 levy each** and launch a coordinated attack on one Ottoman Anatolian province (`bithynia`/`bursa`/`nicaea`); the Ottoman fights at **−1** there this round. |
| 32 | **Hexamilion Rebuilt at Corinth** | `hexamilion-wall` | Good *(holder of `morea`)* | The wall across the Isthmus rises again. | The controller of `morea` may spend 🪨 marble to fortify: `morea` gains **+1 wall tier** and **+1 defense vs any land attack from `athens`** for the rest of the game (until breached by a bombard). **Persistent.** |
| 33 | **Knights of Rhodes Sortie** | `knights-of-rhodes-sortie` | Good *(defensive)* | The Hospitaller galleys ride out of Rhodes. *Trigger: `rhodes` held by the Knights or a Catholic player.* | Their galleys sweep `sea-of-crete` and `eastern-mediterranean` clear of corsairs and damage one enemy/Mamluk fleet there (it **loses 1 naval unit**). **Blocks the next corsair/piracy raid** (`GAME_DESIGN.md` §5.3). |

## Era III — Omens of the End (rounds 11–16) · 13 cards

| # | Card | Slug | Type | Historical flavor & trigger | Mechanical effect |
|---|------|------|------|------------------------------|-------------------|
| 34 | **The Great Bombard Forged** | `great-bombard-forged` | Good *(Ottoman)* | Orban casts the monster cannon before the walls. | The **Great Bombard** enters play **at no cost** in the recipient's capital (or any owned `CITY`), per `GAME_DESIGN.md` §8.4: the **Ottoman** receives it if in play; otherwise the founder Orban **auctions it to the highest bidder** (🪙+🪨 marble bids). It rolls **double wall-damage dice** — up to 6 Wall HP/round, `GAME_DESIGN.md` §8.2 — enough to batter even the Tier-5 Theodosian Walls. One per game; it can **never be recruited or built**. **Persistent.** |
| 35 | **Black Death Returns** | `black-death-returns` | Ill | Pestilence rides the trade roads once more. | For **2 rounds**, every `city` and high-value (`HV`) province produces **−1 🌾 and −1 🪙**; each faction **destroys 1 levy/infantry per 3 such units** it fields (densest provinces first). |
| 36 | **Gunpowder Revolution** | `gunpowder-revolution` | Mixed *(tech)* | The age of the cannon dawns for all. | For the rest of the game, **bombards & handgunners cost −1** and gain **+1 siege**, but old-style **stone walls defend at −1 tier** against them. Favors attackers everywhere. **Persistent.** |
| 37 | **The Final Crusade** | `final-crusade` | Mixed | Christendom's last appeal before the City falls. | All Christian factions may pool units into a grand Crusade targeting any Ottoman-held city. Success: **+4 prestige** to joiners and the city changes hands. Failure or non-participation: each abstaining Christian faction **−1 prestige** (the West stood idle). |
| 38 | **Pilgrimage / Jubilee Year** | `pilgrim-season` | Good *(faith)* | 1450 — the Holy Year fills Rome with pilgrims. | Controller of `rome` gains **+3 🪙 and +2 ✝️**; every Christian faction gains **+1 ✝️** this round. |
| 39 | **Relic Discovered** | `relics-of-the-saints` | Good *(faith)* | A saint's relic is unearthed; pilgrims flock. | Choose a faith-yielding province you hold (`constantinople`/`thessalonica`/`rome`/`morea`/`nicaea`): **+2 ✝️** now and **+1 🪙 pilgrimage/round** for the rest of the game; **+1 prestige**. **Persistent.** |
| 40 | **Drought** | `drought` | Ill | The rains fail; the Nile runs low. | This round all `plains` provinces produce **−1 🌾**; `alexandria` and `cairo` produce **−2 🌾** (a low Nile). |
| 41 | **Financial Crisis (Bank Run)** | `financial-crisis` | Ill *(economy)* | Credit collapses; the great banks close their doors. | **Genoese loans are frozen** (none may be taken or called this round); every faction carrying debt pays a **1 🪙 penalty**; any faction hoarding **> 20 🪙** is taxed **−2 🪙**. |
| 42 | **Byzantine Civil War** | `byzantine-civil-war` | Ill *(Byzantium)* | A Palaiologos pretender raises his standard. *Trigger: Byzantium in play.* | Byzantium loses one province (`thessalonica`/`morea`/`selymbria`) to a pretender — it becomes **Independent** — unless Byzantium pays **4 🪙** to buy off the claimant this round. |
| 43 | **Peace of Turin** | `peace-of-turin` | Good *(if at war)* | The maritime republics are brought to terms. | Immediately **ends the *Venetian–Genoese War*** (card #18): both regain full trade income and each gains **+1 🪙** as commerce resumes. If they are not at war, both simply gain **+1 🪙**. |
| 44 | **The Great Comet of 1453** | `omen-in-the-sky` | Omen | A vast comet hangs over the doomed City — an omen of the end. | Map-wide dread: this round **every faction's levies and merc morale −1**, and **all sieges gain +1** (defenders and attackers alike fight to exhaustion). The lowest-prestige faction gains **+1 prestige** (rallying to the sign). |
| 45 | **Genoese Loan Called In** | `bank-of-saint-george` | Ill *(targeted / Genoa)* | The Bank of St George presents its final account. | Genoa names a debtor: it pays Genoa **4 🪙** or cedes a province / **1 prestige** to Genoa. If none are in debt, Genoa collects **+2 🪙** interest. |
| 46 | **The Fall of Constantinople ("1453")** | `fall-of-constantinople` | Mixed *(endgame)* | The Ottoman guns speak; an age ends. *Trigger: round 16, or whenever `constantinople` is besieged in Era III.* | Resolves the game's climax. If `constantinople` is **still Byzantine at round 16**, Byzantium gains **+5 prestige** (the City endured — history defied) and fulfils *Queen of Cities*. If it **has fallen to the Ottoman**, the Ottoman gains **+5 prestige** and *Fetih* is scored. Triggers the **sudden-death** check (hold `constantinople` two rounds to win outright). |

---

## Quick Index by Type

- **Good (blessings):** Bumper Harvest, Silk Road Caravan, Papal Indulgence, Imperial Coronation,
  Discovery of Alum, Marriage Alliance, Ragusan Tribute, Hussite Handgunners, Hunyadi's Long Campaign,
  Hexamilion Rebuilt, Knights of Rhodes Sortie, The Great Bombard Forged *(Ottoman)*, Pilgrimage/Jubilee,
  Relic Discovered, Peace of Turin.
- **Ill (calamities):** Hard Winter, Ottoman Interregnum, Timurid Shadow, Corsair Raid, Plague of Locusts,
  Venetian–Genoese War, Fall of Thessalonica, Mercenary Revolt, Janissary Discontent, Wallachian Revolt,
  Earthquake, The Grain Fleet Is Lost, Fire of the Arsenal, Papal Interdict, Schism, Mamluk Embargo,
  Anatolian Alliance, Black Death Returns, Drought, Financial Crisis, Byzantine Civil War, Genoese Loan Called In.
- **Mixed / Omen:** Comet Omen, Serbian Despotate Submits, Fall of a Beylik, Council of Florence,
  Varna Crusade, Gunpowder Revolution, The Final Crusade, The Great Comet of 1453, The Fall of Constantinople.

## Faction-Specific Cards (need a valid target, else treated as neutral)

- **Ottoman:** Ottoman Interregnum, Timurid Shadow, Janissary Discontent, Anatolian Alliance, The Great Bombard Forged.
- **Byzantium:** Council of Florence, Fall of Thessalonica *(holder)*, Byzantine Civil War.
- **Venice / Genoa:** Discovery of Alum, Venetian–Genoese War, Fire of the Arsenal, Mamluk Embargo, Peace of Turin, Genoese Loan Called In, Ragusan Tribute.
- **Hungary:** Hunyadi's Long Campaign, Varna Crusade, The Final Crusade *(Christian bloc)*.

**Total: 46 event cards** across three escalating era decks (16 / 17 / 13).

---

## Unreconciled with lore/events/flavor.md (PR #3)

The lore file (`feature/narrative` @ `d6e21d6`) defines **50 flavor slugs**; this deck has **46 cards**.
**20 cards adopt a lore slug verbatim** (same historical event/concept). The remaining gaps, both
directions, are listed here so they can be routed — either by writing new flavor, cutting a lore slug,
or designing a new card.

### (a) Cards with no matching lore slug (slug invented in this doc)

| # | Card | Invented slug | Nearest lore slug (why it was NOT adopted) |
|---|------|---------------|--------------------------------------------|
| 4 | Papal Indulgence | `papal-indulgence` | `papal-envoy` — a legate demanding returns for Rome, not a sale of indulgences to players; concepts differ. |
| 5 | Imperial Coronation | `imperial-coronation` | — |
| 6 | Comet Omen | `comet-omen` | `omen-in-the-sky` is the Era III doom-portent over the City and is adopted by card #44; this Era I generic comet is a different event. |
| 7 | Ottoman Interregnum (Fetret Devri) | `ottoman-interregnum` | — |
| 9 | Discovery of Alum | `discovery-of-alum` | — |
| 10 | Marriage Alliance | `marriage-alliance` | — |
| 11 | Corsair Raid | `corsair-raid` | — |
| 12 | Serbian Despotate Submits | `serbian-despotate-submits` | — |
| 13 | Ragusan Tribute | `ragusan-tribute` | — |
| 14 | Plague of Locusts | `plague-of-locusts` | `plague-in-the-ports` is human pestilence via shipping, not a locust crop-blight. |
| 16 | Fall of a Beylik | `fall-of-a-beylik` | — |
| 23 | Janissary Discontent | `janissary-discontent` | `janissary-recruitment` is the devshirme (raising the corps), not a pay revolt. |
| 24 | Wallachian Revolt | `wallachian-revolt` | — |
| 26 | The Grain Fleet Is Lost | `grain-fleet-lost` | `corn-blockade` is a deliberate blockade at the straits; this card is loss at sea to storm/corsair. |
| 27 | Fire of the Arsenal | `fire-of-the-arsenal` | `venetian-galley-launched` is the opposite event (a launch, not a fire). |
| 28 | Papal Interdict | `papal-interdict` | — |
| 29 | Schism | `schism` | — |
| 30 | Mamluk Embargo | `mamluk-embargo` | — |
| 31 | Anatolian Alliance | `anatolian-alliance` | — |
| 33 | Knights of Rhodes Sortie | `knights-of-rhodes-sortie` | — |
| 36 | Gunpowder Revolution | `gunpowder-revolution` | — |
| 37 | The Final Crusade | `final-crusade` | `no-relief-from-the-west` / `relief-fleet-fails` depict aid that never comes; this card is a crusade that can actually march. |
| 40 | Drought | `drought` | — |
| 41 | Financial Crisis (Bank Run) | `financial-crisis` | `the-empty-treasury` is one state's insolvency, not a general credit collapse. |
| 42 | Byzantine Civil War | `byzantine-civil-war` | `despotate-of-morea` is the brothers' misrule in Mistra, not a pretender's civil war (close — marshal may choose to merge). |
| 43 | Peace of Turin | `peace-of-turin` | — |

### (b) Lore slugs with no matching card

**Era I (9):** `plague-in-the-ports`, `papal-envoy`, `janissary-recruitment`, `guild-charter`,
`venetian-galley-launched`, `akce-debasement`, `salt-tax-riot` *(invented)*, `monastery-tithe`
*(invented)*, `condottiere-contract` *(invented)*.

**Era II (8):** `battle-of-varna` *(folded into card #20's "Ottoman wins" branch — no dedicated card)*,
`treaty-of-szeged`, `second-kosovo`, `union-riots` *(related to card #17's Union-backlash clause but a
distinct 1452 event)*, `despotate-of-morea` *(nearest: card #42)*, `venetian-monopoly`, `corn-blockade`
*(nearest: card #26)*, `spies-in-the-camp` *(invented)*.

**Era III (13):** `rumeli-hisari`, `chain-across-the-horn`, `ships-over-land`, `final-siege`,
`giustiniani-wounded`, `relief-fleet-fails`, `kerkoporta`, `hagia-sophia-vigil`,
`no-relief-from-the-west`, `last-emperor`, `desertion-in-the-night`, `sack-of-the-city`,
`the-empty-treasury` *(invented; nearest: card #41)*. Most of these are fine-grained beats of the 1453
siege that this deck compresses into card #46 *The Fall of Constantinople* — routing them likely means
either new Era III cards or attaching them as sub-flavor to #46.
