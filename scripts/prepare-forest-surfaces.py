#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Bakes a forest pack's native surfaces into block-compressed texture arrays for js/forest-surfaces.js.

    python3 scripts/prepare-forest-surfaces.py saba --bc7enc PATH --astcenc PATH

Two prebuilt sets, BC7 and ASTC 4x4, each a complete mip chain. They hold what the GPU path in
js/forest-scenery.js computes: linear pigment times coverage, and normal and roughness times coverage.
Levels are then sharpened, because the game mostly reads levels 2 and coarser: a plain average is what
makes bark soft at 10 m, not a lack of base texels. Each level's mean coverage still equals the plain
average, so leaves keep their area, and the coarsest leaf levels stay plain so the far canopy is unchanged.

Encoders are build tools and are not kept in this repository:
    bc7enc   github.com/richgel999/bc7enc_rdo (clang++ -O3 -std=c++14 -DSUPPORT_BC7E=0 -o bc7enc test.cpp
             bc7enc.cpp bc7decomp.cpp bc7decomp_ref.cpp lodepng.cpp rgbcx.cpp utils.cpp ert.cpp rdo_bc_encoder.cpp)
    astcenc  github.com/ARM-software/astc-encoder (cmake -DASTCENC_ISA_NEON=ON, gives astcenc-neon)

Without them, on a Mac:
    python3 scripts/prepare-forest-surfaces.py portugal --builtin --reuse saba
--builtin encodes ASTC with the system's sips and BC7 with scripts/forest_bc7.py, which is plainer than
bc7enc. --reuse copies the blocks another pack already holds for any surface baked from the same maps
in the same way, so only what is new to this pack goes through the plainer encoder.

Materials that share their maps and are baked alike share one layer, listed under its `shares`.
"""
import argparse
import concurrent.futures
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile

import numpy as np
from PIL import Image

from forest_bc7 import encode_bc7_blocks

ROOT = Path(__file__).resolve().parent.parent
BLOCK_BYTES = 16
DDS_HEADER_BYTES = 148
ASTC_HEADER_BYTES = 16
# Base levels are only sampled within about two metres, so they take the rate-distortion pass.
BASE_LEVEL_LAMBDA = 0.5
# Sharpening stops here for leaves, so a canopy seen from afar reads exactly the plain average.
LEAF_SHARPEN_LAST_LEVEL = 4


def linear_from_srgb(c):
    return np.where(c <= .04045, c / 12.92, np.power((c + .055) / 1.055, 2.4))


def srgb_from_linear(c):
    return np.where(c <= .0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 1e-12), 1 / 2.4) - .055)


def read_png(path):
    return np.asarray(Image.open(path).convert('RGBA'), dtype=np.float64) / 255


def surface_base(folder, material):
    """Level zero as js/forest-scenery.js forestSurfaceInit computes it."""
    albedo = read_png(folder / material['albedo']['file'])
    normal_rgba = read_png(folder / material['normal']['file'])
    tangent = normal_rgba[..., :3] * 2 - 1
    tangent /= np.maximum(np.linalg.norm(tangent, axis=-1, keepdims=True), 1e-12)
    if material.get('roughnessMap'):
        roughness = read_png(folder / material['roughnessMap']['file'])[..., 0]
    else:
        roughness = np.where(normal_rgba[..., 3] < 0.995, normal_rgba[..., 3], float(material['roughness']))
    coverage = albedo[..., 3]
    pigment = np.dstack((linear_from_srgb(albedo[..., :3]) * coverage[..., None], coverage))
    detail = np.dstack((tangent * coverage[..., None], roughness * coverage))
    return pigment, detail


def box_down(image):
    height, width = image.shape[:2]
    next_height, next_width = max(1, height >> 1), max(1, width >> 1)
    y = np.minimum(np.arange(next_height * 2), height - 1)
    x = np.minimum(np.arange(next_width * 2), width - 1)
    grid = image[np.ix_(y, x)]
    return grid.reshape(next_height, 2, next_width, 2, image.shape[2]).mean(axis=(1, 3))


def blur(image, repeat):
    """[1 2 1]/4 in each direction, wrapping only for surfaces that tile."""
    mode = 'wrap' if repeat else 'edge'
    pad = np.pad(image, ((1, 1), (1, 1), (0, 0)), mode=mode)
    across = (pad[:, :-2] + 2 * pad[:, 1:-1] + pad[:, 2:]) * .25
    return (across[:-2] + 2 * across[1:-1] + across[2:]) * .25


def sharpen_level(pigment, detail, amount, repeat):
    """Restores contrast that a plain average loses. The filter's gain is one, so no area is added."""
    target = pigment[..., 3].mean()
    def sharp(image):
        return image + amount * (image - blur(image, repeat))
    sharp_pigment, sharp_detail = sharp(pigment), sharp(detail)
    coverage = np.clip(sharp_pigment[..., 3], 0, 1)
    # Clipping overshoot moves the mean a little, so restore it. Coverage must stay exact.
    low, high = 0.5, 2.0
    for _ in range(40):
        gain = (low + high) / 2
        if np.clip(coverage * gain, 0, 1).mean() < target:
            low = gain
        else:
            high = gain
    corrected = np.clip(coverage * ((low + high) / 2), 0, 1)
    scale = np.where(sharp_pigment[..., 3] > 1e-6, corrected / np.maximum(sharp_pigment[..., 3], 1e-6), 0)[..., None]
    out_pigment = np.dstack((np.maximum(sharp_pigment[..., :3], 0) * scale, corrected))
    out_detail = sharp_detail * scale
    # A sharpened value can leave the range the formats can hold once its coverage has changed.
    out_detail[..., :3] = np.clip(out_detail[..., :3], -1, 1)
    out_detail[..., 3] = np.clip(out_detail[..., 3], 0, corrected)
    out_pigment[..., :3] = np.minimum(out_pigment[..., :3], corrected[..., None])
    return out_pigment, out_detail


