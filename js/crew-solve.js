// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A sailor at work is posed on the GPU. Each rig's skeleton at rest and its standing, walking and bracing clips go
// up once. Each frame JavaScript writes down, for each sailor whose pose is due, where he is in those clips and
// the short list of things he is doing, and a compute pass (js/wgsl/crew-solve.js) samples, mixes and solves his
// joints from that. The list is written by the same code that poses a skeleton in JavaScript, given a recorder in
// the skeleton's place, so what a sailor does at each kind of work is said once.
import { crewSolveWGSL, crewPlaceWGSL, crewArrowWGSL, CREW_SOLVE_OP, CREW_SOLVE_BONES, CREW_SOLVE_LIMBS, CREW_SOLVE_JOINTS, CREW_SOLVE_MEMORY } from './wgsl/crew-solve.js';
import { gltfSlerp } from './gltf.js';
import { poseCrewWork, poseRotation } from './crew-pose.js';
import { applyCrewRealism, getCrewMixerMasks } from './crew-physics.js';
import { applyCrewWounds, CREW_BROKEN_ANGLE, CREW_CRUSHED_SCALE, CREW_ARROW_LENGTH } from './crew-wounds.js';

// The published page is every module in one scope, so each name here says whose it is.
const CREW_SOLVE_CLIPS = ['Idle', 'Walk', 'Brace'], CREW_SOLVE_RATE = 30;
// The rig table, in 32-bit words: what precedes the joints, each joint, each inverse bind matrix.
const CREW_RIG_HEAD_WORDS = 68, CREW_RIG_JOINT_WORDS = 20, CREW_RIG_WORDS = CREW_RIG_HEAD_WORDS + CREW_SOLVE_JOINTS * CREW_RIG_JOINT_WORDS + CREW_SOLVE_JOINTS * 16;
// One sailor's order is twelve words, and each entry of his list eight. A list is seldom ten entries long, and the
// longest, a gunner's, is seventeen: there is room for every sailor of a batch to have that at once.
const CREW_ORDER_WORDS = 12, CREW_STEP_WORDS = 8, CREW_STEPS_EACH = 20, CREW_STEPS_SPARE = 32;
const crewClipSeconds = (seconds, duration) => (duration > 0 && Number.isFinite(seconds) ? ((seconds % duration) + duration) % duration : 0);

// One channel of a clip at a time within it, as the skeleton's own sampler reads it.
function crewClipChannelAt(channel, seconds, out) {
  const { times, values, n } = channel;
  let lo = 0, hi = times.length - 1;
  while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (times[m] <= seconds) lo = m; else hi = m; }
  if (seconds >= times[hi]) lo = hi;
  const f = channel.step || lo === hi ? 0 : Math.max(0, Math.min(1, (seconds - times[lo]) / (times[hi] - times[lo])));
  if (n === 4) gltfSlerp(out, values.subarray(lo * 4, lo * 4 + 4), values.subarray(hi * 4, hi * 4 + 4), f);
  else for (let i = 0; i < n; i++) out[i] = values[lo * n + i] * (1 - f) + values[hi * n + i] * f;
  return out;
}

