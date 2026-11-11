// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A pack's leaves as a field: every leaf card as points, the points as leaf area in a grid, and the
// surface where that field crosses a level. scripts/prepare-forest-crowns.mjs builds one tree's far crown
// from it, and scripts/prepare-forest-groves.mjs a whole grove's canopy.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { FOREST_CLUSTER_VERTEX_WORDS } from '../js/forest-clusters.js';

// What forestClusterVertex and forestNativeLeafDepthFS do to far leaves (js/forest-clusters.js, js/forest-scenery.js).
export const FAR_INFLATE_BROADLEAF = 0.48, FAR_INFLATE_OTHER = 0.18, FAR_COVERAGE_GAIN = 2.25;
// A ray through leaves at every angle meets about half their area.
export const PROJECTED_SHARE = 0.5;

export const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export function sampleImage(image, u, v, out) {
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width))), y = Math.min(image.height - 1, Math.max(0, Math.floor(v * image.height))), i = y * image.width + x;
  out[0] = image.rgb[i * 3]; out[1] = image.rgb[i * 3 + 1]; out[2] = image.rgb[i * 3 + 2]; out[3] = image.alpha[i];
}

// A unit vector on the square, as packForestClusterVertex keeps normals: the shader reads it back with forestClusterOctahedral.
export function octahedral([x, y, z]) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / length, v = y / length;
  if (z / length < 0) { const a = u; u = (1 - Math.abs(v)) * (a >= 0 ? 1 : -1); v = (1 - Math.abs(a)) * (v >= 0 ? 1 : -1); }
  return [u * 0.5 + 0.5, v * 0.5 + 0.5];
}
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const normalize = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// Gaps narrower than this between boughs are closed.
export const CLOSE_METRES = 1;
// A tree's far crown is found in a leaf field this many of its own cells coarse, and the level its
// manifest names (stats.level) is the level of that field.
export const CROWN_FINE_CELLS = 1.4;
export const CARD_VERTICES = 6, CARD_TRIANGLES = [0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5], CLUSTER_WORDS = 16;

