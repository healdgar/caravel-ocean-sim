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

# (species, seed, open_age, grove_age) — ALL 12 prototypes are grown at true `resolution=1.0, steps_per_cycle=2`:
#   * `veteran` (0..5): stand-alone open-grown specimens (grown alone in full sky at res=1.0 so natural open-grown
#     self-pruning and fine shoot branching develop cleanly without coarse res=2.5 artifacts).
#   * `canopy` (6..11): competitive intermixed grove/copse stand (grown together in lockstep sharing one
#     SiteShadowGrid + SiteSoilField with `share_light=True` at res=1.0 so mixed species genuinely compete for light
#     and soil, self-pruning shaded lower limbs into real woodland trunks).
SPECIES_SPECS = (
    ('oak', 101, 60, 60),
    ('chestnut', 101, 68, 65),
    ('maple', 101, 48, 48),
    ('elm', 303, 62, 60),
    ('birch', 202, 34, 28),
    ('blueberry', 303, 25, 18),
)
SPECIES_SEEDS = tuple((sp, seed) for sp, seed, _, _ in SPECIES_SPECS)
PROTOTYPE_ORDER = (
    tuple((sp, 'veteran', seed) for sp, seed in SPECIES_SEEDS)
    + tuple((sp, 'canopy', seed) for sp, seed in SPECIES_SEEDS)
)

LATITUDE = 39.0
GROVE_SPACING_METRES = 5.4
FIELD_CELL_METRES = 0.6
MIDDLE_CELLS_IN_HEIGHT = 40
BAKER_MIDDLE_CELL_METRES = 0.15


def _grow_open_specimen(job):
    """Worker function for parallel resolution=1.0 open-grown stand-alone ColonizingGrower execution."""
    source_str, species, seed, age_yr, latitude = job
    if source_str not in sys.path:
        sys.path.insert(0, source_str)
    from gardenplans.grow_colonize import ColonizingGrower
    from gardenplans.light import Environment
    from gardenplans.plan import SPECIES
    from gardenplans.scenery import _measure_grown
    from gardenplans.sky import SkyModel

    t0 = time.perf_counter()
    plan = dataclasses.replace(
        SPECIES[species](seed),
        growth_cycles=age_yr,
        background_mortality=0.0,
        senescent_mortality=0.0,
    )
    grower = ColonizingGrower(
        plan,
        Environment(extinction=plan.light_extinction, sky=SkyModel(latitude=latitude)),
        checkpoints=(float(age_yr),),
        steps_per_cycle=2,
        resolution=1.0,
    )
    grower.grow()
    h, cr, dbh, basal = _measure_grown(grower, float(age_yr))
    dt = time.perf_counter() - t0
    return (species, seed, age_yr, plan, grower, (h, cr, dbh, basal), dt)


def _grow_gap_pioneer_stand(source_str, latitude):
    """Grow shade-intolerant pioneer birch & understory blueberry in a sunlit gap competing side-by-side at res=1.0."""
    if source_str not in sys.path:
        sys.path.insert(0, source_str)
    import numpy as np
    from gardenplans import tiered_forest as tf
    from gardenplans.grow_colonize import ColonizingGrower
    from gardenplans.light import Environment
    from gardenplans.plan import SPECIES
    from gardenplans.scenery import _measure_grown
    from gardenplans.site_fields import SiteShadowGrid, SiteSoilField
    from gardenplans.sky import SkyModel

    t0 = time.perf_counter()
    sky = SkyModel(latitude=latitude)
    sh, cl, so = SiteShadowGrid(), {}, SiteSoilField()
    members = [
        ('birch_nb', 'birch', 611, 28, (0.0, 0.0)),
        ('birch', 'birch', 719, 28, (3.2, 0.0)),
        ('oak_nb', 'oak', 821, 28, (-2.8, 2.4)),
        ('blueberry', 'blueberry', 712, 22, (1.4, -2.2)),
    ]
    k_ext = float(np.mean([SPECIES[sp](1).light_extinction for _, sp, _, _, _ in members]))
    entries = []
    for tag, sp, sd, age, pos in members:
        plan = dataclasses.replace(SPECIES[sp](sd), growth_cycles=age, background_mortality=0.0, senescent_mortality=0.0)
        env = Environment(extinction=k_ext, sky=sky)
        env.shadow = sh
        env.claims = cl
        env.soil = so
        g = ColonizingGrower(plan, env, checkpoints=(float(age),), steps_per_cycle=2, resolution=1.0, origin=pos, share_light=True)
        entries.append((tag, sp, sd, age, plan, g, g.steps()))
    done = [False] * len(entries)
    for _yr in range(28):
        for i, e in enumerate(entries):
            if done[i]:
                continue
            try:
                next(e[6])
            except StopIteration:
                done[i] = True
        sh.reset()
        cl.clear()
        so.reset()
        for e in entries:
            e[5].flush_foliage()
        for e in entries:
            e[5].claim_soil()
        for e in entries:
            e[5].read_soil()
    out = {}
    for tag, sp, sd, age, plan, g, it in entries:
        for _ in it:
            pass
        if tag in ('birch', 'blueberry'):
            tf._recenter_grower_to_local_origin(g)
            h, cr, dbh, basal = _measure_grown(g, float(age))
            out[sp] = (sd, age, plan, g, (h, cr, dbh, basal))
    print(f'  competitive gap pioneer stand finished in {time.perf_counter() - t0:.1f} s', flush=True)
    return out


