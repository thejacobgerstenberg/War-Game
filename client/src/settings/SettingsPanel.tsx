/**
 * SettingsPanel — "The Steward's Chamber" (lore/ui-text.md §1: Settings =
 * `The Steward's Chamber`, subtitle `Order the court to your liking.`).
 *
 * design/mockups/home.html callout 5: the settings gear opens the Settings
 * modal (sound bus sliders, The Scribe's Aids toggle). README §3 places the
 * colorblind toggle here, and README §5/AUDIO_DESIGN §5 the mute + volume
 * controls. This component renders the in-game door (a gear button docked
 * top-left of the map, mounted by GameBoard) and the modal itself:
 *
 *   - Master mute toggle (hard-mutes the master bus; playback never resets)
 *   - Master + four bus sliders (Music / Ambient / SFX / UI, §3 buses),
 *     persisted at localStorage "imperium.audio.v1"
 *   - "The Scribe's Aids" — heraldic pattern overlays atop faction colors
 *     (README §3), persisted at "imperium.settings.v1" and applied app-wide
 *     (body class + the board's colorblind prop, via settingsStore)
 *
 * The door is mounted in two places: docked top-left of the map by
 * GameBoard, and in the pre-game menu footer (settings/MenuFooter, mounted
 * by App on every non-game screen) so menu_theme can be muted or turned
 * down before a game ever starts — AUDIO_DESIGN §5 makes these controls
 * required, and home.html callout 5 puts the gear on the home screen.
 *
 * When `anchorGameScene` is set (the GameBoard mount), it also anchors the
 * music state machine to the game screen: mounted for exactly the life of
 * GameBoard, it drives LOBBY→GAME on mount and GAME→LOBBY on unmount
 * (AUDIO_DESIGN §4) — battle transitions belong to the combat modal. The
 * pre-game mounts pass `anchorGameScene={false}` and leave the scene alone.
 *
 * Keyboard: the gear is a real button; Modal (ui/Modal) traps focus and
 * closes on Escape; sliders and switches are native inputs.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useAudio } from "../audio/AudioProvider";
import type { AudioBus } from "../audio/AudioProvider";
import { getAudioEngine } from "../audio/engine";
import { Button, Modal, Tooltip } from "../ui";
import { BUTTONS } from "../game/uiText";
import { setColorblind, useUiSettings } from "./settingsStore";
import "./settings.css";

/** lore/ui-text.md §1 — Settings, in voice. */
const CHAMBER_TITLE = "The Steward's Chamber";
/** lore/ui-text.md §1 — the menu subtitle for the Steward's Chamber. */
const CHAMBER_SUBTITLE = "Order the court to your liking.";
/** design/mockups/README.md §3 — the colorblind mode's in-voice name. */
const SCRIBES_AIDS = "The Scribe's Aids";
/** design/mockups/README.md §3, the rule, absolute. */
const SCRIBES_AIDS_GLOSS =
  "Heraldic patterns atop the faction colors — color is never the only channel.";

/** Slider rows: master first, then the §3 buses in spec order. */
const BUS_ROWS: ReadonlyArray<{ bus: AudioBus; label: string }> = [
  { bus: "music", label: "Music" },
  { bus: "ambient", label: "Ambient" },
  { bus: "sfx", label: "SFX" },
  { bus: "ui", label: "UI" },
];

export interface SettingsPanelProps {
  className?: string;
  /**
   * When true (the GameBoard mount's default), this panel's lifetime drives
   * the AUDIO_DESIGN §4 LOBBY↔GAME music machine. Pre-game mounts (the menu
   * footer) pass false so opening the door never starts campaign_ambient.
   */
  anchorGameScene?: boolean;
}