// One pack's clusters and leaf maps, opened once.
export function openForestLeaves(dir) {
  const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(path.join(dir, file)));
  const clusterManifest = JSON.parse(fs.readFileSync(path.join(dir, 'clusters/manifest.json'), 'utf8'));
  const words = (file) => { const b = gunzip(file); return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const clusterVertices = words('clusters/vertices.bin.gz'), clusterIndices = words('clusters/indices.bin.gz'), clusterWords = words('clusters/clusters.bin.gz'), clusterFloats = new Float32Array(clusterWords.buffer);
  const images = new Map();
  // A leaf map as linear colour and coverage.
  function leafImage(file) {
    if (images.has(file)) return images.get(file);
    const out = path.join(os.tmpdir(), `forest-crown-${process.pid}.bin`);
    const size = execFileSync('python3', ['-c', 'import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGBA");open(sys.argv[2],"wb").write(im.tobytes());print(im.width,im.height)', path.join(dir, file), out], { encoding: 'utf8' }).trim().split(' ').map(Number);
    const bytes = new Uint8Array(fs.readFileSync(out));
    fs.rmSync(out);
    const [width, height] = size, rgb = new Float32Array(width * height * 3), alpha = new Float32Array(width * height);
    const mean = [0, 0, 0];
    let cover = 0;
    for (let i = 0; i < width * height; i++) {
      alpha[i] = bytes[i * 4 + 3] / 255;
      for (let k = 0; k < 3; k++) { rgb[i * 3 + k] = linear(bytes[i * 4 + k] / 255); mean[k] += rgb[i * 3 + k] * alpha[i]; }
      cover += alpha[i];
    }
    const image = { width, height, rgb, alpha, mean: mean.map((v) => v / Math.max(cover, 1e-9)), cover: cover / (width * height) };
    images.set(file, image);
    return image;
  }
  // The leaf cards of one cut of a tree's clusters. At no error it is every leaf as modelled.
  function leafCut(p, errorMetres = 0) {
    const c = clusterManifest.prototypes.find((q) => q.id === p.id);
    if (!c) throw Error(`No clusters for ${p.species}`);
    const cards = [];
    for (let i = c.firstCluster; i < c.firstCluster + c.clusterCount; i++) {
      const at = i * CLUSTER_WORDS;
      if (!(clusterWords[at + 15] & 1) || clusterFloats[at + 12] > errorMetres || clusterFloats[at + 13] <= errorMetres) continue;
      for (let l = 0; l < (clusterWords[at + 15] >>> 1) / 4; l++) cards.push(clusterWords[at + 14] + l * CARD_VERTICES);
    }
    return { c, cards };
  }
  function clusterVertex(c, index) {
    const at = index * FOREST_CLUSTER_VERTEX_WORDS, w0 = clusterVertices[at], w1 = clusterVertices[at + 1], w2 = clusterVertices[at + 2], w3 = clusterVertices[at + 3], w4 = clusterVertices[at + 4];
    const e = [(w2 & 65535) / 65535 * 2 - 1, (w2 >>> 16) / 65535 * 2 - 1];
    let n = [e[0], e[1], 1 - Math.abs(e[0]) - Math.abs(e[1])];
    if (n[2] < 0) { const x = n[0]; n[0] = (1 - Math.abs(n[1])) * (x >= 0 ? 1 : -1); n[1] = (1 - Math.abs(x)) * (n[1] >= 0 ? 1 : -1); }
    return {
      position: [c.low[0] + (w0 & 65535) / 65535 * c.posScale, c.low[1] + (w0 >>> 16) / 65535 * c.posScale, c.low[2] + (w1 & 65535) / 65535 * c.posScale],
      normal: normalize(n), uv: [c.uvLow[0] + (w3 & 65535) / 65535 * c.uvScale[0], c.uvLow[1] + (w3 >>> 16) / 65535 * c.uvScale[1]],
      colour: [w4 & 255, (w4 >>> 8) & 255, (w4 >>> 16) & 255].map((v) => (v / 255) ** 2), material: (w1 >>> 16) & 255, shade: (w1 >>> 24) / 255, canopy: (w4 >>> 24) / 255,
    };
  }
  // Every leaf as points over its far, pushed-out card: where, how opaque, and what a viewer sees there.
  function leafSamples(p, cell, errorMetres = 0) {
    const broadleaf = Boolean(p.cohort) || p.species === 'ceiba' || p.species === 'mangrove';
    const inflate = broadleaf ? FAR_INFLATE_BROADLEAF : FAR_INFLATE_OTHER;
    const { c, cards } = leafCut(p, errorMetres);
    // forestClusterVertex, at the range where its push outward is complete.
    const far = (index) => {
      const v = clusterVertex(c, index), n = v.normal;
      const t1 = normalize(cross(n, Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), t2 = cross(n, t1);
      const du = Math.min(0.65, Math.max(-0.65, v.uv[0] - 0.5)), dv = Math.min(0.65, Math.max(-0.65, v.uv[1] - 0.5));
      return { ...v, at: v.position.map((q, k) => q + (t1[k] * du + t2[k] * dv) * inflate), lean: normalize(n.map((q, k) => q + (t1[k] * du + t2[k] * dv) * 0.1)) };
    };
    const points = [], texel = [0, 0, 0, 0];
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    let leafArea = 0;
    const corners = [];
    for (const first of cards) {
      const v = Array.from({ length: CARD_VERTICES }, (_, k) => far(first + k));
      for (const q of v) for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], q.at[k]); high[k] = Math.max(high[k], q.at[k]); }
      for (let t = 0; t < CARD_TRIANGLES.length; t += 3) corners.push([v[CARD_TRIANGLES[t]], v[CARD_TRIANGLES[t + 1]], v[CARD_TRIANGLES[t + 2]]]);
    }
    const step = cell(low, high);
    // Points of a fixed, even pattern: the same bake always gives the same crown.
    const pattern = (i) => { let u = (i * 0.754877666) % 1, v = (i * 0.569840291) % 1; if (u + v > 1) { u = 1 - u; v = 1 - v; } return [u, v]; };
    for (const [a, b, c3] of corners) {
      const face = cross(a.at.map((q, k) => b.at[k] - q), a.at.map((q, k) => c3.at[k] - q)), area = Math.hypot(...face) / 2;
      if (!(area > 0)) continue;
      const material = p.nativeMaterials[a.material], image = leafImage(material.albedo.file);
      const count = Math.min(160, Math.max(1, Math.ceil(area / (step * step / 6)))), local = [];
      let coverage = 0;
      for (let i = 0; i < count; i++) {
        const [u, v] = pattern(i + 1), w = 1 - u - v, mix = (get) => get(a) * w + get(b) * u + get(c3) * v;
        sampleImage(image, mix((q) => q.uv[0]), mix((q) => q.uv[1]), texel);
        coverage += texel[3];
        local.push({
          at: [0, 1, 2].map((k) => mix((q) => q.at[k])), alpha: texel[3], colour: [0, 1, 2].map((k) => texel[k] * mix((q) => q.colour[k])),
          shade: mix((q) => q.shade), lean: normalize([0, 1, 2].map((k) => mix((q) => q.lean[k]))), canopy: mix((q) => q.canopy),
        });
      }
      coverage /= count;
      if (!(coverage > 0)) continue;
      // Far coverage is the filtered map's, raised and capped: the same for the whole card.
      const opacity = Math.min(1, coverage * FAR_COVERAGE_GAIN), normal = normalize(face), share = area / count;
      for (const s of local) points.push({ ...s, normal, area: share, opacity, seen: share * opacity * s.alpha / coverage });
      leafArea += area;
    }
    return { points, low, high, step, leafArea, broadleaf, cards: cards.length };
  }
  return { clusterManifest, clusterVertices, clusterIndices, clusterWords, clusterFloats, leafImage, leafCut, clusterVertex, leafSamples };
}

