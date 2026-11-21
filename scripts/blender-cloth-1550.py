#!/usr/bin/env python3
"""Headless Blender real 3D Cloth-Simulated 1550 Garment Studio.

Imports the fitted 2M-triangle Tripo H3.1 Ultra undressed male & female base bodies
(`.tripo/1550-hd-base/fit/{base-male,base-female}.glb`), constructs high-resolution tailored
1550 sewing-pattern meshes around each body's exact surface, runs Blender's physical CLOTH
simulation with collision against the body, applies SUBSURF + SOLIDIFY for real fabric
thickness and hems, adds sculpted 3D belts/buckles/buttons/lacing/shoes, computes physical
cloth-crease cavity AO, transfers exact 93-joint skeletal weights via Blender's DATA_TRANSFER,
and exports binary garment meshes (`.tripo/1550-hd-base/cloth/<garment-id>.bin`) for
`scripts/prepare-clothing-continuum.mjs` to bake into One Continuum.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/blender-cloth-1550.py -- [options]
    --only=id1,id2     Only build specific garments
    --sex=male|female  Only build male or female garments
    --sim-frames=28    Cloth simulation frames (default 28)
"""
import bmesh
import bpy
import math
import os
import struct
import sys
import time
from mathutils import Vector, Matrix

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIT_50K_DIR = os.path.join(ROOT, '.tripo', '1550-hd-base', 'fit-50k')
FIT_DIR = os.path.join(ROOT, '.tripo', '1550-hd-base', 'fit')
OUT_DIR = os.path.join(ROOT, '.tripo', '1550-hd-base', 'cloth')
VERIFY_CLOTH_DIR = os.path.join(ROOT, '.tripo', '1550-hd-base', 'verify-cloth')

# Must match scripts/crew_skeleton.py / js/crew-skeleton.js exact 93-joint order
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from crew_skeleton import JOINTS  # noqa: E402

JOINT_INDEX = {name: i for i, name in enumerate(JOINTS)}

# Cloth material channels (bits 0..2 of vertex word, matching js/wgsl/crew-continuum.js)
CH_SHIRT = 0
CH_TROUSERS = 1
CH_LINEN = 2
CH_LEATHER = 3
CH_BRASS = 4
CH_BUFF = 5
CH_HOSE = 6
CH_TRIM = 7

# Fabric weave types (bits 3..5 of vertex word)
FAB_LINEN = 0
FAB_WOOL = 1
FAB_LEATHER = 2
FAB_BRASS = 3
FAB_COTTON = 4

# Garment definitions matching js/clothing-continuum.js CLOTHING_CONTINUUM_TYPES
GARMENTS = [
    ('male-linen-shirt', 'male', 'upper'),
    ('male-doublet', 'male', 'upper'),
    ('male-soldier-jerkin', 'male', 'upper'),
    ('female-chemise-blouse', 'female', 'upper'),
    ('female-laced-bodice', 'female', 'upper'),
    ('indigenous-tunic-m', 'male', 'upper'),
    ('indigenous-huipil-f', 'female', 'upper'),
    ('male-mariner-slops', 'male', 'lower'),
    ('male-trunk-hose', 'male', 'lower'),
    ('female-pleated-skirt', 'female', 'lower'),
    ('female-apron-skirt', 'female', 'lower'),
    ('indigenous-breechcloth-m', 'male', 'lower'),
    ('indigenous-wrap-skirt-f', 'female', 'lower'),
    ('shoulder-cloak', 'male', 'cloak'),
    ('female-riding-breeches', 'female', 'lower'),
]


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    only = None
    sex_filter = None
    sim_frames = 12
    verify = False
    for a in argv:
        if a.startswith('--only='):
            only = set(a.split('=', 1)[1].split(','))
        elif a.startswith('--sex='):
            sex_filter = a.split('=', 1)[1]
        elif a.startswith('--sim-frames='):
            sim_frames = int(a.split('=', 1)[1])
        elif a == '--verify':
            verify = True
    return only, sex_filter, sim_frames, verify


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fitted_body(glb_path):
    """Imports a fitted 2M-tri Tripo body GLB (Y-up in GLB -> Z-up in Blender!)."""
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=glb_path)
    mesh_obj = None
    arm_obj = None
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and (mesh_obj is None or len(o.data.vertices) > len(mesh_obj.data.vertices)):
            mesh_obj = o
        elif o.type == 'ARMATURE':
            arm_obj = o
    if mesh_obj is None or arm_obj is None:
        raise RuntimeError(f'Missing mesh or armature in {glb_path}')

    # Apply world transforms to mesh geometry so coordinates are direct Blender world Z-up metres!
    # Note: glTF Y-up -> Blender Z-up: (x_gl, y_gl, z_gl) -> (x_bl = x_gl, y_bl = -z_gl, z_bl = y_gl)
    # Wait: Blender glTF importer rotates root by +90 deg X so:
    #   Blender +X = glTF +X (left)
    #   Blender -Y = glTF +Z (front face looks toward -Y in Blender!)
    #   Blender +Z = glTF +Y (up!)
    bpy.context.view_layer.objects.active = mesh_obj
    mesh_obj.select_set(True)

    # Measure bone world positions in Blender Z-up space
    arm_mat = arm_obj.matrix_world
    bones = {}
    for b in arm_obj.data.bones:
        bones[b.name] = arm_mat @ b.head_local

    # Build a clean ~28k-tri decimated collision + raycast proxy in world space (keeps 2M-tri original for exact DATA_TRANSFER!)
    bpy.ops.object.select_all(action='DESELECT')
    proxy_data = mesh_obj.data.copy()
    proxy = bpy.data.objects.new('BodyCollisionProxy', proxy_data)
    bpy.context.collection.objects.link(proxy)
    proxy.matrix_world = mesh_obj.matrix_world.copy()
    bpy.context.view_layer.objects.active = proxy
    proxy.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # Strip vertex groups & modifiers on proxy
    proxy.vertex_groups.clear()
    proxy.modifiers.clear()
    # Decimate to ~28k faces for fast raycasts & Blender Cloth collision
    n_polys = len(proxy.data.polygons)
    if n_polys > 32000:
        dec = proxy.modifiers.new('Decimate', 'DECIMATE')
        dec.ratio = 28000.0 / float(n_polys)
        bpy.ops.object.modifier_apply(modifier=dec.name)

    # Create a separate collision collider inflated by +6mm outward so simulated cloth drapes close without intersecting!
    col_data = proxy.data.copy()
    collider = bpy.data.objects.new('BodyCollider', col_data)
    bpy.context.collection.objects.link(collider)
    bpy.context.view_layer.objects.active = collider
    collider.select_set(True)
    disp = collider.modifiers.new('Inflate', 'DISPLACE')
    disp.strength = 0.006
    disp.mid_level = 0.0
    bpy.ops.object.modifier_apply(modifier=disp.name)
    bpy.ops.object.modifier_add(type='COLLISION')
    collider.collision.thickness_outer = 0.006
    collider.collision.thickness_inner = 0.012
    collider.collision.cloth_friction = 22.0
    collider.collision.damping = 0.35

    # Also build a ~60k-tri skinning donor copy with exact vertex groups (fast DATA_TRANSFER, identical weights!)
    bpy.ops.object.select_all(action='DESELECT')
    donor = mesh_obj.copy()
    donor.data = mesh_obj.data.copy()
    donor.name = 'SkinDonor'
    bpy.context.collection.objects.link(donor)
    bpy.context.view_layer.objects.active = donor
    donor.select_set(True)
    donor.modifiers.clear()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(donor.data.polygons) > 65000:
        dec2 = donor.modifiers.new('Decimate', 'DECIMATE')
        dec2.ratio = 60000.0 / float(len(donor.data.polygons))
        bpy.ops.object.modifier_apply(modifier=dec2.name)

    # Hide original 2M-tri mesh during cloth sim so scene updates stay blazing fast
    mesh_obj.hide_viewport = True

    return {
        'mesh': mesh_obj,
        'arm': arm_obj,
        'proxy': proxy,
        'collider': collider,
        'donor': donor,
        'bones': bones,
    }


