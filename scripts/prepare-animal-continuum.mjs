#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes every animal into the animal continuum (AGENTS.md rule 3; js/animal-continuum.js).
//   node scripts/prepare-animal-continuum.mjs [--out=assets/animal-continuum]
// Each type comes from the mesh its builder makes, with the skin its rig poses it by: the herds' beasts and road
// vehicles (js/models/livestock-meshes.js, posed by js/wgsl/herds.js poseLivestockVertex, mirrored here), the
// dolphin (js/dolphin-mesh.js) and shark (js/marine-life.js) bent by their strokes, and the whale (whale.glb) skinned
// by its rig (js/marine-rig.js).
//   clusters   a cluster hierarchy the GPU cuts by projected error. A beast's body, neck, each leg, its tail and its
//              tack, and each shard a vehicle breaks into, are clustered apart, their seams coarsened alike, so no
//              simplified triangle spans two of them. Each group's error is measured posed: every point it removes is
//              matched at rest to its nearest kept point of the same piece, and the error is the farthest the two
//              come apart in any pose the rig takes (felled too). Every sphere is grown to hold its points in every
//              pose standing (its pose slack); a felled or shattered animal is cut whole at its nearest point.
//   far body   the type's outside wrapped (js/continuum-bake.js wrap), simplified within a cell and
//              collapsed one half-edge at a time to a few triangles. Each of its points wears the skin of the source
//              corner nearest it, so it is posed as the source is; each step's error is measured posed, against the
//              wrap and the wrap's against the source; what a collapse takes off the outline is given back along the
//              normals.
//   splat      one view-facing ellipse with the outline's area seen from the side and from the front, and its colour.
// One atlas holds them all, gzipped beside a manifest with its receipt and each type's source digest. Both are kept.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { buildDag } from '../third_party/threejs-nanites/dag/build.ts';
import { getLivestockMeshes, getVehicleMeshes } from '../js/models/livestock-meshes.js';
import { createDolphinMesh } from '../js/dolphin-mesh.js';
import { createMarineMesh } from '../js/marine-life.js';
import { loadMarineGLB } from '../js/marine-asset.js';
import { createMarineRig, MARINE_SWIM_PERIOD } from '../js/marine-rig.js';
import {
  ANIMAL_CONTINUUM_FORMAT, ANIMAL_CONTINUUM_VERSION, ANIMAL_CONTINUUM_MAGIC, ANIMAL_CONTINUUM_HEADER, ANIMAL_CONTINUUM_HEADER_WORDS,
  ANIMAL_CONTINUUM_TYPE, ANIMAL_CONTINUUM_TYPE_WORDS, ANIMAL_CONTINUUM_CLUSTER_WORDS, ANIMAL_CONTINUUM_VERTEX_WORDS, ANIMAL_CONTINUUM_STEP_WORDS,
  ANIMAL_CONTINUUM_TRIANGLE_WORDS, ANIMAL_CONTINUUM_NEVER, ANIMAL_CONTINUUM_HOPS, ANIMAL_CONTINUUM_TYPES, ANIMAL_FAMILY, ANIMAL_CONTINUUM_GRAZE_PITCH,
  ANIMAL_CONTINUUM_ASSETS, ANIMAL_CONTINUUM_SKIN_WORDS, packAnimalContinuumVertex, packAnimalContinuumCluster, animalContinuumFloatBits,
  animalContinuumBitsFloat, animalContinuumUnorm2, validateAnimalContinuumManifest,
} from '../js/animal-continuum.js';
import { closest, triangleSpheres, nearestTriangle, triangleGrid, collapseChain, ancestor, outline, surfaceArea, wrap, simplifyWrap } from '../js/continuum-bake.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = path.resolve(ROOT, option('out', path.dirname(ANIMAL_CONTINUUM_ASSETS['manifest.json'])));
// A far body that will not simplify below this many triangles and stay manifold is wrapped again in coarser cells.
const WRAP_MOST_TRIANGLES = 4096;
// The far body stops collapsing here: a closed body needs four.
const CHAIN_LEAST_TRIANGLES = 6;
// What every sphere is grown by past what it must hold, for the quantization of the points it bounds.
const SPHERE_MARGIN = 0.005;

