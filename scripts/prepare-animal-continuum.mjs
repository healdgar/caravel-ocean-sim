#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes every animal into the animal continuum (AGENTS.md rule 3; js/animal-continuum.js) by the one bake
// (js/continuum-bake.js bakeContinuumBody) into one atlas of the one format (js/continuum-format.js).
//   node scripts/prepare-animal-continuum.mjs [--out=assets/animal-continuum]
// Each type comes from the mesh its builder makes, jointed as its family's pass poses it (js/wgsl/herds.js for the
// herds' beasts and road vehicles, js/wgsl/dolphins.js for the sea), every corner skinned to up to four joints:
//   clusters   a cluster hierarchy cut on the GPU by projected error. A beast's body, neck, each leg, its tail and its
//              tack, a vehicle's every shard, a sea animal's every stretch of spine, the whale's every bone's flesh, are
//              clustered apart, so no simplified triangle spans two; each cluster rides its piece's leading joint.
//              Each group's error is measured posed: every point it removes is matched at rest to its nearest kept
//              point of the same piece, and the error is the farthest the two come apart in any pose the rig takes.
//   far body   the one bake's: the outside wrapped (a horse's tack left out), simplified and collapsed. Each of its
//              points wears the skin of the source corner nearest it; each step's error is raised by how much farther
//              apart the far body and the source come posed than at rest.
//   rig        each joint's sphere at rest, and the pose slack: the farthest any point comes, in any pose, from where
//              its cluster's leading joint alone would carry it.
// One atlas holds them all, gzipped beside a manifest with its receipt, each type's rig and its source digest.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { getLivestockMeshes, getVehicleMeshes } from '../js/models/livestock-meshes.js';
import { createDolphinMesh } from '../js/dolphin-mesh.js';
import { createMarineMesh } from '../js/marine-mesh.js';
import { loadMarineGLB } from '../js/marine-asset.js';
import { createMarineRig, MARINE_SWIM_PERIOD } from '../js/marine-rig.js';
import {
  ANIMAL_CONTINUUM_FORMAT, ANIMAL_CONTINUUM_VERSION, ANIMAL_CONTINUUM_TYPES, ANIMAL_FAMILY, ANIMAL_FAMILY_JOINTS, ANIMAL_JOINT, ANIMAL_SEA_STATIONS,
  ANIMAL_CONTINUUM_GRAZE_PITCH, ANIMAL_CONTINUUM_ASSETS, validateAnimalContinuumManifest,
} from '../js/animal-continuum.js';
import { CONTINUUM_STEP_WORDS } from '../js/continuum-core.js';
import { CONTINUUM_HEADER_WORDS, assembleContinuumAtlas, checkContinuumAtlas, continuumFloatWord, packContinuumBody, packContinuumUV } from '../js/continuum-format.js';
import { bakeContinuumBody, closest, triangleGrid, posedGroupError } from '../js/continuum-bake.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = path.resolve(ROOT, option('out', path.dirname(ANIMAL_CONTINUUM_ASSETS['manifest.json'])));
// What every sphere is grown by past what it must hold, for the quantization of the points it bounds.
const SPHERE_MARGIN = 0.005;

