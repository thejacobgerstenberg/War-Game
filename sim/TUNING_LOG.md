# TUNING_LOG — IMPERIUM balance sim

Append-only. Each entry: changes (old -> new), resulting full-scale metrics,
verdict. Fullgame = 1000 games seed 14530000 unless noted.

---

## Round 1 (2026-07-11) — lead balance tuner, first tuning pass

Baseline (commit a21058b, threshold 50): byzantium 90.5% / ottomans 9.4% /
venice 0% / genoa 0% / hungary 0.1%; median end round 10; 90.5%
threshold-decided; sudden death 9.5%. Root causes diagnosed: Byzantium idle
prestige fountain (3 starting key cities + cple extra + route hub),
trade republics structurally unable to cross 50 before Byzantium, Hungary no
trade access, Ottomans tar-pitted besieging intact Constantinople,
great works gated on marble/faith that only Byzantium produced.

Harness prep: `run/fullgame.ts` now honors `GAMES=<n>` and `SEED=<n>` env
overrides (defaults unchanged) for independent verification.

### Iteration 1
- prestige.victoryThreshold 50 -> 60; tradeRoutePerRound 0.5 -> 1.0
- walls.theodosianExtraHitpoints 4 -> 8 (Cple 16 -> 20 hp)
- NEW siege mechanic: port sea-resupply — unblockaded port garrison starves
  at 0.5x (T5 lever)
- map: trebizond byzantium -> neutral (separate Komnenos empire); faith +1
  at venice/genoa/buda/edirne (great works were Byzantine-only: nobody else
  produced faith); NEW overland trade routes buda_ragusa 3g, buda_venice 3g
  (Hungary trade access); TradeRoute.overland flag added (no port
  requirement, unblockadable)
- Result: byz 47.2 / ott 12.2 / ven 38.9 / gen 1.7 / hun 0; 28.5% of games
  end before r11 (Byz-trader runaway: cple is a 3-route hub); genoa/hungary
  dead (no marble -> no great works; ottomans have zero route candidates).
  Verdict: right direction, Byz trade hub + marble monopoly must go.

### Iteration 2
- prestige.constantinopleExtraPerRound 1 -> 0; warWon 3 -> 5
- map: marble +1 at corsica/upper_hungary/bursa (every faction can now build
  great works); route salonica_constantinople replaced by trebizond_caffa 2g
  (Genoese Black Sea; cuts the Byz hub to 2 routes)
- Result: byz 24.5 / ott 4.2 / ven 44.9 / gen 20.5 / hun 5.9; trader 52.3%;
  94.9% threshold-decided, huge r12 spike. Verdict: 3-routes trade engine too
  strong and too deterministic; games end before Ottoman pressure matures.

### Iteration 3
- prestige.keyCityPerRound 1 -> 1.5; tradeRoutePerRound 1.0 -> 0.75
- Result: byz 45.4 (2 starting keys x1.5 snowball again) / ven 31.2 / gen
  16.3 / ott 6.1 / hun 1.0. Verdict: any flat per-round boost feeds Byzantium
  first; must cut a Byzantium-specific channel.

### Iteration 4
- map: constantinople_caffa route removed (Byz hub -> 1 route); NEW overland
  route bursa_ankara 3g (Ottoman Silk Road terminus — Ottomans previously
  had NO route candidates)
- prestige.victoryThreshold 60 -> 70
- Result: byz 44.9 / ott 13.3 / ven 27.7 / gen 11.2 / hun 2.9; median 14;
  SD 13.4%. Verdict: pacing bands hit; Byzantium keys engine still too big.

### Iteration 5
- map: salonica byzantium -> neutral key city (historically contested;
  Ottoman 1430); its professional moved into the Cple garrison (2L+3P+1G).
  Byzantium is now the historical rump: cple + morea + mesembria.
- agents: do NOT invest a near-intact great fortress (wall bonus >= 3)
  without the Great Bombard — target evaluation now respects the siege
  curves (Ottoman rushers were tar-pitting 12+ units for 10 rounds under
  intact Theodosian walls).
- Result: byz 14.0 / ott 15.8 / ven 39.4 / gen 12.5 / hun 18.3; threshold
  61.1% / cap 25.6% / SD 13.3%. Verdict: Venice idle engine (safe islands +
  5 route candidates + marble + faith) too strong; rusher 0.6%.

