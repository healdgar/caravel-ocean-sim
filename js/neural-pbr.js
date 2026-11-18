// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Runtime loader & GPU buffer manager for the Shared WebGPU Neural PBR Material Bank (NPBR v1).
//
// Allocates a zero-initialized 512.25 KB storage buffer + 2,384 B uniform weight buffer
// synchronously on frame 0 (guaranteeing mathematical identity with zero stalls), then
// asynchronously fetches, decompresses, validates, and uploads the Dual-Band snorm8x4
// latent mip pyramids (`assets/neural-pbr/neural-pbr-latents.bin.gz`).

import {
  NEURAL_PBR_ASSET_PATH,
  NEURAL_PBR_MAGIC,
  NEURAL_PBR_VERSION,
  NEURAL_PBR_MATERIAL_COUNT,
  NEURAL_PBR_WORDS_PER_MATERIAL,
  NEURAL_PBR_TOTAL_WORDS,
  NEURAL_PBR_UNIFORM_FLOATS,
  NEURAL_PBR_DEFAULT_WEIGHTS,
  NEURAL_PBR_MATERIALS,
} from './models/neural-pbr-weights.js';

const NEURAL_PBR_DEVICE_CACHE = new WeakMap();

async function neuralPbrGunzipIfNeeded(bytes) {
  if (bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'function') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    throw new Error('DecompressionStream("gzip") unavailable in this environment');
  }
  return bytes;
}

/**
 * Parses and validates a raw (uncompressed) NPBR v1 binary buffer, returning the Uint32Array
 * of packed snorm8x4 latent pyramids (`NEURAL_PBR_TOTAL_WORDS` = 131,136 u32 words).
 */
