#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Generates and bakes the twelve physical 3D grass/rope-style strand hair and beard grooms into
// assets/crew/hair-continuum/{atlas.bin.gz,manifest.json} through the one bake (js/continuum-bake.js).
//   node scripts/prepare-hair-continuum.mjs
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readGLB, loadCrewGLB } from '../js/gltf.js';
import { CREW_SLOT } from '../js/crew-skeleton.js';
import { crewContinuumRestPlaces } from '../js/crew-continuum-draw.js';
import {
  CONTINUUM_HEADER_WORDS, assembleContinuumAtlas, checkContinuumAtlas, continuumOctahedral, packContinuumBody,
} from '../js/continuum-format.js';
import { bakeContinuumBody, closest, triangleGrid } from '../js/continuum-bake.js';
import {
  HAIR_CONTINUUM_FORMAT, HAIR_CONTINUUM_TYPES, HAIR_CONTINUUM_VERSION, validateHairContinuumManifest,
} from '../js/hair-continuum.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, 'assets/crew/hair-continuum');

const JOINT_HEAD = CREW_SLOT.head;
const JOINT_NECK = CREW_SLOT.neck_01;
const JOINT_SPINE = CREW_SLOT.spine_03;
const JOINT_JAW = CREW_SLOT.FACIAL_C_Jaw;
const JOINT_UPPER_LIP = CREW_SLOT.FACIAL_C_LipUpper;

// Deterministic PRNG (Mulberry32) so every groom bakes identically across machines.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function packSkin(joints, weights) {
  const list = [0, 1, 2, 3]
    .map((k) => [joints[k], weights[k]])
    .filter(([, w]) => w > 1e-6)
    .sort((a, b) => b[1] - a[1]);
  const sum = list.reduce((s, [, w]) => s + w, 0) || 1;
  const pairs = list.map(([j, w]) => [j, Math.round((w / sum) * 255)]);
  if (pairs.length) pairs[0][1] += 255 - pairs.reduce((s, [, q]) => s + q, 0);
  pairs.sort((a, b) => b[1] - a[1]);
  let J = 0, W = 0;
  pairs.forEach(([j, q], k) => { J |= j << (k * 8); W |= q << (k * 8); });
  return [J >>> 0, W >>> 0];
}

function packWind(flex, phase) {
  const f16 = Math.max(0, Math.min(65535, Math.round(flex * 65535)));
  const p16 = Math.max(1, Math.min(65535, Math.round(phase * 65535)));
  return (f16 | (p16 << 16)) >>> 0;
}

function packTangentToneSeed(tangent, tone, seed) {
  const [u, v] = continuumOctahedral(tangent);
  const tu = Math.max(0, Math.min(255, Math.round(u * 255)));
  const tv = Math.max(0, Math.min(255, Math.round(v * 255)));
  const t8 = Math.max(0, Math.min(255, Math.round(tone * 255)));
  const s8 = Math.max(0, Math.min(255, Math.round(seed * 255)));
  return (tu | (tv << 8) | (t8 << 16) | (s8 << 24)) >>> 0;
}