### Iteration 6
- map: venice marble 1 -> 0 (kills its great-work spam)
- NEW prestige channel: keyCityCapture 3 (one-off sack bonus)
- Result: all factions in band (25.1/16.4/26.1/13.6/18.8) but threshold
  share 32.5% (<35) and rusher 0.7%. Diagnosis: Ottoman-rusher collapses
  economically (units 15->1, grain 0) and is farmed by the always-paired
  Byz-opportunist; generic port resupply made every neutral port key city
  starvation-proof for land rushers.

### Iteration 7
- siege: port resupply scoped to Constantinople only
  (cpleSeaResupplyAttritionMult 0.5 — the Golden Horn)
- agents: rusher garrisons threatened core provinces (tryDefend) before
  attacking
- Result: byz 19.2 / ott 26.7 / ven 19.2 / gen 14.7 / hun 20.2; rusher 7.8%;
  SD 23.6% (over), threshold 24% (under). Verdict: sudden death too easy.

### Iteration 8
- victoryThreshold 70 -> 65; greatBombard round 9 -> 10, cost 30 -> 35;
  keyCityCapture 3 -> 4
- Result: bands: factions 19.1/22.8/19.3/18.7/20.1; threshold 44.8%;
  SD 19.2% (over); rusher 7.5%.

### Iteration 9
- greatBombard round 10 -> 11; keyCityCapture 4 -> 5; warWon 5 -> 6
- Result: SD 13.6% OK; trader 43.9% (over), rusher 7.9%.

### Iteration 10
- NEW prestige channel: provinceCapture (conquest track) 1;
  keyCityCapture 5 (then rebalanced, see it14); tradeRoutePerRound
  0.75 -> 0.6
- HARNESS FIX: fullgame policy assignment was `(i+j)%4` — only 4 fixed
  lineups ever occurred and seat-relative policy pairings were constant
  (e.g. Genoa-as-trader always faced a Venice rusher), confounding all
  per-faction policy cells. Now a seeded per-game shuffle (deterministic,
  each policy >= 1x per game, duplicate rotates).
- Result (unconfounded): byz 31.2 / ott 20.7 / ven 8.0 / gen 20.6 /
  hun 19.5; rusher 15.9 / trader 33.2 / turtler 10.6 / opportunist 20.2;
  SD 16.7%.

### Iteration 11
- byzantium capitalExtraGold 4 -> 2; venice marble restored 0 -> 1 (safe now
  that conquest competes); greatBombard cost 35 -> 40
- Result: byz 15.6 / ott 21.0 / ven 28.4 / gen 19.1 / hun 15.9; SD 17.3%.

### Iterations 12-13
- Cple garrison 2L+3P+1G -> 2L+4P+2G overshot (SD 7.3%, ottomans 10.6);
  settled at 2L+4P+1G -> SD 11.0%, but rusher 7.4%.

### Iteration 14
- provinceCapture 1 -> 2, keyCityCapture 5 -> 4 (weight conquest track
  toward ordinary provinces: rushers take many, opportunists only snipe keys)
- Result: all factions in band; rusher 8.0%; SD 10.8%.

### Iteration 15
- agents: rusher opens trade routes with idle actions (sea-faction rushers
  had literally nothing to do with spare actions); greatBombard cost back
  40 -> 35 (later re-raised, see it17)
- Result: ALL bands green: factions 20.2/14.1/28.4/16.1/21.2; policies
  17.1/31.5/14.7/16.6; SD 11.6%; threshold 70.1%.

### Iteration 16 — threshold + pacing recalibration
- victoryThreshold 65 -> 70 (threshold-decided 70.1% was at the T3 edge;
  70 centers it at ~50%)
- pacing.ts model: conquest one-offs (provinceCapture/keyCityCapture) added
  to the trajectory model; archetype conquest/raid parameters recalibrated
  toward observed engine behavior (the old hand-authored rates over-predicted
  accrual by 25%+); sweep range extended to 85.
- Note: even recalibrated, the abstraction still runs hotter than the engine
  (it cannot model inter-player suppression); its all-criteria window is
  73-82 vs. the engine-true 70. Fullgame is ground truth for T3.

### Iteration 17 — economy repair + final SD trim
- map: cple grain 1 -> 2, morea grain 2 -> 3, mesembria grain 2 -> 3
  (rump Byzantium was grain-capped at 5 income vs 8 upkeep — economy sim
  rush archetype could never field a strike force; T6 failed)
- greatBombard availableFromRound 11 -> 12, cost 40 (SD was 15.4-15.5%,
  0.5 over band; round-12 Bombard ≈ year 1449 also reads well historically)