def surface_chain(folder, material, sharpen):
    base_pigment, base_detail = surface_base(folder, material)
    repeat = material.get('wrap') == 'repeat'
    leaf = material['name'].startswith('foliage')
    levels = 1 + int(math.log2(max(base_pigment.shape[:2])))
    plain = [(base_pigment, base_detail)]
    for _ in range(1, levels):
        plain.append((box_down(plain[-1][0]), box_down(plain[-1][1])))
    chain = []
    for level, (pigment, detail) in enumerate(plain):
        use = sharpen > 0 and level > 0 and min(pigment.shape[:2]) >= 4 and (not leaf or level <= LEAF_SHARPEN_LAST_LEVEL)
        chain.append(sharpen_level(pigment, detail, sharpen, repeat) if use else (pigment, detail))
    return chain, plain


def encode_pigment(pigment):
    rgb = np.round(np.clip(srgb_from_linear(pigment[..., :3]), 0, 1) * 255)
    alpha = np.round(np.clip(pigment[..., 3], 0, 1) * 255)
    return np.dstack((rgb, alpha)).astype(np.uint8)


def encode_detail(detail):
    # Signed values in an unsigned format, with zero exactly representable. Decoded by forestDetailSigned.
    xyz = np.round(np.clip(detail[..., :3], -1, 1) * 127 + 128)
    return np.dstack((xyz, np.round(np.clip(detail[..., 3], 0, 1) * 255))).astype(np.uint8)


def pad_to_blocks(image):
    height, width = image.shape[:2]
    return np.pad(image, ((0, -height % 4), (0, -width % 4), (0, 0)), mode='edge')


def block_count(width, height):
    return math.ceil(width / 4) * math.ceil(height / 4)


def encode_bc7(tool, png, level):
    out = png.with_suffix('.dds')
    rate = ['-z%g' % BASE_LEVEL_LAMBDA, '-zn'] if level == 0 else []
    subprocess.run([tool, '-q', '-g', '-C', '-u4', *rate, str(png), str(out)], check=True, capture_output=True, cwd=png.parent)
    return out.read_bytes()[DDS_HEADER_BYTES:]


def encode_astc(tool, png, srgb):
    out = png.with_suffix('.astc')
    subprocess.run([tool, '-cs' if srgb else '-cl', str(png), str(out), '4x4', '-thorough', '-silent', '-j', '1'], check=True, capture_output=True)
    return out.read_bytes()[ASTC_HEADER_BYTES:]


