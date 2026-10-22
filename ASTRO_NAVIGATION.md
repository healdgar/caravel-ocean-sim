# Night sky and celestial navigation

2026-10-21. **Runtime published as `7fba40de2601552757ada1ce490883ced75f06fb` after root's 572/572 native Metal suite, zero skips, and rendered full/new-Moon and four-vessel checks. Public bytes verified 2026-10-22T04:13:27Z. Navigation lessons/instruments and certified navigation accuracy remain deferred.**

## Outcome

One geographic position and astronomical clock determine the Sun, Moon, stars, lighting and navigation readings. Moon phase, constellation placement and horizon altitude must agree with the scene. Optional lessons explain observations without changing the underlying sky.

Manual scene lighting remains the default. Enable **Sun, Moon and stars → Astronomical sky**, or use `skyMode=astronomy`. Existing manual share links retain their lighting.

Manual Sun elevation now spans −90°…90° and azimuth 0°…360°. Its direct light
obeys the same planetary horizon as the astronomical Sun; negative elevation
reaches twilight and then dark night, without introducing an unrelated Moon.
The date/location mode supplies Moon and stars. Editing either Sun slider selects
Manual Sun explicitly. Legacy signed bearings are normalized to equivalent
full-circle controls.

## Existing integration points

| Source | Current behavior | Required boundary |
| --- | --- | --- |
| `js/main.js` | Manual `sunElev`/`sunAzim` cover full altitude/azimuth. Spectrum `simTime` wraps at `LOOP=600`. | A separate unwrapped astronomical epoch; never drive astronomy from the FFT clock. |
| `js/wgsl/sky.js` | Sun, atmosphere, clouds, environment cube and sun visibility share solar inputs. | Extend all light paths coherently; adding a Moon sprite alone is insufficient. |
| `js/wgsl/ocean.js` | Sky background, reflected sky and direct solar light; background horizon sampling clamps a direction above the horizon. | Independent celestial visibility/occlusion; no below-horizon Moon or stars promoted by that clamp. |
| `js/terrain-model.js` | Saba anchor at 17.635° N, 63.238° W; `islandCoordinates()` supplies a local geographic approximation. | Valid initial observer source. Global voyages need canonical latitude/longitude, not unlimited extrapolation of this regional approximation. |
| `js/sharing.js`, `build.mjs` | Shared scene parameters; explicit flat module order and standalone HTML builds. | Serialize mode/date/position; vendor locally, preserve attribution, include in both builds. No runtime CDN/API. |

## Clock and geographic frame

Use an explicit saved `epoch` plus unwrapped elapsed seconds. Default to real-time astronomical progression. Voyage distance compression changes geographic displacement; it must not accidentally accelerate physics, weather or the sky. A separate authored time-of-day rate can remain a clearly labeled option.

Keep calendar interpretation explicit: ISO/proleptic Gregorian internally, deliberate conversion for historical Julian dates. Historical scenarios use a documented UT1-like convention; do not imply modern UTC existed in 1492. Store scenario dates rather than infer them from a vessel. Later historical accuracy claims require an epoch-specific error budget, especially for uncertain Earth rotation.

Adopt east-positive longitude and azimuth clockwise from true north. Existing Sun-vector mapping already fits world +X east, +Y up, −Z north:

```text
direction = [sin(azimuth) cos(altitude), sin(altitude), −cos(azimuth) cos(altitude)]
```

Ship heading and camera orientation never rotate the geographical sky. Deck motion rotates the camera/instrument; observer eye height affects horizon dip.

## Sources and dependencies

