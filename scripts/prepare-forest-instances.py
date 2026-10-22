#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Import current grown native canopy packs into indexed prototypes and roots.

No growth, Blender, downloads or rendering. Run explicitly in Forestmodeler's
NumPy/SciPy environment. Temperate species are authored visual proxies, never a
survey of Saba's flora. Far crowns retain the source's opaque grown crown domes;
colour/alpha/silhouette error is NOT certified. Source prototypes come from the
Forestmodeler bake_waterworld_prototypes.py wrapper, one cohort per pack.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import math
from pathlib import Path
import shutil
import tempfile
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("forest_source_reader", ROOT/"scripts/prepare-canopy-scenery.py")
SOURCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOURCE)
SPECIES = ("oak", "maple", "birch", "elm", "chestnut")
FORMAT = "waterworld.forest-instances"
MAX_PACK_BYTES = 32*1024*1024


def localise_stream(rows, root, yaw):
    """Undo authored Z-up yaw after node conversion (x,y,z)->(x,z,-y)."""
    out = rows.astype(np.float64).copy()
    out[:, :3] -= np.asarray(root)
    c, s = math.cos(yaw), math.sin(yaw)
    for first, last in ((0, 2), (3, 5)):
        x, z = out[:, first].copy(), out[:, last].copy()
        out[:, first], out[:, last] = c*x-s*z, s*x+c*z
    return out.astype("<f4")


def prototype(path, species, region_dir):
    raw = path.read_bytes();source = SOURCE.finite_json(raw)
    SOURCE.require(source.get("format") == "waterworld.canopy-scenery" and source.get("version") == 1 and source.get("stemsCount") == 1 and source.get("species") == [species], "Expected one current native cohort per species")
    stem_name = path.name.removesuffix("_waterworld_manifest.json")
    names = {key: f"{stem_name}_{suffix}" for key, suffix in (("far", "canopy_opaque.bin"), ("leaf", "canopy_cutout.bin"), ("instances", "instances.bin"), ("glb", "canopy.glb"))}
    files = {key: SOURCE.read_receipted(path.parent, name, source["files"]) for key, name in names.items()}
    far = SOURCE.native_stream(files["far"], 10);leaf = SOURCE.native_stream(files["leaf"], 10);instances = SOURCE.native_stream(files["instances"], 8)
    sample, _, terrain_receipts = SOURCE.terrain_inputs(region_dir, source)
    stems, _, _ = SOURCE.validate_stems(source, instances, sample)
    primitives, node = SOURCE.glb_primitives(files["glb"])
    streams, _ = SOURCE.import_geometry(source, far, leaf, instances, primitives, sample=sample)
    stem = stems[0]
    root = [stem["x"], stem["z_ground"]-stem["collar_sink_m"], stem["z_ww"]]
    streams = {("wood" if name == "near" else name): localise_stream(rows, root, stem["yaw_rad"]) for name, rows in streams.items()}
    for name, rows in streams.items():SOURCE.validate_triangles(rows, species+" "+name)
    wood, leaf, far = streams["wood"], streams["leaf"], streams["far"]
    basal = wood[wood[:, 1] <= float(wood[:, 1].min())+.12]
    basal_radius = max(.06, float(np.linalg.norm(basal[:, [0, 2]], axis=1).max()))
    all_points = np.concatenate((wood[:, :3], leaf[:, :3], far[:, :3])).astype(np.float64)
    low, high = all_points.min(axis=0), all_points.max(axis=0)
    centre = (low+high)*.5
    return {"species": species, "low": low.tolist(), "high": high.tolist(), "centre": centre.tolist(),
            "radius": float(np.linalg.norm((high-low)*.5))+.00001, "basalRadius": basal_radius,
            "crownRadius": float(np.linalg.norm(leaf[:, [0, 2]], axis=1).max()),
            "source": {"file": path.name, **SOURCE.receipt(raw), "files": {names[key]: SOURCE.receipt(value) for key, value in files.items()},
                       "nodeTransform": node, "stem": stem, "terrainReceipts": terrain_receipts}, "streams": streams}


def hash32(value):
    value &= 0xffffffff
    value = ((value ^ (value >> 16))*0x7feb352d) & 0xffffffff
    value = ((value ^ (value >> 15))*0x846ca68b) & 0xffffffff
    return (value ^ (value >> 16)) & 0xffffffff


