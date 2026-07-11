# STYLE.md — The Writing Bible

### *IMPERIUM: Twilight of Empires* (1400–1453)

This document governs every word the player reads: flavor text, advisor lines, event
copy, UI labels, tooltips, faction descriptions. When in doubt, this file wins. If it
does not answer your question, ask the lead writer — do not improvise a new convention.

> **The illuminated-chronicle principle.** Every line should read as though a scribe
> copied it into a great chronicle by candlelight: vivid, weighted, a little wry, and
> never wasteful. We write the *account* of a dying age, not a rulebook and not a
> costume drama. Elevated — but always playable at a glance, mid-turn.

---

## 1. Voice & Register

- **Elevated but playable.** The register of an illuminated chronicle: vivid, precise,
  faintly wry. Dignity first; wit is seasoning, never the meal.
- **Short lines.** In-game text must be readable in a single glance while the player is
  mid-turn. Favor the short sentence. Cut every word that does no work.
- **English, always.** All prose is in modern, correct English. No exceptions.
- **Period texture is welcome, in English.** Real titles, offices, and place names give
  the world its weight: *the Sublime Porte*, *the Golden Horn*, *the Despot*, *ducats*,
  *Adrianople (Edirne)*. Reach for the true word, not the quaint one.
- **Concrete over abstract.** A named galley, a named pass, a named coin. "Three galleys
  ride at anchor in the Horn" beats "naval forces are positioned."
- **Restraint in emotion.** The chronicle observes; it rarely shouts. Understatement
  carries more menace than exclamation. Use exclamation points almost never.
- **No hand-holding tone.** The player is a prince, not a pupil. Advise; do not lecture.
- **One voice per surface, but many advisors.** Faction advisors may differ in flavor
  (a Venetian factor is dry and mercantile; a Byzantine logothete is mournful and
  grand), but all share the chronicle's underlying dignity.

---

## 2. Tense & Person

| Surface | Tense | Person | Example |
|---|---|---|---|
| Flavor / lore prose | **Past** (the chronicle recounts) | Third person | *"The walls held through the winter, and the Despot gave thanks."* |
| Event narration | **Past** for the deed; **present** for the standing situation | Third person | *"Famine has come to the City. The granaries stand empty."* |
| Advisor lines (in-fiction counsel) | **Present / future** | **Second person** ("you") — addressing the prince | *"You cannot hold both the strait and the field, my lord. Choose."* |
| UI labels, buttons, costs, tooltips | **Present**, imperative or nominal | Second person imperative or no person | *"Raise levies," "Sue for truce," "Grain: 4."* |

Rules:
- **Second person ("you") is permitted only** in advisor counsel and in UI actions
  directed at the player. Never use "you" inside flavor/lore prose — the chronicle does
  not address the reader.
- **Never first person plural** ("we", "let us") except inside a quoted line of dialogue
  from a named or clearly implied speaker.
- Keep tense consistent within a single block of text. Do not drift from past to present
  mid-paragraph unless the shift is the standing-situation rule above.

---

## 3. Terminology Glossary

Use these words. Keep them consistent everywhere. The **Prose** column is for
flavor, events, and advisor lines; the **UI** column is for labels, counters, buttons,
and tooltips (where brevity and clarity rule).

| Concept | In prose | In UI |
|---|---|---|
| Military force | **host**, **levies** (never "troops", "units", "stacks", "armies-as-tokens") | **Host** |
| A besieging force / act | **siege**, "to lay siege", "the siege tightens" | **Siege** |
| Territory | **province**, **lands** (never "tiles", "hexes", "squares") | **Province** |
| Victory / glory track | **Prestige** (also *renown*, *standing* in flavor) | **Prestige** |
| Money held | **the treasury** | **Treasury** |
| Coin (generic) | **gold**, **coin** | **Gold** |
| Coin (Venice / Genoa) | **ducats** | Gold (counter); "ducats" in flavor |
| Coin (Byzantium) | **hyperpyra** | Gold (counter); "hyperpyra" in flavor |
| Coin (Ottomans) | **akçe** | Gold (counter); "akçe" in flavor |
| Subject faction | **vassal** | **Vassal** |
| A vassal breaking free | **revolt**, "to rise", "to throw off the yoke" | **Revolt** |
| Peace agreement / alliance | **pact**, **truce** | **Pact**, **Truce** |
| Open war | **the field**, "to take the field" | **War** |
| Resource 1 — coin/wealth | **gold**, **coin** | **Gold** |
| Resource 2 — food/supply | **grain** | **Grain** |
| Resource 3 — wood for fleet, siege & building | **timber** | **Timber** |
| Resource 4 — stone for church & monument | **marble** | **Marble** |
| Resource 5 — piety/legitimacy | **faith** | **Faith** |

