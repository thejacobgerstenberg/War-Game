# The Guided First Game — Tutorial Script

### *IMPERIUM: Twilight of Empires* (1400–1453)

This file is a data-driven script for the guided first game. It is meant to be
implemented verbatim by the UI team. All player-facing copy follows
`lore/STYLE.md`; when this file and the style bible disagree, the bible wins.

## Format

Each step is one block with exactly six fields:

- **id** — stable kebab-case identifier, in play order.
- **trigger** — the semantic event, emitted by the rules engine, that opens the step
  (e.g. `game_start`, `first_income`, `siege_begun`). Steps arm in listed order: a
  step's trigger is only listened for once the previous step has completed.
- **highlight** — the semantic UI target the client spotlights while the step is open
  (e.g. `resource-bar`, `province:constantinople`, `action:recruit`, `track:prestige`).
- **speaker** — a semantic advisor slot (see below), never a hard-coded name.
- **copy** — one to three sentences of advisor counsel, shown in the step panel.
  This is the only player-facing string in each block.
- **completion** — the player action or condition that closes the step and advances
  the tutorial.

## Speaker convention

Speaker ids are semantic slots that the UI resolves to the playing faction's own
named advisors. This script's sample copy is written for a first game as
**Byzantium**, so the three Byzantine advisors are the voices used throughout:

| Slot | Domain | Resolves to (Byzantium, this script) |
|---|---|---|
| `advisor:coin` | Treasury, income, trade, the market, spycraft, diplomacy | Demetrios Choumnos, Grand Logothete |
| `advisor:war` | Levies, movement, battle, sieges, hired steel | Constantine Kontostephanos, Megas Doux |
| `advisor:faith` | Faith, events and fate, Prestige, objectives, the eras | Brother Athanasios of Vatopedi, Confessor of the Holy Mountain |

Other factions resolve the same slots to their own roster (see the advisor roster in
lore) and receive their own localized copy in a later pass; the step structure below
does not change per faction.

---

### step-01-the-chronicle-opens
- **id:** step-01-the-chronicle-opens
- **trigger:** game_start
- **highlight:** map:overview
- **speaker:** advisor:coin
- **copy:** "So the chronicle opens upon you, Majesty. Behind you stand eleven centuries of empire; before you lies a map that has grown smaller every year of my life. Look upon it while it is still ours to look upon."
- **completion:** player pans or zooms the map

### step-02-the-queen-of-cities
- **id:** step-02-the-queen-of-cities
- **trigger:** map_panned
- **highlight:** province:constantinople
- **speaker:** advisor:war
- **copy:** "There she is, Basileus — the City, the Queen of Cities, with the chain across her Horn and walls no host has ever paid the full price of. Select her, and see what an empire has come down to."
- **completion:** player selects Constantinople

### step-03-reading-a-province
- **id:** step-03-reading-a-province
- **trigger:** province_selected
- **highlight:** panel:province
- **speaker:** advisor:coin
- **copy:** "A province is a page in the ledger, Majesty: what it yields each season, who garrisons it, whose banner flies above it. Read the page before you spend blood on it."
- **completion:** player closes the province panel

### step-04-the-five-resources
- **id:** step-04-the-five-resources
- **trigger:** province_panel_closed
- **highlight:** resource-bar
- **speaker:** advisor:coin
- **copy:** "Five things keep an empire breathing: Gold, Grain, Timber, Marble, and Faith. Gold hires, Grain feeds, Timber builds and besieges, Marble glorifies, Faith sanctifies. I have watched all five run dry, and I do not recommend it."
- **completion:** player inspects the resource bar

### step-05-the-measure-of-renown
- **id:** step-05-the-measure-of-renown
- **trigger:** resource_bar_inspected
- **highlight:** track:prestige
- **speaker:** advisor:faith
- **copy:** "And beside those earthly stores stands Prestige, my son — the regard of the world, which no vault can hold. It is not a resource; it cannot be spent, only won or squandered. When the age ends, the prince who holds the most will be remembered, and the rest will be a line in another man's chronicle."
- **completion:** player selects the Prestige track

