// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Every animal family's way into the one cut (js/continuum-scene.js): the animal atlas with its rigs, and a scene of
// it. The herds (js/herds.js) and the sea's animals (js/dolphins.js, js/marine-life.js) each stand their records and
// write their joints in a compute pass of their own; the select, the shadow and the view are the one cut's.
import { requestOnce } from './gpu-program-cache.js';
import { ANIMAL_POSE_VEC4S, LIVESTOCK_TEXTURE_ASSETS, animalRigTable, loadAnimalContinuum } from './animal-continuum.js';
import { continuumRoom } from './continuum-format.js';
import { requestContinuumAtlas, createContinuumScene } from './continuum-scene.js';

// Exact IEC 61966-2-1 sRGB <-> linear helpers for gamma-correct, browser-independent CPU mip pyramids.
const SRGB_TO_LINEAR_LUT = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
function linearToSrgbByte(x) {
  const c = x <= 0 ? 0 : x >= 1 ? 1 : x;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * (c ** (1 / 2.4)) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

// Loads all 4 clean pelt-baked Tripo H3.1 livestock basecolor textures (sheep, cattle, swine, horse) into one
// mipmapped rgba8unorm-srgb texture_2d_array (1024x1024x4) using canonical top-down ImageData bytes, CPU linear-space
// 2x2 mip downsampling, and queue.writeTexture (zero reused-OffscreenCanvas / IOSurface orientation hazards).
export function requestLivestockTextures(device) {
  return requestOnce(device, 'livestock albedo texture array', async () => {
    const bitmaps = await Promise.all(LIVESTOCK_TEXTURE_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await createImageBitmap(await res.blob());
      } catch {
        return null;
      }
    }));
    const valid = bitmaps.find(Boolean);
    const size = valid ? Math.min(1024, Math.max(256, valid.width)) : 4;
    const mipLevelCount = Math.floor(Math.log2(size)) + 1;
    const layers = LIVESTOCK_TEXTURE_ASSETS.length;
    const texture = device.createTexture({
      label: 'livestock albedo array',
      size: [size, size, layers],
      mipLevelCount,
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const uploadSolidLayer = (layer) => {
      for (let mip = 0, w = size, h = size; mip < mipLevelCount; mip++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
        const bytes = new Uint8Array(w * h * 4).fill(255);
        device.queue.writeTexture({ texture, mipLevel: mip, origin: [0, 0, layer] }, bytes, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h, 1]);
      }
    };
    if (valid) {
      for (let layer = 0; layer < layers; layer++) {
        const bmp = bitmaps[layer];
        if (!bmp) {
          uploadSolidLayer(layer);
          continue;
        }
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0, size, size);
        const topDown = ctx.getImageData(0, 0, size, size).data;
        bmp.close?.();

        const mip0 = new Uint8Array(topDown.buffer, topDown.byteOffset, topDown.byteLength);
        device.queue.writeTexture({ texture, mipLevel: 0, origin: [0, 0, layer] }, mip0, { bytesPerRow: size * 4, rowsPerImage: size }, [size, size, 1]);

        // Decode mip 0 to linear float RGB once, then box-average 2x2 in linear light down the full pyramid.
        let w = size, h = size;
        let lin = new Float32Array(w * h * 3);
        for (let i = 0, p = 0; i < w * h; i++, p += 4) {
          lin[i * 3] = SRGB_TO_LINEAR_LUT[mip0[p]];
          lin[i * 3 + 1] = SRGB_TO_LINEAR_LUT[mip0[p + 1]];
          lin[i * 3 + 2] = SRGB_TO_LINEAR_LUT[mip0[p + 2]];
        }
        for (let mip = 1; mip < mipLevelCount; mip++) {
          const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
          const nextLin = new Float32Array(nw * nh * 3);
          const mipBytes = new Uint8Array(nw * nh * 4);
          for (let y = 0; y < nh; y++) {
            const sy0 = Math.min(h - 1, y * 2), sy1 = Math.min(h - 1, sy0 + 1);
            for (let x = 0; x < nw; x++) {
              const sx0 = Math.min(w - 1, x * 2), sx1 = Math.min(w - 1, sx0 + 1);
              const i00 = (sy0 * w + sx0) * 3, i10 = (sy0 * w + sx1) * 3;
              const i01 = (sy1 * w + sx0) * 3, i11 = (sy1 * w + sx1) * 3;
              const r = 0.25 * (lin[i00] + lin[i10] + lin[i01] + lin[i11]);
              const g = 0.25 * (lin[i00 + 1] + lin[i10 + 1] + lin[i01 + 1] + lin[i11 + 1]);
              const b = 0.25 * (lin[i00 + 2] + lin[i10 + 2] + lin[i01 + 2] + lin[i11 + 2]);
              const dst = (y * nw + x) * 3;
              nextLin[dst] = r;
              nextLin[dst + 1] = g;
              nextLin[dst + 2] = b;
              const p = (y * nw + x) * 4;
              mipBytes[p] = linearToSrgbByte(r);
              mipBytes[p + 1] = linearToSrgbByte(g);
              mipBytes[p + 2] = linearToSrgbByte(b);
              mipBytes[p + 3] = 255;
            }
          }
          device.queue.writeTexture({ texture, mipLevel: mip, origin: [0, 0, layer] }, mipBytes, { bytesPerRow: nw * 4, rowsPerImage: nh }, [nw, nh, 1]);
          lin = nextLin;
          w = nw;
          h = nh;
        }
      }
    } else {
      for (let layer = 0; layer < layers; layer++) uploadSolidLayer(layer);
    }
    const view = texture.createView({ dimension: '2d-array' });
    const sampler = device.createSampler({
      label: 'livestock albedo sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 8,
    });
    return { texture, view, sampler };
  });
}

// The animal atlas, once a device, with every type's rig (js/animal-continuum.js animalRigTable) in a uniform buffer for
// the passes that write their joints.
export function requestAnimalContinuumAtlas(device) {
  return requestOnce(device, 'animal continuum atlas and rigs', async () => {
    const atlas = await requestContinuumAtlas(device, 'animal', () => loadAnimalContinuum());
    const table = animalRigTable(atlas.manifest);
    const rig = device.createBuffer({ label: 'animal rigs', size: table.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(rig, 0, table);
    return { ...atlas, rig };
  });
}

// A scene of the one cut for `count` animals, each of any of `types`: its lists have the room the heaviest of them
// would take were all of that type; its joints lie in a pose buffer of its own, which its family's pass writes
// (ANIMAL_POSE_VEC4S an instance).
export function createAnimalScene({ device, atlas, programs, view, count, types, frame, shadowUniform, samples, label, profile = null }) {
  const room = types.map((t) => continuumRoom(atlas.types, atlas.types.map((_, u) => (u === t ? count : 0))).room).reduce((a, b) => a.map((n, i) => Math.max(n, b[i])));
  return createContinuumScene({ device, atlas, programs, capacity: count, room, view, poseRoom: count * ANIMAL_POSE_VEC4S, frame, shadowUniform, samples, label, profile });
}
