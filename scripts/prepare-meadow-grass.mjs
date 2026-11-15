#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes GPU-resident 4-level Lush Botanical Meadow Grass Continuum on seamless 1.75 m x 1.75 m tiles (3.0625 m^2):
//   - L0..L3 (~4,200 -> 2,100 -> 950 -> 380 tris, ~1,370 tris/m^2 at LOD0):
//     1. Arched Multi-Segment Ryegrass, Cocksfoot & Fescue Sheaves (70%): 3-segment (5-tri, 7-vert) curved blades
//        (14-38 cm tall, 1.1-2.2 cm basal width tapering to a fine tip, parabolic droop along^1.7, V-camber normals)
//        in toroidal-Poisson organic tussock clumps (3-7 blades at asymmetric azimuths, zero 6-spoke pinwheels).
//     2. Low Basal Turf / Clover / Ribwort Ground-Huggers (20%): dense broad low-arching basal leaf tufts (5-11 cm)
//        carpeting inter-tussock gaps for >80% oblique turf fullness with zero synthetic flat floor sheet.
//     3. Tall Sunlit Oat / Wild Barley Panicles & Coastal Wildflowers (10%): 38-58 cm curved culms with 3D cross-vaned
//        golden-straw seed heads (along > 0.78) + subtle 3D concave chamomile, mallow, hawkbit & poppy blossoms.
//   - Continuum (morph.bin): closed genus-0 (Euler = 2) D4-symmetric periodic sculpted tussock canopy
//     [-0.892, +0.892]^2 + 1 underground pole (V=26, E=72, F=48 -> coreTriCount=6) + O(1) u8x4 ancestor lookup table.
//   - Horizon splats: 1-triangle view-facing silhouette splat metadata per variant.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SRC_DIR = 'assets/ground-cover/portugal/meadows';
const OUT_DIR = 'assets/ground-cover/portugal/meadows-gpu';
const MIXES = ['pasture', 'waste', 'field-margin'];
const VARIANTS = 4;
const TILE_METRES = 1.75;
const SUB_GRID = 1;
const SOURCE_STRIDE = 12; // pos(3), nrm(3), linearSrgbCol(3), along(1), stiffness(1), anchor(1)
const GPU_VERTEX_WORDS = 8; // px, py, pz, packedNorm+wTag, packedCol+tuftRand, along, stiffness, packedMorphXZ(half2)
const CLUSTER_WORDS = 12;

// Screen-space error thresholds on 1.75 m tiles (allowedErr = dist / focal):
// L0 holds 100% density inside ~20 m, then retires smoothly:
// L0 (<~28.5 m), L1 (~28.5..49 m), L2 (~49..72 m), L3 (~72..86 m) -> MSAA sample_mask handoff -> morph.bin -> splat
const LEVEL_ERRORS = [0.0, 0.030, 0.052, 0.076];
const LEVEL_PARENT_ERRORS = [0.030, 0.052, 0.076, 0.104];

// Sculpted 5x5 tussock canopy [-0.892, +0.892]^2 + 1 underground pole = 26 verts, 48 faces, 72 edges -> V - E + F = 2!
const MORPH_GRID = 5;
const MORPH_VERTS = MORPH_GRID * MORPH_GRID + 1; // 26
const MORPH_FACES = (MORPH_GRID - 1) * (MORPH_GRID - 1) * 2 + (MORPH_GRID - 1) * 4; // 32 top + 16 bottom = 48
const MORPH_STEPS = 21; // 26 -> 5 core verts = 6 core tris (2 top square + 4 back-culled bottom)
const MORPH_HALF_M = TILE_METRES * 0.5 + 0.017; // 0.892 m (1.7 cm seam weld across 1.75 m lattice)
const MORPH_REMAP_WORDS = Math.ceil((MORPH_STEPS * MORPH_VERTS) / 2 / 4) * 4; // 276 u32 words (u8x4 (v0,v1) pairs)

// Calibrated linear-sRGB reflectance scale for single botanical leaves into sunlit Mediterranean meadow domain
const BOTANICAL_ALBEDO_SCALE = 0.46;
const GOLDEN_ANGLE = 2.399963229728653;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const qPos = (v) => Math.round(v * 512) / 512; // 1.95 mm spatial precision + clean mantissa zeros for gzip
const qAttr = (v) => Math.round(v * 64) / 64;
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

function wrapTile(v) {
  const m = v % TILE_METRES;
  return m < 0 ? m + TILE_METRES : m;
}

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

function toroidalDistSq(ax, az, bx, bz) {
  let dx = Math.abs(ax - bx);
  let dz = Math.abs(az - bz);
  if (dx > TILE_METRES * 0.5) dx = TILE_METRES - dx;
  if (dz > TILE_METRES * 0.5) dz = TILE_METRES - dz;
  return dx * dx + dz * dz;
}

