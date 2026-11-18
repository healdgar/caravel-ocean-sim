// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The people continuum's baked bodies (js/crew-continuum-draw.js), read from this checkout for tests on a device that
// makes nothing. Their streams are published, not committed: where they are not baked, people cannot be drawn at all.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { CREW_CONTINUUM_ASSETS } from '../../js/crew-continuum.js';

const root = new URL('../../', import.meta.url);
// Whether every file of these bodies is baked here.
export const crewContinuumBaked = (ids) => ids.every((id) => Object.values(CREW_CONTINUUM_ASSETS[id]).every((file) => existsSync(new URL(file, root))));
// fetch() for the bodies' files, from disk: a HEAD is answered without the body, and anything absent is a 404.
export async function fetchCrewContinuumAsset(path, init = {}) {
  try {
    const bytes = await readFile(new URL(path, root));
    return new Response(init.method === 'HEAD' ? null : bytes);
  } catch {
    return new Response(null, { status: 404 });
  }
}
// What a body asks of a device beyond buffers and bind groups: its picture (in BC7, which this device reads, for a
// person's picture is never stood in for), its sampler, and the one cut's layouts.
export function crewContinuumDevice(device) {
  const texture = (d) => ({ ...d, createView: () => ({ texture: d.label }), destroy() {} });
  return Object.assign(device, {
    features: new Set(['texture-compression-bc']),
    createTexture: texture,
    createSampler: (d) => ({ ...d }),
    createBindGroupLayout: (d) => ({ ...d }),
    createPipelineLayout: (d) => ({ ...d }),
    queue: Object.assign(device.queue, { writeTexture() {}, onSubmittedWorkDone: () => Promise.resolve() }),
  });
}
// The WebGPU enumerations the continuum's loader and programs name, set for a test and put back after it.
export function crewContinuumGlobals(t) {
  const set = {
    GPUBufferUsage: { VERTEX: 1, INDEX: 2, UNIFORM: 4, STORAGE: 8, COPY_DST: 16, INDIRECT: 32, COPY_SRC: 64 },
    GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
    GPUColorWrite: { ALL: 15 },
  };
  const before = Object.fromEntries(Object.keys(set).map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, set);
  t.after(() => { for (const [name, value] of Object.entries(before)) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value; } });
}
