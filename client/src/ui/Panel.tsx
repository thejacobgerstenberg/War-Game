/**
 * Panel — the vellum surface of the design contract (mockups.css §5).
 * Variants: vellum (default), parchment, porphyry (dark chrome with gold rim).
 */
import type { HTMLAttributes, ReactNode } from "react";

export type PanelVariant = "vellum" | "parchment" | "porphyry";

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  variant?: PanelVariant;
  /** Small-caps gilded title rendered as the panel's heading. */
  title?: string;
  /** Accessible label when there is no visible title. */
  ariaLabel?: string;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<PanelVariant, string> = {
  vellum: "",
  parchment: "panel--parchment",
  porphyry: "panel--porphyry",
};

export function Panel(props: PanelProps): JSX.Element {
  const { variant = "vellum", title, ariaLabel, children, className, ...rest } = props;
  const classes = ["panel", VARIANT_CLASS[variant], className].filter(Boolean).join(" ");
  return (
    <section className={classes} aria-label={ariaLabel ?? title} {...rest}>
      {title !== undefined && <h2 className="panel-title">{title}</h2>}
      {children}
    </section>
  );
}
