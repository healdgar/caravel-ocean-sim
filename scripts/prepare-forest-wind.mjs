#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes mesh-derived skeletal wind hierarchies (<= 32 bones/prototype), bottom-up cumulative
// wood + foliage mass & canopy-sheltered aerodynamic drag moments, and bark-locked dual-bone
// cluster vertex weights for GPU Dynamic Wind simulation (js/forest-wind.js).
//   node scripts/prepare-forest-wind.mjs [portugal|subtropical|saba]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  FOREST_WIND_BONES,
  FOREST_WIND_BONE_FLOATS,
  packForestWindWeight,
  validateForestWindManifest,
} from '../js/forest-wind.js';
import { FOREST_CLUSTER_VERTEX_WORDS, FOREST_CLUSTER_WORDS, FOREST_LEAF_VERTICES } from '../js/forest-clusters.js';

const WOOD_DENSITY_KG_M3 = 700.0;
const LEAF_AREAL_DENSITY_KG_M2 = 0.60;
const LEAF_SILHOUETTE_FILL = 0.56;
const LEAF_OPTICAL_DEPTH = 0.40;
const REF_WIND_SPEED_MS = 10.0;
const REF_DYN_PRESSURE_PA = 0.6125 * REF_WIND_SPEED_MS * REF_WIND_SPEED_MS;

const args = process.argv.slice(2);
const packNames = args.filter((a) => !a.startsWith('--'));
const targets = packNames.length ? packNames : ['portugal'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hypot3 = (x, y, z) => Math.hypot(x, y, z);

function normalize3(x, y, z, fallback = [0, 1, 0]) {
  const len = Math.hypot(x, y, z);
  return len > 1e-6 ? [x / len, y / len, z / len] : fallback;
}

function pointSegClosest(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const ab2 = abx * abx + aby * aby + abz * abz;
  const t = ab2 > 1e-8 ? clamp(((px - ax) * abx + (py - aby === py ? 0 : 0) + (py - ay) * aby + (pz - az) * abz) / ab2, 0, 1) : 0;
  const cx = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
  const dx = px - cx, dy = py - cy, dz = pz - cz;
  return { d2: dx * dx + dy * dy + dz * dz, t, cx, cy, cz };
}

function farthestPointSample(points, k, weightFn = null) {
  const n = points.length / 3;
  if (n === 0 || k <= 0) return [];
  const chosen = [];
  let first = 0, bestInit = -1;
  for (let i = 0; i < n; i++) {
    const w = weightFn ? weightFn(i) : (points[i * 3] ** 2 + points[i * 3 + 2] ** 2 + points[i * 3 + 1] ** 2 * 0.25);
    if (w > bestInit) { bestInit = w; first = i; }
  }
  chosen.push(first);
  const minDist2 = new Float32Array(n).fill(Infinity);
  while (chosen.length < k && chosen.length < n) {
    const last = chosen[chosen.length - 1];
    const lx = points[last * 3], ly = points[last * 3 + 1], lz = points[last * 3 + 2];
    let next = -1, bestScore = -1;
    for (let i = 0; i < n; i++) {
      const dx = points[i * 3] - lx, dy = points[i * 3 + 1] - ly, dz = points[i * 3 + 2] - lz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < minDist2[i]) minDist2[i] = d2;
      const score = minDist2[i] * (weightFn ? weightFn(i) : 1.0);
      if (score > bestScore) { bestScore = score; next = i; }
    }
    if (next < 0 || bestScore <= 1e-8) break;
    chosen.push(next);
  }
  return chosen;
}

function hashU32(x) {
  let v = x >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d) >>> 0;
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

function unpackClusterPosUv(vWords, vertexIdx, quant) {
  const at = vertexIdx * FOREST_CLUSTER_VERTEX_WORDS;
  const w0 = vWords[at], w1 = vWords[at + 1], w3 = vWords[at + 3];
  const px = quant.low[0] + ((w0 & 65535) / 65535) * quant.posScale;
  const py = quant.low[1] + ((w0 >>> 16) / 65535) * quant.posScale;
  const pz = quant.low[2] + ((w1 & 65535) / 65535) * quant.posScale;
  const u = quant.uvLow[0] + ((w3 & 65535) / 65535) * quant.uvScale[0];
  const v = quant.uvLow[1] + ((w3 >>> 16) / 65535) * quant.uvScale[1];
  return { px, py, pz, u, v };
}

