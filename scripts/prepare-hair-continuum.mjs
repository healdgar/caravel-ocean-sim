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
  let noseY = headPos[1] + 0.032, noseZ = -9, lipUpperY = 0, lipZ = -9, chinY = 9, chinFrontY = 0, chinZ = -9;
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
    // Philtrum / cutaneous upper lip sits strictly below the nostrils (crownY - 0.168) and above the mouth slit (crownY - 0.184).
    if (Math.abs(x) < 0.018 && y > crownY - 0.178 && y < crownY - 0.168 && z > lipZ) {
      lipZ = z; lipUpperY = y;
    }
    // Chin prominence (pogonion): max forward Z in the chin band below the lower lip.
    if (Math.abs(x) < 0.020 && y > crownY - 0.236 && y < crownY - 0.208 && z > chinZ) {
      chinZ = z; chinFrontY = y;
    }
    if (Math.abs(x) < 0.025 && y > crownY - 0.245 && y < crownY - 0.215 && z > headPos[2] + 0.05) {
      if (y < chinY) chinY = y;
    }
  }
  const mouthY = lipUpperY - 0.0105;
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

  return { id, headPos, neckPos, crownY, foreZ, occZ, midZ, earY, earZ, noseY, noseZ, lipUpperY, lipZ, mouthY, chinY, chinFrontY, chinZ, raycast, repel };
}

