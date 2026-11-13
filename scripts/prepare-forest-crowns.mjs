#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes each tree's single-mesh progressive continuum crown (version 3): one genus-0 closed surface in the
// shape of its leaves plus one trunk column, sorted by half-edge collapse retirement order with exact per-step
// ancestor maps and silhouette-preserving scale factors down to a 4-triangle core and 1-triangle horizon splat.
//   node scripts/prepare-forest-crowns.mjs portugal [--only=oak] [--preview=folder]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { FOREST_CLUSTER_VERTEX_WORDS, packForestClusterVertex } from '../js/forest-clusters.js';
import { FOREST_CROWN_NEAREST, FOREST_CROWN_STEP_WORDS, FOREST_CROWN_VERSION } from '../js/forest-crowns.js';
import { CLOSE_METRES, CLUSTER_WORDS, CROWN_FINE_CELLS, compact, cross, leafField, linear, normalize, octahedral, openForestLeaves, relax, seenFrom, surface, vertexNormals, volume } from './forest-leaf-field.mjs';

const args = process.argv.slice(2);
const packName = args.find((a) => !a.startsWith('--')) ?? 'portugal';
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const previewDir = args.find((a) => a.startsWith('--preview='))?.slice(10);
const dir = path.join('assets/forest-scenery', packName);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const { clusterManifest, clusterIndices, clusterWords, clusterFloats, leafImage, clusterVertex, leafSamples } = openForestLeaves(dir);

const BASE_FOLIAGE_TRIANGLES = 300;
const MIN_FOLIAGE_TRIANGLES = 6;
const BASE_TRUNK_SIDES = 5, BASE_TRUNK_RINGS = 4, TRUNK_FOOT_METRES = 0.03;

const REFERENCE_PIXELS_PER_METRE = 1008, REFERENCE_LEAF_PIXELS = 1.2, REFERENCE_WOOD_PIXELS = 1.5;
const CHANGE_ERROR_METRES = FOREST_CROWN_NEAREST * REFERENCE_LEAF_PIXELS / REFERENCE_PIXELS_PER_METRE;
const ROUNDING = 8;
const CREASE_SHARE = 0.03, CREASE_DEPTH = 0.4, CREASE_LIFT = 0.12;
const BACKDROP_SHADE = 0.5;
const OPEN_GROWN = { subtropical: 25 };

const f32Buf = new ArrayBuffer(4), f32View = new Float32Array(f32Buf), u32View = new Uint32Array(f32Buf);
const floatBits = (v) => { f32View[0] = v; return u32View[0]; };

function orientOutward(mesh) {
  if (volume(mesh) < 0) {
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const swap = mesh.indices[i + 1];
      mesh.indices[i + 1] = mesh.indices[i + 2];
      mesh.indices[i + 2] = swap;
    }
  }
  return mesh;
}

function isClosedSingleBody(mesh) {
  if (!mesh || !mesh.indices.length || mesh.indices.length % 3) return false;
  const directed = new Set(), undirected = new Set(), parent = new Map(), faceKeys = new Set();
  const find = (v) => { let r = v; while (parent.get(r) !== r) r = parent.get(r); parent.set(v, r); return r; };
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i], b = mesh.indices[i + 1], c = mesh.indices[i + 2];
    if (a === b || b === c || c === a) return false;
    const fk = [a, b, c].sort((x, y) => x - y).join(',');
    if (faceKeys.has(fk)) return false;
    faceKeys.add(fk);
    for (const v of [a, b, c]) if (!parent.has(v)) parent.set(v, v);
    parent.set(find(b), find(a));
    parent.set(find(c), find(a));
    for (const [u, w] of [[a, b], [b, c], [c, a]]) {
      const dk = `${u},${w}`;
      if (directed.has(dk)) return false;
      directed.add(dk);
      undirected.add(u < w ? `${u},${w}` : `${w},${u}`);
    }
  }
  if (directed.size !== undirected.size * 2) return false;
  const roots = new Set();
  for (const v of parent.keys()) roots.add(find(v));
  return roots.size === 1 && volume(mesh) > 1e-6;
}

function isGenusZeroClosedManifold(mesh) {
  if (!mesh || !mesh.indices.length || mesh.indices.length % 3) return false;
  const triCount = mesh.indices.length / 3;
  const directed = new Set(), undirected = new Set(), vertFaces = new Map(), faceKeys = new Set(), parent = new Map();
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3], b = mesh.indices[t * 3 + 1], c = mesh.indices[t * 3 + 2];
    if (a === b || b === c || c === a) return false;
    const fk = [a, b, c].sort((x, y) => x - y).join(',');
    if (faceKeys.has(fk)) return false;
    faceKeys.add(fk);
    for (const v of [a, b, c]) {
      if (!parent.has(v)) parent.set(v, v);
      let list = vertFaces.get(v);
      if (!list) { list = []; vertFaces.set(v, list); }
      list.push(t);
    }
    parent.set(find(b), find(a));
    parent.set(find(c), find(a));
    for (const [u, w] of [[a, b], [b, c], [c, a]]) {
      const dk = `${u},${w}`;
      if (directed.has(dk)) return false;
      directed.add(dk);
      undirected.add(u < w ? `${u},${w}` : `${w},${u}`);
    }
  }
  if (directed.size !== undirected.size * 2) return false;
  const roots = new Set();
  for (const v of parent.keys()) roots.add(find(v));
  if (roots.size !== 1) return false;
  for (const [v, faces] of vertFaces.entries()) {
    if (faces.length < 3) return false;
    const visited = new Set([faces[0]]), stack = [faces[0]];
    while (stack.length) {
      const f = stack.pop();
      const fa = mesh.indices[f * 3], fb = mesh.indices[f * 3 + 1], fc = mesh.indices[f * 3 + 2];
      for (const other of faces) {
        if (visited.has(other)) continue;
        const oa = mesh.indices[other * 3], ob = mesh.indices[other * 3 + 1], oc = mesh.indices[other * 3 + 2];
        let shared = 0;
        for (const x of [fa, fb, fc]) if (x !== v && (x === oa || x === ob || x === oc)) shared++;
        if (shared >= 1) { visited.add(other); stack.push(other); }
      }
    }
    if (visited.size !== faces.length) return false;
  }
  return volume(mesh) > 1e-5 && (vertFaces.size - undirected.size + triCount === 2);
}

