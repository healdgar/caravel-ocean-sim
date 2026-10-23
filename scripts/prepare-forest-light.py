#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Bake immutable own-canopy exposure for original native forest vertices.

This is an authored five-ray hemispherical transmittance approximation, not a
directional sun shadow or a neighboring-tree shadow. Original geometry, UVs,
materials and the verified continuous leaf-density cache remain unchanged.

Root executes explicitly:
  uv run --directory ../forestmodeler python /absolute/path/waterworld/scripts/prepare-forest-light.py \
    --pack /tmp/waterworld-mature-dense-forest-237 \
    --fields /tmp/waterworld-native-fields-260 --output /tmp/native-canopy-light

One byte addresses each original global vertex. Its storage length is padded
to four bytes; unused/coarse-only vertices and padding remain255. A GPU may
read packed u32 words and unpack the byte using the unchanged vertex index.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import math
from pathlib import Path
import re
import shutil
import tempfile
import zipfile
import hashlib

import numpy as np
from scipy.ndimage import map_coordinates

FORMAT = "waterworld.native-canopy-light"
SPECIES = ("oak", "maple", "birch", "elm", "chestnut")
MAX_STREAM_BYTES = 256*1024*1024
MAX_FIELD_BYTES = 192*1024*1024
MAX_FIELD_VOXELS = 8_000_000
MAX_LIGHT_VOXELS = 20_000_000
VERTEX_BATCH = 65536
EXTINCTION = .5
EXPOSURE_CLAMP = (.18, 1.)
RAYS = ((1, 1, .4), (0, 1, .15), (0, -1, .15), (2, 1, .15), (2, -1, .15))


def require(ok, message):
    if not ok:
        raise ValueError(message)


def receipt(raw):
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def parse_json(raw):
    def reject(value):
        raise ValueError("Nonfinite JSON: "+value)
    return json.loads(raw, parse_constant=reject)


def safe_name(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value), "Unsafe source name")
    return value


def checked_receipt(raw, item, name):
    require(isinstance(item, dict) and type(item.get("bytes")) is int and item["bytes"] >= 0
            and isinstance(item.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]), "Invalid source receipt: "+name)
    require(receipt(raw) == {key: item[key] for key in ("bytes", "sha256")}, "Source receipt mismatch: "+name)


def read_verified(folder, name, item, maximum=MAX_STREAM_BYTES):
    safe_name(name)
    require(type(item.get("bytes")) is int and 0 < item["bytes"] <= maximum, "Oversized/empty source: "+name)
    path = folder/name
    if path.is_file():
        require(path.stat().st_size <= maximum, "Oversized source file: "+name)
        raw = path.read_bytes()
    else:
        transport = item.get("gzip", {});encoded_name = safe_name(transport.get("file"))
        path = folder/encoded_name
        require(path.stat().st_size <= maximum, "Oversized compressed source: "+name)
        encoded = path.read_bytes();checked_receipt(encoded, transport, encoded_name)
        with gzip.GzipFile(fileobj=io.BytesIO(encoded)) as stream:
            raw = stream.read(item["bytes"]+1)
            require(len(raw) == item["bytes"] and not stream.read(1), "Decoded source length differs: "+name)
    checked_receipt(raw, item, name)
    return raw


