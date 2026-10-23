#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Bounded near-coast derivative; root explicitly runs acquisition/export.

Uses the original, hash-verified 0.5m DTM, never the 16m derivative as survey.
Only a new wells-bay/ pack and the parent manifest's optional pointer change.
The original height, albedo and biome bytes remain unchanged. No Blender.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import tempfile
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image
import rasterio
from rasterio.transform import Affine
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.windows import from_bounds, Window
from rasterio.features import rasterize
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parents[1]
DTM_URL = 'https://basisdata.nl/hwh-ortho/Caribisch_NL/LiDAR/caribisch/Saba/02a_DTM_50cm/M_SABA2023.TIF'
DTM_SHA = 'c72247094f1f08b038c59b88d832a461914047b580ac5e0cc2f8f31848c5c955'
WMS = 'https://api.ellipsis-drive.com/v3/ogc/wms/37a9029d-7578-4471-826d-3b40d721b83b'
LAYER = '007963d5-7a71-4d40-b6ce-b4440306244f_786eb116-19ff-4406-bd3e-3d03bf8b89af'


def digest_file(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(1024 * 1024):
            result.update(block)
    return result.hexdigest()


def triangle_sample(heights, x, z, manifest):
    n = manifest['gridSize']; span = manifest['spanMetres']; origin = manifest['localOrigin']
    u = (x-origin['x']+span/2)*(n-1)/span; v = (z-origin['z']+span/2)*(n-1)/span
    i = np.clip(np.floor(u).astype(int), 0, n-2); j = np.clip(np.floor(v).astype(int), 0, n-2)
    a = u-i; b = v-j
    return np.where(a+b <= 1,
        heights[j, i]+a*(heights[j, i+1]-heights[j, i])+b*(heights[j+1, i]-heights[j, i]),
        heights[j+1, i+1]+(1-a)*(heights[j+1, i]-heights[j+1, i+1])+(1-b)*(heights[j, i+1]-heights[j+1, i+1]))


def near_coordinates(manifest, spacing):
    if spacing not in (1, 2):
        raise ValueError('Near terrain spacing must be 1 or 2 metres')
    # Boundaries lie on resident 16m edges, around Wells Bay's authored target.
    x0, z0, span = -2048.0, -7504.0, 1024.0
    n = int(span/spacing)+1
    x, z = np.meshgrid(x0+np.arange(n)*spacing, z0+np.arange(n)*spacing)
    origin = manifest['localOrigin']
    lon = manifest['longitude']+(x-origin['x'])/(111195*math.cos(math.radians(manifest['latitude'])))
    lat = manifest['latitude']-(z-origin['z'])/111195
    return x, z, lon, lat


def shoreline_context(geojson, manifest, x, z, spacing, tolerance=4):
    """Independent mapped shore; never infer water from blue/shadowed imagery.

    Coastline is approximate mean high water, not a bathymetric survey. A 4m
    uncertainty band cannot override measured ground or certify missing water.
    """
    origin = manifest['localOrigin']; shapes = []
    for feature in geojson['features']:
        geometry = feature['geometry']
        if geometry['type'] != 'Polygon':
            raise ValueError('Expected closed coastline polygons')
        rings = []
        for ring in geometry['coordinates']:
            if len(ring) < 4 or ring[0] != ring[-1]:
                raise ValueError('Open coastline ring')
            rings.append([[(lon-manifest['longitude'])*111195*math.cos(math.radians(manifest['latitude']))+origin['x'],
                           (manifest['latitude']-lat)*111195+origin['z']] for lon, lat in ring])
        shapes.append((dict(type='Polygon', coordinates=rings), 1))
    if not shapes or tolerance < 0:
        raise ValueError('Missing coastline or invalid tolerance')
    land = rasterize(shapes, out_shape=x.shape, transform=Affine(spacing, 0, x.min()-spacing/2,
                     0, spacing, z.min()-spacing/2), fill=0, dtype='uint8').astype(bool)
    if not land.any() or land.all():
        raise ValueError('Mapped shoreline does not cross the requested coastal tile')
    distance = np.maximum(0, distance_transform_edt(~land, sampling=spacing)-spacing/2)
    return (~land) & (distance > tolerance), distance, land


def blend_near_heights(measured_heights, measured, coarse, x, z, spacing, confirmed_ocean=None, shore_distance=None):
    # A labelled authored shallow skirt is separate from the measured dry land.
    # It is only a 48m shore transition, never a claimed bathymetric survey.
    distance = np.maximum(0, distance_transform_edt(~measured, sampling=spacing)-spacing/2)
    t = np.clip(distance/48, 0, 1); weight = 1-t*t*(3-2*t)
    authored = np.where(coarse <= 0, coarse*(1-weight)-np.maximum(.05, distance*.15)*weight, coarse)
    if confirmed_ocean is not None:
        if confirmed_ocean.shape != coarse.shape or shore_distance is None or shore_distance.shape != coarse.shape:
            raise ValueError('Mapped shore is not registered to terrain')
        # Missing inland returns keep their resident surface; confirmed ocean
        # cannot inherit the coarse gap-filler's positive coastal overhang.
        ocean_bed = -np.minimum(120, np.maximum(.05, shore_distance*.15))
        authored = np.where(confirmed_ocean, ocean_bed, authored)
    fine = np.where(measured, measured_heights, authored)
    edge = np.minimum.reduce([x-x.min(), x.max()-x, z-z.min(), z.max()-z])
    t = np.clip(edge/32, 0, 1); blend = t*t*(3-2*t)
    return (coarse+(fine-coarse)*blend).astype('<f4')


def mask_near_albedo(pixels, dry_coverage, pixel_metres=1, shore_inset_metres=1):
    """Keep source RGB; alpha certifies conservative measured dry support.

    The WMS alpha alone is not a coast mask: opaque foam and sea are valid image
    pixels. Coverage is independently warped from the original 0.5m DTM's dry
    returns, not from the authored seabed or the coarser runtime height grid.
    """
    if pixels.ndim != 3 or pixels.shape[2] != 4 or pixels.shape[:2] != dry_coverage.shape:
        raise ValueError('Albedo and measured dry support are not registered')
    if not np.isfinite(dry_coverage).all() or pixel_metres <= 0 or shore_inset_metres < 0:
        raise ValueError('Invalid measured imagery support')
    supported = dry_coverage >= .95
    # An explicit one-image-pixel inset rejects mixed shore/surf pixels. Padding
    # treats the unobserved exterior conservatively instead of extending land.
    distance = distance_transform_edt(np.pad(supported, 1), sampling=pixel_metres)[1:-1, 1:-1]
    supported &= distance > shore_inset_metres
    result = pixels.copy()
    result[:, :, 3] = np.where(supported, pixels[:, :, 3], 0)
    return result


def qualify_inland_imagery(coverage, mapped_land, spacing=1, inset=4):
    """Mapped inland gaps may qualify dry imagery; never classify by RGB hue."""
    if coverage.shape != mapped_land.shape or spacing <= 0 or inset < 0:
        raise ValueError('Unregistered inland imagery support')
    inland = np.maximum(0, distance_transform_edt(mapped_land, sampling=spacing)-spacing/2)
    return np.maximum(coverage, (inland > inset).astype(np.float32))


def prepare(cache, region_path, spacing=2, force=False):
    region_path = Path(region_path); cache = Path(cache)
    parent_path = region_path/'manifest.json'; parent = json.loads(parent_path.read_text())
    protected = {name: digest_file(region_path/name) for name in ('height.bin', 'albedo.png', 'biome.bin')}
    if protected['height.bin'] != parent['heightSHA256']:
        raise ValueError('Resident base height bytes do not match their receipt')
    output = region_path/'wells-bay'
    if output.exists() and not force:
        raise ValueError('Near pack exists; use --force to replace it explicitly')
    dtm_path = cache/'M_SABA2023.TIF'
    if not dtm_path.exists() or digest_file(dtm_path) != DTM_SHA:
        raise ValueError('Place the recorded, hash-matching M_SABA2023.TIF in the cache before exporting')
    x, z, lon, lat = near_coordinates(parent, spacing); n = len(x)
    west, east, north, south = float(lon.min()), float(lon.max()), float(lat.max()), float(lat.min())
    transform = Affine((east-west)/(n-1), 0, west-(east-west)/(n-1)/2,
                       0, -(north-south)/(n-1), north+(north-south)/(n-1)/2)
    heights = np.full((n, n), np.nan, dtype=np.float32); coverage = np.zeros((n, n), dtype=np.float32)
    image_coverage = np.zeros((1024, 1024), dtype=np.float32)
    image_transform = Affine((east-west)/1024, 0, west, 0, -(north-south)/1024, north)
    with rasterio.open(dtm_path) as dtm:
        bounds = transform_bounds('EPSG:4326', 'EPSG:10641', west, south, east, north, densify_pts=21)
        window = from_bounds(*bounds, dtm.transform)
        window = Window(window.col_off-8, window.row_off-8, window.width+16, window.height+16).round_offsets().round_lengths()
        raw = dtm.read(1, window=window, boundless=True, masked=True).astype(np.float32).filled(np.nan)
        valid = np.isfinite(raw) & (raw > .1) & (raw < 1000)
        raw = np.where(valid, raw, np.nan).astype(np.float32)
        common = dict(src_transform=dtm.window_transform(window), src_crs='EPSG:10641', dst_transform=transform,
                      dst_crs='EPSG:4326', resampling=Resampling.average, warp_mem_limit=64)
        reproject(source=raw, destination=heights, src_nodata=np.nan, dst_nodata=np.nan, **common)
        reproject(source=valid.astype(np.float32), destination=coverage, dst_nodata=0, **common)
        image_common = {**common, 'dst_transform': image_transform}
        reproject(source=valid.astype(np.float32), destination=image_coverage, dst_nodata=0, **image_common)
    measured = np.isfinite(heights) & (coverage >= .5) & (heights > .1)
    if not measured.any():
        raise ValueError('The original survey has no dry terrain in the requested crop')
    coarse = np.frombuffer((region_path/'height.bin').read_bytes(), dtype='<i2').astype(np.float64).reshape(parent['gridSize'], -1)/4
    base = triangle_sample(coarse, x, z, parent)
    shore_path = region_path/'wells-bay-shoreline.geojson'
    shore = json.loads(shore_path.read_text())
    ocean, shore_distance, _ = shoreline_context(shore, parent, x, z, spacing)
    final = blend_near_heights(heights, measured, base, x, z, spacing, ocean, shore_distance)
    if not np.isfinite(final).all():
        raise ValueError('Nonfinite near terrain')
    # Request a small true geographic crop. Increasing the old 8m island image's
    # resolution would only interpolate blur; retain this independent source URL.
    mx = lambda value: 6378137*math.radians(value)
    my = lambda value: 6378137*math.asinh(math.tan(math.radians(value)))
    wms_bounds = [mx(west), my(south), mx(east), my(north)]
    url = WMS+'?'+urllib.parse.urlencode(dict(SERVICE='WMS', VERSION='1.3.0', REQUEST='GetMap', LAYERS=LAYER,
        STYLES='', CRS='EPSG:3857', BBOX=','.join(map(str, wms_bounds)), WIDTH='1024', HEIGHT='1024', FORMAT='image/png', TRANSPARENT='true'))
    key = hashlib.sha256(url.encode()).hexdigest()[:16]; image_path = cache/f'wells-bay-orthophoto-1024-{key}.png'
    cache.mkdir(parents=True, exist_ok=True)
    if not image_path.exists():
        with urllib.request.urlopen(url, timeout=60) as response:
            image_path.write_bytes(response.read())
    image = Image.open(image_path).convert('RGBA')
    if image.size != (1024, 1024):
        raise ValueError('Unexpected Wells Bay WMS dimensions')
    pixels = np.asarray(image); registered = np.empty_like(pixels)
    for j in range(1024):
        latitude = north-(j+.5)/1024*(north-south)
        row = max(0, min(1023, round((wms_bounds[3]-my(latitude))/(wms_bounds[3]-wms_bounds[1])*1024-.5)))
        registered[j] = pixels[row]
    # Ground-return gaps do not turn dry cliffs/forest into photographed water.
    # The independent shoreline can also qualify imagery well inside mapped
    # land. Keep a conservative4m inland buffer plus the existing1m pixel inset.
    ix, iz = np.meshgrid(x.min()+np.arange(1024)+.5, z.min()+np.arange(1024)+.5)
    _, _, image_land = shoreline_context(shore, parent, ix, iz, 1)
    image_coverage = qualify_inland_imagery(image_coverage, image_land)
    # Opaque source water is still water. Preserve every registered RGB byte;
    # alpha records independent dry support, never a colour/hue classification.
    image = Image.fromarray(mask_near_albedo(registered, image_coverage))
    with tempfile.TemporaryDirectory(prefix='wells-bay-', dir=region_path) as temporary:
        folder = Path(temporary)
        (folder/'height.bin').write_bytes(final.tobytes())
        (folder/'measured.bin').write_bytes(measured.astype(np.uint8).tobytes())
        image.save(folder/'albedo.png', optimize=True)
        files = {name: dict(bytes=(folder/name).stat().st_size, sha256=digest_file(folder/name)) for name in ('height.bin', 'measured.bin', 'albedo.png')}
        manifest = dict(format='waterworld.terrain-near', version=1, id='wells-bay', region=parent['id'],
            domain=dict(x=-1536, z=-6992, span=1024, size=n, spacing=spacing), edgeBlendMetres=32,
            baseHeightSHA256=protected['height.bin'], files=files,
            source=dict(url=DTM_URL, sha256=DTM_SHA, spacingMetres=.5, licence='CC BY 4.0',
                licenceURL='https://creativecommons.org/licenses/by/4.0/', crs='EPSG:10641 (publisher assignment; source TIFF LOCAL_CS)',
                verticalDatum='Publisher local DTM heights; no hydrographic datum conversion',
                processing='Original raster crop; area-average directly to near grid without intermediate16m reduction. Binary measured mask records dry source support.32m perimeter blends to exact resident triangle surface.'),
            authoredWetCells=dict(provenance='Unmeasured cells use resident terrain; a48m dry-shore-distance skirt on wet cells is authored, not surveyed bathymetry or a reconstructed beach.',
                distanceDepthSlope=.15, shallowMinimumMetres=.05, transitionMetres=48,
                mappedOceanOverride='Unmeasured cells more than4m outside the independent mapped coastline receive negative authored depth even where the resident gap-fill was positive; measured ground and inland gaps remain unchanged.32m perimeter seam remains exact.',
                correctedPositiveCoarseNodes=int(np.sum(ocean & ~measured & (base > 0)))),
            derivedDataLicence='Coastline-derived composite: ODbL1.0; terrain and imagery source attribution remains CC BY4.0',
            shoreline=dict(sourceFile='assets/world/saba/wells-bay-shoreline.geojson',
                sourceDataURL='https://raw.githubusercontent.com/healdgar/caravel-ocean-sim/main/assets/world/saba/wells-bay-shoreline.geojson', sha256=digest_file(shore_path),
                source=shore['source'], attribution=shore['attribution'], licence=shore['licence'],
                snapshot=shore['snapshot'], uncertaintyMetres=4,
                interpretation='Approximate mean high water coastline, not a surveyed beach profile, instantaneous tide or measured bathymetry. A mapping constraint only where original dry ground is absent.'),
            imagery=dict(url=url, sourceSHA256=digest_file(image_path), size=1024, derivedSpacingMetres=1,
                licence='CC BY 4.0', licenceURL='https://creativecommons.org/licenses/by/4.0/',
                acquisition=parent['imagery']['acquisition'],
                alphaMask=dict(source='Original hash-verified0.5m DTM dry-return coverage OR independent mapped land more than4m inland, registered onto the1m imagery grid',
                    minimumDryCoverage=.95, shoreInsetMetres=1, modifiedChannels=['alpha'],
                    sourceAlpha='Intersected with measured dry support; original RGB retained, including masked pixels'),
                processing='Independent WMS crop reprojected to local metric domain; RGB preserved. Alpha qualified by measured dry support or mapped inland support with conservative shore insets, not by colour, WMS water opacity or authored bathymetry. Native source resolution is not certified by request dimensions.'))
        (folder/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
        output.mkdir(exist_ok=True)
        for name in (*files, 'manifest.json'):
            (folder/name).replace(output/name)
    if protected != {name: digest_file(region_path/name) for name in protected}:
        raise ValueError('Near export changed a protected resident asset')
    parent['nearTile'] = 'wells-bay/manifest.json'
    temporary = parent_path.with_suffix('.json.tmp'); temporary.write_text(json.dumps(parent, indent=2)+'\n'); temporary.replace(parent_path)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cache', type=Path, nargs='?', default=Path('/tmp/waterworld-terrain-source'))
    parser.add_argument('--near-tile', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--spacing', type=int, choices=(1, 2), default=2)
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--region', type=Path, default=ROOT/'assets/world/saba')
    args = parser.parse_args(); result = prepare(args.cache, args.region, args.spacing, args.force)
    print('Prepared Wells Bay near tile:', result['domain'], 'Existing height/albedo/biome bytes preserved.')
