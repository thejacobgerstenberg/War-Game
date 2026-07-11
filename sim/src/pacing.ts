/**
 * Pacing / prestige-threshold model.
 *
 * Models per-round prestige accrual for four strategic archetypes (rusher,
 * trader, turtler, opportunist) using only the prestige values in CONFIG:
 * own/enemy capitals held (canon §13.1), held key cities (+Constantinople
 * extra), open trade routes and trade monopolies, great works, wars won,
 * secret objectives, and prestige event cards.
 *
 * Accrual is stochastic: conquests are attempted and succeed/fail, captured
 * key cities can be lost again, trade routes get raided/blockaded for a
 * round, great works land on a jittered schedule with a completion
 * probability, secret objectives complete via a per-round hazard inside a
 * mid/late-game window, and prestige event cards hit with configured
 * magnitude bounds. All randomness flows through the seeded RNG (sim/src/rng).
 *
 * A "game" is 5 players: one of each archetype plus one random archetype.
 * The threshold sweep asks, for each candidate victory threshold T: when
 * does the first player cross T (game-ending round, capped at maxRounds),
 * what share of games is decided by threshold vs the round-16 highest-
 * prestige tiebreak, and how often does the round-8 prestige leader end up
 * winning (runaway measure).
 */

import type { RNG } from './rng';
import type { Config } from './rules';

// ---------------------------------------------------------------- archetypes

export type ArchetypeName = 'rusher' | 'trader' | 'turtler' | 'opportunist';

export const ARCHETYPE_NAMES: readonly ArchetypeName[] = [
  'rusher',
  'trader',
  'turtler',
  'opportunist',
];

/** Fully serializable archetype description (goes into results JSON). */
export interface ArchetypeParams {
  name: ArchetypeName;
  /** Key cities held at game start (home capital region). */
  startKeyCities: number;
  /** Cap on simultaneously held key cities (map has 10; nobody holds all). */
  maxKeyCities: number;
  /** P(attempt a conquest) per round, rounds 1-3 (armies still mustering). */
  conquestAttemptProbEarly: number;
  /** P(attempt a conquest) per round, rounds 4+. */
  conquestAttemptProbLate: number;
  /** P(a conquest attempt succeeds). */
  conquestSuccessProb: number;
  /** P(a successful conquest nets a key city) — 10 of 52 provinces qualify. */
  keyCityChanceOnConquest: number;
  /** P(losing one gained key city) per round while above startKeyCities. */
  keyCityLossProb: number;
  /** P(a successful conquest concludes a war => warWon prestige). */
  warWonChanceOnConquest: number;
  /** P(winning a defensive war) per round (repelling an invader). */
  defensiveWarWonProb: number;
  /** Routes open at round r = min(maxRoutes, floor(r * routeRampPerRound)). */
  routeRampPerRound: number;
  /** Cap on open routes (CONFIG.trade.maxRoutesPerFaction bounds this). */
  maxRoutes: number;
  /** P(a given open route is raided/blockaded for the round) per route. */
  routeRaidProb: number;
  /** Trade monopolies (both route ends owned, canon +2/round) ramp like routes. */
  monopolyRampPerRound: number;
  /** Cap on simultaneous monopolies. */
  maxMonopolies: number;
  /** Round from which capturing an enemy capital is attempted (null = never). */
  enemyCapitalFromRound: number | null;
  /** P(capturing an enemy capital) per round once attempting. */
  enemyCapitalCaptureProb: number;
  /** P(losing the held enemy capital) per round. */
  enemyCapitalLossProb: number;
  /** Great-work completion attempts: at round (+/-1 jitter), with prob. */
  greatWorkSchedule: Array<{ round: number; prob: number }>;
  /** [first, last] round in which the secret objective can complete. */
  objectiveWindow: [number, number];
  /** Per-round completion hazard inside the objective window. */
  objectiveHazard: number;
  /** Round from which a Constantinople grab is attempted (null = never). */
  cpleAttemptFromRound: number | null;
  /** P(capturing Constantinople) per round once attempting. */
  cpleCaptureProb: number;
  /** P(losing Constantinople again) per round while holding it. */
  cpleLossProb: number;
  /** P(a prestige event card affects this player) per round. */
  prestigeEventProb: number;
}