def read_fields(folder, native, native_manifest_receipt):
    manifest_raw = (folder/"manifest.json").read_bytes()
    require(len(manifest_raw) <= 4*1024*1024, "Oversized field manifest")
    manifest = parse_json(manifest_raw)
    require(manifest.get("format") == "waterworld.native-forest-fields" and manifest.get("version") == 1
            and manifest.get("complete") is True and manifest.get("upAxis") == "Y"
            and manifest.get("units") == "metres", "Expected complete native field cache")
    source = manifest.get("source", {})
    require(source.get("manifest") == native_manifest_receipt, "Field/native manifest differs")
    for name in ("vertices.bin", "indices.bin", "roots.bin"):
        require(all(source.get("files", {}).get(name, {}).get(k) == native["files"][name].get(k)
                    for k in ("bytes", "sha256")), "Field/native source differs: "+name)
    prototypes = manifest.get("prototypes")
    require(isinstance(prototypes, list) and len(prototypes) == len(native["prototypes"]), "Incomplete native light prototypes")
    result = []
    for ordinal, p in enumerate(prototypes):
        require(p.get("id") == ordinal and p.get("species") == native["prototypes"][ordinal]["species"], "Field prototype identity differs")
        field = p.get("field", {});name = safe_name(field.get("file"))
        encoded = read_verified(folder, name, field, MAX_FIELD_BYTES)
        with zipfile.ZipFile(io.BytesIO(encoded)) as archive:
            require(set(archive.namelist()) == {"originXYZ.npy", "cellMetres.npy", "density.npy", "rgbMoment.npy"}
                    and len(archive.infolist()) == 4 and sum(i.file_size for i in archive.infolist()) <= MAX_FIELD_BYTES,
                    "Unsafe native field archive")
        arrays = {}
        with np.load(io.BytesIO(encoded), allow_pickle=False) as packed:
            for key in ("originXYZ", "cellMetres", "density", "rgbMoment"):
                array = packed[key]
                require(array.dtype == np.dtype("<f8" if key in ("originXYZ", "cellMetres") else "<f4"), "Native field dtype differs")
                descriptor = p.get("arrays", {}).get(key, {})
                require(descriptor.get("shape") == list(array.shape) and descriptor.get("dtype") == array.dtype.str,
                        "Native field array layout differs")
                checked_receipt(array.tobytes(order="C"), descriptor, name+":"+key)
                require(np.isfinite(array).all(), "Nonfinite native field array")
                arrays[key] = array
        density, moment = arrays["density"], arrays["rgbMoment"]
        require(arrays["originXYZ"].shape == (3,) and arrays["cellMetres"].shape == ()
                and density.ndim == 3 and all(n >= 2 for n in density.shape)
                and density.size <= MAX_FIELD_VOXELS and moment.shape == (*density.shape, 3)
                and np.all(density >= 0) and np.all(moment >= 0), "Invalid native density field")
        cell = float(arrays["cellMetres"])
        require(.05 <= cell <= 1, "Unsafe native field spacing")
        density.flags.writeable = False
        result.append({"id": ordinal, "species": p["species"], "origin": arrays["originXYZ"],
                       "cell": cell, "density": density, "receipt": {"file": name, **receipt(encoded)}})
    return manifest, receipt(manifest_raw), result


def exposure_grid(density, cell_metres, extinction=EXTINCTION, clamp=EXPOSURE_CLAMP):
    """Mid-cell ray integrals over the supplied finite density domain.

    A cumulative sum includes the whole current cell. Subtract half of its
    density before multiplying by cell length: the ray begins at the vertex's
    cell centre, not the cell's rear face. Opposite horizontal rays have equal
    weights; the upward ray carries0.4. No downward soil ray is invented.
    """
    values = np.asarray(density)
    require(values.ndim == 3 and values.size <= MAX_LIGHT_VOXELS and np.isfinite(values).all()
            and np.all(values >= 0) and math.isfinite(cell_metres) and cell_metres > 0
            and math.isfinite(extinction) and extinction >= 0
            and 0 <= clamp[0] <= clamp[1] <= 1, "Invalid canopy transmittance input")
    exposure = np.zeros(values.shape, dtype=np.float64)
    for axis, direction, weight in RAYS:
        integrated = np.cumsum(np.flip(values, axis) if direction > 0 else values, axis=axis, dtype=np.float64)
        if direction > 0:
            integrated = np.flip(integrated, axis)
        integrated -= values*.5
        np.maximum(integrated, 0, out=integrated)
        integrated *= -extinction*cell_metres
        np.exp(integrated, out=integrated)
        exposure += weight*integrated
    np.clip(exposure, clamp[0], clamp[1], out=exposure)
    return exposure.astype("<f4")


def expand_density(density, origin, cell, positions, max_voxels=MAX_LIGHT_VOXELS):
    """Zero-pad to include wood probes below/outside the foliage grid.

    A below-canopy root must still see leaves overhead. Sampling a small light
    grid with an outside value of1 would incorrectly erase that occlusion.
    Only zero-density space is added; source values and coordinates are exact.
    """
    points = np.asarray(positions)
    require(points.ndim == 2 and points.shape[1] == 3 and len(points) and np.isfinite(points).all(), "Invalid native light probe positions")
    require(type(max_voxels) is int and 1 <= max_voxels <= MAX_LIGHT_VOXELS, "Unsafe light grid budget")
    lo = np.minimum(np.floor((points.min(axis=0)-origin)/cell).astype(np.int64)-1, 0)
    hi = np.maximum(np.ceil((points.max(axis=0)-origin)/cell).astype(np.int64)+1, np.asarray(density.shape)-1)
    shape = hi-lo+1
    require(math.prod(map(int, shape)) <= max_voxels, "Expanded native canopy light voxel budget exceeded")
    padded = np.zeros(tuple(map(int, shape)), dtype="<f4")
    start = -lo;target = tuple(slice(int(a), int(a+n)) for a, n in zip(start, density.shape))
    padded[target] = density
    return padded, np.asarray(origin, dtype=np.float64)+lo*cell


