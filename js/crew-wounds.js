// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Wounds that belong to one body: which sailor a shot actually met, arrows that stay
// where they struck, and limbs lost or broken by round shot. A wound arrives as a
// pending hit in actor space. The first pose after it finds the nearest bone there and
// bakes the wound onto that bone, so it follows the body from then on.
import { gltfQuatMultiply } from './gltf.js';

const CREW_WOUND_BONES = Object.freeze(['pelvis', 'spine_01', 'spine_02', 'spine_03', 'Head', 'upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r', 'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r']);
// The joint a limb parts at when a ball strikes that bone.
const CREW_LIMB_JOINTS = Object.freeze({
  upperarm_l: 'upperarm_l', lowerarm_l: 'lowerarm_l', hand_l: 'lowerarm_l',
  upperarm_r: 'upperarm_r', lowerarm_r: 'lowerarm_r', hand_r: 'lowerarm_r',
  thigh_l: 'thigh_l', calf_l: 'calf_l', foot_l: 'calf_l',
  thigh_r: 'thigh_r', calf_r: 'calf_r', foot_r: 'calf_r',
});
const CREW_CRUSHED_SCALE = Object.freeze([1.18, 0.62, 0.7]);
const CREW_BROKEN_ANGLE = 1.15;
const CREW_ARROW_LENGTH = 0.66;
export const CREW_ARROWS_PER_BODY = 3;
// Chances that a direct hit from a ball takes or wrecks what it strikes.
export const CREW_BALL_SEVER_CHANCE = 0.55;
export const CREW_BALL_BREAK_CHANCE = 0.3;
export const CREW_BALL_CRUSH_CHANCE = 0.6;
export const CREW_SPLINTER_BREAK_CHANCE = 0.35;
export const CREW_FALL_BREAK_CHANCE = 0.7;

const woundClamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function crewBodyHeight(s) {
  const scale = s.scale?.[1] ?? 1;
  if ((s.knockdownTimer ?? 0) > 0) return 0.5 * scale;
  return (s.seatedPose ? 1.15 : 1.72) * scale;
}

// Bodies a segment passes through, nearest first, in the same frame as the sailors'
// positions. A body is an upright capsule. Only those before `limit` count, since
// whatever the shot strikes first shields anyone behind it.
export function sweepCrewBodies(from, to, radius, crew, limit = 1) {
  const hits = [];
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], flat = dx * dx + dz * dz;
  for (const s of crew ?? []) {
    if (s.visible === false || s.casualtyState === 'fallen' || !s.position) continue;
    const wx = from[0] - s.position[0], wz = from[2] - s.position[2];
    const t = flat > 1e-9 ? woundClamp(-(wx * dx + wz * dz) / flat, 0, 1) : 0;
    if (t > limit) continue;
    const y = from[1] + dy * t, base = s.position[1];
    const above = Math.max(base - y, 0, y - (base + crewBodyHeight(s)));
    const reach = radius + 0.2 * (s.scale?.[0] ?? 1);
    if (Math.hypot(wx + dx * t, above, wz + dz * t) > reach) continue;
    hits.push({ sailor: s, fraction: t, point: [from[0] + dx * t, y, from[2] + dz * t] });
  }
  return hits.sort((a, b) => a.fraction - b.fraction);
}

// Boat-local metres to the sailor's own frame, where the skeleton is posed.
function crewWoundActorPoint(p, s) {
  const dx = p[0] - s.position[0], dy = p[1] - s.position[1], dz = p[2] - s.position[2];
  const c = Math.cos(s.yaw ?? 0), sn = Math.sin(s.yaw ?? 0), pitch = s.climbPitch ?? 0, cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x = c * dx - sn * dz, z = sn * dx + c * dz, sx = s.scale?.[0] ?? 1, sy = s.scale?.[1] ?? 1, sz = s.scale?.[2] ?? 1;
  return [x / sx, (cp * dy + sp * z) / sy, (-sp * dy + cp * z) / sz];
}
function crewWoundActorDirection(d, s) {
  const c = Math.cos(s.yaw ?? 0), sn = Math.sin(s.yaw ?? 0), n = Math.hypot(d[0], d[1], d[2]) || 1;
  return [(c * d[0] - sn * d[2]) / n, d[1] / n, (sn * d[0] + c * d[2]) / n];
}
function crewWoundBoatPoint(p, s) {
  const x = p[0] * (s.scale?.[0] ?? 1), y = p[1] * (s.scale?.[1] ?? 1), z = p[2] * (s.scale?.[2] ?? 1);
  const c = Math.cos(s.yaw ?? 0), sn = Math.sin(s.yaw ?? 0), pitch = s.climbPitch ?? 0, cp = Math.cos(pitch), sp = Math.sin(pitch), Y = cp * y - sp * z, Z = sp * y + cp * z;
  return [s.position[0] + c * x + sn * Z, s.position[1] + Y, s.position[2] - sn * x + c * Z];
}

// Queue a hit for the next pose. `kind` is 'arrow', 'ball', 'splinter' or 'fall'; `roll` is 0 to 1.
export function recordCrewWound(s, kind, point, direction, roll = 0) {
  if (!s?.position) return;
  (s.pendingWounds ??= []).push({ kind, point: crewWoundActorPoint(point, s), direction: crewWoundActorDirection(direction ?? [0, 0, 1], s), roll });
}

