#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Package original native foliage fields as immutable shaded 3D textures.

No growth, source geometry/material edits, resampling, isosurface fitting or
far-mass changes. RGBA stores linear RGB area moments followed by leaf density;
divide AFTER interpolation to obtain pigment. Exposure is the existing static
own-canopy five-ray approximation, not a directional or neighboring shadow.

Root executes explicitly:
  uv run --directory ../forestmodeler python /absolute/path/waterworld/scripts/prepare-forest-volume.py \
    --pack /tmp/waterworld-mature-dense-forest-237 \
    --fields /tmp/waterworld-native-fields-260 --output /tmp/native-volumes

Binary texels use WebGPU x-fastest order, then y, then z. Source NumPy arrays
use[x,y,z]; transport transposes to[z,y,x,channels] without moving any texel.
Only deterministic gzip files and manifest.json enter the fresh output folder.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import shutil
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("forest_volume_own_light", ROOT/"scripts/prepare-forest-light.py")
LIGHT = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(LIGHT)
FORMAT = "waterworld.native-forest-volume"
MAX_DIMENSION = 256
MAX_VOXELS = 8_000_000
EXTINCTION = .5


def require(ok, message):
    if not ok:
        raise ValueError(message)


def receipt(raw):
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def source_arrays(field_folder, prototype):
    item = prototype["field"]
    encoded = LIGHT.read_verified(field_folder, item["file"], item, LIGHT.MAX_FIELD_BYTES)
    # read_fields verifies archive names, array shapes/dtypes and all four raw
    # array receipts first. Recheck density/moment identity when loading them.
    with np.load(io.BytesIO(encoded), allow_pickle=False) as packed:
        density, moment = packed["density"], packed["rgbMoment"]
        origin = packed["originXYZ"].astype(np.float64);cell = float(packed["cellMetres"])
    for name, array in (("density", density), ("rgbMoment", moment)):
        LIGHT.checked_receipt(array.tobytes(order="C"), prototype["arrays"][name], item["file"]+":"+name)
    return origin, cell, density, moment


def validate_grid(density, moment, origin, cell_metres):
    require(isinstance(density, np.ndarray) and density.dtype == np.dtype("<f4")
            and density.ndim == 3 and all(2 <= n <= MAX_DIMENSION for n in density.shape)
            and density.size <= MAX_VOXELS, "Unsupported native volume dimensions/budget; no resampling")
    require(moment.dtype == np.dtype("<f4") and moment.shape == (*density.shape, 3)
            and np.asarray(origin).shape == (3,) and np.isfinite(origin).all()
            and math.isfinite(cell_metres) and .05 <= cell_metres <= 1, "Invalid native volume coordinate layout")
    require(np.isfinite(density).all() and np.isfinite(moment).all()
            and np.all(density >= 0) and np.all(moment >= 0), "Invalid native density/pigment moments")
    # Pigment is bounded by1; tolerate only source Float32 arithmetic rounding.
    require(np.all(moment <= density[..., None]*1.00001+1e-12), "Native RGB area moment exceeds density")
    for axis in range(3):
        for side in (0, -1):
            index = [slice(None)]*3;index[axis] = side;index = tuple(index)
            require(np.all(density[index] == 0) and np.all(moment[index] == 0), "Native volume lacks an outside zero-density border")


