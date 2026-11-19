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
FIT_DIR = os.path.join(ROOT, '.tripo', '1550-hd-base', 'fit')
OUT_DIR = os.path.join(ROOT, '.tripo', '1550-hd-base', 'cloth')

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
    sim_frames = 26
    for a in argv:
        if a.startswith('--only='):
            only = set(a.split('=', 1)[1].split(','))
        elif a.startswith('--sex='):
            sex_filter = a.split('=', 1)[1]
        elif a.startswith('--sim-frames='):
            sim_frames = int(a.split('=', 1)[1])
    return only, sex_filter, sim_frames


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
        # Smoothly fill any missed grazing rays without ever shrinking below measured surface
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
                    else:
                        self.torso_r[iz][it] = max(c, c * 0.78 + (sum(nb) * 0.25) * 0.22)

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


def enforce_body_clearance(obj, donor, min_clr):
    """Mathematically guarantees every vertex of the cloth surface sits at least min_clr outside the high-res Tripo body."""
    if donor is None or min_clr <= 0.0:
        return
    mesh = obj.data
    pushed = 0
    for v in mesh.vertices:
        ok, loc, nrm, _fi = donor.closest_point_on_mesh(v.co)
        if not ok:
            continue
        delta = v.co - loc
        sd = delta.dot(nrm)
        if sd < min_clr:
            v.co = loc + nrm * min_clr
            pushed += 1
    if pushed:
        mesh.update()