- FINAL full-scale result (fullgame 1000 games):
  - factions: byz 14.5 / ott 15.4 / ven 29.4 / gen 19.3 / hun 21.4  [T1 ✓]
  - policies: rusher 21.5 / trader 36.3 / turtler 11.6 / opport. 10.6 [T2 ✓]
  - median end round 16; 3.7% end before r11; 94.4% end in r12-16;
    threshold-decided 50.5% [T3 ✓]
  - sudden death 12.9% [T4 ✓]
  - siege: Cple no-Bombard P(capture<=6 siege rounds) worst 0.3% (<15%);
    with Bombard P(capture<=4) 66.6-90.1% (>50%), captures land in siege
    rounds 3-4 [T5 ✓]
  - economy baseline: all 5 factions x 3 archetypes solvent through r16,
    rush strike power at r5 = 10-17.6 (>=8) [T6 ✓]

### Final CONFIG deltas vs a21058b (summary)
| knob | old | new |
|---|---|---|
| prestige.victoryThreshold | 50 | 70 |
| prestige.keyCityPerRound | 1 | 1.5 |
| prestige.constantinopleExtraPerRound | 1 | 0 |
| prestige.tradeRoutePerRound | 0.5 | 0.6 |
| prestige.provinceCapture | — | 2 (new) |
| prestige.keyCityCapture | — | 4 (new) |
| prestige.warWon | 3 | 6 |
| walls.theodosianExtraHitpoints | 4 | 8 |
| siege.cpleSeaResupplyAttritionMult | — | 0.5 (new) |
| siege.greatBombard | r9 / 30g | r12 / 40g |
| factions.byzantium.capitalExtraGold | 4 | 2 |

Map deltas: salonica + trebizond -> neutral key cities; Byz garrisons
consolidated (cple 2L+4P+1G); Byz core grain +3 (cple 2, morea 3,
mesembria 3); faith +1 at venice/genoa/buda/edirne; marble +1 at
corsica/upper_hungary/bursa; venice marble kept at 1; routes: -
salonica_constantinople, - constantinople_caffa, + trebizond_caffa (2g),
+ buda_ragusa (3g, overland), + buda_venice (3g, overland),
+ bursa_ankara (3g, overland).

Mechanics added (documented in RULES_MODEL.md): overland caravan routes,
Constantinople sea resupply, conquest track (+2/province, +4 key-city sack),
tactic-card one-per-battle guardrail (rules text), agent fortress-avoidance.

### Known remaining issues (round 1 exit)
- Turtler 11.6% and opportunist 10.6% sit near the 10% floor of T2.
- Venice 29.4% is near the 30% ceiling of T1 (venice-trader is the single
  strongest faction-policy niche at 65%).
- Secret objectives complete ~0% of games; the +6 award is dead rules
  weight. Needs redesign (e.g. easier objectives or a longer deadline), not
  numbers.
- The pacing abstraction (results/pacing.json) recommends threshold 73-82;
  it over-predicts accrual relative to the real engine even after
  recalibration. Treat fullgame.json as ground truth for pacing.
- Tactic cards remain a ±29-percentage-point swing at 6v4 per the combat MC;
  the one-card-per-battle cap must go into the physical rules.
- Sea-faction rushers (Venice 17%, Genoa 8% as rusher) are viable but weak;
  amphibious AI is basic.

---

## Round 91 (2026-07-11) — seed-robustness repair: Venice over the T1 ceiling

Trigger: independent 5000-game fresh-seed rerun (seed 987654321) of the
round-1 config measured venice 32.4% (>30% T1 ceiling, ~3.6 SE over), driven
by the venice-trader (70%) and venice-turtler (40%) cells. The tuner's
1000-game 29.4% had understated it. Mandate: fix those two cells with minimal
changes; verify at GAMES=3000 SEED=555444333.

Reproduced at the verification seed (3000 games): venice 31.9%,
venice-trader 65%, venice-turtler 43%. Ledger diagnostic on winning cells:
venice-trader = keyCities 24 + routes 28.7 + greatWorks 18.9 (~72.6 total),
venice-turtler the same engine minus a work (68.9, wins cap races) — a
zero-risk idle engine: 5 route candidates, safest home region, and home-island
marble+faith feeding great works. Gold is NOT the binding constraint (income
nerfs do ~nothing); marble income is.

### Iteration 1 — venice marble -> neutral Friuli (REVERTED)
- map: venice marble 1 -> 0, friuli 0 -> 1
- Result: venice 13.7% (engine amputated: agents rarely take Friuli),
  hungary 32.8% over ceiling, turtler policy 8.1%. Overshoot ~-18pp; also
  exposed that venice-turtler anchors 70% of ALL turtler wins — any venice
  fix must raise the other turtlers.

