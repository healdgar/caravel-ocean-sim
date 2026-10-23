# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Tiny independent native GLB/PNG fixtures; no growth or external bake needed."""
import copy
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("forest_native_import", ROOT/"scripts/prepare-forest-instances.py")
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


def receipt(raw, **extra):
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), **extra}


def pack_glb(document, binary):
    text = json.dumps(document, separators=(",", ":")).encode()
    text += b" "*(-len(text) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 28+len(text)+len(binary))
            + struct.pack("<II", len(text), 0x4E4F534A)+text
            + struct.pack("<II", len(binary), 0x004E4942)+binary)


def make_fixture(folder, species="oak"):
    folder.mkdir(parents=True, exist_ok=True)
    table, expected_maps = [], {}
    for index, name in enumerate(("bark", "wounds", "foliage_0")):
        prefix = f"leaf-{species}-0" if name == "foliage_0" else f"{species}-{name}"
        entry = {"name": name, "index": index, "colour": [1., 1., 1.], "roughness": .73,
                 "wrap": "repeat" if name == "bark" else "clamp", "clearcoat": .2 if name == "bark" else 0.,
                 "opacityThreshold": .35 if name == "foliage_0" else 0., "maps": {}}
        if name == "foliage_0":
            entry.update(underside=.31, transmission=.12, undersideReference=[.62, .70, .58])
        for kind in (("albedo", "normal", "roughness") if index < 2 else ("albedo", "normal")):
            # Nonuniform native bytes catch substitution, accidental gamma
            # conversion, resizing and normal/roughness channel confusion.
            if kind == "albedo":
                pixels = np.array([[[31, 73, 119, 255], [61, 89, 151, 64]],
                                   [[67, 131, 191, 240], [97, 173, 223, 0]]], dtype=np.uint8)
            elif kind == "normal":
                pixels = np.array([[[127, 128, 255], [113, 139, 252]],
                                   [[138, 120, 251], [127, 128, 255]]], dtype=np.uint8)
            else:
                pixels = np.array([[57, 93], [133, 197]], dtype=np.uint8)
            path = folder/f"{prefix}-{kind}.png"
            Image.fromarray(pixels).save(path)
            raw = path.read_bytes();expected_maps[path.name] = raw
            entry["maps"][kind] = receipt(raw, file=path.name, width=2, height=2,
                                           encoding="srgb" if kind == "albedo" else "linear")
        table.append(entry)
    # Two bark primitives distinguish shoot/roots and retain below-ground wood.
    points = [np.array(p, dtype="<f4") for p in (
        [[0, 0, 0], [.25, 0, 0], [0, 0, 2]],
        [[-.25, 0, -.3], [.25, 0, -.3], [0, 0, 0]],
        [[0, .05, .2], [.1, .05, .2], [0, .05, .3]],
        [[0, 0, 2], [1, 0, 2], [0, 0, 3]],
    )]
    uv = np.array([[.13, .21], [.81, .29], [.39, .93]], dtype="<f4")
    normal = np.tile(np.array([0, -1, 0], dtype="<f4"), (3, 1))
    binary, accessors, views, primitives = bytearray(), [], [], []

    def append(values, kind, component):
        raw = values.tobytes();offset = len(binary)
        binary.extend(raw);binary.extend(b"\x00"*(-len(binary) % 4))
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(raw)})
        accessors.append({"bufferView": len(views)-1, "componentType": component,
                          "count": len(values), "type": kind})
        return len(accessors)-1

    for material, vertices in zip((0, 0, 1, 2), points):
        # A nontrivial source index order must survive import and reindexing.
        attributes = {"POSITION": append(vertices, "VEC3", 5126),
                      "NORMAL": append(normal, "VEC3", 5126),
                      "TEXCOORD_0": append(uv, "VEC2", 5126)}
        primitives.append({"attributes": attributes,
                           "indices": append(np.array([2, 0, 1], dtype="<u2"), "SCALAR", 5123),
                           "material": material})
    images = [{"uri": filename} for filename in expected_maps]
    materials = [{"name": entry["name"], "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1]},
                  "extras": {"materialContract": "gene-surfaces-v3",
                             "nativeSurface": {k: v for k, v in entry.items() if k != "index"}}} for entry in table]
    image_ids = {image["uri"]: index for index, image in enumerate(images)}
    for material, entry in zip(materials, table):
        material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": image_ids[entry["maps"]["albedo"]["file"]]}
        material["normalTexture"] = {"index": image_ids[entry["maps"]["normal"]["file"]]}
    document = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
                "nodes": [{"mesh": 0, "rotation": [-math.sqrt(.5), 0, 0, math.sqrt(.5)]}],
                "meshes": [{"primitives": primitives}], "buffers": [{"byteLength": len(binary)}],
                "bufferViews": views, "accessors": accessors, "materials": materials,
                "images": images, "textures": [{"source": i} for i in range(len(images))]}
    raw = pack_glb(document, bytes(binary));path = folder/f"native_{species}.glb";path.write_bytes(raw)
    source = {"engine": "fixture-current-engine", "age": 24, "seed": 42, "resolution": 2., "variant": 0}
    record = {"species": species, "directory": species, "materialContract": "gene-surfaces-v3",
              "glb": receipt(raw, file=path.name), "source": source, "materialTable": table,
              "triangles": {"shoot": 1, "roots": 1, "wounds": 1, "foliage_0": 1}, "foliageAudit": []}
    index = {"format": "waterworld.native-prototypes", "version": 1, "quality": "hero",
             "age": 24, "seed": 42, "resolution": 2., "materialContract": "gene-surfaces-v3",
             "source": {"growthEngine": "fixture-current-engine"}, "prototypes": [record]}
    # Independent Z-up -> Y-up expression, including original source indexing.
    expected = [p[[2, 0, 1]][:, [0, 2, 1]]*np.array([1, 1, -1], dtype="<f4") for p in points]
    return record, index, expected, uv[[2, 0, 1]], expected_maps, document, bytes(binary)


