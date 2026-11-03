---
name: waterworld-3d
description: "Core 3D WebGPU architecture, coordinate systems, vertex buffer strides, WGSL material IDs, Universal Boat Part Taxonomy scaling, and build/deploy rules for the Waterworld naval & coastal simulator. Trigger when modifying ships, coastal ports, buildings, WGSL shaders, gunnery ballistics, 3D mesh deformations, or camera/helm controls in the waterworld repository."
---

# Waterworld 3D Architecture & Conventions

Parsimonious reference of non-obvious 3D invariants in `waterworld` (following the `threejs-webgpu-3d` and `unreal-skill` guidelines).

---

## 1. Coordinate Systems & Handedness

- **World Space**: Right-handed, `+Y` = up (meters above mean sea level), `X` = east/west, `Z` = north/south.
- **Vessel Local Space** (`vesselWorldToLocal` / `vesselLocalToWorld` in `js/gunnery-control.js`):
  - `+X` = starboard, `-X` = port
  - `+Y` = up above design waterline
  - `-Z` = bow (forward), `+Z` = stern (aft)
  - Positive gun traverse (`+deg`) trains toward the bow (`-Z`).
- **Port Building Local Space** (`toWorld` in `js/coastal-world.js`, `buildingLocalToWorld` in `js/gunnery-control.js`):
  - `wx = inst.x + lx * cosY + lz * sinY`
  - `wy = (inst.baseY ?? inst.y ?? 0) + ly`
  - `wz = inst.z - lx * sinY + lz * cosY`
  - Inverse (world-to-local): `lx = dx * cosY - dz * sinY`, `lz = dx * sinY + dz * cosY`.
  - When rotating local building helpers by +90° in XZ (`rot90`), always use a right-handed basis (`(lx, ly, lz) => toWorld(lz, ly, -lx)`, `det = +1`) so triangle winding and outward normals stay intact.

---

## 2. Vertex Buffer Strides & Packed Attribute Encodings

- **Terrain & Coastal Port Building Meshes** (`stride = 8` floats / 32 bytes per vertex):
  - `[0..2]`: `position.xyz` (world space)
  - `[3..5]`: `normal.xyz` — **structural damage is encoded in the normal vector length**: `len(normal) = 1.0 + structDmg` where `structDmg` is in `[0.0, 1.45]`. Always preserve unit direction `(ux/uLen) * (1.0 + nextDmg)` when deforming vertices in `bakeBuildingImpactDeformations`.
  - `[6]`: `kind.x` — discrete material ID (unshared per-face vertices prevent GPU interpolation across material boundaries):
    - `0`: terrain land / cliff / grass
    - `3`: palm/tree trunk bark
    - `4`: palm/tree canopy fronds
    - `10`: structural timber, beams, dark iron/bronze cannon barrels
    - `11`: dressed ashlar stone masonry (bastions, seawalls, quoins)
    - `12`: limewashed colonial stucco plaster
    - `13`: Spanish terracotta barrel roof tiles (*tejas*)
    - `14`: deep recessed openings, embrasure throats, wrought-iron *rejas*
    - `15`: bundled palm-thatch & reed roofing (*bohíos*, *caneyes*)
    - `16`: river-cobble pavement & packed-earth bastion terreplein
    - `17`: birch/elm/cedar bark sheathing (wigwams, longhouses, canoes)
  - `[7]`: `kind.y` — context-dependent scalar:
    - On coastal terrain (`kind.x == 0`): foreshore beach sand blend weight in `[0.02, 1.0]`.
    - On port buildings (`kind.x >= 10`): per-face / per-block ambient shade multiplier in `[0.20, 1.0]`.

- **Ship Meshes** (`stride = 15` floats / 60 bytes per vertex):
  - Transformed on GPU by `js/wgsl/part-assembly.js` using per-part 4×4 matrices (`16` floats per part) + `partDamage` array (`4` floats per part).

---

## 3. Universal Boat Part Taxonomy & Non-Rubberband Archetype Scaling

Defined in `js/ship-part-taxonomy.js`:
- Never rubber-band scale a ship uniformly when deploying a shorter/smaller or larger variant of an archetype (`computeArchetypeScaleSpec`).
- Every ship part belongs to one of four scaling modes:
  1. `FIXED`: Human-scale fittings (helm wheel, binnacle, ship's bell, anchors, capstan, gratings, lanterns, crow's nest tub, gunport openings, cannon barrels/carriages) stay at `1:1` human size (`invL = 1/scaleL`, `invB = 1/scaleB`, `invH = 1/scaleH` in `writePartTransform` in `js/part-assembly.js`).
  2. `DISCRETE_COUNT`: Masts (`fore`, `mizzen`, `bonaventure`), upper sail tiers (`topgallant`, `royal`, `spritsail`), and gunports step down/up in discrete integer counts based on physical spacing (`>= 5.8 m` per mast step, `>= 2.55 m` per gunport bay). Dropped gunports seal their hull lids (`lid.*`) and disable the corresponding gun IDs in `syncScaledGuns()` (`js/gunnery-control.js`).
  3. `SECTION_INSERT`: Midships hull strakes, decks, and bulwarks scale along length/beam/depth while preserving bow/stern proportions.
  4. `PROPORTIONAL`: Remaining spars and rigging scale with their parent mast/hull assembly.

---

## 4. Build, Test & Cloudflare Deploy Workflow

- **Bundle**: `npm run build` runs `build.mjs`, which inlines `js/*` into `ocean.html`, `ocean.min.html`, and `docs/index.html`. Always run `npm run build` after editing any file in `js/`.
- **Deploy**: Always deploy using `node scripts/deploy-cloudflare.mjs --skip-build` (after `npm run build`), which stages `.cloudflare/public` and deploys the `sixcailloux-waterworld` Cloudflare Worker.
