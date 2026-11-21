#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes each high-detail crew body into the people continuum (AGENTS.md rule 3; js/crew-continuum.js) by the one bake
// (js/continuum-bake.js bakeContinuumBody), each body an atlas of one type of the one format (js/continuum-format.js).
//   node scripts/prepare-crew-continuum.mjs --fits=<absolute .tripo/1550-hd/fit-regions> [--only=sailor-male] [--out=assets/crew/continuum] [--texture=4096]
// Each body comes from its fit (scripts/fit-crew-body.py --textured --full-texture, which tags each point's region),
// every point skinned to up to four of the crew skeleton's joints:
//   clusters   a cluster hierarchy cut on the GPU by projected error. Each piece of the body (CREW_CONTINUUM_PIECES: the
//              trunk in two, the neck, the head, each limb by its segments) is clustered apart, its boundary a seam both
//              sides coarsen together, and each piece's clusters ride the joint its points weigh on most. Each group's
//              error is measured in every pose of a set the body is held to (rest, its clips, each joint swung through
//              its range), so a cut keeps its bound while it moves.
//   far body   the one bake's, wrapped round a light even simplification of the fit (the far source) whose points wear
//              the colour of the surface about them. Each far point wears the skin of the far source's point nearest
//              it; each step's error is raised by how far the far source strays from the fit posed, and by how much
//              farther apart the far body and the far source come posed than at rest.
//   rig        each joint's sphere at rest, and the pose slack: the farthest any point comes, in any pose, from where
//              its cluster's joint, or its own strongest joint, alone would carry it.
//   splat      the one bake's, with each region's share of its outline and mean colour.
//   albedo     the body's texture, filled past its islands, in BC7 and ASTC 4x4 (scripts/crew-continuum-texture.py).
//   body.glb   the skeleton, clips and a light mesh the pose code measures footing and seating from (never drawn).
// Streams are written gzipped beside a manifest with their receipts. Only the manifests are kept in git.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readGLB, createSkinAnimator, gltfQuatMultiply } from '../js/gltf.js';
import { CREW_JOINT_NAMES, CREW_JOINT_COUNT } from '../js/crew-skeleton.js';
import {
  CREW_CONTINUUM_FORMAT, CREW_CONTINUUM_VERSION, CREW_CONTINUUM_BODIES, CREW_CONTINUUM_JOINT_PIECE, CREW_CONTINUUM_PIECES, CREW_CONTINUUM_REGIONS,
  CREW_CONTINUUM_STREAMS, validateCrewContinuumManifest,
} from '../js/crew-continuum.js';
import { CONTINUUM_STEP_WORDS } from '../js/continuum-core.js';
import { CONTINUUM_HEADER_WORDS, assembleContinuumAtlas, checkContinuumAtlas, packContinuumBody, packContinuumUV } from '../js/continuum-format.js';
import { bakeContinuumBody, closest, triangleSpheres, nearestTriangle, triangleGrid, outline } from '../js/continuum-bake.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const FITS = path.resolve(ROOT, option('fits', '.tripo/1550-hd/fit-regions'));
const OUT = path.resolve(ROOT, option('out', 'assets/crew/continuum'));
const ONLY = option('only', null);
const TEXTURE_SIZE = Number(option('texture', 4096));
const SAMPLE_SIZE = Math.min(2048, TEXTURE_SIZE);
// The far source the far body is wrapped round, and the light mesh body.glb carries, in triangles.
const FAR_SOURCE_TRIANGLES = Number(option('far', 50000));
const STAND_IN_TRIANGLES = Number(option('standin', 20000));
// What every sphere and the slack are grown by past what they must hold: for a pose outside the set, and for the
// quantization of the points they bound.
const SPHERE_MARGIN = 0.01;
// Each joint's reach either way about each of its own axes, in degrees, for the range-of-motion poses.
const RANGE_OF_MOTION = [
  [/^(upperarm|thigh)_[lr]$/, 80], [/^(lowerarm|calf)_[lr]$/, 110], [/^(hand|foot)_[lr]$/, 60], [/^ball_/, 40],
  [/^clavicle_/, 25], [/^spine_/, 20], [/^neck_/, 25], [/^head$/, 35], [/twist/, 40],
  [/^(thumb|index|middle|ring|pinky)_/, 70], [/^FACIAL_C_Jaw$/, 25], [/^FACIAL_.*Eyelid/, 30], [/^FACIAL_/, 20],
];
const CLIP_FRAMES = [['Idle', 3], ['Walk', 8], ['Brace', 3]];
// What a far-source point wears rides the bake as its two kind floats: its colour's three bytes (the square root of
// its linear colour) and its region, each kept below 1 by a power of two, so exactly.
const KIND_WORD = 2 ** -24;

// ------------------------------------------------------------------------------------------------ glTF reading
const COMPONENT = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
// A whole accessor as its own typed array (js/gltf.js caps accessors well below a high-detail body's indices).
function accessorOf(asset, index) {
  const a = asset.json.accessors[index], view = asset.json.bufferViews[a.bufferView], Type = COMPONENT[a.componentType], n = WIDTH[a.type];
  if (!Type || !n || a.sparse || a.normalized) throw Error(`Unsupported accessor ${index}`);
  const size = Type.BYTES_PER_ELEMENT;
  if ((view.byteStride ?? n * size) !== n * size) throw Error(`Interleaved accessor ${index}`);
  const start = asset.bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return new Type(asset.bin.buffer.slice(start, start + a.count * n * size));
}

