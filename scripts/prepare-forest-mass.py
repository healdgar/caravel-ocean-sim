#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Offline native leaf-field assembly. Never grow or read a crown-dome range.

Continuous area density and pigment moments come from prepare-forest-fields.py.
The same immutable mature fields produce individual intermediate meshes and a
shared-lattice forest union. This is an authored optical volume, not a certified
replacement for the detailed source's alpha geometry. Root runs native rendered
comparisons before installing its output.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import shutil
import tempfile
import time

import numpy as np
from scipy.ndimage import map_coordinates
from skimage.measure import marching_cubes
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('forest_mass_ground', ROOT/'scripts/prepare-forest-canopy.py')
GROUND = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(GROUND)
NO_OWNER = 0xffffffff


def require(ok, message):
    if not ok: raise ValueError(message)


def receipt(raw):
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def read_verified(folder, item):
    name = item['file']; require(Path(name).name == name, 'Unsafe field filename')
    raw = (folder/name).read_bytes()
    require(receipt(raw) == {k: item[k] for k in ('bytes', 'sha256')}, 'Field receipt differs: '+name)
    return raw


def gzip_bytes(raw):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, filename='', mode='wb', compresslevel=9, mtime=0) as f: f.write(raw)
    return output.getvalue()


def read_fields(folder, native):
    raw = (folder/'manifest.json').read_bytes(); m = json.loads(raw)
    require(m.get('format') == 'waterworld.native-forest-fields' and m.get('version') == 1, 'Expected original native field cache')
    for key in ('vertices.bin', 'indices.bin', 'roots.bin'):
        actual = m['source']['files'][key]
        require(all(actual[k] == native['files'][key][k] for k in ('bytes', 'sha256')), 'Field/native source differs: '+key)
    fields = []
    for p in m['prototypes']:
        encoded = read_verified(folder, p['field'])
        with np.load(io.BytesIO(encoded), allow_pickle=False) as data:
            origin = np.asarray(data['originXYZ'], dtype=np.float64)
            cell = float(data['cellMetres']); density = np.asarray(data['density'], dtype=np.float32)
            moment = np.asarray(data['rgbMoment'], dtype=np.float32)
        require(p['id'] == len(fields) and p['species'] == native['prototypes'][p['id']]['species'], 'Field prototype identity differs')
        require(origin.shape == (3,) and density.ndim == 3 and moment.shape == (*density.shape, 3) and density.size < 20_000_000, 'Invalid field shape')
        require(cell > 0 and np.isfinite(origin).all() and np.isfinite(density).all() and np.isfinite(moment).all() and np.min(density) >= 0, 'Invalid field data')
        fields.append({'id': p['id'], 'species': p['species'], 'origin': origin, 'cell': cell, 'density': density, 'moment': moment,
                       'high': origin+(np.asarray(density.shape)-1)*cell, 'source': p})
    return m, receipt(raw), fields


