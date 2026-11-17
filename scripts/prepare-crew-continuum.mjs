#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes each high-detail crew body into the people continuum (AGENTS.md rule 3; js/crew-continuum.js).
//   node scripts/prepare-crew-continuum.mjs [--fits=.tripo/1550-hd/fit-regions] [--only=sailor-male] [--out=assets/crew/continuum] [--texture=4096]
// Each body comes from its fit (scripts/fit-crew-body.py --textured --full-texture, which tags each point's region):
//   clusters   a cluster hierarchy the GPU cuts by projected error. Each part a ball can take off (the head, and each
//              limb segment of CREW_LIMB_JOINTS) is clustered apart, its boundary a seam both sides coarsen together,
//              and each group's error is measured in every pose of a set the body is held to, so a cut keeps its
//              bound while it moves. Bounds are posed by one joint each, grown by how far their points stray from it.
//   chain      a closed vertex-coloured body that collapses one half-edge at a time to a few triangles. Each step's
//              error is measured posed, and what the collapse takes off the outline is given back along the normals.
//   splat      one view-facing ellipse with the body's outline area and its colour by region.
//   albedo     the body's texture, filled past its islands, in BC7 and ASTC 4x4 (scripts/crew-continuum-texture.py).
//   body.glb   the skeleton, clips and a light stand-in mesh, so posing, footing and seating are measured as before.
// Streams are written gzipped beside a manifest with their receipts. Only the manifests are kept in git.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { buildDag } from '../third_party/threejs-nanites/dag/build.ts';
import { readGLB, createSkinAnimator, gltfQuatMultiply } from '../js/gltf.js';
import { CREW_JOINT_NAMES, CREW_JOINT_COUNT } from '../js/crew-skeleton.js';
import {
  CREW_CONTINUUM_FORMAT, CREW_CONTINUUM_VERSION, CREW_CONTINUUM_VERTEX_WORDS, CREW_CONTINUUM_CLUSTER_WORDS, CREW_CONTINUUM_STEP_WORDS,
  CREW_CONTINUUM_BODIES, CREW_CONTINUUM_JOINT_PART, CREW_CONTINUUM_PARTS, CREW_CONTINUUM_REGIONS, CREW_CONTINUUM_NEVER,
  packCrewContinuumVertex, packCrewContinuumCluster, validateCrewContinuumManifest,
} from '../js/crew-continuum.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const FITS = option('fits', '.tripo/1550-hd/fit-regions');
const OUT = option('out', 'assets/crew/continuum');
const ONLY = option('only', null);
const TEXTURE_SIZE = Number(option('texture', 4096));
const SAMPLE_SIZE = 2048;
// The far body's base and the stand-in mesh, in triangles.
const CHAIN_BASE_TRIANGLES = Number(option('chain', 6000));
const STAND_IN_TRIANGLES = 20000;
// The far body stops collapsing here: a closed body needs four, and a few more keep a person's two legs apart longer.
const CHAIN_LEAST_TRIANGLES = 6;
// Where a body's points stray from their sphere's joint, in a pose outside the set, this margin is what covers it.
const SPHERE_MARGIN = 0.01;
// Each joint's reach either way about each of its own axes, in degrees, for the range-of-motion poses.
const RANGE_OF_MOTION = [
  [/^(upperarm|thigh)_[lr]$/, 80], [/^(lowerarm|calf)_[lr]$/, 110], [/^(hand|foot)_[lr]$/, 60], [/^ball_/, 40],
  [/^clavicle_/, 25], [/^spine_/, 20], [/^neck_/, 25], [/^head$/, 35], [/twist/, 40],
  [/^(thumb|index|middle|ring|pinky)_/, 70], [/^FACIAL_C_Jaw$/, 25], [/^FACIAL_.*Eyelid/, 30], [/^FACIAL_/, 20],
];
const CLIP_FRAMES = [['Idle', 3], ['Walk', 8], ['Brace', 3]];

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

