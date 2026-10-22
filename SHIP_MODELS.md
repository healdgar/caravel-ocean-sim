# Reusable ship definitions

The published registry admits **Niña, HMS Victory (1805), Pinta and Santa
María**. Pinta/Santa María are explicit development reconstructions with their
own hulls, equipment and mixed rigs. Up to **eight independently selected AI
followers plus the player** share one sea/weather simulation.

The **unpublished nine-model candidate** integrates Oseberg, Lusoria, the
Taíno-style canoe, Flying Cloud and Gipsy Moth IV with their own meshes, companies,
propulsion, equipment and controls. Final combined qualification and release
remain pending; registry/backend readiness is not a publication receipt.

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
- `js/models/rowing.js`, `js/rowing.js`, `js/rowing-ships.js`: candidate independent
  oared/paddled hulls, benches and shared blade/crew/force stroke geometry.
- `js/rowing-water.js`, `js/wgsl/rowing-water.js`: per-vessel moving-water samples
  from the shared GPU sea, consumed by actual blade immersion/relative flow.
- `js/models/later-sail.js`, `js/later-sail-ships.js`: candidate clipper/ketch hulls,
  fin/cockpit, model-owned spars, working cloth and named standing fittings.
- `js/models/procedural.js`, `js/procedural-models.js`: strict hull/deck/appendage
  adapters and affine nodes; no fallback to caravel geometry or dummy equipment.
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
corresponding starboard fittings. Masts expose foot/head points and actual climb
runners where provided. Yard, spar, luff, clew and control-station roles reflect
real equipment; a headsail has no fictitious yard. Rowing nodes expose actual
blade, grip and foot targets. Crew identities and costumes
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
anchor/gun equipment, loading policy and model-owned crew stations.
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

The candidate uses absent sail/mast/anchor paths for the canoe, distinct oar or
paddle strokes, and simultaneous wind/human propulsion on Oseberg and Lusoria.
One stroke drives visible blades, hand/foot targets and moving-water forces.
Dry recovery does not supply drive. A ready backend still requires root's
combined/rendered qualification before publication.

### Defined variants

| Model | Prepared rig | Geometry/status |
|---|---|---|
| Niña | Three lateen courses | Current authored 20 × 6 m caravel; ready |
| HMS Victory | Eight square sails, three headsails, gaff spanker | Own three-decker hull and `square1805` backend; ready |
| Pinta | Square fore/main courses, lateen mizzen | Development caravel, own loft/decks/equipment; `surfaces-v1`, CPU posed |
| Santa María | Square fore/main, main topsail, spritsail, lateen mizzen | Development nao, main/forecastle/quarter/poop zones and fore lookout; `surfaces-v1`, CPU posed |
| Oseberg-based vessel | One square sail, 30 oars, steering oar | Candidate independent clinker-style hull and bench/stroke layout; unpublished |
| Lusoria | One square sail, 24 oars, steering oar | Candidate late-Roman riverine reconstruction; unpublished |
| Taíno-style canoe | 24 paddlers and steering paddle; no mast or sail | Candidate independent dugout; no anchor or guns; unpublished |
| Flying Cloud | 15 square yards/cloth tiers, eight headsails, two gaff sails | Candidate fine-ended clipper, wheel and own working rig; inventory interpretation, unpublished |
| Gipsy Moth IV | Two Bermudan sails and two headsails on two masts | Candidate original-design ketch, recessed cockpit, fin and tiller; engine disabled, unpublished |

The first four belong to the public receipt above; five additional rows describe
integrated candidate source, not completed release qualification. Flying Cloud's
25 cloth surfaces are not a verified historical inventory.

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

Pinta/Santa María and the five additional candidate models use one CPU evaluator
for cloth, spars, ropes, surface normals
and attachment transforms. `asset.pose(boat,time,wind,targetVertices)` fills each
instance's geometry; the visible, shadow and submerged passes consume that upload.
Wetness probe positions refresh from those same posed vertices. Force panels and
crew targets evaluate the same model-owned surface functions. Victory retains
its shared GPU pose path; Niña's existing rig path remains explicit. Existing
three mast-control groups permit multiple actual sails per group. Physical mast
index is independent of control slot: Oseberg/Lusoria's mast zero uses `main`;
Gipsy Moth's main mast carries both fore-controlled headsails and main canvas.
The canoe exposes no sail controls or yard-transfer orders.

Rowing effort, differential stroke demand and cadence act through actual crew
attendance, blade immersion, moving-water velocity and authored human force/power
limits. Steering oars/paddles need relative flow. Each active rowing vessel owns
its sample/readback state; the fleet still shares one FFT ocean. Rowing followers
write these ordinary human commands, never prescribed velocity or motor thrust.

Loaded hull silhouette strips and actual exposed keel parts generate passive
crossflow/attached-lift loads and their sway/yaw/roll moments. Sail yaw feeds the
steering balance. The model does not invent a separate fin for Victory, calibrated
historical coefficients or a measured dynamic CLR. Formation guidance operates
physical canvas/helm controls, with leader/station velocity, leeway compensation
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

Published four-model boundary:

