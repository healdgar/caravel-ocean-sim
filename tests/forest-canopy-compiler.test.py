# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Small source-derived solids; root owns execution and actual scene checks."""
from collections import Counter
from contextlib import redirect_stdout
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("forest_canopy_compiler", ROOT/"scripts/prepare-forest-canopy.py")
COMPILER = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(COMPILER)


def crown():
    top, bottom = [0., 10., 0.], [0., 3., 0.]
    ring = [[4., 6., 0.], [0., 6., 4.], [-4., 6., 0.], [0., 6., -4.]]
    rows = []
    for i in range(4):
        for triangle in ([top, ring[(i+1) % 4], ring[i]], [bottom, ring[i], ring[(i+1) % 4]]):
            triangle = np.asarray(triangle);normal = np.cross(triangle[1]-triangle[0], triangle[2]-triangle[0]);normal /= np.linalg.norm(normal)
            rows.extend([[*point, *normal, 4., .72, 0., 0., .07, .21, .04, -1.] for point in triangle])
    return np.asarray(rows, dtype="<f4").reshape(-1, 3, 14)


def roots(*positions):
    return np.asarray([[x, 100., z, scale, yaw, .95, 1.05, 1., 0., .08, 0., 0.] for x, z, scale, yaw in positions], dtype="<f4")


def flat(x, z):return 100.
flat.minimum_step = 1.


def receipt(raw):return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def assert_closed(test, vertices, indices):
    counts, directions = Counter(), Counter();volume = 0.
    centre = vertices[:, :3].astype(float).mean(axis=0)
    for triangle in vertices[indices.reshape(-1, 3), :3]:
        keys = [tuple(map(float, p)) for p in triangle]
        test.assertEqual(len(set(keys)), 3)
        for a, b in zip(keys, keys[1:]+keys[:1]):
            edge = tuple(sorted((a, b)));counts[edge] += 1;directions[edge] += 1 if a < b else -1
        a, b, c = triangle.astype(float)-centre;volume += float(np.dot(a, np.cross(b, c)))/6
    test.assertTrue(counts);test.assertTrue(all(n == 2 for n in counts.values()), "All position-welded edges need two incident faces")
    test.assertTrue(all(n == 0 for n in directions.values()), "Incident faces need opposite edge directions")
    test.assertGreater(volume, 0)


