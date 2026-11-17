#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Moves a crew GLB from the classic 65-joint rig onto the crew skeleton: Unreal 5's 80-joint body and 13 face
joints (scripts/crew_skeleton.py).

Nothing the body does changes. The classic rig's own joints keep their places and turns; 'Head' is named 'head';
the joints Unreal adds are placed along the bones the classic rig has and start turned as their parents are, so
they carry no weight and no clip moves them until a body fitted to them (scripts/fit-crew-body.py) gives them skin;
the face joints are placed on the face's own features. The fingertip and toe-tip end joints, which carry no skin,
are dropped. Clips keep every key; a joint that changes parent keeps its place in the world.

  python3 scripts/extend-crew-skeleton.py in.glb [out.glb]      (out defaults to in, rewritten in place)

Needs numpy.
"""
import json, math, os, struct, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crew_skeleton import JOINTS, PARENT, INSERTED, FACE_JOINTS, face_landmarks  # noqa: E402

TYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
SIZES = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    data = open(path, 'rb').read()
    n = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + n])
    start = 20 + n + 8
    return doc, data[start:start + doc['buffers'][0]['byteLength']]


def view_bytes(doc, bin_, v):
    view = doc['bufferViews'][v]
    at = view.get('byteOffset', 0)
    return bin_[at:at + view['byteLength']]


def accessor(doc, bin_, index):
    a = doc['accessors'][index]
    view = doc['bufferViews'][a['bufferView']]
    t, size = TYPES[a['componentType']], SIZES[a['type']]
    if view.get('byteStride') not in (None, size * np.dtype(t).itemsize):
        raise SystemExit('Interleaved buffers are not handled')
    start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
    return np.frombuffer(bin_, dtype=t, count=a['count'] * size, offset=start).reshape(a['count'], size).copy()


def quat_to_mat3(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def mat3_to_quat(m):
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def local_matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix'], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    m[:3, :3] = quat_to_mat3(node.get('rotation', [0, 0, 0, 1])) * np.array(node.get('scale', [1, 1, 1]))
    m[:3, 3] = node.get('translation', [0, 0, 0])
    return m


def worlds_of(nodes):
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
    out = {}

    def get(i):
        if i not in out:
            out[i] = (get(parent[i]) if i in parent else np.eye(4)) @ local_matrix(nodes[i])
        return out[i]
    for i in range(len(nodes)):
        get(i)
    return out, parent


def write_glb(path, doc, views):
    """views: one bytes object per bufferView, in order; the binary chunk is packed afresh."""
    chunks, at = [], 0
    for v, data in zip(doc['bufferViews'], views):
        pad = (-at) % 4
        if pad:
            chunks.append(b'\0' * pad)
            at += pad
        v['byteOffset'] = at
        v['byteLength'] = len(data)
        v['buffer'] = 0
        chunks.append(data)
        at += len(data)
    chunks.append(b'\0' * ((-at) % 4))
    binary = b''.join(chunks)
    doc['buffers'] = [{'byteLength': len(binary)}]
    text = json.dumps(doc, separators=(',', ':')).encode()
    text += b' ' * ((-len(text)) % 4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(text), 0x4E4F534A) + text)
        f.write(struct.pack('<II', len(binary), 0x004E4942) + binary)


def extend(src_path, out_path):
    doc, bin_ = read_glb(src_path)
    nodes = doc['nodes']
    skin = doc['skins'][0]
    old_slots = list(skin['joints'])
    old_names = [nodes[j]['name'] for j in old_slots]
    if len(old_slots) == len(JOINTS) and old_names == list(JOINTS):
        print(f'{src_path}: already on the crew skeleton')
        return
    if len(old_slots) != 65 or 'Head' not in old_names:
        raise SystemExit(f'{src_path}: expected the classic 65-joint rig, found {len(old_slots)} joints')
    for i in old_slots:
        if nodes[i]['name'] == 'Head':
            nodes[i]['name'] = 'head'
    by_name = {nodes[j]['name']: j for j in old_slots}
    worlds, parent_of = worlds_of(nodes)

    # Where the body is at rest: every skinned vertex carried by its joints, and how much the head carries each.
    ibm = accessor(doc, bin_, skin['inverseBindMatrices']).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    head_slot = old_names.index('Head')
    points, head_w = [], []
    for n in nodes:
        if 'mesh' not in n or 'skin' not in n:
            continue
        for prim in doc['meshes'][n['mesh']]['primitives']:
            a = prim['attributes']
            p = accessor(doc, bin_, a['POSITION']).astype(np.float64)
            js = accessor(doc, bin_, a['JOINTS_0']).astype(np.int64)
            ws = accessor(doc, bin_, a['WEIGHTS_0']).astype(np.float64)
            if a.get('WEIGHTS_0') is not None and doc['accessors'][a['WEIGHTS_0']].get('normalized'):
                ws = ws / np.iinfo(TYPES[doc['accessors'][a['WEIGHTS_0']]['componentType']]).max
            ph = np.c_[p, np.ones(len(p))]
            rest = np.zeros((len(p), 3))
            for k in range(4):
                mats = np.array([worlds[old_slots[s]] @ ibm[s] for s in range(len(old_slots))])[js[:, k]]
                rest += ws[:, k:k + 1] * np.einsum('nij,nj->ni', mats, ph)[:, :3]
            points.append(rest)
            head_w.append(np.where(js == head_slot, ws, 0.0).sum(axis=1))
    points, head_w = np.concatenate(points), np.concatenate(head_w)

    # The world place of every joint of the crew skeleton.
    place = {name: worlds[by_name[name]][:3, 3] for name in JOINTS if name in by_name}
    for name in ('spine_04', 'spine_05', 'neck_02'):
        a, b, f = INSERTED[name]
        place[name] = place[a] * (1 - f) + place[b] * f
    for name, (a, b, f) in INSERTED.items():
        if name not in place:
            place[name] = place[a] * (1 - f) + place[b] * f
    marks, _ = face_landmarks(points, head_w, place['head'])
    place.update(marks)

    # New nodes for the joints the classic rig lacks; its end joints go.
    leaves = [j for j in old_slots if '_leaf' in nodes[j]['name']]
    for j in leaves:
        if worlds[j] is not None and any(nodes[j].get('children', [])):
            raise SystemExit(f'{nodes[j]["name"]} has children')
    created = {}
    for name in JOINTS:
        if name not in by_name:
            created[name] = len(nodes)
            nodes.append({'name': name})
    node_of = {**by_name, **created}

    # Every joint's parent as the crew skeleton has it; a joint keeps its place in the world, and a new joint is
    # turned as its parent is, so its frame is its parent's moved along.
    new_world = {}
    for name in JOINTS:
        i = node_of[name]
        if name in by_name:
            new_world[i] = worlds[i]
        else:
            m = new_world[node_of[PARENT[name]]].copy() if PARENT[name] else np.eye(4)
            m[:3, 3] = place[name]
            new_world[i] = m
    for name in JOINTS:
        i = node_of[name]
        p = PARENT[name]
        if p is None:
            continue
        pi = node_of[p]
        old_parent = parent_of.get(i)
        if old_parent == pi and name in by_name:
            continue
        local = np.linalg.inv(new_world[pi]) @ new_world[i]
        node = nodes[i]
        node.pop('matrix', None)
        scale = np.linalg.norm(local[:3, :3], axis=0)
        node['translation'] = [float(x) for x in local[:3, 3]]
        node['rotation'] = [float(x) for x in mat3_to_quat(local[:3, :3] / scale)]
        if np.allclose(scale, 1, atol=1e-6):
            node.pop('scale', None)
        else:
            node['scale'] = [float(x) for x in scale]
    children = {}
    for name in JOINTS:
        if PARENT[name]:
            children.setdefault(node_of[PARENT[name]], []).append(node_of[name])
    joint_nodes = set(node_of.values()) | set(leaves)
    for i, n in enumerate(nodes):
        others = [c for c in n.get('children', []) if c not in joint_nodes]
        mine = children.get(i, [])
        if others or mine:
            n['children'] = others + mine
        else:
            n.pop('children', None)
    root_holder = parent_of[by_name['root']]
    if by_name['root'] not in nodes[root_holder].get('children', []):
        nodes[root_holder].setdefault('children', []).append(by_name['root'])

    # Clips: keys on the end joints go; a key that moves a joint whose parent changed is counted from the new parent.
    for anim in doc.get('animations', []):
        anim['channels'] = [c for c in anim['channels'] if c['target']['node'] not in leaves]
        for c in anim['channels']:
            i = c['target']['node']
            if c['target']['path'] != 'translation':
                continue
            name = nodes[i]['name']
            if PARENT.get(name) and parent_of.get(i) != node_of[PARENT[name]]:
                raise SystemExit(f'{name} is moved by a clip and changes parent; not handled')

    # Remove the end joints' nodes and renumber every reference.
    keep = [i for i in range(len(nodes)) if i not in set(leaves)]
    renumber = {old: new for new, old in enumerate(keep)}
    doc['nodes'] = [nodes[i] for i in keep]
    for n in doc['nodes']:
        if 'children' in n:
            n['children'] = [renumber[c] for c in n['children']]
    for scene in doc.get('scenes', []):
        scene['nodes'] = [renumber[c] for c in scene['nodes']]
    for anim in doc.get('animations', []):
        for c in anim['channels']:
            c['target']['node'] = renumber[c['target']['node']]
        used = sorted({c['sampler'] for c in anim['channels']})
        remap = {old: new for new, old in enumerate(used)}
        anim['samplers'] = [anim['samplers'][s] for s in used]
        for c in anim['channels']:
            c['sampler'] = remap[c['sampler']]
    new_slots = [renumber[node_of[name]] for name in JOINTS]
    skin['joints'] = new_slots
    skin.pop('skeleton', None)

    # Inverse bind matrices from the joints' places at rest, and each vertex's joints renumbered; any weight an end
    # joint held goes to the joint it ends.
    views = [view_bytes(doc, bin_, v) for v in range(len(doc['bufferViews']))]

    def replace(acc_index, array, component_type, kind):
        data = np.ascontiguousarray(array).tobytes()
        views.append(data)
        doc['bufferViews'].append({'buffer': 0, 'byteLength': len(data)})
        a = doc['accessors'][acc_index]
        a.update(bufferView=len(doc['bufferViews']) - 1, componentType=component_type, count=len(array), type=kind)
        a.pop('byteOffset', None)
        a.pop('min', None)
        a.pop('max', None)

    bind = np.array([np.linalg.inv(new_world[node_of[name]]).T for name in JOINTS], dtype=np.float32)
    replace(skin['inverseBindMatrices'], bind.reshape(len(JOINTS), 16), 5126, 'MAT4')
    slot_of = {name: s for s, name in enumerate(JOINTS)}
    old_to_new = []
    for name in old_names:
        if '_leaf' in name:
            name = name.replace('_04_leaf', '_03').replace('ball_leaf', 'ball')
        old_to_new.append(slot_of['head' if name == 'Head' else name])
    old_to_new = np.array(old_to_new)
    done = set()
    for n in doc['nodes']:
        if 'mesh' not in n or 'skin' not in n:
            continue
        for prim in doc['meshes'][n['mesh']]['primitives']:
            index = prim['attributes']['JOINTS_0']
            if index in done:
                continue
            done.add(index)
            js = accessor(doc, bin_, index).astype(np.int64)
            replace(index, old_to_new[js].astype(np.uint16), 5123, 'VEC4')

    # Drop buffer views nothing refers to any more.
    used = {a['bufferView'] for a in doc['accessors'] if 'bufferView' in a} | {im['bufferView'] for im in doc.get('images', []) if 'bufferView' in im}
    order = [v for v in range(len(doc['bufferViews'])) if v in used]
    remap = {old: new for new, old in enumerate(order)}
    doc['bufferViews'] = [doc['bufferViews'][v] for v in order]
    views = [views[v] for v in order]
    for a in doc['accessors']:
        if 'bufferView' in a:
            a['bufferView'] = remap[a['bufferView']]
    for im in doc.get('images', []):
        if 'bufferView' in im:
            im['bufferView'] = remap[im['bufferView']]
    extras = doc.setdefault('extras', {})
    extras['skeleton'] = 'crew-ue5-80+face-13'
    write_glb(out_path, doc, views)
    print(f'{out_path}: {len(JOINTS)} joints ({len(created)} added, {len(leaves)} end joints dropped)')


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        raise SystemExit('Usage: python3 scripts/extend-crew-skeleton.py in.glb [out.glb]')
    extend(args[0], args[1] if len(args) > 1 else args[0])
