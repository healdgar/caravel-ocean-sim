# Native-derived forest mass

**Architecture status (October 23):** this documents the current implementation
and its evidence. The replacement tier/streaming architecture is specified in
[Forest rendering redesign](FOREST_LOD_PLAN.md); it is not implemented here.

The forest has three representations of the same planted roots: detailed native
trees close, reduced individual trees between, and a shared opaque foliage mass
farther away. The mass comes from actual native leaf triangles and their original
MASK textures. Neither coarse crown domes nor individual transparent atlases
define its geometry.

This is an **authored optical approximation, not a certified three-pixel match**
to native foliage. Local stand comparison 267 fails many strict three-pixel
silhouette / 20% coverage witnesses. The runtime projects a recorded sampling
footprint; that is not a measured bound on all appearance differences.

## Source authority

The five sources are Forestmodeler's installed mature Hero USDZs and embedded
`gene-surfaces-v3` materials: oak 60 years, maple 50, birch 25, elm 65 and
chestnut 70. Their original growth-engine identity remains
`0504005de09ccd3693aa2a84dd8dd820`. These temperate trees are visual proxies,
not surveyed Saba vegetation.

`convert_waterworld_mature_prototypes.py` transports the existing native meshes,
UVs, indices and PNGs into the native pack. It does not simulate growth.
The new cache stores **render fields derived from those finished meshes**;
it is not a recovered growth checkpoint or a new biological simulation.
Original catalogs, asset hashes and native material/map receipts remain authority.

## Continuous fields and assembly

`scripts/prepare-forest-fields.py` verifies the native pack's original wood/leaf
index ranges and PNG receipts. Only leaf surface area contributes to its field.
Deterministic adaptive barycentric quadrature samples original UVs, applies each
material's bilinear source MASK cutoff and weights samples by true triangle area.
PNG sRGB is decoded before interpolation; stored linear vertex RGB is applied once.
No source tree is fitted to a radius, regrown, thinned or replaced by a dome.

Each species has an NPZ containing:

| Key | Meaning |
|---|---|
| `originXYZ` | Float64 centre of voxel `[0,0,0]`, Y-up metres |
| `cellMetres` | Float64 scalar; 0.25 m in cache 260 |
| `density[x,y,z]` | Float32 opaque one-sided render-proxy area per volume, m²/m³ |
| `rgbMoment[x,y,z,3]` | Float32 linear RGB multiplied by density |

Cache 260 uses a 0.30 m geometric quadrature edge, with mixed-MASK patches
refined to 0.075 m. The earlier 0.15 m request exceeded the explicit 40-million
patch limit and failed rather than thinning. Terminal MASK-boundary area remains
reported uncertainty; those conservative intervals can be broad.

A normalized separable Gaussian uses sigma 0.35 m and truncation 3. At this
lattice its support is a box extending 1 m per axis, or 1.732 m to a corner;
it is not a 1.05 m radial cutoff. Deposition/interpolation and quadrature support
are recorded separately. Recipe 1's maximum combined footprint is
2.647449898511305 m. No component filtering, morphological closing or hole
filling occurs in this cache.

`scripts/prepare-forest-mass.py` transforms continuous fields to the actual root
positions, yaw, scale and tint, **adds** overlapping density and RGB moments, then
extracts one isosurface. Uniform scale `s` divides density and RGB moments by `s`,
so integrated leaf area scales as `s²`; root tint affects RGB moments once.
Surface pigment is the interpolated RGB moment divided by density.

This is **rendered proxy area**, not biological leaf area. Forestmodeler's card
tiers carry a `2/opaque_fraction` representation factor. These fields never feed
growth, carbon, biomass or ecological light calculations.

Region 268 uses a shared 2 m world lattice, density level 0.08 m²/m³ and
128 m ownership blocks. Neighboring roots contribute through complete field
halos. Shared-lattice triangle ownership partitions block boundaries without
inventing foliage caps. Root ownership and conservative neighbor lists govern
handoff to individual representations; an unresolved neighboring block prevents
suppression of the whole individual tree.

Root-collar sink and exclusions use the same rendered coarse terrain and fine
Wells Bay triangles as the native renderer. Of 85,451 planted roots, 85,050 remain
resident and 401 are excluded. Fully buried mass faces are omitted; crossing
faces remain depth-occluded by terrain. The compiler does not manufacture a green
flat bottom or copy terrain colour into foliage. It reuses the old compiler's
terrain/seating helpers, not its crown geometry.

The intermediate prototypes use the individual density surfaces plus original
woody membership clustered in 0.15 m spatial cells, separately per source
material. Their bark pigment comes from original maps. These are reduced render
meshes, not unchanged native geometry. The current middle refinement is below.

## Local authoring measurements

These are completed local checkpoints, not publication or device frame-rate proof.

