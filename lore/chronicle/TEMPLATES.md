# The Chronicle — Recap Templates

*IMPERIUM: Twilight of Empires* (1400–1453). When a match ends, the Chronicle stitches
a "history book" from what actually happened at the table. It does this by drawing on
short sentence **templates**, each holding `{placeholders}` in braces —
`{faction}`, `{rival}`, `{province}`, `{city}`, `{round}`, `{ruler}`, and the rest.

At recap time the engine walks the match log, matches each notable moment to an event
below, fills the braces from that moment's data, and picks **one** of the three phrasing
variants. Stringing several filled lines together — a war declared, a city fallen, a
betrayal, a final reckoning — yields one continuous chronicle in a single voice.

**Rules for anyone adding lines here:**
- Every event keeps **exactly three** variants, so no two recaps read the same.
- Keep the register of an illuminated chronicle: vivid, a little wry, short lines,
  readable at a glance. Period texture is welcome; fake-archaic spelling is not.
- Spell numbers as words in prose. Braces such as `{round}` and `{prestige}` fill with
  counters and are the one place a numeral may appear.
- Full placeholder list is at the foot of the file.

---

## War declared

- The pretense of peace is spent. {faction} looses its hosts upon {rival}, and the field is open between them.
- In the year {year}, from {capital}, {ruler} proclaims open war upon {rival}. The truce is ash; the levies muster.
- No herald softens it: {faction} takes the field against {rival}. Let {province} run red.

## City falls / captured

- {city} is taken. {faction}'s banners climb the walls, and {rival} counts the loss in stone and blood.
- When the siege has done its work, {city} opens its gates to {faction}. The keys pass, and the garrison of {rival} is no more.
- The walls of {city} hold no longer. {faction} enters as master, and {rival} is poorer by a city.

## Betrayal (pact broken)

- So much for sworn faith: {faction} breaks the pact with {rival} and turns the dagger inward.
- The seal is broken by {ruler}'s own hand. Where there stood a pact with {rival_ruler}, now there is only the field.
- {faction} keeps the truce with {rival} exactly until it is useful to break it. Today it breaks.

## Vassal revolt

- {vassal} will kneel no longer. The yoke of {overlord} is thrown off, and revolt runs through {province}.
- The tribute stops; the banners rise. {vassal} revolts against {overlord} and reclaims its own name.
- {overlord} kept a vassal, not a friend. {vassal} remembers the difference and rises in revolt.

## Trade monopoly seized

- Every ledger now runs through {faction}. The trade of {province} answers to no one else, and rivals pay the toll.
- {faction} closes its fist on the trade of {province}. What flows, flows for it, and the {coin} flow after.
- The markets bow to one master. {faction} seizes the monopoly of {province}, and {rival} is shut out of the counting-house.

## Prestige lead change (a new front-runner)

- The standing shifts in round {round}: {faction} outpaces {rival} and stands first in Prestige, {prestige} to its name.
- Renown finds a new favorite. {faction} overtakes {rival} and stands first in Prestige.
- {rival} led, and leads no longer. {faction} claims the foremost seat, with {prestige} Prestige in hand.

## Sudden-death: the fall of Constantinople

*The fall of the City ends the game outright, whoever holds the walls when they break.*

- Constantinople falls, and with it the age. {faction} stands within the walls, and where the City ends, the chronicle can hold no more.
- The Queen of Cities is taken. When Constantinople falls to {faction}, nothing further remains to contest — the reckoning is closed.
- The last wall of the world gives way. {faction} enters Constantinople, and the fall of the City closes the reckoning.

---

## Epilogues

One epilogue closes the chronicle for the winner, and — where the log demands it — a
lament for the fallen. Each faction keeps a **win** set and a **lose** set, three variants
apiece.

### Byzantium — *win (the impossible reprieve)*

- Against every reckoning, the City holds. The double walls stand unbroken, the Golden Horn stays Roman, and {ruler} rules on where all foretold ruin. Twilight, and yet no night.
- Constantinople endures. The last heir of the Caesars keeps his throne beside the Bosporus, and the empire that was a rumor becomes, once more, a fact.
- The siege lifts, the relief comes, the impossible is done. {faction} outlives its own eulogy, and the purple is not folded away after all.

### Byzantium — *lose (the City falls)*

- The walls that guarded Christendom for a thousand years are breached at last. Constantinople falls, {ruler} with it, and the long Roman evening is over.
- The Queen of Cities kneels. The cross comes down from the great church, and what was Byzantium passes into memory and lament.
- It ends where it was always going to end: at the Theodosian walls, under the smoke of the Golden Horn. {faction} is no more, and an age closes with it.

