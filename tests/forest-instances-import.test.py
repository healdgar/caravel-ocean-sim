# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Synthetic source math; no growth, external assets, rendering or downloads."""
import importlib.util
import math
from pathlib import Path
import unittest
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("forest_import", ROOT/"scripts/prepare-forest-instances.py")
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class ForestInstanceImport(unittest.TestCase):
    def test_native_z_up_yaw_is_undone_once_after_y_up_node_conversion(self):
        local = np.array([[2., 3., 4., .6, 0, .8, 4, .5, .2, .3, .1, .2, .3]], dtype="<f4")
        root, yaw = np.array([100., 200., -300.]), .73
        # Independent Z-up XY rotation, followed by Y-up (x,z,-y).
        x, y, z = local[0, 0], -local[0, 2], local[0, 1]
        nx, ny, nz = local[0, 3], -local[0, 5], local[0, 4]
        c, s = math.cos(yaw), math.sin(yaw)
        world = local.astype(np.float64).copy()
        world[0, :3] = root+[c*x-s*y, z, -(s*x+c*y)]
        world[0, 3:6] = [c*nx-s*ny, nz, -(s*nx+c*ny)]
        restored = IMPORTER.localise_stream(world, root, yaw)
        np.testing.assert_allclose(restored[:, :6], local[:, :6], atol=2e-6, rtol=0)
        np.testing.assert_array_equal(restored[:, 6:], local[:, 6:])

    def test_dense_deterministic_roots_obey_hard_biome_slope_water_and_collar_rules(self):
        region = {"spanMetres": 128., "localOrigin": {"x": 0., "z": 0.}, "vegetation": {"maskSize": 16}}
        mask = np.full((16, 16), 255, dtype=np.uint8);mask[:, :3] = 0
        def sample(x, z):
            return (0., 0., 0.) if z > 30 else (100.+.1*x, 2. if x > 30 else .1, 0.)
        prototypes = [{"id": i, "crownRadius": 5., "basalRadius": .3} for i in range(5)]
        roots, coverage = IMPORTER.place_roots(region, sample, mask.tobytes(), prototypes, exclude=[-8, 8, -8, 8])
        again, _ = IMPORTER.place_roots(region, sample, mask.tobytes(), prototypes, exclude=[-8, 8, -8, 8])
        np.testing.assert_array_equal(roots, again)
        self.assertGreater(len(roots), 20)
        self.assertEqual(set(roots[:, 8].astype(int)), set(range(5)))
        self.assertEqual(coverage["kind"], "occupied-cells")
        contacts = 0
        for i, row in enumerate(roots):
            x, collar, z, scale = map(float, row[:4])
            self.assertLessEqual(x, 30);self.assertLessEqual(z, 30)
            self.assertFalse(-8 <= x <= 8 and -8 <= z <= 8)
            self.assertAlmostEqual(collar+float(row[9]), sample(x, z)[0], delta=1e-5)
            radius = 5*scale
            peers = np.delete(roots, i, axis=0)
            distances = np.hypot(peers[:, 0]-x, peers[:, 2]-z)
            self.assertTrue(np.all(distances >= .65*(radius+peers[:, 3]*5)-1e-5))
            contacts += int(np.any(distances <= radius+peers[:, 3]*5))
        self.assertGreater(contacts, len(roots)*.5, "forest crowns should actually touch, not form an orchard grid")


if __name__ == "__main__":unittest.main()