function readFit(file) {
  const bytes = fs.readFileSync(file), asset = readGLB(bytes), g = asset.json;
  if (g.meshes?.length !== 1 || g.meshes[0].primitives.length !== 1) throw Error(`${file}: expected one primitive`);
  const primitive = g.meshes[0].primitives[0], at = primitive.attributes;
  if (at._REGION === undefined || at.TEXCOORD_0 === undefined) throw Error(`${file}: refit with --textured, which tags each point's region`);
  const position = accessorOf(asset, at.POSITION), normal = accessorOf(asset, at.NORMAL), uv = accessorOf(asset, at.TEXCOORD_0);
  const count = position.length / 3, rawJoints = accessorOf(asset, at.JOINTS_0), rawWeights = accessorOf(asset, at.WEIGHTS_0), rawRegion = accessorOf(asset, at._REGION);
  const joints = new Uint8Array(count * 4), weights = new Float32Array(count * 4), region = new Uint8Array(count);
  for (let v = 0; v < count; v++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += Math.max(0, rawWeights[v * 4 + k]);
    if (!(sum > 1e-6)) throw Error(`${file}: vertex ${v} is unweighted`);
    for (let k = 0; k < 4; k++) {
      const j = rawJoints[v * 4 + k];
      if (j >= CREW_JOINT_COUNT) throw Error(`${file}: vertex ${v} names joint ${j}`);
      joints[v * 4 + k] = j;
      weights[v * 4 + k] = Math.max(0, rawWeights[v * 4 + k]) / sum;
    }
    region[v] = rawRegion[v * 4];
    if (region[v] >= CREW_CONTINUUM_REGIONS.length) throw Error(`${file}: vertex ${v} has region ${region[v]}`);
  }
  const index = Uint32Array.from(accessorOf(asset, primitive.indices));
  const image = g.images?.[0], view = g.bufferViews[image?.bufferView];
  if (!view) throw Error(`${file}: no embedded texture`);
  const picture = asset.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const animator = createSkinAnimator(asset);
  CREW_JOINT_NAMES.forEach((name, slot) => {
    if (animator.names[animator.joints[slot]] !== name) throw Error(`${file}: joint ${slot} is ${animator.names[animator.joints[slot]]}, not ${name}`);
  });
  return { asset, animator, position, normal, uv, joints, weights, region, index, picture, mime: image.mimeType ?? 'image/jpeg', sha256: createHash('sha256').update(bytes).digest('hex') };
}

// The joint a point answers to most.
function strongest(fit, v) {
  let best = 0;
  for (let k = 1; k < 4; k++) if (fit.weights[v * 4 + k] > fit.weights[v * 4 + best]) best = k;
  return fit.joints[v * 4 + best];
}

// ------------------------------------------------------------------------------------------------ pieces
// Each vertex's piece is its strongest joint's; each triangle's is the piece most of its corners hold. A vertex on a
// boundary is copied into each piece that uses it, so the copies coarsen along the boundary together, as a seam. The
// fit's own vertices keep their numbers; the copies follow them.
function splitPieces(fit) {
  const count = fit.position.length / 3, own = new Uint8Array(count);
  for (let v = 0; v < count; v++) own[v] = CREW_CONTINUUM_JOINT_PIECE[strongest(fit, v)];
  const source = Array.from({ length: count }, (_, v) => v), piece = Array.from(own), copies = new Map();
  const index = new Uint32Array(fit.index.length);
  for (let t = 0; t < fit.index.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => own[fit.index[t + k]]);
    const p = a === b || a === c ? a : b === c ? b : a;
    for (let k = 0; k < 3; k++) {
      const v = fit.index[t + k];
      if (own[v] === p) { index[t + k] = v; continue; }
      let copy = copies.get(v * 32 + p);
      if (copy === undefined) { copy = source.length; copies.set(v * 32 + p, copy); source.push(v); piece.push(p); }
      index[t + k] = copy;
    }
  }
  const n = source.length, pick = (array, width) => {
    const out = new array.constructor(n * width);
    for (let v = 0; v < n; v++) out.set(array.subarray(source[v] * width, source[v] * width + width), v * width);
    return out;
  };
  return {
    count: n, copies: copies.size, index, piece: Uint32Array.from(piece), source: Uint32Array.from(source),
    position: pick(fit.position, 3), normal: pick(fit.normal, 3), uv: pick(fit.uv, 2), joints: pick(fit.joints, 4), weights: pick(fit.weights, 4), region: pick(fit.region, 1),
  };
}

// ------------------------------------------------------------------------------------------------ poses
// The poses every error and bound is measured in: rest, the body's clips, and each joint swung through its range
// about each of its axes, full and half way (all joints at once: each point answers to the joints near it).
function samplePoses(animator) {
  const palettes = [];
  palettes.push(animator.sample(null, 0).slice());
  for (const [name, frames] of CLIP_FRAMES) {
    const clip = animator.clips.get(name);
    if (!clip) continue;
    for (let f = 0; f < frames; f++) palettes.push(animator.sample(name, (clip.duration * f) / frames).slice());
  }
  const out = new Float32Array(4);
  for (const amplitude of [1, 0.5]) for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) {
    animator.sample(null, 0);
    CREW_JOINT_NAMES.forEach((name, slot) => {
      const degrees = RANGE_OF_MOTION.find(([pattern]) => pattern.test(name))?.[1] ?? 0;
      if (!degrees) return;
      const half = (sign * amplitude * degrees * Math.PI) / 360, q = [0, 0, 0, Math.cos(half)];
      q[axis] = Math.sin(half);
      const r = animator.pose[animator.joints[slot]].r;
      gltfQuatMultiply(out, r, q);
      r.set(out);
    });
    palettes.push(animator.update().slice());
  }
  animator.sample(null, 0);
  return palettes;
}
// A point posed by a palette (column-major 4x4 skin matrices, a joint each) and its four joints and weights.
function skinPoint(palette, joints, weights, v, x, y, z, out, at) {
  let px = 0, py = 0, pz = 0;
  for (let k = 0; k < 4; k++) {
    const w = weights[v * 4 + k];
    if (!w) continue;
    const m = joints[v * 4 + k] * 16;
    px += w * (palette[m] * x + palette[m + 4] * y + palette[m + 8] * z + palette[m + 12]);
    py += w * (palette[m + 1] * x + palette[m + 5] * y + palette[m + 9] * z + palette[m + 13]);
    pz += w * (palette[m + 2] * x + palette[m + 6] * y + palette[m + 10] * z + palette[m + 14]);
  }
  out[at] = px; out[at + 1] = py; out[at + 2] = pz;
}
function posedPositions(palette, body) {
  const out = new Float32Array(body.count * 3);
  for (let v = 0; v < body.count; v++) skinPoint(palette, body.joints, body.weights, v, body.position[v * 3], body.position[v * 3 + 1], body.position[v * 3 + 2], out, v * 3);
  return out;
}
const jointPoint = (palette, j, x, y, z, out) => {
  const m = j * 16;
  out[0] = palette[m] * x + palette[m + 4] * y + palette[m + 8] * z + palette[m + 12];
  out[1] = palette[m + 1] * x + palette[m + 5] * y + palette[m + 9] * z + palette[m + 13];
  out[2] = palette[m + 2] * x + palette[m + 6] * y + palette[m + 10] * z + palette[m + 14];
  return out;
};
// Up to four joints and their weights as the skin stream's two words: four joint bytes, four unorm weights summing
// to 255.
function packSkin(joints, weights) {
  const list = [0, 1, 2, 3].map((k) => [joints[k], weights[k]]).filter(([, w]) => w > 1e-6).sort((a, b) => b[1] - a[1]), sum = list.reduce((s, [, w]) => s + w, 0) || 1;
  const pairs = list.map(([j, w]) => [j, Math.round((w / sum) * 255)]);
  if (pairs.length) pairs[0][1] += 255 - pairs.reduce((s, [, q]) => s + q, 0);
  pairs.sort((a, b) => b[1] - a[1]);
  let J = 0, W = 0;
  pairs.forEach(([j, q], k) => { J |= j << (k * 8); W |= q << (k * 8); });
  return [J >>> 0, W >>> 0];
}

