#!/usr/bin/env node
// MaterialCraft Headless PBR Authoring & Cooking Pipeline for All 9 Land Structure Materials (Kind 10..18)
// Drives /Applications/MaterialCraft.app/Contents/MacOS/MaterialCraft over its JSON control channel
// to build .sbs graphs, cook BaseColor, OpenGL Tangent-Space Normal, Roughness, AmbientOcclusion & Height
// maps for all 9 architectural material families, export .sbs/.mcmat/3D previews, and pack the cooked
// 18-layer PBR array atlas at assets/ports/1550/land-materials-pbr.png.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MC_BIN = '/Applications/MaterialCraft.app/Contents/MacOS/MaterialCraft';
const OUT_DIR = path.resolve('assets/artcraft');
const ATLAS_PATH = path.resolve('assets/ports/1550/land-materials-pbr.png');
const SIZE = 256;

// --- Minimal lossless PNG encoder/decoder (RGBA8) ---
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (1 + width * 4);
    raw[rowOff] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowOff + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA8
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePNG(buf) {
  let pos = 8;
  let width = 0, height = 0, bitDepth = 8, colorType = 6;
  const idatChunks = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * bpp;
  const recon = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)];
    const rowIn = y * (1 + stride) + 1;
    const rowOut = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[rowIn + i];
      const a = i >= bpp ? recon[rowOut + i - bpp] : 0;
      const b = y > 0 ? recon[rowOut - stride + i] : 0;
      const c = y > 0 && i >= bpp ? recon[rowOut - stride + i - bpp] : 0;
      let val = x;
      if (filter === 1) val = (x + a) & 255;
      else if (filter === 2) val = (x + b) & 255;
      else if (filter === 3) val = (x + ((a + b) >> 1)) & 255;
      else if (filter === 4) val = (x + paeth(a, b, c)) & 255;
      recon[rowOut + i] = val;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (bpp === 4) {
      rgba[i * 4] = recon[i * 4];
      rgba[i * 4 + 1] = recon[i * 4 + 1];
      rgba[i * 4 + 2] = recon[i * 4 + 2];
      rgba[i * 4 + 3] = recon[i * 4 + 3];
    } else if (bpp === 3) {
      rgba[i * 4] = recon[i * 3];
      rgba[i * 4 + 1] = recon[i * 3 + 1];
      rgba[i * 4 + 2] = recon[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = recon[i * bpp];
      rgba[i * 4 + 3] = 255;
    }
  }
  return { width, height, rgba };
}

// --- Deterministic periodic (tileable) noise helpers ---
function hash2(ix, iy, seed = 1) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function pnoise(u, v, periodX, periodY, seed = 1) {
  const x = ((u % 1) + 1) % 1 * periodX;
  const y = ((v % 1) + 1) % 1 * periodY;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % periodX) + periodX) % periodX;
  const x1 = (x0 + 1) % periodX;
  const y0 = ((iy % periodY) + periodY) % periodY;
  const y1 = (y0 + 1) % periodY;
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x1, y0, seed);
  const n01 = hash2(x0, y1, seed);
  const n11 = hash2(x1, y1, seed);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

