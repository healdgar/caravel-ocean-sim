# Crew and decision-system preparation

Design only: crew agents, characters, navigation and work execution are not yet
implemented. The current sail controls still drive automatic handling directly.

## Complement

Start with 12 simulated people, including the captain: captain, mate, boatswain
and nine hands with overlapping sailing, cooking and maintenance skills. Two
six-person watches provide a simple initial duty schedule; manoeuvres can call
all hands. This is a lean design estimate for our default 12 m × 3.6 m vessel,
not a documented historical minimum or a validated manning requirement.

The [Museum of Angra do Heroísmo](https://museu-angra.cultura.azores.gov.pt/en/others/historical-pieces/caravela/)
describes 20–30 m caravels, with smaller examples carrying 25–30 people. The
[Niña replica operator](https://www.ninapinta.net/) reports an ocean voyage of
over 4,000 miles with 11 sailors in 1991–92. A modern replica voyage establishes
feasibility under those conditions, not a minimum for period equipment or storms.

Simulated complement and rendered population are separate. Initially budget six
visible sailors, with off-watch crew below deck; all-hands work may require more
visible characters. Hidden crew retain identity, fatigue and task state. Never
complete physical work merely because its workers are off camera. Crew count
must remain configurable, including a historically fuller 25–30-person option.

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
  indefinitely for another. Yield on ladders at authored passing/waiting nodes.
- Recheck hazards during travel and work. Urgent bracing can interrupt ordinary
  orders. A climber stops at a secure grip or platform, never switches directly
  into a deck-walking animation. Resume or replan after the hazard passes.
- Task commitment and switching penalties prevent constant indecision. Fatigue
  affects work, climbing and watch relief; rest must consume simulation time.

## Integration seams

- `js/hull.js` is the source for decks and helm anchors. Author routes around
  stairs, cabin, masts and railings in ship space. Validate access to mast tops;
  the current crow's-nest floor needs an actual opening before climbing works.
- `js/caravel.js` and `js/wgsl/vessel.js` define moving yards and rigging. Work
  anchors must follow the same transforms as the visible rig.
- `boat.sailFore`, `sailMain`, `sailMizzen` currently request sail fractions.
  `advanceSails` in `js/sailing.js` changes actual `sailingState(boat).set` and
  trim automatically. In crew mode, commands must create work; executor progress
  must become the sole driver of these actual values. Do not leave automatic
  handling running alongside crew work. Preserve automatic handling as a
  separate mode until a complete crew workflow is usable.
- Existing controls in `js/main.js` should issue structured orders. The captain
  need not select individual hands for routine work. Keep heading/helm control
  separate until an explicit helmsman task and steering controller exist.

## First executable milestone

Three visible sailors complete one foremast sail-reduction order: approach,
reserve stations, climb/haul, perform work together and return. Use a deliberately
authored sequence first; identify required rig access and hardware before calling
it historical reefing. The other crew retain simple watch/rest state.

Acceptance checks: no duplicate station occupancy; no work without a present,
capable team; orders changed mid-climb leave no stuck reservation; stale async
decisions cannot resurrect cancelled work; actual sail area and forces follow
completed work; hiding a character changes neither progress nor fatigue. Measure
the added CPU/GPU cost on the iPhone against the existing 30 FPS target.
