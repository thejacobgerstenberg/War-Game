/**
 * DiplomacyModal — "The Court of Envoys" (design/mockups/diplomacy.html).
 *
 * Engine reality mirrored here (server/src/engine/diplomacy.ts + balance.ts):
 *  - DIPLOMACY PROPOSE parks a `treaty_proposal` on state.activeModifiers;
 *    ACCEPT (free, un-budgeted) materialises it into both parties' treaties
 *    and ENDS any war between them (TRIBUTE forces a victor: the accepter);
 *    RENOUNCE breaks a treaty — Alliance −4 / Royal Marriage −4 / Truce (NAP)
 *    −2 Prestige, Tribute lapses free; a broken marriage grants the jilted
 *    crown a casus belli (a state of war) and every perfidy counts a betrayal
 *    (twice forsworn = −1 to later diplomacy rolls).
 *  - DECLARE_WAR: a justified war (claim / crusade / vassal-defense /
 *    ally-call) costs nothing; an UNJUSTIFIED one costs 1 Prestige
 *    (balance.UNJUSTIFIED_WAR_PRESTIGE).
 *  - VASSALIZE: bribe = 8 + 4×garrison gold (+4 for the marriage bribe);
 *    roll 1d6 + prestige-tier(≤2) − ⌊garrison/2⌋ (+1 marriage, −1 twice
 *    forsworn) ≥ 4; failure refunds half the bribe.
 *  - LEVY_CALL: once per 2 rounds a vassal lends 2 + ⌊garrison/2⌋ levies.
 *  - TRIBUTE direction is canonical: the PROPOSER pays, the accepter receives.
 * All costs above are read from the engine's balance constants (vendored
 * below with provenance) — never invented.
 *
 * Copy: design/mockups/diplomacy.html, lore/ui-text.md §3/§7,
 * lore/tutorial/script.md step-24. Sounds: crowd_murmur while the court is
 * open, ui_click on presses, quill_scratch on seals, horn_fanfare when war is
 * declared, church_bell when a royal marriage is sealed (README §4).
 *
 * Opened by OverlayManager on intent {type:"diplomacy", targetPlayerId?}.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GamePhase, TreatyType } from "@imperium/shared";
import type {
  GameLogEntry,
  GameState,
  NpcMinor,
  Player,
  Treaty,
} from "@imperium/shared";
import { Button, ConfirmModal, CREST_URL, IconChip, Modal, toRoman, useToast } from "../../ui";
import { useAudio } from "../../audio/AudioProvider";
import { useGame } from "../GameProvider";
import { isMyTurn, provinceById } from "../selectors";
import { ACTION_ERROR_COPY, BUTTONS, FACTION_NAME } from "../uiText";
import "./court.css";

/* ---------------------------------------------------------------------------
 * Vendored engine numbers (client may not import server code).
 * PROVENANCE: server/src/engine/balance.ts — PRESTIGE_VALUES.betrayAlliance −4,
 * betrayNap −2, betrayMarriage −4, royalMarriagePerRound +2, vassalPerRound +1,
 * winWar +3; UNJUSTIFIED_WAR_PRESTIGE 1; VASSAL { bribeBase 8, bribePerGarrison
 * 4, rollTarget 4, garrisonTierDivisor 2, prestigeTierCap 2, marriageBribeBonus
 * +1, marriageBribeGold 4, failRefundFraction 0.5, tributeFraction 0.5,
 * levyEveryRounds 2, levyBase 2, levyPerTier 1 }; and diplomacy.ts —
 * NAP_DEFAULT_ROUNDS 3, REPUTATION_BETRAYAL_THRESHOLD 2. Re-copy when tuned.
 * ------------------------------------------------------------------------- */
const BREAK_PRESTIGE: Record<TreatyType, number> = {
  [TreatyType.ALLIANCE]: -4,
  [TreatyType.NAP]: -2,
  [TreatyType.TRIBUTE]: 0,
  [TreatyType.ROYAL_MARRIAGE]: -4,
};
const UNJUSTIFIED_WAR_PRESTIGE = 1;
const VASSAL = {
  bribeBase: 8,
  bribePerGarrison: 4,
  rollTarget: 4,
  garrisonTierDivisor: 2,
  prestigeTierCap: 2,
  marriageBribeBonus: 1,
  marriageBribeGold: 4,
  failRefundFraction: 0.5,
  levyBase: 2,
  levyPerTier: 1,
} as const;
const BETRAYAL_THRESHOLD = 2;
const NAP_DEFAULT_ROUNDS = 3;

