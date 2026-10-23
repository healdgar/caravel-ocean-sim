# Ocean Sailing Simulator backlog and overnight checkpoint

## October 23: adopted forest representation redesign

The user requests a complete rethink, with multiple complexity tiers and Manor
Lords as a reference. [FOREST_LOD_PLAN.md](FOREST_LOD_PLAN.md) is the controlling
implementation plan; existing forest documents remain current-runtime evidence.
Research distinguishes Manor Lords' documented automatic LOD, mesh merging and
GPU instance selection from our proposed WebGPU design. It does not establish
that game's undisclosed asset tiers or a Nanite implementation.

Replacement ladder: inspection branches/leaves -> nearby source-baked clusters
-> middle crown/branch meshes with leaf material detail -> merged stands ->
distant contiguous canopy. Retain source placements, density, crown character,
colour and lighting. Raw botanical meshes become offline references, not the
normal detail tier or a missing-page/overflow fallback. Existing .25m fields
cannot restore fine leaf information; direct-source detail bakes are required.

Implementation order:
- [ ] Qualify one complex and one slender source tree plus edge/dense mixed
      stands across all five tiers before a regional rebake.
- [ ] Export bounded geometry, coverage-aware material/depth detail, provenance,
      and actual rendered appearance envelopes for each tier.
- [ ] Implement GPU branch/tree/stand ownership and refinement, with always-
      resident base cover, hysteresis and bounded transition/streaming costs.
- [ ] Enforce initial pilot gates of <=6M main forest triangles and <=2M extra
      shadow/reflection triangles, alongside measured cost and image quality.
      These are targets, not measured outcomes or a substitute for full-game FPS.
- [ ] Validate continuous approach, orbit, aerial, inside-stand and grazing views
      at 1080p, Retina and physical iPhone resolutions, under varied lighting.
- [ ] Integrate all species/Wells Bay; qualify the exact failing camera and
      complete game; rebuild and verify published bytes only after passing.
- [ ] Feed the qualified exporter/adapter back to Forestmodeler without changing
      biological growth or leaf-area accounting.

**Implementation checkpoint:** the bounded two-species pilot is now code, not
only a design document. [FOREST_LOD_PILOT.md](FOREST_LOD_PILOT.md) records the
source-leaf hierarchy, original material/depth bakes, three woody LODs, paged
inspection leaves, curved two-triangle source leaf ribbons with offline
preauthored index assets (~706KB gzipped for oak+birch), shared pixel lighting,
parallel GPU compaction, ownership/budget policy and native comparison harness.
Every source blade is accounted for; missing pages never
substitute a full botanical model. All 75 serialized source/loader/policy and
native GPU regressions validate these mechanisms. With preauthored hybrid
ribbons, all five saved dense-stand views (`dense-far`, `dense-middle`,
`dense-near`, `dense-aerial`, `dense-low-sun`) pass the finite 3-pixel support
and coverage gates (`preparationMs = 0`, median GPU 1.64–4.77ms, p95
2.30–11.99ms). The JavaScript policy chooser is an
offline reference, not a frame-loop renderer.

The pilot is deliberately isolated from game startup. Its selected specimen
pages load eagerly; production demand streaming, merged stands and regional
integration are unfinished. Loose thresholds fail canopy coverage; tighter
ones can exceed the GPU gate. Do not describe mechanism tests, finite masks or
small draw counts as a qualified forest replacement. Current runtime, shipping
assets and published performance remain unchanged.


## October 23: close-forest GPU bottleneck remains open

Reproduced the exact reported free-camera approach at1920x1080, native Metal.
The old **Ocean + sky** pass includes terrain and every tree. Isolated replay
measured946.8ms; omitting forests reduced it to0.455ms. The actual native/middle
indirect commands submit1,541,128,221triangles, including2,995whole native trees.
These are logical indexed submissions, not unique assets or visible pixels.
The foliage draw dominates. Moving hosting cannot fix this GPU work.

Bounded accepted candidate: immutable min/max pyramids of both actual triangular
terrain grids. GPU culling rejects a root only when terrain provably covers its
entire conservative sphere; underwater, uncertain seams, saddle apertures and
uncertain external camera positions stay visible. No depth readback, per-frame
CPU geometry/visibility work, density/LOD/resolution change or previous-frame
occlusion. `forestOcclusion=off` retains an A/B reference. Profiler display now
says **Scenery + ocean + sky**; internal timing keys remain unchanged.
Initial native measurement:1,338,730,820triangles and813–815ms isolated pass,
about14% lower. This is a limited improvement, **not a resolution of the billion-
triangle issue, ordinary 60FPS, Retina or physical-iPhone qualification**.
Final qualification:44serialized source, native GPU, distribution and Stats
checks pass;4additional packaged/native startup and debug-atlas checks pass.
Both source and packaged complete-frame A/B suites compare11,059,200channels
each with ZERO differences across close forest, shore, horizon and underwater.
Close submissions remain1,338,730,820; the primary representation issue stays
open. Logs: `/tmp/waterworld-forest-occlusion-regressions.log`,
`/tmp/waterworld-forest-occlusion-package.log`. Primary checkout untouched.

Rejected experiments are local, not part of the candidate:
- Early native-alpha exits and a leaf depth prepass: no gain / slower.
- Fine .25m source-field near crowns:85.4million triangles and32ms isolated,
  but visibly smooth green lobes instead of native leaves. Failed visual review.
- Exact spatial wood/leaf meshlet culling with original vertex IDs, GPU
  compaction and full-source overflow fallback: no useful gain; dense foliage
  still overlaps, and vertex pulling/overflow negated the rejected work.
  No CPU rendering path or unbounded simplification was substituted.

Receipts: `/tmp/waterworld-scenery-baseline/`,
`/tmp/waterworld-scenery-occlusion/`, `/tmp/waterworld-forest-occlusion-pixels/`,
`/tmp/waterworld-scenery-game-near/`, and
`/tmp/waterworld-scenery-spatial-clusters/`. Rejected prototype source and bake
are retained in `/tmp/waterworld-rejected-forest-experiments/`; none ships.

Published code `96428decad04d8ff2dd21baf874422a90e41724a`; Pages built
2026-10-23T17:57:32Z. Public verification at17:59:16Z matches HTML1,520,815bytes,
SHA256`a77cc7e2dd5706c35e474ce23b9022ed849574d33a1669d4880585c1a8edc463`.
Manifest SHA256`a783e4aec72b968dcec07cd8a169d67bc7fb2858353116fcce9f22d191d36252`
and all158asset records match the prior fully verified asset release. Receipt
`/tmp/waterworld-forest-occlusion-public-bytes.json`. Fresh live Metal Chrome
renders four complete1920x1080frames each on normal sailing and close forest,
without page/GPU errors; only the forest compiles the terrain-cull extension.
Proof/screenshots: `/tmp/waterworld-forest-occlusion-live/`. This verifies live
code/rendering, not physical-iPhone performance or the unfinished60FPS target.

Next required representation work: source-baked branch-cluster colour/normal/
depth detail, with actual native-leaf comparisons at framebuffer/FOV-dependent
transitions, using paged original inspection branches where a bake fails its
appearance gate. Whole botanical meshes remain explicit references; there is no
silent full-tree fallback in the replacement.
The current .25m moment/density fields already smooth the leaf structure;
finer surface extraction cannot restore it. Individual leaves are already bent
single sheets (four triangles), without duplicate back faces. Forestmodeler's
GAME export removes organs and enlarges selected cards; it is not a lossless
replacement. Do not relabel the current source-field footprint as a native
appearance certificate or publish a smooth close-crown fallback as solved.


## October 23: normal Safari startup and forest timer stalls

User reports >1minute on physical iPhone's **normal sailing page**, stuck at
"Building the ships and loading their crew…". Forests are NOT that page's cause.
Native Safari27.0.1 on this M4 reproduces it: all3startup media transfers finish
around3.3s; ocean/sky lasts until71.447s, and ship setup is still incomplete at180s.
Chrome's4–5s fresh-context observations concealed the engine-specific cost.
The separate4xCPU/network-proxy fetch failure was transient, not a device result;
repeat6xCPU and8Mbps/80ms desktop proxies reached readiness without errors.

Bounded correction:
- Cache pending shader/compute programs per device by final rewritten WGSL;
  rejected entries evict for retry. Mutable ship resources stay independent.
- Compile the8independent core render pipelines and crew visible/shadow pairs
  concurrently; overlap independent wetness and water-interaction setup.
- Remove unreachable unannotated WGSL helper functions, retaining every entry,
  global declaration, override, annotated helper and transitive dependency.
- Generate HULL_PROFILE for every allocated fleetSpec's original model code;
  omit only absent procedural profiles/cases, preserving Niña/Victory arithmetic.
  Ship/fleet changes reload; hidden allocated vessels stay in the specialization.
  `shaderModels=all&shaderPrune=off` retains a reference compilation path.

Native Safari local packaged candidate reaches actual first-frame readiness at
14.379s (16.424s external polling), no GPU/page errors. Its first function-pruned
candidate without scene hull filtering took88.493s to ready. These observations
are not controlled cold-driver-cache A/B or physical-iPhone timing. Receipts:
`/tmp/waterworld-safari-startup.log`, `/tmp/waterworld-safari-candidate/`,
`/tmp/waterworld-safari-candidate2/`. Initial public startup/network traces:
`/tmp/waterworld-startup-oct23/` and `/tmp/waterworld-normal-startup-repeat/`.

A second issue affects Landfall:26,945default validation/upload yields can become
clamped zero-delay timers without scheduler.yield. Real mass-loader reproduction
with scheduler disabled took98.5048s, including95.7665s in21,143timers. The fixed
loader processes the SAME210,189,048vertex bytes and202,671,540index bytes with
all hashes/address/finite checks:2.0503s,82MessageChannel task boundaries,0timers,
59UI heartbeat deliveries. Native uploads keep1MiBchunks and abort checks;
explicit injected validation callbacks retain their per-batch semantics.
Receipts `/tmp/waterworld-forest-yield-{baseline,candidate}.json`.
The complete island still transfers about248MB before first frame; native-demand
streaming and further lossless transport work remain open. No assets were reduced.

Qualification:22loader/scheduling checks,14cache/pruning/lifecycle checks, and20
serialized native GPU/package/startup checks passed. A separate19-case rendering
pass covers source/Pages ships, full/new Moon, Sun controls, storms, underwater and
bloom. The new real packaged island regression passes with scheduler disabled:
5.708s to first-frame ready,242real task boundaries,0timer waits, all native/mass
vertex and index buffers uploaded completely and native residency confirmed.
Its initial diagnostic hook missed the shared residency label; corrected the hook
without relaxing the residency assertion. Seven complete production-canvas A/B
scenes compare2,752,512channels with ZERO differences against unpruned all-model
shaders (Niña, Victory, Flying Cloud, mixed fleet, storm, full Moon, underwater).
All9hulls compare14,229GPU query points/455,328output bytes exactly. The first
pixel harness deadlocked its own intercepted RAF poll; using independent50mspolling
fixed it. Final pixel/cache/scheduling run passes11/11. Logs:
`/tmp/waterworld-startup-{native,render,final-render,pixels-final}.log`.

Final rebuilt-package gate passes11/11: required/delayed/failed media, actual first
GPU completion, offline downloads, exact158asset bytes and scheduler-free full
island startup. Release log `/tmp/waterworld-startup-release-check.log`.

Published code checkpoint `edda21df2c3e19ceb005f5c5487e674c3439588d`; Pages built
at2026-10-23T14:47:51Z. Public HTML matches1,515,019bytes, SHA256
`8a8ac16337be6c8e37d02cbc3591305a98cc75589db2a3147697fa628fde38bf`.
Manifest SHA256`a783e4aec72b968dcec07cd8a169d67bc7fb2858353116fcce9f22d191d36252`
and all158asset records are unchanged from prior full public verification.
Receipt `/tmp/waterworld-startup-public-bytes.json`. Fresh private Safari on the
published normal page reached ready at2.1s external polling with WARM driver caches;
this is distinct from the14.379s initial local candidate and is NOT an iPhone or
controlled cold-cache result. Receipt `/tmp/waterworld-safari-public/`.
Fresh public Chrome with phone viewport renders real1206x2280canvas frames:
5.902sready,67modules,88pipelines, no unused procedural hull functions or forest
requests and no fatal/page/GPU errors. Two earlier public Chrome attempts hit a
transient Failed-to-fetch error; the instrumented retry completed. Do not confuse
those network failures with the reproduced Safari compiler stall. Receipt/image:
`/tmp/waterworld-startup-live/`. The phone captain's default view can still be
obscured by its own sail; camera/framing remains a separate issue, unchanged by
this exact-pixel startup correction. Root owns validation. Primary held crew/
Victory work and rejected forest experiments stay separate.

