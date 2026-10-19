# Landfall data

The first region is Saba, centered at 17.635° N, 63.238° W. Local X points east
and Z south; the world origin places the island center at `(0, -6000)` metres.
The pack covers 8192 m on a side, with 257² elevation samples (32 m spacing).
`height.bin` is row-major signed little-endian int16, four units per metre.

Source: Mapzen Terrain Tiles, zoom 12, Terrarium encoding. The manifest retains
URLs, original download hashes and the derived elevation hash. Global source
credits: SRTM/GMTED2010 (USGS), ETOPO1 (NOAA); see
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

`land.json` contains rounded exterior rings from Natural Earth's public-domain
1:110 million land polygons. It supplies the world overview only.

Rebuild with Python 3 and Pillow:

```sh
python3 scripts/prepare-land.py /tmp/waterworld-terrain-source
npm run build
```

The script caches source downloads. Keep that cache to reproduce the exact
manifest if the upstream files change. There is no runtime map service/API key.
`canopy.png` is an original deterministic procedural field: red/green store color,
blue canopy height, alpha opaque. Generated forest is not geographic land-cover
data. It is mipmapped on upload; rounded instanced crowns supplement its silhouette.

The elevation-derived shoreline is coarse. Twelve isolated high coastal samples
are median-filtered to suppress subgrid needles; this authored cleanup is recorded
in the manifest. The main island relief is retained. Ocean/no-data elevations receive an
authored submerged skirt; this is not bathymetry. Water tint and shore foam are
visual approximations. Hull clearance prevents land penetration but cannot support
survey-quality shoal navigation. No settlements or modern structures are authored.