def place_roots(region, sample, biome, prototypes, *, spacing=6.0, seed=47231, exclude=None, max_roots=100000):
    SOURCE.require(2 <= spacing <= 32 and prototypes and 0 < max_roots <= 250000, "Invalid forest placement limits")
    span, origin = float(region["spanMetres"]), region["localOrigin"]
    x0, z0 = origin["x"]-span/2, origin["z"]-span/2
    mask_size = int(region["vegetation"]["maskSize"])
    mask = np.frombuffer(biome, dtype=np.uint8).reshape(mask_size, mask_size)
    cells, roots, neighbours = set(), [], {}
    occupancy_size = math.ceil(span/64)
    max_radius = max(p["crownRadius"] for p in prototypes)*1.35
    grid = max(4., max_radius*2)
    def probability(x, z):
        u, v = (x-x0)/span, (z-z0)/span
        if not (0 <= u < 1 and 0 <= v < 1):return 0
        return int(mask[min(mask_size-1, int(v*mask_size)), min(mask_size-1, int(u*mask_size))])
    def excluded(x, z):
        if not exclude:return False
        a, b, c, d = exclude
        return a <= x <= b and c <= z <= d
    for j in range(math.ceil(span/spacing)):
        for i in range(math.ceil(span/spacing)):
            key = hash32(seed ^ (i*73856093) ^ (j*19349663))
            x = x0+(i+.5+(key/2**32-.5)*.6)*spacing
            z = z0+(j+.5+(hash32(key)/2**32-.5)*.6)*spacing
            if probability(x, z) < 96 or excluded(x, z):continue
            if not (x0+spacing < x < x0+span-spacing and z0+spacing < z < z0+span-spacing):continue
            h, sx, sz = sample(x, z)
            if not (18 <= h <= 840) or math.hypot(sx, sz) > 1.10:continue
            p = prototypes[hash32(key+1) % len(prototypes)]
            scale = .9+hash32(key+2)/2**32*.45
            radius = p["crownRadius"]*scale
            # Preserve actual coastal/bare-ground gaps across the crown's rim.
            good = True
            for dx, dz in ((radius, 0), (-radius, 0), (0, radius), (0, -radius)):
                if probability(x+dx, z+dz) < 48 or sample(x+dx, z+dz)[0] < 5:good = False;break
            if not good:continue
            gx, gz = math.floor(x/grid), math.floor(z/grid)
            nearby = [r for a in range(gx-1, gx+2) for b in range(gz-1, gz+2) for r in neighbours.get((a, b), ())]
            if any(math.hypot(x-r[0], z-r[2]) < .65*(radius+r[-1]) for r in nearby):continue
            sink = p["basalRadius"]*scale*math.hypot(sx, sz)+.08
            yaw = hash32(key+3)/2**32*math.tau
            tint = .92+hash32(key+4)/2**32*.16
            row = [x, h-sink, z, scale, yaw, tint, tint, tint, p["id"], sink, 0, 0]
            roots.append(row);neighbours.setdefault((gx, gz), []).append([x, h, z, radius])
            cells.add(math.floor((z-z0)/64)*occupancy_size+math.floor((x-x0)/64))
            SOURCE.require(len(roots) <= max_roots, "Forest root limit exceeded; change spacing explicitly")
    SOURCE.require(roots, "No eligible forest roots")
    roots.sort(key=lambda r:(int(r[8]), r[2], r[0]))
    return np.asarray(roots, dtype="<f4"), {"kind": "occupied-cells", "originXZ": [x0, z0], "cellMetres": 64,
                                           "dimensions": [occupancy_size, occupancy_size], "cells": sorted(cells)}


