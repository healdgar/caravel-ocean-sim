#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes the meadow continuum (js/meadow-continuum.js; AGENTS.md rule 3) from the Portuguese meadow groves: twelve 4 m
// tiles (three mixes, four variants each) drawn plant by plant at full resolution by forestmodeler, kept out of git in
// assets/ground-cover/portugal/meadows/. Each tile becomes one patch:
//   - a cluster hierarchy of five levels, cells 16 to a side down to one. A level keeps half the organs (leaves, culms,
//     florets) of every plant of the level below, never fewer than one, and widens each kept organ about its own
//     midrib until the patch covers, seen from above and from two sides, what the full sward did. As the forest's leaves,
//     a cell's error is a share of the width its kept organs are grown to, never less than its children's.
//   The far body takes over from the first of its steps no finer than the coarsest level.
//   - a closed canopy body: the sward's canopy (where 85% of its surface lies below) as a slab over the patch, wound
//     outward, collapsed one half-edge at a time down to a core of a few triangles, its error measured at every eighth
//     step and its growth along its normals measured to keep its outline.
//   - its splat: the canopy's height and the sward's mean colour from above and from the side.
// Plants on a tile's edge band are the same in every variant of a mix, and their dropped organs are chosen by where
// they stand, so neighbouring patches of one mix agree across their seam at every level.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { collapseChain, ancestor, closestOnTriangle, closest, outline, edgeCensus } from '../js/continuum-bake.js';
import {
  MEADOW_CONTINUUM_FORMAT, MEADOW_CONTINUUM_VERSION, MEADOW_CONTINUUM_MAGIC, MEADOW_PATCH_METRES, MEADOW_CONTINUUM_LEVELS,
  MEADOW_CONTINUUM_CELLS, MEADOW_CONTINUUM_HEADER_WORDS, MEADOW_CONTINUUM_HEADER, MEADOW_CONTINUUM_VARIANT_WORDS,
  MEADOW_CONTINUUM_VARIANT, MEADOW_CONTINUUM_CLUSTER_WORDS, MEADOW_CONTINUUM_CLUSTER_TRIANGLES, MEADOW_CONTINUUM_VERTEX_WORDS,
  MEADOW_CONTINUUM_STEP_WORDS, MEADOW_CONTINUUM_TRIANGLE_WORDS, MEADOW_CONTINUUM_NEVER, MEADOW_CONTINUUM_HOPS,
  MEADOW_CONTINUUM_OFFSET_UNIT, PORTUGAL_MEADOW_GRASS_ASSETS, packMeadowContinuumVertex, packMeadowContinuumCluster,
} from '../js/meadow-continuum.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOURCE = path.join(root, 'assets/ground-cover/portugal/meadows');
const OUT = path.join(root, path.dirname(PORTUGAL_MEADOW_GRASS_ASSETS['manifest.json']));
const P = MEADOW_PATCH_METRES;
const STRIDE = 12; // position, normal, linear colour, along, stiffness, anchor
// The groves' single-leaf reflectance, scaled to the sunlit meadow the land is lit as.
const ALBEDO_SCALE = 0.46;
// The canopy body: a slab of 8 x 8 cells, its top where this share of the sward's surface lies below.
const CANOPY_CELLS = 8;
const CANOPY_QUANTILE = 0.85;
// How far below the ground its floor lies, never seen.
const CANOPY_FLOOR = -0.05;
// The canopy's error: the height above it under which this share of the sward's surface lies.
const BASE_QUANTILE = 0.9;
// A coarser level's error: this share of the mean width its kept organs are grown to, as the forest's leaves
// (scripts/prepare-forest-clusters.mjs, third_party/threejs-nanites/dag/leaves.ts).
const ORGAN_ERROR_SHARE = 0.35;
const COVERAGE_CELLS = 768;
const CHAIN_LEAST_TRIANGLES = 6;
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
const wrap = (v) => ((v % P) + P) % P;
function quantile(pairs, q) {
  if (!pairs.length) return 0;
  pairs.sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((n, [, w]) => n + w, 0);
  let run = 0;
  for (const [v, w] of pairs) { run += w; if (run >= q * total) return v; }
  return pairs[pairs.length - 1][0];
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

function bakeVariant({ mixIndex, variantIndex, variant, V, I, vertexBase }) {
  const organs = organsOf(variant, V, I);
  // The variant's vertices, numbered locally in organ order, and its triangles in those numbers.
  const local = new Map(), sources = [], clumps = [];
  for (const o of organs) for (const v of o.vertices) { local.set(v, sources.length); sources.push(v); clumps.push(o.clumpRand); }
  const count = sources.length, base = new Float64Array(count * 3), offset = new Float64Array(count * 3), normal = new Float64Array(count * 3);
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
  const corners = Int32Array.from(organs.flatMap((o) => o.local));
  let t0 = 0;
  for (const o of organs) { o.firstTriangle = t0; t0 += o.local.length / 3; }
  const trianglesOf = (list) => list.flatMap((o) => Array.from({ length: o.local.length / 3 }, (_, k) => o.firstTriangle + k));
  const widened = (g) => { const out = new Float64Array(count * 3); for (let i = 0; i < out.length; i++) out[i] = base[i] + offset[i] * (g - 1); return out; };

  // Each level's growth: the least widening at which its kept organs cover, from above and from two sides, what all
  // of them did.
  const frame = { low: [-1, -0.2, -1], size: 6, cells: COVERAGE_CELLS };
  const covered = (position, list) => outline(position, position, corners, trianglesOf(list), 0, frame).reduce((n, view) => n + view.covered, 0);
  const wanted = covered(base, organs);
  const growth = [1];
  for (let level = 1; level < MEADOW_CONTINUUM_LEVELS; level++) {
    const kept = organs.filter((o) => keptAt(o, level));
    let lo = growth[level - 1], hi = Math.max(lo * 2, 2) * 3;
    if (covered(widened(hi), kept) < wanted) { growth.push(hi); continue; }
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (covered(widened(mid), kept) < wanted) lo = mid; else hi = mid; }
    growth.push(hi);
  }

  // Cells and their errors. An organ belongs to the cell its lowest point stands in.
  const cellOf = (o, level) => {
    const n = MEADOW_CONTINUUM_CELLS >> level, s = P / n;
    return Math.min(n - 1, Math.max(0, Math.floor(o.root[1] / s))) * n + Math.min(n - 1, Math.max(0, Math.floor(o.root[0] / s)));
  };
  const errors = [], spheres = [];
  for (let level = 0; level < MEADOW_CONTINUUM_LEVELS; level++) {
    const n = MEADOW_CONTINUUM_CELLS >> level, kept = organs.filter((o) => keptAt(o, level));
    const position = widened(growth[level]);
    // As the forest's leaves: a share of the mean width its kept organs are grown to.
    const widths = Array.from({ length: n * n }, () => [0, 0]);
    if (level > 0) for (const o of kept) { const w = widths[cellOf(o, level)]; w[0] += o.width * growth[level]; w[1]++; }
    const own = widths.map(([sum, k]) => (k ? (sum / k) * ORGAN_ERROR_SHARE : 0));
    // Each cell's LOD sphere holds what it draws and its children's spheres.
    const points = Array.from({ length: n * n }, () => []);
    for (const o of kept) { const c = cellOf(o, level); for (const v of new Set(o.local)) points[c].push([position[v * 3], position[v * 3 + 1], position[v * 3 + 2]]); }
    const levelErrors = new Float64Array(n * n), levelSpheres = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const c = j * n + i, children = level ? [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => (j * 2 + b) * n * 2 + i * 2 + a) : [];
      levelErrors[c] = Math.max(own[c], ...children.map((k) => errors[level - 1][k] * 1.05 + 1e-4));
      levelSpheres[c] = sphereOf(points[c].length ? points[c] : [[(i + 0.5) * P / n, 0, (j + 0.5) * P / n]], children.map((k) => spheres[level - 1][k]));
    }
    errors.push(levelErrors); spheres.push(levelSpheres);
  }

  // Clusters: each cell's kept organs in Morton order, filled up to the cluster's triangles; an organ is never split.
  const clusters = [], indices = [];
  for (let level = 0; level < MEADOW_CONTINUUM_LEVELS; level++) {
    const n = MEADOW_CONTINUUM_CELLS >> level, position = widened(growth[level]), byCell = Array.from({ length: n * n }, () => []);
    for (const o of organs) if (keptAt(o, level)) byCell[cellOf(o, level)].push(o);
    byCell.forEach((list, c) => {
      list.sort((a, b) => morton(...a.root) - morton(...b.root));
      const parentCell = level + 1 < MEADOW_CONTINUUM_LEVELS ? Math.floor((c % n) / 2) + Math.floor(Math.floor(c / n) / 2) * (n >> 1) : -1;
      const parentError = parentCell >= 0 ? errors[level + 1][parentCell] : 1e30, parentLod = parentCell >= 0 ? spheres[level + 1][parentCell] : spheres[level][c];
      let open = [];
      const close = () => {
        if (!open.length) return;
        const tris = open.reduce((s, o) => s + o.local.length / 3, 0), first = indices.length, points = [];
        for (const o of open) for (const v of o.local) { indices.push(vertexBase + v); points.push([position[v * 3], position[v * 3 + 1], position[v * 3 + 2]]); }
        clusters.push({ lod: spheres[level][c], parentLod, cull: sphereOf(points), error: errors[level][c], parentError, first, triangles: tris, level });
        open = [];
      };
      for (const o of list) {
        const tris = o.local.length / 3;
        if (tris > MEADOW_CONTINUUM_CLUSTER_TRIANGLES) throw Error(`An organ of ${tris} triangles outgrows a cluster`);
        if (open.reduce((s, x) => s + x.local.length / 3, 0) + tris > MEADOW_CONTINUUM_CLUSTER_TRIANGLES) close();
        open.push(o);
      }
      close();
    });
  }
  // Coarsest parent first, so the clusters that can be drawn at a patch's nearest point are a prefix.
  clusters.sort((a, b) => b.parentError - a.parentError || a.level - b.level);

  // The canopy: per cell of the slab, the height under which CANOPY_QUANTILE of the sward's surface lies, and the
  // colour it shows from above. Positions wrap, so a plant overhanging the edge counts where it stands.
  const G = CANOPY_CELLS, step = P / G, heights = Array.from({ length: G * G }, () => []), colours = Array.from({ length: G * G }, () => [0, 0, 0, 0]);
  const triangleCount = corners.length / 3, centroids = new Float64Array(triangleCount * 4), colourOf = (i) => [0, 1, 2].map((k) => V[sources[i] * STRIDE + 6 + k] * ALBEDO_SCALE);
  let top = [0, 0, 0, 0], side = [0, 0, 0, 0], floor = [0, 0, 0, 0];
  for (let t = 0; t < triangleCount; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => corners[t * 3 + k] * 3);
    const e = [0, 1, 2].map((k) => base[b + k] - base[a + k]), f = [0, 1, 2].map((k) => base[c + k] - base[a + k]);
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]], area = Math.hypot(...n) / 2, up = area > 0 ? Math.abs(n[1]) / (2 * area) : 0;
    const x = (base[a] + base[b] + base[c]) / 3, y = (base[a + 1] + base[b + 1] + base[c + 1]) / 3, z = (base[a + 2] + base[b + 2] + base[c + 2]) / 3;
    centroids.set([x, y, z, area], t * 4);
    const cell = Math.min(G - 1, Math.floor(wrap(z) / step)) * G + Math.min(G - 1, Math.floor(wrap(x) / step));
    heights[cell].push([y, area]);
    const ca = colourOf(corners[t * 3]), cb = colourOf(corners[t * 3 + 1]), cc = colourOf(corners[t * 3 + 2]), col = [0, 1, 2].map((k) => (ca[k] + cb[k] + cc[k]) / 3);
    const add = (sum, w) => { for (let k = 0; k < 3; k++) sum[k] += col[k] * w; sum[3] += w; };
    add(colours[cell], area * up); add(top, area * up); add(side, area * (1 - up) * y); if (y < 0.06) add(floor, area);
  }
  const mean = (sum, fallback) => (sum[3] > 0 ? sum.slice(0, 3).map((v) => v / sum[3]) : fallback);
  const topColour = mean(top, [0.06, 0.1, 0.04]), sideColour = mean(side, topColour), floorColour = mean(floor, topColour);
  const cellHeight = heights.map((list) => Math.max(0.04, quantile(list, CANOPY_QUANTILE)));
  const cellColour = colours.map((sum) => mean(sum, topColour));
  const around = (i, j) => [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]].map(([a, b]) => ((b + G) % G) * G + ((a + G) % G));
  const gridHeight = (i, j) => around(i, j).reduce((s, c) => s + cellHeight[c], 0) / 4;
  const canopyAt = (x, z) => {
    const u = wrap(x) / step, v = wrap(z) / step, i = Math.min(G - 1, Math.floor(u)), j = Math.min(G - 1, Math.floor(v)), fu = u - i, fv = v - j;
    return (gridHeight(i, j) * (1 - fu) + gridHeight(i + 1, j) * fu) * (1 - fv) + (gridHeight(i, j + 1) * (1 - fu) + gridHeight(i + 1, j + 1) * fu) * fv;
  };
  const above = [];
  for (let t = 0; t < triangleCount; t++) above.push([Math.max(0, centroids[t * 4 + 1] - canopyAt(centroids[t * 4], centroids[t * 4 + 2])), centroids[t * 4 + 3]]);
  const baseError = quantile(above, BASE_QUANTILE);

  // The slab: a top and a floor of (G + 1)^2 vertices, joined round the edge, every face wound outward.
  const side1 = G + 1, slabPosition = [], slabNormal = [], slabColour = [], slabAlong = [], slabIndex = [];
  for (const layer of [0, 1]) for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
    const h = gridHeight(i, j);
    slabPosition.push(i * step, layer ? CANOPY_FLOOR : h, j * step);
    if (layer) { slabNormal.push(0, -1, 0); slabColour.push(floorColour); slabAlong.push(0); continue; }
    const dx = (gridHeight(i + 1, j) - gridHeight(i - 1, j)) / (2 * step), dz = (gridHeight(i, j + 1) - gridHeight(i, j - 1)) / (2 * step), l = Math.hypot(dx, 1, dz);
    slabNormal.push(-dx / l, 1 / l, -dz / l);
    slabColour.push(around(i, j).reduce((s, c) => s.map((v, k) => v + cellColour[c][k] / 4), [0, 0, 0]));
    slabAlong.push(0.55);
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
  const rim = [];
  for (let i = 0; i < G; i++) rim.push([[i, 0], [i + 1, 0], [0, 0, -1]], [[i, G], [i + 1, G], [0, 0, 1]], [[0, i], [0, i + 1], [-1, 0, 0]], [[G, i], [G, i + 1], [1, 0, 0]]);
  for (const [[ai, aj], [bi, bj], want] of rim) {
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
  // Errors and growth, measured at every eighth step and the last few, between them taken in proportion.
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
  const sampled = new Set([0, S]);
  for (let s = 0; s <= S; s += 8) sampled.add(s);
  for (let s = Math.max(0, S - 48); s <= S; s++) sampled.add(s);
  const measured = new Map(), stepCorners = new Int32Array(ST * 3);
  for (const s of [...sampled].sort((p, q) => p - q)) {
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
    let inflate = 0;
    const cast = (d) => outline(position, slabN, stepCorners, living, d, slabFrame).reduce((n, view) => n + view.covered, 0);
    if (s > 0 && cast(0) < wantedOutline) {
      let lo = 0, hi = P * 0.25;
      for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (cast(mid) < wantedOutline) lo = mid; else hi = mid; }
      inflate = (lo + hi) / 2;
    }
    measured.set(s, { error: baseError + error, inflate });
  }
  const keys = [...measured.keys()].sort((p, q) => p - q), stepErrors = new Float64Array(S + 1), inflates = new Float64Array(S + 1);
  for (let i = 0; i < keys.length; i++) {
    const s0 = keys[i], s1 = keys[Math.min(i + 1, keys.length - 1)], m0 = measured.get(s0), m1 = measured.get(s1);
    for (let s = s0; s <= s1; s++) { const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0; stepErrors[s] = m0.error + (m1.error - m0.error) * f; inflates[s] = m0.inflate + (m1.inflate - m0.inflate) * f; }
  }
  for (let s = 1; s <= S; s++) stepErrors[s] = Math.max(stepErrors[s], stepErrors[s - 1] * (1 + 4e-6) + 1e-7);
  const order = allBase.slice().sort((p, q) => (chain.death[q] < 0 ? Infinity : chain.death[q]) - (chain.death[p] < 0 ? Infinity : chain.death[p]));
  const dying = new Int32Array(S + 2);
  for (let t = 0; t < ST; t++) if (chain.death[t] >= 0) dying[chain.death[t]]++;
  const alive = [];
  for (let s = 0, n = ST; s <= S; s++) { n -= dying[s]; alive.push(n); }
  // The far body takes over only where the clusters have reached their coarsest: from the first step whose error is
  // no finer than the patch's coarsest cell's.
  const rootError = Math.max(...errors[MEADOW_CONTINUUM_LEVELS - 1]);
  const reached = Array.from(stepErrors).findIndex((e) => e >= rootError), farFirst = reached < 0 ? S : reached;
  const canopy = cellHeight.reduce((s, h) => s + h, 0) / cellHeight.length;
  const widest = widened(growth[MEADOW_CONTINUUM_LEVELS - 1]), all = [];
  for (let i = 0; i < count; i++) all.push([base[i * 3], base[i * 3 + 1], base[i * 3 + 2]], [widest[i * 3], widest[i * 3 + 1], widest[i * 3 + 2]]);
  for (let v = 0; v < SV; v++) all.push([position[v * 3], position[v * 3 + 1], position[v * 3 + 2]]);

  // Vertices: the sward, then the canopy body.
  const vertexWords = [];
  sources.forEach((v, i) => vertexWords.push(...packMeadowContinuumVertex({
    position: [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]], normal: [normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]], colour: colourOf(i),
    along: V[v * STRIDE + 9], stiffness: V[v * STRIDE + 10], clump: clumps[i],
    offset: [offset[i * 3], offset[i * 3 + 1], offset[i * 3 + 2]],
  }, { low: ATLAS_LOW, span: ATLAS_SPAN })));
  for (let v = 0; v < SV; v++) vertexWords.push(...packMeadowContinuumVertex({
    position: [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]], normal: [slabN[v * 3], slabN[v * 3 + 1], slabN[v * 3 + 2]],
    colour: slabColour[v], along: slabAlong[v], stiffness: 9, clump: 0.999,
  }, { low: ATLAS_LOW, span: ATLAS_SPAN }));
  const records = Array.from({ length: SV }, (_, v) => (chain.dieStep[v] < 0 ? MEADOW_CONTINUUM_NEVER : (chain.dieStep[v] | (chain.target[v] << 16)) >>> 0));
  const triangles = order.flatMap((t) => [index[t * 3], index[t * 3 + 1], index[t * 3 + 2], 0]);
  const steps = new Uint32Array((S + 1) * MEADOW_CONTINUUM_STEP_WORDS), stepFloats = new Float32Array(steps.buffer);
  for (let s = 0; s <= S; s++) { steps[s * 4] = alive[s]; stepFloats[s * 4 + 1] = stepErrors[s]; stepFloats[s * 4 + 2] = inflates[s]; }
  return {
    organs, growth, clusters, indices, vertexWords, swardVertices: count, records, triangles, steps,
    chain: { baseTriangles: ST, steps: S, coreTriangles: alive[S], farFirst, baseError, firstError: stepErrors[farFirst], lastError: stepErrors[S], depth, vertices: SV },
    canopy, topColour, sideColour, sphere: sphereOf(all), sourceTriangles: triangleCount, mixIndex, variantIndex,
    levelTriangles: Array.from({ length: MEADOW_CONTINUUM_LEVELS }, (_, l) => clusters.filter((c) => c.level === l).reduce((s, c) => s + c.triangles, 0)),
    levelErrors: errors.map((list) => Math.max(...list)),
  };
}

