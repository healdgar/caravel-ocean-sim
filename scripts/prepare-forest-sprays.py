#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Draws the Portugal pack's leaf pictures as 512x512 botanical sprays: 3D-shaded woody twigs, petioles and layered leaves.

    python3 scripts/prepare-forest-sprays.py [--preview FOLDER]

A full-grown tree carries its foliage on cambered shoots ~0.38-0.46 m long (scripts/bake-forest-mature-pack.py).
One leaf drawn that large makes an oak of 25 m read as a seedling a few leaves tall. A high-resolution 512x512
botanical spray on the shoot shows crisp individual leaves, petioles, and 3D-normal woody branchlets at natural
Mediterranean scale while preserving physical crown leaf-area coverage.

The single leaves are saba's (assets/forest-scenery/saba/leaf-<species>-<n>-{albedo,normal}.png). Each spray is
drawn at 4x supersampling (DRAWN = 2048) on a card SPRAY_ASPECT times as long as it is broad, with the main twig's
foot at the middle of the card's near edge where the shoot meets its branchlet. Non-bark companion maps in the
Portugal pack (wounds and single-leaf blueberry shrub foliage) are aligned to 512x512 so all non-bark maps share
surface Family 1 alongside Family 0's 512x1024 bark maps.

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
from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/forest-scenery/saba'
PACK = ROOT / 'assets/forest-scenery/portugal'
# A spray's card is this many times as long as it is broad. scripts/bake-forest-mature-pack.py shapes the shoots to it.
SPRAY_ASPECT = 1.25
SIZE = 512
# The spray is drawn at 4x supersampling across the card's breadth and box-filtered to SIZE x SIZE.
DRAWN = 2048

# species: leaf aspect (length/breadth); leaf length as share of card breadth; leaf insertion angle (deg);
# internode step in leaf lengths; opposite/paired phyllotaxy; lateral side-twigs (along_fraction, angle_deg, reach);
# woody bark colour (RGB 0..255) and bark roughness.
SPECIES = {
    'oak': dict(
        aspect=1.52, length=0.39, angle=48, step=0.23, paired=False,
        forks=((0.09, 34, 0.56), (0.37, 29, 0.44), (0.62, 25, 0.28)),
        twig=(88, 72, 48), twig_rough=0.86,
    ),
    'chestnut': dict(
        aspect=2.50, length=0.45, angle=50, step=0.20, paired=False,
        forks=((0.09, 32, 0.54), (0.40, 27, 0.38)),
        twig=(94, 78, 48), twig_rough=0.83,
    ),
    'maple': dict(
        aspect=1.12, length=0.38, angle=56, step=0.38, paired=True,
        forks=((0.13, 38, 0.48),),
        twig=(102, 70, 54), twig_rough=0.82,
    ),
    'elm': dict(
        aspect=1.88, length=0.33, angle=54, step=0.25, paired=False,
        forks=((0.09, 35, 0.54), (0.35, 30, 0.43), (0.60, 26, 0.30)),
        twig=(82, 69, 51), twig_rough=0.85,
    ),
    'birch': dict(
        aspect=1.55, length=0.29, angle=48, step=0.29, paired=False,
        forks=((0.09, 36, 0.55), (0.37, 32, 0.43), (0.62, 27, 0.28)),
        twig=(68, 50, 42), twig_rough=0.80,
    ),
}
ALL_SPECIES = ('oak', 'chestnut', 'maple', 'elm', 'birch', 'blueberry')


def planes(path):
    return np.asarray(Image.open(path).convert('RGBA'), dtype=np.float32) / 255.0


def placed_crop(plane, coefficients, crop_size):
    """Transform one plane of a source leaf image into a tight local bounding box on the supersampled canvas."""
    image = Image.fromarray(plane, mode='F')
    return np.asarray(
        image.transform(crop_size, Image.AFFINE, coefficients, resample=Image.BICUBIC, fillcolor=0.0),
        dtype=np.float32,
    )


