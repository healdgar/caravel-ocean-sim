#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Extracts high-resolution 3D hair, coif, roach, and 1550 beard meshes from `.tripo/1550/*.glb`,
applies verified upright Y-yaw cranial alignment onto `REF_GROOM_HEAD`, trims stray behind-ear
scalp fragments on beard pieces, and registers all 3 beards directly to `assets/crew/sailor.glb`'s
measured philtrum (Y=1.575..1.593), mouth slit (Y=1.566), chin cup (Y=1.522), and jaw taper `jawRx(y)`.

Usage:
  python3 scripts/extract-groom-canonical.py /tmp/groom-canonical.json /tmp/groom-canonical.bin
  node scripts/prepare-groom-pack.mjs /tmp/groom-canonical.json /tmp/groom-canonical.bin assets/crew/groom-pack.glb
"""
import io, json, os, struct, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (piece_name, color_mode, upright_yaw_deg)
PIECES = [
    ('hair_1550_cropped', 'hair', 180),
    ('hair_1550_wavy', 'hair', 0),
    ('hair_1550_female_bun', 'hair', 180),
    ('hair_1550_coif_cap', 'paint', 0),
    ('hair_indigenous_long', 'hair', 0),
    ('hair_indigenous_plaits', 'hair_with_red_ties', 0),
    ('hair_algonquian_roach', 'roach', 90),
    ('beard_1550_pointed', 'hair', 0),
    ('beard_1550_full_mariner', 'hair', 0),
    ('beard_1550_tercio_strap', 'hair', 0),
]

YAW_MATS = {
    0:   np.array([[ 1.0, 0.0,  0.0], [0.0, 1.0, 0.0], [ 0.0, 0.0,  1.0]], dtype=np.float64),
    90:  np.array([[ 0.0, 0.0,  1.0], [0.0, 1.0, 0.0], [-1.0, 0.0,  0.0]], dtype=np.float64),
    180: np.array([[-1.0, 0.0,  0.0], [0.0, 1.0, 0.0], [ 0.0, 0.0, -1.0]], dtype=np.float64),
    270: np.array([[ 0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [ 1.0, 0.0,  0.0]], dtype=np.float64),
}

# Canonical cranial & initial facial bounding boxes on `sailor.glb` (`REF_GROOM_HEAD`)
REF_BOUNDS = {
    'hair_1550_coif_cap':      (np.array([-0.1124, 1.5072, -0.1635]), np.array([0.1142, 1.7889, 0.0955])),
    'hair_1550_cropped':       (np.array([-0.1186, 1.5171, -0.1589]), np.array([0.1167, 1.7747, 0.1061])),
    'hair_1550_female_bun':    (np.array([-0.1049, 1.5311, -0.1880]), np.array([0.1037, 1.7849, 0.0883])),
    'hair_1550_wavy':          (np.array([-0.1260, 1.4826, -0.1742]), np.array([0.1241, 1.7881, 0.1173])),
    'hair_algonquian_roach':   (np.array([-0.0396, 1.6309, -0.1512]), np.array([0.0438, 1.8457, 0.0935])),
    'hair_indigenous_long':    (np.array([-0.1244, 1.4279, -0.1643]), np.array([0.1210, 1.7887, 0.1092])),
    'hair_indigenous_plaits':  (np.array([-0.1608, 1.3546, -0.1584]), np.array([0.1653, 1.7785, 0.1298])),
    'beard_1550_full_mariner': (np.array([-0.0880, 1.4600, -0.0160]), np.array([0.0880, 1.6160, 0.0980])),
    'beard_1550_pointed':      (np.array([-0.0830, 1.4850, -0.0120]), np.array([0.0830, 1.6080, 0.0880])),
    'beard_1550_tercio_strap': (np.array([-0.0840, 1.5050, -0.0150]), np.array([0.0840, 1.5960, 0.0820])),
}

# Measured normalized [0..1] vertical feature knots in each raw Tripo beard mesh:
# (chin_tuft_top_u, moust_bot_u, moust_top_u) -> mapped onto sailor.glb's mouth opening & philtrum!
BEARD_RAW_U_KNOTS = {
    'beard_1550_pointed':      (0.45, 0.75, 0.88),
    'beard_1550_full_mariner': (0.45, 0.56, 0.75),
    'beard_1550_tercio_strap': (0.45, 0.83, 0.98),
}


def read_glb(path):
    data = open(path, 'rb').read()
    n = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + n])
    return doc, data[28 + n:28 + n + doc['buffers'][0]['byteLength']]


def acc(doc, bin_, index):
    tmap = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
    smap = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
    a = doc['accessors'][index]
    v = doc['bufferViews'][a['bufferView']]
    dt = tmap[a['componentType']]
    sz = smap[a['type']]
    off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = v.get('byteStride') or sz * dt().itemsize
    raw = np.frombuffer(bin_, dtype=np.uint8, count=stride * a['count'], offset=off).tobytes()
    out = np.column_stack([
        np.ndarray((a['count'],), dtype=dt, buffer=raw, offset=k * dt().itemsize, strides=(stride,))
        for k in range(sz)
    ])
    if a.get('normalized') and dt is not np.float32:
        out = out.astype(np.float32) / np.iinfo(dt).max
    return out


def srgb_to_linear(srgb):
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4).astype(np.float32)


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
    return (
        pixels[y0, x0] * (1 - fx) * (1 - fy)
        + pixels[y0, x1] * fx * (1 - fy)
        + pixels[y1, x0] * (1 - fx) * fy
        + pixels[y1, x1] * fx * fy
    ).astype(np.float32)


def decimate_grid_cluster(pos, col, faces, cell_size):
    q = np.floor(pos / cell_size).astype(np.int64)
    _, _, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
    inv = inv.ravel()
    num_c = int(inv.max()) + 1
    out_p = np.zeros((num_c, 3), dtype=np.float64)
    out_c = np.zeros((num_c, 3), dtype=np.float64)
    cnt = np.zeros(num_c, dtype=np.float64)
    np.add.at(out_p, inv, pos)
    np.add.at(out_c, inv, col)
    np.add.at(cnt, inv, 1.0)
    out_p /= cnt[:, None]
    out_c /= cnt[:, None]
    f_m = inv[faces]
    keep = (f_m[:, 0] != f_m[:, 1]) & (f_m[:, 1] != f_m[:, 2]) & (f_m[:, 0] != f_m[:, 2])
    return out_p.astype(np.float32), out_c.astype(np.float32), f_m[keep].astype(np.uint32)


def measure_sailor_face_envelope(sailor_path):
    doc, b = read_glb(sailor_path)
    p = doc['meshes'][0]['primitives'][0]
    P = acc(doc, b, p['attributes']['POSITION']).astype(np.float64)
    J = acc(doc, b, p['attributes']['JOINTS_0']).astype(np.int64)
    W = acc(doc, b, p['attributes']['WEIGHTS_0']).astype(np.float64)
    jnames = [doc['nodes'][j]['name'] for j in doc['skins'][0]['joints']]
    hs = jnames.index('Head')
    hw = (W * (J == hs)).sum(axis=1)
    hv = P[hw > 0.45]

    ys = np.linspace(1.505, 1.630, 51)
    jaw_rx = np.zeros_like(ys)
    front_z = np.zeros_like(ys)
    for i, y0 in enumerate(ys):
        band_w = hv[(np.abs(hv[:, 1] - y0) < 0.010) & (hv[:, 2] > -0.015)]
        jaw_rx[i] = float(np.percentile(np.abs(band_w[:, 0]), 96)) if len(band_w) >= 4 else 0.058
        band_c = hv[(np.abs(hv[:, 1] - y0) < 0.008) & (np.abs(hv[:, 0]) < 0.022)]
        front_z[i] = float(np.percentile(band_c[:, 2], 96)) if len(band_c) >= 3 else 0.092
    jaw_rx = np.convolve(np.pad(jaw_rx, 2, mode='edge'), [0.15, 0.2, 0.3, 0.2, 0.15], mode='valid')
    front_z = np.convolve(np.pad(front_z, 1, mode='edge'), [0.25, 0.5, 0.25], mode='valid')
    return ys, jaw_rx, front_z


def register_beard_to_sailor_face(name, raw_p_upright, ys_prof, jaw_rx_prof, front_z_prof):
    """Maps upright raw Tripo beard coordinates directly onto `sailor.glb`'s anatomical face landmarks."""
    p = raw_p_upright.astype(np.float64).copy()
    mn = p.min(0)
    mx = p.max(0)
    u_y = (p[:, 1] - mn[1]) / max(mx[1] - mn[1], 1e-8)

    # 1. Exact piecewise-linear vertical registration onto `sailor.glb`:
    #    Mouth slit = 1.566, Lower-lip beard top = 1.557, Philtrum moustache = [1.575 .. 1.592] (right below nose base 1.595)
    u_chin, u_mbot, u_mtop = BEARD_RAW_U_KNOTS[name]
    tgt_bottom = {
        'beard_1550_full_mariner': 1.478,
        'beard_1550_pointed':      1.502,
        'beard_1550_tercio_strap': 1.515,
    }[name]
    tgt_top = {
        'beard_1550_full_mariner': 1.616,
        'beard_1550_pointed':      1.608,
        'beard_1550_tercio_strap': 1.596,
    }[name]
    src_u = np.array([0.0, u_chin, u_mbot, u_mtop, 1.0], dtype=np.float64)
    tgt_y = np.array([tgt_bottom, 1.557, 1.575, 1.592, tgt_top], dtype=np.float64)
    out_y = np.interp(u_y, src_u, tgt_y)

    # 2. Initial centered X & Z scaling into canonical facial depth/width
    b_min, b_max = REF_BOUNDS[name]
    cx = 0.5 * (mn[0] + mx[0])
    half_span_x = max(0.5 * (mx[0] - mn[0]), 1e-6)
    out_x = (p[:, 0] - cx) / half_span_x * (0.5 * (b_max[0] - b_min[0]))
    out_z = b_min[2] + (p[:, 2] - mn[2]) / max(mx[2] - mn[2], 1e-6) * (b_max[2] - b_min[2])

    out = np.column_stack([out_x, out_y, out_z])

    # 3. Conform outer cheek/jaw U-shell width `X` to `sailor.glb`'s tapered `jawRx(y)` contour
    y_bands = np.linspace(tgt_bottom, tgt_top, 24)
    beard_rx = np.zeros_like(y_bands)
    for bi, yb in enumerate(y_bands):
        bpts = out[np.abs(out[:, 1] - yb) < 0.010]
        beard_rx[bi] = float(np.percentile(np.abs(bpts[:, 0]), 96)) if len(bpts) >= 4 else 0.075
    beard_rx = np.maximum(np.convolve(np.pad(beard_rx, 1, mode='edge'), [0.25, 0.5, 0.25], mode='valid'), 0.025)

    target_jaw_at_v = np.interp(np.clip(out[:, 1], ys_prof[0], ys_prof[-1]), ys_prof, jaw_rx_prof)
    cur_rx_at_v = np.interp(out[:, 1], y_bands, beard_rx)
    hair_pad = {
        'beard_1550_full_mariner': 0.0085,
        'beard_1550_pointed':      0.0055,
        'beard_1550_tercio_strap': 0.0045,
    }[name]
    desired_rx = target_jaw_at_v + hair_pad
    x_ratio = np.clip(desired_rx / np.maximum(cur_rx_at_v, 0.025), 0.55, 1.05)
    lat_blend = np.clip((np.abs(out[:, 0]) - 0.016) / 0.030, 0.0, 1.0)
    out[:, 0] *= (1.0 * (1.0 - lat_blend) + x_ratio * lat_blend)

    # 4. Anchor moustache front/back depth flush onto philtrum skin (`Z ~ 0.098 m` on sailor.glb)
    moust_band = (out[:, 1] >= 1.575) & (out[:, 1] <= 1.592) & (np.abs(out[:, 0]) < 0.022) & (out[:, 2] > 0.03)
    cur_moust_front_z = float(np.percentile(out[moust_band, 2], 92)) if np.any(moust_band) else float(np.percentile(out[:, 2], 94))
    philtrum_skin_z = float(np.interp(1.584, ys_prof, front_z_prof))
    tgt_front_z = philtrum_skin_z + (0.009 if name == 'beard_1550_full_mariner' else 0.007)
    out[:, 2] += (tgt_front_z - cur_moust_front_z)

    # Tuck rear sideburn edges gently inward onto pre-auricular cheeks
    sideburn = (out[:, 1] > 1.535) & (np.abs(out[:, 0]) > 0.035) & (out[:, 2] < 0.050)
    if np.any(sideburn):
        out[sideburn, 0] *= 0.94

    return out.astype(np.float32)


