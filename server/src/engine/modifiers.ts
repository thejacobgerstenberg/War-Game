/**
 * modifiers.ts — the active-modifier side-channel helpers.
 *
 * Event (Omen) cards post {@link ActiveModifier}s onto `state.activeModifiers`;
 * the combat / economy / movement subsystems read them back at the exact point
 * they need the effect. This keeps cards decoupled from the subsystems they
 * touch: a card only knows how to `addModifier`, and each subsystem only knows
 * how to `getModifiers(state, kind, target?)`.
 *
 * All functions are pure: they return a new value / new state and never mutate
 * the input (per the engine purity contract).
 */
import type { ActiveModifier, Faction, GameState } from "@imperium/shared";

/** A target query narrowing which modifiers apply (all fields optional). */
export type ModifierTarget = {
  faction?: Faction;
  provinceId?: string;
  seaZoneId?: string;
};

/**
 * True when `mod` applies to the given `target` query. A modifier with no
 * `target` is global and matches everything. For each key present in the query,
 * the modifier matches when it either does not constrain that key (undefined) or
 * constrains it to the same value.
 */
function appliesTo(mod: ActiveModifier, target?: ModifierTarget): boolean {
  if (!target) return true;
  const t = mod.target;
  if (!t) return true; // global modifier applies to any specific query
  if (target.faction !== undefined && t.faction !== undefined && t.faction !== target.faction) {
    return false;
  }
  if (target.provinceId !== undefined && t.provinceId !== undefined && t.provinceId !== target.provinceId) {
    return false;
  }
  if (target.seaZoneId !== undefined && t.seaZoneId !== undefined && t.seaZoneId !== target.seaZoneId) {
    return false;
  }
  return true;
}

/**
 * All active modifiers of the given `kind`, optionally narrowed to a target
 * (faction / province / sea zone). Read-only; returns a fresh array.
 */
export function getModifiers(
  state: GameState,
  kind: string,
  target?: ModifierTarget,
): ActiveModifier[] {
  return state.activeModifiers.filter(
    (m) => m.kind === kind && appliesTo(m, target),
  );
}

/**
 * Convenience: sum the `value` of every modifier of `kind` matching `target`
 * (missing values count as 0). Handy for additive combat/income tweaks.
 */
export function sumModifierValues(
  state: GameState,
  kind: string,
  target?: ModifierTarget,
): number {
  return getModifiers(state, kind, target).reduce((acc, m) => acc + (m.value ?? 0), 0);
}

/** Append a modifier, returning a new state. Input is not mutated. */
export function addModifier(state: GameState, mod: ActiveModifier): GameState {
  return { ...state, activeModifiers: [...state.activeModifiers, mod] };
}

/** Remove modifiers by id, returning a new state. */
export function removeModifier(state: GameState, id: string): GameState {
  return {
    ...state,
    activeModifiers: state.activeModifiers.filter((m) => m.id !== id),
  };
}

/**
 * Drop modifiers that have lapsed at round cleanup: every `scope: 'round'`
 * modifier, plus any modifier whose `expiresRound` is at or before the current
 * round. `persistent`/`game` modifiers without a timer survive. Returns new state.
 */
export function expireRoundModifiers(state: GameState): GameState {
  const survivors = state.activeModifiers.filter((m) => {
    if (m.scope === "round") return false;
    if (m.expiresRound !== undefined && m.expiresRound <= state.round) return false;
    return true;
  });
  if (survivors.length === state.activeModifiers.length) return state;
  return { ...state, activeModifiers: survivors };
}
