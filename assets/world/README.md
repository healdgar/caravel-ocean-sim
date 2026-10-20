# Selected-region landfall data

The first region is Saba, centered at 17.635° N, 63.238° W. Local X points east
and Z south; the world origin places the island center at `(0, -6000)` metres.
The pack covers 8192 m on a side, with 513² elevation samples (16 m spacing).
`height.bin` is row-major signed little-endian int16, four units per metre.

Relief source: **Beeldmateriaal Nederland, Saba 2023 bare-earth LiDAR DTM**, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The original GeoTIFF is
half-metre spacing; runtime data is area-averaged to 16 m and reprojected. The
publisher identifies the local metric coordinates as Saba DPnet (EPSG:10641);
the TIFF itself carries a generic LOCAL_CS tag, so this assignment is recorded.
Missing forest ground returns are interpolated from nearby measured ground
after closing short return gaps. Exterior no-data remains an authored underwater
skirt. The manifest retains source/derived hashes, the exact URL, processing
and CRS/datum limitations. Heights are not transformed to chart datum and the
result is not a bathymetric or navigation survey. See
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

`land.json` contains rounded exterior rings from Natural Earth's public-domain
1:110 million land polygons. It supplies the world overview only.

## Real imagery as a generation seed

`albedo.png` is derived from **Beeldmateriaal Nederland, Saba RGB
orthophotography**, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The [publisher's Caribbean dataroom](https://www.beeldmateriaal.nl/dataroom-caribisch-nederland)
links the public WMS used for this small crop. The publisher describes Saba
acquisition around 2023–2024. The service's `2025-05-27` layer label is a
publication label, not an asserted capture date. `manifest.json` retains the
exact GetMap URL, raw download SHA-256, derived hashes and processing notes.

The crop covers the same 8192 m metric domain as the height grid, reprojected
from EPSG:3857 to the demo's local equirectangular grid. The distributed texture
is 1024², **8 m per pixel**, downsampled from aerial source data. Natural ground
receives only 0.2-pixel antialiasing: broad pale cliffs and canopy contrast are
retained. Median cleanup is limited to 64 compact neutral-bright features in
predominantly vegetated surroundings, affecting 189 of 1,048,576 pixels. That
conservative heuristic is an authored infrastructure approximation, not complete
building/road identification. Bounded local shadow lifting reduces photographed
shading. This does not perfectly remove cast
shadows, recover calibrated surface reflectance or reconstruct historical land
cover. Some modern features may remain. Broad green interior and exposed brown
slopes come from the source image, rather than an invented repeating palette.
Water/no-data pixels receive an authored neutral ground fallback where the
coarse elevation coast disagrees with the imagery.

`biome.bin` is a 512² uint8 vegetation probability layer derived from RGB
greenness, not a measured species/forest inventory. The same north-to-south rows
and eastward columns register it with the DEM and colour texture. Tree placement
also requires dry ground, a supported elevation and a moderate slope. The source
is an appearance seed; no depth or navigable clearance is inferred from colour.

Rebuild with Python 3, Pillow, numpy, scipy and rasterio as local authoring
dependencies, plus the project's Node.js runtime for the exact tree-count report. The
first importer supplies the overview and an obsolete global-relief baseline;
the second replaces that baseline with the local LiDAR survey and imagery seed:

```sh
python3 scripts/prepare-land.py /tmp/waterworld-terrain-source
python3 scripts/prepare-land-imagery.py /tmp/waterworld-terrain-source
npm run build
```

Use `python3 scripts/prepare-land-imagery.py --imagery-only` to revise the image
seed while preserving every existing terrain and authored-seabed byte.

Both importers cache their source snapshots. Preserve that cache for exact
reproduction if the upstream WMS changes. The game makes no runtime WMS request
and needs no mapping account or key. The older `canopy.png` remains an unused
procedural-source artifact; rendering now uses the registered imagery seed.

## Deterministic generated vegetation

`js/vegetation.js` generates a bounded library of four original recursive branch
and foliage-cluster forms for the native WebGPU renderer. The source image drives
placement probability, producing 1,775 instances in this pack revision. Stable
seeds determine roots, height, radius and shape;
camera position never regenerates them. Low, middle and near meshes use the same
canonical branch skeleton and crown bounds. Distance changes tessellation and
branch detail, with hysteresis. Maximum near/middle counts are 192/1024;
overflow uses the cheaper representation at the same location and physical
scale. All farther instances retain a compact canopy mesh and the same regional
colour field. At most twelve instanced vegetation batches are submitted. No
Three.js runtime, per-frame tree rebuilding, shrinking trees or camera-seeded
placement is involved. Species and individual trees are plausible authored
generation, not reconstructed observations.

`js/terrain-model.js:LAND_REGIONS` and each pack's manifest give every layer a
shared metric domain and explicit assets. This is a single resident Saba pack;
the format prepares selected river reaches, island groups and coastal strips,
without importing a detailed world or implementing voyage compression.

The elevation-derived shoreline is still limited by the distributed 16 m grid,
ground-return gaps and source alignment. Original relief is retained at that
budget; no decorative displacement noise changes the mountain silhouette.
Ocean/no-data elevations receive an authored submerged skirt; this is not
bathymetry. Water tint and shore foam are
visual approximations. Hull clearance prevents land penetration but cannot support
survey-quality shoal navigation. No playable settlements or modern structures
are authored. Actual iPhone combined ocean/terrain frame time remains a device
measurement requirement; instance limits are an implementation budget, not a
claim of 30 FPS on a phone.