def main():
    if len(sys.argv) < 3:
        raise SystemExit('Usage: python3 scripts/extract-groom-canonical.py <out.json> <out.bin>')
    out_json, out_bin = sys.argv[1], sys.argv[2]

    sailor_path = os.path.join(ROOT, 'assets', 'crew', 'sailor.glb')
    ys_prof, jaw_rx_prof, front_z_prof = measure_sailor_face_envelope(sailor_path)

    manifest = []
    chunks = []
    cursor = 0

    def append_chunk(arr):
        nonlocal cursor
        b = arr.tobytes()
        pad = (4 - (len(b) % 4)) % 4
        off = cursor
        chunks.append(b)
        if pad:
            chunks.append(b'\0' * pad)
        cursor += len(b) + pad
        return [off, len(b)]

    for name, mode, yaw_deg in PIECES:
        src_path = os.path.join(ROOT, '.tripo', '1550', f'{name}.glb')
        doc, bin_ = read_glb(src_path)
        prim = doc['meshes'][0]['primitives'][0]
        raw_p = acc(doc, bin_, prim['attributes']['POSITION']).astype(np.float64)
        raw_uv = acc(doc, bin_, prim['attributes']['TEXCOORD_0']).astype(np.float64)
        faces = acc(doc, bin_, prim['indices']).astype(np.uint32).reshape(-1, 3)

        mat = doc['materials'][prim.get('material', 0)]
        tex_info = mat.get('pbrMetallicRoughness', {}).get('baseColorTexture', {'index': 0})
        img_idx = doc['textures'][tex_info['index']]['source']
        img_view = doc['bufferViews'][doc['images'][img_idx]['bufferView']]
        img_bytes = bin_[img_view.get('byteOffset', 0):img_view.get('byteOffset', 0) + img_view['byteLength']]
        img = Image.open(io.BytesIO(img_bytes)).convert('RGB')
        pixels = np.asarray(img, dtype=np.float32) / 255.0
        lin_col = srgb_to_linear(bilinear_sample(pixels, raw_uv))

        R = YAW_MATS[yaw_deg]
        rot_p = raw_p @ R.T

        if name.startswith('beard_'):
            # Trim stray rear-cranium hair fragments behind the ear plane (`z < z_min + 0.34 * z_span`,
            # or upper-center scalp bridge above moustache with `|x| < 0.08` and `u_y > 0.86` on pointed beard)
            z_lo, z_hi = float(rot_p[:, 2].min()), float(rot_p[:, 2].max())
            y_lo, y_hi = float(rot_p[:, 1].min()), float(rot_p[:, 1].max())
            u_y_vert = (rot_p[:, 1] - y_lo) / max(y_hi - y_lo, 1e-8)
            valid_v = rot_p[:, 2] >= (z_lo + (0.36 if name == 'beard_1550_pointed' else 0.08) * (z_hi - z_lo))
            if name == 'beard_1550_pointed':
                valid_v &= ~((u_y_vert > 0.87) & (np.abs(rot_p[:, 0]) < 0.12))
            tri_keep = valid_v[faces[:, 0]] & valid_v[faces[:, 1]] & valid_v[faces[:, 2]]
            faces = faces[tri_keep]
            used_v = np.unique(faces.ravel())
            remap_v = np.full(len(rot_p), -1, dtype=np.int64)
            remap_v[used_v] = np.arange(len(used_v))
            rot_p = rot_p[used_v]
            lin_col = lin_col[used_v]
            faces = remap_v[faces].astype(np.uint32)

        if len(rot_p) > 60_000:
            diag = float(np.linalg.norm(rot_p.max(0) - rot_p.min(0)))
            rot_p_f, lin_col, faces = decimate_grid_cluster(rot_p, lin_col, faces, diag * 0.0042)
            rot_p = rot_p_f.astype(np.float64)

        if name.startswith('beard_'):
            aligned_p = register_beard_to_sailor_face(name, rot_p, ys_prof, jaw_rx_prof, front_z_prof)
        else:
            b_min, b_max = REF_BOUNDS[name]
            mn, mx = rot_p.min(0), rot_p.max(0)
            aligned_p = (b_min + (rot_p - mn) / np.maximum(mx - mn, 1e-8) * (b_max - b_min)).astype(np.float64)
            # Strip Tripo's watertight inner skull-cavity walls and front-face / under-jaw closing plugs
            # so hair caps never poke through eyes, cheeks, noses, or throats!
            p0 = aligned_p[faces[:, 0]]
            p1 = aligned_p[faces[:, 1]]
            p2 = aligned_p[faces[:, 2]]
            tc = (p0 + p1 + p2) / 3.0
            tn = np.cross(p1 - p0, p2 - p0)
            rel_c = tc - np.array([0.0, 1.635, -0.018], dtype=np.float64)
            ellip_r2 = (rel_c[:, 0] / 0.092) ** 2 + (rel_c[:, 1] / 0.115) ** 2 + (rel_c[:, 2] / 0.106) ** 2
            inward_cavity = (ellip_r2 < 0.92) & ((tn * rel_c).sum(axis=1) < -1e-8)
            if name == 'hair_algonquian_roach':
                face_plug = (tc[:, 2] > 0.015) & (tc[:, 1] < 1.695) & (np.abs(tc[:, 0]) < 0.068)
            elif name == 'hair_1550_coif_cap':
                face_plug = (tc[:, 2] > 0.018) & (tc[:, 1] < 1.685) & (np.abs(tc[:, 0]) < 0.062)
            else:
                face_plug = (
                    ((tc[:, 2] > 0.012) & (tc[:, 1] < 1.688) & (np.abs(tc[:, 0]) < 0.065))
                    | ((tc[:, 1] < 1.608) & (tc[:, 2] > -0.042) & (np.abs(tc[:, 0]) < 0.072))
                )
            keep_tri = ~(inward_cavity | face_plug)
            faces = faces[keep_tri]
            used_v = np.unique(faces.ravel())
            remap_v = np.full(len(aligned_p), -1, dtype=np.int64)
            remap_v[used_v] = np.arange(len(used_v))
            aligned_p = aligned_p[used_v].astype(np.float32)
            lin_col = lin_col[used_v]
            faces = remap_v[faces].astype(np.uint32)

        v_span = append_chunk(aligned_p.astype(np.float32).ravel())
        c_span = append_chunk(lin_col.astype(np.float32).ravel())
        f_span = append_chunk(faces.astype(np.uint32).ravel())
        manifest.append({
            'name': name,
            'mode': mode,
            'v': v_span,
            'c': c_span,
            'f': f_span,
        })
        print(f'{name.ljust(26)}: verts={len(aligned_p):6d} tris={len(faces):6d} bounds={aligned_p.min(0).round(4)}..{aligned_p.max(0).round(4)}')

    with open(out_json, 'w', encoding='utf-8') as jf:
        json.dump(manifest, jf, indent=2)
    with open(out_bin, 'wb') as bf:
        for ch in chunks:
            bf.write(ch)
    print(f'Wrote {out_json} and {out_bin} ({cursor // 1024} KB)')


if __name__ == '__main__':
    main()