### Ottomans — *win (the conquest of the City)*

- The crescent rises over the Golden Horn. {ruler} takes Constantinople, the two continents are stitched into one dominion, and the Sublime Porte becomes the center of the world.
- What was besieged for generations is won in a season. {faction} enters the Queen of Cities as master, and the Roman evening gives way to a new imperial dawn.
- From Adrianople (Edirne) to the Bosporus, the road is now all one realm. The City is taken, and {ruler} is hailed conqueror beneath the great dome.

### Ottomans — *lose*

- The siege breaks upon the walls it could not climb. The hosts fall back toward Adrianople (Edirne), and the Porte's great design is undone for a generation.
- The tide that seemed unstoppable is stopped. {faction} spends its strength before the City and comes away with ash, and {ruler} counts the cost in the empty camps.
- The crescent does not rise this day. The Bosporus stays contested, the conquest deferred, and {ruler} rides home to a court that expected an empire.

### Venice — *win (mastery of the sea)*

- The Serenissima is mistress of the sea. Every galley pays her toll, every ledger closes in her favor, and the ducat rules where the sword could not.
- Venice counts, and Venice wins. The routes run gold into the lagoon, the rivals are shut from the counting-house, and {ruler} presides over an empire of the ledger.
- The lion of Saint Mark stands over the wharves of the world. {faction} takes the age not by conquest but by commerce, and the ducats have the last word.

### Venice — *lose*

- The lagoon cannot save the ledger. Venice's galleys are scattered, her monopolies broken, and the Serenissima learns that even the sea can be lost.
- The counting-house falls silent. The routes that fed the lagoon feed a rival now, and {faction} watches its ducats sail under another's flag.
- The lion of Saint Mark is caged. Trade slips the Republic's grasp, the treasury thins, and Venice yields the sea it thought its own.

### Genoa — *win (the counting-house triumphant)*

- Genoa the proud outlasts her every rival. The banks of the Ligurian shore fund the age, the Black Sea colonies answer to no one else, and the ducat bends to Genoese account.
- The Superba earns her name. {faction} masters the counting-house and the colony alike, and Venice herself must trade on Genoese terms.
- From Pera to the Ligurian sea, the ledgers all run home to Genoa. {ruler} presides over a maritime empire that owes nothing and is owed much.

### Genoa — *lose*

- Genoa is eclipsed. The colonies slip away, the banks fall quiet, and the Superba yields her seat at the world's table to the lion of Saint Mark.
- The Ligurian pride is humbled. {faction}'s galleys thin, her monopolies pass to rivals, and Genoa learns what it is to be second at sea.
- The counting-house of Genoa closes its books at a loss. The colonies answer to another flag now, and {ruler} rules a shore, not an empire.

### Hungary — *win (bulwark of Christendom)*

- The frontier holds. The crown of Saint Stephen stands as the shield of the West, the crescent breaks upon the Danube, and {ruler} is hailed defender of Christendom.
- Hungary is the wall that does not fall. {faction} keeps the marches, turns back the siege, and the bells of Buda ring for a border kept whole.
- The bulwark stands unbroken. From Buda, {ruler} holds the line that others only prayed for, and the West sleeps easier for Hungarian steel.

### Hungary — *lose*

- The frontier gives way. The marches are overrun, Buda's bells fall silent, and the shield of Christendom is beaten from Hungary's arm.
- The wall is breached. {faction}'s hosts are broken on the plain, the crown of Saint Stephen is contested, and the border the West relied upon is a border no longer.
- The bulwark fails. {ruler} spends the kingdom's strength and cannot hold the Danube; the marches are lost, and with them the shield of the West.

---

## Placeholders

| Placeholder | Fills with |
|---|---|
| `{faction}` | The acting faction (Byzantium, Ottomans, Venice, Genoa, Hungary). |
| `{rival}` | The opposing faction in the moment. |
| `{ruler}` | The acting faction's ruler. |
| `{rival_ruler}` | The opposing faction's ruler. |
| `{city}` | A named city (e.g. Constantinople, Venice, Buda). |
| `{province}` | A named land or region. |
| `{capital}` | The acting faction's capital. |
| `{round}` | The game round in which the moment falls (counter). |
| `{year}` | The calendar year, 1400–1453 (counter). |
| `{vassal}` | The faction rising in revolt. |
| `{overlord}` | The faction being revolted against. |
| `{coin}` | The faction-specific coin — ducats, hyperpyra, akçe. |
| `{prestige}` | The Prestige (renown / standing) value on the victory track (counter). |
