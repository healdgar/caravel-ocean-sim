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


def blend_near_heights(measured_heights, measured, coarse, x, z, spacing):
    # A labelled authored shallow skirt is separate from the measured dry land.
    # It is only a 48m shore transition, never a claimed bathymetric survey.
    distance = np.maximum(0, distance_transform_edt(~measured, sampling=spacing)-spacing/2)
    t = np.clip(distance/48, 0, 1); weight = 1-t*t*(3-2*t)
    authored = np.where(coarse <= 0, coarse*(1-weight)-np.maximum(.05, distance*.15)*weight, coarse)
    fine = np.where(measured, measured_heights, authored)
    edge = np.minimum.reduce([x-x.min(), x.max()-x, z-z.min(), z.max()-z])
    t = np.clip(edge/32, 0, 1); blend = t*t*(3-2*t)
    return (coarse+(fine-coarse)*blend).astype('<f4')


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
    measured = np.isfinite(heights) & (coverage >= .5) & (heights > .1)
    if not measured.any():
        raise ValueError('The original survey has no dry terrain in the requested crop')
    coarse = np.frombuffer((region_path/'height.bin').read_bytes(), dtype='<i2').astype(np.float64).reshape(parent['gridSize'], -1)/4
    base = triangle_sample(coarse, x, z, parent)
    final = blend_near_heights(heights, measured, base, x, z, spacing)
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
    # Keep source RGB, with alpha indicating missing imagery. Shader preserves
    # the existing regional macro colour and blends detail out at the seam.
    image = Image.fromarray(registered)
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
                distanceDepthSlope=.15, shallowMinimumMetres=.05, transitionMetres=48),
            imagery=dict(url=url, sourceSHA256=digest_file(image_path), size=1024, derivedSpacingMetres=1,
                licence='CC BY 4.0', licenceURL='https://creativecommons.org/licenses/by/4.0/',
                acquisition=parent['imagery']['acquisition'], processing='Independent WMS crop reprojected to local metric domain; RGB preserved. Native source resolution is not certified by request dimensions.'))
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
