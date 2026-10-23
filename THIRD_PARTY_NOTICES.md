# Third-party code and data

## Procedural tree growth reference

The recursive branching and leaf-card approach follows Dan Greenheck's
[Fractals to Forests](https://tympanus.net/codrops/2025/01/27/fractals-to-forests-creating-realistic-3d-trees-with-three-js/)
explanation of [EZ-Tree](https://github.com/dgreenheck/ez-tree).
The native WebGPU implementation and procedural twig-spray texture are original
project code/artwork under the project MIT licence. No EZ-Tree source, textures
or Three.js dependency are included. The texture generator is
`scripts/prepare-tree-foliage.py`.

## Saba LiDAR terrain and aerial imagery

Current Saba relief and RGB appearance seeds derive from **Beeldmateriaal
Nederland**, [Dataroom Caribisch Nederland](https://www.beeldmateriaal.nl/dataroom-caribisch-nederland),
under the [Creative Commons Attribution 4.0 International licence](https://creativecommons.org/licenses/by/4.0/).
The publisher describes Saba aerial/LiDAR acquisition around 2023–2024; the DTM
file is labelled Saba 2023. A WMS publication-layer date is not a capture date.

- Bare-earth source: [M_SABA2023.TIF](https://basisdata.nl/hwh-ortho/Caribisch_NL/LiDAR/caribisch/Saba/02a_DTM_50cm/M_SABA2023.TIF), half-metre spacing.
- RGB source: [Saba orthophoto WMS](https://api.ellipsis-drive.com/v3/ogc/wms/37a9029d-7578-4471-826d-3b40d721b83b?request=getCapabilities).

These data are **modified**. The local DTM is area-averaged, gap-interpolated,
reprojected and quantized to 16 m spacing. The publisher's EPSG:10641 coordinate
assignment is recorded because the original TIFF carries a generic LOCAL_CS tag;
no hydrographic vertical-datum conversion is asserted. A reduced orthophoto crop
is co-registered and lightly antialiased. Median historical cleanup is limited to
compact neutral-bright features in vegetated surroundings; natural pale cliffs
and canopy detail are retained. Bounded local shadow lifting reduces photographed
shade. Its colours seed authored ground appearance and a
greenness-derived vegetation mask; they are not calibrated surface reflectance,
surveyed species coverage or a reconstruction of historical land cover.
The exterior underwater skirt is authored and is not bathymetry.

`assets/world/saba/manifest.json` preserves exact download URLs, original and
derived SHA-256 hashes, licensing, coordinate assignment and processing limits.
`scripts/prepare-land-imagery.py` reproduces the local derivatives from cached
source downloads. CC BY 4.0 applies to these data derivatives; the project's MIT
code licence does not replace it. No endorsement by the source provider is implied.

## Wells Bay mapped shoreline

© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
[Open Database Licence1.0](https://opendatacommons.org/licenses/odbl/1-0/).
`assets/world/saba/wells-bay-shoreline.geojson` contains directed closed coastline
rings from the recorded Overpass reply (snapshot July24,2026; acquired October22).
The exact query, raw-reply hash and way IDs are retained. Recreate the rings with
`scripts/prepare-shoreline.py` and the coastal correction with
`scripts/prepare-wells-bay.py`. Source data and the reconstruction recipe are
distributed in this public repository; the coastline-derived composite retains
ODbL terms alongside the original terrain/imagery CC BY attribution. MIT applies
to project code and does not replace these data licences.

Mapped mean-high-water coastline constrains only unsupported coastal heights
and imagery support. Its4m safety band is authored, not a certified accuracy.
Measured ground remains authoritative; inland return gaps retain terrain. The
32m tile perimeter blends back to the unchanged regional terrain. Neither this
mapping constraint nor the authored submerged skirt is surveyed bathymetry or a
reconstructed beach/tide profile.

## Earlier global terrain prototype and world overview

The earlier Saba terrain prototype derived from [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/),
using four zoom-12 Terrarium tiles in the public `elevation-tiles-prod` bucket.
Global sources: SRTM and GMTED2010, courtesy U.S. Geological Survey; ETOPO1,
courtesy NOAA. These US-government source datasets are public domain. Preserve
the [Tilezen attribution guidance](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
when importing other regions, whose component datasets may have different terms.

World chart: Made with [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/).
The 1:110 million land polygons are public domain. This is an overview map, not
a navigational coastline.

`scripts/prepare-land.py` can recreate that older global-relief baseline and its
unused procedural canopy material; the local LiDAR/imagery importer now replaces
the rendered Saba relief and appearance. Coastline/skirt and vegetation adaptations
remain authored. No Google/Apple imagery, code or proprietary map data is incorporated.

## Quaternius crew assets

The male and female sailors adapt Quaternius Universal Base Characters and Universal
Animation Library (animations credited to Quaternius and Gonzalo Furnier), under
CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/.

Sources: https://quaternius.itch.io/universal-base-characters and
https://quaternius.itch.io/universal-animation-library.
The free Standard data was acquired from a public mirror pinned at
`NafisRayan/Animate-Rigged-Humanoid-No-Blender@5821923af517ac5fdc82505faa92a0d575fc1b1a`.
No mirror code is used. `assets/crew/README.md`, `assets/crew/LICENSE-CC0.txt` and
`scripts/prepare-crew.mjs` retain provenance, licence and exact source checksums.
Local costume/retargeting adaptations are also CC0.

## Joshbrew WebGPU clouds

The volumetric cloud density, cached lighting, and ray integration in
`js/wgsl/clouds.js` and `js/wgsl/cloud-model.js` adapt
[joshbrew/webgpu_realtime_clouds](https://github.com/joshbrew/webgpu_realtime_clouds)
at commit `bf7a48f949e25e09d463357149ec9d0009e97328`.

Source functions: `roundedCloudBody`, `cloudEllipsoid`, `cloudSoftUnion`, and
`buildCloudLightField` in `tools/clouds/shaders/cloudFields.wgsl`;
`cloudRayJitter` and the cached ray integration in `tools/clouds/shaders/clouds.wgsl`;
`contrast01`, `ridge01`, and `hash11Fast` in `tools/clouds/shaders/cloudCommon.wgsl`.

The adaptation uses kilometre coordinates, a periodic ocean cloud field, our
atmospheric LUTs, and our own camera reprojection and resource scheduling. It
omits the upstream playground, aircraft, terrain, planet renderer and engine
wrapper. Density changes rebuild the field; wind advects it without rebuilding.

MIT License

Copyright (c) 2025 Joshua Brewster (Bubba Skrimp)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
# User-supplied whale asset

`assets/wildlife/whale.glb` is a reduced derivative of the user's straight
Meshy-generated sperm whale, supplied as `Meshy_AI_Character_output (1).glb`
on 20 October 2026. It replaces the earlier curled whale. The source has 145,388
triangles and 18 weighted joints; the runtime mesh has 39,254 triangles. All three
source JPEG texture images are retained byte-for-byte. The supplied rig contains
no animation clips; swimming and water effects are project code.

Source SHA-256: `8bb6babe3cf638efb988e3509fdc2875451e93be52b44f5b06b24fe2a02e2d94`.
Runtime SHA-256: `af1b3d2448efbc0f67673f46494c890aa901a4728ac627c3d2d55e3b00fe43f3`.

# User-supplied Victory shape reference

The procedural Victory hull uses measurements from the user's
`Meshy_AI_Victory_at_Portsmouth_1020215320_generate.glb`, supplied on
20 October 2026. The original GLB and the supplied Portsmouth photograph are
not bundled. Registration, rejected artifacts and modelling limits are recorded
in `VICTORY_RESEARCH.md`; these measurements are not Admiralty construction offsets.

Reference SHA-256: `f54976c233c708811065981f00a1be9ff6b3c6a56880b34b36d391720cd3453e`.

## Astronomy Engine and stellar catalogue

Astronomical Sun/Moon positions, topocentric coordinates, precession/nutation,
photometric lunar phase and horizon rotations use **Astronomy Engine**, Don Cross,
MIT, pinned commit `865d3da7d8112bbc7911238052c6af4aaf877181`:
https://github.com/cosinekitty/astronomy/tree/865d3da7d8112bbc7911238052c6af4aaf877181 .
The unmodified browser distribution is enclosed in a local namespace in
`js/vendor/astronomy-engine.js`; its complete copyright/permission notice remains
inside that file and in `js/vendor/astronomy.LICENSE`.

`js/star-catalog.js` is a **modified HYG v4.1 data derivative**, by David Nash /
Astronexus, pinned commit `c7f7f883fe678cc7680169a50ccd7dcc49b060ce`:
https://github.com/astronexus/HYG-Database/tree/c7f7f883fe678cc7680169a50ccd7dcc49b060ce/hyg/CURRENT .
The derivative selects stars of visual magnitude ≤5.5 and retains J2000 Cartesian
position/velocity, V magnitude, B−V colour index, HIP identifiers and proper names.
**CC BY-SA 4.0 applies to this catalogue derivative**, separately from the MIT
simulator code: https://creativecommons.org/licenses/by-sa/4.0/ . Its original
notice is `js/vendor/hyg.LICENSE`. Illustrative constellation connections are
locally authored guides, not official IAU boundaries. Pinning, byte hashes and
sources are recorded in `js/vendor/README.md`.

Saved USNO/NASA/JPL reference responses in `tests/data/astronomy` retain their
request/convention provenance. Government reference data do not imply endorsement.

Astronomy Engine permission notice (also retained here for minified standalone distributions):

```text
MIT License

Copyright (c) 2019-2025 Don Cross <cosinekitty@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Meshoptimizer forest transport

The local forest decoder derives from meshoptimizer 1.3.0 by Arseny Kapoulkine.
Source: https://github.com/zeux/meshoptimizer . The embedded WebAssembly decoder
is unchanged; the local namespace/export is adapted for the standalone bundle.
Offline transport uses byte-exact attribute/index sequence encoding, without
lossy filters. Its complete MIT notice follows, retained in standalone builds.

```text
MIT License

Copyright (c) 2016-2026 Arseny Kapoulkine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
