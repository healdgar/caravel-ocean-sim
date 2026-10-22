# Baked canopy scenery

**Status:** integrated source, unpublished; actual rendered/full-regression and
release qualification remain pending. The published nine-ship receipt in README
does not establish qualification of this scenery integration.

## Scope

The existing Forestmodeler Saba export contains **42 trees in an 80 × 80 m
rectangle**, not a forest for the whole island. Its five species labels are fir,
oak, birch, elm and maple: temperate demonstration taxa, not Saba flora. The source
domain is X −96…−16 m, Z −5904…−5824 m in the game's Y-up world frame.

Imported geometry replaces procedural tree roots inside that rectangle only.
Outside roots, grass, boulders, terrain, island starts and Wells Bay remain in
their existing paths. There is no stand tiling, regional growth, new tropical
species library or forest-interior depth atlas.

## Import and provenance

`scripts/prepare-canopy-scenery.py` converts an existing
`waterworld.canopy-scenery` v1 export into `waterworld.canopy-runtime` v1.
It reads the source canopy GLB, opaque/cutout streams, instances and registered
terrain; it does not grow trees, render or download scenery. NumPy and SciPy are
required. Defaults select the sibling Forestmodeler Saba export and write
`assets/canopy-scenery/saba/`; overwriting requires `--force`.

```sh
uv run --directory ../forestmodeler python ../waterworld/scripts/prepare-canopy-scenery.py
uv run --directory ../forestmodeler python ../waterworld/tests/canopy-import.test.py
```

The importer verifies 3 mm collar-height registration and records surviving basal
stems' horizontal offsets and actual terrain clearances. A multi-stem tree may
retain one offset trunk; its biological seed need not lie inside the surviving
wood. Nearest same-genome assignment and the declared plant envelope check
seating correspondence, not biological parent identity or every wood-ground contact.

The pack retains source manifests/region, original instance bytes and a provenance
ledger with source-file and terrain byte hashes. The current generator checkout
is dirty; its recorded HEAD, status and selected source hashes describe inspection
time. They are **not the missing fingerprint of the earlier bake**, and do not
prove that rerunning today's generator reproduces those assets.

The canopy GLB supplies species-specific bark/foliage material factors already
in linear colour. It supplies **no images or leaf-alpha texture**. The importer
maps those factors onto matching native geometry without another sRGB conversion.
The existing Waterworld foliage image supplies alpha only; its RGB does not
replace the imported material colours. This alpha choice remains an explicit
appearance approximation.

| Runtime stream | Contents |
|---|---|
| `near.bin` | Actual detailed GLB branch/trunk wood |
| `leaf.bin` | Matching native cutout foliage |
| `far.bin` | Source opaque crown domes and coarse trunks |
| `instances.bin` | Original metadata; not reapplied to baked world geometry |

Draw vertices use 13 Float32 values: XYZ, normal XYZ, kind, shade, UV and linear
RGB, 52 bytes total. Complete triangles are partitioned into 128 m draw patches;
each patch records explicit stream ranges, complete bounds and geometric error.
The runtime verifies stream SHA-256 receipts, layouts, finite values, classifications,
draw-range partitioning and containment before replacing procedural roots.

## Rendering and LOD

`bakedCanopyVS` consumes absolute world vertices once. It does not apply the
procedural tree instance's root, scaling, yaw or wind bend. Opaque wood/crowns
draw before cutout foliage; the opaque fragment has neither discard nor leaf
texture sampling. Cutout RGB remains source linear colour. Both paths receive
terrain's cached Sun/Moon visibility, sky light, atmosphere and volumetric clouds.
Imported trees remain static; this integration adds **no canopy shadow caster**.

The importer bounds geometric difference in both directions between detailed
wood/leaf triangles and far triangles. For each triangle, distance to one chosen
vertex on the opposite representation is bounded by the largest distance from
its three vertices. Taking the maximum in both directions gives a conservative
whole-triangle bound, not a point-sampling estimate. It excludes alpha holes,
colour, lighting and unsupported deformation.

Projection uses actual render height, field of view, forward depth, patch radius
and off-axis magnification. Hysteresis enters simplification below **2.64 pixels**
and retains it only at or below **3 pixels**; CSS resolution and fixed distance
bands do not define the threshold. Near-plane or unsupported projections retain
detail. An alpha texel's measured world span describes sampling, not silhouette
or appearance reconstruction error.

This pack has **no certified alpha/silhouette error bound**. Default `auto`
therefore retains detailed wood and cutouts unless the complete union support
of near and far geometry projects to at most three pixels. All potential alpha
or silhouette differences then lie within that small support; colour difference
is still unbounded. The geometry bound alone does not authorize a normal far swap.

## Loading and inspection

The loader runs only inside the landfall terrain factory. Pages does not preload
the canopy pack for open-ocean startup; standalone downloads still embed their
self-contained assets. Manifest/stream/hash failure retains all procedural roots
and records a diagnostic in `terrain.canopyStats`. GPU creation failures propagate
rather than silently claiming a successful import.

| Query | Behaviour |
|---|---|
| `canopy=auto` or omitted | Conservative automatic policy above |
| `canopy=near` | Force detailed wood and cutouts |
| `canopy=far` | Explicit **uncertified** opaque preview, bypassing LOD gates |
| `canopy=off` | No canopy fetch/allocation; retain existing procedural forest |

`terrain.canopyInspectionURL` provides a shareable free-camera link around the
actual imported bounds, using ordinary `cam` query values and `canopy=near`.
It preserves an existing landfall stage, ship/fleet choices and boat coordinates;
an absent stage defaults to Approach. It does not relocate boats onto the summit
or replace the Wells Bay approach. `canopyStats` reports source trees, selected
patches, triangles, replaced procedural roots and unsupported appearance bounds.

Physical-device performance, dense tropical regional coverage, animated imported
wind response, cast forest shadows and appearance-certified stand transitions
remain separate work. No new test-pass or publication receipt is claimed here.