def rasterize_cylindrical_twigs(twigs, width, height, base_rgb, twig_rough):
    """Render tapered 3D-cylindrical woody branchlets and petioles with true tangent-space normals and bark grain."""
    twig_colour = np.zeros((height, width, 3), np.float32)
    twig_detail = np.zeros((height, width, 4), np.float32)
    twig_alpha = np.zeros((height, width), np.float32)

    for points, r_start, r_end in twigs:
        n_seg = len(points) - 1
        if n_seg < 1:
            continue
        for k in range(n_seg):
            x0, y0 = points[k][0] * DRAWN, points[k][1] * DRAWN
            x1, y1 = points[k + 1][0] * DRAWN, points[k + 1][1] * DRAWN
            r0 = (r_start + (r_end - r_start) * (k / n_seg)) * DRAWN
            r1 = (r_start + (r_end - r_start) * ((k + 1) / n_seg)) * DRAWN
            rmax = max(r0, r1) + 2.0
            ix0 = max(0, int(math.floor(min(x0, x1) - rmax)))
            ix1 = min(width, int(math.ceil(max(x0, x1) + rmax)) + 1)
            iy0 = max(0, int(math.floor(min(y0, y1) - rmax)))
            iy1 = min(height, int(math.ceil(max(y0, y1) + rmax)) + 1)
            if ix0 >= ix1 or iy0 >= iy1:
                continue

            dx, dy = x1 - x0, y1 - y0
            seg_len2 = dx * dx + dy * dy
            if seg_len2 < 1e-6:
                continue
            seg_len = math.sqrt(seg_len2)
            tx, ty = dx / seg_len, dy / seg_len
            px, py = -ty, tx

            gx = np.arange(ix0, ix1, dtype=np.float32)[None, :] + 0.5 - x0
            gy = np.arange(iy0, iy1, dtype=np.float32)[:, None] + 0.5 - y0
            t = np.clip((gx * dx + gy * dy) / seg_len2, 0.0, 1.0)
            cx = gx - t * dx
            cy = gy - t * dy
            dist = np.sqrt(cx * cx + cy * cy)
            rad = np.maximum(1.1, r0 + (r1 - r0) * t)

            seg_a = np.clip((rad + 0.75 - dist) / 1.5, 0.0, 1.0)
            if not (seg_a > 1e-3).any():
                continue

            signed_perp = gx * px + gy * py
            u_cyl = np.clip(signed_perp / np.maximum(rad, 1e-3), -0.95, 0.95)
            nz = np.sqrt(np.maximum(0.08, 1.0 - u_cyl * u_cyl))
            # Subtle longitudinal bark ridges & lenticel nodes along the woody stem.
            along_px = (k + t) * 0.85
            grain = 0.07 * np.sin(u_cyl * 9.0 + along_px * 1.7) + 0.04 * np.cos(along_px * 5.2)
            nx = u_cyl * px + grain * tx
            ny = u_cyl * py + grain * ty
            inv_n = 1.0 / np.maximum(np.sqrt(nx * nx + ny * ny + nz * nz), 1e-6)
            nx, ny, nz = nx * inv_n, ny * inv_n, nz * inv_n

            # Cylindrical edge ambient darkening + subtle warm/cool bark tone along nodes.
            cyl_shade = (1.0 - 0.26 * (u_cyl * u_cyl)) * (0.95 + 0.08 * np.sin(along_px * 2.3))
            c_patch = seg_a[..., None] * (base_rgb[None, None, :] * cyl_shade[..., None])
            d_patch = np.stack(
                [
                    seg_a * (0.5 + 0.5 * nx),
                    seg_a * (0.5 + 0.5 * ny),
                    seg_a * (0.5 + 0.5 * nz),
                    seg_a * np.clip(twig_rough + 0.05 * grain, 0.65, 0.96),
                ],
                axis=-1,
            )

            cur_a = twig_alpha[iy0:iy1, ix0:ix1]
            keep = 1.0 - seg_a
            twig_colour[iy0:iy1, ix0:ix1] = c_patch + twig_colour[iy0:iy1, ix0:ix1] * keep[..., None]
            twig_detail[iy0:iy1, ix0:ix1] = d_patch + twig_detail[iy0:iy1, ix0:ix1] * keep[..., None]
            twig_alpha[iy0:iy1, ix0:ix1] = seg_a + cur_a * keep

    return twig_colour, twig_detail, twig_alpha


