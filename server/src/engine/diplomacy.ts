/**
 * diplomacy.ts — treaties, vassalage and revolts subsystem.
 *
 * Owns §11 (alliances, NAPs, tribute, royal marriage, betrayal penalties &
 * casus belli), §11.5 (vassalize an NPC minor + vassal benefits) and revolt
 * resolution. Every number is read from balance.VASSAL / PRESTIGE_VALUES.
 *
 * Purity/determinism: the phase-level functions that roll dice
 * ({@link applyVassalize}, {@link runRevolts}, and the betrayal-revolt branch of
 * {@link applyDiplomacy}) derive their RNG via makeRng(state.rngSeed,
 * state.rngCursor) and write the advanced cursor back onto the returned state.
 * Inputs are treated as immutable (structuredClone), consistent with economy.ts.
 */
import {
  TreatyType,
  UnitType,
  type Army,
  type GameAction,
  type GameState,
  type NpcMinor,
  type Player,
  type ResourceBundle,
  type Treaty,
} from "@imperium/shared";
import { PRESTIGE_VALUES, VASSAL } from "./balance.js";
import { appendLog } from "./logEntry.js";
import { makeRng, type Rng } from "./rng.js";
import { EngineError } from "./actions.js";

// ---------------------------------------------------------------------------
// Local constants & helpers
// ---------------------------------------------------------------------------

/**
 * §11 NAP default term of 3 rounds. There is no NAP-duration constant in
 * balance.ts and this subsystem may not edit balance.ts, so it is defined here
 * with a clear citation. See NEEDS-FROM-INTEGRATOR: add DIPLOMACY.napDefaultRounds.
 */
const NAP_DEFAULT_ROUNDS = 3;

/**
 * §11 "betrayed twice" reputation threshold — a player at or above this many
 * betrayals suffers −1 to their diplomacy (vassalize) rolls.
 */
const REPUTATION_BETRAYAL_THRESHOLD = 2;
const REPUTATION_ROLL_PENALTY = 1;

const RESOURCE_KEYS = ["gold", "grain", "timber", "marble", "faith"] as const;

function clone(state: GameState): GameState {
  return structuredClone(state) as GameState;
}

function playerById(state: GameState, id: string | null): Player | undefined {
  if (!id) return undefined;
  return state.players.find((p) => p.id === id);
}

function requirePlayer(state: GameState, id: string): Player {
  const p = playerById(state, id);
  if (!p) throw new EngineError("UNKNOWN_PLAYER", `No such player: ${id}`);
  return p;
}

/**
 * §11.5 A player's "prestige-tier" for the vassalize roll. The design cites a
 * prestige-tier but balance.ts defines no tiering divisor; this maps prestige to
 * an integer tier of one per 10 prestige (floor, ≥0). See NEEDS-FROM-INTEGRATOR
 * / ambiguity list.
 */
function prestigeTier(player: Player): number {
  return Math.max(0, Math.floor(player.prestige / 10));
}

/** §11 reputation: −1 to diplomacy rolls once a player has betrayed twice. */
function reputationPenalty(player: Player): number {
  return player.betrayals >= REPUTATION_BETRAYAL_THRESHOLD
    ? REPUTATION_ROLL_PENALTY
    : 0;
}

/** Deterministic per-Income prestige (−4/−2) for breaking a treaty, by type. */
function breakPrestige(type: TreatyType): number {
  switch (type) {
    case TreatyType.ALLIANCE:
      return PRESTIGE_VALUES.betrayAlliance; // §11 −4
    case TreatyType.NAP:
      return PRESTIGE_VALUES.betrayNap; // §11 −2
    case TreatyType.ROYAL_MARRIAGE:
      return PRESTIGE_VALUES.betrayMarriage; // §11 −4
    case TreatyType.TRIBUTE:
      return 0; // §11 "missed tribute = pact voids, no penalty"
    default:
      return 0;
  }
}

/** Treaties whose break counts as a perfidy (reputation + vassal revolts). */
function isPerfidy(type: TreatyType): boolean {
  return type !== TreatyType.TRIBUTE; // §11 tribute lapse carries no penalty
}

/** §11 the term a freshly-concluded treaty lapses on (NAP defaults to 3 rounds). */
function treatyExpiry(
  type: TreatyType,
  round: number,
  requested?: number,
): number | null {
  if (requested !== undefined) return requested;
  if (type === TreatyType.NAP) return round + NAP_DEFAULT_ROUNDS;
  return null; // Alliance / Marriage / Tribute are indefinite until broken
}