// ------------------------------------------------------------------------------------------------ the rigs
const rotX = (x, y, z, a) => { const c = Math.cos(a), s = Math.sin(a); return [x, y * c - z * s, y * s + z * c]; };
const rotY = (x, y, z, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c + z * s, y, -x * s + z * c]; };
const rotZ = (x, y, z, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c, z]; };
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// js/wgsl/herds.js poseLivestockVertex for one point, in the type's own metres (before its scale, slope and yaw), not
// shattered. `rig` is { neck: [x, y, z, graze pitch], legs: [legY, frontZ, backZ, height] }.
function herdPose(x, y, z, part, rig, pose, vehicle) {
  const { neck, legs } = rig, { walkPhase = 0, walkAmp = 0, graze = 0, tail = 0, tack = true, felled = false, hitAge = 0, hitAngle = 0 } = pose;
  let p = [x, y, z];
  const turnNeck = (base) => {
    const w = smooth(0, 1, clamp01(part - base)), nibble = 0.055 * Math.sin(tail * 3.4) * Math.max(0, graze);
    const pitch = (felled ? 0.26 : graze * neck[3] + nibble) * w, yaw = felled ? 0 : 0.14 * Math.sin(tail * 0.73) * graze * w;
    const rel = rotY(...rotX(p[0] - neck[0], p[1] - neck[1], p[2] - neck[2], pitch), yaw);
    p = [neck[0] + rel[0], neck[1] + rel[1], neck[2] + rel[2]];
  };
  if (!vehicle && part >= 8.5) {
    if (!tack) p = [0, legs[0], 0];
    else if (part >= 9.95 && part < 11) turnNeck(10);
  } else if (!vehicle && part >= 1 && part < 1.995) turnNeck(1);
  else if (!vehicle && part >= 1.995 && part < 5.5) {
    const leg = Math.round(part), beat = [0, 0, 0, Math.PI, 4.71238898, 1.57079633][leg], pivotZ = leg <= 3 ? legs[1] : legs[2];
    const piv = [p[0], legs[0], pivotZ];
    if (felled) {
      const fall = smooth(0, 0.38, hitAge), fold = (leg <= 3 ? 0.72 : -0.72) * fall, rel = rotX(p[0] - piv[0], p[1] - piv[1], p[2] - piv[2], fold);
      rel[1] *= 1 - 0.42 * fall;
      p = [piv[0] + rel[0], piv[1] + rel[1], piv[2] + rel[2]];
    } else {
      const ph = walkPhase + beat, swing = Math.sin(ph) * 0.36 * walkAmp, lift = Math.max(0, Math.cos(ph)) * 0.045 * walkAmp * clamp01(1 - p[1] / Math.max(0.2, legs[0]));
      const rel = rotX(p[0] - piv[0], p[1] - piv[1], p[2] - piv[2], swing);
      p = [piv[0] + rel[0], piv[1] + rel[1] + lift, piv[2] + rel[2]];
    }
  } else if (vehicle && part >= 7.5) {
    const piv = [0, neck[1], neck[2]], rel = rotY(...rotX(p[0] - piv[0], p[1] - piv[1], p[2] - piv[2], tail), graze);
    p = [piv[0] + rel[0], piv[1] + rel[1], piv[2] + rel[2]];
  } else if (vehicle && part >= 6.5) {
    const front = p[2] > 0.5 * (legs[1] + legs[2]), r = Math.max(0.2, front ? neck[0] : legs[0]), piv = [p[0], r, front ? legs[1] : legs[2]];
    const rel = rotX(p[0] - piv[0], p[1] - piv[1], p[2] - piv[2], walkPhase / r);
    p = [piv[0] + rel[0], piv[1] + rel[1], piv[2] + rel[2]];
  } else if (!vehicle && part >= 5.5) {
    const sway = felled ? 0 : 0.18 * Math.sin(tail * 2.1), piv = [0, legs[0] * 1.15, legs[2] - 0.18], rel = rotZ(p[0] - piv[0], p[1] - piv[1], p[2] - piv[2], sway);
    p = [piv[0] + rel[0], piv[1] + rel[1], piv[2] + rel[2]];
  }
  if (!vehicle && felled) {
    const fall = smooth(0, 0.38, hitAge), roll = (Math.sin(hitAngle) >= 0 ? 1 : -1) * 1.5707963 * fall, barrelY = legs[0] * 1.05, flank = 0.28 * legs[0] + 0.08;
    const hop = hitAge < 0.36 ? Math.sin((hitAge / 0.36) * Math.PI) * 0.16 : 0, rel = rotZ(p[0], p[1] - barrelY, p[2], roll);
    p = [rel[0], barrelY + rel[1] - (barrelY - flank) * fall + hop, rel[2]];
  }
  const bob = (vehicle ? 0.005 * Math.abs(Math.sin(walkPhase * 2.7)) : 0.014 * Math.abs(Math.sin(walkPhase))) * walkAmp * (felled ? 0 : 1);
  return [p[0], p[1] + bob, p[2]];
}
// A shattered vehicle's piece in flight (js/wgsl/herds.js), its hash's two numbers given, in its own metres at scale 1.
function shardPose(x, y, z, part, shard, rig, { hitAge, hitAngle, h0, h1 }) {
  const { neck, legs } = rig;
  let piv;
  if (part >= 7.5) piv = [0, neck[1] + 0.24, 2.75];
  else if (part >= 6.5) { const front = (shard & 2) !== 0; piv = [shard & 1 ? 0.86 : -0.86, Math.max(0.2, front ? neck[0] : legs[0]), front ? legs[1] : legs[2]]; }
  else piv = [shard & 1 ? 0.44 : -0.44, shard & 4 ? 1.46 : 0.92, shard & 2 ? 0.68 : -0.68];
  const hit = [Math.sin(hitAngle), Math.cos(hitAngle)], radial = Math.hypot(piv[0], piv[2]) > 0.08 ? [piv[0] / Math.hypot(piv[0], piv[2]), piv[2] / Math.hypot(piv[0], piv[2])] : [h0 - 0.5, h1 - 0.5];
  const d = [radial[0] * 0.72 + hit[0] * 0.68 + 1e-4, radial[1] * 0.72 + hit[1] * 0.68], dl = Math.hypot(...d), dir = [d[0] / dl, d[1] / dl];
  const wheel = part >= 6.5 && part < 7.5, speed = (2.7 + 3.9 * h0) * (wheel ? 1.25 : 1), vy0 = 2.9 + 3.3 * h1, g = 9.81;
  const drop = Math.max(0.05, piv[1] - (part >= 6.5 ? 0.08 : 0.14)), impact = (vy0 + Math.sqrt(vy0 * vy0 + 2 * g * drop)) / g;
  const fly = Math.min(hitAge, impact), ground = Math.max(0, hitAge - impact), slide = ground > 0 ? (1 - Math.exp(-ground * 4.5)) * 0.18 : 0;
  let dy = vy0 * fly - 0.5 * g * fly * fly;
  if (hitAge >= impact) dy = -drop + (ground < 0.34 ? Math.sin((ground / 0.34) * Math.PI) * 0.22 * (0.5 + 0.5 * h1) : 0);
  const spin = fly + slide * 0.5, spinX = (2.4 + 3.5 * h0) * spin * (h1 < 0.5 ? -1 : 1);
  const tilt = smooth(impact * 0.7, impact + 0.25, hitAge), spinZ = (1.8 + 2.8 * h1) * spin * (1 - tilt) + (piv[0] >= 0 ? 1.46 : -1.46) * tilt;
  const rel = rotZ(...rotX(x - piv[0], y - piv[1], z - piv[2], spinX), spinZ);
  return [piv[0] + rel[0] + dir[0] * speed * (fly + slide), Math.max(0.02, piv[1] + rel[1] + dy), piv[2] + rel[2] + dir[1] * speed * (fly + slide)];
}

// The poses each rig is measured in. `standing` bounds what the GPU places rigidly by the animal's frame (its pose
// slack); `error` adds the poses a clusters' error must hold besides (a felled beast is cut by clusters alone).
function herdPoses(vehicle) {
  if (vehicle) {
    // Each piece moves rigidly, so its own gaps hold in every pose: the wheels turned through a whole turn, the pole
    // to every corner of its yaw and pitch.
    const standing = [];
    for (let k = 0; k < 64; k++) standing.push({ walkPhase: k * 0.1, walkAmp: 1 });
    for (const graze of [-0.56, 0, 0.56]) for (const tail of [-0.34, 0, 0.34]) standing.push({ walkPhase: 0.3, walkAmp: 1, graze, tail });
    return { standing, error: standing };
  }
  const standing = [];
  for (const walkPhase of [0, Math.PI / 2, Math.PI, 1.5 * Math.PI]) for (const graze of [0, -0.28]) standing.push({ walkPhase, walkAmp: 1, graze, tail: 0 });
  for (const graze of [0.5, 1]) for (const tail of [2.15, -2.15, 0.462, -0.462]) standing.push({ walkPhase: 0, walkAmp: 0, graze, tail });
  for (const walkPhase of [Math.PI / 2, 1.5 * Math.PI]) standing.push({ walkPhase, walkAmp: 0.45, graze: 0.6, tail: 2.15 });
  const felled = [];
  for (const hitAge of [0.12, 0.2, 0.3, 1]) for (const hitAngle of [Math.PI / 2, -Math.PI / 2]) felled.push({ felled: true, hitAge, hitAngle });
  return { standing, felled, error: [...standing, ...felled] };
}
const seaPoses = (stroke) => ({ standing: [-1, -0.5, 0, 0.5, 1].map((beat) => ({ beat, stroke })), error: [-1, -0.5, 0, 0.5, 1].map((beat) => ({ beat, stroke })) });
function whalePoses(rig) {
  const palettes = [Float32Array.from(rig.update(0, 0))];
  for (let k = 0; k < 8; k++) palettes.push(Float32Array.from(rig.update((k / 8) * MARINE_SWIM_PERIOD, 1)));
  rig.update(0, 0);
  const poses = palettes.map((palette) => ({ palette }));
  return { standing: poses, error: poses };
}

