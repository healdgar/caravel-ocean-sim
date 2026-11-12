#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Draws the Portugal pack's leaf pictures as sprays: a twig and the leaves along it, in place of one leaf.

    python3 scripts/prepare-forest-sprays.py [--preview FOLDER]

A full-grown tree carries its foliage on cards most of a metre long (scripts/bake-forest-mature-pack.py).
One leaf drawn that large makes an oak of 25 m read as a seedling a few leaves tall. A spray on the same
card shows leaves a third as long, which is near what such a tree bears, and the crown keeps its cover.

The single leaves are saba's (assets/forest-scenery/saba/leaf-<species>-<n>-{albedo,normal}.png), the same
pictures the Portugal pack held before. Each spray is drawn on a card SPRAY_ASPECT times as long as it is
broad, the shape the bake gives the cards of these species, with the twig's foot at the middle of the
card's near edge, where the card meets its limb. The pictures are written over the pack's
<species>-veteran-foliage-<n>-{albedo,normal}.png and their receipts in the pack's manifest are renewed.
Blueberry keeps its single leaf: its cards are the size of the leaf itself.

After this, bake the surfaces and then the sets that read the pictures:

    python3 scripts/prepare-forest-surfaces.py portugal --builtin --reuse saba
    node scripts/prepare-forest-clusters.mjs portugal
    node scripts/prepare-forest-crowns.mjs portugal
    node scripts/prepare-forest-groves.mjs portugal
