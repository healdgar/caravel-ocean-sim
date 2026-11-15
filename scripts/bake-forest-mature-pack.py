#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Bakes the Portugal forest pack from full-grown trees, each at the size it stands.

Run from the repository root with forestmodeler's own Python:

    <forestmodeler>/.venv/bin/python scripts/bake-forest-mature-pack.py \\
        --forestmodeler <a forestmodeler checkout> --work <an empty folder for the baker's own output>

(add --revision <commit> when the checkout is an archive copy, so the manifest can name what grew the trees)

Every prototype is one tree grown alone, in the open, to the age PROTOTYPES names for it, by forestmodeler's
colonising grower at Lisbon's latitude. forestmodeler's tiered-forest baker (gardenplans/tiered_forest.py)
then meshes it and writes the pack. Five of the baker's own choices do not suit a tree of a hundred years,
and this script replaces them:

  growth   Asked for a veteran of sixty years or more, the baker grows a tree for at most 48 or 94 years at a
           coarse resolution and thickens its trunk to stand for the rest. Here each tree is grown for every
           year of its age.
  wood     Each tree receives cylindrical multi-sided bark rings (radial_base 10-12, radial_min 5,
           radial_error 0.010) and organic curve preservation (WOOD_STRAIGHTEN = 0.20 rad) with generous
           level-0 triangle budgets (PROTOTYPES) so close-up trunks, forks, and 3rd/4th-order branchlets
           render round and gnarled while distant trees select coarser GPU cluster cuts.
  leaves   Each tree distributes compact (~0.38-0.46 m), 3D V-cambered and gravitationally drooped 4-triangle
           (6-vertex) botanical shoots across its branchlet tips, sized so their combined spray coverage
           conserves physical crown Leaf Area Index. Draw the 512x512 sprays with
           scripts/prepare-forest-sprays.py before this bake.
  middle   The baker thins a tree's wood for its middle tier by merging the vertices that share a cell of
           0.15 m. Here the cells grow with the tree (MIDDLE_CELLS_IN_HEIGHT).
  bark     The baker's cooked bark maps come with texture coordinates scaled for a square tile. The pack
           keeps the bark and leaf pictures it already has, which are drawn with the unscaled coordinates.

The pack keeps its layout: the same twelve prototypes in the same order, the same pictures and materials,
6-vertex 4-triangle V-cambered leaf shoots, `middle/` and `volumes/` beside it. Its manifest gains
`stature: "full-grown"`, which tells the game to draw these trees at about the size they are (js/terrain.js),
and `bake`, which records what was grown. After this, bake the derived sets in order:

    python3 scripts/prepare-forest-surfaces.py portugal --builtin --reuse saba
    node scripts/prepare-forest-clusters.mjs portugal
    node scripts/prepare-forest-crowns.mjs portugal
    node scripts/prepare-forest-groves.mjs portugal