def extract(density, moment, origin, cell, level, nominal=None, step_size=1):
    require(np.isfinite(density).all() and density.min() >= 0, 'Invalid assembled density')
    if density.max() <= level: return np.empty((0, 13), '<f4'), np.empty(0, '<u4')
    positions, faces, normals, _ = marching_cubes(density, level=level, spacing=(cell,)*3, step_size=step_size, allow_degenerate=False)
    coordinates = (positions/cell).T
    # Pigment is a ratio of independently accumulated area moments, not a fitted
    # green. Interpolation uses the identical position for density and pigment.
    area = map_coordinates(density, coordinates, order=1, mode='constant', cval=0, prefilter=False)
    colour = np.column_stack([map_coordinates(moment[..., k], coordinates, order=1, mode='constant', cval=0, prefilter=False) for k in range(3)])
    colour = np.divide(colour, area[:, None], out=np.zeros_like(colour), where=area[:, None] > 1e-12)
    require(np.isfinite(colour).all() and np.min(colour) >= -1e-6 and np.max(colour) <= 1.001, 'Source pigment outside physical range')
    positions += np.asarray(origin, dtype=np.float32)
    if nominal is not None:
        centre = positions[faces].mean(axis=1)
        faces = faces[(centre[:, 0] >= nominal[0]) & (centre[:, 0] < nominal[1]) & (centre[:, 2] >= nominal[2]) & (centre[:, 2] < nominal[3])]
    if not len(faces): return np.empty((0, 13), '<f4'), np.empty(0, '<u4')
    used, inverse = np.unique(faces, return_inverse=True)
    rows = np.zeros((len(used), 13), dtype='<f4')
    rows[:, :3] = positions[used]; rows[:, 3:6] = normals[used]
    lengths = np.linalg.norm(rows[:, 3:6], axis=1); require(np.min(lengths) > 0, 'Undefined field normal')
    rows[:, 3:6] /= lengths[:, None]; rows[:, 6] = 4; rows[:, 7] = .8; rows[:, 10:13] = np.clip(colour[used], 0, 1)
    return rows, inverse.reshape(-1).astype('<u4')


def root_bounds(roots, fields):
    low, high = np.empty((len(roots), 3)), np.empty((len(roots), 3))
    for p in fields:
        ids = np.flatnonzero((roots[:, 8] == p['id']) & (roots[:, 3] > 0))
        lo = np.full((len(ids), 3), np.inf); hi = np.full((len(ids), 3), -np.inf)
        r = roots[ids].astype(np.float64); c, s = np.cos(r[:, 4]), np.sin(r[:, 4])
        for bits in range(8):
            q = np.where([(bits >> k) & 1 for k in range(3)], p['high'], p['origin'])
            world = r[:, :3]+r[:, 3, None]*np.column_stack((c*q[0]-s*q[2], np.full(len(ids), q[1]), s*q[0]+c*q[2]))
            lo = np.minimum(lo, world); hi = np.maximum(hi, world)
        low[ids], high[ids] = lo, hi
    low[roots[:, 3] <= 0] = np.inf; high[roots[:, 3] <= 0] = -np.inf
    return low, high


def middle_wood(pack, native, prototype, vertices, indices, cell=.15):
    """Cluster original woody vertices, retaining original pigment bindings.

    No parametric trunk is invented. Within each source material every vertex
    moves only inside its spatial cell; tiny triangles may collapse. This is an
    explicit intermediate representation and is compared at its intended scale.
    """
    r = prototype['wood']; ids = indices[r['firstIndex']:r['firstIndex']+r['indexCount']].reshape(-1, 3)
    ids = ids[~np.all(vertices[ids, 1] < 0, axis=1)].reshape(-1)
    source_ids, inverse = np.unique(ids, return_inverse=True); rows = vertices[source_ids].astype(np.float64)
    require(np.all(rows[:, 6] == 3), 'Middle wood must use original native wood membership')
    pigment = np.zeros((len(rows), 3))
    for material in prototype['nativeMaterials']:
        selected = np.flatnonzero(rows[:, 13] == material['index'])
        if not len(selected): continue
        item = native['files'][material['albedo']['file']]; raw = GROUND.read_stream(pack, material['albedo']['file'], item)
        image = np.array(Image.open(io.BytesIO(raw)).convert('RGBA'), np.float64)[..., :3]/255
        image = np.where(image <= .04045, image/12.92, ((image+.055)/1.055)**2.4)
        uv = rows[selected, 8:10]; uv = uv % 1 if material.get('wrap') == 'repeat' else np.clip(uv, 0, 1)
        h, w = image.shape[:2]; q = uv*[w, h]-.5; start = np.floor(q).astype(int); fraction = q-start
        for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            xy = start+[dx, dy]
            if material.get('wrap') == 'repeat': xy %= [w, h]
            else: xy = np.clip(xy, [0, 0], [w-1, h-1])
            weight = (fraction[:, 0] if dx else 1-fraction[:, 0])*(fraction[:, 1] if dy else 1-fraction[:, 1])
            pigment[selected] += image[xy[:, 1], xy[:, 0]]*weight[:, None]
    pigment *= rows[:, 10:13]
    key = np.column_stack((np.floor(rows[:, :3]/cell).astype(np.int64), rows[:, 13].astype(np.int64)))
    _, groups = np.unique(key, axis=0, return_inverse=True); count = np.bincount(groups); output = np.zeros((len(count), 13), '<f4')
    for k in range(3):
        output[:, k] = np.bincount(groups, weights=rows[:, k])/count
        output[:, 3+k] = np.bincount(groups, weights=rows[:, 3+k])/count
        output[:, 10+k] = np.bincount(groups, weights=pigment[:, k])/count
    length = np.linalg.norm(output[:, 3:6], axis=1); empty = length < 1e-8
    output[empty, 3:6] = [0, 1, 0]; output[~empty, 3:6] /= length[~empty, None]
    output[:, 6] = 3; output[:, 7] = .8
    faces = groups[inverse].reshape(-1, 3); faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 0] != faces[:, 2]) & (faces[:, 1] != faces[:, 2])]
    pos = output[faces, :3]; area = np.linalg.norm(np.cross(pos[:, 1]-pos[:, 0], pos[:, 2]-pos[:, 0]), axis=1); faces = faces[area > 1e-10]
    used, new = np.unique(faces, return_inverse=True)
    return output[used], new.reshape(-1).astype('<u4')


