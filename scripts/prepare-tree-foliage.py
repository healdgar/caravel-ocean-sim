#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Reproduce the original alpha-cutout twig spray; no downloaded artwork.

Requires Pillow and NumPy. UV origin is the stem, so the PNG grows downwards.
Transparent texels retain green RGB to prevent dark fringes in GPU mipmaps.
"""
from pathlib import Path
import math
import random
import numpy as np
from PIL import Image, ImageDraw

SIZE = 2048
rng = random.Random(1492)
image = Image.new('RGBA', (SIZE, SIZE), (68, 104, 40, 0))
draw = ImageDraw.Draw(image)


def stem(t):
    return np.array([.51 + .025 * math.sin(t * 4), .025 + t * .87]) * SIZE


def leaf(origin, angle, length, width, seed):
    local = random.Random(seed)
    axis = np.array([math.cos(angle), math.sin(angle)])
    side = np.array([-axis[1], axis[0]])
    curl = local.uniform(-.08, .08) * length
    points = []
    for edge in [-1, 1]:
        for t in np.linspace(0, 1, 45)[::edge]:
            center = origin + axis * length * t + side * curl * math.sin(t * math.pi)
            half = width * math.sin(t * math.pi) ** .72 * (1 + .05 * math.sin(t * 41 + seed))
            points.append(tuple(center + side * edge * half))
    bounds = np.array(points)
    x0, y0 = np.maximum(0, np.floor(bounds.min(axis=0)).astype(int) - 2)
    x1, y1 = np.minimum(SIZE, np.ceil(bounds.max(axis=0)).astype(int) + 3)
    if x1 <= x0 or y1 <= y0:
        return
    mask = Image.new('L', (x1 - x0, y1 - y0))
    ImageDraw.Draw(mask).polygon([(x - x0, y - y0) for x, y in points], fill=255)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    delta = np.stack([xx - origin[0], yy - origin[1]], axis=-1)
    along = np.clip(delta @ axis / length, 0, 1)
    across = delta @ side - curl * np.sin(along * np.pi)
    fold = np.clip(across / width, -1, 1)
    tone = .92 + .11 * fold + .10 * np.sin(along * np.pi) - .10 * along
    grain = np.sin(xx * .91 + yy * 1.23) * np.sin(xx * .27 - yy * .73) * 2
    color = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.uint8)
    base = np.array([66 + local.randrange(-7, 9), 100 + local.randrange(-8, 13), 37 + local.randrange(-5, 9)])
    color[:, :, :3] = np.clip(tone[:, :, None] * base + grain[:, :, None], 0, 255)
    color[:, :, 3] = 255
    patch = Image.fromarray(color, 'RGBA')
    vein = ImageDraw.Draw(patch)
    centerline = [origin + axis * length * t + side * curl * math.sin(t * math.pi) for t in np.linspace(0, .96, 20)]
    vein.line([(p[0] - x0, p[1] - y0) for p in centerline], fill=(101, 130, 58, 255), width=2)
    for t in np.linspace(.18, .8, 7):
        mid = origin + axis * length * t + side * curl * math.sin(t * math.pi)
        for sign in [-1, 1]:
            end = mid + axis * length * .09 + side * sign * width * math.sin(t * math.pi) * .78
            vein.line([(mid[0] - x0, mid[1] - y0), (end[0] - x0, end[1] - y0)], fill=(77, 110, 43, 255), width=1)
    image.paste(patch, (int(x0), int(y0)), mask)


# An asymmetrical twig with staggered, petiolate leaf pairs and a terminal leaf.
# Each card represents many small leaves, rather than a solid canopy plate.
for row in range(7):
    t = .11 + row * .115
    for sign in [-1, 1]:
        u = t + (0 if sign < 0 else .037)
        origin = stem(u)
        reach = (.365 - u * .17) * SIZE * rng.uniform(.91, 1.10)
        angle = math.pi / 2 - sign * rng.uniform(.78, 1.05)
        axis = np.array([math.cos(angle), math.sin(angle)])
        petiole = .028 * SIZE
        endpoint = origin + axis * petiole
        draw.line([tuple(origin), tuple(endpoint)], fill=(102, 112, 57, 255), width=5)
        leaf(endpoint, angle, reach, reach * rng.uniform(.25, .34), row * 9 + sign + 71)
leaf(stem(.83), math.pi / 2 + .12, .13 * SIZE, .042 * SIZE, 913)
draw.line([tuple(stem(t)) for t in np.linspace(0, .89, 80)], fill=(108, 111, 62, 255), width=7)

image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
pixels = np.array(image)
pixels[pixels[:, :, 3] == 0, :3] = [68, 104, 40]
target = Path(__file__).resolve().parents[1] / 'assets' / 'tree-foliage.png'
Image.fromarray(pixels, 'RGBA').save(target, optimize=True)
print(f'{target.name}: original 1024 x 1024 RGBA twig spray, {target.stat().st_size} bytes')
