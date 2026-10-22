# Wells Bay near terrain

Source implementation awaiting root baking and validation. No generated tile is
included with the code. The original Saba height/albedo/biome bytes stay intact.

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

`measured.bin` records dry survey support. Missing ground returns retain the
resident surface. Wet unsupported cells receive an explicitly authored 48 m
shore transition, **not surveyed bathymetry or a reconstructed beach**. A 32 m
perimeter blends onto the original coarse triangle planes. The loader checks
receipts, grid alignment and every boundary height before replacing coarse cells.

Terrain vertices and fine height storage upload once. Main/submerged rendering,
CPU roots/clearance and GPU coastal/light queries share the same fine triangle
diagonal. Within measured dry support, the independent local RGB supplies actual
linear diffuse colour, blending to the resident image across the 32 m seam. It
is not normalized back to the older 8 m image's colour. Original RGB bytes and
the WMS source hash remain intact; exported alpha intersects source opacity with
at least 95% dry DTM coverage independently warped onto the 1 m imagery grid and
a conservative 1 m shore inset. Opaque WMS sea/surf cannot certify dry imagery.

Steep faces use the nearest confident 8/16/32 m landward image patch as a stable
colour seed. Sampling accounts for the whole surface footprint and changes in
the landward normal, with a minimum 4 m colour footprint. Missing confidence
retains the registered fallback. Geographic photography is never projected
around a cliff axis. Grain, bounded authored strata and joints instead use
filtered surface coordinates and disappear before their features become
subpixel. They add material relief, not surveyed ledges or new rock geometry.
There is no per-frame JavaScript terrain deformation or global vegetation-policy
change. Ground-patch bounds include fine peaks; existing local roots re-seat once.

Material revision requires `--force` to rebake the optional pack's alpha and
provenance. It changes no global Saba assets or terrain heights. The authored
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