| Checkpoint | Result |
|---|---|
| Native fields 260 | Five caches in 27.44 s; NPZ data 7,844,601 bytes |
| Region assembly 268 | 537 blocks in 100.37 s; 85,050 resident roots |
| Unsimplified mass | 8,757,877 vertices; 16,889,295 triangles |
| Five intermediate prototypes | 85,322 triangles total |
| Lossless transport 270 | 8.69 s; sizes below |

Mass v2 stores 24-byte vertices: unchanged reconstructed Float32 world positions,
snorm8 normals and Float16 linear RGB. Normals are renormalized on the GPU.
This packing quantizes shading attributes; it does not move mesh positions.
The intermediate stream retains the existing 52-byte vertex layout.

| Stream | Decoded bytes | Transport bytes, checkpoint 270 |
|---|---:|---:|
| Mass vertices | 210,189,048 | 97,806,735 |
| Mass indices | 202,671,540 | 36,650,318 |
| Root ownership | 341,804 | 91,407 |
| Root neighbors | 1,367,216 | 138,805 |
| Intermediate vertices | 2,702,440 | 1,398,654 |
| Intermediate indices | 1,023,864 | 169,358 |
| **Streams total** | **418,295,912** | **136,255,277** |

These unsimplified regional assets remain substantial. The table excludes the
manifest, source native assets and other scene resources. Source close geometry
is another 223,732,752 decoded bytes / 92,375,462 gzip bytes, plus roots and
native maps; close resources can load in the background. Authoring time is not
browser startup time, and offline generation is not per-frame simulation.

`scripts/compress-forest-mass.mjs` uses pinned meshoptimizer 1.3.0 to encode
attributes and index sequences, then gzip. It decodes and byte-compares every
encoded stream before publishing the fresh directory. It applies no codec
filters, geometry reduction or index reordering. Manifest decoded receipts remain
unchanged; separate `meshopt` and `gzip` receipts describe transport. Loader
validation verifies encoded, intermediate and decoded bytes.

## Runtime and appearance limits

Immutable shared buffers hold native, intermediate and mass geometry. WebGPU
compute selects blocks/roots and prepares indirect draws. Camera movement does
not trigger CPU tree deformation, remeshing or repeated vertex uploads.

The automatic switch projects the authored support footprint using actual
viewport height, FOV, near bound and off-axis angle. Its threshold is at most
three rendered pixels, with hysteresis to limit switching. This calculation
bounds the **declared footprint**, not native leaf alpha, colour, topology or
lighting error. Explicit debug/startup previews are separate policies.

The opaque density surface can alter crown holes, fine branches and coverage.
Gaussian smoothing and the isovalue can expand, merge or shrink features even
when source positions and pigment are faithful. Front pigment is retained;
view-dependent underside response, leaf transmission, fine normal maps, wetness
and native self-shadowing are not reproduced by one opaque vertex-coloured shell.
Wind is not baked. The representation therefore needs rendered comparison at
intended approach distances and performance checks on real devices.

Comparison 267 rendered an actual stand with 341 owner and 253 halo roots,
16 native capture views and eight held-out views. Its strict witnesses are
recorded in `/tmp/waterworld-native-mass-review-267/mass-review.json`; many fail.
Do not relabel finite passing views, source hashes or the footprint projection
as global visual certification. Neither manifests 268/270 nor this document
establish a released checkpoint.

## Earlier integration review — superseded coastal cost

The installed candidate uses the original compact mesh plus exact transport
(checkpoint270). Source and packaged Pages builds render the horizon and approach
views with537 selected mass blocks. Three source views and two packaged views
completed without GPU/device errors. Local startup took4.7–5.0seconds on this Mac;
that is loopback loading, not a public-network or iPhone measurement.

The earlier coast was **not release-ready**. At1280×900 in visible-scene settings with
wind/waves/clouds disabled, headless Metal measured2.35FPS:8,108 original Hero
trees submit3,383,970,921 native triangles, plus40,344 middle trees submitting
498,152,759 triangles. The forest's buffers alone occupy647,218,092bytes.
The distant views' roughly118 uncapped frames/second do not establish the
ordinary game's60FPS target. Receipts: `/tmp/waterworld-native-mass-scenes-279`
and `/tmp/waterworld-native-mass-package-scenes-288`.

This measured the missing intermediate representation, subsequently addressed
below. Public assets remain unchanged.

An offline seam-locked simplifier was also exercised. It preserves surviving
position/normal/colour records and exact shared spatial seams, removes only
reported exact-zero-area faces, and retains original geometry if seam/attribute
checks fail. Region287 reduced16,889,295triangles to16,397,951 (2.9%), with no
fallback chunks. This small saving does not solve coastal cost; **that reduction
is not installed**. Its error estimate is not a native appearance certificate.

## Native lighting and field-shaded middle refinement

`prepare-forest-light.py` bakes five-ray own-canopy escape at the original native
vertex addresses. The neutral GPU storage record is 32 bytes, respecting WGSL
struct alignment. Native positions, UVs, normals and material maps remain exact.
Own-canopy exposure affects ambient and direct response; terrain/cloud lighting
still changes normally. This static exposure is not a directional shadow map.

