"""Small, reproducible imagery seed for the Saba regional demonstration.

Requires Pillow, numpy, scipy and rasterio. Run after prepare-land.py; no key or GIS runtime
is needed by the game. GIS dependencies are authoring tools only.
The source is an openly licensed orthophoto, not a generated picture. Derived
colour and vegetation probability are authored interpretations, not land survey.
"""
from pathlib import Path
import hashlib
import json
import math
import subprocess
import sys
import urllib.parse
import urllib.request
from PIL import Image, ImageFilter
import numpy as np
import rasterio
from rasterio.transform import Affine
from rasterio.warp import reproject, Resampling
from rasterio.fill import fillnodata
from scipy.ndimage import distance_transform_edt, label, find_objects

ROOT = Path(__file__).resolve().parents[1]
if '--near-tile' in sys.argv:
    # Optional bounded export has its own receipts and never replaces the
    # resident island height/albedo/biome bytes. Root runs acquisition/export.
    import runpy
    runpy.run_path(str(ROOT/'scripts/prepare-wells-bay.py'), run_name='__main__')
    raise SystemExit
OUT = ROOT / 'assets/world/saba'
arguments=[arg for arg in sys.argv[1:] if not arg.startswith('--')]
IMAGERY_ONLY='--imagery-only' in sys.argv
CACHE = Path(arguments[0]) if arguments else Path('/tmp/waterworld-terrain-source')
CACHE.mkdir(parents=True, exist_ok=True)
SIZE, MASK_SIZE, SPAN, LAT, LON = 1024, 512, 8192, 17.635, -63.238
west, east = [LON+s*SPAN/2/(111195*math.cos(math.radians(LAT))) for s in (-1, 1)]
south, north = [LAT+s*SPAN/2/111195 for s in (-1, 1)]
mx = lambda lon: 6378137*math.radians(lon)
my = lambda lat: 6378137*math.asinh(math.tan(math.radians(lat)))
bounds = [mx(west), my(south), mx(east), my(north)]
manifest=json.loads((OUT/'manifest.json').read_text())
# --imagery-only preserves every height/seabed byte and its provenance.
if not IMAGERY_ONLY:
    # Replace the soft, canopy-influenced global terrain with the actual 2023 local
    # bare-earth survey. The published TIFF has a LOCAL_CS tag; the publisher's WMS
    # identifies its local metric system as Saba DPnet, EPSG:10641. Record that
    # explicit CRS assignment rather than silently interpreting these metres as UTM.
    dtm_url='https://basisdata.nl/hwh-ortho/Caribisch_NL/LiDAR/caribisch/Saba/02a_DTM_50cm/M_SABA2023.TIF'
    dtm_file=CACHE/'M_SABA2023.TIF'
    if not dtm_file.exists():
        with urllib.request.urlopen(dtm_url,timeout=120) as response, dtm_file.open('wb') as target:
            while block:=response.read(1024*1024): target.write(block)
    grid_size=513
    step_lon=(east-west)/(grid_size-1);step_lat=(north-south)/(grid_size-1)
    target_transform=Affine(step_lon,0,west-step_lon/2,0,-step_lat,north+step_lat/2)
    elevations=np.full((grid_size,grid_size),-8,dtype=np.float32)
    with rasterio.open(dtm_file) as dtm:
        # Average the half-metre ground returns before the warp. Sampling only four
        # original pixels leaves forest ground-return holes as false ocean craters.
        # GDAL's average excludes declared no-data and stays within the 16 m budget.
        reduced_shape=(math.ceil(dtm.height/32),math.ceil(dtm.width/32))
        reduced=dtm.read(1,out_shape=reduced_shape,resampling=Resampling.average)
        valid=reduced<1e30
        # The published DTM contains gaps between bare-earth returns under forest.
        # Close only short (<=128 m) return gaps, then interpolate nearby measured
        # ground. Preserve the exterior/no-data sea rather than treating it as land.
        land_mask=np.asarray(Image.fromarray(np.uint8(valid)*255).filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9)))>0
        reduced=fillnodata(np.where(valid,reduced,0),mask=np.uint8(valid),max_search_distance=16,smoothing_iterations=1)
        reduced=np.where(land_mask,reduced,dtm.nodata).astype(np.float32)
        reduced_transform=dtm.transform*Affine.scale(dtm.width/reduced_shape[1],dtm.height/reduced_shape[0])
        reproject(source=reduced,destination=elevations,
            src_transform=reduced_transform,src_crs='EPSG:10641',src_nodata=dtm.nodata,
            dst_transform=target_transform,dst_crs='EPSG:4326',dst_nodata=-8,
            resampling=Resampling.bilinear,warp_mem_limit=64)
    land=np.isfinite(elevations)&(elevations>.1)
    # LiDAR supplies land, not bathymetry. An explicitly authored coastal slope
    # permits deep-draft ships to approach without inventing a surveyed seabed.
    # Measure from the wet cell centre to the dry-cell boundary (half a cell back).
    spacing=SPAN/(grid_size-1)
    shore_distance=np.maximum(0,distance_transform_edt(~land,sampling=spacing)-spacing/2)
    authored_depth=np.minimum(120,2+.15*shore_distance)
    elevations=np.where(land,elevations,-authored_depth)
    height_bytes=np.rint(elevations*4).clip(-32768,32767).astype('<i2').tobytes()
    (OUT/'height.bin').write_bytes(height_bytes)
    dtm_hash=hashlib.sha256()
    with dtm_file.open('rb') as source_dtm:
        while block:=source_dtm.read(1024*1024):dtm_hash.update(block)
    manifest.update(dict(accessed='2026-10-20',gridSize=grid_size,heightSHA256=hashlib.sha256(height_bytes).hexdigest(),
        terrainSources=[dict(url=dtm_url,sha256=dtm_hash.hexdigest())],
        terrainCredit='Beeldmateriaal Nederland / Saba 2023 bare-earth LiDAR DTM, CC BY 4.0; reprojected and downsampled.',
        terrainSurvey=dict(sourceSpacingMetres=.5,derivedSpacingMetres=16,sourceCRS='EPSG:10641 (publisher assignment; TIFF carries LOCAL_CS)',
            sourceVerticalDatum='Publisher local DTM heights; not transformed to a hydrographic/chart datum.',
            processing='16 m area-average excluding missing ground returns; close <=128 m return gaps and interpolate nearby measured ground; bilinear reprojection to local equirectangular grid; quarter-metre quantization. Measured land elevations > 0.1 m retained; remaining cells use the separately declared authored coastal depth model.',
            licence='CC BY 4.0',licenceURL='https://creativecommons.org/licenses/by/4.0/'),
        authoredBathymetry=dict(provenance='Gameplay coastal skirt from shore distance; not measured bathymetry, chart soundings or a navigational aid.',
            method='Euclidean distance from each wet cell centre to the nearest dry cell, minus half the 16 m grid spacing; depth = min(120, 2 + 0.15 * distanceMetres).',
            minimumDepthMetres=2,maximumDepthMetres=120,depthPerShoreMetre=.15,
            shoreCellCorrectionMetres=spacing/2,derivedSpacingMetres=spacing),
        visualCleanup='No isolated-needle cleanup applied to local DTM. Modern road grading and other terrain alterations may remain.'))
