#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Import an existing Forestmodeler canopy bake; never grow, render or download.

Requires NumPy and SciPy (available in Forestmodeler's uv environment). Runtime
streams are world-Y-up Float32, 13 floats/vertex: xyz, normal, kind, shade, UV,
linear RGB. near.bin is actual GLB wood; leaf.bin is the matching native foliage;
far.bin retains the original opaque trunks/crown domes. All are partitioned into
128 m spatial draw batches. instances.bin retains original instance bytes; its
shape field is NOT a specimen ID or the actual yaw (see manifest.stems).

The geometric LOD bound is rigorous but intentionally conservative: for each
triangle choose any vertex of the opposite representation, bound every point of
that triangle by the largest of its three vertex distances to that chosen point,
then take the maximum in both directions. It bounds near+leaf triangles versus
far triangles, not alpha coverage. Source assets have no leaf alpha texture, so
reusing Waterworld's alpha image remains an explicit, uncertified approximation.

Example (root runs this explicitly, outside validation concurrency):
  uv run --directory ../forestmodeler python \
    ../waterworld/scripts/prepare-canopy-scenery.py --force
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile

import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
FORMAT = "waterworld.canopy-runtime"
MAX_INPUT_BYTES = 256 * 1024 * 1024
MAX_VERTICES = 3_000_000
PATCH_METRES = 128.0
ATTRIBUTES = ["x", "y", "z", "nx", "ny", "nz", "kind", "shade", "u", "v", "linearR", "linearG", "linearB"]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def finite_json(raw):
    def reject(value):
        raise ValueError(f"Nonfinite JSON constant: {value}")
    return json.loads(raw, parse_constant=reject)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def receipt(raw, **extra):
    return {"bytes": len(raw), "sha256": digest(raw), **extra}


def basename(name):
    require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name), "Unsafe asset filename")
    return name


def read_receipted(folder, name, records):
    name = basename(name)
    raw = (folder / name).read_bytes()
    require(len(raw) <= MAX_INPUT_BYTES, f"Source exceeds bounded input size: {name}")
    expected = records.get(name)
    require(isinstance(expected, dict) and expected.get("bytes") == len(raw) and expected.get("sha256") == digest(raw), f"Source receipt mismatch: {name}")
    return raw


def point(value, length=3):
    return isinstance(value, (list, tuple)) and len(value) == length and all(isinstance(v, (int, float)) and math.isfinite(v) for v in value)


def native_stream(raw, stride):
    require(len(raw) % (stride * 4) == 0, "Invalid native stream byte length")
    data = np.frombuffer(raw, dtype="<f4").reshape(-1, stride).copy()
    require(0 < len(data) <= MAX_VERTICES and np.isfinite(data).all(), "Empty, oversized or nonfinite native stream")
    return data


def validate_triangles(data, label):
    require(0 < len(data) <= MAX_VERTICES and len(data) % 3 == 0 and np.isfinite(data).all(), f"Invalid {label} triangles")
    normals = np.linalg.norm(data[:, 3:6].astype(np.float64), axis=1)
    require(np.all(np.abs(normals - 1) < 2e-4), f"Non-unit {label} normals")
    triangles = data[:, :3].reshape(-1, 3, 3).astype(np.float64)
    area = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1)
    require(np.all(area > 1e-12), f"Degenerate {label} triangle")
    require(np.max(np.abs(data[:, :3])) < 1e7, f"Unbounded {label} coordinates")
    require(np.all((data[:, 7] >= 0) & (data[:, 7] <= 1)), f"Invalid {label} exposure")