class BodySurface:
    """Exact surface raycaster against the imported Tripo body in Blender Z-up space (+Z up, -Y front, +X left)."""

    def __init__(self, body_ctx, female=False):
        self.ctx = body_ctx
        self.proxy = body_ctx['proxy']
        self.bones = body_ctx['bones']
        self.female = female

        # Determine front sign (-Y in standard glTF->Blender import; verify from nose/face or foot toes)
        foot_l = self.bone('foot_l')
        ball_l = self.bone('ball_l')
        self.front_y = -1.0 if (ball_l.y - foot_l.y) < 0 else 1.0
        self.sh_l = self.bone('upperarm_l')
        self.sh_r = self.bone('upperarm_r')
        self.el_l = self.bone('lowerarm_l')
        self.ha_l = self.bone('hand_l')
        self.pelvis = self.bone('pelvis')
        self.neck = self.bone('neck_01')
        self.head = self.bone('head')
        self.thigh_l = self.bone('thigh_l')
        self.calf_l = self.bone('calf_l')
        self.foot_l = foot_l
        self.foot_r = self.bone('foot_r')
        self.arm_x0 = abs(self.sh_l.x) * 0.85
        self.arm_x1 = abs(self.ha_l.x)
        self.arm_cut = abs(self.sh_l.x) + 0.045

        # Precompute exact torso center Y and polar surface radii via raycasts from outside inward (catches outermost silhouette!)
        self.t_nz, self.t_nt = 44, 48
        self.t_z0, self.t_z1 = 0.74, self.neck.z + 0.04
        self.torso_yc = [self.pelvis.y] * self.t_nz
        self.torso_r = [[0.14] * self.t_nt for _ in range(self.t_nz)]
        for iz in range(self.t_nz):
            z = self.t_z0 + (iz / (self.t_nz - 1)) * (self.t_z1 - self.t_z0)
            # Find front/back Y extents at x=0 by casting inward from front and back
            y_front = self._ray_inward(Vector((0.0, self.front_y * 0.6, z)), Vector((0.0, -self.front_y, 0.0)))
            y_back = self._ray_inward(Vector((0.0, -self.front_y * 0.6, z)), Vector((0.0, self.front_y, 0.0)))
            yc = 0.5 * (y_front.y + y_back.y) if (y_front and y_back) else self.pelvis.y
            self.torso_yc[iz] = yc
            for it in range(self.t_nt):
                th = (it / self.t_nt) * math.tau  # 0 = front, pi/2 = +X (left), pi = back
                dx = math.sin(th)
                dy = math.cos(th) * self.front_y
                best = 0.0
                for dz in (-0.012, 0.0, 0.012):
                    # Cast inward from r=0.55 toward center (0, yc, z+dz), ignore arm hits beyond arm_cut
                    origin = Vector((dx * 0.55, yc + dy * 0.55, z + dz))
                    direction = Vector((-dx, -dy, 0.0))
                    ok, loc, _n, _f = self.proxy.ray_cast(origin, direction, distance=0.55)
                    if ok and abs(loc.x) <= self.arm_cut:
                        r = math.hypot(loc.x, loc.y - yc)
                        if r > best:
                            best = r
                self.torso_r[iz][it] = best
        # Fill any missed grazing rays, then run 2D Gaussian outer-convex envelope smoothing
        # taking max(raw_r, smoothed_r) so the torso envelope NEVER shrinks into skin and has ZERO raycast dimples!
        for _ in range(3):
            prev = [row[:] for row in self.torso_r]
            for iz in range(self.t_nz):
                for it in range(self.t_nt):
                    c = prev[iz][it]
                    nb = [
                        prev[iz][(it - 1) % self.t_nt],
                        prev[iz][(it + 1) % self.t_nt],
                        prev[max(0, iz - 1)][it],
                        prev[min(self.t_nz - 1, iz + 1)][it],
                    ]
                    if c < 0.04:
                        self.torso_r[iz][it] = max(nb)
        # 3 passes of 5x5 separable Gaussian smoothing with max(raw_r, smooth_r) convex-hull preservation
        gauss = (0.0625, 0.25, 0.375, 0.25, 0.0625)
        for _ in range(3):
            tmp = [[0.0] * self.t_nt for _ in range(self.t_nz)]
            for iz in range(self.t_nz):
                for it in range(self.t_nt):
                    s = 0.0
                    for k, wk in enumerate(gauss):
                        s += wk * self.torso_r[iz][(it + k - 2) % self.t_nt]
                    tmp[iz][it] = s
            for iz in range(self.t_nz):
                for it in range(self.t_nt):
                    s = 0.0
                    for k, wk in enumerate(gauss):
                        jz = max(0, min(self.t_nz - 1, iz + k - 2))
                        s += wk * tmp[jz][it]
                    self.torso_r[iz][it] = max(self.torso_r[iz][it], s)

        # Female chest/bust bridge envelope: smoothly bridge the front sternum valley between left & right bust peaks
        # and add positive bust clearance so blouses/bodices drape smoothly across the chest with ZERO cleavage poke-through!
        if self.female:
            bust_z0 = self.pelvis.z + 0.14
            bust_z1 = self.sh_l.z - 0.015
            for iz in range(self.t_nz):
                z = self.t_z0 + (iz / (self.t_nz - 1)) * (self.t_z1 - self.t_z0)
                if z < bust_z0 - 0.05 or z > bust_z1 + 0.04:
                    continue
                # Vertical smooth weight over bust zone
                wz_lo = max(0.0, min(1.0, (z - (bust_z0 - 0.05)) / 0.07))
                wz_hi = max(0.0, min(1.0, ((bust_z1 + 0.04) - z) / 0.05))
                wz = wz_lo * wz_hi
                wz = wz * wz * (3.0 - 2.0 * wz)
                # Find left (th > 0) and right (th < 0) bust peak forward projection y_fwd = r * cos(th)
                peak_l_th, peak_l_yf = 0.45, 0.0
                peak_r_th, peak_r_yf = -0.45, 0.0
                for it in range(self.t_nt):
                    th = (it / self.t_nt) * math.tau
                    th_s = ((th + math.pi) % math.tau) - math.pi
                    if 0.12 <= th_s <= 0.88:
                        yf = self.torso_r[iz][it] * math.cos(th_s)
                        if yf > peak_l_yf:
                            peak_l_yf, peak_l_th = yf, th_s
                    elif -0.88 <= th_s <= -0.12:
                        yf = self.torso_r[iz][it] * math.cos(th_s)
                        if yf > peak_r_yf:
                            peak_r_yf, peak_r_th = yf, th_s
                # Bridge the front arc linearly in forward projection y_fwd across the sternum valley + 15 mm ease
                if peak_l_yf > 0.05 and peak_r_yf > 0.05:
                    for it in range(self.t_nt):
                        th = (it / self.t_nt) * math.tau
                        th_s = ((th + math.pi) % math.tau) - math.pi
                        if abs(th_s) < 0.92 and math.cos(th_s) > 0.25:
                            # Convex horizontal bridge between left & right peaks (plus gentle 6mm center arch)
                            if peak_r_th <= th_s <= peak_l_th:
                                frac = (th_s - peak_r_th) / max(1e-4, peak_l_th - peak_r_th)
                                bridge_yf = peak_r_yf * (1.0 - frac) + peak_l_yf * frac + 0.006 * math.sin(frac * math.pi)
                                bridge_r = bridge_yf / math.cos(th_s)
                            else:
                                bridge_r = self.torso_r[iz][it]
                            # Smooth 14 mm extra bust ease across front chest
                            front_w = max(0.0, 1.0 - (abs(th_s) / 0.92) ** 2)
                            target_r = max(self.torso_r[iz][it], bridge_r) + 0.014 * front_w * wz
                            self.torso_r[iz][it] = self.torso_r[iz][it] * (1.0 - wz) + target_r * wz

        # Precompute arm envelopes along X
        self.a_nx, self.a_nt = 24, 24
        self.arm_yc = [[self.sh_l.y] * self.a_nx, [self.sh_r.y] * self.a_nx]
        self.arm_zc = [[self.sh_l.z] * self.a_nx, [self.sh_r.z] * self.a_nx]
        self.arm_r = [[[0.045] * self.a_nt for _ in range(self.a_nx)] for _ in range(2)]
        for side in range(2):
            sgn = 1.0 if side == 0 else -1.0
            sh = self.sh_l if side == 0 else self.sh_r
            ha = self.ha_l if side == 0 else self.bone('hand_r')
            for ix in range(self.a_nx):
                f = ix / (self.a_nx - 1)
                ax = self.arm_x0 + f * (self.arm_x1 - self.arm_x0)
                xw = ax * sgn
                yc0 = sh.y * (1 - f) + ha.y * f
                zc0 = sh.z * (1 - f) + ha.z * f
                # Refine center via top/bottom and front/back hits
                p_top = self._ray_inward(Vector((xw, yc0, zc0 + 0.25)), Vector((0.0, 0.0, -1.0)))
                p_bot = self._ray_inward(Vector((xw, yc0, zc0 - 0.25)), Vector((0.0, 0.0, 1.0)))
                p_fr = self._ray_inward(Vector((xw, yc0 + self.front_y * 0.25, zc0)), Vector((0.0, -self.front_y, 0.0)))
                p_bk = self._ray_inward(Vector((xw, yc0 - self.front_y * 0.25, zc0)), Vector((0.0, self.front_y, 0.0)))
                zc = 0.5 * (p_top.z + p_bot.z) if (p_top and p_bot) else zc0
                yc = 0.5 * (p_fr.y + p_bk.y) if (p_fr and p_bk) else yc0
                self.arm_yc[side][ix] = yc
                self.arm_zc[side][ix] = zc
                for it in range(self.a_nt):
                    th = (it / self.a_nt) * math.tau
                    dy = math.cos(th) * self.front_y
                    dz = math.sin(th)
                    best = 0.0
                    for ox in (-0.01, 0.0, 0.01):
                        origin = Vector((xw + ox, yc + dy * 0.22, zc + dz * 0.22))
                        ok, loc, _n, _f = self.proxy.ray_cast(origin, Vector((0.0, -dy, -dz)), distance=0.22)
                        if ok:
                            r = math.hypot(loc.y - yc, loc.z - zc)
                            if r < 0.14 and r > best:
                                best = r
                    self.arm_r[side][ix][it] = max(0.032, best)
            # Smooth arm envelope with outer-convex max(raw, smooth) so shoulder & elbow sleeves have zero dents
            for _ in range(2):
                prev_a = [row[:] for row in self.arm_r[side]]
                for ix in range(self.a_nx):
                    for it in range(self.a_nt):
                        sm_t = (
                            0.25 * prev_a[ix][(it - 1) % self.a_nt]
                            + 0.50 * prev_a[ix][it]
                            + 0.25 * prev_a[ix][(it + 1) % self.a_nt]
                        )
                        sm_x = (
                            0.25 * prev_a[max(0, ix - 1)][it]
                            + 0.50 * sm_t
                            + 0.25 * prev_a[min(self.a_nx - 1, ix + 1)][it]
                        )
                        self.arm_r[side][ix][it] = max(prev_a[ix][it], sm_x)

        # Precompute leg envelopes (Z in [0.02, 0.86])
        self.l_nz, self.l_nt = 32, 24
        self.l_z0, self.l_z1 = 0.02, 0.86
        self.leg_xc = [[self.thigh_l.x] * self.l_nz, [-self.thigh_l.x] * self.l_nz]
        self.leg_yc = [[self.thigh_l.y] * self.l_nz, [self.thigh_l.y] * self.l_nz]
        self.leg_r = [[[0.055] * self.l_nt for _ in range(self.l_nz)] for _ in range(2)]
        for side in range(2):
            sgn = 1.0 if side == 0 else -1.0
            hip = self.thigh_l if side == 0 else self.bone('thigh_r')
            ankle = self.foot_l if side == 0 else self.foot_r
            for iz in range(self.l_nz):
                f = iz / (self.l_nz - 1)
                z = self.l_z0 + f * (self.l_z1 - self.l_z0)
                xc = ankle.x * (1 - f) + hip.x * f
                yc = ankle.y * (1 - f) + hip.y * f
                self.leg_xc[side][iz] = xc
                self.leg_yc[side][iz] = yc
                for it in range(self.l_nt):
                    th = (it / self.l_nt) * math.tau
                    dx = math.sin(th)
                    dy = math.cos(th) * self.front_y
                    best = 0.0
                    for oz in (-0.01, 0.0, 0.01):
                        origin = Vector((xc + dx * 0.20, yc + dy * 0.20, z + oz))
                        ok, loc, _n, _f = self.proxy.ray_cast(origin, Vector((-dx, -dy, 0.0)), distance=0.20)
                        if ok and loc.x * sgn > -0.01:
                            r = math.hypot(loc.x - xc, loc.y - yc)
                            if r < 0.16 and r > best:
                                best = r
                    self.leg_r[side][iz][it] = max(0.036, best)
            # Smooth leg envelope with outer-convex max(raw, smooth) so thighs & hips have zero raycast dents
            for _ in range(2):
                prev_l = [row[:] for row in self.leg_r[side]]
                for iz in range(self.l_nz):
                    for it in range(self.l_nt):
                        sm_t = (
                            0.25 * prev_l[iz][(it - 1) % self.l_nt]
                            + 0.50 * prev_l[iz][it]
                            + 0.25 * prev_l[iz][(it + 1) % self.l_nt]
                        )
                        sm_z = (
                            0.25 * prev_l[max(0, iz - 1)][it]
                            + 0.50 * sm_t
                            + 0.25 * prev_l[min(self.l_nz - 1, iz + 1)][it]
                        )
                        self.leg_r[side][iz][it] = max(prev_l[iz][it], sm_z)

        # Measure foot bounding boxes for 3D shoes
        self.feet = []
        verts_world = [v.co for v in self.proxy.data.vertices]
        for side in range(2):
            sgn = 1.0 if side == 0 else -1.0
            pts = [p for p in verts_world if p.z <= 0.125 and p.x * sgn > 0.01]
            if not pts:
                f = self.foot_l if side == 0 else self.foot_r
                pts = [f + Vector((-0.05, -0.10, -0.05)), f + Vector((0.05, 0.10, 0.05))]
            self.feet.append({
                'min_x': min(p.x for p in pts), 'max_x': max(p.x for p in pts),
                'min_y': min(p.y for p in pts), 'max_y': max(p.y for p in pts),
                'min_z': max(0.0, min(p.z for p in pts)), 'max_z': max(p.z for p in pts),
            })

    def bone(self, name):
        return self.bones.get(name, Vector((0, 0, 1)))

    def _ray_inward(self, origin, direction, dist=0.75):
        ok, loc, _n, _f = self.proxy.ray_cast(origin, direction, distance=dist)
        return loc if ok else None

    def sample_torso(self, z, theta):
        fz = max(0.0, min(self.t_nz - 1.0001, ((z - self.t_z0) / (self.t_z1 - self.t_z0)) * (self.t_nz - 1)))
        iz = int(fz)
        wz = fz - iz
        yc = self.torso_yc[iz] * (1 - wz) + self.torso_yc[iz + 1] * wz
        ft = ((theta % math.tau) / math.tau) * self.t_nt
        it = int(ft) % self.t_nt
        it2 = (it + 1) % self.t_nt
        wt = ft - int(ft)
        r0 = self.torso_r[iz][it] * (1 - wt) + self.torso_r[iz][it2] * wt
        r1 = self.torso_r[iz + 1][it] * (1 - wt) + self.torso_r[iz + 1][it2] * wt
        return max(0.058, r0 * (1 - wz) + r1 * wz), yc

    def sample_arm(self, side, ax, theta):
        fx = max(0.0, min(self.a_nx - 1.0001, ((ax - self.arm_x0) / max(1e-4, self.arm_x1 - self.arm_x0)) * (self.a_nx - 1)))
        ix = int(fx)
        wx = fx - ix
        yc = self.arm_yc[side][ix] * (1 - wx) + self.arm_yc[side][ix + 1] * wx
        zc = self.arm_zc[side][ix] * (1 - wx) + self.arm_zc[side][ix + 1] * wx
        ft = ((theta % math.tau) / math.tau) * self.a_nt
        it = int(ft) % self.a_nt
        it2 = (it + 1) % self.a_nt
        wt = ft - int(ft)
        r0 = self.arm_r[side][ix][it] * (1 - wt) + self.arm_r[side][ix][it2] * wt
        r1 = self.arm_r[side][ix + 1][it] * (1 - wt) + self.arm_r[side][ix + 1][it2] * wt
        return max(0.036, r0 * (1 - wx) + r1 * wx), yc, zc

    def sample_leg(self, side, z, theta):
        fz = max(0.0, min(self.l_nz - 1.0001, ((z - self.l_z0) / (self.l_z1 - self.l_z0)) * (self.l_nz - 1)))
        iz = int(fz)
        wz = fz - iz
        xc = self.leg_xc[side][iz] * (1 - wz) + self.leg_xc[side][iz + 1] * wz
        yc = self.leg_yc[side][iz] * (1 - wz) + self.leg_yc[side][iz + 1] * wz
        ft = ((theta % math.tau) / math.tau) * self.l_nt
        it = int(ft) % self.l_nt
        it2 = (it + 1) % self.l_nt
        wt = ft - int(ft)
        r0 = self.leg_r[side][iz][it] * (1 - wt) + self.leg_r[side][iz][it2] * wt
        r1 = self.leg_r[side][iz + 1][it] * (1 - wt) + self.leg_r[side][iz + 1][it2] * wt
        return max(0.038, r0 * (1 - wz) + r1 * wz), xc, yc


_ACTIVE_DONOR = None
_ACTIVE_SURF = None


