#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""A crew body's albedo for the people continuum, called by scripts/prepare-crew-continuum.mjs.

    python3 scripts/crew-continuum-texture.py IMAGE MASK OUTDIR [--size 4096] [--sample 2048]

IMAGE is the fit's embedded picture and MASK the texels its UV triangles cover (one byte each, SIZE x SIZE,
rasterised by the bake). What lies outside the islands is filled from the islands' own edges, coarse to fine
(push-pull), so no level of the chain reads the picture's background where an island ends. Levels are plain
averages in linear light, then each is written in BC7 and in ASTC 4x4 (sRGB), whole chains, level after level.

Writes OUTDIR/albedo.bc7.bin, OUTDIR/albedo.astc.bin, OUTDIR/sample.rgb (the filled picture at SAMPLE, sRGB
bytes, for the bake's far-body colours) and OUTDIR/levels.json.
"""
import argparse
import concurrent.futures
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile

import numpy as np
from PIL import Image

from forest_bc7 import encode_bc7_blocks

BLOCK_BYTES = 16
ASTC_HEADER_BYTES = 16


def linear_from_srgb(c):
    return np.where(c <= .04045, c / 12.92, np.power((c + .055) / 1.055, 2.4))


def srgb_from_linear(c):
    return np.where(c <= .0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 1e-12), 1 / 2.4) - .055)


def box_down(image):
    h, w = image.shape[:2]
    if h == 1 and w == 1:
        return image
    if h % 2 or w % 2:
        raise SystemExit('Texture sides must be powers of two')
    return image.reshape(h // 2, 2, w // 2, 2, -1).mean(axis=(1, 3)).astype(np.float32)


def fill_outside(rgb, covered):
    """Push-pull: every texel outside the islands takes the average of the nearest coverage, coarse to fine."""
    pyramid = []
    colour, weight = rgb * covered[..., None], covered.astype(np.float32)
    while colour.shape[0] > 1:
        pyramid.append((colour, weight))
        h, w = weight.shape
        colour = colour.reshape(h // 2, 2, w // 2, 2, 3).sum(axis=(1, 3))
        weight = weight.reshape(h // 2, 2, w // 2, 2).sum(axis=(1, 3))
    filled = colour / np.maximum(weight, 1e-6)[..., None]
    for colour, weight in reversed(pyramid):
        up = np.repeat(np.repeat(filled, 2, axis=0), 2, axis=1)
        own = colour / np.maximum(weight, 1e-6)[..., None]
        share = np.clip(weight, 0, 1)[..., None]
        filled = (own * share + up * (1 - share)).astype(np.float32)
    return filled


def encode_srgb(linear):
    rgb = np.round(np.clip(srgb_from_linear(linear), 0, 1) * 255).astype(np.uint8)
    return np.dstack((rgb, np.full(rgb.shape[:2], 255, np.uint8)))


def pad_to_blocks(image):
    h, w = image.shape[:2]
    return np.pad(image, ((0, -h % 4), (0, -w % 4), (0, 0)), mode='edge')


def bc7_strip(pixels):
    return encode_bc7_blocks(np.ascontiguousarray(pixels))


def encode_bc7(pool, pixels):
    """Rows of blocks in parallel strips; BC7 blocks are stored row by row, so the strips join end to end."""
    rows = pixels.shape[0] // 4
    step = max(1, math.ceil(rows / (os.cpu_count() or 4)))
    strips = [pixels[r * 4:min(rows, r + step) * 4] for r in range(0, rows, step)]
    return b''.join(pool.map(bc7_strip, strips))


def encode_astc(folder, level, pixels):
    png, out = Path(folder) / f'level-{level}.png', Path(folder) / f'level-{level}.astc'
    # sips stores rows bottom to top, so it is given the picture upside down.
    Image.fromarray(pixels[::-1]).save(png)
    subprocess.run(['sips', '-s', 'format', 'astc', str(png), '--out', str(out)], check=True, capture_output=True)
    raw = out.read_bytes()
    if raw[4:7] != bytes([4, 4, 1]):
        raise SystemExit('sips did not write 4x4 ASTC blocks')
    return raw[ASTC_HEADER_BYTES:]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('image', type=Path)
    parser.add_argument('mask', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--size', type=int, default=4096)
    parser.add_argument('--sample', type=int, default=2048)
    parser.add_argument('--sample-only', action='store_true')
    args = parser.parse_args()
    if args.size & (args.size - 1) or args.sample & (args.sample - 1) or args.sample > args.size:
        raise SystemExit('Sizes must be powers of two, the sample no larger than the texture')

    source = Image.open(args.image).convert('RGB')
    linear = linear_from_srgb(np.asarray(source, dtype=np.float32) / 255).astype(np.float32)
    while linear.shape[0] > args.size and linear.shape[0] % 2 == 0 and linear.shape[1] % 2 == 0:
        linear = box_down(linear)
    if linear.shape[:2] != (args.size, args.size):
        resized = source.resize((args.size, args.size), Image.LANCZOS)
        linear = linear_from_srgb(np.asarray(resized, dtype=np.float32) / 255).astype(np.float32)
    covered = np.fromfile(args.mask, dtype=np.uint8).reshape(args.size, args.size) > 0
    filled = fill_outside(linear, covered)

    chain = [filled]
    while chain[-1].shape[0] > 1:
        chain.append(box_down(chain[-1]))
    args.out.mkdir(parents=True, exist_ok=True)
    if args.sample_only:
        for image in chain:
            if image.shape[0] == args.sample:
                np.round(np.clip(srgb_from_linear(image), 0, 1) * 255).astype(np.uint8).tofile(args.out / 'sample.rgb')
        return
    levels = []
    bc7, astc = bytearray(), bytearray()
    with tempfile.TemporaryDirectory() as folder, concurrent.futures.ProcessPoolExecutor() as pool:
        for level, image in enumerate(chain):
            pixels = pad_to_blocks(encode_srgb(image))
            expected = (pixels.shape[0] // 4) * (pixels.shape[1] // 4) * BLOCK_BYTES
            a, b = encode_bc7(pool, pixels), encode_astc(folder, level, pixels)
            if len(a) != expected or len(b) != expected:
                raise SystemExit(f'Level {level}: {len(a)} BC7 and {len(b)} ASTC bytes, expected {expected}')
            levels.append({'width': image.shape[1], 'height': image.shape[0], 'offset': len(bc7), 'bytes': expected})
            bc7 += a
            astc += b
            if image.shape[0] == args.sample:
                np.round(np.clip(srgb_from_linear(image), 0, 1) * 255).astype(np.uint8).tofile(args.out / 'sample.rgb')
    (args.out / 'albedo.bc7.bin').write_bytes(bytes(bc7))
    (args.out / 'albedo.astc.bin').write_bytes(bytes(astc))
    coverage = float(covered.mean())
    (args.out / 'levels.json').write_text(json.dumps({'width': args.size, 'height': args.size, 'coverage': round(coverage, 4), 'levels': levels}))
    print(f'albedo {args.size}: {len(levels)} levels, {len(bc7) / 1048576:.1f} MiB a codec, islands cover {coverage * 100:.0f}%')


if __name__ == '__main__':
    main()