### step-06-first-income
- **id:** step-06-first-income
- **trigger:** first_income
- **highlight:** phase:income
- **speaker:** advisor:coin
- **copy:** "The harvest, Majesty: each province you hold pays its yield into the treasury — hyperpyra, grain, timber, and the rest. Coin first, glory after — glory is expensive."
- **completion:** player ends the income phase

### step-07-raising-the-levies
- **id:** step-07-raising-the-levies
- **trigger:** first_recruit
- **highlight:** action:recruit
- **speaker:** advisor:war
- **copy:** "Gold in the treasury is a promise, Basileus; levies in the field are a fact. Raise one levy at the City — the muster costs coin and grain, and it is the cheapest thing you will buy in this war."
- **completion:** player recruits one levy

### step-08-the-host-marches
- **id:** step-08-the-host-marches
- **trigger:** first_move
- **highlight:** action:move
- **speaker:** advisor:war
- **copy:** "A host that sits is a host that only eats. Select your levies and march them into a neighboring province — one march by land each turn, farther by sea, if the years had left me galleys enough to carry them."
- **completion:** player moves a host into an adjacent province

### step-09-first-blood
- **id:** step-09-first-blood
- **trigger:** first_combat
- **highlight:** panel:combat
- **speaker:** advisor:war
- **copy:** "Rebel levies bar the road in the Morea. March into their province and you offer battle; the panel weighs your strength against theirs before a single spear is lowered. Read the odds the way a sailor reads weather — then decide whether you like them."
- **completion:** player confirms the attack

### step-10-the-reckoning
- **id:** step-10-the-reckoning
- **trigger:** combat_resolved
- **highlight:** panel:combat-result
- **speaker:** advisor:war
- **copy:** "There is the reckoning: their losses, yours, and who holds the ground. A victory that empties your host is a second kind of defeat — count what the field cost before you boast of it."
- **completion:** player closes the combat result panel

### step-11-stone-and-patience
- **id:** step-11-stone-and-patience
- **trigger:** siege_available
- **highlight:** action:lay-siege
- **speaker:** advisor:war
- **copy:** "The Morea has shut her gates, Basileus — the beaten remnant sits behind the Hexamilion, six miles of old stone across the Isthmus, and old stone still stops young men. You will not carry walls with courage alone. Lay siege, and let hunger do what spears cannot."
- **completion:** player lays siege in the Morea

### step-12-the-siege-tightens
- **id:** step-12-the-siege-tightens
- **trigger:** siege_begun
- **highlight:** province:morea
- **speaker:** advisor:war
- **copy:** "The siege is laid, and each turn it tightens. Timber builds your engines; grain keeps your own men from starving before theirs do; patience does the rest. Hold the lines through the turn, and the gates will come to you."
- **completion:** player ends the turn with the siege maintained

### step-13-the-hand-that-deals
- **id:** step-13-the-hand-that-deals
- **trigger:** omen_revealed
- **highlight:** deck:omens
- **speaker:** advisor:faith
- **copy:** "The Omen deck, my son: plague, storm, a prince dead without an heir. Each round one omen is drawn, and it falls upon every realm at the table — no crown is exempt. Men call it chance; I call it the hand of God turning the page."
- **completion:** player resolves the omen

### step-14-stratagems-in-hand
- **id:** step-14-stratagems-in-hand
- **trigger:** tactic_card_drawn
- **highlight:** action:play-card
- **speaker:** advisor:war
- **copy:** "Some battles are won before the first spear is lowered, Basileus. Cards of stratagem come to your hand — a night march, a false ford, a bought captain — and the Play Card action spends them at the hour of your choosing. Guard your hand: one card alone, The Intercepted Letter, can cancel a rival's stratagem as it is played."
- **completion:** player plays one card from the hand

### step-15-the-counting-house
- **id:** step-15-the-counting-house
- **trigger:** trade_route_available
- **highlight:** action:trade
- **speaker:** advisor:coin
- **copy:** "Trade, Majesty — the one harvest that ripens in every season. Open a route from your port and the counting-house returns Gold each turn. Venice and Genoa grew fat on this while we grew principled, and principles garrison nothing."
- **completion:** player establishes one trade route

### step-16-hired-steel
- **id:** step-16-hired-steel
- **trigger:** market_opened
- **highlight:** market:mercenaries
- **speaker:** advisor:coin
- **copy:** "The mercenary market: companies of hired steel, honestly priced — which is more than one can say of most honest men. When the treasury is fuller than the muster rolls, hire; a company costs Gold for every turn it serves."
- **completion:** player hires one mercenary company