def glb_primitives(raw):
    require(len(raw) >= 20, "Truncated canopy GLB")
    magic, version, length = struct.unpack_from("<III", raw)
    require(magic == 0x46546C67 and version == 2 and length == len(raw), "Invalid canopy GLB header")
    chunks = {}
    offset = 12
    while offset < len(raw):
        require(offset + 8 <= len(raw), "Truncated GLB chunk")
        size, kind = struct.unpack_from("<II", raw, offset)
        offset += 8
        require(size % 4 == 0 and offset + size <= len(raw) and kind not in chunks, "Invalid or duplicate GLB chunk")
        chunks[kind] = raw[offset:offset + size]
        offset += size
    require(0x4E4F534A in chunks and 0x004E4942 in chunks, "GLB needs JSON and BIN chunks")
    gltf = finite_json(chunks[0x4E4F534A].decode("utf8"))
    blob = chunks[0x004E4942]
    require(gltf.get("asset", {}).get("version") == "2.0" and not any(gltf.get(key) for key in ("images", "textures", "skins", "animations", "extensionsRequired")), "Only static, texture-free GLB is supported")
    require(len(gltf.get("buffers", [])) == 1 and "uri" not in gltf["buffers"][0] and gltf["buffers"][0]["byteLength"] <= len(blob), "Unsupported GLB buffer")
    require(len(gltf.get("nodes", [])) == 1 and len(gltf.get("meshes", [])) == 1, "Expected the source's single-node canopy GLB")
    scene = gltf.get("scenes", [])[gltf.get("scene", 0)]
    node = gltf["nodes"][0]
    require(scene.get("nodes") == [0] and node.get("mesh") == 0 and not node.get("children") and "matrix" not in node, "Unsupported canopy scene transform")
    rotation = node.get("rotation", [0, 0, 0, 1])
    translation = node.get("translation", [0, 0, 0])
    scale = node.get("scale", [1, 1, 1])
    require(point(rotation, 4) and point(translation) and point(scale) and all(x > 0 for x in scale) and abs(sum(x * x for x in rotation) - 1) < 1e-8, "Invalid GLB TRS")
    x, y, z, w = rotation
    matrix = np.array([[1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)],
                       [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
                       [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)]], dtype=np.float64) @ np.diag(scale)
    normal_matrix = np.linalg.inv(matrix).T

    def accessor(index):
        require(isinstance(index, int) and 0 <= index < len(gltf.get("accessors", [])), "Invalid accessor index")
        a = gltf["accessors"][index]
        require("sparse" not in a and not a.get("normalized"), "Sparse/normalized accessors are unsupported")
        types = {5121: ("<u1", 1), 5123: ("<u2", 2), 5125: ("<u4", 4), 5126: ("<f4", 4)}
        components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}
        require(a.get("componentType") in types and a.get("type") in components, "Unsupported accessor storage")
        dtype, item = types[a["componentType"]]
        columns, count = components[a["type"]], a.get("count")
        require(isinstance(count, int) and 0 < count <= MAX_VERTICES, "Invalid accessor count")
        vi = a.get("bufferView")
        require(isinstance(vi, int) and 0 <= vi < len(gltf.get("bufferViews", [])), "Invalid bufferView index")
        view = gltf["bufferViews"][vi]
        require(view.get("buffer", 0) == 0, "External GLB bufferView")
        start, view_size, relative = view.get("byteOffset", 0), view["byteLength"], a.get("byteOffset", 0)
        stride = view.get("byteStride", columns * item)
        require(all(isinstance(n, int) and n >= 0 for n in (start, view_size, relative, stride)) and stride >= columns * item
                and start + view_size <= len(blob) and relative + (count - 1) * stride + columns * item <= view_size, "Accessor exceeds source bufferView")
        values = np.ndarray((count, columns), dtype=dtype, buffer=blob, offset=start + relative, strides=(stride, item)).copy()
        require(np.isfinite(values).all(), "Nonfinite GLB accessor")
        return values

    result = []
    materials = gltf.get("materials", [])
    for primitive in gltf["meshes"][0].get("primitives", []):
        require(primitive.get("mode", 4) == 4 and "targets" not in primitive, "Expected static triangle primitives")
        attributes = primitive.get("attributes", {})
        require(all(key in attributes for key in ("POSITION", "NORMAL", "TEXCOORD_0")), "Missing canopy vertex attribute")
        positions, normals, uv = (accessor(attributes[key]) for key in ("POSITION", "NORMAL", "TEXCOORD_0"))
        require(positions.shape == normals.shape and positions.shape[1] == 3 and uv.shape == (len(positions), 2), "Mismatched canopy attributes")
        require(all(values.dtype == np.dtype("<f4") for values in (positions, normals, uv)), "Canopy attributes must use Float32 storage")
        indices = accessor(primitive["indices"])
        require(indices.shape[1] == 1 and np.issubdtype(indices.dtype, np.integer) and len(indices) % 3 == 0 and indices.max() < len(positions), "Invalid canopy triangle indices")
        material_id = primitive.get("material")
        require(isinstance(material_id, int) and 0 <= material_id < len(materials), "Missing canopy material")
        material = materials[material_id]
        factor = material.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])
        require(point(factor, 4) and all(0 <= value <= 1 for value in factor), "Invalid linear material factor")
        world = (positions.astype(np.float64) @ matrix.T + np.asarray(translation)).astype("<f4")
        world_normals = normals.astype(np.float64) @ normal_matrix.T
        lengths = np.linalg.norm(world_normals, axis=1)
        require(np.all(lengths > 1e-12), "Invalid transformed normal")
        world_normals = (world_normals / lengths[:, None]).astype("<f4")
        index = indices.ravel()
        result.append({"material": material, "colour": np.asarray(factor[:3], dtype="<f4"),
                       "positions": world[index], "normals": world_normals[index], "uv": uv[index].astype("<f4")})
    require(result, "Canopy GLB has no primitives")
    return result, {"rotation": rotation, "translation": translation, "scale": scale}