def enforce_body_clearance(obj, donor, min_clr, peplum_flare=None, bust_bridge=False):
    """Smoothly guarantees every vertex of the cloth surface sits at least min_clr outside the body
    using SMOOTH RADIAL outward push (NEVER noisy local triangle normals from closest_point_on_mesh,
    which caused jagged scars & dimples on peplums, chests, and trouser hips!)."""
    if donor is None or (min_clr <= 0.0 and peplum_flare is None):
        return
    mesh = obj.data
    pushed = 0
    surf = _ACTIVE_SURF
    for v in mesh.vertices:
        req = min_clr
        if peplum_flare is not None:
            z_start, z_bot, extra_clr = peplum_flare
            if v.co.z < z_start:
                ft = max(0.0, min(1.0, (z_start - v.co.z) / max(0.06, z_start - z_bot)))
                req = max(req, min_clr + extra_clr * (ft ** 1.15))
        if req <= 0.0:
            continue
        ok, loc, nrm, _fi = donor.closest_point_on_mesh(v.co)
        if ok:
            delta = v.co - loc
            sd = delta.dot(nrm)
            # Only push vertices that actually approach skin (< min(0.011, req)) using PURE smooth radial direction
            # (ZERO noisy body-mesh normal component!) so already-clear cloth NEVER gets pinpoint bumps!
            safe_req = min(0.011, req) if peplum_flare is None else req
            if sd < safe_req and delta.length < 0.038:
                if surf is not None and abs(v.co.x) < surf.arm_x0 * 0.96 and v.co.z >= surf.t_z0:
                    _, yc = surf.sample_torso(min(surf.t_z1, max(surf.t_z0, v.co.z)), 0.0)
                    out_dir = Vector((v.co.x, v.co.y - yc, 0.0))
                elif delta.length > 1e-4 and sd > 0.0:
                    out_dir = delta.copy()
                else:
                    out_dir = nrm.copy()
                if out_dir.length > 1e-5:
                    out_dir.normalize()
                    need = safe_req - sd
                    if need > 0.0:
                        v.co = v.co + out_dir * min(need, 0.014)
                        pushed += 1
        # Female chest bridge guard: keep front bust vertices strictly outside the bridged torso envelope
        if bust_bridge and surf is not None and surf.female and abs(v.co.x) < surf.arm_x0 * 0.96:
            if (surf.pelvis.z + 0.08) <= v.co.z <= (surf.sh_l.z + 0.01):
                _, yc = surf.sample_torso(v.co.z, 0.0)
                dy_fwd = (v.co.y - yc) * surf.front_y
                if dy_fwd > 0.02:
                    th = math.atan2(v.co.x, dy_fwd)
                    if abs(th) < 0.92:
                        env_r, yc2 = surf.sample_torso(v.co.z, th)
                        cur_r = math.hypot(v.co.x, v.co.y - yc2)
                        need_r = env_r + max(0.012, min_clr * 0.85)
                        if cur_r < need_r:
                            v.co.x = math.sin(th) * need_r
                            v.co.y = yc2 + math.cos(th) * surf.front_y * need_r
                            pushed += 1
    if pushed:
        mesh.update()


def add_rolled_hem_lip(obj, lip_turn=0.0025, lip_return=0.0055, tuck_in=0.0030):
    """Replaces full-body SOLIDIFY with a clean 6 mm rolled hem/collar/cuff return lip ONLY along open boundary edges.
    Gives collars, cuffs, and hems crisp physical visual thickness with ZERO double-wall z-fighting on torso or sleeves!"""
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.normal_update()

    b_edges = [e for e in bm.edges if len(e.link_faces) == 1]
    if not b_edges:
        bm.free()
        return

    ch_layer = bm.faces.layers.int.get('cloth_ch')
    fab_layer = bm.faces.layers.int.get('cloth_fab')

    # Compute outward tangent direction & outward normal at each boundary vertex before modifying topology
    v_nrm = {}
    v_out = {}
    edge_attrs = {}
    for e in b_edges:
        f = e.link_faces[0]
        fn = f.normal.copy()
        fc = f.calc_center_median()
        em = 0.5 * (e.verts[0].co + e.verts[1].co)
        edir = (e.verts[1].co - e.verts[0].co).normalized()
        out_v = em - fc
        out_v -= edir * out_v.dot(edir)
        out_v -= fn * out_v.dot(fn)
        if out_v.length > 1e-6:
            out_v.normalize()
        else:
            out_v = fn.cross(edir).normalized()
        ch_val = f[ch_layer] if ch_layer is not None else 0
        fab_val = f[fab_layer] if fab_layer is not None else 0
        for v in e.verts:
            v_nrm[v] = v_nrm.get(v, Vector((0, 0, 0))) + fn
            v_out[v] = v_out.get(v, Vector((0, 0, 0))) + out_v
            edge_attrs[v] = (ch_val, fab_val)

    for v in list(v_nrm.keys()):
        if v_nrm[v].length > 1e-6:
            v_nrm[v].normalize()
        if v_out[v].length > 1e-6:
            v_out[v].normalize()

    # Step 1: tiny 2.5 mm rolled rim turn slightly inward
    ret1 = bmesh.ops.extrude_edge_only(bm, edges=b_edges)
    verts1 = [g for g in ret1['geom'] if isinstance(g, bmesh.types.BMVert)]
    edges1 = [g for g in ret1['geom'] if isinstance(g, bmesh.types.BMEdge)]
    faces1 = [g for g in ret1['geom'] if isinstance(g, bmesh.types.BMFace)]
    # Map each new vert to its original boundary vert via connecting edge
    v1_nrm, v1_out, v1_attr = {}, {}, {}
    for f in faces1:
        f.smooth = True
        orig_vs = [v for v in f.verts if v in v_nrm]
        if orig_vs:
            attr = edge_attrs[orig_vs[0]]
            if ch_layer is not None:
                f[ch_layer] = attr[0]
            if fab_layer is not None:
                f[fab_layer] = attr[1]
    for v in verts1:
        for e in v.link_edges:
            ov = e.other_vert(v)
            if ov in v_nrm:
                nrm = v_nrm[ov]
                out = v_out[ov]
                v.co = ov.co + out * (lip_turn * 0.55) - nrm * (tuck_in * 0.65)
                v1_nrm[v] = nrm
                v1_out[v] = out
                v1_attr[v] = edge_attrs[ov]
                break

    # Step 2: 5.5 mm clean hem return tucked gently 3 mm inward along the interior edge
    rim_edges = [e for e in edges1 if len(e.link_faces) == 1]
    if rim_edges:
        ret2 = bmesh.ops.extrude_edge_only(bm, edges=rim_edges)
        verts2 = [g for g in ret2['geom'] if isinstance(g, bmesh.types.BMVert)]
        faces2 = [g for g in ret2['geom'] if isinstance(g, bmesh.types.BMFace)]
        for f in faces2:
            f.smooth = True
            src_vs = [v for v in f.verts if v in v1_attr]
            if src_vs:
                attr = v1_attr[src_vs[0]]
                if ch_layer is not None:
                    f[ch_layer] = attr[0]
                if fab_layer is not None:
                    f[fab_layer] = attr[1]
        for v in verts2:
            for e in v.link_edges:
                ov = e.other_vert(v)
                if ov in v1_nrm:
                    v.co = ov.co - v1_out[ov] * lip_return - v1_nrm[ov] * (tuck_in * 0.35)
                    break

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def make_cloth_object(name, verts, faces, pin_weights, chan_fab_uv, flex_phase, cloth_cfg=None, solidify=0.0028, subsurf=1, sim_frames=12, min_clr=0.012, peplum_flare=None, bust_bridge=False):
    """Creates a Blender mesh, runs tailored physical CLOTH draping + SUBSURF + SMOOTH + rolled edge hems (NO full-body SOLIDIFY z-fighting!)."""
    mesh = bpy.data.meshes.new(name + '_mesh')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    # Store channel & fabric as discrete INT attributes on FACE domain so SUBSURF NEVER
    # linearly interpolates CH_SHIRT(0) and CH_LINEN(2) into CH_TROUSERS(1)!
    a_ch = mesh.attributes.new(name='cloth_ch', type='INT', domain='FACE')
    a_fab = mesh.attributes.new(name='cloth_fab', type='INT', domain='FACE')
    a_ch.data.foreach_set('value', [int(chan_fab_uv[fc[0]][0]) for fc in faces])
    a_fab.data.foreach_set('value', [int(chan_fab_uv[fc[0]][1]) for fc in faces])
    a_wu = mesh.attributes.new(name='cloth_wu', type='FLOAT', domain='POINT')
    a_wv = mesh.attributes.new(name='cloth_wv', type='FLOAT', domain='POINT')
    a_fl = mesh.attributes.new(name='cloth_flex', type='FLOAT', domain='POINT')
    a_ph = mesh.attributes.new(name='cloth_phase', type='FLOAT', domain='POINT')
    a_wu.data.foreach_set('value', [float(c[2]) for c in chan_fab_uv])
    a_wv.data.foreach_set('value', [float(c[3]) for c in chan_fab_uv])
    a_fl.data.foreach_set('value', [float(f[0]) for f in flex_phase])
    a_ph.data.foreach_set('value', [float(f[1]) for f in flex_phase])

    # Pin vertex group for Blender's Cloth physics solver
    vg_pin = obj.vertex_groups.new(name='CLOTH_PIN')
    for vi, pw in enumerate(pin_weights):
        if pw > 0.001:
            vg_pin.add([vi], min(1.0, float(pw)), 'REPLACE')

    # Smooth normals
    for poly in mesh.polygons:
        poly.use_smooth = True

    if cloth_cfg is not None and sim_frames > 0:
        # Optional shrinkwrap pinning ONLY when explicitly requested (disabled on upper torso/sleeves so smooth tailored
        # patterns NEVER get pulled into bumpy shoulder creases or sternum valleys!)
        if _ACTIVE_DONOR is not None and cloth_cfg.get('pin_shrinkwrap', False) and any(pw > 0.5 for pw in pin_weights):
            sw = obj.modifiers.new('PinToBodyCurve', 'SHRINKWRAP')
            sw.target = _ACTIVE_DONOR
            sw.wrap_method = 'NEAREST_SURFACEPOINT'
            sw.wrap_mode = 'OUTSIDE_SURFACE'
            sw.offset = cloth_cfg.get('pin_offset', max(0.012, min_clr))
            sw.vertex_group = 'CLOTH_PIN'
            bpy.ops.object.modifier_apply(modifier=sw.name)

        if cloth_cfg.get('pre_subsurf', 0) > 0:
            ss0 = obj.modifiers.new('PreSubsurf', 'SUBSURF')
            ss0.levels = cloth_cfg['pre_subsurf']
            ss0.render_levels = cloth_cfg['pre_subsurf']
            bpy.ops.object.modifier_apply(modifier=ss0.name)

        cmod = obj.modifiers.new('Cloth', 'CLOTH')
        cs = cmod.settings
        cs.quality = cloth_cfg.get('quality', 7)
        cs.mass = cloth_cfg.get('mass', 0.28)
        cs.air_damping = cloth_cfg.get('air_damping', 3.2)
        cs.tension_stiffness = cloth_cfg.get('tension', 34.0)
        cs.compression_stiffness = cloth_cfg.get('compression', 28.0)
        cs.shear_stiffness = cloth_cfg.get('shear', 22.0)
        cs.bending_stiffness = cloth_cfg.get('bending', 1.6)
        cs.tension_damping = 10.0
        cs.compression_damping = 10.0
        cs.bending_damping = 1.8
        cs.vertex_group_mass = 'CLOTH_PIN'
        cs.pin_stiffness = cloth_cfg.get('pin_stiffness', 1.0)
        cs.shrink_min = cloth_cfg.get('shrink', 0.0)
        cc = cmod.collision_settings
        cc.use_collision = True
        cc.collision_quality = 4
        cc.distance_min = cloth_cfg.get('col_dist', 0.010)
        cc.friction = 10.0
        cc.use_self_collision = False

        # Step Blender's physical cloth drape gently so fabric hangs cleanly without chaotic clay bunching!
        scene = bpy.context.scene
        scene.frame_start = 1
        scene.frame_end = sim_frames + 2
        scene.frame_set(1)
        for frame in range(1, sim_frames + 1):
            scene.frame_set(frame)

        depsgraph = bpy.context.evaluated_depsgraph_get()
        eval_obj = obj.evaluated_get(depsgraph)
        baked_mesh = bpy.data.meshes.new_from_object(eval_obj)
        obj.modifiers.remove(cmod)
        obj.data = baked_mesh

    if subsurf > 0:
        ss = obj.modifiers.new('Subsurf', 'SUBSURF')
        ss.levels = subsurf
        ss.render_levels = subsurf
        bpy.ops.object.modifier_apply(modifier=ss.name)

    # Iterative smooth clearance relaxation (5 passes of clamp -> smooth, FINISHING on smooth!):
    # Ending with smooth guarantees ZERO localized push-out scars/dimples while keeping safe body clearance!
    if min_clr > 0.0 and subsurf > 0:
        for it_pass in range(5):
            enforce_body_clearance(obj, _ACTIVE_DONOR, min_clr + 0.002 * (1.0 - it_pass / 5.0), peplum_flare=peplum_flare, bust_bridge=bust_bridge)
            sm_i = obj.modifiers.new(f'RelaxSmooth_{it_pass}', 'SMOOTH')
            sm_i.factor = 0.45 - it_pass * 0.05
            sm_i.iterations = 2
            bpy.ops.object.modifier_apply(modifier=sm_i.name)
        csm = obj.modifiers.new('CorrectiveSmooth', 'CORRECTIVE_SMOOTH')
        csm.factor = 0.45
        csm.iterations = 3
        csm.smooth_type = 'LENGTH_WEIGHTED'
        bpy.ops.object.modifier_apply(modifier=csm.name)
    else:
        sm = obj.modifiers.new('Smooth', 'SMOOTH')
        sm.factor = 0.40
        sm.iterations = 3
        bpy.ops.object.modifier_apply(modifier=sm.name)
        enforce_body_clearance(obj, _ACTIVE_DONOR, min_clr, peplum_flare=peplum_flare, bust_bridge=bust_bridge)

    # Rolled 6 mm return lip ONLY on open collar/cuff/hem boundaries (NEVER full-body SOLIDIFY -> ZERO z-fighting!)
    if solidify > 0.0:
        add_rolled_hem_lip(obj, lip_turn=min(0.0028, solidify), lip_return=0.0055, tuck_in=min(0.0032, solidify * 1.1))

    if 'CLOTH_PIN' in obj.vertex_groups:
        obj.vertex_groups.remove(obj.vertex_groups['CLOTH_PIN'])

    return obj