def encode_bc7_builtin(pixels):
    return encode_bc7_blocks(pixels)


def encode_astc_sips(png, pixels):
    # sips stores rows bottom to top, so it is given the picture upside down.
    Image.fromarray(pixels[::-1]).save(png)
    out = png.with_suffix('.astc')
    subprocess.run(['sips', '-s', 'format', 'astc', str(png), '--out', str(out)], check=True, capture_output=True)
    raw = out.read_bytes()
    if raw[4:7] != bytes([4, 4, 1]):
        raise SystemExit('sips did not write 4x4 ASTC blocks')
    return raw[ASTC_HEADER_BYTES:]


def bake_key(material):
    """Everything about a material that decides its baked blocks."""
    return (tuple(material[kind]['sha256'] if material.get(kind) else None for kind in ('albedo', 'normal', 'roughnessMap')),
            material.get('wrap') == 'repeat', material['name'].startswith('foliage'),
            None if material.get('roughnessMap') else round(float(material['roughness']), 6))


def reusable_blocks(pack, sharpen):
    """Blocks another pack has already baked, by bake key, codec, kind and level."""
    folder = ROOT / 'assets/forest-scenery' / pack
    forest = json.loads((folder / 'manifest.json').read_text())
    materials = [material for prototype in forest['prototypes'] for material in prototype['nativeMaterials']]
    manifest = json.loads((folder / 'surfaces/manifest.json').read_text())
    if manifest.get('sharpen') != sharpen:
        return {}
    found = {}
    for family in manifest['families']:
        count = len(family['layers'])
        for codec in family['files']:
            for kind in ('albedo', 'detail'):
                raw = gzip.decompress((folder / 'surfaces' / family['files'][codec][kind]['gzip']['file']).read_bytes())
                offset = 0
                for level in range(family['levels']):
                    size = block_count(max(1, family['width'] >> level), max(1, family['height'] >> level)) * BLOCK_BYTES
                    for row, layer in enumerate(family['layers']):
                        found[(bake_key(materials[layer['material']]), codec, kind, level)] = raw[offset + row * size:offset + (row + 1) * size]
                    offset += size * count
    return found


