# Seasick Simulator

Performance optimizations for [Noniv/web-ocean](https://github.com/Noniv/web-ocean).

A real-time WebGPU ocean with a wave-driven sailing ship, impact spray, deck wash, whitecaps, and volumetric weather. The caravel has three triangular lateen sails, a working helm, and boat, free-flight, and exterior cameras. Sea conditions, sunlight, and clouds can be adjusted and shared in a link.

[Open Seasick Simulator](https://healdgar.github.io/caravel-ocean-sim/).

[Try the Saba landfall MVP](https://healdgar.github.io/caravel-ocean-sim/?landfall=approach&boat=1).
Open **Landfall** to choose Horizon, Approach or Near coast, and compare clear air,
sunset, backlighting and sea mist. The world overview locates Saba; only this island
currently renders in 3D. [Longer-term geography and voyage design](LAND_SYSTEM_DESIGN.md).

![Saba landfall at sunset, rendered from aboard the caravel](docs/landfall.png)

![Looking toward the sun from 2.4 m above the water](docs/front.jpg)

| 75 degrees off the sun, 2.4 m up | Looking toward the sun from 30 m up |
|---|---|
| ![](docs/side.jpg) | ![](docs/high.jpg) |

## Run it

You need a recent Chrome with WebGPU and a reasonably capable GPU. On a laptop, force Chrome onto the dedicated GPU in the Windows graphics settings, or it will fall back to the integrated one.

Open `ocean.html` directly in the browser. `ocean.min.html` is the same page minified. Both include the ship's oak material and are self-contained.

To run from source:

```
npm install
npm start        # serves http://localhost:8080/
```

After editing anything under `js/`, run `npm run build` to regenerate `ocean.html`, `ocean.min.html`, and `docs/index.html`. The minified build strips WGSL comments and whitespace and minifies the JavaScript with esbuild. Building locally does not publish the changes; see [GitHub Pages build](#github-pages-build).

## Controls

| Input | Action |
|---|---|
| Click the canvas | Capture the mouse (Esc releases it). Holding the right mouse button also works. |
| Mouse | Look around |
| W A S D | Move in Free camera; A / D steer in Boat camera |
| Left / right arrows | Steer in Boat camera |
| X | Centre the rudder |
| B | Switch between Boat camera and Free camera; board from View ship |
| Space or E / Q or C | Up / down in Free camera |
| Shift | 5x Free camera speed |
| Mouse wheel | Change Free camera speed or View ship zoom |
| Drag in View ship | Orbit the vessel |
| Touch-drag the canvas | Look around or orbit in View ship |
| H | Settings panel: wind, swell, choppiness, turbidity, foam, sun, haze, clouds, exposure, bloom |

The free camera stays above the sampled water. The boat camera follows the hull; rough seas can overtop the gunwales and wash across the deck.

On mobile, both settings panels keep their **Hide** button above the scrolling controls. Sea settings temporarily covers the boat controls. Buttons have 44 px touch targets, and the layout follows the visible viewport, safe areas and keyboard. The optional Performance monitor starts collapsed; expand it for detailed timings.

URL parameters are handy for testing. `?w=2560&h=1440` forces the render resolution, `cam=x,y,z,yawDeg,pitchDeg` sets the camera, `fov=deg` sets the field of view, `ui=0` hides the HUD, and any settings key works too, for example `windSpeed=12&swellHs=2&sunElev=8`.

## Share your sea conditions

Open **Sea settings** and adjust the waves and lighting, then select **Copy share
link** in the top controls. The link includes every sea and lighting parameter,
boat length, beam, heading, speed, eye height, rudder setting, provisions, cargo, ship visibility,
wake/spray/deck-wash visibility, and the selected camera mode. Opening it restores those settings. The address
bar also receives the link; if copying is blocked, a selected text field lets
you copy it manually. Each copy captures your latest settings.

For crossing storm seas, select **Hella rough** in Sea settings: 28 m/s wind,
8 m swell, and extra foam. The sliders allow up to 32 m/s wind and 10 m swell.
[Try rough seas](https://healdgar.github.io/caravel-ocean-sim/?boat=1&windSpeed=28&windDir=123&fetchKm=300&swellHs=8&swellLength=95&swellDir=236&choppy=1.6&foam=1.7).
Links share the configuration; they do not freeze an animation frame or the
boat's travelled position.

## How it works

### Landfall MVP

Saba uses real Mapzen Terrarium elevation, resampled to a 32 m grid across an
8.192 km region. Its fixed 34,784-triangle mesh preserves the silhouette throughout
approach. Generated forest materials and instanced broadleaf crowns supply surface
detail; they are not aerial imagery or a reconstruction of historical vegetation.
The same sun, sky, atmospheric extinction and volumetric clouds light the sea,
ship and land. A cached terrain/cloud shadow field shades the slopes; foreground
cloud integration stops at terrain, allowing low cloud to veil the mountains.

The shore has approximate shallow-water tint, wave-contact foam and wet rock.
A swept hull-clearance constraint stops the ship entering the elevation-derived
coast. The underwater skirt is authored, **not surveyed bathymetry**. Deep-water
waves still lack coastal refraction, shelter and a physical surf solver.

All simulation clocks remain unchanged. This is a visual landfall slice: no ports,
docking, river currents, voyage compression, terrain streaming or complete grounding
model yet. The future target remains 15–20 minutes of offshore passage.
The source packs, licenses, checksums and rebuild instructions live in
[`assets/world/README.md`](assets/world/README.md). Both single-file builds embed
the island and world chart. The regular ocean scene does not allocate terrain GPU
resources. The existing automatic 30 FPS resolution target remains active; combined
land/ocean performance still needs a physical iPhone measurement.

### Waves

The sea is a Tessendorf FFT simulation with six cascades of 256 by 256 samples. The patches range from 1103 m down to 0.26 m, so wavelengths run from about a kilometre to a few millimetres. The smallest cascade produces the sharp sun sparkles near the camera.

The spectrum is a fetch-limited JONSWAP wind sea with Donelan-Banner directional spreading, plus a narrow long-crested swell. Dispersion includes the capillary term, and choppy horizontal displacement sharpens the crests. Spectrum evolution feeds directly into the first radix-2 inverse FFT in workgroup memory, followed by the column FFT.

The surface mesh is a CDLOD quadtree with 17 levels. Vertices are 6.25 cm apart near the camera and the mesh reaches 160 km, with continuous vertex morphing between levels.

### Caravel model

The procedural hull follows the Martínez-Hidalgo Niña reconstruction, with a finer bow, curved stem, full midbody, modest tumblehome and finer
underwater stern. [Research, sources and historical limits](CARAVEL_RESEARCH.md)
distinguish the authored interpretation from measured reconstruction offsets.
The earlier [generated reference](assets/caravel-design-reference.png) remains
art direction only.

One continuous main deck and a partial raised quarterdeck replace the tall
forecastle tier. Two small recessed stern lights replace the ornate window
rows. Four rail-mounted swivel falconets follow the Mariners’ Museum Niña
model's equipment list. They are modeled cannon, without firing mechanics.
Three single masts carry triangular fore, main and mizzen sails. The previous square fore/main configuration is preserved in `SQUARE_RIG_PLAN` for a future model; it is not the active rig.
A direct tiller replaces the wheel, beneath the quarterdeck. Topsails and large
mast baskets are removed. Raked masts, a shorter bowsprit and runners follow this
interpretation; exact offsets and complete period sail handling remain approximations.

The hull, camera, shadows, water exclusion, spray contacts and deck wash share
one geometry definition. Indexed mesh records preserve normals, material and UV
seams; no imported ship model or Blender dependency is required.

### Ship's company and captain's orders

Twelve named sailors are aboard: six women and six men, using distinct
Quaternius-derived models. The deliberately diverse company includes Black,
white and East Asian appearances, two redheads, and individual skin tones, hair,
head/jaw shapes, nose profiles and eye openings. Appearance is fixed per sailor
and independent of role. Clothing, heights and animation phases also vary. Six tend short, separate routes on the main deck;
the others hold lookout, quarterdeck and helm stations. Strong wind, heel or roll
rate interrupts normal duties with a crouched brace. Each sailor uses the same
replaceable local decision policy, independently of rendering.

Open **Captain** for a separate orders panel: **Make full sail**, **Reduce sail**,
**Furl all sails**, **Prepare for heavy weather**, or **Resume sea watch**. These
are shipwide objectives, with no individual position controls. Sail orders select
wind-driven propulsion and assign work. Fore/main changes wait for an aloft
rigging hand and a deck hand at the halyard; the mizzen uses its quarterdeck hand.
Heavy-weather preparation requests 20% fore/main canvas, furled mizzen, and
a carpenter to close the visible weather hatch. Returning to watch retains sail settings.
Manual sail sliders remain in Boat perspective and supersede an outstanding order.
The captain panel has a persistent Hide button and scrollable roster; it opens
separately from boat and sea settings on mobile.

**Show crew** is a display switch, preserved in shared links as `crew=0/1`.
Hiding characters or the ship does not stop their simulation or sail orders.
Hulls below 10.5 m long or 3.2 m wide hide the company because these authored
stations no longer provide sufficient clearance.

The original Quaternius crew remains the active asset family. Workwear has a
looser shirt silhouette, sewn collars and rolled cuffs, and trousers that bridge
the pelvis and seat rather than following the unclothed body sculpt. Smoothed
centre-seam normals avoid artificial creases. Heights, body skin weights,
joint lengths, animation curves and hand targets are preserved; the belt follows
the adjacent garment weights through bends.
Both embedded GLBs total 2.21 MB. Each has 65 joints and Idle, Walk and Brace
clips; the male model has 15,995 triangles, the female 18,720. Twelve sailors use
two instanced draws in the ship pass and two in the existing solid shadow pass,
with independent bone palettes. They receive ship/sail shadows. No render pass
is added. The 30 FPS automatic-resolution target remains active; the expanded
crew's physical-iPhone performance has not yet been measured.

Crew follow bounded authored routes, yield to nearby bodies, climb the rendered
runners with procedural two-bone IK, haul shared tackle leads, then return to
stations. The lookout periodically climbs a foremast runner, below the mast head.
Dangerous heel, roll rate or strong wind pauses work; climbers retain their holds.
The helmsman follows the tiller beneath the quarterdeck. Nearby sailors become progressively transparent
in the first-person camera; shadows and exterior visibility remain intact.

This is an executable local job system, not a general planner or a historically
exact reefing drill. Free navigation, yard crawling, fatigue, anchor deployment,
cannon firing and autonomous steering remain
future work. The policy can choose work, wait or brace; safety remains in the
executor. No remote decision service or new rendering pass is added.

[Asset provenance and rebuild instructions](assets/crew/README.md) retain the CC0
licence, source revision and checksums. [Crew and decision-system design](CREW.md)
describes the larger decision and work-execution system.

The **Meshy replacement experiment is shelved** in favour of refining the
original crew. The local **Meshy 7.1 CLI** remains available for future requests:
`npm run meshy -- help`. It reads credentials from 1Password, preserves generation
requests and task IDs locally, downloads GLBs/PBR maps with checksums, and checks
rig compatibility. Image-guided generation uses references with a shared outfit
and T-pose; body type changes anatomy only. [Meshy authoring workflow](assets/crew/MESHY.md) covers the
male/female presets, paid submissions, recovery, native remeshing and auto-rigging.
The generated candidates failed visual review and remain archived locally.
Shipped models use the refined original geometry, rig and animations; no Meshy
body or replacement renderer is included.

### Wake, bow waves and spray

Thirty-two bow probes and eight aft probes intersect the moving hull with the horizontally displaced FFT surface. Continuous hull pressure scales with speed squared and produces paired crests/troughs even on flat water. A raised, contact-attached bow ribbon shows the immediate water parting, with speed-dependent breaking froth; it samples the evolving wake height so it stays above its own displacement wave. Water rising relative to the hull, filtered over a 0.65 m patch to suppress tiny ripples, launches finite-lived curved bow sheets into world space; they spread, tear at the lip, fall, and expire between impacts. A dry bow stops emitting, while a stationary hull still responds to rising crests. Normals come from the planking gradient; relative closing speed produces bounded quadratic impact forcing. Adjacent contacts create broad sheets, while delayed mist is born along their airborne lips. Receding water or a stronger new strike re-arms the next burst; sheet landings add foam.

A boat-centred 256 × 256 local wave grid adds displacement and slopes to the ocean. It retains disturbances in world space as the ship moves. Bow and stern foam and droplet landings feed the existing foam clipmaps. The buoyancy probe samples the same added height. Impacts inject outward-travelling crest/trough pulses. Gravity, drag, water collision, 128 sheet slots, and 4,096 secondary particle slots stay on the GPU.

The stern wake uses its own waterline contacts, so lifting the stern clear of the sea stops stern entrainment even while the bow remains wet. A transom trough and recovery crest, plus quarter-hull pressure, feed the outgoing waves. Foam production follows actual forward speed and the speed-to-hull-length ratio. It forms a broken trail, drifts through a small eddy field, spreads and fades along the travelled path; turning does not rotate old foam with the ship. Fresh bubbles fade faster than the lingering surface foam. These authored rates are a visual approximation for a displacement vessel, without a propeller jet.

Wake transport reuses the existing grid, textures and compute dispatch. The immediate bow ribbon adds one small draw of 120 triangles in the existing effects pass, using the existing waterline contacts and wake texture. It adds no full-screen pass or particle population. The 30 FPS automatic-resolution target remains active. Physical-iPhone performance of this change has not been measured.

**Wakes & spray** toggles the effect, also preserved as `effects=0` or `effects=1` in shared links. Changing sea spectrum or hull dimensions resets contact history to avoid false impacts. The grid uses a damped wave approximation with bounded forcing; it does not model full hull hydrodynamics, planing, or a physically exact Kelvin wake.

Technique references: [Noniv/snowflow_demo](https://github.com/Noniv/snowflow_demo) for curling sheets and separate spray populations; [booherbg/clean-room-fft-ocean](https://github.com/booherbg/clean-room-fft-ocean) for ocean/contact-driven spray; [bob6664569/open-water](https://github.com/bob6664569/open-water) for persistent world-space wakes. [NUS CRISP's ship-wake overview](https://crisp.nus.edu.sg/~research/shipwakes/shipwakes.htm) distinguishes the outgoing wave pattern from the turbulent trail and near-hull foam. This implementation uses native WebGPU/WGSL and adds no runtime dependencies.

### Wind-blown crest spray

**Sea settings → Crest spray** controls spindrift independently of **Wakes & spray** and ship visibility. It is on by default; `spindrift=0` disables it, and shared links preserve the setting. The default 7 m/s wind emits none. Strong wind tears intermittent mist trails from breaking crests; the rough-seas preset makes them more frequent.

Emission samples the actual FFT displacement and compression, filtered over a 0.65 m patch. World-anchored candidates locate a ridge across its compressed direction and verify that its peak rises above both shoulders, 1.4 m away. Compression on a flat surface, trough or sloping face is insufficient. Wind response begins above 8 m/s and reaches full strength at 19 m/s; stronger breaking produces wider, more energetic bursts.

Each burst tracks its moving crest for up to 0.28–0.60 seconds, ending emission early if breaking stops. Four overlapping mist volumes follow a low trajectory, stretch downwind, then detach, disperse, settle and collide with the sea. Three density samples through each visible volume soften its entire boundary, including the underside; camera-facing bounds contribute no opacity. This removes the old upright cards and their straight bottom edges. Sky illumination and normalized sunlight scattering replace the excessive orange sheet lighting. Births and attached sources avoid the ship's enclosed footprint; clouds, vessel shadows and scene depth affect appearance, and airborne spray still deposits moisture on the ship. This is a visual spindrift model, not calibrated droplet-size physics or a sea-spray flux prediction.

The GPU owns at most 1,024 bursts in a 70 m emission radius, with 0.9–2.0 second lifetimes. Each uses 96 bytes of state and eight triangles. Projected volume bounds are limited; candidates behind the camera are rejected and water collision checks are staggered. Obsolete sheet-foot wave samples are removed. Rendering uses the existing effects pass, with no additional full-screen effect or readback. Calm wind or a disabled control skips the compute and draw after one clear. Spectrum changes and camera teleports reset the population. GPU fixtures check ridge-only births, travelling-crest attachment, detachment, wind response, frame-rate consistency, hull exclusion, wetness, and soft volume boundaries viewed from every axis. The existing 30 FPS automatic-resolution target is unchanged; physical-iPhone performance remains unverified.

Physical basis: [Anguelova et al., *Spume Drops Produced by the Wind Tearing of Wave Crests*](https://journals.ametsoc.org/view/journals/phoc/29/6/1520-0485_1999_029_1156_sdpbtw_2.0.co_2.xml) links production to breaking crests; [Andreas, *A New Sea Spray Generation Function for Wind Speeds up to 32 m/s*](https://doi.org/10.1175/1520-0485%281998%29028%3C2175%3AANSSGF%3E2.0.CO%3B2) discusses uncertain onset and production rates. These motivate the wind-and-breaking gate; the rendering rates and trajectories are authored.

### Deck wash and buoyancy

A 32 × 96 hull-local water field samples the displaced sea at the rails. Overtopping adds water at the edges; four bounded downhill-flow substeps carry it across the deck and out through modeled scuppers. The raised quarterdeck has its own floor height, and the cabin blocks flow between the two deck levels. Translucent wash, frothy fronts, inward curtains, and falling runoff strips share the scene lighting. A finer 64 × 192 rendering mesh and smoothed height gradients keep reflections from exposing the simulation grid. Timber darkens and stays glossy after the water drains, then dries. The existing **Wakes & spray** switch also controls deck wash.

The field uses float32 storage with explicit bilinear sampling, requiring no optional GPU features. Depth is capped at 1.2 m: this is a visual surface-water approximation, not a vessel flooding, capsize, or flood-mass simulation. Runoff does not yet deposit separate splash particles on the sea. Buoyancy follows sampled wave height and velocity with bounded prediction for readback latency; new sea presets place the hull at its loaded draft relative to the sampled surface. Large crests can still overtop it.

### Wet timber, rigging, canvas and crew

Porous surfaces retain moisture where waves, deck wash or spray actually reach
them. Hull planks, rails, masts, yards, ropes and sails carry their wet patches
when the ship moves or the rig furls. Sheltered deck surfaces use retained deck
water instead of the external ocean height; the quarterdeck protects the tiller
space. Wind alone does not wet the upper rigging.

Wet timber darkens and becomes more reflective; a fresh film softens fine grain
normals and adds sheen. Rope darkens but stays rough. Canvas darkens while
remaining matte, with a modest reduction in optical scattering shared by its
backlighting and transmitted shadows. Reduced wet-fabric reflectance follows
[the observed effect of water on textile scattering](https://onlinelibrary.wiley.com/doi/10.1002/app.1973.070170317);
the coefficients here are authored, not measurements of historical sailcloth.
Crew use four moving exposure probes each: clothing darkens, with a smaller
fresh-water highlight on skin.

Surface film fades within seconds; absorbed moisture dries over minutes, faster
in wind. Rope dries slower than wood, canvas faster. These are visual rates:
absorbed water does not yet change sail weight, drape, strength or ship stability.
Spray exposure uses a transient 24 × 32 × 48 grid around the vessel, populated by
the existing impact sheets, droplets and crest plumes. Around 9,000 material
probes interpolate wetness across the mesh; sea contact uses a 32 × 32 cache of
the displaced six-cascade ocean. The extra GPU storage is below 1 MB and adds no
draw passes. Fine spray occlusion and detailed cloth/skin absorption are
approximations. Disabling ship effects clears wetness and skips its updates.

### Shading

- Mip-mapped first and second moments of the wave slopes (LEAN mapping) give the right anisotropic roughness at every distance. The sun glitter widens with distance and the far sea settles into a sheen without aliasing. Screen-space slope derivatives add specular anti-aliasing.
- Sun glitter uses an anisotropic Gaussian slope distribution with Smith masking and the size of the solar disc.
- The sky reflection comes from an environment cube map with roughness-filtered mips. One face and its mip chain refresh per frame; all six refresh on startup and after settings changes. At grazing angles the reflection direction is tilted to account for which wave facets the viewer can actually see.
- The water body is turbid blue-green, lit by the whole sky hemisphere. Backlit crests get a subsurface glow, and wind-gust patches modulate the short ripples.
- Whitecaps form at strong compression of the surface displacement field. Fresh breaking crests appear immediately, including near the camera; two world-space maps (128 m and 1 km wide) retain their fading, drifting foam. Bounded production and decay prevent accumulation beyond full coverage. The Foam control changes production rather than lowering the breaking threshold. A procedural bubble texture gives dense foam structure while retaining thin translucent trails.

### Sky

The atmosphere follows Hillaire's approach, with transmittance, multiple-scattering, and sky-view lookup tables plus aerosol haze. All clouds use a native WGSL adaptation of [Joshbrew's volumetric renderer](https://github.com/joshbrew/webgpu_realtime_clouds), pinned to `bf7a48f949e25e09d463357149ec9d0009e97328`. The rounded cumulus/anvil density model and cached lighting are adapted from its shaders. [Provenance and MIT license](THIRD_PARTY_NOTICES.md) are retained locally and embedded in all standalone builds.

A periodic 128 × 64 × 128 density volume contains connected billows, eroded edges and developing anvils. A second volume stores sun visibility, surface lighting and ambient occlusion. Coverage, depth and storm development rebuild density; sunlight and optical density changes rebuild lighting. Wind continuously advects both fields together without rebuilding them or resetting at the FFT loop boundary. Four mip levels filter distant samples. These are procedural cloud forms, not a meteorological fluid simulation.

The camera raymarches 64 intervals at reduced resolution, capped at 1280 × 720, and reconstructs the result over time. Reprojection accounts for camera translation, rotation and cloud advection; neighborhood clamping and depth rejection limit ghosting. Settings changes, resizing and camera jumps invalidate history. Fast camera movements can still reveal reconstruction noise, and the finite cloud field repeats over 16 km.

Camera rays, the ocean environment cube and direct-sun visibility sample the same cloud material. Clouds receive the existing atmosphere's sun and sky colours, including sunset and distance haze. Reflection rays are evaluated independently at a lower ray budget. The visible solar disc and direct lighting on the boat, sails and water share full-precision cloud transmittance. The disc bypasses reconstructed cloud alpha, whose early-termination residual previously left a bright sun visible through clouds that shaded the vessel. Sun occlusion is averaged across the disc near the camera and applied to the scene; this does not yet produce spatial cloud-shadow patches across the sea.

**Sea settings** includes Cloud coverage, Cloud base, Cloud depth, Cloud density, Storm development and Cloud quality. Shared links preserve them. **Hella rough** also selects low, deep storm clouds. The quality control adjusts screen ray resolution; it does not change the cached volume resolution. The old flat cloud veil has been removed from the sky, reflections and sunlight occlusion. Zero cloud coverage clears the sky; legacy `veil` URL parameters are ignored.

### Post-processing

The scene renders in HDR with 4x MSAA. Post-processing adds up to 8 levels of bloom, AgX tone mapping, a slight white balance shift, and dithering. Small render targets use only the mip levels they support, and setting bloom to zero skips its blur passes.

## Performance

The original renderer measured about 6 to 8 ms per frame at 2560 by 1440 on an RTX 5070 Ti, while other programs were also using the GPU. The HUD shows actual animation-frame cadence, plus GPU timestamp intervals when the browser supports `timestamp-query`. FPS uses elapsed wall time independently of the simulation's 100 ms timestep limit, so rates below 10 FPS remain visible.

The render loop reuses large typed arrays and GPU resources, keeping most recurring allocations small.

Volumetric clouds add raymarching and reconstruction work. If frame rate drops at maximum **Cloud quality**, lower that setting or the render resolution. Cloud quality changes the screen ray resolution, while the cached density and lighting volumes remain fixed. The older RTX timing above predates these cloud and vessel effects and is not a current performance guarantee.

**Render resolution** in Sea settings defaults to **Auto · 30+ FPS**. It measures delivered animation-frame cadence, lowers resolution after sustained frames slower than the 30 FPS target, and aims for roughly 33 FPS when reducing pixels. It waits two seconds after startup or a resize, ignores isolated stalls and hidden-tab time, and restores resolution in small steps only after sustained headroom above 42 FPS. The range is 35–100% of native width and height. Native, 75% and 50% overrides are also available.

Auto mode trades screen sharpness for frame rate; wave simulation, vessel geometry, shadows, effects and 4× MSAA stay enabled. Screen-sized render targets, including cloud reconstruction, follow the selected resolution. CPU limits, fixed GPU work or thermal throttling can still prevent 30 FPS at the minimum scale; the status shows when that floor is reached. Physical-iPhone results remain to be measured.

Use `resolution=native` for a fixed native-resolution comparison, or `resolution=0.75` / `resolution=0.5`. Explicit `w`, `h` or `shot` parameters disable automatic tuning so captures remain reproducible. Resolution is device-local and omitted from ordinary scene share links. The monitor and capture JSON record the active mode and scale.

The optimized frame schedule also avoids redundant GPU work:

- Fusing spectrum evolution with the row FFT removes two 6 MiB buffers, one dispatch, and 24 MiB of intermediate buffer reads/writes per frame.
- The sky-view LUT updates only when sun elevation, haze, or effective camera altitude changes. An unchanged sky skips 256 × 144 × 48 atmospheric integration steps.
- Updating only the changed reflection face removes five-sixths of the steady-state cube mip filtering work.
- The water-height probe runs only when its result will be read back, and disabled bloom skips all 15 blur passes at normal resolutions.
- At that revision, exact caravel vertex reuse reduced its main vertex/index buffers from 9,086,472 to 4,894,512 bytes (46.1%). Including the unchanged-size shadow index buffers, total mesh-buffer storage fell 41.5%; all 84,134 triangles were retained. The later hull revision changes the geometry and triangle count.
- With the ship visible, the ocean pass resolves directly into the water-reflection texture. This removes one full-screen RGBA16F copy (8 bytes per pixel read and written), preserving 4× MSAA, HDR precision, and every reflection mip. With the ship hidden, it resolves directly into the final HDR texture.
- Water inside the hull exits before shadow filtering, reflections, lighting, and atmospheric shading. Implicit texture gradients and wave/foam derivatives are evaluated first, preserving water-mask edges and all visible shading. This removes work on pixels that were already discarded; shadow sample counts and render quality stay unchanged.
- The slope-moment texture also carries the cross derivative in its previously unused alpha channel. Ocean fragments read 12 rather than 18 wave-cascade texture samples, with identical half precision, mip filtering, anisotropy, and wave detail. Displacement data remains available to geometry, foam, and buoyancy.
- Ocean visibility is resolved by default with a cheap depth draw before shading, within the same render pass. The full surface shader contains no discard and uses an equal-depth test, allowing hidden water to be rejected before its texture sampling and lighting. Both draws use identical, invariant vertex positions, the original hull cutout, and 4× MSAA. This adds a geometry draw in exchange for avoiding hidden-fragment work; `oceanDepth=0` restores inline visibility for comparison.

These changes target memory and GPU work. Frame-rate benefits depend on the adapter and scene; the device observations below are not controlled benchmarks.

### GPU profiling

Add `profile=1` to any scene URL for an opt-in timing overlay. It samples waves/effects, sky/clouds, environment reflections, solid/canvas shadows, ocean, reflection filtering, ship/spray, bloom, and composite every eight frames when `timestamp-query` is supported. Normal mode retains the original single compute pass; detailed mode splits it into three for measurement. Unsupported devices render normally and report that timing is unavailable.

The default overlay identifies `Ocean visibility: depth first`. The previous `inline` path remains available with `oceanDepth=0`; `oceanDepth=1` explicitly selects the default. Compare the same resolution and scene. Both visibility and shading remain within the `Ocean + sky` span; the new stage does not introduce a render-pass boundary. Capture JSON records `oceanDepth`, and ordinary share links omit this diagnostic flag.

Values are GPU **spans**, not exclusive costs: render stages can overlap or wait on earlier work, especially on tile GPUs. Pass times must not be added; bloom reports its enclosing span. Detailed mode's **sampled GPU window** runs from the earliest measured pass start to the latest measured end, including stages that begin before the first compute pass. It includes waits and is not a frame-rate measurement. Normal mode's cheaper **GPU endpoints** interval covers only first-compute start to composite end. These are different metrics; compare matching modes and use actual FPS/frame cadence for performance. Browser timestamp quantization can round short passes to zero. The overlay also shows render dimensions and device pixel ratio.

For a reproducible local capture, use `?view=ship&profile=1&w=1280&h=720&shot=gpu-check.png&frames=600&sunElev=35&sunAzim=30&boatSpeed=6`. The development server saves the image and `shots/gpu-check.json`, containing scene parameters, per-pass samples, median and p95 frame spans. Samples start at frame 120 and retain at most 512 entries. Screenshot runs use a fixed simulation timestep; asynchronous hull readback can still produce slight pose differences between runs. Close other active GPU scenes before comparing. These diagnostics remain local; GitHub Pages cannot save captures.

The initial October 2026 Mac comparison reported roughly 12 ms compute-to-composite endpoint intervals, incorrectly labelled whole-frame spans. Those figures are not comparable to the corrected sampled GPU window (capture format version 2). No sustained FPS improvement has been established. Confirmed benefits are reductions in buffer storage and scheduled GPU work. Waves, cloud quality, shadows, HDR, and antialiasing settings remain unchanged.

User-supplied iPhone 18 Pro screenshots of build `7d0f4d1`, with profiling enabled at the helm, showed 6.5 FPS / 153.8 ms at 1206 × 1998 and 15.4 FPS / 64.9 ms at 603 × 999. Quartering pixel count improved FPS about 2.4×, indicating substantial resolution-dependent cost. After packed wave reads (`a85cb45`), the full-resolution screenshot showed 8.6 FPS / 116.6 ms: about 32% higher FPS, still too slow. With depth-first visibility (`ea22474`), the next full-resolution screenshot showed 17.3 FPS / 57.7 ms, about twice the previous FPS. Depth-first visibility is now the default. These are individual observations, not a controlled benchmark; overlapping pass spans cannot isolate exclusive ocean, ship, or bloom costs. Those builds retained native resolution; Auto mode was added afterward.

## Validation

With Node.js 20 or newer:

```
npm ci
npx playwright install chromium
npm run build
npm test
```

The suite covers:

- Both crew rigs and grounded clip bounds, balanced twelve-person roster, deck clearance and separation, replaceable captain orders, gradual canvas changes, hidden-character independence, two six-instance GPU draws, animated shadows, embedded assets and mobile panel reachability.
- Crest-spray wind/breaking gates, displaced birth height, downwind entrainment, hull exclusion, bounded populations, 30/120 Hz emission, clears, real FFT emission and rendering independent of the ship and its wake toggle.

- Analytical FFT waves across all six cascades, steering, moving-water buoyancy response, hull geometry, and shared settings. Triangle intersections verify unobstructed recessed window panes, quarterdeck camera support and forward sightlines on resized hulls; camera checks cover windward boarding and smooth tack changes.
- Surge force direction, calm-water equilibrium, mass/inertia response, signed coasting, stale-probe decay, and travelling-wave integration from 10 to 120 FPS. GPU checks verify incident-slope averaging, short-chop filtering, wake exclusion from propulsion, and actual-speed coupling to wakes; shared links preserve the calm-water target.
- Sailing checks cover apparent wind, wind-angle-dependent drive, independent sail area, trim lag, gradual furling, coasting, mirrored heel/leeway, zero-time startup, and stable integration from 10 to 120 FPS. Wind-roll checks cover vertical shear, sail-height leverage, inertia, righting equilibrium, reefing, roll/pitch energy dissipation, short-chop rejection, long-swell response and sail damping of wave-driven roll. GPU checks exercise actual canvas vertices, finite normals, independent furling, independent yard poses and fixed deck leads; loaded versus slack motion, sewn-rope attachment, and physical triangle-to-rope clearance including rope thickness across both tacks, partial furling and complete yard transfers; application checks verify that torque reaches the hull transform and that furling lets it settle upright.
- Dry, stationary, moving, and tilted hull contacts; independent dry-stern/wet-bow contact; foam retention along a moving and turning track, decay after stopping, and eventual clearing; impact sheets; matching buoyancy heights; spray retirement and landing foam; and effect toggling.
- Gunwale exclusion of the external wave field, including crests above the rails; dry decks below the rails, foredeck and quarterdeck freeboard, overtopping, retained water, downhill flow, scupper drainage, eventual timber drying, bounded deep immersion at large time steps, and resets.
- Material-probe identity through mesh indexing and rig attachments; GPU contact/spray wetting, dry sheltered surfaces, retained deck wash, differential drying, film drainage, furling sails, moving crew, and resets. Rendered wet/dry comparisons and canvas-shadow samples verify that moisture reaches the visible materials.
- Bounded foam production and decay, cloud clearing/occlusion/advection, temporal-history invalidation, sky scheduling, bloom toggling, and resizing down to 1 × 1.
- Consistent HDR sun extinction, solid and translucent vessel shadows, sun direction, translated/tilted casters, self-shadow bias, and disabling hidden/night shadows. Water checks preserve broad shadows and canvas tint while dispersing fine rigging through the refracted scattering footprint.
- JavaScript and WGSL initialization in all three standalone builds.
- Adaptive-resolution convergence, cautious recovery, bounded scale, manual overrides and background/resume handling; actual GPU target resizing and fixed capture dimensions. Mobile checks cover unobstructed Hide buttons while scrolling, collapsed/expanded profiling, and six portrait, landscape and tablet viewports.
- Bit-exact indexed geometry and shadow partitions; pixel equality between the original copy/unindexed schedule, direct resolve/indexed rendering, and profiled rendering; actual slow-frame FPS, timestamp readback, overlapping/early render stages, stale disabled queries, quantized zero intervals, invalid timestamps, and unsupported-device fallback.
- Pixel equality before/after early hull exclusion, both with the water cutout exposed at the helm and with the complete ship visible from outside.
- Analytical cross-derivative values and pixel equality between separate and packed wave-texture reads, at sunset and in rough seas.
- Exact MSAA coverage comparison between inline and depth-first ocean visibility. Shaded comparisons cover exposed hull edges, rough seas, free-camera water, and unmasked debug views; they bound rounding/edge differences to sub-quarter-level RMS on a 0–255 channel scale, rather than asserting bit equality. Resolution, wave cascades, texture filtering, shadows and antialiasing remain unchanged.

GPU fixtures default to SwiftShader and an offscreen render target, so a physical GPU or window system is not required. To use an existing Chromium installation, set `CHROMIUM_PATH` (for example, `CHROMIUM_PATH=/usr/bin/chromium npm test`). On macOS, `WEBGPU_BACKEND=metal` selects the native GPU for local validation. The main GPU suite uses port 8082 by default (`TEST_PORT` overrides it); the independent rig-clearance fixture uses 8085 (`RIG_TEST_PORT` overrides it). Visual checks supplement these tests; neither software rendering nor Mac checks establish physical-iPhone performance.

## Known limitations

- Far water is still somewhat darker than the bright horizon sky above it.
- The water is tuned toward turbid coastal water. The "Water turbidity" slider gives darker, bluer deep water when turned down.
- The scene is open ocean with an optional fully modeled sailing ship. There is no shoreline, surf, or other vessels.
- Volumetric clouds can show reconstruction noise during fast movement and repeat over a 16 km field. Direct-sun occlusion is sampled near the camera; moving cloud shadows are not yet projected across the sea.
- Deck wash is a bounded visual model. It does not add floodwater mass, simulate capsizing or complete underwater immersion, or create separate runoff landing splashes. Severe crests can still overtop the hull and fill the deck-water field up to its 1.2 m depth limit.
- Vessel shadows retain the nearest canvas layer; overlapping sails do not multiply their transmission. The finite map resolution and bounded soft filter can alias very thin rigging, especially on enlarged ships. The ocean receives vessel shadows but does not cast wave shadows onto the ship.
- Underwater vessel shadows use a bounded local-surface scattering approximation, with authored optical depth and spread. They do not simulate underwater caustics or full multiple scattering.

## How it was made

The upstream README credits Claude Code (Opus 5.5), with headless Chrome screenshots and separate critic reviews. Its account describes an earlier version that replaced volumetric clouds with flat layers. This fork retains the native WebGPU architecture and adds the caravel, steering, hull interactions, deck wash, and the Joshbrew-derived volumetric clouds described above.

## Repository layout

| Path | Contents |
|---|---|
| `index.html` | Page shell, HUD, and settings panel styles |
| `js/main.js` | Device setup, resources, camera modes, per-frame loop |
| `js/profiler.js` | Optional GPU pass spans, sampled frame timing, and local capture statistics |
| `js/resolution.js` | Device-local render scaling toward 30 FPS from delivered frame cadence |
| `js/boat.js` | Wave response, steering, and world-space eye position |
| `js/sailing.js` | Shared sail plan, apparent wind, automatic trim, sail handling and aerodynamic forces |
| `js/lateen.js`, `js/wgsl/lateen.js` | Independent lateen poses, sequential yard transfers, sheet leads and matching CPU/GPU motion |
| `js/rig-plan.js` | Digitized d’Albertis lateen sail/mast coordinates and uniform hull-scale conversion |
| `js/gltf.js`, `js/crew.js`, `js/crew-work.js`, `js/crew-pose.js`, `js/rigging.js`, `js/wgsl/crew.js` | Bounded GLB loading, clip blending, deckhand execution, GPU skinning and shadows |
| `assets/crew/`, `scripts/prepare-crew.mjs` | Self-contained sailor asset, CC0 provenance and reproducible preparation |
| `js/interaction.js` | GPU hull contacts, wake grid, spray resources, and effect passes |
| `js/spindrift.js`, `js/wgsl/spindrift.js` | Wind-driven breaking-crest mist, bounded GPU population and soft volume rendering |
| `js/deck.js`, `js/wgsl/deck.js` | Retained deck water, drainage, wetness, wash shading, and runoff strips |
| `js/wetness.js`, `js/wgsl/wetness.js` | Persistent material moisture, spray exposure, cached sea contact and crew probes |
| `js/clouds.js`, `js/wgsl/clouds.js`, `js/wgsl/cloud-model.js` | Volumetric cloud resources, density and lighting caches, raymarching, and temporal reconstruction |
| `js/sharing.js` | Shareable scene settings, camera modes, and storm preset |
| `js/caravel.js` | Hull, continuous foredeck, quarterdeck, swivel cannon, lookout, rigging, sails, and helm geometry |
| `js/shadows.js`, `js/wgsl/shadows.js`, `js/wgsl/vessel.js` | Boat-relative sunlight shadow maps, cloth transmission, and shared visible/caster rig deformation |
| `js/hull.js`, `js/wgsl/hull.js` | Shared hull section for visible geometry, water masking, and bow contacts |
| `assets/` | Neutral oak texture, optimized WebP, and generation prompt |
| `js/wgsl/` | Shaders as JavaScript modules, including waves/foam, atmosphere, ocean, timber, and post-processing |
| `server.mjs` | Tiny static server for development |
| `build.mjs` | Builds all three standalone pages and embeds third-party notices |
| `docs/` | Generated GitHub Pages demo, `.nojekyll`, and README images |
| `tests/` | Boat math, geometry, sharing, GPU behavior, and standalone startup checks |
| `THIRD_PARTY_NOTICES.md` | Joshbrew shader provenance and MIT license |

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Boat perspective

Choose **Boat camera** in the always-visible camera controls, or open `ocean.html?boat=1`.
Set length and beam in metres, heading in degrees (0 along the
original view, 90 to the right), and camera height. The camera moves with the loaded hull.
The default hull is **20 m long × 6 m beam**, excluding the bowsprit. The original
12 × 3.6 design frame is converted to metres with a shared 5/3 vertical scale;
length and beam controls set the other two axes. Decks, rigging, ocean exclusion,
spray contacts, deck wash, shadows and crew anchors use the same transform.
The cabin doorway is about 1.97 m high, cabin headroom 2.27–2.57 m, and the mainmast
about 11.0 m above the main deck (see the sail-plan audit). Twelve quarterdeck ladder treads keep risers
below 23 cm. Crew retain their 1.71–1.80 m adult heights. The helmsman works a
waist-height tiller on the main deck beneath the quarterdeck, facing aft and
following its swing. The captain's camera stands near the forward windward
corner of the quarterdeck, ahead of the mizzen and beside the centreline masts.
It looks 15° outboard of the bow to see past the sail edges and crosses smoothly
to the opposite side after a tack, keeping the billowing canvas leeward.
Boarding selects the current windward side immediately. Ship
geometry remains visible. Nearby sailors fade
using depth-correct screen-door transparency between 1.4 and 4.8 m from the camera.
All remain visible in exterior/free views and continue casting shadows.

The default eye is **about 5.35 m above the loaded waterline**, 1.6 m above the quarterdeck;
its fore/aft and lateral position follow hull length and beam. Shared links preserve explicit
dimensions and eye heights. Remove `boatLength`, `boatBeam`, and `boatEye` from an
older link to use the enlarged defaults, or set them to 20, 6, and 5.43 respectively.
The helm controls the rudder; mouse look is relative to the boat. **Look ahead**
centres the view. Choose **Free camera** or press **B** to leave the floating viewpoint.
Choose **View ship** for a level exterior view that follows the ship: drag to orbit
and use the mouse wheel to zoom. The vessel continues sailing in all camera modes.
For repeatable exterior captures, `orbitYaw`, `orbitElevation` (degrees), and
`orbitDistance` (metres at the default hull size) set the initial orbit; ordinary
shared links omit these capture controls.

Heave follows a 3 by 3 grid of displaced FFT heights plus the local wake. Measured
vertical water velocity and bounded readback prediction reduce lag on rising water.
Roll and pitch instead integrate hull inertia, restoring torque and damping against
incident-wave slopes filtered over the hull footprint. Short visible chop no longer
prescribes angular velocity, and the ship does not rock itself through its own wake.
Forward speed evolves under wave pressure, propulsion, quadratic resistance, and
ship plus added-water inertia. **Sailing** is the default: the ship starts from rest
on a beam reach and accelerates under its sails. Heading, wind speed, apparent wind,
trim and exposed canvas determine its drive. The panel shows actual speed and estimated
displacement; steering, wakes and spray use that speed.

**Fore course**, **Main course** and **Mizzen sail** independently set 0–100% canvas.
The separate **Captain** panel issues **Make full sail**, **Reduce sail** and
**Furl all sails** across all three groups. Handling takes
about 5.6 seconds of attended work from fully set to fully furled, plus travel
and climbing time (roughly a minute for the first complete fore/main operation). The percentage readouts show actual
canvas while the sliders show the requested amount. Each lateen gathers along
its diagonal yard. Each sail trims around that yard with an independent sheet angle;
the yards remain fore-and-aft on the leeward side of their masts. Loaded canvas holds
its camber; rapid luffing belongs to slack or poorly trimmed sails. Sewn edge ropes
follow the same deformation as the cloth.

A sustained change of tack initiates a crew-attended maneuver: gather all canvas,
align the bundles, raise and steepen one yard, pass it abaft its mast, lower it,
then repeat for the other yards. Once all three are across, the crew sheets and
sets the captain's requested canvas. Handling takes about a minute after the deck
hands arrive; climbers descend before runners are eased. The ship loses sail drive
while canvas is gathered and keeps its momentum and wave response. Readouts show
actual exposed canvas and the Captain panel reports the maneuver.

Both quarters carry sheet leads. The working sheet changes with tack; the lazy
sheet hangs below the foot and returns across the deck. Halyards support fixed
slings along the yards, with separate tack lines at their forward heels. Windward
runners remain taut; leeward runners and paired running stays gather beside their
masts. Rope geometry stays continuous in the visible and shadow passes: there are
no intersection masks or contact dimples. The fore stay remains led to the bowsprit.

The operating rig is an authored, reconstruction-guided kinematic approximation,
not a rope-tension or cloth solver. Its sheet leads, released-runner curves, yard
hoists and handling drill are not recovered Niña specifications. See
[the reconstruction notes](CARAVEL_RESEARCH.md#operating-rig).

The sail readout reports the point of sail, apparent wind speed and its direction
relative to the bow. Apparent wind subtracts the ship's forward and sideways velocity
from the true wind. Lift and drag use dynamic pressure `0.5 * airDensity * windSpeed²`,
exposed area and authored angle-dependent coefficients. The active lateen rig loses
drive near headwind; the stored square plan uses a wider no-go angle. Lateral force produces
bounded leeway against hull/keel resistance and a heeling moment. Sailing resistance rises
above an authored Froude-number threshold. The basis is
[relative air velocity](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/relative-velocity/),
the [aerodynamic force equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/drag-equation/)
and [points of sail](https://www.rya.org.uk/training/do-you-know-your-points-of-sail/).
This is an approximate sailing model, not a measured caravel polar or cloth/fluid simulation.
It omits sail interference, weather helm, reefing penalties, gust loading and capsizing.

**Wind speed at 10 m** is the reference for a neutral logarithmic marine wind profile:
`U(z) = U10 * log(z / z0) / log(10 / z0)`, with fixed roughness `z0 = 0.0002 m`.
Each of the three sails samples wind at its current centre of effort; higher canvas
therefore experiences stronger wind and greater leverage. Furling changes both area
and centre height. Each lateral force contributes `-force * lever` about the hull's
loaded centre of gravity. Heeling
shortens projected sail area and leverage; apparent wind also subtracts the sail's
sideways velocity caused by roll. The profile follows the open-water approximation in
this [marine windage study](https://www.fws.gov/doiddata/dwh-ar-documents/876/DWH-AR0269040.pdf).

Wave and wind loads share one roll state:
`I * roll'' = windMoment + mass*g*GM*sin(waveAngle-roll) - damping*roll'`.
Pitch uses the analogous longitudinal waterplane righting moment. Both integrate
in substeps no longer than 1/120 second with implicit damping. Sail apparent wind
includes the velocity induced by this same roll, allowing aerodynamic damping as
well as steady heel. The effect depends on heading, trim and canvas; wind is not
an unconditional upright constraint. See [Kerdraon et al. (2020), sections 3.1 and 3.4](https://doi.org/10.1016/j.oceaneng.2020.107668)
for coupled rigid-body dynamics and rotational apparent wind.

The loaded hull determines mass, centre of gravity and righting stiffness.
Effective radii of gyration, added-water inertia (20% roll, 50% pitch), baseline
damping ratios (0.50 roll, 0.70 pitch) and extra damping underway are authored
approximations. The default loaded vessel has small-angle undamped periods of
about 6.49 s in roll and 3.32 s in pitch. These are model values, not measurements
from the replica video. The panel reports wind torque. Set speed mode disables
wind torque while retaining angular momentum and wave response. Angles are bounded
at 60° because capsizing is not modeled. Atmospheric stability, directional wind
shear, unsteady aerodynamic hysteresis, bare-hull windage, wave diffraction and
full six-axis hydrodynamic coupling remain omitted.

Choose **Set speed** to retain the previous propulsion model. **Calm-water speed**
sets the thrust that balances resistance at that speed on flat water; waves still
change actual speed. A zero target lets the ship coast, including astern. Switching
propulsion modes preserves momentum. Old links containing `boatSpeed` without an
explicit propulsion mode retain this behavior and start at their selected speed.

The surge model uses the long-wave pressure-gradient approximation
`(mass + addedMass) * dv/dt = thrust - drag * v * abs(v) - rho * g * volume * slope`.
It follows the structure of the [Froude–Krylov surge-force model](https://arxiv.org/html/2406.12853v1).
The GPU averages incident-wave slopes over the hull footprint using all six FFT
cascades and filtered texture mips. Force follows the encountered waves and heading,
independently of the lagging pitch angle. The vessel's own wake affects buoyancy
but is excluded from surge forcing. Two spare values in the existing 64-byte probe
readback carry the mean world-space slope; no new texture, dispatch, or readback is
needed. Stale forces fade if probing stalls. Integration uses substeps of at most
1/120 second with implicit signed drag to remain stable at mobile frame rates.

Loading now solves displacement against a hydrostatic table integrated from the
canonical hull. The original **2.0 m design draft** calibrates approximately
**107.7 tonnes of vessel and permanent ballast**; this is an authored reference,
not a measured lightship weight or historical tonnage claim.

The default twelve-person departure manifest adds **7.94 tonnes**:

- Crew: 0.96 t (12 × 80 kg).
- Water: 3.60 t (60 days × 12 × 5 kg/day, including cooking).
- Food: 1.08 t (60 days × 12 × 1.5 kg/day).
- Casks/containers: 0.80 t; spare rope, canvas, tools and other stores: 1.50 t.

These are explicit provisioning assumptions. The resulting displacement is
**115.6 t**, draft **2.086 m**, and lowest main-deck freeboard **1.081 m**.
The supplied ship sits **8.6 cm deeper** than the former fixed waterline. Its
broad waterplane needs about 0.92 t to sink another centimetre near design draft;
ordinary provisions do not justify lowering it half a metre. For comparison,
the [modern Niña replica operator](https://www.ninapinta.net/) reports 7 ft
(2.13 m) draft; that different reconstruction is a scale check, not calibration.

**Boat controls → Supplies and cargo** adjusts 0–120 provision days and 0–40 t
of additional cargo; shared links retain both. Stores do not yet deplete with
elapsed time. Hidden crew retain their mass. Containers and spares remain aboard
at zero provision days. Additional cargo and stores are assumed secured low
amidships; there is no asymmetric trim, shifting cargo or tank slosh model.
Length and beam rescale fixed vessel mass, while the twelve-person manifest
stays fixed. Configurations exceeding the supported draft show **Overloaded**;
the non-flooding model retains at least 15 cm of main-deck freeboard and does not
simulate foundering.

Loaded mass drives surge inertia, draft-dependent drag and lateral resistance,
heave response, centre of gravity, hydrostatic righting and roll inertia. The
same vertical offset reaches rendering, camera, water exclusion, contacts,
deck wash, wet materials and shadows. Sail wind heights and torque arms use the
loaded waterline. No additional per-frame GPU pass or geometry is required.
Added mass is an authored 8% of displacement; effective resistance uses coefficient
0.012 and estimated wetted area. These coefficients are not calibrated to a historical
caravel. Hull-footprint filtering approximates short-wave cancellation; the model
does not solve diffraction, full depth-dependent pressure, detailed sailing aerodynamics,
wave-driven lateral motion, broaching, planing, or slamming.

Speed changes position and therefore the waves encountered. Live pitch, roll, and
heave remain visible in the panel. The existing wave-following response combines with
the wind-driven heel; both surge and wind roll have inertia. Wakes, impact spray and
retained deck wash follow the resulting motion.

Sailing URL options: `view=ship&propulsion=sail&sailFore=1&sailMain=1&sailMizzen=1`.
Sail targets are fractions from 0 to 1; shared links preserve them and the propulsion mode.
Manual example: `boat=1&propulsion=manual&boatLength=20&boatBeam=6&boatHeading=0&boatSpeed=6&boatEye=5.43`.
The legacy `windDir` parameter remains the wind's travel angle in the world's X/Z plane;
its source bearing in boat-heading coordinates is `(windDir - 90 + 360) % 360`.
Run `node --test tests/boat.test.mjs tests/sailing.test.mjs` for the motion checks.

### Full sailing ship

The complete vessel includes a rounded planked hull and keel, square transom,
stern cabin with windows, raised quarterdeck, bow and stern rails, bowsprit,
hinged hatch cover and grating, four swivel cannon, cleats, fittings, and a rudder that moves with the helm. Three
single masts carry three triangular lateen sails, with diagonal yards, stays and runners.
Their proportions are measured from d’Albertis’s 1892 Niña side elevation at our
20 m hull length: approximately **114 m² fore, 50 m² main, 16 m² mizzen**. The
foremost sail is largest. Mast positions follow the same drawing; a uniform
1.08 m lift clears the retained quarterdeck without stretching the sails.
These are reconstruction-based scan estimates, not known original Niña dimensions.
See the [measurement audit and orthographic comparison](CARAVEL_RESEARCH.md#sail-size-audit).
Canvas uses a two-sided cloth material and slight wind-driven flutter under the
actual sun and sky. Thin-sheet transmission produces a soft, warm glow around
the backlighting sun; seams, hems, folds, and grazing light paths transmit less.
Cloud shadows attenuate the glow. The fabric coefficients are authored visual
approximations, and the canvas retains depth occlusion rather than becoming
transparent to background geometry. Apparent wind and deployed canvas drive propulsion
in Sailing mode. Toggle **Show ship** or use `prow=0` to hide it.
**Hide** collapses the controls; camera selection remains visible. Geometry
scales with boat length and beam. The ship has an independent world position
and keeps its wave-following pose while the camera flies or orbits around it.

The PBR material uses the live atmospheric sunlight, cloud transmittance, sky
environment, and current ocean HDR image for visible water reflections and
approximate bounced light. Offscreen reflections use the environment cube;
its sea fallback follows cloud shadows. Diffuse lighting weights separate sky
and sea hemispheres by surface orientation, avoiding duplicate sea tint on
vertical timber. Neutral white balance preserves the oak colour across sunlight
settings; shaded and wet wood still pick up their surroundings.

Two 2048 × 2048 sun shadow maps track the moving vessel: one for solid timber,
metal and rigging, and one for canvas with its warm optical transmission.
The actual mesh casts onto the deck, hull, sails, displaced ocean, foam, deck wash
and spray. The shadow and visible passes share sail flutter, steering and hull
transforms. Filtered edges soften with caster distance; receiver-plane correction
limits self-shadow speckling on tilted surfaces. Direct sunlight is attenuated
while sky fill and reflections remain. This replaces the former analytic rail
shadow approximation. Hiding the ship or placing the sun below the horizon skips
the passes. `shadows=0` disables them for performance comparisons.

Water separates surface sunlight from underwater scatter. Sun glitter and foam
retain the geometric shadow; the water body's colour integrates 32 samples around
a refracted view ray, backtracked toward the refracted sun. Wave normals move this
footprint, and unresolved slope variance broadens it. Fine rigging therefore fades
and sail edges disperse instead of printing a crisp silhouette into the water's
diffuse colour. Thin crest transmission blends toward the surface result. The
authored mean optical path is 1.2 m; a conservative vessel-footprint bound skips
these texture reads elsewhere on the ocean. Deck and sail shading retain their
existing surface filter.

Visual references: the [Rolex Sydney Hobart aerial photograph](https://rolexsydneyhobart.com/race/2025/news/day-2/2025-rolex-sydney-hobart-afternoon-update/)
shows a broad shadow interrupted by rough-water highlights; [SilverTip](https://www.yachtingdevelopments.co.nz/media)
shows that shadows can still be sharply defined against sun glitter.
[Rendering Natural Waters](https://graphics.stanford.edu/courses/cs348b-competition/cs348b-01/ocean_scenes/ocean.pdf)
describes the distinction between surface reflection/refraction and water-volume
scattering. These inform the approximation, not a claim of calibrated optics.

All camera modes share the ocean depth buffer, so
water, hull, deck wash, bow sheets, and spray occlude each other consistently. A world-space
hull volume excludes the open-ocean surface inside the bulwarks and stern cabin,
including above rail height. Previously, crests above the rail could reappear
inside the deck without crossing a boundary, bypassing the gunwales and drawing
over the deck-wash field. Water aboard now comes from the deck solver's measured
rail overtopping, finite flow across the deck, retention and drainage. Buoyancy,
freeboard and sea presets are unchanged. The neutral oak albedo texture has no
intentional scene lighting and is embedded into both standalone HTML bundles. It was created
with the built-in image generation tool using this prompt:

> Seamless weathered oak ship timber base-color texture; fine vertical grain,
> subtle salt-weathered brown-grey patina, tiny knots and fissures; orthographic,
> flat unlit color only, no directional illumination, shadows, highlights,
> ambient occlusion, perspective, plank seams, text, or borders.

### Steering and rendering refinements

Use **A / D** or **left / right arrows** to command port/starboard helm;
**X** or **Centre rudder** returns it to neutral. The **Rudder** slider provides
the same control on mobile. The visible direct tiller and rudder share their
stock axis: a starboard command moves the blade's trailing edge to starboard and
the forward-pointing tiller to port. The helmsman follows its grip below the
quarterdeck; the player observes from above. Wheel dragging is removed.

Turn rate builds gradually and decays after centering. Rudder authority depends
on speed and hull length; a stationary boat does not turn under rudder alone.
This remains an approximate yaw response, not a measured caravel manoeuvring model.
See [the reconstruction notes](CARAVEL_RESEARCH.md) for steering and rig sources.

Reflections now use a roughness-filtered HDR mip chain and blend continuously at
screen edges. Timber grain follows the individual timbers and tiller
using stable local UV coordinates. Detail normals and rope fibres are filtered,
overlapping plank faces have been removed,
and cap rails are continuous beveled sweeps. Sea-state-dependent culling bounds
retain rough-wave crests. Test the math and geometry with:

```
node --test tests/boat.test.mjs tests/caravel.test.mjs
```

The joint hotspot was caused by an out-of-range floating-point cosine reaching
`pow(1 - cosine, 5)` in the caravel Fresnel calculation. On the active GPU this
could produce invalid HDR values and a large white bloom. All BRDF cosines are
now clamped to their physical ranges, and the fifth power uses multiplication.
A 120-frame live capture under the 20 m/s wind / 4 m swell preset showed no white
hotspot after the correction. This visual check supplements the steering and
mesh tests; it is not a guarantee for every GPU or lighting configuration.

The full-ship checks cover finite geometry, submerged hull extent, stern cabin,
three sail panels, mast height, tiller/rudder alignment, crew grip clearance and the camera eye
anchor. The independent camera and hull wave probes let Free camera remain
level while the vessel continues floating and steering.

## GitHub Pages build

[Open the live sailing demo](https://healdgar.github.io/caravel-ocean-sim/).
Source and the published build now live together in the public
[`healdgar/caravel-ocean-sim`](https://github.com/healdgar/caravel-ocean-sim) repository.

`node build.mjs` also generates `docs/index.html`, a standalone minified demo
with the oak material embedded. It starts in Boat camera unless the URL contains
`boat=0`. GitHub Pages serves the `main` branch's `/docs` folder. To update the
demo, rebuild, commit the generated bundles with the source, and push to `main`.
The `.nojekyll` file preserves the generated static page without a Jekyll build.
