#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Bakes high-detail organic 16th-century livestock & horse tack meshes plus
Rule-3 progressive half-edge collapse continuum tables into assets/wildlife/livestock-1550.bin.

Supports two input paths per species (0=sheep, 1=cattle, 2=swine, 3=horse):
  1. Tripo 3D H3.1 4K GLBs cached under .tripo/livestock/<species>/**/*.glb:
     - Samples 4096x4096 basecolor textures (sRGB -> linear -> gamma-2.0 RGB555)
     - Strips twin sheep duplicate on X > 0
     - Welds UV seams BEFORE decimation for a 100% crack-free closed manifold
     - Aligns horizontal fore-aft yaw via lower-body/hoof PCA (ignoring wide horns & head turns)
     - Measures exact barrel/hoof rig joints & fits 1550 Iberian `sela à gineta` saddle & tack directly to the horse mesh
  2. Seamless Blender 5.2 voxel-remeshed + Laplacian-smoothed fallback volumes.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/bake-livestock-meshes.py -- [--from-tripo .tripo/livestock]
"""
import os
import sys
import glob
import math
import heapq
import struct
from collections import deque
import numpy as np
import bpy
import bmesh
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_BIN = os.path.join(ROOT, "assets", "wildlife", "livestock-1550.bin")
OUT_TEX_DIR = os.path.join(ROOT, "assets", "animal-continuum")

# Coordinate convention exported to Waterworld:
#   X = right, Y = up (0 at ground), Z = forward (+Z is nose/poll, -Z is rump/tail).


def parse_cli():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    tripo_dir = os.path.join(ROOT, ".tripo", "livestock")
    for i, a in enumerate(args):
        if a == "--from-tripo" and i + 1 < len(args):
            tripo_dir = args[i + 1]
    return tripo_dir


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def ao_shade(y, max_y, ny):
    h = max(0.0, min(1.0, y / max(0.1, max_y)))
    up = max(0.0, min(1.0, 0.5 + 0.5 * ny))
    return max(0.08, min(0.95, 0.34 + 0.36 * h + 0.25 * up))


def pack_rgb555(r_lin, g_lin, b_lin):
    """Packs linear RGB [0..1] into positive 15-bit gamma-2.0 RGB555 int16 (1..32767)."""
    r5 = int(round(math.sqrt(max(0.0, min(1.0, float(r_lin)))) * 31.0))
    g5 = int(round(math.sqrt(max(0.0, min(1.0, float(g_lin)))) * 31.0))
    b5 = int(round(math.sqrt(max(0.0, min(1.0, float(b_lin)))) * 31.0))
    return max(1, min(32767, (r5 << 10) | (g5 << 5) | b5))


def pack_tack_coat(zone, ao):
    """Packs horse tack zone (4=leather, 5=iron, 6=cloth) + AO into negative int16."""
    val = float(zone) + max(0.08, min(0.98, float(ao)))
    return -max(1, min(32767, int(round(val * 1000.0))))


def build_spine_loft(bm, stations, segs=28, wool_ripple=0.0, anatomical_ribs=0.0):
    n = len(stations)
    rings = []
    side = Vector((1.0, 0.0, 0.0))
    for i, st in enumerate(stations):
        yc, zc, rx, r_up, r_dn = st[:5]
        belly_round = st[5] if len(st) > 5 else 1.0
        p = Vector((0.0, yc, zc))
        if i == 0:
            tan = Vector((0.0, stations[1][0] - yc, stations[1][1] - zc))
        elif i == n - 1:
            tan = Vector((0.0, yc - stations[i - 1][0], zc - stations[i - 1][1]))
        else:
            tan = Vector((0.0, stations[i + 1][0] - stations[i - 1][0], stations[i + 1][1] - stations[i - 1][1]))
        tan = tan.normalized() if tan.length > 1e-6 else Vector((0.0, 0.0, 1.0))
        dorsal = tan.cross(side).normalized()
        ring = []
        for s in range(segs):
            a = (s / segs) * 2.0 * math.pi
            ca = math.cos(a)
            sa = math.sin(a)
            ry = r_up if sa >= 0.0 else r_dn
            spine_dip = -0.035 * max(0.0, sa) ** 6 if zc < 0.35 else 0.0
            w_mod = 1.0 + (0.09 * (ca * ca) * (sa * sa)) * belly_round + spine_dip
            if wool_ripple > 0.0 and zc < 0.38:
                w_mod += wool_ripple * (0.65 * math.cos(7.0 * a + zc * 19.0) + 0.35 * math.sin(11.0 * a - zc * 27.0))
            if anatomical_ribs > 0.0 and -0.22 < zc < 0.30 and abs(ca) > 0.55 and sa < 0.35:
                w_mod += anatomical_ribs * math.sin(zc * 42.0) * (abs(ca) - 0.55)
            pt = p + side * (ca * rx * w_mod) + dorsal * (sa * ry * w_mod)
            ring.append(bm.verts.new(pt))
        rings.append(ring)

    for i in range(n - 1):
        r0, r1 = rings[i], rings[i + 1]
        for s in range(segs):
            sn = (s + 1) % segs
            bm.faces.new([r0[s], r0[sn], r1[sn], r1[s]])

    c0 = bm.verts.new(Vector((0.0, stations[0][0], stations[0][1] - 0.022)))
    for s in range(segs):
        sn = (s + 1) % segs
        bm.faces.new([c0, rings[0][sn], rings[0][s]])

    c1 = bm.verts.new(Vector((0.0, stations[-1][0], stations[-1][1] + 0.015)))
    for s in range(segs):
        sn = (s + 1) % segs
        bm.faces.new([c1, rings[-1][s], rings[-1][sn]])


def add_tapered_tube(bm, points, radii, segs=16, cap_start=True, cap_end=True, scale_xz=(1.0, 1.0), cloven=False):
    rings = []
    n = len(points)
    for i, (pt, rad) in enumerate(zip(points, radii)):
        p = Vector(pt)
        if i == 0:
            tangent = (Vector(points[1]) - p).normalized()
        elif i == n - 1:
            tangent = (p - Vector(points[i - 1])).normalized()
        else:
            tangent = (Vector(points[i + 1]) - Vector(points[i - 1])).normalized()
        ref = Vector((0, 0, 1)) if abs(tangent.z) < 0.9 else Vector((1, 0, 0))
        side = tangent.cross(ref).normalized()
        perp = side.cross(tangent).normalized()
        ring = []
        rx = rad[0] if isinstance(rad, (tuple, list)) else rad * scale_xz[0]
        rz = rad[1] if isinstance(rad, (tuple, list)) else rad * scale_xz[1]
        is_hoof = (i >= n - 2) and cloven
        for s in range(segs):
            a = (s / segs) * 2.0 * math.pi
            ca, sa = math.cos(a), math.sin(a)
            cleft = 0.72 if (is_hoof and abs(ca) < 0.22 and sa > 0.1) else 1.0
            v = bm.verts.new(p + side * (ca * rx * cleft) + perp * (sa * rz * cleft))
            ring.append(v)
        rings.append(ring)
    for i in range(n - 1):
        r0, r1 = rings[i], rings[i + 1]
        for s in range(segs):
            sn = (s + 1) % segs
            bm.faces.new([r0[s], r0[sn], r1[sn], r1[s]])
    if cap_start:
        c0 = bm.verts.new(Vector(points[0]))
        for s in range(segs):
            sn = (s + 1) % segs
            bm.faces.new([c0, rings[0][sn], rings[0][s]])
    if cap_end:
        c1 = bm.verts.new(Vector(points[-1]))
        for s in range(segs):
            sn = (s + 1) % segs
            bm.faces.new([c1, rings[-1][s], rings[-1][sn]])


def add_ellipsoid(bm, center, radii, rot_euler=(0.0, 0.0, 0.0), u_segs=16, v_segs=10):
    res = bmesh.ops.create_uvsphere(bm, u_segments=u_segs, v_segments=v_segs, radius=1.0)
    verts = res["verts"]
    cx, cy, cz = center
    rx, ry, rz = radii
    ex, ey, ez = rot_euler
    cx_r, sx_r = math.cos(ex), math.sin(ex)
    cy_r, sy_r = math.cos(ey), math.sin(ey)
    cz_r, sz_r = math.cos(ez), math.sin(ez)
    for v in verts:
        x, y, z = v.co.x * rx, v.co.y * ry, v.co.z * rz
        y, z = y * cx_r - z * sx_r, y * sx_r + z * cx_r
        x, z = x * cy_r + z * sy_r, -x * sy_r + z * cy_r
        x, y = x * cz_r - y * sz_r, x * sz_r + y * cz_r
        v.co = Vector((cx + x, cy + y, cz + z))


def voxel_unify_and_decimate(bm, name, voxel_size, target_faces, smooth_iters=3):
    """Fallback procedural sculpt -> watertight manifold."""
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(name + "_raw")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    rem = obj.modifiers.new(name="VoxelUnify", type="REMESH")
    rem.mode = "VOXEL"
    rem.voxel_size = voxel_size
    rem.adaptivity = 0.0015
    bpy.ops.object.modifier_apply(modifier=rem.name)

    if smooth_iters > 0:
        sm = obj.modifiers.new(name="OrganicSmooth", type="SMOOTH")
        sm.factor = 0.42
        sm.iterations = smooth_iters
        bpy.ops.object.modifier_apply(modifier=sm.name)

    cur_faces = len(obj.data.polygons)
    if cur_faces > target_faces:
        dec = obj.modifiers.new(name="TargetPoly", type="DECIMATE")
        dec.decimate_type = "COLLAPSE"
        dec.ratio = max(0.05, min(1.0, target_faces / float(cur_faces)))
        dec.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=dec.name)

    out_bm = bmesh.new()
    out_bm.from_mesh(obj.data)
    bmesh.ops.triangulate(out_bm, faces=out_bm.faces[:])
    min_y = min((v.co.y for v in out_bm.verts), default=0.0)
    if abs(min_y) > 1e-5:
        for v in out_bm.verts:
            v.co.y -= min_y
    bmesh.ops.recalc_face_normals(out_bm, faces=out_bm.faces[:])
    out_bm.verts.ensure_lookup_table()
    out_bm.faces.ensure_lookup_table()
    out_bm.normal_update()
    bpy.data.objects.remove(obj, do_unlink=True)
    return out_bm


def extract_part_records(bm, part_code, coat_fn):
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.normal_update()
    uv_layer = bm.loops.layers.uv.active
    verts = []
    indices = []
    # Keep smooth vertex normals across UV seams while splitting vertices ONLY where adjacent
    # face loops carry distinct (u, v) coordinates so texture mapping is 100% crack-free.
    vert_map = {}

    def get_corner(loop):
        v = loop.vert
        if uv_layer is not None:
            uv = loop[uv_layer].uv
            u_gpu = max(0.0, min(1.0, float(uv.x)))
            v_bl = max(0.0, min(1.0, float(uv.y)))
            v_gpu = 1.0 - v_bl
            key = (v.index, int(round(u_gpu * 4095.0)), int(round(v_gpu * 4095.0)))
        else:
            u_gpu, v_gpu = 0.0, 0.0
            key = (v.index, 0, 0)
        idx = vert_map.get(key)
        if idx is None:
            p = v.co
            n = v.normal.normalized() if v.normal.length > 1e-6 else Vector((0, 1, 0))
            part_val = part_code(p) if callable(part_code) else float(part_code)
            coat_val = coat_fn(v.index, p, n)
            idx = len(verts)
            verts.append((p.x, p.y, p.z, n.x, n.y, n.z, part_val, coat_val, u_gpu, v_gpu))
            vert_map[key] = idx
        return idx

    for f in bm.faces:
        l0, l1, l2 = f.loops[0], f.loops[1], f.loops[2]
        v0, v1, v2 = l0.vert, l1.vert, l2.vert
        fn = (v1.co - v0.co).cross(v2.co - v0.co)
        avg_n = v0.normal + v1.normal + v2.normal
        if avg_n.length < 1e-6:
            avg_n = fn
        i0, i1, i2 = get_corner(l0), get_corner(l1), get_corner(l2)
        if fn.dot(avg_n) < 0:
            indices.extend([i0, i2, i1])
        else:
            indices.extend([i0, i1, i2])
    return verts, indices


def merge_parts(parts):
    all_verts, all_idx, base = [], [], 0
    for v, idx in parts:
        all_verts.extend(v)
        all_idx.extend([i + base for i in idx])
        base += len(v)
    return all_verts, all_idx


def measure_quadruped_rig(bm, height):
    """Measures exact (front_z, back_z, belly_min_y, leg_top_y, tail_z, neck_pivot, neck_max_span, base_y_neck)
    directly from the aligned & scaled quadruped BMesh.
    """
    pts = [v.co for v in bm.verts]
    min_z = min(p.z for p in pts)
    max_z = max(p.z for p in pts)
    body_len = max(0.2, max_z - min_z)

    hoof_y = 0.06 * height
    fore_hooves = [p.z for p in pts if p.y < hoof_y and p.z >= 0.0]
    hind_hooves = [p.z for p in pts if p.y < hoof_y and p.z < 0.0]
    front_z = float(np.median(fore_hooves)) if fore_hooves else 0.28 * body_len
    back_z = float(np.median(hind_hooves)) if hind_hooves else -0.28 * body_len

    barrel_ys = [
        p.y for p in pts
        if abs(p.x) < 0.08 * height and abs(p.z) < 0.14 * body_len and p.y > 0.18 * height
    ]
    belly_min_y = float(np.percentile(barrel_ys, 2)) if barrel_ys else 0.36 * height
    leg_top_y = belly_min_y - 0.015
    leg_y = belly_min_y + 0.015
    tail_z = back_z - 0.12 * height

    neck_z = front_z + 0.03 * height
    # Measure neck base height just ahead of forelegs
    neck_slice = [p.y for p in pts if abs(p.z - neck_z) < 0.05 * height and p.y > belly_min_y]
    if neck_slice:
        n_lo, n_hi = float(np.percentile(neck_slice, 10)), float(np.percentile(neck_slice, 90))
        neck_piv_y = n_lo + 0.48 * (n_hi - n_lo)
        base_y_neck = max(belly_min_y + 0.03, n_lo + 0.18 * (n_hi - n_lo))
    else:
        neck_piv_y = 0.62 * height
        base_y_neck = 0.50 * height
    neck_max_span = max(0.15, max_z - neck_z)

    return {
        "neckPivot": (0.0, round(neck_piv_y, 4), round(neck_z, 4)),
        "legY": round(leg_y, 4),
        "frontZ": round(front_z, 4),
        "backZ": round(back_z, 4),
        "belly_min_y": belly_min_y,
        "leg_top_y": leg_top_y,
        "tail_z": tail_z,
        "neck_z": neck_z,
        "neck_max_span": neck_max_span,
        "base_y_neck": base_y_neck,
        "height": height,
    }


def classify_quadruped_part(p, rig):
    height = rig["height"]
    tail_z = rig["tail_z"]
    leg_top_y = rig["leg_top_y"]
    front_z = rig["front_z"] if "front_z" in rig else rig["frontZ"]
    back_z = rig["back_z"] if "back_z" in rig else rig["backZ"]
    neck_z = rig["neck_z"]
    neck_max_span = rig["neck_max_span"]
    base_y_neck = rig["base_y_neck"]

    # 1. Tail FIRST so long hanging tails (horse/cattle) never split into hind legs!
    if p.z < tail_z and p.y > 0.075 * height:
        return 6.0
    # 2. Four legs below belly_min_y - 0.015 (including inner hoof walls down to |x| = 0!)
    if p.y < leg_top_y and p.z >= tail_z:
        is_front = p.z >= 0.5 * (front_z + back_z)
        is_right = p.x >= 0.0
        if is_front:
            return 3.0 if is_right else 2.0
        return 5.0 if is_right else 4.0
    # 3. Weighted neck & head grazing/alarm pivot
    if p.z > neck_z and p.y > base_y_neck:
        w = max(
            0.02,
            min(
                0.98,
                (p.z - neck_z) / max(0.15, neck_max_span) * 0.68
                + max(0.0, p.y - base_y_neck) / max(0.20, 0.35 * height) * 0.32,
            ),
        )
        return 1.0 + w
    return 0.0


def find_tripo_glb(tripo_dir, species_name):
    sp_dir = os.path.join(tripo_dir, species_name)
    if not os.path.isdir(sp_dir):
        return None
    glbs = sorted(glob.glob(os.path.join(sp_dir, "**", "*.glb"), recursive=True))
    return glbs[-1] if glbs else None


def sample_image_to_point_attribute(me, img):
    """Samples an sRGB/linear Blender Image through `me.uv_layers.active` onto a POINT
    FLOAT_COLOR attribute `BakeCoat` (linear RGB) so FAR and SPLAT match CLUSTER 1:1.
    """
    if img is None or not me.uv_layers.active:
        return False
    w, h, ch = img.size[0], img.size[1], img.channels
    px = np.empty(w * h * ch, dtype=np.float32)
    img.pixels.foreach_get(px)
    tex = px.reshape(h, w, ch)[:, :, :3]
    if not img.is_float and img.colorspace_settings.name.lower() == "srgb":
        tex = np.where(tex <= 0.04045, tex / 12.92, np.power((tex + 0.055) / 1.055, 2.4)).astype(np.float32)

    n_loops = len(me.loops)
    n_verts = len(me.vertices)
    uvs = np.empty(n_loops * 2, dtype=np.float32)
    me.uv_layers.active.data.foreach_get("uv", uvs)
    uvs = uvs.reshape(-1, 2)
    l_verts = np.empty(n_loops, dtype=np.int32)
    me.loops.foreach_get("vertex_index", l_verts)

    gx = np.clip(uvs[:, 0], 0.0, 1.0) * (w - 1)
    gy = np.clip(uvs[:, 1], 0.0, 1.0) * (h - 1)
    x0 = np.floor(gx).astype(np.int32)
    y0 = np.floor(gy).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (gx - x0)[:, None]
    fy = (gy - y0)[:, None]
    samp = (tex[y0, x0] * (1.0 - fx) + tex[y0, x1] * fx) * (1.0 - fy) + (tex[y1, x0] * (1.0 - fx) + tex[y1, x1] * fx) * fy

    cnt = np.maximum(np.bincount(l_verts, minlength=n_verts), 1).astype(np.float32)
    rgba = np.ones((n_verts, 4), dtype=np.float32)
    for c in range(3):
        rgba[:, c] = np.bincount(l_verts, weights=samp[:, c], minlength=n_verts) / cnt

    attr = me.color_attributes.get("BakeCoat")
    if attr is None:
        attr = me.color_attributes.new(name="BakeCoat", type="FLOAT_COLOR", domain="POINT")
    attr.data.foreach_set("color", rgba.ravel())
    return True


def align_points_waterworld(pts_bl, height):
    """Converts Blender (x, y, z) -> Waterworld (x, z, -y), aligns +Z forward via lower-body/hoof PCA,
    scales to exact metric height, centers X/Z symmetrically, and grounds hooves at Y = 0.
    Returns (aligned_float32_nx3, scale_factor).
    """
    pts = np.column_stack([pts_bl[:, 0], pts_bl[:, 2], -pts_bl[:, 1]]).astype(np.float64)
    min_y, max_y = float(pts[:, 1].min()), float(pts[:, 1].max())
    span_y = max(0.05, max_y - min_y)

    low_mask = pts[:, 1] < (min_y + 0.55 * span_y)
    low_pts = pts[low_mask] if np.any(low_mask) else pts
    xz = low_pts[:, [0, 2]] - low_pts[:, [0, 2]].mean(axis=0)
    _, evecs = np.linalg.eigh((xz.T @ xz) / max(1, len(xz)))
    fw = evecs[:, 1]  # principal horizontal body axis (unit vector in XZ)

    # Orient +Z toward taller head/poll end
    proj = pts[:, 0] * fw[0] + pts[:, 2] * fw[1]
    mid_proj = 0.5 * (float(proj.min()) + float(proj.max()))
    if float(pts[proj < mid_proj, 1].max()) > float(pts[proj >= mid_proj, 1].max()):
        fw = -fw

    # Right-handed horizontal basis: Y=(0,1,0), Z=(fw[0], 0, fw[1]), X = Y x Z = (fw[1], 0, -fw[0])
    rt = np.array([fw[1], -fw[0]], dtype=np.float64)
    scale = height / span_y
    wx = (pts[:, 0] * rt[0] + pts[:, 2] * rt[1]) * scale
    wy = (pts[:, 1] - min_y) * scale
    wz = (pts[:, 0] * fw[0] + pts[:, 2] * fw[1]) * scale

    # Center X on mid-barrel + hooves, center Z on 4 hooves, ground hooves at Y = 0
    hoof_m = wy < 0.06 * height
    med_z = float(np.median(wz[hoof_m])) if np.any(hoof_m) else 0.5 * (float(wz.min()) + float(wz.max()))
    fore_m = hoof_m & (wz >= med_z)
    hind_m = hoof_m & (wz < med_z)
    cz = 0.5 * (
        (float(np.median(wz[fore_m])) if np.any(fore_m) else float(wz.max()))
        + (float(np.median(wz[hind_m])) if np.any(hind_m) else float(wz.min()))
    )
    body_span_z = float(wz.max() - wz.min())
    mid_barrel = (wy > 0.34 * height) & (wy < 0.68 * height) & (np.abs(wz - cz) < 0.25 * body_span_z)
    if np.sum(mid_barrel) >= 8:
        cx = 0.5 * (float(np.percentile(wx[mid_barrel], 2)) + float(np.percentile(wx[mid_barrel], 98)))
    elif np.any(hoof_m):
        cx = 0.5 * (float(np.percentile(wx[hoof_m], 5)) + float(np.percentile(wx[hoof_m], 95)))
    else:
        cx = 0.5 * (float(wx.min()) + float(wx.max()))

    wx -= cx
    wz -= cz
    wy -= float(wy.min())
    return np.column_stack([wx, wy, wz]).astype(np.float32), float(scale)


def make_strict_closed_manifold(bm):
    """Repairs decimation-induced non-manifold edges/vertices, disconnected shells, and boundary holes
    so the target mesh is a watertight 2-manifold (boundary=0, non_manifold=0) before UV unwrapping.
    """
    for _pass in range(8):
        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()
        bm.faces.ensure_lookup_table()

        bad_faces = set()
        for e in bm.edges:
            if len(e.link_faces) > 2:
                for f in e.link_faces:
                    bad_faces.add(f)
        for f in bm.faces:
            if f.calc_area() < 1e-10:
                bad_faces.add(f)
        if bad_faces:
            bmesh.ops.delete(bm, geom=list(bad_faces), context="FACES")

        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        pinch_faces = set()
        for v in bm.verts:
            if len(v.link_faces) == 0:
                continue
            bdy_deg = sum(1 for e in v.link_edges if e.is_boundary)
            if bdy_deg > 2:
                for f in v.link_faces:
                    pinch_faces.add(f)
                continue
            if not v.is_manifold:
                lfaces = list(v.link_faces)
                vis = {lfaces[0]}
                q = deque([lfaces[0]])
                while q:
                    cf = q.popleft()
                    for e in cf.edges:
                        if v in e.verts:
                            for nf in e.link_faces:
                                if nf not in vis and nf in lfaces:
                                    vis.add(nf)
                                    q.append(nf)
                if len(vis) < len(lfaces):
                    for f in lfaces:
                        pinch_faces.add(f)
        if pinch_faces:
            bmesh.ops.delete(bm, geom=list(pinch_faces), context="FACES")

        loose_e = [e for e in bm.edges if len(e.link_faces) == 0]
        if loose_e:
            bmesh.ops.delete(bm, geom=loose_e, context="EDGES")
        loose_v = [v for v in bm.verts if len(v.link_faces) == 0]
        if loose_v:
            bmesh.ops.delete(bm, geom=loose_v, context="VERTS")

        bm.faces.ensure_lookup_table()
        visited = set()
        comps = []
        for f in bm.faces:
            if f.index in visited:
                continue
            comp = []
            q = deque([f])
            visited.add(f.index)
            while q:
                cur = q.popleft()
                comp.append(cur)
                for e in cur.edges:
                    if len(e.link_faces) == 2:
                        for nf in e.link_faces:
                            if nf.index not in visited:
                                visited.add(nf.index)
                                q.append(nf)
            comps.append(comp)
        if len(comps) > 1:
            comps.sort(key=len, reverse=True)
            del_f = [f for c in comps[1:] for f in c]
            bmesh.ops.delete(bm, geom=del_f, context="FACES")
            loose_e = [e for e in bm.edges if len(e.link_faces) == 0]
            if loose_e:
                bmesh.ops.delete(bm, geom=loose_e, context="EDGES")
            loose_v = [v for v in bm.verts if len(v.link_faces) == 0]
            if loose_v:
                bmesh.ops.delete(bm, geom=loose_v, context="VERTS")

        bm.edges.ensure_lookup_table()
        bdy = [e for e in bm.edges if e.is_boundary]
        if bdy:
            bmesh.ops.holes_fill(bm, edges=bdy, sides=256)
            bmesh.ops.triangulate(bm, faces=bm.faces[:])

        # Fallback: fan-triangulate any remaining simple boundary loops that holes_fill skipped
        bm.edges.ensure_lookup_table()
        rem_bdy = [e for e in bm.edges if e.is_boundary]
        if rem_bdy:
            bdy_set = set(rem_bdy)
            while bdy_set:
                start_e = next(iter(bdy_set))
                loop_verts = [start_e.verts[0], start_e.verts[1]]
                bdy_set.discard(start_e)
                cur_v = start_e.verts[1]
                while True:
                    nxt = None
                    for e in cur_v.link_edges:
                        if e in bdy_set:
                            nxt = e
                            break
                    if nxt is None:
                        break
                    bdy_set.discard(nxt)
                    cur_v = nxt.other_vert(cur_v)
                    if cur_v == loop_verts[0]:
                        break
                    loop_verts.append(cur_v)
                if len(loop_verts) >= 3:
                    center = sum((v.co for v in loop_verts), Vector((0.0, 0.0, 0.0))) / float(len(loop_verts))
                    vc = bm.verts.new(center)
                    for k in range(len(loop_verts)):
                        va = loop_verts[k]
                        vb = loop_verts[(k + 1) % len(loop_verts)]
                        if va != vb and va != vc and vb != vc:
                            try:
                                bm.faces.new([va, vb, vc])
                            except ValueError:
                                pass

        bm.edges.ensure_lookup_table()
        bm.verts.ensure_lookup_table()
        n_bdy = sum(1 for e in bm.edges if e.is_boundary)
        n_nm = sum(1 for e in bm.edges if not e.is_manifold)
        n_nmv = sum(1 for v in bm.verts if not v.is_manifold)
        if n_bdy == 0 and n_nm == 0 and n_nmv == 0:
            break

    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def compute_sagittal_midline_x(pts, height):
    """Computes a smooth anatomical centerline x_mid(z) following body, neck, and slightly turned head."""
    z_min, z_max = float(pts[:, 2].min()), float(pts[:, 2].max())
    n_bins = 48
    zs = np.linspace(z_min, z_max, n_bins)
    dz = (z_max - z_min) / n_bins
    xs = np.zeros(n_bins, dtype=np.float64)
    valid = np.zeros(n_bins, dtype=bool)
    for i, zc in enumerate(zs):
        m = (np.abs(pts[:, 2] - zc) <= dz * 1.2) & (pts[:, 1] < 0.84 * height)
        if np.sum(m) < 10:
            m = np.abs(pts[:, 2] - zc) <= dz * 2.0
        if np.sum(m) >= 4:
            sub_x = pts[m, 0]
            xs[i] = 0.5 * (float(np.percentile(sub_x, 15)) + float(np.percentile(sub_x, 85)))
            valid[i] = True
    if np.any(valid):
        idx_v = np.where(valid)[0]
        xs = np.interp(np.arange(n_bins), idx_v, xs[idx_v])
        for _ in range(4):
            xs_pad = np.pad(xs, 1, mode="edge")
            xs = 0.25 * xs_pad[:-2] + 0.5 * xs_pad[1:-1] + 0.25 * xs_pad[2:]
    return zs, xs


def dijkstra_seam_path(bm, start_vert, goal_set, cost_fn):
    dist = {start_vert.index: 0.0}
    prev_edge = {}
    pq = [(0.0, start_vert.index)]
    visited = set()
    while pq:
        d, u_idx = heapq.heappop(pq)
        if u_idx in visited:
            continue
        visited.add(u_idx)
        if u_idx in goal_set:
            edges = []
            cur = u_idx
            while cur in prev_edge:
                e, parent_idx = prev_edge[cur]
                edges.append(e)
                cur = parent_idx
            return edges
        u = bm.verts[u_idx]
        for e in u.link_edges:
            v = e.other_vert(u)
            v_idx = v.index
            if v_idx in visited:
                continue
            nd = d + cost_fn(u, v, e)
            if nd < dist.get(v_idx, 1e30):
                dist[v_idx] = nd
                prev_edge[v_idx] = (e, u_idx)
                heapq.heappush(pq, (nd, v_idx))
    return []


def mark_anatomical_pelt_seams(obj, height, species_name):
    """Marks clean anatomical UV seams yielding 2-3 large continuous pelt islands:
      - Left pelt & Right pelt split cleanly along the smooth sagittal midline x_mid(z)
      - Long hanging tail (cattle, horse) detached at the tail dock with 1 hidden inner slit
      - Hidden medial inner-leg relief slits from each hoof sole to the sagittal midline
      - Hidden underside horn slits (cattle) so curved horns unroll flat without squishing
    Zero random Voronoi seams across face, eyes, forehead, horns, ears, neck, or flanks!
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()

    for e in bm.edges:
        e.seam = False

    pts = np.array([[v.co.x, v.co.y, v.co.z] for v in bm.verts], dtype=np.float64)
    zs, xs_mid = compute_sagittal_midline_x(pts, height)
    min_z, max_z = float(pts[:, 2].min()), float(pts[:, 2].max())

    def x_mid_at(z):
        return float(np.interp(z, zs, xs_mid))

    hoof_y = 0.06 * height
    hind_hooves = [p[2] for p in pts if p[1] < hoof_y and p[2] < 0.0]
    back_z = float(np.median(hind_hooves)) if hind_hooves else min_z + 0.25 * (max_z - min_z)
    tail_z = back_z - 0.14 * height

    region = {}
    has_long_tail = species_name in ("cattle", "horse")
    for f in bm.faces:
        c = f.calc_center_median()
        if has_long_tail and c.z < tail_z and c.y < 0.72 * height:
            region[f.index] = 2
        else:
            region[f.index] = 1 if (c.x - x_mid_at(c.z)) >= 0.0 else 0

    for _ in range(4):
        new_reg = dict(region)
        for f in bm.faces:
            nbrs = [lf for e in f.edges for lf in e.link_faces if lf != f]
            if len(nbrs) >= 2:
                counts = {}
                for nf in nbrs:
                    r = region[nf.index]
                    counts[r] = counts.get(r, 0) + 1
                best_r, best_c = max(counts.items(), key=lambda kv: kv[1])
                if best_c == len(nbrs) and best_r != region[f.index]:
                    new_reg[f.index] = best_r
        region = new_reg

    for _ in range(6):
        visited = set()
        comps_by_reg = {0: [], 1: [], 2: []}
        for f in bm.faces:
            if f.index in visited:
                continue
            r = region[f.index]
            comp = []
            q = deque([f])
            visited.add(f.index)
            while q:
                cur = q.popleft()
                comp.append(cur)
                for e in cur.edges:
                    for nf in e.link_faces:
                        if nf.index not in visited and region[nf.index] == r:
                            visited.add(nf.index)
                            q.append(nf)
            comps_by_reg[r].append(comp)

        changed = 0
        for r, comps in comps_by_reg.items():
            if len(comps) <= 1:
                continue
            comps.sort(key=len, reverse=True)
            for small in comps[1:]:
                nbr_counts = {}
                small_set = set(f.index for f in small)
                for f in small:
                    for e in f.edges:
                        for nf in e.link_faces:
                            if nf.index not in small_set:
                                nr = region[nf.index]
                                nbr_counts[nr] = nbr_counts.get(nr, 0) + 1
                target_r = max(nbr_counts.items(), key=lambda kv: kv[1])[0] if nbr_counts else (1 - r if r < 2 else 0)
                for f in small:
                    region[f.index] = target_r
                    changed += 1
        if changed == 0:
            break

    seam_verts = set()
    tail_seam_verts = set()
    boundary_seam_edges = 0
    for e in bm.edges:
        if len(e.link_faces) == 2:
            r0, r1 = region[e.link_faces[0].index], region[e.link_faces[1].index]
            if r0 != r1:
                e.seam = True
                boundary_seam_edges += 1
                seam_verts.add(e.verts[0].index)
                seam_verts.add(e.verts[1].index)
                if 2 in (r0, r1):
                    tail_seam_verts.add(e.verts[0].index)
                    tail_seam_verts.add(e.verts[1].index)

    tail_slit_edges = 0
    if has_long_tail and tail_seam_verts:
        tail_verts = [v for v in bm.verts if any(region[f.index] == 2 for f in v.link_faces)]
        if tail_verts:
            v_tail_tip = min(tail_verts, key=lambda v: v.co.y)
            def tail_cost(u, v, e):
                if not all(any(region[f.index] == 2 for f in x.link_faces) for x in (u, v)):
                    return 1e6
                p = 0.5 * (u.co + v.co)
                elen = (u.co - v.co).length
                dx = abs(p.x - x_mid_at(p.z))
                n = (u.normal + v.normal).normalized() if (u.normal + v.normal).length > 1e-6 else Vector((0, 0, 1))
                return elen * (1.0 + 8.0 * dx / height + 3.0 * max(0.0, -n.z))
            for e in dijkstra_seam_path(bm, v_tail_tip, tail_seam_verts, tail_cost):
                e.seam = True
                tail_slit_edges += 1

    hoof_verts = [v for v in bm.verts if v.co.y < 0.08 * height]
    med_z = float(np.median([v.co.z for v in hoof_verts])) if hoof_verts else 0.0
    leg_seam_edges = 0
    for is_front in (True, False):
        for is_right in (True, False):
            reg_id = 1 if is_right else 0
            cands = [
                v for v in bm.verts
                if v.co.y < 0.25 * height
                and ((v.co.z >= med_z) == is_front)
                and any(region[f.index] == reg_id for f in v.link_faces)
            ]
            if not cands:
                continue
            v_hoof = min(cands, key=lambda v: v.co.y + 0.05 * abs(v.co.x - x_mid_at(v.co.z)))
            def leg_cost(u, v, e, r_id=reg_id):
                p = 0.5 * (u.co + v.co)
                dx_mid = abs(p.x - x_mid_at(p.z))
                elen = (u.co - v.co).length
                pen = 1.0 + 18.0 * dx_mid / max(0.1, height)
                if p.y > 0.58 * height:
                    pen += 40.0 * (p.y - 0.58 * height) / height
                if not any(region[f.index] == r_id for f in v.link_faces):
                    pen += 100.0
                return elen * pen
            for e in dijkstra_seam_path(bm, v_hoof, seam_verts, leg_cost):
                e.seam = True
                leg_seam_edges += 1

    horn_seam_edges = 0
    if species_name == "cattle":
        for is_right in (True, False):
            reg_id = 1 if is_right else 0
            s_sign = 1.0 if is_right else -1.0
            cands = [
                v for v in bm.verts
                if v.co.y > 0.72 * height and v.co.z > 0.25 * max_z
                and (v.co.x - x_mid_at(v.co.z)) * s_sign > 0.08 * height
            ]
            if not cands:
                continue
            v_tip = max(cands, key=lambda v: abs(v.co.x - x_mid_at(v.co.z)) + 0.8 * v.co.y)
            def horn_cost(u, v, e, r_id=reg_id):
                n = (u.normal + v.normal).normalized() if (u.normal + v.normal).length > 1e-6 else Vector((0, 1, 0))
                elen = (u.co - v.co).length
                pen = 1.0 + 4.0 * max(0.0, n.y) + 5.0 * max(0.0, n.z)
                if not any(region[f.index] == r_id for f in v.link_faces):
                    pen += 100.0
                return elen * pen
            for e in dijkstra_seam_path(bm, v_tip, seam_verts, horn_cost):
                e.seam = True
                horn_seam_edges += 1

    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    print(f"[pelt-uv] {species_name}: seams region_bdy={boundary_seam_edges}, legs={leg_seam_edges}, tail={tail_slit_edges}, horns={horn_seam_edges}")


