/**
 * DiceCascade — combat.html zone 3: attacker's dice (gold-rimmed) above the
 * reckoning strip, defender's dice (lapis-rimmed) below. One die per levy,
 * capped for readability; each die carries a verdict label with a glyph
 * (⚔ hit, · miss) so color is never the only channel. Faces come from the
 * vendored art/ui/dice-1..6.svg.
 *
 * Face values are DERIVED deterministically from the engine's real result
 * (see combat/dice.ts header): the projected state carries only aggregate
 * hits/casualties, never per-die values — the counts here are engine truth,
 * the pips a stable presentation of it.
 */
import { DICE_URL, MAX_DICE_PER_ROW, deriveDice } from "./dice";

export interface DiceRowSpec {
  /** Dice cast (units that fought), before the display cap. */
  count: number;
  /** Hits that stood (enemy units felled) — engine truth. */
  hits: number;
  /** Stable seed for face derivation (battle id + side). */
  seed: string;
}

function DiceRow(props: {
  spec: DiceRowSpec;
  side: "attacker" | "defender";
  label: string;
  rolling: boolean;
}): JSX.Element {
  const { spec, side, label, rolling } = props;
  const dice = deriveDice(spec.seed, spec.count, spec.hits);
  const overflow = Math.max(0, spec.count - MAX_DICE_PER_ROW);
  return (
    <div className={`cbt-dice-row cbt-dice-row--${side}`} role="group" aria-label={label}>
      {dice.map((d, i) => (
        <span className="cbt-die-slot" key={i}>
          <span
            className={`cbt-die${rolling ? " is-rolling" : ""}`}
            role="img"
            aria-label={`${side === "attacker" ? "Attacker" : "Defender"} die: ${d.value} — ${
              d.hit ? "a hit" : "a miss"
            }`}
            style={{ animationDelay: rolling ? `${i * 60}ms` : undefined }}
          >
            <img src={DICE_URL[d.value]} alt="" />
          </span>
          <span className={`cbt-die-verdict${d.hit ? "" : " is-miss"}`} aria-hidden="true">
            {d.hit ? "⚔ Hit" : "· Miss"}
          </span>
        </span>
      ))}
      {overflow > 0 && (
        <span className="cbt-dice-more">…and {overflow} more dice beyond the table's edge</span>
      )}
    </div>
  );
}

export interface DiceCascadeProps {
  attacker: DiceRowSpec;
  defender: DiceRowSpec;
  attackerName: string;
  defenderName: string;
  /** True while the tumble animation plays (≤400ms per die). */
  rolling: boolean;
  /** Extra reckoning lines (rout, pursuit, sack…). */
  notes?: string[];
  /** Show the reckoning strip (revealed a beat after the dice). */
  showReckoning: boolean;
}

/** Number words for the reckoning sentence, per the mockup's diction. */
function strikes(n: number): string {
  if (n === 0) return "not at all";
  if (n === 1) return "once";
  if (n === 2) return "twice";
  if (n === 3) return "thrice";
  return `${n} times`;
}

export function DiceCascade(props: DiceCascadeProps): JSX.Element {
  const { attacker, defender, attackerName, defenderName, rolling, notes, showReckoning } =
    props;
  return (
    <div>
      <DiceRow
        spec={attacker}
        side="attacker"
        label={`Attacker's dice — ${attackerName}, gold-rimmed`}
        rolling={rolling}
      />
      {showReckoning && (
        <div className="cbt-reckoning" aria-label="The reckoning of this battle">
          <p>
            <b>The attacker strikes {strikes(attacker.hits)}</b> —{" "}
            <b>
              {attacker.hits === 1 ? "one hit stands." : `${attacker.hits} hits stand.`}
            </b>
          </p>
          <p>
            <b>The defender strikes {strikes(defender.hits)}</b> —{" "}
            <b>
              {defender.hits === 1 ? "one hit stands." : `${defender.hits} hits stand.`}
            </b>
          </p>
          {(notes ?? []).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p style={{ fontStyle: "italic" }}>
            A die of five or six strikes home. Each hit that stands fells one levy.
          </p>
          <div className="cbt-tally">
            <span className="pill pill--gold">
              ⚔ Attacker · {attacker.hits} {attacker.hits === 1 ? "hit stands" : "hits stand"}
            </span>
            <span className="pill pill--lapis">
              ⚔ Defender · {defender.hits} {defender.hits === 1 ? "hit stands" : "hits stand"}
            </span>
          </div>
        </div>
      )}
      <DiceRow
        spec={defender}
        side="defender"
        label={`Defender's dice — ${defenderName}, lapis-rimmed`}
        rolling={rolling}
      />
    </div>
  );
}