def terrain_inputs(folder, source):
    raw = (folder / "manifest.json").read_bytes()
    manifest = finite_json(raw)
    region = source["region"]
    origin = manifest["localOrigin"]
    require(manifest.get("id", folder.name) == region["id"] and manifest["gridSize"] == region["gridSize"]
            and manifest["spanMetres"] == region["spanMetres"] and origin == region["localOrigin"], "Canopy region differs from runtime terrain")
    size, span = manifest["gridSize"], manifest["spanMetres"]
    require(isinstance(size, int) and 2 <= size <= 4097 and math.isfinite(span) and span > 0, "Invalid terrain dimensions")
    height_name = basename(manifest.get("assets", {}).get("height", "height.bin"))
    biome_name = basename(manifest.get("assets", {}).get("biome", "biome.bin"))
    height_raw, biome_raw = (folder / height_name).read_bytes(), (folder / biome_name).read_bytes()
    require(len(height_raw) == size * size * 2 and digest(height_raw) == manifest.get("heightSHA256"), "Terrain height receipt mismatch")
    mask = manifest.get("vegetation", {}).get("maskSize")
    require(isinstance(mask, int) and 0 < mask <= 4096 and len(biome_raw) == mask * mask
            and digest(biome_raw) == manifest.get("vegetation", {}).get("sha256"), "Terrain biome receipt mismatch")
    heights = np.frombuffer(height_raw, dtype="<i2").reshape(size, size).astype(np.float64) * .25

    def sample(x, z):
        u = (x - origin["x"]) / span + .5
        v = (z - origin["z"]) / span + .5
        require(0 <= u <= 1 and 0 <= v <= 1, "Stem is outside terrain domain")
        s = size - 1
        ix, iz = min(s - 1, max(0, math.floor(u * s))), min(s - 1, max(0, math.floor(v * s)))
        a, b, step = u * s - ix, v * s - iz, span / s
        h00, h10, h01, h11 = heights[iz, ix], heights[iz, ix+1], heights[iz+1, ix], heights[iz+1, ix+1]
        if a + b <= 1:
            sx, sz = (h10-h00)/step, (h01-h00)/step
            return h00 + a*(h10-h00) + b*(h01-h00), sx, sz
        sx, sz = (h11-h01)/step, (h11-h10)/step
        return h11 + (1-a)*(h01-h11) + (1-b)*(h10-h11), sx, sz

    return sample, raw, {"manifest.json": receipt(raw), height_name: receipt(height_raw), biome_name: receipt(biome_raw)}


