"""Native leaf-field union regressions; run explicitly in the authoring env."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np

SPEC = importlib.util.spec_from_file_location('native_mass', Path(__file__).resolve().parents[1]/'scripts/prepare-forest-mass.py')
M = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(M)


def field(colour=(.1, .3, .05), level=.06):
    density = np.zeros((9, 9, 9), np.float32); density[2:7, 2:7, 2:7] = level
    return {'id': 0, 'origin': np.array([-4., -4., -4.]), 'high': np.array([4., 4., 4.]), 'cell': 1.,
            'density': density, 'moment': density[..., None]*np.array(colour, np.float32)}


class NativeMass(unittest.TestCase):
    def test_foliage_adds_before_isosurface_instead_of_unioning_thresholded_trees(self):
        p = field(); r = np.array([[0, 10, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0]]*2, np.float32)
        lo, hi = M.root_bounds(r, [p]); nominal = [-8, 8, -8, 8]
        v, i = M.assemble([p], r, np.array([0]), lo, hi, nominal, 1., lambda x, z: 0., .08)
        self.assertEqual(len(i), 0, 'each isolated .06 field is below the same .08 threshold')
        v, i = M.assemble([p], r, np.array([0, 1]), lo, hi, nominal, 1., lambda x, z: 0., .08)
        self.assertGreater(len(i), 0, 'two real leaf areas jointly form a visible mass')
        self.assertEqual(i.ndim, 1, 'serialized indexCount always counts scalar indices under NumPy 1.x and 2.x')
        self.assertEqual(i.nbytes, len(i)*4)
        np.testing.assert_allclose(v[:, 10:13], np.broadcast_to([.1, .3, .05], (len(v), 3)), atol=1e-6)

    def test_uniform_scale_conserves_leaf_area_not_volume(self):
        p = field(level=1.)
        def area(scale):
            r = np.array([[0, 20, 0, scale, 0, 1, 1, 1, 0, 0, 0, 0]], np.float32); lo, hi = M.root_bounds(r, [p])
            captured = {}
            def capture(density, moment, origin, cell, *args, **kw):
                captured['area'] = float(density.sum())*cell**3
                return np.empty((0, 13), np.float32), np.empty(0, np.uint32)
            with patch.object(M, 'extract', capture): M.assemble([p], r, np.array([0]), lo, hi, [-16, 16, -16, 16], 1., lambda x, z: 0., .08)
            return captured['area']
        self.assertAlmostEqual(area(2)/area(1), 4., places=6)

    def test_shared_chunk_lattice_meets_without_extra_boundary_walls(self):
        p = field(level=1.); r = np.array([[0, 10, 0, 1, .35, 1, 1, 1, 0, 0, 0, 0]], np.float32); lo, hi = M.root_bounds(r, [p])
        halves = [M.assemble([p], r, np.array([0]), lo, hi, n, .5, lambda x, z: 0., .08) for n in ([-8, 0, -8, 8], [0, 8, -8, 8])]
        edges = []
        for v, i in halves:
            edge = v[np.abs(v[:, 0]) < 1e-6, :3]
            self.assertGreater(len(edge), 0)
            edges.append({tuple(np.round(p, 5)) for p in edge})
            self.assertFalse(any(np.all(np.abs(v[tri, 0]) < 1e-6) for tri in i.reshape(-1, 3)), 'no invented foliage wall on the internal block plane')
        self.assertEqual(edges[0], edges[1])

    def test_empty_space_and_terrain_never_generate_foliage_or_green(self):
        p = field(level=1.); p['density'][4:6] = 0; p['moment'][4:6] = 0
        r = np.array([[0, 10, 0, 1, 0, .5, 1, .5, 0, 0, 0, 0]], np.float32); lo, hi = M.root_bounds(r, [p])
        v, i = M.assemble([p], r, np.array([0]), lo, hi, [-8, 8, -8, 8], .5, lambda x, z: 100., .08)
        self.assertEqual(len(i), 0, 'ground clips real foliage; it never contributes optical area')
        v, i = M.assemble([p], r, np.array([0]), lo, hi, [-8, 8, -8, 8], .5, lambda x, z: 0., .08)
        tri = v[i.reshape(-1, 3), :3]
        self.assertFalse(np.any((tri[:, :, 0].min(axis=1) < 0) & (tri[:, :, 0].max(axis=1) > 2)), 'clear source tunnel is not closed to force density')
        np.testing.assert_allclose(v[:, 10:13], np.broadcast_to([.05, .3, .025], (len(v), 3)), atol=1e-6)


if __name__ == '__main__': unittest.main()