export function SettingsPanel({
  className,
  anchorGameScene = true,
}: SettingsPanelProps): JSX.Element {
  const { playSfx, muted, setMuted, volume, setVolume } = useAudio();
  const { colorblind } = useUiSettings();
  const [open, setOpen] = useState(false);

  const engine = getAudioEngine();
  const master = useSyncExternalStore(engine.subscribe, engine.getSnapshot).master;

  // Music machine anchor (AUDIO_DESIGN §4): the GameBoard mount lives for
  // exactly the life of the game screen. Deliberately mount-only — reacting
  // to context churn here would bounce the scene through LOBBY on every
  // volume change. (anchorGameScene never changes across a mount: the two
  // door sites are distinct component instances.)
  useEffect(() => {
    if (!anchorGameScene) return;
    const e = getAudioEngine();
    e.markGameScreenMounted(true);
    e.setScene("GAME");
    return () => {
      e.markGameScreenMounted(false);
      e.setScene("LOBBY");
    };
    // (mount-only by design; react-hooks/exhaustive-deps is not registered in
    // this repo's eslint config, so no suppression directive is needed)
  }, []);

  return (
    <div className={["set-door-slot", className ?? ""].filter(Boolean).join(" ")}>
      <Tooltip label={`${CHAMBER_TITLE} — ${CHAMBER_SUBTITLE}`}>
        <Button
          variant="quiet"
          className="set-door"
          aria-label={`Open Settings — ${CHAMBER_TITLE}`}
          aria-haspopup="dialog"
          onClick={() => {
            playSfx("ui_click");
            setOpen(true);
          }}
          icon={<span aria-hidden="true">⚙</span>}
        >
          <span className="visually-hidden">Settings</span>
        </Button>
      </Tooltip>

      {open && (
        <Modal
          title={CHAMBER_TITLE}
          onClose={() => {
            playSfx("ui_click");
            setOpen(false);
          }}
        >
          <p className="rubric set-subtitle">{CHAMBER_SUBTITLE}</p>

          <section className="set-section" aria-label="Sound">
            <h3 className="set-heading">Sound</h3>

            {/* AUDIO_DESIGN §5: master mute toggle — hard-mutes the master
                bus without stopping or resetting playback. */}
            <label className="set-switch">
              <input
                type="checkbox"
                checked={muted}
                onChange={(e) => {
                  setMuted(e.target.checked);
                  // Audible only when unmuting — a sealed court stays silent.
                  playSfx("ui_click");
                }}
              />
              <span className="set-switch-label">Mute</span>
              <span className="set-switch-state" aria-hidden="true">
                {muted ? "The court is silenced" : "The court may sound"}
              </span>
            </label>

            {/* Sliders stay live while muted — levels persist and take
                effect the moment the court may sound again. */}
            <VolumeRow
              id="set-vol-master"
              label="Master"
              value={master}
              onChange={(v) => {
                engine.setMasterVolume(v);
                playSfx("ui_click");
              }}
            />
            {BUS_ROWS.map(({ bus, label }) => (
              <VolumeRow
                key={bus}
                id={`set-vol-${bus}`}
                label={label}
                value={volume(bus)}
                onChange={(v) => {
                  setVolume(bus, v);
                  playSfx("ui_click");
                }}
              />
            ))}
          </section>

          <section className="set-section" aria-label={SCRIBES_AIDS}>
            <h3 className="set-heading">{SCRIBES_AIDS}</h3>
            <label className="set-switch">
              <input
                type="checkbox"
                checked={colorblind}
                onChange={(e) => {
                  setColorblind(e.target.checked);
                  playSfx("ui_click");
                }}
              />
              <span className="set-switch-label">Patterned banners</span>
              <span className="set-switch-gloss">{SCRIBES_AIDS_GLOSS}</span>
            </label>
          </section>

          <div className="modal-actions">
            <Button
              variant="quiet"
              onClick={() => {
                playSfx("ui_click");
                setOpen(false);
              }}
            >
              {BUTTONS.close}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface VolumeRowProps {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}

/** One labelled volume slider, 0..1, keyboard-operable (native range). */
function VolumeRow({ id, label, value, onChange }: VolumeRowProps): JSX.Element {
  const percent = Math.round(value * 100);
  return (
    <div className="set-volume-row">
      <label className="set-volume-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="set-volume-slider"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        aria-valuetext={`${percent} of 100`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {/* Counters wear bare numerals (lore/ui-text.md preamble). */}
      <span className="set-volume-value" aria-hidden="true">
        {percent}
      </span>
    </div>
  );
}
