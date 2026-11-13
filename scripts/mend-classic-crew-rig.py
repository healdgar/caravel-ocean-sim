#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Mends human rig proportions and posture on sailor-classic.glb and sailor-female-classic.glb.

Fixes three upstream superhero-rig issues inherited by all fitted crew & townsfolk models:
1. Oversized comic-book hands: scales 30 finger bone local translations (and classic hand vertices)
   around hand_l / hand_r by 0.76 (male) / 0.82 (female), leaving wrist IK grips untouched.
2. Stretched shins (calf > thigh): lowers calf_l / calf_r knee rest Y by -0.036 m (male) /
   -0.044 m (female) while adjusting foot_l / foot_r local translation so ankles and toes remain
   at their exact world positions (thigh > calf, 1.0x natural Tripo calf proportion).
3. Hunched turtle-neck posture in Idle & Walk: applies constant local counter-pitch across
   spine_02, spine_03, neck_01, and gentle shoulder draw-back on clavicle_l/r + upperarm_l/r,
   bringing gaze level with the horizon while preserving loop closure and Brace crouch.
"""
import json, math, struct, sys
import numpy as np


def read_glb(path):
    data = open(path, 'rb').read()
    n = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + n])
    start = 20 + n + 8
    return doc, bytearray(data[start:start + doc['buffers'][0]['byteLength']])


def write_glb(path, doc, bin_bytes):
    pad_b = (4 - len(bin_bytes) % 4) % 4
    if pad_b:
        bin_bytes = bytes(bin_bytes) + b'\0' * pad_b
    else:
        bin_bytes = bytes(bin_bytes)
    doc['buffers'][0]['byteLength'] = len(bin_bytes)
    js = json.dumps(doc, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_bytes)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack('<II', len(bin_bytes), 0x004E4942))
        f.write(bin_bytes)


TYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
SIZES = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def get_acc(doc, bin_buf, idx):
    a = doc['accessors'][idx]
    v = doc['bufferViews'][a['bufferView']]
    t = TYPES[a['componentType']]
    sz = SIZES[a['type']]
    item = np.dtype(t).itemsize
    stride = v.get('byteStride') or (sz * item)
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    if stride != sz * item:
        raise RuntimeError('Interleaved accessor not expected in classic crew GLB')
    arr = np.frombuffer(bin_buf, dtype=t, count=a['count'] * sz, offset=start).copy()
    return arr.reshape(a['count'], sz) if sz > 1 else arr


def set_acc(doc, bin_buf, idx, arr):
    a = doc['accessors'][idx]
    v = doc['bufferViews'][a['bufferView']]
    t = TYPES[a['componentType']]
    sz = SIZES[a['type']]
    item = np.dtype(t).itemsize
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    flat = np.asarray(arr, dtype=t).ravel()
    raw = flat.tobytes()
    bin_buf[start:start + len(raw)] = raw
    if 'min' in a and 'max' in a:
        shaped = flat.reshape(-1, sz)
        a['min'] = shaped.min(axis=0).astype(float).tolist()
        a['max'] = shaped.max(axis=0).astype(float).tolist()


def quat_mul(a, b):
    ax, ay, az, aw = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    out = np.stack([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ], axis=-1)
    return out / np.maximum(np.linalg.norm(out, axis=-1, keepdims=True), 1e-12)


def quat_inv(q):
    out = np.array(q, dtype=np.float64, copy=True)
    out[..., :3] *= -1.0
    return out


def axis_angle_quat(axis, angle):
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / max(np.linalg.norm(axis), 1e-12)
    h = 0.5 * angle
    return np.array([axis[0] * math.sin(h), axis[1] * math.sin(h), axis[2] * math.sin(h), math.cos(h)], dtype=np.float64)


def mat_from_trs(t, r, s):
    x, y, z, w = r
    rm = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float64)
    m = np.eye(4, dtype=np.float64)
    m[:3, :3] = rm * np.asarray(s, dtype=np.float64)
    m[:3, 3] = t
    return m


def rot_to_quat(m):
    r = m[:3, :3] / max(np.linalg.norm(m[:3, 0]), 1e-12)
    tr = r[0, 0] + r[1, 1] + r[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2.0
        q = np.array([(r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, 0.25 * s])
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2.0
        q = np.array([0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s, (r[2, 1] - r[1, 2]) / s])
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2.0
        q = np.array([(r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s, (r[0, 2] - r[2, 0]) / s])
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2.0
        q = np.array([(r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s, (r[1, 0] - r[0, 1]) / s])
    return q / np.linalg.norm(q)


def compute_worlds(nodes, overrides=None):
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
    cache = {}

    def wm(i):
        if i not in cache:
            n = nodes[i]
            ov = (overrides or {}).get(i, {})
            t = ov.get('t', n.get('translation', [0.0, 0.0, 0.0]))
            r = ov.get('r', n.get('rotation', [0.0, 0.0, 0.0, 1.0]))
            s = ov.get('s', n.get('scale', [1.0, 1.0, 1.0]))
            loc = mat_from_trs(t, r, s)
            cache[i] = (wm(parent[i]) @ loc) if i in parent else loc
        return cache[i]

    return [wm(i) for i in range(len(nodes))], parent


def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def surface_normals(pos, indices, fallback):
    normals = np.zeros_like(pos, dtype=np.float64)
    tris = indices.reshape(-1, 3)
    u = pos[tris[:, 1]] - pos[tris[:, 0]]
    v = pos[tris[:, 2]] - pos[tris[:, 0]]
    fn = np.cross(u, v)
    for k in range(3):
        np.add.at(normals, tris[:, k], fn)
    keys = np.round(pos * 1e5).astype(np.int64)
    _, inv = np.unique(keys, axis=0, return_inverse=True)
    summed = np.zeros((inv.max() + 1, 3), dtype=np.float64)
    np.add.at(summed, inv, normals)
    normals = summed[inv]
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    return np.where(lengths > 1e-10, normals / np.maximum(lengths, 1e-10), fallback).astype(np.float32)


def mend_classic_glb(path, female=False):
    doc, bin_buf = read_glb(path)
    extras = doc.setdefault('extras', {})
    if extras.get('rigMendedRevision') == 1 and '--force' not in sys.argv:
        print(f'{path}: already mended (rigMendedRevision=1), skipping')
        return

    nodes = doc['nodes']
    by_name = {n.get('name', ''): i for i, n in enumerate(nodes)}
    skin = doc['skins'][0]
    joints = skin['joints']
    slot_of_name = {nodes[j]['name']: s for s, j in enumerate(joints)}

    old_worlds, parent = compute_worlds(nodes)

    # Pre-measure planted foot/ball world Y at every keyframe of every clip BEFORE rig mend
    old_clip_ground = {}
    for anim in doc.get('animations', []):
        aname = anim.get('name', '')
        ch_map = {(ch['target']['node'], ch['target']['path']): ch for ch in anim['channels']}
        pel_t_ch = ch_map.get((by_name['pelvis'], 'translation'))
        if not pel_t_ch:
            continue
        n_keys = doc['accessors'][anim['samplers'][pel_t_ch['sampler']]['input']]['count']
        key_data = {}
        for (ni, path_kind), ch in ch_map.items():
            key_data[(ni, path_kind)] = get_acc(doc, bin_buf, anim['samplers'][ch['sampler']]['output']).astype(np.float64)
        ys = []
        for k in range(n_keys):
            ov = {}
            for (ni, path_kind), arr in key_data.items():
                ov.setdefault(ni, {})['r' if path_kind == 'rotation' else 't'] = arr[min(k, len(arr) - 1)]
            wk, _ = compute_worlds(nodes, ov)
            ys.append(min(wk[by_name['foot_l']][1, 3], wk[by_name['foot_r']][1, 3], wk[by_name['ball_l']][1, 3], wk[by_name['ball_r']][1, 3]))
        old_clip_ground[aname] = ys

    hand_scale = 0.82 if female else 0.76
    knee_drop = 0.044 if female else 0.036

    # 1. Scale 15 finger bone local translations per hand around hand_l / hand_r.
    finger_slots_by_side = {'l': set(), 'r': set()}
    for side in ('l', 'r'):
        finger_slots_by_side[side].add(slot_of_name[f'hand_{side}'])
        for finger in ('thumb', 'index', 'middle', 'ring', 'pinky'):
            for k in (1, 2, 3):
                jn = f'{finger}_0{k}_{side}'
                ni = by_name[jn]
                t = np.array(nodes[ni].get('translation', [0.0, 0.0, 0.0]), dtype=np.float64)
                nodes[ni]['translation'] = (t * hand_scale).tolist()
                finger_slots_by_side[side].add(slot_of_name[jn])

    # 2. Lower calf_l / calf_r rest Y by knee_drop while keeping foot_l / foot_r and ball_l / ball_r world matrices fixed.
    leg_info = {}
    for side in ('l', 'r'):
        thigh_i = by_name[f'thigh_{side}']
        calf_i = by_name[f'calf_{side}']
        foot_i = by_name[f'foot_{side}']
        w_thigh = old_worlds[thigh_i]
        p_thigh = w_thigh[:3, 3].copy()
        p_calf_old = old_worlds[calf_i][:3, 3].copy()
        p_foot_old = old_worlds[foot_i][:3, 3].copy()
        p_calf_new = p_calf_old + np.array([0.0, -knee_drop, 0.0])

        t_calf_new = (np.linalg.inv(w_thigh) @ np.append(p_calf_new, 1.0))[:3]
        nodes[calf_i]['translation'] = t_calf_new.tolist()

        w_calf_new = w_thigh @ mat_from_trs(
            nodes[calf_i]['translation'],
            nodes[calf_i].get('rotation', [0.0, 0.0, 0.0, 1.0]),
            nodes[calf_i].get('scale', [1.0, 1.0, 1.0]),
        )
        t_foot_new = (np.linalg.inv(w_calf_new) @ np.append(p_foot_old, 1.0))[:3]
        nodes[foot_i]['translation'] = t_foot_new.tolist()
        leg_info[side] = (p_thigh[1], p_calf_old[1], p_calf_new[1], p_foot_old[1])

    new_worlds, _ = compute_worlds(nodes)

    # Verify foot_l/r and hand_l/r world positions are untouched!
    for check_name in ('hand_l', 'hand_r', 'foot_l', 'foot_r', 'ball_l', 'ball_r', 'Head'):
        ni = by_name[check_name]
        err = np.linalg.norm(new_worlds[ni][:3, 3] - old_worlds[ni][:3, 3])
        assert err < 1e-6, f'{check_name} world position drifted by {err}'

    # Recompute inverseBindMatrices = inv(new_world) in column-major glTF MAT4 order.
    ibm_cols = []
    for j in joints:
        inv_w = np.linalg.inv(new_worlds[j]).astype(np.float32)
        ibm_cols.append(inv_w.T.ravel())
    set_acc(doc, bin_buf, skin['inverseBindMatrices'], np.stack(ibm_cols, axis=0))

    # 3. Smoothly remap classic mesh vertices (hands/wrists + knees/garter bands) so classic body matches mended rig.
    for mi, mesh in enumerate(doc['meshes']):
        mname = mesh.get('name', '')
        for prim in mesh['primitives']:
            attrs = prim['attributes']
            pos = get_acc(doc, bin_buf, attrs['POSITION']).astype(np.float64)
            norm = get_acc(doc, bin_buf, attrs['NORMAL']).astype(np.float64)
            jts = get_acc(doc, bin_buf, attrs['JOINTS_0']).astype(np.int64)
            wts = get_acc(doc, bin_buf, attrs['WEIGHTS_0']).astype(np.float64)
            wts_sum = np.maximum(wts.sum(axis=1, keepdims=True), 1e-9)
            wn = wts / wts_sum

            changed = False
            # Hand & distal wrist scaling around hand_l / hand_r
            for side in ('l', 'r'):
                hand_pos = old_worlds[by_name[f'hand_{side}']][:3, 3]
                elbow_pos = old_worlds[by_name[f'lowerarm_{side}']][:3, 3]
                arm_vec = hand_pos - elbow_pos
                arm_len2 = float(arm_vec @ arm_vec)
                t_arm = ((pos - elbow_pos) @ arm_vec) / max(arm_len2, 1e-9)
                wrist_ramp = smoothstep(0.76, 1.0, t_arm)

                in_hand = np.isin(jts, list(finger_slots_by_side[side]))
                w_hand = (wn * in_hand).sum(axis=1)
                w_low = (wn * (jts == slot_of_name[f'lowerarm_{side}'])).sum(axis=1)
                eff = np.clip(w_hand + w_low * wrist_ramp, 0.0, 1.0)
                if np.any(eff > 1e-4):
                    pos += (pos - hand_pos) * ((hand_scale - 1.0) * eff)[:, None]
                    changed = True

            # Leg knee height remapping
            for side in ('l', 'r'):
                thigh_y, calf_old_y, calf_new_y, foot_y = leg_info[side]
                leg_slots = [slot_of_name[f'thigh_{side}'], slot_of_name[f'calf_{side}']]
                w_leg = (wn * np.isin(jts, leg_slots)).sum(axis=1)
                if np.any(w_leg > 1e-4):
                    y = pos[:, 1]
                    y_mapped = np.where(
                        y >= calf_old_y,
                        calf_new_y + (y - calf_old_y) * ((thigh_y - calf_new_y) / (thigh_y - calf_old_y)),
                        foot_y + (y - foot_y) * ((calf_new_y - foot_y) / (calf_old_y - foot_y)),
                    )
                    # Keep below-ankle boots (y <= foot_y + 0.04) untouched
                    above_ankle = smoothstep(foot_y + 0.02, foot_y + 0.09, y) * (1.0 - smoothstep(thigh_y - 0.04, thigh_y + 0.03, y))
                    pos[:, 1] += (y_mapped - y) * w_leg * above_ankle
                    changed = True

            if changed:
                set_acc(doc, bin_buf, attrs['POSITION'], pos.astype(np.float32))
                if mname.startswith(('Sphere', 'Superhero', 'Rolled', 'Knee')):
                    idx_arr = get_acc(doc, bin_buf, prim['indices']).astype(np.int64)
                    set_acc(doc, bin_buf, attrs['NORMAL'], surface_normals(pos, idx_arr, norm))

    # 4. Mend hunched posture in Idle and Walk clips (leaving Brace crouch intact).
    # Constant local counter-rotations preserve exact loop closure (frame[0] == frame[-1]).
    pitch_fixes = {
        'spine_02': axis_angle_quat([1.0, 0.0, 0.0], -0.065),
        'spine_03': axis_angle_quat([1.0, 0.0, 0.0], -0.125),
        'neck_01': axis_angle_quat([1.0, 0.0, 0.0], -0.060),
    }
    # Gentle shoulder roll-back around world +Y: clavicle local Z is world +Y ([0, 1, 0]).
    # Counter-yaw upperarm in world +Y so hands/forearms keep their natural forward alignment.
    shoulder_back = 0.065
    for anim in doc.get('animations', []):
        aname = anim.get('name', '')
        if aname not in ('Idle', 'Walk'):
            continue
        ch_by_node_path = {(ch['target']['node'], ch['target']['path']): ch for ch in anim['channels']}

        for bname, dq_local in pitch_fixes.items():
            ni = by_name[bname]
            ch = ch_by_node_path.get((ni, 'rotation'))
            if not ch:
                continue
            out_idx = anim['samplers'][ch['sampler']]['output']
            qs = get_acc(doc, bin_buf, out_idx).astype(np.float64)
            qs_new = quat_mul(qs, dq_local)
            set_acc(doc, bin_buf, out_idx, qs_new.astype(np.float32))

        # Roll clavicles back slightly around local Z (world +Y) and counter-rotate upperarms in world +Y
        for side, sign in (('l', 1.0), ('r', -1.0)):
            clav_i = by_name[f'clavicle_{side}']
            uarm_i = by_name[f'upperarm_{side}']
            ch_c = ch_by_node_path.get((clav_i, 'rotation'))
            ch_u = ch_by_node_path.get((uarm_i, 'rotation'))
            if ch_c and ch_u:
                # Local +Z on clavicle_l/r points along world +Y; sign=+1 rotates left clavicle (+X) toward -Z (back)!
                dq_clav = axis_angle_quat([0.0, 0.0, 1.0], sign * shoulder_back)
                out_c = anim['samplers'][ch_c['sampler']]['output']
                qc = get_acc(doc, bin_buf, out_c).astype(np.float64)
                set_acc(doc, bin_buf, out_c, quat_mul(qc, dq_clav).astype(np.float32))

                # Counter-rotate upperarm around its rest-frame axis corresponding to world +Y so forearm orientation stays clean
                uarm_world_rot = new_worlds[uarm_i][:3, :3]
                local_world_y = uarm_world_rot.T @ np.array([0.0, 1.0, 0.0])
                dq_uarm = axis_angle_quat(local_world_y, -sign * shoulder_back)
                out_u = anim['samplers'][ch_u['sampler']]['output']
                qu = get_acc(doc, bin_buf, out_u).astype(np.float64)
                set_acc(doc, bin_buf, out_u, quat_mul(qu, dq_uarm).astype(np.float32))

    # 5. Re-ground pelvis vertical translation per keyframe across Idle, Walk, and Brace so stance feet stay exact on deck.
    root_rot_inv = new_worlds[by_name['root']][:3, :3].T if 'root' in by_name else np.eye(3)
    for anim in doc.get('animations', []):
        aname = anim.get('name', '')
        if aname not in old_clip_ground:
            continue
        ch_map = {(ch['target']['node'], ch['target']['path']): ch for ch in anim['channels']}
        pel_t_ch = ch_map.get((by_name['pelvis'], 'translation'))
        if not pel_t_ch:
            continue
        pel_out_idx = anim['samplers'][pel_t_ch['sampler']]['output']
        pel_t = get_acc(doc, bin_buf, pel_out_idx).astype(np.float64)
        key_data = {}
        for (ni, path_kind), ch in ch_map.items():
            key_data[(ni, path_kind)] = get_acc(doc, bin_buf, anim['samplers'][ch['sampler']]['output']).astype(np.float64)
        old_ys = old_clip_ground[aname]
        for k in range(len(pel_t)):
            ov = {}
            for (ni, path_kind), arr in key_data.items():
                ov.setdefault(ni, {})['r' if path_kind == 'rotation' else 't'] = arr[min(k, len(arr) - 1)]
            wk, _ = compute_worlds(nodes, ov)
            new_y = min(wk[by_name['foot_l']][1, 3], wk[by_name['foot_r']][1, 3], wk[by_name['ball_l']][1, 3], wk[by_name['ball_r']][1, 3])
            dy = new_y - old_ys[k]
            pel_t[k] += root_rot_inv @ np.array([0.0, -dy, 0.0])
        pel_t[-1] = pel_t[0]
        set_acc(doc, bin_buf, pel_out_idx, pel_t.astype(np.float32))

    extras['rigMendedRevision'] = 1
    write_glb(path, doc, bin_buf)
    thigh_len = new_worlds[by_name['thigh_l']][1, 3] - new_worlds[by_name['calf_l']][1, 3]
    calf_len = new_worlds[by_name['calf_l']][1, 3] - new_worlds[by_name['foot_l']][1, 3]
    hand_len = np.linalg.norm(new_worlds[by_name['middle_03_l']][:3, 3] - new_worlds[by_name['hand_l']][:3, 3])
    print(f'mended {path}: thigh={thigh_len:.4f}m > calf={calf_len:.4f}m, hand->mid3={hand_len:.4f}m')


if __name__ == '__main__':
    mend_classic_glb('assets/crew/sailor-classic.glb', female=False)
    mend_classic_glb('assets/crew/sailor-female-classic.glb', female=True)