def flood_fill_unbaked_pixels(rgba_f32):
    """Inpaints any missed/pure-black ray pixels inside islands and dilates valid baked pelt colors
    into all untouched background texels so GPU mipmaps down to 1x1 NEVER bleed black into coats.
    """
    h, w, _ = rgba_f32.shape
    valid = (rgba_f32[:, :, 3] > 0.5) & (np.max(rgba_f32[:, :, :3], axis=2) >= 0.004)
    if np.all(valid) or not np.any(valid):
        return rgba_f32[:, :, :3]
    out = rgba_f32[:, :, :3].copy()
    cur_valid = valid.copy()
    for _ in range(64):
        if np.all(cur_valid):
            break
        acc = np.zeros_like(out)
        cnt = np.zeros((h, w), dtype=np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                ys = slice(max(0, dy), h + min(0, dy))
                xs = slice(max(0, dx), w + min(0, dx))
                yd = slice(max(0, -dy), h + min(0, -dy))
                xd = slice(max(0, -dx), w + min(0, -dx))
                m = cur_valid[ys, xs]
                acc[yd, xd] += out[ys, xs] * m[:, :, None]
                cnt[yd, xd] += m.astype(np.float32)
        fill = (~cur_valid) & (cnt > 0.0)
        if not np.any(fill):
            break
        out[fill] = acc[fill] / cnt[fill, None]
        cur_valid[fill] = True
    if not np.all(cur_valid):
        out[~cur_valid] = out[valid].mean(axis=0)
    return out


def bake_clean_pelt_texture(src_obj, tgt_obj, src_img, species_name, tex_size=1024):
    """Bakes lighting-free Cycles EMIT color from high-res Tripo source_obj onto clean pelt-unwrapped
    target_obj (1024x1024 sRGB), flood-fills margins/background, saves JPEG, and returns bake_img.
    """
    mat_src = bpy.data.materials.new(name=f"{species_name}_emit_src")
    mat_src.use_nodes = True
    nt = mat_src.node_tree
    nt.nodes.clear()
    n_out = nt.nodes.new("ShaderNodeOutputMaterial")
    n_emit = nt.nodes.new("ShaderNodeEmission")
    n_tex = nt.nodes.new("ShaderNodeTexImage")
    n_tex.image = src_img
    n_tex.interpolation = "Linear"
    nt.links.new(n_tex.outputs["Color"], n_emit.inputs["Color"])
    nt.links.new(n_emit.outputs["Emission"], n_out.inputs["Surface"])
    src_obj.data.materials.clear()
    src_obj.data.materials.append(mat_src)

    bake_img = bpy.data.images.new(name=f"{species_name}_pelt_baked", width=tex_size, height=tex_size, alpha=True, float_buffer=False)
    bake_img.colorspace_settings.name = "sRGB"
    bake_img.pixels.foreach_set(np.zeros(tex_size * tex_size * 4, dtype=np.float32))
    mat_tgt = bpy.data.materials.new(name=f"{species_name}_bake_tgt")
    mat_tgt.use_nodes = True
    nt_t = mat_tgt.node_tree
    nt_t.nodes.clear()
    nt_t.nodes.new("ShaderNodeOutputMaterial")
    nt_tex = nt_t.nodes.new("ShaderNodeTexImage")
    nt_tex.image = bake_img
    nt_t.nodes.active = nt_tex
    tgt_obj.data.materials.clear()
    tgt_obj.data.materials.append(mat_tgt)

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 4
    scene.cycles.use_denoising = False
    scene.cycles.bake_type = "EMIT"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.use_clear = True
    scene.render.bake.cage_extrusion = 0.035
    scene.render.bake.max_ray_distance = 0.08
    scene.render.bake.margin = 16
    scene.render.bake.margin_type = "EXTEND"

    bpy.ops.object.select_all(action="DESELECT")
    src_obj.select_set(True)
    tgt_obj.select_set(True)
    bpy.context.view_layer.objects.active = tgt_obj
    bpy.ops.object.bake(type="EMIT")

    px = np.empty(tex_size * tex_size * 4, dtype=np.float32)
    bake_img.pixels.foreach_get(px)
    rgba = px.reshape(tex_size, tex_size, 4)

    # Diagnostic check for any missed ray loops prior to flood-fill repair
    bm_chk = bmesh.new()
    bm_chk.from_mesh(tgt_obj.data)
    uv_lay = bm_chk.loops.layers.uv.active
    missed_alpha = 0
    repaired_black = 0
    total_loops = 0
    for f in bm_chk.faces:
        for l in f.loops:
            total_loops += 1
            uv = l[uv_lay].uv
            ix = max(0, min(tex_size - 1, int(round(uv.x * (tex_size - 1)))))
            iy = max(0, min(tex_size - 1, int(round(uv.y * (tex_size - 1)))))
            if rgba[iy, ix, 3] < 0.5:
                missed_alpha += 1
            elif np.max(rgba[iy, ix, :3]) < 0.004:
                repaired_black += 1
    bm_chk.free()

    rgb_filled = flood_fill_unbaked_pixels(rgba)
    rgba[:, :, :3] = rgb_filled
    rgba[:, :, 3] = 1.0
    bake_img.pixels.foreach_set(rgba.ravel())
    bake_img.update()

    os.makedirs(OUT_TEX_DIR, exist_ok=True)
    out_path = os.path.join(OUT_TEX_DIR, f"livestock-{species_name}.jpg")
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.quality = 92
    bake_img.save_render(out_path, scene=scene)
    print(
        f"[cycles-bake] {species_name}: saved {tex_size}x{tex_size} pelt JPEG {out_path} "
        f"({os.path.getsize(out_path)/1024:.1f} KB), missed_alpha={missed_alpha}/{total_loops}, "
        f"inpainted_dark={repaired_black}/{total_loops}"
    )
    return bake_img


def import_tripo_quadruped(glb_path, spec_meta):
    """Imports a Tripo H3.1 4K GLB, aligns source_obj to Waterworld coordinates, builds a watertight
    decimated target_obj (12k-14k tris), re-unwraps cleanly onto 2-3 continuous anatomical pelt UV
    islands, Cycles-EMIT bakes 4K -> 1K clean pelt JPEG, and resamples linear BakeCoat vertex colors
    from the baked pelt texture so FAR & SPLAT match CLUSTER 1:1.
    Returns (bm, vert_linear_rgb_list).
    """
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=glb_path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        return None, None
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    src_obj = bpy.context.view_layer.objects.active
    src_obj.name = f"{spec_meta['name']}_source"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # 1. Single Merino sheep extraction: strip twin sheep at X > 0.0 immediately after transform_apply!
    if spec_meta["name"] == "sheep":
        bm_strip = bmesh.new()
        bm_strip.from_mesh(src_obj.data)
        to_del = [v for v in bm_strip.verts if v.co.x > 0.0]
        if to_del:
            print(f"[tripo] Stripping twin sheep component ({len(to_del)}/{len(bm_strip.verts)} verts with x > 0)")
            bmesh.ops.delete(bm_strip, geom=to_del, context="VERTS")
            bm_strip.to_mesh(src_obj.data)
            src_obj.data.update()
        bm_strip.free()

    # 2. Transform source_obj directly into Waterworld coordinates (+Z forward, +Y up, symmetric X, hooves Y=0)
    #    BEFORE duplicating to target_obj so Cycles selected-to-active raycasts align identically in real meters.
    n_sv = len(src_obj.data.vertices)
    co_flat = np.empty(n_sv * 3, dtype=np.float32)
    src_obj.data.vertices.foreach_get("co", co_flat)
    ww_pts, scale = align_points_waterworld(co_flat.reshape(-1, 3), spec_meta["height"])
    src_obj.data.vertices.foreach_set("co", ww_pts.ravel())
    src_obj.data.update()

    imgs = [im for im in bpy.data.images if im.size[0] >= 256 and im.size[1] >= 256]
    src_img = next((im for im in imgs if "basecolor" in im.name.lower() or "color" in im.name.lower()), imgs[0]) if imgs else None

    # 3. Build welded, decimated, watertight manifold target_obj (dropping Tripo's 80 Voronoi UV islands!)
    tgt_mesh = src_obj.data.copy()
    tgt_mesh.name = f"{spec_meta['name']}_target_mesh"
    tgt_obj = bpy.data.objects.new(f"{spec_meta['name']}_target", tgt_mesh)
    bpy.context.collection.objects.link(tgt_obj)
    bpy.ops.object.select_all(action="DESELECT")
    tgt_obj.select_set(True)
    bpy.context.view_layer.objects.active = tgt_obj

    while len(tgt_obj.data.uv_layers) > 0:
        tgt_obj.data.uv_layers.remove(tgt_obj.data.uv_layers[0])

    weld = tgt_obj.modifiers.new(name="WeldUVSeams", type="WELD")
    weld.merge_threshold = 0.00015 * scale
    bpy.ops.object.modifier_apply(modifier=weld.name)

    target_faces = spec_meta.get("targetFaces", 12000)
    if len(tgt_obj.data.polygons) > target_faces:
        dec = tgt_obj.modifiers.new(name="TripoDec", type="DECIMATE")
        dec.decimate_type = "COLLAPSE"
        dec.ratio = float(target_faces) / float(len(tgt_obj.data.polygons))
        dec.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=dec.name)

    bm_clean = bmesh.new()
    bm_clean.from_mesh(tgt_obj.data)
    make_strict_closed_manifold(bm_clean)
    bm_clean.edges.ensure_lookup_table()
    bm_clean.verts.ensure_lookup_table()
    b_edges = sum(1 for e in bm_clean.edges if e.is_boundary)
    nm_edges = sum(1 for e in bm_clean.edges if not e.is_manifold)
    bm_clean.to_mesh(tgt_obj.data)
    bm_clean.free()
    tgt_obj.data.update()

    # 4. Re-unwrap target_obj cleanly onto 2-3 continuous anatomical pelt UV islands via SLIM MINIMUM_STRETCH
    tgt_obj.data.uv_layers.new(name="CleanPeltUV")
    mark_anatomical_pelt_seams(tgt_obj, spec_meta["height"], spec_meta["name"])

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.unwrap(method="MINIMUM_STRETCH", margin=0.025, iterations=14)
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(margin=0.025, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")

    # Verify UV island count, area utilization & orientation
    bm_uv = bmesh.new()
    bm_uv.from_mesh(tgt_obj.data)
    uv_lay = bm_uv.loops.layers.uv.active
    uv_area = 0.0
    neg_tris = 0
    for f in bm_uv.faces:
        u0, u1, u2 = [l[uv_lay].uv for l in f.loops]
        a2 = (u1.x - u0.x) * (u2.y - u0.y) - (u2.x - u0.x) * (u1.y - u0.y)
        uv_area += 0.5 * abs(a2)
        if a2 < 0.0:
            neg_tris += 1
    bm_uv.faces.ensure_lookup_table()
    vis = set()
    islands = []
    for f in bm_uv.faces:
        if f.index in vis:
            continue
        comp = []
        q = deque([f])
        vis.add(f.index)
        while q:
            c = q.popleft()
            comp.append(c)
            for e in c.edges:
                if e.seam:
                    continue
                for nf in e.link_faces:
                    if nf.index not in vis:
                        vis.add(nf.index)
                        q.append(nf)
        islands.append(len(comp))
    bm_uv.free()
    islands.sort(reverse=True)
    print(
        f"[tripo] {spec_meta['name']}: {len(tgt_obj.data.vertices)} verts, {len(tgt_obj.data.polygons)} tris, "
        f"boundary={b_edges}, non_manifold={nm_edges}, uv_islands={len(islands)} {islands[:6]}, "
        f"uv_area={uv_area:.3f}, neg_uv_tris={neg_tris}"
    )

    # 5. Cycles EMIT selected-to-active bake (4K Tripo -> 1024x1024 clean pelt JPEG) & resample BakeCoat vertex RGB
    bake_img = bake_clean_pelt_texture(src_obj, tgt_obj, src_img, spec_meta["name"], tex_size=1024) if src_img else None
    has_tex = sample_image_to_point_attribute(tgt_obj.data, bake_img) if bake_img else False

    me = tgt_obj.data
    n_v = len(me.vertices)
    vert_rgb = None
    attr = me.color_attributes.get("BakeCoat") if has_tex else None
    if attr is not None and attr.domain == "POINT" and len(attr.data) == n_v:
        raw_c = np.empty(n_v * 4, dtype=np.float32)
        attr.data.foreach_get("color", raw_c)
        vert_rgb = raw_c.reshape(-1, 4)[:, :3].copy()

    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.normal_update()

    bpy.data.objects.remove(tgt_obj, do_unlink=True)
    bpy.data.objects.remove(src_obj, do_unlink=True)
    return bm, vert_rgb


def build_sheep(tripo_dir):
    meta = {"name": "sheep", "neckPivot": (0.0, 0.56, 0.28), "legY": 0.36, "frontZ": 0.26, "backZ": -0.30, "height": 0.82, "targetFaces": 12000}
    glb = find_tripo_glb(tripo_dir, "sheep")
    vert_rgb = None
    if glb:
        print(f"[tripo] Importing cached sheep GLB: {glb}")
        bm, vert_rgb = import_tripo_quadruped(glb, meta)
    else:
        clear_scene()
        bm = bmesh.new()
        stations = [
            (0.54, -0.46, 0.11, 0.11, 0.12),
            (0.53, -0.34, 0.20, 0.19, 0.215),
            (0.51, -0.14, 0.23, 0.21, 0.23),
            (0.52,  0.08, 0.225, 0.21, 0.23),
            (0.54,  0.26, 0.20, 0.195, 0.225),
            (0.61,  0.36, 0.145, 0.135, 0.14),
            (0.69,  0.44, 0.108, 0.098, 0.098),
            (0.73,  0.50, 0.084, 0.078, 0.074),
            (0.69,  0.59, 0.058, 0.054, 0.050),
            (0.65,  0.665, 0.040, 0.038, 0.035),
        ]
        build_spine_loft(bm, stations, segs=28, wool_ripple=0.038)
        for sx in (-1.0, 1.0):
            add_ellipsoid(bm, (sx * 0.125, 0.45, 0.25), (0.095, 0.135, 0.115))
            add_ellipsoid(bm, (sx * 0.135, 0.47, -0.29), (0.105, 0.145, 0.130))
            add_ellipsoid(bm, (sx * 0.058, 0.72, 0.51), (0.035, 0.032, 0.042))
            add_tapered_tube(bm, [(sx * 0.065, 0.73, 0.46), (sx * 0.145, 0.71, 0.44), (sx * 0.180, 0.69, 0.43)], [0.030, 0.025, 0.011], segs=12)
        add_ellipsoid(bm, (0.0, 0.76, 0.47), (0.072, 0.052, 0.068))
        add_tapered_tube(bm, [(0.0, 0.56, -0.45), (0.0, 0.46, -0.52), (0.0, 0.36, -0.53)], [0.058, 0.048, 0.030], segs=12)
        for lx, lz in [(-0.115, 0.26), (0.115, 0.26), (-0.125, -0.30), (0.125, -0.30)]:
            kz = lz + (0.015 if lz > 0 else -0.028)
            pts = [(lx * 0.90, 0.44, lz), (lx, 0.26, kz), (lx, 0.18, kz), (lx, 0.06, lz), (lx, 0.0, lz + 0.016)]
            rads = [(0.078, 0.088), (0.050, 0.054), 0.030, 0.024, (0.029, 0.034)]
            add_tapered_tube(bm, pts, rads, segs=14, cloven=True)
        bm = voxel_unify_and_decimate(bm, "sheep", voxel_size=0.010, target_faces=3400, smooth_iters=2)

    rig = measure_quadruped_rig(bm, meta["height"])
    meta.update({k: rig[k] for k in ("neckPivot", "legY", "frontZ", "backZ")})
    print(f"[rig] sheep: neckPivot={meta['neckPivot']} legY={meta['legY']} frontZ={meta['frontZ']} backZ={meta['backZ']} leg_top_y={rig['leg_top_y']:.3f}")

    def coat_fn(i, p, n):
        if vert_rgb is not None:
            return pack_rgb555(vert_rgb[i, 0], vert_rgb[i, 1], vert_rgb[i, 2])
        if (p.z > 0.49 and p.y < 0.745) or p.y < 0.21:
            return pack_rgb555(0.18, 0.14, 0.11)
        return pack_rgb555(0.64, 0.59, 0.48)

    v, idx = extract_part_records(bm, lambda p: classify_quadruped_part(p, rig), coat_fn)
    bm.free()
    return {**meta, "verts": v, "indices": idx}


def build_cattle(tripo_dir):
    meta = {"name": "cattle", "neckPivot": (0.0, 1.06, 0.62), "legY": 0.78, "frontZ": 0.56, "backZ": -0.64, "height": 1.52, "targetFaces": 12000}
    glb = find_tripo_glb(tripo_dir, "cattle")
    vert_rgb = None
    if glb:
        print(f"[tripo] Importing cached cattle GLB: {glb}")
        bm, vert_rgb = import_tripo_quadruped(glb, meta)
    else:
        clear_scene()
        bm = bmesh.new()
        stations = [
            (1.06, -0.84, 0.18, 0.22, 0.24),
            (1.02, -0.64, 0.305, 0.31, 0.365),
            (0.96, -0.28, 0.35, 0.345, 0.395),
            (0.97,  0.14, 0.34, 0.355, 0.405),
            (1.01,  0.50, 0.29, 0.37, 0.46),
            (1.07,  0.74, 0.19, 0.23, 0.30),
            (1.16,  0.92, 0.15, 0.155, 0.155),
            (1.07,  1.08, 0.108, 0.102, 0.102),
            (0.99,  1.215, 0.086, 0.078, 0.074),
        ]
        build_spine_loft(bm, stations, segs=30, anatomical_ribs=0.018)
        add_ellipsoid(bm, (0.0, 1.28, 0.46), (0.15, 0.14, 0.24))
        add_ellipsoid(bm, (0.0, 0.68, 0.58), (0.075, 0.18, 0.26), rot_euler=(-0.32, 0.0, 0.0))
        for sx in (-1.0, 1.0):
            add_ellipsoid(bm, (sx * 0.20, 0.92, 0.52), (0.12, 0.22, 0.18), rot_euler=(0.18, 0.0, 0.0))
            add_ellipsoid(bm, (sx * 0.21, 0.96, -0.60), (0.135, 0.24, 0.21))
            add_ellipsoid(bm, (sx * 0.17, 1.21, -0.74), (0.075, 0.065, 0.11))
            add_ellipsoid(bm, (sx * 0.105, 1.13, 0.98), (0.048, 0.045, 0.055))
            add_tapered_tube(bm, [
                (sx * 0.11, 1.25, 0.90),
                (sx * 0.25, 1.33, 0.91),
                (sx * 0.36, 1.44, 0.98),
                (sx * 0.34, 1.54, 1.06),
                (sx * 0.29, 1.60, 1.11),
            ], [0.046, 0.036, 0.025, 0.015, 0.007], segs=14)
            add_tapered_tube(bm, [(sx * 0.13, 1.19, 0.88), (sx * 0.24, 1.16, 0.86), (sx * 0.29, 1.15, 0.85)], [0.042, 0.035, 0.014], segs=12)
        add_tapered_tube(bm, [(0.0, 1.14, -0.84), (0.0, 0.84, -0.94), (0.0, 0.50, -0.95), (0.0, 0.35, -0.94)], [0.044, 0.028, 0.048, 0.018], segs=12)
        for lx, lz in [(-0.19, 0.56), (0.19, 0.56), (-0.20, -0.64), (0.20, -0.64)]:
            hz = lz + (0.022 if lz > 0 else -0.060)
            pts = [(lx * 0.88, 0.86, lz), (lx, 0.57, lz - 0.01), (lx, 0.42, hz), (lx, 0.14, lz), (lx, 0.05, lz + 0.012), (lx, 0.0, lz + 0.028)]
            rads = [(0.125, 0.155) if lz < 0 else (0.115, 0.135), (0.082, 0.096), (0.056, 0.064), 0.040, 0.044, (0.050, 0.058)]
            add_tapered_tube(bm, pts, rads, segs=14, cloven=True)
        bm = voxel_unify_and_decimate(bm, "cattle", voxel_size=0.014, target_faces=3800, smooth_iters=3)

    rig = measure_quadruped_rig(bm, meta["height"])
    meta.update({k: rig[k] for k in ("neckPivot", "legY", "frontZ", "backZ")})
    print(f"[rig] cattle: neckPivot={meta['neckPivot']} legY={meta['legY']} frontZ={meta['frontZ']} backZ={meta['backZ']} leg_top_y={rig['leg_top_y']:.3f}")

    def coat_fn(i, p, n):
        if vert_rgb is not None:
            return pack_rgb555(vert_rgb[i, 0], vert_rgb[i, 1], vert_rgb[i, 2])
        if p.y > 1.25 and p.z > 0.84 and abs(p.x) > 0.12:
            return pack_rgb555(0.48, 0.43, 0.34)
        if p.y < 0.12:
            return pack_rgb555(0.055, 0.048, 0.045)
        return pack_rgb555(0.28, 0.12, 0.055)

    v, idx = extract_part_records(bm, lambda p: classify_quadruped_part(p, rig), coat_fn)
    bm.free()
    return {**meta, "verts": v, "indices": idx}


def build_swine(tripo_dir):
    meta = {"name": "swine", "neckPivot": (0.0, 0.42, 0.28), "legY": 0.28, "frontZ": 0.25, "backZ": -0.30, "height": 0.66, "targetFaces": 12000}
    glb = find_tripo_glb(tripo_dir, "swine")
    vert_rgb = None
    if glb:
        print(f"[tripo] Importing cached swine GLB: {glb}")
        bm, vert_rgb = import_tripo_quadruped(glb, meta)
    else:
        clear_scene()
        bm = bmesh.new()
        stations = [
            (0.42, -0.46, 0.125, 0.135, 0.145),
            (0.43, -0.32, 0.20, 0.20, 0.205),
            (0.425, -0.08, 0.22, 0.225, 0.22),
            (0.42,  0.18, 0.21, 0.215, 0.21),
            (0.41,  0.34, 0.17, 0.17, 0.175),
            (0.40,  0.46, 0.118, 0.118, 0.108),
            (0.35,  0.57, 0.070, 0.066, 0.062),
            (0.32,  0.655, 0.052, 0.052, 0.048),
        ]
        build_spine_loft(bm, stations, segs=26)
        for sx in (-1.0, 1.0):
            add_ellipsoid(bm, (sx * 0.115, 0.36, 0.22), (0.085, 0.12, 0.11))
            add_ellipsoid(bm, (sx * 0.12, 0.38, -0.28), (0.095, 0.13, 0.12))
            add_ellipsoid(bm, (sx * 0.095, 0.36, 0.38), (0.055, 0.065, 0.08))
            add_tapered_tube(bm, [(sx * 0.09, 0.52, 0.38), (sx * 0.145, 0.48, 0.46), (sx * 0.125, 0.43, 0.54)], [0.046, 0.040, 0.015], segs=12)
        add_tapered_tube(bm, [(0.0, 0.47, -0.45), (0.022, 0.51, -0.51), (-0.012, 0.46, -0.545)], [0.024, 0.017, 0.010], segs=10)
        for lx, lz in [(-0.115, 0.25), (0.115, 0.25), (-0.120, -0.30), (0.120, -0.30)]:
            pts = [(lx * 0.90, 0.31, lz), (lx, 0.16, lz - 0.012), (lx, 0.055, lz), (lx, 0.0, lz + 0.014)]
            rads = [(0.072, 0.082), (0.042, 0.046), 0.029, (0.032, 0.036)]
            add_tapered_tube(bm, pts, rads, segs=12, cloven=True)
        bm = voxel_unify_and_decimate(bm, "swine", voxel_size=0.0095, target_faces=3000, smooth_iters=3)

    rig = measure_quadruped_rig(bm, meta["height"])
    meta.update({k: rig[k] for k in ("neckPivot", "legY", "frontZ", "backZ")})
    print(f"[rig] swine: neckPivot={meta['neckPivot']} legY={meta['legY']} frontZ={meta['frontZ']} backZ={meta['backZ']} leg_top_y={rig['leg_top_y']:.3f}")

    def coat_fn(i, p, n):
        if vert_rgb is not None:
            return pack_rgb555(vert_rgb[i, 0], vert_rgb[i, 1], vert_rgb[i, 2])
        return pack_rgb555(0.08, 0.07, 0.065)

    v, idx = extract_part_records(bm, lambda p: classify_quadruped_part(p, rig), coat_fn)
    bm.free()
    return {**meta, "verts": v, "indices": idx}


def build_gineta_saddle_and_tack(horse_bm, neck_pivot):
    """Fits the 1550 Iberian `sela à gineta` high-cantle/pommel leather saddle, quilted `xairel`
    saddlecloth, stirrup leathers, forged iron box stirrups (`estribos`), breastplate (`peitoral`),
    crupper (`rabicho`), dual `alforjas` courier saddlebags (`part = 9.0`), plus headstall bridle,
    iron curb bit, and looped reins (`part = 10.0..10.95`) directly onto the measured Tripo H3.1 horse mesh.
    Zones (negative int16): 4 = oiled Cordovan leather, 5 = forged iron hardware, 6 = dyed courier cloth.
    """
    pts = np.array([[v.co.x, v.co.y, v.co.z] for v in horse_bm.verts], dtype=np.float64)

    def dorsal_y_at(z0, half_dz=0.038):
        m = (np.abs(pts[:, 2] - z0) < half_dz) & (pts[:, 1] > 0.72) & (np.abs(pts[:, 0]) < 0.14)
        if np.sum(m) >= 3:
            return float(np.percentile(pts[m, 1], 98))
        m2 = (np.abs(pts[:, 2] - z0) < 0.07) & (pts[:, 1] > 0.72)
        return float(np.percentile(pts[m2, 1], 96)) if np.any(m2) else 1.18

    def barrel_rx_at(z0, y_lo=0.78, y_hi=1.18, half_dz=0.04):
        m = (np.abs(pts[:, 2] - z0) < half_dz) & (pts[:, 1] >= y_lo) & (pts[:, 1] <= y_hi)
        if np.sum(m) >= 4:
            return float(np.percentile(np.abs(pts[m, 0]), 98))
        return 0.22

    def belly_y_at(z0):
        m = (np.abs(pts[:, 2] - z0) < 0.045) & (pts[:, 1] > 0.55) & (np.abs(pts[:, 0]) < 0.10)
        return float(np.percentile(pts[m, 1], 3)) if np.sum(m) >= 3 else 0.70

    def radial_surface_at(z0, y_pivot, ang):
        """Measures actual distance from (0, y_pivot, z0) along direction (sin(ang), cos(ang)) to horse skin."""
        sa, ca = math.sin(ang), math.cos(ang)
        m = (np.abs(pts[:, 2] - z0) < 0.042) & (pts[:, 1] > 0.72)
        sub = pts[m]
        if len(sub) < 6:
            return 0.23
        dx = sub[:, 0]
        dy = sub[:, 1] - y_pivot
        # Angular alignment with ray (sa, ca)
        r = np.hypot(dx, dy)
        valid = r > 0.04
        if not np.any(valid):
            return 0.23
        cos_diff = (dx[valid] * sa + dy[valid] * ca) / r[valid]
        cone = cos_diff > 0.94
        if np.sum(cone) >= 2:
            return float(np.percentile(r[valid][cone], 96))
        cone2 = cos_diff > 0.85
        if np.any(cone2):
            return float(np.max(r[valid][cone2]))
        return 0.23

    parts = []
    # 1. Quilted saddlecloth (`xairel`, zone = 6, part = 9.0) molded directly to the measured Lusitano back & ribs
    bm_sad = bmesh.new()
    cloth_z = [-0.34, -0.22, -0.10, 0.02, 0.14, 0.26]
    cloth_a = [-1.18, -0.82, -0.45, 0.0, 0.45, 0.82, 1.18]
    y_piv_cloth = 0.94
    grid_out, grid_in = [], []
    cloth_max_rx = 0.0
    for zc in cloth_z:
        row_o, row_i = [], []
        for ang in cloth_a:
            sa, ca = math.sin(ang), math.cos(ang)
            r_skin = radial_surface_at(zc, y_piv_cloth, ang)
            r_in = r_skin + 0.003
            r_out = r_skin + 0.017
            xo, yo = sa * r_out, y_piv_cloth + ca * r_out
            xi, yi = sa * r_in, y_piv_cloth + ca * r_in
            cloth_max_rx = max(cloth_max_rx, abs(xo))
            row_o.append(bm_sad.verts.new(Vector((xo, yo, zc))))
            row_i.append(bm_sad.verts.new(Vector((xi, yi, zc))))
        grid_out.append(row_o)
        grid_in.append(row_i)
    for iz in range(len(cloth_z) - 1):
        for ia in range(len(cloth_a) - 1):
            bm_sad.faces.new([grid_out[iz][ia], grid_out[iz + 1][ia], grid_out[iz + 1][ia + 1], grid_out[iz][ia + 1]])
            bm_sad.faces.new([grid_in[iz][ia], grid_in[iz][ia + 1], grid_in[iz + 1][ia + 1], grid_in[iz + 1][ia]])
    for iz in range(len(cloth_z) - 1):
        bm_sad.faces.new([grid_out[iz][0], grid_in[iz][0], grid_in[iz + 1][0], grid_out[iz + 1][0]])
        bm_sad.faces.new([grid_out[iz][-1], grid_out[iz + 1][-1], grid_in[iz + 1][-1], grid_in[iz][-1]])
    for ia in range(len(cloth_a) - 1):
        bm_sad.faces.new([grid_out[0][ia], grid_out[0][ia + 1], grid_in[0][ia + 1], grid_in[0][ia]])
        bm_sad.faces.new([grid_out[-1][ia], grid_in[-1][ia], grid_in[-1][ia + 1], grid_out[-1][ia + 1]])
    parts.append(extract_part_records(bm_sad, 9.0, lambda _i, p, n: pack_tack_coat(6, ao_shade(p.y, 1.55, n.y))))
    bm_sad.free()

    # 2. Leather `sela à gineta` seat, high pommel, high cantle, girth, breastplate, crupper, alforjas & stirrup leathers (`zone = 4`)
    bm_lth = bmesh.new()
    seat_z = -0.02
    spine_hollow_y = dorsal_y_at(seat_z)
    seat_ry = 0.038
    seat_cy = spine_hollow_y + 0.014 + seat_ry * 0.68
    saddle_seat_top_y = seat_cy + seat_ry
    add_ellipsoid(bm_lth, (0.0, seat_cy, seat_z), (0.176, seat_ry, 0.215), u_segs=14, v_segs=8)

    # Molded leather saddle skirts (`abas`) hugging the saddlecloth sides so seat transitions smoothly into flaps
    for sx in (-1.0, 1.0):
        rx_mid = barrel_rx_at(0.0) + 0.019
        add_ellipsoid(bm_lth, (sx * (rx_mid - 0.022), spine_hollow_y - 0.09, 0.0), (0.032, 0.105, 0.165), rot_euler=(0.0, 0.0, sx * -0.26), u_segs=10, v_segs=6)

    # High curved Iberian pommel (`arzón delantero`, z = +0.18..+0.21) & wrap-around cantle (`arzón trasero`, z = -0.18..-0.24)
    y_pom_base = dorsal_y_at(0.18) + 0.012
    pommel_top_y = saddle_seat_top_y + 0.145
    add_tapered_tube(bm_lth, [
        (-0.145, y_pom_base - 0.02, 0.175),
        (-0.075, pommel_top_y - 0.035, 0.195),
        (0.0, pommel_top_y, 0.208),
        (0.075, pommel_top_y - 0.035, 0.195),
        (0.145, y_pom_base - 0.02, 0.175),
    ], [0.025, 0.031, 0.034, 0.031, 0.025], segs=8)

    y_can_base = dorsal_y_at(-0.19) + 0.012
    cantle_top_y = saddle_seat_top_y + 0.135
    add_tapered_tube(bm_lth, [
        (-0.168, y_can_base - 0.02, -0.175),
        (-0.108, cantle_top_y - 0.032, -0.218),
        (0.0, cantle_top_y, -0.238),
        (0.108, cantle_top_y - 0.032, -0.218),
        (0.168, y_can_base - 0.02, -0.175),
    ], [0.027, 0.034, 0.037, 0.034, 0.027], segs=8)

    # Leather girth (`cincha`) at z = +0.06 wrapping tightly around the measured ribcage & belly_y
    z_girth = 0.06
    girth_rx = barrel_rx_at(z_girth) + 0.012
    belly_y = belly_y_at(z_girth)
    add_tapered_tube(bm_lth, [
        (-girth_rx + 0.004, 1.07, z_girth),
        (-girth_rx - 0.004, 0.90, z_girth),
        (-0.145, belly_y + 0.018, z_girth),
        (0.0, belly_y - 0.008, z_girth),
        (0.145, belly_y + 0.018, z_girth),
        (girth_rx + 0.004, 0.90, z_girth),
        (girth_rx - 0.004, 1.07, z_girth),
    ], [0.015] * 7, segs=6)

    # Breastplate (`peitoral`) hugging shoulders & pectoral chest front
    chest_m = (pts[:, 1] > 0.96) & (pts[:, 1] < 1.12) & (np.abs(pts[:, 0]) < 0.08) & (pts[:, 2] > 0.45)
    chest_z = float(np.percentile(pts[chest_m, 2], 97)) if np.any(chest_m) else 0.67
    sh_rx = barrel_rx_at(0.42, 0.94, 1.18) + 0.012
    sad_front_rx = barrel_rx_at(0.20, 1.00, 1.22) + 0.014
    add_tapered_tube(bm_lth, [
        (-sad_front_rx + 0.02, y_pom_base - 0.06, 0.21),
        (-sh_rx, 1.08, 0.43),
        (-0.135, 1.02, chest_z - 0.03),
        (0.0, 1.00, chest_z + 0.012),
        (0.135, 1.02, chest_z - 0.03),
        (sh_rx, 1.08, 0.43),
        (sad_front_rx - 0.02, y_pom_base - 0.06, 0.21),
    ], [0.014] * 7, segs=6)

    # Crupper (`rabicho`) running along the measured croup spine to the tail dock
    add_tapered_tube(bm_lth, [
        (0.0, dorsal_y_at(-0.24) + 0.014, -0.24),
        (0.0, dorsal_y_at(-0.46) + 0.012, -0.46),
        (0.0, dorsal_y_at(-0.68) + 0.010, -0.68),
    ], [0.012] * 3, segs=6)

    # Dual stuffed courier leather `alforjas` saddlebags hugging croup flanks + stirrup leathers (`loros`)
    croup_rx = barrel_rx_at(-0.31, 0.92, 1.20)
    stirrup_x = max(0.335, round(cloth_max_rx + 0.085, 3))
    stirrup_z = 0.04
    stirrup_eye_y = 0.890
    stirrup_bar_center_y = 0.770
    stirrup_bar_r = 0.020
    stirrup_bar_top_y = stirrup_bar_center_y + stirrup_bar_r
    for sx in (-1.0, 1.0):
        add_ellipsoid(
            bm_lth,
            (sx * (croup_rx + 0.036), dorsal_y_at(-0.31) - 0.105, -0.31),
            (0.068, 0.115, 0.108),
            rot_euler=(0.0, 0.0, sx * 0.20),
            u_segs=12,
            v_segs=8,
        )
        add_tapered_tube(bm_lth, [
            (sx * (barrel_rx_at(0.02) + 0.014), spine_hollow_y - 0.03, 0.02),
            (sx * (cloth_max_rx + 0.022), 1.020, 0.03),
            (sx * stirrup_x, stirrup_eye_y, stirrup_z),
        ], [0.014, 0.013, 0.011], segs=6)

    parts.append(extract_part_records(bm_lth, 9.0, lambda _i, p, n: pack_tack_coat(4, ao_shade(p.y, 1.55, n.y))))
    bm_lth.free()

    # 3. Forged iron `à gineta` box stirrups (`estribos`, zone = 5, part = 9.0) + pectoral boss
    bm_irn = bmesh.new()
    add_ellipsoid(bm_irn, (0.0, 1.00, chest_z + 0.018), (0.034, 0.034, 0.016), u_segs=10, v_segs=6)
    for sx in (-1.0, 1.0):
        cx = sx * stirrup_x
        add_tapered_tube(bm_irn, [
            (cx, stirrup_eye_y, stirrup_z),
            (cx - sx * 0.044, 0.830, stirrup_z),
            (cx - sx * 0.048, stirrup_bar_center_y, stirrup_z),
            (cx + sx * 0.048, stirrup_bar_center_y, stirrup_z),
            (cx + sx * 0.044, 0.830, stirrup_z),
            (cx, stirrup_eye_y, stirrup_z),
        ], [0.011, 0.012, stirrup_bar_r, stirrup_bar_r, 0.012, 0.011], segs=6)
    parts.append(extract_part_records(bm_irn, 9.0, lambda _i, p, n: pack_tack_coat(5, ao_shade(p.y, 1.55, n.y))))
    bm_irn.free()

    # 4. Headstall bridle, noseband, curb bit & looped leather reins fitted directly to measured 3D skull/muzzle!
    def measure_head_slice(y_lo, y_hi):
        m = (pts[:, 2] > 0.78) & (pts[:, 1] >= y_lo) & (pts[:, 1] <= y_hi)
        sub = pts[m]
        if len(sub) < 5:
            return 0.0, 0.5 * (y_lo + y_hi), 0.96, 0.08, 0.08
        z_max = float(sub[:, 2].max())
        sub = sub[sub[:, 2] >= z_max - 0.18]
        x0, x1 = float(np.percentile(sub[:, 0], 3)), float(np.percentile(sub[:, 0], 97))
        z0, z1 = float(np.percentile(sub[:, 2], 4)), float(np.percentile(sub[:, 2], 97))
        return 0.5 * (x0 + x1), 0.5 * (y_lo + y_hi), 0.5 * (z0 + z1), 0.5 * (x1 - x0), 0.5 * (z1 - z0)

    poll_cx, poll_cy, poll_cz, poll_rx, poll_rz = measure_head_slice(1.71, 1.76)
    cheek_cx, cheek_cy, cheek_cz, cheek_rx, _ = measure_head_slice(1.51, 1.57)
    nose_cx, nose_cy, nose_cz, nose_rx, nose_rz = measure_head_slice(1.33, 1.38)
    bit_cx, bit_cy, bit_cz, bit_rx, _ = measure_head_slice(1.28, 1.33)

    # Estimate head horizontal yaw so noseband & bit align perpendicular to nasal bridge
    head_dx = bit_cx - poll_cx
    head_dz = max(0.10, bit_cz - poll_cz)
    head_yaw = math.atan2(head_dx, head_dz)
    hx_r, hz_r = math.cos(head_yaw), -math.sin(head_yaw)  # head-local right vector in XZ
    hx_f, hz_f = math.sin(head_yaw), math.cos(head_yaw)   # head-local forward vector in XZ

    bm_brd = bmesh.new()
    # Noseband (`focinho`) wrapping cleanly around the measured nasal bridge & jaw
    nb_rx = max(0.062, nose_rx * 0.88 + 0.008)
    nb_rz = max(0.062, nose_rz * 0.88 + 0.008)
    nose_ring = []
    for k in range(9):
        a = (k / 8.0) * 2.0 * math.pi
        ca, sa = math.cos(a), math.sin(a)
        px = nose_cx + hx_r * (ca * nb_rx) + hx_f * (sa * nb_rz * 0.65)
        py = nose_cy + sa * 0.052
        pz = nose_cz + hz_r * (ca * nb_rx) + hz_f * (sa * nb_rz * 0.65)
        nose_ring.append((px, py, pz))
    add_tapered_tube(bm_brd, nose_ring, [0.010] * len(nose_ring), segs=6, cap_start=False, cap_end=False)

    # Cheekpieces from noseband/bit up both cheeks over the poll crownpiece behind ears + browband
    ck_rx = max(0.075, cheek_rx * 0.90 + 0.008)
    pl_rx = max(0.065, poll_rx * 0.82 + 0.006)
    add_tapered_tube(bm_brd, [
        (nose_cx - hx_r * nb_rx, nose_cy, nose_cz - hz_r * nb_rx),
        (cheek_cx - hx_r * ck_rx, cheek_cy, cheek_cz - hz_r * ck_rx),
        (poll_cx - hx_r * pl_rx, poll_cy + 0.01, poll_cz - hz_r * pl_rx - 0.015),
        (poll_cx, poll_cy + 0.032, poll_cz - 0.022),
        (poll_cx + hx_r * pl_rx, poll_cy + 0.01, poll_cz + hz_r * pl_rx - 0.015),
        (cheek_cx + hx_r * ck_rx, cheek_cy, cheek_cz + hz_r * ck_rx),
        (nose_cx + hx_r * nb_rx, nose_cy, nose_cz + hz_r * nb_rx),
    ], [0.010] * 7, segs=6)

    # Looped leather reins draping naturally along neck flanks from curb bit shanks to bridle hand above pommel!
    rein_hand_y = pommel_top_y + 0.055
    rein_hand_z = 0.22
    bt_rx = max(0.058, bit_rx * 0.92 + 0.010)
    neck_hi_rx = barrel_rx_at(0.66, 1.24, 1.52) + 0.018
    neck_lo_rx = barrel_rx_at(0.44, 1.18, 1.46) + 0.018
    for sx in (-1.0, 1.0):
        bx = bit_cx + sx * hx_r * bt_rx
        bz = bit_cz + sx * hz_r * bt_rx
        add_tapered_tube(bm_brd, [
            (bx, bit_cy - 0.045, bz + 0.01),
            (0.45 * bx + sx * neck_hi_rx, 1.29, 0.72),
            (sx * neck_lo_rx, 1.34, 0.45),
            (0.02 + sx * 0.024, rein_hand_y, rein_hand_z),
        ], [0.0085] * 4, segs=6)

    piv_z = neck_pivot[2]
    span_z = max(0.35, bit_cz - piv_z)

    def bridle_part(p):
        if p.z <= 0.30:
            return 9.0  # rear rein loop at rider's hand stays anchored to saddle pommel
        w = max(0.02, min(0.95, (p.z - 0.30) / max(0.35, bit_cz - 0.30) * 0.88 + max(0.0, p.y - 1.32) / 0.50 * 0.12))
        return 10.0 + w

    parts.append(extract_part_records(bm_brd, bridle_part, lambda _i, p, n: pack_tack_coat(4, ao_shade(p.y, 1.84, n.y))))
    bm_brd.free()

    # 5. Forged iron curb bit shanks & mouthpiece (`zone = 5`, `part = 10.92`)
    bm_bit = bmesh.new()
    for sx in (-1.0, 1.0):
        bx = bit_cx + sx * hx_r * bt_rx
        bz = bit_cz + sx * hz_r * bt_rx
        add_tapered_tube(bm_bit, [(bx, bit_cy + 0.018, bz), (bx + sx * 0.006, bit_cy - 0.055, bz + 0.015)], [0.010, 0.008], segs=6)
    add_tapered_tube(
        bm_bit,
        [(bit_cx - hx_r * bt_rx, bit_cy - 0.005, bit_cz - hz_r * bt_rx), (bit_cx + hx_r * bt_rx, bit_cy - 0.005, bit_cz + hz_r * bt_rx)],
        [0.007, 0.007],
        segs=6,
    )
    parts.append(extract_part_records(bm_bit, 10.92, lambda _i, p, n: pack_tack_coat(5, ao_shade(p.y, 1.84, n.y))))
    bm_bit.free()

    print(
        f"[tack] Tripo H3.1 gineta fit: spine_hollow_y={spine_hollow_y:.4f} "
        f"saddle_seat_top_y={saddle_seat_top_y:.4f} pommel_top_y={pommel_top_y:.4f} "
        f"barrel_max_rx={cloth_max_rx:.4f} stirrup_x={stirrup_x:.4f} stirrup_bar_top_y={stirrup_bar_top_y:.4f}"
    )
    return parts


def build_horse(tripo_dir):
    meta = {"name": "horse", "neckPivot": (0.0, 1.22, 0.54), "legY": 0.90, "frontZ": 0.50, "backZ": -0.58, "height": 1.84, "targetFaces": 14000}
    glb = find_tripo_glb(tripo_dir, "horse")
    vert_rgb = None
    if glb:
        print(f"[tripo] Importing cached horse GLB: {glb}")
        bm, vert_rgb = import_tripo_quadruped(glb, meta)
    else:
        clear_scene()
        bm = bmesh.new()
        stations = [
            (1.22, -0.78, 0.165, 0.205, 0.205),
            (1.18, -0.58, 0.28, 0.315, 0.325),
            (1.14, -0.22, 0.30, 0.305, 0.325),
            (1.14,  0.16, 0.295, 0.335, 0.365),
            (1.19,  0.48, 0.26, 0.35, 0.385),
            (1.37,  0.64, 0.15, 0.22, 0.165),
            (1.57,  0.76, 0.115, 0.165, 0.125),
            (1.69,  0.84, 0.098, 0.105, 0.102),
            (1.57,  0.98, 0.070, 0.070, 0.066),
            (1.46,  1.105, 0.052, 0.050, 0.048),
        ]
        build_spine_loft(bm, stations, segs=32, anatomical_ribs=0.012)
        add_ellipsoid(bm, (0.0, 1.08, 0.52), (0.19, 0.17, 0.16))
        add_ellipsoid(bm, (0.0, 1.38, 0.42), (0.11, 0.15, 0.20))
        add_tapered_tube(bm, [(0.0, 1.46, 0.48), (0.024, 1.63, 0.65), (0.020, 1.76, 0.80)], [(0.032, 0.085), (0.036, 0.095), (0.026, 0.065)], segs=12)
        for sx in (-1.0, 1.0):
            add_ellipsoid(bm, (sx * 0.175, 1.08, 0.46), (0.115, 0.23, 0.18), rot_euler=(0.24, 0.0, 0.0))
            add_ellipsoid(bm, (sx * 0.185, 1.12, -0.56), (0.135, 0.25, 0.22), rot_euler=(-0.15, 0.0, 0.0))
            add_ellipsoid(bm, (sx * 0.068, 1.59, 0.89), (0.042, 0.058, 0.065))
            add_tapered_tube(bm, [(sx * 0.055, 1.74, 0.82), (sx * 0.074, 1.83, 0.83), (sx * 0.062, 1.89, 0.84)], [0.028, 0.019, 0.007], segs=10)
        add_tapered_tube(bm, [(0.0, 1.28, -0.77), (0.0, 1.05, -0.90), (0.0, 0.68, -0.95), (0.0, 0.34, -0.92)], [0.052, 0.078, 0.070, 0.028], segs=14)
        for lx, lz in [(-0.165, 0.50), (0.165, 0.50), (-0.175, -0.58), (0.175, -0.58)]:
            hz = lz + (0.018 if lz > 0 else -0.065)
            pts = [(lx * 0.88, 0.96, lz), (lx, 0.65, lz - 0.01), (lx, 0.48, hz), (lx, 0.16, lz), (lx, 0.065, lz + 0.012), (lx, 0.0, lz + 0.028)]
            rads = [(0.115, 0.145) if lz < 0 else (0.102, 0.122), (0.070, 0.084), (0.048, 0.056), 0.035, 0.039, (0.048, 0.054)]
            add_tapered_tube(bm, pts, rads, segs=14, cloven=False)
        bm = voxel_unify_and_decimate(bm, "horse", voxel_size=0.013, target_faces=4200, smooth_iters=3)

    rig = measure_quadruped_rig(bm, meta["height"])
    meta.update({k: rig[k] for k in ("neckPivot", "legY", "frontZ", "backZ")})
    print(f"[rig] horse: neckPivot={meta['neckPivot']} legY={meta['legY']} frontZ={meta['frontZ']} backZ={meta['backZ']} leg_top_y={rig['leg_top_y']:.3f}")

    def coat_fn(i, p, n):
        if vert_rgb is not None:
            return pack_rgb555(vert_rgb[i, 0], vert_rgb[i, 1], vert_rgb[i, 2])
        if p.z < -0.75 or p.y < 0.20:
            return pack_rgb555(0.035, 0.032, 0.030)
        return pack_rgb555(0.22, 0.095, 0.048)

    horse_parts = [extract_part_records(bm, lambda p: classify_quadruped_part(p, rig), coat_fn)]
    horse_parts.extend(build_gineta_saddle_and_tack(bm, meta["neckPivot"]))
    bm.free()
    v, idx = merge_parts(horse_parts)
    return {**meta, "verts": v, "indices": idx}


def unpack_rgb555_gamma(c):
    c = int(c)
    return (((c >> 10) & 31) / 31.0, ((c >> 5) & 31) / 31.0, (c & 31) / 31.0)


def build_progressive_collapse(verts, indices, target_core_tris=20):
    """Computes a priority-queue half-edge collapse continuum for Rule-3 GPU interpolation.
    Returns (sorted_indices, morph_words, core_tri_count, total_steps).
    """
    n_verts = len(verts)
    pos = [Vector((v[0], v[1], v[2])) for v in verts]
    nrm = [Vector((v[3], v[4], v[5])) for v in verts]
    part = [int(math.floor(v[6] + 1e-4)) for v in verts]
    coat_raw = [v[7] for v in verts]
    tack_zone = [int(math.floor((-c) * 0.001 + 1e-4)) if c < 0 else 0 for c in coat_raw]
    gamma_rgb = [unpack_rgb555_gamma(c) if c > 0 else (0.0, 0.0, 0.0) for c in coat_raw]

    max_y = max((p.y for p in pos), default=1.0)
    max_abs_z = max((abs(p.z) for p in pos), default=1.0)

    tris = []
    v_tris = [set() for _ in range(n_verts)]
    for t_id in range(0, len(indices), 3):
        a, b, c = indices[t_id], indices[t_id + 1], indices[t_id + 2]
        if a == b or b == c or c == a:
            continue
        ti = len(tris)
        tris.append([a, b, c, True])
        v_tris[a].add(ti)
        v_tris[b].add(ti)
        v_tris[c].add(ti)

    alive_v = [True] * n_verts
    parent = list(range(n_verts))
    collapse_step = [-1] * n_verts
    tri_retire = [10**9] * len(tris)

    def root_of(u):
        while parent[u] != u:
            u = parent[u]
        return u

    def edge_cost(u, v):
        du = pos[u] - pos[v]
        dist = du.length
        ndot = max(-1.0, min(1.0, nrm[u].dot(nrm[v])))
        curv = 1.0 + 1.8 * (1.0 - ndot)
        tack_u = part[u] >= 9
        tack_v = part[v] >= 9
        if tack_u and not tack_v:
            return dist * 0.35
        if not tack_u and tack_v:
            return 1e6
        part_pen = 1.0 if part[u] == part[v] else (2.4 if (part[u] <= 6 and part[v] <= 6) else 8.0)
        if tack_u and tack_v:
            zone_pen = 1.0 if tack_zone[u] == tack_zone[v] else 1.25
        else:
            cu, cv = gamma_rgb[u], gamma_rgb[v]
            cdiff = abs(cu[0] - cv[0]) + abs(cu[1] - cv[1]) + abs(cu[2] - cv[2])
            zone_pen = 1.0 + 0.35 * cdiff
        sil_pen = 1.65 if (pos[u].y < 0.04 * max_y or abs(pos[u].z) > 0.82 * max_abs_z or pos[u].y > 0.94 * max_y) else 1.0
        return dist * curv * part_pen * zone_pen * sil_pen

    heap = []
    ver = [0] * n_verts

    def push_vertex_edges(u):
        if not alive_v[u]:
            return
        nbrs = set()
        for ti in v_tris[u]:
            t = tris[ti]
            if not t[3]:
                continue
            for w in t[:3]:
                if w != u and alive_v[w]:
                    nbrs.add(w)
        for v in nbrs:
            c = edge_cost(u, v)
            if c < 1e5:
                heapq.heappush(heap, (c, ver[u], u, v))

    for u in range(n_verts):
        push_vertex_edges(u)

    alive_tris = len(tris)
    step = 0
    while heap and alive_tris > target_core_tris:
        cost, vu, u, v = heapq.heappop(heap)
        if not alive_v[u] or vu != ver[u]:
            continue
        v = root_of(v)
        if u == v or not alive_v[v]:
            continue

        flipped = False
        affected = list(v_tris[u])
        retired_here = sum(1 for ti in affected if tris[ti][3] and v in tris[ti][:3])
        if alive_tris - retired_here < target_core_tris:
            continue
        for ti in affected:
            t = tris[ti]
            if not t[3] or v in t[:3]:
                continue
            ia, ib, ic = t[0], t[1], t[2]
            pa = pos[v] if ia == u else pos[ia]
            pb = pos[v] if ib == u else pos[ib]
            pc = pos[v] if ic == u else pos[ic]
            old_n = (pos[ib] - pos[ia]).cross(pos[ic] - pos[ia])
            new_n = (pb - pa).cross(pc - pa)
            if new_n.length < 1e-8 or (old_n.length > 1e-8 and old_n.normalized().dot(new_n.normalized()) < 0.15):
                flipped = True
                break
        if flipped:
            continue

        alive_v[u] = False
        parent[u] = v
        collapse_step[u] = step
        step += 1
        for ti in affected:
            t = tris[ti]
            if not t[3]:
                continue
            if v in t[:3]:
                t[3] = False
                tri_retire[ti] = step
                alive_tris -= 1
                for w in t[:3]:
                    if w != u:
                        v_tris[w].discard(ti)
            else:
                for k in range(3):
                    if t[k] == u:
                        t[k] = v
                v_tris[v].add(ti)
        v_tris[u].clear()
        ver[v] += 1
        push_vertex_edges(v)

    total_steps = max(1, step)
    orig_tris = [(indices[k], indices[k + 1], indices[k + 2]) for k in range(0, len(indices), 3)]
    valid_orig = [t for t in orig_tris if t[0] != t[1] and t[1] != t[2] and t[2] != t[0]]
    ranked = sorted(enumerate(valid_orig), key=lambda kv: -tri_retire[kv[0]])
    sorted_indices = []
    core_tris = 0
    for ti, (a, b, c) in ranked:
        sorted_indices.extend([a, b, c])
        if tri_retire[ti] >= 10**8:
            core_tris += 1

    morph_words = []
    span_q16 = int(round(0.10 * 65535))
    for u in range(n_verts):
        if collapse_step[u] < 0:
            p_idx = u
            gp_idx = u
            start_q16 = 65535
        else:
            p_idx = parent[u]
            gp_idx = parent[p_idx] if collapse_step[p_idx] >= 0 else p_idx
            norm_s = (collapse_step[u] / float(total_steps)) * 0.88
            start_q16 = max(0, min(65534, int(round(norm_s * 65535))))
        w0 = (p_idx & 0xFFFF) | ((start_q16 & 0xFFFF) << 16)
        w1 = (span_q16 & 0xFFFF) | ((gp_idx & 0xFFFF) << 16)
        morph_words.extend([w0, w1])

    return sorted_indices, morph_words, core_tris, total_steps


def pack_livestock_binary(species_list, out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    # Version 2: adds per-vertex uint16 (u, v) texture coordinates (20 bytes/vert) and omits legacy
    # per-vertex morph tables (superseded by scripts/prepare-animal-continuum.mjs).
    chunks = [struct.pack("<4sIII", b"LSTK", 2, len(species_list), 0)]
    for sp in species_list:
        raw_verts = sp["verts"]
        # Pre-quantize positions to int16 millimeters and strip any sub-mm degenerate triangles
        verts = []
        q_pos = []
        for r in raw_verts:
            qx = max(-32767, min(32767, int(round(r[0] * 1000.0)))) * 0.001
            qy = max(-32767, min(32767, int(round(r[1] * 1000.0)))) * 0.001
            qz = max(-32767, min(32767, int(round(r[2] * 1000.0)))) * 0.001
            u_val = float(r[8]) if len(r) > 8 else 0.0
            v_val = float(r[9]) if len(r) > 9 else 0.0
            verts.append((qx, qy, qz, r[3], r[4], r[5], r[6], r[7], u_val, v_val))
            q_pos.append(Vector((qx, qy, qz)))
        clean_indices = []
        raw_idx = sp["indices"]
        for k in range(0, len(raw_idx), 3):
            a, b, c = raw_idx[k], raw_idx[k + 1], raw_idx[k + 2]
            if a == b or b == c or c == a:
                continue
            area2 = (q_pos[b] - q_pos[a]).cross(q_pos[c] - q_pos[a]).length
            if area2 > 1.5e-7:
                clean_indices.extend([a, b, c])
        vc = len(verts)
        ic = len(clean_indices)
        use_u32_idx = vc >= 65535
        print(f"Packed {sp['name']} (v2 UV): {vc} verts, {ic // 3} tris")
        meta = struct.pack(
            "<8f4I",
            sp["neckPivot"][0], sp["neckPivot"][1], sp["neckPivot"][2],
            sp["legY"], sp["frontZ"], sp["backZ"], sp["height"], 0.0,
            vc, ic, 0, 1 if use_u32_idx else 0,
        )
        chunks.append(meta)
        v_buf = bytearray(vc * 20)
        for i, r in enumerate(verts):
            px = max(-32767, min(32767, int(round(r[0] * 1000.0))))
            py = max(-32767, min(32767, int(round(r[1] * 1000.0))))
            pz = max(-32767, min(32767, int(round(r[2] * 1000.0))))
            nx = max(-16384, min(16384, int(round(r[3] * 16384.0))))
            ny = max(-16384, min(16384, int(round(r[4] * 16384.0))))
            nz = max(-16384, min(16384, int(round(r[5] * 16384.0))))
            pt = max(-32767, min(32767, int(round(r[6] * 1000.0))))
            ct = max(-32767, min(32767, int(round(r[7]))))
            u16 = max(0, min(65535, int(round(max(0.0, min(1.0, r[8])) * 65535.0))))
            v16 = max(0, min(65535, int(round(max(0.0, min(1.0, r[9])) * 65535.0))))
            struct.pack_into("<8h2H", v_buf, i * 20, px, py, pz, nx, ny, nz, pt, ct, u16, v16)
        chunks.append(bytes(v_buf))

        if use_u32_idx:
            i_buf = bytearray(ic * 4)
            for k, idx_val in enumerate(clean_indices):
                struct.pack_into("<I", i_buf, k * 4, idx_val)
        else:
            i_buf = bytearray(ic * 2 + ((ic * 2) % 4))
            for k, idx_val in enumerate(clean_indices):
                struct.pack_into("<H", i_buf, k * 2, idx_val)
        chunks.append(bytes(i_buf))

    blob = b"".join(chunks)
    with open(out_path, "wb") as f:
        f.write(blob)
    print(f"Wrote {out_path} ({len(blob) / 1024.0:.1f} KB)")


def main():
    tripo_dir = parse_cli()
    species = [
        build_sheep(tripo_dir),
        build_cattle(tripo_dir),
        build_swine(tripo_dir),
        build_horse(tripo_dir),
    ]
    pack_livestock_binary(species, OUT_BIN)


if __name__ == "__main__":
    main()