and name the new vertices.bin, indices.bin and roots.bin (their sha256 in the manifest's `files`) in
CERTIFIED_FOREST_STREAM_SHAS of js/forest-scenery.js, once the pack has loaded in the game without them: a
stream not named there is checked vertex by vertex each time it loads.
"""
import argparse
import dataclasses
import gzip
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import time

# species, cohort, age in years, seed, grower resolution, wood triangles, leaf shoots, shoot area over crown footprint.
# Only close-up trees (~8-35 m) draw level-0 clusters; mid/far trees select coarser GPU DAG cuts, morph crowns, and splats.
PROTOTYPES = (
    ('oak', 'veteran', 110, 101, 3.0, 34000, 24000, 9.2),
    ('chestnut', 'veteran', 110, 101, 3.0, 34000, 22000, 8.6),
    ('maple', 'veteran', 100, 101, 3.0, 34000, 24500, 9.0),
    ('elm', 'veteran', 110, 303, 3.0, 34000, 28500, 7.8),
    ('birch', 'veteran', 40, 202, 1.8, 10000, 6800, 8.5),
    ('blueberry', 'veteran', 25, 303, 1.8, 4800, 1500, 10.0),
    ('oak', 'canopy', 70, 202, 3.0, 22000, 14000, 9.2),
    ('chestnut', 'canopy', 70, 202, 3.0, 22000, 13500, 8.6),
    ('maple', 'canopy', 60, 202, 3.0, 22000, 15000, 9.0),
    ('elm', 'canopy', 70, 202, 3.0, 22000, 15000, 7.8),
    ('birch', 'canopy', 25, 101, 1.8, 7500, 4800, 8.5),
    ('blueberry', 'canopy', 12, 202, 1.8, 2400, 500, 10.0),
)
# The species whose shoots show a botanical spray of leaves, and the aspect ratio (length / breadth) matching prepare-forest-sprays.py.
SPRAYED = frozenset(('oak', 'chestnut', 'maple', 'elm', 'birch'))
SPRAY_ASPECT = 1.25
LATITUDE = 39.0
# A crown's foliage field and far shell are kept at this cell: a crown 26 m across then takes about as many
# cells as the 10 m crowns of the pack before took at 0.3 m.
FIELD_CELL_METRES = 0.6
# Limbs straighter than this many radians (~11.5 deg) between rings share one ring; preserves organic bough curves.
WOOD_STRAIGHTEN = 0.20
# The middle tier's wood is merged by cells of which this many stand in the height the tree's wood reaches,
# where that is coarser than the baker's own cell.
MIDDLE_CELLS_IN_HEIGHT = 40
BAKER_MIDDLE_CELL_METRES = 0.15


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def write_stream(folder, name, raw, **counts):
    packed = gzip.compress(raw, compresslevel=9, mtime=0)
    (folder / f'{name}.gz').write_bytes(packed)
    return {'bytes': len(raw), 'sha256': sha256(raw), 'gzip': {'file': f'{name}.gz', 'bytes': len(packed), 'sha256': sha256(packed)}, **counts}


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

    import numpy as np
    import gardenplans
    if not str(pathlib.Path(gardenplans.__file__).resolve()).startswith(str(source)):
        raise SystemExit(f'gardenplans was loaded from {gardenplans.__file__}, not from {source}')
    from gardenplans import tiered_forest as tf
    from gardenplans.grow_colonize import ColonizingGrower
    from gardenplans.light import Environment
    from gardenplans.lod import TIERS
    from gardenplans.mesh import Tessellation
    from gardenplans.plan import SPECIES
    from gardenplans.scenery import _measure_grown
    from gardenplans.sky import SkyModel
    from scripts import bake_tiered_forest as baker_cli

    before = json.loads((pack / 'manifest.json').read_text())
    if [(p['species'], p['cohort']) for p in before['prototypes']] != [(s[0], s[1]) for s in PROTOTYPES]:
        raise SystemExit('The pack does not hold these prototypes in this order')
    work.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    # Grow every tree alone, for every year of its age, with round cylindrical bark rings and fine branchlets.
    rings_veteran = Tessellation(radial_base=12, radial_falloff=0.72, radial_min=5, radial_error=0.010, radial_max=16)
    rings_canopy = Tessellation(radial_base=10, radial_falloff=0.72, radial_min=5, radial_error=0.010, radial_max=14)
    grown, tier_of, spec_of, record = [], {}, {}, []
    for index, (species, cohort, age, seed, resolution, wood, cards, cover) in enumerate(PROTOTYPES):
        clock = time.perf_counter()
        plan = dataclasses.replace(SPECIES[species](seed), growth_cycles=age, background_mortality=0.0, senescent_mortality=0.0)
        grower = ColonizingGrower(plan, Environment(extinction=plan.light_extinction, sky=SkyModel(latitude=LATITUDE)),
                                  checkpoints=(float(age),), resolution=resolution, steps_per_cycle=2)
        grower.grow()
        height, crown, dbh, basal = _measure_grown(grower, float(age))
        grown.append((index, species, cohort, float(age), plan, grower))
        rings = rings_veteran if cohort == 'veteran' else rings_canopy
        tier_of[id(grower)] = dataclasses.replace(TIERS['game'], tess=rings, straighten=WOOD_STRAIGHTEN, budget=wood)
        spec_of[id(plan)] = {'cards': cards, 'cover': cover, 'index': index}
        record.append({'id': index, 'species': species, 'cohort': cohort, 'age': age, 'seed': seed, 'resolution': resolution,
                       'woodTriangleBudget': wood, 'leafCards': cards, 'cardAreaOverFootprint': cover,
                       'growSeconds': round(time.perf_counter() - clock, 1), 'basalRadius': round(float(basal), 3)})
        print(f'grew {species} {cohort}: {age} years, seed {seed}: {height:.1f} m tall, crown radius {crown:.1f} m, '
              f'{dbh:.0f} cm through, {int(grower.skeleton.alive_mask(float(age)).sum())} live nodes, {record[-1]["growSeconds"]} s', flush=True)

    def grown_prototypes(species_order, *, cohorts, **_):
        wanted = [(species, cohort) for cohort in cohorts for species in species_order]
        if wanted != [(s[0], s[1]) for s in PROTOTYPES]:
            raise SystemExit(f'The stand asks for {wanted}')
        return grown

    # Wood: each tree's own budget, whichever mesher the baker picks.
    accel = tf._get_bake_accel()
    meshes_module, meshes_name = (accel, 'plant_meshes_fast') if accel is not None else (tf, 'plant_meshes')
    plant_meshes = getattr(meshes_module, meshes_name)

    def budgeted_meshes(grower, age, **options):
        options['lod'] = tier_of[id(grower)]
        shoot, roots, foliage, wounds = plant_meshes(grower, age, **options)
        record[[g[5] for g in grown].index(grower)]['woodStraighten'] = round(float(getattr(shoot, 'straighten', 0.0)), 3)
        return shoot, roots, foliage, wounds

    # Leaves: compact 3D V-cambered and gravitationally drooped botanical shoots anchored on branchlet tips.
    blade_meshes = tf._build_tier0_blade_meshes

    def carded_blades(organs, plan, cluster, **_):
        spec = spec_of[id(plan)]
        counts = np.bincount(organs.archetype, minlength=len(plan.leaves))
        meshes = {}
        for kind, count in enumerate(counts):
            if not count:
                continue
            share = int(min(count, max(1, round(spec['cards'] * count / counts.sum()))))
            meshes[f'foliage_{kind}'] = blade_meshes(organs, plan, cluster, max_blades_per_archetype=share)[f'foliage_{kind}']
        # The ground under the crown, on a grid no coarser than a metre.
        ground = np.asarray(organs.position, dtype=np.float64)[:, :2]
        centre = ground.mean(axis=0)
        reach = float(np.quantile(np.hypot(*(ground - centre).T), 0.9))
        cell = min(1.0, max(0.05, reach / 8))
        footprint = len(np.unique(np.floor((ground - centre) / cell).astype(np.int64), axis=0)) * cell * cell
        blades = {name: np.asarray(mesh.vertices, dtype=np.float64).reshape(-1, 6, 3) for name, mesh in meshes.items()}
        area = sum(float(np.linalg.norm(np.cross(b[:, 3] - b[:, 0], b[:, 2] - b[:, 0]), axis=1).sum()) for b in blades.values())
        grow = (spec['cover'] * footprint / area) ** 0.5
        fold_tris = np.array([[0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 2]], dtype=np.int64)
        sizes = []
        for name, b in blades.items():
            foot = b[:, 1:2]
            b = foot + (b - foot) * grow
            if PROTOTYPES[spec['index']][0] in SPRAYED:
                # 3D V-cambered & drooped botanical spray shoot anchored at the branchlet attachment foot (v1).
                along = b[:, 4] - b[:, 1]
                along /= np.maximum(np.linalg.norm(along, axis=1, keepdims=True), 1e-9)
                across = b[:, 2] - b[:, 0]
                across -= along * (across * along).sum(axis=1, keepdims=True)
                across /= np.maximum(np.linalg.norm(across, axis=1, keepdims=True), 1e-9)
                up_shoot = np.cross(along, across)
                up_shoot /= np.maximum(np.linalg.norm(up_shoot, axis=1, keepdims=True), 1e-9)
                flip_up = np.where(up_shoot[:, 2:3] < -0.15, -1.0, 1.0)
                camber_dir = up_shoot * flip_up
                broad = (np.linalg.norm(np.cross(b[:, 3] - b[:, 0], b[:, 2] - b[:, 0]), axis=1) / SPRAY_ASPECT) ** 0.5
                long_m = broad * SPRAY_ASPECT
                half_w = 0.5 * broad[:, None]
                v1 = b[:, 1]
                wing_near = 0.14 * broad[:, None] * camber_dir
                v0 = v1 - half_w * across + wing_near
                v2 = v1 + half_w * across + wing_near
                gravity_droop = np.zeros_like(v1)
                gravity_droop[:, 2] = -0.10 * long_m
                v4 = v1 + long_m[:, None] * along - (0.05 * long_m[:, None]) * camber_dir + gravity_droop
                wing_far = 0.17 * broad[:, None] * camber_dir
                v3 = v4 - half_w * across + wing_far
                v5 = v4 + half_w * across + wing_far
                b = np.stack([v0, v1, v2, v3, v4, v5], axis=1)
            # Recompute smooth area-weighted unit normals across the 4 non-coplanar shoot triangles.
            p0 = b[:, fold_tris[:, 0]]
            p1 = b[:, fold_tris[:, 1]]
            p2 = b[:, fold_tris[:, 2]]
            fn = np.cross(p1 - p0, p2 - p0)
            vn = np.zeros_like(b)
            for corner in range(3):
                for t_idx in range(4):
                    vn[:, fold_tris[t_idx, corner]] += fn[:, t_idx]
            vn /= np.maximum(np.linalg.norm(vn, axis=2, keepdims=True), 1e-12)
            sizes.append(np.stack([np.linalg.norm(b[:, 4] - b[:, 1], axis=1), np.linalg.norm(b[:, 2] - b[:, 0], axis=1)], axis=1))
            meshes[name] = dataclasses.replace(
                meshes[name],
                vertices=b.reshape(-1, 3).astype(np.float32),
                normals=vn.reshape(-1, 3).astype(np.float32),
            )
        sizes = np.concatenate(sizes)
        record[spec['index']].update({'crownFootprintSquareMetres': round(footprint, 1), 'cardMetres': [round(float(v), 3) for v in np.median(sizes, axis=0)],
                                      'cardsKept': int(len(sizes)), 'leavesGrown': int(counts.sum())})
        return meshes

    # Middle wood: every cell the baker merges by, made coarser by as much as the tree outgrows the baker's.
    merged_by_cell = tf._simplify_wood_indices_by_cell

    def merged_for_height(wood_vertices, wood_indices, cell_m):
        reach = float(np.asarray(wood_vertices)[:, 1].max())
        return merged_by_cell(wood_vertices, wood_indices, cell_m * max(1.0, reach / MIDDLE_CELLS_IN_HEIGHT / BAKER_MIDDLE_CELL_METRES))

    tf._grow_prototype_cohorts = grown_prototypes
    tf._simplify_wood_indices_by_cell = merged_for_height
    setattr(meshes_module, meshes_name, budgeted_meshes)
    tf._build_tier0_blade_meshes = carded_blades
    tf._load_cooked_species_maps = lambda species: (None, None)
    # The baker's merged scene files are not part of the pack.
    tf.write_glb = lambda layers, path, **_: pathlib.Path(path)

    clock = time.perf_counter()
    result = tf.bake_tiered_forest(
        baker_cli._build_subtropical_island_field(), work, stand='portugal', stem='portugal_forest', n_stems=24, seed=42,
        prototype_age=70.0, veteran_age=110.0, growth_mode='isolated', cohorts=('veteran', 'canopy'), resolution=3.0,
        field_cell_m=FIELD_CELL_METRES, latitude=LATITUDE)
    print(f'baked in {time.perf_counter() - clock:.0f} s', flush=True)

    # The pack's own streams: cylindrical multi-order wood, 6-vertex 4-triangle 3D V-cambered leaf shoots, and far crown.
    baked = result['forest_instances_manifest']
    fold = np.array([0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2], dtype=np.uint32)
    vertices, indices, prototypes, vertex_at, index_at = [], [], [], 0, 0
    for entry, made, was, spec in zip(baked['prototypes'], result['prototypes'], before['prototypes'], record):
        leaves = made['leaf_verts_56'].reshape(-1, 6, 14)
        folded = made['leaf_indices_local'].reshape(-1, 12)
        if not np.array_equal(folded, fold[None, :] + (np.arange(len(leaves), dtype=np.uint32) * 6)[:, None]):
            raise SystemExit(f'{entry["species"]}: leaf indices do not match expected 6-vertex V-folded layout')
        parts = [(made['wood_verts_56'], made['wood_indices_local']),
                 (made['leaf_verts_56'], made['leaf_indices_local']),
                 (made['far_verts_56'], made['far_indices_local'])]
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
            'low': [round(float(v), 4) for v in low], 'high': [round(float(v), 4) for v in high], 'centre': [round(float(v), 4) for v in centre],
            'radius': round(float(np.linalg.norm(box - centre, axis=1).max()) + 1e-3, 4),
            'firstRoot': entry['firstRoot'], 'rootCount': entry['rootCount'], **ranges,
            'nativeMaterials': was['nativeMaterials'],
            'geometryErrorSupported': False, 'unverifiedGeometryErrorMetres': entry['unverifiedGeometryErrorMetres'],
            'crownRadius': entry['crownRadiusMetres'], 'basalRadius': spec['basalRadius'],
        })
        spec.update({'heightMetres': entry['heightMetres'], 'crownRadiusMetres': entry['crownRadiusMetres'], 'crownBaseMetres': entry['crownBaseMetres'],
                     'dbhCentimetres': entry['dbhCentimetres'], 'woodTriangles': ranges['wood']['indexCount'] // 3, 'leafTriangles': ranges['leaf']['indexCount'] // 3})

    vertex_bytes, index_bytes = np.vstack(vertices).tobytes(), np.concatenate(indices).tobytes()
    # The baker lists its stand's trees in the order it placed them. The pack keeps each prototype's together.
    roots = np.frombuffer((work / 'roots.bin').read_bytes(), dtype='<f4').reshape(-1, 12)
    roots = roots[np.argsort(roots[:, 8], kind='stable')]
    files = {
        'vertices.bin': write_stream(pack, 'vertices.bin', vertex_bytes, vertexCount=vertex_at),
        'indices.bin': write_stream(pack, 'indices.bin', index_bytes, indexCount=index_at),
        'roots.bin': write_stream(pack, 'roots.bin', roots.tobytes(), rootCount=baked['rootCount']),
    }

    # The crown shells and foliage fields, as the baker wrote them. Each of their manifests names, by sha256,
    # the roots it was baked beside: the baker's. The pack holds the same trees in its own order, so the
    # manifest it keeps names those.
    roots_as_baked, roots_as_kept = sha256((work / 'roots.bin').read_bytes()).encode(), files['roots.bin']['sha256'].encode()
    receipts = {}
    for folder, own, streams in (('middle', 'middle-manifest.json', ['middle-vertices.bin.gz', 'middle-indices.bin.gz']),
                                 ('volumes', 'volumes-manifest.json', [f'prototype-{p["id"]}-{p["species"]}-{p["cohort"]}/{name}'
                                                                      for p in prototypes for name in ('field.rgba16f.bin.gz', 'exposure.r8.bin.gz')])):
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
        'files': files, 'prototypes': prototypes, 'volume': receipts['volumes'], 'middle': receipts['middle'],
        'bake': {'script': 'scripts/bake-forest-mature-pack.py', 'forestmodeler': revision, 'growth': 'each tree alone, every year of its age',
                 'latitudeDegrees': LATITUDE, 'fieldCellMetres': FIELD_CELL_METRES, 'middleCellsInHeight': MIDDLE_CELLS_IN_HEIGHT, 'prototypes': record},
    }
    (pack / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for spec in record:
        print(json.dumps(spec))
    print(f'{vertex_at} vertices, {index_at // 3} triangles; vertices.bin.gz {files["vertices.bin"]["gzip"]["bytes"]} bytes, '
          f'indices.bin.gz {files["indices.bin"]["gzip"]["bytes"]} bytes; {time.perf_counter() - started:.0f} s in all')


if __name__ == '__main__':
    main()