// ------------------------------------------------------------------------------------------------ posed measures
// How far apart, in the worst pose, a point of one posed set (vertex a) and the barycentric point (s, t) on triangle
// (b0, b1, b2) of the same are.
function posedGap(posed, a, b0, b1, b2, s, t) {
  const r = 1 - s - t;
  let worst = 0;
  for (const X of posed) {
    const dx = X[a * 3] - (r * X[b0 * 3] + s * X[b1 * 3] + t * X[b2 * 3]);
    const dy = X[a * 3 + 1] - (r * X[b0 * 3 + 1] + s * X[b1 * 3 + 1] + t * X[b2 * 3 + 1]);
    const dz = X[a * 3 + 2] - (r * X[b0 * 3 + 2] + s * X[b1 * 3 + 2] + t * X[b2 * 3 + 2]);
    worst = Math.max(worst, dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(worst);
}
// The builder's group error, measured posed: each point a group removes is matched, at rest, to its nearest point on
// what the group keeps of the same piece, and the error is the farthest those two come apart in any pose.
function posedGroupError(welded, posed) {
  const kept = new Int32Array(welded.count).fill(-1), seen = new Int32Array(welded.count).fill(-1), mesh = { position: welded.position, corners: null };
  let stamp = 0;
  return (children, simplified, error) => {
    stamp++;
    const count = simplified.length / 3;
    if (!count) return error;
    for (const v of simplified) kept[v] = stamp;
    const byPiece = new Map(), every = Array.from({ length: count }, (_, t) => t);
    for (let t = 0; t < count; t++) {
      const p = welded.part[simplified[t * 3]];
      if (!byPiece.has(p)) byPiece.set(p, []);
      byPiece.get(p).push(t);
    }
    mesh.corners = simplified;
    const pieceSpheres = new Map();
    let worst = 0;
    for (const v of children) {
      if (kept[v] === stamp || seen[v] === stamp) continue;
      seen[v] = stamp;
      const list = byPiece.get(welded.part[v]) ?? every;
      if (!pieceSpheres.has(list)) pieceSpheres.set(list, triangleSpheres(welded.position, simplified, list));
      const k = nearestTriangle(welded.position[v * 3], welded.position[v * 3 + 1], welded.position[v * 3 + 2], list, mesh, pieceSpheres.get(list)), t = list[k];
      worst = Math.max(worst, posedGap(posed, v, simplified[t * 3], simplified[t * 3 + 1], simplified[t * 3 + 2], closest[1], closest[2]));
    }
    return Math.max(worst, error);
  };
}

// ------------------------------------------------------------------------------------------------ texture
// The texels a body's UV triangles cover, at the texture's size, for the filling pass.
function coverageMask(fit, size) {
  const mask = new Uint8Array(size * size), { uv, index } = fit;
  for (let t = 0; t < index.length; t += 3) {
    const x = [0, 1, 2].map((k) => uv[index[t + k] * 2] * size - 0.5), y = [0, 1, 2].map((k) => uv[index[t + k] * 2 + 1] * size - 0.5);
    const area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(...x))), x1 = Math.min(size - 1, Math.ceil(Math.max(...x))), y0 = Math.max(0, Math.floor(Math.min(...y))), y1 = Math.min(size - 1, Math.ceil(Math.max(...y)));
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const w0 = ((x[1] - px) * (y[2] - py) - (x[2] - px) * (y[1] - py)) / area, w1 = ((x[2] - px) * (y[0] - py) - (x[0] - px) * (y[2] - py)) / area;
      if (w0 >= -1e-6 && w1 >= -1e-6 && 1 - w0 - w1 >= -1e-6) mask[py * size + px] = 1;
    }
  }
  return mask;
}
const DELIGHT_VERSION = 3;
function bakeTexture(fit, glbFile, work, reuseDir = null) {
  let prev = null;
  if (reuseDir && fs.existsSync(path.join(reuseDir, 'manifest.json')) && fs.existsSync(path.join(reuseDir, 'albedo.bc7.bin.gz')) && fs.existsSync(path.join(reuseDir, 'albedo.astc.bin.gz'))) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(reuseDir, 'manifest.json'), 'utf8'));
      if (m?.source?.sha256 === fit.sha256 && m?.texture?.width === TEXTURE_SIZE && m?.texture?.delightVersion === DELIGHT_VERSION && m?.files?.['albedo.bc7.bin'] && m?.files?.['albedo.astc.bin']) prev = m;
    } catch { /* rebake full texture */ }
  }
  const image = path.join(work, fit.mime === 'image/png' ? 'albedo.png' : 'albedo.jpg'), mask = path.join(work, 'mask.u8');
  fs.writeFileSync(image, fit.picture);
  fs.writeFileSync(mask, coverageMask(fit, TEXTURE_SIZE));
  const pyArgs = [fileURLToPath(new URL('./crew-continuum-texture.py', import.meta.url)), image, mask, work, `--size=${TEXTURE_SIZE}`, `--sample=${SAMPLE_SIZE}`, `--glb=${glbFile}`, ...(prev ? ['--sample-only'] : [])];
  execFileSync('python3', pyArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
  const sample = fs.readFileSync(path.join(work, 'sample.rgb')), toLinear = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  // Bilinear, in linear light, wrapping as the GPU's sampler does.
  const at = (u, v, out) => {
    const x = (((u % 1) + 1) % 1) * SAMPLE_SIZE - 0.5, y = (((v % 1) + 1) % 1) * SAMPLE_SIZE - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    out[0] = out[1] = out[2] = 0;
    for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const px = (x0 + dx + SAMPLE_SIZE) % SAMPLE_SIZE, py = (y0 + dy + SAMPLE_SIZE) % SAMPLE_SIZE, s = (py * SAMPLE_SIZE + px) * 3;
      for (let k = 0; k < 3; k++) out[k] += w * toLinear[sample[s + k]];
    }
    return out;
  };
  if (prev) return { levels: prev.texture, bc7: null, astc: null, reusedFiles: prev.files, at };
  return { levels: JSON.parse(fs.readFileSync(path.join(work, 'levels.json'), 'utf8')), bc7: fs.readFileSync(path.join(work, 'albedo.bc7.bin')), astc: fs.readFileSync(path.join(work, 'albedo.astc.bin')), reusedFiles: null, at };
}
// Each triangle's colour and area, and each region's median colour (area-weighted, a channel at a time).
function surfaceColours(fit, texture) {
  const T = fit.index.length / 3, colour = new Float32Array(T * 3), area = new Float32Array(T), region = new Uint8Array(T), rgb = [0, 0, 0];
  for (let t = 0; t < T; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => fit.index[t * 3 + k]);
    texture.at((fit.uv[a * 2] + fit.uv[b * 2] + fit.uv[c * 2]) / 3, (fit.uv[a * 2 + 1] + fit.uv[b * 2 + 1] + fit.uv[c * 2 + 1]) / 3, rgb);
    colour.set(rgb, t * 3);
    const P = fit.position, e = [0, 1, 2].map((k) => P[b * 3 + k] - P[a * 3 + k]), f = [0, 1, 2].map((k) => P[c * 3 + k] - P[a * 3 + k]);
    area[t] = 0.5 * Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]);
    const r = [fit.region[a], fit.region[b], fit.region[c]];
    region[t] = r[0] === r[1] || r[0] === r[2] ? r[0] : r[1] === r[2] ? r[1] : r[0];
  }
  const medians = CREW_CONTINUUM_REGIONS.map((_, r) => {
    const members = [];
    for (let t = 0; t < T; t++) if (region[t] === r && area[t] > 0) members.push(t);
    if (!members.length) return null;
    const total = members.reduce((s, t) => s + area[t], 0);
    return [0, 1, 2].map((k) => {
      members.sort((p, q) => colour[p * 3 + k] - colour[q * 3 + k]);
      let sum = 0;
      for (const t of members) if ((sum += area[t]) >= total / 2) return +colour[t * 3 + k].toFixed(5);
      return +colour[members.at(-1) * 3 + k].toFixed(5);
    });
  });
  // Each region's area-weighted mean, for the splat.
  const means = CREW_CONTINUUM_REGIONS.map((_, r) => {
    const sum = [0, 0, 0];
    let weight = 0;
    for (let t = 0; t < T; t++) if (region[t] === r) { for (let k = 0; k < 3; k++) sum[k] += area[t] * colour[t * 3 + k]; weight += area[t]; }
    return weight > 0 ? sum.map((v) => +(v / weight).toFixed(5)) : null;
  });
  return { colour, area, region, medians, means };
}
// A linear colour's three bytes, each the square root of its channel, so the dark of cloth and skin keeps its steps.
const colourBytes = (rgb) => rgb.reduce((n, c, k) => n | (Math.max(0, Math.min(255, Math.round(Math.sqrt(Math.max(c, 0)) * 255))) << (k * 8)), 0) >>> 0;