// ------------------------------------------------------------------------------------------------ parts
// Each vertex's part is its strongest joint's; each triangle's is the part most of its corners hold. A vertex on a
// boundary is copied into each part that uses it, so the copies coarsen along the boundary together, as a seam.
function splitParts(fit) {
  const count = fit.position.length / 3, own = new Uint8Array(count);
  for (let v = 0; v < count; v++) {
    let best = 0;
    for (let k = 1; k < 4; k++) if (fit.weights[v * 4 + k] > fit.weights[v * 4 + best]) best = k;
    own[v] = CREW_CONTINUUM_JOINT_PART[fit.joints[v * 4 + best]];
  }
  const source = Array.from({ length: count }, (_, v) => v), part = Array.from(own), copies = new Map();
  const index = new Uint32Array(fit.index.length);
  for (let t = 0; t < fit.index.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => own[fit.index[t + k]]);
    const p = a === b || a === c ? a : b === c ? b : a;
    for (let k = 0; k < 3; k++) {
      const v = fit.index[t + k];
      if (own[v] === p) { index[t + k] = v; continue; }
      let copy = copies.get(v * 16 + p);
      if (copy === undefined) { copy = source.length; copies.set(v * 16 + p, copy); source.push(v); part.push(p); }
      index[t + k] = copy;
    }
  }
  const n = source.length, pick = (array, width) => {
    const out = new array.constructor(n * width);
    for (let v = 0; v < n; v++) out.set(array.subarray(source[v] * width, source[v] * width + width), v * width);
    return out;
  };
  return {
    count: n, copies: copies.size, index, part: Uint8Array.from(part), source: Uint32Array.from(source),
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
// The joint a set of points answers to most.
function dominantJoint(body, vertices) {
  const sum = new Float64Array(CREW_JOINT_COUNT);
  for (const v of vertices) for (let k = 0; k < 4; k++) sum[body.joints[v * 4 + k]] += body.weights[v * 4 + k];
  let best = 0;
  for (let j = 1; j < CREW_JOINT_COUNT; j++) if (sum[j] > sum[best]) best = j;
  return best;
}
// How far, in any pose, a set of points strays from where joint j alone would carry it.
function jointSlack(body, posed, palettes, vertices, j) {
  const at = [0, 0, 0];
  let worst = 0;
  palettes.forEach((palette, p) => {
    const X = posed[p];
    for (const v of vertices) {
      jointPoint(palette, j, body.position[v * 3], body.position[v * 3 + 1], body.position[v * 3 + 2], at);
      worst = Math.max(worst, Math.hypot(X[v * 3] - at[0], X[v * 3 + 1] - at[1], X[v * 3 + 2] - at[2]));
    }
  });
  return worst;
}

// ------------------------------------------------------------------------------------------------ geometry
const closest = new Float64Array(3);
// Ericson's closest point on triangle a + s*e0 + t*e1 to p: writes [squared distance, s, t] into `closest`.
function closestOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let s, t;
  if (d1 <= 0 && d2 <= 0) { s = 0; t = 0; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { s = 1; t = 0; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { s = d1 / (d1 - d3); t = 0; } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { s = 0; t = 1; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { s = 0; t = d2 / (d2 - d6); } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { t = (d4 - d3) / (d4 - d3 + (d5 - d6)); s = 1 - t; } else if (va + vb + vc > 1e-30) {
              const denominator = 1 / (va + vb + vc);
              s = vb * denominator; t = vc * denominator;
            } else {
              // A sliver with no area: the nearest of its three edges.
              const onEdge = (ex, ey, ez, ox, oy, oz) => { const l = ex * ex + ey * ey + ez * ez; return l > 1e-30 ? Math.min(1, Math.max(0, ((px - ox) * ex + (py - oy) * ey + (pz - oz) * ez) / l)) : 0; };
              const u = onEdge(abx, aby, abz, ax, ay, az), w = onEdge(acx, acy, acz, ax, ay, az), m = onEdge(cx - bx, cy - by, cz - bz, bx, by, bz);
              const gap = (ss, tt) => (ax + abx * ss + acx * tt - px) ** 2 + (ay + aby * ss + acy * tt - py) ** 2 + (az + abz * ss + acz * tt - pz) ** 2;
              const options = [[u, 0], [0, w], [1 - m, m]];
              [s, t] = options.reduce((best, o) => (gap(o[0], o[1]) < gap(best[0], best[1]) ? o : best));
            }
          }
        }
      }
    }
  }
  const qx = ax + abx * s + acx * t - px, qy = ay + aby * s + acy * t - py, qz = az + abz * s + acz * t - pz;
  closest[0] = qx * qx + qy * qy + qz * qz; closest[1] = s; closest[2] = t;
}
// Nearest point of a list of triangles to p, pruned by each triangle's bounding sphere. Returns the triangle's
// position in the list, with its barycentric pair in `closest`; -1 for an empty list.
function nearestTriangle(px, py, pz, list, P, spheres) {
  let best = Infinity, found = -1, bs = 0, bt = 0;
  for (let k = 0; k < list.length; k++) {
    const t = list[k], sx = spheres[t * 4] - px, sy = spheres[t * 4 + 1] - py, sz = spheres[t * 4 + 2] - pz;
    const gap = Math.sqrt(sx * sx + sy * sy + sz * sz) - spheres[t * 4 + 3];
    if (gap > 0 && gap * gap >= best) continue;
    const a = P.corners[t * 3] * 3, b = P.corners[t * 3 + 1] * 3, c = P.corners[t * 3 + 2] * 3, X = P.position;
    closestOnTriangle(px, py, pz, X[a], X[a + 1], X[a + 2], X[b], X[b + 1], X[b + 2], X[c], X[c + 1], X[c + 2]);
    if (closest[0] < best) { best = closest[0]; found = k; bs = closest[1]; bt = closest[2]; }
  }
  closest[0] = best; closest[1] = bs; closest[2] = bt;
  return found;
}
function triangleSpheres(position, corners, triangles) {
  const out = new Float64Array(triangles.length * 4);
  triangles.forEach((t, k) => {
    const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3;
    const cx = (position[a] + position[b] + position[c]) / 3, cy = (position[a + 1] + position[b + 1] + position[c + 1]) / 3, cz = (position[a + 2] + position[b + 2] + position[c + 2]) / 3;
    let r = 0;
    for (const v of [a, b, c]) r = Math.max(r, Math.hypot(position[v] - cx, position[v + 1] - cy, position[v + 2] - cz));
    out.set([cx, cy, cz, r], k * 4);
  });
  return out;
}
// How far apart, in the worst pose, point p (skinned as vertex v, or at barycentric `from` on a triangle) and the
// barycentric point `to` on triangle (a, b, c) are.
function posedGap(posed, v, a, b, c, s, t) {
  const r = 1 - s - t;
  let worst = 0;
  for (const X of posed) {
    const dx = X[v * 3] - (r * X[a * 3] + s * X[b * 3] + t * X[c * 3]);
    const dy = X[v * 3 + 1] - (r * X[a * 3 + 1] + s * X[b * 3 + 1] + t * X[c * 3 + 1]);
    const dz = X[v * 3 + 2] - (r * X[a * 3 + 2] + s * X[b * 3 + 2] + t * X[c * 3 + 2]);
    worst = Math.max(worst, dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(worst);
}
function posedTriangleGap(posed, from, to) {
  let worst = 0;
  for (const X of posed) {
    let dx = 0, dy = 0, dz = 0;
    for (const [[a, b, c], s, t, sign] of [[from[0], from[1], from[2], 1], [to[0], to[1], to[2], -1]]) {
      const r = 1 - s - t;
      dx += sign * (r * X[a * 3] + s * X[b * 3] + t * X[c * 3]);
      dy += sign * (r * X[a * 3 + 1] + s * X[b * 3 + 1] + t * X[c * 3 + 1]);
      dz += sign * (r * X[a * 3 + 2] + s * X[b * 3 + 2] + t * X[c * 3 + 2]);
    }
    worst = Math.max(worst, dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(worst);
}

// ------------------------------------------------------------------------------------------------ clusters
// The builder's group error, measured posed: each point a group removes is matched, in the rest pose, to its nearest
// point on what the group keeps of the same part, and the error is the farthest those two come apart in any pose.
function posedGroupError(body, posed) {
  const kept = new Int32Array(body.count).fill(-1), seen = new Int32Array(body.count).fill(-1), P = { position: body.position, corners: null };
  let stamp = 0;
  return (children, simplified, error) => {
    stamp++;
    const count = simplified.length / 3;
    if (!count) return error;
    for (const v of simplified) kept[v] = stamp;
    const byPart = new Map(), every = Array.from({ length: count }, (_, t) => t);
    for (let t = 0; t < count; t++) {
      const p = body.part[simplified[t * 3]];
      if (!byPart.has(p)) byPart.set(p, []);
      byPart.get(p).push(t);
    }
    P.corners = simplified;
    const spheres = triangleSpheres(body.position, simplified, every);
    let worst = 0;
    for (const v of children) {
      if (kept[v] === stamp || seen[v] === stamp) continue;
      seen[v] = stamp;
      const list = byPart.get(body.part[v]) ?? every;
      const k = nearestTriangle(body.position[v * 3], body.position[v * 3 + 1], body.position[v * 3 + 2], list, P, spheres);
      const t = list[k];
      worst = Math.max(worst, posedGap(posed, v, simplified[t * 3], simplified[t * 3 + 1], simplified[t * 3 + 2], closest[1], closest[2]));
    }
    return worst;
  };
}

async function bakeClusters(body, palettes, posed) {
  const dag = await buildDag({
    id: 0, bark: { pos: body.position, nrm: body.normal, uv: body.uv, idx: body.index },
    leaves: { pos: new Float32Array(0), nrm: new Float32Array(0), uv: new Float32Array(0), vpl: 8 },
    barkParts: body.part, barkGroupError: posedGroupError(body, posed),
  });
  const count = dag.meta.length / 4;
  const verticesOf = (c) => new Set(dag.idx.subarray(dag.meta[c * 4], dag.meta[c * 4] + dag.meta[c * 4 + 1] * 3));
  let groupCount = 0;
  for (let c = 0; c < count; c++) groupCount = Math.max(groupCount, dag.groups[c * 2] + 1, dag.groups[c * 2 + 1] + 1);
  const children = Array.from({ length: groupCount }, () => []);
  for (let c = 0; c < count; c++) if (dag.groups[c * 2 + 1] >= 0) children[dag.groups[c * 2 + 1]].push(c);
  // Each group's sphere, posed by its own joint, grown to hold its points in every pose and every child group's
  // posed sphere, so a coarser level is never projected finer than the level it replaces.
  const groupJoint = new Uint8Array(groupCount), groupRadius = new Float64Array(groupCount), centre = (g) => dag.rec.subarray(children[g][0] * 16 + 4, children[g][0] * 16 + 7);
  const a = [0, 0, 0], b = [0, 0, 0];
  for (let g = 0; g < groupCount; g++) {
    const vertices = new Set();
    for (const c of children[g]) for (const v of verticesOf(c)) vertices.add(v);
    const j = groupJoint[g] = dominantJoint(body, vertices), [x, y, z] = centre(g);
    groupRadius[g] = dag.rec[children[g][0] * 16 + 7] + jointSlack(body, posed, palettes, vertices, j) + SPHERE_MARGIN;
    for (const c of children[g]) {
      const own = dag.groups[c * 2];
      if (own < 0) continue;
      const [ox, oy, oz] = centre(own);
      for (const palette of palettes) {
        jointPoint(palette, j, x, y, z, a);
        jointPoint(palette, groupJoint[own], ox, oy, oz, b);
        groupRadius[g] = Math.max(groupRadius[g], Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) + groupRadius[own]);
      }
    }
  }
  const records = [];
  for (let c = 0; c < count; c++) {
    const r = dag.rec.subarray(c * 16, c * 16 + 16), vertices = verticesOf(c), own = dag.groups[c * 2], parent = dag.groups[c * 2 + 1];
    const cullJoint = dominantJoint(body, vertices), cull = [r[8], r[9], r[10], r[11] + jointSlack(body, posed, palettes, vertices, cullJoint) + SPHERE_MARGIN];
    const lod = own >= 0 ? [...centre(own), groupRadius[own]] : cull, ownJoint = own >= 0 ? groupJoint[own] : cullJoint;
    records.push({
      cluster: c, lod, parentLod: parent >= 0 ? [...centre(parent), groupRadius[parent]] : lod, cull,
      error: r[12], parentError: parent >= 0 ? r[13] : Infinity, ownJoint, parentJoint: parent >= 0 ? groupJoint[parent] : ownJoint, cullJoint,
      part: body.part[dag.idx[dag.meta[c * 4]]], level: dag.meta[c * 4 + 2],
    });
  }
  // Coarsest parent first: what an instance can draw at its nearest point is then a prefix.
  records.sort((p, q) => q.parentError - p.parentError || q.error - p.error);
  const local = new Int32Array(body.count).fill(-1), order = [], indices = new Uint32Array(dag.idx.length), clusters = new Uint32Array(count * CREW_CONTINUUM_CLUSTER_WORDS);
  let first = 0, triangles = 0;
  records.forEach((record, k) => {
    const at = dag.meta[record.cluster * 4], tris = dag.meta[record.cluster * 4 + 1];
    for (let i = 0; i < tris * 3; i++) {
      const v = dag.idx[at + i];
      if (local[v] < 0) { local[v] = order.length; order.push(v); }
      indices[first + i] = local[v];
    }
    clusters.set(packCrewContinuumCluster({ ...record, first, triangles: tris }), k * CREW_CONTINUUM_CLUSTER_WORDS);
    first += tris * 3;
    triangles += tris;
  });
  return { dag, order: Uint32Array.from(order), indices, clusters, count, triangles, groupCount, levels: dag.stats.barkLevels, roots: dag.stats.barkRoots };
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
function bakeTexture(fit, work) {
  const image = path.join(work, fit.mime === 'image/png' ? 'albedo.png' : 'albedo.jpg'), mask = path.join(work, 'mask.u8');
  fs.writeFileSync(image, fit.picture);
  fs.writeFileSync(mask, coverageMask(fit, TEXTURE_SIZE));
  execFileSync('python3', [fileURLToPath(new URL('./crew-continuum-texture.py', import.meta.url)), image, mask, work, `--size=${TEXTURE_SIZE}`, `--sample=${SAMPLE_SIZE}`], { stdio: ['ignore', 'inherit', 'inherit'] });
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
  return { levels: JSON.parse(fs.readFileSync(path.join(work, 'levels.json'), 'utf8')), bc7: fs.readFileSync(path.join(work, 'albedo.bc7.bin')), astc: fs.readFileSync(path.join(work, 'albedo.astc.bin')), at };
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
  return { colour, area, region, medians };
}

// ------------------------------------------------------------------------------------------------ far body
// The fit welded by position into one closed surface, each welded point keeping its own skin and region.
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
// simplifier holds fixed unless permitted to move them; held, they stop it near 45k triangles. `even` asks for
// triangles near equilateral, which the far body's collapses and morph need.
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
function edgeCensus(index) {
  const edges = new Map();
  for (let t = 0; t < index.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = index[t + k], b = index[t + ((k + 1) % 3)], key = a < b ? a * 1048576 + b : b * 1048576 + a;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  let boundary = 0, nonManifold = 0;
  for (const n of edges.values()) { if (n === 1) boundary++; if (n > 2) nonManifold++; }
  return { edges: edges.size, boundary, nonManifold };
}

// Half-edge collapses, cheapest first by quadric error (Garland and Heckbert), each vertex moving onto a neighbour
// so every survivor keeps its own skin. A collapse that would fold a triangle over, pinch the surface (the link
// condition) or cross a region border cheaply is refused or put off.
function collapseChain(position, index, region, least) {
  const V = position.length / 3, T = index.length / 3, corners = Int32Array.from(index), alive = new Uint8Array(T).fill(1), death = new Int32Array(T).fill(-1);
  const Q = new Float64Array(V * 10), fans = Array.from({ length: V }, () => []);
  const p = (v, k) => position[v * 3 + k];
  for (let t = 0; t < T; t++) {
    const [a, b, c] = [corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]];
    const e = [0, 1, 2].map((k) => p(b, k) - p(a, k)), f = [0, 1, 2].map((k) => p(c, k) - p(a, k));
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]], l = Math.hypot(...n) || 1e-12, w = l / 2;
    const [nx, ny, nz] = n.map((x) => x / l), d = -(nx * p(a, 0) + ny * p(a, 1) + nz * p(a, 2));
    const q = [nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d];
    for (const v of [a, b, c]) { for (let k = 0; k < 10; k++) Q[v * 10 + k] += w * q[k]; fans[v].push(t); }
  }
  const quadric = (u, v) => {
    const x = p(v, 0), y = p(v, 1), z = p(v, 2), q = (k) => Q[u * 10 + k] + Q[v * 10 + k];
    return q(0) * x * x + 2 * q(1) * x * y + 2 * q(2) * x * z + 2 * q(3) * x + q(4) * y * y + 2 * q(5) * y * z + 2 * q(6) * y + q(7) * z * z + 2 * q(8) * z + q(9);
  };
  const ring = (v) => { const s = new Set(); for (const t of fans[v]) if (alive[t]) for (let k = 0; k < 3; k++) if (corners[t * 3 + k] !== v) s.add(corners[t * 3 + k]); return s; };
  const cost = (u, v) => {
    const l2 = (p(u, 0) - p(v, 0)) ** 2 + (p(u, 1) - p(v, 1)) ** 2 + (p(u, 2) - p(v, 2)) ** 2;
    return (Math.max(0, quadric(u, v)) + 1e-4 * l2 * l2) * (region[u] === region[v] ? 1 : 6);
  };
  const normalOf = (a, b, c) => {
    const e = [0, 1, 2].map((k) => p(b, k) - p(a, k)), f = [0, 1, 2].map((k) => p(c, k) - p(a, k));
    return [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
  };
  // Folds are refused while the body has triangles to spare; near the core, only a triangle turned right over is.
  const valid = (u, v) => {
    const fold = living > 400 ? 0.2 : living > 60 ? -0.3 : -0.9;
    const ru = ring(u), rv = ring(v);
    let shared = 0, common = 0;
    for (const t of fans[u]) if (alive[t] && (corners[t * 3] === v || corners[t * 3 + 1] === v || corners[t * 3 + 2] === v)) shared++;
    for (const w of ru) if (rv.has(w)) common++;
    if (shared !== 2 || common !== 2) return false;
    for (const t of fans[u]) {
      if (!alive[t]) continue;
      const [a, b, c] = [corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]];
      if (a === v || b === v || c === v) continue;
      const before = normalOf(a, b, c), after = normalOf(a === u ? v : a, b === u ? v : b, c === u ? v : c);
      const lb = Math.hypot(...before), la = Math.hypot(...after);
      if (la < 1e-10 || (lb > 1e-10 && (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (lb * la) < fold)) return false;
    }
    return true;
  };
  // A binary heap of [cost, u, v, stamp of u, stamp of v].
  const heap = [], stamp = new Int32Array(V);
  const push = (item) => { heap.push(item); let i = heap.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (heap[j][0] <= heap[i][0]) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  const offer = (u) => { for (const w of ring(u)) { push([cost(u, w), u, w, stamp[u], stamp[w]]); push([cost(w, u), w, u, stamp[w], stamp[u]]); } };
  for (let v = 0; v < V; v++) for (const w of ring(v)) push([cost(v, w), v, w, stamp[v], stamp[w]]);
  const dieStep = new Int32Array(V).fill(-1), target = new Int32Array(V).fill(-1), steps = [];
  let living = T;
  while (living > least && heap.length) {
    const [, u, v, su, sv] = pop();
    if (su !== stamp[u] || sv !== stamp[v] || dieStep[u] >= 0 || dieStep[v] >= 0 || !valid(u, v)) continue;
    const step = steps.length;
    steps.push({ u, v });
    dieStep[u] = step; target[u] = v;
    for (const t of fans[u]) {
      if (!alive[t]) continue;
      if (corners[t * 3] === v || corners[t * 3 + 1] === v || corners[t * 3 + 2] === v) { alive[t] = 0; death[t] = step + 1; living--; continue; }
      for (let k = 0; k < 3; k++) if (corners[t * 3 + k] === u) corners[t * 3 + k] = v;
      fans[v].push(t);
    }
    for (let k = 0; k < 10; k++) Q[v * 10 + k] += Q[u * 10 + k];
    const neighbours = ring(v);
    stamp[v]++;
    for (const w of neighbours) stamp[w]++;
    offer(v);
    for (const w of neighbours) offer(w);
  }
  return { dieStep, target, death, steps, living };
}
// Where vertex v has gone by step s.
const ancestor = (chain, v, s) => { while (chain.dieStep[v] >= 0 && chain.dieStep[v] < s) v = chain.target[v]; return v; };

// The outline a mesh casts, front and side, on a grid over the body: pixels covered, and each pixel's nearest region.
function outline(position, normal, corners, triangles, inflate, frame, regionOf) {
  const { low, size, cells } = frame, views = [[0, 1, 2], [2, 1, 0]], result = [];
  for (const [ax, ay, az] of views) {
    const depth = new Float32Array(cells * cells).fill(Infinity), region = new Int8Array(cells * cells).fill(-1);
    for (const t of triangles) {
      const v = [0, 1, 2].map((k) => corners[t * 3 + k]);
      const x = v.map((w) => ((position[w * 3 + ax] + normal[w * 3 + ax] * inflate - low[ax]) / size) * cells);
      const y = v.map((w) => ((position[w * 3 + ay] + normal[w * 3 + ay] * inflate - low[ay]) / size) * cells);
      const z = v.map((w) => position[w * 3 + az]);
      const area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]);
      if (Math.abs(area) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(...x))), x1 = Math.min(cells - 1, Math.ceil(Math.max(...x))), y0 = Math.max(0, Math.floor(Math.min(...y))), y1 = Math.min(cells - 1, Math.ceil(Math.max(...y)));
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5, cy = py + 0.5, w0 = ((x[1] - cx) * (y[2] - cy) - (x[2] - cx) * (y[1] - cy)) / area, w1 = ((x[2] - cx) * (y[0] - cy) - (x[0] - cx) * (y[2] - cy)) / area, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * z[0] + w1 * z[1] + w2 * z[2], at = py * cells + px;
        if (d < depth[at]) { depth[at] = d; region[at] = regionOf ? regionOf(t) : 0; }
      }
    }
    let covered = 0;
    for (const r of region) if (r >= 0) covered++;
    result.push({ covered, region });
  }
  return result;
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
function bakeChain(fit, welded, surface, posedOf) {
  const base = simplifyWelded(fit, welded, CHAIN_BASE_TRIANGLES, true), V = base.vertices.length, T = base.index.length / 3;
  const census = edgeCensus(base.index);
  const position = new Float32Array(V * 3), normal = new Float32Array(V * 3), region = new Uint8Array(V);
  base.vertices.forEach((v, i) => { position.set(fit.position.subarray(v * 3, v * 3 + 3), i * 3); normal.set(welded.normal.subarray(v * 3, v * 3 + 3), i * 3); region[i] = fit.region[v]; });
  // Each base point's colour: the area-weighted mean of the source triangles nearest it along the surface, within its
  // own region (assignToBase), so no colour crosses from shirt to skin or from an arm to the body beside it.
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
  const colour = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    const median = surface.medians[region[i]] ?? [0.5, 0.5, 0.5];
    for (let k = 0; k < 3; k++) colour[i * 3 + k] = sums[i * 4 + 3] > 0 ? sums[i * 4 + k] / sums[i * 4 + 3] : median[k];
  }
  // The base's own error against the whole body, posed: a sample of source points, each matched by part to its
  // nearest base triangle at rest. Its vertex colours blur what lies within half their spacing, which counts too.
  const baseCorners = Uint32Array.from(base.index, (i) => base.vertices[i]), allBase = Array.from({ length: T }, (_, t) => t);
  const basePart = Uint8Array.from(allBase, (t) => {
    const [a, b, c] = [0, 1, 2].map((k) => CREW_CONTINUUM_JOINT_PART[strongest(fit, baseCorners[t * 3 + k])]);
    return a === b || a === c ? a : b === c ? b : a;
  });
  const byPart = new Map();
  allBase.forEach((t) => { if (!byPart.has(basePart[t])) byPart.set(basePart[t], []); byPart.get(basePart[t]).push(t); });
  const fitP = { position: fit.position, corners: baseCorners }, baseSpheres = triangleSpheres(fit.position, baseCorners, allBase);
  const posed = posedOf(fit), stride = Math.max(1, Math.floor(fit.position.length / 3 / 40000));
  let geometric = 0;
  for (let v = 0; v < fit.position.length / 3; v += stride) {
    const list = byPart.get(CREW_CONTINUUM_JOINT_PART[strongest(fit, v)]) ?? allBase;
    const k = nearestTriangle(fit.position[v * 3], fit.position[v * 3 + 1], fit.position[v * 3 + 2], list, fitP, baseSpheres), t = list[k];
    geometric = Math.max(geometric, posedGap(posed, v, baseCorners[t * 3], baseCorners[t * 3 + 1], baseCorners[t * 3 + 2], closest[1], closest[2]));
  }
  const surfaceArea = (corners, triangles, X) => triangles.reduce((sum, t) => {
    const [a, b, c] = [0, 1, 2].map((k) => corners[t * 3 + k] * 3), e = [0, 1, 2].map((k) => X[b + k] - X[a + k]), f = [0, 1, 2].map((k) => X[c + k] - X[a + k]);
    return sum + 0.5 * Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]);
  }, 0);
  const appearance = (area, vertices) => 0.5 * Math.sqrt(area / Math.max(vertices, 1));
  const baseError = Math.max(geometric, appearance(surfaceArea(base.index, allBase, position), V));

  const chain = collapseChain(position, base.index, region, CHAIN_LEAST_TRIANGLES), S = chain.steps.length;
  let depth = 0;
  for (let v = 0; v < V; v++) { let d = 0; for (let w = v; chain.dieStep[w] >= 0; w = chain.target[w]) d++; depth = Math.max(depth, d); }
  // Errors and inflation, measured at every eighth step and the last few, between them taken in proportion.
  const baseFans = Array.from({ length: V }, () => []);
  allBase.forEach((t) => { for (let k = 0; k < 3; k++) baseFans[base.index[t * 3 + k]].push(t); });
  const chainPosed = posed.map((X) => { const out = new Float32Array(V * 3); base.vertices.forEach((v, i) => out.set(X.subarray(v * 3, v * 3 + 3), i * 3)); return out; });
  const P = { position, corners: base.index }, spheres = triangleSpheres(position, base.index, allBase);
  const low = [0, 1, 2].map((k) => Math.min(...Array.from({ length: V }, (_, i) => position[i * 3 + k])) - 0.15), high = [0, 1, 2].map((k) => Math.max(...Array.from({ length: V }, (_, i) => position[i * 3 + k])) + 0.15);
  const frame = { low, size: Math.max(...high.map((h, k) => h - low[k])), cells: 192 };
  const baseOutline = outline(position, normal, base.index, allBase, 0, frame, (t) => {
    const r = [0, 1, 2].map((k) => region[base.index[t * 3 + k]]);
    return r[0] === r[1] || r[0] === r[2] ? r[0] : r[1] === r[2] ? r[1] : r[0];
  });
  const wanted = baseOutline[0].covered + baseOutline[1].covered;
  const measured = new Map(), sampled = new Set([0, S]);
  for (let s = 0; s <= S; s += 8) sampled.add(s);
  for (let s = Math.max(0, S - 48); s <= S; s++) sampled.add(s);
  const stepCorners = new Uint32Array(T * 3);
  for (const s of [...sampled].sort((p, q) => p - q)) {
    const living = allBase.filter((t) => chain.death[t] < 0 || chain.death[t] > s);
    for (const t of living) for (let k = 0; k < 3; k++) stepCorners[t * 3 + k] = ancestor(chain, base.index[t * 3 + k], s);
    const fans = new Map();
    for (const t of living) for (let k = 0; k < 3; k++) { const a = stepCorners[t * 3 + k]; if (!fans.has(a)) fans.set(a, []); fans.get(a).push(t); }
    const stepP = { position, corners: stepCorners }, stepSpheres = new Float64Array(T * 4);
    stepSpheres.set(triangleSpheres(position, stepCorners, allBase));
    let error = 0;
    // Each base point against the triangles of the vertex it has collapsed into.
    for (let v = 0; v < V; v++) {
      const list = fans.get(ancestor(chain, v, s)) ?? [];
      const k = nearestTriangle(position[v * 3], position[v * 3 + 1], position[v * 3 + 2], list, stepP, stepSpheres);
      if (k < 0) continue;
      const t = list[k];
      error = Math.max(error, posedGap(chainPosed, v, stepCorners[t * 3], stepCorners[t * 3 + 1], stepCorners[t * 3 + 2], closest[1], closest[2]));
    }
    // Each surviving triangle's middle against the base it has replaced.
    const members = new Map();
    for (let v = 0; v < V; v++) { const a = ancestor(chain, v, s); if (!members.has(a)) members.set(a, []); members.get(a).push(v); }
    for (const t of living) {
      const [a, b, c] = [0, 1, 2].map((k) => stepCorners[t * 3 + k]), candidates = new Set();
      for (const corner of [a, b, c]) for (const m of members.get(corner) ?? []) for (const u of baseFans[m]) candidates.add(u);
      const list = [...candidates], x = (position[a * 3] + position[b * 3] + position[c * 3]) / 3, y = (position[a * 3 + 1] + position[b * 3 + 1] + position[c * 3 + 1]) / 3, z = (position[a * 3 + 2] + position[b * 3 + 2] + position[c * 3 + 2]) / 3;
      const k = nearestTriangle(x, y, z, list, P, spheres);
      if (k < 0) continue;
      const u = list[k];
      error = Math.max(error, posedTriangleGap(chainPosed, [[a, b, c], 1 / 3, 1 / 3], [[base.index[u * 3], base.index[u * 3 + 1], base.index[u * 3 + 2]], closest[1], closest[2]]));
    }
    const vertices = fans.size, area = surfaceArea(stepCorners, living, position);
    // How far along its normals the surface must grow to cast the base's outline again.
    let inflate = 0;
    const cast = (d) => { const o = outline(position, normal, stepCorners, living, d, frame, null); return o[0].covered + o[1].covered; };
    if (s > 0 && cast(0) < wanted) {
      let lo = 0, hi = 0.08;
      for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (cast(mid) < wanted) lo = mid; else hi = mid; }
      inflate = (lo + hi) / 2;
    }
    measured.set(s, { error: Math.max(baseError + error, appearance(area, vertices)), inflate, living: living.length });
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
  for (let s = 1; s <= S; s++) errors[s] = Math.max(errors[s], errors[s - 1] * 1.0005 + 1e-6);
  // No step of a body under 2.5 m can be farther from it than its own height.
  if (!(errors[S] < 2.5)) throw Error(`The far body's last step is ${errors[S]} m in error`);

  // Triangles in order of death, latest first: those alive at step s are a prefix.
  const order = allBase.slice().sort((p, q) => (chain.death[q] < 0 ? Infinity : chain.death[q]) - (chain.death[p] < 0 ? Infinity : chain.death[p]));
  const aliveAt = (s) => order.filter((t) => chain.death[t] < 0 || chain.death[t] > s).length;
  const steps = new Uint32Array((S + 1) * CREW_CONTINUUM_STEP_WORDS), stepFloats = new Float32Array(steps.buffer);
  {
    // Alive counts from death steps directly.
    const dying = new Int32Array(S + 2);
    for (let t = 0; t < T; t++) if (chain.death[t] >= 0) dying[chain.death[t]]++;
    let alive = T;
    for (let s = 0; s <= S; s++) {
      alive -= dying[s];
      steps[s * CREW_CONTINUUM_STEP_WORDS] = alive;
      stepFloats[s * CREW_CONTINUUM_STEP_WORDS + 1] = errors[s];
      stepFloats[s * CREW_CONTINUUM_STEP_WORDS + 2] = inflates[s];
    }
    if (steps[0] !== T || steps[S * CREW_CONTINUUM_STEP_WORDS] !== aliveAt(S)) throw Error('Chain prefix counts disagree');
  }
  // The splat: the base's bounds, posed by the pelvis, with the outline's area and each region's share of it.
  const bottom = Math.min(...Array.from({ length: V }, (_, i) => position[i * 3 + 1])), top = Math.max(...Array.from({ length: V }, (_, i) => position[i * 3 + 1]));
  const cellArea = (frame.size / frame.cells) ** 2, ry = (top - bottom) / 2, outlineArea = (wanted / 2) * cellArea;
  const shares = CREW_CONTINUUM_REGIONS.map(() => 0), means = CREW_CONTINUUM_REGIONS.map(() => [0, 0, 0]);
  for (const view of baseOutline) for (const r of view.region) if (r >= 0) shares[r]++;
  for (let i = 0; i < V; i++) for (let k = 0; k < 3; k++) means[region[i]][k] += colour[i * 3 + k];
  const counts = CREW_CONTINUUM_REGIONS.map((_, r) => region.reduce((n, x) => n + (x === r), 0));
  const centre = [0, 1, 2].map((k) => (k === 1 ? (top + bottom) / 2 : (Math.min(...Array.from({ length: V }, (_, i) => position[i * 3 + k])) + Math.max(...Array.from({ length: V }, (_, i) => position[i * 3 + k]))) / 2));
  const splat = {
    joint: CREW_JOINT_NAMES.indexOf('pelvis'), centre: centre.map((v) => +v.toFixed(4)), ry: +ry.toFixed(4), rx: +(outlineArea / (Math.PI * ry)).toFixed(4),
    regions: CREW_CONTINUUM_REGIONS.map((name, r) => ({ name, share: +(shares[r] / wanted).toFixed(4), mean: counts[r] ? means[r].map((v) => +(v / counts[r]).toFixed(5)) : null })),
  };
  return {
    base, position, normal, colour, region, chain, steps, order, depth, census, splat,
    sources: base.vertices, skin: (i) => ({ joints: Array.from(fit.joints.subarray(base.vertices[i] * 4, base.vertices[i] * 4 + 4)), weights: Array.from(fit.weights.subarray(base.vertices[i] * 4, base.vertices[i] * 4 + 4)) }),
    stats: { baseTriangles: T, baseVertices: V, baseError: +baseError.toFixed(4), baseGeometric: +geometric.toFixed(4), simplifyError: +base.error.toFixed(4), steps: S, coreTriangles: steps[S * CREW_CONTINUUM_STEP_WORDS], depth, errorRange: [+errors[0].toFixed(4), +errors[S].toFixed(4)], inflateMax: +Math.max(...inflates).toFixed(4), boundaryEdges: census.boundary, nonManifoldEdges: census.nonManifold },
  };
}
function strongest(fit, v) {
  let best = 0;
  for (let k = 1; k < 4; k++) if (fit.weights[v * 4 + k] > fit.weights[v * 4 + best]) best = k;
  return fit.joints[v * 4 + best];
}

