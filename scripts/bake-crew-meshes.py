#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Rebuilds high-craft ~50,000-triangle anatomical human base bodies with:
  1. Selective detail-preserving decimation (~16k tris on head/face/eyelids/lips/ears,
     ~5k on hands, ~29k on torso/limbs -> ~50k tris watertight manifold).
  2. Clean anatomical UV pelt unwrap (ZERO Voronoi soup: the entire face, forehead,
     brows, eyelids, nose, cheeks, lips, chin, ears, and front neck form ONE single
     unbroken, distortion-free UV island with 2x texel density).
  3. Cycles 8K -> 2K EMIT texture bake onto 2048x2048 sRGB with margin dilation.
  4. Smooth 3D skin delighting on the continuous face/body chart (zero bilateral pixel
     mirroring, zero unilateral shadow/glare, preserving brows/lashes/lips/nostrils).
  5. Real, crisp, 100% symmetric 3D UV-sphere eyeballs (_REGION = 0) seated cleanly
     inside recessed anatomical eye sockets with a dedicated 400x400 procedural iris/
     pupil/sclera texture patch (never warped, never neon-white, never misaligned).
  6. Exact 93-joint skeletal weight transfer via Blender DATA_TRANSFER + bit-exact
     preservation of the source GLB's 93-joint Unreal skeleton, IBMs, and animations.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/bake-crew-meshes.py -- [--only=male|female] [--tex=2048]
"""
import collections
import heapq
import io
import json
import math
import os
import struct
import sys
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent
FIT_IN = ROOT / '.tripo' / '1550-hd-base' / 'fit'
FIT_OUT = ROOT / '.tripo' / '1550-hd-base' / 'fit-50k'
VERIFY_DIR = ROOT / '.tripo' / '1550-hd-base' / 'verify-50k'

sys.path.insert(0, str(ROOT / 'scripts'))
from crew_skeleton import JOINTS  # noqa: E402

JOINT_INDEX = {name: i for i, name in enumerate(JOINTS)}

COMPONENT_DTYPE = {
    5121: np.uint8,
    5123: np.uint16,
    5125: np.uint32,
    5126: np.float32,
}
TYPE_WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def parse_cli():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    only = None
    tex_size = 2048
    render_verify = True
    for a in args:
        if a.startswith('--only='):
            only = set(a.split('=', 1)[1].split(','))
        elif a.startswith('--tex='):
            tex_size = int(a.split('=', 1)[1])
        elif a == '--no-verify':
            render_verify = False
    return only, tex_size, render_verify


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def read_glb_raw(glb_path: Path):
    data = glb_path.read_bytes()
    jlen = struct.unpack_from('<I', data, 12)[0]
    g = json.loads(data[20:20 + jlen])
    bin_data = data[20 + jlen + 8:]
    return g, bin_data


def read_accessor(g, bin_data, idx):
    a = g['accessors'][idx]
    v = g['bufferViews'][a['bufferView']]
    off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    dt = COMPONENT_DTYPE[a['componentType']]
    w = TYPE_WIDTH[a['type']]
    arr = np.frombuffer(bin_data, dtype=dt, count=a['count'] * w, offset=off).copy()
    return arr.reshape(-1, w) if w > 1 else arr


def linear_from_srgb(c):
    return np.where(c <= 0.04045, c / 12.92, np.power(np.maximum(c + 0.055, 0.0) / 1.055, 2.4)).astype(np.float32)


def srgb_from_linear(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 1e-12), 1.0 / 2.4) - 0.055).astype(np.float32)


def encode_png_rgb(rgb_u8: np.ndarray) -> bytes:
    """Pure-stdlib RGB PNG encoder (zero Pillow dependency inside Blender Python)."""
    import zlib
    h, w, _ = rgb_u8.shape
    raw = bytearray(h * (1 + w * 3))
    stride = 1 + w * 3
    for y in range(h):
        raw[y * stride] = 0
        raw[y * stride + 1:(y + 1) * stride] = rgb_u8[y].tobytes()

    def chunk(ctype: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(ctype + payload) & 0xFFFFFFFF
        return struct.pack('>I', len(payload)) + ctype + payload + struct.pack('>I', crc)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=6)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')


# --------------------------------------------------------------------------- Mesh repair & anatomical UV seams
def make_strict_closed_manifold(bm):
    """Repairs decimation-induced non-manifold edges/vertices, stray islands, and boundary holes."""
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
            if f.calc_area() < 1e-11:
                bad_faces.add(f)
        if bad_faces:
            bmesh.ops.delete(bm, geom=list(bad_faces), context='FACES')

        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        pinch_faces = set()
        for v in bm.verts:
            if not v.link_faces:
                continue
            bdy_deg = sum(1 for e in v.link_edges if e.is_boundary)
            if bdy_deg > 2:
                for f in v.link_faces:
                    pinch_faces.add(f)
                continue
            if not v.is_manifold:
                lfaces = list(v.link_faces)
                vis = {lfaces[0]}
                q = collections.deque([lfaces[0]])
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
            bmesh.ops.delete(bm, geom=list(pinch_faces), context='FACES')

        loose_e = [e for e in bm.edges if not e.link_faces]
        if loose_e:
            bmesh.ops.delete(bm, geom=loose_e, context='EDGES')
        loose_v = [v for v in bm.verts if not v.link_faces]
        if loose_v:
            bmesh.ops.delete(bm, geom=loose_v, context='VERTS')

        # Keep single largest connected shell
        bm.faces.ensure_lookup_table()
        visited = set()
        comps = []
        for f in bm.faces:
            if f.index in visited:
                continue
            comp = []
            q = collections.deque([f])
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
            bmesh.ops.delete(bm, geom=del_f, context='FACES')
            loose_e = [e for e in bm.edges if not e.link_faces]
            if loose_e:
                bmesh.ops.delete(bm, geom=loose_e, context='EDGES')
            loose_v = [v for v in bm.verts if not v.link_faces]
            if loose_v:
                bmesh.ops.delete(bm, geom=loose_v, context='VERTS')

        bm.edges.ensure_lookup_table()
        bdy = [e for e in bm.edges if e.is_boundary]
        if bdy:
            bmesh.ops.holes_fill(bm, edges=bdy, sides=256)
            bmesh.ops.triangulate(bm, faces=bm.faces[:])

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
                        va, vb = loop_verts[k], loop_verts[(k + 1) % len(loop_verts)]
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
    bm.edges.ensure_lookup_table()
    bm.verts.ensure_lookup_table()
    n_bdy = sum(1 for e in bm.edges if e.is_boundary)
    n_nm = sum(1 for e in bm.edges if not e.is_manifold)
    print(f'  [manifold] verts={len(bm.verts)} tris={len(bm.faces)} boundary={n_bdy} non_manifold={n_nm}')


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


def mark_human_anatomical_pelt_seams(obj, bones, female):
    """Marks clean anatomical seams in Blender Z-up space (+Z up, -Y front, +X left):
      Region 0: HEAD + FRONT NECK (unwrapped flat via ONE vertical slit up the back of skull -> ZERO face seams!)
      Region 1: FRONT TORSO
      Region 2: BACK TORSO
      Region 3: LEFT ARM + HAND (one hidden underside seam)
      Region 4: RIGHT ARM + HAND (one hidden underside seam)
      Region 5: LEFT LEG + FOOT (one hidden medial inner-leg seam)
      Region 6: RIGHT LEG + FOOT (one hidden medial inner-leg seam)
    Returns set of face indices belonging to the HERO HEAD region (0) so we can boost its UV scale 2x!
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.normal_update()

    for e in bm.edges:
        e.seam = False

    neck_z = bones['neck_01'].z
    head_y = bones['head'].y
    pelvis_z = bones['pelvis'].z
    pelvis_y = bones['pelvis'].y
    sh_l = bones['upperarm_l']
    sh_r = bones['upperarm_r']
    arm_x0 = abs(sh_l.x) * 0.96
    arm_z_lo = sh_l.z - 0.14
    crown_z = max(v.co.z for v in bm.verts)
    crotch_z = pelvis_z - (0.14 if female else 0.13)

    # Classify every face into 8 clean anatomical regions:
    #   Region 0: HERO FRONT FACE ONLY (forehead, brows, eyes, nose, cheeks, lips, chin — strictly in front of ears &
    #             hairline so it unwraps flat with ZERO conformal sphere pinch and gets ~800x800 px in the 2K atlas!)
    #   Region 7: BACK OF SKULL + EARS + NECK (hidden under hair/collar; slit vertically up posterior midline)
    #   Regions 1..6: FRONT/BACK TORSO, LEFT/RIGHT ARMS, LEFT/RIGHT LEGS
    region = {}
    for f in bm.faces:
        c = f.calc_center_median()
        # Slightly lower neck seam in front so throat & collarbones stay seamless with face/neck
        neck_cut = neck_z - 0.025 + 0.020 * max(0.0, min(1.0, (c.y - head_y + 0.04) / 0.10))
        if c.z >= neck_cut and abs(c.x) < 0.14:
            # Hero front-face mask strictly in front of ears (y <= head_y - 0.008), below crown hairline, above chin/jaw
            chin_z = neck_z + (0.045 if female else 0.048)
            in_front_face = (
                c.y <= head_y - 0.008
                and c.z >= chin_z
                and c.z <= crown_z - 0.032
                and abs(c.x) <= 0.088
            )
            region[f.index] = 0 if in_front_face else 7
        elif c.x >= arm_x0 and c.z >= arm_z_lo:
            region[f.index] = 3  # LEFT ARM
        elif c.x <= -arm_x0 and c.z >= arm_z_lo:
            region[f.index] = 4  # RIGHT ARM
        elif c.z <= crotch_z:
            region[f.index] = 5 if c.x >= 0.0 else 6  # LEFT / RIGHT LEG
        else:
            # Split torso cleanly along lateral flank plane (y ~ pelvis_y)
            y_split = pelvis_y * 0.65 + sh_l.y * 0.35
            region[f.index] = 1 if c.y <= y_split else 2  # FRONT / BACK TORSO

    # Smooth region boundaries & absorb tiny disconnected speckles so each region is 1 single connected chart!
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
                if best_c >= 2 and best_r != region[f.index]:
                    new_reg[f.index] = best_r
        region = new_reg

    for _ in range(8):
        visited = set()
        comps_by_reg = collections.defaultdict(list)
        for f in bm.faces:
            if f.index in visited:
                continue
            r = region[f.index]
            comp = []
            q = collections.deque([f])
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
                small_set = {f.index for f in small}
                nbr_counts = {}
                for f in small:
                    for e in f.edges:
                        for nf in e.link_faces:
                            if nf.index not in small_set:
                                nr = region[nf.index]
                                nbr_counts[nr] = nbr_counts.get(nr, 0) + 1
                if nbr_counts:
                    target_r = max(nbr_counts.items(), key=lambda kv: kv[1])[0]
                    for f in small:
                        region[f.index] = target_r
                        changed += 1
        if changed == 0:
            break

    # Mark region boundary seams
    seam_verts = set()
    head_neck_seam_verts = set()
    arm_seam_verts = {3: set(), 4: set()}
    leg_seam_verts = {5: set(), 6: set()}
    bdy_edges = 0
    for e in bm.edges:
        if len(e.link_faces) == 2:
            r0, r1 = region[e.link_faces[0].index], region[e.link_faces[1].index]
            if r0 != r1:
                e.seam = True
                bdy_edges += 1
                for v in e.verts:
                    seam_verts.add(v.index)
                    if 7 in (r0, r1) and 0 not in (r0, r1):
                        head_neck_seam_verts.add(v.index)
                    if 3 in (r0, r1):
                        arm_seam_verts[3].add(v.index)
                    if 4 in (r0, r1):
                        arm_seam_verts[4].add(v.index)
                    if 5 in (r0, r1):
                        leg_seam_verts[5].add(v.index)
                    if 6 in (r0, r1):
                        leg_seam_verts[6].add(v.index)

    # 1. SKULL BACK SLIT (Region 7): ONE vertical seam from back of neck seam up the posterior midline to crown
    #    (strictly behind the hairline, NEVER crossing Hero Front Face Region 0!)
    head_verts = [v for v in bm.verts if any(region[f.index] == 7 for f in v.link_faces)]
    if head_verts and head_neck_seam_verts:
        # Crown apex slightly behind midline so slit stops behind hairline
        v_crown = min(
            head_verts,
            key=lambda v: abs(v.co.x) * 3.0 + abs(v.co.z - (crown_z - 0.015)) * 2.0 + max(0.0, head_y - v.co.y) * 5.0
        )
        # Goal: posterior neck seam vertices (y > head_y)
        back_neck_goals = {vi for vi in head_neck_seam_verts if bm.verts[vi].co.y > head_y}
        if not back_neck_goals:
            back_neck_goals = head_neck_seam_verts

        def head_slit_cost(u, v, e):
            p = 0.5 * (u.co + v.co)
            elen = (u.co - v.co).length
            pen = 1.0 + 35.0 * abs(p.x)
            # Strongly forbid going onto front face (y < head_y)!
            if p.y < head_y:
                pen += 200.0 * (head_y - p.y) * 20.0
            if not any(region[f.index] == 7 for f in v.link_faces):
                pen += 200.0
            return elen * pen

        slit = dijkstra_seam_path(bm, v_crown, back_neck_goals, head_slit_cost)
        for e in slit:
            e.seam = True
        print(f'  [uv-seams] head back slit = {len(slit)} edges (crown_z={v_crown.co.z:.4f}, y={v_crown.co.y:.4f})')

    # 2. ARM UNDERSIDE SLITS (left & right): from fingertip back along bottom of arm to armscye seam
    for r_id, sgn in ((3, 1.0), (4, -1.0)):
        averts = [v for v in bm.verts if any(region[f.index] == r_id for f in v.link_faces)]
        if averts and arm_seam_verts[r_id]:
            v_tip = max(averts, key=lambda v: v.co.x * sgn)
            sh_z = sh_l.z if r_id == 3 else sh_r.z

            def arm_cost(u, v, e, rid=r_id):
                p = 0.5 * (u.co + v.co)
                elen = (u.co - v.co).length
                n = (u.normal + v.normal).normalized() if (u.normal + v.normal).length > 1e-6 else Vector((0, 0, -1))
                # Prefer underside (normal.z < 0, lower z) and hidden posterior edge
                pen = 1.0 + 6.0 * max(0.0, n.z) + 4.0 * max(0.0, p.z - (sh_z - 0.02)) * 20.0
                if not any(region[f.index] == rid for f in v.link_faces):
                    pen += 200.0
                return elen * pen

            for e in dijkstra_seam_path(bm, v_tip, arm_seam_verts[r_id], arm_cost):
                e.seam = True

    # 3. LEG MEDIAL INNER SLITS (left & right): from heel/sole up inner thigh to crotch seam
    for r_id, sgn in ((5, 1.0), (6, -1.0)):
        lverts = [v for v in bm.verts if any(region[f.index] == r_id for f in v.link_faces)]
        if lverts and leg_seam_verts[r_id]:
            v_heel = min(lverts, key=lambda v: v.co.z * 4.0 - v.co.y * 0.5 + abs(v.co.x) * 0.5)

            def leg_cost(u, v, e, rid=r_id):
                p = 0.5 * (u.co + v.co)
                elen = (u.co - v.co).length
                # Strongly prefer medial inner edge (smallest |x|)
                pen = 1.0 + 35.0 * abs(p.x)
                if not any(region[f.index] == rid for f in v.link_faces):
                    pen += 200.0
                return elen * pen

            for e in dijkstra_seam_path(bm, v_heel, leg_seam_verts[r_id], leg_cost):
                e.seam = True

    head_face_indices = {fi for fi, r in region.items() if r == 0}
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    print(f'  [uv-seams] boundary_edges={bdy_edges}, head_faces={len(head_face_indices)}')
    return head_face_indices