export const ARCHETYPES: Record<ArchetypeName, ArchetypeParams> = {
  // All-in military expansion (Ottoman-style). High-variance, snowballs key
  // cities and war prestige, goes for Constantinople once the Bombard exists.
  rusher: {
    name: 'rusher',
    startKeyCities: 1,
    maxKeyCities: 5,
    conquestAttemptProbEarly: 0.35,
    conquestAttemptProbLate: 0.45,
    conquestSuccessProb: 0.5,
    keyCityChanceOnConquest: 0.3,
    keyCityLossProb: 0.1,
    warWonChanceOnConquest: 0.15,
    defensiveWarWonProb: 0.02,
    routeRampPerRound: 0.15,
    maxRoutes: 1,
    routeRaidProb: 0.15,
    monopolyRampPerRound: 0,
    maxMonopolies: 0,
    enemyCapitalFromRound: 8,
    enemyCapitalCaptureProb: 0.06,
    enemyCapitalLossProb: 0.06,
    greatWorkSchedule: [{ round: 14, prob: 0.15 }],
    objectiveWindow: [8, 14],
    objectiveHazard: 0.12,
    cpleAttemptFromRound: 12, // Great Bombard from round 11, built + moved
    cpleCaptureProb: 0.12,
    cpleLossProb: 0.05,
    prestigeEventProb: 0.25,
  },
  // Venice/Genoa-style route economy: routes max out early, steady income,
  // one late great work, little fighting.
  trader: {
    name: 'trader',
    startKeyCities: 1,
    maxKeyCities: 3,
    conquestAttemptProbEarly: 0.1,
    conquestAttemptProbLate: 0.2,
    conquestSuccessProb: 0.5,
    keyCityChanceOnConquest: 0.25,
    keyCityLossProb: 0.04,
    warWonChanceOnConquest: 0.1,
    defensiveWarWonProb: 0.03,
    routeRampPerRound: 0.75, // 3 routes open by round 4
    maxRoutes: 3,
    routeRaidProb: 0.18,
    monopolyRampPerRound: 0.2, // 1 monopoly by round 5, 2 by round 10
    maxMonopolies: 2,
    enemyCapitalFromRound: null,
    enemyCapitalCaptureProb: 0,
    enemyCapitalLossProb: 0,
    greatWorkSchedule: [{ round: 12, prob: 0.4 }],
    objectiveWindow: [7, 13],
    objectiveHazard: 0.15,
    cpleAttemptFromRound: null,
    cpleCaptureProb: 0,
    cpleLossProb: 0,
    prestigeEventProb: 0.25,
  },
  // Defensive builder: sits on the home key city, stacks great works and the
  // objective, occasionally wins a defensive war.
  turtler: {
    name: 'turtler',
    startKeyCities: 1,
    maxKeyCities: 2,
    conquestAttemptProbEarly: 0.05,
    conquestAttemptProbLate: 0.1,
    conquestSuccessProb: 0.5,
    keyCityChanceOnConquest: 0.3,
    keyCityLossProb: 0.02,
    warWonChanceOnConquest: 0.2,
    defensiveWarWonProb: 0.06,
    routeRampPerRound: 0.25, // 2 routes by round 8
    maxRoutes: 2,
    routeRaidProb: 0.08,
    monopolyRampPerRound: 0.08, // 1 monopoly by round 13
    maxMonopolies: 1,
    enemyCapitalFromRound: null,
    enemyCapitalCaptureProb: 0,
    enemyCapitalLossProb: 0,
    greatWorkSchedule: [
      { round: 7, prob: 0.6 },
      { round: 11, prob: 0.5 },
      { round: 14, prob: 0.35 },
    ],
    objectiveWindow: [9, 15],
    objectiveHazard: 0.15,
    cpleAttemptFromRound: null,
    cpleCaptureProb: 0,
    cpleLossProb: 0,
    prestigeEventProb: 0.25,
  },
  // Balanced: moderate expansion, some trade, a mid-game great work, takes
  // late-game chances on Constantinople if the door opens.
  opportunist: {
    name: 'opportunist',
    startKeyCities: 1,
    maxKeyCities: 4,
    conquestAttemptProbEarly: 0.2,
    conquestAttemptProbLate: 0.28,
    conquestSuccessProb: 0.5,
    keyCityChanceOnConquest: 0.3,
    keyCityLossProb: 0.05,
    warWonChanceOnConquest: 0.15,
    defensiveWarWonProb: 0.03,
    routeRampPerRound: 0.35, // 2 routes by round 6
    maxRoutes: 2,
    routeRaidProb: 0.1,
    monopolyRampPerRound: 0.12, // 1 monopoly by round 9
    maxMonopolies: 1,
    enemyCapitalFromRound: 10,
    enemyCapitalCaptureProb: 0.04,
    enemyCapitalLossProb: 0.06,
    greatWorkSchedule: [
      { round: 10, prob: 0.3 },
      { round: 13, prob: 0.2 },
    ],
    objectiveWindow: [8, 14],
    objectiveHazard: 0.13,
    cpleAttemptFromRound: 12,
    cpleCaptureProb: 0.06,
    cpleLossProb: 0.05,
    prestigeEventProb: 0.25,
  },
};