export function parseNeuralPbrLatentBinary(rawBytes) {
  const u8 = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  if (u8.byteLength < 16) {
    throw new Error(`NPBR binary truncated (${u8.byteLength} B < 16 B header)`);
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const matCount = view.getUint32(8, true);
  const wordsPerMat = view.getUint32(12, true);
  if (magic !== NEURAL_PBR_MAGIC) {
    throw new Error(`Invalid NPBR magic: 0x${magic.toString(16)} (expected 0x${NEURAL_PBR_MAGIC.toString(16)})`);
  }
  if (version !== NEURAL_PBR_VERSION) {
    throw new Error(`Unsupported NPBR version: ${version} (expected ${NEURAL_PBR_VERSION})`);
  }
  if (matCount !== NEURAL_PBR_MATERIAL_COUNT || wordsPerMat !== NEURAL_PBR_WORDS_PER_MATERIAL) {
    throw new Error(
      `NPBR layout mismatch: ${matCount}x${wordsPerMat} words (expected ${NEURAL_PBR_MATERIAL_COUNT}x${NEURAL_PBR_WORDS_PER_MATERIAL})`
    );
  }
  const expectedPayloadBytes = NEURAL_PBR_TOTAL_WORDS * 4;
  if (u8.byteLength < 16 + expectedPayloadBytes) {
    throw new Error(`NPBR payload truncated: ${u8.byteLength - 16} B < ${expectedPayloadBytes} B`);
  }
  const aligned = u8.slice(16, 16 + expectedPayloadBytes);
  return new Uint32Array(aligned.buffer, aligned.byteOffset, NEURAL_PBR_TOTAL_WORDS);
}

export function createNeuralPbrBank(device, {
  url = NEURAL_PBR_ASSET_PATH,
  strength = 1.0,
  normalScale = 1.45,
  glossScale = 1.25,
  maxDistanceM = 36.0,
  autoLoad = true,
  rawLatentBytes = null,
} = {}) {
  const latentByteLength = NEURAL_PBR_TOTAL_WORDS * 4;
  const latentBuffer = device.createBuffer({
    label: 'neuralPbrLatents',
    size: latentByteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const weights = new Float32Array(NEURAL_PBR_UNIFORM_FLOATS);
  weights.set(NEURAL_PBR_DEFAULT_WEIGHTS);
  weights[0] = strength;
  weights[1] = normalScale;
  weights[2] = glossScale;
  weights[3] = maxDistanceM;

  const weightBuffer = device.createBuffer({
    label: 'neuralPbrWeights',
    size: weights.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(weightBuffer, 0, weights);

  const headerScratch = new Float32Array(4);
  headerScratch.set(weights.subarray(0, 4));

  let loaded = false;
  let readyPromise = Promise.resolve(false);

  function uploadLatentWords(words) {
    if (!(words instanceof Uint32Array) || words.length !== NEURAL_PBR_TOTAL_WORDS) {
      throw new Error(`Expected Uint32Array(${NEURAL_PBR_TOTAL_WORDS}), got ${words?.length}`);
    }
    device.queue.writeBuffer(latentBuffer, 0, words);
    loaded = true;
    return true;
  }

  function uploadRawBinary(rawBytes) {
    const words = parseNeuralPbrLatentBinary(rawBytes);
    return uploadLatentWords(words);
  }

  async function loadFromUrl(fetchUrl = url) {
    try {
      if (typeof fetch !== 'function') return false;
      if (typeof location === 'undefined' && typeof fetchUrl === 'string' && !/^(?:https?:|file:|data:|blob:)/i.test(fetchUrl)) {
        return false;
      }
      const resp = await fetch(fetchUrl);
      if (!resp.ok) {
        console.warn(`[NeuralPBR] Asset HTTP ${resp.status} for ${fetchUrl}; keeping identity fallback.`);
        return false;
      }
      const rawFetched = new Uint8Array(await resp.arrayBuffer());
      const decompressed = await neuralPbrGunzipIfNeeded(rawFetched);
      return uploadRawBinary(decompressed);
    } catch (err) {
      console.warn('[NeuralPBR] Async latent load skipped:', err?.message || err);
      return false;
    }
  }

  if (rawLatentBytes) {
    uploadRawBinary(rawLatentBytes);
    readyPromise = Promise.resolve(true);
  } else if (autoLoad) {
    readyPromise = loadFromUrl(url);
  }

  function syncParams() {
    if (
      weights[0] === headerScratch[0] &&
      weights[1] === headerScratch[1] &&
      weights[2] === headerScratch[2] &&
      weights[3] === headerScratch[3]
    ) {
      return;
    }
    headerScratch[0] = weights[0];
    headerScratch[1] = weights[1];
    headerScratch[2] = weights[2];
    headerScratch[3] = weights[3];
    device.queue.writeBuffer(weightBuffer, 0, headerScratch);
  }

  function setStrength(nextStrength) {
    const s = Number.isFinite(nextStrength) ? Math.max(0, Math.min(2, nextStrength)) : 1.0;
    weights[0] = s;
    syncParams();
  }

  function setParams({ strength: s, normalScale: ns, glossScale: gs, maxDistanceM: md } = {}) {
    if (Number.isFinite(s)) weights[0] = Math.max(0, Math.min(2, s));
    if (Number.isFinite(ns)) weights[1] = Math.max(0, Math.min(2, ns));
    if (Number.isFinite(gs)) weights[2] = Math.max(0, Math.min(2, gs));
    if (Number.isFinite(md)) weights[3] = Math.max(10, Math.min(600, md));
    syncParams();
  }

  return {
    latentBuffer,
    weightBuffer,
    weights,
    materials: NEURAL_PBR_MATERIALS,
    get loaded() {
      return loaded;
    },
    get ready() {
      return readyPromise;
    },
    setStrength,
    setParams,
    uploadLatentWords,
    uploadRawBinary,
    loadFromUrl,
    vesselBindings(latentBinding = 16, weightBinding = 17) {
      return [
        { binding: latentBinding, resource: { buffer: latentBuffer } },
        { binding: weightBinding, resource: { buffer: weightBuffer } },
      ];
    },
    terrainResources: [
      [22, { buffer: latentBuffer }],
      [23, { buffer: weightBuffer }],
    ],
    propResources: [
      [14, { buffer: latentBuffer }],
      [15, { buffer: weightBuffer }],
    ],
    destroy() {
      latentBuffer.destroy();
      weightBuffer.destroy();
    },
  };
}

/**
 * Returns the shared GPU-wide Neural PBR Material Bank for a given `GPUDevice`,
 * creating it on first call so `main.js`, `terrain.js`, and `props.js` share the
 * exact same 512 KB storage buffer and uniform buffer without extra constructor plumbing.
 */
export function sharedNeuralPbrBank(device, options = {}) {
  let bank = NEURAL_PBR_DEVICE_CACHE.get(device);
  if (!bank) {
    bank = createNeuralPbrBank(device, options);
    NEURAL_PBR_DEVICE_CACHE.set(device, bank);
  } else if (options.strength !== undefined || options.normalScale !== undefined || options.glossScale !== undefined) {
    bank.setParams(options);
  }
  return bank;
}
