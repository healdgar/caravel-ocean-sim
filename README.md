# Seasick Simulator

Performance optimizations for [Noniv/web-ocean](https://github.com/Noniv/web-ocean).

A real-time WebGPU ocean with a wave-driven sailing ship, square sails, a working helm, and boat, free-flight, and exterior cameras. Sea conditions, sunlight, and clouds can be adjusted and shared in a link.

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

After editing anything under `js/`, run `npm run build` to regenerate both bundles. The minified build strips WGSL comments and whitespace and minifies the JavaScript with esbuild.

## Controls

| Input | Action |
|---|---|
| Click the canvas | Capture the mouse (Esc releases it). Holding the right mouse button also works. |
| Mouse | Look around |
| W A S D | Move |
| Space or E / Q or C | Up / down |
| Shift | 5x speed |
| Mouse wheel | Change base speed |
| H | Settings panel: wind, swell, choppiness, turbidity, foam, sun, haze, clouds, exposure, bloom |

The camera keeps itself above the displaced water surface, so waves never pass through it.

URL parameters are handy for testing. `?w=2560&h=1440` forces the render resolution, `cam=x,y,z,yawDeg,pitchDeg` sets the camera, `fov=deg` sets the field of view, `ui=0` hides the HUD, and any settings key works too, for example `windSpeed=12&swellHs=2&sunElev=8`.

## Share your sea conditions

Open **Sea settings** and adjust the waves and lighting, then select **Copy share
link** in the top controls. The link includes every sea and lighting parameter,
boat length, beam, heading, speed, eye height, rudder setting, ship visibility,
and the selected camera mode. Opening it restores those settings. The address
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

### Shading

- Mip-mapped first and second moments of the wave slopes (LEAN mapping) give the right anisotropic roughness at every distance. The sun glitter widens with distance and the far sea settles into a sheen without aliasing. Screen-space slope derivatives add specular anti-aliasing.
- Sun glitter uses an anisotropic Gaussian slope distribution with Smith masking and the size of the solar disc.
- The sky reflection comes from an environment cube map with roughness-filtered mips. One face and its mip chain refresh per frame; all six refresh on startup and after settings changes. At grazing angles the reflection direction is tilted to account for which wave facets the viewer can actually see.
- The water body is turbid blue-green, lit by the whole sky hemisphere. Backlit crests get a subsurface glow, and wind-gust patches modulate the short ripples.
- Whitecaps start where the total surface Jacobian folds. Foam is stored in two camera-centred world-space maps (128 m and 1 km wide), decays over time, drifts downwind, and breaks into streaks as it ages. A procedural bubble texture gives it its structure.

### Sky

The atmosphere follows Hillaire's approach, with transmittance, multiple-scattering, and sky-view lookup tables plus aerosol haze. There are two cloud layers, a broken low cumulus and a fibrous altostratus deck. Each is shaded with self-shadowing toward the sun, lit rims, silver linings when backlit, and direction-dependent multiple scattering.

Cloud noise octaves are filtered by pixel footprint, and silhouettes are anti-aliased analytically: the screen-space derivative of each layer's edge function sets the width of its opacity edge. Cloud transmittance along the sun direction dims the sunlight that reaches the water, and aerial perspective is applied over the sea.

### Post-processing

The scene renders in HDR with 4x MSAA. Post-processing adds up to 8 levels of bloom, AgX tone mapping, a slight white balance shift, and dithering. Small render targets use only the mip levels they support, and setting bloom to zero skips its blur passes.

## Performance

The original renderer measured about 6 to 8 ms per frame at 2560 by 1440 on an RTX 5070 Ti, while other programs were also using the GPU. The HUD shows FPS and GPU time when the browser supports `timestamp-query`.

The per-frame code reuses preallocated typed arrays and descriptors, so the garbage collector has almost nothing to do. The only recurring allocations are the objects WebGPU itself requires, such as the swap-chain view and command buffers.

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
npm test
npm run build
```

The WebGPU tests compare the fused FFT with analytical travelling waves across all six cascades, and exercise sky invalidation, settings changes, bloom toggling, and resizing down to 1 × 1. They use SwiftShader and an offscreen GPU render target so a physical GPU or window system is not required. To use an existing Chromium installation, set `CHROMIUM_PATH` (for example, `CHROMIUM_PATH=/usr/bin/chromium npm test`). Tests use port 8082 by default; override it with `TEST_PORT` if needed.

## Known limitations

- Far water is still somewhat darker than the bright horizon sky above it.
- The water is tuned toward turbid coastal water. The "Water turbidity" slider gives darker, bluer deep water when turned down.
- The scene is open ocean with an optional fully modeled sailing ship. There is no shoreline, surf, or other vessels.
- Clouds are two flat layers, not volumetric.

## How it was made

I built this with Claude Code (Opus 5.5). I asked for the most realistic water it could produce, in WebGPU, with a floating camera, and left the architecture and implementation to it. It checked its own work by rendering screenshots in headless Chrome and having separate critic subagents review them, so it was not grading its own output. I gave feedback along the way, mainly on the clouds, which led to replacing the volumetric clouds with the flat layers and later fixing their edge aliasing.

## Repository layout

| Path | Contents |
|---|---|
| `index.html` | Page shell, HUD, and settings panel styles |
| `js/main.js` | Device setup, resources, camera modes, per-frame loop |
| `js/boat.js` | Wave response, steering, and world-space eye position |
| `js/caravel.js` | Full hull, decks, cabin, rigging, square sails, and helm geometry |
| `assets/` | Neutral oak texture, optimized WebP, and generation prompt |
| `js/wgsl/` | Shaders as JavaScript modules: `sim.js` (waves and foam), `sky.js` (atmosphere and clouds), `ocean.js` (surface and sky pass), `post.js` (bloom and tone mapping), `common.js` (shared structs) |
| `server.mjs` | Tiny static server for development |
| `build.mjs` | Builds `ocean.html` and `ocean.min.html` |
| `docs/` | README images |

## License

MIT. See [LICENSE](LICENSE).

## Boat perspective

Choose **Boat camera** in the always-visible camera controls, or open `ocean.html?boat=1`.
Set length and beam in metres, speed in knots, heading in degrees (0 along the
original view, 90 to the right), and eye height above the mean waterline.
The helm controls the rudder; mouse look is relative to the boat. **Look ahead**
centres the view. Choose **Free camera** or press **B** to leave the floating viewpoint.
Choose **View ship** for a level exterior view that follows the ship: drag to orbit
and use the mouse wheel to zoom. The vessel continues sailing in all camera modes.

The camera follows a damped hull pose fitted to a 3 by 3 grid of heights sampled
from the actual displaced FFT ocean. Larger footprints average over waves;
length also slows the pitch/heave response and beam slows the roll response.
Speed changes position and therefore the waves encountered. Live pitch, roll,
and heave are shown in the panel. This is an approximate displacement-hull ride,
without hull-specific mass/stability, wake, planing, or slamming physics.

URL options: `boat=1&boatLength=12&boatBeam=3.6&boatHeading=0&boatSpeed=6&boatEye=2.4`.
Run `node --test tests/boat.test.mjs` for the hull-response math checks.

### Full sailing ship

The complete vessel includes a rounded planked hull and keel, square transom,
stern cabin with windows, raised quarterdeck, bow and stern rails, bowsprit,
hatch grating, cleats, fittings, and a rudder that moves with the helm. Three
masts carry five shaped square sails, with yards, stays, shrouds, and ratlines.
Canvas uses a two-sided cloth material and slight wind-driven flutter under the
actual sun and sky. Speed is still manually controlled; sail forces are not
integrated into propulsion. Toggle **Show ship** or use `prow=0` to hide it.
**Hide** collapses the controls; camera selection remains visible. Geometry
scales with boat length and beam. The ship has an independent world position
and keeps its wave-following pose while the camera flies or orbits around it.

The PBR material uses the live atmospheric sunlight, cloud transmittance, sky
environment, and current ocean HDR image for visible water reflections and
approximate bounced light. Offscreen reflections use the environment cube;
rail shadows are approximate. A separate near-field depth pass keeps wave crests
from rendering through the foredeck in Boat camera. Exterior views share the
ocean depth buffer so the water correctly occludes the submerged hull. A
world-space hull volume also excludes water inside the vessel, keeping the
decks dry while preserving the exterior waterline in all camera modes. The neutral oak albedo texture has no
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