def validate_stems(source, instances, sample):
    stems, species = source.get("stems"), source.get("species")
    require(isinstance(stems, list) and len(stems) == source.get("stemsCount") == len(instances) and len(stems) <= 100_000, "Stem/instance count mismatch")
    require(isinstance(species, list) and species and len(set(species)) == len(species) and all(isinstance(s, str) for s in species), "Invalid species list")
    bounds = source["region"].get("domainBoundsXZ")
    require(point(bounds, 4) and bounds[0] < bounds[1] and bounds[2] < bounds[3], "Invalid source coverage domain")
    for i, (stem, row) in enumerate(zip(stems, instances)):
        require(stem.get("index") == i and stem.get("genome") in species, "Stem order/identity mismatch")
        require(all(isinstance(stem.get(key), (int, float)) and math.isfinite(stem[key]) for key in ("x", "y", "z_ww", "z_ground", "sx", "sz", "yaw_rad", "collar_sink_m")), "Invalid stem metadata")
        x, h, z, radius, height, shape, sx, sz = map(float, row)
        require(bounds[0] - .002 <= x <= bounds[1] + .002 and bounds[2] - .002 <= z <= bounds[3] + .002 and radius > 0 and height > 0, "Invalid instance footprint")
        require(abs(x-stem["x"]) <= .002 and abs(z-stem["z_ww"]) <= .002 and abs(z+stem["y"]) <= .002 and abs(h-stem["z_ground"]) <= .002, "Instance is not its authored stem")
        ground, tx, tz = sample(x, z)
        require(abs(h-ground) <= .002 and abs(sx-tx) <= 2e-5 and abs(sz-tz) <= 2e-5, "Instance does not sit on the runtime terrain triangle")
        expected_shape = (species.index(stem["genome"]) + .5) / len(species)
        require(abs(shape-expected_shape) < 1e-6 and 0 <= stem["yaw_rad"] <= 2*math.pi and stem["collar_sink_m"] >= 0, "Invalid species/yaw/collar contract")
    return stems, species, list(bounds)


def coloured(data, rgb):
    return np.column_stack((data, np.broadcast_to(rgb, (len(data), 3)))).astype("<f4")


def verify_opaque_block(block, stem, instance):
    # Current source emits exactly12trunk+32closedcrown triangles per stem. This
    # is a verified supported topology, never an unchecked44-triangle stride.
    require(block.shape == (132, 10) and np.all(block[:36, 6] == 3) and np.all(block[36:, 6] == 4), "Unsupported opaque stem topology")
    trunk = np.unique(block[:36, :3], axis=0).astype(np.float64)
    require(len(trunk) == 12, "Opaque trunk is not a six-sided prism")
    levels, counts = np.unique(trunk[:, 1], return_counts=True)
    require(len(levels) == 2 and list(counts) == [6, 6], "Opaque trunk end rings are invalid")
    base = trunk[trunk[:, 1] == levels[0]]
    require(np.max(np.abs(base[:, [0, 2]].mean(axis=0)-instance[[0, 2]])) < .002 and abs(levels[0]-(stem["z_ground"]-.15)) < .002, "Opaque block does not belong to this stem root")
    basal_radius = float(np.linalg.norm(base[:, [0, 2]]-base[:, [0, 2]].mean(axis=0), axis=1).mean())
    slope = math.hypot(float(instance[6]), float(instance[7]))
    sink = stem["collar_sink_m"]
    if basal_radius > .0805:
        require(abs(sink-(basal_radius*slope+.04)) < .002, "Collar sink disagrees with actual basal radius/slope")
    else:
        require(.038 <= sink <= .042+.081*slope, "Small-stem collar sink is outside its source construction bound")
    crown = block[36:, :3]
    vertices, inverse = np.unique(crown, axis=0, return_inverse=True)
    require(len(vertices) == 18, "Opaque crown is not the supported octagonal dome")
    levels, counts = np.unique(vertices[:, 1], return_counts=True)
    require(len(levels) == 4 and list(counts) == [1, 8, 8, 1], "Opaque crown rings/caps are invalid")
    bottom, top = vertices[vertices[:, 1] == levels[0]][0], vertices[vertices[:, 1] == levels[-1]][0]
    require(np.max(np.abs(bottom[[0, 2]]-top[[0, 2]])) < .002, "Opaque dome caps disagree")
    height = float(levels[-1]-levels[0])
    require(abs(float(levels[1])-(float(levels[0])+.26*height)) < .002 and abs(float(levels[2])-(float(levels[0])+.74*height)) < .002, "Opaque dome ring elevations changed")
    triangles = inverse.reshape(-1, 3)
    edges = Counter(tuple(sorted((int(t[i]), int(t[(i+1)%3])))) for t in triangles for i in range(3))
    require(len(edges) == 48 and all(count == 2 for count in edges.values()), "Opaque crown is not a closed connected surface")
    require(np.linalg.norm(bottom[[0, 2]]-instance[[0, 2]]) <= instance[3]+8, "Crown is unrelated to its stem")
    trunk_top = trunk[trunk[:, 1] == trunk[:, 1].max()]
    require(np.max(np.abs(trunk_top[:, [0, 2]].mean(axis=0)-bottom[[0, 2]])) < .002
            and abs(float(trunk_top[0, 1])-(float(bottom[1])+.25*height)) < .002, "Opaque trunk does not join the crown interior")


