/**
 * MenuFooter — the pre-game site footer (design/mockups/home.html, zone 5):
 * version line plus the settings gear. Mounted by App on every non-game
 * screen (Home / CreateJoin / FactionPick / Lobby) so the Steward's Chamber
 * — master mute, the bus sliders, and The Scribe's Aids — is reachable
 * before a game starts. AUDIO_DESIGN §5 makes the mute + volume controls
 * required, and menu_theme begins on the first gesture on the home screen;
 * without this door there would be no way to silence it until in-game.
 *
 * Copy is verbatim from design/mockups/home.html's footer. The door passes
 * anchorGameScene={false}: pre-game mounts must not drive the LOBBY→GAME
 * music transition (that anchor belongs to the GameBoard mount alone).
 */
import { SettingsPanel } from "./SettingsPanel";
import "./settings.css";

export function MenuFooter(): JSX.Element {
  return (
    <footer className="set-menu-footer">
      <p className="set-menu-footer-line">
        Twilight of Empires · a chronicle in the making ·{" "}
        {/* Counters wear bare numerals (lore/ui-text.md preamble). */}
        <span className="set-menu-footer-version">v0.1.0 “Golden Horn”</span> ·{" "}
        <i>the scribes beg pardon for all errors of the pen.</i>
      </p>
      <SettingsPanel anchorGameScene={false} className="set-door-slot--inline" />
    </footer>
  );
}
