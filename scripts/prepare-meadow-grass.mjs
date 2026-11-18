#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes the meadow continuum (js/meadow-continuum.js; AGENTS.md rule 3) from a pack of meadow groves: twelve 4 m
// tiles (three mixes, four variants each) drawn plant by plant at full resolution, kept out of git in
// assets/ground-cover/<pack>/meadows/ (the Portuguese from forestmodeler, the tropical from
// scripts/prepare-tropical-sward.mjs). Usage: node scripts/prepare-meadow-grass.mjs [portugal] [tropical]
// (both when none is named). Each tile becomes one patch:
//   - a cluster hierarchy of eight levels, cells 16 to a side halving to one by the fifth. A level keeps half the
//     organs (leaves, culms, florets) of every plant of the level below, never fewer than one, and widens each kept
//     organ about its own midrib until the patch covers, seen from above and from two sides, what the full sward did.
//     As the forest's leaves, a cell's error is a share of the width its kept organs are grown to (and, should no
//     widening restore the cover, the height of what is lost), never less than its children's.
//   - a closed canopy body: the sward as the eye sees it from above (its highest surface over every 4 mm of ground,
//     or the ground itself where the sward leaves a gap), as a slab over the patch whose top stands where half of
//     that view lies below, its error where nine tenths of it lie within. The share of ground the sward hides rides
//     each body vertex, so the far meadow shows its soil where the near one does. Every variant's body meets the edge
//     of its patch at one height, colour and cover, so patches of any mix meet without a step. Collapsed one
//     half-edge at a time down to a core of a few triangles, its error measured at every step, and given between the
//     steps where it rises a rise of its own, so the morph passes through every step in turn.
//   The far body takes over from the first of its steps no finer than the coarsest level.
//   - its splat: the canopy's height, the sward's cover and its colour from above and from the side.
// Plants on a tile's edge band are the same in every variant of a mix, and their dropped organs are chosen by where
// they stand, so neighbouring patches of one mix agree across their seam at every level. The variants are baked in
// parallel, one worker thread each.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { collapseChain, ancestor, closestOnTriangle, closest, outline, edgeCensus } from '../js/continuum-bake.js';
import {
  MEADOW_CONTINUUM_FORMAT, MEADOW_CONTINUUM_VERSION, MEADOW_CONTINUUM_MAGIC, MEADOW_PATCH_METRES, MEADOW_CONTINUUM_LEVELS,
  MEADOW_CONTINUUM_CELLS, MEADOW_CONTINUUM_HEADER_WORDS, MEADOW_CONTINUUM_HEADER, MEADOW_CONTINUUM_VARIANT_WORDS,
  MEADOW_CONTINUUM_VARIANT, MEADOW_CONTINUUM_CLUSTER_WORDS, MEADOW_CONTINUUM_CLUSTER_TRIANGLES, MEADOW_CONTINUUM_VERTEX_WORDS,
  MEADOW_CONTINUUM_STEP_WORDS, MEADOW_CONTINUUM_NEVER, MEADOW_CONTINUUM_HOPS, MEADOW_CONTINUUM_CLUSTER_SPAN,
  MEADOW_CONTINUUM_VARIANT_VERTICES, MEADOW_CONTINUUM_OFFSET_UNIT, MEADOW_MIX_ROLES, PORTUGAL_MEADOW_GRASS_ASSETS,
  TROPICAL_MEADOW_GRASS_ASSETS, meadowContinuumCellsAt, packMeadowContinuumVertex, packMeadowContinuumCluster,
  packMeadowContinuumIndices,
} from '../js/meadow-continuum.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PACKS = Object.freeze({
  portugal: { source: 'assets/ground-cover/portugal/meadows', assets: PORTUGAL_MEADOW_GRASS_ASSETS },
  tropical: { source: 'assets/ground-cover/tropical/meadows', assets: TROPICAL_MEADOW_GRASS_ASSETS },
});
const P = MEADOW_PATCH_METRES;
const LEVELS = MEADOW_CONTINUUM_LEVELS;
const STRIDE = 12; // position, normal, linear colour, along, stiffness, anchor
// The groves' single-leaf reflectance, scaled to the sunlit meadow the land is lit as.
const ALBEDO_SCALE = 0.46;
// The views the sward's cover is measured in: from above over the tile (wrapped, as the tiles repeat), and from two
// sides over its height, in cells of about 4 mm.
const RASTER = 1024, SIDE_LOW = -0.2, SIDE_HEIGHT = 2, SIDE_CELLS = 512;
// The canopy body: a slab of 8 x 8 cells; its top where this share of the sward seen from above lies below, each
// vertex judged over the metre round it; its floor this far under the ground, never seen.
const BODY_CELLS = 8, BODY_QUANTILE = 0.5, BODY_FLOOR = -0.05;
// The body's error: how far from its top this share of the sward seen from above lies, ground in its gaps included.
const BODY_ERROR_QUANTILE = 0.9;
// A coarser level's error: this share of the mean width its kept organs are grown to, as the forest's leaves
// (scripts/prepare-forest-clusters.mjs, third_party/threejs-nanites/dag/leaves.ts).
const ORGAN_ERROR_SHARE = 0.35;
const CHAIN_LEAST_TRIANGLES = 6;
// Between steps whose errors rise by at least this share, the error rises in proportion (on a log scale), and no step
// ever has less than this over the one before, so each step has its own error and the morph passes through it.
const KNOT_RISE = 0.01, STEP_RISE = 0.003;
const ATLAS_LOW = [-1, -0.2, -1], ATLAS_SPAN = 6;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function hash32(...values) {
  let h = 0x811c9dc5;
  for (const v of values) {
    h = Math.imul(h ^ (v | 0), 0x01000193);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  }
  return h >>> 0;
}
const hash01 = (...values) => hash32(...values) / 4294967296;
const millimetres = (v) => Math.round(v * 1000);
function quantileOf(values, q) {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}
function sphereOf(points, spheres = []) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], p[k]); high[k] = Math.max(high[k], p[k]); }
  for (const s of spheres) for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], s[k] - s[3]); high[k] = Math.max(high[k], s[k] + s[3]); }
  const c = [0, 1, 2].map((k) => (low[k] + high[k]) / 2);
  let r = 0;
  for (const p of points) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  for (const s of spheres) r = Math.max(r, Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) + s[3]);
  return [...c, r * 1.0001 + 1e-5];
}
// A sphere round the points of `position` (xyz each) whose indices `vertices` lists, as sphereOf.
function sphereOfVertices(position, vertices) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], position[v * 3 + k]); high[k] = Math.max(high[k], position[v * 3 + k]); }
  const c = [0, 1, 2].map((k) => (low[k] + high[k]) / 2);
  let r = 0;
  for (const v of vertices) r = Math.max(r, Math.hypot(position[v * 3] - c[0], position[v * 3 + 1] - c[1], position[v * 3 + 2] - c[2]));
  return [...c, r * 1.0001 + 1e-5];
}
function morton(x, z) {
  const spread = (v) => { v &= 1023; v = (v | (v << 8)) & 0x00ff00ff; v = (v | (v << 4)) & 0x0f0f0f0f; v = (v | (v << 2)) & 0x33333333; return (v | (v << 1)) & 0x55555555; };
  return (spread(Math.round(((x + 1) / 6) * 1023)) | (spread(Math.round(((z + 1) / 6) * 1023)) << 1)) >>> 0;
}