function norm3([x, y, z]) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
const add3 = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function loadReferenceHead(id) {
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
  const nrm = acc(at.NORMAL, Float32Array, 3);
  const idx = prim.indices !== undefined
    ? Uint32Array.from(acc(prim.indices, asset.json.accessors[prim.indices].componentType === 5123 ? Uint16Array : Uint32Array, 1))
    : null;

  const headPos = [...rest.subarray(JOINT_HEAD * 4, JOINT_HEAD * 4 + 3)];
  const neckPos = [...rest.subarray(JOINT_NECK * 4, JOINT_NECK * 4 + 3)];
  // Keep upper-body triangles (y >= 1.18) for fast follicle raycasting & strand-vs-skin repulsion.
  const uTris = [];
  const faceNormals = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (pos[a * 3 + 1] < 1.18 && pos[b * 3 + 1] < 1.18 && pos[c * 3 + 1] < 1.18) continue;
    uTris.push(a, b, c);
    const pa = [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]];
    const pb = [pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]];
    const pc = [pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]];
    const fn = norm3(cross3(sub3(pb, pa), sub3(pc, pa)));
    faceNormals.push(fn);
  }
  const upperCorners = Uint32Array.from(uTris);
  const grid = triangleGrid(pos, upperCorners, 0.025);

  let crownY = -9, foreZ = -9, occZ = 9, earY = headPos[1] + 0.055, earZ = headPos[2] - 0.005;
  let noseY = headPos[1] + 0.032, noseZ = -9, lipUpperY = 0, lipZ = -9, chinY = 9;
  for (let v = 0; v < pos.length / 3; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    if (Math.abs(x) < 0.08 && y > headPos[1] && y > crownY) crownY = y;
  }
  for (let v = 0; v < pos.length / 3; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    if (Math.abs(x) < 0.045 && y > crownY - 0.075 && y < crownY - 0.035) {
      if (z > foreZ) foreZ = z;
      if (z < occZ) occZ = z;
    }
    if (Math.abs(x) < 0.015 && y > crownY - 0.175 && y < crownY - 0.145 && z > noseZ) {
      noseZ = z; noseY = y;
    }
    if (Math.abs(x) < 0.020 && y > crownY - 0.192 && y < crownY - 0.176 && z > lipZ) {
      lipZ = z; lipUpperY = y;
    }
    if (Math.abs(x) < 0.025 && y > crownY - 0.255 && y < crownY - 0.215 && z > headPos[2] + 0.05) {
      if (y < chinY) chinY = y;
    }
  }
  const midZ = 0.5 * (foreZ + occZ);
  earY = crownY - 0.128;
  earZ = midZ - 0.018;

  // Outward Möller–Trumbore raycast from an interior anchor, returning the outermost skin intersection.
  function raycast(origin, dir, minT = 0.015, maxT = 0.22) {
    let bestT = -1, bestHit = null, bestN = null;
    for (let t = 0; t < upperCorners.length / 3; t++) {
      const ia = upperCorners[t * 3] * 3, ib = upperCorners[t * 3 + 1] * 3, ic = upperCorners[t * 3 + 2] * 3;
      const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2];
      const e1x = pos[ib] - ax, e1y = pos[ib + 1] - ay, e1z = pos[ib + 2] - az;
      const e2x = pos[ic] - ax, e2y = pos[ic + 1] - ay, e2z = pos[ic + 2] - az;
      const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-9) continue;
      const inv = 1 / det;
      const tx = origin[0] - ax, ty = origin[1] - ay, tz = origin[2] - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const hitT = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (hitT < minT || hitT > maxT || hitT <= bestT) continue;
      const w0 = 1 - u - v;
      const nx = nrm[ia] * w0 + nrm[ib] * u + nrm[ic] * v;
      const ny = nrm[ia + 1] * w0 + nrm[ib + 1] * u + nrm[ic + 1] * v;
      const nz = nrm[ia + 2] * w0 + nrm[ib + 2] * u + nrm[ic + 2] * v;
      const sn = norm3([nx, ny, nz]);
      if (dot3(sn, dir) < -0.15) continue;
      bestT = hitT;
      bestHit = add3(origin, dir, hitT);
      bestN = sn;
    }
    return bestHit ? { point: bestHit, normal: bestN, t: bestT } : null;
  }

  // Pushes free strand nodes outward only if they penetrate inside the fitted body mesh, hugging the real skull contour.
  let maxAbsX = 0.068;
  for (let v = 0; v < pos.length / 3; v++) {
    const y = pos[v * 3 + 1];
    if (y > crownY - 0.11 && y < crownY - 0.03) maxAbsX = Math.max(maxAbsX, Math.abs(pos[v * 3]));
  }
  const coreRx = maxAbsX * 0.78, coreRy = 0.072, coreRz = ((foreZ - occZ) * 0.5) * 0.78;
  function repel(p, clearance = 0.0016) {
    let cur = [...p];
    const sc = [0, crownY - 0.086, midZ];
    const ex = (cur[0] - sc[0]) / coreRx, ey = (cur[1] - sc[1]) / coreRy, ez = (cur[2] - sc[2]) / coreRz;
    const ell = Math.hypot(ex, ey, ez);
    if (ell < 1 && ell > 1e-4 && cur[1] > headPos[1] - 0.01) {
      cur = [sc[0] + (ex / ell) * coreRx, sc[1] + (ey / ell) * coreRy, sc[2] + (ez / ell) * coreRz];
    }
    const tri = grid(cur[0], cur[1], cur[2]);
    if (tri >= 0) {
      const dist = Math.sqrt(closest[0]);
      if (dist < 0.038) {
        const s = closest[1], t = closest[2], w0 = 1 - s - t;
        const ia = upperCorners[tri * 3] * 3, ib = upperCorners[tri * 3 + 1] * 3, ic = upperCorners[tri * 3 + 2] * 3;
        const q = [
          pos[ia] * w0 + pos[ib] * s + pos[ic] * t,
          pos[ia + 1] * w0 + pos[ib + 1] * s + pos[ic + 1] * t,
          pos[ia + 2] * w0 + pos[ib + 2] * s + pos[ic + 2] * t,
        ];
        const vn = norm3([
          nrm[ia] * w0 + nrm[ib] * s + nrm[ic] * t,
          nrm[ia + 1] * w0 + nrm[ib + 1] * s + nrm[ic + 1] * t,
          nrm[ia + 2] * w0 + nrm[ib + 2] * s + nrm[ic + 2] * t,
        ]);
        const signed = dot3(sub3(cur, q), vn);
        if (signed < clearance) cur = add3(q, vn, clearance);
      }
    }
    return cur;
  }

  return { id, headPos, neckPos, crownY, foreZ, occZ, midZ, earY, earZ, noseY, noseZ, lipUpperY, lipZ, chinY, raycast, repel };
}