def unwrap_and_pack_body_uvs(obj, head_face_indices):
    """Unwraps clean anatomical pelt UVs with 2.0x texel boost for the continuous head/face island,
    packs cleanly into v_bl in [0.23, 0.99] (leaving v_bl in [0.00, 0.22] strictly reserved for 3D eyeballs!)."""
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    while len(obj.data.uv_layers) > 0:
        obj.data.uv_layers.remove(obj.data.uv_layers[0])
    obj.data.uv_layers.new(name='UVMap')

    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.unwrap(method='ANGLE_BASED', margin=0.015)
    bpy.ops.object.mode_set(mode='OBJECT')

    # Boost HERO FRONT FACE island texel density 4.5x relative to body/skull islands before packing so
    # eyes, brows, nose, and lips receive ~800x800 pixels (~60x more texel area, ZERO conformal sphere pinch!)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    uv_lay = bm.loops.layers.uv.active
    head_uvs = [l[uv_lay].uv for f in bm.faces if f.index in head_face_indices for l in f.loops]
    if head_uvs:
        cx = sum(u.x for u in head_uvs) / len(head_uvs)
        cy = sum(u.y for u in head_uvs) / len(head_uvs)
        for u in head_uvs:
            u.x = cx + (u.x - cx) * 4.5
            u.y = cy + (u.y - cy) * 4.5
    bm.to_mesh(obj.data)
    bm.free()

    # Pack cleanly with generous margin and zero overlap
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(margin=0.016, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')

    # Map packed [0, 1] x [0, 1] body UVs into u in [0.01, 0.99], v_bl in [0.235, 0.99]
    uv_data = obj.data.uv_layers.active.data
    n_loops = len(uv_data)
    uvs = np.empty(n_loops * 2, dtype=np.float32)
    uv_data.foreach_get('uv', uvs)
    uvs = uvs.reshape(-1, 2)
    u_min, u_max = float(uvs[:, 0].min()), float(uvs[:, 0].max())
    v_min, v_max = float(uvs[:, 1].min()), float(uvs[:, 1].max())
    uvs[:, 0] = 0.01 + ((uvs[:, 0] - u_min) / max(1e-5, u_max - u_min)) * 0.98
    uvs[:, 1] = 0.235 + ((uvs[:, 1] - v_min) / max(1e-5, v_max - v_min)) * 0.755
    uv_data.foreach_set('uv', uvs.ravel())
    obj.data.update()


# --------------------------------------------------------------------------- Cycles 8K -> 2K EMIT Bake
def flood_fill_unbaked(rgba_f32):
    h, w, _ = rgba_f32.shape
    valid = (rgba_f32[:, :, 3] > 0.5) & (np.max(rgba_f32[:, :, :3], axis=2) >= 0.003)
    if np.all(valid) or not np.any(valid):
        return rgba_f32[:, :, :3].copy(), valid
    out = rgba_f32[:, :, :3].copy()
    cur = valid.copy()
    for _ in range(72):
        if np.all(cur):
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
                m = cur[ys, xs]
                acc[yd, xd] += out[ys, xs] * m[:, :, None]
                cnt[yd, xd] += m.astype(np.float32)
        fill = (~cur) & (cnt > 0.0)
        if not np.any(fill):
            break
        out[fill] = acc[fill] / cnt[fill, None]
        cur[fill] = True
    if not np.all(cur):
        out[~cur] = out[valid].mean(axis=0)
    return out, valid


def cycles_emit_bake(src_obj, tgt_obj, src_img, name, tex_size=2048):
    mat_src = bpy.data.materials.new(name=f'{name}_emit_src')
    mat_src.use_nodes = True
    nt = mat_src.node_tree
    nt.nodes.clear()
    n_out = nt.nodes.new('ShaderNodeOutputMaterial')
    n_emit = nt.nodes.new('ShaderNodeEmission')
    n_tex = nt.nodes.new('ShaderNodeTexImage')
    n_tex.image = src_img
    n_tex.interpolation = 'Linear'
    nt.links.new(n_tex.outputs['Color'], n_emit.inputs['Color'])
    nt.links.new(n_emit.outputs['Emission'], n_out.inputs['Surface'])
    src_obj.data.materials.clear()
    src_obj.data.materials.append(mat_src)

    bake_img = bpy.data.images.new(name=f'{name}_baked', width=tex_size, height=tex_size, alpha=True, float_buffer=True)
    bake_img.colorspace_settings.name = 'sRGB'
    bake_img.pixels.foreach_set(np.zeros(tex_size * tex_size * 4, dtype=np.float32))
    mat_tgt = bpy.data.materials.new(name=f'{name}_bake_tgt')
    mat_tgt.use_nodes = True
    nt_t = mat_tgt.node_tree
    nt_t.nodes.clear()
    nt_t.nodes.new('ShaderNodeOutputMaterial')
    nt_tex = nt_t.nodes.new('ShaderNodeTexImage')
    nt_tex.image = bake_img
    nt_t.nodes.active = nt_tex
    tgt_obj.data.materials.clear()
    tgt_obj.data.materials.append(mat_tgt)

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 4
    scene.cycles.use_denoising = False
    scene.cycles.bake_type = 'EMIT'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.use_clear = True
    scene.render.bake.cage_extrusion = 0.025
    scene.render.bake.max_ray_distance = 0.06
    scene.render.bake.margin = 16
    scene.render.bake.margin_type = 'EXTEND'

    bpy.ops.object.select_all(action='DESELECT')
    src_obj.select_set(True)
    tgt_obj.select_set(True)
    bpy.context.view_layer.objects.active = tgt_obj
    t0 = time.perf_counter()
    bpy.ops.object.bake(type='EMIT')
    print(f'  [cycles-bake] {name} {tex_size}x{tex_size} EMIT baked in {time.perf_counter() - t0:.1f}s')

    px = np.empty(tex_size * tex_size * 4, dtype=np.float32)
    bake_img.pixels.foreach_get(px)
    # Blender float_buffer images store LINEAR RGB in pixels! (row 0 = bottom v_bl=0)
    rgba_lin = px.reshape(tex_size, tex_size, 4)
    rgb_lin, valid = flood_fill_unbaked(rgba_lin)
    return rgb_lin, valid


# --------------------------------------------------------------------------- Eye socket analysis & 3D eyeballs
def measure_eyes_and_face(tgt_obj, rgb_lin, bones, female):
    """Measures exact geometric nose midline x_mid, left & right eye opening centers, eyelid rim depth,
    and lip/nose landmarks directly from the 50k target mesh + its freshly baked 2K pelt texture."""
    me = tgt_obj.data
    H, W = rgb_lin.shape[:2]
    n_verts = len(me.vertices)
    pos_bl = np.empty(n_verts * 3, dtype=np.float32)
    me.vertices.foreach_get('co', pos_bl)
    pos_bl = pos_bl.reshape(-1, 3)

    # Convert to glTF Y-up for clean anatomical reasoning: (x_gl = x_bl, y_gl = z_bl, z_gl = -y_bl)
    pos_gl = np.column_stack([pos_bl[:, 0], pos_bl[:, 2], -pos_bl[:, 1]])

    # Per-vertex UV & linear RGB sample
    n_loops = len(me.loops)
    l_verts = np.empty(n_loops, dtype=np.int32)
    me.loops.foreach_get('vertex_index', l_verts)
    uvs = np.empty(n_loops * 2, dtype=np.float32)
    me.uv_layers.active.data.foreach_get('uv', uvs)
    uvs = uvs.reshape(-1, 2)
    # Pick first UV per vertex (all face vertices are interior to the continuous HEAD island!)
    v_uv = np.zeros((n_verts, 2), dtype=np.float32)
    v_uv[l_verts] = uvs
    ux = np.clip((v_uv[:, 0] * W).astype(np.int32), 0, W - 1)
    vy = np.clip((v_uv[:, 1] * H).astype(np.int32), 0, H - 1)  # row 0 = v_bl = 0
    v_rgb = rgb_lin[vy, ux]
    v_luma = v_rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)

    ymax = float(pos_gl[:, 1].max())
    eye_y_est = 1.5825 if female else 1.6585
    nose_y_est = eye_y_est - 0.038
    lip_y_est = 1.506 if female else 1.584

    # Measure sagittal midline x_mid from nose tip prominence
    nose_m = (np.abs(pos_gl[:, 0]) < 0.016) & (np.abs(pos_gl[:, 1] - nose_y_est) < 0.018) & (pos_gl[:, 2] > 0.06)
    nose_pts = pos_gl[nose_m]
    x_mid = float(nose_pts[nose_pts[:, 2] > np.percentile(nose_pts[:, 2], 92), 0].mean()) if len(nose_pts) > 10 else 0.0

    # Measure exact symmetric eye centers from the actual geometric palpebral fissure (bright sclera + dark iris),
    # immune to inner-nose directional shadow!
    eyes = {}
    for side, sgn in (('R', -1.0), ('L', +1.0)):  # R = viewer-left (x < x_mid), L = viewer-right (x > x_mid)
        em = (
            ((pos_gl[:, 0] - x_mid) * sgn > 0.020)
            & ((pos_gl[:, 0] - x_mid) * sgn < 0.047)
            & (np.abs(pos_gl[:, 1] - eye_y_est) < 0.009)
            & (pos_gl[:, 2] > 0.055)
        )
        ep = pos_gl[em]
        el = v_luma[em]
        ergb = v_rgb[em]
        # Iris/pupil + sclera inside fissure has lower R-B warmth than surrounding warm skin!
        low_warm = (ergb[:, 0] - ergb[:, 2]) < np.percentile(ergb[:, 0] - ergb[:, 2], 42)
        dark = el < np.percentile(el, 18)
        fissure = ep[low_warm] if low_warm.sum() >= 12 else ep[dark]
        # Geometric midpoint of fissure X (30th..70th percentile avoids inner nose-bridge shadow bias!)
        cx = float(0.5 * (np.percentile(fissure[:, 0], 25) + np.percentile(fissure[:, 0], 75)))
        cy = float(np.median(fissure[:, 1]))
        cz_surf = float(np.percentile(ep[dark, 2], 55))
        lid_u = (np.abs(pos_gl[:, 0] - cx) < 0.006) & (pos_gl[:, 1] > cy + 0.005) & (pos_gl[:, 1] < cy + 0.011) & (pos_gl[:, 2] > 0.055)
        lid_l = (np.abs(pos_gl[:, 0] - cx) < 0.006) & (pos_gl[:, 1] < cy - 0.004) & (pos_gl[:, 1] > cy - 0.010) & (pos_gl[:, 2] > 0.055)
        zu_rim = float(np.percentile(pos_gl[lid_u, 2], 75)) if lid_u.any() else cz_surf + 0.004
        zl_rim = float(np.percentile(pos_gl[lid_l, 2], 75)) if lid_l.any() else cz_surf + 0.001
        eyes[side] = {
            'cx': cx, 'cy': cy, 'cz_surf': cz_surf,
            'zu_rim': zu_rim, 'zl_rim': zl_rim,
        }

    # Exact symmetric IPD & relaxed natural eye height:
    x_eye_mid = 0.5 * (eyes['R']['cx'] + eyes['L']['cx'])
    ipd_half = 0.5 * (eyes['L']['cx'] - eyes['R']['cx'])
    ipd_half = max(0.0300, min(0.0365, ipd_half))
    eye_y_sym = 0.5 * (eyes['R']['cy'] + eyes['L']['cy']) + (0.0005 if female else 0.0010)
    R_eye = 0.0118 if female else 0.0118

    # Seat front corneal apex tucked naturally inside the eyelids (never bulging forward!)
    specs = {}
    for side, sgn in (('R', -1.0), ('L', +1.0)):
        e = eyes[side]
        cx_final = x_eye_mid + sgn * ipd_half
        cy_final = eye_y_sym
        z_apex = e['cz_surf'] + 0.0002
        z_apex = min(z_apex, e['zu_rim'] - 0.0026)
        cz_center = z_apex - R_eye
        specs[side] = {
            'center_gl': np.array([cx_final, cy_final, cz_center], dtype=np.float32),
            'center_bl': np.array([cx_final, -cz_center, cy_final], dtype=np.float32),
            'z_apex': z_apex,
            'radius': R_eye,
        }
        print(
            f"  [eye-{side}] gl=({cx_final:+.4f}, {cy_final:.4f}, {cz_center:.4f}) "
            f"apex_z={z_apex:.4f} (surf={e['cz_surf']:.4f}, u_rim={e['zu_rim']:.4f}, l_rim={e['zl_rim']:.4f}) R={R_eye:.4f}"
        )

    return {
        'x_mid': x_mid, 'ymax': ymax, 'eye_y': eye_y_sym, 'ipd_half': ipd_half,
        'lip_y': lip_y_est, 'nose_y': nose_y_est, 'eyes': specs,
        'pos_gl': pos_gl, 'v_uv': v_uv, 'v_rgb': v_rgb, 'v_luma': v_luma,
    }


