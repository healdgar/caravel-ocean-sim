#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Bakes high-detail organic 16th-century livestock & horse tack meshes plus
Rule-3 progressive half-edge collapse continuum tables into assets/wildlife/livestock-1550.bin.

Supports two input paths per species (0=sheep, 1=cattle, 2=swine, 3=horse):
  1. Tripo 3D V3 GLBs cached under .tripo/livestock/<species>/**/*.glb (from `npm run tripo:livestock -- generate`)
  2. Seamless Blender 5.2 voxel-remeshed + Laplacian-smoothed anatomical muscle/skeletal volumes
     (eliminating disjoint primitive tube seams) + 3D 1550 Iberian `sela à gineta` horse saddle,
     iron stirrups, bridle, reins, and courier `alforjas` saddlebags.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/bake-livestock-meshes.py -- [--from-tripo .tripo/livestock]
"""
import os
import sys
import glob
import math
import heapq
import struct
import bpy
import bmesh
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_BIN = os.path.join(ROOT, "assets", "wildlife", "livestock-1550.bin")

# Coordinate convention exported to Waterworld:
#   X = right, Y = up (0 at ground), Z = forward (+Z is nose, -Z is tail).

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
            # Anatomical dorsal spine furrow & muscular flank fullness
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
        # Rx
        y, z = y * cx_r - z * sx_r, y * sx_r + z * cx_r
        # Ry
        x, z = x * cy_r + z * sy_r, -x * sy_r + z * cy_r
        # Rz
        x, y = x * cz_r - y * sz_r, x * sz_r + y * cz_r
        v.co = Vector((cx + x, cy + y, cz + z))

def voxel_unify_and_decimate(bm, name, voxel_size, target_faces, smooth_iters=3):
    """Converts multi-volume anatomical sculpt into a single seamless watertight organic manifold."""
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
    # Ground hooves cleanly at y = 0
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
    verts = []
    for v in bm.verts:
        p = v.co
        n = v.normal.normalized() if v.normal.length > 1e-6 else Vector((0, 1, 0))
        part_val = part_code(p) if callable(part_code) else float(part_code)
        coat_val = coat_fn(p, n)
        verts.append((p.x, p.y, p.z, n.x, n.y, n.z, part_val, coat_val))
    indices = []
    for f in bm.faces:
        v0, v1, v2 = f.verts[0], f.verts[1], f.verts[2]
        fn = (v1.co - v0.co).cross(v2.co - v0.co)
        avg_n = v0.normal + v1.normal + v2.normal
        if avg_n.length < 1e-6:
            avg_n = fn
        if fn.dot(avg_n) < 0:
            indices.extend([v0.index, v2.index, v1.index])
        else:
            indices.extend([v0.index, v1.index, v2.index])
    return verts, indices

def merge_parts(parts):
    all_verts, all_idx, base = [], [], 0
    for v, idx in parts:
        all_verts.extend(v)
        all_idx.extend([i + base for i in idx])
        base += len(v)
    return all_verts, all_idx

def classify_quadruped_part(p, neck_z, leg_top_y, front_z, back_z, tail_z, neck_max_span, base_y_neck):
    if p.z < tail_z and p.y > leg_top_y * 0.72:
        return 6.0
    if p.y < leg_top_y and abs(p.x) > 0.035 and (abs(p.z - front_z) < abs(front_z - back_z) * 0.48 or abs(p.z - back_z) < abs(front_z - back_z) * 0.48):
        is_front = p.z >= 0.5 * (front_z + back_z)
        is_right = p.x >= 0.0
        if is_front:
            return 3.0 if is_right else 2.0
        return 5.0 if is_right else 4.0
    if p.z > neck_z and p.y > base_y_neck:
        w = max(0.02, min(0.98, (p.z - neck_z) / max(0.15, neck_max_span) * 0.68 + max(0.0, p.y - base_y_neck) / 0.45 * 0.32))
        return 1.0 + w
    return 0.0

def find_tripo_glb(tripo_dir, species_name):
    sp_dir = os.path.join(tripo_dir, species_name)
    if not os.path.isdir(sp_dir):
        return None
    glbs = sorted(glob.glob(os.path.join(sp_dir, "**", "*.glb"), recursive=True))
    return glbs[-1] if glbs else None

def import_tripo_quadruped(glb_path, spec_meta):
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=glb_path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Orient longest horizontal axis along Z (+Z forward toward taller poll/head end)
    verts_w = [v.co.copy() for v in obj.data.vertices]
    min_x, max_x = min(v.x for v in verts_w), max(v.x for v in verts_w)
    min_y, max_y = min(v.y for v in verts_w), max(v.y for v in verts_w)
    min_z, max_z = min(v.z for v in verts_w), max(v.z for v in verts_w)
    # Note: Blender glTF importer maps glTF +Y up -> Blender +Z up!
    # Convert Blender (X right, -Y forward, +Z up) -> Waterworld (X right, +Y up, +Z forward)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for v in bm.verts:
        bx, by, bz = v.co.x, v.co.y, v.co.z
        v.co = Vector((bx, bz, -by))
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    zs = [v.co.z for v in bm.verts]
    if (max(xs) - min(xs)) > (max(zs) - min(zs)):
        for v in bm.verts:
            v.co = Vector((-v.co.z, v.co.y, v.co.x))
    zs = [v.co.z for v in bm.verts]
    mid_z = 0.5 * (min(zs) + max(zs))
    pos_top = max((v.co.y for v in bm.verts if v.co.z >= mid_z), default=0.0)
    neg_top = max((v.co.y for v in bm.verts if v.co.z < mid_z), default=0.0)
    if neg_top > pos_top + 0.02:
        for v in bm.verts:
            v.co = Vector((-v.co.x, v.co.y, -v.co.z))

    min_y = min(v.co.y for v in bm.verts)
    max_y = max(v.co.y for v in bm.verts)
    cx = 0.5 * (min(v.co.x for v in bm.verts) + max(v.co.x for v in bm.verts))
    cz = 0.5 * (min(v.co.z for v in bm.verts) + max(v.co.z for v in bm.verts))
    scale = spec_meta["height"] / max(0.05, max_y - min_y)
    for v in bm.verts:
        v.co = Vector(((v.co.x - cx) * scale, (v.co.y - min_y) * scale, (v.co.z - cz) * scale))

    # Decimate cleanly if above runtime budget (2,400 tris)
    mesh_tmp = bpy.data.meshes.new("tripo_fit")
    bm.to_mesh(mesh_tmp)
    bm.free()
    fit_obj = bpy.data.objects.new("tripo_fit_obj", mesh_tmp)
    bpy.context.collection.objects.link(fit_obj)
    bpy.context.view_layer.objects.active = fit_obj
    if len(fit_obj.data.polygons) > 2200:
        dec = fit_obj.modifiers.new(name="TripoDec", type="DECIMATE")
        dec.decimate_type = "COLLAPSE"
        dec.ratio = 2200.0 / float(len(fit_obj.data.polygons))
        dec.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=dec.name)
    out_bm = bmesh.new()
    out_bm.from_mesh(fit_obj.data)
    bpy.data.objects.remove(fit_obj, do_unlink=True)
    return out_bm

def build_sheep(tripo_dir):
    meta = {"name": "sheep", "neckPivot": (0.0, 0.56, 0.28), "legY": 0.36, "frontZ": 0.26, "backZ": -0.30, "height": 0.82}
    glb = find_tripo_glb(tripo_dir, "sheep")
    if glb:
        print(f"[tripo] Importing cached sheep GLB: {glb}")
        bm = import_tripo_quadruped(glb, meta)
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
        # Organic shoulder & haunch fleece masses + poll cap + jaw/cheeks
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
        bm = voxel_unify_and_decimate(bm, "sheep", voxel_size=0.010, target_faces=1750, smooth_iters=2)

    def part_fn(p):
        return classify_quadruped_part(p, neck_z=0.26, leg_top_y=0.35, front_z=0.26, back_z=-0.30, tail_z=-0.46, neck_max_span=0.38, base_y_neck=0.50)
    def coat_fn(p, n):
        sh = ao_shade(p.y, 0.84, n.y)
        if (p.z > 0.49 and p.y < 0.745) or (abs(p.x) > 0.105 and p.z > 0.40 and p.y > 0.66) or p.y < 0.21:
            return 1.0 + sh
        return 0.0 + sh
    v, idx = extract_part_records(bm, part_fn, coat_fn)
    bm.free()
    return {**meta, "verts": v, "indices": idx}

def build_cattle(tripo_dir):
    meta = {"name": "cattle", "neckPivot": (0.0, 1.06, 0.62), "legY": 0.78, "frontZ": 0.56, "backZ": -0.64, "height": 1.52}
    glb = find_tripo_glb(tripo_dir, "cattle")
    if glb:
        print(f"[tripo] Importing cached cattle GLB: {glb}")
        bm = import_tripo_quadruped(glb, meta)
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
        # Sculpted withers hump, brisket dewlap fold, scapula, pelvic pin-bones, thighs, ears, lyre horns
        add_ellipsoid(bm, (0.0, 1.28, 0.46), (0.15, 0.14, 0.24))
        add_ellipsoid(bm, (0.0, 0.68, 0.58), (0.075, 0.18, 0.26), rot_euler=(-0.32, 0.0, 0.0))
        for sx in (-1.0, 1.0):
            add_ellipsoid(bm, (sx * 0.20, 0.92, 0.52), (0.12, 0.22, 0.18), rot_euler=(0.18, 0.0, 0.0))
            add_ellipsoid(bm, (sx * 0.21, 0.96, -0.60), (0.135, 0.24, 0.21))
            add_ellipsoid(bm, (sx * 0.17, 1.21, -0.74), (0.075, 0.065, 0.11))
            add_ellipsoid(bm, (sx * 0.105, 1.13, 0.98), (0.048, 0.045, 0.055))
            # Sweeping Iberian Barrosã lyre horns
            add_tapered_tube(bm, [
                (sx * 0.11, 1.25, 0.90),
                (sx * 0.25, 1.33, 0.91),
                (sx * 0.36, 1.44, 0.98),
                (sx * 0.34, 1.54, 1.06),
                (sx * 0.29, 1.60, 1.11),
            ], [0.046, 0.036, 0.025, 0.015, 0.007], segs=14)
            add_tapered_tube(bm, [
                (sx * 0.13, 1.19, 0.88),
                (sx * 0.24, 1.16, 0.86),
                (sx * 0.29, 1.15, 0.85),
            ], [0.042, 0.035, 0.014], segs=12)
        add_tapered_tube(bm, [(0.0, 1.14, -0.84), (0.0, 0.84, -0.94), (0.0, 0.50, -0.95), (0.0, 0.35, -0.94)], [0.044, 0.028, 0.048, 0.018], segs=12)
        for lx, lz in [(-0.19, 0.56), (0.19, 0.56), (-0.20, -0.64), (0.20, -0.64)]:
            hz = lz + (0.022 if lz > 0 else -0.060)
            pts = [(lx * 0.88, 0.86, lz), (lx, 0.57, lz - 0.01), (lx, 0.42, hz), (lx, 0.14, lz), (lx, 0.05, lz + 0.012), (lx, 0.0, lz + 0.028)]
            rads = [(0.125, 0.155) if lz < 0 else (0.115, 0.135), (0.082, 0.096), (0.056, 0.064), 0.040, 0.044, (0.050, 0.058)]
            add_tapered_tube(bm, pts, rads, segs=14, cloven=True)
        bm = voxel_unify_and_decimate(bm, "cattle", voxel_size=0.014, target_faces=2050, smooth_iters=3)

    def part_fn(p):
        return classify_quadruped_part(p, neck_z=0.58, leg_top_y=0.76, front_z=0.56, back_z=-0.64, tail_z=-0.85, neck_max_span=0.62, base_y_neck=0.68)
    def coat_fn(p, n):
        sh = ao_shade(p.y, 1.56, n.y)
        if p.y > 1.25 and p.z > 0.84 and abs(p.x) > 0.12:
            return 1.0 + sh  # keratin horns
        if (p.z > 1.12 and p.y < 1.08) or p.y < 0.12:
            return 1.0 + sh  # dark wet muzzle & cloven hooves
        if p.z < -0.86 and p.y < 0.58:
            return 3.0 + sh  # dark tail switch
        if p.y < 0.72 and abs(p.x) < 0.26 and abs(p.z) < 0.48:
            return 2.0 + sh  # pale belly
        return 0.0 + sh
    v, idx = extract_part_records(bm, part_fn, coat_fn)
    bm.free()
    return {**meta, "verts": v, "indices": idx}

def build_swine(tripo_dir):
    meta = {"name": "swine", "neckPivot": (0.0, 0.42, 0.28), "legY": 0.28, "frontZ": 0.25, "backZ": -0.30, "height": 0.66}
    glb = find_tripo_glb(tripo_dir, "swine")
    if glb:
        print(f"[tripo] Importing cached swine GLB: {glb}")
        bm = import_tripo_quadruped(glb, meta)
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
        bm = voxel_unify_and_decimate(bm, "swine", voxel_size=0.0095, target_faces=1550, smooth_iters=3)

    def part_fn(p):
        return classify_quadruped_part(p, neck_z=0.26, leg_top_y=0.27, front_z=0.25, back_z=-0.30, tail_z=-0.46, neck_max_span=0.38, base_y_neck=0.28)
    def coat_fn(p, n):
        sh = ao_shade(p.y, 0.66, n.y)
        if p.z > 0.59 or p.y < 0.075:
            return 1.0 + sh
        if p.y < 0.27 and abs(p.z) < 0.30:
            return 2.0 + sh
        return 0.0 + sh
    v, idx = extract_part_records(bm, part_fn, coat_fn)
    bm.free()
    return {**meta, "verts": v, "indices": idx}

def build_gineta_saddle_and_tack():
    """Builds 1550 Iberian `sela à gineta` high-cantle/pommel leather saddle, saddlecloth (`xairel`),
    stirrup leathers, iron stirrups (`estribos`), breastplate (`peitoral`), crupper (`rabicho`),
    messenger `alforjas` saddlebags (`part = 9.0`), plus headstall bridle & looped reins (`part = 10.0..10.94`).
    Zones: 4 = oiled Cordovan leather, 5 = forged iron hardware, 6 = dyed courier saddlecloth/alforjas.
    """
    parts = []
    # 1. Quilted saddlecloth (`xairel`, zone = 6) + molded `sela à gineta` saddle seat, high arçon pommel & cantle (`zone = 4`, `part = 9.0`)
    bm_sad = bmesh.new()
    # Draped saddlecloth hugging Lusitano back (z = -0.34 .. +0.30, y = 1.12 .. 1.48)
    cloth_z = [-0.34, -0.22, -0.08, 0.06, 0.18, 0.30]
    cloth_a = [-0.88, -0.58, -0.30, 0.0, 0.30, 0.58, 0.88]
    grid_out, grid_in = [], []
    for zc in cloth_z:
        row_o, row_i = [], []
        y_top = 1.465 + 0.025 * (zc * zc * 4.0)
        rx = 0.312 - 0.025 * abs(zc)
        for ang in cloth_a:
            sa, ca = math.sin(ang), math.cos(ang)
            xo = sa * rx
            yo = 1.15 + ca * (y_top - 1.15)
            xi = sa * (rx - 0.014)
            yi = 1.15 + ca * (y_top - 1.164)
            row_o.append(bm_sad.verts.new(Vector((xo, yo, zc))))
            row_i.append(bm_sad.verts.new(Vector((xi, yi, zc))))
        grid_out.append(row_o)
        grid_in.append(row_i)
    for iz in range(len(cloth_z) - 1):
        for ia in range(len(cloth_a) - 1):
            bm_sad.faces.new([grid_out[iz][ia], grid_out[iz + 1][ia], grid_out[iz + 1][ia + 1], grid_out[iz][ia + 1]])
            bm_sad.faces.new([grid_in[iz][ia], grid_in[iz][ia + 1], grid_in[iz + 1][ia + 1], grid_in[iz + 1][ia]])
    # Stitch rim of saddlecloth
    for iz in range(len(cloth_z) - 1):
        for side_i in (0, len(cloth_a) - 1):
            if side_i == 0:
                bm_sad.faces.new([grid_out[iz][0], grid_in[iz][0], grid_in[iz + 1][0], grid_out[iz + 1][0]])
            else:
                bm_sad.faces.new([grid_out[iz][-1], grid_out[iz + 1][-1], grid_in[iz + 1][-1], grid_in[iz][-1]])
    for ia in range(len(cloth_a) - 1):
        bm_sad.faces.new([grid_out[0][ia], grid_out[0][ia + 1], grid_in[0][ia + 1], grid_in[0][ia]])
        bm_sad.faces.new([grid_out[-1][ia], grid_in[-1][ia], grid_in[-1][ia + 1], grid_out[-1][ia + 1]])
    parts.append(extract_part_records(bm_sad, 9.0, lambda p, n: 6.0 + ao_shade(p.y, 1.65, n.y)))
    bm_sad.free()

    # 2. Leather `sela à gineta` seat, high pommel (`arzón delantero`), high cantle (`arzón trasero`), girth, breastplate, crupper & courier `alforjas` bags (`zone = 4`)
    bm_lth = bmesh.new()
    add_ellipsoid(bm_lth, (0.0, 1.48, -0.02), (0.19, 0.045, 0.22), u_segs=14, v_segs=8)
    # High curved Iberian pommel (z = +0.19, y = 1.56..1.63) & wrap-around cantle (z = -0.21, y = 1.55..1.62)
    add_tapered_tube(bm_lth, [(-0.14, 1.47, 0.18), (-0.07, 1.59, 0.20), (0.0, 1.63, 0.21), (0.07, 1.59, 0.20), (0.14, 1.47, 0.18)], [0.026, 0.032, 0.035, 0.032, 0.026], segs=8)
    add_tapered_tube(bm_lth, [(-0.17, 1.47, -0.18), (-0.11, 1.58, -0.22), (0.0, 1.61, -0.24), (0.11, 1.58, -0.22), (0.17, 1.47, -0.18)], [0.028, 0.035, 0.038, 0.035, 0.028], segs=8)
    # Leather girth (`cincha`) around ribcage, breastplate (`peitoral`) across chest, crupper (`rabicho`) to dock
    add_tapered_tube(bm_lth, [(-0.295, 1.24, 0.08), (-0.305, 0.96, 0.08), (-0.18, 0.77, 0.08), (0.0, 0.75, 0.08), (0.18, 0.77, 0.08), (0.305, 0.96, 0.08), (0.295, 1.24, 0.08)], [0.016]*7, segs=6)
    add_tapered_tube(bm_lth, [(-0.18, 1.42, 0.22), (-0.26, 1.22, 0.44), (-0.16, 1.14, 0.58), (0.0, 1.12, 0.61), (0.16, 1.14, 0.58), (0.26, 1.22, 0.44), (0.18, 1.42, 0.22)], [0.015]*7, segs=6)
    add_tapered_tube(bm_lth, [(0.0, 1.49, -0.24), (0.0, 1.47, -0.52), (0.0, 1.32, -0.76)], [0.013]*3, segs=6)
    # Dual stuffed courier leather `alforjas` saddlebags behind the cantle + stirrup leathers
    for sx in (-1.0, 1.0):
        add_ellipsoid(bm_lth, (sx * 0.275, 1.34, -0.32), (0.075, 0.125, 0.115), rot_euler=(0.0, 0.0, sx * 0.18), u_segs=12, v_segs=8)
        add_tapered_tube(bm_lth, [(sx * 0.23, 1.43, 0.02), (sx * 0.305, 1.21, 0.03), (sx * 0.30, 0.98, 0.04)], [0.014, 0.014, 0.012], segs=6)
    parts.append(extract_part_records(bm_lth, 9.0, lambda p, n: 4.0 + ao_shade(p.y, 1.65, n.y)))
    bm_lth.free()

    # 3. Forged iron `à gineta` box stirrups (`estribos`, `zone = 5`, `part = 9.0`) + breastplate boss
    bm_irn = bmesh.new()
    add_ellipsoid(bm_irn, (0.0, 1.12, 0.615), (0.036, 0.036, 0.018), u_segs=10, v_segs=6)
    for sx in (-1.0, 1.0):
        cx = sx * 0.30
        add_tapered_tube(bm_irn, [
            (cx, 0.98, 0.04), (cx - sx * 0.045, 0.91, 0.04), (cx - sx * 0.05, 0.86, 0.04),
            (cx + sx * 0.05, 0.86, 0.04), (cx + sx * 0.045, 0.91, 0.04), (cx, 0.98, 0.04),
        ], [0.011, 0.012, 0.022, 0.022, 0.012, 0.011], segs=6)
    parts.append(extract_part_records(bm_irn, 9.0, lambda p, n: 5.0 + ao_shade(p.y, 1.65, n.y)))
    bm_irn.free()

    # 4. Headstall bridle, noseband, iron curb bit & looped leather reins (`part = 10.0 + w` so it pitches/yaws with head!)
    bm_brd = bmesh.new()
    # Noseband (`focinho`) around nasal bridge z ~ 1.03, y ~ 1.51
    add_tapered_tube(bm_brd, [
        (-0.066, 1.49, 1.02), (0.0, 1.565, 1.01), (0.066, 1.49, 1.02), (0.0, 1.435, 1.03), (-0.066, 1.49, 1.02),
    ], [0.011]*5, segs=6)
    # Cheekpieces up to poll/crownpiece behind ears (z ~ 0.83, y ~ 1.73)
    add_tapered_tube(bm_brd, [
        (-0.062, 1.48, 1.04), (-0.088, 1.63, 0.91), (-0.068, 1.73, 0.82), (0.0, 1.755, 0.81),
        (0.068, 1.73, 0.82), (0.088, 1.63, 0.91), (0.062, 1.48, 1.04),
    ], [0.011]*7, segs=6)
    # Looped leather reins from curb bit (z=1.05, y=1.44) back to rider's left hand above pommel (z=0.22, y=1.66)
    for sx in (-1.0, 1.0):
        add_tapered_tube(bm_brd, [
            (sx * 0.065, 1.43, 1.05),
            (sx * 0.115, 1.44, 0.78),
            (sx * 0.095, 1.50, 0.50),
            (sx * 0.035, 1.64, 0.23),
        ], [0.009]*4, segs=6)
    def bridle_part(p):
        w = max(0.02, min(0.95, (p.z - 0.22) / 0.84 * 0.82 + max(0.0, p.y - 1.40) / 0.42 * 0.18))
        return 10.0 + w
    parts.append(extract_part_records(bm_brd, bridle_part, lambda p, n: 4.0 + ao_shade(p.y, 1.80, n.y)))
    bm_brd.free()

    # Curb bit shanks (`zone = 5`)
    bm_bit = bmesh.new()
    for sx in (-1.0, 1.0):
        add_tapered_tube(bm_bit, [(sx * 0.062, 1.47, 1.04), (sx * 0.070, 1.39, 1.06)], [0.010, 0.008], segs=6)
    parts.append(extract_part_records(bm_bit, 10.92, lambda p, n: 5.0 + ao_shade(p.y, 1.80, n.y)))
    bm_bit.free()
    return parts

def build_horse(tripo_dir):
    meta = {"name": "horse", "neckPivot": (0.0, 1.22, 0.54), "legY": 0.90, "frontZ": 0.50, "backZ": -0.58, "height": 1.84}
    glb = find_tripo_glb(tripo_dir, "horse")
    if glb:
        print(f"[tripo] Importing cached horse GLB: {glb}")
        bm = import_tripo_quadruped(glb, meta)
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
        # Sculpted Lusitano pectoral chest, scapula/shoulder slope, rounded croup/gluteal muscles, jowl/cheekbone, mane crest, ears, tail, and athletic legs
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
        bm = voxel_unify_and_decimate(bm, "horse", voxel_size=0.013, target_faces=2150, smooth_iters=3)

    def part_fn(p):
        return classify_quadruped_part(p, neck_z=0.48, leg_top_y=0.88, front_z=0.50, back_z=-0.58, tail_z=-0.79, neck_max_span=0.60, base_y_neck=1.04)
    def coat_fn(p, n):
        sh = ao_shade(p.y, 1.86, n.y)
        if p.z < -0.79 and p.y < 1.32:
            return 3.0 + sh  # flowing Lusitano tail
        if abs(p.x) < 0.068 and 0.44 < p.z < 0.88 and p.y > 1.36 and n.y > 0.10:
            return 3.0 + sh  # arched crest mane
        if (p.z > 1.02 and p.y < 1.54) or p.y < 0.20:
            return 1.0 + sh  # dark muzzle & lower stockings/hooves
        return 0.0 + sh

    horse_parts = [extract_part_records(bm, part_fn, coat_fn)]
    bm.free()
    # Append physical 3D 1550 `sela à gineta` saddle, saddlebags, stirrups, bridle & reins (`part >= 9.0`)
    horse_parts.extend(build_gineta_saddle_and_tack())
    v, idx = merge_parts(horse_parts)
    return {**meta, "verts": v, "indices": idx}

def build_progressive_collapse(verts, indices, target_core_tris=20):
    """Computes a priority-queue half-edge collapse continuum for Rule-3 GPU interpolation.
    Returns (sorted_indices, morph_words, core_tri_count).
    Each vertex gets 2 x uint32:
      word0 = (parent_idx & 0xFFFF) | (collapse_start_q16 << 16)
      word1 = (collapse_span_q16 & 0xFFFF) | (grandparent_idx << 16)
    """
    n_verts = len(verts)
    pos = [Vector((v[0], v[1], v[2])) for v in verts]
    nrm = [Vector((v[3], v[4], v[5])) for v in verts]
    part = [int(math.floor(v[6] + 1e-4)) for v in verts]
    zone = [int(math.floor(v[7] + 1e-4)) for v in verts]

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
        # Directed cost of collapsing u -> v: penalize length * curvature + part/tack boundary jumps
        du = pos[u] - pos[v]
        dist = du.length
        ndot = max(-1.0, min(1.0, nrm[u].dot(nrm[v])))
        curv = 1.0 + 1.8 * (1.0 - ndot)
        # Collapse tack (`part >= 9`) early so mid-far continuum simplifies tack onto the horse cleanly
        tack_u = part[u] >= 9
        tack_v = part[v] >= 9
        if tack_u and not tack_v:
            return dist * 0.35
        if not tack_u and tack_v:
            return 1e6
        part_pen = 1.0 if part[u] == part[v] else (2.4 if (part[u] <= 6 and part[v] <= 6) else 8.0)
        zone_pen = 1.0 if zone[u] == zone[v] else 1.25
        # Preserve extreme silhouette tips (hooves y<0.04, poll/muzzle/rump extremes) until late steps
        sil_pen = 1.65 if (pos[u].y < 0.035 or abs(pos[u].z) > 0.72) else 1.0
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

        # Check normal flip on surviving incident triangles of u when u moves to pos[v]
        flipped = False
        affected = list(v_tris[u])
        for ti in affected:
            t = tris[ti]
            if not t[3]:
                continue
            if v in t[:3]:
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

        # Commit collapse u -> v
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
    # Reorder original triangles so surviving core triangles come first, then triangles in reverse retirement order
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
            # Map step 0..total_steps-1 onto morphLevel 0.0..0.90 so morph completes cleanly at 1.0
            norm_s = (collapse_step[u] / float(total_steps)) * 0.88
            start_q16 = max(0, min(65534, int(round(norm_s * 65535))))
        w0 = (p_idx & 0xFFFF) | ((start_q16 & 0xFFFF) << 16)
        w1 = (span_q16 & 0xFFFF) | ((gp_idx & 0xFFFF) << 16)
        morph_words.extend([w0, w1])

    return sorted_indices, morph_words, core_tris, total_steps

def pack_livestock_binary(species_list, out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    chunks = [struct.pack("<4sIII", b"LSTK", 1, len(species_list), 0)]
    for sp in species_list:
        verts = sp["verts"]
        sorted_idx, morph_words, core_tris, total_steps = build_progressive_collapse(verts, sp["indices"], target_core_tris=20)
        vc = len(verts)
        ic = len(sorted_idx)
        print(f"Packed {sp['name']}: {vc} verts, {ic // 3} tris -> {core_tris} core tris across {total_steps} half-edge collapses")
        meta = struct.pack(
            "<8f4I",
            sp["neckPivot"][0], sp["neckPivot"][1], sp["neckPivot"][2],
            sp["legY"], sp["frontZ"], sp["backZ"], sp["height"], float(core_tris),
            vc, ic, total_steps, 0,
        )
        chunks.append(meta)
        v_buf = bytearray(vc * 16)
        for i, r in enumerate(verts):
            px = max(-32767, min(32767, int(round(r[0] * 1000.0))))
            py = max(-32767, min(32767, int(round(r[1] * 1000.0))))
            pz = max(-32767, min(32767, int(round(r[2] * 1000.0))))
            nx = max(-16384, min(16384, int(round(r[3] * 16384.0))))
            ny = max(-16384, min(16384, int(round(r[4] * 16384.0))))
            nz = max(-16384, min(16384, int(round(r[5] * 16384.0))))
            pt = max(-32767, min(32767, int(round(r[6] * 1000.0))))
            ct = max(-32767, min(32767, int(round(r[7] * 1000.0))))
            struct.pack_into("<8h", v_buf, i * 16, px, py, pz, nx, ny, nz, pt, ct)
        chunks.append(bytes(v_buf))

        i_buf = bytearray(ic * 2 + ((ic * 2) % 4))
        for k, idx_val in enumerate(sorted_idx):
            struct.pack_into("<H", i_buf, k * 2, idx_val)
        chunks.append(bytes(i_buf))

        m_buf = bytearray(len(morph_words) * 4)
        for k, w in enumerate(morph_words):
            struct.pack_into("<I", m_buf, k * 4, w)
        chunks.append(bytes(m_buf))

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
