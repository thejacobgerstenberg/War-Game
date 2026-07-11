# IMPERIUM: Twilight of Empires — Fixed UI Text

*The complete book of interface copy, set down in the voice of the chronicle.*
*Years of grace 1400–1453, ending at the walls of Constantinople.*

**How to read this file.** Every string a player will ever see is set below in
`code formatting` or in a blockquote, ready to be lifted straight into the client.
Prose spells its numbers as words; only counters, costs, and tallies wear bare numerals.
Nothing here uses modern idiom or false-antique spelling — the register is that of an
illuminated hand, plain enough to read at a glance mid-turn.

Faction-specific coin is noted where it lends color: **ducats** (Venice, Genoa),
**hyperpyra** (Byzantium), **akçe** (Ottomans). Where the interface must stay neutral,
the word is simply **gold**.

---

## 1. Main Menu

The title-screen choices, named in voice.

| Function | Label |
|---|---|
| New Game | `Raise a Banner` |
| Join Game | `Answer the Summons` |
| Rules | `The Book of Laws` |
| Chronicles / History | `The Chronicle` |
| Settings | `The Steward's Chamber` |
| Quit | `Lay Down the Crown` |

Menu subtitles (optional, shown beneath each item):

- Raise a Banner — `Found a new realm and call the great houses to the field.`
- Answer the Summons — `A game is already convened. Take your place among the powers.`
- The Book of Laws — `Every rule of war, coin, and diplomacy, plainly set down.`
- The Chronicle — `Read the records of realms risen and fallen before you.`
- The Steward's Chamber — `Order the court to your liking.`
- Lay Down the Crown — `Depart the game. Your seat will grow cold.`

Title tagline (under the game name):

> *Five crowns. One dying empire. The years run out at the Golden Horn.*

---

## 2. Lobby & Matchmaking

No modern idiom. The lobby is a gathering of courts before the war begins.

**Lobby heading**

> `The Powers Assemble`

**Waiting for players**

- `Awaiting the other courts…`
- `Two thrones are filled. Three sit empty.` *(counts adjust: "Three thrones are filled. Two sit empty.")*
- `The table is not yet full. We wait upon latecomers.`
- `A herald has been dispatched. Stand by for their answer.`

**Choose your faction**

> `Under which banner will you ride?`

Faction seats (selectable):

- `Byzantium — the Purple, from Constantinople.`
- `The Ottomans — the Sublime Porte, from Adrianople (Edirne).`
- `Venice — the Most Serene Republic, from her lagoon.`
- `Genoa — La Superba, from her harbor of stone.`
- `Hungary — the Crown of Saint Stephen, from Buda.`

Seat states:

- Available — `This throne stands empty. Claim it.`
- Taken by another — `Claimed by another house.`
- Taken by you — `Your banner flies here.`

**Ready states**

| State | Label |
|---|---|
| Not ready | `Not Yet Sworn` |
| Set ready | `Swear the Oath` |
| Ready (locked) | `Oath Sworn — Awaiting the Others` |
| Cancel ready | `Recall the Oath` |
| Host starts the game | `Open the Campaign` |

Lobby toasts:

- `Venice has taken her seat.` *(faction name varies)*
- `Genoa has sworn the oath.`
- `Hungary has withdrawn from the table.`
- `The host alone may open the campaign.`
- `All oaths are sworn. The years begin.`

**Codes / joining**

- `Bear this seal to those you would summon:` *(precedes the join code)*
- `Present your seal to join a game already convened.` *(join-by-code field prompt)*
- `No game answers to that seal.` *(bad code)*

---

## 3. Button Labels

Every interface action, given its in-voice label.

**Turn & flow**

| Function | Label |
|---|---|
| Confirm | `So Be It` |
| Cancel | `Think Again` |
| End turn | `Rest the Banner` |
| Undo last action | `Recall the Order` |
| Skip / pass | `Hold, and Watch` |
| Continue | `Onward` |
| Back | `Return` |
| Close panel | `Draw the Curtain` |

**War & the host**

| Function | Label |
|---|---|
| Muster / recruit | `Muster the Levies` |
| Reinforce a host | `Swell the Ranks` |
| Move a host | `March` |
| Lay siege | `Lay Siege` |
| Assault the walls | `Storm the Walls` |
| Declare war | `Take the Field` |
| Sue for peace | `Sue for Peace` |
| Disband a host | `Send Them Home` |
| Fortify a province | `Raise the Walls` |

**Coin, court & building**

| Function | Label |
|---|---|
| Build | `Lay the Foundation` |
| Build (improvement) | `Enrich the Province` |
| Trade | `Open the Counting-House` |
| Send tribute / gift | `Send Tribute` |
| Levy a tax | `Gather the Tithe` |
| Collect income | `Fill the Treasury` |

**Diplomacy**

| Function | Label |
|---|---|
| Propose a pact | `Extend the Hand` |
| Propose a truce | `Offer a Truce` |
| Accept | `We Are Agreed` |
| Refuse | `We Decline` |
| Break a pact | `Break Faith` |
| Demand vassalage | `Demand Submission` |
| Grant independence | `Loose the Leash` |
| Revolt (as vassal) | `Cast Off the Yoke` |

---

## 4. Resource & Prestige Tooltips

One evocative line each. The five resources sit along the top of the board;
Prestige stands apart, upon its own track.

**The Five Resources**

- **Gold** —
  > `The treasury's lifeblood. It pays the levies, buys the peace, and quiets the discontented — ducats, hyperpyra, or akçe, all melt to the same use.`

