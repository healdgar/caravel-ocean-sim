# Native Forestmodeler forest

The Saba forest package contains **85,451 roots** using five shared, immutable
native Hero prototypes. Fine Wells Bay terrain rejects 401 sites, leaving
**85,050 resident roots**. These temperate species are visual proxies, not
surveyed Saba flora.
Source authority is Forestmodeler's installed `NativeModelCatalog.json`, verified
mature USDZs, `TreeSurfaceCatalog.json` and embedded `gene-surfaces-v3` maps.

| Species | Catalogued age | Source asset |
|---|---:|---|
| Oak | 60 | `oak_mature60_hero.usdz` |
| Maple | 50 | `maple_mature50_hero.usdz` |
| Birch | 25 | `birch_mature25_hero.usdz` |
| Elm | 65 | `elm_mature65_hero.usdz` |
| Chestnut | 70 | `chestnut_mature70_hero.usdz` |

Original growth engine: `0504005de09ccd3693aa2a84dd8dd820`. Catalog rows,
growth identities, USDZ hashes, source point/normal/UV/index receipts and embedded
PNG hashes remain in the provenance. Conversion does not regrow trees or relabel
their growth as current. Earlier age-24 scenery prototypes are not these assets.

## Geometry, materials and placement

The converter extracts source USD triangles and bindings. Its inverse coordinate
swizzle lets the existing GLB writer's node restore Y-up metres. The importer
applies that node once, retaining indexed wood, roots, wounds and individual
folded leaf cutouts. Normals follow the existing transformed-normal normalization
contract. No scenery-shell culling, enlarged cards or near-mesh substitution occurs.

Native albedo, normal and optional roughness PNGs retain their original bytes.
Albedo is sRGB; normal/roughness are linear data. Metadata preserves wrap,
roughness, clearcoat, leaf underside, transmission and opacity threshold.
Transmission is separate from opacity. Birch has no source wound mesh/material;
no substitute wound map is manufactured.

`waterworld.forest-instances` v2 uses **14 Float32 values / 56 bytes per vertex**:
position, normal, kind, shade, UV, linear RGB factor and native material index.
The index identifies the actual GLB material slot; leaf pigments come from maps.
A root uses **12 Float32 values / 48 bytes**: collar position, uniform scale,
yaw, linear RGB tint, prototype ID, collar sink and two reserved values.

Deterministic planting requires elevation 18–840 m, slope ≤1.1, vegetation-mask
byte ≥96, valid coastal crown rims and crown-relative spacing. Native planting
uses a **3 m candidate grid** and minimum stem separation of **0.32 times the
summed, individually scaled maximum horizontal foliage radii**. Legacy defaults
remain 6 m and 0.65. Maximum radii include sparse outlying branches; closer stems
overlap interior foliage without modifying native geometry. This authored
stand-density policy is not a competition growth simulation. The 250,000-root
limit fails rather than truncating eligible roots. Roots are seated once on rendered
terrain triangles, including Wells Bay's near tile. Invalid newly resolved sites
are rejected. The old 42-tree rectangle is not excluded from native planting.

When the native forest is resident, **all generic tree models and the old
42-tree stand are disabled**. They remain load-failure fallbacks. Low-probability
bare/coastal outliers are not converted into forced native trees. Grass,
boulders and terrain remain separate.

## GPU rendering and distance representations

Prototype geometry is shared across roots. Uploaded root and prototype buffers
remain immutable. GPU compute culls bounds, selects representations and compacts
visible IDs; indexed indirect draws reuse those buffers. Camera movement causes
no CPU vertex deformation or repeated tree-geometry upload.

Distance atlases use the exact native wood/leaf ranges and maps. Each species
has **256 full-sphere octahedral views**: a 16×16 grid of 64-pixel tiles in two
1024² RGBA16Float atlases. Baking captures at 2× resolution with MSAA4, then GPU
area-averages 2×2 pixels: 16 samples per final pixel. One atlas stores
premultiplied linear albedo/coverage; the other stores premultiplied local
normals/front depth. Depth reconstruction and view interpolation approximate
the native tree's volume.

The initial **32-rendered-pixel** impostor switch is an authored policy,
**not an appearance-error certificate**. Native rendered comparisons remain
required before calling the transition imperceptible. `forestImpostorPixels`
adjusts that policy; `forestImpostor=off` and `forestImpostor=force` support
comparison. Atlas alpha, colour, depth and lighting error are not bounded by
the old geometric 3-pixel criterion.

Forestmodeler's existing `_build_opaque_crown_dome` also generates each tree's
coarse far fallback from its extracted foliage, with a function hash. Colour
integrates the source albedo. This explicitly approximate fallback uses material
sentinel −1 and recorded coarse RGB; it requires whole support within 3 rendered
pixels. It is distinct from the detailed native model and depth atlas.