def _grow_competitive_grove(source_str, specs, latitude):
    """Grow Portugal canopy species in lockstep inside one shared SiteShadowGrid + SiteSoilField at resolution=1.0."""
    if source_str not in sys.path:
        sys.path.insert(0, source_str)
    import math
    import numpy as np
    from gardenplans import tiered_forest as tf
    from gardenplans.grow_colonize import ColonizingGrower
    from gardenplans.light import Environment
    from gardenplans.plan import SPECIES
    from gardenplans.scenery import _measure_grown
    from gardenplans.site_fields import SiteShadowGrid, SiteSoilField
    from gardenplans.sky import SkyModel

    t0 = time.perf_counter()
    sky_model = SkyModel(latitude=latitude)
    canopy_specs = [s for s in specs if s[0] not in ('birch', 'blueberry')]
    k_ext = float(np.mean([SPECIES[sp](1).light_extinction for sp, _, _, _ in canopy_specs]))
    shared_shadow = SiteShadowGrid()
    shared_claims = {}
    shared_soil = SiteSoilField()

    # Arrange the 4 canopy trees on a tight intermixed competitive ring (GROVE_SPACING_METRES apart)
    # so oak, chestnut, maple, and elm genuinely compete for sky and soil.
    n_can = len(canopy_specs)
    r_can = GROVE_SPACING_METRES / (2.0 * math.sin(math.pi / max(n_can, 2)))
    places = {}
    for idx, (sp, _, _, _) in enumerate(canopy_specs):
        ang = math.radians(45.0) + idx * (2.0 * math.pi / n_can)
        places[sp] = (r_can * math.cos(ang), r_can * math.sin(ang))

    max_years = max(grove_age for _, _, _, grove_age in canopy_specs)
    entries = []
    for sp, seed, _, grove_age in canopy_specs:
        # Distinct seed from open specimen so grove & open trees have independent branch geometry
        g_seed = seed + 409
        start_yr = max(0, max_years - grove_age)
        plan = dataclasses.replace(
            SPECIES[sp](g_seed),
            growth_cycles=grove_age,
            background_mortality=0.0,
            senescent_mortality=0.0,
        )
        env = Environment(extinction=k_ext, sky=sky_model)
        env.shadow = shared_shadow
        env.claims = shared_claims
        env.soil = shared_soil
        g = ColonizingGrower(
            plan,
            env,
            checkpoints=(float(grove_age),),
            steps_per_cycle=2,
            resolution=1.0,
            origin=places[sp],
            share_light=True,
        )
        entries.append((sp, g_seed, grove_age, start_yr, plan, g, g.steps()))

    done = [False] * len(entries)
    for yr in range(max_years):
        for idx, (sp, _, _, start_yr, _, _, it) in enumerate(entries):
            if yr < start_yr or done[idx]:
                continue
            try:
                next(it)
            except StopIteration:
                done[idx] = True
        shared_shadow.reset()
        shared_claims.clear()
        shared_soil.reset()
        active = [idx for idx, e in enumerate(entries) if yr >= e[3]]
        for idx in active:
            entries[idx][5].flush_foliage()
        for idx in active:
            entries[idx][5].claim_soil()
        for idx in active:
            entries[idx][5].read_soil()
        if (yr + 1) % 10 == 0 or yr + 1 == max_years:
            print(f'  competitive grove year {yr + 1:2d}/{max_years} ({time.perf_counter() - t0:.1f} s)', flush=True)

    out = {}
    for sp, g_seed, grove_age, _, plan, g, it in entries:
        for _ in it:
            pass
        tf._recenter_grower_to_local_origin(g)
        h, cr, dbh, basal = _measure_grown(g, float(grove_age))
        out[sp] = (g_seed, grove_age, plan, g, (h, cr, dbh, basal))
    print(f'  competitive canopy grove finished in {time.perf_counter() - t0:.1f} s', flush=True)
    # Pioneer birch & understory blueberry grow in a sunlit competitive gap rather than deep 37yr closed oak shade.
    out.update(_grow_gap_pioneer_stand(source_str, latitude))
    return out


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

    # Grow Track A (6 open-grown stand-alone trees in parallel at res=1.0, spc=2) AND Track B (1 competitive
    # intermixed 6-species grove sharing SiteShadowGrid + SiteSoilField at res=1.0, spc=2) concurrently!
    cache_pkl = work / 'grown_res1_open_and_grove.pkl'
    open_by_species, grove_by_species = {}, {}
    if cache_pkl.exists():
        open_by_species, grove_by_species = pickle.loads(cache_pkl.read_bytes())
        print(f'loaded cached res=1.0 open + competitive grove skeletons from {cache_pkl}', flush=True)
    else:
        open_jobs = [(str(source), sp, seed, open_age, LATITUDE) for sp, seed, open_age, _ in SPECIES_SPECS]
        with concurrent.futures.ProcessPoolExecutor(max_workers=len(open_jobs) + 1) as pool:
            grove_fut = pool.submit(_grow_competitive_grove, str(source), SPECIES_SPECS, LATITUDE)
            open_futs = [pool.submit(_grow_open_specimen, job) for job in open_jobs]
            for fut in open_futs:
                species, seed, age_yr, plan, grower, (h, cr, dbh, basal), dt = fut.result()
                open_by_species[species] = (seed, age_yr, plan, grower, (h, cr, dbh, basal))
                print(
                    f'OPEN   {species:9s} res=1.0 spc=2 {age_yr:2d}yr  '
                    f'H={h:5.2f}m  crownR={cr:5.2f}m  dbh={dbh:5.1f}cm  ({dt:.1f} s)',
                    flush=True,
                )
            grove_by_species = grove_fut.result()
            for sp, _, _, _ in SPECIES_SPECS:
                g_seed, grove_age, _, _, (h, cr, dbh, _) = grove_by_species[sp]
                print(
                    f'GROVE  {sp:9s} res=1.0 spc=2 {grove_age:2d}yr  '
                    f'H={h:5.2f}m  crownR={cr:5.2f}m  dbh={dbh:5.1f}cm  (competitive intermixed)',
                    flush=True,
                )
        cache_pkl.write_bytes(pickle.dumps((open_by_species, grove_by_species)))

    grown, grower_of_skel, record = [], {}, []
    for index, (species, cohort, _seed) in enumerate(PROTOTYPE_ORDER):
        if cohort == 'veteran':
            seed, age, plan, grower, (_, _, _, basal) = open_by_species[species]
            mode_tag = 'open-grown'
        else:
            seed, age, plan, grower, (_, _, _, basal) = grove_by_species[species]
            mode_tag = 'competitive-grove'
        grown.append((index, species, cohort, float(age), plan, grower))
        grower_of_skel[id(grower.skeleton)] = grower
        record.append({
            'id': index,
            'species': species,
            'cohort': cohort,
            'growthMode': mode_tag,
            'age': age,
            'seed': seed,
            'resolution': 1.0,
            'stepsPerCycle': 2,
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
        prototype_age=60.0, veteran_age=65.0, growth_mode='dense_interspecies', cohorts=('veteran', 'canopy'), resolution=1.0,
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
            'growth': 'native forestmodeler ColonizingGrower at resolution=1.0, steps_per_cycle=2: open-grown stand-alone trees (veteran) + lockstep intermixed competitive stand sharing SiteShadowGrid & SiteSoilField (canopy) + hero wood + native_tree_render.blade_meshes',
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