def native_membership(prototype, vertices, indices):
    records, members = {}, []
    for name in ("wood", "leaf"):
        r = prototype.get(name)
        require(isinstance(r, dict) and type(r.get("firstIndex")) is int and type(r.get("indexCount")) is int
                and r["firstIndex"] >= 0 and r["indexCount"] > 0 and r["indexCount"] % 3 == 0
                and r["firstIndex"]+r["indexCount"] <= len(indices), "Invalid native light membership")
        own = indices[r["firstIndex"]:r["firstIndex"]+r["indexCount"]]
        require(np.all(own < len(vertices)), "Native light index outside original vertices")
        for first in range(0, len(own), VERTEX_BATCH):
            rows = vertices[own[first:first+VERTEX_BATCH]]
            require(np.isfinite(rows).all() and (np.all(rows[:, 6] == 3) if name == "wood" else np.all(rows[:, 6] >= 4))
                    and np.all(rows[:, 13] >= 0), "Non-native source in canopy light membership")
        records[name] = {"firstIndex": r["firstIndex"], "indexCount": r["indexCount"], "indices": receipt(own.tobytes())}
        members.append(own)
    return np.unique(np.concatenate(members)), records


def gzip_bytes(raw):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, filename="", mode="wb", compresslevel=9, mtime=0) as packed:
        packed.write(raw)
    return output.getvalue()


