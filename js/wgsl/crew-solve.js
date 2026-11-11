// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// One sailor's skeleton, solved on the GPU: the standing, walking and bracing clips sampled and mixed, then the
// short list of things that sailor is doing this frame, each a reach, a turn or a whole stance, then sea legs,
// gaze, fingers, the ease from his last action into this one, and his wounds. JavaScript sends the list and the
// numbers the simulation owns; no joint is touched there. js/crew-pose.js and js/crew-physics.js hold the same
// steps in JavaScript, which is what the tests hold this against.

// What one entry of a sailor's list asks for. An entry is eight numbers; a stance takes several entries.
export const CREW_SOLVE_OP = Object.freeze({ blend: 1, neutral: 2, turn: 3, shift: 4, move: 5, limb: 6, limbHead: 7, gunBody: 8, seated: 9, rowFeet: 10, ragdoll: 11, grip: 12, seaLegs: 13, gaze: 14, fingers: 15, inertia: 16, injury: 17 });
// The bones a pose step names, in the order the rig table lists their joints.
export const CREW_SOLVE_BONES = Object.freeze(['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head', 'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r']);
// A limb is its upper bone's place in that list: an arm at 8 and 12, a leg at 15 and 19.
export const CREW_SOLVE_LIMBS = Object.freeze({ upperarm_l: 0, upperarm_r: 1, thigh_l: 2, thigh_r: 3 });
export const CREW_SOLVE_JOINTS = 65;
// What the pass remembers of each sailor between solves: every joint's last turn, the turn it is easing from, and
// the pelvis's place for both.
export const CREW_SOLVE_MEMORY = CREW_SOLVE_JOINTS * 2 + 2;
export const CREW_INJURY_KINDS = Object.freeze({ severed: 1, crushed: 2, broken: 3 });

