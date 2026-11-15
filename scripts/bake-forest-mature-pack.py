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
    ('oak', 'veteran', 110, 101, 3.0, 56000, 22000, 9.2),
    ('chestnut', 'veteran', 110, 101, 3.0, 56000, 21000, 8.6),
    ('maple', 'veteran', 100, 101, 3.0, 56000, 22500, 9.0),
    ('elm', 'veteran', 110, 303, 3.0, 58000, 25000, 7.8),
    ('birch', 'veteran', 40, 202, 1.8, 15000, 6800, 8.5),
    ('blueberry', 'veteran', 25, 303, 1.8, 6000, 1500, 10.0),
    ('oak', 'canopy', 70, 202, 3.0, 38000, 14000, 9.2),
    ('chestnut', 'canopy', 70, 202, 3.0, 38000, 13500, 8.6),
    ('maple', 'canopy', 60, 202, 3.0, 38000, 14500, 9.0),
    ('elm', 'canopy', 70, 202, 3.0, 38000, 14500, 7.8),
    ('birch', 'canopy', 25, 101, 1.8, 10500, 4800, 8.5),
    ('blueberry', 'canopy', 12, 202, 1.8, 3600, 500, 10.0),
)
# The species whose shoots show a botanical spray of leaves, and the aspect ratio (length / breadth) matching prepare-forest-sprays.py.
SPRAYED = frozenset(('oak', 'chestnut', 'maple', 'elm', 'birch'))
SPRAY_ASPECT = 1.25
LATITUDE = 39.0
# A crown's foliage field and far shell are kept at this cell: a crown 26 m across then takes about as many
# cells as the 10 m crowns of the pack before took at 0.3 m.
FIELD_CELL_METRES = 0.6
# Limbs straighter than this many radians between rings share one ring while preserving bough curves and terminal twigs.
WOOD_STRAIGHTEN_VETERAN = 0.34
WOOD_STRAIGHTEN_CANOPY = 0.30
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
    from scipy.spatial import cKDTree
    import gardenplans
    if not str(pathlib.Path(gardenplans.__file__).resolve()).startswith(str(source)):
        raise SystemExit(f'gardenplans was loaded from {gardenplans.__file__}, not from {source}')
    from gardenplans import tiered_forest as tf
    from gardenplans.grow_colonize import ColonizingGrower
    from gardenplans.light import Environment
    from gardenplans.lod import prune_by_radius
    from gardenplans.mesh import Tessellation, build_branch_mesh, build_wound_mesh, concat, subset_faces
    from gardenplans.organs import OrganArray, place_leaves
    from gardenplans.plan import SPECIES
    from gardenplans.scenery import _measure_grown
    from gardenplans.sky import SkyModel
    from scripts import bake_tiered_forest as baker_cli

    def closest_bark_points(shoot_mesh, query_pts):
        """Exact vectorized closest point on 3D living bark triangles (Ericson §5.1.5)."""
        verts = np.asarray(shoot_mesh.vertices, dtype=np.float64)
        faces = np.asarray(shoot_mesh.faces, dtype=np.int64)
        tri_a, tri_b, tri_c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
        fn = np.cross(tri_b - tri_a, tri_c - tri_a)
        fn_unit = fn / np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
        # Dense edge/midline sampling so straightened cylinder strips up to 1.5 m long never miss in KD-tree lookup.
        max_edge = np.maximum(
            np.maximum(np.linalg.norm(tri_b - tri_a, axis=1), np.linalg.norm(tri_c - tri_b, axis=1)),
            np.linalg.norm(tri_a - tri_c, axis=1),
        )
        steps = np.clip(np.ceil(max_edge / 0.045).astype(np.int64), 1, 40)
        sample_pts, sample_tris = [], []
        for s_val in np.unique(steps):
            t_ids = np.flatnonzero(steps == s_val)
            a_s, b_s, c_s = tri_a[t_ids], tri_b[t_ids], tri_c[t_ids]
            if s_val == 1:
                pts = np.concatenate([(a_s + b_s + c_s) / 3.0, a_s, b_s, c_s], axis=0)
                ids = np.tile(t_ids, 4)
            else:
                ts = np.linspace(0.0, 1.0, int(s_val) + 1)[:, None, None]
                mid_ab = 0.5 * (a_s + b_s)
                grid = np.concatenate([
                    a_s[None] + (b_s - a_s)[None] * ts,
                    b_s[None] + (c_s - b_s)[None] * ts,
                    c_s[None] + (a_s - c_s)[None] * ts,
                    mid_ab[None] + (c_s - mid_ab)[None] * ts[1:-1],
                ], axis=0)
                pts = grid.reshape(-1, 3)
                ids = np.tile(t_ids, grid.shape[0])
            sample_pts.append(pts)
            sample_tris.append(ids)
        all_pts = np.vstack(sample_pts)
        all_tris = np.concatenate(sample_tris)
        k_nn = min(12, len(all_pts))
        _, nn = cKDTree(all_pts).query(query_pts, k=k_nn)
        if k_nn == 1:
            nn = nn[:, None]
        cand = all_tris[nn]
        pa = tri_a[cand]
        pb = tri_b[cand]
        pc = tri_c[cand]
        pp = query_pts[:, None, :]
        ab = pb - pa
        ac = pc - pa
        ap = pp - pa
        d1 = (ab * ap).sum(axis=-1)
        d2 = (ac * ap).sum(axis=-1)
        bp = pp - pb
        d3 = (ab * bp).sum(axis=-1)
        d4 = (ac * bp).sum(axis=-1)
        vc = d1 * d4 - d3 * d2
        cp = pp - pc
        d5 = (ab * cp).sum(axis=-1)
        d6 = (ac * cp).sum(axis=-1)
        vb = d5 * d2 - d1 * d6
        va = d3 * d6 - d5 * d4
        denom = 1.0 / np.maximum(va + vb + vc, 1e-18)
        closest = pa + ab * (vb * denom)[..., None] + ac * (vc * denom)[..., None]
        m_bc = (va <= 0.0) & ((d4 - d3) >= 0.0) & ((d5 - d6) >= 0.0)
        w_bc = np.clip((d4 - d3) / np.maximum((d4 - d3) + (d5 - d6), 1e-18), 0.0, 1.0)
        closest = np.where(m_bc[..., None], pb + (pc - pb) * w_bc[..., None], closest)
        m_ac = (vb <= 0.0) & (d2 >= 0.0) & (d6 <= 0.0)
        w_ac = np.clip(d2 / np.maximum(d2 - d6, 1e-18), 0.0, 1.0)
        closest = np.where(m_ac[..., None], pa + ac * w_ac[..., None], closest)
        m_ab = (vc <= 0.0) & (d1 >= 0.0) & (d3 <= 0.0)
        v_ab = np.clip(d1 / np.maximum(d1 - d3, 1e-18), 0.0, 1.0)
        closest = np.where(m_ab[..., None], pa + ab * v_ab[..., None], closest)
        closest = np.where(((d6 >= 0.0) & (d5 <= d6))[..., None], pc, closest)
        closest = np.where(((d3 >= 0.0) & (d4 <= d3))[..., None], pb, closest)
        closest = np.where(((d1 <= 0.0) & (d2 <= 0.0))[..., None], pa, closest)
        dist2 = ((pp - closest) ** 2).sum(axis=-1)
        best_k = np.argmin(dist2, axis=1)
        rows = np.arange(len(query_pts))
        best_tri = cand[rows, best_k]
        return closest[rows, best_k], fn_unit[best_tri], np.sqrt(dist2[rows, best_k])

    before = json.loads((pack / 'manifest.json').read_text())
    if [(p['species'], p['cohort']) for p in before['prototypes']] != [(s[0], s[1]) for s in PROTOTYPES]:
        raise SystemExit('The pack does not hold these prototypes in this order')
    work.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    # Grow every tree alone, for every year of its age, with adaptive physical-radius bark rings and connected terminal twigs.
    rings_veteran = Tessellation(radial_base=4, radial_falloff=0.62, radial_min=3, radial_error=0.011, radial_max=16)
    rings_canopy = Tessellation(radial_base=4, radial_falloff=0.62, radial_min=3, radial_error=0.012, radial_max=14)
    grown, grower_spec, spec_of, wood_state, record = [], {}, {}, {}, []
    for index, (species, cohort, age, seed, resolution, wood, cards, cover) in enumerate(PROTOTYPES):
        clock = time.perf_counter()
        plan = dataclasses.replace(SPECIES[species](seed), growth_cycles=age, background_mortality=0.0, senescent_mortality=0.0)
        grower = ColonizingGrower(plan, Environment(extinction=plan.light_extinction, sky=SkyModel(latitude=LATITUDE)),
                                  checkpoints=(float(age),), resolution=resolution, steps_per_cycle=2)
        grower.grow()
        height, crown, dbh, basal = _measure_grown(grower, float(age))
        grown.append((index, species, cohort, float(age), plan, grower))
        rings = rings_veteran if cohort == 'veteran' else rings_canopy
        straighten = WOOD_STRAIGHTEN_VETERAN if cohort == 'veteran' else WOOD_STRAIGHTEN_CANOPY
        grower_spec[id(grower)] = {'index': index, 'cohort': cohort, 'wood': wood, 'tess': rings, 'straighten': straighten, 'plan': plan}
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

    # Wood: preserve unbroken 3D branchlet chains throughout the entire crown envelope so every kept leaf shoot sits on meshed wood.
    def budgeted_meshes(grower, age, **options):
        gspec = grower_spec[id(grower)]
        plan = gspec['plan']
        skel = grower.skeleton
        age_f = float(age)
        if age_f in skel.radius_at:
            radius = skel.radius_at[age_f]
        elif skel.radius_at:
            closest_age = min(skel.radius_at.keys(), key=lambda a: abs(a - age_f))
            radius = skel.radius_at[closest_age]
        else:
            radius = np.full(len(skel.nodes.parent), plan.tip_radius)

        organs = place_leaves(skel, age_f, plan)
        if len(organs.position) == 0:
            for fallback_age in range(int(round(age_f)) - 1, 0, -1):
                organs = place_leaves(skel, float(fallback_age), plan)
                if len(organs.position) > 0:
                    break

        parent = np.asarray(skel.nodes.parent, dtype=np.int64)
        pos = np.asarray(skel.nodes.position, dtype=np.float64)
        n_nodes = len(parent)
        depth = np.zeros(n_nodes, dtype=np.int32)
        for i in range(n_nodes):
            if parent[i] >= 0:
                depth[i] = depth[parent[i]] + 1

        u_nodes = np.unique(organs.node_index)
        anc = np.zeros(n_nodes, dtype=bool)
        anc[u_nodes] = True
        has_bearing_child = np.zeros(n_nodes, dtype=bool)
        for i in np.argsort(-depth):
            if anc[i] and parent[i] >= 0:
                has_bearing_child[parent[i]] = True
                anc[parent[i]] = True
        tips = np.flatnonzero(anc & ~has_bearing_child)
        tess = gspec['tess']
        wound_tess = dataclasses.replace(tess, radial_error=0.032, radial_max=8)
        st = gspec['straighten']
        wood_budget = gspec['wood']

        def build_wood_for_tips(picked_tips, min_r_floor):
            protect = np.zeros(n_nodes, dtype=bool)
            protect[picked_tips] = True
            keep_mask = prune_by_radius(skel, age_f, radius, min_r_floor, protect=protect)
            living = build_branch_mesh(skel, age_f, plan.pipe_exponent, plan.tip_radius, tess=tess, radius=radius, alive=keep_mask, straighten=st)
            wounds_raw = build_wound_mesh(skel, age_f, radius, ring_width=plan.wood.max_ring_width, tess=wound_tess, alive=keep_mask)
            combined = concat(living, wounds_raw) if (len(wounds_raw.faces) and len(living.faces)) else (wounds_raw if len(wounds_raw.faces) else living)
            return combined, keep_mask

        full_mesh, full_keep = build_wood_for_tips(tips, 0.04)
        if len(full_mesh.faces) <= wood_budget or len(tips) <= 24:
            chosen_mesh, chosen_keep, chosen_tips = full_mesh, full_keep, tips
        else:
            # Order terminal bearing tips by 3D Farthest-Point Sampling seeded at crown apex & perimeter extremes.
            tip_pos = pos[tips]
            seed_local = list(dict.fromkeys([
                int(np.argmax(tip_pos[:, 2])),
                int(np.argmin(tip_pos[:, 0])),
                int(np.argmax(tip_pos[:, 0])),
                int(np.argmin(tip_pos[:, 1])),
                int(np.argmax(tip_pos[:, 1])),
            ]))
            order = list(seed_local)
            d2 = np.full(len(tips), np.inf, dtype=np.float64)
            for s_idx in seed_local:
                d2 = np.minimum(d2, ((tip_pos - tip_pos[s_idx]) ** 2).sum(axis=1))
                d2[s_idx] = -1.0
            while len(order) < len(tips):
                nxt = int(np.argmax(d2))
                if d2[nxt] <= 0.0:
                    break
                order.append(nxt)
                d2 = np.minimum(d2, ((tip_pos - tip_pos[nxt]) ** 2).sum(axis=1))
                d2[nxt] = -1.0
            fps_tips = tips[np.array(order, dtype=np.int64)]

            lo_k, hi_k = max(len(seed_local), 8), len(fps_tips)
            best_fit = None
            while lo_k <= hi_k:
                mid_k = (lo_k + hi_k) // 2
                cand_tips = fps_tips[:mid_k]
                trial_mesh, trial_keep = build_wood_for_tips(cand_tips, 0.18)
                if len(trial_mesh.faces) <= wood_budget:
                    best_fit = (trial_mesh, trial_keep, cand_tips)
                    lo_k = mid_k + 1
                else:
                    hi_k = mid_k - 1
            if best_fit is not None:
                chosen_mesh, chosen_keep, chosen_tips = best_fit
            else:
                cand_tips = fps_tips[:max(len(seed_local), 8)]
                chosen_mesh, chosen_keep = build_wood_for_tips(cand_tips, 0.22)
                chosen_tips = cand_tips

        root_mesh = None
        if options.get('roots', True):
            got = grower.roots_at.get(age_f)
            if got is None and grower.roots is not None:
                got = (grower.roots, grower.root_radius, grower.root_cloud)
            if got is not None and len(got[0].nodes) > 1:
                rk = prune_by_radius(got[0], age_f, got[1], 0.14)
                root_mesh = build_branch_mesh(got[0], age_f, plan.pipe_exponent, plan.tip_radius, tess=tess, radius=got[1], alive=rk, straighten=st)

        wounds_out = None
        shoot_out = chosen_mesh
        if shoot_out is not None and shoot_out.kind is not None:
            exposed = np.asarray(shoot_out.kind) == 2
            if exposed.any():
                wounds_out = subset_faces(shoot_out, exposed)
                shoot_out = subset_faces(shoot_out, ~exposed)

        wood_state[id(plan)] = {'shoot': shoot_out, 'keep': chosen_keep, 'skel': skel, 'radius': radius, 'depth': depth}
        record[gspec['index']].update({
            'woodStraighten': round(float(st), 3),
            'protectedCrownTips': int(len(chosen_tips)),
            'keptWoodNodes': int(chosen_keep.sum()),
        })
        return shoot_out, root_mesh, None, wounds_out

    # Leaves: 3D V-cambered botanical shoots embedded directly into their parent 3D bark tubes (~0 mm gap).
    blade_meshes = tf._build_tier0_blade_meshes

    def rotate_around_axis(vecs, axes, angles):
        c = np.cos(angles)[:, None]
        s = np.sin(angles)[:, None]
        dot = (vecs * axes).sum(axis=1, keepdims=True)
        return vecs * c + np.cross(axes, vecs) * s + axes * dot * (1.0 - c)

    def carded_blades(organs, plan, cluster, **_):
        spec = spec_of[id(plan)]
        state = wood_state[id(plan)]
        shoot_mesh = state['shoot']
        keep = state['keep']
        skel = state['skel']
        radius = state['radius']
        depth = state['depth']
        parent = np.asarray(skel.nodes.parent, dtype=np.int64)
        pos = np.asarray(skel.nodes.position, dtype=np.float64)

        nid_all = organs.node_index.astype(np.int64)
        pid_all = parent[nid_all]
        on_kept = keep[nid_all] & (pid_all >= 0) & keep[np.clip(pid_all, 0, None)]
        if not np.any(on_kept):
            raise SystemExit(f'Prototype {spec["index"]}: no leaf organs landed on kept wood branches')

        # Identify kept bearing nodes that are distal tips of kept foliage chains so every twig tip gets capped.
        kept_bearing_nodes = np.unique(nid_all[on_kept])
        kb_anc = np.zeros(len(parent), dtype=bool)
        kb_anc[kept_bearing_nodes] = True
        kb_has_child = np.zeros(len(parent), dtype=bool)
        for i in np.argsort(-depth):
            if kb_anc[i] and parent[i] >= 0:
                kb_has_child[parent[i]] = True
                kb_anc[parent[i]] = True
        kept_tip_mask = np.zeros(len(parent), dtype=bool)
        kept_tip_mask[kept_bearing_nodes[~kb_has_child[kept_bearing_nodes]]] = True

        # Crown ground footprint from full grown organ cloud so leaf area index matches isolated open-grown crown.
        ground = np.asarray(organs.position, dtype=np.float64)[:, :2]
        centre = ground.mean(axis=0)
        reach = float(np.quantile(np.hypot(*(ground - centre).T), 0.9))
        cell = min(1.0, max(0.05, reach / 8))
        footprint = len(np.unique(np.floor((ground - centre) / cell).astype(np.int64), axis=0)) * cell * cell
        crown_centre_3d = np.array([centre[0], centre[1], float(np.median(organs.position[:, 2]))], dtype=np.float64)

        counts = np.bincount(organs.archetype, minlength=len(plan.leaves))
        meshes = {}
        attach_of = {}
        up_target_of = {}
        snap_dists = []

        for kind, count in enumerate(counts):
            if not count:
                continue
            share = int(min(count, max(1, round(spec['cards'] * count / counts.sum()))))
            elig_k = np.flatnonzero((organs.archetype == kind) & on_kept)
            if len(elig_k) == 0:
                elig_k = np.flatnonzero(on_kept)

            # Cap every distal twig tip first (at most one per tip for this archetype), then stride evenly across kept crown branches.
            tip_cand = elig_k[kept_tip_mask[nid_all[elig_k]]]
            if len(tip_cand) > 0:
                _, first_tip_idx = np.unique(nid_all[tip_cand], return_index=True)
                tip_picks = tip_cand[np.sort(first_tip_idx)]
            else:
                tip_picks = np.zeros(0, dtype=np.int64)

            if len(tip_picks) >= share:
                step_t = len(tip_picks) / float(share)
                sel_k = tip_picks[np.clip(np.floor(np.arange(share) * step_t).astype(np.int64), 0, len(tip_picks) - 1)]
                is_tip_cap = np.ones(len(sel_k), dtype=bool)
                dup_pass = np.zeros(len(sel_k), dtype=np.int64)
            else:
                rem = share - len(tip_picks)
                used_mask = np.zeros(len(organs.archetype), dtype=bool)
                used_mask[tip_picks] = True
                pool = elig_k[~used_mask[elig_k]]
                if len(pool) == 0:
                    pool = elig_k
                if rem <= len(pool):
                    step_p = len(pool) / float(rem)
                    rest = pool[np.clip(np.floor(np.arange(rem) * step_p).astype(np.int64), 0, len(pool) - 1)]
                    rest_pass = np.zeros(rem, dtype=np.int64)
                else:
                    idx_seq = np.arange(rem, dtype=np.int64)
                    # Interleave evenly across pool on each pass.
                    perm_idx = np.floor((idx_seq % len(pool)) * (len(pool) / float(min(len(pool), rem)))).astype(np.int64) if rem < len(pool) else (idx_seq % len(pool))
                    rest = pool[perm_idx]
                    rest_pass = idx_seq // len(pool)
                sel_k = np.concatenate([tip_picks, rest])
                is_tip_cap = np.concatenate([np.ones(len(tip_picks), dtype=bool), np.zeros(rem, dtype=bool)])
                dup_pass = np.concatenate([np.zeros(len(tip_picks), dtype=np.int64), rest_pass])

            nid_s = nid_all[sel_k]
            pid_s = parent[nid_s]
            seg_a = pos[pid_s]
            seg_b = pos[nid_s]
            twig_vec = seg_b - seg_a
            twig_len = np.maximum(np.linalg.norm(twig_vec, axis=1, keepdims=True), 1e-9)
            twig_dir = twig_vec / twig_len

            # Quasirandom golden-ratio bud positions along each meshed woody internode, with 0.97 at twig tips.
            seq = np.arange(len(sel_k), dtype=np.float64)
            t_lat = 0.08 + ((0.61803398875 * seq + 0.29 * kind + 0.17 * dup_pass) % 0.86)
            t_seg = np.where(is_tip_cap, 0.97, t_lat)
            p_seg = seg_a + twig_vec * t_seg[:, None]

            # Snap onto the exact 3D triangle surface of shoot_mesh and tuck 3.5 mm inside the bark cylinder.
            p_bark, bark_n, s_dist = closest_bark_points(shoot_mesh, p_seg)
            snap_dists.append(s_dist)
            radial_from_axis = p_bark - seg_a - twig_dir * ((p_bark - seg_a) * twig_dir).sum(axis=1, keepdims=True)
            flip_n = (bark_n * radial_from_axis).sum(axis=1, keepdims=True) < 0.0
            bark_out = np.where(flip_n, -bark_n, bark_n)
            embed = np.minimum(0.0035, 0.38 * radius[nid_s])[:, None]
            p_attach = p_bark - bark_out * embed

            # Orient shoot midribs cleanly outward from the bark cylinder (or continuing distal twig tips).
            f_dir = organs.normal[sel_k].astype(np.float64)
            f_dir /= np.maximum(np.linalg.norm(f_dir, axis=1, keepdims=True), 1e-9)
            if np.any(dup_pass > 0):
                f_dir = rotate_around_axis(f_dir, twig_dir, 2.39996323 * dup_pass.astype(np.float64))
            out_crown = p_bark - crown_centre_3d[None, :]
            out_crown /= np.maximum(np.linalg.norm(out_crown, axis=1, keepdims=True), 1e-9)
            f_tip = 0.66 * twig_dir + 0.24 * f_dir + 0.10 * out_crown
            f_tip /= np.maximum(np.linalg.norm(f_tip, axis=1, keepdims=True), 1e-9)
            # Ensure lateral shoots emerge outward from bark (dot >= 0.35) instead of diving backward through the limb.
            inward = np.maximum(0.35 - (f_dir * bark_out).sum(axis=1, keepdims=True), 0.0)
            f_lat = f_dir + inward * bark_out + 0.10 * out_crown
            f_lat /= np.maximum(np.linalg.norm(f_lat, axis=1, keepdims=True), 1e-9)
            f_final = np.where(is_tip_cap[:, None], f_tip, f_lat)

            up_target = np.array([[0.0, 0.0, 1.0]], dtype=np.float64) + 0.38 * out_crown
            up_target /= np.maximum(np.linalg.norm(up_target, axis=1, keepdims=True), 1e-9)
            b_base = np.cross(up_target, f_final)
            b_norm = np.linalg.norm(b_base, axis=1, keepdims=True)
            fallback_ref = np.where(np.abs(f_final[:, 2:3]) > 0.9, np.array([[1.0, 0.0, 0.0]]), np.array([[0.0, 0.0, 1.0]]))
            fallback_b = np.cross(fallback_ref, f_final)
            fallback_b /= np.maximum(np.linalg.norm(fallback_b, axis=1, keepdims=True), 1e-9)
            b_base = np.where(b_norm > 1e-6, b_base / np.maximum(b_norm, 1e-9), fallback_b)
            b_final = rotate_around_axis(b_base, f_final, 0.20 * np.sin(2.39996323 * seq + 0.71 * dup_pass.astype(np.float64)))

            sub_organs = OrganArray(
                archetype=np.full(len(sel_k), kind, dtype=np.uint8),
                position=p_attach.astype(np.float32),
                normal=f_final.astype(np.float32),
                binormal=b_final.astype(np.float32),
                scale=organs.scale[sel_k].astype(np.float32),
                birth_age=organs.birth_age[sel_k].astype(np.float32),
                node_index=nid_s.astype(np.int32),
            )
            name = f'foliage_{kind}'
            meshes[name] = blade_meshes(sub_organs, plan, cluster, max_blades_per_archetype=len(sel_k))[name]
            attach_of[name] = p_attach
            up_target_of[name] = up_target

        blades = {name: np.asarray(mesh.vertices, dtype=np.float64).reshape(-1, 6, 3) for name, mesh in meshes.items()}
        area = sum(float(np.linalg.norm(np.cross(b[:, 3] - b[:, 0], b[:, 2] - b[:, 0]), axis=1).sum()) for b in blades.values())
        grow = (spec['cover'] * footprint / area) ** 0.5
        fold_tris = np.array([[0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 2]], dtype=np.int64)
        sizes = []
        for name, b in blades.items():
            p_attach = attach_of[name]
            up_t = up_target_of[name]
            b = p_attach[:, None, :] + (b - b[:, 1:2, :]) * grow
            if PROTOTYPES[spec['index']][0] in SPRAYED:
                # 3D V-cambered & drooped botanical spray shoot anchored strictly at p_attach (v1) with skyward/outward adaxial face.
                along = b[:, 4] - b[:, 1]
                along /= np.maximum(np.linalg.norm(along, axis=1, keepdims=True), 1e-9)
                across = b[:, 2] - b[:, 0]
                across -= along * (across * along).sum(axis=1, keepdims=True)
                across /= np.maximum(np.linalg.norm(across, axis=1, keepdims=True), 1e-9)
                up_shoot = np.cross(along, across)
                up_shoot /= np.maximum(np.linalg.norm(up_shoot, axis=1, keepdims=True), 1e-9)
                flip_up = np.where((up_shoot * up_t).sum(axis=1, keepdims=True) < 0.0, -1.0, 1.0)
                across = across * flip_up
                camber_dir = up_shoot * flip_up
                broad = (np.linalg.norm(np.cross(b[:, 3] - b[:, 0], b[:, 2] - b[:, 0]), axis=1) / SPRAY_ASPECT) ** 0.5
                long_m = broad * SPRAY_ASPECT
                half_w = 0.5 * broad[:, None]
                v1 = p_attach
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
        all_snaps = np.concatenate(snap_dists)
        record[spec['index']].update({
            'crownFootprintSquareMetres': round(footprint, 1),
            'cardMetres': [round(float(v), 3) for v in np.median(sizes, axis=0)],
            'cardsKept': int(len(sizes)),
            'leavesGrown': int(counts.sum()),
            'skeletonToBarkSnapMedianMm': round(float(np.median(all_snaps) * 1000.0), 2),
        })
        return meshes

    # Middle wood: every cell the baker merges by, made coarser by as much as the tree outgrows the baker's.
    merged_by_cell = tf._simplify_wood_indices_by_cell

    def merged_for_height(wood_vertices, wood_indices, cell_m):
        reach = float(np.asarray(wood_vertices)[:, 1].max())
        return merged_by_cell(wood_vertices, wood_indices, cell_m * max(1.0, reach / MIDDLE_CELLS_IN_HEIGHT / BAKER_MIDDLE_CELL_METRES))

    accel = tf._get_bake_accel()
    meshes_module, meshes_name = (accel, 'plant_meshes_fast') if accel is not None else (tf, 'plant_meshes')
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