def build_tube(rings, closed_u=True):
    verts = []
    faces = []
    pin = []
    cfu = []
    fp = []
    ring_ids = []
    for row in rings:
        r_idx = []
        for (co, pw, ch, fab, wu, wv, fl, ph) in row:
            idx = len(verts)
            verts.append(co)
            pin.append(pw)
            cfu.append((ch, fab, wu, wv))
            fp.append((fl, ph))
            r_idx.append(idx)
        ring_ids.append(r_idx)
    n_r = len(ring_ids)
    n_s = len(ring_ids[0])
    limit = n_s if closed_u else n_s - 1
    for r in range(n_r - 1):
        a, b = ring_ids[r], ring_ids[r + 1]
        for s in range(limit):
            s2 = (s + 1) % n_s
            faces.append((a[s], a[s2], b[s2], b[s]))
    return verts, faces, pin, cfu, fp


def _sstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))) if abs(b - a) > 1e-6 else (1.0 if x >= b else 0.0)
    return t * t * (3.0 - 2.0 * t)


# --------------------------------------------------------------------------- Tailored 1550 garment pattern builders
def build_torso_piece(surf, name, *, z_bot, z_top=None, n_z=28, n_t=48, clearance=0.020,
                      flare_bot=0.0, v_neck=0.0, scoop=0.0, stand_collar=0.0,
                      collar_ch=None, channel=CH_SHIRT, fabric=FAB_LINEN,
                      hem_trim=False, bodice_lace=False, pleats=0, pleat_amp=0.0,
                      shoulder_yoke=True, tucked=False, cloth_cfg=None, solidify=0.0028,
                      subsurf=1, sim_frames=26, hem_flex=0.20):
    sh_z = surf.sh_l.z
    neck_z = surf.neck.z
    neck_y = surf.neck.y
    neck_r = 0.056 if surf.female else 0.064
    yoke_z0 = sh_z - 0.012
    yoke_z1 = (neck_z + 0.016) if shoulder_yoke else (z_top or surf.pelvis.z + 0.06)
    body_top = yoke_z0 if shoulder_yoke else (z_top or surf.pelvis.z + 0.06)
    yoke_split = 0.78 if shoulder_yoke else 1.05
    rings = []

    for iz in range(n_z):
        vf = iz / (n_z - 1)
        in_yoke = shoulder_yoke and vf > yoke_split
        yt = (vf - yoke_split) / (1.0 - yoke_split) if in_yoke else 0.0
        bf = min(1.0, vf / yoke_split) if shoulder_yoke else vf
        z_base = yoke_z0 + math.sin(yt * math.pi * 0.5) * (yoke_z1 - yoke_z0) if in_yoke else z_bot + bf * (body_top - z_bot)

        row = []
        for it in range(n_t):
            uf = it / n_t
            th = uf * math.tau
            cos_f = math.cos(th)
            z = z_base
            if in_yoke:
                if v_neck > 0:
                    # Smooth tailored 1550 linen collar band around back/sides + clean open front V-placket (zero jagged notch!)
                    if cos_f > 0.35:
                        vs = _sstep(0.35, 1.0, cos_f)
                        z -= v_neck * (vs ** 1.25) * (yt ** 0.90)
                    elif yt > 0.58:
                        # Neat soft turned-down 1550 collar band framing back and sides of neck cleanly
                        band_w = 1.0 - _sstep(-0.05, 0.35, cos_f)
                        z += 0.018 * ((yt - 0.58) / 0.42) * band_w
                elif scoop > 0:
                    # Wide, smooth, graceful Renaissance gathered oval scoop neckline across collarbone (zero jagged notch!)
                    if cos_f > -0.15:
                        ss = _sstep(-0.15, 0.92, cos_f)
                        z -= scoop * (ss ** 1.15) * (yt ** 0.92)
                if stand_collar > 0 and yt > 0.60:
                    z += stand_collar * ((yt - 0.60) / 0.40)

            env_r, yc = surf.sample_torso(min(surf.t_z1, max(surf.t_z0, z)), th)
            if tucked:
                # Tucked upper garment: smoothly taper waist inward right behind the belt & waistband so ZERO
                # shirt/blouse hem ever pokes through trousers or skirts below the belt!
                tuck_t = _sstep(z_bot + 0.055, z_bot, z)
                tuck_drop = -0.006 * tuck_t
                bot_flare = 0.0
                # Graceful subtle vertical tailored linen drape folds (soft cosine pleats fading cleanly at waist & yoke)
                fold_env = math.sin(bf * math.pi) * (1.0 - tuck_t)
                pleat_w = (0.5 + 0.5 * math.cos(th * pleats + math.sin(bf * math.pi) * 0.35)) * pleat_amp * fold_env if pleats > 0 else 0.0
            else:
                # Untucked outer doublet/jerkin/tunic: flare lower peplum smoothly below the belt line (z <= 1.025)
                # so the skirt clears the trouser/breechcloth hips while the slim belt wraps flush at z ~ 1.03!
                tuck_drop = 0.0
                flare_t = max(0.0, (1.025 - z) / max(0.08, 1.025 - z_bot))
                bot_flare = flare_bot * (flare_t ** 1.35)
                pleat_w = (0.5 + 0.5 * math.cos(th * pleats)) * pleat_amp * (1.0 - bf * 0.45) if pleats > 0 else 0.0
            # Subtle shoulder-armscye outward ease (+4mm at side armscye) so torso sits cleanly OVER sleeve roots with zero z-clash!
            armscye_w = _sstep(sh_z - 0.14, sh_z - 0.02, z) * (1.0 - _sstep(sh_z + 0.02, neck_z, z)) * (abs(math.sin(th)) ** 2)
            r = env_r + max(0.011, clearance + tuck_drop) + bot_flare + pleat_w + 0.004 * armscye_w

            if in_yoke:
                collar_r = neck_r + (0.010 if stand_collar > 0 else 0.013)
                cw = yt ** 1.12
                sh_r, sh_yc = surf.sample_torso(min(surf.t_z1, yoke_z0), th)
                yoke_r = (sh_r + clearance + 0.004 * (abs(math.sin(th)) ** 2)) * (1.0 - cw) + collar_r * cw
                r = max(env_r + 0.014, yoke_r)
                yc = sh_yc * (1.0 - cw) + neck_y * cw

            x = math.sin(th) * r
            y = yc + math.cos(th) * surf.front_y * r

            ch, fab = channel, fabric
            if collar_ch is not None and in_yoke and yt > 0.68:
                ch, fab = collar_ch, FAB_LINEN
            elif hem_trim and not in_yoke and bf < 0.09:
                ch, fab = CH_TRIM, FAB_COTTON
            elif bodice_lace and cos_f > 0.975 and 0.08 < bf < 0.88 and not in_yoke:
                ch, fab = CH_LINEN, FAB_LINEN

            # Pin collar/yoke smoothly + firm pin at tucked waist hem so torso drapes cleanly without riding up or bunching!
            pw = 0.0
            if in_yoke:
                pw = 0.72 + 0.28 * yt
            elif tucked and bf < 0.18:
                pw = 1.0
            elif tucked and bf < 0.34:
                pw = 0.75 * (1.0 - (bf - 0.18) / 0.16)
            elif not shoulder_yoke and bf > 0.80:
                pw = 1.0

            fl = hem_flex * (max(0.0, 1.0 - bf * 1.7) ** 1.5) if not tucked else 0.04 * math.sin(bf * math.pi)
            row.append(((x, y, z), pw, ch, fab, uf * 4.0, vf * 3.0, fl, uf))
        rings.append(row)

    v, f, p, cfu, fp = build_tube(rings, True)
    cfg = dict(cloth_cfg) if cloth_cfg is not None else None
    if cfg is not None:
        cfg['pin_shrinkwrap'] = False
    min_c = 0.012 if tucked else max(0.018, clearance * 0.75)
    pf = None if (tucked or flare_bot <= 0.0) else (1.025, z_bot, flare_bot * 0.95)
    return make_cloth_object(name, v, f, p, cfu, fp, cloth_cfg=cfg, solidify=solidify, subsurf=subsurf, sim_frames=sim_frames, min_clr=min_c, peplum_flare=pf, bust_bridge=surf.female)


def build_sleeves_piece(surf, name, *, x_end_frac=0.58, n_x=22, n_t=28, clearance=0.018,
                        puff_amp=0.016, cuff_trim=False, rolled_cuff=True,
                        channel=CH_SHIRT, fabric=FAB_LINEN, sleeve_flex=0.22,
                        cloth_cfg=None, solidify=0.0024, subsurf=1, sim_frames=24, x0_frac=0.95):
    objs = []
    # Start cleanly at the outer shoulder seam so sleeves blend smoothly into the torso armscye without lumps!
    x0 = surf.arm_x0 * x0_frac
    x1 = surf.arm_x0 + (surf.arm_x1 - surf.arm_x0) * x_end_frac
    cfg = dict(cloth_cfg) if cloth_cfg is not None else None
    if cfg is not None:
        cfg['pin_shrinkwrap'] = False
    min_c = 0.008
    for side in range(2):
        sgn = 1.0 if side == 0 else -1.0
        rings = []
        for ix in range(n_x):
            uf = ix / (n_x - 1)
            ax = x0 + uf * (x1 - x0)
            row = []
            for it in range(n_t):
                vf = it / n_t
                th = vf * math.tau
                env_r, yc, zc = surf.sample_arm(side, max(surf.arm_x0, ax), th)
                # Tuck inner sleeve root smoothly inside torso armscye with zero bulbous shoulder-cap lump!
                armscye_tuck = -0.012 * (1.0 - _sstep(0.0, 0.28, uf))
                cap = 0.0
                # Graceful subtle gravity hang on underside of sleeve + gentle tailored puff
                hang_drop = -0.005 * math.sin(uf * math.pi) * max(0.0, -math.sin(th))
                puff = puff_amp * (math.sin(uf * math.pi) ** 1.25) * (0.95 + 0.05 * math.cos(th * 6))
                # Clean tailored cuff band without pinched double-wall sausage bulge
                cuff = 0.0025 * _sstep(0.86, 0.94, uf) if rolled_cuff else 0.0
                r = env_r + clearance + armscye_tuck + cap + puff + cuff
                x = ax * sgn
                y = yc + math.cos(th) * surf.front_y * r
                z = zc + math.sin(th) * r + hang_drop

                ch, fab = channel, fabric
                if cuff_trim and uf >= 0.87:
                    ch, fab = CH_LINEN, FAB_LINEN

                # Pin shoulder seam & cuff band smoothly at matching clearance so mid-sleeve drapes naturally!
                pw = 0.0
                if uf < 0.16:
                    pw = 1.0 - uf / 0.16 * 0.35
                elif uf > 0.88:
                    pw = 0.85
                elif math.sin(th) > 0.45:
                    # Gentle top-of-arm support so sleeve hangs cleanly below arm
                    pw = 0.35 * (math.sin(th) - 0.45) / 0.55

                fl = sleeve_flex * math.sin(uf * math.pi) * (1.0 if math.sin(th) < 0 else 0.35)
                row.append(((x, y, z), pw, ch, fab, uf * 2.5, vf * 2.0, fl, vf + side * 0.5))
            rings.append(row)
        v, f, p, cfu, fp = build_tube(rings, True)
        # Ensure outward normals on both left (sgn=+1) and right (sgn=-1) sleeves!
        if sgn * (-surf.front_y) > 0:
            f = [tuple(reversed(fc)) for fc in f]
        objs.append(make_cloth_object(f'{name}_s{side}', v, f, p, cfu, fp, cloth_cfg=cfg, solidify=solidify, subsurf=subsurf, sim_frames=sim_frames, min_clr=min_c))
    return objs


def build_pleated_skirt(surf, name, *, z_waist, z_hem=0.10, n_z=30, n_t=64,
                        waist_clr=0.024, hem_rx=0.40, hem_rz=0.37,
                        pleats=16, pleat_amp=0.020, channel=CH_TROUSERS, fabric=FAB_WOOL,
                        hem_trim=False, apron=False, max_flex=0.85, sim_frames=32):
    rings = []
    for iz in range(n_z):
        vf = iz / (n_z - 1)  # 0 = hem, 1 = waist
        z = z_hem + vf * (z_waist - z_hem)
        down = 1.0 - vf
        row = []
        for it in range(n_t):
            uf = it / n_t
            th = uf * math.tau
            env_r, yc = surf.sample_torso(max(surf.t_z0, z), th)
            bell = down ** 1.10
            base_r = env_r + waist_clr
            target_r = math.hypot(math.sin(th) * hem_rx, math.cos(th) * hem_rz)
            pleat_w = math.cos(th * pleats) * pleat_amp * (down ** 0.95)
            side = 0 if math.sin(th) >= 0 else 1
            leg_mask = max(0.0, min(1.0, (0.95 - z) / 0.16))
            if leg_mask > 0.0:
                lr, lxc, lyc = surf.sample_leg(side, min(surf.l_z1, max(surf.l_z0, z)), th)
                leg_out = math.hypot(lxc + math.sin(th) * (lr + 0.078), (lyc - yc) + math.cos(th) * surf.front_y * (lr + 0.078)) * leg_mask
            else:
                leg_out = 0.0
            # Single-manifold sculpted front apron panel: crisp 3mm raised linen front apron with ZERO double-sheet z-fighting!
            th_front = ((th + math.pi) % math.tau) - math.pi
            in_apron = apron and (abs(th_front) < math.pi * 0.28) and (vf >= 0.18)
            apron_lift = 0.003 if in_apron else 0.0
            # Smooth hip ease so skirt bell flows cleanly over upper hips & thighs with ZERO hip dent or skin poke!
            hip_ease = 0.022 * math.sin(min(1.0, down / 0.35) * math.pi) if down < 0.35 else 0.0
            r = max(base_r * (1 - bell) + target_r * bell + hip_ease, leg_out) + pleat_w + apron_lift
            x = math.sin(th) * r
            y = yc + math.cos(th) * surf.front_y * r
            if in_apron:
                ch, fab = CH_LINEN, FAB_LINEN
            elif hem_trim and vf < 0.08:
                ch, fab = CH_TRIM, FAB_COTTON
            else:
                ch, fab = channel, fabric
            pw = 1.0
            fl = max_flex * (down ** 1.5)
            row.append(((x, y, z), pw, ch, fab, uf * 5.0, vf * 4.0, fl, uf))
        rings.append(row)

    v, f, p, cfu, fp = build_tube(rings, True)
    return [make_cloth_object(name, v, f, p, cfu, fp, cloth_cfg=None, solidify=0.0028, subsurf=1, sim_frames=0, min_clr=max(0.022, waist_clr))]


