/**
 * The full {@link GameAction} discriminated union: every player-issued command
 * the pure reducer (`server/src/engine/actions.ts::applyAction`) accepts.
 *
 * Every variant carries `type` (the discriminant) and `player` (the issuing
 * player id). Payloads are fully specified — there are no placeholder fields.
 */
import type {
  BuildingType,
  Faction,
  GreatWorkType,
  ResourceBundle,
  SpyMission,
  TacticCardId,
  TaxPosture,
  TreatyType,
  UnitType,
} from "./gameState.js";

/** A batch of generic units, keyed by {@link UnitType}. */
export type UnitCounts = Partial<Record<UnitType, number>>;

/** A named unique-unit request in a recruit order. */
export interface RecruitVariant {
  base: UnitType;
  /** Key into balance.UNIQUE_UNIT_OVERRIDES. */
  variant: string;
  count: number;
}

/** Raise units (and/or unique variants) in one owned province. */
export interface RecruitAction {
  type: "RECRUIT";
  player: string;
  provinceId: string;
  units: UnitCounts;
  /** Named unique units to raise (validated against faction + province). */
  variants?: RecruitVariant[];
  /** Hire as mercenaries (×1.5 gold, 0 grain, ×2 upkeep, desert first). */
  mercenary?: boolean;
}

/** Move one army or fleet one step; entering a defended tile declares battle. */
export interface MoveAction {
  type: "MOVE";
  player: string;
  /** Army id (land) or fleet id (naval) being moved. */
  stackId: string;
  /** Destination province id or sea-zone id. */
  toId: string;
  /** True when moving a fleet through sea zones. */
  naval?: boolean;
  /** Fleet id transporting this army across a sea zone (amphibious). */
  transportFleetId?: string;
  /** Begin a siege of the destination instead of an open assault. */
  declareSiege?: boolean;
}

/** Construct a building or invest a round into a great work in a province. */
export interface BuildAction {
  type: "BUILD";
  player: string;
  provinceId: string;
  /** Exactly one of `building` / `greatWork` must be set. */
  building?: BuildingType;
  greatWork?: GreatWorkType;
}

/** Convert resources at the market, or establish/reassign a trade route. */
export interface TradeAction {
  type: "TRADE";
  player: string;
  trade:
    | {
        kind: "CONVERT";
        /** Resources spent. */
        give: Partial<ResourceBundle>;
        /** Resources requested (validated against the applicable ratio). */
        get: Partial<ResourceBundle>;
      }
    | {
        kind: "ROUTE";
        /** Owned port province at each end of the route. */
        fromProvinceId: string;
        toProvinceId: string;
        /** Ordered sea-zone ids the route traverses. */
        seaZonePath: string[];
      };
}

/** Propose, accept or renounce a treaty (or set up tribute/marriage terms). */
export interface DiplomacyAction {
  type: "DIPLOMACY";
  player: string;
  diplomacy: {
    kind: "PROPOSE" | "ACCEPT" | "RENOUNCE";
    treatyType: TreatyType;
    /** The other party (for PROPOSE) / initiator (for ACCEPT). */
    targetPlayerId: string;
    /** Existing treaty id, for ACCEPT / RENOUNCE. */
    treatyId?: string;
    /** For a TRIBUTE treaty: the per-Income bundle owed. */
    tribute?: Partial<ResourceBundle>;
    /** Optional explicit expiry round (else the treaty's default term). */
    expiresRound?: number;
  };
}

/** Attempt to vassalise an NPC minor (pay bribe, then roll). */
export interface VassalizeAction {
  type: "VASSALIZE";
  player: string;
  minorId: string;
  /** Pay the +4 gold royal-marriage bribe for +1 to the roll. */
  marriageBribe?: boolean;
}

/** Play a held/political card from hand. */
export interface PlayCardAction {
  type: "PLAY_CARD";
  player: string;
  cardId: string;
  targetProvinceId?: string;
  targetPlayerId?: string;
  /** Free-form choice key for cards offering a decision (e.g. "ACCEPT"/"REFUSE"). */
  choice?: string;
}

/** Run a spy mission (1 action + 3 gold, one mission, success roll). */
export interface SpyAction {
  type: "SPY";
  player: string;
  mission: SpyMission;
  targetPlayerId?: string;
  targetProvinceId?: string;
}

/** Place or raise a bid on a mercenary company in the round's market. */
export interface MercBidAction {
  type: "MERC_BID";
  player: string;
  companyId: string;
  /** Whole-gold bid; must exceed the current high bid by ≥1. */
  bid: number;
  /**
   * DA-3 (§6.3 step 2, CANON CLARIFICATION 3) — voluntary pass. When true the
   * player withdraws from this offer's round-robin (recorded in
   * `MercCompanyOffer.passedPlayerIds`) and `bid` is ignored; the auction closes
   * when only one non-passed bidder remains. The mercenaries + actions agents
   * implement the round-robin + pass handling.
   */
  pass?: boolean;
}

/** Set the taxation posture for the upcoming Income phase. */
export interface SetTaxAction {
  type: "SET_TAX";
  player: string;
  posture: TaxPosture;
}

/** Voluntarily forfeit the remaining action(s) this turn. */
export interface PassAction {
  type: "PASS";
  player: string;
}

/**
 * Play a tactic card (§7.7) into a battle already on `state.pendingBattles`. Free
 * (not action-budgeted); any printed resource cost is still paid. At most one per
 * side per battle round is enforced by the tactic subsystem.
 */
export interface PlayTacticAction {
  type: "PLAY_TACTIC";
  player: string;
  /** Id of the {@link PendingBattle} this card is played into. */
  battleId: string;
  /** The tactic card being played (namespaced tactic keyspace). */
  cardId: TacticCardId;
}

/** Declare war on a rival faction (opens a casus belli / {@link WarState}; §11). */
export interface DeclareWarAction {
  type: "DECLARE_WAR";
  player: string;
  /** The faction being declared upon. */
  target: Faction;
  /**
   * The casus belli this declaration rests on (delta 5, §11 "Casus belli"). A
   * valid justification — a broken-marriage/seized-key-city `claim`, a `crusade`,
   * defence of a `vassal`, or answering an `ally-call` — lets the aggressor attack
   * "without the usual prestige cost". ABSENT (or an invalid/none justification)
   * means the war is UNJUSTIFIED and costs `balance.UNJUSTIFIED_WAR_PRESTIGE`
   * prestige. Consumed by actions.ts (validate the claim) + diplomacy.ts (apply
   * the unjustified-war prestige penalty / grant the casus-belli bonus).
   */
  justification?: "claim" | "crusade" | "vassal-defense" | "ally-call";
}

/** Call up a vassal minor's levy (§11.5), subject to its levy cooldown. */
export interface LevyCallAction {
  type: "LEVY_CALL";
  player: string;
  /** The vassalised NPC minor answering the call. */
  minorId: string;
}

/** Advance the phase / turn state machine (engine- or host-driven). */
export interface AdvancePhaseAction {
  type: "ADVANCE_PHASE";
  /** Issuing player id, if player-driven. */
  player?: string;
}

/** The complete set of commands the reducer accepts. */
export type GameAction =
  | RecruitAction
  | MoveAction
  | BuildAction
  | TradeAction
  | DiplomacyAction
  | VassalizeAction
  | PlayCardAction
  | PlayTacticAction
  | DeclareWarAction
  | LevyCallAction
  | SpyAction
  | MercBidAction
  | SetTaxAction
  | PassAction
  | AdvancePhaseAction;

/** Discriminant literal of every {@link GameAction}. */
export type GameActionType = GameAction["type"];
