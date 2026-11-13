#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Binds a rigged generated character to the game's sailor skeleton, keeping that skeleton and its clips.

Each vertex is carried from its rest pose into ours by its own skin weights, bone by bone, so the new
body fits our joints exactly and every clip and IK target keeps working. The texture is baked to vertex
colours, because the crew loader has no textures, and split into clothes so each sailor can wear their own.
Then run scripts/bake-crew-levels.mjs on the result.

  python scripts/fit-crew-body.py rigged.glb assets/crew/sailor-classic.glb assets/crew/sailor.glb

Needs numpy and Pillow.
"""
import io, json, struct, sys
import numpy as np
from PIL import Image

def read(path):
    data = open(path, 'rb').read()
    n = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + n])
    start = 20 + n + 8
    return doc, data[start:start + doc['buffers'][0]['byteLength']]

TYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
SIZES = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
def accessor(doc, bin_, index):
    a = doc['accessors'][index]; v = doc['bufferViews'][a['bufferView']]; t = TYPES[a['componentType']]; size = SIZES[a['type']]
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0); stride = v.get('byteStride') or size * t().itemsize
    raw = np.frombuffer(bin_, dtype=np.uint8, count=stride * a['count'], offset=start)
    out = np.zeros((a['count'], size), dtype=t)
    for k in range(size): out[:, k] = np.frombuffer(raw[k * t().itemsize:].tobytes(), dtype=t, count=a['count'], offset=0) if stride == size * t().itemsize and False else np.ndarray((a['count'],), dtype=t, buffer=raw.tobytes(), offset=k * t().itemsize, strides=(stride,))
    if a.get('normalized') and t is not np.float32: out = out.astype(np.float32) / np.iinfo(t).max
    return out

def local_matrix(n):
    if 'matrix' in n: return np.array(n['matrix'], dtype=np.float64).reshape(4, 4).T
    x, y, z, w = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1]); t = n.get('translation', [0, 0, 0])
    r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    m = np.eye(4); m[:3, :3] = r * np.array(s); m[:3, 3] = t
    return m
def world_matrices(doc):
    parent = {}
    for i, n in enumerate(doc['nodes']):
        for c in n.get('children', []): parent[c] = i
    cache = {}
    def world(i):
        if i not in cache: cache[i] = (world(parent[i]) if i in parent else np.eye(4)) @ local_matrix(doc['nodes'][i])
        return cache[i]
    return [world(i) for i in range(len(doc['nodes']))], parent

def rotation_between(a, b):
    a = a / max(np.linalg.norm(a), 1e-9); b = b / max(np.linalg.norm(b), 1e-9)
    v = np.cross(a, b); c = float(a @ b)
    if c < -0.9999:
        axis = np.cross(a, [1, 0, 0]);
        if np.linalg.norm(axis) < 1e-3: axis = np.cross(a, [0, 1, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k / (1 + c)

args = [a for a in sys.argv[1:] if not a.startswith('--')]
textured = '--textured' in sys.argv
bald = (not textured) and ('--keep-hair' not in sys.argv)
source_path, target_path, out_path = args[:3]
is_female = 'female' in target_path.lower() or 'woman' in source_path.lower()
src, src_bin = read(source_path); dst, dst_bin = read(target_path)
print('source nodes with mesh:', sum('mesh' in n for n in src['nodes']), 'skins', len(src.get('skins', [])))
skin = src['skins'][0]; src_names = [src['nodes'][j].get('name', f'j{j}') for j in skin['joints']]
print('source joints', len(src_names), src_names[:70])
dst_skin = dst['skins'][0]; dst_names = [dst['nodes'][j]['name'] for j in dst_skin['joints']]
src_ibm = accessor(src, src_bin, skin['inverseBindMatrices']).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
dst_ibm = accessor(dst, dst_bin, dst_skin['inverseBindMatrices']).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
src_world = np.linalg.inv(src_ibm); dst_world = np.linalg.inv(dst_ibm)

# Names map straight across where they match; otherwise by the common aliases, then to the nearest kept ancestor.
ALIASES = {'hips': 'pelvis', 'spine': 'spine_01', 'chest': 'spine_02', 'upperchest': 'spine_03', 'neck': 'neck_01', 'head': 'Head'}
def clean(name):
    return name.split(':')[-1].replace('mixamorig', '')
dst_index = {n: i for i, n in enumerate(dst_names)}; dst_lower = {n.lower(): i for i, n in enumerate(dst_names)}
node_parent = {c: i for i, n in enumerate(src['nodes']) for c in n.get('children', [])}
joint_of_node = {j: i for i, j in enumerate(skin['joints'])}
mapping = {}
for i, name in enumerate(src_names):
    c = clean(name); key = ALIASES.get(c.lower(), c).lower()
    if key in dst_lower: mapping[i] = dst_lower[key]
unmapped = [src_names[i] for i in range(len(src_names)) if i not in mapping]
print('mapped', len(mapping), 'of', len(src_names), 'unmapped', unmapped[:40])
for i in range(len(src_names)):
    if i in mapping: continue
    node = skin['joints'][i]
    while node in node_parent:
        node = node_parent[node]
        if node in joint_of_node and joint_of_node[node] in mapping:
            mapping[i] = mapping[joint_of_node[node]]; break
    if i not in mapping: mapping[i] = dst_index['pelvis']

# Mesh, in Tripo's own world frame (its bind space).
node_worlds, _ = world_matrices(src)
positions = []; normals = []; uvs = []; joints = []; weights = []; indices = []; offset = 0; image = None
for ni, n in enumerate(src['nodes']):
    if 'mesh' not in n: continue
    for p in src['meshes'][n['mesh']]['primitives']:
        a = p['attributes']
        positions.append(accessor(src, src_bin, a['POSITION']).astype(np.float64))
        normals.append(accessor(src, src_bin, a['NORMAL']).astype(np.float64))
        uvs.append(accessor(src, src_bin, a['TEXCOORD_0']).astype(np.float64))
        joints.append(accessor(src, src_bin, a['JOINTS_0']).astype(np.int64))
        weights.append(accessor(src, src_bin, a['WEIGHTS_0']).astype(np.float64))
        indices.append(accessor(src, src_bin, p['indices']).astype(np.int64).ravel() + offset)
        offset += len(positions[-1])
        material = src['materials'][p['material']]
        texture = material.get('pbrMetallicRoughness', {}).get('baseColorTexture')
        if texture and image is None:
            view = src['bufferViews'][src['images'][src['textures'][texture['index']]['source']]['bufferView']]
            raw_image = src_bin[view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']]
            image = Image.open(io.BytesIO(raw_image)).convert('RGB')
P = np.concatenate(positions); N = np.concatenate(normals); UV = np.concatenate(uvs); J = np.concatenate(joints); W = np.concatenate(weights); I = np.concatenate(indices)
W = W / np.maximum(W.sum(axis=1, keepdims=True), 1e-9)
print('vertices', len(P), 'triangles', len(I) // 3, 'bounds', P.min(0).round(3), P.max(0).round(3), 'image', image.size if image else None)

# ---- fitting ----------------------------------------------------------------------------------
sname = {clean(n).lower(): i for i, n in enumerate(src_names)}
s_pos = lambda n: src_world[sname[n.lower()]][:3, 3]
d_pos = lambda n: dst_world[dst_index[n]][:3, 3]
# Turn the whole body first: bones only say which way they point, not which way the chest faces.
def yaw_between(a, b):
    a = a * [1, 0, 1]; b = b * [1, 0, 1]
    return rotation_between(a, b)
R0 = yaw_between(s_pos('upperarm_l') - s_pos('upperarm_r'), d_pos('upperarm_l') - d_pos('upperarm_r'))
# Same stature: top of mesh to the floor, against our own sailor's measured height.
src_height = float(P[:, 1].max() - P[:, 1].min())
body_node = next(i for i, n in enumerate(dst['nodes']) if n.get('name', '').lower().startswith('superhero_'))
dst_body = dst['nodes'][body_node]['mesh']
old = accessor(dst, dst_bin, dst['meshes'][dst_body]['primitives'][0]['attributes']['POSITION'])
our_height = float(old[:, 1].max() - old[:, 1].min()); S = our_height / src_height
print('turned', np.round(R0 @ np.array([1, 0, 0]), 2), 'our height', round(our_height, 3), 'scale', round(S, 3))
toes = (R0 @ (s_pos('ball_l') - s_pos('foot_l')))[[0, 2]]; our_toes = (d_pos('ball_l') - d_pos('foot_l'))[[0, 2]]
print('facing the same way:', float(toes @ our_toes) > 0)

# Where each of Tripo's joints lands: along the matching stretch of our chain, by share of its length.
target = {}
def chain(src_chain, landmarks):
    """src_chain: Tripo joints in order. landmarks: {tripo joint: our joint}, including both ends."""
    names = [n.lower() for n in src_chain]; marks = [i for i, n in enumerate(names) if n in landmarks]
    for lo, hi in zip(marks, marks[1:]):
        lengths = [np.linalg.norm(s_pos(names[i + 1]) - s_pos(names[i])) for i in range(lo, hi)]
        total = sum(lengths) or 1; along = 0
        a = d_pos(landmarks[names[lo]]); b = d_pos(landmarks[names[hi]])
        for i in range(lo, hi + 1):
            target[names[i]] = a + (b - a) * (along / total)
            if i < hi: along += lengths[i - lo]
chain(['pelvis', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05', 'neck_01', 'neck_02', 'head'], {'pelvis': 'pelvis', 'neck_01': 'neck_01', 'head': 'Head'})
BONE_NEXT = {}
def link(names):
    for a, b in zip(names, names[1:]): BONE_NEXT[a.lower()] = b.lower()
link(['pelvis', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05', 'neck_01', 'neck_02', 'head'])
for side in ('_l', '_r'):
    arm = [n + side for n in ('clavicle', 'upperarm', 'upperarm_twist_01', 'upperarm_twist_02', 'lowerarm', 'lowerarm_twist_01', 'lowerarm_twist_02', 'hand')]
    arm = [n for n in arm if n.lower() in sname]
    # Twist joints sit along the limb in whatever order they were named: sort them by distance.
    upper = sorted([n for n in arm if 'upperarm' in n], key=lambda n: np.linalg.norm(s_pos(n) - s_pos('upperarm' + side)))
    lower = sorted([n for n in arm if 'lowerarm' in n], key=lambda n: np.linalg.norm(s_pos(n) - s_pos('lowerarm' + side)))
    arm = ['clavicle' + side] + upper + lower + ['hand' + side]
    chain(arm, {n + side: n + side for n in ('clavicle', 'upperarm', 'lowerarm', 'hand')}); link(arm)
    thigh = sorted([n for n in sname if n.startswith('thigh') and n.endswith(side)], key=lambda n: np.linalg.norm(s_pos(n) - s_pos('thigh' + side)))
    calf = sorted([n for n in sname if n.startswith('calf') and n.endswith(side)], key=lambda n: np.linalg.norm(s_pos(n) - s_pos('calf' + side)))
    leg = thigh + calf + ['foot' + side, 'ball' + side]
    chain(leg, {n + side: n + side for n in ('thigh', 'calf', 'foot', 'ball')}); link(leg)
    for finger in ('index', 'middle', 'ring', 'pinky', 'thumb'):
        joints = [f'{finger}_0{k}{side}' for k in (1, 2, 3)]
        if all(j in sname for j in joints):
            chain(joints, {j: j for j in joints}); link(joints)
            meta = f'{finger}_metacarpal{side}'
            if meta in sname: target[meta] = target[joints[0]] + S * (R0 @ (s_pos(meta) - s_pos(joints[0])))

# Each Tripo bone: from its rest into ours. Thickness scales with the body; only length follows the bone.
def bone_transform(n):
    if n not in target: return None
    a = R0 @ s_pos(n) * S
    nxt = BONE_NEXT.get(n)
    R = np.eye(3); stretch = 1.0; axis = np.array([0, 1, 0.])
    if nxt and nxt in target:
        from_dir = R0 @ (s_pos(nxt) - s_pos(n)) * S; to_dir = target[nxt] - target[n]
        R = rotation_between(from_dir, to_dir); stretch = np.linalg.norm(to_dir) / max(np.linalg.norm(from_dir), 1e-9)
        axis = from_dir / max(np.linalg.norm(from_dir), 1e-9)
    return a, target[n], R, stretch, axis
bones = {}
for n in sname:
    t = bone_transform(n)
    if t: bones[n] = t
# Leaves of a chain (hand, head, finger tips, toes) turn with the bone before them, so they stay attached,
# except 'head', which stays upright so neck forward slant never pitches the skull/face toward the deck.
before = {b: a for a, b in BONE_NEXT.items()}
for n in list(bones):
    if n not in BONE_NEXT and n in before and before[n] in bones:
        a, t, _, _, axis = bones[n]
        leaf_R = np.eye(3) if n == 'head' else bones[before[n]][2]
        bones[n] = (a, t, leaf_R, 1.0, axis)
hand_of = lambda n: n.replace('metacarpal', 'hand')
for side in ('_l', '_r'):
    for n in [k for k in sname if k.endswith(side) and 'metacarpal' in k]:
        a = R0 @ s_pos(n) * S; h = bones['hand' + side]
        bones[n] = (a, h[1] + h[2] @ (a - h[0]), h[2], 1.0, h[4])
print('bones placed', len(bones), 'of', len(sname), 'stretch', {k: round(float(v[3]), 2) for k, v in bones.items() if k in ('spine_01', 'upperarm_l', 'lowerarm_l', 'thigh_l', 'calf_l', 'neck_01')})

# Which of our joints each Tripo joint's weight goes to.
def our_joint(n):
    if n in dst_lower: return dst_lower[n]
    if n.startswith('spine_'):
        p = target[n]; spine = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01']
        best = 'spine_03'
        for s in spine[:-1]:
            if d_pos(s)[1] <= p[1]: best = s
        return dst_index[best]
    if n.startswith('neck'): return dst_index['neck_01']
    if 'metacarpal' in n: return dst_index['hand' + n[-2:]]
    if 'twist' in n: return dst_index[n.split('_twist')[0] + n[-2:]]
    if n == 'head': return dst_index['Head']
    return None
to_ours = {}
for i, name in enumerate(src_names):
    k = our_joint(clean(name).lower()); to_ours[i] = k
print('joints with no home in ours:', [src_names[i] for i, k in to_ours.items() if k is None])

P0 = P @ R0.T * S; N0 = N @ R0.T
out_p = np.zeros_like(P); out_n = np.zeros_like(N); out_j = np.zeros_like(J); out_w = np.zeros_like(W)
pelvis = bones['pelvis']
for v in range(len(P)):
    merged = {}
    for k in range(4):
        w = W[v, k]
        if w <= 0: continue
        i = int(J[v, k]); n = clean(src_names[i]).lower(); a, t, R, stretch, axis = bones.get(n, pelvis)
        rel = P0[v] - a
        along = rel @ axis
        moved = t + R @ (rel + axis * along * (stretch - 1))
        out_p[v] += w * moved; out_n[v] += w * (R @ N0[v])
        d = to_ours[i] if to_ours[i] is not None else dst_index['pelvis']
        merged[d] = merged.get(d, 0) + w
    top = sorted(merged.items(), key=lambda kv: -kv[1])[:4]; total = sum(w for _, w in top)
    for k, (d, w) in enumerate(top): out_j[v, k] = d; out_w[v, k] = w / total
out_n /= np.maximum(np.linalg.norm(out_n, axis=1, keepdims=True), 1e-9)
print('fitted bounds', out_p.min(0).round(3), out_p.max(0).round(3), 'ours were', old.min(0).round(3), old.max(0).round(3))

# ---- hinges -----------------------------------------------------------------------------------
# A generated rig's elbow and knee can sit several centimetres from the bend it painted. Where the limb
# meets our joint the weight passes from one bone to the next, so it bends where our poses expect.
HINGE_REACH = .06
for side in ('_l', '_r'):
    for upper, lower in ((f'upperarm{side}', f'lowerarm{side}'), (f'thigh{side}', f'calf{side}')):
        a, b = dst_index[upper], dst_index[lower]
        joint = d_pos(lower); axis = joint - d_pos(upper); axis = axis / np.linalg.norm(axis)
        along = (out_p - joint) @ axis
        t = np.clip((along + HINGE_REACH) / (2 * HINGE_REACH), 0, 1); t = t * t * (3 - 2 * t)
        for v in np.nonzero(((out_j == a) | (out_j == b)).any(axis=1) & (out_w.sum(axis=1) > 0))[0]:
            on = (out_w[v] > 0)
            held = out_w[v][on & ((out_j[v] == a) | (out_j[v] == b))].sum()
            if held <= 0: continue
            weights_ = {int(j): float(w) for j, w in zip(out_j[v], out_w[v]) if w > 0 and j not in (a, b)}
            weights_[a] = held * (1 - t[v]); weights_[b] = held * t[v]
            top = sorted(weights_.items(), key=lambda kv: -kv[1])[:4]; total = sum(w for _, w in top)
            out_j[v] = 0; out_w[v] = 0
            for k, (j, w) in enumerate(top): out_j[v, k] = j; out_w[v, k] = w / total

# ---- thickness --------------------------------------------------------------------------------
# Work poses were tuned on the classic body, so a sleeve or breech leg that billows past it goes through
# a gun. Limbs are drawn in toward their bones to the classic thickness; joints and lengths stay.
LIMBS = {f'{a}{side}': f'{b}{side}' for side in ('_l', '_r') for a, b in (('upperarm', 'lowerarm'), ('lowerarm', 'hand'), ('thigh', 'calf'), ('calf', 'foot'))}
def radii(points, joints, weights, bone, nxt):
    a = d_pos(bone); d = d_pos(nxt) - a; d = d / np.linalg.norm(d)
    rel = points - a; radial = rel - np.outer(rel @ d, d)
    return radial
def classic_mesh():
    pts = []; js = []; ws = []
    for n in dst['nodes']:
        if 'mesh' not in n: continue
        for prim_ in dst['meshes'][n['mesh']]['primitives']:
            a_ = prim_['attributes']
            pts.append(accessor(dst, dst_bin, a_['POSITION']).astype(np.float64)); js.append(accessor(dst, dst_bin, a_['JOINTS_0']).astype(np.int64)); ws.append(accessor(dst, dst_bin, a_['WEIGHTS_0']).astype(np.float64))
    return np.concatenate(pts), np.concatenate(js), np.concatenate(ws)
old_p, old_j, old_w = classic_mesh()
def dominant(joints, weights): return joints[np.arange(len(joints)), weights.argmax(1)]
old_top = dominant(old_j, old_w)
for bone, nxt in LIMBS.items():
    index = dst_index[bone]
    allowed = np.percentile(np.linalg.norm(radii(old_p[old_top == index], None, None, bone, nxt), axis=1), 95)
    radial = radii(out_p, None, None, bone, nxt)
    mine = np.percentile(np.linalg.norm(radial[dominant(out_j, out_w) == index], axis=1), 95)
    if mine <= allowed: continue
    influence = (out_w * (out_j == index)).sum(axis=1, keepdims=True)
    out_p += radial * (allowed / mine - 1) * influence
    print(f'{bone}: {mine:.3f} drawn in to {allowed:.3f}')

# Scale radial hand & finger thickness to match the mended classic finger lengths (0.78x male, 0.84x female),
# tapering smoothly across the distal wrist so forearms blend cleanly into natural human-proportioned hands.
hand_radial_scale = 0.84 if is_female else 0.78
for side in ('_l', '_r'):
    hand_slot = dst_index['hand' + side]
    low_slot = dst_index['lowerarm' + side]
    elbow_p = d_pos('lowerarm' + side); wrist_p = d_pos('hand' + side)
    arm_d = wrist_p - elbow_p; arm_len = np.linalg.norm(arm_d); arm_u = arm_d / max(arm_len, 1e-9)
    t_arm = np.clip(((out_p - elbow_p) @ arm_u) / max(arm_len, 1e-9), 0.0, 1.2)
    tw = np.clip((t_arm - 0.76) / 0.24, 0.0, 1.0); wrist_ramp = tw * tw * (3.0 - 2.0 * tw)
    palm_d = d_pos('middle_01' + side) - wrist_p; palm_u = palm_d / max(np.linalg.norm(palm_d), 1e-9)
    rel_palm = out_p - wrist_p
    rad_palm = rel_palm - np.outer(rel_palm @ palm_u, palm_u)
    w_palm = (out_w * (out_j == hand_slot)).sum(axis=1) + (out_w * (out_j == low_slot)).sum(axis=1) * wrist_ramp
    out_p += rad_palm * ((hand_radial_scale - 1.0) * w_palm)[:, None]
    for finger in ('thumb', 'index', 'middle', 'ring', 'pinky'):
        for k in (1, 2, 3):
            fn = f'{finger}_0{k}{side}'
            if fn not in dst_index: continue
            fslot = dst_index[fn]
            w_f = (out_w * (out_j == fslot)).sum(axis=1)
            if not np.any(w_f > 1e-4): continue
            fa = d_pos(fn)
            fd = (d_pos(f'{finger}_0{k+1}{side}') - fa) if k < 3 else (fa - d_pos(f'{finger}_02{side}'))
            fu = fd / max(np.linalg.norm(fd), 1e-9)
            rel_f = out_p - fa
            rad_f = rel_f - np.outer(rel_f @ fu, fu)
            out_p += rad_f * ((hand_radial_scale - 1.0) * w_f)[:, None]
# Soles rest where the classic ones do, so clips that plant feet stay on the deck.
SOLE_REACH = .12
# A longer foot rocks lower through a stride than the classic one did.
SOLE_LIFT = .006
sink = max(0.0, float(old_p[:, 1].min() + SOLE_LIFT - out_p[:, 1].min()))
if sink: out_p[:, 1] += sink * np.clip(1 - (out_p[:, 1] - out_p[:, 1].min()) / SOLE_REACH, 0, 1)

# Texture to vertex colours, in linear light as the loader expects.
pixels = np.asarray(image, dtype=np.float32) / 255; h, w_ = pixels.shape[:2]
xs = np.clip((UV[:, 0] % 1) * (w_ - 1), 0, w_ - 1).astype(int); ys = np.clip((UV[:, 1] % 1) * (h - 1), 0, h - 1).astype(int)
srgb = pixels[ys, xs]
colors = np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4).astype(np.float32)

# ---- clothes ----------------------------------------------------------------------------------
# Which garment each point is, from its painted colour and where it stands in the rest pose. Each stores
# how far it departs from its garment's typical colour, with the garment's number in blue's whole part, and
# the shader multiplies that by what this person wears. See crewClothed in js/wgsl/crew.js.
SHIRT, TROUSERS, SKIN, HAIR = 1, 2, 3, 4
HEAD_Y, COLLAR_Y, WAIST_Y, CUFF_Y, SHOULDER_Y = d_pos('neck_01')[1], d_pos('neck_01')[1] + .08, d_pos('spine_01')[1] + .03, .35, d_pos('spine_03')[1]
# Hair below the neck is a ponytail: nothing on a shirt is nearly black up there.
TAIL = .02
GRIME = .035
# Dark warm breeches share skin's hue, and only its brightness tells them apart. Same for shirt folds.
BARE, CHEST = .12, .08
lum = colors @ np.array([.2126, .7152, .0722], dtype=np.float32)
warmth = colors[:, 0] / np.maximum(colors[:, 1], 1e-4)
skin_hue = (warmth > 1.75) & (lum > GRIME)
pale = (warmth < 1.45) & (lum > GRIME)
y = out_p[:, 1]
regions = np.zeros(len(colors), dtype=np.int64)
head = y >= HEAD_Y; torso = (y >= WAIST_Y) & ~head; thighs = (y >= CUFF_Y) & (y < WAIST_Y); shins = y < CUFF_Y
regions[head] = SKIN
regions[head & (lum <= GRIME)] = HAIR
regions[head & pale & (y < COLLAR_Y)] = SHIRT
regions[head & pale & (y >= COLLAR_Y)] = 0  # the whites of the eyes keep their paint
regions[torso] = SHIRT
regions[torso & skin_hue & (lum > CHEST)] = SKIN
regions[torso & (lum < TAIL) & (y > SHOULDER_Y)] = HAIR
regions[thighs] = TROUSERS
regions[thighs & skin_hue & (lum > BARE)] = SKIN
regions[thighs & pale & (lum > .1)] = SHIRT
regions[shins & skin_hue & (lum > BARE)] = SKIN
regions[shins & ~skin_hue & (y > .15)] = TROUSERS
print('regions', {name: int((regions == k).sum()) for name, k in (('paint', 0), ('shirt', SHIRT), ('trousers', TROUSERS), ('skin', SKIN), ('hair', HAIR))})

# ---- bald base scalp projection ---------------------------------------------------------------
# Base male & female models are authored bald so modular 3D hair and headwear components fit cleanly
# without Tripo's wide tricorn side-wings or hanging ponytail clipping through caps or collars.
# Front brow-ridge eyebrows stay HAIR (garment=4) so bald characters keep natural eyebrows.
if bald:
    head_p = d_pos('Head')
    head_slot = dst_index['Head']
    cran_c = np.array([0.0, head_p[1] + (0.068 if is_female else 0.064), head_p[2] + (0.006 if is_female else 0.008)], dtype=np.float64)
    cran_r = np.array([0.071, 0.091, 0.089] if is_female else [0.075, 0.096, 0.093], dtype=np.float64)
    eye_y = head_p[1] + (0.078 if is_female else 0.070)
    is_eyebrow = (
        (regions == HAIR)
        & (out_p[:, 2] > head_p[2] + 0.068)
        & (np.abs(out_p[:, 0]) < 0.056)
        & (out_p[:, 1] > eye_y - 0.020)
        & (out_p[:, 1] < eye_y + 0.028)
    )
    if int(is_eyebrow.sum()) < 6:
        hair_idx = np.nonzero(regions == HAIR)[0]
        if len(hair_idx):
            brow_score = (out_p[hair_idx, 2] - (head_p[2] + 0.085)) * 2.0 - np.abs(out_p[hair_idx, 1] - (eye_y + 0.008)) - np.abs(np.abs(out_p[hair_idx, 0]) - 0.026)
            is_eyebrow[hair_idx[np.argsort(-brow_score)[:16]]] = True

    rel_c = (out_p - cran_c) / cran_r
    rho = np.linalg.norm(rel_c, axis=1)
    in_lower_front_face = (out_p[:, 2] > head_p[2] + 0.032) & (out_p[:, 1] < cran_c[1] + 0.042) & (np.abs(out_p[:, 0]) < 0.068)
    protruding_head = (out_p[:, 1] > head_p[1] - 0.015) & (regions != 0) & (~in_lower_front_face) & (~is_eyebrow) & (rho > 1.015)
    hair_scalp = (regions == HAIR) & (~is_eyebrow)

    # Weld 3D positions BEFORE scalp projection so coincident UV-seam corners at the hairline never tear apart!
    tris0 = I.reshape(-1, 3)
    pos_keys0 = np.round(out_p * 1e4).astype(np.int64)
    _, weld_first, weld_inv = np.unique(pos_keys0, axis=0, return_index=True, return_inverse=True)
    weld_inv = weld_inv.ravel()
    weld_p = out_p[weld_first].copy()
    hair_w_mask = np.zeros(len(weld_p), dtype=bool)
    hair_w_mask[weld_inv[hair_scalp]] = True
    sc_w_mask = hair_w_mask.copy()
    sc_w_mask[weld_inv[protruding_head]] = True
    # Keep eyebrow 3D positions strictly excluded from scalp projection.
    sc_w_mask[weld_inv[is_eyebrow]] = False
    is_scalp = sc_w_mask[weld_inv]
    sc_idx = np.nonzero(is_scalp)[0]
    sc_w_idx = np.nonzero(sc_w_mask)[0]

    # Tuck any low-hanging ponytail / nape locks smoothly up onto the occipital skull base before ellipsoid projection.
    nape_floor = cran_c[1] - 0.072
    low_w = sc_w_mask & (weld_p[:, 1] < nape_floor)
    if np.any(low_w):
        weld_p[low_w, 1] = nape_floor - 0.010 * np.tanh((nape_floor - weld_p[low_w, 1]) / 0.045)
        weld_p[low_w, 0] *= 0.72

    # Project scalp vertices onto the smooth symmetric cranial dome.
    rho_w = np.linalg.norm((weld_p[sc_w_idx] - cran_c) / cran_r, axis=1)
    u_sc = (weld_p[sc_w_idx] - cran_c) / cran_r
    u_len = np.maximum(np.linalg.norm(u_sc, axis=1, keepdims=True), 1e-6)
    dome_pts = cran_c + (u_sc / u_len) * cran_r
    snap_w = np.where(hair_w_mask[sc_w_idx], 1.0, np.clip((rho_w - 1.0) / 0.12, 0.0, 1.0))[:, None]
    weld_p[sc_w_idx] = weld_p[sc_w_idx] * (1.0 - snap_w) + dome_pts * snap_w

    # Smooth across welded 3D positions so coincident UV-seam corners stay 100% locked together.
    tris_w = weld_inv[tris0]
    adj_sum = np.zeros_like(weld_p)
    adj_cnt = np.zeros((len(weld_p), 1), dtype=np.float64)
    for _pass in range(2):
        adj_sum.fill(0.0); adj_cnt.fill(0.0)
        for a_c, b_c in ((0, 1), (1, 2), (2, 0)):
            va, vb = tris_w[:, a_c], tris_w[:, b_c]
            np.add.at(adj_sum, va, weld_p[vb]); np.add.at(adj_cnt, va, 1.0)
            np.add.at(adj_sum, vb, weld_p[va]); np.add.at(adj_cnt, vb, 1.0)
        avg_p = adj_sum / np.maximum(adj_cnt, 1.0)
        weld_p[sc_w_idx] = 0.65 * weld_p[sc_w_idx] + 0.35 * avg_p[sc_w_idx]
        u_sc2 = (weld_p[sc_w_idx] - cran_c) / cran_r
        u_len2 = np.maximum(np.linalg.norm(u_sc2, axis=1, keepdims=True), 1e-6)
        dome2 = cran_c + (u_sc2 / u_len2) * cran_r
        crown_mask = (weld_p[sc_w_idx, 1] > cran_c[1] - 0.035) | (u_len2[:, 0] > 1.0)
        weld_p[sc_w_idx[crown_mask]] = dome2[crown_mask]
    out_p[sc_idx] = weld_p[weld_inv[sc_idx]]

    # Bind scalp vertices above neck cleanly to Head so former ponytail vertices never stretch toward the back/shoulders.
    bind_head_w = sc_w_mask & (weld_p[:, 1] > head_p[1] - 0.015)
    bind_head = np.nonzero(bind_head_w[weld_inv])[0]
    out_j[bind_head] = [head_slot, 0, 0, 0]
    out_w[bind_head] = [1.0, 0.0, 0.0, 0.0]

    # Recompute smooth vertex normals across scalp + 1-ring welded boundary so the bald dome lights evenly.
    touch_tris = sc_w_mask[tris_w].any(axis=1)
    touch_w = np.zeros(len(weld_p), dtype=bool)
    touch_w[np.unique(tris_w[touch_tris])] = True
    fn = np.cross(out_p[tris0[:, 1]] - out_p[tris0[:, 0]], out_p[tris0[:, 2]] - out_p[tris0[:, 0]])
    welded_n = np.zeros_like(weld_p)
    for k_c in range(3):
        np.add.at(welded_n, tris_w[:, k_c], fn)
    wn_len = np.maximum(np.linalg.norm(welded_n, axis=1, keepdims=True), 1e-9)
    welded_n /= wn_len
    touch_verts = np.nonzero(touch_w[weld_inv])[0]
    out_n[touch_verts] = welded_n[weld_inv[touch_verts]]

    # Re-tag bald scalp vertices as SKIN with clean cranial skin shading matching the face's median skin tone.
    face_skin = (regions == SKIN) & (out_p[:, 1] > head_p[1]) & (~is_scalp)
    typical_face = np.median(colors[face_skin if np.any(face_skin) else (regions == SKIN)], axis=0)
    dome_shade = (0.96 + 0.06 * np.clip(out_n[sc_idx, 1], -0.4, 1.0)).astype(np.float32)[:, None]
    colors[sc_idx] = typical_face[None, :] * dome_shade
    regions[sc_idx] = SKIN
    print(f'bald scalp projected: {len(sc_idx)} verts -> SKIN, {int(is_eyebrow.sum())} brow verts kept as HAIR')
shaded = colors.copy()
if textured:
    uv_mod = (UV % 1.0).astype(np.float32)
    shaded = np.column_stack([uv_mod[:, 0], uv_mod[:, 1], np.where(regions == SKIN, -11.0, -10.0).astype(np.float32)])
    keys = np.concatenate([np.round(out_p / 2e-4), np.round(out_n / .05), np.round(out_w / .02), out_j, np.round(uv_mod / 1e-4), (regions == SKIN)[:, None]], axis=1).astype(np.int64)
else:
    for k in (SHIRT, TROUSERS, SKIN, HAIR):
        at = regions == k
        typical = np.median(colors[at], axis=0)
        print(' typical', k, typical.round(3))
        shaded[at] = np.clip(colors[at] / np.maximum(typical, 1e-3), .05, 1.99)
        shaded[at, 2] += 2 * k
    # A texture seam splits corners that the body has no reason to split, and each costs a skinned vertex.
    keys = np.concatenate([np.round(out_p / 2e-4), np.round(out_n / .05), np.round(out_w / .02), out_j, regions[:, None]], axis=1).astype(np.int64)
_, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
inverse = inverse.ravel()
order = np.argsort(first); rank = np.zeros(len(first), dtype=np.int64); rank[order] = np.arange(len(first))
remap = rank[inverse]
tinted = np.zeros((len(first), 3), dtype=np.float64); hits = np.zeros(len(first))
np.add.at(tinted, remap, shaded); np.add.at(hits, remap, 1)
tinted = (tinted / hits[:, None]).astype(np.float32)
kept = first[order]
out_p, out_n, out_j, out_w, out_uv = out_p[kept], out_n[kept], out_j[kept], out_w[kept], (UV % 1.0)[kept].astype(np.float32)
faces = remap[I].reshape(-1, 3)
faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
I = faces.ravel()
print('vertices', len(hits), 'triangles', len(faces))

# ---- writing ----------------------------------------------------------------------------------
# Same skeleton, clips and joint order; one new mesh, and only the data those need.
chunks = []; cursor = 0; views = []; accessors = []
def add_bytes(b, target=None):
    global cursor
    pad = (4 - (cursor % 4)) % 4
    if pad: chunks.append(b'\0' * pad); cursor += pad
    views.append({'buffer': 0, 'byteOffset': cursor, 'byteLength': len(b), **({'target': target} if target else {})}); chunks.append(b); cursor += len(b)
    return len(views) - 1
def add(arr, target, kind, comp, extra=None):
    count = len(arr) if kind != 'SCALAR' else arr.size
    accessors.append({'bufferView': add_bytes(arr.tobytes(), target), 'componentType': comp, 'count': count, 'type': kind, **(extra or {})})
    return len(accessors) - 1
carried = {}
def carry(index):
    if index in carried: return carried[index]
    a = dict(dst['accessors'][index]); v = dst['bufferViews'][a['bufferView']]
    start = v.get('byteOffset', 0)
    a['bufferView'] = add_bytes(dst_bin[start:start + v['byteLength']]); accessors.append(a)
    carried[index] = len(accessors) - 1
    return carried[index]
dst_skin['inverseBindMatrices'] = carry(dst_skin['inverseBindMatrices'])
for animation in dst['animations']:
    for sampler in animation['samplers']:
        sampler['input'] = carry(sampler['input']); sampler['output'] = carry(sampler['output'])
op = out_p.astype(np.float32)
prim = {'attributes': {
    'POSITION': add(op, 34962, 'VEC3', 5126, {'min': op.min(0).tolist(), 'max': op.max(0).tolist()}),
    'NORMAL': add((out_n / np.maximum(np.linalg.norm(out_n, axis=1, keepdims=True), 1e-9)).astype(np.float32), 34962, 'VEC3', 5126),
    'COLOR_0': add(tinted, 34962, 'VEC3', 5126),
    **({'TEXCOORD_0': add(out_uv, 34962, 'VEC2', 5126)} if textured else {}),
    'JOINTS_0': add(out_j.astype(np.uint16), 34962, 'VEC4', 5123),
    'WEIGHTS_0': add(out_w.astype(np.float32), 34962, 'VEC4', 5126)},
  'indices': add(I.astype(np.uint32), 34963, 'SCALAR', 5125), 'material': 0}
keep = body_node
for i, n in enumerate(dst['nodes']):
    if 'mesh' in n and i != keep: n.pop('mesh'); n.pop('skin', None)
dst['nodes'][keep]['mesh'] = 0
material = dst['materials'][0]; material.setdefault('pbrMetallicRoughness', {})['baseColorFactor'] = [1, 1, 1, 1]
if textured and image is not None:
    buf = io.BytesIO()
    image.save(buf, format='JPEG', quality=90, optimize=True)
    img_bytes = buf.getvalue() if len(buf.getvalue()) < len(raw_image) else raw_image
    img_view = add_bytes(img_bytes)
    dst['images'] = [{'bufferView': img_view, 'mimeType': 'image/jpeg'}]
    dst['textures'] = [{'source': 0}]
    material['pbrMetallicRoughness']['baseColorTexture'] = {'index': 0}
dst.update(meshes=[{'name': 'sailor', 'primitives': [prim]}], materials=[material], accessors=accessors, bufferViews=views)
new_bin = b''.join(chunks); new_bin += b'\0' * ((4 - len(new_bin) % 4) % 4); dst['buffers'] = [{'byteLength': len(new_bin)}]
js = json.dumps(dst).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
with open(out_path, 'wb') as f:
    f.write(struct.pack('<III', 0x46546c67, 2, 12 + 8 + len(js) + 8 + len(new_bin))); f.write(struct.pack('<II', len(js), 0x4e4f534a)); f.write(js); f.write(struct.pack('<II', len(new_bin), 0x004e4942)); f.write(new_bin)
print('wrote', out_path, len(new_bin) // 1024, 'KB')
