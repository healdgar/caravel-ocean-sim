import { SPINDRIFT_COUNT, SPINDRIFT_UPDATE, SPINDRIFT_RENDER } from './wgsl/spindrift.js';

// A fixed population of world-space crest wisps; independent of ship effects.
export async function createSpindrift({ device, frameUBO, hullUBO, seaView, derivView, seaSampler, envView, transView, sunVis, shader, computePipe, shadows }) {
  const usage = GPUBufferUsage;
  const control = device.createBuffer({ label: 'crest spray control', size: 16, usage: usage.UNIFORM | usage.COPY_DST });
  const plumes = device.createBuffer({ label: 'crest spray plumes', size: SPINDRIFT_COUNT * 64, usage: usage.STORAGE | usage.COPY_SRC });
  const [updatePipe, module] = await Promise.all([computePipe(SPINDRIFT_UPDATE, 'crest spray update'), shader(SPINDRIFT_RENDER, 'crest spray')]);
  const renderPipe = await device.createRenderPipelineAsync({
    label: 'crest spray', layout: 'auto', vertex: { module, entryPoint: 'crestVS' },
    fragment: { module, entryPoint: 'crestFS', targets: [{ format: 'rgba16float', blend: {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    } }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater' }, multisample: { count: 4 },
  });
  const buffer = buffer => ({ buffer });
  const bind = (pipe, resources) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })) });
  const updateGroup = bind(updatePipe, [buffer(frameUBO), buffer(control), buffer(hullUBO), seaView, derivView, seaSampler, buffer(plumes)]);
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
  const renderGroup = bind(renderPipe, [buffer(frameUBO), buffer(plumes), envView, sampler, transView, buffer(sunVis)]);
  const shadowGroup = shadows.bind(renderPipe);
  const values = new Float32Array(4);
  let enabled = false, previousEnabled = false, needsClear = true, previousX = NaN, previousZ = NaN;
  return {
    plumes,
    update(frame, amount, dt, resetSea = false) {
      enabled = amount > 0 && frame[58] > 8;
      const reset = resetSea || enabled !== previousEnabled || !Number.isFinite(previousX)
        || Math.hypot(frame[16] - previousX, frame[18] - previousZ) > 40;
      values[0] = Math.max(0, Math.min(0.1, dt)); values[1] = reset ? 1 : 0;
      values[2] = enabled ? Math.max(0, Math.min(2, amount)) : 0; values[3] = frame[70];
      device.queue.writeBuffer(control, 0, values);
      previousX = frame[16]; previousZ = frame[18]; previousEnabled = enabled;
    },
    encode(pass) {
      if (!enabled && !needsClear) return;
      needsClear = enabled;
      pass.setPipeline(updatePipe); pass.setBindGroup(0, updateGroup); pass.dispatchWorkgroups(SPINDRIFT_COUNT / 64);
    },
    draw(pass) {
      if (!enabled) return;
      pass.setPipeline(renderPipe); pass.setBindGroup(0, renderGroup); pass.setBindGroup(1, shadowGroup); pass.draw(24, SPINDRIFT_COUNT);
    },
  };
}
