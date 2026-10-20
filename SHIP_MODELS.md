# Reusable ship definitions

Niña and HMS Victory (1805) are playable. Pinta and Santa María remain validated
planned definitions; neither can silently use another model's mesh. Victory was
brought forward ahead of those variants at the user's request. The renderer still
has two vessel slots; a three-model fleet toggle remains pending.

## Ownership

- `js/models/nina.js`: immutable authored dimensions, hull parameters, deck/helm
  layout, anchor catheads, crew home stations, tackles and reconstruction plate.
- `js/models/victory.js`, `js/victory.js`, `js/victory-motion.js`: Victory hull,
  decks, batteries, spars, cloth, rope leads and shared posed geometry.
- `js/ship-models.js`: model registry, sourced reference measurements, named
  structure points and posed attachment resolution.
- `js/rig-definition.js`: validates node references, acyclic parents, mast/sail
  identities, control groups and ready versus planned backend capabilities.
- `js/ship-mesh.js`: CPU geometry cache keyed by model ID and revision. Each
  asset owns mesh/index data and semantic inspection groups; each vessel owns
  its motion, rig, crew, moisture, anchor, probes and wake.
- `js/vessels.js`: binds model identity and copies requested vessel settings
  without transplanting another vessel's running simulation.

Legacy hull/rig exports remain Niña aliases. Model-aware hydrostatics, deck/width
queries, exclusion masks, helm camera, material transforms and crew routes select
the appropriate geometry. The same ocean, weather, crew assets, lighting and
sound systems serve both. See [VICTORY_RESEARCH.md](VICTORY_RESEARCH.md) for
measurements, construction references and unresolved historical calibration.

## Structure points and mesh groups

Stable roles include `hull`, `deck.main`, `deck.quarter`, `helm.tiller`,
`helm.grip`, `helm.camera`, `hatch.main`, `anchor.port.fairlead` and the
corresponding starboard fittings. Each mast has named foot/head/runner points,
yard/tack/peak points, sail clews and a haul station. Crew identities and costumes
remain independent of ship-owned home stations.

```js
import {resolveShipNode} from './js/ship-models.js';
const bowLead = resolveShipNode(boat, 'anchor.port.fairlead'); // hull-local metres
const clew = resolveShipNode(boat, 'sail.fore.clew', {space:'design', time, wind});
const grip = resolveShipNode(boat, 'helm.grip', {along:.09});
```

These are point attachments, not a replacement skeleton or arbitrary GLB loader.
Node rest positions are relative to their parents. Dynamic evaluators return an
absolute point from the same CPU cloth/yard/runner/tiller functions used by the
simulation; children inherit the evaluated parent origin. Exact rig orientation
comes from those evaluators, not a generic translation of rest geometry.
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

| Model | Prepared rig | Geometry/status |
|---|---|---|
| Niña | Three lateen courses | Current authored 20 × 6 m caravel; ready |
| HMS Victory | Eight square sails, three headsails, gaff spanker | Own three-decker hull and `square1805` backend; ready |
| Pinta | Square fore/main courses, lateen mizzen | Planned caravel; unresolved points remain null |
| Santa María | Square fore/main, main topsail, spritsail, lateen mizzen | Planned nao hull/decks; unresolved points remain null |

Sails have stable IDs independent of mast IDs; multiple sails can share a mast
and `fore`, `main` or `mizzen` control group. Fittings attach by node ID. Santa
María includes the requested `lookout.fore` crow's nest point. Its foremast
placement is an authored request, not a verified historical fact; it can be moved
without changing crew identity or inventing another animation system.

Reported replica dimensions/tonnage retain source, subject, units and meaning in
`referenceMeasurements`. See [SHIP_MODEL_RESEARCH.md](SHIP_MODEL_RESEARCH.md).
They do not change simulation dimensions or kilograms. Pinta's modern visitor
replica is enlarged. Santa María's reported 3.49 m *puntal* is hull depth, not
draught. Original 1492 offsets and displacement remain uncertain.

## Next implementation gates

1. Select each variant's reconstruction/size profile and author its own hull,
   decks, structural points, crew routes and hydrostatics. Do not apply replica
   tonnage as displacement or scale Niña into a nao.
2. Adapt the Victory square-cloth/yard/rope backend to each historical rig,
   retaining a shared posed surface for visible rendering, forces, shadows and
   wetting. The existing 208-byte hull uniform carries model identity, vertical
   scale and three mast-control groups; Victory evaluates twelve actual sails.
   Its initial bracing/contact envelope is authored rather than a calibrated polar.
3. Validate mast/yard/sheet/cloth clearance, rig jobs, lookout access and physical
   dimensions. Keep one authoritative posed geometry for every consumer.
4. Generalize the current two-vessel ocean mask, wake bindings, foam/probe
   dispatch and shadow array to three independently enabled model instances.
   Share immutable assets per model and the single ocean/weather simulation.
5. Add the three fleet toggles only after each model passes those gates; measure
   the combined scene on the target iPhone against the 30 FPS goal.

## Validation

Tests preserve the exact pre-refactor raw mesh, compact mesh and index SHA-256
hashes. They check component ranges, shared asset caching, ready/planned guards,
static and animated attachment alignment, inherited moving origins, crew station
ownership and independent vessel simulation. The normal GPU suite covers the
rendered fleet, anchor actions, crew jobs and all standalone bundles.

## Later vessel programme

Victory is implemented first at the subsequent request. After the remaining
Pinta/Santa María and fleet work, the following targets remain on the roadmap.

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

Oar/paddle propulsion and historical-complement crew simulation remain
unimplemented. Ready backends support Niña lateens and Victory square/headsail/
gaff cloth under three mast groups. Victory loading accounts for 820 people,
with twelve visible workers. Attachment resolution returns points; rowing and
paddling need shared posed orientations/transforms too. Separate optional `rig`,
`propulsion`, `steering`, `crewLayout` and `hull/hydrostatics` capabilities before
admitting those craft.

Reuse ocean/weather, materials, wetness, hull contacts, wake/spray, crew identities,
orders and attachment evaluation where applicable. Each additional hull needs
its own displacement/contact representation and validation; a new mesh alone
does not make the current Niña physics suitable for it. Admit each model only
after geometry, propulsion, crew jobs and fleet performance pass its gates.
