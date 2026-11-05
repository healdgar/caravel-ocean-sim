// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Each ship's shadow on the sea, baked once a frame into a texture with blur levels. Shadows on
// water are soft and low in detail, so a few reads of the right blur replace over a hundred fetches.
import { SEA_SHADOW_BAKE, SEA_SHADOW_LEVEL, SEA_SHADOW_REDUCTION, SEA_SHADOW_LEVELS } from './wgsl/shadows.js';

export async function createSeaShadows({ device, computePipe, sceneShadows, count }) {
  const [bake, level] = await Promise.all([computePipe(SEA_SHADOW_BAKE(count), 'sea shadow bake'), computePipe(SEA_SHADOW_LEVEL, 'sea shadow blur')]);
  const size = sceneShadows.resolution / SEA_SHADOW_REDUCTION;
  const texture = device.createTexture({ label: 'sea shadows', size: [size, size, count], format: 'rgba8unorm', mipLevelCount: SEA_SHADOW_LEVELS, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
  const levelView = (layer, mip) => texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: mip, mipLevelCount: 1 });
  const layerBuffers = [], layers = [];
  for (let layer = 0; layer < count; layer++) {
    const layerBuffer = device.createBuffer({ label: 'sea shadow layer', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(layerBuffer, 0, new Uint32Array([layer, 0, 0, 0]));
    layerBuffers.push(layerBuffer);
    const { uniform, solid, compare, canvas, filter, linear } = sceneShadows.sources;
    layers.push({
      bake: device.createBindGroup({ label: 'sea shadow bake', layout: bake.getBindGroupLayout(0), entries: [uniform, { buffer: layerBuffer }, solid, compare, canvas, filter, linear, levelView(layer, 0)].map((resource, binding) => ({ binding, resource })) }),
      levels: Array.from({ length: SEA_SHADOW_LEVELS - 1 }, (_, mip) => device.createBindGroup({ label: 'sea shadow blur', layout: level.getBindGroupLayout(0), entries: [{ binding: 0, resource: levelView(layer, mip) }, { binding: 1, resource: levelView(layer, mip + 1) }] })),
    });
  }
  const workgroups = (mip) => Math.ceil(Math.max(1, size >> mip) / 8);
  return {
    view: texture.createView({ dimension: '2d-array' }),
    // `live` says which layers have a fresh shadow map this frame.
    encode(encoder, live) {
      const pass = encoder.beginComputePass({ label: 'sea shadows' });
      for (let layer = 0; layer < count; layer++) {
        if (!live(layer)) continue;
        pass.setPipeline(bake); pass.setBindGroup(0, layers[layer].bake); pass.dispatchWorkgroups(workgroups(0), workgroups(0));
        pass.setPipeline(level);
        layers[layer].levels.forEach((group, mip) => { pass.setBindGroup(0, group); pass.dispatchWorkgroups(workgroups(mip + 1), workgroups(mip + 1)); });
      }
      pass.end();
    },
    destroy() { texture.destroy(); for (const buffer of layerBuffers) buffer.destroy(); },
  };
}