def import_geometry(source, opaque, leaf, instances, primitives):
    stems, species = source["stems"], source["species"]
    materials = {}
    for primitive in primitives:
        name = primitive["material"].get("name")
        require(name not in materials and any(name == f"{s}_{part}" for s in species for part in ("bark", "foliage")), "Unknown or duplicate GLB species material")
        materials[name] = primitive
    require(len(materials) == len(species)*2, "Missing bark/foliage material split")
    leaf_parts, near_parts, offset = [], [], 0
    for species_id in species:
        bark, foliage = materials[f"{species_id}_bark"], materials[f"{species_id}_foliage"]
        count = len(foliage["positions"])
        require(count == int(source["shellCulling"][species_id]["faces_kept"])*3 and offset+count <= len(leaf), "Native/GLB species foliage ranges disagree")
        native = leaf[offset:offset+count]
        require(np.all(native[:, 6] == 4) and np.allclose(native[:, :3], foliage["positions"], atol=.001, rtol=0)
                and np.allclose(native[:, 3:6], foliage["normals"], atol=3e-5, rtol=0)
                and np.allclose(native[:, 8:10], foliage["uv"], atol=1e-6, rtol=0), "GLB/native foliage coordinate correspondence failed")
        leaf_parts.append(coloured(native, foliage["colour"]))
        near = np.column_stack((bark["positions"], bark["normals"], np.full((len(bark["positions"]), 1), 3), np.full((len(bark["positions"]), 1), .44), bark["uv"]))
        near_parts.append(coloured(near, bark["colour"]))
        offset += count
    require(offset == len(leaf) and len(opaque) == len(stems)*132, "Unsupported opaque or cutout source count")
    far_parts = []
    for i, (stem, instance) in enumerate(zip(stems, instances)):
        block = opaque[i*132:(i+1)*132]
        verify_opaque_block(block, stem, instance)
        wood = materials[f"{stem['genome']}_bark"]["positions"].astype(np.float64)
        collar = np.array([stem["x"], stem["z_ground"]-stem["collar_sink_m"], stem["z_ww"]])
        # Source shoot tubes include the biological root cap centre. This ties
        # each species primitive to its seated stem, including the declared
        # slope-dependent collar sink, instead of trusting manifest order alone.
        require(float(np.linalg.norm(wood-collar, axis=1).min()) < .003, "Detailed wood root does not match its terrain/collar placement")
        rgb = np.where((block[:, 6] == 3)[:, None], materials[f"{stem['genome']}_bark"]["colour"], materials[f"{stem['genome']}_foliage"]["colour"])
        far_parts.append(np.column_stack((block, rgb)).astype("<f4"))
    streams = {"near": np.concatenate(near_parts), "leaf": np.concatenate(leaf_parts), "far": np.concatenate(far_parts)}
    for name, data in streams.items():
        validate_triangles(data, name)
    palette = {name: p["material"] for name, p in materials.items()}
    return streams, palette


