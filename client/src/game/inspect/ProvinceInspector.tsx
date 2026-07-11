/**
 * ProvinceInspector — game.html callouts 9–10: the province card in the
 * right rail. Name, owner crest + "Under the banner of …", seasonal yields
 * (ALL five stores, icon + word + count, even at nought), works and walls
 * ("Walls II · Harbor" style), garrison and hosts present, siege/blockade
 * state, an adjacency list (click a neighbor to navigate there), and at most
 * TWO contextual orders chosen by game state (primary + secondary; disabled
 * orders keep their place with an in-voice reason).
 *
 * Data: useSelection().selection -> useGame().gameState via selectors.
 * Orders: useSelection().setArmedOrder (Muster/March flow through the
 * ActionBar trays) and useOverlay().open({type:"build", provinceId}).
 *
 * GOTCHA (HANDOFF §3.1): the vendored board.svg still carries retired region
 * ids, so a real click can select an id unknown to GameState — every lookup
 * here null-checks and falls back to the "The Realm" empty card.
 */
import { BuildingType, GamePhase, TerrainType } from "@imperium/shared";
import type { Army, Fleet } from "@imperium/shared";
import { useGame } from "../GameProvider";
import { useSelection } from "../SelectionContext";
import { useOverlay } from "../OverlayManager";
import { useAudio } from "../../audio/AudioProvider";
import { Button, IconChip, Panel, CREST_URL, ICON_URL, toRoman } from "../../ui";
import { FACTION_SLUG } from "../../board/types";
import {
  BOARD_MAP,
  armiesAt,
  factionOf,
  fleetsAt,
  myBudgetRemaining,
  myStacks,
  neighborsOf,
  provinceById,
  seaZoneById,
  unitCount,
} from "../selectors";
import { ACTION_ERROR_COPY, CONNECTION, FACTION_NAME, PHASE_BANNER } from "../uiText";
import {
  BUILDING_NAME,
  GREAT_WORK,
  MAX_WALL_TIER,
  RESOURCE_KEYS,
  RESOURCE_LABEL,
  WALL_TIER_STATS,
} from "../actions/costs";
import "./inspector.css";

/** Terrain display names (shared TerrainType, title-cased). */
const TERRAIN_LABEL: Record<TerrainType, string> = {
  [TerrainType.PLAINS]: "Plains",
  [TerrainType.HILLS]: "Hills",
  [TerrainType.MOUNTAINS]: "Mountains",
  [TerrainType.FOREST]: "Forest",
  [TerrainType.COAST]: "Coast",
  [TerrainType.CITY]: "City",
  [TerrainType.DESERT]: "Desert",
};

const CHOOSE_PROMPT = "Choose a province upon the map.";

export interface ProvinceInspectorProps {
  className?: string;
}