def spray(species, variant):
    look = SPECIES[species]
    albedo = planes(SOURCE / f'leaf-{species}-{variant}-albedo.png')
    normal = planes(SOURCE / f'leaf-{species}-{variant}-normal.png')
    cover = albedo[..., 3]
    src_h, src_w = cover.shape
    bare = (
        np.median(normal[cover < 0.02], axis=0)
        if (cover < 0.02).any()
        else np.array([0.5, 0.5, 1.0, 0.5], np.float32)
    )
    rng = random.Random(f'{species}-{variant}-v2')
    width, height = round(DRAWN * SPRAY_ASPECT), DRAWN
    length = look['length']
    twigs, leaves = [], []

    def set_leaf(x_node, y_node, angle, long):
        """Attach a leaf via a short woody petiole from (x_node, y_node), keeping the blade wholly inside the card."""
        c, s = math.cos(angle), math.sin(angle)
        for share in (1.0, 0.92, 0.84, 0.76, 0.68, 0.60):
            L = long * share
            petiole = 0.055 * L
            xb = x_node + c * petiole
            yb = y_node + s * petiole
            half = L / look['aspect'] / 2.0
            corners = [(xb + c * a - s * b, yb + s * a + c * b) for a in (0.0, L) for b in (-half, half)]
            if all(0.006 <= u <= SPRAY_ASPECT - 0.006 and 0.006 <= v <= 0.994 for u, v in corners):
                twigs.append(([(x_node, y_node), (xb + c * 0.02 * L, yb + s * 0.02 * L)], 0.0048, 0.0030))
                leaves.append((xb, yb, angle, L))
                return

    def shoot(x0, y0, heading, reach, first):
        """One curved woody shoot from (x0, y0), bearing lateral leaves and a terminal cluster."""
        bend = rng.uniform(-0.042, 0.042)
        at = lambda t: (
            x0 + math.cos(heading) * t - math.sin(heading) * bend * math.sin(math.pi * t / max(reach, 1e-4)),
            y0 + math.sin(heading) * t + math.cos(heading) * bend * math.sin(math.pi * t / max(reach, 1e-4)),
        )
        pts = [at(t) for t in np.linspace(0.0, reach, 24)]
        twigs.append((pts, 0.0115 if first else 0.0072, 0.0045 if first else 0.0032))
        t, side = length * rng.uniform(0.10, 0.20), rng.choice((-1, 1))
        while t < reach - length * 0.12:
            grown = (0.82 + 0.20 * t / max(reach, 1e-4)) * rng.uniform(0.88, 1.07)
            for s_side in ((-1, 1) if look['paired'] else (side,)):
                set_leaf(
                    *at(t),
                    heading + s_side * math.radians(look['angle'] + rng.uniform(-8.5, 8.5)),
                    length * grown,
                )
            side = -side
            t += length * look['step'] * rng.uniform(0.86, 1.14)
        # Terminal leaf + sub-terminal companion leaf for natural Mediterranean shoot closure.
        set_leaf(*at(reach), heading + math.radians(rng.uniform(-10, 10)), length * rng.uniform(0.95, 1.06))
        return at

    main_reach = SPRAY_ASPECT - length * rng.uniform(0.98, 1.04)
    main = shoot(0.0, 0.5 + rng.uniform(-0.018, 0.018), math.radians(rng.uniform(-2.5, 2.5)), main_reach, True)
    side = rng.choice((-1, 1))
    for along, angle, reach in look['forks']:
        shoot(
            *main(main_reach * along * rng.uniform(0.88, 1.12)),
            side * math.radians(angle + rng.uniform(-5, 5)),
            reach * rng.uniform(0.92, 1.06),
            False,
        )
        side = -side

    # Sort leaves from basal/shaded to distal/sunlit so upper leaves naturally overlap and shade lower ones.
    leaves.sort(key=lambda leaf: leaf[0] + rng.uniform(-0.03, 0.03))

    base_twig_rgb = np.array(look['twig'], np.float32) / 255.0
    colour, detail, alpha = rasterize_cylindrical_twigs(twigs, width, height, base_twig_rgb, look['twig_rough'])

    premult_albedo = [np.ascontiguousarray(albedo[..., k] * cover) for k in range(3)]
    premult_normal = [np.ascontiguousarray(normal[..., k] * cover) for k in range(4)]
    cover_contig = np.ascontiguousarray(cover)

    for x, y, angle, long in leaves:
        broad = long / look['aspect']
        c, s = math.cos(angle), math.sin(angle)
        x0, y0 = x * DRAWN, y * DRAWN
        L_px, W_px = long * DRAWN, broad * DRAWN
        half_w = 0.5 * W_px
        pts_x = [x0 + c * a - s * b for a in (-4.0, L_px + 4.0) for b in (-half_w - 4.0, half_w + 4.0)]
        pts_y = [y0 + s * a + c * b for a in (-4.0, L_px + 4.0) for b in (-half_w - 4.0, half_w + 4.0)]
        ix0 = max(0, int(math.floor(min(pts_x))) - 10)
        ix1 = min(width, int(math.ceil(max(pts_x))) + 10)
        iy0 = max(0, int(math.floor(min(pts_y))) - 10)
        iy1 = min(height, int(math.ceil(max(pts_y))) + 10)
        if ix0 >= ix1 or iy0 >= iy1:
            continue
        cw, ch = ix1 - ix0, iy1 - iy0

        # Map crop pixel (u_crop, v_crop) -> canvas (u_crop + ix0, v_crop + iy0) -> source leaf (0..src_w, 0..src_h).
        along_scale, across_scale = src_w / L_px, src_h / W_px
        ox, oy = ix0 - x0, iy0 - y0
        coefficients = (
            along_scale * c,
            along_scale * s,
            along_scale * (c * ox + s * oy),
            -across_scale * s,
            across_scale * c,
            across_scale * (-s * ox + c * oy) + src_h * 0.5,
        )

        a_raw = np.clip(placed_crop(cover_contig, coefficients, (cw, ch)), 0.0, 1.0)
        if not (a_raw > 0.02).any():
            continue
        # Crisp botanical margin around 0.50 (preserves leaf area while eliminating upsample blur).
        t_edge = np.clip((a_raw - 0.30) / 0.40, 0.0, 1.0)
        a = t_edge * t_edge * (3.0 - 2.0 * t_edge)
        ratio = np.where(a_raw > 1e-4, a / np.maximum(a_raw, 1e-4), 0.0)

        # Sunlit/shaded leaf variation + subtle apex warmth across individual leaves on the shoot.
        shade = rng.uniform(0.88, 1.10) * (0.94 + 0.10 * (x / SPRAY_ASPECT))
        hue_warm = rng.uniform(-0.035, 0.040)
        tint = np.array([1.0 + hue_warm, 1.0 + 0.4 * hue_warm, 1.0 - 0.7 * hue_warm], np.float32) * shade

        # Local leaf coordinates (u_leaf in 0..1 base-to-tip, v_leaf in -0.5..0.5 across blade) for high-res venation.
        gx = (np.arange(cw, dtype=np.float32)[None, :] + ox)
        gy = (np.arange(ch, dtype=np.float32)[:, None] + oy)
        u_leaf = np.clip((c * gx + s * gy) / max(L_px, 1.0), 0.0, 1.0)
        v_leaf = np.clip((-s * gx + c * gy) / max(W_px, 1.0), -0.5, 0.5)

        layer_colour = (
            np.stack([placed_crop(premult_albedo[k], coefficients, (cw, ch)) * ratio for k in range(3)], axis=-1)
            * tint[None, None, :]
        )
        # Subtle midrib & pinnate vein relief + lamina self-shading at full 2048 supersampled resolution.
        midrib_w = np.exp(-np.abs(v_leaf) * 34.0) * (1.0 - 0.55 * u_leaf)
        chev = u_leaf * 26.0 - np.abs(v_leaf) * 15.0
        lat_vein = np.exp(-np.abs((chev - np.floor(chev)) - 0.5) * 9.0) * (1.0 - np.abs(v_leaf) * 1.4)
        vein_bright = 1.0 + 0.08 * midrib_w + 0.035 * np.maximum(lat_vein, 0.0)
        layer_colour *= vein_bright[..., None]

        raw = [placed_crop(premult_normal[k], coefficients, (cw, ch)) * ratio for k in range(4)]
        nx_l = raw[0] * 2.0 - a
        ny_l = raw[1] * 2.0 - a
        nz_l = np.maximum(raw[2] * 2.0 - a, 0.05 * a)

        # Add per-leaf 3D botanical pitch/roll + crisp midrib/pinnate normal relief so leaves catch light individually.
        tilt_u = rng.uniform(-0.20, 0.16) - 0.12 * (u_leaf - 0.4) * a
        tilt_v = rng.uniform(-0.24, 0.24) + 0.20 * v_leaf * a
        vein_nu = -0.10 * np.cos(chev * 6.2831853) * a * np.clip(1.0 - np.abs(v_leaf) * 1.8, 0.0, 1.0)
        vein_nv = (0.22 * np.where(v_leaf >= 0.0, 1.0, -1.0) * midrib_w - 0.08 * vein_nu) * a
        nx_l = nx_l + tilt_u * a + vein_nu
        ny_l = ny_l + tilt_v * a + vein_nv
        n_len = np.maximum(np.sqrt(nx_l * nx_l + ny_l * ny_l + nz_l * nz_l), 1e-6)
        nx_l, ny_l, nz_l = nx_l / n_len * a, ny_l / n_len * a, nz_l / n_len * a

        # Rotate leaf tangent normal (nx_l, ny_l) into spray card space.
        nx_w = c * nx_l - s * ny_l
        ny_w = s * nx_l + c * ny_l
        rough_plane = np.clip(raw[3] + rng.uniform(-0.04, 0.04) * a - 0.05 * midrib_w * a, 0.0, a)
        layer_detail = np.stack([(nx_w + a) * 0.5, (ny_w + a) * 0.5, (nz_l + a) * 0.5, rough_plane], axis=-1)

        # Soft contact ambient occlusion cast by this upper leaf onto underlying leaves and woody stems.
        ao_blur = np.asarray(
            Image.fromarray(np.clip(a * 255.0, 0.0, 255.0).astype(np.uint8), mode='L').filter(
                ImageFilter.BoxBlur(radius=9)
            ),
            dtype=np.float32,
        ) / 255.0
        under_shade = 1.0 - 0.22 * ao_blur[..., None]
        keep = 1.0 - a
        colour[iy0:iy1, ix0:ix1] = np.clip(layer_colour, 0.0, None) + (colour[iy0:iy1, ix0:ix1] * under_shade) * keep[..., None]
        detail[iy0:iy1, ix0:ix1] = layer_detail + detail[iy0:iy1, ix0:ix1] * keep[..., None]
        alpha[iy0:iy1, ix0:ix1] = a + alpha[iy0:iy1, ix0:ix1] * keep

    def reduced(plane):
        return np.asarray(
            Image.fromarray(np.ascontiguousarray(plane), mode='F').resize((SIZE, SIZE), resample=Image.BOX),
            dtype=np.float32,
        )

    alpha_small = np.clip(reduced(alpha), 0.0, 1.0)
    held = alpha_small > 1e-3
    safe = np.where(held, alpha_small, 1.0)
    colour_small = np.stack([reduced(colour[..., k]) for k in range(3)], axis=-1)
    detail_small = np.stack([reduced(detail[..., k]) for k in range(4)], axis=-1)
    # Re-normalize averaged tangent normals inside held texels so box-filtered normals stay unit length.
    n_rgb = (detail_small[..., :3] / safe[..., None]) * 2.0 - 1.0
    n_norm = np.maximum(np.linalg.norm(n_rgb, axis=-1, keepdims=True), 1e-6)
    n_rgb = (n_rgb / n_norm) * 0.5 + 0.5
    rough_out = np.clip(detail_small[..., 3:4] / safe[..., None], 0.0, 1.0)
    detail_unit = np.concatenate([n_rgb, rough_out], axis=-1)

    # Where no leaf is, the picture holds the spray's own mean colour, so no edge bleeds dark or pale.
    mean = colour_small.sum(axis=(0, 1)) / max(alpha_small.sum(), 1e-6)
    albedo_out = np.where(held[..., None], np.clip(colour_small / safe[..., None], 0.0, 1.0), mean)
    normal_out = np.where(held[..., None], detail_unit, bare)
    to_bytes = lambda planes_: np.clip(np.rint(planes_ * 255.0), 0, 255).astype(np.uint8)
    albedo_image = Image.fromarray(to_bytes(np.concatenate([albedo_out, alpha_small[..., None]], axis=-1)), 'RGBA')
    normal_image = Image.fromarray(to_bytes(normal_out), 'RGBA')
    return albedo_image, normal_image, float((alpha_small > 0.35).mean()), len(leaves)