function extractSourceElements(proto, sourceFloats, sourceIndices) {
  const STRIDE = 14;
  // Wood triangles: area, centroid, and estimated cylindrical volume element.
  const woodTris = [];
  const wStart = proto.wood.firstIndex, wEnd = wStart + proto.wood.indexCount;
  for (let i = wStart; i + 2 < wEnd; i += 3) {
    const i0 = sourceIndices[i] * STRIDE, i1 = sourceIndices[i + 1] * STRIDE, i2 = sourceIndices[i + 2] * STRIDE;
    const x0 = sourceFloats[i0], y0 = sourceFloats[i0 + 1], z0 = sourceFloats[i0 + 2];
    const x1 = sourceFloats[i1], y1 = sourceFloats[i1 + 1], z1 = sourceFloats[i1 + 2];
    const x2 = sourceFloats[i2], y2 = sourceFloats[i2 + 1], z2 = sourceFloats[i2 + 2];
    const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3, cz = (z0 + z1 + z2) / 3;
    const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
    const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const area = 0.5 * Math.hypot(nx, ny, nz);
    if (!(area > 1e-8)) continue;
    // Estimate local branch radius from cross-edge span so tube surface area maps to wood volume (V ~= 0.5 * r * A_surface).
    const e3x = x2 - x1, e3y = y2 - y1, e3z = z2 - z1;
    const l1 = Math.hypot(e1x, e1y, e1z), l2 = Math.hypot(e2x, e2y, e2z), l3 = Math.hypot(e3x, e3y, e3z);
    const minEdge = Math.min(l1, l2, l3);
    const estRadius = clamp(minEdge * 0.85, 0.004, Math.max(0.08, (proto.dbhCentimetres ? proto.dbhCentimetres / 200 : proto.basalRadius || 0.35)));
    const vol = area * estRadius * 0.5;
    const mass = vol * WOOD_DENSITY_KG_M3;
    const dragArea = area * 0.32; // projected cylinder drag ~ 1/pi of bark circumference area
    woodTris.push({ cx, cy, cz, area, estRadius, mass, dragArea });
  }

  // Leaf shoots / fronds: area, centroid, and canopy-sheltered drag.
  const leafElems = [];
  const lStart = proto.leaf.firstIndex, lEnd = lStart + proto.leaf.indexCount;
  let crownSumX = 0, crownSumY = 0, crownSumZ = 0, crownAreaSum = 0;
  for (let i = lStart; i + 2 < lEnd; i += 3) {
    const i0 = sourceIndices[i] * STRIDE, i1 = sourceIndices[i + 1] * STRIDE, i2 = sourceIndices[i + 2] * STRIDE;
    const x0 = sourceFloats[i0], y0 = sourceFloats[i0 + 1], z0 = sourceFloats[i0 + 2];
    const x1 = sourceFloats[i1], y1 = sourceFloats[i1 + 1], z1 = sourceFloats[i1 + 2];
    const x2 = sourceFloats[i2], y2 = sourceFloats[i2 + 1], z2 = sourceFloats[i2 + 2];
    const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3, cz = (z0 + z1 + z2) / 3;
    const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
    const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
    const area = 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    if (!(area > 1e-8)) continue;
    crownSumX += cx * area; crownSumY += cy * area; crownSumZ += cz * area; crownAreaSum += area;
    leafElems.push({ cx, cy, cz, area });
  }
  const crownMid = crownAreaSum > 0 ? [crownSumX / crownAreaSum, crownSumY / crownAreaSum, crownSumZ / crownAreaSum] : [0, proto.high[1] * 0.6, 0];
  let maxCrownR = 0.5;
  for (const e of leafElems) {
    const d = hypot3(e.cx - crownMid[0], (e.cy - crownMid[1]) * 0.85, e.cz - crownMid[2]);
    if (d > maxCrownR) maxCrownR = d;
  }
  for (const e of leafElems) {
    const rNorm = clamp(hypot3(e.cx - crownMid[0], (e.cy - crownMid[1]) * 0.85, e.cz - crownMid[2]) / maxCrownR, 0, 1);
    const opticalDepth = (1.0 - rNorm) * 2.2; // deeper interior foliage is sheltered by outer canopy
    const shelter = Math.exp(-LEAF_OPTICAL_DEPTH * opticalDepth);
    const effBladeArea = e.area * LEAF_SILHOUETTE_FILL;
    e.mass = effBladeArea * LEAF_AREAL_DENSITY_KG_M2;
    e.dragArea = effBladeArea * shelter * 0.72;
  }
  return { woodTris, leafElems, crownMid, maxCrownR };
}

