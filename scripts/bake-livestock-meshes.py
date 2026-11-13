#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Sculpts anatomical low-poly Iberian livestock meshes (sheep, cattle, swine, horse)
into js/models/livestock-meshes.js via headless Blender.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/bake-livestock-meshes.py
"""
import os
import bpy
import bmesh
import math
import json
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Coordinate convention exported to Waterworld:
#   X = right, Y = up (0 at ground), Z = forward (+Z is nose, -Z is tail).

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def build_spine_loft(bm, stations, segs=12, wool_ripple=0.0):
    """Lofts an exact bilaterally symmetric sagittal quadruped body+neck+head mesh.
    Each station: (yc, zc, rx, r_dorsal, r_ventral[, pinch_belly]).
    """
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
        # tangent x side: for tan=(0,0,1), (0,0,1)x(1,0,0) = (0,+1,0) dorsal (+Y)!
        dorsal = tan.cross(side).normalized()
        ring = []
        for s in range(segs):
            a = (s / segs) * 2.0 * math.pi  # a=0 -> +X right, a=pi/2 -> dorsal, a=3pi/2 -> ventral
            ca = math.cos(a)
            sa = math.sin(a)
            ry = r_up if sa >= 0.0 else r_dn
            # Slightly squarer muscular ribcage/haunch fullness on quadrupeds
            w_mod = 1.0 + (0.08 * (ca * ca) * (sa * sa)) * belly_round
            if wool_ripple > 0.0 and zc < 0.34:
                w_mod += wool_ripple * math.cos(5.0 * a + zc * 14.0)
            pt = p + side * (ca * rx * w_mod) + dorsal * (sa * ry * w_mod)
            ring.append(bm.verts.new(pt))
        rings.append(ring)

    for i in range(n - 1):
        r0, r1 = rings[i], rings[i + 1]
        for s in range(segs):
            sn = (s + 1) % segs
            bm.faces.new([r0[s], r0[sn], r1[sn], r1[s]])

    # Smoothly cap tail-base and muzzle tip
    p0 = Vector((0.0, stations[0][0], stations[0][1] - 0.025))
    c0 = bm.verts.new(p0)
    for s in range(segs):
        sn = (s + 1) % segs
        bm.faces.new([c0, rings[0][sn], rings[0][s]])

    p1 = Vector((0.0, stations[-1][0], stations[-1][1] + 0.018))
    c1 = bm.verts.new(p1)
    for s in range(segs):
        sn = (s + 1) % segs
        bm.faces.new([c1, rings[-1][s], rings[-1][sn]])

def add_tapered_tube(bm, points, radii, segs=6, cap_start=True, cap_end=True, scale_xz=(1.0, 1.0)):
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
        for s in range(segs):
            a = (s / segs) * 2.0 * math.pi
            v = bm.verts.new(p + side * (math.cos(a) * rx) + perp * (math.sin(a) * rz))
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

def ao_shade(y, max_y, ny):
    h = max(0.0, min(1.0, y / max(0.1, max_y)))
    up = max(0.0, min(1.0, 0.5 + 0.5 * ny))
    return max(0.08, min(0.95, 0.34 + 0.36 * h + 0.25 * up))

def build_sheep():
    clear_scene()
    # 0: Merino / Churra sheep: plump deep woolly barrel (y=0.29..0.72m, width 0.44m), woolly upper thighs, short slender shanks!
    neck_pivot = (0.0, 0.56, 0.28)
    front_z, back_z = 0.26, -0.30
    hip_y = 0.36
    # (yc, zc, rx, r_dorsal, r_ventral)
    stations = [
        (0.54, -0.46, 0.11, 0.11, 0.12),   # rump rear
        (0.53, -0.34, 0.195, 0.185, 0.21), # full woolly hindquarters (y=0.32..0.715)
        (0.51, -0.14, 0.225, 0.205, 0.225),# deep Merino barrel (y=0.285..0.715)
        (0.52,  0.08, 0.220, 0.205, 0.225),# ribcage
        (0.54,  0.26, 0.195, 0.190, 0.220),# woolly brisket & withers (y=0.32..0.73)
        (0.61,  0.36, 0.140, 0.130, 0.135),# woolly neck ruff
        (0.69,  0.44, 0.105, 0.095, 0.095),# upper neck / poll wool cap
        (0.73,  0.50, 0.082, 0.075, 0.072),# forehead / eyes
        (0.69,  0.59, 0.056, 0.052, 0.048),# Roman nasal bridge
        (0.65,  0.66, 0.038, 0.036, 0.034),# tapered ovine muzzle
    ]
    bm_body = bmesh.new()
    build_spine_loft(bm_body, stations, segs=12, wool_ripple=0.04)
    def body_part(p):
        if p.z > 0.26:
            w = max(0.02, min(0.98, (p.z - 0.26) / 0.34 * 0.72 + max(0.0, p.y - 0.56) / 0.22 * 0.28))
            return 1.0 + w
        return 0.0
    def body_coat(p, n):
        sh = ao_shade(p.y, 0.84, n.y)
        if p.z > 0.49 and p.y < 0.75:
            return 1.0 + sh  # bare Churra/Merino face & muzzle
        return 0.0 + sh      # plump woolly fleece
    parts = [extract_part_records(bm_body, body_part, body_coat)]
    bm_body.free()

    # Horizontal sheep ears (part 1.88)
    bm_ears = bmesh.new()
    for sx in (-1.0, 1.0):
        add_tapered_tube(bm_ears, [(sx * 0.065, 0.73, 0.46), (sx * 0.145, 0.71, 0.44), (sx * 0.175, 0.69, 0.43)], [0.028, 0.024, 0.010], segs=5)
    parts.append(extract_part_records(bm_ears, 1.88, lambda p, n: 1.0 + ao_shade(p.y, 0.84, n.y)))
    bm_ears.free()

    # Plump woolly tail (part 6.0)
    bm_tail = bmesh.new()
    add_tapered_tube(bm_tail, [(0.0, 0.56, -0.45), (0.0, 0.46, -0.52), (0.0, 0.36, -0.53)], [0.056, 0.046, 0.028], segs=6)
    parts.append(extract_part_records(bm_tail, 6.0, lambda p, n: 0.0 + ao_shade(p.y, 0.84, n.y)))
    bm_tail.free()

    # 4 legs: woolly upper thigh/forearm blending out of the fleece (y=0.40..0.24), slender bare shanks below y=0.23!
    leg_specs = [
        (2.0, -0.115, front_z),
        (3.0,  0.115, front_z),
        (4.0, -0.125, back_z),
        (5.0,  0.125, back_z),
    ]
    for code, lx, lz in leg_specs:
        bm_leg = bmesh.new()
        knee_z = lz + (0.014 if lz > 0 else -0.026)
        pts = [(lx * 0.92, 0.42, lz), (lx, 0.26, knee_z), (lx, 0.19, knee_z), (lx, 0.06, lz), (lx, 0.0, lz + 0.014)]
        rads = [(0.072, 0.082), (0.048, 0.052), 0.028, 0.022, 0.028]
        add_tapered_tube(bm_leg, pts, rads, segs=6)
        parts.append(extract_part_records(bm_leg, code, lambda p, n: (1.0 if p.y < 0.22 else 0.0) + ao_shade(p.y, 0.84, n.y)))
        bm_leg.free()

    v, idx = merge_parts(parts)
    return {"name": "sheep", "neckPivot": neck_pivot, "legY": hip_y, "frontZ": front_z, "backZ": back_z, "height": 0.82, "verts": v, "indices": idx}

def build_cattle():
    clear_scene()
    # 1: Iberian Barrosã / Mertolenga cattle: heavy barrel (y=0.56..1.34m, width 0.68m), deep dewlap brisket, muscular haunches, lyre horns
    neck_pivot = (0.0, 1.06, 0.62)
    front_z, back_z = 0.56, -0.64
    hip_y = 0.78
    stations = [
        (1.06, -0.84, 0.18, 0.22, 0.24),   # pin bones / rump rear
        (1.02, -0.64, 0.30, 0.30, 0.36),   # muscular hindquarters (y=0.66..1.32)
        (0.96, -0.28, 0.345, 0.34, 0.39),  # deep barrel / flank (y=0.57..1.30)
        (0.97,  0.14, 0.335, 0.35, 0.40),  # ribcage (y=0.57..1.32)
        (1.00,  0.50, 0.285, 0.36, 0.45),  # prominent withers hump & deep brisket dewlap (y=0.55..1.36)
        (1.06,  0.74, 0.185, 0.22, 0.28),  # thick bovine neck & throatlatch dewlap
        (1.16,  0.92, 0.145, 0.15, 0.15),  # broad poll / forehead
        (1.07,  1.08, 0.105, 0.10, 0.10),  # facial bridge
        (0.99,  1.21, 0.082, 0.075, 0.072),# broad square bovine muzzle
    ]
    bm_body = bmesh.new()
    build_spine_loft(bm_body, stations, segs=12)
    def body_part(p):
        if p.z > 0.58:
            w = max(0.02, min(0.98, (p.z - 0.58) / 0.58))
            return 1.0 + w
        return 0.0
    def body_coat(p, n):
        sh = ao_shade(p.y, 1.48, n.y)
        if p.z > 1.12 and p.y < 1.08:
            return 1.0 + sh  # dark wet muzzle
        if p.y < 0.72 and abs(p.x) < 0.26 and abs(p.z) < 0.48:
            return 2.0 + sh  # pale/piebald belly
        return 0.0 + sh
    parts = [extract_part_records(bm_body, body_part, body_coat)]
    bm_body.free()

    # Sweeping Iberian Barrosã lyre horns + ears (part 1.94)
    bm_head_extra = bmesh.new()
    for sx in (-1.0, 1.0):
        add_tapered_tube(bm_head_extra, [
            (sx * 0.11, 1.26, 0.90),
            (sx * 0.26, 1.34, 0.92),
            (sx * 0.35, 1.46, 0.99),
            (sx * 0.31, 1.56, 1.07),
        ], [0.040, 0.030, 0.020, 0.008], segs=5)
        add_tapered_tube(bm_head_extra, [
            (sx * 0.13, 1.19, 0.88),
            (sx * 0.24, 1.16, 0.86),
            (sx * 0.28, 1.15, 0.85),
        ], [0.038, 0.032, 0.014], segs=5)
    parts.append(extract_part_records(bm_head_extra, 1.94, lambda p, n: (1.0 if p.y > 1.25 else 0.0) + ao_shade(p.y, 1.56, n.y)))
    bm_head_extra.free()

    # Long tufted switch tail (part 6.0)
    bm_tail = bmesh.new()
    add_tapered_tube(bm_tail, [(0.0, 1.14, -0.84), (0.0, 0.84, -0.93), (0.0, 0.50, -0.94), (0.0, 0.36, -0.93)], [0.040, 0.025, 0.044, 0.018], segs=5)
    parts.append(extract_part_records(bm_tail, 6.0, lambda p, n: (3.0 if p.y < 0.58 else 0.0) + ao_shade(p.y, 1.48, n.y)))
    bm_tail.free()

    # 4 muscular legs tapering from shoulder/gaskin into hock & cloven hooves
    leg_specs = [
        (2.0, -0.19, front_z),
        (3.0,  0.19, front_z),
        (4.0, -0.20, back_z),
        (5.0,  0.20, back_z),
    ]
    for code, lx, lz in leg_specs:
        bm_leg = bmesh.new()
        hock_z = lz + (0.02 if lz > 0 else -0.055)
        pts = [(lx * 0.90, 0.82, lz), (lx, 0.56, lz - 0.01), (lx, 0.42, hock_z), (lx, 0.12, lz), (lx, 0.0, lz + 0.024)]
        rads = [(0.115, 0.145) if lz < 0 else (0.105, 0.125), (0.075, 0.090), 0.052, 0.038, 0.050]
        add_tapered_tube(bm_leg, pts, rads, segs=6)
        parts.append(extract_part_records(bm_leg, code, lambda p, n: (1.0 if p.y < 0.13 else 0.0) + ao_shade(p.y, 1.48, n.y)))
        bm_leg.free()

    v, idx = merge_parts(parts)
    return {"name": "cattle", "neckPivot": neck_pivot, "legY": hip_y, "frontZ": front_z, "backZ": back_z, "height": 1.52, "verts": v, "indices": idx}

def build_swine():
    clear_scene()
    # 2: Iberian pig (Porco Preto Ibérico): low-slung rotund barrel (y=0.20..0.64m, width 0.42m), heavy jowls, conical rooting snout, short trotters
    neck_pivot = (0.0, 0.42, 0.28)
    front_z, back_z = 0.25, -0.30
    hip_y = 0.28
    stations = [
        (0.42, -0.46, 0.12, 0.13, 0.14),   # rounded ham rear
        (0.43, -0.32, 0.195, 0.195, 0.20), # plump hams (y=0.23..0.625)
        (0.42, -0.08, 0.215, 0.220, 0.215),# stout arched barrel (y=0.205..0.64)
        (0.42,  0.18, 0.205, 0.210, 0.205),# thick shoulders (y=0.215..0.63)
        (0.41,  0.34, 0.165, 0.165, 0.165),# heavy jowl / neck
        (0.40,  0.46, 0.115, 0.115, 0.105),# forehead / eyes
        (0.35,  0.57, 0.068, 0.064, 0.060),# long Iberian snout bridge
        (0.32,  0.65, 0.048, 0.048, 0.045),# flat rooting snout disc
    ]
    bm_body = bmesh.new()
    build_spine_loft(bm_body, stations, segs=12)
    def body_part(p):
        if p.z > 0.26:
            w = max(0.02, min(0.98, (p.z - 0.26) / 0.36))
            return 1.0 + w
        return 0.0
    def body_coat(p, n):
        sh = ao_shade(p.y, 0.66, n.y)
        if p.z > 0.59:
            return 1.0 + sh  # rooting snout disc
        if p.y < 0.28:
            return 2.0 + sh  # warm dusty belly
        return 0.0 + sh
    parts = [extract_part_records(bm_body, body_part, body_coat)]
    bm_body.free()

    # Forward-drooping Iberian pig ears (part 1.75)
    bm_ears = bmesh.new()
    for sx in (-1.0, 1.0):
        add_tapered_tube(bm_ears, [(sx * 0.09, 0.52, 0.38), (sx * 0.14, 0.48, 0.46), (sx * 0.12, 0.43, 0.53)], [0.044, 0.038, 0.014], segs=5)
    parts.append(extract_part_records(bm_ears, 1.75, lambda p, n: 0.0 + ao_shade(p.y, 0.66, n.y)))
    bm_ears.free()

    # Curly tail (part 6.0)
    bm_tail = bmesh.new()
    add_tapered_tube(bm_tail, [(0.0, 0.47, -0.45), (0.02, 0.51, -0.51), (-0.01, 0.46, -0.54)], [0.022, 0.016, 0.009], segs=5)
    parts.append(extract_part_records(bm_tail, 6.0, lambda p, n: 0.0 + ao_shade(p.y, 0.66, n.y)))
    bm_tail.free()

    # 4 short stout trotters
    leg_specs = [
        (2.0, -0.115, front_z),
        (3.0,  0.115, front_z),
        (4.0, -0.120, back_z),
        (5.0,  0.120, back_z),
    ]
    for code, lx, lz in leg_specs:
        bm_leg = bmesh.new()
        pts = [(lx * 0.92, 0.30, lz), (lx, 0.15, lz - 0.01), (lx, 0.05, lz), (lx, 0.0, lz + 0.012)]
        rads = [(0.068, 0.078), 0.040, 0.028, 0.032]
        add_tapered_tube(bm_leg, pts, rads, segs=6)
        parts.append(extract_part_records(bm_leg, code, lambda p, n: (1.0 if p.y < 0.08 else 0.0) + ao_shade(p.y, 0.66, n.y)))
        bm_leg.free()

    v, idx = merge_parts(parts)
    return {"name": "swine", "neckPivot": neck_pivot, "legY": hip_y, "frontZ": front_z, "backZ": back_z, "height": 0.66, "verts": v, "indices": idx}

def build_horse():
    clear_scene()
    # 3: Iberian Lusitano horse: deep athletic chest (y=0.76..1.52m), rounded croup, proud arched crest neck (y=1.78m), clean equine legs
    neck_pivot = (0.0, 1.22, 0.54)
    front_z, back_z = 0.50, -0.58
    hip_y = 0.90
    stations = [
        (1.22, -0.78, 0.16, 0.20, 0.20),   # dock / croup rear
        (1.18, -0.58, 0.275, 0.31, 0.32),  # powerful rounded Lusitano croup & gaskin top (y=0.86..1.49)
        (1.14, -0.22, 0.295, 0.30, 0.32),  # barrel / loin (y=0.82..1.44)
        (1.14,  0.16, 0.290, 0.33, 0.36),  # deep heart-girth ribcage (y=0.78..1.47)
        (1.18,  0.48, 0.255, 0.34, 0.38),  # defined withers & muscular chest (y=0.80..1.52)
        (1.36,  0.64, 0.145, 0.21, 0.16),  # proud arched Lusitano neck base
        (1.56,  0.76, 0.110, 0.16, 0.12),  # arched upper crest
        (1.68,  0.84, 0.095, 0.10, 0.10),  # poll / forehead
        (1.56,  0.98, 0.068, 0.068, 0.065),# sub-convex Iberian nasal profile
        (1.46,  1.10, 0.048, 0.048, 0.046),# refined velvety muzzle
    ]
    bm_body = bmesh.new()
    build_spine_loft(bm_body, stations, segs=12)
    def body_part(p):
        if p.z > 0.48 and p.y > 1.05:
            w = max(0.02, min(0.98, (p.z - 0.48) / 0.56 * 0.62 + max(0.0, p.y - 1.18) / 0.52 * 0.38))
            return 1.0 + w
        return 0.0
    def body_coat(p, n):
        sh = ao_shade(p.y, 1.82, n.y)
        if p.z > 1.02 and p.y < 1.54:
            return 1.0 + sh  # dark muzzle
        if abs(p.x) < 0.065 and p.z > 0.46 and p.z < 0.88 and p.y > 1.34 and n.y > 0.15:
            return 3.0 + sh  # crest mane
        return 0.0 + sh
    parts = [extract_part_records(bm_body, body_part, body_coat)]
    bm_body.free()

    # Pricked ears + thick Lusitano mane crest (part 1.85..1.92)
    bm_ears = bmesh.new()
    for sx in (-1.0, 1.0):
        add_tapered_tube(bm_ears, [(sx * 0.055, 1.74, 0.82), (sx * 0.072, 1.83, 0.83), (sx * 0.062, 1.88, 0.84)], [0.026, 0.018, 0.006], segs=5)
    add_tapered_tube(bm_ears, [(0.0, 1.46, 0.50), (0.022, 1.62, 0.65), (0.018, 1.75, 0.79)], [(0.028, 0.075), (0.032, 0.085), (0.022, 0.055)], segs=5)
    parts.append(extract_part_records(bm_ears, lambda p: 1.92 if p.y > 1.74 else 1.52, lambda p, n: (3.0 if p.y < 1.76 else 0.0) + ao_shade(p.y, 1.88, n.y)))
    bm_ears.free()

    # Full flowing Lusitano tail (part 6.0)
    bm_tail = bmesh.new()
    add_tapered_tube(bm_tail, [(0.0, 1.28, -0.77), (0.0, 1.04, -0.90), (0.0, 0.68, -0.94), (0.0, 0.34, -0.91)], [0.048, 0.072, 0.066, 0.026], segs=6)
    parts.append(extract_part_records(bm_tail, 6.0, lambda p, n: 3.0 + ao_shade(p.y, 1.82, n.y)))
    bm_tail.free()

    # 4 athletic equine legs with muscular forearm/gaskin -> knee/hock -> slender cannon -> hoof
    leg_specs = [
        (2.0, -0.165, front_z),
        (3.0,  0.165, front_z),
        (4.0, -0.175, back_z),
        (5.0,  0.175, back_z),
    ]
    for code, lx, lz in leg_specs:
        bm_leg = bmesh.new()
        hock_z = lz + (0.018 if lz > 0 else -0.060)
        pts = [(lx * 0.90, 0.94, lz), (lx, 0.64, lz - 0.01), (lx, 0.48, hock_z), (lx, 0.14, lz), (lx, 0.0, lz + 0.026)]
        rads = [(0.105, 0.135) if lz < 0 else (0.092, 0.112), (0.064, 0.078), 0.045, 0.033, 0.046]
        add_tapered_tube(bm_leg, pts, rads, segs=6)
        parts.append(extract_part_records(bm_leg, code, lambda p, n: (1.0 if p.y < 0.22 else 0.0) + ao_shade(p.y, 1.82, n.y)))
        bm_leg.free()

    v, idx = merge_parts(parts)
    return {"name": "horse", "neckPivot": neck_pivot, "legY": hip_y, "frontZ": front_z, "backZ": back_z, "height": 1.84, "verts": v, "indices": idx}

species = [build_sheep(), build_cattle(), build_swine(), build_horse()]

out_lines = [
    "// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.",
    "// Anatomical low-poly Iberian livestock meshes sculpted in headless Blender (sagittal rib-loft + articulated limbs).",
    "// Species order: 0 = sheep (Merino/Churra), 1 = cattle (Barrosã/Mertolenga), 2 = swine (Porco Preto), 3 = horse (Lusitano).",
    "// Vertex layout (8 floats = 32 bytes): [px, py, pz, nx, ny, nz, part, coat].",
    "",
    "export const LIVESTOCK_SPECIES_COUNT = 4;",
    "export const LIVESTOCK_VERTEX_FLOATS = 8;",
    "",
    "function unpackLivestockSpecies(spec) {",
    "  const vSrc = spec.v, vCount = vSrc.length / 8, verts = new Float32Array(vSrc.length);",
    "  for (let i = 0; i < vCount; i++) {",
    "    const b = i * 8;",
    "    verts[b] = vSrc[b] * 0.001;",
    "    verts[b + 1] = vSrc[b + 1] * 0.001;",
    "    verts[b + 2] = vSrc[b + 2] * 0.001;",
    "    const nx = vSrc[b + 3] * 0.001, ny = vSrc[b + 4] * 0.001, nz = vSrc[b + 5] * 0.001;",
    "    const nl = Math.hypot(nx, ny, nz) || 1;",
    "    verts[b + 3] = nx / nl; verts[b + 4] = ny / nl; verts[b + 5] = nz / nl;",
    "    verts[b + 6] = vSrc[b + 6] * 0.001;",
    "    verts[b + 7] = vSrc[b + 7] * 0.001;",
    "  }",
    "  return Object.freeze({",
    "    name: spec.name,",
    "    neckPivot: Object.freeze(spec.neckPivot),",
    "    legY: spec.legY,",
    "    frontZ: spec.frontZ,",
    "    backZ: spec.backZ,",
    "    height: spec.height,",
    "    vertices: verts,",
    "    indices: new Uint32Array(spec.i),",
    "    indexCount: spec.i.length,",
    "  });",
    "}",
    "",
    "const RAW_LIVESTOCK = [",
]

for sp in species:
    qv = []
    for rec in sp["verts"]:
        for val in rec:
            qv.append(int(round(val * 1000)))
    print(f"Built {sp['name']}: {len(sp['verts'])} verts, {len(sp['indices'])//3} tris")
    entry = {
        "name": sp["name"],
        "neckPivot": [round(x, 3) for x in sp["neckPivot"]],
        "legY": round(sp["legY"], 3),
        "frontZ": round(sp["frontZ"], 3),
        "backZ": round(sp["backZ"], 3),
        "height": round(sp["height"], 3),
        "v": qv,
        "i": sp["indices"],
    }
    out_lines.append("  " + json.dumps(entry, separators=(",", ":")) + ",")

out_lines.extend([
    "];",
    "",
    "let cachedLivestockMeshes = null;",
    "export function getLivestockMeshes() {",
    "  return cachedLivestockMeshes ??= Object.freeze(RAW_LIVESTOCK.map(unpackLivestockSpecies));",
    "}",
    "",
])

out_path = os.path.join(ROOT, "js", "models", "livestock-meshes.js")
with open(out_path, "w") as f:
    f.write("\n".join(out_lines))
print("Wrote", out_path)