## October 22: iPhone bloom timing and bounded filter efficiency

User reports Bloom120ms on iPhone. Root's source audit and native Mac reproduction
show overlapping render-stage waits: individual bloom passes inherited about11ms
spans while the whole isolated chain took under1ms. This does not establish the
physical iPhone's exclusive bloom cost. The normal row now says **Bloom window
(waits)**. **Measure bloom alone** drains prior GPU work, pauses normal frames,
and measures three four-chain batches with separate, lazily allocated queries.
It resumes with fresh cadence/resolution samples, retains current HDR pixels,
handles pending resize, and adds no fences to normal rendering.

The separable tent's fractional texel phase folds9upsample lookups to4, preserving
all8levels, RGBA16F, Karis downsample and radius. Independent original-filter
renders compare688,400final channels, with230one-step rounding differences and
no larger error. Reference specialization remains bit-identical and can be
selected with `bloomFilter=reference`. Same-context Mac A/B at1206x1998 measured
0.168966→0.15178925ms; at3840x2160,0.2961725→0.25827725ms. These are short isolated
bloom results, not full-game or physical-iPhone FPS claims. Receipt/screenshots:
`/tmp/waterworld-bloom-ab-final/`; reproducible runner `scripts/benchmark-bloom.mjs`.

Root's19-case native Metal pass covers new filter/timing/UI, old profiling,
resolution and28medium/bloom cases plus56bit-exact underwater composites.
Distribution rebuild and19/19packaged/startup checks pass, including offline
HTML downloads, native resource bytes and actual mobile Stats. Final5/5bloom
checks also cover the packaged underwater source and resuming real canvas frames.
The initial packaged test incorrectly watched a minified callback name; it now
observes GPUCanvasContext.getCurrentTexture instead. Published `57bbdd206e37e245d5c8947f7b973789c9ccd241`; Pages built at
2026-10-23T05:56:42Z. Fresh deployed HTML matches1,512,169bytes,
SHA256`e11b59206e5345923141086930c56b5f8696d3d5fa4f56a09be925199dc13973`.
The manifest hash and all158asset records are unchanged from the previous full
public verification. Receipt `/tmp/waterworld-bloom-public-bytes.json`.
Fresh public Apple/Metal Chrome exercised the actual folded pipeline and all15
bloom passes at1206x1998, measured0.138527ms isolated, resumed real canvas frames,
and reported no GPU/page errors. Receipt/screenshot `/tmp/waterworld-bloom-live/`.
This is a Mac with a phone viewport, not a physical-iPhone performance result.

## October 22 evening: native forest release is public

Published `e01bb8cfafae3af8777c9ff5acd9f4559ad6ee34` from the isolated
`codex/gpu-rig-integration` checkout. GitHub Pages reports built at
2026-10-23T04:46:40Z (October22local). Public verification at04:48:13Z matches
HTML1,508,340bytes SHA256`c624e73120919c08906118c2d717239e3ec08ac3173dbddf54fcd7ade69810cf`,
manifest37,855bytes SHA256`a783e4aec72b968dcec07cd8a169d67bc7fb2858353116fcce9f22d191d36252`,
and all158assets/274,627,196bytes. Receipt `/tmp/waterworld-public-release-338.json`.
Fresh public sailing/coast Chrome checks show no errors and the coast compiles
`instanced forest shaded native crown shell`; screenshots/receipt are in
`/tmp/waterworld-live-render-337`. Fresh network ready-and-review observations
were74.9s sailing and31.4s coast, not loopback startup or steady-state frame time;
cold public startup remains worth investigating. Local final package/startup
passes10/10, with horizon/approach/coast rendered review336; static1280x900coast
was58FPS, not a Retina/iPhone or full-sailing60FPS claim.

The817-case sweep326 and targeted reruns329/332 cover all failures/cancellation.
Two stale forest fixture hooks were repaired without relaxing assertions; offline
startup keeps its timeout and fully closes the intentionally failed-GPU browser
before opening distribution tests. The rejected dome pack is excluded. Detailed
near/middle/far foliage and Wells Bay correction are now public. Remaining close
terrain realism and strict native appearance qualification stay open.
Primary crew-route work remains held and was not merged into this release.
Preserve its dirty files; the release authority is the commit above.

## Current order: native-resolution efficiency, then Wells Bay close terrain

The user reproduced sub-60 FPS across scenes on the M4 Mac, supplying the default
`?boat=1` view. Root profiles fixed native Retina pixels before changing quality;
only demonstrated efficiency gains qualify. The user next requested finishing
Wells Bay's poor close-up island rendering. Earlier grass/rock and canopy work
was partial, not close-coast completion. After the performance checkpoint, review
the actual bay at close range, improve shoreline/ground/rock/vegetation detail,
and require rendered before/after checks at approach and coast scales.

## October 22 afternoon: regional forest and closed-canopy correction

**Release candidate:** the user authorized publication of the tested forest refinement. The user explicitly
requires individual trees close, reduced geometry between, and a **solid,
contiguous baked canopy mass** at distance. Individual transparent tree captures
are not that representation. Transitions must use projected perceptible error,
including rendered resolution, field of view and viewing angle.

Current local source uses the five catalogued mature Forestmodeler Hero models
and original gene-surfaces-v3 geometry/maps. The native bridge preserves source
identity and uses immutable shared GPU buffers and indirect draws. The authored
stand contains85,451 roots; the fine Wells terrain rejects401. Greater root count
alone does not establish closed crown coverage. The legacy regional trees and
42-tree patch are load-failure fallbacks, not additional production layers.

The individual full-sphere atlas experiment was rejected for distant forest:
250 grounded comparisons against4× supersampled native rendering fail70 cases
under the unchanged3px silhouette/20% coverage gates. It cannot justify a larger
production atlas switch. The strict opt-in harness remains
`scripts/review-forest-atlases.mjs`; receipt
`/tmp/waterworld-forest-supersampled-243.log`. A closed opaque owner-chunk canopy
compiler/runtime experiment was tested but rejected: its input was the coarse
`p.far` crown domes, not original native leaves/wood. Closure and depth tests
proved opaque geometry, not the requested forest likeness. Active runtime hooks
were reverted; local branch `codex/rejected-crown-dome-canopy-20261022` preserves
the experiment. Do not publish it. The replacement must bake the actual assembled
native wood/leaf geometry, source maps and roots, first for one reviewable stand.
The replacement now derives continuous leaf-area density and linear pigment from
original detailed triangles/MASK maps, assembles overlapping trees before surface
extraction, and clips buried native roots at their collar. Five mature caches
took27.44s; the537-block/85,050-resident-root assembly took100.37s. Middle geometry
uses native wood and those fields; distant geometry is opaque, not atlas cards.
Actual GPU opacity/depth, immutable buffer and projected ownership checks pass.
The24-view isolated stand review still fails strict native3px/20% coverage gates
in many views; these remain diagnostic failures, not a certified transition.
The earlier coast measured2.35FPS at1280×900:8,108 original Hero instances
submitted3.384billion native triangles;40,344 middle instances added498million.
The current refinement adds a useful source-derived middle and fixes near
lighting/coverage. Index-only reduction under a0.35m tool-reported cap retains
766–2,425 triangles per prototype; interior3D fields recover pigment, density
normals and own-canopy exposure. Ordinary opaque rasterization preserves real
mesh depth; no bounding-box fill or per-frame CPU graphics is used. Native
leaves retain source maps and geometry, with independent stable MSAA masks so
overlapping filtered leaves accumulate rather than remaining a transparent veil.
Five-ray exposure improves own-canopy lighting, without claiming inter-tree
shadows. Far mass270 remains unchanged; projected authored sampling estimates
retain the3px target and hysteresis, not a native-appearance certificate.

Source and packaged approach/coast views render without GPU errors. Static
coast is now57.1FPS source/54.5FPS packaged, selecting two native and48,368 middle
roots; buffer storage remains647MB plus20MB of field textures. Packaged loopback
startup takes5.52–5.99s. Wind, waves, clouds, ships and crew were disabled: this
does not prove ordinary-game60FPS, Retina or iPhone performance. Combined run315
passes63 loader/material/build/GPU checks; Python317 passes10 lighting/volume
fixtures. Near oak/maple/birch renders verify the coverage/lighting change.
Receipts: `/tmp/waterworld-close-specimens-coverage-307`,
`/tmp/waterworld-forest-shell-scenes-313`,
`/tmp/waterworld-forest-shell-package-316`. The scene remains unpublished.
The user requested porting the successful technique back to Forestmodeler:
portable field/surface exporters, a Three.js adapter, tests and local documentation
are now in `/Users/alexwall/dev/forestmodeler`, without modifying its growth engine
or existing dirty work. `make test-foliage` passes15Python and36JavaScript checks.
Actual mature-oak export and Three r160/WebGL2 rendering verify source pigment,
own-canopy exposure, opaque silhouette/depth, instancing and framebuffer-based
LOD math. The source/technique guide is `docs/FOLIAGE_LOD.md` there; generated
render receipts remain local in its ignored `out/` directory. This is a reusable
rendering extension, not a change to botanical leaf-area accounting.
Seam-locked reduction287 passed exact spatial joins but saved only2.9% of far
triangles, so it is not installed. No native-resolution performance target is
claimed. Public assets are unchanged.
See FOREST_MASS.md for source receipts and reproducible commands.

Wells correction: independent OSM coastline constrains2,543 unsupported positive
nodes (measured ground wins;4m safety band;32m seam). Independent near imagery
and a2m survey mesh remove the photographed blue foreground wall. Original
terrain source/rings/recipe and separate ODbL/CC BY attribution remain. Close rock
still exposes limitations of filled heightfields/projected photography; detailed
beach/swash and cliff-overhang geometry remain unfinished.

Retina audit uses Apple M4 Max/Metal3 at3344×1846 pixels,2.98×1080p. Stable unchanged
baseline/candidate brackets around41FPS found no repeatable gain from the rejected
lighting/cache rewrites. CPU frame work is a few milliseconds; rendering dominates.
Native Retina60 remains unproven. Keep direct cloud-depth history reuse, which
removes one5.887MiB texture/copy with identical native output across34 frames.

Root is the sole executing validator; agents author source only. Current focused
checks pass3 geometric-certificate fixtures,10 native-import fixtures,4 placement
fixtures and22 loader/material/GPU/package tests. These do not qualify the pending
closed-canopy implementation or a release.

## October 22 evening: forest publication qualification

The release sweep326 covered817cases:812passed, four failed and one was
cancelled. The old atlas fixture gated the new mass buffers and observed only
its former residency label; the legacy tree fixture used a replaced source
marker. Both fixtures now track the actual renderer without relaxing assertions.
Rerun329 passes the deck-water check, both debug-atlas paths and all legacy-tree
render checks. The offline check required fully closing the browser used for
intentional failed GPU startups; a new browser alone retained the old process.
Final startup run332 passes8/8 with unchanged timeouts and offline assertions.
No application code changed during these release repairs. All failed/cancelled
cases have passing focused reruns. Native-looking approximation limits above
remain; this is not a universal three-pixel appearance certificate.

Release includes registered native forests, source-density middle/far crowns,
canopy lighting, independent native coverage and Wells Bay near terrain.
Only manifest-registered assets ship; rejected crown-dome assets are excluded.
Pages deployment and public-byte verification follow the final build.

## October 22: scene zoom must not scale the HUD

The canvas wheel handler was passive, allowing Chromium trackpad pinch/Ctrl-wheel
to change the camera and trigger browser page zoom simultaneously. It now cancels
the default through a canvas-scoped non-passive listener. Panel scrolling and
browser zoom outside the scene retain their normal handling; no global zoom lock
or viewport restriction was added. The user confirmed the issue concerns the
3D ocean/island view. The separate static world-map SVG is unchanged.