**Ephemerides:** prefer locally vendored [Astronomy Engine](https://github.com/cosinekitty/astronomy), pinned to reviewed bytes/commit. Its author targets roughly ±1 arcminute and compares against NOVAS/JPL; that is an upstream claim, not an Ocean Sailing Simulator accuracy result. Preserve its [MIT notice](https://github.com/cosinekitty/astronomy/blob/master/LICENSE). Avoid large ephemeris downloads for the first release.

Its [official position example](https://github.com/cosinekitty/astronomy/blob/master/demo/nodejs/positions.js) demonstrates observer-based equator-of-date coordinates followed by horizon conversion. The [API](https://github.com/cosinekitty/astronomy/blob/master/source/js/README.md) supplies phase/illumination and rotations, but `DefineStar` has only eight slots. Use a generic catalogue-vector path for the sky. Record the library’s UTC/UT1 approximation and TT/Delta-T model in the adapter.

**Stars:** use a small magnitude-filtered, attributed derivative of a pinned HYG snapshot. The [archive](https://github.com/astronexus/HYG-Database) points to its current Codeberg home; current Codeberg contents were inaccessible during this research. The accessible [HYG schema](https://github.com/astronexus/HYG-Database/blob/main/hyg/README.md) documents J2000 positions, proper motion, Cartesian velocities, brightness and colour index. Confirm units and the RA proper-motion convention before conversion. Its [CC BY-SA 4.0 data license](https://github.com/astronexus/HYG-Database/blob/main/LICENSE) must remain with the derived catalogue; do not relabel data MIT. Keep code and data notices distinct.

[Yale Bright Star Catalogue V/50](https://cdsarc.cds.unistra.fr/viz-bin/ReadMe/V/50?format=html&tex=true) is another naked-eye catalogue candidate, but its redistribution terms were not established here. Do not ingest it until resolved. Author simple constellation line connections locally; labels/lines are teaching overlays, not physical sky geometry.

## Proposed implementation

Add a small `js/astronomy.js` adapter and a dedicated celestial uniform/binding. Do not repurpose the existing 384-byte frame structure silently. Expose one `CelestialState` to rendering and navigation:

```text
epoch/time scale + observer latitude/longitude/elevation
Sun/Moon geometric and apparent directions, distances, angular radii
Moon illumination, limb orientation, phase
catalogue-to-horizon rotation, extinction/visibility inputs
solar/lunar light radiance and active lighting mode
```

Names and placement remain proposals; follow the flat repository and explicit standalone bundler. Isolate vendor symbols: import stripping flattens modules and rejects aliased imports.

Propagate catalogue proper motion to the scenario epoch, then apply precession/nutation and observer horizon transforms. Validate aberration/parallax conventions against the chosen reference. Do not freeze Polaris, constellation orientation or celestial poles to J2000. Distinguish catalogue positions from apparent observed positions.

Calculate ephemerides at a modest cadence, interpolate directions, and refresh after time/location edits. Bound the cadence by measured angular error. Upload catalogue stars once; rotate in the shader rather than run per-star CPU astronomy each frame. Rebuild atmospheric/environment resources only when their input changes warrant it. Performance is unmeasured.

## Night rendering

- Continue atmospheric twilight below sunset; blend star visibility from sky luminance, extinction, Moon illumination and cloud transmittance.
- Render the Moon at its actual angular size with an observer-correct terminator derived from Sun/Moon geometry. Phase is not a decorative brightness slider. Begin with a procedural disc; qualified texture/libration detail can follow.
- Respect sea/land horizon, scene depth and cloud transmittance in the main sky and reflections. Labels must not make cloud-obscured stars appear physically visible.
- Moonlight must affect ocean glints, sky/environment lighting, clouds, hull, wet surfaces, sails and crew through the same light definition. Preserve Sun and Moon simultaneously at dawn/dusk. Never swap the global Sun direction to fake lunar lighting.
- Use phase/distance/atmospheric attenuation for lunar light, with bounded shadow cost. Exposure/night adaptation is a separate presentation decision; avoid fixed blue daylight on moonless nights.
- Eclipses and detailed lunar libration are optional later work. Do not claim eclipse behavior merely because the library predicts events.

## Navigation and lessons

Keep separate: geometric topocentric altitude; refracted apparent altitude; chosen limb; visible sea horizon/dip; instrument/index error; and geocentric almanac altitude. In particular, do not apply lunar parallax twice after an already topocentric calculation.

The [USNO celestial-navigation service](https://aa.usno.navy.mil/data/celnav) documents sextant correction flow: instrument/index and dip corrections, then refraction, semidiameter and parallax to obtain an observed altitude comparable with computed altitude. Use saved independent outputs as development fixtures; never require a live service to play. Preserve time scale, sea-level assumptions and limb selection with every fixture. The [USNO API](https://aa.usno.navy.mil/data/api.html) is a reference-source option, not a runtime dependency.

First lessons: identify pole/bright stars; measure altitude; take a noon-Sun latitude sight; then combine separated lines of position with time and a chart. A single arbitrary star altitude does not identify a unique position. Instrument angle measurement must be independent of screen resolution/FOV. Optional steadying aids and exact overlays should be visible training settings.

Offer period presentation separately from modern training instruments. [Royal Museums Greenwich](https://www.rmg.co.uk/stories/space-astronomy/what-mariners-astrolabe) describes the mariner’s astrolabe, its use by about 1470, and Columbus carrying an astrolabe/quadrant. Nina should not acquire an unlabeled modern sextant as historical equipment. Rough seas, lost horizons and clouds should constrain actual sights.

## Evidence requirements and navigation/device follow-up

The current sky/rendering checkpoint passed the runtime qualification recorded
below. Navigation accuracy, instruments and physical-device rows remain follow-up
requirements, not capabilities certified by that checkpoint. Pages deployment
`7243537555` succeeded at **2026-10-22T04:12:31Z**; HTML, manifest and all 53 assets
matched exact public sizes/hashes at **04:13:27Z**.
[Exact release receipts](BACKLOG.md#published-checkpoint-four-vessels-independent-fleets-and-night).

| Gate | Required evidence |
| --- | --- |
| Clock/geography | 600-second spectrum wrap cannot reset sky; save/reload and manual-mode links round-trip; cardinal directions, date line, equator, both hemispheres, leap days and calendar convention. |
| Independent positions | Saved USNO/JPL/NOVAS-compatible fixtures with exact epoch, observer, time scale, frame, refraction and limb conventions. Modern plus 1492/1805; 350/850 only after their own historical validation. Do not compare geometric output with apparent reference. |
| Accuracy | Provisional target ≤2 arcminutes for navigation bodies/stars at 10–80° altitude under the declared model. Demonstrate before advertising; widen/reject claims where historical timing or near-horizon refraction prevents it. |
| Historical stars | Polaris offset and bright high-proper-motion star checks at distinct centuries; no static modern sky texture accepted. |
| Moon | New/quarter/full phases, both hemispheres, rise/set parallax, terminator orientation and angular size. No lunar directional illumination from below the horizon. |
| Common illumination | Main sky/reflections/clouds/materials agree at sunset, moonlit night, moonless night and dawn with both bodies present. Terrain/ship/cloud occlusion works at overhead and horizon views. |
| Instruments | Fixed-reference Hs→corrected-altitude round trip; index/dip/refraction/limb/parallax signs; topocentric-vs-geocentric distinction; viewpoint/FOV cannot change the measured angle. |
| Delivery/performance | Offline standalone and deployed HTML/asset checks; mobile controls; measured GPU/CPU impact and physical iPhone qualification. Root owns all tests/builds/browser/profiling. |

## Bounded sequence

1. Clock/location contract, local pinned ephemeris adapter and independent source fixtures.
2. Astronomical Sun, night stars, Moon/phase and coherent lunar lighting; manual-mode compatibility.
3. Optional constellation/altitude hints and period instrument presentation; sight correction lessons.
4. Multi-sight fixes, chronometer/almanac training and optional advanced celestial events.

## Implemented runtime contract

- `js/astronomy.js`: unwrapped epoch/elapsed clock, UT-like ISO/proleptic Gregorian dates, geographic observer, pinned Astronomy Engine topocentric Sun/Moon directions, phase/photometry/limb orientation and J2000-to-horizon rotation. Geographic displacement uses a spherical great-circle calculation anchored to the edited observer; global route compression remains a separate system.
- `js/celestial.js` and `js/star-catalog.js`: magnitude-filtered HYG v4.1 stars with Cartesian proper motion, historical precession/nutation, stellar flux/colour, atmospheric extinction and cached 512² stellar cube. Proper-motion positions refresh on day-scale date changes; the Earth/horizon rotation refreshes each ephemeris second, cube at two-second intervals. Star positions are geometric catalogue directions; stellar refraction/annual aberration/parallax are not navigation-qualified.
- Optional authored constellation connections respect scene depth, local horizon and reconstructed cloud opacity. These are simple guide lines, without lessons, labels or a sextant.
- Moon disc uses actual angular radius and Moon-to-Sun geometry, with a procedural tonal surface. Its full-disc integral is normalized to ephemeris irradiance; background stars are occulted by both lunar hemispheres. Explicit discs are excluded from the environment cube, matching the existing Sun/direct-BRDF split; reflected lunar glints enter through the lunar surface BRDF. Star cubemap flux accounts for face-dependent texel solid angle. No detailed lunar texture, libration or eclipses are claimed.
- Sun and Moon remain separate simultaneous lights. Lunar terms reach ocean slope glints/foam, sky/reflections, clouds, hull/sail transmission, crew, terrain/vegetation, deck water, anchor, spindrift, marine skin/splashes and underwater scattering/caustics. Cloud lighting fields and ship shadow maps prioritize the Sun while it is above the horizon, otherwise the Moon. This is a physical-dominance approximation: separate cloud attenuation can occasionally make the Moon locally stronger near sunset. The weaker simultaneous source does not get an independent ship/cloud light-field shadow map. Terrain separately caches solar/lunar cloud and relief visibility.
- Night adaptation is an explicit bounded exposure multiplier, independent of solar/lunar irradiance; dark moonless and full-Moon energy still differ. Airglow is a weak authored floor, not a calibrated sky model.
- Production **Frame is explicitly 528 bytes /132 floats**, preserving the first384 bytes unchanged: Moon direction/irradiance at384, disc-right/radius400, disc-up/phase416, Moon-to-Sun/Lambert432, mode/stars/constellation/lunar-shadow flags448, catalogue rotation464–527. `withCelestialFrame()` specializes every production Frame-bearing shader in `main.shader()`. Legacy isolated384-byte shaders use exact zero-Moon stubs. This is a documented schema extension, not reused reserved components.
- `window.oceanAstronomy`: `.clock`, `.state`, `.set({mode,date,latitude,longitude,rate,stars,constellations})`, `.update(elapsedSeconds)`. Share links preserve current astronomical date/location/rate and guide settings. Old manual links remain manual.

`tests/astronomy.test.mjs` adds independent raw USNO modern/1805 and NASA/JPL1492 references with declared geometric/topocentric/parallax/time conventions, clock/share/geographic and historical-star invariants. `tests/celestial-gpu.test.mjs` uses the actual528-byte production specialization to check limb orientation, angular extent, horizon rejection and material light. Root executed these in the full native Metal suite: **572/572 tests passed**, **zero skips**, in **302.194 seconds**. Native actual four-vessel, full-Moon and new-Moon captures supplemented the suite; Pinta and Santa María were also reviewed in visible Chrome. This bounded runtime checkpoint is published and byte-verified. No2-arcminute navigation, sustained performance or physical iPhone qualification is asserted.

Still deferred: navigation lessons/hints, measured altitude/sextant/astrolabe UI, sight reduction and fixes, calendars other than explicit proleptic Gregorian, tides, eclipse/libration and calibrated stellar/airglow radiometry.