def pack_textures(density, moment, origin, cell_metres):
    """Retain moment/density pairing and native sample locations, quantized16F."""
    validate_grid(density, moment, origin, cell_metres)
    nx, ny, nz = density.shape
    rgba = np.empty((nz, ny, nx, 4), dtype="<f2")
    rgba[..., :3] = moment.transpose(2, 1, 0, 3)
    rgba[..., 3] = density.transpose(2, 1, 0)
    require(np.isfinite(rgba).all(), "Native foliage density exceeds RGBA16F range; no clamping")
    own_exposure = LIGHT.exposure_grid(density, cell_metres)
    exposure = np.rint(np.clip(own_exposure, .18, 1.)*255).astype(np.uint8).transpose(2, 1, 0).copy()
    low = np.asarray(origin, dtype=np.float64)-cell_metres*.5
    high = np.asarray(origin, dtype=np.float64)+(np.asarray(density.shape)-.5)*cell_metres
    clipped_low = low.copy();clipped_low[1] = max(0., float(clipped_low[1]))
    require(high[1] > clipped_low[1], "Native volume contains no biological above-ground interval")
    report = {"originXYZ": np.asarray(origin, dtype=np.float64).tolist(), "cellMetres": cell_metres,
              "dimensionsXYZ": list(density.shape), "textureLow": low.tolist(), "textureHigh": high.tolist(),
              "low": clipped_low.tolist(), "high": high.tolist(), "nativeGroundPlaneY": 0,
              "samplingFootprintMetres": math.sqrt(3)*cell_metres,
              "densityRange": [float(density.min()), float(density.max())],
              "exposureRange": [float(own_exposure.min()), float(own_exposure.max())]}
    return rgba.tobytes(order="C"), exposure.tobytes(order="C"), report


def write_transport(staging, name, raw):
    compressed = LIGHT.gzip_bytes(raw)
    path = staging/(name+".gz");path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(compressed)
    return {"file": name, **receipt(raw), "gzip": {"file": name+".gz", **receipt(compressed)}}


