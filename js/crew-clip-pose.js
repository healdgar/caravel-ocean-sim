// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bodies with nothing to reach for, such as soldiers ashore, sailors far off or men in the water, need only a
// clip. Those are baked to the GPU once per model, and a compute pass poses every such body each frame.
// JavaScript sends a few numbers per body and touches no skeleton.
import { CREW_CLIP_POSE, CREW_SHOULDER_TURN } from './wgsl/crew.js';
import { CREW_AFLOAT_LOOPS, poseCrewAfloat } from './crew-pose.js';
import { poseCrewFingers } from './crew-physics.js';

export const CREW_CLIP_RATE = 30;
const CREW_JOINT_FLOATS = 65 * 16;
const CREW_CLIPS = ['Idle', 'Walk'];
// What a body's fourth number says of it: left alone, standing and walking by its first three, or a loop at its first.
export const CREW_CLIP_MODES = { off: 0, walk: 1, Swim: 2, Float: 3 };
// Loops that are solved once here rather than authored: a man swimming and a body afloat, slow enough for few frames.
export const CREW_SOLVED_LOOPS = CREW_AFLOAT_LOOPS.map(({ name, alive, duration, rate }) => ({
  name, duration, rate,
  pose(animator, seconds) { animator.sample('Idle', 0); poseCrewAfloat(animator, alive, seconds); poseCrewFingers(animator, null, 0.22, 0.22); },
}));

export function bakeCrewClips(animator, rate = CREW_CLIP_RATE, loops = []) {
  let total = 0;
  const authored = CREW_CLIPS.map((name) => ({ name, duration: animator.clips.get(name).duration, rate, pose: (a, seconds) => a.sample(name, seconds) }));
  const clips = [...authored, ...loops].map((clip) => {
    const frames = Math.max(1, Math.round(clip.duration * clip.rate)), first = total;
    total += frames;
    return { ...clip, frames, first };
  });
  const palettes = new Float32Array(total * CREW_JOINT_FLOATS);
  for (const clip of clips) for (let frame = 0; frame < clip.frames; frame++) {
    clip.pose(animator, frame / clip.frames * clip.duration);
    palettes.set(animator.palette, (clip.first + frame) * CREW_JOINT_FLOATS);
  }
  return { palettes, clips: clips.map(({ name, duration, frames, first }) => ({ name, duration, frames, first })) };
}
// The position in a baked clip, in frames, for a time in seconds.
export function crewClipFrame(clip, seconds) {
  const wrapped = ((seconds % clip.duration) + clip.duration) % clip.duration;
  return wrapped / clip.duration * clip.frames;
}

