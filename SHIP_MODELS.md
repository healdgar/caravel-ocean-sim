# Reusable ship definitions

The model/attachment foundation is implemented. Niña remains the only playable
model. Pinta and Santa María have validated planned definitions; they cannot be
spawned or silently rendered with Niña geometry. Building their meshes, square
rigs and the three-ship sailing toggle is the next stage, not part of this pass.

## Ownership

- `js/models/nina.js`: immutable authored dimensions, hull parameters, deck/helm
  layout, anchor catheads, crew home stations, tackles and reconstruction plate.
- `js/ship-models.js`: model registry, sourced reference measurements, named
  structure points and posed attachment resolution.
- `js/rig-definition.js`: validates node references, acyclic parents, mast/sail
  identities, control groups and ready versus planned backend capabilities.
- `js/ship-mesh.js`: CPU geometry cache keyed by model ID and revision. Each
  asset owns mesh/index data and semantic inspection groups; each vessel owns
  its motion, rig, crew, moisture, anchor, probes and wake.
- `js/vessels.js`: binds model identity and copies requested vessel settings
  without transplanting another vessel's running simulation.

The current hull/rig exports remain compatible aliases. Shared routines such as
hydrostatics, hull exclusion, climbing routes and shader generation still consume
Niña's geometry. This refactor identifies that boundary instead of treating the
existing caravel as a universal hull.

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
its existing fixed vertical scale when the length slider changes. This pass
does not rescale people, rewrite buoyancy or change sail forces.

The mesh now exposes 110 named triangle ranges: hull, planking, decks, cabin,
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
2. Add a square cloth/yard/rope backend shared by visible rendering, forces,
   shadows and wetting. A retained square mesh generator alone is insufficient.
   The active shader, 208-byte hull uniform and force tessellation still assume
   three lateen sails. Existing bad-tack geometry remains a separate known defect.
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