function buildPrototypeSkeleton(proto, elems) {
  const { woodTris, leafElems, crownMid, maxCrownR } = elems;
  const groundY = Math.max(0, proto.low[1]);
  const topY = Math.max(groundY + 0.8, proto.high[1]);
  const H = topY - groundY;
  const isPalm = proto.species === 'palm' || proto.species === 'royal_palm';
  const stemDiam = proto.dbhCentimetres ? (proto.dbhCentimetres / 100) : Math.max(0.05, (proto.basalRadius || 0.25) * 1.35);

  const bones = []; // { parent, group, active, pivot:[x,y,z], tip:[x,y,z], radius, chainT }

  if (isPalm) {
    // 6 trunk bones up to crown shaft (~0.77 * topY), then 13 frond rachises + 13 frond tips = 32 bones.
    const shaftTopY = groundY + H * 0.77;
    const trunkSteps = 6;
    const spinePts = [];
    let curX = 0, curZ = 0;
    for (let s = 0; s <= trunkSteps; s++) {
      const yLo = groundY + (s - 0.5) * ((shaftTopY - groundY) / trunkSteps);
      const yHi = groundY + (s + 0.5) * ((shaftTopY - groundY) / trunkSteps);
      let sx = 0, sz = 0, sw = 0;
      for (const w of woodTris) {
        if (w.cy >= yLo && w.cy <= yHi && Math.hypot(w.cx - curX, w.cz - curZ) < Math.max(1.8, maxCrownR * 0.45)) {
          sx += w.cx * w.area; sz += w.cz * w.area; sw += w.area;
        }
      }
      if (sw > 0) { curX = sx / sw; curZ = sz / sw; }
      spinePts.push([curX, groundY + (s / trunkSteps) * (shaftTopY - groundY), curZ]);
    }
    for (let b = 0; b < trunkSteps; b++) {
      bones.push({
        parent: b - 1,
        group: 0,
        active: 1,
        pivot: spinePts[b],
        tip: spinePts[b + 1],
        radius: Math.max(0.08, stemDiam * 0.5 * (1 - 0.35 * (b / trunkSteps))),
        chainT: (b + 0.6) / trunkSteps,
      });
    }
    const crownHub = spinePts[trunkSteps];
    // Sample outer frond points via 3D FPS.
    const outerPts = [];
    for (let i = 0; i < leafElems.length; i += Math.max(1, Math.floor(leafElems.length / 1800))) {
      const e = leafElems[i];
      const d = hypot3(e.cx - crownHub[0], e.cy - crownHub[1], e.cz - crownHub[2]);
      if (d > maxCrownR * 0.35) outerPts.push(e.cx, e.cy, e.cz);
    }
    const frondSeeds = farthestPointSample(outerPts, 13);
    const frondCount = frondSeeds.length;
    for (let k = 0; k < 13; k++) {
      const idx = frondSeeds[k % Math.max(1, frondCount)] ?? 0;
      const ox = outerPts.length ? outerPts[idx * 3] : crownHub[0] + Math.cos((k / 13) * Math.PI * 2) * maxCrownR;
      const oy = outerPts.length ? outerPts[idx * 3 + 1] : crownHub[1] + 0.5;
      const oz = outerPts.length ? outerPts[idx * 3 + 2] : crownHub[2] + Math.sin((k / 13) * Math.PI * 2) * maxCrownR;
      const dir = normalize3(ox - crownHub[0], oy - crownHub[1], oz - crownHub[2]);
      const piv = [crownHub[0] + dir[0] * 0.14, crownHub[1] + dir[1] * 0.08, crownHub[2] + dir[2] * 0.14];
      const mid = [
        piv[0] + (ox - piv[0]) * 0.54,
        piv[1] + (oy - piv[1]) * 0.54 + 0.28,
        piv[2] + (oz - piv[2]) * 0.54,
      ];
      bones.push({
        parent: trunkSteps - 1,
        group: 1,
        active: 1,
        pivot: piv,
        tip: mid,
        radius: 0.06,
        chainT: 0.48,
      });
    }
    for (let k = 0; k < 13; k++) {
      const rachis = bones[trunkSteps + k];
      const idx = frondSeeds[k % Math.max(1, frondCount)] ?? 0;
      const ox = outerPts.length ? outerPts[idx * 3] : rachis.tip[0] * 1.6;
      const oy = outerPts.length ? outerPts[idx * 3 + 1] : rachis.tip[1] - 0.3;
      const oz = outerPts.length ? outerPts[idx * 3 + 2] : rachis.tip[2] * 1.6;
      bones.push({
        parent: trunkSteps + k,
        group: 2,
        active: 1,
        pivot: [...rachis.tip],
        tip: [ox, oy, oz],
        radius: 0.03,
        chainT: 0.92,
      });
    }
  } else {
    // Broadleaf tree / shrub: 5 trunk spine bones (0..4) + 9 primary boughs (5..13) + 18 outer branchlets (14..31) = 32 bones.
    const yFracs = [0.0, 0.14, 0.30, 0.48, 0.66, 0.84];
    const spinePts = [];
    let curX = 0, curZ = 0;
    for (let s = 0; s < yFracs.length; s++) {
      const targetY = groundY + yFracs[s] * H;
      const bandHalf = 0.09 * H;
      const searchR = s === 0 ? Math.max(0.8, stemDiam * 1.6) : Math.max(0.45, maxCrownR * (0.22 + 0.12 * s));
      let sx = 0, sz = 0, sw = 0;
      for (const w of woodTris) {
        if (Math.abs(w.cy - targetY) <= bandHalf && Math.hypot(w.cx - curX, w.cz - curZ) <= searchR) {
          const wt = w.mass / (0.05 + Math.hypot(w.cx - curX, w.cz - curZ));
          sx += w.cx * wt; sz += w.cz * wt; sw += wt;
        }
      }
      if (sw > 0) { curX = sx / sw; curZ = sz / sw; }
      spinePts.push([curX, targetY, curZ]);
    }
    const trunkChainTs = [0.08, 0.24, 0.44, 0.68, 0.90];
    for (let b = 0; b < 5; b++) {
      bones.push({
        parent: b - 1,
        group: 0,
        active: 1,
        pivot: spinePts[b],
        tip: spinePts[b + 1],
        radius: Math.max(0.015, stemDiam * 0.5 * (1 - 0.58 * (b / 5))),
        chainT: trunkChainTs[b],
      });
    }

    const spineAtY = (y) => {
      const f = clamp((y - groundY) / H, 0, yFracs[5]);
      for (let b = 0; b < 5; b++) {
        if (f <= yFracs[b + 1] || b === 4) {
          const u = clamp((f - yFracs[b]) / Math.max(1e-4, yFracs[b + 1] - yFracs[b]), 0, 1);
          return {
            boneIdx: b,
            x: spinePts[b][0] + (spinePts[b + 1][0] - spinePts[b][0]) * u,
            y: spinePts[b][1] + (spinePts[b + 1][1] - spinePts[b][1]) * u,
            z: spinePts[b][2] + (spinePts[b + 1][2] - spinePts[b][2]) * u,
          };
        }
      }
      return { boneIdx: 4, x: spinePts[5][0], y: spinePts[5][1], z: spinePts[5][2] };
    };

    // Candidate crown points for 9 primary boughs.
    const candPts = [];
    const candRadial = [];
    const stepW = Math.max(1, Math.floor(woodTris.length / 2200));
    for (let i = 0; i < woodTris.length; i += stepW) {
      const w = woodTris[i];
      if (w.cy < groundY + 0.15 * H) continue;
      const sp = spineAtY(w.cy);
      const r = Math.hypot(w.cx - sp.x, w.cz - sp.z);
      if (r > Math.max(stemDiam * 0.85, maxCrownR * 0.16)) {
        candPts.push(w.cx, w.cy, w.cz);
        candRadial.push(r);
      }
    }
    const stepL = Math.max(1, Math.floor(leafElems.length / 1800));
    for (let i = 0; i < leafElems.length; i += stepL) {
      const e = leafElems[i];
      const sp = spineAtY(e.cy);
      const r = Math.hypot(e.cx - sp.x, e.cz - sp.z);
      if (r > maxCrownR * 0.22) {
        candPts.push(e.cx, e.cy, e.cz);
        candRadial.push(r);
      }
    }

    const boughSeeds = farthestPointSample(candPts, 9, (idx) => 0.35 + candRadial[idx]);
    const boughCount = Math.max(1, boughSeeds.length);
    for (let s = 0; s < 9; s++) {
      const seedIdx = boughSeeds[s % boughCount] ?? 0;
      const sx = candPts.length ? candPts[seedIdx * 3] : crownMid[0] + Math.cos((s / 9) * Math.PI * 2) * maxCrownR * 0.7;
      const sy = candPts.length ? candPts[seedIdx * 3 + 1] : groundY + (0.35 + 0.45 * ((s % 3) / 2)) * H;
      const sz = candPts.length ? candPts[seedIdx * 3 + 2] : crownMid[2] + Math.sin((s / 9) * Math.PI * 2) * maxCrownR * 0.7;
      const spSeed = spineAtY(sy);
      // Fork sits slightly lower on the trunk than the outer bough tip, following natural upward branch angle (~25-35 deg).
      const reachXZ = Math.hypot(sx - spSeed.x, sz - spSeed.z);
      const forkY = clamp(sy - reachXZ * 0.32, groundY + 0.13 * H, groundY + 0.80 * H);
      const fork = spineAtY(forkY);
      const outDir = normalize3(sx - fork.x, 0, sz - fork.z, [1, 0, 0]);
      const collarR = Math.max(0.01, stemDiam * 0.32 * (1 - 0.5 * ((forkY - groundY) / H)));
      const piv = [fork.x + outDir[0] * collarR, fork.y, fork.z + outDir[2] * collarR];
      const tip = [
        piv[0] + (sx - piv[0]) * 0.58,
        piv[1] + (sy - piv[1]) * 0.58,
        piv[2] + (sz - piv[2]) * 0.58,
      ];
      bones.push({
        parent: fork.boneIdx, // strictly in 0..4 < 5 + s
        group: 1,
        active: 1,
        pivot: piv,
        tip,
        radius: Math.max(0.008, stemDiam * 0.14),
        chainT: 0.52,
      });
    }

    // 18 secondary / terminal branchlet clusters across outer foliage & twigs.
    const twigCandPts = [];
    const twigRadii = [];
    for (let i = 0; i < leafElems.length; i += Math.max(1, Math.floor(leafElems.length / 2600))) {
      const e = leafElems[i];
      const sp = spineAtY(e.cy);
      const r = hypot3(e.cx - sp.x, (e.cy - crownMid[1]) * 0.6, e.cz - sp.z);
      twigCandPts.push(e.cx, e.cy, e.cz);
      twigRadii.push(r);
    }
    const twigSeeds = farthestPointSample(twigCandPts, 18, (idx) => 0.25 + twigRadii[idx]);
    const twigSeedCount = Math.max(1, twigSeeds.length);
    for (let m = 0; m < 18; m++) {
      const seedIdx = twigSeeds[m % twigSeedCount] ?? 0;
      const tx = twigCandPts.length ? twigCandPts[seedIdx * 3] : crownMid[0] + Math.cos((m / 18) * Math.PI * 2) * maxCrownR * 0.9;
      const ty = twigCandPts.length ? twigCandPts[seedIdx * 3 + 1] : groundY + (0.3 + 0.6 * ((m % 4) / 3)) * H;
      const tz = twigCandPts.length ? twigCandPts[seedIdx * 3 + 2] : crownMid[2] + Math.sin((m / 18) * Math.PI * 2) * maxCrownR * 0.9;
      // Parent to the nearest primary bough (5..13).
      let bestParent = 5, bestDist2 = Infinity, bestAnchor = [bones[5].tip[0], bones[5].tip[1], bones[5].tip[2]];
      for (let b = 5; b <= 13; b++) {
        const seg = pointSegClosest(tx, ty, tz, bones[b].pivot[0], bones[b].pivot[1], bones[b].pivot[2], bones[b].tip[0], bones[b].tip[1], bones[b].tip[2]);
        // Bias toward the outer half of the bough (t >= 0.45) so branchlets fork naturally off bough reaches.
        const anchorT = clamp(Math.max(0.45, seg.t), 0.45, 1.0);
        const ax = bones[b].pivot[0] + (bones[b].tip[0] - bones[b].pivot[0]) * anchorT;
        const ay = bones[b].pivot[1] + (bones[b].tip[1] - bones[b].pivot[1]) * anchorT;
        const az = bones[b].pivot[2] + (bones[b].tip[2] - bones[b].pivot[2]) * anchorT;
        const d2 = (tx - ax) ** 2 + (ty - ay) ** 2 + (tz - az) ** 2;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestParent = b;
          bestAnchor = [ax, ay, az];
        }
      }
      bones.push({
        parent: bestParent, // strictly in 5..13 < 14 + m
        group: 2,
        active: 1,
        pivot: bestAnchor,
        tip: [tx, ty, tz],
        radius: Math.max(0.004, stemDiam * 0.045),
        chainT: 0.90,
      });
    }
  }

  while (bones.length < FOREST_WIND_BONES) {
    bones.push({ parent: 0, group: 2, active: 0, pivot: [0, 0, 0], tip: [0, 0.1, 0], radius: 0.01, chainT: 0 });
  }

  // Verify strict topological order.
  for (let b = 0; b < FOREST_WIND_BONES; b++) {
    if (bones[b].active && !(bones[b].parent < b)) {
      throw Error(`${proto.species}: bone ${b} parent ${bones[b].parent} violates topological order`);
    }
  }

  // Assign every source wood & leaf element to its closest active bone capsule, then propagate mass & drag bottom-up!
  const ownMass = new Float64Array(FOREST_WIND_BONES);
  const ownDrag = new Float64Array(FOREST_WIND_BONES);
  const ownMomX = new Float64Array(FOREST_WIND_BONES), ownMomY = new Float64Array(FOREST_WIND_BONES), ownMomZ = new Float64Array(FOREST_WIND_BONES);
  const ownPressX = new Float64Array(FOREST_WIND_BONES), ownPressY = new Float64Array(FOREST_WIND_BONES), ownPressZ = new Float64Array(FOREST_WIND_BONES);

  const nearestBoneFor = (px, py, pz, preferOuter = false) => {
    let bestB = 0, bestScore = Infinity;
    for (let b = 0; b < FOREST_WIND_BONES; b++) {
      const bone = bones[b];
      if (!bone.active) continue;
      if (preferOuter && bone.group === 0 && py > groundY + 0.30 * H) continue;
      const seg = pointSegClosest(px, py, pz, bone.pivot[0], bone.pivot[1], bone.pivot[2], bone.tip[0], bone.tip[1], bone.tip[2]);
      const dist = Math.max(0, Math.sqrt(seg.d2) - bone.radius);
      const groupBias = preferOuter ? (bone.group === 2 ? 0.88 : bone.group === 1 ? 0.96 : 1.15) : 1.0;
      const score = dist * groupBias;
      if (score < bestScore) { bestScore = score; bestB = b; }
    }
    return bestB;
  };

  for (const w of woodTris) {
    const b = nearestBoneFor(w.cx, w.cy, w.cz, false);
    ownMass[b] += w.mass;
    ownDrag[b] += w.dragArea;
    ownMomX[b] += w.cx * w.mass; ownMomY[b] += w.cy * w.mass; ownMomZ[b] += w.cz * w.mass;
    ownPressX[b] += w.cx * w.dragArea; ownPressY[b] += w.cy * w.dragArea; ownPressZ[b] += w.cz * w.dragArea;
  }
  for (const e of leafElems) {
    const b = nearestBoneFor(e.cx, e.cy, e.cz, true);
    ownMass[b] += e.mass;
    ownDrag[b] += e.dragArea;
    ownMomX[b] += e.cx * e.mass; ownMomY[b] += e.cy * e.mass; ownMomZ[b] += e.cz * e.mass;
    ownPressX[b] += e.cx * e.dragArea; ownPressY[b] += e.cy * e.dragArea; ownPressZ[b] += e.cz * e.dragArea;
  }

  // Ensure every active bone has non-zero baseline structural mass & drag even if a sector is sparse.
  for (let b = 0; b < FOREST_WIND_BONES; b++) {
    const bone = bones[b];
    if (!bone.active) continue;
    const len = Math.max(0.08, hypot3(bone.tip[0] - bone.pivot[0], bone.tip[1] - bone.pivot[1], bone.tip[2] - bone.pivot[2]));
    const minMass = Math.PI * bone.radius * bone.radius * len * WOOD_DENSITY_KG_M3 * 0.35;
    const minDrag = Math.max(0.02, bone.radius * 2 * len * 0.5);
    const mx = 0.5 * (bone.pivot[0] + bone.tip[0]), my = 0.5 * (bone.pivot[1] + bone.tip[1]), mz = 0.5 * (bone.pivot[2] + bone.tip[2]);
    if (ownMass[b] < minMass) {
      const add = minMass - ownMass[b];
      ownMass[b] += add;
      ownMomX[b] += mx * add; ownMomY[b] += my * add; ownMomZ[b] += mz * add;
    }
    if (ownDrag[b] < minDrag) {
      const add = minDrag - ownDrag[b];
      ownDrag[b] += add;
      ownPressX[b] += mx * add; ownPressY[b] += my * add; ownPressZ[b] += mz * add;
    }
  }

  // Bottom-up cumulative propagation (b = 31 down to 0).
  const cumMass = Float64Array.from(ownMass);
  const cumDrag = Float64Array.from(ownDrag);
  const cumMomX = Float64Array.from(ownMomX), cumMomY = Float64Array.from(ownMomY), cumMomZ = Float64Array.from(ownMomZ);
  const cumPressX = Float64Array.from(ownPressX), cumPressY = Float64Array.from(ownPressY), cumPressZ = Float64Array.from(ownPressZ);

  for (let b = FOREST_WIND_BONES - 1; b >= 0; b--) {
    const p = bones[b].parent;
    if (bones[b].active && p >= 0) {
      cumMass[p] += cumMass[b];
      cumDrag[p] += cumDrag[b];
      cumMomX[p] += cumMomX[b]; cumMomY[p] += cumMomY[b]; cumMomZ[p] += cumMomZ[b];
      cumPressX[p] += cumPressX[b]; cumPressY[p] += cumPressY[b]; cumPressZ[p] += cumPressZ[b];
    }
  }

  const rootMassKg = Math.max(0.5, cumMass[0]);
  const rootDragM2 = Math.max(0.05, cumDrag[0]);
  // Slenderness ratio Lambda = H / stemDiam: distinguishes stout veteran oaks (~26) from supple birches/palms (~65-95).
  const slenderness = clamp(H / Math.max(stemDiam, 0.035 * H), 8.0, 95.0);
  // Fundamental trunk sway angular frequency (rad/s) scaling physically as ~ 1 / sqrt(H).
  const omega0 = clamp((2 * Math.PI * 1.12 / Math.sqrt(Math.max(1.1, H))) * Math.pow(30.0 / slenderness, 0.18), 1.15, 7.5);

  const boneFloats = new Float32Array(FOREST_WIND_BONES * FOREST_WIND_BONE_FLOATS);
  let activeCount = 0;

  for (let b = 0; b < FOREST_WIND_BONES; b++) {
    const bone = bones[b];
    const base = b * FOREST_WIND_BONE_FLOATS;
    if (!bone.active) continue;
    activeCount++;
    const dx = bone.tip[0] - bone.pivot[0], dy = bone.tip[1] - bone.pivot[1], dz = bone.tip[2] - bone.pivot[2];
    const boneLen = Math.max(0.06, hypot3(dx, dy, dz));
    const axis = normalize3(dx, dy, dz);

    const copX = cumPressX[b] / cumDrag[b];
    const copY = cumPressY[b] / cumDrag[b];
    const copZ = cumPressZ[b] / cumDrag[b];
    let levX = copX - bone.pivot[0];
    let levY = copY - bone.pivot[1];
    let levZ = copZ - bone.pivot[2];
    // Foliage occupies a 3D crown thickness above/around horizontal branches, ensuring horizontal wind parallel to a bough still lifts/bobs it.
    const minVertLever = bone.group === 0 ? 0.25 * boneLen : 0.24 * boneLen;
    if (Math.abs(levY) < minVertLever) levY = (levY >= 0 ? 1 : -1) * minVertLever;
    const leverLen = Math.max(0.08, hypot3(levX, levY, levZ));

    const effDrag = cumDrag[b];
    const refTorque10 = Math.max(0.15, REF_DYN_PRESSURE_PA * effDrag * leverLen);

    let targetBend10, natOmega, dampingRatio, maxBendRad;
    if (bone.group === 0) {
      // Trunk spine: stiff basal collar, progressive upper bend, stately low-frequency sway.
      targetBend10 = (0.0045 + 0.0165 * bone.chainT) * Math.pow(slenderness / 30.0, 0.65);
      natOmega = omega0 * (0.92 + 0.36 * bone.chainT);
      dampingRatio = 0.29;
      maxBendRad = 0.19 * (0.42 + 0.78 * bone.chainT);
    } else if (bone.group === 1) {
      // Primary scaffold boughs / palm frond rachises.
      const massShare = clamp(cumMass[b] / rootMassKg, 0.005, 0.5);
      targetBend10 = (isPalm ? 0.078 : 0.050) * Math.pow(slenderness / 30.0, 0.30);
      natOmega = omega0 * (isPalm ? 1.85 : 2.20) * Math.pow(0.08 / massShare, 0.12);
      dampingRatio = 0.25;
      maxBendRad = isPalm ? 0.48 : 0.30;
    } else {
      // Secondary & terminal outer branchlets / frond tips.
      const massShare = clamp(cumMass[b] / rootMassKg, 0.001, 0.2);
      targetBend10 = (isPalm ? 0.130 : 0.095) * Math.pow(slenderness / 30.0, 0.22);
      natOmega = omega0 * (isPalm ? 3.25 : 4.15) * Math.pow(0.02 / massShare, 0.14);
      dampingRatio = 0.22;
      maxBendRad = isPalm ? 0.60 : 0.42;
    }
    natOmega = clamp(natOmega, 1.0, 16.5);
    const stiffness = Math.max(1.2, refTorque10 / Math.max(targetBend10, 0.002));
    const maxBendQ = clamp(Math.round((maxBendRad / (Math.PI * 0.5)) * 65535), 1, 65535);
    const chainTQ = clamp(Math.round(bone.chainT * 65535), 0, 65535);
    const packedLim = (maxBendQ | (chainTQ << 16)) >>> 0;
    const metaCode = ((bone.parent + 1) | (bone.group << 6) | (1 << 8)) >>> 0;

    boneFloats[base + 0] = bone.pivot[0];
    boneFloats[base + 1] = bone.pivot[1];
    boneFloats[base + 2] = bone.pivot[2];
    boneFloats[base + 3] = metaCode;

    boneFloats[base + 4] = axis[0];
    boneFloats[base + 5] = axis[1];
    boneFloats[base + 6] = axis[2];
    boneFloats[base + 7] = boneLen;

    boneFloats[base + 8] = levX;
    boneFloats[base + 9] = levY;
    boneFloats[base + 10] = levZ;
    boneFloats[base + 11] = effDrag;

    boneFloats[base + 12] = stiffness;
    boneFloats[base + 13] = natOmega;
    boneFloats[base + 14] = dampingRatio;
    boneFloats[base + 15] = packedLim;
  }

  return {
    bones,
    boneFloats,
    groundY,
    H,
    summary: {
      id: proto.id,
      species: proto.species,
      cohort: proto.cohort ?? null,
      boneCount: activeCount,
      heightMetres: +H.toFixed(2),
      slenderness: +slenderness.toFixed(2),
      totalMassKg: +rootMassKg.toFixed(2),
      totalDragAreaM2: +rootDragM2.toFixed(2),
      trunkNaturalFreqHz: +(omega0 / (2 * Math.PI)).toFixed(3),
    },
  };
}