// Leaf area in each cell of a grid, as how much of a ray crossing the cell it would stop.
export function leafField(samples, step = samples.step) {
  const { points, low } = samples, pad = 3;
  const origin = low.map((v) => v - pad * step), size = samples.high.map((v, k) => Math.ceil((v - low[k]) / step) + 1 + pad * 2);
  const cells = size[0] * size[1] * size[2], weight = new Float32Array(cells), seen = new Float32Array(cells), colour = new Float32Array(cells * 3), shade = new Float32Array(cells), shadeCanopy = new Float32Array(cells), lean = new Float32Array(cells * 3);
  const at = (q) => { const x = Math.floor((q[0] - origin[0]) / step), y = Math.floor((q[1] - origin[1]) / step), z = Math.floor((q[2] - origin[2]) / step); return x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2] ? -1 : (z * size[1] + y) * size[0] + x; };
  for (const s of points) {
    const i = at(s.at);
    weight[i] += s.area * s.opacity; seen[i] += s.seen;
    for (let k = 0; k < 3; k++) { colour[i * 3 + k] += s.seen * s.colour[k]; lean[i * 3 + k] += s.seen * s.lean[k]; }
    shade[i] += s.seen * s.shade; shadeCanopy[i] += s.seen * s.canopy;
  }
  const density = new Float32Array(cells);
  for (let i = 0; i < cells; i++) density[i] = weight[i] / (step * step);
  // One pass of 1 2 1 along each axis: a card that straddles a cell wall counts on both sides of it.
  const smooth = Float32Array.from(density), strides = [1, size[0], size[0] * size[1]];
  for (let axis = 0; axis < 3; axis++) {
    const from = Float32Array.from(smooth), stride = strides[axis];
    for (let z = 0; z < size[2]; z++) for (let y = 0; y < size[1]; y++) for (let x = 0; x < size[0]; x++) {
      const i = (z * size[1] + y) * size[0] + x, c = [x, y, z][axis];
      smooth[i] = (2 * from[i] + (c > 0 ? from[i - stride] : 0) + (c < size[axis] - 1 ? from[i + stride] : 0)) / 4;
    }
  }
  return { origin, size, step, density, smooth, seen, colour, shade, shadeCanopy, lean, at };
}

