# Woodland & Landfall Scenery Bridge (`../forestmodeler`)

This document records the architectural contract between **Ocean Sailing Simulator**
(`waterworld`) and the neighboring botanical growth & terrain-scenery engine in
`../forestmodeler` (`gardenplans`). It is written for agents working on
`LAND_SYSTEM_DESIGN.md`, `js/terrain-model.js`, `js/terrain.js`, `js/wgsl/terrain.js`,
`js/vegetation.js`, `js/woodland.js`, and `scripts/prepare-woodland.py`.

---

## 1. What Exists Today vs. What `../forestmodeler` Now Provides

1. **Single-Specimen Woodland Prototype (`js/woodland.js` & `scripts/prepare-woodland.py`)**:
   - `assets/woodland/` currently holds two 20-year specimens (`oak-101-20` and
     `birch-101-20`) with reduced wood JSONs (`wood-near.json`, `wood-middle.json`)
     and an $8 \times 3$ directional depth/normal/colour impostor atlas ray-marched
     in `js/wgsl/woodland.js`.
   - `js/woodland.js:200` and `scripts/prepare-woodland.py:132` explicitly record
     the current limitation:
     - `standVolumes: false`
     - `"Individual overlapping crowns are not a coherent stand-volume compiler."`
   - `README.md:690` likewise notes regarding `js/vegetation.js`:
     - *"These additions do not yet supply a closed distant forest canopy."*

2. **Stand-Volume Canopy Compiler & Regional Terrain Bridge (`../forestmodeler/gardenplans/scenery.py`)**:
   - `../forestmodeler` now provides a deterministic stand-volume canopy compiler
     and regional terrain exporter (`gardenplans.scenery.bake_waterworld_scenery` and
     `gardenplans.scenery.export_waterworld_region`, CLI:
     `../forestmodeler/scripts/bake_waterworld_scenery.py`).
   - It reads a `waterworld` region directory (`assets/world/saba/` or any future
     `assets/world/<region>/` pack), places a multi-species forest stand using
     Mitchell's blue-noise sampling constrained by `height.bin` (`>= 8 m`), slope
     (`<= 0.78`), and `biome.bin` probability, seats every trunk collar on the
     **exact** `terrainSurfaceSample(heights, x, z, region)` triangle plane
     (`a + b <= 1` split), strips buried interior sub-canopy cards via
     `cull_canopy_shell`, and emits both native WebGPU `Float32Array` binary streams
     and Y-up glTF 2.0 (`GLB`) meshes with SHA-256 receipts.

---

## 2. Non-Negotiable `waterworld` Renderer & Physics Invariants

When integrating `../forestmodeler` outputs into `waterworld`, preserve these rules:

1. **No Three.js Runtime**:
   - All outputs target `waterworld`'s native WebGPU pipelines (`js/terrain.js`,
     `js/wgsl/terrain.js`, `js/woodland.js`, `js/gltf.js`).
2. **Playable Shores Require `height.bin` on CPU and GPU (Not Just `_terrain.glb`)**:
   - In `js/terrain.js` and `js/terrain-model.js`, the `heights` grid (`signed int16`
     little-endian quarter-metres, rows north-to-south) drives four coupled systems:
     - Above-water (`> -0.5 m`) and submerged (`-45 m < h < 0 m`) triangle buffers via
       `islandGeometry(heights, region)`.
     - Hull grounding and draft clearance via `islandHullClearance(heights, x, z, draft)`.
     - Shallow-water wave attenuation, shoaling tint, and surf foam via the `r32float`
       `elevation` texture in `COASTAL_WATER` (`js/wgsl/terrain.js:58-72`).
     - Real-time $64 \times 64$ terrain self-shadowing and cloud-shadow ray marching
       via the `TERRAIN_LIGHT` compute shader (`js/wgsl/terrain.js:74-108`).
   - Therefore, for new navigable islands or river reaches (Virgin Islands, Hudson,
     Columbia in `LAND_SYSTEM_DESIGN.md`), always export `height.bin` + `biome.bin`
     via `export_waterworld_region` alongside any static backdrop or canopy mesh.
