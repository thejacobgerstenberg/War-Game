# Audio Credits & License Manifest — IMPERIUM: Twilight of Empires

**Last updated:** 2026-07-11
**Scope:** every audio file under `audio/music/` and `audio/sfx/`.

This document is both the **license manifest** for the files currently in the repository
(Section 1) and the **sourcing plan** for replacing them with licensed recordings once
network egress to asset sites is available (Section 2), plus the **verification protocol**
the sourcer must follow (Section 3).

> **Summary:** Every audio file currently in this repository is a procedurally synthesized
> **original work**, generated in-repo by the Python scripts in `audio/tools/`
> (numpy DSP, fixed random seeds, fully reproducible). No third-party audio of any kind
> is included. The project dedicates these placeholder files to the public domain (CC0-1.0).

---

## Section 1 — Current files (manifest)

| File | Title | Author | Source | License | Attribution required | Status |
|---|---|---|---|---|---|---|
| `audio/music/menu_theme.ogg` | Menu Theme — Byzantine Modal Hymn (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_music.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/music/campaign_ambient.ogg` | Campaign Ambient Bed (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_music.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/music/battle_drums.ogg` | Battle War Drums (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_music.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/dice_roll.ogg` | Dice Roll (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_impacts.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/sword_clash.ogg` | Sword Clash (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_impacts.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/bombard_shot.ogg` | Great Bombard Shot (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_impacts.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/defeat_drum.ogg` | Defeat Drum (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_impacts.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/church_bell.ogg` | Church Bell (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_tonal.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/horn_fanfare.ogg` | Victory Horn Fanfare (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_tonal.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/coin_purse.ogg` | Coin Purse (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_tonal.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/battle_distant.ogg` | Distant Battle Ambience (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_ambience.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/ship_creak.ogg` | Ship Hull Creak (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_ambience.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/crowd_murmur.ogg` | Council Crowd Murmur (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_ambience.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/card_flip.ogg` | Card Flip (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_paper_ui.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/page_turn.ogg` | Page Turn (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_paper_ui.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/quill_scratch.ogg` | Quill Scratch (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_paper_ui.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |
| `audio/sfx/ui_click.ogg` | UI Click (placeholder) | IMPERIUM audio pipeline (procedurally synthesized, original work) | `audio/tools/gen_paper_ui.py` | CC0-1.0 (dedicated to the public domain by the project) | None | PLACEHOLDER — to be replaced by licensed recording, see Section 2 |

### Manifest verification snapshot (2026-07-11)

All 17 files decoded cleanly (`ffmpeg -v error -i FILE -f null -` → exit 0, no stderr output).
Exact byte sizes and container durations at time of writing:

| File | Bytes | Duration |
|---|---:|---|
| `audio/music/menu_theme.ogg` | 915,082 | 1:30.00 |
| `audio/music/campaign_ambient.ogg` | 1,012,100 | 1:50.00 |
| `audio/music/battle_drums.ogg` | 731,707 | 1:20.90 |
| `audio/sfx/dice_roll.ogg` | 10,218 | 1.20 s |
| `audio/sfx/sword_clash.ogg` | 7,374 | 0.80 s |
| `audio/sfx/bombard_shot.ogg` | 15,818 | 2.00 s |
| `audio/sfx/defeat_drum.ogg` | 7,889 | 1.40 s |
| `audio/sfx/church_bell.ogg` | 22,976 | 3.50 s |
| `audio/sfx/horn_fanfare.ogg` | 18,840 | 2.57 s |
| `audio/sfx/coin_purse.ogg` | 7,184 | 0.70 s |
| `audio/sfx/battle_distant.ogg` | 40,148 | 4.50 s |
| `audio/sfx/ship_creak.ogg` | 27,904 | 3.00 s |
| `audio/sfx/crowd_murmur.ogg` | 41,717 | 4.50 s |
| `audio/sfx/card_flip.ogg` | 5,118 | 0.25 s |
| `audio/sfx/page_turn.ogg` | 8,004 | 0.60 s |
| `audio/sfx/quill_scratch.ogg` | 8,954 | 0.80 s |
| `audio/sfx/ui_click.ogg` | 3,975 | 0.08 s |

---

## Section 2 — Sourcing plan (for when egress opens)

### Why no third-party assets are included

This build environment's egress policy returned **HTTP 403** for every audio asset host
tested — freesound.org, cdn.freesound.org, commons.wikimedia.org, upload.wikimedia.org,
archive.org, incompetech.com, freemusicarchive.org, opengameart.org, and pixabay.com — so
no external file could be downloaded, and, just as importantly, no license statement could
be read and verified on its source page. Assets whose licenses cannot be verified must not
be committed, so all current audio was procedurally synthesized in-repo instead.

> **Everything below is a PLAN, not a record.** No item in this section has been downloaded,
> auditioned, or license-verified. Track and category names are pointers from well-known
> catalogs only; every one is marked **license to verify at download** and must pass the
> Section 3 checklist before it may replace a placeholder. Do not treat anything here as a
> confirmed license or a confirmed match.

### Per-slot replacement plan

#### Music (3 slots)

| Slot (target file) | What to source | Preferred sources | Search terms / known candidates | Acceptable licenses |
|---|---|---|---|---|
| `audio/music/menu_theme.ogg` | Byzantine chant / Orthodox liturgical vocal recording, contemplative, loop-friendly (~90 s usable) | Wikimedia Commons (Byzantine chant categories), Musopen | Commons category searches: "Byzantine chant", "Byzantine music", "Orthodox chant"; Musopen search: "Byzantine", "chant". Note: the *composition* being ancient/PD is not enough — the specific *recording* must carry its own free license. All candidates: license to verify at download | Public domain / CC0 preferred; CC-BY (with attribution); CC-BY-SA only if the team accepts SA terms |
| `audio/music/campaign_ambient.ogg` | Oud / medieval-Mediterranean instrumental, sparse and low-intensity, loopable (~110 s) | Free Music Archive (CC-BY filter), incompetech.com (Kevin MacLeod, CC-BY 4.0) | FMA searches: "oud", "medieval Mediterranean", "Middle Eastern instrumental"; incompetech candidates (Kevin MacLeod titles, license to verify at download): "Desert City", "Ibn Al-Noor", "Tabuk", "Night in Venice" | CC0; CC-BY 3.0/4.0 (with attribution) |
| `audio/music/battle_drums.ogg` | Martial percussion / war-drum ensemble, driving but not melodic, loopable (~80 s) | incompetech.com (Kevin MacLeod, CC-BY 4.0), Free Music Archive | incompetech candidates (license to verify at download): "Drums of the Deep", "Ritual", "Crossing the Chasm"; FMA searches: "war drums", "taiko", "battle percussion" | CC0; CC-BY 3.0/4.0 (with attribution) |

#### SFX (14 slots)

Preferred sources for **all** SFX slots: **freesound.org with the license filter set to CC0**,
plus **opengameart.org** (filter CC0/CC-BY). Do not use search-result badges as license
evidence — open each file's own page (Section 3).

| Slot (target file) | What to source | Preferred sources | Search terms / known candidates | Acceptable licenses |
|---|---|---|---|---|
| `audio/sfx/dice_roll.ogg` | Several dice tumbling on a wooden table, ~1–1.5 s | freesound.org (CC0 filter), opengameart.org | "dice roll wood", "dice tray", "board game dice" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/sword_clash.ogg` | Single metallic blade-on-blade clash, ~0.5–1 s | freesound.org (CC0 filter), opengameart.org | "sword clash", "sword hit metal", "blade clang" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/bombard_shot.ogg` | Deep black-powder cannon / bombard boom with tail, ~2 s | freesound.org (CC0 filter), opengameart.org | "cannon shot", "black powder cannon", "mortar boom" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/defeat_drum.ogg` | Two somber low tom/bass-drum hits, ~1.5 s | freesound.org (CC0 filter), opengameart.org | "low tom hit", "funeral drum", "bass drum somber" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/church_bell.ogg` | Single large church bell strike, left to ring, ~3–4 s | freesound.org (CC0 filter), opengameart.org | "church bell single", "bell toll", "cathedral bell" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/horn_fanfare.ogg` | Short brass/natural-horn victory fanfare, ~2–3 s | freesound.org (CC0 filter), opengameart.org | "horn fanfare", "trumpet fanfare short", "medieval fanfare" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/coin_purse.ogg` | Handful of coins dropped/jingled, ~0.5–1 s | freesound.org (CC0 filter), opengameart.org | "coins purse", "coin pouch", "gold coins handful" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/battle_distant.ogg` | Distant battle rumble (shouts, clashes, low booms), seamless loop, ~4–6 s | freesound.org (CC0 filter), opengameart.org | "distant battle", "battle ambience far", "war ambience loop" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/ship_creak.ogg` | Wooden ship hull creaking at sea, ~3 s | freesound.org (CC0 filter), opengameart.org | "ship creak", "wooden hull creak", "boat rigging creak" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/crowd_murmur.ogg` | Indoor crowd/council-hall murmur (no intelligible modern speech), seamless loop, ~4–6 s | freesound.org (CC0 filter), opengameart.org | "crowd murmur indoor", "walla", "hall chatter loop" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/card_flip.ogg` | Crisp single playing-card flip/snap, ~0.2–0.3 s | freesound.org (CC0 filter), opengameart.org | "card flip", "card snap", "playing card deal" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/page_turn.ogg` | Soft paper page turn, ~0.5–0.8 s | freesound.org (CC0 filter), opengameart.org | "page turn", "paper flip soft", "book page" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/quill_scratch.ogg` | Quill/pen scratching on parchment, ~0.8–1 s | freesound.org (CC0 filter), opengameart.org | "quill writing", "pen scratch paper", "writing parchment" | CC0 preferred; CC-BY (with attribution) |
| `audio/sfx/ui_click.ogg` | Very short soft/woody UI tick, ~0.05–0.1 s | freesound.org (CC0 filter), opengameart.org | "ui click soft", "button click short", "wood tick" | CC0 preferred; CC-BY (with attribution) |

---

## Section 3 — License verification checklist

Follow this protocol **per file**, without exception, before a downloaded asset may replace
a placeholder:

1. Open the file's **own source page** (the individual sound/track page, not a search
   results list) and confirm the license label stated there. A license badge shown in
   search results or an aggregator listing does **not** count as verification.
2. Record into the Section 1 manifest table: title, author, **exact license + version**
   (e.g. "CC-BY 4.0", not just "CC"), the source URL of the file's own page, and the
   download date. Change the row's Status from PLACEHOLDER to LICENSED.
3. Save a screenshot **and/or** a web-archive link (e.g. Wayback Machine snapshot) of the
   page showing the license statement, and store the reference alongside this manifest.
4. For CC-BY (any version): copy the complete required attribution string (author, title,
   source, license, and any modification note) into the manifest table **and** flag the
   entry for inclusion on the in-game credits screen.
5. If the license cannot be confirmed on the source page — missing, ambiguous, contradictory,
   or the page is unreachable — **discard the file**. Do not commit it, do not "verify later".
6. Re-encode the accepted file to OGG Vorbis per the project pipeline (44100 Hz,
   peak-normalized to -1 dBFS, attack within the first 10 ms, target duration and size
   budget for the slot), re-run the audio QA verification pass (clean
   `ffmpeg -v error -i FILE -f null -` decode, duration and size checks), and update
   `audio/preview.html` so the preview page reflects the new asset.