// Guaranteed genus-0 sphere shrink-wrapped onto the fine leaf crown envelope (fallback if voxel topology has handles).
function shrinkWrapGenusZeroCrown(fineMesh, subdivisions = 2) {
  const phi = (1 + Math.sqrt(5)) / 2;
  const verts = [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ].map(normalize);
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdivisions; s++) {
    const midCache = new Map();
    const mid = (a, b) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      if (midCache.has(k)) return midCache.get(k);
      const id = verts.length;
      verts.push(normalize([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2, (verts[a][2] + verts[b][2]) / 2]));
      midCache.set(k, id);
      return id;
    };
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const fPos = fineMesh.positions, fCount = fPos.length / 3;
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < fPos.length; i++) { low[i % 3] = Math.min(low[i % 3], fPos[i]); high[i % 3] = Math.max(high[i % 3], fPos[i]); }
  const center = [0, 1, 2].map((k) => (low[k] + high[k]) * 0.5);
  const radii = [0, 1, 2].map((k) => Math.max(0.25, (high[k] - low[k]) * 0.5));
  const positions = new Float32Array(verts.length * 3);
  for (let v = 0; v < verts.length; v++) {
    const d = verts[v];
    let best = 0, wSum = 0, rSum = 0;
    for (let i = 0; i < fCount; i++) {
      const rx = (fPos[i * 3] - center[0]) / radii[0], ry = (fPos[i * 3 + 1] - center[1]) / radii[1], rz = (fPos[i * 3 + 2] - center[2]) / radii[2];
      const rLen = Math.hypot(rx, ry, rz);
      if (rLen < 1e-4) continue;
      const cos = (rx * d[0] + ry * d[1] + rz * d[2]) / rLen;
      if (cos > 0.86) {
        const w = ((cos - 0.86) / 0.14) ** 2;
        wSum += w; rSum += w * rLen;
        if (rLen * cos > best) best = rLen * cos;
      }
    }
    const reach = wSum > 1e-3 ? 0.65 * (rSum / wSum) + 0.35 * best : Math.max(0.55, best);
    positions[v * 3] = center[0] + d[0] * radii[0] * reach;
    positions[v * 3 + 1] = center[1] + d[1] * radii[1] * reach;
    positions[v * 3 + 2] = center[2] + d[2] * radii[2] * reach;
  }
  return relax(orientOutward({ positions, indices: Uint32Array.from(faces.flat()) }), 2);
}

function trunkColumn(p, top) {
  const sides = BASE_TRUNK_SIDES, rings = BASE_TRUNK_RINGS;
  const c = clusterManifest.prototypes.find((q) => q.id === p.id), woodClusters = [];
  let coarsest = 0;
  for (let i = c.firstCluster; i < c.firstCluster + c.clusterCount; i++) {
    const at = i * CLUSTER_WORDS;
    if (clusterWords[at + 15] & 1) continue;
    woodClusters.push({ err: clusterFloats[at + 12], parentErr: clusterFloats[at + 13], first: clusterWords[at + 14], triangles: clusterWords[at + 15] >>> 1 });
    coarsest = Math.max(coarsest, clusterFloats[at + 12]);
  }
  const errorMetres = Math.min(FOREST_CROWN_NEAREST * REFERENCE_WOOD_PIXELS / REFERENCE_PIXELS_PER_METRE, coarsest), wood = [];
  let highest = -Infinity;
  for (const k of woodClusters) if (k.err <= errorMetres && k.parentErr > errorMetres) for (let t = 0; t < k.triangles; t++) {
    const v = [0, 1, 2].map((n) => clusterVertex(c, clusterIndices[k.first + t * 3 + n])), [a, b, d] = v.map((q) => q.position);
    const area = Math.hypot(...cross(a.map((q, n) => b[n] - q), a.map((q, n) => d[n] - q))) / 2;
    if (!(area > 0)) continue;
    const bark = leafImage(p.nativeMaterials[v[0].material].albedo.file).mean, mean = (get) => (get(v[0]) + get(v[1]) + get(v[2])) / 3;
    wood.push({ area, corners: [a, b, d], from: Math.min(a[1], b[1], d[1]), to: Math.max(a[1], b[1], d[1]), colour: [0, 1, 2].map((n) => bark[n] * mean((q) => q.colour[n])), shade: mean((q) => q.shade), canopy: mean((q) => q.canopy) });
    highest = Math.max(highest, a[1], b[1], d[1]);
  }
  const height = Math.min(top, highest) - TRUNK_FOOT_METRES;
  if (!wood.length || height < 0.3) return null;
  const span = height / (rings - 1), positions = [], normals = [], looks = [], centres = [], indices = [];
  const gather = (from, to, centre, within) => {
    const sum = [0, 0, 0, 0, 0, 0, 0, 0], found = [];
    let inside = 0;
    for (const w of wood) {
      if (w.to < from || w.from >= to) continue;
      const x = (w.corners[0][0] + w.corners[1][0] + w.corners[2][0]) / 3, z = (w.corners[0][2] + w.corners[1][2] + w.corners[2][2]) / 3;
      if (centre && Math.hypot(x - centre[0], z - centre[1]) > within) continue;
      found.push(w);
      inside += w.area * Math.min(1, (Math.min(to, w.to) - Math.max(from, w.from)) / Math.max(w.to - w.from, 1e-6));
      sum[0] += w.area; sum[1] += w.area * x; sum[2] += w.area * z;
      for (let n = 0; n < 3; n++) sum[3 + n] += w.area * w.colour[n];
      sum[6] += w.area * w.shade; sum[7] += w.area * w.canopy;
    }
    if (!(sum[0] > 0)) return null;
    const middle = [sum[1] / sum[0], sum[2] / sum[0]];
    let reach = 0;
    for (const w of found) for (const q of w.corners) reach += w.area / 3 * Math.hypot(q[0] - middle[0], q[2] - middle[1]);
    return { centre: middle, radius: Math.min(reach / sum[0], inside / (2 * Math.PI * (to - from))), colour: [sum[3] / sum[0], sum[4] / sum[0], sum[5] / sum[0]], shade: sum[6] / sum[0], canopy: sum[7] / sum[0] };
  };
  const foot = gather(Math.min(0.15, height * 0.1), Math.min(1.2, Math.max(0.3, height * 0.25)), null, 0);
  if (!foot) return null;
  let last = foot;
  for (let j = 0; j < rings; j++) {
    const y = TRUNK_FOOT_METRES + j * span;
    const ring = (j && gather(y - span / 2, y + span / 2, last.centre, Math.max(foot.radius * 3, 0.5))) || last;
    last = ring;
    const radius = foot.radius * (1 - 0.45 * j / (rings - 1)), corner = radius * Math.PI / (sides * Math.sin(Math.PI / sides));
    for (let i = 0; i < sides; i++) {
      const angle = (i + j * 0.5) * 2 * Math.PI / sides, out = [Math.cos(angle), 0, Math.sin(angle)];
      positions.push(ring.centre[0] + out[0] * corner, y, ring.centre[1] + out[2] * corner);
      normals.push(...out);
      looks.push(ring);
      centres.push([ring.centre[0], y, ring.centre[1]]);
    }
  }
  for (let j = 0; j < rings - 1; j++) for (let i = 0; i < sides; i++) {
    const a = j * sides + i, b = j * sides + (i + 1) % sides, e = a + sides, d = b + sides;
    indices.push(a, e, b, b, e, d);
  }
  for (let i = 1; i < sides - 1; i++) indices.push(0, i, i + 1, (rings - 1) * sides, (rings - 1) * sides + i + 1, (rings - 1) * sides + i);
  const mesh = orientOutward({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) });
  return { ...mesh, normals, looks, centres, sides, rings };
}

const VIEWS = [];
for (const [row, elevation] of [-12, 2, 16, 34, 56].entries()) for (let k = 0; k < 12; k++) {
  const az = (k + row * 0.37) * Math.PI / 6, el = elevation * Math.PI / 180;
  const towards = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  const right = normalize(cross([0, 1, 0], towards));
  VIEWS.push({ towards, right, up: cross(towards, right) });
}
const FAST_VIEW_INDICES = Array.from({ length: 12 }, (_, i) => i * 5);

function viewFrame(view, low, high, pixel) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let bits = 0; bits < 8; bits++) {
    const q = [0, 1, 2].map((k) => (bits & (1 << k) ? high[k] : low[k]));
    const x = q[0] * view.right[0] + q[1] * view.right[1] + q[2] * view.right[2], y = q[0] * view.up[0] + q[1] * view.up[1] + q[2] * view.up[2];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  x0 -= pixel * 3; y0 -= pixel * 3;
  return { x0, y0, pixel, width: Math.ceil((x1 - x0) / pixel) + 3, height: Math.ceil((y1 - y0) / pixel) + 3 };
}

