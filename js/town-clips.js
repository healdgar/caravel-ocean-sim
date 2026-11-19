// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The poses of a town's people, baked once when a town comes into reach: the walk and stand that everyone has,
// 1550 Iberian sela à gineta saddle-riding for mounted couriers/gentry, and what they do under fire. Falls come
// from the same ragdoll that brings down a soldier or a sailor, run once here, so people in a street go down as
// they do without any of it being worked out per body per frame.
import { gltfQuatMultiply } from './gltf.js';
import { CREW_CLIP_RATE } from './crew-clip-pose.js';
import { applyArticulatedRagdollPose, initArticulatedRagdoll, stepArticulatedRagdoll } from './crew-physics.js';
import { poseMoveBone, poseRotation, solveCrewLimb, turnBone } from './crew-pose.js';
import { TOWN_COWER_FRAMES, TOWN_FALL_FRAMES, TOWN_FALL_RATE } from './wgsl/townsfolk.js';
import { CREW_JOINT_COUNT } from './crew-skeleton.js';

const JOINT_FLOATS = CREW_JOINT_COUNT * 16;
export const TOWN_CLIP_IDLE = 0;
export const TOWN_CLIP_WALK = 1;
export const TOWN_CLIP_RUN = 2;
export const TOWN_CLIP_COWER = 3;
export const TOWN_CLIP_FALL_FWD = 4;
export const TOWN_CLIP_FALL_BACK = 5;
export const CLIP_RIDE = 6;
export const TOWN_CLIP_RIDE = 6;
export const TOWN_CLIP_COUNT = 7;
export const TOWN_RIDE_FRAMES = 20;
export const TOWN_CLIP_CARRY = 6;
export const TOWN_CLIP_WORK = 7;

// How much wider than a walk a run swings each limb, and how it carries itself.
const RUN_SWING = Object.freeze({ thigh: 1.40, calf: 1.35, upperarm: 1.42, lowerarm: 1.12 });
const RUN_LEAN_RADIANS = 0.22;
const RUN_ELBOW_RADIANS = 0.90;
const COWER_DROP_M = 0.44;
const COWER_BACK_M = 0.12;
const COWER_LEAN_RADIANS = 1.35;
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

function resetSymmetricTorso(a) {
  for (const name of ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05', 'neck_01', 'neck_02', 'head', 'clavicle_l', 'clavicle_r']) {
    const node = a.nodeIndex(name);
    if (node < 0) continue;
    a.pose[node].t.set(a.rest[node].t);
    a.pose[node].r.set(a.rest[node].r);
    a.pose[node].s.set(a.rest[node].s);
  }
  a.update();
}

export const HORSE_SADDLE_SEAT_TOP_Y = 1.230;
export const HORSE_POMMEL_TOP_Y = 1.375;
export const HORSE_BARREL_MAX_RX = 0.2506;
export const HORSE_STIRRUP_BAR_TOP_Y = 0.790;
export const HORSE_STIRRUP_Z = 0.04;

