/**
 * AudioEngine — the WebAudio implementation behind AudioProvider, built to
 * audio/AUDIO_DESIGN.md v1.0:
 *
 *   §3 graph: master → { music .40, ambient .30, sfx .70, ui .45 } with a
 *      hard-mute gain after master (mute never stops or resets playback);
 *   §3 debounce: no second start of the SAME sfx file within 80 ms (drop,
 *      don't queue) — per-file lastStartTime check;
 *   §4 music machine LOBBY → GAME ⇄ BATTLE: 2.0 s equal-power crossfades,
 *      0.8 s duck to 30 %, 1.0 s drums in, 1.5 s drums out, 1.2 s restore;
 *      battle_drums never starts before menu_theme is fully out; a battle
 *      re-opened during the drums fade-out cancels it and ramps back over
 *      1.0 s;
 *   §5 persistence at localStorage "imperium.audio.v1" and gesture unlock:
 *      the AudioContext is created suspended, resumed on the first
 *      pointerdown/keydown (plus a zero-gain buffer for older Safari), and
 *      NOTHING is scheduled before unlock — pre-unlock events are dropped;
 *   §6 loading: all 14 sfx fetched+decoded at app load; music is streamed
 *      via <audio> elements (routed through the graph with
 *      MediaElementAudioSourceNode) and lazy-loaded — menu_theme after the
 *      unlock gesture, campaign_ambient idle-prefetched right after unlock
 *      (so it is ready before the lobby→game crossfade), battle_drums
 *      idle-prefetched shortly after entering GAME;
 *   §8 loops: the five looping files play with loop=true; the two ambient
 *      loops (battle_distant, crowd_murmur) are state-bound and are stopped
 *      with a 50 ms fade when their owning modal closes (observed via the
 *      modal scrim, since the frozen playSfx API has no stop()) or when the
 *      music scene leaves BATTLE / returns to LOBBY.
 *
 * The engine is a framework-free singleton; AudioProvider subscribes via
 * subscribe()/getSnapshot() (useSyncExternalStore-shaped).
 */
import type { AudioBus, MusicScene, SfxName } from "./AudioProvider";
import type { MusicTrackName } from "./files";
import {
  LOOPING_SFX,
  SFX_BUS,
  SFX_NAMES,
  detectPreferredExtension,
  musicUrl,
  sfxUrl,
} from "./files";

/* ---- §3 constants -------------------------------------------------------- */

const DEFAULT_BUS_GAIN: Record<AudioBus, number> = {
  music: 0.4,
  ambient: 0.3,
  sfx: 0.7,
  ui: 0.45,
};
const DEFAULT_MASTER = 1.0;
const SFX_DEBOUNCE_MS = 80;
const LOOP_FADE_S = 0.05; // 50 ms loop fade-out (§2/§8)
const SETTING_RAMP_S = 0.03; // short ramp on slider/mute changes (anti-click)

/* ---- §4 transition timings ---------------------------------------------- */

const XFADE_S = 2.0;
const DUCK_S = 0.8;
const DUCK_LEVEL = 0.3;
const DRUMS_IN_S = 1.0;
const DRUMS_OUT_S = 1.5;
const RESTORE_S = 1.2;

/* ---- §5 persistence ------------------------------------------------------ */

const STORAGE_KEY = "imperium.audio.v1";

interface StoredAudioSettings {
  master: number;
  buses: Record<AudioBus, number>;
  muted: boolean;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function loadSettings(): StoredAudioSettings {
  const fallback: StoredAudioSettings = {
    master: DEFAULT_MASTER,
    buses: { ...DEFAULT_BUS_GAIN },
    muted: false,
  };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    const p = parsed as Partial<StoredAudioSettings>;
    const buses = { ...DEFAULT_BUS_GAIN };
    for (const bus of Object.keys(buses) as AudioBus[]) {
      const v = p.buses?.[bus];
      if (typeof v === "number" && Number.isFinite(v)) buses[bus] = clamp01(v);
    }
    return {
      master:
        typeof p.master === "number" && Number.isFinite(p.master)
          ? clamp01(p.master)
          : DEFAULT_MASTER,
      buses,
      muted: typeof p.muted === "boolean" ? p.muted : false,
    };
  } catch {
    return fallback;
  }
}