export function clearCrewWounds(s) {
  s.pendingWounds = null;
  s.stuckArrows = null;
  s.stuckArrowPoses = null;
  s.crewInjuries = null;
}

// What a hit does to the bone it found. Pure, so the chances can be tested directly.
export function crewWoundOutcome(kind, bone, roll) {
  const joint = CREW_LIMB_JOINTS[bone];
  if (kind === 'ball') {
    if (joint) {
      if (roll < CREW_BALL_SEVER_CHANCE) return { kind: 'severed', bone: joint };
      if (roll < CREW_BALL_SEVER_CHANCE + CREW_BALL_BREAK_CHANCE) return { kind: 'broken', bone: joint };
      return null;
    }
    return roll < CREW_BALL_CRUSH_CHANCE ? { kind: 'crushed', bone: 'spine_03' } : null;
  }
  if (kind === 'splinter' && joint && roll < CREW_SPLINTER_BREAK_CHANCE) return { kind: 'broken', bone: joint };
  if (kind === 'fall' && joint && roll < CREW_FALL_BREAK_CHANCE) return { kind: 'broken', bone: joint };
  return null;
}

const woundMatrixPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const woundMatrixVector = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
];
// Inverse of the matrix's upper 3x3, applied to a vector. Null for a collapsed bone.
function woundMatrixUnrotate(m, v) {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-6) return null;
  return [
    (A * v[0] + (c * h - b * i) * v[1] + (b * f - c * e) * v[2]) / det,
    (B * v[0] + (a * i - c * g) * v[1] + (c * d - a * f) * v[2]) / det,
    (C * v[0] + (b * g - a * h) * v[1] + (a * e - b * d) * v[2]) / det,
  ];
}
function nearestWoundBone(a, point) {
  let best = null, bestDistance = Infinity;
  for (const name of CREW_WOUND_BONES) {
    const node = a.nodeIndex(name);
    if (node < 0) continue;
    const m = a.world[node];
    if (Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]) < 0.01) continue; // already lost
    const distance = Math.hypot(m[12] - point[0], m[13] - point[1], m[14] - point[2]);
    if (distance < bestDistance) { best = name; bestDistance = distance; }
  }
  return best;
}
function poseCrewInjury(a, injury) {
  const node = a.nodeIndex(injury.bone);
  if (node < 0) return;
  const pose = a.pose[node];
  if (injury.kind === 'severed') {
    pose.s.fill(0.001);
  } else if (injury.kind === 'crushed') {
    pose.s.set(CREW_CRUSHED_SCALE);
  } else if (injury.kind === 'broken') {
    const half = CREW_BROKEN_ANGLE * 0.5, out = new Float32Array(4);
    gltfQuatMultiply(out, pose.r, [Math.sin(half), 0, 0, Math.cos(half)]);
    pose.r.set(out);
  }
  if (a.updateBranch) a.updateBranch(node); else a.update();
}

// Runs once per posed sailor, after every other pose step and before the palette is
// copied. The next sailor's animation sample restores the shared skeleton.
export function applyCrewWounds(a, s) {
  for (const injury of s.crewInjuries ?? []) poseCrewInjury(a, injury);
  if (s.pendingWounds?.length) {
    for (const wound of s.pendingWounds) {
      const bone = nearestWoundBone(a, wound.point);
      if (!bone) continue;
      if (wound.kind === 'arrow') {
        const m = a.world[a.nodeIndex(bone)], m4 = [m[12], m[13], m[14]];
        const offset = woundMatrixUnrotate(m, wound.point.map((v, i) => v - m4[i]));
        const direction = woundMatrixUnrotate(m, wound.direction);
        if (!offset || !direction) continue;
        s.stuckArrows ??= [];
        if (s.stuckArrows.length >= CREW_ARROWS_PER_BODY) s.stuckArrows.shift();
        s.stuckArrows.push({ bone, offset, direction });
        continue;
      }
      const injury = crewWoundOutcome(wound.kind, bone, wound.roll);
      if (!injury) continue;
      const injuries = (s.crewInjuries ??= []);
      if (injuries.some((known) => known.bone === injury.bone && known.kind === injury.kind)) continue;
      injuries.push(injury);
      poseCrewInjury(a, injury);
    }
    s.pendingWounds = null;
  }
  if (!s.stuckArrows?.length) { s.stuckArrowPoses = null; return; }
  s.stuckArrowPoses = s.stuckArrows.map((arrow) => {
    const m = a.world[a.nodeIndex(arrow.bone)];
    const tip = woundMatrixPoint(m, arrow.offset), along = woundMatrixVector(m, arrow.direction);
    const n = Math.hypot(along[0], along[1], along[2]);
    // A bone lost after the arrow struck takes its arrow with it.
    if (n < 0.05) return null;
    const tail = tip.map((v, i) => v - (along[i] / n) * CREW_ARROW_LENGTH);
    return { tip: crewWoundBoatPoint(tip, s), tail: crewWoundBoatPoint(tail, s) };
  }).filter(Boolean);
}