def build_leg_trousers(surf, name, *, z_waist, z_knee, z_ankle=None,
                       clr_hip=0.024, clr_thigh=0.034, clr_knee=0.020,
                       slop_puff=0.026, pleat_freq=10, hose_ch=None,
                       channel=CH_TROUSERS, fabric=FAB_WOOL, sim_frames=24):
    """Builds ONE continuous watertight bifurcated trouser mesh (waist -> hips -> crotch bridge -> left & right legs)
    so NO hip/thigh seam gap can ever open during walking, crouching, or horseback riding!"""
    z_crotch = 0.77 if surf.female else 0.79
    n_t = 44
    half = n_t // 2  # 22: 0=front, 11=left, 22=back, 33=right
    n_hip = 14
    n_bridge = 4
    n_leg = 18

    verts, faces, pin, cfu, fp = [], [], [], [], []
    hip_ids = []

    # 1. Continuous waist-to-crotch upper shell (iz=0 at z_crotch, iz=n_hip-1 at z_waist)
    for iz in range(n_hip):
        f = iz / (n_hip - 1)  # 0=crotch, 1=waist
        z = z_crotch + f * (z_waist - z_crotch)
        row_ids = []
        for it in range(n_t):
            uf = it / n_t
            th = uf * math.tau
            env_r, yc = surf.sample_torso(min(surf.t_z1, max(surf.t_z0, z)), th)
            pleat = (0.5 + 0.5 * math.cos(th * pleat_freq)) * (slop_puff * 0.22) * (1.0 - f * 0.75)
            puff_h = slop_puff * 0.35 * (1.0 - f)
            waist_wrap = 0.002 * max(0.0, (f - 0.60) / 0.40)
            r = env_r + clr_hip + waist_wrap + puff_h + pleat
            x = math.sin(th) * r
            y = yc + math.cos(th) * surf.front_y * r
            # Pin top waistband firmly onto body waist curve!
            pw = 1.0 if f > 0.80 else (0.55 * (f - 0.62) / 0.18 if f > 0.62 else 0.0)
            fl = 0.08 * (1.0 - f)
            idx = len(verts)
            verts.append((x, y, z))
            pin.append(pw)
            cfu.append((channel, fabric, uf * 4.0, 2.0 + f * 1.5))
            fp.append((fl, uf))
            row_ids.append(idx)
        hip_ids.append(row_ids)

    for iz in range(n_hip - 1):
        a, b = hip_ids[iz], hip_ids[iz + 1]
        for s in range(n_t):
            s2 = (s + 1) % n_t
            faces.append((a[s], a[s2], b[s2], b[s]))

    # 2. Smooth 4-vertex front-to-back crotch saddle bridge connecting back(22) -> front(0)
    p_front = Vector(verts[hip_ids[0][0]])
    p_back = Vector(verts[hip_ids[0][half]])
    bridge_ids = []
    for ib in range(n_bridge):
        t = (ib + 1) / (n_bridge + 1)  # 0=back, 1=front
        pt = p_back.lerp(p_front, t)
        pt.x = 0.0
        pt.z = z_crotch - 0.022 * math.sin(t * math.pi)
        idx = len(verts)
        verts.append((pt.x, pt.y, pt.z))
        pin.append(0.35)
        cfu.append((channel, fabric, 0.5, 2.0))
        fp.append((0.04, t))
        bridge_ids.append(idx)

    # 3. Extrude BOTH left (side=0, +X) & right (side=1, -X) legs seamlessly from the shared crotch ring!
    top_rings = [
        [hip_ids[0][i] for i in range(0, half + 1)] + bridge_ids,                           # Left leg (CCW)
        [hip_ids[0][i % n_t] for i in range(half, n_t + 1)] + list(reversed(bridge_ids)),   # Right leg (CCW)
    ]
    ring_len = len(top_rings[0])  # 27 vertices per leg ring

    for side in range(2):
        prev_ring = top_rings[side]
        # Compute stable polar angle around leg center for every vertex in the top ring
        _, lxc0, lyc0 = surf.sample_leg(side, z_crotch, 0.0)
        top_pts = [Vector(verts[vi]) for vi in prev_ring]
        top_th = [math.atan2(pt.x - lxc0, (pt.y - lyc0) * surf.front_y) for pt in top_pts]

        for il in range(1, n_leg):
            d = il / (n_leg - 1)  # 0=crotch, 1=knee
            z = z_crotch - d * (z_crotch - z_knee)
            # Smoothly blend from top crotch shape into anatomical thigh/knee contour
            blend_in = min(1.0, d / 0.22)
            blend_in = blend_in * blend_in * (3.0 - 2.0 * blend_in)
            puff = slop_puff * math.sin(d * math.pi)
            cur_ring = []
            for s in range(ring_len):
                th = top_th[s]
                lr, xc, yc = surf.sample_leg(side, max(surf.l_z0, min(surf.l_z1, z)), th)
                pleat = (0.5 + 0.5 * math.cos(th * pleat_freq)) * (slop_puff * 0.24) * math.sin(d * math.pi)
                clr = clr_thigh * (1.0 - d) + clr_knee * d
                r = lr + clr + puff + pleat
                tx = xc + math.sin(th) * r
                ty = yc + math.cos(th) * surf.front_y * r
                x = top_pts[s].x * (1.0 - blend_in) + tx * blend_in
                y = top_pts[s].y * (1.0 - blend_in) + ty * blend_in
                pw = 1.0 if d > 0.88 else 0.0
                fl = 0.14 * math.sin(d * math.pi)
                idx = len(verts)
                verts.append((x, y, z))
                pin.append(pw)
                cfu.append((channel, fabric, (s / ring_len) * 2.5, 2.0 - d * 2.0))
                fp.append((fl, (s / ring_len) + side * 0.5))
                cur_ring.append(idx)
            # Outward normals when extruding downward: (cur[s], cur[s2], prev[s2], prev[s])
            for s in range(ring_len):
                s2 = (s + 1) % ring_len
                faces.append((cur_ring[s], cur_ring[s2], prev_ring[s2], prev_ring[s]))
            prev_ring = cur_ring

    trou_cfg = {
        'mass': 0.36, 'tension': 20.0, 'compression': 12.0, 'shear': 10.0, 'bending': 0.55,
        'air_damping': 2.0, 'pin_offset': max(0.022, clr_hip * 0.92),
    }
    objs = [make_cloth_object(name + '_body', verts, faces, pin, cfu, fp, cloth_cfg=trou_cfg, solidify=0.0028, subsurf=1, sim_frames=sim_frames, min_clr=0.014)]

    # Fitted wool stockings / hose below knee (generous 14mm clearance so shins/calves never poke through during knee bend!)
    if hose_ch is not None and z_ankle is not None:
        for side in range(2):
            h_rings = []
            for iz in range(12):
                f = iz / 11.0
                z = z_ankle + f * ((z_knee + 0.03) - z_ankle)
                row = []
                for it in range(22):
                    uf = it / 22.0
                    th = uf * math.tau
                    lr, xc, yc = surf.sample_leg(side, z, th)
                    r = lr + 0.014
                    row.append(((xc + math.sin(th) * r, yc + math.cos(th) * surf.front_y * r, z), 1.0, hose_ch, FAB_WOOL, uf * 2, f * 2, 0.0, uf))
                h_rings.append(row)
            hv, hf, hp, hcfu, hfp = build_tube(h_rings, True)
            objs.append(make_cloth_object(f'{name}_hose{side}', hv, hf, hp, hcfu, hfp, cloth_cfg=None, solidify=0.0022, subsurf=1, sim_frames=0, min_clr=0.010))
    return objs


def build_belt_and_buckle(surf, name, *, z_center, half_h=0.015, clr=0.022, thickness=0.005, belt_ch=CH_LEATHER, buckle_ch=CH_BRASS):
    """Crisp, flat, slim 1550 leather strap seated snugly flush against the garment waist (NEVER a bloated floating sausage ring!)
    with a neat forged rectangular brass buckle."""
    n_t = 48
    # Closed 6-point chamfered rectangular cross-section (inner face -> chamfered bottom -> flat outer face -> chamfered top)
    cham = 0.0012
    profile = [
        (0.0,              -half_h + cham, 0.00),
        (thickness - cham, -half_h,        0.18),
        (thickness,        -half_h + cham, 0.30),
        (thickness,         half_h - cham, 0.70),
        (thickness - cham,  half_h,        0.82),
        (0.0,               half_h - cham, 1.00),
    ]
    n_p = len(profile)
    verts, faces, pin, cfu, fp = [], [], [], [], []
    ring_ids = []
    for it in range(n_t):
        uf = it / n_t
        th = uf * math.tau
        env_r, yc = surf.sample_torso(z_center, th)
        r_inner = env_r + clr
        col_ids = []
        for (dr, dz, vf) in profile:
            r = r_inner + dr
            x = math.sin(th) * r
            y = yc + math.cos(th) * surf.front_y * r
            idx = len(verts)
            verts.append((x, y, z_center + dz))
            pin.append(1.0)
            cfu.append((belt_ch, FAB_LEATHER, uf * 6.0, vf))
            fp.append((0.0, uf))
            col_ids.append(idx)
        ring_ids.append(col_ids)
    for it in range(n_t):
        a = ring_ids[it]
        b = ring_ids[(it + 1) % n_t]
        for ip in range(n_p):
            ip2 = (ip + 1) % n_p
            faces.append((a[ip], b[ip], b[ip2], a[ip2]))
    objs = [make_cloth_object(name + '_belt', verts, faces, pin, cfu, fp, cloth_cfg=None, solidify=0.0, subsurf=0, sim_frames=0, min_clr=0.0)]

    if buckle_ch is not None:
        # Neat forged rectangular brass buckle seated flush on the front face of the slim belt!
        env_r, yc = surf.sample_torso(z_center, 0.0)
        fy = yc + surf.front_y * (env_r + clr + thickness + 0.0015)
        bm = bmesh.new()
        bw, bh, bd = 0.020, half_h * 1.18, 0.0030
        bars = [
            ((0.0, 0.0, bh - 0.0030), (bw, bd, 0.0032)),
            ((0.0, 0.0, -(bh - 0.0030)), (bw, bd, 0.0032)),
            ((-bw + 0.0030, 0.0, 0.0), (0.0032, bd, bh)),
            ((bw - 0.0030, 0.0, 0.0), (0.0032, bd, bh)),
            ((0.0, surf.front_y * 0.0014, 0.0), (0.0022, bd * 0.75, bh * 0.84)),
        ]
        for (ox, oy, oz), (sx, sy, sz) in bars:
            ret = bmesh.ops.create_cube(bm, size=2.0)
            bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=ret['verts'])
            bmesh.ops.translate(bm, vec=(ox, fy + oy, z_center + oz), verts=ret['verts'])
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bv = [tuple(vt.co) for vt in bm.verts]
        bf = [tuple(vt.index for vt in fc.verts) for fc in bm.faces]
        bm.free()
        objs.append(make_cloth_object(
            name + '_buckle', bv, bf, [1.0] * len(bv),
            [(buckle_ch, FAB_BRASS, 0.5, 0.5)] * len(bv),
            [(0.0, 0.5)] * len(bv), cloth_cfg=None, solidify=0.0, subsurf=0, sim_frames=0, min_clr=0.0,
        ))
    return objs


def build_buttons(surf, name, *, z_bot, z_top, count=7, clr=0.024):
    """Sculpted 3D domed brass doublet/jerkin buttons down the center front placket."""
    bm = bmesh.new()
    for i in range(count):
        f = i / max(1, count - 1)
        z = z_bot + f * (z_top - z_bot)
        env_r, yc = surf.sample_torso(z, 0.0)
        y = yc + surf.front_y * (env_r + clr + 0.006)
        ret = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=0.0075)
        bmesh.ops.scale(bm, vec=(1.0, 0.55, 1.0), verts=ret['verts'])
        bmesh.ops.translate(bm, vec=(0.0, y, z), verts=ret['verts'])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bv = [tuple(vt.co) for vt in bm.verts]
    bf = [tuple(vt.index for vt in fc.verts) for fc in bm.faces]
    bm.free()
    return make_cloth_object(
        name + '_buttons', bv, bf, [1.0] * len(bv),
        [(CH_BRASS, FAB_BRASS, 0.5, 0.5)] * len(bv),
        [(0.0, 0.5)] * len(bv), cloth_cfg=None, solidify=0.0, subsurf=0, sim_frames=0, min_clr=0.0,
    )