// Deterministic toroidal Poisson dart-throwing inside [margin, TILE_METRES - margin)^2
// so tussocks have organic spacing with zero grid rows and uniform density right across tile seams.
function sampleToroidalPoisson(seed, targetCount, minDist, existing = [], repelDist = 0, margin = 0.035) {
  const pts = [];
  const span = TILE_METRES - 2 * margin;
  let curMinSq = minDist * minDist;
  const repelSq = repelDist * repelDist;
  let cursor = 0;

  for (let pass = 0; pass < 4 && pts.length < targetCount; pass++) {
    const maxAttempts = targetCount * 36;
    for (let att = 0; att < maxAttempts && pts.length < targetCount; att++) {
      const x = margin + hash01(seed, cursor++) * span;
      const z = margin + hash01(seed, cursor++) * span;
      let ok = true;
      if (repelSq > 0) {
        for (let i = 0; i < existing.length; i++) {
          if (toroidalDistSq(x, z, existing[i].x, existing[i].z) < repelSq) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        for (let i = 0; i < pts.length; i++) {
          if (toroidalDistSq(x, z, pts[i].x, pts[i].z) < curMinSq) {
            ok = false;
            break;
          }
        }
      }
      if (ok) pts.push({ x, z, seed: hashCoordSeed(seed, pts.length + 1, cursor) });
    }
    curMinSq *= 0.72;
  }
  return pts;
}

function createGlobalVertexPool() {
  const words = [];
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

// Extracts real 3-segment curved botanical specimen leaves & culm-panicles from the Portuguese meadow source stream,
// re-rooted toroidally into [0.05, TILE_METRES - 0.05]^2 at exact 1:1 physical metric organ dimensions!
function extractSpecimenTemplates(srcVerts, srcIndices, varSpec, mixIdx, vIdx) {
  const leafSpecimens = [];
  const culmSpecimens = [];

  for (let ci = 0; ci < varSpec.clumps.length; ci++) {
    const c = varSpec.clumps[ci];
    const rx0 = c.root[0], rz0 = c.root[1];
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

    for (const [r, vs] of compVerts) {
      const tCnt = compTris.get(r) || 0;
      const nv = vs.length;

      // V-folded botanical grass leaf (nv = 3*K + 1, K >= 4): preserve 3-segment (4-station) real arch curve!
      if (nv >= 13 && nv <= 25 && (nv - 1) % 3 === 0 && tCnt === ((nv - 1) / 3) * 4 - 2) {
        const K = (nv - 1) / 3;
        const oTip = vs[nv - 1] * SOURCE_STRIDE;
        const oBase = vs[1] * SOURCE_STRIDE;
        const span = Math.hypot(
          srcVerts[oTip] - srcVerts[oBase],
          srcVerts[oTip + 1] - srcVerts[oBase + 1],
          srcVerts[oTip + 2] - srcVerts[oBase + 2],
        );
        if (span < 0.11 || span > 0.44 || srcVerts[oTip + 1] < 0.08) continue;

        const r1 = Math.max(1, Math.min(K - 2, Math.round(K * 0.34)));
        const r2 = Math.max(r1 + 1, Math.min(K - 1, Math.round(K * 0.68)));
        const rowIds = [0, r1, r2];
        const relPts = [];
        for (let si = 0; si < 3; si++) {
          const rk = rowIds[si];
          const oL = vs[rk * 3] * SOURCE_STRIDE;
          const oM = vs[rk * 3 + 1] * SOURCE_STRIDE;
          const oR = vs[rk * 3 + 2] * SOURCE_STRIDE;
          let sx = srcVerts[oR] - srcVerts[oL];
          let sz = srcVerts[oR + 2] - srcVerts[oL + 2];
          const w = Math.hypot(sx, srcVerts[oR + 1] - srcVerts[oL + 1], sz);
          const hl = Math.hypot(sx, sz);
          if (hl > 1e-5) { sx /= hl; sz /= hl; } else { sx = 1; sz = 0; }
          const baseHW = clamp(w * 0.85, 0.0058, 0.0112) * [1.0, 0.88, 0.54][si];
          relPts.push({
            dx: srcVerts[oM] - rx0,
            y: si === 0 ? -0.005 : Math.max(0.02, srcVerts[oM + 1]),
            dz: srcVerts[oM + 2] - rz0,
            sx,
            sz,
            hw: baseHW,
            col: [
              clamp(srcVerts[oM + 6] * BOTANICAL_ALBEDO_SCALE, 0.032, 0.18),
              clamp(srcVerts[oM + 7] * BOTANICAL_ALBEDO_SCALE * 1.12, 0.068, 0.22),
              clamp(srcVerts[oM + 8] * BOTANICAL_ALBEDO_SCALE * 0.82, 0.018, 0.09),
            ],
            along: [0.02, 0.26, 0.52][si],
          });
        }
        relPts.push({
          dx: srcVerts[oTip] - rx0,
          y: Math.max(0.06, srcVerts[oTip + 1]),
          dz: srcVerts[oTip + 2] - rz0,
          sx: relPts[2].sx,
          sz: relPts[2].sz,
          hw: 0,
          col: [
            clamp(srcVerts[oTip + 6] * BOTANICAL_ALBEDO_SCALE * 1.08, 0.045, 0.20),
            clamp(srcVerts[oTip + 7] * BOTANICAL_ALBEDO_SCALE * 1.15, 0.085, 0.24),
            clamp(srcVerts[oTip + 8] * BOTANICAL_ALBEDO_SCALE * 0.85, 0.022, 0.10),
          ],
          along: 0.76,
        });
        leafSpecimens.push({
          species: c.species,
          span,
          stiff: clamp(srcVerts[oBase + 10], 5.5, 14.5),
          relPts,
        });
        if (leafSpecimens.length >= 96) break;
      }

      // 3-sided hollow culm (Avena sterilis / Bromus diandrus)
      if (nv >= 12 && nv <= 30 && nv % 3 === 0 && tCnt === (nv / 3 - 1) * 6 && culmSpecimens.length < 32) {
        const K = nv / 3;
        const ring = (rk) => {
          const a = vs[rk * 3] * SOURCE_STRIDE, b = vs[rk * 3 + 1] * SOURCE_STRIDE, d = vs[rk * 3 + 2] * SOURCE_STRIDE;
          return {
            dx: (srcVerts[a] + srcVerts[b] + srcVerts[d]) / 3 - rx0,
            y: (srcVerts[a + 1] + srcVerts[b + 1] + srcVerts[d + 1]) / 3,
            dz: (srcVerts[a + 2] + srcVerts[b + 2] + srcVerts[d + 2]) / 3 - rz0,
            stiff: clamp(srcVerts[a + 10], 6.0, 15.0),
          };
        };
        const p0 = ring(0), pTop = ring(K - 1);
        if (pTop.y - p0.y > 0.26) {
          culmSpecimens.push({
            reachX: pTop.dx - p0.dx,
            reachZ: pTop.dz - p0.dz,
            height: clamp(pTop.y, 0.38, 0.58),
            stiff: p0.stiff,
          });
        }
      }
    }
  }

  return { leafSpecimens, culmSpecimens, mixIdx, vIdx };
}

// Evaluates parabolic droop curve y(s) = hPeak * (s - droop * s^1.7) / peakNorm with exact peak = hPeak.
function evalBladeCurve(s, hPeak, droop) {
  // Derivative 1 - 1.7 * droop * s^0.7 = 0 => sCrit = (1 / (1.7 * droop))^(1 / 0.7)
  const denom = 1.7 * droop;
  const sCrit = denom > 1.0 ? Math.min(1.0, Math.pow(1.0 / denom, 1.0 / 0.7)) : 1.0;
  const peakNorm = Math.max(0.18, sCrit - droop * Math.pow(sCrit, 1.7));
  return hPeak * ((s - droop * Math.pow(s, 1.7)) / peakNorm);
}

// Generates the 3-stratum Mediterranean meadow sward on [0, 1.75 m)^2:
//   1. Tussock Sheaves (70%): 118 organic Poisson tussock clumps -> 588 curved 3-segment (5-tri, 7-vert) blades (~2,940 tris)
//   2. Basal Ground-Huggers (20%): 94 interstitial tufts -> 282 broad arched low leaves (3-tri each -> 846 tris)
//   3. Tall Golden Oat/Barley Panicles & Coastal Wildflowers (10%): 48 panicles (7-tri) + 12 wildflowers (7-tri) (420 tris)
function generateBotanicalSward(profile, specimens, mixIdx, vIdx) {
  // Two rich Poisson layout banks per mix + per-variant organic wildflowers/panicles -> compact gzip + zero repetition
  const bankId = vIdx & 1;
  const baseSeed = hashCoordSeed(4099 + mixIdx * 31, bankId + 1, 17);
  const varSeed = hashCoordSeed(8191 + mixIdx * 53, vIdx + 1, 29);

  // --- STRATUM 1: 124 Toroidal-Poisson Ryegrass, Cocksfoot & Fescue Tussocks (624 x 5-tri curved blades = 3,120 tris) ---
  const tussockCenters = sampleToroidalPoisson(baseSeed, 124, 0.118, [], 0, 0.04);
  const tussockBlades = [];

  // Assign 3..7 blades per tussock summing to exactly 624 blades
  const counts = tussockCenters.map((tc) => {
    const r = hash01(tc.seed, 1);
    return r < 0.12 ? 3 : r < 0.34 ? 4 : r < 0.64 ? 5 : r < 0.86 ? 6 : 7;
  });
  let bladeSum = counts.reduce((a, b) => a + b, 0);
  let adjustCursor = 0;
  while (bladeSum > 624) {
    const ti = adjustCursor++ % counts.length;
    if (counts[ti] > 3) { counts[ti]--; bladeSum--; }
  }
  while (bladeSum < 624) {
    const ti = adjustCursor++ % counts.length;
    if (counts[ti] < 7) { counts[ti]++; bladeSum++; }
  }

  for (let ti = 0; ti < tussockCenters.length; ti++) {
    const tc = tussockCenters[ti];
    const cSeed = tc.seed;
    const tuftRand = clamp(0.06 + 0.88 * hash01(cSeed, 2), 0.06, 0.94);
    const vigor = 0.78 + 0.44 * hash01(cSeed, 3);
    const leanAz = hash01(cSeed, 4) * Math.PI * 2;
    const leanStrength = 0.015 + 0.035 * hash01(cSeed, 5);
    const clumpHue = hash01(cSeed, 6);
    const clumpStraw = hash01(cSeed, 7) > 0.74 ? 0.42 + 0.38 * hash01(cSeed, 8) : 0.14 * hash01(cSeed, 8);
    const nBlades = counts[ti];
    const baseAz0 = hash01(cSeed, 9) * Math.PI * 2;

    for (let bi = 0; bi < nBlades; bi++) {
      const bSeed = hashCoordSeed(cSeed, bi + 1, 13);
      // Asymmetric golden-angle + strong angular jitter -> natural organic tussock sheaf, NEVER a 6-spoke pinwheel!
      const az = baseAz0 + bi * GOLDEN_ANGLE + (hash01(bSeed, 1) - 0.5) * 0.76;
      const dirX = Math.cos(az), dirZ = Math.sin(az);
      const sideX = -dirZ, sideZ = dirX;

      const crownOff = 0.010 + 0.032 * hash01(bSeed, 2);
      const bx0 = tc.x + dirX * crownOff;
      const bz0 = tc.z + dirZ * crownOff;

      // 16-38 cm tall curved blades with 1.4-2.2 cm basal width (hw0 = 0.0070..0.0110 m)
      const hPeak = clamp(profile.sheafHeight * vigor * (0.76 + 0.56 * hash01(bSeed, 3)), 0.16, 0.38);
      const hw0 = 0.0070 + 0.0040 * hash01(bSeed, 4); // 1.4 cm to 2.2 cm full basal width
      const reach = (0.16 + 0.19 * hash01(bSeed, 5)) * clamp(vigor, 0.88, 1.20);
      const droop = 0.32 + 0.34 * hash01(bSeed, 6);
      const curlLat = (hash01(bSeed, 7) - 0.5) * 0.056;
      const stiff = profile.stiffness * (0.76 + 0.42 * hash01(bSeed, 8));

      // Blend 25% real extracted specimen arch displacements when available for extra botanical irregularity
      const useSpec = specimens.leafSpecimens.length > 0 && hash01(bSeed, 9) < 0.28;
      const spec = useSpec
        ? specimens.leafSpecimens[(ti * 7 + bi) % specimens.leafSpecimens.length]
        : null;

      const strawMix = clamp(clumpStraw + 0.18 * hash01(bSeed, 10), 0, 0.82);
      const hueScale = 0.88 + 0.24 * clumpHue;
      const cBase = [
        clamp(lerp(profile.rootCol[0], profile.strawCol[0], strawMix * 0.28) * hueScale, 0.025, 0.16),
        clamp(lerp(profile.rootCol[1], profile.strawCol[1], strawMix * 0.24) * hueScale, 0.048, 0.18),
        clamp(lerp(profile.rootCol[2], profile.strawCol[2], strawMix * 0.28), 0.016, 0.08),
      ];
      const cMid1 = [
        clamp(lerp(profile.midCol[0], profile.strawCol[0], strawMix * 0.42) * hueScale, 0.032, 0.19),
        clamp(lerp(profile.midCol[1], profile.strawCol[1], strawMix * 0.36) * hueScale, 0.072, 0.22),
        clamp(lerp(profile.midCol[2], profile.strawCol[2], strawMix * 0.42), 0.020, 0.09),
      ];
      const cMid2 = [
        clamp(lerp(profile.upperCol[0], profile.strawCol[0], strawMix * 0.58) * hueScale, 0.040, 0.21),
        clamp(lerp(profile.upperCol[1], profile.strawCol[1], strawMix * 0.50) * hueScale, 0.085, 0.24),
        clamp(lerp(profile.upperCol[2], profile.strawCol[2], strawMix * 0.56), 0.022, 0.10),
      ];
      const cTip = [
        clamp(lerp(profile.tipCol[0], profile.strawCol[0], strawMix * 0.74) * hueScale, 0.048, 0.23),
        clamp(lerp(profile.tipCol[1], profile.strawCol[1], strawMix * 0.66) * hueScale, 0.095, 0.25),
        clamp(lerp(profile.tipCol[2], profile.strawCol[2], strawMix * 0.70), 0.024, 0.11),
      ];

      const stations = [0.0, 0.34, 0.68, 1.0];
      const hwScale = [1.0, 0.92, 0.60, 0.0];
      const alongVals = [0.02, 0.26, 0.52, 0.76];
      const cols = [cBase, cMid1, cMid2, cTip];
      const pts = [];

      for (let si = 0; si < 4; si++) {
        const s = stations[si];
        const rDist = reach * (0.58 * s + 0.42 * Math.pow(s, 1.35));
        const latOff = curlLat * Math.pow(s, 1.6);
        const leanX = Math.cos(leanAz) * leanStrength * s;
        const leanZ = Math.sin(leanAz) * leanStrength * s;
        let px = bx0 + dirX * rDist + sideX * latOff + leanX;
        let py = si === 0 ? -0.006 : evalBladeCurve(s, hPeak, droop);
        let pz = bz0 + dirZ * rDist + sideZ * latOff + leanZ;
        if (spec) {
          const sp = spec.relPts[si];
          // Rotate extracted specimen delta slightly by az for variety while keeping 1:1 metric proportions
          const ca = Math.cos(az * 0.5), sa = Math.sin(az * 0.5);
          const sdx = sp.dx * ca - sp.dz * sa;
          const sdz = sp.dx * sa + sp.dz * ca;
          px = lerp(px, tc.x + sdx, 0.35);
          py = si === 0 ? -0.006 : lerp(py, sp.y, 0.35);
          pz = lerp(pz, tc.z + sdz, 0.35);
        }
        // Slight azimuthal twist of lateral axis along the curved blade
        const twistAz = az + curlLat * 2.4 * s;
        pts.push({
          x: px,
          y: py,
          z: pz,
          sx: -Math.sin(twistAz),
          sz: Math.cos(twistAz),
          hw: hw0 * hwScale[si],
          col: cols[si],
          along: alongVals[si],
        });
      }

      tussockBlades.push({
        rootX: tc.x,
        rootZ: tc.z,
        tuftRand,
        stiff,
        hPeak,
        hw0,
        pts,
        retirePhase: Math.round(hash01(bSeed, 15) * 7) / 7,
        // Rank by botanical stature (height * width + primary sheaf bonus) so retirement thins fine inner blades first!
        score: hPeak * 2.1 + hw0 * 38.0 + (bi < 2 ? 0.38 : 0.0) + hash01(bSeed, 16) * 0.22,
      });
    }
  }
  tussockBlades.sort((a, b) => b.score - a.score);

  // --- STRATUM 2: 98 Interstitial Low Basal Turf / Clover / Ribwort Ground-Hugger Tufts (98 x 9 = 882 tris) ---
  const huggerCenters = sampleToroidalPoisson(
    hashCoordSeed(baseSeed, 77, 3),
    98,
    0.114,
    tussockCenters,
    0.052,
    0.04,
  );
  const huggerTufts = [];
  for (let hi = 0; hi < huggerCenters.length; hi++) {
    const hc = huggerCenters[hi];
    const hSeed = hc.seed;
    const tuftRand = clamp(0.05 + 0.89 * hash01(hSeed, 1), 0.05, 0.94);
    const stiff = profile.stiffness * 1.18;
    const baseAz = hash01(hSeed, 2) * Math.PI * 2;
    const hueJit = 0.90 + 0.20 * hash01(hSeed, 3);
    const leaves = [];

    for (let li = 0; li < 3; li++) {
      const lSeed = hashCoordSeed(hSeed, li + 1, 19);
      const az = baseAz + li * GOLDEN_ANGLE + (hash01(lSeed, 1) - 0.5) * 0.65;
      const dirX = Math.cos(az), dirZ = Math.sin(az);
      const sideX = -dirZ, sideZ = dirX;
      // 5-11 cm tall broad arching basal rosettes/clover mats carpeting the root zone!
      const hArch = 0.055 + 0.055 * hash01(lSeed, 2);
      const reach = 0.155 + 0.115 * hash01(lSeed, 3);
      const hwBase = 0.016 + 0.009 * hash01(lSeed, 4); // 3.2-5.0 cm basal tuft cluster attachment
      const hwMid = 0.028 + 0.015 * hash01(lSeed, 5);  // 5.6-8.6 cm broad overlapping clover/ribwort pad

      const c0 = [
        clamp(profile.rootCol[0] * 0.95 * hueJit, 0.022, 0.14),
        clamp(profile.rootCol[1] * 1.06 * hueJit, 0.050, 0.18),
        clamp(profile.rootCol[2] * 0.92, 0.015, 0.07),
      ];
      const c1 = [
        clamp(profile.huggerCol[0] * hueJit, 0.028, 0.16),
        clamp(profile.huggerCol[1] * hueJit, 0.068, 0.20),
        clamp(profile.huggerCol[2], 0.018, 0.08),
      ];
      const c2 = [
        clamp(profile.midCol[0] * 1.04 * hueJit, 0.034, 0.18),
        clamp(profile.midCol[1] * 1.08 * hueJit, 0.078, 0.22),
        clamp(profile.midCol[2], 0.020, 0.09),
      ];

      leaves.push({
        pts: [
          { x: hc.x + dirX * 0.008, y: -0.005, z: hc.z + dirZ * 0.008, sx: sideX, sz: sideZ, hw: hwBase, col: c0, along: 0.02 },
          { x: hc.x + dirX * reach * 0.54, y: hArch, z: hc.z + dirZ * reach * 0.54, sx: sideX, sz: sideZ, hw: hwMid, col: c1, along: 0.24 },
          { x: hc.x + dirX * reach, y: hArch * 0.58, z: hc.z + dirZ * reach, sx: sideX, sz: sideZ, hw: 0, col: c2, along: 0.44 },
        ],
        retirePhase: Math.round(hash01(lSeed, 9) * 7) / 7,
      });
    }
    huggerTufts.push({
      rootX: hc.x,
      rootZ: hc.z,
      tuftRand,
      stiff,
      leaves,
      score: 0.35 + hash01(hSeed, 11) * 0.65,
    });
  }
  huggerTufts.sort((a, b) => b.score - a.score);

  // --- STRATUM 3A: 48 Tall Sunlit Oat / Wild Barley Culms & Panicle Seed Heads (48 x 7 = 336 tris) ---
  const panicleCenters = sampleToroidalPoisson(varSeed, 48, 0.185, [], 0, 0.05);
  const panicles = [];
  for (let pi = 0; pi < panicleCenters.length; pi++) {
    const pc = panicleCenters[pi];
    const pSeed = pc.seed;
    const tuftRand = clamp(0.08 + 0.84 * hash01(pSeed, 1), 0.08, 0.92);
    const az = hash01(pSeed, 2) * Math.PI * 2;
    const dirX = Math.cos(az), dirZ = Math.sin(az);
    const sideX = -dirZ, sideZ = dirX;

    // 38-58 cm tall slender culms topped with golden-straw oat/barley seed panicles!
    const specCulm = specimens.culmSpecimens.length > 0
      ? specimens.culmSpecimens[pi % specimens.culmSpecimens.length]
      : null;
    const hTop = clamp(
      specCulm ? lerp(0.40 + 0.18 * hash01(pSeed, 3), specCulm.height, 0.45) : (0.38 + 0.20 * hash01(pSeed, 3)),
      0.38,
      0.58,
    );
    const reach = 0.11 + 0.15 * hash01(pSeed, 4);
    const droop = 0.24 + 0.24 * hash01(pSeed, 5);
    const stiff = clamp((specCulm ? specCulm.stiff : 8.2) * (0.82 + 0.32 * hash01(pSeed, 6)), 5.8, 13.5);
    const headHW = 0.0095 + 0.0055 * hash01(pSeed, 7); // 1.9-3.0 cm feathery golden spikelet plume

    const cStem0 = profile.rootCol;
    const cStem1 = [
      lerp(profile.midCol[0], profile.oatGoldCol[0], 0.28),
      lerp(profile.midCol[1], profile.oatGoldCol[1], 0.24),
      lerp(profile.midCol[2], profile.oatGoldCol[2], 0.25),
    ];
    const cHeadBase = [
      lerp(profile.tipCol[0], profile.oatGoldCol[0], 0.76),
      lerp(profile.tipCol[1], profile.oatGoldCol[1], 0.74),
      lerp(profile.tipCol[2], profile.oatGoldCol[2], 0.72),
    ];
    const cHeadTip = [
      clamp(profile.oatGoldCol[0] * (0.94 + 0.14 * hash01(pSeed, 8)), 0.14, 0.24),
      clamp(profile.oatGoldCol[1] * (0.94 + 0.14 * hash01(pSeed, 8)), 0.12, 0.21),
      clamp(profile.oatGoldCol[2], 0.042, 0.09),
    ];

    const sArr = [0.0, 0.38, 0.74, 1.0];
    const hwArr = [0.0034, 0.0028, headHW * 0.78, 0.0];
    const alArr = [0.04, 0.42, 0.82, 1.00]; // along > 0.78 marks sunlit golden oat seed-heads!
    const colArr = [cStem0, cStem1, cHeadBase, cHeadTip];
    const pts = sArr.map((s, si) => {
      const rDist = reach * (0.52 * s + 0.48 * Math.pow(s, 1.4));
      return {
        x: pc.x + dirX * rDist,
        y: si === 0 ? -0.006 : evalBladeCurve(s, hTop, droop),
        z: pc.z + dirZ * rDist,
        sx: sideX,
        sz: sideZ,
        hw: hwArr[si],
        col: colArr[si],
        along: alArr[si],
      };
    });

    panicles.push({
      rootX: pc.x,
      rootZ: pc.z,
      tuftRand,
      stiff,
      hTop,
      headHW,
      dirX,
      dirZ,
      pts,
      retirePhase: Math.round(hash01(pSeed, 12) * 7) / 7,
      score: hTop * 1.8 + headHW * 25.0 + hash01(pSeed, 13) * 0.35,
    });
  }
  panicles.sort((a, b) => b.score - a.score);

  // --- STRATUM 3B: 12 Subtle Coastal Wildflowers (Chamomile, Mallow, Hawkbit, Field Poppy; 12 x 7 = 84 tris) ---
  const flowerCenters = sampleToroidalPoisson(
    hashCoordSeed(varSeed, 313, 7),
    12,
    0.34,
    panicleCenters,
    0.10,
    0.08,
  );
  const wildflowers = [];
  for (let fi = 0; fi < flowerCenters.length; fi++) {
    const fc = flowerCenters[fi];
    const fSeed = fc.seed;
    const tuftRand = clamp(0.12 + 0.78 * hash01(fSeed, 1), 0.12, 0.90);
    const az = hash01(fSeed, 2) * Math.PI * 2;
    const dirX = Math.cos(az), dirZ = Math.sin(az);
    const sideX = -dirZ, sideZ = dirX;
    const hFlower = 0.22 + 0.17 * hash01(fSeed, 3);
    const lean = 0.04 + 0.07 * hash01(fSeed, 4);
    const corollaR = 0.011 + 0.0055 * hash01(fSeed, 5); // 2.2-3.3 cm subtle Mediterranean blossom
    const kindRoll = hash01(fSeed, 6);

    let petalCol, diskCol;
    if (mixIdx === 0) {
      // Pasture: coastal chamomile (ivory-white + golden disk) & wild rose mallow
      if (kindRoll < 0.74) {
        petalCol = [0.245, 0.232, 0.168];
        diskCol = [0.205, 0.142, 0.026];
      } else {
        petalCol = [0.182, 0.080, 0.146];
        diskCol = [0.125, 0.055, 0.095];
      }
    } else if (mixIdx === 1) {
      // Waste: golden hawkbit/mustard & chamomile
      if (kindRoll < 0.62) {
        petalCol = [0.218, 0.172, 0.032];
        diskCol = [0.175, 0.118, 0.020];
      } else {
        petalCol = [0.240, 0.226, 0.162];
        diskCol = [0.200, 0.138, 0.026];
      }
    } else {
      // Field-margin: chamomile, scarlet field poppy (Papaver rhoeas), and mallow
      if (kindRoll < 0.52) {
        petalCol = [0.245, 0.232, 0.168];
        diskCol = [0.205, 0.142, 0.026];
      } else if (kindRoll < 0.84) {
        petalCol = [0.232, 0.035, 0.024];
        diskCol = [0.038, 0.026, 0.030];
      } else {
        petalCol = [0.182, 0.080, 0.146];
        diskCol = [0.125, 0.055, 0.095];
      }
    }

    wildflowers.push({
      rootX: fc.x,
      rootZ: fc.z,
      tuftRand,
      stiff: 9.2 + 2.5 * hash01(fSeed, 7),
      az,
      dirX,
      dirZ,
      sideX,
      sideZ,
      hFlower,
      lean,
      corollaR,
      petalCol,
      diskCol,
      stemCol: profile.midCol,
      rootCol: profile.rootCol,
      retirePhase: Math.round(hash01(fSeed, 9) * 7) / 7,
      score: hFlower + corollaR * 12.0 + hash01(fSeed, 10) * 0.25,
    });
  }
  wildflowers.sort((a, b) => b.score - a.score);

  return { tussockCenters, tussockBlades, huggerTufts, panicles, wildflowers };
}

function addScoredTri(pool, outIndices, i0, i1, i2, colHint, stats) {
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
}

// Emits a 3-segment (5-tri, 7-vert) curved botanical blade (or 3-tri simplified tussock plume at L3).
function emitCurvedSheafBlade(pool, outIndices, blade, curWMult, nextWMult, hMult, retiring, useSimplePlume, stats) {
  const pts = blade.pts;
  const rx = blade.rootX, rz = blade.rootZ;
  const wTag = retiring ? -(0.10 + 0.86 * clamp(blade.retirePhase, 0, 1)) : 1.0;
  const widenRatio = !retiring && nextWMult > curWMult ? (nextWMult / curWMult - 1.0) : 0.0;

  const evalStationNormal = (si) => {
    const pPrev = pts[Math.max(0, si - 1)];
    const pNext = pts[Math.min(3, si + 1)];
    const tx = pNext.x - pPrev.x;
    const ty = (pNext.y - pPrev.y) * hMult;
    const tz = pNext.z - pPrev.z;
    const sx = pts[si].sx, sz = pts[si].sz;
    // Ribbon normal = S x T (points upward and outward along the parabolic blade arch)
    let nx = -sz * ty;
    let ny = sz * tx - sx * tz;
    let nz = sx * ty;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    ny = Math.max(0.32, ny + 0.35);
    return [nx, ny, nz];
  };

  const emitRowEdge = (si, sign) => {
    const p = pts[si];
    const [nx, ny, nz] = evalStationNormal(si);
    const hw = p.hw * curWMult;
    const px = qPos(p.x + p.sx * hw * sign);
    const py = qPos(p.y <= 0 ? p.y : p.y * hMult);
    const pz = qPos(p.z + p.sz * hw * sign);
    if (py > stats.maxY) stats.maxY = py;

    // Slight cross-camber normal spread across V-keeled grass lamina
    const camber = 0.28 * sign;
    const packedN = packSnorm8x4(nx + p.sx * camber, ny, nz + p.sz * camber, wTag);
    const packedC = packColorUnorm8x4(p.col[0], p.col[1], p.col[2], blade.tuftRand);
    let morph = 0;
    if (retiring) {
      morph = packHalf2(rx - px, rz - pz);
    } else if (widenRatio > 0 && hw > 0) {
      morph = packHalf2(p.sx * hw * sign * widenRatio, p.sz * hw * sign * widenRatio);
    }
    return pool.add(px, py, pz, packedN, packedC, qAttr(p.along), qAttr(blade.stiff), morph);
  };

  const emitTip = () => {
    const p = pts[3];
    const [nx, ny, nz] = evalStationNormal(3);
    const px = qPos(p.x), py = qPos(p.y * hMult), pz = qPos(p.z);
    if (py > stats.maxY) stats.maxY = py;
    return pool.add(
      px,
      py,
      pz,
      packSnorm8x4(nx * 0.75, ny + 0.25, nz * 0.75, wTag),
      packColorUnorm8x4(p.col[0], p.col[1], p.col[2], blade.tuftRand),
      qAttr(p.along),
      qAttr(blade.stiff * 0.90),
      retiring ? packHalf2(rx - px, rz - pz) : 0,
    );
  };

  if (useSimplePlume) {
    // L3 broad 3-triangle tussock plume: station 0 -> station 2 -> tip (5 verts, 3 tris)
    const i0L = emitRowEdge(0, -1), i0R = emitRowEdge(0, 1);
    const i2L = emitRowEdge(2, -1), i2R = emitRowEdge(2, 1);
    const iTip = emitTip();
    addScoredTri(pool, outIndices, i0L, i0R, i2R, pts[1].col, stats);
    addScoredTri(pool, outIndices, i0L, i2R, i2L, pts[1].col, stats);
    addScoredTri(pool, outIndices, i2L, i2R, iTip, pts[2].col, stats);
    return;
  }

  // Full 3-segment curved botanical blade: 7 vertices, 5 triangles!
  const i0L = emitRowEdge(0, -1), i0R = emitRowEdge(0, 1);
  const i1L = emitRowEdge(1, -1), i1R = emitRowEdge(1, 1);
  const i2L = emitRowEdge(2, -1), i2R = emitRowEdge(2, 1);
  const iTip = emitTip();

  addScoredTri(pool, outIndices, i0L, i0R, i1R, pts[0].col, stats);
  addScoredTri(pool, outIndices, i0L, i1R, i1L, pts[1].col, stats);
  addScoredTri(pool, outIndices, i1L, i1R, i2R, pts[1].col, stats);
  addScoredTri(pool, outIndices, i1L, i2R, i2L, pts[2].col, stats);
  addScoredTri(pool, outIndices, i2L, i2R, iTip, pts[3].col, stats);
}

// Emits a broad low-arching ground-hugger basal leaf (5 verts, 3 tris).
function emitHuggerLeaf(pool, outIndices, tuft, leaf, curWMult, nextWMult, hMult, retiring, stats) {
  const [p0, p1, p2] = leaf.pts;
  const rx = tuft.rootX, rz = tuft.rootZ;
  const wTag = retiring ? -(0.12 + 0.84 * clamp(leaf.retirePhase, 0, 1)) : 1.0;
  const widenRatio = !retiring && nextWMult > curWMult ? (nextWMult / curWMult - 1.0) : 0.0;

  const addEdge = (p, sign) => {
    const hw = p.hw * curWMult;
    const px = qPos(p.x + p.sx * hw * sign);
    const py = qPos(p.y <= 0 ? p.y : p.y * hMult);
    const pz = qPos(p.z + p.sz * hw * sign);
    if (py > stats.maxY) stats.maxY = py;
    let morph = 0;
    if (retiring) {
      morph = packHalf2(rx - px, rz - pz);
    } else if (widenRatio > 0 && hw > 0) {
      morph = packHalf2(p.sx * hw * sign * widenRatio, p.sz * hw * sign * widenRatio);
    }
    return pool.add(
      px,
      py,
      pz,
      packSnorm8x4(p.sx * 0.22 * sign, 0.94, p.sz * 0.22 * sign, wTag),
      packColorUnorm8x4(p.col[0], p.col[1], p.col[2], tuft.tuftRand),
      qAttr(p.along),
      qAttr(tuft.stiff),
      morph,
    );
  };

  const i0L = addEdge(p0, -1), i0R = addEdge(p0, 1);
  const i1L = addEdge(p1, -1), i1R = addEdge(p1, 1);
  const tx = qPos(p2.x), ty = qPos(p2.y * hMult), tz = qPos(p2.z);
  if (ty > stats.maxY) stats.maxY = ty;
  const iTip = pool.add(
    tx,
    ty,
    tz,
    packSnorm8x4(0, 0.96, 0, wTag),
    packColorUnorm8x4(p2.col[0], p2.col[1], p2.col[2], tuft.tuftRand),
    qAttr(p2.along),
    qAttr(tuft.stiff),
    retiring ? packHalf2(rx - tx, rz - tz) : 0,
  );

  addScoredTri(pool, outIndices, i0L, i0R, i1R, p0.col, stats);
  addScoredTri(pool, outIndices, i0L, i1R, i1L, p1.col, stats);
  addScoredTri(pool, outIndices, i1L, i1R, iTip, p2.col, stats);
}

// Emits a tall golden oat/barley culm + 3D cross-vaned spikelet panicle (7 tris full, or 3-tri plume at L3).
function emitOatPanicle(pool, outIndices, panicle, curWMult, nextWMult, hMult, retiring, simpleL3, stats) {
  emitCurvedSheafBlade(
    pool,
    outIndices,
    {
      rootX: panicle.rootX,
      rootZ: panicle.rootZ,
      tuftRand: panicle.tuftRand,
      stiff: panicle.stiff,
      pts: panicle.pts,
      retirePhase: panicle.retirePhase,
    },
    curWMult,
    nextWMult,
    hMult,
    retiring,
    simpleL3,
    stats,
  );
  if (simpleL3) return;

  // Cross-vaned perpendicular golden spikelet plume (2 extra triangles at 90 deg around the upper panicle axis)
  const p2 = panicle.pts[2];
  const p3 = panicle.pts[3];
  const rx = panicle.rootX, rz = panicle.rootZ;
  const wTag = retiring ? -(0.10 + 0.86 * clamp(panicle.retirePhase, 0, 1)) : 1.0;
  const hwCross = panicle.headHW * curWMult * 0.92;
  const cx = panicle.dirX, cz = panicle.dirZ;

  const mkV = (bx, by, bz, sign, col, along) => {
    const px = qPos(bx + cx * hwCross * sign);
    const py = qPos(by * hMult);
    const pz = qPos(bz + cz * hwCross * sign);
    if (py > stats.maxY) stats.maxY = py;
    return pool.add(
      px,
      py,
      pz,
      packSnorm8x4(cx * 0.35 * sign, 0.90, cz * 0.35 * sign, wTag),
      packColorUnorm8x4(col[0], col[1], col[2], panicle.tuftRand),
      qAttr(along),
      qAttr(panicle.stiff * 0.88),
      retiring ? packHalf2(rx - px, rz - pz) : 0,
    );
  };

  const midBaseY = lerp(panicle.pts[1].y, p2.y, 0.55);
  const midBaseX = lerp(panicle.pts[1].x, p2.x, 0.55);
  const midBaseZ = lerp(panicle.pts[1].z, p2.z, 0.55);
  const vBase = mkV(midBaseX, midBaseY, midBaseZ, 0, p2.col, 0.79);
  const vCrossL = mkV(p2.x, p2.y, p2.z, -1, p2.col, 0.86);
  const vCrossR = mkV(p2.x, p2.y, p2.z, 1, p2.col, 0.86);
  const vTop = mkV(p3.x, p3.y, p3.z, 0, p3.col, 1.00);

  addScoredTri(pool, outIndices, vBase, vCrossL, vCrossR, p2.col, stats);
  addScoredTri(pool, outIndices, vCrossL, vTop, vCrossR, p3.col, stats);
}

// Emits a slender curved wildflower stem (3 tris) + 3D upward-cupped 4-petal corolla cup (4 tris) = 7 tris.
function emitWildflower(pool, outIndices, fl, curWMult, hMult, retiring, stats) {
  const rx = fl.rootX, rz = fl.rootZ;
  const wTag = retiring ? -(0.14 + 0.82 * clamp(fl.retirePhase, 0, 1)) : 1.0;
  const stemHW = 0.0026 * curWMult;
  const headX = rx + fl.dirX * fl.lean;
  const headZ = rz + fl.dirZ * fl.lean;
  const headY = fl.hFlower * hMult;
  const midX = rx + fl.dirX * fl.lean * 0.45;
  const midZ = rz + fl.dirZ * fl.lean * 0.45;
  const midY = headY * 0.54;

  const mkV = (bx, by, bz, nx, ny, nz, col, along) => {
    const px = qPos(bx), py = qPos(by), pz = qPos(bz);
    if (py > stats.maxY) stats.maxY = py;
    return pool.add(
      px,
      py,
      pz,
      packSnorm8x4(nx, ny, nz, wTag),
      packColorUnorm8x4(col[0], col[1], col[2], fl.tuftRand),
      qAttr(along),
      qAttr(fl.stiff),
      retiring ? packHalf2(rx - px, rz - pz) : 0,
    );
  };

  // 3-tri curved scape
  const s0L = mkV(rx - fl.sideX * stemHW, -0.005, rz - fl.sideZ * stemHW, -fl.sideX * 0.3, 0.9, -fl.sideZ * 0.3, fl.rootCol, 0.03);
  const s0R = mkV(rx + fl.sideX * stemHW, -0.005, rz + fl.sideZ * stemHW, fl.sideX * 0.3, 0.9, fl.sideZ * 0.3, fl.rootCol, 0.03);
  const s1L = mkV(midX - fl.sideX * stemHW * 0.85, midY, midZ - fl.sideZ * stemHW * 0.85, -fl.sideX * 0.3, 0.9, -fl.sideZ * 0.3, fl.stemCol, 0.38);
  const s1R = mkV(midX + fl.sideX * stemHW * 0.85, midY, midZ + fl.sideZ * stemHW * 0.85, fl.sideX * 0.3, 0.9, fl.sideZ * 0.3, fl.stemCol, 0.38);
  const cCenter = mkV(headX, headY - 0.003, headZ, 0, 1, 0, fl.diskCol, 0.70);

  addScoredTri(pool, outIndices, s0L, s0R, s1R, fl.rootCol, stats);
  addScoredTri(pool, outIndices, s0L, s1R, s1L, fl.stemCol, stats);
  addScoredTri(pool, outIndices, s1L, s1R, cCenter, fl.stemCol, stats);

  // 4-tri 3D concave upward-cupped corolla blossom (never a flat billboard!)
  const rP = fl.corollaR * Math.min(1.45, curWMult);
  const lift = rP * 0.34;
  const p0 = mkV(headX + fl.dirX * rP, headY + lift, headZ + fl.dirZ * rP, -fl.dirX * 0.25, 0.96, -fl.dirZ * 0.25, fl.petalCol, 0.74);
  const p1 = mkV(headX + fl.sideX * rP, headY + lift, headZ + fl.sideZ * rP, -fl.sideX * 0.25, 0.96, -fl.sideZ * 0.25, fl.petalCol, 0.74);
  const p2 = mkV(headX - fl.dirX * rP, headY + lift, headZ - fl.dirZ * rP, fl.dirX * 0.25, 0.96, fl.dirZ * 0.25, fl.petalCol, 0.74);
  const p3 = mkV(headX - fl.sideX * rP, headY + lift, headZ - fl.sideZ * rP, fl.sideX * 0.25, 0.96, fl.sideZ * 0.25, fl.petalCol, 0.74);

  addScoredTri(pool, outIndices, cCenter, p0, p1, fl.petalCol, stats);
  addScoredTri(pool, outIndices, cCenter, p1, p2, fl.petalCol, stats);
  addScoredTri(pool, outIndices, cCenter, p2, p3, fl.petalCol, stats);
  addScoredTri(pool, outIndices, cCenter, p3, p0, fl.petalCol, stats);
}

// Builds progressive cluster cuts L0..L3 (~4,206 -> 2,107 -> 948 -> 378 tris) on a 1.75 m x 1.75 m tile.
function buildBotanicalMeadowLevel(pool, outIndices, sward, profile, lvl) {
  const stats = { sumR: 0, sumG: 0, sumB: 0, sumArea: 0, maxY: 0.24 };
  const startIdx = outIndices.length;

  const SHEAF_COUNTS = [624, 316, 150, 114];
  const HUGGER_TUFT_COUNTS = [98, 50, 32, 0];
  const HUGGER_LEAVES_PER_TUFT = [3, 2, 1, 0];
  const PANICLE_COUNTS = [48, 32, 16, 14];
  const FLOWER_COUNTS = [12, 5, 0, 0];
  const WIDTH_COMP = [1.00, 1.36, 1.92, 2.95];
  const HEIGHT_SCALE = [1.00, 0.99, 0.95, 0.88];

  const curW = WIDTH_COMP[lvl];
  const nextW = lvl < 3 ? WIDTH_COMP[lvl + 1] : curW;
  const hMult = HEIGHT_SCALE[lvl];
  const spatialKey = (rx, rz) => (Math.floor((rz / TILE_METRES) * 6) * 8 + Math.floor((rx / TILE_METRES) * 6));

  // 1. Arched 3-segment tussock sheaves
  const sheafN = Math.min(sward.tussockBlades.length, SHEAF_COUNTS[lvl]);
  const nextSheafN = lvl < 3 ? Math.min(sward.tussockBlades.length, SHEAF_COUNTS[lvl + 1]) : 0;
  const chosenSheaves = sward.tussockBlades.slice(0, sheafN).map((b, rankIdx) => ({ b, rankIdx }));
  chosenSheaves.sort((a, b) => spatialKey(a.b.rootX, a.b.rootZ) - spatialKey(b.b.rootX, b.b.rootZ));
  for (const { b, rankIdx } of chosenSheaves) {
    const retiring = lvl < 3 ? rankIdx >= nextSheafN : true;
    emitCurvedSheafBlade(pool, outIndices, b, curW, nextW, hMult, retiring, lvl === 3, stats);
  }

  // 2. Low basal ground-hugger tufts
  const hugN = Math.min(sward.huggerTufts.length, HUGGER_TUFT_COUNTS[lvl]);
  const nextHugN = lvl < 3 ? Math.min(sward.huggerTufts.length, HUGGER_TUFT_COUNTS[lvl + 1]) : 0;
  const curLeaves = HUGGER_LEAVES_PER_TUFT[lvl];
  const nextLeaves = lvl < 3 ? HUGGER_LEAVES_PER_TUFT[lvl + 1] : 0;
  const chosenHuggers = sward.huggerTufts.slice(0, hugN).map((t, rankIdx) => ({ t, rankIdx }));
  chosenHuggers.sort((a, b) => spatialKey(a.t.rootX, a.t.rootZ) - spatialKey(b.t.rootX, b.t.rootZ));
  for (const { t, rankIdx } of chosenHuggers) {
    const tuftSurvives = lvl < 3 && rankIdx < nextHugN;
    for (let li = 0; li < curLeaves; li++) {
      const retiring = !tuftSurvives || li >= nextLeaves;
      emitHuggerLeaf(pool, outIndices, t, t.leaves[li], curW, nextW, hMult, retiring, stats);
    }
  }

  // 3. Tall golden oat/barley panicles
  const panN = Math.min(sward.panicles.length, PANICLE_COUNTS[lvl]);
  const nextPanN = lvl < 3 ? Math.min(sward.panicles.length, PANICLE_COUNTS[lvl + 1]) : 0;
  const chosenPanicles = sward.panicles.slice(0, panN).map((p, rankIdx) => ({ p, rankIdx }));
  chosenPanicles.sort((a, b) => spatialKey(a.p.rootX, a.p.rootZ) - spatialKey(b.p.rootX, b.p.rootZ));
  for (const { p, rankIdx } of chosenPanicles) {
    const retiring = lvl < 3 ? rankIdx >= nextPanN : true;
    emitOatPanicle(pool, outIndices, p, curW * 0.92, nextW * 0.92, hMult, retiring, lvl === 3, stats);
  }

  // 4. Subtle Mediterranean coastal wildflowers
  const flN = Math.min(sward.wildflowers.length, FLOWER_COUNTS[lvl]);
  const nextFlN = lvl < 3 ? Math.min(sward.wildflowers.length, FLOWER_COUNTS[lvl + 1]) : 0;
  for (let fi = 0; fi < flN; fi++) {
    const retiring = lvl < 3 ? fi >= nextFlN : true;
    emitWildflower(pool, outIndices, sward.wildflowers[fi], curW, hMult, retiring, stats);
  }

  const meanCol = stats.sumArea > 0
    ? [stats.sumR / stats.sumArea, stats.sumG / stats.sumArea, stats.sumB / stats.sumArea]
    : profile.midCol;
  return { idxCount: outIndices.length - startIdx, meanCol, maxY: stats.maxY };
}

// D4-invariant & Z^2-periodic boundary height on [0, TILE_METRES]^2:
// invariant under 0/90/180/270 deg tile rotations AND lattice translations -> 100% seam-free continuum!
function evalPeriodicBorderCanopyY(tx, tz) {
  const px = (tx / TILE_METRES) * Math.PI * 2;
  const pz = (tz / TILE_METRES) * Math.PI * 2;
  return 0.148
    + 0.016 * Math.cos(px) * Math.cos(pz)
    + 0.009 * (Math.cos(px) + Math.cos(pz));
}

function evalTussockCanopyY(tx, tz, sward, profile) {
  const borderY = evalPeriodicBorderCanopyY(tx, tz);
  const edgeDist = Math.min(tx, TILE_METRES - tx, tz, TILE_METRES - tz);
  if (edgeDist <= 0.03) return borderY;

  let clumpLift = 0.0;
  let weightSum = 0.0;
  for (let ci = 0; ci < sward.tussockCenters.length; ci += 2) {
    const tc = sward.tussockCenters[ci];
    const dx = tx - tc.x;
    const dz = tz - tc.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 0.22) continue;
    const w = Math.exp(-d2 / 0.055);
    const h = 0.15 + 0.09 * hash01(tc.seed, 3);
    clumpLift += h * w;
    weightSum += w;
  }
  const interiorY = weightSum > 0.05
    ? lerp(profile.canopyBaseY, clamp(clumpLift / Math.max(weightSum, 0.65), 0.12, 0.25), clamp(weightSum * 0.55, 0, 0.85))
    : profile.canopyBaseY;
  const interiorBlend = clamp((edgeDist - 0.03) / 0.38, 0, 1);
  return lerp(borderY, interiorY, interiorBlend * interiorBlend * (3 - 2 * interiorBlend));
}

// Builds closed genus-0 (Euler = 2) 5x5 sculpted tussock canopy + underground pole (V=26, E=72, F=48 -> coreTriCount=6)
// and bakes the flat O(1) cumulative vertex ancestor table (u8 packed 4-per-u32).
function buildSculptedContinuumForVariant(sward, profile, tileMeanCol) {
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
    sway[vi * 3 + 1] = qAttr(profile.stiffness * 1.10);
    sway[vi * 3 + 2] = qAttr(alongVal * alongVal * 0.08);
  };

  const borderCol = [0.068, 0.132, 0.038];

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
      const y = isBorder ? evalPeriodicBorderCanopyY(tx, tz) : evalTussockCanopyY(tx, tz, sward, profile);

      const eps = 0.16;
      const yX1 = isBorder ? evalPeriodicBorderCanopyY(tx + eps, tz) : evalTussockCanopyY(clamp(tx + eps, 0, TILE_METRES), tz, sward, profile);
      const yX0 = isBorder ? evalPeriodicBorderCanopyY(tx - eps, tz) : evalTussockCanopyY(clamp(tx - eps, 0, TILE_METRES), tz, sward, profile);
      const yZ1 = isBorder ? evalPeriodicBorderCanopyY(tx, tz + eps) : evalTussockCanopyY(tx, clamp(tz + eps, 0, TILE_METRES), sward, profile);
      const yZ0 = isBorder ? evalPeriodicBorderCanopyY(tx, tz - eps) : evalTussockCanopyY(tx, clamp(tz - eps, 0, TILE_METRES), sward, profile);
      const gx = (yX1 - yX0) / (2 * eps);
      const gz = (yZ1 - yZ0) / (2 * eps);

      const alongVal = clamp(0.42 + (y - 0.12) * 1.8, 0.36, 0.68);
      const c = isBorder
        ? borderCol
        : [
            lerp(tileMeanCol[0], profile.tipCol[0], clamp((y - 0.13) * 3.2, 0, 0.55)),
            lerp(tileMeanCol[1], profile.tipCol[1], clamp((y - 0.13) * 3.2, 0, 0.55)),
            lerp(tileMeanCol[2], profile.tipCol[2], clamp((y - 0.13) * 3.2, 0, 0.55)),
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
    const err = +((0.104 + ((step + 1) / MORPH_STEPS) * 0.36).toFixed(4));
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
      centreY: +(profile.canopyBaseY * 0.58).toFixed(4),
      rx: +(MORPH_HALF_M * 0.985).toFixed(4),
      ry: +(Math.min(0.16, profile.canopyBaseY * 0.76)).toFixed(4),
      meanCol: tileMeanCol.map((c) => +c.toFixed(4)),
    },
  };
}

