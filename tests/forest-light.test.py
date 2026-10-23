# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Physical small-grid witnesses; root alone executes these fixtures."""
from contextlib import redirect_stdout
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import numpy as np
from scipy.ndimage import map_coordinates

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("native_canopy_light", ROOT/"scripts/prepare-forest-light.py")
LIGHT = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(LIGHT)


def packed_arrays(arrays):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for key, array in arrays.items():
            payload = io.BytesIO();np.lib.format.write_array(payload, array, allow_pickle=False)
            archive.writestr(key+".npy", payload.getvalue())
    return stream.getvalue()


def write_fixture(folder):
    pack, fields = folder/"native", folder/"fields";pack.mkdir();fields.mkdir()
    vertices, indices, prototypes = [], [], []
    for i, species in enumerate(LIGHT.SPECIES):
        first = len(indices);start = len(vertices)
        # Original wood below the leaf cache and three native leaf vertices.
        for point, kind, material in (((0., -2., 0.), 3., 0.), ((.5, -2., 0.), 3., 0.),
                                     ((0., -1., .5), 3., 0.), ((0., 1., 0.), 4., 1.),
                                     ((.5, 1., 0.), 4., 1.), ((0., 1., .5), 4., 1.)):
            vertices.append([*point, 0., 1., 0., kind, .72, 0., 0., 1., 1., 1., material])
        indices.extend(range(start, start+6))
        prototypes.append({"id": i, "species": species, "wood": {"firstIndex": first, "indexCount": 3},
                           "leaf": {"firstIndex": first+3, "indexCount": 3}})
    # An unused coarse-only vertex keeps255 without reading any proxy range.
    vertices.append([0., 0., 0., 0., 1., 0., 4., 1., 0., 0., 1., 1., 1., -1.])
    raw = {"vertices.bin": np.asarray(vertices, dtype="<f4").tobytes(),
           "indices.bin": np.asarray(indices, dtype="<u4").tobytes(), "roots.bin": bytes(48)}
    native = {"format": "waterworld.forest-instances", "version": 2, "vertexStride": 56,
              "units": "metres", "upAxis": "Y", "materialContract": "gene-surfaces-v3",
              "rootCount": 1, "prototypes": prototypes, "files": {k: LIGHT.receipt(v) for k, v in raw.items()}}
    for name, value in raw.items():
        (pack/name).write_bytes(value)
    manifest_raw = (json.dumps(native)+"\n").encode();(pack/"manifest.json").write_bytes(manifest_raw)
    records = []
    for p in prototypes:
        density = np.zeros((5, 5, 5), dtype="<f4");density[:, 2:4, :] = 3.
        arrays = {"originXYZ": np.asarray([-1., 0., -1.], dtype="<f8"), "cellMetres": np.asarray(.5, dtype="<f8"),
                  "density": density, "rgbMoment": np.zeros((*density.shape, 3), dtype="<f4")}
        encoded = packed_arrays(arrays);name = f"prototype-{p['id']}-{p['species']}.npz";(fields/name).write_bytes(encoded)
        records.append({"id": p["id"], "species": p["species"], "field": {"file": name, **LIGHT.receipt(encoded)},
                        "arrays": {key: {"dtype": array.dtype.str, "shape": list(array.shape), **LIGHT.receipt(array.tobytes())}
                                   for key, array in arrays.items()}})
    field_manifest = {"format": "waterworld.native-forest-fields", "version": 1, "complete": True,
                      "units": "metres", "upAxis": "Y", "recipe": {"version": 1},
                      "source": {"manifest": LIGHT.receipt(manifest_raw), "files": native["files"]}, "prototypes": records}
    (fields/"manifest.json").write_text(json.dumps(field_manifest)+"\n")
    return pack, fields, raw


