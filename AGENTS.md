# Waterworld Repository Rules

Every 3D model in `waterworld` — ships, harbor and river boats, buildings, bridges, crew, livestock, wagons, trees, boulders, and props — **MUST** satisfy all three rules below without exception:

1. **Every model must be physical.**
2. **Every model must execute on the GPU.**
3. **Every model must use continuous splat decimation like the forest system.**

---

## 1. Physical Models Only (Zero Non-Physical Impostors or Proxy Boxes)

- **Real structural geometry**: Build every asset as a physical 3D manifold or part assembly with real metric dimensions and physically based material optics — never flat billboard cards, rubber-banded meshes, or ungrounded decorative placeholders (`MODEL_AUDIT.md`).
- **Rendered geometry is the physical truth**: Collision, gunnery ballistics, hydrostatics, crew footing, and destruction must match what is drawn:
  - **Vessels** (`js/ship-models.js`, `js/trade-vessels.js`): Assemble from the Universal Boat Part Taxonomy (`js/ship-part-taxonomy.js` — `FIXED`, `DISCRETE_COUNT`, `SECTION_INSERT`, `PROPORTIONAL`; never uniform rubber-band scaling), sweep shots against real triangles (`js/ship-collider.js`), flood physically (`js/hull-flood.js`), and break via GPU shard flight (`js/ship-fracture.js`).
  - **Buildings & bridges** (`js/coastal-world.js`, `js/old-world-buildings.js`, `js/old-world-works.js`): Enrol mesh-accurate targets (`js/city-targets.js`) and fracture physically (`js/building-fracture.js`).
  - **Trees & foliage** (`js/forest-trunks.js`, `js/forest-trunk-shapes.js`): Match struck wood to the GPU-placed root transforms so shot stops on trunks/limbs, fells or wounds trees (`forestStruckPlace`), and passes through leaves and twigs thinner than a ball.

---

## 2. GPU Execution Contract (`GPU_ARCHITECTURE.md`)

- **Compute + indirect draw**: Frustum/occlusion culling, closed-form route/time placement, skeletal and part posing, LOD/continuum selection, and fracture shard kinematics belong on WebGPU (`@compute` passes writing shared pose/instance buffers and `drawIndirect` arguments).
- **No per-frame CPU mesh or instance work**: JavaScript prepares static buffers and metadata once, steps sparse physical simulation state, and uploads compact uniforms or orders. Never animate vertices in JavaScript, never loop over large instance populations on the CPU per frame, and never read posed GPU buffers back at runtime.
- **Tile-based GPU (TBDR) discipline**:
  - Draw opaque surfaces first; never put `discard` in an opaque or main shading pass.
  - Surfaces that cut must lay depth first and shade at `depthCompare: 'equal'` with zero `discard`, or transition via MSAA `@builtin(sample_mask)`.
  - Keep WGSL fragment sampled textures `<= 16`, storage buffers `<= 8`, and `textureSample` / derivatives in uniform control flow.

---

## 3. Continuous Splat Decimation (Forest Continuum Architecture)

Every model family rendered across distance must scale continuously on the GPU without discrete LOD pops, following the forest reference pipeline (`scripts/prepare-forest-crowns.mjs`, `js/forest-clusters.js`, `js/forest-crowns.js`):

1. **Near / Mid Physical Detail**: Render full physical part assemblies or GPU-cut cluster hierarchies (`forestClusterSelect`), selecting cuts on the GPU by projected screen-space error (`err * scale * focal / distance <= allowed`).
2. **MSAA Sample-Mask Handoff**: Crossfade into the far continuum over a proportional distance band (`FOREST_CROWN_BAND`) using deterministic `@builtin(sample_mask)` coverage splitting (`forestCrownSamples`) — never alpha-blended double-draw or hard range switches.
3. **Continuous Half-Edge Collapse Continuum (`morph.bin`)**: Bake a closed progressive base mesh ordered by half-edge collapse retirement with cumulative vertex ancestor maps and silhouette-preserving scale factors. In GPU compute, binary-search `allowedErr` per visible instance and pack `(stepIdx, morphT)` so the vertex shader smoothly interpolates collapsing vertices (`mix(p0, p1, morphT)`), normals, and surface/volumetric optical moments down to a minimal ~4–6 triangle core.
4. **1-Triangle Horizon Splat & Sub-Pixel Stochastic Thinning**: Below `~3.5 px` projected span (`FOREST_CROWN_SPLAT_PIXELS`), morph smoothly into a single 3-vertex view-facing silhouette splat carrying integrated physical shading (`centre`, `rx`, `ry`, mean `colour`, and directional/ambient response). Below `1.0 px` (`FOREST_CROWN_MIN_PIXELS`), apply deterministic hash thinning paired with area-preserving radius inflation (`inflate`) so horizon silhouettes remain stable without sub-pixel aliasing or triangle amplification.

---

## 4. Build & Repository Safeguards

- Run `npm run build` after modifying any file under `js/` so `ocean.html`, `ocean.min.html`, and `docs/index.html` stay synchronized.
- Never hand-edit coordinate fixes into procedural world generators; fix the procedural rule itself.
- Do not modify `assets/board/game.js` or overwrite verified packs in `assets/forest-scenery/**` without running their canonical offline preparation and validation scripts.
