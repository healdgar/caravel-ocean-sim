// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The poses of a town's people, baked once when a town comes into reach: the walk and stand that everyone has, and
// what they do under fire. Falls come from the same ragdoll that brings down a soldier or a sailor, run once here,
// so people in a street go down as they do without any of it being worked out per body per frame.
import { gltfQuatMultiply } from './gltf.js';
import { CREW_CLIP_RATE } from './crew-clip-pose.js';
import { applyArticulatedRagdollPose, initArticulatedRagdoll, stepArticulatedRagdoll } from './crew-physics.js';
import { poseMoveBone, poseRotation, solveCrewLimb, turnBone } from './crew-pose.js';
import { TOWN_COWER_FRAMES, TOWN_FALL_FRAMES, TOWN_FALL_RATE } from './wgsl/townsfolk.js';

const JOINT_FLOATS = 65 * 16;
// How much wider than a walk a run swings each limb, and how it carries itself.
const RUN_SWING = Object.freeze({ thigh: 1.7, calf: 1.5, upperarm: 1.8, lowerarm: 1.15 });
const RUN_LEAN_RADIANS = 0.3;
const RUN_ELBOW_RADIANS = 1.05;
const COWER_DROP_M = 0.5;
const COWER_BACK_M = 0.14;
const COWER_LEAN_RADIANS = 1.5;
const FALL_STEPS_PER_FRAME = 2;
const FALL_THROW_M_S = 2;

const nodeAt = (a, node) => Array.from(a.world[node].subarray(12, 15));
const LEFT_THEN_RIGHT = [['l', 1], ['r', -1]];

function keepSoleFlat(a, side) {
  const f = a.footContacts[side], q = poseRotation(a.world[a.parent[f.node]]), local = new Float32Array(4);
  gltfQuatMultiply(local, [-q[0], -q[1], -q[2], q[3]], poseRotation(f.restWorld));
  a.pose[f.node].r.set(local);
  const toe = a.nodeIndex('ball_' + side);
  if (toe >= 0) a.pose[toe].r.set(a.rest[toe].r);
  a.updateBranch(f.node);
}

// The walk, swung wider, leaning into it and with the elbows bent, and let down until the lower foot is on the ground.
function bakeRun(a, frames, duration, keep) {
  const swinging = Object.keys(RUN_SWING).flatMap((limb) => ['l', 'r'].map((side) => ({ node: a.nodeIndex(`${limb}_${side}`), gain: RUN_SWING[limb], mean: new Float32Array(4) })));
  for (let frame = 0; frame < frames; frame++) {
    a.sample('Walk', frame / frames * duration);
    for (const { node, mean } of swinging) {
      const r = a.pose[node].r, sign = mean[0] * r[0] + mean[1] * r[1] + mean[2] * r[2] + mean[3] * r[3] < 0 ? -1 : 1;
      for (let i = 0; i < 4; i++) mean[i] += r[i] * sign;
    }
  }
  for (const { mean } of swinging) {
    const size = Math.hypot(...mean);
    for (let i = 0; i < 4; i++) mean[i] /= size;
  }
  // Ankle and ball of each foot, and how high each is off the ground standing, to find what touches it first.
  a.sample(null, 0);
  const soles = LEFT_THEN_RIGHT.flatMap(([side]) => ['foot_', 'ball_'].map((joint) => {
    const node = a.nodeIndex(joint + side);
    return { node, rest: nodeAt(a, node)[1] };
  }));
  const off = new Float32Array(4), wider = new Float32Array(4);
  const pelvis = a.nodeIndex('pelvis'), spine = a.nodeIndex('spine_01');
  for (let frame = 0; frame < frames; frame++) {
    a.sample('Walk', frame / frames * duration);
    for (const { node, gain, mean } of swinging) {
      const r = a.pose[node].r;
      gltfQuatMultiply(off, [-mean[0], -mean[1], -mean[2], mean[3]], r);
      const sign = off[3] < 0 ? -1 : 1, size = Math.hypot(off[0], off[1], off[2]);
      if (size < 1e-6) continue;
      const half = Math.atan2(size, off[3] * sign) * gain, scale = Math.sin(half) / size * sign;
      gltfQuatMultiply(wider, mean, [off[0] * scale, off[1] * scale, off[2] * scale, Math.cos(half)]);
      r.set(wider);
    }
    a.update();
    turnBone(a, spine, [0, 1, 0], [0, Math.cos(RUN_LEAN_RADIANS), Math.sin(RUN_LEAN_RADIANS)]);
    const flex = Math.cos(RUN_ELBOW_RADIANS), raise = Math.sin(RUN_ELBOW_RADIANS);
    for (const [side] of LEFT_THEN_RIGHT) {
      const lower = a.nodeIndex('lowerarm_' + side), elbow = nodeAt(a, lower), hand = nodeAt(a, a.nodeIndex('hand_' + side));
      const d = [hand[0] - elbow[0], hand[1] - elbow[1], hand[2] - elbow[2]];
      turnBone(a, lower, d, [d[0], d[1] * flex + d[2] * raise, d[2] * flex - d[1] * raise]);
    }
    let low = Infinity;
    for (const { node, rest } of soles) low = Math.min(low, nodeAt(a, node)[1] - rest);
    const hips = nodeAt(a, pelvis);
    poseMoveBone(a, pelvis, [hips[0], hips[1] - low, hips[2]]);
    keep(frame);
  }
}

