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
import struct
import subprocess
import tempfile

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

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


def read_glb_mesh(glb_path):
    """Reads vertex positions, UVs, and triangle indices from a fitted crew GLB."""
    data = Path(glb_path).read_bytes()
    jlen = struct.unpack_from('<I', data, 12)[0]
    g = json.loads(data[20:20 + jlen])
    bin_data = data[20 + jlen + 8:]
    prim = g['meshes'][0]['primitives'][0]
    at = prim['attributes']

    def acc(i):
        a = g['accessors'][i]
        v = g['bufferViews'][a['bufferView']]
        off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        dt = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[a['componentType']]
        w = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        arr = np.frombuffer(bin_data, dtype=dt, count=a['count'] * w, offset=off)
        return arr.reshape(-1, w) if w > 1 else arr

    pos = acc(at['POSITION']).astype(np.float32, copy=False)
    uv = acc(at['TEXCOORD_0']).astype(np.float32, copy=False)
    indices = acc(prim['indices']).astype(np.int32, copy=False).reshape(-1, 3)
    return pos, uv, indices


def bilinear_sample(img, u, v):
    """Bilinear sample (H, W, 3) float32 image at normalized (u, v) in [0, 1]."""
    h, w = img.shape[:2]
    x = np.mod(u, 1.0) * w - 0.5
    y = np.mod(v, 1.0) * h - 0.5
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    fx = (x - x0)[..., None].astype(np.float32)
    fy = (y - y0)[..., None].astype(np.float32)
    x0m = x0 % w
    y0m = y0 % h
    x1m = (x0 + 1) % w
    y1m = (y0 + 1) % h
    c00 = img[y0m, x0m]
    c10 = img[y0m, x1m]
    c01 = img[y1m, x0m]
    c11 = img[y1m, x1m]
    return (c00 * (1 - fx) + c10 * fx) * (1 - fy) + (c01 * (1 - fx) + c11 * fx) * fy