def assemble(fields, roots, ids, low, high, nominal, cell, ground, level):
    # One extra shared cell on X/Z makes all independently baked neighbors
    # evaluate the same lattice. Only triangles in the owner's cells are emitted.
    origin = np.array([nominal[0]-cell, math.floor(low[ids, 1].min()/cell)*cell-cell, nominal[2]-cell])
    end = np.array([nominal[1]+cell, math.ceil(high[ids, 1].max()/cell)*cell+cell, nominal[3]+cell])
    shape = np.rint((end-origin)/cell).astype(int)+1
    require(np.prod(shape) <= 20_000_000, 'Mass chunk exceeds explicit voxel budget')
    density = np.zeros(shape, dtype=np.float32); moment = np.zeros((*shape, 3), dtype=np.float32)
    for root_id in ids:
        r = roots[root_id].astype(np.float64); p = fields[int(r[8])]
        start = np.maximum(0, np.floor((low[root_id]-origin)/cell).astype(int))
        stop = np.minimum(shape, np.ceil((high[root_id]-origin)/cell).astype(int)+1)
        if np.any(stop <= start): continue
        axes = [np.arange(start[k], stop[k])*cell+origin[k] for k in range(3)]
        world = np.stack(np.meshgrid(*axes, indexing='ij'), axis=0).reshape(3, -1)-r[:3, None]
        c, s = math.cos(r[4]), math.sin(r[4]); local = np.array([c*world[0]+s*world[2], world[1], -s*world[0]+c*world[2]])/r[3]
        coordinates = (local-p['origin'][:, None])/p['cell']; target = tuple(slice(a, b) for a, b in zip(start, stop)); sizes = tuple(stop-start)
        density[target] += map_coordinates(p['density'], coordinates, order=1, mode='constant', cval=0, prefilter=False).reshape(sizes)/r[3]
        for k in range(3):
            moment[(*target, k)] += map_coordinates(p['moment'][..., k], coordinates, order=1, mode='constant', cval=0, prefilter=False).reshape(sizes)*(r[5+k]/r[3])
    # Carving density at ground level would manufacture a new green isosurface
    # on steep cliffs. Extract the unchanged foliage field first. Soil only
    # hides existing surfaces; crossing triangles retain no invented cap.
    vertices, indices = extract(density, moment, origin, cell, level, nominal=nominal)
    if not len(indices): return vertices, indices
    above = np.array([row[1] >= ground(float(row[0]), float(row[2])) for row in vertices])
    faces = indices.reshape(-1, 3); faces = faces[np.any(above[faces], axis=1)]
    if not len(faces): return np.empty((0, 13), '<f4'), np.empty(0, '<u4')
    used, inverse = np.unique(faces, return_inverse=True)
    return vertices[used], inverse.reshape(-1).astype('<u4')


