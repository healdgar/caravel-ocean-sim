#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Import two finished Forestmodeler specimens, never grow or render plants.

Run explicitly with Python/Pillow. Copies exact leafy atlas pixels: no resize,
filtering, colour correction or interpolation of the two-byte depth channel.
The source receipts and original manifests accompany the compact runtime data.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

from PIL import Image


SPECIMENS = ("oak-101-20", "birch-101-20")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def prepare(source, output, force=False):
    library = read_json(source / "library.json")
    if library.get("format") != "castle.woodland" or library.get("version") != 1:
        raise ValueError("Expected the finished Castle and Commons woodland library")
    if (output / "library.json").exists() and not force:
        raise ValueError("Output already exists; use --force to deliberately refresh it")
    rows = {row["id"]: row for row in library["plants"]}
    prepared = []
    for specimen in SPECIMENS:
        row = rows[specimen]
        folder = source / specimen
        manifest = read_json(folder / "manifest.json")
        if manifest.get("upAxis") != "Y" or manifest.get("units") != "metres" or manifest.get("rootsIncluded"):
            raise ValueError("Expected metre-scale, Y-up source with a ground pivot and no roots")
        if manifest["sourceFingerprint"] != row["sourceFingerprint"]:
            raise ValueError("Source fingerprint does not match the imported library")
        atlas = manifest["impostor"]
        if atlas["colourSpace"] != "sRGB" or atlas["normalSpace"] != "object-y-up" or atlas["imageOrigin"] != "top-left":
            raise ValueError("Unsupported atlas encoding")
        tile, padding = int(atlas["tileSize"]), int(atlas["padding"])
        stride = tile + 2 * padding
        if len(atlas["tiles"]) != 48 or atlas["size"] != [8 * stride, 8 * stride]:
            raise ValueError("Expected the complete padded 8 azimuth / 3 elevation / 2 season bank")
        for index, view in enumerate(atlas["tiles"]):
            expected = [(index % 8) * stride + padding, (index // 8) * stride + padding, tile, tile]
            if view["rect"] != expected or view["season"] != ("leafy" if index < 24 else "dormant"):
                raise ValueError("Unexpected tile rectangle or season")
            if abs(view["azimuth"] - (index % 8) * math.pi / 4) > 1e-8 or abs(view["elevation"] - ((index // 8) % 3) * math.radians(35)) > 1e-8:
                raise ValueError("Unexpected source view direction")
        names = ["colour.png", "normal.png", "depth.png", "woodland-near.json", "woodland-middle.json"]
        receipts = {}
        for name in names:
            raw = (folder / name).read_bytes()
            receipt = manifest["files"][name]
            if len(raw) != receipt["bytes"] or digest(raw) != receipt["sha256"]:
                raise ValueError(f"Source receipt mismatch: {specimen}/{name}")
            receipts[name] = receipt
        meshes = []
        for name in names[3:]:
            native = read_json(folder / name)
            wood = native["wood"]
            if len(wood["positions"]) != len(wood["normals"]) or len(wood["positions"]) != len(wood["uvs"]) or len(wood["indices"]) % 3:
                raise ValueError("Invalid native wood attribute lengths")
            if not all(math.isfinite(v) for attr in ("positions", "normals", "uvs") for point in wood[attr] for v in point):
                raise ValueError("Nonfinite native wood")
            if not all(isinstance(i, int) and 0 <= i < len(wood["positions"]) for i in wood["indices"]):
                raise ValueError("Invalid native wood index")
            meshes.append({**wood, "triangles": len(wood["indices"]) // 3,
                           "sourceWoodDisplacement": float(native.get("woodVertexDisplacement", 0))})
        prepared.append((row, manifest, atlas, meshes, receipts, folder))
    tile = prepared[0][2]["tileSize"]
    padding = prepared[0][2]["padding"]
    if any(a["tileSize"] != tile or a["padding"] != padding for _, _, a, *_ in prepared):
        raise ValueError("The two banks must use the same pixel grid")
    bank_width, bank_height = 8 * (tile + 2 * padding), 3 * (tile + 2 * padding)
    width, height = len(prepared) * bank_width, bank_height
    memory = width * height * 4 * 3
    if memory > 18 * 1024 * 1024:
        raise ValueError("Leafy-only atlas exceeds the explicit 18 MiB memory bound")
    output.mkdir(parents=True, exist_ok=True)
    for channel in ("colour", "normal", "depth"):
        packed = Image.new("RGBA", (width, height))
        for index, (_, _, atlas, _, _, folder) in enumerate(prepared):
            with Image.open(folder / f"{channel}.png") as image:
                if list(image.size) != atlas["size"] or image.mode != "RGBA":
                    raise ValueError("Expected exact RGBA source pixels")
                packed.paste(image.crop((0, 0, bank_width, bank_height)), (index * bank_width, 0))
        packed.save(output / f"{channel}.png")
    plants = []
    for index, (row, manifest, atlas, meshes, receipts, folder) in enumerate(prepared):
        specimen = row["id"]
        (output / f"{specimen}-source.json").write_bytes((folder / "manifest.json").read_bytes())
        wood_names = []
        for tier, mesh in zip(("near", "middle"), meshes):
            name = f"{specimen}-wood-{tier}.json"
            (output / name).write_text(json.dumps(mesh, separators=(",", ":")) + "\n")
            wood_names.append(name)
        bounds = atlas["bounds"]
        source_height = float(bounds[1][1])
        horizontal_radius = max(abs(float(bounds[edge][axis])) for edge in (0, 1) for axis in (0, 2))
        if source_height <= 0 or horizontal_radius <= 0:
            raise ValueError("Invalid source scale bounds")
        plants.append({"id": specimen, "species": manifest["species"], "seed": manifest["seed"],
                       "age": manifest["age"], "sourceFingerprint": manifest["sourceFingerprint"],
                       "sourceReceipts": receipts, "sourceManifest": f"{specimen}-source.json",
                       "bounds": bounds, "centre": atlas["centre"], "radius": atlas["radius"],
                       "sourceHeight": source_height, "horizontalRadius": horizontal_radius,
                       "woodColourSRGB": manifest["materials"]["wood"]["colour"],
                       "wood": wood_names,
                       "woodDisplacement": [m["sourceWoodDisplacement"] for m in meshes],
                       "origin": [index * bank_width, 0], "tileSize": tile, "padding": padding})
    result = {"format": "waterworld.woodland", "version": 1, "source": library["source"],
              "sourceCommit": library["sourceCommit"], "units": "metres", "upAxis": "Y",
              "rootsIncluded": False, "seasons": ["leafy"], "azimuths": 8,
              "elevationsDegrees": [0, 35, 70], "atlas": {"width": width, "height": height,
              "colour": "colour.png", "normal": "normal.png", "depth": "depth.png",
              "colourSpace": "sRGB", "normalSpace": "object-y-up",
              "depthEncoding": "(R*256+G)/65535; near=0, far=1", "imageOrigin": "top-left",
              "uncompressedBytes": memory}, "plants": plants,
              "limits": ["North American source taxa; no Caribbean species or coverage survey claim.",
                         "One front depth per baked view; hidden surfaces and all viewing angles are not recovered.",
                         "The three-pixel runtime ceiling bounds atlas texel footprint, not complete surface error.",
                         "Source wood reduction displacement is not a full-plant geometry error bound.",
                         "Individual overlapping crowns are not a coherent stand-volume compiler."],
              "processing": "Exact leafy 8x3 tile/padding crop and side-by-side packing; no resampling; native wood only."}
    result["files"] = {}
    for name in ["colour.png", "normal.png", "depth.png"] + [name for p in plants for name in p["wood"]]:
        raw = (output / name).read_bytes()
        result["files"][name] = {"bytes": len(raw), "sha256": digest(raw)}
    (output / "library.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"Prepared {len(plants)} source-matched leafy crowns; {width}x{height}; {memory} RGBA texture bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("../furlong-kingdom-annals/assets/woodland"))
    parser.add_argument("--out", type=Path, default=Path("assets/woodland"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    prepare(args.source.resolve(), args.out.resolve(), args.force)