// A tile's plants split into their organs: the connected pieces of each plant's mesh.
function organsOf(variant, V, I) {
  const organs = [];
  variant.clumps.forEach((clump, plant) => {
    const n = clump.vertexCount, parent = new Int32Array(n).fill(-1);
    const find = (x) => { while (parent[x] >= 0) x = parent[x]; return x; };
    const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const end = clump.firstIndex + clump.indexCount;
    for (let i = clump.firstIndex; i < end; i += 3) {
      const [a, b, c] = [I[i], I[i + 1], I[i + 2]].map((v) => v - clump.firstVertex);
      if (![a, b, c].every((v) => v >= 0 && v < n)) throw Error(`Plant ${plant} reaches outside its vertices`);
      unite(a, b); unite(b, c);
    }
    const pieces = new Map();
    for (let k = 0; k < n; k++) { const r = find(k); if (!pieces.has(r)) pieces.set(r, { vertices: [], triangles: [] }); pieces.get(r).vertices.push(clump.firstVertex + k); }
    for (let i = clump.firstIndex; i < end; i += 3) pieces.get(find(I[i] - clump.firstVertex)).triangles.push(I[i], I[i + 1], I[i + 2]);
    const where = [millimetres(clump.root[0]), millimetres(clump.root[1])];
    const clumpRand = hash01(0x6d656164, ...where);
    const plantOrgans = [...pieces.values()].filter((o) => o.triangles.length).map((o) => {
      const c = [0, 1, 2].map((k) => o.vertices.reduce((s, v) => s + V[v * STRIDE + k], 0) / o.vertices.length);
      let r = 0, low = 0;
      o.vertices.forEach((v, j) => { r = Math.max(r, Math.hypot(V[v * STRIDE] - c[0], V[v * STRIDE + 1] - c[1], V[v * STRIDE + 2] - c[2])); if (V[v * STRIDE + 1] < V[o.vertices[low] * STRIDE + 1]) low = j; });
      const base = o.vertices[low];
      return { ...o, plant, clumpRand, centre: c, radius: r, root: [V[base * STRIDE], V[base * STRIDE + 2]], order: hash01(0x6f726761, ...where, millimetres(c[0]), millimetres(c[1]), millimetres(c[2])) };
    });
    plantOrgans.sort((a, b) => a.order - b.order);
    plantOrgans.forEach((o, rank) => { o.rank = rank; o.siblings = plantOrgans.length; organs.push(o); });
  });
  return organs;
}
// Whether an organ is kept at a level: the first half of its plant's organs, by a hash of where they stand, at each.
const keptAt = (organ, level) => organ.rank < Math.max(1, Math.ceil(organ.siblings / 2 ** level));

// How each vertex moves when its organ is widened by g: offset * (g - 1). A leaf or culm is rows of three vertices
// round its midrib (and a tip), and widens about each row's middle; a floret or a single scale grows about its centre.
function wideningOf(organ, V) {
  const n = organ.vertices.length, offsets = new Map();
  if (n >= 6 && n % 3 !== 2) {
    const rows = Math.floor(n / 3);
    for (let r = 0; r < rows; r++) {
      const vs = organ.vertices.slice(r * 3, r * 3 + 3), c = [0, 1, 2].map((k) => vs.reduce((s, v) => s + V[v * STRIDE + k], 0) / 3);
      for (const v of vs) offsets.set(v, [0, 1, 2].map((k) => V[v * STRIDE + k] - c[k]));
    }
    if (n % 3 === 1) offsets.set(organ.vertices[n - 1], [0, 0, 0]);
  } else {
    for (const v of organ.vertices) offsets.set(v, [0, 1, 2].map((k) => (V[v * STRIDE + k] - organ.centre[k]) * 0.5));
  }
  return offsets;
}

// The cells of one view a set of triangles covers, their corners at base + offset * grow: `across` and `up` are the
// axes of the view; across always wraps over the tile, up wraps too seen from above and spans the sward's height
// seen from the side.
function rasterCount(mark, across, up, fromAbove, base, offset, grow, corners, triangles) {
  mark.fill(0);
  const cu = RASTER, cv = fromAbove ? RASTER : SIDE_CELLS, su = RASTER / P, sv = fromAbove ? RASTER / P : SIDE_CELLS / SIDE_HEIGHT, ov = fromAbove ? 0 : SIDE_LOW;
  let count = 0;
  for (let k = 0; k < triangles.length; k++) {
    const t = triangles[k] * 3, a = corners[t] * 3, b = corners[t + 1] * 3, c = corners[t + 2] * 3;
    let x0 = (base[a + across] + offset[a + across] * grow) * su, x1 = (base[b + across] + offset[b + across] * grow) * su, x2 = (base[c + across] + offset[c + across] * grow) * su;
    let y0 = (base[a + up] + offset[a + up] * grow - ov) * sv, y1 = (base[b + up] + offset[b + up] * grow - ov) * sv, y2 = (base[c + up] + offset[c + up] * grow - ov) * sv;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const shiftX = Math.floor(Math.min(x0, x1, x2) / cu) * cu;
    x0 -= shiftX; x1 -= shiftX; x2 -= shiftX;
    if (fromAbove) { const shiftY = Math.floor(Math.min(y0, y1, y2) / cv) * cv; y0 -= shiftY; y1 -= shiftY; y2 -= shiftY; }
    const px0 = Math.floor(Math.min(x0, x1, x2) - 0.5), px1 = Math.ceil(Math.max(x0, x1, x2) - 0.5);
    let py0 = Math.floor(Math.min(y0, y1, y2) - 0.5), py1 = Math.ceil(Math.max(y0, y1, y2) - 0.5);
    if (!fromAbove) { py0 = Math.max(0, py0); py1 = Math.min(cv - 1, py1); }
    const inv = 1 / area;
    for (let py = py0; py <= py1; py++) {
      const cy = py + 0.5, row = (((py % cv) + cv) % cv) * cu;
      for (let px = px0; px <= px1; px++) {
        const cx = px + 0.5;
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * inv, w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * inv;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        const at = row + (((px % cu) + cu) % cu);
        if (!mark[at]) { mark[at] = 1; count++; }
      }
    }
  }
  return count;
}
// The sward seen from above: the highest point over each cell and the triangle it lies on (-1 where the ground shows).
function rasterAbove(base, corners, triangleCount) {
  const height = new Float32Array(RASTER * RASTER).fill(-Infinity), owner = new Int32Array(RASTER * RASTER).fill(-1), s = RASTER / P;
  for (let t = 0; t < triangleCount; t++) {
    const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3;
    let x0 = base[a] * s, x1 = base[b] * s, x2 = base[c] * s, y0 = base[a + 2] * s, y1 = base[b + 2] * s, y2 = base[c + 2] * s;
    const h0 = base[a + 1], h1 = base[b + 1], h2 = base[c + 1];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const shiftX = Math.floor(Math.min(x0, x1, x2) / RASTER) * RASTER, shiftY = Math.floor(Math.min(y0, y1, y2) / RASTER) * RASTER;
    x0 -= shiftX; x1 -= shiftX; x2 -= shiftX; y0 -= shiftY; y1 -= shiftY; y2 -= shiftY;
    const px0 = Math.floor(Math.min(x0, x1, x2) - 0.5), px1 = Math.ceil(Math.max(x0, x1, x2) - 0.5);
    const py0 = Math.floor(Math.min(y0, y1, y2) - 0.5), py1 = Math.ceil(Math.max(y0, y1, y2) - 0.5);
    const inv = 1 / area;
    for (let py = py0; py <= py1; py++) {
      const cy = py + 0.5, row = (((py % RASTER) + RASTER) % RASTER) * RASTER;
      for (let px = px0; px <= px1; px++) {
        const cx = px + 0.5;
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * inv, w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * inv, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const at = row + (((px % RASTER) + RASTER) % RASTER), h = w0 * h0 + w1 * h1 + w2 * h2;
        if (h > height[at]) { height[at] = h; owner[at] = t; }
      }
    }
  }
  return { height, owner };
}