**The five resources are: Gold, Grain, Timber, Marble, Faith.**
**Prestige is the separate victory track — it is *not* one of the five resources.** Never
call Prestige a resource, and never speak of "spending Prestige" as if it were coin
(it is *won*, *lost*, *squandered*, *earned*).

**Fighting strength is not a resource.** The realm's strength in arms lives on the board
as its hosts and levies. Write "the levies are spent" or "the muster fields stand empty" —
never a counted stockpile of fighting men, and never speak of spending them as if they
sat in a granary.

**Trade is not a resource.** Trading is an activity — routes, monopolies, the
counting-house — and its fruit is Gold. "Trade routes," "to trade," and commerce as a
deed are all welcome; "Trade" as a stockpiled, spendable quantity is not.

Faction-specific coin names (*ducats*, *hyperpyra*, *akçe*) are flavor color: use them in
prose where they add texture; the UI counter is always the neutral **Gold**.

---

## 4. Capitalization

Capitalize:
- **Prestige** — always, as a proper game concept.
- **The five resource names as game terms in UI and headings:** Gold, Grain, Timber,
  Marble, Faith. In running prose, lowercase them as ordinary nouns unless referring to
  the tracked quantity as a named thing ("Grain fell to two" vs. "the grain rotted").
- **Faction names:** Byzantium, the Ottomans, Venice, Genoa, Hungary. Also **Byzantine**,
  **Ottoman**, **Venetian**, **Genoese**, **Hungarian**.
- **Offices and titles when used as titles:** the Despot, the Sultan, the Doge, the Basileus,
  the Grand Vizier, the Logothete, the Voivode, the Sublime Porte. Lowercase a title used
  generically ("he was made a despot of no importance").
- **Place names:** Constantinople, the City (when it means Constantinople), Adrianople
  (Edirne), the Golden Horn, the Bosporus, the Sublime Porte, Buda, the Morea.
- **Named game systems and tracks** treated as proper nouns: Prestige, Siege (as a titled
  action), Vassal (as a status label).

Lowercase:
- Generic military and geographic nouns in prose: host, levies, siege, province, lands,
  pact, truce, vassal, revolt, treasury, coin — *unless* they are a UI label.
- "the field" (open war) — lowercase in prose.

House convention: **"the City"** capitalized always means Constantinople.

---

## 5. Anachronism Blacklist & the Archaic-Spelling Rule

### 5a. Banned words and idioms — never use, anywhere

These break the period instantly. Do not use them even in jest, headers, or placeholder text:

`OK` · `okay` · `%` · `percent` · `guys` · `team` · `level up` · `stats` · `buff` ·
`nerf` · `meta` · `grind` · `XP` · emoji · `hey` · `cool` · `awesome`

Also banned:
- **Modern idiom and slang** of any kind ("game changer", "no-brainer", "heads up",
  "back on track", "win-win", "reach out", "double down").
- **Clock time in AM/PM or hours-and-minutes.** Mark time by season, watch, feast day,
  or the turn ("by the spring thaw", "before the feast of St. Demetrios", "this turn").
- **Metric units.** Use period measures or plain description (leagues, a day's ride, a
  bowshot) — never kilometers, meters, kilograms.
- **Anything postdating 1453**: later technology, later gunpowder-age-and-beyond
  references, nation-states, later titles, later coinage, modern warfare vocabulary.
