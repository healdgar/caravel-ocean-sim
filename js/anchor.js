// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The splash a let-go anchor throws up. Her iron, its ring and its rode are her own assembly and detail lines,
// placed in her pose pass from her compact anchor state (js/vessel-detail.js).
import { requestOnce } from './gpu-program-cache.js';
import { ANCHOR_SPLASH_RENDER, ANCHOR_SPLASH_RING_VERTICES, ANCHOR_SPLASH_DROP_VERTICES } from './wgsl/anchor.js';
import { anchorEquipment } from './anchor-state.js';

export const ANCHOR_SPLASH_FLOATS = 8;
export const ANCHOR_SPLASH_SECONDS = 1.6;
const ANCHOR_SPLASH_DROP_SECONDS = 0.75;

// The splash's compact state: where the iron struck and how long ago, and the anchor's scale. Returns how many
// vertices to draw: none once it has settled, the ring alone once its drops have fallen.
export function writeAnchorSplashState(state, boat, target) {
  if (!(target instanceof Float32Array) || target.length !== ANCHOR_SPLASH_FLOATS) throw Error('Anchor splash state has wrong shape');
  const splash = state.phase === 'stowed' ? null : state.splash, age = splash ? state.time - splash.at : -1;
  if (!splash || age < 0 || age >= ANCHOR_SPLASH_SECONDS) return 0;
  target.set([splash.x, splash.y, splash.z, age, anchorEquipment(boat).renderScale, 0, 0, 0]);
  return ANCHOR_SPLASH_RING_VERTICES + (age < ANCHOR_SPLASH_DROP_SECONDS ? ANCHOR_SPLASH_DROP_VERTICES : 0);
}

// The splash's program, asked for once a device and shared by the fleet: blended over the sea, writing no depth.
export function requestAnchorSplashPipeline({ device, shader, format, samples }) {
  return requestOnce(device, `anchor splash ${format} ${samples}`, async () => {
    const module = await shader(ANCHOR_SPLASH_RENDER, 'anchor splash');
    const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' };
    return device.createRenderPipelineAsync({
      label: 'anchor splash', layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color: blend, alpha: blend } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater' },
      multisample: { count: samples },
    });
  });
}

export async function createAnchorSplashRenderer({ device, frameUBO, transView, skyView, sampler, envCubeView, sunVisBuf, shadows, shader, format, samples }) {
  const pipe = await requestAnchorSplashPipeline({ device, shader, format, samples });
  const buffer = device.createBuffer({ label: 'anchor splash', size: ANCHOR_SPLASH_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const values = new Float32Array(ANCHOR_SPLASH_FLOATS);
  const resources = [[0, { buffer: frameUBO }], [1, transView], [2, skyView], [3, sampler], [4, envCubeView], [5, { buffer: sunVisBuf }], [7, { buffer }]];
  const group = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: resources.map(([binding, resource]) => ({ binding, resource })) });
  const shadowGroup = shadows.bind(pipe);
  let count = 0;
  return {
    update(state, boat) {
      count = writeAnchorSplashState(state, boat, values);
      if (count) device.queue.writeBuffer(buffer, 0, values);
    },
    draw(pass) {
      if (!count) return;
      pass.setPipeline(pipe); pass.setBindGroup(0, group); pass.setBindGroup(1, shadowGroup); pass.draw(count);
    },
    destroy() { buffer.destroy(); },
  };
}