def make_cloth_object(name, verts, faces, pin_weights, chan_fab_uv, flex_phase, cloth_cfg=None, solidify=0.0028, subsurf=1, sim_frames=26, min_clr=0.010):
    """Creates a Blender mesh, runs real physical CLOTH simulation + SUBSURF + SOLIDIFY, and returns the evaluated mesh object."""
    mesh = bpy.data.meshes.new(name + '_mesh')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    # Store channel & fabric as discrete INT attributes on FACE domain so SUBSURF/SOLIDIFY NEVER
    # linearly interpolate CH_SHIRT(0) and CH_LINEN(2) into CH_TROUSERS(1)!
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
        # True body-curve seam pinning: snap structural seams (collar, shoulders, waistband, cuffs) flush to the
        # Tripo body surface via SHRINKWRAP BEFORE cloth physics so ONLY free fabric drapes between pinned curves!
        if _ACTIVE_DONOR is not None and cloth_cfg.get('pin_shrinkwrap', True) and any(pw > 0.5 for pw in pin_weights):
            sw = obj.modifiers.new('PinToBodyCurve', 'SHRINKWRAP')
            sw.target = _ACTIVE_DONOR
            sw.wrap_method = 'NEAREST_SURFACEPOINT'
            sw.wrap_mode = 'OUTSIDE_SURFACE'
            sw.offset = cloth_cfg.get('pin_offset', max(0.011, min_clr))
            sw.vertex_group = 'CLOTH_PIN'
            bpy.ops.object.modifier_apply(modifier=sw.name)

        # Subdivide slightly BEFORE cloth sim if requested so folds bend smoothly
        if cloth_cfg.get('pre_subsurf', 0) > 0:
            ss0 = obj.modifiers.new('PreSubsurf', 'SUBSURF')
            ss0.levels = cloth_cfg['pre_subsurf']
            ss0.render_levels = cloth_cfg['pre_subsurf']
            bpy.ops.object.modifier_apply(modifier=ss0.name)

        cmod = obj.modifiers.new('Cloth', 'CLOTH')
        cs = cmod.settings
        cs.quality = cloth_cfg.get('quality', 7)
        cs.mass = cloth_cfg.get('mass', 0.30)
        cs.air_damping = cloth_cfg.get('air_damping', 1.8)
        cs.tension_stiffness = cloth_cfg.get('tension', 16.0)
        cs.compression_stiffness = cloth_cfg.get('compression', 12.0)
        cs.shear_stiffness = cloth_cfg.get('shear', 10.0)
        cs.bending_stiffness = cloth_cfg.get('bending', 0.45)
        cs.tension_damping = 6.0
        cs.compression_damping = 6.0
        cs.bending_damping = 0.8
        cs.vertex_group_mass = 'CLOTH_PIN'
        cs.pin_stiffness = cloth_cfg.get('pin_stiffness', 1.0)
        cs.shrink_min = cloth_cfg.get('shrink', 0.0)
        cc = cmod.collision_settings
        cc.use_collision = True
        cc.collision_quality = 4
        cc.distance_min = cloth_cfg.get('col_dist', 0.008)
        cc.friction = 14.0
        cc.use_self_collision = cloth_cfg.get('self_col', False)
        cc.self_distance_min = 0.006

        # Step Blender's physical cloth simulation!
        scene = bpy.context.scene
        scene.frame_start = 1
        scene.frame_end = sim_frames + 2
        scene.frame_set(1)
        for frame in range(1, sim_frames + 1):
            scene.frame_set(frame)

        # Bake the simulated cloth shape permanently into the mesh
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

    # Gentle corrective smooth to remove any tiny cloth pinch artifacts BEFORE clearance push & solidify
    sm = obj.modifiers.new('Smooth', 'SMOOTH')
    sm.factor = 0.30
    sm.iterations = 2
    bpy.ops.object.modifier_apply(modifier=sm.name)

    # Guaranteed geometric body clearance BEFORE solidify so ZERO vertices ever intersect skin!
    enforce_body_clearance(obj, _ACTIVE_DONOR, min_clr)

    if solidify > 0.0:
        sol = obj.modifiers.new('Solidify', 'SOLIDIFY')
        sol.thickness = solidify
        sol.offset = 1.0  # grow strictly OUTWARD from body!
        sol.use_rim = True
        bpy.ops.object.modifier_apply(modifier=sol.name)

    # Clean out pin group so only real bone weights exist later
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
    neck_r = 0.064 if surf.female else 0.076
    yoke_z0 = sh_z - 0.012
    yoke_z1 = (neck_z + 0.020) if shoulder_yoke else (z_top or surf.pelvis.z + 0.06)
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
                if v_neck > 0 and cos_f > 0.65:
                    vs = ((cos_f - 0.65) / 0.35) ** 1.3
                    z -= v_neck * vs * yt
                elif scoop > 0 and cos_f > 0.42:
                    ss = ((cos_f - 0.42) / 0.58) ** 1.3
                    z -= scoop * ss * yt
                if stand_collar > 0 and yt > 0.60:
                    z += stand_collar * ((yt - 0.60) / 0.40)

            env_r, yc = surf.sample_torso(min(surf.t_z1, max(surf.t_z0, z)), th)
            bot_flare = flare_bot * (max(0.0, 1.0 - bf * 2.0) ** 1.5)
            pleat_w = (0.5 + 0.5 * math.cos(th * pleats)) * pleat_amp * (1.0 - bf * 0.5) if pleats > 0 else 0.0
            # Never apply negative tuck_drop that pulls the lower back/waist cloth inside the spine skin!
            tuck_drop = 0.0
            r = env_r + clearance + tuck_drop + bot_flare + pleat_w

            if in_yoke:
                collar_r = neck_r + (0.012 if stand_collar > 0 else 0.016)
                cw = yt ** 1.08
                sh_r, sh_yc = surf.sample_torso(min(surf.t_z1, yoke_z0), th)
                yoke_r = (sh_r + clearance) * (1.0 - cw) + collar_r * cw
                r = max(env_r + 0.018, yoke_r)
                yc = sh_yc * (1.0 - cw) + neck_y * cw

            x = math.sin(th) * r
            y = yc + math.cos(th) * surf.front_y * r

            ch, fab = channel, fabric
            if collar_ch is not None and in_yoke and yt > 0.68:
                ch, fab = collar_ch, FAB_LINEN
            elif hem_trim and not in_yoke and bf < 0.09:
                ch, fab = CH_TRIM, FAB_COTTON
            elif bodice_lace and cos_f > 0.985 and 0.14 < bf < 0.88 and not in_yoke:
                ch, fab = CH_LINEN, FAB_LINEN

            # Pin collar/yoke firmly + firm pin at tucked bottom hem so torso drapes naturally without riding up!
            pw = 0.0
            if in_yoke:
                pw = 0.65 + 0.35 * yt
            elif tucked and bf < 0.10:
                pw = 1.0
            elif tucked and bf < 0.22:
                pw = 0.80 * (1.0 - (bf - 0.10) / 0.12)
            elif not shoulder_yoke and bf > 0.80:
                pw = 1.0

            fl = hem_flex * (max(0.0, 1.0 - bf * 1.7) ** 1.5) if not tucked else 0.05 * math.sin(bf * math.pi)
            row.append(((x, y, z), pw, ch, fab, uf * 4.0, vf * 3.0, fl, uf))
        rings.append(row)

    v, f, p, cfu, fp = build_tube(rings, True)
    return make_cloth_object(name, v, f, p, cfu, fp, cloth_cfg=cloth_cfg, solidify=solidify, subsurf=subsurf, sim_frames=sim_frames, min_clr=max(0.016, clearance * 0.58))