// Appends one 3D V-arched multi-segment hair strand (grass/rope ribbon with central ridge and tapered sharp tip)
// into the groom's triangle soup and per-vertex stream arrays. `rootNormal` aligns the ribbon's flat face tangent
// to the skull surface so shingled locks cover the scalp instead of standing edge-on like fins.
function appendStrand(mesh, points, widths, arches, skinFn, flexMax, phase, tone, seed, rootNormal = null) {
  const S = points.length - 1;
  if (S < 2) return;
  const tangents = points.map((_, k) => {
    const a = points[Math.max(0, k - 1)], b = points[Math.min(S, k + 1)];
    return norm3(sub3(b, a));
  });
  // Align initial cross-strand axis tangent to the scalp surface (cross(rootNormal, T0)), then parallel-transport.
  let side;
  if (rootNormal) {
    const s0 = cross3(rootNormal, tangents[0]);
    if (Math.hypot(...s0) > 1e-4) {
      side = norm3(s0);
    }
  }
  if (!side) {
    const upRef = Math.abs(tangents[0][1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    side = norm3(cross3(tangents[0], upRef));
  }
  const stationIdx = [];

  for (let k = 0; k <= S; k++) {
    const u = k / S;
    const T = tangents[k];
    side = sub3(side, T, dot3(side, T));
    const sl = Math.hypot(...side);
    side = sl > 1e-5 ? side.map((v) => v / sl) : norm3(cross3(T, [0, 0, 1]));
    let N = norm3(cross3(side, T));
    if (k === 0 && rootNormal && dot3(N, rootNormal) < 0) {
      side = side.map((v) => -v);
      N = N.map((v) => -v);
    }
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

    // Front forehead & temple M-contour: keep forehead, brows, and eyes completely clear while sealing temples/sideburns.
    if (hz > ref.midZ + 0.012) {
      const widowDip = 0.006 * Math.exp(-((hx / 0.018) ** 2));
      const templeRecede = 0.005 * Math.exp(-(((ax - 0.044) / 0.018) ** 2));
      const hairlineY = (ref.crownY - 0.050) - widowDip + templeRecede;
      const sideburnZone = ax > 0.052 && hz < ref.midZ + 0.048;
      if (!sideburnZone && hy < hairlineY) continue;
      if (sideburnZone && hy < ref.earY - 0.010) continue;
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
    'cropped-curls': 1480,
    'parted-locks': 1420,
    'mariner-queue': 1340,
    'indigenous-long': 1400,
    'tonsure-fringe': 960,
    'parted-waves': 1460,
    'nape-chignon': 1320,
    'crown-braids': 1320,
    'indigenous-long-f': 1480,
  };
  const follicles = sampleScalpFollicles(ref, countMap[style] ?? 1380, rand, { tonsure });
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
    // 3-tier volumetric hair architecture:
    //   layer 0 (45%): broad shingled under-coat hugging the skull (seals all scalp gaps)
    //   layer 1 (35%): fluffy lofted mid-body locks with fuller arch & wave volume
    //   layer 2 (20%): fine outer wind-reactive flyaway fibers
    const tier = sparseWisp ? 2 : (i % 5 === 0 ? 2 : (i % 5 <= 2 ? 0 : 1));
    const isFlyaway = tier === 2;
    const isUnderCoat = tier === 0;

    let segs = 6, len = 0.10, baseW = 0.0095, flexMax = 0.55, curlAmp = 0.0045, curlFreq = 7.0;
    if (style === 'cropped-curls') {
      segs = 5;
      len = (0.042 + rand() * 0.024) * (isUnderCoat ? 0.92 : 1.08);
      baseW = isFlyaway ? 0.0032 : (isUnderCoat ? 0.0112 : 0.0086) + rand() * 0.0024;
      flexMax = isFlyaway ? 0.42 : 0.22;
      curlAmp = isUnderCoat ? 0.0040 : 0.0068;
      curlFreq = 10.5;
    } else if (style === 'tonsure-fringe') {
      segs = 5;
      len = sparseWisp ? 0.028 + rand() * 0.012 : 0.048 + rand() * 0.024;
      baseW = sparseWisp ? 0.0018 : (isUnderCoat ? 0.0102 : 0.0078) + rand() * 0.0022;
      flexMax = 0.34;
      curlAmp = 0.0042;
      curlFreq = 7.0;
    } else if (style === 'parted-locks') {
      segs = 7;
      const frontFactor = Math.max(0, (rz - ref.midZ) / 0.10);
      len = (0.11 + rand() * 0.06) * (1 - 0.22 * frontFactor);
      baseW = isFlyaway ? 0.0032 : (isUnderCoat ? 0.0118 : 0.0090) + rand() * 0.0026;
      flexMax = isFlyaway ? 0.80 : (isUnderCoat ? 0.44 : 0.62);
      curlAmp = isUnderCoat ? 0.0045 : 0.0072;
      curlFreq = 8.4;
    } else if (style === 'mariner-queue') {
      segs = 6;
      len = 0.148 + rand() * 0.035;
      baseW = isFlyaway ? 0.0028 : (isUnderCoat ? 0.0115 : 0.0088) + rand() * 0.0022;
      flexMax = isFlyaway ? 0.58 : 0.18;
      curlAmp = 0.0024;
      curlFreq = 5.2;
    } else if (style === 'indigenous-long') {
      segs = 8;
      const frontTrim = rz > ref.midZ + 0.038 && Math.abs(rx) < 0.045;
      len = frontTrim ? 0.056 + rand() * 0.018 : 0.22 + rand() * 0.075;
      baseW = isFlyaway ? 0.0032 : (isUnderCoat ? 0.0120 : 0.0092) + rand() * 0.0024;
      flexMax = frontTrim ? 0.44 : (isUnderCoat ? 0.70 : 0.90);
      curlAmp = 0.0026;
      curlFreq = 4.4;
    } else if (style === 'parted-waves') {
      segs = 8;
      const frontTendril = rz > ref.midZ + 0.025 && Math.abs(rx) > 0.022;
      len = frontTendril ? 0.15 + rand() * 0.05 : 0.24 + rand() * 0.09;
      baseW = isFlyaway ? 0.0032 : (isUnderCoat ? 0.0124 : 0.0094) + rand() * 0.0026;
      flexMax = isUnderCoat ? 0.72 : 0.92;
      curlAmp = isUnderCoat ? 0.0055 : 0.0092;
      curlFreq = 9.5;
    } else if (style === 'nape-chignon' || style === 'crown-braids') {
      segs = 6;
      len = 0.140 + rand() * 0.035;
      baseW = isFlyaway ? 0.0026 : (isUnderCoat ? 0.0116 : 0.0088) + rand() * 0.0024;
      flexMax = isFlyaway ? 0.60 : 0.22;
      curlAmp = 0.0030;
      curlFreq = 6.2;
    } else if (style === 'indigenous-long-f') {
      segs = 8;
      const templeLock = rz > ref.midZ + 0.022 && Math.abs(rx) > 0.020;
      len = templeLock ? 0.19 + rand() * 0.05 : 0.28 + rand() * 0.09;
      baseW = isFlyaway ? 0.0032 : (isUnderCoat ? 0.0124 : 0.0094) + rand() * 0.0026;
      flexMax = isUnderCoat ? 0.75 : 0.95;
      curlAmp = 0.0032;
      curlFreq = 4.8;
    }

    // Slimmer, naturally tapered lock ribbons tucked tightly into the scalp root so strands never look like floating tabs.
    baseW *= 0.76;
    const rootLift = isUnderCoat ? -0.0008 : (tier === 1 ? 0.0014 : 0.0024);
    const root = add3(point, normal, rootLift);
    const archRatio = isUnderCoat ? 0.28 : (tier === 1 ? 0.44 : 0.36);
    const pts = [root], widths = [baseW * 0.88], arches = [baseW * archRatio];
    let cur = add3(point, normal, rootLift + (isUnderCoat ? 0.0016 : 0.0032));
    // Smooth part-line emergence: near partX, strands crest slightly UP & BACK before parting sideways so the crown part has zero bald gap!
    const distFromPart = Math.abs(rx - partX);
    const partSpread = Math.min(1, distFromPart / 0.028);
    let sweepSide = [sideSign * (0.14 + 0.50 * partSpread), (isUnderCoat ? 0.12 : 0.26) * (1 - partSpread) - 0.04, -0.46];
    if (style === 'cropped-curls') {
      const swirlAngle = Math.atan2(rx, rz - (ref.midZ - 0.035)) + 0.65;
      sweepSide = [Math.sin(swirlAngle) * 0.58, 0.12 - 0.24 * partSpread, Math.min(-0.12, Math.cos(swirlAngle) * 0.55 - 0.18)];
    } else if (style === 'indigenous-long' && rz > ref.midZ + 0.038 && Math.abs(rx) < 0.045) {
      sweepSide = [sideSign * (0.25 + 0.50 * partSpread), -0.42, -0.06];
    }
    let dir = norm3(add3(normal, sweepSide, isUnderCoat ? 1.15 : (tier === 1 ? 0.92 : 0.80)));

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
        // Natural gravity drape: lofted root crown near u=0, then soft vertical hang along head & shoulders.
        const grav = style === 'cropped-curls' ? 0.58 : 1.48;
        const horizDamp = Math.max(0.30, 1 - u * 0.66);
        dir = norm3([
          dir[0] * horizDamp + sideSign * (tier === 1 ? 0.09 : 0.06) * (1 - u),
          dir[1] - grav * (0.24 + 1.12 * u),
          dir[2] * horizDamp - (rz > ref.midZ + 0.02 ? 0.14 * (1 - u) : 0.03),
        ]);
      }
      const waveA = Math.sin(u * curlFreq + phase * 6.283) * curlAmp * Math.min(1, u * 2.2);
      const waveB = Math.cos(u * curlFreq * 0.85 + phase * 6.283) * curlAmp * 0.65 * Math.min(1, u * 2.2);
      const sideVec = norm3(cross3(dir, [0, 1, 0.1]));
      const outVec = norm3(cross3(sideVec, dir));
      let next = add3(cur, dir, ds);
      next = add3(add3(next, sideVec, waveA), outVec, waveB);
      const hugClearance = isUnderCoat ? (0.0024 + u * 0.0014) : (tier === 1 ? (0.0058 + u * 0.0042) : (0.0076 + u * 0.0050));
      next = ref.repel(next, hugClearance);
      dir = norm3(sub3(next, cur));
      cur = next;
      pts.push(cur);
      const taper = Math.max(0.18, 1 - (u ** 1.55) * 0.82);
      widths.push(baseW * taper);
      arches.push(baseW * taper * archRatio);
    }
    appendStrand(mesh, pts, widths, arches, skinFn, flexMax, phase, tone, lockSeed, normal);
  }

  // Dense crown-part & hairline root-cover locks along the midline so the part line is a natural soft seam, never a bald strip!
  if (!tonsure) {
    const centerAnchor = [0, ref.crownY - 0.088, ref.midZ - 0.004];
    for (let p = 0; p < 140; p++) {
      const zFrac = p / 139;
      const zTarget = (ref.foreZ - 0.016) * (1 - zFrac) + (ref.occZ + 0.015) * zFrac;
      const xOff = partX + ((p % 2 === 0 ? 1 : -1) * (0.001 + rand() * 0.014));
      const rayDir = norm3([xOff, 0.11, zTarget - centerAnchor[2]]);
      const hit = ref.raycast(centerAnchor, rayDir, 0.04, 0.18);
      if (!hit || hit.point[1] < ref.crownY - 0.054) continue;
      const sgn = (p % 2 === 0) ? 1 : -1;
      const segs = 5, pLen = style === 'cropped-curls' ? 0.042 : 0.085, bW = 0.0115;
      const pts = [add3(hit.point, hit.normal, 0.0022)];
      const widths = [bW * 1.18], arches = [bW * 0.30];
      let cur = add3(hit.point, hit.normal, 0.0042);
      let dir = norm3([sgn * 0.38, 0.18, -0.56]);
      for (let k = 1; k <= segs; k++) {
        const u = k / segs;
        dir = norm3([dir[0] * 0.84 + sgn * 0.14, dir[1] - 0.52 * u, dir[2] * 0.82 - 0.08]);
        const next = ref.repel(add3(cur, dir, pLen / segs), 0.0038 + u * 0.0020);
        dir = norm3(sub3(next, cur));
        cur = next;
        pts.push(cur);
        const w = bW * Math.max(0.22, 1 - u * 0.76);
        widths.push(w); arches.push(w * 0.30);
      }
      appendStrand(mesh, pts, widths, arches, skinFn, 0.30, rand(), 0.35 + rand() * 0.45, rand(), hit.normal);
    }
  }

  // Broad shingled temple & sideburn under-coat locks so light gaps never flash at the temples between locks.
  {
    const centerAnchor = [0, ref.crownY - 0.095, ref.midZ - 0.004];
    for (const sgn of [-1, 1]) {
      for (let t = 0; t < 38; t++) {
        const f = t / 37;
        const yTarget = (ref.crownY - 0.042) * (1 - f) + (ref.earY - 0.006) * f + (rand() - 0.5) * 0.006;
        const zTarget = (ref.midZ + 0.044) * (1 - f * 0.55) + (ref.earZ + 0.022) * (f * 0.55) + (rand() - 0.5) * 0.008;
        const rayDir = norm3([sgn * (0.072 + rand() * 0.012), yTarget - centerAnchor[1], zTarget - centerAnchor[2]]);
        const hit = ref.raycast(centerAnchor, rayDir, 0.04, 0.18);
        if (!hit) continue;
        const [hx, hy, hz] = hit.point;
        const earDy = (hy - ref.earY) / 0.034, earDz = (hz - ref.earZ) / 0.026;
        if (Math.abs(hx) > 0.052 && earDy * earDy + earDz * earDz < 1.0) continue;
        const segs = 4, tLen = (style === 'cropped-curls' || tonsure) ? (0.034 + rand() * 0.014) : (0.056 + rand() * 0.024);
        const bW = 0.0096 + rand() * 0.0020;
        const pts = [add3(hit.point, hit.normal, -0.0005)];
        const widths = [bW * 0.95], arches = [bW * 0.26];
        let cur = add3(hit.point, hit.normal, 0.0014);
        let dir = norm3(add3(hit.normal, [sgn * 0.10, -0.52 - f * 0.25, -0.68], 1.15));
        for (let k = 1; k <= segs; k++) {
          const u = k / segs;
          dir = norm3([dir[0] * 0.80, dir[1] - 0.42 * u, dir[2] * 0.82 - 0.14]);
          const next = ref.repel(add3(cur, dir, tLen / segs), 0.0022 + u * 0.0014);
          dir = norm3(sub3(next, cur));
          cur = next;
          pts.push(cur);
          const w = bW * Math.max(0.20, 1 - u * 0.78);
          widths.push(w); arches.push(w * 0.26);
        }
        appendStrand(mesh, pts, widths, arches, skinFn, 0.18, rand(), 0.34 + rand() * 0.44, rand(), hit.normal);
      }
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
  const oralOrigin = [0, ref.lipUpperY + 0.001, ref.midZ + 0.024];

  const moustacheSkin = () => [[JOINT_HEAD, JOINT_UPPER_LIP, 0, 0], [0.68, 0.32, 0, 0], JOINT_HEAD];
  const beardSkin = (p, u) => {
    const neckShare = style === 'sea-beard' && u > 0.65 ? Math.min(0.22, (u - 0.65) * 0.55) : 0;
    return [[JOINT_JAW, JOINT_HEAD, JOINT_NECK, 0], [0.72 - neckShare * 0.5, 0.28 - neckShare * 0.5, neckShare, 0], JOINT_JAW];
  };

  // 1. Moustache locks: rooted squarely on the cutaneous upper lip / philtrum (strictly ABOVE the mouth slit and BELOW
  //    the nostrils), sweeping outward laterally toward the mouth corners so the lower lip & mouth line stay crisp.
  const mCount = style === 'moustache' ? 230 : 190;
  for (let i = 0; i < mCount; i++) {
    const uX = ((i + 0.5) / mCount) * 2 - 1 + (rand() - 0.5) * 0.07;
    const absU = Math.abs(uX);
    const x = uX * 0.028;
    // Arch gently from mid-philtrum down toward the outer mouth corners, staying strictly above the mouth slit!
    const yTarget = ref.lipUpperY + 0.002 + (rand() - 0.45) * 0.0065 - (absU ** 1.4) * 0.0065;
    const zSpan = Math.max(0.04, ref.lipZ - oralOrigin[2]);
    const dirRay = norm3([x, yTarget - oralOrigin[1], zSpan]);
    const hit = ref.raycast(oralOrigin, dirRay, 0.02, 0.16);
    if (!hit) continue;
    // Hard anatomical guard: never root below the mouth slit or on the underside of the nose tip!
    const minHitY = ref.mouthY + 0.0030 - absU * 0.0035;
    if (hit.point[1] < minHitY || hit.point[1] > ref.noseY - 0.009 || hit.point[2] < ref.lipZ - 0.028) continue;
    const sgn = x >= 0 ? 1 : -1;
    const segs = 5;
    const len = (style === 'sea-beard' ? 0.019 : 0.015) + absU * 0.011 + rand() * 0.005;
    const baseW = 0.0018 + rand() * 0.0006;
    const root = add3(hit.point, hit.normal, -0.0015);
    const pts = [root], widths = [baseW * 0.85], arches = [baseW * 0.38];
    let cur = [...hit.point];
    // Sweep outward laterally along the upper lip rather than straight down over the lower lip!
    let dir = norm3([sgn * (0.64 + absU * 0.42), -0.34 - absU * 0.24, 0.28 - absU * 0.32]);
    for (let k = 1; k <= segs; k++) {
      const u = k / segs;
      const tipLift = style === 'iberian-barba' && u > 0.55 ? 0.22 : (style === 'moustache' && u > 0.60 ? 0.16 : 0);
      dir = norm3([dir[0] + sgn * 0.24 * u, dir[1] - 0.16 + tipLift, dir[2] - 0.16]);
      let next = add3(cur, dir, len / segs);
      next = ref.repel(next, 0.0016);
      cur = next;
      pts.push(cur);
      const w = baseW * Math.max(0.14, 1 - (u ** 1.35) * 0.86);
      widths.push(w); arches.push(w * 0.4);
    }
    appendStrand(mesh, pts, widths, arches, moustacheSkin, style === 'sea-beard' ? 0.28 : 0.16, rand(), 0.35 + rand() * 0.55, rand(), hit.normal);
  }

  if (style === 'moustache') return mesh;

  // 2. Chin, soul-patch, and jawline/cheek beard strands — rooted squarely on the FRONT of the chin and jawline
  //    (never on the throat behind the chin!).
  const jawOrigin = [0, ref.chinFrontY + 0.010, ref.midZ + 0.012];
  const emitBeardStrand = (hit, absT, isSoulPatch = false) => {
    const phase = rand();
    const isChinCenter = absT < 0.42;
    const segs = isSoulPatch ? 4 : (style === 'sea-beard' ? 7 : 6);
    const len = isSoulPatch
      ? (0.014 + rand() * 0.008)
      : style === 'sea-beard'
        ? (isChinCenter ? 0.056 + rand() * 0.026 : 0.044 + rand() * 0.024)
        : (isChinCenter ? 0.040 + rand() * 0.020 : 0.020 + rand() * 0.014);
    const baseW = (isSoulPatch ? 0.0022 : (style === 'sea-beard' ? 0.0044 : 0.0030)) + rand() * 0.0010;
    const root = add3(hit.point, hit.normal, -0.0016);
    const pts = [root], widths = [baseW * 0.92], arches = [baseW * 0.38];
    let cur = [...hit.point];
    // Grow forward-down along the natural full 1550 chin & jaw silhouette without pinching into a narrow tassel.
    let dir = norm3(add3(hit.normal, [0, -0.82, 0.24], 1.05));
    for (let k = 1; k <= segs; k++) {
      const u = k / segs;
      const pointPull = style === 'iberian-barba' ? -cur[0] * 1.9 * u : -cur[0] * 0.12 * u;
      const waveX = Math.sin(u * 8.5 + phase * 6.283) * (style === 'sea-beard' ? 0.0034 : 0.0016) * u;
      const waveZ = Math.cos(u * 7.2 + phase * 6.283) * (style === 'sea-beard' ? 0.0026 : 0.0012) * u;
      dir = norm3([dir[0] * 0.80 + pointPull, dir[1] - 0.44, dir[2] * 0.78 + 0.06]);
      let next = add3(cur, dir, len / segs);
      next[0] += waveX; next[2] += waveZ;
      next = ref.repel(next, 0.0020);
      cur = next;
      pts.push(cur);
      const w = baseW * Math.max(0.18, 1 - (u ** 1.40) * 0.82);
      widths.push(w); arches.push(w * 0.4);
    }
    appendStrand(mesh, pts, widths, arches, beardSkin, isSoulPatch ? 0.12 : (style === 'sea-beard' ? 0.52 : 0.34), phase, 0.30 + rand() * 0.60, rand(), hit.normal);
  };

  // 2a. Dense front-chin & soul-patch coverage directly on the pogonion & chin curve.
  const chinCount = style === 'sea-beard' ? 160 : 140;
  for (let i = 0; i < chinCount; i++) {
    const uX = ((i + 0.5) / chinCount) * 2 - 1 + (rand() - 0.5) * 0.08;
    const x = uX * 0.032;
    const isSoul = Math.abs(x) < 0.011 && rand() < 0.24;
    const yTarget = isSoul
      ? (ref.mouthY - 0.015 + rand() * 0.007)
      : (ref.chinY + 0.006 + rand() * (ref.mouthY - 0.020 - (ref.chinY + 0.006)));
    const zSpan = Math.max(0.05, ref.chinZ - jawOrigin[2]);
    const dirRay = norm3([x, yTarget - jawOrigin[1], zSpan]);
    const hit = ref.raycast(jawOrigin, dirRay, 0.02, 0.16);
    if (!hit) continue;
    // Strict front-chin guard: reject throat/neck hits behind the chin!
    if (hit.point[1] < ref.chinY + 0.001 || hit.point[2] < ref.chinZ - 0.026) continue;
    emitBeardStrand(hit, Math.abs(uX) * 0.35, isSoul);
  }

  // 2b. Jawline and lower-cheek beard strands sweeping from chin around both mandibles toward the sideburns.
  const bCount = style === 'sea-beard' ? 420 : 250;
  for (let i = 0; i < bCount; i++) {
    const uA = ((i + 0.5) / bCount) * 2 - 1 + (rand() - 0.5) * 0.06;
    const maxAngle = style === 'sea-beard' ? 1.32 : 0.94;
    const theta = uA * maxAngle;
    const absT = Math.abs(theta);
    const cheekH = style === 'sea-beard' ? 0.056 : 0.030;
    const yTarget = ref.chinY + 0.008 + rand() * (0.028 + absT * cheekH);
    // Keep lower lip vermilion & mouth slit clean!
    if (absT < 0.38 && yTarget > ref.mouthY - 0.018) continue;
    const radEst = 0.080;
    const dirRay = norm3([Math.sin(theta) * radEst, yTarget - jawOrigin[1], Math.cos(theta) * radEst]);
    const hit = ref.raycast(jawOrigin, dirRay, 0.02, 0.16);
    if (!hit) continue;
    if (hit.point[1] > ref.earY + 0.004 || hit.point[1] < ref.chinY + 0.001) continue;
    // Reject throat hits behind the jaw curve!
    const minJawZ = ref.chinZ - 0.024 - Math.abs(hit.point[0]) * 1.15;
    if (hit.point[2] < minJawZ) continue;
    emitBeardStrand(hit, absT, false);
  }
  return mesh;
}

// Builds an exact, smooth, genus-0 (closed, euler === 2) hair far-body shell directly from the fitted skull and
// baked 3D strands — bypassing voxel-wrapping so the far hair silhouette NEVER bridges across the face or turns boxy.
// Vertices inside the open facial window (forehead, eyes, nose, cheeks, mouth, ears, throat, and tonsure dome) are
// recessed deep inside the skull core (r = 4.2 cm), so hardware depth testing always keeps the real face 100% clear
// at every progressive collapse step while crown, temple, side, back, and draping hair stays smooth and voluminous.
function buildFarHairShell(ref, mesh, spec) {
  const isBeard = spec.slot === 'beard';
  const tonsure = spec.id === 'tonsure-fringe';
  const isLong = spec.id === 'parted-waves' || spec.id === 'indigenous-long' || spec.id === 'indigenous-long-f';
  const isQueue = spec.id === 'mariner-queue';
  const isBun = spec.id === 'nape-chignon';

  const Vmesh = mesh.position.length / 3;
  // Subsample strand vertices for fast directional silhouette measurement.
  const stride = Math.max(1, Math.floor(Vmesh / 1800));
  const strandPts = [];
  for (let v = 0; v < Vmesh; v += stride) {
    strandPts.push([mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]]);
  }

  const RINGS = isBeard ? 7 : 12;
  const SEGS = isBeard ? 12 : 20;
  const verts = [];
  const recessedFlag = [];
  const shellCenter = [0, ref.crownY - 0.090, ref.midZ - 0.006];

  if (isBeard) {
    // Tight jawline/lip ellipsoid strictly below nostrils so far beards never touch eyes or nose.
    const cx = 0;
    const cy = spec.id === 'moustache' ? ref.lipUpperY - 0.004 : (spec.id === 'sea-beard' ? ref.chinY - 0.008 : ref.chinY + 0.004);
    const cz = spec.id === 'moustache' ? ref.lipZ - 0.002 : ref.lipZ - 0.018;
    const rx = spec.id === 'moustache' ? 0.032 : (spec.id === 'sea-beard' ? 0.072 : 0.052);
    const ry = spec.id === 'moustache' ? 0.010 : (spec.id === 'sea-beard' ? 0.054 : 0.038);
    const rz = spec.id === 'moustache' ? 0.016 : (spec.id === 'sea-beard' ? 0.054 : 0.044);
    const maxY = ref.lipUpperY + 0.005;
    const pushBeardVert = (dx, dy, dz) => {
      let x = cx + dx * rx;
      let y = Math.min(maxY, cy + dy * ry);
      let z = cz + dz * rz;
      // Recess upper-back vertices into the jaw interior so only the outward beard silhouette shows.
      const isRec = dz < -0.15;
      if (isRec) {
        x *= 0.65;
        z = cz - 0.018;
      }
      verts.push([x, y, z]);
      recessedFlag.push(isRec);
    };
    pushBeardVert(0, 1, 0);
    for (let r = 1; r < RINGS; r++) {
      const phi = (r / RINGS) * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let s = 0; s < SEGS; s++) {
        const th = (s / SEGS) * Math.PI * 2;
        pushBeardVert(Math.sin(th) * sp, cp, Math.cos(th) * sp);
      }
    }
    pushBeardVert(0, -1, 0);
  } else {
    const center = [0, ref.crownY - 0.090, ref.midZ - 0.006];
    const evalDir = (dx, dy, dz) => {
      const dir = norm3([dx, dy, dz]);
      const hit = ref.raycast(center, dir, 0.035, 0.19);
      const skullR = hit ? hit.t : 0.088;
      const sx = center[0] + dir[0] * skullR;
      const sy = center[1] + dir[1] * skullR;
      const sz = center[2] + dir[2] * skullR;
      const ax = Math.abs(sx);

      // Exact open-face window: forehead below hairline, brows, eyes, nose, cheeks, mouth, chin, ears, and front throat.
      let recessed = false;
      const widowDip = 0.005 * Math.exp(-((sx / 0.020) ** 2));
      const templeRecede = 0.012 * Math.exp(-(((ax - 0.044) / 0.020) ** 2));
      const hairlineY = (ref.crownY - 0.044) - widowDip + templeRecede;
      if (sz > ref.midZ + 0.006 && sy < hairlineY) {
        // Keep sideburns/long cheek-framing hair only outside |x| > 0.064 and behind the cheek plane.
        const behindCheeks = ax > 0.064 && sz < ref.midZ + 0.030;
        if (!behindCheeks) recessed = true;
      }
      // Always keep the front facial cone (nose/eyes/mouth) strictly clear.
      if (dir[2] > 0.28 && dir[1] < 0.34) recessed = true;
      // Ears stay clear.
      const earDy = (sy - ref.earY) / 0.034, earDz = (sz - ref.earZ) / 0.026;
      if (ax > 0.052 && earDy * earDy + earDz * earDz < 1.0) recessed = true;
      // Nape/neck bottom cutoff (lower for long hair in the back/sides, strictly clear in front of throat).
      const backShare = Math.max(0, Math.min(1, (-dir[2] + 0.25) / 0.85));
      const minHairY = isLong
        ? (ref.crownY - 0.24 - backShare * 0.16)
        : (isQueue ? (ref.crownY - 0.20 - backShare * 0.12) : (ref.crownY - 0.175));
      if (sy < minHairY || (dir[1] < -0.55 && dir[2] > -0.15)) recessed = true;
      // Tonsure dome stays bare on top.
      if (tonsure) {
        const domeR = Math.hypot(sx / 0.056, (sz - (ref.midZ - 0.004)) / 0.068);
        if (sy > ref.crownY - 0.064 && domeR < 1.0) recessed = true;
      }

      if (recessed) {
        // Pull deep inside the cranium core (4.0 cm sphere) so no triangle or collapsed chord can ever cross the face!
        recessedFlag.push(true);
        return add3(center, dir, 0.040);
      }

      // Measure actual outer hair strand envelope along `dir` (within a 22-deg cone) so the far shell matches each groom.
      const radialSamples = [];
      for (let k = 0; k < strandPts.length; k++) {
        const p = strandPts[k];
        const vx = p[0] - center[0], vy = p[1] - center[1], vz = p[2] - center[2];
        const rl = Math.hypot(vx, vy, vz);
        if (rl < 0.04) continue;
        const cosA = (vx * dir[0] + vy * dir[1] + vz * dir[2]) / rl;
        if (cosA > 0.925) radialSamples.push(rl);
      }
      let targetR = skullR + 0.006;
      if (radialSamples.length >= 3) {
        radialSamples.sort((a, b) => a - b);
        const q75 = radialSamples[Math.floor(radialSamples.length * 0.72)];
        const maxExtra = isLong ? 0.095 : (isBun || isQueue ? 0.055 : 0.024);
        targetR = Math.max(skullR + 0.004, Math.min(skullR + maxExtra, q75));
      }
      const out = add3(center, dir, targetR);
      // Hard safety clamp: never let hair far-shell poke forward past the forehead/cheek plane below the hairline.
      if (out[1] < ref.crownY - 0.042 && out[2] > ref.midZ + 0.032) {
        out[2] = ref.midZ + 0.032;
      }
      recessedFlag.push(false);
      return out;
    };

    verts.push(evalDir(0, 1, 0));
    for (let r = 1; r < RINGS; r++) {
      const phi = (r / RINGS) * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let s = 0; s < SEGS; s++) {
        const th = (s / SEGS) * Math.PI * 2;
        verts.push(evalDir(Math.sin(th) * sp, cp, Math.cos(th) * sp));
      }
    }
    verts.push(evalDir(0, -1, 0));
  }

  // Build watertight outward-wound triangle indices (V = 2 + (RINGS - 1) * SEGS, F = 2 * (RINGS - 1) * SEGS, euler === 2).
  const tris = [];
  const southIdx = verts.length - 1;
  const ringIdx = (r, s) => 1 + (r - 1) * SEGS + (s % SEGS);
  for (let s = 0; s < SEGS; s++) {
    tris.push([0, ringIdx(1, s), ringIdx(1, s + 1)]);
  }
  for (let r = 1; r < RINGS - 1; r++) {
    for (let s = 0; s < SEGS; s++) {
      const a = ringIdx(r, s), b = ringIdx(r, s + 1);
      const c = ringIdx(r + 1, s), d = ringIdx(r + 1, s + 1);
      tris.push([a, c, d], [a, d, b]);
    }
  }
  for (let s = 0; s < SEGS; s++) {
    tris.push([ringIdx(RINGS - 1, s), southIdx, ringIdx(RINGS - 1, s + 1)]);
  }

  // Compute smooth outward vertex normals from non-recessed outer triangles so recessed inner cliff faces never darken
  // or twist hairline normals.
  const vNorms = verts.map(() => [0, 0, 0]);
  for (const [ia, ib, ic] of tris) {
    if (recessedFlag[ia] || recessedFlag[ib] || recessedFlag[ic]) continue;
    const fn = cross3(sub3(verts[ib], verts[ia]), sub3(verts[ic], verts[ia]));
    for (const idx of [ia, ib, ic]) {
      vNorms[idx][0] += fn[0];
      vNorms[idx][1] += fn[1];
      vNorms[idx][2] += fn[2];
    }
  }
  for (let i = 0; i < vNorms.length; i++) {
    const l = Math.hypot(vNorms[i][0], vNorms[i][1], vNorms[i][2]);
    vNorms[i] = l > 1e-6 ? vNorms[i].map((c) => c / l) : norm3(sub3(verts[i], shellCenter));
  }

  const T = tris.length;
  const vertices = new Float32Array(T * 24);
  const parts = new Uint32Array(T).fill(isBeard ? JOINT_JAW : JOINT_HEAD);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const v = tris[t][k], at = (t * 3 + k) * 8;
      vertices[at] = verts[v][0];
      vertices[at + 1] = verts[v][1];
      vertices[at + 2] = verts[v][2];
      vertices[at + 3] = vNorms[v][0];
      vertices[at + 4] = vNorms[v][1];
      vertices[at + 5] = vNorms[v][2];
      vertices[at + 6] = 0.5;
      vertices[at + 7] = 0;
    }
  }
  return { name: `${spec.id} far`, closed: true, vertices, triangles: T, parts };
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
  const baked = await bakeContinuumBody({ name: spec.id, welded, far: buildFarHairShell(ref, mesh, spec) });
  const { clusters, far: farBody } = baked;
  const V = farBody.position.length / 3;

  // Hand off from individual thin strand clusters to the smooth open-faced far hair shell right as strand ribbons
  // reach ~9 mm error (before thin strands collapse to sparse slivers), using the full base shell (farFirst = 0)
  // and disabling post-collapse normal inflation so far steps never puff outward across faces.
  farBody.farFirst = 0;
  const stepN = farBody.steps.length / 4;
  if (stepN > 0) {
    const stepFloats = new Float32Array(farBody.steps.buffer, farBody.steps.byteOffset, farBody.steps.length);
    const eLo = spec.slot === 'beard' ? 0.012 : 0.016;
    const eHi = Math.max(0.18, stepFloats[(stepN - 1) * 4 + 1]);
    const origLo = stepFloats[1];
    const origSpan = Math.max(stepFloats[(stepN - 1) * 4 + 1] - origLo, 1e-6);
    for (let s = 0; s < stepN; s++) {
      const u = stepN > 1 ? Math.max(s / (stepN - 1), (stepFloats[s * 4 + 1] - origLo) / origSpan) : 0;
      let nextErr = eLo + (eHi - eLo) * (u * u);
      if (s > 0) nextErr = Math.max(nextErr, stepFloats[(s - 1) * 4 + 1] * (1 + 4e-6) + 1e-7);
      stepFloats[s * 4 + 1] = nextErr;
      stepFloats[s * 4 + 2] = 0;
    }
  }

  // Assign skin, per-vertex flow word (tangent/tone/seed), and damped wind to far-body vertices from the nearest strand.
  // Keep crown/hairline wind zero so the solid far shell never shears sideways off the head in strong wind.
  const toStrand = triangleGrid(position, index, 0.02);
  const farSkin = new Array(V), farWind = new Uint32Array(V), farWords = new Uint32Array(V);
  const neutralFarWord = packTangentToneSeed([0, -1, 0], 0.5, 0.5);
  for (let i = 0; i < V; i++) {
    const px = farBody.position[i * 3], py = farBody.position[i * 3 + 1], pz = farBody.position[i * 3 + 2];
    const t = toStrand(px, py, pz);
    const w = [1 - closest[1] - closest[2], closest[1], closest[2]];
    const nearV = t >= 0 ? index[t * 3 + w.indexOf(Math.max(...w))] : 0;
    farSkin[i] = mesh.skin[nearV];
    farWords[i] = t >= 0 ? mesh.word[nearV] : neutralFarWord;
    const rawWind = mesh.wind[nearV];
    const rawFlex = (rawWind & 65535) / 65535;
    const phase = (rawWind >>> 16) / 65535;
    const hangShare = spec.slot === 'beard' ? 0 : Math.max(0, Math.min(1, (ref.crownY - 0.14 - py) / 0.14));
    const cappedFlex = rawFlex * hangShare * 0.14;
    farWind[i] = cappedFlex > 0.002 ? packWind(cappedFlex, phase) : 0;
  }

  const body = packContinuumBody({
    triangles: index.length / 3,
    vertex: (v) => ({ high: mesh.high[v], word: mesh.word[v] }),
    farWord: (i) => farWords[i],
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