// ------------------------------------------------------------------------------------------------ joints
// An affine joint, as js/wgsl/skinned-pose.js writes it: twelve numbers, three rows of (x, y, z, translation).
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const translate = ([x, y, z]) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const scaleBy = ([x, y, z]) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0];
const gather = ([x, y, z]) => [0, 0, 0, x, 0, 0, 0, y, 0, 0, 0, z];
const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]; };
const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]; };
const rotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]; };
// a after b.
const then = (a, b) => {
  const out = new Array(12);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
  return out;
};
const about = (pivot, m) => then(translate(pivot), then(m, translate(pivot.map((v) => -v))));
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// js/wgsl/herds.js herdJoints: a herd beast's joints in one pose, before its scale, slope and yaw.
function livestockJoints(rig, { walkPhase = 0, walkAmp = 0, graze = 0, tail = 0, tack = true, felled = false, hitAge = 0, hitAngle = 0 }) {
  const { neck, legs } = rig, fall = smooth(0, 0.38, hitAge), nibble = 0.055 * Math.sin(tail * 3.4) * Math.max(0, graze);
  const neckJoint = about(neck.slice(0, 3), then(rotY(felled ? 0 : 0.14 * Math.sin(tail * 0.73) * graze), rotX(felled ? 0.26 : graze * neck[3] + nibble)));
  const joints = [identity(), neckJoint];
  const feet = [];
  for (let leg = 2; leg <= 5; leg++) {
    const beat = [0, 0, 0, Math.PI, 4.71238898, 1.57079633][leg], piv = [0, legs[0], leg <= 3 ? legs[1] : legs[2]];
    if (felled) {
      const m = about(piv, then(scaleBy([1, 1 - 0.42 * fall, 1]), rotX((leg <= 3 ? 0.72 : -0.72) * fall)));
      joints.push(m); feet.push(m);
    } else {
      const ph = walkPhase + beat, m = about(piv, rotX(Math.sin(ph) * 0.36 * walkAmp));
      joints.push(m); feet.push(then(translate([0, Math.max(0, Math.cos(ph)) * 0.045 * walkAmp, 0]), m));
    }
  }
  joints.push(...feet);
  joints.push(about([0, legs[0] * 1.15, legs[2] - 0.18], rotZ(felled ? 0 : 0.18 * Math.sin(tail * 2.1))));
  const hidden = gather([0, legs[0], 0]);
  joints.push(tack ? identity() : hidden, tack ? neckJoint : hidden);
  let global = identity();
  if (felled) {
    const barrelY = legs[0] * 1.05, flank = 0.28 * legs[0] + 0.08, hop = hitAge < 0.36 ? Math.sin((hitAge / 0.36) * Math.PI) * 0.16 : 0;
    global = then(translate([0, -(barrelY - flank) * fall + hop, 0]), about([0, barrelY, 0], rotZ((Math.sin(hitAngle) >= 0 ? 1 : -1) * 1.5707963 * fall)));
  } else global = translate([0, 0.014 * Math.abs(Math.sin(walkPhase)) * walkAmp, 0]);
  return joints.map((m) => then(global, m));
}
// A road vehicle's joints, a shard each: standing, its wheels turned and its pole swung; shattered, each shard in flight.
function vehicleJoints(rig, { walkPhase = 0, walkAmp = 0, graze = 0, tail = 0, shattered = false, hitAge = 0, hitAngle = 0, coatSeed = 0 }) {
  const { neck, legs } = rig, joints = [];
  const fract = (x) => x - Math.floor(x);
  for (let shard = 0; shard < ANIMAL_FAMILY_JOINTS[ANIMAL_FAMILY.vehicle]; shard++) {
    const wheel = shard < 4, pole = shard === 4;
    if (!shattered) {
      const bob = translate([0, 0.005 * Math.abs(Math.sin(walkPhase * 2.7)) * walkAmp, 0]);
      if (wheel) { const front = (shard & 2) !== 0, r = Math.max(0.2, front ? neck[0] : legs[0]); joints.push(then(bob, about([0, r, front ? legs[1] : legs[2]], rotX(walkPhase / r)))); }
      else if (pole) joints.push(then(bob, about([0, neck[1], neck[2]], then(rotY(graze), rotX(tail)))));
      else joints.push(bob);
      continue;
    }
    const h0 = fract(Math.sin(shard * 12.9898 + coatSeed * 78.233) * 43758.5453), h1 = fract(Math.sin(shard * 39.3467 + coatSeed * 19.19) * 24634.6345);
    let piv;
    if (pole) piv = [0, neck[1] + 0.24, 2.75];
    else if (wheel) { const front = (shard & 2) !== 0; piv = [shard & 1 ? 0.86 : -0.86, Math.max(0.2, front ? neck[0] : legs[0]), front ? legs[1] : legs[2]]; }
    else piv = [shard & 1 ? 0.44 : -0.44, shard & 4 ? 1.46 : 0.92, shard & 2 ? 0.68 : -0.68];
    const hit = [Math.sin(hitAngle), Math.cos(hitAngle)], flat = Math.hypot(piv[0], piv[2]);
    const radial = flat > 0.08 ? [piv[0] / flat, piv[2] / flat] : [h0 - 0.5, h1 - 0.5];
    const d = [radial[0] * 0.72 + hit[0] * 0.68 + 1e-4, radial[1] * 0.72 + hit[1] * 0.68], dl = Math.hypot(...d), dir = [d[0] / dl, d[1] / dl];
    const speed = (2.7 + 3.9 * h0) * (wheel ? 1.25 : 1), vy0 = 2.9 + 3.3 * h1, g = 9.81;
    const drop = Math.max(0.05, piv[1] - (wheel || pole ? 0.08 : 0.14)), impact = (vy0 + Math.sqrt(vy0 * vy0 + 2 * g * drop)) / g;
    const fly = Math.min(hitAge, impact), ground = Math.max(0, hitAge - impact), slide = ground > 0 ? (1 - Math.exp(-ground * 4.5)) * 0.18 : 0;
    let dy = vy0 * fly - 0.5 * g * fly * fly;
    if (hitAge >= impact) dy = -drop + (ground < 0.34 ? Math.sin((ground / 0.34) * Math.PI) * 0.22 * (0.5 + 0.5 * h1) : 0);
    const spin = fly + slide * 0.5, spinX = (2.4 + 3.5 * h0) * spin * (h1 < 0.5 ? -1 : 1);
    const tilt = smooth(impact * 0.7, impact + 0.25, hitAge), spinZ = (1.8 + 2.8 * h1) * spin * (1 - tilt) + (piv[0] >= 0 ? 1.46 : -1.46) * tilt;
    joints.push(then(translate([dir[0] * speed * (fly + slide), dy, dir[1] * speed * (fly + slide)]), about(piv, then(rotZ(spinZ), rotX(spinX)))));
  }
  return joints;
}
// js/wgsl/dolphins.js seaJoints: a dolphin's or shark's spine, its stations bent by the stroke's beat. `spine` is
// the first station's z, how far the bend runs and how far the stations reach along it (dolphin) or 1 (shark).
const SEA_STROKE = Object.freeze({ dolphin: { start: 0.25, run: 1.35, amplitude: 0.24, axis: 'y' }, shark: { start: 0.15, run: 2.4, amplitude: 0.42, axis: 'x' } });
function seaJoints(stroke, reach, beat) {
  const { start, run, amplitude, axis } = SEA_STROKE[stroke], joints = [];
  for (let k = 0; k < ANIMAL_SEA_STATIONS; k++) {
    const t = (k / (ANIMAL_SEA_STATIONS - 1)) * reach, z = start + run * t, bend = beat * amplitude * t * t, slope = Math.atan((beat * amplitude * 2 * t) / run);
    joints.push(axis === 'y' ? then(translate([0, bend, 0]), about([0, 0, z], rotX(-slope))) : then(translate([bend, 0, 0]), about([0, 0, z], rotY(slope))));
  }
  return joints;
}
// Where a sea animal's point lies along its spine (0 at the first station; the shark's stops at 1).
const seaSpine = (stroke, z) => { const { start, run } = SEA_STROKE[stroke]; const t = Math.max(0, (z - start) / run); return stroke === 'shark' ? Math.min(1, t) : t; };

