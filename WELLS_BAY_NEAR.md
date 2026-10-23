# Wells Bay near terrain

Local source candidate baked and reviewed by root; publication is held for the
native Forestmodeler integration. The original regional Saba height/albedo/biome
bytes stay intact.

The optional tile covers X −2048…−1024 m, Z −7504…−6480 m, around the existing
Wells Bay approach. Its default 2 m grid comes directly from the recorded 0.5 m
Beeldmateriaal Nederland DTM, without the existing 16 m intermediate reduction.
A separate 1024² WMS crop supplies resolved local imagery detail. Request size
alone does not certify the provider's native imagery resolution.

Root explicitly runs the exporter with the recorded source in its cache:

```sh
python3 scripts/prepare-land-imagery.py /tmp/waterworld-terrain-source --near-tile
# Optional: --spacing 1; --force replaces an existing near pack.
```

The exporter refuses a missing or hash-mismatched original DTM. It may fetch the
bounded WMS crop when that exact URL is not cached. The source remains CC BY 4.0;
its URL, hash, CRS assignment and unchanged local vertical-datum caveat are in
the new manifest. The parent Saba manifest gains only a `nearTile` pointer.

`measured.bin` records dry survey support. Missing inland ground returns retain
the resident surface. Independent OpenStreetMap coastline rings correct2,543
unsupported positive coarse samples outside mapped land, beyond an authored4m
safety band. Measured dry ground wins over approximate mapping, including rocks.
Wet unsupported cells receive an explicitly authored48m
shore transition, **not surveyed bathymetry or a reconstructed beach**. A 32 m
perimeter blends onto the original coarse triangle planes. The loader checks
receipts, grid alignment and every boundary height before replacing coarse cells.

Terrain vertices and fine height storage upload once. Main/submerged rendering,
CPU roots/clearance and GPU coastal/light queries share the same fine triangle
diagonal. Within measured dry support, the independent local RGB supplies actual
linear diffuse colour, blending to the resident image across the 32 m seam. It
is not normalized back to the older 8 m image's colour. Original RGB bytes and
the WMS source hash remain intact; exported alpha intersects source opacity with
either at least95% dry DTM coverage or mapped land more than4m inland, plus a
conservative1m pixel inset. Thus sparse ground returns do not reject real inland
photography. Opaque WMS sea/surf and blue/yellow hue cannot certify land.

Steep faces use the nearest confident 8/16/32 m landward image patch as a stable
colour seed. Sampling accounts for the whole surface footprint and changes in
the landward normal, with a minimum4m colour footprint. Raised masked gaps try a
bounded independent dry-colour search before the resident fallback, including
unmeasured positive cells. Geographic photography is never projected
around a cliff axis. Grain, bounded authored strata and joints instead use
filtered surface coordinates and disappear before their features become
subpixel. They add material relief, not surveyed ledges or new rock geometry.
There is no per-frame JavaScript terrain deformation or global vegetation-policy
change. Ground-patch bounds include fine peaks; existing local roots re-seat once.

Material revision requires `--force` to rebake the optional pack's alpha and
provenance. It changes no global Saba assets. The mapped-ocean revision also
corrects local unsupported heights. The authored
native material regression isolates dark fine RGB versus pale coarse RGB,
shore-mask fallback, landward direction, seam weighting and subpixel relief;
the Python regression checks alpha conservatism and unchanged source RGB.

`nearTerrain=off` retains the complete coarse path for an explicit comparison.
Without optional parent metadata, no near asset is requested. A corrupt declared
pack retains coarse geometry and reports `terrain.nearStats.error`.

This is a fixed bounded fine tile, not a full terrain streaming/LOD system, beach
ecology, harbour, cliff overhang reconstruction or breaking/swash solver. Root
must qualify source/packaged/offline pages, seam silhouette, roots, real imagery,
GPU resource limits and performance at identical approach/coast cameras before
publication. Authored tests are not validation receipts.

Root receipts: Python importer8/8(`waterworld-shore-tests-196.log`); four native
source renders195 load cleanly at coast/close-tree/approach/horizon cameras. The
blue raised foreground wall is removed. Heightfield interpolation and projected
photography still limit close cliffs; this does not complete beach/swash work.

The separately licensed OSM source rings, IDs, snapshot and query are distributed
in `assets/world/saba/wells-bay-shoreline.geojson`. `scripts/prepare-shoreline.py`
recreates them from the recorded cached Overpass reply. ODbL1.0 applies to the
coastline-derived composite; source imagery/DTM retain CC BY4.0 attribution.
See `THIRD_PARTY_NOTICES.md`. The4m band is not a certified mapping accuracy;
mean high water is not the instantaneous tide. The32m seam intentionally retains
the unchanged resident surface and can retain its coastal error at the edge.