// 1550 Iberian sela à gineta riding clip: seated ON TOP of the molded leather saddle seat (`saddle_seat_top_y = 1.230 m`,
// `z = -0.02 m`) using each skeleton's measured `seatContact.pelvisAboveSeat` so zero buttocks/groin geometry ever merges
// into the horse's spine, thighs/knees abducted cleanly outside the `0.251 m` saddleclothed barrel, and boot soles planted
// squarely on the forged iron stirrup bars (`stirrup_bar_top_y = 0.740 m`) via `footContacts[side].ankleAboveSole`.
export function bakeRideClip(a, frames = TOWN_RIDE_FRAMES, keep = null) {
  const palettes = keep ? null : new Float32Array(frames * JOINT_FLOATS);
  const pelvis = a.nodeIndex('pelvis');
  const spine1 = a.nodeIndex('spine_01');
  const spine2 = a.nodeIndex('spine_02');
  const neck = a.nodeIndex('neck_01');
  const head = a.nodeIndex('head');
  const pelvisAboveSeat = a.seatContact?.pelvisAboveSeat ?? 0.278;
  const stirrupX = Math.min(0.315, Math.max(0.295, HORSE_BARREL_MAX_RX + 0.055));

  for (let frame = 0; frame < frames; frame++) {
    const phase = (frame / frames) * Math.PI * 2;
    const beat2 = phase * 2;
    const bobY = 0.016 * Math.sin(beat2);
    const swayX = 0.008 * Math.sin(phase);
    const pelPitch = 0.040 + 0.028 * Math.cos(beat2);
    const chestCounter = 0.032 - 0.022 * Math.cos(beat2);
    const headSteady = -0.025 + 0.012 * Math.sin(phase);
    const pelvisY = HORSE_SADDLE_SEAT_TOP_Y + pelvisAboveSeat - 0.038 + bobY;

    a.sample('Idle', 0);
    resetSymmetricTorso(a);
    if (pelvis >= 0) {
      poseMoveBone(a, pelvis, [swayX, pelvisY, -0.02]);
      turnBone(a, pelvis, [0, 1, 0], [0, Math.cos(pelPitch), Math.sin(pelPitch)]);
    }
    if (spine1 >= 0) turnBone(a, spine1, [0, 1, 0], [0, Math.cos(0.035), Math.sin(0.035)]);
    if (spine2 >= 0) turnBone(a, spine2, [0, 1, 0], [0, Math.cos(chestCounter), Math.sin(chestCounter)]);
    if (neck >= 0) turnBone(a, neck, [0, 1, 0], [0, Math.cos(headSteady), Math.sin(headSteady)]);
    if (head >= 0) turnBone(a, head, [0, 0, 1], [0.025 * Math.sin(phase), 0, 1]);

    // Natural equestrian leg wrap: thighs angle forward along the saddle flaps hugging the 0.251 m barrel cleanly.
    for (const [side, sign] of LEFT_THEN_RIGHT) {
      const ankleAboveSole = a.footContacts?.[side]?.ankleAboveSole ?? 0.11;
      const stirrupBounce = 0.006 * Math.sin(beat2 + (sign > 0 ? 0.25 : -0.25));
      const stirrupFoot = [sign * stirrupX, HORSE_STIRRUP_BAR_TOP_Y + ankleAboveSole + stirrupBounce, HORSE_STIRRUP_Z];
      const kneePole = [sign * 0.32, pelvisY - 0.16, 0.90];
      solveCrewLimb(a, ['thigh_' + side, 'calf_' + side, 'foot_' + side], stirrupFoot, kneePole);
      keepSoleFlat(a, side);
    }

    // Left hand holds the gathered reins above the pommel; right hand steadies the hip / courier alforja pouch.
    const reinFollow = 0.014 * Math.sin(beat2 - 0.35);
    const reinHand = [0.02, HORSE_POMMEL_TOP_Y + 0.065 + bobY * 0.5 + reinFollow * 0.5, 0.26 + reinFollow];
    const hipHand = [-0.22, pelvisY + 0.02, 0.02];
    solveCrewLimb(a, ['upperarm_l', 'lowerarm_l', 'hand_l'], reinHand, [0.48, pelvisY + 0.06, -0.04]);
    solveCrewLimb(a, ['upperarm_r', 'lowerarm_r', 'hand_r'], hipHand, [-0.52, pelvisY + 0.10, -0.18]);

    if (keep) keep(frame);
    else palettes.set(a.palette, frame * JOINT_FLOATS);
  }
  return palettes;
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
    // Flex elbows around the anatomical local hinge axis (+X in joint space) rather than character-global YZ.
    const halfElbow = RUN_ELBOW_RADIANS * 0.5;
    const elbowHinge = [Math.sin(halfElbow), 0, 0, Math.cos(halfElbow)];
    const bent = new Float32Array(4);
    for (const [side] of LEFT_THEN_RIGHT) {
      const lower = a.nodeIndex('lowerarm_' + side);
      gltfQuatMultiply(bent, a.pose[lower].r, elbowHinge);
      a.pose[lower].r.set(bent);
      a.updateBranch(lower);
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
  const head = nodeAt(a, a.nodeIndex('head'));
  const arc = Math.sin(Math.PI * amount);
  LEFT_THEN_RIGHT.forEach(([side, sign], i) => {
    const over = [head[0] + sign * 0.08, head[1] + 0.085, head[2] + 0.01];
    const target = [
      hands[i][0] + (over[0] - hands[i][0]) * amount + sign * 0.08 * arc,
      hands[i][1] + (over[1] - hands[i][1]) * amount,
      hands[i][2] + (over[2] - hands[i][2]) * amount + 0.14 * arc,
    ];
    solveCrewLimb(a, ['upperarm_' + side, 'lowerarm_' + side, 'hand_' + side], target, [sign * 0.8, -0.2, -0.5]);
  });
}

// Optional station pose helper: walking or standing while carrying a crate/basket in both hands before the waist.
export function bakeCarryStationClip(a, frames, duration, keep) {
  const halfElbow = 0.52;
  const elbowHinge = [Math.sin(halfElbow), 0, 0, Math.cos(halfElbow)];
  const bent = new Float32Array(4);
  const spine2 = a.nodeIndex('spine_02');
  for (let frame = 0; frame < frames; frame++) {
    a.sample('Walk', frame / frames * duration);
    if (spine2 >= 0) turnBone(a, spine2, [0, 1, 0], [0, Math.cos(-0.06), Math.sin(-0.06)]);
    const chest = nodeAt(a, a.nodeIndex('spine_02'));
    LEFT_THEN_RIGHT.forEach(([side, sign]) => {
      const target = [chest[0] + sign * 0.13, chest[1] - 0.06, chest[2] + 0.24];
      solveCrewLimb(a, ['upperarm_' + side, 'lowerarm_' + side, 'hand_' + side], target, [sign * 0.65, -0.35, -0.45]);
      const lower = a.nodeIndex('lowerarm_' + side);
      gltfQuatMultiply(bent, a.pose[lower].r, elbowHinge);
      a.pose[lower].r.set(bent);
      a.updateBranch(lower);
    });
    keep(frame);
  }
}

// Optional station pose helper: standing work cycle tending nets, stalls, or cargo at bench height.
export function bakeWorkStationClip(a, frames, duration, keep) {
  const spine1 = a.nodeIndex('spine_01'), neck = a.nodeIndex('neck_01');
  for (let frame = 0; frame < frames; frame++) {
    const phase = (frame / frames) * Math.PI * 2;
    a.sample('Idle', (frame / frames) * duration);
    const lean = 0.18 + 0.04 * Math.sin(phase);
    if (spine1 >= 0) turnBone(a, spine1, [0, 1, 0], [0, Math.cos(lean), Math.sin(lean)]);
    if (neck >= 0) turnBone(a, neck, [0, 1, 0], [0, Math.cos(0.14), Math.sin(0.14)]);
    const chest = nodeAt(a, a.nodeIndex('spine_02'));
    LEFT_THEN_RIGHT.forEach(([side, sign]) => {
      const reach = 0.24 + 0.05 * Math.sin(phase + sign * 0.9);
      const lift = -0.02 + 0.03 * Math.cos(phase + sign * 0.9);
      const target = [chest[0] + sign * 0.14, chest[1] + lift, chest[2] + reach];
      solveCrewLimb(a, ['upperarm_' + side, 'lowerarm_' + side, 'hand_' + side], target, [sign * 0.7, -0.3, -0.45]);
    });
    keep(frame);
  }
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
// fall on the back, plus (when `includeRide` is requested by `townsfolk.js`) `CLIP_RIDE` (`6`) seated à gineta.
export function bakeTownClips(a, { includeRide = false } = {}) {
  const framesOf = (name) => Math.max(1, Math.round(a.clips.get(name).duration * CREW_CLIP_RATE));
  const idle = framesOf('Idle'), walk = framesOf('Walk');
  const lengths = includeRide
    ? [idle, walk, walk, TOWN_COWER_FRAMES, TOWN_FALL_FRAMES, TOWN_FALL_FRAMES, TOWN_RIDE_FRAMES]
    : [idle, walk, walk, TOWN_COWER_FRAMES, TOWN_FALL_FRAMES, TOWN_FALL_FRAMES];
  const layout = new Uint32Array(lengths.length * 2);
  let total = 0;
  lengths.forEach((frames, i) => { layout[i * 2] = total; layout[i * 2 + 1] = frames; total += frames; });
  const palettes = new Float32Array(total * JOINT_FLOATS);
  const keeper = (clip) => (frame) => palettes.set(a.palette, (layout[clip * 2] + frame) * JOINT_FLOATS);
  for (const [clip, name] of [[TOWN_CLIP_IDLE, 'Idle'], [TOWN_CLIP_WALK, 'Walk']]) {
    const duration = a.clips.get(name).duration, keep = keeper(clip);
    for (let frame = 0; frame < lengths[clip]; frame++) { a.sample(name, frame / lengths[clip] * duration); keep(frame); }
  }
  bakeRun(a, walk, a.clips.get('Walk').duration, keeper(TOWN_CLIP_RUN));
  const keepCower = keeper(TOWN_CLIP_COWER);
  for (let frame = 0; frame < TOWN_COWER_FRAMES; frame++) {
    const t = frame / (TOWN_COWER_FRAMES - 1);
    poseCower(a, t * t * (3 - 2 * t));
    keepCower(frame);
  }
  bakeFall(a, 1, keeper(TOWN_CLIP_FALL_FWD));
  bakeFall(a, -1, keeper(TOWN_CLIP_FALL_BACK));
  if (includeRide) {
    bakeRideClip(a, TOWN_RIDE_FRAMES, keeper(CLIP_RIDE));
  }
  return { palettes, layout, rideFrames: TOWN_RIDE_FRAMES };
}

// Optional helper returning the two station clips (TOWN_CLIP_CARRY, TOWN_CLIP_WORK) without altering bakeTownClips layout.
export function bakeTownStationClips(a) {
  const framesOf = (name) => Math.max(1, Math.round(a.clips.get(name).duration * CREW_CLIP_RATE));
  const carryFrames = framesOf('Walk'), workFrames = framesOf('Idle');
  const layout = new Uint32Array([0, carryFrames, carryFrames, workFrames]);
  const palettes = new Float32Array((carryFrames + workFrames) * JOINT_FLOATS);
  bakeCarryStationClip(a, carryFrames, a.clips.get('Walk').duration, (f) => palettes.set(a.palette, f * JOINT_FLOATS));
  bakeWorkStationClip(a, workFrames, a.clips.get('Idle').duration, (f) => palettes.set(a.palette, (carryFrames + f) * JOINT_FLOATS));
  return { palettes, layout };
}
