#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""What each point of a dressed crew body is: paint, shirt, trousers, skin or hair.

The game wears each region its own way (js/wgsl/crew-continuum.js): skin and paint as the picture
has them, shirt and trousers dyed the person's own colours, hair tinted theirs. A point given the
wrong region is a stain: a patch of chest dyed as hair, a jerkin worn as skin.

Regions grow over the body's welded surface from seeds: skin from the middle of the face and the
hands, shirt from the chest, back and sleeves, trousers from the hips and thighs, paint from shod soles, and
skin again wherever a forearm, shin, foot or neck is plainly bare (skin-coloured amid skin-coloured, a few centimetres
round). A garment's seeds are sown only where its zone is plainly covered, so a bare or tattooed
chest seeds no shirt. A point belongs to the region that reaches it most cheaply. A step costs its
length, more where the colour changes across it, more the further the point's colour lies from the
growing region's own (learnt from its seeds, relearnt from what it grew), and more again where
another region's colour fits it better. So each region keeps to one piece that keeps to its colour:
a brown jerkin is not skin for being skin-coloured, a tattoo is not cloth for being dark, and a
skirt's hem is not skin for touching the feet. Whatever no region's colour fits, in pieces too large
to be a crease (belts, buckles, trim), is paint. Nothing is hair: the bodies are bald, their brows
are worn as painted, and the person's own groom (js/hair-continuum.js) is their hair.

  python3 scripts/crew_regions.py fit.glb [--write] [--labels=out.npy]

