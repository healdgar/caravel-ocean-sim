# Forest rendering redesign

October 23, 2026. **Adopted implementation plan; not a shipped replacement.**
This supersedes the intended native-tree/middle-shell transition architecture in
`FOREST_INSTANCES.md` and `FOREST_MASS.md`. Those files remain records of the
current implementation, source receipts and experiments. No performance or
appearance qualification follows from adopting this plan.

The bounded implementation now lives in [FOREST_LOD_PILOT.md](FOREST_LOD_PILOT.md):
original-leaf cluster captures, woody LODs, paged inspection geometry, GPU
ownership/refinement, strict policy/loader regressions and native reference
comparisons. It remains isolated and unqualified; this plan's regional rollout
and complete representation ladder are not finished.

## Evidence and research

The reported close approach submits 1,541,128,221 indexed triangles, including
2,995 complete botanical trees. Terrain occlusion lowers this to 1,338,730,820.
The isolated pass fell from about 947 to 814 ms at 1920x1080 on the authoring
Mac. A .25 m field shell was faster but visibly lost leaf structure. These
observations require a representation change, not another culling-only pass.
Exact receipts and limitations remain in `BACKLOG.md`.

Primary sources reviewed on October 23:

| Source | Documented fact | Consequence for this design |
|---|---|---|
| [Manor Lords developer interview, April 25, 2024](https://www.unrealengine.com/developer-interviews/solo-dev-makes-sophisticated-sim-manor-lords-using-unreal-engine?lang=en-US) | Greg Styczen credits automatic LOD generation, static mesh merging and detailed profiling. | Build an ordinary, measurable asset LOD pipeline before adding bespoke rendering complexity. |
| [Manor Lords 0.8.004 developer announcement](https://steamcommunity.com/games/1363080/announcements/detail/4575182314563546164) | The UE5 upgrade includes GPU-based LOD handling for instanced components. | Retain WebGPU selection/instancing; change the geometry it selects. |
| [Epic HLOD overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/hierarchical-level-of-detail-overview-in-unreal-engine) | Groups of objects can be replaced by merged proxy meshes and materials. | Change representation granularity from branches to trees to forest stands. |
| [Epic Impostor Baker](https://dev.epicgames.com/documentation/en-us/unreal-engine/impostor-baker-plugin-in-unreal-engine) | Multi-view bakes support material channels, depth and several parallax costs; Fortnite uses tree impostors on its non-Nanite path. | Bake actual material/depth detail; evaluate bounded image representations rather than generic coloured crowns. |
| [Epic Nanite Foliage](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-foliage) | Experimental foliage combines assemblies, near-pixel aggregate voxels and normal distributions. Full triangle foliage also has distance/culling costs. | Preserve aggregate coverage and lighting statistics. Do not assume instancing or generic simplification makes dense leaves cheap. |
| [meshoptimizer upstream](https://github.com/zeux/meshoptimizer) | Supplies simplification, indexed-mesh optimization, compression and a separate clustered LOD helper. | Reuse the existing pinned dependency for suitable geometry; a new virtual-geometry renderer is not the first milestone. |

The interview and patch notes do **not** disclose Manor Lords' complete forest
asset chain, exact tier counts, budgets or current use of Nanite. The following
is our proposed WebGPU architecture, not a claim to have reproduced its engine.

## Representation ladder

Reuse finished mature Forestmodeler sources and the same root/species/scale/tint
placements. Do not regrow trees or reduce forest density to meet a budget.
Raw botanical meshes become offline references and an explicit diagnostic mode;
they are not the normal resident tier or an automatic fallback.

Each tier must preserve source crown character, canopy coverage, material colour
and a consistent response to sun, moon, cloud and fog lighting. Retain real
resolved gaps and forest edges; merge subpixel foliage without turning the
canopy into haze. Geometry counts below are initial authoring targets, not
evidence that a target will preserve appearance or achieve a frame rate.

| Tier | Resolved content | Representation | Initial main-view geometry target |
|---|---|---|---|
| 0: inspection | Individual leaves, twigs and bark | Reduced source trunk/branches; source leaf geometry only for visibly resolved branch clusters | 25-60k triangles per complete tree equivalent |
| 1: nearby trees | Branch structure and leaf clusters | Reduced wood plus tightly trimmed source-baked cluster meshes; albedo, normal, coverage, depth and canopy exposure | 6-15k per tree |
| 2: middle trees | Crown silhouette, lobes, cavities and lighting | Coarse source-derived crown/branch geometry with baked leaf-scale material detail and bounded depth/parallax | 500-2k per tree |
| 3: forest stands | Overlapping crowns and forest-edge relief | Terrain-fitted, merged 32-64 m stand meshes baked from the actual planted sources; opaque supported interiors and detailed crown boundaries | 2-8k per stand |
| 4: distant canopy | Continuous mass, treetop outline and regional colour | Hierarchical 128-256 m stand proxies with filtered source colour/normal/exposure detail | 256-1k per stand |

The ranges overlap in apparent size, not fixed world distances. A distant large
silhouette tree can need more detail than a nearer tree hidden within a stand.
Tier 0 can refine branches independently; approaching one branch must not
promote the whole surrounding forest. No tier may use a smoothed sphere/dome
with a green texture as a substitute for an unqualified source-derived asset.

## Authoring pipeline

1. Pin original meshes, maps, placements and their hashes. Preserve leaf/wood
   separation and root IDs. Existing .25 m fields can support distant mass and
   canopy exposure; they cannot supply detail already smoothed out of them.
2. Partition each finished tree into meaningful branch clusters. Use skeleton
   membership if retained; otherwise spatially group complete leaf blades with
   their supporting branches. Keep indexed reuse. This is offline authoring,
   not the rejected per-frame exact-native meshlet culler.
3. Derive trunk/branch LODs with the pinned meshoptimizer tool. Generate small
   close leaf meshes and reduced cluster representations from actual source
   leaves. Compare tightly trimmed cluster meshes with a small multi-view depth
   bake on the pilot; select by image quality and measured GPU cost.
4. Bake linear albedo, coverage, depth, normals/normal variance, canopy exposure
   and required roughness/transmission information from the original sources.
   Do not bake a fixed sunny-day colour into every lighting condition. Preserve
   fine lighting variation; a single smooth crown normal causes the blob look.
   Keep depth/parallax sampling bounded; no whole-box raymarch as the default.
5. Assemble trees at their real placements before baking stand tiers. Use shared
   world coordinates, neighbour halos and deterministic boundaries. Preserve
   holes large enough to resolve, colour variation and real crown contours.
   Finer tree tiers and coarser stands must cover the same planted population.
6. Generate coverage-aware mipmaps and normal-variance filtering. Filter colour
   in linear space and prevent transparent texel colour bleed. Test canopy
   coverage after filtering; ordinary averaged alpha plus a fixed cutoff can
   erase leaves. Bound grazing-angle shimmer and moire at actual render sizes.
7. Emit separate streamable tier pages plus provenance, bounds, geometry costs,
   texture footprints and appearance qualification. Missing or failed tiers
   fail authoring; they never silently point at a complete Hero mesh.

The manifest must identify `sourceReceipts`, `placementReceipts`, stable ownership
IDs, parent/child coverage, tier bounds (including wind), page dependencies,
per-pass vertex/triangle costs, texture/mip bytes and qualified size/view ranges.
Store geometric error separately from rendered appearance receipts. Keep those
receipts and tool versions next to the assets. Schema validation must reject
missing children, overlapping ownership, broken page references and a production
tier that resolves to a raw reference asset.

Avoid a blind percentage decimation of disconnected leaves: preserving only
vertex positions does not preserve canopy coverage. Also measure alpha overdraw
and material sample cost; replacing every leaf with a large transparent card
can exchange a geometry bottleneck for a fragment bottleneck.

## Selection in screen space

For a small on-axis world-space deviation E at forward depth Z:

```text
pixelsPerRadian = framebufferHeight / (2 * tan(verticalFov / 2))
projectedDeviation ~= pixelsPerRadian * E / Z
```

This is an explanatory approximation. Runtime selection must conservatively
account for nearest bounds, lateral extent, camera-inside cases and animation.
Use the real drawing buffer, not CSS pixels. Texture footprint and view-angle
interpolation error participate alongside geometric deviation.

The user-requested three-pixel limit is an upper ceiling on demonstrated
silhouette displacement, not permission for wholesale colour, density or
lighting changes. Start interior detail qualification near one pixel, with
separate coverage/lighting checks. Derive acceptable size/angle ranges from
renders of the source and each candidate; retain untested ranges as unqualified.
A voxel cell size or a simplifier error alone is not such a qualification.

GPU compute selects a hierarchical cover of visible stands, trees and branches.
For each ownership region choose a parent or its children, never both in full.
Use hysteresis and a bounded transition band. Any dithered handoff must have
complementary ownership and stable coverage; cap simultaneous transition cost.
Check moving cameras: a still image cannot qualify popping or stippled fades.
If residency prevents refinement, keep the last qualified coarser cover while
requesting pages. Do not replace it with raw native trees or an empty patch.
Small shared base-tree meshes and placement metadata stay resident so a camera
inside a stand can reveal trees without rendering the stand's exterior as an
opaque wall. An exterior-only proxy is inadmissible for camera-inside views.
Qualify this base cover before enabling free-camera teleports in the new path.

Frustum and conservative terrain occlusion remain GPU operations. Treat alpha
foliage as an uncertain occluder unless a separate conservative method qualifies
it. Animate only movement whose projected amplitude can affect the image; share
the same GPU deformation and transition ownership with shadow passes.

## Budgets, streaming and diagnostics

Budget refinement across the visible forest rather than independently promoting
every tree. Prioritize visible silhouette and large image improvements per unit
cost. Record all compromises; if no cover meets both quality and cost, that is
a failed asset/scene gate, not justification to call the threshold imperceptible.

Initial pilot gates:

| Measure | Target |
|---|---|
| Main-view forest submissions | At most 6 million triangles; report vertices and leaf/wood/stand counts separately |
| Additional forest shadow/reflection submissions | At most 2 million triangles combined |
| Isolated forest GPU interval, authoring M4 | p95 at most 4 ms at the tested native framebuffer; full game still must meet 16.67 ms for 60 FPS |
| Isolated forest GPU interval, physical iPhone | p95 at most 8 ms; full game still must meet 33.33 ms for 30 FPS |
| Ordinary sailing startup | No forest page request |
| Island startup | Usable coarse cover before fine-page download; no complete native pack prerequisite |

These are proposed acceptance gates, not measured results or universal hardware
limits. Counts alone do not establish speed. Record exact device/browser,
framebuffer, shader variants, resolution policy and competing workloads.
Use a contiguous measured GPU interval, not sums of overlapping pass windows.
Report ordinary full-scene frame pacing separately from isolated forest cost.

Coarse stand pages load first. Fine pages stream by apparent benefit, with bounded
decode/upload work, cancellation, cache limits and eviction hysteresis. Texture
resolution follows projected footprint and qualified mip quality. Include
geometry, texture and staging memory in the residency budget. A cache miss,
camera teleport or request overflow retains a valid coarse cover rather than
triggering a full pack download or synchronous frame stall.

Per-frame culling, tier selection, deformation and draw compaction stay on GPU.
JavaScript handles asynchronous page I/O and compact controls. No synchronous GPU
readback or CPU vertex animation is introduced. Sparse asynchronous diagnostic
counters and page requests must not become a frame dependency.

Add a tier-colour overlay and counters for branch/tree/stand instances,
submissions per tier and pass, transition duplication, resident bytes, requested
pages, qualification failures and GPU times. A hard ceiling rejects a release
regression before another billion-triangle scene can be described as optimized.

## Qualification and rollout

Root alone owns tests/build/browser/profiling. No full-island rebake until a
bounded pilot passes appearance and cost together.

1. **Pilot:** one complex oak, one visibly different slender species, an edge
   stand and a dense mixed stand. Reuse mature originals. Compare alternative
   branch/cluster bakes before choosing an exporter default.
2. **Sweep:** continuous zoom through all tiers; lateral motion, orbital/aerial
   views, grazing hill silhouettes and camera-inside cases. Test 1080p, native
   Retina and physical iPhone framebuffers, including normal adaptive scaling.
   Use midday/backlight/low sun, overcast, moonlight and strong wind.
3. **Visual gate:** compare source/candidate silhouette masks, depth, canopy
   coverage, colour and lighting, plus motion clips at transition boundaries.
   Match wind state for comparisons. Do not substitute opaque occlusion parity
   or a successful GPU compile for image likeness. Qualify the intended tier's
   size range; close-up pixels can legitimately differ from far approximations.
4. **Cost gate:** collect GPU intervals, all-pass submissions, memory, download
   bytes, cold/warm readiness and full-scene frame pacing. Test delayed/missing
   fine pages and rapid viewpoint changes. Do not call Mac emulation an iPhone
   performance result.
5. **Runtime:** implement and validate a deterministic parent/child cover and
   bounded refinement, initially behind a comparison flag. Replace the whole
   native-tree fallback only after its replacement is qualified. Test that no
   overflow/missing tier can re-enable unrestricted original geometry.
6. **Region:** bake all five species and actual Wells Bay stands, then repeat the
   exact reported failing approach, coast, horizon and a continuous approach.
   Include ships, ocean and weather for final performance qualification.
7. **Release:** rebuild, inspect rendered production output and verify deployed
   bytes. Preserve reference assets/receipts locally. Feed the qualified exporter
   and adapter contract back to Forestmodeler, with its biological data untouched.

## Reuse beyond forests

Use the same representation metadata, screen-space selection, ownership and
streaming principles for rocks, grass and terrain. Grass becomes ground
coverage/normal detail when blades no longer resolve; rocks transfer small
surface geometry into filtered material detail. Ships can later use part-level
visual LOD while retaining the same simulation, attachments and animations.
This forest redesign does not require a ship/simulation rewrite or a renderer
port. First qualify the expensive forest case, then generalize demonstrated code.
