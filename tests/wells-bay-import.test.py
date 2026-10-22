# Copyright (c) 2026 Six Cailloux, LLC. MIT. Root owns execution.
import importlib.util
from pathlib import Path
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('wells_bay_import_under_test', ROOT/'scripts/prepare-wells-bay.py')
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class NearTerrainTests(unittest.TestCase):
    def test_triangle_reference_rejects_bilinear_saddle(self):
        manifest = dict(gridSize=2, spanMetres=2, localOrigin=dict(x=0, z=0))
        heights = np.array([[0, 0], [0, 8]], dtype=np.float64)
        actual = IMPORTER.triangle_sample(heights, np.array([-.5, 0, .5, 1]), np.array([-.5, 0, .5, 1]), manifest)
        np.testing.assert_array_equal(actual, [0, 0, 4, 8])

    def test_crop_is_bounded_and_uses_resident_grid_aligned_edges(self):
        manifest = dict(latitude=17.635, longitude=-63.238, localOrigin=dict(x=0, z=-6000))
        for spacing in (1, 2):
            x, z, lon, lat = IMPORTER.near_coordinates(manifest, spacing)
            self.assertEqual(x.shape, (1024//spacing+1,)*2)
            self.assertEqual((x.min(), x.max(), z.min(), z.max()), (-2048, -1024, -7504, -6480))
            self.assertTrue(np.all(np.diff(lon, axis=1) > 0)); self.assertTrue(np.all(np.diff(lat, axis=0) < 0))
        with self.assertRaises(ValueError):
            IMPORTER.near_coordinates(manifest, 8)

    def test_source_support_and_authored_water_remain_distinct_while_perimeter_is_exact(self):
        axis = np.arange(65)*2; x, z = np.meshgrid(axis, axis)
        coarse = 10+x*.125-z*.0625
        measured = np.ones_like(coarse, dtype=bool); fine = coarse+3
        result = IMPORTER.blend_near_heights(fine, measured, coarse, x, z, 2)
        for a, b in [(result[0], coarse[0]), (result[-1], coarse[-1]), (result[:, 0], coarse[:, 0]), (result[:, -1], coarse[:, -1])]:
            np.testing.assert_array_equal(a, b)
        self.assertEqual(result[32, 32], fine[32, 32])
        measured[:, :24] = False
        wet_coarse = np.where(measured, coarse, -20)
        wet = IMPORTER.blend_near_heights(fine, measured, wet_coarse, x, z, 2)
        self.assertTrue(np.all(wet[~measured] <= 0)); self.assertTrue(np.isfinite(wet).all())
        self.assertLess(wet[32, 23], 0); self.assertGreater(wet[32, 23], -20)


if __name__ == '__main__':
    unittest.main()