const SEEN_CHANNELS = 9;
function leafSeen(samples, view, frame) {
  const count = frame.width * frame.height, through = new Float32Array(count).fill(1), seen = new Float32Array(count * SEEN_CHANNELS);
  const { points } = samples, depth = new Float32Array(points.length), order = new Uint32Array(points.length);
  for (let i = 0; i < points.length; i++) { const q = points[i].at; depth[i] = q[0] * view.towards[0] + q[1] * view.towards[1] + q[2] * view.towards[2]; order[i] = i; }
  order.sort((a, b) => depth[b] - depth[a]);
  let underside = 0, total = 0;
  for (const i of order) {
    const s = points[i];
    const x = Math.floor((s.at[0] * view.right[0] + s.at[1] * view.right[1] + s.at[2] * view.right[2] - frame.x0) / frame.pixel);
    const y = Math.floor((s.at[0] * view.up[0] + s.at[1] * view.up[1] + s.at[2] * view.up[2] - frame.y0) / frame.pixel);
    const facing = Math.abs(s.normal[0] * view.towards[0] + s.normal[1] * view.towards[1] + s.normal[2] * view.towards[2]);
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
    const pixel = y * frame.width + x, weight = through[pixel] * Math.min(1, s.seen * facing / (frame.pixel * frame.pixel));
    if (!(weight > 0)) continue;
    through[pixel] -= weight;
    const at = pixel * SEEN_CHANNELS;
    seen[at] += weight * s.colour[0]; seen[at + 1] += weight * s.colour[1]; seen[at + 2] += weight * s.colour[2];
    seen[at + 3] += weight * s.shade; seen[at + 4] += weight * s.canopy;
    seen[at + 5] += weight * s.lean[0]; seen[at + 6] += weight * s.lean[1]; seen[at + 7] += weight * s.lean[2];
    seen[at + 8] += weight * depth[i];
    total += weight; if (s.lean[0] * view.towards[0] + s.lean[1] * view.towards[1] + s.lean[2] * view.towards[2] < 0) underside += weight;
  }
  let area = 0;
  for (let i = 0; i < count; i++) area += 1 - through[i];
  return { through, seen, area: area * frame.pixel * frame.pixel, underside: underside / Math.max(total, 1e-9) };
}

function shapeArea(through, frame) {
  const { width, height } = frame, cells = width * height, reach = Math.max(1, Math.round(CLOSE_METRES / 2 / frame.pixel));
  let solid = Uint8Array.from(through, (open) => (open < 0.9 ? 1 : 0));
  for (const grow of [1, 0]) for (let pass = 0; pass < reach; pass++) {
    const next = Uint8Array.from(solid);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (solid[i] === grow) continue;
      const beside = [x > 0 ? solid[i - 1] : 0, x < width - 1 ? solid[i + 1] : 0, y > 0 ? solid[i - width] : 0, y < height - 1 ? solid[i + width] : 0];
      if (beside.includes(grow)) next[i] = grow;
    }
    solid = next;
  }
  const outside = new Uint8Array(cells), queue = new Int32Array(cells);
  let head = 0, tail = 0;
  const visit = (i) => { if (!solid[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
  while (head < tail) { const i = queue[head++], x = i % width; if (x > 0) visit(i - 1); if (x < width - 1) visit(i + 1); if (i >= width) visit(i - width); if (i < cells - width) visit(i + width); }
  let count = 0;
  for (let i = 0; i < cells; i++) if (!outside[i]) count++;
  return count * frame.pixel * frame.pixel;
}

function outline(mesh, view, frame) {
  const fine = frame.pixel / 2, width = frame.width * 2, height = frame.height * 2, mask = new Uint8Array(width * height);
  const { positions, indices: tri } = mesh;
  for (let t = 0; t < tri.length; t += 3) {
    const q = [0, 1, 2].map((k) => { const i = tri[t + k] * 3; return [(positions[i] * view.right[0] + positions[i + 1] * view.right[1] + positions[i + 2] * view.right[2] - frame.x0) / fine, (positions[i] * view.up[0] + positions[i + 1] * view.up[1] + positions[i + 2] * view.up[2] - frame.y0) / fine]; });
    const det = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]);
    if (Math.abs(det) < 1e-12) continue;
    const xLow = Math.max(0, Math.floor(Math.min(q[0][0], q[1][0], q[2][0]))), xHigh = Math.min(width - 1, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0])));
    const yLow = Math.max(0, Math.floor(Math.min(q[0][1], q[1][1], q[2][1]))), yHigh = Math.min(height - 1, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1])));
    for (let y = yLow; y <= yHigh; y++) for (let x = xLow; x <= xHigh; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((q[1][0] - px) * (q[2][1] - py) - (q[1][1] - py) * (q[2][0] - px)) / det, w1 = ((q[2][0] - px) * (q[0][1] - py) - (q[2][1] - py) * (q[0][0] - px)) / det;
      if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) mask[y * width + x] = 1;
    }
  }
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  return { mask, width, height, area: count * fine * fine };
}

function writePreview(name, panels) {
  const height = Math.max(...panels.map((p) => p.height)), width = panels.reduce((sum, p) => sum + p.width + 4, 0), out = new Uint8Array(width * height).fill(40);
  let left = 0;
  for (const p of panels) {
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) out[(height - 1 - y) * width + left + x] = Math.round(255 * p.value(x, y));
    left += p.width + 4;
  }
  const raw = path.join(os.tmpdir(), `forest-crown-preview-${process.pid}.bin`);
  fs.writeFileSync(raw, out);
  execFileSync('python3', ['-c', 'import sys;from PIL import Image;Image.frombytes("L",(int(sys.argv[2]),int(sys.argv[3])),open(sys.argv[1],"rb").read()).save(sys.argv[4])', raw, String(width), String(height), path.join(previewDir, name)]);
  fs.rmSync(raw);
}

await MeshoptSimplifier.ready;
const cellFor = (low, high) => Math.min(0.3, Math.max(0.04, Math.max(high[0] - low[0], high[1] - low[1], high[2] - low[2]) / 44));
const packColour = (() => {
  const each = manifest.prototypes.map((p) => {
    const colour = [0, 0, 0];
    let weight = 0;
    for (const s of leafSamples(p, cellFor).points) { weight += s.seen; for (let k = 0; k < 3; k++) colour[k] += s.seen * s.colour[k]; }
    return colour.map((v) => v / Math.max(weight, 1e-9));
  });
  return [0, 1, 2].map((k) => { const sorted = each.map((c) => c[k]).sort((a, b) => a - b), half = sorted.length >> 1; return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2; });
})();
console.log(`the pack's middle leaf colour ${packColour.map((v) => v.toFixed(3))}`);
if (previewDir) fs.mkdirSync(previewDir, { recursive: true });
const vertexWords = [], indexWords = [], morphWords = [], prototypes = [];
let vertexCount = 0, morphWordCount = 0;

