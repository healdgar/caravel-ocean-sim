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
// mipmapped rgba8unorm-srgb texture_2d_array using sequential low-RAM decoding, one reused HTMLCanvasElement,
// compact Uint8Array linear-light 2x2 mip downsampling, and 256-byte-aligned queue.writeTexture (iOS/WebKit-safe).
export function requestLivestockTextures(device, { isMobile = false } = {}) {
  const mobile = isMobile || (typeof navigator !== 'undefined' && (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)));
  return requestOnce(device, `livestock albedo texture array ${mobile ? 512 : 1024}`, async () => {
    const size = mobile ? 512 : 1024;
    const mipLevelCount = Math.floor(Math.log2(size)) + 1;
    const layers = LIVESTOCK_TEXTURE_ASSETS.length;
    const texture = device.createTexture({
      label: 'livestock albedo array',
      size: [size, size, layers],
      mipLevelCount,
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const writeAlignedMip = (layer, mip, w, h, rgba) => {
      const rowBytes = w * 4;
      const bpr = (rowBytes + 255) & ~255;
      if (bpr === rowBytes) {
        device.queue.writeTexture({ texture, mipLevel: mip, origin: [0, 0, layer] }, rgba, { bytesPerRow: bpr, rowsPerImage: h }, [w, h, 1]);
      } else {
        const padded = new Uint8Array(bpr * h);
        for (let y = 0; y < h; y++) padded.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * bpr);
        device.queue.writeTexture({ texture, mipLevel: mip, origin: [0, 0, layer] }, padded, { bytesPerRow: bpr, rowsPerImage: h }, [w, h, 1]);
      }
    };
    const uploadSolidLayer = (layer) => {
      for (let mip = 0, w = size, h = size; mip < mipLevelCount; mip++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
        writeAlignedMip(layer, mip, w, h, new Uint8Array(w * h * 4).fill(255));
      }
    };
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : null);
    if (canvas) {
      canvas.width = size;
      canvas.height = size;
    }
    const ctx = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;
    try {
      for (let layer = 0; layer < layers; layer++) {
        let bmp = null;
        try {
          const res = await fetch(LIVESTOCK_TEXTURE_ASSETS[layer]);
          if (res.ok) bmp = await createImageBitmap(await res.blob());
        } catch {
          bmp = null;
        }
        if (!bmp || !ctx) {
          bmp?.close?.();
          uploadSolidLayer(layer);
          continue;
        }
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(bmp, 0, 0, size, size);
        bmp.close?.();
        const topDown = ctx.getImageData(0, 0, size, size).data;
        let cur = new Uint8Array(topDown.buffer, topDown.byteOffset, topDown.byteLength);
        writeAlignedMip(layer, 0, size, size, cur);

        let w = size, h = size;
        for (let mip = 1; mip < mipLevelCount; mip++) {
          const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
          const next = new Uint8Array(nw * nh * 4);
          for (let y = 0; y < nh; y++) {
            const sy0 = Math.min(h - 1, y * 2), sy1 = Math.min(h - 1, sy0 + 1);
            for (let x = 0; x < nw; x++) {
              const sx0 = Math.min(w - 1, x * 2), sx1 = Math.min(w - 1, sx0 + 1);
              const i00 = (sy0 * w + sx0) * 4, i10 = (sy0 * w + sx1) * 4;
              const i01 = (sy1 * w + sx0) * 4, i11 = (sy1 * w + sx1) * 4;
              const r = 0.25 * (SRGB_TO_LINEAR_LUT[cur[i00]] + SRGB_TO_LINEAR_LUT[cur[i10]] + SRGB_TO_LINEAR_LUT[cur[i01]] + SRGB_TO_LINEAR_LUT[cur[i11]]);
              const g = 0.25 * (SRGB_TO_LINEAR_LUT[cur[i00 + 1]] + SRGB_TO_LINEAR_LUT[cur[i10 + 1]] + SRGB_TO_LINEAR_LUT[cur[i01 + 1]] + SRGB_TO_LINEAR_LUT[cur[i11 + 1]]);
              const b = 0.25 * (SRGB_TO_LINEAR_LUT[cur[i00 + 2]] + SRGB_TO_LINEAR_LUT[cur[i10 + 2]] + SRGB_TO_LINEAR_LUT[cur[i01 + 2]] + SRGB_TO_LINEAR_LUT[cur[i11 + 2]]);
              const p = (y * nw + x) * 4;
              next[p] = linearToSrgbByte(r);
              next[p + 1] = linearToSrgbByte(g);
              next[p + 2] = linearToSrgbByte(b);
              next[p + 3] = 255;
            }
          }
          writeAlignedMip(layer, mip, nw, nh, next);
          cur = next;
          w = nw;
          h = nh;
        }
      }
    } finally {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    const view = texture.createView({ dimension: '2d-array' });
    const sampler = device.createSampler({
      label: 'livestock albedo sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: mobile ? 4 : 8,
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
