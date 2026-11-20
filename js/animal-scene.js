// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Every animal family's way into the one cut (js/continuum-scene.js): the animal atlas with its rigs, and a scene of
// it. The herds (js/herds.js) and the sea's animals (js/dolphins.js, js/marine-life.js) each stand their records and
// write their joints in a compute pass of their own; the select, the shadow and the view are the one cut's.
import { requestOnce } from './gpu-program-cache.js';
import { ANIMAL_POSE_VEC4S, LIVESTOCK_TEXTURE_ASSETS, animalRigTable, loadAnimalContinuum } from './animal-continuum.js';
import { continuumRoom } from './continuum-format.js';
import { requestContinuumAtlas, createContinuumScene } from './continuum-scene.js';

// Loads all 4 Tripo H3.1 livestock basecolor textures (sheep, cattle, swine, horse) into one mipmapped
// rgba8unorm-srgb texture_2d_array (1024x1024x4) with anisotropic linear-mip filtering.
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
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (valid) {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      for (let layer = 0; layer < layers; layer++) {
        const bmp = bitmaps[layer];
        if (!bmp) continue;
        let w = size, h = size;
        canvas.width = w;
        canvas.height = h;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        device.queue.copyExternalImageToTexture({ source: canvas }, { texture, mipLevel: 0, origin: [0, 0, layer] }, [w, h]);
        // Downsample pyramid cleanly for crisp hardware trilinear + anisotropic mipmapping.
        for (let mip = 1; mip < mipLevelCount; mip++) {
          const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
          const prev = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
          prev.width = w; prev.height = h;
          prev.getContext('2d').drawImage(canvas, 0, 0);
          canvas.width = nw; canvas.height = nh;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.clearRect(0, 0, nw, nh);
          ctx.drawImage(prev, 0, 0, w, h, 0, 0, nw, nh);
          device.queue.copyExternalImageToTexture({ source: canvas }, { texture, mipLevel: mip, origin: [0, 0, layer] }, [nw, nh]);
          w = nw; h = nh;
        }
        bmp.close?.();
      }
    } else {
      const white = new Uint8Array(size * size * 4).fill(255);
      for (let layer = 0; layer < layers; layer++) {
        device.queue.writeTexture({ texture, origin: [0, 0, layer] }, white, { bytesPerRow: size * 4 }, [size, size, 1]);
      }
    }
    const view = texture.createView({ dimension: '2d-array' });
    const sampler = device.createSampler({
      label: 'livestock albedo sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
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
