# IMPERIUM: Twilight of Empires — Audio Integration Spec

**Version:** 1.0 · **Date:** 2026-07-11 · **Owner:** Audio integration
**Audience:** Client team. This document is the implementation contract for all in-game audio.

> **Placeholder notice:** Every file listed below is a procedurally generated **placeholder**
> (original CC0 work). Placeholders will be swapped for licensed recordings later under the
> **same filenames**, so the integration contract in this spec is stable — implement against
> the paths and names exactly as given and never hard-code assumptions about content or
> duration of a specific file.

---

## 1. Fixed Asset Inventory

The inventory is **fixed**. Do not add, rename, or remove files without a spec revision.

### Music — stereo OGG Vorbis loops, `audio/music/`

| File | Role |
|---|---|
| `menu_theme.ogg` | Lobby / main menu theme |
| `campaign_ambient.ogg` | In-game ambient bed |
| `battle_drums.ogg` | Battle overlay layer |

### SFX — mono OGG Vorbis, `audio/sfx/` (14 files)

`dice_roll.ogg`, `coin_purse.ogg`, `sword_clash.ogg`, `battle_distant.ogg`,
`bombard_shot.ogg`, `card_flip.ogg`, `page_turn.ogg`, `quill_scratch.ogg`,
`church_bell.ogg`, `horn_fanfare.ogg`, `ship_creak.ogg`, `crowd_murmur.ogg`,
`ui_click.ogg`, `defeat_drum.ogg`.

---

## 2. Event → Sound Mapping

Turn phases: **omen/event card → income → actions → battle → cleanup**.
Bus column refers to the mixer buses in §3. "Sting" = play once; "loop" = looping playback tied to a UI/game state.

| Game event | File | Play mode | Bus | Turn phase(s) |
|---|---|---|---|---|
| Game start / new round begins | `church_bell.ogg` | Sting, once per round start | SFX | Start of omen/event card phase (and game start) |
| Omen / event card revealed | `card_flip.ogg` | Sting | SFX | Omen/event card |
| Browsing cards / rules / log pages | `page_turn.ogg` | Sting per page change | UI | Any phase (UI browsing) |
| Income collected | `coin_purse.ogg` | Sting, once per player collection | SFX | Income |
| Action confirmed / order committed | `quill_scratch.ogg` | Sting | SFX | Actions |
| Generic UI hover / select / button press | `ui_click.ogg` | Sting | UI | All phases |
| Dice rolled | `dice_roll.ogg` | Sting per roll | SFX | Battle (also any phase with a die roll, e.g. omen effects) |
| Battle begins / army engagement | `sword_clash.ogg` | Sting at battle open | SFX | Battle |
| Battle ambience while battle UI is open | `battle_distant.ogg` | Loop while battle UI open; stop on close | Ambient | Battle |
| Siege / bombard action resolved | `bombard_shot.ogg` | Sting per bombard | SFX | Battle (also siege actions declared in Actions) |
| Fleet move confirmed | `ship_creak.ogg` | Sting per fleet move | SFX | Actions |
| Diplomacy screen open | `crowd_murmur.ogg` | Loop while diplomacy screen open; stop on close | Ambient | Actions (also usable between phases) |
| Victory achieved | `horn_fanfare.ogg` | Sting | SFX | Cleanup (end-of-game check) |
| Player eliminated / defeat | `defeat_drum.ogg` | Sting | SFX | Cleanup (elimination check) or immediately in Battle when elimination resolves |

Rules:

- One sting per logical event. If a batch resolves at once (e.g. all players collect income simultaneously), play `coin_purse.ogg` **once**, not per player.
- Loops (`battle_distant`, `crowd_murmur`) are state-bound: start when the owning UI opens, stop (50 ms fade-out to avoid clicks) when it closes. Never leave an orphaned loop running.
- `sword_clash.ogg` sting and `battle_distant.ogg` loop start together when the battle UI opens; the loop continues after the sting ends.

---

## 3. Mixer: Buses, Default Gains, Debounce

One **master** bus with four sub-buses. All values are **linear gains** (not dB) and are the defaults before user adjustment.

| Bus | Default gain | Routes |
|---|---|---|
| Music | **0.40** | `menu_theme`, `campaign_ambient`, `battle_drums` |
| Ambient loops | **0.30** | `battle_distant`, `crowd_murmur` |
| SFX | **0.70** | All remaining stings (`dice_roll`, `coin_purse`, `sword_clash`, `bombard_shot`, `card_flip`, `quill_scratch`, `church_bell`, `horn_fanfare`, `ship_creak`, `defeat_drum`) |
| UI | **0.45** | `ui_click`, `page_turn` |

Master default gain: **1.0**. Effective gain = master × bus × per-playback gain (per-playback defaults to 1.0).

**Debounce rule (hard requirement):** no more than **one instance of the same SFX file may start within 80 ms**. If a second trigger for the same file arrives inside the 80 ms window, drop it (do not queue). Different files are unaffected. Implement as a per-file `lastStartTime` check.

---

## 4. Music State Machine and Crossfades

States: `LOBBY` → `GAME` ⇄ `BATTLE`. Never allow two music tracks at full level simultaneously — every transition below is a crossfade or duck.

| Transition | Behavior |
|---|---|
| App load → `LOBBY` | Start `menu_theme.ogg` looping (after audio unlock, §5). |
| `LOBBY` → `GAME` (game starts) | Crossfade `menu_theme` → `campaign_ambient` over **2.0 s** (equal-power: menu fades 1→0 while ambient fades 0→1 across the same 2.0 s). |
| `GAME` → `BATTLE` (battle UI opens) | Duck `campaign_ambient` to **30%** of its current level over **0.8 s**; start `battle_drums.ogg` at full music-bus level with a **1.0 s** fade-in. Both run on the Music bus; the duck keeps combined level safe. |
| `BATTLE` → `GAME` (battle resolves) | Fade `battle_drums` out over **1.5 s**, then stop it; restore `campaign_ambient` from 30% back to 100% over **1.2 s**. The two ramps may run concurrently. |
| `GAME` → `LOBBY` (leave/end game) | Crossfade `campaign_ambient` (and `battle_drums` if somehow active) → `menu_theme` over 2.0 s. |