def prepare(source_dir, region_dir, output, *, spacing=6., force=False):
    source_dir, region_dir, output = source_dir.resolve(), region_dir.resolve(), output.resolve()
    if output.exists():
        SOURCE.require(force and (output/"manifest.json").is_file() and SOURCE.finite_json((output/"manifest.json").read_bytes()).get("format") == FORMAT, "Existing output requires --force and a matching forest format")
    region_raw = (region_dir/"manifest.json").read_bytes();region = SOURCE.finite_json(region_raw)
    identity = {k: region[k] for k in ("id", "gridSize", "spanMetres", "localOrigin")}
    sample, _, terrain_receipts = SOURCE.terrain_inputs(region_dir, {"region": identity})
    biome = (region_dir/SOURCE.basename(region.get("assets", {}).get("biome", "biome.bin"))).read_bytes()
    prototypes = []
    for species in SPECIES:
        p = prototype(source_dir/f"prototype_{species}_waterworld_manifest.json", species, region_dir);p["id"] = len(prototypes);prototypes.append(p)
    exclude = None
    legacy = ROOT/"assets/canopy-scenery/saba/manifest.json"
    if legacy.is_file():exclude = SOURCE.finite_json(legacy.read_bytes())["coverage"]["boundsXZ"]
    roots, coverage = place_roots(region, sample, biome, prototypes, spacing=spacing, exclude=exclude)
    vertices, indices, vertex_count, index_count = [], [], 0, 0
    for p in prototypes:
        own = np.flatnonzero(roots[:, 8] == p["id"])
        p["firstRoot"], p["rootCount"] = (int(own[0]) if len(own) else sum(q.get("rootCount", 0) for q in prototypes[:p["id"]])), len(own)
        for name, rows in p.pop("streams").items():
            unique, inverse = np.unique(rows, axis=0, return_inverse=True)
            p[name] = {"firstIndex": index_count, "indexCount": len(inverse)}
            vertices.append(unique.astype("<f4"));indices.append((inverse+vertex_count).astype("<u4"))
            vertex_count += len(unique);index_count += len(inverse)
    streams = {"vertices.bin": np.concatenate(vertices).tobytes(), "indices.bin": np.concatenate(indices).tobytes(), "roots.bin": roots.tobytes()}
    SOURCE.require(sum(map(len, streams.values())) <= MAX_PACK_BYTES, "Forest streams exceed explicit32MiB asset budget")
    manifest = {"format": FORMAT, "version": 1, "units": "metres", "upAxis": "Y", "vertexStride": 52, "rootStride": 48,
                "rootAttributes": ["x", "collarY", "z", "scale", "yaw", "linearR", "linearG", "linearB", "prototype", "sinkMetres", "reserved", "reserved"],
                "rootCount": len(roots), "prototypes": prototypes, "coverage": coverage, "appearanceErrorSupported": False,
                "sourceClaim": "Current native grown oak/maple/birch/elm/chestnut cohorts are authored visual proxies, not surveyed tropical flora. Near alpha reuses the declared game foliage texture; native far crowns are approximate, not appearance-certified. Auto collapse requires whole support <=3pixels.",
                "placement": {"candidateSpacingMetres": spacing, "seed": 47231, "minimumBiomeByte": 96, "elevationMetres": [18, 840], "maximumSlope": 1.1, "minimumCrownSpacingFactor": .65,
                              "legacyStandExcluded": exclude, "terrainReceipts": terrain_receipts},
                "files": {n: SOURCE.receipt(raw, **{ {"vertices.bin": "vertexCount", "indices.bin": "indexCount", "roots.bin": "rootCount"}[n]: {"vertices.bin": vertex_count, "indices.bin": index_count, "roots.bin": len(roots)}[n]}) for n, raw in streams.items()}}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix="forest-import-", dir=output.parent))
    try:
        for name, raw in streams.items():(temporary/name).write_bytes(raw)
        (temporary/"manifest.json").write_text(json.dumps(manifest, indent=2)+"\n")
        if output.exists():shutil.rmtree(output)
        temporary.rename(output)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True);raise
    print(json.dumps({"output": str(output), "roots": len(roots), "species": list(SPECIES), "prototypeCount": len(prototypes), "bytes": sum(map(len, streams.values())), "appearanceErrorSupported": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True, help="Folder containing prototype_SPECIES_waterworld_manifest.json native packs")
    parser.add_argument("--region", type=Path, default=ROOT/"assets/world/saba")
    parser.add_argument("--output", type=Path, default=ROOT/"assets/forest-scenery/saba")
    parser.add_argument("--spacing", type=float, default=6.)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    prepare(args.source_dir, args.region, args.output, spacing=args.spacing, force=args.force)