// Everything the pass needs of a rig, and the little JavaScript still needs of it, made once.
const crewSolveRigs = new WeakMap();
export function crewSolveRig(animator) {
  if (crewSolveRigs.has(animator)) return crewSolveRigs.get(animator);
  const a = animator, joints = a.joints;
  if (joints.length !== CREW_SOLVE_JOINTS) throw Error('The crew pose pass expects a rig of ' + CREW_SOLVE_JOINTS + ' joints');
  if (!a.footContacts?.l || !a.footContacts?.r || !a.seatContact) throw Error('The crew pose pass expects measured boots and a measured seat');
  const slots = new Int16Array(a.names.length).fill(-1);
  joints.forEach((node, slot) => { slots[node] = slot; });
  const parents = joints.map((node) => (a.parent[node] < 0 ? -1 : slots[a.parent[node]]));
  // The pass walks a joint's descendants as one run of the table, parents first.
  const under = (slot, root) => { for (let at = parents[slot]; at >= 0; at = parents[at]) if (at === root) return true; return false; };
  const ends = joints.map((_, slot) => { let end = slot + 1; while (end < CREW_SOLVE_JOINTS && under(end, slot)) end++; return end; });
  for (let slot = 0; slot < CREW_SOLVE_JOINTS; slot++) {
    if (slot > 0 && !(parents[slot] >= 0 && parents[slot] < slot)) throw Error('Crew joint ' + a.names[joints[slot]] + ' does not follow its parent joint');
    let descendants = 0;
    for (let other = 0; other < CREW_SOLVE_JOINTS; other++) if (under(other, slot)) descendants++;
    if (descendants !== ends[slot] - slot - 1) throw Error('Crew joint ' + a.names[joints[slot]] + ' is not followed by all its descendants');
  }
  const bones = CREW_SOLVE_BONES.map((name) => { const slot = slots[a.nodeIndex(name)] ?? -1; if (!(slot >= 0)) throw Error('The crew pose pass expects a joint named ' + name); return slot; });

  const clips = [];
  let keysTotal = 0;
  const moved = new Set();
  for (const name of CREW_SOLVE_CLIPS) {
    const clip = a.clips.get(name);
    if (!clip) throw Error('Missing crew animation: ' + name);
    for (const channel of clip.channels) {
      if (channel.path === 'scale' || !(slots[channel.node] >= 0)) throw Error('The crew pose pass expects clips that only turn and move joints');
      if (channel.path === 'translation') moved.add(slots[channel.node]);
    }
    const keys = Math.round(clip.duration * CREW_SOLVE_RATE) + 1;
    clips.push({ name, duration: clip.duration, keys, first: keysTotal, channels: clip.channels });
    keysTotal += keys;
  }
  if (moved.size > 1) throw Error('The crew pose pass expects clips to move one joint at most');
  const movedSlot = moved.size ? [...moved][0] : -1;
  // Every joint's turn at every key of every clip, then the one moved joint's place at each.
  const table = new Float32Array(keysTotal * CREW_SOLVE_JOINTS * 4 + keysTotal * 4), movesAt = keysTotal * CREW_SOLVE_JOINTS, q = new Float32Array(4), t = new Float32Array(3);
  for (const clip of clips) for (let key = 0; key < clip.keys; key++) {
    const row = clip.first + key, seconds = Math.min(key / CREW_SOLVE_RATE, clip.duration);
    for (let slot = 0; slot < CREW_SOLVE_JOINTS; slot++) table.set(a.rest[joints[slot]].r, (row * CREW_SOLVE_JOINTS + slot) * 4);
    if (movedSlot >= 0) table.set(a.rest[joints[movedSlot]].t, (movesAt + row) * 4);
    for (const channel of clip.channels) {
      if (channel.path === 'rotation') table.set(crewClipChannelAt(channel, seconds, q), (row * CREW_SOLVE_JOINTS + slots[channel.node]) * 4);
      else table.set(crewClipChannelAt(channel, seconds, t), (movesAt + row) * 4);
    }
  }

  const data = new ArrayBuffer(CREW_RIG_WORDS * 4), f = new Float32Array(data), u = new Uint32Array(data), n = new Int32Array(data);
  a.sample(null, 0);
  const above = a.parent[joints[0]];
  f.set(above >= 0 ? a.world[above] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
  clips.forEach((clip, i) => { u[16 + i] = clip.first; u[20 + i] = clip.keys; f[24 + i] = clip.duration; });
  f.set(poseRotation(Float32Array.from(a.footContacts.l.restWorld)), 28);
  f.set(poseRotation(Float32Array.from(a.footContacts.r.restWorld)), 32);
  f.set([a.footContacts.l.ankleAboveSole, a.footContacts.r.ankleAboveSole, a.seatContact.heelBelow, a.seatContact.heelBehind], 36);
  u.set([movedSlot >= 0 ? movedSlot : 0xffffffff, movesAt, CREW_SOLVE_RATE, 0], 40);
  u.set(bones, 44);
  for (let slot = 0; slot < CREW_SOLVE_JOINTS; slot++) {
    const at = CREW_RIG_HEAD_WORDS + slot * CREW_RIG_JOINT_WORDS, rest = a.rest[joints[slot]];
    f.set(rest.r, at); f.set(rest.t, at + 4); f.set(rest.s, at + 8);
    n[at + 16] = parents[slot]; n[at + 17] = ends[slot];
    // Everything beyond a wrist is placed last: nothing is solved from where a finger is.
    n[at + 19] = Number(under(slot, bones[10]) || under(slot, bones[14]));
  }
  // How far each finger joint curls for a full grip, and about what. js/crew-physics.js, poseCrewFingers.
  const masks = getCrewMixerMasks(a);
  for (const side of ['l', 'r']) masks.fingers[side].forEach(({ name, nodes }, finger) => nodes.forEach((node, phalanx) => {
    const at = CREW_RIG_HEAD_WORDS + slots[node] * CREW_RIG_JOINT_WORDS, cascade = name === 'thumb' ? 0.65 : 0.82 + finger * 0.09;
    f.set(name === 'thumb' ? [0.55, side === 'l' ? 0.45 : -0.45, 0.70] : [0.12, 0, 0.99], at + 12);
    f[at + 15] = cascade * (phalanx === 0 ? 0.52 : phalanx === 1 ? 0.68 : 0.48) * 1.15;
    n[at + 18] = side === 'l' ? 1 : 2;
  }));
  f.set(a.inverseBinds, CREW_RIG_HEAD_WORDS + CREW_SOLVE_JOINTS * CREW_RIG_JOINT_WORDS);

  // Where each clip puts the two feet at each key, for reading the deck under them, and where a body's middle,
  // chest and head are when it stands at rest, for sampling how wet it is.
  const footNodes = [a.footContacts.l.node, a.footContacts.r.node], feet = new Float32Array(keysTotal * 6);
  for (const clip of clips) for (let key = 0; key < clip.keys; key++) {
    a.sample(clip.name, Math.min(key / CREW_SOLVE_RATE, clip.duration - 1e-5));
    footNodes.forEach((node, side) => feet.set(a.world[node].subarray(12, 15), ((clip.first + key) * 2 + side) * 3));
  }
  a.sample(null, 0);
  const restPoints = ['pelvis', 'spine_02', 'Head'].map((name) => Array.from(a.world[a.nodeIndex(name)].subarray(12, 15)));
  // A joint's own frame on the body at rest: what its inverse bind matrix undoes. Worked out when first asked for.
  const binds = new Map();
  const bind = (slot) => {
    if (binds.has(slot)) return binds.get(slot);
    const m = a.inverseBinds.subarray(slot * 16, slot * 16 + 16), [p, q, r, s, v, w, x, y, z] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
    const A = v * z - w * y, B = w * x - s * z, C = s * y - v * x, det = p * A + q * B + r * C;
    const turn = [A / det, B / det, C / det, (r * y - q * z) / det, (p * z - r * x) / det, (q * x - p * y) / det, (q * w - r * v) / det, (r * s - p * w) / det, (p * v - q * s) / det];
    const vector = (d) => [turn[0] * d[0] + turn[3] * d[1] + turn[6] * d[2], turn[1] * d[0] + turn[4] * d[1] + turn[7] * d[2], turn[2] * d[0] + turn[5] * d[1] + turn[8] * d[2]];
    const origin = vector([-m[12], -m[13], -m[14]]), made = { vector, point: (d) => vector(d).map((n, i) => n + origin[i]) };
    binds.set(slot, made);
    return made;
  };
  const rig = { data, table, slots, bones, clips, feet, restPoints, bind };
  crewSolveRigs.set(animator, rig);
  return rig;
}

// Where a clip has the two feet at some second of it, into `out`, a pair of points.
function crewClipFeet(rig, clip, seconds, out, weight) {
  const { first, keys } = rig.clips[clip], at = Math.max(0, seconds) * CREW_SOLVE_RATE, lo = Math.min(Math.floor(at), keys - 1), hi = Math.min(lo + 1, keys - 1), f = lo === hi ? 0 : Math.min(1, at - lo);
  for (let side = 0; side < 2; side++) for (let k = 0; k < 3; k++) {
    const a = rig.feet[((first + lo) * 2 + side) * 3 + k], b = rig.feet[((first + hi) * 2 + side) * 3 + k];
    out[side][k] += (a + (b - a) * f - out[side][k]) * weight;
  }
}

// What the pose steps are given in a skeleton's place. It has the rig's names and measures but no joints: each
// step writes itself into `ops` for the pass.
function createCrewPoseRecorder(animator, rig, owner, room) {
  const ops = new Float32Array(room * CREW_STEP_WORDS);
  return {
    record: true, owner, slotOf: 0, ops, used: 0, full: false,
    names: animator.names, parent: animator.parent, rest: animator.rest, clips: animator.clips, pose: { length: animator.pose.length },
    footContacts: animator.footContacts, seatContact: animator.seatContact, nodeIndex: animator.nodeIndex,
    // Where the clips alone would have the feet, in the sailor's own frame.
    feet: [[0, 0, 0], [0, 0, 0]],
    slot(node) {
      const slot = rig.slots[node];
      if (!(slot >= 0)) throw Error('Not a crew joint: ' + animator.names[node]);
      return slot;
    },
    put(code, ...values) {
      const entries = Math.ceil((values.length + 1) / CREW_STEP_WORDS), at = this.used * CREW_STEP_WORDS;
      if (this.used + entries > room) { this.full = true; return; }
      ops.fill(0, at, at + entries * CREW_STEP_WORDS);
      ops[at] = code;
      ops.set(values, at + 1);
      this.used += entries;
    },
    limb(code, upper, target, pole) { this.put(code, CREW_SOLVE_LIMBS[upper], target[0], target[1], target[2], pole[0], pole[1], pole[2]); },
    blend(name, time, weight) {
      if (!(weight > 0)) return;
      const clip = CREW_SOLVE_CLIPS.indexOf(name), seconds = crewClipSeconds(time, rig.clips[clip].duration);
      this.put(CREW_SOLVE_OP.blend, clip, seconds, Math.min(1, weight));
      crewClipFeet(rig, clip, seconds, this.feet, Math.min(1, weight));
    },
    stand(idle, walkSeconds, walk, braceSeconds, brace) {
      crewClipFeet(rig, 0, idle, this.feet, 1);
      if (walk > 0) crewClipFeet(rig, 1, walkSeconds, this.feet, walk);
      if (brace > 0) crewClipFeet(rig, 2, braceSeconds, this.feet, brace);
    },
    shifted(by) { for (const foot of this.feet) for (let k = 0; k < 3; k++) foot[k] += by[k]; },
    bodyPoints(lift) { return rig.restPoints.map((p) => [p[0], p[1] + lift, p[2]]); },
  };
}

// One solver for a device. The GPU is about as long over one sailor's pose as over a hundred at once, and as long
// again for each further dispatch, so every batch of bodies on the device, whatever vessel or fort it belongs to,
// is solved in the one dispatch. Each batch writes its sailors down; the first to be encoded in a frame sends
// what all of them wrote, solves it, and has each pose put where its body is drawn from.
const crewSolvers = new WeakMap();
export function createCrewSolver(device, shader) {
  if (!crewSolvers.has(device)) crewSolvers.set(device, makeCrewSolver(device, shader));
  return crewSolvers.get(device);
}
const CREW_POSE_NOWHERE = 0xffffffff;
async function makeCrewSolver(device, shader) {
  const compile = async (code, label) => device.createComputePipelineAsync({ label, layout: 'auto', compute: { module: await shader(code, label), entryPoint: 'main' } });
  const [pipeline, placing] = await Promise.all([compile(crewSolveWGSL({ brokenAngle: CREW_BROKEN_ANGLE, crushedScale: CREW_CRUSHED_SCALE }), 'crew pose solve'), compile(crewPlaceWGSL, 'crew pose placing')]);
  const B = GPUBufferUsage, usage = B.STORAGE | B.COPY_DST, batches = new Set(), rigs = [], blocks = [];
  let rigBuffer = null, clipBuffer = null, orderBuffer = null, stepBuffer = null, solved = null, memory = null, group = null;
  let orders = new Uint32Array(0), steps = new Float32Array(0), roomPeople = 0, roomEntries = 0, roomMemory = 0;
  // What has been written into the pass now being encoded, which has yet to run with it.
  let lastPass = null, usedPeople = 0, usedEntries = 0;
  // A buffer that has been outgrown may still be named by a pass not yet submitted.
  const retire = (buffer) => { if (buffer) device.queue.onSubmittedWorkDone().then(() => buffer.destroy(), () => {}); };
  const filled = (label, data) => { const buffer = device.createBuffer({ label, size: data.byteLength, usage }); device.queue.writeBuffer(buffer, 0, data); return buffer; };
  // Every rig in one table, and every rig's clip keys in another. Each rig's keys start on a whole pose, so a key
  // is still a run of 65 turns.
  const layRigs = () => {
    let keys = 0;
    const firsts = rigs.map((rig) => { const first = keys; keys += Math.ceil(rig.table.length / 4 / CREW_SOLVE_JOINTS) * CREW_SOLVE_JOINTS; return first; });
    const table = new Uint32Array(rigs.length * CREW_RIG_WORDS), clips = new Float32Array(keys * 4);
    rigs.forEach((rig, id) => {
      const at = id * CREW_RIG_WORDS;
      table.set(new Uint32Array(rig.data), at);
      for (let clip = 0; clip < CREW_SOLVE_CLIPS.length; clip++) table[at + 16 + clip] += firsts[id] / CREW_SOLVE_JOINTS;
      // The one moved joint's places follow the turns, and are counted from the rig's first key as the turns are.
      table[at + 41] += firsts[id] - firsts[id] / CREW_SOLVE_JOINTS;
      clips.set(rig.table, firsts[id] * 4);
    });
    retire(rigBuffer); retire(clipBuffer);
    rigBuffer = filled('crew rigs at rest', table); clipBuffer = filled('crew clip keys', clips);
    group = null;
  };
  // Room for everybody at once: their orders, their steps, the poses solved, and what is remembered of each.
  const lay = () => {
    let people = 0, entries = 0;
    for (const batch of batches) { people += batch.people; entries += batch.room; }
    const last = blocks.at(-1), remembered = last ? last.at + last.size : 0;
    if (!rigBuffer) layRigs();
    if (people > roomPeople) {
      roomPeople = Math.ceil(people * 1.25 / 8) * 8;
      retire(orderBuffer); retire(solved);
      orders = new Uint32Array(roomPeople * CREW_ORDER_WORDS);
      orderBuffer = device.createBuffer({ label: 'crew pose orders', size: orders.byteLength, usage });
      solved = device.createBuffer({ label: 'crew poses just solved', size: roomPeople * CREW_SOLVE_JOINTS * 64, usage: B.STORAGE });
      group = null;
      for (const batch of batches) batch.placed = null;
    }
    if (entries > roomEntries) {
      roomEntries = Math.ceil(entries * 1.25);
      retire(stepBuffer);
      steps = new Float32Array(roomEntries * CREW_STEP_WORDS);
      stepBuffer = device.createBuffer({ label: 'crew pose steps', size: steps.byteLength, usage });
      group = null;
    }
    if (remembered > roomMemory) {
      const room = Math.ceil(remembered * 1.25), next = device.createBuffer({ label: 'crew pose memory', size: room * CREW_SOLVE_MEMORY * 16, usage: B.STORAGE | B.COPY_SRC | B.COPY_DST });
      // What is remembered of those already aboard goes with them.
      if (memory) { const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(memory, 0, next, 0, roomMemory * CREW_SOLVE_MEMORY * 16); device.queue.submit([encoder.finish()]); retire(memory); }
      memory = next; roomMemory = room; group = null;
    }
    group ??= device.createBindGroup({ label: 'crew pose solve', layout: pipeline.getBindGroupLayout(0), entries: [rigBuffer, clipBuffer, orderBuffer, stepBuffer, memory, solved].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  };
  return {
    // A batch joins with the rig it is built on, and is told which that is and where its sailors are remembered.
    join(batch, rig) {
      let id = rigs.indexOf(rig);
      if (id < 0) { id = rigs.push(rig) - 1; retire(rigBuffer); retire(clipBuffer); rigBuffer = clipBuffer = null; }
      let block = blocks.find((b) => b.free && b.size >= batch.people);
      if (block) {
        if (block.size > batch.people) blocks.splice(blocks.indexOf(block) + 1, 0, { at: block.at + batch.people, size: block.size - batch.people, free: true });
      } else if (blocks.at(-1)?.free) block = blocks.at(-1);
      else { const last = blocks.at(-1); block = { at: last ? last.at + last.size : 0 }; blocks.push(block); }
      block.size = batch.people; block.free = false;
      batches.add(batch);
      lay();
      return { rig: id, block };
    },
    leave(batch, block) {
      batches.delete(batch);
      block.free = true;
      for (let i = blocks.length - 1; i > 0; i--) if (blocks[i].free && blocks[i - 1].free) { blocks[i - 1].size += blocks[i].size; blocks.splice(i, 1); }
    },
    // Everything written down and not yet solved, in one dispatch, and each pose then put in its place.
    flush(pass) {
      const due = [];
      let people = 0, entries = 0;
      for (const batch of batches) if (batch.ready) { due.push(batch); people += batch.ready; entries += batch.entries; }
      if (!people) return;
      const whole = Math.ceil(people / 8) * 8;
      // Normally one flush serves a frame. A second into the same pass goes after the first, which has yet to run
      // with what it wrote; its orders and poses start on a boundary a buffer may be bound from.
      if (pass !== lastPass || usedPeople + whole > roomPeople || usedEntries + entries > roomEntries) { usedPeople = 0; usedEntries = 0; }
      lastPass = pass;
      const first = usedPeople, firstEntry = usedEntries;
      let at = first, entry = firstEntry;
      for (const batch of due) {
        orders.set(batch.orders.subarray(0, batch.ready * CREW_ORDER_WORDS), at * CREW_ORDER_WORDS);
        for (let n = 0; n < batch.ready; n++) { orders[(at + n) * CREW_ORDER_WORDS + 8] += entry; batch.placings[n * 4] = at + n; }
        batch.placings[batch.ready * 4] = CREW_POSE_NOWHERE;
        steps.set(batch.steps.subarray(0, batch.entries * CREW_STEP_WORDS), entry * CREW_STEP_WORDS);
        device.queue.writeBuffer(batch.placingBuffer, 0, batch.placings, 0, (batch.ready + 1) * 4);
        at += batch.ready; entry += batch.entries;
      }
      // Nobody is in the places that only fill out the last group of eight.
      for (let i = at; i < first + whole; i++) orders[i * CREW_ORDER_WORDS + 5] = 0;
      device.queue.writeBuffer(orderBuffer, first * CREW_ORDER_WORDS * 4, orders, first * CREW_ORDER_WORDS, whole * CREW_ORDER_WORDS);
      if (entries) device.queue.writeBuffer(stepBuffer, firstEntry * CREW_STEP_WORDS * 4, steps, firstEntry * CREW_STEP_WORDS, entries * CREW_STEP_WORDS);
      const bound = first ? device.createBindGroup({ label: 'crew pose solve, later in a pass', layout: pipeline.getBindGroupLayout(0), entries: [rigBuffer, clipBuffer, { buffer: orderBuffer, offset: first * CREW_ORDER_WORDS * 4 }, stepBuffer, memory, { buffer: solved, offset: first * CREW_SOLVE_JOINTS * 64 }].map((resource, binding) => ({ binding, resource: resource.buffer ? resource : { buffer: resource } })) }) : group;
      pass.setPipeline(pipeline); pass.setBindGroup(0, bound); pass.dispatchWorkgroups(whole / 8);
      usedPeople = Math.ceil((first + whole) / 16) * 16; usedEntries = entry;
      pass.setPipeline(placing);
      for (const batch of due) {
        batch.placed ??= device.createBindGroup({ label: 'crew pose placing', layout: placing.getBindGroupLayout(0), entries: [batch.placingBuffer, solved, batch.poses].map((buffer, binding) => ({ binding, resource: { buffer } })) });
        pass.setBindGroup(0, batch.placed); pass.dispatchWorkgroups(Math.ceil(batch.ready * CREW_SOLVE_JOINTS / 64));
        batch.ready = 0;
      }
    },
  };
}

// One batch of bodies on one rig, solved into `poses`, a buffer of 65 matrices a pose. `add` writes down one
// sailor's pose for this frame; `upload` says the writing is done; `encode` has the solver solve whatever is
// waiting, this batch's and every other's.
export function createCrewSolveBatch(device, solver, model, poses, capacity) {
  const rig = crewSolveRig(model.animator), people = Math.max(1, capacity), room = people * CREW_STEPS_EACH + CREW_STEPS_SPARE;
  const orders = new Uint32Array(people * CREW_ORDER_WORDS), numbers = new Float32Array(orders.buffer), placings = new Uint32Array((people + 1) * 4);
  const placingBuffer = device.createBuffer({ label: 'crew pose places', size: placings.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const batch = { people, room, poses, orders, placings, placingBuffer, steps: null, ready: 0, entries: 0, placed: null }, recorder = createCrewPoseRecorder(model.animator, rig, batch, room);
  batch.steps = recorder.ops;
  const joined = solver.join(batch, rig);
  let count = 0;
  return Object.assign(batch, {
    recorder,
    begin() { count = 0; recorder.used = 0; batch.ready = 0; },
    // `index` is the sailor's own place in the batch, where the pass keeps what it remembers of him, and `slot`
    // the pose to write. `snap` writes the pose beside it too. `work` is whether he has a job to be posed at.
    // False when there is no room left to write him down; he is then somebody else's to pose this frame.
    add(index, s, boat, dt, slot, { snap = false, work = true } = {}) {
      if (count >= people) return false;
      const first = recorder.used, idle = crewClipSeconds(s.time, rig.clips[0].duration), walkSeconds = crewClipSeconds(s.walkTime, rig.clips[1].duration), braceSeconds = crewClipSeconds(s.time, rig.clips[2].duration);
      const walk = Math.max(0, Math.min(1, s.walk || 0)), brace = s.brace > 0.001 && !(s.job?.rung > 0) ? Math.min(1, s.brace) : 0;
      recorder.full = false; recorder.slotOf = index;
      recorder.stand(idle, walkSeconds, walk, braceSeconds, brace);
      if (work) {
        poseCrewWork(recorder, s, boat);
        ['hand_l', 'hand_r'].forEach((name, side) => { const held = s.grips?.[name]; if (held) recorder.put(CREW_SOLVE_OP.grip, side, held.reached ? 1 : 0, held[0], held[1], held[2]); });
      }
      applyCrewRealism(recorder, s, boat, dt);
      applyCrewWounds(recorder, s);
      if (recorder.full) { recorder.used = first; return false; }
      const at = count * CREW_ORDER_WORDS;
      numbers.set([idle, walkSeconds, walk, brace, braceSeconds, 1, 0, 0], at);
      orders.set([first, recorder.used - first, joined.rig, joined.block.at + index], at + 8);
      placings.set([0, slot, snap ? slot ^ 1 : CREW_POSE_NOWHERE, 0], count * 4);
      count++;
      return true;
    },
    upload() { batch.ready = count; batch.entries = recorder.used; },
    encode(pass) { solver.flush(pass); },
    destroy() { batch.ready = 0; solver.leave(batch, joined.block); placingBuffer.destroy(); },
  });
}

// The one time JavaScript poses a sailor's skeleton in a frame: a shot has just struck him, and which bone it
// struck is found on his pose as it is now. It leaves his injuries and arrows for every later pose to show.
export function resolveCrewWoundsOnSkeleton(animator, s, boat, work = true) {
  animator.sample('Idle', s.time, 'Walk', s.walkTime, s.walk);
  if (s.brace > 0.001 && !(s.job?.rung > 0)) animator.blend('Brace', s.time, s.brace);
  if (work) poseCrewWork(animator, s, boat);
  applyCrewRealism(animator, s, boat, 0, false);
  applyCrewWounds(animator, s);
  // Where his arrows are from now on is worked out on the GPU, from the joints he is drawn with.
  s.stuckArrowPoses = null;
}

// An arrow as the arrow pass wants it: the joint it is stuck in, and where on the body at rest it stands. It is
// kept on the arrow, which stays in the one body.
function crewArrowAtRest(animator, arrow) {
  if (arrow.atRest) return arrow.atRest;
  const rig = crewSolveRig(animator), joint = rig.slots[animator.nodeIndex(arrow.bone)] ?? -1;
  if (!(joint >= 0)) return null;
  const frame = rig.bind(joint);
  return (arrow.atRest = { joint, tip: frame.point(arrow.offset), along: frame.vector(arrow.direction) });
}
export async function createCrewArrowPipeline(device, shader) {
  const module = await shader(crewArrowWGSL({ length: CREW_ARROW_LENGTH }), 'crew arrows');
  return device.createComputePipelineAsync({ label: 'crew arrows', layout: 'auto', compute: { module, entryPoint: 'main' } });
}
// The arrows stuck in one batch of bodies. 'joints' and 'actors' are what the bodies are drawn from, and 'tubes'
// the records their arrows are drawn from; 'add' names the pair of records an arrow is to fill.
export function createCrewArrowBatch(device, pipeline, joints, actors, tubes, capacity) {
  const room = Math.ceil(Math.max(1, capacity) / 8) * 8, data = new Float32Array(room * 8);
  const buffer = device.createBuffer({ label: 'crew arrows', size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const group = device.createBindGroup({ label: 'crew arrows', layout: pipeline.getBindGroupLayout(0), entries: [buffer, joints, actors, tubes].map((resource, binding) => ({ binding, resource: { buffer: resource } })) });
  let count = 0, sent = 0;
  return {
    begin() { count = 0; },
    add(record, index, animator, arrow) {
      const rest = count < room ? crewArrowAtRest(animator, arrow) : null;
      if (!rest) return false;
      data.set([...rest.tip, record, ...rest.along, index * CREW_SOLVE_JOINTS + rest.joint], count * 8);
      count++;
      return true;
    },
    upload() {
      sent = count;
      if (!count) return;
      const whole = Math.ceil(count / 8) * 8;
      for (let i = count; i < whole; i++) data[i * 8 + 3] = -1;
      device.queue.writeBuffer(buffer, 0, data, 0, whole * 8);
    },
    encode(pass) {
      if (!sent) return;
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(sent / 8));
    },
    destroy() { buffer.destroy(); },
  };
}
