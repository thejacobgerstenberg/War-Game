# IMPERIUM — Phase 3 UI Mockups: The Interaction Contract

These static pages are the **contract** the Phase 3 client team implements. What is
annotated here is deliberate; where a mockup and this document disagree, this document
wins. Every screen links the shared stylesheet (`<link rel="stylesheet" href="mockups.css">`),
uses only the nine locked palette hues (as CSS custom properties from `mockups.css`),
and renders fully offline — no CDNs, no external fonts, no external anything.
JS is permitted only as a few inline lines for trivial tab-switching; prefer the
CSS-only `.tab-group` radio pattern documented in `mockups.css`.

---

## 1. Hover, selection, confirmation

| State | Treatment | Notes |
|---|---|---|
| Hover | **Gold rim** — 2px `--gold` ring (`box-shadow`), no fill change | Cursor: pointer. Applies to buttons, tabs, cards, provinces on the map. |
| Keyboard focus | Same gold rim via `:focus-visible`, 2px offset | Never remove focus outlines. Hover and focus look the same on purpose. |
| Selected | **Gold fill + ink text** (`.is-selected` / `aria-pressed="true"`) | Persistent until deselected. Selection is always also marked by a glyph or label, never color alone (see §3). |
| Pressed | Offset shadow collapses, element translates 2px — the seal comes down | 120ms max; respects `prefers-reduced-motion`. |
| Disabled | Opacity 0.45, no hover response, `cursor: not-allowed` | Always pair with an in-voice reason on hover/tap: *"The levies are spent."* |
| Destructive | **Always confirms** via `.modal` | Title names the deed; one line of consequence; `.btn--danger` carries the verb (*"Disband the Host"*), `.btn--quiet` stays the hand (*"Hold"*). No destructive action ever fires from a single click. |
| Commitment | Orders are two-step: choose, then commit (*"Set the Seal"*) | Committing plays `quill_scratch` (§4). Until sealed, orders are freely revocable. |
| Touch parity | Nothing lives on hover alone | Any hover detail (province tooltip, chip breakdown) must also open on tap/click and be dismissible. |

## 2. Errors and toasts

- Toasts stack in `.toast-rack`: **fixed, top-center, below the phase track.** Newest on
  top, at most three visible; older notices yield the floor.
- Informational toasts dismiss themselves after ~5 seconds. **Error toasts persist** until
  dismissed. Errors never block with a modal unless the game truly cannot proceed.
- Variants: default (gold spine), `.toast--error` (crimson spine), `.toast--triumph`
  (laurel spine). The spine color is doubled by a leading glyph — color is never the
  only channel.
- Copy is in-voice, short, and names the remedy where one exists:
  - *"The treasury cannot bear it."* — insufficient Gold
  - *"The granaries are bare; the host will not march."* — insufficient Grain
  - *"No road leads there, sire."* — illegal move target
  - *"The council awaits your word."* — turn reminder
  - *"So it is written."* — order committed (triumph variant)

## 3. Colorblind mode ("The Scribe's Aids")

- **Where:** Settings, under *The Scribe's Aids* — a single toggle. Settings are reached
  from the title screen and the in-game menu (demonstrated as a modal on screen 01).
- **What it changes:**
  - **Pattern overlays on faction colors** — every element carrying `data-faction` gains a
    heraldic hatch atop its hue (Byzantium diagonal, Venice horizontal waves, Genoa
    vertical pales, Ottomans reverse bends, Hungary ermine spots). Implemented in
    `mockups.css` §16 under the `.colorblind` body class.
  - **Glyph doubling on dice** — die results show pips *and* a distinct glyph per face
    (e.g. hit = crossed swords, rout = broken banner), so red/green die tinting is
    never load-bearing.
  - Resource chips always render icon + word, prestige markers always carry the crest,
    map ownership always shows the crest on the province.
- **The rule, absolute:** color is never the only channel. Every state readable by hue
  must also be readable by pattern, glyph, or label — in both modes.

## 4. Sound cue mapping

