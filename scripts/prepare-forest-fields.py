#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Cache continuous mature-native leaf area and pigment, without growing trees.

Read only the original indexed wood/leaf ranges and receipted native PNGs.
Adaptive triangle quadrature applies the source MASK at original UVs; accepted
samples deposit true triangle area, not triangle counts or a fitted crown.
The Gaussian is an explicit render approximation. Its exact finite support and
unresolved MASK area are recorded; no silhouette/colour certificate is implied.
No connected components, holes, branches or small islands are removed.

Root executes, for example:
  uv run --with pillow --with scipy python scripts/prepare-forest-fields.py \
    --pack /tmp/waterworld-mature-dense-forest-237 --output /tmp/native-fields

NPZ coordinates are voxel CENTRES. Density is leaf m2 / volume m3; rgbMoment
is linear RGB times that density. At uniform root scale s, sample both fields
at inverse-transformed coordinates and divide by s; tint rgbMoment once. Add
overlapping continuous fields before choosing any later authored isosurface.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

import numpy as np
from PIL import Image
from scipy.ndimage import convolve1d

FORMAT = "waterworld.native-forest-fields"
SPECIES = ("oak", "maple", "birch", "elm", "chestnut")
MAX_STREAM_BYTES = 256*1024*1024
MAX_MAP_BYTES = 16*1024*1024
MAX_MAP_PIXELS = 2048*2048
MAX_VOXELS = 8_000_000
MAX_TRIANGLES = 5_000_000
MAX_PATCHES = 40_000_000
CHUNK_TRIANGLES = 8192


def require(value, message):
    if not value:
        raise ValueError(message)


def receipt(raw):
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def safe_name(name):
    require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name), "Unsafe source filename")
    return name


def finite_json(raw):
    def reject(value):
        raise ValueError("Nonfinite JSON: "+value)
    return json.loads(raw, parse_constant=reject)


def verify_receipt(raw, item, name):
    require(isinstance(item, dict) and type(item.get("bytes")) is int
            and item["bytes"] >= 0 and isinstance(item.get("sha256"), str)
            and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]), "Invalid receipt: "+name)
    require(receipt(raw) == {key: item[key] for key in ("bytes", "sha256")}, "Source receipt mismatch: "+name)


def read_receipted(folder, name, item, limit=MAX_STREAM_BYTES):
    safe_name(name)
    require(type(item.get("bytes")) is int and 0 <= item["bytes"] <= limit, "Oversized source: "+name)
    path = folder/name
    if path.is_file():
        require(path.stat().st_size <= limit, "Oversized source file: "+name)
        raw = path.read_bytes()
    else:
        encoded = item.get("gzip", {})
        encoded_name = safe_name(encoded.get("file"))
        path = folder/encoded_name
        require(path.stat().st_size <= limit, "Oversized compressed source: "+name)
        compressed = path.read_bytes()
        verify_receipt(compressed, encoded, encoded_name)
        # Bounded inflation also rejects concatenated or oversized gzip payloads.
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
            raw = stream.read(item["bytes"]+1)
            require(len(raw) == item["bytes"] and not stream.read(1), "Decoded source size mismatch: "+name)
    verify_receipt(raw, item, name)
    return raw


def linear_rgb(encoded):
    values = np.asarray(encoded, dtype=np.float64)/255.
    return np.where(values <= .04045, values/12.92, ((values+.055)/1.055)**2.4)


def load_materials(folder, prototype, files):
    result, records = [], []
    materials = prototype.get("nativeMaterials")
    require(isinstance(materials, list) and 1 <= len(materials) <= 16, "Missing native materials")
    for ordinal, material in enumerate(materials):
        require(material.get("index") == ordinal and isinstance(material.get("name"), str), "Noncanonical native material slots")
        record = {key: value for key, value in material.items() if key not in ("albedo", "normal", "roughnessMap")}
        maps = {}
        for key in ("albedo", "normal", "roughnessMap"):
            item = material.get(key)
            if item is None:
                require(key == "roughnessMap", "Missing native "+key)
                continue
            name = safe_name(item.get("file"))
            require(name in files and all(item.get(k) == files[name].get(k) for k in ("bytes", "sha256")), "Unbound native map receipt")
            require(item.get("encoding") == ("srgb" if key == "albedo" else "linear"), "Wrong native map encoding")
            raw = read_receipted(folder, name, item, MAX_MAP_BYTES)
            with Image.open(io.BytesIO(raw)) as image:
                require(image.format == "PNG" and image.width*image.height <= MAX_MAP_PIXELS
                        and image.width == item.get("width") and image.height == item.get("height"), "Native map dimensions/format mismatch")
                if key == "albedo":
                    pixels = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
            maps[key] = {"file": name, **receipt(raw), "encoding": item["encoding"],
                         "width": item["width"], "height": item["height"]}
        cutoff = material.get("opacityThreshold")
        require(isinstance(cutoff, (float, int)) and math.isfinite(cutoff) and 0 <= cutoff <= 1, "Invalid native MASK threshold")
        require(material.get("wrap") in ("clamp", "repeat"), "Unknown native wrap")
        result.append({"name": material["name"], "cutoff": float(cutoff),
                       "rgba": pixels, "rgb": linear_rgb(pixels[:, :, :3]),
                       "alpha": pixels[:, :, 3].astype(np.float64)/255.})
        records.append({**record, **maps})
    return result, records


