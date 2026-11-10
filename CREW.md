# Crew and decision-system preparation

Twelve named sailors are implemented: six women and six men. Captain orders
create executable sail-handling and hatch jobs. Fore/main work assembles an aloft
hand and a deck hand; only their attendance allows actual canvas to change.
A lookout climbs a foremast runner during watch. Job phases are approach,
ascending, working, descending and return. Routes are authored; role allocation
reserves distinct runners, and moving sailors get past each other as described under Getting past each other.

`js/rigging.js` supplies the mesh, runner path and grip positions. Two-bone IK
places alternating hands and simplified boot locks against the actual ropes.
Climbers use the taut runner opposite the yard and stop below the mast heads.
The **Transfer yards** captain order recalls climbers before easing runners.
Routine tacks retain the yard side and do not interrupt their work. Three deck hands attend the tackle while
all canvas gathers and the yards transfer individually; revised captain orders
determine how much canvas is set afterward. There are no ratline ladders or mast baskets
in the selected Martínez-Hidalgo reconstruction.
Automatic sheet trim is not yet a distinct crew animation/job. Helm input does
not command sail backing; explicit crew-operated backing is not implemented.
The carpenter closes a hinged hatch over eight seconds. Hands haul actual tackle
leads; the helmsman follows the player-controlled tiller beneath the quarterdeck. Crew near the helm
camera fade, while their shadows and exterior appearance remain.

`createCompany(policy)` accepts a local synchronous policy. Observations include
identity, role, captain order/revision, wind, roll/rate, hazard, job and stage.
The current executable return values are `work`, `standby` and `brace` during jobs,
and `patrol`, `standby`, `brace` on watch. Decisions run at 2 Hz with immediate
hazard interruption. The executor owns motion and work; policy failure falls back
locally. The broader asynchronous contract below remains a proposal.

Hidden crew continue working. Changed sail requests replace targets without
teleporting workers or resurrecting old commands. Dangerous wind/roll pauses work
and retains aloft grips. General navigation/reservations, fatigue, anchor handling,
yard crawling, cannon operation and autonomous steering remain future work.

The prepared male and female GLBs use modestly slimmer bodies and clothing,
with unchanged skeletons, heights and animation clips. See `assets/crew/README.md`
for the reproducible preparation and provenance. Each named sailor has an authored
appearance: the company includes Black, white and East Asian appearances and two
redheads, independently of roles or skills. Skin and hair palettes are converted
from sRGB to linear light; subtle head, jaw, nose and eye morphs run before skinning
in both colour and shadow passes. Twelve people still share two mesh/animation
assets and two instanced draws per pass. This is deliberate contemporary casting,
not a claim about historical demographics.

## Complement

The current complement is 12 visible people, including the captain: captain,
mate, boatswain and nine hands. Six are women and six are men; roles are unrelated
to gender. Individual skills and two six-person duty watches remain future work.
This is a lean gameplay complement for our default 20 m × 6 m vessel,
not a documented historical minimum or a validated manning requirement.
Adult body heights remain 1.71–1.80 m. Stations and deck elevations follow the
enlarged hull, walking speed stays in metres per second, and the helmsman follows
the tiller's end from just aft of it and to port of the bar, facing forward and turned
a little in toward it. A slight stoop lets both hands reach the waist-height arm.
The player camera remains above on the quarterdeck.

