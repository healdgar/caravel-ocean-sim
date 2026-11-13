#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Sculpts and bakes modular 3D character components (hair, headwear, facial hair, outerwear)
fitted directly to assets/crew/sailor.glb and assets/crew/sailor-female.glb via headless Blender.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/bake-crew-components.py
"""
import base64, json, math, os, struct
import numpy as np
import bpy, bmesh
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_JS = os.path.join(ROOT, 'js', 'models', 'crew-components.js')

SLOT_HAIR = 4
SLOT_ACCENT = 5
SLOT_LINEN = 6


def read_glb(path):
    data = open(path, 'rb').read()
    n = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + n])
    bin_ = data[20 + n + 8:20 + n + 8 + doc['buffers'][0]['byteLength']]
    types = {5123: np.uint16, 5125: np.uint32, 5126: np.float32}
    sizes = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

    def acc(index):
        a = doc['accessors'][index]
        v = doc['bufferViews'][a['bufferView']]
        dt = types[a['componentType']]
        sz = sizes[a['type']]
        off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        return np.frombuffer(bin_, dtype=dt, count=a['count'] * sz, offset=off).reshape(a['count'], sz)

    prim = doc['meshes'][0]['primitives'][0]
    P = acc(prim['attributes']['POSITION']).astype(np.float64)
    N = acc(prim['attributes']['NORMAL']).astype(np.float64)
    J = acc(prim['attributes']['JOINTS_0']).astype(np.int64)
    W = acc(prim['attributes']['WEIGHTS_0']).astype(np.float64)
    I = acc(prim['indices']).astype(np.int64).reshape(-1, 3)
    skin = doc['skins'][0]
    jnames = [doc['nodes'][j]['name'] for j in skin['joints']]
    ibm = acc(skin['inverseBindMatrices']).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    world = np.linalg.inv(ibm)
    jidx = {name: i for i, name in enumerate(jnames)}
    jpos = {name: world[i][:3, 3].copy() for i, name in enumerate(jnames)}
    return {'P': P, 'N': N, 'J': J, 'W': W, 'I': I, 'jnames': jnames, 'jidx': jidx, 'jpos': jpos}


def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / max(hi - lo, 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


class BodyEnvelope:
    """Measured anatomical skull, face, and torso envelopes over a fitted crew GLB."""
    def __init__(self, body, is_female):
        self.body = body
        self.is_female = is_female
        self.P = body['P']
        self.J = body['J']
        self.W = body['W']
        self.jidx = body['jidx']
        self.jpos = body['jpos']
        self.head_p = self.jpos['Head']
        self.neck_p = self.jpos['neck_01']
        self.cran_c = np.array([
            0.0,
            self.head_p[1] + (0.068 if is_female else 0.064),
            self.head_p[2] + (0.006 if is_female else 0.008),
        ], dtype=np.float64)
        self.cran_r = np.array([0.071, 0.091, 0.089] if is_female else [0.075, 0.096, 0.093], dtype=np.float64)

        # Identify non-arm body vertices for torso/hip garment fitting & weight transfer.
        arm_slots = {
            i for name, i in self.jidx.items()
            if any(k in name for k in ('clavicle', 'upperarm', 'lowerarm', 'hand', 'thumb', 'index', 'middle', 'ring', 'pinky'))
        }
        arm_w = np.zeros(len(self.P), dtype=np.float64)
        for k in range(4):
            mask = np.isin(self.J[:, k], list(arm_slots))
            arm_w[mask] += self.W[mask, k]
        self.torso_mask = (arm_w < 0.35) & (np.abs(self.P[:, 0]) < 0.235)
        self.torso_P = self.P[self.torso_mask]
        self.torso_J = self.J[self.torso_mask]
        self.torso_W = self.W[self.torso_mask]
        self.arm_slots = arm_slots

        # Precompute cylindrical torso radius table R(y, az) around (x=0, z=-0.025).
        self.torso_z0 = -0.025
        self.ny, self.na = 44, 48
        self.y_grid = np.linspace(0.32, 1.52, self.ny)
        self.a_grid = np.linspace(-math.pi, math.pi, self.na, endpoint=False)
        self.r_table = np.zeros((self.ny, self.na), dtype=np.float64)
        tp = self.torso_P
        tx = tp[:, 0]
        ty = tp[:, 1]
        tz = tp[:, 2] - self.torso_z0
        tr = np.hypot(tx, tz)
        ta = np.arctan2(tx, tz)
        for iy, yv in enumerate(self.y_grid):
            band = np.abs(ty - yv) < 0.042
            if not np.any(band):
                self.r_table[iy, :] = 0.14
                continue
            bx, bz, br, ba = tx[band], tz[band], tr[band], ta[band]
            for ia, av in enumerate(self.a_grid):
                da = np.abs((ba - av + math.pi) % (2.0 * math.pi) - math.pi)
                sec = da < 0.34
                if np.any(sec):
                    self.r_table[iy, ia] = float(np.percentile(br[sec], 96))
                else:
                    sec2 = da < 0.72
                    self.r_table[iy, ia] = float(np.percentile(br[sec2], 92)) if np.any(sec2) else float(np.median(br))
        # Smooth r_table along azimuth & height while never shrinking below 98.5% of raw max.
        raw_r = self.r_table.copy()
        for _ in range(2):
            self.r_table = 0.5 * self.r_table + 0.25 * np.roll(self.r_table, 1, axis=1) + 0.25 * np.roll(self.r_table, -1, axis=1)
            pad = np.vstack([self.r_table[:1], self.r_table, self.r_table[-1:]])
            self.r_table = 0.5 * self.r_table + 0.25 * pad[:-2] + 0.25 * pad[2:]
        self.r_table = np.maximum(self.r_table, raw_r * 0.99)

        # Head vertices for exact skull & front-face queries (strictly Head-weighted, excluding T-pose shoulders/arms).
        head_slot = self.jidx['Head']
        head_w = np.zeros(len(self.P), dtype=np.float64)
        for k in range(4):
            mask = self.J[:, k] == head_slot
            head_w[mask] += self.W[mask, k]
        self.head_verts = self.P[(head_w > 0.45) & (self.P[:, 1] > self.neck_p[1] + 0.005) & (np.abs(self.P[:, 0]) < 0.102)]

    def skull_point(self, ux, uy, uz, clearance=0.005):
        """Point on cranial dome along direction (ux, uy, uz) from cran_c, clearing all actual skull vertices."""
        u = np.array([ux, uy, uz], dtype=np.float64)
        u /= max(np.linalg.norm(u), 1e-9)
        # Base ellipsoid radius along u: || (r * u) / cran_r || = 1 => r = 1 / || u / cran_r ||
        r_ell = 1.0 / max(np.linalg.norm(u / self.cran_r), 1e-9)
        rel = self.head_verts - self.cran_c
        rel_len = np.maximum(np.linalg.norm(rel, axis=1), 1e-6)
        dots = (rel / rel_len[:, None]) @ u
        near = dots > 0.955
        r_meas = float(rel_len[near].max()) if np.any(near) else r_ell
        # Clamp facial features (nose/jaw/neck) out of cranial dome radius queries.
        r_meas = min(r_meas, r_ell + 0.012)
        if uy > -0.15 and uz > 0.65 and uy < 0.28:
            r_meas = min(r_meas, r_ell + 0.004)
        return self.cran_c + u * (max(r_ell, r_meas) + clearance)

    def face_front_z(self, x, y):
        """Measured front skin Z on face at (x, y), symmetric in |x|."""
        ax = abs(float(x))
        hv = self.head_verts
        sel = (np.abs(hv[:, 1] - y) < 0.013) & (np.abs(np.abs(hv[:, 0]) - ax) < 0.014) & (hv[:, 2] > -0.01)
        if np.any(sel):
            return float(np.percentile(hv[sel, 2], 95))
        sel2 = (np.abs(hv[:, 1] - y) < 0.024) & (np.abs(np.abs(hv[:, 0]) - ax) < 0.025) & (hv[:, 2] > -0.02)
        if np.any(sel2):
            return float(np.percentile(hv[sel2, 2], 90))
        return float(self.cran_c[2] + 0.072 * math.sqrt(max(0.0, 1.0 - (ax / 0.072) ** 2)))

    def torso_radius(self, y, az):
        """Interpolated torso radius from (0, y, torso_z0) along azimuth az = atan2(x, z - torso_z0)."""
        fy = np.clip((y - self.y_grid[0]) / (self.y_grid[-1] - self.y_grid[0]) * (self.ny - 1), 0.0, self.ny - 1.0001)
        iy = int(fy); ty = fy - iy
        fa = ((az + math.pi) % (2.0 * math.pi)) / (2.0 * math.pi) * self.na
        ia = int(fa) % self.na; ta = fa - int(fa)
        ia1 = (ia + 1) % self.na
        r0 = self.r_table[iy, ia] * (1.0 - ta) + self.r_table[iy, ia1] * ta
        r1 = self.r_table[iy + 1, ia] * (1.0 - ta) + self.r_table[iy + 1, ia1] * ta
        return float(r0 * (1.0 - ty) + r1 * ty)

    def torso_point(self, y, az, extra=0.008):
        r = self.torso_radius(y, az) + extra
        return np.array([r * math.sin(az), y, self.torso_z0 + r * math.cos(az)], dtype=np.float64)

    def head_weights(self, pts, neck_blend_below=None, spine_tail=False):
        h_slot = self.jidx['Head']
        n_slot = self.jidx['neck_01']
        s_slot = self.jidx['spine_03']
        n = len(pts)
        J = np.zeros((n, 4), dtype=np.uint16)
        W = np.zeros((n, 4), dtype=np.float32)
        J[:, 0] = h_slot
        W[:, 0] = 1.0
        if neck_blend_below is not None:
            for i, p in enumerate(pts):
                if p[1] < neck_blend_below:
                    t = float(np.clip((neck_blend_below - p[1]) / 0.11, 0.0, 1.0))
                    if spine_tail:
                        wh = 1.0 - 0.58 * t
                        wn = 0.42 * t
                        ws = 0.16 * t
                        J[i] = [h_slot, n_slot, s_slot, 0]
                        W[i] = [wh, wn, ws, 0.0]
                    else:
                        wn = 0.35 * t
                        J[i] = [h_slot, n_slot, 0, 0]
                        W[i] = [1.0 - wn, wn, 0.0, 0.0]
        return J, W

    def garment_weights(self, pts, skirt_mode=False):
        """Transfers smooth non-arm torso/hip/leg weights from fitted body vertices."""
        n = len(pts)
        J = np.zeros((n, 4), dtype=np.uint16)
        W = np.zeros((n, 4), dtype=np.float32)
        pelvis_s = self.jidx['pelvis']
        sp1_s = self.jidx['spine_01']
        tl_s, tr_s = self.jidx['thigh_l'], self.jidx['thigh_r']
        cl_s, cr_s = self.jidx['calf_l'], self.jidx['calf_r']
        pelvis_y = float(self.jpos['pelvis'][1])
        knee_y = float(self.jpos['calf_l'][1])

        for i, p in enumerate(pts):
            if skirt_mode and p[1] < pelvis_y + 0.03:
                # Analytical smooth split across pelvis, left/right thighs, and calves so strides never tear pleats!
                hip_t = float(smoothstep(pelvis_y - 0.10, pelvis_y + 0.03, p[1]))
                calf_t = float(1.0 - smoothstep(knee_y - 0.08, knee_y + 0.07, p[1]))
                side_l = float(smoothstep(-0.085, 0.085, p[0]))  # +x is left leg (thigh_l.x > 0)
                side_r = 1.0 - side_l
                wp = hip_t * 0.85 + (1.0 - hip_t) * 0.12 * (1.0 - calf_t)
                leg_share = max(0.0, 1.0 - wp)
                wtl = leg_share * (1.0 - calf_t * 0.72) * side_l
                wtr = leg_share * (1.0 - calf_t * 0.72) * side_r
                wcl = leg_share * (calf_t * 0.72) * side_l
                wcr = leg_share * (calf_t * 0.72) * side_r
                cand = [(pelvis_s, wp), (tl_s, wtl), (tr_s, wtr), (cl_s, wcl), (cr_s, wcr)]
                cand = sorted([(s, w) for s, w in cand if w > 1e-4], key=lambda kv: -kv[1])[:4]
                tot = sum(w for _, w in cand) or 1.0
                for k, (s, w) in enumerate(cand):
                    J[i, k] = s; W[i, k] = w / tot
                continue

            d2 = np.sum((self.torso_P - p) ** 2, axis=1)
            near = np.argpartition(d2, 8)[:8]
            acc_w = {}
            for idx in near:
                inv_d = 1.0 / max(float(d2[idx]), 2e-5)
                for k in range(4):
                    w = float(self.torso_W[idx, k])
                    if w <= 1e-5:
                        continue
                    slot = int(self.torso_J[idx, k])
                    if slot in self.arm_slots:
                        slot = self.jidx['spine_03']
                    acc_w[slot] = acc_w.get(slot, 0.0) + w * inv_d
            if not acc_w:
                acc_w[sp1_s] = 1.0
            top = sorted(acc_w.items(), key=lambda kv: -kv[1])[:4]
            tot = sum(w for _, w in top) or 1.0
            for k, (s, w) in enumerate(top):
                J[i, k] = s; W[i, k] = w / tot
        return J, W


def finalize_bmesh(bm, comp_id, slot, shade_fn, weight_fn, low_ratio=0.52):
    """Triangulates a bmesh in Blender, computes smooth normals, decimates low-LOD indices over the SAME vertex buffer."""
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.normal_update()

    me = bpy.data.meshes.new(f'comp_{comp_id}')
    bm.to_mesh(me)
    bm.free()

    verts = np.array([v.co[:] for v in me.vertices], dtype=np.float64)
    norms = np.array([v.normal[:] for v in me.vertices], dtype=np.float64)
    nlen = np.maximum(np.linalg.norm(norms, axis=1, keepdims=True), 1e-9)
    norms /= nlen
    near_idx = np.array([p.vertices[:] for p in me.polygons], dtype=np.uint32).reshape(-1)

    # Create a temporary object to run Blender's topology-preserving Collapse Decimate, then remap surviving corners
    # back onto our exact vertex buffer indices by nearest 3D coordinate so both LODs share one vertex slice!
    obj = bpy.data.objects.new(f'obj_{comp_id}', me)
    bpy.context.collection.objects.link(obj)
    mod = obj.modifiers.new('Dec', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = low_ratio
    deps = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(deps)
    eval_me = eval_obj.to_mesh()
    low_tris = []
    if len(eval_me.polygons) >= 8:
        ev_pts = np.array([v.co[:] for v in eval_me.vertices], dtype=np.float64)
        # Snap each decimated vertex to the nearest original vertex index so skin weights & attributes stay shared!
        d2 = np.sum((ev_pts[:, None, :] - verts[None, :, :]) ** 2, axis=2)
        snap_map = np.argmin(d2, axis=1).astype(np.uint32)
        for poly in eval_me.polygons:
            vs = [int(snap_map[vi]) for vi in poly.vertices]
            for k in range(1, len(vs) - 1):
                a, b, c = vs[0], vs[k], vs[k + 1]
                if a != b and b != c and a != c:
                    low_tris.extend([a, b, c])
    eval_obj.to_mesh_clear()
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.meshes.remove(me)

    low_idx = np.array(low_tris, dtype=np.uint32) if len(low_tris) >= 12 else near_idx.copy()

    shades = np.clip(shade_fn(verts, norms), 0.65, 1.18).astype(np.float32)
    if shades.ndim == 1:
        shades = np.repeat(shades[:, None], 3, axis=1)
    colors = np.zeros((len(verts), 3), dtype=np.float32)
    colors[:, 0] = shades[:, 0]
    colors[:, 1] = shades[:, 1] + 2.0 * float(comp_id)
    colors[:, 2] = shades[:, 2] + 2.0 * float(slot)

    J, W = weight_fn(verts)
    return {
        'id': comp_id,
        'slot': slot,
        'pos': verts.astype(np.float32),
        'norm': norms.astype(np.float32),
        'color': colors,
        'joints': J.astype(np.uint16),
        'weights': W.astype(np.float32),
        'near': near_idx,
        'low': low_idx,
    }


def build_grid_cap(bm, rings, closed_pole=None, tuck_bottom=0.0):
    """Builds a quad-grid shell from rings of 3D points [ring_idx][az_idx], optionally closing top pole & tucking rim."""
    na = len(rings[0])
    v_rings = []
    if tuck_bottom > 0.0:
        r0 = rings[0]
        center0 = np.mean(r0, axis=0)
        inner = [center0 + (p - center0) * (1.0 - tuck_bottom) for p in r0]
        v_rings.append([bm.verts.new(Vector(p.tolist())) for p in inner])
    for r in rings:
        v_rings.append([bm.verts.new(Vector(p.tolist())) for p in r])
    for ri in range(len(v_rings) - 1):
        ra, rb = v_rings[ri], v_rings[ri + 1]
        for i in range(na):
            j = (i + 1) % na
            # Outward CCW winding when azimuth runs -pi..+pi (x = sin(az), z = cos(az)) from bottom to top:
            bm.faces.new((ra[i], ra[j], rb[j], rb[i]))
    if closed_pole is not None:
        pole_v = bm.verts.new(Vector(closed_pole.tolist()))
        top_r = v_rings[-1]
        for i in range(na):
            j = (i + 1) % na
            bm.faces.new((top_r[i], top_r[j], pole_v))
    return v_rings


def hairline_min_uy(az, front_uy=0.40, temple_uy=-0.04, ear_uy=0.06, nape_uy=-0.78):
    """Normalized vertical direction uy in [-1, 1] along azimuth az (0=front forehead, +-pi=back nape)."""
    a = abs(az)
    if a < 0.72:
        t = smoothstep(0.18, 0.72, a)
        return front_uy * (1.0 - t) + temple_uy * t
    if a < 1.55:
        # Slight arch around/above ear at |az| ~ 1.48
        t = smoothstep(0.72, 1.45, a)
        return temple_uy * (1.0 - t) + ear_uy * t
    t = smoothstep(1.55, 2.35, a)
    return ear_uy * (1.0 - t) + nape_uy * t


def sculpt_hair_cropped(env):
    """compId 1: Close-cropped 16th-c mariner hair cap."""
    bm = bmesh.new()
    na, nr = 18, 5
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    rings = []
    for ri in range(nr):
        s = ri / float(nr)  # 0 at hairline -> 1 near pole
        ring = []
        for az in azs:
            uy0 = hairline_min_uy(az, front_uy=0.42, temple_uy=-0.02, ear_uy=0.08, nape_uy=-0.74)
            uy = uy0 + (0.94 - uy0) * (s ** 0.88)
            horiz = math.sqrt(max(1e-5, 1.0 - uy * uy))
            ux, uz = horiz * math.sin(az), horiz * math.cos(az)
            wave = 0.0012 * math.cos(14.0 * az) * math.sin(math.pi * s)
            thick = 0.0022 + 0.0052 * math.sin(math.pi * (0.15 + 0.78 * s)) + wave
            ring.append(env.skull_point(ux, uy, uz, clearance=thick))
        rings.append(ring)
    pole = env.skull_point(0.0, 1.0, -0.04, clearance=0.0068)
    build_grid_cap(bm, rings, closed_pole=pole, tuck_bottom=0.06)
    shade_fn = lambda v, n: 0.90 + 0.14 * np.clip(n[:, 1], -0.4, 1.0) + 0.05 * np.cos(np.arctan2(v[:, 0], v[:, 2] - env.cran_c[2]) * 14.0)
    return finalize_bmesh(bm, 1, SLOT_HAIR, shade_fn, lambda v: env.head_weights(v))


def sculpt_hair_parted_locks(env):
    """compId 2: Parted 16th-c wavy Renaissance locks framing temples & nape."""
    bm = bmesh.new()
    na, nr = 20, 6
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    rings = []
    for ri in range(nr):
        s = ri / float(nr)
        ring = []
        for az in azs:
            # Parted curtains dip lower along temples & nape while keeping forehead & eyes open
            uy0 = hairline_min_uy(az, front_uy=0.44, temple_uy=-0.28, ear_uy=-0.38, nape_uy=-0.88)
            # Center part notch on forehead
            if abs(az) < 0.28:
                uy0 += 0.10 * (1.0 - abs(az) / 0.28)
            uy = uy0 + (0.95 - uy0) * (s ** 0.86)
            horiz = math.sqrt(max(1e-5, 1.0 - min(0.995, uy * uy)))
            ux, uz = horiz * math.sin(az), horiz * math.cos(az)
            side_fullness = 0.0085 * math.sin(math.pi * min(1.0, s * 1.15)) * (0.45 + 0.55 * math.sin(az) ** 2)
            part_dip = -0.0038 * math.exp(-((az / 0.14) ** 2)) * smoothstep(0.25, 0.85, s)
            lock_wave = 0.0022 * math.cos(12.0 * az + 3.0 * s) * (1.0 - 0.5 * s)
            thick = max(0.0025, 0.0045 + side_fullness + part_dip + lock_wave)
            pt = env.skull_point(ux, uy, uz, clearance=thick)
            # Flare lower wavy locks gently outward at jaw/nape so they drape instead of pinching inward
            if ri <= 2 and abs(az) > 0.75:
                flare = (3 - ri) * 0.0032
                pt[0] += math.sin(az) * flare
                pt[2] += math.cos(az) * flare * 0.6
                pt[1] -= (3 - ri) * 0.0045
            ring.append(pt)
        rings.append(ring)
    pole = env.skull_point(0.0, 1.0, -0.03, clearance=0.0065)
    build_grid_cap(bm, rings, closed_pole=pole, tuck_bottom=0.08)
    shade_fn = lambda v, n: 0.88 + 0.15 * np.clip(n[:, 1], -0.4, 1.0) + 0.07 * np.cos(np.arctan2(v[:, 0], v[:, 2] - env.cran_c[2]) * 12.0)
    return finalize_bmesh(bm, 2, SLOT_HAIR, shade_fn, lambda v: env.head_weights(v, neck_blend_below=env.head_p[1] - 0.005))


def sculpt_hair_queue(env):
    """compId 3: Pulled-back mariner scalp wrap + tied low nape queue/ponytail (fits cleanly under caps/hats!)."""
    bm = bmesh.new()
    na, nr = 16, 4
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    rings = []
    for ri in range(nr):
        s = ri / float(nr)
        ring = []
        for az in azs:
            uy0 = hairline_min_uy(az, front_uy=0.43, temple_uy=0.0, ear_uy=0.08, nape_uy=-0.72)
            uy = uy0 + (0.94 - uy0) * (s ** 0.9)
            horiz = math.sqrt(max(1e-5, 1.0 - uy * uy))
            ring.append(env.skull_point(horiz * math.sin(az), uy, horiz * math.cos(az), clearance=0.0032 + 0.0018 * s))
        rings.append(ring)
    build_grid_cap(bm, rings, closed_pole=env.skull_point(0.0, 1.0, -0.04, clearance=0.0048), tuck_bottom=0.05)

    # Sculpted tied queue emerging from occipital base and draping cleanly down the nape.
    tie_base = env.skull_point(0.0, -0.56, -0.83, clearance=0.005)
    nq = 8
    q_rings = []
    specs = [
        (0.000, 0.000, 0.015, 0.013),
        (-0.016, -0.008, 0.011, 0.010),  # leather/cord tie pinch
        (-0.042, -0.018, 0.018, 0.015),
        (-0.082, -0.026, 0.016, 0.014),
        (-0.125, -0.030, 0.011, 0.010),
        (-0.158, -0.028, 0.004, 0.004),
    ]
    for dy, dz, rx, rz in specs:
        c = tie_base + np.array([0.0, dy, dz], dtype=np.float64)
        q_rings.append([
            np.array([c[0] + rx * math.sin(2.0 * math.pi * i / nq), c[1], c[2] + rz * math.cos(2.0 * math.pi * i / nq)])
            for i in range(nq)
        ])
    build_grid_cap(bm, q_rings[::-1], closed_pole=tie_base + np.array([0.0, 0.004, 0.004]), tuck_bottom=0.6)
    shade_fn = lambda v, n: 0.87 + 0.16 * np.clip(n[:, 1], -0.5, 1.0)
    return finalize_bmesh(bm, 3, SLOT_HAIR, shade_fn, lambda v: env.head_weights(v, neck_blend_below=tie_base[1] - 0.015, spine_tail=True))


def sculpt_hair_nape_bun(env):
    """compId 4: Sleek parted sweep + coiled Iberian nape bun (*coque*), sits below cap/hat brims."""
    bm = bmesh.new()
    na, nr = 16, 4
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    rings = []
    for ri in range(nr):
        s = ri / float(nr)
        ring = []
        for az in azs:
            uy0 = hairline_min_uy(az, front_uy=0.42, temple_uy=-0.04, ear_uy=0.05, nape_uy=-0.74)
            uy = uy0 + (0.94 - uy0) * (s ** 0.9)
            horiz = math.sqrt(max(1e-5, 1.0 - uy * uy))
            ring.append(env.skull_point(horiz * math.sin(az), uy, horiz * math.cos(az), clearance=0.0036 + 0.0020 * s))
        rings.append(ring)
    build_grid_cap(bm, rings, closed_pole=env.skull_point(0.0, 1.0, -0.04, clearance=0.0052), tuck_bottom=0.05)

    # Coiled occipital bun
    bun_c = env.skull_point(0.0, -0.34, -0.94, clearance=0.014)
    nb = 10
    bun_rings = []
    for k, (dz, r_scale) in enumerate([(-0.022, 0.38), (-0.016, 0.82), (-0.005, 1.04), (0.009, 0.96), (0.018, 0.68)]):
        ring = []
        for i in range(nb):
            ang = 2.0 * math.pi * i / nb
            twist = 1.0 + 0.08 * math.cos(5.0 * ang + k * 0.9)
            rx = 0.036 * r_scale * twist
            ry = 0.033 * r_scale * twist
            ring.append(np.array([bun_c[0] + rx * math.sin(ang), bun_c[1] + ry * math.cos(ang), bun_c[2] + dz]))
        bun_rings.append(ring)
    # Build bun oriented aft (-Z)
    v_rings = [[bm.verts.new(Vector(p.tolist())) for p in r] for r in bun_rings]
    for ri in range(len(v_rings) - 1):
        ra, rb = v_rings[ri], v_rings[ri + 1]
        for i in range(nb):
            j = (i + 1) % nb
            bm.faces.new((ra[i], rb[i], rb[j], ra[j]))
    back_pole = bm.verts.new(Vector((bun_c + np.array([0.0, 0.0, -0.026])).tolist()))
    for i in range(nb):
        j = (i + 1) % nb
        bm.faces.new((v_rings[0][i], v_rings[0][j], back_pole))

    shade_fn = lambda v, n: 0.86 + 0.17 * np.clip(n[:, 1], -0.4, 1.0) + 0.06 * np.sin((v[:, 1] - bun_c[1]) * 120.0)
    return finalize_bmesh(bm, 4, SLOT_HAIR, shade_fn, lambda v: env.head_weights(v))


def sculpt_hair_crown_braids(env):
    """compId 5: Parted scalp sweep + braided coronet coil wrapped around the crown."""
    bm = bmesh.new()
    na, nr = 18, 6
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    rings = []
    for ri in range(nr):
        s = ri / float(nr)
        ring = []
        for az in azs:
            uy0 = hairline_min_uy(az, front_uy=0.41, temple_uy=-0.05, ear_uy=0.05, nape_uy=-0.75)
            uy = uy0 + (0.95 - uy0) * (s ** 0.88)
            horiz = math.sqrt(max(1e-5, 1.0 - uy * uy))
            # Raised twisted coronet braid around s in [0.35, 0.65]
            braid_band = math.exp(-(((s - 0.48) / 0.14) ** 2))
            braid_bump = 0.0085 * braid_band * (0.82 + 0.24 * math.cos(18.0 * az))
            ring.append(env.skull_point(horiz * math.sin(az), uy, horiz * math.cos(az), clearance=0.0040 + braid_bump))
        rings.append(ring)
    build_grid_cap(bm, rings, closed_pole=env.skull_point(0.0, 1.0, -0.04, clearance=0.0055), tuck_bottom=0.06)
    shade_fn = lambda v, n: 0.86 + 0.16 * np.clip(n[:, 1], -0.4, 1.0) + 0.07 * np.cos(np.arctan2(v[:, 0], v[:, 2] - env.cran_c[2]) * 18.0)
    return finalize_bmesh(bm, 5, SLOT_HAIR, shade_fn, lambda v: env.head_weights(v))


def sculpt_hat_barrete(env):
    """compId 6: 16th-c Portuguese knitted wool barrete / Monmouth stocking cap (rolled cuff + drooping bag crown)."""
    bm = bmesh.new()
    na = 18
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    rings = []
    # Rolled knitted cuff (rings 0..2) + soft crown rising & drooping aft-right (rings 3..7)
    cuff_specs = [
        (0.00, 0.0065),
        (0.08, 0.0135),
        (0.18, 0.0125),
        (0.26, 0.0090),
    ]
    for s_cuff, clear in cuff_specs:
        ring = []
        for az in azs:
            uy0 = hairline_min_uy(az, front_uy=0.38, temple_uy=0.05, ear_uy=0.10, nape_uy=-0.52)
            uy = uy0 + (0.85 - uy0) * s_cuff
            horiz = math.sqrt(max(1e-5, 1.0 - uy * uy))
            rib = 0.0008 * math.cos(26.0 * az)
            ring.append(env.skull_point(horiz * math.sin(az), uy, horiz * math.cos(az), clearance=clear + rib))
        rings.append(ring)
    # Soft drooping stocking bag above the skull
    top_base = env.cran_c + np.array([0.0, env.cran_r[1] + 0.008, -0.006])
    bag_specs = [
        (np.array([0.008, 0.018, -0.012]), 0.064, 0.072),
        (np.array([0.022, 0.036, -0.032]), 0.046, 0.050),
        (np.array([0.036, 0.028, -0.058]), 0.026, 0.028),
        (np.array([0.045, 0.008, -0.078]), 0.011, 0.011),
    ]
    for shift, rx, rz in bag_specs:
        c = top_base + shift
        rings.append([
            np.array([c[0] + rx * math.sin(az), c[1] + 0.006 * math.cos(az), c[2] + rz * math.cos(az)])
            for az in azs
        ])
    tip = top_base + np.array([0.050, -0.006, -0.090])
    build_grid_cap(bm, rings, closed_pole=tip, tuck_bottom=0.09)
    shade_fn = lambda v, n: 0.86 + 0.16 * np.clip(n[:, 1], -0.4, 1.0) + 0.04 * np.cos(np.arctan2(v[:, 0], v[:, 2] - env.cran_c[2]) * 26.0)
    return finalize_bmesh(bm, 6, SLOT_ACCENT, shade_fn, lambda v: env.head_weights(v))


def sculpt_hat_wide_brim(env):
    """compId 7: 16th-c wide-brim felt / straw sun hat (*chapéu*) with darker recessed hatband."""
    bm = bmesh.new()
    na = 20
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]

    # Seat line around upper forehead / above ears, tilted 4 deg back for clear sightline
    seat = []
    for az in azs:
        uy = 0.39 * math.cos(az) * 0.18 + 0.34  # higher in front (+0.41), snug at back (+0.27)
        horiz = math.sqrt(max(1e-5, 1.0 - uy * uy))
        seat.append(env.skull_point(horiz * math.sin(az), uy, horiz * math.cos(az), clearance=0.0085))

    # Outer brim -> upper brim -> hatband -> crown top (closed solid double-sided brim!)
    brim_under_in = [p + np.array([0.0, -0.003, 0.0]) for p in seat]
    brim_outer_lo = []
    brim_outer_hi = []
    for i, az in enumerate(azs):
        p = seat[i]
        out_dir = np.array([math.sin(az), 0.0, math.cos(az)])
        span = 0.078 + 0.008 * math.cos(az) ** 2
        # Gentle cavalier/peasant brim wave: slight side lift, subtle front dip
        lift = 0.010 * (math.sin(az) ** 2) - 0.004 * math.cos(az)
        lo = p + out_dir * span + np.array([0.0, lift - 0.0025, 0.0])
        hi = p + out_dir * (span + 0.002) + np.array([0.0, lift + 0.0030, 0.0])
        brim_outer_lo.append(lo)
        brim_outer_hi.append(hi)
    band_lo = [p + np.array([0.0, 0.003, 0.0]) for p in seat]
    band_hi = [p + np.array([math.sin(azs[i]) * (-0.002), 0.018, math.cos(azs[i]) * (-0.002)]) for i, p in enumerate(seat)]
    crown_mid = [
        np.array([p[0] * 0.88, env.cran_c[1] + env.cran_r[1] + 0.022, env.cran_c[2] + (p[2] - env.cran_c[2]) * 0.88])
        for p in seat
    ]
    crown_top = [
        np.array([p[0] * 0.72, env.cran_c[1] + env.cran_r[1] + 0.040, env.cran_c[2] + (p[2] - env.cran_c[2]) * 0.72])
        for p in seat
    ]
    pole = np.array([0.0, env.cran_c[1] + env.cran_r[1] + 0.043, env.cran_c[2] - 0.004])
    rings = [brim_under_in, brim_outer_lo, brim_outer_hi, band_lo, band_hi, crown_mid, crown_top]
    build_grid_cap(bm, rings, closed_pole=pole, tuck_bottom=0.06)

    band_y0 = float(np.mean([p[1] for p in band_lo]))
    band_y1 = float(np.mean([p[1] for p in band_hi]))

    def shade_fn(v, n):
        in_band = (v[:, 1] > band_y0 - 0.002) & (v[:, 1] < band_y1 + 0.003) & (np.hypot(v[:, 0], v[:, 2] - env.cran_c[2]) < 0.105)
        base = 0.88 + 0.16 * np.clip(n[:, 1], -0.6, 1.0)
        base[in_band] *= 0.72  # contrasting dark hatband ribbon
        return base

    return finalize_bmesh(bm, 7, SLOT_ACCENT, shade_fn, lambda v: env.head_weights(v))


def sculpt_hat_headscarf(env):
    """compId 8: Tied linen headscarf / Portuguese *lenço* with knotted nape tails."""
    bm = bmesh.new()
    na, nr = 18, 5
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    rings = []
    for ri in range(nr):
        s = ri / float(nr)
        ring = []
        for az in azs:
            uy0 = hairline_min_uy(az, front_uy=0.36, temple_uy=-0.02, ear_uy=-0.08, nape_uy=-0.70)
            uy = uy0 + (0.94 - uy0) * (s ** 0.88)
            horiz = math.sqrt(max(1e-5, 1.0 - uy * uy))
            fold = 0.0016 * math.cos(6.0 * az + 4.0 * s)
            ring.append(env.skull_point(horiz * math.sin(az), uy, horiz * math.cos(az), clearance=0.0068 + 0.0022 * math.sin(math.pi * s) + fold))
        rings.append(ring)
    build_grid_cap(bm, rings, closed_pole=env.skull_point(0.0, 1.0, -0.04, clearance=0.0085), tuck_bottom=0.08)

    # Nape knot + two short tied kerchief tails
    knot_c = env.skull_point(0.0, -0.58, -0.82, clearance=0.012)
    for side in (-1.0, 1.0):
        nt = 5
        t_rings = []
        for dy, dz, spread, r in [
            (0.000, 0.000, 0.006, 0.011),
            (-0.024, -0.010, 0.018, 0.012),
            (-0.056, -0.018, 0.032, 0.008),
        ]:
            c = knot_c + np.array([side * spread, dy, dz])
            t_rings.append([
                np.array([c[0] + r * math.sin(2.0 * math.pi * i / nt), c[1], c[2] + r * 0.7 * math.cos(2.0 * math.pi * i / nt)])
                for i in range(nt)
            ])
        build_grid_cap(bm, t_rings[::-1], closed_pole=knot_c + np.array([side * 0.004, 0.005, 0.0]), tuck_bottom=0.5)

    shade_fn = lambda v, n: 0.90 + 0.14 * np.clip(n[:, 1], -0.4, 1.0)
    return finalize_bmesh(bm, 8, SLOT_LINEN, shade_fn, lambda v: env.head_weights(v, neck_blend_below=knot_c[1] - 0.01))


def sculpt_hat_morion(env):
    """compId 9: 1550 Iberian morion / cabasset / cocked officer hat (fore-and-aft peaked boat brim + sagittal comb)."""
    bm = bmesh.new()
    na = 20
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    seat = []
    for az in azs:
        uy = 0.28 + 0.08 * math.cos(az)
        horiz = math.sqrt(max(1e-5, 1.0 - uy * uy))
        seat.append(env.skull_point(horiz * math.sin(az), uy, horiz * math.cos(az), clearance=0.009))

    brim_in = [p + np.array([0.0, -0.003, 0.0]) for p in seat]
    brim_lo, brim_hi = [], []
    for i, az in enumerate(azs):
        p = seat[i]
        # Peaked fore (az=0) and aft (|az|=pi), narrower & dipped along the sides
        peak = math.cos(az) ** 2
        span = 0.034 + 0.034 * peak
        up_curve = 0.026 * (peak ** 1.4) - 0.004 * (1.0 - peak)
        out_dir = np.array([math.sin(az), 0.0, math.cos(az)])
        brim_lo.append(p + out_dir * span + np.array([0.0, up_curve - 0.0025, 0.0]))
        brim_hi.append(p + out_dir * (span + 0.0015) + np.array([0.0, up_curve + 0.0028, 0.0]))

    bowl_base = [p + np.array([0.0, 0.004, 0.0]) for p in seat]
    rings = [brim_in, brim_lo, brim_hi, bowl_base]
    for s_bowl, shrink in [(0.35, 0.90), (0.68, 0.68), (0.92, 0.34)]:
        ring = []
        for i, az in enumerate(azs):
            p = seat[i]
            # Raised sagittal comb along x ~ 0 (|sin(az)| small)
            comb = 0.020 * math.exp(-((math.sin(az) / 0.20) ** 2)) * s_bowl
            y = p[1] + (env.cran_c[1] + env.cran_r[1] + 0.044 - p[1]) * (s_bowl ** 0.82) + comb
            ring.append(np.array([p[0] * shrink, y, env.cran_c[2] + (p[2] - env.cran_c[2]) * (shrink * 0.96 + 0.06)]))
        rings.append(ring)
    pole = np.array([0.0, env.cran_c[1] + env.cran_r[1] + 0.066, env.cran_c[2] - 0.004])
    build_grid_cap(bm, rings, closed_pole=pole, tuck_bottom=0.06)
    shade_fn = lambda v, n: 0.85 + 0.20 * np.clip(n[:, 1], -0.5, 1.0) + 0.06 * np.abs(n[:, 0])
    return finalize_bmesh(bm, 9, SLOT_ACCENT, shade_fn, lambda v: env.head_weights(v))


def build_moustache_grid(bm, env, width=0.046, droop=0.012):
    """Adds a closed 3D sculpted moustache arch rooted inside the philtrum skin of sailor.glb."""
    y_phil = env.head_p[1] + 0.0165  # ~1.6163 on male (right between nose base 1.628 and mouth 1.603)
    nx = 13
    xs = np.linspace(-width, width, nx)
    prof_angles = [0.0, 0.5 * math.pi, math.pi, 1.5 * math.pi]  # back(in skin), top, front, bottom
    cols = []
    for xv in xs:
        u = abs(xv) / width
        yc = y_phil - droop * (u ** 1.65)
        zc_skin = env.face_front_z(xv, yc)
        # Center philtrum notch + tapered tips
        thick_z = (0.0115 * (1.0 - 0.72 * (u ** 2.2))) * (0.82 + 0.18 * smoothstep(0.0, 0.22, u))
        thick_y = 0.0072 * (1.0 - 0.65 * (u ** 2.0))
        col = []
        for ang in prof_angles:
            # ang=0 -> inner root (-2mm inside skin), ang=pi -> outer front (+thick_z outside skin)
            sz = 0.5 * (1.0 - math.cos(ang))  # 0 at back, 1 at front
            sy = math.sin(ang)
            z = zc_skin - 0.0020 + sz * (thick_z + 0.0020)
            y = yc + sy * thick_y
            col.append(bm.verts.new(Vector([float(xv), float(y), float(z)])))
        cols.append(col)
    for ix in range(nx - 1):
        ca, cb = cols[ix], cols[ix + 1]
        for k in range(4):
            kn = (k + 1) % 4
            bm.faces.new((ca[k], ca[kn], cb[kn], cb[k]))
    # Cap both moustache tips
    bm.faces.new((cols[0][0], cols[0][3], cols[0][2], cols[0][1]))
    bm.faces.new((cols[-1][0], cols[-1][1], cols[-1][2], cols[-1][3]))


def sculpt_beard_moustache(env):
    """compId 10: 16th-c arched sea moustache (*bigode*)."""
    bm = bmesh.new()
    build_moustache_grid(bm, env, width=0.046, droop=0.013)
    shade_fn = lambda v, n: 0.88 + 0.15 * np.clip(n[:, 2], -0.3, 1.0)
    return finalize_bmesh(bm, 10, SLOT_HAIR, shade_fn, lambda v: env.head_weights(v), low_ratio=0.60)


def sculpt_beard_iberian_barba(env):
    """compId 11: Pointed 1550 Iberian *barba* (moustache + sculpted soul-patch & pointed chin beard)."""
    bm = bmesh.new()
    build_moustache_grid(bm, env, width=0.044, droop=0.011)

    # Pointed chin goatee from lower lip/chin crease (head_p.y - 0.004) tapering to a point below the chin
    na = 9
    azs = [(-0.48 * math.pi + 0.96 * math.pi * i / (na - 1)) for i in range(na)]  # front semicircle
    y_top = env.head_p[1] - 0.004
    layers = [
        (0.000, 0.030, 0.005, 0.000),
        (-0.015, 0.032, 0.011, 0.004),
        (-0.034, 0.025, 0.016, 0.011),
        (-0.056, 0.008, 0.008, 0.017),
    ]
    rings = []
    for dy, half_w, jut, fwd_tip in layers:
        yv = y_top + dy
        front_row = []
        back_row = []
        for az in azs:
            xv = half_w * math.sin(az)
            z_skin = env.face_front_z(xv, max(yv, env.head_p[1] - 0.032))
            arch = math.cos(az) ** 1.3
            zf = z_skin + jut * arch + fwd_tip * arch
            zb = z_skin - 0.003 - 0.004 * (1.0 - arch)
            front_row.append(np.array([xv, yv, zf]))
            back_row.append(np.array([xv * 0.85, yv + 0.002, zb]))
        # Closed loop around cross-section (front L->R then back R->L)
        rings.append(front_row + back_row[::-1])
    build_grid_cap(bm, rings[::-1], closed_pole=np.array([0.0, y_top + 0.003, env.face_front_z(0.0, y_top)]), tuck_bottom=0.65)
    shade_fn = lambda v, n: 0.86 + 0.16 * np.clip(n[:, 2], -0.3, 1.0)
    return finalize_bmesh(bm, 11, SLOT_HAIR, shade_fn, lambda v: env.head_weights(v, neck_blend_below=env.head_p[1] - 0.035), low_ratio=0.58)


def sculpt_beard_full_sea(env):
    """compId 12: Full 16th-c mariner sea beard (cheek jaw-whiskers + moustache + layered chest-top beard)."""
    bm = bmesh.new()
    build_moustache_grid(bm, env, width=0.048, droop=0.013)

    na = 11
    azs = [(-0.56 * math.pi + 1.12 * math.pi * i / (na - 1)) for i in range(na)]
    y_top = env.head_p[1] + 0.022  # sideburns start near mid-ear/cheek
    layers = [
        (0.000, 0.068, 0.007, 0.42),   # upper sideburns (hollowed in center for mouth/cheeks via mouth_clear)
        (-0.024, 0.066, 0.014, 0.16),  # jaw corners + lower lip
        (-0.052, 0.058, 0.021, 0.00),  # full chin & jaw beard
        (-0.088, 0.036, 0.017, 0.00),  # tapered rounded bottom
    ]
    rings = []
    for dy, half_w, jut, mouth_dip in layers:
        yv = y_top + dy
        front_row, back_row = [], []
        for az in azs:
            s_az = math.sin(az)
            c_az = math.cos(az)
            xv = half_w * s_az
            # Dip beard hairline below mouth & cheeks near center on the top ring
            y_eff = yv - mouth_dip * (c_az ** 2) * 0.062
            z_skin = env.face_front_z(min(abs(xv), 0.056), max(y_eff, env.head_p[1] - 0.035))
            if abs(xv) > 0.048:
                z_skin = min(z_skin, env.cran_c[2] + 0.052 * (1.0 - (abs(xv) - 0.048) * 6.0))
            wave = 0.0018 * math.cos(9.0 * az)
            zf = z_skin + jut * (0.55 + 0.45 * c_az) + wave
            zb = z_skin - 0.005 - 0.008 * c_az
            front_row.append(np.array([xv, y_eff, zf]))
            back_row.append(np.array([xv * 0.86, y_eff + 0.002, zb]))
        rings.append(front_row + back_row[::-1])

    bot_pole = np.array([0.0, y_top - 0.104, env.face_front_z(0.0, env.head_p[1] - 0.035) + 0.008])
    build_grid_cap(bm, rings, closed_pole=bot_pole, tuck_bottom=0.55)
    shade_fn = lambda v, n: 0.85 + 0.17 * np.clip(n[:, 2], -0.4, 1.0) + 0.05 * np.cos(v[:, 0] * 110.0)
    return finalize_bmesh(bm, 12, SLOT_HAIR, shade_fn, lambda v: env.head_weights(v, neck_blend_below=env.head_p[1] - 0.025, spine_tail=True), low_ratio=0.55)


def sculpt_garment_jerkin(env):
    """compId 13: Sleeveless 16th-c leather/wool jerkin (*gibão*) with V-laced front & peplum hem."""
    bm = bmesh.new()
    na = 22
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    y_lo = 0.895 if env.is_female else 0.910
    y_hi = 1.395 if env.is_female else 1.435
    ys = np.linspace(y_lo, y_hi, 7)

    rings = []
    arm_x = 0.132 if env.is_female else 0.152
    for ri, yv in enumerate(ys):
        s = ri / float(len(ys) - 1)
        # Slight flared peplum skirt below waist (s < 0.22)
        peplum = 0.010 * (1.0 - smoothstep(0.0, 0.26, s))
        ring = []
        for az in azs:
            pt = env.torso_point(yv, az, extra=0.0075 + peplum)
            # Carve sleeveless armhole cutout above mid-chest so sleeves & raised arms never intersect jerkin!
            if s > 0.52 and abs(pt[0]) > arm_x:
                clamp_s = smoothstep(0.52, 0.92, s)
                max_x = arm_x * (1.0 - 0.22 * clamp_s)
                if abs(pt[0]) > max_x:
                    pt[0] = math.copysign(max_x, pt[0])
            # Subtle V-neck dip at front collar (az ~ 0, top 2 rings)
            if s > 0.72 and abs(az) < 0.45:
                pt[1] -= 0.042 * (s - 0.72) / 0.28 * (1.0 - abs(az) / 0.45)
            ring.append(pt)
        rings.append(ring)

    # Tuck both bottom hem and top collar inward to form thick leather/wool edges with zero open floating sheets!
    v_rings = []
    for edge_r, rings_src in [(0, [rings[0]]), (1, rings), (2, [rings[-1]])]:
        if edge_r == 0:
            c0 = np.mean(rings[0], axis=0)
            v_rings.append([bm.verts.new(Vector((c0 + (p - c0) * 0.92).tolist())) for p in rings[0]])
        elif edge_r == 1:
            for r in rings_src:
                v_rings.append([bm.verts.new(Vector(p.tolist())) for p in r])
        else:
            c1 = np.mean(rings[-1], axis=0)
            v_rings.append([bm.verts.new(Vector((c1 + (p - c1) * 0.92).tolist())) for p in rings[-1]])
    for ri in range(len(v_rings) - 1):
        ra, rb = v_rings[ri], v_rings[ri + 1]
        for i in range(na):
            j = (i + 1) % na
            bm.faces.new((ra[i], ra[j], rb[j], rb[i]))

    def shade_fn(v, n):
        # Darker front center lacing seam + waist belt crease
        seam = 1.0 - 0.22 * np.exp(-((v[:, 0] / 0.014) ** 2)) * (v[:, 2] > 0.0)
        waist = 1.0 - 0.14 * np.exp(-(((v[:, 1] - (y_lo + 0.10)) / 0.025) ** 2))
        return (0.90 + 0.12 * np.clip(n[:, 1], -0.4, 1.0)) * seam * waist

    return finalize_bmesh(bm, 13, SLOT_ACCENT, shade_fn, lambda v: env.garment_weights(v, skirt_mode=False))


def sculpt_garment_apron(env):
    """compId 14: Artisan / tavern-keeper / fishwife linen apron (*avental*) with full waist tie & front panel."""
    bm = bmesh.new()
    y_waist = 0.995 if env.is_female else 1.015
    # 1. Tied waist cord all around waist
    na = 20
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    tie_rings = []
    for dy, extra in [(-0.014, 0.006), (0.0, 0.011), (0.014, 0.006)]:
        tie_rings.append([env.torso_point(y_waist + dy, az, extra=extra) for az in azs])
    build_grid_cap(bm, tie_rings, closed_pole=None, tuck_bottom=0.05)

    # 2. Front draped linen panel from chest/bib or waist down to knees (y = 0.54), flared forward for stride clearance
    ny, nx = 6, 9
    y_top = 1.255 if env.is_female else 1.285
    y_bot = 0.535 if env.is_female else 0.555
    ys = np.linspace(y_bot, y_top, ny)
    panel_rows_f, panel_rows_b = [], []
    for yv in ys:
        in_bib = yv > y_waist
        half_ang = (0.30 if in_bib else (0.56 - 0.10 * smoothstep(y_bot, y_waist, yv))) * math.pi * 0.5
        stride_flare = 0.026 * (1.0 - smoothstep(y_bot, y_waist - 0.04, yv))
        row_f, row_b = [], []
        for ix in range(nx):
            u = -1.0 + 2.0 * ix / (nx - 1)
            az = u * half_ang
            fold = 0.0035 * math.cos(u * 4.0 * math.pi) * (1.0 - smoothstep(y_bot + 0.1, y_waist, yv))
            pf = env.torso_point(yv, az, extra=0.011 + stride_flare * (0.65 + 0.35 * math.cos(az)) + fold)
            pb = env.torso_point(yv, az, extra=0.007 + stride_flare * (0.65 + 0.35 * math.cos(az)) + fold)
            row_f.append(bm.verts.new(Vector(pf.tolist())))
            row_b.append(bm.verts.new(Vector(pb.tolist())))
        panel_rows_f.append(row_f)
        panel_rows_b.append(row_b)

    for iy in range(ny - 1):
        for ix in range(nx - 1):
            bm.faces.new((panel_rows_f[iy][ix], panel_rows_f[iy][ix + 1], panel_rows_f[iy + 1][ix + 1], panel_rows_f[iy + 1][ix]))
            bm.faces.new((panel_rows_b[iy][ix + 1], panel_rows_b[iy][ix], panel_rows_b[iy + 1][ix], panel_rows_b[iy + 1][ix + 1]))
    # Stitch side & bottom/top hems so the apron has solid cloth edge thickness
    for iy in range(ny - 1):
        bm.faces.new((panel_rows_b[iy][0], panel_rows_f[iy][0], panel_rows_f[iy + 1][0], panel_rows_b[iy + 1][0]))
        bm.faces.new((panel_rows_f[iy][-1], panel_rows_b[iy][-1], panel_rows_b[iy + 1][-1], panel_rows_f[iy + 1][-1]))
    for ix in range(nx - 1):
        bm.faces.new((panel_rows_b[0][ix], panel_rows_b[0][ix + 1], panel_rows_f[0][ix + 1], panel_rows_f[0][ix]))
        bm.faces.new((panel_rows_f[-1][ix], panel_rows_f[-1][ix + 1], panel_rows_b[-1][ix + 1], panel_rows_b[-1][ix]))

    shade_fn = lambda v, n: 0.92 + 0.10 * np.clip(n[:, 2], -0.4, 1.0) + 0.04 * np.cos(v[:, 0] * 55.0)
    return finalize_bmesh(bm, 14, SLOT_LINEN, shade_fn, lambda v: env.garment_weights(v, skirt_mode=True))


def sculpt_garment_saia_skirt(env):
    """compId 15: Pleated 16th-c *saia* overskirt / kirtle (female), weighted smoothly across pelvis & legs."""
    bm = bmesh.new()
    na = 26
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    y_bot, y_top = 0.34, 1.025
    ys = np.linspace(y_bot, y_top, 7)
    rings = []
    for ri, yv in enumerate(ys):
        s = ri / float(len(ys) - 1)  # 0 at lower calf hem -> 1 at high waist
        flare = (1.0 - s) ** 1.18
        ring = []
        for az in azs:
            base_r = env.torso_radius(max(yv, 0.84), az)
            pleat = 0.0085 * math.cos(14.0 * az) * (0.25 + 0.75 * flare)
            # Bell-shaped Renaissance A-line flare with extra fore/aft stride room
            rx_extra = 0.009 + 0.078 * flare + pleat
            rz_extra = 0.009 + 0.105 * flare + pleat
            c_az, s_az = math.cos(az), math.sin(az)
            rx = base_r + rx_extra
            rz = base_r + rz_extra
            ring.append(np.array([rx * s_az, yv, env.torso_z0 + rz * c_az], dtype=np.float64))
        rings.append(ring)

    # Tuck both waist top and bottom hem inward (solid closed hem rim so looking up from ground never sees paper edge!)
    v_rings = []
    c_bot = np.array([0.0, y_bot + 0.008, env.torso_z0])
    v_rings.append([bm.verts.new(Vector((c_bot + (p - c_bot) * 0.88).tolist())) for p in rings[0]])
    for r in rings:
        v_rings.append([bm.verts.new(Vector(p.tolist())) for p in r])
    c_top = np.array([0.0, y_top - 0.004, env.torso_z0])
    v_rings.append([bm.verts.new(Vector((c_top + (p - c_top) * 0.93).tolist())) for p in rings[-1]])
    for ri in range(len(v_rings) - 1):
        ra, rb = v_rings[ri], v_rings[ri + 1]
        for i in range(na):
            j = (i + 1) % na
            bm.faces.new((ra[i], ra[j], rb[j], rb[i]))

    def shade_fn(v, n):
        az = np.arctan2(v[:, 0], v[:, 2] - env.torso_z0)
        pleat_ao = 0.91 + 0.09 * np.cos(14.0 * az)
        hem_band = np.where((v[:, 1] > y_bot + 0.018) & (v[:, 1] < y_bot + 0.052), 0.78, 1.0)
        return (0.92 + 0.10 * np.clip(n[:, 1], -0.4, 1.0)) * pleat_ao * hem_band

    return finalize_bmesh(bm, 15, SLOT_ACCENT, shade_fn, lambda v: env.garment_weights(v, skirt_mode=True))


def sculpt_garment_waist_sash(env):
    """compId 16: Broad folded mariner / corsair waist sash (*faixa*) with hip knot & hanging tails."""
    bm = bmesh.new()
    na = 20
    azs = [(-math.pi + 2.0 * math.pi * i / na) for i in range(na)]
    y_mid = 0.985 if env.is_female else 1.005
    rings = []
    for dy, extra in [(-0.048, 0.008), (-0.025, 0.015), (0.005, 0.017), (0.036, 0.014), (0.052, 0.008)]:
        ring = []
        for az in azs:
            fold = 0.0020 * math.sin(3.0 * az + dy * 45.0)
            ring.append(env.torso_point(y_mid + dy, az, extra=extra + fold))
        rings.append(ring)
    build_grid_cap(bm, rings, closed_pole=None, tuck_bottom=0.06)

    # Side hip knot + two hanging sash tails on left hip (az ~ +0.44*pi)
    hip_az = 0.44 * math.pi
    hip_base = env.torso_point(y_mid - 0.010, hip_az, extra=0.020)
    for tail_idx, (dz_off, len_y) in enumerate([(-0.018, 0.23), (0.018, 0.19)]):
        nt = 6
        t_rings = []
        for s in [0.0, 0.30, 0.68, 1.0]:
            yv = hip_base[1] - len_y * s
            # Follow hip outer contour so hanging sash never clips Venetian slops
            p_hip = env.torso_point(yv, hip_az + (0.05 if tail_idx else -0.05), extra=0.020 + 0.006 * s)
            c = np.array([p_hip[0], yv, p_hip[2] + dz_off * (0.4 + 0.6 * s)])
            rx = 0.010 * (1.0 - 0.45 * s)
            rz = 0.022 * (1.0 - 0.30 * s)
            t_rings.append([
                np.array([c[0] + rx * math.sin(2.0 * math.pi * i / nt), c[1], c[2] + rz * math.cos(2.0 * math.pi * i / nt)])
                for i in range(nt)
            ])
        build_grid_cap(bm, t_rings[::-1], closed_pole=hip_base + np.array([0.004, 0.012, dz_off * 0.3]), tuck_bottom=0.6)

    shade_fn = lambda v, n: 0.89 + 0.14 * np.clip(n[:, 1], -0.4, 1.0) + 0.05 * np.sin(v[:, 1] * 95.0)
    return finalize_bmesh(bm, 16, SLOT_ACCENT, shade_fn, lambda v: env.garment_weights(v, skirt_mode=True))


def pack_sex_components(glb_path, is_female):
    body = read_glb(glb_path)
    env = BodyEnvelope(body, is_female)
    comps = [
        sculpt_hair_cropped(env),
        sculpt_hair_parted_locks(env),
        sculpt_hair_queue(env),
        sculpt_hair_nape_bun(env),
        sculpt_hair_crown_braids(env),
        sculpt_hat_barrete(env),
        sculpt_hat_wide_brim(env),
        sculpt_hat_headscarf(env),
        sculpt_hat_morion(env),
    ]
    if not is_female:
        comps.extend([
            sculpt_beard_moustache(env),
            sculpt_beard_iberian_barba(env),
            sculpt_beard_full_sea(env),
        ])
    comps.extend([
        sculpt_garment_jerkin(env),
        sculpt_garment_apron(env),
    ])
    if is_female:
        comps.append(sculpt_garment_saia_skirt(env))
    comps.append(sculpt_garment_waist_sash(env))

    # Quantize each vertex to 20 bytes (<3h3b3B4B4B):
    #   pos: int16 * 1e-4 m (0.1 mm resolution), norm: int8 / 127.0,
    #   compId: u8, slot: u8, shade: u8 (0.50 + u8/255 * 0.75),
    #   joints: 4 * u8, weights: 4 * u8 (normalized on unpack).
    total_v = sum(len(c['pos']) for c in comps)
    buf = bytearray(total_v * 20)
    near_all = []
    low_all = []
    v_cursor = 0
    for c in comps:
        nv = len(c['pos'])
        comp_id = int(c['id'])
        slot = int(c['slot'])
        for i in range(nv):
            off = (v_cursor + i) * 20
            px, py, pz = [int(np.clip(round(float(val) * 10000.0), -32767, 32767)) for val in c['pos'][i]]
            nx, ny, nz = [int(np.clip(round(float(val) * 127.0), -127, 127)) for val in c['norm'][i]]
            sh = float(c['color'][i, 0])
            sh_u8 = int(np.clip(round((sh - 0.50) / 0.75 * 255.0), 0, 255))
            j0, j1, j2, j3 = [int(x) for x in c['joints'][i]]
            ws = [max(0.0, float(x)) for x in c['weights'][i]]
            w_sum = sum(ws) or 1.0
            wq = [int(np.clip(round(w / w_sum * 255.0), 0, 255)) for w in ws]
            if sum(wq) == 0:
                wq[0] = 255
            struct.pack_into('<3h3b3B4B4B', buf, off, px, py, pz, nx, ny, nz, comp_id, slot, sh_u8, j0, j1, j2, j3, wq[0], wq[1], wq[2], wq[3])
        near_all.append(c['near'] + v_cursor)
        low_all.append(c['low'] + v_cursor)
        print(f"  comp {comp_id:2d} (slot {slot}): {nv:3d} verts, near={len(c['near'])//3:3d} tris, low={len(c['low'])//3:3d} tris")
        v_cursor += nv

    near_u16 = np.concatenate(near_all).astype(np.uint16)
    low_u16 = np.concatenate(low_all).astype(np.uint16)
    assert total_v < 65535
    print(f"{'FEMALE' if is_female else 'MALE'} total: {total_v} verts ({len(buf)//1024} KB packed), near={len(near_u16)//3} tris, low={len(low_u16)//3} tris")
    return {
        'vertexCount': int(total_v),
        'nearTris': int(len(near_u16) // 3),
        'lowTris': int(len(low_u16) // 3),
        'componentIds': [int(c['id']) for c in comps],
        'verticesQ20B64': base64.b64encode(bytes(buf)).decode('ascii'),
        'nearIndicesB64': base64.b64encode(near_u16.tobytes()).decode('ascii'),
        'lowIndicesB64': base64.b64encode(low_u16.tobytes()).decode('ascii'),
    }


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    male_pack = pack_sex_components(os.path.join(ROOT, 'assets', 'crew', 'sailor.glb'), False)
    female_pack = pack_sex_components(os.path.join(ROOT, 'assets', 'crew', 'sailor-female.glb'), True)
    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    js = (
        '// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.\n'
        '// Generated by scripts/bake-crew-components.py (headless Blender 5.2 LTS, 0 paid model credits).\n'
        '// Quantized 20-byte skinned component vertices (<3h3b3B4B4B) + near/low uint16 relative index lists.\n'
        f'export const CREW_COMPONENT_PACKS = Object.freeze({json.dumps({"male": male_pack, "female": female_pack}, separators=(",", ":"))});\n'
    )
    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write(js)
    print(f'Wrote {OUT_JS} ({len(js) // 1024} KB)')


if __name__ == '__main__':
    main()
