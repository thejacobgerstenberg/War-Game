/**
 * ArmiesArrayed — combat.html zone 2: attacker left, defender right, each
 * with crest, role pill, faction swatch + name, unit chips (icon+word+count,
 * Roman numerals per the design contract) and the commander line.
 * Role is triple-channeled: label pill, dice-rim color below, and position —
 * never color alone (mockup legend, callout 2).
 */
import { Faction, UnitType } from "@imperium/shared";
import { CREST_URL, ICON_URL } from "../../../ui";
import { FACTION_SLUG } from "../../../board/types";
import { FACTION_NAME } from "../../uiText";

/**
 * Unit-type display names, in the design vocabulary of lore/ui-text.md and
 * design/mockups/combat.html ("Levies" is the mockup's chip label).
 */
export const UNIT_LABEL: Record<UnitType, string> = {
  [UnitType.LEVY]: "Levies",
  [UnitType.INFANTRY]: "Infantry",
  [UnitType.CAVALRY]: "Cavalry",
  [UnitType.ARCHER]: "Archers",
  [UnitType.SIEGE]: "Siege Engines",
  [UnitType.GALLEY]: "Galleys",
  [UnitType.WARSHIP]: "Warships",
};

/**
 * Commander lines, quoted from the "Ruler (c.1440)" sections of
 * lore/factions/*.md (Hungary uses the war-captain line the combat mockup
 * ships, from lore/factions/hungary.md).
 */
export const COMMANDER_LINE: Record<Faction, string> = {
  [Faction.BYZANTIUM]: "John VIII Palaiologos, Basileus and Autokrator of the Romans",
  [Faction.OTTOMAN]: "Murad II, Sultan of the ghazis",
  [Faction.VENICE]: "Francesco Foscari, Doge of Venice",
  [Faction.GENOA]: "Tommaso di Campofregoso, Doge of Genoa",
  [Faction.HUNGARY]: "John Hunyadi, Voivode of Transylvania and war-captain of the Regnum",
};

export interface ArmySideProps {
  role: "attacker" | "defender";
  faction: Faction | null;
  /** Display name when no seated faction (neutral garrison). */
  fallbackName: string;
  units: Record<UnitType, number>;
  /** Units of this side that fell (post-resolution); omit while pending. */
  fallen?: number;
}

function unitIcon(type: UnitType): string {
  if (type === UnitType.GALLEY || type === UnitType.WARSHIP) return ICON_URL.fleet;
  if (type === UnitType.SIEGE) return ICON_URL.siege;
  return ICON_URL.army;
}

function ArmySide(props: ArmySideProps): JSX.Element {
  const { role, faction, fallbackName, units, fallen } = props;
  const name = faction !== null ? FACTION_NAME[faction] : fallbackName;
  const slug = faction !== null ? FACTION_SLUG[faction] : undefined;
  const rows = Object.values(UnitType)
    .map((t) => ({ type: t, count: units[t] ?? 0 }))
    .filter((r) => r.count > 0);
  return (
    <article
      className={`cbt-army cbt-army--${role}`}
      data-faction={slug}
      aria-label={`${role === "attacker" ? "Attacker" : "Defender"}: ${name}`}
    >
      {faction !== null && (
        <figure className="cbt-army-crest" style={{ margin: 0 }}>
          <img src={CREST_URL[faction]} alt={`Crest of ${name}`} />
        </figure>
      )}
      <div>
        <p className="cbt-army-role">
          {role === "attacker" ? (
            <span className="pill pill--gold">⚔ Attacker</span>
          ) : (
            <span className="pill pill--lapis">⛨ Defender</span>
          )}
        </p>
        <h3>
          {slug !== undefined && (
            <span className="faction-swatch" data-faction={slug} aria-hidden="true" />
          )}{" "}
          {name}
        </h3>
        <div className="cbt-army-units">
          {rows.length === 0 && <span className="rubric">None stand upon the field.</span>}
          {rows.map((r) => (
            <span className="resource-chip" key={r.type}>
              <span className="chip-icon">
                <img src={unitIcon(r.type)} alt="" />
              </span>
              {/* ui-text preamble: "only counters, costs, and tallies wear bare
                  numerals" — unit tallies are tallies (combat.html zone 2 shows
                  "6 Levies"). Roman numerals stay reserved for Round/Era. */}
              <b className="value">{r.count}</b>
              <span className="name">{UNIT_LABEL[r.type]}</span>
            </span>
          ))}
          {fallen !== undefined && fallen > 0 && (
            <span className="pill pill--crimson">{fallen} fall</span>
          )}
        </div>
        {faction !== null && <p className="cbt-commander">{COMMANDER_LINE[faction]}</p>}
      </div>
    </article>
  );
}

export interface ArmiesArrayedProps {
  attacker: ArmySideProps;
  defender: ArmySideProps;
}

/** The two hosts arrayed, attacker · ⚔ · defender. */
export function ArmiesArrayed({ attacker, defender }: ArmiesArrayedProps): JSX.Element {
  return (
    <div className="cbt-armies">
      <ArmySide {...attacker} />
      <span className="cbt-versus" aria-hidden="true">
        ⚔
      </span>
      <ArmySide {...defender} />
    </div>
  );
}