// Up to four joints and their weights (summing to 1) as the skin stream's two words: four joint bytes, four unorm
// weights summing to 255.
function packSkin(influences) {
  const list = influences.filter(([, w]) => w > 1e-6).sort((a, b) => b[1] - a[1]).slice(0, 4), sum = list.reduce((s, [, w]) => s + w, 0) || 1;
  const q = list.map(([, w]) => Math.round((w / sum) * 255));
  q[0] += 255 - q.reduce((s, x) => s + x, 0);
  let joints = 0, weights = 0;
  list.forEach(([j, ], k) => { if (j > 255) throw Error('A joint past a byte'); joints |= j << (k * 8); weights |= q[k] << (k * 8); });
  return [joints >>> 0, weights >>> 0];
}
const unpackSkin = ([joints, weights]) => [0, 1, 2, 3].map((k) => [(joints >>> (k * 8)) & 255, ((weights >>> (k * 8)) & 255) / 255]).filter(([, w]) => w > 0);

// A point posed by its skin and a pose's joints.
function posePoint(joints, skin, x, y, z, out, at) {
  let wx = 0, wy = 0, wz = 0, sum = 0;
  for (const [j, w] of skin) {
    const m = joints[j];
    wx += w * (m[0] * x + m[1] * y + m[2] * z + m[3]); wy += w * (m[4] * x + m[5] * y + m[6] * z + m[7]); wz += w * (m[8] * x + m[9] * y + m[10] * z + m[11]);
    sum += w;
  }
  out[at] = wx / sum; out[at + 1] = wy / sum; out[at + 2] = wz / sum;
}
const posedSet = (P, skins, joints) => { const out = new Float32Array(P.length); for (let v = 0; v < P.length / 3; v++) posePoint(joints, skins[v], P[v * 3], P[v * 3 + 1], P[v * 3 + 2], out, v * 3); return out; };