3. **Preserve Apple Tile-GPU Hidden-Surface Removal (HSR) in `landOpaque`**:
   - `js/wgsl/terrain.js:169-171` states:
     *"The opaque call graph contains neither discard nor a leaf texture fetch. Keep
     that property for Apple's hidden-surface removal."*
   - Accordingly, `bake_waterworld_scenery` separates its native WebGPU output into:
     - `<stem>_canopy_opaque.bin` (`kind.x = 3.0` coarse trunk prisms + `kind.x = 4.0`
       watertight octagonal crown envelopes, **zero `discard`**) for `landOpaque`.
     - `<stem>_canopy_cutout.bin` (`kind.x = 4.0`, `leafUV` in `[8..9]`) for the
       alpha-cutout `leafFS` pass (`discard` when `leaf.a < 0.015`).

---

## 3. Exact Coordinate & Binary Buffer Contracts

### 3.1 Coordinate Alignment & Triangle Plane Seating
- `waterworld` world space is Y-up metres (`[x, h, z]`): `+X` east, `+Y` up, `+Z`
  south, centred at `region.localOrigin` (`x = 0, z = -6000` for Saba) across
  `region.spanMetres` (`8192 m`).
- `gardenplans.scenery.waterworld_surface_sample(region, x, z)` implements the exact
  `a + b <= 1` triangle split of `terrainSurfaceSample(heights, x, z, region)` in
  `js/terrain-model.js:22-38`, returning `(height_m, sx, sz)`.
- Every vertex in the exported `.bin` streams and `.glb` files is already in
  `waterworld` Y-up world coordinates `(x, h, z)`.

### 3.2 Binary Stream Layouts (`<stem>_waterworld_manifest.json`)

| File | Type | Stride | Layout & Binding |
|---|---|---|---|
| `<stem>_canopy_opaque.bin` | `Float32` LE | `10` floats (`40 B`) / vertex (`30` floats / tri) | `[x, y, z, nx, ny, nz, kind, shade, u, v]` (`TREE_VERTEX_FLOATS = 10`). `kind = 3.0` bark, `kind = 4.0` opaque crown dome, `shade = exposure` (`0.35..0.96`). Binds to `landOpaque` (`js/wgsl/terrain.js`). |
| `<stem>_canopy_cutout.bin` | `Float32` LE | `10` floats (`40 B`) / vertex (`30` floats / tri) | `[x, y, z, nx, ny, nz, 4.0, shade, u, v]`. Shell-culled outer canopy dome & edge skirt cards. Binds to `leafFS` (`js/wgsl/terrain.js`). |
| `<stem>_instances.bin` | `Float32` LE | `8` floats (`32 B`) / instance | `[x, h, z, crown_radius, height, shape, sx, sz]`. Matches `seedVegetation` (`js/vegetation.js`) and `selectWoodland` (`js/woodland.js`). |
| `<stem>_canopy.glb` / `_terrain.glb` | glTF 2.0 binary | Indexed PBR | Y-up metres `(x, h, z)` for inspection or static inland ridge backdrops (`js/gltf.js`). |

Each `<stem>_waterworld_manifest.json` also includes:
- `files`: exact byte lengths and SHA-256 digests for every generated `.bin` and `.glb`.
- `patches`: `128 m × 128 m` bounding spheres (`key`, `centre`, `radius`, `low`, `high`)
  matching `createForestPatches` and `visibleForestIds` in `js/vegetation.js:474-506`.

---

## 4. Commands to Bake or Refresh Scenery Assets

Run from either repository using `uv`:

```bash
# 1. Bake stand-volume canopy scenery onto Saba's LiDAR terrain & biome mask:
uv run --directory ../forestmodeler python scripts/bake_waterworld_scenery.py \
  --region ../waterworld/assets/world/saba \
  --stand mixed \
  --stems 42 \
  --out ../forestmodeler/out/waterworld_scenery

# 2. Synthesize a new navigable river reach (Hudson Highlands or Columbia Gorge)
#    with height.bin, biome.bin, manifest.json, and baked forest canopy scenery:
uv run --directory ../forestmodeler python scripts/bake_waterworld_scenery.py \
  --generate-region hudson \
  --stand mixed \
  --stems 42 \
  --out ../forestmodeler/out/waterworld_hudson

uv run --directory ../forestmodeler python scripts/bake_waterworld_scenery.py \
  --generate-region columbia \
  --stand spruce-fir \
  --stems 48 \
  --out ../forestmodeler/out/waterworld_columbia
```

Full implementation details on the `forestmodeler` side live in:
- `../forestmodeler/gardenplans/scenery.py` (`load_waterworld_region`,
  `waterworld_surface_sample`, `waterworld_biome_sample`, `export_waterworld_region`,
  `bake_waterworld_scenery`)
- `../forestmodeler/scripts/bake_waterworld_scenery.py`
- `../forestmodeler/docs/WATERWORLD.md`
