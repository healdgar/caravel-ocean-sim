# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""The crew skeleton: Unreal 5's 80-joint body, as Tripo rigs it with --spec unreal, and 13 face joints under the head.

js/crew-skeleton.js holds the same list for the runtime; tests/crew-skeleton.test.mjs holds the two together. The
order is the skin's joint order: every joint follows its parent, and every joint is followed by all its
descendants, which the GPU pose pass walks as runs. Imported by scripts/extend-crew-skeleton.py and
scripts/fit-crew-body.py.
"""
import numpy as np

FACE_JOINTS = (
    'FACIAL_C_Jaw', 'FACIAL_C_LipLower', 'FACIAL_C_LipUpper', 'FACIAL_L_LipCorner', 'FACIAL_R_LipCorner',
    'FACIAL_L_Eye', 'FACIAL_R_Eye', 'FACIAL_L_EyelidUpper', 'FACIAL_L_EyelidLower',
    'FACIAL_R_EyelidUpper', 'FACIAL_R_EyelidLower', 'FACIAL_L_Brow', 'FACIAL_R_Brow',
)


def _arm(side):
    out = [(f'clavicle{side}', 'spine_05'), (f'upperarm{side}', f'clavicle{side}'),
           (f'upperarm_twist_01{side}', f'upperarm{side}'), (f'upperarm_twist_02{side}', f'upperarm{side}'),
           (f'lowerarm{side}', f'upperarm{side}'),
           (f'lowerarm_twist_01{side}', f'lowerarm{side}'), (f'lowerarm_twist_02{side}', f'lowerarm{side}'),
           (f'hand{side}', f'lowerarm{side}')]
    for finger in ('index', 'middle', 'pinky', 'ring'):
        out.append((f'{finger}_metacarpal{side}', f'hand{side}'))
        out += [(f'{finger}_0{k}{side}', f'{finger}_metacarpal{side}' if k == 1 else f'{finger}_0{k - 1}{side}') for k in (1, 2, 3)]
    out += [(f'thumb_0{k}{side}', f'hand{side}' if k == 1 else f'thumb_0{k - 1}{side}') for k in (1, 2, 3)]
    return out


def _leg(side):
    return [(f'thigh{side}', 'pelvis'), (f'thigh_twist_01{side}', f'thigh{side}'), (f'thigh_twist_02{side}', f'thigh{side}'),
            (f'calf{side}', f'thigh{side}'), (f'calf_twist_01{side}', f'calf{side}'), (f'calf_twist_02{side}', f'calf{side}'),
            (f'foot{side}', f'calf{side}'), (f'ball{side}', f'foot{side}')]


# (joint, parent) in skin order.
SKELETON = tuple(
    [('root', None), ('pelvis', 'root'), ('spine_01', 'pelvis'), ('spine_02', 'spine_01'), ('spine_03', 'spine_02'),
     ('spine_04', 'spine_03'), ('spine_05', 'spine_04'), ('neck_01', 'spine_05'), ('neck_02', 'neck_01'), ('head', 'neck_02')]
    + [(name, 'FACIAL_C_Jaw' if name == 'FACIAL_C_LipLower' else 'head') for name in FACE_JOINTS]
    + _arm('_l') + _arm('_r') + _leg('_l') + _leg('_r'))
JOINTS = tuple(name for name, _ in SKELETON)
PARENT = dict(SKELETON)
assert len(JOINTS) == 93 and len(set(JOINTS)) == 93

# Where each joint the 65-joint classic rig lacks sits, as a fraction of the way along a span of joints it has.
# Unreal's twist joints: an upper limb's _01 is near its root, a lower limb's _01 near its far end.
INSERTED = {}
for _s in ('_l', '_r'):
    INSERTED[f'upperarm_twist_01{_s}'] = (f'upperarm{_s}', f'lowerarm{_s}', 1 / 3)
    INSERTED[f'upperarm_twist_02{_s}'] = (f'upperarm{_s}', f'lowerarm{_s}', 2 / 3)
    INSERTED[f'lowerarm_twist_01{_s}'] = (f'lowerarm{_s}', f'hand{_s}', 2 / 3)
    INSERTED[f'lowerarm_twist_02{_s}'] = (f'lowerarm{_s}', f'hand{_s}', 1 / 3)
    INSERTED[f'thigh_twist_01{_s}'] = (f'thigh{_s}', f'calf{_s}', 1 / 3)
    INSERTED[f'thigh_twist_02{_s}'] = (f'thigh{_s}', f'calf{_s}', 2 / 3)
    INSERTED[f'calf_twist_01{_s}'] = (f'calf{_s}', f'foot{_s}', 2 / 3)
    INSERTED[f'calf_twist_02{_s}'] = (f'calf{_s}', f'foot{_s}', 1 / 3)
    for _f in ('index', 'middle', 'pinky', 'ring'):
        INSERTED[f'{_f}_metacarpal{_s}'] = (f'hand{_s}', f'{_f}_01{_s}', 0.42)
INSERTED['spine_04'] = ('spine_03', 'neck_01', 1 / 3)
INSERTED['spine_05'] = ('spine_03', 'neck_01', 2 / 3)
INSERTED['neck_02'] = ('neck_01', 'head', 1 / 2)


def face_landmarks(points, head_weight, head_joint):
    """Where the face joints sit on a body at rest: metres, +Y up, +Z the way the body faces.

    points: (n, 3) vertices; head_weight: (n,) how much each is carried by the head; head_joint: the head joint's
    place. Reads the face's midline profile for the nose and mouth and the eye sockets either side of it, so a
    sculpted face and a painted one both place their joints on the features they have.
    """
    on = head_weight > 0.45
    head = points[on] if on.sum() >= 50 else points[head_weight > 0.2]
    top = float(head[:, 1].max())
    span = max(top - float(head_joint[1]), 0.12)
    scale = span / 0.205  # an adult head, joint to crown
    front = float(np.percentile(head[:, 2], 97))
    back = float(np.percentile(head[:, 2], 3))
    mid_z = 0.5 * (front + back)
    # The face is read from every vertex in front of the head, whatever carries it: a rig may give the lips and chin
    # to the neck. The nose tip may sit anywhere from level with the head joint to well above it.
    hy = float(head_joint[1])
    face = points[(points[:, 1] > hy - 0.11 * scale) & (points[:, 1] < top + 0.005) & (np.abs(points[:, 0] - float(head_joint[0])) < 0.10 * scale) & (points[:, 2] > back)]
    # The face's own midline runs through its nose tip, which need not be over the head joint.
    cx = float(head_joint[0])
    nose_band = face[(np.abs(face[:, 0] - cx) < 0.03 * scale) & (face[:, 1] > hy - 0.01 * scale) & (face[:, 1] < hy + 0.55 * span)]
    if len(nose_band):
        cx = float(nose_band[int(np.argmax(nose_band[:, 2])), 0])

    # The midline profile: the farthest-forward point in each 2 mm band of height.
    strip = face[np.abs(face[:, 0] - cx) < 0.007 * scale]
    lo_y, hi_y = hy - 0.11 * scale, hy + 0.75 * span
    bands = np.arange(lo_y, hi_y, 0.002)
    profile = np.full(len(bands), -np.inf)
    which = np.clip(((strip[:, 1] - lo_y) / 0.002).astype(int), 0, len(bands) - 1)
    inside = (strip[:, 1] >= lo_y) & (strip[:, 1] < hi_y)
    np.maximum.at(profile, which[inside], strip[inside, 2])
    have = np.isfinite(profile)
    if have.sum() >= 8:
        profile = np.interp(bands, bands[have], profile[have])
    else:
        profile = np.full(len(bands), front)
    smooth = np.convolve(profile, np.ones(3) / 3, mode='same')

    def band_range(a, b):
        return (bands >= a) & (bands <= b)

    nose_zone = band_range(hy - 0.01 * scale, hy + 0.62 * span)
    nose_i = int(np.argmax(np.where(nose_zone, smooth, -np.inf)))
    nose_y, nose_z = float(bands[nose_i]), float(smooth[nose_i])
    # The mouth. Down the profile from the nose tip come the dip under the nose, the upper lip, the line between the
    # lips, the lower lip and the chin: the mouth is the second dip. Full lips can make the line between them
    # shallower than the dip under the nose, so the dips are counted, not compared.
    fine_lo = nose_y - 0.065 * scale
    fine = np.arange(fine_lo, nose_y, 0.001)
    near = strip[(strip[:, 1] >= fine_lo) & (strip[:, 1] < nose_y)]
    fine_z = np.full(len(fine), -np.inf)
    np.maximum.at(fine_z, np.clip(((near[:, 1] - fine_lo) / 0.001).astype(int), 0, len(fine) - 1), near[:, 2])
    seen = np.isfinite(fine_z)
    mouth_y = None
    if seen.sum() >= 12:
        fine_z = np.convolve(np.interp(fine, fine[seen], fine_z[seen]), np.ones(3) / 3, mode='same')
        extremes = []  # (index, +1 a rise, -1 a dip), from the nose down
        for i in range(len(fine) - 3, 1, -1):
            if fine_z[i] < fine_z[i - 1] and fine_z[i] <= fine_z[i + 1]:
                extremes.append((i, -1))
            elif fine_z[i] > fine_z[i - 1] and fine_z[i] >= fine_z[i + 1]:
                extremes.append((i, 1))
        # Keep only turns of half a millimetre or more.
        kept = []
        for i, kind in extremes:
            if kept and kept[-1][1] == kind:
                if (kind < 0) == (fine_z[i] < fine_z[kept[-1][0]]):
                    kept[-1] = (i, kind)
            elif not kept or abs(fine_z[i] - fine_z[kept[-1][0]]) >= 0.0005 * scale:
                kept.append((i, kind))
        dips = [i for i, kind in kept if kind < 0]
        if len(dips) >= 2 and nose_y - fine[dips[1]] < 0.050 * scale:
            mouth_y = float(fine[dips[1]])
    if mouth_y is None:
        # Fall back on the deepest point of the profile 18 to 45 mm below the nose tip, nearest 30 mm below it.
        mouth_zone = band_range(nose_y - 0.045 * scale, nose_y - 0.018 * scale)
        depth = np.where(mouth_zone, -smooth + 0.15 * np.abs(bands - (nose_y - 0.030 * scale)), -np.inf)
        mouth_i = int(np.argmax(depth))
        mouth_y = float(bands[mouth_i]) if np.isfinite(depth[mouth_i]) else nose_y - 0.030 * scale
    lips_z = float(np.max(np.where(band_range(mouth_y - 0.010 * scale, mouth_y + 0.010 * scale), smooth, -np.inf)))
    if not np.isfinite(lips_z):
        lips_z = nose_z - 0.012 * scale
    # The chin: the lowest point of the profile still well in front of the throat.
    chin_zone = band_range(mouth_y - 0.075 * scale, mouth_y - 0.020 * scale) & (smooth > mid_z + 0.045 * scale)
    chin_y = float(bands[chin_zone].min()) if chin_zone.any() else mouth_y - 0.045 * scale

    # The eyes: just below the nasion, the deepest point of the profile between the brow and the nose, and each
    # where the eyeball bulges forward between the nose bridge and the temple at that height.
    nasion_zone = band_range(nose_y + 0.020 * scale, nose_y + 0.070 * scale)
    nasion_i = int(np.argmax(np.where(nasion_zone, -smooth, -np.inf)))
    eye_y = float(bands[nasion_i]) - 0.004 * scale if nasion_zone.any() else float(head_joint[1]) + 0.40 * span
    row = face[(np.abs(face[:, 1] - eye_y) < 0.003 * scale) & (face[:, 2] > mid_z)]
    eye_dx = 0.032 * scale
    if len(row) >= 20:
        # Outward from the nose bridge at eye height the face falls into the inner corner of the eye, rises over the
        # eyeball and falls away to the temple: the eye is the rise after the deepest fall.
        found = []
        for sign in (1.0, -1.0):
            side = row[(sign * (row[:, 0] - cx) > 0.006 * scale) & (sign * (row[:, 0] - cx) < 0.048 * scale)]
            if len(side) < 12:
                continue
            cols = np.round((side[:, 0] - cx) * sign / 0.0015).astype(int)
            best = {}
            for c, zz in zip(cols, side[:, 2]):
                best[c] = max(best.get(c, -np.inf), zz)
            keys = np.array(sorted(best))
            zs = np.convolve([best[k] for k in keys], np.ones(3) / 3, mode='same')
            dist = keys * 0.0015
            inner = (dist > 0.008 * scale) & (dist < 0.028 * scale)
            if not inner.any():
                continue
            corner = dist[inner][int(np.argmin(zs[inner]))]
            outer = (dist > corner + 0.006 * scale) & (dist < 0.046 * scale)
            if outer.any():
                found.append(float(dist[outer][int(np.argmax(zs[outer]))]))
        if found:
            eye_dx = float(np.clip(np.mean(found), 0.026 * scale, 0.040 * scale))

    def surface_z(x, y, r):
        near = face[(np.abs(face[:, 0] - x) < r) & (np.abs(face[:, 1] - y) < r)]
        return float(near[:, 2].max()) if len(near) else front - 0.02 * scale

    out = {}
    out['FACIAL_C_Jaw'] = np.array([cx, nose_y - 0.006 * scale, mid_z + 0.004 * scale])
    out['FACIAL_C_LipUpper'] = np.array([cx, mouth_y + 0.007 * scale, lips_z - 0.007 * scale])
    out['FACIAL_C_LipLower'] = np.array([cx, mouth_y - 0.008 * scale, lips_z - 0.008 * scale])
    for side, sign in (('L', 1.0), ('R', -1.0)):
        x = cx + sign * eye_dx
        eye_surface = surface_z(x, eye_y, 0.006 * scale)
        eye = np.array([x, eye_y, eye_surface - 0.012 * scale])
        out[f'FACIAL_{side}_Eye'] = eye
        out[f'FACIAL_{side}_EyelidUpper'] = eye.copy()
        out[f'FACIAL_{side}_EyelidLower'] = eye.copy()
        bx = cx + sign * eye_dx * 0.95
        out[f'FACIAL_{side}_Brow'] = np.array([bx, eye_y + 0.017 * scale, surface_z(bx, eye_y + 0.017 * scale, 0.006 * scale) - 0.006 * scale])
        lx = cx + sign * 0.026 * scale
        out[f'FACIAL_{side}_LipCorner'] = np.array([lx, mouth_y, surface_z(lx, mouth_y, 0.005 * scale) - 0.005 * scale])
    measures = {'scale': scale, 'cx': cx, 'nose': (nose_y, nose_z), 'mouth_y': mouth_y, 'lips_z': lips_z, 'chin_y': chin_y,
                'eye_y': eye_y, 'eye_dx': eye_dx, 'mid_z': mid_z, 'front': front, 'top': top}
    return out, measures