// ------------------------------------------------------------------------------------------------ the sources
// A herd beast's piece, by its rig's part: body, neck, each leg, tail, saddle, bridle.
function herdSegment(part) {
  if (part < 1) return 0;
  if (part < 1.995) return 1;
  if (part < 5.5) return Math.round(part);
  if (part < 8.5) return 6;
  return part >= 9.95 && part < 11 ? 10 : 9;
}
// A herd beast's skin, from its rig's part and its height at rest.
function livestockSkin(part, y, legY) {
  const J = ANIMAL_JOINT;
  if (part < 1) return [[J.body, 1]];
  if (part < 1.995) { const w = smooth(0, 1, clamp01(part - 1)); return [[J.body, 1 - w], [J.neck, w]]; }
  if (part < 5.5) { const leg = Math.round(part), f = clamp01(1 - y / Math.max(0.2, legY)); return [[J.leg + leg - 2, 1 - f], [J.foot + leg - 2, f]]; }
  if (part < 8.5) return [[J.tail, 1]];
  if (part >= 9.95 && part < 11) { const w = smooth(0, 1, clamp01(part - 10)); return [[J.saddle, 1 - w], [J.bridle, w]]; }
  return [[J.saddle, 1]];
}
// The pieces a road vehicle breaks into (the shard each corner flies with): each connected piece of its mesh, a
// wheel by its side and axle, the pole, and the body's pieces by octant in three sets.
function vehicleShards(mesh) {
  const F = mesh.vertices, V = F.length / 8, parent = Int32Array.from({ length: V }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const at = new Map();
  for (let i = 0; i < V; i++) {
    const key = `${Math.round(F[i * 8] * 200)},${Math.round(F[i * 8 + 1] * 200)},${Math.round(F[i * 8 + 2] * 200)},${Math.round(F[i * 8 + 6] * 10)}`;
    if (at.has(key)) union(i, at.get(key)); else at.set(key, i);
  }
  for (let t = 0; t < mesh.indices.length; t += 3) { union(mesh.indices[t], mesh.indices[t + 1]); union(mesh.indices[t], mesh.indices[t + 2]); }
  const middle = 0.5 * (mesh.frontZ + mesh.backZ), pieces = new Map();
  for (let i = 0; i < V; i++) {
    const r = find(i);
    if (!pieces.has(r)) pieces.set(r, { x: 0, y: 0, z: 0, n: 0, part: F[i * 8 + 6] });
    const piece = pieces.get(r); piece.x += F[i * 8]; piece.y += F[i * 8 + 1]; piece.z += F[i * 8 + 2]; piece.n++;
  }
  let serial = 0;
  for (const piece of pieces.values()) {
    const x = piece.x / piece.n, y = piece.y / piece.n, z = piece.z / piece.n, part = Math.round(piece.part);
    piece.shard = part === 7 ? (x >= 0 ? 1 : 0) | (z > middle ? 2 : 0) : part === 8 ? 4 : 8 + ((x >= 0 ? 1 : 0) | (z >= 0 ? 2 : 0) | (y >= 1.25 ? 4 : 0)) + (serial++ % 3) * 8;
  }
  return Uint32Array.from({ length: V }, (_, i) => pieces.get(find(i)).shard);
}

// A body as the one bake reads it: eight floats a corner (position, normal, and the two the family's material wears),
// each triangle's piece, each corner's source vertex. `kept(t)` leaves a triangle out of the far body's wrap.
function bakeSource(name, indices, corner, pieceOf, kept = null) {
  const T = indices.length / 3, vertices = new Float32Array(T * 24), parts = new Uint32Array(T), corners = new Uint32Array(T * 3);
  for (let t = 0; t < T; t++) {
    const c = [0, 1, 2].map((k) => indices[t * 3 + k]), pieces = c.map(pieceOf);
    parts[t] = pieces[0] === pieces[1] || pieces[0] === pieces[2] ? pieces[0] : pieces[1] === pieces[2] ? pieces[1] : pieces[0];
    c.forEach((v, k) => { vertices.set(corner(v), (t * 3 + k) * 8); corners[t * 3 + k] = v; });
  }
  const body = { name, vertices, triangles: T, parts, corners };
  if (kept) {
    const list = [];
    for (let t = 0; t < T; t++) if (kept(t)) list.push(t);
    const fv = new Float32Array(list.length * 24);
    list.forEach((t, i) => fv.set(vertices.subarray(t * 24, t * 24 + 24), i * 24));
    body.far = { name: `${name} far`, vertices: fv, triangles: list.length, parts: new Uint32Array(list.length) };
  }
  return body;
}
// A colour's three bytes as one number a float holds exactly, and as the word a far triangle or point wears.
const colour24 = ([r, g, b]) => [r, g, b].reduce((n, c) => n * 256 + Math.max(0, Math.min(255, Math.round(c * 255))), 0);
// A texture place in one number a float holds exactly (12 bits a coordinate), and back.
const place24 = (u, v) => Math.round(clamp01(u) * 4095) + 4096 * Math.round(clamp01(v) * 4095);
const placeOf = (n) => [(n % 4096) / 4095, Math.floor(n / 4096) / 4095];
// What a corner wears rides the bake as its two kind floats, which the clusters' simplifier also weighs beside the
// normal: each is kept below 1 by a power of two (so exactly), weighing no more than a texture place would.
const KIND_COAT = 2 ** -16, KIND_WORD = 2 ** -24;

function herdType(id, mesh) {
  const vehicle = id >= 4, F = mesh.vertices, uvs = !vehicle && mesh.uvs ? mesh.uvs : null, shards = vehicle ? vehicleShards(mesh) : null;
  const rig = { neck: [...mesh.neckPivot, ANIMAL_CONTINUUM_GRAZE_PITCH[id]], legs: [mesh.legY, mesh.frontZ, mesh.backZ, mesh.height] };
  const skinOf = (v) => (vehicle ? [[shards[v], 1]] : livestockSkin(F[v * 8 + 6], F[v * 8 + 1], mesh.legY));
  // The coat (zone + its shade, or 16 + RGB555) plus real Tripo UV place in kind[1] for livestock.
  const body = bakeSource(ANIMAL_CONTINUUM_TYPES[id], mesh.indices, (v) => [
      ...F.subarray(v * 8, v * 8 + 6),
      F[v * 8 + 7] * KIND_COAT,
      uvs ? place24(uvs[v * 2], uvs[v * 2 + 1]) * KIND_WORD : 0,
    ],
    (v) => (vehicle ? shards[v] : herdSegment(F[v * 8 + 6])),
    // A horse's tack is left out of its far body: it lies over the coat, a few centimetres proud, and a beast without it hides it.
    vehicle ? null : (t) => [0, 1, 2].some((k) => F[mesh.indices[t * 3 + k] * 8 + 6] < 8.5));
  // Feed true 2D UV coordinates directly to MeshoptSimplifier so cluster collapses preserve UV seams & texture fidelity.
  if (uvs) {
    body.uv = (welded) => {
      const out = new Float32Array(welded.count * 2);
      for (let w = 0; w < welded.count; w++) {
        const src = welded.corner[w];
        out[w * 2] = uvs[src * 2];
        out[w * 2 + 1] = uvs[src * 2 + 1];
      }
      return out;
    };
  }
  // The coat's linear colour where it is textured (16 + RGB555), for the splat.
  const colourOf = (v) => {
    const coat = F[v * 8 + 7];
    if (coat < 16) return null;
    const rgb = Math.round(coat - 16);
    return [(rgb >> 10) & 31, (rgb >> 5) & 31, rgb & 31].map((c) => (c / 31) ** 2);
  };
  const poses = [];
  if (vehicle) {
    for (let k = 0; k < 32; k++) poses.push({ walkPhase: k * 0.2, walkAmp: 1 });
    for (const graze of [-0.56, 0, 0.56]) for (const tail of [-0.34, 0, 0.34]) poses.push({ walkPhase: 0.3, walkAmp: 1, graze, tail });
  } else {
    for (const walkPhase of [0, Math.PI / 2, Math.PI, 1.5 * Math.PI]) for (const graze of [0, -0.28]) poses.push({ walkPhase, walkAmp: 1, graze, tail: 0 });
    for (const graze of [0.5, 1]) for (const tail of [2.15, -2.15, 0.462, -0.462]) poses.push({ walkPhase: 0, walkAmp: 0, graze, tail });
    for (const walkPhase of [Math.PI / 2, 1.5 * Math.PI]) poses.push({ walkPhase, walkAmp: 0.45, graze: 0.6, tail: 2.15 });
    for (const hitAge of [0.12, 0.2, 0.3, 1]) for (const hitAngle of [Math.PI / 2, -Math.PI / 2]) poses.push({ felled: true, hitAge, hitAngle });
  }
  const jointsOf = vehicle ? (p) => vehicleJoints(rig, p) : (p) => livestockJoints(rig, p);
  return {
    id, family: vehicle ? 'vehicle' : 'livestock', rig, body, skinOf, colourOf, poses: poses.map(jointsOf), felled: poses.map((p) => !!p.felled),
    wordOf: (kind) => continuumFloatWord(kind[0] / KIND_COAT),
    ...(uvs ? { uvOf: (kind) => packContinuumUV(placeOf(Math.round(kind[1] / KIND_WORD))) } : {}),
    sourceTriangles: mesh.indices.length / 3,
    sourceBytes: [F, ...(uvs ? [uvs] : []), mesh.indices, Float32Array.from([...rig.neck, ...rig.legs])],
  };
}
function seaType(id, stroke, mesh) {
  const F = mesh.vertices, V = F.length / 9, station = (v) => seaSpine(stroke, F[v * 9 + 2]);
  let reach = 0;
  for (let v = 0; v < V; v++) reach = Math.max(reach, station(v));
  reach = Math.max(reach, 1e-3);
  const skinOf = (v) => {
    const s = (station(v) / reach) * (ANIMAL_SEA_STATIONS - 1), k = Math.min(Math.floor(s), ANIMAL_SEA_STATIONS - 2), f = s - k;
    return [[k, 1 - f], [k + 1, f]];
  };
  const body = bakeSource(stroke, Array.from(mesh.indices), (v) => [...F.subarray(v * 9, v * 9 + 6), colour24(F.subarray(v * 9 + 6, v * 9 + 9)) * KIND_WORD, 0],
    (v) => Math.round((station(v) / reach) * (ANIMAL_SEA_STATIONS - 1)));
  const poses = [-1, -0.5, 0, 0.5, 1].map((beat) => seaJoints(stroke, reach, beat));
  return {
    id, family: 'sea', rig: { neck: [0, 0, 0, 0], legs: [0, 0, 0, 0], spine: reach }, body, skinOf, colourOf: (v) => Array.from(F.subarray(v * 9 + 6, v * 9 + 9)), poses,
    wordOf: (kind) => Math.round(kind[0] / KIND_WORD) >>> 0, sourceTriangles: mesh.indices.length / 3, sourceBytes: [F, mesh.indices],
  };
}
function whaleType(id) {
  const bytes = fs.readFileSync(path.join(ROOT, 'assets/wildlife/whale.glb')), model = loadMarineGLB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const F = model.vertices, { joints, weights } = model.skin, rig = createMarineRig(model), J = ANIMAL_FAMILY_JOINTS[ANIMAL_FAMILY.whale];
  if (Math.max(...joints) >= J) throw Error(`The whale has more than ${J} joints`);
  const skinOf = (v) => [0, 1, 2, 3].map((k) => [joints[v * 4 + k], weights[v * 4 + k]]).filter(([, w]) => w > 0);
  const lead = (v) => skinOf(v).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const body = bakeSource('whale', Array.from(model.indices), (v) => [...F.subarray(v * 11, v * 11 + 6), colour24(F.subarray(v * 11 + 6, v * 11 + 9)) * KIND_WORD, place24(F[v * 11 + 9], F[v * 11 + 10]) * KIND_WORD], lead);
  // Its rig's bones in each pose, as rows.
  const rows = (palette) => Array.from({ length: J }, (_, j) => { const m = palette.subarray(j * 16, j * 16 + 16); return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]]; });
  const poses = [rows(Float32Array.from(rig.update(0, 0)))];
  for (let k = 0; k < 8; k++) poses.push(rows(Float32Array.from(rig.update((k / 8) * MARINE_SWIM_PERIOD, 1))));
  rig.update(0, 0);
  return {
    id, family: 'whale', rig: { neck: [0, 0, 0, 0], legs: [0, 0, 0, 0] }, body, skinOf, colourOf: (v) => Array.from(F.subarray(v * 11 + 6, v * 11 + 9)), poses,
    wordOf: (kind) => Math.round(kind[0] / KIND_WORD) >>> 0, uvOf: (kind) => packContinuumUV(placeOf(Math.round(kind[1] / KIND_WORD))),
    sourceTriangles: model.indices.length / 3, sourceBytes: [F, model.indices, joints, weights],
  };
}