Native Metal regression run **30/30** passes in **39.692 seconds**:
`/tmp/waterworld-map-zoom-regression-153.log`. Real Ctrl-wheel events on source and
packaged pages are trusted, canceled, preserve HUD rectangles/DPR/visual-viewport
scale, and still change source camera range. The mobile two-finger path retains
the same layout invariants. Camera, Stats desktop/mobile, all-vessel GPU guards,
asset packaging, startup and offline checks pass. This is not physical Safari or
iPhone gesture qualification. Build receipt `/tmp/waterworld-map-zoom-build-152.log`.
Published runtime **`5d6ee64194d4aa1a8964754b1fb548fc460aab85`** built at
**2026-10-22T19:27:21Z**. Verification at **19:28:02Z** matches HTML
**1,346,216 bytes**, SHA-256
`bdc097e2c7dd2a31c8dee90371062de4c6c9b78cd1900ddf5abf04624716957f`,
the unchanged manifest, and all **58 assets / 19,931,107 bytes**. Receipt
`/tmp/waterworld-zoom-public-receipt-154.json`.
Fresh visible Chrome review zoomed the public scene with unchanged HUD sizing
and no console warnings/errors; proof `shots/scene-zoom-live.png`.

## October 22 morning: shared WebGPU graphics contract

The user identified severe Flying Cloud slowdown and clarified that all scene
graphics, including every future/player/AI/fleet/background ship, use WebGPU. CPU
graphics exceptions need measured performance or transfer-latency justification.
The new `surfaces-v1` adapters incorrectly selected per-frame CPU deformation;
the correction extends the existing canonical GPU pose stage, with compact
model/state buffers and GPU wetness reuse. Sparse physics/IK and one-time asset
generation remain CPU work. See `GPU_ARCHITECTURE.md`.

Integration is isolated in
`/Users/alexwall/.codex/worktrees/overnight-models/waterworld`, branch
`codex/gpu-rig-integration`, based on public documentation HEAD `379881a`.
It excludes the unpublished primary crew-route work. Runtime checkpoint
**`0247d56f65c2aa9b5df7893c6c6c96da08d41ab9`** is published. Pages built at
**2026-10-22T18:50:17Z**; public bytes verified at **18:50:40Z** match:
HTML **1,346,197 bytes**, SHA-256
`ca47154eb9e078f7fbd24219ad5cdeaab11f85e2d6cb776a8440d32ef279b87e`;
manifest **12,422 bytes**, SHA-256
`e920744da5f4b83579461046f8a5f55585710304158236996fbe3eb0f18973ff`;
all **58 assets / 19,931,107 bytes**. Receipt
`/tmp/waterworld-gpu-public-receipt-148.json`.
Fresh visible Chrome review of the public page shows the final Flying Cloud rig
at 60.1 FPS with detailed Stats open and no console warnings/errors; proof
`shots/flying-cloud-gpu-live.png`. This observation remains a short Mac check.

- Stats-button source is `b634c53`, adding live CPU/FPS/resolution and optional
  GPU detail, plus bounded escort timing names. Native source/packaged, desktop
  1140×800/mobile320×568 lifecycle/UI checks pass in receipt122 (10/10 combined).
- Root froze seven pre-port model references in `20dc609`; tests never regenerate
  them. Old-source red check `/tmp/waterworld-gpu-contract-red-105.log` fails the
  expected CPU-path guards. Integrated static/packing/wetness checks pass 9/9
  in `/tmp/waterworld-gpu-contract-focused-107.log`.
- Native Metal observes every registered model's real dispatch, exact shared
  visible/shadow/submerged/wetness buffer and immutable CPU geometry, in source
  and packaged production pages (122). Deliberate dispatch/fallback/upload
  mutations fail the same guard. Partial CPU gun-recoil uploads are removed;
  real GPU recoil passes every actual gun/scale/return/independent-instance
  comparison (116). No CPU vertex-animation exception remains.
- All2784 native crew-tool cases match old geometry, maximum2.15µm position
  difference (124). Anchor expansion/physics/command guards pass24/24 (130),
  retaining physical catenary knots, deployment orientation and Victory's
  >2cm housed-bow clearance. Both accessories upload static templates once and
  compact commands thereafter.
- Every generic vertex in seven models/five states is compared with an offline
  CPU oracle. All original frozen samples pass via exact source records.
  Node/Chrome exact-bit mesh deduplication yields different Cloud indices;
  verified original Node records avoid mismatching frozen indices. Current
  strict position/normal gates now pass every vertex for seven models in five
  states. Pivot-local immutable sail/support records avoid global-coordinate
  Float32 cancellation; Metal had optimized the attempted precision residuals
  away. No thresholds or expected golden values changed.
- Controlled native Metal1920×1080, fixed100%, oneFlyingCloud, Statsclosed:
  public379881a averaged5.28FPS/median188.8msCPU; candidate60.00FPS/2.9msCPU.
  Both89-frame samples had no errors. Candidate median/p95 frame16.7ms;
  this does not establish sustained60FPS or physical-iPhone performance.
  Receipt `/tmp/waterworld-gpu-final-compare-146.jsonl`; visible Chrome proof
  `shots/flying-cloud-gpu-final.png` shows the final rig and detailed Stats.
- Final combined native Metal suite passes **738/738**, zero failures, skips
  or cancellations, in **398.751 seconds**. Receipt
  `/tmp/waterworld-gpu-final-full-145.log`. Source and packaged model contracts
  require the actual canonical pose pipeline, rejecting a recoil-only dispatch
  as well as CPU animation, full or partial mesh uploads and skipped dispatch.
  Final visible Chrome review has no console warnings/errors.
- Final review strengthened the command guard against CPU staging-buffer copies
  and canonical dispatches with zero x/y/z or insufficient x workgroups. Actual
  production-frame mutants fail and restored frames pass in source and packaged
  pages. The expanded native/static/accessory guard run passes **11/11** in
  **10.972 seconds**, receipt `/tmp/waterworld-gpu-expanded-147.log`; runtime
  bytes are unchanged from the 738-test combined qualification.
- The user is downloading a macOS update and authorized work until restart.
  Stop promptly when asked, preserve all checkouts/assets, and keep the one-night
  heartbeat paused. Root alone runs validation; direct authors run no tests.

## Active overnight authorization: October 21–22, 2026

The user renewed overnight implementation at 21:42 PDT on October 21. Continue
`FLEET_MODELS_PLAN.md`: qualify the active Sun/environment control repair, then
integrate the five authored later vessels with coherent geometry, propulsion,
equipment, crew and fleet behavior. Root owns all execution/testing; direct
subagents may author code, without nested agents. Publish only passing, rendered,
byte-verified checkpoints. The held woodland prototype stays separate.

At **08:00 America/Los_Angeles on October 22**, start no new implementation;
stabilize active work, record releases/checks/remaining tasks, and disable
`waterworld-overnight-backlog`. Its local hourly heartbeat is active for this
night. Notify on meaningful changes, failures, required input or morning completion.

The October 20–21 overnight run and its old cutoff below are historical records.

### Nine-vessel integration — published and byte-verified

The registry now integrates all five later vessels alongside the original four.
Runtime **`c8a660d5135db4cb25ac47e3c3b60b3025bc916f`** passed combined native and
rendered checks and is published. The prior Sun-control receipt remains below.

- Own hulls, floors/barriers, appendages, rig/propulsion, equipment and companies:
  Oseberg 32, Lusoria 26, Taíno-style canoe 30, Flying Cloud 12 represented from
  a 42-person loading manifest, Gipsy Moth IV one sailor. Interpretive offsets,
  rig dimensions, loads and coefficients remain authored.
- Rowing geometry, blade immersion, relative water drag, hand targets and effort
  share one stroke. Actual FFT/shared-wave height and orbital motion arrive
  asynchronously; missing/stale/reset fields suppress thrust. Followers command
  human effort, stroke bias and steering; no motor or direct motion correction.
- Rowing wood/bench mass uses physical placement, seated crew and floor-level
  stores. Yacht body sections were refined at fixed waterline/extremes: measured
  geometry displaces 10,583.20 kg against reported 10,577.77 kg. This is an authored
  approximation, not measured hull offsets or certified performance.
- Root's original-four golden hydro check passes exact keys and scalar values
  in twelve configurations. Actual native GPU wetness preserves exact legacy
  outputs while distinguishing dry open interiors, external wet shells and the
  recessed cockpit. Gipsy Moth solo hatch/sail completion and complete body
  clearance through its cockpit coaming pass their focused CPU checks.
- Native modular/Pages preflight now passes all five startup/mesh/company and
  actual rowing-water/thrust checks. The canoe's absent captain controls hide
  immediately; cadence uses strokes per minute and selecting rowing exits
  set-speed mode. Variable frame intervals and the 600-second ocean-loop reset
  retain correct water-field timestamps. These are not device-performance tests.
- All 1,408 measured hands (88 rowing actors, eight phases, two hands) reach the
  actual grips within 8 cm using fixed limbs. Real boot vertices clear shared
  thwarts/supports through sail orders; the scheduler chooses workers with an
  accessible route rather than sending the captain through occupied seats.
- The first combined native run passed 657/664, with six failures and one timed
  out check. Focused reruns resolved crew routing, isolated deck-wash/offline
  startup timeouts, and the new long-name mobile select overflow. The final
  clipper clearance correction passes 48/48 rig/mast/support/cache checks.
  Foreign booms/gaffs previously inherited the mast's authored cloth face and
  could pull a distant course into its mast. Explicit spar kinds now preserve
  foreign cloth's physical rest side; legacy yards retain their original rule.
  Cloth/stay/mast separation gates retain their original tolerances.
- Root's native compact UI fixture passes all five models at 320×360, 402×666
  and 844×390: actual first GPU frame, visible HUD, unobstructed 44px helm targets,
  real sail/rowing/rudder commands, no horizontal overflow, and real settings
  scrolling with a fixed reachable Hide. Native Metal uses a visible test window:
  a plain HTML control reproduces macOS headless Metal's inert wheel scrolling.
- The scalar prepared-support evaluator and bounded exact-normal memo preserve
  independent array-loop Float64 results. A complete-tree oracle checks seven
  procedural models over eight poses, including Float32 mesh bytes, direct cloth,
  normals, ropes, spars, immutable assets and restored poses. Local harness work
  fell substantially; a proposed UV cache was reverted after paired native
  measurements showed no improvement. Flying Cloud remains CPU-heavy; these
  receipts do not establish 60 FPS or physical-iPhone performance.
- The final serialized combined native Metal suite passes **687/687**, zero
  skips/cancellations, in **370.783 seconds**. It includes modular/Pages startup,
  all-nine allocation and mutable-state isolation, actual rowing water/thrust,
  crew work/route clearance, original-four hydro parity, strict rig separation,
  packaged/offline/mobile and rendering regressions. Visible Chrome review of
  all five new models and the mixed nine-vessel scene completed; captured scenes
  reported no JavaScript/shader/device errors. A navigation timeout after several
  sequential scene reloads recovered in a fresh review tab without app changes.
  Pages build **1305173682** built at **2026-10-22T11:03:44Z**. Public bytes were
  verified at **11:05:32Z**: HTML **1,277,453 bytes**, SHA-256
  `860f40e6eb288c83e33404a7c5c667880dc4f085dbdc89b131ae78ea5762e9f3`;
  manifest **11,321 bytes**, SHA-256
  `de21217564c4051c331411cc3ddcc55f07835fd67b6245493958e705cf140a17`.
  All **53 assets / 15,875,925 bytes** matched individual sizes/hashes and local
  files. Held woodland files were excluded from source, build and publication.
- Remaining scope includes whole-rig running-line/spar clearance and calibrated
  historical performance. Blade forces currently react to actual ocean motion;
  individual blade entry/exit does not yet emit its own surface-wave disturbance.
  Hull wakes remain active. Player rowing exposes effort and physical steering;
  unequal-stroke commands currently belong to fleet guidance, not the player UI.
  Root alone holds the testing baton; direct agents author isolated fixes and
  proposed checks without running validation.

### Blade contact waves — published