/** Add a state of war (casus belli), de-duplicated on the unordered pair. */
function addWar(next: GameState, a: string, b: string): boolean {
  if (a === b) return false;
  const exists = next.wars.some(
    (w) => (w.a === a && w.b === b) || (w.a === b && w.b === a),
  );
  if (exists) return false;
  next.wars.push({ a, b, startedRound: next.round });
  return true;
}

/** Remove a treaty (by id) from every party's treaty list. */
function dropTreaty(next: GameState, treatyId: string): void {
  for (const p of next.players) {
    p.treaties = p.treaties.filter((t) => t.id !== treatyId);
  }
}

function emptyUnits(): Record<UnitType, number> {
  const u = {} as Record<UnitType, number>;
  for (const t of Object.values(UnitType)) u[t] = 0;
  return u;
}

/**
 * Free a minor from vassalage: revert to independent, drop it from the
 * overlord's vassal list, and flip any provinces it holds back to neutral
 * (conquered vassals had their provinces flipped to the overlord). Garrison is
 * left intact ("garrison restored", §11.5). Returns a log-appended state.
 */
function freeVassal(
  next: GameState,
  minor: NpcMinor,
  reason: string,
): GameState {
  const overlordId = minor.vassalOf;
  const overlord = playerById(next, overlordId);
  minor.vassalOf = null;
  if (overlord) {
    overlord.vassals = overlord.vassals.filter((v) => v !== minor.id);
  }
  // §11.5 revolting vassal reverts to neutral: release any owned provinces.
  for (const provId of minor.provinceIds) {
    const prov = next.provinces.find((p) => p.id === provId);
    if (prov && prov.ownerId === overlordId) prov.ownerId = null;
  }
  return appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "betrayal",
    actors: [minor.id],
    targets: overlordId ? [overlordId] : [],
    message: `${minor.name} revolts and throws off ${overlord?.name ?? "its overlord"} (${reason}).`,
    data: { reason, minorId: minor.id, conquered: !!minor.conquered },
  });
}

/**
 * §11.5 roll a revolt check for every CONQUERED vassal of `overlordId` (bribed
 * vassals are loyal and unaffected by trigger-revolts). Each conquered vassal
 * revolts on 1d6 ≤ VASSAL.conqueredRevoltRoll. Consumes `rng`.
 */