def build_shoes(surf, name, *, channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.105, cuff_clr=0.008):
    """Builds a REAL closed physical 3D Renaissance leather shoe / low ankle boot conforming tightly to surf.feet[side]:
    flat closed bottom sole with subtle heel step, rounded enclosed toe box, closed sloped vamp/instep, and snug ankle
    collar hugs surf.sample_leg(side, cuff_z, th) + cuff_clr with a clean rolled inner rim."""
    objs = []
    n_t = 24
    for side in range(2):
        fb = surf.feet[side]
        cx = 0.5 * (fb['min_x'] + fb['max_x'])
        hx = 0.5 * (fb['max_x'] - fb['min_x']) + 0.006
        y_toe = fb['min_y'] if surf.front_y < 0 else fb['max_y']
        y_heel = fb['max_y'] if surf.front_y < 0 else fb['min_y']
        y_toe_out = y_toe + surf.front_y * 0.008
        y_heel_out = y_heel - surf.front_y * 0.007
        z0 = max(0.0, fb['min_z'])

        # Sample exact ankle collar center & per-angle radii at cuff_z
        ankle_r = []
        _, axc, ayc = surf.sample_leg(side, cuff_z, 0.0)
        for it in range(n_t):
            th = (it / n_t) * math.tau
            ar, _, _ = surf.sample_leg(side, cuff_z, th)
            ankle_r.append(ar + cuff_clr)

        d_toe = max(0.08, abs(y_toe_out - ayc))
        d_heel = max(0.04, abs(ayc - y_heel_out))
        cy_mid = 0.5 * (y_toe_out + y_heel_out)

        def foot_xy(th, scale=1.0):
            ct = math.cos(th)
            st = math.sin(th)
            w_s = (1.02 - 0.14 * (ct * ct)) if ct >= 0 else (1.00 - 0.16 * (ct * ct))
            xc_th = axc * (0.5 - 0.5 * ct) + cx * (0.5 + 0.5 * ct)
            fx0 = xc_th + st * hx * w_s
            dy0 = ct * d_toe if ct >= 0 else ct * d_heel
            fy0 = ayc + surf.front_y * dy0
            return cx + (fx0 - cx) * scale, cy_mid + (fy0 - cy_mid) * scale

        def ankle_xy(it, r_delta=0.0):
            th = (it / n_t) * math.tau
            r = max(0.025, ankle_r[it] + r_delta)
            return axc + math.sin(th) * r, ayc + math.cos(th) * surf.front_y * r

        # Ring profile from closed sole bottom -> sole welt -> enclosed toe box -> sloped vamp -> snug ankle collar -> inner rim tuck
        # Each entry: (ring_kind, z_val, front_blend, back_blend, foot_scale, r_delta, v_uv)
        z_toe_top = z0 + 0.044
        z_vamp = z0 + 0.044 + (cuff_z - (z0 + 0.044)) * 0.42
        z_throat = z0 + 0.044 + (cuff_z - (z0 + 0.044)) * 0.74
        profile = [
            ('sole_in',  z0,          0.00, 0.00, 0.42,  0.000, 0.00),
            ('sole_out', z0,          0.00, 0.00, 1.00,  0.000, 0.08),
            ('welt',     z0 + 0.009,  0.00, 0.00, 1.03,  0.000, 0.16),
            ('wall',     z0 + 0.022,  0.04, 0.12, 1.00,  0.000, 0.28),
            ('toe_box',  z0 + 0.035,  0.20, 0.36, 0.99,  0.000, 0.42),
            ('vamp0',    z_toe_top,   0.52, 0.72, 0.98,  0.000, 0.56),
            ('vamp1',    z_vamp,      0.82, 0.92, 0.98,  0.000, 0.70),
            ('throat',   z_throat,    0.96, 0.98, 0.98,  0.000, 0.82),
            ('collar',   cuff_z,      1.00, 1.00, 1.00,  0.002, 0.92),
            ('rim_top',  cuff_z + 0.002, 1.00, 1.00, 1.00, -0.001, 0.96),
            ('rim_in',   cuff_z - 0.016, 1.00, 1.00, 1.00, -0.004, 1.00),
        ]

        rings = []
        for (kind, z_base, fb_fr, fb_bk, f_scale, r_del, v_uv) in profile:
            row = []
            for it in range(n_t):
                uf = it / n_t
                th = uf * math.tau
                ct = math.cos(th)
                front_w = _sstep(-0.30, 0.30, ct)
                blend = fb_bk * (1.0 - front_w) + fb_fr * front_w
                fx, fy = foot_xy(th, f_scale)
                ax, ay = ankle_xy(it, r_del)
                x = fx * (1.0 - blend) + ax * blend
                y = fy * (1.0 - blend) + ay * blend
                # Subtle 4mm Renaissance leather heel step & midfoot arch on sole bottom
                if kind in ('sole_in', 'sole_out'):
                    heel_step = -0.003 if ct < -0.20 else (0.002 if ct < 0.25 else 0.0)
                    z = max(0.0, z_base + heel_step)
                elif kind == 'welt':
                    heel_step = -0.002 if ct < -0.20 else 0.0
                    z = max(0.005, z_base + heel_step)
                elif kind in ('toe_box', 'vamp0') and ct > 0.0:
                    # Smoothly arch the closed toe cap / instep slightly higher over the ball and instep
                    z = z_base + 0.005 * (1.0 - ct * 0.5)
                else:
                    z = z_base
                row.append(((x, y, z), 1.0, channel, fabric, uf * 2.0, v_uv, 0.0, uf))
            rings.append(row)

        v, f, p, cfu, fp = build_tube(rings, True)
        # Close bottom sole completely with center pole connected to inner sole ring (outward -Z normal!)
        bot_idx = len(v)
        v.append((cx, cy_mid, max(0.0, z0)))
        p.append(1.0)
        cfu.append((channel, fabric, 0.5, 0.0))
        fp.append((0.0, 0.5))
        for s in range(n_t):
            s2 = (s + 1) % n_t
            f.append((bot_idx, s2, s))

        shoe_obj = make_cloth_object(
            f'{name}_shoe{side}', v, f, p, cfu, fp,
            cloth_cfg=None, solidify=0.0, subsurf=1, sim_frames=0, min_clr=0.004,
        )
        # Keep flat bottom sole strictly above ground (z >= 0.0)
        for vt in shoe_obj.data.vertices:
            if vt.co.z < 0.0:
                vt.co.z = 0.0
        shoe_obj.data.update()
        objs.append(shoe_obj)
    return objs


def build_shoulder_cloak(surf, name, sim_frames=34):
    z_top = surf.neck.z + 0.005
    z_bot = 0.62
    n_z, n_t = 24, 40
    rings = []
    for iz in range(n_z):
        vf = iz / (n_z - 1)
        down = 1.0 - vf
        z = z_bot + vf * (z_top - z_bot)
        row = []
        for it in range(n_t):
            s = it / (n_t - 1)
            th = math.pi * (0.24 + s * 1.52)  # open front, draped over shoulders & back
            env_r, yc = surf.sample_torso(max(surf.t_z0, min(surf.t_z1, z)), th)
            sw = 0.27 + 0.16 * down
            bd = 0.21 + 0.18 * down
            target_r = math.hypot(math.sin(th) * sw, math.cos(th) * bd)
            fold = math.cos(s * math.pi * 10.0) * 0.014 * down
            r = max(env_r + 0.036, target_r) + fold
            x = math.sin(th) * r
            y = yc + math.cos(th) * surf.front_y * r - surf.front_y * 0.025 * down
            is_trim = vf < 0.07 or s < 0.045 or s > 0.955
            ch = CH_TRIM if is_trim else CH_HOSE
            pw = 1.0 if vf > 0.90 else (0.50 if vf > 0.80 else 0.0)
            fl = 0.92 * (down ** 1.35)
            row.append(((x, y, z), pw, ch, FAB_WOOL, s * 4.0, vf * 3.0, fl, s))
        rings.append(row)
    v, f, p, cfu, fp = build_tube(rings, False)
    cloak_cfg = {'mass': 0.50, 'tension': 18.0, 'compression': 10.0, 'shear': 8.0, 'bending': 0.45, 'air_damping': 2.2, 'col_dist': 0.012}
    return [make_cloth_object(name, v, f, p, cfu, fp, cloth_cfg=cloak_cfg, solidify=0.0036, subsurf=1, sim_frames=sim_frames)]


