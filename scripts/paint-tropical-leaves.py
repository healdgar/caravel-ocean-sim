#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
# Leaf textures for the tropical trees. Each blade runs along u with a pale midrib along v = 0.5 and
# faint veins. Colour bleeds past the blade so mips stay clean.
import math
import random
import sys
from PIL import Image

SIZE = 256
# Tones of each species' three leaf materials, and the shape of its blade.
SPECIES = {
    "royal-palm": ("leaflet", [(30, 76, 28), (24, 64, 26), (42, 86, 30)]),
    "palm": ("leaflet", [(40, 82, 30), (32, 72, 28), (58, 92, 32)]),
    "ceiba": ("lance", [(36, 86, 30), (28, 74, 28), (52, 98, 34)]),
    "mangrove": ("oval", [(20, 58, 24), (16, 50, 24), (30, 68, 26)]),
}


def half_width(shape, u):
    if shape == "leaflet":
        # Narrow, widest near the base, running to a point.
        if u < 0.1:
            return 0.32 + 0.68 * (u / 0.1) ** 0.6
        return (1 - ((u - 0.1) / 0.9) ** 2.2) ** 0.8
    if shape == "lance":
        # Pointed at both ends, widest a little past the middle.
        return math.sin(math.pi * u ** 0.85) ** 0.9
    # Oval and blunt, as a mangrove's thick leaf is.
    return (1 - abs(2 * u - 1) ** 2.6) ** 0.55


def paint(shape, tone, seed):
    rng = random.Random(seed)
    veins = [rng.uniform(-0.05, 0.05) for _ in range(SIZE)]
    image = Image.new("RGBA", (SIZE, SIZE))
    pixels = image.load()
    for y in range(SIZE):
        v = (y + 0.5) / SIZE
        across = abs(v - 0.5) * 2
        vein = 1 + 0.07 * math.sin(across * 46) + veins[y]
        for x in range(SIZE):
            u = (x + 0.5) / SIZE
            inside = across <= half_width(shape, u) * 0.94
            rib = max(0, 1 - across / 0.09)
            light = (0.84 + 0.3 * u) * vein
            rgb = [min(255, int(c * light + (150 - c) * 0.42 * rib)) for c in tone]
            pixels[x, y] = (*rgb, 255 if inside else 0)
    return image


for stem, (shape, tones) in SPECIES.items():
    for index, tone in enumerate(tones):
        paint(shape, tone, index * 17 + len(stem)).save(f"{sys.argv[1]}/{stem}-foliage-{index}-albedo.png", optimize=True)