// ------------------------------------------------------------------------------------------------ main
const asBytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function bake(type) {
  const t0 = Date.now(), { body } = type;
  // Each welded vertex's skin is its source corner's; its posed places in every pose, for the clusters' error.
  let weldedSkins = null;
  body.groupError = (welded) => {
    weldedSkins = Array.from(welded.corner, (v) => unpackSkin(packSkin(type.skinOf(v))));
    return posedGroupError(welded, type.poses.map((joints) => posedSet(welded.position, weldedSkins, joints)));
  };
  const baked = await bakeContinuumBody(body), { welded, clusters, far } = baked;
  // Each piece rides its leading joint: the one its points weigh most on.
  const weigh = new Map();
  for (let v = 0; v < welded.count; v++) {
    if (!weigh.has(welded.part[v])) weigh.set(welded.part[v], new Map());
    const tally = weigh.get(welded.part[v]);
    for (const [j, w] of weldedSkins[v]) tally.set(j, (tally.get(j) ?? 0) + w);
  }
  const leadOf = new Map([...weigh].map(([piece, tally]) => [piece, [...tally].sort((a, b) => b[1] - a[1])[0][0]]));
  const pieceOfCluster = clusters.records.map((record) => record.part);
  for (const record of clusters.records) record.part = leadOf.get(record.part);
  // Each far point wears the skin of the source corner nearest it (the far body's own source: a horse without its tack).
  const tack = (v) => body.far && welded.part[v] >= 9, farSource = body.far ? (t) => !tack(welded.index[t * 3]) : null;
  const V = far.position.length / 3, farSkins = [], farNearest = new Uint32Array(V), toSource = triangleGrid(welded.position, welded.index, 0.25);
  let bodyJoint = Infinity;
  if (type.family === 'vehicle') for (const skin of weldedSkins) for (const [j] of skin) if (j >= 8) bodyJoint = Math.min(bodyJoint, j);
  for (let i = 0; i < V; i++) {
    const t = toSource(far.position[i * 3], far.position[i * 3 + 1], far.position[i * 3 + 2], farSource), w = [1 - closest[1] - closest[2], closest[1], closest[2]];
    farNearest[i] = welded.index[t * 3 + w.indexOf(Math.max(...w))];
    let skin = weldedSkins[farNearest[i]];
    // A far wheel is a disc whose turning cannot be seen: it rides the body, so no far triangle between a wheel and
    // the bed it stands beside is stretched by the turn (a shattered vehicle has no far body).
    if (type.family === 'vehicle' && skin[0][0] < 4) skin = [[bodyJoint, 1]];
    farSkins.push(unpackSkin(packSkin(skin)));
  }
  // The pose slack: how far any cluster point comes from where its cluster's leading joint alone would carry it.
  const leadOfVertex = new Int32Array(welded.count).fill(-1);
  clusters.records.forEach((record) => { for (let i = record.first; i < record.first + record.triangles * 3; i++) leadOfVertex[clusters.order[clusters.indices[i]]] = record.part; });
  let slack = 0;
  const posedWelded = type.poses.map((joints) => posedSet(welded.position, weldedSkins, joints)), alone = new Float32Array(3);
  type.poses.forEach((joints, k) => {
    for (let v = 0; v < welded.count; v++) {
      if (leadOfVertex[v] < 0) continue;
      posePoint(joints, [[leadOfVertex[v], 1]], welded.position[v * 3], welded.position[v * 3 + 1], welded.position[v * 3 + 2], alone, 0);
      const X = posedWelded[k];
      slack = Math.max(slack, Math.hypot(X[v * 3] - alone[0], X[v * 3 + 1] - alone[1], X[v * 3 + 2] - alone[2]));
    }
  });
  slack += SPHERE_MARGIN;
  // The far body posed: how much farther it and the source come apart than at rest, which every step's error takes.
  const restFar = far.position, restGap = new Float32Array(V), sourceGap = new Float32Array(welded.count);
  {
    const toFar = triangleGrid(restFar, far.index, 0.25);
    for (let i = 0; i < V; i++) { toSource(restFar[i * 3], restFar[i * 3 + 1], restFar[i * 3 + 2], farSource); restGap[i] = Math.sqrt(closest[0]); }
    for (let v = 0; v < welded.count; v++) { toFar(welded.position[v * 3], welded.position[v * 3 + 1], welded.position[v * 3 + 2]); sourceGap[v] = Math.sqrt(closest[0]); }
  }
  // Felled or shattered, a beast or vehicle is cut whole as clusters (EXACT, SHATTERED): only the poses it stands in
  // are asked of its far body.
  let posedDelta = 0;
  type.poses.forEach((joints, k) => {
    if (type.felled?.[k]) return;
    const X = posedWelded[k], Y = posedSet(restFar, farSkins, joints), toX = triangleGrid(X, welded.index, 0.25), toY = triangleGrid(Y, far.index, 0.25);
    for (let i = 0; i < V; i++) { toX(Y[i * 3], Y[i * 3 + 1], Y[i * 3 + 2], farSource); posedDelta = Math.max(posedDelta, Math.sqrt(closest[0]) - restGap[i]); }
    for (let v = 0; v < welded.count; v++) { if (tack(v)) continue; toY(X[v * 3], X[v * 3 + 1], X[v * 3 + 2]); posedDelta = Math.max(posedDelta, Math.sqrt(closest[0]) - sourceGap[v]); }
  });
  const stepFloats = new Float32Array(far.steps.buffer, far.steps.byteOffset, far.steps.length);
  for (let s = 0; s < far.steps.length / CONTINUUM_STEP_WORDS; s++) stepFloats[s * CONTINUUM_STEP_WORDS + 1] += posedDelta;
  // Each joint's sphere at rest: every cluster and far point it carries, grown by the far body's inflation.
  const J = ANIMAL_FAMILY_JOINTS[ANIMAL_FAMILY[type.family]], members = Array.from({ length: J }, () => []);
  for (let v = 0; v < welded.count; v++) for (const [j] of weldedSkins[v]) members[j].push(welded.position.subarray(v * 3, v * 3 + 3));
  for (let i = 0; i < V; i++) for (const [j] of farSkins[i]) members[j].push(far.position.subarray(i * 3, i * 3 + 3));
  const spheres = members.map((points) => {
    if (!points.length) return [0, 0, 0, -1];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const centre = lo.map((v, k) => (v + hi[k]) / 2);
    let radius = 0;
    for (const p of points) radius = Math.max(radius, Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]));
    return [...centre.map((v) => +v.toFixed(5)), +(radius + far.stats.inflateMax + SPHERE_MARGIN).toFixed(5)];
  });
  // A sea animal's splat stands about its whole body (the bake's stands on a floor at 0, as a beast on the ground).
  let splat = far.splat;
  if (type.family === 'sea' || type.family === 'whale') {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < welded.count; v++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], welded.position[v * 3 + k]); hi[k] = Math.max(hi[k], welded.position[v * 3 + k]); }
    const half = hi.map((v, k) => (v - lo[k]) / 2);
    splat = { ...far.splat, centre: lo.map((v, k) => +(v + half[k]).toFixed(4)), ry: +(half[1] * 0.85).toFixed(4), rx: +(0.5 * (half[0] + half[2]) * 0.85).toFixed(4) };
  }
  // The splat's colour: the area-weighted mean of the source's (-1 for a beast coated by zones).
  let sum = [0, 0, 0], weight = 0, untextured = 0;
  const T = body.triangles;
  for (let t = 0; t < T; t++) {
    const c = [0, 1, 2].map((k) => body.corners[t * 3 + k]), P = (v) => body.vertices.subarray(v * 8, v * 8 + 3);
    const [a, b, d] = [0, 1, 2].map((k) => P(t * 3 + k)), e = [0, 1, 2].map((k) => b[k] - a[k]), f = [0, 1, 2].map((k) => d[k] - a[k]);
    const area = Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]) / 2, colours = c.map(type.colourOf);
    if (colours.some((x) => !x)) { untextured += area; continue; }
    for (const x of colours) for (let k = 0; k < 3; k++) sum[k] += (area / 3) * x[k];
    weight += area;
  }
  const colour = weight > untextured ? sum.map((v) => v / weight) : [-1, -1, -1];
  // The whale's far points wear the texture place of the source corner nearest them, as its clusters' points do.
  const uvAt = (v) => [type.uvOf([welded.kind[v * 2], welded.kind[v * 2 + 1]])];
  const words = packContinuumBody({
    triangles: body.triangles, splat,
    material: [ANIMAL_FAMILY[type.family], continuumFloatWord(type.rig.legs[3]), ...colour.map(continuumFloatWord)],
    vertex: (v) => ({ word: type.wordOf([welded.kind[v * 2], welded.kind[v * 2 + 1]]) }),
    farWord: (t) => type.wordOf([far.kinds[t * 2], far.kinds[t * 2 + 1]]),
    streams: { skin: (v) => packSkin(weldedSkins[v]), ...(type.uvOf ? { uv: uvAt } : {}) },
    farStreams: { skin: (i) => packSkin(farSkins[i]), ...(type.uvOf ? { uv: (i) => uvAt(farNearest[i]) } : {}) },
  }, baked);
  const fingerprint = createHash('sha256');
  for (const typed of type.sourceBytes) fingerprint.update(asBytes(typed));
  const pieces = new Set(pieceOfCluster).size, ms = Date.now() - t0;
  console.log(`${type.id} ${ANIMAL_CONTINUUM_TYPES[type.id].padEnd(8)} ${String(type.sourceTriangles).padStart(5)} tris · ${String(clusters.count).padStart(3)} clusters in ${pieces} pieces, ${clusters.levels} levels, root ${clusters.rootError.toFixed(3)} m · far ${far.stats.baseTriangles} → ${far.stats.coreTriangles} in ${far.stats.steps} steps, posed +${posedDelta.toFixed(3)} m, handoff at ${far.farFirst} · slack ${slack.toFixed(3)} m · ${(ms / 1000).toFixed(1)} s`);
  return {
    words: words.words,
    manifest: {
      id: type.id, name: ANIMAL_CONTINUUM_TYPES[type.id], family: type.family, fingerprint: fingerprint.digest('hex'), sourceTriangles: type.sourceTriangles,
      rig: { neck: type.rig.neck, legs: type.rig.legs, ...(type.rig.spine ? { spine: +type.rig.spine.toFixed(5) } : {}), joints: J, slack: +slack.toFixed(5), spheres },
      clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootError: +clusters.rootError.toFixed(4), pieces },
      chain: { ...far.stats, posedDelta: +posedDelta.toFixed(4) }, splat: { centre: splat.centre, rx: splat.rx, ry: splat.ry, colour: colour.map((v) => +v.toFixed(5)) }, poses: type.poses.length, bakeMs: ms,
    },
  };
}