// One variant's sward: its organs, the growth of each level, its clusters and their indices, its vertices, and what
// it shows from above, from which the main thread builds its body. Run in a worker.
function bakeSward({ V, I, variant }) {
  const organs = organsOf(variant, V, I);
  // Vertices numbered in the order of their organs' roots along a Morton curve, so a cluster's organs lie near one
  // another in the atlas and its indices fit in 16 bits above its first vertex.
  organs.sort((a, b) => morton(...a.root) - morton(...b.root) || a.plant - b.plant || a.rank - b.rank);
  const local = new Map(), sources = [], clumps = [];
  for (const o of organs) { o.start = sources.length; for (const v of o.vertices) { local.set(v, sources.length); sources.push(v); clumps.push(o.clumpRand); } }
  const count = sources.length;
  if (count >= MEADOW_CONTINUUM_VARIANT_VERTICES) throw Error(`A meadow variant of ${count} vertices outgrows the clusters' reach`);
  const base = new Float64Array(count * 3), offset = new Float64Array(count * 3), normal = new Float64Array(count * 3);
  const offsetUnit = MEADOW_CONTINUUM_OFFSET_UNIT * 127;
  sources.forEach((v, i) => { for (let k = 0; k < 3; k++) { base[i * 3 + k] = V[v * STRIDE + k]; normal[i * 3 + k] = V[v * STRIDE + 3 + k]; } });
  for (const o of organs) {
    o.local = o.triangles.map((v) => local.get(v));
    o.width = 0;
    for (const [v, d] of wideningOf(o, V)) {
      const i = local.get(v);
      for (let k = 0; k < 3; k++) offset[i * 3 + k] = Math.max(-offsetUnit, Math.min(offsetUnit, d[k]));
      o.width = Math.max(o.width, 2 * Math.hypot(offset[i * 3], offset[i * 3 + 1], offset[i * 3 + 2]));
    }
  }
  const corners = Int32Array.from(organs.flatMap((o) => o.local)), triangleCount = corners.length / 3;
  let t0 = 0;
  for (const o of organs) { o.firstTriangle = t0; t0 += o.local.length / 3; }
  const trianglesOf = (list) => {
    const out = new Int32Array(list.reduce((n, o) => n + o.local.length / 3, 0));
    let at = 0;
    for (const o of list) for (let k = 0; k < o.local.length / 3; k++) out[at++] = o.firstTriangle + k;
    return out;
  };
  const colourOf = (i) => [0, 1, 2].map((k) => V[sources[i] * STRIDE + 6 + k] * ALBEDO_SCALE);

  // Each level's growth: the least widening at which its kept organs cover, from above and from two sides, what all
  // of them did; and, should none, the share of that cover lost.
  const marks = [new Uint8Array(RASTER * RASTER), new Uint8Array(RASTER * SIDE_CELLS), new Uint8Array(RASTER * SIDE_CELLS)];
  const covered = (grow, triangles) => rasterCount(marks[0], 0, 2, true, base, offset, grow, corners, triangles)
    + rasterCount(marks[1], 0, 1, false, base, offset, grow, corners, triangles) + rasterCount(marks[2], 2, 1, false, base, offset, grow, corners, triangles);
  const wanted = covered(0, trianglesOf(organs));
  const growth = [1], shortfall = [0];
  for (let level = 1; level < LEVELS; level++) {
    const kept = trianglesOf(organs.filter((o) => keptAt(o, level)));
    let lo = growth[level - 1], hi = Math.max(lo * 2, 2) * 3;
    const widest = covered(hi - 1, kept);
    if (widest < wanted) { growth.push(hi); shortfall.push(1 - widest / wanted); continue; }
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (covered(mid - 1, kept) < wanted) lo = mid; else hi = mid; }
    growth.push(hi); shortfall.push(0);
  }

  // The sward from above: its cover, its highest surface over each cell (the ground where it shows), and the colour
  // seen there.
  const above = rasterAbove(base, corners, triangleCount);
  const triangleColour = (t) => { const a = colourOf(corners[t * 3]), b = colourOf(corners[t * 3 + 1]), c = colourOf(corners[t * 3 + 2]); return [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3); };
  const visible = new Float32Array(RASTER * RASTER), seen = new Float32Array(RASTER * RASTER * 3);
  let coveredCells = 0, heightSum = 0;
  const top = [0, 0, 0];
  for (let i = 0; i < RASTER * RASTER; i++) {
    if (above.owner[i] < 0) continue;
    visible[i] = Math.max(0, above.height[i]); coveredCells++; heightSum += visible[i];
    const c = triangleColour(above.owner[i]);
    for (let k = 0; k < 3; k++) { seen[i * 3 + k] = c[k]; top[k] += c[k]; }
  }
  const coverage = coveredCells / (RASTER * RASTER), visibleMean = heightSum / (RASTER * RASTER);
  const topColour = coveredCells ? top.map((v) => v / coveredCells) : [0.06, 0.1, 0.04];
  // What height along their stalks the organs seen from above show, as the shading reads it: the shader warms a
  // blade's head from along 0.76 to 0.94 (meadowShade), so the mean of that warming over what is seen, and the along
  // that gives it.
  const alongOf = (i) => V[sources[i] * STRIDE + 9];
  const ramp = (x) => { const t = Math.min(1, Math.max(0, (x - 0.76) / 0.18)); return t * t * (3 - 2 * t); };
  let headShare = 0;
  for (let i = 0; i < RASTER * RASTER; i++) {
    const t = above.owner[i];
    if (t >= 0) headShare += ramp((alongOf(corners[t * 3]) + alongOf(corners[t * 3 + 1]) + alongOf(corners[t * 3 + 2])) / 3);
  }
  headShare = coveredCells ? headShare / coveredCells : 0;
  const seenAlong = 0.76 + 0.18 * (0.5 - Math.sin(Math.asin(1 - 2 * headShare) / 3));
  // From the side: each triangle's colour by the area it turns sideways and how high it stands.
  const side = [0, 0, 0, 0];
  for (let t = 0; t < triangleCount; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => corners[t * 3 + k] * 3);
    const e = [0, 1, 2].map((k) => base[b + k] - base[a + k]), f = [0, 1, 2].map((k) => base[c + k] - base[a + k]);
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]], area = Math.hypot(...n) / 2, up = area > 0 ? Math.abs(n[1]) / (2 * area) : 0;
    const y = (base[a + 1] + base[b + 1] + base[c + 1]) / 3, col = triangleColour(t);
    const add = (sum, w) => { for (let k = 0; k < 3; k++) sum[k] += col[k] * w; sum[3] += w; };
    add(side, area * (1 - up) * Math.max(y, 0));
  }
  const mean = (sum, fallback) => (sum[3] > 0 ? sum.slice(0, 3).map((v) => v / sum[3]) : fallback);
  // The body's grid: at each vertex (wrapped, as the tiles repeat), over the metre round it, the height half the view
  // from above lies below, the share it covers and the colour it shows.
  const G = BODY_CELLS, window = RASTER / G, gridHeight = new Float32Array(G * G), gridCover = new Float32Array(G * G), gridColour = new Float32Array(G * G * 3);
  const heights = new Float32Array(window * window * 4);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    let n = 0, hidden = 0;
    const colour = [0, 0, 0];
    for (let y = j * window - window; y < j * window + window; y++) for (let x = i * window - window; x < i * window + window; x++) {
      const at = (((y % RASTER) + RASTER) % RASTER) * RASTER + (((x % RASTER) + RASTER) % RASTER);
      heights[n++] = visible[at];
      if (above.owner[at] >= 0) { hidden++; for (let k = 0; k < 3; k++) colour[k] += seen[at * 3 + k]; }
    }
    gridHeight[j * G + i] = quantileOf(heights, BODY_QUANTILE);
    gridCover[j * G + i] = hidden / n;
    for (let k = 0; k < 3; k++) gridColour[(j * G + i) * 3 + k] = hidden ? colour[k] / hidden : topColour[k];
  }

  // Cells and their errors. An organ belongs to the cell its lowest point stands in.
  const cellOf = (o, level) => {
    const n = meadowContinuumCellsAt(level), s = P / n;
    return Math.min(n - 1, Math.max(0, Math.floor(o.root[1] / s))) * n + Math.min(n - 1, Math.max(0, Math.floor(o.root[0] / s)));
  };
  // A cell's children at the level below: four, or itself where the cells no longer halve.
  const childrenOf = (level, i, j) => {
    const n = meadowContinuumCellsAt(level), below = meadowContinuumCellsAt(level - 1);
    return below === n ? [j * n + i] : [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => (j * 2 + b) * below + i * 2 + a);
  };
  const parentOf = (level, c) => {
    if (level + 1 >= LEVELS) return -1;
    const n = meadowContinuumCellsAt(level), above1 = meadowContinuumCellsAt(level + 1);
    return above1 === n ? c : Math.floor((c % n) / 2) + Math.floor(Math.floor(c / n) / 2) * above1;
  };
  const widened = (g) => { const out = new Float64Array(count * 3); for (let i = 0; i < out.length; i++) out[i] = base[i] + offset[i] * (g - 1); return out; };
  const errors = [], spheres = [];
  for (let level = 0; level < LEVELS; level++) {
    const n = meadowContinuumCellsAt(level), kept = organs.filter((o) => keptAt(o, level));
    const position = widened(growth[level]);
    // As the forest's leaves: a share of the mean width its kept organs are grown to; and the height of any cover lost.
    const widths = Array.from({ length: n * n }, () => [0, 0]);
    if (level > 0) for (const o of kept) { const w = widths[cellOf(o, level)]; w[0] += o.width * growth[level]; w[1]++; }
    const own = widths.map(([sum, k]) => (k ? (sum / k) * ORGAN_ERROR_SHARE : 0) + shortfall[level] * visibleMean);
    // Each cell's LOD sphere holds what it draws and its children's spheres.
    const points = Array.from({ length: n * n }, () => []);
    for (const o of kept) { const c = cellOf(o, level); for (let v = o.start; v < o.start + o.vertices.length; v++) points[c].push(v); }
    const levelErrors = new Float64Array(n * n), levelSpheres = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const c = j * n + i, children = level ? childrenOf(level, i, j) : [];
      levelErrors[c] = Math.max(own[c], ...children.map((k) => errors[level - 1][k] * 1.05 + 1e-4));
      const mine = points[c].length ? sphereOfVertices(position, points[c]) : [(i + 0.5) * P / n, 0, (j + 0.5) * P / n, 1e-3];
      levelSpheres[c] = sphereOf([], [mine, ...children.map((k) => spheres[level - 1][k])]);
    }
    errors.push(levelErrors); spheres.push(levelSpheres);
  }

  // Clusters: each cell's kept organs in Morton order, filled up to the cluster's triangles while their vertices stay
  // within 16 bits of the first; an organ is never split.
  const clusters = [], indexChunks = [];
  let indexWords = 0;
  for (let level = 0; level < LEVELS; level++) {
    const n = meadowContinuumCellsAt(level), position = widened(growth[level]), byCell = Array.from({ length: n * n }, () => []);
    for (const o of organs) if (keptAt(o, level)) byCell[cellOf(o, level)].push(o);
    byCell.forEach((list, c) => {
      list.sort((a, b) => a.start - b.start);
      const parentCell = parentOf(level, c);
      const parentError = parentCell >= 0 ? errors[level + 1][parentCell] : 1e30, parentLod = parentCell >= 0 ? spheres[level + 1][parentCell] : spheres[level][c];
      let open = [], tris = 0, low = Infinity, high = -Infinity;
      const close = () => {
        if (!open.length) return;
        const offsets = [], used = [];
        for (const o of open) { for (const v of o.local) offsets.push(v - low); for (let v = o.start; v < o.start + o.vertices.length; v++) used.push(v); }
        const words = packMeadowContinuumIndices(offsets);
        clusters.push({ lod: spheres[level][c], parentLod, cull: sphereOfVertices(position, used), error: errors[level][c], parentError, first: indexWords, triangles: tris, level, vertexBase: low });
        indexChunks.push(words); indexWords += words.length;
        open = []; tris = 0; low = Infinity; high = -Infinity;
      };
      for (const o of list) {
        const t = o.local.length / 3, end = o.start + o.vertices.length - 1;
        if (t > MEADOW_CONTINUUM_CLUSTER_TRIANGLES) throw Error(`An organ of ${t} triangles outgrows a cluster`);
        if (o.vertices.length > MEADOW_CONTINUUM_CLUSTER_SPAN) throw Error(`An organ of ${o.vertices.length} vertices outgrows a cluster's indices`);
        if (tris + t > MEADOW_CONTINUUM_CLUSTER_TRIANGLES || Math.max(high, end) - Math.min(low, o.start) >= MEADOW_CONTINUUM_CLUSTER_SPAN) close();
        open.push(o); tris += t; low = Math.min(low, o.start); high = Math.max(high, end);
      }
      close();
    });
  }
  // Coarsest parent first, so the clusters that can be drawn at a patch's nearest point are a prefix.
  clusters.sort((a, b) => b.parentError - a.parentError || a.level - b.level);
  const clusterWords = new Uint32Array(clusters.length * MEADOW_CONTINUUM_CLUSTER_WORDS);
  clusters.forEach((c, k) => clusterWords.set(packMeadowContinuumCluster(c), k * MEADOW_CONTINUUM_CLUSTER_WORDS));
  const indices = new Uint32Array(indexWords);
  let at = 0;
  for (const chunk of indexChunks) { indices.set(chunk, at); at += chunk.length; }

  const vertexWords = new Uint32Array(count * MEADOW_CONTINUUM_VERTEX_WORDS);
  sources.forEach((v, i) => vertexWords.set(packMeadowContinuumVertex({
    position: [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]], normal: [normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]], colour: colourOf(i),
    along: V[v * STRIDE + 9], stiffness: V[v * STRIDE + 10], clump: clumps[i],
    offset: [offset[i * 3], offset[i * 3 + 1], offset[i * 3 + 2]],
  }, { low: ATLAS_LOW, span: ATLAS_SPAN }), i * MEADOW_CONTINUUM_VERTEX_WORDS));
  const all = [...Array(count).keys()];
  const sphere = sphereOf([], [sphereOfVertices(base, all), sphereOfVertices(widened(growth[LEVELS - 1]), all)]);
  return {
    organs: organs.length, swardVertices: count, sourceTriangles: triangleCount, growth, shortfall, clusterWords, clusterCount: clusters.length, indices,
    vertexWords, sphere, rootError: Math.max(...errors[LEVELS - 1]), levelErrors: errors.map((list) => Math.max(...list)),
    levelTriangles: Array.from({ length: LEVELS }, (_, l) => clusters.filter((c) => c.level === l).reduce((s, c) => s + c.triangles, 0)),
    coverage, visibleMean, visible, topColour, sideColour: mean(side, topColour), seenAlong, headShare, gridHeight, gridCover, gridColour,
  };
}