function fbm(u, v, px, py, seed = 1, octaves = 4) {
  let sum = 0, amp = 0.5, norm = 0, fx = px, fy = py;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (pnoise(u, v, fx, fy, seed + i * 17) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return sum / norm;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// Synthesize seamless 256x256 source maps (Albedo, Height, Roughness, AO) for a given material index 0..8 (Kind 10..18)
function synthesizeSourceMaterial(matIndex) {
  const albedo = new Uint8Array(SIZE * SIZE * 4);
  const height = new Uint8Array(SIZE * SIZE * 4);
  const rough = new Uint8Array(SIZE * SIZE * 4);
  const ao = new Uint8Array(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    const v = y / SIZE;
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const idx = (y * SIZE + x) * 4;
      let r = 0.5, g = 0.5, b = 0.5, h = 0.5, ro = 0.75, a = 0.9;

      if (matIndex === 0) {
        // Kind 10: Weathered Iberian oak & pitch-pine dock/shipyard timber planking
        const courses = 6;
        const cy = v * courses;
        const plankRow = Math.floor(cy) % courses;
        const fy = cy - Math.floor(cy);
        const stagger = (plankRow * 0.41 + hash2(plankRow, 3, 101) * 0.29) % 1;
        const ux = (u + stagger) % 1;
        // Fine caulked plank edge seams & occasional staggered butt joints (only on 2 of 6 courses)
        const seamY = 1 - smoothstep(0.005, 0.017, Math.min(fy, 1 - fy));
        const hasButt = plankRow === 1 || plankRow === 4;
        const buttX = hasButt ? (1 - smoothstep(0.004, 0.012, Math.min(ux, 1 - ux))) : 0;
        const seam = Math.max(seamY, buttX * 0.75);
        const plankBevel = smoothstep(0.006, 0.028, Math.min(fy, 1 - fy)) * (hasButt ? smoothstep(0.004, 0.018, Math.min(ux, 1 - ux)) : 1.0);
        // Subtle oak treenail pegs only at staggered butt joints
        const spikeDx = Math.min(Math.abs(ux - 0.028), Math.abs(ux - 0.972));
        const spikeDy = Math.min(Math.abs(fy - 0.28), Math.abs(fy - 0.72));
        const spikeDist = Math.hypot(spikeDx * 4.5, spikeDy);
        const spike = hasButt ? (1 - smoothstep(0.016, 0.034, spikeDist)) : 0;
        // Occasional tight wood knot
        const hasKnot = plankRow === 0 || plankRow === 3;
        const knotU = 0.24 + 0.52 * hash2(plankRow, 11, 103);
        const knotV = 0.30 + 0.40 * hash2(plankRow, 19, 107);
        const dkx = (ux - knotU) * 3.2, dky = (fy - knotV) * 0.95;
        const knotR = Math.hypot(dkx, dky);
        const knotDeflect = hasKnot ? Math.exp(-knotR * knotR * 24) * 0.07 * (fy > knotV ? 1 : -1) : 0;
        const knotCore = hasKnot ? Math.exp(-knotR * knotR * 95) : 0;
        // Multi-scale anisotropic sawn oak grain fibers & medullary rays
        const grainBroad = fbm(u, v + knotDeflect, 2, 24, 109 + plankRow * 7, 4);
        const grainMed = fbm(u, v + knotDeflect * 0.7, 4, 48, 113 + plankRow * 13, 3);
        const grainFine = fbm(u, v + knotDeflect * 0.4, 8, 96, 119 + plankRow * 19, 3);
        const checkCrack = Math.max(0, fbm(u, v, 4, 48, 127, 2) - 0.62) * 1.4;
        const plankTone = (hash2(plankRow, 7, 131) - 0.5) * 0.12;
        const silverDrift = Math.max(0, grainBroad * 0.5 + grainMed * 0.5 - 0.18) * 0.08;
        const grainVal = grainBroad * 0.14 + grainMed * 0.11 + grainFine * 0.08 - checkCrack * 0.22 - knotCore * 0.26;
        // Rich weathered Iberian oak / pitch-pine palette (sRGB)
        r = 0.53 + plankTone * 0.36 + grainVal * 0.20 + silverDrift * 0.4;
        g = 0.40 + plankTone * 0.30 + grainVal * 0.16 + silverDrift * 0.45;
        b = 0.28 + plankTone * 0.22 + grainVal * 0.12 + silverDrift * 0.5;
        r = r * (1 - seam * 0.34 - spike * 0.22);
        g = g * (1 - seam * 0.36 - spike * 0.22);
        b = b * (1 - seam * 0.38 - spike * 0.20);
        // Flat sawn plank surface with crisp fine seam drop & wood fiber micro-relief
        h = 0.42 + plankBevel * 0.26 + plankTone * 0.06 + grainBroad * 0.06 + grainMed * 0.05 + grainFine * 0.04 - checkCrack * 0.12 - knotCore * 0.06 - seam * 0.24 - spike * 0.08;
        ro = 0.74 - grainBroad * 0.05 + grainFine * 0.05 + seam * 0.12 - spike * 0.08;
        a = 0.96 - seam * 0.24 - checkCrack * 0.14 - spike * 0.10;
      } else if (matIndex === 1) {
        // Kind 11: Coursed Pedra Lioz & coral-limestone ashlar masonry (flat dressed blocks, fine lime-mortar joints)
        const courses = 4;
        const cy = v * courses;
        const row = Math.floor(cy) % courses;
        const fy = cy - Math.floor(cy);
        const blocksPerRow = row % 2 === 0 ? 2 : 3;
        const stagger = (row * 0.333 + (hash2(row, 1, 201) - 0.5) * 0.06 + 1) % 1;
        const cx = ((u + stagger) % 1) * blocksPerRow;
        const col = Math.floor(cx) % blocksPerRow;
        const fx = cx - Math.floor(cx);
        // Subtle hand-dressed edge irregularity on fine lime-mortar joints
        const edgeJitter = fbm(u, v, 16, 16, 211, 3) * 0.006;
        const distY = Math.min(fy, 1 - fy) + edgeJitter;
        const distX = (Math.min(fx, 1 - fx) / blocksPerRow) * 2.2 + edgeJitter;
        const mortarY = 1 - smoothstep(0.007, 0.022, distY);
        const mortarX = 1 - smoothstep(0.006, 0.020, distX);
        const mortar = Math.max(mortarY, mortarX);
        const bevel = smoothstep(0.008, 0.032, Math.min(distY, distX));
        // Per-block Pedra Lioz warm ivory / buff / cream variation & fossil calcite veining
        const blockHash = hash2(col + row * 7, row, 223);
        const stoneMacro = fbm(u, v, 6, 6, 229, 4);
        const stoneMed = fbm(u, v, 14, 14, 231, 3);
        const stoneMicro = fbm(u, v, 28, 28, 233, 3);
        const vein = Math.exp(-Math.pow(fbm(u, v, 8, 8, 237, 3) * 3.5, 2.0)) * 0.04;
        const pores = Math.max(0, fbm(u, v, 32, 32, 239, 3) - 0.44) * 0.95;
        const blockTone = (blockHash - 0.5) * 0.09 + stoneMacro * 0.065 + stoneMed * 0.045 + stoneMicro * 0.035 + vein - pores * 0.11;
        // Stone base vs flush warm cream-buff lime mortar (argamassa de cal)
        const sr = 0.77 + blockTone * 0.38 + (blockHash - 0.5) * 0.025;
        const sg = 0.73 + blockTone * 0.35;
        const sb = 0.65 + blockTone * 0.31;
        const mr = 0.68 + stoneMicro * 0.04;
        const mg = 0.64 + stoneMicro * 0.04;
        const mb = 0.56 + stoneMicro * 0.035;
        r = sr * (1 - mortar) + mr * mortar;
        g = sg * (1 - mortar) + mg * mortar;
        b = sb * (1 - mortar) + mb * mortar;
        // Flat dressed ashlar block top with tight micro-chamfer & natural limestone mineral grain
        h = (0.48 + bevel * 0.16 + (blockHash - 0.5) * 0.05 + stoneMacro * 0.06 + stoneMed * 0.045 + stoneMicro * 0.035 - pores * 0.12) * (1 - mortar) + (0.34 + stoneMicro * 0.03) * mortar;
        ro = (0.72 + stoneMicro * 0.06 + pores * 0.12 - (blockHash - 0.5) * 0.04) * (1 - mortar) + 0.86 * mortar;
        a = (0.96 - (1 - bevel) * 0.10 - pores * 0.10) * (1 - mortar) + 0.80 * mortar;
      } else if (matIndex === 2) {
        // Kind 12: Warm Iberian & colonial limewashed stucco over rubble masonry
        const plasterBroad = fbm(u, v, 6, 6, 307, 4);
        const plasterMed = fbm(u, v, 16, 16, 311, 3);
        const sandGrit = fbm(u, v, 36, 36, 313, 3);
        const limeStreak = fbm(u, v, 4, 12, 317, 3);
        const flakeMask = smoothstep(0.45, 0.60, fbm(u, v, 6, 6, 331, 3));
        const tone = plasterBroad * 0.08 + plasterMed * 0.05 + limeStreak * 0.06 + sandGrit * 0.035 - flakeMask * 0.10;
        r = 0.83 + tone * 0.36;
        g = 0.76 + tone * 0.33;
        b = 0.65 + tone * 0.28;
        h = 0.58 + plasterBroad * 0.12 + plasterMed * 0.07 + sandGrit * 0.05 - flakeMask * 0.18;
        ro = 0.80 + sandGrit * 0.06 + flakeMask * 0.08;
        a = 0.95 - flakeMask * 0.15 + plasterBroad * 0.04;
      } else if (matIndex === 3) {
        // Kind 13: Fired Roman/Iberian terracotta barrel roof tiles (telha mourisca / tejas curvas)
        const cols = 6;
        const rows = 4;
        const cx = u * cols;
        const col = Math.floor(cx) % cols;
        const fx = cx - Math.floor(cx);
        const cy = v * rows + (col % 2) * 0.08;
        const row = Math.floor(cy) % rows;
        const fy = cy - Math.floor(cy);
        const arch = Math.sin(fx * Math.PI);
        const valley = 1 - arch;
        const lipShadow = 1 - smoothstep(0.02, 0.12, fy);
        const tileHash = hash2(col, row, 401);
        const clayNoise = fbm(u, v, 12, 12, 409, 4);
        const lichen = Math.max(0, fbm(u, v, 18, 18, 419, 3) - 0.45) * valley * 1.5;
        const kilnShift = (tileHash - 0.5) * 0.18 + clayNoise * 0.08;
        r = 0.72 + kilnShift * 0.42 + arch * 0.06 - valley * 0.12 - lipShadow * 0.22 - lichen * 0.26;
        g = 0.38 + kilnShift * 0.26 + arch * 0.04 - valley * 0.08 - lipShadow * 0.14 - lichen * 0.08;
        b = 0.23 + kilnShift * 0.16 + arch * 0.02 - valley * 0.05 - lipShadow * 0.10 - lichen * 0.12;
        h = clamp01(0.22 + arch * 0.52 + (1 - fy) * 0.16 - lipShadow * 0.28 + clayNoise * 0.04);
        ro = 0.64 - arch * 0.08 + valley * 0.14 + clayNoise * 0.06 + lichen * 0.18;
        a = 0.96 - valley * 0.34 - lipShadow * 0.38;
      } else if (matIndex === 4) {
        // Kind 14: 16th-century diamond leaded-glass casements (vidrieras emplomadas) & wrought-iron rejas
        const d1 = Math.abs(((u + v) * 4) % 1 - 0.5) * 2;
        const d2 = Math.abs(((u - v + 4) * 4) % 1 - 0.5) * 2;
        const came = 1 - smoothstep(0.04, 0.11, Math.min(d1, d2));
        const rejaU = 1 - smoothstep(0.025, 0.06, Math.min((u * 2) % 1, 1 - ((u * 2) % 1)));
        const rejaV = 1 - smoothstep(0.025, 0.06, Math.min((v * 2) % 1, 1 - ((v * 2) % 1)));
        const reja = Math.max(rejaU, rejaV);
        const frame = Math.max(came * 0.85, reja);
        const glassRipple = fbm(u, v, 8, 8, 503, 3);
        r = (0.18 + glassRipple * 0.04) * (1 - frame) + 0.22 * frame;
        g = (0.23 + glassRipple * 0.05) * (1 - frame) + 0.21 * frame;
        b = (0.26 + glassRipple * 0.05) * (1 - frame) + 0.20 * frame;
        h = 0.35 + glassRipple * 0.08 * (1 - frame) + came * 0.28 + reja * 0.45;
        ro = 0.16 * (1 - frame) + 0.54 * frame;
        a = 0.92 - frame * 0.28;
      } else if (matIndex === 5) {
        // Kind 15: Layered tropical palm-thatch & bundled reed roof
        const tiers = 4;
        const ty = v * tiers;
        const tierRow = Math.floor(ty) % tiers;
        const fy = ty - Math.floor(ty);
        const tierLip = 1 - smoothstep(0.03, 0.15, fy);
        const stalks = fbm(u, v, 36, 6, 601 + tierRow * 11, 4);
        const bundle = fbm(u, v, 10, 4, 607, 3);
        const fineStraw = fbm(u, v, 64, 12, 613, 3);
        const tone = stalks * 0.14 + bundle * 0.12 + fineStraw * 0.08 - tierLip * 0.24;
        r = 0.58 + tone * 0.36;
        g = 0.48 + tone * 0.30;
        b = 0.31 + tone * 0.22;
        h = 0.42 + (1 - fy) * 0.22 - tierLip * 0.32 + stalks * 0.12 + bundle * 0.12;
        ro = 0.88 + fineStraw * 0.06;
        a = 0.92 - tierLip * 0.44 - Math.max(0, -stalks) * 0.18;
      } else if (matIndex === 6) {
        // Kind 16: Granite cobblestone & flagstone courtyard pavement (calçada / empedrado)
        const rows = 6, cols = 6;
        const cy = v * rows;
        const row = Math.floor(cy) % rows;
        const fy = cy - Math.floor(cy);
        const cx = ((u + (row % 2) * 0.5 / cols) % 1) * cols;
        const col = Math.floor(cx) % cols;
        const fx = cx - Math.floor(cx);
        const jx = (hash2(col, row, 701) - 0.5) * 0.18;
        const jy = (hash2(col, row, 709) - 0.5) * 0.18;
        const dx = (fx - 0.5 - jx) * 1.85;
        const dy = (fy - 0.5 - jy) * 1.85;
        const rCob = Math.pow(Math.pow(Math.abs(dx), 2.6) + Math.pow(Math.abs(dy), 2.6), 1 / 2.6);
        const joint = smoothstep(0.68, 0.92, rCob);
        const dome = Math.max(0, 1 - rCob * rCob * 0.85);
        const stoneId = hash2(col, row, 719);
        const grit = fbm(u, v, 20, 20, 727, 3);
        const sr = 0.56 + (stoneId - 0.5) * 0.18 + grit * 0.08;
        const sg = 0.52 + (stoneId - 0.5) * 0.16 + grit * 0.07;
        const sb = 0.46 + (stoneId - 0.5) * 0.14 + grit * 0.06;
        const mr = 0.42 + grit * 0.05, mg = 0.38 + grit * 0.05, mb = 0.32 + grit * 0.04;
        r = sr * (1 - joint) + mr * joint;
        g = sg * (1 - joint) + mg * joint;
        b = sb * (1 - joint) + mb * joint;
        h = (0.30 + dome * 0.52 + (stoneId - 0.5) * 0.08 + grit * 0.07) * (1 - joint) + (0.14 + grit * 0.05) * joint;
        ro = (0.70 + grit * 0.08 - dome * 0.06) * (1 - joint) + 0.92 * joint;
        a = (0.96 - (1 - dome) * 0.18) * (1 - joint) + 0.48 * joint;
      } else if (matIndex === 7) {
        // Kind 17: Paper-birch & cedar bark sheathing with lenticels & stitched seams
        const seamY = 1 - smoothstep(0.015, 0.045, Math.min((v * 2) % 1, 1 - ((v * 2) % 1)));
        const lenticel = Math.max(0, fbm(u, v, 4, 32, 809, 3) - 0.32) * 1.8;
        const barkWave = fbm(u, v, 8, 16, 811, 3);
        r = 0.74 + barkWave * 0.08 - lenticel * 0.28 - seamY * 0.25;
        g = 0.67 + barkWave * 0.07 - lenticel * 0.26 - seamY * 0.28;
        b = 0.56 + barkWave * 0.06 - lenticel * 0.22 - seamY * 0.30;
        h = 0.58 + barkWave * 0.14 - lenticel * 0.18 - seamY * 0.34;
        ro = 0.76 + lenticel * 0.12 + seamY * 0.10;
        a = 0.94 - seamY * 0.36 - lenticel * 0.16;
      } else {
        // Kind 18: Sand-cast ordnance iron & forged harbor metal
        const castPits = Math.max(0, fbm(u, v, 28, 28, 907, 4) - 0.32) * 1.5;
        const hammerFacet = fbm(u, v, 8, 8, 911, 3);
        const patina = Math.max(0, -hammerFacet) * 0.5;
        r = 0.22 + hammerFacet * 0.04 - castPits * 0.06 + patina * 0.05;
        g = 0.23 + hammerFacet * 0.04 - castPits * 0.06 + patina * 0.02;
        b = 0.25 + hammerFacet * 0.04 - castPits * 0.06;
        h = 0.55 + hammerFacet * 0.16 - castPits * 0.26;
        ro = 0.54 - hammerFacet * 0.08 + castPits * 0.22;
        a = 0.94 - castPits * 0.30;
      }

      albedo[idx] = Math.round(clamp01(r) * 255);
      albedo[idx + 1] = Math.round(clamp01(g) * 255);
      albedo[idx + 2] = Math.round(clamp01(b) * 255);
      albedo[idx + 3] = 255;

      const hv = Math.round(clamp01(h) * 255);
      height[idx] = height[idx + 1] = height[idx + 2] = hv;
      height[idx + 3] = 255;

      const rv = Math.round(clamp01(ro) * 255);
      rough[idx] = rough[idx + 1] = rough[idx + 2] = rv;
      rough[idx + 3] = 255;

      const av = Math.round(clamp01(a) * 255);
      ao[idx] = ao[idx + 1] = ao[idx + 2] = av;
      ao[idx + 3] = 255;
    }
  }
  return { albedo, height, rough, ao };
}

class MaterialCraftClient {
  constructor(port, token) {
    this.port = port;
    this.token = token;
    this.sock = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.sock = net.createConnection({ host: '127.0.0.1', port: this.port }, resolve);
      this.sock.on('error', reject);
      this.sock.on('data', (chunk) => {
        this.buf += chunk.toString('utf8');
        let nl;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.ok === false || msg.error) p.reject(new Error(JSON.stringify(msg.error || msg)));
            else p.resolve(msg.result);
          }
        }
      });
    });
    await this.call('auth', { token: this.token });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  runCmd(id, params = {}) {
    return this.call('command.run', { id, params });
  }

  close() {
    this.sock?.end();
  }
}