Reads a fit (scripts/fit-crew-body.py --textured), prints each region's share, and with --write
rewrites its _REGION in place; scripts/fit-crew-body.py labels through label_regions below.
Needs numpy, scipy and Pillow.
"""
import io, json, os, struct, sys
import numpy as np
from PIL import Image, ImageFilter
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra, connected_components

PAINT, SHIRT, TROUSERS, SKIN, HAIR = 0, 1, 2, 3, 4
NAMES = ('paint', 'shirt', 'trousers', 'skin', 'hair')

WELD = 2e-4           # metres: points this close are one point of the surface
EDGE = 0.03           # OKLab step across an edge that costs as much again as its length
FAR = 2.0             # Mahalanobis radius inside which a colour is its region's own at no extra cost
STEEP = 1.5           # how fast a step's cost grows past FAR
STRANGE = 4.5         # Mahalanobis radius past which no region's colour fits a point
PIECE = 40            # welded points: smaller strange pieces are creases and stains, larger are paint
SPECK = 150           # welded points, a few square centimetres: a smaller piece of a region is a speck in another
RIVAL = 1.0           # how much more a region pays for a colour another region holds better
CELL = 0.025          # metres: the grain of `bare`, each place's share of skin-coloured surface around it


def srgb_to_linear(srgb):
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_oklab(rgb):
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    l = np.cbrt(np.maximum(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.0))
    m = np.cbrt(np.maximum(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0.0))
    s = np.cbrt(np.maximum(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b, 0.0))
    return np.column_stack([
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ]).astype(np.float32)


def bilinear_sample(pixels, uvs):
    h, w = pixels.shape[:2]
    u = (uvs[:, 0] % 1.0) * (w - 1)
    v = (uvs[:, 1] % 1.0) * (h - 1)
    x0 = np.floor(u).astype(np.int32)
    y0 = np.floor(v).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (u - x0)[:, None]
    fy = (v - y0)[:, None]
    return (pixels[y0, x0] * (1 - fx) * (1 - fy) + pixels[y0, x1] * fx * (1 - fy)
            + pixels[y1, x0] * (1 - fx) * fy + pixels[y1, x1] * fx * fy).astype(np.float32)


class Model:
    """A region's colour: up to `k` Gaussians in OKLab, each floored so no region is a single shade. The pictures
    carry baked light, so a region's lightness wanders far more than its hue: lightness is floored wide."""
    FLOOR = np.array([0.10, 0.010, 0.010], np.float32)

    def __init__(self, lab, k=1):
        lab = np.asarray(lab, np.float32)
        self.parts = []
        if len(lab) < 8:
            return
        centres = np.median(lab, axis=0)[None]
        if k > 1 and len(lab) >= 64 * k:
            # k-means++ seeded by the farthest colours, a few rounds; enough to split a white shirt from its embroidery.
            centres = [np.median(lab, axis=0)]
            for _ in range(k - 1):
                d = np.min([np.sum((lab - c) ** 2, axis=1) for c in centres], axis=0)
                centres.append(lab[int(np.argmax(d))])
            centres = np.array(centres)
            for _ in range(8):
                near = np.argmin(((lab[:, None] - centres[None]) ** 2).sum(-1), axis=1)
                centres = np.array([lab[near == c].mean(0) if (near == c).sum() > 8 else centres[c] for c in range(len(centres))])
        near = np.argmin(((lab[:, None] - centres[None]) ** 2).sum(-1), axis=1)
        for c in range(len(centres)):
            x = lab[near == c]
            if len(x) < max(8, len(lab) // 50):
                continue
            mu = np.median(x, axis=0)
            for _ in range(3):
                cov = np.cov((x - mu).T) + np.diag(self.FLOOR ** 2)
                inv = np.linalg.inv(cov)
                d2 = np.einsum('ij,jk,ik->i', x - mu, inv, x - mu)
                keep = d2 < 9.0
                if keep.sum() < 8:
                    break
                mu = x[keep].mean(0)
                x = x[keep]
            cov = np.cov((x - mu).T) + np.diag(self.FLOOR ** 2)
            self.parts.append((mu.astype(np.float32), np.linalg.inv(cov).astype(np.float32)))

    def __bool__(self):
        return bool(self.parts)

    def distance(self, lab):
        """Each colour's Mahalanobis distance from the nearest part."""
        if not self.parts:
            return np.full(len(lab), np.inf, np.float32)
        return np.sqrt(np.min([np.einsum('ij,jk,ik->i', lab - mu, inv, lab - mu) for mu, inv in self.parts], axis=0))


def joint_groups(slot_names):
    def slots(test):
        return [i for i, n in enumerate(slot_names) if test(n)]
    return {
        'head': slots(lambda n: n == 'head' or n.startswith('FACIAL_')),
        'neck': slots(lambda n: n in ('neck_01', 'neck_02')),
        'hand': slots(lambda n: n.startswith(('hand_', 'index_', 'middle_', 'ring_', 'pinky_', 'thumb_'))),
        'arm': slots(lambda n: n.startswith(('upperarm_', 'lowerarm_'))),
        'forearm': slots(lambda n: n.startswith('lowerarm_')),
        'chest': slots(lambda n: n in ('spine_02', 'spine_03', 'spine_04', 'spine_05', 'clavicle_l', 'clavicle_r')),
        'waist': slots(lambda n: n == 'spine_01'),
        'hips': slots(lambda n: n == 'pelvis' or n.startswith('thigh_')),
        'calf': slots(lambda n: n.startswith('calf_')),
        'foot': slots(lambda n: n.startswith(('foot_', 'ball_'))),
    }


def label_regions(P, UV, F, J, W, slot_names, joint_pos, image, undressed=False, log=print):
    """Region of each vertex. P (n,3) bind positions in metres (y up, z forward), UV (n,2), F (m,3) triangles,
    J/W (n,4) joint slots and weights, slot_names the skin's joint names, joint_pos name -> position, image the
    body's picture (PIL)."""
    P = np.asarray(P, np.float64)
    F = np.asarray(F, np.int64).reshape(-1, 3)
    n_v = len(P)

    # Colour, read through a slight blur so a weave's single texels do not decide anything.
    pixels = np.asarray(image.convert('RGB').filter(ImageFilter.GaussianBlur(2.0)), np.float32) / 255.0
    lab_v = linear_to_oklab(srgb_to_linear(bilinear_sample(pixels, UV)))

    # Weld: one node per place on the surface, so a UV seam is no border.
    _, first, node = np.unique(np.round(P / WELD).astype(np.int64), axis=0, return_index=True, return_inverse=True)
    node = node.ravel()
    n = len(first)
    count = np.bincount(node, minlength=n).astype(np.float32)
    def mean(x):
        return np.column_stack([np.bincount(node, weights=x[:, k], minlength=n) for k in range(x.shape[1])]) / count[:, None]
    pos = P[first]
    lab = mean(lab_v).astype(np.float32)
    group_w = {}
    for name, slots in joint_groups(slot_names).items():
        w = (W * np.isin(J, slots)).sum(axis=1)
        group_w[name] = np.bincount(node, weights=w, minlength=n) / count

    tri = node[F]
    a = np.concatenate([tri[:, 0], tri[:, 1], tri[:, 2]])
    b = np.concatenate([tri[:, 1], tri[:, 2], tri[:, 0]])
    keep = a != b
    pair = np.unique(np.minimum(a[keep], b[keep]) * n + np.maximum(a[keep], b[keep]))
    ei, ej = pair // n, pair % n
    length = np.linalg.norm(pos[ei] - pos[ej], axis=1) + 1e-5
    step = np.linalg.norm(lab[ei] - lab[ej], axis=1)
    base = length * (1.0 + (step / EDGE) ** 2)

    def grow(seeds_by_region, models, allowed):
        """Each node's cheapest region from its seeds; inf where none reaches. A region pays for a colour unlike
        its own, and more again for one another region holds better, so a skirt's hem stays skirt and a bare
        belly skin."""
        dist = {r: models[r].distance(lab) for r in seeds_by_region if len(seeds_by_region[r]) and models.get(r)}
        cost = np.full((5, n), np.inf, np.float32)
        for r, d in dist.items():
            rivals = [dist[q] for q in dist if q != r]
            best = np.min(rivals, axis=0) if rivals else d
            mult = 1.0 + STEEP * (np.maximum(d - FAR, 0.0) ** 2 + RIVAL * np.maximum(d - best, 0.0) ** 2)
            mult = np.where(allowed[r], np.minimum(mult, 1e4), 1e7)
            w = base * 0.5 * (mult[ei] + mult[ej])
            g = csr_matrix((np.concatenate([w, w]), (np.concatenate([ei, ej]), np.concatenate([ej, ei]))), shape=(n, n))
            cost[r] = dijkstra(g, directed=True, indices=seeds_by_region[r], min_only=True)
        return cost

    head, hand, foot = group_w['head'], group_w['hand'], group_w['foot']
    upper = group_w['chest'] + group_w['neck'] + group_w['arm'] + group_w['waist']
    lower = group_w['hips'] + group_w['calf'] + group_w['foot'] + 0.5 * group_w['waist']

    # Skin's colour: the middle of the face (nose bridge, cheeks, upper lip) and the palms and fingers.
    hp = np.asarray(joint_pos['head'], np.float64)
    on_head = head > 0.9
    top = float(pos[on_head, 1].max()) if on_head.any() else hp[1] + 0.2
    span = max(top - hp[1], 0.12)
    front = float(np.percentile(pos[on_head, 2], 98)) if on_head.any() else hp[2] + 0.1
    rise = (pos[:, 1] - hp[1]) / span
    face = on_head & (np.abs(pos[:, 0] - hp[0]) < 0.045) & (rise > 0.28) & (rise < 0.52) & (pos[:, 2] > front - 0.035)
    if face.sum() < 30:
        face = on_head & (pos[:, 2] > front - 0.05)
    L = lab[:, 0]
    lo, hi = np.percentile(L[face], [20, 85])
    face &= (L >= lo) & (L <= hi)
    skin = Model(lab[face])
    palms = hand > 0.9
    gloved = bool(palms.any()) and float(np.median(skin.distance(lab[palms]))) > 3.5
    if not gloved:
        skin = Model(lab[face | (palms & (skin.distance(lab) < 3.0))])
    d_skin = skin.distance(lab)
    # How much of each place's few centimetres is skin-coloured: a clothed chest none, a bare calf all, a tattooed
    # chest half. Seeds are sown only where a place is plainly one or the other.
    bare = local_share(pos, d_skin < 2.5)
    # Forearms, shins, feet and neck may be bare wherever they look it; upper arms and trunk are reached from them, as
    # a leather jerkin or pauldron can be skin-coloured all over.
    limb = (group_w['forearm'] + group_w['calf'] + group_w['foot'] + group_w['neck']) > 0.8
    skin_seeds = face | (palms & ~np.bool_(gloved) & (d_skin < 3.0)) | (limb & (d_skin < 2.0) & (bare > 0.85))

    if undressed:
        regions_n = np.full(n, SKIN, np.int64)
    else:
        def sown(zone):
            """A garment's seeds in its zone: not skin-coloured amid not skin-coloured, over a quarter of the zone."""
            s = zone & (d_skin > 3.0) & (bare < 0.25)
            return s if s.sum() > 0.25 * max(int(zone.sum()), 1) else np.zeros(n, bool)
        # Sleeves seed their own: a band at the shoulder seam would otherwise cut them off from the chest.
        shirt_seeds = sown(group_w['chest'] > 0.8) | sown(group_w['arm'] > 0.8)
        trousers_seeds = sown((group_w['hips'] > 0.8) & (pos[:, 1] > np.asarray(joint_pos['pelvis'])[1] - 0.25))
        # Shoes are paint, where the soles are shod.
        paint_seeds = (foot > 0.8) & (d_skin > 3.0) & (bare < 0.3)

        allowed = {
            PAINT: np.ones(n, bool),
            SKIN: np.ones(n, bool),
            SHIRT: (upper >= 0.25) & (head < 0.5) & (hand < 0.5),
            TROUSERS: (lower >= 0.25) & (head < 0.5) & (hand < 0.5),
        }
        seeds = {SKIN: skin_seeds, SHIRT: shirt_seeds & allowed[SHIRT], TROUSERS: trousers_seeds & allowed[TROUSERS], PAINT: paint_seeds}
        models = {
            SKIN: skin,
            SHIRT: Model(lab[seeds[SHIRT]], k=2),
            TROUSERS: Model(lab[seeds[TROUSERS]], k=2),
            PAINT: Model(lab[seeds[PAINT]], k=2),
        }
        for round_ in range(3):
            cost = grow({r: np.nonzero(s)[0] for r, s in seeds.items()}, models, allowed)
            regions_n = np.argmin(cost, axis=0)
            unreached = ~np.isfinite(cost.min(axis=0))
            # What no region's colour fits, in pieces larger than a crease, is paint: belts, buckles, trim. Not on
            # the head or hands, whose tones wander.
            fit = np.min([models[r].distance(lab) if models.get(r) else np.full(n, np.inf, np.float32) for r in (SHIRT, TROUSERS, SKIN)], axis=0)
            strange = (fit > STRANGE) & (head < 0.5) & (hand < 0.5)
            # Relearn each region's colour from what it grew; cloth never learns skin's.
            for r in (SHIRT, TROUSERS):
                grown = (regions_n == r) & (d_skin > 2.5) & ~strange
                if grown.sum() > 64:
                    models[r] = Model(lab[grown], k=2)
            grown = (regions_n == SKIN) & ~strange & (d_skin < 3.0)
            if grown.sum() > 64:
                models[SKIN] = Model(lab[grown], k=2)
            if round_ == 2:
                break
            si, sj = ei[strange[ei] & strange[ej]], ej[strange[ei] & strange[ej]]
            _, strange_piece = connected_components(csr_matrix((np.ones(len(si)), (si, sj)), shape=(n, n)), directed=False)
            size = np.bincount(strange_piece[strange], minlength=n)
            seeds[PAINT] = paint_seeds | (strange & (size[strange_piece] >= PIECE))
            models[PAINT] = Model(lab[seeds[PAINT]], k=4)
            d_skin = models[SKIN].distance(lab)
        regions_n[unreached] = PAINT
        log('seeds:', {NAMES[r]: int(s.sum()) for r, s in seeds.items()}, 'unreached:', int(unreached.sum()))

    regions_n = despeckle(regions_n, ei, ej, n)
    regions = regions_n[node]
    log('regions:', {NAMES[k]: int((regions == k).sum()) for k in range(5)})
    return regions


def local_share(pos, flag, cell=CELL):
    """Each point's share of flagged points within a cell either way, about 7 cm across."""
    from scipy.ndimage import uniform_filter
    key = np.floor((pos - pos.min(0)) / cell).astype(np.int64) + 1
    dims = key.max(0) + 2
    flat = np.ravel_multi_index(key.T, dims)
    total = np.bincount(flat, minlength=int(np.prod(dims))).reshape(dims).astype(np.float64)
    hits = np.bincount(flat, weights=flag.astype(np.float64), minlength=int(np.prod(dims))).reshape(dims)
    total, hits = uniform_filter(total, 3, mode='constant'), uniform_filter(hits, 3, mode='constant')
    return (hits / np.maximum(total, 1e-12)).ravel()[flat]


def despeckle(regions, ei, ej, n, size=SPECK):
    """Pieces of a region smaller than `size` nodes take the region most of their border holds."""
    for _ in range(3):
        same = regions[ei] == regions[ej]
        _, piece = connected_components(csr_matrix((np.ones(int(same.sum())), (ei[same], ej[same])), shape=(n, n)), directed=False)
        sizes = np.bincount(piece)
        small = sizes[piece] < size
        if not small.any():
            break
        border = ~same & (small[ei] | small[ej])
        votes = np.zeros((len(sizes), 5), np.int64)
        for x, y in ((ei[border], ej[border]), (ej[border], ei[border])):
            at = small[x]
            np.add.at(votes, (piece[x[at]], regions[y[at]]), 1)
        winner = np.where(votes.sum(1) > 0, votes.argmax(1), -1)
        change = small & (winner[piece] >= 0)
        regions = np.where(change, winner[piece], regions)
    return regions


# ---- fits on disk -------------------------------------------------------------------------------------------------
TYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
SIZES = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    data = open(path, 'rb').read()
    n = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + n])
    start = 20 + n + 8
    return doc, data, start