// --------------------------------------------------------------- trajectory

/**
 * Simulate one player's cumulative prestige per round.
 * Returns an array of length cfg.game.maxRounds: entry r-1 = prestige held
 * at the END of round r. Cumulative prestige is floored at 0 (as a total —
 * event cards can drag it down but not below zero).
 */
export function simulateTrajectory(p: ArchetypeParams, cfg: Config, rng: RNG): number[] {
  const rounds = cfg.game.maxRounds;
  const pr = cfg.prestige;
  const [evMin, evMax] = cfg.events.prestigeMagnitude;

  // Pre-roll great work completions: jittered round, completion probability.
  // Engine reconciliation: works score PER-WORK canon prestige (§9.2). The
  // i-th completed work pays cfg.buildings.greatWorks[i].prestige in the same
  // greedy (cheapest-first) order game.ts builds them: 5, 6, 6, 10.
  const greatWorkRounds: number[] = [];
  for (const gw of p.greatWorkSchedule) {
    if (rng.chance(gw.prob)) greatWorkRounds.push(gw.round + rng.range(-1, 1));
  }
  greatWorkRounds.sort((a, b) => a - b);
  const gwPrestigeSeq = cfg.buildings.greatWorks.map((w) => w.prestige);
  let gwBuiltCount = 0;

  let keyCities = p.startKeyCities;
  let hasCple = false;
  let hasEnemyCapital = false;
  // E4: THREE independent objectives per faction, each completing via the
  // per-round hazard inside the window and each paying +4 at game end.
  const objectiveDone = [false, false, false];
  let cum = 0;
  const out: number[] = new Array(rounds);

  for (let r = 1; r <= rounds; r++) {
    // --- conquest attempts (canon §13.1 conquest track) ---
    const attemptProb = r <= 3 ? p.conquestAttemptProbEarly : p.conquestAttemptProbLate;
    if (rng.chance(attemptProb) && rng.chance(p.conquestSuccessProb)) {
      cum += pr.provinceCapture + pr.decisiveBattle; // won the field decisively
      if (keyCities < p.maxKeyCities && rng.chance(p.keyCityChanceOnConquest)) {
        keyCities++;
        cum += pr.walledCityCapture; // key cities are walled (canon: +2 for T1-T3)
      }
      if (rng.chance(p.warWonChanceOnConquest)) cum += pr.warWon;
    }
    // gained key cities can be retaken
    if (keyCities > p.startKeyCities && rng.chance(p.keyCityLossProb)) keyCities--;
    // defensive war concluded in the player's favor
    if (rng.chance(p.defensiveWarWonProb)) cum += pr.warWon;

    // --- Constantinople (T5 walled city on top of a normal key city) ---
    if (p.cpleAttemptFromRound !== null && r >= p.cpleAttemptFromRound) {
      if (!hasCple) {
        if (rng.chance(p.cpleCaptureProb)) {
          hasCple = true;
          cum += pr.provinceCapture + pr.walledCityCaptureHighTier; // canon: +3 for T4-T5
        }
      } else if (rng.chance(p.cpleLossProb)) {
        hasCple = false;
      }
    }

    // --- enemy capital (canon §13.1: +3/round while held) ---
    if (p.enemyCapitalFromRound !== null && r >= p.enemyCapitalFromRound) {
      if (!hasEnemyCapital) {
        if (rng.chance(p.enemyCapitalCaptureProb)) hasEnemyCapital = true;
      } else if (rng.chance(p.enemyCapitalLossProb)) {
        hasEnemyCapital = false;
      }
    }

    // --- trade routes: ramp to cap, each open route can be raided ---
    const capRoutes = Math.min(p.maxRoutes, cfg.trade.maxRoutesPerFaction);
    const routesOpen = Math.min(capRoutes, Math.floor(r * p.routeRampPerRound));
    let routesActive = 0;
    for (let i = 0; i < routesOpen; i++) if (!rng.chance(p.routeRaidProb)) routesActive++;
    // monopolies (both route ends owned; canon +2/round) ramp separately
    const monopoliesOpen = Math.min(p.maxMonopolies, Math.floor(r * p.monopolyRampPerRound));
    let monopoliesActive = 0;
    for (let i = 0; i < monopoliesOpen; i++) if (!rng.chance(p.routeRaidProb)) monopoliesActive++;

    // --- one-off prestige: great works; secret objectives COMPLETE inside
    //     their window but are revealed & SCORED at game end only (canon
    //     §13.1) — added in the final round so they can never trigger an
    //     early threshold win ---
    for (const gwRound of greatWorkRounds) {
      if (gwRound === r && gwBuiltCount < gwPrestigeSeq.length) cum += gwPrestigeSeq[gwBuiltCount++];
    }
    if (r >= p.objectiveWindow[0] && r <= p.objectiveWindow[1]) {
      for (let i = 0; i < objectiveDone.length; i++) {
        if (!objectiveDone[i] && rng.chance(p.objectiveHazard)) objectiveDone[i] = true;
      }
    }
    if (r === rounds) cum += objectiveDone.filter(Boolean).length * pr.secretObjective;

    // --- per-round prestige income ---
    cum += pr.ownCapitalPerRound; // own capital assumed held (canon §13.1)
    if (hasEnemyCapital) cum += pr.enemyCapitalPerRound;
    cum += keyCities * pr.keyCityPerRound;
    if (hasCple) cum += pr.keyCityPerRound + pr.constantinopleExtraPerRound;
    cum += routesActive * pr.tradeRoutePerRound;
    // E2 diminishing returns: first monopoly +2, each additional +1
    if (monopoliesActive > 0) {
      cum += pr.tradeMonopolyPerRound + (monopoliesActive - 1) * pr.tradeMonopolyAdditionalPerRound;
    }

    // --- prestige event card ---
    if (rng.chance(p.prestigeEventProb)) cum += rng.range(evMin, evMax);

    cum = Math.max(0, cum);
    out[r - 1] = cum;
  }
  return out;
}