/** Read-only view for React (immutable; replaced wholesale on change). */
export interface AudioEngineSnapshot {
  scene: MusicScene;
  muted: boolean;
  master: number;
  volumes: Record<AudioBus, number>;
  /** True once the first user gesture has resumed the AudioContext. */
  unlocked: boolean;
}

interface MusicTrack {
  el: HTMLAudioElement;
  gain: GainNode;
  /** Bumped on every fade so a stale fade-out's pause() can be cancelled. */
  generation: number;
}

interface AmbientLoop {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private muteGain: GainNode | null = null;
  private busGains: Partial<Record<AudioBus, GainNode>> = {};

  private ext: ".ogg" | ".m4a" | null = null;

  private sfxBuffers = new Map<SfxName, AudioBuffer>();
  private sfxFailed = new Set<SfxName>();
  private lastSfxStart = new Map<SfxName, number>();
  private ambientLoops = new Map<SfxName, AmbientLoop>();

  private musicTracks = new Map<MusicTrackName, MusicTrack>();
  /** Epoch ms until which menu_theme is still fading out (§4 edge case). */
  private menuOutUntil = 0;
  private pendingDrumsTimer: number | null = null;

  private scene: MusicScene = "LOBBY";
  private unlocked = false;
  private initialized = false;
  private gameScreenMounted = false;

  private settings: StoredAudioSettings = loadSettings();
  private snapshot: AudioEngineSnapshot;
  private listeners = new Set<() => void>();

  private scrimObserver: MutationObserver | null = null;

  constructor() {
    this.snapshot = this.buildSnapshot();
  }

  /* ---- React subscription (useSyncExternalStore shape) ------------------ */

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AudioEngineSnapshot => this.snapshot;

  private buildSnapshot(): AudioEngineSnapshot {
    return {
      scene: this.scene,
      muted: this.settings.muted,
      master: this.settings.master,
      volumes: { ...this.settings.buses },
      unlocked: this.unlocked,
    };
  }

  private notify(): void {
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l();
  }

