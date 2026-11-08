// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes the land's detail texture once, on the GPU, when the land loads. Nothing here runs per frame.
import { GROUND_DETAIL_BAKE, GROUND_DETAIL_MEAN, GROUND_DETAIL_SIZE } from './wgsl/ground-detail.js';

export const ARCH_MATERIAL_SIZE = 256;
export const ARCH_MATERIAL_LAYERS = 18;
export const ARCH_LAYER_STRIDE = 87360; // 256^2 + 128^2 + 64^2 + 32^2 + 16^2 + 8^2

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

  // MaterialCraft-cooked 18-layer mipmapped PBR storage buffer (Kind 10..18: even = BaseColor+Roughness, odd = Normal+AO)
  // Using a read-only storage buffer adds 0 sampled textures to @group(0), preserving WebGPU's 16-texture ceiling in water-optics capture.
  const totalWords = ARCH_MATERIAL_LAYERS * ARCH_LAYER_STRIDE;
  const archWords = new Uint32Array(totalWords);
  for (let layer = 0; layer < ARCH_MATERIAL_LAYERS; layer++) {
    const fillWord = (layer & 1) === 0 ? 0xc08ea2b0 : 0xebff8080;
    archWords.fill(fillWord, layer * ARCH_LAYER_STRIDE, (layer + 1) * ARCH_LAYER_STRIDE);
  }
  const archBuffer = device.createBuffer({
    label: 'MaterialCraft architectural PBR storage buffer',
    size: archWords.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  if (typeof fetch === 'function' && typeof createImageBitmap === 'function') {
    try {
      const assetPath = 'assets/ports/1550/land-materials-pbr.png';
      const url = typeof location !== 'undefined' ? assetPath : new URL('../' + assetPath, import.meta.url).href;
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
        const totalH = ARCH_MATERIAL_SIZE * ARCH_MATERIAL_LAYERS;
        if (bmp.width === ARCH_MATERIAL_SIZE && bmp.height === totalH) {
          const canvas = typeof OffscreenCanvas === 'function'
            ? new OffscreenCanvas(ARCH_MATERIAL_SIZE, totalH)
            : Object.assign(document.createElement('canvas'), { width: ARCH_MATERIAL_SIZE, height: totalH });
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(bmp, 0, 0);
          const rgba = ctx.getImageData(0, 0, ARCH_MATERIAL_SIZE, totalH).data;
          const srcWords = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2);
          for (let layer = 0; layer < ARCH_MATERIAL_LAYERS; layer++) {
            const baseWordOff = layer * ARCH_LAYER_STRIDE;
            const srcLayerOff = layer * ARCH_MATERIAL_SIZE * ARCH_MATERIAL_SIZE;
            archWords.set(srcWords.subarray(srcLayerOff, srcLayerOff + ARCH_MATERIAL_SIZE * ARCH_MATERIAL_SIZE), baseWordOff);
            let prevOff = baseWordOff;
            let prevSize = ARCH_MATERIAL_SIZE;
            let dstOff = baseWordOff + ARCH_MATERIAL_SIZE * ARCH_MATERIAL_SIZE;
            const isNormalLayer = (layer & 1) === 1;
            for (let m = 1; m <= 5; m++) {
              const nextSize = prevSize >> 1;
              for (let y = 0; y < nextSize; y++) {
                const y0 = (y * 2) * prevSize;
                const y1 = (y * 2 + 1) * prevSize;
                for (let x = 0; x < nextSize; x++) {
                  const x0 = x * 2;
                  const w00 = archWords[prevOff + y0 + x0];
                  const w10 = archWords[prevOff + y0 + x0 + 1];
                  const w01 = archWords[prevOff + y1 + x0];
                  const w11 = archWords[prevOff + y1 + x0 + 1];
                  let r = ((w00 & 255) + (w10 & 255) + (w01 & 255) + (w11 & 255) + 2) >> 2;
                  let g = (((w00 >>> 8) & 255) + ((w10 >>> 8) & 255) + ((w01 >>> 8) & 255) + ((w11 >>> 8) & 255) + 2) >> 2;
                  let b = (((w00 >>> 16) & 255) + ((w10 >>> 16) & 255) + ((w01 >>> 16) & 255) + ((w11 >>> 16) & 255) + 2) >> 2;
                  const a = (((w00 >>> 24) & 255) + ((w10 >>> 24) & 255) + ((w01 >>> 24) & 255) + ((w11 >>> 24) & 255) + 2) >> 2;
                  if (isNormalLayer) {
                    let nx = (r / 255) * 2 - 1;
                    let ny = (g / 255) * 2 - 1;
                    let nz = (b / 255) * 2 - 1;
                    const len = Math.hypot(nx, ny, nz) || 1;
                    r = Math.round(((nx / len) * 0.5 + 0.5) * 255);
                    g = Math.round(((ny / len) * 0.5 + 0.5) * 255);
                    b = Math.round(((nz / len) * 0.5 + 0.5) * 255);
                  }
                  archWords[dstOff + y * nextSize + x] = (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
                }
              }
              prevOff = dstOff;
              prevSize = nextSize;
              dstOff += nextSize * nextSize;
            }
          }
        }
        bmp.close?.();
      }
    } catch {
      // Keep fallback words when asset route is unavailable in isolated unit tests
    }
  }
  device.queue.writeBuffer(archBuffer, 0, archWords);

  const sampler = device.createSampler({ label: 'ground detail', minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
  return {
    texture, archBuffer, resources: [[16, texture.createView()], [17, sampler], [18, { buffer: archBuffer }]],
    // What the land looks like with none of this. For tests and for looking into what went wrong.
    flatten() {
      const texel = GROUND_DETAIL_MEAN.map((v) => Math.round(v * 255));
      for (let m = 0; m < mips; m++) {
        const size = GROUND_DETAIL_SIZE >> m;
        device.queue.writeTexture({ texture, mipLevel: m }, new Uint8Array(size * size * 4).map((_, i) => texel[i & 3]), { bytesPerRow: size * 4 }, [size, size]);
      }
    },
    dispose() { texture.destroy(); archBuffer.destroy(); },
  };
}
