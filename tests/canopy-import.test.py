# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Independent importer qualification. Root runs with NumPy/SciPy available.

Synthetic bytes exercise the real importer without growing trees, invoking
Blender, reading an external bake, or treating its generating revision as known.
"""
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

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("canopy_import_under_test", ROOT / "scripts/prepare-canopy-scenery.py")
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def vertex_triangle(points, kind=4, shade=.37, uv=((0, 0), (1, 0), (0, 1))):
    points = np.asarray(points, dtype=np.float64)
    normal = np.cross(points[1]-points[0], points[2]-points[0])
    normal /= np.linalg.norm(normal)
    return np.array([[*p, *normal, kind, shade, *q] for p, q in zip(points, uv)], dtype="<f4")


def make_glb(local_bark, local_leaf, translation):
    """One genuinely indexed glTF mesh with nonuniform scale and X rotation."""
    views, accessors, blob, primitives = [], [], bytearray(), []

    def append(values, component, kind):
        start = len(blob)
        raw = values.tobytes()
        blob.extend(raw)
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": start, "byteLength": len(raw)})
        accessors.append({"bufferView": len(views)-1, "componentType": component, "count": len(values), "type": kind})
        return len(accessors)-1

    for material, points in enumerate((local_bark, local_leaf)):
        native = np.concatenate([vertex_triangle(points[i:i+3]) for i in range(0, len(points), 3)])
        if material == 0:
            # Genuine shoot-mesh root-cap convention, not an invented central
            # trunk requirement: centre UV(.5,minV), normal against root axis.
            native[:3, 8:10] = [[.5, 0], [0, 0], [1, 0]]
        attributes = {name: append(native[:, indices].copy(), 5126, kind) for name, indices, kind in
                      (("POSITION", slice(0, 3), "VEC3"), ("NORMAL", slice(3, 6), "VEC3"), ("TEXCOORD_0", slice(8, 10), "VEC2"))}
        indices = append(np.arange(len(native), dtype="<u2"), 5123, "SCALAR")
        primitives.append({"attributes": attributes, "indices": indices, "material": material, "mode": 4})
    scene = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
             "nodes": [{"mesh": 0, "translation": translation, "rotation": [-math.sqrt(.5), 0, 0, math.sqrt(.5)], "scale": [2, 3, 1]}],
             "meshes": [{"primitives": primitives}], "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accessors,
             "materials": [{"name": "fixture_bark", "pbrMetallicRoughness": {"baseColorFactor": [.18, .07, .035, 1]}},
                           {"name": "fixture_foliage", "pbrMetallicRoughness": {"baseColorFactor": [.05, .30, .09, 1]}}]}
    raw = json.dumps(scene, separators=(",", ":")).encode()
    raw += b" " * (-len(raw) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 12+8+len(raw)+8+len(blob))
            + struct.pack("<II", len(raw), 0x4E4F534A)+raw+struct.pack("<II", len(blob), 0x004E4942)+blob)


def source_opaque(x, ground, z):
    """Six-sided trunk plus independently constructed closed octagonal crown."""
    top, bottom, radius = ground+4, ground-.15, .20
    low = [[x+radius*math.cos(i*math.tau/6), bottom, z+radius*math.sin(i*math.tau/6)] for i in range(6)]
    high = [[p[0], top, p[2]] for p in low]
    triangles = []
    for i in range(6):
        j = (i+1) % 6
        triangles.extend((vertex_triangle([low[i], high[i], low[j]], 3), vertex_triangle([low[j], high[i], high[j]], 3)))
    base, height = ground+2.5, 6
    lower = [[x+2*math.cos(i*math.tau/8), base+height*.26, z+2*math.sin(i*math.tau/8)] for i in range(8)]
    upper = [[x+1.4*math.cos(i*math.tau/8), base+height*.74, z+1.4*math.sin(i*math.tau/8)] for i in range(8)]
    for i in range(8):
        j = (i+1) % 8
        triangles.extend((vertex_triangle([[x, base, z], lower[j], lower[i]]), vertex_triangle([lower[i], lower[j], upper[i]]),
                          vertex_triangle([lower[j], upper[j], upper[i]]), vertex_triangle([upper[i], upper[j], [x, base+height, z]])))
    return np.concatenate(triangles).astype("<f4")


class CanopyImport(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.region = self.folder / "region"
        self.region.mkdir()
        self.output = self.folder / "imported"
        self.manifest_path = self.folder / "fixture_waterworld_manifest.json"
        x, z, ground = 16, 16, 23
        sink = .20*math.hypot(.125, .0625)+.04
        self.local_bark = np.array([[0, 0, -sink], [.1, 0, -sink], [0, -.1, -sink], [0, 0, 0], [.5, 0, 1], [0, .5, 1]], dtype="<f4")
        self.local_leaf = np.array([[0, 0, 3], [.4, 0, 3], [0, .4, 3]], dtype="<f4")
        # Independent closed form of Ry-up <- source Z-up, including scale.
        self.world = lambda p: np.array([x+2*p[0], ground+p[2], z-3*p[1]], dtype="<f4")
        leaf_local = vertex_triangle(self.local_leaf)
        leaf = leaf_local.copy()
        leaf[:, :3] = np.array([self.world(p) for p in self.local_leaf])
        leaf[:, 3:6] = [0, 1, 0]
        self.raw = {"fixture_canopy_opaque.bin": source_opaque(x, ground, z).tobytes(), "fixture_canopy_cutout.bin": leaf.tobytes(),
                    "fixture_instances.bin": np.array([x, ground, z, 2, 6, .5, .125, .0625], dtype="<f4").tobytes(),
                    "fixture_canopy.glb": make_glb(self.local_bark, self.local_leaf, [x, ground, z])}
        heights = np.array([[20+X*.125+Z*.0625 for X in [-64, 0, 64]] for Z in [-64, 0, 64]])
        height_raw, biome_raw = (heights*4).astype("<i2").tobytes(), bytes([255]*4)
        (self.region / "height.bin").write_bytes(height_raw)
        (self.region / "biome.bin").write_bytes(biome_raw)
        region = {"id": "fixture", "gridSize": 3, "spanMetres": 128, "localOrigin": {"x": 0, "z": 0},
                  "heightSHA256": sha(height_raw), "vegetation": {"maskSize": 2, "sha256": sha(biome_raw)}}
        self.region_raw = (json.dumps(region, indent=1)+"\n").encode()
        (self.region / "manifest.json").write_bytes(self.region_raw)
        self.source = {"format": "waterworld.canopy-scenery", "version": 1, "units": "metres", "upAxis": "Y",
                       "vertexLayout": {"strideFloats": 10, "strideBytes": 40, "attributes": ["x", "y", "z", "nx", "ny", "nz", "kind", "shade", "u", "v"]},
                       "instanceLayout": {"strideFloats": 8, "strideBytes": 32, "attributes": ["x", "h", "z", "radius", "height", "shape", "sx", "sz"]},
                       "region": {"id": "fixture", "gridSize": 3, "spanMetres": 128, "localOrigin": {"x": 0, "z": 0}, "domainBoundsXZ": [-40, 40, -40, 40]},
                       "species": ["fixture"], "stemsCount": 1, "stems": [{"index": 0, "genome": "fixture", "x": x, "y": -z, "z_ww": z,
                       "z_ground": ground, "sx": .125, "sz": .0625, "yaw_rad": .7, "collar_sink_m": sink}],
                       "shellCulling": {"fixture": {"faces_kept": 1}}, "triangles": {"opaque_dome_and_trunk": 44, "cutout_foliage_culled": 1, "glb_wood": 2, "glb_foliage_culled": 1}}
        self.write_source()

    def write_source(self):
        self.source["files"] = {name: {"bytes": len(raw), "sha256": sha(raw)} for name, raw in self.raw.items()}
        for name, raw in self.raw.items():
            (self.folder / name).write_bytes(raw)
        self.source_raw = (json.dumps(self.source, indent=1)+"\n").encode()
        self.manifest_path.write_bytes(self.source_raw)

    def prepare(self, **options):
        with redirect_stdout(io.StringIO()):
            return IMPORTER.prepare(self.manifest_path, self.region, self.output, **options)

    def test_complete_pack_preserves_source_bytes_materials_transforms_and_provenance(self):
        manifest = self.prepare()
        self.assertEqual(manifest["format"], "waterworld.canopy-runtime")
        self.assertEqual(manifest["vertexLayout"]["strideBytes"], 52)
        self.assertFalse(manifest["textureAlphaErrorSupported"])
        self.assertIsNone(manifest["textureAlphaErrorMetres"])
        for name, record in manifest["files"].items():
            raw = (self.output / name).read_bytes()
            self.assertEqual((len(raw), sha(raw)), (record["bytes"], record["sha256"]), name)
        self.assertEqual((self.output / "instances.bin").read_bytes(), self.raw["fixture_instances.bin"])
        self.assertEqual((self.output / "source-manifest.json").read_bytes(), self.source_raw)
        self.assertEqual((self.output / "source-region.json").read_bytes(), self.region_raw)
        near = np.frombuffer((self.output / "near.bin").read_bytes(), dtype="<f4").reshape(-1, 13)
        leaf = np.frombuffer((self.output / "leaf.bin").read_bytes(), dtype="<f4").reshape(-1, 13)
        far = np.frombuffer((self.output / "far.bin").read_bytes(), dtype="<f4").reshape(-1, 13)
        np.testing.assert_allclose(near[:, :3], [self.world(p) for p in self.local_bark], rtol=0, atol=2e-6)
        expected_normals = []
        for i in range(0, len(self.local_bark), 3):
            native_normal = vertex_triangle(self.local_bark[i:i+3])[0, 3:6].astype(np.float64)
            n = np.array([native_normal[0]/2, native_normal[2], -native_normal[1]/3])
            expected_normals.extend([n/np.linalg.norm(n)]*3)
        np.testing.assert_allclose(near[:, 3:6], expected_normals, rtol=0, atol=2e-6)
        np.testing.assert_array_equal(leaf[:, :10], np.frombuffer(self.raw["fixture_canopy_cutout.bin"], dtype="<f4").reshape(-1, 10))
        for stream, colour in ((near, [.18, .07, .035]), (leaf, [.05, .30, .09])):
            np.testing.assert_array_equal(stream[:, 10:13], np.broadcast_to(np.array(colour, dtype="<f4"), (len(stream), 3)))
        for kind, colour in ((3, [.18, .07, .035]), (4, [.05, .30, .09])):
            np.testing.assert_array_equal(far[far[:, 6] == kind, 10:13], np.broadcast_to(np.array(colour, dtype="<f4"), (sum(far[:, 6] == kind), 3)))
        self.assertEqual(manifest["stems"], self.source["stems"])
        provenance = json.loads((self.output / "provenance.json").read_bytes())
        self.assertIsNone(provenance["generatorSnapshot"], "an unknown historical generator revision is not invented")
        self.assertNotIn(str(self.folder), json.dumps(provenance), "portable provenance excludes local absolute paths")
        self.assertEqual(manifest["collarObservations"], provenance["collarObservations"])
        self.assertEqual(manifest["collarObservations"][0]["stemIndex"], 0)
        self.assertLess(manifest["collarObservations"][0]["maximumHeightErrorMetres"], .003)

    def test_modified_binary_receipt_and_leaf_transform_mismatch_are_rejected_before_replacement(self):
        self.prepare()
        before = (self.output / "manifest.json").read_bytes()
        changed = bytearray(self.raw["fixture_canopy_cutout.bin"])
        changed[-1] ^= 1
        (self.folder / "fixture_canopy_cutout.bin").write_bytes(changed)
        with self.assertRaisesRegex(ValueError, "receipt mismatch"):
            self.prepare(force=True)
        self.assertEqual((self.output / "manifest.json").read_bytes(), before)
        data = np.frombuffer(self.raw["fixture_canopy_cutout.bin"], dtype="<f4").copy().reshape(-1, 10)
        data[:, 0] += 10
        self.raw["fixture_canopy_cutout.bin"] = data.tobytes()
        self.write_source()
        with self.assertRaisesRegex(ValueError, "correspondence"):
            self.prepare(force=True)
        self.assertEqual((self.output / "manifest.json").read_bytes(), before)

    def test_unrelated_output_missing_receipt_and_terrain_seating_are_rejected(self):
        self.output.mkdir()
        (self.output / "keep.txt").write_text("untouched")
        with self.assertRaisesRegex(ValueError, "unrelated"):
            self.prepare(force=True)
        self.assertEqual((self.output / "keep.txt").read_text(), "untouched")
        self.output = self.folder / "new"
        del self.source["files"]["fixture_canopy.glb"]
        self.manifest_path.write_text(json.dumps(self.source))
        with self.assertRaisesRegex(ValueError, "receipt mismatch"):
            self.prepare()
        self.write_source()
        self.source["stems"][0]["z_ground"] += .5
        instance = np.frombuffer(self.raw["fixture_instances.bin"], dtype="<f4").copy()
        instance[1] += .5
        self.raw["fixture_instances.bin"] = instance.tobytes()
        self.write_source()
        with self.assertRaisesRegex(ValueError, "runtime terrain triangle"):
            self.prepare()

    def test_open_crown_and_detailed_root_displacement_are_rejected(self):
        data = np.frombuffer(self.raw["fixture_canopy_opaque.bin"], dtype="<f4").copy().reshape(-1, 10)
        data[36, 0] += .01
        self.raw["fixture_canopy_opaque.bin"] = data.tobytes()
        self.write_source()
        with self.assertRaisesRegex(ValueError, "crown|dome"):
            self.prepare()
        self.raw["fixture_canopy_opaque.bin"] = source_opaque(16, 23, 16).tobytes()
        moved = self.local_bark.copy()
        moved[0, 2] += .1
        self.raw["fixture_canopy.glb"] = make_glb(moved, self.local_leaf, [16, 23, 16])
        self.write_source()
        with self.assertRaisesRegex(ValueError, "basal|Detailed wood root"):
            self.prepare()

    def test_surviving_offset_stems_keep_collar_height_and_declared_plant_envelope_without_invented_seed_containment(self):
        stem = self.source["stems"][0]
        y = stem["z_ground"]-stem["collar_sink_m"]
        caps = np.array([[16+.14, y, 16], [16, y, 16+.14], [16-.14, y, 16], [16, y, 16-.14]], dtype="<f4")
        instances = np.frombuffer(self.raw["fixture_instances.bin"], dtype="<f4").reshape(-1, 8)

        def materials(points):
            return {"fixture_bark": {"positions": points, "uv": np.tile([.5, 0], (len(points), 1)), "normals": np.tile([0, -1, 0], (len(points), 1))}}

        self.assertTrue(np.linalg.norm(caps-np.array([16, y, 16]), axis=1).min() > .1)
        IMPORTER.validate_collar_centres([stem], materials(caps), instances)
        # Peer stems may die: a seed need not lie inside the surviving stool.
        for surviving in (caps[:1], np.array([[16+.14, y, 16], [16+.20, y, 16+.1]], dtype="<f4")):
            observed = IMPORTER.validate_collar_centres([stem], materials(surviving), instances)
            self.assertEqual(observed[0]["stemIndex"], 0)
            self.assertGreater(observed[0]["maximumHorizontalOffsetMetres"], .1)
            self.assertLess(observed[0]["maximumHeightErrorMetres"], .003)
            self.assertEqual(len(observed[0]["caps"]), len(surviving))
        for delta in ([0, .004, 0], [20, 0, 0]):
            with self.assertRaises(ValueError, msg="lifted collars and caps beyond the source plant envelope are rejected"):
                IMPORTER.validate_collar_centres([stem], materials(caps+delta), instances)
        centre = np.array([[16, y, 16]], dtype="<f4")
        IMPORTER.validate_collar_centres([stem], materials(centre), instances)
        with self.assertRaises(ValueError):
            IMPORTER.validate_collar_centres([stem], materials(centre+[0, .004, 0]), instances)
        other = dict(stem, index=1, x=26)
        other_instance = instances.copy()
        other_instance[0, 0] = 26
        with self.assertRaises(ValueError, msg="nearest-stem assignment cannot silently leave another authored stem without any basal cap"):
            IMPORTER.validate_collar_centres([stem, other], materials(centre+[10, 0, 0]), np.concatenate((instances, other_instance)))

    def test_glb_headers_and_native_nonfinite_data_are_not_silently_accepted(self):
        raw = self.raw["fixture_canopy.glb"]
        for changed in (raw[:15], b"FAIL"+raw[4:], raw[:-4], raw+raw[12:20]):
            with self.assertRaises(ValueError):
                IMPORTER.glb_primitives(changed)
        with self.assertRaises(ValueError):
            IMPORTER.native_stream(struct.pack("<10f", *([math.nan]+[0]*9)), 10)

    def test_partition_keeps_whole_triangles_and_conservative_error_bounds_triangle_interiors(self):
        a = np.column_stack((vertex_triangle([[120, 0, 0], [150, 0, 0], [120, 0, 20]]), np.tile([.1, .2, .3], (3, 1)))).astype("<f4")
        b = np.column_stack((vertex_triangle([[124, 1, 3], [125, 1, 3], [124, 1, 4]]), np.tile([.1, .2, .3], (3, 1)))).astype("<f4")
        error = IMPORTER.conservative_error(a, b)
        self.assertGreater(error, 0)
        for first, opposite in ((a, b), (b, a)):
            for i in range(11):
                for j in range(11-i):
                    p = first[0, :3]*(1-(i+j)/10)+first[1, :3]*i/10+first[2, :3]*j/10
                    self.assertLessEqual(float(np.linalg.norm(opposite[:, :3]-p, axis=1).min()), error+1e-6)
        streams, patches = IMPORTER.partition({"near": a, "leaf": b, "far": a.copy()})
        for name, original in (("near", a), ("leaf", b), ("far", a)):
            np.testing.assert_array_equal(streams[name], original)
            self.assertEqual(sum(p[name]["vertexCount"] for p in patches), len(original))
        for patch in patches:
            for name in streams:
                r = patch[name]
                for p in streams[name][r["firstVertex"]:r["firstVertex"]+r["vertexCount"], :3]:
                    self.assertTrue(np.all(p >= patch["low"]) and np.all(p <= patch["high"]))
                    self.assertLessEqual(float(np.linalg.norm(p-np.array(patch["centre"]))), patch["radius"]+1e-6)
        self.assertTrue(any(p["geometryErrorSupported"] is False and p["geometryErrorMetres"] is None for p in patches), "disjoint draw batches do not invent geometric LOD proofs")

    def test_affine_leaf_texel_span_is_conservative_and_not_an_alpha_error_claim(self):
        data = np.column_stack((vertex_triangle([[0, 0, 0], [2, 0, 0], [1, 0, 4]]), np.tile([.1, .2, .3], (3, 1)))).astype("<f4")
        span = IMPORTER.leaf_texel_span(data, 100, 200)
        du, dv = np.array([2/100, 0, 0]), np.array([1/200, 0, 4/200])
        exact = max(float(np.linalg.norm(du+dv)), float(np.linalg.norm(du-dv)))
        self.assertGreaterEqual(span, exact)
        self.assertLess(span-exact, 1e-10)
        data[:, 8:10] = 0
        self.assertIsNone(IMPORTER.leaf_texel_span(data, 100, 200), "singular UVs cannot certify a texel footprint")


if __name__ == "__main__":
    unittest.main()