function rollConqueredVassalRevolts(
  state: GameState,
  overlordId: string,
  rng: Rng,
  reason: string,
): GameState {
  let next = state;
  for (const minor of next.minors) {
    if (minor.vassalOf !== overlordId) continue;
    if (!minor.conquered) continue; // §11.5 only the sword breeds this revolt
    const roll = rng.rollD6();
    if (roll <= VASSAL.conqueredRevoltRoll) {
      next = freeVassal(next, minor, `${reason}: conquered-vassal revolt (rolled ${roll})`);
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// applyDiplomacy — propose / accept / renounce treaties (§11)
// ---------------------------------------------------------------------------

/**
 * Apply a DIPLOMACY action (§11). PROPOSE parks a pending offer on the
 * activeModifiers side-channel (kind='treaty_proposal'); ACCEPT materialises the
 * treaty into both parties' `treaties`; RENOUNCE breaks an active treaty,
 * applying the break-prestige penalty (−4 alliance/marriage, −2 NAP; tribute is
 * free), incrementing the actor's betrayal count, and — for a royal marriage —
 * granting the jilted power a casus belli (a new state of war). A betrayal also
 * fires conquered-vassal revolt checks. Assumes the reducer already spent the
 * initiator's action (ACCEPT is free). Pure.
 */
export function applyDiplomacy(state: GameState, action: GameAction): GameState {
  if (action.type !== "DIPLOMACY") {
    throw new EngineError("UNKNOWN_ACTION", "applyDiplomacy requires a DIPLOMACY action.");
  }
  const { kind, treatyType, targetPlayerId, treatyId, tribute, expiresRound } =
    action.diplomacy;

  const actor = requirePlayer(state, action.player);

  // ---- PROPOSE -----------------------------------------------------------
  if (kind === "PROPOSE") {
    if (targetPlayerId === action.player) {
      throw new EngineError("BAD_DIPLOMACY", "Cannot treaty with yourself.");
    }
    requirePlayer(state, targetPlayerId);
    const next = clone(state);
    const proposalId = `treaty-${next.logCounter}`;
    next.activeModifiers = [
      ...next.activeModifiers,
      {
        id: proposalId,
        scope: "persistent",
        kind: "treaty_proposal",
        data: {
          treatyId: proposalId,
          proposerId: action.player,
          accepterId: targetPlayerId,
          treatyType,
          tribute: tribute ?? null,
          expiresRound: expiresRound ?? null,
        },
      },
    ];
    return appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "diplomacy",
      actors: [action.player],
      targets: [targetPlayerId],
      message: `${actor.name} proposes a ${treatyType} to ${playerById(next, targetPlayerId)?.name ?? targetPlayerId}.`,
      data: { proposalId, treatyType },
    });
  }

  // ---- ACCEPT ------------------------------------------------------------
  if (kind === "ACCEPT") {
    const next = clone(state);
    const idx = next.activeModifiers.findIndex(
      (m) =>
        m.kind === "treaty_proposal" &&
        (treatyId ? m.id === treatyId : true) &&
        m.data?.proposerId === targetPlayerId &&
        m.data?.accepterId === action.player &&
        m.data?.treatyType === treatyType,
    );
    if (idx < 0) {
      throw new EngineError(
        "NO_PROPOSAL",
        `No pending ${treatyType} from ${targetPlayerId} to accept.`,
      );
    }
    const proposal = next.activeModifiers[idx];
    next.activeModifiers = next.activeModifiers.filter((_, i) => i !== idx);

    const proposerId = String(proposal.data?.proposerId);
    const accepterId = action.player;
    const proposalTribute =
      (proposal.data?.tribute as Partial<ResourceBundle> | null) ?? undefined;
    const proposalExpiry =
      (proposal.data?.expiresRound as number | null) ?? undefined;

    const treaty: Treaty = {
      id: String(proposal.data?.treatyId ?? proposal.id),
      type: treatyType,
      parties: [proposerId, accepterId],
      startedRound: next.round,
      expiresRound: treatyExpiry(treatyType, next.round, proposalExpiry),
    };
    if (treatyType === TreatyType.TRIBUTE) {
      // §11 the proposer offers tribute (peace/protection); proposer = payer.
      treaty.tribute = proposalTribute ?? tribute;
      treaty.payerId = proposerId;
      treaty.tributeFrom = proposerId;
      treaty.tributeTo = accepterId;
    }

    for (const partyId of treaty.parties) {
      const p = playerById(next, partyId);
      if (p) p.treaties = [...p.treaties, { ...treaty }];
    }
    return appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "diplomacy",
      actors: [accepterId],
      targets: [proposerId],
      message: `${actor.name} concludes a ${treatyType} with ${playerById(next, proposerId)?.name ?? proposerId}.`,
      data: { treatyId: treaty.id, treatyType, expiresRound: treaty.expiresRound },
    });
  }

  // ---- RENOUNCE ----------------------------------------------------------
  if (kind === "RENOUNCE") {
    const active = treatyId
      ? actor.treaties.find((t) => t.id === treatyId)
      : actor.treaties.find(
          (t) => t.type === treatyType && t.parties.includes(targetPlayerId),
        );
    if (!active) {
      throw new EngineError(
        "NO_TREATY",
        `${actor.name} has no ${treatyType} to renounce with ${targetPlayerId}.`,
      );
    }
    const otherId = active.parties.find((id) => id !== action.player) ?? targetPlayerId;

    let next = clone(state);
    dropTreaty(next, active.id);
    const me = playerById(next, action.player)!;

    const penalty = breakPrestige(active.type);
    me.prestige += penalty; // §11 break penalty (negative)
    me.prestigeThisRound = (me.prestigeThisRound ?? 0) + penalty;

    let casusBelli = false;
    if (isPerfidy(active.type)) {
      me.betrayals += 1; // §11 reputation flag / betrayal count
      // §11 royal marriage break → the jilted power gains a casus belli.
      if (active.type === TreatyType.ROYAL_MARRIAGE) {
        casusBelli = addWar(next, otherId, action.player);
      }
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "betrayal",
        actors: [action.player],
        targets: [otherId],
        message: `${me.name} betrays the ${active.type} with ${playerById(next, otherId)?.name ?? otherId} (${penalty} prestige${casusBelli ? "; casus belli granted" : ""}).`,
        data: {
          treatyType: active.type,
          prestige: penalty,
          betrayals: me.betrayals,
          casusBelli,
          reputation: me.betrayals >= REPUTATION_BETRAYAL_THRESHOLD,
        },
      });

      // §11.5 "perfidy is contagious": a betrayal triggers conquered-vassal
      // revolt checks against the betrayer. Consumes the seeded RNG.
      const rng = makeRng(next.rngSeed, next.rngCursor);
      next = rollConqueredVassalRevolts(next, action.player, rng, "treaty betrayal");
      next.rngCursor = rng.cursor;
    } else {
      // §11 tribute simply lapses (no penalty to either side).
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "diplomacy",
        actors: [action.player],
        targets: [otherId],
        message: `${me.name} ends the TRIBUTE arrangement with ${playerById(next, otherId)?.name ?? otherId}.`,
        data: { treatyType: active.type },
      });
    }
    return next;
  }

  throw new EngineError("BAD_DIPLOMACY", `Unknown diplomacy kind: ${String(kind)}.`);
}