function measureBotanicalVariantProfile(srcVerts, srcIndices, mixSpec, mixIdx, vIdx) {
  const varSpec = mixSpec.variants[0];
  const startI = varSpec.firstIndex;
  const endI = startI + varSpec.indexCount;
  let stiffSum = 0, nSamples = 0;
  const step = Math.max(3, Math.floor((endI - startI) / 1800) * 3);
  for (let ii = startI; ii < endI; ii += step) {
    const s = srcIndices[ii] * SOURCE_STRIDE;
    stiffSum += clamp(srcVerts[s + 10], 2.0, 35.0);
    nSamples++;
  }
  const measuredStiff = nSamples > 0 ? clamp(stiffSum / nSamples, 7.5, 13.0) : 9.5;

  // Natural Iberian coastal meadow chlorophyll & golden-oat linear-sRGB palettes per mix:
  //   0: pasture (lush emerald-olive cocksfoot & ryegrass + clover)
  //   1: waste (Mediterranean olive-sage fescue, brome & warm dry straw)
  //   2: field-margin (tall rich meadow sheaves + abundant sunlit golden wild oat)
  const rootCol = [
    [0.044, 0.082, 0.026],
    [0.056, 0.084, 0.030],
    [0.048, 0.086, 0.028],
  ][mixIdx];
  const huggerCol = [
    [0.046, 0.128, 0.030],
    [0.064, 0.122, 0.036],
    [0.050, 0.134, 0.032],
  ][mixIdx];
  const midCol = [
    [0.056, 0.144, 0.034],
    [0.078, 0.134, 0.040],
    [0.062, 0.148, 0.036],
  ][mixIdx];
  const upperCol = [
    [0.074, 0.158, 0.038],
    [0.098, 0.146, 0.045],
    [0.082, 0.162, 0.040],
  ][mixIdx];
  const tipCol = [
    [0.094, 0.168, 0.044],
    [0.124, 0.154, 0.050],
    [0.106, 0.170, 0.046],
  ][mixIdx];
  const strawCol = [0.154, 0.138, 0.054];
  const oatGoldCol = [0.196, 0.162, 0.058];

  return {
    variantId: mixIdx * VARIANTS + vIdx,
    sheafHeight: [0.24, 0.26, 0.29][mixIdx],
    canopyBaseY: [0.150, 0.160, 0.172][mixIdx],
    stiffness: lerp([8.6, 9.6, 9.0][mixIdx], measuredStiff, 0.25),
    rootCol,
    huggerCol,
    midCol,
    upperCol,
    tipCol,
    strawCol,
    oatGoldCol,
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
  const levelTriTotals = [0, 0, 0, 0];

  for (let mixIdx = 0; mixIdx < MIXES.length; mixIdx++) {
    const mixName = MIXES[mixIdx];
    const mixSpec = srcManifest.groves[mixName];
    const bankSpecimens = [
      extractSpecimenTemplates(srcVerts, srcIndices, mixSpec.variants[0], mixIdx, 0),
      extractSpecimenTemplates(srcVerts, srcIndices, mixSpec.variants[1], mixIdx, 1),
    ];
    for (let vIdx = 0; vIdx < VARIANTS; vIdx++) {
      const profile = measureBotanicalVariantProfile(srcVerts, srcIndices, mixSpec, mixIdx, vIdx);
      const specimens = bankSpecimens[vIdx & 1];
      const sward = generateBotanicalSward(profile, specimens, mixIdx, vIdx);
      const variantId = profile.variantId;
      const clusterFirst = clusterRecords.length / CLUSTER_WORDS;
      let l0MeanCol = profile.midCol;

      for (let lvl = 0; lvl < 4; lvl++) {
        const firstIdx = outIndices.length;
        const geo = buildBotanicalMeadowLevel(vertPool, outIndices, sward, profile, lvl);
        if (lvl === 0) l0MeanCol = geo.meanCol;
        levelTriTotals[lvl] += geo.idxCount / 3;
        clusterRecords.push(
          firstIdx,
          geo.idxCount,
          lvl,
          LEVEL_PARENT_ERRORS[lvl],
          LEVEL_ERRORS[lvl],
          half,
          geo.maxY * 0.45,
          half,
          Math.hypot(MORPH_HALF_M * Math.SQRT2, geo.maxY * 0.65),
          variantId,
          0,
          0,
        );
      }

      const cont = buildSculptedContinuumForVariant(sward, profile, l0MeanCol);
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

  const nVars = variantRecords.length;
  const meanCuts = levelTriTotals.map((t) => Math.round(t / nVars));
  const l0TrisPerM2 = +(meanCuts[0] / (TILE_METRES * TILE_METRES)).toFixed(1);

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
  console.log(
    `Baked meadows-gpu (${TILE_METRES}m x ${TILE_METRES}m = ${(TILE_METRES * TILE_METRES).toFixed(4)} m^2): ` +
    `cuts=[${meanCuts.join(' -> ')}] tris/tile (${l0TrisPerM2} tris/m^2 at L0), ` +
    `${outManifest.vertexCount} unique verts, ${outManifest.triangleCount} total tris, ` +
    `Euler=2 across all ${nVars} variants, ${(totalGz / 1024).toFixed(1)} KB gz total`
  );
}

main();