The next bounded water task connects actual oar/paddle entry and emergence to
the existing shared surface-wave field. Source is isolated from the published
checkpoint until qualification: actual accepted moving-water samples, passive
blade-load/swept-water impulse bounds, no change to propulsion, at most 32 events
per frame with remaining shared capacity respected, and one-frame delayed events
with real age. Missing/stale/reset/teleported/disabled contact must clear history.
Subframe catches can be missed by the snapshot approximation. Focused CPU/native
GPU checks pass: actual three-model crossings, real shared height/foam output,
passive impulse limits, stale/disabled/reset rejection and nine-vessel bounds.
Canoe emergence now retains crossing-time prescribed motion through delayed dry
confirmation. Published with `3ba18f9` after the combined 709/709 native gate and
rendered review. The native fixture measures only roughly 20 micrometres of
height: this proves actual shared-field coupling, not a visibly realistic blade
splash. Richer contact-water shape and appropriate scale remain future work.

### Updated Forestmodeler canopy pipeline — published

The user requested adaptation to the newly updated local pipeline. Import the
existing `waterworld.canopy-scenery/v1` bake through a separate native stand
adapter; the older two-specimen woodland prototype remains untouched. The
available Saba pack is **80×80 m, 42 stems, five temperate species**, not island-wide
or botanically representative tropical coverage. Preserve existing terrain and
procedural vegetation outside that domain.

Native source meshes are already world-space Y-up; instances encode species,
not yaw. Recover actual linear species material colors from the accompanying
GLB, apply its node transform once, spatially partition draw ranges, and preserve
opaque/cutout pass separation. Keep detailed geometry when the export cannot
justify its appearance error; a geometry-only bound does not certify alpha-hole
or material similarity. Never claim `standVolumes:true` is an interior-depth
forest atlas: the current exporter supplies crown domes and shell-culled cards.

Root owns import execution and all validation; direct agents author the local
importer, native runtime/shader integration and independent fixtures. Capture
exact bake receipts and current terrain/mask hashes, preserve Forestmodeler
outputs, and distinguish observed dirty generator source from unknown bake
provenance. Importing new Hudson/Columbia regions or growing island-wide assets
is outside this bounded compatibility pass.

The adapter is now imported, rendered, packaged and published in runtime
**`3ba18f9cc6b88cc4be5d116e6110bdcb45f2a8da`**. The pack supplies detailed GLB
wood, native cutout foliage and original opaque domes/trunks in two conservative
128 m draw batches; runtime vertices append source linear RGB to the existing
attributes. Existing foliage supplies alpha only. The original instance bytes,
source manifest, region, terrain hashes and inspection-time source snapshot are
retained locally. The importer never modifies Forestmodeler or grows new assets.

Initial real imports found a false assumption in our validator: surviving basal
stems can be displaced from their biological seed, including a single remaining
stem in a multi-stem stool. Registration now keeps the strict 3 mm collar-height
check and declared plant-envelope bound, records actual offsets/terrain clearances,
and does not require nonexistent seed-centred wood. Nearest same-genome assignment
does not establish biological parent identity or every wood-ground contact.

Root alone ran eight Python importer checks and 22 focused native/CPU checks.
The first full run passed 708/709: an old tree fixture searched for the former
seed-variable spelling and stopped before rendering. Its revised hook isolates
the original renderer with `canopy=off`, preserves the exact original seed and
retains all foliage/crown thresholds and the intentionally sparse negative case.
The final serialized installed-Chrome/Metal suite passed **709/709**, zero skips
or cancellations, in **351.361 seconds**. Visible Chrome reviewed detailed/auto
source trees and the explicitly uncertified coarse preview without console/GPU
errors; `shots/canopy-source-auto-review.png` records the local result. Normal
open-ocean startup fetches no imported assets; a corrupted optional pack preserves
all original procedural instances exactly.

Pages built at **2026-10-22T12:59:14Z**. At **12:59:54Z**, public HTML, manifest
and every **58 assets / 19,931,107 bytes** matched tested local bytes. HTML is
**1,298,006 bytes**, SHA-256
`8f98010da734ec24966684a2ccccfc631159996f50f4315957742f07ac7c9219`;
manifest SHA-256
`e920744da5f4b83579461046f8a5f55585710304158236996fbe3eb0f18973ff`.
The held two-tree woodland prototype remains excluded. Regional density,
tropical species, a forest-interior atlas, animated imported wind, forest shadow
casting and appearance-certified transitions remain open; this 80 m test stand
does not complete the island forest. See `CANOPY_SCENERY.md` for repeatable import
commands, exact runtime format, strict three-render-pixel policy and camera-only
inspection controls.

### Sun/environment controls checkpoint

- Manual Sun elevation now spans −90°…90°; Sun azimuth, wind direction and swell
  direction cover 0°…360°. Signed old links normalize to the same direction.
- Sun controls live in **Sun, Moon and stars**. Moving either explicitly selects
  Manual Sun. Astronomy retains its actual date/location Moon and stars.
- Manual direct sunlight now obeys the planetary horizon, including cached ocean
  light; twilight scattering remains separate. Solar-disc cloud sampling has a
  finite basis at zenith/nadir.
- Root's complete native Metal run passed **573/573**, zero skips, in
  **315.616 seconds**. The new modular/Pages fixture checks full ranges, signed
  links, spectrum updates, mode switching, finite poles and actual GPU
  day→night→day recovery. The independent finite-disc oracle checks manual night
  and ocean-cache parity.
- Rendered review caught the native date field truncating its time. It now has
  a full-width row. Follow-up native modular/Pages night/date-layout, offline
  downloads, mobile loading and phone/tablet/desktop panel-reachability checks
  passed after that CSS change. Visible Chrome shows the complete date/time
  and Sun controls without console warnings/errors (`shots/full-sun-controls.png`).
- Published runtime **`7c0b52798111bbb693abac5db6d467deb22518d7`**, Pages deployment
  **7244279543**, built **2026-10-22T05:09:08Z**. Public bytes verified at
  **05:09:53Z**: HTML **1,134,838 bytes**, SHA-256
  `f8d796fd522c355f2e2a4db8efb8b5551e61ffae9dc1b18de29f3bc963a1122e`;
  manifest **11,321 bytes**, SHA-256
  `de21217564c4051c331411cc3ddcc55f07835fd67b6245493958e705cf140a17`.
  All **53 assets / 15,875,925 bytes** matched their individual sizes/hashes.

## Published checkpoint: four vessels, independent fleets and night

The public name is **Ocean Sailing Simulator**. Published runtime
`7fba40de2601552757ada1ce490883ced75f06fb` contains the qualified four-model/fleet/night
checkpoint. Root's serialized full native Metal
suite passed **572/572 tests**, **zero skips**, in **302.194 seconds**. Visible
Chrome review covered Pinta and Santa María; native captures covered the actual
four-vessel fleet, full Moon and new Moon. No sustained frame-rate,
physical-iPhone or certified navigation-accuracy result is claimed.

Root verified Pages deployment **7243537555**, successful at
**2026-10-22T04:12:31Z**, and exact public bytes at **2026-10-22T04:13:27Z**.
The release merge preserves the user's README rename commit `915b7f2`; runtime
bytes match the qualified `5a4ad07` tree.

| Public artifact | Bytes | SHA-256 / result |
|---|---:|---|
| Index HTML | 1,134,007 | `5cc2c00084db082a262cba152b37c533d154dc0a6d35ea8f795a2ace628d04f3` |
| Asset manifest | 11,321 | `de21217564c4051c331411cc3ddcc55f07835fd67b6245493958e705cf140a17` |
| All 53 assets | 15,875,925 | Every individual size and hash matched local bytes |

- Published registry: Niña, Victory, Pinta and Santa María. The two new vessels
  have independent lofts/decks, helms, equipment, loading/crew stations and mixed
  square/lateen rigs. Pinta uses an enlarged modern-replica size profile; Santa
  María uses replica reported length/beam and an authored service draft. Offsets,
  working sail dimensions, ballast and gun outfit remain authored. Unspecified
  or builders' tonnage does not become displacement mass.
- Shared semantic parts/construction primitives coexist with explicit model
  backends. New vessels use one authoritative CPU cloth/yard/rope/attachment pose
  for forces, crew targets and uploaded visible/shadow/submerged geometry;
  wetness probes follow the same posed vertices. Niña/Victory retain their
  existing explicit deformation paths.
- Cached loaded hull/actual-keel strips supply passive lateral forces and
  yaw/roll moments; sail yaw joins the steering balance. Follower helm/canvas
  guidance uses real flow, leeway and station/leader motion. No motor thrust,
  zero-flow steering assist or calibrated historical CLR/polar is claimed.
- Fleet UI/query allows eight independently enabled followers plus the player.
  Disabled rows allocate no GPU vessel; enabled instances own crew/joint/actor,
  geometry, probes, moisture, guns, anchors and wake state. One ocean/weather,
  per-model immutable assets, two pooled wake banks and three shadow arrays are
  shared. Legacy omitted-`fleet` and `follower=0/1` links remain compatible.
- Astronomical mode has an unwrapped clock/location, actual Sun/Moon positions,
  phase/terminator, historical catalogue stars and optional constellation lines.
  Explicit 528-byte production Frame preserves its 384-byte prefix. Lunar energy
  reaches cloud/sea/ship/crew/terrain/wet/underwater paths. Solar-above-horizon
  shadow/cloud-map priority is an approximation; the secondary source has no
  separate map. No certified navigation accuracy, eclipse/libration model or
  physical-iPhone performance claim. Navigation helpers/instruments come later.
- Five later craft now have authored definitions/prototypes: Oseberg-based
  c.850 vessel, late-Roman Lusoria, thirty-person Taíno-style canoe, Flying Cloud
  and Gipsy Moth IV. They remain planned/unregistered; coherent propulsion,
  crew/control/GPU integration and qualification are still required.

Passing regression coverage includes immutable geometry and attachment parity,
passive-load invariants, physical follower controls, actual modular/Pages startup,
independent mixed fleets through nine vessels, real GPU uploaded poses/moisture,
and actual 528-byte manual/day/full/new-night scenes. The full-suite result above
qualifies this bounded four-model checkpoint; five later craft remain unregistered.
The held woodland prototype and all unrelated history below remain separate.

Fresh public Chrome review after byte verification loaded the four-model fleet
and astronomical full-Moon scene under the **Ocean Sailing Simulator** title.
Both completed startup and rendered without console warnings/errors. Local
captures are `shots/published-four-model-fleet.png` and
`shots/published-full-moon.png`; the local development preview remains available
at `http://localhost:8088/`.

## Working rules

- Follow existing repository structure. Keep project context and checkpoints here.
- Direct subagents only; **no nested subagents**.
- **Testing baton: root.** Only root may run tests, builds, browser checks, numerical validation or profiling. Other agents may read/edit source and write proposed tests. Transfer this baton explicitly before another agent runs anything.
- Check active agents and test processes after interruption. Preserve unrelated changes; integrate bounded changes and verify before publishing.
- Test appropriate CPU invariants, actual native WebGPU rendering and affected user flows. Desktop/mobile viewports do not establish physical iPhone performance.
- Publish only passing checkpoints to the existing GitHub Pages site. Verify deployment and public artifact bytes. Keep measured facts distinct from authored historical/physical assumptions.
- Avoid new paid generation until existing assets and concrete gaps have been assessed.

## Original overnight baseline

- Published `bea3a355a7d5d273f958d3622cf014bb3045be68`: crew-served cannon drill, solid round-shot flight/recoil, actual FFT sea contacts, volumetric powder smoke, local flash lighting and reviewed audio.
- Last complete native Metal suite: 350 tests passed. A final focused control/crew run passed 7 tests after the last small control changes. Current test count can consequently differ from that earlier full run.
- Public `docs/index.html` SHA-256: `499368f428c73138c010e0cc2b3b54fed403544fc78fbbe85d104527d6a08af4`.
- Clean tree verified before overnight work began.
- Original local hourly continuation: `waterworld-overnight-backlog`, bounded to that night and now paused. Daytime requests do not extend its overnight authorization or reactivate it.

## Original overnight workstreams