// Crouched on the feet they stood on, bent right over, with both hands over the back of the head.
function poseCower(a, amount) {
  a.sample('Idle', 0);
  const pelvis = a.nodeIndex('pelvis'), hips = nodeAt(a, pelvis);
  const ankles = LEFT_THEN_RIGHT.map(([side]) => nodeAt(a, a.footContacts[side].node));
  const hands = LEFT_THEN_RIGHT.map(([side]) => nodeAt(a, a.nodeIndex('hand_' + side)));
  poseMoveBone(a, pelvis, [hips[0], hips[1] - COWER_DROP_M * amount, hips[2] - COWER_BACK_M * amount]);
  for (const [name, share] of [['pelvis', 0.2], ['spine_01', 0.3], ['spine_02', 0.3], ['spine_03', 0.2], ['neck_01', 0.2]]) {
    const angle = COWER_LEAN_RADIANS * amount * share, node = a.nodeIndex(name);
    if (node >= 0) turnBone(a, node, [0, 1, 0], [0, Math.cos(angle), Math.sin(angle)]);
  }
  LEFT_THEN_RIGHT.forEach(([side, sign], i) => {
    solveCrewLimb(a, ['thigh_' + side, 'calf_' + side, 'foot_' + side], ankles[i], [sign * 0.3, 0.35, 0.85]);
    keepSoleFlat(a, side);
  });
  const head = nodeAt(a, a.nodeIndex('Head'));
  LEFT_THEN_RIGHT.forEach(([side, sign], i) => {
    const over = [head[0] + sign * 0.07, head[1] + 0.1, head[2] - 0.02];
    solveCrewLimb(a, ['upperarm_' + side, 'lowerarm_' + side, 'hand_' + side], hands[i].map((v, k) => v + (over[k] - v) * amount), [sign * 0.7, 0.3, 0.5]);
  });
}

function bakeFall(a, sign, keep) {
  const body = { position: [0, 0, 0], yaw: 0, climbPitch: 0, scale: [1, 1, 1], crewIndex: sign > 0 ? 0 : 1, fallDir: sign, casualtyState: 'fallen', navigationY: 0, knockbackVx: 0, knockbackVz: sign * FALL_THROW_M_S };
  initArticulatedRagdoll(body, null);
  for (let frame = 0; frame < TOWN_FALL_FRAMES; frame++) {
    a.sample('Idle', 0);
    applyArticulatedRagdollPose(a, body, null);
    keep(frame);
    for (let step = 0; step < FALL_STEPS_PER_FRAME; step++) stepArticulatedRagdoll(body, null, 1 / (TOWN_FALL_RATE * FALL_STEPS_PER_FRAME));
  }
}

// Palettes for every frame, and where each clip starts and how long it is: idle, walk, run, cower, fall on the face,
// fall on the back. A cower runs from standing to right down; a fall ends where the body stays.
export function bakeTownClips(a) {
  const framesOf = (name) => Math.max(1, Math.round(a.clips.get(name).duration * CREW_CLIP_RATE));
  const idle = framesOf('Idle'), walk = framesOf('Walk');
  const lengths = [idle, walk, walk, TOWN_COWER_FRAMES, TOWN_FALL_FRAMES, TOWN_FALL_FRAMES];
  const layout = new Uint32Array(12);
  let total = 0;
  lengths.forEach((frames, i) => { layout[i * 2] = total; layout[i * 2 + 1] = frames; total += frames; });
  const palettes = new Float32Array(total * JOINT_FLOATS);
  const keeper = (clip) => (frame) => palettes.set(a.palette, (layout[clip * 2] + frame) * JOINT_FLOATS);
  for (const [clip, name] of [[0, 'Idle'], [1, 'Walk']]) {
    const duration = a.clips.get(name).duration, keep = keeper(clip);
    for (let frame = 0; frame < lengths[clip]; frame++) { a.sample(name, frame / lengths[clip] * duration); keep(frame); }
  }
  bakeRun(a, walk, a.clips.get('Walk').duration, keeper(2));
  const keepCower = keeper(3);
  for (let frame = 0; frame < TOWN_COWER_FRAMES; frame++) {
    const t = frame / (TOWN_COWER_FRAMES - 1);
    poseCower(a, t * t * (3 - 2 * t));
    keepCower(frame);
  }
  bakeFall(a, 1, keeper(4));
  bakeFall(a, -1, keeper(5));
  return { palettes, layout };
}