class ForestCanopyCompiler(unittest.TestCase):
    def test_closed_owner_union_preserves_colours_halos_and_disjoint_clearings(self):
        own = roots((0., 0., 1., .2), (5., 0., 1.1, -.3), (40., 0., 1., .5))
        vertices, indices, report = COMPILER.build_chunk([crown()], [0, 1, 2], own, flat)
        again, again_indices, again_report = COMPILER.build_chunk([crown()], [0, 1, 2], own, flat)
        np.testing.assert_array_equal(vertices, again);np.testing.assert_array_equal(indices, again_indices)
        self.assertEqual(report, again_report)
        assert_closed(self, vertices, indices)
        self.assertEqual(report["components"], 2)
        self.assertFalse(np.any((vertices[:, 0] > 15) & (vertices[:, 0] < 30)), "A wide clearing must not become forest")
        self.assertTrue(np.all(vertices[:, 6] == 4))
        np.testing.assert_allclose(np.linalg.norm(vertices[:, 3:6], axis=1), 1., atol=2e-6, rtol=0)
        expected = np.asarray([.07, .21, .04])*own[0, 5:8]
        np.testing.assert_allclose(vertices[:, 10:13], np.broadcast_to(expected, vertices[:, 10:13].shape), atol=2e-8, rtol=0)
        s = report["sampling"]
        self.assertGreaterEqual(report["geometryErrorMetres"], np.hypot(s["witnessHorizontalMetres"], s["verticalExcessMetres"])+s["arithmeticAllowanceMetres"])
        self.assertEqual(report["geometryErrorMetres"], float(np.float32(report["geometryErrorMetres"])))
        self.assertIn("NOT native leaf alpha", report["geometryErrorScope"])

    def test_seating_uses_actual_terrain_and_never_forces_invalid_roots(self):
        own = roots((0., 0., 1., 0.), (40., 0., 1., 0.), (-40., 0., 1., 0.))
        def ground(x, z):return 0. if x < -20 else 100.+(2*max(0., x-20))
        resident, excluded = COMPILER.resident_roots({"rootCount": 3, "prototypes": [{"basalRadius": .2}]}, own, ground)
        self.assertEqual(excluded, [1, 2]);self.assertEqual(float(resident[0, 3]), 1.)
        self.assertEqual(float(resident[1, 3]), 0.);self.assertEqual(float(resident[2, 3]), 0.)
        self.assertAlmostEqual(float(resident[0, 1]+resident[0, 9]), ground(0., 0.), delta=1e-5)
        np.testing.assert_array_equal(own[:, 3], np.ones(3), "Input root commands remain immutable")

    def test_fresh_compressed_pack_binds_exact_source_and_owner_membership(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary);source = folder/"forest";region = folder/"region";source.mkdir();region.mkdir()
            vertex_data = crown().astype("<f4").tobytes();index_data = np.arange(len(vertex_data)//56, dtype="<u4").tobytes()
            root_data = roots((127., 0., 1., 0.), (129., 0., 1., 0.)).tobytes()
            stream_data = {"vertices.bin": vertex_data, "indices.bin": index_data, "roots.bin": root_data}
            m = {"format": "waterworld.forest-instances", "version": 2, "vertexStride": 56, "materialContract": "gene-surfaces-v3", "rootCount": 2,
                 "prototypes": [{"id": 0, "basalRadius": .2, "far": {"firstIndex": 0, "indexCount": len(index_data)//4}}],
                 "files": {name: receipt(value) for name, value in stream_data.items()}}
            for name, value in stream_data.items():(source/name).write_bytes(value)
            (source/"manifest.json").write_text(json.dumps(m))
            height = np.full((3, 3), 400, dtype="<i2").tobytes();biome = bytes([255]*16)
            (region/"height.bin").write_bytes(height);(region/"biome.bin").write_bytes(biome)
            (region/"manifest.json").write_text(json.dumps({"id": "fixture", "gridSize": 3, "spanMetres": 512., "localOrigin": {"x": 0., "z": 0.},
                "heightSHA256": receipt(height)["sha256"], "vegetation": {"maskSize": 4, "sha256": receipt(biome)["sha256"]}}))
            output = folder/"canopy"
            with redirect_stdout(io.StringIO()):manifest = COMPILER.prepare(source, region, output)
            self.assertEqual((manifest["rootCount"], manifest["residentRootCount"], len(manifest["chunks"])), (2, 2, 2))
            decoded = {}
            for name, item in manifest["files"].items():
                encoded = (output/item["gzip"]["file"]).read_bytes();self.assertEqual(receipt(encoded), {k: item["gzip"][k] for k in ("bytes", "sha256")})
                decoded[name] = gzip.decompress(encoded);self.assertEqual(receipt(decoded[name]), {k: item[k] for k in ("bytes", "sha256")})
            owners = np.frombuffer(decoded["root-chunks.bin"], dtype="<u4")
            self.assertNotEqual(int(owners[0]), int(owners[1]))
            vertices = np.frombuffer(decoded["vertices.bin"], dtype="<f4").reshape(-1, 13);indices = np.frombuffer(decoded["indices.bin"], dtype="<u4")
            for chunk in manifest["chunks"]:
                self.assertEqual(chunk["rootCount"], 1)
                self.assertLess(chunk["low"][0], 128);self.assertGreater(chunk["high"][0], 128)
                draw = indices[chunk["firstIndex"]:chunk["firstIndex"]+chunk["indexCount"]]
                assert_closed(self, vertices, draw)
                self.assertEqual(chunk["geometryErrorSource"]["sourceFiles"], manifest["source"]["files"])
            self.assertIs(manifest["appearanceErrorSupported"], False)
            with self.assertRaisesRegex(ValueError, "Fresh output"):
                COMPILER.prepare(source, region, output)


if __name__ == "__main__":unittest.main()