| Priority | Owner | Work | Gate |
|---|---|---|---|
| 1 | overnight_sailing | Source audit and bounded repair of sail forces, fill/luff, tacking, in-irons handling and shared rig clearance | Source-proven issue, physical invariants, actual GPU rig/clearance checks |
| 1 | overnight_marine | Source audit and bounded repair of whale/marine animation and water-contact defects | No rest-pose distortion; continuous animation; actual GPU/water visibility |
| 1 | overnight_hull_audio | Resume deferred hull/wave audio: quiet rush, distinct watery bottom impacts, fewer deliberate splash sounds | Contact-driven events, bounded mix, Argon review if new samples are required |
| 1 | root | Integrate and verify serially; audit new gunnery safety/playability and live startup | One testing owner, independent state, rendered and public verification |

These audits may close with no change when current source already satisfies the request. Do not invent fixes to fill a workstream.

## Remaining requested programme

1. Complete unresolved Victory shape/structure and sail/rig details when current evidence identifies defects; use existing measured GLB/reconstruction ledgers. Preserve real joins and tapered entrance; avoid detached decorative boards.
2. Maintain the published four-model/fleet checkpoint. Pinta/Santa María own geometry, physics descriptors and authoritative mixed-rig poses; the combined crew/native/packaged/rendered regression gate and public-byte verification passed. Preserve documented rig-clearance limits, reconstruction uncertainty and tonnage/displacement distinctions.
3. Refine landfall geography/vegetation from meaningful island/river/coastal modules, atmospheric visibility and natural source data. Existing Saba is an MVP; global mapping and explorable interiors are not required. Open-ocean voyage target remains 15–20 minutes without fast-forwarding local simulation.
4. Continue marine encounters, water interaction/refraction and effects quality based on rendered evidence. Shark/whale/dolphin systems already exist; distinguish defects from missing systems.
5. Improve crew appearance and functional work/decision hooks where current source/rendered checks show outstanding issues. Preserve diverse identities and half-female crew, without gendered costume/pose bias.
6. Preserve the qualified nine-model fleet checkpoint above: Oseberg-based c.850 vessel, c.350 Lusoria, 1492 thirty-person Taíno-style canoe, Flying Cloud (replacing generic schooner), Gipsy Moth IV now have playable integration. Remaining historical calibration, whole-operating-rig coverage and model-specific device performance remain explicit.
7. Build navigation learning helpers/instruments after the qualified astronomical Moon/night runtime. Navigation accuracy remains a separate gate. Keep the sky clock separate from FFT time and retain explicit time/geographic conventions.

## Uncalibrated or deliberately subsequent systems

- Gunnery muzzle speeds, reload/cadence and constant spherical drag remain authored approximations; damage, penetration, ricochet, adjustable gun elevation and AI combat are subsequent systems, not completed capabilities.
- Historical ship displacement, detailed rig leads/sail schedules and hydrodynamic coefficients retain their source/assumption distinctions in research files.
- Physical iPhone frame-rate qualification remains device-specific. Adaptive resolution now targets60FPS; source/native desktop tests are not a replacement for that check.

## October 21 desktop performance and bow-whitewater pass

Root retains the testing baton. Direct agents supplied source/proposed tests and
read-only reviews; none ran tests, builds or browsers. Held woodland work remains
outside production.

- Reproduced the user's Victory / Hella rough / exterior view at native Retina
  resolution. Initial profiled cadence was about50FPS and about4.7ms of JS work
  per frame; GPU spans overlap and are not additive costs.
- Crew posing now updates affected descendants rather than full skeletons for
  each IK turn. Real male/female Niña/Victory work poses match transform/palette
  bytes exactly. Gunnery reuses per-gun stage storage.
- Victory computes one pose per enabled ship for visible, shadow and submerged
  draws; raw material coordinates and independent recoil remain intact. Native
  checks compare1,353,648 vertex evaluations with zero position/normal error and
  actual diagnostic rendering with zero pixel differences.
- Dry deck water rejects invisible pixels before lighting. The underwater pass
  stops copying HDR in air; first bloom/final composite select sources using the
  current GPU probe. Native tests retain exact pixels through air/water crossings,
  stale CPU optics and resize. Distributed/minified shader replacements have
  explicit guards; all three built pages boot after correcting a formatting bug.
- Ocean sunlight and invariant diffuse sky values are computed once per frame,
  after visibility/environment mip updates. Native cache values and full ocean
  images match exactly; per-normal/view lighting remains per pixel.
- Auto now targets60FPS. Actual cadence controls reductions; measured CPU/GPU
  headroom permits cautious restoration on60Hz displays. Native keeps full pixel
  resolution. Native visible Chrome held60FPS at2906×1880, about54FPS at3840×2160.
  A3840×2160 Auto viewport held60FPS at3456×1944(90%). Short Mac observations do
  not establish sustained/device-wide or physical-iPhone performance.
- The user's reference shows broad white bow shoulders, not a thin hull ribbon.
  Foam-only source width/birth now follows wet contacts, pressure and peel, and
  clipmap injection includes horizontal FFT displacement. Native Niña/Victory
  checks retain identical height/velocity fields, zero calm dry/stopped/astern
  sources, bounded connected foam and correct independently enabled fleet mapping.
- Strong fresh waterline contacts and accepted lower-hull returns now drive the
  accepted timber-creak sample independently of roll/pitch. One grouped episode
  and shared periodic cooldown prevent station/probe layering and delayed replay.
  Eight additional pure checks pass for freshness, resets, invalid payloads,
  grouping, revision/serial handling and30/60/120Hz partitioning. Severity is an
  acoustic proxy: no structural damage/force solver or new crash sample is added.
- Above-water geometry viewed through the surface from underwater remains absent:
  that path refracts the environment, while the object capture excludes geometry
  above water. A separate above-water refracted capture is still required.

The first full run passed452/463. Ten coastal startups exposed a name collision
between ocean and terrain lighting locals; specialization now validates/replaces
only the balanced ocean fragment body, with20raw/compacted variants and negative
helper/comment/formula guards. The remaining failure was the sail-opacity fixture
missing the newly shared vertex layouts; it now uses production layouts and
Victory's actual computed vertex buffer, preserving all opacity/light assertions.

Final full native Metal suite **464/464 PASS**, root serialized,214.5seconds.
Calm Niña and moderate Victory bow views render without page/GPU errors. Final
built Victory/Hella rough at a3840×2160viewport held60.00FPS over601frame spans,
p9517.5ms,3494×1966(91%) Auto resolution, with correct Victory selection and no
warnings/errors. Proofs remain in ignored `shots/bow-froth-calm.png`,
`shots/bow-froth-victory-moderate.png` and `shots/victory-final-rough-auto60.png`.
Published runtime `5959d8e57266d924a112cda575401c525c473bcd`;
Pages39692095383 succeeded. At23:15:49UTC, public HTML, manifest and all53assets
matched the tested local bytes: HTML680633bytes, SHA-256
`c60cabf4a736ca8a17c171c3f5aea2e9e9143a1ca535c0640f7d1426b5927e83`;
asset bytes15875925. Fresh public Chrome rendered Niña's broader bow whitewater
at2906×1880with ready startup and no warnings/errors;
`shots/bow-froth-public-verified.png`. A second fresh public Victory/Hella rough
view also reaches ready with the correct model and no warnings/errors;
`shots/victory-frame-release-public.png`. No physical-iPhone qualification.

## Release log

- Overnight work started23:19 October20. Direct agents have disjoint ownership; root runs all checks. No overnight changes released yet.
- First batch: heave/yaw relative sail wind, continuous whale emergence, root-anchored breath births, calmer hull audio and actual-sea muzzle clearance. Initial focused checks:30sailing/controlCPU,43otherCPU and11nativeMetal cases passed. Three whale GPU cases initially lacked CHROMIUM_PATH, then passed with the configured browser.
- Integrated run:367/368 passed. The packed-wave image oracle failed its 0.1% one-level channel threshold. Fresh-device SAME-shader controls reproduced52/49152 differing channels, with maximum error1 and identical alpha. Bound raised to0.2%; hard one-level/alpha limits remain. Four serial diagnostic runs then passed; this corrects measured native image noise, not a renderer change.
- Argon listened directly through agy: calm/stationary mixes improved; replayed-wash re-entry lacked body and pumped. Two new candidates (70credits) and their trimmed versions were rejected; no new audio assets promoted. Re-entry now retains the continuous wash and suppresses the fake extra impact. True underside probes/accepted heavy-crash texture remain pending.
- Root rendered actual blow and breach sequences on Metal at1000x700, no GPU/page errors; PNG evidence remains under ignored shots/. The final ambient hull mix received Argon KEEP; a heavy-impact texture remains absent.
- **Held rig prototype:** support-owner/cache changes passed40focusedCPU cases but exposed a17mm main-stay/mizzen intersection in four new mixed-yard poses. Narrowing the pinned-seam ramp to1/26 moved the crossing into triangles touching the sewn luff (segment3; full24mm rope penetration). The full run consequently passed371/372; that prototype is not releasable. Correct support sidedness/wrap geometry together; do not adjust separation tolerances or hide a rope. The complete patch and proposed CPU regression are preserved locally under ignored `shots/lateen-support-work/`. Those runtime changes and extra fixtures have been removed from the release batch pending a coherent correction. The existing operating rig is unchanged.
- **Published batch01:** `5d4f210c7cf9652188b55885fdf95d67679473a9`. Rebuilt all standalone pages; complete native Metal suite368/368 passed in187.9s, serialized by root. Pages deployment39565380826 succeeded. Public artifact SHA-256 matched local: `79afb04fcc1df1109cd02f2dafb255d0f092262ad16fe654149e19366c2a3b04`. Fresh visible Chrome loaded Victory, completed real crew preparation, enabled fire after52/52ready and discharged52guns; no console errors. Local proof `shots/overnight-live-victory.png`. No new audio asset bytes entered the release.

## Next mechanical rig work

The full retained-yard bad-tack correction remains open. Separate yard side from
signed working-sheet angle, lead free cloth leeward around the aft mast while
keeping its luff sewn, and transition loaded/eased runners with climber safety.
CPU/WGSL/rope endpoints/forces/shadows must share that geometry. Existing tests
that expect windward-clew backing do not establish correct routine tacking.
Restrict own-yard exemptions to the sewn-luff neighbourhood when introducing a
wrap; do not hide intersections or restore an artificial force multiplier.

For the next pass, the held patch is `shots/lateen-support-work/owner-pose.patch`;
its proposed test is `rig-support.fixture.txt` in the same folder (not named
*.test.mjs, so Node cannot accidentally discover the unreleased fixture).
Do not promote its narrower seam ramp alone: it changes which triangle crosses
the same rope. The current one-sided X projection sends free cloth outboard of
a neighbouring stay while its sewn luff remains inboard. A continuous contact
path around the actual support, with the correct side, is required.
Routine sheet handling needs separate signed trim and latched working side;
occupied runners must remain taut until climbers descend. Additional per-mast
support controls may require a uniform-layout change; preserve Victory's
interpretation and every consumer if doing so. Full clearance, pinned-luff,
continuity, mirrored/dissipative force and crew-safety gates precede release.

## Batch02 in progress: lower-hull contact

Root retains the testing baton. The expanded isolated lateen oracle ran204
synthetic poses:164failed, predominantly compressed/furled own-yard penetration;
full-canvas failures occurred at opening0. The ordinary trim controller keeps
opening>=.30 and gathers before opening0 during a yard transfer. Thus the
synthetic matrix diagnoses several representations, not204 reachable sailing
states. No rig prototype entered production. Proper exposed-cloth wrapping needs
signed sheet trim, a textile rest metric/slack, finite owner-posed obstacles,
continuous contact topology and a shared deformation lattice. Gathered fabric
needs its own yard-surface bundle; blanket contact exemptions are unacceptable.

A separate ten-point canonical lower-bilge/keel sampler is being integrated.
It retains exposure/return on the GPU every enabled simulation frame; existing
40waterline/wake records cannot stand in for bottom contacts. Encounter speed
is diagnostic, not impact energy or a new force. First/reset/stale events stay
silent. Actual underside returns will suppress coincident light-splash audio;
a convincing heavy-crash sample remains unaccepted. No paid generation.

Batch02 local gate:376/376native Metal tests passed, serialized by root,
186.1seconds. Focused hull/weather checks19/19and all3page startup checks passed.
An initial reserved WGSL field (`meta`) prevented startup; renamed to `tags`,
rebuilt, then ran the passing full suite. Independent direct-agent source review
found no remaining blocker. Actual visible Chrome exercised Victory, sound
enable, Hella rough, spectrum reset and mute with no console errors; proof
`shots/overnight-bottom-local.png`. No crash sound, force impulse or rig change
is included. Publication pending.