def delight_and_equalize_face(linear, covered, glb_path):
    """3D-aware skin delighting + bilateral face/eye restoration for Tripo HD base bodies.

    1. Estimates the smooth 3D directional studio-lighting field on neutral skin vertices (excluding eyes,
       brows, lips, and nostrils) and divides it out across the entire body and head, eliminating dark
       purple/grey unilateral shadows and white specular hotspots while preserving fine skin/pore detail.
    2. Restores bilateral eye/socket symmetry by projecting the shadowed viewer-right eye socket (x > 0)
       onto the cleanly-rendered viewer-left eye (x < 0) via exact triangle UV rasterization + 3D mirror
       lookup, feathered smoothly so both eyes have matched warm irises, crisp lashes, and clean sockets.
    """
    pos, uv, indices = read_glb_mesh(glb_path)
    H, W = linear.shape[:2]
    ymax = float(pos[:, 1].max())
    female = ymax < 1.73
    eye_y = 1.5825 if female else 1.6585
    eye_x = 0.0345 if female else 0.0315
    lip_y = 1.506 if female else 1.584
    nose_y = eye_y - 0.040
    head_y0 = ymax - 0.27

    # Sample current linear color at every vertex
    vx = np.clip((np.mod(uv[:, 0], 1.0) * W).astype(np.int32), 0, W - 1)
    vy = np.clip((np.mod(uv[:, 1], 1.0) * H).astype(np.int32), 0, H - 1)
    v_rgb = linear[vy, vx]
    v_luma = v_rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)

    # Identify pure-skin anchor vertices (exclude eyes, brows, lips, nostrils so features stay crisp!)
    ax = np.abs(pos[:, 0])
    in_eye = (np.abs(ax - eye_x) < 0.020) & (np.abs(pos[:, 1] - eye_y) < 0.014) & (pos[:, 2] > 0.045)
    in_brow = (ax > 0.008) & (ax < 0.058) & (pos[:, 1] > eye_y + 0.011) & (pos[:, 1] < eye_y + 0.034) & (pos[:, 2] > 0.050)
    in_lip = (ax < 0.030) & (np.abs(pos[:, 1] - lip_y) < 0.016) & (pos[:, 2] > 0.068)
    in_nostril = (ax < 0.018) & (np.abs(pos[:, 1] - nose_y) < 0.012) & (pos[:, 2] > 0.072)
    is_skin_anchor = ~(in_eye | in_brow | in_lip | in_nostril) & (v_luma > 0.012)

    # Neutral target skin RGB: median of well-lit neutral skin (excluding extreme highlights & deep shadow)
    head_skin = is_skin_anchor & (pos[:, 1] > head_y0) & (pos[:, 2] > 0.02)
    body_skin = is_skin_anchor & (pos[:, 1] <= head_y0)
    # Target mid-lit tone from the clean right-hand side (x < -0.015), slightly tempered below studio glare
    clean_face = head_skin & (pos[:, 0] < -0.010) & (pos[:, 0] > -0.065) & (pos[:, 1] < eye_y + 0.025) & (pos[:, 1] > lip_y - 0.025)
    target_face = np.median(v_rgb[clean_face], axis=0).astype(np.float32) * 0.86
    # Use clean neutral body median scaled softly to harmonize with face target
    target_body = np.median(v_rgb[body_skin & (pos[:, 0] < -0.02)], axis=0).astype(np.float32) * 0.88
    # Unify skin albedo across head & body smoothly so neck transition has zero seam!
    target_skin = (0.55 * target_face + 0.45 * target_body).astype(np.float32)

    # Subsample skin anchor vertices (~18k body + ~10k head) for fast smooth 3D illumination estimation
    head_idx = np.flatnonzero(head_skin)
    body_idx = np.flatnonzero(body_skin)
    rng = np.random.default_rng(42)
    h_pick = head_idx[rng.choice(len(head_idx), min(10000, len(head_idx)), replace=False)]
    b_pick = body_idx[rng.choice(len(body_idx), min(18000, len(body_idx)), replace=False)]
    anchors = np.concatenate([h_pick, b_pick])
    anchor_pos = pos[anchors]
    anchor_rgb = v_rgb[anchors]

    # Estimate smooth local baked illumination at every mesh vertex via 3D k-NN Gaussian average
    tree3 = cKDTree(anchor_pos)
    # Evaluate on a strided vertex set (~120k verts) then map to 1024x1024 UV grid for blazing speed
    v_stride = max(1, len(pos) // 160000)
    sub_idx = np.arange(0, len(pos), v_stride)
    # Always include all head vertices at higher density (stride 2) for ultra-clean facial delighting
    head_sub = np.flatnonzero(pos[:, 1] > head_y0 - 0.05)[::2]
    eval_idx = np.unique(np.concatenate([sub_idx, head_sub]))
    eval_pos = pos[eval_idx]
    eval_uv = uv[eval_idx]

    dists, nn = tree3.query(eval_pos, k=48, workers=-1)
    # Use tighter 2.4 cm kernel on head, 4.5 cm on body
    sigma = np.where(eval_pos[:, 1:2] > head_y0, 0.024, 0.045).astype(np.float32)
    w = np.exp(-0.5 * (dists.astype(np.float32) / sigma) ** 2)
    w_sum = np.maximum(w.sum(axis=1, keepdims=True), 1e-6)
    local_illum = (w[..., None] * anchor_rgb[nn]).sum(axis=1) / w_sum

    # Delighting RGB gain brings local skin illumination smoothly to uniform target_skin
    gain_v = target_skin[None, :] / np.maximum(local_illum, 0.018)
    # Blend slightly toward neutral luminance ratio so subtle healthy cheek/skin variation survives,
    # while strongly correcting unilateral blue/purple shadow color cast on x > 0!
    gain_luma = (gain_v @ np.array([0.299, 0.587, 0.114], dtype=np.float32))[:, None]
    gain_v = 0.82 * gain_v + 0.18 * gain_luma
    gain_v = np.clip(gain_v, 0.42, 2.80).astype(np.float32)

    # Project vertex delighting gain onto a 1024x1024 UV grid via 2D UV cKDTree (zero cross-island bleed!)
    G = 1024
    cov_g = covered.reshape(G, H // G, G, W // G).any(axis=(1, 3))
    gy, gx = np.nonzero(cov_g)
    q_uv = np.stack([(gx + 0.5) / G, (gy + 0.5) / G], axis=-1).astype(np.float32)
    tree_uv = cKDTree(np.mod(eval_uv, 1.0))
    _, uv_nn = tree_uv.query(q_uv, k=4, workers=-1)
    gain_g = np.ones((G, G, 3), dtype=np.float32)
    gain_g[gy, gx] = gain_v[uv_nn].mean(axis=1)
    # Push-pull fill outside islands so upsampling never pulls black/1.0 across seams
    gain_g = fill_outside(gain_g, cov_g)
    # Upsample smooth gain field to full H x W
    gain_full = np.stack([
        np.asarray(Image.fromarray(gain_g[..., c], mode='F').resize((W, H), Image.BILINEAR), dtype=np.float32)
        for c in range(3)
    ], axis=-1)

    delighted = np.clip(linear * gain_full, 0.0, 1.0).astype(np.float32)

    # Soft specular hotspot knee on skin outside the tight eye opening (kills any residual chalky white glare!)
    pos_g = np.zeros((G, G, 3), dtype=np.float32)
    pos_g[gy, gx] = eval_pos[uv_nn[:, 0]]
    pos_g = fill_outside(pos_g, cov_g)
    pos_full_y = np.asarray(Image.fromarray(pos_g[..., 1], mode='F').resize((W, H), Image.NEAREST), dtype=np.float32)
    pos_full_x = np.asarray(Image.fromarray(pos_g[..., 0], mode='F').resize((W, H), Image.NEAREST), dtype=np.float32)
    pos_full_z = np.asarray(Image.fromarray(pos_g[..., 2], mode='F').resize((W, H), Image.NEAREST), dtype=np.float32)

    eye_dist2 = ((np.abs(pos_full_x) - eye_x) / 0.017) ** 2 + ((pos_full_y - eye_y) / 0.008) ** 2
    in_eye_pix = (pos_full_z > 0.055) & (eye_dist2 < 1.0)
    # Soft-compress any skin texel above 1.28 * target_skin
    hi_cap = (target_skin * 1.28)[None, None, :]
    over = np.maximum(delighted - hi_cap, 0.0)
    compressed = hi_cap + over / (1.0 + over * 6.0)
    delighted = np.where(in_eye_pix[..., None], delighted, np.minimum(delighted, compressed))

    # Pass B: Exact 4K bilateral mirror restoration for the shadowed viewer-right face & eye (x > 0 -> from pristine delighted x < 0)!
    # Measure geometric nose tip as exact sagittal midline x_mid, and match front-projected (x, y) coordinates
    # (with small z weight 0.12) so a tiny 2-3 mm head yaw in Z never snaps eyeball texels onto the eyelid overhang!
    nose_band = (np.abs(pos[:, 0]) < 0.015) & (np.abs(pos[:, 1] - nose_y) < 0.020) & (pos[:, 2] > 0.06)
    nose_pts = pos[nose_band]
    x_mid = float(nose_pts[nose_pts[:, 2] > np.percentile(nose_pts[:, 2], 95), 0].mean()) if len(nose_pts) > 20 else 0.0

    # Measure exact 2D (x, y) eye-fissure center on both sides strictly inside the eyeball band (ignoring outer lashes)
    def find_eye_xy(sgn):
        em = (
            ((pos[:, 0] - x_mid) * sgn > 0.021) & ((pos[:, 0] - x_mid) * sgn < 0.043)
            & (np.abs(pos[:, 1] - eye_y) < 0.009) & (pos[:, 2] > 0.062)
        )
        ep = pos[em]
        el = v_luma[em]
        dark = el < np.percentile(el, 15)
        return float(ep[dark, 0].mean()), float(ep[dark, 1].mean())

    lx_eye, ly_eye = find_eye_xy(-1.0)
    rx_eye, ry_eye = find_eye_xy(1.0)
    eye_dx = (lx_eye - x_mid) + (rx_eye - x_mid)  # residual X asymmetry
    eye_dy = ly_eye - ry_eye

    # Build front-projected cKDTree (x, y, z * 0.12) on clean viewer-left (x <= x_mid + 0.016) front-head vertices
    left_head_mask = (pos[:, 0] <= x_mid + 0.016) & (pos[:, 1] >= head_y0 - 0.03) & (pos[:, 2] >= 0.005)
    left_v_idx = np.flatnonzero(left_head_mask)
    left_pts = pos[left_v_idx].copy()
    left_pts[:, 2] *= 0.12
    left_tree = cKDTree(left_pts)
    left_uv = uv[left_v_idx]

    # Select all front-face vertices on viewer-right side (x > x_mid - 0.004) and build a 2D UV cKDTree
    # so EVERY covered 4K texel (even under sub-pixel eye triangles!) gets exact 3D coordinates with 0% missed texels!
    r_vert_mask = (
        (pos[:, 0] > x_mid - 0.004)
        & (pos[:, 1] > head_y0 - 0.01) & (pos[:, 1] < ymax - 0.01)
        & (pos[:, 2] > 0.010)
    )
    r_v_idx = np.flatnonzero(r_vert_mask)
    r_uv = np.mod(uv[r_v_idx], 1.0)
    r_pos = pos[r_v_idx]

    # Candidate 4K covered texels near viewer-right face (from the 1024x1024 3D position map upsampled to 4K!)
    cand_mask = (
        covered
        & (pos_full_x > x_mid - 0.004)
        & (pos_full_y > head_y0 - 0.01) & (pos_full_y < ymax - 0.01)
        & (pos_full_z > 0.010)
    )
    cy, cx = np.nonzero(cand_mask)
    out_img = delighted.copy()
    if len(cx) > 0 and len(r_v_idx) > 10:
        q_uv_r = np.stack([(cx + 0.5) / W, (cy + 0.5) / H], axis=-1).astype(np.float32)
        r_uv_tree = cKDTree(r_uv)
        rd, rnn = r_uv_tree.query(q_uv_r, k=3, workers=-1)
        # Only process texels truly belonging to the viewer-right face UV islands (within ~6 texels of a right-face vertex)
        valid = rd[:, 0] < (8.0 / W)
        if valid.any():
            cx, cy, rd, rnn = cx[valid], cy[valid], rd[valid], rnn[valid]
            rw = 1.0 / np.maximum(rd.astype(np.float32), 1e-6)
            rw /= rw.sum(axis=1, keepdims=True)
            p3_neighbors = r_pos[rnn]  # (N, 3, 3)
            p3_spread = np.abs(p3_neighbors - p3_neighbors[:, 0:1, :]).max(axis=(1, 2))
            all_p3 = np.where((p3_spread < 0.015)[:, None], (p3_neighbors * rw[..., None]).sum(axis=1), p3_neighbors[:, 0, :])

            # Smooth feather across nose midline, neck/crown, and side of head
            bx = np.clip((all_p3[:, 0] - (x_mid + 0.007)) / 0.011, 0.0, 1.0)
            bx = bx * bx * (3.0 - 2.0 * bx)
            by_bot = np.clip((all_p3[:, 1] - (head_y0 + 0.020)) / 0.045, 0.0, 1.0)
            by_top = np.clip(((ymax - 0.025) - all_p3[:, 1]) / 0.040, 0.0, 1.0)
            bz = np.clip((all_p3[:, 2] - 0.018) / 0.026, 0.0, 1.0)
            # Keep lips/mouth 100% original delighted (never double-mirror lip corners)
            lip_d = np.hypot((all_p3[:, 0] - x_mid) / 0.036, (all_p3[:, 1] - lip_y) / 0.018)
            not_lip = np.clip((lip_d - 0.85) / 0.35, 0.0, 1.0)
            not_lip = not_lip * not_lip * (3.0 - 2.0 * not_lip)
            blend = (bx * by_bot * by_top * bz * not_lip).astype(np.float32)
            keep = blend > 0.002
            if keep.any():
                kx, ky, kp, kb = cx[keep], cy[keep], all_p3[keep], blend[keep]
                d_eye = np.hypot((kp[:, 0] - rx_eye) / 0.030, (kp[:, 1] - ry_eye) / 0.024)
                ew = np.exp(-0.5 * d_eye * d_eye).astype(np.float32)
                mirror_p = kp.copy()
                mirror_p[:, 0] = (2.0 * x_mid - kp[:, 0]) + eye_dx * ew
                mirror_p[:, 1] = kp[:, 1] + eye_dy * ew
                mirror_p[:, 2] = kp[:, 2] * 0.12
                md, mnn = left_tree.query(mirror_p, k=3, workers=-1)
                mw = 1.0 / np.maximum(md.astype(np.float32), 1e-5)
                mw /= mw.sum(axis=1, keepdims=True)
                uv3 = left_uv[mnn]
                spread = np.abs(uv3 - uv3[:, 0:1, :]).max(axis=(1, 2))
                m_uv = np.where((spread < 0.02)[:, None], (uv3 * mw[..., None]).sum(axis=1), uv3[:, 0, :])
                mirrored_col = bilinear_sample(delighted, m_uv[:, 0], m_uv[:, 1])
                out_img[ky, kx] = delighted[ky, kx] * (1.0 - kb[:, None]) + mirrored_col * kb[:, None]

    # Gentle warm off-white cap inside BOTH eye openings so sclera is natural (~0.62 sRGB = ~0.34 linear), never chalky!
    sclera_cap = np.array([0.36, 0.34, 0.31], dtype=np.float32)[None, None, :]
    out_img = np.where(in_eye_pix[..., None], np.minimum(out_img, sclera_cap), out_img)
    return out_img


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('image', type=Path)
    parser.add_argument('mask', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--size', type=int, default=4096)
    parser.add_argument('--sample', type=int, default=2048)
    parser.add_argument('--sample-only', action='store_true')
    parser.add_argument('--glb', type=Path, default=None, help='Source fitted GLB for 3D-aware skin delighting & eye restoration')
    parser.add_argument('--preview-out', type=Path, default=None, help='Optional PNG preview path (exits early without BC7/ASTC encode)')
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
    if args.glb is not None:
        raw_glb = args.glb.read_bytes()
        jlen = struct.unpack_from('<I', raw_glb, 12)[0]
        g_hdr = json.loads(raw_glb[20:20 + jlen])
        if g_hdr.get('extras', {}).get('cleanPelt'):
            print(f'cleanPelt GLB ({args.glb.name}): skipping legacy Tripo delight/mirror pass')
        else:
            linear = delight_and_equalize_face(linear, covered, args.glb)
    filled = fill_outside(linear, covered)
    if args.preview_out is not None:
        args.preview_out.parent.mkdir(parents=True, exist_ok=True)
        rgb = np.round(np.clip(srgb_from_linear(filled), 0, 1) * 255).astype(np.uint8)
        Image.fromarray(rgb).save(args.preview_out)
        print(f'wrote preview {args.preview_out}')
        return

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
