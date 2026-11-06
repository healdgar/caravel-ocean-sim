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

source_path, target_path, out_path = sys.argv[1:4]
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
            image = Image.open(io.BytesIO(src_bin[view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']])).convert('RGB')
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
# Leaves of a chain (hand, head, finger tips, toes) turn with the bone before them, so they stay attached.
before = {b: a for a, b in BONE_NEXT.items()}
for n in list(bones):
    if n not in BONE_NEXT and n in before and before[n] in bones:
        a, t, _, _, axis = bones[n]; bones[n] = (a, t, bones[before[n]][2], 1.0, axis)
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
shaded = colors.copy()
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
out_p, out_n, out_j, out_w = out_p[kept], out_n[kept], out_j[kept], out_w[kept]
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
def carry(index):
    a = dict(dst['accessors'][index]); v = dst['bufferViews'][a['bufferView']]
    start = v.get('byteOffset', 0)
    a['bufferView'] = add_bytes(dst_bin[start:start + v['byteLength']]); accessors.append(a)
    return len(accessors) - 1
dst_skin['inverseBindMatrices'] = carry(dst_skin['inverseBindMatrices'])
for animation in dst['animations']:
    for sampler in animation['samplers']:
        sampler['input'] = carry(sampler['input']); sampler['output'] = carry(sampler['output'])
op = out_p.astype(np.float32)
prim = {'attributes': {
    'POSITION': add(op, 34962, 'VEC3', 5126, {'min': op.min(0).tolist(), 'max': op.max(0).tolist()}),
    'NORMAL': add((out_n / np.maximum(np.linalg.norm(out_n, axis=1, keepdims=True), 1e-9)).astype(np.float32), 34962, 'VEC3', 5126),
    'COLOR_0': add(tinted, 34962, 'VEC3', 5126),
    'JOINTS_0': add(out_j.astype(np.uint16), 34962, 'VEC4', 5123),
    'WEIGHTS_0': add(out_w.astype(np.float32), 34962, 'VEC4', 5126)},
  'indices': add(I.astype(np.uint32), 34963, 'SCALAR', 5125), 'material': 0}
keep = body_node
for i, n in enumerate(dst['nodes']):
    if 'mesh' in n and i != keep: n.pop('mesh'); n.pop('skin', None)
dst['nodes'][keep]['mesh'] = 0
material = dst['materials'][0]; material.setdefault('pbrMetallicRoughness', {})['baseColorFactor'] = [1, 1, 1, 1]
dst.update(meshes=[{'name': 'sailor', 'primitives': [prim]}], materials=[material], accessors=accessors, bufferViews=views)
new_bin = b''.join(chunks); new_bin += b'\0' * ((4 - len(new_bin) % 4) % 4); dst['buffers'] = [{'byteLength': len(new_bin)}]
js = json.dumps(dst).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
with open(out_path, 'wb') as f:
    f.write(struct.pack('<III', 0x46546c67, 2, 12 + 8 + len(js) + 8 + len(new_bin))); f.write(struct.pack('<II', len(js), 0x4e4f534a)); f.write(js); f.write(struct.pack('<II', len(new_bin), 0x004e4942)); f.write(new_bin)
print('wrote', out_path, len(new_bin) // 1024, 'KB')
