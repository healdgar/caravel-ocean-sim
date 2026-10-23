# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Small independent area/pigment fixtures; root owns every execution."""
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("native_forest_fields", ROOT/"scripts/prepare-forest-fields.py")
FIELDS = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(FIELDS)


class NoProxy(dict):
    def get(self, name, *args):
        if name == "far":
            raise AssertionError("A native field cannot read coarse proxy membership")
        return super().get(name, *args)

    def __getitem__(self, name):
        if name == "far":
            raise AssertionError("A native field cannot read coarse proxy membership")
        return super().__getitem__(name)


def material(name, rgb=(128, 128, 128), alpha=None, cutoff=.35):
    rgba = np.empty((16, 16, 4), dtype=np.uint8)
    rgba[:, :, :3] = rgb;rgba[:, :, 3] = 255 if alpha is None else alpha
    return {"name": name, "cutoff": cutoff, "rgba": rgba,
            "rgb": FIELDS.linear_rgb(rgba[:, :, :3]), "alpha": rgba[:, :, 3].astype(float)/255.}


def rows(points, slot, kind=4):
    uv = ((0., 0.), (1., 0.), (0., 1.))
    return [[*p, 0., 1., 0., float(kind), 1., *q, 1., 1., 1., float(slot)] for p, q in zip(points, uv)]


def fixture():
    wood = rows(((-.05, 0., 0.), (.05, 0., 0.), (0., .2, 0.)), 0, 3)
    first = rows(((-3., 1., 0.), (-2.8, 1., 0.), (-3., 1., .2)), 1)
    second = rows(((3., 1., 0.), (3.2, 1., 0.), (3., 1., .2)), 2)
    vertices = np.asarray([*wood, *first, *second, *([float("nan")]*14,)], dtype="<f4")
    indices = np.arange(9, dtype="<u4")
    p = NoProxy(wood={"firstIndex": 0, "indexCount": 3}, leaf={"firstIndex": 3, "indexCount": 6},
                far={"firstIndex": 10**9, "indexCount": 3})
    materials = [material("bark"), material("foliage_0", (128, 0, 0)), material("foliage_1", (0, 128, 0))]
    return p, vertices, indices, materials


class NativeForestFields(unittest.TestCase):
    def test_true_leaf_area_linear_pigment_and_disconnected_patches_survive(self):
        p, vertices, indices, materials = fixture()
        origin, density, rgb, report = FIELDS.build_field(p, vertices, indices, materials,
            cell_metres=.1, sigma_metres=.1, quadrature_edge_metres=.15)
        # Two horizontal right triangles, each0.2m by0.2m, no wood leaf area.
        expected = sum(.5*np.linalg.norm(np.cross(t[1]-t[0], t[2]-t[0]))
                       for t in vertices[indices[3:]].reshape(-1, 3, 14)[:, :, :3].astype(float))
        self.assertAlmostEqual(float(density.sum(dtype=np.float64)*.1**3), expected, delta=2e-9)
        self.assertEqual(report["unresolvedMaskAreaSquareMetres"], 0.)
        x = origin[0]+np.arange(density.shape[0])*.1
        self.assertTrue(np.any(density[x < -2] > 0));self.assertTrue(np.any(density[x > 2] > 0))
        self.assertTrue(np.all(density[(x > -1) & (x < 1)] == 0), "A clearing cannot be filled")
        red = x < 0;green = x > 0
        self.assertTrue(np.all(rgb[red, :, :, 1:] == 0));self.assertTrue(np.all(rgb[green][..., [0, 2]] == 0))
        linear = ((128/255.+.055)/1.055)**2.4
        colour_area = rgb.sum(axis=(0, 1, 2), dtype=np.float64)*.1**3
        np.testing.assert_allclose(colour_area, [expected*.5*linear, expected*.5*linear, 0], atol=2e-9, rtol=2e-6)
        self.assertIs(report["appearanceErrorSupported"], False)

    def test_mixed_mask_has_analytic_area_inside_reported_uncertainty(self):
        alpha = np.zeros((16, 16), dtype=np.uint8);alpha[:, :8] = 255
        source = np.asarray(rows(((0., 1., 0.), (1., 1., 0.), (0., 1., 1.)), 1), dtype="<f4").reshape(1, 3, 14)
        stats = {"evaluatedPatches": 0, "zeroAreaPatches": 0, "provedTransparentAreaSquareMetres": 0.,
                 "terminalPatches": 0, "unresolvedMaskAreaSquareMetres": 0., "acceptedAreaSquareMetres": 0.,
                 "acceptedSamples": 0, "acceptedLinearRGBTimesArea": np.zeros(3),
                 "maximumQuadraturePatchRadiusMetres": 0.}
        batches = list(FIELDS.quadrature(source, material("foliage_0", alpha=alpha, cutoff=.5), .15, stats, 100000))
        accepted = sum(float(weights.sum()) for _, weights, _ in batches)
        # Bilinear half-alpha boundary is u=.5; the left portion of this
        # unit right triangle has area3/8, independent of triangulation.
        self.assertLessEqual(abs(accepted-.375), stats["unresolvedMaskAreaSquareMetres"]+1e-12)
        self.assertGreater(stats["evaluatedPatches"], 1)
        self.assertGreater(stats["provedTransparentAreaSquareMetres"], 0)

    def test_budget_failure_preserves_source_and_npz_scalar_contract(self):
        p, vertices, indices, materials = fixture();before = vertices.tobytes()
        with self.assertRaisesRegex(ValueError, "voxel budget"):
            FIELDS.build_field(p, vertices, indices, materials, max_voxels=1)
        self.assertEqual(vertices.tobytes(), before)
        arrays = {"originXYZ": np.array([1., 2., 3.], dtype="<f8"),
                  "cellMetres": np.asarray(.25, dtype="<f8"),
                  "density": np.ones((2, 3, 4), dtype="<f4"),
                  "rgbMoment": np.ones((2, 3, 4, 3), dtype="<f4")}
        first = FIELDS.deterministic_npz(arrays)
        self.assertEqual(first, FIELDS.deterministic_npz(arrays))
        with np.load(io.BytesIO(first), allow_pickle=False) as packed:
            self.assertEqual(packed["cellMetres"].shape, ())
            for name, value in arrays.items():
                np.testing.assert_array_equal(packed[name], value)

    def test_native_receipt_mutation_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary);original = b"Original native stream"
            (folder/"vertices.bin").write_bytes(original)
            expected = FIELDS.receipt(original)
            self.assertEqual(FIELDS.read_receipted(folder, "vertices.bin", expected), original)
            (folder/"vertices.bin").write_bytes(original[:-1]+b"!")
            with self.assertRaisesRegex(ValueError, "receipt mismatch"):
                FIELDS.read_receipted(folder, "vertices.bin", expected)


if __name__ == "__main__":
    unittest.main()
