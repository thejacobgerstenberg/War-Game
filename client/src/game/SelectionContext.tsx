/**
 * SelectionContext — board selection + armed order, shared by the Board,
 * the ProvinceInspector, and the ActionBar.
 *
 * Model (game.html callouts 7/8/11):
 *  - `selection` — the selected province/sea-zone id (gold ring on the map,
 *    fills the province card). Controlled here; the Board is a controlled
 *    component. Escape clears it (the Board handles the key).
 *  - `armedOrder` — which of the seven armable orders is active. Arming an
 *    order sets the map's click-meaning; one at a time.
 *  - `hover` — live HoverInfo from the Board (for coordination like
 *    resource-chip `.is-short` hints); null when the pointer leaves.
 */
import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { HoverInfo } from "../board/types";
import type { OrderKind } from "./types";

export interface SelectionContextValue {
  selection: string | null;
  setSelection: (id: string | null) => void;
  hover: HoverInfo | null;
  setHover: (hover: HoverInfo | null) => void;
  armedOrder: OrderKind | null;
  /** Arm an order (or null to disarm). Arming replaces any armed order. */
  setArmedOrder: (order: OrderKind | null) => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [selection, setSelection] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [armedOrder, setArmedOrder] = useState<OrderKind | null>(null);

  const value = useMemo<SelectionContextValue>(
    () => ({ selection, setSelection, hover, setHover, armedOrder, setArmedOrder }),
    [selection, hover, armedOrder],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** Access board selection state. Must be inside <SelectionProvider>. */
export function useSelection(): SelectionContextValue {
  const value = useContext(SelectionContext);
  if (!value) {
    throw new Error("useSelection must be used within <SelectionProvider>");
  }
  return value;
}
