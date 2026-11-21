#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Generates and bakes fourteen tailored 3D GPU-skinned kinematic 1550 garments into
// assets/crew/clothing-continuum/{atlas.bin.gz,manifest.json} through the one bake (js/continuum-bake.js).
// Every garment is sculpted strictly OUTSIDE the measured polar surface envelope of the clean undressed
// male/female base bodies (`assets/crew/continuum/{sailor-male,villager-female}/body.glb`) with exact
// k-NN 4-joint skeletal weight transfer and per-vertex wind/stride cloth freedom (`wind` stream).
//
// Usage:
//   node scripts/prepare-clothing-continuum.mjs
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readGLB, loadCrewGLB } from '../js/gltf.js';
import { CREW_JOINT_COUNT, CREW_SLOT } from '../js/crew-skeleton.js';
import { crewContinuumRestPlaces } from '../js/crew-continuum-draw.js';
import {
  CONTINUUM_HEADER_WORDS, assembleContinuumAtlas, checkContinuumAtlas, packContinuumBody,
} from '../js/continuum-format.js';
import { bakeContinuumBody } from '../js/continuum-bake.js';
import {
  CLOTHING_CONTINUUM_FORMAT, CLOTHING_CONTINUUM_TYPES, CLOTHING_CONTINUUM_VERSION,
  validateClothingContinuumManifest,
} from '../js/clothing-continuum.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, 'assets/crew/clothing-continuum');

// Cloth material channels packed into vertex word bits 0..2:
//   0 = actor.shirt.rgb (primary upper cloth)
//   1 = actor.trousers.rgb (primary lower cloth)
//   2 = crisp off-white linen (chemise sleeves, collar/cuff trim, working apron)
//   3 = dark oiled leather (waist belt, shoes/boots, straps)
//   4 = burnished brass (belt buckle, jerkin studs, cloak clasp)
//   5 = buff leather / tan hide (tercio jerkin, moccasins)
//   6 = dark charcoal/slate wool (fitted hose/stockings, dark cape lining)
//   7 = woven crimson/ochre decorative border trim
const CH = {
  SHIRT: 0, TROUSERS: 1, LINEN: 2, LEATHER: 3, BRASS: 4, BUFF: 5, HOSE: 6, TRIM: 7,
};
// Fabric weave types packed into vertex word bits 3..5:
const FAB = { LINEN: 0, WOOL: 1, LEATHER: 2, BRASS: 3, COTTON: 4 };

function packClothWord(channel, fabric, foldAO, weaveU, weaveV) {
  const ch = channel & 7;
  const fb = fabric & 7;
  const ao = Math.max(0, Math.min(255, Math.round(foldAO * 255)));
  const u8 = Math.max(0, Math.min(255, Math.round((((weaveU % 1) + 1) % 1) * 255)));
  const v8 = Math.max(0, Math.min(255, Math.round((((weaveV % 1) + 1) % 1) * 255)));
  return (ch | (fb << 3) | (ao << 8) | (u8 << 16) | (v8 << 24)) >>> 0;
}

function packWind(flex, phase) {
  const f16 = Math.max(0, Math.min(65535, Math.round(Math.max(0, Math.min(1, flex)) * 65535)));
  const p16 = Math.max(1, Math.min(65535, Math.round((((phase % 1) + 1) % 1) * 65535)));
  return (f16 | (p16 << 16)) >>> 0;
}

function packSkin(joints, weights) {
  const map = new Map();
  for (let k = 0; k < joints.length; k++) {
    const j = joints[k], w = weights[k];
    if (w > 1e-6 && j >= 0 && j < CREW_JOINT_COUNT) map.set(j, (map.get(j) ?? 0) + w);
  }
  const list = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (!list.length) list.push([CREW_SLOT.spine_02, 1]);
  const sum = list.reduce((s, [, w]) => s + w, 0) || 1;
  const pairs = list.map(([j, w]) => [j, Math.round((w / sum) * 255)]);
  pairs[0][1] += 255 - pairs.reduce((s, [, q]) => s + q, 0);
  pairs.sort((a, b) => b[1] - a[1]);
  let J = 0, W = 0;
  pairs.forEach(([j, q], k) => { J |= j << (k * 8); W |= q << (k * 8); });
  return [J >>> 0, W >>> 0, pairs[0][0]];
}

