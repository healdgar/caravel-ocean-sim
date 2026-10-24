# Source-derived forest LOD pilot

Experimental implementation of [FOREST_LOD_PLAN.md](FOREST_LOD_PLAN.md).
**Not imported by game startup; not a production asset pack or a published
performance fix.** Generated comparison packs remain outside the repository.

## Implemented

- Deterministic spatial hierarchy of complete original four-triangle leaf
  blades. Every frontier covers each source blade once; source records, UVs,
  winding, material IDs and canopy AO retain explicit receipts.
- Three reduced woody meshes per species, using the pinned meshoptimizer tool.
  Retained vertices keep original records and AO source IDs. Error bounds take
  precedence over triangle targets; the exporter reports misses.
- Six-view branch captures at 128/512-leaf frontiers, using original pigment,
  normal, underside, transmission and exposure. Premultiplied linear channels,
  physical source MASK samples, bounded image-depth correction, independently
  filtered/guttered mips and original canopy AO.
- Paged original leaf geometry for inspection children of at most 32 blades,
  plus curved two-triangle source leaf ribbons (`js/forest-leaf-ribbons.js`) and
  offline preauthored ribbon index assets (`scripts/prepare-forest-ribbons.mjs`,
  `js/forest-ribbon-assets.js`). Both frontiers cover every source blade once
  while sharing the original 60B vertex records, materials and source IDs;
  GPU selection refines from two-triangle ribbons to four-triangle blades when
  projected geometric error exceeds `ribbonErrorPixels`.
  The runtime loader verifies full source membership without fetching the
  original whole-tree vertex/index/AO buffers, and supports geometry-only
  offline loading without PNG decode overhead. Explicit review permission is
  required before loading unqualified assets.
- GPU projection, hysteresis, parent-or-children coverage, frustum culling,
  serial and parallel index compaction (`--compaction parallel`), per-pixel
  shared lighting (`--shading pixel`) with exact MSAA coverage, and indirect
  draws. Static geometry uploads once. JavaScript
  handles initialization, asset I/O and review controls, not frame-loop
  geometry/visibility work. Synchronous readback exists only in this diagnostic
  fixture for counters and timestamps.
- Optional 2/4/8-cell depth-grid meshes reconstruct source capture depth in
  vertices, with no fragment-depth output or fragment ray iterations. This
  tests early-depth rejection against the original billboard path. Both remain
  unqualified; fewer fetches do not establish image likeness.
- A reference policy validates ownership, dependencies, rendered applicability,
  resident child cover and combined pass budgets. Its JavaScript chooser is a
  test/reference implementation, not the game renderer.
- Identical GPU root placements for individual trees and bounded edge/dense
  mixed stands. Native reference geometry loads only in the explicit review
  tool. Capture, image comparison and cost receipts are repeatable.

## Reproduce

Run from the canonical checkout. Use fresh output directories. Mature source
assets are reused; no biological tree growth is required. The capture tool reads
and hashes the original bake shader from the sibling Forestmodeler repository.

```sh
node scripts/prepare-forest-wood-lods.mjs \
  --pack assets/forest-scenery/saba --out /tmp/forest-wood-FRESH \
  --prototype 0,2 --meshoptimizer-module /tmp/waterworld-meshopt-tools/node_modules/meshoptimizer

node scripts/bake-forest-lod-pilot.mjs \
  --pack assets/forest-scenery/saba --out /tmp/forest-clusters-FRESH \
  --prototype 0,2 --max-leaves 128,512 --tile-pixels 32 --encoding rgba8 \
  --playwright-module /Users/alexwall/dev/waterworld/node_modules/playwright/index.mjs \
  --browser-executable '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

node scripts/prepare-forest-inspection.mjs \
  --pack assets/forest-scenery/saba --out /tmp/forest-inspection-FRESH \
  --prototype 0,2 --nodes-per-page 64

node scripts/prepare-forest-ribbons.mjs \
  --inspection /tmp/forest-inspection-FRESH --out /tmp/forest-ribbons-FRESH

node scripts/review-forest-lod-pilot.mjs \
  --pilot /tmp/forest-clusters-FRESH --wood /tmp/forest-wood-FRESH \
  --inspection /tmp/forest-inspection-FRESH --ribbons /tmp/forest-ribbons-FRESH \
  --shading pixel --compaction parallel --out /tmp/forest-review-FRESH

python3 scripts/compare-forest-lod-pilot.py /tmp/forest-review-FRESH --strict
```