function main() {
  const started = Date.now();
  const manifestBytes = fs.readFileSync(path.join(SOURCE, 'manifest.json'));
  const source = JSON.parse(manifestBytes);
  if (source.format !== 'waterworld.meadow-groves' || source.tileMetres !== P) throw Error('The meadow groves are not the 4 m tiles this bake reads');
  const vertexBytes = zlib.gunzipSync(fs.readFileSync(path.join(SOURCE, source.streams.vertices.file)));
  const indexBytes = zlib.gunzipSync(fs.readFileSync(path.join(SOURCE, source.streams.indices.file)));
  if (sha256(vertexBytes) !== source.streams.vertices.rawSha256 || sha256(indexBytes) !== source.streams.indices.rawSha256) throw Error('The meadow groves failed verification');
  const V = new Float32Array(vertexBytes.buffer, vertexBytes.byteOffset, vertexBytes.byteLength / 4);
  const I = new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength / 4);

  const baked = [];
  let vertexBase = 0;
  source.mixes.forEach((mix, mixIndex) => source.groves[mix].variants.forEach((variant, variantIndex) => {
    const b = bakeVariant({ mixIndex, variantIndex, variant, V, I, vertexBase });
    b.vertexBase = vertexBase; b.chainVertices = vertexBase + b.swardVertices;
    vertexBase += b.vertexWords.length / MEADOW_CONTINUUM_VERTEX_WORDS;
    baked.push(b);
    console.log(`${mix} ${variantIndex}: ${b.sourceTriangles} triangles, ${b.organs.length} organs; levels ${b.levelTriangles.join(' / ')} triangles, errors ${b.levelErrors.map((e) => e.toFixed(3)).join(' / ')} m, growth ${b.growth.map((g) => g.toFixed(2)).join(' / ')}; canopy ${b.canopy.toFixed(3)} m, ${b.chain.baseTriangles} -> ${b.chain.coreTriangles} triangles in ${b.chain.steps} steps, from step ${b.chain.farFirst} at ${b.chain.firstError.toFixed(3)} m to ${b.chain.lastError.toFixed(3)} m`);
  }));
  if (baked.length !== 12) throw Error(`The groves hold ${baked.length} variants, not 12`);

  // The atlas: header, variants, clusters, vertices, indices, then each variant's chain.
  const clusterCount = baked.reduce((n, b) => n + b.clusters.length, 0), indexCount = baked.reduce((n, b) => n + b.indices.length, 0);
  const H = MEADOW_CONTINUUM_HEADER, R = MEADOW_CONTINUUM_VARIANT;
  const variantsAt = MEADOW_CONTINUUM_HEADER_WORDS, clustersAt = variantsAt + baked.length * MEADOW_CONTINUUM_VARIANT_WORDS;
  const verticesAt = clustersAt + clusterCount * MEADOW_CONTINUUM_CLUSTER_WORDS, indicesAt = verticesAt + vertexBase * MEADOW_CONTINUUM_VERTEX_WORDS;
  const chainsAt = indicesAt + indexCount;
  const words = chainsAt + baked.reduce((n, b) => n + b.records.length + b.triangles.length + b.steps.length, 0);
  const atlas = new Uint32Array(words), floats = new Float32Array(atlas.buffer);
  atlas[H.magic] = MEADOW_CONTINUUM_MAGIC; atlas[H.version] = MEADOW_CONTINUUM_VERSION; atlas[H.variantCount] = baked.length;
  atlas[H.variantsAt] = variantsAt; atlas[H.clustersAt] = clustersAt; atlas[H.clusterCount] = clusterCount;
  atlas[H.verticesAt] = verticesAt; atlas[H.vertexCount] = vertexBase; atlas[H.indicesAt] = indicesAt; atlas[H.indexCount] = indexCount;
  atlas[H.chainsAt] = chainsAt; atlas[H.words] = words; floats[H.patch] = P; floats.set(ATLAS_LOW, H.low); floats[H.span] = ATLAS_SPAN;
  let clusterAt = 0, indexAt = 0, chainAt = chainsAt;
  baked.forEach((b, id) => {
    const r = variantsAt + id * MEADOW_CONTINUUM_VARIANT_WORDS;
    atlas[r + R.clusterFirst] = clusterAt; atlas[r + R.clusterCount] = b.clusters.length;
    for (const c of b.clusters) atlas.set(packMeadowContinuumCluster({ ...c, first: c.first + indexAt }), clustersAt + (clusterAt++) * MEADOW_CONTINUUM_CLUSTER_WORDS);
    atlas.set(b.vertexWords, verticesAt + b.vertexBase * MEADOW_CONTINUUM_VERTEX_WORDS);
    atlas.set(b.indices, indicesAt + indexAt); indexAt += b.indices.length;
    atlas[r + R.chainVertices] = b.chainVertices; atlas[r + R.chainVertexCount] = b.chain.vertices;
    atlas[r + R.records] = chainAt; atlas.set(b.records, chainAt); chainAt += b.records.length;
    atlas[r + R.triangles] = chainAt; atlas.set(b.triangles, chainAt); chainAt += b.triangles.length;
    atlas[r + R.steps] = chainAt; atlas.set(b.steps, chainAt); chainAt += b.steps.length;
    atlas[r + R.stepCount] = b.chain.steps; atlas[r + R.chainTriangleCount] = b.chain.baseTriangles; atlas[r + R.farFirst] = b.chain.farFirst;
    floats[r + R.baseError] = b.chain.baseError; floats[r + R.canopy] = b.canopy; floats.set(b.sphere, r + R.sphere);
    floats.set(b.topColour, r + R.topColour); floats.set(b.sideColour, r + R.sideColour);
    atlas[r + R.mix] = b.mixIndex; atlas[r + R.sourceTriangles] = b.sourceTriangles; floats.set(b.growth, r + R.growth);
  });
  if (chainAt !== words) throw Error('The atlas was laid out wrongly');

  const bytes = new Uint8Array(atlas.buffer), gzip = zlib.gzipSync(bytes, { level: 9 });
  fs.mkdirSync(OUT, { recursive: true });
  for (const file of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, file));
  fs.writeFileSync(path.join(root, PORTUGAL_MEADOW_GRASS_ASSETS['atlas.bin.gz']), gzip);
  const manifest = {
    format: MEADOW_CONTINUUM_FORMAT, version: MEADOW_CONTINUUM_VERSION, generator: 'scripts/prepare-meadow-grass.mjs',
    source: { format: source.format, generator: source.generator, manifestSha256: sha256(manifestBytes), vertices: source.streams.vertices.rawSha256, indices: source.streams.indices.rawSha256 },
    patchMetres: P, levels: MEADOW_CONTINUUM_LEVELS, cells: MEADOW_CONTINUUM_CELLS, mixes: source.mixes,
    canopy: { cells: CANOPY_CELLS, quantile: CANOPY_QUANTILE, errorQuantile: BASE_QUANTILE }, organErrorShare: ORGAN_ERROR_SHARE,
    variants: baked.map((b, id) => ({
      id, mix: b.mixIndex, variant: b.variantIndex, sourceTriangles: b.sourceTriangles, organs: b.organs.length, clusters: b.clusters.length,
      levels: b.levelTriangles.map((triangles, level) => ({ triangles, error: +b.levelErrors[level].toFixed(5), growth: +b.growth[level].toFixed(4) })),
      chain: { baseTriangles: b.chain.baseTriangles, steps: b.chain.steps, coreTriangles: b.chain.coreTriangles, farFirst: b.chain.farFirst, baseError: +b.chain.baseError.toFixed(5), lastError: +b.chain.lastError.toFixed(5), hops: b.chain.depth },
      splat: { canopy: +b.canopy.toFixed(4), topColour: b.topColour.map((v) => +v.toFixed(5)), sideColour: b.sideColour.map((v) => +v.toFixed(5)), sphere: b.sphere.map((v) => +v.toFixed(4)) },
    })),
    atlas: { words, bytes: bytes.byteLength, sha256: sha256(bytes), gzip: { file: path.basename(PORTUGAL_MEADOW_GRASS_ASSETS['atlas.bin.gz']), bytes: gzip.byteLength, sha256: sha256(gzip) }, clusters: clusterCount, vertices: vertexBase, indices: indexCount },
  };
  fs.writeFileSync(path.join(root, PORTUGAL_MEADOW_GRASS_ASSETS['manifest.json']), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`Meadow continuum: ${baked.length} variants, ${clusterCount} clusters, ${vertexBase} vertices, ${indexCount / 3} cluster triangles; ${(bytes.byteLength / 1048576).toFixed(1)} MiB, ${(gzip.byteLength / 1048576).toFixed(1)} MiB gzipped, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

main();