## Loading, compression and offline scope

Landfall loading brings in roots and atlases first. Detailed native geometry
and maps load in the background; close representations become available after
their resources are ready. Native map families retain exact source dimensions.

The authoring package `/tmp/waterworld-mature-dense-runtime-230` contains
**107,085,210 bytes**, including catalogs, receipts and inspection
images. This total is not the first-load network cost.

| Buffer | Original bytes | Stored gzip bytes |
|---|---:|---:|
| Vertices | 188,946,072 | 78,658,880 |
| Indices | 34,786,680 | 13,716,582 |
| Roots | 4,101,648 | 2,477,736 |
| **Geometry total** | **227,834,400** | **94,853,198** |

The two close-geometry buffers require **92,375,462 compressed bytes**
(92.4 MB, 88.1 MiB), plus native material maps. Ten normative atlas gzip files
total **3,474,888 bytes**; decoded atlas data is 80 MiB. Inspection PNGs and
provenance files are not all fetched at runtime. Denser planting changes roots
and source receipts; native vertex/index buffers, PNGs and atlas gzip bytes
remain unchanged.

`manifest.files` retains decoded byte counts and SHA-256 hashes, adding
`gzip: {file, bytes, sha256}` transport receipts. The loader verifies compressed
bytes, decompresses and verifies decoded bytes. Packaging changes no geometry,
UV, indices, maps or native material values. Large raw buffers/atlases are
omitted from runtime assets. `manifest.impostors` receipts the packaged atlas
manifest. Original forest/atlas manifests remain as provenance; the atlas's
source identity refers to the precompression forest manifest, recorded in
`runtimePackaging.sourceManifest`.

Pages serves versioned assets. Downloadable HTML embeds core assets, roots,
forest atlases and native maps. Its **two native close-geometry buffers use
versioned absolute Pages URLs**: base64 embedding would exceed GitHub's 100 MB
file limit. Core simulation and forest atlases work offline; full native close
geometry requires network access. Downloads are not entirely self-contained.

## Rebuild and validation

Run from Waterworld; adjust output directories to fresh paths. The converter
and atlas baker live in the sibling Forestmodeler repository. Input is the
installed mature catalog; no growth bake is needed.

```sh
uv run --directory ../forestmodeler --with usd-core python \
  scripts/convert_waterworld_mature_prototypes.py \
  --out /tmp/waterworld-mature-hero

uv run --directory ../forestmodeler python \
  /absolute/path/waterworld/scripts/prepare-forest-instances.py \
  --native-dir /tmp/waterworld-mature-hero \
  --region /absolute/path/waterworld/assets/world/saba \
  --spacing 3 --crown-spacing-factor .32 --max-roots 250000 \
  --output /tmp/waterworld-mature-forest

node ../forestmodeler/scripts/bake_waterworld_impostors.mjs \
  --pack /tmp/waterworld-mature-forest \
  --out /tmp/waterworld-mature-impostors \
  --playwright-module /absolute/path/waterworld/node_modules/playwright \
  --hemisphere full --compression gzip

node scripts/prepare-forest-runtime.mjs \
  --pack /tmp/waterworld-mature-forest \
  --atlases /tmp/waterworld-mature-impostors \
  --output /tmp/waterworld-mature-runtime
```

The importer and packager neither render nor grow anything. The atlas baker
uses WebGPU. Packaging stages a fresh directory, verifies stored/decoded hashes
and renames atomically. Copy the runtime pack into `assets/forest-scenery/saba`,
retaining nested `impostors`; build and rendered qualification follow separately.

Root executed mature conversion (211), denser native import (228), the complete
full-sphere atlas bake (229) and packaging/integrity checks (230). These local
receipts establish lineage and bytes, not publication, device frame rate or a
certified rendered transition.

Focused fixtures were authored for:

- Native USD geometry, original PNGs, singular `wound` binding, catalog identity
  and rejection of regrowth/remeshing substitutes:
  `../forestmodeler/tests/test_waterworld_mature_prototypes.py` (pytest).
- Native import, explicit material indices, exact maps, rejection of altered
  sources, mature ages and original provenance: `tests/forest-native-import.test.py`.
- Deterministic denser planting, unchanged site exclusions/prototypes, root
  layout and failure rather than budget truncation: `tests/forest-instances-import.test.py`.
- Lossless deterministic gzip, decoded hashes, materials, source mismatches
  and fresh-only output: `tests/forest-runtime-package.test.mjs`.

Authorship is not a passing test result. Root owns execution and records actual
test/build/browser results separately. Appearance, performance, download
behavior and deployed bytes still require final qualification.