export const crewSolveWGSL = ({ brokenAngle, crushedScale }) => /* wgsl */`
// A joint at rest, how its finger curls if it is one, and its place in the tree: its parent, where its descendants
// end, which hand it curls with, and whether it hangs from a hand at all.
struct Joint { r: vec4f, t: vec4f, s: vec4f, finger: vec4f, link: vec4i }
struct Rig {
  rootParent: mat4x4f,
  clipFirst: vec4u,
  clipKeys: vec4u,
  clipSeconds: vec4f,
  footRest: array<vec4f, 2>,
  // Each ankle above its sole, then the heel below and behind the ankle.
  contact: vec4f,
  // The one joint a clip moves as well as turns, where the clips' moves start, and keys a second.
  misc: vec4u,
  bones: array<u32, 24>,
  joints: array<Joint, 65>,
  binds: array<mat4x4f, 65>,
}
// Where a sailor is in his clips, whether he is there at all, and where his steps start, how many they are, which
// rig he is built on and where the pass keeps what it remembers of him.
struct Sailor { clip: vec4f, more: vec4f, at: vec4u }
struct Op { a: vec4f, b: vec4f }
// Every rig, every rig's clip keys, and everybody due a pose this frame, whatever vessel or fort they are in: the
// GPU is as long over one sailor as over a hundred, and as long again for each further dispatch.
@group(0) @binding(0) var<storage, read> rigs: array<Rig>;
@group(0) @binding(1) var<storage, read> clips: array<vec4f>;
@group(0) @binding(2) var<storage, read> sailors: array<Sailor>;
@group(0) @binding(3) var<storage, read> ops: array<Op>;
@group(0) @binding(4) var<storage, read_write> memory: array<vec4f>;
// The poses just solved, one a sailor in the order they were asked for. A second pass puts each where it is drawn from.
@group(0) @binding(5) var<storage, read_write> poses: array<mat4x4f>;

const ROOT = 0u; const PELVIS = 1u; const SPINE1 = 2u; const SPINE2 = 3u; const SPINE3 = 4u; const NECK = 5u; const HEAD = 6u;
const CLAVICLE_L = 7u; const UPPERARM_L = 8u; const LOWERARM_L = 9u; const HAND_L = 10u;
const CLAVICLE_R = 11u; const UPPERARM_R = 12u; const HAND_R = 14u;
const THIGH_L = 15u; const FOOT_L = 17u; const UP = vec3f(0.0, 1.0, 0.0);

var<private> RIG: u32;
var<private> R: array<vec4f, 65>;
var<private> T: array<vec3f, 65>;
var<private> S: array<vec3f, 65>;
// Where each joint is in the sailor's own frame: how it is turned and scaled, and its place.
var<private> W: array<mat3x3f, 65>;
var<private> P: array<vec3f, 65>;
var<private> grip: array<vec3f, 2>;
var<private> gripped: array<u32, 2>;

fn bone(i: u32) -> u32 { return rigs[RIG].bones[i]; }
fn qmul(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z);
}
fn slerp(a: vec4f, b: vec4f, t: f32) -> vec4f {
  var d = dot(a, b);
  let sgn = select(1.0, -1.0, d < 0.0);
  d = abs(d);
  var x = 1.0 - t; var y = t;
  if (d < 0.9995) { let angle = acos(min(1.0, d)); let s = sin(angle); x = sin((1.0 - t) * angle) / s; y = sin(t * angle) / s; }
  let q = x * a + y * sgn * b;
  return q / max(length(q), 1e-10);
}
fn turned(q: vec4f, s: vec3f) -> mat3x3f {
  let xx = q.x * q.x; let yy = q.y * q.y; let zz = q.z * q.z; let xy = q.x * q.y; let xz = q.x * q.z; let yz = q.y * q.z;
  let wx = q.w * q.x; let wy = q.w * q.y; let wz = q.w * q.z;
  return mat3x3f(vec3f(1.0 - 2.0 * (yy + zz), 2.0 * (xy + wz), 2.0 * (xz - wy)) * s.x,
    vec3f(2.0 * (xy - wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz + wx)) * s.y,
    vec3f(2.0 * (xz + wy), 2.0 * (yz - wx), 1.0 - 2.0 * (xx + yy)) * s.z);
}
fn linear(m: mat4x4f) -> mat3x3f { return mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz); }
// The turn a matrix holds, taking its first column's length for its scale.
fn mquat(m: mat3x3f) -> vec4f {
  let scale = max(length(m[0].xyz), 1e-12);
  let r0 = m[0].x / scale; let r1 = m[1].x / scale; let r2 = m[2].x / scale;
  let r3 = m[0].y / scale; let r4 = m[1].y / scale; let r5 = m[2].y / scale;
  let r6 = m[0].z / scale; let r7 = m[1].z / scale; let r8 = m[2].z / scale;
  let trace = r0 + r4 + r8;
  var q: vec4f;
  if (trace > 0.0) { let s = sqrt(trace + 1.0) * 2.0; q = vec4f((r7 - r5) / s, (r2 - r6) / s, (r3 - r1) / s, s / 4.0); }
  else if (r0 > r4 && r0 > r8) { let s = sqrt(1.0 + r0 - r4 - r8) * 2.0; q = vec4f(s / 4.0, (r1 + r3) / s, (r2 + r6) / s, (r7 - r5) / s); }
  else if (r4 > r8) { let s = sqrt(1.0 + r4 - r0 - r8) * 2.0; q = vec4f((r1 + r3) / s, s / 4.0, (r5 + r7) / s, (r2 - r6) / s); }
  else { let s = sqrt(1.0 + r8 - r0 - r4) * 2.0; q = vec4f((r2 + r6) / s, (r5 + r7) / s, s / 4.0, (r3 - r1) / s); }
  return q / max(length(q), 1e-12);
}
fn unit(v: vec3f) -> vec3f { return v / max(length(v), 1e-9); }
fn at(n: u32) -> vec3f { return P[n]; }
fn place(i: u32) {
  let p = rigs[RIG].joints[i].link.x;
  let local = turned(R[i], S[i]);
  if (p >= 0) { let over = W[u32(p)]; W[i] = over * local; P[i] = over * T[i] + P[u32(p)]; }
  else { let over = linear(rigs[RIG].rootParent); W[i] = over * local; P[i] = over * T[i] + rigs[RIG].rootParent[3].xyz; }
}
// A joint and everything hanging from it. Joints are stored parent first with each one's descendants straight
// after it, so that is one run of the table. Fingers are most of the joints and nothing is solved from where
// they are, so they are left until the pose is done.
fn fkFrom(n: u32) {
  let end = u32(rigs[RIG].joints[n].link.y);
  for (var i = n; i < end; i++) { if (rigs[RIG].joints[i].link.w == 0) { place(i); } }
}
fn placeFingers() {
  for (var i = 0u; i < 65u; i++) { if (rigs[RIG].joints[i].link.w != 0) { place(i); } }
}
fn parentMatrix(n: u32) -> mat3x3f {
  let p = rigs[RIG].joints[n].link.x;
  if (p < 0) { return linear(rigs[RIG].rootParent); }
  return W[u32(p)];
}
// What carries a point of the body at rest to where this pose has it.
fn palette(j: u32) -> mat4x4f {
  let bind = rigs[RIG].binds[j]; let m = W[j] * linear(bind);
  return mat4x4f(vec4f(m[0], 0.0), vec4f(m[1], 0.0), vec4f(m[2], 0.0), vec4f(W[j] * bind[3].xyz + P[j], 1.0));
}
fn rest(n: u32) { R[n] = rigs[RIG].joints[n].r; T[n] = rigs[RIG].joints[n].t.xyz; S[n] = rigs[RIG].joints[n].s.xyz; }
// Turn a bone so that what pointed along 'was' points along 'to', both in the sailor's own frame.
fn turn(n: u32, was: vec3f, to: vec3f) {
  let u = unit(was); let v = unit(to); let d = dot(u, v);
  var delta = vec4f(cross(u, v), 1.0 + d);
  if (d < -0.9999) { delta = vec4f(unit(cross(u, select(UP, vec3f(1.0, 0.0, 0.0), abs(u.x) < 0.8))), 0.0); }
  delta = delta / max(length(delta), 1e-9);
  let q = mquat(parentMatrix(n));
  R[n] = qmul(qmul(qmul(vec4f(-q.xyz, q.w), delta), q), R[n]);
  fkFrom(n);
}
fn moveTo(n: u32, goal: vec3f) {
  let delta = goal - at(n);
  let m = parentMatrix(n);
  for (var k = 0u; k < 3u; k++) { let axis = m[k].xyz; T[n][k] += dot(axis, delta) / max(1e-12, dot(axis, axis)); }
  fkFrom(n);
}
fn limbBase(c: u32) -> u32 { return select(8u + 4u * c, 7u + 4u * c, c >= 2u); }
// Two bones to a goal, the middle joint bent toward the pole. Neither bone changes length.
fn limb(c: u32, goal: vec3f, pole: vec3f) {
  let base = limbBase(c); let upper = bone(base); let lower = bone(base + 1u); let end = bone(base + 2u);
  let A = at(upper); let B = at(lower); let C = at(end);
  let l1 = length(B - A); let l2 = length(C - B); let ray = goal - A; let dir = unit(ray);
  let d = max(abs(l1 - l2) + 0.001, min(l1 + l2 - 0.001, length(ray)));
  let x = (l1 * l1 - l2 * l2 + d * d) / (2.0 * d); let h = sqrt(max(0.0, l1 * l1 - x * x));
  let p = pole - A; let bend = unit(p - dir * dot(p, dir));
  turn(upper, B - A, A + dir * x + bend * h - A);
  let b = at(lower);
  turn(lower, at(end) - b, goal - b);
}
// A foot turned to face as 'desired' says, whatever its shin is doing, and its toes as the rig has them.
fn footTurn(side: u32, desired: vec4f) {
  let foot = bone(FOOT_L + 4u * side); let toe = bone(FOOT_L + 1u + 4u * side);
  let q = mquat(parentMatrix(foot));
  R[foot] = qmul(vec4f(-q.xyz, q.w), desired); R[toe] = rigs[RIG].joints[toe].r;
  fkFrom(foot);
}
fn bootFlat(side: u32, normal: vec3f) {
  let delta = vec4f(normal.z, 0.0, -normal.x, 1.0 + normal.y);
  footTurn(side, qmul(delta / length(delta), rigs[RIG].footRest[side]));
}
fn neutral() {
  rest(bone(ROOT)); rest(bone(PELVIS)); rest(bone(SPINE1)); rest(bone(SPINE2)); rest(bone(SPINE3)); rest(bone(CLAVICLE_L)); rest(bone(CLAVICLE_R));
  fkFrom(bone(ROOT));
}
fn fingers(left: f32, right: f32) {
  for (var j = 0u; j < 65u; j++) {
    let side = rigs[RIG].joints[j].link.z;
    if (side == 0) { continue; }
    let f = rigs[RIG].joints[j].finger; let half = select(right, left, side == 1) * f.w * 0.5;
    R[j] = qmul(rigs[RIG].joints[j].r, vec4f(sin(half) * f.xyz, cos(half)));
  }
}
// Where a clip is at some second of it: the key before, the key after, and how far between.
fn clipKey(c: u32, seconds: f32) -> vec3f {
  let keys = rigs[RIG].clipKeys[c]; let u = max(seconds, 0.0) * f32(rigs[RIG].misc.z);
  let lo = min(u32(u), keys - 1u); let hi = min(lo + 1u, keys - 1u);
  return vec3f(f32(rigs[RIG].clipFirst[c] + lo), f32(rigs[RIG].clipFirst[c] + hi), select(clamp(u - f32(lo), 0.0, 1.0), 0.0, lo == hi));
}
// Mix a clip into the pose, or with 'first' start the pose from it.
fn blendClip(c: u32, seconds: f32, weight: f32, first: bool) {
  let key = clipKey(c, seconds); let lo = u32(key.x); let hi = u32(key.y); let w = clamp(weight, 0.0, 1.0);
  for (var j = 0u; j < 65u; j++) {
    let q = slerp(clips[lo * 65u + j], clips[hi * 65u + j], key.z);
    if (first) { R[j] = q; } else { R[j] = slerp(R[j], q, w); }
  }
  let moved = rigs[RIG].misc.x;
  if (moved < 65u) {
    let t = mix(clips[rigs[RIG].misc.y + lo].xyz, clips[rigs[RIG].misc.y + hi].xyz, key.z);
    if (first) { T[moved] = t; } else { T[moved] = mix(T[moved], t, w); }
  }
}
// How far short of a hand's goal an arm falls, from the shoulder as it is, raised by 'lift'.
fn armShort(c: u32, goal: vec3f, lift: f32, slack: f32) -> f32 {
  let base = limbBase(c); let shoulder = at(bone(base)); let elbow = at(bone(base + 1u)); let hand = at(bone(base + 2u));
  return length(goal - (shoulder + vec3f(0.0, lift, 0.0))) - length(elbow - shoulder) - length(hand - elbow) + slack;
}
// How far the pelvis must come down for both legs to reach their feet without stretching.
fn settleOnLegs(left: vec3f, right: vec3f) {
  var lower = 0.0;
  for (var side = 0u; side < 2u; side++) {
    let base = THIGH_L + 4u * side; let hip = at(bone(base)); let knee = at(bone(base + 1u)); let ankle = at(bone(base + 2u));
    let goal = select(right, left, side == 0u);
    let reach = length(knee - hip) + length(ankle - knee) - 0.006; let level = length(goal.xz - hip.xz);
    lower = min(lower, goal.y + sqrt(max(0.0, reach * reach - level * level)) - hip.y);
  }
  if (lower < 0.0) { let p = at(bone(PELVIS)); moveTo(bone(PELVIS), vec3f(p.x, p.y + lower, p.z)); }
}
// Boots planted where the deck is, and knees and hips bent as far as the hands' work needs. js/crew-pose.js,
// poseGroundedGunBody, from its pelvis on.
fn gunBody(k: u32) {
  let head = ops[k]; let mode = u32(head.a.y); let asked = head.a.z; let lift = head.a.w; let dropCap = head.b.x; let reachCap = head.b.y;
  let hands = array<vec3f, 2>(ops[k + 1u].a.xyz, ops[k + 1u].b.xyz);
  let feet = array<vec3f, 2>(ops[k + 2u].a.xyz, ops[k + 2u].b.xyz);
  let normals = array<vec3f, 2>(ops[k + 3u].a.xyz, ops[k + 3u].b.xyz);
  let pelvis = bone(PELVIS); let base = at(pelvis);
  var lean = asked; var drop = 0.0; var short = 0.0;
  if (mode == 1u) {
    for (var c = 0u; c < 2u; c++) { short = max(short, armShort(c, hands[c], lift, 0.02)); }
    drop = min(0.24, short * 0.7); lean = min(0.42, short * 0.9);
  } else if (mode == 2u) {
    let centre = (hands[0] + hands[1]) * 0.5;
    for (var c = 0u; c < 2u; c++) { short = max(short, armShort(c, hands[c], 0.0, 0.015)); }
    if (short > 0.0) { lean = max(lean, min(0.65, atan2(max(0.0, centre.z - base.z), max(0.10, centre.y - base.y)))); }
    let shoulders = (at(bone(UPPERARM_L)).y + at(bone(UPPERARM_R)).y) * 0.5;
    drop = max(0.0, min(dropCap, shoulders - centre.y - 0.16));
  } else if (mode == 3u) { drop = 0.12 * min(1.0, asked / 0.45); }
  let fraction = clamp(lean / 0.45, 0.0, 1.0);
  moveTo(pelvis, vec3f(base.x, base.y + lift - drop, base.z + 0.08 * fraction));
  if (abs(lean) > 1e-6) {
    turn(pelvis, UP, vec3f(0.0, cos(lean * 0.18), sin(lean * 0.18)));
    turn(bone(SPINE1), UP, vec3f(0.0, cos(lean * 0.45), sin(lean * 0.45)));
    turn(bone(SPINE2), UP, vec3f(0.0, cos(lean * 0.37), sin(lean * 0.37)));
  }
  if (reachCap > 0.0) {
    var forward = 0.0;
    for (var c = 0u; c < 2u; c++) {
      let b = limbBase(c); let shoulder = at(bone(b)); let elbow = at(bone(b + 1u)); let hand = at(bone(b + 2u));
      let reach = length(elbow - shoulder) + length(hand - elbow) - 0.015; let across = dot(hands[c].xy - shoulder.xy, hands[c].xy - shoulder.xy);
      forward = max(forward, hands[c].z - shoulder.z - sqrt(max(0.0, reach * reach - across)));
    }
    forward = max(0.0, min(reachCap - 0.04 * fraction, forward));
    if (forward != 0.0) { let p = at(pelvis); moveTo(pelvis, vec3f(p.x, p.y, p.z + forward)); }
  }
  settleOnLegs(feet[0], feet[1]);
  for (var side = 0u; side < 2u; side++) {
    limb(2u + side, feet[side], vec3f(select(-0.25, 0.25, side == 0u), 0.35, 0.85));
    bootFlat(side, normals[side]);
  }
}
// A body on a bench: pelvis over the seat, a bow from the hips if the hands are out of reach, heels down and
// both hands on what they hold. js/crew-pose.js, poseSeatedCrew.
fn seated(k: u32) {
  let lean = ops[k].a.y; let hips = vec3f(ops[k].a.z, ops[k].a.w, ops[k].b.x);
  let hands = array<vec3f, 2>(ops[k + 1u].a.xyz, ops[k + 1u].b.xyz);
  var feet = array<vec3f, 2>(ops[k + 2u].a.xyz, ops[k + 2u].b.xyz);
  let pelvis = bone(PELVIS);
  turn(pelvis, UP, vec3f(0.0, cos(lean), sin(lean)));
  moveTo(pelvis, hips);
  var excess = 0.0; var toward = vec3f(0.0);
  for (var c = 0u; c < 2u; c++) {
    let over = armShort(c, hands[c], 0.0, 0.02);
    if (over > excess) { excess = over; toward = hands[c] - at(bone(limbBase(c))); }
  }
  if (excess > 0.0) {
    let angle = min(0.6, excess / 0.32); var along = length(toward.xz);
    if (along == 0.0) { along = 1.0; }
    let sway = toward.xz / along;
    turn(bone(SPINE1), UP, vec3f(sway.x * sin(angle * 0.55), cos(angle * 0.55), sway.y * sin(angle * 0.55)));
    turn(bone(SPINE2), UP, vec3f(sway.x * sin(angle * 0.45), cos(angle * 0.45), sway.y * sin(angle * 0.45)));
  }
  for (var side = 0u; side < 2u; side++) {
    let sgn = select(-1.0, 1.0, side == 0u); let base = THIGH_L + 4u * side;
    var foot = feet[side];
    let pole = vec3f((at(bone(base)).x + foot.x) * 0.5 + sgn * 0.04, 0.18, 0.8);
    limb(2u + side, foot, pole);
    let knee = at(bone(base + 1u)); let ankle = at(bone(base + 2u));
    let back = max(0.0, atan2(ankle.z - knee.z, knee.y - ankle.y));
    let raise = rigs[RIG].contact.z * cos(back) + rigs[RIG].contact.w * sin(back) - rigs[RIG].contact[side];
    if (raise > 0.002) { foot.y += raise; limb(2u + side, foot, pole); }
    bootFlat(side, vec3f(0.0, cos(back * 0.5), -sin(back * 0.5)));
    limb(side, hands[side], vec3f(sgn * 0.6, 0.6, 0.15));
  }
}
// The walking clip's upper body over two boots set where a rowed ship's own floor is. js/crew-pose.js,
// poseRowingWalkingFeet.
fn rowFeet(k: u32) {
  let raised = ops[k].a.y;
  let feet = array<vec3f, 2>(vec3f(ops[k].a.z, ops[k].a.w, ops[k].b.x), ops[k].b.yzw);
  let turned = array<vec4f, 2>(ops[k + 1u].a, ops[k + 1u].b);
  let pelvis = bone(PELVIS);
  rest(bone(ROOT)); rest(pelvis); fkFrom(bone(ROOT));
  let base = at(pelvis);
  moveTo(pelvis, vec3f(base.x, base.y + raised - 0.035, base.z));
  settleOnLegs(feet[0], feet[1]);
  for (var side = 0u; side < 2u; side++) {
    limb(2u + side, feet[side], vec3f(select(-0.25, 0.25, side == 0u), 0.35, 0.85));
    footTurn(side, qmul(turned[side], rigs[RIG].footRest[side]));
  }
}
// A fallen body laid along the eleven points its physics holds. js/crew-physics.js, applyArticulatedRagdollPose.
fn ragdollPoint(k: u32, i: u32) -> vec3f {
  let n = 1u + i * 3u;
  var v: vec3f;
  for (var c = 0u; c < 3u; c++) {
    let f = n + c; let op = ops[k + f / 8u]; let h = f % 8u;
    if (h < 4u) { v[c] = op.a[h]; } else { v[c] = op.b[h - 4u]; }
  }
  return v;
}
fn ragdoll(k: u32) {
  let pelvis = bone(PELVIS);
  rest(pelvis); rest(bone(SPINE1)); rest(bone(SPINE2)); rest(bone(SPINE3)); rest(bone(NECK)); rest(bone(HEAD));
  fkFrom(bone(ROOT));
  moveTo(pelvis, ragdollPoint(k, 0u));
  let hips = at(pelvis);
  turn(pelvis, at(bone(SPINE3)) - hips, ragdollPoint(k, 1u) - hips);
  let nape = at(bone(NECK));
  turn(bone(NECK), at(bone(HEAD)) - nape, ragdollPoint(k, 2u) - nape);
  limb(0u, ragdollPoint(k, 4u), ragdollPoint(k, 3u));
  limb(1u, ragdollPoint(k, 6u), ragdollPoint(k, 5u));
  limb(2u, ragdollPoint(k, 8u), ragdollPoint(k, 7u));
  limb(3u, ragdollPoint(k, 10u), ragdollPoint(k, 9u));
  fingers(0.35, 0.35);
}
// Weight over the feet as the deck moves, the spine leaning against it and breathing, and held hands put back on
// what they hold. js/crew-physics.js, applySeaLegsAndBreathing.
fn seaLegs(k: u32) {
  let a = ops[k].a; let b = ops[k].b; let c = ops[k + 1u].a; let d = ops[k + 1u].b;
  let flags = u32(a.y); let stance = a.z;
  if ((flags & 1u) != 0u) {
    let footL = bone(FOOT_L); let footR = bone(FOOT_L + 4u);
    let pL = at(footL); let pR = at(footR); let qL = mquat(W[footL]); let qR = mquat(W[footR]);
    var rise = vec2f(b.z, b.w);
    // Ashore the ground is a slope, and each foot rises with it from where the foot is.
    if ((flags & 2u) != 0u) {
      rise = vec2f((b.z * pL.x + b.w * pL.z) * c.x + (-b.w * pL.x + b.z * pL.z) * c.y, (b.z * pR.x + b.w * pR.z) * c.x + (-b.w * pR.x + b.z * pR.z) * c.y);
    }
    let drop = (b.y + max(0.0, -min(rise.x, rise.y))) * stance;
    if (abs(a.w) > 1e-3 || abs(b.x) > 1e-3 || drop > 1e-3 || abs(rise.x) > 1e-3 || abs(rise.y) > 1e-3) {
      let p = at(bone(PELVIS));
      moveTo(bone(PELVIS), vec3f(p.x + a.w, p.y - drop, p.z + b.x));
      limb(2u, vec3f(pL.x, pL.y + rise.x * stance, pL.z), vec3f(0.22, 0.42, 0.82));
      limb(3u, vec3f(pR.x, pR.y + rise.y * stance, pR.z), vec3f(-0.22, 0.42, 0.82));
      let iL = mquat(parentMatrix(footL)); R[footL] = qmul(vec4f(-iL.xyz, iL.w), qL); fkFrom(footL);
      let iR = mquat(parentMatrix(footR)); R[footR] = qmul(vec4f(-iR.xyz, iR.w), qR); fkFrom(footR);
    }
  }
  let leanX = c.z; let leanZ = c.w; let breath = d.x; let breathAmp = d.y; let spread = d.z;
  let lean = array<vec2f, 3>(vec2f(0.38, 0.25), vec2f(0.36, 0.45), vec2f(0.26, 0.30));
  for (var i = 0u; i < 3u; i++) {
    let rx = (leanZ * lean[i].x - breath * breathAmp * lean[i].y) * 0.5; let rz = -leanX * lean[i].x * 0.5;
    let n = bone(SPINE1 + i);
    R[n] = qmul(R[n], vec4f(sin(rx) * cos(rz), sin(rx) * sin(rz), cos(rx) * sin(rz), cos(rx) * cos(rz)));
  }
  let shrug = max(0.0, breath) * breathAmp * 0.45;
  for (var side = 0u; side < 2u; side++) {
    let sgn = select(-1.0, 1.0, side == 0u); let clavicle = bone(CLAVICLE_L + 4u * side); let arm = bone(UPPERARM_L + 4u * side);
    if (shrug > 1e-4 || spread > 1e-4) { let half = (shrug + spread * 0.3) * 0.5 * sgn; R[clavicle] = qmul(R[clavicle], vec4f(0.0, 0.0, sin(half), cos(half))); }
    if (spread > 1e-3 && (flags & 4u) == 0u) { let half = spread * 0.5 * sgn; R[arm] = qmul(R[arm], vec4f(0.0, 0.0, sin(half), cos(half))); }
  }
  fkFrom(bone(SPINE1));
  if (gripped[0] != 0u) { limb(0u, grip[0], vec3f(0.52, 0.92, 0.32)); }
  if (gripped[1] != 0u) { limb(1u, grip[1], vec3f(-0.52, 0.92, 0.32)); }
}
fn gaze(yaw: f32, pitch: f32) {
  let share = array<vec3f, 2>(vec3f(0.35, 0.35, 0.05), vec3f(0.65, 0.65, 0.12));
  for (var i = 0u; i < 2u; i++) {
    let hy = yaw * share[i].x * 0.5; let hp = pitch * share[i].y * 0.5; let hr = -yaw * share[i].z * 0.5;
    let cy = cos(hy); let sy = sin(hy); let cp = cos(hp); let sp = sin(hp); let cr = cos(hr); let sr = sin(hr);
    let n = bone(NECK + i);
    R[n] = qmul(R[n], vec4f(cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr, cy * cp * sr - sy * sp * cr, cy * cp * cr + sy * sp * sr));
  }
  fkFrom(bone(NECK));
}
// Ease out of the last action into this one. The pass keeps each sailor's last pose and the one he is leaving;
// JavaScript keeps the clock. js/crew-physics.js, applyPoseInertializer.
fn inertia(sailor: u32, flags: u32, weight: f32) {
  let base = sailor * ${CREW_SOLVE_MEMORY}u; let pelvis = bone(PELVIS);
  if ((flags & 1u) != 0u) {
    for (var j = 0u; j < 65u; j++) { memory[base + j] = R[j]; memory[base + 65u + j] = R[j]; }
    memory[base + 130u] = vec4f(T[pelvis], 0.0); memory[base + 131u] = vec4f(T[pelvis], 0.0);
    return;
  }
  if ((flags & 2u) != 0u) {
    for (var j = 0u; j < 65u; j++) { memory[base + 65u + j] = memory[base + j]; }
    memory[base + 131u] = memory[base + 130u];
  }
  if (weight > 1e-3) {
    for (var j = 0u; j < 65u; j++) { R[j] = slerp(R[j], memory[base + 65u + j], weight); }
    T[pelvis] = mix(T[pelvis], memory[base + 131u].xyz, weight);
    fkFrom(bone(ROOT));
  }
  for (var j = 0u; j < 65u; j++) { memory[base + j] = R[j]; }
  memory[base + 130u] = vec4f(T[pelvis], 0.0);
}

@compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&sailors)) { return; }
  let sailor = sailors[id.x]; let flags = u32(sailor.more.y);
  if ((flags & 1u) == 0u) { return; }
  RIG = sailor.at.z;
  for (var j = 0u; j < 65u; j++) { T[j] = rigs[RIG].joints[j].t.xyz; S[j] = rigs[RIG].joints[j].s.xyz; }
  blendClip(0u, sailor.clip.x, 1.0, true);
  if (sailor.clip.z > 0.0) { blendClip(1u, sailor.clip.y, sailor.clip.z, false); }
  if (sailor.clip.w > 0.0) { blendClip(2u, sailor.more.x, sailor.clip.w, false); }
  fkFrom(bone(ROOT));
  var k = sailor.at.x; let last = k + sailor.at.y;
  while (k < last) {
    let op = ops[k]; let a = op.a; let b = op.b;
    switch u32(a.x) {
      case ${CREW_SOLVE_OP.blend}u { blendClip(u32(a.y), a.z, a.w, false); fkFrom(bone(ROOT)); k += 1u; }
      case ${CREW_SOLVE_OP.neutral}u { neutral(); k += 1u; }
      case ${CREW_SOLVE_OP.turn}u { turn(u32(a.y), vec3f(a.z, a.w, b.x), b.yzw); k += 1u; }
      case ${CREW_SOLVE_OP.shift}u { let n = u32(a.y); moveTo(n, at(n) + vec3f(a.z, a.w, b.x)); k += 1u; }
      case ${CREW_SOLVE_OP.move}u { moveTo(u32(a.y), vec3f(a.z, a.w, b.x)); k += 1u; }
      case ${CREW_SOLVE_OP.limb}u { limb(u32(a.y), vec3f(a.z, a.w, b.x), b.yzw); k += 1u; }
      // A reach measured from the head: the goal's height and depth, and the pole's height, are from where the head is.
      case ${CREW_SOLVE_OP.limbHead}u { let h = at(bone(HEAD)); limb(u32(a.y), vec3f(a.z, h.y + a.w, h.z + b.x), vec3f(b.y, h.y + b.z, b.w)); k += 1u; }
      case ${CREW_SOLVE_OP.gunBody}u { gunBody(k); k += 4u; }
      case ${CREW_SOLVE_OP.seated}u { seated(k); k += 3u; }
      case ${CREW_SOLVE_OP.rowFeet}u { rowFeet(k); k += 2u; }
      case ${CREW_SOLVE_OP.ragdoll}u { ragdoll(k); k += 5u; }
      // What a hand holds: a place it was sent to, or wherever its reach left it.
      case ${CREW_SOLVE_OP.grip}u { let side = u32(a.y); gripped[side] = 1u; grip[side] = select(vec3f(a.w, b.x, b.y), at(bone(HAND_L + 4u * side)), a.z > 0.5); k += 1u; }
      case ${CREW_SOLVE_OP.seaLegs}u { seaLegs(k); k += 2u; }
      case ${CREW_SOLVE_OP.gaze}u { gaze(a.y, a.z); k += 1u; }
      case ${CREW_SOLVE_OP.fingers}u { fingers(a.y, a.z); k += 1u; }
      case ${CREW_SOLVE_OP.inertia}u { inertia(sailor.at.w, u32(a.y), a.z); k += 1u; }
      case ${CREW_SOLVE_OP.injury}u {
        let n = u32(a.y); let kind = u32(a.z);
        if (kind == 1u) { S[n] = vec3f(0.001); }
        else if (kind == 2u) { S[n] = vec3f(${crushedScale.map(v => v.toFixed(4)).join(', ')}); }
        else { R[n] = qmul(R[n], vec4f(${Math.sin(brokenAngle / 2).toFixed(7)}, 0.0, 0.0, ${Math.cos(brokenAngle / 2).toFixed(7)})); }
        fkFrom(n); k += 1u;
      }
      default { k = last; }
    }
  }
  placeFingers();
  let slot = id.x * 65u;
  for (var j = 0u; j < 65u; j++) { poses[slot + j] = palette(j); }
}
`;