// What is solid where the leaf field crosses a level, as one body: gaps between boughs are closed, hollows
// inside are filled, and of what still stands apart only the largest piece is kept. A grove is many
// bodies: it names the fewest cells a piece may have (smallest), and every piece that large is kept.
// A cell is solid where its value is not below zero.
export function solidOf(field, level, { closeMetres = CLOSE_METRES, smallest = 0 } = {}) {
  const { size, smooth, step } = field, [sx, sy, sz] = size, cells = sx * sy * sz;
  const value = new Float32Array(cells), outside = new Uint8Array(cells), queue = new Int32Array(cells);
  for (let i = 0; i < cells; i++) value[i] = smooth[i] - level;
  const lift = Math.max(level * 0.25, 1e-6), strides = [1, sx, sx * sy], sizes3 = [sx, sy, sz];
  // Boughs a little apart are joined: the solid cells are grown and then drawn back by the same amount,
  // which leaves every gap narrower than twice that filled.
  const reach = Math.max(1, Math.round(closeMetres / 2 / step));
  let solid = Uint8Array.from(value, (v) => (v >= 0 ? 1 : 0));
  for (const grow of [1, 0]) for (let pass = 0; pass < reach; pass++) {
    const next = Uint8Array.from(solid);
    for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
      const i = (z * sy + y) * sx + x, at = [x, y, z];
      if (solid[i] === grow) continue;
      for (let axis = 0; axis < 3; axis++) {
        const before = at[axis] > 0 ? solid[i - strides[axis]] : 0, after = at[axis] < sizes3[axis] - 1 ? solid[i + strides[axis]] : 0;
        if (before === grow || after === grow) { next[i] = grow; break; }
      }
    }
    solid = next;
  }
  for (let i = 0; i < cells; i++) if (solid[i] && value[i] < 0) value[i] = lift;
  let head = 0, tail = 0;
  const visit = (i) => { if (!outside[i] && value[i] < 0) { outside[i] = 1; queue[tail++] = i; } };
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) if (x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1) visit((z * sy + y) * sx + x);
  const spread = (i, each) => {
    const x = i % sx, y = Math.floor(i / sx) % sy, z = Math.floor(i / (sx * sy));
    if (x > 0) each(i - 1); if (x < sx - 1) each(i + 1); if (y > 0) each(i - sx); if (y < sy - 1) each(i + sx); if (z > 0) each(i - sx * sy); if (z < sz - 1) each(i + sx * sy);
  };
  while (head < tail) spread(queue[head++], visit);
  for (let i = 0; i < cells; i++) if (!outside[i] && value[i] < 0) value[i] = lift;
  // Solid pieces, each with its size.
  const piece = new Int32Array(cells).fill(-1), sizes = [];
  for (let start = 0; start < cells; start++) {
    if (value[start] < 0 || piece[start] >= 0) continue;
    const id = sizes.length;
    head = 0; tail = 0; queue[tail++] = start; piece[start] = id;
    while (head < tail) spread(queue[head++], (j) => { if (value[j] >= 0 && piece[j] < 0) { piece[j] = id; queue[tail++] = j; } });
    sizes.push(tail);
  }
  if (!sizes.length) return null;
  const largest = sizes.indexOf(Math.max(...sizes));
  for (let i = 0; i < cells; i++) if (piece[i] >= 0 && (smallest > 0 ? sizes[piece[i]] < smallest : piece[i] !== largest)) value[i] = -lift;
  return value;
}
// The surface of that body.
export function surface(field, level, options) {
  const value = solidOf(field, level, options);
  if (!value) return null;
  const { size, origin, step } = field, [sx, sy, sz] = size, cells = sx * sy * sz;
  // Surface nets: one vertex in every cube of cells the surface passes through, at the mean of its crossings.
  const cube = new Int32Array(cells).fill(-1), positions = [];
  const corner = (x, y, z) => value[(z * sy + y) * sx + x];
  for (let z = 0; z < sz - 1; z++) for (let y = 0; y < sy - 1; y++) for (let x = 0; x < sx - 1; x++) {
    const v = [corner(x, y, z), corner(x + 1, y, z), corner(x, y + 1, z), corner(x + 1, y + 1, z), corner(x, y, z + 1), corner(x + 1, y, z + 1), corner(x, y + 1, z + 1), corner(x + 1, y + 1, z + 1)];
    let inside = 0;
    for (let k = 0; k < 8; k++) if (v[k] >= 0) inside++;
    if (inside === 0 || inside === 8) continue;
    let px = 0, py = 0, pz = 0, crossings = 0;
    for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) {
      const b = a | bit;
      if (b === a || (v[a] >= 0) === (v[b] >= 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      px += (a & 1) + (bit === 1 ? t : 0); py += ((a >> 1) & 1) + (bit === 2 ? t : 0); pz += ((a >> 2) & 1) + (bit === 4 ? t : 0); crossings++;
    }
    cube[(z * sy + y) * sx + x] = positions.length / 3;
    // Cell centres carry the values, so a cube's corner at (x, y, z) stands half a cell in.
    positions.push(origin[0] + (x + 0.5 + px / crossings) * step, origin[1] + (y + 0.5 + py / crossings) * step, origin[2] + (z + 0.5 + pz / crossings) * step);
  }
  const tri = [];
  const quad = (a, b, c, d, flip) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (flip) tri.push(a, c, b, a, d, c); else tri.push(a, b, c, a, c, d); };
  const cubeAt = (x, y, z) => cube[(z * sy + y) * sx + x];
  for (let z = 1; z < sz - 1; z++) for (let y = 1; y < sy - 1; y++) for (let x = 1; x < sx - 1; x++) {
    const here = corner(x, y, z) >= 0;
    if (here !== (corner(x + 1, y, z) >= 0)) quad(cubeAt(x, y - 1, z - 1), cubeAt(x, y, z - 1), cubeAt(x, y, z), cubeAt(x, y - 1, z), !here);
    if (here !== (corner(x, y + 1, z) >= 0)) quad(cubeAt(x - 1, y, z - 1), cubeAt(x - 1, y, z), cubeAt(x, y, z), cubeAt(x, y, z - 1), !here);
    if (here !== (corner(x, y, z + 1) >= 0)) quad(cubeAt(x - 1, y - 1, z), cubeAt(x, y - 1, z), cubeAt(x, y, z), cubeAt(x - 1, y, z), !here);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(tri) };
}
// Rounds a surface: each vertex moves part of the way to the middle of its neighbours.
export function relax(mesh, rounds) {
  if (!mesh) return mesh;
  const { positions, indices: t } = mesh, count = positions.length / 3, near = Array.from({ length: count }, () => new Set());
  for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { near[t[i + k]].add(t[i + (k + 1) % 3]); near[t[i + k]].add(t[i + (k + 2) % 3]); }
  let from = positions;
  for (let round = 0; round < rounds; round++) {
    const next = Float32Array.from(from);
    for (let v = 0; v < count; v++) {
      if (!near[v].size) continue;
      for (let k = 0; k < 3; k++) { let sum = 0; for (const n of near[v]) sum += from[n * 3 + k]; next[v * 3 + k] = from[v * 3 + k] * 0.4 + sum / near[v].size * 0.6; }
    }
    from = next;
  }
  return { positions: from, indices: t };
}
export function volume(mesh) {
  const { positions: p, indices: t } = mesh;
  let sum = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    sum += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}