The [Museum of Angra do Heroísmo](https://museu-angra.cultura.azores.gov.pt/en/others/historical-pieces/caravela/)
describes 20–30 m caravels, with smaller examples carrying 25–30 people. The
[Niña replica operator](https://www.ninapinta.net/) reports an ocean voyage of
over 4,000 miles with 11 sailors in 1991–92. A modern replica voyage establishes
feasibility under those conditions, not a minimum for period equipment or storms.

All 12 are presently visible; the display switch does not pause their state.
Future watch rotation can reduce visible population while retaining off-watch
identity, fatigue and tasks below deck. Never complete physical work merely
because its workers are off camera. Configurable complements, including a
historically fuller 25–30-person option, remain future work.

## Responsibilities

1. **Captain's orders** set objectives, priorities and permissions: desired sail
   area, heading, watch rotation, all hands, or an emergency response.
2. **Task director** turns objectives into work with prerequisites, locations,
   required skills, worker counts and station capacity.
3. **Each sailor's decision policy** chooses among eligible tasks using orders,
   observed conditions, fatigue, skills and current commitments.
4. **Executor** reserves resources, follows routes and performs work. Only this
   layer changes task progress and actual rig state.
5. **Animation** represents execution: walking, climbing, bracing, hauling and
   resting. Rendering never decides task completion.

Use a local deterministic policy first. Keep the policy replaceable so utility
scoring, behaviour trees or a later decision engine can use the same contract.
No remote service, credentials or non-local project storage is required.

## Proposed policy contract

Plain serializable data; no GPU handles, mutable boat references or animation
objects cross the boundary. Units are metres, seconds, radians and m/s. Locations
use ship-local coordinates (+X starboard, +Y up, +Z aft).

```js
// Interface sketch, not an implemented export.
engine.decide({
  version: 1, requestId, worldRevision, orderRevision, simTime, seed,
  sailor: { id, skills, fatigue, watch, location, taskId },
  orders: [{ id, revision, objective, target, priority, expiresAt }],
  conditions: {
    apparentWind, heel, rollRate, pitch, deckHazards, sailLoads
  },
  candidates: [{ taskId, revision, action, stationId, urgency,
    estimatedTravelTime, estimatedWorkTime, requiredSkills, risks }]
});
// Returns a value or Promise of:
({ requestId, worldRevision, orderRevision, sailorId,
   choice: 'take-task', taskId, taskRevision, reasonCode });
// Other choices: continue, wait, brace, request-help, rest.
```

The director supplies feasible candidates, not a list of every conceivable
action. A policy selects intent; it cannot teleport a sailor, change wind or
write sail fractions. Conditions reflect available observations. In particular,
deck-wash depth is currently a GPU field: use an explicitly marked conservative
estimate until a small delayed readback exists, not an invented CPU measurement.

Initially evaluate decisions at 2 Hz per sailor, staggered, plus urgent events;
navigation, work and animation update independently. This rate is a starting
budget, not a measured device limit. Log chosen task and reason locally for
inspection; deterministic ordering and seeded ties support replay.

For asynchronous policies, allow one outstanding request per sailor. Apply
results only after checking request identity, current orders, task revision,
availability and current hazards. Reject expired/replaced requests; cancel on
reset. On timeout or failure use the local policy. Never block the render loop.

## Coordination and interruption

- Task states: queued → reserved → travelling → working → complete; also blocked
  and cancelled. Reserve stations and narrow route segments atomically. For
  multi-person work, assemble the required team before advancing progress.
- Reservations expire or release on cancellation, reset and route failure.
  Acquire shared resources in a stable order; avoid holding one while waiting
  indefinitely for another. Yield on climbing routes at authored passing/waiting nodes.
- Recheck hazards during travel and work. Urgent bracing can interrupt ordinary
  orders. A climber stops at a secure grip or platform, never switches directly
  into a deck-walking animation. Resume or replan after the hazard passes.
- Task commitment and switching penalties prevent constant indecision. Fatigue
  affects work, climbing and watch relief; rest must consume simulation time.

## Integration seams

- `js/hull.js` is the source for decks and helm anchors. Author routes around
  stairs, cabin, masts and railings in ship space. The helmsman's main-deck floor
  uses `hullDeck`; upper quarterdeck stations use `vesselDeck`.
- `js/caravel.js` and `js/wgsl/vessel.js` define moving yards and rigging. Work
  anchors must follow the same transforms as the visible rig.
- `boat.sailFore`, `sailMain`, `sailMizzen` request sail fractions.
  `advanceSails` changes actual canvas only with the per-mast attendance gate
  `boat.crewSailRate`. Yard trim remains automatic. Without a crew system (e.g.
  standalone physics fixtures or asset-load failure), the existing automatic
  handler remains available. There is no second canvas integrator.
- Existing controls in `js/main.js` should issue structured orders. The captain
  need not select individual hands for routine work. Keep heading/helm control
  separate until an explicit helmsman task and steering controller exist.

## Executable milestone and limits

Implemented: approach, climb/haul, attended sail changes, hatch closing, returning,
periodic aloft lookout, urgent bracing, and replaceable commands. CPU tests check
continuous movement, body separation, finite skin matrices, grip error, hazard
holds, actual canvas/hatch changes, return completion and hidden-crew operation.
GPU tests check both instanced batches, camera-fade flags, pipeline compilation,
actual sail uniforms through the UI, and all standalone builds.

The sequence is authored and simplified, not historical reefing or a general
multi-agent planning solution. Station ownership is by fixed role; there is no
arbitrary task auction or general deadlock resolver. Physical iPhone performance
of procedural IK remains unmeasured; the 30 FPS resolution target still applies.

## Getting past each other

Routes still say where to go. `js/crew-traffic.js` says who goes where on the deck in the meantime.

- **Bodies on the move** avoid each other by velocity obstacles (ORCA, van den Berg et al.), written here in about a hundred lines. Each takes a share of the avoiding by right of way, and each keeps to starboard of his own direction of travel, moving over before the meeting. If his right hand has no room he holds his line and the other takes all of it.
- **Someone standing still** is a matter for the route. The walker goes round on a line planned for it (`crewWorkPassingDetour`), and a round turns back. Someone idle with no way past them is asked to step aside (`crewWorkYieldIdle`), off the line the asker still has to walk.
- **A gap one body wide** takes one direction at a time. A lane is sampled along the route, and any stretch too tight for two, or on a stair, is such a gap. Whoever gives way waits at the last wide spot before it, a step to starboard of the lane. Victory's gangway past her guns is this: one body wide at each gun's recoil, with a bay between each pair of guns to stand in.
- **Right of way** is a strict order, so nobody waits on someone waiting on them: in the gap first, then gun crews and sail handlers at an order, then a load (`s.carrying`, or a loader going to his gun), then anyone strolling. Ties go by crew index.
- **Nose to nose** with someone who goes first, he steps out of their way, or back along his own trail if there is nowhere to step. After three seconds of it, either of them will.
- **A tight place** turns the shoulders. Centre to centre, two bodies try to keep 0.56 m, then 0.50 m, then 0.40 m turned. After four seconds hemmed in they may go to 0.32 m. The legs keep walking where he is going and the shoulders come round to face whoever he is squeezing past, in a compute pass over the skinning palette (`CREW_SHOULDER_TURN`). JavaScript sends one number a body, and nothing while everyone is square.
- **Feet.** The body comes round to the way it is going at a limited rate, and the walk slows while it does. Nobody turns on a shuffle.

A man lying on the deck is gone round if there is room and stepped over if not, and he keeps no one from taking his place at a gun.

Rowed hulls keep their own planner, because a walker there steps over thwarts on the line of the route. The helmsman, seated rowers and anyone working at a fixed station are walked around, and move only where a yield rule already had them move. Bodies aloft and overboard are ignored.

### The deck

`js/crew-deck.js` answers how far a point is from anything a body would strike. It starts from `js/models/crew-deck-masks.js`, baked by `node scripts/bake-crew-deck.mjs` from the mesh each ship draws: real floor at the height the crew walk on, nothing solid from the knee to the head, no step in the deck. To that it adds the reserved recoil of her guns, and an edge that has lost its rail narrows it as it is asked (`crewDeckRoom`). A step off the route is allowed only where this says so, and within half a metre of anything only if the route's own exact check agrees as well, so a body can always be routed on from wherever passing left him. Routes themselves still come from their graphs: MODEL_AUDIT item 23 stands for them, and only the sidesteps are held to the mesh.

A round goes only where the mesh leaves 0.44 m, so a hand at a tight post now stays at it. Before, most of them stood blocked anyway.

If a mesh changes, `tests/crew-deck.test.mjs` says so, and the masks want baking again.

### Why this and not a library

The numbers below say the old code hardly ever overlapped except where a gun crew was let walk through: what it mostly did was stand. So the work was less about avoiding bodies than about keeping them moving.

- **RVO2/ORCA** is the standard. `palmerabollo/rvo2-js` still calls itself an alpha for research only, and its core is small, so it is written here, with half-planes taken from the clearance field in place of obstacle polygons.
- **ORCA alone gridlocks in counterflow.** The gaps are why the lanes and right of way exist. Cooperative-ORCA* (arXiv 2606.22757) reaches for the same thing, each agent's whole trajectory rather than the next moment, for planned multi-agent paths. Reciprocally-Rotating Velocity Obstacles (Giese, Latypov and Amato, ICRA 2014) rotate polygonal agents to break deadlock. Here the turn is a pose on a capsule that passes closer, not a change to the solver.
- **Recast/Detour's crowd** has a maintained WASM port (`recast-navigation-js`). Tilt is no argument against it, since crew live in ship space, and damage only narrows the deck. But it brings a dependency, a path corridor of its own in place of the routes with their exact stair heights, and neither right of way nor passing side.

### What it did

Each row is one scene from `node scripts/crew-traffic.mjs`, with the full watch aboard, before and after. Deep means one body more than 0.1 m into another, reading a torso as an ellipse 0.48 m across and 0.38 m deep. Blocked counts time spent wanting to walk and not moving. A work trip is measured against path length over pace, so turning now counts against it where it used not to, as the clear-deck orders show. Feet follow the boot that is down through the walk clip and the body's transform: the mean is mostly the clip's own slip, and the worst of it was yaw snapping round.

| Ship | Scene | Deep overlaps a minute | Closest (m) | Blocked, all walkers | Blocked, at work | Longest stop (s) | Work trip against an empty deck | Feet: mean / p99 slide (m/s) | Yaw pops a minute |
|---|---|---|---|---|---|---|---|---|---|
| Niña | watch | 0 → 0 | 0.54 → 0.397 | 78% → 3% | 16% → 9% | 173.6 → 0.6 | ×1.09 → ×1.73 | 0.82 / 2.6 → 0.72 / 2.6 | 11.7 → 0.7 |
| Niña | sail | 0 → 0 | 0.541 → 0.494 | 33% → 8% | 17% → 9% | 11.8 → 0.9 | ×1.3 → ×1.47 | 0.70 / 7.2 → 0.69 / 3.2 | 54.1 → 5.2 |
| Niña | guns | 0 → 0 | 0.542 → 0.666 | 10% → 5% | 6% → 5% | 0.8 → 0.1 | ×1.05 → ×1.3 | 0.83 / 10.5 → 0.76 / 3.7 | 41.9 → 5.4 |
| Victory | watch | 0 → 0 | 0.541 → 0.462 | 50% → 9% | 8% → 1% | 172.9 → 2.5 | ×1.2 → ×1.14 | 0.74 / 2.4 → 0.77 / 2.5 | 24.3 → 0.7 |
| Victory | sail | 0 → 0 | 0.542 → 0.433 | 33% → 9% | 9% → 4% | 41.6 → 2.5 | ×1.18 → ×1.15 | 0.67 / 4.9 → 0.61 / 2.7 | 110 → 1.3 |
| Victory | guns | 0.67 → 0 | 0.02 → 0.419 | 7% → 5% | 7% → 5% | 0.6 → 0.1 | ×1.16 → ×1.09 | 0.60 / 8.1 → 0.61 / 3.0 | 14.7 → 3.3 |
| Santa María | watch | 0 → 0 | 0.546 → 0.55 | 2% → 1% | 4% → 3% | 1.6 → 0.7 | ×1.1 → ×1.2 | 0.71 / 2.3 → 0.68 / 2.4 | 11 → 0.7 |
| Santa María | sail | 0 → 0 | 0.542 → 0.55 | 3% → 2% | 4% → 3% | 1.4 → 0.6 | ×1.1 → ×1.2 | 0.64 / 6.0 → 0.61 / 2.8 | 85.5 → 3.9 |
| Santa María | guns | 1.55 → 0 | 0.001 → 0.496 | 5% → 1% | 6% → 2% | 2.6 → 0.3 | ×1.12 → ×1.17 | 0.57 / 5.4 → 0.52 / 2.7 | 52.8 → 2.3 |
| Oseberg | watch | 0 → 0 | 0.914 → 0.914 | 0% → 0% | 0% → 0% | 0 → 0 | ×0 → ×0 | 0.00 / 0.0 → 0.00 / 0.0 | 0 → 0 |
| Oseberg | sail | 0 → 0 | 0.582 → 0.582 | 2% → 2% | 2% → 2% | 0.1 → 0.1 | ×1.12 → ×1.15 | 0.31 / 2.7 → 0.35 / 2.6 | 19.7 → 0 |

| Ship | Order on a crowded deck | Same order, clear deck | All at work by (crowded / clear) |
|---|---|---|---|
| Niña | 41 → 45.8 s | 39.8 → 41.4 s | 6.5 / 5.8 → 8.8 / 7.2 s |
| Victory | 94.8 → 95.5 s | 92.1 → 94.2 s | 24.9 / 23.2 → 21.1 / 20.2 s |
| Santa María | 58.9 → 61.1 s | 56.2 → 59.4 s | 27.8 / 26.7 → 29 / 28.2 s |
| Oseberg | 15.2 → 15.5 s | 15.2 → 15.5 s | 6.1 / 6.1 → 6.4 / 6.4 s |

The busy deck is where the time goes now, not the standing: a hand walks round whoever is in the way where others used to stop dead for him, so a work trip through a crowded Niña is longer than it was (her lookout's walk home, ×1.73), while bystanders on her deck went from 78% blocked to 3%. Clear-deck orders are 1 to 6% slower because a body now turns where it used to snap. Her crowded sail order is the worst of it, 12% longer than before.

Niña's fore shrouds have since been shortened, and her order on a clear deck now takes 40.8 s. On a crowded one it still takes 45.8 s, because the five seconds are spent on deck getting round people and not on the climb. That is why `tests/crew-traffic.test.mjs` counts what a crowd costs in seconds and not as a share of the order.

Victory's simulation, the fastest of three runs of a minute each in node: watch 0.81 → 0.73 ms a step, sail 0.45 → 0.52, gun drill 0.33 → 0.65. The next stretch of route is now checked once and not every frame, which is why a watch got cheaper. The shoulder pass takes under 0.01 ms a batch on the GPU, and only while someone is turned.

Most of what was left was not the passing. A hand beginning a leg of his round asks `crewNavigationStation` where to stand at the end of it, and that laid out eight places round every obstacle aboard and put them in order before trying the place he asked for, which nearly always does: a third of a watch's step on Victory. It tries that place first now. The box test of a line against an obstacle makes no arrays, each hull remembers its deck field, and a step past someone writes who is near and what it came to into records that are kept. The scenes come out the same, row for row. Fastest of three runs of each whole scene, on a machine with other work on it: Victory's watch 0.50 → 0.23 ms a step, sail 0.46 → 0.26, gun drill 0.36 → 0.24, and Niña's 0.08 → 0.04, 0.08 → 0.06, 0.08 → 0.07. Counted and not timed, with node's nursery held at 1 MiB: 11,318 → 3,751 collections in Victory's three-minute watch, 4,256 → 2,527 in her sail order and 6,385 → 3,274 in her gun drill. The largest share of what is still allocated there is the script's own measuring.

## When the mast comes down

A section takes whoever is on it (`js/crew-aloft.js`). A hand on the lower ratlines stays with a lower mast that still stands, unless his ratlines were made fast above the break. Masts are read from `damage.mastState`, so it does not matter what brought one down.

He comes away as it leans, thrown to the side it falls by up to 5 m/s, harder the higher he is above the break. Where that lands him decides the rest. Clear of the deck he goes overboard with `cause: 'mast-fall'`, hurt, and dead from 30 m or more. On the deck he falls in her frame and is counted when he lands: under 2.2 m knocks him down, up to 7 m wounds him and usually breaks a limb, and more kills him.

Nobody is sent up a mast with no runners left, nobody keeps a lookout from a broken mast, and a hand walking to one turns back. Its canvas is then handled from the deck.

A runner also needs its foot. Victory's stand on her chainwales, and on other ships a foot at the side stands on the rail (`crewRunnerFootGone`). When that goes, whoever is on those shrouds or that chainwale comes off, outward. Climbers use the other side if it still has its runners, and a lookout coming down from the top does the same. Niña's feet stand inboard on the deck, so this never takes hers.

An edge that has lost its rail is covered in `GUNNERY.md`, under What a gap does.
