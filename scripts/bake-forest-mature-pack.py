#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Bakes a temperate forest pack (Portugal's, or the northern one) directly from forestmodeler's native grower and hero meshes.

Run from the repository root with forestmodeler's own Python:

    <forestmodeler>/.venv/bin/python scripts/bake-forest-mature-pack.py [--name portugal|northern] \\
        --forestmodeler <a forestmodeler checkout> --work <an empty folder for the baker's own output>

Every prototype is grown by forestmodeler's ColonizingGrower at its pack's latitude (PACKS) and meshed directly
with forestmodeler's own wood at hero tessellation, every living twig through every node (`plant_meshes_fast`,
no budget, straightening or pruning), the shoots its leaves are strung on (`shoot_meshes`), and native leaf
placement (`place_leaves` + `_build_tier0_blade_meshes`) — no glued twigs and no fake leaf scaling. Decimation
happens ONLY afterward in `scripts/prepare-forest-continuum.mjs`.

After this, bake the derived continuum atlas:

    node scripts/prepare-forest-continuum.mjs <name>
"""
import argparse
import concurrent.futures
import copy
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
# Each pack's species and where its canopy cohort grows: the shade-tolerant trees close a grove in a ring, and the
# pioneers grow in a sunlit gap (`gap`: tag, species, seed, age, place; a member whose tag is one of the pack's
# species is kept, and the rest are its neighbours there).
PACKS = {
    'portugal': {
        'latitude': 39.0,
        'species': (
            ('oak', 101, 60, 60),
            ('chestnut', 101, 68, 65),
            ('maple', 101, 48, 48),
            ('elm', 303, 62, 60),
            ('birch', 202, 34, 28),
            ('blueberry', 303, 25, 18),
        ),
        'sprays': {},
        'cooked': (),
        'materials': None,
        'gap': (
            ('birch_nb', 'birch', 611, 28, (0.0, 0.0)),
            ('birch', 'birch', 719, 28, (3.2, 0.0)),
            ('oak_nb', 'oak', 821, 28, (-2.8, 2.4)),
            ('blueberry', 'blueberry', 712, 22, (1.4, -2.2)),
        ),
    },
    # Québec and New England, about 45° north (forestmodeler's northeastern_us_temperate): balsam fir, red maple and
    # red oak close the wood; tamarack and gray birch take the gaps and the bogs' edges, highbush blueberry beneath.
    'northern': {
        'latitude': 45.0,
        'species': (
            ('fir', 101, 60, 60),
            # Red maple bears shade and rises with the fir: planted with it, not twelve years after, or the grove's
            # fir and oak close over it and leave a pole.
            ('maple', 101, 48, 60),
            ('oak', 101, 60, 60),
            ('larch', 404, 50, 40),
            ('birch', 202, 34, 28),
            ('blueberry', 303, 25, 18),
        ),
        # A conifer's needles are drawn as sprays (spray_meshes); its bark and needles are forestmodeler's
        # MaterialCraft maps, and the broadleaves wear the Portugal pack's own, being the same genomes.
        'sprays': {'fir': 'ranked', 'larch': 'tufted'},
        'cooked': ('fir', 'larch'),
        'materials': 'portugal',
        'gap': (
            ('larch', 'larch', 731, 40, (0.0, 0.0)),
            ('birch', 'birch', 719, 28, (3.4, 0.6)),
            ('fir_nb', 'fir', 823, 30, (-3.0, 2.2)),
            ('blueberry', 'blueberry', 712, 22, (1.2, -2.4)),
        ),
    },
}


def prototype_order(specs):
    seeds = tuple((sp, seed) for sp, seed, _, _ in specs)
    return tuple((sp, 'veteran', seed) for sp, seed in seeds) + tuple((sp, 'canopy', seed) for sp, seed in seeds)

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


def _grow_gap_pioneer_stand(source_str, latitude, members, kept):
    """Grow the shade-intolerant pioneers & understory shrub in a sunlit gap competing side-by-side at res=1.0."""
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
    for _yr in range(max(age for _, _, _, age, _ in members)):
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
        if tag in kept:
            tf._recenter_grower_to_local_origin(g)
            h, cr, dbh, basal = _measure_grown(g, float(age))
            out[sp] = (sd, age, plan, g, (h, cr, dbh, basal))
    print(f'  competitive gap pioneer stand finished in {time.perf_counter() - t0:.1f} s', flush=True)
    return out


def _grow_competitive_grove(source_str, specs, gap, latitude):
    """Grow a pack's canopy species in lockstep inside one shared SiteShadowGrid + SiteSoilField at resolution=1.0."""
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
    kept = {tag for tag, *_ in gap if tag in {s[0] for s in specs}}
    canopy_specs = [s for s in specs if s[0] not in kept]
    k_ext = float(np.mean([SPECIES[sp](1).light_extinction for sp, _, _, _ in canopy_specs]))
    shared_shadow = SiteShadowGrid()
    shared_claims = {}
    shared_soil = SiteSoilField()

    # Arrange the canopy trees on a tight intermixed competitive ring (GROVE_SPACING_METRES apart)
    # so they genuinely compete for sky and soil.
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
    # Pioneers & the understory shrub grow in a sunlit competitive gap rather than deep closed shade.
    out.update(_grow_gap_pioneer_stand(source_str, latitude, gap, kept))
    return out