// --------------------------------------------------------------------- game

export interface GameTrajectories {
  /** Archetype of each of the 5 players. */
  archetypes: ArchetypeName[];
  /** trajectories[i][r-1] = player i cumulative prestige at end of round r. */
  trajectories: number[][];
}

/** One 5-player game: each archetype once, plus one random duplicate. */
export function simulateGame(cfg: Config, rng: RNG): GameTrajectories {
  const archetypes: ArchetypeName[] = [...ARCHETYPE_NAMES, rng.pick(ARCHETYPE_NAMES)];
  const trajectories = archetypes.map((a, i) =>
    simulateTrajectory(ARCHETYPES[a], cfg, rng.fork(i + 1)),
  );
  return { archetypes, trajectories };
}

/** First round (1-based) whose end-of-round prestige >= threshold, else null. */
export function firstCrossing(trajectory: number[], threshold: number): number | null {
  for (let r = 0; r < trajectory.length; r++) {
    if (trajectory[r] >= threshold) return r + 1;
  }
  return null;
}

// -------------------------------------------------------------------- sweep

export interface SweepRow {
  threshold: number;
  /** histogram: endRoundCounts[r-1] = games ending at round r. */
  endRoundCounts: number[];
  medianEndRound: number;
  meanEndRound: number;
  /** Share of games ending before round 11 (i.e. at rounds 1-10). */
  shareEndedBeforeRound11: number;
  /** Share decided by a player crossing the threshold. */
  shareDecidedByThreshold: number;
  /** Share decided by highest prestige at the round-16 cap. */
  shareDecidedByCap: number;
  /** Runaway measure: P(the round-8 prestige leader wins the game). */
  pRound8LeaderWins: number;
}