1. Passed: root's combined CPU/native Metal suite and production modular/Pages
   fixtures, including posed uploads, tested cloth/rope poses, crew reach/routes,
   wetting, disabled allocation and fleets through nine active vessels.
2. Passed: visible Chrome Pinta/Santa María review and native four-vessel,
   full-Moon and new-Moon captures. Published HTML, manifest and all 53 assets
   matched exact local sizes/hashes. Rendered fixtures do not certify every operating rig pose.
3. Calibrate hull offsets, mass/ballast, sail polars and dynamic lateral response
   when defensible source data exist. Current finite/passive equations alone do
   not establish historical performance or seaworthiness.

These completed receipts describe the published four-model source. The nine-model
candidate adds actual variable companies, rowing-water probes, optional equipment,
new rig envelopes and an all-nine-model scene; final combined and rendered
qualification and deployed-byte verification are pending separately.

Performance follow-up, not an admission gate: measure sustained target-device
cost. The nine-vessel bound is not a guarantee of 60 FPS on Mac or 30 FPS on a
physical iPhone.

## Validation

Existing baseline tests preserve pre-refactor Niña/Victory mesh/index hashes,
semantic ranges and attachment contracts. Published-checkpoint checks cover shared assets,
ready/planned guards, authoritative cloth/rope/crew/wetness positions, passive
hull-load invariants, physical follower controls and actual modular/Pages fleets.
Root's full native Metal suite passed **572/572**, zero skips, in **302.194 seconds**;
the checkpoint is published and byte-verified. [Astronomy](ASTRO_NAVIGATION.md) adds a
separate 528-byte production Frame and actual Moon/stars/night lighting shared
by each model, with no certified historical navigation accuracy.

## Later vessel programme

Victory was implemented first at the subsequent request. The five later craft
now have integrated candidate registry, geometry, crew, propulsion and renderer
paths. They remain unpublished pending final qualification. Their source subjects
and principal reconstruction limits are explicit:

| Target | Candidate capability | Source / reconstruction boundary |
|---|---|---|
| Viking vessel, c. AD 850 | One square sail, 30 oars, steering oar, open hull | Oseberg AD 820 hull proportions/reconstruction used for the c.850 scenario; draft, offsets and working sail authored |
| Roman galley, c. AD 350 | 24 oars, one square sail, steering oar | Lusoria Rhenana riverine reconstruction branch; not a trireme; .38 m service draft authored |
| Caribbean canoe, AD 1492, 30 people | 24 paddlers, five passengers and steering paddler | Greater Antillean design target, 14 × 1.8 m and .42 m draft authored; 30 occupants does not mean 30 drive paddlers |
| HMS Victory, 1805 configuration | Implemented first pass: own hull, square/fore-and-aft sail groups, crew stations and running rigging | Further dimensional refinement and measured sailing calibration remain; see source ledger |
| Flying Cloud, 1851 clipper | Separate courses/upper tiers, headsails, Spencer/spanker, wheel | Selected 225 ft deck/41 ft beam report; offsets/draft and cloth/chainplate/trim choices authored; crossjack cloth uncertain |
| Gipsy Moth IV, 1966 yacht | Two-mast ketch, four sails/three controls, fin, cockpit, tiller | Original design-DWL branch, 53.1 ft LOA/10.5 ft beam; reported original lead retained; later refit figures separate |

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

Companies and personnel mass are separate model fields. These are candidate
simulation manifests, not newly established historical complements:

| Model | Represented people | People in loading manifest | Equipment / helm |
|---|---:|---:|---|
| Niña | 12 | 12 | Four swivel guns, anchors, tiller/rudder |
| Pinta | 12 | 30 | Four authored swivel guns, anchors, tiller/rudder |
| Santa María | 12 | 40 | Four authored swivel guns, anchors, tiller/rudder |
| HMS Victory | 12 | 820 | 104 guns, anchors, wheel/rudder |
| Oseberg | 32 | 32 | 30 oars, anchors, steering oar; no guns |
| Lusoria | 26 | 26 | 24 oars, anchors, steering oar; no guns |
| Taíno-style canoe | 30 | 30 | 24 paddles plus steering paddle; no anchor/guns/rig |
| Flying Cloud | 12 | 42 | Anchors, wheel/rudder; no guns |
| Gipsy Moth IV | 1 | 1 | Anchor, tiller/rudder; engine disabled, no guns |

One of each uses 149 represented actors, not a full historical company for every
ship. Shared human assets retain human dimensions and reusable identities;
each vessel owns actor palettes, jobs, rowing attendance, wetness and hand targets.
Recorded tonnage never supplies simulation kilograms. Moth's original design-DWL
10.58 t and 3.85 t lead are distinct from empty-hull mass and later restored
displacement reports. Geometric calibration to one DWL does not validate a
sailing polar or every historical loading condition.

Reuse ocean/weather, materials, wetness, hull contacts, wake/spray, crew identities,
orders and attachment evaluation where applicable. Each additional hull needs
its own displacement/contact representation and validation; a new mesh alone
does not make the current Niña physics suitable for it. Publish additional models only
after geometry, propulsion, crew jobs and actual fleet rendering pass their gates;
record performance separately without claiming physical-device qualification.