// A type's points posed: `skin` its words (ANIMAL_CONTINUUM_SKIN_WORDS a point), as the GPU reads them.
function poser(type) {
  if (type.family === ANIMAL_FAMILY.livestock || type.family === ANIMAL_FAMILY.vehicle) {
    const vehicle = type.family === ANIMAL_FAMILY.vehicle;
    return (P, skin, pose) => {
      const V = P.length / 3, out = new Float32Array(V * 3);
      for (let v = 0; v < V; v++) out.set(herdPose(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], animalContinuumBitsFloat(skin[v * 5]), type.rig, pose, vehicle), v * 3);
      return out;
    };
  }
  if (type.family === ANIMAL_FAMILY.sea) {
    return (P, skin, pose) => {
      const V = P.length / 3, out = Float32Array.from(P);
      for (let v = 0; v < V; v++) {
        const z = P[v * 3 + 2];
        if (pose.stroke === 'dolphin') { const tail = Math.max(0, (z - 0.25) / 1.35); out[v * 3 + 1] += pose.beat * 0.24 * tail * tail; }
        else { const tail = clamp01((z - 0.15) / 2.4); out[v * 3] += pose.beat * 0.42 * tail * tail; }
      }
      return out;
    };
  }
  return (P, skin, { palette }) => {
    const V = P.length / 3, out = new Float32Array(V * 3), m = new Float64Array(16);
    for (let v = 0; v < V; v++) {
      const joints = skin[v * 5 + 3], weights = skin[v * 5 + 4], w = [0, 1, 2, 3].map((k) => (weights >>> (k * 8)) & 255), sum = w.reduce((s, x) => s + x, 0) || 1;
      m.fill(0);
      for (let k = 0; k < 4; k++) { const j = (joints >>> (k * 8)) & 255; for (let e = 0; e < 16; e++) m[e] += palette[j * 16 + e] * (w[k] / sum); }
      const [x, y, z] = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      for (let r = 0; r < 3; r++) out[v * 3 + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
    }
    return out;
  };
}