export function ProvinceInspector({ className }: ProvinceInspectorProps): JSX.Element {
  const { gameState, myPlayerId } = useGame();
  const { selection, setSelection, setArmedOrder } = useSelection();
  const overlay = useOverlay();
  const { playSfx } = useAudio();

  const province = selection !== null ? provinceById(gameState, selection) : null;
  const sea = selection !== null && !province ? seaZoneById(gameState, selection) : null;

  // Retired-board-id fallback: name from the canon map dataset if we can.
  const boardName =
    selection !== null
      ? (BOARD_MAP.provinces.find((p) => p.id === selection)?.name ??
        BOARD_MAP.seaZones.find((s) => s.id === selection)?.name ??
        null)
      : null;

  const title = province?.name ?? sea?.name ?? boardName ?? "The Realm";

  // -- In-voice unavailability for the contextual orders --------------------
  const phase = gameState.phase;
  const inWindow =
    phase === GamePhase.RECRUITMENT ||
    phase === GamePhase.MOVEMENT ||
    phase === GamePhase.DIPLOMACY;
  const remaining = myBudgetRemaining(gameState, myPlayerId);
  const orderReason = !inWindow
    ? (PHASE_BANNER[phase] ?? CONNECTION.waiting)
    : remaining <= 0
      ? ACTION_ERROR_COPY.NO_ACTIONS
      : undefined;

  const nameOf = (id: string): string =>
    provinceById(gameState, id)?.name ??
    seaZoneById(gameState, id)?.name ??
    BOARD_MAP.provinces.find((p) => p.id === id)?.name ??
    BOARD_MAP.seaZones.find((s) => s.id === id)?.name ??
    id;

  /** Neighbor pills — click to navigate the selection there. */
  const adjacency = (id: string): JSX.Element | null => {
    const neighbors = neighborsOf(id);
    if (neighbors.length === 0) return null;
    return (
      <>
        <dt>Adjoining lands and waters</dt>
        <dd>
          <ul className="insp-adj">
            {neighbors.map((n) => (
              <li key={n}>
                <Button
                  variant="quiet"
                  onClick={() => {
                    playSfx("ui_click");
                    setSelection(n);
                  }}
                >
                  {nameOf(n)}
                </Button>
              </li>
            ))}
          </ul>
        </dd>
      </>
    );
  };

  /** Hosts/fleets present, one line each: crest-colored owner + strength. */
  const stacksList = (armies: Army[], fleets: Fleet[], garrison?: number): JSX.Element => {
    const strengthOf = (s: Army | Fleet): number =>
      unitCount(s.units) + (s.variants ?? []).reduce((sum, v) => sum + v.count, 0);
    const rows: JSX.Element[] = [];
    for (const a of armies) {
      const f = factionOf(gameState, a.ownerId);
      rows.push(
        <li key={a.id}>
          <span className="insp-host-icon" aria-hidden="true">
            <img src={ICON_URL.army} alt="" />
          </span>
          {f !== null ? FACTION_NAME[f] : a.ownerId} —{" "}
          <span className="insp-host-strength">{toRoman(Math.max(1, strengthOf(a)))}</span>
        </li>,
      );
    }
    for (const fl of fleets) {
      const f = factionOf(gameState, fl.ownerId);
      rows.push(
        <li key={fl.id}>
          <span className="insp-host-icon" aria-hidden="true">
            <img src={ICON_URL.fleet} alt="" />
          </span>
          {f !== null ? FACTION_NAME[f] : fl.ownerId} —{" "}
          <span className="insp-host-strength">{toRoman(Math.max(1, strengthOf(fl)))}</span>
        </li>,
      );
    }
    if (rows.length === 0 && garrison !== undefined && garrison > 0) {
      rows.push(
        <li key="garrison">
          <span className="insp-host-icon" aria-hidden="true">
            <img src={ICON_URL.army} alt="" />
          </span>
          Garrison — <span className="insp-host-strength">{toRoman(garrison)}</span>
        </li>,
      );
    }
    if (rows.length === 0) {
      return <span className="rubric">No host stands here.</span>;
    }
    return <ul className="insp-hosts">{rows}</ul>;
  };

  // ==========================================================================
  // Empty / unknown selection
  // ==========================================================================
  if (province === null && sea === null) {
    return (
      <Panel
        variant="parchment"
        title={title}
        ariaLabel="Selected province"
        className={["insp-card", className ?? ""].filter(Boolean).join(" ")}
      >
        <p className="rubric">{CHOOSE_PROMPT}</p>
      </Panel>
    );
  }

  // ==========================================================================
  // Sea-zone variant: blockade state + fleets + adjacency
  // ==========================================================================
  if (sea !== null) {
    const blockader =
      sea.blockadedBy !== undefined && sea.blockadedBy !== null
        ? factionOf(gameState, sea.blockadedBy)
        : null;
    const fleets = fleetsAt(gameState, sea.id);
    const { fleets: mine } = myStacks(gameState, myPlayerId);
    const myFleetHere = mine.some((f) => f.locationId === sea.id);

    return (
      <Panel
        variant="parchment"
        title={sea.name}
        ariaLabel="Selected sea zone"
        className={["insp-card", className ?? ""].filter(Boolean).join(" ")}
      >
        <div className="insp-owner">
          <span className="pill">
            <span className="insp-host-icon" aria-hidden="true">
              <img src={ICON_URL.fleet} alt="" />
            </span>
            Sea zone
          </span>
          {blockader !== null && (
            <span className="pill pill--crimson">
              Blockaded by {FACTION_NAME[blockader]}
            </span>
          )}
        </div>
        <dl>
          <dt>Fleets upon these waters</dt>
          <dd>{stacksList([], fleets)}</dd>
          {adjacency(sea.id)}
        </dl>
        <div className="insp-actions">
          <Button
            variant="primary"
            icon={<img src={ICON_URL.fleet} alt="" />}
            disabledReason={
              orderReason ??
              (myFleetHere ? undefined : "No host of yours stands there.")
            }
            onClick={() => {
              playSfx("ui_click");
              setArmedOrder("march");
            }}
          >
            March
          </Button>
        </div>
      </Panel>
    );
  }

  // ==========================================================================
  // Province card
  // ==========================================================================
  const prov = province!;
  const ownerFaction = prov.ownerId !== null ? factionOf(gameState, prov.ownerId) : null;
  const minor =
    prov.minorId !== undefined
      ? gameState.minors.find((m) => m.id === prov.minorId)
      : undefined;
  const mine = prov.ownerId === myPlayerId;

  const armies = armiesAt(gameState, prov.id);
  const fleets = prov.coastal ? fleetsAt(gameState, prov.id) : [];

  const siege =
    gameState.siegeStates.find((s) => s.provinceId === prov.id) ?? prov.siege;
  const besieger = siege !== undefined ? factionOf(gameState, siege.besiegerId) : null;

  // Works and walls — "Walls II · Harbor" style (mockup callout 9).
  const works: string[] = [];
  if (prov.walls.tier > 0) {
    const maxHp = WALL_TIER_STATS[prov.walls.tier]?.hp ?? prov.walls.hp;
    works.push(
      prov.walls.hp <= 0
        ? `Walls ${toRoman(prov.walls.tier)} (breached)`
        : prov.walls.hp < maxHp
          ? `Walls ${toRoman(prov.walls.tier)} (HP ${prov.walls.hp} of ${maxHp})`
          : `Walls ${toRoman(prov.walls.tier)}`,
    );
  }
  for (const b of prov.buildings) works.push(BUILDING_NAME[b]);
  for (const g of prov.greatWorks) {
    const def = GREAT_WORK[g.type];
    works.push(
      g.progress >= def.rounds
        ? def.name
        : `${def.name} (${toRoman(g.progress)} of ${toRoman(def.rounds)})`,
    );
  }

  // Contextual orders (at most two, per callout 10).
  const canRaiseLandHere =
    prov.isCapitalOf !== undefined ||
    prov.terrain === TerrainType.CITY ||
    prov.buildings.includes(BuildingType.BARRACKS);
  const { armies: myArmies, fleets: myFleets } = myStacks(gameState, myPlayerId);
  const haveAnyStack = myArmies.length > 0 || myFleets.length > 0;

  return (
    <Panel
      variant="parchment"
      title={prov.name}
      ariaLabel="Selected province"
      className={["insp-card", className ?? ""].filter(Boolean).join(" ")}
    >
      <div
        className="insp-owner"
        data-faction={ownerFaction !== null ? FACTION_SLUG[ownerFaction] : undefined}
      >
        {ownerFaction !== null && (
          <figure className="insp-crest">
            <img src={CREST_URL[ownerFaction]} alt={FACTION_NAME[ownerFaction]} />
          </figure>
        )}
        <div>
          {ownerFaction !== null ? (
            <span className="insp-owner-name">
              Under the banner of {FACTION_NAME[ownerFaction]}
            </span>
          ) : minor !== undefined ? (
            <span className="insp-owner-name">Held by {minor.name}</span>
          ) : (
            <span className="insp-owner-name rubric">Under no banner</span>
          )}
          <br />
          <span className="pill">
            {ownerFaction !== null && (
              <span
                className="faction-swatch"
                data-faction={FACTION_SLUG[ownerFaction]}
                style={{ backgroundColor: `var(--faction-${FACTION_SLUG[ownerFaction]})` }}
              />
            )}
            {TERRAIN_LABEL[prov.terrain]}
            {prov.coastal && prov.terrain !== TerrainType.COAST ? " · Coastal" : ""}
          </span>{" "}
          {prov.isCapitalOf !== undefined && (
            <span className="pill pill--gold">
              Capital of {FACTION_NAME[prov.isCapitalOf]}
            </span>
          )}
        </div>
      </div>

      {siege !== undefined && (
        <div className="insp-alert">
          <span className="pill pill--crimson">
            <span className="insp-host-icon" aria-hidden="true">
              <img src={ICON_URL.siege} alt="" />
            </span>
            Under siege{besieger !== null ? ` by ${FACTION_NAME[besieger]}` : ""}
            {siege.breached ? " — the walls are breached" : ""}
          </span>
        </div>
      )}

      <dl>
        <dt>Yields each season</dt>
        <dd>
          <div className="insp-yields">
            {RESOURCE_KEYS.map((k) => (
              <IconChip key={k} icon={k} label={RESOURCE_LABEL[k]} value={prov.yields[k]} />
            ))}
          </div>
        </dd>

        <dt>Works and walls</dt>
        <dd>{works.length > 0 ? works.join(" · ") : "—"}</dd>

        <dt>Garrison</dt>
        <dd>{stacksList(armies, fleets, prov.garrison)}</dd>

        {adjacency(prov.id)}
      </dl>

      <div className="insp-actions">
        {mine ? (
          <>
            <Button
              variant="primary"
              icon={<img src={ICON_URL.army} alt="" />}
              disabledReason={
                orderReason ??
                (canRaiseLandHere
                  ? undefined
                  : `${prov.name} cannot raise land units — a capital, a city, or a Barracks is needed.`)
              }
              onClick={() => {
                playSfx("ui_click");
                setArmedOrder("muster");
              }}
            >
              Muster a Levy
            </Button>
            <Button
              icon={<img src={ICON_URL.timber} alt="" />}
              disabledReason={orderReason}
              onClick={() => {
                playSfx("ui_click");
                setArmedOrder(null);
                overlay.open({ type: "build", provinceId: prov.id });
              }}
            >
              {prov.walls.tier < MAX_WALL_TIER ? "Strengthen the Walls" : "Lay the Foundation"}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            icon={<img src={ICON_URL.army} alt="" />}
            disabledReason={
              orderReason ??
              (haveAnyStack ? undefined : "The muster fields are empty — no levies to raise.")
            }
            onClick={() => {
              playSfx("ui_click");
              setArmedOrder("march");
            }}
          >
            March
          </Button>
        )}
      </div>
    </Panel>
  );
}