def join_and_transfer_skin(objs, body_ctx, spec_id, slot):
    """Joins garment pieces, transfers exact 93-joint skeletal weights from the HD Tripo body, computes crease AO, and exports binary."""
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    garment = bpy.context.view_layer.objects.active
    garment.name = f'Garment_{spec_id}'

    # Triangulate cleanly with FIXED quad split so vertical garment color seams (bodice lacing, apron, trim) stay razor-straight!
    tri = garment.modifiers.new('Triangulate', 'TRIANGULATE')
    tri.quad_method = 'FIXED'
    bpy.ops.object.modifier_apply(modifier=tri.name)

    # Transfer exact 93-joint vertex groups from the clean body donor, then smooth across shoulders/armpits
    # so sleeves and torsos bend like real woven fabric when arms drop from T-pose to natural idle/walk pose!
    donor = body_ctx['donor']
    dt = garment.modifiers.new('SkinTransfer', 'DATA_TRANSFER')
    dt.object = donor
    dt.use_vert_data = True
    dt.data_types_verts = {'VGROUP_WEIGHTS'}
    dt.vert_mapping = 'POLYINTERP_NEAREST'
    bpy.ops.object.datalayout_transfer(modifier=dt.name)
    bpy.ops.object.modifier_apply(modifier=dt.name)

    # Smooth vertex weights along connected fabric topology (never bleeds across disconnected shoes/buttons!)
    bpy.ops.object.select_all(action='DESELECT')
    garment.select_set(True)
    bpy.context.view_layer.objects.active = garment
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=0.55, repeat=6, expand=0.0)
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    bpy.ops.object.mode_set(mode='OBJECT')

    mesh = garment.data
    n_verts = len(mesh.vertices)
    n_tris = len(mesh.polygons)

    # Compute physical cloth crease/fold Ambient Occlusion from local mean curvature!
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bm.normal_update()
    crease_ao = [0.92] * n_verts
    for v in bm.verts:
        if not v.link_edges:
            continue
        avg = Vector((0.0, 0.0, 0.0))
        for e in v.link_edges:
            avg += e.other_vert(v).co
        avg /= len(v.link_edges)
        # Positive dot((v.co - avg), normal) = convex ridge (brighter), negative = concave cloth crease (soft tailored AO!)
        curv = (v.co - avg).dot(v.normal) * 70.0
        crease_ao[v.index] = max(0.78, min(1.04, 0.94 + max(-0.16, min(0.10, curv))))
    bm.free()

    # Read interpolated custom attributes (with FACE-domain INT support for discrete channel/fabric)
    def read_attr(aname, default=0.0):
        a = mesh.attributes.get(aname)
        if a is None:
            return [default] * n_verts
        buf = [0.0] * n_verts
        a.data.foreach_get('value', buf)
        return buf

    def read_face_int_attr(aname, default=0):
        a = mesh.attributes.get(aname)
        if a is None:
            return [default] * n_verts
        if a.domain == 'FACE':
            fbuf = [0] * n_tris
            a.data.foreach_get('value', fbuf)
            votes = [{} for _ in range(n_verts)]
            for pi, poly in enumerate(mesh.polygons):
                val = int(fbuf[pi])
                for vi in poly.vertices:
                    d = votes[vi]
                    d[val] = d.get(val, 0) + 1
            return [max(d.items(), key=lambda kv: kv[1])[0] if d else default for d in votes]
        buf = [0] * n_verts
        a.data.foreach_get('value', buf)
        return [int(round(v)) for v in buf]

    a_ch = read_face_int_attr('cloth_ch', 0)
    a_fab = read_face_int_attr('cloth_fab', 0)
    a_wu = read_attr('cloth_wu', 0.0)
    a_wv = read_attr('cloth_wv', 0.0)
    a_fl = read_attr('cloth_flex', 0.0)
    a_ph = read_attr('cloth_phase', 0.25)

    vg_to_slot = {}
    for vg in garment.vertex_groups:
        if vg.name in JOINT_INDEX:
            vg_to_slot[vg.index] = JOINT_INDEX[vg.name]

    is_skirt = ('skirt' in spec_id or 'breechcloth' in spec_id)
    is_cloak = (spec_id == 'shoulder-cloak')
    fallback_joint = JOINT_INDEX['pelvis'] if slot == 'lower' else JOINT_INDEX['spine_02']

    # Convert Blender Z-up -> glTF Y-up: (x_gl = x_bl, y_gl = z_bl, z_gl = -y_bl)
    # Verify sign from front_y: if front_y == -1.0 (standard glTF->Blender), then -y_bl == +z_gl (front!).
    pos_buf = bytearray(n_verts * 12)
    nrm_buf = bytearray(n_verts * 12)
    word_buf = bytearray(n_verts * 4)
    skin_j_buf = bytearray(n_verts * 4)
    skin_w_buf = bytearray(n_verts * 4)
    wind_buf = bytearray(n_verts * 4)

    pelvis_j = JOINT_INDEX['pelvis']
    thigh_l_j, thigh_r_j = JOINT_INDEX['thigh_l'], JOINT_INDEX['thigh_r']
    calf_l_j, calf_r_j = JOINT_INDEX['calf_l'], JOINT_INDEX['calf_r']
    sp3_j, sp2_j = JOINT_INDEX['spine_03'], JOINT_INDEX['spine_02']

    for i, v in enumerate(mesh.vertices):
        x, y, z = v.co.x, v.co.z, -v.co.y
        nx, ny, nz = v.normal.x, v.normal.z, -v.normal.y
        nl = math.hypot(nx, ny, nz) or 1.0
        nx, ny, nz = nx / nl, ny / nl, nz / nl
        struct.pack_into('<3f', pos_buf, i * 12, x, y, z)
        struct.pack_into('<3f', nrm_buf, i * 12, nx, ny, nz)

        ch = max(0, min(7, int(round(a_ch[i]))))
        fab = max(0, min(7, int(round(a_fab[i]))))
        ao8 = max(0, min(255, int(round(crease_ao[i] * 255.0))))
        u8 = max(0, min(255, int(round((a_wu[i] % 1.0) * 255.0))))
        v8 = max(0, min(255, int(round((a_wv[i] % 1.0) * 255.0))))
        word = (ch | (fab << 3) | (ao8 << 8) | (u8 << 16) | (v8 << 24)) & 0xFFFFFFFF
        struct.pack_into('<I', word_buf, i * 4, word)

        # Skinning: lock skirt waistband AND its belt/buckle together to pelvis so belt never separates in Idle/Walk!
        if is_skirt and y > 0.13:
            if y > 0.90 and ch in (CH_LEATHER, CH_BRASS, CH_BUFF, CH_TRIM):
                pairs_raw = [(pelvis_j, 1.0)]
            elif ch not in (CH_LEATHER, CH_BRASS, CH_BUFF):
                # Pelvis holds waist (y >= 0.90), drops rapidly below hip so each side tracks its thigh/knee cleanly while striding!
                pw = max(0.0, min(1.0, (y - 0.74) / 0.18))
                t_lr = max(0.0, min(1.0, (x + 0.065) / 0.13))
                sb = t_lr * t_lr * (3.0 - 2.0 * t_lr)  # smoothstep(-0.065, +0.065, x)
                calf_f = max(0.0, min(0.70, (0.50 - y) / 0.34))
                leg_w = 1.0 - pw
                lw = leg_w * (1.0 - calf_f)
                cw = leg_w * calf_f
                pairs_raw = [
                    (pelvis_j, pw),
                    (thigh_l_j, lw * sb),
                    (thigh_r_j, lw * (1.0 - sb)),
                    (calf_l_j if sb >= 0.5 else calf_r_j, cw),
                ]
            else:
                # Shoes at y <= 0.13 handled in else branch below
                jmap = {}
                for g in v.groups:
                    js = vg_to_slot.get(g.group, -1)
                    if 0 < js < len(JOINTS) and g.weight > 1e-5:
                        jmap[js] = jmap.get(js, 0.0) + g.weight
                pairs_raw = sorted(jmap.items(), key=lambda kv: kv[1], reverse=True)[:4]
                if not pairs_raw:
                    pairs_raw = [(fallback_joint, 1.0)]
        elif is_cloak:
            vf = max(0.0, min(1.0, (y - 0.62) / 0.90))
            pairs_raw = [(sp3_j, 0.45 + 0.45 * vf), (sp2_j, 0.35), (pelvis_j, 0.20 * (1.0 - vf))]
        else:
            jmap = {}
            for g in v.groups:
                js = vg_to_slot.get(g.group, -1)
                if 0 < js < len(JOINTS) and g.weight > 1e-5:
                    jmap[js] = jmap.get(js, 0.0) + g.weight
            pairs_raw = sorted(jmap.items(), key=lambda kv: kv[1], reverse=True)[:4]
            if not pairs_raw:
                pairs_raw = [(fallback_joint, 1.0)]

        # Pack top-4 strictly normalized uint8 weights summing to 255 with j > 0
        pairs_raw = [(j, w) for j, w in pairs_raw if w > 1e-6 and 0 < j < len(JOINTS)]
        if not pairs_raw:
            pairs_raw = [(fallback_joint, 1.0)]
        pairs_raw.sort(key=lambda kv: kv[1], reverse=True)
        pairs_raw = pairs_raw[:4]
        wsum = sum(w for _, w in pairs_raw) or 1.0
        qpairs = [[j, int(round((w / wsum) * 255.0))] for j, w in pairs_raw]
        qpairs[0][1] += 255 - sum(q for _, q in qpairs)
        qpairs.sort(key=lambda kv: kv[1], reverse=True)
        J = 0
        W = 0
        for k, (j, q) in enumerate(qpairs):
            J |= (j & 255) << (k * 8)
            W |= (q & 255) << (k * 8)
        struct.pack_into('<I', skin_j_buf, i * 4, J & 0xFFFFFFFF)
        struct.pack_into('<I', skin_w_buf, i * 4, W & 0xFFFFFFFF)

        f16 = max(0, min(65535, int(round(max(0.0, min(1.0, a_fl[i])) * 65535.0))))
        p16 = max(1, min(65535, int(round((a_ph[i] % 1.0) * 65535.0))))
        struct.pack_into('<I', wind_buf, i * 4, (f16 | (p16 << 16)) & 0xFFFFFFFF)

    idx_buf = bytearray(n_tris * 12)
    for ti, poly in enumerate(mesh.polygons):
        a, b, c = poly.vertices[0], poly.vertices[1], poly.vertices[2]
        struct.pack_into('<3I', idx_buf, ti * 12, a, b, c)

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f'{spec_id}.bin')
    with open(out_path, 'wb') as f:
        # Magic 'CLTH', version 1, n_verts, n_tris
        f.write(struct.pack('<4sIII', b'CLTH', 1, n_verts, n_tris))
        f.write(pos_buf)
        f.write(nrm_buf)
        f.write(word_buf)
        f.write(skin_j_buf)
        f.write(skin_w_buf)
        f.write(wind_buf)
        f.write(idx_buf)

    # Clean garment object from scene before next garment
    bpy.data.objects.remove(garment, do_unlink=True)
    return n_verts, n_tris, out_path


def build_one_garment(surf, body_ctx, spec_id, slot, sim_frames):
    z_waist = 1.01 if surf.female else 1.00
    linen_cfg = {'mass': 0.26, 'tension': 34.0, 'compression': 28.0, 'shear': 22.0, 'bending': 1.6, 'air_damping': 3.2, 'pin_shrinkwrap': False}
    wool_cfg = {'mass': 0.42, 'tension': 44.0, 'compression': 36.0, 'shear': 26.0, 'bending': 2.8, 'air_damping': 3.4, 'pin_shrinkwrap': False}
    leather_cfg = {'mass': 0.52, 'tension': 55.0, 'compression': 44.0, 'shear': 32.0, 'bending': 4.5, 'air_damping': 3.5, 'pin_shrinkwrap': False}
    skirt_frames = max(sim_frames, 16)

    # Fitted upper garments use sculpted tailored patterns (sim_frames=0) for crisp, smooth, dent-free 1550 tailoring
    # with subtle draped linen folds & rolled hems; flowing skirts, cloaks, and full slops use gentle physical cloth drape.
    objs = []
    if spec_id == 'male-linen-shirt':
        objs.append(build_torso_piece(surf, 'shirt_body', z_bot=z_waist - 0.004, clearance=0.017, v_neck=0.072, tucked=True,
                                      pleats=10, pleat_amp=0.0045, channel=CH_SHIRT, fabric=FAB_LINEN,
                                      cloth_cfg=None, solidify=0.0026, sim_frames=0, hem_flex=0.12))
        objs.extend(build_sleeves_piece(surf, 'shirt_slv', x_end_frac=0.56, clearance=0.017, puff_amp=0.009,
                                        rolled_cuff=True, channel=CH_SHIRT, fabric=FAB_LINEN,
                                        cloth_cfg=None, solidify=0.0024, sim_frames=0))
    elif spec_id == 'male-doublet':
        objs.append(build_torso_piece(surf, 'dbl_body', z_bot=0.84, clearance=0.023, flare_bot=0.052,
                                      stand_collar=0.036, collar_ch=CH_LINEN, channel=CH_SHIRT, fabric=FAB_WOOL,
                                      cloth_cfg=None, solidify=0.0032, sim_frames=0, hem_flex=0.10))
        objs.extend(build_sleeves_piece(surf, 'dbl_slv', x_end_frac=0.88, clearance=0.017, puff_amp=0.007,
                                        cuff_trim=True, rolled_cuff=False, channel=CH_SHIRT, fabric=FAB_WOOL,
                                        cloth_cfg=None, solidify=0.0028, sim_frames=0))
        objs.append(build_buttons(surf, 'dbl', z_bot=0.96, z_top=1.42, count=7, clr=0.024))
    elif spec_id == 'male-soldier-jerkin':
        objs.extend(build_sleeves_piece(surf, 'jrk_slv', x_end_frac=0.84, clearance=0.017, puff_amp=0.006,
                                        cuff_trim=True, rolled_cuff=False, channel=CH_LINEN, fabric=FAB_LINEN,
                                        cloth_cfg=None, solidify=0.0024, sim_frames=0))
        objs.append(build_torso_piece(surf, 'jrk_body', z_bot=0.84, clearance=0.023, flare_bot=0.052,
                                      stand_collar=0.030, channel=CH_BUFF, fabric=FAB_LEATHER,
                                      cloth_cfg=None, solidify=0.0034, sim_frames=0, hem_flex=0.06))
        objs.append(build_buttons(surf, 'jrk', z_bot=0.95, z_top=1.40, count=6, clr=0.025))
    elif spec_id == 'female-chemise-blouse':
        objs.append(build_torso_piece(surf, 'blouse_body', z_bot=z_waist + 0.012, clearance=0.017, scoop=0.056, tucked=True,
                                      pleats=12, pleat_amp=0.0040, channel=CH_SHIRT, fabric=FAB_LINEN,
                                      cloth_cfg=None, solidify=0.0026, sim_frames=0, hem_flex=0.08))
        objs.extend(build_sleeves_piece(surf, 'blouse_slv', x_end_frac=0.58, clearance=0.017, puff_amp=0.011,
                                        rolled_cuff=True, channel=CH_SHIRT, fabric=FAB_LINEN,
                                        cloth_cfg=None, solidify=0.0022, sim_frames=0, x0_frac=0.96))
    elif spec_id == 'female-laced-bodice':
        objs.extend(build_sleeves_piece(surf, 'bod_slv', x_end_frac=0.56, clearance=0.017, puff_amp=0.012,
                                        rolled_cuff=True, channel=CH_LINEN, fabric=FAB_LINEN,
                                        cloth_cfg=None, solidify=0.0022, sim_frames=0, x0_frac=0.96))
        objs.append(build_torso_piece(surf, 'bod_body', z_bot=z_waist + 0.012, clearance=0.018, scoop=0.062, tucked=True,
                                      collar_ch=CH_LINEN, bodice_lace=True, channel=CH_SHIRT, fabric=FAB_WOOL,
                                      cloth_cfg=None, solidify=0.0030, sim_frames=0, hem_flex=0.05))
    elif spec_id == 'indigenous-tunic-m':
        objs.append(build_torso_piece(surf, 'tun_body', z_bot=0.82, clearance=0.023, flare_bot=0.032, scoop=0.055,
                                      hem_trim=True, pleats=8, pleat_amp=0.0045, channel=CH_SHIRT, fabric=FAB_COTTON,
                                      cloth_cfg=None, solidify=0.0026, sim_frames=0, hem_flex=0.26))
        objs.extend(build_sleeves_piece(surf, 'tun_slv', x_end_frac=0.30, clearance=0.017, puff_amp=0.005,
                                        rolled_cuff=False, channel=CH_SHIRT, fabric=FAB_COTTON,
                                        cloth_cfg=None, solidify=0.0024, sim_frames=0))
    elif spec_id == 'indigenous-huipil-f':
        objs.append(build_torso_piece(surf, 'hup_body', z_bot=0.83, clearance=0.023, flare_bot=0.032, scoop=0.052,
                                      hem_trim=True, pleats=10, pleat_amp=0.0045, channel=CH_SHIRT, fabric=FAB_COTTON,
                                      cloth_cfg=None, solidify=0.0026, sim_frames=0, hem_flex=0.28))
        objs.extend(build_sleeves_piece(surf, 'hup_slv', x_end_frac=0.32, clearance=0.018, puff_amp=0.006,
                                        rolled_cuff=False, channel=CH_SHIRT, fabric=FAB_COTTON,
                                        cloth_cfg=None, solidify=0.0024, sim_frames=0))
    elif spec_id == 'male-mariner-slops':
        objs.extend(build_leg_trousers(surf, 'slops', z_waist=z_waist + 0.044, z_knee=0.42,
                                       clr_hip=0.021, clr_thigh=0.030, clr_knee=0.020, slop_puff=0.022, pleat_freq=10,
                                       channel=CH_TROUSERS, fabric=FAB_WOOL, sim_frames=0))
        objs.extend(build_belt_and_buckle(surf, 'slops', z_center=z_waist + 0.028, half_h=0.015, clr=0.023, thickness=0.005))
        objs.extend(build_shoes(surf, 'slops', channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.115, cuff_clr=0.008))
    elif spec_id == 'male-trunk-hose':
        objs.extend(build_leg_trousers(surf, 'trunk', z_waist=z_waist + 0.040, z_knee=0.54, z_ankle=0.09,
                                       clr_hip=0.019, clr_thigh=0.038, clr_knee=0.022, slop_puff=0.034, pleat_freq=14,
                                       hose_ch=CH_HOSE, channel=CH_TROUSERS, fabric=FAB_WOOL, sim_frames=0))
        objs.extend(build_belt_and_buckle(surf, 'trunk', z_center=z_waist + 0.028, half_h=0.015, clr=0.025, thickness=0.005))
        objs.extend(build_shoes(surf, 'trunk', channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.155, cuff_clr=0.018))
    elif spec_id == 'female-pleated-skirt':
        objs.extend(build_pleated_skirt(surf, 'skirt', z_waist=z_waist + 0.030, z_hem=0.10, waist_clr=0.022,
                                        hem_rx=0.42, hem_rz=0.39, pleats=16, pleat_amp=0.018,
                                        channel=CH_TROUSERS, fabric=FAB_WOOL, apron=False, sim_frames=skirt_frames))
        objs.extend(build_belt_and_buckle(surf, 'skirt', z_center=z_waist + 0.026, half_h=0.015, clr=0.027, thickness=0.005, belt_ch=CH_LEATHER, buckle_ch=CH_BRASS))
        objs.extend(build_shoes(surf, 'skirt', channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.105, cuff_clr=0.008))
    elif spec_id == 'female-apron-skirt':
        objs.extend(build_pleated_skirt(surf, 'askirt', z_waist=z_waist + 0.030, z_hem=0.10, waist_clr=0.022,
                                        hem_rx=0.42, hem_rz=0.39, pleats=16, pleat_amp=0.018,
                                        channel=CH_TROUSERS, fabric=FAB_WOOL, apron=True, sim_frames=skirt_frames))
        objs.extend(build_belt_and_buckle(surf, 'askirt', z_center=z_waist + 0.026, half_h=0.015, clr=0.028, thickness=0.005, belt_ch=CH_LINEN, buckle_ch=None))
        objs.extend(build_shoes(surf, 'askirt', channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.105, cuff_clr=0.008))
    elif spec_id == 'indigenous-breechcloth-m':
        objs.extend(build_pleated_skirt(surf, 'breech', z_waist=z_waist + 0.020, z_hem=0.46, n_z=18, n_t=40,
                                        waist_clr=0.020, hem_rx=0.28, hem_rz=0.25, pleats=10, pleat_amp=0.012,
                                        channel=CH_TROUSERS, fabric=FAB_COTTON, hem_trim=True, max_flex=0.55, sim_frames=sim_frames))
        objs.extend(build_belt_and_buckle(surf, 'breech', z_center=z_waist + 0.022, half_h=0.015, clr=0.025, thickness=0.005, belt_ch=CH_TRIM, buckle_ch=None))
        objs.extend(build_shoes(surf, 'breech', channel=CH_BUFF, fabric=FAB_LEATHER, cuff_z=0.105, cuff_clr=0.008))
    elif spec_id == 'indigenous-wrap-skirt-f':
        objs.extend(build_pleated_skirt(surf, 'wrap', z_waist=z_waist + 0.020, z_hem=0.16, n_z=24, n_t=48,
                                        waist_clr=0.020, hem_rx=0.35, hem_rz=0.31, pleats=12, pleat_amp=0.014,
                                        channel=CH_TROUSERS, fabric=FAB_COTTON, hem_trim=True, max_flex=0.72, sim_frames=skirt_frames))
        objs.extend(build_belt_and_buckle(surf, 'wrap', z_center=z_waist + 0.022, half_h=0.015, clr=0.025, thickness=0.005, belt_ch=CH_TRIM, buckle_ch=None))
        objs.extend(build_shoes(surf, 'wrap', channel=CH_BUFF, fabric=FAB_LEATHER, cuff_z=0.105, cuff_clr=0.008))
    elif spec_id == 'shoulder-cloak':
        objs.extend(build_shoulder_cloak(surf, 'cloak', sim_frames=skirt_frames))
    elif spec_id == 'female-riding-breeches':
        objs.extend(build_leg_trousers(surf, 'fbreeches', z_waist=z_waist + 0.036, z_knee=0.34, z_ankle=0.09,
                                       clr_hip=0.021, clr_thigh=0.026, clr_knee=0.018, slop_puff=0.012, pleat_freq=8,
                                       hose_ch=CH_LEATHER, channel=CH_TROUSERS, fabric=FAB_WOOL, sim_frames=0))
        objs.extend(build_belt_and_buckle(surf, 'fbreeches', z_center=z_waist + 0.024, half_h=0.014, clr=0.023, thickness=0.005, belt_ch=CH_LEATHER, buckle_ch=CH_BRASS))
        objs.extend(build_shoes(surf, 'fbreeches', channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.145, cuff_clr=0.018))
    else:
        raise RuntimeError(f'Unknown garment {spec_id}')

    return join_and_transfer_skin(objs, body_ctx, spec_id, slot)