for (const p of manifest.prototypes) {
  if (only && p.species !== only) continue;
  const started = Date.now();
  const samples = leafSamples(p, cellFor);
  const field = leafField(samples), { step } = field;
  const frames = VIEWS.map((view) => viewFrame(view, field.origin, field.origin.map((v, k) => v + field.size[k] * step), step));
  const wanted = VIEWS.map((view, k) => leafSeen(samples, view, frames[k]));
  const wantShapes = wanted.map((w, k) => shapeArea(w.through, frames[k]));
  const coveredArea = wanted.reduce((sum, w) => sum + w.area, 0), wantedArea = wantShapes.reduce((sum, a) => sum + a, 0), coverShare = Math.min(1, coveredArea / wantedArea);
  const fastWantedArea = FAST_VIEW_INDICES.reduce((sum, idx) => sum + wantShapes[idx], 0);
  const changing = leafSamples(p, () => step, CHANGE_ERROR_METRES), changeArea = VIEWS.reduce((sum, view, k) => sum + leafSeen(changing, view, frames[k]).area, 0), ownShare = Math.min(1, changeArea / wantedArea);
  const outlined = (mesh) => VIEWS.reduce((sum, view, k) => sum + outline(mesh, view, frames[k]).area, 0);
  const fastOutlined = (mesh) => FAST_VIEW_INDICES.reduce((sum, idx) => sum + outline(mesh, VIEWS[idx], frames[idx]).area, 0);

  const posSpan = Math.max(...[0, 1, 2].map((k) => samples.high[k] - samples.low[k]), 1e-3);
  const reachLimit = Math.max(1.5, p.radius * 0.25) * 0.985;
  const boxLow = p.centre.map((c) => c - p.radius - reachLimit);
  const boxHigh = p.centre.map((c) => c + p.radius + reachLimit);

  const fitField = (cellsMul, closeMul) => {
    const f = leafField(samples, step * cellsMul);
    const opts = { closeMetres: Math.max(CLOSE_METRES, f.step * closeMul) };
    let lowLevel = 0, highLevel = 0;
    for (let i = 0; i < f.smooth.length; i++) highLevel = Math.max(highLevel, f.smooth[i]);
    lowLevel = highLevel * 1e-4;
    for (let pass = 0; pass < 14; pass++) {
      const level = Math.sqrt(lowLevel * highLevel), raw = surface(f, level, opts);
      const mesh = raw ? relax(raw, ROUNDING) : null;
      if (mesh && mesh.indices.length && fastOutlined(mesh) > fastWantedArea) lowLevel = level; else highLevel = level;
    }
    const raw = surface(f, lowLevel, opts);
    if (!raw || !raw.indices.length) return null;
    const mesh = orientOutward(relax(raw, ROUNDING));
    return { mesh, level: lowLevel, cell: f.step };
  };

  const fine = fitField(CROWN_FINE_CELLS, 4.5);
  let baseCand = null, baseSimplifyErr = 0, chosenCell = fine ? fine.cell : step * CROWN_FINE_CELLS, chosenLevel = fine ? fine.level : 0.01;
  for (const [cellsMul, closeMul] of [[CROWN_FINE_CELLS, 4.5], [1.6, 5.0], [1.8, 5.2], [2.2, 5.2], [2.6, 5.2]]) {
    const fitted = (cellsMul === CROWN_FINE_CELLS && closeMul === 4.5 && fine) ? fine : fitField(cellsMul, closeMul);
    if (!fitted) continue;
    const [kept, reported] = MeshoptSimplifier.simplify(fitted.mesh.indices, fitted.mesh.positions, 3, BASE_FOLIAGE_TRIANGLES * 3, posSpan, ['ErrorAbsolute']);
    const cand = orientOutward(compact({ positions: fitted.mesh.positions, indices: kept }));
    if (isGenusZeroClosedManifold(cand) && outlined(cand) >= wantedArea * 0.45) {
      baseCand = cand;
      baseSimplifyErr = reported;
      chosenCell = fitted.cell;
      chosenLevel = fitted.level;
      break;
    }
  }
  if (!baseCand) {
    const wrapped = shrinkWrapGenusZeroCrown(fine.mesh, 2);
    const [kept, reported] = MeshoptSimplifier.simplify(wrapped.indices, wrapped.positions, 3, BASE_FOLIAGE_TRIANGLES * 3, posSpan, ['ErrorAbsolute']);
    baseCand = orientOutward(compact({ positions: wrapped.positions, indices: kept }));
    baseSimplifyErr = reported;
  }

  const rawFolPos = Float32Array.from(baseCand.positions);
  const folCount = rawFolPos.length / 3;
  const rawMiddle = [0, 0, 0];
  for (let i = 0; i < rawFolPos.length; i++) rawMiddle[i % 3] += rawFolPos[i] / folCount;
  const splatCentre = rawMiddle.map((v, axis) => Math.max(boxLow[axis], Math.min(boxHigh[axis], v)));

  const scaleFolRaw = (g) => {
    const scaled = new Float32Array(rawFolPos.length);
    for (let i = 0; i < rawFolPos.length; i++) {
      const axis = i % 3;
      const v = splatCentre[axis] + (rawFolPos[i] - splatCentre[axis]) * g;
      scaled[i] = Math.max(boxLow[axis], Math.min(boxHigh[axis], v));
    }
    return { positions: scaled, indices: baseCand.indices };
  };
  let bestG0 = 1, curG0 = 1, bestDiff0 = Infinity;
  for (let pass = 0; pass < 4; pass++) {
    const area = outlined(scaleFolRaw(curG0));
    const diff = Math.abs(area / wantedArea - 1);
    if (diff < bestDiff0) { bestDiff0 = diff; bestG0 = curG0; }
    if (diff < 0.003) break;
    curG0 = Math.max(0.65, Math.min(2.2, curG0 * Math.sqrt(wantedArea / Math.max(area, 1e-9))));
  }
  const baseFoliage = orientOutward(scaleFolRaw(bestG0));
  const trunk = trunkColumn(p, splatCentre[1]);
  const trunkVertCount = trunk ? trunk.positions.length / 3 : 0;
  const totalLocalVerts = folCount + trunkVertCount;
  if (totalLocalVerts >= 250) throw Error(`Prototype ${p.species} has ${totalLocalVerts} >= 250 local vertices`);

  const trunkAxisXZ = trunk ? (() => {
    let sx = 0, sz = 0;
    for (const c of trunk.centres) { sx += c[0]; sz += c[2]; }
    return [+(sx / trunk.centres.length).toFixed(4), +(sz / trunk.centres.length).toFixed(4)];
  })() : [+splatCentre[0].toFixed(4), +splatCentre[2].toFixed(4)];

  const meanOutlineArea = wantedArea / VIEWS.length;
  const spanY = Math.max(0.4, samples.high[1] - samples.low[1]);
  const spanXZ = Math.max(0.4, ((samples.high[0] - samples.low[0]) + (samples.high[2] - samples.low[2])) * 0.5);
  const aspect = Math.max(0.45, Math.min(2.4, spanY / spanXZ));
  const splatRx = Math.sqrt(meanOutlineArea / (3.14025 * aspect));
  const splatRy = splatRx * aspect;

  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const positions of [baseFoliage.positions, trunk?.positions ?? []]) {
    for (let i = 0; i < positions.length; i++) {
      low[i % 3] = Math.min(low[i % 3], positions[i]);
      high[i % 3] = Math.max(high[i % 3], positions[i]);
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    const rad = axis === 1 ? splatRy : splatRx;
    low[axis] = Math.min(low[axis], Math.max(boxLow[axis], splatCentre[axis] - rad));
    high[axis] = Math.max(high[axis], Math.min(boxHigh[axis], splatCentre[axis] + rad));
  }
  const posScale = Math.max(high[0] - low[0], high[1] - low[1], high[2] - low[2], 1e-3);
  const quant = { low, posScale, uvLow: [0, 0], uvScale: [1, 1] };

  const foliage = p.nativeMaterials.filter((m) => /^(foliage|leaf)/.test(m.name));
  const foliageMean = [0, 1, 2].map((k) => foliage.reduce((sum, m) => sum + leafImage(m.albedo.file).mean[k], 0) / foliage.length);
  const whole = [0, 0, 0, 0, 0, 0, 0, 0];
  let wholeSeen = 0;
  for (const s of samples.points) { for (let k = 0; k < 3; k++) { whole[k] += s.seen * s.colour[k]; whole[5 + k] += s.seen * s.lean[k]; } whole[3] += s.seen * s.shade; whole[4] += s.seen * s.canopy; wholeSeen += s.seen; }
  const fallback = whole.map((v) => v / wholeSeen);

  const seenAt = (at, normal) => {
    const sum = new Float64Array(SEEN_CHANNELS);
    let weight = 0;
    for (const [k, view] of VIEWS.entries()) {
      const facing = normal[0] * view.towards[0] + normal[1] * view.towards[1] + normal[2] * view.towards[2];
      if (facing < 0.2) continue;
      const frame = frames[k], { seen, through } = wanted[k];
      const x = Math.floor((at[0] * view.right[0] + at[1] * view.right[1] + at[2] * view.right[2] - frame.x0) / frame.pixel), y = Math.floor((at[0] * view.up[0] + at[1] * view.up[1] + at[2] * view.up[2] - frame.y0) / frame.pixel);
      const depth = at[0] * view.towards[0] + at[1] * view.towards[1] + at[2] * view.towards[2], reach = Math.max(1, step * 5);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
        const pixel = py * frame.width + px, cover = 1 - through[pixel];
        if (cover < 0.05 || Math.abs(seen[pixel * SEEN_CHANNELS + 8] / cover - depth) > reach) continue;
        for (let c = 0; c < SEEN_CHANNELS; c++) sum[c] += facing * seen[pixel * SEEN_CHANNELS + c];
        weight += facing * cover;
      }
    }
    return weight > 0.5 ? Array.from(sum.subarray(0, 8), (v) => v / weight) : null;
  };

  // Pack the single base mesh vertices (foliage + trunk) and decode exact quantized positions for bit-identical collapse geometry.
  const firstVertex = vertexCount;
  const shown = new Float64Array(SEEN_CHANNELS), given = new Float64Array(8);
  let shownCover = 0, unseen = 0, alike = 0;
  for (const { seen, through } of wanted) for (let i = 0; i < through.length; i++) { for (let c = 0; c < SEEN_CHANNELS; c++) shown[c] += seen[i * SEEN_CHANNELS + c]; shownCover += 1 - through[i]; }

  const folNormals = vertexNormals(baseFoliage), smoothed = relax(baseFoliage, 4).positions, creased = new Float32Array(folCount);
  for (let v = 0; v < folCount; v++) {
    let depth = 0;
    for (let k = 0; k < 3; k++) depth += (smoothed[v * 3 + k] - baseFoliage.positions[v * 3 + k]) * folNormals[v * 3 + k];
    creased[v] = Math.max(-1, Math.min(1, depth / (posSpan * CREASE_SHARE)));
  }
  const outVertWords = [];
  for (let v = 0; v < folCount; v++) {
    const at = [baseFoliage.positions[v * 3], baseFoliage.positions[v * 3 + 1], baseFoliage.positions[v * 3 + 2]];
    const normal = [folNormals[v * 3], folNormals[v * 3 + 1], folNormals[v * 3 + 2]];
    const viewed = seenAt(at, normal), look = viewed ?? seenFrom(field, at, normal, fallback), lean = normalize(look.slice(5, 8));
    look[3] = Math.min(1, look[3] * (1 - CREASE_DEPTH * Math.max(creased[v], 0) + CREASE_LIFT * Math.max(-creased[v], 0)));
    for (let c = 0; c < 3; c++) look[c] = coverShare * (ownShare * look[c] + (1 - ownShare) * BACKDROP_SHADE * packColour[c]);
    if (!viewed) unseen++;
    for (let c = 0; c < 8; c++) given[c] += look[c] / folCount;
    alike += Math.min(1, Math.hypot(...look.slice(5, 8))) / folCount;
    outVertWords.push(...packForestClusterVertex({ position: at, normal: Math.hypot(...look.slice(5, 8)) > 1e-3 ? lean : [0, 1, 0], uv: octahedral(normal), colour: look.slice(0, 3).map((c) => Math.min(1, c)), material: 0, shade: look[3], canopy: look[4] }, quant));
  }
  for (let v = 0; v < trunkVertCount; v++) {
    const pos = [...trunk.positions.subarray(v * 3, v * 3 + 3)];
    outVertWords.push(...packForestClusterVertex({ position: pos, normal: trunk.normals.slice(v * 3, v * 3 + 3), uv: octahedral(trunk.normals.slice(v * 3, v * 3 + 3)), colour: trunk.looks[v].colour.map((c) => Math.min(1, c)), material: 1, shade: trunk.looks[v].shade, canopy: trunk.looks[v].canopy }, quant));
  }
  const packedVertArray = Uint32Array.from(outVertWords);
  vertexWords.push(packedVertArray);
  vertexCount += totalLocalVerts;

  const localPosFlat = new Float32Array(totalLocalVerts * 3);
  const localPos = [];
  for (let v = 0; v < totalLocalVerts; v++) {
    const w0 = packedVertArray[v * FOREST_CLUSTER_VERTEX_WORDS], w1 = packedVertArray[v * FOREST_CLUSTER_VERTEX_WORDS + 1];
    const px = low[0] + (w0 & 65535) / 65535 * posScale;
    const py = low[1] + (w0 >>> 16) / 65535 * posScale;
    const pz = low[2] + (w1 & 65535) / 65535 * posScale;
    localPosFlat[v * 3] = px; localPosFlat[v * 3 + 1] = py; localPosFlat[v * 3 + 2] = pz;
    localPos.push([px, py, pz]);
  }

  // Assemble base triangles (foliage + wood) in local vertex indices [0 .. totalLocalVerts - 1].
  const baseTris = [];
  for (let i = 0; i < baseFoliage.indices.length; i += 3) {
    baseTris.push({ corners: [baseFoliage.indices[i], baseFoliage.indices[i + 1], baseFoliage.indices[i + 2]], wood: false });
  }
  if (trunk) {
    for (let i = 0; i < trunk.indices.length; i += 3) {
      baseTris.push({ corners: [folCount + trunk.indices[i], folCount + trunk.indices[i + 1], folCount + trunk.indices[i + 2]], wood: true });
    }
  }
  const T0 = baseTris.length;
  const triDeath = new Int32Array(T0).fill(1e9);
  const mapV = Int32Array.from({ length: totalLocalVerts }, (_, i) => i);
  const resolve = (v) => { while (mapV[v] !== v) v = mapV[v]; return v; };

  // Build progressive half-edge collapse sequence (foliage + interleaved trunk collapses).
  const stepRecords = [];
  let didTrunkRing1 = !trunk, didTrunkRing2 = !trunk, didTrunkRetire = !trunk;
  const trunkQueue = [];
  let curStep = 0;

  while (true) {
    const curFol = [], curWood = [], candEdges = new Set();
    for (let t = 0; t < T0; t++) {
      if (triDeath[t] <= curStep) continue;
      const [c0, c1, c2] = baseTris[t].corners;
      const a = resolve(c0), b = resolve(c1), c = resolve(c2);
      if (baseTris[t].wood) {
        curWood.push([a, b, c]);
      } else {
        curFol.push([a, b, c]);
        for (const [u, w] of [[a, b], [b, c], [c, a]]) {
          candEdges.add(`${u},${w}`);
          candEdges.add(`${w},${u}`);
        }
      }
    }

    if (curFol.length <= 155 && !didTrunkRing1) {
      didTrunkRing1 = true;
      for (let i = 0; i < trunk.sides; i++) trunkQueue.push([folCount + trunk.sides + i, folCount + i]);
    }
    if (curFol.length <= 80 && !didTrunkRing2) {
      didTrunkRing2 = true;
      for (let i = 0; i < trunk.sides; i++) trunkQueue.push([folCount + 2 * trunk.sides + i, folCount + 3 * trunk.sides + i]);
    }

    // 1. Process queued trunk ring collapses if valid.
    let committed = false;
    while (trunkQueue.length > 0) {
      const [uRaw, wRaw] = trunkQueue.shift();
      const u = resolve(uRaw), w = resolve(wRaw);
      if (u === w || curWood.length === 0) continue;
      const nextWoodFlat = [];
      let bad = false;
      for (const [a, b, c] of curWood) {
        const na = a === u ? w : a, nb = b === u ? w : b, nc = c === u ? w : c;
        if (na === nb || nb === nc || nc === na) continue;
        nextWoodFlat.push(na, nb, nc);
      }
      if (!nextWoodFlat.length || nextWoodFlat.length / 3 >= curWood.length) continue;
      if (!isClosedSingleBody({ positions: localPosFlat, indices: Uint32Array.from(nextWoodFlat) })) continue;
      const piSnap = Uint8Array.from({ length: totalLocalVerts }, (_, v) => resolve(v));
      const dEdge = Math.hypot(localPos[u][0] - localPos[w][0], localPos[u][1] - localPos[w][1], localPos[u][2] - localPos[w][2]);
      stepRecords.push({ pi: piSnap, collapseV: u, targetV: w, collapseErr: dEdge * 0.25 });
      curStep++;
      mapV[u] = w;
      for (let t = 0; t < T0; t++) {
        if (triDeath[t] <= curStep) continue;
        const [c0, c1, c2] = baseTris[t].corners;
        const ra = resolve(c0), rb = resolve(c1), rc = resolve(c2);
        if (ra === rb || rb === rc || rc === ra) triDeath[t] = curStep;
      }
      committed = true;
      break;
    }
    if (committed) continue;

    // 2. Retire remaining sub-pixel trunk smoothly onto trunkAxisXZ once foliage reaches <= 28 triangles.
    if (curFol.length <= 28 && !didTrunkRetire) {
      didTrunkRetire = true;
      if (curWood.length > 0) {
        const piSnap = Uint8Array.from({ length: totalLocalVerts }, (_, v) => resolve(v));
        stepRecords.push({ pi: piSnap, collapseV: 253, targetV: 0, collapseErr: 0.12 });
        curStep++;
        for (let t = 0; t < T0; t++) {
          if (baseTris[t].wood && triDeath[t] > curStep) triDeath[t] = curStep;
        }
        continue;
      }
    }

    // 3. Collapse valid foliage half-edge with lowest Lindstrom-Turk volume-weighted edge cost.
    if (curFol.length <= MIN_FOLIAGE_TRIANGLES) break;
    let curVol6 = 0;
    for (const [a, b, c] of curFol) {
      const pa = localPos[a], pb = localPos[b], pc = localPos[c];
      curVol6 += pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) - pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) + pa[2] * (pb[0] * pc[1] - pb[1] * pc[0]);
    }
    const thresholds = curFol.length <= 40 ? [0.15, -0.15, -0.45] : [0.15, -0.05];
    let chosen = null, chosenCost = 0;
    for (const minDot of thresholds) {
      let bestEdge = null, bestCost = Infinity, bestEdgeLen = 0;
      for (const e of candEdges) {
        const [u, w] = e.split(',').map(Number);
        const nextFlat = [];
        let bad = false, nextVol6 = 0;
        for (const [a, b, c] of curFol) {
          const na = a === u ? w : a, nb = b === u ? w : b, nc = c === u ? w : c;
          if (na === nb || nb === nc || nc === na) continue;
          const pa = localPos[a], pb = localPos[b], pc = localPos[c];
          const n0 = [
            (pb[1] - pa[1]) * (pc[2] - pa[2]) - (pb[2] - pa[2]) * (pc[1] - pa[1]),
            (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]),
            (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]),
          ];
          const qa = localPos[na], qb = localPos[nb], qc = localPos[nc];
          const n1 = [
            (qb[1] - qa[1]) * (qc[2] - qa[2]) - (qb[2] - qa[2]) * (qc[1] - qa[1]),
            (qb[2] - qa[2]) * (qc[0] - qa[0]) - (qb[0] - qa[0]) * (qc[2] - qa[2]),
            (qb[0] - qa[0]) * (qc[1] - qa[1]) - (qb[1] - qa[1]) * (qc[0] - qa[0]),
          ];
          const l0 = Math.hypot(...n0), l1 = Math.hypot(...n1);
          if (l1 < 1e-7 || (l0 > 1e-7 && (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < minDot)) {
            bad = true; break;
          }
          nextVol6 += qa[0] * (qb[1] * qc[2] - qb[2] * qc[1]) - qa[1] * (qb[0] * qc[2] - qb[2] * qc[0]) + qa[2] * (qb[0] * qc[1] - qb[1] * qc[0]);
          nextFlat.push(na, nb, nc);
        }
        if (bad || nextFlat.length / 3 >= curFol.length || nextFlat.length / 3 < MIN_FOLIAGE_TRIANGLES) continue;
        if (!isGenusZeroClosedManifold({ positions: localPosFlat, indices: Uint32Array.from(nextFlat) })) continue;
        const pu = localPos[u], pw = localPos[w];
        const edgeLen = Math.hypot(pu[0] - pw[0], pu[1] - pw[1], pu[2] - pw[2]);
        const volLoss = Math.abs(curVol6 - nextVol6) / Math.max(Math.abs(curVol6), 1e-5);
        // Also penalize moving an extreme hull vertex inward toward centre so all 6 cardinal directions survive!
        const ru = Math.hypot(pu[0] - splatCentre[0], pu[1] - splatCentre[1], pu[2] - splatCentre[2]);
        const rw = Math.hypot(pw[0] - splatCentre[0], pw[1] - splatCentre[1], pw[2] - splatCentre[2]);
        const inwardPenalty = Math.max(0, ru - rw) * 1.5;
        const cost = (edgeLen + inwardPenalty) * (1 + 10 * volLoss);
        if (cost < bestCost) { bestCost = cost; bestEdge = [u, w]; bestEdgeLen = edgeLen; }
      }
      if (bestEdge) { chosen = bestEdge; chosenCost = bestEdgeLen; break; }
    }
    if (!chosen) break;

    const piSnap = Uint8Array.from({ length: totalLocalVerts }, (_, v) => resolve(v));
    stepRecords.push({ pi: piSnap, collapseV: chosen[0], targetV: chosen[1], collapseErr: chosenCost });
    curStep++;
    mapV[chosen[0]] = chosen[1];
    for (let t = 0; t < T0; t++) {
      if (triDeath[t] <= curStep) continue;
      const [c0, c1, c2] = baseTris[t].corners;
      const ra = resolve(c0), rb = resolve(c1), rc = resolve(c2);
      if (ra === rb || rb === rc || rc === ra) triDeath[t] = curStep;
    }
  }

  // Ensure wood is retired before the final splat-morph state.
  const anyWoodAlive = baseTris.some((tr, t) => tr.wood && triDeath[t] > curStep);
  if (anyWoodAlive) {
    const piSnap = Uint8Array.from({ length: totalLocalVerts }, (_, v) => resolve(v));
    stepRecords.push({ pi: piSnap, collapseV: 253, targetV: 0, collapseErr: 0.12 });
    curStep++;
    for (let t = 0; t < T0; t++) if (baseTris[t].wood && triDeath[t] > curStep) triDeath[t] = curStep;
  }

  // Append final state s = stepCount (collapseV = 255 morphs coarsest polyhedron onto splat ellipsoid).
  const stepCount = curStep;
  const finalPi = Uint8Array.from({ length: totalLocalVerts }, (_, v) => resolve(v));
  stepRecords.push({ pi: finalPi, collapseV: 255, targetV: 0, collapseErr: 0 });
  for (let t = 0; t < T0; t++) if (triDeath[t] > stepCount) triDeath[t] = stepCount + 1;

  // Sort base triangles in descending order of death step so every step s = 0 .. stepCount is a contiguous prefix!
  const sortedOrder = Array.from({ length: T0 }, (_, t) => t).sort((a, b) => (triDeath[b] - triDeath[a]) || (Number(baseTris[a].wood) - Number(baseTris[b].wood)));
  const firstIndex = indexWords.length;
  for (const t of sortedOrder) {
    const [c0, c1, c2] = baseTris[t].corners;
    indexWords.push(firstVertex + c0, firstVertex + c1, firstVertex + c2);
  }
  const baseIndexCount = T0 * 3;

  // Compute aliveTris[s], silhouette-preserving growScale[s], and monotonic angular facet errorMetres[s].
  const aliveTriCounts = new Uint16Array(stepCount + 1);
  const growScales = new Float32Array(stepCount + 1);
  const errorMetres = new Float32Array(stepCount + 1);
  const outlineShares = new Float32Array(stepCount + 1);
  const previews = [];

  let fastCalib = 1, cumErrSq = 0;
  const baseE0 = Math.hypot(chosenCell * 1.35, baseSimplifyErr * 0.5);

  for (let s = 0; s <= stepCount; s++) {
    const { pi } = stepRecords[s];
    let alive = 0;
    const folIndices = [];
    const activeFolVerts = new Set();
    for (let k = 0; k < T0; k++) {
      const origT = sortedOrder[k];
      if (triDeath[origT] <= s) break;
      alive++;
      if (!baseTris[origT].wood) {
        const [c0, c1, c2] = baseTris[origT].corners;
        const ma = pi[c0], mb = pi[c1], mc = pi[c2];
        folIndices.push(ma, mb, mc);
        activeFolVerts.add(ma); activeFolVerts.add(mb); activeFolVerts.add(mc);
      }
    }
    aliveTriCounts[s] = alive;
    const folTriCount = folIndices.length / 3;
    const folTriArr = Uint32Array.from(folIndices);

    // Maximum radial scale keeping all active foliage vertices strictly inside [boxLow, boxHigh].
    let maxSafeG = 1.65;
    for (const v of activeFolVerts) {
      for (let axis = 0; axis < 3; axis++) {
        const d = localPos[v][axis] - splatCentre[axis];
        if (d > 1e-4) maxSafeG = Math.min(maxSafeG, (boxHigh[axis] - splatCentre[axis]) / d);
        else if (d < -1e-4) maxSafeG = Math.min(maxSafeG, (boxLow[axis] - splatCentre[axis]) / d);
      }
    }
    maxSafeG = Math.max(1.0, maxSafeG * 0.995);

    const buildScaledFol = (g) => {
      const scaled = new Float32Array(folCount * 3);
      for (const v of activeFolVerts) {
        scaled[v * 3] = splatCentre[0] + (localPos[v][0] - splatCentre[0]) * g;
        scaled[v * 3 + 1] = splatCentre[1] + (localPos[v][1] - splatCentre[1]) * g;
        scaled[v * 3 + 2] = splatCentre[2] + (localPos[v][2] - splatCentre[2]) * g;
      }
      return { positions: scaled, indices: folTriArr };
    };

    if (s === 0) {
      growScales[0] = 1.0;
      const m0 = buildScaledFol(1.0);
      const fullA = outlined(m0), fastA = fastOutlined(m0);
      outlineShares[0] = fullA / wantedArea;
      fastCalib = (fullA / wantedArea) / Math.max(fastA / fastWantedArea, 1e-6);
    } else {
      const useFull = (s % 16 === 0) || (folTriCount <= 28) || (s === stepCount);
      let curG = Math.min(maxSafeG, growScales[s - 1]), bestG = curG, bestDiff = Infinity;
      for (let pass = 0; pass < 3; pass++) {
        const m = buildScaledFol(curG);
        const share = useFull ? (outlined(m) / wantedArea) : ((fastOutlined(m) / fastWantedArea) * fastCalib);
        const diff = Math.abs(share - 1);
        if (diff < bestDiff) { bestDiff = diff; bestG = curG; }
        if (diff < 0.005) break;
        curG = Math.max(0.72, Math.min(maxSafeG, curG * Math.sqrt(1 / Math.max(share, 1e-6))));
      }
      growScales[s] = bestG;
      const finalM = buildScaledFol(bestG);
      if (useFull) {
        const fullShare = outlined(finalM) / wantedArea;
        const fastShare = fastOutlined(finalM) / fastWantedArea;
        outlineShares[s] = fullShare;
        fastCalib = fullShare / Math.max(fastShare, 1e-6);
      } else {
        outlineShares[s] = (fastOutlined(finalM) / fastWantedArea) * fastCalib;
      }
    }

    if (previewDir && (s === 0 || s === Math.floor(stepCount * 0.4) || s === Math.floor(stepCount * 0.75) || s === stepCount)) {
      previews.push(outline(buildScaledFol(growScales[s]), VIEWS[13], frames[13]));
    }

    // Angular facet radius rTri = sqrt(2 * meanOutlineArea / (pi * F_s)) keeps screen-space facet span ~constant.
    const rTri = Math.sqrt((2 * meanOutlineArea) / (Math.PI * Math.max(folTriCount, 1)));
    const rawErr = Math.max(baseE0, Math.hypot(rTri * 0.68, Math.sqrt(cumErrSq) * 0.14));
    errorMetres[s] = s === 0 ? +baseE0.toFixed(4) : +Math.max(errorMetres[s - 1] + 0.0025, rawErr).toFixed(4);
    if (s < stepCount) cumErrSq += stepRecords[s].collapseErr * stepRecords[s].collapseErr;
  }

  // Pack morph.bin words for this prototype: (stepCount + 1) 4-word headers followed by packed u8 ancestor tables.
  const morphOffset = morphWordCount;
  const headerWordsCount = (stepCount + 1) * FOREST_CROWN_STEP_WORDS;
  const wordsPerMap = Math.ceil(totalLocalVerts / 4);
  const protoMorphWords = new Uint32Array(headerWordsCount + (stepCount + 1) * wordsPerMap);
  for (let s = 0; s <= stepCount; s++) {
    const mapWordOffset = morphOffset + headerWordsCount + s * wordsPerMap;
    const { pi, collapseV, targetV } = stepRecords[s];
    const hdrAt = s * FOREST_CROWN_STEP_WORDS;
    protoMorphWords[hdrAt] = ((aliveTriCounts[s] & 65535) | ((collapseV & 255) << 16) | ((targetV & 255) << 24)) >>> 0;
    protoMorphWords[hdrAt + 1] = floatBits(errorMetres[s]);
    protoMorphWords[hdrAt + 2] = floatBits(growScales[s]);
    protoMorphWords[hdrAt + 3] = mapWordOffset >>> 0;

    const mapLocalAt = headerWordsCount + s * wordsPerMap;
    for (let w = 0; w < wordsPerMap; w++) {
      const b0 = pi[w * 4] ?? 0;
      const b1 = pi[w * 4 + 1] ?? 0;
      const b2 = pi[w * 4 + 2] ?? 0;
      const b3 = pi[w * 4 + 3] ?? 0;
      protoMorphWords[mapLocalAt + w] = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
    }
  }
  morphWords.push(protoMorphWords);
  morphWordCount += protoMorphWords.length;

  const splat = {
    centre: splatCentre.map((v) => +v.toFixed(4)),
    rx: +splatRx.toFixed(4),
    ry: +splatRy.toFixed(4),
    colour: [0, 1, 2].map((c) => +Math.min(1, Math.max(0, given[c])).toFixed(4)),
    exposure: +Math.min(1, Math.max(0, given[3])).toFixed(4),
    escape: +Math.min(1, Math.max(0, given[4])).toFixed(4),
    trunkAxisXZ,
  };

  if (previewDir) {
    const frame = frames[13], cover = wanted[13].through;
    writePreview(`${p.id}-${p.species}${p.cohort ? '-' + p.cohort : ''}.png`, [
      { width: frame.width * 2, height: frame.height * 2, value: (x, y) => 1 - cover[(y >> 1) * frame.width + (x >> 1)] },
      ...previews.map((o) => ({ width: o.width, height: o.height, value: (x, y) => o.mask[y * o.width + x] })),
    ]);
  }

  let minShare = Infinity, maxShare = -Infinity;
  for (let s = 0; s <= stepCount; s++) {
    minShare = Math.min(minShare, outlineShares[s]);
    maxShare = Math.max(maxShare, outlineShares[s]);
  }
  const finalFoliageTris = aliveTriCounts[stepCount];
  const baseTrunkTris = trunk ? trunk.indices.length / 3 : 0;
  const material = foliage[0];

  prototypes.push({
    id: p.id,
    species: p.species,
    ...(p.cohort ? { cohort: p.cohort } : {}),
    firstVertex,
    vertexCount: totalLocalVerts,
    firstIndex,
    baseIndexCount,
    baseFoliageTriangles: folCount ? baseFoliage.indices.length / 3 : 0,
    baseTrunkTriangles: baseTrunkTris,
    minFoliageTriangles: finalFoliageTris,
    stepCount,
    morphOffset,
    low,
    posScale,
    errorRangeMetres: [+errorMetres[0].toFixed(4), +errorMetres[stepCount].toFixed(4)],
    outlineShareRange: [+minShare.toFixed(4), +maxShare.toFixed(4)],
    splat,
    leafErrorMetres: +CHANGE_ERROR_METRES.toFixed(4),
    leaves: samples.cards,
    breadthMetres: +Math.sqrt(meanOutlineArea).toFixed(3),
    look: {
      alike: +Math.max(0.05, alike).toFixed(4),
      transmission: material.transmission,
      roughness: material.roughness,
      undersideGain: foliageMean.map((c, k) => +(1 + material.underside * (linear(material.undersideReference[k]) / Math.max(c, 1e-3) - 1)).toFixed(4)),
    },
    stats: {
      undersideSeenLevel: +(wanted.slice(12, 24).reduce((sum, w) => sum + w.underside, 0) / 12).toFixed(3),
      undersideSeenAbove: +(wanted.slice(36, 48).reduce((sum, w) => sum + w.underside, 0) / 12).toFixed(3),
      cellMetres: +step.toFixed(4),
      level: +chosenLevel.toPrecision(4),
      fineTriangles: fine ? fine.mesh.indices.length / 3 : 0,
      leafAreaSquareMetres: +samples.leafArea.toFixed(1),
      meanOutlineSquareMetres: +meanOutlineArea.toFixed(2),
      leavesCoverShare: +(coveredArea / wantedArea).toFixed(3),
      cardsCoverShareAtChange: +ownShare.toFixed(3),
      ms: Date.now() - started,
    },
  });
  console.log(' '.repeat(20), `leaves show exposure ${(shown[3] / shownCover).toFixed(3)} colour ${[0, 1, 2].map((c) => (shown[c] / shownCover).toFixed(3))}; crown has ${given[3].toFixed(3)} and ${[0, 1, 2].map((c) => given[c].toFixed(3))}; ${unseen} of ${folCount} vertices no view saw`);
  console.log(`${p.species}${p.cohort ? ' ' + p.cohort : ''}`.padEnd(20), `${samples.cards} leaves · 1 base mesh (${T0}t: ${T0 - baseTrunkTris}f+${baseTrunkTris}w, ${totalLocalVerts}v) → ${stepCount} half-edge steps (±${errorMetres[0].toFixed(2)}..${errorMetres[stepCount].toFixed(2)}m, outline ${(minShare * 100).toFixed(0)}..${(maxShare * 100).toFixed(0)}%) → ${finalFoliageTris}t → 1t splat (${splat.rx.toFixed(1)}×${splat.ry.toFixed(1)}m) · ${Date.now() - started} ms`);
}