- **Statistics-speak**: "percent", ratios written as odds-jargon, "efficiency", "optimize",
  "DPS", "cooldown". Express chance in prose ("the odds are grim", "a slender hope").

### 5b. No fake archaic spelling — ever

We write **modern, correct English**. We do **not** fake the medieval by misspelling.

Forbidden: `ye olde`, `thou`, `thee`, `thy`, `thine`, `shalt`, `hast`, `doth`, any
`-eth` verb ending (`sayeth`, `goeth`, `maketh`), `wouldst`, `couldst`, dropped-vowel
mock-old spellings (`towne`, `warre`, `swifte`).

The period feeling comes from **real vocabulary and real names**, not from broken spelling.
Write "you will not hold the City" — never "thou shalt not hold ye Citie."

---

## 6. Numbers: Prose vs. UI

- **In prose** (flavor, events, advisor lines): spell numbers as words where it reads
  naturally — *"three galleys", "the twelve gates", "a thousand janissaries", "two
  provinces lost."* This is the chronicle's voice.
- **In UI** (counters, costs, resource readouts, tooltips): use **bare numerals** for
  clarity at a glance — *"Grain 4", "Cost: 2 Gold", "Host: 3", "Prestige +1."*
- **Do not mix** within one line. A tooltip that costs coin reads *"Cost: 2 Gold,"* not
  *"Cost: two Gold."* A flavor line reads *"three galleys,"* not *"3 galleys."*
- Years may be written as numerals in prose when a date is meant as a chronicle entry
  (*"In 1453 the City fell"*) — this is the one prose exception, and it is deliberate.
- Never use `%`. Express proportion in words: *"a third of the harvest", "half the host."*

---

## 7. Ten Good / Bad Example Pairs

Each pair shows a line that violates this bible and its corrected form. Study the *why*.

| # | Surface | BAD | GOOD |
|---|---|---|---|
| 1 | Flavor | "Yon garrison hath 3 units and stats are low." | "The garrison numbers three worn hosts, and the walls are older than the men who hold them." |
| 2 | Advisor | "Hey, you should level up your army, it's a game changer." | "Raise fresh levies before the thaw, my lord, or the field will be lost by summer." |
| 3 | UI cost | "Buy Siege — Cost: two gold (33%)" | "Lay Siege — Cost: 2 Gold" |
| 4 | Event | "Famine hit the tiles and you lost 25% of grain." | "Famine walks the lands. A quarter of the grain is gone, and the granaries echo." |
| 5 | Flavor | "Thou shalt not passeth ye olde strait." | "None shall cross the strait while the chain holds the Horn." |
| 6 | Advisor | "OK team, let's grind Prestige and buff Faith." | "Endow the monasteries, and your standing will rise with your Faith. Piety is the coin the crowd counts." |
| 7 | UI label | "Troops: 5 | Money: 200 | Meta score" | "Host: 5 · Treasury: 200 Gold · Prestige: 12" |
| 8 | Event | "At 3:45 PM the enemy stack attacked your hex." | "At the dawn watch the Ottoman host fell upon the eastern province." |
| 9 | Flavor | "Venice nerfed Genoa's trade, awesome win-win." | "Venice has closed the Adriatic to Genoese bottoms; the ducats of Genoa will thin before the year is out." |
| 10 | Advisor | "Your vassal is grinding a revolt, heads up." | "Hungary stirs beneath your yoke, my lord. The vassal sharpens knives; a revolt is a season away." |

**How to read these:** the bad lines fail on banned words (1, 2, 6, 7, 9), fake-archaic
spelling (5), numerals or `%` where prose wants words (1, 3, 4), UI where words should be
numerals (3), modern clock time (8), modern idiom (2, 9, 10), and glossary drift —
"units/tiles/stacks/hex/troops" (1, 4, 7, 8). Each good line fixes the fault *and* earns
its place in the chronicle.

---

*When a line satisfies this bible, it should sound like it was always meant to be there —
copied into the great book by a scribe who knew the age was ending, and wrote it down anyway.*