// ------------------------------------------------------------------------------------------------ body.glb
// The fit's skeleton and clips with a light stand-in mesh, painted garment by garment as the crew shader reads an
// untextured body: each point's shade against its region's median, plus twice its garment in blue.
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
    meshes: [{ name: 'continuum stand-in', primitives: [{ attributes, indices, material: 0 }] }],
    materials: [{ name: 'Crew character material', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }],
    skins: [{ name: g.skins[0].name, joints: g.skins[0].joints, inverseBindMatrices }],
    animations, buffers: [{ byteLength: length }], bufferViews: views, accessors,
    extras: { ...g.extras, crewContinuum: 'stand-in: the body is drawn from the continuum streams' },
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks), header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  jsonHeader.writeUInt32LE(text.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return { bytes: Buffer.concat([header, jsonHeader, text, binHeader, bin]), triangles: stand.index.length / 3, vertices: n };
}
// How far the stand-in's footing and seating, which the pose code measures from the mesh, are from the full body's.
function contactDrift(fit, bytes) {
  const stand = createSkinAnimator(readGLB(bytes)), full = fit.animator, drift = {};
  for (const side of ['l', 'r']) {
    const a = full.footContacts?.[side], b = stand.footContacts?.[side];
    if (!a || !b) throw Error(`No ${side} foot contact on the ${a ? 'stand-in' : 'fit'}`);
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
  const started = Date.now(), lap = (label) => console.log(`  ${label.padEnd(10)} ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const file = path.join(FITS, `${entry.id}.glb`), fit = readFit(file), work = fs.mkdtempSync(path.join(os.tmpdir(), `crew-continuum-${entry.id}-`));
  console.log(`${entry.id}: ${fit.position.length / 3} vertices, ${fit.index.length / 3} triangles`);
  try {
    const palettes = samplePoses(fit.animator), body = splitParts(fit), posed = palettes.map((palette) => posedPositions(palette, body));
    lap(`${palettes.length} poses`);
    const texture = bakeTexture(fit, work), surface = surfaceColours(fit, texture);
    lap('albedo');
    const clusters = await bakeClusters(body, palettes, posed);
    lap('clusters');
    // The far body works on the unsplit fit: map its posed points from the split body's (each source vertex is itself).
    const posedOf = () => posed.map((X) => X.subarray(0, fit.position.length * 1));
    const welded = weld(fit), far = bakeChain(fit, welded, surface, posedOf);
    lap('far body');
    posed.length = 0;
    const standIn = writeBody(fit, welded, surface, texture), drift = contactDrift(fit, standIn.bytes);
    lap('body.glb');

    // Quantization over the body's bounds, shared by both streams.
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity], uvLow = [Infinity, Infinity], uvHigh = [-Infinity, -Infinity];
    for (let v = 0; v < body.count; v++) {
      for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], body.position[v * 3 + k]); high[k] = Math.max(high[k], body.position[v * 3 + k]); }
      for (let k = 0; k < 2; k++) { uvLow[k] = Math.min(uvLow[k], body.uv[v * 2 + k]); uvHigh[k] = Math.max(uvHigh[k], body.uv[v * 2 + k]); }
    }
    const quant = { low, posScale: Math.max(...high.map((h, k) => h - low[k])), uvLow, uvScale: uvHigh.map((h, k) => Math.max(h - uvLow[k], 1e-6)) };
    const vertices = new Uint32Array(clusters.order.length * CREW_CONTINUUM_VERTEX_WORDS);
    clusters.order.forEach((v, i) => vertices.set(packCrewContinuumVertex({
      position: body.position.subarray(v * 3, v * 3 + 3), normal: body.normal.subarray(v * 3, v * 3 + 3), uv: body.uv.subarray(v * 2, v * 2 + 2),
      joints: Array.from(body.joints.subarray(v * 4, v * 4 + 4)), weights: Array.from(body.weights.subarray(v * 4, v * 4 + 4)), part: body.part[v], region: body.region[v],
    }, quant), i * CREW_CONTINUUM_VERTEX_WORDS));
    // The far body: its vertices, then each vertex's collapse (the step it goes at, and where), its triangles in
    // order of death, and its steps.
    const V = far.position.length / 3, T = far.base.index.length / 3, S = far.chain.steps.length;
    const chainWords = new Uint32Array(V * CREW_CONTINUUM_VERTEX_WORDS + V + T * 3 + far.steps.length);
    for (let i = 0; i < V; i++) chainWords.set(packCrewContinuumVertex({
      position: far.position.subarray(i * 3, i * 3 + 3), normal: far.normal.subarray(i * 3, i * 3 + 3), colour: far.colour.subarray(i * 3, i * 3 + 3), ...far.skin(i), part: 0, region: far.region[i],
    }, quant), i * CREW_CONTINUUM_VERTEX_WORDS);
    const recordsAt = V * CREW_CONTINUUM_VERTEX_WORDS, indicesAt = recordsAt + V, stepsAt = indicesAt + T * 3;
    for (let i = 0; i < V; i++) chainWords[recordsAt + i] = ((far.chain.dieStep[i] < 0 ? CREW_CONTINUUM_NEVER : far.chain.dieStep[i]) | ((far.chain.target[i] < 0 ? i : far.chain.target[i]) << 16)) >>> 0;
    far.order.forEach((t, k) => { for (let c = 0; c < 3; c++) chainWords[indicesAt + k * 3 + c] = far.base.index[t * 3 + c]; });
    chainWords.set(far.steps, stepsAt);

    const dir = path.join(OUT, entry.id);
    fs.mkdirSync(dir, { recursive: true });
    const files = {
      'vertices.bin': receipt(asBytes(vertices), dir, 'vertices.bin'),
      'indices.bin': receipt(asBytes(clusters.indices), dir, 'indices.bin'),
      'clusters.bin': receipt(asBytes(clusters.clusters), dir, 'clusters.bin'),
      'chain.bin': receipt(asBytes(chainWords), dir, 'chain.bin'),
      'albedo.bc7.bin': receipt(texture.bc7, dir, 'albedo.bc7.bin'),
      'albedo.astc.bin': receipt(texture.astc, dir, 'albedo.astc.bin'),
    };
    fs.writeFileSync(path.join(dir, 'body.glb'), standIn.bytes);
    const manifest = {
      format: CREW_CONTINUUM_FORMAT, version: CREW_CONTINUUM_VERSION, id: entry.id, sex: entry.sex, role: entry.role,
      source: { file: path.basename(file), sha256: fit.sha256, vertices: fit.position.length / 3, triangles: fit.index.length / 3 },
      vertexWords: CREW_CONTINUUM_VERTEX_WORDS, clusterWords: CREW_CONTINUUM_CLUSTER_WORDS, stepWords: CREW_CONTINUUM_STEP_WORDS,
      vertexCount: clusters.order.length, indexCount: clusters.indices.length, clusterCount: clusters.count,
      quantization: { low: quant.low.map((v) => +v.toFixed(6)), posScale: +quant.posScale.toFixed(6), uvLow: quant.uvLow.map((v) => +v.toFixed(6)), uvScale: quant.uvScale.map((v) => +v.toFixed(6)) },
      parts: CREW_CONTINUUM_PARTS, regions: CREW_CONTINUUM_REGIONS, regionMedians: surface.medians,
      clusters: { triangles: clusters.triangles, levels: clusters.levels, roots: clusters.roots, groups: clusters.groupCount, partCopies: body.copies, rootError: +Math.max(...Array.from({ length: clusters.count }, (_, c) => new Float32Array(clusters.clusters.buffer, c * CREW_CONTINUUM_CLUSTER_WORDS * 4, 14)[12])).toFixed(4) },
      chain: { vertexCount: V, triangleCount: T, stepCount: S, offsets: { vertices: 0, records: recordsAt, indices: indicesAt, steps: stepsAt }, ...far.stats },
      splat: far.splat,
      texture: { width: texture.levels.width, height: texture.levels.height, coverage: texture.levels.coverage, levels: texture.levels.levels },
      body: { file: 'body.glb', bytes: standIn.bytes.length, sha256: createHash('sha256').update(standIn.bytes).digest('hex'), triangles: standIn.triangles, vertices: standIn.vertices, contactDrift: drift },
      poses: palettes.length, files,
    };
    validateCrewContinuumManifest(manifest);
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
    const gz = Object.values(files).reduce((s, f) => s + f.gzip.bytes, 0);
    console.log(`  ${clusters.count} clusters (${clusters.triangles} triangles, ${clusters.levels} levels, root error ${manifest.clusters.rootError} m) · far body ${T} → ${far.stats.coreTriangles} triangles in ${S} steps, ${far.stats.errorRange.join('–')} m · ${(gz / 1048576).toFixed(1)} MiB gzipped · ${((Date.now() - started) / 1000).toFixed(0)} s`);
    console.log('  contact drift', drift, 'base', { error: far.stats.baseError, geometric: far.stats.baseGeometric, boundary: far.stats.boundaryEdges, nonManifold: far.stats.nonManifoldEdges, depth: far.stats.depth });
    return manifest;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await MeshoptSimplifier.ready;
for (const entry of CREW_CONTINUUM_BODIES) {
  if (ONLY && !ONLY.split(',').includes(entry.id)) continue;
  await bake(entry);
}