**Published batch02:** `1e665c03a715e5e57b147d14034faef146b4e26a`.
Pages deployment39581887758succeeded. Public page SHA-256 matched local bytes:
`04cc20d03bd006453ec6e2e4c798729e3875b90975f9dcbcfcf50085d6c42443`.
Fresh visible Chrome loaded the published Victory, enabled sound, changed to
Hella rough, muted and continued rendering with no console warnings/errors.
Live proof `shots/overnight-bottom-live.png`; verification tabs closed.
Source/bundles/tests are committed and pushed; this publication receipt remains
local for the next checkpoint. Root remains the sole tester. Next priority is
the retained-yard operating-rig correction; do not promote any held contact
prototype or claim the accepted heavy-crash texture exists.

## Batch03: retained-yard research and isolated prototypes

`RIG_HANDLING.md` records the mechanical distinctions and release gates. Primary
museum research adds the missing routine yard-azimuth degree of freedom; the
existing yard is rigid in azimuth outside transfers. Root's25raw yaw/signed-sheet
poses showed forward force is possible but every such pose still contacts rig;
yaw alone is not a clearance correction. The actual-yard oracle now accepts an
optional yard transform. An eight-fixture pure crew/support handover prototype
passed, but it changes no production state and remains blocked at its external
geometry-clearance gate. Held fixtures use `.fixture.mjs`, never `.test.mjs`,
to avoid accidental discovery by the production suite. No batch03 runtime edits
or publication yet. Continue finite-mast wrapping/slack work; never promote a
signed-clew flip, wider spar offset or support masking as a completed correction.

Root subsequently rejected three isolated contact candidates on the same
fully exposed signed-sheet fixture: independent horizontal rows157pairs
(45own-mast), raw-subarc splice143(36own-mast), mesh constraints119(11own-mast).
The mesh pins were exact but edge stretch reached1.60times canonical reference;
three sails took425ms in the unoptimized diagnostic. None is releasable.
Ordinary free-edge points must move; they are not fixed attachments. Continue
from a known clear lattice with contact history, rather than inventing a wrap
side from an already intersecting raw surface. `RIG_HANDLING.md` records the
specific failures and remaining gates. No live rig change.

Root's31pose retained-history continuation removed deep own-mast crossings.
With target attraction applied once before each unchanged64iteration solve,
all93sampled sail surfaces met their own-mast margin; full-rig endpoint still
failed194pairs and edge stretch reached8%. This is not continuous collision or
textile clearance. Worst stretch sits below the moving clew, including on a
mizzen with no contact projection; explicit endpoint relaxation confirms slow
local propagation. An optional canonical graph-distance tether experiment is
next, preserving edge limits and iteration count. Production remains unchanged.

That tether comparison reduced maximum local stretch to4.6%, but still failed
217full-rig contacts. A full-raw-target prediction reversed contact normals and
was rejected. Selected rope witnesses are gathered stays/runners, always-eased
working falls and a foreign halyard; more support release alone is insufficient.
Root's production metric sweep also found existing tight-backed edge ratios
up to1.131with little total-area change. The reusable material-mesh audit exposes
this limitation without blessing it as a clearance pass.

Fresh visible Chrome inspected Victory's stern and close forward-quarter view,
calm sea/furled sails, with no console warnings/errors. Source audit found no
recurrence of the corrected blunt entrance or detached wales. Remaining numeric
gate: define and measure semantic keel and figurehead-to-taffrail endpoints
against the ledger's46.1010m/69.0372m conventions before reshaping again; generic
mesh extrema are not those measurements. Proofs `shots/overnight-victory-bow-review.png`
and `shots/overnight-victory-shape-review.png`; inspection tab closed.

**Batch03 gate passed:** complete native Metal suite383/383, serialized by root,
180.1seconds. Seven new material-mesh audit checks passed, including finite-input
arithmetic overflow; independent review caught and corrected partial edge extrema
after overflow. CLI JSON returned54records with no invalid coordinates/topology,
while honestly reporting backed-pose edge stretch. Only the audit script/tests
and local project documentation enter this checkpoint. Runtime JS/WGSL and all
three standalone page bytes remain unchanged. No contact prototype, artificial
force correction, new asset or paid generation is included. Publication pending.

**Published batch03:** `443ea7fcbf9d3c879490d96f361f71dec55d965b`.
Pages deployment39597495015succeeded; legacy Pages reports built at the same
commit. Public page SHA-256 matches the prior verified runtime and local bytes:
`04cc20d03bd006453ec6e2e4c798729e3875b90975f9dcbcfcf50085d6c42443`.
The audit, tests and documentation are pushed; only this publication receipt
remains local. All direct agents are complete; root retains testing. No test or
inspection browser remains active. Local server8088stays available.

Next bounded rig step: begin from an independently certified full-rig seed,
not merely an own-mast-clear raw surface. Solve cloth against the actual mast,
gathered rope bundle and foreign load-bearing lines; keep sheet/support controls
independent. Preserve rest lengths, moving-attachment consistency and contact
history before pursuing CPU/GPU integration or performance. Do not promote the
held row/PBD/tether prototypes or substitute support release for contact solving.
At/after08:00local, start no new implementation and disable the one-night heartbeat.

Historical overnight status: the heartbeat remains active. Its bounded count was extended from9to10solely to
retain a wake at/after the08:00cutoff for stabilization/report/disable; the prompt,
thread, notification policy and prohibition on new implementation after08:00
are unchanged. Always check actual local time before starting another change.

## Batch04: breach trajectory continuity

Verified whole-body breach discontinuities at ages 4, 6 and 8.9: pitch jumped at
the launch branch, and vertical velocity jumped into and out of flight. Exact
swimming/ballistic derivatives now join through submerged Hermite approach and
recovery segments. A squared-sine bank has zero endpoint roll rates. Airborne
height/pitch, launch time, apex and flight duration remain unchanged; the bank
waveform changes intentionally. This is authored C1 kinematics, not C2 motion,
conserved energy or hydrodynamic propulsion. Event logic and assets are unchanged.

Root's dense diagnostic found root minima −5.53 m/−5.61 m in approach/recovery;
the existing analytic body envelope reaches −10.58 m. These are not animated-skin
or actual-seabed clearance checks. Independent direct-agent source review found
no blocker. 22 focused marine checks passed on Metal. An initial omitted Chrome
path prevented three GPU checks from launching; the correctly configured run
passed. Complete serialized native Metal suite 385/385 passed in 175.4 seconds;
all three standalone pages rebuilt. Visible Chrome captured the actual airborne
breach and re-entry at deterministic frames 435/545 with no console warnings or
errors (`shots/overnight-c1-breach.png`, `shots/overnight-c1-reentry.png`). Existing
entry spray still shows authored pointed particle shapes; this checkpoint fixes
motion, not that remaining fluid-effects quality limitation. Publication pending.
Root remains sole tester.

Further held rig work established one full-rig-clear static seed and preserved
raked-mast-axis rotation invariants, but the raw handover first contacts rig at
step 5 and 216 independent-yaw endpoints yielded no complete clearance. See
`RIG_HANDLING.md`; no prototype entered the runtime. Victory's endpoint audit
also found missing semantic keel/figurehead/taffrail measurement nodes; details
are recorded in `VICTORY_RESEARCH.md`. Do not reshape to generic mesh extrema.

**Published batch04:** `dfd0ba8fdd55ce71a8bf0564d6a84a120d9ed1bd`.
Pages deployment 39604848700 succeeded; public standalone bytes exactly match
local SHA-256 `eadd9154e79e2d1bc7f670e528b324dcc3e9ae02f5fbfc40542c687c94d3c8d9`.
Fresh visible Chrome loaded the public whale encounter without console warnings
or errors; proof `shots/overnight-c1-breach-live.png`. Verification tab closed;
direct agents complete, root retains testing and local server 8088 remains up.
This publication receipt remains local for the next checkpoint. Full rig
handling, accepted heavy hull-crash audio, actual wave-relative animal contact
events and improved marine entry spray remain open. No new paid generation.

## Batch05: marine impact water

The visible whale re-entry spikes came from the shared dolphin crown's
13-cycle rim sampled at only 28 segments, compounded by high rim foam and
overlapping crowns. Marine impacts now use their own 64-segment/six-row curved
sheet, analytic normals, brief staggered emission and full gravity for every
detached row.64 impact drops retain first-contact records and generate24
representative fallout ripples. Dolphins and whale breath remain unchanged.

An initial candidate fixed drops but could expose an absorbed sheet again when
waves fell. Independent review identified that gap. A separate344,064-byte
cache now retains water absorption at every sheet lattice vertex, with exact
seam identity, serial-keyed slot reuse and a dedicated compute dispatch.
Root's13 focused Metal checks pass, including actual marine runtime rendering,
analytic velocity/gravity/normals, later finest-band waves, first-contact
retention and recycled keys. Full suite and final rendered gate pending.
Limitations: sampled point contact, no swept/interior-triangle collision, no
impact wind or fluid-pressure coupling. Geometry/contact work persists through
the bounded4.2-second event life; physical iPhone cost is unqualified.

Argon directly auditioned the existing anchor plunge and a filtered/slowed trial
alone and in the current rough-water mix. Both hull-impact trials were REJECTED:
point-source bubble/plunge, muffled slosh and repetition. No asset promoted or
new sound generation. Detailed local review/provenance is recorded in
`scripts/audio/hull-contact-review.json`; its duration guesses are not measured
evidence. The continuous accepted wash remains, without a heavy-crash accent.

The additional rig source audit supports the existing forward heel/aft penna
orientation. Authored neighboring support/tackle leads remain suspect. A
partial-brailing diagnostic is recommended but unrun; no rig behavior changed.

**Batch05 held after rendered review:** the revised effect removes pointed
rims but looks too faint in actual early/side re-entry captures
(`shots/overnight-impact-early.png`, `shots/overnight-impact-side.png`). All13
focused GPU checks pass, including the new retained sheet contacts, but their
water is spatially flat. Source concern: one frozen root height can place a
new parcel below the local wave at its offset footprint, immediately latching
absorption. Check per-parcel local launch-height sampling before promoting;
do not merely increase opacity or disable valid contact. Marine agent has a
read-only design audit, no further edit authorization. Full suite/build and
publication have NOT been run for batch05. Last public release remains
`dfd0ba8`; root retains the testing baton. All working edits are intentional.

## User priority: startup delay and loading feedback

### October 21 follow-up: remove inactive encounter and repeated setup costs

Fresh public Chrome observations reached first GPU completion at 2.65 s and
1.31 s with the browser resource cache bypassed. Those runs retained the
driver's shader cache. A first unbundled local-source visit took 8.09 s despite
millisecond local asset transfers: compilation/setup also matters, not merely
network throughput. This is Mac evidence, not an iPhone timing.

Instrumented copies of the exact Pages bundle identified 102 startup pipelines,
the mandatory 8,319,500-byte whale, serial material setup and repeated CPU
wetness probe generation for identical player/companion meshes. Ship geometry
itself is procedural: indexed Niña buffers total 3,959,760 bytes, Victory
6,086,508 bytes in memory; those buffers are not downloaded GLBs.

The first fix defers marine assets/pipelines until a requested or natural
encounter. Loading freezes encounter time rather than skipping its opening;
failure leaves sailing available and exposes retry in environmental controls.
Explicit whale/shark scene links retain first-frame readiness for that animal.
Only wood and two crew models preload: 2,767,328 bytes before HTTP compression,
versus 11,086,828 previously (75% fewer required media bytes). Original assets
and the embedded offline downloads keep identical media quality.

Factory-local submerged material caching shares pending compilations and
scene-only groups, with separate vessel bindings and live wave-field selection.
Immutable wetness layout templates are reused per mesh; mutable crew probes,
moisture, GPU allocations and destruction remain independent. A matching warm
local Pages run recorded 90 initial pipelines and 1.09 s to first GPU completion;
the retained before bundle recorded 102 and 1.15 s. Do not interpret those small,
noisy warm desktop differences as a cold-cache or device speed guarantee.
Victory's coastal view reached readiness at 1.45 s in another warm local run.