url = 'https://api.ellipsis-drive.com/v3/ogc/wms/37a9029d-7578-4471-826d-3b40d721b83b?'+urllib.parse.urlencode(dict(
    SERVICE='WMS', VERSION='1.3.0', REQUEST='GetMap',
    LAYERS='007963d5-7a71-4d40-b6ce-b4440306244f_786eb116-19ff-4406-bd3e-3d03bf8b89af',
    STYLES='', CRS='EPSG:3857', BBOX=','.join(map(str, bounds)),
    WIDTH=str(SIZE), HEIGHT=str(SIZE), FORMAT='image/png', TRANSPARENT='true'))
source = CACHE / 'saba-orthophoto-1024.png'
if not source.exists():
    source.write_bytes(urllib.request.urlopen(url, timeout=60).read())
raw = source.read_bytes()
image = Image.open(source).convert('RGBA')
if image.size != (SIZE, SIZE):
    raise ValueError('Unexpected Saba orthophoto dimensions')
# Reproject the tiny Mercator GetMap onto the DEM's local equirectangular grid.
# North-to-south rows, eastward columns, exactly the existing height grid bounds.
rows = []
for j in range(SIZE):
    lat = north-(j+.5)/SIZE*(north-south)
    sy = (bounds[3]-my(lat))/(bounds[3]-bounds[1])*SIZE-.5
    rows.append(max(0, min(SIZE-1, round(sy))))
registered = Image.new('RGBA', (SIZE, SIZE))
pixels = image.load()
registered.putdata([pixels[i, rows[j]] for j in range(SIZE) for i in range(SIZE)])
# Preserve the aerial source's natural rock/canopy texture. Apply median cleanup
# only to small, compact, neutral-bright features surrounded by vegetation;
# this conservative image heuristic does not classify every building or road.
# Large pale cliffs, exposed slopes and elongated features are never recoloured.
rgba=np.asarray(registered)
rgb=rgba[:,:,:3].astype(np.float32)
maximum=rgb.max(axis=2);minimum=rgb.min(axis=2)
bright=(rgba[:,:,3]>127)&(minimum>140)&(maximum-minimum<48)
components,component_count=label(bright)
cleanup=np.zeros((SIZE,SIZE),dtype=np.uint8)
green=(2*rgb[:,:,1]/np.maximum(1,rgb[:,:,0]+rgb[:,:,2])>1.15)&(rgba[:,:,3]>127)
cleaned_components=0
for component,box in enumerate(find_objects(components),1):
    if box is None:continue
    ys,xs=box;height=ys.stop-ys.start;width=xs.stop-xs.start
    area=int(np.sum(components[box]==component))
    if not (1<=area<=20 and width<=6 and height<=6 and area/(width*height)>=.5):continue
    context=green[max(0,ys.start-3):min(SIZE,ys.stop+3),max(0,xs.start-3):min(SIZE,xs.stop+3)]
    if context.mean()<.45:continue
    cleanup[components==component]=255;cleaned_components+=1