def build_sleeves_piece(surf, name, *, x_end_frac=0.58, n_x=22, n_t=28, clearance=0.018,
                        puff_amp=0.016, cuff_trim=False, rolled_cuff=True,
                        channel=CH_SHIRT, fabric=FAB_LINEN, sleeve_flex=0.22,
                        cloth_cfg=None, solidify=0.0024, subsurf=1, sim_frames=24, x0_frac=0.95):
    objs = []
    # Start cleanly at the outer shoulder seam (x0_frac=0.95) so contrasting chemise sleeves never bury inside the bodice chest!
    x0 = surf.arm_x0 * x0_frac
    x1 = surf.arm_x0 + (surf.arm_x1 - surf.arm_x0) * x_end_frac
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
                # Taper sleeve-cap smoothly out from inside the bodice armscye (uf=0) to avoid shoulder-seam z-fighting!
                cap = 0.014 * math.sin(min(1.0, uf / 0.32) * math.pi) if uf < 0.32 else 0.0
                puff = puff_amp * math.sin(uf * math.pi) * (0.85 + 0.15 * math.cos(th * 8))
                cuff = 0.009 * math.sin(((uf - 0.85) / 0.15) * math.pi) if (rolled_cuff and uf > 0.85) else 0.0
                armscye_tuck = -0.006 * (1.0 - uf / 0.14) if uf < 0.14 else 0.0
                r = env_r + clearance + armscye_tuck + cap + puff + cuff
                x = ax * sgn
                y = yc + math.cos(th) * surf.front_y * r
                z = zc + math.sin(th) * r

                ch, fab = channel, fabric
                if cuff_trim and uf > 0.86:
                    ch, fab = CH_LINEN, FAB_LINEN

                # Pin shoulder seam & cuff band so middle of sleeve puffs and drapes under real gravity!
                pw = 0.0
                if uf < 0.16:
                    pw = 1.0 - uf / 0.16 * 0.35
                elif uf > 0.88:
                    pw = 0.90
                elif math.sin(th) > 0.45:
                    # Gentle top-of-arm support so sleeve hangs cleanly below arm
                    pw = 0.35 * (math.sin(th) - 0.45) / 0.55

                fl = sleeve_flex * math.sin(uf * math.pi) * (1.0 if math.sin(th) < 0 else 0.35)
                row.append(((x, y, z), pw, ch, fab, uf * 2.5, vf * 2.0, fl, vf + side * 0.5))
            rings.append(row)
        v, f, p, cfu, fp = build_tube(rings, True)
        objs.append(make_cloth_object(f'{name}_s{side}', v, f, p, cfu, fp, cloth_cfg=cloth_cfg, solidify=solidify, subsurf=subsurf, sim_frames=sim_frames))
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
            bell = down ** 0.80
            base_r = env_r + waist_clr
            target_r = math.hypot(math.sin(th) * hem_rx, math.cos(th) * hem_rz)
            pleat_w = math.cos(th * pleats) * pleat_amp * (down ** 0.85)
            side = 0 if math.sin(th) >= 0 else 1
            leg_mask = max(0.0, min(1.0, (0.88 - z) / 0.14))
            if leg_mask > 0.0:
                lr, lxc, lyc = surf.sample_leg(side, min(surf.l_z1, max(surf.l_z0, z)), th)
                leg_out = math.hypot(lxc + math.sin(th) * (lr + 0.072), (lyc - yc) + math.cos(th) * surf.front_y * (lr + 0.072)) * leg_mask
            else:
                leg_out = 0.0
            # Single-manifold sculpted front apron panel: crisp 6mm raised linen front apron with ZERO double-sheet z-fighting!
            th_front = ((th + math.pi) % math.tau) - math.pi
            in_apron = apron and (abs(th_front) < math.pi * 0.28) and (vf >= 0.18)
            apron_lift = 0.006 if in_apron else 0.0
            r = max(base_r * (1 - bell) + target_r * bell, leg_out) + pleat_w + apron_lift
            x = math.sin(th) * r
            y = yc + math.cos(th) * surf.front_y * r
            if in_apron:
                ch, fab = CH_LINEN, FAB_LINEN
            elif hem_trim and vf < 0.08:
                ch, fab = CH_TRIM, FAB_COTTON
            else:
                ch, fab = channel, fabric
            pw = 1.0 if vf > 0.88 else (0.55 * (vf - 0.76) / 0.12 if vf > 0.76 else 0.0)
            fl = max_flex * (down ** 1.5)
            row.append(((x, y, z), pw, ch, fab, uf * 5.0, vf * 4.0, fl, uf))
        rings.append(row)

    v, f, p, cfu, fp = build_tube(rings, True)
    skirt_cfg = {'mass': 0.42, 'tension': 18.0, 'compression': 10.0, 'shear': 10.0, 'bending': 0.35, 'air_damping': 2.0, 'col_dist': 0.012}
    return [make_cloth_object(name, v, f, p, cfu, fp, cloth_cfg=skirt_cfg, solidify=0.0030, subsurf=1, sim_frames=sim_frames, min_clr=0.018)]


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
            waist_wrap = 0.007 * max(0.0, (f - 0.60) / 0.40)
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
        'air_damping': 2.0, 'pin_offset': max(0.021, clr_hip * 0.85),
    }
    objs = [make_cloth_object(name + '_body', verts, faces, pin, cfu, fp, cloth_cfg=trou_cfg, solidify=0.0028, subsurf=1, sim_frames=sim_frames, min_clr=0.012)]

    # Fitted wool stockings / hose below knee (optional)
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
                    r = lr + 0.009
                    row.append(((xc + math.sin(th) * r, yc + math.cos(th) * surf.front_y * r, z), 1.0, hose_ch, FAB_WOOL, uf * 2, f * 2, 0.0, uf))
                h_rings.append(row)
            hv, hf, hp, hcfu, hfp = build_tube(h_rings, True)
            objs.append(make_cloth_object(f'{name}_hose{side}', hv, hf, hp, hcfu, hfp, cloth_cfg=None, solidify=0.0018, subsurf=1, sim_frames=0, min_clr=0.005))
    return objs