def render_cloth_verify(glb_path, sex, pairs):
    """Renders crisp Cycles verification views of exported cloth .bin garments on the 50k body
    in BOTH rest pose AND arms-down natural Idle pose to confirm zero chest dimples, zero shoulder
    crumples, zero skin poke-through, and clean collar/neckline tailoring!"""
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=glb_path)
    body_obj = max((o for o in bpy.context.scene.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
    arm_obj = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
    for p in body_obj.data.polygons:
        p.use_smooth = True

    # Setup simple clean PBR materials for cloth channels
    ch_colors = {
        CH_SHIRT: (0.62, 0.56, 0.46, 1.0) if sex == 'male' else (0.74, 0.70, 0.63, 1.0),
        CH_TROUSERS: (0.14, 0.19, 0.27, 1.0) if sex == 'male' else (0.32, 0.14, 0.14, 1.0),
        CH_LINEN: (0.82, 0.79, 0.72, 1.0),
        CH_LEATHER: (0.10, 0.06, 0.035, 1.0),
        CH_BRASS: (0.58, 0.39, 0.11, 1.0),
        CH_BUFF: (0.42, 0.28, 0.14, 1.0),
        CH_HOSE: (0.09, 0.09, 0.10, 1.0),
        CH_TRIM: (0.45, 0.10, 0.07, 1.0),
    }
    ch_mats = []
    for ch in range(8):
        m = bpy.data.materials.new(f'VerifyCh{ch}')
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        bsdf.inputs['Base Color'].default_value = ch_colors[ch]
        bsdf.inputs['Roughness'].default_value = 0.25 if ch == CH_BRASS else (0.50 if ch == CH_LEATHER else 0.85)
        if ch == CH_BRASS:
            bsdf.inputs['Metallic'].default_value = 0.85
        ch_mats.append(m)

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 20
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 640
    scene.render.resolution_y = 800
    scene.view_settings.view_transform = 'AgX'

    world = bpy.data.worlds.new('ClothWorld')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.35, 0.40, 0.48, 1.0)
        bg.inputs[1].default_value = 0.80

    sun_data = bpy.data.lights.new('KeySun', type='SUN')
    sun_data.energy = 3.2
    sun_data.angle = math.radians(10.0)
    sun_obj = bpy.data.objects.new('KeySun', sun_data)
    bpy.context.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = (math.radians(48), math.radians(-18), math.radians(-24))

    cam_data = bpy.data.cameras.new('VerifyCam')
    cam_data.lens = 55.0
    cam_obj = bpy.data.objects.new('VerifyCam', cam_data)
    bpy.context.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    def load_bin_garment(gid):
        p = os.path.join(OUT_DIR, f'{gid}.bin')
        raw = open(p, 'rb').read()
        magic, ver, nv, nt = struct.unpack_from('<4sIII', raw, 0)
        off = 16
        pos_gl = struct.unpack_from(f'<{nv * 3}f', raw, off); off += nv * 12
        off += nv * 12  # skip normals
        words = struct.unpack_from(f'<{nv}I', raw, off); off += nv * 4
        skin_j = struct.unpack_from(f'<{nv}I', raw, off); off += nv * 4
        skin_w = struct.unpack_from(f'<{nv}I', raw, off); off += nv * 4
        off += nv * 4  # skip wind
        idxs = struct.unpack_from(f'<{nt * 3}I', raw, off)

        # Convert glTF Y-up back to Blender Z-up: (x_bl = x_gl, y_bl = -z_gl, z_bl = y_gl)
        bverts = [(pos_gl[i * 3], -pos_gl[i * 3 + 2], pos_gl[i * 3 + 1]) for i in range(nv)]
        bfaces = [(idxs[t * 3], idxs[t * 3 + 1], idxs[t * 3 + 2]) for t in range(nt)]
        me = bpy.data.meshes.new(f'V_{gid}')
        me.from_pydata(bverts, [], bfaces)
        me.update()
        obj = bpy.data.objects.new(f'V_{gid}', me)
        bpy.context.collection.objects.link(obj)
        for m in ch_mats:
            me.materials.append(m)
        for poly in me.polygons:
            poly.use_smooth = True
            poly.material_index = words[poly.vertices[0]] & 7
        # Create vertex groups matching armature bone names so ARMATURE modifier poses cloth identically!
        vgs = {}
        for j_slot, j_name in enumerate(JOINTS):
            vgs[j_slot] = obj.vertex_groups.new(name=j_name)
        for vi in range(nv):
            jw, ww = skin_j[vi], skin_w[vi]
            for k in range(4):
                js = (jw >> (k * 8)) & 255
                wt = ((ww >> (k * 8)) & 255) / 255.0
                if wt > 1e-4 and js in vgs:
                    vgs[js].add([vi], wt, 'REPLACE')
        # Match body_obj world transform (arm_obj is parent of body_obj)
        inv_arm = arm_obj.matrix_world.inverted()
        for v in me.vertices:
            v.co = inv_arm @ v.co
        me.update()
        obj.parent = arm_obj
        amod = obj.modifiers.new('Armature', 'ARMATURE')
        amod.object = arm_obj
        return obj

    os.makedirs(VERIFY_CLOTH_DIR, exist_ok=True)
    idle_act = next((a for a in bpy.data.actions if 'Idle' in a.name), None)

    for tag, gids in pairs:
        loaded = [load_bin_garment(g) for g in gids]
        for pose_name, use_idle in (('rest', False), ('idle', True)):
            if use_idle and idle_act is not None:
                arm_obj.data.pose_position = 'POSE'
                if arm_obj.animation_data is None:
                    arm_obj.animation_data_create()
                arm_obj.animation_data.action = idle_act
                scene.frame_set(1)
            else:
                arm_obj.data.pose_position = 'REST'
                scene.frame_set(1)
            # Frame torso + head + hips cleanly (1.5 m portrait view)
            z_tgt = 1.24 if sex == 'female' else 1.30
            cam_loc = Vector((-0.38, -1.65, z_tgt + 0.06))
            cam_obj.location = cam_loc
            cam_obj.rotation_euler = (Vector((0.0, 0.0, z_tgt)) - cam_loc).to_track_quat('-Z', 'Y').to_euler()
            out_png = os.path.join(VERIFY_CLOTH_DIR, f'{sex}_{tag}_{pose_name}.png')
            scene.render.filepath = out_png
            bpy.ops.render.render(write_still=True)
            print(f'  [cloth-verify] rendered {out_png}')
        for o in loaded:
            bpy.data.objects.remove(o, do_unlink=True)


def main():
    global _ACTIVE_DONOR, _ACTIVE_SURF
    only, sex_filter, sim_frames, verify = parse_args()
    t_all = time.perf_counter()
    for sex in ('female', 'male'):
        if sex_filter and sex != sex_filter:
            continue
        todo = [(gid, gsex, gslot) for gid, gsex, gslot in GARMENTS if gsex == sex and (only is None or gid in only)]
        if not todo:
            continue
        fit50k_name = 'villager-female.glb' if sex == 'female' else 'sailor-male.glb'
        glb_50k = os.path.join(FIT_50K_DIR, fit50k_name)
        glb = glb_50k if os.path.exists(glb_50k) else os.path.join(FIT_DIR, f'base-{sex}.glb')
        if not os.path.exists(glb):
            raise SystemExit(f'Missing fitted base body: {glb}')
        print(f'\n=== Loading fitted base body {os.path.relpath(glb, ROOT)} ===')
        t0 = time.perf_counter()
        body_ctx = import_fitted_body(glb)
        _ACTIVE_DONOR = body_ctx['donor']
        surf = BodySurface(body_ctx, female=(sex == 'female'))
        _ACTIVE_SURF = surf
        print(f'Loaded + built collision/donor proxy in {time.perf_counter() - t0:.1f}s (front_y={surf.front_y:+.0f})')

        for gid, _gsex, gslot in todo:
            tg = time.perf_counter()
            nv, nt, outp = build_one_garment(surf, body_ctx, gid, gslot, sim_frames)
            print(f'  {gid:24s}: {nv:6d} verts · {nt:6d} tris · {os.path.getsize(outp) // 1024:4d} KB · {time.perf_counter() - tg:.1f}s')

        if verify:
            pairs = (
                [('blouse_skirt', ['female-chemise-blouse', 'female-pleated-skirt']),
                 ('bodice_apron', ['female-laced-bodice', 'female-apron-skirt'])]
                if sex == 'female' else
                [('shirt_slops', ['male-linen-shirt', 'male-mariner-slops']),
                 ('doublet_hose', ['male-doublet', 'male-trunk-hose'])]
            )
            render_cloth_verify(glb, sex, pairs)

    print(f'\nDone in {time.perf_counter() - t_all:.1f}s')


if __name__ == '__main__':
    main()
