#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Bakes the Portugal forest pack from full-grown trees with genomic single-leaf placement on 3D woody shoots.

Run from the repository root with forestmodeler's own Python:

    <forestmodeler>/.venv/bin/python scripts/bake-forest-mature-pack.py \\
        --forestmodeler <a forestmodeler checkout> --work <an empty folder for the baker's own output>

(add --revision <commit> when the checkout is an archive copy, so the manifest can name what grew the trees)

Every prototype is one tree grown alone, in the open, to the age PROTOTYPES names for it, by forestmodeler's
colonising grower at Lisbon's latitude. Each tree's structural trunk, boughs, and multi-order branchlets are
meshed as 3D cylindrical bark tubes, and FPS-distributed 1st/2nd-year bearing shoots are meshed directly onto
those branchlets as tapered 3D woody twigs. Individual botanical leaves (using each species' single-leaf + petiole
surface maps) are placed node-by-node along every 3D woody shoot strictly according to the species' genome in
gardenplans/plan.py and gardenplans/organs.py:
  - phyllotaxy & buds_per_node (137.5° golden-angle 3D spiral on oak/blueberry, 90° opposite-decussate pairs on
    maple, and foliage_planarity two-rank lateral combing on elm 0.62, chestnut 0.55, and birch 0.40),
  - sub-apical internode shortening on species with terminal_cluster_buds (oak),
  - leaf_attach divergence angle from the shoot axis,
  - Beer-Lambert canopy light (lit_at) driving sun/shade petiole-twist leaf-mosaic inclination
    (leaf_inclination_shade..leaf_inclination_sun) and sun/shade blade size plasticity (leaf_size_shade..sun),
  - exact petiole-foot contact (0 mm gap) anchored into the 3D woody shoot bark.

After this, bake the derived sets in order:

    python3 scripts/prepare-forest-surfaces.py portugal --builtin --reuse saba
    node scripts/prepare-forest-clusters.mjs portugal
    node scripts/prepare-forest-crowns.mjs portugal
    node scripts/prepare-forest-groves.mjs portugal
    node scripts/prepare-forest-wind.mjs portugal

