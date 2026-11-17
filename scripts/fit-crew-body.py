#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Binds a rigged generated character to the game's crew skeleton without warping geometry.

The crew skeleton (scripts/crew_skeleton.py) is Unreal 5's 80-joint body, the one Tripo rigs with
--spec unreal, and 13 face joints. The character keeps its own uniformly scaled anatomical joint
positions (zero shoulder shear, zero pelvis/hip inversion, zero head-pitch tilt, zero limb-radius
crushing) and its own skin weights, joint for joint; the face joints are placed on its face and
take their share of the head's weight. Recomputes exact inverseBindMatrices, and retargets Idle,
Walk, and Brace in model space with grounded soles. Segments skin, hair/beard, upper garment,
lower garment, and untinted leather/trim using joint weights, anatomical coordinates,
character-specific colour prototypes, and mesh-graph despeckling so facial features, beards, and
hair render cleanly across all palettes.

  python3 scripts/fit-crew-body.py [--textured] [--full-texture] rigged.glb assets/crew/sailor-classic.glb out.glb

--full-texture keeps the character's texture as generated instead of reducing it to 2048 pixels.
Needs numpy and Pillow.
"""
import io, json, math, os, struct, sys
import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crew_skeleton import JOINTS, FACE_JOINTS, INSERTED, face_landmarks  # noqa: E402


def read_glb(path):
    data = open(path, 'rb').read()
    n = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + n])
    start = 20 + n + 8
    return doc, data[start:start + doc['buffers'][0]['byteLength']]


TYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
SIZES = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def accessor(doc, bin_, index):
    a = doc['accessors'][index]
    v = doc['bufferViews'][a['bufferView']]
    t = TYPES[a['componentType']]
    size = SIZES[a['type']]
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = v.get('byteStride') or size * t().itemsize
    raw = np.frombuffer(bin_, dtype=np.uint8, count=stride * a['count'], offset=start)
    out = np.zeros((a['count'], size), dtype=t)
    buf = raw.tobytes()
    for k in range(size):
        out[:, k] = np.ndarray((a['count'],), dtype=t, buffer=buf, offset=k * t().itemsize, strides=(stride,))
    if a.get('normalized') and t is not np.float32:
        out = out.astype(np.float32) / np.iinfo(t).max
    return out


def quat_to_mat3(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float64)


def mat3_to_quat(r):
    tr = float(r[0, 0] + r[1, 1] + r[2, 2])
    if tr > 0.0:
        s = math.sqrt(tr + 1.0) * 2.0
        q = np.array([(r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, 0.25 * s], dtype=np.float64)
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2.0
        q = np.array([0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s, (r[2, 1] - r[1, 2]) / s], dtype=np.float64)
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2.0
        q = np.array([(r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s, (r[0, 2] - r[2, 0]) / s], dtype=np.float64)
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2.0
        q = np.array([(r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s, (r[1, 0] - r[0, 1]) / s], dtype=np.float64)
    q /= max(np.linalg.norm(q), 1e-12)
    return q


def quat_slerp(a, b, t):
    dot = float(np.dot(a, b))
    sign = -1.0 if dot < 0.0 else 1.0
    dot = min(1.0, abs(dot))
    if dot < 0.9995:
        ang = math.acos(dot)
        sn = math.sin(ang)
        wa = math.sin((1.0 - t) * ang) / sn
        wb = math.sin(t * ang) / sn * sign
    else:
        wa = 1.0 - t
        wb = t * sign
    out = wa * a + wb * b
    return out / max(np.linalg.norm(out), 1e-12)


def local_matrix(n):
    if 'matrix' in n:
        return np.array(n['matrix'], dtype=np.float64).reshape(4, 4).T
    r = quat_to_mat3(n.get('rotation', [0, 0, 0, 1]))
    s = np.array(n.get('scale', [1, 1, 1]), dtype=np.float64)
    t = np.array(n.get('translation', [0, 0, 0]), dtype=np.float64)
    m = np.eye(4, dtype=np.float64)
    m[:3, :3] = r * s
    m[:3, 3] = t
    return m


def world_matrices(doc):
    parent = {}
    order = []
    for i, n in enumerate(doc['nodes']):
        for c in n.get('children', []):
            parent[c] = i
    seen = set()

    def visit(i):
        if i in seen:
            return
        seen.add(i)
        if i in parent:
            visit(parent[i])
        order.append(i)

    for i in range(len(doc['nodes'])):
        visit(i)
    worlds = [None] * len(doc['nodes'])
    for i in order:
        lm = local_matrix(doc['nodes'][i])
        worlds[i] = (worlds[parent[i]] @ lm) if i in parent else lm
    return worlds, parent, order


def rotation_between(a, b):
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na < 1e-8 or nb < 1e-8:
        return np.eye(3, dtype=np.float64)
    a = a / na
    b = b / nb
    v = np.cross(a, b)
    c = float(np.clip(a @ b, -1.0, 1.0))
    if c < -0.9999:
        axis = np.cross(a, [1.0, 0.0, 0.0])
        if np.linalg.norm(axis) < 1e-3:
            axis = np.cross(a, [0.0, 1.0, 0.0])
        axis /= np.linalg.norm(axis)
        return 2.0 * np.outer(axis, axis) - np.eye(3, dtype=np.float64)
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]], dtype=np.float64)
    return np.eye(3, dtype=np.float64) + k + (k @ k) / (1.0 + c)


def clean_joint_name(name):
    return name.split(':')[-1].replace('mixamorig', '')


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
    c00 = pixels[y0, x0]
    c10 = pixels[y0, x1]
    c01 = pixels[y1, x0]
    c11 = pixels[y1, x1]
    return (c00 * (1 - fx) * (1 - fy) + c10 * fx * (1 - fy) + c01 * (1 - fx) * fy + c11 * fx * fy).astype(np.float32)


def srgb_to_linear(srgb):
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_oklab(rgb):
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    l = np.cbrt(np.maximum(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.0))
    m = np.cbrt(np.maximum(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0.0))
    s = np.cbrt(np.maximum(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b, 0.0))
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return np.column_stack([L, A, B]).astype(np.float32)


def main():
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 3:
        raise SystemExit('Usage: python3 scripts/fit-crew-body.py [--textured] source_rigged.glb target_classic.glb out.glb')
    textured = '--textured' in flags
    full_texture = '--full-texture' in flags
    force_bald = '--bald' in flags
    source_path, target_path, out_path = args[:3]

    src, src_bin = read_glb(source_path)
    dst, dst_bin = read_glb(target_path)

    skin = src['skins'][0]
    src_names = [src['nodes'][j].get('name', f'j{j}') for j in skin['joints']]
    dst_skin = dst['skins'][0]
    dst_names = [dst['nodes'][j]['name'] for j in dst_skin['joints']]
    if dst_names != list(JOINTS):
        raise SystemExit(f'{target_path} is not on the crew skeleton; run scripts/extend-crew-skeleton.py on it first')
    dst_index = {n: i for i, n in enumerate(dst_names)}
    dst_lower = {n.lower(): i for i, n in enumerate(dst_names)}

    src_ibm = accessor(src, src_bin, skin['inverseBindMatrices']).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    src_bind_world = np.linalg.inv(src_ibm)
    dst_worlds, dst_parent, dst_order = world_matrices(dst)

    # Read mesh primitives in Tripo's bind frame.
    src_node_worlds, _, _ = world_matrices(src)
    positions, normals, uvs, joints, weights, indices = [], [], [], [], [], []
    offset = 0
    image = None
    raw_image = None
    for ni, n in enumerate(src['nodes']):
        if 'mesh' not in n:
            continue
        mw = src_node_worlds[ni]
        mr = mw[:3, :3]
        nr = np.linalg.inv(mr).T
        for p in src['meshes'][n['mesh']]['primitives']:
            a = p['attributes']
            pos_raw = accessor(src, src_bin, a['POSITION']).astype(np.float64)
            norm_raw = accessor(src, src_bin, a['NORMAL']).astype(np.float64)
            # Skinned glTF meshes store vertices in bind space; apply node world only if unskinned.
            if 'skin' not in n:
                pos_raw = (pos_raw @ mr.T) + mw[:3, 3]
                norm_raw = norm_raw @ nr.T
            positions.append(pos_raw)
            normals.append(norm_raw)
            uvs.append(accessor(src, src_bin, a['TEXCOORD_0']).astype(np.float64))
            joints.append(accessor(src, src_bin, a['JOINTS_0']).astype(np.int64))
            weights.append(accessor(src, src_bin, a['WEIGHTS_0']).astype(np.float64))
            indices.append(accessor(src, src_bin, p['indices']).astype(np.int64).ravel() + offset)
            offset += len(pos_raw)
            material = src['materials'][p['material']]
            texture = material.get('pbrMetallicRoughness', {}).get('baseColorTexture')
            if texture and image is None:
                view = src['bufferViews'][src['images'][src['textures'][texture['index']]['source']]['bufferView']]
                raw_image = src_bin[view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']]
                image = Image.open(io.BytesIO(raw_image)).convert('RGB')

    P = np.concatenate(positions)
    N = np.concatenate(normals)
    UV = np.concatenate(uvs)
    J = np.concatenate(joints)
    W = np.concatenate(weights)
    I = np.concatenate(indices)
    W = W / np.maximum(W.sum(axis=1, keepdims=True), 1e-9)

    sname = {clean_joint_name(n).lower(): i for i, n in enumerate(src_names)}
    s_pos = lambda n: src_bind_world[sname[n.lower()]][:3, 3]
    d_node_of = {dst['nodes'][i].get('name', ''): i for i in range(len(dst['nodes']))}
    d_pos = lambda n: dst_worlds[d_node_of[n]][:3, 3]
    is_female_target = 'female' in target_path.lower()

    # 1. Rigid similarity transform ONLY (proper 3D orientation R0 + uniform stature scale S + grounded T0).
    # Handles both Y-up (glTF/OpenAPI) and Z-up (UE5 Mannequin Studio) bind frames with zero non-uniform shear.
    up_raw = s_pos('head') - 0.5 * (s_pos('foot_l') + s_pos('foot_r'))
    up_axis = int(np.argmax(np.abs(up_raw)))
    up_src = np.zeros(3, dtype=np.float64)
    up_src[up_axis] = 1.0 if up_raw[up_axis] >= 0.0 else -1.0
    sh_src = s_pos('upperarm_l') - s_pos('upperarm_r')
    sh_src = sh_src - np.dot(sh_src, up_src) * up_src
    left_src = sh_src / max(np.linalg.norm(sh_src), 1e-9)
    fwd_src = np.cross(left_src, up_src)
    toes_src_3d = (s_pos('ball_l') - s_pos('foot_l')) - np.dot(s_pos('ball_l') - s_pos('foot_l'), up_src) * up_src
    if float(np.dot(toes_src_3d, fwd_src)) < 0.0:
        left_src = -left_src
        fwd_src = -fwd_src

    up_dst = np.array([0.0, 1.0, 0.0], dtype=np.float64)
    sh_dst = (d_pos('upperarm_l') - d_pos('upperarm_r')) * np.array([1.0, 0.0, 1.0])
    left_dst = sh_dst / max(np.linalg.norm(sh_dst), 1e-9)
    fwd_dst = np.cross(left_dst, up_dst)
    R0 = np.column_stack([left_dst, up_dst, fwd_dst]) @ np.column_stack([left_src, up_src, fwd_src]).T

    body_node = next(i for i, n in enumerate(dst['nodes']) if n.get('name', '').lower().startswith('superhero_'))
    dst_body_pos = accessor(dst, dst_bin, dst['meshes'][dst['nodes'][body_node]['mesh']]['primitives'][0]['attributes']['POSITION'])
    dst_sole_y = float(dst_body_pos[:, 1].min())
    dst_head_above_sole = float(d_pos('head')[1] - dst_sole_y)

    P_rot = P @ R0.T
    N_rot = N @ R0.T
    N_rot /= np.maximum(np.linalg.norm(N_rot, axis=1, keepdims=True), 1e-9)

    src_sole_y = float(P_rot[:, 1].min())
    src_top_y = float(P_rot[:, 1].max())
    src_head_rot = R0 @ s_pos('head')
    src_head_above_sole = float(src_head_rot[1] - src_sole_y)
    # Match anatomical head-joint stature while bounding total height cleanly inside [1.66, 1.81] m.
    target_total = 1.70 if is_female_target else 1.76
    S_head = dst_head_above_sole / max(src_head_above_sole, 1e-6) * (0.965 if is_female_target else 0.975)
    S_box = target_total / max(src_top_y - src_sole_y, 1e-6)
    S = 0.5 * S_head + 0.5 * S_box
    max_allowed_h = 1.81 if not is_female_target else 1.77
    min_allowed_h = 1.66 if not is_female_target else 1.61
    if (src_top_y - src_sole_y) * S > max_allowed_h:
        S = max_allowed_h / (src_top_y - src_sole_y)
    elif (src_top_y - src_sole_y) * S < min_allowed_h:
        S = min_allowed_h / (src_top_y - src_sole_y)

    pelvis_rot = (R0 @ s_pos('pelvis')) * S
    ankles_rot_z = 0.5 * ((R0 @ s_pos('foot_l'))[2] + (R0 @ s_pos('foot_r'))[2]) * S
    dst_ankles_z = 0.5 * (d_pos('foot_l')[2] + d_pos('foot_r')[2])
    SOLE_CLEARANCE = 0.004
    T0 = np.array([-pelvis_rot[0], SOLE_CLEARANCE - src_sole_y * S, dst_ankles_z - ankles_rot_z], dtype=np.float64)

    out_p = P_rot * S + T0
    out_n = N_rot.copy()
    print(f'rigid fit: scale={S:.3f}, height={(out_p[:, 1].max() - out_p[:, 1].min()):.3f}m, bounds={out_p.min(0).round(3)}..{out_p.max(0).round(3)}')

    # 2. Place every body joint at Tripo's own transformed anatomical location, joint for joint, and the face joints
    # on the face.
    def tp(name):
        return (R0 @ s_pos(name)) * S + T0

    new_joint_pos = {'Armature': np.array([0.0, 0.0, 0.0]), 'root': np.array([0.0, 0.0, 0.0])}
    for name in JOINTS:
        if name in ('root',) or name in FACE_JOINTS:
            continue
        if name.lower() in sname:
            new_joint_pos[name] = tp(name)
    for name, (a_name, b_name, f) in INSERTED.items():
        # A rig without Unreal's twist, metacarpal or upper spine joints: place them along the bones it has.
        if name not in new_joint_pos:
            new_joint_pos[name] = new_joint_pos[a_name] * (1.0 - f) + new_joint_pos[b_name] * f
    missing = [n for n in JOINTS if n not in new_joint_pos and n not in FACE_JOINTS]
    if missing:
        raise SystemExit(f'{source_path} lacks joints the crew skeleton needs: {", ".join(missing)}')
    src_head = sname['head']
    src_head_weight = np.where(J == src_head, W, 0.0).sum(axis=1)
    face_marks, face_measures = face_landmarks(out_p, src_head_weight, new_joint_pos['head'])
    new_joint_pos.update(face_marks)
    print('face: eyes at {:.3f} m, mouth at {:.3f} m, chin at {:.3f} m, nose tip {:.3f} m forward'.format(
        face_measures['eye_y'], face_measures['mouth_y'], face_measures['chin_y'], face_measures['nose'][1]))

    # 3. Compute rest world rotations W_rot[node].
    # Axial / posture joints keep dst's exact world rest rotation (upright head/spine/pelvis, flat feet).
    # Limb chains align their rest orientation to Tripo's bind-pose limb vectors so rest skinning is
    # exact identity while retargeted clips rotate limbs to dst's exact animated world directions.
    LIMB_AIM = {}
    for side in ('_l', '_r'):
        LIMB_AIM[f'upperarm{side}'] = f'lowerarm{side}'
        LIMB_AIM[f'lowerarm{side}'] = f'hand{side}'
        LIMB_AIM[f'thigh{side}'] = f'calf{side}'
        LIMB_AIM[f'calf{side}'] = f'foot{side}'
        for finger in ('index', 'middle', 'ring', 'pinky', 'thumb'):
            LIMB_AIM[f'{finger}_01{side}'] = f'{finger}_02{side}'
            LIMB_AIM[f'{finger}_02{side}'] = f'{finger}_03{side}'
            if finger != 'thumb':
                LIMB_AIM[f'{finger}_metacarpal{side}'] = f'{finger}_01{side}'
    # Joints turned as the joint they hang from is turned: a fingertip bone as the one before it, a twist joint as
    # its limb bone.
    FOLLOW = {}
    for side in ('_l', '_r'):
        for finger in ('index', 'middle', 'ring', 'pinky', 'thumb'):
            FOLLOW[f'{finger}_03{side}'] = f'{finger}_02{side}'
        for limb in ('upperarm', 'lowerarm', 'thigh', 'calf'):
            for k in ('01', '02'):
                FOLLOW[f'{limb}_twist_{k}{side}'] = f'{limb}{side}'

    new_world_rot = {}
    new_world_pos = {}
    for i, n in enumerate(dst['nodes']):
        name = n.get('name', '')
        w_dst_r = dst_worlds[i][:3, :3].copy()
        # Normalize columns in case of numerical drift
        for col in range(3):
            w_dst_r[:, col] /= max(np.linalg.norm(w_dst_r[:, col]), 1e-12)
        if name in new_joint_pos:
            new_world_pos[i] = new_joint_pos[name]
        else:
            new_world_pos[i] = dst_worlds[i][:3, 3].copy()

        if name in LIMB_AIM:
            child_name = LIMB_AIM[name]
            dir_dst = d_pos(child_name) - d_pos(name)
            dir_new = new_joint_pos[child_name] - new_joint_pos[name]
            R_diff = rotation_between(dir_dst, dir_new)
            new_world_rot[i] = R_diff @ w_dst_r
        elif name in ('hand_l', 'hand_r'):
            side = name[-2:]
            # Align hand along middle_01 - hand (or forearm if degenerate)
            mid_name = f'middle_01{side}'
            dir_dst = d_pos(mid_name) - d_pos(name)
            dir_new = new_joint_pos[mid_name] - new_joint_pos[name]
            R_diff = rotation_between(dir_dst, dir_new)
            new_world_rot[i] = R_diff @ w_dst_r
        else:
            # Followers are computed after the joint they follow, in dst_order below.
            new_world_rot[i] = w_dst_r

    for i in dst_order:
        name = dst['nodes'][i].get('name', '')
        if name in FOLLOW:
            prev_idx = d_node_of[FOLLOW[name]]
            R_parent_diff = new_world_rot[prev_idx] @ dst_worlds[prev_idx][:3, :3].T
            new_world_rot[i] = R_parent_diff @ dst_worlds[i][:3, :3]

    # Write local TRS into dst['nodes'] and build exact inverseBindMatrices.
    new_worlds = [np.eye(4, dtype=np.float64) for _ in range(len(dst['nodes']))]
    for i in dst_order:
        w = np.eye(4, dtype=np.float64)
        w[:3, :3] = new_world_rot[i]
        w[:3, 3] = new_world_pos[i]
        new_worlds[i] = w
        if i in dst_parent:
            pw = new_worlds[dst_parent[i]]
            pr = pw[:3, :3]
            loc_r = pr.T @ w[:3, :3]
            loc_t = pr.T @ (w[:3, 3] - pw[:3, 3])
        else:
            loc_r = w[:3, :3]
            loc_t = w[:3, 3]
        node = dst['nodes'][i]
        node.pop('matrix', None)
        node['translation'] = [float(x) for x in loc_t]
        node['rotation'] = [float(x) for x in mat3_to_quat(loc_r)]
        node['scale'] = [1.0, 1.0, 1.0]

    new_ibm = np.zeros((len(dst_skin['joints']), 4, 4), dtype=np.float32)
    for slot, node_idx in enumerate(dst_skin['joints']):
        inv_w = np.linalg.inv(new_worlds[node_idx])
        # glTF stores column-major MAT4
        new_ibm[slot] = inv_w.T.astype(np.float32)

    # 4. Keep Tripo's skin weights, joint for joint: its Unreal rig is the crew skeleton's body.
    joint_weight_splits = {}
    for i, raw_name in enumerate(src_names):
        n = clean_joint_name(raw_name).lower()
        if n in dst_lower:
            joint_weight_splits[i] = [(dst_lower[n], 1.0)]
        else:
            # Walk up Tripo hierarchy to nearest mapped ancestor
            src_parent = {c: p for p, nd in enumerate(src['nodes']) for c in nd.get('children', [])}
            j_of_node = {jn: ji for ji, jn in enumerate(skin['joints'])}
            cur = skin['joints'][i]
            found = None
            while cur in src_parent:
                cur = src_parent[cur]
                if cur in j_of_node:
                    anc_name = clean_joint_name(src_names[j_of_node[cur]]).lower()
                    if anc_name in dst_lower:
                        found = dst_lower[anc_name]
                        break
            joint_weight_splits[i] = [(found if found is not None else dst_index['pelvis'], 1.0)]

    out_j = np.zeros_like(J)
    out_w = np.zeros_like(W)
    for v in range(len(P)):
        merged = {}
        for k in range(4):
            w = float(W[v, k])
            if w <= 0.0:
                continue
            si = int(J[v, k])
            for dj, share in joint_weight_splits[si]:
                merged[dj] = merged.get(dj, 0.0) + w * share
        top = sorted(merged.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(val for _, val in top) or 1.0
        for k, (dj, val) in enumerate(top):
            out_j[v, k] = dj
            out_w[v, k] = val / tot

    # Smooth skin weights across welded 3D edges in high-articulation garment zones:
    # (a) shoulder/armpit puffed sleeves (T-pose -> Idle -68 deg drop) and
    # (b) skirt/breeches centerline (prevents thigh_l vs thigh_r tearing across x=0).
    num_joints = len(dst_skin['joints'])
    dense_w = np.zeros((len(P), num_joints), dtype=np.float64)
    for k in range(4):
        np.add.at(dense_w, (np.arange(len(P)), out_j[:, k]), out_w[:, k])
    w_keys = np.round(out_p / 2e-4).astype(np.int64)
    _, w_first, w_inv = np.unique(w_keys, axis=0, return_index=True, return_inverse=True)
    w_inv = w_inv.ravel()
    n_u = len(w_first)
    u_pos = out_p[w_first]
    u_nbrs = [set() for _ in range(n_u)]
    for ta, tb, tc in I.reshape(-1, 3):
        ua, ub, uc = int(w_inv[ta]), int(w_inv[tb]), int(w_inv[tc])
        if ua != ub:
            u_nbrs[ua].add(ub); u_nbrs[ub].add(ua)
        if ub != uc:
            u_nbrs[ub].add(uc); u_nbrs[uc].add(ub)
        if ua != uc:
            u_nbrs[ua].add(uc); u_nbrs[uc].add(ua)
    u_dense = np.zeros((n_u, num_joints), dtype=np.float64)
    u_cnt = np.zeros(n_u, dtype=np.float64)
    np.add.at(u_dense, w_inv, dense_w)
    np.add.at(u_cnt, w_inv, 1.0)
    u_dense /= np.maximum(u_cnt[:, None], 1.0)

    pelvis_y = float(new_joint_pos['pelvis'][1])
    sp2_y = float(new_joint_pos['spine_02'][1])
    head_y = float(new_joint_pos['head'][1])
    in_armpit = (np.abs(u_pos[:, 0]) > 0.095) & (np.abs(u_pos[:, 0]) < 0.31) & (u_pos[:, 1] > sp2_y - 0.03) & (u_pos[:, 1] < head_y - 0.03)
    in_skirt_seam = (np.abs(u_pos[:, 0]) < 0.125) & (u_pos[:, 1] > 0.20) & (u_pos[:, 1] < pelvis_y + 0.04)
    smooth_zone = in_armpit | in_skirt_seam
    for _ in range(4):
        nxt_u = u_dense.copy()
        for ui in np.nonzero(smooth_zone)[0]:
            nb = list(u_nbrs[ui])
            if not nb:
                continue
            alpha = 0.50 if in_skirt_seam[ui] else 0.38
            nxt_u[ui] = (1.0 - alpha) * u_dense[ui] + alpha * u_dense[nb].mean(axis=0)
        u_dense = nxt_u
    smoothed_v = smooth_zone[w_inv]
    for v in np.nonzero(smoothed_v)[0]:
        row = u_dense[w_inv[v]]
        top_idx = np.argsort(row)[::-1][:4]
        vals = np.maximum(row[top_idx], 0.0)
        tot = float(vals.sum()) or 1.0
        out_j[v] = top_idx
        out_w[v] = vals / tot

    # 4b. The face joints take their share of what the head and neck carry, each a soft region about its own feature: the
    # jaw everything below the mouth and in front of the ear, each lip and lip corner its own, each eye the eye
    # between the lids, each lid the skin above or below that, each brow its own.
    fm, s = face_measures, face_measures['scale']
    cx = fm['cx']
    fx, fy, fz = out_p[:, 0] - cx, out_p[:, 1], out_p[:, 2]

    def ramp(e0, e1, value):
        t = np.clip((value - e0) / (e1 - e0), 0.0, 1.0)
        return t * t * (3.0 - 2.0 * t)

    def region(centre, rx, ry, rz):
        d = np.sqrt(((out_p[:, 0] - centre[0]) / rx) ** 2 + ((out_p[:, 1] - centre[1]) / ry) ** 2 + ((out_p[:, 2] - centre[2]) / rz) ** 2)
        return ramp(1.0, 0.45, d)

    # A rig without a jaw may hang the lips and chin on the neck, so the face carves from the neck as well as the head.
    head_slot = dst_index['head']
    carving = [head_slot, dst_index['neck_01'], dst_index['neck_02']]
    carried = np.where(np.isin(out_j, carving), out_w, 0.0).sum(axis=1)
    facing = ramp(fm['mid_z'] - 0.005 * s, fm['mid_z'] + 0.025 * s, fz)
    mouth_y, lips_z = fm['mouth_y'], fm['lips_z']
    jaw_at = new_joint_pos['FACIAL_C_Jaw']
    share = {}
    share['FACIAL_C_Jaw'] = (ramp(mouth_y + 0.002 * s, mouth_y - 0.007 * s, fy) * ramp(jaw_at[2] - 0.020 * s, jaw_at[2] + 0.025 * s, fz)
                             * ramp(0.078 * s, 0.056 * s, np.abs(fx)) * ramp(fm['chin_y'] - 0.045 * s, fm['chin_y'] - 0.012 * s, fy))
    share['FACIAL_C_LipUpper'] = region((cx, mouth_y + 0.006 * s, lips_z), 0.021 * s, 0.010 * s, 0.016 * s) * (fy > mouth_y - 0.0005 * s)
    share['FACIAL_C_LipLower'] = region((cx, mouth_y - 0.008 * s, lips_z), 0.020 * s, 0.011 * s, 0.016 * s) * (fy < mouth_y + 0.0005 * s)
    for side in ('L', 'R'):
        corner = new_joint_pos[f'FACIAL_{side}_LipCorner']
        share[f'FACIAL_{side}_LipCorner'] = region((corner[0], corner[1], corner[2] + 0.005 * s), 0.010 * s, 0.010 * s, 0.016 * s)
        eye = new_joint_pos[f'FACIAL_{side}_Eye']
        front_of_eye = fz > eye[2]
        open_eye = np.sqrt(((out_p[:, 0] - eye[0]) / (0.0135 * s)) ** 2 + ((out_p[:, 1] - eye[1]) / (0.0058 * s)) ** 2)
        share[f'FACIAL_{side}_Eye'] = ramp(1.0, 0.7, open_eye) * front_of_eye
        across = ramp(1.0, 0.55, np.abs(out_p[:, 0] - eye[0]) / (0.017 * s)) * front_of_eye
        rise = out_p[:, 1] - eye[1]
        share[f'FACIAL_{side}_EyelidUpper'] = across * ramp(0.002 * s, 0.006 * s, rise) * ramp(0.016 * s, 0.010 * s, rise) * (1 - share[f'FACIAL_{side}_Eye'])
        share[f'FACIAL_{side}_EyelidLower'] = across * ramp(-0.002 * s, -0.006 * s, rise) * ramp(-0.013 * s, -0.008 * s, rise) * (1 - share[f'FACIAL_{side}_Eye'])
        brow = new_joint_pos[f'FACIAL_{side}_Brow']
        share[f'FACIAL_{side}_Brow'] = region((brow[0], brow[1], brow[2] + 0.006 * s), 0.024 * s, 0.011 * s, 0.020 * s) * front_of_eye
    # The lips ride the jaw's region rather than adding to it.
    share['FACIAL_C_Jaw'] = share['FACIAL_C_Jaw'] * (1.0 - share['FACIAL_C_LipLower'])
    total = sum(share.values()) * facing
    scale_down = np.where(total > 1.0, 1.0 / np.maximum(total, 1e-9), 1.0)
    face_rows = np.nonzero((carried > 1e-4) & (total > 1e-4))[0]
    face_slots = [dst_index[n] for n in FACE_JOINTS]
    for v in face_rows:
        row = {}
        for k in range(4):
            if out_w[v, k] > 0:
                row[int(out_j[v, k])] = row.get(int(out_j[v, k]), 0.0) + float(out_w[v, k])
        given = 0.0
        for name, slot in zip(FACE_JOINTS, face_slots):
            w = carried[v] * float(share[name][v] * facing[v] * scale_down[v])
            if w > 1e-5:
                row[slot] = row.get(slot, 0.0) + w
                given += w
        keep = max(1.0 - given / carried[v], 0.0)
        for slot in carving:
            if slot in row:
                row[slot] *= keep
        top = sorted(row.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(val for _, val in top) or 1.0
        out_j[v] = 0
        out_w[v] = 0.0
        for k, (slot, val) in enumerate(top):
            out_j[v, k] = slot
            out_w[v, k] = val / tot
    print('face weights:', {n: int((out_j == dst_index[n]).any(axis=1).sum()) for n in FACE_JOINTS})

    # 5. Retarget Idle, Walk, and Brace onto the new anatomical skeleton.
    dst_leg_len = float(np.linalg.norm(d_pos('calf_l') - d_pos('thigh_l')) + np.linalg.norm(d_pos('foot_l') - d_pos('calf_l')))
    new_leg_len = float(np.linalg.norm(new_joint_pos['calf_l'] - new_joint_pos['thigh_l']) + np.linalg.norm(new_joint_pos['foot_l'] - new_joint_pos['calf_l']))
    leg_ratio = new_leg_len / max(dst_leg_len, 1e-6)

    dst_rest_t = [np.array(n.get('translation', [0, 0, 0]), dtype=np.float64) for n in dst['nodes']]
    # Re-read original dst rest local rotations/translations BEFORE we mutated dst['nodes']!
    dst_orig, _ = read_glb(target_path)
    orig_rest_t = [np.array(n.get('translation', [0, 0, 0]), dtype=np.float64) for n in dst_orig['nodes']]
    orig_rest_r = [np.array(n.get('rotation', [0, 0, 0, 1]), dtype=np.float64) for n in dst_orig['nodes']]
    for q in orig_rest_r:
        q /= max(np.linalg.norm(q), 1e-12)
    new_rest_t = [np.array(n['translation'], dtype=np.float64) for n in dst['nodes']]
    new_rest_r = [np.array(n['rotation'], dtype=np.float64) for n in dst['nodes']]

    def sample_orig_clip(anim, t_sec):
        pose_t = [x.copy() for x in orig_rest_t]
        pose_r = [x.copy() for x in orig_rest_r]
        for ch in anim['channels']:
            node_idx = ch['target']['node']
            path = ch['target']['path']
            samp = anim['samplers'][ch['sampler']]
            times = accessor(dst_orig, dst_bin, samp['input']).ravel().astype(np.float64)
            vals = accessor(dst_orig, dst_bin, samp['output']).astype(np.float64)
            lo = int(np.searchsorted(times, t_sec, side='right')) - 1
            lo = max(0, min(lo, len(times) - 1))
            hi = min(lo + 1, len(times) - 1)
            f = 0.0 if lo == hi or samp.get('interpolation') == 'STEP' else float(np.clip((t_sec - times[lo]) / max(times[hi] - times[lo], 1e-9), 0.0, 1.0))
            if path == 'rotation':
                qa = vals[lo] / max(np.linalg.norm(vals[lo]), 1e-12)
                qb = vals[hi] / max(np.linalg.norm(vals[hi]), 1e-12)
                pose_r[node_idx] = quat_slerp(qa, qb, f)
            elif path == 'translation':
                pose_t[node_idx] = vals[lo] * (1.0 - f) + vals[hi] * f
        w_mats = [None] * len(dst_orig['nodes'])
        for idx in dst_order:
            lm = np.eye(4, dtype=np.float64)
            lm[:3, :3] = quat_to_mat3(pose_r[idx])
            lm[:3, 3] = pose_t[idx]
            w_mats[idx] = (w_mats[dst_parent[idx]] @ lm) if idx in dst_parent else lm
        return w_mats

    # Sole sample subset for fast grounding verification across animation frames
    sole_candidates = np.argsort(out_p[:, 1])[:256]
    pelvis_node = d_node_of['pelvis']
    root_node = d_node_of['root']
    root_new_r = new_worlds[root_node][:3, :3]
    orig_pelvis_world_rest = dst_worlds[pelvis_node][:3, 3]
    new_pelvis_world_rest = new_worlds[pelvis_node][:3, 3]

    retargeted_clips = []
    for anim in dst_orig.get('animations', []):
        name = anim['name']
        dur = max(float(accessor(dst_orig, dst_bin, s['input']).max()) for s in anim['samplers'])
        steps = max(2, int(round(dur * 30)))
        times = np.linspace(0.0, dur, steps + 1, dtype=np.float32)

        tracks_r = [[] for _ in range(len(dst['nodes']))]
        tracks_t = [[] for _ in range(len(dst['nodes']))]
        frame_min_ys = []

        # First pass: retarget rotations & scaled pelvis world translation
        clav_nodes = {d_node_of[k] for k in ('clavicle_l', 'clavicle_r') if k in d_node_of}
        frame_worlds = []
        for fi in range(steps + 1):
            t_eval = 0.0 if fi == steps else float(times[fi])
            src_w = sample_orig_clip(anim, t_eval)
            tgt_w_rot = [None] * len(dst['nodes'])
            tgt_w_pos = [None] * len(dst['nodes'])
            for idx in dst_order:
                # Dampen classic-rig clavicle forward hunch so straight-lateral 1550 T-pose shoulders
                # never shove +4 cm forward into puffed sleeves/armpits when arms drop to the side.
                if idx in clav_nodes:
                    q_rest = mat3_to_quat(dst_worlds[idx][:3, :3])
                    q_anim = mat3_to_quat(src_w[idx][:3, :3])
                    tgt_w_rot[idx] = quat_to_mat3(quat_slerp(q_rest, q_anim, 0.22))
                else:
                    tgt_w_rot[idx] = src_w[idx][:3, :3]
                if idx == pelvis_node:
                    dp = (src_w[pelvis_node][:3, 3] - orig_pelvis_world_rest) * leg_ratio
                    tgt_w_pos[idx] = new_pelvis_world_rest + dp
                elif idx in dst_parent:
                    p_idx = dst_parent[idx]
                    tgt_w_pos[idx] = tgt_w_pos[p_idx] + tgt_w_rot[p_idx] @ new_rest_t[idx]
                else:
                    tgt_w_pos[idx] = new_rest_t[idx].copy()

            # Measure sole height on sole_candidates
            pal = np.zeros((len(dst_skin['joints']), 4, 4), dtype=np.float64)
            for slot, j_node in enumerate(dst_skin['joints']):
                wm = np.eye(4, dtype=np.float64)
                wm[:3, :3] = tgt_w_rot[j_node]
                wm[:3, 3] = tgt_w_pos[j_node]
                pal[slot] = wm @ new_ibm[slot].T
            ys = np.zeros(len(sole_candidates), dtype=np.float64)
            for k in range(4):
                slots = out_j[sole_candidates, k]
                ws = out_w[sole_candidates, k]
                mats = pal[slots]
                pts = out_p[sole_candidates]
                ys += ws * (mats[:, 1, 0] * pts[:, 0] + mats[:, 1, 1] * pts[:, 1] + mats[:, 1, 2] * pts[:, 2] + mats[:, 1, 3])
            frame_min_ys.append(float(ys.min()))
            frame_worlds.append((tgt_w_rot, tgt_w_pos))

        # Constant clip ground lift so lowest stance sole kisses y ~ 0.002 m cleanly without jump
        clip_min_y = min(frame_min_ys)
        pelvis_lift_y = 0.002 - clip_min_y if (clip_min_y < -0.008 or clip_min_y > 0.025) else 0.0

        for fi in range(steps + 1):
            tgt_w_rot, tgt_w_pos = frame_worlds[fi]
            for idx in dst_order:
                if idx in dst_parent:
                    p_idx = dst_parent[idx]
                    loc_r = tgt_w_rot[p_idx].T @ tgt_w_rot[idx]
                else:
                    loc_r = tgt_w_rot[idx]
                q = mat3_to_quat(loc_r)
                if tracks_r[idx] and float(np.dot(tracks_r[idx][-1], q)) < 0.0:
                    q = -q
                tracks_r[idx].append(q)
                if idx == pelvis_node:
                    pw = tgt_w_pos[pelvis_node] + np.array([0.0, pelvis_lift_y, 0.0])
                    loc_t = root_new_r.T @ (pw - new_worlds[root_node][:3, 3])
                    tracks_t[idx].append(loc_t)
                else:
                    tracks_t[idx].append(new_rest_t[idx])
        retargeted_clips.append((name, times, tracks_r, tracks_t))

    # 6. High-quality texture sampling & anatomical garment/skin/hair/beard classification.
    slot_names = [dst['nodes'][j]['name'] for j in dst_skin['joints']]
    head_slots = {i for i, n in enumerate(slot_names) if n == 'head' or n.startswith('FACIAL_')}
    neck_slots = {i for i, n in enumerate(slot_names) if n in ('neck_01', 'neck_02')}
    hand_slots = {i for i, n in enumerate(slot_names) if n.startswith(('hand_', 'index_', 'middle_', 'ring_', 'pinky_', 'thumb_'))}
    arm_slots = {i for i, n in enumerate(slot_names) if n.startswith(('upperarm_', 'lowerarm_'))}
    torso_slots = {i for i, n in enumerate(slot_names) if n in ('pelvis', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05', 'clavicle_l', 'clavicle_r')}
    leg_slots = {i for i, n in enumerate(slot_names) if n.startswith(('thigh_', 'calf_'))}
    foot_slots = {i for i, n in enumerate(slot_names) if n.startswith(('foot_', 'ball_'))}

    def group_weight(slot_set):
        mask = np.isin(out_j, list(slot_set))
        return (out_w * mask).sum(axis=1)

    head_pos = new_joint_pos['head']
    neck_pos = new_joint_pos['neck_01']
    spine1_pos = new_joint_pos['spine_01']
    spine3_pos = new_joint_pos['spine_03']

    # Conforming 2-pass front-face midpoint subdivision for vertex-coloured characters so 4K painted
    # eyes, pupils, sclera, eyebrows, nostrils, and lips are captured at ~1.8 mm vertex resolution
    # without adding any runtime texture bindings or T-junction cracks across UV island seams.
    if not textured:
        def merge_joint_weights(ja, wa, jb, wb):
            acc = {}
            for slot, wt in zip(ja, wa):
                if wt > 1e-6:
                    acc[int(slot)] = acc.get(int(slot), 0.0) + 0.5 * float(wt)
            for slot, wt in zip(jb, wb):
                if wt > 1e-6:
                    acc[int(slot)] = acc.get(int(slot), 0.0) + 0.5 * float(wt)
            top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
            while len(top) < 4:
                top.append((0, 0.0))
            tot = sum(wt for _, wt in top) or 1.0
            return (
                np.array([s for s, _ in top], dtype=out_j.dtype),
                np.array([wt / tot for _, wt in top], dtype=out_w.dtype),
            )

        for pass_idx, (max_dx, min_dy_off, max_dy_frac, min_dz_off, min_edge_m) in enumerate((
            (0.072, -0.045, 0.78, 0.008, 0.0038),
            (0.056, -0.025, 0.68, 0.022, 0.0020),
        )):
            wh_cur = group_weight(head_slots)
            hv_cur = wh_cur > 0.42
            htop_cur = float(out_p[hv_cur, 1].max()) if hv_cur.any() else head_pos[1] + 0.18
            hfz_cur = float(np.percentile(out_p[hv_cur, 2], 95)) if hv_cur.any() else head_pos[2] + 0.10
            hbz_cur = float(np.percentile(out_p[hv_cur, 2], 8)) if hv_cur.any() else head_pos[2] - 0.10
            hmid_cur = 0.5 * (hfz_cur + hbz_cur)
            hspan_cur = max(htop_cur - head_pos[1], 0.12)
            elig = (
                (wh_cur > 0.42)
                & (np.abs(out_p[:, 0] - head_pos[0]) < max_dx)
                & (out_p[:, 1] > head_pos[1] + min_dy_off)
                & (out_p[:, 1] < head_pos[1] + max_dy_frac * hspan_cur)
                & (out_p[:, 2] > hmid_cur + min_dz_off)
            )
            p_quant = [tuple(row) for row in np.round(out_p / 1e-4).astype(np.int64)]
            canon_pos = {}
            for vi, pk in enumerate(p_quant):
                if pk not in canon_pos:
                    canon_pos[pk] = out_p[vi]
            tris_cur = I.reshape(-1, 3)
            split_spatial = set()
            for a, b, c in tris_cur:
                for u, v in ((a, b), (b, c), (c, a)):
                    if elig[u] and elig[v]:
                        pku, pkv = p_quant[u], p_quant[v]
                        if pku != pkv:
                            elen = float(np.linalg.norm(canon_pos[pku] - canon_pos[pkv]))
                            if elen > min_edge_m:
                                split_spatial.add((pku, pkv) if pku < pkv else (pkv, pku))
            if not split_spatial:
                continue
            p_list = list(out_p)
            n_list = list(out_n)
            uv_list = list(UV)
            j_list = list(out_j)
            w_list = list(out_w)
            corner_mid = {}

            def edge_mid_vertex(u, v):
                u_i, v_i = (int(u), int(v)) if u < v else (int(v), int(u))
                ck = (u_i, v_i)
                if ck in corner_mid:
                    return corner_mid[ck]
                pku, pkv = p_quant[u_i], p_quant[v_i]
                mp = 0.5 * (canon_pos[pku] + canon_pos[pkv])
                mn = out_n[u_i] + out_n[v_i]
                mn = mn / max(float(np.linalg.norm(mn)), 1e-9)
                muv = 0.5 * (UV[u_i] + UV[v_i])
                mj, mw = merge_joint_weights(out_j[u_i], out_w[u_i], out_j[v_i], out_w[v_i])
                idx_new = len(p_list)
                p_list.append(mp)
                n_list.append(mn)
                uv_list.append(muv)
                j_list.append(mj)
                w_list.append(mw)
                corner_mid[ck] = idx_new
                return idx_new

            def is_split(u, v):
                pku, pkv = p_quant[u], p_quant[v]
                if pku == pkv:
                    return False
                return ((pku, pkv) if pku < pkv else (pkv, pku)) in split_spatial

            new_tris = []
            for a, b, c in tris_cur:
                s01 = is_split(a, b)
                s12 = is_split(b, c)
                s20 = is_split(c, a)
                cnt = int(s01) + int(s12) + int(s20)
                if cnt == 0:
                    new_tris.append((a, b, c))
                elif cnt == 3:
                    m01 = edge_mid_vertex(a, b)
                    m12 = edge_mid_vertex(b, c)
                    m20 = edge_mid_vertex(c, a)
                    new_tris.extend(((a, m01, m20), (m01, b, m12), (m20, m12, c), (m01, m12, m20)))
                elif cnt == 1:
                    if s01:
                        v0, v1, v2 = a, b, c
                    elif s12:
                        v0, v1, v2 = b, c, a
                    else:
                        v0, v1, v2 = c, a, b
                    m01 = edge_mid_vertex(v0, v1)
                    new_tris.extend(((v0, m01, v2), (m01, v1, v2)))
                else:
                    # Rotate cyclically so v0-v1 and v1-v2 are the two split edges
                    if s01 and s12:
                        v0, v1, v2 = a, b, c
                    elif s12 and s20:
                        v0, v1, v2 = b, c, a
                    else:
                        v0, v1, v2 = c, a, b
                    m01 = edge_mid_vertex(v0, v1)
                    m12 = edge_mid_vertex(v1, v2)
                    new_tris.extend(((v0, m01, v2), (m01, m12, v2), (m01, v1, m12)))

            out_p = np.asarray(p_list, dtype=np.float64)
            out_n = np.asarray(n_list, dtype=np.float64)
            UV = np.asarray(uv_list, dtype=np.float64)
            out_j = np.asarray(j_list, dtype=out_j.dtype)
            out_w = np.asarray(w_list, dtype=out_w.dtype)
            I = np.asarray(new_tris, dtype=np.int64).ravel()

    # Lightly smooth noisy 1px UV seam artifacts on garments while keeping sharp detail on facial features.
    blurred = image.filter(ImageFilter.BoxBlur(0.65))
    pixels_sharp = np.asarray(image, dtype=np.float32) / 255.0
    pixels_smooth = np.asarray(blurred, dtype=np.float32) / 255.0
    srgb_sharp = bilinear_sample(pixels_sharp, UV)
    srgb_smooth = bilinear_sample(pixels_smooth, UV)

    w_head = group_weight(head_slots)
    w_neck = group_weight(neck_slots)
    w_hand = group_weight(hand_slots)
    w_arm = group_weight(arm_slots)
    w_torso = group_weight(torso_slots)
    w_leg = group_weight(leg_slots)
    w_foot = group_weight(foot_slots)

    srgb = np.where((w_head > 0.42)[:, None], 0.15 * srgb_smooth + 0.85 * srgb_sharp, 0.65 * srgb_smooth + 0.35 * srgb_sharp)
    colors = srgb_to_linear(srgb)
    lab = linear_to_oklab(colors)
    lum = (colors @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)).astype(np.float32)
    chroma = np.hypot(lab[:, 1], lab[:, 2])

    head_verts = w_head > 0.45
    head_top_y = float(out_p[head_verts, 1].max()) if head_verts.any() else head_pos[1] + 0.18
    head_front_z = float(np.percentile(out_p[head_verts, 2], 95)) if head_verts.any() else head_pos[2] + 0.10
    head_back_z = float(np.percentile(out_p[head_verts, 2], 8)) if head_verts.any() else head_pos[2] - 0.10
    head_center_x = float(head_pos[0])
    head_mid_z = 0.5 * (head_front_z + head_back_z)
    eye_y = head_pos[1] + 0.48 * (head_top_y - head_pos[1])
    nose_base_y = head_pos[1] + 0.24 * (head_top_y - head_pos[1])

    # Character-specific skin prototype from central nose bridge & inner cheeks (guaranteed bare skin)
    central_face = (
        (w_head > 0.55)
        & (np.abs(out_p[:, 0] - head_center_x) < 0.044)
        & (out_p[:, 1] > nose_base_y + 0.006)
        & (out_p[:, 1] < eye_y + 0.012)
        & (out_p[:, 2] > head_mid_z + 0.032)
    )
    if central_face.sum() < 10:
        central_face = (
            (w_head > 0.50)
            & (np.abs(out_p[:, 0] - head_center_x) < 0.052)
            & (out_p[:, 1] > nose_base_y)
            & (out_p[:, 1] < head_pos[1] + 0.65 * (head_top_y - head_pos[1]))
            & (out_p[:, 2] > head_mid_z + 0.025)
        )
    if central_face.sum() < 8:
        central_face = (w_head > 0.5) & (out_p[:, 2] > head_mid_z + 0.02)
    cf_lum = lum[central_face]
    cf_keep = (cf_lum >= np.percentile(cf_lum, 22)) & (cf_lum <= np.percentile(cf_lum, 88))
    skin_indices = np.nonzero(central_face)[0][cf_keep] if cf_keep.sum() >= 6 else np.nonzero(central_face)[0]
    skin_proto_rgb = np.median(colors[skin_indices], axis=0)
    skin_proto_lab = np.median(lab[skin_indices], axis=0)
    skin_lum = float(np.median(lum[skin_indices]))

    # Character-specific hair prototype from back & crown of cranium
    back_scalp = (
        (w_head > 0.55)
        & ((out_p[:, 2] < head_mid_z - 0.015) | (out_p[:, 1] > head_pos[1] + 0.82 * (head_top_y - head_pos[1])))
    )
    if back_scalp.sum() >= 10:
        hair_proto_lab = np.median(lab[back_scalp], axis=0)
        hair_lum = float(np.median(lum[back_scalp]))
    else:
        hair_proto_lab = np.array([0.22, 0.02, 0.02], dtype=np.float32)
        hair_lum = 0.025

    dist_skin = np.linalg.norm((lab - skin_proto_lab) * np.array([0.85, 1.55, 1.55], dtype=np.float32), axis=1)
    dist_hair = np.linalg.norm((lab - hair_proto_lab) * np.array([0.85, 1.55, 1.55], dtype=np.float32), axis=1)
    warmth = colors[:, 0] / np.maximum(colors[:, 1], 1e-4)
    is_skin_like = (dist_skin < 0.125) & (warmth > 1.18) & (lum > max(0.022, skin_lum * 0.28))

    # Build welded 3D position adjacency graph upfront for coherent hair/beard growth & despeckling
    pos_keys = np.round(out_p / 2e-4).astype(np.int64)
    _, pos_first, pos_inv = np.unique(pos_keys, axis=0, return_index=True, return_inverse=True)
    pos_inv = pos_inv.ravel()
    num_pos = len(pos_first)
    nbrs = [set() for _ in range(num_pos)]
    tris_raw = I.reshape(-1, 3)
    for t_a, t_b, t_c in tris_raw:
        pa, pb, pc = int(pos_inv[t_a]), int(pos_inv[t_b]), int(pos_inv[t_c])
        if pa != pb:
            nbrs[pa].add(pb); nbrs[pb].add(pa)
        if pb != pc:
            nbrs[pb].add(pc); nbrs[pc].add(pb)
        if pa != pc:
            nbrs[pa].add(pc); nbrs[pc].add(pa)

    SHIRT, TROUSERS, SKIN, HAIR = 1, 2, 3, 4
    regions = np.zeros(len(colors), dtype=np.int64)

    # A. Head & Face classification (NEVER assigns SHIRT on Head!)
    on_head = w_head >= 0.42
    regions[on_head] = SKIN

    dx_h = np.abs(out_p[:, 0] - head_center_x)
    dz_h = out_p[:, 2] - head_mid_z
    dy_h = (out_p[:, 1] - head_pos[1]) / max(head_top_y - head_pos[1], 0.12)

    # Eye socket box (protects sclera + iris/pupil from hair or skin recolouring across male & female proportions)
    head_span = max(head_top_y - head_pos[1], 0.12)
    eye_box = (
        on_head
        & (dx_h > 0.011) & (dx_h < 0.052)
        & (out_p[:, 1] > head_pos[1] + 0.25 * head_span)
        & (out_p[:, 1] < head_pos[1] + 0.62 * head_span)
        & (dz_h > 0.020)
    )
    eye_sclera = eye_box & (chroma < 0.068) & (lum > max(0.10, skin_lum * 1.04))
    iris_pupil = np.zeros(len(colors), dtype=bool)
    pupil_core = np.zeros(len(colors), dtype=bool)
    if eye_sclera.sum() >= 4:
        eye_cx = float(np.clip(np.median(dx_h[eye_sclera]), 0.024, 0.038))
        eye_cy = float(np.median(out_p[eye_sclera, 1]))
    else:
        eye_cx = 0.031
        eye_cy = head_pos[1] + 0.42 * head_span
    eye_rad = np.hypot(dx_h - eye_cx, (out_p[:, 1] - eye_cy) * 1.35)
    iris_pupil = on_head & (dz_h > 0.024) & (eye_rad < 0.0056)
    pupil_core = on_head & (dz_h > 0.024) & (eye_rad < 0.0027)
    eye_sclera = eye_sclera & ~iris_pupil
    eye_feature = iris_pupil | eye_sclera | (
        eye_box
        & (
            (lum < skin_lum * 0.56)
            | ((dist_skin > 0.11) & (lum < skin_lum * 0.76))
        )
    )

    # Central mid-face guard (nose bridge & inner cheeks stay SKIN)
    mid_face_skin_guard = (
        on_head
        & (dx_h < 0.046)
        & (out_p[:, 1] > nose_base_y + 0.004)
        & (out_p[:, 1] < eye_y + 0.016)
        & (dz_h > 0.032)
    )

    # Back/top/temples scalp hair vs bald skull
    hair_distinct_from_skin = float(np.linalg.norm(hair_proto_lab - skin_proto_lab)) > 0.055
    is_bald_head = force_bald or (
        (float(np.linalg.norm(hair_proto_lab - skin_proto_lab)) < 0.075)
        and (abs(hair_lum - skin_lum) < max(0.035, skin_lum * 0.36))
    )
    if is_bald_head:
        # Clean bald & clean-shaven head: keep entire cranium & face as SKIN, tagging only dark eyebrow/lash creases as HAIR
        brow_band = (
            on_head & ~eye_box
            & (dx_h > 0.012) & (dx_h < 0.054)
            & (out_p[:, 1] > eye_y + 0.008) & (out_p[:, 1] < eye_y + 0.030)
            & (dz_h > 0.028)
            & (lum < skin_lum * 0.68)
        )
        regions[brow_band] = HAIR
    else:
        is_scalp_zone = on_head & (
            (dz_h < -0.008)
            | (dy_h > 0.78)
            | ((dx_h > 0.068) & (dy_h > 0.28) & (dz_h < 0.035))
        )
        scalp_is_skin = is_scalp_zone & (dist_skin + 0.035 < dist_hair) & (lum > skin_lum * 0.62) & (dz_h > -0.035) & (dy_h < 0.72)
        regions[is_scalp_zone & ~scalp_is_skin] = HAIR

        # Front bangs, side-locks, beard, mustache & sideburns on head
        head_hair_candidate = on_head & ~eye_box & ~mid_face_skin_guard
        if hair_distinct_from_skin:
            direct_head_hair = head_hair_candidate & (
                (dist_hair + 0.008 < dist_skin)
                | ((dy_h > 0.52) & (dist_hair < dist_skin + 0.018))
                | ((dy_h < 0.38) & (((warmth < 1.28) & (lum < skin_lum * 0.68)) | (lum < min(0.035, skin_lum * 0.38))))
            )
        else:
            direct_head_hair = head_hair_candidate & (
                (lum < min(0.035, skin_lum * 0.38))
                | ((dy_h > 0.60) & ((dx_h > 0.038) | (lum < skin_lum * 0.80)))
                | ((dy_h < 0.36) & (lum < skin_lum * 0.62) & (warmth < 1.26))
            )
        regions[direct_head_hair] = HAIR

        # Grow HAIR coherently across welded mesh edges into adjacent bangs/beard locks that match hair better than skin
        pos_is_hair = np.zeros(num_pos, dtype=bool)
        np.logical_or.at(pos_is_hair, pos_inv, regions == HAIR)
        pos_can_grow_hair = np.zeros(num_pos, dtype=bool)
        grow_elig = head_hair_candidate & (
            (dist_hair < dist_skin + (0.026 if hair_distinct_from_skin else 0.012))
            | ((dy_h > 0.54) & (lum < skin_lum * 0.86))
        )
        np.logical_or.at(pos_can_grow_hair, pos_inv, grow_elig)
        for _ in range(4):
            added = False
            for p_i in np.nonzero(pos_can_grow_hair & ~pos_is_hair)[0]:
                if any(pos_is_hair[nb_j] for nb_j in nbrs[p_i]):
                    pos_is_hair[p_i] = True
                    added = True
            if not added:
                break
        grown_hair = on_head & ~eye_box & ~mid_face_skin_guard & pos_is_hair[pos_inv]
        regions[grown_hair] = HAIR

    # Preserve crisp natural eye sclera + dark iris/pupil inside eye sockets
    regions[eye_feature] = 0

    # Decorative headband / feather / metal helmet / hat on head if bright non-skin/non-hair chroma
    head_accessory = on_head & ~eye_feature & (dist_skin > 0.20) & (dist_hair > 0.18) & (chroma > 0.09)
    regions[head_accessory] = 0

    # B. Hands & Fingers: always SKIN unless dark leather gloves
    on_hand = (w_hand >= 0.45) & ~on_head
    gloved = on_hand & (dist_skin > 0.20) & (lum < min(0.035, skin_lum * 0.32))
    regions[on_hand & ~gloved] = SKIN
    regions[gloved] = 0

    # C. Feet & Footwear (boots, shoes, moccasins, sandals, or barefoot)
    shoe_top_y = 0.155
    on_foot = ((w_foot >= 0.35) | (out_p[:, 1] < shoe_top_y)) & ~on_head & ~on_hand
    foot_skin_cand = on_foot & (dist_skin < 0.085) & (warmth > 1.20) & (lum > skin_lum * 0.48)
    if on_foot.any() and (foot_skin_cand.sum() / max(int(on_foot.sum()), 1)) > 0.45:
        regions[foot_skin_cand] = SKIN
        regions[on_foot & ~foot_skin_cand] = 0
    else:
        regions[on_foot] = 0  # shoes/boots/moccasins keep natural leather paint

    # D. Torso, Neck & Arms (upper body)
    remaining = ~on_head & ~on_hand & ~on_foot
    upper_body = remaining & ((w_torso + w_arm + w_neck >= w_leg) & (out_p[:, 1] >= spine1_pos[1] - 0.06))
    regions[upper_body] = SHIRT

    # Long hair / braids / ponytails draped over neck & upper shoulders (never on bald base models)
    if is_bald_head:
        draped_hair = np.zeros(len(colors), dtype=bool)
    else:
        draped_hair = (
            upper_body
            & (out_p[:, 1] > spine3_pos[1] - 0.06)
            & (dist_hair < 0.085)
            & (lum < max(0.048, hair_lum * 1.38))
            & (dist_hair + 0.035 < dist_skin)
        )
    regions[draped_hair] = HAIR

    # Coherent bare neck, bare forearms (rolled sleeves / sleeveless), and bare chest/midriff (Indigenous attire)
    neck_skin = (
        upper_body & ~draped_hair & (w_neck > 0.18)
        & (dist_skin < 0.150) & (warmth > 1.12) & (lum > max(0.018, skin_lum * 0.25))
    )
    regions[neck_skin] = SKIN

    forearm_zone = upper_body & ~draped_hair & (w_arm > 0.32) & (np.abs(out_p[:, 0]) > 0.42)
    forearm_skin_cand = forearm_zone & (dist_skin < 0.135) & (warmth > 1.12) & (lum > skin_lum * 0.30)
    has_bare_forearms = forearm_zone.any() and (forearm_skin_cand.sum() / max(int(forearm_zone.sum()), 1)) > 0.35
    if has_bare_forearms:
        upperarm_zone = upper_body & ~draped_hair & (w_arm > 0.28) & (np.abs(out_p[:, 0]) > 0.22) & (np.abs(out_p[:, 0]) <= 0.42)
        upperarm_skin_cand = upperarm_zone & (dist_skin < 0.125) & (warmth > 1.12) & (lum > skin_lum * 0.32)
        is_sleeveless = upperarm_zone.any() and (upperarm_skin_cand.sum() / max(int(upperarm_zone.sum()), 1)) > 0.48
        min_arm_x = 0.17 if is_sleeveless else 0.36
        arm_skin = (
            upper_body & ~draped_hair & (w_arm > 0.25) & (np.abs(out_p[:, 0]) > min_arm_x)
            & (dist_skin < 0.155) & (warmth > 1.10) & (lum > skin_lum * 0.26)
        )
        regions[arm_skin] = SKIN
    else:
        is_sleeveless = False

    torso_zone = upper_body & ~draped_hair & (w_torso > 0.35)
    # Open V-neck / scoop-neck collar skin right below the throat
    open_collar_skin = (
        torso_zone
        & (out_p[:, 1] > spine3_pos[1] - 0.025)
        & (np.abs(out_p[:, 0]) < 0.115)
        & (out_p[:, 2] > spine3_pos[2] - 0.01)
        & (dist_skin < 0.135) & (warmth > 1.12) & (lum > skin_lum * 0.28)
    )
    regions[open_collar_skin] = SKIN
    # Bare chest / bare shoulders / bare midriff ONLY on genuinely sleeveless models whose torso matches skin tightly
    if is_sleeveless and torso_zone.any():
        tight_torso_skin = torso_zone & (dist_skin < 0.068) & (warmth > 1.18) & (lum > skin_lum * 0.38) & (lum < skin_lum * 1.42)
        if (tight_torso_skin.sum() / max(int(torso_zone.sum()), 1)) > 0.24:
            broad_torso_skin = torso_zone & (dist_skin < 0.088) & (warmth > 1.16) & (lum > skin_lum * 0.32) & (lum < skin_lum * 1.48)
            regions[broad_torso_skin] = SKIN

    # Waist belt / dark leather strap at waist
    waist_band = upper_body & (np.abs(out_p[:, 1] - (spine1_pos[1] + 0.01)) < 0.045) & (lum < 0.038) & (regions != SKIN)
    regions[waist_band] = 0

    # E. Legs / Breeches / Skirt / Loincloth / Stockings (lower body above footwear)
    lower_body = remaining & ~upper_body
    regions[lower_body] = TROUSERS
    calf_zone = lower_body & (out_p[:, 1] > 0.17) & (out_p[:, 1] < 0.46)
    ankle_zone = lower_body & (out_p[:, 1] > 0.155) & (out_p[:, 1] < 0.275)
    thigh_zone = lower_body & (out_p[:, 1] >= 0.50)
    calf_skin_cand = calf_zone & (dist_skin < 0.082) & (warmth > 1.20) & (lum > skin_lum * 0.48)
    ankle_skin_cand = ankle_zone & (dist_skin < 0.095) & (warmth > 1.16) & (lum > skin_lum * 0.42)
    if calf_zone.any() and (calf_skin_cand.sum() / max(int(calf_zone.sum()), 1)) > 0.52:
        # Genuinely bare lower legs (rolled breeches, knee skirts, loincloths)
        leg_skin = lower_body & (dist_skin < 0.098) & (warmth > 1.18) & (lum > skin_lum * 0.45)
        regions[leg_skin] = SKIN
    elif ankle_zone.any() and (ankle_skin_cand.sum() / max(int(ankle_zone.sum()), 1)) > 0.55:
        # Calf-length skirt/dress with bare ankles above sandals/moccasins
        leg_skin = lower_body & (out_p[:, 1] < 0.34) & (dist_skin < 0.105) & (warmth > 1.15) & (lum > skin_lum * 0.40)
        regions[leg_skin] = SKIN
    elif calf_zone.any() and thigh_zone.any():
        # Check for neutral cream/grey knitted stockings below breeches (e.g. 1550 Venetian slops + wool hose)
        calf_med_chroma = float(np.median(chroma[calf_zone]))
        calf_med_lum = float(np.median(lum[calf_zone]))
        thigh_med_lab = np.median(lab[thigh_zone], axis=0)
        calf_med_lab = np.median(lab[calf_zone], axis=0)
        if calf_med_chroma < 0.055 and calf_med_lum > 0.22 and float(np.linalg.norm(calf_med_lab - thigh_med_lab)) > 0.08:
            stockings = lower_body & (out_p[:, 1] < 0.48) & (chroma < 0.065) & (lum > 0.16)
            regions[stockings] = 0

    # Preserve high-chroma decorative woven sashes, brocaded yokes, and geometric hem borders as untinted paint (0)
    for g_reg in (SHIRT, TROUSERS):
        g_at = regions == g_reg
        if g_at.sum() >= 40:
            g_med_lab = np.median(lab[g_at], axis=0)
            g_dist = np.linalg.norm(lab - g_med_lab, axis=1)
            trim_band = g_at & (chroma > 0.105) & (g_dist > 0.135) & (dist_skin > 0.140)
            regions[trim_band] = 0

    # F. Topological 2-pass despeckling over welded 3D positions so isolated shadow pits
    # (nostrils, mouth corners, cloth creases) never become miscoloured 1-triangle islands.
    pos_reg = np.zeros(num_pos, dtype=np.int64)
    counts = np.zeros((num_pos, 5), dtype=np.int32)
    np.add.at(counts, (pos_inv, regions), 1)
    pos_reg = counts.argmax(axis=1)
    pos_eye = np.zeros(num_pos, dtype=bool)
    np.logical_or.at(pos_eye, pos_inv, eye_feature)

    for _ in range(2):
        nxt_reg = pos_reg.copy()
        for p_i in range(num_pos):
            if pos_eye[p_i] or not nbrs[p_i]:
                continue
            nb = list(nbrs[p_i])
            nb_regs = pos_reg[nb]
            vals, cnts = np.unique(nb_regs, return_counts=True)
            best_r = int(vals[cnts.argmax()])
            best_c = int(cnts.max())
            # Despeckle if >= 70% of 1-ring neighbours agree on a different region
            if best_r != pos_reg[p_i] and best_c >= max(2, math.ceil(0.70 * len(nb))):
                nxt_reg[p_i] = best_r
        pos_reg = nxt_reg
    regions = pos_reg[pos_inv]

    # Guarantee all 5 region tags [0, 1, 2, 3, 4] exist on vertex-coloured bodies (tests/crew.test.mjs invariant)
    if not textured:
        brow_fallback = (
            on_head & ~eye_feature
            & (dx_h > 0.016) & (dx_h < 0.046)
            & (out_p[:, 1] > eye_y + 0.010) & (out_p[:, 1] < eye_y + 0.024)
            & (dz_h > 0.032)
        )
        sole_fallback = out_p[:, 1] < 0.022
        for req_k, fallback_mask in (
            (0, sole_fallback if sole_fallback.any() else on_foot),
            (SHIRT, upper_body),
            (TROUSERS, lower_body),
            (SKIN, on_head),
            (HAIR, brow_fallback if brow_fallback.any() else on_head),
        ):
            if not (regions == req_k).any() and fallback_mask.any():
                idx0 = np.nonzero(fallback_mask)[0][:8]
                regions[idx0] = req_k

    print('regions:', {name: int((regions == k).sum()) for name, k in (('paint', 0), ('shirt', SHIRT), ('trousers', TROUSERS), ('skin', SKIN), ('hair', HAIR))})

    # 7. Encode vertex colours without false channel-ratio hue blowups.
    shaded = np.clip(colors.copy(), 0.0, 1.95)
    if textured:
        uv_mod = (UV % 1.0).astype(np.float32)
        # Tag both SKIN and head HAIR/beard as -11.0 (v.skin=1.0) so procedural cloth-weave bump never ripples across faces or beards!
        no_cloth_bump = (regions == SKIN) | ((regions == HAIR) & (w_head > 0.3))
        shaded = np.column_stack([uv_mod[:, 0], uv_mod[:, 1], np.where(no_cloth_bump, -11.0, -10.0).astype(np.float32)])
        keys = np.concatenate([
            np.round(out_p / 2e-4),
            np.round(out_n / 0.05),
            np.round(out_w / 0.02),
            out_j,
            np.round(uv_mod / 1e-4),
            no_cloth_bump[:, None],
        ], axis=1).astype(np.int64)
    else:
        for k, (lo_s, hi_s, chroma_mix) in (
            (SHIRT, (0.20, 1.62, 0.28)),
            (TROUSERS, (0.20, 1.62, 0.28)),
            (SKIN, (0.34, 1.36, 0.16)),
            (HAIR, (0.40, 1.42, 0.08)),
        ):
            at = regions == k
            if not at.any():
                continue
            med_lum = max(float(np.median(lum[at])), 1e-3)
            med_rgb = np.maximum(np.median(colors[at], axis=0), 1e-3)
            lum_ratio = np.clip(lum[at] / med_lum, lo_s, hi_s)[:, None]
            rgb_ratio = np.clip(colors[at] / med_rgb, lo_s, hi_s)
            if k == SKIN:
                # Preserve full dark eyelid/lash/nostril/mouth creases and warm lip tint on the face
                on_face_at = on_head[at]
                if on_face_at.any():
                    f_lum = np.clip(lum[at][on_face_at] / med_lum, 0.06, 1.42)[:, None]
                    f_rgb = np.clip(colors[at][on_face_at] / med_rgb, 0.06, 1.44)
                    f_rgb_lum = np.maximum(f_rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32), 1e-3)[:, None]
                    f_rgb_norm = f_rgb * (f_lum / f_rgb_lum)
                    lum_ratio[on_face_at] = f_lum
                    rgb_ratio[on_face_at] = f_rgb_norm
            # Normalize rgb_ratio luminance to lum_ratio so chroma_mix adds subtle warmth without hue blowup
            rgb_ratio_lum = np.maximum(rgb_ratio @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32), 1e-3)[:, None]
            rgb_norm = rgb_ratio * (lum_ratio / rgb_ratio_lum)
            cmix = np.where(on_head[at], 0.42, chroma_mix)[:, None] if k == SKIN else chroma_mix
            shade = np.clip((1.0 - cmix) * lum_ratio + cmix * rgb_norm, 0.04, 1.92).astype(np.float32)
            shaded[at] = shade
            shaded[at, 2] += 2.0 * k
        # Paint (0): keep red < 1.95 so optional dress-piece decoding (u32(r * 0.5)) stays 0
        paint_at = regions == 0
        shaded[paint_at] = np.clip(colors[paint_at], 0.0, 1.92)
        # Shade sclera with natural upper-lid occlusion so eyes never glow white, and render crisp iris + pupil disc
        if eye_sclera.any():
            shaded[eye_sclera] = np.clip(colors[eye_sclera] * 0.45, 0.08, 0.30)
        if iris_pupil.any():
            shaded[iris_pupil] = np.array([0.036, 0.021, 0.013], dtype=np.float32)
        if pupil_core.any():
            shaded[pupil_core] = np.array([0.009, 0.008, 0.008], dtype=np.float32)
        keys = np.concatenate([
            np.round(out_p / 2e-4),
            np.round(out_n / 0.05),
            np.round(out_w / 0.02),
            out_j,
            regions[:, None],
        ], axis=1).astype(np.int64)

    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.ravel()
    order = np.argsort(first)
    rank = np.zeros(len(first), dtype=np.int64)
    rank[order] = np.arange(len(first))
    remap = rank[inverse]
    tinted = np.zeros((len(first), 3), dtype=np.float64)
    hits = np.zeros(len(first), dtype=np.float64)
    np.add.at(tinted, remap, shaded)
    np.add.at(hits, remap, 1.0)
    tinted = (tinted / hits[:, None]).astype(np.float32)
    kept = first[order]
    out_p = out_p[kept]
    out_n = out_n[kept]
    out_j = out_j[kept]
    out_w = out_w[kept]
    out_uv = (UV % 1.0)[kept].astype(np.float32)
    # Each welded vertex's region (0 paint, 1 shirt, 2 trousers, 3 skin, 4 hair), so a textured body can still be
    # worn in each person's own colours. Four bytes a vertex, as glTF aligns vertex attributes.
    out_region = np.zeros((len(kept), 4), dtype=np.uint8)
    out_region[:, 0] = regions[kept].astype(np.uint8)
    faces = remap[I].reshape(-1, 3)
    faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    I_out = faces.ravel()
    print('welded vertices:', len(hits), 'triangles:', len(faces))

    # 8. Write self-contained glTF 2.0 binary (.glb)
    chunks = []
    cursor = 0
    views = []
    accessors = []

    def add_bytes(b, target=None):
        nonlocal cursor
        pad = (4 - (cursor % 4)) % 4
        if pad:
            chunks.append(b'\0' * pad)
            cursor += pad
        views.append({'buffer': 0, 'byteOffset': cursor, 'byteLength': len(b), **({'target': target} if target else {})})
        chunks.append(b)
        cursor += len(b)
        return len(views) - 1

    def add_acc(arr, target, kind, comp, extra=None):
        count = len(arr) if kind != 'SCALAR' else arr.size
        accessors.append({'bufferView': add_bytes(arr.tobytes(), target), 'componentType': comp, 'count': int(count), 'type': kind, **(extra or {})})
        return len(accessors) - 1

    dst_skin['inverseBindMatrices'] = add_acc(new_ibm, None, 'MAT4', 5126)

    new_animations = []
    for name, times, tracks_r, tracks_t in retargeted_clips:
        clip = {'name': name, 'channels': [], 'samplers': []}
        time_acc = None
        for node_idx in range(len(dst['nodes'])):
            r_arr = np.array(tracks_r[node_idx], dtype=np.float32)
            r_rest = new_rest_r[node_idx].astype(np.float32)
            if not np.all(np.abs(r_arr - r_rest[None, :]) < 1e-5) and not np.all(np.abs(r_arr + r_rest[None, :]) < 1e-5):
                if time_acc is None:
                    time_acc = add_acc(times, None, 'SCALAR', 5126, {'min': [float(times.min())], 'max': [float(times.max())]})
                out_acc = add_acc(r_arr, None, 'VEC4', 5126)
                clip['channels'].append({'sampler': len(clip['samplers']), 'target': {'node': node_idx, 'path': 'rotation'}})
                clip['samplers'].append({'input': time_acc, 'output': out_acc, 'interpolation': 'LINEAR'})

            t_arr = np.array(tracks_t[node_idx], dtype=np.float32)
            t_rest = new_rest_t[node_idx].astype(np.float32)
            if not np.all(np.abs(t_arr - t_rest[None, :]) < 1e-5):
                if time_acc is None:
                    time_acc = add_acc(times, None, 'SCALAR', 5126, {'min': [float(times.min())], 'max': [float(times.max())]})
                out_acc = add_acc(t_arr, None, 'VEC3', 5126, {'min': t_arr.min(0).tolist(), 'max': t_arr.max(0).tolist()})
                clip['channels'].append({'sampler': len(clip['samplers']), 'target': {'node': node_idx, 'path': 'translation'}})
                clip['samplers'].append({'input': time_acc, 'output': out_acc, 'interpolation': 'LINEAR'})
        new_animations.append(clip)
    dst['animations'] = new_animations

    op = out_p.astype(np.float32)
    on = (out_n / np.maximum(np.linalg.norm(out_n, axis=1, keepdims=True), 1e-9)).astype(np.float32)
    prim = {
        'attributes': {
            'POSITION': add_acc(op, 34962, 'VEC3', 5126, {'min': op.min(0).tolist(), 'max': op.max(0).tolist()}),
            'NORMAL': add_acc(on, 34962, 'VEC3', 5126),
            'COLOR_0': add_acc(tinted, 34962, 'VEC3', 5126),
            **({'TEXCOORD_0': add_acc(out_uv, 34962, 'VEC2', 5126)} if textured else {}),
            'JOINTS_0': add_acc(out_j.astype(np.uint16), 34962, 'VEC4', 5123),
            'WEIGHTS_0': add_acc(out_w.astype(np.float32), 34962, 'VEC4', 5126),
            **({'_REGION': add_acc(out_region, 34962, 'VEC4', 5121)} if textured else {}),
        },
        'indices': add_acc(I_out.astype(np.uint32), 34963, 'SCALAR', 5125),
        'material': 0,
    }

    for i, n in enumerate(dst['nodes']):
        if 'mesh' in n and i != body_node:
            n.pop('mesh', None)
            n.pop('skin', None)
    dst['nodes'][body_node]['mesh'] = 0
    dst['nodes'][body_node]['skin'] = 0

    material = {
        'name': 'Crew character material',
        'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': 0.9},
        'doubleSided': True,
    }
    dst.pop('images', None)
    dst.pop('textures', None)
    dst.pop('samplers', None)
    if textured and image is not None:
        if full_texture:
            # The generated texture, byte for byte.
            img_bytes = raw_image
            mime = 'image/png' if raw_image[:4] == b'\x89PNG' else 'image/jpeg'
        else:
            tex_img = image
            if max(tex_img.size) > 2048:
                tex_img = tex_img.resize((2048, 2048), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            tex_img.save(buf, format='JPEG', quality=87, optimize=True)
            if len(buf.getvalue()) > 880_000:
                buf = io.BytesIO()
                tex_img.save(buf, format='JPEG', quality=80, optimize=True)
            img_bytes = buf.getvalue()
            mime = 'image/jpeg'
        img_view = add_bytes(img_bytes)
        dst['images'] = [{'bufferView': img_view, 'mimeType': mime}]
        dst['textures'] = [{'source': 0}]
        material['pbrMetallicRoughness']['baseColorTexture'] = {'index': 0}

    dst.update(meshes=[{'name': 'sailor', 'primitives': [prim]}], materials=[material], accessors=accessors, bufferViews=views)
    new_bin = b''.join(chunks)
    new_bin += b'\0' * ((4 - len(new_bin) % 4) % 4)
    dst['buffers'] = [{'byteLength': len(new_bin)}]
    js = json.dumps(dst, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    with open(out_path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(new_bin)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack('<II', len(new_bin), 0x004E4942))
        f.write(new_bin)
    print('wrote', out_path, len(new_bin) // 1024, 'KB')


if __name__ == '__main__':
    main()