- **Grain** —
  > `The bread of hosts and cities alike. Empty granaries breed thin soldiers and thinner loyalty.`

- **Manpower** —
  > `The strong backs of the realm. From these levies are hosts mustered, and by their spending are they emptied.`

- **Faith** —
  > `Piety and the right to rule, bound as one. It hallows a crown, blesses a war, and steadies a people when the walls shake.`

- **Trade** —
  > `The goods that move by galley and caravan. Where commerce flows, the counting-house fills; where it fails, the coin runs dry.`

**The Prestige Track**

- **Prestige** —
  > `Your renown before God and history. Cities won, foes humbled, and faith upheld raise your standing; the crown of greatest Prestige when the years run out is remembered above all others.`

---

## 5. Turn Actions

The deeds a player may perform on their turn, named in voice.
(These are the action menu; the button labels above are how each is committed.)

| Action | In-voice name | One-line gloss |
|---|---|---|
| Recruit | `Muster` | `Raise fresh levies into a host.` |
| Move | `March` | `Lead a host into a neighboring province.` |
| Attack | `Give Battle` | `Meet an enemy host upon the field.` |
| Besiege | `Lay Siege` | `Ring a fortified city and starve it out.` |
| Build | `Endow` | `Raise walls, harbors, and holy houses.` |
| Trade | `Traffic` | `Send goods abroad and draw coin homeward.` |
| Tax | `Levy the Tithe` | `Wring gold from your provinces.` |
| Diplomacy | `Treat` | `Bind or break pacts and truces.` |
| Vassalize | `Subject a Rival` | `Bend a broken foe to your crown.` |
| Fortify | `Entrench` | `Dig in and strengthen a holding.` |

---

## 6. Phases of the Turn

The ordered phases of a round, named in voice.

1. `The Reckoning` — *income and supply are counted; treasuries fill, granaries empty.*
2. `The Levy` — *fresh hosts are mustered and the ranks are swelled.*
3. `The March` — *hosts move, cities are besieged, and battle is joined upon the field.*
4. `The Court` — *pacts are sealed, truces offered, tribute sent, and foundations laid.*
5. `The Chronicle` — *the deeds of the round are set down, and Prestige is weighed.*

Phase banners (shown as each phase opens):

- `The Reckoning begins. Count what the realm has gathered.`
- `The Levy is called. Raise your hosts.`
- `The March is upon us. Let the banners move.`
- `The Court is in session. Let ambassadors speak.`
- `The Chronicle is written. The round is ended.`

Turn banner (whose turn it is):

- `The turn passes to Venice.` *(faction name varies)*
- `It is your turn. The realm awaits your word.`

---

## 7. Errors & Toasts

At least ten, all in voice. No "OK," no "error," no modern phrasing.

**Coin & resources**

1. `Not enough gold in the treasury.`
2. `The granaries are bare — no grain to spare.`
3. `Too few levies answer the muster.`
4. `The people's faith will not stretch so far.`
5. `The counting-house is empty; you have no goods to trade.`

**Movement & targets**

6. `No path leads a host from here to there.`
7. `There is no worthy target within reach.`
8. `That province lies too far for one march.`
9. `A host already holds that ground — it cannot move twice.`

**Ownership & rules**

10. `That province already flies your banner.`
11. `You cannot lay siege to your own city.`
12. `This deed is not yours to do — the turn belongs to another.`
13. `You have spent your deeds this round. Rest the banner.`

**Diplomacy**

14. `A truce forbids this. You are sworn to peace.`
15. `You hold no pact with that crown to break.`
16. `A vassal may not treat with foreign powers.`
17. `They have refused your hand.`

**The table & connection**

18. `The herald cannot reach the table — the connection is lost.`
19. `The messenger returns; the table is restored.`
20. `You wait upon another court. Be patient.`

Success toasts (the pleasant kind):

- `The city has fallen. Its keys are yours.`
- `The pact is sealed.`
- `The truce holds.`
- `Fresh levies stand ready beneath your banner.`
- `The treasury swells with the season's income.`
- `Your standing rises. The chronicle takes note.`

---

## 8. Victory Screen

Generic, faction-agnostic.

**Heading**

> `The Years Are Run — and You Stand First`

**Body**

> `Constantinople has met its hour, and the age of empires turns.
> When the dust of these fifty years settled, no crown shone brighter than yours.
> Your cities endured, your foes bent the knee, and your renown outlasted them all.
>
> The chronicle closes with your name at its head. So it will be remembered.`

**Footer line**

> `Greatest in Prestige. Sovereign of the Twilight.`

**Button**

- Return to menu — `Close the Book`
- Review the game — `Read the Chronicle`

---

## 9. Defeat Screen

Generic, faction-agnostic.

**Heading — realm fallen (eliminated)**

> `Your Banner Is Struck`

**Body — eliminated**

> `Your last city has fallen and your hosts are scattered to the wind.
> The lands that bore your crown now answer to another.
> History is unkind to the vanquished; it will spare you but a line.`

**Heading — game ended, not first**

> `The Years Are Run`

**Body — outlasted but outshone**

> `Constantinople has met its hour, and the age of empires turns.
> You endured to the end — no small thing — yet a brighter crown eclipsed your own.
> Another name stands first in the chronicle. Yours is set down beneath it.`

**Footer line**

> `Take heart. Empires fall, and are raised again.`

**Button**

- Return to menu — `Close the Book`
- Review the game — `Read the Chronicle`

---

*End of the Book of Interface Text. Keep the voice; keep the lines short.*
