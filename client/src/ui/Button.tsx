/**
 * Button — the seal-press button of the design contract.
 *
 * States (art/ui/button-*.svg + design/mockups/README interaction
 * principles, rendered in CSS rather than bitmap chrome):
 *   normal   — vellum ground, ink border, hard offset shadow
 *   hover    — 2px --gold ring (also :focus-visible, from tokens.css)
 *   pressed  — 2px translate, shadow collapses ("the seal comes down")
 *   disabled — opacity .45 + an in-voice reason on hover (`disabledReason`)
 *
 * Selected (`selected`) renders gold fill + ink text and sets aria-pressed;
 * callers must ALSO mark selection with a glyph/label — never color alone.
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "default" | "primary" | "quiet" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Toggle-style selection: gold fill + aria-pressed. */
  selected?: boolean;
  /**
   * In-voice reason the order is unavailable (e.g. "The levies are spent.").
   * When set, the button LOOKS and ACTS disabled but stays focusable so the
   * reason is keyboard-discoverable (aria-disabled + title).
   */
  disabledReason?: string;
  /** Optional leading glyph (e.g. an <img> from ICON_URL). */
  icon?: ReactNode;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "",
  primary: "btn--primary",
  quiet: "btn--quiet",
  danger: "btn--danger",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    const {
      variant = "default",
      selected,
      disabledReason,
      icon,
      children,
      className,
      onClick,
      title,
      type,
      ...rest
    } = props;

    const softDisabled = disabledReason !== undefined;
    const classes = ["btn", VARIANT_CLASS[variant], className]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={classes}
        aria-pressed={selected === undefined ? undefined : selected}
        aria-disabled={softDisabled ? true : undefined}
        title={softDisabled ? disabledReason : title}
        onClick={softDisabled ? (e) => e.preventDefault() : onClick}
        {...(selected ? { "data-selected": "true" } : {})}
        {...rest}
      >
        {icon !== undefined && (
          <span className="btn-glyph" aria-hidden="true">
            {icon}
          </span>
        )}
        {children}
      </button>
    );
  },
);