def accessor(doc, data, bin_start, index):
    a = doc['accessors'][index]
    v = doc['bufferViews'][a['bufferView']]
    t = TYPES[a['componentType']]
    size = SIZES[a['type']]
    offset = bin_start + v.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = v.get('byteStride') or size * np.dtype(t).itemsize
    if stride != size * np.dtype(t).itemsize:
        raise SystemExit('interleaved accessors are not read here')
    return np.frombuffer(data, dtype=t, count=a['count'] * size, offset=offset).reshape(a['count'], size), offset


def label_fit(path, write=False, labels=None):
    doc, data, bin_start = read_glb(path)
    prim = doc['meshes'][0]['primitives'][0]
    at = prim['attributes']
    P = accessor(doc, data, bin_start, at['POSITION'])[0]
    UV = accessor(doc, data, bin_start, at['TEXCOORD_0'])[0]
    J = accessor(doc, data, bin_start, at['JOINTS_0'])[0].astype(np.int64)
    W = accessor(doc, data, bin_start, at['WEIGHTS_0'])[0].astype(np.float64)
    F = accessor(doc, data, bin_start, prim['indices'])[0].ravel()
    skin = doc['skins'][0]
    names = [doc['nodes'][j]['name'] for j in skin['joints']]
    ibm = accessor(doc, data, bin_start, skin['inverseBindMatrices'])[0].astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    joint_pos = {name: np.linalg.inv(m)[:3, 3] for name, m in zip(names, ibm)}
    tex = doc['textures'][doc['materials'][prim['material']]['pbrMetallicRoughness']['baseColorTexture']['index']]
    bv = doc['bufferViews'][doc['images'][tex['source']]['bufferView']]
    image = Image.open(io.BytesIO(data[bin_start + bv.get('byteOffset', 0):bin_start + bv.get('byteOffset', 0) + bv['byteLength']]))
    print(os.path.basename(path))
    regions = label_regions(P, UV, F, J, W, names, joint_pos, image)
    if labels:
        np.save(labels, regions.astype(np.uint8))
    if write:
        old, offset = accessor(doc, data, bin_start, at['_REGION'])
        out = np.zeros_like(old)
        out[:, 0] = regions
        with open(path, 'r+b') as f:
            f.seek(offset)
            f.write(out.astype(np.uint8).tobytes())
        print('wrote', path)
    return regions


if __name__ == '__main__':
    flags = [a for a in sys.argv[1:] if a.startswith('--')]
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        raise SystemExit(__doc__)
    labels = next((f.split('=', 1)[1] for f in flags if f.startswith('--labels=')), None)
    for p in args:
        label_fit(p, write='--write' in flags, labels=labels if len(args) == 1 else None)