Cue names are from `audio/AUDIO_DESIGN.md` (v1.0, `origin/feature/audio-assets`); files
live in `audio/sfx/` and `audio/music/`.

| UI moment | Cue | Kind |
|---|---|---|
| Game start / round start | `church_bell` | sting |
| Button press / hover-select (generic UI) | `ui_click` | UI |
| Order committed ("Set the Seal") | `quill_scratch` | UI |
| Rules, log, or chronicle page turned | `page_turn` | UI |
| Income collected | `coin_purse` | SFX |
| Omen / event card struck | `card_flip` | sting |
| Dice rolled | `dice_roll` | SFX |
| Battle begun | `sword_clash` sting, then `battle_distant` loop while battle UI is open | sting + loop |
| Siege / bombard resolved | `bombard_shot` | SFX |
| Fleet move confirmed | `ship_creak` | SFX |
| Diplomacy screen open | `crowd_murmur` | loop |
| Era change | `horn_fanfare` (short) over `church_bell` tail — *proposed; reconcile with audio team* | sting |
| Victory | `horn_fanfare` | sting |
| Player eliminated / defeat | `defeat_drum` | sting |

Music state machine `LOBBY → GAME ⇄ BATTLE`: `menu_theme` loops in the lobby,
`campaign_ambient` is the in-game bed, `battle_drums` overlays during battle with the
ambient ducked to 30%. Default bus gains: Music 0.40, Ambient 0.30, SFX 0.70, UI 0.45.
Same-file retriggers debounce at 80ms. Audio unlocks on first user gesture (autoplay
policy) — the title screen's first press doubles as the unlock.

## 5. Asset fallback convention

Real game art lives on sibling branches (`feature/visual-assets`,
`feature/card-illustrations`) and is referenced by **relative path from
`design/mockups/`** — e.g. `../../art/icons/grain.svg`,
`../../art/crests/venice.svg`, `../../art/map/board.svg`,
`../../art/illustrations/events/greek-fire.svg`.

Every reference is wrapped in the `.asset` box from `mockups.css`:

```html
<figure class="asset asset--card">
  <img src="../../art/illustrations/events/greek-fire.svg" alt="Greek Fire">
</figure>
```

When the file exists, the image fills the box. When the branch is not yet merged, the
box degrades to a **hatched vellum placeholder with the alt text as a centered label** —
never a broken layout. Seeing hatched boxes on this branch is expected and correct.

**Fonts:** the locked stack is Cinzel (display) / EB Garamond (body), self-hosted woff2
at `client/public/fonts/` on `feature/design-and-scaffold`; `mockups.css` declares
`@font-face` against those relative paths with `font-display: swap`. Until that branch
merges, the pages render in the Georgia/Garamond fallbacks — expected, not a defect. Do
not substitute a `fonts.googleapis.com` import; under restricted egress it stalls page
load ~13 seconds.

## 6. File map

| File | Screen |
|---|---|
| `mockups.css` | Shared tokens + component kit (this contract's design layer) |
| `home.html` | Home / landing: illuminated masthead, Convene / Answer a Summons / Book of Rules, crest strip |
| `lobby.html` | Lobby (The Gathering Hall): word of gathering, player seats, faction select, antechamber chat |
| `game.html` | The campaign board: map, phase track, prestige track, province card, action bar, event toast, advisor, chronicle drawer |
| `combat.html` | Battle resolution: hosts arrayed, dice, tactic cards, outcome |
| `market.html` | The market: the Free Companies (mercenary block) and the Counting-House (trade ledger) |
| `diplomacy.html` | Diplomacy (The Court of Envoys): envoys, offers, the ledger |
| `chronicle.html` | Victory & end-of-era chronicle: final prestige, the written record |
| `screenshots/` | Captures of each screen for review threads; name after the screen file (e.g. `lobby.png`) |

Annotation convention inside every screen: numbered `.callout` circles over each zone,
matched by a `.legend` list at the foot of the page. Callouts and legends are spec
apparatus — they do not ship.