function skinWeightAtPoint(px, py, pz, skel, isLeafFallback = false) {
  const { bones, groundY, H } = skel;
  // Grounded basal root-collar anchor: vertices right at soil level stay rooted on bone 0.
  const collarTop = groundY + Math.min(0.32, 0.045 * H);
  if (!isLeafFallback && py <= collarTop) {
    return { bone0: 0, bone1: 0, weight0: 1.0 };
  }
  // Find the 3 closest active bones (d0 <= d1 <= d2) so dual-bone weights form a globally C1-continuous
  // partition of unity across all 3D Voronoi cell faces:
  //   u0 = (d2 - d0)^p, u1 = (d2 - d1)^p, w0 = u0 / (u0 + u1)
  // At d0 == d1 (primary seam), w0 == 0.5 on both sides; at d1 == d2 (runner-up swap), u1 == 0 => w0 == 1.0!
  let b0 = 0, b1 = 0;
  let d0 = Infinity, d1 = Infinity, d2 = Infinity;
  for (let b = 0; b < FOREST_WIND_BONES; b++) {
    const bone = bones[b];
    if (!bone.active) continue;
    const seg = pointSegClosest(px, py, pz, bone.pivot[0], bone.pivot[1], bone.pivot[2], bone.tip[0], bone.tip[1], bone.tip[2]);
    // Soft core radius offset keeps distance strictly positive & C1-smooth around capsule surfaces.
    const softDist = Math.sqrt(seg.d2 + 0.04) - Math.min(bone.radius * 0.65, 0.16);
    const groupBias = isLeafFallback && bone.group === 0 && py > groundY + 0.32 * H ? 1.35 : 1.0;
    const score = Math.max(0.01, softDist) * groupBias + b * 1e-6;
    if (score < d0) {
      d2 = d1;
      d1 = d0; b1 = b0;
      d0 = score; b0 = b;
    } else if (score < d1) {
      d2 = d1;
      d1 = score; b1 = b;
    } else if (score < d2) {
      d2 = score;
    }
  }
  if (!Number.isFinite(d1) || b0 === b1) {
    return { bone0: b0, bone1: b0, weight0: 1.0 };
  }
  const ref2 = Number.isFinite(d2) ? d2 : d1 + 1.0;
  const u0 = Math.pow(Math.max(0, ref2 - d0), 1.35);
  const u1 = Math.pow(Math.max(0, ref2 - d1), 1.35);
  const denom = u0 + u1;
  if (denom <= 1e-7) {
    return { bone0: b0, bone1: b1, weight0: 0.5 };
  }
  const w0 = clamp(u0 / denom, 0.5, 1.0);
  if (w0 > 0.996) {
    return { bone0: b0, bone1: b0, weight0: 1.0 };
  }
  return { bone0: b0, bone1: b1, weight0: w0 };
}