def range_indices(prototype, name, indices):
    value = prototype.get(name)
    require(isinstance(value, dict) and type(value.get("firstIndex")) is int
            and type(value.get("indexCount")) is int and value["firstIndex"] >= 0
            and value["indexCount"] > 0 and value["indexCount"] % 3 == 0
            and value["firstIndex"]+value["indexCount"] <= len(indices), "Invalid original "+name+" range")
    require(value["indexCount"]//3 <= MAX_TRIANGLES, "Native triangle budget exceeded")
    return indices[value["firstIndex"]:value["firstIndex"]+value["indexCount"]].reshape(-1, 3)


def validate_geometry(prototype, vertices, indices, materials):
    records, leaf_low, leaf_high = {}, np.full(3, math.inf), np.full(3, -math.inf)
    for name in ("wood", "leaf"):
        own = range_indices(prototype, name, indices)
        digest = hashlib.sha256()
        for start in range(0, len(own), CHUNK_TRIANGLES):
            selected = own[start:start+CHUNK_TRIANGLES]
            require(np.all(selected < len(vertices)), "Original native index outside vertex stream")
            rows = vertices[selected]
            require(np.isfinite(rows).all(), "Nonfinite native triangle")
            require(np.all(np.abs(np.linalg.norm(rows[:, :, 3:6], axis=2)-1) <= .01), "Invalid original native normals")
            slots = rows[:, :, 13]
            require(np.all(slots == np.floor(slots)) and np.all(slots >= 0)
                    and np.all(slots < len(materials)) and np.all(slots == slots[:, :1]), "Mixed/invalid native material triangle")
            require(np.all(rows[:, :, 6] == 3) if name == "wood" else np.all(rows[:, :, 6] >= 4), "Non-native geometry in detailed range")
            require(np.all((rows[:, :, 10:13] >= 0) & (rows[:, :, 10:13] <= 1)), "Invalid native linear vertex pigment")
            for slot in np.unique(slots.astype(int)):
                require(materials[slot]["name"].startswith("foliage_") == (name == "leaf"), "Native material/range disagreement")
                if name == "leaf":
                    require(materials[slot]["name"].startswith("foliage_") and materials[slot]["cutoff"] >= 0, "Missing native leaf material")
            digest.update(rows.tobytes(order="C"))
            if name == "leaf":
                leaf_low = np.minimum(leaf_low, rows[:, :, :3].min(axis=(0, 1)))
                leaf_high = np.maximum(leaf_high, rows[:, :, :3].max(axis=(0, 1)))
                require(np.all((rows[:, :, 8:10] >= -1e-6) & (rows[:, :, 8:10] <= 1+1e-6)), "Native leaf UV outside clamped source map")
        records[name] = {**prototype[name], "indices": receipt(own.tobytes(order="C")),
                         "triangleRows": {"bytes": int(own.size*56), "sha256": digest.hexdigest(), "strideFloats": 14}}
    require(np.isfinite(leaf_low).all() and np.all(leaf_high >= leaf_low)
            and np.linalg.norm(leaf_high-leaf_low) > 0, "Degenerate native foliage bounds")
    return records, leaf_low, leaf_high


def alpha_pyramid(alpha):
    """Conservative UV rectangle bounds; bilinear alpha lies within its texels."""
    result = [(alpha, alpha)]
    while max(result[-1][0].shape) > 1:
        low, high = result[-1]
        pad = ((0, low.shape[0] % 2), (0, low.shape[1] % 2))
        low, high = np.pad(low, pad, mode="edge"), np.pad(high, pad, mode="edge")
        result.append((np.minimum.reduce((low[0::2, 0::2], low[1::2, 0::2], low[0::2, 1::2], low[1::2, 1::2])),
                       np.maximum.reduce((high[0::2, 0::2], high[1::2, 0::2], high[0::2, 1::2], high[1::2, 1::2]))))
    return result


def mask_bounds(uv, pyramid):
    height, width = pyramid[0][0].shape
    coords = np.clip(uv, 0, 1)*[width, height]-.5
    lo, hi = np.floor(coords.min(axis=1)).astype(int), np.ceil(coords.max(axis=1)).astype(int)
    lo, hi = np.clip(lo, [0, 0], [width-1, height-1]), np.clip(hi, [0, 0], [width-1, height-1])
    span = np.maximum(hi-lo+1, 1).max(axis=1)
    levels = np.ceil(np.log2(span)).astype(int)
    lower, upper = np.empty(len(uv)), np.empty(len(uv))
    for level in np.unique(levels):
        ids = np.flatnonzero(levels == level);small, large = pyramid[min(int(level), len(pyramid)-1)]
        a, b = lo[ids]//(2**int(level)), hi[ids]//(2**int(level))
        lower[ids] = np.minimum.reduce((small[a[:, 1], a[:, 0]], small[b[:, 1], a[:, 0]], small[a[:, 1], b[:, 0]], small[b[:, 1], b[:, 0]]))
        upper[ids] = np.maximum.reduce((large[a[:, 1], a[:, 0]], large[b[:, 1], a[:, 0]], large[a[:, 1], b[:, 0]], large[b[:, 1], b[:, 0]]))
    return lower, upper


def bilinear_native(material, uv):
    """GPU clamp-to-edge coordinates; decode sRGB BEFORE bilinear filtering."""
    height, width = material["alpha"].shape
    q = np.clip(uv, 0, 1)*[width, height]-.5;floor = np.floor(q).astype(int);fraction = q-floor
    low, high = np.clip(floor, [0, 0], [width-1, height-1]), np.clip(floor+1, [0, 0], [width-1, height-1])
    rgb, alpha = np.zeros((len(q), 3)), np.zeros(len(q))
    for x, y, weight in ((0, 0, (1-fraction[:, 0])*(1-fraction[:, 1])),
                         (1, 0, fraction[:, 0]*(1-fraction[:, 1])),
                         (0, 1, (1-fraction[:, 0])*fraction[:, 1]),
                         (1, 1, fraction[:, 0]*fraction[:, 1])):
        ix, iy = (high if x else low)[:, 0], (high if y else low)[:, 1]
        rgb += material["rgb"][iy, ix]*weight[:, None]
        alpha += material["alpha"][iy, ix]*weight
    return rgb, alpha


def triangle_area(rows):
    return .5*np.linalg.norm(np.cross(rows[:, 1, :3]-rows[:, 0, :3], rows[:, 2, :3]-rows[:, 0, :3]), axis=1)


def quadrature(rows, material, edge_metres, stats, max_patches):
    """Yield native surface centroids and area weights; refine MASK boundaries.

    Each subdivision partitions one source triangle into four equal-area
    triangles. UV, colour and position are barycentrically interpolated. A
    source-alpha rectangle supplies conservative transparent/opaque bounds.
    Remaining mixed-mask patch area bounds MASK integration uncertainty.
    """
    pending = [rows.astype(np.float64)];pyramid = alpha_pyramid(material["alpha"])
    while pending:
        patch = pending.pop();stats["evaluatedPatches"] += len(patch)
        require(stats["evaluatedPatches"] <= max_patches, "Adaptive quadrature patch budget exceeded; no thinning")
        areas = triangle_area(patch)
        require(np.isfinite(areas).all(), "Nonfinite native triangle area")
        positive = areas > 0
        stats["zeroAreaPatches"] += int(np.count_nonzero(~positive))
        patch, areas = patch[positive], areas[positive]
        if not len(patch):
            continue
        edges = np.linalg.norm(patch[:, [1, 2, 0], :3]-patch[:, :, :3], axis=2).max(axis=1)
        lower, upper = mask_bounds(patch[:, :, 8:10], pyramid)
        cutoff = material["cutoff"]
        transparent = upper < cutoff
        stats["provedTransparentAreaSquareMetres"] += float(areas[transparent].sum())
        patch, areas, edges, lower = patch[~transparent], areas[~transparent], edges[~transparent], lower[~transparent]
        if not len(patch):
            continue
        uncertain = lower < cutoff
        split = (edges > edge_metres) | (uncertain & (edges > edge_metres*.25))
        if np.any(split):
            a, b, c = (patch[split, i] for i in range(3));ab, bc, ca = (a+b)*.5, (b+c)*.5, (c+a)*.5
            # Bound temporary batches; never materialize a whole mature canopy.
            for child in (np.stack((a, ab, ca), axis=1), np.stack((ab, b, bc), axis=1),
                          np.stack((ca, bc, c), axis=1), np.stack((ab, bc, ca), axis=1)):
                for first in range(0, len(child), CHUNK_TRIANGLES):
                    pending.append(child[first:first+CHUNK_TRIANGLES])
        terminal = ~split
        if not np.any(terminal):
            continue
        patch, areas, uncertain = patch[terminal], areas[terminal], uncertain[terminal]
        point = patch.mean(axis=1);rgb, alpha = bilinear_native(material, point[:, 8:10])
        accepted = alpha >= cutoff
        stats["terminalPatches"] += len(patch)
        stats["unresolvedMaskAreaSquareMetres"] += float(areas[uncertain].sum())
        stats["acceptedAreaSquareMetres"] += float(areas[accepted].sum())
        stats["acceptedSamples"] += int(np.count_nonzero(accepted))
        if not np.any(accepted):
            continue
        points, weights = point[accepted, :3], areas[accepted]
        pigment = rgb[accepted]*point[accepted, 10:13]
        require(np.isfinite(pigment).all() and np.all((pigment >= 0) & (pigment <= 1)), "Invalid native sampled pigment")
        stats["acceptedLinearRGBTimesArea"] += np.sum(pigment*weights[:, None], axis=0)
        radius = np.linalg.norm(patch[accepted, :, :3]-points[:, None, :], axis=2).max()
        stats["maximumQuadraturePatchRadiusMetres"] = max(stats["maximumQuadraturePatchRadiusMetres"], float(radius))
        yield points, weights, pigment


def kernel_weights(cell_metres, sigma_metres, truncate):
    radius = int(truncate*sigma_metres/cell_metres+.5)
    require(1 <= radius <= 64, "Kernel support outside explicit budget")
    x = np.arange(-radius, radius+1, dtype=np.float64)*cell_metres
    kernel = np.exp(-.5*(x/sigma_metres)**2);kernel /= kernel.sum()
    return kernel, radius


def deposit(fields, origin, cell_metres, points, area, rgb):
    q = (points-origin)/cell_metres;low = np.floor(q).astype(np.int64);fraction = q-low
    require(np.all(low >= 0) and np.all(low+1 < np.asarray(fields.shape[:3])), "Quadrature escaped padded native field")
    moments = np.column_stack((area, rgb*area[:, None]))/(cell_metres**3)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                weight = np.prod(np.where([dx, dy, dz], fraction, 1-fraction), axis=1)
                key = (low[:, 0]+dx, low[:, 1]+dy, low[:, 2]+dz)
                np.add.at(fields, key, moments*weight[:, None])


def build_field(prototype, vertices, indices, materials, *, cell_metres=.25,
                quadrature_edge_metres=.15, sigma_metres=.35, truncate=3.,
                max_voxels=MAX_VOXELS, max_patches=MAX_PATCHES):
    ranges, low, high = validate_geometry(prototype, vertices, indices, materials)
    kernel, radius = kernel_weights(cell_metres, sigma_metres, truncate)
    # One trilinear-deposit halo, the complete finite Gaussian, then an empty
    # guard layer: convolution loses no accepted area outside this grid.
    padding = radius+3
    origin = (np.floor(low/cell_metres)-padding)*cell_metres
    shape = np.ceil((high-origin)/cell_metres).astype(np.int64)+padding+1
    require(np.all(shape >= 3) and math.prod(map(int, shape)) <= max_voxels, "Native field voxel budget exceeded; no crop")
    fields = np.zeros((*map(int, shape), 4), dtype=np.float64)
    stats = {"sourceTriangleAreaSquareMetres": 0., "provedTransparentAreaSquareMetres": 0.,
             "unresolvedMaskAreaSquareMetres": 0., "acceptedAreaSquareMetres": 0.,
             "acceptedLinearRGBTimesArea": np.zeros(3), "evaluatedPatches": 0,
             "terminalPatches": 0, "acceptedSamples": 0, "zeroAreaPatches": 0,
             "maximumQuadraturePatchRadiusMetres": 0.}
    own = range_indices(prototype, "leaf", indices)
    for first in range(0, len(own), CHUNK_TRIANGLES):
        rows = vertices[own[first:first+CHUNK_TRIANGLES]].astype(np.float64)
        stats["sourceTriangleAreaSquareMetres"] += float(triangle_area(rows).sum())
        for slot in np.unique(rows[:, 0, 13].astype(int)):
            for points, area, rgb in quadrature(rows[rows[:, 0, 13] == slot], materials[slot], quadrature_edge_metres, stats, max_patches):
                deposit(fields, origin, cell_metres, points, area, rgb)
    require(stats["acceptedAreaSquareMetres"] > 0, "Native MASK produced no area; refusing an empty substitute")
    for axis in range(3):
        convolve1d(fields, kernel, axis=axis, output=fields, mode="constant", cval=0.)
    require(np.isfinite(fields).all() and np.all(fields >= 0), "Invalid native field convolution")
    density = fields[:, :, :, 0].astype("<f4")
    colour = fields[:, :, :, 1:4].astype("<f4")
    area_out = float(np.sum(density, dtype=np.float64)*cell_metres**3)
    colour_out = np.sum(colour, axis=(0, 1, 2), dtype=np.float64)*cell_metres**3
    require(abs(area_out-stats["acceptedAreaSquareMetres"]) <= max(1e-8, stats["acceptedAreaSquareMetres"]*1e-6), "Leaf area lost during field deposition/filtering")
    require(np.all(np.abs(colour_out-stats["acceptedLinearRGBTimesArea"]) <= np.maximum(1e-8, stats["acceptedLinearRGBTimesArea"]*1e-6)), "Linear native pigment moment lost")
    report = {**stats, "acceptedLinearRGBTimesArea": stats["acceptedLinearRGBTimesArea"].tolist(),
              "storedAreaSquareMetres": area_out, "storedLinearRGBTimesArea": colour_out.tolist(),
              "maskAreaIntervalSquareMetres": [max(0., stats["acceptedAreaSquareMetres"]-stats["unresolvedMaskAreaSquareMetres"]),
                                               stats["acceptedAreaSquareMetres"]+stats["unresolvedMaskAreaSquareMetres"]],
              "sourceRanges": ranges, "nativeLeafBounds": {"low": low.tolist(), "high": high.tolist()},
              "originXYZ": origin.tolist(), "shapeXYZ": list(map(int, shape)), "voxelCount": int(np.prod(shape)),
              "fieldSupport": {"kernel": "Normalized separable discrete Gaussian; BOX truncation, not radial truncation",
                  "sigmaMetres": sigma_metres, "truncate": truncate, "radiusVoxelsPerAxis": radius,
                  "radiusMetresPerAxis": radius*cell_metres, "maximumEuclideanKernelSupportMetres": math.sqrt(3)*radius*cell_metres,
                  "trilinearDepositMaximumMetres": math.sqrt(3)*cell_metres,
                  "maximumNonzeroCentreDistanceFromAcceptedNativeSampleMetres": math.sqrt(3)*(radius+1)*cell_metres,
                  "oneDimensionalKernelFloat64LE": receipt(kernel.astype("<f8").tobytes()),
                  "oneDimensionalWeights": kernel.tolist(), "paddingVoxelsPerSide": padding},
              "recipe": {"maximumSupportMetres": math.sqrt(3)*(radius+2)*cell_metres+stats["maximumQuadraturePatchRadiusMetres"],
                  "scope": "Authored smoothing/sampling footprint: Gaussian corner + trilinear deposit + trilinear field interpolation + maximum accepted quadrature patch radius. Not an appearance or native silhouette certificate."},
              "appearanceErrorSupported": False, "surfaceDistanceErrorSupported": False}
    return origin.astype("<f8"), density, colour, report


def deterministic_npz(arrays):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as packed:
        for name, value in arrays.items():
            array = np.asarray(value)
            if not array.flags.c_contiguous:
                array = np.ascontiguousarray(array)
            payload = io.BytesIO();np.lib.format.write_array(payload, array, allow_pickle=False)
            info = zipfile.ZipInfo(name+".npy", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED;info.create_system = 3;info.external_attr = 0o100644 << 16
            packed.writestr(info, payload.getvalue(), compresslevel=6)
    return output.getvalue()


def prepare(pack, output, *, species=SPECIES, cell_metres=.25, quadrature_edge_metres=.15,
            sigma_metres=.35, truncate=3., max_voxels=MAX_VOXELS, max_patches=MAX_PATCHES):
    pack, output = Path(pack).resolve(), Path(output).absolute()
    require(not output.exists(), "Fresh output required")
    require(output.parent.is_dir(), "Output parent must exist")
    require(all(math.isfinite(v) for v in (cell_metres, quadrature_edge_metres, sigma_metres, truncate))
            and .05 <= cell_metres <= 1 and .01 <= quadrature_edge_metres <= .5
            and cell_metres*.25 <= sigma_metres <= 2 and 1 <= truncate <= 6, "Unsafe field parameters")
    require(type(max_voxels) is int and 1 <= max_voxels <= MAX_VOXELS
            and type(max_patches) is int and 1 <= max_patches <= MAX_PATCHES, "Unsafe explicit field budget")
    require(species and len(set(species)) == len(species) and all(name in SPECIES for name in species), "Unknown/duplicate source species")
    manifest_raw = (pack/"manifest.json").read_bytes()
    require(len(manifest_raw) <= 4*1024*1024, "Oversized source manifest")
    manifest = finite_json(manifest_raw)
    require(manifest.get("format") == "waterworld.forest-instances" and manifest.get("version") == 2
            and manifest.get("vertexStride") == 56 and manifest.get("materialContract") == "gene-surfaces-v3"
            and manifest.get("upAxis") == "Y" and manifest.get("units") == "metres", "Expected original native v2 forest")
    files = manifest["files"];raw = {name: read_receipted(pack, name, files[name]) for name in ("vertices.bin", "indices.bin", "roots.bin")}
    require(len(raw["vertices.bin"]) % 56 == 0 and len(raw["indices.bin"]) % 4 == 0
            and len(raw["roots.bin"]) == manifest["rootCount"]*48, "Malformed original native streams")
    vertices, indices = np.frombuffer(raw["vertices.bin"], dtype="<f4").reshape(-1, 14), np.frombuffer(raw["indices.bin"], dtype="<u4")
    prototypes = manifest.get("prototypes")
    require(isinstance(prototypes, list) and len(prototypes) == 5
            and all(p.get("id") == i and p.get("species") == SPECIES[i] for i, p in enumerate(prototypes)), "Unknown native prototype registry")
    staging = Path(tempfile.mkdtemp(prefix=output.name+".staging-", dir=output.parent))
    records, source_files = [], {name: receipt(value) for name, value in raw.items()}
    try:
        for prototype in prototypes:
            if prototype["species"] not in species:
                continue
            materials, material_records = load_materials(pack, prototype, files)
            for material in material_records:
                for key in ("albedo", "normal", "roughnessMap"):
                    if key in material:
                        item = material[key];source_files[item["file"]] = {key: item[key] for key in ("bytes", "sha256")}
            origin, density, colour, report = build_field(prototype, vertices, indices, materials,
                cell_metres=cell_metres, quadrature_edge_metres=quadrature_edge_metres,
                sigma_metres=sigma_metres, truncate=truncate, max_voxels=max_voxels, max_patches=max_patches)
            name = f"prototype-{prototype['id']}-{prototype['species']}.npz"
            encoded = deterministic_npz({"originXYZ": origin, "cellMetres": np.asarray(cell_metres, dtype="<f8"),
                                         "density": density, "rgbMoment": colour})
            (staging/name).write_bytes(encoded)
            records.append({"id": prototype["id"], "species": prototype["species"], "file": name, **receipt(encoded),
                "field": {"file": name, **receipt(encoded)},
                "source": {"native": prototype.get("source", {}).get("native"), "ranges": report.pop("sourceRanges")},
                "nativeMaterials": material_records, "arrays": {
                    "originXYZ": {"dtype": "<f8", "shape": [3], **receipt(origin.tobytes())},
                    "cellMetres": {"dtype": "<f8", "shape": [], **receipt(np.asarray(cell_metres, dtype="<f8").tobytes())},
                    "density": {"dtype": "<f4", "shape": list(density.shape), **receipt(density.tobytes())},
                    "rgbMoment": {"dtype": "<f4", "shape": list(colour.shape), **receipt(colour.tobytes())}},
                **report})
            print(json.dumps({"species": prototype["species"], "voxelCount": report["voxelCount"],
                              "samples": report["acceptedSamples"], "bytes": len(encoded)}), flush=True)
        require(records, "No native prototype selected")
        method = Path(__file__).read_bytes()
        document = {"format": FORMAT, "version": 1, "complete": True, "units": "metres", "upAxis": "Y",
            "fieldUnits": {"density": "leaf square metres per cubic metre", "rgbMoment": "linear RGB times leaf square metres per cubic metre"},
            "coordinateContract": "Array axis order[x,y,z]; originXYZ is centre of voxel[0,0,0]. Uniform world scale s: inverse-transform sample coordinates, density/s, rgbMoment*rootLinearTint/s. Add overlapping continuous fields before later authored isosurface.",
            "source": {"manifest": receipt(manifest_raw), "files": source_files, "nativeSource": manifest.get("nativeSource"),
                       "method": {"file": "scripts/prepare-forest-fields.py", **receipt(method)},
                       "geometry": "Only original wood and leaf indexed ranges validated; only actual leaf triangle area deposited. No alternate membership, crown radius, fitted surface, growth or connected-component filtering."},
            "parameters": {"cellMetres": cell_metres, "quadratureEdgeMetres": quadrature_edge_metres,
                "maskBoundaryEdgeMetres": quadrature_edge_metres*.25, "sigmaMetres": sigma_metres,
                "truncate": truncate, "maxVoxelsPerPrototype": max_voxels, "maxPatchesPerPrototype": max_patches},
            "recipe": {"maximumSupportMetres": max(p["recipe"]["maximumSupportMetres"] for p in records),
                "scope": "Maximum recorded prototype sampling/smoothing footprint, not a native appearance certificate."},
            "quadrature": "Equal-area barycentric four-child triangle subdivision; conservative source alpha-pyramid bounds; refine geometric edges to budget and mixed MASK edges four times finer; bilinear original UV MASK and linearized source PNG at terminal centroid; unresolved mixed-patch area reported.",
            "pigment": "Original PNG sRGB decoded before bilinear filtering, multiplied by stored linear vertex RGB once. Leaf front pigment only; source underside/transmission preserved as material provenance, not mixed into a fake lighting bake.",
            "prototypes": records, "appearanceErrorSupported": False, "surfaceDistanceErrorSupported": False,
            "limitations": ["Density smoothing and any later isosurface threshold are authored render approximations, not native leaf silhouette certificates.",
                "Exact source tree geometry/maps are unchanged. Finite MASK quadrature has an explicit unresolved-area bound.",
                "No components removed, holes filled, stand generated, terrain clipped or runtime assets installed.",
                "Native wood is provenance-validated but is not counted as leaf area; separate wood geometry remains available.",
                "Held-out actual native stand silhouette/colour comparison is required before regional deployment."]}
        (staging/"manifest.json").write_text(json.dumps(document, indent=2, allow_nan=False)+"\n")
        # Recheck mutable source identities before making the fresh package visible.
        require((pack/"manifest.json").read_bytes() == manifest_raw, "Native source manifest changed during field bake")
        for name, item in source_files.items():
            read_receipted(pack, name, files[name], MAX_MAP_BYTES if name.endswith(".png") else MAX_STREAM_BYTES)
        require(not output.exists(), "Fresh output was occupied during field bake")
        staging.rename(output)
        return document
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--species", nargs="+", choices=SPECIES, default=list(SPECIES))
    parser.add_argument("--cell-metres", type=float, default=.25)
    parser.add_argument("--quadrature-edge-metres", type=float, default=.15)
    parser.add_argument("--sigma-metres", type=float, default=.35)
    parser.add_argument("--truncate", type=float, default=3.)
    parser.add_argument("--max-voxels", type=int, default=MAX_VOXELS)
    parser.add_argument("--max-patches", type=int, default=MAX_PATCHES)
    args = parser.parse_args()
    prepare(args.pack, args.output, species=tuple(args.species), cell_metres=args.cell_metres,
            quadrature_edge_metres=args.quadrature_edge_metres, sigma_metres=args.sigma_metres,
            truncate=args.truncate, max_voxels=args.max_voxels, max_patches=args.max_patches)


if __name__ == "__main__":
    main()
