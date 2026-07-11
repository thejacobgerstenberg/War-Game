/**
 * AudioProvider — the real audio engine binding, implementing
 * audio/AUDIO_DESIGN.md v1.0 (see client/src/audio/engine.ts for the
 * WebAudio graph, crossfade machine, debounce, persistence and unlock).
 *
 * The exported types and AudioApi below are the FROZEN contract the
 * foundation stub declared — every feature area already calls them. Do not
 * change signatures without updating every caller listed in HANDOFF.md.
 *
 *   - music scenes LOBBY -> GAME <-> BATTLE with §4 crossfades
 *   - buses: Music .40, Ambient .30, SFX .70, UI .45 (master 1.0)
 *   - 80 ms same-file debounce on sfx
 *   - settings persisted at localStorage "imperium.audio.v1"
 *   - AudioContext unlocked on first user gesture; nothing plays before
 *
 * Files are served from client/public/audio/{music,sfx}/ — byte-copies of
 * the repo placeholders (provenance: client/src/audio/files.ts).
 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { getAudioEngine } from "./engine";

/** The three music scenes of AUDIO_DESIGN §4. */
export type MusicScene = "LOBBY" | "GAME" | "BATTLE";

/** The fixed 14-sfx inventory of AUDIO_DESIGN §1. */
export type SfxName =
  | "dice_roll"
  | "coin_purse"
  | "sword_clash"
  | "battle_distant"
  | "bombard_shot"
  | "card_flip"
  | "page_turn"
  | "quill_scratch"
  | "church_bell"
  | "horn_fanfare"
  | "ship_creak"
  | "crowd_murmur"
  | "ui_click"
  | "defeat_drum";

/** Mixer buses of AUDIO_DESIGN §3. */
export type AudioBus = "music" | "ambient" | "sfx" | "ui";

export interface AudioApi {
  /** Fire a one-shot sound effect (subject to the 80ms debounce). */
  playSfx: (name: SfxName) => void;
  /** Crossfade the music state machine to a scene. */
  setMusicScene: (scene: MusicScene) => void;
  musicScene: MusicScene;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  /** Per-bus volume, 0..1. */
  volume: (bus: AudioBus) => number;
  setVolume: (bus: AudioBus, value: number) => void;
}

const AudioContextReact = createContext<AudioApi | null>(null);

export function AudioProvider({ children }: { children: ReactNode }): JSX.Element {
  const engine = getAudioEngine();

  // App-load init (§6: sfx preload; §5: unlock listeners). The engine is an
  // app-lifetime singleton and init() is idempotent, so React 18 StrictMode
  // double-mounting is harmless.
  useEffect(() => {
    engine.init();
  }, [engine]);

  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  const api = useMemo<AudioApi>(
    () => ({
      playSfx: (name) => engine.playSfx(name),
      setMusicScene: (scene) => engine.setScene(scene),
      musicScene: snapshot.scene,
      muted: snapshot.muted,
      setMuted: (muted) => engine.setMuted(muted),
      volume: (bus) => snapshot.volumes[bus],
      setVolume: (bus, value) => engine.setBusVolume(bus, value),
    }),
    [engine, snapshot],
  );

  return <AudioContextReact.Provider value={api}>{children}</AudioContextReact.Provider>;
}

/** Access the audio engine. Must be rendered inside <AudioProvider>. */
export function useAudio(): AudioApi {
  const api = useContext(AudioContextReact);
  if (!api) {
    throw new Error("useAudio must be used within <AudioProvider>");
  }
  return api;
}