// Shared 1-triangle index triplet [0, 1, 2] for the camera-facing analytical crown splat.
const splatFirstIndex = indexWords.length;
indexWords.push(0, 1, 2);

const vertexBytes = Buffer.concat(vertexWords.map((w) => Buffer.from(w.buffer, w.byteOffset, w.byteLength)));
const morphBytes = Buffer.concat(morphWords.map((w) => Buffer.from(w.buffer, w.byteOffset, w.byteLength)));
const outputs = {
  'vertices.bin': vertexBytes,
  'indices.bin': Buffer.from(Uint32Array.from(indexWords).buffer),
  'morph.bin': morphBytes,
};
const outDir = path.join(dir, 'crowns');
fs.mkdirSync(outDir, { recursive: true });
const files = {};
for (const [name, bytes] of Object.entries(outputs)) {
  const gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(outDir, `${name}.gz`), gz);
  files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), gzip: { file: `${name}.gz`, bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex') } };
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
  format: 'waterworld.forest-crowns',
  version: FOREST_CROWN_VERSION,
  vertexWords: FOREST_CLUSTER_VERTEX_WORDS,
  stepHeaderWords: FOREST_CROWN_STEP_WORDS,
  vertexCount,
  indexCount: indexWords.length,
  morphWordCount,
  splatFirstIndex,
  ...(OPEN_GROWN[packName] ? { widestLeafErrors: OPEN_GROWN[packName] } : {}),
  files,
  prototypes,
}, null, 1));
console.log('total', vertexCount, 'vertices,', (indexWords.length - 3) / 3, 'base triangles,', morphWordCount, 'morph words,', Object.values(files).reduce((sum, f) => sum + f.gzip.bytes, 0), 'bytes gzipped');