// ------------------------------------------------------------------------------------------------ the sources
// A herd beast's piece, by its rig's part: body, neck, each leg, tail, saddle, bridle.
function herdSegment(part) {
  if (part < 1) return 0;
  if (part < 1.995) return 1;
  if (part < 5.5) return Math.round(part);
  if (part < 8.5) return 6;
  return part >= 9.95 && part < 11 ? 10 : 9;
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

// A body for the bake: its points welded where every attribute and the piece agree, each triangle in one piece.
//   corners(t, k) the source corner, attributes(v) its numbers (position first, normal next), skinOf(v) its words,
//   pieceOf(v) its piece, uvOf(v) what the simplifier weighs beside the normal.
function weldBody(triangles, corners, attributes, skinOf, pieceOf, uvOf, excluded = () => false) {
  const map = new Map(), position = [], normal = [], uv = [], part = [], skin = [], source = [], index = new Uint32Array(triangles * 3), tack = new Uint8Array(triangles);
  for (let t = 0; t < triangles; t++) {
    const c = [0, 1, 2].map((k) => corners(t, k)), pieces = c.map(pieceOf);
    const piece = pieces[0] === pieces[1] || pieces[0] === pieces[2] ? pieces[0] : pieces[1] === pieces[2] ? pieces[1] : pieces[0];
    tack[t] = excluded(c) ? 1 : 0;
    for (let k = 0; k < 3; k++) {
      const key = `${attributes(c[k]).join(',')}|${piece}`;
      let v = map.get(key);
      if (v === undefined) {
        v = position.length / 3;
        map.set(key, v);
        const a = attributes(c[k]);
        position.push(a[0], a[1], a[2]); normal.push(a[3], a[4], a[5]); uv.push(...uvOf(c[k])); part.push(piece); skin.push(...skinOf(c[k])); source.push(c[k]);
      }
      index[t * 3 + k] = v;
    }
  }
  return {
    position: Float32Array.from(position), normal: Float32Array.from(normal), uv: Float32Array.from(uv), part: Uint32Array.from(part), skin: Uint32Array.from(skin),
    index, count: position.length / 3, excluded: tack, source,
  };
}

function herdType(id, mesh) {
  const vehicle = id >= 4, F = mesh.vertices, shards = vehicle ? vehicleShards(mesh) : null;
  const rig = { neck: [...mesh.neckPivot, ANIMAL_CONTINUUM_GRAZE_PITCH[id]], legs: [mesh.legY, mesh.frontZ, mesh.backZ, mesh.height] };
  const body = weldBody(mesh.indices.length / 3, (t, k) => mesh.indices[t * 3 + k], (v) => Array.from(F.subarray(v * 8, v * 8 + 8)),
    (v) => [animalContinuumFloatBits(F[v * 8 + 6]), animalContinuumFloatBits(F[v * 8 + 7]), shards ? shards[v] : 0, 0, 0],
    (v) => (vehicle ? shards[v] : herdSegment(F[v * 8 + 6])), () => [0, 0],
    // A horse's tack is left out of its far body: it lies over the coat, a few centimetres proud.
    (c) => !vehicle && c.every((v) => F[v * 8 + 6] >= 8.5));
  // The coat's linear colour where it is textured (16 + RGB555), for the splat.
  const colourOf = (v) => {
    const coat = F[v * 8 + 7];
    if (coat < 16) return null;
    const rgb = Math.round(coat - 16);
    return [(rgb >> 10) & 31, (rgb >> 5) & 31, rgb & 31].map((c) => (c / 31) ** 2);
  };
  return {
    id, name: ANIMAL_CONTINUUM_TYPES[id], family: vehicle ? ANIMAL_FAMILY.vehicle : ANIMAL_FAMILY.livestock, rig, body, poses: herdPoses(vehicle), colourOf: (v) => colourOf(body.source[v]),
    sourceTriangles: mesh.indices.length / 3, sourceBytes: [F, mesh.indices, Float32Array.from([...rig.neck, ...rig.legs])],
  };
}
function seaType(id, name, mesh, stroke) {
  const F = mesh.vertices;
  const body = weldBody(mesh.indices.length / 3, (t, k) => mesh.indices[t * 3 + k], (v) => Array.from(F.subarray(v * 9, v * 9 + 9)),
    (v) => [animalContinuumUnorm2(F[v * 9 + 6], F[v * 9 + 7]), animalContinuumUnorm2(F[v * 9 + 8], 0), 0, 0, 0], () => 0, () => [0, 0]);
  return {
    id, name, family: ANIMAL_FAMILY.sea, rig: null, body, poses: seaPoses(stroke), colourOf: (v) => Array.from(F.subarray(body.source[v] * 9 + 6, body.source[v] * 9 + 9)),
    sourceTriangles: mesh.indices.length / 3, sourceBytes: [F, mesh.indices],
  };
}
function whaleType(id) {
  const bytes = fs.readFileSync(path.join(ROOT, 'assets/wildlife/whale.glb')), model = loadMarineGLB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const F = model.vertices, { joints, weights } = model.skin, rig = createMarineRig(model);
  for (let v = 0; v < F.length / 11; v++) if (!(F[v * 11 + 9] >= 0 && F[v * 11 + 9] <= 1 && F[v * 11 + 10] >= 0 && F[v * 11 + 10] <= 1)) throw Error('The whale\'s texture place leaves 0..1');
  if (Math.max(...joints) > 255) throw Error('The whale has more joints than a byte holds');
  const packWeights = (v) => {
    const w = [0, 1, 2, 3].map((k) => weights[v * 4 + k]), sum = w.reduce((s, x) => s + x, 0) || 1, q = w.map((x) => Math.round((x / sum) * 255));
    q[q.indexOf(Math.max(...q))] += 255 - q.reduce((s, x) => s + x, 0);
    return (q[0] | (q[1] << 8) | (q[2] << 16) | (q[3] << 24)) >>> 0;
  };
  const body = weldBody(model.indices.length / 3, (t, k) => model.indices[t * 3 + k], (v) => [...F.subarray(v * 11, v * 11 + 11), ...joints.subarray(v * 4, v * 4 + 4), ...weights.subarray(v * 4, v * 4 + 4)],
    (v) => [animalContinuumUnorm2(F[v * 11 + 6], F[v * 11 + 7]), animalContinuumUnorm2(F[v * 11 + 8], 0), animalContinuumUnorm2(F[v * 11 + 9], F[v * 11 + 10]),
      (joints[v * 4] | (joints[v * 4 + 1] << 8) | (joints[v * 4 + 2] << 16) | (joints[v * 4 + 3] << 24)) >>> 0, packWeights(v)],
    () => 0, (v) => [F[v * 11 + 9], F[v * 11 + 10]]);
  return {
    id, name: 'whale', family: ANIMAL_FAMILY.whale, rig: null, body, poses: whalePoses(rig), colourOf: (v) => Array.from(F.subarray(body.source[v] * 11 + 6, body.source[v] * 11 + 9)),
    sourceTriangles: model.indices.length / 3, sourceBytes: [F, model.indices, joints, weights],
  };
}

// ------------------------------------------------------------------------------------------------ posed measures
// How far apart, in the worst pose, a point of one posed set (vertex a) and the barycentric point (s, t) on triangle
// (b0, b1, b2) of another are.
function posedGap(A, a, B, b0, b1, b2, s, t) {
  const r = 1 - s - t;
  let worst = 0;
  for (let k = 0; k < A.length; k++) {
    const X = A[k], Y = B[k];
    const dx = X[a * 3] - (r * Y[b0 * 3] + s * Y[b1 * 3] + t * Y[b2 * 3]);
    const dy = X[a * 3 + 1] - (r * Y[b0 * 3 + 1] + s * Y[b1 * 3 + 1] + t * Y[b2 * 3 + 1]);
    const dz = X[a * 3 + 2] - (r * Y[b0 * 3 + 2] + s * Y[b1 * 3 + 2] + t * Y[b2 * 3 + 2]);
    worst = Math.max(worst, dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(worst);
}
// The same between barycentric points of two triangles.
function posedTriangleGap(A, [a0, a1, a2], sa, ta, B, [b0, b1, b2], sb, tb) {
  const ra = 1 - sa - ta, rb = 1 - sb - tb;
  let worst = 0;
  for (let k = 0; k < A.length; k++) {
    const X = A[k], Y = B[k];
    let d2 = 0;
    for (let e = 0; e < 3; e++) {
      const d = ra * X[a0 * 3 + e] + sa * X[a1 * 3 + e] + ta * X[a2 * 3 + e] - (rb * Y[b0 * 3 + e] + sb * Y[b1 * 3 + e] + tb * Y[b2 * 3 + e]);
      d2 += d * d;
    }
    worst = Math.max(worst, d2);
  }
  return Math.sqrt(worst);
}

// ------------------------------------------------------------------------------------------------ clusters
// The builder's group error, measured posed: each point a group removes is matched, at rest, to its nearest point on
// what the group keeps of the same piece, and the error is the farthest those two come apart in any pose.
function posedGroupError(body, posed) {
  const kept = new Int32Array(body.count).fill(-1), seen = new Int32Array(body.count).fill(-1), mesh = { position: body.position, corners: null };
  let stamp = 0;
  return (children, simplified, error) => {
    stamp++;
    const count = simplified.length / 3;
    if (!count) return error;
    for (const v of simplified) kept[v] = stamp;
    const byPiece = new Map(), every = Array.from({ length: count }, (_, t) => t);
    for (let t = 0; t < count; t++) {
      const p = body.part[simplified[t * 3]];
      if (!byPiece.has(p)) byPiece.set(p, []);
      byPiece.get(p).push(t);
    }
    mesh.corners = simplified;
    const spheres = triangleSpheres(body.position, simplified, every), pieceSpheres = new Map();
    let worst = 0;
    for (const v of children) {
      if (kept[v] === stamp || seen[v] === stamp) continue;
      seen[v] = stamp;
      const list = byPiece.get(body.part[v]) ?? every;
      if (!pieceSpheres.has(list)) pieceSpheres.set(list, list === every ? spheres : triangleSpheres(body.position, simplified, list));
      const k = nearestTriangle(body.position[v * 3], body.position[v * 3 + 1], body.position[v * 3 + 2], list, mesh, pieceSpheres.get(list)), t = list[k];
      worst = Math.max(worst, posedGap(posed, v, posed, simplified[t * 3], simplified[t * 3 + 1], simplified[t * 3 + 2], closest[1], closest[2]));
    }
    return worst;
  };
}
// The farthest any of `vertices` comes, in any pose, from a point at rest.
function posedReach(posed, vertices, [cx, cy, cz]) {
  let worst = 0;
  for (const X of posed) for (const v of vertices) worst = Math.max(worst, (X[v * 3] - cx) ** 2 + (X[v * 3 + 1] - cy) ** 2 + (X[v * 3 + 2] - cz) ** 2);
  return Math.sqrt(worst);
}

async function bakeClusters(type, errorPosed, slackPosed) {
  const body = type.body;
  const dag = await buildDag({
    id: 0, bark: { pos: body.position, nrm: body.normal, uv: body.uv, idx: body.index },
    leaves: { pos: new Float32Array(0), nrm: new Float32Array(0), uv: new Float32Array(0), vpl: 8 },
    barkParts: body.part, barkGroupError: posedGroupError(body, errorPosed),
  });
  const count = dag.meta.length / 4;
  const verticesOf = (c) => new Set(dag.idx.subarray(dag.meta[c * 4], dag.meta[c * 4] + dag.meta[c * 4 + 1] * 3));
  let groupCount = 0;
  for (let c = 0; c < count; c++) groupCount = Math.max(groupCount, dag.groups[c * 2] + 1, dag.groups[c * 2 + 1] + 1);
  const children = Array.from({ length: groupCount }, () => []);
  for (let c = 0; c < count; c++) if (dag.groups[c * 2 + 1] >= 0) children[dag.groups[c * 2 + 1]].push(c);
  // Each group's sphere about its centre at rest, grown to hold its points in every pose standing and every child
  // group's sphere, so a coarser level is never projected finer than the level it replaces.
  const centre = (g) => Array.from(dag.rec.subarray(children[g][0] * 16 + 4, children[g][0] * 16 + 7)), radius = new Float64Array(groupCount);
  for (let g = 0; g < groupCount; g++) {
    const vertices = new Set(), [x, y, z] = centre(g);
    for (const c of children[g]) for (const v of verticesOf(c)) vertices.add(v);
    radius[g] = Math.max(dag.rec[children[g][0] * 16 + 7], posedReach(slackPosed, vertices, [x, y, z])) + SPHERE_MARGIN;
    for (const c of children[g]) {
      const own = dag.groups[c * 2];
      if (own < 0) continue;
      const [ox, oy, oz] = centre(own);
      radius[g] = Math.max(radius[g], Math.hypot(x - ox, y - oy, z - oz) + radius[own]);
    }
  }
  const records = [];
  for (let c = 0; c < count; c++) {
    const r = dag.rec.subarray(c * 16, c * 16 + 16), own = dag.groups[c * 2], parent = dag.groups[c * 2 + 1];
    const cullCentre = [r[8], r[9], r[10]], cull = [...cullCentre, Math.max(r[11], posedReach(slackPosed, verticesOf(c), cullCentre)) + SPHERE_MARGIN];
    const lod = own >= 0 ? [...centre(own), radius[own]] : cull;
    records.push({
      cluster: c, lod, parentLod: parent >= 0 ? [...centre(parent), radius[parent]] : lod, cull,
      error: r[12], parentError: parent >= 0 ? r[13] : Infinity, part: body.part[dag.idx[dag.meta[c * 4]]], level: dag.meta[c * 4 + 2],
    });
  }
  // Coarsest parent first: what an animal can draw at its nearest point is then a prefix.
  records.sort((p, q) => q.parentError - p.parentError || q.error - p.error || p.cluster - q.cluster);
  const local = new Int32Array(body.count).fill(-1), order = [], indices = [];
  for (const record of records) {
    const at = dag.meta[record.cluster * 4], tris = dag.meta[record.cluster * 4 + 1];
    record.first = indices.length; record.triangles = tris;
    for (let i = 0; i < tris * 3; i++) {
      const v = dag.idx[at + i];
      if (local[v] < 0) { local[v] = order.length; order.push(v); }
      indices.push(local[v]);
    }
  }
  const finest = records.filter((r) => r.level === 0).reduce((n, r) => n + r.triangles, 0);
  if (finest !== body.index.length / 3) throw Error(`${type.name}: the finest clusters hold ${finest} of ${body.index.length / 3} triangles`);
  return {
    records, order, indices, count, levels: dag.stats.barkLevels, roots: dag.stats.barkRoots, finestTriangles: finest,
    rootError: Math.max(...records.map((r) => r.error)), rootTriangles: records.reduce((n, r) => n + (r.parentError === Infinity ? r.triangles : 0), 0),
  };
}

// ------------------------------------------------------------------------------------------------ far body
// Area-weighted vertex normals.
function normalsOf(position, index) {
  const V = position.length / 3, normal = new Float32Array(V * 3);
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => index[t + k] * 3), e = [0, 1, 2].map((k) => position[b + k] - position[a + k]), f = [0, 1, 2].map((k) => position[c + k] - position[a + k]);
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normal[v + k] += n[k];
  }
  for (let v = 0; v < V; v++) { const l = Math.hypot(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]) || 1; for (let k = 0; k < 3; k++) normal[v * 3 + k] /= l; }
  return normal;
}