// The body every variant's edge shares: the mean of their edges' heights, colours and cover.
function commonRim(swards) {
  const G = BODY_CELLS, rim = { height: 0, colour: [0, 0, 0], cover: 0 };
  let n = 0;
  for (const s of swards) for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    if (i && j) continue;
    const c = j * G + i;
    rim.height += s.gridHeight[c]; rim.cover += s.gridCover[c]; for (let k = 0; k < 3; k++) rim.colour[k] += s.gridColour[c * 3 + k]; n++;
  }
  return { height: rim.height / n, cover: rim.cover / n, colour: rim.colour.map((v) => v / n) };
}

// One variant's closed canopy body over the patch, its collapse chain and the error and growth of every step.
function bakeBody(sward, rim) {
  const G = BODY_CELLS, step = P / G, side1 = G + 1;
  const isRim = (i, j) => i % G === 0 || j % G === 0;
  const cell = (i, j) => (((j % G) + G) % G) * G + (((i % G) + G) % G);
  const heightAt = (i, j) => (isRim(i, j) ? rim.height : sward.gridHeight[cell(i, j)]);
  const coverAt = (i, j) => (isRim(i, j) ? rim.cover : sward.gridCover[cell(i, j)]);
  const colourAt = (i, j) => (isRim(i, j) ? rim.colour : [0, 1, 2].map((k) => sward.gridColour[cell(i, j) * 3 + k]));
  // The body's top under any point of the patch.
  const bodyAt = (x, z) => {
    const u = x / step, v = z / step, i = Math.min(G - 1, Math.floor(u)), j = Math.min(G - 1, Math.floor(v)), fu = u - i, fv = v - j;
    return (heightAt(i, j) * (1 - fu) + heightAt(i + 1, j) * fu) * (1 - fv) + (heightAt(i, j + 1) * (1 - fu) + heightAt(i + 1, j + 1) * fu) * fv;
  };
  // Its error: how far from its top nine tenths of the sward seen from above lie, ground in its gaps included.
  const misses = new Float32Array(RASTER * RASTER);
  for (let z = 0; z < RASTER; z++) for (let x = 0; x < RASTER; x++) misses[z * RASTER + x] = Math.abs(sward.visible[z * RASTER + x] - bodyAt(((x + 0.5) * P) / RASTER, ((z + 0.5) * P) / RASTER));
  const baseError = quantileOf(misses, BODY_ERROR_QUANTILE);

  // The slab: a top and a floor of (G + 1)^2 vertices, joined round the edge, every face wound outward. The edge's
  // normals stand straight up, as every variant's do. The floor lies under the ground and is never seen, but the
  // walls rise from it between neighbouring patches: it carries the edge's colour, cover and height along the
  // stalk, so a wall is shaded as the edge it stands under and no seam shows.
  const slabPosition = [], slabNormal = [], slabColour = [], slabAlong = [], slabCover = [], slabIndex = [];
  for (const layer of [0, 1]) for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
    slabPosition.push(i * step, layer ? BODY_FLOOR : heightAt(i, j), j * step);
    if (layer) { slabNormal.push(0, -1, 0); slabColour.push(rim.colour); slabAlong.push(sward.seenAlong); slabCover.push(rim.cover); continue; }
    if (isRim(i, j)) slabNormal.push(0, 1, 0);
    else {
      const dx = (heightAt(i + 1, j) - heightAt(i - 1, j)) / (2 * step), dz = (heightAt(i, j + 1) - heightAt(i, j - 1)) / (2 * step), l = Math.hypot(dx, 1, dz);
      slabNormal.push(-dx / l, 1 / l, -dz / l);
    }
    slabColour.push(colourAt(i, j)); slabAlong.push(sward.seenAlong); slabCover.push(coverAt(i, j));
  }
  const vtx = (layer, i, j) => layer * side1 * side1 + j * side1 + i;
  const outward = (a, b, c, want) => {
    const p = (v, k) => slabPosition[v * 3 + k], e = [0, 1, 2].map((k) => p(b, k) - p(a, k)), f = [0, 1, 2].map((k) => p(c, k) - p(a, k));
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
    slabIndex.push(...(n[0] * want[0] + n[1] * want[1] + n[2] * want[2] >= 0 ? [a, b, c] : [a, c, b]));
  };
  for (const layer of [0, 1]) for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const want = [0, layer ? -1 : 1, 0], q = [vtx(layer, i, j), vtx(layer, i + 1, j), vtx(layer, i + 1, j + 1), vtx(layer, i, j + 1)];
    outward(q[0], q[1], q[2], want); outward(q[0], q[2], q[3], want);
  }
  const walls = [];
  for (let i = 0; i < G; i++) walls.push([[i, 0], [i + 1, 0], [0, 0, -1]], [[i, G], [i + 1, G], [0, 0, 1]], [[0, i], [0, i + 1], [-1, 0, 0]], [[G, i], [G, i + 1], [1, 0, 0]]);
  for (const [[ai, aj], [bi, bj], want] of walls) {
    const a = vtx(0, ai, aj), b = vtx(0, bi, bj), c = vtx(1, bi, bj), d = vtx(1, ai, aj);
    outward(a, b, c, want); outward(a, c, d, want);
  }
  const census = edgeCensus(slabIndex);
  if (census.boundary || census.nonManifold) throw Error(`The canopy slab is not closed: ${JSON.stringify(census)}`);
  const position = Float64Array.from(slabPosition), slabN = Float64Array.from(slabNormal), index = Int32Array.from(slabIndex);
  const SV = position.length / 3, ST = index.length / 3;
  const chain = collapseChain(position, index, CHAIN_LEAST_TRIANGLES), S = chain.steps.length;
  let depth = 0;
  for (let v = 0; v < SV; v++) { let d = 0; for (let w = v; chain.dieStep[w] >= 0; w = chain.target[w]) d++; depth = Math.max(depth, d); }
  if (depth > MEADOW_CONTINUUM_HOPS) throw Error(`A canopy vertex collapses ${depth} times, past the GPU's ${MEADOW_CONTINUUM_HOPS}`);
  // Every step's error and growth, measured.
  const allBase = Array.from({ length: ST }, (_, t) => t), baseFans = Array.from({ length: SV }, () => []);
  allBase.forEach((t) => { for (let k = 0; k < 3; k++) baseFans[index[t * 3 + k]].push(t); });
  const slabFrame = { low: [-0.6, -0.6, -0.6], size: P + 1.2, cells: 128 };
  const wantedOutline = outline(position, slabN, index, allBase, 0, slabFrame).reduce((n, view) => n + view.covered, 0);
  const near = (px, py, pz, list, cs) => {
    let best = Infinity;
    for (const t of list) {
      const a = cs[t * 3] * 3, b = cs[t * 3 + 1] * 3, c = cs[t * 3 + 2] * 3;
      closestOnTriangle(px, py, pz, position[a], position[a + 1], position[a + 2], position[b], position[b + 1], position[b + 2], position[c], position[c + 1], position[c + 2]);
      best = Math.min(best, closest[0]);
    }
    return Math.sqrt(best);
  };
  const measured = new Float64Array(S + 1), inflates = new Float64Array(S + 1), stepCorners = new Int32Array(ST * 3);
  for (let s = 0; s <= S; s++) {
    const living = allBase.filter((t) => chain.death[t] < 0 || chain.death[t] > s);
    for (const t of living) for (let k = 0; k < 3; k++) stepCorners[t * 3 + k] = ancestor(chain, index[t * 3 + k], s);
    const fans = new Map(), members = new Map();
    for (const t of living) for (let k = 0; k < 3; k++) { const a = stepCorners[t * 3 + k]; if (!fans.has(a)) fans.set(a, []); fans.get(a).push(t); }
    for (let v = 0; v < SV; v++) { const a = ancestor(chain, v, s); if (!members.has(a)) members.set(a, []); members.get(a).push(v); }
    let error = 0;
    for (let v = 0; v < SV; v++) { const list = fans.get(ancestor(chain, v, s)); if (list) error = Math.max(error, near(position[v * 3], position[v * 3 + 1], position[v * 3 + 2], list, stepCorners)); }
    for (const t of living) {
      const [a, b, c] = [0, 1, 2].map((k) => stepCorners[t * 3 + k]), candidates = new Set();
      for (const corner of [a, b, c]) for (const m of members.get(corner) ?? []) for (const u of baseFans[m]) candidates.add(u);
      error = Math.max(error, near((position[a * 3] + position[b * 3] + position[c * 3]) / 3, (position[a * 3 + 1] + position[b * 3 + 1] + position[c * 3 + 1]) / 3, (position[a * 3 + 2] + position[b * 3 + 2] + position[c * 3 + 2]) / 3, [...candidates], index));
    }
    const cast = (d) => outline(position, slabN, stepCorners, living, d, slabFrame).reduce((n, view) => n + view.covered, 0);
    if (s > 0 && cast(0) < wantedOutline) {
      let lo = 0, hi = P * 0.25;
      for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (cast(mid) < wantedOutline) lo = mid; else hi = mid; }
      inflates[s] = (lo + hi) / 2;
    }
    measured[s] = baseError + error;
  }
  // Flat collapses (the floor, the edge, a level top) cost nothing measurable, so a run of steps shares one error and
  // the morph would leap them. Between the steps where the error truly rises it rises in proportion, never below what
  // was measured, and every step rises over the one before.
  const knots = [0];
  for (let s = 1; s <= S; s++) if (measured[s] > measured[knots.at(-1)] * (1 + KNOT_RISE)) knots.push(s);
  if (knots.at(-1) !== S) knots.push(S);
  const stepErrors = new Float64Array(S + 1);
  for (let k = 0; k + 1 < knots.length; k++) {
    const a = knots[k], b = knots[k + 1], ea = measured[a], eb = Math.max(measured[b], ea * (1 + KNOT_RISE));
    for (let s = a; s <= b; s++) stepErrors[s] = Math.max(measured[s], ea * (eb / ea) ** ((s - a) / (b - a)));
  }
  for (let s = 1; s <= S; s++) stepErrors[s] = Math.max(stepErrors[s], stepErrors[s - 1] * (1 + STEP_RISE));
  const order = allBase.slice().sort((p, q) => (chain.death[q] < 0 ? Infinity : chain.death[q]) - (chain.death[p] < 0 ? Infinity : chain.death[p]));
  const dying = new Int32Array(S + 2);
  for (let t = 0; t < ST; t++) if (chain.death[t] >= 0) dying[chain.death[t]]++;
  const alive = [];
  for (let s = 0, n = ST; s <= S; s++) { n -= dying[s]; alive.push(n); }
  // The far body takes over only where the clusters have reached their coarsest: from the first step whose error is
  // no finer than the patch's coarsest cell's.
  const reached = Array.from(stepErrors).findIndex((e) => e >= sward.rootError), farFirst = reached < 0 ? S : reached;
  let canopy = 0;
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) canopy += heightAt(i, j) / (side1 * side1);

  const vertexWords = new Uint32Array(SV * MEADOW_CONTINUUM_VERTEX_WORDS);
  for (let v = 0; v < SV; v++) vertexWords.set(packMeadowContinuumVertex({
    position: [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]], normal: [slabN[v * 3], slabN[v * 3 + 1], slabN[v * 3 + 2]],
    colour: slabColour[v], along: slabAlong[v], cover: slabCover[v],
  }, { low: ATLAS_LOW, span: ATLAS_SPAN }), v * MEADOW_CONTINUUM_VERTEX_WORDS);
  const records = Uint32Array.from({ length: SV }, (_, v) => (chain.dieStep[v] < 0 ? MEADOW_CONTINUUM_NEVER : (chain.dieStep[v] | (chain.target[v] << 16)) >>> 0));
  const triangles = Uint32Array.from(order.flatMap((t) => [index[t * 3], index[t * 3 + 1], index[t * 3 + 2], 0]));
  const steps = new Uint32Array((S + 1) * MEADOW_CONTINUUM_STEP_WORDS), stepFloats = new Float32Array(steps.buffer);
  for (let s = 0; s <= S; s++) { steps[s * 4] = alive[s]; stepFloats[s * 4 + 1] = stepErrors[s]; stepFloats[s * 4 + 2] = inflates[s]; }
  const slabPoints = Array.from({ length: SV }, (_, v) => [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]]);
  return {
    vertexWords, records, triangles, steps, canopy, sphere: sphereOf(slabPoints, [sward.sphere]),
    chain: { baseTriangles: ST, steps: S, coreTriangles: alive[S], farFirst, baseError, firstError: stepErrors[farFirst], lastError: stepErrors[S], depth, vertices: SV, knots: knots.length },
  };
}