def prepare(pack, fields_dir, region, output, cell=1., span=128., level=.08, stand=None):
    require(not output.exists() and cell in (.5, 1., 2.) and span == 128. and level > 0, 'Fresh output and supported lattice required')
    native_raw = (pack/'manifest.json').read_bytes(); native = json.loads(native_raw)
    fm, field_receipt, fields = read_fields(fields_dir, native)
    ground, terrain, terrain_receipts = GROUND.terrain_sampler(region)
    root_raw = GROUND.read_stream(pack, 'roots.bin', native['files']['roots.bin'])
    roots, excluded = GROUND.resident_roots(native, np.frombuffer(root_raw, dtype='<f4').reshape(-1, 12), ground)
    low, high = root_bounds(roots, fields)
    native_origin = terrain['localOrigin']; lattice = np.array([native_origin['x']-terrain['spanMetres']/2, native_origin['z']-terrain['spanMetres']/2])
    groups = {}
    for root_id, r in enumerate(roots):
        if r[3] <= 0: continue
        key = tuple(np.floor((r[[0, 2]]-lattice)/span).astype(int))
        groups.setdefault(key, []).append(root_id)
    if stand is not None:
        # Explicit witness center, independent of region's spatial ownership.
        nominal = [stand[0]-span/2, stand[0]+span/2, stand[1]-span/2, stand[1]+span/2]
        own = np.flatnonzero((roots[:, 3] > 0) & (roots[:, 0] >= nominal[0]) & (roots[:, 0] < nominal[1]) & (roots[:, 2] >= nominal[2]) & (roots[:, 2] < nominal[3])).tolist()
        groups = {('witness', 'witness'): own}
    vertices_parts, index_parts, chunks = [], [], []; owners = np.full(len(roots), NO_OWNER, dtype='<u4'); nv = ni = 0
    for key, own in sorted(groups.items()):
        if stand is None: nominal = [lattice[0]+key[0]*span, lattice[0]+(key[0]+1)*span, lattice[1]+key[1]*span, lattice[1]+(key[1]+1)*span]
        ids = np.flatnonzero((roots[:, 3] > 0) & (high[:, 0] >= nominal[0]-cell) & (low[:, 0] <= nominal[1]+cell) & (high[:, 2] >= nominal[2]-cell) & (low[:, 2] <= nominal[3]+cell))
        started = time.monotonic(); vertices, indices = assemble(fields, roots, ids, low, high, nominal, cell, ground, level)
        require(len(indices) > 0, 'Empty owned forest mass')
        lo = vertices[:, :3].min(axis=0).astype(float); hi = vertices[:, :3].max(axis=0).astype(float); centre = (lo+hi)*.5
        # Explicit sampling footprint only, never a native alpha certificate.
        kernel = fm['recipe']['maximumSupportMetres']; scale = float(roots[ids, 3].max())
        error = kernel*scale+math.sqrt(3)*cell
        chunk = {'id': len(chunks), 'nominalBoundsXZ': list(map(float, nominal)), 'rootCount': len(own), 'haloRootCount': len(ids)-len(own),
                 'firstIndex': ni, 'indexCount': len(indices), 'low': lo.tolist(), 'high': hi.tolist(), 'centre': centre.tolist(),
                 'radius': float(np.linalg.norm((hi-lo)*.5))+1e-3, 'lodErrorMetres': error,
                 'sourceRoots': receipt(np.array(own, '<u4').tobytes()), 'contributingRoots': receipt(roots[ids].tobytes())}
        owners[own] = chunk['id']; vertices_parts.append(vertices); index_parts.append(indices+nv); chunks.append(chunk); nv += len(vertices); ni += len(indices)
        print(json.dumps({'chunk': len(chunks), 'total': len(groups), 'roots': len(own), 'halo': len(ids)-len(own), 'triangles': len(indices)//3, 'seconds': round(time.monotonic()-started, 2)}), flush=True)
    middle_v, middle_i, prototypes = [], [], []; mv = mi = 0
    native_vertices = np.frombuffer(GROUND.read_stream(pack, 'vertices.bin', native['files']['vertices.bin']), '<f4').reshape(-1, 14)
    native_indices = np.frombuffer(GROUND.read_stream(pack, 'indices.bin', native['files']['indices.bin']), '<u4')
    for p in fields:
        v, i = extract(p['density'], p['moment'], p['origin'], p['cell'], level, step_size=2)
        wood_v, wood_i = middle_wood(pack, native, native['prototypes'][p['id']], native_vertices, native_indices)
        i = np.concatenate((i, wood_i+len(v))).astype('<u4'); v = np.concatenate((v, wood_v))
        lo, hi = v[:, :3].min(axis=0).astype(float), v[:, :3].max(axis=0).astype(float)
        prototypes.append({'id': p['id'], 'species': p['species'], 'firstIndex': mi, 'indexCount': len(i), 'lodErrorMetres': fm['recipe']['maximumSupportMetres']+p['cell']*math.sqrt(3)*2,
                           'low': lo.tolist(), 'high': hi.tolist(), 'woodClusterMetres': .15, 'woodSource': native['prototypes'][p['id']]['wood']})
        middle_v.append(v); middle_i.append(i+mv); mv += len(v); mi += len(i)
    neighbors = np.full((len(roots), 4), NO_OWNER, dtype='<u4'); by_key = {key: i for i, key in enumerate(sorted(groups))}
    for root_id, r in enumerate(roots):
        if r[3] <= 0: continue
        if stand is not None:
            box = chunks[0]['nominalBoundsXZ']; touches = []
            if high[root_id, 0] >= box[0] and low[root_id, 0] <= box[1] and high[root_id, 2] >= box[2] and low[root_id, 2] <= box[3]: touches.append(0)
            if low[root_id, 0] < box[0] or high[root_id, 0] > box[1] or low[root_id, 2] < box[2] or high[root_id, 2] > box[3]: touches.append(NO_OWNER-1)
        else:
            a = np.floor((low[root_id, [0, 2]]-lattice)/span).astype(int)
            b = np.floor((np.nextafter(high[root_id, [0, 2]], -np.inf)-lattice)/span).astype(int)
            touches = [by_key.get((x, z), NO_OWNER-1) for x in range(a[0], b[0]+1) for z in range(a[1], b[1]+1)]
        require(len(touches) <= 4, 'Root field crosses more than four block bounds; no neighbor truncation')
        neighbors[root_id, :len(touches)] = touches
    full_vertices = np.concatenate(vertices_parts)
    compact_type = np.dtype([('position', '<f4', 3), ('normal', 'i1', 4), ('colour', '<f2', 4)])
    require(compact_type.itemsize == 24, 'Compact forest layout changed')
    compact_vertices = np.zeros(len(full_vertices), dtype=compact_type)
    compact_vertices['position'] = full_vertices[:, :3]
    compact_vertices['normal'][:, :3] = np.rint(np.clip(full_vertices[:, 3:6], -1, 1)*127).astype(np.int8)
    compact_vertices['colour'][:, :3] = full_vertices[:, 10:13].astype('<f2'); compact_vertices['colour'][:, 3] = 1
    require(np.array_equal(compact_vertices['position'], full_vertices[:, :3]), 'Compact storage moved world positions')
    buffers = {'vertices.bin': compact_vertices.tobytes(), 'indices.bin': np.concatenate(index_parts).astype('<u4').tobytes(),
               'root-chunks.bin': owners.tobytes(), 'root-neighbors.bin': neighbors.tobytes(),
               'middle-vertices.bin': np.concatenate(middle_v).tobytes(), 'middle-indices.bin': np.concatenate(middle_i).astype('<u4').tobytes()}
    method = {'file': 'scripts/prepare-forest-mass.py', **receipt(Path(__file__).read_bytes())}
    document = {'format': 'waterworld.native-forest-mass', 'version': 2, 'units': 'metres', 'upAxis': 'Y', 'vertexStride': 24,
                'quantization': {'positions': 'Original Float32 world XYZ unchanged', 'normals': 'Normalized source normals rounded to snorm8 XYZ, renormalized on GPU',
                                 'normalComponentErrorMaximum': .5/127, 'linearPigment': 'Float16 RGB, same numerical storage precision as native captures',
                                 'implicitAttributes': 'kind4, exposure.8, UV0; no geometry reduction', 'positionSHA256': receipt(full_vertices[:, :3].tobytes())['sha256']},
                'rootCount': len(roots), 'residentRootCount': int(np.count_nonzero(owners != NO_OWNER)), 'excludedRootCount': len(excluded),
                'chunkMetres': span, 'cellMetres': cell, 'chunks': chunks, 'prototypes': prototypes, 'noChunk': NO_OWNER,
                'source': {'manifest': receipt(native_raw), 'files': {name: {k: native['files'][name][k] for k in ('bytes', 'sha256')} for name in ('vertices.bin', 'indices.bin', 'roots.bin')},
                           'nativeFieldManifest': field_receipt, 'nativeFieldRecipe': fm['recipe'], 'method': method, 'terrain': terrain_receipts,
                           'claim': 'Original detailed native leaf triangles, MASK maps and area/pigment moments, at actual seated root transforms. No crown dome ranges.'},
                'recipe': {'isoLeafAreaDensity': level, 'scale': 'Local area density divided by uniform root scale, so integrated leaf area scales with s squared',
                           'neighbors': 'Four conservative transformed native-field XZ block touches per root; 0xffffffff padding; 0xfffffffe missing block prevents full-tree suppression',
                           'assembly': 'ADD continuous leaf-area density and linear RGB area moments; one shared world lattice; no prethresholded tree unions or terrain colour',
                           'mesh': 'Lewiner marching cubes, original field isovalue, shared lattice; internal block boundaries are partitioned, never capped with extra foliage'},
                'appearanceErrorSupported': False, 'validation': None, 'files': {}}
    output.parent.mkdir(parents=True, exist_ok=True); temp = Path(tempfile.mkdtemp(prefix=output.name+'.baking-', dir=output.parent))
    try:
        for name, data in buffers.items():
            require(len(data) <= 256*1024*1024, 'Mass stream exceeds runtime buffer budget')
            encoded = gzip_bytes(data); (temp/(name+'.gz')).write_bytes(encoded)
            document['files'][name] = {**receipt(data), 'gzip': {'file': name+'.gz', **receipt(encoded)}}
        (temp/'manifest.json').write_text(json.dumps(document, indent=2)+'\n'); temp.rename(output)
    except Exception:
        shutil.rmtree(temp, ignore_errors=True); raise
    print(json.dumps({'output': str(output), 'chunks': len(chunks), 'triangles': ni//3, 'middleTriangles': mi//3, 'rawBytes': sum(map(len, buffers.values()))}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('pack', 'fields', 'region', 'output'): parser.add_argument('--'+flag, required=True, type=Path)
    parser.add_argument('--cell-metres', type=float, default=1.); parser.add_argument('--level', type=float, default=.08)
    parser.add_argument('--stand', type=float, nargs=2)
    a = parser.parse_args(); prepare(a.pack, a.fields, a.region, a.output, cell=a.cell_metres, level=a.level, stand=a.stand)
