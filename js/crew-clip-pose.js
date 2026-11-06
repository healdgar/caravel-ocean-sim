// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bodies with nothing to reach for, such as soldiers ashore or sailors far off, need only their
// walking and standing clips. Those are baked to the GPU once per model, and a compute pass poses
// every such body each frame. JavaScript sends a few numbers per body and touches no skeleton.
import { CREW_CLIP_POSE } from './wgsl/crew.js';

export const CREW_CLIP_RATE = 30;
const CREW_JOINT_FLOATS = 65 * 16;
const CREW_CLIPS = ['Idle', 'Walk'];

export function bakeCrewClips(animator, rate = CREW_CLIP_RATE) {
  let total = 0;
  const clips = CREW_CLIPS.map((name) => {
    const duration = animator.clips.get(name).duration, frames = Math.max(1, Math.round(duration * rate)), first = total;
    total += frames;
    return { name, duration, frames, first };
  });
  const palettes = new Float32Array(total * CREW_JOINT_FLOATS);
  for (const clip of clips) for (let frame = 0; frame < clip.frames; frame++) {
    animator.sample(clip.name, frame / clip.frames * clip.duration);
    palettes.set(animator.palette, (clip.first + frame) * CREW_JOINT_FLOATS);
  }
  return { palettes, clips };
}
// The position in a baked clip, in frames, for a time in seconds.
export function crewClipFrame(clip, seconds) {
  const wrapped = ((seconds % clip.duration) + clip.duration) % clip.duration;
  return wrapped / clip.duration * clip.frames;
}

const bakedModels = new WeakMap();
export function bakedCrewClips(device, model) {
  if (bakedModels.has(model)) return bakedModels.get(model);
  const { palettes, clips } = bakeCrewClips(model.animator);
  const paletteBuffer = device.createBuffer({ label: 'crew baked clips', size: palettes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(paletteBuffer, 0, palettes);
  const info = device.createBuffer({ label: 'crew baked clip layout', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(info, 0, new Uint32Array([clips[0].first, clips[0].frames, clips[1].first, clips[1].frames]));
  const baked = { clips, paletteBuffer, info };
  bakedModels.set(model, baked);
  return baked;
}

export async function createCrewClipPipeline(device, shader) {
  const module = await shader(CREW_CLIP_POSE, 'crew clip pose');
  return device.createComputePipelineAsync({ label: 'crew clip pose', layout: 'auto', compute: { module, entryPoint: 'main' } });
}

// One batch of bodies, writing into `joints`. Set a body's clip times with `set`, or leave it off
// for one whose joints something else writes this frame.
export function createCrewClipBatch(device, pipeline, model, joints, capacity) {
  const { clips, paletteBuffer, info } = bakedCrewClips(device, model);
  const states = new Float32Array(Math.max(1, capacity) * 4);
  const stateBuffer = device.createBuffer({ label: 'crew clip times', size: states.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const group = device.createBindGroup({ label: 'crew clip pose', layout: pipeline.getBindGroupLayout(0), entries: [paletteBuffer, info, stateBuffer, joints].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  let any = false, count = 0;
  return {
    begin(people) { any = false; count = people; },
    set(index, idleSeconds, walkSeconds, walkWeight) {
      const at = index * 4;
      states[at] = crewClipFrame(clips[0], idleSeconds); states[at + 1] = crewClipFrame(clips[1], walkSeconds); states[at + 2] = walkWeight; states[at + 3] = 1;
      any = true;
    },
    off(index) { states[index * 4 + 3] = 0; },
    upload() { if (any) device.queue.writeBuffer(stateBuffer, 0, states, 0, count * 4); },
    encode(pass) {
      if (!any) return;
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(count * 65 / 64));
    },
    destroy() { stateBuffer.destroy(); },
  };
}