def conservative_error(a, b):
    if not len(a) or not len(b):
        return None

    def directed(first, opposite):
        triangles = first[:, :3].reshape(-1, 3, 3).astype(np.float64)
        points = opposite[:, :3].astype(np.float64)
        # The KD-tree merely chooses a convenient point on the opposite mesh;
        # its search accuracy cannot invalidate the upper-bound proof.
        _, indices = cKDTree(points).query(triangles.mean(axis=1), k=1, workers=1)
        delta = triangles-points[indices, None, :]
        return float(np.sqrt(np.sum(delta*delta, axis=2)).max())

    bound = max(directed(a, b), directed(b, a))
    # Round upward, including conservative floating arithmetic allowance. This
    # does not turn geometric error into an alpha-coverage guarantee.
    return math.nextafter(bound*(1+64*np.finfo(np.float64).eps)+1e-12, math.inf)


def leaf_texel_span(data, width, height):
    """World diagonal of one base-level alpha texel, not alpha error."""
    if not len(data):
        return 0.0
    triangles = data.reshape(-1, 3, 13).astype(np.float64)
    e1, e2 = triangles[:, 1, :3]-triangles[:, 0, :3], triangles[:, 2, :3]-triangles[:, 0, :3]
    uv1, uv2 = triangles[:, 1, 8:10]-triangles[:, 0, 8:10], triangles[:, 2, 8:10]-triangles[:, 0, 8:10]
    determinant = uv1[:, 0]*uv2[:, 1]-uv1[:, 1]*uv2[:, 0]
    if np.any(np.abs(determinant) < 1e-12):
        return None
    du = (e1*uv2[:, 1, None]-e2*uv1[:, 1, None])/determinant[:, None]/width
    dv = (e2*uv1[:, 0, None]-e1*uv2[:, 0, None])/determinant[:, None]/height
    maximum = float(np.maximum(np.linalg.norm(du+dv, axis=1), np.linalg.norm(du-dv, axis=1)).max())
    return math.nextafter(maximum*(1+64*np.finfo(np.float64).eps)+1e-12, math.inf)


def alpha_fallback():
    path = ROOT/"assets/tree-foliage.png"
    if not path.is_file():
        return None
    raw = path.read_bytes()
    require(len(raw) >= 24 and raw[:8] == b"\x89PNG\r\n\x1a\n" and raw[12:16] == b"IHDR", "Invalid fallback foliage PNG")
    width, height = struct.unpack_from(">II", raw, 16)
    require(0 < width <= 16384 and 0 < height <= 16384, "Invalid fallback foliage dimensions")
    return {"path": "assets/tree-foliage.png", "width": width, "height": height, **receipt(raw)}


def partition(streams, alpha=None):
    grouped = {}
    for name, data in streams.items():
        triangles = data.reshape(-1, 3, 13)
        centre = triangles[:, :, :3].astype(np.float64).mean(axis=1)
        cells = np.floor(centre[:, [0, 2]] / PATCH_METRES).astype(np.int64)
        for index, cell in enumerate(cells):
            key = (int(cell[0]), int(cell[1]))
            grouped.setdefault(key, {"near": [], "leaf": [], "far": []})[name].append(index)
    packed = {name: [] for name in streams}
    offsets = {name: 0 for name in streams}
    patches = []
    for key in sorted(grouped):
        layers = {}
        patch = {"id": f"{key[0]}:{key[1]}"}
        for name, data in streams.items():
            indices = grouped[key][name]
            layer = data.reshape(-1, 3, 13)[indices].reshape(-1, 13) if indices else np.empty((0, 13), dtype="<f4")
            layers[name] = layer
            patch[name] = {"firstVertex": offsets[name], "vertexCount": len(layer)}
            packed[name].append(layer)
            offsets[name] += len(layer)
        positions = np.concatenate([layer[:, :3] for layer in layers.values() if len(layer)]).astype(np.float64)
        low, high = positions.min(axis=0), positions.max(axis=0)
        centre = (low+high)*.5
        radius = math.nextafter(float(np.linalg.norm((high-low)*.5))*(1+64*np.finfo(np.float64).eps)+1e-12, math.inf)
        error = conservative_error(np.concatenate((layers["near"], layers["leaf"])), layers["far"])
        patch.update(low=low.tolist(), high=high.tolist(), centre=centre.tolist(), radius=radius,
                     geometryErrorMetres=error, geometryErrorSupported=error is not None)
        patch["leafAlphaTexelMetres"] = leaf_texel_span(layers["leaf"], alpha["width"], alpha["height"]) if alpha else None
        patches.append(patch)
    return {name: np.concatenate(parts).astype("<f4") for name, parts in packed.items()}, patches