// ------------------------------------------------------------------------------------------------ the far source
// The fit welded by position into one surface, each welded point keeping its own skin and region.
function weld(fit) {
  const remap = MeshoptSimplifier.generatePositionRemap(fit.position, 3), count = fit.position.length / 3, normal = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) for (let k = 0; k < 3; k++) normal[remap[v] * 3 + k] += fit.normal[v * 3 + k];
  const index = [];
  for (let t = 0; t < fit.index.length; t += 3) {
    const a = remap[fit.index[t]], b = remap[fit.index[t + 1]], c = remap[fit.index[t + 2]];
    if (a !== b && b !== c && c !== a) index.push(a, b, c);
  }
  for (let v = 0; v < count; v++) if (remap[v] === v) {
    const l = Math.hypot(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]) || 1;
    for (let k = 0; k < 3; k++) normal[v * 3 + k] /= l;
  }
  return { index: Uint32Array.from(index), normal, remap };
}
// A simplification of the welded body that keeps region borders and the shading's turns, as a vertex subset. The
// weld leaves points where separate sheets of the fit meet (a cuff on a wrist, a collar on a neck), which the
// simplifier holds fixed unless permitted to move them. `even` asks for triangles near equilateral.
function simplifyWelded(fit, welded, triangles, even) {
  const count = fit.position.length / 3, attributes = new Float32Array(count * 8);
  for (let v = 0; v < count; v++) {
    attributes.set(welded.normal.subarray(v * 3, v * 3 + 3), v * 8);
    attributes[v * 8 + 3 + fit.region[v]] = 1;
  }
  const [index, error] = MeshoptSimplifier.simplifyWithAttributes(welded.index, fit.position, 3, attributes, 8, [0.25, 0.25, 0.25, 0.02, 0.02, 0.02, 0.02, 0.02], null, triangles * 3, 1e9, ['ErrorAbsolute', 'Permissive', ...(even ? ['Regularize'] : [])]);
  if (index.length > triangles * 3 * 1.05) throw Error(`The welded body simplified only to ${index.length / 3} triangles of ${triangles}`);
  const vertices = [...new Set(index)], local = new Map(vertices.map((v, i) => [v, i]));
  return { vertices: Uint32Array.from(vertices), index: Uint32Array.from(index, (v) => local.get(v)), error };
}
// Each welded point's nearest base point along the surface (Dijkstra from every base point at once), first keeping
// to the point's own region, then, for a patch of a region no base point holds, across regions.
function assignToBase(fit, welded, baseVertices) {
  const count = fit.position.length / 3, start = new Uint32Array(count + 1), P = fit.position;
  for (const v of welded.index) start[v + 1] += 2;
  for (let v = 0; v < count; v++) start[v + 1] += start[v];
  const fill = start.slice(0, count), next = new Uint32Array(start[count]);
  for (let t = 0; t < welded.index.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = welded.index[t + k], b = welded.index[t + ((k + 1) % 3)];
    next[fill[a]++] = b; next[fill[b]++] = a;
  }
  const owner = new Int32Array(count).fill(-1), distance = new Float64Array(count).fill(Infinity);
  let heapD = new Float64Array(1 << 20), heapV = new Int32Array(1 << 20), size = 0;
  const push = (d, v) => {
    if (size === heapD.length) { const d2 = new Float64Array(size * 2), v2 = new Int32Array(size * 2); d2.set(heapD); v2.set(heapV); heapD = d2; heapV = v2; }
    let i = size++;
    while (i > 0) { const j = (i - 1) >> 1; if (heapD[j] <= d) break; heapD[i] = heapD[j]; heapV[i] = heapV[j]; i = j; }
    heapD[i] = d; heapV[i] = v;
  };
  const pop = () => {
    const v = heapV[0], d = heapD[0], lastD = heapD[--size], lastV = heapV[size];
    let i = 0;
    for (;;) { const l = 2 * i + 1, r = l + 1; let m = -1, md = lastD; if (l < size && heapD[l] < md) { m = l; md = heapD[l]; } if (r < size && heapD[r] < md) { m = r; } if (m < 0) break; heapD[i] = heapD[m]; heapV[i] = heapV[m]; i = m; }
    heapD[i] = lastD; heapV[i] = lastV;
    return [d, v];
  };
  const run = (crossing, open) => {
    while (size) {
      const [d, v] = pop();
      if (d > distance[v]) continue;
      for (let e = start[v]; e < start[v + 1]; e++) {
        const w = next[e];
        if (!crossing && fit.region[w] !== fit.region[v]) continue;
        if (open && !open[w]) continue;
        const nd = d + Math.hypot(P[w * 3] - P[v * 3], P[w * 3 + 1] - P[v * 3 + 1], P[w * 3 + 2] - P[v * 3 + 2]);
        if (nd < distance[w]) { distance[w] = nd; owner[w] = owner[v]; push(nd, w); }
      }
    }
  };
  baseVertices.forEach((v, i) => { owner[v] = i; distance[v] = 0; push(0, v); });
  run(false, null);
  const open = new Uint8Array(count);
  let unreached = 0;
  for (const v of welded.index) if (owner[v] < 0 && !open[v]) { open[v] = 1; unreached++; }
  if (unreached) {
    for (let v = 0; v < count; v++) if (owner[v] >= 0) push(distance[v], v);
    run(true, open);
  }
  return owner;
}
// The far source: the welded fit simplified evenly, each of its points (a fit vertex) wearing the area-weighted mean
// colour of the fit's triangles nearest it along the surface within its own region (assignToBase), so no colour
// crosses from shirt to skin or from an arm to the body beside it. As the one bake reads a body: eight floats a
// corner (position, normal, and its colour's bytes and its region as kinds), each triangle's piece.
function farSource(fit, welded, surface) {
  const base = simplifyWelded(fit, welded, FAR_SOURCE_TRIANGLES, true), V = base.vertices.length, T = base.index.length / 3;
  const owner = assignToBase(fit, welded, base.vertices), sums = new Float64Array(V * 4);
  for (let t = 0; t < fit.index.length / 3; t++) {
    const w = surface.area[t] / 3;
    for (let k = 0; k < 3; k++) {
      const i = owner[welded.remap[fit.index[t * 3 + k]]];
      if (i < 0) continue;
      for (let c = 0; c < 3; c++) sums[i * 4 + c] += w * surface.colour[t * 3 + c];
      sums[i * 4 + 3] += w;
    }
  }
  const colour = new Uint32Array(V);
  base.vertices.forEach((v, i) => {
    const median = surface.medians[fit.region[v]] ?? [0.5, 0.5, 0.5];
    colour[i] = colourBytes([0, 1, 2].map((k) => (sums[i * 4 + 3] > 0 ? sums[i * 4 + k] / sums[i * 4 + 3] : median[k])));
  });
  const vertices = new Float32Array(T * 24), parts = new Uint32Array(T), corners = Uint32Array.from(base.index, (i) => base.vertices[i]);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const i = base.index[t * 3 + k], v = base.vertices[i], at = (t * 3 + k) * 8;
      vertices.set(fit.position.subarray(v * 3, v * 3 + 3), at);
      vertices.set(welded.normal.subarray(v * 3, v * 3 + 3), at + 3);
      vertices[at + 6] = colour[i] * KIND_WORD;
      vertices[at + 7] = fit.region[v] * KIND_WORD;
    }
  }
  // Each triangle's piece, for matching the fit to it piece by piece.
  const piece = Uint8Array.from({ length: T }, (_, t) => {
    const [a, b, c] = [0, 1, 2].map((k) => CREW_CONTINUUM_JOINT_PIECE[strongest(fit, corners[t * 3 + k])]);
    return a === b || a === c ? a : b === c ? b : a;
  });
  return { type: { name: 'far source', vertices, triangles: T, parts }, corners, piece, triangles: T, vertices: base.vertices, simplifyError: base.error };
}