"""
import argparse
import hashlib
import json
import math
import pathlib
import random

import numpy as np
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/forest-scenery/saba'
PACK = ROOT / 'assets/forest-scenery/portugal'
# A spray's card is this many times as long as it is broad. scripts/bake-forest-mature-pack.py shapes the cards to it.
SPRAY_ASPECT = 1.25
SIZE = 256
# The spray is drawn at this many pixels to the card's breadth and then reduced.
DRAWN = 1024
# species: a leaf's length over its breadth; its length as a share of the card's breadth; the angle it
# stands off its twig, in degrees; how far apart leaves are set along a twig, in leaf lengths; whether
# leaves stand in pairs; the side twigs a spray of small leaves needs to fill its card, each as how far
# along the main twig it leaves, the angle it leaves at and its length; the twig's colour.
SPECIES = {
    'oak': dict(aspect=1.5, length=0.42, angle=50, step=0.27, paired=False, forks=((0.1, 32, 0.52), (0.4, 28, 0.38)), twig=(92, 78, 52)),
    'chestnut': dict(aspect=2.6, length=0.47, angle=52, step=0.22, paired=False, forks=((0.1, 30, 0.5),), twig=(96, 84, 50)),
    'maple': dict(aspect=1.1, length=0.41, angle=58, step=0.46, paired=True, forks=(), twig=(104, 72, 58)),
    'elm': dict(aspect=1.9, length=0.34, angle=56, step=0.3, paired=False, forks=((0.1, 34, 0.5), (0.36, 30, 0.4)), twig=(84, 72, 54)),
    'birch': dict(aspect=1.6, length=0.3, angle=50, step=0.34, paired=False, forks=((0.1, 36, 0.52), (0.38, 32, 0.4)), twig=(70, 52, 44)),
}


def planes(path):
    return np.asarray(Image.open(path).convert('RGBA'), dtype=np.float32) / 255.0


def placed(plane, coefficients, size):
    """One plane of a leaf picture, laid where the leaf stands on the drawing."""
    image = Image.fromarray(plane, mode='F')
    return np.asarray(image.transform(size, Image.AFFINE, coefficients, resample=Image.BICUBIC, fillcolor=0.0), dtype=np.float32)


def spray(species, variant):
    look = SPECIES[species]
    albedo = planes(SOURCE / f'leaf-{species}-{variant}-albedo.png')
    normal = planes(SOURCE / f'leaf-{species}-{variant}-normal.png')
    cover = albedo[..., 3]
    # What the normal picture holds where no leaf is: flat, and the fourth plane's own resting value.
    bare = np.median(normal[cover < 0.02], axis=0) if (cover < 0.02).any() else np.array([0.5, 0.5, 1.0, 0.5], np.float32)
    rng = random.Random(f'{species}-{variant}')
    width, height = round(DRAWN * SPRAY_ASPECT), DRAWN
    # The drawing, in lengths of the card's breadth: x runs 0..SPRAY_ASPECT along the card, y 0..1 across it.
    length = look['length']
    twigs, leaves = [], []

    def set_leaf(x, y, angle, long):
        """Sets a leaf at (x, y), as long as asked or as much shorter as keeps the whole of it on the card."""
        c, s = math.cos(angle), math.sin(angle)
        for share in (1.0, 0.92, 0.84, 0.76, 0.68):
            half = long * share / look['aspect'] / 2
            corners = [(x + c * a - s * b, y + s * a + c * b) for a in (0.0, long * share) for b in (-half, half)]
            if all(0.005 <= u <= SPRAY_ASPECT - 0.005 and 0.005 <= v <= 0.995 for u, v in corners):
                leaves.append((x, y, angle, long * share))
                return

    def shoot(x0, y0, heading, reach, first):
        """One twig from (x0, y0), its leaves to either side and one at its tip."""
        bend = rng.uniform(-0.04, 0.04)
        at = lambda t: (x0 + math.cos(heading) * t - math.sin(heading) * bend * math.sin(math.pi * t / reach),
                        y0 + math.sin(heading) * t + math.cos(heading) * bend * math.sin(math.pi * t / reach))
        twigs.append(([at(t) for t in np.linspace(0.0, reach, 24)], 0.014 if first else 0.009))
        t, side = length * rng.uniform(0.12, 0.24), rng.choice((-1, 1))
        while t < reach - length * 0.15:
            grown = (0.8 + 0.2 * t / reach) * rng.uniform(0.88, 1.06)
            for s in ((-1, 1) if look['paired'] else (side,)):
                set_leaf(*at(t), heading + s * math.radians(look['angle'] + rng.uniform(-9, 9)), length * grown)
            side = -side
            t += length * look['step'] * rng.uniform(0.85, 1.15)
        set_leaf(*at(reach), heading + math.radians(rng.uniform(-12, 12)), length * rng.uniform(0.96, 1.06))
        return at

    main_reach = SPRAY_ASPECT - length * rng.uniform(1.0, 1.06)
    main = shoot(0.0, 0.5 + rng.uniform(-0.02, 0.02), math.radians(rng.uniform(-2.5, 2.5)), main_reach, True)
    side = rng.choice((-1, 1))
    for along, angle, reach in look['forks']:
        shoot(*main(main_reach * along * rng.uniform(0.85, 1.15)), side * math.radians(angle + rng.uniform(-5, 5)), reach * rng.uniform(0.9, 1.05), False)
        side = -side
    # Leaves nearest the card's far edge are drawn last, over those behind them.
    leaves.sort(key=lambda leaf: leaf[0])

    colour = np.zeros((height, width, 3), np.float32)
    detail = np.zeros((height, width, 4), np.float32)
    alpha = np.zeros((height, width), np.float32)

    def over(layer_colour, layer_detail, layer_alpha):
        nonlocal colour, detail, alpha
        keep = 1.0 - layer_alpha
        colour = layer_colour + colour * keep[..., None]
        detail = layer_detail + detail * keep[..., None]
        alpha = layer_alpha + alpha * keep

    mask = Image.new('L', (width, height), 0)
    draw = ImageDraw.Draw(mask)
    for points, breadth in twigs:
        for k in range(len(points) - 1):
            draw.line([tuple(v * DRAWN for v in points[k]), tuple(v * DRAWN for v in points[k + 1])], fill=255, width=max(2, round(DRAWN * breadth * (1.0 - 0.5 * k / len(points)))))
    twig = np.asarray(mask, dtype=np.float32) / 255.0
    over(twig[..., None] * (np.array(look['twig'], np.float32) / 255.0), twig[..., None] * np.array([0.5, 0.5, 1.0, bare[3]], np.float32), twig)

    for x, y, angle, long in leaves:
        broad = long / look['aspect']
        c, s = math.cos(angle), math.sin(angle)
        x0, y0 = x * DRAWN, y * DRAWN
        # From a pixel of the drawing to the pixel of the leaf picture that lies there.
        along, across = SIZE / (long * DRAWN), SIZE / (broad * DRAWN)
        coefficients = (along * c, along * s, -along * (c * x0 + s * y0), -across * s, across * c, across * (s * x0 - c * y0) + SIZE / 2)
        a = np.clip(placed(np.ascontiguousarray(cover), coefficients, (width, height)), 0.0, 1.0)
        shade = rng.uniform(0.9, 1.08)
        layer_colour = np.stack([placed(np.ascontiguousarray(albedo[..., k] * cover), coefficients, (width, height)) for k in range(3)], axis=-1) * shade
        raw = [placed(np.ascontiguousarray(normal[..., k] * cover), coefficients, (width, height)) for k in range(4)]
        # The leaf's own slopes turn with it: its first two planes are a direction in the picture.
        nx, ny = raw[0] * 2.0 - a, raw[1] * 2.0 - a
        turned = [(c * nx - s * ny + a) / 2.0, (s * nx + c * ny + a) / 2.0, raw[2], raw[3]]
        over(np.clip(layer_colour, 0.0, None), np.stack(turned, axis=-1), a)

    def reduced(plane):
        return np.asarray(Image.fromarray(np.ascontiguousarray(plane), mode='F').resize((SIZE, SIZE), resample=Image.BOX), dtype=np.float32)

    alpha_small = np.clip(reduced(alpha), 0.0, 1.0)
    held = alpha_small > 1e-3
    safe = np.where(held, alpha_small, 1.0)
    colour_small = np.stack([reduced(colour[..., k]) for k in range(3)], axis=-1)
    detail_small = np.stack([reduced(detail[..., k]) for k in range(4)], axis=-1)
    # Where no leaf is, the picture holds the spray's own mean colour, so no edge is drawn dark or pale.
    mean = colour_small.sum(axis=(0, 1)) / max(alpha_small.sum(), 1e-6)
    albedo_out = np.where(held[..., None], colour_small / safe[..., None], mean)
    normal_out = np.where(held[..., None], detail_small / safe[..., None], bare)
    to_bytes = lambda planes_: np.clip(np.rint(planes_ * 255.0), 0, 255).astype(np.uint8)
    albedo_image = Image.fromarray(to_bytes(np.concatenate([albedo_out, alpha_small[..., None]], axis=-1)), 'RGBA')
    normal_image = Image.fromarray(to_bytes(normal_out), 'RGBA')
    return albedo_image, normal_image, float((alpha_small > 0.35).mean()), len(leaves)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--preview', type=pathlib.Path, help='Write the sprays here and leave the pack as it is')
    args = parser.parse_args()
    out = args.preview or PACK
    out.mkdir(parents=True, exist_ok=True)
    receipts = {}
    for species in SPECIES:
        for variant in range(3):
            albedo, normal, share, count = spray(species, variant)
            for kind, image in (('albedo', albedo), ('normal', normal)):
                name = f'{species}-veteran-foliage-{variant}-{kind}.png'
                image.save(out / name, optimize=True)
                raw = (out / name).read_bytes()
                receipts[name] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            print(f'{species} {variant}: {count} leaves, {share * 100:.0f}% of the card is leaf')
    if args.preview:
        return
    manifest_path = PACK / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    renewed = 0
    for prototype in manifest['prototypes']:
        for material in prototype['nativeMaterials']:
            for kind in ('albedo', 'normal'):
                receipt = material.get(kind)
                if receipt and receipt['file'] in receipts:
                    receipt.update(receipts[receipt['file']])
                    renewed += 1
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'{len(receipts)} pictures written, {renewed} receipts renewed in {manifest_path.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