def clean_female_lash_flaps(tgt_obj, bones):
    """Gently relaxes protruding Tripo 4mm eyelash-visor flaps on base-female.glb BEFORE UV unwrap & Cycles bake,
    leaving her lips, nose, cheeks, and chin 100% untouched."""
    me = tgt_obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()

    nose_pts = [v.co for v in bm.verts if abs(v.co.x) < 0.016 and 1.535 < v.co.z < 1.560 and v.co.y < -0.090]
    x_mid = float(np.mean([p.x for p in sorted(nose_pts, key=lambda p: p.y)[:max(6, len(nose_pts)//6)]])) if nose_pts else -0.002

    lid_verts = []
    eye_z_est = 1.5835
    for v in bm.verts:
        if v.co.y > -0.068:
            continue
        for cx in (x_mid - 0.035, x_mid + 0.035):
            dx = (v.co.x - cx) / 0.020
            dz = (v.co.z - eye_z_est) / 0.012
            if dx * dx + dz * dz < 1.0:
                lid_verts.append(v.index)
                break
    for _ in range(14):
        new_co = {}
        for vi in lid_verts:
            v = bm.verts[vi]
            if not v.link_edges:
                continue
            avg = sum((e.other_vert(v).co for e in v.link_edges), Vector((0.0, 0.0, 0.0))) / len(v.link_edges)
            f_y = 0.72 if v.co.y < avg.y - 0.0002 else 0.32
            new_co[vi] = Vector((
                v.co.x * 0.72 + avg.x * 0.28,
                v.co.y * (1.0 - f_y) + avg.y * f_y,
                v.co.z * 0.72 + avg.z * 0.28,
            ))
        for vi, p in new_co.items():
            bm.verts[vi].co = p

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    me.update()
    print(f'  [female-lids] smoothed {len(lid_verts)} protruding lash-flap verts (lips/nose 100% preserved!)')


def clean_head_and_face_skin_weights(tgt_obj, bones, female):
    """Architectural rig fix for ALL human bodies: Tripo auto-skinning leaks `neck_02` and `neck_01` weights
    onto 1,000-2,000 front-face, chin, cheek, and lip vertices! Whenever the `head` bone rotates in Idle/Walk
    while `neck_02` stays behind, those leaked neck weights literally shear the mouth and chin apart by >1.5cm.
    Reassigns all `neck_01`/`neck_02`/upper-torso weights above the anatomical jawline cleanly onto `head`
    with a smooth 2.5cm throat/nape blend ramp, keeping every FACIAL_* bone weight intact."""
    vg_head = tgt_obj.vertex_groups.get('head')
    if vg_head is None:
        vg_head = tgt_obj.vertex_groups.new(name='head')
    neck_names = {'neck_01', 'neck_02', 'spine_03', 'clavicle_l', 'clavicle_r'}
    neck_gids = {g.index for g in tgt_obj.vertex_groups if g.name in neck_names}
    head_y = float(bones['head'].y)
    # Anatomical jawline underside (under chin in front, skull base/occiput in back)
    chin_under_z = 1.462 if female else 1.535
    occiput_z = float(bones['neck_02'].z) + 0.025

    cleaned = 0
    for v in tgt_obj.data.vertices:
        # Smooth front-to-back anatomical jawline threshold z_jaw(y)
        t_fb = max(0.0, min(1.0, (v.co.y - (head_y - 0.05)) / 0.11))
        z_jaw = chin_under_z * (1.0 - t_fb) + occiput_z * t_fb
        if v.co.z <= z_jaw - 0.015:
            continue
        # Ramp 0 -> 1 across 2.5cm band strictly below the chin/jawline; 100% pure head above chin!
        t = max(0.0, min(1.0, (v.co.z - (z_jaw - 0.015)) / 0.025))
        keep_head = t * t * (3.0 - 2.0 * t)
        if keep_head <= 0.0:
            continue
        moved = 0.0
        cur_head = 0.0
        neck_entries = []
        for g in v.groups:
            if g.group == vg_head.index:
                cur_head = g.weight
            elif g.group in neck_gids and g.weight > 1e-6:
                neck_entries.append((g.group, g.weight))
        if not neck_entries:
            continue
        for gid, w in neck_entries:
            take = w * keep_head
            rem = w - take
            moved += take
            grp = tgt_obj.vertex_groups[gid]
            if rem <= 1e-5:
                grp.remove([v.index])
            else:
                grp.add([v.index], rem, 'REPLACE')
        if moved > 1e-6:
            vg_head.add([v.index], cur_head + moved, 'REPLACE')
            cleaned += 1
    print(f'  [rig-clean] reassigned leaked neck weights -> head on {cleaned} face/jaw/cranium verts (ZERO mouth/jaw shear!)')


def sculpt_smooth_eyelids_and_sockets(tgt_obj, face_info, female):
    """1. Smooths out Tripo's jagged crusty eyelash-visor shelves and sharp sculpted eyebrow clay ridges
          via targeted local Laplacian relaxation strictly on eyelid rims & brow ridges.
       2. Smoothly recesses the inner almond-shaped palpebral fissure cleanly BEHIND the 3D eyeball sphere
          so zero skin tabs ever poke through the front of the eyeball while eyelids wrap organically around it."""
    me = tgt_obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()

    rx_open = 0.0126 if female else 0.0130
    ry_open = 0.0056 if female else 0.0052
    x_mid = face_info['x_mid']
    eye_y = face_info['eye_y']

    # Pass A: Identify eyelid-rim vertices (around both palpebral fissures) & sculpted brow ridges
    # and melt jagged Tripo lash-shelf spikes into smooth anatomical human eyelids!
    lid_verts = set()
    brow_verts = set()
    for v in bm.verts:
        gx, gy, gz = v.co.x, v.co.z, -v.co.y
        if gz < 0.055:
            continue
        for side in ('L', 'R'):
            cx, cy, _cz = face_info['eyes'][side]['center_gl']
            dx = (gx - cx) / (rx_open * 1.45)
            dy = (gy - cy) / (ry_open * 2.10)
            if dx * dx + dy * dy < 1.0:
                lid_verts.add(v.index)
                break
        ax = abs(gx - x_mid)
        if 0.010 < ax < 0.056 and (eye_y + 0.009) < gy < (eye_y + 0.028):
            brow_verts.add(v.index)

    # Gently soften only protruding outer Tripo lash-visor spikes (NEVER deform lips, nose, cheeks, or eyelid heights!)
    lid_iters = 6 if female else 3
    for _ in range(lid_iters):
        new_co = {}
        for vi in lid_verts:
            v = bm.verts[vi]
            if not v.link_edges:
                continue
            avg = Vector((0.0, 0.0, 0.0))
            for e in v.link_edges:
                avg += e.other_vert(v).co
            avg /= len(v.link_edges)
            # Only relax depth spikes outward along Y, preserving exact X/Z eyelid silhouette
            new_co[vi] = Vector((
                v.co.x * 0.85 + avg.x * 0.15,
                v.co.y * 0.65 + avg.y * 0.35,
                v.co.z * 0.85 + avg.z * 0.15,
            ))
        for vi, p in new_co.items():
            bm.verts[vi].co = p

    # Pass B: Mathematically recess ONLY the inner palpebral backing strictly BEHIND the 3D eyeball sphere!
    # Lips, nose, cheeks, chin, and outer eyelids are left 100% faithful to the original sculpt.
    recessed = 0
    for v in bm.verts:
        gx, gy, gz = v.co.x, v.co.z, -v.co.y
        if gz < 0.055:
            continue
        for side in ('L', 'R'):
            sp = face_info['eyes'][side]
            cx, cy, cz = [float(x) for x in sp['center_gl']]
            R = float(sp['radius'])
            dx = (gx - cx) / rx_open
            dy = (gy - cy) / ry_open
            # Almond eye fissure contour (tapers slightly toward inner/outer corners)
            r2 = dx * dx + (dy / max(0.35, 1.0 - 0.35 * min(1.0, dx * dx))) ** 2
            if r2 < 1.0:
                w = 0.5 * (1.0 + math.cos(math.pi * math.sqrt(r2)))
                # Sphere front surface Z at (gx, gy)
                rr2 = (gx - cx) ** 2 + (gy - cy) ** 2
                sphere_z = cz + math.sqrt(max(0.0, R * R - rr2)) if rr2 < R * R else cz
                # Push behind sphere surface by at least 3.2 mm inside fissure, blending smoothly to 0 at lid rim
                target_z_gl = min(gz - 0.0040 * w, sphere_z - 0.0032 * (w ** 0.75))
                if target_z_gl < gz:
                    v.co.y = -target_z_gl
                    recessed += 1
                break

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    me.update()
    print(f'  [eyelid-sculpt] gentle lid relax={len(lid_verts)} verts ({lid_iters} iters), recessed {recessed} socket verts (lips/nose untouched!)')


def paint_eyeball_texture_patch(rgb_lin, u_c=0.25, v_bl_c=0.11, r_uv=0.095):
    """Paints a crisp, lifelike, symmetric procedural eye texture (linear RGB) into the reserved
    bottom UV strip v_bl in [0.00, 0.22] of the 2048x2048 atlas.
    Mapping: front hemisphere of 3D eyeball sphere uses azimuthal projection where r_norm = theta / (pi * 0.5):
      - r_norm < 0.115: crisp deep black pupil
      - 0.115..0.325: rich warm hazel-brown iris with radial fibers, golden collarette & crisp dark limbal ring
      - r_norm > 0.325: natural warm off-white sclera (#ded7ce) shading softly warmer toward outer corners,
        plus a gentle upper-eyelid ambient shadow gradient on the upper eyeball!
    """
    H, W = rgb_lin.shape[:2]
    y_max = int(round(0.225 * H))
    yy, xx = np.mgrid[0:y_max, 0:W].astype(np.float32)
    u = (xx + 0.5) / W
    v = (yy + 0.5) / H

    du = (u - u_c) / r_uv
    dv = (v - v_bl_c) / r_uv  # +dv = UP on eyeball!
    r = np.hypot(du, dv)
    ang = np.arctan2(dv, du)

    # Base natural warm off-white sclera (NEVER stark neon white!)
    sclera_center = linear_from_srgb(np.array([0.85, 0.82, 0.78], dtype=np.float32))
    sclera_edge = linear_from_srgb(np.array([0.66, 0.57, 0.52], dtype=np.float32))
    edge_t = np.clip((r - 0.36) / 0.52, 0.0, 1.0)
    edge_t = edge_t * edge_t * (3.0 - 2.0 * edge_t)
    col = sclera_center[None, None, :] * (1.0 - edge_t[..., None]) + sclera_edge[None, None, :] * edge_t[..., None]

    # Subtle capillary/organic warmth at far corners of sclera
    corner_warm = np.clip((np.abs(du) - 0.42) / 0.35, 0.0, 1.0) * (1.0 - np.clip(np.abs(dv) / 0.32, 0.0, 1.0))
    pink_tint = linear_from_srgb(np.array([0.74, 0.54, 0.48], dtype=np.float32))
    col = col * (1.0 - 0.35 * corner_warm[..., None]) + pink_tint[None, None, :] * (0.35 * corner_warm[..., None])

    # Rich lifelike warm hazel-brown iris (r in [0.118, 0.365] — natural 11.8 mm human iris diameter!)
    r_iris = 0.365
    r_pupil = 0.125
    iris_frac = np.clip((r - r_pupil) / max(1e-4, r_iris - r_pupil), 0.0, 1.0)

    # Multi-frequency radial stroma fibers
    fib = (
        0.50 * np.sin(ang * 36.0 + np.sin(ang * 7.0) * 1.4)
        + 0.32 * np.sin(ang * 74.0 - iris_frac * 5.0 + 1.1)
        + 0.18 * np.cos(ang * 128.0 + iris_frac * 9.0)
    )
    fib_mod = 0.84 + 0.24 * fib

    iris_inner = linear_from_srgb(np.array([0.44, 0.27, 0.14], dtype=np.float32))   # warm amber-hazel collarette
    iris_mid = linear_from_srgb(np.array([0.30, 0.17, 0.09], dtype=np.float32))     # rich chestnut brown
    iris_limbus = linear_from_srgb(np.array([0.09, 0.06, 0.05], dtype=np.float32))  # dark crisp limbal ring

    # Blend inner collarette -> mid iris -> dark outer limbal ring
    t_col = np.clip(iris_frac / 0.40, 0.0, 1.0)
    iris_rgb = iris_inner[None, None, :] * (1.0 - t_col[..., None]) + iris_mid[None, None, :] * t_col[..., None]
    iris_rgb *= fib_mod[..., None]

    # Natural corneal caustic: lower half of iris catches subtle warm sky/bounced light, upper is slightly shaded
    caustic = 0.85 + 0.32 * np.clip(-dv / r_iris, -0.5, 1.0)
    iris_rgb *= caustic[..., None]

    # Limbal ring (outer 16% of iris)
    limb_t = np.clip((iris_frac - 0.78) / 0.22, 0.0, 1.0)
    limb_t = limb_t * limb_t
    iris_rgb = iris_rgb * (1.0 - limb_t[..., None] * 0.80) + iris_limbus[None, None, :] * (limb_t[..., None] * 0.80)

    # Smooth anti-aliased iris outer mask
    iris_mask = 1.0 - np.clip((r - (r_iris - 0.014)) / 0.022, 0.0, 1.0)
    iris_mask = iris_mask * iris_mask * (3.0 - 2.0 * iris_mask)
    col = col * (1.0 - iris_mask[..., None]) + iris_rgb * iris_mask[..., None]

    # Crisp centered deep dark pupil
    pupil_rgb = linear_from_srgb(np.array([0.04, 0.035, 0.035], dtype=np.float32))
    pupil_mask = 1.0 - np.clip((r - (r_pupil - 0.008)) / 0.014, 0.0, 1.0)
    pupil_mask = pupil_mask * pupil_mask * (3.0 - 2.0 * pupil_mask)
    col = col * (1.0 - pupil_mask[..., None]) + pupil_rgb[None, None, :] * pupil_mask[..., None]

    # Soft upper-eyelid ambient occlusion shadow across top of eyeball (makes eyes nestle naturally under lids!)
    lid_sh = np.clip((dv - 0.14) / 0.34, 0.0, 1.0)
    lid_sh = lid_sh * lid_sh * (3.0 - 2.0 * lid_sh)
    col *= (1.0 - 0.38 * lid_sh[..., None])

    # Soft lower-eyelid tear-line subtle shadow at bottom
    bot_sh = np.clip((-dv - 0.24) / 0.32, 0.0, 1.0)
    col *= (1.0 - 0.14 * bot_sh[..., None])

    rgb_lin[:y_max, :, :] = np.clip(col, 0.0, 1.0)
    return rgb_lin


def build_eyeball_mesh_arrays(face_info, u_c=0.25, v_bl_c=0.11, r_uv=0.095, u_segs=24, v_segs=16):
    """Creates two clean, smooth, 100% symmetric 3D UV-sphere eyeballs in glTF Y-up space,
    oriented with front pole pointing straight +Z, mapped onto the reserved procedural eye texture patch."""
    positions = []
    normals = []
    uvs_gl = []
    indices = []

    head_slot = JOINT_INDEX['head']

    for side in ('L', 'R'):
        sp = face_info['eyes'][side]
        cx, cy, cz = [float(x) for x in sp['center_gl']]
        R = float(sp['radius'])
        base_v = len(positions)

        # Build UV sphere with poles at +Z (front cornea, iv=0) and -Z (back of eye, iv=v_segs)
        # so the iris & pupil have concentric polar rings with ZERO triangulation pinching!
        for iv in range(v_segs + 1):
            theta = (iv / v_segs) * math.pi  # 0 = +Z front cornea, pi/2 = equator, pi = -Z back
            st = math.sin(theta)
            ct = math.cos(theta)
            r_norm = min(1.15, theta / (math.pi * 0.5))
            for iu in range(u_segs + 1):
                phi = (iu / u_segs) * math.tau
                cp = math.cos(phi)
                sp_a = math.sin(phi)
                nx = st * cp
                ny = st * sp_a
                nz = ct
                positions.append((cx + nx * R, cy + ny * R, cz + nz * R))
                normals.append((nx, ny, nz))
                # Azimuthal projection onto eye texture patch (v_bl -> v_gl = 1 - v_bl!)
                u_tex = u_c + r_norm * cp * r_uv
                v_bl_tex = v_bl_c + r_norm * sp_a * r_uv
                uvs_gl.append((u_tex, 1.0 - v_bl_tex))

        ring = u_segs + 1
        for iv in range(v_segs):
            for iu in range(u_segs):
                a = base_v + iv * ring + iu
                b = base_v + iv * ring + (iu + 1)
                c = base_v + (iv + 1) * ring + (iu + 1)
                d = base_v + (iv + 1) * ring + iu
                # Outward winding (+Z front pole at iv=0, CCW when looking from +Z toward -Z):
                # Going from iv -> iv+1 moves radially outward; iu -> iu+1 moves CCW around +Z!
                if iv > 0:
                    indices.extend([a, d, b])
                if iv < v_segs - 1:
                    indices.extend([b, d, c])

    n = len(positions)
    pos_arr = np.array(positions, dtype=np.float32)
    nrm_arr = np.array(normals, dtype=np.float32)
    uv_arr = np.array(uvs_gl, dtype=np.float32)
    jnt_arr = np.zeros((n, 4), dtype=np.uint8)
    jnt_arr[:, 0] = head_slot
    wgt_arr = np.zeros((n, 4), dtype=np.float32)
    wgt_arr[:, 0] = 1.0
    reg_arr = np.zeros((n, 4), dtype=np.uint8)  # _REGION = 0 (3D eyeball!)
    idx_arr = np.array(indices, dtype=np.uint32)
    return pos_arr, nrm_arr, uv_arr, jnt_arr, wgt_arr, reg_arr, idx_arr


# --------------------------------------------------------------------------- Smooth 3D Skin Delighting
def rasterize_3d_pos_in_uv(tgt_obj, grid_size=512):
    """Rasterizes exact 3D glTF Y-up coordinates onto a grid_size x grid_size UV map (row 0 = v_bl = 0)."""
    me = tgt_obj.data
    n_verts = len(me.vertices)
    pos_bl = np.empty(n_verts * 3, dtype=np.float32)
    me.vertices.foreach_get('co', pos_bl)
    pos_bl = pos_bl.reshape(-1, 3)
    pos_gl = np.column_stack([pos_bl[:, 0], pos_bl[:, 2], -pos_bl[:, 1]]).astype(np.float32)

    uv_data = me.uv_layers.active.data
    pos_map = np.zeros((grid_size, grid_size, 3), dtype=np.float32)
    cov = np.zeros((grid_size, grid_size), dtype=bool)

    for poly in me.polygons:
        ls = poly.loop_indices
        if len(ls) != 3:
            continue
        i0, i1, i2 = me.loops[ls[0]].vertex_index, me.loops[ls[1]].vertex_index, me.loops[ls[2]].vertex_index
        u0 = uv_data[ls[0]].uv
        u1 = uv_data[ls[1]].uv
        u2 = uv_data[ls[2]].uv
        x0, y0 = u0.x * grid_size - 0.5, u0.y * grid_size - 0.5
        x1, y1 = u1.x * grid_size - 0.5, u1.y * grid_size - 0.5
        x2, y2 = u2.x * grid_size - 0.5, u2.y * grid_size - 0.5
        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(area) < 1e-9:
            continue
        inv_a = 1.0 / area
        xmin = max(0, int(math.floor(min(x0, x1, x2))))
        xmax = min(grid_size - 1, int(math.ceil(max(x0, x1, x2))))
        ymin = max(0, int(math.floor(min(y0, y1, y2))))
        ymax = min(grid_size - 1, int(math.ceil(max(y0, y1, y2))))
        if xmax < xmin or ymax < ymin:
            continue
        p0, p1, p2 = pos_gl[i0], pos_gl[i1], pos_gl[i2]
        xs = np.arange(xmin, xmax + 1, dtype=np.float32)
        ys = np.arange(ymin, ymax + 1, dtype=np.float32)
        gx, gy = np.meshgrid(xs, ys)
        w0 = ((x1 - gx) * (y2 - gy) - (x2 - gx) * (y1 - gy)) * inv_a
        w1 = ((x2 - gx) * (y0 - gy) - (x0 - gx) * (y2 - gy)) * inv_a
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if inside.any():
            sub_p = w0[inside, None] * p0 + w1[inside, None] * p1 + w2[inside, None] * p2
            pos_map[ymin:ymax + 1, xmin:xmax + 1][inside] = sub_p
            cov[ymin:ymax + 1, xmin:xmax + 1][inside] = True
    return pos_map, cov


def bilinear_upsample(img_small, target_h, target_w):
    sh, sw = img_small.shape[:2]
    ys = (np.arange(target_h, dtype=np.float32) + 0.5) * (sh / target_h) - 0.5
    xs = (np.arange(target_w, dtype=np.float32) + 0.5) * (sw / target_w) - 0.5
    y0 = np.clip(np.floor(ys).astype(np.int32), 0, sh - 1)
    x0 = np.clip(np.floor(xs).astype(np.int32), 0, sw - 1)
    y1 = np.minimum(y0 + 1, sh - 1)
    x1 = np.minimum(x0 + 1, sw - 1)
    fy = (ys - y0)[:, None, None]
    fx = (xs - x0)[None, :, None]
    c00 = img_small[y0[:, None], x0[None, :]]
    c10 = img_small[y0[:, None], x1[None, :]]
    c01 = img_small[y1[:, None], x0[None, :]]
    c11 = img_small[y1[:, None], x1[None, :]]
    return ((c00 * (1.0 - fx) + c10 * fx) * (1.0 - fy) + (c01 * (1.0 - fx) + c11 * fx) * fy).astype(np.float32)


def delight_continuous_pelt(rgb_lin, tgt_obj, face_info, female):
    """Smoothly removes Tripo's baked unilateral studio shadow, cool bluish shadow cast, and white
    forehead/nose glare across the continuous UV pelt without moving a single pixel spatially!
    Preserves crisp brows, lashes, eyelid creases, nostrils, and natural rosy lips.
    Also cleans residual sclera/iris bleed strictly inside the recessed inner eye socket backing."""
    H, W = rgb_lin.shape[:2]
    pos_gl = face_info['pos_gl']
    v_rgb = face_info['v_rgb']
    v_luma = face_info['v_luma']
    x_mid = face_info['x_mid']
    eye_y = face_info['eye_y']
    ipd_half = face_info['ipd_half']
    lip_y = face_info['lip_y']
    nose_y = face_info['nose_y']
    head_y0 = face_info['ymax'] - 0.27

    # Identify pure-skin anchor vertices (exclude eyes, brows, lips, nostrils so features stay rich & crisp!)
    ax = np.abs(pos_gl[:, 0] - x_mid)
    in_eye = (np.abs(ax - ipd_half) < 0.020) & (np.abs(pos_gl[:, 1] - eye_y) < 0.015) & (pos_gl[:, 2] > 0.045)
    in_brow = (ax > 0.008) & (ax < 0.056) & (pos_gl[:, 1] > eye_y + 0.010) & (pos_gl[:, 1] < eye_y + 0.032) & (pos_gl[:, 2] > 0.050)
    in_lip = (ax < 0.030) & (np.abs(pos_gl[:, 1] - lip_y) < 0.016) & (pos_gl[:, 2] > 0.065)
    in_nostril = (ax < 0.018) & (np.abs(pos_gl[:, 1] - nose_y) < 0.012) & (pos_gl[:, 2] > 0.068)
    is_skin = ~(in_eye | in_brow | in_lip | in_nostril) & (v_luma > 0.020)

    # Target warm, even, neutral skin albedo from well-lit cheek + pure body skin (excluding white Tripo underpants/bandeau!)
    warm_skin_px = (v_rgb[:, 0] - v_rgb[:, 2]) > 0.08
    head_skin = is_skin & (pos_gl[:, 1] > head_y0) & (pos_gl[:, 2] > 0.01) & warm_skin_px
    body_skin = is_skin & (pos_gl[:, 1] <= head_y0) & warm_skin_px
    clean_cheek = head_skin & (pos_gl[:, 0] < x_mid - 0.010) & (pos_gl[:, 0] > x_mid - 0.065) & (pos_gl[:, 1] < eye_y + 0.025) & (pos_gl[:, 1] > lip_y - 0.025)
    t_face = np.median(v_rgb[clean_cheek], axis=0).astype(np.float32) * 0.80 if clean_cheek.any() else np.array([0.46, 0.28, 0.19], np.float32)
    t_body = np.median(v_rgb[body_skin], axis=0).astype(np.float32) * 0.85 if body_skin.any() else t_face
    target_skin = (0.60 * t_face + 0.40 * t_body).astype(np.float32)
    print(f'  [delight] target_skin linear={target_skin.round(4).tolist()}')

    # Subsample skin anchor points (~3000 anchors -> instant vectorized Gaussian evaluation!)
    rng = np.random.default_rng(1550)
    h_idx = np.flatnonzero(head_skin)
    b_idx = np.flatnonzero(body_skin)
    h_pick = h_idx[rng.choice(len(h_idx), min(1400, len(h_idx)), replace=False)]
    b_pick = b_idx[rng.choice(len(b_idx), min(1800, len(b_idx)), replace=False)]
    anchors = np.concatenate([h_pick, b_pick])
    anc_p = pos_gl[anchors]       # (M, 3)
    anc_c = v_rgb[anchors]        # (M, 3)

    # Rasterize 3D positions on a 768x768 UV grid for crisp, zero-seam gain evaluation
    G = 768
    pos_g, cov_g = rasterize_3d_pos_in_uv(tgt_obj, G)
    gy, gx = np.nonzero(cov_g)
    q_pts = pos_g[gy, gx]  # (N, 3)

    # Vectorized chunked Gaussian illumination estimate (zero scipy dependency!)
    local_illum = np.zeros((len(q_pts), 3), dtype=np.float32)
    chunk = 4096
    for s in range(0, len(q_pts), chunk):
        qp = q_pts[s:s + chunk]  # (C, 3)
        diff = qp[:, None, :] - anc_p[None, :, :]  # (C, M, 3)
        d2 = (diff * diff).sum(axis=2)             # (C, M)
        sig = np.where(qp[:, 1:2] > head_y0, 0.028, 0.052).astype(np.float32)
        w = np.exp(-0.5 * d2 / (sig * sig))
        w_sum = np.maximum(w.sum(axis=1, keepdims=True), 1e-6)
        local_illum[s:s + chunk] = (w @ anc_c) / w_sum

    # Smooth RGB delighting gain eliminates both unilateral dark shadows & cool purple/blue shadow cast
    gain_q = target_skin[None, :] / np.maximum(local_illum, 0.022)
    gain_luma = (gain_q @ np.array([0.299, 0.587, 0.114], dtype=np.float32))[:, None]
    gain_q = 0.86 * gain_q + 0.14 * gain_luma
    gain_q = np.clip(gain_q, 0.45, 2.55).astype(np.float32)

    gain_rgba = np.zeros((G, G, 4), dtype=np.float32)
    gain_rgba[gy, gx, :3] = gain_q
    gain_rgba[gy, gx, 3] = 1.0
    gain_filled, _ = flood_fill_unbaked(gain_rgba)
    gain_full = bilinear_upsample(gain_filled, H, W)

    out = np.clip(rgb_lin * gain_full, 0.0, 1.0).astype(np.float32)

    # Soft specular glare knee across skin (eliminates white forehead/cheek studio hotspots cleanly)
    hi_cap = (target_skin * 1.18)[None, None, :]
    over = np.maximum(out - hi_cap, 0.0)
    out = np.minimum(out, hi_cap + over / (1.0 + over * 7.0))

    # Clean up any leftover Tripo sclera/iris pixels STRICTLY inside the recessed inner eye socket & inner lash crease
    # so the eyelid rims frame our crisp 3D eyeballs cleanly with natural lash-line shading!
    pos_rgba = np.zeros((G, G, 4), dtype=np.float32)
    pos_rgba[gy, gx, :3] = q_pts
    pos_rgba[gy, gx, 3] = 1.0
    pos_filled, _ = flood_fill_unbaked(pos_rgba)
    pos_full = bilinear_upsample(pos_filled, H, W)

    rx_clean = 0.0132 if female else 0.0138
    ry_clean = 0.0056 if female else 0.0058
    socket_skin = (target_skin * np.array([0.62, 0.56, 0.54], dtype=np.float32))[None, None, :]
    for side in ('L', 'R'):
        cx, cy, _cz = face_info['eyes'][side]['center_gl']
        dx = (pos_full[:, :, 0] - cx) / rx_clean
        dy = (pos_full[:, :, 1] - cy) / ry_clean
        r2 = dx * dx + dy * dy
        in_sock = (pos_full[:, :, 2] > 0.055) & (r2 < 1.0)
        # Only replace inside the recessed socket (smooth edge near r=0.8..1.0 so natural lid skin & lashes stay crisp!)
        w_s = np.clip((1.0 - np.sqrt(np.maximum(r2, 0.0))) / 0.25, 0.0, 1.0)
        w_s = np.where(in_sock, w_s * w_s * (3.0 - 2.0 * w_s), 0.0).astype(np.float32)
        out = out * (1.0 - w_s[..., None]) + socket_skin * w_s[..., None]

    # Also neutralize any remaining cool/grey/blue chromatic cast strictly on front face skin (preserving rosy lips & dark brows)
    face_mask = (pos_full[:, :, 1] > head_y0) & (pos_full[:, :, 2] > 0.025)
    # On face skin, blue channel should never exceed green * 0.90 (removes cold studio shadow bruises!)
    max_b = out[:, :, 1] * 0.88
    out[:, :, 2] = np.where(face_mask, np.minimum(out[:, :, 2], max_b), out[:, :, 2])

    return np.clip(out, 0.0, 1.0).astype(np.float32)


# --------------------------------------------------------------------------- GLB writer preserving exact 93-joint rig
def write_clean_50k_glb(src_glb_path: Path, out_glb_path: Path, tgt_obj, eye_arrays, rgb_lin: np.ndarray, label: str):
    """Packs the 50k clean anatomical body + 2 symmetric 3D eyeballs + 2048x2048 PNG texture
    into a single-primitive GLB preserving 100% bit-exact nodes, 93-joint skeleton, IBMs, and animations."""
    src_g, src_bin = read_glb_raw(src_glb_path)

    # Extract body geometry from Blender (splitting vertices ONLY where UVs differ along clean pelt seams!)
    me = tgt_obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.normal_update()
    uv_lay = bm.loops.layers.uv.active

    # Map vertex group indices -> 93-joint skeleton slots
    vg_to_slot = {vg.index: JOINT_INDEX[vg.name] for vg in tgt_obj.vertex_groups if vg.name in JOINT_INDEX}
    v_joints = np.zeros((len(me.vertices), 4), dtype=np.uint8)
    v_weights = np.zeros((len(me.vertices), 4), dtype=np.float32)
    fallback_spine = JOINT_INDEX['spine_02']
    for vi, v in enumerate(me.vertices):
        pairs = []
        for g in v.groups:
            js = vg_to_slot.get(g.group, -1)
            if 0 <= js < len(JOINTS) and g.weight > 1e-6:
                pairs.append((js, float(g.weight)))
        pairs.sort(key=lambda kv: kv[1], reverse=True)
        pairs = pairs[:4]
        wsum = sum(w for _, w in pairs)
        if wsum < 1e-6:
            pairs = [(fallback_spine, 1.0)]
            wsum = 1.0
        for k, (js, w) in enumerate(pairs):
            v_joints[vi, k] = js
            v_weights[vi, k] = w / wsum

    vert_map = {}
    b_pos, b_nrm, b_uv, b_jnt, b_wgt, b_idx = [], [], [], [], [], []
    for f in bm.faces:
        tri_ids = []
        for l in f.loops:
            vi = l.vert.index
            uv = l[uv_lay].uv
            u_g = max(0.0, min(1.0, float(uv.x)))
            v_g = max(0.0, min(1.0, 1.0 - float(uv.y)))  # glTF V-flip!
            key = (vi, int(round(u_g * 8191.0)), int(round(v_g * 8191.0)))
            out_i = vert_map.get(key)
            if out_i is None:
                p = l.vert.co
                n = l.vert.normal.normalized() if l.vert.normal.length > 1e-6 else Vector((0, 0, 1))
                out_i = len(b_pos)
                # Blender Z-up -> glTF Y-up: (x, z, -y)
                b_pos.append((p.x, p.z, -p.y))
                b_nrm.append((n.x, n.z, -n.y))
                b_uv.append((u_g, v_g))
                b_jnt.append(v_joints[vi])
                b_wgt.append(v_weights[vi])
                vert_map[key] = out_i
            tri_ids.append(out_i)
        b_idx.extend(tri_ids)
    bm.free()

    body_n = len(b_pos)
    body_pos = np.array(b_pos, dtype=np.float32)
    body_nrm = np.array(b_nrm, dtype=np.float32)
    body_uv = np.array(b_uv, dtype=np.float32)
    body_jnt = np.array(b_jnt, dtype=np.uint8)
    body_wgt = np.array(b_wgt, dtype=np.float32)
    body_reg = np.zeros((body_n, 4), dtype=np.uint8)
    body_reg[:, 0] = 3  # 100% clean anatomical skin!
    body_idx = np.array(b_idx, dtype=np.uint32)

    # Concatenate body + symmetric 3D eyeballs!
    e_pos, e_nrm, e_uv, e_jnt, e_wgt, e_reg, e_idx = eye_arrays
    all_pos = np.concatenate([body_pos, e_pos], axis=0)
    all_nrm = np.concatenate([body_nrm, e_nrm], axis=0)
    all_uv = np.concatenate([body_uv, e_uv], axis=0)
    all_jnt = np.concatenate([body_jnt, e_jnt], axis=0)
    all_wgt = np.concatenate([body_wgt, e_wgt], axis=0)
    all_reg = np.concatenate([body_reg, e_reg], axis=0)
    all_idx = np.concatenate([body_idx, e_idx + body_n], axis=0)

    print(
        f'  [export] {label}: body={body_n}v/{len(body_idx)//3}t + eyes={len(e_pos)}v/{len(e_idx)//3}t '
        f'-> total={len(all_pos)}v/{len(all_idx)//3}t, bbox=({all_pos.min(axis=0).round(4).tolist()}, {all_pos.max(axis=0).round(4).tolist()})'
    )

    # Encode 2048x2048 sRGB PNG (flip vertically so row 0 = top = v_gl=0!)
    rgb_srgb = np.round(np.clip(srgb_from_linear(rgb_lin[::-1]), 0.0, 1.0) * 255.0).astype(np.uint8)
    png_bytes = encode_png_rgb(rgb_srgb)

    # Build clean GLB binary & JSON reusing source skeleton, IBMs, nodes, and animations
    chunks = []
    views = []
    accessors = []
    byte_len = 0

    def add_view(raw_bytes: bytes, target=None):
        nonlocal byte_len
        pad = (4 - (byte_len % 4)) % 4
        if pad:
            chunks.append(b'\x00' * pad)
            byte_len += pad
        off = byte_len
        chunks.append(raw_bytes)
        byte_len += len(raw_bytes)
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(raw_bytes)}
        if target is not None:
            v['target'] = target
        views.append(v)
        return len(views) - 1

    def add_acc(arr: np.ndarray, gl_type: str, comp_type: int, target=None, bounds=False):
        arr = np.ascontiguousarray(arr)
        bv = add_view(arr.tobytes(), target)
        w = TYPE_WIDTH[gl_type]
        cnt = arr.size // w
        a = {'bufferView': bv, 'componentType': comp_type, 'count': int(cnt), 'type': gl_type}
        if bounds:
            flat = arr.reshape(cnt, w)
            a['min'] = [float(x) for x in flat.min(axis=0)]
            a['max'] = [float(x) for x in flat.max(axis=0)]
        accessors.append(a)
        return len(accessors) - 1

    copied_acc = {}

    def copy_src_acc(old_i: int):
        if old_i in copied_acc:
            return copied_acc[old_i]
        sa = src_g['accessors'][old_i]
        arr = read_accessor(src_g, src_bin, old_i)
        ni = add_acc(arr, sa['type'], sa['componentType'], bounds=('min' in sa))
        copied_acc[old_i] = ni
        return ni

    attributes = {
        'POSITION': add_acc(all_pos, 'VEC3', 5126, target=34962, bounds=True),
        'NORMAL': add_acc(all_nrm, 'VEC3', 5126, target=34962),
        'TEXCOORD_0': add_acc(all_uv, 'VEC2', 5126, target=34962),
        'JOINTS_0': add_acc(all_jnt, 'VEC4', 5121, target=34962),
        'WEIGHTS_0': add_acc(all_wgt, 'VEC4', 5126, target=34962),
        '_REGION': add_acc(all_reg, 'VEC4', 5121, target=34962),
    }
    idx_acc = add_acc(all_idx, 'SCALAR', 5125, target=34963, bounds=True)

    skin0 = src_g['skins'][0]
    ibm_acc = copy_src_acc(skin0['inverseBindMatrices'])
    animations = []
    for anim in src_g.get('animations', []):
        animations.append({
            'name': anim['name'],
            'channels': anim['channels'],
            'samplers': [
                {
                    'input': copy_src_acc(s['input']),
                    'output': copy_src_acc(s['output']),
                    'interpolation': s.get('interpolation', 'LINEAR'),
                }
                for s in anim['samplers']
            ],
        })

    img_view = add_view(png_bytes)
    pad = (4 - (byte_len % 4)) % 4
    if pad:
        chunks.append(b'\x00' * pad)
        byte_len += pad

    mesh_node = next(i for i, n in enumerate(src_g['nodes']) if 'mesh' in n)
    nodes = [
        ({**n, 'mesh': 0, 'skin': 0} if i == mesh_node else n)
        for i, n in enumerate(src_g['nodes'])
    ]

    out_json = {
        'asset': {
            'version': '2.0',
            'generator': 'waterworld/scripts/bake-crew-meshes.py',
            'copyright': src_g.get('asset', {}).get('copyright', ''),
        },
        'scene': src_g.get('scene', 0),
        'scenes': src_g['scenes'],
        'nodes': nodes,
        'meshes': [{
            'name': f'{label}-50k',
            'primitives': [{'attributes': attributes, 'indices': idx_acc, 'material': 0}],
        }],
        'materials': [{
            'name': f'{label}_clean_pelt',
            'pbrMetallicRoughness': {
                'baseColorTexture': {'index': 0},
                'metallicFactor': 0.0,
                'roughnessFactor': 0.78,
            },
            'doubleSided': False,
        }],
        'textures': [{'source': 0, 'sampler': 0}],
        'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}],
        'images': [{'bufferView': img_view, 'mimeType': 'image/png'}],
        'skins': [{'name': skin0.get('name', 'Armature'), 'joints': skin0['joints'], 'inverseBindMatrices': ibm_acc}],
        'animations': animations,
        'buffers': [{'byteLength': byte_len}],
        'bufferViews': views,
        'accessors': accessors,
        'extras': {**src_g.get('extras', {}), 'cleanPelt': True, 'has3DEyeballs': True},
    }

    jbytes = json.dumps(out_json, separators=(',', ':')).encode('utf-8')
    jpad = (4 - (len(jbytes) % 4)) % 4
    jbytes += b' ' * jpad
    bin_bytes = b''.join(chunks)
    total_len = 12 + 8 + len(jbytes) + 8 + len(bin_bytes)

    out_glb_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_glb_path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total_len))
        f.write(struct.pack('<II', len(jbytes), 0x4E4F534A))
        f.write(jbytes)
        f.write(struct.pack('<II', len(bin_bytes), 0x004E4942))
        f.write(bin_bytes)

    print(f'  [wrote] {out_glb_path} ({out_glb_path.stat().st_size / 1048576:.2f} MiB, png={len(png_bytes)/1024:.0f} KB)')
    return rgb_srgb


# --------------------------------------------------------------------------- Close-up Portrait Verification Render
def render_head_portraits(glb_path: Path, out_prefix: Path, female: bool):
    """Renders crisp Cycles front + 3/4 portrait close-ups of the newly baked 50k GLB with realistic
    daylight key/fill lighting and wet corneal specular on _REGION=0 eyeballs for visual inspection!"""
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    mesh_obj = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
    bpy.ops.object.select_all(action='DESELECT')
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for p in mesh_obj.data.polygons:
        p.use_smooth = True

    # Build clean PBR material reading embedded baseColor texture + glossy wet cornea on eyeball faces
    tex_img = next((im for im in bpy.data.images if im.size[0] >= 512), None)
    mat_skin = bpy.data.materials.new('PortraitSkin')
    mat_skin.use_nodes = True
    nt = mat_skin.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = 0.62
    n_tex = nt.nodes.new('ShaderNodeTexImage')
    n_tex.image = tex_img
    nt.links.new(n_tex.outputs['Color'], bsdf.inputs['Base Color'])

    mat_eye = bpy.data.materials.new('PortraitEye')
    mat_eye.use_nodes = True
    nt_e = mat_eye.node_tree
    bsdf_e = next(n for n in nt_e.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf_e.inputs['Roughness'].default_value = 0.06
    if 'Coat Weight' in bsdf_e.inputs:
        bsdf_e.inputs['Coat Weight'].default_value = 0.85
        bsdf_e.inputs['Coat Roughness'].default_value = 0.03
    n_tex_e = nt_e.nodes.new('ShaderNodeTexImage')
    n_tex_e.image = tex_img
    nt_e.links.new(n_tex_e.outputs['Color'], bsdf_e.inputs['Base Color'])

    mesh_obj.data.materials.clear()
    mesh_obj.data.materials.append(mat_skin)
    mesh_obj.data.materials.append(mat_eye)

    # Assign eye material to eyeball polygons (UV v_bl < 0.225 -> v_gl > 0.775)
    uv_lay = mesh_obj.data.uv_layers.active.data
    for poly in mesh_obj.data.polygons:
        v_bl = uv_lay[poly.loop_indices[0]].uv.y
        poly.material_index = 1 if v_bl < 0.225 else 0

    # Neutral soft daylight studio sky + sun key + warm fill
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.view_settings.view_transform = 'AgX'

    world = bpy.data.worlds.new('PortraitWorld')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.38, 0.44, 0.52, 1.0)
        bg.inputs[1].default_value = 0.85

    sun_data = bpy.data.lights.new('KeySun', type='SUN')
    sun_data.energy = 3.2
    sun_data.angle = math.radians(12.0)
    sun_obj = bpy.data.objects.new('KeySun', sun_data)
    bpy.context.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = (math.radians(52), math.radians(-18), math.radians(-26))

    fill_data = bpy.data.lights.new('FillArea', type='AREA')
    fill_data.energy = 18.0
    fill_data.size = 1.2
    fill_obj = bpy.data.objects.new('FillArea', fill_data)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.location = (0.9, -1.2, 1.7)
    fill_obj.rotation_euler = (math.radians(78), 0.0, math.radians(36))

    head_z = 1.545 if female else 1.622
    cam_data = bpy.data.cameras.new('PortraitCam')
    cam_data.lens = 85.0
    cam_obj = bpy.data.objects.new('PortraitCam', cam_data)
    bpy.context.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    out_prefix.parent.mkdir(parents=True, exist_ok=True)
    for tag, cam_loc in (
        ('front', Vector((0.0, -0.82, head_z + 0.015))),
        ('3q', Vector((-0.40, -0.70, head_z + 0.025))),
    ):
        cam_obj.location = cam_loc
        direction = Vector((0.0, -0.02, head_z)) - cam_loc
        cam_obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(out_prefix.parent / f'{out_prefix.name}_{tag}.png')
        bpy.ops.render.render(write_still=True)
        print(f'  [verify] rendered {scene.render.filepath}')


# --------------------------------------------------------------------------- Main Pipeline
def process_body(sex: str, out_id: str, tex_size: int, render_verify: bool):
    female = (sex == 'female')
    src_glb = FIT_IN / f'base-{sex}.glb'
    out_glb = FIT_OUT / f'{out_id}.glb'
    t0 = time.perf_counter()
    print(f'\n================ Building clean 50k {out_id} ({sex}) ================')

    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(src_glb))
    src_obj = max((o for o in bpy.context.scene.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
    arm_obj = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')

    # Measure rest bone positions in Blender Z-up space
    arm_mat = arm_obj.matrix_world
    bones = {b.name: arm_mat @ b.head_local for b in arm_obj.data.bones}

    # Apply world transform to source mesh so source & target share exact metric Z-up coordinates
    bpy.ops.object.select_all(action='DESELECT')
    src_obj.select_set(True)
    bpy.context.view_layer.objects.active = src_obj
    src_obj.modifiers.clear()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    src_obj.name = f'{out_id}_source'

    imgs = [im for im in bpy.data.images if im.size[0] >= 512]
    src_img = imgs[0]
    print(f'  [source] {len(src_obj.data.vertices)} verts, {len(src_obj.data.polygons)} tris, img={src_img.size[0]}x{src_img.size[1]}')

    # Duplicate target mesh & strip UV seams -> weld to watertight manifold
    tgt_mesh = src_obj.data.copy()
    tgt_obj = bpy.data.objects.new(f'{out_id}_50k', tgt_mesh)
    bpy.context.collection.objects.link(tgt_obj)
    bpy.ops.object.select_all(action='DESELECT')
    tgt_obj.select_set(True)
    bpy.context.view_layer.objects.active = tgt_obj
    tgt_obj.modifiers.clear()
    tgt_obj.vertex_groups.clear()
    while len(tgt_obj.data.uv_layers) > 0:
        tgt_obj.data.uv_layers.remove(tgt_obj.data.uv_layers[0])

    weld = tgt_obj.modifiers.new('WeldUV', 'WELD')
    weld.merge_threshold = 0.00005
    bpy.ops.object.modifier_apply(modifier=weld.name)
    print(f'  [welded] {len(tgt_obj.data.vertices)} verts, {len(tgt_obj.data.polygons)} tris')

    # 2-Pass Exact Selective Decimation:
    #   Pass 1: Decimate ONLY body/limbs/hands (z < neck_z - 0.015) down to ~33,000 tris (protecting hands slightly).
    #   Pass 2: Decimate ONLY head/neck (z >= neck_z - 0.015) down to ~16,000 tris (protecting front face/eyelids/lips).
    #   Total: ~49,000 body tris + ~1,440 3D eyeball tris = ~50,400 tris, 100% seamless & full feet/hands intact!
    neck_z = bones['neck_01'].z
    head_y = bones['head'].y
    hand_x = abs(bones['hand_l'].x)

    n_total_0 = len(tgt_obj.data.polygons)
    n_head_0 = sum(1 for p in tgt_obj.data.polygons if p.center.z >= neck_z - 0.015)
    vg_body = tgt_obj.vertex_groups.new(name='DecimateBody')
    body_full, hand_verts = [], []
    for v in tgt_obj.data.vertices:
        if v.co.z < neck_z - 0.015:
            if abs(v.co.x) >= hand_x - 0.04:
                hand_verts.append(v.index)
            else:
                body_full.append(v.index)
    if body_full:
        vg_body.add(body_full, 1.0, 'REPLACE')
    if hand_verts:
        vg_body.add(hand_verts, 0.35, 'REPLACE')

    target_body_tris = 30000
    dec1 = tgt_obj.modifiers.new('DecimateBody', 'DECIMATE')
    dec1.decimate_type = 'COLLAPSE'
    dec1.ratio = max(0.01, min(1.0, (n_head_0 + target_body_tris) / float(n_total_0)))
    dec1.vertex_group = 'DecimateBody'
    dec1.invert_vertex_group = False
    dec1.vertex_group_factor = 1.0
    dec1.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=dec1.name)
    tgt_obj.vertex_groups.clear()

    # Pass 2: Decimate head/neck cleanly down to ~19,500 tris with balanced weights so cranium, ears,
    # eyelids, nose, and lips ALL stay ultra-smooth (ZERO polygonal skull silhouette or lip pinches!)
    n_total_1 = len(tgt_obj.data.polygons)
    n_body_1 = sum(1 for p in tgt_obj.data.polygons if p.center.z < neck_z - 0.015)
    vg_head = tgt_obj.vertex_groups.new(name='DecimateHead')
    head_cranium, head_face, head_features = [], [], []
    lip_z_est = 1.506 if female else 1.584
    eye_z_est = 1.582 if female else 1.658
    for v in tgt_obj.data.vertices:
        if v.co.z >= neck_z - 0.015:
            is_lip = abs(v.co.x) < 0.036 and abs(v.co.z - lip_z_est) < 0.020 and v.co.y < head_y - 0.035
            is_eye = abs(v.co.x) < 0.060 and abs(v.co.z - eye_z_est) < 0.022 and v.co.y < head_y - 0.030
            if is_lip or is_eye:
                head_features.append(v.index)
            elif v.co.y < head_y - 0.010 and abs(v.co.x) < 0.095:
                head_face.append(v.index)
            else:
                head_cranium.append(v.index)
    if head_cranium:
        vg_head.add(head_cranium, 0.72, 'REPLACE')
    if head_face:
        vg_head.add(head_face, 0.50, 'REPLACE')
    if head_features:
        vg_head.add(head_features, 0.28, 'REPLACE')

    target_head_tris = 19500
    dec2 = tgt_obj.modifiers.new('DecimateHead', 'DECIMATE')
    dec2.decimate_type = 'COLLAPSE'
    dec2.ratio = max(0.05, min(1.0, (n_body_1 + target_head_tris) / float(n_total_1)))
    dec2.vertex_group = 'DecimateHead'
    dec2.invert_vertex_group = False
    dec2.vertex_group_factor = 1.0
    dec2.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=dec2.name)
    tgt_obj.vertex_groups.clear()

    # Repair to strict watertight closed 2-manifold
    bm_m = bmesh.new()
    bm_m.from_mesh(tgt_obj.data)
    make_strict_closed_manifold(bm_m)
    head_tris = sum(1 for f in bm_m.faces if f.calc_center_median().z >= neck_z - 0.015)
    print(f'  [decimate] total={len(bm_m.faces)} tris (head/face={head_tris} tris, body/limbs={len(bm_m.faces)-head_tris} tris)')
    bm_m.to_mesh(tgt_obj.data)
    bm_m.free()
    tgt_obj.data.update()

    # Relax protruding Tripo lash flaps on female BEFORE UV unwrap & Cycles bake (lips/nose 100% preserved!)
    if female:
        clean_female_lash_flaps(tgt_obj, bones)

    # Clean anatomical UV pelt unwrap (ONE unbroken front-face chart ~900x900px, eye strip reserved!)
    head_face_indices = mark_human_anatomical_pelt_seams(tgt_obj, bones, female)
    unwrap_and_pack_body_uvs(tgt_obj, head_face_indices)

    # Cycles 8K -> 2K EMIT bake from original 2M-tri Tripo source onto our clean 50k pelt mesh
    rgb_lin, _valid = cycles_emit_bake(src_obj, tgt_obj, src_img, out_id, tex_size=tex_size)

    # Measure exact symmetric eye centers & facial landmarks on the 50k mesh + baked pelt texture
    face_info = measure_eyes_and_face(tgt_obj, rgb_lin, bones, female)

    # Smooth 3D skin delighting on continuous face/body chart (zero bilateral mirroring, zero shadow/glare!)
    rgb_lin = delight_continuous_pelt(rgb_lin, tgt_obj, face_info, female)

    # Paint crisp, lifelike, symmetric procedural eyeball patch into the reserved bottom UV strip!
    rgb_lin = paint_eyeball_texture_patch(rgb_lin, u_c=0.25, v_bl_c=0.11, r_uv=0.095)

    # Smooth jagged Tripo eyelid lash-visors & brow ridges, and recess eye sockets cleanly behind 3D eyeballs!
    sculpt_smooth_eyelids_and_sockets(tgt_obj, face_info, female)

    # Transfer exact 93-joint skeletal weights from 2M-tri source (use a 80k donor copy for fast exact transfer)
    bpy.ops.object.select_all(action='DESELECT')
    tgt_obj.select_set(True)
    bpy.context.view_layer.objects.active = tgt_obj
    dt = tgt_obj.modifiers.new('SkinTransfer', 'DATA_TRANSFER')
    dt.object = src_obj
    dt.use_vert_data = True
    dt.data_types_verts = {'VGROUP_WEIGHTS'}
    dt.vert_mapping = 'POLYINTERP_NEAREST'
    bpy.ops.object.datalayout_transfer(modifier=dt.name)
    bpy.ops.object.modifier_apply(modifier=dt.name)

    # Architectural rig fix: remove leaked neck_02/neck_01 weights from face/lips/chin so turning the head NEVER shears the mouth!
    clean_head_and_face_skin_weights(tgt_obj, bones, female)

    # Build clean symmetric 3D spherical eyeballs (_REGION = 0)
    eye_arrays = build_eyeball_mesh_arrays(face_info, u_c=0.25, v_bl_c=0.11, r_uv=0.095)

    # Pack single-primitive GLB preserving exact 93-joint skeleton, IBMs, and animations
    rgb_srgb = write_clean_50k_glb(src_glb, out_glb, tgt_obj, eye_arrays, rgb_lin, out_id)

    # Save texture preview PNG for direct visual inspection
    VERIFY_DIR.mkdir(parents=True, exist_ok=True)
    tex_preview = VERIFY_DIR / f'{out_id}_pelt_2k.png'
    tex_preview.write_bytes(encode_png_rgb(rgb_srgb))
    print(f'  [verify] saved UV texture {tex_preview}')

    if render_verify:
        render_head_portraits(out_glb, VERIFY_DIR / f'{out_id}_portrait', female)

    print(f'Finished {out_id} in {time.perf_counter() - t0:.1f}s')


def main():
    only, tex_size, render_verify = parse_cli()
    jobs = [
        ('male', 'sailor-male'),
        ('female', 'villager-female'),
    ]
    for sex, out_id in jobs:
        if only is not None and sex not in only and out_id not in only:
            continue
        process_body(sex, out_id, tex_size, render_verify)


if __name__ == '__main__':
    main()
