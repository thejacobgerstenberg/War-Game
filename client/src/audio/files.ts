/**
 * Audio asset inventory + URL resolution — audio/AUDIO_DESIGN.md v1.0 §1/§7.
 *
 * PROVENANCE: the files under client/public/audio/{music,sfx}/ are byte-
 * copies of the repository placeholders audio/music/*.ogg and audio/sfx/*.ogg
 * (procedurally generated original CC0 work, per the spec's placeholder
 * notice). Licensed recordings will replace them later under the SAME
 * filenames, plus AAC fallbacks with the same basenames and a `.m4a`
 * extension — which is why everything here resolves `basename + extension`
 * instead of hard-coding paths (§7).
 */
import type { AudioBus, SfxName } from "./AudioProvider";

/** The three music beds of §1 (stereo loops, streamed via <audio>). */
export type MusicTrackName = "menu_theme" | "campaign_ambient" | "battle_drums";

export const MUSIC_TRACKS: readonly MusicTrackName[] = [
  "menu_theme",
  "campaign_ambient",
  "battle_drums",
];

/** The fixed 14-sfx inventory of §1 (mono one-shots + two state-bound loops). */
export const SFX_NAMES: readonly SfxName[] = [
  "dice_roll",
  "coin_purse",
  "sword_clash",
  "battle_distant",
  "bombard_shot",
  "card_flip",
  "page_turn",
  "quill_scratch",
  "church_bell",
  "horn_fanfare",
  "ship_creak",
  "crowd_murmur",
  "ui_click",
  "defeat_drum",
];

/**
 * Bus routing per §3: `ui_click`/`page_turn` → UI bus; the two state-bound
 * loops → Ambient bus; every remaining sting → SFX bus. (The three music
 * beds route to the Music bus and are not listed here.)
 */
export const SFX_BUS: Record<SfxName, Exclude<AudioBus, "music">> = {
  dice_roll: "sfx",
  coin_purse: "sfx",
  sword_clash: "sfx",
  battle_distant: "ambient",
  bombard_shot: "sfx",
  card_flip: "sfx",
  page_turn: "ui",
  quill_scratch: "sfx",
  church_bell: "sfx",
  horn_fanfare: "sfx",
  ship_creak: "sfx",
  crowd_murmur: "ambient",
  ui_click: "ui",
  defeat_drum: "sfx",
};

/**
 * The two seamless ambient loops of §8. They are state-bound: start when the
 * owning UI opens, stop with a 50 ms fade when it closes — never orphaned.
 */
export const LOOPING_SFX: ReadonlySet<SfxName> = new Set<SfxName>([
  "battle_distant",
  "crowd_murmur",
]);

/**
 * Feature-detect a playable container (§7): prefer OGG Vorbis; fall back to
 * the future `.m4a` AAC siblings; otherwise silence + a console warning —
 * never a crash, never user-agent sniffing.
 */
export function detectPreferredExtension(): ".ogg" | ".m4a" | null {
  if (typeof document === "undefined") return null;
  const probe = document.createElement("audio");
  if (typeof probe.canPlayType !== "function") return null;
  if (probe.canPlayType('audio/ogg; codecs="vorbis"') !== "") return ".ogg";
  if (
    probe.canPlayType('audio/mp4; codecs="mp4a.40.2"') !== "" ||
    probe.canPlayType("audio/aac") !== ""
  ) {
    return ".m4a";
  }
  return null;
}

/** Resolve a music bed URL: basename + preferred extension (§7). */
export function musicUrl(name: MusicTrackName, ext: ".ogg" | ".m4a"): string {
  return `/audio/music/${name}${ext}`;
}

/** Resolve an sfx URL: basename + preferred extension (§7). */
export function sfxUrl(name: SfxName, ext: ".ogg" | ".m4a"): string {
  return `/audio/sfx/${name}${ext}`;
}
