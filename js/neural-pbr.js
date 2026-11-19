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
  NEURAL_PBR_WORDS_PER_BAND,
  NEURAL_PBR_WORDS_PER_MATERIAL,
  NEURAL_PBR_TOTAL_WORDS,
  NEURAL_PBR_UNIFORM_FLOATS,
  NEURAL_PBR_DEFAULT_WEIGHTS,
  NEURAL_PBR_MATERIALS,
  NEURAL_PBR_LEAKY_SLOPE,
} from './models/neural-pbr-weights.js';

// Pre-decoded snorm8x4 channel scales for the dual-band startup MLP bake.
// Each texel stores 2 adjacent u32 words: (outA_band, outB_band), eliminating all
// 16 per-pixel mat4x4f MLP multiplies and slashing fragment register pressure across
// ships, city, terrain, and props while keeping zero new texture/buffer bindings.
export const NEURAL_PBR_DECODE_SCALE_A = Object.freeze([0.70, 0.70, 0.70, 0.45]);
export const NEURAL_PBR_DECODE_SCALE_B = Object.freeze([0.80, 0.80, 0.46, 0.90]);

function packSnorm8x4(x, y, z, w, inv0, inv1, inv2, inv3) {
  const q0 = Math.max(-127, Math.min(127, Math.round(x * inv0 * 127))) & 0xff;
  const q1 = Math.max(-127, Math.min(127, Math.round(y * inv1 * 127))) & 0xff;
  const q2 = Math.max(-127, Math.min(127, Math.round(z * inv2 * 127))) & 0xff;
  const q3 = Math.max(-127, Math.min(127, Math.round(w * inv3 * 127))) & 0xff;
  return (q0 | (q1 << 8) | (q2 << 16) | (q3 << 24)) >>> 0;
}

/**
 * Decodes the static Dual-Band snorm8x4 latent pyramids through the shared PReLU MLP
 * ONCE at load time into packed (outA, outB) snorm8x4 word pairs (2 u32 per texel).
 * Zero texels (frame 0, mip 6, and micro mips 3..5) remain exact zero.
 */