// `afloat` is whether anyone of this model can be in the water: a sailor can, and a villager ashore cannot.
const bakedModels = new WeakMap();
export function bakedCrewClips(device, model, afloat = true) {
  if (bakedModels.has(model)) return bakedModels.get(model);
  const { palettes, clips } = bakeCrewClips(model.animator, CREW_CLIP_RATE, afloat ? CREW_SOLVED_LOOPS : []);
  const paletteBuffer = device.createBuffer({ label: 'crew baked clips', size: palettes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(paletteBuffer, 0, palettes);
  const info = device.createBuffer({ label: 'crew baked clip layout', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  // First frame and frame count of each clip, in the order of CREW_CLIP_MODES from walk on: Idle, Walk, Swim, Float.
  const layout = new Uint32Array(8);
  clips.forEach((clip, i) => layout.set([clip.first, clip.frames], i * 2));
  device.queue.writeBuffer(info, 0, layout);
  const baked = { clips, paletteBuffer, info };
  bakedModels.set(model, baked);
  return baked;
}

export async function createCrewClipPipeline(device, shader) {
  const module = await shader(CREW_CLIP_POSE, 'crew clip pose');
  return device.createComputePipelineAsync({ label: 'crew clip pose', layout: 'auto', compute: { module, entryPoint: 'main' } });
}

// One batch of bodies, writing into `joints`. Set a body's clip times with `set`, or its place in a loop with
// `loop`, or leave it off for one whose joints something else writes this frame.
export function createCrewClipBatch(device, pipeline, model, joints, capacity, afloat = true) {
  const { clips, paletteBuffer, info } = bakedCrewClips(device, model, afloat);
  const states = new Float32Array(Math.max(1, capacity) * 4);
  const stateBuffer = device.createBuffer({ label: 'crew clip times', size: states.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const group = device.createBindGroup({ label: 'crew clip pose', layout: pipeline.getBindGroupLayout(0), entries: [paletteBuffer, info, stateBuffer, joints].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  let any = false, count = 0;
  return {
    begin(people) { any = false; count = people; },
    set(index, idleSeconds, walkSeconds, walkWeight) {
      const at = index * 4;
      states[at] = crewClipFrame(clips[0], idleSeconds); states[at + 1] = crewClipFrame(clips[1], walkSeconds); states[at + 2] = walkWeight; states[at + 3] = CREW_CLIP_MODES.walk;
      any = true;
    },
    // False when this model has no such loop, and the body is then left for whatever else poses it.
    loop(index, name, seconds) {
      const clip = clips.find((c) => c.name === name), at = index * 4;
      if (!clip || !(CREW_CLIP_MODES[name] > CREW_CLIP_MODES.walk)) { states[at + 3] = CREW_CLIP_MODES.off; return false; }
      states[at] = crewClipFrame(clip, seconds); states[at + 1] = 0; states[at + 2] = 0; states[at + 3] = CREW_CLIP_MODES[name];
      any = true;
      return true;
    },
    off(index) { states[index * 4 + 3] = CREW_CLIP_MODES.off; },
    upload() { if (any) device.queue.writeBuffer(stateBuffer, 0, states, 0, count * 4); },
    encode(pass) {
      if (!any) return;
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(count * 65 / 64));
    },
    destroy() { stateBuffer.destroy(); },
  };
}

// How much of a shoulder turn each joint takes. The legs none, so the feet stay on the line he walks; the hips a little, the
// spine more, the shoulders and arms all of it, and the head some of it back, so that he still looks where he is going.
const CREW_TURN_SHARES = [[/^(root|thigh|calf|foot|ball)/, 0], [/^pelvis/, 0.3], [/^spine_01/, 0.55], [/^spine_02/, 0.8], [/^(neck|Head)/, 0.55]];
export function crewTurnShares(animator) {
  const shares = new Float32Array(65);
  animator.joints.forEach((node, joint) => {
    const name = animator.names[node] ?? '', rule = CREW_TURN_SHARES.find(([pattern]) => pattern.test(name));
    shares[joint] = rule ? rule[1] : 1;
  });
  return shares;
}
export async function createCrewTurnPipeline(device, shader) {
  const module = await shader(CREW_SHOULDER_TURN, 'crew shoulder turn');
  return device.createComputePipelineAsync({ label: 'crew shoulder turn', layout: 'auto', compute: { module, entryPoint: 'main' } });
}
// One batch's turned shoulders. JavaScript sends one number a body, and only while anyone is turned.
export function createCrewTurnBatch(device, pipeline, model, joints, capacity) {
  const animator = model.animator, shares = crewTurnShares(animator), turns = new Float32Array(Math.max(1, capacity));
  const pelvis = animator.world[animator.nodeIndex('pelvis')];
  animator.sample('Idle', 0);
  const rig = new ArrayBuffer(16);
  new Float32Array(rig, 0, 2).set([pelvis[12], pelvis[14]]);
  new Uint32Array(rig, 8, 2).set([capacity, 0]);
  const shareBuffer = device.createBuffer({ label: 'crew turn shares', size: shares.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(shareBuffer, 0, shares);
  const rigBuffer = device.createBuffer({ label: 'crew turn rig', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(rigBuffer, 0, rig);
  const turnBuffer = device.createBuffer({ label: 'crew turns', size: turns.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const group = device.createBindGroup({ label: 'crew shoulder turn', layout: pipeline.getBindGroupLayout(0), entries: [turnBuffer, shareBuffer, rigBuffer, joints].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  let any = false;
  return {
    // Read the bodies once a frame. Nothing is sent or dispatched while everyone is square.
    update(people) {
      let turned = false, changed = false;
      for (let i = 0; i < people.length; i++) {
        const turn = people[i].shoulderTurn ?? 0;
        if (turn !== 0) turned = true;
        if (turns[i] !== turn) { turns[i] = turn; changed = true; }
      }
      if (changed) device.queue.writeBuffer(turnBuffer, 0, turns);
      any = turned;
    },
    encode(pass) {
      if (!any) return;
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(capacity * 65 / 64));
    },
    destroy() { shareBuffer.destroy(); rigBuffer.destroy(); turnBuffer.destroy(); },
  };
}