async function launchMaterialCraft(port) {
  const tokenFile = `/tmp/materialcraft-control-${port}.token`;
  try { fs.unlinkSync(tokenFile); } catch {}
  let stderrToken = null;
  const child = spawn(MC_BIN, ['--control', String(port), '--empty'], {
    env: { ...process.env, MATERIALCRAFT_NO_PREFS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const m = d.toString('utf8').match(/control token written to (\S+)/);
    if (m) stderrToken = m[1];
  });
  for (let i = 0; i < 80; i++) {
    const tf = stderrToken || tokenFile;
    if (fs.existsSync(tf)) {
      const token = fs.readFileSync(tf, 'utf8').trim();
      if (token) {
        await new Promise((r) => setTimeout(r, 250));
        return { child, token };
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('Timed out waiting for MaterialCraft control token');
}

const MATERIAL_NAMES = [
  'kind10_iberian_timber',
  'kind11_pedra_lioz_ashlar',
  'kind12_limewash_stucco',
  'kind13_terracotta_telha',
  'kind14_leaded_casement',
  'kind15_palm_thatch',
  'kind16_calcada_cobble',
  'kind17_birch_bark',
  'kind18_ordnance_iron',
];

const NORMAL_INTENSITY = [3.6, 4.4, 2.6, 4.8, 3.2, 3.8, 4.5, 2.8, 2.8];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(ATLAS_PATH), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-land-pbr-'));

  const port = 45600 + Math.floor(Math.random() * 800);
  console.log(`Launching MaterialCraft on control port ${port}...`);
  const { child, token } = await launchMaterialCraft(port);
  const mc = new MaterialCraftClient(port, token);

  try {
    await mc.connect();
    await mc.call('ping');
    await mc.runCmd('file.newPackage', { name: 'waterworld_land_materials' });

    const atlasRGBA = new Uint8Array(SIZE * (SIZE * 18) * 4);

    for (let m = 0; m < 9; m++) {
      const name = MATERIAL_NAMES[m];
      console.log(`Cooking MaterialCraft PBR graph [${m + 1}/9]: ${name}...`);
      const src = synthesizeSourceMaterial(m);
      const albedoSrcPath = path.join(tmpDir, `${name}_albedo_src.png`);
      const heightSrcPath = path.join(tmpDir, `${name}_height_src.png`);
      const roughSrcPath = path.join(tmpDir, `${name}_rough_src.png`);
      const aoSrcPath = path.join(tmpDir, `${name}_ao_src.png`);

      fs.writeFileSync(albedoSrcPath, encodePNG(SIZE, SIZE, src.albedo));
      fs.writeFileSync(heightSrcPath, encodePNG(SIZE, SIZE, src.height));
      fs.writeFileSync(roughSrcPath, encodePNG(SIZE, SIZE, src.rough));
      fs.writeFileSync(aoSrcPath, encodePNG(SIZE, SIZE, src.ao));

      await mc.runCmd('file.newPackage', { name: `pkg_${name}` });
      await mc.runCmd('file.new', {
        name,
        kind: 'material',
        template: 'empty',
        size: SIZE,
      });

      const impAlbedo = await mc.runCmd('file.importBitmap', { path: albedoSrcPath, name: `${name}_albedo` });
      const impHeight = await mc.runCmd('file.importBitmap', { path: heightSrcPath, name: `${name}_height` });
      const impRough = await mc.runCmd('file.importBitmap', { path: roughSrcPath, name: `${name}_rough` });
      const impAo = await mc.runCmd('file.importBitmap', { path: aoSrcPath, name: `${name}_ao` });

      const nAlb = await mc.runCmd('graph.node.add', {
        def: 'bitmap',
        at: [100, -240],
        label: `${name}_albedo`,
        params: { resource: impAlbedo?.name ?? `${name}_albedo`, colour_space: 0, color_mode: true },
      });
      const nHgtBmp = await mc.runCmd('graph.node.add', {
        def: 'bitmap',
        at: [100, 0],
        label: `${name}_height`,
        params: { resource: impHeight?.name ?? `${name}_height`, colour_space: 1, color_mode: false },
      });
      const nRghBmp = await mc.runCmd('graph.node.add', {
        def: 'bitmap',
        at: [100, 200],
        label: `${name}_rough`,
        params: { resource: impRough?.name ?? `${name}_rough`, colour_space: 1, color_mode: false },
      });
      const nAoBmp = await mc.runCmd('graph.node.add', {
        def: 'bitmap',
        at: [100, 380],
        label: `${name}_ao`,
        params: { resource: impAo?.name ?? `${name}_ao`, colour_space: 1, color_mode: false },
      });

      const nHgtGray = await mc.runCmd('graph.node.add', {
        def: 'grayscale_conversion',
        at: [320, 0],
        label: 'HeightGray',
        params: { red: 0.34, green: 0.33, blue: 0.33 },
        connectFrom: { node: nHgtBmp.id },
      });

      const nEmboss = await mc.runCmd('graph.node.add', {
        def: 'emboss',
        at: [540, 80],
        label: 'MicroReliefEmboss',
        params: { intensity: 0.9, light_angle: 0.7854 },
        connectFrom: { node: nHgtGray.id },
      });

      const nHgtCombine = await mc.runCmd('graph.node.add', {
        def: 'blend',
        at: [760, 0],
        label: 'CombinedHeight',
        params: { opacity: 0.84, mode: 0 },
        connectFrom: { node: nHgtGray.id },
      });
      await mc.runCmd('graph.connect', { from: nEmboss.id, to: nHgtCombine.id, toPort: 'background' });

      const nSharpAlb = await mc.runCmd('graph.node.add', {
        def: 'sharpen',
        at: [980, -240],
        label: 'CrispAlbedo',
        params: { intensity: 0.65 },
        connectFrom: { node: nAlb.id },
      });

      const nNormal = await mc.runCmd('graph.node.add', {
        def: 'normal',
        at: [980, -60],
        label: 'NormalOpenGL',
        params: { intensity: NORMAL_INTENSITY[m], opengl: true },
        connectFrom: { node: nHgtCombine.id },
      });

      const nRghGray = await mc.runCmd('graph.node.add', {
        def: 'grayscale_conversion',
        at: [980, 180],
        label: 'RoughnessGray',
        params: { red: 0.34, green: 0.33, blue: 0.33 },
        connectFrom: { node: nRghBmp.id },
      });

      const nAoGray = await mc.runCmd('graph.node.add', {
        def: 'grayscale_conversion',
        at: [980, 360],
        label: 'AoGray',
        params: { red: 0.34, green: 0.33, blue: 0.33 },
        connectFrom: { node: nAoBmp.id },
      });

      await mc.runCmd('graph.node.add', {
        def: 'output',
        at: [1240, -240],
        label: 'baseColor',
        params: { identifier: 'baseColor', usage: 0 },
        connectFrom: { node: nSharpAlb.id },
      });
      await mc.runCmd('graph.node.add', {
        def: 'output',
        at: [1240, -60],
        label: 'normal',
        params: { identifier: 'normal', usage: 1 },
        connectFrom: { node: nNormal.id },
      });
      await mc.runCmd('graph.node.add', {
        def: 'output',
        at: [1240, 120],
        label: 'roughness',
        params: { identifier: 'roughness', usage: 2 },
        connectFrom: { node: nRghGray.id },
      });
      await mc.runCmd('graph.node.add', {
        def: 'output',
        at: [1240, 260],
        label: 'ambientOcclusion',
        params: { identifier: 'ambientOcclusion', usage: 5 },
        connectFrom: { node: nAoGray.id },
      });
      await mc.runCmd('graph.node.add', {
        def: 'output',
        at: [1240, 400],
        label: 'height',
        params: { identifier: 'height', usage: 4 },
        connectFrom: { node: nHgtCombine.id },
      });

      const cookRes = await mc.runCmd('graph.cook', { full: true });
      console.log(`  Cooked ${name}:`, JSON.stringify(cookRes));

      const exportDir = path.join(tmpDir, `cooked_${name}`);
      fs.mkdirSync(exportDir, { recursive: true });
      const expRes = await mc.runCmd('file.export', {
        dir: exportDir,
        format: 'png',
        depth: 8,
        size: SIZE,
      });
      const exportedFiles = expRes?.files || fs.readdirSync(exportDir).map((f) => path.join(exportDir, f));
      console.log(`  Exported ${name} maps (${exportedFiles.length} files)`);

      const findExport = (usage) => {
        const match = exportedFiles.find((f) => path.basename(f).toLowerCase().includes(usage.toLowerCase()));
        if (!match) throw new Error(`Missing exported map for ${usage} in ${JSON.stringify(exportedFiles)}`);
        return match;
      };

      const cookedBase = decodePNG(fs.readFileSync(findExport('baseColor')));
      const cookedNorm = decodePNG(fs.readFileSync(findExport('normal')));
      const cookedRough = decodePNG(fs.readFileSync(findExport('roughness')));
      const cookedAo = decodePNG(fs.readFileSync(findExport('ambientOcclusion')));

      // Layer 2*m: BaseColor.rgb + Roughness.r
      // Layer 2*m + 1: Normal.rgb + AmbientOcclusion.r
      const layerEvenOffset = (2 * m) * SIZE * SIZE * 4;
      const layerOddOffset = (2 * m + 1) * SIZE * SIZE * 4;
      for (let i = 0; i < SIZE * SIZE; i++) {
        atlasRGBA[layerEvenOffset + i * 4] = cookedBase.rgba[i * 4];
        atlasRGBA[layerEvenOffset + i * 4 + 1] = cookedBase.rgba[i * 4 + 1];
        atlasRGBA[layerEvenOffset + i * 4 + 2] = cookedBase.rgba[i * 4 + 2];
        atlasRGBA[layerEvenOffset + i * 4 + 3] = cookedRough.rgba[i * 4];

        atlasRGBA[layerOddOffset + i * 4] = cookedNorm.rgba[i * 4];
        atlasRGBA[layerOddOffset + i * 4 + 1] = cookedNorm.rgba[i * 4 + 1];
        atlasRGBA[layerOddOffset + i * 4 + 2] = cookedNorm.rgba[i * 4 + 2];
        atlasRGBA[layerOddOffset + i * 4 + 3] = cookedAo.rgba[i * 4];
      }

      if (m === 1 || m === 3) {
        await mc.runCmd('view.3d.outputs', { reset: true });
        await mc.runCmd('view.3d', {
          scene: 'rounded_cube',
          environment: 'sunset',
          tiling: 2.0,
          heightScale: 0.05,
          yaw: 0.65,
          pitch: 0.38,
          distance: 2.5,
        });
        const prevPath = path.join(OUT_DIR, `${name}-preview.png`);
        const renderRes = await mc.call('view.screenshot', {
          path: prevPath,
          view: '3d',
          width: 640,
          height: 640,
          hq: true,
        });
        if (renderRes?.png) {
          fs.writeFileSync(prevPath, Buffer.from(renderRes.png, 'base64'));
        }
        console.log(`  Saved MaterialCraft 3D preview -> ${prevPath}`);
      }
    }

    const sbsPath = path.join(OUT_DIR, 'land-materials.sbs');
    await mc.runCmd('file.save', { path: sbsPath });
    console.log(`Saved MaterialCraft package -> ${sbsPath}`);

    fs.writeFileSync(ATLAS_PATH, encodePNG(SIZE, SIZE * 18, atlasRGBA));
    console.log(`Wrote cooked 18-layer PBR atlas (${SIZE}x${SIZE * 18}) -> ${ATLAS_PATH}`);
  } finally {
    mc.close();
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