Verification: 8 new lifecycle/cache tests and 18 focused native Metal checks
passed, followed by the complete serialized native Metal suite: **441/441 PASS**
in 227.4 s. Visible Chrome reviewed Niña startup and Victory coastal rendering
without reported warnings or errors. Publication results follow when verified.
Local audit receipts: `/tmp/waterworld-startup-audit-before.json`,
`/tmp/waterworld-startup-audit-after.json`,
`/tmp/waterworld-startup-coast-after.json`;
`shots/startup-audit/` holds instrumented before/after bundles and
`shots/startup-victory-after.png` the rendered checkpoint. Remaining work:
parallelize independent critical setup and, if measurements justify it,
defer disabled companion initialization. Neither is claimed complete here.

Published `bdb57ddb0f2cc3e2d39bc16b4c1fcb5e81655442`; GitHub Pages deployment
`39677090372` succeeded. Public HTML matched all 669,982 tested bytes, SHA-256
`b90671d9a389b783026ecd8d87d11fbd955861659c7704784d92550fe5aa17ab`;
the manifest and all 53 referenced assets (15,875,925 bytes) matched their hashes.
Visible public Chrome reached readiness at 1.19 s with warm driver shaders,
fetched only the wood/crew media, and reported no warnings/errors. Screenshot:
`shots/startup-ready-release-bdb57dd.png`; deployed-byte/browser receipts:
`/tmp/waterworld-startup-release-verified.json`,
`/tmp/waterworld-startup-public-browser.json`. No physical-iPhone load timing
is claimed.

The held batch05 runtime/docs/test work is preserved in local Git stash
`01a25d28773a65b814f7689355fd78ffce03c9d0` (message: Held marine impact v2).
Production marine code was restored before this change; no held impact code is
part of the startup release. Ignored recordings/prototypes remain in place.

Verified the public page transferred14,055,444compressed bytes and decoded to
21,774,158bytes before startup. On this Mac's fresh Chrome context, first GPU
frame completed at2.34s, with102pipelines and no application errors. That desktop
observation is not a physical-iPhone timing. The published HTML embedded muted
audio, inactive terrain and all models. Generic init failures only logged, and
the existing starting label was hidden inside the optional performance HUD.

The Pages build now emits about600KB of HTML with explicit, content-hashed media
files and a SHA-256 asset manifest. Mandatory wood/crew/whale files preload;
audio remains gesture-loaded and terrain remains scene-gated. Both downloadable
ocean pages retain every original embedded asset. No media reduction or fidelity
change. Older hashed files remain available for cached HTML. A static loading
screen precedes the module, reports actual milestones, waits for first canvas
GPU completion, supports mobile/reduced motion, and retains errors with Retry.
No guessed progress percentage or failure timeout. The extra presentation RAF
was removed during review to preserve deterministic single-callback render
fixtures; first-GPU-work completion still gates readiness.

Eight focused tests passed before the final two assertion improvements: delayed
module/mobile layout, first GPU fence, sticky API failure/Retry, script/asset
failures, deferred web audio, byte-identical versioned media and both actual
file:// offline boots. Exact per-asset embedding and single-transfer preload
checks are now in the full serialized native Metal suite. Full/rendered/public
gates pending. Root remains sole tester; direct agents did source work only.

Final startup validation: **393/393 PASS**, serialized installed Chrome on native
Metal, 185.5 seconds. The first full run found five legacy UI fixtures that froze
RAF before any frame and then clicked through the loader. Those fixtures now
render their real first frame and await readiness; their interaction assertions
remain intact. Eight new startup/packaging tests pass, including exact bytes in
both downloads and exactly one request for each preloaded asset.

Visible Chrome review of the rebuilt Pages scene showed the real loading stage,
then the ship, instruments, helm and usable Sea settings; no warning/error logs.
Evidence: `shots/startup-mobile-loading.png`, `shots/startup-ready-local.png`.
Initial Pages HTML is 614,127 bytes; 53 referenced assets total 15,875,925 bytes.
The whale remains a mandatory 8.32 MB startup resource and pipeline count remains
102; this checkpoint improves packaging and feedback without claiming all
startup work has disappeared.

Published startup checkpoint `12e58a891419e317d029df461e59783732219c10`;
Pages workflow `39618593217` succeeded. At 2026-10-21 14:40:48 UTC, the public
HTML and manifest matched local bytes, and all 53 deployed assets matched their
SHA-256/byte counts. HTML SHA-256:
`72ef564f9369023b602a8b7e4d2755a5a1d0762bd747a79c96ffcc1261fda148`.
Fresh public Chrome on this Mac reached its first GPU frame in 1.20s, versus
the earlier 2.34s observation; HTML transfer was 212,493 compressed bytes.
These are desktop observations, not an iPhone or controlled repeated benchmark.
The deployed scene also passed visible Chrome review: real loading stage,
then the ship/helm, with no warning/error logs. Evidence:
`shots/startup-ready-public.png`; local receipts are in
`/tmp/waterworld-startup-deployed.json` and
`/tmp/waterworld-startup-after-public.json`.

## Daytime requests: forest, ship wake and shared surface disturbances

**Published and verified: runtime checkpoint `6a39870`.**
The public-byte receipt is recorded below. Root alone owns
numerical/geometric checks, native GPU tests, rendered review, builds and any
subsequent Pages publication. Documentation/source readiness is not a passing
combined run or a physical-iPhone result.

- **Ship wake:** removed the separate reflective waterline ribbon. Continuous
  interpolation now drives resolved crest/trough pressure across fore/aft
  contacts, with Victory's correct aft span. Headway/pressure set outward peel
  velocity and nearby foam transport. A balanced stern trough/recovery pair and
  compact alternating quarter-pressure lobes drive the actual retained height
  field. These are bounded authored waves, not calibrated CFD or Kelvin dispersion;
  no propulsion assist was added.
- **Shared scene water:** wildlife surface events, anchor entry and actual
  round-shot water contacts feed independent 512² near/far layers covering
  256/1,024 m. Their authored 4 m/s wave response contributes surface displacement,
  normals, refraction and probes without altering the global FFT spectrum.
  Source IDs, bounded impulses, reset handling and near/far representation are
  part of root's current checks. Existing splash effects are not sufficient proof
  that the underlying sea moves correctly.
- **Forest:** the Saba pack records 17,466 stable trees from 360,000 deterministic
  candidates. Distant trees use opaque primary-bough envelopes joined to their
  actual trunk. Near/middle geometry retains recursive branches and leaf cutouts.
  Actual render-pixel height/FOV/depth select a conservative 3 px geometry-error
  target with 12% hysteresis; frustum culling and source-integrated leaf colour are
  included. Production 96/512 near/middle budgets flag overflow rather than
  silently violating the geometry target. Source colour/elevation remain 8 m/16 m;
  density is authored, not historical canopy reconstruction. Combined geometric,
  canopy rendering and desktop cost checks passed as recorded below; pixel
  geometry bounds do not certify imperceptible alpha/colour transitions.
