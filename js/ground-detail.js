// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes the land's detail texture once, on the GPU, when the land loads. Nothing here runs per frame.
import { GROUND_DETAIL_BAKE, GROUND_DETAIL_MEAN, GROUND_DETAIL_SIZE } from './wgsl/ground-detail.js';

export async function createGroundDetail({ device, computePipe, mipPipe }) {
  const mips = 1 + Math.log2(GROUND_DETAIL_SIZE);
  const texture = device.createTexture({ label: 'ground detail', size: [GROUND_DETAIL_SIZE, GROUND_DETAIL_SIZE], format: 'rgba8unorm', mipLevelCount: mips, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
  const bake = await computePipe(GROUND_DETAIL_BAKE, 'ground detail bake');
  const encoder = device.createCommandEncoder({ label: 'ground detail bake' }), pass = encoder.beginComputePass();
  pass.setPipeline(bake);
  pass.setBindGroup(0, device.createBindGroup({ layout: bake.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }) }] }));
  pass.dispatchWorkgroups(GROUND_DETAIL_SIZE / 8, GROUND_DETAIL_SIZE / 8);
  pass.setPipeline(mipPipe);
  for (let m = 1; m < mips; m++) {
    pass.setBindGroup(0, device.createBindGroup({ layout: mipPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: texture.createView({ baseMipLevel: m - 1, mipLevelCount: 1 }) },
      { binding: 1, resource: texture.createView({ baseMipLevel: m, mipLevelCount: 1 }) },
    ] }));
    pass.dispatchWorkgroups(Math.ceil((GROUND_DETAIL_SIZE >> m) / 8), Math.ceil((GROUND_DETAIL_SIZE >> m) / 8));
  }
  pass.end();
  device.queue.submit([encoder.finish()]);
  const sampler = device.createSampler({ label: 'ground detail', minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
  return {
    texture, resources: [[16, texture.createView()], [17, sampler]],
    // What the land looks like with none of this. For tests and for looking into what went wrong.
    flatten() {
      const texel = GROUND_DETAIL_MEAN.map((v) => Math.round(v * 255));
      for (let m = 0; m < mips; m++) {
        const size = GROUND_DETAIL_SIZE >> m;
        device.queue.writeTexture({ texture, mipLevel: m }, new Uint8Array(size * size * 4).map((_, i) => texel[i & 3]), { bytesPerRow: size * 4 }, [size, size]);
      }
    },
    dispose() { texture.destroy(); },
  };
}