// ---------------------------------------------------------------------------
// applyVassalize — bribe & roll for an NPC minor (§11.5)
// ---------------------------------------------------------------------------

/**
 * Apply a VASSALIZE action (§11.5): pay an up-front bribe of
 * `8 + 4×(garrison count)` gold (+4 for the optional royal-marriage bribe), then
 * roll 1d6 + prestige-tier − garrison-tier (+1 if the marriage bribe is paid,
 * −1 if the actor has betrayed twice). On ≥ VASSAL.rollTarget (4) the minor
 * becomes a vassal; on failure half the bribe is refunded and the actor may
 * retry a later round. Derives RNG from state and writes the cursor back. Pure.
 */
export function applyVassalize(state: GameState, action: GameAction): GameState {
  if (action.type !== "VASSALIZE") {
    throw new EngineError("UNKNOWN_ACTION", "applyVassalize requires a VASSALIZE action.");
  }
  const actor = requirePlayer(state, action.player);
  const minor = state.minors.find((m) => m.id === action.minorId);
  if (!minor) throw new EngineError("NO_MINOR", `No such minor: ${action.minorId}.`);
  if (minor.vassalOf !== null) {
    throw new EngineError("ALREADY_VASSAL", `${minor.name} is already a vassal.`);
  }

  // §11.5 bribe = 8 + 4 × garrison unit count (+ optional +4 marriage bribe).
  let bribe = VASSAL.bribeBase + VASSAL.bribePerGarrison * minor.garrison;
  if (action.marriageBribe) bribe += VASSAL.marriageBribeGold;
  if (actor.treasury.gold < bribe) {
    throw new EngineError(
      "INSUFFICIENT_RESOURCES",
      `${actor.name} cannot afford the ${bribe}-gold bribe for ${minor.name}.`,
    );
  }

  const next = clone(state);
  const me = playerById(next, action.player)!;
  const tgt = next.minors.find((m) => m.id === action.minorId)!;
  me.treasury.gold -= bribe;

  const rng = makeRng(next.rngSeed, next.rngCursor);
  const die = rng.rollD6();
  const marriageBonus = action.marriageBribe ? VASSAL.marriageBribeBonus : 0; // §11.5 +1
  const repPenalty = reputationPenalty(me); // §11 −1 if betrayed twice
  // §11.5 roll = 1d6 + prestige-tier − garrison-tier (+ marriage bonus − rep).
  const roll = die + prestigeTier(me) - tgt.tier + marriageBonus - repPenalty;
  const success = roll >= VASSAL.rollTarget;

  if (success) {
    tgt.vassalOf = action.player;
    tgt.conquered = false; // §11.5 bought loyalty, not conquered
    // §11.5 first levy call is one cadence away.
    tgt.roundsUntilLevy = VASSAL.levyEveryRounds;
    tgt.levyCooldown = VASSAL.levyEveryRounds;
    if (!me.vassals.includes(tgt.id)) me.vassals = [...me.vassals, tgt.id];
    const out = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "diplomacy",
      actors: [action.player],
      targets: [tgt.id],
      message: `${me.name} vassalises ${tgt.name} (rolled ${die}, total ${roll} ≥ ${VASSAL.rollTarget}).`,
      data: { minorId: tgt.id, die, roll, bribe, marriageBribe: !!action.marriageBribe },
    });
    out.rngCursor = rng.cursor;
    return out;
  }

  // §11.5 failure: half the bribe is refunded; the actor may retry next round.
  const refund = Math.floor(bribe * VASSAL.failRefundFraction);
  me.treasury.gold += refund;
  const out = appendLog(next, {
    round: next.round,
    phase: next.phase,
    type: "diplomacy",
    actors: [action.player],
    targets: [tgt.id],
    message: `${me.name} fails to vassalise ${tgt.name} (rolled ${die}, total ${roll} < ${VASSAL.rollTarget}); ${refund} gold refunded.`,
    data: { minorId: tgt.id, die, roll, bribe, refund },
  });
  out.rngCursor = rng.cursor;
  return out;
}