cleanup_mask=Image.fromarray(cleanup)
median=registered.filter(ImageFilter.MedianFilter(5))
smooth=Image.composite(median,registered,cleanup_mask).filter(ImageFilter.GaussianBlur(.2))
low = smooth.filter(ImageFilter.GaussianBlur(16))
colours, vegetation = [], []
for (r,g,b,a),(lr,lg,lb,_) in zip(smooth.getdata(), low.getdata()):
    luminance = .2126*r+.7152*g+.0722*b
    local = .2126*lr+.7152*lg+.0722*lb
    # This cannot recover absolute spectral reflectance or perfectly remove
    # cast shadows. Bound the correction and record that uncertainty.
    lift = min(1.35, max(.90, (max(local, 32)/max(luminance, 10))**.25))*1.10
    valid = a > 127 and r+g+b > 10
    greenness = max(0, min(1, (2*g/max(1,r+b)-1.02)*2.1)) if valid and g>b else 0
    if not valid:
        r,g,b = 80,72,58
    colours.append((min(255,round(r*lift)), min(255,round(g*lift)), min(255,round(b*lift)),255))
    vegetation.append(round(greenness*255))
albedo = Image.new('RGBA',(SIZE,SIZE)); albedo.putdata(colours)
albedo.save(OUT/'albedo.png',optimize=True)
mask = Image.new('L',(SIZE,SIZE)); mask.putdata(vegetation)
mask = mask.resize((MASK_SIZE,MASK_SIZE),Image.Resampling.BOX)
mask_bytes=mask.tobytes();(OUT/'biome.bin').write_bytes(mask_bytes)
# Record the deterministic count using the actual runtime sampler, avoiding a
# second Python copy of its RNG, slope limits and geographic edge conventions.
vegetation_counts=json.loads(subprocess.check_output(['node','--input-type=module','-e',
    "import{readFileSync}from'node:fs';import{decodeIsland,decodeBiome,islandVegetation}from'./js/terrain-model.js';"
    "const h=readFileSync('assets/world/saba/height.bin'),b=readFileSync('assets/world/saba/biome.bin');"
    "const raw=x=>x.buffer.slice(x.byteOffset,x.byteOffset+x.byteLength);"
    "const {ISLAND}=await import('./js/terrain-model.js');"
    "console.log(JSON.stringify({instances:islandVegetation(decodeIsland(raw(h)),decodeBiome(raw(b))).length/8,candidates:ISLAND.vegetationCandidates}));"],cwd=ROOT,text=True))
manifest.update(dict(
    schemaVersion=2, id='saba', kind='island-region',
    localOrigin=dict(x=0,z=-6000), projection='local equirectangular, metres; X east, Z south',
    assets=dict(height='height.bin',albedo='albedo.png',biome='biome.bin'),
    imagery=dict(source='Beeldmateriaal Nederland / Saba RGB orthophoto',
        sourcePage='https://www.beeldmateriaal.nl/dataroom-caribisch-nederland',
        licence='CC BY 4.0',licenceURL='https://creativecommons.org/licenses/by/4.0/',
        acquisition='2023–2024; publisher describes acquisition around 2023/2024',
        serviceLayerDate='2025-05-27 (publication layer label, not capture date)',
        accessed='2026-10-20',url=url,sourceSHA256=hashlib.sha256(raw).hexdigest(),
        textureSize=SIZE,derivedSpacingMetres=SPAN/SIZE,
        processing='Co-registered to DEM; 0.2-pixel antialias only across natural ground. Median cleanup limited to compact neutral-bright components of <=20 pixels, <=6 pixels wide/high, in predominantly vegetated context; broad pale rock/cliffs and canopy detail retained, no global bright-ground recolouring. Bounded local shadow lifting. RGB is an approximate appearance seed, not calibrated reflectance. Modern features may remain.',
        cleanupComponents=cleaned_components,cleanupPixels=int(np.sum(cleanup>0)),
        albedoSHA256=hashlib.sha256((OUT/'albedo.png').read_bytes()).hexdigest()),
    vegetation=dict(maskSize=MASK_SIZE,format='uint8 vegetation probability, rows north to south',
        sha256=hashlib.sha256(mask_bytes).hexdigest(),
        provenance='Authored RGB greenness interpretation, constrained by elevation and slope; not a surveyed forest/species map.',
        seed=47231,candidateCount=vegetation_counts['candidates'],instanceCount=vegetation_counts['instances'],variantLibrary='Native seeded recursive branches, foliage clusters and projected-error LOD; no Three.js runtime.'),
    playableScope='Single continuous island region; no whole-world generation or voyage compression.',
    limitations='16 m elevation-derived coast and visual CRS/datum alignment; authored vegetation and historical cleanup; approximate de-lighting; underwater skirt is not surveyed bathymetry.'))
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Prepared registered colour/vegetation seed'+(' only; terrain unchanged.' if IMAGERY_ONLY else ' and local LiDAR relief.')+' No runtime map service.')