function bakeFar(type, pose) {
  const body = type.body, T0 = body.index.length / 3, kept = [];
  for (let t = 0; t < T0; t++) if (!body.excluded[t]) kept.push(t);
  const soup = new Float32Array(kept.length * 24);
  kept.forEach((t, i) => { for (let k = 0; k < 3; k++) soup.set(body.position.subarray(body.index[t * 3 + k] * 3, body.index[t * 3 + k] * 3 + 3), (i * 3 + k) * 8); });
  let wrapped, base;
  for (let coarser = 1; ; coarser *= 1.5) {
    wrapped = wrap({ vertices: soup, triangles: kept.length, name: type.name }, coarser); base = simplifyWrap(type.name, wrapped);
    if (base.index.length / 3 <= WRAP_MOST_TRIANGLES || coarser > 5) break;
  }
  const position = base.position, index = base.index, V = position.length / 3, T = index.length / 3, normal = normalsOf(position, index), allBase = Array.from({ length: T }, (_, t) => t);
  // Each far point wears the skin of the nearest corner of the source's own surface (its tack left out).
  const keptSet = new Uint8Array(T0);
  for (const t of kept) keptSet[t] = 1;
  const cell = Math.max(wrapped.h * 4, 0.25), source = triangleGrid(body.position, body.index, cell), accept = (t) => keptSet[t] === 1;
  const skin = new Uint32Array(V * ANIMAL_CONTINUUM_SKIN_WORDS), W = ANIMAL_CONTINUUM_SKIN_WORDS;
  for (let v = 0; v < V; v++) {
    const t = source(position[v * 3], position[v * 3 + 1], position[v * 3 + 2], accept), s = closest[1], u = closest[2], w = [1 - s - u, s, u];
    const corner = body.index[t * 3 + w.indexOf(Math.max(...w))];
    skin.set(body.skin.subarray(corner * W, corner * W + W), v * W);
    // A far wheel is a disc whose turning cannot be seen: it rides the body, so no far triangle between a wheel and
    // the bed it stands beside is stretched by the turn.
    if (type.family === ANIMAL_FAMILY.vehicle) {
      const part = animalContinuumBitsFloat(skin[v * W]);
      if (part >= 6.5 && part < 7.5) skin[v * W] = animalContinuumFloatBits(0);
    }
  }
  // Posed, standing: the source and the far body.
  const sourcePosed = type.poses.standing.map((p) => pose(body.position, body.skin, p)), farPosed = type.poses.standing.map((p) => pose(position, skin, p));
  // How far the wrap is from what it stands for, both ways and in every pose: each of its points from the source's
  // nearest surface, and each point of the source that can be seen from outside it (a vertex, a triangle's middle)
  // from the wrap's nearest surface, all posed alike.
  const seen = [];
  for (let v = 0; v < body.count; v++) if (wrapped.exteriorAt(body.position[v * 3], body.position[v * 3 + 1], body.position[v * 3 + 2])) seen.push([v, v, v]);
  for (let t = 0; t < T0; t++) {
    const c = [0, 1, 2].map((k) => body.index[t * 3 + k]), P = body.position;
    if (wrapped.exteriorAt(...[0, 1, 2].map((e) => (P[c[0] * 3 + e] + P[c[1] * 3 + e] + P[c[2] * 3 + e]) / 3))) seen.push(c);
  }
  let outward = 0, inward = 0;
  sourcePosed.forEach((X, k) => {
    const Y = farPosed[k], toSource = triangleGrid(X, body.index, cell), toFar = triangleGrid(Y, index, cell);
    for (let v = 0; v < V; v++) { toSource(Y[v * 3], Y[v * 3 + 1], Y[v * 3 + 2]); outward = Math.max(outward, closest[0]); }
    for (const [a, b, c] of seen) { toFar(...[0, 1, 2].map((e) => (X[a * 3 + e] + X[b * 3 + e] + X[c * 3 + e]) / 3)); inward = Math.max(inward, closest[0]); }
  });
  outward = Math.sqrt(outward); inward = Math.sqrt(inward);
  const baseError = Math.max(outward, inward, base.error);

  const chain = collapseChain(position, index, CHAIN_LEAST_TRIANGLES), S = chain.steps.length;
  let depth = 0;
  for (let v = 0; v < V; v++) { let d = 0; for (let w = v; chain.dieStep[w] >= 0; w = chain.target[w]) d++; depth = Math.max(depth, d); }
  if (depth > ANIMAL_CONTINUUM_HOPS) throw Error(`${type.name}: a far-body vertex collapses ${depth} times, past the GPU's ${ANIMAL_CONTINUUM_HOPS}`);
  // Errors (posed) and inflation (at rest), measured at every eighth step and the last few, between them in proportion.
  const baseFans = Array.from({ length: V }, () => []);
  allBase.forEach((t) => { for (let k = 0; k < 3; k++) baseFans[index[t * 3 + k]].push(t); });
  const low = [0, 1, 2].map((k) => Math.min(...Array.from({ length: V }, (_, i) => position[i * 3 + k]))), high = [0, 1, 2].map((k) => Math.max(...Array.from({ length: V }, (_, i) => position[i * 3 + k])));
  const span = Math.max(...high.map((v, k) => v - low[k])), margin = span * 0.15;
  const frame = { low: low.map((v) => v - margin), size: span + 2 * margin, cells: 128 };
  const baseOutline = outline(position, normal, index, allBase, 0, frame);
  const wanted = baseOutline.reduce((n, view) => n + view.covered, 0);
  const baseMesh = { position, corners: index }, baseSpheres = triangleSpheres(position, index, allBase);
  const measured = new Map(), sampled = new Set([0, S]);
  for (let s = 0; s <= S; s += 8) sampled.add(s);
  for (let s = Math.max(0, S - 48); s <= S; s++) sampled.add(s);
  const stepCorners = new Uint32Array(T * 3);
  for (const s of [...sampled].sort((p, q) => p - q)) {
    const living = allBase.filter((t) => chain.death[t] < 0 || chain.death[t] > s);
    for (const t of living) for (let k = 0; k < 3; k++) stepCorners[t * 3 + k] = ancestor(chain, index[t * 3 + k], s);
    const fans = new Map();
    for (const t of living) for (let k = 0; k < 3; k++) { const a = stepCorners[t * 3 + k]; if (!fans.has(a)) fans.set(a, []); fans.get(a).push(t); }
    const stepMesh = { position, corners: stepCorners };
    let error = 0;
    // Each base point against the triangles of the vertex it has collapsed into.
    for (let v = 0; v < V; v++) {
      const list = fans.get(ancestor(chain, v, s)) ?? [];
      const k = nearestTriangle(position[v * 3], position[v * 3 + 1], position[v * 3 + 2], list, stepMesh, triangleSpheres(position, stepCorners, list));
      if (k < 0) continue;
      const t = list[k];
      error = Math.max(error, posedGap(farPosed, v, farPosed, stepCorners[t * 3], stepCorners[t * 3 + 1], stepCorners[t * 3 + 2], closest[1], closest[2]));
    }
    // Each surviving triangle's middle against the base it has replaced.
    const members = new Map();
    for (let v = 0; v < V; v++) { const a = ancestor(chain, v, s); if (!members.has(a)) members.set(a, []); members.get(a).push(v); }
    for (const t of living) {
      const [a, b, c] = [0, 1, 2].map((k) => stepCorners[t * 3 + k]), candidates = new Set();
      for (const corner of [a, b, c]) for (const m of members.get(corner) ?? []) for (const u of baseFans[m]) candidates.add(u);
      const list = [...candidates], spheres = new Float64Array(list.length * 4);
      list.forEach((u, i) => spheres.set(baseSpheres.subarray(u * 4, u * 4 + 4), i * 4));
      const [x, y, z] = [0, 1, 2].map((e) => (position[a * 3 + e] + position[b * 3 + e] + position[c * 3 + e]) / 3);
      const k = nearestTriangle(x, y, z, list, baseMesh, spheres);
      if (k < 0) continue;
      const u = list[k];
      error = Math.max(error, posedTriangleGap(farPosed, [a, b, c], 1 / 3, 1 / 3, farPosed, [index[u * 3], index[u * 3 + 1], index[u * 3 + 2]], closest[1], closest[2]));
    }
    // How far along its normals the surface must grow to cast the wrap's outline again.
    let inflate = 0;
    const cast = (d) => outline(position, normal, stepCorners, living, d, frame).reduce((n, view) => n + view.covered, 0);
    if (s > 0 && cast(0) < wanted) {
      let lo = 0, hi = span * 0.1;
      for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (cast(mid) < wanted) lo = mid; else hi = mid; }
      inflate = (lo + hi) / 2;
    }
    measured.set(s, { error: baseError + error, inflate });
  }
  const keys = [...measured.keys()].sort((p, q) => p - q), errors = new Float32Array(S + 1), inflates = new Float32Array(S + 1);
  for (let i = 0; i < keys.length; i++) {
    const s0 = keys[i], s1 = keys[Math.min(i + 1, keys.length - 1)], m0 = measured.get(s0), m1 = measured.get(s1);
    for (let s = s0; s <= s1; s++) {
      const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
      errors[s] = m0.error + (m1.error - m0.error) * f;
      inflates[s] = m0.inflate + (m1.inflate - m0.inflate) * f;
    }
  }
  // Rising strictly, so the morph search always has room between one step and the next.
  for (let s = 1; s <= S; s++) errors[s] = Math.max(errors[s], errors[s - 1] * (1 + 4e-6) + 1e-7);
  if (!(errors[S] < 2 * span)) throw Error(`${type.name}: the far body's last step is ${errors[S]} m in error`);
  // Triangles in order of death, latest first: those alive at step s are a prefix.
  const order = allBase.slice().sort((p, q) => (chain.death[q] < 0 ? Infinity : chain.death[q]) - (chain.death[p] < 0 ? Infinity : chain.death[p]));
  const steps = new Uint32Array((S + 1) * ANIMAL_CONTINUUM_STEP_WORDS), stepFloats = new Float32Array(steps.buffer), dying = new Int32Array(S + 2);
  for (let t = 0; t < T; t++) if (chain.death[t] >= 0) dying[chain.death[t]]++;
  for (let s = 0, alive = T; s <= S; s++) {
    alive -= dying[s];
    steps[s * ANIMAL_CONTINUUM_STEP_WORDS] = alive;
    stepFloats[s * ANIMAL_CONTINUUM_STEP_WORDS + 1] = errors[s];
    stepFloats[s * ANIMAL_CONTINUUM_STEP_WORDS + 2] = inflates[s];
  }
  if (steps[S * ANIMAL_CONTINUUM_STEP_WORDS] !== order.filter((t) => chain.death[t] < 0 || chain.death[t] > S).length) throw Error('Chain prefix counts disagree');

  // The splat: the wrap's outline seen from the front (along z) and from the side (along x), each as an ellipse as
  // tall as the wrap, about the wrap's middle; its colour the area-weighted mean of the source's.
  const cellArea = (frame.size / frame.cells) ** 2, ry = Math.max((high[1] - low[1]) / 2, 0.05);
  const front = baseOutline[0].covered * cellArea, side = baseOutline[1].covered * cellArea;
  let sum = [0, 0, 0], weight = 0, untextured = 0;
  for (const t of kept) {
    const c = [0, 1, 2].map((k) => body.index[t * 3 + k]), area = surfaceArea(body.index, [t], body.position), colours = c.map(type.colourOf);
    if (colours.some((x) => !x)) { untextured += area; continue; }
    for (const x of colours) for (let k = 0; k < 3; k++) sum[k] += (area / 3) * x[k];
    weight += area;
  }
  // A beast coated by zones (not by its texture) is coloured by its zones' own rule on the GPU: the colour is -1.
  const colour = weight > untextured ? sum.map((v) => v / weight) : [-1, -1, -1];
  const splat = {
    centre: low.map((v, k) => +((v + high[k]) / 2).toFixed(4)), ry: +ry.toFixed(4),
    rxFront: +Math.max(front / (Math.PI * ry), 0.02).toFixed(4), rxSide: +Math.max(side / (Math.PI * ry), 0.02).toFixed(4), colour: colour.map((v) => +v.toFixed(5)),
  };
  return {
    position, normal, index, skin, chain, steps, order, splat, baseError, farPosed,
    stats: {
      cell: +wrapped.h.toFixed(4), cells: wrapped.cells, wellComposedCells: wrapped.added, wrapTriangles: wrapped.index.length / 3, baseTriangles: T, baseVertices: V,
      baseError: +baseError.toFixed(4), outward: +outward.toFixed(4), inward: +inward.toFixed(4), simplifyError: +base.error.toFixed(4),
      steps: S, coreTriangles: steps[S * ANIMAL_CONTINUUM_STEP_WORDS], depth, errorRange: [+errors[0].toFixed(4), +errors[S].toFixed(4)], inflateMax: +Math.max(...inflates).toFixed(4),
    },
  };
}

