#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes compact GPU-resident 4-level Volumetric Cloud + Wavy Tendrils grass continuum
// (1 cluster per 1.35 m tile per level = 48 clusters total + genus-0 morph.bin + 1-tri splats)
// from raw botanical meadow data into assets/ground-cover/portugal/meadows-gpu/.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SRC_DIR = 'assets/ground-cover/portugal/meadows';
const OUT_DIR = 'assets/ground-cover/portugal/meadows-gpu';
const MIXES = ['pasture', 'waste', 'field-margin'];
const VARIANTS = 4;
const TILE_METRES = 1.35;
const SUB_GRID = 1; // 1 unified overlapping volumetric cloud+tendrils unit per tile (loop-free GPU select!)
const SOURCE_STRIDE = 12;
const GPU_VERTEX_WORDS = 8; // px, py, pz, packedNorm+wTag, packedCol, along, stiffness, packedMorphXZ(half2)
const CLUSTER_WORDS = 12;

// Continuous screen-space error thresholds across L0 -> L1 -> L2 -> L3 -> Continuum
const LEVEL_TENDRILS = [88, 38, 14, 4];
const LEVEL_BILLOWS = [7, 4, 1, 0];
const LEVEL_SHELL_CFG = [
  { rings: 7, segs: 10 }, // L0: 140-tri undulating volumetric cloud + 7 soft billows + 88 slender 4-seg arched tendrils
  { rings: 6, segs: 8 },  // L1: 96-tri undulating volumetric cloud + 4 soft billows + 38 slender 3-seg arched tendrils
  { rings: 5, segs: 7 },  // L2: 70-tri undulating volumetric cloud + 1 billow + 14 wind-combed wave plumes
  { rings: 4, segs: 5 },  // L3: 40-tri undulating volumetric cloud + 4 subtle crest plumes -> matches morph.bin!
];
const LEVEL_ERRORS = [0.0, 0.011, 0.026, 0.056];
const LEVEL_PARENT_ERRORS = [0.011, 0.026, 0.056, 0.125];

const MORPH_RINGS = 4;
const MORPH_K = 5;
const MORPH_STEPS = MORPH_RINGS * MORPH_K - 2; // 18 half-edge collapse steps from 40 tris -> 4 core tris

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