// ---------------------------------------------------------------------------
// runRevolts — per-round vassal upkeep/benefits + revolt resolution (§11.5)
// ---------------------------------------------------------------------------

/**
 * Resolve the per-round vassal cycle and pending revolts (§11.5 / §11), called
 * once per round in the END phase:
 *  - Vassal tribute: each vassal pays its province yields ×0.5 to its overlord.
 *  - Levy call: once per VASSAL.levyEveryRounds the overlord gains a free stack
 *    of `2 LEVY (+1 per garrison-tier)` raised in the vassal's capital.
 *  - Vassal prestige: +1/round per held vassal, and +2/round to BOTH parties of
 *    every active royal marriage; player-to-player TRIBUTE treaties transfer.
 *  - Revolts: event-driven triggers (activeModifiers of kind 'revolt' /
 *    'vassal_revolt' / 'unrest') fire conquered-vassal revolt checks (1d6 ≤ 2),
 *    or force a flagged minor (data.minorId) to revolt outright.
 * Consumes the seeded RNG and writes the advanced cursor back. Pure.
 */
export function runRevolts(state: GameState): GameState {
  let next = clone(state);
  const rng = makeRng(next.rngSeed, next.rngCursor);

  // --- 1) Per-round vassal economics, levies and prestige ----------------
  for (const minor of next.minors) {
    if (minor.vassalOf === null) continue;
    const overlord = playerById(next, minor.vassalOf);
    if (!overlord) continue;

    // §11.5 tribute income: overlord gains Σ(vassal yields) × 0.5 (floor).
    const tribute: Partial<ResourceBundle> = {};
    let anyTribute = false;
    for (const provId of minor.provinceIds) {
      const prov = next.provinces.find((p) => p.id === provId);
      if (!prov) continue;
      for (const k of RESOURCE_KEYS) {
        const share = Math.floor((prov.yields[k] ?? 0) * VASSAL.tributeFraction);
        if (share > 0) {
          tribute[k] = (tribute[k] ?? 0) + share;
          overlord.treasury[k] += share;
          anyTribute = true;
        }
      }
    }

    // §11.5 prestige: holding a vassal is worth +1/round.
    overlord.prestige += VASSAL.prestigePerRound;
    overlord.prestigeThisRound =
      (overlord.prestigeThisRound ?? 0) + VASSAL.prestigePerRound;

    // §11.5 levy call once per VASSAL.levyEveryRounds rounds.
    const cooldown = minor.roundsUntilLevy ?? 0;
    let leviedCount = 0;
    if (cooldown <= 0) {
      leviedCount = VASSAL.levyBase + VASSAL.levyPerTier * minor.tier;
      const capital = minor.provinceIds[0];
      let army: Army | undefined = next.armies.find(
        (a) => a.ownerId === overlord.id && a.locationId === capital,
      );
      if (!army) {
        army = {
          id: `army-levy-${minor.id}-${next.round}`,
          ownerId: overlord.id,
          locationId: capital,
          units: emptyUnits(),
        };
        next.armies = [...next.armies, army];
      }
      army.units[UnitType.LEVY] = (army.units[UnitType.LEVY] ?? 0) + leviedCount;
      minor.roundsUntilLevy = VASSAL.levyEveryRounds;
      minor.levyCooldown = VASSAL.levyEveryRounds;
    } else {
      minor.roundsUntilLevy = cooldown - 1;
      minor.levyCooldown = cooldown - 1;
    }

    next = appendLog(next, {
      round: next.round,
      phase: next.phase,
      type: "diplomacy",
      actors: [minor.id],
      targets: [overlord.id],
      message: `${minor.name} renders service to ${overlord.name}${anyTribute ? " (tribute paid)" : ""}${leviedCount > 0 ? `, raising ${leviedCount} levies` : ""}.`,
      data: {
        minorId: minor.id,
        tribute,
        levies: leviedCount,
        prestige: VASSAL.prestigePerRound,
      },
    });
  }

  // --- 2) Royal-marriage per-round prestige (+2 to BOTH), once per marriage.
  const scoredMarriages = new Set<string>();
  for (const player of next.players) {
    for (const treaty of player.treaties) {
      if (treaty.type !== TreatyType.ROYAL_MARRIAGE) continue;
      if (scoredMarriages.has(treaty.id)) continue;
      scoredMarriages.add(treaty.id);
      for (const partyId of treaty.parties) {
        const p = playerById(next, partyId);
        if (!p) continue;
        p.prestige += PRESTIGE_VALUES.royalMarriagePerRound; // §11 +2/round
        p.prestigeThisRound =
          (p.prestigeThisRound ?? 0) + PRESTIGE_VALUES.royalMarriagePerRound;
      }
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "prestige_change",
        actors: treaty.parties,
        message: `A royal marriage binds ${treaty.parties.join(" & ")} (+${PRESTIGE_VALUES.royalMarriagePerRound} prestige each).`,
        data: { treatyId: treaty.id, prestige: PRESTIGE_VALUES.royalMarriagePerRound },
      });
    }
  }

  // --- 3) Player-to-player TRIBUTE treaty transfers (once per treaty) ------
  const settledTribute = new Set<string>();
  for (const player of next.players) {
    for (const treaty of [...player.treaties]) {
      if (treaty.type !== TreatyType.TRIBUTE) continue;
      if (settledTribute.has(treaty.id)) continue;
      settledTribute.add(treaty.id);
      const payer = playerById(next, treaty.tributeFrom ?? treaty.payerId ?? "");
      const payee = playerById(next, treaty.tributeTo ?? "");
      const bundle = treaty.tribute ?? {};
      if (!payer || !payee) continue;
      const canPay = RESOURCE_KEYS.every(
        (k) => payer.treasury[k] >= (bundle[k] ?? 0),
      );
      if (!canPay) {
        // §11 missed tribute voids the pact (no penalty to the receiver).
        dropTreaty(next, treaty.id);
        next = appendLog(next, {
          round: next.round,
          phase: next.phase,
          type: "diplomacy",
          actors: [payer.id],
          targets: [payee.id],
          message: `${payer.name} cannot render tribute to ${payee.name}; the pact voids.`,
          data: { treatyId: treaty.id, voided: true },
        });
        continue;
      }
      for (const k of RESOURCE_KEYS) {
        const amt = bundle[k] ?? 0;
        payer.treasury[k] -= amt;
        payee.treasury[k] += amt;
      }
      next = appendLog(next, {
        round: next.round,
        phase: next.phase,
        type: "diplomacy",
        actors: [payer.id],
        targets: [payee.id],
        message: `${payer.name} pays tribute to ${payee.name}.`,
        data: { treatyId: treaty.id, tribute: bundle },
      });
    }
  }

  // --- 4) Event-driven revolts (§11.5 revolt Omen cards / unrest) ----------
  const revoltMods = next.activeModifiers.filter(
    (m) => m.kind === "revolt" || m.kind === "vassal_revolt" || m.kind === "unrest",
  );
  for (const mod of revoltMods) {
    const minorId = mod.data?.minorId ? String(mod.data.minorId) : undefined;
    if (minorId) {
      // A card that names a specific minor forces it to revolt outright.
      const minor = next.minors.find((m) => m.id === minorId);
      if (minor && minor.vassalOf !== null) {
        next = freeVassal(next, minor, `event: ${mod.kind}`);
      }
    } else {
      // Otherwise the trigger rolls conquered-vassal revolts for the overlord(s).
      const targetFaction = mod.target?.faction;
      const overlordIds = new Set<string>();
      for (const minor of next.minors) {
        if (minor.vassalOf === null) continue;
        if (targetFaction) {
          const ov = playerById(next, minor.vassalOf);
          if (ov?.faction !== targetFaction) continue;
        }
        overlordIds.add(minor.vassalOf);
      }
      for (const overlordId of overlordIds) {
        next = rollConqueredVassalRevolts(next, overlordId, rng, `event: ${mod.kind}`);
      }
    }
  }
  // Clear one-shot revolt triggers so they do not re-fire next round.
  next.activeModifiers = next.activeModifiers.filter(
    (m) => !(m.kind === "vassal_revolt" || (m.kind === "revolt" && m.scope !== "game")),
  );

  next.rngCursor = rng.cursor; // determinism: persist advanced cursor
  return next;
}
