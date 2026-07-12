/**
 * gauntletHarness.ts — the INTEGRATION GAUNTLET driver + invariant checker.
 *
 * NEW file. Does NOT touch engine source. It drives full IMPERIUM games with
 * deterministic bots and asserts a battery of cross-cutting invariants after
 * every applied mutation. Shared by:
 *   - server/src/engine/__tests__/gauntlet.test.ts  (fast CI subset)
 *   - server/scripts/gauntlet.mjs                   (heavy standalone 200-game fuzz)
 *
 * Classification of failures (kept strict so we only flag real engine bugs):
 *   - A candidate action that throws `EngineError` is an EXPECTED legality probe
 *     result (the bot uses the engine's own validation to stay legal) — NOT a bug.
 *   - `applyAction`/`advancePhase` throwing a NON-EngineError (TypeError, etc.) is
 *     a CRASH bug (recorded with the phase/round/action).
 *   - An invariant that fails after a SUCCESSFUL mutation is a VIOLATION (recorded).
 *   - The phase machine failing to progress within the step budget is a DEADLOCK.
 */
import {
  Faction,
  GamePhase,
  BuildingType,
  TerrainType,
  TreatyType,
  SpyMission,
  UnitType,
  type GameAction,
  type GameState,
  type Army,
  type Fleet,
  type Player,
  type Province,
} from "@imperium/shared";
import { createInitialState, type SeatInput } from "../gameState.js";
import { applyAction, EngineError } from "../actions.js";
import { advancePhase } from "../roundLoop.js";
import { neighborsOf } from "../adjacency.js";
import { STACKING, BUILDING_COSTS, UNIT_STATS, ROUNDS } from "../balance.js";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — the harness never touches Math.random.
// ---------------------------------------------------------------------------
export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(rng: Rng, arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------
const FACTION_ORDER: Faction[] = [
  Faction.BYZANTIUM,
  Faction.OTTOMAN,
  Faction.VENICE,
  Faction.GENOA,
  Faction.HUNGARY,
];
const NAMES = ["Basil", "Murad", "Dandolo", "Doria", "Hunyadi"];

export function makeSeats(numPlayers: number): SeatInput[] {
  const n = Math.max(2, Math.min(5, numPlayers));
  const seats: SeatInput[] = [];
  for (let i = 0; i < n; i += 1) {
    seats.push({
      id: `p${i + 1}`,
      name: NAMES[i],
      faction: FACTION_ORDER[i],
      isHost: i === 0,
    });
  }
  return seats;
}

export type Strategy = "aggressive" | "trader" | "turtle" | "random";

// ---------------------------------------------------------------------------
// Small state helpers (mirror the engine's own predicates — read only)
// ---------------------------------------------------------------------------
const RESOURCE_KEYS = ["gold", "grain", "timber", "marble", "faith"] as const;
type ResKey = (typeof RESOURCE_KEYS)[number];

function realCount(stack: Army | Fleet): number {
  let n = 0;
  for (const t of Object.values(UnitType)) n += stack.units[t] ?? 0;
  for (const v of stack.variants ?? []) n += v.count;
  return n;
}
function provinceById(state: GameState, id: string): Province | undefined {
  return state.provinces.find((p) => p.id === id);
}
function isSeaZone(state: GameState, id: string): boolean {
  return state.seaZones.some((z) => z.id === id);
}
function isCityProvince(prov: Province): boolean {
  return prov.terrain === TerrainType.CITY || prov.isCapitalOf !== undefined;
}
function canAfford(player: Player, cost: Partial<Record<ResKey, number>>): boolean {
  return RESOURCE_KEYS.every((k) => player.treasury[k] >= (cost[k] ?? 0));
}
function playerById(state: GameState, id: string): Player {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new Error(`harness: no player ${id}`);
  return p;
}

// ---------------------------------------------------------------------------
// Candidate action generation (only BUDGETED action types — so the driver's
// "spend down the budget" loop always terminates). Every candidate is
// pre-filtered to be *plausibly* legal; the engine's validation is the final
// arbiter (an EngineError just means "try the next candidate").
// ---------------------------------------------------------------------------
function moveCandidates(state: GameState, player: Player): GameAction[] {
  const out: GameAction[] = [];
  for (const army of state.armies) {
    if (army.ownerId !== player.id || realCount(army) === 0) continue;
    for (const nb of neighborsOf(army.locationId)) {
      // Land armies only step onto land provinces (never a sea zone — that needs
      // a transport; the bot stays strictly legal).
      if (!provinceById(state, nb)) continue;
      out.push({ type: "MOVE", player: player.id, stackId: army.id, toId: nb });
    }
  }
  for (const fleet of state.fleets) {
    if (fleet.ownerId !== player.id || realCount(fleet) === 0) continue;
    for (const nb of neighborsOf(fleet.locationId)) {
      if (!isSeaZone(state, nb)) continue;
      out.push({ type: "MOVE", player: player.id, stackId: fleet.id, toId: nb, naval: true });
    }
  }
  return out;
}

function recruitCandidates(state: GameState, player: Player): GameAction[] {
  const out: GameAction[] = [];
  for (const prov of state.provinces) {
    if (prov.ownerId !== player.id) continue;
    const isCity = prov.terrain === TerrainType.CITY;
    const isCapital = prov.isCapitalOf !== undefined;
    const canLand = isCapital || isCity || prov.buildings.includes(BuildingType.BARRACKS);
    if (canLand) {
      // Cheapest units first so the bot can usually afford something.
      if (canAfford(player, UNIT_STATS[UnitType.LEVY].cost)) {
        out.push({ type: "RECRUIT", player: player.id, provinceId: prov.id, units: { [UnitType.LEVY]: 1 } });
      }
      if (canAfford(player, UNIT_STATS[UnitType.INFANTRY].cost)) {
        out.push({ type: "RECRUIT", player: player.id, provinceId: prov.id, units: { [UnitType.INFANTRY]: 1 } });
      }
      if (canAfford(player, UNIT_STATS[UnitType.ARCHER].cost)) {
        out.push({ type: "RECRUIT", player: player.id, provinceId: prov.id, units: { [UnitType.ARCHER]: 1 } });
      }
      if (canAfford(player, UNIT_STATS[UnitType.CAVALRY].cost)) {
        out.push({ type: "RECRUIT", player: player.id, provinceId: prov.id, units: { [UnitType.CAVALRY]: 1 } });
      }
    }
    if (prov.buildings.includes(BuildingType.SHIPYARD) && canAfford(player, UNIT_STATS[UnitType.GALLEY].cost)) {
      out.push({ type: "RECRUIT", player: player.id, provinceId: prov.id, units: { [UnitType.GALLEY]: 1 } });
    }
  }
  return out;
}

function buildCandidates(state: GameState, player: Player): GameAction[] {
  const out: GameAction[] = [];
  const buildings = Object.values(BuildingType);
  for (const prov of state.provinces) {
    if (prov.ownerId !== player.id) continue;
    for (const b of buildings) {
      if (prov.buildings.includes(b)) continue;
      if (!canAfford(player, BUILDING_COSTS[b] as Partial<Record<ResKey, number>>)) continue;
      out.push({ type: "BUILD", player: player.id, provinceId: prov.id, building: b });
    }
  }
  return out;
}

function tradeCandidates(_state: GameState, player: Player): GameAction[] {
  const out: GameAction[] = [];
  // Simple, ratio-safe CONVERTs: give 2 of a plentiful resource for 1 of another.
  const rich = RESOURCE_KEYS.filter((k) => k !== "faith" && player.treasury[k] >= 2);
  for (const g of rich) {
    for (const want of RESOURCE_KEYS) {
      if (want === g || want === "faith") continue;
      out.push({
        type: "TRADE",
        player: player.id,
        trade: { kind: "CONVERT", give: { [g]: 2 }, get: { [want]: 1 } },
      });
    }
  }
  return out;
}

function diplomacyCandidates(state: GameState, player: Player): GameAction[] {
  const out: GameAction[] = [];
  for (const other of state.players) {
    if (other.id === player.id) continue;
    out.push({
      type: "DIPLOMACY",
      player: player.id,
      diplomacy: { kind: "PROPOSE", treatyType: TreatyType.NAP, targetPlayerId: other.id },
    });
  }
  return out;
}

function vassalizeCandidates(state: GameState, player: Player): GameAction[] {
  const out: GameAction[] = [];
  for (const m of state.minors) {
    if (m.vassalOf === player.id || m.conquered) continue;
    out.push({ type: "VASSALIZE", player: player.id, minorId: m.id });
  }
  return out;
}

function spyCandidates(state: GameState, player: Player): GameAction[] {
  const out: GameAction[] = [];
  if (player.treasury.gold < 3) return out;
  for (const other of state.players) {
    if (other.id === player.id) continue;
    out.push({ type: "SPY", player: player.id, mission: SpyMission.OMEN, targetPlayerId: other.id });
  }
  return out;
}

function declareWarCandidates(state: GameState, player: Player): GameAction[] {
  const out: GameAction[] = [];
  for (const other of state.players) {
    if (other.id === player.id || !other.faction) continue;
    out.push({ type: "DECLARE_WAR", player: player.id, target: other.faction });
  }
  return out;
}

/**
 * SIEGE_ASSAULT candidates (marshal Stage B "chosen assault"): sieges no longer
 * auto-assault every round — combat storms the walls ONLY for sieges whose
 * besieger DECLARED an assault this round via the budgeted SIEGE_ASSAULT action.
 * Without these candidates a besieging bot would only ever starve cities out
 * (the SIEGE_ASSAULT reducer path would go unexercised). Heuristic:
 *   - aggressive bots storm on a BREACH (walls down / `breached`) or with
 *     favorable odds (physically-present besiegers >= defenders inside);
 *   - every other strategy storms EVENTUALLY — once the siege has dragged two
 *     rounds, or immediately at a breach.
 * Deterministic: reads only `state` + `strat`. A declaration already made this
 * round is skipped (the flag clears after COMBAT, so bots re-declare next round).
 */
function assaultCandidates(state: GameState, player: Player, strat: Strategy): GameAction[] {
  const out: GameAction[] = [];
  for (const siege of state.siegeStates) {
    if (siege.besiegerId !== player.id || siege.assaultDeclared === true) continue;
    const prov = provinceById(state, siege.provinceId);
    if (!prov) continue;
    const breached = siege.breached || prov.walls.hp <= 0;
    // Strengths from PHYSICAL unit locations (mirrors the engine's siege lock).
    let besiegers = 0;
    let defenders = prov.garrison ?? 0;
    for (const a of state.armies) {
      if (a.locationId !== siege.provinceId) continue;
      if (a.ownerId === player.id) besiegers += realCount(a);
      else if (a.ownerId === prov.ownerId) defenders += realCount(a);
    }
    if (besiegers === 0) continue; // marched away — the siege lock will lift it
    const wants =
      strat === "aggressive"
        ? breached || besiegers >= defenders
        : breached || siege.roundsElapsed >= 2;
    if (wants) out.push({ type: "SIEGE_ASSAULT", player: player.id, provinceId: siege.provinceId });
  }
  return out;
}

/**
 * Produce an ordered list of budgeted-action candidates for one "turn", weighted
 * by strategy. The driver tries them in order; the first that the engine accepts
 * is applied. If every candidate is rejected (EngineError), the player is treated
 * as having passed.
 */
function pickActions(state: GameState, player: Player, strat: Strategy, rng: Rng): GameAction[] {
  const moves = moveCandidates(state, player);
  const recruits = recruitCandidates(state, player);
  const builds = buildCandidates(state, player);
  const trades = tradeCandidates(state, player);
  const diplo = diplomacyCandidates(state, player);
  const vass = vassalizeCandidates(state, player);
  const spy = spyCandidates(state, player);
  const war = declareWarCandidates(state, player);
  // Chosen assaults (Stage B): declared FIRST for every strategy whose heuristic
  // fires — a declaration costs 1 of 4 actions and is the only way a besieging
  // bot ever storms (undeclared sieges resolve by bombardment/starvation only).
  const assaults = assaultCandidates(state, player, strat);

  let ordered: GameAction[];
  switch (strat) {
    case "aggressive":
      ordered = [
        ...shuffled(rng, assaults),
        ...shuffled(rng, recruits),
        ...shuffled(rng, moves),
        ...shuffled(rng, war),
        ...shuffled(rng, vass),
        ...shuffled(rng, builds),
        ...shuffled(rng, trades),
      ];
      break;
    case "trader":
      ordered = [
        ...shuffled(rng, assaults),
        ...shuffled(rng, trades),
        ...shuffled(rng, builds),
        ...shuffled(rng, recruits),
        ...shuffled(rng, diplo),
        ...shuffled(rng, moves),
      ];
      break;
    case "turtle":
      ordered = [
        ...shuffled(rng, assaults),
        ...shuffled(rng, builds),
        ...shuffled(rng, recruits),
        ...shuffled(rng, diplo),
        ...shuffled(rng, trades),
        ...shuffled(rng, vass),
      ];
      break;
    case "random":
    default:
      ordered = [
        ...shuffled(rng, assaults),
        ...shuffled(rng, [
          ...moves,
          ...recruits,
          ...builds,
          ...trades,
          ...diplo,
          ...vass,
          ...spy,
          ...war,
        ]),
      ];
      break;
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------
export interface Violation {
  invariant: string; // a..h label
  detail: string;
  step: number;
  phase: GamePhase;
  round: number;
  action?: string;
}

function labelAction(a: GameAction | null): string {
  if (!a) return "advancePhase";
  return JSON.stringify(a);
}

/**
 * Run the full invariant battery comparing `prev` → `next` after a single applied
 * mutation (`action` = the GameAction, or null for an advancePhase).
 */
export function checkInvariants(
  prev: GameState,
  next: GameState,
  ctx: { step: number; action: GameAction | null },
): Violation[] {
  const v: Violation[] = [];
  const add = (invariant: string, detail: string): void => {
    v.push({
      invariant,
      detail,
      step: ctx.step,
      phase: next.phase,
      round: next.round,
      action: labelAction(ctx.action),
    });
  };

  // (a) no player resource negative (engine floors at 0; there is no documented
  //     debt rule for the tradeable pools — grain shortfall causes desertion, not
  //     negative stores).
  for (const p of next.players) {
    for (const k of RESOURCE_KEYS) {
      if (p.treasury[k] < 0) add("a:negative-resource", `${p.id} ${k}=${p.treasury[k]}`);
      if (!Number.isFinite(p.treasury[k])) add("a:nonfinite-resource", `${p.id} ${k}=${p.treasury[k]}`);
    }
  }

  // (b) army/fleet unit counts never negative.
  for (const stack of [...next.armies, ...next.fleets]) {
    for (const t of Object.values(UnitType)) {
      const c = stack.units[t] ?? 0;
      if (c < 0) add("b:negative-units", `stack ${stack.id} ${t}=${c}`);
    }
    for (const va of stack.variants ?? []) {
      if (va.count < 0) add("b:negative-variant", `stack ${stack.id} ${va.variant}=${va.count}`);
    }
  }

  // (c) every province ownerId is null, a real player id, or a real minor id.
  const validOwners = new Set<string>([
    ...next.players.map((p) => p.id),
    ...next.minors.map((m) => m.id),
  ]);
  for (const prov of next.provinces) {
    if (prov.ownerId !== null && !validOwners.has(prov.ownerId)) {
      add("c:bad-owner", `province ${prov.id} ownerId=${prov.ownerId}`);
    }
  }

  // (d) moves only between adjacent provinces: if this mutation was a MOVE, the
  //     stack must have relocated from an adjacent source.
  if (ctx.action && ctx.action.type === "MOVE") {
    const a = ctx.action;
    const list = a.naval ? next.fleets : next.armies;
    const prevList = a.naval ? prev.fleets : prev.armies;
    const before = prevList.find((s) => s.id === a.stackId);
    const afterStack = list.find((s) => s.id === a.stackId);
    if (before && afterStack && afterStack.locationId !== before.locationId) {
      if (!neighborsOf(before.locationId).includes(afterStack.locationId)) {
        add("d:non-adjacent-move", `${a.stackId} ${before.locationId}→${afterStack.locationId}`);
      }
    }
  }

  // (e) rngCursor monotonically non-decreasing.
  if (next.rngCursor < prev.rngCursor) {
    add("e:rng-cursor-regressed", `${prev.rngCursor}→${next.rngCursor}`);
  }

  // (f) determinism is checked at the whole-game level (runGame twice); nothing here.

  // (g) prestige changes only through logged events: if total prestige changed,
  //     the chronicle must have grown in the same step (no silent mutation).
  const sumPrestige = (s: GameState): number => s.players.reduce((acc, p) => acc + p.prestige, 0);
  if (sumPrestige(prev) !== sumPrestige(next) && next.log.length <= prev.log.length) {
    add(
      "g:silent-prestige",
      `Δprestige=${sumPrestige(next) - sumPrestige(prev)} with no new log entry (log ${prev.log.length}→${next.log.length})`,
    );
  }

  // (h) per-player stacking limits (8 land / 12 city / 6 naval) never exceeded.
  const tally = (stacks: (Army | Fleet)[], naval: boolean): void => {
    const byKey = new Map<string, number>();
    for (const s of stacks) {
      // GD §8.4 (delta 3): the Great Bombard is a SINGLETON emplacement piece —
      // omen #34 spawns it (fixed id) directly onto the recipient's capital
      // regardless of occupancy. It is not a stacked unit, so it is exempt
      // from the §3.2 tally (discovered by the bot battery, where a full
      // 12-unit capital plus the spawned gun is a legal engine outcome).
      if (s.id === "army-great-bombard") continue;
      const key = `${s.ownerId}@${s.locationId}`;
      byKey.set(key, (byKey.get(key) ?? 0) + realCount(s));
    }
    for (const [key, count] of byKey) {
      const loc = key.split("@")[1];
      let limit: number;
      if (naval) limit = STACKING.naval;
      else {
        const prov = provinceById(next, loc);
        limit = prov && isCityProvince(prov) ? STACKING.city : STACKING.land;
      }
      if (count > limit) add("h:stack-limit", `${key} has ${count} (limit ${limit})`);
    }
  };
  tally(next.armies, false);
  tally(next.fleets, true);

  return v;
}

// ---------------------------------------------------------------------------
// The game runner
// ---------------------------------------------------------------------------
export interface Crash {
  where: "applyAction" | "advancePhase";
  errorName: string;
  message: string;
  stack?: string;
  phase: GamePhase;
  round: number;
  action?: string;
}

export interface GameReport {
  seed: number;
  numPlayers: number;
  strategy: Strategy;
  completed: boolean;
  endedReason: "winner" | "round16" | "crash" | "deadlock" | "incomplete";
  winner: Faction | null;
  finalRound: number;
  steps: number;
  actionsApplied: number;
  engineErrorProbes: number;
  violations: Violation[];
  crash: Crash | null;
  deadlock: string | null;
  finalState: GameState;
}

export interface RunOptions {
  numPlayers: number;
  seed: number;
  strategy: Strategy;
  room?: string;
  maxRounds?: number;
  checkInvariants?: boolean;
}

/**
 * Drive one full game to completion (a winner, round-16 end, a crash, or a
 * deadlock). Bots spend their whole shared per-round budget during the single
 * CANON action window (RECRUITMENT/MOVEMENT/DIPLOMACY are one type-agnostic
 * window, CANON #9 — so we resolve all budgeted actions when we first reach
 * RECRUITMENT, then let the remaining window phases advance).
 */
export function runGame(opts: RunOptions): GameReport {
  const seats = makeSeats(opts.numPlayers);
  const room = opts.room ?? `G${opts.seed.toString(36).toUpperCase()}`;
  const doInv = opts.checkInvariants !== false;
  const maxRounds = opts.maxRounds ?? ROUNDS;
  const rng = mulberry32((opts.seed ^ 0x9e3779b9) >>> 0);

  let state = createInitialState(room, seats, opts.seed);
  const violations: Violation[] = [];
  let crash: Crash | null = null;
  let deadlock: string | null = null;
  let steps = 0;
  let actionsApplied = 0;
  let engineErrorProbes = 0;

  const STEP_CAP = maxRounds * 6 * 4 + 200; // phases per round * rounds + slack

  while (true) {
    steps += 1;
    if (steps > STEP_CAP) {
      deadlock = `step cap ${STEP_CAP} exceeded at phase=${state.phase} round=${state.round}`;
      break;
    }

    // --- Action window: resolve budgeted actions once, at RECRUITMENT. ---------
    // TURN ORDER (marshal actions major): applyAction now gates every budgeted
    // action on `turnOrder[activePlayerIndex]` (OUT_OF_TURN) and the pointer
    // advances on exhaustion/PASS. The driver therefore follows the ENGINE'S
    // OWN pointer instead of iterating seats: on each iteration the ACTIVE
    // player either applies one legal budgeted action or PASSes to yield the
    // window. The loop (and thus the phase advance below) only ends once every
    // budget is 0 — exactly the reducer's WINDOW_NOT_DONE condition for
    // ADVANCE_PHASE. Deterministic: same pointer walk + same rng stream.
    if (state.phase === GamePhase.RECRUITMENT) {
      // Each iteration spends 1 action or zeroes one player's budget via PASS,
      // so the window is bounded by total budget + seats; cap with slack.
      const windowCap = state.players.length * 60;
      let safety = 0;
      while (state.players.some((p) => p.actionsRemaining > 0)) {
        safety += 1;
        if (safety > windowCap) {
          deadlock = `action window exceeded ${windowCap} iterations (budgets stuck: ${state.players.map((p) => `${p.id}=${p.actionsRemaining}`).join(" ")})`;
          break;
        }
        const activeId = state.turnOrder[state.activePlayerIndex];
        if (activeId === undefined) {
          deadlock = `window pointer out of range (activePlayerIndex=${state.activePlayerIndex}, turnOrder=${state.turnOrder.join(",")})`;
          break;
        }
        const player = playerById(state, activeId);
        let applied = false;
        if (player.actionsRemaining > 0) {
          const candidates = pickActions(state, player, opts.strategy, rng);
          for (const cand of candidates) {
            let nextState: GameState;
            try {
              nextState = applyAction(state, cand);
            } catch (e) {
              if (e instanceof EngineError) {
                engineErrorProbes += 1;
                continue; // legality probe: try the next candidate
              }
              crash = {
                where: "applyAction",
                errorName: (e as Error)?.name ?? "Error",
                message: (e as Error)?.message ?? String(e),
                stack: (e as Error)?.stack,
                phase: state.phase,
                round: state.round,
                action: labelAction(cand),
              };
              break;
            }
            // Success: check invariants, commit.
            if (doInv) violations.push(...checkInvariants(state, nextState, { step: steps, action: cand }));
            state = nextState;
            actionsApplied += 1;
            applied = true;
            break;
          }
        }
        if (crash) break;
        if (!applied) {
          // No legal budgeted action left → the active player PASSes, zeroing
          // their budget and handing the window pointer to the next undone seat.
          const pass: GameAction = { type: "PASS", player: activeId };
          let nextState: GameState;
          try {
            nextState = applyAction(state, pass);
          } catch (e) {
            crash = {
              where: "applyAction",
              errorName: (e as Error)?.name ?? "Error",
              message: (e as Error)?.message ?? String(e),
              stack: (e as Error)?.stack,
              phase: state.phase,
              round: state.round,
              action: labelAction(pass),
            };
            break;
          }
          if (doInv) violations.push(...checkInvariants(state, nextState, { step: steps, action: pass }));
          state = nextState;
          actionsApplied += 1;
        }
      }
      if (crash) break;
    }

    // --- Advance the phase machine. -------------------------------------------
    // Window phases advance through the REDUCER's ADVANCE_PHASE so its
    // WINDOW_NOT_DONE gate is exercised (satisfied here — the drain above spent
    // or PASSed every budget; an unexpected rejection is a real bug and is
    // recorded as a crash). Non-window phases advance via the phase machine
    // directly, as the driver/host does.
    const isWindowPhase =
      state.phase === GamePhase.RECRUITMENT ||
      state.phase === GamePhase.MOVEMENT ||
      state.phase === GamePhase.DIPLOMACY;
    const before = { phase: state.phase, round: state.round };
    let advanced: GameState;
    try {
      advanced = isWindowPhase
        ? applyAction(state, { type: "ADVANCE_PHASE" })
        : advancePhase(state);
    } catch (e) {
      crash = {
        where: "advancePhase",
        errorName: (e as Error)?.name ?? "Error",
        message: (e as Error)?.message ?? String(e),
        stack: (e as Error)?.stack,
        phase: state.phase,
        round: state.round,
      };
      break;
    }
    if (doInv) violations.push(...checkInvariants(state, advanced, { step: steps, action: null }));

    // Terminal: END that does not progress (round-16 or a declared winner).
    if (before.phase === GamePhase.END && advanced.phase === GamePhase.END && advanced.round === before.round) {
      state = advanced;
      break;
    }
    // Progress guard: a non-END phase must always change phase or round.
    if (
      before.phase !== GamePhase.END &&
      advanced.phase === before.phase &&
      advanced.round === before.round
    ) {
      deadlock = `advancePhase made no progress from ${before.phase} (round ${before.round})`;
      state = advanced;
      break;
    }
    state = advanced;
  }

  const winner = state.winner ?? null;
  let endedReason: GameReport["endedReason"];
  if (crash) endedReason = "crash";
  else if (deadlock) endedReason = "deadlock";
  else if (winner) endedReason = "winner";
  else if (state.round >= maxRounds && state.phase === GamePhase.END) endedReason = "round16";
  else endedReason = "incomplete";

  return {
    seed: opts.seed,
    numPlayers: seats.length,
    strategy: opts.strategy,
    completed: !crash && !deadlock,
    endedReason,
    winner,
    finalRound: state.round,
    steps,
    actionsApplied,
    engineErrorProbes,
    violations,
    crash,
    deadlock,
    finalState: state,
  };
}

/**
 * Determinism check (invariant f): run the SAME game twice and compare the final
 * states byte-for-byte (stable JSON — createInitialState builds keys in a fixed
 * order and the engine + harness are pure, so a matching run is byte-identical).
 */
export function determinismCheck(opts: RunOptions): { identical: boolean; firstDiff?: string } {
  const a = runGame({ ...opts, checkInvariants: false });
  const b = runGame({ ...opts, checkInvariants: false });
  const sa = JSON.stringify(a.finalState);
  const sb = JSON.stringify(b.finalState);
  if (sa === sb) return { identical: true };
  // Find a short human diff.
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i += 1;
  return {
    identical: false,
    firstDiff: `first divergence at char ${i}: …${sa.slice(Math.max(0, i - 40), i + 40)}… vs …${sb.slice(Math.max(0, i - 40), i + 40)}…`,
  };
}