def receipt(raw):
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('pack', choices=['saba', 'subtropical', 'portugal'])
    parser.add_argument('--builtin', action='store_true', help='Encode with sips and scripts/forest_bc7.py in place of astcenc and bc7enc')
    parser.add_argument('--reuse', help='A pack whose baked blocks are copied for surfaces baked from the same maps')
    parser.add_argument('--bc7enc', default=os.environ.get('FOREST_BC7ENC', 'bc7enc'))
    parser.add_argument('--astcenc', default=os.environ.get('FOREST_ASTCENC', 'astcenc-neon'))
    parser.add_argument('--sharpen', type=float, default=1., help='Contrast restored to each level; 0 is the plain average')
    parser.add_argument('--output', type=Path, help='Defaults to the pack\'s surfaces folder')
    args = parser.parse_args()

    folder = ROOT / 'assets/forest-scenery' / args.pack
    out_dir = args.output or folder / 'surfaces'
    out_dir.mkdir(parents=True, exist_ok=True)
    forest = json.loads((folder / 'manifest.json').read_text())
    materials = [material for prototype in forest['prototypes'] for material in prototype['nativeMaterials']]

    reuse = reusable_blocks(args.reuse, args.sharpen) if args.reuse else {}
    families = []
    first_with = {}
    shares = {}
    for index, material in enumerate(materials):
        key = bake_key(material)
        if key in first_with:
            shares[first_with[key]].append(index)
            continue
        first_with[key] = index
        shares[index] = []
        width, height = Image.open(folder / material['albedo']['file']).size
        family = next((f for f in families if f['width'] == width and f['height'] == height), None)
        if family is None:
            family = {'width': width, 'height': height, 'levels': 1 + int(math.log2(max(width, height))), 'layers': []}
            families.append(family)
        family['layers'].append(index)
    if len(families) > 4:
        raise SystemExit('The renderer binds at most four texture families')

    manifest = {'format': 'waterworld.forest-surfaces', 'version': 1, 'materialContract': forest['materialContract'],
                'sharpen': args.sharpen, **({'encoder': 'builtin'} if args.builtin else {}), **({'reuses': args.reuse} if reuse else {}), 'families': []}
    reused = encoded = 0
    with tempfile.TemporaryDirectory() as temporary, concurrent.futures.ThreadPoolExecutor(os.cpu_count()) as pool:
        for family_index, family in enumerate(families):
            jobs = {}
            layers = []
            for layer, material_index in enumerate(family['layers']):
                material = materials[material_index]
                chain, plain = surface_chain(folder, material, args.sharpen)
                if len(chain) != family['levels']:
                    raise SystemExit('Mip count mismatch: ' + material['albedo']['file'])
                key = bake_key(material)
                layers.append({'material': material_index, **({'shares': shares[material_index]} if shares[material_index] else {}), 'name': material['name'],
                               'sources': {kind: material[kind]['sha256'] for kind in ('albedo', 'normal', 'roughnessMap') if material.get(kind)},
                               'coverage': [round(float(level[0][..., 3].mean()), 6) for level in plain],
                               'terminal': [round(float(v), 6) for v in plain[-1][0][0, 0]]})
                for level, (pigment, detail) in enumerate(chain):
                    for kind, pixels in (('albedo', encode_pigment(pigment)), ('detail', encode_detail(detail))):
                        if all((key, codec, kind, level) in reuse for codec in ('bc7', 'astc')):
                            for codec in ('bc7', 'astc'):
                                jobs[(codec, kind, level, layer)] = pool.submit(lambda blocks: blocks, reuse[(key, codec, kind, level)])
                            reused += 1
                            continue
                        png = Path(temporary) / f'{family_index}-{layer}-{level}-{kind}.png'
                        padded = pad_to_blocks(pixels)
                        if args.builtin:
                            jobs[('bc7', kind, level, layer)] = pool.submit(encode_bc7_builtin, padded)
                            jobs[('astc', kind, level, layer)] = pool.submit(encode_astc_sips, png, padded)
                            encoded += 1
                            continue
                        Image.fromarray(padded).save(png)
                        jobs[('bc7', kind, level, layer)] = pool.submit(encode_bc7, args.bc7enc, png, level)
                        jobs[('astc', kind, level, layer)] = pool.submit(encode_astc, args.astcenc, png, kind == 'albedo')
                        encoded += 1
            files = {}
            for codec in ('bc7', 'astc'):
                files[codec] = {}
                for kind in ('albedo', 'detail'):
                    payload = bytearray()
                    for level in range(family['levels']):
                        expected = block_count(max(1, family['width'] >> level), max(1, family['height'] >> level)) * BLOCK_BYTES
                        for layer in range(len(family['layers'])):
                            blocks = jobs[(codec, kind, level, layer)].result()
                            if len(blocks) != expected:
                                raise SystemExit(f'{codec} {kind} level {level} has {len(blocks)} bytes, expected {expected}')
                            payload += blocks
                    raw = bytes(payload)
                    packed = gzip.compress(raw, 9, mtime=0)
                    name = f'family-{family_index}-{kind}.{codec}.bin.gz'
                    (out_dir / name).write_bytes(packed)
                    files[codec][kind] = {**receipt(raw), 'gzip': {'file': name, **receipt(packed)}}
                    print(f'{name}: {len(raw) / 1048576:.2f} MiB in memory, {len(packed) / 1048576:.2f} MiB to download', flush=True)
            manifest['families'].append({'width': family['width'], 'height': family['height'], 'levels': family['levels'], 'layers': layers, 'files': files})
    (out_dir / 'manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')
    print(f'{reused} levels copied from {args.reuse}, {encoded} encoded' if args.reuse else f'{encoded} levels encoded')
    for codec in ('bc7', 'astc'):
        gpu = sum(f['files'][codec][k]['bytes'] for f in manifest['families'] for k in ('albedo', 'detail'))
        wire = sum(f['files'][codec][k]['gzip']['bytes'] for f in manifest['families'] for k in ('albedo', 'detail'))
        print(f'{args.pack} {codec}: {gpu / 1048576:.1f} MiB in GPU memory, {wire / 1048576:.1f} MiB to download')


if __name__ == '__main__':
    main()