def old_base(species="oak"):
    far = np.array([[0, 2, 0, 0, 0, 1, 4, .5, 0, 0, .12, .31, .17],
                    [1, 2, 0, 0, 0, 1, 4, .5, 1, 0, .12, .31, .17],
                    [0, 3, 0, 0, 0, 1, 4, .5, 0, 1, .12, .31, .17]], dtype="<f4")
    # Deliberately unrelated old near meshes must never enter native streams.
    wrong = far.copy();wrong[:, :3] += 1000
    return {"species": species, "source": {"file": f"prototype_{species}_waterworld_manifest.json"},
            "streams": {"wood": wrong.copy(), "leaf": wrong.copy(), "far": far.copy()}}


class ForestNativeImport(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.record, self.index, self.expected, self.uv, self.maps, self.document, self.binary = make_fixture(self.folder/"oak")

    def import_one(self, record=None):
        copied = {}
        actual = IMPORTER.native_prototype(old_base(), record or copy.deepcopy(self.record), self.index, self.folder/"oak", copied)
        return actual, copied

    def test_native_positions_normals_uv_indices_and_materials_survive(self):
        actual, copied = self.import_one()
        wood, leaf, far = (actual["streams"][name] for name in ("wood", "leaf", "far"))
        self.assertEqual((wood.shape, leaf.shape, far.shape), ((9, 14), (3, 14), (3, 14)))
        self.assertEqual(wood.dtype, np.dtype("<f4"));self.assertEqual(wood.strides[0], 56)
        np.testing.assert_allclose(wood[:, :3], np.concatenate(self.expected[:3]), atol=2e-7, rtol=0)
        np.testing.assert_allclose(leaf[:, :3], self.expected[3], atol=2e-7, rtol=0)
        np.testing.assert_allclose(wood[:, 3:6], np.tile([0, 0, 1], (9, 1)), atol=2e-7, rtol=0)
        np.testing.assert_array_equal(wood[:, 8:10], np.tile(self.uv, (3, 1)))
        np.testing.assert_array_equal(leaf[:, 8:10], self.uv)
        np.testing.assert_array_equal(wood[:, 13], [0]*6+[1]*3)
        np.testing.assert_array_equal(leaf[:, 13], [2]*3)
        np.testing.assert_array_equal(wood[:, 6], [3]*9)
        np.testing.assert_array_equal(leaf[:, 6], [4]*3)
        np.testing.assert_array_equal(wood[:, 10:13], np.ones((9, 3)))
        np.testing.assert_array_equal(far[:, :13], old_base()["streams"]["far"])
        np.testing.assert_array_equal(far[:, 13], [-1]*3)
        self.assertLess(float(wood[:, 1].min()), 0, "Source native roots must remain present")
        self.assertLess(float(wood[:, :3].max()), 10, "Old scenery near geometry must never substitute")
        self.assertEqual(copied, self.maps)

    def test_source_png_bytes_encodings_wrap_optics_and_hashes_are_exact(self):
        actual, copied = self.import_one()
        self.assertEqual([m["name"] for m in actual["nativeMaterials"]], ["bark", "wounds", "foliage_0"])
        for entry, source in zip(actual["nativeMaterials"], self.record["materialTable"]):
            self.assertEqual(entry["index"], source["index"])
            for key in ("roughness", "wrap", "clearcoat", "opacityThreshold"):
                self.assertEqual(entry[key], source[key])
            for kind, image in source["maps"].items():
                imported = entry["roughnessMap" if kind == "roughness" else kind]
                self.assertEqual(imported, image)
                self.assertEqual(copied[image["file"]], (self.folder/"oak"/image["file"]).read_bytes())
                self.assertEqual(receipt(copied[image["file"]])["sha256"], imported["sha256"])
            self.assertEqual(entry["underside"], source.get("underside", 0.))
            self.assertEqual(entry["transmission"], source.get("transmission", 0.))

    def test_tampered_png_is_rejected_instead_of_generic_fallback(self):
        path = self.folder/"oak"/"leaf-oak-0-albedo.png"
        path.write_bytes(path.read_bytes()+b"changed")
        with self.assertRaisesRegex(ValueError, "receipt mismatch"):
            self.import_one()

    def test_material_table_mismatch_is_rejected(self):
        record = copy.deepcopy(self.record);record["materialTable"][2]["roughness"] = .1
        with self.assertRaisesRegex(ValueError, "material differs"):
            self.import_one(record)

    def test_triangle_loss_is_rejected(self):
        record = copy.deepcopy(self.record);record["triangles"]["foliage_0"] = 2
        with self.assertRaisesRegex(ValueError, "triangle receipts"):
            self.import_one(record)

    def test_unreceipted_external_texture_is_rejected(self):
        document = copy.deepcopy(self.document);document["images"][0]["uri"] = "generic-foliage.png"
        raw = pack_glb(document, self.binary)
        path = self.folder/"oak"/"native_oak.glb";path.write_bytes(raw)
        record = copy.deepcopy(self.record);record["glb"] = receipt(raw, file=path.name)
        with self.assertRaisesRegex(ValueError, "Unreceipted"):
            self.import_one(record)

    def test_receipted_but_wrong_species_map_binding_is_rejected(self):
        document = copy.deepcopy(self.document)
        document["materials"][2]["normalTexture"] = document["materials"][0]["normalTexture"]
        raw = pack_glb(document, self.binary)
        path = self.folder/"oak"/"native_oak.glb";path.write_bytes(raw)
        record = copy.deepcopy(self.record);record["glb"] = receipt(raw, file=path.name)
        with self.assertRaisesRegex(ValueError, "texture differs"):
            self.import_one(record)

    def test_v2_full_pack_covers_old_patch_and_retains_indexed_native_geometry(self):
        region = self.folder/"region";region.mkdir()
        height = np.full((3, 3), 400, dtype="<i2").tobytes();biome = bytes([255]*16)
        region_data = {"id": "fixture", "gridSize": 3, "spanMetres": 128., "localOrigin": {"x": 0., "z": 0.},
                       "heightSHA256": receipt(height)["sha256"], "vegetation": {"maskSize": 4, "sha256": receipt(biome)["sha256"]}}
        (region/"height.bin").write_bytes(height);(region/"biome.bin").write_bytes(biome)
        (region/"manifest.json").write_text(json.dumps(region_data))
        native, old = self.folder/"native", self.folder/"old";native.mkdir();old.mkdir()
        native_index = None;far_records = []
        for species in IMPORTER.SPECIES:
            record, index, *_ = make_fixture(native/species, species)
            if native_index is None:
                native_index = index;native_index["prototypes"] = []
            native_index["prototypes"].append(record)
            filename = f"prototype_{species}_waterworld_manifest.json";raw = b'{"far":"verified fixture"}'
            (old/filename).write_bytes(raw);far_records.append({"species": species, "manifest": filename, **receipt(raw)})
        (native/"prototypes.json").write_text(json.dumps(native_index))
        (old/"prototypes.json").write_text(json.dumps({"format": "waterworld.canopy-prototypes", "version": 1,
            "age": 24, "seed": 42, "resolution": 2., "source": native_index["source"], "prototypes": far_records}))
        legacy = self.folder/"assets/canopy-scenery/saba";legacy.mkdir(parents=True)
        (legacy/"manifest.json").write_text(json.dumps({"coverage": {"boundsXZ": [-40, 40, -40, 40]}}))
        output = self.folder/"pack"
        # Only the old far-source boundary is mocked. Real native GLBs/PNGs,
        # material import, triangular terrain, placement, indexing and receipts run.
        with mock.patch.object(IMPORTER, "ROOT", self.folder), mock.patch.object(IMPORTER, "prototype", side_effect=lambda path, species, region: old_base(species)), redirect_stdout(io.StringIO()):
            IMPORTER.prepare(old, region, output, native_dir=native)
        manifest = json.loads((output/"manifest.json").read_text())
        self.assertEqual((manifest["version"], manifest["vertexStride"], manifest["materialContract"]), (2, 56, "gene-surfaces-v3"))
        self.assertIsNone(manifest["placement"]["legacyStandExcluded"])
        self.assertEqual(manifest["placement"]["candidateSpacingMetres"], 3.)
        self.assertEqual(manifest["placement"]["minimumCrownSpacingFactor"], .32)
        self.assertEqual(manifest["placement"]["maximumRoots"], 250000)
        self.assertEqual(manifest["placement"]["densityPolicy"], "authored overlapping native crowns")
        roots = np.frombuffer((output/"roots.bin").read_bytes(), dtype="<f4").reshape(-1, 12)
        self.assertTrue(np.any((np.abs(roots[:, 0]) < 40) & (np.abs(roots[:, 2]) < 40)), "Native forest must fill the old patch")
        vertices = np.frombuffer((output/"vertices.bin").read_bytes(), dtype="<f4").reshape(-1, 14)
        indices = np.frombuffer((output/"indices.bin").read_bytes(), dtype="<u4")
        first = manifest["prototypes"][0]
        for name, positions in (("wood", np.concatenate(self.expected[:3])), ("leaf", self.expected[3])):
            draw = first[name];rows = vertices[indices[draw["firstIndex"]:draw["firstIndex"]+draw["indexCount"]]]
            np.testing.assert_allclose(rows[:, :3], positions, atol=2e-7, rtol=0)
        for filename, item in manifest["files"].items():
            raw = (output/filename).read_bytes()
            self.assertEqual(len(raw), item["bytes"]);self.assertEqual(receipt(raw)["sha256"], item["sha256"])
        self.assertEqual((output/"leaf-oak-0-albedo.png").read_bytes(), self.maps["leaf-oak-0-albedo.png"])

    def test_mature_catalog_native_only_pack_keeps_each_reported_age_and_original_source(self):
        region = self.folder/"mature-region";region.mkdir()
        height = np.full((3, 3), 400, dtype="<i2").tobytes();biome = bytes([255]*16)
        (region/"height.bin").write_bytes(height);(region/"biome.bin").write_bytes(biome)
        (region/"manifest.json").write_text(json.dumps({"id": "mature-fixture", "gridSize": 3, "spanMetres": 128.,
            "localOrigin": {"x": 0., "z": 0.}, "heightSHA256": receipt(height)["sha256"],
            "vegetation": {"maskSize": 4, "sha256": receipt(biome)["sha256"]}}))
        native = self.folder/"mature-native";native.mkdir()
        ages = {"oak": 60, "maple": 50, "birch": 25, "elm": 65, "chestnut": 70}
        records, catalog_rows = [], []
        for species, age in ages.items():
            record, *_ = make_fixture(native/species, species)
            original = {"engine": "original-baked-engine", "age": age, "resolution": 1., "seed": 42}
            row = {"species": species, "age": age, "stage": "mature", "tier": "hero", "materialContract": "gene-surfaces-v3",
                   "file": f"{species}_mature{age}_hero.usdz", "bytes": 123, "sha256": "e"*64, "source": original}
            record.update(age=age, source={"kind": "catalog-usdz", "catalogEntry": row,
                          "asset": {"bytes": 123, "sha256": "e"*64}, "originalSource": original})
            far = np.column_stack((old_base(species)["streams"]["far"], np.full(3, -1))).astype("<f4").tobytes()
            (native/species/"native-far.bin").write_bytes(far)
            record["directFar"] = receipt(far, file="native-far.bin", strideFloats=14, upAxis="Y", triangles=1,
                generator="gardenplans.scenery._build_opaque_crown_dome", functionSHA256="f"*64, appearanceErrorSupported=False)
            records.append(record);catalog_rows.append(row)
        catalog = json.dumps({"models": catalog_rows}).encode();surface = b'{}'
        (native/"source-catalog.json").write_bytes(catalog);(native/"source-surface-catalog.json").write_bytes(surface)
        index = {"format": "waterworld.native-prototypes", "version": 1, "mode": "catalog-mature-usdz", "quality": "hero",
                 "materialContract": "gene-surfaces-v3", "source": {"kind": "catalog-usdz", "catalog": receipt(catalog),
                 "surfaceCatalog": receipt(surface)}, "prototypes": records}
        (native/"prototypes.json").write_text(json.dumps(index))
        output = self.folder/"mature-pack"
        with mock.patch.object(IMPORTER, "ROOT", self.folder), mock.patch.object(IMPORTER, "prototype", side_effect=AssertionError("No scenery near/far source permitted")), redirect_stdout(io.StringIO()):
            IMPORTER.prepare(None, region, output, native_dir=native)
        result = json.loads((output/"manifest.json").read_text())
        for prototype in result["prototypes"]:
            self.assertTrue(prototype["geometryErrorSupported"])
            self.assertEqual(prototype["geometryErrorMethod"], "symmetric-fixed-opposing-vertex-triangle-bound-v1")
            certificate = prototype["geometryErrorSource"]
            self.assertEqual(certificate["nativeGLB"], prototype["source"]["native"]["glb"])
            for key in ("file", "bytes", "sha256"):
                self.assertEqual(certificate["farAsset"][key], prototype["source"]["directFar"][key])
            for name in ("vertices.bin", "indices.bin"):
                for key in ("bytes", "sha256"):
                    self.assertEqual(certificate["packedStreams"][name][key], result["files"][name][key])
            for name in ("wood", "leaf", "far"):
                self.assertEqual(certificate["ranges"][name], prototype[name])
                self.assertEqual(certificate["measuredStreams"][name]["vertexCount"], prototype[name]["indexCount"])
        self.assertEqual(result["nativeSource"]["ages"], ages)
        self.assertNotIn("age", result["nativeSource"]);self.assertNotIn("growthEngine", result["nativeSource"]["source"])
        for prototype in result["prototypes"]:
            source = prototype["source"]["native"]["cohort"]
            self.assertEqual(source["catalogEntry"]["age"], ages[prototype["species"]])
            self.assertEqual(source["originalSource"]["engine"], "original-baked-engine")
            self.assertEqual(source["originalSource"], source["catalogEntry"]["source"])
        self.assertEqual((output/"source-catalog.json").read_bytes(), catalog)
        self.assertEqual((output/"source-surface-catalog.json").read_bytes(), surface)

    def test_mature_record_cannot_relabel_a_catalog_age(self):
        record = copy.deepcopy(self.record)
        row = {"species": "oak", "stage": "mature", "tier": "hero", "age": 60,
               "materialContract": "gene-surfaces-v3", "bytes": 1, "sha256": "a"*64, "source": {"engine": "old"}}
        record.update(age=24, source={"kind": "catalog-usdz", "catalogEntry": row,
                                    "originalSource": row["source"], "asset": {"bytes": 1, "sha256": "a"*64}})
        index = {"mode": "catalog-mature-usdz", "materialContract": "gene-surfaces-v3"}
        with self.assertRaisesRegex(ValueError, "Mature catalog identity"):
            IMPORTER.native_prototype(old_base(), record, index, self.folder/"oak", {})


if __name__ == "__main__":
    unittest.main()
