#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Import current grown native canopy packs into indexed prototypes and roots.

No growth, Blender, downloads or rendering. Run explicitly in Forestmodeler's
NumPy/SciPy environment. Temperate species are authored visual proxies, never a
survey of Saba's flora. Far crowns retain the source's opaque grown crown domes;
colour/alpha/silhouette error is NOT certified. With --native-dir, near trees
come from Forestmodeler's native_tree_render Hero pipeline and exact source
gene-surfaces-v3 maps. The scenery bundle supplies only same-cohort far domes.
Native format v2 uses14floats/56bytes with an explicit native material slot.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import math
from pathlib import Path
import shutil
import struct
import tempfile
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("forest_source_reader", ROOT/"scripts/prepare-canopy-scenery.py")
SOURCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOURCE)
SPECIES = ("oak", "maple", "birch", "elm", "chestnut")
FORMAT = "waterworld.forest-instances"
MAX_PACK_BYTES = 256*1024*1024


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


def native_glb_primitives(raw, assets):
    """Verify native texture transport, then reuse the existing geometry reader.

    Only JSON transport fields are removed from this temporary reader input;
    original BIN geometry/UV/index bytes and material splits remain unchanged.
    The original GLB and every PNG retain their own receipts.
    """
    SOURCE.require(len(raw) >= 20, "Truncated native GLB")
    magic, version, length = struct.unpack_from("<III", raw)
    SOURCE.require(magic == 0x46546C67 and version == 2 and length == len(raw), "Invalid native GLB header")
    size, kind = struct.unpack_from("<II", raw, 12)
    SOURCE.require(kind == 0x4E4F534A and size % 4 == 0 and 20+size <= len(raw), "Invalid native GLB JSON")
    document = SOURCE.finite_json(raw[20:20+size])
    SOURCE.require(not document.get("extensionsRequired") and set(document.get("extensionsUsed", [])) <= {"KHR_materials_clearcoat"}, "Unsupported native GLB extension")
    images = document.get("images", [])
    for image in images:
        SOURCE.require(set(image) == {"uri"} and SOURCE.basename(image["uri"]) in assets, "Unreceipted native GLB image")
    for texture in document.get("textures", []):
        SOURCE.require(isinstance(texture.get("source"), int) and 0 <= texture["source"] < len(images), "Invalid native image binding")
    def bound_image(slot):
        texture = slot.get("index") if isinstance(slot, dict) else None
        bindings = document.get("textures", [])
        SOURCE.require(isinstance(texture, int) and 0 <= texture < len(bindings), "Missing native material texture")
        return images[bindings[texture]["source"]]["uri"]
    for material in document.get("materials", []):
        surface = material.get("extras", {}).get("nativeSurface", {})
        maps = surface.get("maps", {})
        pbr = material.get("pbrMetallicRoughness", {})
        SOURCE.require(bound_image(pbr.get("baseColorTexture")) == maps.get("albedo", {}).get("file")
                       and bound_image(material.get("normalTexture")) == maps.get("normal", {}).get("file"), "Native GLB texture differs from its source map")
        if surface.get("gltfMetallicRoughness"):
            SOURCE.require(bound_image(pbr.get("metallicRoughnessTexture")) == surface["gltfMetallicRoughness"]["file"], "Native GLB roughness differs from its source map")
    document.pop("images", None);document.pop("textures", None)
    payload = json.dumps(document, separators=(",", ":")).encode()
    payload += b" "*(-len(payload) % 4)
    binary = raw[20+size:]
    temporary = struct.pack("<III", 0x46546C67, 2, 20+len(payload)+len(binary))+struct.pack("<II", len(payload), 0x4E4F534A)+payload+binary
    return SOURCE.glb_primitives(temporary)