// The worker: one variant's sward at a time, the groves shared.
if (!isMainThread) {
  const V = new Float32Array(workerData.vertices), I = new Uint32Array(workerData.indices);
  parentPort.on('message', ({ id, variant }) => {
    try {
      const s = bakeSward({ V, I, variant });
      parentPort.postMessage({ id, sward: s }, [s.clusterWords.buffer, s.indices.buffer, s.vertexWords.buffer, s.visible.buffer]);
    } catch (error) { parentPort.postMessage({ id, error: String(error?.stack ?? error) }); }
  });
}

async function bakePack(name) {
  const started = Date.now(), pack = PACKS[name], source = path.join(root, pack.source), out = path.join(root, path.dirname(pack.assets['manifest.json']));
  const manifestBytes = fs.readFileSync(path.join(source, 'manifest.json'));
  const groves = JSON.parse(manifestBytes);
  if (groves.format !== 'waterworld.meadow-groves' || groves.tileMetres !== P) throw Error(`The ${name} meadow groves are not the 4 m tiles this bake reads`);
  if (groves.mixes?.length !== MEADOW_MIX_ROLES.length) throw Error(`The ${name} meadow groves need ${MEADOW_MIX_ROLES.length} mixes`);
  const vertexBytes = zlib.gunzipSync(fs.readFileSync(path.join(source, groves.streams.vertices.file)));
  const indexBytes = zlib.gunzipSync(fs.readFileSync(path.join(source, groves.streams.indices.file)));
  if (sha256(vertexBytes) !== groves.streams.vertices.rawSha256 || sha256(indexBytes) !== groves.streams.indices.rawSha256) throw Error(`The ${name} meadow groves failed verification`);
  const shared = (bytes) => { const b = new SharedArrayBuffer(bytes.byteLength); new Uint8Array(b).set(bytes); return b; };
  const vertices = shared(vertexBytes), indices = shared(indexBytes);

  const jobs = [];
  groves.mixes.forEach((mix, mixIndex) => groves.groves[mix].variants.forEach((variant, variantIndex) => jobs.push({ id: jobs.length, mix, mixIndex, variantIndex, variant })));
  if (jobs.length !== 12) throw Error(`The ${name} groves hold ${jobs.length} variants, not 12`);
  const swards = new Array(jobs.length);
  const threads = Math.max(1, Math.min(jobs.length, os.availableParallelism?.() ?? os.cpus().length, 8));
  await new Promise((resolve, reject) => {
    let next = 0, done = 0;
    const workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url), { workerData: { vertices, indices } }));
    const feed = (worker) => { if (next < jobs.length) { const job = jobs[next++]; worker.postMessage({ id: job.id, variant: job.variant }); } };
    for (const worker of workers) {
      worker.on('message', ({ id, sward, error }) => {
        if (error) { workers.forEach((w) => w.terminate()); reject(Error(`${name} ${jobs[id].mix} ${jobs[id].variantIndex}: ${error}`)); return; }
        swards[id] = sward;
        console.log(`${name} ${jobs[id].mix} ${jobs[id].variantIndex}: ${sward.sourceTriangles} triangles, ${sward.organs} organs, cover ${(sward.coverage * 100).toFixed(1)}%; levels ${sward.levelTriangles.join(' / ')}; errors ${sward.levelErrors.map((e) => e.toFixed(3)).join(' / ')} m; growth ${sward.growth.map((g) => g.toFixed(1)).join(' / ')}`);
        if (++done === jobs.length) { workers.forEach((w) => w.terminate()); resolve(); } else feed(worker);
      });
      worker.on('error', (error) => { workers.forEach((w) => w.terminate()); reject(error); });
      feed(worker);
    }
  });

  const rim = commonRim(swards);
  const bodies = swards.map((s, id) => {
    const b = bakeBody(s, rim);
    console.log(`${name} ${jobs[id].mix} ${jobs[id].variantIndex}: body ${b.canopy.toFixed(3)} m, ${b.chain.baseTriangles} -> ${b.chain.coreTriangles} triangles in ${b.chain.steps} steps (${b.chain.knots} knots), from step ${b.chain.farFirst} at ${b.chain.firstError.toFixed(3)} m to ${b.chain.lastError.toFixed(3)} m`);
    return b;
  });
  const farError = Math.max(...bodies.map((b) => b.chain.firstError)), canopy = bodies.reduce((s, b) => s + b.canopy, 0) / bodies.length;

  // The atlas: header, variants, clusters, vertices, indices, then each variant's chain.
  const H = MEADOW_CONTINUUM_HEADER, R = MEADOW_CONTINUUM_VARIANT;
  const clusterCount = swards.reduce((n, s) => n + s.clusterCount, 0), indexWordCount = swards.reduce((n, s) => n + s.indices.length, 0);
  const vertexCount = swards.reduce((n, s, id) => n + s.swardVertices + bodies[id].vertexWords.length / MEADOW_CONTINUUM_VERTEX_WORDS, 0);
  const variantsAt = MEADOW_CONTINUUM_HEADER_WORDS, clustersAt = variantsAt + jobs.length * MEADOW_CONTINUUM_VARIANT_WORDS;
  const verticesAt = clustersAt + clusterCount * MEADOW_CONTINUUM_CLUSTER_WORDS, indicesAt = verticesAt + vertexCount * MEADOW_CONTINUUM_VERTEX_WORDS;
  const chainsAt = indicesAt + indexWordCount;
  const words = chainsAt + bodies.reduce((n, b) => n + b.records.length + b.triangles.length + b.steps.length, 0);
  const atlas = new Uint32Array(words), floats = new Float32Array(atlas.buffer);
  atlas[H.magic] = MEADOW_CONTINUUM_MAGIC; atlas[H.version] = MEADOW_CONTINUUM_VERSION; atlas[H.variantCount] = jobs.length;
  atlas[H.variantsAt] = variantsAt; atlas[H.clustersAt] = clustersAt; atlas[H.clusterCount] = clusterCount;
  atlas[H.verticesAt] = verticesAt; atlas[H.vertexCount] = vertexCount; atlas[H.indicesAt] = indicesAt; atlas[H.indexCount] = indexWordCount * 2;
  atlas[H.chainsAt] = chainsAt; atlas[H.words] = words; floats[H.patch] = P; floats.set(ATLAS_LOW, H.low); floats[H.span] = ATLAS_SPAN;
  floats[H.farError] = farError; floats[H.canopy] = canopy; floats[H.rim] = rim.height;
  let clusterAt = 0, vertexAt = 0, indexAt = 0, chainAt = chainsAt;
  swards.forEach((s, id) => {
    const b = bodies[id], r = variantsAt + id * MEADOW_CONTINUUM_VARIANT_WORDS;
    atlas[r + R.clusterFirst] = clusterAt; atlas[r + R.clusterCount] = s.clusterCount;
    for (let k = 0; k < s.clusterCount; k++) s.clusterWords[k * MEADOW_CONTINUUM_CLUSTER_WORDS + 14] += indexAt;
    atlas.set(s.clusterWords, clustersAt + clusterAt * MEADOW_CONTINUUM_CLUSTER_WORDS); clusterAt += s.clusterCount;
    atlas[r + R.vertexBase] = vertexAt;
    atlas.set(s.vertexWords, verticesAt + vertexAt * MEADOW_CONTINUUM_VERTEX_WORDS);
    atlas.set(b.vertexWords, verticesAt + (vertexAt + s.swardVertices) * MEADOW_CONTINUUM_VERTEX_WORDS);
    atlas[r + R.chainVertices] = vertexAt + s.swardVertices; atlas[r + R.chainVertexCount] = b.chain.vertices;
    vertexAt += s.swardVertices + b.chain.vertices;
    atlas.set(s.indices, indicesAt + indexAt); indexAt += s.indices.length;
    atlas[r + R.records] = chainAt; atlas.set(b.records, chainAt); chainAt += b.records.length;
    atlas[r + R.triangles] = chainAt; atlas.set(b.triangles, chainAt); chainAt += b.triangles.length;
    atlas[r + R.steps] = chainAt; atlas.set(b.steps, chainAt); chainAt += b.steps.length;
    atlas[r + R.stepCount] = b.chain.steps; atlas[r + R.chainTriangleCount] = b.chain.baseTriangles; atlas[r + R.farFirst] = b.chain.farFirst;
    floats[r + R.baseError] = b.chain.baseError; floats[r + R.canopy] = b.canopy; floats.set(b.sphere, r + R.sphere);
    floats.set(s.topColour, r + R.topColour); floats.set(s.sideColour, r + R.sideColour);
    atlas[r + R.mix] = jobs[id].mixIndex; atlas[r + R.sourceTriangles] = s.sourceTriangles; floats.set(s.growth, r + R.growth);
    floats[r + R.coverage] = s.coverage; floats[r + R.firstError] = b.chain.firstError; floats[r + R.seenAlong] = s.seenAlong;
  });
  if (chainAt !== words || vertexAt !== vertexCount || indexAt !== indexWordCount) throw Error('The atlas was laid out wrongly');

  const bytes = new Uint8Array(atlas.buffer), gzip = zlib.gzipSync(bytes, { level: 9 });
  fs.mkdirSync(out, { recursive: true });
  for (const file of fs.readdirSync(out)) fs.rmSync(path.join(out, file));
  fs.writeFileSync(path.join(root, pack.assets['atlas.bin.gz']), gzip);
  const manifest = {
    format: MEADOW_CONTINUUM_FORMAT, version: MEADOW_CONTINUUM_VERSION, generator: 'scripts/prepare-meadow-grass.mjs', pack: name,
    source: { format: groves.format, generator: groves.generator, manifestSha256: sha256(manifestBytes), vertices: groves.streams.vertices.rawSha256, indices: groves.streams.indices.rawSha256 },
    patchMetres: P, levels: LEVELS, cells: MEADOW_CONTINUUM_CELLS, mixes: groves.mixes, roles: MEADOW_MIX_ROLES,
    body: { cells: BODY_CELLS, quantile: BODY_QUANTILE, errorQuantile: BODY_ERROR_QUANTILE, rim: { height: +rim.height.toFixed(4), cover: +rim.cover.toFixed(4), colour: rim.colour.map((v) => +v.toFixed(5)) } },
    organErrorShare: ORGAN_ERROR_SHARE, farError: +farError.toFixed(5), canopy: +canopy.toFixed(4),
    variants: swards.map((s, id) => {
      const b = bodies[id];
      return {
        id, mix: jobs[id].mixIndex, variant: jobs[id].variantIndex, sourceTriangles: s.sourceTriangles, organs: s.organs, clusters: s.clusterCount, coverage: +s.coverage.toFixed(4),
        levels: s.levelTriangles.map((triangles, level) => ({ triangles, error: +s.levelErrors[level].toFixed(5), growth: +s.growth[level].toFixed(4), shortfall: +s.shortfall[level].toFixed(4) })),
        chain: { baseTriangles: b.chain.baseTriangles, steps: b.chain.steps, coreTriangles: b.chain.coreTriangles, farFirst: b.chain.farFirst, baseError: +b.chain.baseError.toFixed(5), firstError: +b.chain.firstError.toFixed(5), lastError: +b.chain.lastError.toFixed(5), hops: b.chain.depth, knots: b.chain.knots },
        splat: { canopy: +b.canopy.toFixed(4), seenAlong: +s.seenAlong.toFixed(4), headShare: +s.headShare.toFixed(4), topColour: s.topColour.map((v) => +v.toFixed(5)), sideColour: s.sideColour.map((v) => +v.toFixed(5)), sphere: b.sphere.map((v) => +v.toFixed(4)) },
      };
    }),
    atlas: { words, bytes: bytes.byteLength, sha256: sha256(bytes), gzip: { file: path.basename(pack.assets['atlas.bin.gz']), bytes: gzip.byteLength, sha256: sha256(gzip) }, clusters: clusterCount, vertices: vertexCount, indices: indexWordCount * 2 },
  };
  fs.writeFileSync(path.join(root, pack.assets['manifest.json']), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${name} meadow continuum: ${jobs.length} variants, ${clusterCount} clusters, ${vertexCount} vertices, far error ${farError.toFixed(3)} m; ${(bytes.byteLength / 1048576).toFixed(1)} MiB, ${(gzip.byteLength / 1048576).toFixed(1)} MiB gzipped, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

if (isMainThread) {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PACKS);
  for (const name of names) if (!PACKS[name]) throw Error(`No meadow pack ${name}; there are ${Object.keys(PACKS).join(', ')}`);
  for (const name of names) await bakePack(name);
}