The local meshoptimizer path must contain the already pinned version; the helper
checks its version/receipts. Image comparison requires Pillow and NumPy.
`--stand edge|dense` reviews fixed mixed stands. `--serve 1 --port 8091` keeps the
whitelisted local review server open instead of launching an automated capture.
`--grid 2|4|8` selects the optional source-depth mesh.
`FOREST_PILOT_CASES` accepts a JSON list of camera/control cases. `--layers 2`
retains a rejected paired-capture diagnostic; it is not the selected default.

The review uses actual framebuffer dimensions, native Metal Chrome, matched
Lambert/ambient source lighting and physical MASK sampling. It does not reproduce
the game's filtered fractional coverage, PBR/weather lighting, wind or shadows.
Candidate-only timing iterations exclude the native comparison draw. Counts
include every selected woody/leaf stage; contiguous GPU intervals are not sums
of overlapping pass spans. Reports retain raw counts and qualification status.

## Promotion gate

Recorded October23 comparisons on native Metal Chrome at1024×900, four MSAA
samples, isolated source Lambert lighting:

All 75 focused regressions pass, serialized by root: source partitioning, woody
authoring, inspection export/transport, curved source ribbon reduction, offline
preauthored ribbon assets, ownership/residency/budget policy, serial/parallel
GPU compaction, pixel-depth coverage and four actual Metal GPU modes (billboard
and 2/4/8-cell meshes). The GPU fixtures
verify parent-or-complete-children selection, counter reset, nonzero root
instances, multiple original materials, rendered pixels and hard mixed-frontier
budget rejection. Log: `/tmp/waterworld-forest-lod-checkpoint-tests.log`.

Preauthored ribbon dense-stand run (`--stand dense --shading pixel --compaction parallel --ribbons /tmp/waterworld-forest-ribbons-pilot-1`, `preparationMs = 0`):

| Case | Submitted triangles | Candidate-only GPU median | Candidate-only GPU p95 | Finite support/coverage gate |
|---|---:|---:|---:|---|
| Dense stand, 250 m (`dense-far`) | 208,054 | 1.64 ms | 2.30 ms | Pass (0 px >3px) |
| Dense stand, 100 m (`dense-middle`) | 1,051,198 | 3.25 ms | 8.04 ms | Pass (0 px >3px) |
| Dense stand, 55 m (`dense-near`) | 2,058,272 | 4.77 ms | 11.99 ms | Pass (0 px >3px) |
| Dense stand, 100 m, 60° (`dense-aerial`) | 1,041,632 | 3.39 ms | 9.93 ms | Pass (0 px >3px) |
| Dense stand, 100 m, low sun (`dense-low-sun`) | 1,046,624 | 3.00 ms | 4.45 ms | Pass (0 px >3px) |

Earlier baseline modes before preauthored hybrid ribbons:

| Case | Submitted triangles | Candidate-only GPU p95 | Finite support/coverage gate |
|---|---:|---:|---|
| Twelve-tree stand,250m, billboards |59,400|1.04ms|Pass|
| Same stand,100m |96,068|8.01ms|Fail|
| Same stand,55m |908,640|10.86ms|Fail|
| Oak,45m,4-cell depth mesh, fixed fine tier |50,346|0.85ms|Fail|
| Birch,25m, tighter original-leaf refinement |77,092|2.44ms|Pass|

