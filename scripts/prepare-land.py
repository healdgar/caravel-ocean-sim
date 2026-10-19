"""Rebuild the Saba visual pilot from public Terrarium tiles. Requires Pillow.

python3 scripts/prepare-land.py [download-cache-directory]
No runtime mapping service or credentials are used by the game.
"""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import random
import statistics
import urllib.request
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/waterworld-terrain-source')
CACHE.mkdir(parents=True, exist_ok=True)
OUT = ROOT / 'assets/world/saba'
OUT.mkdir(parents=True, exist_ok=True)
sources = []

def source(url, name):
    file = CACHE / name
    if not file.exists():
        file.write_bytes(urllib.request.urlopen(url, timeout=60).read())
    data = file.read_bytes()
    sources.append(dict(url=url, sha256=hashlib.sha256(data).hexdigest()))
    return file

tiles = {}
for x in (1328, 1329):
    for y in (1843, 1844):
        url = f'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/12/{x}/{y}.png'
        tiles[x, y] = Image.open(source(url, f'{x}-{y}.png')).convert('RGB')

def pixel(x, y):
    tile = tiles[x // 256, y // 256]
    r, g, b = tile.getpixel((x % 256, y % 256))
    return r * 256 + g + b / 256 - 32768

def elevation(lon, lat):
    x = (lon + 180) / 360 * 4096 * 256 - .5
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 4096 * 256 - .5
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    return ((pixel(ix, iy) * (1-fx) + pixel(ix+1, iy)*fx) * (1-fy)
            + (pixel(ix, iy+1)*(1-fx) + pixel(ix+1, iy+1)*fx)*fy)

size, span, lon0, lat0 = 257, 8192, -63.238, 17.635
values = []
for j in range(size):
    lat = lat0 - (j/(size-1)-.5)*span/111195
    for i in range(size):
        lon = lon0 + (i/(size-1)-.5)*span/(111195*math.cos(math.radians(lat0)))
        h = elevation(lon, lat)
        # Zero-height ocean/no-data is not land. The underwater skirt is visual,
        # deliberately not labelled surveyed bathymetry.
        values.append(round(max(-120, h if h > .5 else min(-8, h))*4))
# The coarse coastal source includes isolated one/two-cell needles. Suppress
# tiny disconnected high patches in this visual pilot, retaining the main
# island's relief. This authored cleanup is recorded in the manifest.
remaining={i for i,h in enumerate(values) if h>50*4}
outliers=[]
while remaining:
    component=[remaining.pop()]
    for k in component:
        for neighbour in (k-1,k+1,k-size,k+size):
            if neighbour in remaining:
                remaining.remove(neighbour);component.append(neighbour)
    if len(component)<16:outliers.extend(component)
original=values[:]
for k in outliers:
    x,y=k%size,k//size
    values[k]=round(statistics.median(original[j*size+i]
        for j in range(max(0,y-3),min(size,y+4))
        for i in range(max(0,x-3),min(size,x+4))))
data = struct.pack('<' + 'h'*len(values), *values)
(OUT/'height.bin').write_bytes(data)
world = json.loads(source('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson', 'world.geojson').read_text())
rings = []
for feature in world['features']:
    geometry = feature['geometry']
    polygons = geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]
    for polygon in polygons:
        rings.append([[round(lon, 3), round(lat, 3)] for lon, lat in polygon[0]])
(OUT.parent/'land.json').write_text(json.dumps(rings, separators=(',', ':'))+'\n')
(OUT/'manifest.json').write_text(json.dumps(dict(
    name='Saba', latitude=lat0, longitude=lon0, spanMetres=span, gridSize=size,
    format='signed int16 little endian; metres = value / 4; rows north to south',
    accessed='2026-10-19', terrainSources=sources, heightSHA256=hashlib.sha256(data).hexdigest(),
    terrainCredit='Mapzen terrain tiles; global SRTM/GMTED2010 courtesy USGS; ETOPO1 courtesy NOAA.',
    worldCredit='Made with Natural Earth. Public domain.',
    visualCleanup=f'{len(outliers)} isolated coastal samples median-filtered; disconnected patches smaller than 16 cells above 50 m.',
    limitations='Elevation-derived coast; generated vegetation/materials; underwater skirt is not surveyed bathymetry.'
), indent=2)+'\n')
print(f'Saba: {size}² samples, {max(values)/4:.1f} m peak, {len(data)} bytes; {len(rings)} world outlines')

# A tileable canopy-height/material field, authored procedurally rather than
# satellite imagery. Its mip chain supplies dense understory at long range.
rng=random.Random(8721)
tex_size=512
canopy=[0.0]*(tex_size*tex_size)
for _ in range(3800):
    x,y=rng.randrange(tex_size),rng.randrange(tex_size)
    radius=rng.uniform(3.5,8.5);height=rng.uniform(.55,1)
    extent=math.ceil(radius)
    for dy in range(-extent,extent+1):
        for dx in range(-extent,extent+1):
            d=(dx*dx+dy*dy)/(radius*radius)
            if d<1:
                index=((y+dy)%tex_size)*tex_size+(x+dx)%tex_size
                canopy[index]=max(canopy[index],math.sqrt(1-d)*height)
texture=Image.new('RGBA',(tex_size,tex_size))
# Opaque packed data avoids browser alpha premultiplication during upload.
# Red/green are color; blue stores canopy height.
texture.putdata([(int(58+h*28),int(83+h*31),int(h*255),255) for h in canopy])
texture.save(OUT/'canopy.png',optimize=True)