### step-17-the-price-of-loyalty
- **id:** step-17-the-price-of-loyalty
- **trigger:** mercenary_hired
- **highlight:** market:mercenaries
- **speaker:** advisor:war
- **copy:** "Hired steel fights for the paymaster, Basileus, not for the City. Pay them on the day and they are as good as any levy; let the treasury run dry and you will learn what they are instead."
- **completion:** player dismisses the counsel

### step-18-a-ledger-of-secrets
- **id:** step-18-a-ledger-of-secrets
- **trigger:** spy_available
- **highlight:** action:spy
- **speaker:** advisor:coin
- **copy:** "I keep two ledgers, Majesty: one of coin, one of secrets. Send an agent to a rival court and choose his errand — read the coming omen before God turns the page, unseal one rival's hidden ambition, or stir a province to unrest so it yields its master nothing. It is cheaper than a war and far quieter than a truce."
- **completion:** player dispatches one spy on any of the three missions

### step-19-the-whisper-returns
- **id:** step-19-the-whisper-returns
- **trigger:** spy_report_delivered
- **highlight:** panel:spy-report
- **speaker:** advisor:coin
- **copy:** "The whisper has come home; read it slowly. And remember that every court on this map keeps a man like mine — assume you are read in turn, and move accordingly."
- **completion:** player closes the spy report

### step-20-the-coin-of-heaven
- **id:** step-20-the-coin-of-heaven
- **trigger:** build_available
- **highlight:** action:build
- **speaker:** advisor:faith
- **copy:** "Faith is not coin, my son, and yet the world exchanges it. Build a church — in other lands they raise a mosque — and your Faith will rise, and with it the people's patience for your wars. An emperor the Church will not bless is only a soldier with a larger tent."
- **completion:** player builds a church or mosque

### step-21-renown-and-the-chronicle
- **id:** step-21-renown-and-the-chronicle
- **trigger:** prestige_gained
- **highlight:** track:prestige
- **speaker:** advisor:faith
- **copy:** "You have won Prestige, and the scribes have noticed. Victories, wonders, crowned heads humbled — all of it feeds your renown; defeats and broken oaths bleed it away. When the age closes, this track alone divides the remembered from the forgotten."
- **completion:** player dismisses the counsel

### step-22-the-sealed-ambitions
- **id:** step-22-the-sealed-ambitions
- **trigger:** objectives_revealed
- **highlight:** panel:objectives
- **speaker:** advisor:faith
- **copy:** "Here are your sealed ambitions — three objectives known to you alone, each worth Prestige if it is fulfilled before the age closes. Every prince at the table carries three of his own. Confess them to no man; God knows them already, and that is audience enough."
- **completion:** player reviews all three objectives and closes the panel

### step-23-the-shape-of-the-age
- **id:** step-23-the-shape-of-the-age
- **trigger:** era_change
- **highlight:** track:eras
- **speaker:** advisor:faith
- **copy:** "The age turns, my son, and the chronicle begins a darker chapter. The first era is small quarrels; the second brings the great crises; the third asks whether the empire is to exist at all. Every road on this map runs toward 1453 and the walls of the City — pray you will have written enough by then."
- **completion:** player dismisses the era panel

### step-24-parchment-and-wax
- **id:** step-24-parchment-and-wax
- **trigger:** diplomacy_available
- **highlight:** panel:diplomacy
- **speaker:** advisor:coin
- **copy:** "Not every quarrel wants a host, Majesty. Offer a pact, buy a truce, or bend a lesser prince into a vassal — parchment holds provinces that spears cannot reach. But remember: every seal is only wax, and wax melts."
- **completion:** player proposes a pact or truce

### step-25-the-chronicle-is-yours
- **id:** step-25-the-chronicle-is-yours
- **trigger:** tutorial_complete
- **highlight:** map:overview
- **speaker:** advisor:faith
- **copy:** "The lesson ends, my son; the age does not. Fifty-three years lie between this morning and the last one, and every year is yours to spend. Go and write your page — the scribes are watching, and so is God."
- **completion:** player begins the next turn unguided