function assignPrototypeClusterWeights(clusterProto, nextFirstVertex, skel, vWords, idxWords, cWords, cFloats, outWeights) {
  const quant = {
    low: clusterProto.low,
    posScale: clusterProto.posScale,
    uvLow: clusterProto.uvLow,
    uvScale: clusterProto.uvScale,
  };
  const vStart = clusterProto.firstVertex;
  const vEnd = nextFirstVertex;
  const vSpan = vEnd - vStart;

  // 1. Skin all unique bark cluster vertices for this prototype and sample L0 bark triangles
  //    (vertices + edge midpoints + centroids) into a 0.28 m spatial hash so shoots growing mid-internode
  //    inherit the exact interpolated weight of their parent twig!
  const CELL = 0.28;
  const barkVisited = new Uint8Array(vSpan);
  const barkPx = new Float32Array(vSpan), barkPy = new Float32Array(vSpan), barkPz = new Float32Array(vSpan);
  const barkB0 = new Uint8Array(vSpan), barkB1 = new Uint8Array(vSpan);
  const barkW0 = new Float32Array(vSpan);
  const barkGrid = new Map();
  const cellKey = (ix, iy, iz) => `${ix},${iy},${iz}`;
  const addBarkSample = (px, py, pz, bone0, bone1, weight0) => {
    const ix = Math.floor(px / CELL), iy = Math.floor(py / CELL), iz = Math.floor(pz / CELL);
    const key = cellKey(ix, iy, iz);
    let bucket = barkGrid.get(key);
    if (!bucket) { bucket = []; barkGrid.set(key, bucket); }
    bucket.push({ px, py, pz, bone0, bone1, weight0 });
  };

  const cStart = clusterProto.firstCluster;
  const cEnd = cStart + clusterProto.clusterCount;

  for (let ci = cStart; ci < cEnd; ci++) {
    const at = ci * FOREST_CLUSTER_WORDS;
    const err = cFloats[at + 12];
    const first = cWords[at + 14];
    const shape = cWords[at + 15];
    const tris = shape >>> 1;
    const kind = shape & 1;
    if (kind !== 0) continue;
    const endIdx = first + tris * 3;
    for (let k = first; k < endIdx; k++) {
      const gv = idxWords[k];
      if (gv < vStart || gv >= vEnd) continue;
      const lv = gv - vStart;
      if (barkVisited[lv]) continue;
      barkVisited[lv] = 1;
      const { px, py, pz } = unpackClusterPosUv(vWords, gv, quant);
      const sw = skinWeightAtPoint(px, py, pz, skel, false);
      barkPx[lv] = px; barkPy[lv] = py; barkPz[lv] = pz;
      barkB0[lv] = sw.bone0; barkB1[lv] = sw.bone1; barkW0[lv] = sw.weight0;
      const phase = (hashU32(gv ^ 0x51ed270b) & 255) / 255;
      outWeights[gv] = packForestWindWeight({ ...sw, phase });
      addBarkSample(px, py, pz, sw.bone0, sw.bone1, sw.weight0);
    }
    if (err === 0) {
      for (let k = first; k + 2 < endIdx; k += 3) {
        const g0 = idxWords[k], g1 = idxWords[k + 1], g2 = idxWords[k + 2];
        if (g0 < vStart || g0 >= vEnd || g1 < vStart || g1 >= vEnd || g2 < vStart || g2 >= vEnd) continue;
        const l0 = g0 - vStart, l1 = g1 - vStart, l2 = g2 - vStart;
        const cx = (barkPx[l0] + barkPx[l1] + barkPx[l2]) / 3;
        const cy = (barkPy[l0] + barkPy[l1] + barkPy[l2]) / 3;
        const cz = (barkPz[l0] + barkPz[l1] + barkPz[l2]) / 3;
        const csw = skinWeightAtPoint(cx, cy, cz, skel, false);
        addBarkSample(cx, cy, cz, csw.bone0, csw.bone1, csw.weight0);
        // Subdivide long internode edges (> 0.16 m) so mid-twig shoots always find a < 5 cm bark sample with exact C1 weight.
        const pairs = [[l0, l1], [l1, l2], [l2, l0]];
        for (const [a, b] of pairs) {
          const d2 = (barkPx[a] - barkPx[b]) ** 2 + (barkPy[a] - barkPy[b]) ** 2 + (barkPz[a] - barkPz[b]) ** 2;
          if (d2 > 0.16 * 0.16) {
            const mx = 0.5 * (barkPx[a] + barkPx[b]), my = 0.5 * (barkPy[a] + barkPy[b]), mz = 0.5 * (barkPz[a] + barkPz[b]);
            const msw = skinWeightAtPoint(mx, my, mz, skel, false);
            addBarkSample(mx, my, mz, msw.bone0, msw.bone1, msw.weight0);
          }
        }
      }
    }
  }

  // 2. Assign every 6-vertex leaf in leaf clusters a single unified (bone0, bone1, weight0, phase),
  //    locking directly to the nearest bark sample within 0.28 m of the leaf's proximal attachment foot!
  let totalLeaves = 0, barkLockedLeaves = 0, l0Leaves = 0, l0BarkLocked = 0;
  const leafVerts = new Array(FOREST_LEAF_VERTICES);

  for (let ci = cStart; ci < cEnd; ci++) {
    const at = ci * FOREST_CLUSTER_WORDS;
    const err = cFloats[at + 12];
    const first = cWords[at + 14];
    const shape = cWords[at + 15];
    const tris = shape >>> 1;
    const kind = shape & 1;
    if (kind !== 1) continue;
    const isL0 = err === 0;
    const leafCount = Math.floor(tris / 4);
    for (let l = 0; l < leafCount; l++) {
      const baseV = first + l * FOREST_LEAF_VERTICES;
      let bestFootK = -1, bestFootScore = Infinity, minU = Infinity;
      for (let k = 0; k < FOREST_LEAF_VERTICES; k++) {
        const u = unpackClusterPosUv(vWords, baseV + k, quant);
        leafVerts[k] = u;
        if (u.u < minU) minU = u.u;
        const footScore = u.u + Math.abs(u.v - 0.5) * 0.65;
        if (footScore < bestFootScore) {
          bestFootScore = footScore;
          bestFootK = k;
        }
      }
      let fx = leafVerts[bestFootK].px, fy = leafVerts[bestFootK].py, fz = leafVerts[bestFootK].pz;
      if (Math.abs(leafVerts[bestFootK].v - 0.5) > 0.24) {
        let sx = 0, sy = 0, sz = 0, sc = 0;
        for (let k = 0; k < FOREST_LEAF_VERTICES; k++) {
          if (leafVerts[k].u <= minU + 0.08) {
            sx += leafVerts[k].px; sy += leafVerts[k].py; sz += leafVerts[k].pz; sc++;
          }
        }
        if (sc > 0) { fx = sx / sc; fy = sy / sc; fz = sz / sc; }
      }

      const ix = Math.floor(fx / CELL), iy = Math.floor(fy / CELL), iz = Math.floor(fz / CELL);
      let nearestBark = null, bestBarkD2 = 0.28 * 0.28;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bucket = barkGrid.get(cellKey(ix + dx, iy + dy, iz + dz));
            if (!bucket) continue;
            for (let j = 0; j < bucket.length; j++) {
              const cand = bucket[j];
              const d2 = (fx - cand.px) ** 2 + (fy - cand.py) ** 2 + (fz - cand.pz) ** 2;
              if (d2 < bestBarkD2) {
                bestBarkD2 = d2;
                nearestBark = cand;
              }
            }
          }
        }
      }

      let sw;
      if (nearestBark) {
        sw = { bone0: nearestBark.bone0, bone1: nearestBark.bone1, weight0: nearestBark.weight0 };
        barkLockedLeaves++;
        if (isL0) l0BarkLocked++;
      } else {
        sw = skinWeightAtPoint(fx, fy, fz, skel, true);
      }
      if (isL0) l0Leaves++;
      const phase = (hashU32((baseV >>> 0) ^ 0x9e3779b9) & 255) / 255;
      const packed = packForestWindWeight({ ...sw, phase });
      for (let k = 0; k < FOREST_LEAF_VERTICES; k++) {
        outWeights[baseV + k] = packed;
      }
      totalLeaves++;
    }
  }

  for (let gv = vStart; gv < vEnd; gv++) {
    if (outWeights[gv] === 0xffffffff) {
      const { px, py, pz } = unpackClusterPosUv(vWords, gv, quant);
      const sw = skinWeightAtPoint(px, py, pz, skel, false);
      outWeights[gv] = packForestWindWeight({ ...sw, phase: 0 });
    }
  }

  return { totalLeaves, barkLockedLeaves, l0Leaves, l0BarkLocked };
}

