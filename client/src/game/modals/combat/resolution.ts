/**
 * Pure helpers that read the ENGINE'S battle results out of the projected
 * GameState for the battle modal.
 *
 * Result shapes (server/src/engine/combat.ts appendLog calls):
 *  - field battle  type:"battle"  data:{ rounds, winnerId, attackerLosses,
 *      defenderLosses, attackerRouted, defenderRouted, prestigePending, sacked }
 *  - naval battle  type:"battle"  data:{ ..., naval:true } (no rout at sea)
 *  - occupation    type:"battle"  data:{ rounds:0 } message "...occupies..."
 *  - barred        type:"battle"  data:{ rounds:0, amphibiousBarred:true }
 *  - frozen sea    type:"battle"  data:{ rounds:0, naval:true, frozen:true }
 *  - investment    type:"siege"   data:{ invested:true, grainStores }
 *  - siege round   type:"siege"   data:{ wallHp, wallDamage, starved,
 *      resupplied, captured, breached, assaultRounds, prestigePending, sacked }
 * Losses are Record<stackId, unitsRemoved>; a synthetic neutral garrison uses
 * the stack id `garrison-<provinceId>`.
 */
import { UnitType } from "@imperium/shared";
import type {
  Army,
  Fleet,
  GameLogEntry,
  GameState,
  PendingBattle,
} from "@imperium/shared";

export type OutcomeKind =
  | "field"
  | "naval"
  | "occupation"
  | "invest"
  | "barred"
  | "frozen"
  | "siege";

export interface BattleOutcome {
  entry: GameLogEntry;
  kind: OutcomeKind;
  winnerId: string | null;
  rounds: number;
  attackerLosses: number;
  defenderLosses: number;
  attackerRouted: boolean;
  defenderRouted: boolean;
  /** Summed prestige_pending posted to the winner by this resolution. */
  prestige: number;
  captured: boolean;
  sacked: boolean;
  // Siege facts (present for kind "invest"/"siege").
  wallHp?: number;
  wallDamage?: number;
  starved?: number;
  resupplied?: boolean;
  breached?: boolean;
  grainStores?: number;
}

function sumRecord(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (acc, v) => acc + (typeof v === "number" ? v : 0),
    0,
  );
}

/**
 * The chronicle entry that resolved this battle, or null while it is still
 * pending. Matches the last battle/siege entry whose targets include the
 * battle's location and whose actors include the attacker.
 */
export function findResolution(
  state: GameState,
  battle: PendingBattle,
): BattleOutcome | null {
  const locationId = battle.provinceId ?? battle.seaZoneId;
  if (locationId === undefined) return null;
  for (let i = state.log.length - 1; i >= 0; i -= 1) {
    const entry = state.log[i];
    if (entry.type !== "battle" && entry.type !== "siege") continue;
    if (!(entry.targets ?? []).includes(locationId)) continue;
    if (!entry.actors.includes(battle.attackerId)) continue;
    return toOutcome(entry, battle.attackerId);
  }
  return null;
}

function toOutcome(entry: GameLogEntry, attackerId: string): BattleOutcome {
  const data = entry.data ?? {};
  const kind: OutcomeKind =
    data.frozen === true
      ? "frozen"
      : data.amphibiousBarred === true
        ? "barred"
        : data.invested === true
          ? "invest"
          : entry.type === "siege"
            ? "siege"
            : data.naval === true
              ? "naval"
              : typeof data.winnerId === "string" || sumRecord(data.attackerLosses) > 0 || sumRecord(data.defenderLosses) > 0
                ? "field"
                : "occupation";
  return {
    entry,
    kind,
    winnerId:
      typeof data.winnerId === "string"
        ? data.winnerId
        : kind === "occupation"
          ? entry.actors[0] ?? null
          : null,
    rounds: typeof data.rounds === "number" ? data.rounds : 0,
    attackerLosses: sumRecord(data.attackerLosses),
    defenderLosses: sumRecord(data.defenderLosses),
    attackerRouted: data.attackerRouted === true,
    defenderRouted: data.defenderRouted === true,
    prestige: sumRecord(data.prestigePending),
    captured:
      data.captured === true ||
      kind === "occupation" ||
      (kind === "field" &&
        data.winnerId === attackerId &&
        data.attackerRouted !== true),
    sacked: data.sacked === true,
    wallHp: typeof data.wallHp === "number" ? data.wallHp : undefined,
    wallDamage: typeof data.wallDamage === "number" ? data.wallDamage : undefined,
    starved: typeof data.starved === "number" ? data.starved : undefined,
    resupplied: data.resupplied === true ? true : undefined,
    breached: data.breached === true ? true : undefined,
    grainStores: typeof data.grainStores === "number" ? data.grainStores : undefined,
  };
}

/** Aggregate units (generic + variants folded onto their base) for stacks. */
export function aggregateUnits(stacks: readonly (Army | Fleet)[]): Record<UnitType, number> {
  const totals = Object.fromEntries(
    Object.values(UnitType).map((t) => [t, 0]),
  ) as Record<UnitType, number>;
  for (const stack of stacks) {
    for (const t of Object.values(UnitType)) {
      totals[t] += stack.units[t] ?? 0;
    }
    for (const v of stack.variants ?? []) totals[v.base] += v.count;
  }
  return totals;
}

/** Live strength of one battle side, straight from the projected state. */
export function sideStrength(
  state: GameState,
  battle: PendingBattle,
  side: "attacker" | "defender",
): { units: Record<UnitType, number>; total: number; garrison: number } {
  const ids = side === "attacker" ? battle.attackerStackIds : battle.defenderStackIds;
  const pool: (Army | Fleet)[] = battle.seaZoneId ? state.fleets : state.armies;
  const stacks = pool.filter((s) => ids.includes(s.id));
  const units = aggregateUnits(stacks);
  let garrison = 0;
  // A neutral/minor garrison stands in as INFANTRY-equivalent defenders
  // (server/src/engine/combat.ts resolveBattle).
  if (side === "defender" && stacks.length === 0 && battle.provinceId !== undefined) {
    const prov = state.provinces.find((p) => p.id === battle.provinceId);
    garrison = prov?.garrison ?? 0;
    units[UnitType.INFANTRY] += garrison;
  }
  const total = Object.values(units).reduce((a, b) => a + b, 0);
  return { units, total, garrison };
}

/**
 * A side's strength AT THE MOMENT battle was joined, reconstructed after
 * resolution: survivors still on the map plus the engine's reported losses.
 */
export function initialStrength(
  state: GameState,
  battle: PendingBattle,
  side: "attacker" | "defender",
  losses: number,
): number {
  return sideStrength(state, battle, side).total + losses;
}
