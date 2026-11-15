#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes GPU-resident 4-level Real Botanical Grass Continuum on 4.0 m seamless tiles:
//   - L0..L3: real extracted botanical organs (Dactylis glomerata tussocks, Plantago lanceolata rosettes & spikes,
//     Avena sterilis & Bromus diandrus culms & golden seed panicles) + dense arched 3D turf-grass micro-tufts,
//     with anti-flicker width compensation (1.05x -> 1.48x -> 2.15x -> tussock plumes), lossless vertex deduplication
//     across shared border plants, and zero synthetic opaque floor sheet!
//   - Continuum (morph.bin): closed genus-0 (Euler = 2) non-overlapping 4.0 m x 4.0 m sculpted tussock canopy
//     with shared periodic boundary heights (zero Z-fighting, cullMode: 'back') + O(1) u8x4 ancestor lookup table!
//   - Horizon splats: 1-triangle view-facing silhouette splat metadata per variant.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SRC_DIR = 'assets/ground-cover/portugal/meadows';
const OUT_DIR = 'assets/ground-cover/portugal/meadows-gpu';
const MIXES = ['pasture', 'waste', 'field-margin'];
const VARIANTS = 4;
const TILE_METRES = 4.0;
const SUB_GRID = 1;
const SOURCE_STRIDE = 12; // pos(3), nrm(3), linearSrgbCol(3), along(1), stiffness(1), anchor(1)
const GPU_VERTEX_WORDS = 8; // px, py, pz, packedNorm+wTag, packedCol+tuftRand, along, stiffness, packedMorphXZ(half2)
const CLUSTER_WORDS = 12;

// Screen-space error thresholds locked to spanPx * allowedErr = 4.6 across all resolutions:
// L0 (<~18 m), L1 (~18..34 m), L2 (~34..54 m), L3 (~54..76 m) -> MSAA sample_mask handoff (spanPx 26 -> 20) -> morph.bin
const LEVEL_ERRORS = [0.0, 0.040, 0.078, 0.124];
const LEVEL_PARENT_ERRORS = [0.040, 0.078, 0.124, 0.180];

// Sculpted 5x5 tussock canopy [-2.02, +2.02]^2 + 1 underground pole = 26 verts, 48 faces, 72 edges -> V - E + F = 2!
const MORPH_GRID = 5;
const MORPH_VERTS = MORPH_GRID * MORPH_GRID + 1; // 26
const MORPH_FACES = (MORPH_GRID - 1) * (MORPH_GRID - 1) * 2 + (MORPH_GRID - 1) * 4; // 32 top + 16 bottom = 48
const MORPH_STEPS = 21; // 26 -> 5 core verts = 6 core tris (2 top square + 4 culled bottom)
const MORPH_HALF_M = 2.02; // 2 cm seam weld across 4.0 m lattice (non-overlapping, zero Z-fighting)
const MORPH_REMAP_WORDS = Math.ceil((MORPH_STEPS * MORPH_VERTS) / 2 / 4) * 4; // 276 u32 words (u8x4 (v0,v1) pairs)

// Raw forestmodeler linear-srgb single-leaf diffuse albedo (~0.26..0.38) scaled into shaded canopy reflectance domain
const CANOPY_ALBEDO_SCALE = 0.42;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const qPos = (v) => Math.round(v * 512) / 512; // 1.95 mm spatial precision + clean mantissa zeros for gzip
const qAttr = (v) => Math.round(v * 64) / 64;
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