def generator_snapshot(folder):
    if folder is None:
        return None
    folder = folder.resolve()
    names = ["gardenplans/scenery.py", "gardenplans/export.py", "gardenplans/cache.py", "gardenplans/grow_colonize.py", "gardenplans/plan.py", "gardenplans/organs.py"]
    records = {name: receipt((folder/name).read_bytes()) for name in names if (folder/name).is_file()}
    def git(*args):
        try:
            result = subprocess.run(["git", "-C", str(folder), *args], capture_output=True, text=True, check=False)
            return result.stdout.strip() if result.returncode == 0 else None
        except OSError:
            return None
    return {"headAtImport": git("rev-parse", "HEAD"), "statusAtImport": git("status", "--porcelain", "--untracked-files=normal"), "filesAtImport": records,
            "claim": "Inspection-time source snapshot only. The old bake manifest does not identify its generating source revision; reproduction is not asserted."}


def prepare(manifest_path, region_path, output, forestmodeler=None, force=False):
    manifest_path, region_path, output = manifest_path.resolve(), region_path.resolve(), output.resolve()
    if output.exists():
        require(force, "Output exists; use --force to explicitly replace this imported pack")
        existing = output/"manifest.json"
        require(existing.is_file() and finite_json(existing.read_bytes()).get("format") == FORMAT, "Refusing to replace an unrelated directory")
    require(manifest_path.name.endswith("_waterworld_manifest.json"), "Expected a *_waterworld_manifest.json source")
    stem = basename(manifest_path.name.removesuffix("_waterworld_manifest.json"))
    source_raw = manifest_path.read_bytes()
    require(len(source_raw) <= MAX_INPUT_BYTES, "Source manifest exceeds bounded input size")
    source = finite_json(source_raw)
    require(source.get("format") == "waterworld.canopy-scenery" and source.get("version") == 1 and source.get("units") == "metres" and source.get("upAxis") == "Y", "Unsupported source canopy format")
    require(source.get("vertexLayout", {}).get("strideFloats") == 10 and source["vertexLayout"].get("strideBytes") == 40
            and source["vertexLayout"].get("attributes") == ATTRIBUTES[:10]
            and source.get("instanceLayout", {}).get("strideFloats") == 8 and source["instanceLayout"].get("strideBytes") == 32
            and source["instanceLayout"].get("attributes") == ["x", "h", "z", "radius", "height", "shape", "sx", "sz"], "Unsupported source binary layouts")
    names = {name: f"{stem}_{suffix}" for name, suffix in (("far", "canopy_opaque.bin"), ("leaf", "canopy_cutout.bin"), ("instances", "instances.bin"), ("glb", "canopy.glb"))}
    raw = {key: read_receipted(manifest_path.parent, name, source.get("files", {})) for key, name in names.items()}
    opaque, leaf, instances = native_stream(raw["far"], 10), native_stream(raw["leaf"], 10), native_stream(raw["instances"], 8)
    validate_triangles(opaque, "source opaque")
    validate_triangles(leaf, "source leaf")
    require(source.get("triangles", {}).get("opaque_dome_and_trunk") == len(opaque)//3
            and source["triangles"].get("cutout_foliage_culled") == len(leaf)//3, "Source triangle receipts disagree with stream counts")
    sample, region_raw, terrain_receipts = terrain_inputs(region_path, source)
    stems, species, domain = validate_stems(source, instances, sample)
    primitives, transform = glb_primitives(raw["glb"])
    streams, materials = import_geometry(source, opaque, leaf, instances, primitives)
    require(source["triangles"].get("glb_wood") == len(streams["near"])//3
            and source["triangles"].get("glb_foliage_culled") == len(streams["leaf"])//3, "GLB triangle receipts disagree with imported counts")
    alpha = alpha_fallback()
    streams, patches = partition(streams, alpha)
    provenance = {"sourceManifest": {"filename": manifest_path.name, **receipt(source_raw)},
                  "sourceFiles": {names[key]: receipt(value) for key, value in raw.items()},
                  "terrainAtImport": terrain_receipts, "generatorSnapshot": generator_snapshot(forestmodeler),
                  "alphaFallbackAtImport": alpha,
                  "coordinates": {"native": "World Y-up metres; copied once, without root transform", "glbNodeApplied": transform},
                  "sourceLimit": "Output byte receipts are verified. Current source snapshot is not evidence that it produced the previous bake."}
    manifest = {"format": FORMAT, "version": 1, "upAxis": "Y", "units": "metres",
                "vertexLayout": {"strideFloats": 13, "strideBytes": 52, "attributes": ATTRIBUTES},
                "instanceLayout": source["instanceLayout"], "region": source["region"],
                "coverage": {"kind": "rectangle", "boundsXZ": domain}, "patchMetres": PATCH_METRES,
                "patches": patches, "stems": stems, "species": species, "materials": materials,
                "textureAlphaErrorMetres": None, "textureAlphaErrorSupported": False,
                "alphaFallback": alpha,
                "leafAlphaTexelScope": "Per-patch leafAlphaTexelMetres bounds one base-level texel's affine world diagonal only. This is not alpha reconstruction or silhouette error.",
                "alphaApproximation": "Existing Waterworld foliage texture; source GLB/BIN has no alpha texture, no certified alpha/silhouette error.",
                "geometryErrorMethod": "Symmetric upper bound: max over each triangle of its three vertex distances to one selected vertex on the opposing representation; near+leaf versus far. Whole triangles are assigned by centroid; bounds retain their full extent.",
                "geometryErrorScope": "Opaque geometric triangle surfaces only; excludes alpha coverage, lighting, texture and wind differences.",
                "sourceManifest": "source-manifest.json", "sourceRegion": "source-region.json", "provenance": "provenance.json",
                "limits": ["Imported source patch only; preserve other regional vegetation outside coverage.", "Temperate source taxa; not surveyed Caribbean flora.", "No forest interior-depth atlas or certified pixel LOD follows from standVolumes:true.", "Static baked world geometry; no per-stem wind deformation is added.", "Instance shape stores normalized species order; actual identity/yaw are manifest.stems.", "Material RGB factors already linear; do not apply sRGB conversion again."], "files": {}}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".canopy-import-", dir=output.parent) as temporary:
        staging = Path(temporary)/"pack"
        staging.mkdir()
        for name, data in streams.items():
            contents = data.tobytes()
            (staging/f"{name}.bin").write_bytes(contents)
            manifest["files"][f"{name}.bin"] = receipt(contents, vertexCount=len(data), triangleCount=len(data)//3)
        files = {"instances.bin": raw["instances"], "source-manifest.json": source_raw, "source-region.json": region_raw,
                 "provenance.json": (json.dumps(provenance, indent=2, sort_keys=True, allow_nan=False)+"\n").encode()}
        for name, contents in files.items():
            (staging/name).write_bytes(contents)
            manifest["files"][name] = receipt(contents, **({"instanceCount": len(instances)} if name == "instances.bin" else {}))
        (staging/"manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False)+"\n")
        if output.exists():
            shutil.rmtree(output)
        staging.rename(output)
    print(f"Imported {len(stems)} source trees, {len(patches)} spatial patches -> {output}")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT.parent/"forestmodeler/out/waterworld_scenery/saba_mixed_waterworld_manifest.json")
    parser.add_argument("--region", type=Path, default=ROOT/"assets/world/saba")
    parser.add_argument("--out", type=Path, default=ROOT/"assets/canopy-scenery/saba")
    parser.add_argument("--forestmodeler", type=Path, default=ROOT.parent/"forestmodeler")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    prepare(args.manifest, args.region, args.out, args.forestmodeler, args.force)