// Appends one 3D V-arched multi-segment hair strand (grass/rope ribbon with central ridge and tapered sharp tip)
// into the groom's triangle soup and per-vertex stream arrays.
function appendStrand(mesh, points, widths, arches, skinFn, flexMax, phase, tone, seed) {
  const S = points.length - 1;
  if (S < 2) return;
  const tangents = points.map((_, k) => {
    const a = points[Math.max(0, k - 1)], b = points[Math.min(S, k + 1)];
    return norm3(sub3(b, a));
  });
  // Parallel-transport a stable cross-strand frame from the root outward.
  let upRef = Math.abs(tangents[0][1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
  let side = norm3(cross3(tangents[0], upRef));
  const stationIdx = [];

  for (let k = 0; k <= S; k++) {
    const u = k / S;
    const T = tangents[k];
    side = sub3(side, T, dot3(side, T));
    const sl = Math.hypot(...side);
    side = sl > 1e-5 ? side.map((v) => v / sl) : norm3(cross3(T, [0, 0, 1]));
    const N = norm3(cross3(side, T));
    const p = points[k];
    const flex = u === 0 ? 0 : Math.min(1, flexMax * (u ** 1.45));
    const [joints, weights, leadJoint] = skinFn(p, u);
    const along8 = Math.max(0, Math.min(255, Math.round(u * 255)));

    const pushVertex = (pos, nrm, crossV) => {
      const idx = mesh.position.length / 3;
      mesh.position.push(pos[0], pos[1], pos[2]);
      mesh.normal.push(nrm[0], nrm[1], nrm[2]);
      const cross8 = Math.max(0, Math.min(255, Math.round((crossV * 0.5 + 0.5) * 255)));
      mesh.high.push((along8 | (cross8 << 8)) >>> 0);
      mesh.word.push(packTangentToneSeed(T, tone, seed));
      mesh.skin.push(packSkin(joints, weights));
      mesh.wind.push(packWind(flex, phase));
      mesh.part.push(leadJoint);
      return idx;
    };

    if (k === S) {
      const tipIdx = pushVertex(p, N, 0);
      stationIdx.push([tipIdx]);
    } else {
      const w = widths[k], arch = arches[k];
      const pL = add3(add3(p, side, -w), N, -arch * 0.35);
      const pM = add3(p, N, arch * 0.65);
      const pR = add3(add3(p, side, +w), N, -arch * 0.35);
      const nL = norm3(add3(N, side, -0.58));
      const nR = norm3(add3(N, side, +0.58));
      stationIdx.push([
        pushVertex(pL, nL, -1),
        pushVertex(pM, N, 0),
        pushVertex(pR, nR, +1),
      ]);
    }
  }

  for (let k = 0; k < S; k++) {
    const cur = stationIdx[k], nxt = stationIdx[k + 1];
    const triPart = mesh.part[cur[1]];
    if (nxt.length === 1) {
      const tip = nxt[0];
      mesh.index.push(cur[0], cur[1], tip, cur[1], cur[2], tip);
      mesh.triPart.push(triPart, triPart);
    } else {
      mesh.index.push(
        cur[0], cur[1], nxt[1],
        cur[0], nxt[1], nxt[0],
        cur[1], cur[2], nxt[2],
        cur[1], nxt[2], nxt[1],
      );
      mesh.triPart.push(triPart, triPart, triPart, triPart);
    }
  }
}

function createEmptyGroomMesh() {
  return { position: [], normal: [], high: [], word: [], skin: [], wind: [], part: [], index: [], triPart: [] };
}

// Samples scalp follicles evenly across the entire hair-bearing cranium (crown, temples, sides, occiput, and nape).
function sampleScalpFollicles(ref, targetCount, rand, { tonsure = false } = {}) {
  const center = [0, ref.crownY - 0.088, ref.midZ - 0.004];
  const accepted = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  // Sweep ALL `totalRays` evenly from dy = +1.0 (crown apex) to dy = -0.78 (lower nape) so no region is starved!
  const totalRays = Math.round(targetCount * (tonsure ? 3.4 : 1.75));
  for (let i = 0; i < totalRays; i++) {
    const t = (i + 0.5) / totalRays;
    const dy = 1 - t * 1.78 + (rand() - 0.5) * 0.025;
    const rHoriz = Math.sqrt(Math.max(0.0005, 1 - Math.min(0.9995, dy * dy)));
    const phi = i * golden + (rand() - 0.5) * 0.12;
    const dx = Math.sin(phi) * rHoriz;
    const dz = Math.cos(phi) * rHoriz;
    const dir = norm3([dx * 0.90, dy, dz * 1.06]);

    const hit = ref.raycast(center, dir, 0.04, 0.18);
    if (!hit) continue;
    const [hx, hy, hz] = hit.point;
    const ax = Math.abs(hx);

    // Front forehead & temple M-contour: keep forehead, brows, and eyes completely clear.
    if (hz > ref.midZ + 0.012) {
      const widowDip = 0.006 * Math.exp(-((hx / 0.018) ** 2));
      const templeRecede = 0.010 * Math.exp(-(((ax - 0.044) / 0.018) ** 2));
      const hairlineY = (ref.crownY - 0.050) - widowDip + templeRecede;
      const sideburnZone = ax > 0.056 && hz < ref.midZ + 0.046;
      if (!sideburnZone && hy < hairlineY) continue;
      if (sideburnZone && hy < ref.earY - 0.008) continue;
    }
    // Clean arch around the ear pinna so ears are crisp and never skewered at the root.
    const earDy = (hy - ref.earY) / 0.035, earDz = (hz - ref.earZ) / 0.027;
    if (ax > 0.054 && earDy * earDy + earDz * earDz < 1.0) continue;

    // Nape cutoff at the back of the neck.
    const napeLimit = ref.crownY - 0.176 + 0.020 * Math.max(0, (hz - (ref.occZ + 0.02)) * 4);
    if (hy < napeLimit) continue;

    // Tonsure / thinning older mariner: bald/sparse crown dome, dense temple & occipital fringe.
    let sparseWisp = false;
    if (tonsure) {
      const domeR = Math.hypot(hx / 0.056, (hz - (ref.midZ - 0.004)) / 0.068);
      if (hy > ref.crownY - 0.064 && domeR < 1.0) {
        if (rand() > 0.07) continue;
        sparseWisp = true;
      }
    }
    accepted.push({ point: hit.point, normal: hit.normal, sparseWisp });
  }
  return accepted;
}

function scalpSkinFor(ref) {
  return (p, u) => {
    if (u < 0.35 || p[1] > ref.headPos[1] + 0.015) {
      return [[JOINT_HEAD, 0, 0, 0], [1, 0, 0, 0], JOINT_HEAD];
    }
    const drop = Math.min(1, Math.max(0, (ref.headPos[1] + 0.015 - p[1]) / 0.16)) * Math.min(1, (u - 0.35) / 0.65);
    const spineShare = Math.max(0, (drop - 0.45) * 0.85);
    const neckShare = drop * 0.65 - spineShare * 0.4;
    const headShare = Math.max(0.18, 1 - neckShare - spineShare);
    return [[JOINT_HEAD, JOINT_NECK, JOINT_SPINE, 0], [headShare, Math.max(0, neckShare), spineShare, 0], JOINT_HEAD];
  };
}

function buildScalpGroom(ref, style, seed) {
  const rand = mulberry32(seed);
  const mesh = createEmptyGroomMesh();
  const skinFn = scalpSkinFor(ref);
  const tonsure = style === 'tonsure-fringe';
  const countMap = {
    'cropped-curls': 1150,
    'parted-locks': 1080,
    'mariner-queue': 1020,
    'indigenous-long': 1080,
    'tonsure-fringe': 760,
    'parted-waves': 1120,
    'nape-chignon': 980,
    'crown-braids': 980,
    'indigenous-long-f': 1140,
  };
  const follicles = sampleScalpFollicles(ref, countMap[style] ?? 1050, rand, { tonsure });
  const partX = style === 'parted-locks' ? -0.014 : 0.0;
  const gatherPt = [0, ref.crownY - 0.148, ref.occZ - 0.020];
  const bunPt = [0, ref.crownY - 0.116, ref.occZ - 0.030];

  for (let i = 0; i < follicles.length; i++) {
    const { point, normal, sparseWisp } = follicles[i];
    const [rx, ry, rz] = point;
    const sideSign = rx >= partX ? 1 : -1;
    const phase = rand();
    const tone = Math.min(1, Math.max(0, 0.5 + (rand() - 0.5) * 0.68));
    const lockSeed = rand();
    // 72% overlapping shingle base locks (zero bald scalp showing through) + 28% fine outer grass/rope wisps!
    const isFlyaway = sparseWisp || (i % 4 === 0);

    let segs = 6, len = 0.10, baseW = 0.0068, flexMax = 0.55, curlAmp = 0.004, curlFreq = 7.0;
    if (style === 'cropped-curls') {
      segs = 5;
      len = 0.034 + rand() * 0.022;
      baseW = isFlyaway ? 0.0022 : 0.0068 + rand() * 0.0020;
      flexMax = isFlyaway ? 0.38 : 0.20;
      curlAmp = 0.0045;
      curlFreq = 9.5;
    } else if (style === 'tonsure-fringe') {
      segs = 5;
      len = sparseWisp ? 0.026 + rand() * 0.012 : 0.042 + rand() * 0.024;
      baseW = sparseWisp ? 0.0014 : 0.0064 + rand() * 0.0018;
      flexMax = 0.34;
      curlAmp = 0.0032;
      curlFreq = 6.5;
    } else if (style === 'parted-locks') {
      segs = 7;
      const frontFactor = Math.max(0, (rz - ref.midZ) / 0.10);
      len = (0.10 + rand() * 0.06) * (1 - 0.25 * frontFactor);
      baseW = isFlyaway ? 0.0022 : 0.0074 + rand() * 0.0022;
      flexMax = isFlyaway ? 0.78 : 0.58;
      curlAmp = 0.0055;
      curlFreq = 8.2;
    } else if (style === 'mariner-queue') {
      segs = 6;
      len = 0.145 + rand() * 0.035;
      baseW = isFlyaway ? 0.0020 : 0.0072 + rand() * 0.0020;
      flexMax = isFlyaway ? 0.55 : 0.18;
      curlAmp = 0.0016;
      curlFreq = 5.0;
    } else if (style === 'indigenous-long') {
      segs = 8;
      const frontTrim = rz > ref.midZ + 0.038 && Math.abs(rx) < 0.045;
      len = frontTrim ? 0.052 + rand() * 0.018 : 0.21 + rand() * 0.075;
      baseW = isFlyaway ? 0.0022 : 0.0076 + rand() * 0.0022;
      flexMax = frontTrim ? 0.42 : 0.88;
      curlAmp = 0.0018;
      curlFreq = 4.2;
    } else if (style === 'parted-waves') {
      segs = 8;
      const frontTendril = rz > ref.midZ + 0.025 && Math.abs(rx) > 0.022;
      len = frontTendril ? 0.14 + rand() * 0.05 : 0.23 + rand() * 0.09;
      baseW = isFlyaway ? 0.0022 : 0.0078 + rand() * 0.0024;
      flexMax = 0.90;
      curlAmp = 0.0072;
      curlFreq = 9.5;
    } else if (style === 'nape-chignon' || style === 'crown-braids') {
      segs = 6;
      len = 0.135 + rand() * 0.035;
      baseW = isFlyaway ? 0.0018 : 0.0072 + rand() * 0.0020;
      flexMax = isFlyaway ? 0.58 : 0.20;
      curlAmp = 0.0022;
      curlFreq = 6.0;
    } else if (style === 'indigenous-long-f') {
      segs = 8;
      const templeLock = rz > ref.midZ + 0.022 && Math.abs(rx) > 0.020;
      len = templeLock ? 0.18 + rand() * 0.05 : 0.27 + rand() * 0.09;
      baseW = isFlyaway ? 0.0022 : 0.0078 + rand() * 0.0024;
      flexMax = 0.94;
      curlAmp = 0.0022;
      curlFreq = 4.6;
    }

    // Start root 1.8mm proud of the stand-in skull so locks never dip inside the 1.98M-tri full-detail scalp ridges!
    const root = add3(point, normal, 0.0016);
    const pts = [root], widths = [baseW * 1.12], arches = [baseW * 0.30];
    let cur = add3(point, normal, 0.0028);
    // Smooth part-line emergence: near partX, strands crest slightly UP & BACK before parting sideways so the crown part has zero bald gap!
    const distFromPart = Math.abs(rx - partX);
    const partSpread = Math.min(1, distFromPart / 0.028);
    let sweepSide = [sideSign * (0.16 + 0.52 * partSpread), 0.14 * (1 - partSpread) - 0.06, -0.48];
    if (style === 'cropped-curls') {
      const swirlAngle = Math.atan2(rx, rz - (ref.midZ - 0.035)) + 0.65;
      sweepSide = [Math.sin(swirlAngle) * 0.58, 0.05 - 0.28 * partSpread, Math.min(-0.12, Math.cos(swirlAngle) * 0.55 - 0.20)];
    } else if (style === 'indigenous-long' && rz > ref.midZ + 0.038 && Math.abs(rx) < 0.045) {
      sweepSide = [sideSign * (0.25 + 0.50 * partSpread), -0.45, -0.08];
    }
    let dir = norm3(add3(normal, sweepSide, isFlyaway ? 0.85 : 1.05));

    // Non-uniform station spacing: short 6mm–12mm root-crest steps over the curved skull, lengthening along the free hang!
    let prevU = 0;
    for (let k = 1; k <= segs; k++) {
      const lin = k / segs;
      const u = 0.35 * lin + 0.65 * (lin * lin);
      const ds = len * (u - prevU);
      prevU = u;
      if (style === 'mariner-queue' && !isFlyaway) {
        const toTie = sub3(gatherPt, cur);
        const dist = Math.hypot(...toTie);
        if (dist > 0.012) dir = norm3(add3(dir, norm3(toTie), 0.76 * u + 0.28));
        else { cur = add3(gatherPt, [(rand() - 0.5) * 0.008, -u * 0.012, -0.006]); }
      } else if ((style === 'nape-chignon' || style === 'crown-braids') && !isFlyaway) {
        const target = style === 'nape-chignon' ? bunPt : [sideSign * 0.056 * (1 - u * 0.65), ref.crownY - 0.075 - u * 0.055, ref.occZ - 0.014];
        const toTarget = sub3(target, cur);
        if (Math.hypot(...toTarget) > 0.012) dir = norm3(add3(dir, norm3(toTarget), 0.72 * u + 0.26));
      } else {
        // Natural gravity drape: gentle root lift near u=0, then strong vertical hang along head & shoulders (never a 45° mane!).
        const grav = style === 'cropped-curls' ? 0.65 : 1.55;
        const horizDamp = Math.max(0.28, 1 - u * 0.68);
        dir = norm3([
          dir[0] * horizDamp + sideSign * 0.06 * (1 - u),
          dir[1] - grav * (0.28 + 1.15 * u),
          dir[2] * horizDamp - (rz > ref.midZ + 0.02 ? 0.14 * (1 - u) : 0.03),
        ]);
      }
      const waveA = Math.sin(u * curlFreq + phase * 6.283) * curlAmp * Math.min(1, u * 2.2);
      const waveB = Math.cos(u * curlFreq * 0.85 + phase * 6.283) * curlAmp * 0.55 * Math.min(1, u * 2.2);
      const sideVec = norm3(cross3(dir, [0, 1, 0.1]));
      const outVec = norm3(cross3(sideVec, dir));
      let next = add3(cur, dir, ds);
      next = add3(add3(next, sideVec, waveA), outVec, waveB);
      const hugClearance = isFlyaway ? (0.0034 + u * 0.0022) : (0.0026 + u * 0.0012);
      next = ref.repel(next, hugClearance);
      dir = norm3(sub3(next, cur));
      cur = next;
      pts.push(cur);
      const taper = Math.max(0.16, 1 - (u ** 1.45) * 0.84);
      widths.push(baseW * taper);
      arches.push(baseW * taper * 0.30);
    }
    appendStrand(mesh, pts, widths, arches, skinFn, flexMax, phase, tone, lockSeed);
  }

  // Dense crown-part & hairline root-cover locks along the midline so the part line is a natural 1mm seam, never a wide bald strip!
  if (!tonsure) {
    const centerAnchor = [0, ref.crownY - 0.088, ref.midZ - 0.004];
    for (let p = 0; p < 95; p++) {
      const zFrac = p / 94;
      const zTarget = (ref.foreZ - 0.018) * (1 - zFrac) + (ref.occZ + 0.015) * zFrac;
      const xOff = partX + ((p % 2 === 0 ? 1 : -1) * (0.002 + rand() * 0.012));
      const rayDir = norm3([xOff, 0.11, zTarget - centerAnchor[2]]);
      const hit = ref.raycast(centerAnchor, rayDir, 0.04, 0.18);
      if (!hit || hit.point[1] < ref.crownY - 0.052) continue;
      const sgn = (p % 2 === 0) ? 1 : -1;
      const segs = 5, pLen = style === 'cropped-curls' ? 0.035 : 0.075, bW = 0.0082;
      const pts = [add3(hit.point, hit.normal, 0.0020)];
      const widths = [bW * 1.15], arches = [bW * 0.28];
      let cur = add3(hit.point, hit.normal, 0.0032);
      let dir = norm3([sgn * 0.42, 0.10, -0.58]);
      for (let k = 1; k <= segs; k++) {
        const u = k / segs;
        dir = norm3([dir[0] * 0.82 + sgn * 0.12, dir[1] - 0.55 * u, dir[2] * 0.82 - 0.08]);
        const next = ref.repel(add3(cur, dir, pLen / segs), 0.0028);
        dir = norm3(sub3(next, cur));
        cur = next;
        pts.push(cur);
        const w = bW * Math.max(0.20, 1 - u * 0.78);
        widths.push(w); arches.push(w * 0.28);
      }
      appendStrand(mesh, pts, widths, arches, skinFn, 0.28, rand(), 0.35 + rand() * 0.45, rand());
    }
  }

  // Secondary structural feature strands: wind-whipped queue tail, coiled chignon bun, or woven Renaissance crown plaits!
  if (style === 'mariner-queue') {
    for (let q = 0; q < 96; q++) {
      const a = (q / 96) * Math.PI * 2 + rand() * 0.2, r = Math.sqrt(rand()) * 0.012;
      const start = [gatherPt[0] + Math.cos(a) * r, gatherPt[1] + Math.sin(a) * r * 0.7, gatherPt[2] - 0.004];
      const segs = 7, tailLen = 0.155 + rand() * 0.055;
      const pts = [start], widths = [0.0028], arches = [0.0011];
      let cur = [...start], dir = norm3([(rand() - 0.5) * 0.12, -0.86, -0.48]);
      const phase = rand();
      for (let k = 1; k <= segs; k++) {
        const u = k / segs;
        const twist = u * 4.5 + a;
        const flare = u > 0.35 ? (u - 0.35) * 0.018 : 0;
        let next = add3(cur, dir, tailLen / segs);
        next[0] += Math.cos(twist) * (0.002 + flare * 0.35);
        next[2] += Math.sin(twist) * 0.002 - flare * 0.25;
        next = ref.repel(next, 0.003);
        dir = norm3([dir[0] * 0.9, dir[1] - 0.12, dir[2] * 0.88]);
        cur = next;
        pts.push(cur);
        const w = (0.0030 + flare * 0.12) * Math.max(0.15, 1 - (u ** 1.4) * 0.82);
        widths.push(w); arches.push(w * 0.4);
      }
      appendStrand(mesh, pts, widths, arches, skinFn, 0.96, phase, 0.35 + rand() * 0.45, rand());
    }
  } else if (style === 'nape-chignon') {
    for (let b = 0; b < 135; b++) {
      const t0 = (b / 135) * Math.PI * 2, ringR = 0.016 + (b % 3) * 0.009 + rand() * 0.005;
      const segs = 6, arcSpan = 1.9 + rand() * 0.6;
      const pts = [], widths = [], arches = [];
      for (let k = 0; k <= segs; k++) {
        const u = k / segs, ang = t0 + u * arcSpan;
        const braidWave = Math.sin(u * 9.4 + b) * 0.0035;
        const p = ref.repel([
          bunPt[0] + Math.cos(ang) * (ringR + braidWave),
          bunPt[1] + Math.sin(ang) * (ringR * 0.86 + braidWave),
          bunPt[2] - 0.010 - Math.sin(u * Math.PI) * (0.016 + (2 - (b % 3)) * 0.005),
        ], 0.0025);
        pts.push(p);
        const w = 0.0038 * Math.sin(Math.max(0.18, u * Math.PI * 0.92));
        widths.push(Math.max(0.0012, w)); arches.push(Math.max(0.0006, w * 0.42));
      }
      appendStrand(mesh, pts, widths, arches, skinFn, 0.16, rand(), 0.35 + rand() * 0.5, rand());
    }
  } else if (style === 'crown-braids') {
    for (const side of [-1, 1]) {
      for (let b = 0; b < 78; b++) {
        const lobe = b % 3, offset = (rand() - 0.5) * 0.006;
        const segs = 8, pts = [], widths = [], arches = [];
        for (let k = 0; k <= segs; k++) {
          const u = k / segs;
          // Sweep from upper temple around the side of the crown to an interlaced occipital coronet.
          const theta = (0.28 + u * 2.45) * side;
          const baseY = ref.crownY - 0.032 - u * 0.072 + Math.cos(u * 18.8 + lobe * 2.09) * 0.0055;
          const radX = 0.076 + Math.sin(u * 18.8 + lobe * 2.09) * 0.0045 + offset;
          const radZ = 0.096 + Math.sin(u * 18.8 + lobe * 2.09) * 0.0045;
          const raw = [Math.sin(theta) * radX, baseY, ref.midZ + Math.cos(theta) * radZ * 0.92];
          const pushed = ref.repel(raw, 0.0055);
          pts.push(pushed);
          const w = 0.0036 * Math.max(0.22, 1 - Math.abs(u - 0.5) * 0.55);
          widths.push(w); arches.push(w * 0.42);
        }
        appendStrand(mesh, pts, widths, arches, skinFn, 0.20, rand(), 0.35 + rand() * 0.5, rand());
      }
    }
  }
  return mesh;
}

function buildBeardGroom(ref, style, seed) {
  const rand = mulberry32(seed);
  const mesh = createEmptyGroomMesh();
  const oralOrigin = [0, ref.lipUpperY - 0.010, ref.midZ + 0.030];

  const moustacheSkin = () => [[JOINT_HEAD, JOINT_UPPER_LIP, 0, 0], [0.68, 0.32, 0, 0], JOINT_HEAD];
  const beardSkin = (p, u) => {
    const neckShare = style === 'sea-beard' && u > 0.55 ? Math.min(0.32, (u - 0.55) * 0.65) : 0;
    return [[JOINT_JAW, JOINT_HEAD, JOINT_NECK, 0], [0.72 - neckShare * 0.5, 0.28 - neckShare * 0.5, neckShare, 0], JOINT_JAW];
  };

  // 1. Moustache locks (shared across moustache, iberian-barba, and sea-beard)
  const mCount = style === 'moustache' ? 210 : 175;
  for (let i = 0; i < mCount; i++) {
    const uX = ((i + 0.5) / mCount) * 2 - 1 + (rand() - 0.5) * 0.08;
    const x = uX * 0.029;
    // Keep philtrum notch slightly softer and strictly above mouth opening & below nostrils.
    const y = ref.lipUpperY + 0.001 + (rand() - 0.35) * 0.0075 - (Math.abs(x) / 0.029) * 0.0045;
    const dirRay = norm3([x, y - oralOrigin[1], ref.lipZ + 0.03 - oralOrigin[2]]);
    const hit = ref.raycast(oralOrigin, dirRay, 0.02, 0.16);
    if (!hit) continue;
    const sgn = x >= 0 ? 1 : -1;
    const segs = 5;
    const len = (style === 'sea-beard' ? 0.024 : 0.018) + Math.abs(uX) * 0.014 + rand() * 0.007;
    const baseW = 0.0019 + rand() * 0.0007;
    const root = add3(hit.point, hit.normal, -0.0016);
    const pts = [root], widths = [baseW * 0.85], arches = [baseW * 0.38];
    let cur = [...hit.point];
    let dir = norm3([sgn * (0.28 + Math.abs(uX) * 0.62), -0.68, 0.38]);
    for (let k = 1; k <= segs; k++) {
      const u = k / segs;
      dir = norm3([dir[0] + sgn * 0.18 * u, dir[1] - 0.22 + (style === 'iberian-barba' && u > 0.6 ? 0.18 : 0), dir[2] - 0.12]);
      let next = add3(cur, dir, len / segs);
      next = ref.repel(next, 0.0018);
      cur = next;
      pts.push(cur);
      const w = baseW * Math.max(0.14, 1 - (u ** 1.35) * 0.86);
      widths.push(w); arches.push(w * 0.4);
    }
    appendStrand(mesh, pts, widths, arches, moustacheSkin, style === 'sea-beard' ? 0.35 : 0.20, rand(), 0.35 + rand() * 0.55, rand());
  }

  if (style === 'moustache') return mesh;

  // 2. Chin, soul-patch, and jawline/cheek beard strands
  const bCount = style === 'sea-beard' ? 370 : 280;
  const jawOrigin = [0, ref.chinY + 0.032, ref.midZ + 0.018];
  for (let i = 0; i < bCount; i++) {
    const uA = ((i + 0.5) / bCount) * 2 - 1 + (rand() - 0.5) * 0.06;
    const maxAngle = style === 'sea-beard' ? 1.28 : 0.98;
    const theta = uA * maxAngle;
    const absT = Math.abs(theta);
    const cheekH = style === 'sea-beard' ? 0.046 : 0.028;
    const yTarget = ref.chinY + 0.004 + rand() * (0.026 + absT * cheekH);
    // Keep lower lip vermilion & mouth slit clean!
    if (Math.abs(theta) < 0.36 && yTarget > ref.lipUpperY - 0.020) {
      if (Math.abs(theta) > 0.14 || yTarget > ref.lipUpperY - 0.014) continue;
    }
    const dirRay = norm3([Math.sin(theta) * 0.92, (yTarget - jawOrigin[1]) * 1.1 - 0.12, Math.cos(theta) * 0.95]);
    const hit = ref.raycast(jawOrigin, dirRay, 0.02, 0.17);
    if (!hit) continue;
    if (hit.point[1] > ref.earY + 0.008) continue;

    const phase = rand();
    const isChinCenter = absT < 0.42;
    const segs = style === 'sea-beard' ? 7 : 6;
    const len = style === 'sea-beard'
      ? (isChinCenter ? 0.105 + rand() * 0.055 : 0.065 + rand() * 0.045)
      : (isChinCenter ? 0.048 + rand() * 0.024 : 0.024 + rand() * 0.016);
    const baseW = (style === 'sea-beard' ? 0.0033 : 0.0026) + rand() * 0.0010;
    const root = add3(hit.point, hit.normal, -0.0018);
    const pts = [root], widths = [baseW * 0.88], arches = [baseW * 0.38];
    let cur = [...hit.point];
    let dir = norm3(add3(hit.normal, [0, -0.88, 0.20], 1.1));
    for (let k = 1; k <= segs; k++) {
      const u = k / segs;
      // Iberian barba tapers gently inward toward a classic 1550 pointed chin silhouette; sea-beard billows full and wavy.
      const pointPull = style === 'iberian-barba' ? -cur[0] * 2.2 * u : -cur[0] * 0.35 * u;
      const waveX = Math.sin(u * 8.5 + phase * 6.283) * (style === 'sea-beard' ? 0.0042 : 0.0018) * u;
      const waveZ = Math.cos(u * 7.2 + phase * 6.283) * (style === 'sea-beard' ? 0.0035 : 0.0014) * u;
      dir = norm3([dir[0] * 0.78 + pointPull, dir[1] - 0.45, dir[2] * 0.75 + 0.06]);
      let next = add3(cur, dir, len / segs);
      next[0] += waveX; next[2] += waveZ;
      next = ref.repel(next, 0.0022);
      cur = next;
      pts.push(cur);
      const w = baseW * Math.max(0.14, 1 - (u ** 1.35) * 0.86);
      widths.push(w); arches.push(w * 0.4);
    }
    appendStrand(mesh, pts, widths, arches, beardSkin, style === 'sea-beard' ? 0.78 : 0.40, phase, 0.30 + rand() * 0.60, rand());
  }
  return mesh;
}

function buildFarWrapInput(mesh) {
  const T = mesh.index.length / 3;
  const vertices = new Float32Array(T * 24);
  const parts = Uint32Array.from(mesh.triPart);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.index[t * 3 + k], at = (t * 3 + k) * 8;
      vertices[at] = mesh.position[v * 3];
      vertices[at + 1] = mesh.position[v * 3 + 1];
      vertices[at + 2] = mesh.position[v * 3 + 2];
      vertices[at + 3] = mesh.normal[v * 3];
      vertices[at + 4] = mesh.normal[v * 3 + 1];
      vertices[at + 5] = mesh.normal[v * 3 + 2];
      vertices[at + 6] = (mesh.high[v] & 255) / 255;
      vertices[at + 7] = 0;
    }
  }
  return { name: 'hair far wrap', vertices, triangles: T, parts };
}