// Each pose just solved goes to where its body is drawn from: one of the two poses a sailor is shown between, or
// both when a change has to show at once.
export const crewPlaceWGSL = /* wgsl */`
struct Placing { solved: u32, slot: u32, beside: u32, spare: u32 }
@group(0) @binding(0) var<storage, read> placings: array<Placing>;
@group(0) @binding(1) var<storage, read> solved: array<mat4x4f>;
@group(0) @binding(2) var<storage, read_write> poses: array<mat4x4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = id.x / 65u; let j = id.x % 65u;
  if (n >= arrayLength(&placings)) { return; }
  let placing = placings[n];
  if (placing.solved == 0xffffffffu) { return; }
  let pose = solved[placing.solved * 65u + j];
  poses[placing.slot * 65u + j] = pose;
  if (placing.beside != 0xffffffffu) { poses[placing.beside * 65u + j] = pose; }
}
`;

// An arrow stays in the bone it struck. Each is kept as a point and a direction on the body at rest, and placed
// here from that bone's joint as the body is drawn this frame: a shaft and its fletching, two of the tubes the
// crew's tools are drawn from.
export const crewArrowWGSL = ({ length }) => /* wgsl */`
// The point with the tube record to write, then the direction with which joint of which body.
struct Arrow { tip: vec4f, along: vec4f }
struct Actor { transform: mat4x4f, shirt: vec4f, trousers: vec4f, skin: vec4f, hair: vec4f, face: vec4f }
struct Tube { a: vec4f, b: vec4f }
@group(0) @binding(0) var<storage, read> arrows: array<Arrow>;
@group(0) @binding(1) var<storage, read> joints: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> actors: array<Actor>;
@group(0) @binding(3) var<storage, read_write> tubes: array<Tube>;
@compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&arrows)) { return; }
  let arrow = arrows[id.x];
  if (arrow.tip.w < 0.0) { return; }
  let record = u32(arrow.tip.w); let which = u32(arrow.along.w); let joint = joints[which];
  let body = actors[which / 65u].transform;
  let tip = (joint * vec4f(arrow.tip.xyz, 1.0)).xyz; let along = (joint * vec4f(arrow.along.xyz, 0.0)).xyz; let reach = length(along);
  // A bone lost after the arrow struck takes its arrow with it.
  if (reach < 0.05) { tubes[record] = Tube(vec4f(0.0), vec4f(0.0)); tubes[record + 1u] = Tube(vec4f(0.0), vec4f(0.0)); return; }
  let a = (body * vec4f(tip, 1.0)).xyz; let b = (body * vec4f(tip - along / reach * ${length.toFixed(3)}, 1.0)).xyz;
  let back = normalize(b - a);
  tubes[record] = Tube(vec4f(a, 0.011), vec4f(b, 1.0));
  tubes[record + 1u] = Tube(vec4f(b - back * 0.1, 0.02), vec4f(b, 2.0));
}
`;
