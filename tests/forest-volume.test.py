# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Analytical volume transport fixtures; root alone executes them."""
from contextlib import redirect_stdout
import gzip
import importlib.util
import io
import json
import math
from pathlib import Path
import tempfile
import unittest
import zipfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("native_foliage_volume", ROOT/"scripts/prepare-forest-volume.py")
VOLUME = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(VOLUME)


def arrays(shape=(5, 6, 7)):
    density = np.zeros(shape, dtype="<f4")
    x, y, z = np.indices(shape)
    density[1:-1, 1:-1, 1:-1] = (.5+x*.125+y*.25+z*.5)[1:-1, 1:-1, 1:-1]
    moment = density[..., None]*np.asarray([.25, .5, .75], dtype="<f4")
    return density, moment.astype("<f4")


def write_npz(data):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for key, array in data.items():
            member = io.BytesIO();np.lib.format.write_array(member, array, allow_pickle=False)
            archive.writestr(key+".npy", member.getvalue())
    return stream.getvalue()


def native_fixture(folder):
    pack, fields = folder/"native", folder/"fields";pack.mkdir();fields.mkdir()
    streams = {"vertices.bin": bytes(56), "indices.bin": bytes(12), "roots.bin": bytes(48)}
    native = {"format": "waterworld.forest-instances", "version": 2, "vertexStride": 56,
        "units": "metres", "upAxis": "Y", "materialContract": "gene-surfaces-v3", "rootCount": 1,
        "prototypes": [{"id": i, "species": name} for i, name in enumerate(VOLUME.LIGHT.SPECIES)],
        "files": {name: VOLUME.receipt(raw) for name, raw in streams.items()}}
    native_raw = (json.dumps(native)+"\n").encode();(pack/"manifest.json").write_bytes(native_raw)
    for name, raw in streams.items():
        (pack/name).write_bytes(raw)
    density, moment = arrays()
    values = {"originXYZ": np.asarray([-.5, -.5, -.5], dtype="<f8"),
        "cellMetres": np.asarray(.25, dtype="<f8"), "density": density, "rgbMoment": moment}
    records = []
    for p in native["prototypes"]:
        encoded = write_npz(values);name = f"prototype-{p['id']}-{p['species']}.npz";(fields/name).write_bytes(encoded)
        records.append({**p, "field": {"file": name, **VOLUME.receipt(encoded)},
            "arrays": {key: {"dtype": array.dtype.str, "shape": list(array.shape), **VOLUME.receipt(array.tobytes())}
                       for key, array in values.items()}})
    fm = {"format": "waterworld.native-forest-fields", "version": 1, "complete": True,
        "upAxis": "Y", "units": "metres", "recipe": {"version": 1}, "prototypes": records,
        "source": {"manifest": VOLUME.receipt(native_raw), "files": native["files"]}}
    (fields/"manifest.json").write_text(json.dumps(fm)+"\n")
    return pack, fields, streams