function hash01(seed, idx) {
  let h = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(idx + 1, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hashCoordSeed(a, b, c = 0) {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(c | 0, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

const _f16Buf = new ArrayBuffer(4);
const _f16F32 = new Float32Array(_f16Buf);
const _f16U32 = new Uint32Array(_f16Buf);
function floatToHalf(val) {
  _f16F32[0] = val;
  const bits = _f16U32[0];
  const sign = (bits >>> 16) & 0x8000;
  let mantissa = bits & 0x007fffff;
  let exp = (bits >>> 23) & 0xff;
  if (exp === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00);
  exp -= 112;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mantissa = (mantissa | 0x00800000) >>> (1 - exp);
    if (mantissa & 0x00001000) mantissa += 0x00002000;
    return sign | (mantissa >>> 13);
  }
  if (mantissa & 0x00001000) {
    mantissa += 0x00002000;
    if (mantissa & 0x00800000) {
      mantissa = 0;
      exp += 1;
      if (exp >= 31) return sign | 0x7c00;
    }
  }
  return sign | (exp << 10) | (mantissa >>> 13);
}
function packHalf2(x, y) {
  return (((floatToHalf(y) & 0xffff) << 16) | (floatToHalf(x) & 0xffff)) >>> 0;
}

function packSnorm8x4(nx, ny, nz, w = 1.0) {
  const len = Math.hypot(nx, ny, nz) || 1;
  const x = clamp(Math.round((nx / len) * 127), -127, 127) & 0xff;
  const y = clamp(Math.round((ny / len) * 127), -127, 127) & 0xff;
  const z = clamp(Math.round((nz / len) * 127), -127, 127) & 0xff;
  const a = clamp(Math.round(clamp(w, -1, 1) * 127), -127, 127) & 0xff;
  return ((a << 24) | (z << 16) | (y << 8) | x) >>> 0;
}

// Encodes linear-srgb reflectance into sRGB unorm8x3 + per-tuft stochastic margin survival threshold in alpha.
function packColorUnorm8x4(linR, linG, linB, tuftRand = 1.0) {
  const enc = (c) => clamp(Math.round(Math.pow(clamp(c, 0, 1), 1 / 2.2) * 255), 0, 255);
  const ir = enc(linR), ig = enc(linG), ib = enc(linB);
  const ia = clamp(Math.round(clamp(tuftRand, 0, 1) * 255), 0, 255);
  return ((ia << 24) | (ib << 16) | (ig << 8) | ir) >>> 0;
}

function triArea3D(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const ux = aby * acz - abz * acy;
  const uy = abz * acx - abx * acz;
  const uz = abx * acy - aby * acx;
  return 0.5 * Math.hypot(ux, uy, uz);
}

// Lossless global 32-byte vertex pool: identical vertices across shared border clumps, variants, and tuft crowns
// share a single vertex entry in vertices.bin and are referenced by uint32 index in indices.bin!
function createGlobalVertexPool() {
  const words = []; // raw u32 words (8 per vertex)
  const map = new Map();
  const scratchBuf = new ArrayBuffer(32);
  const sf32 = new Float32Array(scratchBuf);
  const su32 = new Uint32Array(scratchBuf);
  const su8 = new Uint8Array(scratchBuf);

  return {
    words,
    get count() { return words.length / GPU_VERTEX_WORDS; },
    add(px, py, pz, packedNormW, packedColA, along, stiff, packedMorph) {
      sf32[0] = px;
      sf32[1] = py;
      sf32[2] = pz;
      su32[3] = packedNormW >>> 0;
      su32[4] = packedColA >>> 0;
      sf32[5] = along;
      sf32[6] = stiff;
      su32[7] = packedMorph >>> 0;
      const key = Buffer.from(su8).toString('latin1');
      const existing = map.get(key);
      if (existing !== undefined) return existing;
      const vi = words.length / GPU_VERTEX_WORDS;
      for (let k = 0; k < 8; k++) words.push(su32[k]);
      map.set(key, vi);
      return vi;
    },
    posOf(vi) {
      const b = vi * GPU_VERTEX_WORDS;
      su32[0] = words[b];
      su32[1] = words[b + 1];
      su32[2] = words[b + 2];
      return [sf32[0], sf32[1], sf32[2]];
    },
    toUint8Array() {
      const out = new Uint32Array(words);
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
  };
}

// Extracts simplified real botanical blades, ribwort rosettes, culms & golden panicle heads from a raw variant.
// IMPORTANT: srcVerts[s+6..8] is ALREADY linear-srgb — never apply pow(c, 2.2) a second time!
function extractBotanicalOrgans(srcVerts, srcIndices, varSpec, mixIdx, vIdx) {
  const blades = [];

  for (let ci = 0; ci < varSpec.clumps.length; ci++) {
    const c = varSpec.clumps[ci];
    const rx = c.root[0], rz = c.root[1];
    const clumpSeed = c.shared
      ? hashCoordSeed(mixIdx + 1, Math.round(rx * 1000), Math.round(rz * 1000) * 8 + c.species)
      : hashCoordSeed(mixIdx * 16 + vIdx + 1, Math.round(rx * 1000), Math.round(rz * 1000) * 8 + ci);
    const tuftRand = clamp(0.06 + 0.88 * hash01(clumpSeed, 0), 0.06, 0.94);

    const vCount = c.vertexCount;
    if (vCount < 3 || c.indexCount < 3) continue;
    const parent = new Int32Array(vCount).fill(-1);
    const find = (x) => {
      let r = x;
      while (parent[r] >= 0) r = parent[r];
      let cur = x;
      while (cur !== r) { const nxt = parent[cur]; parent[cur] = r; cur = nxt; }
      return r;
    };
    const unite = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    const endI = c.firstIndex + c.indexCount;
    for (let ii = c.firstIndex; ii < endI; ii += 3) {
      const a = srcIndices[ii] - c.firstVertex;
      const b = srcIndices[ii + 1] - c.firstVertex;
      const d = srcIndices[ii + 2] - c.firstVertex;
      if (a >= 0 && a < vCount && b >= 0 && b < vCount && d >= 0 && d < vCount) {
        unite(a, b);
        unite(b, d);
      }
    }

    const compVerts = new Map();
    const compTris = new Map();
    for (let lv = 0; lv < vCount; lv++) {
      const r = find(lv);
      let arr = compVerts.get(r);
      if (!arr) { arr = []; compVerts.set(r, arr); }
      arr.push(c.firstVertex + lv);
    }
    for (let ii = c.firstIndex; ii < endI; ii += 3) {
      const r = find(srcIndices[ii] - c.firstVertex);
      compTris.set(r, (compTris.get(r) || 0) + 1);
    }

    const clumpLeaves = [];
    const clumpCulms = [];
    const spikeletCloud = [];

    for (const [r, vs] of compVerts) {
      const tCnt = compTris.get(r) || 0;
      const nv = vs.length;

      // 1. V-folded grass leaf / ribwort basal rosette leaf: nv = 3*K + 1, tCnt = 4*K - 2 (K = 4..7)
      if (nv >= 13 && nv <= 25 && (nv - 1) % 3 === 0 && tCnt === ((nv - 1) / 3) * 4 - 2) {
        const K = (nv - 1) / 3;
        const oTip = vs[nv - 1] * SOURCE_STRIDE;
        const oBase = vs[1] * SOURCE_STRIDE;
        const span = Math.hypot(
          srcVerts[oTip] - srcVerts[oBase],
          srcVerts[oTip + 1] - srcVerts[oBase + 1],
          srcVerts[oTip + 2] - srcVerts[oBase + 2],
        );
        if (span < 0.045) continue;

        const rMid = Math.min(K - 1, Math.max(1, Math.floor(K * 0.45)));
        const rows = [0, rMid];
        const pts = [];
        for (const rk of rows) {
          const oL = vs[rk * 3] * SOURCE_STRIDE;
          const oM = vs[rk * 3 + 1] * SOURCE_STRIDE;
          const oR = vs[rk * 3 + 2] * SOURCE_STRIDE;
          let dx = srcVerts[oR] - srcVerts[oL];
          let dy = srcVerts[oR + 1] - srcVerts[oL + 1];
          let dz = srcVerts[oR + 2] - srcVerts[oL + 2];
          const w = Math.hypot(dx, dy, dz);
          if (w > 1e-5) { dx /= w; dy /= w; dz /= w; } else { dx = 1; dy = 0; dz = 0; }
          const hw = clamp(w * 0.62, 0.0032, 0.017);
          const py = srcVerts[oM + 1];
          const col = [
            clamp(srcVerts[oM + 6] * CANOPY_ALBEDO_SCALE, 0.014, 0.22),
            clamp(srcVerts[oM + 7] * CANOPY_ALBEDO_SCALE, 0.020, 0.24),
            clamp(srcVerts[oM + 8] * CANOPY_ALBEDO_SCALE, 0.008, 0.13),
          ];
          const effAlong = clamp(Math.max(srcVerts[oM + 9] * 0.85, py * 1.55), 0.0, 1.0);
          pts.push({
            x: srcVerts[oM], y: py, z: srcVerts[oM + 2],
            sx: dx, sy: dy, sz: dz,
            hw, col, along: effAlong,
          });
        }
        const tipCol = [
          clamp(srcVerts[oTip + 6] * CANOPY_ALBEDO_SCALE * 1.06, 0.016, 0.24),
          clamp(srcVerts[oTip + 7] * CANOPY_ALBEDO_SCALE * 1.06, 0.022, 0.26),
          clamp(srcVerts[oTip + 8] * CANOPY_ALBEDO_SCALE * 1.02, 0.008, 0.14),
        ];
        pts.push({
          x: srcVerts[oTip], y: srcVerts[oTip + 1], z: srcVerts[oTip + 2],
          sx: pts[1].sx, sy: pts[1].sy, sz: pts[1].sz,
          hw: 0, col: tipCol, along: clamp(Math.max(0.75, srcVerts[oTip + 1] * 1.65), 0.55, 1.0),
        });
        const stiff = clamp(c.species === 3 ? 11.5 : 8.5, 4.0, 18.0);
        clumpLeaves.push({
          rootX: rx, rootZ: rz, species: c.species, shared: c.shared, stiff, tuftRand,
          span, pts,
        });
        continue;
      }

      // 2. 3-sided hollow culm / flower scape: nv = 3*K, tCnt = 6*(K - 1)
      if (nv >= 9 && nv <= 30 && nv % 3 === 0 && tCnt === (nv / 3 - 1) * 6) {
        const K = nv / 3;
        const ring = (rk) => {
          const a = vs[rk * 3] * SOURCE_STRIDE, b = vs[rk * 3 + 1] * SOURCE_STRIDE, d = vs[rk * 3 + 2] * SOURCE_STRIDE;
          return {
            x: (srcVerts[a] + srcVerts[b] + srcVerts[d]) / 3,
            y: (srcVerts[a + 1] + srcVerts[b + 1] + srcVerts[d + 1]) / 3,
            z: (srcVerts[a + 2] + srcVerts[b + 2] + srcVerts[d + 2]) / 3,
            col: [
              clamp(((srcVerts[a + 6] + srcVerts[b + 6] + srcVerts[d + 6]) / 3) * CANOPY_ALBEDO_SCALE, 0.016, 0.24),
              clamp(((srcVerts[a + 7] + srcVerts[b + 7] + srcVerts[d + 7]) / 3) * CANOPY_ALBEDO_SCALE, 0.022, 0.26),
              clamp(((srcVerts[a + 8] + srcVerts[b + 8] + srcVerts[d + 8]) / 3) * CANOPY_ALBEDO_SCALE, 0.008, 0.14),
            ],
            stiff: clamp(srcVerts[a + 10], 4.0, 20.0),
          };
        };
        const p0 = ring(0), pTop = ring(K - 1);
        if (pTop.y - p0.y > 0.16) {
          clumpCulms.push({ p0, pTop });
        }
        continue;
      }

      // 3. Panicle spikelets (4v_2t) or ribwort cylindrical flower head (16v_25t)
      if ((nv === 4 && tCnt === 2) || (nv === 16 && tCnt === 25)) {
        let cx = 0, cy = 0, cz = 0, cr = 0, cg = 0, cb = 0;
        for (let k = 0; k < nv; k++) {
          const o = vs[k] * SOURCE_STRIDE;
          cx += srcVerts[o]; cy += srcVerts[o + 1]; cz += srcVerts[o + 2];
          cr += srcVerts[o + 6]; cg += srcVerts[o + 7]; cb += srcVerts[o + 8];
        }
        cx /= nv; cy /= nv; cz /= nv;
        if (cy > 0.18) {
          spikeletCloud.push({
            x: cx, y: cy, z: cz,
            col: [
              clamp((cr / nv) * CANOPY_ALBEDO_SCALE * 1.12, 0.020, 0.25),
              clamp((cg / nv) * CANOPY_ALBEDO_SCALE * 1.10, 0.024, 0.26),
              clamp((cb / nv) * CANOPY_ALBEDO_SCALE * 1.04, 0.010, 0.15),
            ],
          });
        }
      }
    }

    clumpCulms.sort((a, b) => b.pTop.y - a.pTop.y);
    if (clumpCulms.length > 0) {
      const culm = clumpCulms[0];
      let headX = culm.pTop.x, headY = culm.pTop.y, headZ = culm.pTop.z;
      let headCol = culm.pTop.col;
      let headCount = 0, sumX = 0, sumY = 0, sumZ = 0, sumR = 0, sumG = 0, sumB = 0;
      for (const sp of spikeletCloud) {
        if (Math.hypot(sp.x - culm.pTop.x, sp.y - culm.pTop.y, sp.z - culm.pTop.z) < 0.22) {
          sumX += sp.x; sumY += sp.y; sumZ += sp.z;
          sumR += sp.col[0]; sumG += sp.col[1]; sumB += sp.col[2];
          headCount++;
        }
      }
      if (headCount > 0) {
        const mx = sumX / headCount, my = sumY / headCount, mz = sumZ / headCount;
        headX = culm.pTop.x + (mx - culm.pTop.x) * 1.45;
        headY = Math.max(culm.pTop.y + 0.04, culm.pTop.y + (my - culm.pTop.y) * 1.45);
        headZ = culm.pTop.z + (mz - culm.pTop.z) * 1.45;
        headCol = [sumR / headCount, sumG / headCount, sumB / headCount];
      }
      const dx = headX - culm.p0.x, dz = headZ - culm.p0.z;
      const hl = Math.hypot(dx, dz);
      const sx = hl > 1e-4 ? -dz / hl : 1.0;
      const sz = hl > 1e-4 ? dx / hl : 0.0;
      const panicleHW = headCount > 0 ? (c.species === 1 ? 0.015 : c.species === 3 ? 0.0085 : 0.0115) : 0.0048;
      blades.push({
        rootX: rx,
        rootZ: rz,
        species: c.species,
        shared: c.shared,
        isBroad: true, // 3-tri culm + golden panicle plume
        stiff: clamp(culm.p0.stiff, 5.5, 16.0),
        tuftRand,
        retirePhase: Math.round(hash01(clumpSeed, 91) * 7) / 7,
        score: (c.shared ? 0.42 : 0.0) + headY * 0.85 + hash01(clumpSeed, 11) * 0.42,
        pts: [
          { x: culm.p0.x, y: Math.max(0.0, culm.p0.y - 0.008), z: culm.p0.z, sx, sy: 0, sz, hw: 0.0032, col: culm.p0.col, along: 0.04 },
          { x: culm.pTop.x, y: culm.pTop.y, z: culm.pTop.z, sx, sy: 0, sz, hw: panicleHW, col: headCol, along: 0.74 },
          { x: headX, y: Math.min(0.68, headY), z: headZ, sx, sy: 0, sz, hw: 0, col: headCol, along: 1.0 },
        ],
      });
    }

    clumpLeaves.sort((a, b) => b.span - a.span);
    const maxLeaves = c.species === 0 ? 4 : c.species === 3 ? 3 : 2;
    for (let k = 0; k < Math.min(clumpLeaves.length, maxLeaves); k++) {
      const lf = clumpLeaves[k];
      blades.push({
        ...lf,
        isBroad: c.species === 3, // Broad ribwort plantain rosette leaves use 3-tri; grass blades use crisp 2-tri lanceolate
        retirePhase: Math.round(hash01(clumpSeed, 97 + k) * 7) / 7,
        score: (c.shared ? 0.45 : 0.0) + lf.span * 1.4 + (k === 0 ? 0.35 : 0.0) + hash01(clumpSeed, 31 + k) * 0.4,
      });
    }
  }

  blades.sort((a, b) => b.score - a.score);
  return blades;
}

// Generates dense, natural arched 3D turf-grass micro-tufts filling the 4.0 m x 4.0 m sward between tussocks.
// Outer 2 rings (within 0.72 m of the 4.0 m border) use a variant-invariant seed so rotRad = 0 tiles interlock seamlessly
// AND share vertices across variants in vertices.bin!
function generateSupplementalTurfTufts(profile, mixIdx, vIdx) {
  const tufts = [];
  const TUFT_GRID = 12; // 12 x 12 = 144 micro-tufts per 4.0 m x 4.0 m tile (9 micro-tufts/m^2, 6 arched blades each = 864 turf blades!)
  const cellM = TILE_METRES / TUFT_GRID;

  for (let gz = 0; gz < TUFT_GRID; gz++) {
    for (let gx = 0; gx < TUFT_GRID; gx++) {
      const borderDist = Math.min(gx, TUFT_GRID - 1 - gx, gz, TUFT_GRID - 1 - gz);
      const isSharedBorder = borderDist <= 1;
      // Interior micro-tufts draw from 2 variant banks per mix + shared border ring -> rich natural variety + compact stream
      const bankId = vIdx & 1;
      const seed = isSharedBorder
        ? hashCoordSeed(911 + mixIdx * 7, gx + 17, gz + 53)
        : hashCoordSeed(mixIdx * 16 + bankId + 101, gx + 17, gz + 53);

      const jx = (hash01(seed, 1) - 0.5) * cellM * 0.78;
      const jz = (hash01(seed, 2) - 0.5) * cellM * 0.78;
      const rootX = clamp((gx + 0.5) * cellM + jx, 0.03, TILE_METRES - 0.03);
      const rootZ = clamp((gz + 0.5) * cellM + jz, 0.03, TILE_METRES - 0.03);
      const tuftRand = clamp(0.05 + 0.90 * hash01(seed, 3), 0.05, 0.95);
      const tuftTall = 0.76 + 0.52 * hash01(seed, 4);
      const tuftHue = hash01(seed, 5);
      const baseAz = hash01(seed, 6) * Math.PI * 2;
      const stiff = profile.stiffness * (0.78 + 0.36 * hash01(seed, 7));

      const cRoot = [
        lerp(profile.rootCol[0], profile.strawCol[0], 0.12),
        lerp(profile.rootCol[1], profile.strawCol[1], 0.12),
        lerp(profile.rootCol[2], profile.strawCol[2], 0.12),
      ];

      const blades = [];
      const bladesInTuft = 6;
      for (let bi = 0; bi < bladesInTuft; bi++) {
        const bSeed = hashCoordSeed(seed, bi + 1, 7);
        const az = baseAz + (bi / bladesInTuft) * Math.PI * 2 + (hash01(bSeed, 1) - 0.5) * 0.52;
        const dirX = Math.cos(az), dirZ = Math.sin(az);
        const sideX = -dirZ, sideZ = dirX;

        const hPeak = profile.turfHeight * tuftTall * (0.72 + 0.54 * hash01(bSeed, 3));
        const reach = (0.09 + 0.14 * hash01(bSeed, 4)) * tuftTall;
        const droop = 0.76 + 0.22 * hash01(bSeed, 5);
        const hwMid = 0.0038 + 0.0022 * hash01(bSeed, 6);
        const senescent = hash01(bSeed, 8) > 0.68 ? 1.0 : 0.25 * hash01(bSeed, 9);
        const hueScale = 0.90 + 0.20 * tuftHue;

        const cMid = [
          clamp(lerp(profile.midCol[0], profile.strawCol[0], senescent * 0.55) * hueScale, 0.016, 0.22),
          clamp(lerp(profile.midCol[1], profile.strawCol[1], senescent * 0.50) * hueScale, 0.022, 0.24),
          clamp(lerp(profile.midCol[2], profile.strawCol[2], senescent * 0.55), 0.008, 0.13),
        ];
        const cTip = [
          clamp(lerp(profile.tipCol[0], profile.strawCol[0], senescent * 0.85) * hueScale, 0.020, 0.25),
          clamp(lerp(profile.tipCol[1], profile.strawCol[1], senescent * 0.80) * hueScale, 0.026, 0.26),
          clamp(lerp(profile.tipCol[2], profile.strawCol[2], senescent * 0.85), 0.010, 0.14),
        ];

        blades.push({
          midX: rootX + dirX * reach * 0.52,
          midY: hPeak * 0.84,
          midZ: rootZ + dirZ * reach * 0.52,
          tipX: rootX + dirX * reach,
          tipY: hPeak * droop,
          tipZ: rootZ + dirZ * reach,
          sx: sideX,
          sz: sideZ,
          hw: hwMid,
          cMid,
          cTip,
        });
      }

      tufts.push({
        gx,
        gz,
        rootX,
        rootZ,
        tuftRand,
        stiff,
        cRoot,
        blades,
        score: (isSharedBorder ? 0.25 : 0.0) + hash01(seed, 19) * 0.75,
      });
    }
  }

  return tufts;
}

// Emits a botanical organ (3-tri ribbon for broad rosettes/panicles, or 2-tri arched lanceolate blade for grass leaves).
function emitBotanicalOrgan(pool, outIndices, blade, widthMult, heightMult, retiring, retireRank, stats) {
  const [p0, p1, p2] = blade.pts;
  const wTag = retiring ? -(0.10 + 0.86 * clamp(retireRank, 0, 1)) : 1.0;
  const rx = blade.rootX, rz = blade.rootZ;

  const ax = p2.x - p0.x, ay = (p2.y - p0.y) * heightMult, az = p2.z - p0.z;
  let nx = p1.sy * az - p1.sz * ay;
  let ny = p1.sz * ax - p1.sx * az;
  let nz = p1.sx * ay - p1.sy * ax;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  ny = Math.abs(ny) + 0.65;

  const addV = (px, py, pz, snx, sny, snz, col, along, forceSurvive = false) => {
    const fy = py <= 0 ? py : py * heightMult;
    if (fy > stats.maxY) stats.maxY = fy;
    const qx = qPos(px), qy = qPos(fy), qz = qPos(pz);
    const useRetire = retiring && !forceSurvive;
    return pool.add(
      qx,
      qy,
      qz,
      packSnorm8x4(snx, sny, snz, useRetire ? wTag : 1.0),
      packColorUnorm8x4(col[0], col[1], col[2], blade.tuftRand),
      qAttr(clamp(along, 0, 1)),
      qAttr(blade.stiff),
      useRetire ? packHalf2(rx - qx, rz - qz) : 0,
    );
  };

  const addT = (i0, i1, i2, colHint) => {
    const [ax0, ay0, az0] = pool.posOf(i0);
    const [bx0, by0, bz0] = pool.posOf(i1);
    const [cx0, cy0, cz0] = pool.posOf(i2);
    const area = triArea3D(ax0, ay0, az0, bx0, by0, bz0, cx0, cy0, cz0);
    if (area > 1e-8) {
      stats.sumR += colHint[0] * area;
      stats.sumG += colHint[1] * area;
      stats.sumB += colHint[2] * area;
      stats.sumArea += area;
    }
    outIndices.push(i0, i1, i2);
  };

  const hw1 = p1.hw * widthMult;
  const i1L = addV(p1.x - p1.sx * hw1, p1.y, p1.z - p1.sz * hw1, nx - p1.sx * 0.18, ny, nz - p1.sz * 0.18, p1.col, p1.along);
  const i1R = addV(p1.x + p1.sx * hw1, p1.y, p1.z + p1.sz * hw1, nx + p1.sx * 0.18, ny, nz + p1.sz * 0.18, p1.col, p1.along);
  const iTip = addV(p2.x, p2.y, p2.z, nx * 0.6, ny + 0.25, nz * 0.6, p2.col, p2.along);

  if (blade.isBroad) {
    const hw0 = p0.hw * widthMult;
    const i0L = addV(p0.x - p0.sx * hw0, p0.y, p0.z - p0.sz * hw0, nx - p0.sx * 0.22, ny, nz - p0.sz * 0.22, p0.col, p0.along);
    const i0R = addV(p0.x + p0.sx * hw0, p0.y, p0.z + p0.sz * hw0, nx + p0.sx * 0.22, ny, nz + p0.sz * 0.22, p0.col, p0.along);
    addT(i0L, i0R, i1R, p0.col);
    addT(i0L, i1R, i1L, p1.col);
    addT(i1L, i1R, iTip, p2.col);
  } else {
    const iBase = addV(p0.x, p0.y, p0.z, nx * 0.4, ny + 0.35, nz * 0.4, p0.col, p0.along);
    addT(iBase, i1L, i1R, p1.col);
    addT(i1L, iTip, i1R, p2.col);
  }
}

// Emits a shared-crown arched 3D turf micro-tuft (1 shared root crown vertex + B x 2-tri arched lanceolate blades).
function emitTurfTuft(pool, outIndices, tuft, bladesToEmit, bladesNextLvl, widthMult, heightMult, lvl, stats) {
  if (bladesToEmit <= 0) return;
  const rx = qPos(tuft.rootX), rz = qPos(tuft.rootZ);
  const iCrown = pool.add(
    rx,
    qPos(-0.008),
    rz,
    packSnorm8x4(0, 1, 0, 1.0),
    packColorUnorm8x4(tuft.cRoot[0], tuft.cRoot[1], tuft.cRoot[2], tuft.tuftRand),
    0.0,
    qAttr(tuft.stiff),
    0,
  );

  for (let bi = 0; bi < bladesToEmit; bi++) {
    const b = tuft.blades[bi];
    const retiring = lvl < 3 ? bi >= bladesNextLvl : true;
    const rank = lvl < 3
      ? (retiring ? (bi - bladesNextLvl) / Math.max(1, bladesToEmit - bladesNextLvl) : 0)
      : (bi / Math.max(1, bladesToEmit));
    const wTag = retiring ? -(0.12 + 0.84 * clamp(rank, 0, 1)) : 1.0;

    const hw = b.hw * widthMult;
    const my = qPos(b.midY * heightMult);
    const ty = qPos(b.tipY * heightMult);
    if (my > stats.maxY) stats.maxY = my;
    if (ty > stats.maxY) stats.maxY = ty;

    const lx = qPos(b.midX - b.sx * hw), lz = qPos(b.midZ - b.sz * hw);
    const rx2 = qPos(b.midX + b.sx * hw), rz2 = qPos(b.midZ + b.sz * hw);
    const tx = qPos(b.tipX), tz = qPos(b.tipZ);

    const iL = pool.add(
      lx, my, lz,
      packSnorm8x4(-b.sx * 0.24, 0.94, -b.sz * 0.24, wTag),
      packColorUnorm8x4(b.cMid[0], b.cMid[1], b.cMid[2], tuft.tuftRand),
      qAttr(0.52),
      qAttr(tuft.stiff),
      retiring ? packHalf2(rx - lx, rz - lz) : 0,
    );
    const iR = pool.add(
      rx2, my, rz2,
      packSnorm8x4(b.sx * 0.24, 0.94, b.sz * 0.24, wTag),
      packColorUnorm8x4(b.cMid[0], b.cMid[1], b.cMid[2], tuft.tuftRand),
      qAttr(0.52),
      qAttr(tuft.stiff),
      retiring ? packHalf2(rx - rx2, rz - rz2) : 0,
    );
    const iTip = pool.add(
      tx, ty, tz,
      packSnorm8x4(0.0, 0.98, 0.0, wTag),
      packColorUnorm8x4(b.cTip[0], b.cTip[1], b.cTip[2], tuft.tuftRand),
      qAttr(0.96),
      qAttr(tuft.stiff * 0.88),
      retiring ? packHalf2(rx - tx, rz - tz) : 0,
    );

    const area1 = triArea3D(rx, -0.008, rz, lx, my, lz, rx2, my, rz2);
    const area2 = triArea3D(lx, my, lz, tx, ty, tz, rx2, my, rz2);
    const area = area1 + area2;
    if (area > 1e-8) {
      stats.sumR += b.cMid[0] * area;
      stats.sumG += b.cMid[1] * area;
      stats.sumB += b.cMid[2] * area;
      stats.sumArea += area;
    }
    outIndices.push(iCrown, iL, iR, iL, iTip, iR);
  }
}

// Builds L0..L3 for a 4.0 m x 4.0 m seamless botanical meadow tile (ZERO synthetic opaque floor sheet!):
//   L0: ~2,950 tris (~1,380 3D botanical + turf grass blades)
//   L1: ~1,150 tris (1.48x width-compensated anti-flicker ribbons)
//   L2:   ~460 tris (2.15x width-compensated arched tussock fans)
//   L3:   ~180 tris (broad volumetric tussock plumes matching sculpted morph.bin)
function buildBotanicalMeadowLevel(pool, outIndices, botBlades, turfTufts, profile, lvl) {
  const stats = { sumR: 0, sumG: 0, sumB: 0, sumArea: 0, maxY: 0.22 };
  const startIdx = outIndices.length;

  const BOT_COUNTS = [530, 240, 82, 28];
  const TUFT_BLADES_PER_CELL = [6, 2, 1, 1];
  const TUFT_KEEP_CELLS = [144, 144, 140, 58];
  const WIDTH_COMP = [1.05, 1.48, 2.15, 4.60];
  const HEIGHT_SCALE = [1.00, 0.98, 0.93, 0.82];

  const botN = Math.min(botBlades.length, BOT_COUNTS[lvl]);
  const nextBotN = lvl < 3 ? Math.min(botBlades.length, BOT_COUNTS[lvl + 1]) : 0;
  const wMult = WIDTH_COMP[lvl];
  const hMult = HEIGHT_SCALE[lvl];

  // Order spatially by (gx, gz) after ranking slice for optimal vertex cache + gzip LZ77 locality!
  const chosenBot = botBlades.slice(0, botN).map((b, rankIdx) => ({ b, rankIdx }));
  chosenBot.sort((a, b) => (Math.floor(a.b.rootZ) * 4 + Math.floor(a.b.rootX)) - (Math.floor(b.b.rootZ) * 4 + Math.floor(b.b.rootX)));

  for (const { b, rankIdx } of chosenBot) {
    const retiring = lvl < 3 ? rankIdx >= nextBotN : true;
    const rank = retiring ? b.retirePhase : 0;
    emitBotanicalOrgan(pool, outIndices, b, wMult, hMult, retiring, rank, stats);
  }

  const rankedTufts = [...turfTufts].sort((a, b) => b.score - a.score);
  const activeTufts = rankedTufts.slice(0, Math.min(turfTufts.length, TUFT_KEEP_CELLS[lvl]));
  const nextTuftSet = lvl < 3 ? new Set(rankedTufts.slice(0, Math.min(turfTufts.length, TUFT_KEEP_CELLS[lvl + 1]))) : null;
  activeTufts.sort((a, b) => (a.gz * 16 + a.gx) - (b.gz * 16 + b.gx));

  const curB = TUFT_BLADES_PER_CELL[lvl];
  const nxtB = lvl < 3 ? TUFT_BLADES_PER_CELL[lvl + 1] : 0;
  for (const tuft of activeTufts) {
    const surviveNext = nextTuftSet?.has(tuft) ? nxtB : 0;
    emitTurfTuft(pool, outIndices, tuft, curB, surviveNext, wMult, hMult, lvl, stats);
  }

  const meanCol = stats.sumArea > 0
    ? [stats.sumR / stats.sumArea, stats.sumG / stats.sumArea, stats.sumB / stats.sumArea]
    : profile.midCol;
  return { idxCount: outIndices.length - startIdx, meanCol, maxY: stats.maxY };
}

// Evaluates periodic 4.0 m boundary height so all adjacent continuum tiles meet at exact identical heights (zero Z-fighting).
function evalPeriodicBorderCanopyY(tx, tz) {
  const px = (tx / TILE_METRES) * Math.PI * 2;
  const pz = (tz / TILE_METRES) * Math.PI * 2;
  return 0.135
    + 0.022 * Math.cos(px) * Math.cos(pz)
    + 0.014 * Math.sin(px * 2.0 + 0.7)
    + 0.014 * Math.cos(pz * 2.0 - 0.5);
}

// Evaluates sculpted tussock-canopy height at tile coords [0..4]^2 from the variant's real botanical clumps,
// blending smoothly onto the exact periodic border on the outer perimeter!
function evalTussockCanopyY(tx, tz, varSpec, profile) {
  const borderY = evalPeriodicBorderCanopyY(tx, tz);
  const edgeDist = Math.min(tx, TILE_METRES - tx, tz, TILE_METRES - tz);
  if (edgeDist <= 0.05) return borderY;

  let clumpLift = 0.0;
  let weightSum = 0.0;
  for (let ci = 0; ci < varSpec.clumps.length; ci++) {
    const c = varSpec.clumps[ci];
    const dx = tx - c.centre[0];
    const dz = tz - c.centre[2];
    const r = Math.max(0.32, c.radius * 1.15);
    const d2 = dx * dx + dz * dz;
    if (d2 > r * r * 3.2) continue;
    const w = Math.exp(-d2 / (0.65 * r * r));
    const h = clamp(c.centre[1] * 0.62, 0.09, 0.28);
    clumpLift += h * w;
    weightSum += w;
  }
  const interiorY = weightSum > 0.05
    ? lerp(profile.canopyBaseY, clamp(clumpLift / Math.max(weightSum, 0.65), 0.10, 0.26), clamp(weightSum * 0.55, 0, 0.85))
    : profile.canopyBaseY;
  const interiorBlend = clamp((edgeDist - 0.05) / 0.85, 0, 1);
  return lerp(borderY, interiorY, interiorBlend * interiorBlend * (3 - 2 * interiorBlend));
}

// Builds closed genus-0 (Euler = 2) 5x5 sculpted tussock canopy + underground pole (V=26, E=72, F=48 -> coreTriCount=6)
// and bakes the flat O(1) cumulative vertex ancestor table (u8 packed 4-per-u32).
function buildSculptedContinuumForVariant(varSpec, profile, tileMeanCol) {
  const V = MORPH_VERTS; // 26
  const BOT = V - 1;     // 25
  const pos = new Float32Array(V * 3);
  const nrm = new Float32Array(V * 3);
  const col = new Float32Array(V * 3);
  const sway = new Float32Array(V * 3);

  const setV = (vi, lx, ly, lz, nx, ny, nz, rgb, alongVal) => {
    pos[vi * 3] = qPos(lx);
    pos[vi * 3 + 1] = qPos(ly);
    pos[vi * 3 + 2] = qPos(lz);
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm[vi * 3] = nx / len;
    nrm[vi * 3 + 1] = ny / len;
    nrm[vi * 3 + 2] = nz / len;
    col[vi * 3] = clamp(rgb[0], 0, 1);
    col[vi * 3 + 1] = clamp(rgb[1], 0, 1);
    col[vi * 3 + 2] = clamp(rgb[2], 0, 1);
    sway[vi * 3] = qAttr(alongVal);
    sway[vi * 3 + 1] = qAttr(profile.stiffness * 1.15);
    sway[vi * 3 + 2] = qAttr(alongVal * alongVal * 0.08);
  };

  const borderCol = [0.098, 0.118, 0.054];

  for (let iz = 0; iz < MORPH_GRID; iz++) {
    for (let ix = 0; ix < MORPH_GRID; ix++) {
      const vi = iz * MORPH_GRID + ix;
      const u = ix / (MORPH_GRID - 1);
      const v = iz / (MORPH_GRID - 1);
      const lx = lerp(-MORPH_HALF_M, MORPH_HALF_M, u);
      const lz = lerp(-MORPH_HALF_M, MORPH_HALF_M, v);
      const tx = u * TILE_METRES;
      const tz = v * TILE_METRES;

      const isBorder = ix === 0 || ix === MORPH_GRID - 1 || iz === 0 || iz === MORPH_GRID - 1;
      const y = isBorder ? evalPeriodicBorderCanopyY(tx, tz) : evalTussockCanopyY(tx, tz, varSpec, profile);

      const eps = 0.35;
      const yX1 = isBorder ? evalPeriodicBorderCanopyY(tx + eps, tz) : evalTussockCanopyY(clamp(tx + eps, 0, 4), tz, varSpec, profile);
      const yX0 = isBorder ? evalPeriodicBorderCanopyY(tx - eps, tz) : evalTussockCanopyY(clamp(tx - eps, 0, 4), tz, varSpec, profile);
      const yZ1 = isBorder ? evalPeriodicBorderCanopyY(tx, tz + eps) : evalTussockCanopyY(tx, clamp(tz + eps, 0, 4), varSpec, profile);
      const yZ0 = isBorder ? evalPeriodicBorderCanopyY(tx, tz - eps) : evalTussockCanopyY(tx, clamp(tz - eps, 0, 4), varSpec, profile);
      const gx = (yX1 - yX0) / (2 * eps);
      const gz = (yZ1 - yZ0) / (2 * eps);

      const alongVal = clamp(0.36 + (y - 0.10) * 1.6, 0.32, 0.68);
      const c = isBorder
        ? borderCol
        : [
            lerp(tileMeanCol[0], profile.tipCol[0], clamp((y - 0.12) * 3.5, 0, 0.65)),
            lerp(tileMeanCol[1], profile.tipCol[1], clamp((y - 0.12) * 3.5, 0, 0.65)),
            lerp(tileMeanCol[2], profile.tipCol[2], clamp((y - 0.12) * 3.5, 0, 0.65)),
          ];
      setV(vi, lx, y, lz, -gx, 1.0, -gz, c, alongVal);
    }
  }
  setV(BOT, 0.0, -0.055, 0.0, 0.0, -1.0, 0.0, profile.rootCol, 0.05);

  const faces = [];
  for (let iz = 0; iz < MORPH_GRID - 1; iz++) {
    for (let ix = 0; ix < MORPH_GRID - 1; ix++) {
      const v00 = iz * MORPH_GRID + ix;
      const v10 = v00 + 1;
      const v01 = v00 + MORPH_GRID;
      const v11 = v01 + 1;
      faces.push([v00, v01, v11]);
      faces.push([v00, v11, v10]);
    }
  }
  const perim = [0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5];
  for (let k = 0; k < perim.length; k++) {
    faces.push([perim[k], perim[(k + 1) % perim.length], BOT]);
  }

  const dirEdges = new Set();
  const undirEdges = new Set();
  for (let fi = 0; fi < faces.length; fi++) {
    const [a, b, c] = faces[fi];
    for (const [u, w] of [[a, b], [b, c], [c, a]]) {
      const key = `${u}->${w}`;
      if (dirEdges.has(key)) throw Error(`Duplicate directed half-edge ${key} in continuum`);
      dirEdges.add(key);
      undirEdges.add(u < w ? `${u}_${w}` : `${w}_${u}`);
    }
    const abx = pos[b * 3] - pos[a * 3], aby = pos[b * 3 + 1] - pos[a * 3 + 1], abz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const acx = pos[c * 3] - pos[a * 3], acy = pos[c * 3 + 1] - pos[a * 3 + 1], acz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const ny = abz * acx - abx * acz;
    if (fi < 32 && !(ny > 0)) throw Error(`Top canopy face ${fi} has non-upward normal ny=${ny}`);
    if (fi >= 32 && !(ny < 0)) throw Error(`Bottom cap face ${fi} has non-downward normal ny=${ny}`);
  }
  for (const key of dirEdges) {
    const [u, w] = key.split('->');
    if (!dirEdges.has(`${w}->${u}`)) throw Error(`Unpaired boundary half-edge ${key} in continuum`);
  }
  const euler = V - undirEdges.size + faces.length;
  if (euler !== 2) throw Error(`Genus-0 meadow continuum Euler=${euler}, expected 2`);

  const retireOrder = [
    { v: 6, target: 12 },
    { v: 8, target: 12 },
    { v: 16, target: 12 },
    { v: 18, target: 12 },
    { v: 7, target: 12 },
    { v: 11, target: 12 },
    { v: 13, target: 12 },
    { v: 17, target: 12 },
    { v: 12, target: 0 },
    { v: 1, target: 0 },
    { v: 21, target: 20 },
    { v: 3, target: 4 },
    { v: 23, target: 24 },
    { v: 5, target: 0 },
    { v: 9, target: 4 },
    { v: 15, target: 20 },
    { v: 19, target: 24 },
    { v: 2, target: 0 },
    { v: 22, target: 20 },
    { v: 10, target: 0 },
    { v: 14, target: 4 },
  ];

  const states = [Uint8Array.from({ length: V }, (_, i) => i)];
  const activeFaces = faces.map((f) => [...f]);
  const remap = new Int32Array(V);
  for (let i = 0; i < V; i++) remap[i] = i;

  const collapseSteps = [];
  for (let step = 0; step < MORPH_STEPS; step++) {
    const { v, target } = retireOrder[step];
    let dst = target;
    while (remap[dst] !== dst) dst = remap[dst];
    remap[v] = dst;
    for (let i = 0; i < V; i++) {
      let r = remap[i];
      while (remap[r] !== r) r = remap[r];
      remap[i] = r;
    }
    states.push(Uint8Array.from(remap));
    for (let f = 0; f < activeFaces.length; f++) {
      const tri = activeFaces[f];
      if (!tri) continue;
      for (let j = 0; j < 3; j++) tri[j] = remap[tri[j]];
      if (tri[0] === tri[1] || tri[1] === tri[2] || tri[2] === tri[0]) activeFaces[f] = null;
    }
    const err = +((0.18 + ((step + 1) / MORPH_STEPS) * 0.42).toFixed(4));
    collapseSteps.push({ retired: v, dst, err, aliveTris: activeFaces.filter(Boolean).length });
  }

  const coreTriCount = activeFaces.filter(Boolean).length;
  if (coreTriCount !== 6) throw Error(`Expected 6 full-square core triangles, got ${coreTriCount}`);

  const remapWords = new Uint32Array(MORPH_REMAP_WORDS);
  for (let s = 0; s < MORPH_STEPS; s++) {
    const st0 = states[s];
    const st1 = states[s + 1];
    for (let vi = 0; vi < V; vi++) {
      const e = s * V + vi;
      const wIdx = e >>> 1;
      const shift = (e & 1) * 16;
      const pair16 = (st0[vi] & 0xff) | ((st1[vi] & 0xff) << 8);
      remapWords[wIdx] = (remapWords[wIdx] | (pair16 << shift)) >>> 0;
    }
  }

  return {
    vertexCount: V,
    faceCount: faces.length,
    euler,
    coreTriCount,
    pos,
    nrm,
    col,
    sway,
    faces,
    collapseSteps,
    remapWords,
    splat: {
      centreY: +(profile.canopyBaseY * 0.55).toFixed(4),
      rx: +(MORPH_HALF_M * 0.98).toFixed(4),
      ry: +(Math.min(0.14, profile.canopyBaseY * 0.72)).toFixed(4),
      meanCol: tileMeanCol.map((c) => +c.toFixed(4)),
    },
  };
}

function measureBotanicalVariantProfile(srcVerts, srcIndices, varSpec, mixIdx, vIdx) {
  const startI = varSpec.firstIndex;
  const endI = startI + varSpec.indexCount;
  let rootR = 0, rootG = 0, rootB = 0, rootN = 0;
  let midR = 0, midG = 0, midB = 0, midN = 0;
  let tipR = 0, tipG = 0, tipB = 0, tipN = 0;
  let stiffSum = 0, nSamples = 0;

  // Quantize per-mix profile colors so shared border plants & micro-tufts share exact packedCol across variants!
  const step = Math.max(3, Math.floor((endI - startI) / 2400) * 3);
  for (let ii = startI; ii < endI; ii += step) {
    const s = srcIndices[ii] * SOURCE_STRIDE;
    const cr = srcVerts[s + 6], cg = srcVerts[s + 7], cb = srcVerts[s + 8];
    const along = srcVerts[s + 9];
    const stiff = clamp(srcVerts[s + 10], 1.5, 45.0);
    stiffSum += stiff;
    nSamples++;
    if (along < 0.25) {
      rootR += cr; rootG += cg; rootB += cb; rootN++;
    } else if (along < 0.70) {
      midR += cr; midG += cg; midB += cb; midN++;
    } else {
      tipR += cr; tipG += cg; tipB += cb; tipN++;
    }
  }

  const sc = CANOPY_ALBEDO_SCALE;
  const rootCol = [[0.070, 0.088, 0.040], [0.076, 0.086, 0.042], [0.072, 0.090, 0.041]][mixIdx];
  const midCol = [[0.096, 0.120, 0.054], [0.106, 0.118, 0.054], [0.102, 0.122, 0.055]][mixIdx];
  const tipCol = tipN > 0
    ? [clamp((tipR / tipN) * sc * 1.08, 0.048, 0.22), clamp((tipG / tipN) * sc * 1.06, 0.060, 0.24), clamp((tipB / tipN) * sc, 0.022, 0.12)]
    : [0.128, 0.146, 0.066];

  const strawCol = [0.158, 0.148, 0.072];
  const turfHeight = [0.22, 0.25, 0.27][mixIdx];
  const canopyBaseY = [0.135, 0.150, 0.162][mixIdx];
  const variantId = mixIdx * VARIANTS + vIdx;

  return {
    variantId,
    turfHeight,
    canopyBaseY,
    stiffness: [10.0, 11.0, 10.5][mixIdx],
    rootCol,
    midCol,
    tipCol: [[0.126, 0.146, 0.064], [0.138, 0.144, 0.066], [0.134, 0.148, 0.065]][mixIdx],
    rawTipCol: tipCol,
    strawCol,
  };
}

function main() {
  const srcManifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'manifest.json'), 'utf8'));
  const vb = zlib.gunzipSync(fs.readFileSync(path.join(SRC_DIR, 'vertices.bin.gz')));
  const ib = zlib.gunzipSync(fs.readFileSync(path.join(SRC_DIR, 'indices.bin.gz')));
  const srcVerts = new Float32Array(vb.buffer, vb.byteOffset, vb.byteLength / 4);
  const srcIndices = new Uint32Array(ib.buffer, ib.byteOffset, ib.byteLength / 4);

  const vertPool = createGlobalVertexPool();
  const outIndices = [];
  const clusterRecords = [];
  const variantRecords = [];
  const morphRecords = [];

  const half = TILE_METRES * 0.5;

  for (let mixIdx = 0; mixIdx < MIXES.length; mixIdx++) {
    const mixName = MIXES[mixIdx];
    const mixSpec = srcManifest.groves[mixName];
    for (let vIdx = 0; vIdx < VARIANTS; vIdx++) {
      const varSpec = mixSpec.variants[vIdx];
      const profile = measureBotanicalVariantProfile(srcVerts, srcIndices, varSpec, mixIdx, vIdx);
      const botBlades = extractBotanicalOrgans(srcVerts, srcIndices, varSpec, mixIdx, vIdx);
      const turfTufts = generateSupplementalTurfTufts(profile, mixIdx, vIdx);
      const variantId = profile.variantId;
      const clusterFirst = clusterRecords.length / CLUSTER_WORDS;
      let l0MeanCol = profile.midCol;

      for (let lvl = 0; lvl < 4; lvl++) {
        const firstIdx = outIndices.length;
        const geo = buildBotanicalMeadowLevel(vertPool, outIndices, botBlades, turfTufts, profile, lvl);
        if (lvl === 0) l0MeanCol = geo.meanCol;
        clusterRecords.push(
          firstIdx,
          geo.idxCount,
          lvl,
          LEVEL_PARENT_ERRORS[lvl],
          LEVEL_ERRORS[lvl],
          half,
          geo.maxY * 0.45,
          half,
          Math.hypot(MORPH_HALF_M * Math.SQRT2, geo.maxY * 0.6),
          variantId,
          0,
          0,
        );
      }

      const cont = buildSculptedContinuumForVariant(varSpec, profile, l0MeanCol);
      morphRecords.push({ variantId, mix: mixName, variant: vIdx, ...cont });
      variantRecords.push({
        variantId,
        mix: mixName,
        variant: vIdx,
        firstCluster: clusterFirst,
        clusterCount: 4,
        genusZeroEuler: cont.euler,
        coreTriCount: cont.coreTriCount,
        meanColour: cont.splat.meanCol,
        splat: cont.splat,
      });
    }
  }

  const vertBytes = vertPool.toUint8Array();
  const idxBuf = new Uint32Array(outIndices);
  const clBuf = new ArrayBuffer(clusterRecords.length * 4);
  const cf32 = new Float32Array(clBuf), cu32 = new Uint32Array(clBuf);
  for (let i = 0; i < clusterRecords.length; i += CLUSTER_WORDS) {
    cu32[i] = clusterRecords[i] >>> 0;
    cu32[i + 1] = clusterRecords[i + 1] >>> 0;
    cu32[i + 2] = clusterRecords[i + 2] >>> 0;
    cf32[i + 3] = clusterRecords[i + 3];
    cf32[i + 4] = clusterRecords[i + 4];
    cf32[i + 5] = clusterRecords[i + 5];
    cf32[i + 6] = clusterRecords[i + 6];
    cf32[i + 7] = clusterRecords[i + 7];
    cf32[i + 8] = clusterRecords[i + 8];
    cu32[i + 9] = clusterRecords[i + 9] >>> 0;
    cu32[i + 10] = clusterRecords[i + 10] >>> 0;
    cu32[i + 11] = clusterRecords[i + 11] >>> 0;
  }

  const MORPH_VERT_FLOATS = 8;
  const perVarVertWords = MORPH_VERTS * MORPH_VERT_FLOATS; // 208
  const perVarFaceWords = MORPH_FACES * 3; // 144
  const perVarWords = perVarVertWords + perVarFaceWords + MORPH_REMAP_WORDS; // 628 words = 2512 bytes
  const perVarBytes = perVarWords * 4;
  const morphBuf = new ArrayBuffer(morphRecords.length * perVarBytes);
  const mf32 = new Float32Array(morphBuf), mu32 = new Uint32Array(morphBuf);
  for (let mIdx = 0; mIdx < morphRecords.length; mIdx++) {
    const mr = morphRecords[mIdx];
    const baseWord = mIdx * perVarWords;
    for (let vi = 0; vi < mr.vertexCount; vi++) {
      const vw = baseWord + vi * MORPH_VERT_FLOATS;
      mf32[vw] = mr.pos[vi * 3];
      mf32[vw + 1] = mr.pos[vi * 3 + 1];
      mf32[vw + 2] = mr.pos[vi * 3 + 2];
      mu32[vw + 3] = packSnorm8x4(mr.nrm[vi * 3], mr.nrm[vi * 3 + 1], mr.nrm[vi * 3 + 2], 1.0);
      mu32[vw + 4] = packColorUnorm8x4(mr.col[vi * 3], mr.col[vi * 3 + 1], mr.col[vi * 3 + 2], 1.0);
      mf32[vw + 5] = mr.sway[vi * 3];
      mf32[vw + 6] = mr.sway[vi * 3 + 1];
      mf32[vw + 7] = mr.sway[vi * 3 + 2];
    }
    const faceBaseWord = baseWord + perVarVertWords;
    for (let fi = 0; fi < mr.faceCount; fi++) {
      mu32[faceBaseWord + fi * 3] = mr.faces[fi][0];
      mu32[faceBaseWord + fi * 3 + 1] = mr.faces[fi][1];
      mu32[faceBaseWord + fi * 3 + 2] = mr.faces[fi][2];
    }
    const remapBaseWord = faceBaseWord + perVarFaceWords;
    mu32.set(mr.remapWords, remapBaseWord);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const filesMeta = {};
  const writeStream = (name, rawBuf) => {
    const raw = Buffer.from(rawBuf.buffer ?? rawBuf, rawBuf.byteOffset ?? 0, rawBuf.byteLength);
    const gz = zlib.gzipSync(raw, { level: 9 });
    fs.writeFileSync(path.join(OUT_DIR, `${name}.gz`), gz);
    filesMeta[name] = { bytes: raw.byteLength, gzipBytes: gz.byteLength, sha256: sha256Hex(raw) };
  };
  writeStream('vertices.bin', vertBytes);
  writeStream('indices.bin', idxBuf);
  writeStream('clusters.bin', new Uint8Array(clBuf));
  writeStream('morph.bin', new Uint8Array(morphBuf));

  const outManifest = {
    format: 'waterworld.meadow-grass-gpu',
    version: 2,
    style: 'botanical-tussock-continuum',
    tileMetres: TILE_METRES,
    mixes: MIXES,
    variants: VARIANTS,
    subGrid: SUB_GRID,
    levels: 4,
    levelErrors: LEVEL_ERRORS,
    levelParentErrors: LEVEL_PARENT_ERRORS,
    strideBytes: GPU_VERTEX_WORDS * 4,
    clusterRecordWords: CLUSTER_WORDS,
    morph: {
      gridSide: MORPH_GRID,
      vertexCount: MORPH_VERTS,
      faceCount: MORPH_FACES,
      steps: MORPH_STEPS,
      ancestorTableOffsetWords: perVarVertWords + perVarFaceWords,
      ancestorTableWords: MORPH_REMAP_WORDS,
      ancestorEncoding: 'u8x4-v0v1-pairs',
      bytesPerVariant: perVarBytes,
    },
    vertexCount: vertPool.count,
    triangleCount: outIndices.length / 3,
    clusterCount: clusterRecords.length / CLUSTER_WORDS,
    variantRecords,
    files: filesMeta,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(outManifest, null, 2));
  const totalGz = Object.values(filesMeta).reduce((s, f) => s + f.gzipBytes, 0);
  console.log(`Baked meadows-gpu (botanical-tussock-continuum): ${outManifest.vertexCount} verts, ${outManifest.triangleCount} tris, ${outManifest.clusterCount} clusters, ${(totalGz / 1024).toFixed(1)} KB gz total`);
}

main();
