#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Bake closed opaque owner-chunk forest masses from existing native crowns.

No growth, native remeshing, downloads or rendering. Solidification is an
authored distant representation, not an alpha/colour match to individual leaves.
Root executes explicitly in the existing NumPy/SciPy authoring environment.
"""
from __future__ import annotations
import argparse
from collections import defaultdict, deque
import gzip
import importlib.util
import io
import json
import math
from pathlib import Path
import shutil
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("forest_canopy_source", ROOT/"scripts/prepare-forest-instances.py")
IMPORTER = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(IMPORTER)
SOURCE = IMPORTER.SOURCE
FORMAT = "waterworld.forest-canopy"
ERROR_METHOD = "conservative-solid-column-union-containment-v1"
GROUND_OVERLAP = .08
MAX_OUTPUT_BYTES = 512*1024*1024
MAX_CHUNK_CELLS = 100000
NO_CHUNK = 0xffffffff


def read_stream(folder, name, item):
    raw_path = folder/SOURCE.basename(name)
    if raw_path.is_file():raw = raw_path.read_bytes()
    else:
        encoded = item.get("gzip", {});filename = SOURCE.basename(encoded.get("file"))
        compressed = SOURCE.read_receipted(folder, filename, {filename: encoded})
        SOURCE.require(item["bytes"] <= MAX_OUTPUT_BYTES, "Oversized decoded source")
        raw = gzip.decompress(compressed)
    SOURCE.require(len(raw) == item["bytes"] and SOURCE.digest(raw) == item["sha256"], "Canopy source receipt mismatch: "+name)
    return raw


def terrain_sampler(folder):
    raw = (folder/"manifest.json").read_bytes();manifest = SOURCE.finite_json(raw)
    identity = {key: manifest[key] for key in ("id", "gridSize", "spanMetres", "localOrigin")}
    coarse, _, receipts = SOURCE.terrain_inputs(folder, {"region": identity})
    origin, span = manifest["localOrigin"], float(manifest["spanMetres"])
    near = None;terrain_step = span/(manifest["gridSize"]-1)
    if manifest.get("nearTile"):
        SOURCE.require(manifest["nearTile"] == "wells-bay/manifest.json", "Unknown registered near terrain")
        near_folder = folder/"wells-bay";near_raw = (near_folder/"manifest.json").read_bytes()
        near_manifest = SOURCE.finite_json(near_raw);domain = near_manifest["domain"]
        SOURCE.require(near_manifest.get("format") == "waterworld.terrain-near"
                       and near_manifest.get("baseHeightSHA256") == manifest["heightSHA256"]
                       and domain["spacing"] in (1, 2) and (domain["size"]-1)*domain["spacing"] == domain["span"], "Unregistered near canopy terrain")
        height_raw = SOURCE.read_receipted(near_folder, "height.bin", near_manifest["files"])
        heights = np.frombuffer(height_raw, dtype="<f4").reshape(domain["size"], domain["size"]).astype(np.float64)
        SOURCE.require(np.isfinite(heights).all(), "Invalid near canopy elevations")
        near = (domain, heights);terrain_step = min(terrain_step, domain["spacing"])
        receipts["wells-bay/manifest.json"] = SOURCE.receipt(near_raw)
        receipts["wells-bay/height.bin"] = SOURCE.receipt(height_raw)
    def sample(x, z):
        if near:
            d, h = near;n = d["size"];x0, z0 = d["x"]-d["span"]/2, d["z"]-d["span"]/2
            if x0 <= x <= x0+d["span"] and z0 <= z <= z0+d["span"]:
                u, v = (x-x0)/d["spacing"], (z-z0)/d["spacing"]
                i, j = min(n-2, math.floor(u)), min(n-2, math.floor(v));a, b = u-i, v-j
                return float(h[j, i]+a*(h[j, i+1]-h[j, i])+b*(h[j+1, i]-h[j, i])) if a+b <= 1 else float(h[j+1, i+1]+(1-a)*(h[j+1, i]-h[j+1, i+1])+(1-b)*(h[j, i+1]-h[j+1, i+1]))
        if not (abs(x-origin["x"]) <= span/2 and abs(z-origin["z"]) <= span/2):return -120.
        return coarse(x, z)[0]
    sample.minimum_step = terrain_step
    return sample, manifest, receipts


def resident_roots(manifest, roots, ground):
    """Same one-time terrain seating and exclusions as createForestRenderer."""
    rooted = np.asarray(roots, dtype="<f4").copy();excluded = []
    SOURCE.require(rooted.shape == (manifest["rootCount"], 12) and np.isfinite(rooted).all(), "Invalid canopy root stream")
    for i, row in enumerate(rooted):
        x, z, scale = float(row[0]), float(row[2]), float(row[3]);height = ground(x, z)
        slope = math.hypot((ground(x+1, z)-ground(x-1, z))*.5, (ground(x, z+1)-ground(x, z-1))*.5)
        if scale <= 0 or height < 18 or height > 840 or not math.isfinite(slope) or slope > 1.1:
            rooted[i, 3] = 0;excluded.append(i);continue
        p = manifest["prototypes"][int(row[8])]
        rooted[i, 9] = max(float(row[9]), p.get("basalRadius", 0)*scale*slope+GROUND_OVERLAP)
        rooted[i, 1] = height-rooted[i, 9]
    return rooted, excluded


def crown_prototypes(manifest, vertices, indices):
    SOURCE.require(manifest.get("version") == 2 and manifest.get("vertexStride") == 56
                   and manifest.get("materialContract") == "gene-surfaces-v3", "Expected native forest v2")
    rows = np.asarray(vertices, dtype="<f4").reshape(-1, 14);indices = np.asarray(indices, dtype="<u4")
    result = []
    for i, p in enumerate(manifest["prototypes"]):
        SOURCE.require(p["id"] == i, "Noncanonical canopy prototype IDs")
        r = p["far"];own = indices[r["firstIndex"]:r["firstIndex"]+r["indexCount"]]
        SOURCE.require(len(own) == r["indexCount"] and len(own) % 3 == 0 and np.all(own < len(rows)), "Invalid source crown range")
        triangles = rows[own].reshape(-1, 3, 14)
        SOURCE.require(np.all(np.all(triangles[:, :, 6] == 3, axis=1) | np.all(triangles[:, :, 6] == 4, axis=1)), "Mixed source crown kinds")
        crown = triangles[np.all(triangles[:, :, 6] == 4, axis=1)].astype(np.float64)
        SOURCE.require(len(crown) > 0 and np.isfinite(crown).all() and np.all((crown[:, :, 10:13] >= 0) & (crown[:, :, 10:13] <= 1)), "Invalid source canopy colour/shape")
        result.append(crown)
    return result


def crown_cell_extrema(triangles, origin, step):
    """Exact linear extrema over triangle/cell intersections in horizontal XZ.

    A clipped triangle's extrema occur at its original vertices, grid corners
    inside it, or source-edge/grid-line intersections. These candidates retain
    source height, RGB and exposure; no invented round tree shapes are used.
    """
    points = triangles[:, :, :3];attributes = triangles[:, :, [7, 10, 11, 12]]
    low, high = points[:, :, [0, 2]].min(axis=(0, 1)), points[:, :, [0, 2]].max(axis=(0, 1))
    lo = np.floor((low-origin)/step).astype(int);hi = np.ceil((high-origin)/step).astype(int)
    SOURCE.require(np.prod(hi-lo+1) <= MAX_CHUNK_CELLS, "Source crown exceeds bounded lattice")
    samples = [np.concatenate((points.reshape(-1, 3), attributes.reshape(-1, 4)), axis=1)]
    gx, gz = np.meshgrid(np.arange(lo[0], hi[0]+1), np.arange(lo[1], hi[1]+1))
    horizontal = np.column_stack((origin[0]+gx.ravel()*step, origin[1]+gz.ravel()*step))
    a, b, c = points[:, 0], points[:, 1], points[:, 2]
    denominator = (b[:, 2]-c[:, 2])*(a[:, 0]-c[:, 0])+(c[:, 0]-b[:, 0])*(a[:, 2]-c[:, 2])
    valid = np.abs(denominator) > 1e-12
    if valid.any():
        aa, bb, cc, den = a[valid], b[valid], c[valid], denominator[valid]
        u = ((bb[:, 2]-cc[:, 2])[None, :]*(horizontal[:, 0, None]-cc[:, 0])+(cc[:, 0]-bb[:, 0])[None, :]*(horizontal[:, 1, None]-cc[:, 2]))/den
        v = ((cc[:, 2]-aa[:, 2])[None, :]*(horizontal[:, 0, None]-cc[:, 0])+(aa[:, 0]-cc[:, 0])[None, :]*(horizontal[:, 1, None]-cc[:, 2]))/den
        w = 1-u-v;inside = (u >= -1e-12) & (v >= -1e-12) & (w >= -1e-12)
        pi, ti = np.nonzero(inside)
        if len(pi):
            weights = np.column_stack((u[pi, ti], v[pi, ti], w[pi, ti]))
            values = np.sum(weights[:, :, None]*np.concatenate((points[valid], attributes[valid]), axis=2)[ti], axis=1)
            samples.append(values)
    first = points.reshape(-1, 3);last = np.roll(points, -1, axis=1).reshape(-1, 3)
    fa = attributes.reshape(-1, 4);la = np.roll(attributes, -1, axis=1).reshape(-1, 4)
    for axis, index in ((0, 0), (2, 1)):
        delta = last[:, axis]-first[:, axis];moving = np.abs(delta) > 1e-12
        lines = origin[index]+np.arange(lo[index], hi[index]+1)*step
        t = (lines[:, None]-first[moving, axis])/delta[moving]
        li, ei = np.nonzero((t >= 0) & (t <= 1));fraction = t[li, ei, None]
        if len(ei):samples.append(np.concatenate((first[moving][ei]+fraction*(last-first)[moving][ei], fa[moving][ei]+fraction*(la-fa)[moving][ei]), axis=1))
    values = np.concatenate(samples);coordinates = (values[:, [0, 2]]-origin)/step
    cells = np.floor(coordinates).astype(np.int64)
    on_line = np.abs(coordinates-np.rint(coordinates)) < 1e-9
    all_cells, all_values = [], []
    for dx, dz in ((0, 0), (-1, 0), (0, -1), (-1, -1)):
        select = (on_line[:, 0] if dx else np.ones(len(values), dtype=bool)) & (on_line[:, 1] if dz else np.ones(len(values), dtype=bool))
        own = cells[select].copy();own += [dx, dz]
        all_cells.append(own);all_values.append(values[select])
    cells, values = np.concatenate(all_cells), np.concatenate(all_values)
    order = np.lexsort((values[:, 1], cells[:, 1], cells[:, 0]));cells, values = cells[order], values[order]
    starts = np.r_[0, np.flatnonzero(np.any(cells[1:] != cells[:-1], axis=1))+1];ends = np.r_[starts[1:], len(cells)]
    return [(tuple(map(int, cells[start])), values[end-1].copy(), float(values[start, 1])) for start, end in zip(starts, ends)]


def build_chunk(prototypes, root_ids, roots, ground, *, cell_metres=2., origin=(0., 0.)):
    cells = {};origin = np.asarray(origin, dtype=np.float64)
    source_hashes = []
    for root_id in root_ids:
        row = roots[root_id].astype(np.float64);scale, yaw = row[3], row[4];c, s = math.cos(yaw), math.sin(yaw)
        triangles = prototypes[int(row[8])].copy();local = triangles[:, :, :3].copy()
        triangles[:, :, 0] = row[0]+scale*(c*local[:, :, 0]-s*local[:, :, 2])
        triangles[:, :, 1] = row[1]+scale*local[:, :, 1]
        triangles[:, :, 2] = row[2]+scale*(s*local[:, :, 0]+c*local[:, :, 2])
        triangles[:, :, 10:13] *= row[5:8]
        source_hashes.append(SOURCE.receipt(triangles[:, :, :3].astype("<f8").tobytes()))
        for key, top, bottom in crown_cell_extrema(triangles, origin, cell_metres):
            if key not in cells:cells[key] = [top, bottom]
            else:
                if top[1] > cells[key][0][1]:cells[key][0] = top
                cells[key][1] = min(cells[key][1], bottom)
    SOURCE.require(cells and len(cells) <= MAX_CHUNK_CELLS, "Empty/oversized canopy chunk")
    # A pair of diagonal cells otherwise shares only a vertical edge: a closed
    # but non-manifold contact after position welding. Add one adjacent cell,
    # retaining an actual source maximum/witness. Its extra reach is measured
    # below; this is not an unrecorded dilation or a new tree.
    bridge_cells = 0
    while True:
        additions = {}
        nodes = {corner for i, j in cells for corner in ((i, j), (i+1, j), (i, j+1), (i+1, j+1))}
        for i, j in sorted(nodes):
            around = ((i-1, j-1), (i, j-1), (i, j), (i-1, j))
            present = [k for k, cell in enumerate(around) if cell in cells]
            if len(present) == 2 and (present[0]+2) % 4 == present[1]:
                target = min(cell for cell in around if cell not in cells)
                a, b = (cells[around[k]] for k in present)
                additions[target] = [(a if a[0][1] >= b[0][1] else b)[0], min(a[1], b[1])]
        if not additions:break
        cells.update(additions);bridge_cells += len(additions)
        SOURCE.require(len(cells) <= MAX_CHUNK_CELLS, "Canopy manifold closure exceeds bounded lattice")
    top_nodes, floor_nodes, ground_cache = {}, {}, {}
    def xy(key):return origin+np.asarray(key)*cell_metres
    def terrain(key):
        if key not in ground_cache:
            x, z = xy(key);ground_cache[key] = float(ground(float(x), float(z)))
        return ground_cache[key]
    subdivisions = max(1, math.ceil(cell_metres/getattr(ground, "minimum_step", cell_metres)))
    for (i, j), (top, minimum) in cells.items():
        x0, z0 = xy((i, j))
        terrain_values = [ground(float(x0+cell_metres*u/subdivisions), float(z0+cell_metres*v/subdivisions)) for v in range(subdivisions+1) for u in range(subdivisions+1)]
        floor = min(min(terrain_values), minimum)-GROUND_OVERLAP
        for key in ((i, j), (i+1, j), (i, j+1), (i+1, j+1)):
            if key not in top_nodes or top[1] > top_nodes[key][1]:top_nodes[key] = top
            floor_nodes[key] = min(floor_nodes.get(key, math.inf), floor)
    vertices, indices, lookup, normal_sums = [], [], {}, []
    def fan(key, cell):
        i, j = key;around = [(i-1, j-1), (i, j-1), (i, j), (i-1, j)]
        own = around.index(cell);connected, pending = {own}, [own]
        while pending:
            k = pending.pop()
            for other in ((k-1) % 4, (k+1) % 4):
                if other not in connected and around[other] in cells:connected.add(other);pending.append(other)
        return min(connected)
    def vertex(key, layer, cell):
        identity = (*key, layer, fan(key, cell))
        if identity not in lookup:
            x, z = xy(key);top = top_nodes[key];height = top[1] if layer == 0 else floor_nodes[key]
            index = len(vertices);lookup[identity] = index
            vertices.append([x, height, z, 0., 0., 0., 4., float(np.clip(top[3], 0, 1)), 0., 0., *np.clip(top[4:7], 0, 1)])
            normal_sums.append(np.zeros(3, dtype=np.float64))
        return lookup[identity]
    def triangle(a, b, c):
        positions = np.asarray([vertices[k][:3] for k in (a, b, c)])
        normal = np.cross(positions[1]-positions[0], positions[2]-positions[0])
        SOURCE.require(float(np.linalg.norm(normal)) > 1e-10, "Degenerate canopy surface")
        indices.extend((a, b, c))
        for k in (a, b, c):normal_sums[k] += normal
    vertical_excess = horizontal_excess = 0.
    for cell in sorted(cells):
        i, j = cell;keys = ((i, j), (i+1, j), (i+1, j+1), (i, j+1))
        top = [vertex(k, 0, cell) for k in keys];bottom = [vertex(k, 1, cell) for k in keys]
        triangle(top[0], top[3], top[1]);triangle(top[1], top[3], top[2])
        triangle(bottom[0], bottom[1], bottom[3]);triangle(bottom[1], bottom[2], bottom[3])
        for neighbour, a, b in (((i, j-1), 0, 1), ((i+1, j), 1, 2), ((i, j+1), 2, 3), ((i-1, j), 3, 0)):
            if neighbour not in cells:
                triangle(top[a], top[b], bottom[a]);triangle(top[b], bottom[b], bottom[a])
        witness_bottom = max(min(float(ground(float(top_nodes[k][0]), float(top_nodes[k][2]))), float(top_nodes[k][1]))-GROUND_OVERLAP for k in keys)
        vertical_excess = max(vertical_excess, witness_bottom-min(floor_nodes[k] for k in keys))
        horizontal_excess = max(horizontal_excess, max(float(np.linalg.norm(xy(corner)-top_nodes[witness][[0, 2]])) for corner in keys for witness in keys))
    for row, normal in zip(vertices, normal_sums):
        length = float(np.linalg.norm(normal));SOURCE.require(length > 1e-12, "Undefined canopy normal")
        row[3:6] = (normal/length).tolist()
    vertices = np.asarray(vertices, dtype="<f4");indices = np.asarray(indices, dtype="<u4")
    horizontal = horizontal_excess
    # Every roof point is below one of its four nodes' exact source maxima.
    # That source column lies in a nearby cell; its actual maximum horizontal
    # distance is measured, including manifold-closure cells. Its lower endpoint can exceed the baked floor
    # by at most the measured vertical_excess. Conservative floors/roofs contain
    # the reference columns. This is a VOLUME bound, not hidden-face Hausdorff.
    arithmetic = 1e-4+float(np.abs(vertices[:, :3]).max())*8*np.finfo(np.float32).eps
    error = IMPORTER.float32_upper_bound(math.hypot(horizontal, max(0., vertical_excess))+arithmetic)
    low, high = vertices[:, :3].min(axis=0).astype(float), vertices[:, :3].max(axis=0).astype(float)
    occupied = set(cells);components = 0
    while occupied:
        components += 1;pending = deque([occupied.pop()])
        while pending:
            i, j = pending.popleft()
            for neighbour in ((i-1, j), (i+1, j), (i, j-1), (i, j+1)):
                if neighbour in occupied:occupied.remove(neighbour);pending.append(neighbour)
    report = {"low": low.tolist(), "high": high.tolist(), "centre": ((low+high)*.5).tolist(),
              "radius": IMPORTER.float32_upper_bound(float(np.linalg.norm((high-low)*.5))+arithmetic),
              "roofCells": len(cells), "components": components, "manifoldBridgeCells": bridge_cells,
              "sampling": {"cellMetres": cell_metres, "horizontalCellDiagonalMetres": math.sqrt(2)*cell_metres,
                           "witnessHorizontalMetres": horizontal, "verticalExcessMetres": max(0., vertical_excess), "arithmeticAllowanceMetres": arithmetic},
              "geometryErrorSupported": True, "geometryErrorMetres": error, "geometryErrorMethod": ERROR_METHOD,
              "geometryErrorScope": "Filled authored opaque source crown-column union versus closed sampled volume; NOT native leaf alpha/colour or hidden internal boundary faces",
              "sourceTransformedCrowns": SOURCE.receipt(json.dumps(source_hashes, separators=(",", ":")).encode()),
              "sourceUnindexedShell": SOURCE.receipt(vertices[indices].tobytes()),
              "approximation": "Source crown envelopes solidified down to terrain; no native alpha or colour appearance certificate"}
    return vertices, indices, report


def deterministic_gzip(raw):
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0) as stream:stream.write(raw)
    return output.getvalue()


def prepare(pack_dir, region_dir, output, *, cell_metres=2., chunk_metres=128.):
    pack_dir, region_dir, output = Path(pack_dir).resolve(), Path(region_dir).resolve(), Path(output).resolve()
    SOURCE.require(not output.exists() and cell_metres in (1., 2., 4., 8.) and chunk_metres == 128.
                   and chunk_metres/cell_metres == int(chunk_metres/cell_metres), "Fresh output and supported canopy lattice required")
    raw = (pack_dir/"manifest.json").read_bytes();manifest = SOURCE.finite_json(raw)
    source_files = {name: {key: manifest["files"][name][key] for key in ("bytes", "sha256")} for name in ("vertices.bin", "indices.bin", "roots.bin")}
    streams = {name: read_stream(pack_dir, name, manifest["files"][name]) for name in source_files}
    ground, region, terrain_receipts = terrain_sampler(region_dir)
    roots, excluded = resident_roots(manifest, np.frombuffer(streams["roots.bin"], dtype="<f4").reshape(-1, 12), ground)
    prototypes = crown_prototypes(manifest, np.frombuffer(streams["vertices.bin"], dtype="<f4"), np.frombuffer(streams["indices.bin"], dtype="<u4"))
    span, local = region["spanMetres"], region["localOrigin"];origin = (local["x"]-span/2, local["z"]-span/2)
    groups = defaultdict(list)
    for i, row in enumerate(roots):
        if row[3] > 0:groups[(math.floor((float(row[0])-origin[0])/chunk_metres), math.floor((float(row[2])-origin[1])/chunk_metres))].append(i)
    owners = np.full(manifest["rootCount"], NO_CHUNK, dtype="<u4")
    vertex_parts, index_parts, chunks = [], [], [];vertex_count = index_count = 0
    for chunk_id, (key, own) in enumerate(sorted(groups.items())):
        vertices, indices, chunk = build_chunk(prototypes, own, roots, ground, cell_metres=cell_metres, origin=origin)
        chunk.update(id=chunk_id, key=f"{key[0]}:{key[1]}", rootCount=len(own), firstIndex=index_count, indexCount=len(indices),
                     sourceRoots=SOURCE.receipt(np.asarray(own, dtype="<u4").tobytes()),
                     seatedRoots=SOURCE.receipt(roots[own].tobytes()),
                     nominalBoundsXZ=[origin[0]+key[0]*chunk_metres, origin[0]+(key[0]+1)*chunk_metres, origin[1]+key[1]*chunk_metres, origin[1]+(key[1]+1)*chunk_metres])
        vertex_parts.append(vertices);index_parts.append(indices+vertex_count);chunks.append(chunk);owners[own] = chunk_id
        vertex_count += len(vertices);index_count += len(indices)
        SOURCE.require(vertex_count*52+index_count*4+owners.nbytes <= MAX_OUTPUT_BYTES, "Canopy output exceeds512MiB; no cells or crowns truncated")
    SOURCE.require(chunks, "No resident canopy roots")
    packed = {"vertices.bin": np.concatenate(vertex_parts).tobytes(), "indices.bin": np.concatenate(index_parts).astype("<u4").tobytes(), "root-chunks.bin": owners.tobytes()}
    files = {name: SOURCE.receipt(value, **{ {"vertices.bin": "vertexCount", "indices.bin": "indexCount", "root-chunks.bin": "rootCount"}[name]: {"vertices.bin": vertex_count, "indices.bin": index_count, "root-chunks.bin": len(owners)}[name]}) for name, value in packed.items()}
    method = {"file": "scripts/prepare-forest-canopy.py", **SOURCE.receipt(Path(__file__).read_bytes())}
    for chunk in chunks:
        chunk["geometryErrorSource"] = {
            "method": method, "sourceFiles": source_files,
            "rootOwnership": {key: files["root-chunks.bin"][key] for key in ("bytes", "sha256")},
            "sourceRoots": chunk["sourceRoots"], "seatedRoots": chunk["seatedRoots"],
            "transformedCrowns": chunk["sourceTransformedCrowns"], "unindexedShell": chunk["sourceUnindexedShell"],
            "packedStreams": {name: {key: files[name][key] for key in ("bytes", "sha256")} for name in ("vertices.bin", "indices.bin")},
            "range": {key: chunk[key] for key in ("firstIndex", "indexCount")},
            "proof": "Reference solid columns are contained by the sampled roof/floor. Each added point has a real source maximum-height column witness within measured horizontal/vertical distances; Euclidean bound plus Float32 allowance is rounded upward.",
            "sampling": chunk["sampling"]}
    result = {"format": FORMAT, "version": 1, "units": "metres", "upAxis": "Y", "vertexStride": 52,
              "rootCount": len(roots), "residentRootCount": len(roots)-len(excluded), "excludedRootCount": len(excluded),
              "noChunk": NO_CHUNK, "chunkMetres": chunk_metres, "cellMetres": cell_metres, "gridOriginXZ": list(origin), "chunks": chunks,
              "source": {"manifest": SOURCE.receipt(raw), "files": source_files, "nativeSource": manifest.get("nativeSource"),
                         "terrain": terrain_receipts, "seatedRoots": SOURCE.receipt(roots.tobytes()), "method": method,
                         "claim": "Existing source native-far kind4 crowns and exact original root identities; source native geometry/maps unchanged"},
              "geometryErrorMethod": ERROR_METHOD, "appearanceErrorSupported": False, "textureAlphaErrorSupported": False, "colourErrorSupported": False,
              "approximation": "Continuous opaque source crown-column masses; actual contributing species colour/exposure/tint retained, native leaf alpha intentionally not retained", "files": files}
    output.parent.mkdir(parents=True, exist_ok=True);temporary = Path(tempfile.mkdtemp(prefix="forest-canopy-", dir=output.parent))
    try:
        for name, value in packed.items():
            compressed = deterministic_gzip(value);filename = name+".gz";(temporary/filename).write_bytes(compressed)
            files[name]["gzip"] = {"file": filename, **SOURCE.receipt(compressed)}
            SOURCE.require(gzip.decompress(compressed) == value, "Canopy gzip roundtrip differs")
        (temporary/"manifest.json").write_text(json.dumps(result, indent=2)+"\n")
        temporary.rename(output)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True);raise
    print(json.dumps({"output": str(output), "chunks": len(chunks), "roots": result["residentRootCount"], "excluded": len(excluded), "vertices": vertex_count, "indices": index_count, "rawBytes": sum(map(len, packed.values()))}))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", type=Path, required=True);parser.add_argument("--region", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True);parser.add_argument("--cell-size", type=float, default=2.)
    parser.add_argument("--chunk-size", type=float, default=128.)
    arguments = parser.parse_args()
    prepare(arguments.pack, arguments.region, arguments.output, cell_metres=arguments.cell_size, chunk_metres=arguments.chunk_size)