for (const packName of targets) {
  const t0 = Date.now();
  const dir = path.join('assets/forest-scenery', packName);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const clusterManifest = JSON.parse(fs.readFileSync(path.join(dir, 'clusters/manifest.json'), 'utf8'));

  const gunzip = (rel) => zlib.gunzipSync(fs.readFileSync(path.join(dir, rel)));
  const asFloats = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const asWords = (buf) => new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

  const sourceFloats = asFloats(gunzip('vertices.bin.gz'));
  const sourceIndices = asWords(gunzip('indices.bin.gz'));
  const clusterVWords = asWords(gunzip('clusters/vertices.bin.gz'));
  const clusterIdxWords = asWords(gunzip('clusters/indices.bin.gz'));
  const clusterCBuf = gunzip('clusters/clusters.bin.gz');
  const clusterCWords = asWords(clusterCBuf);
  const clusterCFloats = asFloats(clusterCBuf);

  const protoCount = manifest.prototypes.length;
  const allBones = new Float32Array(protoCount * FOREST_WIND_BONES * FOREST_WIND_BONE_FLOATS);
  const allWeights = new Uint32Array(clusterManifest.vertexCount).fill(0xffffffff);
  const protoSummaries = [];

  console.log(`\n=== Preparing Dynamic Skeletal Bone Wind: ${packName} (${protoCount} prototypes, ${clusterManifest.vertexCount.toLocaleString()} cluster vertices) ===`);
  for (let pIdx = 0; pIdx < protoCount; pIdx++) {
    const proto = manifest.prototypes[pIdx];
    const cProto = clusterManifest.prototypes.find((cp) => cp.id === proto.id);
    const nextFirstV = pIdx + 1 < protoCount
      ? clusterManifest.prototypes.find((cp) => cp.id === manifest.prototypes[pIdx + 1].id).firstVertex
      : clusterManifest.vertexCount;

    const elems = extractSourceElements(proto, sourceFloats, sourceIndices);
    const skel = buildPrototypeSkeleton(proto, elems);
    allBones.set(skel.boneFloats, pIdx * FOREST_WIND_BONES * FOREST_WIND_BONE_FLOATS);

    const lockStats = assignPrototypeClusterWeights(cProto, nextFirstV, skel, clusterVWords, clusterIdxWords, clusterCWords, clusterCFloats, allWeights);
    const lockPct = lockStats.totalLeaves > 0 ? ((100 * lockStats.barkLockedLeaves) / lockStats.totalLeaves) : 100;
    const l0LockPct = lockStats.l0Leaves > 0 ? ((100 * lockStats.l0BarkLocked) / lockStats.l0Leaves) : 100;
    const summary = {
      ...skel.summary,
      barkLockedLeafShare: +(lockPct / 100).toFixed(4),
      l0BarkLockedShare: +(l0LockPct / 100).toFixed(4),
    };
    protoSummaries.push(summary);
    console.log(
      `  [${proto.id}] ${(proto.species + (proto.cohort ? `/${proto.cohort}` : '')).padEnd(18)} ` +
      `H=${summary.heightMetres.toFixed(1).padStart(4)}m  mass=${summary.totalMassKg.toFixed(0).padStart(6)}kg  ` +
      `drag=${summary.totalDragAreaM2.toFixed(1).padStart(6)}m²  f0=${summary.trunkNaturalFreqHz.toFixed(2)}Hz  ` +
      `L0BarkLock=${l0LockPct.toFixed(1)}% (all=${lockPct.toFixed(1)}%)`
    );
  }

  const outDir = path.join(dir, 'wind');
  fs.mkdirSync(outDir, { recursive: true });
  const outputs = {
    'bones.bin': Buffer.from(allBones.buffer, allBones.byteOffset, allBones.byteLength),
    'weights.bin': Buffer.from(allWeights.buffer, allWeights.byteOffset, allWeights.byteLength),
  };
  const files = {};
  for (const [name, bytes] of Object.entries(outputs)) {
    const gz = zlib.gzipSync(bytes, { level: 9 });
    fs.writeFileSync(path.join(outDir, `${name}.gz`), gz);
    files[name] = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      gzip: {
        file: `${name}.gz`,
        bytes: gz.length,
        sha256: createHash('sha256').update(gz).digest('hex'),
      },
    };
  }
  const windManifest = validateForestWindManifest({
    format: 'waterworld.forest-wind',
    version: 1,
    bonesPerPrototype: FOREST_WIND_BONES,
    boneFloats: FOREST_WIND_BONE_FLOATS,
    clusterVertexCount: clusterManifest.vertexCount,
    physics: {
      woodDensityKgM3: WOOD_DENSITY_KG_M3,
      leafArealDensityKgM2: LEAF_AREAL_DENSITY_KG_M2,
      leafOpticalDepth: LEAF_OPTICAL_DEPTH,
    },
    files,
    prototypes: protoSummaries,
  });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(windManifest, null, 2) + '\n');
  console.log(
    `  -> wrote ${outDir}: bones.bin.gz ${(files['bones.bin'].gzip.bytes / 1024).toFixed(1)} KB, ` +
    `weights.bin.gz ${(files['weights.bin'].gzip.bytes / 1e6).toFixed(2)} MB (${((Date.now() - t0) / 1000).toFixed(1)}s)`
  );
}