def native_prototype(base, record, index, folder, texture_files):
    """Replace near geometry with current native Hero; keep explicit source far."""
    species = base["species"]
    source = record.get("source", {})
    SOURCE.require(record.get("species") == species and record.get("directory") == species
                   and record.get("materialContract") == index.get("materialContract") == "gene-surfaces-v3", "Invalid native species/material identity")
    SOURCE.require(source.get("engine") == index["source"]["growthEngine"] and source.get("age") == index["age"]
                   and source.get("resolution") == index["resolution"] and source.get("seed") == index["seed"]
                   and source.get("variant") == 0, "Native cohort identity mismatch")
    glb_record = record.get("glb", {});glb_name = SOURCE.basename(glb_record.get("file"))
    raw = SOURCE.read_receipted(folder, glb_name, {glb_name: glb_record})
    table = record.get("materialTable")
    SOURCE.require(isinstance(table, list) and table and [m.get("index") for m in table] == list(range(len(table))), "Invalid native material order")
    materials, material_names, owned_assets = [], {}, {}
    for entry in table:
        name, material_id = entry.get("name"), entry["index"]
        SOURCE.require(isinstance(name, str) and name not in material_names, "Duplicate native material")
        material_names[name] = material_id
        maps = entry.get("maps", {})
        SOURCE.require("albedo" in maps and "normal" in maps and set(maps) <= {"albedo", "normal", "roughness"}, "Native material lacks required source maps")
        material = {key: value for key, value in entry.items() if key not in ("maps", "gltfMetallicRoughness")}
        material.setdefault("underside", 0.0);material.setdefault("transmission", 0.0);material.setdefault("undersideReference", [0., 0., 0.])
        SOURCE.require(all(isinstance(material.get(key), (int, float)) and math.isfinite(material[key]) and 0 <= material[key] <= 1
                           for key in ("roughness", "underside", "transmission", "opacityThreshold"))
                       and SOURCE.point(material["undersideReference"]), "Invalid native optical metadata")
        for map_name, item in maps.items():
            filename = SOURCE.basename(item.get("file"))
            pixels = SOURCE.read_receipted(folder, filename, {filename: item})
            encoding = "srgb" if map_name == "albedo" else "linear"
            SOURCE.require(item.get("encoding") == encoding and len(pixels) >= 24
                           and pixels[:8] == b"\x89PNG\r\n\x1a\n" and pixels[12:16] == b"IHDR", "Invalid native map encoding")
            width, height = struct.unpack_from(">II", pixels, 16)
            SOURCE.require((width, height) == (item.get("width"), item.get("height")) and 0 < width <= 4096 and 0 < height <= 4096, "Native map dimensions mismatch")
            SOURCE.require(filename not in texture_files or texture_files[filename] == pixels, "Conflicting native map filenames")
            texture_files[filename] = pixels;owned_assets[filename] = SOURCE.receipt(pixels)
            material["roughnessMap" if map_name == "roughness" else map_name] = item
        packed = entry.get("gltfMetallicRoughness")
        if packed:
            name = SOURCE.basename(packed.get("file"))
            packed_raw = SOURCE.read_receipted(folder, name, {name: packed})
            owned_assets[name] = SOURCE.receipt(packed_raw)
        materials.append(material)
    SOURCE.require("bark" in material_names and "wounds" in material_names, "Missing native wood materials")
    leaves = sorted((name for name in material_names if name.startswith("foliage_")), key=lambda name: int(name.split("_")[-1]))
    SOURCE.require(leaves and leaves == [f"foliage_{i}" for i in range(len(leaves))], "Native leaf archetypes must be contiguous")
    primitives, node = native_glb_primitives(raw, owned_assets)
    wood, leaf, observed = [], [], {}
    for primitive in primitives:
        name = primitive["material"].get("name")
        SOURCE.require(name in material_names, "Unknown native primitive material")
        extras = primitive["material"].get("extras", {})
        expected_surface = {key: value for key, value in table[material_names[name]].items() if key != "index"}
        SOURCE.require(extras.get("materialContract") == "gene-surfaces-v3" and extras.get("nativeSurface") == expected_surface,
                       "Native primitive material differs from its source table")
        observed[name] = observed.get(name, 0)+len(primitive["positions"])//3
        is_leaf = name.startswith("foliage_")
        kind = 4+int(name.split("_")[-1]) if is_leaf else 3
        count = len(primitive["positions"])
        rows = np.column_stack((primitive["positions"], primitive["normals"], np.full(count, kind),
                                np.full(count, .44 if not is_leaf else .72), primitive["uv"],
                                np.broadcast_to(primitive["colour"], (count, 3)), np.full(count, material_names[name]))).astype("<f4")
        SOURCE.validate_triangles(rows, species+" native "+name)
        (leaf if is_leaf else wood).append(rows)
    expected = record.get("triangles", {})
    SOURCE.require(observed.get("bark", 0) == expected.get("shoot", 0)+expected.get("roots", 0)
                   and observed.get("wounds", 0) == expected.get("wounds", 0)
                   and all(observed.get(name, 0) == expected.get(name, 0) for name in leaves), "Native primitive triangle receipts disagree")
    SOURCE.require(wood and leaf, "Native prototype lacks wood or leaves")
    far = base["streams"]["far"]
    # These are the recorded coarse RGB domes, not bark/leaf-UV surfaces.
    # The renderer's explicit sentinel keeps them off native texture sampling.
    far = np.column_stack((far, np.full(len(far), -1))).astype("<f4")
    base["streams"] = {"wood": np.concatenate(wood), "leaf": np.concatenate(leaf), "far": far}
    base["nativeMaterials"] = materials
    base["source"]["native"] = {"glb": {"file": glb_name, **SOURCE.receipt(raw)}, "cohort": source,
                               "materialContract": index["materialContract"], "maps": owned_assets,
                               "nodeTransform": node, "foliageAudit": record.get("foliageAudit")}
    points = np.concatenate([rows[:, :3] for rows in base["streams"].values()]).astype(np.float64)
    low, high = points.min(axis=0), points.max(axis=0)
    wood, leaf = base["streams"]["wood"], base["streams"]["leaf"]
    basal = wood[(wood[:, 1] >= -.01) & (wood[:, 1] <= .12)]
    SOURCE.require(len(basal) > 0, "Native source has no collar wood")
    base.update(low=low.tolist(), high=high.tolist(), centre=((low+high)*.5).tolist(),
                radius=float(np.linalg.norm((high-low)*.5))+.00001,
                basalRadius=max(.06, float(np.linalg.norm(basal[:, [0, 2]], axis=1).max())),
                crownRadius=float(np.linalg.norm(leaf[:, [0, 2]], axis=1).max()))
    return base


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