// ------------------------------------------------------------------------------------------------ body.glb
// The fit's skeleton and clips with a light mesh the pose code measures footing and seating from, painted garment by
// garment as the crew's own records describe a body: each point's shade against its region's median, plus twice its
// garment in blue. It is never drawn.
const GARMENT = [0, 1, 2, 3, 4];
function writeBody(fit, welded, surface, texture) {
  const stand = simplifyWelded(fit, welded, STAND_IN_TRIANGLES, false), n = stand.vertices.length, rgb = [0, 0, 0];
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), colour = new Float32Array(n * 3), joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
  stand.vertices.forEach((v, i) => {
    position.set(fit.position.subarray(v * 3, v * 3 + 3), i * 3);
    normal.set(welded.normal.subarray(v * 3, v * 3 + 3), i * 3);
    joints.set(fit.joints.subarray(v * 4, v * 4 + 4), i * 4);
    weights.set(fit.weights.subarray(v * 4, v * 4 + 4), i * 4);
    texture.at(fit.uv[v * 2], fit.uv[v * 2 + 1], rgb);
    const r = fit.region[v], median = surface.medians[r];
    if (!GARMENT[r] || !median) colour.set(rgb.map((c) => Math.min(c, 1.999)), i * 3);
    else colour.set([0, 1, 2].map((k) => Math.min(1.999, rgb[k] / Math.max(median[k], 1e-4)) + (k === 2 ? 2 * GARMENT[r] : 0)), i * 3);
  });
  const g = fit.asset.json, views = [], accessors = [], chunks = [];
  let length = 0;
  const add = (typed, type, componentType, extra = {}) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    chunks.push(bytes);
    length += bytes.length;
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); length += pad; }
    accessors.push({ bufferView: views.length - 1, componentType, count: typed.length / WIDTH[type], type, ...extra });
    return accessors.length - 1;
  };
  const bounds = [0, 1, 2].map((k) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { lo = Math.min(lo, position[i * 3 + k]); hi = Math.max(hi, position[i * 3 + k]); } return [lo, hi]; });
  const attributes = {
    POSITION: add(position, 'VEC3', 5126, { min: bounds.map((b) => b[0]), max: bounds.map((b) => b[1]) }),
    NORMAL: add(normal, 'VEC3', 5126), COLOR_0: add(colour, 'VEC3', 5126), JOINTS_0: add(joints, 'VEC4', 5123), WEIGHTS_0: add(weights, 'VEC4', 5126),
  };
  const indices = add(stand.vertices.length < 65536 ? Uint16Array.from(stand.index) : Uint32Array.from(stand.index), 'SCALAR', stand.vertices.length < 65536 ? 5123 : 5125);
  const inverseBindMatrices = add(accessorOf(fit.asset, g.skins[0].inverseBindMatrices), 'MAT4', 5126);
  const copied = new Map(), copy = (index) => {
    if (!copied.has(index)) {
      const a = g.accessors[index];
      copied.set(index, add(accessorOf(fit.asset, index), a.type, 5126, a.min ? { min: a.min, max: a.max } : {}));
    }
    return copied.get(index);
  };
  const animations = g.animations.map((a) => ({ name: a.name, channels: a.channels, samplers: a.samplers.map((s) => ({ input: copy(s.input), output: copy(s.output), interpolation: s.interpolation ?? 'LINEAR' })) }));
  const meshNode = g.nodes.findIndex((node) => node.mesh !== undefined);
  if (meshNode < 0) throw Error('The fit has no mesh node');
  const json = {
    asset: { version: '2.0', generator: 'waterworld/scripts/prepare-crew-continuum.mjs', copyright: g.asset.copyright },
    scene: g.scene ?? 0, scenes: g.scenes, nodes: g.nodes.map((node, i) => (i === meshNode ? { ...node, mesh: 0, skin: 0 } : node)),
    meshes: [{ name: 'continuum rig mesh', primitives: [{ attributes, indices, material: 0 }] }],
    materials: [{ name: 'Crew character material', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }],
    skins: [{ name: g.skins[0].name, joints: g.skins[0].joints, inverseBindMatrices }],
    animations, buffers: [{ byteLength: length }], bufferViews: views, accessors,
    extras: { ...g.extras, crewContinuum: 'rig: the body is drawn from its continuum atlas' },
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks), header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  jsonHeader.writeUInt32LE(text.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return { bytes: Buffer.concat([header, jsonHeader, text, binHeader, bin]), triangles: stand.index.length / 3, vertices: n };
}
// How far the light mesh's footing and seating, which the pose code measures from it, are from the full body's.
function contactDrift(fit, bytes) {
  const stand = createSkinAnimator(readGLB(bytes)), full = fit.animator, drift = {};
  for (const side of ['l', 'r']) {
    const a = full.footContacts?.[side], b = stand.footContacts?.[side];
    if (!a || !b) throw Error(`No ${side} foot contact on the ${a ? 'light mesh' : 'fit'}`);
    drift[`ankleAboveSole_${side}`] = +(b.ankleAboveSole - a.ankleAboveSole).toFixed(4);
  }
  drift.pelvisAboveSeat = +((stand.seatContact?.pelvisAboveSeat ?? 0) - (full.seatContact?.pelvisAboveSeat ?? 0)).toFixed(4);
  return drift;
}