export function compact(mesh) {
  const remap = new Map(), positions = [], out = new Uint32Array(mesh.indices.length);
  mesh.indices.forEach((v, i) => {
    let local = remap.get(v);
    if (local === undefined) { local = positions.length / 3; remap.set(v, local); positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]); }
    out[i] = local;
  });
  return { positions: Float32Array.from(positions), indices: out };
}
export function vertexNormals(mesh) {
  const { positions: p, indices: t } = mesh, normals = new Float32Array(p.length);
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const n = cross([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]);
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v + k] += n[k];
  }
  for (let v = 0; v < normals.length; v += 3) { const n = normalize([normals[v], normals[v + 1], normals[v + 2]]); normals.set(Math.hypot(...n) > 0.5 ? n : [0, 1, 0], v); }
  return normals;
}

// What a viewer sees of the leaves at one place on the surface: rays go in from just outside it, and
// each cell counts by how much of the ray is still unstopped when it arrives.
export function seenFrom(field, at, normal, fallback) {
  const { step, density, seen, colour, shade, shadeCanopy, lean } = field;
  const side = normalize(cross(normal, Math.abs(normal[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), other = cross(normal, side);
  const result = [0, 0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  for (const [u, v] of [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) {
    const ray = normalize([-normal[0] + side[0] * u + other[0] * v, -normal[1] + side[1] * u + other[1] * v, -normal[2] + side[2] * u + other[2] * v]);
    let open = 1;
    for (let d = -1.5 * step; d < Math.max(4, step * 12) && open > 0.03; d += step / 2) {
      const i = field.at([at[0] + ray[0] * d, at[1] + ray[1] * d, at[2] + ray[2] * d]);
      if (i < 0 || !(seen[i] > 0)) continue;
      const stopped = open * (1 - Math.exp(-density[i] * PROJECTED_SHARE / 2));
      for (let k = 0; k < 3; k++) result[k] += stopped * colour[i * 3 + k] / seen[i];
      result[3] += stopped * shade[i] / seen[i]; result[4] += stopped * shadeCanopy[i] / seen[i];
      for (let k = 0; k < 3; k++) result[5 + k] += stopped * lean[i * 3 + k] / seen[i];
      total += stopped; open -= stopped;
    }
  }
  return total > 1e-4 ? result.map((v) => v / total) : fallback;
}