  private persist(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage may be unavailable (private mode) — settings stay in memory */
    }
  }

  /* ---- Lifecycle --------------------------------------------------------- */

  /** Idempotent app-load init: graph, sfx preload, unlock listeners. */
  init(): void {
    if (this.initialized || typeof window === "undefined") return;
    this.initialized = true;

    this.ext = detectPreferredExtension();
    if (this.ext === null) {
      // §7: unsupported browsers get silence with a console warning.
      console.warn(
        "[audio] Neither OGG Vorbis nor AAC is decodable here — the court falls silent.",
      );
    }

    const Ctor = window.AudioContext;
    if (typeof Ctor !== "function") {
      console.warn("[audio] Web Audio is unavailable — the court falls silent.");
      return;
    }
    this.ctx = new Ctor(); // created suspended pre-gesture (§5)

    // Graph: buses → master → mute → destination (§3).
    this.masterGain = this.ctx.createGain();
    this.muteGain = this.ctx.createGain();
    this.masterGain.gain.value = this.settings.master;
    this.muteGain.gain.value = this.settings.muted ? 0 : 1;
    this.masterGain.connect(this.muteGain);
    this.muteGain.connect(this.ctx.destination);
    for (const bus of ["music", "ambient", "sfx", "ui"] as const) {
      const g = this.ctx.createGain();
      g.gain.value = this.settings.buses[bus];
      g.connect(this.masterGain);
      this.busGains[bus] = g;
    }

    // §6: preload + decode ALL sfx at app (lobby) load — never lazy.
    void this.preloadAllSfx();

    // §5: unlock on the first pointerdown/keydown anywhere.
    const onGesture = (): void => {
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      void this.unlock();
    };
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);

    // §8: ambient loops are state-bound to their owning modal. The frozen
    // playSfx API has no stop(), so the engine watches the modal scrim
    // (ui/Modal portals a .modal-scrim into <body>) and fades both loops
    // out 50 ms after the last modal closes.
    this.scrimObserver = new MutationObserver(() => {
      if (
        this.ambientLoops.size > 0 &&
        document.querySelector(".modal-scrim") === null
      ) {
        this.stopAmbientLoop("battle_distant");
        this.stopAmbientLoop("crowd_murmur");
      }
    });
    this.scrimObserver.observe(document.body, { childList: true });
  }

  private async unlock(): Promise<void> {
    const ctx = this.ctx;
    if (ctx === null || this.unlocked) return;
    try {
      await ctx.resume();
      // Belt-and-suspenders zero-gain blip for older Safari (§5).
      const blip = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = blip;
      const zero = ctx.createGain();
      zero.gain.value = 0;
      src.connect(zero);
      zero.connect(ctx.destination);
      src.start();
    } catch (err) {
      console.warn("[audio] AudioContext resume failed:", err);
      return;
    }
    this.unlocked = true;
    this.startSceneMusic();
    // §6: idle-prefetch campaign_ambient right after unlock so the
    // lobby→game 2.0 s crossfade never stalls on the network.
    window.setTimeout(() => this.ensureTrack("campaign_ambient"), 2500);
    this.notify();
  }

  /**
   * The Steward's Chamber (SettingsPanel) is mounted for exactly the life of
   * the game screen; it reports that here. A stray setMusicScene("GAME")
   * fired by a modal's unmount cleanup AFTER the player has left the game
   * (React cleanup ordering) is coerced back to LOBBY.
   */
  markGameScreenMounted(mounted: boolean): void {
    this.gameScreenMounted = mounted;
  }

  /* ---- Volumes / mute (§3 + §5) ------------------------------------------ */

  getBusVolume(bus: AudioBus): number {
    return this.settings.buses[bus];
  }

  setBusVolume(bus: AudioBus, value: number): void {
    const v = clamp01(value);
    this.settings.buses[bus] = v;
    const g = this.busGains[bus];
    if (g && this.ctx) this.rampParam(g.gain, v, SETTING_RAMP_S);
    this.persist();
    this.notify();
  }

  getMasterVolume(): number {
    return this.settings.master;
  }

  setMasterVolume(value: number): void {
    const v = clamp01(value);
    this.settings.master = v;
    if (this.masterGain && this.ctx) {
      this.rampParam(this.masterGain.gain, v, SETTING_RAMP_S);
    }
    this.persist();
    this.notify();
  }

  isMuted(): boolean {
    return this.settings.muted;
  }

  /** Hard-mutes the master bus; playback positions are never reset (§5). */
  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    if (this.muteGain && this.ctx) {
      this.rampParam(this.muteGain.gain, muted ? 0 : 1, SETTING_RAMP_S);
    }
    this.persist();
    this.notify();
  }

  /* ---- SFX (§2, §3, §8) --------------------------------------------------- */

  private async preloadAllSfx(): Promise<void> {
    const ctx = this.ctx;
    const ext = this.ext;
    if (ctx === null || ext === null) return;
    await Promise.all(
      SFX_NAMES.map(async (name) => {
        try {
          const res = await fetch(sfxUrl(name, ext));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = await res.arrayBuffer();
          const buffer = await ctx.decodeAudioData(bytes);
          this.sfxBuffers.set(name, buffer);
        } catch (err) {
          this.sfxFailed.add(name);
          console.warn(`[audio] Could not load sfx "${name}":`, err);
        }
      }),
    );
  }

  playSfx(name: SfxName): void {
    const ctx = this.ctx;
    if (ctx === null || !this.unlocked) return; // §5: no pre-unlock catch-up

    // §3 debounce: same file may not start twice within 80 ms — drop.
    const now = performance.now();
    const last = this.lastSfxStart.get(name);
    if (last !== undefined && now - last < SFX_DEBOUNCE_MS) return;

    if (LOOPING_SFX.has(name)) {
      this.startAmbientLoop(name);
      this.lastSfxStart.set(name, now);
      return;
    }

    const buffer = this.sfxBuffers.get(name);
    if (buffer === undefined) return; // not decoded (yet, or failed): silence
    const bus = this.busGains[SFX_BUS[name]];
    if (bus === undefined) return;
    this.lastSfxStart.set(name, now);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(bus);
    source.start();
  }

  /** Start a state-bound ambient loop (idempotent while running). */
  private startAmbientLoop(name: SfxName): void {
    const ctx = this.ctx;
    const buffer = this.sfxBuffers.get(name);
    const bus = this.busGains[SFX_BUS[name]];
    if (ctx === null || buffer === undefined || bus === undefined) return;
    if (this.ambientLoops.has(name)) return;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(bus);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true; // seamless — authored with crossfaded tails (§8)
    source.connect(gain);
    source.start();
    this.ambientLoops.set(name, { source, gain });
  }

  /** Stop a loop with the contractual 50 ms fade-out (§2/§8). */
  private stopAmbientLoop(name: SfxName): void {
    const ctx = this.ctx;
    const loop = this.ambientLoops.get(name);
    if (ctx === null || loop === undefined) return;
    this.ambientLoops.delete(name);
    this.rampParam(loop.gain.gain, 0, LOOP_FADE_S);
    window.setTimeout(() => {
      try {
        loop.source.stop();
      } catch {
        /* already stopped */
      }
      loop.gain.disconnect();
    }, LOOP_FADE_S * 1000 + 30);
  }

  /* ---- Music machine (§4, §6, §7) ----------------------------------------- */

  getScene(): MusicScene {
    return this.scene;
  }

  setScene(next: MusicScene): void {
    // Late "GAME" from a modal unmounting after the game screen is gone.
    const target = next === "GAME" && !this.gameScreenMounted ? "LOBBY" : next;
    if (target === this.scene) return;
    const prev = this.scene;
    this.scene = target;

    if (this.unlocked && this.ctx !== null) {
      this.applySceneTransition(prev, target);
    }
    // Pre-unlock we only record the scene; startSceneMusic() honors it later.
    this.notify();
  }

  private applySceneTransition(prev: MusicScene, next: MusicScene): void {
    this.cancelPendingDrums();

    if (prev === "LOBBY" && next === "GAME") {
      // §4: equal-power 2.0 s crossfade menu_theme → campaign_ambient.
      this.menuOutUntil = Date.now() + XFADE_S * 1000;
      this.fadeTrack("menu_theme", 0, XFADE_S, true);
      this.fadeTrack("campaign_ambient", 1, XFADE_S);
      // §2: the campaign opens on a bell (game start sting).
      this.playSfx("church_bell");
      // §6: idle-prefetch battle_drums so the first battle never stalls.
      window.setTimeout(() => this.ensureTrack("battle_drums"), 3000);
      return;
    }

    if (prev === "GAME" && next === "BATTLE") {
      this.enterBattle();
      return;
    }

    if (prev === "BATTLE" && next === "GAME") {
      // §4: drums out over 1.5 s; ambient restored 30 % → 100 % over 1.2 s.
      this.fadeTrack("battle_drums", 0, DRUMS_OUT_S, true);
      this.fadeTrack("campaign_ambient", 1, RESTORE_S);
      this.stopAmbientLoop("battle_distant");
      return;
    }

    if (next === "LOBBY") {
      // §4: crossfade whatever plays (ambient, and drums if somehow active)
      // back to menu_theme over 2.0 s. Ambient loops die with the game.
      this.fadeTrack("campaign_ambient", 0, XFADE_S, true);
      this.fadeTrack("battle_drums", 0, XFADE_S, true);
      this.fadeTrack("menu_theme", 1, XFADE_S);
      this.stopAmbientLoop("battle_distant");
      this.stopAmbientLoop("crowd_murmur");
      return;
    }

    if (prev === "LOBBY" && next === "BATTLE") {
      // Degenerate jump (no GAME between): treat as lobby-out + battle-in.
      this.menuOutUntil = Date.now() + XFADE_S * 1000;
      this.fadeTrack("menu_theme", 0, XFADE_S, true);
      this.fadeTrack("campaign_ambient", DUCK_LEVEL, XFADE_S);
      this.enterBattle();
    }
  }

  /** GAME → BATTLE: 0.8 s duck to 30 %, drums in over 1.0 s (§4). */
  private enterBattle(): void {
    // Shortcut the ambient straight to the ducked target (spec-sanctioned
    // for battles opening mid-crossfade).
    this.fadeTrack("campaign_ambient", DUCK_LEVEL, DUCK_S);
    // Never start battle_drums before menu_theme is fully out (§4 edge).
    const wait = Math.max(0, this.menuOutUntil - Date.now());
    const start = (): void => {
      this.pendingDrumsTimer = null;
      if (this.scene !== "BATTLE") return; // battle already over
      // Consecutive battles: fadeTrack cancels a running 1.5 s fade-out and
      // ramps back to full from the current level over 1.0 s (§4 edge).
      this.fadeTrack("battle_drums", 1, DRUMS_IN_S);
    };
    if (wait === 0) start();
    else this.pendingDrumsTimer = window.setTimeout(start, wait);
  }

  private cancelPendingDrums(): void {
    if (this.pendingDrumsTimer !== null) {
      window.clearTimeout(this.pendingDrumsTimer);
      this.pendingDrumsTimer = null;
    }
  }

  /** Start the right bed(s) immediately after the unlock gesture (§5). */
  private startSceneMusic(): void {
    if (this.scene === "LOBBY") {
      this.fadeTrack("menu_theme", 1, 0.2);
    } else if (this.scene === "GAME") {
      this.fadeTrack("campaign_ambient", 1, 0.2);
      window.setTimeout(() => this.ensureTrack("battle_drums"), 3000);
    } else {
      this.fadeTrack("campaign_ambient", DUCK_LEVEL, 0.2);
      this.fadeTrack("battle_drums", 1, DRUMS_IN_S);
    }
  }

  /**
   * Lazily create a music track: a streaming <audio> element (§7 — music is
   * never decoded whole into memory) routed through the Music bus via a
   * MediaElementAudioSourceNode, with a per-track gain for crossfades.
   * Creating the element also serves as the §6 idle-prefetch.
   */
  private ensureTrack(name: MusicTrackName): MusicTrack | null {
    const ctx = this.ctx;
    const musicBus = this.busGains.music;
    const ext = this.ext;
    if (ctx === null || musicBus === undefined || ext === null) return null;
    const existing = this.musicTracks.get(name);
    if (existing !== undefined) return existing;
    const el = new Audio(musicUrl(name, ext));
    el.loop = true; // all three beds loop at file end (§8)
    el.preload = "auto";
    const gain = ctx.createGain();
    gain.gain.value = 0;
    ctx.createMediaElementSource(el).connect(gain);
    gain.connect(musicBus);
    const track: MusicTrack = { el, gain, generation: 0 };
    this.musicTracks.set(name, track);
    return track;
  }

  /**
   * Linear-ramp a track to `target` over `seconds` (§4: all ramps are linear
   * gain ramps). `pauseAtEnd` pauses the element once a fade to 0 completes,
   * unless a newer fade superseded it (generation check).
   */
  private fadeTrack(
    name: MusicTrackName,
    target: number,
    seconds: number,
    pauseAtEnd = false,
  ): void {
    // Fading out a track that was never created must not create it.
    if (target === 0 && !this.musicTracks.has(name)) return;
    const track = this.ensureTrack(name);
    if (track === null) return;
    track.generation += 1;
    const generation = track.generation;
    if (target > 0 && track.el.paused) {
      track.el.play().catch((err) => {
        console.warn(`[audio] Could not start music "${name}":`, err);
      });
    }
    this.rampParam(track.gain.gain, target, seconds);
    if (pauseAtEnd && target === 0) {
      window.setTimeout(
        () => {
          if (track.generation === generation) track.el.pause();
        },
        seconds * 1000 + 60,
      );
    }
  }

  private rampParam(param: AudioParam, target: number, seconds: number): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + seconds);
  }
}

let singleton: AudioEngine | null = null;

/** The app-lifetime engine (survives React StrictMode remounts). */
export function getAudioEngine(): AudioEngine {
  if (singleton === null) singleton = new AudioEngine();
  return singleton;
}