await MeshoptSimplifier.ready;
const started = Date.now();
const maleRef = loadReferenceHead('sailor-male');
const femaleRef = loadReferenceHead('villager-female');

const packedBodies = [];
const typeSummaries = [];

for (const spec of HAIR_CONTINUUM_TYPES) {
  const t0 = Date.now();
  const ref = spec.sex === 'female' ? femaleRef : maleRef;
  const mesh = spec.slot === 'beard'
    ? buildBeardGroom(ref, spec.id, 15500 + spec.index * 977)
    : buildScalpGroom(ref, spec.id, 15500 + spec.index * 977);

  const count = mesh.position.length / 3;
  const position = Float32Array.from(mesh.position);
  const normal = Float32Array.from(mesh.normal);
  const index = Uint32Array.from(mesh.index);
  const part = Uint32Array.from(mesh.part);
  // Kind holds 2 floats per vertex for cluster attribute simplification (along & lockTone).
  const kind = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    kind[v * 2] = (mesh.high[v] & 255) / 255;
    kind[v * 2 + 1] = ((mesh.word[v] >>> 16) & 255) / 255;
  }

  const welded = { position, normal, kind, part, index, count, corner: null };
  const baked = await bakeContinuumBody({ name: spec.id, welded, far: buildFarWrapInput(mesh) });
  const { clusters, far: farBody } = baked;

  // Inflate the far-body hair shell outward along its normals so coarse far/mid steps sit cleanly outside the curved
  // skull instead of cutting chords inside the 1.98M-triangle head mesh at 8–120 m.
  const farInflate = spec.slot === 'beard' ? 0.005 : 0.011;
  const V = farBody.position.length / 3;
  for (let i = 0; i < V; i++) {
    farBody.position[i * 3] += farBody.normal[i * 3] * farInflate;
    farBody.position[i * 3 + 1] += farBody.normal[i * 3 + 1] * farInflate;
    farBody.position[i * 3 + 2] += farBody.normal[i * 3 + 2] * farInflate;
  }

  // Hand off from individual thin strand clusters to the closed solid far hair shell right as strand ribbons reach
  // ~8 mm error (before thin strands collapse to sparse 30-tri slivers), using the full base shell (farFirst = 0)
  // and strictly rising up to ~0.16 m across the collapse chain.
  farBody.farFirst = 0;
  const stepN = farBody.steps.length / 4;
  if (stepN > 0) {
    const stepFloats = new Float32Array(farBody.steps.buffer, farBody.steps.byteOffset, farBody.steps.length);
    const eLo = spec.slot === 'beard' ? 0.007 : 0.008;
    const eHi = Math.max(0.16, stepFloats[(stepN - 1) * 4 + 1]);
    const origLo = stepFloats[1];
    const origSpan = Math.max(stepFloats[(stepN - 1) * 4 + 1] - origLo, 1e-6);
    for (let s = 0; s < stepN; s++) {
      const u = stepN > 1 ? Math.max(s / (stepN - 1), (stepFloats[s * 4 + 1] - origLo) / origSpan) : 0;
      let nextErr = eLo + (eHi - eLo) * (u * u);
      if (s > 0) nextErr = Math.max(nextErr, stepFloats[(s - 1) * 4 + 1] * (1 + 4e-6) + 1e-7);
      stepFloats[s * 4 + 1] = nextErr;
    }
  }

  // Assign skin and wind to far-body vertices from the nearest strand vertex.
  const toStrand = triangleGrid(position, index, 0.02);
  const farSkin = new Array(V), farWind = new Uint32Array(V);
  for (let i = 0; i < V; i++) {
    const t = toStrand(farBody.position[i * 3], farBody.position[i * 3 + 1], farBody.position[i * 3 + 2]);
    const w = [1 - closest[1] - closest[2], closest[1], closest[2]];
    const nearV = t >= 0 ? index[t * 3 + w.indexOf(Math.max(...w))] : 0;
    farSkin[i] = mesh.skin[nearV];
    farWind[i] = mesh.wind[nearV];
  }

  const neutralFarWord = packTangentToneSeed([0, -1, 0], 0.5, 0.5);
  const body = packContinuumBody({
    triangles: index.length / 3,
    vertex: (v) => ({ high: mesh.high[v], word: mesh.word[v] }),
    farWord: () => neutralFarWord,
    streams: {
      skin: (v) => mesh.skin[v],
      wind: (v) => [mesh.wind[v]],
    },
    farStreams: {
      skin: (i) => farSkin[i],
      wind: (i) => [farWind[i]],
    },
  }, baked);

  packedBodies.push(body.words);
  typeSummaries.push({
    index: spec.index,
    id: spec.id,
    sex: spec.sex,
    slot: spec.slot,
    vertices: count,
    triangles: index.length / 3,
    clusters: {
      count: clusters.count,
      levels: clusters.levels,
      roots: clusters.roots,
      finestTriangles: clusters.finestTriangles,
      rootError: +clusters.rootError.toFixed(4),
    },
    chain: farBody.stats,
    splat: {
      centre: farBody.splat.centre.map((v) => +v.toFixed(4)),
      rx: +farBody.splat.rx.toFixed(4),
      ry: +farBody.splat.ry.toFixed(4),
    },
  });
  console.log(`  [${spec.index}] ${spec.id.padEnd(18)} ${String(index.length / 3).padStart(6)} tris · ${String(clusters.count).padStart(3)} clusters (${clusters.levels} lv) · far ${farBody.stats.baseTriangles}→${farBody.stats.coreTriangles} in ${farBody.stats.steps} steps · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const atlas = checkContinuumAtlas(assembleContinuumAtlas(packedBodies), 'hair continuum');
const rawBytes = Buffer.from(atlas.buffer, atlas.byteOffset, atlas.byteLength);
const gzBytes = zlib.gzipSync(rawBytes, { level: 9 });
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'atlas.bin.gz'), gzBytes);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const manifest = {
  format: HAIR_CONTINUUM_FORMAT,
  version: HAIR_CONTINUUM_VERSION,
  generator: 'scripts/prepare-hair-continuum.mjs',
  atlas: {
    words: atlas.length,
    headerWords: CONTINUUM_HEADER_WORDS,
    bytes: rawBytes.length,
    sha256: sha(rawBytes),
    gzip: { file: 'atlas.bin.gz', bytes: gzBytes.length, sha256: sha(gzBytes) },
  },
  types: typeSummaries,
};
validateHairContinuumManifest(manifest);
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`hair continuum baked: ${HAIR_CONTINUUM_TYPES.length} grooms, ${(rawBytes.length / 1048576).toFixed(2)} MiB raw (${(gzBytes.length / 1048576).toFixed(2)} MiB gz) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
