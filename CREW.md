# Crew and decision-system preparation

Twelve named sailors are implemented: six women and six men. Captain orders
create executable sail-handling and hatch jobs. Fore/main work assembles an aloft
hand and a deck hand; only their attendance allows actual canvas to change.
A lookout climbs a foremast runner during watch. Job phases are approach,
ascending, working, descending and return. Routes are authored; role allocation
reserves distinct runners, and moving sailors yield to nearby bodies.

`js/rigging.js` supplies the mesh, runner path and grip positions. Two-bone IK
places alternating hands and simplified boot locks against the actual ropes.
Climbers stop below the mast heads. There are no ratline ladders or mast baskets
in the selected Martínez-Hidalgo reconstruction.
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
enlarged hull, walking speed stays in metres per second, and the helmsman's station
follows the tiller grip from 0.32 m forward, facing aft. A slight crouch lets both
hands reach the waist-height arm. The player camera remains above on the quarterdeck.

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