# A conifer bears its needles by the million (a sixty-year balsam fir sixteen million, each 2.4 cm), and drawn one
# by one they would be eighty times an oak's leaves. So a shoot's needles are drawn as sprays: each leafy shoot is
# cut, in order along it, into pieces about as long as its needles reach across (SPRAY_SQUARE times their length,
# so the spray's picture keeps its proportions), and each piece is drawn as sheets folded along its twig, as long as
# the piece and its needles' forward reach and as wide as they spread from it, upper side to the sky their own blades
# face. Its picture is the species' spray (a fir's two ranks of needles, a tamarack's tufts along a long shoot), so a
# sheet is six vertices and four triangles in the same layout as a broadleaf's folded blade, and every needle the
# genome placed is in some spray. A picture shows fewer needles than the piece holds, so the piece takes as many
# sheets as its needles' area needs (at most SPRAY_LAYERS), fanned about the twig as far as they spread out of the
# plane they lie in: the crown is as dense to the eye as the needles grown, and a radial shoot is seen edge on too.
SPRAY_SQUARE = 2.0
SPRAY_LAYERS = 4
SPRAY_FOLD = [[0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 2]]


def spray_meshes(organs, plan, Mesh, cover):
    """`cover`: the share of a sheet its picture covers (the mean of its opacity)."""
    import numpy as np
    n = len(organs.position)
    if n == 0:
        return {}
    P = organs.position.astype(np.float64)
    F = organs.normal.astype(np.float64)
    F /= np.maximum(np.linalg.norm(F, axis=1, keepdims=True), 1e-12)
    B = organs.binormal.astype(np.float64)
    up = np.cross(F, B)
    up /= np.maximum(np.linalg.norm(up, axis=1, keepdims=True), 1e-12)
    length = np.array([a.length for a in plan.leaves])[organs.archetype] * organs.scale.astype(np.float64)

    def sums(group, k, values):
        return np.stack([np.bincount(group, values[:, j], k) for j in range(values.shape[1])], 1)

    def scatter(group, k, values):
        out = np.zeros((k, 3, 3))
        for i in range(3):
            for j in range(i, 3):
                out[:, i, j] = out[:, j, i] = np.bincount(group, values[:, i] * values[:, j], k)
        return out

    # Each shoot's axis: the line its needles stand along, pointing the way they lean (to its tip). A shoot whose
    # needles rise from one point (a spur's tuft, a whorl) has no such line, and takes their own mean direction.
    # A node bearing a frond (a rachis and its side shoots) is many shoots, so needles go by the shoot they sit on.
    shoots = getattr(organs, 'shoot_index', None)
    if shoots is None and float(getattr(plan, 'shoot_leaf_density', 0.0) or 0.0) > 0.0:
        raise SystemExit('this forestmodeler lays fronds but does not say which shoot a needle sits on (Organs.shoot_index)')
    _, g = np.unique(organs.node_index if shoots is None else shoots, return_inverse=True)
    G = int(g.max()) + 1
    count = np.bincount(g, minlength=G).astype(np.float64)
    centre = sums(g, G, P) / count[:, None]
    spread, vectors = np.linalg.eigh(scatter(g, G, P - centre[g]) / count[:, None, None])
    axis = vectors[:, :, 2].copy()
    lean = sums(g, G, F)
    leaning = lean / np.maximum(np.linalg.norm(lean, axis=1, keepdims=True), 1e-12)
    point = np.sqrt(np.maximum(spread[:, 2], 0.0)) < 0.25 * np.bincount(g, length, G) / count
    axis[point] = leaning[point]
    axis[np.einsum('ij,ij->i', axis, lean) < 0] *= -1

    # Long shoots are cut in order along themselves into sprays about as long as they are wide.
    along = np.einsum('ij,ij->i', P - centre[g], axis[g])
    first, last = np.full(G, np.inf), np.full(G, -np.inf)
    np.minimum.at(first, g, along)
    np.maximum.at(last, g, along)
    needle = np.bincount(g, length, G) / count
    order = np.lexsort((along, g))
    first_of = np.r_[0, np.cumsum(count.astype(np.int64))[:-1]]
    rank = np.empty(n, np.int64)
    rank[order] = np.arange(n) - first_of[g[order]]
    pieces = np.minimum(np.maximum(1, np.round((last - first) / (SPRAY_SQUARE * needle))), count).astype(np.int64)
    card = np.r_[0, np.cumsum(pieces)[:-1]][g] + rank * pieces[g] // count.astype(np.int64)[g]
    C = int(card.max()) + 1
    shoot = np.repeat(np.arange(G), pieces)
    held = np.bincount(card, minlength=C).astype(np.float64)
    mid = sums(card, C, P) / held[:, None]
    a = axis[shoot]

    # The piece's plane is the one its needles spread in from the twig, its upper face where their blades face.
    forward = np.einsum('ij,ij->i', F, a[card])
    across = F - forward[:, None] * a[card]
    spread, vectors = np.linalg.eigh(scatter(card, C, across))
    w = vectors[:, :, 2] - np.einsum('ij,ij->i', vectors[:, :, 2], a)[:, None] * a
    lost = np.linalg.norm(w, axis=1) < 1e-6
    w[lost] = np.cross(a[lost], np.where(np.abs(a[lost, 1:2]) < 0.9, [[0.0, 1.0, 0.0]], [[1.0, 0.0, 0.0]]))
    w /= np.maximum(np.linalg.norm(w, axis=1, keepdims=True), 1e-12)
    normal = np.cross(a, w)
    turn = np.einsum('ij,ij->i', normal, sums(card, C, up)) < 0
    w[turn] *= -1
    normal[turn] *= -1

    # As long as the piece of shoot and its needles' forward reach; as wide as they reach from the twig. The picture
    # thins to its ends (its first and last sixth), so a piece with a neighbour reaches a fifth of itself into it, or
    # the shoot would be drawn as beads with gaps between them where its needles run on unbroken.
    t = np.einsum('ij,ij->i', P - mid[card], a[card])
    low = np.full(C, np.inf)
    high = np.full(C, -np.inf)
    np.minimum.at(low, card, t)
    np.maximum.at(high, card, t)
    reach = np.bincount(card, length * np.clip(forward, 0.0, None), C) / held
    sideways = np.abs(np.einsum('ij,ij->i', across, w[card]))
    half_c = 1.35 * np.bincount(card, length * sideways, C) / held + 0.002
    piece = np.arange(C) - np.r_[0, np.cumsum(pieces)[:-1]][shoot]
    span = ((last - first) / pieces)[shoot]
    x0_c = low - 0.003 - np.where(piece > 0, 0.2 * span, 0.0)
    x1_c = high + reach + 0.003 + np.where(piece < pieces[shoot] - 1, 0.2 * span, 0.0)

    # Each sheet's two halves rise from the twig as far as the needles stand out of the piece's plane, measured: a
    # fir's combed ranks lie nearly flat, a tamarack's tufts radiate.
    rise_c = np.clip(np.bincount(card, length * np.abs(np.einsum('ij,ij->i', F, normal[card])), C)
                     / np.maximum(np.bincount(card, length * sideways, C), 1e-9), 0.16, 1.0)

    # As many sheets as the needles' area needs, fanned about the twig over the angle they spread out of the plane
    # (a half turn where they radiate).
    width = np.array([getattr(leaf, 'width', 0.0) or 0.0 for leaf in plan.leaves])[organs.archetype] * organs.scale.astype(np.float64)
    width = np.where(width > 0, width, 0.07 * length)
    needles_area = np.bincount(card, length * width, C)
    sheet_area = (x1_c - x0_c) * 2.0 * half_c * cover
    layers = np.clip(np.round(needles_area / np.maximum(sheet_area, 1e-12)), 1, SPRAY_LAYERS).astype(np.int64)
    fan = np.pi * np.sqrt(np.clip(spread[:, 1] / np.maximum(spread[:, 2], 1e-18), 0.0, 1.0))
    sheet = np.repeat(np.arange(C), layers)
    K = len(sheet)
    layer = np.arange(K) - np.r_[0, np.cumsum(layers)[:-1]][sheet]
    angle = ((layer + 0.5) / layers[sheet] - 0.5) * fan[sheet]
    sw = np.cos(angle)[:, None] * w[sheet] + np.sin(angle)[:, None] * normal[sheet]
    sn = np.cos(angle)[:, None] * normal[sheet] - np.sin(angle)[:, None] * w[sheet]
    x0, x1, half, rise = x0_c[sheet], x1_c[sheet], half_c[sheet], rise_c[sheet]

    lx = np.repeat(np.stack([x0, x1], 1), 3, axis=1)
    ly = np.tile(np.stack([-half, np.zeros(K), half], 1), (1, 2))
    lz = np.abs(ly) * rise[:, None]
    position = (mid[sheet][:, None, :] + lx[..., None] * a[sheet][:, None, :] + ly[..., None] * sw[:, None, :]
                + lz[..., None] * sn[:, None, :])
    fold = np.array(SPRAY_FOLD)
    face = np.cross(position[:, fold[:, 1]] - position[:, fold[:, 0]], position[:, fold[:, 2]] - position[:, fold[:, 0]])
    vertex_normal = np.zeros_like(position)
    for f in range(len(fold)):
        for corner in fold[f]:
            vertex_normal[:, corner] += face[:, f]
    vertex_normal /= np.maximum(np.linalg.norm(vertex_normal, axis=2, keepdims=True), 1e-12)
    uv = np.stack(((lx - x0[:, None]) / (x1 - x0)[:, None], (ly + half[:, None]) / (2.0 * half)[:, None]), axis=2)

    kind = np.zeros(C, np.int64)
    kind[card] = organs.archetype
    kind = kind[sheet]
    meshes = {}
    for i in range(len(plan.leaves)):
        sel = np.flatnonzero(kind == i)
        if not len(sel):
            continue
        k = len(sel)
        meshes[f'foliage_{i}'] = Mesh(
            position[sel].reshape(-1, 3).astype(np.float32), vertex_normal[sel].reshape(-1, 3).astype(np.float32),
            uv[sel].reshape(-1, 2).astype(np.float32), (fold[None] + 6 * np.arange(k)[:, None, None]).reshape(-1, 3).astype(np.int32),
            np.zeros(4 * k, np.uint8), np.ones(4 * k, np.uint8),
        )
    print(f'  {plan.name if hasattr(plan, "name") else "conifer"}: {n:,} needles on {G:,} shoots in {C:,} pieces drawn as '
          f'{K:,} sheets ({np.bincount(layers, minlength=SPRAY_LAYERS + 1)[1:].tolist()} pieces of 1..{SPRAY_LAYERS})', flush=True)
    return meshes