and name the new vertices.bin, indices.bin and roots.bin (their sha256 in the manifest's `files`) in
CERTIFIED_FOREST_STREAM_SHAS of js/forest-scenery.js.
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

# (species, cohort, age_yr, seed, grower_res, wood_skel_tris, n_woody_shoots, leaves_per_shoot, target_opaque_lai, max_botanical_scale)
PROTOTYPES = (
    ('oak', 'veteran', 110, 101, 3.0, 39000, 2300, 14, 3.6, 1.48),
    ('chestnut', 'veteran', 110, 101, 3.0, 39000, 2200, 14, 3.5, 1.72),
    ('maple', 'veteran', 100, 101, 3.0, 39000, 2250, 14, 3.6, 1.74),
    ('elm', 'veteran', 110, 303, 3.0, 41000, 2400, 15, 3.4, 1.85),
    ('birch', 'veteran', 40, 202, 1.8, 10500, 900, 13, 3.0, 1.85),
    ('blueberry', 'veteran', 25, 303, 1.8, 4400, 240, 10, 3.6, 1.50),
    ('oak', 'canopy', 70, 202, 3.0, 26000, 1500, 13, 3.6, 1.48),
    ('chestnut', 'canopy', 70, 202, 3.0, 26000, 1450, 13, 3.5, 1.72),
    ('maple', 'canopy', 60, 202, 3.0, 26000, 1500, 14, 3.6, 1.74),
    ('elm', 'canopy', 70, 202, 3.0, 27000, 1550, 14, 3.4, 1.85),
    ('birch', 'canopy', 25, 101, 1.8, 7600, 600, 12, 3.0, 1.85),
    ('blueberry', 'canopy', 12, 202, 1.8, 2600, 110, 8, 3.6, 1.50),
)

# Species-specific natural shoot length range (metres) and gravitational shoot tip droop fraction.
SHOOT_HABIT = {
    'oak': (0.36, 0.58, 0.04),
    'chestnut': (0.38, 0.62, 0.07),
    'maple': (0.34, 0.56, 0.05),
    'elm': (0.36, 0.60, 0.14),
    'birch': (0.24, 0.44, 0.13),
    'blueberry': (0.14, 0.28, 0.04),
}

LATITUDE = 39.0
FIELD_CELL_METRES = 0.6
WOOD_STRAIGHTEN_VETERAN = 0.46
WOOD_STRAIGHTEN_CANOPY = 0.40
MIDDLE_CELLS_IN_HEIGHT = 40
BAKER_MIDDLE_CELL_METRES = 0.15


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

    import numpy as np
    from PIL import Image
    from scipy.spatial import cKDTree
    import gardenplans
    if not str(pathlib.Path(gardenplans.__file__).resolve()).startswith(str(source)):
        raise SystemExit(f'gardenplans was loaded from {gardenplans.__file__}, not from {source}')
    from gardenplans import tiered_forest as tf
    from gardenplans.grow_colonize import ColonizingGrower
    from gardenplans.light import Environment
    from gardenplans.lod import prune_by_radius
    from gardenplans.mesh import Mesh, Tessellation, build_branch_mesh, build_wound_mesh, concat, subset_faces
    from gardenplans.organs import leaf_blade, lit_at, place_leaves
    from gardenplans.plan import SPECIES
    from gardenplans.rng import Rng
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
        max_edge = np.maximum(
            np.maximum(np.linalg.norm(tri_b - tri_a, axis=1), np.linalg.norm(tri_c - tri_b, axis=1)),
            np.linalg.norm(tri_a - tri_c, axis=1),
        )
        steps = np.clip(np.ceil(max_edge / 0.05).astype(np.int64), 1, 36)
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
        pa, pb, pc = tri_a[cand], tri_b[cand], tri_c[cand]
        pp = query_pts[:, None, :]
        ab, ac, ap = pb - pa, pc - pa, pp - pa
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

    def fps_indices(points, k):
        """Deterministic 3D Farthest-Point Sampling seeded at crown spatial extremes."""
        n = len(points)
        if n <= k:
            return np.arange(n, dtype=np.int64)
        seeds = list(dict.fromkeys([
            int(np.argmax(points[:, 2])),
            int(np.argmin(points[:, 0])),
            int(np.argmax(points[:, 0])),
            int(np.argmin(points[:, 1])),
            int(np.argmax(points[:, 1])),
            int(np.argmin(points[:, 2])),
        ]))
        chosen = list(seeds[:k])
        d2 = np.full(n, np.inf, dtype=np.float64)
        for s_idx in chosen:
            d2 = np.minimum(d2, ((points - points[s_idx]) ** 2).sum(axis=1))
            d2[s_idx] = -1.0
        while len(chosen) < k:
            nxt = int(np.argmax(d2))
            if d2[nxt] <= 0.0:
                break
            chosen.append(nxt)
            d2 = np.minimum(d2, ((points - points[nxt]) ** 2).sum(axis=1))
            d2[nxt] = -1.0
        return np.array(chosen, dtype=np.int64)

    def build_woody_shoots_mesh(p_base, p_tip, r_base, r_tip):
        """Build 3-sided tapered 3D cylindrical bark twigs (6 vertices, 6 triangles per shoot)."""
        m = len(p_base)
        axis = p_tip - p_base
        length = np.maximum(np.linalg.norm(axis, axis=1, keepdims=True), 1e-6)
        u = axis / length
        ref = np.tile(np.array([0.0, 0.0, 1.0]), (m, 1))
        ref[np.abs(u[:, 2]) > 0.9] = np.array([1.0, 0.0, 0.0])
        e1 = np.cross(u, ref)
        e1 /= np.maximum(np.linalg.norm(e1, axis=1, keepdims=True), 1e-9)
        e2 = np.cross(u, e1)

        angles = np.array([0.0, 2.0 * np.pi / 3.0, 4.0 * np.pi / 3.0], dtype=np.float64)
        ca, sa = np.cos(angles), np.sin(angles)
        # Radial unit vectors for the 3 ring corners: shape (m, 3_corners, 3_xyz)
        dirs = e1[:, None, :] * ca[None, :, None] + e2[:, None, :] * sa[None, :, None]
        ring0 = p_base[:, None, :] + dirs * r_base[:, None, None]
        ring1 = p_tip[:, None, :] + dirs * r_tip[:, None, None]
        verts = np.concatenate([ring0, ring1], axis=1).reshape(-1, 3).astype(np.float32)
        norms = np.concatenate([dirs, dirs], axis=1).reshape(-1, 3).astype(np.float32)

        u_ring = np.array([0.0, 1.0 / 3.0, 2.0 / 3.0], dtype=np.float32)
        v_top = np.clip((length[:, 0] / np.maximum(2.0 * np.pi * r_base, 1e-3)) * 0.25, 0.2, 2.5).astype(np.float32)
        uv0 = np.stack([np.broadcast_to(u_ring[None, :], (m, 3)), np.zeros((m, 3), dtype=np.float32)], axis=2)
        uv1 = np.stack([np.broadcast_to(u_ring[None, :], (m, 3)), np.broadcast_to(v_top[:, None], (m, 3))], axis=2)
        uvs = np.concatenate([uv0, uv1], axis=1).reshape(-1, 2)

        # Outward CCW winding around +u (`ring0` = 0,1,2; `ring1` = 3,4,5):
        f_local = np.array([
            [0, 1, 4], [0, 4, 3],
            [1, 2, 5], [1, 5, 4],
            [2, 0, 3], [2, 3, 5],
        ], dtype=np.int32)
        offsets = (np.arange(m, dtype=np.int32) * 6)[:, None, None]
        faces = (f_local[None, :, :] + offsets).reshape(-1, 3)
        return Mesh(
            vertices=verts,
            normals=norms,
            uvs=uvs,
            faces=faces,
            order=np.full(len(faces), 4, dtype=np.uint8),
            kind=np.zeros(len(faces), dtype=np.uint8),
        )

    before = json.loads((pack / 'manifest.json').read_text())
    if [(p['species'], p['cohort']) for p in before['prototypes']] != [(s[0], s[1]) for s in PROTOTYPES]:
        raise SystemExit('The pack does not hold these prototypes in this order')

    # Measure opaque alpha coverage fraction of each prototype's single-leaf textures.
    fol_coverage_by_proto = {}
    for p_entry in before['prototypes']:
        covs = []
        for mat in p_entry['nativeMaterials']:
            if mat['name'].startswith('foliage'):
                alpha = np.asarray(Image.open(pack / mat['albedo']['file']).convert('RGBA'), dtype=np.float64)[..., 3] / 255.0
                covs.append(float((alpha >= float(mat.get('opacityThreshold', 0.35))).mean()))
        fol_coverage_by_proto[p_entry['id']] = float(np.mean(covs)) if covs else 0.36

    work.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    rings_veteran = Tessellation(radial_base=4, radial_falloff=0.60, radial_min=3, radial_error=0.020, radial_max=12)
    rings_canopy = Tessellation(radial_base=4, radial_falloff=0.60, radial_min=3, radial_error=0.020, radial_max=12)
    grown, grower_spec, spec_of, wood_state, record = [], {}, {}, {}, []

    for index, (species, cohort, age, seed, resolution, wood_skel, n_shoots, lps, target_lai, max_scale) in enumerate(PROTOTYPES):
        clock = time.perf_counter()
        plan = dataclasses.replace(SPECIES[species](seed), growth_cycles=age, background_mortality=0.0, senescent_mortality=0.0)
        grower = ColonizingGrower(
            plan,
            Environment(extinction=plan.light_extinction, sky=SkyModel(latitude=LATITUDE)),
            checkpoints=(float(age),),
            resolution=resolution,
            steps_per_cycle=2,
        )
        grower.grow()
        height, crown, dbh, basal = _measure_grown(grower, float(age))
        grown.append((index, species, cohort, float(age), plan, grower))
        rings = rings_veteran if cohort == 'veteran' else rings_canopy
        straighten = WOOD_STRAIGHTEN_VETERAN if cohort == 'veteran' else WOOD_STRAIGHTEN_CANOPY
        grower_spec[id(grower)] = {
            'index': index,
            'species': species,
            'cohort': cohort,
            'wood_skel': wood_skel,
            'n_shoots': n_shoots,
            'leaves_per_shoot': lps,
            'tess': rings,
            'straighten': straighten,
            'plan': plan,
        }
        spec_of[id(plan)] = {
            'index': index,
            'species': species,
            'cohort': cohort,
            'n_shoots': n_shoots,
            'leaves_per_shoot': lps,
            'target_lai': target_lai,
            'max_scale': max_scale,
            'tex_coverage': fol_coverage_by_proto[index],
        }
        record.append({
            'id': index,
            'species': species,
            'cohort': cohort,
            'age': age,
            'seed': seed,
            'resolution': resolution,
            'woodSkeletonBudget': wood_skel,
            'genomicShootsTarget': n_shoots,
            'leavesPerShoot': lps,
            'growSeconds': round(time.perf_counter() - clock, 1),
            'basalRadius': round(float(basal), 3),
        })
        print(
            f'grew {species} {cohort}: {age} years, seed {seed}: {height:.1f} m tall, crown radius {crown:.1f} m, '
            f'{dbh:.0f} cm through, {int(grower.skeleton.alive_mask(float(age)).sum())} live nodes, {record[-1]["growSeconds"]} s',
            flush=True,
        )

    def grown_prototypes(species_order, *, cohorts, **_):
        wanted = [(species, cohort) for cohort in cohorts for species in species_order]
        if wanted != [(s[0], s[1]) for s in PROTOTYPES]:
            raise SystemExit(f'The stand asks for {wanted}')
        return grown

    def budgeted_meshes(grower, age, **options):
        gspec = grower_spec[id(grower)]
        plan = gspec['plan']
        species = gspec['species']
        skel = grower.skeleton
        age_f = float(age)
        if age_f in skel.radius_at:
            radius = skel.radius_at[age_f]
        elif skel.radius_at:
            closest_age = min(skel.radius_at.keys(), key=lambda a: abs(a - age_f))
            radius = skel.radius_at[closest_age]
        else:
            radius = np.full(len(skel.nodes.parent), plan.tip_radius)

        organs = place_leaves(skel, age_f, plan, env=grower.env)
        if len(organs.position) == 0:
            for fallback_age in range(int(round(age_f)) - 1, 0, -1):
                organs = place_leaves(skel, float(fallback_age), plan, env=grower.env)
                if len(organs.position) > 0:
                    break

        parent = np.asarray(skel.nodes.parent, dtype=np.int64)
        pos = np.asarray(skel.nodes.position, dtype=np.float64)
        true_alive = skel.alive_mask(age_f)
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
        tips = np.flatnonzero(anc & ~has_bearing_child & true_alive)

        tess = gspec['tess']
        wound_tess = dataclasses.replace(tess, radial_error=0.036, radial_max=8)
        st = gspec['straighten']
        wood_skel_budget = gspec['wood_skel']

        def build_living_for(min_r_floor, picked_tips=None):
            protect = None
            if picked_tips is not None and len(picked_tips):
                protect = np.zeros(n_nodes, dtype=bool)
                protect[picked_tips] = True
            keep_mask = prune_by_radius(skel, age_f, radius, min_r_floor, protect=protect) & true_alive
            living = build_branch_mesh(
                skel, age_f, plan.pipe_exponent, plan.tip_radius,
                tess=tess, radius=radius, alive=keep_mask, straighten=st,
            )
            return living, keep_mask

        # Step 1: Binary-search the finest radius floor that fits ~78% of wood_skel_budget so fine 3rd/4th-order crown branches stay everywhere.
        fine_target = int(wood_skel_budget * 0.78)
        full_liv, full_km = build_living_for(0.015, tips)
        if len(full_liv.faces) <= wood_skel_budget:
            chosen_liv, chosen_keep, chosen_tips = full_liv, full_km, tips
        else:
            lo_r, hi_r = 0.018, 0.16
            best_r = 0.12
            for _ in range(12):
                mid_r = 0.5 * (lo_r + hi_r)
                liv_try, _ = build_living_for(mid_r, None)
                if len(liv_try.faces) <= fine_target:
                    best_r = mid_r
                    hi_r = mid_r
                else:
                    lo_r = mid_r
            # Step 2: Spend the remaining 22% of wood_skel_budget on FPS-distributed distal bearing twig chains reaching outer crown tips.
            fps_tips = tips[fps_indices(pos[tips], min(len(tips), 900))]
            lo_k, hi_k = 0, len(fps_tips)
            best_fit = None
            while lo_k <= hi_k:
                mid_k = (lo_k + hi_k) // 2
                cand = fps_tips[:mid_k]
                liv_try, km_try = build_living_for(best_r, cand)
                if len(liv_try.faces) <= wood_skel_budget:
                    best_fit = (liv_try, km_try, cand)
                    lo_k = mid_k + 1
                else:
                    hi_k = mid_k - 1
            if best_fit is not None:
                chosen_liv, chosen_keep, chosen_tips = best_fit
            else:
                chosen_liv, chosen_keep = build_living_for(max(best_r, 0.12), fps_tips[:8])
                chosen_tips = fps_tips[:8]

        # Step 3: Select FPS-distributed 1st/2nd-year genomic bearing shoots across the grown organ cloud and mesh them onto chosen_liv!
        org_pos = np.asarray(organs.position, dtype=np.float64)
        org_nrm = np.asarray(organs.normal, dtype=np.float64)
        d_to_wood, _ = cKDTree(chosen_liv.vertices).query(org_pos, k=1)
        l_min, l_max, droop_frac = SHOOT_HABIT[species]
        n_shoots_target = min(gspec['n_shoots'], len(org_pos))

        # Prefer grown leaves within natural shoot reach of kept branchlets so shoots bridge wood-to-foliage with zero distortion.
        reach_cap = l_max * 1.35
        elig = np.flatnonzero(d_to_wood <= reach_cap)
        if len(elig) < n_shoots_target * 2:
            q_dist = float(np.quantile(d_to_wood, min(0.95, max(0.55, (n_shoots_target * 2.5) / max(len(org_pos), 1)))))
            elig = np.flatnonzero(d_to_wood <= max(reach_cap, q_dist))
        picked_local = fps_indices(org_pos[elig], n_shoots_target)
        picked_org = elig[picked_local]

        p_targets = org_pos[picked_org]
        p_bark, bark_n, snap_d = closest_bark_points(chosen_liv, p_targets)
        crown_centre = np.array([
            float(org_pos[:, 0].mean()),
            float(org_pos[:, 1].mean()),
            float(np.median(org_pos[:, 2])),
        ], dtype=np.float64)
        out_crown = p_bark - crown_centre[None, :]
        out_crown /= np.maximum(np.linalg.norm(out_crown, axis=1, keepdims=True), 1e-9)

        # Orient bark_out outward from parent branch / crown interior.
        to_target = p_targets - p_bark
        to_target_len = np.linalg.norm(to_target, axis=1, keepdims=True)
        ref_out = np.where(to_target_len > 0.02, to_target / np.maximum(to_target_len, 1e-9), out_crown)
        bark_out = np.where((bark_n * ref_out).sum(axis=1, keepdims=True) < 0.0, -bark_n, bark_n)

        # Tuck shoot base 3 mm inside the parent 3D bark triangle so there is zero seam or gap.
        p_shoot_base = p_bark - bark_out * 0.003

        raw_vec = p_targets - p_shoot_base
        raw_len = np.linalg.norm(raw_vec, axis=1, keepdims=True)
        org_dir = org_nrm[picked_org]
        org_dir /= np.maximum(np.linalg.norm(org_dir, axis=1, keepdims=True), 1e-9)
        dir_blend = np.where(
            raw_len > 0.06,
            0.70 * (raw_vec / np.maximum(raw_len, 1e-9)) + 0.20 * org_dir + 0.10 * out_crown,
            0.62 * org_dir + 0.38 * out_crown,
        )
        dir_blend /= np.maximum(np.linalg.norm(dir_blend, axis=1, keepdims=True), 1e-9)
        inward = np.maximum(0.24 - (dir_blend * bark_out).sum(axis=1, keepdims=True), 0.0)
        shoot_dir = dir_blend + inward * bark_out
        shoot_dir /= np.maximum(np.linalg.norm(shoot_dir, axis=1, keepdims=True), 1e-9)

        rng_sh = Rng(plan.seed + 3571).stream('genomic-shoots', purpose='shoot-lengths')
        jit_len = rng_sh.uniform(0.88, 1.12, len(picked_org))
        shoot_len = np.clip(np.maximum(raw_len[:, 0], 0.5 * (l_min + l_max)) * jit_len, l_min, l_max)
        p_shoot_tip = p_shoot_base + shoot_dir * shoot_len[:, None]
        p_shoot_tip[:, 2] -= droop_frac * shoot_len

        r_shoot_base = np.full(len(picked_org), max(float(plan.tip_radius) * 1.35, 0.0022), dtype=np.float64)
        r_shoot_tip = np.full(len(picked_org), max(float(plan.tip_radius) * 0.65, 0.0012), dtype=np.float64)
        shoots_mesh = build_woody_shoots_mesh(p_shoot_base, p_shoot_tip, r_shoot_base, r_shoot_tip)

        wounds_raw = build_wound_mesh(skel, age_f, radius, ring_width=plan.wood.max_ring_width, tess=wound_tess, alive=chosen_keep)
        shoot_out = concat(chosen_liv, shoots_mesh)
        wounds_out = wounds_raw if len(wounds_raw.faces) > 0 else None
        if shoot_out.kind is not None:
            exposed = np.asarray(shoot_out.kind) == 2
            if exposed.any():
                extra_w = subset_faces(shoot_out, exposed)
                wounds_out = concat(wounds_out, extra_w) if wounds_out is not None else extra_w
                shoot_out = subset_faces(shoot_out, ~exposed)

        root_mesh = None
        if options.get('roots', True):
            got = grower.roots_at.get(age_f)
            if got is None and grower.roots is not None:
                got = (grower.roots, grower.root_radius, grower.root_cloud)
            if got is not None and len(got[0].nodes) > 1:
                rk = prune_by_radius(got[0], age_f, got[1], 0.14)
                root_mesh = build_branch_mesh(
                    got[0], age_f, plan.pipe_exponent, plan.tip_radius,
                    tess=tess, radius=got[1], alive=rk, straighten=st,
                )

        wood_state[id(plan)] = {
            'grower': grower,
            'organs_grown': organs,
            'p_shoot_base': p_shoot_base,
            'p_shoot_tip': p_shoot_tip,
            'r_shoot_base': r_shoot_base,
            'r_shoot_tip': r_shoot_tip,
            'shoot_snap_dists': snap_d,
        }
        record[gspec['index']].update({
            'woodStraighten': round(float(st), 3),
            'protectedCrownTips': int(len(chosen_tips)),
            'keptWoodNodes': int(chosen_keep.sum()),
            'meshedWoodyShoots': int(len(p_shoot_base)),
        })
        return shoot_out, root_mesh, None, wounds_out

    def genomic_blades(organs, plan, cluster, **_):
        """Place individual single leaves along every 3D woody shoot strictly by gardenplans's genomic equations."""
        spec = spec_of[id(plan)]
        state = wood_state[id(plan)]
        grower = state['grower']
        organs_grown = state['organs_grown']
        p_base = state['p_shoot_base']
        p_tip = state['p_shoot_tip']
        r_base = state['r_shoot_base']
        r_tip = state['r_shoot_tip']

        n_shoots = len(p_base)
        lps = int(spec['leaves_per_shoot'])
        paired = int(plan.buds_per_node) >= 2
        if paired and (lps % 2 == 1):
            lps += 1

        rng = Rng(plan.seed + 7919).stream('genomic-foliage', purpose='leaf-placement')
        phi0 = rng.uniform(0.0, 2.0 * np.pi, n_shoots)

        # Build per-leaf shoot index, fractional position `t_node` along the shoot, along_idx, and genomic phyllotactic phase.
        if paired:
            # Opposite-decussate phyllotaxy (e.g. Maple: buds_per_node == 2, phyllotaxy == 90° between successive 180° pairs).
            n_pairs = lps // 2
            s_idx = np.repeat(np.arange(n_shoots, dtype=np.int64), lps)
            k_local = np.tile(np.arange(lps, dtype=np.int64), n_shoots)
            pair_idx = k_local // 2
            pair_side = k_local % 2
            u_frac = (pair_idx + 0.5) / max(n_pairs, 1)
            t_jitter = rng.uniform(-0.012, 0.012, len(s_idx))
            t_node = np.clip(0.14 + 0.83 * u_frac + t_jitter, 0.08, 0.985)
            along_leaf = pair_idx
            phase = (phi0[s_idx] + pair_idx * float(plan.phyllotaxy) + pair_side * np.pi) % (2.0 * np.pi)
            is_apical = pair_idx == (n_pairs - 1)
        else:
            # Alternate / spiral phyllotaxy (137.508° golden angle; sub-apical internode shortening when terminal_cluster_buds > 0).
            s_idx = np.repeat(np.arange(n_shoots, dtype=np.int64), lps)
            k_local = np.tile(np.arange(lps, dtype=np.int64), n_shoots)
            u_frac = (k_local + 0.5) / max(lps, 1)
            if int(getattr(plan, 'terminal_cluster_buds', 0)) > 0:
                u_shaped = u_frac ** 0.82
            else:
                u_shaped = u_frac
            t_jitter = rng.uniform(-0.012, 0.012, len(s_idx))
            t_node = np.clip(0.12 + 0.86 * u_shaped + t_jitter, 0.06, 0.99)
            along_leaf = k_local
            phase = (phi0[s_idx] + k_local * float(plan.phyllotaxy)) % (2.0 * np.pi)
            is_apical = k_local == (lps - 1)

        m = len(s_idx)
        shoot_vec = p_tip[s_idx] - p_base[s_idx]
        twig = shoot_vec / np.maximum(np.linalg.norm(shoot_vec, axis=1, keepdims=True), 1e-9)
        p_node = p_base[s_idx] + shoot_vec * t_node[:, None]
        r_local = (1.0 - t_node) * r_base[s_idx] + t_node * r_tip[s_idx]

        # Orthonormal frame around the shoot axis (`gardenplans/organs.py:832-840`).
        ref = np.tile(np.array([0.0, 0.0, 1.0]), (m, 1))
        ref[np.abs(twig[:, 2]) > 0.9] = np.array([1.0, 0.0, 0.0])
        side = np.cross(twig, ref)
        side /= np.maximum(np.linalg.norm(side, axis=1, keepdims=True), 1e-9)
        up2 = np.cross(twig, side)
        radial = side * np.cos(phase)[:, None] + up2 * np.sin(phase)[:, None]

        # Genomic two-rank lateral combing (`plan.foliage_planarity`: 0.0 on oak/maple/blueberry; >0 on elm/chestnut/birch).
        if float(plan.foliage_planarity) > 0.0:
            h = np.cross(np.tile(np.array([0.0, 0.0, 1.0]), (m, 1)), twig)
            hn = np.linalg.norm(h, axis=1, keepdims=True)
            h_unit = h / np.maximum(hn, 1e-9)
            rank = h_unit * np.where((along_leaf % 2) == 0, 1.0, -1.0)[:, None]
            k_plan = float(plan.foliage_planarity) * hn
            mixed = radial * (1.0 - k_plan) + rank * k_plan
            mn = np.linalg.norm(mixed, axis=1, keepdims=True)
            radial = np.where(mn > 1e-9, mixed / np.maximum(mn, 1e-9), radial)

        # Genomic insertion divergence angle (`plan.leaf_attach`), leading slightly forward on the terminal bud.
        attach = np.atleast_1d(plan.leaf_attach.sample(rng, m)).astype(np.float64)
        if not paired:
            attach = np.where(is_apical, attach * 0.52, attach)
        forward = twig * np.cos(attach)[:, None] + radial * np.sin(attach)[:, None]
        forward /= np.maximum(np.linalg.norm(forward, axis=1, keepdims=True), 1e-9)

        # Beer-Lambert canopy light -> sun/shade petiole-twist leaf mosaic (`organs.py:894-930`).
        lit = np.zeros(m, dtype=np.float64)
        if grower.env is not None:
            lit = np.clip(lit_at(p_node, grower.env, budget=4000), 0.0, 1.0)
        up = np.tile(np.array([0.0, 0.0, 1.0]), (m, 1))
        proj = up - forward * (up * forward).sum(axis=1, keepdims=True)
        pn = np.linalg.norm(proj, axis=1, keepdims=True)
        e1 = np.where(pn > 1e-6, proj / np.maximum(pn, 1e-9), side)
        e2 = np.cross(forward, e1)

        target_inc = (
            float(plan.leaf_inclination_shade)
            + (float(plan.leaf_inclination_sun) - float(plan.leaf_inclination_shade)) * lit
            + rng.normal(0.0, float(plan.leaf_inclination_spread), m)
        )
        a_inc = np.clip(np.cos(target_inc) / np.maximum(pn[:, 0], 1e-9), -1.0, 1.0)
        b_inc = np.sqrt(np.maximum(1.0 - a_inc * a_inc, 0.0)) * np.where(np.sin(phase) >= 0.0, 1.0, -1.0)
        blade_normal = e1 * a_inc[:, None] + e2 * b_inc[:, None]
        nn = np.linalg.norm(blade_normal, axis=1, keepdims=True)
        blade_normal = np.where(nn > 1e-6, blade_normal / np.maximum(nn, 1e-9), e1)
        binormal = np.cross(blade_normal, forward)
        bn = np.linalg.norm(binormal, axis=1, keepdims=True)
        binormal = np.where(bn > 1e-6, binormal / np.maximum(bn, 1e-9), side)
        # Re-orthogonalize blade_normal = cross(forward, binormal) for exact right-handed basis (forward, binormal, blade_normal).
        blade_normal = np.cross(forward, binormal)
        blade_normal /= np.maximum(np.linalg.norm(blade_normal, axis=1, keepdims=True), 1e-9)

        # Sun/shade blade size plasticity (`organs.py:934-946`) + natural shoot-position leaf size profile.
        plastic = float(plan.leaf_size_shade) + (float(plan.leaf_size_sun) - float(plan.leaf_size_shade)) * lit
        plastic /= max(float(plastic.mean()), 1e-9)
        size_draw = np.clip(rng.normal(1.0, 0.14, m), 0.62, 1.42)
        size_draw /= np.sqrt(max(float(np.mean(size_draw ** 2)), 1e-9))
        shoot_profile = 0.88 + 0.18 * np.sin(np.pi * np.clip(t_node, 0.05, 0.95))
        rel_scale = size_draw * np.sqrt(plastic) * shoot_profile

        # Anchor petiole foot 65% inside the 3D woody shoot bark cylinder (0.000 mm detachment!).
        p_petiole_foot = p_node + radial * (0.35 * r_local)[:, None]

        # Crown ground footprint from full grown organ cloud, and bounded botanical scale conserving lush crown LAI.
        ground = np.asarray(organs_grown.position, dtype=np.float64)[:, :2]
        centre_xy = ground.mean(axis=0)
        reach = float(np.quantile(np.hypot(*(ground - centre_xy).T), 0.9))
        cell = min(1.0, max(0.05, reach / 8.0))
        footprint = len(np.unique(np.floor((ground - centre_xy) / cell).astype(np.int64), axis=0)) * cell * cell

        arch_ids = rng.integers(0, len(plan.leaves), m).astype(np.int64)
        raw_quad_areas = np.zeros(m, dtype=np.float64)
        arch_templates = []
        for i_arch, arch in enumerate(plan.leaves):
            bv_raw, _ = leaf_blade(arch)
            lo = bv_raw[:, :2].min(axis=0)
            hi = bv_raw[:, :2].max(axis=0)
            # Shift x by -lo[0] so v1 (petiole foot, UV=(0,0.5)) sits at local (0,0,0) right inside the woody shoot!
            bv_shifted = np.array(
                [[x - lo[0], y, abs(y) * 0.18] for x in (lo[0], hi[0]) for y in (lo[1], 0.0, hi[1])],
                dtype=np.float64,
            )
            uv_tpl = ((np.array([[x, y] for x in (lo[0], hi[0]) for y in (lo[1], 0.0, hi[1])], dtype=np.float64) - lo)
                      / np.maximum(hi - lo, 1e-9)).astype(np.float32)
            q_area = float((hi[0] - lo[0]) * (hi[1] - lo[1]))
            raw_quad_areas[arch_ids == i_arch] = q_area
            arch_templates.append((bv_shifted, uv_tpl))

        raw_opaque_area = float(np.sum(raw_quad_areas * (rel_scale ** 2))) * max(spec['tex_coverage'], 0.20)
        wanted_opaque_area = float(spec['target_lai']) * footprint
        botanical_scale = float(np.clip(np.sqrt(wanted_opaque_area / max(raw_opaque_area, 1e-6)), 1.05, float(spec['max_scale'])))
        final_scale = rel_scale * botanical_scale

        fold_tris = np.array([[0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 2]], dtype=np.int32)
        basis_all = np.stack([forward, binormal, blade_normal], axis=2)  # shape (m, 3, 3)

        meshes = {}
        sizes = []
        for i_arch, (bv_shifted, uv_tpl) in enumerate(arch_templates):
            sel = np.flatnonzero(arch_ids == i_arch)
            if len(sel) == 0:
                continue
            b_world = (
                p_petiole_foot[sel, None, :]
                + np.einsum('mij,vj->mvi', basis_all[sel], bv_shifted) * final_scale[sel, None, None]
            )
            p0 = b_world[:, fold_tris[:, 0]]
            p1 = b_world[:, fold_tris[:, 1]]
            p2 = b_world[:, fold_tris[:, 2]]
            fn = np.cross(p1 - p0, p2 - p0)
            vn = np.zeros_like(b_world)
            for corner in range(3):
                for t_idx in range(4):
                    vn[:, fold_tris[t_idx, corner]] += fn[:, t_idx]
            vn /= np.maximum(np.linalg.norm(vn, axis=2, keepdims=True), 1e-12)

            count_k = len(sel)
            idx_k = (fold_tris[None, :, :] + (np.arange(count_k, dtype=np.int32) * 6)[:, None, None]).reshape(-1, 3)
            sizes.append(np.stack([
                np.linalg.norm(b_world[:, 4] - b_world[:, 1], axis=1),
                np.linalg.norm(b_world[:, 2] - b_world[:, 0], axis=1),
            ], axis=1))
            meshes[f'foliage_{i_arch}'] = Mesh(
                vertices=b_world.reshape(-1, 3).astype(np.float32),
                normals=vn.reshape(-1, 3).astype(np.float32),
                uvs=np.tile(uv_tpl, (count_k, 1)),
                faces=idx_k,
                order=np.zeros(count_k * 4, dtype=np.uint8),
                kind=np.ones(count_k * 4, dtype=np.uint8),
            )

        sizes_all = np.concatenate(sizes, axis=0)
        snap_d = state['shoot_snap_dists']
        record[spec['index']].update({
            'crownFootprintSquareMetres': round(footprint, 1),
            'botanicalLeafScale': round(botanical_scale, 3),
            'leafBladeMetres': [round(float(v), 3) for v in np.median(sizes_all, axis=0)],
            'singleLeavesPlaced': int(len(sizes_all)),
            'leavesGrown': int(len(organs_grown.position)),
            'phyllotaxyDegrees': round(float(np.degrees(plan.phyllotaxy)), 2),
            'budsPerNode': int(plan.buds_per_node),
            'foliagePlanarity': round(float(plan.foliage_planarity), 2),
            'shootBaseToBarkSnapMedianMm': round(float(np.median(snap_d) * 1000.0), 2),
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
    tf._build_tier0_blade_meshes = genomic_blades
    tf._load_cooked_species_maps = lambda species: (None, None)
    tf.write_glb = lambda layers, path, **_: pathlib.Path(path)

    clock = time.perf_counter()
    result = tf.bake_tiered_forest(
        baker_cli._build_subtropical_island_field(), work, stand='portugal', stem='portugal_forest', n_stems=24, seed=42,
        prototype_age=70.0, veteran_age=110.0, growth_mode='isolated', cohorts=('veteran', 'canopy'), resolution=3.0,
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
            'growth': 'each tree alone, every year of its age, with genomic single-leaf placement along 3D woody shoots',
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