### Iteration 2 — venice marble -> Venetian Zara (KEPT)
- map: venice marble 1 -> 0, zara 0 -> 1 (Istrian stone via Dalmatia; the
  engine works from round 1 but its source is a contestable mainland border
  province instead of the lagoon)
- Result: venice 25.1%, venice-trader 50%, venice-turtler 31%; all factions
  in band; turtler 10.4 / opportunist 10.4 right at the floor; default-seed
  check showed turtler 9.3% — below floor, must be lifted.

### Iteration 3-4 — wallUpgrade marble cost (turtler floor)
- Diagnostic: genoa-turtler built 0 great works — wall upgrades were eating
  its marble 2 at a time before a work's 4 could accumulate (plus war-defense
  gold drain). wallUpgrade marbleCost 2 -> 0 flipped turtler to 20-22% and
  genoa to 31.9% (genoa-turtler 51-54%): overshoot. Settled at
  **marbleCost 2 -> 1** (goldCost stays 10): turtler 10.9-12.9 across seeds,
  genoa 23-25.
### Iteration 5 — keyCityCapture 4 -> 5
- Nudge for the floor-hugging opportunist (key-city snipes are its niche);
  side effect: trims venice share a bit more. Opportunist +0.3-0.6pp,
  byzantium +1pp (byz-rusher reconquests), venice -0.5pp.

### Iteration 6-7 — ottoman floor nudge
- ottomans capitalExtraGold 0 -> 2 lifted them +1pp everywhere but broke the
  economy module's balancedMid snapshot criterion (ottoman rushNet16 jumped
  2.3 -> 21.6 from a recruit-threshold discontinuity; even +1 gold flips it).
  REVERTED to 0. Kept instead: map bursa_ankara route income 3 -> 4 (Silk
  Road terminus; feeds ottoman-trader, leaves the rush snapshot alone).
  Economy baseline pass restored.

### Final CONFIG/map deltas this round
| knob | old | new |
|---|---|---|
| map venice marble | 1 | 0 |
| map zara marble | 0 | 1 |
| buildings.wallUpgrade.marbleCost | 2 | 1 |
| prestige.keyCityCapture | 4 | 5 |
| map bursa_ankara route income | 3 | 4 |

### Final full-scale results (all five sims rerun at this config)
- fullgame (1000 games, seed 14530000): byz 16.8 / ott 14.9 / ven 19.7 /
  gen 24.7 / hun 23.9 [T1 OK]; rusher 23.3 / trader 34.0 / turtler 10.9 /
  opportunist 11.8 [T2 OK]; median end round 16, 3.6% before r11, 94.5% in
  r12-16, threshold-decided 45.4% [T3 OK]; sudden death 13.0% [T4 OK].
- verification run (3000 games, SEED=555444333): byz 17.1 / ott 13.0 /
  ven 22.8 / gen 23.7 / hun 23.4; policies 23.6 / 33.8 / 12.5 / 10.2;
  venice-trader 47% (was 65-70%), venice-turtler 29% (was 40-43%).
- third-seed stress (3000 games, SEED=424242): venice 24.6, all factions in
  band except ottomans 11.0 (-1.0pp under floor at this seed; 13.0-14.9 at
  the other two); opportunist 9.6 there (10.2-11.8 elsewhere).
- siege: no-Bombard P(capture<=6) worst 0.3% (<15%); Bombard P(<=4)
  66.6-90.1% (>50%), E[rounds] ~3.1 [T5 OK — unchanged, walls untouched].
- economy: all 5 factions x 3 archetypes solvent, rush strike r5 10-17.6,
  baseline pass true [T6 OK].

### Known remaining issues (round 91 exit)
- Opportunist (9.6-11.8%) and turtler (10.9-12.9%) still hug the 10% floor;
  ottomans dip to ~11% on some seeds. All within ~1-1.5pp of band on the
  worst seed observed; stop-rule applied.
- genoa-trader is now the strongest cell (~65%); genoa total stays in band
  only because its other cells are weak.
- Secret objectives still complete ~0% of games (needs a rules redesign,
  not numbers).
- Pacing abstraction still recommends threshold 74-84; it over-predicts
  accrual vs the engine. Fullgame remains ground truth for T3.
- Tactic cards remain a ±29pp swing at 6v4; the one-card-per-battle cap
  must appear in the physical rules (carried from round 1).