class NativeFoliageVolume(unittest.TestCase):
    def test_webgpu_axis_order_and_source_linear_pigment(self):
        density, moment = arrays();before = (density.tobytes(), moment.tobytes())
        field, exposure, report = VOLUME.pack_textures(density, moment, np.asarray([-.5, -.5, -.5]), .25)
        packed = np.frombuffer(field, dtype="<f2")
        nx, ny, nz = density.shape
        for x, y, z in ((1, 1, 1), (2, 3, 4), (3, 4, 5)):
            address = ((z*ny+y)*nx+x)*4
            np.testing.assert_array_equal(packed[address:address+4], [*moment[x, y, z], density[x, y, z]])
            np.testing.assert_allclose(packed[address:address+3]/packed[address+3], [.25, .5, .75], atol=1e-3, rtol=0)
        self.assertEqual(len(exposure), nx*ny*nz)
        self.assertEqual(report["dimensionsXYZ"], [nx, ny, nz])
        self.assertEqual(report["low"][1], 0.)
        self.assertEqual(report["textureLow"], [-.625, -.625, -.625])
        self.assertAlmostEqual(report["samplingFootprintMetres"], math.sqrt(3)*.25)
        self.assertEqual(before, (density.tobytes(), moment.tobytes()))

    def test_filtering_keeps_moments_until_after_density_interpolation(self):
        density = np.zeros((4, 3, 3), dtype="<f4");moment = np.zeros((*density.shape, 3), dtype="<f4")
        density[1, 1, 1], density[2, 1, 1] = 1., 3.
        moment[1, 1, 1] = .25;moment[2, 1, 1] = 2.25
        field, _, _ = VOLUME.pack_textures(density, moment, np.zeros(3), .25)
        packed = np.frombuffer(field, dtype="<f2").reshape(3, 3, 4, 4).astype(float)
        sample = .5*(packed[1, 1, 1]+packed[1, 1, 2])
        np.testing.assert_array_equal(sample[:3]/sample[3], [.625]*3)
        self.assertNotEqual(float(sample[0]/sample[3]), .5, "Averaging pigment before density would be wrong")

    def test_analytic_beer_lambert_scale_and_own_canopy_escape(self):
        density = np.zeros((3, 3, 3), dtype="<f4");density[1, 1, 1] = 2.
        moment = np.repeat((density*.25)[..., None], 3, axis=3).astype("<f4")
        field, exposure, _ = VOLUME.pack_textures(density, moment, np.zeros(3), .5)
        values = np.frombuffer(field, dtype="<f2").reshape(3, 3, 3, 4)
        rho = float(values[1, 1, 1, 3]);path = .75
        expected_alpha = 1-math.exp(-.5*2.*path)
        self.assertAlmostEqual(1-math.exp(-VOLUME.EXTINCTION*rho*path), expected_alpha)
        for scale in (.5, 2., 4.):
            self.assertAlmostEqual(1-math.exp(-VOLUME.EXTINCTION*(rho/scale)*(path*scale)), expected_alpha)
        # At the occupied cell centre each of the five rays sees half0.5m:
        # tau=.5 projection *2m2/m3 *.25m=.25; equal escape on everyray.
        expected_byte = round(math.exp(-.25)*255)
        self.assertEqual(exposure[(1*3+1)*3+1], expected_byte)
        empty = np.zeros((3, 3, 3), dtype="<f4")
        _, sky, _ = VOLUME.pack_textures(empty, np.zeros((*empty.shape, 3), dtype="<f4"), np.zeros(3), .5)
        self.assertEqual(sky, bytes([255])*27)

    def test_unsafe_grid_or_missing_zero_border_fails_without_resampling(self):
        density = np.zeros((257, 2, 2), dtype="<f4")
        with self.assertRaisesRegex(ValueError, "dimensions/budget"):
            VOLUME.pack_textures(density, np.zeros((*density.shape, 3), dtype="<f4"), np.zeros(3), .25)
        density, moment = arrays();density[0, 2, 2] = 1.
        with self.assertRaisesRegex(ValueError, "zero-density border"):
            VOLUME.pack_textures(density, moment, np.zeros(3), .25)

    def test_fresh_transport_receipts_source_invariance_and_hash_rejection(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary);pack, fields, originals = native_fixture(folder);output = folder/"volumes"
            with redirect_stdout(io.StringIO()):
                manifest = VOLUME.prepare(pack, fields, output)
            self.assertEqual((manifest["format"], manifest["version"]), ("waterworld.native-forest-volume", 1))
            self.assertEqual(manifest["recipe"]["nativeGroundPlaneY"], 0)
            self.assertEqual(len(manifest["prototypes"]), 5)
            self.assertEqual(manifest["source"]["files"], {k: VOLUME.receipt(v) for k, v in originals.items()})
            for name, item in manifest["files"].items():
                encoded = (output/item["gzip"]["file"]).read_bytes();decoded = gzip.decompress(encoded)
                self.assertFalse((output/name).exists())
                self.assertEqual(VOLUME.receipt(encoded), {k: item["gzip"][k] for k in ("bytes", "sha256")})
                self.assertEqual(VOLUME.receipt(decoded), {k: item[k] for k in ("bytes", "sha256")})
            for name, original in originals.items():
                self.assertEqual((pack/name).read_bytes(), original)
            self.assertIs(manifest["appearanceErrorSupported"], False)
            self.assertIs(manifest["qualification"]["renderedAccepted"], False)
            with self.assertRaisesRegex(ValueError, "Fresh output"):
                VOLUME.prepare(pack, fields, output)
            field = manifest["prototypes"][0]["sourceField"]["file"]
            damaged = bytearray((fields/field).read_bytes());damaged[-1] ^= 1;(fields/field).write_bytes(damaged)
            with self.assertRaisesRegex(ValueError, "receipt mismatch"):
                VOLUME.prepare(pack, fields, folder/"bad")
            self.assertFalse((folder/"bad").exists())


if __name__ == "__main__":
    unittest.main()