def prepare(source_dir, region_dir, output, *, spacing=6., force=False, native_dir=None):
    source_dir, region_dir, output = source_dir.resolve(), region_dir.resolve(), output.resolve()
    if output.exists():
        SOURCE.require(force and (output/"manifest.json").is_file() and SOURCE.finite_json((output/"manifest.json").read_bytes()).get("format") == FORMAT, "Existing output requires --force and a matching forest format")
    region_raw = (region_dir/"manifest.json").read_bytes();region = SOURCE.finite_json(region_raw)
    identity = {k: region[k] for k in ("id", "gridSize", "spanMetres", "localOrigin")}
    sample, _, terrain_receipts = SOURCE.terrain_inputs(region_dir, {"region": identity})
    biome = (region_dir/SOURCE.basename(region.get("assets", {}).get("biome", "biome.bin"))).read_bytes()
    native_index, native_records, texture_files = None, {}, {}
    if native_dir is not None:
        native_dir = native_dir.resolve()
        native_raw = (native_dir/"prototypes.json").read_bytes();native_index = SOURCE.finite_json(native_raw)
        far_raw = (source_dir/"prototypes.json").read_bytes();far_index = SOURCE.finite_json(far_raw)
        SOURCE.require(native_index.get("format") == "waterworld.native-prototypes" and native_index.get("version") == 1
                       and native_index.get("quality") == "hero" and native_index.get("materialContract") == "gene-surfaces-v3", "Expected current native Hero prototype bundle")
        SOURCE.require(far_index.get("format") == "waterworld.canopy-prototypes" and far_index.get("version") == 1
                       and all(native_index.get(key) == far_index.get(key) for key in ("age", "seed", "resolution"))
                       and native_index["source"]["growthEngine"] == far_index["source"]["growthEngine"], "Native/far growth identities differ")
        native_records = {record["species"]: record for record in native_index["prototypes"]}
        SOURCE.require(set(native_records) == set(SPECIES) and len(native_index["prototypes"]) == len(SPECIES), "Native bundle species mismatch")
        far_records = {record["species"]: record for record in far_index["prototypes"]}
        SOURCE.require(set(far_records) == set(SPECIES), "Far source species mismatch")
        for species in SPECIES:
            record = far_records[species];filename = SOURCE.basename(record["manifest"])
            SOURCE.read_receipted(source_dir, filename, {filename: record})
            SOURCE.require(filename == f"prototype_{species}_waterworld_manifest.json", "Unexpected far prototype name")
    prototypes = []
    for species in SPECIES:
        p = prototype(source_dir/f"prototype_{species}_waterworld_manifest.json", species, region_dir)
        if native_index:
            p = native_prototype(p, native_records[species], native_index, native_dir/species, texture_files)
        p["id"] = len(prototypes);prototypes.append(p)
    exclude = None
    legacy = ROOT/"assets/canopy-scenery/saba/manifest.json"
    if native_index is None and legacy.is_file():exclude = SOURCE.finite_json(legacy.read_bytes())["coverage"]["boundsXZ"]
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
    SOURCE.require(sum(map(len, streams.values()))+sum(map(len, texture_files.values())) <= MAX_PACK_BYTES, "Forest assets exceed explicit256MiB asset budget")
    manifest = {"format": FORMAT, "version": 2 if native_index else 1, "units": "metres", "upAxis": "Y", "vertexStride": 56 if native_index else 52, "rootStride": 48,
                "rootAttributes": ["x", "collarY", "z", "scale", "yaw", "linearR", "linearG", "linearB", "prototype", "sinkMetres", "reserved", "reserved"],
                "rootCount": len(roots), "prototypes": prototypes, "coverage": coverage, "appearanceErrorSupported": False,
                "sourceClaim": "Current native grown oak/maple/birch/elm/chestnut cohorts are authored visual proxies, not surveyed tropical flora. Near alpha reuses the declared game foliage texture; native far crowns are approximate, not appearance-certified. Auto collapse requires whole support <=3pixels.",
                "placement": {"candidateSpacingMetres": spacing, "seed": 47231, "minimumBiomeByte": 96, "elevationMetres": [18, 840], "maximumSlope": 1.1, "minimumCrownSpacingFactor": .65,
                              "legacyStandExcluded": exclude, "terrainReceipts": terrain_receipts},
                "files": {n: SOURCE.receipt(raw, **{ {"vertices.bin": "vertexCount", "indices.bin": "indexCount", "roots.bin": "rootCount"}[n]: {"vertices.bin": vertex_count, "indices.bin": index_count, "roots.bin": len(roots)}[n]}) for n, raw in streams.items()}}
    if native_index:
        manifest.update(materialContract="gene-surfaces-v3", vertexAttributes=[*SOURCE.ATTRIBUTES, "nativeMaterial"],
                        sourceClaim="Current Forestmodeler native Hero wood/roots/wounds and native-size individual folded cutouts, with exact gene-surfaces-v3 materials. No scenery near-mesh simplification. Same-cohort native opaque far domes remain approximate, not appearance-certified; strict whole-support fallback only.",
                        nativeSource={"index": SOURCE.receipt(native_raw), "farIndex": SOURCE.receipt(far_raw),
                                      "source": native_index["source"], "quality": native_index["quality"],
                                      "age": native_index["age"], "resolution": native_index["resolution"]})
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix="forest-import-", dir=output.parent))
    try:
        for name, raw in streams.items():(temporary/name).write_bytes(raw)
        for name, raw in texture_files.items():
            (temporary/name).write_bytes(raw);manifest["files"][name] = SOURCE.receipt(raw)
        if native_index:
            for name, raw in (("source-native-index.json", native_raw), ("source-far-index.json", far_raw)):
                (temporary/name).write_bytes(raw);manifest["files"][name] = SOURCE.receipt(raw)
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
    parser.add_argument("--native-dir", type=Path, help="Current native Hero prototype bundle; source-dir supplies only verified same-cohort far domes")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    prepare(args.source_dir, args.region, args.output, spacing=args.spacing, force=args.force, native_dir=args.native_dir)