def prepare(pack, fields_folder, output, *, max_light_voxels=MAX_LIGHT_VOXELS):
    pack, fields_folder, output = Path(pack).resolve(), Path(fields_folder).resolve(), Path(output).absolute()
    require(not output.exists() and output.parent.is_dir(), "Fresh output and existing parent required")
    require(type(max_light_voxels) is int and 1 <= max_light_voxels <= MAX_LIGHT_VOXELS, "Unsafe light voxel budget")
    native_raw = (pack/"manifest.json").read_bytes()
    require(len(native_raw) <= 4*1024*1024, "Oversized native manifest")
    native = parse_json(native_raw)
    require(native.get("format") == "waterworld.forest-instances" and native.get("version") == 2
            and native.get("vertexStride") == 56 and native.get("materialContract") == "gene-surfaces-v3"
            and native.get("units") == "metres" and native.get("upAxis") == "Y", "Expected original native forest v2")
    prototypes = native.get("prototypes")
    require(isinstance(prototypes, list) and len(prototypes) == 5
            and all(p.get("id") == i and p.get("species") == SPECIES[i] for i, p in enumerate(prototypes)), "Unknown native light registry")
    sources = {name: read_verified(pack, name, native["files"][name]) for name in ("vertices.bin", "indices.bin", "roots.bin")}
    require(len(sources["vertices.bin"]) % 56 == 0 and len(sources["indices.bin"]) % 4 == 0
            and len(sources["roots.bin"]) == native["rootCount"]*48, "Malformed original native streams")
    vertices = np.frombuffer(sources["vertices.bin"], dtype="<f4").reshape(-1, 14)
    indices = np.frombuffer(sources["indices.bin"], dtype="<u4")
    require(0 < len(vertices) <= 8_000_000, "Native light vertex budget exceeded")
    fm, field_receipt, fields = read_fields(fields_folder, native, receipt(native_raw))
    vertex_count = len(vertices);padded_count = (vertex_count+3)//4*4
    shade = np.full(padded_count, 255, dtype=np.uint8);assigned = np.zeros(vertex_count, dtype=bool)
    records = []
    for p, field in zip(prototypes, fields):
        ids, membership = native_membership(p, vertices, indices)
        require(not np.any(assigned[ids]), "Shared vertex has ambiguous native prototype exposure")
        positions = vertices[ids, :3]
        density, origin = expand_density(field["density"], field["origin"], field["cell"], positions, max_light_voxels)
        lighting = exposure_grid(density, field["cell"])
        minimum, maximum, total = 1., 0., 0.
        for first in range(0, len(ids), VERTEX_BATCH):
            own = ids[first:first+VERTEX_BATCH]
            coordinates = ((vertices[own, :3].astype(np.float64)-origin)/field["cell"]).T
            require(np.all(coordinates >= 0) and np.all(coordinates <= (np.asarray(lighting.shape)-1)[:, None]), "Native light probe escaped expanded grid")
            sampled = map_coordinates(lighting, coordinates, order=1, mode="constant", cval=1., prefilter=False)
            require(np.isfinite(sampled).all() and np.all(sampled >= EXPOSURE_CLAMP[0]-1e-7) and np.all(sampled <= 1+1e-7), "Invalid native canopy exposure")
            shade[own] = np.rint(np.clip(sampled, *EXPOSURE_CLAMP)*255).astype(np.uint8)
            minimum, maximum = min(minimum, float(sampled.min())), max(maximum, float(sampled.max()))
            total += float(np.sum(sampled, dtype=np.float64))
        assigned[ids] = True
        record = {"id": p["id"], "species": p["species"], "membership": membership,
            "sourceField": field["receipt"], "sampledVertexCount": len(ids),
            "expandedGrid": {"originXYZ": origin.tolist(), "shapeXYZ": list(lighting.shape), "cellMetres": field["cell"]},
            "exposure": {"minimum": minimum, "maximum": maximum, "mean": total/len(ids)}}
        records.append(record)
        print(json.dumps({"species": p["species"], "vertices": len(ids), **record["exposure"]}), flush=True)
    require(np.all(shade[vertex_count:] == 255) and np.all(shade[:vertex_count][~assigned] == 255), "Unused native light bytes changed")
    raw = shade.tobytes();encoded = gzip_bytes(raw);method_raw = Path(__file__).read_bytes()
    document = {"format": FORMAT, "version": 1, "complete": True, "vertexCount": vertex_count,
        "sampledVertexCount": int(np.count_nonzero(assigned)), "unusedVertexCount": int(np.count_nonzero(~assigned)),
        "paddingBytes": padded_count-vertex_count, "encoding": "One UNORM8 byte per unchanged global native vertex index; unused/coarse-only bytes and four-byte alignment padding255",
        "source": {"files": {name: receipt(value) for name, value in sources.items()},
            "nativeManifest": receipt(native_raw), "nativeFieldManifest": field_receipt,
            "nativeFieldRecipe": fm.get("recipe"), "nativeSource": fm.get("source", {}).get("nativeSource"),
            "method": {"file": "scripts/prepare-forest-light.py", **receipt(method_raw)}},
        "recipe": {"version": 1, "extinction": EXTINCTION,
            "extinctionMeaning": "Authored projected-leaf-area factor multiplying density(m2/m3) and path length(m)",
            "rays": [{"directionXYZ": [direction if k == axis else 0 for k in range(3)], "weight": weight}
                     for axis, direction, weight in RAYS],
            "localCellSubtractionFraction": .5, "clamp": list(EXPOSURE_CLAMP),
            "integration": "Five axis-aligned cumulative density integrals, subtract half the current cell, then exp(-extinction*integral); weighted transmittance average",
            "sampling": "Trilinear light grid at unchanged native local positions; zero-density expansion encloses original wood/leaf probes",
            "quantization": "Nearest UNORM8, ties-to-even; maximum quantization error0.5/255",
            "maxLightVoxelsPerPrototype": max_light_voxels},
        "prototypes": records,
        "qualification": {"renderedAccepted": False, "directionalSunShadow": False,
            "neighborShadow": False, "physicalCalibration": False,
            "scope": "Static authored own-canopy hemispherical occlusion only; source geometry/materials unchanged. Root owns rendered appearance acceptance."},
        "files": {"canopy-shade.bin": {**receipt(raw), "gzip": {"file": "canopy-shade.bin.gz", **receipt(encoded)}}}}
    staging = Path(tempfile.mkdtemp(prefix=output.name+".staging-", dir=output.parent))
    try:
        require((pack/"manifest.json").read_bytes() == native_raw
                and receipt((fields_folder/"manifest.json").read_bytes()) == field_receipt, "Native light source changed during bake")
        for name in sources:
            read_verified(pack, name, native["files"][name])
        for field in fields:
            read_verified(fields_folder, field["receipt"]["file"], field["receipt"], MAX_FIELD_BYTES)
        (staging/"canopy-shade.bin.gz").write_bytes(encoded)
        (staging/"canopy-shade.json").write_text(json.dumps(document, indent=2, allow_nan=False)+"\n")
        require(not output.exists(), "Fresh native light output was occupied")
        staging.rename(output)
        return document
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--fields", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-light-voxels", type=int, default=MAX_LIGHT_VOXELS)
    args = parser.parse_args()
    prepare(args.pack, args.fields, args.output, max_light_voxels=args.max_light_voxels)