// --------------------------------------------------------------------------- Anatomical body envelope & spatial k-NN skinning
function loadBodyReference(id) {
  const file = path.join(ROOT, 'assets/crew/continuum', id, 'body.glb');
  const bytes = fs.readFileSync(file);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loaded = loadCrewGLB(ab);
  const rest = crewContinuumRestPlaces(loaded.animator);
  const asset = readGLB(bytes), prim = asset.json.meshes[0].primitives[0], at = prim.attributes;
  const acc = (idx, Type, w) => {
    const a = asset.json.accessors[idx], v = asset.json.bufferViews[a.bufferView];
    const off = asset.bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return new Type(asset.bin.buffer.slice(off, off + a.count * w * Type.BYTES_PER_ELEMENT));
  };
  const pos = acc(at.POSITION, Float32Array, 3);
  const jAcc = asset.json.accessors[at.JOINTS_0];
  const jnt = acc(at.JOINTS_0, jAcc.componentType === 5123 ? Uint16Array : Uint8Array, 4);
  const wgt = acc(at.WEIGHTS_0, Float32Array, 4);
  const idxAcc = asset.json.accessors[prim.indices];
  const idx = acc(prim.indices, idxAcc.componentType === 5125 ? Uint32Array : Uint16Array, 1);
  const nVerts = pos.length / 3;
  const nTris = idx.length / 3;

  // Möller–Trumbore ray-triangle hit distance (double-sided, returns t >= 0 or -1)
  function rayTri(ox, oy, oz, dx, dy, dz, a, b, c) {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const e1x = pos[b * 3] - ax, e1y = pos[b * 3 + 1] - ay, e1z = pos[b * 3 + 2] - az;
    const e2x = pos[c * 3] - ax, e2y = pos[c * 3 + 1] - ay, e2z = pos[c * 3 + 2] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-8) return -1;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-4 || u > 1 + 1e-4) return -1;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-4 || u + v > 1 + 2e-4) return -1;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t >= 0 ? t : -1;
  }

  // Precompute per-triangle bounding boxes for fast slice filtering
  const tMinX = new Float32Array(nTris), tMaxX = new Float32Array(nTris);
  const tMinY = new Float32Array(nTris), tMaxY = new Float32Array(nTris);
  for (let t = 0; t < nTris; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    tMinX[t] = Math.min(pos[a * 3], pos[b * 3], pos[c * 3]);
    tMaxX[t] = Math.max(pos[a * 3], pos[b * 3], pos[c * 3]);
    tMinY[t] = Math.min(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1]);
    tMaxY[t] = Math.max(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1]);
  }

  const jointAt = (name) => {
    const slot = CREW_SLOT[name];
    return [rest[slot * 4], rest[slot * 4 + 1], rest[slot * 4 + 2]];
  };

  // Spatial hash grid for instant k-NN skinning weight transfer
  const cell = 0.04;
  const grid = new Map();
  const key = (ix, iy, iz) => `${ix},${iy},${iz}`;
  for (let v = 0; v < nVerts; v++) {
    const ix = Math.floor(pos[v * 3] / cell), iy = Math.floor(pos[v * 3 + 1] / cell), iz = Math.floor(pos[v * 3 + 2] / cell);
    const k = key(ix, iy, iz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(v);
  }

  function nearestSkin(x, y, z, filterFn = null) {
    const ix = Math.floor(x / cell), iy = Math.floor(y / cell), iz = Math.floor(z / cell);
    const best = [];
    for (let rad = 1; rad <= 5 && best.length < 6; rad++) {
      for (let dx = -rad; dx <= rad; dx++) for (let dy = -rad; dy <= rad; dy++) for (let dz = -rad; dz <= rad; dz++) {
        if (rad > 1 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) < rad) continue;
        const list = grid.get(key(ix + dx, iy + dy, iz + dz));
        if (!list) continue;
        for (const v of list) {
          if (filterFn && !filterFn(v)) continue;
          const d2 = (pos[v * 3] - x) ** 2 + (pos[v * 3 + 1] - y) ** 2 + (pos[v * 3 + 2] - z) ** 2;
          best.push([d2, v]);
        }
      }
    }
    best.sort((a, b) => a[0] - b[0]);
    const pick = best.slice(0, 6);
    if (!pick.length) return [[CREW_SLOT.spine_02], [1]];
    const accJ = [], accW = [];
    for (const [d2, v] of pick) {
      const w = 1 / (Math.sqrt(d2) + 0.012);
      for (let k = 0; k < 4; k++) {
        const jw = wgt[v * 4 + k];
        if (jw > 1e-5) { accJ.push(jnt[v * 4 + k]); accW.push(jw * w); }
      }
    }
    return [accJ, accW];
  }

  // Exact ray-triangle outer-surface envelope for torso (y in [0.76, 1.56], excluding arms |x| > armCut)
  const shL = jointAt('upperarm_l'), shR = jointAt('upperarm_r');
  const elL = jointAt('lowerarm_l'), haL = jointAt('hand_l');
  const hipL = jointAt('thigh_l'), kneeL = jointAt('calf_l'), footL = jointAt('foot_l');
  const pelvis = jointAt('pelvis'), neck = jointAt('neck_01'), spine3 = jointAt('spine_03');
  const armCut = Math.abs(shL[0]) + 0.045;

  const tNY = 48, tNT = 40, tY0 = 0.76, tY1 = 1.56;
  const torsoR = new Float32Array(tNY * tNT);
  const torsoZ = new Float32Array(tNY);
  for (let iy = 0; iy < tNY; iy++) {
    const y = tY0 + (iy / (tNY - 1)) * (tY1 - tY0);
    // Find exact midpoint of front/back torso bounds at height y from intersecting triangles
    let zMin = 9, zMax = -9;
    const sliceTris = [];
    for (let t = 0; t < nTris; t++) {
      if (tMaxY[t] < y - 0.018 || tMinY[t] > y + 0.018) continue;
      if (tMinX[t] > armCut || tMaxX[t] < -armCut) continue;
      sliceTris.push(t);
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      for (const v of [a, b, c]) {
        if (Math.abs(pos[v * 3]) < armCut && Math.abs(pos[v * 3 + 1] - y) < 0.05) {
          const vz = pos[v * 3 + 2];
          if (vz < zMin) zMin = vz;
          if (vz > zMax) zMax = vz;
        }
      }
    }
    const zc = zMin < zMax ? (zMin + zMax) * 0.5 : pelvis[2];
    torsoZ[iy] = zc;
    for (let it = 0; it < tNT; it++) {
      const th = (it / tNT) * Math.PI * 2;
      const dx = Math.sin(th), dz = Math.cos(th);
      let maxHit = 0;
      // Sample at y and y ± 0.012 m so ridges between rings never poke out!
      for (const oy of [y - 0.012, y, y + 0.012]) {
        for (const t of sliceTris) {
          const hit = rayTri(0, oy, zc, dx, 0, dz, idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
          if (hit > maxHit && hit < armCut + 0.08) maxHit = hit;
        }
      }
      torsoR[iy * tNT + it] = maxHit;
    }
  }
  // Gentle 1-pass neighbor fill ONLY for any grazing miss, NEVER shrinking below measured surface!
  for (let pass = 0; pass < 2; pass++) {
    const copy = new Float32Array(torsoR);
    for (let iy = 0; iy < tNY; iy++) for (let it = 0; it < tNT; it++) {
      const cur = copy[iy * tNT + it];
      const l = copy[iy * tNT + ((it + tNT - 1) % tNT)];
      const r = copy[iy * tNT + ((it + 1) % tNT)];
      const d = copy[Math.max(0, iy - 1) * tNT + it];
      const u = copy[Math.min(tNY - 1, iy + 1) * tNT + it];
      const maxN = Math.max(l, r, d, u);
      const avg = (l + r + d + u) * 0.25;
      torsoR[iy * tNT + it] = cur < 0.04 ? maxN : Math.max(cur, cur * 0.80 + avg * 0.20);
    }
  }

  function sampleTorso(y, theta) {
    const fy = Math.max(0, Math.min(tNY - 1.0001, ((y - tY0) / (tY1 - tY0)) * (tNY - 1)));
    const iy = Math.floor(fy), wy = fy - iy;
    const zc = torsoZ[iy] * (1 - wy) + torsoZ[iy + 1] * wy;
    const ft = ((((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * tNT;
    const it = Math.floor(ft) % tNT, it2 = (it + 1) % tNT, wt = ft - Math.floor(ft);
    const r00 = torsoR[iy * tNT + it], r01 = torsoR[iy * tNT + it2];
    const r10 = torsoR[(iy + 1) * tNT + it], r11 = torsoR[(iy + 1) * tNT + it2];
    const r = (r00 * (1 - wt) + r01 * wt) * (1 - wy) + (r10 * (1 - wt) + r11 * wt) * wy;
    return { r: Math.max(0.055, r), zc };
  }

  // Exact ray-triangle outer-surface envelopes for left & right arms along X
  const armX0 = Math.abs(shL[0]) * 0.85, armX1 = Math.abs(haL[0]) + 0.02;
  const aNX = 24, aNT = 20;
  const armR = [new Float32Array(aNX * aNT), new Float32Array(aNX * aNT)];
  const armY = [new Float32Array(aNX), new Float32Array(aNX)];
  const armZ = [new Float32Array(aNX), new Float32Array(aNX)];
  for (let side = 0; side < 2; side++) {
    const sgn = side === 0 ? 1 : -1;
    for (let ix = 0; ix < aNX; ix++) {
      const t = ix / (aNX - 1);
      const ax = armX0 + t * (armX1 - armX0);
      const xWorld = ax * sgn;
      let yMin = 9, yMax = -9, zMin = 9, zMax = -9;
      const sliceTris = [];
      for (let ti = 0; ti < nTris; ti++) {
        if (tMaxX[ti] < xWorld - 0.02 || tMinX[ti] > xWorld + 0.02) continue;
        if (tMaxY[ti] < shL[1] - 0.16 || tMinY[ti] > shL[1] + 0.16) continue;
        sliceTris.push(ti);
        for (const v of [idx[ti * 3], idx[ti * 3 + 1], idx[ti * 3 + 2]]) {
          const vy = pos[v * 3 + 1], vz = pos[v * 3 + 2];
          if (vy < yMin) yMin = vy; if (vy > yMax) yMax = vy;
          if (vz < zMin) zMin = vz; if (vz > zMax) zMax = vz;
        }
      }
      const yc = yMin < yMax ? (yMin + yMax) * 0.5 : shL[1];
      const zc = zMin < zMax ? (zMin + zMax) * 0.5 : shL[2];
      armY[side][ix] = yc;
      armZ[side][ix] = zc;
      for (let it = 0; it < aNT; it++) {
        const th = (it / aNT) * Math.PI * 2;
        const dy = Math.sin(th), dz = Math.cos(th);
        let maxHit = 0;
        for (const ox of [xWorld - 0.01, xWorld, xWorld + 0.01]) {
          for (const ti of sliceTris) {
            const hit = rayTri(ox, yc, zc, 0, dy, dz, idx[ti * 3], idx[ti * 3 + 1], idx[ti * 3 + 2]);
            if (hit > maxHit && hit < 0.15) maxHit = hit;
          }
        }
        armR[side][ix * aNT + it] = maxHit;
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      const copy = new Float32Array(armR[side]);
      for (let ix = 0; ix < aNX; ix++) for (let it = 0; it < aNT; it++) {
        const cur = copy[ix * aNT + it];
        const l = copy[ix * aNT + ((it + aNT - 1) % aNT)];
        const r = copy[ix * aNT + ((it + 1) % aNT)];
        const d = copy[Math.max(0, ix - 1) * aNT + it];
        const u = copy[Math.min(aNX - 1, ix + 1) * aNT + it];
        armR[side][ix * aNT + it] = cur < 0.025 ? Math.max(l, r, d, u) : Math.max(cur, (l + r + d + u) * 0.25);
      }
    }
  }

  function sampleArm(side, ax, theta) {
    const fx = Math.max(0, Math.min(aNX - 1.0001, ((ax - armX0) / (armX1 - armX0)) * (aNX - 1)));
    const ix = Math.floor(fx), wx = fx - ix;
    const yc = armY[side][ix] * (1 - wx) + armY[side][ix + 1] * wx;
    const zc = armZ[side][ix] * (1 - wx) + armZ[side][ix + 1] * wx;
    const ft = ((((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * aNT;
    const it = Math.floor(ft) % aNT, it2 = (it + 1) % aNT, wt = ft - Math.floor(ft);
    const r00 = armR[side][ix * aNT + it], r01 = armR[side][ix * aNT + it2];
    const r10 = armR[side][(ix + 1) * aNT + it], r11 = armR[side][(ix + 1) * aNT + it2];
    const r = (r00 * (1 - wt) + r01 * wt) * (1 - wx) + (r10 * (1 - wt) + r11 * wt) * wx;
    return { r: Math.max(0.036, r), yc, zc };
  }

  // Exact ray-triangle outer-surface envelopes for left & right legs (y in [0.00, 0.88])
  const lNY = 32, lNT = 24, lY0 = 0.00, lY1 = 0.88;
  const legR = [new Float32Array(lNY * lNT), new Float32Array(lNY * lNT)];
  const legX = [new Float32Array(lNY), new Float32Array(lNY)];
  const legZ = [new Float32Array(lNY), new Float32Array(lNY)];
  for (let side = 0; side < 2; side++) {
    const sgn = side === 0 ? 1 : -1;
    for (let iy = 0; iy < lNY; iy++) {
      const y = lY0 + (iy / (lNY - 1)) * (lY1 - lY0);
      let xMin = 9, xMax = -9, zMin = 9, zMax = -9;
      const sliceTris = [];
      for (let ti = 0; ti < nTris; ti++) {
        if (tMaxY[ti] < y - 0.02 || tMinY[ti] > y + 0.02) continue;
        if (sgn > 0 ? tMaxX[ti] < -0.005 : tMinX[ti] > 0.005) continue;
        sliceTris.push(ti);
        for (const v of [idx[ti * 3], idx[ti * 3 + 1], idx[ti * 3 + 2]]) {
          const vx = pos[v * 3], vz = pos[v * 3 + 2];
          if (vx * sgn > -0.005) {
            if (vx < xMin) xMin = vx; if (vx > xMax) xMax = vx;
            if (vz < zMin) zMin = vz; if (vz > zMax) zMax = vz;
          }
        }
      }
      const xc = xMin < xMax ? (xMin + xMax) * 0.5 : hipL[0] * sgn;
      const zc = zMin < zMax ? (zMin + zMax) * 0.5 : hipL[2];
      legX[side][iy] = xc;
      legZ[side][iy] = zc;
      for (let it = 0; it < lNT; it++) {
        const th = (it / lNT) * Math.PI * 2;
        const dx = Math.sin(th), dz = Math.cos(th);
        let maxHit = 0;
        for (const oy of [y - 0.01, y, y + 0.01]) {
          for (const ti of sliceTris) {
            const hit = rayTri(xc, oy, zc, dx, 0, dz, idx[ti * 3], idx[ti * 3 + 1], idx[ti * 3 + 2]);
            if (hit > maxHit && hit < 0.16) maxHit = hit;
          }
        }
        legR[side][iy * lNT + it] = maxHit;
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      const copy = new Float32Array(legR[side]);
      for (let iy = 0; iy < lNY; iy++) for (let it = 0; it < lNT; it++) {
        const cur = copy[iy * lNT + it];
        const l = copy[iy * lNT + ((it + lNT - 1) % lNT)];
        const r = copy[iy * lNT + ((it + 1) % lNT)];
        const d = copy[Math.max(0, iy - 1) * lNT + it];
        const u = copy[Math.min(lNY - 1, iy + 1) * lNT + it];
        legR[side][iy * lNT + it] = cur < 0.03 ? Math.max(l, r, d, u) : Math.max(cur, (l + r + d + u) * 0.25);
      }
    }
  }

  function sampleLeg(side, y, theta) {
    const fy = Math.max(0, Math.min(lNY - 1.0001, ((y - lY0) / (lY1 - lY0)) * (lNY - 1)));
    const iy = Math.floor(fy), wy = fy - iy;
    const xc = legX[side][iy] * (1 - wy) + legX[side][iy + 1] * wy;
    const zc = legZ[side][iy] * (1 - wy) + legZ[side][iy + 1] * wy;
    const ft = ((((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * lNT;
    const it = Math.floor(ft) % lNT, it2 = (it + 1) % lNT, wt = ft - Math.floor(ft);
    const r00 = legR[side][iy * lNT + it], r01 = legR[side][iy * lNT + it2];
    const r10 = legR[side][(iy + 1) * lNT + it], r11 = legR[side][(iy + 1) * lNT + it2];
    const r = (r00 * (1 - wt) + r01 * wt) * (1 - wy) + (r10 * (1 - wt) + r11 * wt) * wy;
    return { r: Math.max(0.036, r), xc, zc };
  }

  // Foot bounding boxes for tailored 3D leather shoes
  const feet = [0, 1].map((side) => {
    const sgn = side === 0 ? 1 : -1;
    let minX = 9, maxX = -9, minY = 9, maxY = -9, minZ = 9, maxZ = -9;
    for (let v = 0; v < nVerts; v++) {
      const vx = pos[v * 3], vy = pos[v * 3 + 1], vz = pos[v * 3 + 2];
      if (vy <= 0.115 && vx * sgn > 0.01) {
        if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
        if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
      }
    }
    return { minX, maxX, minY: Math.max(-0.02, minY), maxY, minZ, maxZ };
  });

  return {
    id, female: id.includes('female'), pos, jnt, wgt, rest,
    shL, shR, elL, haL, hipL, kneeL, footL, pelvis, neck, spine3, armX0, armX1, feet,
    nearestSkin, sampleTorso, sampleArm, sampleLeg,
  };
}

// --------------------------------------------------------------------------- Mesh builder with auto smooth normals
function createClothMesh() {
  const pos = [], words = [], skinJ = [], skinW = [], wind = [], parts = [], indices = [];
  function addVertex(x, y, z, word, joints, weights, flex = 0, phase = 0.25) {
    const [J, W, lead] = packSkin(joints, weights);
    const id = pos.length / 3;
    pos.push(x, y, z);
    words.push(word >>> 0);
    skinJ.push(J);
    skinW.push(W);
    wind.push(packWind(flex, phase));
    parts.push(lead);
    return id;
  }
  function addTri(a, b, c) {
    indices.push(a, b, c);
  }
  function addQuad(a, b, c, d) {
    indices.push(a, b, c, a, c, d);
  }
  function addTube(rings, closedU = true) {
    const nR = rings.length, nS = rings[0].length;
    for (let r = 0; r < nR - 1; r++) {
      const rowA = rings[r], rowB = rings[r + 1];
      const limit = closedU ? nS : nS - 1;
      for (let s = 0; s < limit; s++) {
        const s2 = (s + 1) % nS;
        addQuad(rowA[s], rowA[s2], rowB[s2], rowB[s]);
      }
    }
  }
  function finalize() {
    const count = pos.length / 3;
    const position = Float32Array.from(pos);
    const index = Uint32Array.from(indices);
    const normal = new Float32Array(count * 3);
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2];
      const ax = position[a * 3], ay = position[a * 3 + 1], az = position[a * 3 + 2];
      const e1x = position[b * 3] - ax, e1y = position[b * 3 + 1] - ay, e1z = position[b * 3 + 2] - az;
      const e2x = position[c * 3] - ax, e2y = position[c * 3 + 1] - ay, e2z = position[c * 3 + 2] - az;
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) { normal[v * 3] += nx; normal[v * 3 + 1] += ny; normal[v * 3 + 2] += nz; }
    }
    for (let v = 0; v < count; v++) {
      const l = Math.hypot(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]) || 1;
      normal[v * 3] /= l; normal[v * 3 + 1] /= l; normal[v * 3 + 2] /= l;
    }
    return {
      count, position, normal, index,
      words: Uint32Array.from(words),
      skinJ: Uint32Array.from(skinJ),
      skinW: Uint32Array.from(skinW),
      wind: Uint32Array.from(wind),
      parts: Uint32Array.from(parts),
    };
  }
  return { addVertex, addTri, addQuad, addTube, finalize };
}

// --------------------------------------------------------------------------- Reusable tailored garment building blocks
function addTorsoShell(mesh, body, {
  yBot, yTop, nY = 22, nT = 40, clearance = 0.032, flareBot = 0.0,
  vNeckDepth = 0.0, vNeckWidth = 0.28, scoopDepth = 0.0,
  standCollar = 0.0, collarChannel = null,
  channel = CH.SHIRT, fabric = FAB.LINEN,
  placketChannel = null, hemTrim = false,
  hemFlex = 0.25, pleats = 0, pleatAmp = 0.0,
  bodiceLace = false, shoulderYoke = true, tucked = false,
}) {
  // Exact anatomical shoulder & neck heights so the upper yoke curves cleanly OVER the trapezius/shoulders to hug the neck!
  const shY = body.shL[1];
  const neckY = body.neck[1];
  const neckZ = body.neck[2];
  const neckR = body.female ? 0.064 : 0.076;
  const yokeY0 = shY - 0.01;
  const yokeY1 = shoulderYoke ? neckY + 0.022 : yTop;
  const bodyTopY = shoulderYoke ? yokeY0 : yTop;
  const rings = [];

  for (let iy = 0; iy < nY; iy++) {
    const vFrac = iy / (nY - 1);
    // Reserve the top 5 rings for the curved shoulder yoke closing inward to the neck collar!
    const yokeSplit = shoulderYoke ? 0.76 : 1.01;
    const inYoke = shoulderYoke && vFrac > yokeSplit;
    const yokeT = inYoke ? (vFrac - yokeSplit) / (1 - yokeSplit) : 0; // 0 = shoulder outer rim, 1 = neck collar
    const bodyFrac = shoulderYoke ? Math.min(1, vFrac / yokeSplit) : vFrac;
    const yBase = inYoke
      ? yokeY0 + Math.sin(yokeT * Math.PI * 0.5) * (yokeY1 - yokeY0)
      : yBot + bodyFrac * (bodyTopY - yBot);

    const row = [];
    for (let it = 0; it < nT; it++) {
      const uFrac = it / nT;
      const th = uFrac * Math.PI * 2; // 0 = front (+Z), PI/2 = left (+X), PI = back (-Z)
      const cosFront = Math.cos(th);
      const frontMask = Math.max(0, cosFront);

      let y = yBase;
      // Clean neckline cutout ONLY at the front sternum (never sliding off the shoulders!)
      if (inYoke) {
        if (vNeckDepth > 0 && cosFront > 0.62) {
          const vShape = Math.pow((cosFront - 0.62) / 0.38, 1.35);
          y -= vNeckDepth * vShape * yokeT;
        } else if (scoopDepth > 0 && cosFront > 0.45) {
          const sShape = Math.pow((cosFront - 0.45) / 0.55, 1.35);
          y -= scoopDepth * sShape * yokeT;
        }
        if (standCollar > 0 && yokeT > 0.65) {
          y += standCollar * ((yokeT - 0.65) / 0.35);
        }
      }

      const envY = Math.min(1.52, Math.max(0.78, y));
      const env = body.sampleTorso(envY, th);
      const botFlare = flareBot * Math.pow(Math.max(0, 1 - bodyFrac * 2.2), 1.6);
      // Strictly NON-NEGATIVE outward pleats & folds so fabric NEVER dips inward into skin!
      const pleatWave = pleats > 0 ? (0.5 + 0.5 * Math.cos(th * pleats)) * pleatAmp * (1 - bodyFrac * 0.55) : 0;
      const drapeFold = (0.5 + 0.5 * Math.sin(th * 7 + bodyFrac * 4.5)) * 0.004;
      // Tuck lower shirt slightly narrower below waist so outer trousers/skirt waistband + belt sit cleanly outside!
      const tuckDrop = tucked && y < (body.female ? 1.00 : 0.99) ? -0.005 * Math.min(1, ((body.female ? 1.00 : 0.99) - y) / 0.08) : 0;
      let r = env.r + clearance + tuckDrop + botFlare + pleatWave + drapeFold;
      let zc = env.zc;

      if (inYoke) {
        // Curve smoothly inward over shoulders toward the neck collar while always staying strictly outside the body!
        const collarR = neckR + (standCollar > 0 ? 0.010 : 0.014);
        const curveW = Math.pow(yokeT, 1.10);
        const shEnv = body.sampleTorso(Math.min(1.52, yokeY0), th);
        const outerShoulderR = shEnv.r + clearance;
        const yokeR = outerShoulderR * (1 - curveW) + collarR * curveW;
        // Also sample exact body radius at this (y, th) so neck/trapezius never pokes through!
        r = Math.max(env.r + 0.014, yokeR);
        zc = shEnv.zc * (1 - curveW) + neckZ * curveW;
      }

      const x = Math.sin(th) * r;
      const z = zc + Math.cos(th) * r;

      let ch = channel;
      let fab = fabric;
      let ao = 0.88 + 0.08 * Math.cos(th * Math.max(6, pleats)) - 0.10 * Math.pow(1 - bodyFrac, 4);
      if (collarChannel !== null && inYoke && yokeT > 0.68) { ch = collarChannel; fab = FAB.LINEN; ao = 0.96; }
      else if (hemTrim && !inYoke && bodyFrac < 0.09) { ch = CH.TRIM; fab = FAB.COTTON; ao = 0.90; }
      else if (placketChannel !== null && cosFront > 0.965 && bodyFrac > 0.12 && (!inYoke || yokeT < 0.72)) {
        ch = placketChannel; fab = FAB.BRASS; ao = 0.92;
      } else if (bodiceLace && cosFront > 0.92 && bodyFrac > 0.14 && !inYoke) {
        const lace = Math.abs(Math.sin(bodyFrac * 28.0 + Math.abs(x) * 80.0));
        if (lace > 0.82) { ch = CH.LINEN; ao = 0.95; }
        else ao *= 0.84;
      }
      if ((inYoke && yokeT > 0.85) || (!inYoke && bodyFrac < 0.04)) ao *= 0.86;

      // Skin torso vertices to the closest torso/spine/clavicle body vertices (excluding outstretched arms)
      const [j, w] = body.nearestSkin(
        x * (inYoke ? 0.82 : 0.90),
        Math.min(1.50, Math.max(0.84, y)),
        z,
        (v) => Math.abs(body.pos[v * 3]) < Math.abs(body.shL[0]) + 0.04,
      );
      const flex = hemFlex * Math.pow(Math.max(0, 1 - bodyFrac * 1.8), 1.6);
      row.push(mesh.addVertex(x, y, z, packClothWord(ch, fab, ao, uFrac * 4, vFrac * 3), j, w, flex, uFrac));
    }
    rings.push(row);
  }
  mesh.addTube(rings, true);
}

function addSleeves(mesh, body, {
  xEndFrac = 0.56, nX = 16, nT = 22, clearance = 0.024,
  puffAmp = 0.0, cuffTrim = false, rolledCuff = true,
  channel = CH.SHIRT, fabric = FAB.LINEN, sleeveFlex = 0.18,
}) {
  // Tuck sleeve root cleanly inside the torso shoulder cap (armX0 * 0.78) so there is zero shoulder gap!
  const x0 = body.armX0 * 0.78;
  const x1 = body.armX0 + (body.armX1 - body.armX0) * xEndFrac;
  for (let side = 0; side < 2; side++) {
    const sgn = side === 0 ? 1 : -1;
    const rings = [];
    for (let ix = 0; ix < nX; ix++) {
      const uFrac = ix / (nX - 1);
      const ax = x0 + uFrac * (x1 - x0);
      const row = [];
      for (let it = 0; it < nT; it++) {
        const vFrac = it / nT;
        const th = vFrac * Math.PI * 2;
        const env = body.sampleArm(side, Math.max(body.armX0, ax), th);
        const capFlare = uFrac < 0.22 ? 0.012 * (1 - uFrac / 0.22) : 0;
        const puff = puffAmp * Math.sin(uFrac * Math.PI) * (0.85 + 0.15 * Math.cos(th * 6));
        const cuffBulge = rolledCuff && uFrac > 0.86 ? 0.008 * Math.sin(((uFrac - 0.86) / 0.14) * Math.PI) : 0;
        const hang = Math.sin(th) < 0 ? 0.007 * Math.sin(uFrac * Math.PI) * (-Math.sin(th)) : 0;
        const r = env.r + clearance + capFlare + puff + cuffBulge + hang;
        const x = ax * sgn;
        const y = env.yc + Math.sin(th) * r;
        const z = env.zc + Math.cos(th) * r;

        let ch = channel, fab = fabric;
        let ao = 0.88 + 0.06 * Math.cos(th * 6);
        if (cuffTrim && uFrac > 0.87) { ch = CH.LINEN; fab = FAB.LINEN; ao = 0.95; }
        else if (uFrac > 0.92) ao *= 0.82;

        const [j, w] = body.nearestSkin(x, y, z, (v) => body.pos[v * 3] * sgn > 0.02);
        const flex = sleeveFlex * Math.sin(uFrac * Math.PI) * (Math.sin(th) < 0 ? 1.0 : 0.35);
        row.push(mesh.addVertex(x, y, z, packClothWord(ch, fab, ao, uFrac * 2, vFrac * 2), j, w, flex, vFrac + side * 0.5));
      }
      rings.push(row);
    }
    mesh.addTube(rings, true);
  }
}

function addBeltAndBuckle(mesh, body, {
  yCenter, halfH = 0.026, clearance = 0.028, beltChannel = CH.LEATHER, buckleChannel = CH.BRASS,
}) {
  const nY = 4, nT = 32;
  const rings = [];
  for (let iy = 0; iy < nY; iy++) {
    const f = iy / (nY - 1);
    const y = yCenter + (f - 0.5) * halfH * 2;
    const bulge = Math.sin(f * Math.PI) * 0.005;
    const row = [];
    for (let it = 0; it < nT; it++) {
      const uFrac = it / nT;
      const th = uFrac * Math.PI * 2;
      const env = body.sampleTorso(y, th);
      const isBuckle = buckleChannel !== null && Math.cos(th) > 0.965 && iy >= 1 && iy <= 2;
      const r = env.r + clearance + bulge + (isBuckle ? 0.007 : 0);
      const x = Math.sin(th) * r;
      const z = env.zc + Math.cos(th) * r;
      const ch = isBuckle ? buckleChannel : beltChannel;
      const fab = isBuckle ? FAB.BRASS : FAB.LEATHER;
      const ao = isBuckle ? 0.98 : (0.86 + 0.08 * Math.sin(f * Math.PI));
      const [j, w] = body.nearestSkin(x, y, z);
      row.push(mesh.addVertex(x, y, z, packClothWord(ch, fab, ao, uFrac * 6, f), j, w, 0, uFrac));
    }
    rings.push(row);
  }
  mesh.addTube(rings, true);
}

function addShoes(mesh, body, {
  channel = CH.LEATHER, fabric = FAB.LEATHER, cuffY = 0.115, cuffClr = 0.008,
}) {
  const nT = 22;
  const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let side = 0; side < 2; side++) {
    const fb = body.feet[side];
    const footJoint = side === 0 ? CREW_SLOT.foot_l : CREW_SLOT.foot_r;
    const ballJoint = side === 0 ? CREW_SLOT.ball_l : CREW_SLOT.ball_r;
    const cx = (fb.minX + fb.maxX) * 0.5;
    const hx = (fb.maxX - fb.minX) * 0.5 + 0.006;
    const zToeOut = fb.maxZ + 0.008;
    const zHeelOut = fb.minZ - 0.007;
    const czMid = (zToeOut + zHeelOut) * 0.5;
    const y0 = Math.max(0.0, fb.minY);
    const leg0 = body.sampleLeg(side, cuffY, 0);
    const axc = leg0.xc, azc = leg0.zc;
    const ankleR = Array.from({ length: nT }, (_, it) => body.sampleLeg(side, cuffY, (it / nT) * Math.PI * 2).r + cuffClr);
    const dToe = Math.max(0.08, zToeOut - azc);
    const dHeel = Math.max(0.04, azc - zHeelOut);

    const footXZ = (th, scale) => {
      const ct = Math.cos(th), st = Math.sin(th);
      const wS = ct >= 0 ? (1.02 - 0.14 * ct * ct) : (1.00 - 0.16 * ct * ct);
      const xcTh = axc * (0.5 - 0.5 * ct) + cx * (0.5 + 0.5 * ct);
      const fx0 = xcTh + st * hx * wS;
      const fz0 = azc + (ct >= 0 ? ct * dToe : ct * dHeel);
      return [cx + (fx0 - cx) * scale, czMid + (fz0 - czMid) * scale];
    };
    const ankleXZ = (it, rDel) => {
      const th = (it / nT) * Math.PI * 2;
      const r = Math.max(0.025, ankleR[it] + rDel);
      return [axc + Math.sin(th) * r, azc + Math.cos(th) * r];
    };

    const yToeTop = y0 + 0.044;
    const yVamp = yToeTop + (cuffY - yToeTop) * 0.44;
    const yThroat = yToeTop + (cuffY - yToeTop) * 0.76;
    const profile = [
      ['sole_in', y0, 0.00, 0.00, 0.42, 0.000, 0.00],
      ['sole_out', y0, 0.00, 0.00, 1.00, 0.000, 0.08],
      ['welt', y0 + 0.009, 0.00, 0.00, 1.03, 0.000, 0.16],
      ['wall', y0 + 0.022, 0.04, 0.12, 1.00, 0.000, 0.28],
      ['toe_box', y0 + 0.035, 0.20, 0.36, 0.99, 0.000, 0.42],
      ['vamp0', yToeTop, 0.52, 0.72, 0.98, 0.000, 0.56],
      ['vamp1', yVamp, 0.82, 0.92, 0.98, 0.000, 0.70],
      ['throat', yThroat, 0.96, 0.98, 0.98, 0.000, 0.82],
      ['collar', cuffY, 1.00, 1.00, 1.00, 0.002, 0.92],
      ['rim_top', cuffY + 0.002, 1.00, 1.00, 1.00, -0.001, 0.96],
      ['rim_in', cuffY - 0.016, 1.00, 1.00, 1.00, -0.004, 1.00],
    ];
    const rings = [];
    for (const [kind, yBase, fbFr, fbBk, fScale, rDel, vUV] of profile) {
      const row = [];
      for (let it = 0; it < nT; it++) {
        const uFrac = it / nT, th = uFrac * Math.PI * 2, ct = Math.cos(th);
        const fw = sstep(-0.30, 0.30, ct);
        const blend = fbBk * (1 - fw) + fbFr * fw;
        const [fx, fz] = footXZ(th, fScale);
        const [ax, az] = ankleXZ(it, rDel);
        const x = fx * (1 - blend) + ax * blend;
        const z = fz * (1 - blend) + az * blend;
        let y = yBase;
        if (kind === 'sole_in' || kind === 'sole_out') {
          y = Math.max(0.0, yBase + (ct < -0.20 ? -0.003 : (ct < 0.25 ? 0.002 : 0.0)));
        } else if (kind === 'welt') {
          y = Math.max(0.005, yBase + (ct < -0.20 ? -0.002 : 0.0));
        } else if ((kind === 'toe_box' || kind === 'vamp0') && ct > 0) {
          y = yBase + 0.005 * (1 - ct * 0.5);
        }
        const toeW = Math.max(0, Math.min(1, (z - czMid) / Math.max(0.04, dToe)));
        const ao = 0.78 + 0.14 * vUV;
        row.push(mesh.addVertex(
          x, y, z,
          packClothWord(channel, fabric, ao, uFrac * 2, vUV),
          [footJoint, ballJoint],
          [1 - toeW * 0.45, toeW * 0.45],
          0, uFrac,
        ));
      }
      rings.push(row);
    }
    mesh.addTube(rings, true);
    // Close bottom sole completely with center pole (outward -Y normal)
    const botIdx = mesh.addVertex(
      cx, Math.max(0.0, y0), czMid,
      packClothWord(channel, fabric, 0.76, 0.5, 0.0),
      [footJoint, ballJoint], [0.75, 0.25], 0, 0.5,
    );
    const r0 = rings[0];
    for (let s = 0; s < nT; s++) {
      const s2 = (s + 1) % nT;
      mesh.addTri(botIdx, r0[s2], r0[s]);
    }
  }
}

function addLegTrousers(mesh, body, {
  yWaist, yKnee, yAnkle = null,
  clearanceHip = 0.024, clearanceThigh = 0.036, clearanceKnee = 0.022,
  hoseChannel = null, channel = CH.TROUSERS, fabric = FAB.WOOL,
  slopPuff = 0.022, pleatFreq = 8,
}) {
  // Pelvis/hip shorts shell bridging waist down to upper thighs (y in [yCrotch, yWaist])
  const yCrotch = body.female ? 0.79 : 0.81;
  addTorsoShell(mesh, body, {
    yBot: yCrotch, yTop: yWaist, nY: 8, nT: 32,
    clearance: clearanceHip, flareBot: slopPuff * 0.6,
    channel, fabric, hemFlex: 0.08, pleats: pleatFreq, pleatAmp: slopPuff * 0.25,
    shoulderYoke: false,
  });

  // Left and right leg sleeves from upper thigh to knee (plus optional fitted hose down to shoes)
  for (let side = 0; side < 2; side++) {
    const nY = 12, nT = 22;
    const rings = [];
    for (let iy = 0; iy < nY; iy++) {
      const f = iy / (nY - 1);
      const y = yKnee + f * ((yCrotch + 0.05) - yKnee);
      const env = body.sampleLeg(side, y, 0);
      const puff = slopPuff * Math.sin(f * Math.PI);
      const row = [];
      for (let it = 0; it < nT; it++) {
        const uFrac = it / nT;
        const th = uFrac * Math.PI * 2;
        const e = body.sampleLeg(side, y, th);
        const pleat = Math.cos(th * pleatFreq) * (slopPuff * 0.16) * Math.sin(f * Math.PI);
        const clr = clearanceKnee * (1 - f) + clearanceThigh * f;
        const r = e.r + clr + puff + pleat;
        const x = e.xc + Math.sin(th) * r;
        const z = e.zc + Math.cos(th) * r;
        const ao = 0.86 + 0.08 * Math.cos(th * pleatFreq) - (f < 0.08 ? 0.10 : 0);
        const [j, w] = body.nearestSkin(x, y, z, (v) => body.pos[v * 3] * (side === 0 ? 1 : -1) > -0.01);
        const flex = 0.12 * Math.sin(f * Math.PI);
        row.push(mesh.addVertex(x, y, z, packClothWord(channel, fabric, ao, uFrac * 2, f * 2), j, w, flex, uFrac + side * 0.5));
      }
      rings.push(row);
    }
    mesh.addTube(rings, true);

    // Optional fitted stockings / hose from knee down to ankle shoes
    if (hoseChannel !== null && yAnkle !== null) {
      const hRings = [];
      for (let iy = 0; iy < 10; iy++) {
        const f = iy / 9;
        const y = yAnkle + f * ((yKnee + 0.03) - yAnkle);
        const row = [];
        for (let it = 0; it < 18; it++) {
          const uFrac = it / 18;
          const th = uFrac * Math.PI * 2;
          const e = body.sampleLeg(side, y, th);
          const r = e.r + 0.014;
          const x = e.xc + Math.sin(th) * r;
          const z = e.zc + Math.cos(th) * r;
          const [j, w] = body.nearestSkin(x, y, z, (v) => body.pos[v * 3] * (side === 0 ? 1 : -1) > -0.01);
          row.push(mesh.addVertex(x, y, z, packClothWord(hoseChannel, FAB.WOOL, 0.88, uFrac * 2, f * 2), j, w, 0, uFrac));
        }
        hRings.push(row);
      }
      mesh.addTube(hRings, true);
    }
  }
}

function addPleatedSkirt(mesh, body, {
  yWaist, yHem = 0.11, nY = 20, nT = 44,
  waistClearance = 0.022, hemRadiusX = 0.34, hemRadiusZ = 0.30,
  pleats = 16, pleatAmp = 0.018, channel = CH.TROUSERS, fabric = FAB.WOOL,
  hemTrim = false, apron = false, maxFlex = 0.85,
}) {
  const rings = [];
  for (let iy = 0; iy < nY; iy++) {
    const vFrac = iy / (nY - 1); // 0 = hem, 1 = waist
    const y = yHem + vFrac * (yWaist - yHem);
    const down = 1 - vFrac; // 0 at waist, 1 at hem
    const row = [];
    for (let it = 0; it < nT; it++) {
      const uFrac = it / nT;
      const th = uFrac * Math.PI * 2;
      // Waist hugs anatomical torso; below hips flares gracefully into a physical A-line kirtle bell!
      const envW = body.sampleTorso(Math.max(0.78, y), th);
      const bellW = Math.pow(down, 0.82);
      const baseRx = envW.r + waistClearance;
      const targetR = Math.hypot(Math.sin(th) * hemRadiusX, Math.cos(th) * hemRadiusZ);
      const pleatWave = Math.cos(th * pleats) * pleatAmp * (0.25 + 0.75 * down);
      // Guarantee strict clearance outside both legs at every height!
      const legSide = Math.sin(th) >= 0 ? 0 : 1;
      const legEnv = body.sampleLeg(legSide, Math.min(0.86, Math.max(0.05, y)), th);
      const legOut = Math.hypot(legEnv.xc + Math.sin(th) * (legEnv.r + 0.032), (legEnv.zc - envW.zc) + Math.cos(th) * (legEnv.r + 0.032));
      const r = Math.max(baseRx * (1 - bellW) + targetR * bellW, legOut) + pleatWave;

      const x = Math.sin(th) * r;
      const z = envW.zc + Math.cos(th) * r;

      let ch = channel, fab = fabric;
      let ao = 0.84 + 0.14 * Math.cos(th * pleats) - (vFrac > 0.94 ? 0.10 : 0);
      if (hemTrim && vFrac < 0.09) { ch = CH.TRIM; fab = FAB.COTTON; ao = 0.92; }

      // Smooth hip-to-leg kinematic skinning: waist rides pelvis, lower skirt blends smoothly with left/right thighs & calves
      // so walking legs carry the pleated bell naturally without clipping!
      const sideBlend = Math.max(0, Math.min(1, (x / 0.16) * 0.5 + 0.5)); // 1 = left (+X), 0 = right (-X)
      const pelW = Math.max(0.18, 1 - down * 0.85);
      const legW = (1 - pelW) * (1 - down * 0.25);
      const calfW = (1 - pelW) * (down * 0.25);
      const j = [CREW_SLOT.pelvis, CREW_SLOT.thigh_l, CREW_SLOT.thigh_r, sideBlend >= 0.5 ? CREW_SLOT.calf_l : CREW_SLOT.calf_r];
      const w = [pelW, legW * sideBlend, legW * (1 - sideBlend), calfW];
      const flex = maxFlex * Math.pow(down, 1.55);
      row.push(mesh.addVertex(x, y, z, packClothWord(ch, fab, ao, uFrac * 5, vFrac * 4), j, w, flex, uFrac));
    }
    rings.push(row);
  }
  mesh.addTube(rings, true);

  // Separate contrasting crisp white linen working apron draped over the front of the skirt!
  if (apron) {
    const aRings = [];
    const aNY = 16, aNT = 20;
    const yApronBot = yHem + (yWaist - yHem) * 0.18;
    for (let iy = 0; iy < aNY; iy++) {
      const vFrac = iy / (aNY - 1);
      const y = yApronBot + vFrac * (yWaist - yApronBot);
      const down = 1 - ((y - yHem) / (yWaist - yHem));
      const row = [];
      for (let it = 0; it < aNT; it++) {
        const s = it / (aNT - 1); // 0..1 across front arc [-0.34*PI .. +0.34*PI]
        const th = (s - 0.5) * Math.PI * 0.68;
        const envW = body.sampleTorso(Math.max(0.78, y), th);
        const bellW = Math.pow(down, 0.82);
        const baseRx = envW.r + waistClearance;
        const targetR = Math.hypot(Math.sin(th) * hemRadiusX, Math.cos(th) * hemRadiusZ);
        const pleatWave = Math.cos(th * pleats) * pleatAmp * (0.25 + 0.75 * down);
        const legSide = Math.sin(th) >= 0 ? 0 : 1;
        const legEnv = body.sampleLeg(legSide, Math.min(0.86, Math.max(0.05, y)), th);
        const legOut = Math.hypot(legEnv.xc + Math.sin(th) * (legEnv.r + 0.032), (legEnv.zc - envW.zc) + Math.cos(th) * (legEnv.r + 0.032));
        const skirtR = Math.max(baseRx * (1 - bellW) + targetR * bellW, legOut) + pleatWave;
        const r = skirtR + 0.016 + 0.004 * down;
        const x = Math.sin(th) * r;
        const z = envW.zc + Math.cos(th) * r;
        const ao = 0.90 + 0.06 * Math.cos(th * 12) - (vFrac < 0.08 ? 0.08 : 0);
        const sideBlend = Math.max(0, Math.min(1, (x / 0.16) * 0.5 + 0.5));
        const pelW = Math.max(0.18, 1 - down * 0.85);
        const legW = (1 - pelW) * (1 - down * 0.25);
        const calfW = (1 - pelW) * (down * 0.25);
        const flex = maxFlex * Math.pow(down, 1.55);
        row.push(mesh.addVertex(
          x, y, z,
          packClothWord(CH.LINEN, FAB.LINEN, ao, s * 2, vFrac * 3),
          [CREW_SLOT.pelvis, CREW_SLOT.thigh_l, CREW_SLOT.thigh_r, sideBlend >= 0.5 ? CREW_SLOT.calf_l : CREW_SLOT.calf_r],
          [pelW, legW * sideBlend, legW * (1 - sideBlend), calfW],
          flex, s,
        ));
      }
      aRings.push(row);
    }
    mesh.addTube(aRings, false);
  }
}

function addShoulderCloak(mesh, body) {
  // 1550 Iberian short shoulder cloak pinned at the collarbone, draping freely over back & shoulders!
  const yTop = body.neck[1] - 0.02;
  const yBot = 0.64;
  const nY = 16, nT = 28;
  const rings = [];
  for (let iy = 0; iy < nY; iy++) {
    const vFrac = iy / (nY - 1); // 0 = bottom hem, 1 = shoulder collar
    const down = 1 - vFrac;
    const y = yBot + vFrac * (yTop - yBot);
    const row = [];
    for (let it = 0; it < nT; it++) {
      const s = it / (nT - 1); // open front gap: spans back arc from +0.26*PI around PI (back) to +1.74*PI
      const th = Math.PI * (0.26 + s * 1.48);
      const env = body.sampleTorso(Math.max(0.80, Math.min(1.50, y)), th);
      const shoulderWide = 0.25 + 0.13 * down;
      const backDepth = 0.19 + 0.15 * down;
      const targetR = Math.hypot(Math.sin(th) * shoulderWide, Math.cos(th) * backDepth);
      const fold = Math.cos(s * Math.PI * 10) * 0.014 * down;
      const r = Math.max(env.r + 0.032, targetR) + fold;
      const x = Math.sin(th) * r;
      const z = env.zc + Math.cos(th) * r - 0.025 * down;
      const isTrim = vFrac < 0.07 || s < 0.05 || s > 0.95;
      const ch = isTrim ? CH.TRIM : CH.HOSE;
      const ao = 0.84 + 0.12 * Math.cos(s * Math.PI * 10);
      const flex = 0.92 * Math.pow(down, 1.35);
      row.push(mesh.addVertex(
        x, y, z,
        packClothWord(ch, FAB.WOOL, ao, s * 4, vFrac * 3),
        [CREW_SLOT.spine_03, CREW_SLOT.spine_02, CREW_SLOT.pelvis],
        [0.45 + 0.45 * vFrac, 0.35, 0.20 * down],
        flex, s,
      ));
    }
    rings.push(row);
  }
  mesh.addTube(rings, false);
}

// --------------------------------------------------------------------------- Build all 14 physical 1550 garments
function buildGarment(spec, male, female) {
  const m = createClothMesh();
  const body = spec.sex === 'female' ? female : male;
  const waistY = body.female ? 1.01 : 1.00;
  const topY = body.female ? 1.44 : 1.49;

  switch (spec.id) {
    case 'male-linen-shirt':
      addTorsoShell(m, male, {
        yBot: 0.88, yTop: topY, clearance: 0.022, flareBot: 0.004,
        vNeckDepth: 0.075, vNeckWidth: 0.20, tucked: true,
        channel: CH.SHIRT, fabric: FAB.LINEN, hemFlex: 0.14, pleats: 8, pleatAmp: 0.004,
      });
      addSleeves(m, male, {
        xEndFrac: 0.56, clearance: 0.020, puffAmp: 0.010, rolledCuff: true,
        channel: CH.SHIRT, fabric: FAB.LINEN, sleeveFlex: 0.18,
      });
      break;

    case 'male-doublet':
      addTorsoShell(m, male, {
        yBot: 0.85, yTop: topY + 0.01, clearance: 0.030, flareBot: 0.026,
        standCollar: 0.036, collarChannel: CH.LINEN, placketChannel: CH.BRASS,
        channel: CH.SHIRT, fabric: FAB.WOOL, hemFlex: 0.12,
      });
      addSleeves(m, male, {
        xEndFrac: 0.88, clearance: 0.022, puffAmp: 0.012, cuffTrim: true, rolledCuff: false,
        channel: CH.SHIRT, fabric: FAB.WOOL, sleeveFlex: 0.12,
      });
      break;

    case 'male-soldier-jerkin':
      // Linen undertunic sleeves + buff leather tercio jerkin torso with brass studs
      addSleeves(m, male, {
        xEndFrac: 0.84, clearance: 0.020, puffAmp: 0.009, cuffTrim: true,
        channel: CH.LINEN, fabric: FAB.LINEN, sleeveFlex: 0.14,
      });
      addTorsoShell(m, male, {
        yBot: 0.84, yTop: topY + 0.005, clearance: 0.032, flareBot: 0.024,
        standCollar: 0.028, placketChannel: CH.BRASS,
        channel: CH.BUFF, fabric: FAB.LEATHER, hemFlex: 0.10,
      });
      break;

    case 'female-chemise-blouse':
      addTorsoShell(m, female, {
        yBot: 0.89, yTop: topY, clearance: 0.020, tucked: true,
        scoopDepth: 0.062, channel: CH.SHIRT, fabric: FAB.LINEN, hemFlex: 0.10, pleats: 10, pleatAmp: 0.004,
      });
      addSleeves(m, female, {
        xEndFrac: 0.58, clearance: 0.020, puffAmp: 0.022, rolledCuff: true,
        channel: CH.SHIRT, fabric: FAB.LINEN, sleeveFlex: 0.20,
      });
      break;

    case 'female-laced-bodice':
      // Crisp off-white linen chemise sleeves & collar trim + dyed laced bodice torso
      addSleeves(m, female, {
        xEndFrac: 0.56, clearance: 0.020, puffAmp: 0.024, rolledCuff: true,
        channel: CH.LINEN, fabric: FAB.LINEN, sleeveFlex: 0.20,
      });
      addTorsoShell(m, female, {
        yBot: 0.89, yTop: topY, clearance: 0.022, tucked: true,
        scoopDepth: 0.070, collarChannel: CH.LINEN, bodiceLace: true,
        channel: CH.SHIRT, fabric: FAB.WOOL, hemFlex: 0.08,
      });
      break;

    case 'indigenous-tunic-m':
      addTorsoShell(m, male, {
        yBot: 0.80, yTop: topY, clearance: 0.028, flareBot: 0.022,
        scoopDepth: 0.060, hemTrim: true,
        channel: CH.SHIRT, fabric: FAB.COTTON, hemFlex: 0.26, pleats: 6, pleatAmp: 0.005,
      });
      addSleeves(m, male, {
        xEndFrac: 0.30, clearance: 0.022, puffAmp: 0.006, rolledCuff: false,
        channel: CH.SHIRT, fabric: FAB.COTTON, sleeveFlex: 0.22,
      });
      break;

    case 'indigenous-huipil-f':
      addTorsoShell(m, female, {
        yBot: 0.82, yTop: topY, clearance: 0.028, flareBot: 0.024,
        scoopDepth: 0.058, hemTrim: true,
        channel: CH.SHIRT, fabric: FAB.COTTON, hemFlex: 0.28, pleats: 8, pleatAmp: 0.005,
      });
      addSleeves(m, female, {
        xEndFrac: 0.32, clearance: 0.022, puffAmp: 0.009, rolledCuff: false,
        channel: CH.SHIRT, fabric: FAB.COTTON, sleeveFlex: 0.22,
      });
      break;

    case 'male-mariner-slops':
      addLegTrousers(m, male, {
        yWaist: waistY + 0.03, yKnee: 0.42, clearanceHip: 0.028, clearanceThigh: 0.034, clearanceKnee: 0.020,
        channel: CH.TROUSERS, fabric: FAB.WOOL, slopPuff: 0.020, pleatFreq: 8,
      });
      addBeltAndBuckle(m, male, { yCenter: waistY + 0.018, clearance: 0.036 });
      addShoes(m, male, { channel: CH.LEATHER, fabric: FAB.LEATHER, cuffY: 0.115 });
      break;

    case 'male-trunk-hose':
      addLegTrousers(m, male, {
        yWaist: waistY + 0.03, yKnee: 0.54, yAnkle: 0.09,
        clearanceHip: 0.026, clearanceThigh: 0.042, clearanceKnee: 0.022,
        hoseChannel: CH.HOSE, channel: CH.TROUSERS, fabric: FAB.WOOL, slopPuff: 0.032, pleatFreq: 12,
      });
      addBeltAndBuckle(m, male, { yCenter: waistY + 0.018, clearance: 0.038 });
      addShoes(m, male, { channel: CH.LEATHER, fabric: FAB.LEATHER, cuffY: 0.16 });
      break;

    case 'female-pleated-skirt':
      addPleatedSkirt(m, female, {
        yWaist: waistY + 0.03, yHem: 0.11, waistClearance: 0.028,
        hemRadiusX: 0.34, hemRadiusZ: 0.30, pleats: 16, pleatAmp: 0.018,
        channel: CH.TROUSERS, fabric: FAB.WOOL, apron: false, maxFlex: 0.85,
      });
      addBeltAndBuckle(m, female, { yCenter: waistY + 0.022, halfH: 0.018, clearance: 0.033, beltChannel: CH.LEATHER, buckleChannel: null });
      addShoes(m, female, { channel: CH.LEATHER, fabric: FAB.LEATHER, cuffY: 0.105 });
      break;

    case 'female-apron-skirt':
      addPleatedSkirt(m, female, {
        yWaist: waistY + 0.03, yHem: 0.11, waistClearance: 0.028,
        hemRadiusX: 0.35, hemRadiusZ: 0.31, pleats: 16, pleatAmp: 0.018,
        channel: CH.TROUSERS, fabric: FAB.WOOL, apron: true, maxFlex: 0.85,
      });
      addBeltAndBuckle(m, female, { yCenter: waistY + 0.022, halfH: 0.018, clearance: 0.034, beltChannel: CH.LINEN, buckleChannel: null });
      addShoes(m, female, { channel: CH.LEATHER, fabric: FAB.LEATHER, cuffY: 0.105 });
      break;

    case 'indigenous-breechcloth-m':
      addPleatedSkirt(m, male, {
        yWaist: waistY + 0.02, yHem: 0.48, nY: 12, nT: 32, waistClearance: 0.026,
        hemRadiusX: 0.25, hemRadiusZ: 0.22, pleats: 10, pleatAmp: 0.010,
        channel: CH.TROUSERS, fabric: FAB.COTTON, hemTrim: true, maxFlex: 0.55,
      });
      addBeltAndBuckle(m, male, { yCenter: waistY + 0.015, halfH: 0.022, clearance: 0.034, beltChannel: CH.TRIM, buckleChannel: null });
      addShoes(m, male, { channel: CH.BUFF, fabric: FAB.LEATHER, cuffY: 0.105 });
      break;

    case 'indigenous-wrap-skirt-f':
      addPleatedSkirt(m, female, {
        yWaist: waistY + 0.02, yHem: 0.18, nY: 18, nT: 38, waistClearance: 0.026,
        hemRadiusX: 0.30, hemRadiusZ: 0.27, pleats: 12, pleatAmp: 0.012,
        channel: CH.TROUSERS, fabric: FAB.COTTON, hemTrim: true, maxFlex: 0.72,
      });
      addBeltAndBuckle(m, female, { yCenter: waistY + 0.015, halfH: 0.022, clearance: 0.034, beltChannel: CH.TRIM, buckleChannel: null });
      addShoes(m, female, { channel: CH.BUFF, fabric: FAB.LEATHER, cuffY: 0.10 });
      break;

    case 'shoulder-cloak':
      addShoulderCloak(m, male);
      break;

    default:
      throw Error(`Unknown garment type: ${spec.id}`);
  }
  return m.finalize();
}

// --------------------------------------------------------------------------- Load Blender real cloth-simulated .bin garment
const BLENDER_CLOTH_DIR = path.resolve(ROOT, '.tripo/1550-hd-base/cloth');
function loadBlenderClothBin(id) {
  const file = path.join(BLENDER_CLOTH_DIR, `${id}.bin`);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const magic = buf.subarray(0, 4).toString('ascii');
  if (magic !== 'CLTH') throw Error(`${file}: bad magic "${magic}"`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = view.getUint32(4, true);
  if (version !== 1) throw Error(`${file}: unsupported CLTH version ${version}`);
  const count = view.getUint32(8, true);
  const nTris = view.getUint32(12, true);
  let off = 16;
  const sliceF32 = (n) => { const a = new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * 4)); off += n * 4; return a; };
  const sliceU32 = (n) => { const a = new Uint32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * 4)); off += n * 4; return a; };
  const position = sliceF32(count * 3);
  const normal = sliceF32(count * 3);
  const words = sliceU32(count);
  const skinJ = sliceU32(count);
  const skinW = sliceU32(count);
  const wind = sliceU32(count);
  const index = sliceU32(nTris * 3);
  const parts = new Uint32Array(count);
  return { count, position, normal, words, skinJ, skinW, wind, index, parts, source: 'blender-cloth' };
}

// --------------------------------------------------------------------------- Bake all 14 garments into One Continuum atlas
await MeshoptSimplifier.ready;
const started = Date.now();
const useBlenderCloth = fs.existsSync(BLENDER_CLOTH_DIR) && !process.argv.includes('--procedural');
const male = useBlenderCloth ? null : loadBodyReference('sailor-male');
const female = useBlenderCloth ? null : loadBodyReference('villager-female');
const typeWords = [], manifestTypes = [];

for (const spec of CLOTHING_CONTINUUM_TYPES) {
  const t0 = Date.now();
  const built = (useBlenderCloth && loadBlenderClothBin(spec.id)) || buildGarment(spec, male || loadBodyReference('sailor-male'), female || loadBodyReference('villager-female'));
  const tris = built.index.length / 3;
  const garmentPart = spec.slot === 'lower' ? CREW_SLOT.pelvis : CREW_SLOT.spine_02;
  built.parts.fill(garmentPart);
  const kind = new Float32Array(built.count * 2);
  for (let v = 0; v < built.count; v++) {
    kind[v * 2] = (built.words[v] & 7) / 8;
    kind[v * 2 + 1] = ((built.words[v] >>> 8) & 255) / 255;
  }
  const welded = {
    position: built.position, normal: built.normal, kind, part: built.parts,
    index: built.index, count: built.count, corner: null,
  };
  // Simplify far source to ~3600 tris when baking 30k-50k-tri Blender cloth so far-collapse baking stays fast while near clusters keep 100% full cloth detail!
  let farIndex = built.index;
  if (tris > 4200) {
    const [simp] = MeshoptSimplifier.simplify(built.index, built.position, 3, 3600 * 3, 0.04);
    if (simp.length >= 600) farIndex = simp;
  }
  const farTris = farIndex.length / 3;
  const farFloats = new Float32Array(farIndex.length * 8);
  for (let i = 0; i < farIndex.length; i++) {
    const v = farIndex[i], o = i * 8;
    farFloats[o] = built.position[v * 3];
    farFloats[o + 1] = built.position[v * 3 + 1];
    farFloats[o + 2] = built.position[v * 3 + 2];
    farFloats[o + 3] = built.normal[v * 3];
    farFloats[o + 4] = built.normal[v * 3 + 1];
    farFloats[o + 5] = built.normal[v * 3 + 2];
    farFloats[o + 6] = kind[v * 2];
    farFloats[o + 7] = kind[v * 2 + 1];
  }
  const baked = await bakeContinuumBody({
    name: spec.id,
    welded,
    far: { vertices: farFloats, triangles: farTris, parts: new Uint32Array(farTris).fill(garmentPart) },
  });
  const { clusters, far } = baked;

  // Map each far-body vertex's skinning & cloth flex from its nearest sculpted garment vertex
  const farCount = far.position.length / 3;
  const farSkinJ = new Uint32Array(farCount);
  const farSkinW = new Uint32Array(farCount);
  const farWind = new Uint32Array(farCount);
  const farWord = new Uint32Array(far.index.length / 3);
  const nearestBuilt = (px, py, pz) => {
    let bestV = 0, bestD = Infinity;
    for (let v = 0; v < built.count; v++) {
      const d = (built.position[v * 3] - px) ** 2 + (built.position[v * 3 + 1] - py) ** 2 + (built.position[v * 3 + 2] - pz) ** 2;
      if (d < bestD) { bestD = d; bestV = v; }
    }
    return bestV;
  };
  const farMap = new Uint32Array(farCount);
  for (let i = 0; i < farCount; i++) {
    const bv = nearestBuilt(far.position[i * 3], far.position[i * 3 + 1], far.position[i * 3 + 2]);
    farMap[i] = bv;
    farSkinJ[i] = built.skinJ[bv];
    farSkinW[i] = built.skinW[bv];
    farWind[i] = built.wind[bv];
  }
  for (let t = 0; t < farWord.length; t++) {
    farWord[t] = built.words[farMap[far.index[t * 3]]];
  }

  const packed = packContinuumBody({
    triangles: tris,
    splat: far.splat,
    vertex: (v) => ({ word: built.words[v] }),
    farWord: (t) => farWord[t],
    streams: {
      skin: (v) => [built.skinJ[v], built.skinW[v]],
      wind: (v) => [built.wind[v]],
    },
    farStreams: {
      skin: (i) => [farSkinJ[i], farSkinW[i]],
      wind: (i) => [farWind[i]],
    },
  }, baked);

  typeWords.push(packed.words);
  manifestTypes.push({
    index: spec.index,
    id: spec.id,
    sex: spec.sex,
    slot: spec.slot,
    triangles: tris,
    clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootError: +clusters.rootError.toFixed(4) },
    chain: far.stats,
  });
  console.log(`  [${String(spec.index).padStart(2)}] ${spec.id.padEnd(24)} ${String(tris).padStart(5)} tris · ${String(clusters.count).padStart(3)} clusters (${clusters.levels} lv) · far ${far.stats.baseTriangles}→${far.stats.coreTriangles} in ${far.stats.steps} steps · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const atlas = checkContinuumAtlas(assembleContinuumAtlas(typeWords), 'clothing continuum');
const rawBytes = Buffer.from(atlas.buffer, atlas.byteOffset, atlas.byteLength);
const gzBytes = zlib.gzipSync(rawBytes, { level: 9 });
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'atlas.bin.gz'), gzBytes);

const manifest = {
  format: CLOTHING_CONTINUUM_FORMAT,
  version: CLOTHING_CONTINUUM_VERSION,
  generator: 'scripts/prepare-clothing-continuum.mjs',
  atlas: {
    words: atlas.length,
    headerWords: CONTINUUM_HEADER_WORDS,
    bytes: rawBytes.length,
    sha256: createHash('sha256').update(rawBytes).digest('hex'),
    gzip: {
      file: 'atlas.bin.gz',
      bytes: gzBytes.length,
      sha256: createHash('sha256').update(gzBytes).digest('hex'),
    },
  },
  types: manifestTypes,
};
validateClothingContinuumManifest(manifest);
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`clothing continuum baked: ${manifestTypes.length} garments, ${(rawBytes.length / 1048576).toFixed(2)} MiB raw (${(gzBytes.length / 1048576).toFixed(2)} MiB gz) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