/** Treaty kind display names (mockup: alliance, pact, tribute, truce). */
const TREATY_KIND: Record<TreatyType, string> = {
  [TreatyType.ALLIANCE]: "Alliance",
  [TreatyType.NAP]: "Truce",
  [TreatyType.TRIBUTE]: "Tribute",
  [TreatyType.ROYAL_MARRIAGE]: "Royal Marriage",
};

/** In-voice terms per kind (diplomacy.html rows / offer-terms, verbatim). */
const TREATY_TERMS: Record<TreatyType, string> = {
  [TreatyType.ALLIANCE]:
    "Each crown answers the other's call to war, and neither takes the field against the other.",
  [TreatyType.NAP]:
    "Neither host nor fleet of either crown takes the field against the other while the truce holds.",
  [TreatyType.TRIBUTE]: "Gold rendered at each Income, for which the other stays its hand.",
  [TreatyType.ROYAL_MARRIAGE]:
    "A royal marriage binds the two houses (+2 Prestige to each crown every round).",
};

const NUMBER_WORDS = [
  "nought", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve",
] as const;
function numberWord(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}
function numberWordCap(n: number): string {
  const w = numberWord(n);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** A pending PROPOSE parked on activeModifiers (kind "treaty_proposal"). */
interface ProposalView {
  id: string;
  proposerId: string;
  accepterId: string;
  treatyType: TreatyType;
  tributeGold: number;
  expiresRound: number | null;
}

function readProposals(state: GameState): ProposalView[] {
  const out: ProposalView[] = [];
  for (const m of state.activeModifiers) {
    if (m.kind !== "treaty_proposal" || !m.data) continue;
    const tribute = m.data.tribute as { gold?: number } | null | undefined;
    out.push({
      id: String(m.data.treatyId ?? m.id),
      proposerId: String(m.data.proposerId ?? ""),
      accepterId: String(m.data.accepterId ?? ""),
      treatyType: m.data.treatyType as TreatyType,
      tributeGold: tribute?.gold ?? 0,
      expiresRound: (m.data.expiresRound as number | null) ?? null,
    });
  }
  return out;
}

function enduresText(expiresRound: number | null | undefined, round: number): string {
  if (expiresRound === null || expiresRound === undefined) {
    return "Until the years run out";
  }
  const remain = expiresRound - round;
  if (remain <= 0) return "Lapsed";
  if (remain === 1) return "One round remains";
  return `${numberWordCap(remain)} rounds remain`;
}

/** Break-Faith consequence, in voice, with the engine's real prestige costs. */
function breakConsequence(type: TreatyType): string {
  const cost = Math.abs(BREAK_PRESTIGE[type]);
  if (type === TreatyType.TRIBUTE) {
    return "The tribute simply lapses. No Prestige is struck; the pact voids.";
  }
  const struck = `${numberWordCap(cost)} Prestige are struck from your name`;
  if (type === TreatyType.ROYAL_MARRIAGE) {
    return `${struck}, and the jilted crown gains a casus belli — a state of war. The scribes forget nothing.`;
  }
  return `${struck}, and the scribes forget nothing.`;
}

const JUSTIFICATIONS = [
  { key: "none", label: "No cause", gloss: "The scribes will call the war unjustified." },
  { key: "claim", label: "A claim", gloss: "A broken marriage or a seized key city." },
  { key: "crusade", label: "A crusade", gloss: "Preached and blessed." },
  { key: "vassal-defense", label: "Defense of a vassal", gloss: "A crown that kneels to you stands in need." },
  { key: "ally-call", label: "An ally's call", gloss: "A sworn ally already at war summons you." },
] as const;
type JustificationKey = (typeof JUSTIFICATIONS)[number]["key"];

export interface DiplomacyModalProps {
  /** Pre-selected rival court, when opened from a context that names one. */
  targetPlayerId?: string;
  onClose: () => void;
}

type ConfirmState =
  | { kind: "break"; treaty: Treaty; otherId: string }
  | { kind: "war"; rival: Player }
  | { kind: "vassalize"; minor: NpcMinor; marriage: boolean }
  | null;

export function DiplomacyModal({ targetPlayerId, onClose }: DiplomacyModalProps): JSX.Element {
  const { gameState, myPlayerId, dispatch, pendingAction, timer } = useGame();
  const { playSfx } = useAudio();
  const toast = useToast();

  const my = gameState.players.find((p) => p.id === myPlayerId) ?? null;
  const rivals = gameState.players.filter((p) => p.id !== myPlayerId);

  // crowd_murmur loops for the life of this screen (README §4).
  const murmured = useRef(false);
  useEffect(() => {
    if (!murmured.current) {
      murmured.current = true;
      playSfx("crowd_murmur");
    }
  }, [playSfx]);

  /* ---- act gating: PROPOSE/RENOUNCE/DECLARE_WAR/VASSALIZE/LEVY_CALL are
   * budgeted deeds in the action window; ACCEPT is free (engine actions.ts). */
  const myTurn = isMyTurn(gameState, myPlayerId, timer);
  const inWindow =
    gameState.phase === GamePhase.RECRUITMENT ||
    gameState.phase === GamePhase.MOVEMENT ||
    gameState.phase === GamePhase.DIPLOMACY;
  const deeds = my?.actionsRemaining ?? 0;
  const actReason = !myTurn
    ? ACTION_ERROR_COPY.NOT_YOUR_TURN
    : !inWindow
      ? "You wait upon another court. Be patient."
      : deeds <= 0
        ? ACTION_ERROR_COPY.NO_ACTIONS
        : undefined;

  /* ---- table data --------------------------------------------------------- */
  const treaties = useMemo(() => {
    const byId = new Map<string, Treaty>();
    for (const p of gameState.players) {
      for (const t of p.treaties) if (!byId.has(t.id)) byId.set(t.id, t);
    }
    return [...byId.values()];
  }, [gameState.players]);

  const proposals = useMemo(() => readProposals(gameState), [gameState]);
  const [dismissedOffers, setDismissedOffers] = useState<ReadonlySet<string>>(new Set());
  const incoming = proposals.filter(
    (p) => p.accepterId === myPlayerId && !dismissedOffers.has(p.id),
  );
  const outgoing = proposals.filter((p) => p.proposerId === myPlayerId);

  // Broken seals stay legible (mockup zone 1: the Gallipoli row).
  const broken = useMemo(
    () =>
      gameState.log
        .filter(
          (e: GameLogEntry) => e.type === "betrayal" && e.data?.treatyType !== undefined,
        )
        .slice(-3),
    [gameState.log],
  );

  const playerName = (id: string): string => {
    const p = gameState.players.find((x) => x.id === id);
    return p ? (p.faction ? FACTION_NAME[p.faction] : p.name) : id;
  };
  const crestOf = (id: string): string | null => {
    const f = gameState.players.find((x) => x.id === id)?.faction ?? null;
    return f ? CREST_URL[f] : null;
  };

  const atWarWith = (rivalId: string): number | null => {
    const w = gameState.wars.find(
      (x) =>
        (x.a === myPlayerId && x.b === rivalId) || (x.a === rivalId && x.b === myPlayerId),
    );
    return w ? w.startedRound : null;
  };

  /* ---- composer (Extend the Hand / Sue for Peace) ------------------------- */
  const [composer, setComposer] = useState<{
    targetPlayerId: string;
    treatyType: TreatyType;
  } | null>(targetPlayerId !== undefined ? { targetPlayerId, treatyType: TreatyType.NAP } : null);
  const [tributeGold, setTributeGold] = useState(2);
  const [truceRounds, setTruceRounds] = useState(NAP_DEFAULT_ROUNDS);

  const sealProposal = (): void => {
    if (!composer) return;
    playSfx("quill_scratch");
    dispatch({
      type: "DIPLOMACY",
      player: myPlayerId,
      diplomacy: {
        kind: "PROPOSE",
        treatyType: composer.treatyType,
        targetPlayerId: composer.targetPlayerId,
        ...(composer.treatyType === TreatyType.TRIBUTE
          ? { tribute: { gold: Math.max(1, tributeGold) } }
          : {}),
        ...(composer.treatyType === TreatyType.NAP
          ? { expiresRound: gameState.round + Math.max(1, truceRounds) }
          : {}),
      },
    });
    setComposer(null);
  };

  const acceptOffer = (offer: ProposalView): void => {
    playSfx("quill_scratch");
    if (offer.treatyType === TreatyType.ROYAL_MARRIAGE) playSfx("church_bell");
    dispatch({
      type: "DIPLOMACY",
      player: myPlayerId,
      diplomacy: {
        kind: "ACCEPT",
        treatyType: offer.treatyType,
        targetPlayerId: offer.proposerId,
        treatyId: offer.id,
      },
    });
    toast.triumph("So it is written.");
  };

  /* ---- destructive confirms ------------------------------------------------ */
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [justification, setJustification] = useState<JustificationKey>("none");

  // Mirrors diplomacy.ts::isJustifiedWar so the warning is honest.
  const justificationHolds = (key: JustificationKey): boolean => {
    switch (key) {
      case "claim":
      case "crusade":
        return true;
      case "vassal-defense":
        return gameState.minors.some((m) => m.vassalOf === myPlayerId);
      case "ally-call": {
        const allyIds = new Set<string>();
        for (const t of my?.treaties ?? []) {
          if (t.type !== TreatyType.ALLIANCE) continue;
          for (const party of t.parties) if (party !== myPlayerId) allyIds.add(party);
        }
        return gameState.wars.some((w) => allyIds.has(w.a) || allyIds.has(w.b));
      }
      default:
        return false;
    }
  };

  const sealBreak = (treaty: Treaty, otherId: string): void => {
    playSfx("quill_scratch");
    dispatch({
      type: "DIPLOMACY",
      player: myPlayerId,
      diplomacy: {
        kind: "RENOUNCE",
        treatyType: treaty.type,
        targetPlayerId: otherId,
        treatyId: treaty.id,
      },
    });
    setConfirm(null);
  };

  const sealWar = (rival: Player): void => {
    if (!rival.faction) return;
    playSfx("quill_scratch");
    playSfx("horn_fanfare");
    dispatch({
      type: "DECLARE_WAR",
      player: myPlayerId,
      target: rival.faction,
      ...(justification !== "none" ? { justification } : {}),
    });
    setConfirm(null);
  };

  /* ---- vassals ------------------------------------------------------------- */
  const [marriageBribes, setMarriageBribes] = useState<ReadonlySet<string>>(new Set());
  const toggleMarriage = (minorId: string): void => {
    playSfx("ui_click");
    setMarriageBribes((prev) => {
      const next = new Set(prev);
      if (next.has(minorId)) next.delete(minorId);
      else next.add(minorId);
      return next;
    });
  };

  const bribeFor = (minor: NpcMinor, marriage: boolean): number =>
    VASSAL.bribeBase +
    VASSAL.bribePerGarrison * minor.garrison +
    (marriage ? VASSAL.marriageBribeGold : 0);

  /** The die face the §11.5 vassalize roll must show, given all modifiers. */
  const neededCast = (minor: NpcMinor, marriage: boolean): number => {
    const pTier = Math.min(
      VASSAL.prestigeTierCap,
      Math.max(0, Math.floor((my?.prestige ?? 0) / 10)),
    );
    const gTier = Math.floor(minor.garrison / VASSAL.garrisonTierDivisor);
    const rep = (my?.betrayals ?? 0) >= BETRAYAL_THRESHOLD ? 1 : 0;
    return VASSAL.rollTarget - pTier + gTier - (marriage ? VASSAL.marriageBribeBonus : 0) + rep;
  };

  const oddsLine = (minor: NpcMinor, marriage: boolean): string => {
    const need = neededCast(minor, marriage);
    if (need <= 1) return "Any cast of the die prospers.";
    if (need > 6) return "No cast of the die can prosper — their garrison is too proud.";
    return `The suit prospers on a cast of ${numberWord(need)} or better.`;
  };

  const sealVassalize = (minor: NpcMinor, marriage: boolean): void => {
    playSfx("quill_scratch");
    dispatch({
      type: "VASSALIZE",
      player: myPlayerId,
      minorId: minor.id,
      ...(marriage ? { marriageBribe: true } : {}),
    });
    setConfirm(null);
  };

  const callLevy = (minor: NpcMinor): void => {
    playSfx("quill_scratch");
    dispatch({ type: "LEVY_CALL", player: myPlayerId, minorId: minor.id });
  };

  const minorPlace = (minor: NpcMinor): string => {
    const names = minor.provinceIds
      .map((id) => provinceById(gameState, id)?.name ?? id)
      .join(", ");
    return names;
  };

  /* ---- render --------------------------------------------------------------- */
  const envoy = incoming[0];

  return (
    <Modal title="The Court of Envoys" onClose={onClose} wide>
      <div className="dip-head">
        <p className="rubric">Where wars are ended on parchment, and begun in whispers.</p>
        <div className="dip-when">
          <span className="pill">Round {toRoman(gameState.round)}</span>
          <span className="pill">Era {toRoman(gameState.era)}</span>
        </div>
      </div>

      {/* ZONE 6/7 · The envoy: incoming offer (answered, not ignored). */}
      {envoy && (
        <section className="dip-envoy" aria-label="An envoy is received">
          <div className="dip-seal-disc" aria-hidden="true">
            {crestOf(envoy.proposerId) && (
              <img src={crestOf(envoy.proposerId) ?? undefined} alt="" />
            )}
          </div>
          <p className="dip-envoy-kicker">
            An envoy of {playerName(envoy.proposerId)} is received
          </p>
          <h3>
            {playerName(envoy.proposerId)} proposes a {TREATY_KIND[envoy.treatyType]}
          </h3>
          <blockquote className="dip-offer-words">
            {playerName(envoy.proposerId)} proposes a{" "}
            {TREATY_KIND[envoy.treatyType].toLowerCase()}
            {envoy.treatyType === TreatyType.TRIBUTE
              ? `. Tribute: ${numberWord(envoy.tributeGold)} Gold each round, rendered to you.`
              : envoy.expiresRound !== null
                ? ` of ${numberWord(Math.max(1, envoy.expiresRound - gameState.round))} rounds.`
                : "."}
          </blockquote>
          <dl className="dip-offer-terms">
            <dt>The terms</dt>
            <dd>{TREATY_TERMS[envoy.treatyType]}</dd>
            {envoy.treatyType === TreatyType.TRIBUTE && (
              <>
                <dt>The price</dt>
                <dd>
                  <IconChip icon="gold" label="Gold" value={envoy.tributeGold} /> rendered to
                  you at each Income — the proposer pays.
                </dd>
              </>
            )}
            <dt>The term</dt>
            <dd>{enduresText(envoy.expiresRound, gameState.round)}</dd>
          </dl>
          <div className="modal-actions">
            <Button
              variant="quiet"
              onClick={() => {
                playSfx("ui_click");
                setDismissedOffers((prev) => new Set(prev).add(envoy.id));
              }}
              title="Refuse the offer. The envoy departs."
            >
              Send the Envoy Home
            </Button>
            <Button
              onClick={() => {
                playSfx("ui_click");
                setComposer({
                  targetPlayerId: envoy.proposerId,
                  treatyType: envoy.treatyType,
                });
                if (envoy.treatyType === TreatyType.TRIBUTE) {
                  setTributeGold(Math.max(1, envoy.tributeGold));
                }
              }}
              title="Keep the terms in hand; your counter rides back with the envoy."
            >
              Name Another Price
            </Button>
            <Button variant="primary" onClick={() => acceptOffer(envoy)} disabled={pendingAction}>
              Seal It
            </Button>
          </div>
          <p className="dip-seal-caution">
            A sealed {TREATY_KIND[envoy.treatyType].toLowerCase()} binds. Break it, and{" "}
            {numberWord(Math.abs(BREAK_PRESTIGE[envoy.treatyType]))} Prestige are struck from
            your name.
          </p>
        </section>
      )}

      {/* ZONE 1/2 · Seals in Force. */}
      <h3 className="dip-section-title">Seals in Force</h3>
      {treaties.length === 0 && incoming.length === 0 && broken.length === 0 ? (
        <p className="rubric">No seal yet binds the powers. The wax is unspent.</p>
      ) : (
        <div className="dip-treaty-scroll">
          <table className="table dip-treaty-table">
            <thead>
              <tr>
                <th scope="col">Arrangement</th>
                <th scope="col">Parties</th>
                <th scope="col">The Terms</th>
                <th scope="col">Endures</th>
                <th scope="col">Standing</th>
              </tr>
            </thead>
            <tbody>
              {treaties.map((t) => {
                const otherId = t.parties.find((id) => id !== myPlayerId) ?? t.parties[0];
                const mine = t.parties.includes(myPlayerId);
                const lapsed = t.expiresRound !== null && t.expiresRound <= gameState.round;
                return (
                  <tr key={t.id}>
                    <td>
                      <span className="dip-arrangement-kind">{TREATY_KIND[t.type]}</span>
                    </td>
                    <td>
                      <span className="dip-party-pair">
                        {t.parties.map((id, i) => (
                          <span key={id} className="dip-party">
                            {i > 0 && (
                              <span className="dip-pair-tie" aria-hidden="true">
                                {t.type === TreatyType.TRIBUTE ? "⟶" : "&"}
                              </span>
                            )}
                            {crestOf(id) && <img src={crestOf(id) ?? undefined} alt="" />}
                            {playerName(id)}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td>
                      {t.type === TreatyType.TRIBUTE
                        ? `${numberWordCap(t.tribute?.gold ?? t.tributeAmount ?? 0)} Gold rendered to ${playerName(
                            t.tributeTo ?? otherId,
                          )} at each Income.`
                        : TREATY_TERMS[t.type]}
                    </td>
                    <td className="dip-endures">
                      {enduresText(t.expiresRound, gameState.round)}
                    </td>
                    <td>
                      {lapsed ? (
                        <span className="pill">Lapsed</span>
                      ) : (
                        <span className="pill pill--laurel">In force</span>
                      )}{" "}
                      {mine && !lapsed && (
                        <Button
                          variant="danger"
                          onClick={() => {
                            playSfx("ui_click");
                            setConfirm({ kind: "break", treaty: t, otherId });
                          }}
                          disabledReason={actReason}
                        >
                          Break Faith
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {incoming.map((p) => (
                <tr key={p.id} className="dip-is-proposed">
                  <td>
                    <span className="dip-arrangement-kind">{TREATY_KIND[p.treatyType]}</span>
                  </td>
                  <td>
                    <span className="dip-party-pair">
                      <span className="dip-party">
                        {crestOf(p.proposerId) && (
                          <img src={crestOf(p.proposerId) ?? undefined} alt="" />
                        )}
                        {playerName(p.proposerId)}
                      </span>
                      <span className="dip-pair-tie" aria-hidden="true">
                        &
                      </span>
                      <span className="dip-party">
                        {crestOf(myPlayerId) && (
                          <img src={crestOf(myPlayerId) ?? undefined} alt="" />
                        )}
                        {playerName(myPlayerId)}
                      </span>
                    </span>
                  </td>
                  <td>The envoy waits upon your word.</td>
                  <td className="dip-endures">
                    {enduresText(p.expiresRound, gameState.round)}, if sealed
                  </td>
                  <td>
                    <span className="pill pill--gold">Awaiting your word</span>
                  </td>
                </tr>
              ))}
              {broken.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className="dip-arrangement-kind">
                      {TREATY_KIND[e.data?.treatyType as TreatyType] ?? "Pact"}
                    </span>
                  </td>
                  <td>
                    <span className="dip-party-pair">
                      {[...e.actors, ...(e.targets ?? [])].slice(0, 2).map((id, i) => (
                        <span key={`${e.id}-${id}`} className="dip-party">
                          {i > 0 && (
                            <span className="dip-pair-tie" aria-hidden="true">
                              &
                            </span>
                          )}
                          {crestOf(id) && <img src={crestOf(id) ?? undefined} alt="" />}
                          {playerName(id)}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>{e.message}</td>
                  <td className="dip-endures">Broken in round {numberWord(e.round)}</td>
                  <td>
                    <span className="pill pill--crimson">Broken</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {outgoing.map((p) => (
        <p key={p.id} className="rubric">
          Your envoy waits upon {playerName(p.accepterId)}&rsquo;s word — a{" "}
          {TREATY_KIND[p.treatyType].toLowerCase()} is proposed.
        </p>
      ))}

      {/* The rival courts: propose, sue for peace, take the field. */}
      <h3 className="dip-section-title">The Courts</h3>
      <div className="dip-courts">
        {rivals.map((rival) => {
          const warSince = atWarWith(rival.id);
          const shared = (my?.treaties ?? []).filter((t) => t.parties.includes(rival.id));
          return (
            <div key={rival.id} className="dip-court-row">
              {rival.faction ? (
                <img className="dip-court-crest" src={CREST_URL[rival.faction]} alt="" />
              ) : (
                <span className="dip-court-crest" aria-hidden="true" />
              )}
              <div>
                <span className="dip-court-name">
                  {rival.faction ? FACTION_NAME[rival.faction] : rival.name}
                </span>
                <div className="dip-court-standing">
                  {warSince !== null && (
                    <span className="pill pill--crimson">
                      At war since Round {toRoman(warSince)}
                    </span>
                  )}
                  {shared.map((t) => (
                    <span key={t.id} className="pill pill--laurel">
                      {TREATY_KIND[t.type]}
                    </span>
                  ))}
                  {warSince === null && shared.length === 0 && (
                    <span className="pill">No seal binds you</span>
                  )}
                </div>
              </div>
              <div className="dip-court-actions">
                <Button
                  onClick={() => {
                    playSfx("ui_click");
                    setComposer({ targetPlayerId: rival.id, treatyType: TreatyType.NAP });
                  }}
                  disabledReason={actReason}
                  title="Send envoys; make and break pacts"
                >
                  {warSince !== null ? "Sue for Peace" : "Extend the Hand"}
                </Button>
                {warSince === null && (
                  <Button
                    variant="danger"
                    onClick={() => {
                      playSfx("ui_click");
                      setJustification("none");
                      setConfirm({ kind: "war", rival });
                    }}
                    disabledReason={
                      actReason ??
                      (shared.some(
                        (t) =>
                          t.type === TreatyType.NAP || t.type === TreatyType.ALLIANCE,
                      )
                        ? ACTION_ERROR_COPY.TREASON_GATE
                        : undefined)
                    }
                  >
                    Take the Field
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* The composer — Extend the Hand. */}
      {composer && (
        <section className="dip-composer" aria-label="Extend the Hand">
          <h3 className="dip-section-title" style={{ marginTop: 0 }}>
            Extend the Hand — {playerName(composer.targetPlayerId)}
          </h3>
          {atWarWith(composer.targetPlayerId) !== null && (
            <p className="rubric">
              You are at war. A pact sealed between you concludes the peace
              {" — "}a tribute forces the victor&rsquo;s terms.
            </p>
          )}
          <div className="dip-composer-row" role="radiogroup" aria-label="The arrangement">
            <span className="dip-composer-label">Arrangement</span>
            {(
              [
                TreatyType.ALLIANCE,
                TreatyType.NAP,
                TreatyType.TRIBUTE,
                TreatyType.ROYAL_MARRIAGE,
              ] as const
            ).map((tt) => (
              <Button
                key={tt}
                selected={composer.treatyType === tt}
                onClick={() => {
                  playSfx("ui_click");
                  setComposer({ ...composer, treatyType: tt });
                }}
              >
                {TREATY_KIND[tt]}
              </Button>
            ))}
          </div>
          <p className="rubric">{TREATY_TERMS[composer.treatyType]}</p>
          {composer.treatyType === TreatyType.TRIBUTE && (
            <div className="dip-composer-row">
              <label className="dip-composer-label" htmlFor="dip-tribute-gold">
                The price
              </label>
              <input
                id="dip-tribute-gold"
                className="dip-field"
                type="number"
                min={1}
                max={my?.treasury.gold ?? 99}
                value={tributeGold}
                onChange={(e) => setTributeGold(Number(e.target.value))}
              />
              <span>
                Gold rendered by you to {playerName(composer.targetPlayerId)} at each Income —
                the proposer pays.
              </span>
            </div>
          )}
          {composer.treatyType === TreatyType.NAP && (
            <div className="dip-composer-row">
              <label className="dip-composer-label" htmlFor="dip-truce-rounds">
                The term
              </label>
              <input
                id="dip-truce-rounds"
                className="dip-field"
                type="number"
                min={1}
                max={16}
                value={truceRounds}
                onChange={(e) => setTruceRounds(Number(e.target.value))}
              />
              <span>rounds of quiet. A truce holds three rounds unless another term is named.</span>
            </div>
          )}
          <div className="modal-actions">
            <Button
              variant="quiet"
              onClick={() => {
                playSfx("ui_click");
                setComposer(null);
              }}
            >
              {BUTTONS.cancel}
            </Button>
            <Button
              variant="primary"
              onClick={sealProposal}
              disabled={pendingAction}
              disabledReason={actReason}
            >
              {BUTTONS.setTheSeal}
            </Button>
          </div>
        </section>
      )}

      {/* ZONE 3 · Beneath the Yoke — the minors. */}
      <h3 className="dip-section-title">Beneath the Yoke</h3>
      {gameState.minors.map((minor) => {
        const marriage = marriageBribes.has(minor.id);
        const bribe = bribeFor(minor, marriage);
        const isMine = minor.vassalOf === myPlayerId;
        const overlord =
          minor.vassalOf !== null
            ? gameState.players.find((p) => p.id === minor.vassalOf) ?? null
            : null;
        const cooldown = minor.roundsUntilLevy ?? minor.levyCooldown ?? 0;
        const levySize =
          VASSAL.levyBase +
          VASSAL.levyPerTier * Math.floor(minor.garrison / VASSAL.garrisonTierDivisor);
        const shortGold = (my?.treasury.gold ?? 0) < bribe;
        return (
          <div key={minor.id} className="dip-vassal-row">
            <div>
              <span className="dip-vassal-name">{minor.name}</span>
              {isMine ? (
                <span className="pill pill--laurel">Kneels to your crown</span>
              ) : overlord ? (
                <span className="pill">
                  Kneels to {overlord.faction ? FACTION_NAME[overlord.faction] : overlord.name}
                </span>
              ) : (
                <IconChip icon="army" label="Garrison" value={minor.garrison} />
              )}
              <p className="rubric" style={{ margin: "2px 0 0" }}>
                {minorPlace(minor)}
              </p>
              {isMine && (
                <dl className="dip-vassal-obligations">
                  <dt>Owes</dt>
                  <dd>Half its province yields, rendered at each Income.</dd>
                  <dt>Lends</dt>
                  <dd>
                    {numberWordCap(levySize)} levies, whenever you call the muster — once in
                    two rounds.
                  </dd>
                  <dt>Yields</dt>
                  <dd>One Prestige to your name each round.</dd>
                </dl>
              )}
              {!isMine && !overlord && (
                <>
                  <label className="dip-marriage-toggle">
                    <input
                      type="checkbox"
                      checked={marriage}
                      onChange={() => toggleMarriage(minor.id)}
                    />
                    <span>
                      Sweeten the suit with a royal marriage — {numberWord(VASSAL.marriageBribeGold)}{" "}
                      Gold more, and the die leans your way.
                    </span>
                  </label>
                  <p className="dip-odds-line">{oddsLine(minor, marriage)}</p>
                </>
              )}
            </div>
            <div className="dip-vassal-actions">
              {isMine && (
                <Button
                  variant="primary"
                  onClick={() => callLevy(minor)}
                  disabled={pendingAction}
                  disabledReason={
                    actReason ??
                    (cooldown > 0
                      ? cooldown === 1
                        ? "One round until the muster may be called."
                        : `${numberWordCap(cooldown)} rounds until the muster may be called.`
                      : undefined)
                  }
                >
                  Call the Muster
                </Button>
              )}
              {!isMine && !overlord && (
                <>
                  <IconChip
                    icon="gold"
                    label="Bribe"
                    value={bribe}
                    short={shortGold}
                    shortReason="Not enough gold in the treasury."
                  />
                  <Button
                    onClick={() => {
                      playSfx("ui_click");
                      setConfirm({ kind: "vassalize", minor, marriage });
                    }}
                    disabledReason={
                      actReason ??
                      (shortGold ? "Not enough gold in the treasury." : undefined)
                    }
                  >
                    Demand Submission
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}

      {/* ZONE 5 · The scribes' caution — always present on this screen. */}
      <aside className="dip-caution" role="note" aria-label="The cost of breaking a truce">
        <div>
          <span className="dip-caution-kicker">The Scribes&rsquo; Caution</span>
          <p>
            Break a sealed truce and the chronicle is unsparing: two Prestige struck from your
            name, and no envoy of yours received at any court for a round thereafter. The
            scribes forget nothing.
          </p>
        </div>
      </aside>

      <div className="modal-actions">
        <Button
          variant="quiet"
          onClick={() => {
            playSfx("page_turn");
            onClose();
          }}
        >
          {BUTTONS.close}
        </Button>
      </div>

      {/* ---- confirms -------------------------------------------------------- */}
      {confirm?.kind === "break" && (
        <ConfirmModal
          title="Break Faith"
          consequence={breakConsequence(confirm.treaty.type)}
          confirmLabel="Break Faith"
          onConfirm={() => sealBreak(confirm.treaty, confirm.otherId)}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "vassalize" && (
        <ConfirmModal
          title="Demand Submission"
          consequence={`The bribe of ${numberWord(bribeFor(confirm.minor, confirm.marriage))} Gold is paid at once. ${oddsLine(
            confirm.minor,
            confirm.marriage,
          )} If the suit fails, half the bribe returns; the rest is spent.`}
          confirmLabel={BUTTONS.confirm}
          onConfirm={() => sealVassalize(confirm.minor, confirm.marriage)}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "war" && (
        <Modal title="Take the Field" onClose={() => setConfirm(null)}>
          <p>
            You would declare war upon{" "}
            {confirm.rival.faction ? FACTION_NAME[confirm.rival.faction] : confirm.rival.name}.
            Name the cause, that the scribes may weigh it.
          </p>
          <div className="dip-composer-row" role="radiogroup" aria-label="The cause of war">
            {JUSTIFICATIONS.map((j) => (
              <Button
                key={j.key}
                selected={justification === j.key}
                onClick={() => {
                  playSfx("ui_click");
                  setJustification(j.key);
                }}
                title={j.gloss}
              >
                {j.label}
              </Button>
            ))}
          </div>
          {justificationHolds(justification) ? (
            <p className="rubric">
              A war with cause costs no Prestige. The scribes will note the{" "}
              {JUSTIFICATIONS.find((j) => j.key === justification)?.label.toLowerCase()}.
            </p>
          ) : (
            <p className="dip-warning-line">
              The scribes will call this war unjustified:{" "}
              {numberWord(UNJUSTIFIED_WAR_PRESTIGE)} Prestige struck from your name.
            </p>
          )}
          <div className="modal-actions">
            <Button variant="quiet" onClick={() => setConfirm(null)}>
              {BUTTONS.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => sealWar(confirm.rival)}
              disabled={pendingAction}
            >
              Take the Field
            </Button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