These are different diagnostic cases, not a whole-island or controlled release
speedup claim. The identical twelve-tree native reference submits4,012,194
triangles. While preauthored hybrid ribbons + pixel shading pass all five saved
finite image gates (`allFiniteImageGatesPassed: true`) with zero runtime
reduction overhead, the dense-stand p95 GPU intervals still exceed the 4ms
pilot target on middle, near and aerial views. No tested
configuration passes every required gate. Do not promote either experiment by
loosening the ceiling or hiding those failures.

Receipts/screenshots: `/tmp/waterworld-lod-pilot-authored-1/`,
`/tmp/waterworld-lod-pilot-dense-2/`,
`/tmp/waterworld-lod-pilot-review-13/`,
`/tmp/waterworld-lod-pilot-grid-1/`,
`/tmp/waterworld-lod-pilot-grid-2/`, and
`/tmp/waterworld-lod-pilot-edge-1/`. Newer captures snapshot and hash served code
and source manifests. The image tool records fractional coverage, binary
support errors, displayed RGB error and its finite-view limitations.

The woody source targets were18k/5k/600 triangles. Oak produced
17,578/4,399/**630** (last target missed); birch16,156/4,861/514. Inspection
retains303,852 original oak leaf triangles and76,320 birch leaf triangles across
separate branch pages; offline ribbon authoring (`prepare-forest-ribbons.mjs`)
reduces those to151,926 oak triangles (564,153B gzipped,2.90cm bound) and
38,160 birch triangles (141,688B gzipped,0.83cm bound) while retaining every blade.
Retaining all of them in view is explicitly not the
production solution.

No regional rebake/default replacement until appearance and cost pass together.
Passing a finite three-pixel support check does not qualify untested view cones,
continuous camera motion, lighting, inside views or a different framebuffer.
The default loose threshold and paired-capture experiment still exposed canopy
loss and silhouette errors; neither is production-qualified.

Remaining for full multi-tier stand replacement: qualified branch appearance
envelopes, transition motion, varied lighting/wind, stand likeness/cost, GPU
scene-wide refinement priorities, coarse/base cover, demand page
residency/eviction, merged stand tiers, shadows, Retina and physical
iPhone/full-game measurements. The pilot currently loads selected specimen
pages eagerly; paged files alone do not establish demand streaming. Exporter
feedback to Forestmodeler follows qualification.

## Five-species Saba native LOD sidecar and runtime integration

`scripts/prepare-forest-native-lod.mjs` now bakes all five Saba species
(`0: oak`, `1: maple`, `2: birch`, `3: elm`, `4: chestnut`) from the verified
native vertex/index streams into `assets/forest-scenery/saba/lod/manifest.json`
and `assets/forest-scenery/saba/lod/lod-indices.bin.gz` (`6.70 MB` gzipped,
`11.79 MB` raw, `3,091,170` `Uint32` indices):
- Exact two-triangle leaf ribbons for every 4-triangle source leaf sheet across
  all five species (`50.0%` leaf index reduction with every blade retained; max
  support error `1.54–3.21 cm`).
- Three topology-preserving woody branch LOD tiers (`wood0`, `wood1`, `wood2`)
  referencing the original native vertex stream (`maxErrorMeters` `4.1–8.0 cm`
  for `wood0`, `7.1–11.7 cm` for `wood1`, `11.0–15.6 cm` for `wood2`).
- `js/forest-native-lod.js` and `js/forest-scenery.js` load and verify the
  sidecar digest and wire native sub-tiers (`native-near`: `wood0` + leaf
  ribbons, `native-mid`: `wood1` + leaf ribbons, `native-far`: `wood2` + leaf
  ribbons) into the GPU classifier while retaining `forestNativeLod=off` as an
  exact A/B fallback.
- On the exact failing `reported-close-view` (`1920x1080`), total indirect
  triangle submissions drop from `1,338,730,820` (`1.34B`) to `421,201,253`
  (`421.2M`, a **3.18x reduction**) with `0` pixel differences (`maxError: 0`)
  against baseline.
