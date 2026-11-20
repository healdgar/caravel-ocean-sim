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

## 3. One Continuum (Forest Continuum Architecture)

Every model family rendered across distance — people and their faces, animals, buildings, ships, trees, rocks, props, terrain — is drawn through **one continuum**, defined by how the forest pipeline *functions* (`scripts/prepare-forest-clusters.mjs`, `scripts/prepare-forest-crowns.mjs`, `js/forest-clusters.js`, `js/forest-crowns.js`), not by the forest's detail level. Families differ only in their source mesh and instance records, never in their selection, handoff or budget code. Per-family LOD ladders (discrete tiers, hand-made proxies) are not the architecture: those that exist are to be replaced, and none is to be extended or copied.

1. **Near / Mid Physical Detail**: Bake each family's full-resolution physical part assembly into a cluster hierarchy and cut it on the GPU per instance (`forestClusterSelect`) by projected screen-space error (`err * scale * focal / distance <= allowed`). There is no triangle cap per instance: near detail is whatever the source holds, and one tree, face or façade may take a million triangles or more when the scene budget allows (the format bounds list capacity, never detail). Animated or skinned meshes carry their skin in the clusters, with pose slack added to each cluster's error bound.
2. **MSAA Sample-Mask Handoff**: Crossfade into the far continuum over a proportional distance band (`FOREST_CROWN_BAND`) using deterministic `@builtin(sample_mask)` coverage splitting (`forestCrownSamples`) — never alpha-blended double-draw or hard range switches.
3. **Continuous Half-Edge Collapse Continuum (`morph.bin`)**: Bake a closed progressive base mesh ordered by half-edge collapse retirement with cumulative vertex ancestor maps and silhouette-preserving scale factors. In GPU compute, binary-search `allowedErr` per visible instance and pack `(stepIdx, morphT)` so the vertex shader smoothly interpolates collapsing vertices (`mix(p0, p1, morphT)`), normals, and surface/volumetric optical moments down to a minimal ~4–6 triangle core. That core is the far end of the chain, not a limit on near detail.
4. **1-Triangle Relightable Octahedral G-Buffer Cards & Sub-Pixel Stochastic Thinning**: Families with GPU-baked octahedral G-buffer cards (`js/continuum-cards.js`, `js/wgsl/continuum-cards.js`) hand off directly from crisp ~1 px physical 3D clusters across the MSAA `@builtin(sample_mask)` band into a single 3-vertex view-facing silhouette card carrying cell-isolated mipmapped linear albedo, view-tangent 3D normals, exact per-texel depth (`@builtin(frag_depth)` + parallax reprojection), and material flags for live sun/moon/cloud-shadow/backlit relighting — bypassing coarse multi-pixel polygons while using 1 triangle per instance. Non-card families morph into the 3-vertex integrated horizon splat below `~3.5 px` (`CONTINUUM_SPLAT_PIXELS`). Below `1.0 px` (`CONTINUUM_MIN_PIXELS`), deterministic hash thinning paired with area-preserving radius inflation keeps horizon silhouettes stable without sub-pixel aliasing or triangle amplification.
5. **One Scene Budget**: A view has one triangle budget (initially **3M submitted triangles**), managed dynamically by one shared pixel-error scalar that every family's cut reads. Detail yields smoothly under the budget — through the morph and the sample-mask band, never by popping — while importance weights keep what the player is looking at, speaking to or firing upon sharp. Frame-time governors may move that same scalar and no other. Triangle counts are a proxy: pass times measured on the GPU remain the final check.
6. **The Finest Cut Is the Physical Truth** (rule 1): collision, gunnery, flooding, crew footing and fracture work on the full-resolution assembly. A damaged, fractured, flooding or aimed-at instance draws the finest cut its error bound allows, simplification never crosses a part or shard boundary, and relief thinner than a ball is a detail layer keyed by part id that rides its part's transform.
7. **One Shared Core**: Projected error, the sample-mask split and the splat and thinning constants live once, in one WGSL include and one module early in the `build.mjs` order, with unique top-level names; each family supplies data to it, not another copy.

---

## 4. Build & Repository Safeguards

- **Fix architecturally, across the whole game**: Any time you solve a problem, check whether the root cause is architectural and should be fixed systematically across the entire codebase (all building generators, all vessel families, all characters/animals, all shaders/passes) rather than patching a single asset or call site.
- Run `npm run build` after modifying any file under `js/` so `ocean.html`, `ocean.min.html`, and `docs/index.html` stay synchronized.
- Never hand-edit coordinate fixes into procedural world generators; fix the procedural rule itself.
- Do not modify `assets/board/game.js` or overwrite verified packs in `assets/forest-scenery/**` without running their canonical offline preparation and validation scripts.
