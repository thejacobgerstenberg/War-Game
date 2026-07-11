/**
 * IconChip — the icon+word resource chip of the design contract
 * (mockups.css §7, README §3 "The Scribe's Aids"): icon + word + count,
 * always all three — colorblind-safe because the word and glyph carry the
 * meaning, never color alone. `short` marks a store that cannot bear the
 * order being lined up (crimson rim + in-voice reason on hover).
 */
import type { IconName } from "./icons";
import { ICON_URL } from "./icons";

export interface IconChipProps {
  icon: IconName;
  /** The word beside the icon (e.g. "Grain"). */
  label: string;
  /** Counter value; omit for icon+word-only chips. */
  value?: number | string;
  /** Cannot afford the lined-up order (crimson rim). */
  short?: boolean;
  /** In-voice reason shown on hover when short (e.g. "The quarries have given all they have."). */
  shortReason?: string;
  /** Visually hide the word (kept for assistive tech). Use sparingly. */
  hideLabel?: boolean;
  className?: string;
}

export function IconChip(props: IconChipProps): JSX.Element {
  const { icon, label, value, short, shortReason, hideLabel, className } = props;
  return (
    <span
      className={["resource-chip", short ? "is-short" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      title={short ? shortReason : undefined}
    >
      <span className="chip-icon" aria-hidden="true">
        <img src={ICON_URL[icon]} alt="" />
      </span>
      <span className={hideLabel ? "name visually-hidden" : "name"}>{label}</span>
      {value !== undefined && <b className="value">{value}</b>}
    </span>
  );
}
