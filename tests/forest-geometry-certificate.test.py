# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Independent finite surface witnesses; no external models, growth or render."""
import hashlib
import importlib.util
import math
from pathlib import Path
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("forest_certificate", ROOT/"scripts/prepare-forest-instances.py")
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


def rows(triangles):
    points = np.asarray(triangles, dtype="<f4").reshape(-1, 3)
    stream = np.zeros((len(points), 14), dtype="<f4")
    stream[:, :3] = points;stream[:, 4] = 1;stream[:, 6] = 4
    return stream


def triangle_distance(point, triangle):
    """Independent projection to the plane/interior and three bounded edges."""
    a, b, c = triangle.astype(np.float64);point = np.asarray(point, dtype=np.float64)
    ab, ac = b-a, c-a;normal = np.cross(ab, ac);normal /= np.linalg.norm(normal)
    signed = np.dot(point-a, normal);projected = point-signed*normal
    aa, bb, cc = np.dot(ab, ab), np.dot(ab, ac), np.dot(ac, ac)
    ap = projected-a;d, e = np.dot(ap, ab), np.dot(ap, ac)
    v, w = (d*cc-e*bb)/(aa*cc-bb*bb), (e*aa-d*bb)/(aa*cc-bb*bb)
    if v >= -1e-12 and w >= -1e-12 and v+w <= 1+1e-12:return abs(float(signed))
    return min(float(np.linalg.norm(point-(first+np.clip(np.dot(point-first, last-first)/np.dot(last-first, last-first), 0, 1)*(last-first))))
               for first, last in ((a, b), (b, c), (c, a)))


class ForestGeometryCertificate(unittest.TestCase):
    native_glb = {"file": "native_oak.glb", "bytes": 123, "sha256": "a"*64}
    far_asset = {"file": "native-far.bin", "bytes": 456, "sha256": "b"*64}

    def certificate(self, streams):
        return IMPORTER.native_geometry_certificate(streams, self.native_glb, self.far_asset)

    def assert_surface_witnesses(self, first, second, bound):
        targets = second[:, :3].reshape(-1, 3, 3)
        for triangle in first[:, :3].reshape(-1, 3, 3):
            for i in range(9):
                for j in range(9-i):
                    point = (i*triangle[0]+j*triangle[1]+(8-i-j)*triangle[2])/8
                    distance = min(triangle_distance(point, target) for target in targets)
                    self.assertLessEqual(distance, bound+1e-10)

    def test_complete_surfaces_including_deep_roots_and_outlying_leaves_are_bounded(self):
        streams = {"wood": rows([[[0, -30, 0], [1, -30, 0], [0, -29, 0]],
                                  [[0, 0, 0], [1, 0, 0], [0, 1, 0]]]),
                   "leaf": rows([[[40, 10, 0], [41, 10, 0], [40, 11, 0]]]),
                   "far": rows([[[0, 5, 0], [3, 5, 0], [0, 8, 0]]])}
        before = {name: stream.tobytes() for name, stream in streams.items()}
        certificate = self.certificate(streams);error = certificate["geometryErrorMetres"]
        self.assertTrue(certificate["geometryErrorSupported"])
        self.assertGreaterEqual(error, 35., "Below-ground roots must not be clipped from measurement")
        self.assertGreaterEqual(error, min(triangle_distance([41, 10, 0], triangle)
                                         for triangle in streams["far"][:, :3].reshape(-1, 3, 3)))
        native = np.concatenate((streams["wood"], streams["leaf"]))
        self.assert_surface_witnesses(native, streams["far"], error)
        self.assert_surface_witnesses(streams["far"], native, error)
        self.assertEqual(before, {name: stream.tobytes() for name, stream in streams.items()})
        source = certificate["geometryErrorSource"]
        self.assertEqual(source["nativeGLB"], self.native_glb)
        self.assertEqual(source["farAsset"], self.far_asset)
        self.assertEqual(source["farSubdivisionLevels"], 0)
        for name, stream in streams.items():
            item = source["measuredStreams"][name]
            self.assertEqual(item["sha256"], hashlib.sha256(before[name]).hexdigest())
            self.assertEqual((item["bytes"], item["vertexCount"], item["strideFloats"]), (stream.nbytes, len(stream), 14))
        for key in ("appearanceErrorSupported", "textureAlphaErrorSupported", "colourErrorSupported"):
            self.assertIs(source[key], False)

    def test_vertex_coincidence_does_not_hide_missing_triangle_interiors(self):
        triangle = [[0, 0, 0], [12, 0, 0], [0, 0, 12]]
        tiny = [[[x, 0, z], [x+.01, 0, z], [x, 0, z+.01]] for x, _, z in triangle]
        streams = {"wood": rows([triangle]), "leaf": rows([triangle]), "far": rows(tiny)}
        # Every large-triangle vertex lies on a target triangle. Checking only
        # those vertices would incorrectly certify zero surface error.
        for point in triangle:
            self.assertAlmostEqual(min(triangle_distance(point, t) for t in streams["far"][:, :3].reshape(-1, 3, 3)), 0.)
        error = self.certificate(streams)["geometryErrorMetres"]
        centre_error = min(triangle_distance([4, 0, 4], t) for t in streams["far"][:, :3].reshape(-1, 3, 3))
        self.assertGreater(centre_error, 5.)
        self.assertGreaterEqual(error, centre_error)
        self.assert_surface_witnesses(streams["wood"], streams["far"], error)

    def test_float32_transport_never_rounds_the_certificate_down(self):
        for value in (0., 1., 1.+2**-26, 19.123456789, 1e-8):
            rounded = IMPORTER.float32_upper_bound(value)
            self.assertGreaterEqual(rounded, value)
            self.assertEqual(rounded, float(np.float32(rounded)))
            self.assertLessEqual(rounded-value, max(float(np.spacing(np.float32(value))), 0.))
        for value in (-1., math.inf, math.nan):
            with self.assertRaisesRegex(ValueError, "Invalid geometric error"):
                IMPORTER.float32_upper_bound(value)


if __name__ == "__main__":unittest.main()