def prepare(pack, fields_folder, output):
    pack, fields_folder, output = Path(pack).resolve(), Path(fields_folder).resolve(), Path(output).absolute()
    require(not output.exists() and output.parent.is_dir(), "Fresh output and existing parent required")
    native_raw = (pack/"manifest.json").read_bytes()
    require(len(native_raw) <= 4*1024*1024, "Oversized native volume manifest")
    native = LIGHT.parse_json(native_raw)
    require(native.get("format") == "waterworld.forest-instances" and native.get("version") == 2
            and native.get("vertexStride") == 56 and native.get("materialContract") == "gene-surfaces-v3"
            and native.get("units") == "metres" and native.get("upAxis") == "Y", "Expected original native source forest")
    prototypes = native.get("prototypes")
    require(isinstance(prototypes, list) and len(prototypes) == 5
            and all(p.get("id") == i and p.get("species") == LIGHT.SPECIES[i] for i, p in enumerate(prototypes)), "Unknown native volume prototype registry")
    original = {}
    for name in ("vertices.bin", "indices.bin", "roots.bin"):
        raw = LIGHT.read_verified(pack, name, native["files"][name]);original[name] = receipt(raw)
        stride = {"vertices.bin": 56, "indices.bin": 4, "roots.bin": 48}[name]
        require(len(raw) % stride == 0 and (name != "roots.bin" or len(raw) == native["rootCount"]*48), "Malformed original native stream")
    fm, field_manifest_receipt, _ = LIGHT.read_fields(fields_folder, native, receipt(native_raw))
    staging = Path(tempfile.mkdtemp(prefix=output.name+".staging-", dir=output.parent))
    records, files = [], {}
    method_raw = Path(__file__).read_bytes();light_method_raw = (ROOT/"scripts/prepare-forest-light.py").read_bytes()
    try:
        for p in fm["prototypes"]:
            origin, cell, density, moment = source_arrays(fields_folder, p)
            field_raw, exposure_raw, bounds = pack_textures(density, moment, origin, cell)
            prefix = f"prototype-{p['id']}-{p['species']}"
            field = write_transport(staging, prefix+"/field.rgba16f.bin", field_raw)
            exposure = write_transport(staging, prefix+"/exposure.r8.bin", exposure_raw)
            for item in (field, exposure):
                files[item["file"]] = {key: value for key, value in item.items() if key != "file"}
            records.append({"id": p["id"], "species": p["species"], **bounds,
                            "sourceField": p["field"], "field": field, "exposure": exposure,
                            "sourceArrays": p["arrays"], "nativeMaterials": p.get("nativeMaterials"),
                            "appearanceErrorSupported": False})
            print(json.dumps({"species": p["species"], "dimensionsXYZ": bounds["dimensionsXYZ"],
                              "fieldBytes": len(field_raw), "exposureBytes": len(exposure_raw)}), flush=True)
        document = {"format": FORMAT, "version": 1, "complete": True, "units": "metres", "upAxis": "Y",
            "source": {"files": original, "nativeManifest": receipt(native_raw),
                "nativeFieldManifest": field_manifest_receipt, "nativeFieldRecipe": fm.get("recipe"),
                "nativeSource": fm.get("source", {}).get("nativeSource"),
                "method": {"file": "scripts/prepare-forest-volume.py", **receipt(method_raw)},
                "exposureMethod": {"file": "scripts/prepare-forest-light.py", **receipt(light_method_raw)}},
            "recipe": {"version": 1, "nativeGroundPlaneY": 0, "extinction": EXTINCTION,
                "fieldChannels": ["linearRGBMomentR", "linearRGBMomentG", "linearRGBMomentB", "leafAreaDensity"],
                "fieldEncoding": "Little-endian RGBA16F, linear source moments and density; divide moment by density AFTER interpolation. No colour averaging before interpolation.",
                "textureOrder": "x fastest, then y, then z; NumPy source[x,y,z,channel] transposed to[z,y,x,channel]",
                "textureCoordinates": "originXYZ is centre of texel[0,0,0]; uvw=(local-originXYZ+0.5*cellMetres)/(dimensionsXYZ*cellMetres)",
                "densityUnits": "Leaf square metres per cubic metre",
                "rootScale": "For uniform scale s, world density=local density/s; world ray step=s*local step. Native root RGB tint multiplies reconstructed pigment once.",
                "exposure": {"encoding": "R8 UNORM; nearest, ties-to-even", "extinction": LIGHT.EXTINCTION,
                    "rays": [{"directionXYZ": [direction if k == axis else 0 for k in range(3)], "weight": weight}
                             for axis, direction, weight in LIGHT.RAYS],
                    "localCellSubtractionFraction": .5, "clamp": list(LIGHT.EXPOSURE_CLAMP),
                    "scope": "Static own-canopy hemisphere escape: weighted exp(-0.5*integrated density), not directional or neighboring-tree shadow"},
                "biologicalClipping": "Texture coordinates and density remain unchanged. Draw bounds and shader reject localY<0; source ground plane is not a green cap.",
                "maximumTexture3DDimension": MAX_DIMENSION, "maximumVoxelsPerPrototype": MAX_VOXELS,
                "samplingFootprintScope": "sqrt(3)*cellMetres is an authored voxel interpolation footprint, not a native foliage appearance certificate"},
            "prototypes": records, "files": files, "appearanceErrorSupported": False,
            "qualification": {"renderedAccepted": False, "physicalCalibration": False,
                "scope": "Immutable source-derived foliage textures only; no source geometry/material or far-mass edits, no growth. Root owns rendering and appearance acceptance."},
            "limitations": ["RGBA16F quantizes source Float32 density/moments. Pairing preserves interpolated ratio semantics, not bit-exact pigment values.",
                "Cached smoothing and finite source MASK quadrature retain their original uncertainty and source receipts.",
                "Extinction and five-ray own-canopy exposure are authored approximations. Leaf underside, transmission and detailed self-shadowing are not fully reproduced.",
                "Foliage only: original/reduced native wood must remain a separate draw. No fitted trunk or coarse crown geometry is emitted.",
                "Native stand comparisons and GPU/device performance checks remain required before release."]}
        require((pack/"manifest.json").read_bytes() == native_raw
                and receipt((fields_folder/"manifest.json").read_bytes()) == field_manifest_receipt,
                "Native volume source changed during packaging")
        require((ROOT/"scripts/prepare-forest-light.py").read_bytes() == light_method_raw
                and Path(__file__).read_bytes() == method_raw, "Volume recipe changed during packaging")
        for name in original:
            LIGHT.read_verified(pack, name, native["files"][name])
        for p in fm["prototypes"]:
            LIGHT.read_verified(fields_folder, p["field"]["file"], p["field"], LIGHT.MAX_FIELD_BYTES)
        (staging/"manifest.json").write_text(json.dumps(document, indent=2, allow_nan=False)+"\n")
        require(not output.exists(), "Fresh native volume output was occupied")
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
    args = parser.parse_args()
    prepare(args.pack, args.fields, args.output)