// ------------------------------------------------------------------------------------------------ main
function receipt(bytes, dir, name) {
  const gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(dir, `${name}.gz`), gz);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), gzip: { file: `${name}.gz`, bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex') } };
}
const asBytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);

async function bake(entry) {
  const started = Date.now(), lap = (label) => console.log(`  ${label.padEnd(12)} ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const file = path.join(FITS, `${entry.id}.glb`), fit = readFit(file), work = fs.mkdtempSync(path.join(os.tmpdir(), `crew-continuum-${entry.id}-`));
  const fitCount = fit.position.length / 3;
  console.log(`${entry.id}: ${fitCount} vertices, ${fit.index.length / 3} triangles`);
  try {
    const dir = path.join(OUT, entry.id);
    const palettes = samplePoses(fit.animator), body = splitPieces(fit), posed = palettes.map((palette) => posedPositions(palette, body));
    lap(`${palettes.length} poses`);
    const texture = bakeTexture(fit, file, work, dir), surface = surfaceColours(fit, texture);
    lap('albedo');
    const weldedFit = weld(fit), far = farSource(fit, weldedFit, surface);
    lap('far source');

    // The one bake: the pieces clustered with their error measured posed, and the far body wrapped round the far source.
    const welded = { position: body.position, normal: body.normal, kind: body.uv, part: body.piece, index: body.index, count: body.count, corner: null };
    const baked = await bakeContinuumBody({ name: entry.id, welded, groupError: () => posedGroupError(welded, posed), far: far.type });
    const { clusters, far: farBody } = baked;
    lap('one bake');

    // Each piece's clusters ride its leading joint: the one its points weigh on most.
    const weigh = CREW_CONTINUUM_PIECES.map(() => new Float64Array(CREW_JOINT_COUNT));
    for (let v = 0; v < body.count; v++) for (let k = 0; k < 4; k++) weigh[body.piece[v]][body.joints[v * 4 + k]] += body.weights[v * 4 + k];
    const leadOf = weigh.map((tally) => tally.reduce((best, w, j) => (w > tally[best] ? j : best), 0));
    for (const record of clusters.records) record.part = leadOf[record.part];

    // Each far point wears the skin of the far source's point nearest it.
    const V = farBody.position.length / 3, farSkin = new Uint32Array(V), toSource = triangleGrid(fit.position, far.corners, 0.1);
    for (let i = 0; i < V; i++) {
      const t = toSource(farBody.position[i * 3], farBody.position[i * 3 + 1], farBody.position[i * 3 + 2]), w = [1 - closest[1] - closest[2], closest[1], closest[2]];
      farSkin[i] = far.corners[t * 3 + w.indexOf(Math.max(...w))];
    }
    const farJoints = new Uint8Array(V * 4), farWeights = new Float32Array(V * 4);
    for (let i = 0; i < V; i++) { farJoints.set(fit.joints.subarray(farSkin[i] * 4, farSkin[i] * 4 + 4), i * 4); farWeights.set(fit.weights.subarray(farSkin[i] * 4, farSkin[i] * 4 + 4), i * 4); }

    // The pose slack: how far any point comes, in any pose, from where its cluster's joint alone would carry it, and from
    // where its own strongest joint would (which every whole-body bound is made of).
    const alone = [0, 0, 0], at = new Float32Array(3), pieceSlack = new Float64Array(CREW_CONTINUUM_PIECES.length);
    let slack = 0;
    palettes.forEach((palette, k) => {
      const X = posed[k];
      for (let v = 0; v < body.count; v++) {
        const x = body.position[v * 3], y = body.position[v * 3 + 1], z = body.position[v * 3 + 2];
        for (const j of [leadOf[body.piece[v]], strongest(body, v)]) {
          jointPoint(palette, j, x, y, z, alone);
          const d = Math.hypot(X[v * 3] - alone[0], X[v * 3 + 1] - alone[1], X[v * 3 + 2] - alone[2]);
          if (d > pieceSlack[body.piece[v]]) pieceSlack[body.piece[v]] = d;
        }
      }
      for (let i = 0; i < V; i++) {
        const x = farBody.position[i * 3], y = farBody.position[i * 3 + 1], z = farBody.position[i * 3 + 2];
        skinPoint(palette, farJoints, farWeights, i, x, y, z, at, 0);
        jointPoint(palette, strongest({ joints: farJoints, weights: farWeights }, i), x, y, z, alone);
        slack = Math.max(slack, Math.hypot(at[0] - alone[0], at[1] - alone[1], at[2] - alone[2]));
      }
    });
    slack = Math.max(slack, ...pieceSlack) + SPHERE_MARGIN;
    lap(`slack ${slack.toFixed(3)} m`);

    // The far source's own error, posed: a sample of the fit's points, each matched by piece to its nearest far-source
    // triangle at rest, and how far apart the two come in any pose.
    const bySourcePiece = new Map();
    for (let t = 0; t < far.triangles; t++) { if (!bySourcePiece.has(far.piece[t])) bySourcePiece.set(far.piece[t], []); bySourcePiece.get(far.piece[t]).push(t); }
    const allSource = Array.from({ length: far.triangles }, (_, t) => t), sourceMesh = { position: fit.position, corners: far.corners }, sourceSpheres = new Map();
    const stride = Math.max(1, Math.floor(fitCount / 40000));
    let sourceError = 0;
    for (let v = 0; v < fitCount; v += stride) {
      const list = bySourcePiece.get(CREW_CONTINUUM_JOINT_PIECE[strongest(fit, v)]) ?? allSource;
      if (!sourceSpheres.has(list)) sourceSpheres.set(list, triangleSpheres(fit.position, far.corners, list));
      const k = nearestTriangle(fit.position[v * 3], fit.position[v * 3 + 1], fit.position[v * 3 + 2], list, sourceMesh, sourceSpheres.get(list)), t = list[k];
      sourceError = Math.max(sourceError, posedGap(posed, v, far.corners[t * 3], far.corners[t * 3 + 1], far.corners[t * 3 + 2], closest[1], closest[2]));
    }
    // The far body posed: how much farther it and the far source come apart than at rest.
    const restGap = new Float32Array(V), sourceVertices = far.vertices, sourceGap = new Float32Array(sourceVertices.length);
    {
      const toFar = triangleGrid(farBody.position, farBody.index, 0.1);
      for (let i = 0; i < V; i++) { toSource(farBody.position[i * 3], farBody.position[i * 3 + 1], farBody.position[i * 3 + 2]); restGap[i] = Math.sqrt(closest[0]); }
      sourceVertices.forEach((v, i) => { toFar(fit.position[v * 3], fit.position[v * 3 + 1], fit.position[v * 3 + 2]); sourceGap[i] = Math.sqrt(closest[0]); });
    }
    let posedDelta = 0;
    const farPosed = new Float32Array(V * 3);
    palettes.forEach((palette, k) => {
      const X = posed[k];
      for (let i = 0; i < V; i++) skinPoint(palette, farJoints, farWeights, i, farBody.position[i * 3], farBody.position[i * 3 + 1], farBody.position[i * 3 + 2], farPosed, i * 3);
      const toX = triangleGrid(X, far.corners, 0.1), toY = triangleGrid(farPosed, farBody.index, 0.1);
      for (let i = 0; i < V; i++) { toX(farPosed[i * 3], farPosed[i * 3 + 1], farPosed[i * 3 + 2]); posedDelta = Math.max(posedDelta, Math.sqrt(closest[0]) - restGap[i]); }
      sourceVertices.forEach((v, i) => { toY(X[v * 3], X[v * 3 + 1], X[v * 3 + 2]); posedDelta = Math.max(posedDelta, Math.sqrt(closest[0]) - sourceGap[i]); });
    });
    const stepFloats = new Float32Array(farBody.steps.buffer, farBody.steps.byteOffset, farBody.steps.length);
    for (let s = 0; s < farBody.steps.length / CONTINUUM_STEP_WORDS; s++) stepFloats[s * CONTINUUM_STEP_WORDS + 1] += sourceError + posedDelta;
    lap(`far posed +${(sourceError + posedDelta).toFixed(3)} m`);

    // Each joint's sphere at rest: every cluster and far point it carries, grown by the far body's inflation.
    const lo = Array.from({ length: CREW_JOINT_COUNT }, () => [Infinity, Infinity, Infinity]), hi = Array.from({ length: CREW_JOINT_COUNT }, () => [-Infinity, -Infinity, -Infinity]);
    const eachMember = (visit) => {
      for (let v = 0; v < body.count; v++) for (let k = 0; k < 4; k++) if (body.weights[v * 4 + k] > 0) visit(body.joints[v * 4 + k], body.position, v);
      for (let i = 0; i < V; i++) for (let k = 0; k < 4; k++) if (farWeights[i * 4 + k] > 0) visit(farJoints[i * 4 + k], farBody.position, i);
    };
    eachMember((j, P, v) => { for (let k = 0; k < 3; k++) { lo[j][k] = Math.min(lo[j][k], P[v * 3 + k]); hi[j][k] = Math.max(hi[j][k], P[v * 3 + k]); } });
    const centres = lo.map((l, j) => l.map((x, k) => (x + hi[j][k]) / 2)), radii = new Float64Array(CREW_JOINT_COUNT).fill(-1);
    eachMember((j, P, v) => { radii[j] = Math.max(radii[j], Math.hypot(P[v * 3] - centres[j][0], P[v * 3 + 1] - centres[j][1], P[v * 3 + 2] - centres[j][2])); });
    const spheres = centres.map((c, j) => (radii[j] < 0 ? [0, 0, 0, -1] : [...c.map((x) => +x.toFixed(5)), +(radii[j] + farBody.stats.inflateMax + SPHERE_MARGIN).toFixed(5)]));

    // The splat's regions: each one's share of the far body's outline, front and side, and its mean colour.
    const regionOf = (t) => Math.round(farBody.kinds[t * 2 + 1] / KIND_WORD);
    const low = [0, 1, 2].map((k) => Math.min(...Array.from({ length: V }, (_, i) => farBody.position[i * 3 + k]))), high = [0, 1, 2].map((k) => Math.max(...Array.from({ length: V }, (_, i) => farBody.position[i * 3 + k])));
    const span = Math.max(...high.map((h, k) => h - low[k])), frame = { low: low.map((v) => v - 0.05), size: span + 0.1, cells: 192 };
    const views = outline(farBody.position, farBody.normal, farBody.index, Array.from({ length: farBody.index.length / 3 }, (_, t) => t), 0, frame, regionOf, [[0, 1, 2], [2, 1, 0]]);
    const shares = CREW_CONTINUUM_REGIONS.map(() => 0);
    let covered = 0;
    for (const view of views) for (const r of view.label) if (r >= 0) { shares[r]++; covered++; }
    const splat = {
      centre: farBody.splat.centre, rx: farBody.splat.rx, ry: farBody.splat.ry,
      regions: CREW_CONTINUUM_REGIONS.map((name, r) => ({ name, share: +(covered ? shares[r] / covered : 0).toFixed(4), mean: surface.means[r] })),
    };

    // The atlas: one type, every cluster point wearing its picture's place and its skin, and its colour and region in
    // its word; every far point its skin; every far triangle its colour and region.
    const rgb = [0, 0, 0];
    const words = packContinuumBody({
      triangles: fit.index.length / 3, splat,
      vertex: (v) => { texture.at(body.uv[v * 2], body.uv[v * 2 + 1], rgb); return { word: (colourBytes(rgb) | (body.region[v] << 24)) >>> 0 }; },
      farWord: (t) => (Math.round(farBody.kinds[t * 2] / KIND_WORD) | (regionOf(t) << 24)) >>> 0,
      streams: {
        skin: (v) => packSkin(body.joints.subarray(v * 4, v * 4 + 4), body.weights.subarray(v * 4, v * 4 + 4)),
        uv: (v) => [packContinuumUV([Math.min(1, Math.max(0, body.uv[v * 2])), Math.min(1, Math.max(0, body.uv[v * 2 + 1]))])],
      },
      farStreams: { skin: (i) => packSkin(farJoints.subarray(i * 4, i * 4 + 4), farWeights.subarray(i * 4, i * 4 + 4)) },
    }, baked);
    const atlas = checkContinuumAtlas(assembleContinuumAtlas([words.words]), `${entry.id} crew`);
    lap('atlas');

    const standIn = writeBody(fit, weldedFit, surface, texture), drift = contactDrift(fit, standIn.bytes);
    lap('body.glb');

    fs.mkdirSync(dir, { recursive: true });
    const files = {
      'atlas.bin': receipt(asBytes(atlas), dir, 'atlas.bin'),
      'albedo.bc7.bin': texture.reusedFiles ? texture.reusedFiles['albedo.bc7.bin'] : receipt(texture.bc7, dir, 'albedo.bc7.bin'),
      'albedo.astc.bin': texture.reusedFiles ? texture.reusedFiles['albedo.astc.bin'] : receipt(texture.astc, dir, 'albedo.astc.bin'),
    };
    fs.writeFileSync(path.join(dir, 'body.glb'), standIn.bytes);
    // The streams of the format before this one, which nothing reads now.
    for (const old of ['vertices.bin.gz', 'indices.bin.gz', 'clusters.bin.gz', 'chain.bin.gz']) fs.rmSync(path.join(dir, old), { force: true });
    const manifest = {
      format: CREW_CONTINUUM_FORMAT, version: CREW_CONTINUUM_VERSION, id: entry.id, sex: entry.sex, role: entry.role, generator: 'scripts/prepare-crew-continuum.mjs',
      source: { file: path.basename(file), sha256: fit.sha256, vertices: fitCount, triangles: fit.index.length / 3 },
      atlas: { words: atlas.length, headerWords: CONTINUUM_HEADER_WORDS, bytes: atlas.byteLength, sha256: files['atlas.bin'].sha256, gzip: files['atlas.bin'].gzip },
      pieces: CREW_CONTINUUM_PIECES, regions: CREW_CONTINUUM_REGIONS, regionMedians: surface.medians,
      rig: { joints: CREW_JOINT_COUNT, slack: +slack.toFixed(5), pieceSlack: Object.fromEntries(CREW_CONTINUUM_PIECES.map((name, p) => [name, +pieceSlack[p].toFixed(4)])), leads: leadOf.map((j) => CREW_JOINT_NAMES[j]), spheres },
      clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootError: +clusters.rootError.toFixed(4), pieceCopies: body.copies },
      chain: { ...farBody.stats, farSourceTriangles: far.triangles, farSourceError: +sourceError.toFixed(4), posedDelta: +posedDelta.toFixed(4) },
      splat,
      texture: { width: texture.levels.width, height: texture.levels.height, coverage: texture.levels.coverage, delightVersion: DELIGHT_VERSION, levels: texture.levels.levels },
      body: { file: 'body.glb', bytes: standIn.bytes.length, sha256: createHash('sha256').update(standIn.bytes).digest('hex'), triangles: standIn.triangles, vertices: standIn.vertices, contactDrift: drift },
      poses: palettes.length, files, bakeSeconds: +((Date.now() - started) / 1000).toFixed(1),
    };
    if (Object.keys(files).join() !== CREW_CONTINUUM_STREAMS.join()) throw Error('The streams written are not those the format names');
    validateCrewContinuumManifest(manifest);
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
    const gz = Object.values(files).reduce((s, f) => s + f.gzip.bytes, 0);
    console.log(`  ${clusters.count} clusters (${clusters.finestTriangles} triangles, ${clusters.levels} levels, ${clusters.roots} roots, root error ${manifest.clusters.rootError} m) · far body ${farBody.stats.baseTriangles} → ${farBody.stats.coreTriangles} triangles in ${farBody.stats.steps} steps, handoff at ${farBody.farFirst} · slack ${slack.toFixed(3)} m · ${(gz / 1048576).toFixed(1)} MiB gzipped · ${manifest.bakeSeconds} s`);
    console.log('  contact drift', drift, 'piece slack', manifest.rig.pieceSlack);
    return manifest;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await MeshoptSimplifier.ready;
const started = Date.now();
for (const entry of CREW_CONTINUUM_BODIES) {
  if (ONLY && !ONLY.split(',').includes(entry.id)) continue;
  await bake(entry);
}
if (args.includes('--sync-all')) {
  for (const entry of CREW_CONTINUUM_BODIES) {
    if (entry.id === 'sailor-male' || entry.id === 'villager-female') continue;
    const srcId = entry.sex === 'female' ? 'villager-female' : 'sailor-male';
    const srcDir = path.join(OUT, srcId);
    const dstDir = path.join(OUT, entry.id);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const file of ['body.glb', ...CREW_CONTINUUM_STREAMS.map((s) => `${s}.gz`)]) {
      fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
    manifest.id = entry.id;
    manifest.sex = entry.sex;
    manifest.role = entry.role;
    validateCrewContinuumManifest(manifest);
    fs.writeFileSync(path.join(dstDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
    console.log(`  synced ${srcId} -> ${entry.id}`);
  }
}
console.log(`baked in ${((Date.now() - started) / 1000).toFixed(0)} s`);