# A broadleaf's leaves are strung along shoots (forestmodeler's place_leaves): a modelled node stands for the shoot
# system round it, and each of its shoots leaves the node's internode once, at one point of its axis, in one
# direction, `reach` long, its `per_shoot` leaves standing at (k + 1/2) of its spacing along it, each off it by its own
# petiole. The skeleton holds no shoot, so the wood had none and the leaves hung beside their twigs, a median 9 cm and
# as far as half a metre from any bark. Each is drawn here as the living tip it is: a tube from its internode's axis to
# half a spacing past its last leaf, the genome's `tip_radius` where it leaves (a living tip's, never more than the
# twig it leaves) and half that at its bud, with the sides the mesher gives the order past the finest and that radius,
# closed at both ends. Where each runs is read back from its leaves exactly: a petiole's foot is the leaf less its
# stand-off, two feet give the shoot's line and the first its base, and a lone leaf's shoot leaves the axis of its
# internode at half a spacing from that foot.
def shoot_meshes(organs, plan, skeleton, Mesh, tess):
    """The shoots `organs`' leaves are strung on, as one bark Mesh (z up), or None for a species whose leaves are not
    borne singly along shoots (a rosette, a fascicle, a frond: its sprays draw its shoots)."""
    import numpy as np
    import gardenplans.organs as organs_module
    from gardenplans.phenology import PEAK_SEASON, foliage_fraction
    if not isinstance(getattr(type(plan), 'branches_laterally', None), property):
        raise SystemExit("this forestmodeler takes a zero branch probability for a palm (PlantPlan.branches_laterally)")
    if not callable(getattr(organs_module, 'shoot_layout', None)):
        raise SystemExit("this forestmodeler strings an opposite pair's leaves one by one (organs.shoot_layout)")
    m = len(organs.position)
    per_point = max(int(getattr(plan, 'leaf_cluster', 1)), 1)
    frond = float(getattr(plan, 'shoot_leaf_density', 0.0) or 0.0) > 0.0
    # The shoot's length, its leaves, and how many share each of its nodes (an opposite pair on the maple), as
    # place_leaves lays them.
    reach, per_shoot, paired = organs_module.shoot_layout(plan, float(getattr(skeleton, 'cluster', 1.0)))
    if not m or per_point > 1 or frond or not plan.branches_laterally or reach <= 1e-6:
        return None
    spacing = reach / per_shoot
    gap = paired * spacing
    out = float(foliage_fraction(plan, PEAK_SEASON))
    if out <= 0.0:
        raise SystemExit('the leaves are placed bare, so their petioles cannot be measured')
    petiole = np.array([a.petiole * a.length for a in plan.leaves])[organs.archetype] * (organs.scale.astype(np.float64) / out)
    foot = organs.position.astype(np.float64) - organs.normal.astype(np.float64) * petiole[:, None]

    # A twig node's leaves, in the order they were placed, are its shoots' in turn, `per_shoot` to a shoot.
    node = np.asarray(organs.node_index, np.int64)
    order = np.argsort(node, kind='stable')
    fresh = np.r_[True, node[order][1:] != node[order][:-1]]
    heads = np.flatnonzero(fresh)
    within = np.arange(m) - np.repeat(heads, np.diff(np.r_[heads, m]))
    shoot, along = np.empty(m, np.int64), np.empty(m, np.int64)
    shoot[order] = np.cumsum(fresh | (within % per_shoot == 0)) - 1
    along[order] = within % per_shoot
    told = getattr(organs, 'shoot_index', None)
    if told is not None and np.all(told >= 0):
        pairs = np.unique(np.stack([shoot, told]), axis=1)
        if len(np.unique(pairs[0])) != pairs.shape[1] or len(np.unique(pairs[1])) != pairs.shape[1]:
            raise SystemExit("the leaves' shoots are not forestmodeler's own (Organs.shoot_index)")
    G = int(shoot.max()) + 1
    count = np.bincount(shoot, minlength=G)
    first, last = np.empty(G, np.int64), np.empty(G, np.int64)
    first[shoot[along == 0]] = np.flatnonzero(along == 0)
    final = along == count[shoot] - 1
    last[shoot[final]] = np.flatnonzero(final)

    direction = foot[last] - foot[first]
    many = count > paired
    direction[many] /= np.linalg.norm(direction[many], axis=1, keepdims=True)
    base = foot[first] - direction * (0.5 * gap)
    # A shoot of one node: where the internode's axis lies half a node's spacing from its foot.
    nodes = skeleton.nodes
    lone = np.flatnonzero(~many)
    if len(lone):
        n = node[first[lone]]
        parent = np.asarray(nodes.parent)[n]
        b = np.asarray(nodes.position, np.float64)[n]
        a = np.where((parent >= 0)[:, None], np.asarray(nodes.position, np.float64)[np.maximum(parent, 0)], b)
        d, w = b - a, a - foot[first[lone]]
        dd, wd, ww = (d * d).sum(1), (w * d).sum(1), (w * w).sum(1)
        disc = wd * wd - dd * (ww - (0.5 * gap) ** 2)
        root = np.sqrt(np.maximum(disc, 0.0))
        safe = np.maximum(dd, 1e-18)
        t_near, t_far = (-wd - root) / safe, (-wd + root) / safe
        t = np.where((disc >= 0) & (t_near >= 0) & (t_near <= 1), t_near,
                     np.where((disc >= 0) & (t_far >= 0) & (t_far <= 1), t_far, np.clip(-wd / safe, 0.0, 1.0)))
        base[lone] = a + d * t[:, None]
        toward = foot[first[lone]] - base[lone]
        direction[lone] = toward / np.maximum(np.linalg.norm(toward, axis=1, keepdims=True), 1e-12)
    strung = base[shoot] + direction[shoot] * ((along // paired + 0.5) * gap)[:, None]
    astray = np.linalg.norm(strung - foot, axis=1)
    if len(astray) and astray.max() > 1e-3:
        raise SystemExit(f'leaves stand {astray.max() * 1000:.1f} mm off the shoots read back from them')
    length = ((count - 1) // paired + 1) * gap
    tip = base + direction * length[:, None]

    # The tubes: a ring where each leaves its twig and one at its bud, a centre closing the first, a point the second.
    r0 = float(plan.tip_radius)
    r1 = 0.5 * r0
    deepest = max(int(axis.order) for axis in skeleton.axes)
    S = int(tess.radial_for(deepest, r0))
    ref = np.where((np.abs(direction[:, 2]) > 0.9)[:, None], [[1.0, 0.0, 0.0]], [[0.0, 0.0, 1.0]])
    e1 = np.cross(direction, ref)
    e1 /= np.linalg.norm(e1, axis=1, keepdims=True)
    e2 = np.cross(direction, e1)
    phi = 2.0 * np.pi * np.arange(S + 1) / S
    around = np.cos(phi)[None, :, None] * e1[:, None, :] + np.sin(phi)[None, :, None] * e2[:, None, :]
    lean = ((r0 - r1) / length)[:, None, None] * direction[:, None, :]
    side_normal = around + lean
    side_normal /= np.linalg.norm(side_normal, axis=2, keepdims=True)
    V = 2 * (S + 1) + 2
    position = np.empty((G, V, 3))
    normal = np.empty((G, V, 3))
    uv = np.zeros((G, V, 2))
    position[:, :S + 1] = base[:, None, :] + around * r0
    position[:, S + 1:2 * S + 2] = tip[:, None, :] + around * r1
    position[:, 2 * S + 2] = base
    position[:, 2 * S + 3] = tip + direction * r1
    normal[:, :S + 1] = side_normal
    normal[:, S + 1:2 * S + 2] = side_normal
    normal[:, 2 * S + 2] = -direction
    normal[:, 2 * S + 3] = direction
    uv[:, :2 * S + 2, 0] = np.tile(phi / (2.0 * np.pi) * tess.u_repeats_for(r0), 2)[None, :]
    uv[:, S + 1:2 * S + 2, 1] = (length * tess.v_scale)[:, None]
    uv[:, 2 * S + 3, 1] = length * tess.v_scale
    i = np.arange(S)
    faces = np.concatenate([
        np.stack([i, i + 1, S + 1 + i], 1), np.stack([i + 1, S + 2 + i, S + 1 + i], 1),
        np.stack([np.full(S, 2 * S + 2), i + 1, i], 1), np.stack([S + 1 + i, S + 2 + i, np.full(S, 2 * S + 3)], 1),
    ])
    F = len(faces)
    print(f'  {G:,} shoots of {m:,} leaves ({int((~many).sum()):,} of one node), {per_shoot} a shoot, {paired} a node every {gap * 100:.1f} cm, '
          f'{r0 * 1000:.1f} mm to {r1 * 1000:.1f} mm, {S} sides: {G * V:,} vertices, {G * F:,} triangles', flush=True)
    return Mesh(
        position.reshape(-1, 3).astype(np.float32), normal.reshape(-1, 3).astype(np.float32), uv.reshape(-1, 2).astype(np.float32),
        (faces[None] + V * np.arange(G)[:, None, None]).reshape(-1, 3).astype(np.int32),
        np.full(G * F, min(deepest + 1, 255), np.uint8), np.zeros(G * F, np.uint8),
    )


def stretch_bark(maps):
    """A square MaterialCraft bark tile, twice down the stem and at the 512 x 1024 of the pack's other barks."""
    import numpy as np
    from PIL import Image
    out = {}
    for key, picture in maps.items():
        tall = np.concatenate([picture, picture], axis=0)
        out[key] = np.asarray(Image.fromarray(tall).resize((512, 1024), Image.Resampling.LANCZOS))
    return out


def tufted_spray(maps, size=256):
    """A tamarack's long shoot: its tuft (the MaterialCraft picture, rising from its spur at the left) set along a
    twig, turned out to either side and one at the tip, their normals turned with them."""
    import numpy as np
    from PIL import Image
    tuft_albedo = Image.fromarray(maps['albedo']).convert('RGBA')
    tuft_normal = np.asarray(Image.fromarray(maps['normal']).convert('RGBA')).astype(np.float64)
    n = tuft_albedo.width
    alpha = np.asarray(tuft_albedo)[..., 3]
    opaque = np.argwhere(alpha > 128)
    base = (int(opaque[:, 1].min()) + 2, int(np.median(opaque[opaque[:, 1] < opaque[:, 1].min() + n // 16][:, 0])))
    spur = np.asarray(tuft_albedo)[..., :3][alpha > 128][(opaque[:, 1] < base[0] + n // 14)].mean(axis=0)
    big = 2 * size
    albedo = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    normal = Image.new('RGBA', (big, big), (128, 128, 255, 255))
    twig = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    from PIL import ImageDraw
    ImageDraw.Draw(twig).rectangle([0, big // 2 - big // 90, big, big // 2 + big // 90], fill=(*[int(c) for c in spur], 255))
    albedo.alpha_composite(twig)
    tufts = [(0.08 + 0.12 * k, (40.0 + 12.0 * (k % 3)) * (1 if k % 2 else -1)) for k in range(6)] + [(0.78, 0.0)]
    for u, angle in tufts:
        scale = 0.5 * big / (n - base[0])
        pad = Image.new('RGBA', (2 * n, 2 * n), (0, 0, 0, 0))
        pad.paste(tuft_albedo, (n - base[0], n - base[1]))
        c, s = np.cos(np.radians(angle)), np.sin(np.radians(angle))
        nx, ny = tuft_normal[..., 0] / 127.5 - 1.0, -(tuft_normal[..., 1] / 127.5 - 1.0)
        turned = tuft_normal.copy()
        turned[..., 0] = (c * nx - s * ny + 1.0) * 127.5
        turned[..., 1] = (-(s * nx + c * ny) + 1.0) * 127.5
        turned[..., 3] = alpha
        pad_normal = Image.new('RGBA', (2 * n, 2 * n), (128, 128, 255, 0))
        pad_normal.paste(Image.fromarray(np.clip(turned, 0, 255).astype(np.uint8)), (n - base[0], n - base[1]))
        side = max(2, int(2 * n * scale))
        at = (int(u * big) - side // 2, big // 2 - side // 2)
        for layer, target in ((pad, albedo), (pad_normal, normal)):
            placed = layer.rotate(angle, resample=Image.Resampling.BICUBIC, center=(n, n)).resize((side, side), Image.Resampling.LANCZOS)
            sheet = Image.new('RGBA', (big, big), (0, 0, 0, 0))
            sheet.paste(placed, at)
            target.alpha_composite(sheet)
    albedo = albedo.resize((size, size), Image.Resampling.LANCZOS)
    normal = normal.resize((size, size), Image.Resampling.LANCZOS)
    return {'albedo': np.asarray(albedo), 'normal': np.asarray(normal)}


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
    parser.add_argument('--name', default='portugal', choices=sorted(PACKS), help='which pack to grow (PACKS)')
    parser.add_argument('--pack', help='the pack folder to rewrite (default assets/forest-scenery/<name>); its pictures and materials are kept')
    parser.add_argument('--revision', help='the forestmodeler commit, when the checkout is a copy without its history')
    args = parser.parse_args()
    source = pathlib.Path(args.forestmodeler).resolve()
    revision = args.revision or subprocess.run(['git', '-C', str(source), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip() or None
    unsaved = subprocess.run(['git', '-C', str(source), 'diff', 'HEAD'], capture_output=True).stdout
    grower = (revision, hashlib.sha256(unsaved).hexdigest()) if revision else \
        hashlib.sha256(b''.join(f.read_bytes() for f in sorted(source.rglob('*.py')))).hexdigest()
    work = pathlib.Path(args.work).resolve()
    pack = pathlib.Path(args.pack or f'assets/forest-scenery/{args.name}').resolve()
    SPECIES_SPECS, GAP, LATITUDE = PACKS[args.name]['species'], PACKS[args.name]['gap'], PACKS[args.name]['latitude']
    PROTOTYPE_ORDER = prototype_order(SPECIES_SPECS)
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

    # A pack being rewritten keeps its pictures and materials; a new one takes them from forestmodeler's bake, and its
    # broadleaves wear those of the pack it names (PACKS[...]['materials']), being the same genomes.
    SPRAYS, COOKED, BORROWED = PACKS[args.name]['sprays'], PACKS[args.name]['cooked'], PACKS[args.name]['materials']
    before = json.loads((pack / 'manifest.json').read_text()) if (pack / 'manifest.json').exists() else None
    if before and [(p['species'], p['cohort']) for p in before['prototypes']] != [(s[0], s[1]) for s in PROTOTYPE_ORDER]:
        raise SystemExit('The pack does not hold these prototypes in this order')
    lender = pack.parent / BORROWED if BORROWED else None
    lent = {(p['species'], p['cohort']): p['nativeMaterials'] for p in json.loads((lender / 'manifest.json').read_text())['prototypes']} if lender else {}

    work.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    # Grow Track A (6 open-grown stand-alone trees in parallel at res=1.0, spc=2) AND Track B (1 competitive
    # intermixed 6-species grove sharing SiteShadowGrid + SiteSoilField at res=1.0, spc=2) concurrently!
    # Named for what was grown and the forestmodeler that grew it (its commit and any change not yet committed), so a
    # changed species, age, seed, gap or genome grows afresh instead of reading a stale grove.
    grown_key = hashlib.sha256(repr((SPECIES_SPECS, GAP, LATITUDE, grower)).encode()).hexdigest()[:12]
    cache_pkl = work / f'grown_res1_open_and_grove_{grown_key}.pkl'
    open_by_species, grove_by_species = {}, {}
    if cache_pkl.exists():
        open_by_species, grove_by_species = pickle.loads(cache_pkl.read_bytes())
        print(f'loaded cached res=1.0 open + competitive grove skeletons from {cache_pkl}', flush=True)
    else:
        open_jobs = [(str(source), sp, seed, open_age, LATITUDE) for sp, seed, open_age, _ in SPECIES_SPECS]
        with concurrent.futures.ProcessPoolExecutor(max_workers=len(open_jobs) + 1) as pool:
            grove_fut = pool.submit(_grow_competitive_grove, str(source), SPECIES_SPECS, GAP, LATITUDE)
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

    # Pass grower.env into forestmodeler's real place_leaves so sun/shade leaf plasticity is active; placed once a
    # tree, so its shoots (the wood's) and its blades are strung from the same leaves.
    placed = {}

    def native_env_leaves(skel, age, plan, **options):
        key = (id(skel), float(age))
        if key not in placed:
            g = grower_of_skel.get(id(skel))
            placed[key] = native_place_leaves(skel, float(age), plan, env=g.env if g is not None else options.get('env'))
        return placed[key]

    # forestmodeler's own wood mesher (omitting only the underground root networks, so a prototype's bound stays its
    # trunk and crown), sweeping every living twig through every node: hero's tessellation and none of its economies.
    # Its 450,000-triangle budget is met by straightening rings off the twigs until the tree fits, which took 21% of
    # the veteran oak's internodes its shoots leave from as far as 13 cm off them, and its pruning drops leafless
    # twigs under 5.6% of the trunk's radius. A cap on one tree's detail is no part of the continuum's source (its cut
    # economises, AGENTS.md rule 3), and the finest cut is the physical truth. The shoots the leaves are strung on
    # (shoot_meshes) are its finest bark.
    from gardenplans.lod import HERO
    from gardenplans.mesh import Mesh, concat
    whole = dataclasses.replace(HERO, name='hero-whole', min_radius=0.0, straighten=0.0, budget=0)
    plan_of_grower = {id(grower): plan for _, _, _, _, plan, grower in grown}

    def native_hero_meshes(grower, age, **options):
        shoot, *rest = real_meshes(grower, float(age), roots=False, leaves=False, lod=whole, separate_wounds=True)
        plan = plan_of_grower[id(grower)]
        tubes = shoot_meshes(native_env_leaves(grower.skeleton, age, plan), plan, grower.skeleton, Mesh, whole.tess)
        return (shoot if tubes is None else concat(shoot, tubes), *rest)

    # Use forestmodeler's REAL native_tree_render.blade_meshes at 1:1 native single-leaf scale (cluster=1.0): each
    # veteran oak, chestnut or elm carries 200k–408k real individual folded leaves.
    species_of_plan = {id(plan): species for _, species, _, _, plan, _ in grown}

    covers = {}

    def native_hero_blades(organs, plan, cluster, **_):
        species = species_of_plan.get(id(plan))
        if species in SPRAYS:
            if species not in covers:
                covers[species] = float((np.asarray(pack_cooked_maps(species)[1]['albedo'])[..., 3] / 255.0).mean())
            return spray_meshes(organs, plan, Mesh, covers[species])
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
    cooked_maps = tf._load_cooked_species_maps

    def pack_cooked_maps(species):
        if species not in COOKED:
            return None, None
        bark, foliage = cooked_maps(species)
        if bark is not None:
            bark = stretch_bark(bark)
        if foliage is not None and SPRAYS.get(species) == 'tufted':
            foliage = tufted_spray(foliage)
        return bark, foliage

    tf._load_cooked_species_maps = pack_cooked_maps
    tf.write_glb = lambda layers, path, **_: pathlib.Path(path)

    clock = time.perf_counter()
    result = tf.bake_tiered_forest(
        baker_cli._build_subtropical_island_field(), work, stem=f'{args.name}_forest', n_stems=24, seed=42,
        **({'stand': 'portugal'} if args.name == 'portugal' else {'species_weights': {sp: 1.0 for sp, *_ in SPECIES_SPECS}}),
        prototype_age=60.0, veteran_age=65.0, growth_mode='dense_interspecies', cohorts=('veteran', 'canopy'), resolution=1.0,
        field_cell_m=FIELD_CELL_METRES, latitude=LATITUDE,
    )
    print(f'baked in {time.perf_counter() - clock:.0f} s', flush=True)

    baked = result['forest_instances_manifest']
    fold = np.array([0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2], dtype=np.uint32)
    vertices, indices, prototypes, vertex_at, index_at = [], [], [], 0, 0
    def materials_of(entry):
        species, cohort = entry['species'], entry['cohort']
        if (species, cohort) in lent:
            chosen, folder = lent[(species, cohort)], lender
        else:
            # A canopy tree wears its veteran's pictures, as the Portugal pack's do.
            chosen = copy.deepcopy(next(e for e in baked['prototypes'] if e['species'] == species and e['cohort'] == 'veteran')['nativeMaterials'])
            folder = work
            if species in SPRAYS:
                for material in chosen:
                    if material['name'].startswith('foliage'):
                        material['opacityThreshold'] = 0.35
        for material in chosen:
            for key in ('albedo', 'normal', 'roughnessMap'):
                if isinstance(material.get(key), dict) and not (pack / material[key]['file']).exists():
                    shutil.copyfile(folder / material[key]['file'], pack / material[key]['file'])
        return chosen

    pack.mkdir(parents=True, exist_ok=True)
    for entry, made, spec in zip(baked['prototypes'], result['prototypes'], record):
        was = before['prototypes'][entry['id']] if before else {'nativeMaterials': materials_of(entry)}
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

    manifest = {
        **{key: baked[key] for key in ('format', 'version', 'materialContract', 'units', 'upAxis', 'vertexStride', 'rootStride', 'rootCount', 'appearanceErrorSupported', 'coverage')},
        'stature': 'full-grown',
        'files': files,
        'prototypes': prototypes,
        'volume': receipts['volumes'],
        'middle': receipts['middle'],
        'bake': {
            'script': 'scripts/bake-forest-mature-pack.py',
            'pack': args.name,
            'forestmodeler': revision,
            'growth': 'native forestmodeler ColonizingGrower at resolution=1.0, steps_per_cycle=2: open-grown stand-alone trees (veteran) + lockstep intermixed competitive stand sharing SiteShadowGrid & SiteSoilField (canopy) + whole hero wood (unpruned, unstraightened) + shoot tubes under every leaf + native_tree_render.blade_meshes',
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