function argmaxAtRound(trajectories: number[][], roundIdx: number): number {
  let best = 0;
  for (let i = 1; i < trajectories.length; i++) {
    if (trajectories[i][roundIdx] > trajectories[best][roundIdx]) best = i;
  }
  return best;
}

/**
 * Evaluate one victory threshold over a batch of simulated games.
 * Winner: earliest threshold-crosser (ties: higher prestige that round, then
 * lower player index); if nobody crosses, highest prestige at the cap.
 */
export function evaluateThreshold(games: GameTrajectories[], threshold: number): SweepRow {
  const rounds = games[0].trajectories[0].length;
  const endRoundCounts = new Array<number>(rounds).fill(0);
  let byThreshold = 0;
  let endedBefore11 = 0;
  let endRoundSum = 0;
  let leaderWins = 0;

  for (const g of games) {
    let endRound = rounds; // cap
    let winner = -1;
    for (let i = 0; i < g.trajectories.length; i++) {
      const cross = firstCrossing(g.trajectories[i], threshold);
      if (cross === null) continue;
      if (
        winner === -1 ||
        cross < endRound ||
        (cross === endRound && g.trajectories[i][cross - 1] > g.trajectories[winner][cross - 1])
      ) {
        endRound = cross;
        winner = i;
      }
    }
    const decidedByThreshold = winner !== -1;
    if (!decidedByThreshold) winner = argmaxAtRound(g.trajectories, rounds - 1);
    else byThreshold++;

    endRoundCounts[endRound - 1]++;
    endRoundSum += endRound;
    if (endRound <= 10) endedBefore11++;
    if (winner === argmaxAtRound(g.trajectories, 7)) leaderWins++;
  }

  const n = games.length;
  // median from the histogram
  let medianEndRound = rounds;
  let cumCount = 0;
  for (let r = 0; r < rounds; r++) {
    cumCount += endRoundCounts[r];
    if (cumCount >= n / 2) {
      medianEndRound = r + 1;
      break;
    }
  }

  return {
    threshold,
    endRoundCounts,
    medianEndRound,
    meanEndRound: endRoundSum / n,
    shareEndedBeforeRound11: endedBefore11 / n,
    shareDecidedByThreshold: byThreshold / n,
    shareDecidedByCap: 1 - byThreshold / n,
    pRound8LeaderWins: leaderWins / n,
  };
}

// ----------------------------------------------------------- recommendation

export interface RecommendationCriteria {
  medianEndRoundInWindow: boolean; // 12..16
  under10pctEndBeforeRound11: boolean; // < 0.10
  thresholdDecidedShareInWindow: boolean; // 0.40..0.70
}

export interface Recommendation {
  threshold: number;
  meetsAllCriteria: boolean;
  criteria: RecommendationCriteria;
  metrics: SweepRow;
  reasoning: string;
}

function criteriaFor(row: SweepRow): RecommendationCriteria {
  return {
    medianEndRoundInWindow: row.medianEndRound >= 12 && row.medianEndRound <= 16,
    under10pctEndBeforeRound11: row.shareEndedBeforeRound11 < 0.1,
    thresholdDecidedShareInWindow:
      row.shareDecidedByThreshold >= 0.4 && row.shareDecidedByThreshold <= 0.7,
  };
}