export function decodeNeuralPbrLatentWords(words, weights = NEURAL_PBR_DEFAULT_WEIGHTS) {
  const out = new Uint32Array(NEURAL_PBR_TOTAL_WORDS * 2);
  const slope = NEURAL_PBR_LEAKY_SLOPE;
  const inv127 = 1 / 127;
  const OFF_MESO = 52;
  const OFF_MICRO = 100;
  const OFF_GATE = 148;
  const OFF_W1_MESO = 340;
  const OFF_W1_MICRO = 404;
  const OFF_W2A = 468;
  const OFF_W2B = 532;
  const invA0 = 1 / NEURAL_PBR_DECODE_SCALE_A[0];
  const invA1 = 1 / NEURAL_PBR_DECODE_SCALE_A[1];
  const invA2 = 1 / NEURAL_PBR_DECODE_SCALE_A[2];
  const invA3 = 1 / NEURAL_PBR_DECODE_SCALE_A[3];
  const invB0 = 1 / NEURAL_PBR_DECODE_SCALE_B[0];
  const invB1 = 1 / NEURAL_PBR_DECODE_SCALE_B[1];
  const invB2 = 1 / NEURAL_PBR_DECODE_SCALE_B[2];
  const invB3 = 1 / NEURAL_PBR_DECODE_SCALE_B[3];

  for (let m = 0; m < NEURAL_PBR_MATERIAL_COUNT; m++) {
    const matBase = m * NEURAL_PBR_WORDS_PER_MATERIAL;
    const gBase = OFF_GATE + m * 16;
    for (let band = 0; band < 2; band++) {
      const bandBase = matBase + band * NEURAL_PBR_WORDS_PER_BAND;
      const msOff = (band === 0 ? OFF_MESO : OFF_MICRO) + m * 4;
      const ms0 = weights[msOff];
      const ms1 = weights[msOff + 1];
      const ms2 = weights[msOff + 2];
      const ms3 = weights[msOff + 3];
      const w1Off = band === 0 ? OFF_W1_MESO : OFF_W1_MICRO;
      for (let i = 0; i < NEURAL_PBR_WORDS_PER_BAND; i++) {
        const idx = bandBase + i;
        const u = words[idx];
        if (u === 0) continue;
        let z0 = ((u << 24) >> 24) * inv127; if (z0 < -1) z0 = -1;
        let z1 = ((u << 16) >> 24) * inv127; if (z1 < -1) z1 = -1;
        let z2 = ((u << 8) >> 24) * inv127; if (z2 < -1) z2 = -1;
        let z3 = (u >> 24) * inv127; if (z3 < -1) z3 = -1;
        const m0 = z0 * ms0;
        const m1 = z1 * ms1;
        const m2 = z2 * ms2;
        const m3 = z3 * ms3;
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0;
        for (let blk = 0; blk < 4; blk++) {
          const o1 = w1Off + blk * 16;
          const p0 = weights[o1] * m0 + weights[o1 + 4] * m1 + weights[o1 + 8] * m2 + weights[o1 + 12] * m3;
          const p1 = weights[o1 + 1] * m0 + weights[o1 + 5] * m1 + weights[o1 + 9] * m2 + weights[o1 + 13] * m3;
          const p2 = weights[o1 + 2] * m0 + weights[o1 + 6] * m1 + weights[o1 + 10] * m2 + weights[o1 + 14] * m3;
          const p3 = weights[o1 + 3] * m0 + weights[o1 + 7] * m1 + weights[o1 + 11] * m2 + weights[o1 + 15] * m3;
          const go = gBase + blk * 4;
          const h0 = (p0 >= 0 ? p0 : p0 * slope) * weights[go];
          const h1 = (p1 >= 0 ? p1 : p1 * slope) * weights[go + 1];
          const h2 = (p2 >= 0 ? p2 : p2 * slope) * weights[go + 2];
          const h3 = (p3 >= 0 ? p3 : p3 * slope) * weights[go + 3];
          const oa = OFF_W2A + blk * 16;
          a0 += weights[oa] * h0 + weights[oa + 4] * h1 + weights[oa + 8] * h2 + weights[oa + 12] * h3;
          a1 += weights[oa + 1] * h0 + weights[oa + 5] * h1 + weights[oa + 9] * h2 + weights[oa + 13] * h3;
          a2 += weights[oa + 2] * h0 + weights[oa + 6] * h1 + weights[oa + 10] * h2 + weights[oa + 14] * h3;
          a3 += weights[oa + 3] * h0 + weights[oa + 7] * h1 + weights[oa + 11] * h2 + weights[oa + 15] * h3;
          const ob = OFF_W2B + blk * 16;
          b0 += weights[ob] * h0 + weights[ob + 4] * h1 + weights[ob + 8] * h2 + weights[ob + 12] * h3;
          b1 += weights[ob + 1] * h0 + weights[ob + 5] * h1 + weights[ob + 9] * h2 + weights[ob + 13] * h3;
          b2 += weights[ob + 2] * h0 + weights[ob + 6] * h1 + weights[ob + 10] * h2 + weights[ob + 14] * h3;
          b3 += weights[ob + 3] * h0 + weights[ob + 7] * h1 + weights[ob + 11] * h2 + weights[ob + 15] * h3;
        }
        // 1.42 restores the ~5% variance attenuation of post-PReLU bilinear filtering vs pre-PReLU filtering.
        out[idx * 2] = packSnorm8x4(a0 * 1.42, a1 * 1.42, a2 * 1.42, a3 * 1.42, invA0, invA1, invA2, invA3);
        out[idx * 2 + 1] = packSnorm8x4(b0 * 1.42, b1 * 1.42, b2 * 1.42, b3 * 1.42, invB0, invB1, invB2, invB3);
      }
    }
  }
  return out;
}

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
  const latentByteLength = NEURAL_PBR_TOTAL_WORDS * 8;
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
    const decoded = decodeNeuralPbrLatentWords(words, weights);
    device.queue.writeBuffer(latentBuffer, 0, decoded);
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