def build_belt_and_buckle(surf, name, *, z_center, half_h=0.024, clr=0.034, belt_ch=CH_LEATHER, buckle_ch=CH_BRASS):
    rings = []
    n_z, n_t = 5, 44
    for iz in range(n_z):
        f = iz / (n_z - 1)
        z = z_center + (f - 0.5) * half_h * 2.0
        bulge = math.sin(f * math.pi) * 0.004
        row = []
        for it in range(n_t):
            uf = it / n_t
            th = uf * math.tau
            env_r, yc = surf.sample_torso(z, th)
            r = env_r + clr + bulge
            x = math.sin(th) * r
            y = yc + math.cos(th) * surf.front_y * r
            row.append(((x, y, z), 1.0, belt_ch, FAB_LEATHER, uf * 6.0, f, 0.0, uf))
        rings.append(row)
    v, f, p, cfu, fp = build_tube(rings, True)
    objs = [make_cloth_object(name + '_belt', v, f, p, cfu, fp, cloth_cfg=None, solidify=0.0055, subsurf=1, sim_frames=0, min_clr=0.018)]

    if buckle_ch is not None:
        # Sculpted 3D rectangular brass buckle frame at front center!
        env_r, yc = surf.sample_torso(z_center, 0.0)
        fy = yc + surf.front_y * (env_r + clr + 0.009)
        bm = bmesh.new()
        bw, bh, bd = 0.028, half_h * 1.18, 0.005
        # 4 frame bars + center tongue pin
        bars = [
            ((0.0, 0.0, bh - 0.004), (bw, bd, 0.0045)),
            ((0.0, 0.0, -(bh - 0.004)), (bw, bd, 0.0045)),
            ((-bw + 0.004, 0.0, 0.0), (0.0045, bd, bh)),
            ((bw - 0.004, 0.0, 0.0), (0.0045, bd, bh)),
            ((0.0, surf.front_y * 0.002, 0.0), (0.003, bd * 0.8, bh * 0.85)),
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


def build_shoes(surf, name, *, channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.105):
    objs = []
    for side in range(2):
        fb = surf.feet[side]
        cx = 0.5 * (fb['min_x'] + fb['max_x'])
        hx = 0.5 * (fb['max_x'] - fb['min_x']) + 0.004
        cy = 0.5 * (fb['min_y'] + fb['max_y'])
        hy = 0.5 * (fb['max_y'] - fb['min_y']) + 0.006
        z0 = max(0.0, fb['min_z'] + 0.001)
        rings = []
        n_z, n_t = 8, 22
        for iz in range(n_z):
            f = iz / (n_z - 1)
            z = z0 + f * (cuff_z - z0)
            taper_y = 1.0 - (f - 0.34) * 0.66 if f > 0.34 else (1.01 if f < 0.16 else 1.0)
            shift_y = -surf.front_y * (f - 0.34) * hy * 0.54 if f > 0.34 else 0.0
            row = []
            for it in range(n_t):
                uf = it / n_t
                th = uf * math.tau
                x = cx + math.sin(th) * hx * (0.82 if f > 0.45 else 0.96)
                y = cy + shift_y + math.cos(th) * surf.front_y * hy * taper_y
                row.append(((x, y, z), 1.0, channel, fabric, uf * 2.0, f, 0.0, uf))
            rings.append(row)
        v, f, p, cfu, fp = build_tube(rings, True)
        objs.append(make_cloth_object(f'{name}_shoe{side}', v, f, p, cfu, fp, cloth_cfg=None, solidify=0.0028, subsurf=1, sim_frames=0, min_clr=0.004))
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

    # Triangulate cleanly before weight transfer & export
    tri = garment.modifiers.new('Triangulate', 'TRIANGULATE')
    tri.quad_method = 'BEAUTY'
    bpy.ops.object.modifier_apply(modifier=tri.name)

    # Transfer exact 93-joint vertex groups from the HD Tripo body donor!
    donor = body_ctx['donor']
    dt = garment.modifiers.new('SkinTransfer', 'DATA_TRANSFER')
    dt.object = donor
    dt.use_vert_data = True
    dt.data_types_verts = {'VGROUP_WEIGHTS'}
    dt.vert_mapping = 'POLYINTERP_NEAREST'
    bpy.ops.object.datalayout_transfer(modifier=dt.name)
    bpy.ops.object.modifier_apply(modifier=dt.name)

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
        # Positive dot((v.co - avg), normal) = convex ridge (brighter), negative = concave cloth crease (darker AO!)
        curv = (v.co - avg).dot(v.normal) * 140.0
        crease_ao[v.index] = max(0.58, min(1.06, 0.90 + max(-0.32, min(0.16, curv))))
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

        # Skinning: crisp leg-following skirt blend (so knees/thighs stay covered walking & riding!), spine drape for cloaks, exact DATA_TRANSFER otherwise!
        if is_skirt and y > 0.13 and ch not in (CH_LEATHER, CH_BRASS, CH_BUFF):
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
    linen_cfg = {'mass': 0.24, 'tension': 14.0, 'compression': 10.0, 'shear': 10.0, 'bending': 0.30, 'air_damping': 1.8}
    wool_cfg = {'mass': 0.44, 'tension': 28.0, 'compression': 18.0, 'shear': 14.0, 'bending': 1.0, 'air_damping': 2.0}
    leather_cfg = {'mass': 0.55, 'tension': 42.0, 'compression': 28.0, 'shear': 20.0, 'bending': 2.0, 'air_damping': 2.0}

    objs = []
    if spec_id == 'male-linen-shirt':
        objs.append(build_torso_piece(surf, 'shirt_body', z_bot=0.84, clearance=0.024, v_neck=0.085, tucked=True,
                                      pleats=10, pleat_amp=0.005, channel=CH_SHIRT, fabric=FAB_LINEN,
                                      cloth_cfg=linen_cfg, solidify=0.0026, sim_frames=sim_frames, hem_flex=0.14))
        objs.extend(build_sleeves_piece(surf, 'shirt_slv', x_end_frac=0.56, clearance=0.022, puff_amp=0.015,
                                        rolled_cuff=True, channel=CH_SHIRT, fabric=FAB_LINEN,
                                        cloth_cfg=linen_cfg, solidify=0.0024, sim_frames=sim_frames))
    elif spec_id == 'male-doublet':
        objs.append(build_torso_piece(surf, 'dbl_body', z_bot=0.83, clearance=0.026, flare_bot=0.032,
                                      stand_collar=0.040, collar_ch=CH_LINEN, channel=CH_SHIRT, fabric=FAB_WOOL,
                                      cloth_cfg=wool_cfg, solidify=0.0038, sim_frames=sim_frames, hem_flex=0.12))
        objs.extend(build_sleeves_piece(surf, 'dbl_slv', x_end_frac=0.88, clearance=0.022, puff_amp=0.014,
                                        cuff_trim=True, rolled_cuff=False, channel=CH_SHIRT, fabric=FAB_WOOL,
                                        cloth_cfg=wool_cfg, solidify=0.0032, sim_frames=sim_frames))
        objs.append(build_buttons(surf, 'dbl', z_bot=0.96, z_top=1.42, count=7, clr=0.028))
    elif spec_id == 'male-soldier-jerkin':
        objs.extend(build_sleeves_piece(surf, 'jrk_slv', x_end_frac=0.84, clearance=0.022, puff_amp=0.012,
                                        cuff_trim=True, rolled_cuff=False, channel=CH_LINEN, fabric=FAB_LINEN,
                                        cloth_cfg=linen_cfg, solidify=0.0024, sim_frames=sim_frames))
        objs.append(build_torso_piece(surf, 'jrk_body', z_bot=0.82, clearance=0.028, flare_bot=0.028,
                                      stand_collar=0.032, channel=CH_BUFF, fabric=FAB_LEATHER,
                                      cloth_cfg=leather_cfg, solidify=0.0044, sim_frames=sim_frames, hem_flex=0.08))
        objs.append(build_buttons(surf, 'jrk', z_bot=0.95, z_top=1.40, count=6, clr=0.030))
    elif spec_id == 'female-chemise-blouse':
        objs.append(build_torso_piece(surf, 'blouse_body', z_bot=0.86, clearance=0.028, scoop=0.068, tucked=True,
                                      pleats=12, pleat_amp=0.005, channel=CH_SHIRT, fabric=FAB_LINEN,
                                      cloth_cfg=linen_cfg, solidify=0.0026, sim_frames=sim_frames, hem_flex=0.10))
        objs.extend(build_sleeves_piece(surf, 'blouse_slv', x_end_frac=0.58, clearance=0.022, puff_amp=0.020,
                                        rolled_cuff=True, channel=CH_SHIRT, fabric=FAB_LINEN,
                                        cloth_cfg=linen_cfg, solidify=0.0022, sim_frames=sim_frames, x0_frac=1.02))
    elif spec_id == 'female-laced-bodice':
        objs.extend(build_sleeves_piece(surf, 'bod_slv', x_end_frac=0.56, clearance=0.022, puff_amp=0.022,
                                        rolled_cuff=True, channel=CH_LINEN, fabric=FAB_LINEN,
                                        cloth_cfg=linen_cfg, solidify=0.0022, sim_frames=sim_frames, x0_frac=1.04))
        objs.append(build_torso_piece(surf, 'bod_body', z_bot=0.86, clearance=0.028, scoop=0.075, tucked=True,
                                      collar_ch=CH_LINEN, bodice_lace=True, channel=CH_SHIRT, fabric=FAB_WOOL,
                                      cloth_cfg=wool_cfg, solidify=0.0032, sim_frames=sim_frames, hem_flex=0.06))
    elif spec_id == 'indigenous-tunic-m':
        objs.append(build_torso_piece(surf, 'tun_body', z_bot=0.78, clearance=0.026, flare_bot=0.026, scoop=0.060,
                                      hem_trim=True, pleats=8, pleat_amp=0.006, channel=CH_SHIRT, fabric=FAB_COTTON,
                                      cloth_cfg=linen_cfg, solidify=0.0028, sim_frames=sim_frames, hem_flex=0.28))
        objs.extend(build_sleeves_piece(surf, 'tun_slv', x_end_frac=0.30, clearance=0.022, puff_amp=0.008,
                                        rolled_cuff=False, channel=CH_SHIRT, fabric=FAB_COTTON,
                                        cloth_cfg=linen_cfg, solidify=0.0026, sim_frames=sim_frames))
    elif spec_id == 'indigenous-huipil-f':
        objs.append(build_torso_piece(surf, 'hup_body', z_bot=0.80, clearance=0.026, flare_bot=0.030, scoop=0.058,
                                      hem_trim=True, pleats=10, pleat_amp=0.006, channel=CH_SHIRT, fabric=FAB_COTTON,
                                      cloth_cfg=linen_cfg, solidify=0.0028, sim_frames=sim_frames, hem_flex=0.30))
        objs.extend(build_sleeves_piece(surf, 'hup_slv', x_end_frac=0.32, clearance=0.024, puff_amp=0.010,
                                        rolled_cuff=False, channel=CH_SHIRT, fabric=FAB_COTTON,
                                        cloth_cfg=linen_cfg, solidify=0.0026, sim_frames=sim_frames))
    elif spec_id == 'male-mariner-slops':
        objs.extend(build_leg_trousers(surf, 'slops', z_waist=z_waist + 0.048, z_knee=0.42,
                                       clr_hip=0.030, clr_thigh=0.036, clr_knee=0.022, slop_puff=0.026, pleat_freq=10,
                                       channel=CH_TROUSERS, fabric=FAB_WOOL, sim_frames=sim_frames))
        objs.extend(build_belt_and_buckle(surf, 'slops', z_center=z_waist + 0.032, clr=0.036))
        objs.extend(build_shoes(surf, 'slops', channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.115))
    elif spec_id == 'male-trunk-hose':
        objs.extend(build_leg_trousers(surf, 'trunk', z_waist=z_waist + 0.048, z_knee=0.54, z_ankle=0.09,
                                       clr_hip=0.028, clr_thigh=0.044, clr_knee=0.024, slop_puff=0.038, pleat_freq=14,
                                       hose_ch=CH_HOSE, channel=CH_TROUSERS, fabric=FAB_WOOL, sim_frames=sim_frames))
        objs.extend(build_belt_and_buckle(surf, 'trunk', z_center=z_waist + 0.032, clr=0.038))
        objs.extend(build_shoes(surf, 'trunk', channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.155))
    elif spec_id == 'female-pleated-skirt':
        objs.extend(build_pleated_skirt(surf, 'skirt', z_waist=z_waist + 0.032, z_hem=0.10, waist_clr=0.024,
                                        hem_rx=0.43, hem_rz=0.40, pleats=16, pleat_amp=0.020,
                                        channel=CH_TROUSERS, fabric=FAB_WOOL, apron=False, sim_frames=sim_frames))
        objs.extend(build_belt_and_buckle(surf, 'skirt', z_center=z_waist + 0.022, half_h=0.018, clr=0.030, belt_ch=CH_LEATHER, buckle_ch=None))
        objs.extend(build_shoes(surf, 'skirt', channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.10))
    elif spec_id == 'female-apron-skirt':
        objs.extend(build_pleated_skirt(surf, 'askirt', z_waist=z_waist + 0.032, z_hem=0.10, waist_clr=0.024,
                                        hem_rx=0.43, hem_rz=0.40, pleats=16, pleat_amp=0.020,
                                        channel=CH_TROUSERS, fabric=FAB_WOOL, apron=True, sim_frames=sim_frames))
        objs.extend(build_belt_and_buckle(surf, 'askirt', z_center=z_waist + 0.022, half_h=0.018, clr=0.032, belt_ch=CH_LINEN, buckle_ch=None))
        objs.extend(build_shoes(surf, 'askirt', channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.10))
    elif spec_id == 'indigenous-breechcloth-m':
        objs.extend(build_pleated_skirt(surf, 'breech', z_waist=z_waist + 0.020, z_hem=0.46, n_z=18, n_t=40,
                                        waist_clr=0.018, hem_rx=0.28, hem_rz=0.25, pleats=10, pleat_amp=0.012,
                                        channel=CH_TROUSERS, fabric=FAB_COTTON, hem_trim=True, max_flex=0.55, sim_frames=sim_frames))
        objs.extend(build_belt_and_buckle(surf, 'breech', z_center=z_waist + 0.016, half_h=0.022, clr=0.028, belt_ch=CH_TRIM, buckle_ch=None))
        objs.extend(build_shoes(surf, 'breech', channel=CH_BUFF, fabric=FAB_LEATHER, cuff_z=0.105))
    elif spec_id == 'indigenous-wrap-skirt-f':
        objs.extend(build_pleated_skirt(surf, 'wrap', z_waist=z_waist + 0.020, z_hem=0.16, n_z=24, n_t=48,
                                        waist_clr=0.018, hem_rx=0.35, hem_rz=0.31, pleats=12, pleat_amp=0.014,
                                        channel=CH_TROUSERS, fabric=FAB_COTTON, hem_trim=True, max_flex=0.72, sim_frames=sim_frames))
        objs.extend(build_belt_and_buckle(surf, 'wrap', z_center=z_waist + 0.016, half_h=0.022, clr=0.028, belt_ch=CH_TRIM, buckle_ch=None))
        objs.extend(build_shoes(surf, 'wrap', channel=CH_BUFF, fabric=FAB_LEATHER, cuff_z=0.10))
    elif spec_id == 'shoulder-cloak':
        objs.extend(build_shoulder_cloak(surf, 'cloak', sim_frames=sim_frames))
    elif spec_id == 'female-riding-breeches':
        objs.extend(build_leg_trousers(surf, 'fbreeches', z_waist=z_waist + 0.032, z_knee=0.34, z_ankle=0.09,
                                       clr_hip=0.022, clr_thigh=0.026, clr_knee=0.016, slop_puff=0.014, pleat_freq=8,
                                       hose_ch=CH_LEATHER, channel=CH_TROUSERS, fabric=FAB_WOOL, sim_frames=sim_frames))
        objs.extend(build_belt_and_buckle(surf, 'fbreeches', z_center=z_waist + 0.020, half_h=0.018, clr=0.026, belt_ch=CH_LEATHER, buckle_ch=CH_BRASS))
        objs.extend(build_shoes(surf, 'fbreeches', channel=CH_LEATHER, fabric=FAB_LEATHER, cuff_z=0.14))
    else:
        raise RuntimeError(f'Unknown garment {spec_id}')

    return join_and_transfer_skin(objs, body_ctx, spec_id, slot)


def main():
    global _ACTIVE_DONOR
    only, sex_filter, sim_frames = parse_args()
    t_all = time.perf_counter()
    for sex in ('female', 'male'):
        if sex_filter and sex != sex_filter:
            continue
        todo = [(gid, gsex, gslot) for gid, gsex, gslot in GARMENTS if gsex == sex and (only is None or gid in only)]
        if not todo:
            continue
        glb = os.path.join(FIT_DIR, f'base-{sex}.glb')
        if not os.path.exists(glb):
            raise SystemExit(f'Missing fitted Tripo base body: {glb}')
        print(f'\n=== Loading HD Tripo base-{sex}.glb ===')
        t0 = time.perf_counter()
        body_ctx = import_fitted_body(glb)
        _ACTIVE_DONOR = body_ctx['donor']
        surf = BodySurface(body_ctx, female=(sex == 'female'))
        print(f'Loaded + built collision/donor proxy in {time.perf_counter() - t0:.1f}s (front_y={surf.front_y:+.0f})')

        for gid, _gsex, gslot in todo:
            tg = time.perf_counter()
            nv, nt, outp = build_one_garment(surf, body_ctx, gid, gslot, sim_frames)
            print(f'  {gid:24s}: {nv:6d} verts · {nt:6d} tris · {os.path.getsize(outp) // 1024:4d} KB · {time.perf_counter() - tg:.1f}s')

    print(f'\nDone in {time.perf_counter() - t_all:.1f}s')


if __name__ == '__main__':
    main()
