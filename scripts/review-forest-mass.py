#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Finite native/MASK-vs-leaf-field rendered witnesses, never a global proof."""
import argparse
import json
from pathlib import Path
import numpy as np
from scipy.ndimage import distance_transform_edt
from PIL import Image, ImageDraw


def read(folder, descriptor):
    w, h = descriptor['atlasPixels']
    return np.frombuffer((folder/descriptor['outputs']['albedo']['file']).read_bytes(), '<f2').reshape(h, w, 4).astype(np.float32)


def average(image, scale):
    h, w = image.shape[:2]
    return image.reshape(h//scale, scale, w//scale, scale, 4).mean(axis=(1, 3))


def metric(a, b):
    am, bm = a[..., 3] > 0, b[..., 3] > 0
    da, db = distance_transform_edt(~am), distance_transform_edt(~bm)
    return {'nativeToMassPixels': float(db[am].max(initial=0)), 'massToNativePixels': float(da[bm].max(initial=0)),
            'relativeCoverageError': float((b[..., 3].sum()-a[..., 3].sum())/max(a[..., 3].sum(), 1e-8)),
            'premultipliedPigmentMeanAbsoluteError': np.abs(a[..., :3]-b[..., :3]).sum(axis=(0, 1)).tolist(),
            'nativeCoverageSum': float(a[..., 3].sum()), 'massCoverageSum': float(b[..., 3].sum())}


def review(folder):
    m = json.loads((folder/'manifest.json').read_text()); rows = []
    for native_key, mass_key in [('capture', 'mass'), ('validation', 'massValidation')]:
        if not m.get(native_key) or not m.get(mass_key): continue
        descriptor = m[native_key]; a, b = read(folder, descriptor), read(folder, m[mass_key]); tile = descriptor['tilePixels']
        for view in descriptor['views']:
            x, y = view['column']*tile, view['row']*tile
            av, bv = a[y:y+tile, x:x+tile], b[y:y+tile, x:x+tile]
            for scale in (1, 2, 4):
                measured = metric(average(av, scale), average(bv, scale)); metres_per_pixel = view['finalWorldMetresPerPixel']*scale
                measured.update(group=native_key, view=view['index'], azimuth=view['azimuthDegrees'], elevation=view['elevationDegrees'], pixels=tile//scale,
                                worldMetresPerPixel=metres_per_pixel, samplingFootprintPixels=m['massSource']['source']['nativeFieldRecipe']['maximumSupportMetres']/metres_per_pixel)
                measured['passesThreePixelCoverageWitness'] = max(measured['nativeToMassPixels'], measured['massToNativePixels']) <= 3 and abs(measured['relativeCoverageError']) <= .2
                rows.append(measured)
        # Inspection images are unchanged renderer outputs side by side.
        an = Image.open(folder/descriptor['outputs']['png']['file']).convert('RGBA')
        bn = Image.open(folder/m[mass_key]['outputs']['png']['file']).convert('RGBA')
        for view in descriptor['views'][:4]:
            x, y = view['column']*tile, view['row']*tile; box = (x, y, x+tile, y+tile)
            na, nb = an.crop(box), bn.crop(box); bounds = Image.fromarray(np.maximum(np.array(na)[..., 3], np.array(nb)[..., 3])).getbbox()
            if not bounds: continue
            x0, y0, x1, y1 = bounds; bounds = (max(0, x0-8), max(0, y0-8), min(tile, x1+8), min(tile, y1+8))
            na, nb = na.crop(bounds), nb.crop(bounds); image = Image.new('RGB', (na.width*2, na.height+24), '#20333a')
            image.paste(na, (0, 24), na); image.paste(nb, (na.width, 24), nb); draw = ImageDraw.Draw(image)
            draw.text((4, 5), 'Detailed native / MASK', fill='white'); draw.text((na.width+4, 5), 'Original leaf-area field', fill='white')
            image.save(folder/(native_key+'-comparison-'+str(view['index'])+'.png'))
    result = {'format': 'waterworld.native-forest-mass-witnesses', 'version': 1, 'qualification': 'Finite original-native rendered views, not a global geometry/appearance certificate',
              'silhouettePixels': 3, 'relativeCoverageTolerance': .2, 'rows': rows,
              'source': m['massSource'], 'runtimeFootprintScope': 'Only the authored source-field sampling footprint is projected by the runtime. These views independently test appearance.'}
    (folder/'mass-review.json').write_text(json.dumps(result, indent=2)+'\n')
    for pixels in (512, 256, 128):
        selected = [r for r in rows if r['pixels'] == pixels]
        if selected: print(json.dumps({'pixels': pixels, 'views': len(selected), 'pass': sum(r['passesThreePixelCoverageWitness'] for r in selected),
                                     'maxDisplacement': max(max(r['nativeToMassPixels'], r['massToNativePixels']) for r in selected),
                                     'maxCoverageError': max(abs(r['relativeCoverageError']) for r in selected)}))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('folder', type=Path); review(p.parse_args().folder)