async function main() {
  const started = Date.now();
  const types = [
    ...[...getLivestockMeshes(), ...getVehicleMeshes()].map((mesh, id) => herdType(id, mesh)),
    seaType(7, 'dolphin', createDolphinMesh()), seaType(8, 'shark', createMarineMesh('shark')), whaleType(9),
  ];
  const baked = [];
  for (const type of types) baked.push(await bake(type));
  const atlas = checkContinuumAtlas(assembleContinuumAtlas(baked.map((b) => b.words)), 'animal');
  fs.mkdirSync(OUT, { recursive: true });
  const bytes = asBytes(atlas), gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(OUT, 'atlas.bin.gz'), gz);
  const manifest = {
    format: ANIMAL_CONTINUUM_FORMAT, version: ANIMAL_CONTINUUM_VERSION, generator: 'scripts/prepare-animal-continuum.mjs',
    totals: { types: types.length, sourceTriangles: types.reduce((n, t) => n + t.sourceTriangles, 0), clusters: baked.reduce((n, b) => n + b.manifest.clusters.count, 0) },
    types: baked.map((b) => b.manifest),
    atlas: { words: atlas.length, headerWords: CONTINUUM_HEADER_WORDS, bytes: bytes.length, sha256: sha256(bytes), gzip: { file: 'atlas.bin.gz', bytes: gz.length, sha256: sha256(gz) } },
    bakeSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  validateAnimalContinuumManifest(manifest);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${types.length} types · ${manifest.totals.clusters} clusters · atlas ${(bytes.length / 1048576).toFixed(2)} MiB, ${(gz.length / 1048576).toFixed(2)} MiB gzipped · ${manifest.bakeSeconds} s`);
}
await main();