/**
 * Pick the threshold where: median ending round in 12-16, <10% of games end
 * before round 11, and 40-70% of games are decided by threshold. Among
 * qualifiers, prefer threshold-decided share closest to the 55% midpoint
 * (tie-break: lower runaway probability). If nothing qualifies, minimize a
 * violation score.
 */
export function recommend(rows: SweepRow[]): Recommendation {
  const qualified = rows.filter((r) => {
    const c = criteriaFor(r);
    return (
      c.medianEndRoundInWindow && c.under10pctEndBeforeRound11 && c.thresholdDecidedShareInWindow
    );
  });

  let best: SweepRow;
  let reasoning: string;
  if (qualified.length > 0) {
    best = qualified.reduce((a, b) => {
      const da = Math.abs(a.shareDecidedByThreshold - 0.55);
      const db = Math.abs(b.shareDecidedByThreshold - 0.55);
      if (da !== db) return da < db ? a : b;
      return a.pRound8LeaderWins <= b.pRound8LeaderWins ? a : b;
    });
    const lo = qualified[0].threshold;
    const hi = qualified[qualified.length - 1].threshold;
    reasoning =
      `Thresholds ${lo}-${hi} satisfy all pacing criteria ` +
      `(median end round 12-16, <10% of games end before round 11, 40-70% decided ` +
      `by threshold). ${best.threshold} is chosen because its threshold-decided share ` +
      `(${(100 * best.shareDecidedByThreshold).toFixed(1)}%) is closest to the 55% midpoint; ` +
      `median end round ${best.medianEndRound}, ` +
      `${(100 * best.shareEndedBeforeRound11).toFixed(1)}% of games end before round 11, ` +
      `round-8 leader wins ${(100 * best.pRound8LeaderWins).toFixed(1)}% of games.`;
  } else {
    // violation score: distance outside each target window
    const score = (r: SweepRow) => {
      let s = 0;
      if (r.medianEndRound < 12) s += (12 - r.medianEndRound) * 0.2;
      if (r.shareEndedBeforeRound11 >= 0.1) s += r.shareEndedBeforeRound11 - 0.1;
      if (r.shareDecidedByThreshold < 0.4) s += 0.4 - r.shareDecidedByThreshold;
      if (r.shareDecidedByThreshold > 0.7) s += r.shareDecidedByThreshold - 0.7;
      return s;
    };
    best = rows.reduce((a, b) => (score(a) <= score(b) ? a : b));
    reasoning =
      `No threshold satisfies all three pacing criteria simultaneously; ` +
      `${best.threshold} minimizes the total violation ` +
      `(median end round ${best.medianEndRound}, ` +
      `${(100 * best.shareEndedBeforeRound11).toFixed(1)}% end before round 11, ` +
      `${(100 * best.shareDecidedByThreshold).toFixed(1)}% decided by threshold). ` +
      `Archetype accrual rates likely need retuning before the threshold can hit all targets.`;
  }

  const criteria = criteriaFor(best);
  return {
    threshold: best.threshold,
    meetsAllCriteria:
      criteria.medianEndRoundInWindow &&
      criteria.under10pctEndBeforeRound11 &&
      criteria.thresholdDecidedShareInWindow,
    criteria,
    metrics: best,
    reasoning,
  };
}

// ------------------------------------------------------------------- curves

export interface AccrualCurve {
  archetype: ArchetypeName;
  samples: number;
  mean: number[]; // per round 1..maxRounds
  p10: number[];
  p50: number[];
  p90: number[];
}

/** Summarize per-round cumulative prestige samples into mean/p10/p50/p90. */
export function summarizeCurves(
  archetype: ArchetypeName,
  perRoundSamples: number[][], // [roundIdx][sample]
): AccrualCurve {
  const q = (sorted: number[], p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const mean: number[] = [];
  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];
  for (const samples of perRoundSamples) {
    const sorted = [...samples].sort((a, b) => a - b);
    mean.push(samples.reduce((s, x) => s + x, 0) / samples.length);
    p10.push(q(sorted, 0.1));
    p50.push(q(sorted, 0.5));
    p90.push(q(sorted, 0.9));
  }
  return { archetype, samples: perRoundSamples[0]?.length ?? 0, mean, p10, p50, p90 };
}
