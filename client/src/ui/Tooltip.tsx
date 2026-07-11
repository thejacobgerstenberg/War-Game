/**
 * Tooltip — a one-line in-voice gloss shown on hover AND keyboard focus
 * (nothing is hover-only; touch parity comes from focus/long-press on the
 * trigger). The trigger is wrapped; the bubble is aria-described.
 */
import { useId, useState } from "react";
import type { ReactNode } from "react";

export interface TooltipProps {
  /** The in-voice tooltip line (real copy from lore/ui-text.md). */
  label: string;
  /** The trigger element(s). Focusable children announce the tip themselves. */
  children: ReactNode;
  className?: string;
}

export function Tooltip(props: TooltipProps): JSX.Element {
  const { label, children, className } = props;
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className={["ui-tooltip-anchor", className ?? ""].filter(Boolean).join(" ")}
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span role="tooltip" id={id} className="ui-tooltip">
          {label}
        </span>
      )}
    </span>
  );
}
