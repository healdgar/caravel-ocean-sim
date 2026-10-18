# Seasick Simulator

Performance optimizations for [Noniv/web-ocean](https://github.com/Noniv/web-ocean).

A real-time WebGPU ocean with a wave-driven sailing ship, impact spray, deck wash, whitecaps, and volumetric weather. The caravel has square sails and a lateen mizzen, a working helm, and boat, free-flight, and exterior cameras. Sea conditions, sunlight, and clouds can be adjusted and shared in a link.

[Open Seasick Simulator](https://healdgar.github.io/seasick-simulator/).

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
| H | Settings panel: wind, swell, choppiness, turbidity, foam, sun, haze, clouds, exposure, bloom |

The free camera stays above the sampled water. The boat camera follows the hull and can be overtopped in rough seas.

URL parameters are handy for testing. `?w=2560&h=1440` forces the render resolution, `cam=x,y,z,yawDeg,pitchDeg` sets the camera, `fov=deg` sets the field of view, `ui=0` hides the HUD, and any settings key works too, for example `windSpeed=12&swellHs=2&sunElev=8`.

## Share your sea conditions

Open **Sea settings** and adjust the waves and lighting, then select **Copy share
link** in the top controls. The link includes every sea and lighting parameter,
boat length, beam, heading, speed, eye height, rudder setting, ship visibility,
wake/spray/deck-wash visibility, and the selected camera mode. Opening it restores those settings. The address
bar also receives the link; if copying is blocked, a selected text field lets
you copy it manually. Each copy captures your latest settings.

For crossing storm seas, select **Hella rough** in Sea settings: 28 m/s wind,
8 m swell, and extra foam. The sliders allow up to 32 m/s wind and 10 m swell.
[Try rough seas](https://healdgar.github.io/seasick-simulator/?boat=1&windSpeed=28&windDir=123&fetchKm=300&swellHs=8&swellLength=95&swellDir=236&choppy=1.6&foam=1.7).
Links share the configuration; they do not freeze an animation frame or the
boat's travelled position.

## How it works

### Waves

The sea is a Tessendorf FFT simulation with six cascades of 256 by 256 samples. The patches range from 1103 m down to 0.26 m, so wavelengths run from about a kilometre to a few millimetres. The smallest cascade produces the sharp sun sparkles near the camera.

The spectrum is a fetch-limited JONSWAP wind sea with Donelan-Banner directional spreading, plus a narrow long-crested swell. Dispersion includes the capillary term, and choppy horizontal displacement sharpens the crests. Spectrum evolution feeds directly into the first radix-2 inverse FFT in workgroup memory, followed by the column FFT.

The surface mesh is a CDLOD quadtree with 17 levels. Vertices are 6.25 cm apart near the camera and the mesh reaches 160 km, with continuous vertex morphing between levels.

### Caravel model

The native procedural mesh follows [this generated art reference](assets/caravel-design-reference.png): a fuller raked hull, dark swept wales, raised stern cabin with arched windows, four billowing square sails, a triangular lateen mizzen, anchors, and rigging. The [generation prompt](assets/caravel-design-reference-prompt.txt) is retained locally with the artwork. The reference was generated with the built-in image tool; it is art direction, not a historical reconstruction.

The model uses roughly 80,000 triangles and retains the animated wheel, rudder, and canvas. `js/hull.js` defines the section used by the mesh; `js/wgsl/hull.js` supplies matching ocean-mask and spray-contact functions. Water overtopping the bulwarks remains visible. No imported model or Blender dependency is required.

### Bow waves and spray

Thirty-two GPU probes intersect the moving hull with the horizontally displaced FFT surface. Forward speed produces a low displacement wave. Water rising relative to the hull, filtered over a 0.65 m patch to suppress tiny ripples, launches finite-lived curved sheets into world space; they spread, tear at the lip, fall, and expire between impacts. A dry bow stops emitting, while a stationary hull still responds to rising crests. Small droplets and broad translucent mist are secondary to the sheets, rather than constant streams.

A boat-centred 256 × 256 local wave grid adds displacement and slopes to the ocean. It retains disturbances in world space as the ship moves. Bow and stern foam and droplet landings feed the existing foam clipmaps. The buoyancy probe samples the same added height. Impacts inject outward-travelling crest/trough pulses. Gravity, drag, water collision, 128 sheet slots, and 4,096 secondary particle slots stay on the GPU.

**Wakes & spray** toggles the effect, also preserved as `effects=0` or `effects=1` in shared links. Changing sea spectrum or hull dimensions resets contact history to avoid false impacts. The grid uses a damped wave approximation with bounded forcing; it does not model full hull hydrodynamics, planing, or a physically exact Kelvin wake.

Technique references: [Noniv/snowflow_demo](https://github.com/Noniv/snowflow_demo) for curling sheets and separate spray populations; [booherbg/clean-room-fft-ocean](https://github.com/booherbg/clean-room-fft-ocean) for ocean/contact-driven spray; [bob6664569/open-water](https://github.com/bob6664569/open-water) for persistent world-space wakes. This implementation uses native WebGPU/WGSL and adds no runtime dependencies.

### Deck wash and buoyancy

A 32 × 96 hull-local water field samples the displaced sea at the rails. Overtopping adds water at the edges; four bounded downhill-flow substeps carry it across the deck and out through modeled scuppers. The raised quarterdeck has its own floor height, and the cabin blocks flow between the two deck levels. Translucent wash, frothy fronts, inward curtains, and falling runoff strips share the scene lighting. A finer 64 × 192 rendering mesh and smoothed height gradients keep reflections from exposing the simulation grid. Timber darkens and stays glossy after the water drains, then dries. The existing **Wakes & spray** switch also controls deck wash.

The field uses float32 storage with explicit bilinear sampling, requiring no optional GPU features. Depth is capped at 1.2 m: this is a visual surface-water approximation, not a vessel flooding, capsize, or flood-mass simulation. Runoff does not yet deposit separate splash particles on the sea. Buoyancy follows sampled wave height and velocity with bounded prediction for readback latency; new sea presets place the hull on the sampled surface. Large crests can still overtop it.

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

The original renderer measured about 6 to 8 ms per frame at 2560 by 1440 on an RTX 5070 Ti, while other programs were also using the GPU. The HUD shows FPS and GPU time when the browser supports `timestamp-query`.

The render loop reuses large typed arrays and GPU resources, keeping most recurring allocations small.

Volumetric clouds add raymarching and reconstruction work. If frame rate drops at maximum **Cloud quality**, lower that setting or the render resolution. Cloud quality changes the screen ray resolution, while the cached density and lighting volumes remain fixed. The older RTX timing above predates these cloud and vessel effects and is not a current performance guarantee.

The optimized frame schedule also avoids redundant GPU work:

- Fusing spectrum evolution with the row FFT removes two 6 MiB buffers, one dispatch, and 24 MiB of intermediate buffer reads/writes per frame.
- The sky-view LUT updates only when sun elevation, haze, or effective camera altitude changes. An unchanged sky skips 256 × 144 × 48 atmospheric integration steps.
- Updating only the changed reflection face removes five-sixths of the steady-state cube mip filtering work.
- The water-height probe runs only when its result will be read back, and disabled bloom skips all 15 blur passes at normal resolutions.

These are reductions in memory and scheduled work, not a measured hardware FPS improvement. GPU timing depends on the adapter and scene.

## Validation

With Node.js 20 or newer:

```
npm ci
npx playwright install chromium
npm run build
npm test
```

The suite contains 27 checks covering:

- Analytical FFT waves across all six cascades, steering, moving-water buoyancy response, hull geometry, and shared settings.
- Dry, stationary, moving, and tilted hull contacts; impact sheets; persistent wakes; matching buoyancy heights; spray retirement and landing foam; and effect toggling.
- Dry decks below the rails, overtopping, retained water, downhill flow, scupper drainage, eventual timber drying, bounded deep immersion at large time steps, and resets.
- Bounded foam production and decay, cloud clearing/occlusion/advection, temporal-history invalidation, sky scheduling, bloom toggling, and resizing down to 1 × 1.
- Consistent HDR sun extinction, solid and translucent vessel shadows, sun direction, translated/tilted casters, self-shadow bias, and disabling hidden/night shadows. Water checks preserve broad shadows and canvas tint while dispersing fine rigging through the refracted scattering footprint.
- JavaScript and WGSL initialization in all three standalone builds.

GPU fixtures use SwiftShader and an offscreen render target, so a physical GPU or window system is not required. To use an existing Chromium installation, set `CHROMIUM_PATH` (for example, `CHROMIUM_PATH=/usr/bin/chromium npm test`). Tests use port 8082 by default; override it with `TEST_PORT` if needed. Visual checks in native Chrome supplement these tests; software-GPU checks do not establish device frame rates or visual quality.

## Known limitations

- Far water is still somewhat darker than the bright horizon sky above it.
- The water is tuned toward turbid coastal water. The "Water turbidity" slider gives darker, bluer deep water when turned down.
- The scene is open ocean with an optional fully modeled sailing ship. There is no shoreline, surf, or other vessels.
- Volumetric clouds can show reconstruction noise during fast movement and repeat over a 16 km field. Direct-sun occlusion is sampled near the camera; moving cloud shadows are not yet projected across the sea.
- Deck wash is a bounded visual model. It does not add floodwater mass, simulate capsizing, or create separate runoff landing splashes. Severe crests can still overtop the hull and boat camera.
- Vessel shadows retain the nearest canvas layer; overlapping sails do not multiply their transmission. The finite map resolution and bounded soft filter can alias very thin rigging, especially on enlarged ships. The ocean receives vessel shadows but does not cast wave shadows onto the ship.
- Underwater vessel shadows use a bounded local-surface scattering approximation, with authored optical depth and spread. They do not simulate underwater caustics or full multiple scattering.

## How it was made

The upstream README credits Claude Code (Opus 5.5), with headless Chrome screenshots and separate critic reviews. Its account describes an earlier version that replaced volumetric clouds with flat layers. This fork retains the native WebGPU architecture and adds the caravel, steering, hull interactions, deck wash, and the Joshbrew-derived volumetric clouds described above.

## Repository layout

| Path | Contents |
|---|---|
| `index.html` | Page shell, HUD, and settings panel styles |
| `js/main.js` | Device setup, resources, camera modes, per-frame loop |
| `js/boat.js` | Wave response, steering, and world-space eye position |
| `js/interaction.js` | GPU hull contacts, wake grid, spray resources, and effect passes |
| `js/deck.js`, `js/wgsl/deck.js` | Retained deck water, drainage, wetness, wash shading, and runoff strips |
| `js/clouds.js`, `js/wgsl/clouds.js`, `js/wgsl/cloud-model.js` | Volumetric cloud resources, density and lighting caches, raymarching, and temporal reconstruction |
| `js/sharing.js` | Shareable scene settings, camera modes, and storm preset |
| `js/caravel.js` | Hull, quarterdeck, cabin, rigging, square and lateen sails, and helm geometry |
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
Set length and beam in metres, speed in knots, heading in degrees (0 along the
original view, 90 to the right), and eye height above the mean waterline.
The helm controls the rudder; mouse look is relative to the boat. **Look ahead**
centres the view. Choose **Free camera** or press **B** to leave the floating viewpoint.
Choose **View ship** for a level exterior view that follows the ship: drag to orbit
and use the mouse wheel to zoom. The vessel continues sailing in all camera modes.

The camera follows a damped hull pose fitted to a 3 by 3 grid of heights sampled
from the actual displaced FFT ocean and local wake. Measured wave velocity and
bounded readback prediction reduce lag on rising water. Larger footprints average over waves;
length also slows the pitch/heave response and beam slows the roll response.
Speed changes position and therefore the waves encountered. Live pitch, roll,
and heave are shown in the panel. This is an approximate displacement-hull ride,
with visual wakes, impact spray, and retained deck wash, but without hull-specific mass/stability, planing, or slamming forces.

URL options: `boat=1&boatLength=12&boatBeam=3.6&boatHeading=0&boatSpeed=6&boatEye=2.4`.
Run `node --test tests/boat.test.mjs` for the hull-response math checks.

### Full sailing ship

The complete vessel includes a rounded planked hull and keel, square transom,
stern cabin with windows, raised quarterdeck, bow and stern rails, bowsprit,
hatch grating, cleats, fittings, and a rudder that moves with the helm. Three
masts carry four shaped square sails and a triangular lateen mizzen, with yards, stays, shrouds, and ratlines.
Canvas uses a two-sided cloth material and slight wind-driven flutter under the
actual sun and sky. Thin-sheet transmission produces a soft, warm glow around
the backlighting sun; seams, hems, folds, and grazing light paths transmit less.
Cloud shadows attenuate the glow. The fabric coefficients are authored visual
approximations, and the canvas retains depth occlusion rather than becoming
transparent to background geometry. Speed is still manually controlled; sail forces are not
integrated into propulsion. Toggle **Show ship** or use `prow=0` to hide it.
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
hull volume excludes ocean water inside the bulwarks and stern cabin; overtopping
crests remain visible. The neutral oak albedo texture has no
intentional scene lighting and is embedded into both standalone HTML bundles. It was created
with the built-in image generation tool using this prompt:

> Seamless weathered oak ship timber base-color texture; fine vertical grain,
> subtle salt-weathered brown-grey patina, tiny knots and fissures; orthographic,
> flat unlit color only, no directional illumination, shadows, highlights,
> ambient occlusion, perspective, plank seams, text, or borders.

### Steering and rendering refinements

Use **A / D** or **left / right arrows** to turn the wheel, **X** or **Centre rudder**
to return it to neutral. The rudder stays where the wheel is left. The **Rudder**
slider provides the same control. With mouse look released (Esc), drag the visible
3D wheel clockwise for starboard or counterclockwise for port. The wheel rotates
with the actual rudder angle, with a one-turn range in each direction. Turn rate
builds gradually and decays after centering; rudder authority depends on boat speed
and length. A stationary boat does not turn under rudder alone.

This is an approximate steering response, without wind-driven sail forces or a
hull-specific rudder/keel model. A wheel is included as requested rather than as a
strict historical reconstruction of a caravel's tiller steering.

Reflections now use a roughness-filtered HDR mip chain and blend continuously at
screen edges. Timber grain follows the individual timbers, spokes, and wheel rim
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
five sail panels, mast height, rudder placement, and the world-space camera eye
anchor. The independent camera and hull wave probes let Free camera remain
level while the vessel continues floating and steering.

## GitHub Pages build

[Open the live sailing demo](https://healdgar.github.io/seasick-simulator/).
Source and the published build now live together in the public
[`healdgar/seasick-simulator`](https://github.com/healdgar/seasick-simulator) repository.

`node build.mjs` also generates `docs/index.html`, a standalone minified demo
with the oak material embedded. It starts in Boat camera unless the URL contains
`boat=0`. GitHub Pages serves the `main` branch's `/docs` folder. To update the
demo, rebuild, commit the generated bundles with the source, and push to `main`.
The `.nojekyll` file preserves the generated static page without a Jekyll build.
