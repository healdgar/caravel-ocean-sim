# Reusable ship definitions

The published registry admits **Niña, HMS Victory (1805), Pinta and Santa
María**. Pinta/Santa María are explicit development reconstructions with their
own hulls, equipment and mixed rigs. Up to **eight independently selected AI
followers plus the player** share one sea/weather simulation. Five later craft
have authored definitions/prototypes but are not admitted to the playable registry.

**Qualification/release boundary:** published runtime
`7fba40de2601552757ada1ce490883ced75f06fb` passed **572/572 native Metal suite
tests**, zero skips, in **302.194 seconds**, with rendered checks. Pages deployment
`7243537555` succeeded at **2026-10-22T04:12:31Z**; public HTML, manifest and all
53 assets matched sizes/hashes at **04:13:27Z**. Physical-iPhone performance is unqualified.
Victory was brought forward at the user's request. See [BACKLOG.md](BACKLOG.md)
for [exact validation and deployment receipts](BACKLOG.md#published-checkpoint-four-vessels-independent-fleets-and-night).

## Ownership

- `js/models/nina.js`: immutable authored dimensions, hull parameters, deck/helm
  layout, anchor catheads, crew home stations, tackles and reconstruction plate.
- `js/models/victory.js`, `js/victory.js`, `js/victory-motion.js`: Victory hull,
  decks, batteries, spars, cloth, rope leads and shared posed geometry.
- `js/models/additional.js`, `js/additional-ships.js`, `js/additional-rig.js`,
  `js/rig-surface.js`: separate Pinta/Santa María lofts, decks, hardware, cloth,
  yards, ropes and authoritative posed surfaces/attachments.
- `js/mesh-writer.js`: shared nine-float construction primitives, preserving the
  existing Victory construction output.
- `js/ship-models.js`: model registry, sourced reference measurements, named
  structure points and posed attachment resolution.
- `js/rig-definition.js`: validates node references, acyclic parents, mast/sail
  identities, control groups and ready versus planned backend capabilities.
- `js/ship-mesh.js`: CPU geometry cache keyed by model ID and revision. Each
  asset owns mesh/index data and semantic inspection groups; each vessel owns
  its motion, rig, crew, moisture, anchor, probes and wake.
- `js/vessels.js`: binds model identity and copies requested vessel settings
  without transplanting another vessel's running simulation.
- `js/fleet.js`, `js/follower.js`: enabled roster allocation, per-model assets,
  distinct formation slots, neighboring-ship avoidance and ordinary sail/helm
  control. `js/wgsl/fleet-wakes.js` pools per-vessel wakes.
- `js/hull-lateral.js`: cached submerged hull/actual-appendage profiles and passive
  distributed forces/moments, consumed with sail yaw by the body integrator.

Legacy hull/rig exports remain Niña aliases. Model-aware hydrostatics, deck/width
queries, exclusion masks, helm camera, material transforms and crew routes select
the appropriate geometry. Enabled vessels share the ocean, weather, crew assets
and lighting. Hull-contact audio remains player-centric; independent spatial
follower contact audio is not implemented. See [VICTORY_RESEARCH.md](VICTORY_RESEARCH.md) for
measurements, construction references and unresolved historical calibration.

## Structure points and mesh groups

Stable roles, where present, include `hull`, `deck.main`, `deck.quarter`, `helm.tiller`,
`helm.grip`, `helm.camera`, `hatch.main`, `anchor.port.fairlead` and the
corresponding starboard fittings. Each mast has named foot/head/runner points,
yard/tack/peak points, sail clews and a haul station. Crew identities and costumes
remain independent of ship-owned home stations. This example uses Niña; other
rigs expose their actual clew identities through `model.rig.sails[].clewNodes`.

```js
import {resolveShipNode} from './js/ship-models.js';
const bowLead = resolveShipNode(boat, 'anchor.port.fairlead'); // hull-local metres
const clew = resolveShipNode(boat, 'sail.fore.clew', {space:'design', time, wind});
const grip = resolveShipNode(boat, 'helm.grip', {along:.09});
```

These are point attachments, not a replacement skeleton or arbitrary GLB loader.
Static node offsets are relative to their parents. The legacy point query
accumulates parent origins; this does not establish a rotated or scaled moving
hierarchy. Explicit animated attachments resolve absolute points through the
same CPU cloth/yard/runner/tiller functions used by the simulation. Use the
position-and-basis contract below for orientation; arbitrary moving descendants
are not inferred by translating rest geometry.
The existing hull transform applies heading, pitch, roll and world translation.

`space:'design'` preserves authored coordinates. Default `space:'vessel'` uses
the model's length/beam reference and vertical scale. Niña deliberately retains
its existing fixed vertical scale when the length slider changes. Victory uses its own length-derived vertical scale and hydrostatic hull. Crew
retain human dimensions rather than scaling with the ship.

The Niña mesh exposes 110 named triangle ranges: hull, planking, decks, cabin,
stairs, tiller/rudder, anchors, masts, yards, sails/edges and every rigging line.
Ranges can nest and are **not** a disjoint mesh partition. `firstVertex` and
`vertexCount` index the original triangle stream; because deduplication retains
triangle order, those numbers are also the indexed `firstIndex`/`indexCount`.
They are not positions in the compact vertex buffer. Existing visual joint tests
and legacy `parts` inspection output remain intact.

## Prepared variants

### Shared-part comparison and adapters

`js/ship-parts.js` supplies a shared inspection/attachment contract. The original
Niña/Victory comparison below remains the baseline; Pinta/Santa María add the
`surfaces-v1` construction/pose backend.
`getShipParts(id)` exposes their existing hull/profile functions, design frame,
weather-deck zones, steering pivots, sail surfaces and mast control groups,
anchor/gun equipment, loading policy and twelve represented crew stations.
It neither rebuilds geometry nor changes existing node, force or animation APIs.
Planned models retain the playable-model guard. A ready model needs an explicit
geometry/rig/hull path; unknown backends fail rather than falling back to Niña.

| Part | Niña | HMS Victory |
|---|---|---|
| Hull | Authored analytic caravel sections; 20 × 6 m runtime | Authored section loft; 56.6928 × 15.8496 m runtime |
| Exposed weather levels | Main and quarterdeck | Waist/main, forecastle, quarterdeck and poop; battery schedule is separate |
| Keel | Actual separate `.13 × .15` design-unit timber; `.075` exposed below skin | Integral authored loft bottom; no separately identified historical keel/rabbet endpoints |
| Lateral resistance | Loaded hull silhouette plus exposed timber keel | Loaded hull silhouette; no invented separate fin |
| Steering | Direct tiller and stern rudder | Wheel/tiller linkage and stern rudder |
| Canvas | Three lateen surfaces under three controls | Twelve square/headsail/gaff surfaces under three controls |
| Equipment | Four represented swivel guns; authored small-ship anchor | 104 represented guns; authored first-rate anchor |
| Loading/crew | Twelve loaded and represented | 820 loaded; twelve workers represent a watch |

These are descriptions of the implementation, not evidence of historical
accuracy. In particular, neither a loft's lowest row nor its inferred immersed
lateral area establishes a measured keel length or a calibrated centre of resistance.

`resolveShipTransform(boat, role, options)` returns `position` and three `basis`
columns in `design`, hull-local `vessel` metres, or `world` space. Rigid bases
come from the actual yard/helm/hatch pose; cloth bases sample the authoritative
posed surface at `(u,v)` and its normal. Columns retain affine scaling and are
not generally unit vectors. Surface roots default to their centroid; named
clews retain their attachment UVs. The API does not invent translation-only
inheritance for unknown moving descendants, and absent roles throw explicitly.
`resolveShipNode()` preserves its legacy point-query behavior while supporting
the explicit new model backends.

The capability design permits absent sails/masts and distinct sail, oar or paddle
propulsion. Planned rowing source now evaluates stroke pivots, grips, blades,
stations, water contact and force; that prototype is not yet integrated into
production crew/control/GPU backends and does not admit those craft to play.

### Defined variants

| Model | Prepared rig | Geometry/status |
|---|---|---|
| Niña | Three lateen courses | Current authored 20 × 6 m caravel; ready |
| HMS Victory | Eight square sails, three headsails, gaff spanker | Own three-decker hull and `square1805` backend; ready |
| Pinta | Square fore/main courses, lateen mizzen | Development caravel, own loft/decks/equipment; `surfaces-v1`, CPU posed |
| Santa María | Square fore/main, main topsail, spritsail, lateen mizzen | Development nao, main/forecastle/quarter/poop zones and fore lookout; `surfaces-v1`, CPU posed |

Sails have stable IDs independent of mast IDs; multiple sails can share a mast
and `fore`, `main` or `mizzen` control group. Fittings attach by node ID. Santa
María includes the requested `lookout.fore` crow's nest point. Its foremast
placement is an authored request, not a verified historical fact; it can be moved
without changing crew identity or inventing another animation system.

Reported replica dimensions/tonnage retain source, subject, units and meaning in
`referenceMeasurements`. See [SHIP_MODEL_RESEARCH.md](SHIP_MODEL_RESEARCH.md).
Reference fields do not silently assign kilograms. The development Pinta selects
the enlarged modern-replica size profile, 25.908 × 7.0104 m, with a 2.286 m service
draft target; Santa María selects 28.30 × 7.96 m and an authored 1.95 m draft. Her
reported 3.49 m *puntal* is hull depth, not draught. Their offsets, ballast/loading,
working cloth dimensions and four represented swivel guns remain authored.
Original 1492 offsets and displacement are uncertain; builders' or capacity
tonnage is never converted directly into displacement mass.

## Current geometry, physics and fleet contract

Pinta/Santa María use one CPU evaluator for cloth, spars, ropes, surface normals
and attachment transforms. `asset.pose(boat,time,wind,targetVertices)` fills each
instance's geometry; the visible, shadow and submerged passes consume that upload.
Wetness probe positions refresh from those same posed vertices. Force panels and
crew targets evaluate the same model-owned surface functions. Victory retains
its shared GPU pose path; Niña's existing rig path remains explicit. Existing
three mast-control groups permit multiple actual sails per group.

Loaded hull silhouette strips and actual exposed keel parts generate passive
crossflow/attached-lift loads and their sway/yaw/roll moments. Sail yaw feeds the
steering balance. The model does not invent a separate fin for Victory, calibrated
historical coefficients or a measured dynamic CLR. Formation guidance operates
physical canvas/rudder controls, with leader/station velocity, leeway compensation
and bounded helm feedback. Rudder commands add no motor or zero-flow turn assist.

`fleet` accepts up to eight ordered follower selections. Enabled rows allocate a
real vessel; `!model-id` keeps a disabled UI row without GPU resources. An omitted
`fleet` preserves the legacy same-model follower and `follower=0` starts alone.
Model choices/add/remove/toggles apply through a scene reload; share links retain
these selections. The single ocean/weather system receives all enabled hull masks,
probes and wakes. Per-model source geometry/index/render assets are immutable;
per-instance geometry, crew joint/actor buffers, wetness, probes, guns and anchors
are independent. Two wake banks and three shadow arrays use one layer per active
vessel, without enumerating every wake-parity combination.

## Qualification and remaining boundaries

1. Passed: root's combined CPU/native Metal suite and production modular/Pages
   fixtures, including posed uploads, tested cloth/rope poses, crew reach/routes,
   wetting, disabled allocation and fleets through nine active vessels.
2. Passed: visible Chrome Pinta/Santa María review and native four-vessel,
   full-Moon and new-Moon captures. Published HTML, manifest and all 53 assets
   matched exact local sizes/hashes. Rendered fixtures do not certify every operating rig pose.
3. Calibrate hull offsets, mass/ballast, sail polars and dynamic lateral response
   when defensible source data exist. Current finite/passive equations alone do
   not establish historical performance or seaworthiness.

Performance follow-up, not an admission gate: measure sustained target-device
cost. The nine-vessel bound is not a guarantee of 60 FPS on Mac or 30 FPS on a
physical iPhone.

## Validation

Existing baseline tests preserve pre-refactor Niña/Victory mesh/index hashes,
semantic ranges and attachment contracts. Passing new checks cover shared assets,
ready/planned guards, authoritative cloth/rope/crew/wetness positions, passive
hull-load invariants, physical follower controls and actual modular/Pages fleets.
Root's full native Metal suite passed **572/572**, zero skips, in **302.194 seconds**;
the checkpoint is published and byte-verified. [Astronomy](ASTRO_NAVIGATION.md) adds a
separate 528-byte production Frame and actual Moon/stars/night lighting shared
by each model, with no certified historical navigation accuracy.

## Later vessel programme

Victory was implemented first at the subsequent request. The following five
later craft now have authored source definitions/prototypes, but production
registration, crew/propulsion/renderer integration and qualification remain pending.
The Victory row retains its separate refinement boundary.

| Target | Planned capability | Reference decision before modelling |
|---|---|---|
| Viking longship, c. AD 850 | Sail and oar propulsion, rowing stations, steering oar, shallow open hull | Choose ninth-century evidence/reconstruction; do not silently substitute a later longship or claim an exact AD 850 wreck |
| Roman galley, c. AD 350 | Oars and sail, coordinated rowing, vessel-specific steering and crew layout | Select a late-Roman vessel class and reconstruction; resolve seagoing versus riverine service and oar-bank arrangement |
| Caribbean canoe, AD 1492, 30 people | Paddle propulsion and steering, occupied paddling stations, loading-sensitive freeboard | Select regional/cultural references; distinguish 30 occupants from 30 active paddlers and any extra cargo |
| HMS Victory, 1805 configuration | Implemented first pass: own hull, square/fore-and-aft sail groups, crew stations and running rigging | Further dimensional refinement and measured sailing calibration remain; see source ledger |
| Flying Cloud, 1851 clipper | Full ship rig with separate courses, topsails and upper sails; fine-ended ocean-going hull | Replaces the generic schooner target; obtain lines, deck and sail plans before modelling |
| Gipsy Moth IV, 1966 yacht | Ketch rig, yacht-scale crew, cockpit helm and handling | Working interpretation of the requested "Gypsy Moth"; distinguish original circumnavigation configuration from later refits |

The Victory identity/date is the working interpretation of "Admiral Nelson's
ship". Historical starting points and unresolved choices are recorded in
[SHIP_MODEL_RESEARCH.md](SHIP_MODEL_RESEARCH.md#later-vessel-reference-starting-points).
No dimensions, displacement or crew counts are inferred from the target dates.

The reusable architecture must consequently support:

- Optional sail, oar and paddle propulsion, including simultaneous modes where
  supported by the selected vessel; craft without sails need no dummy masts.
- Named oar pivots, grips, blades, paddle paths and crew stations. One evaluated
  stroke must drive visible movement, hand targets, water contact, sound and
  physical thrust. Dry recovery strokes cannot create propulsion.
- Port/starboard stroke commands, cadence, crew effort and fatigue; stroke forces
  and their lever arms determine surge/yaw, rather than an artificial speed boost.
- Hull-specific hydrostatics, mass/inertia, load and freeboard; steering may use
  rudders, steering oars, differential rowing or paddles as defined by the craft.
- Variable sail, mast, deck, station and crew counts. Exposed work, climbing,
  shelter and navigation paths belong to each model. Victory needs scalable crew
  simulation/rendering rather than one full-cost animated agent per historical
  occupant.

`js/models/rowing.js`, `js/rowing.js` and `js/rowing-ships.js` contain independent
Oseberg/Lusoria/Taíno-style source and shared stroke/immersion/force/mesh prototypes.
`js/models/later-sail.js` contains Flying Cloud and Gipsy Moth IV definitions and
explicit readiness requirements. These five craft remain planned and unregistered;
prototype equations or metadata are not playable integration. Historical-complement
crew simulation remains abstracted: Victory loads 820 people but represents twelve
workers; Pinta/Santa María likewise represent twelve workers with separate loading
policies. Optional rig/propulsion/steering/crew/hydrostatics capabilities must stay
model-owned as these backends enter production.

Reuse ocean/weather, materials, wetness, hull contacts, wake/spray, crew identities,
orders and attachment evaluation where applicable. Each additional hull needs
its own displacement/contact representation and validation; a new mesh alone
does not make the current Niña physics suitable for it. Admit each model only
after geometry, propulsion, crew jobs and actual fleet rendering pass their gates;
record performance separately without claiming physical-device qualification.