// ------------------------------------------------------------------------------------------------ main
const asBytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  await MeshoptSimplifier.ready;
  const started = Date.now();
  const types = [
    ...[...getLivestockMeshes(), ...getVehicleMeshes()].map((mesh, id) => herdType(id, mesh)),
    seaType(7, 'dolphin', createDolphinMesh(), 'dolphin'), seaType(8, 'shark', createMarineMesh('shark'), 'shark'), whaleType(9),
  ];
  if (types.map((t) => t.name).join() !== ANIMAL_CONTINUUM_TYPES.join()) throw Error('The catalogue and its sources disagree');
  const baked = [];
  for (const type of types) {
    const t0 = Date.now(), pose = poser(type), body = type.body;
    const errorPosed = type.poses.error.map((p) => pose(body.position, body.skin, p)), slackPosed = type.poses.standing.map((p) => pose(body.position, body.skin, p));
    const clusters = await bakeClusters(type, errorPosed, slackPosed), far = bakeFar(type, pose);
    // The far body takes over no sooner than it is as light as the coarsest cut of the clusters, their roots.
    far.farFirst = 0;
    while (far.farFirst < far.chain.steps.length && far.steps[far.farFirst * ANIMAL_CONTINUUM_STEP_WORDS] > clusters.rootTriangles) far.farFirst++;
    Object.assign(far.stats, { rootTriangles: clusters.rootTriangles, farFirst: far.farFirst, farFirstTriangles: far.steps[far.farFirst * ANIMAL_CONTINUUM_STEP_WORDS], handoffError: +new Float32Array(far.steps.buffer)[far.farFirst * ANIMAL_CONTINUUM_STEP_WORDS + 1].toFixed(4) });
    // One sphere about the middle at rest holds every point it draws standing (clusters and far body, grown by the
    // far body's inflation); felled, the same centre and another radius; shattered, how much farther its pieces fly.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const P of [body.position, far.position]) for (let v = 0; v < P.length / 3; v++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[v * 3 + k]); hi[k] = Math.max(hi[k], P[v * 3 + k]); }
    const centre = lo.map((v, k) => (v + hi[k]) / 2), every = (P) => Array.from({ length: P.length / 3 }, (_, v) => v);
    const radius = Math.max(posedReach(slackPosed, every(body.position), centre), posedReach(far.farPosed, every(far.position), centre)) + far.stats.inflateMax + SPHERE_MARGIN;
    let felledRadius = radius, shatterReach = 0;
    if (type.poses.felled) felledRadius = Math.max(radius, posedReach(type.poses.felled.map((p) => pose(body.position, body.skin, p)), every(body.position), centre) + SPHERE_MARGIN);
    if (type.family === ANIMAL_FAMILY.vehicle) {
      for (const hitAge of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 6]) for (const hitAngle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) for (const h0 of [0, 1]) for (const h1 of [0, 0.49, 0.51, 1]) {
        for (let v = 0; v < body.count; v++) {
          const p = shardPose(body.position[v * 3], body.position[v * 3 + 1], body.position[v * 3 + 2], animalContinuumBitsFloat(body.skin[v * 5]), body.skin[v * 5 + 2], type.rig, { hitAge, hitAngle, h0, h1 });
          shatterReach = Math.max(shatterReach, Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]) - radius);
        }
      }
      shatterReach += 0.25;
    }
    baked.push({ type, clusters, far, centre, radius, felledRadius, shatterReach, ms: Date.now() - t0 });
    console.log(`${type.id} ${type.name.padEnd(8)} ${String(type.sourceTriangles).padStart(5)} tris · ${String(clusters.count).padStart(3)} clusters ${clusters.levels} levels, root ${clusters.rootError.toFixed(3)} m (${clusters.rootTriangles} tris) · wrap ${far.stats.cell} m, ${far.stats.baseTriangles} → ${far.stats.coreTriangles} in ${far.stats.steps} steps (depth ${far.stats.depth}), ${far.stats.errorRange.join('–')} m (base: out ${far.stats.outward}, in ${far.stats.inward}), handoff at step ${far.farFirst} (${far.stats.farFirstTriangles}, ${far.stats.handoffError} m) · sphere ${radius.toFixed(2)} m${type.poses.felled ? `, felled ${felledRadius.toFixed(2)}` : ''}${shatterReach ? `, shattered +${shatterReach.toFixed(1)}` : ''} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  const totalClusters = baked.reduce((n, b) => n + b.clusters.count, 0), totalVertices = baked.reduce((n, b) => n + b.clusters.order.length, 0), totalIndices = baked.reduce((n, b) => n + b.clusters.indices.length, 0);
  const chainWords = baked.map((b) => (b.far.position.length / 3) * (ANIMAL_CONTINUUM_VERTEX_WORDS + 1) + (b.far.index.length / 3) * ANIMAL_CONTINUUM_TRIANGLE_WORDS + b.far.steps.length);
  const typesAt = ANIMAL_CONTINUUM_HEADER_WORDS, clustersAt = typesAt + types.length * ANIMAL_CONTINUUM_TYPE_WORDS, verticesAt = clustersAt + totalClusters * ANIMAL_CONTINUUM_CLUSTER_WORDS;
  const indicesAt = verticesAt + totalVertices * ANIMAL_CONTINUUM_VERTEX_WORDS, chainsAt = indicesAt + totalIndices, words = chainsAt + chainWords.reduce((s, n) => s + n, 0);
  const atlas = new Uint32Array(words), floats = new Float32Array(atlas.buffer), H = ANIMAL_CONTINUUM_HEADER;
  const header = { magic: ANIMAL_CONTINUUM_MAGIC, version: ANIMAL_CONTINUUM_VERSION, typeCount: types.length, typesAt, clustersAt, clusterCount: totalClusters, verticesAt, vertexCount: totalVertices, indicesAt, indexCount: totalIndices, chainsAt, words };
  for (const [name, value] of Object.entries(header)) atlas[H[name]] = value;
  let clusterAt = 0, vertexAt = 0, indexAt = 0, chainAt = chainsAt;
  const manifestTypes = [];
  for (const { type, clusters, far, centre, radius, felledRadius, shatterReach, ms } of baked) {
    const body = type.body, low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const P of [body.position, far.position]) for (let v = 0; v < P.length / 3; v++) for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], P[v * 3 + k]); high[k] = Math.max(high[k], P[v * 3 + k]); }
    const quant = { low, span: Math.max(...high.map((v, k) => v - low[k])) }, W = ANIMAL_CONTINUUM_SKIN_WORDS;
    clusters.records.forEach((record, k) => atlas.set(packAnimalContinuumCluster({ ...record, first: indexAt + record.first }), clustersAt + (clusterAt + k) * ANIMAL_CONTINUUM_CLUSTER_WORDS));
    clusters.order.forEach((v, i) => atlas.set(packAnimalContinuumVertex({ position: body.position.subarray(v * 3, v * 3 + 3), normal: body.normal.subarray(v * 3, v * 3 + 3), skin: body.skin.subarray(v * W, v * W + W) }, quant), verticesAt + (vertexAt + i) * ANIMAL_CONTINUUM_VERTEX_WORDS));
    clusters.indices.forEach((v, i) => { atlas[indicesAt + indexAt + i] = vertexAt + v; });
    // The far body: vertices, each vertex's collapse (the step it goes at, and where), triangles in order of death, steps.
    const V = far.position.length / 3, T = far.index.length / 3, S = far.chain.steps.length;
    const recordsAt = chainAt + V * ANIMAL_CONTINUUM_VERTEX_WORDS, trianglesAt = recordsAt + V, stepsAt = trianglesAt + T * ANIMAL_CONTINUUM_TRIANGLE_WORDS;
    for (let i = 0; i < V; i++) {
      atlas.set(packAnimalContinuumVertex({ position: far.position.subarray(i * 3, i * 3 + 3), normal: far.normal.subarray(i * 3, i * 3 + 3), skin: far.skin.subarray(i * W, i * W + W) }, quant), chainAt + i * ANIMAL_CONTINUUM_VERTEX_WORDS);
      atlas[recordsAt + i] = ((far.chain.dieStep[i] < 0 ? ANIMAL_CONTINUUM_NEVER : far.chain.dieStep[i]) | ((far.chain.target[i] < 0 ? i : far.chain.target[i]) << 16)) >>> 0;
    }
    far.order.forEach((t, k) => { for (let c = 0; c < 3; c++) atlas[trianglesAt + k * ANIMAL_CONTINUUM_TRIANGLE_WORDS + c] = far.index[t * 3 + c]; });
    atlas.set(far.steps, stepsAt);
    const at = typesAt + type.id * ANIMAL_CONTINUUM_TYPE_WORDS, F = ANIMAL_CONTINUUM_TYPE;
    floats.set([...low, quant.span, ...centre, radius], at + F.low);
    atlas.set([clusterAt, clusters.count, chainAt, S, V, recordsAt, trianglesAt, stepsAt], at + F.clusterFirst);
    floats.set([far.baseError, clusters.rootError, far.splat.rxSide, far.splat.rxFront, far.splat.ry, ...far.splat.centre, ...far.splat.colour, felledRadius], at + F.baseError);
    atlas.set([T, type.family, type.sourceTriangles, far.farFirst], at + F.chainTriangleCount);
    if (type.rig) floats.set([...type.rig.neck, ...type.rig.legs], at + F.neck);
    floats[at + F.shatterReach] = shatterReach;
    const fingerprint = createHash('sha256');
    for (const typed of type.sourceBytes) fingerprint.update(asBytes(typed));
    manifestTypes.push({
      id: type.id, name: type.name, family: Object.keys(ANIMAL_FAMILY)[type.family], fingerprint: fingerprint.digest('hex'), sourceTriangles: type.sourceTriangles, pieces: new Set(body.part).size,
      quantization: { low: low.map((v) => +v.toFixed(5)), span: +quant.span.toFixed(5) }, sphere: [...centre.map((v) => +v.toFixed(4)), +radius.toFixed(4)], felledRadius: +felledRadius.toFixed(4), shatterReach: +shatterReach.toFixed(3),
      clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootTriangles: clusters.rootTriangles, rootError: +clusters.rootError.toFixed(4) },
      chain: far.stats, splat: far.splat, poses: { standing: type.poses.standing.length, error: type.poses.error.length }, bakeMs: ms,
    });
    clusterAt += clusters.count; vertexAt += clusters.order.length; indexAt += clusters.indices.length; chainAt = stepsAt + far.steps.length;
  }
  if (chainAt !== words) throw Error('The atlas layout does not add up');

  fs.mkdirSync(OUT, { recursive: true });
  const bytes = asBytes(atlas), gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(OUT, 'atlas.bin.gz'), gz);
  const manifest = {
    format: ANIMAL_CONTINUUM_FORMAT, version: ANIMAL_CONTINUUM_VERSION, generator: 'scripts/prepare-animal-continuum.mjs',
    layout: { headerWords: ANIMAL_CONTINUUM_HEADER_WORDS, typeWords: ANIMAL_CONTINUUM_TYPE_WORDS, clusterWords: ANIMAL_CONTINUUM_CLUSTER_WORDS, vertexWords: ANIMAL_CONTINUUM_VERTEX_WORDS, triangleWords: ANIMAL_CONTINUUM_TRIANGLE_WORDS, stepWords: ANIMAL_CONTINUUM_STEP_WORDS, header: ANIMAL_CONTINUUM_HEADER },
    totals: { types: types.length, clusters: totalClusters, vertices: totalVertices, indices: totalIndices, sourceTriangles: types.reduce((n, t) => n + t.sourceTriangles, 0), farTriangles: baked.reduce((n, b) => n + b.far.index.length / 3, 0) },
    types: manifestTypes,
    atlas: { words, bytes: bytes.length, sha256: sha256(bytes), gzip: { file: 'atlas.bin.gz', bytes: gz.length, sha256: sha256(gz) } },
    bakeSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  validateAnimalContinuumManifest(manifest);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${types.length} types · ${totalClusters} clusters · atlas ${(bytes.length / 1048576).toFixed(2)} MiB, ${(gz.length / 1048576).toFixed(2)} MiB gzipped · ${manifest.bakeSeconds} s`);
}
await main();
