# Shared Forestmodeler forest instances

The regional forest uses five current grown native cohorts: oak, maple, birch,
elm, and chestnut. They are authored visual proxies, not surveyed Saba species.
The existing42-tree world-space stand remains supported and is not transformed
again. Its small coverage rectangle is excluded from new planting.

The offline importer consumes `prototype_SPECIES_waterworld_manifest.json` packs
from Forestmodeler's `scripts/bake_waterworld_prototypes.py`. It verifies source
receipts using the existing canopy importer, applies the GLB node transform,
then undoes the single stem's biological collar translation and Z-up yaw.
The shared local wood, shell-culled foliage, and native opaque far crown retain
source linear material colours. Leaves reuse the existing declared alpha image.

Root planting covers the resident Saba region. Elevation18–840m, slope<=1.1,
vegetation-mask byte>=96, coastal crown-rim checks and crown-relative spacing are
hard exclusions. Candidate identities are deterministic. Crowns may overlap;
this is not a botanical competition simulation. Occupied64m cells replace only
their corresponding legacy roots. Bare/coastal gaps receive no new trees.
At residency, roots are seated once using the shared rendered-triangle sampler,
including Wells Bay's measured near tile. Newly resolved cliffs/beaches exclude
roots rather than floating them above ground.

Runtime assets:

- `manifest.json`: source/terrain receipts, prototypes, root ranges, occupied cells.
- `vertices.bin`: indexed prototype vertices,13Float32/vertex (52bytes).
- `indices.bin`: UInt32 triangle indices; wood/leaf/far ranges partition it.
- `roots.bin`:12Float32/root (48bytes): xyz collar position, uniform scale,
  yaw, linear RGB tint, prototype ID, collar sink, two reserved values.

Prototype and root buffers are uploaded once. Every frame, GPU compute resets
indirect instance counts, culls spheres, selects LOD, and compacts root IDs.
Draws are indexed and indirect, with zero firstInstance (no optional WebGPU
feature required). Camera movement causes no CPU root scan or geometry upload.
The asset budget is32MiB; root placement fails rather than silently truncating
at100,000roots. Five shared prototypes avoid geometry replication per tree.

Auto LOD switches to the opaque far prototype only when its whole conservative
support fits<=3actual rendered pixels; hysteresis remains inside that limit.
This is not certification of alpha or colour error. `canopy=far` is an explicit
inspection override. A measured appearance atlas/shared forest shell remains
future work; no48px default or unproved imperceptibility claim is used.

Explicit authoring commands (root owns execution and validation):

```sh
uv run --directory ../forestmodeler python scripts/bake_waterworld_prototypes.py --help
uv run --directory ../forestmodeler python /absolute/path/waterworld/scripts/prepare-forest-instances.py --source-dir /absolute/path/native-prototypes --region /absolute/path/waterworld/assets/world/saba
node --test tests/forest-scenery.test.mjs tests/forest-scenery-gpu.test.mjs
uv run --directory ../forestmodeler python /absolute/path/waterworld/tests/forest-instances-import.test.py
```

The importer never grows plants, invokes Blender, downloads assets, or runs
rendering. Add the new module before `js/terrain.js` in the standalone build
order, and the four explicit asset paths to its runtime asset table after import.
The forest loader is deferred with landfall; unavailable packs retain the old
stand and procedural forest. GPU pipeline failures remain errors to diagnose.