Hardware alpha-to-coverage was giving small overlapping leaf primitives matching
MSAA masks. `forestNativeLeafFS` now rotates explicit sample masks with stable
original primitive/root/pixel hashes. A 25% layer remains 25%; four independent
layers measure about 68%, rather than remaining 25%. The expected independent
union is 68.36%. Perfectly correlated/complementary binary masks cannot be
reconstructed from averaged mip alpha; the tests retain that limitation.

`prepare-forest-volume.py` packages source density/pigment moments as x-fastest
RGBA16F and own-canopy escape as R8. Five immutable fields total 20,045,772
decoded texture bytes. A bounded box raymarch remains a diagnostic: it improved
the coast to only 7.68 FPS because overlapping rays remained expensive.

The default middle uses an **actual source-density surface**, not a box or crown
dome. `simplify-forest-middle.mjs` preserves surviving 52-byte records and changes
indices only, separately reducing wood and leaf ranges. Pinned meshoptimizer
1.3.0 reports at most 0.35 m error; triangle targets never override that cap.
The `field` leaf profile drops normal/pigment attribute weights because the GPU
resamples them from the original field. Wood retains its shading weights.

| Prototype | Wood triangles | Leaf triangles | Total |
|---|---:|---:|---:|
| Oak | 1,056 | 588 | 1,644 |
| Maple | 826 | 512 | 1,338 |
| Birch | 254 | 512 | 766 |
| Elm | 1,100 | 642 | 1,742 |
| Chestnut | 1,787 | 638 | 2,425 |

The ordinary opaque raster supplies silhouette and depth. Six interior samples
recover density-weighted source pigment/exposure, six density samples recover
lobe normals, and four short sun samples add local extinction. No fragment-depth
override, transparent blending, per-frame CPU geometry or GPU readback occurs.
Middle wood and foliage share the same GPU-compacted root IDs. Missing or invalid
optional fields/reduction fall back explicitly; stats retain the error.

The middle policy projects the voxel sampling footprint plus reported reduction
error through actual framebuffer pixels, FOV and nearest/off-axis depth. Far
mass retains its previous support estimate and ownership policy. These remain
**authored approximation estimates**, not native appearance certificates.

Local Metal results at 1280×900, wind/waves/clouds/ships/crew disabled:

| View | Source FPS | Packaged FPS | Selected mass blocks |
|---|---:|---:|---:|
| Approach | 122.1 | 122.1 | 537 |
| Coast | 57.1 | 54.5 | 167 |

The coast now selects two native roots and 48,368 middle roots. Forest buffer
storage is still 647,238,968 bytes, plus the new field textures. Packaged startup
was 5.52–5.99 seconds over loopback. These finite static views do not establish
ordinary-game, native Retina or iPhone frame rate. Close terrain remains a
separate quality issue. Source receipts: `/tmp/waterworld-forest-shell-scenes-313`;
packaged receipts: `/tmp/waterworld-forest-shell-package-316`.

Combined regression 315 passes 63 loader/material/build/GPU checks; Python run
317 passes ten lighting/volume fixtures. The strict native appearance witnesses
267 remain unqualified. No release or global 3-pixel likeness claim follows.

Forestmodeler now receives portable render-field/surface modules and a Three.js
adapter, documented in its `docs/FOLIAGE_LOD.md`. These reuse finished mature
meshes and caches without regrowing trees or changing biological quantities.

## Reproduce bounded checkpoints

Use fresh output directories and an existing mature native pack. Run authoring
serially in the Forestmodeler NumPy/SciPy environment; no growth command is needed.
Adjust repository paths and the pinned meshoptimizer installation path.

```sh
uv run --with numpy --with scipy --with pillow --with scikit-image python \
  /absolute/path/waterworld/scripts/prepare-forest-fields.py \
  --pack /tmp/waterworld-mature-dense-forest-237 \
  --quadrature-edge-metres .3 --output /tmp/forest-fields-fresh

uv run --with numpy --with scipy --with pillow --with scikit-image python \
  /absolute/path/waterworld/scripts/prepare-forest-mass.py \
  --pack /tmp/waterworld-mature-dense-forest-237 \
  --fields /tmp/forest-fields-fresh \
  --region /absolute/path/waterworld/assets/world/saba \
  --cell-metres 2 --level .08 --output /tmp/forest-mass-fresh

node /absolute/path/waterworld/scripts/compress-forest-mass.mjs \
  --pack /tmp/forest-mass-fresh --output /tmp/forest-mass-transport-fresh \
  --meshoptimizer /absolute/path/meshoptimizer-1.3.0
```

Add `--species oak` for an isolated field proof. The region assembler requires all
five caches; `--stand X Z` limits its output to a 128 m witness before a regional
bake. Input hashes, native material receipts, field parameters, terrain receipts,
ownership and compiler identities are preserved in the output manifests.
Installation, rendered qualification, builds and deployed-byte verification are
separate steps owned by the integration workflow.