function hash01(seed, idx) {
  let h = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(idx + 1, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
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

function packSnorm8x4(nx, ny, nz, w = 0) {
  const len = Math.hypot(nx, ny, nz) || 1;
  const x = clamp(Math.round((nx / len) * 127), -127, 127) & 0xff;
  const y = clamp(Math.round((ny / len) * 127), -127, 127) & 0xff;
  const z = clamp(Math.round((nz / len) * 127), -127, 127) & 0xff;
  const a = clamp(Math.round(clamp(w, -1, 1) * 127), -127, 127) & 0xff;
  return ((a << 24) | (z << 16) | (y << 8) | x) >>> 0;
}

function packColorUnorm8x4(r, g, b, a = 1) {
  const enc = (c) => clamp(Math.round(Math.pow(clamp(c, 0, 1), 1 / 2.2) * 255), 0, 255);
  const ir = enc(r), ig = enc(g), ib = enc(b);
  const ia = clamp(Math.round(clamp(a, 0, 1) * 255), 0, 255);
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

// Evaluates the continuous volumetric turf-cloud surface height & normal at local offset (dx, dz) from tile center.
// Radius 1.20 m > diagonal half-tile 0.955 m guarantees 100% gapless overlapping volumetric grass sward across slopes.
function evalCloudSurface(dx, dz, profile) {
  const r = Math.hypot(dx, dz);
  const maxR = profile.cloudRadius;
  const u = clamp(r / maxR, 0, 1);
  const ang = Math.atan2(dz, dx);
  const lobe = 1.0
    + 0.095 * Math.sin(ang * 3.0 + profile.phaseA)
    + 0.065 * Math.cos(ang * 5.0 - profile.phaseB);
  const effU = clamp(u / lobe, 0, 1.08);
  // Soft, deep volumetric dome with gentle skirt tuck (-0.034 m) at outer overlap rim so sloped hills never show gaps
  const dome = Math.pow(Math.max(0, 1.0 - effU * effU * 0.84), 0.66);
  const tussock = (
    0.58 * Math.sin(dx * 4.1 + profile.phaseA) * Math.cos(dz * 3.8 - profile.phaseB)
    + 0.42 * Math.cos((dx * 0.85 - dz * 0.55) * 5.8 + profile.phaseC)
  ) * (1.0 - smooth01(0.62, 1.04, effU));
  const y = -0.034 * smooth01(0.74, 1.04, effU) + profile.cloudHeight * dome * (0.84 + 0.30 * tussock);
  const slopeR = (profile.cloudHeight * 1.28 * effU) / Math.max(0.22, maxR);
  const nx = r > 1e-4 ? (dx / r) * slopeR - 0.16 * Math.cos(dx * 4.1 + profile.phaseA) : 0;
  const nz = r > 1e-4 ? (dz / r) * slopeR + 0.16 * Math.sin(dz * 3.8 - profile.phaseB) : 0;
  const ny = 0.92;
  const nLen = Math.hypot(nx, ny, nz) || 1;
  const along = clamp((y + 0.025) / Math.max(0.10, profile.cloudHeight * 1.52), 0.03, 0.62);
  return { y, nx: nx / nLen, ny: ny / nLen, nz: nz / nLen, along, effU };
}

function smooth01(a, b, x) {
  const t = clamp((x - a) / (b - a || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

function samplePaletteColor(profile, along, hueJitter, goldenTip = 0) {
  const t = clamp(along, 0, 1);
  const base = t < 0.48
    ? [
        lerp(profile.rootCol[0], profile.midCol[0], t / 0.48),
        lerp(profile.rootCol[1], profile.midCol[1], t / 0.48),
        lerp(profile.rootCol[2], profile.midCol[2], t / 0.48),
      ]
    : [
        lerp(profile.midCol[0], profile.tipCol[0], (t - 0.48) / 0.52),
        lerp(profile.midCol[1], profile.tipCol[1], (t - 0.48) / 0.52),
        lerp(profile.midCol[2], profile.tipCol[2], (t - 0.48) / 0.52),
      ];
  const warm = goldenTip * Math.pow(t, 1.9);
  return [
    clamp(lerp(base[0], profile.seedCol[0], warm) * (0.88 + 0.24 * hueJitter), 0.004, 0.32),
    clamp(lerp(base[1], profile.seedCol[1], warm) * (0.90 + 0.20 * hueJitter), 0.008, 0.36),
    clamp(lerp(base[2], profile.seedCol[2], warm) * (0.86 + 0.22 * (1 - hueJitter)), 0.002, 0.16),
  ];
}

// Builds a single LOD level (0..3) of the unified Volumetric Cloud + Wavy Tendrils cluster centered at [0.675, 0.675].
function buildVolumetricTendrilLevel(profile, lvl) {
  const verts = [];
  const tris = [];
  const half = TILE_METRES * 0.5;
  const { rings, segs } = LEVEL_SHELL_CFG[lvl];
  const tendrilCount = LEVEL_TENDRILS[lvl];
  const nextTendrilCount = lvl < 3 ? LEVEL_TENDRILS[lvl + 1] : 0;
  const billowCount = LEVEL_BILLOWS[lvl];
  const nextBillowCount = lvl < 3 ? LEVEL_BILLOWS[lvl + 1] : 0;

  let sumR = 0, sumG = 0, sumB = 0, sumArea = 0, maxY = profile.cloudHeight;

  const addVert = (px, py, pz, nx, ny, nz, col, along, stiff, wTag = 1.0, morphDx = 0, morphDz = 0) => {
    const idx = verts.length / GPU_VERTEX_WORDS;
    if (py > maxY) maxY = py;
    verts.push(
      px,
      py,
      pz,
      packSnorm8x4(nx, ny, nz, wTag),
      packColorUnorm8x4(col[0], col[1], col[2], 1),
      clamp(along, 0, 1),
      stiff,
      packHalf2(morphDx, morphDz),
    );
    return idx;
  };

  const addTri = (i0, i1, i2, colHint) => {
    const o0 = i0 * GPU_VERTEX_WORDS, o1 = i1 * GPU_VERTEX_WORDS, o2 = i2 * GPU_VERTEX_WORDS;
    const area = triArea3D(
      verts[o0], verts[o0 + 1], verts[o0 + 2],
      verts[o1], verts[o1 + 1], verts[o1 + 2],
      verts[o2], verts[o2 + 1], verts[o2 + 2],
    );
    if (area > 1e-7) {
      sumR += colHint[0] * area;
      sumG += colHint[1] * area;
      sumB += colHint[2] * area;
      sumArea += area;
    }
    tris.push(i0, i1, i2);
  };

  // 1. Primary Closed Genus-0 Volumetric Turf-Cloud Cushion (100% overlapping ground seal + billowing tussock volume)
  const botCenter = addVert(half, -0.028, half, 0, 1, 0, profile.rootCol, 0.0, profile.stiffness * 1.4, 1.0, 0, 0);
  const ringStart = verts.length / GPU_VERTEX_WORDS;
  for (let r = 0; r < rings; r++) {
    const rf = 1.0 - (r / rings) * 0.80;
    const rad = profile.cloudRadius * rf;
    for (let k = 0; k < segs; k++) {
      const ang = (k / segs) * Math.PI * 2 + r * 0.24 + profile.phaseA * 0.2;
      const lobe = 1.0 + 0.09 * Math.sin(k * 2.0 + r * 1.1 + profile.phaseB);
      const dx = Math.cos(ang) * rad * lobe;
      const dz = Math.sin(ang) * rad * lobe;
      const surf = evalCloudSurface(dx, dz, profile);
      const hj = hash01(profile.seed, r * 31 + k * 7);
      const col = samplePaletteColor(profile, surf.along, hj, 0.08);
      addVert(half + dx, surf.y, half + dz, surf.nx, surf.ny, surf.nz, col, surf.along, profile.stiffness * 1.15, 1.0, 0, 0);
    }
  }
  const topSurf = evalCloudSurface(0, 0, profile);
  const topCol = samplePaletteColor(profile, topSurf.along + 0.08, 0.58, 0.14);
  const topCenter = addVert(half, topSurf.y + 0.015, half, 0, 1, 0, topCol, topSurf.along + 0.08, profile.stiffness, 1.0, 0, 0);

  for (let k = 0; k < segs; k++) {
    const kn = (k + 1) % segs;
    addTri(botCenter, ringStart + kn, ringStart + k, profile.rootCol);
  }
  for (let r = 0; r < rings - 1; r++) {
    const rA = ringStart + r * segs, rB = ringStart + (r + 1) * segs;
    for (let k = 0; k < segs; k++) {
      const kn = (k + 1) % segs;
      const midCol = samplePaletteColor(profile, 0.18 + 0.36 * ((r + 0.5) / rings), 0.5, 0.08);
      addTri(rA + k, rA + kn, rB + k, midCol);
      addTri(rA + kn, rB + kn, rB + k, midCol);
    }
  }
  const lastRing = ringStart + (rings - 1) * segs;
  for (let k = 0; k < segs; k++) {
    const kn = (k + 1) % segs;
    addTri(lastRing + k, lastRing + kn, topCenter, topCol);
  }

  // 2. Secondary Volumetric Upper Cloud-Crest Pillows at near/mid levels (layered soft tussock depth)
  const bSegs = 7;
  for (let bi = 0; bi < billowCount; bi++) {
    const bAng = (bi / Math.max(1, billowCount)) * Math.PI * 2 + profile.phaseB * 0.6;
    const bDist = 0.24 + 0.38 * hash01(profile.seed + 19, bi);
    const bx = Math.cos(bAng) * bDist;
    const bz = Math.sin(bAng) * bDist;
    const baseSurf = evalCloudSurface(bx, bz, profile);
    const bRad = 0.36 + 0.16 * hash01(profile.seed + 43, bi);
    const bLift = 0.085 + 0.060 * hash01(profile.seed + 71, bi);
    const retiring = bi >= nextBillowCount;
    const rank = retiring ? (bi - nextBillowCount) / Math.max(1, billowCount - nextBillowCount) : 0;
    const wTag = retiring ? -(0.12 + 0.80 * rank) : 1.0;

    const rimStart = verts.length / GPU_VERTEX_WORDS;
    for (let k = 0; k < bSegs; k++) {
      const ka = (k / bSegs) * Math.PI * 2 + bi * 0.4;
      const rx = bx + Math.cos(ka) * bRad;
      const rz = bz + Math.sin(ka) * bRad * 0.82;
      const rs = evalCloudSurface(rx, rz, profile);
      const col = samplePaletteColor(profile, rs.along + 0.04, hash01(profile.seed + 97, bi * 11 + k), 0.10);
      addVert(
        half + rx,
        rs.y - 0.022,
        half + rz,
        Math.cos(ka) * 0.28,
        0.94,
        Math.sin(ka) * 0.28,
        col,
        rs.along + 0.04,
        profile.stiffness * 0.90,
        wTag,
        retiring ? (bx - rx) * 0.5 : 0,
        retiring ? (bz - rz) * 0.5 : 0,
      );
    }
    const crestAlong = clamp(baseSurf.along + 0.22, 0.35, 0.80);
    const crestCol = samplePaletteColor(profile, crestAlong, hash01(profile.seed + 131, bi), 0.16);
    const crestIdx = addVert(
      half + bx + Math.cos(profile.layAngle) * 0.09,
      baseSurf.y + bLift,
      half + bz + Math.sin(profile.layAngle) * 0.09,
      baseSurf.nx * 0.45,
      0.97,
      baseSurf.nz * 0.45,
      crestCol,
      crestAlong,
      profile.stiffness * 0.80,
      wTag,
      retiring ? -Math.cos(profile.layAngle) * 0.09 : 0,
      retiring ? -Math.sin(profile.layAngle) * 0.09 : 0,
    );
    for (let k = 0; k < bSegs; k++) {
      const kn = (k + 1) % bSegs;
      addTri(rimStart + k, rimStart + kn, crestIdx, crestCol);
    }
  }

  // 3. Slender, Wind-Combed Arched 3D Grass Tendrils emerging smoothly out of the volumetric cloud billows
  // Golden-angle phyllotaxis spiral over the tile ensures rich, natural tuft clumping with zero grid regularity.
  const GOLDEN_ANG = 2.399963229728653;
  const segCount = lvl === 0 ? 4 : lvl === 1 ? 3 : 2;
  const widthBoost = [1.0, 1.38, 1.85, 2.30][lvl];

  for (let ti = 0; ti < tendrilCount; ti++) {
    const frac = (ti + 0.5) / tendrilCount;
    const r = Math.sqrt(frac) * (profile.cloudRadius * 0.82);
    const theta = ti * GOLDEN_ANG + profile.phaseC;
    const jx = (hash01(profile.seed + 211, ti) - 0.5) * 0.14;
    const jz = (hash01(profile.seed + 223, ti) - 0.5) * 0.14;
    const rx = Math.cos(theta) * r + jx;
    const rz = Math.sin(theta) * r + jz;
    const surf = evalCloudSurface(rx, rz, profile);

    // Coherent wind-combed wave lay + gentle local splay so tendrils form silky flowing locks rather than upright wedges
    const swirl = 0.48 * Math.sin(rx * 2.3 + profile.phaseA) + 0.34 * Math.cos(rz * 2.1 - profile.phaseB);
    const splay = (hash01(profile.seed + 251, ti) - 0.5) * 0.52;
    const dirAng = profile.layAngle + swirl + splay;
    const dirX = Math.cos(dirAng), dirZ = Math.sin(dirAng);
    const sideX = -dirZ, sideZ = dirX;
    const sCurveSign = hash01(profile.seed + 263, ti) > 0.5 ? 1.0 : -1.0;

    const tallFactor = 0.68 + 0.64 * hash01(profile.seed + 277, ti);
    const tendrilRise = profile.tendrilHeight * tallFactor * (lvl === 3 ? 0.55 : 1.0);
    const tendrilSweep = (0.28 + 0.26 * hash01(profile.seed + 307, ti)) * tallFactor;
    // Slender botanical lock width (1.7..2.9 cm full ribbon width at L0, tapering smoothly to a fine hair tip!)
    const baseHalfW = (0.0085 + 0.0060 * hash01(profile.seed + 331, ti)) * widthBoost;
    const hueJ = hash01(profile.seed + 353, ti);
    const goldenSeed = hash01(profile.seed + 379, ti) > 0.66 ? profile.seedGolden : profile.seedGolden * 0.25;
    const stiff = profile.stiffness * (0.58 + 0.48 * hash01(profile.seed + 401, ti));

    const retiring = lvl < 3 ? ti >= nextTendrilCount : true;
    const rank = lvl < 3
      ? (retiring ? (ti - nextTendrilCount) / Math.max(1, tendrilCount - nextTendrilCount) : 0)
      : (ti / Math.max(1, tendrilCount));
    const wTag = retiring ? -(0.10 + 0.86 * rank) : 1.0;

    // Anchor root inside the volumetric cloud cushion so tendrils emerge seamlessly without hard joints
    const rootX = half + rx;
    const rootY = surf.y - 0.036;
    const rootZ = half + rz;

    const rowPairs = [];
    for (let s = 0; s < segCount; s++) {
      const u = s / segCount; // 0 .. 0.75 (for 4-seg)
      // Graceful arched S-curve spine: rises smoothly out of the cloud, crests horizontally, and curves downwind
      const sweep = tendrilSweep * Math.pow(u, 1.32);
      const sLateral = sCurveSign * 0.045 * Math.sin(u * Math.PI * 1.35) * tallFactor;
      const lift = tendrilRise * Math.sin(u * Math.PI * 0.68);
      const cx = rootX + dirX * sweep + sideX * sLateral;
      const cy = rootY + lift;
      const cz = rootZ + dirZ * sweep + sideZ * sLateral;
      const hw = baseHalfW * Math.pow(1.0 - 0.78 * u, 0.85);
      const along = clamp(surf.along + (1.0 - surf.along) * (0.16 + 0.74 * u), 0.22, 0.96);
      const col = samplePaletteColor(profile, along, hueJ, goldenSeed);

      const nUp = 0.86 - 0.16 * u;
      const lx = cx - sideX * hw, lz = cz - sideZ * hw;
      const rx2 = cx + sideX * hw, rz2 = cz + sideZ * hw;
      const iL = addVert(
        lx, cy, lz,
        surf.nx * 0.35 - sideX * 0.28 + dirX * 0.18 * u, nUp, surf.nz * 0.35 - sideZ * 0.28 + dirZ * 0.18 * u,
        col, along, stiff, wTag,
        retiring ? rootX - lx : 0,
        retiring ? rootZ - lz : 0,
      );
      const iR = addVert(
        rx2, cy, rz2,
        surf.nx * 0.35 + sideX * 0.28 + dirX * 0.18 * u, nUp, surf.nz * 0.35 + sideZ * 0.28 + dirZ * 0.18 * u,
        col, along, stiff, wTag,
        retiring ? rootX - rx2 : 0,
        retiring ? rootZ - rz2 : 0,
      );
      rowPairs.push([iL, iR, col]);
    }

    // Drooping, wind-swept feathery tendril tip (u = 1.0: sin(0.68 * pi) = 0.844 -> arches gracefully downward past crest!)
    const tipLat = sCurveSign * 0.045 * Math.sin(Math.PI * 1.35) * tallFactor;
    const tipX = rootX + dirX * tendrilSweep + sideX * tipLat;
    const tipY = rootY + tendrilRise * Math.sin(Math.PI * 0.68);
    const tipZ = rootZ + dirZ * tendrilSweep + sideZ * tipLat;
    const tipCol = samplePaletteColor(profile, 1.0, hueJ, goldenSeed);
    const iTip = addVert(
      tipX, tipY, tipZ,
      dirX * 0.32, 0.88, dirZ * 0.32,
      tipCol, 1.0, stiff * 0.82, wTag,
      retiring ? rootX - tipX : 0,
      retiring ? rootZ - tipZ : 0,
    );

    for (let s = 0; s < rowPairs.length - 1; s++) {
      const [aL, aR, colA] = rowPairs[s];
      const [bL, bR] = rowPairs[s + 1];
      addTri(aL, aR, bR, colA);
      addTri(aL, bR, bL, colA);
    }
    const [lastL, lastR] = rowPairs[rowPairs.length - 1];
    addTri(lastL, lastR, iTip, tipCol);
  }

  const meanCol = sumArea > 0 ? [sumR / sumArea, sumG / sumArea, sumB / sumArea] : profile.midCol;
  return { verts, tris, meanCol, maxY };
}

function buildGenusZeroContinuumForVariant(profile, tileMeanCol) {
  // Connected genus-0 billowing volumetric grass cloud continuum matching L3's exact footprint & silhouette:
  // bottom center (0) + MORPH_RINGS x MORPH_K rings + top center (V-1) -> V = 22, E = 60, F = 40 -> V - E + F = 2!
  const V = 2 + MORPH_RINGS * MORPH_K;
  const pos = new Float32Array(V * 3);
  const nrm = new Float32Array(V * 3);
  const col = new Float32Array(V * 3);
  const sway = new Float32Array(V * 3);

  const setV = (vi, x, y, z, nx, ny, nz, rgb, alongVal) => {
    pos[vi * 3] = x; pos[vi * 3 + 1] = y; pos[vi * 3 + 2] = z;
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm[vi * 3] = nx / len; nrm[vi * 3 + 1] = ny / len; nrm[vi * 3 + 2] = nz / len;
    col[vi * 3] = clamp(rgb[0], 0, 1);
    col[vi * 3 + 1] = clamp(rgb[1], 0, 1);
    col[vi * 3 + 2] = clamp(rgb[2], 0, 1);
    sway[vi * 3] = alongVal;
    sway[vi * 3 + 1] = profile.stiffness;
    sway[vi * 3 + 2] = alongVal * alongVal * 0.08;
  };

  setV(0, 0, -0.024, 0, 0, 0.98, 0, profile.rootCol, 0.0);
  for (let r = 0; r < MORPH_RINGS; r++) {
    const rf = 1.0 - 0.21 * r;
    const ringR = profile.cloudRadius * rf;
    for (let k = 0; k < MORPH_K; k++) {
      const a = (k / MORPH_K) * Math.PI * 2 + r * 0.26 + profile.phaseA * 0.2;
      const vi = 1 + r * MORPH_K + k;
      const lobe = 1.0 + 0.085 * Math.sin(k * 2.0 + r + profile.phaseB);
      const x = Math.cos(a) * ringR * lobe;
      const z = Math.sin(a) * ringR * lobe;
      const surf = evalCloudSurface(x, z, profile);
      const c = samplePaletteColor(profile, surf.along, hash01(profile.seed + 503, vi), 0.12);
      setV(vi, x, surf.y, z, surf.nx, surf.ny, surf.nz, c, surf.along);
    }
  }
  const topSurf = evalCloudSurface(0, 0, profile);
  const topC = samplePaletteColor(profile, topSurf.along + 0.12, 0.55, 0.18);
  setV(V - 1, 0, topSurf.y + 0.015, 0, 0, 1, 0, topC, clamp(topSurf.along + 0.12, 0, 1));

  const faces = [];
  for (let k = 0; k < MORPH_K; k++) {
    const kn = (k + 1) % MORPH_K;
    faces.push([0, 1 + kn, 1 + k]);
  }
  for (let r = 0; r < MORPH_RINGS - 1; r++) {
    const rowA = 1 + r * MORPH_K, rowB = 1 + (r + 1) * MORPH_K;
    for (let k = 0; k < MORPH_K; k++) {
      const kn = (k + 1) % MORPH_K;
      faces.push([rowA + k, rowA + kn, rowB + k]);
      faces.push([rowA + kn, rowB + kn, rowB + k]);
    }
  }
  const topRow = 1 + (MORPH_RINGS - 1) * MORPH_K;
  for (let k = 0; k < MORPH_K; k++) {
    const kn = (k + 1) % MORPH_K;
    faces.push([topRow + k, topRow + kn, V - 1]);
  }

  // Verify exact genus-0 Euler characteristic (V - E + F = 2)
  const edges = new Set();
  for (const [a, b, c] of faces) {
    edges.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    edges.add(b < c ? `${b}_${c}` : `${c}_${b}`);
    edges.add(c < a ? `${c}_${a}` : `${a}_${c}`);
  }
  const euler = V - edges.size + faces.length;
  if (euler !== 2) throw Error(`Genus-0 meadow continuum Euler=${euler}, expected 2`);

  const retireOrder = [];
  for (let r = 0; r < MORPH_RINGS; r++) {
    for (let k = 0; k < MORPH_K; k++) {
      const v = 1 + r * MORPH_K + k;
      if (r === MORPH_RINGS - 1 && k < 2) continue; // Keep 2 core anchors + pole0 + topPole = 4 verts / 4 core tris
      retireOrder.push({ v, target: k < 2 ? 1 + (MORPH_RINGS - 1) * MORPH_K + k : r === 0 ? 0 : V - 1 });
    }
  }
  const activeFaces = faces.map((f) => [...f]);
  const remap = new Int32Array(V);
  for (let i = 0; i < V; i++) remap[i] = i;

  const collapseSteps = [];
  for (let step = 0; step < Math.min(MORPH_STEPS, retireOrder.length); step++) {
    const { v, target } = retireOrder[step];
    let dst = target;
    while (remap[dst] !== dst) dst = remap[dst];
    remap[v] = dst;
    for (let f = 0; f < activeFaces.length; f++) {
      const tri = activeFaces[f];
      if (!tri) continue;
      for (let j = 0; j < 3; j++) if (tri[j] === v) tri[j] = dst;
      if (tri[0] === tri[1] || tri[1] === tri[2] || tri[2] === tri[0]) activeFaces[f] = null;
    }
    const err = +((0.052 + ((step + 1) / MORPH_STEPS) * 0.25).toFixed(4));
    collapseSteps.push({ retired: v, dst, err, aliveTris: activeFaces.filter(Boolean).length });
  }

  return {
    vertexCount: V,
    faceCount: faces.length,
    euler,
    coreTriCount: activeFaces.filter(Boolean).length,
    pos,
    nrm,
    col,
    sway,
    faces,
    collapseSteps,
    splat: {
      centreY: +(profile.cloudHeight * 0.44).toFixed(4),
      rx: +(profile.cloudRadius * 0.92).toFixed(4),
      ry: +(Math.min(0.115, profile.cloudHeight * 0.56)).toFixed(4),
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
  let stiffSum = 0, maxY = 0.28, nSamples = 0;

  const step = Math.max(3, Math.floor((endI - startI) / 1800) * 3);
  for (let ii = startI; ii < endI; ii += step) {
    const s = srcIndices[ii] * SOURCE_STRIDE;
    const py = srcVerts[s + 1];
    const cr = srcVerts[s + 6], cg = srcVerts[s + 7], cb = srcVerts[s + 8];
    const along = srcVerts[s + 9];
    const stiff = Math.max(0.4, srcVerts[s + 10]);
    if (py > maxY) maxY = py;
    stiffSum += stiff;
    nSamples++;
    if (along < 0.28) {
      rootR += cr; rootG += cg; rootB += cb; rootN++;
    } else if (along < 0.72) {
      midR += cr; midG += cg; midB += cb; midN++;
    } else {
      tipR += cr; tipG += cg; tipB += cb; tipN++;
    }
  }

  // Convert source sRGB botanical samples to physically calibrated linear PBR reflectance
  // matching Lisbon's landAlbedo / forestCrown chlorophyll radiometric units (zero ACES white-out!).
  const toLin = (c) => Math.pow(clamp(c, 0, 1), 2.2);
  const rawRoot = rootN > 0 ? [toLin(rootR / rootN), toLin(rootG / rootN), toLin(rootB / rootN)] : [0.012, 0.034, 0.008];
  const rawMid = midN > 0 ? [toLin(midR / midN), toLin(midG / midN), toLin(midB / midN)] : [0.028, 0.072, 0.015];
  const rawTip = tipN > 0 ? [toLin(tipR / tipN), toLin(tipG / tipN), toLin(tipB / tipN)] : [0.052, 0.112, 0.022];

  // Mix-specific Mediterranean botanical character:
  // 0 = lush emerald-olive grazed pasture, 1 = taller tussocky coastal rough meadow, 2 = wild oat & golden-tipped field margin
  const mixCloudH = [0.215, 0.255, 0.285][mixIdx];
  const mixTendrilH = [0.22, 0.29, 0.35][mixIdx];
  const mixGolden = [0.10, 0.24, 0.38][mixIdx];
  const variantId = mixIdx * VARIANTS + vIdx;
  const seed = 0x517cc1b7 ^ (variantId * 7919);

  return {
    variantId,
    seed,
    cloudRadius: 1.20, // Overlaps 1.35 m neighbor tiles generously across all slopes and jitter
    cloudHeight: mixCloudH * (0.94 + 0.12 * hash01(seed, 1)),
    tendrilHeight: clamp(mixTendrilH * (0.92 + 0.18 * hash01(seed, 2)), 0.18, Math.min(0.42, maxY * 0.90)),
    stiffness: nSamples > 0 ? clamp(stiffSum / nSamples, 3.0, 22.0) : 10.0,
    layAngle: hash01(seed, 3) * Math.PI * 2,
    phaseA: hash01(seed, 4) * Math.PI * 2,
    phaseB: hash01(seed, 5) * Math.PI * 2,
    phaseC: hash01(seed, 6) * Math.PI * 2,
    seedGolden: mixGolden,
    rootCol: [
      clamp(rawRoot[0] * 0.65 + 0.008, 0.008, 0.032),
      clamp(rawRoot[1] * 0.85 + 0.024, 0.024, 0.068),
      clamp(rawRoot[2] * 0.60 + 0.004, 0.004, 0.020),
    ],
    midCol: [
      clamp(rawMid[0] * 0.72 + 0.016, 0.018, 0.062),
      clamp(rawMid[1] * 0.95 + 0.048, 0.048, 0.120),
      clamp(rawMid[2] * 0.65 + 0.009, 0.009, 0.034),
    ],
    tipCol: [
      clamp(rawTip[0] * 0.80 + 0.030, 0.034, 0.105),
      clamp(rawTip[1] * 1.02 + 0.072, 0.078, 0.168),
      clamp(rawTip[2] * 0.72 + 0.014, 0.014, 0.048),
    ],
    seedCol: [0.105, 0.112, 0.028], // Sunlit Mediterranean oat / dry grass gold accent in linear PBR units
  };
}

function main() {
  const srcManifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'manifest.json'), 'utf8'));
  const vb = zlib.gunzipSync(fs.readFileSync(path.join(SRC_DIR, 'vertices.bin.gz')));
  const ib = zlib.gunzipSync(fs.readFileSync(path.join(SRC_DIR, 'indices.bin.gz')));
  const srcVerts = new Float32Array(vb.buffer, vb.byteOffset, vb.byteLength / 4);
  const srcIndices = new Uint32Array(ib.buffer, ib.byteOffset, ib.byteLength / 4);

  const outVerts = [];
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
      const variantId = profile.variantId;
      const clusterFirst = clusterRecords.length / CLUSTER_WORDS;
      let l0MeanCol = profile.midCol;

      for (let lvl = 0; lvl < 4; lvl++) {
        const firstIdx = outIndices.length;
        const baseVertOffset = outVerts.length / GPU_VERTEX_WORDS;
        const geo = buildVolumetricTendrilLevel(profile, lvl);
        if (lvl === 0) l0MeanCol = geo.meanCol;
        for (let k = 0; k < geo.verts.length; k++) outVerts.push(geo.verts[k]);
        for (let k = 0; k < geo.tris.length; k++) outIndices.push(baseVertOffset + geo.tris[k]);
        clusterRecords.push(
          firstIdx,
          geo.tris.length,
          lvl,
          LEVEL_PARENT_ERRORS[lvl],
          LEVEL_ERRORS[lvl],
          half,
          geo.maxY * 0.45,
          half,
          Math.hypot(profile.cloudRadius, geo.maxY * 0.6),
          variantId,
          0,
          0,
        );
      }

      const cont = buildGenusZeroContinuumForVariant(profile, l0MeanCol);
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

  // Pack mixed float32/uint32 buffers cleanly
  const vertBuf = new ArrayBuffer(outVerts.length * 4);
  const vf32 = new Float32Array(vertBuf), vu32 = new Uint32Array(vertBuf);
  for (let i = 0; i < outVerts.length; i += GPU_VERTEX_WORDS) {
    vf32[i] = outVerts[i];
    vf32[i + 1] = outVerts[i + 1];
    vf32[i + 2] = outVerts[i + 2];
    vu32[i + 3] = outVerts[i + 3] >>> 0;
    vu32[i + 4] = outVerts[i + 4] >>> 0;
    vf32[i + 5] = outVerts[i + 5];
    vf32[i + 6] = outVerts[i + 6];
    vu32[i + 7] = outVerts[i + 7] >>> 0;
  }
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

  // Pack morph.bin: per-variant continuum (V*8 GPU verts + F*3 u32 face indices + MORPH_STEPS*4 collapse u32/f32)
  const MORPH_VERT_FLOATS = 8;
  const perVarVertBytes = (2 + MORPH_RINGS * MORPH_K) * MORPH_VERT_FLOATS * 4;
  const perVarFaceBytes = (MORPH_RINGS * MORPH_K * 2) * 3 * 4;
  const perVarStepBytes = MORPH_STEPS * 4 * 4;
  const perVarBytes = perVarVertBytes + perVarFaceBytes + perVarStepBytes;
  const morphBuf = new ArrayBuffer(morphRecords.length * perVarBytes);
  const mf32 = new Float32Array(morphBuf), mu32 = new Uint32Array(morphBuf);
  for (let mIdx = 0; mIdx < morphRecords.length; mIdx++) {
    const mr = morphRecords[mIdx];
    const baseWord = (mIdx * perVarBytes) / 4;
    for (let vi = 0; vi < mr.vertexCount; vi++) {
      const vw = baseWord + vi * MORPH_VERT_FLOATS;
      mf32[vw] = mr.pos[vi * 3];
      mf32[vw + 1] = mr.pos[vi * 3 + 1];
      mf32[vw + 2] = mr.pos[vi * 3 + 2];
      mu32[vw + 3] = packSnorm8x4(mr.nrm[vi * 3], mr.nrm[vi * 3 + 1], mr.nrm[vi * 3 + 2]);
      mu32[vw + 4] = packColorUnorm8x4(mr.col[vi * 3], mr.col[vi * 3 + 1], mr.col[vi * 3 + 2], 1);
      mf32[vw + 5] = mr.sway[vi * 3];
      mf32[vw + 6] = mr.sway[vi * 3 + 1];
      mf32[vw + 7] = mr.sway[vi * 3 + 2];
    }
    const faceBaseWord = baseWord + perVarVertBytes / 4;
    for (let fi = 0; fi < mr.faceCount; fi++) {
      mu32[faceBaseWord + fi * 3] = mr.faces[fi][0];
      mu32[faceBaseWord + fi * 3 + 1] = mr.faces[fi][1];
      mu32[faceBaseWord + fi * 3 + 2] = mr.faces[fi][2];
    }
    const stepBaseWord = faceBaseWord + perVarFaceBytes / 4;
    for (let si = 0; si < MORPH_STEPS; si++) {
      const st = mr.collapseSteps[si];
      mu32[stepBaseWord + si * 4] = st.retired;
      mu32[stepBaseWord + si * 4 + 1] = st.dst;
      mf32[stepBaseWord + si * 4 + 2] = st.err;
      mu32[stepBaseWord + si * 4 + 3] = st.aliveTris;
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const filesMeta = {};
  const writeStream = (name, rawBuf) => {
    const raw = Buffer.from(rawBuf.buffer ?? rawBuf, rawBuf.byteOffset ?? 0, rawBuf.byteLength);
    const gz = zlib.gzipSync(raw, { level: 9 });
    fs.writeFileSync(path.join(OUT_DIR, `${name}.gz`), gz);
    filesMeta[name] = { bytes: raw.byteLength, gzipBytes: gz.byteLength, sha256: sha256Hex(raw) };
  };
  writeStream('vertices.bin', new Uint8Array(vertBuf));
  writeStream('indices.bin', idxBuf);
  writeStream('clusters.bin', new Uint8Array(clBuf));
  writeStream('morph.bin', new Uint8Array(morphBuf));

  const outManifest = {
    format: 'waterworld.meadow-grass-gpu',
    version: 2,
    style: 'volumetric-cloud-tendrils',
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
      rings: MORPH_RINGS,
      ringSegments: MORPH_K,
      vertexCount: 2 + MORPH_RINGS * MORPH_K,
      faceCount: MORPH_RINGS * MORPH_K * 2,
      steps: MORPH_STEPS,
      bytesPerVariant: perVarBytes,
    },
    vertexCount: outVerts.length / GPU_VERTEX_WORDS,
    triangleCount: outIndices.length / 3,
    clusterCount: clusterRecords.length / CLUSTER_WORDS,
    variantRecords,
    files: filesMeta,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(outManifest, null, 2));
  const totalGz = Object.values(filesMeta).reduce((s, f) => s + f.gzipBytes, 0);
  console.log(`Baked meadows-gpu (volumetric-cloud-tendrils): ${outManifest.vertexCount} verts, ${outManifest.triangleCount} tris, ${outManifest.clusterCount} clusters, ${(totalGz / 1024).toFixed(1)} KB gz total`);
}

main();
