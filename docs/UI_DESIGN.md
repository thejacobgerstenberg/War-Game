# IMPERIUM: Twilight of Empires — UI & Visual Design

> The visual language for the browser client (`client/`, React + Vite). This doc
> defines the art direction, the palette and fonts the client ships as CSS
> custom properties (§2 notes which tokens the scaffold ships today), the
> iconography, layout, interaction states, component kit, and accessibility
> rules. It is the source of truth the client CSS must match. Systems live in [`GAME_DESIGN.md`](./GAME_DESIGN.md);
> the technical plan in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. Art Direction

**One line:** *a living illuminated manuscript of the dying Roman world.*

The board should feel like an aged **parchment map** unrolled on a table, drawn
in **iron-gall ink**, illuminated in the **Byzantine mosaic** manner — tesserae,
gold leaf, and **porphyry** purple, the imperial stone. Every panel edge is a
manuscript border; every faction card is a page from a chronicle; the endgame is
a **history book** turned to its last, gilded page.

Principles:

* **Parchment first.** The dominant surface is warm parchment `#F4E9D0`; ink and
  gold do the talking. Avoid flat modern white.
* **Gold is precious.** `--imp-gold` is for emphasis, borders, prestige, and
  victory — never body text. Treat it like real gold leaf: sparing, luminous.
* **Porphyry is imperial.** Deep purple frames the empire and the chrome;
  reserved, weighty, never cheerful.
* **Mosaic texture, not gloss.** Surfaces read as tesserae, vellum grain, and
  hand-drawn linework — subtle noise/texture over flat fills, no glassy gradients.
* **Restraint.** The map is the star. Chrome recedes into manuscript borders so
  the provinces and armies carry the eye.

---

## 2. Color Palette

The client defines these as **CSS custom properties** on `:root` (in
`client/src/theme.css`). Use the variable, never the raw hex, in components.
The scaffold ships the five core colors plus the derived `--imp-purple-deep` /
`--imp-gold-soft` / `--imp-parchment-shade` today; the remaining tints, the
semantic aliases and the `--fac-*` faction tokens (§2.1) are the target set,
added as the game-board UI lands. *(The scaffold's lobby chrome currently sits
on a dark porphyry gradient; the parchment-first board surface of §1 arrives
with the full board UI.)*

| Token (CSS var) | Hex | Role |
|---|---|---|
| `--imp-purple` | `#4B1F3F` | Deep imperial **porphyry** — primary chrome, empire frame, headers |
| `--imp-gold` | `#C9A227` | **Imperial gold** — emphasis, borders, prestige, selection |
| `--imp-parchment` | `#F4E9D0` | **Parchment** — dominant background surface |
| `--imp-lapis` | `#26619C` | **Lapis blue** — sea zones, links, informational accents |
| `--imp-ink` | `#2B2118` | **Iron-gall ink** — body text, linework, borders |
| `--imp-blood` | `#7B241C` | **Blood red** — war, attacks, danger, destructive actions |
| `--imp-verdigris` | `#40826D` | **Verdigris** — success, growth, trade/economy accents |

Supporting tints (derived, also tokenised):

| Token | Hex | Role |
|---|---|---|
| `--imp-purple-deep` | `#35162C` | Background gradient depth, darkest chrome |
| `--imp-parchment-shade` | `#E6D7B4` | Panel fills, hover on parchment, table zebra |
| `--imp-parchment-aged` | `#D9C8A0` | Map landmass base, worn edges *(planned)* |
| `--imp-gold-soft` | `#E2C766` | Gold highlight, glints, focus ring inner |
| `--imp-purple-light` | `#6E3B5C` | Hover/active on purple chrome *(planned)* |
| `--imp-ink-soft` | `#5A4B3A` | Secondary text, captions, disabled ink *(planned)* |