- **Breaking water:** `BREAKING_WAVES.md` records primary research, engine limits
  and a proposed shared lifecycle for wakes, open-sea crests and future beaches.
  It is not implemented. References include
  [Thürey et al. 2007](https://cgl.ethz.ch/Downloads/Publications/Papers/2007/Thue07b/Thue07b.pdf),
  [Chentanez/Müller 2010](https://matthias-research.github.io/pages/publications/hfFluid.pdf)
  and [Derakhti et al. 2020](https://faculty.washington.edu/jmt3rd/Publications/Derakhti_etal_2020_breakingonset.pdf).
  Wind is not the sole cause of breaking; `B≈.85` cannot be applied using wind,
  a fixed grid propagation speed or an unvalidated fluid-velocity estimate.
  Argon input is consultation, not validation evidence.

### Next bounded hull-audio work — not implemented

The user's clarification distinguishes sustained hull-relative rushing from
small steep wave-face slaps riding on a larger swell. Current waterline contacts
sample all six FFT bands independently of broad buoyancy-slope filtering, but
their pressure signal uses a 0.65 m footprint and a roughly 56 ms temporal filter.
Audio then requires a stronger spray-launch serial, reads every eight frames,
and applies whole-wave rearm/quiet gates. Short modest contacts can be attenuated
or missed; the current continuous wash uses surge speed rather than full
hull-relative current/leeway flow.

Next: a separately gated modest-contact audio event retaining peak/time/position
through readback, plus a small steep wave-on-long-swell fixture at 30/60/120 Hz.
Keep rush continuous, preserve underside-return suppression and avoid coupling
ordinary slaps to ballistic spray eligibility. Assess spatial filtering only
after the fixture shows an actual loss. No new audio runtime, asset promotion
or physical-device qualification is claimed by this source audit.

### Daytime checkpoint validation

- **406/406 PASS**, installed Chrome on native Metal, serialized by root,
  208.5 seconds. Includes source and all three packaged pages, offline downloads,
  mobile controls, sail/rig invariants, Victory, shared optics, scene-wave kernels,
  propagation/reset/reprojection, source lifecycle, canopy geometry and actual
  production whale contacts. Imagery preparation script syntax also checked;
  no imagery download/regeneration or new paid asset generation.
- The first combined run was405/406: the new wave-image fixture let its wildlife
  follow camera move after ending the animal. Freezing camera/frame inputs fixed
  the comparison, without a runtime change. At the same scene instant, removing
  wave sampling changed6304pixels versus4pixels in the unchanged control; the
  wave remains after actor/splash removal. The corrected full run passed.
- Tightened offline geometry bounds with point-to-triangle BVH queries and
  adaptive subdivision, then regenerated the eight cached tier tables. Full
  geometric surfaces remain conservative: this is not an alpha/colour guarantee.
  Pixel-mode selection avoids an unnecessary whole-stand distance sort.
- Actual1280×800 horizon/approach/coast checks: median GPU-completed frame
  intervals8.3/8.5/10.6ms; p9510.6/9.8/13.2ms. At3840×2160: medians11.5/13.1/29.6ms;
  p9513.7/15.0/31.5ms. These are short sequential CPU+GPU completion observations
  on this Mac, not physical-iPhone qualification or isolated GPU pass timings.
  The4K coast retained231near,11790middle and4052far trees; pixel quality takes
  precedence over legacy96/512 authoring budgets. No runtime region was deleted.
- Visible Chrome reviewed revised wakes in mild/rough water with no warnings or
  errors. Local evidence: `shots/wake-field-heavy-final-local.png`,
  `shots/forest-water-coast-3840.png`, `shots/whale-real-waves-contact.png`.
  Independent source review found no wave binding/current/reset/order blocker.
- Remaining: connected overturning/spilling water and richer splash absorption,
  genuinely sharper coastal relief/colour, appearance-bounded stand-level forest
  aggregation, physical-iPhone cost, and independent modest-slap audio. The new
  waves are authored linear responses; no CFD, calibrated energy conservation,
  bathymetric surf or universal breaking-onset implementation is claimed.

**Published daytime checkpoint:** `6a39870345526df0809cbb9b0969749eb4942c93`.
Pages workflow `39633359534` succeeded. At2026-10-21 16:18:27UTC, deployed HTML,
manifest and all53 referenced assets matched local bytes/SHA-256 counts.
HTML637680bytes, SHA-256
`a9614bc10be3868ee695f0d0e30cfce0832a258eef67dabc79a83b22b11b6689`;
referenced assets15875925bytes. Fresh visible public Chrome loaded the coastal
scene with no warnings/errors; proof `shots/daytime-public-coast.png`.
Source/asset receipts remain local in `/tmp/waterworld-startup-deployed.json`.
The overnight heartbeat remains paused; this batch followed fresh daytime requests.

## Finite hull exclusion and green water

User reported a carved hollow with sharp inner edges when the bow plunges into
a large crest. Source confirmed the ocean mask extruded the hull footprint to
infinite height; an older test explicitly required that wrong above-rail mask.

- Shared model-aware finite boundaries now follow exposed decks and solid cap
  tops. Both ocean visibility paths admit continuous water above those caps;
  below-rail hull and cabin/raised-deck space remain excluded.
- Deck water enters all four perimeter faces, including a bow-only pulse with
  dry side lips. Physical face lengths weight the bounded flux. Runoff starts
  at the incoming head and travels inward; residual wash drains and dries.
- Optional shared scene-wave sampling is connected to both ships' deck fields.
  Its compute precedes deck updates; no self-wave propulsion force was added.
- **407/407 native Metal tests PASS**, root serialized,198.8seconds. New test
  proves bow-only ingress, no below-cap leak, cabin separation, retained wash,
  drainage/wet-film persistence, current shared-wave view and disabled clears.
  Five focused mask/deck/visibility/wake GPU checks also passed. Controlled
  same-pose before/after renders show continuous water over the foredeck:
  `shots/deck-boarding-legacy.png`, `shots/deck-boarding-finite.png`.
- This is prescribed-wave visibility plus bounded thin deck water, not a
  hydraulic overturning, flood-mass or cabin-flooding solver. No physical-iPhone
  cost qualification. Published as `f16d33d20a2bd89a7246b225597a2000d02de7e7`;
  Pages workflow39643356285 succeeded. At17:26:02UTC, deployed HTML and all53
  assets matched tested bytes. HTML639533bytes, SHA-256
  `fc0786da50541b07feeb017542e27153b75ffdc7c24ee9e4655fb3ea9a109783`;
  assets15875925bytes.

Separate active terrain work: reuse local forestmodeler/furlong woodland assets
and directional depth reprojection for a terrain-conforming cohesive canopy;
varied trees and resolvable grass/rocks; no unreviewed prototype in this water
checkpoint. Original ground-cover additions are preserved in
`shots/terrain-next/source.patch` while the water snapshot is tested/published.
Cloud views from above remain lower priority. Coastal/isolated-shoal surf must
use local depth relative to wave height and wavelength; this is required shared
breaking-water work, not a shoreline colour band. Keep its design separate from
claims about already implemented runtime.

## Underwater inspection, caustics and close ground detail

- Exterior orbit now spans both sides of the waterline, with a closer zoom and
  independent focus panning. Right/Shift drag pans; touch supports two-finger pan
  and pinch. Free inspection also crosses the sea; terrain clearance remains.
  Captain-view behavior is unchanged. Share links retain exterior angle/range/pan
  and free-view coordinates.
- The same displaced sea now has an interior dielectric interface: water-to-air
  refraction, a Snell window and total internal reflection. A current GPU probe
  classifies the camera without readback lag. A bounded HDR medium pass before
  bloom applies spectral extinction and sunlight/sky scattering; captured solid
  material avoids duplicate air fog and water attenuation. Captured shallow bed
  can fill ordinary terrain's deliberately omitted submerged triangles.
- Wave slopes drive a local refracted-light receiver Jacobian for caustics on
  submerged solids from above/below water. Flat waves do not invent a pattern;
  solar occlusion, depth and turbidity fade it. This is not multivalued photon
  tracing, reflected-object reconstruction or full multiple scattering. Runtime
  Moon lighting is pending the separate astronomy design.
- Grass clumps and irregular rocks use four shared opaque meshes, deterministic
  regional patches, triangle-accurate terrain roots, slope-aligned normals and
  actual-render-pixel omission/hysteresis. Grass bends with wind; cached sunlight
  avoids ray marching clouds per blade. Ground materials gain filtered meso detail.
- Focused native optical checks passed: Snell/TIR, actual-wave focusing, negative
  solar/depth/turbidity controls, one/four-sample depth, raw-solid occlusion,
  current GPU camera classification, disabled dispatch and resize. Actual desktop
  and emulated-mobile gestures pass. **420/420 complete production tests PASS**,
  installed Chrome/native Metal, root serialized,214.6seconds. All three packaged
  pages are included. Rendered shallow-bed caustics change with actual wave time;
  proof `shots/caustic-bed-10.png` and `shots/caustic-bed-10.7.png`, no page/GPU
  errors. An earlier run caught grass/rock pipelines mislabeled as tree wood;
  their distinct ground-cover label restores the unchanged two-tree-pipeline
  oracle. The final complete run passes without loosening that oracle.
  Published as `d0018e998611256cc71679e1958a1cf5aebb56a1`; Pages workflow
  39653348992 succeeded. At18:32:08UTC, public HTML, manifest and all53assets
  matched tested bytes. HTML659253bytes, SHA-256
  `0868df573dec143c4212659ff4027ff20c20621c6b6c51729509b06ba9b19ff6`;
  assets15875925bytes. Fresh visible public Chrome rendered submerged ship,
  refracted surface and controls with no warnings/errors. Proof:
  `shots/underwater-public-verified.png`. No physical-iPhone claim.
- Actual1280×800 horizon/approach/coast GPU-completed frame medians with original
  trees and new ground detail:6.2/6.0/8.9ms, p957.4/7.5/11.1ms, no page/GPU errors.
  Coast selected252rocks and634grass clumps (69156prop triangles). These short
  sequential observations are Mac results, not physical-iPhone qualification.

### Held directional woodland prototype

Imported exact leafy colour/normal/RG16-depth banks and reduced wood from local
Castle and Commons / Forestmodeler, with source hashes and notices. Two banks
use9MiB uncompressed GPU textures. New modules, intake script, assets and proposed
tests remain local (fixture in `shots/woodland-next/woodland.test.mjs.txt`);
**not imported by the production terrain or standalone build**.
Initial rendered coverage was unacceptable (twig-like fragments/missing crowns),
and frame medians22.4–28.2ms exceeded the accepted original tree path. No release
claim follows its CPU receipt/bounds tests. Ray-entry/depth convergence repair,
matched-source near geometry, below/overhead view coverage and coherent stand
aggregation still need rendered validation.

Source density review also found the existing full-green placement intensity
can cover only about38% even under optimistic opaque-disc crowns. Increasing
global candidates to900k predicts only about70%, with greater overdraw; it is
not a calibrated closure fix. Next: authored patch closure targets and measured
source crown footprints, deterministic union/overlap planting, then distant
volumes derived from those same planted crowns. Do not fill sparse stands with
an unrelated opaque shell or certify a new asset using old geometry-error tables.

### Subsequent physics and sky work

`BREAKING_WAVES.md` now requires detached-shoal and shoreline surf driven by local
height/wavelength/depth, not a shoreline foam band. The current authored bed lacks
intertidal/shoal detail; runtime transport/breaking/swashing remains pending.
`ASTRO_NAVIGATION.md` specifies historical stars, Moon phase/light and optional
sextant lessons; the current600second loop cannot serve as its astronomy clock.
The distant long-crest report is source-confirmed: swell is deliberately narrow
(spread48). A broader directional spectrum/finite coherence needs a separate
height/energy-preserving comparison; shortening peak wavelength is not that fix.

## Daytime rendering corrections: underwater, terrain and Victory materials

Root retains the sole testing baton; direct agents supplied source and proposed
tests only. Held woodland assets/modules remain outside production.

- Underwater solar scattering no longer adds an unnormalized, unshadowed light
  pedestal. The homogeneous planar-column single-scatter integral clips at the
  water exit, has a cancellation-safe limit, normalized angular phase and bounded
  energy. A representative in-water point supplies vessel shadow; this is not a
  full shadowed volume integral. Native GPU values match independent CPU path
  quadrature across light/view angles, turbidity and surface exits.
- Caustic focusing uses finite-beam regularization, actual rendered-pixel
  footprints and mip-filtered slope fields. Folded local ray maps approach mean
  irradiance; depth fades continuously. This remains a local Jacobian
  approximation, not multivalued photon accumulation.
- Cliff detail now filters in its actual material-coordinate footprint, including
  oblique projections and the narrower frequencies introduced by crack thresholds.
  Unresolved grain returns toward registered aerial colour; filtered block noise
  is no longer thresholded into a dark crack everywhere. Bump inverses reject
  ill-conditioned geometry. No extra material noise octave calls.
- Iron3/8 receives authored rough oxide/cast relief, a small exposed conductor
  fraction and separate water-film highlights. Nonporous kind4 moisture probes
  collect and drain rain/spray/water film without absorbing it; crew kind3 stays
  unchanged. This is not a measured conservation finish or full GGX IBL.
- The user's bright submerged rudder exposed an air/water material-interface bug.
  Captured wood now uses relative water/substrate reflectance and no water-air
  film gloss or directional air-environment reflection. Hull15/rudder14 share this
  policy; tar/wood finishes, material IDs and helm pose remain distinct. Submerged
  iron loses its air-film lobe too. Underwater ambient remains approximate; direct
  material lighting is not a complete refracted incident-light solution.
- Vessel shadows use integrated tent weights and continuous blocker estimates
  without larger maps. Canvas transmission clears with zero coverage and is
  normalized once. Actual rendered review found a self-shadow lattice on curved
  sails: receiver planes now use raster-triangle normals while lighting retains
  smooth normals. Bilinear comparison footprints receive their own bounded
  plane-depth allowance, limited to one shadow texel. Native sloped-plane tests
  retain close opaque/canvas occlusion and the existing thin-rigging/edge gates.

Focused native checks pass. Ten frozen actual-scene comparisons cover underwater
hull/rudder, near-bed caustics, cliff, Victory guns and four sail/light angles;
no page/GPU errors. The first full run passed427/428: the old thin-rigging test
required90% centre occlusion independent of filter footprint. The new tent gives
88.84% for its two-texel strip. Replaced that cutoff with independent numerical
area quadrature of the rasterized strip under the contact tent (0.1% tolerance),
while retaining strong surface-vs-volume contrast. The focused oracle now passes.
Final complete production suite **428/428 PASS**, installed Chrome/native Metal,
root serialized,325.5seconds. Published as
`a86dc29906d37ea51c2a1d99a3e2abb9ecfa1886`; Pages39666411466 succeeded.
At20:01:37UTC, public HTML/manifest/all53assets matched tested bytes:
HTML667985bytes, SHA-256
`630a480eda1a3d992f771cf28ce416bafccd691c3a4aa5ac51f327feb9a69b04`.
Assets15875925bytes. Fresh visible Chrome rendered Victory's sail shadows with
no warnings/errors; `shots/rendering-corrections-public.png`. No physical-iPhone
performance claim.

## Wells Bay nearest approach

After publishing the rendering checkpoint, moved the closest Saba preset from
Ladder Bay to an offshore Wells Bay approach. The registered pack contains this
coastline but no explicit beach/port mesh. Saba Tourism describes Wells Bay's
small coarse black-sand beach, which changes with northerly swell:
https://www.sabatourism.com/tour-item/swimming-on-saba/ . The marine-park source
distinguishes this anchorage from modern Fort Bay harbor:
https://www.sabapark.org/downloads/SCF%20Yacht%20Brochure.pdf .

- New coast start(-1750,−7000), heading112°, shore target roughly(-1500,−6900).
  Swell travels22° in the separate X/Z convention,1.2m significant height/95m
  wavelength; bow and wave travel point into the bay. Wind retains the118°
  direction at5.5m/s so the approach is sailable.
- Corrected coast boat-camera yaw to a local forward look; free-view bearing
  remains absolute. Explicit camera, position, heading and sea links still win.
  Horizon/approach camera behavior remains unchanged. Choosing a new stage
  discards stale pose/helm/swell overrides; model and follower preference survive.
- Both models and their followers retain independent full-envelope draft checks.
  Native frozen renders verify default Niña/Victory, free view and explicit shared
  overrides, without GPU/page errors.42focused terrain/sharing/camera/fleet/startup
  checks pass. Six additional native Metal packaged-landfall, sailing-control,
  mobile-panel and independent-fleet checks pass. All three packaged pages render;
  no regression thresholds changed for this scene setup. Published as
  `3cbadc2bc15752673af2a62c04de13f2b07115e2`; Pages39669511100 succeeded.
  At20:23:13UTC, public HTML/manifest/all53assets matched tested bytes.
  HTML668690bytes, SHA-256
  `5c1507942765757d814e67539b0d8ed0d62c55f498e53614b250a69fa338c692`.
  Asset bytes remain15875925. Fresh visible Chrome renders both boats at Wells
  Bay with heading112° and no warnings/errors. Proof:
  `shots/wells-bay-public-verified.png`. Physical iPhone remains unqualified.
- This sets up incoming surf, but does not implement it: the2m-minimum authored
  bed and16m terrain grid still lack an intertidal profile. Shoaling/breaking,
  plunging fronts, foam transport and swash remain the next water-system work.