def promote_companion_map(path, kind):
    """Promote non-bark companion maps (wounds and single-leaf shrub foliage) to SIZE x SIZE so Family 1 stays unified."""
    im = Image.open(path)
    if im.size == (SIZE, SIZE):
        raw = path.read_bytes()
        return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}, False
    rgba = np.asarray(im.convert('RGBA'), dtype=np.float32) / 255.0
    if kind == 'albedo' and (rgba[..., 3] < 0.99).any():
        # Coverage-preserving premultiplied upsample for alpha-cutout shrub leaves.
        cov = rgba[..., 3]
        up_cov = np.asarray(Image.fromarray(cov, mode='F').resize((SIZE, SIZE), resample=Image.BICUBIC), dtype=np.float32)
        up_cov = np.clip(up_cov, 0.0, 1.0)
        # Match exact mean coverage of source map.
        target_cov = float(cov.mean())
        if target_cov > 1e-4 and up_cov.mean() > 1e-4:
            lo, hi = 0.5, 1.5
            for _ in range(30):
                mid = 0.5 * (lo + hi)
                if np.clip(up_cov * mid, 0.0, 1.0).mean() < target_cov:
                    lo = mid
                else:
                    hi = mid
            up_cov = np.clip(up_cov * (0.5 * (lo + hi)), 0.0, 1.0)
        held = up_cov > 1e-3
        safe = np.where(held, up_cov, 1.0)
        up_rgb = np.stack(
            [
                np.asarray(
                    Image.fromarray(np.ascontiguousarray(rgba[..., k] * cov), mode='F').resize(
                        (SIZE, SIZE), resample=Image.BICUBIC
                    ),
                    dtype=np.float32,
                )
                for k in range(3)
            ],
            axis=-1,
        )
        mean = up_rgb.sum(axis=(0, 1)) / max(up_cov.sum(), 1e-6)
        rgb_out = np.where(held[..., None], np.clip(up_rgb / safe[..., None], 0.0, 1.0), mean)
        out_arr = np.concatenate([rgb_out, up_cov[..., None]], axis=-1)
        out_im = Image.fromarray(np.clip(np.rint(out_arr * 255.0), 0, 255).astype(np.uint8), 'RGBA')
    elif kind == 'normal':
        up = np.stack(
            [
                np.asarray(Image.fromarray(rgba[..., k], mode='F').resize((SIZE, SIZE), resample=Image.BICUBIC), dtype=np.float32)
                for k in range(4)
            ],
            axis=-1,
        )
        vec = up[..., :3] * 2.0 - 1.0
        norm = np.maximum(np.linalg.norm(vec, axis=-1, keepdims=True), 1e-6)
        vec = (vec / norm) * 0.5 + 0.5
        out_arr = np.concatenate([vec, np.clip(up[..., 3:4], 0.0, 1.0)], axis=-1)
        out_im = Image.fromarray(np.clip(np.rint(out_arr * 255.0), 0, 255).astype(np.uint8), 'RGBA')
    else:
        out_im = im.resize((SIZE, SIZE), resample=Image.BICUBIC)
    out_im.save(path, optimize=True)
    raw = path.read_bytes()
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}, True


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
            print(f'{species} {variant}: {count} leaves, {share * 100:.0f}% of the 512x512 card is leaf')
    if args.preview:
        return
    promoted = 0
    for species in ALL_SPECIES:
        for kind in ('albedo', 'normal', 'roughness'):
            wname = f'{species}-veteran-wounds-{kind}.png'
            wpath = PACK / wname
            if wpath.exists():
                rec, changed = promote_companion_map(wpath, kind)
                receipts[wname] = rec
                promoted += int(changed)
    for variant in range(3):
        for kind in ('albedo', 'normal'):
            bname = f'blueberry-veteran-foliage-{variant}-{kind}.png'
            bpath = PACK / bname
            if bpath.exists():
                rec, changed = promote_companion_map(bpath, kind)
                receipts[bname] = rec
                promoted += int(changed)

    manifest_path = PACK / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    renewed = 0
    for prototype in manifest['prototypes']:
        for material in prototype['nativeMaterials']:
            for kind in ('albedo', 'normal', 'roughnessMap'):
                receipt = material.get(kind)
                if receipt and receipt['file'] in receipts:
                    receipt.update(receipts[receipt['file']])
                    renewed += 1
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(
        f'{len(SPECIES) * 6} spray pictures (512x512) written, {promoted} companion maps promoted to 512x512, '
        f'{renewed} receipts renewed in {manifest_path.relative_to(ROOT)}'
    )


if __name__ == '__main__':
    main()