```css
:root {
  /* shipped today in client/src/theme.css */
  --imp-purple: #4B1F3F;
  --imp-gold: #C9A227;
  --imp-parchment: #F4E9D0;
  --imp-lapis: #26619C;
  --imp-ink: #2B2118;
  --imp-purple-deep: #35162C;
  --imp-gold-soft: #E2C766;
  --imp-parchment-shade: #E6D7B4;

  /* target tokens — added with the game-board UI */
  --imp-blood: #7B241C;
  --imp-verdigris: #40826D;
  --imp-parchment-aged: #D9C8A0;
  --imp-purple-light: #6E3B5C;
  --imp-ink-soft: #5A4B3A;

  /* semantic aliases — added with the game-board UI */
  --bg: var(--imp-parchment);
  --surface: var(--imp-parchment-shade);
  --text: var(--imp-ink);
  --text-muted: var(--imp-ink-soft);
  --border: var(--imp-ink);
  --accent: var(--imp-gold);
  --sea: var(--imp-lapis);
  --danger: var(--imp-blood);
  --success: var(--imp-verdigris);
}
```

### 2.1 Faction colors

Each power has a heraldic color, used as the **fill of its provinces, badges and
army tokens**. Color is **never the only signal** — it is always paired with the
faction **emblem** and a **texture pattern** (§7, §8.3) for colorblind safety.

| Faction | Token | Hex | Heraldry |
|---|---|---|---|
| Byzantium | `--fac-byzantium` | `#7A2E2E` → gold accent | Imperial red & gold, the double eagle |
| Ottomans | `--fac-ottoman` | `#1F6B4C` | Islamic green, white crescent |
| Venice | `--fac-venice` | `#B4472A` | Venetian vermilion, winged lion |
| Genoa | `--fac-genoa` | `#C9CBD0` → red cross | Silver-white, the red cross of St George |
| Hungary | `--fac-hungary` | `#2F5B8C` | Blue & silver, the raven |

> The scaffold's placeholder `GameBoard` currently flat-fills provinces with
> interim hardcoded colors; these `--fac-*` tokens (and the §7 pattern fills)
> replace them when the full map UI lands.

---

## 3. Typography

Two Google fonts — self-hosted as woff2 files in `client/public/fonts/` and
loaded via `@font-face` in `client/src/theme.css` (no `fonts.googleapis.com`
request at runtime):

