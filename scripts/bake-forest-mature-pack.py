#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Bakes the Portugal forest pack directly from forestmodeler's native grower and hero meshes.

Run from the repository root with forestmodeler's own Python:

    <forestmodeler>/.venv/bin/python scripts/bake-forest-mature-pack.py \\
        --forestmodeler <a forestmodeler checkout> --work <an empty folder for the baker's own output>

Every prototype is grown by forestmodeler's ColonizingGrower at Lisbon's latitude and meshed directly
with forestmodeler's own hero wood (`plant_meshes_fast(..., lod='hero')`) and native leaf placement
(`place_leaves` + `_build_tier0_blade_meshes`) — no synthetic pruning, no glued twigs, and no fake
leaf scaling. Decimation happens ONLY afterward in `scripts/prepare-forest-continuum.mjs`.

After this, bake the derived continuum atlas:

    node scripts/prepare-forest-continuum.mjs portugal
"""
import argparse
import concurrent.futures
import dataclasses
import gzip
import hashlib
import json
import pathlib
import pickle
import shutil
import subprocess
import sys
import time

# (species, seed) — canopy ('mature') and veteran ('old') ages are pulled directly from
# forestmodeler's own `gardenplans.plan.life_stages(SPECIES[species](seed))`!
# Long-lived old-growth species (old >= 80 yr: oak 168, chestnut 218, elm 148, maple 86) use
# forestmodeler's canonical ancient-tree grower settings (`resolution=2.5, steps_per_cycle=1`,
# matching forestmodeler/scripts/render_ancient_gallery.py); shorter-lived species (birch 34,
# blueberry 25) use `resolution=1.0, steps_per_cycle=2`. All 12 prototypes use
# `native_tree_render.blade_meshes(..., individual_cutout=True, lod_tier='hero')` — 100%
# native-size individual folded leaves with zero card enlargement.
SPECIES_SEEDS = (
    ('oak', 101),
    ('chestnut', 101),
    ('maple', 101),
    ('elm', 303),
    ('birch', 202),
    ('blueberry', 303),
)
PROTOTYPE_ORDER = (
    tuple((sp, 'veteran', seed) for sp, seed in SPECIES_SEEDS)
    + tuple((sp, 'canopy', seed) for sp, seed in SPECIES_SEEDS)
)

LATITUDE = 39.0
FIELD_CELL_METRES = 0.6
MIDDLE_CELLS_IN_HEIGHT = 40
BAKER_MIDDLE_CELL_METRES = 0.15


def _grow_one_species(job):
    """Worker function for parallel ColonizingGrower execution across all 6 Portugal species."""
    source_str, species, seed, latitude = job
    if source_str not in sys.path:
        sys.path.insert(0, source_str)
    from gardenplans.grow_colonize import ColonizingGrower
    from gardenplans.light import Environment
    from gardenplans.plan import SPECIES, life_stages
    from gardenplans.scenery import _measure_grown
    from gardenplans.sky import SkyModel

    t0 = time.perf_counter()
    plan0 = SPECIES[species](seed)
    stages = dict(life_stages(plan0))
    can_age = int(round(stages['mature']))
    vet_age = int(round(stages['old']))
    res = 2.5 if vet_age >= 80 else 1.0
    spc = 1 if vet_age >= 80 else 2
    plan = dataclasses.replace(
        plan0,
        growth_cycles=vet_age,
        background_mortality=0.0,
        senescent_mortality=0.0,
    )
    grower = ColonizingGrower(
        plan,
        Environment(extinction=plan.light_extinction, sky=SkyModel(latitude=latitude)),
        checkpoints=(float(can_age), float(vet_age)),
        steps_per_cycle=spc,
        resolution=res,
    )
    grower.grow()
    h_v, c_v, d_v, _ = _measure_grown(grower, float(vet_age))
    h_c, c_c, d_c, _ = _measure_grown(grower, float(can_age))
    dt = time.perf_counter() - t0
    return (species, seed, can_age, vet_age, res, spc, plan, grower, (h_c, c_c, d_c), (h_v, c_v, d_v), dt)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def write_stream(folder, name, raw, **counts):
    packed = gzip.compress(raw, compresslevel=9, mtime=0)
    (folder / f'{name}.gz').write_bytes(packed)
    return {
        'bytes': len(raw),
        'sha256': sha256(raw),
        'gzip': {'file': f'{name}.gz', 'bytes': len(packed), 'sha256': sha256(packed)},
        **counts,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--forestmodeler', required=True, help='a forestmodeler checkout; only read')
    parser.add_argument('--work', required=True, help="a folder for the baker's own output")
    parser.add_argument('--pack', default='assets/forest-scenery/portugal', help='the pack to rewrite; its pictures and materials are kept')
    parser.add_argument('--revision', help='the forestmodeler commit, when the checkout is a copy without its history')
    args = parser.parse_args()
    source = pathlib.Path(args.forestmodeler).resolve()
    work = pathlib.Path(args.work).resolve()
    pack = pathlib.Path(args.pack).resolve()
    sys.path.insert(0, str(source))
    sys.path.insert(0, str(source / 'scripts'))

    import numpy as np
    import gardenplans
    if not str(pathlib.Path(gardenplans.__file__).resolve()).startswith(str(source)):
        raise SystemExit(f'gardenplans was loaded from {gardenplans.__file__}, not from {source}')
    from gardenplans import tiered_forest as tf
    from gardenplans.grow_colonize import ColonizingGrower
    from gardenplans.light import Environment
    from gardenplans.organs import place_leaves as native_place_leaves
    from gardenplans.plan import SPECIES
    from gardenplans.scenery import _measure_grown
    from gardenplans.sky import SkyModel
    from native_tree_render import blade_meshes as native_blade_meshes
    from scripts import bake_tiered_forest as baker_cli

    before = json.loads((pack / 'manifest.json').read_text())
    if [(p['species'], p['cohort']) for p in before['prototypes']] != [(s[0], s[1]) for s in PROTOTYPE_ORDER]:
        raise SystemExit('The pack does not hold these prototypes in this order')

    work.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    # Grow all 6 species in parallel using forestmodeler's own life_stages(plan) mature & old ages
    # (cached to work/grown_species.pkl so subsequent runs skip the 6-minute growth phase).
    cache_pkl = work / 'grown_species.pkl'
    grown_by_species = {}
    if cache_pkl.exists():
        grown_by_species = pickle.loads(cache_pkl.read_bytes())
        print(f'loaded cached grown skeletons from {cache_pkl}', flush=True)
    else:
        jobs = [(str(source), sp, seed, LATITUDE) for sp, seed in SPECIES_SEEDS]
        with concurrent.futures.ProcessPoolExecutor(max_workers=len(jobs)) as pool:
            for species, seed, can_age, vet_age, res, spc, plan, grower, m_c, m_v, dt in pool.map(_grow_one_species, jobs):
                grown_by_species[species] = (can_age, vet_age, res, spc, plan, grower)
                h_c, c_c, _d_c = m_c
                h_v, c_v, d_v = m_v
                print(
                    f'{species:9s} res={res} spc={spc}  '
                    f'canopy {can_age:3d}yr ({h_c:4.1f}m, {c_c:4.1f}m r)  '
                    f'veteran {vet_age:3d}yr ({h_v:4.1f}m, {c_v:4.1f}m r, {d_v:5.1f}cm dbh)  '
                    f'({dt:.1f} s)',
                    flush=True,
                )
        cache_pkl.write_bytes(pickle.dumps(grown_by_species))

    grown, grower_of_skel, record = [], {}, []
    for index, (species, cohort, seed) in enumerate(PROTOTYPE_ORDER):
        can_age, vet_age, res, spc, plan, grower = grown_by_species[species]
        age = vet_age if cohort == 'veteran' else can_age
        height, crown, dbh, basal = _measure_grown(grower, float(age))
        grown.append((index, species, cohort, float(age), plan, grower))
        grower_of_skel[id(grower.skeleton)] = grower
        record.append({
            'id': index,
            'species': species,
            'cohort': cohort,
            'age': age,
            'seed': seed,
            'resolution': res,
            'stepsPerCycle': spc,
            'basalRadius': round(float(basal), 4),
        })

    def grown_prototypes(species_order, *, cohorts, **_):
        wanted = [(species, cohort) for cohort in cohorts for species in species_order]
        if wanted != [(s[0], s[1]) for s in PROTOTYPE_ORDER]:
            raise SystemExit(f'The stand asks for {wanted}')
        return grown

    accel = tf._get_bake_accel()
    real_meshes = accel.plant_meshes_fast if accel is not None else tf.plant_meshes

    # Use forestmodeler's REAL hero wood mesher directly (only omitting underground ±30m subterranean root networks
    # so prototype bounding spheres stay accurate to above-ground trunks and crowns).
    def native_hero_meshes(grower, age, **options):
        return real_meshes(grower, float(age), roots=False, leaves=False, lod='hero', separate_wounds=True)

    # Pass grower.env into forestmodeler's real place_leaves so sun/shade leaf plasticity is active.
    def native_env_leaves(skel, age, plan, **options):
        g = grower_of_skel.get(id(skel))
        return native_place_leaves(skel, float(age), plan, env=g.env if g is not None else options.get('env'))

    # Use forestmodeler's REAL native_tree_render.blade_meshes at 1:1 native single-leaf scale (cluster=1.0):
    # each veteran oak/chestnut/elm already carries 200k–408k real individual folded leaves (~12.3M total verts
    # across all 12 prototypes, safely within the continuum's 16.77M float-indexable vertex address space).
    def native_hero_blades(organs, plan, cluster, **_):
        meshes, _audit = native_blade_meshes(
            organs, plan, 1.0, max_triangles=20_000_000, individual_cutout=True, lod_tier='hero'
        )
        return meshes

    merged_by_cell = tf._simplify_wood_indices_by_cell

    def merged_for_height(wood_vertices, wood_indices, cell_m):
        reach = float(np.asarray(wood_vertices)[:, 1].max())
        return merged_by_cell(wood_vertices, wood_indices, cell_m * max(1.0, reach / MIDDLE_CELLS_IN_HEIGHT / BAKER_MIDDLE_CELL_METRES))

    from gardenplans import foliage_fields as ff
    ff.MAX_PATCHES = 200_000_000
    ff.MAX_VOXELS = 24_000_000
    orig_build_fields = tf.build_fields

    def wide_build_fields(*a, **kw):
        kw['max_patches'] = ff.MAX_PATCHES
        kw['max_voxels'] = ff.MAX_VOXELS
        kw['quadrature_edge_metres'] = 0.5
        return orig_build_fields(*a, **kw)

    meshes_module, meshes_name = (accel, 'plant_meshes_fast') if accel is not None else (tf, 'plant_meshes')
    tf._grow_prototype_cohorts = grown_prototypes
    tf._simplify_wood_indices_by_cell = merged_for_height
    tf.build_fields = wide_build_fields
    setattr(meshes_module, meshes_name, native_hero_meshes)
    tf.place_leaves = native_env_leaves
    tf._build_tier0_blade_meshes = native_hero_blades
    tf._load_cooked_species_maps = lambda species: (None, None)
    tf.write_glb = lambda layers, path, **_: pathlib.Path(path)

    clock = time.perf_counter()
    result = tf.bake_tiered_forest(
        baker_cli._build_subtropical_island_field(), work, stand='portugal', stem='portugal_forest', n_stems=24, seed=42,
        prototype_age=60.0, veteran_age=168.0, growth_mode='isolated', cohorts=('veteran', 'canopy'), resolution=2.5,
        field_cell_m=FIELD_CELL_METRES, latitude=LATITUDE,
    )
    print(f'baked in {time.perf_counter() - clock:.0f} s', flush=True)

    baked = result['forest_instances_manifest']
    fold = np.array([0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2], dtype=np.uint32)
    vertices, indices, prototypes, vertex_at, index_at = [], [], [], 0, 0
    for entry, made, was, spec in zip(baked['prototypes'], result['prototypes'], before['prototypes'], record):
        leaves = made['leaf_verts_56'].reshape(-1, 6, 14)
        folded = made['leaf_indices_local'].reshape(-1, 12)
        if not np.array_equal(folded, fold[None, :] + (np.arange(len(leaves), dtype=np.uint32) * 6)[:, None]):
            raise SystemExit(f'{entry["species"]}: leaf indices do not match expected 6-vertex V-folded layout')
        parts = [
            (made['wood_verts_56'], made['wood_indices_local']),
            (made['leaf_verts_56'], made['leaf_indices_local']),
            (made['far_verts_56'], made['far_indices_local']),
        ]
        ranges = {}
        for key, (part_vertices, part_indices) in zip(('wood', 'leaf', 'far'), parts):
            vertices.append(part_vertices.astype('<f4'))
            indices.append(part_indices.astype('<u4') + np.uint32(vertex_at))
            ranges[key] = {'firstIndex': index_at, 'indexCount': int(len(part_indices))}
            vertex_at += len(part_vertices)
            index_at += len(part_indices)
        points = np.vstack([p[0][:, :3] for p in parts]).astype(np.float64)
        low, high = points.min(axis=0), points.max(axis=0)
        centre = 0.5 * (low + high)
        box = np.array([[high[k] if bits & (1 << k) else low[k] for k in range(3)] for bits in range(8)])
        prototypes.append({
            **{key: entry[key] for key in ('id', 'species', 'cohort', 'age', 'heightMetres', 'crownRadiusMetres', 'crownBaseMetres', 'dbhCentimetres')},
            'low': [round(float(v), 4) for v in low],
            'high': [round(float(v), 4) for v in high],
            'centre': [round(float(v), 4) for v in centre],
            'radius': round(float(np.linalg.norm(box - centre, axis=1).max()) + 1e-3, 4),
            'firstRoot': entry['firstRoot'],
            'rootCount': entry['rootCount'],
            **ranges,
            'nativeMaterials': was['nativeMaterials'],
            'geometryErrorSupported': False,
            'unverifiedGeometryErrorMetres': entry['unverifiedGeometryErrorMetres'],
            'crownRadius': entry['crownRadiusMetres'],
            'basalRadius': spec['basalRadius'],
        })
        spec.update({
            'heightMetres': entry['heightMetres'],
            'crownRadiusMetres': entry['crownRadiusMetres'],
            'crownBaseMetres': entry['crownBaseMetres'],
            'dbhCentimetres': entry['dbhCentimetres'],
            'woodTriangles': ranges['wood']['indexCount'] // 3,
            'leafTriangles': ranges['leaf']['indexCount'] // 3,
        })

    vertex_bytes, index_bytes = np.vstack(vertices).tobytes(), np.concatenate(indices).tobytes()
    roots = np.frombuffer((work / 'roots.bin').read_bytes(), dtype='<f4').reshape(-1, 12)
    roots = roots[np.argsort(roots[:, 8], kind='stable')]
    files = {
        'vertices.bin': write_stream(pack, 'vertices.bin', vertex_bytes, vertexCount=vertex_at),
        'indices.bin': write_stream(pack, 'indices.bin', index_bytes, indexCount=index_at),
        'roots.bin': write_stream(pack, 'roots.bin', roots.tobytes(), rootCount=baked['rootCount']),
    }

    roots_as_baked, roots_as_kept = sha256((work / 'roots.bin').read_bytes()).encode(), files['roots.bin']['sha256'].encode()
    receipts = {}
    for folder, own, streams in (
        ('middle', 'middle-manifest.json', ['middle-vertices.bin.gz', 'middle-indices.bin.gz']),
        ('volumes', 'volumes-manifest.json', [
            f'prototype-{p["id"]}-{p["species"]}-{p["cohort"]}/{name}'
            for p in prototypes for name in ('field.rgba16f.bin.gz', 'exposure.r8.bin.gz')
        ]),
    ):
        for name in streams:
            (pack / folder / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(work / folder / name, pack / folder / name)
        raw = (work / folder / own).read_bytes()
        if raw.count(roots_as_baked) != 1:
            raise SystemExit(f"{folder}: its manifest does not name the baker's roots once")
        raw = raw.replace(roots_as_baked, roots_as_kept)
        (pack / folder / 'manifest.json').write_bytes(raw)
        receipts[folder] = {'file': f'{folder}/manifest.json', 'bytes': len(raw), 'sha256': sha256(raw)}

    revision = args.revision or subprocess.run(['git', '-C', str(source), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip() or None
    manifest = {
        **{key: baked[key] for key in ('format', 'version', 'materialContract', 'units', 'upAxis', 'vertexStride', 'rootStride', 'rootCount', 'appearanceErrorSupported', 'coverage')},
        'stature': 'full-grown',
        'files': files,
        'prototypes': prototypes,
        'volume': receipts['volumes'],
        'middle': receipts['middle'],
        'bake': {
            'script': 'scripts/bake-forest-mature-pack.py',
            'forestmodeler': revision,
            'growth': 'native forestmodeler ColonizingGrower at life_stages() mature/old ages (res=2.5/spc=1 for >=80yr, res=1.0/spc=2 for <80yr) + hero wood + native_tree_render.blade_meshes (1:1 native leaves, zero card enlargement)',
            'latitudeDegrees': LATITUDE,
            'fieldCellMetres': FIELD_CELL_METRES,
            'middleCellsInHeight': MIDDLE_CELLS_IN_HEIGHT,
            'prototypes': record,
        },
    }
    (pack / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for spec in record:
        print(json.dumps(spec))
    print(
        f'{vertex_at} vertices, {index_at // 3} triangles; vertices.bin.gz {files["vertices.bin"]["gzip"]["bytes"]} bytes, '
        f'indices.bin.gz {files["indices.bin"]["gzip"]["bytes"]} bytes; {time.perf_counter() - started:.0f} s in all',
    )


if __name__ == '__main__':
    main()