class NativeCanopyLight(unittest.TestCase):
    def test_empty_space_is_full_exposure_and_density_is_not_mutated(self):
        density = np.zeros((3, 4, 5), dtype="<f4");before = density.tobytes()
        np.testing.assert_array_equal(LIGHT.exposure_grid(density, .25), np.ones(density.shape, dtype="<f4"))
        self.assertEqual(density.tobytes(), before)

    def test_dense_interior_attenuates_and_half_cell_has_analytic_depth(self):
        density = np.full((5, 5, 5), 4., dtype="<f4")
        result = LIGHT.exposure_grid(density, 1.)
        self.assertAlmostEqual(float(result[2, 2, 2]), .18, delta=1e-7)
        self.assertGreater(float(result[-1, -1, -1]), float(result[2, 2, 2]))
        # One cell contains2m2/m3. Each ray sees half its0.5m width:
        # optical depth=0.5 projection *2 density *0.25m path=0.25.
        single = LIGHT.exposure_grid(np.full((1, 1, 1), 2., dtype="<f4"), .5)
        self.assertAlmostEqual(float(single[0, 0, 0]), float(np.exp(-.25)), delta=5e-8)

    def test_equal_horizontal_rays_are_mirror_and_axis_symmetric(self):
        density = (np.arange(4*5*6, dtype="<f4").reshape(4, 5, 6) % 11)/10
        result = LIGHT.exposure_grid(density, .25)
        for axis in (0, 2):
            mirrored = LIGHT.exposure_grid(np.flip(density, axis), .25)
            np.testing.assert_allclose(mirrored, np.flip(result, axis), atol=1e-7, rtol=0)
        swapped = LIGHT.exposure_grid(density.transpose(2, 1, 0), .25)
        np.testing.assert_allclose(swapped, result.transpose(2, 1, 0), atol=1e-7, rtol=0)

    def test_low_wood_probes_still_see_canopy_above_original_grid(self):
        density = np.zeros((3, 3, 3), dtype="<f4");density[:, 1:, :] = 4.
        points = np.asarray([[1., -3., 1.]])
        padded, origin = LIGHT.expand_density(density, np.zeros(3), 1., points)
        lighting = LIGHT.exposure_grid(padded, 1.)
        sample = map_coordinates(lighting, ((points-origin)/1.).T, order=1, prefilter=False)
        # Horizontal paths are empty, carrying0.6; upward foliage attenuates
        # the remaining0.4 even though the probe is outside the original grid.
        self.assertGreater(float(sample[0]), .6);self.assertLess(float(sample[0]), .8)
        with self.assertRaisesRegex(ValueError, "voxel budget"):
            LIGHT.expand_density(density, np.zeros(3), 1., points, max_voxels=1)

    def test_pack_receipts_global_vertex_bytes_padding_and_immutability(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary);pack, fields, before = write_fixture(folder);out = folder/"shade"
            with redirect_stdout(io.StringIO()):
                document = LIGHT.prepare(pack, fields, out)
            self.assertEqual((document["vertexCount"], document["sampledVertexCount"], document["paddingBytes"]), (31, 30, 1))
            self.assertEqual(document["recipe"]["version"], 1)
            self.assertEqual(document["source"]["files"], {k: LIGHT.receipt(v) for k, v in before.items()})
            encoded = (out/"canopy-shade.bin.gz").read_bytes();raw = gzip.decompress(encoded)
            self.assertEqual(len(raw), 32);self.assertEqual(raw[-2:], bytes([255, 255]))
            self.assertTrue(any(value < 255 for value in raw[:-2]))
            record = document["files"]["canopy-shade.bin"]
            self.assertEqual(LIGHT.receipt(raw), {k: record[k] for k in ("bytes", "sha256")})
            self.assertEqual(LIGHT.receipt(encoded), {k: record["gzip"][k] for k in ("bytes", "sha256")})
            for name, original in before.items():
                self.assertEqual((pack/name).read_bytes(), original)
            self.assertIs(document["qualification"]["renderedAccepted"], False)
            with self.assertRaisesRegex(ValueError, "Fresh output"):
                LIGHT.prepare(pack, fields, out)
            # Source mutation is rejected before a fresh output is published.
            value = bytearray(before["vertices.bin"]);value[0] ^= 1;(pack/"vertices.bin").write_bytes(value)
            with self.assertRaisesRegex(ValueError, "receipt mismatch"):
                LIGHT.prepare(pack, fields, folder/"bad")
            self.assertFalse((folder/"bad").exists())


if __name__ == "__main__":
    unittest.main()