* **Display / titles — [Cinzel](https://fonts.google.com/specimen/Cinzel)**, a
  Trajan-inspired Roman capital face. Titles, headers, faction names, numbers of
  weight. `--font-display: "Cinzel", "Trajan Pro", Georgia, serif;`
* **Body — [EB Garamond](https://fonts.google.com/specimen/EB+Garamond)**, a warm
  humanist serif for readable long text, tables, tooltips.
  `--font-body: "EB Garamond", Garamond, Georgia, serif;`

```css
:root {
  --font-display: "Cinzel", "Trajan Pro", Georgia, serif;
  --font-body: "EB Garamond", Garamond, Georgia, serif;
}
```

### 3.1 Type scale

A modular scale (~1.25). Display uses Cinzel; everything from `h4`/body down uses
EB Garamond (Cinzel is too wide for small sizes).

| Token | Size | Line | Font | Use |
|---|---|---|---|---|
| `--fs-display` | 44px | 1.1 | Cinzel 700, letter-spacing .04em | Screen titles ("IMPERIUM") |
| `--fs-h1` | 32px | 1.15 | Cinzel 600 | Section / modal titles |
| `--fs-h2` | 25px | 1.2 | Cinzel 600 | Panel headers |
| `--fs-h3` | 20px | 1.25 | Cinzel 500 / small-caps | Sub-headers, faction names |
| `--fs-body` | 16px | 1.5 | EB Garamond 400 | Body text, logs |
| `--fs-small` | 14px | 1.45 | EB Garamond 400 | Captions, tooltips |
| `--fs-micro` | 12px | 1.4 | EB Garamond 500 | Pills, badges, map labels |

Numbers in resource pills and dice use **Cinzel** at `--fs-micro`/`--fs-small`
weight 600 for a struck-coin feel.

---

## 4. Motifs & Iconography

Recurring ornaments, drawn as inline SVG so they inherit `currentColor` and the
palette:

* **Mosaic tesserae** — square/rhombic tiles with a 1px parchment grout, used as
  loading shimmers, progress fills, and the texture behind gold panels.
* **Laurel wreath** — frames prestige totals and the victor on the endgame screen.
* **Roundel (medallion)** — the circular frame every **faction emblem** sits in;
  also the base of army/fleet map tokens.
* **Manuscript border** — a repeating interlace/guilloche rule that edges panels
  and cards (a thin `--imp-gold` inner line over `--imp-ink`).
* **Drop-cap initials** — Cinzel drop caps open the event-log and chronicle text.
* **Cross / crescent / eagle finials** — small terminal ornaments on headers,
  faction-appropriate.

### 4.1 Faction emblems

Each emblem is an SVG roundel, monochrome-capable (works in one ink color for
accessibility) but tinted to faction heraldry by default.

| Faction | Emblem | Description |
|---|---|---|
| **Byzantium** | **Double-headed eagle** | The imperial *dikephalos*: a black/gold eagle with two crowned heads facing outward, wings spread, clutching orb & scepter — legitimacy of Rome. |
| **Ottomans** | **Crescent (& star)** | A waxing crescent moon opening right, a small star at its cusp, white on green — the rising power. |
| **Venice** | **Winged Lion of St Mark** | A winged lion passant, halo, one paw on an open book (*Pax tibi Marce*), often with the sea beneath — la Serenissima. |
| **Genoa** | **Cross of St George** | A bold red couped cross on white, flanked by two heraldic griffins — the Genoese commune & its banks. |
| **Hungary** | **Raven with ring** | A black raven (the Hunyadi *corvinus*) perched, a gold ring in its beak, on blue — the Christian bulwark of the Danube. |

Emblems appear at three sizes: **badge** (24px, in chrome), **roundel** (40px, on
tokens/cards), **crest** (96px+, faction-pick & chronicle).

---

## 5. Layout

The Game Board is a full-viewport grid: manuscript chrome around a central map.

```
┌──────────────────────────────────────────────────────────────────────┐
│  RESOURCE BAR  gold ● grain ● timber ● marble ● faith ●│ prestige │yr │  top
├───────────┬──────────────────────────────────────────┬───────────────┤
│  PLAYER   │                                          │   ACTIONS /    │
│  STATUS   │            CENTRAL SVG MAP                │   CARDS panel  │
│  (rows of │   (provinces = tiles, sea zones = lapis,  │  (action       │
│  faction  │    army/fleet roundel tokens, hover &     │   buttons,     │
│  badges,  │    selection highlights)                  │   hand of      │
│  prestige)│                                          │   illuminated  │
│           │                                          │   cards)       │
├───────────┴──────────────────────────────────────────┴───────────────┤
│  EVENT / LOG FEED   — scrolling chronicle of the year (drop-cap lines)  │  bottom
└──────────────────────────────────────────────────────────────────────┘
      Overlays: COMBAT modal · DIPLOMACY modal · SIEGE tracker · endgame CHRONICLE
```

* **Resource bar (top)** — a porphyry strip of **resource pills** (§8), the active
  player's prestige in a laurel, and the **year/round** (1400 → 1453) as a Cinzel
  numeral. Turn-order shown as a row of faction badges, active one lit gold.
* **Central SVG map** — the star. Provinces are terrain-tinted tiles; sea zones
  are lapis; army/fleet tokens are roundels stamped with the faction emblem.
  Pan/zoom; hover and selection states per §6.
* **Left panel — player status** — one row per power: faction badge, name,
  prestige, headline resources, treaty icons. Click to focus that power.
* **Right panel — actions & cards** — the **action buttons** (Recruit, Move,
  Build, Trade, Diplomacy, Play Card, Spy — see `GAME_DESIGN.md` §10) with an
  action-counter (**4 actions**/round, `GAME_DESIGN.md` §10.0), and the
  player's **hand** of illuminated cards.
* **Bottom — event/log feed** — the running **chronicle**: Omen draws, battles,
  betrayals, prestige changes, each a drop-cap line. This is the human-readable
  face of the server's structured event log (`ARCHITECTURE.md`).

### 5.1 Screen flow

`Home → Create/Join → Faction Pick → Lobby → Game Board`. Home is a title plate
(Cinzel "IMPERIUM", parchment, a mosaic border). Faction Pick shows the five
**crests** with lore. Lobby lists joined players by faction badge with the room
code in a gilded cartouche. See `ARCHITECTURE.md` for the socket flow.

---

## 6. Interaction States (map)

Province & sea-zone tiles carry a stateful stroke/fill. States stack in priority
order (topmost wins on the stroke):

| State | Treatment |
|---|---|
| **Default** | Terrain-tinted fill, `--imp-ink` 1px stroke, faction color as ownership wash + pattern (§8.3) |
| **Hover** | `--imp-gold-soft` 2px stroke, subtle lift; tooltip with name/terrain/yields |
| **Selected** | `--imp-gold` 3px stroke + animated tesserae glint; info in right panel |
| **Valid move / target** | Pulsing `--imp-verdigris` overlay + dashed gold outline on reachable tiles |
| **Enemy territory** | `--imp-blood` hatch overlay along the border when a move would attack |
| **Sieged** | `--imp-blood` dashed "circumvallation" ring + a siege badge with Wall-HP bar |
| **Blockaded (sea)** | Lapis zone crossed with a blood-red anchor-bar icon |
| **Unrest / no-yield** | Grey-wash + a broken-coin icon (from a spy's *incite unrest* or revolt) |
| **Disabled / out of range** | Desaturated, `--imp-ink-soft`, non-interactive |

Focus for keyboard users mirrors hover+selected with a visible `--imp-gold` focus
ring (never removed).

---

## 7. Colorblind-Safe Faction Differentiation

**Rule: faction identity is conveyed by three redundant channels — color +
emblem + texture pattern — never color alone.** Every province ownership wash,
army token, badge, and legend swatch carries the faction's **SVG pattern** as a
`<pattern>` fill overlaid on the heraldic color, plus the emblem where space
allows. This keeps all five powers distinguishable under any color-vision
deficiency and in grayscale.

| Faction | Color | Emblem | **Pattern / texture** |
|---|---|---|---|
| **Byzantium** | imperial red/gold | double eagle | **Crosshatch** — fine diagonal cross-lattice |
| **Ottomans** | green | crescent | **Crescent-dot** — repeating small crescents / dotted field |
| **Venice** | vermilion | winged lion | **Wave** — horizontal wavy lines (the lagoon/sea) |
| **Genoa** | silver-white | red cross | **Check** — small checkerboard |
| **Hungary** | blue | raven | **Stripe** — bold diagonal stripes (bendy) |

Patterns are defined once as reusable SVG `<pattern>` defs (`facPattern-byzantium`
… `facPattern-hungary`) and referenced by fill; they scale with zoom and render on
tokens, map washes, badges, the turn-order strip, and legends identically so the
mapping is learnable at a glance.

---

## 8. Component Kit

All components use the tokens above; corners are subtly softened (2–4px), borders
are the manuscript rule.

### 8.1 Buttons
* **Primary (imperial)** — porphyry fill, gold border + label, gold-light on
  hover; used for confirm/start.
* **Action** — parchment-shade fill, ink label, gold underline on hover; the
  right-panel action buttons, each with an icon and a cost chip.
* **Destructive (war)** — blood fill, parchment label; attack/assault/betray.
* **Ghost** — ink outline on parchment; cancel/secondary.
* Disabled: `--imp-ink-soft` on `--imp-parchment-aged`, no border glow.

### 8.2 Resource pills
Small rounded coins: an icon (§4-style glyph) + a Cinzel number, one per resource
(`gold` gold, `grain` verdigris-wheat, `timber` brown, `marble` grey, `faith`
lapis). A delta (`+3` / `−1`) animates on the pill each Income phase.

### 8.3 Faction badges & army tokens
* **Badge** — a roundel: heraldic color + faction pattern + emblem, gold rim.
* **Army/fleet token** — roundel badge with a Cinzel unit count; a thin ring
  segments show composition (INF/CAV/etc.); blood pip when it carries a declared
  attack, anchor for fleets.

### 8.4 Card frames (illuminated cards)
Event/Omen, tactic and objective cards render as **illuminated manuscript pages**:
a parchment field inside a gold manuscript border, a Cinzel title with a drop-cap
initial, an EB Garamond body, a cost strip of resource pills, and a corner
finial matched to card type (**Ill**/crisis = blood, **Good**/boon = verdigris,
**Grant** = gold — the card types of `EVENT_CARDS.md`).
Objective (secret) cards show face-down as a porphyry back with a gold roundel.

### 8.5 Panels & modals
* **Panel** — parchment-shade surface, manuscript border, Cinzel `--fs-h2` header
  on a porphyry ribbon.
* **Combat modal** — a "battlefield" spread: attacker vs defender columns, the
  dice roll animated as struck coins/tesserae, terrain & wall modifier chips, a
  round-by-round casualty log, and Retreat/Assault/Continue controls. Mirrors
  `GAME_DESIGN.md` §7.
* **Diplomacy modal** — two facing crests, a treaty selector (Alliance / NAP /
  Tribute / Royal Marriage / Vassalize), resource offer sliders, and a
  Propose/Accept/Renounce control; betrayal warnings in blood.
* **Siege tracker** — Wall-HP bar, bombardment/starvation counters, assault button.
* **Chronicle (endgame)** — a full-screen illuminated "history book": the victor
  under a laurel, then narrated pages of the game's turning points, built from the
  server chronicle recap (`ARCHITECTURE.md`). Pages turn; gold leaf throughout.

### 8.6 Log / event feed
A scrolling column of drop-cap chronicle lines, color-keyed by entry type (war =
blood, trade = verdigris, diplomacy = lapis, prestige = gold, omen = purple),
each timestamped by round/year.

---

## 9. Accessibility

* **Contrast** — body ink `--imp-ink` on parchment `--imp-parchment` ≈ 11:1
  (well past WCAG AA). Gold `--imp-gold` is **decorative/large-only** — never gold
  body text on parchment (fails AA); gold text appears only on porphyry
  (`--imp-gold` on `--imp-purple` ≈ 4.7:1, AA for large/UI). Blood and lapis meet
  AA for text on parchment. Any new pairing must be validated to ≥ 4.5:1 for body,
  ≥ 3:1 for large text/UI.
* **Never color-only** — faction identity uses color **+ emblem + pattern** (§7);
  interaction states use shape/icon **+ color** (§6); log entries use an icon **+**
  the type color. The game is fully playable in grayscale.
* **Keyboard & focus** — every interactive element is tabbable with a visible
  `--imp-gold` focus ring; the map supports arrow-key province traversal; modals
  trap focus and close on `Esc`.
* **Motion** — tesserae shimmer, dice animation and page-turns respect
  `prefers-reduced-motion` (fall back to instant states).
* **Text scaling** — layout uses relative units so a 200% zoom reflows panels
  without clipping; the map pans/zooms independently.
* **Labels** — tokens, dice results, and treaty states expose text/`aria-label`
  equivalents (not just visual pips) for screen readers.

---

*See also:* [`GAME_DESIGN.md`](./GAME_DESIGN.md) ·
[`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`MAP.md`](./MAP.md) ·
[`FACTIONS.md`](./FACTIONS.md) · [`EVENT_CARDS.md`](./EVENT_CARDS.md)