Edge cases:

- Battle opens during the lobby→game crossfade: let the 2.0 s crossfade finish targeting `campaign_ambient`, then apply the duck; or shortcut ambient straight to the ducked target — either is acceptable, but do not start `battle_drums` before `menu_theme` is fully out.
- Consecutive battles: if a new battle opens during the 1.5 s `battle_drums` fade-out, cancel the fade-out and ramp `battle_drums` back to full over 1.0 s; re-apply the ambient duck.
- All ramps should be linear gain ramps (`linearRampToValueAtTime` or equivalent).

---

## 5. Mute / Volume UI and Autoplay Unlock

Required controls:

- **Master mute toggle** (hard-mutes the master bus; does not stop or reset playback positions).
- **Music volume slider** (0.0–1.0, scales the Music bus; also apply to Ambient bus unless a separate ambient slider is added later).
- **SFX volume slider** (0.0–1.0, scales the SFX and UI buses).

Persistence: store `{ masterMuted: boolean, musicVolume: number, sfxVolume: number }` in **`localStorage`** (suggested key: `imperium.audio.v1`) and restore on load. Defaults on first run: unmuted, sliders at 1.0 (bus defaults from §3 provide the actual levels).

**Autoplay policy (hard requirement):** browsers block audio until a user gesture. No sound may be scheduled before unlock. Recommended unlock pattern:

1. Create the `AudioContext` at app init (it will be `suspended`).
2. On the **first click/pointerdown/keydown** anywhere in the app, call `audioContext.resume()` (and play a zero-gain buffer as a belt-and-suspenders unlock for older Safari).
3. Only after `resume()` succeeds, start `menu_theme` and mark audio as unlocked.
4. Queue nothing before unlock — events fired pre-unlock are simply not played (no catch-up).

---

## 6. Loading Strategy (Requirement)

- **SFX: preload all at lobby load.** All 14 SFX files are tiny; fetch and decode them into memory (`decodeAudioData` → `AudioBuffer`) as soon as the lobby loads. Total payload is small enough that this must not be lazy.
- **Music: lazy-load.** Music files are the large assets and must **not** be fetched up front:
  - `menu_theme.ogg` — fetch **after the first user gesture** (piggyback on the unlock in §5), then start it.
  - `campaign_ambient.ogg` — fetch **when a game is being created or joined** (lobby "create/join" flow), so it is ready before the 2.0 s crossfade.
  - `battle_drums.ogg` — fetch **on first battle**, or better: **idle-prefetch shortly after game start** so the first battle transition has no network stall. If the file is not ready when a battle opens, skip the drums layer for that battle (still apply the ambient duck) rather than delaying the battle UI.

---

## 7. Format and Playback Technology

- All shipped files are **OGG Vorbis**. **Safari does not reliably decode OGG Vorbis** in either `<audio>` or Web Audio. The client must feature-detect Vorbis support (e.g. `audio.canPlayType('audio/ogg; codecs="vorbis"')` and/or a decode probe) rather than sniffing the user agent.
- When the real licensed assets land, we will ship **AAC/M4A fallbacks alongside the OGGs — same basenames, `.m4a` extension** (e.g. `audio/sfx/dice_roll.m4a`). Build the loader now to resolve `basename + preferredExtension` so the fallback is a config change, not a refactor. Until fallbacks exist, unsupported browsers get silence with a console warning — do not crash.
- **SFX: use the Web Audio API** (`AudioBufferSourceNode` through the §3 gain-node bus graph), not bare `<audio>` elements — required for low-latency stings, per-file debounce, and accurate gain ramps.
- **Music: streaming via `<audio>` elements is fine** (wrap each in a `MediaElementAudioSourceNode` if you want it routed through the master graph; otherwise mirror the bus math on `element.volume`). Streaming avoids decoding whole music files into memory.

---

## 8. Looping Details

| File | Loop handling |
|---|---|
| `battle_distant.ogg` | **Seamless loop** — authored with crossfaded tails. Set `loop = true`; no gap handling needed. |
| `crowd_murmur.ogg` | **Seamless loop** — authored with crossfaded tails. Set `loop = true`; no gap handling needed. |
| `menu_theme.ogg` | Loops at file end. `loop = true`; no gap handling needed. |
| `campaign_ambient.ogg` | Loops at file end. `loop = true`; no gap handling needed. |
| `battle_drums.ogg` | Loops at file end. `loop = true`; no gap handling needed. |

All other SFX are one-shots — never loop them.

---

## 9. Implementation Checklist

- [ ] Gain-node graph: master → {music 0.40, ambient 0.30, sfx 0.70, ui 0.45}.
- [ ] 80 ms same-file SFX debounce.
- [ ] Music state machine with §4 transition timings (2.0 s / 0.8 s duck to 30% / 1.0 s in / 1.5 s out / 1.2 s restore).
- [ ] Mute toggle + music/SFX sliders, persisted to `localStorage`.
- [ ] AudioContext unlock on first user gesture; nothing scheduled before unlock.
- [ ] SFX preloaded at lobby; music lazy-loaded per §6.
- [ ] Vorbis feature detection; loader keyed on basename for future `.m4a` fallbacks.
- [ ] `loop = true` on the five looping files; loops stopped with 50 ms fade when their owning UI closes.
