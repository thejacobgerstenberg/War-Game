/**
 * PipBudget — the deed pips of the action bar (game.html callout 11):
 * four per campaign, spent pips hollow, caption in Roman numerals
 * ("III of IV remain"). Color is never the only channel: filled/hollow +
 * the caption carry the count.
 */
import { toRoman } from "./format";

export interface PipBudgetProps {
  /** Total budget for the turn (the standing rule: 4). */
  total: number;
  /** Deeds still available. */
  remaining: number;
  /** Leading label; defaults to the contract's "Deeds this campaign". */
  label?: string;
  className?: string;
}

export function PipBudget(props: PipBudgetProps): JSX.Element {
  const { total, remaining, label = "Deeds this campaign", className } = props;
  const clamped = Math.max(0, Math.min(remaining, total));
  const remainRoman = clamped === 0 ? "nought" : toRoman(clamped);
  return (
    <div
      className={["action-budget", className ?? ""].filter(Boolean).join(" ")}
      aria-label={`Deeds remaining this campaign: ${clamped} of ${total}`}
    >
      {label}
      {Array.from({ length: total }, (_, i) => {
        const spent = i < total - clamped;
        return (
          <span
            key={i}
            className={`pip${spent ? " is-spent" : ""}`}
            title={spent ? "Spent" : "Remaining"}
          />
        );
      })}
      <span>
        {remainRoman} of {toRoman(total)} remain
      </span>
    </div>
  );
}
