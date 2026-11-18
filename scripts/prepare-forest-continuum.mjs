#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes every tree of a forest pack into the one continuum (AGENTS.md rule 3; js/forest-continuum.js), in place of the
// forest's own cluster and crown bakes: the one simplifier (js/continuum-bake.js) clusters each prototype's wood by
// projected error and its leaf cards beside it, wraps the whole tree, crown and trunk, in one closed far body that
// collapses a half-edge at a time to a few triangles, and gives it one splat. One atlas of the one format holds a
// pack's prototypes, in their order, gzipped beside a manifest with its receipt and each prototype's source digest.
//   node scripts/prepare-forest-continuum.mjs portugal|saba|subtropical [--only=oak] [--check]
// --check reads the baked atlas back and checks it against its manifest and the pack, baking nothing.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { CONTINUUM_HEADER, CONTINUUM_ATLAS_VERSION, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, assembleContinuumAtlas, checkContinuumAtlas, continuumAtlasTypes } from '../js/continuum-format.js';
import { CONTINUUM_STEP_WORDS } from '../js/continuum-core.js';
import { weldDrawn, bakeClusters, bakeFar, continuumFarFirst, triangleGrid, closest, ancestor } from '../js/continuum-bake.js';
import { CONTINUUM_WIND_BONES, packContinuumWindBones } from '../js/wgsl/continuum-wind.js';
import {
  FOREST_CONTINUUM_FORMAT, FOREST_CONTINUUM_VERSION, FOREST_CONTINUUM_MATERIAL, FOREST_CONTINUUM_BARK, FOREST_CONTINUUM_LEAF,
  FOREST_CONTINUUM_ASSETS, SUBTROPICAL_FOREST_CONTINUUM_ASSETS, PORTUGAL_FOREST_CONTINUUM_ASSETS, packForestContinuumBody, validateForestContinuumManifest,
} from '../js/forest-continuum.js';

const args = process.argv.slice(2);
const packName = args.find((a) => !a.startsWith('--')) ?? 'portugal';
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const checkOnly = args.includes('--check');
const ASSETS = { saba: FOREST_CONTINUUM_ASSETS, subtropical: SUBTROPICAL_FOREST_CONTINUUM_ASSETS, portugal: PORTUGAL_FOREST_CONTINUUM_ASSETS }[packName];
if (!ASSETS) throw Error(`No forest pack ${packName}`);
const dir = path.join('assets/forest-scenery', packName), OUT = path.dirname(ASSETS['manifest.json']);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
// A pack's source vertex: position, normal, a spare float, its exposure, its UV, its colour and its layer.
const SOURCE_STRIDE = 14;
const MASK_SIZE = 64;
// A coarser leaf level's error as a share of its size (third_party/threejs-nanites/dag/leaves.ts). The forest's own
// cut baked 0.35 and drew leaves at 0.4 of the scene's pixel error, so its cards stayed under ~3.4 px; the one cut
// draws every family at the scene's error, so the share is baked at 0.35 / 0.4 to keep them so. At 0.35 a crown's
// coarser cards grew to several times that, and its root cluster's few dozen read as single giant leaves.
const LEAF_ERROR_SHARE = 0.875;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asBytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);

const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(path.join(dir, file)));
const asFloats = (buffer) => new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
const asWords = (buffer) => new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

// A leaf texture's alpha as a coarse mask, so coarser levels cover what the finer ones did.
function leafMask(file) {
  const out = path.join(os.tmpdir(), `forest-continuum-mask-${process.pid}.bin`);
  execFileSync('python3', ['-I', '-c', `import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGBA').split()[3].resize((${MASK_SIZE},${MASK_SIZE}));open(sys.argv[2],'wb').write(bytes(1 if v>127 else 0 for v in im.tobytes()))`, path.join(dir, file), out]);
  const bits = new Uint8Array(fs.readFileSync(out));
  fs.rmSync(out);
  return { size: MASK_SIZE, bits };
}

// A tree's foot flares into the ground it stands on, as the land's own roots do: the wood near the ground is drawn
// outward and down (what the forest's vertex stage did for every frame, here once).
function flareRoot([x, y, z]) {
  const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const r = Math.hypot(x, z), envelope = 0.32 + 0.14 * Math.min(r, 4) - 0.46 * smooth(1.15, 2.6, r);
  if (!(y < envelope + 0.04 && (r > 0.18 || y < 0.02))) return [x, y, z];
  const w = (1 - smooth(envelope - 0.08, envelope + 0.04, y)) * Math.max(smooth(0.18, 0.22, r), 1 - smooth(-0.01, 0.02, y));
  let px = x, pz = z;
  if (r > 0.2) { const out = 0.2 + 0.52 * (1 - Math.exp(-(r - 0.2) / 0.52)), k = 1 + (out / Math.max(r, 1e-5) - 1) * w; px *= k; pz *= k; }
  const dr = Math.max(0, r - 0.18), py = Math.max(-2.2, y - (1.35 * dr + 0.45 * Math.min(dr * dr, 4)));
  return [px, y + (py - y) * w, pz];
}

// A group of clusters (those the builder made from one simplification, sharing its error and sphere) is drawn where
// its error, projected from its sphere's nearest point, is allowed and its parent group's is not. The builder merges
// its children's spheres, and their slack compounds up a crown many levels deep: a birch whose points lie within
// 7.2 m of its middle had groups reaching 13.9 m, and the type's sphere, which must hold every group's
// (js/continuum-format.js packContinuumBody), was twice the tree. Each group's sphere is drawn in here to every point
// it and every group under it draws, centred on their box. Where a parent's sphere holds its children's, its projected
// error bounds theirs from every eye and exactly one of them is drawn; where a child's pokes out, an eye by the poke
// may draw both, never neither (each surface point's groups still change from allowed to not at least once). Wood
// keeps its children's spheres, grown as far as it must, for its two cuts would fight in depth; a leaf card's coarser
// cards lie over it and only thicken the crown for a moment, so leaves are drawn in to their own points alone. A
// cluster's own culling sphere is drawn in to its points.
function tightenClusterSpheres(clusters, position, nests) {
  // A group is known by its error and sphere, and by the level its clusters were made at: a group of one cluster the
  // builder could not make coarser keeps its child's error and sphere. One that made nothing (twigs simplified away)
  // has children alone.
  const key = (error, s) => `${error}|${s.join(',')}`, groups = new Map(), group = () => ({ records: [], children: new Set(), sphere: null });
  const made = clusters.records.map((r) => {
    const k = `${key(r.error, r.lod)}|${r.level}`;
    if (!groups.has(k)) groups.set(k, Object.assign(group(), { key: key(r.error, r.lod), level: r.level }));
    return groups.get(k);
  });
  clusters.records.forEach((r, i) => made[i].records.push(r));
  const makers = new Map();
  for (const g of groups.values()) { if (!makers.has(g.key)) makers.set(g.key, []); makers.get(g.key).push(g); }
  const used = clusters.records.map((r) => {
    if (r.parentError === Infinity) return null;
    const k = key(r.parentError, r.parentLod), above = (makers.get(k) ?? []).filter((g) => g.level > r.level).sort((p, q) => p.level - q.level)[0];
    if (above) return above;
    if (!groups.has(`${k}|gone`)) groups.set(`${k}|gone`, group());
    return groups.get(`${k}|gone`);
  });
  used.forEach((g, i) => g?.children.add(made[i]));
  const each = (r, visit) => { for (let i = 0; i < r.triangles * 3; i++) visit(clusters.order[clusters.indices[r.first + i]]); };
  const sphereAbout = (records) => {
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const r of records) each(r, (v) => { for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], position[v * 3 + k]); high[k] = Math.max(high[k], position[v * 3 + k]); } });
    const c = low.map((v, k) => (v + high[k]) / 2);
    let radius = 0;
    for (const r of records) each(r, (v) => { radius = Math.max(radius, Math.hypot(position[v * 3] - c[0], position[v * 3 + 1] - c[1], position[v * 3 + 2] - c[2])); });
    return [...c, radius];
  };
  // The least sphere about its own points and its children's spheres (Bădoiu and Clarkson's walk toward the farthest),
  // for a group that holds its children: its own points are some of theirs, so this holds all it draws.
  const ballAbout = (records, spheres) => {
    const items = [];
    for (const r of records) each(r, (v) => items.push([position[v * 3], position[v * 3 + 1], position[v * 3 + 2], 0]));
    items.push(...spheres);
    const box = [0, 1, 2].map((k) => (Math.min(...items.map((s) => s[k] - s[3])) + Math.max(...items.map((s) => s[k] + s[3]))) / 2);
    const radius = (c) => Math.max(...items.map((s) => Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) + s[3]));
    let c = box.slice(), best = [...box, radius(box)];
    for (let i = 1; i <= 256; i++) {
      let far = items[0], most = -1;
      for (const s of items) { const d = Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) + s[3]; if (d > most) { most = d; far = s; } }
      if (most < best[3]) best = [...c, most];
      const d = Math.hypot(far[0] - c[0], far[1] - c[1], far[2] - c[2]) || 1, edge = [0, 1, 2].map((k) => far[k] + ((far[k] - c[k]) / d) * far[3]);
      c = c.map((v, k) => v + (edge[k] - v) / (i + 1));
    }
    return best;
  };
  const sphereOf = (g) => {
    if (g.sphere) return g.sphere;
    if (g.records.some(nests) || (!g.records.length && [...g.children].some((h) => h.records.some(nests)))) {
      return (g.sphere = g.children.size ? ballAbout(g.records, [...g.children].map(sphereOf)) : sphereAbout(g.records));
    }
    const below = new Set(), stack = [g];
    while (stack.length) { const h = stack.pop(); if (below.has(h)) continue; below.add(h); stack.push(...h.children); }
    return (g.sphere = sphereAbout([...below].flatMap((h) => h.records)));
  };
  clusters.records.forEach((r, i) => {
    r.lod = sphereOf(made[i]).slice();
    r.parentLod = used[i] ? sphereOf(used[i]).slice() : r.lod.slice();
    const own = sphereAbout([r]);
    if (own[3] < r.cull[3]) r.cull = own;
  });
}

// Whether a point lies within a closed surface: the parity of its crossings along each axis, two of the three agreeing.
function insideClosed(position, index) {
  const T = index.length / 3, axes = [0, 1, 2].map((a) => {
    const u = (a + 1) % 3, v = (a + 2) % 3, low = [Infinity, Infinity], high = [-Infinity, -Infinity];
    for (let i = 0; i < position.length / 3; i++) { low[0] = Math.min(low[0], position[i * 3 + u]); low[1] = Math.min(low[1], position[i * 3 + v]); high[0] = Math.max(high[0], position[i * 3 + u]); high[1] = Math.max(high[1], position[i * 3 + v]); }
    const n = 64, size = [Math.max(high[0] - low[0], 1e-6) / n, Math.max(high[1] - low[1], 1e-6) / n], cells = Array.from({ length: n * n }, () => []);
    const at = (x, k) => Math.max(0, Math.min(n - 1, Math.floor((x - low[k]) / size[k])));
    for (let t = 0; t < T; t++) {
      const p = [0, 1, 2].map((c) => index[t * 3 + c] * 3);
      const i0 = at(Math.min(...p.map((q) => position[q + u])), 0), i1 = at(Math.max(...p.map((q) => position[q + u])), 0);
      const j0 = at(Math.min(...p.map((q) => position[q + v])), 1), j1 = at(Math.max(...p.map((q) => position[q + v])), 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[j * n + i].push(t);
    }
    return { u, v, low, high, cells, cell: (x, y) => (x < low[0] || y < low[1] || x > high[0] || y > high[1] ? null : cells[at(y, 1) * n + at(x, 0)]) };
  });
  // The crossings of the ray from p along +axis a, by the sign of each triangle's projected areas.
  const crossings = (p, a) => {
    const { u, v, cell } = axes[a], list = cell(p[u], p[v]);
    if (!list) return 0;
    let count = 0;
    for (const t of list) {
      const [A, B, C] = [0, 1, 2].map((c) => index[t * 3 + c] * 3);
      const e = (P, Q) => (position[P + u] - p[u]) * (position[Q + v] - p[v]) - (position[P + v] - p[v]) * (position[Q + u] - p[u]);
      const w0 = e(B, C), w1 = e(C, A), w2 = e(A, B);
      if (!((w0 > 0 && w1 > 0 && w2 > 0) || (w0 < 0 && w1 < 0 && w2 < 0))) continue;
      const along = (w0 * position[A + a] + w1 * position[B + a] + w2 * position[C + a]) / (w0 + w1 + w2);
      if (along > p[a]) count++;
    }
    return count;
  };
  return (x, y, z) => { const p = [x, y, z]; return (crossings(p, 0) & 1) + (crossings(p, 1) & 1) + (crossings(p, 2) & 1) >= 2; };
}

// What the far body gets wrong where it is seen, step by step. The shared measure (js/continuum-bake.js bakeFar) adds
// a step's distance from the wrap to the wrap's from the tree, and takes the wrap's against every point of the tree
// seen from outside, through the gaps of its crown: leaves deep within the crown, many metres from its shell. Those
// lie behind the far body, which wears their porosity in its light and coverage (js/wgsl/forest-continuum.js); what
// moves on screen is its outline. So each step, grown along its normals as the GPU grows it, is measured against the
// tree itself: its points' distance from the tree, and the distance from it of the tree's points outside it. A
// birch's far body of two hundred triangles is then 0.8 m from its tree, not the 2.5 m the sum gave; its clusters'
// roots, of the same weight, 0.74 m: it takes over about where they stop coarsening, not kilometres on.
function outlineErrors(far, drawn) {
  const S = far.chain.steps.length, W = CONTINUUM_STEP_WORDS, steps = new Float32Array(far.steps.buffer, far.steps.byteOffset, far.steps.length);
  const P = far.position, N = far.normal, V = P.length / 3, T = far.index.length / 3, cell = Math.max(far.stats.cell * 2, 0.25);
  const tree = triangleGrid(drawn.position, drawn.index, cell);
  // The tree's points (its vertices and its triangles' middles), and how deep each lies within the wrap (less than
  // nothing outside it): one deeper than a step has moved from the wrap stays within that step.
  const D = drawn.position, dT = drawn.index.length / 3, points = new Float64Array((drawn.count + dT) * 3);
  points.set(D);
  for (let t = 0; t < dT; t++) for (let k = 0; k < 3; k++) points[(drawn.count + t) * 3 + k] = (D[drawn.index[t * 3] * 3 + k] + D[drawn.index[t * 3 + 1] * 3 + k] + D[drawn.index[t * 3 + 2] * 3 + k]) / 3;
  const insideWrap = insideClosed(P, far.index), wrapNear = triangleGrid(P, far.index, cell), depth = new Float64Array(points.length / 3);
  for (let i = 0; i < depth.length; i++) { const [x, y, z] = points.subarray(i * 3, i * 3 + 3); wrapNear(x, y, z); depth[i] = Math.sqrt(closest[0]) * (insideWrap(x, y, z) ? 1 : -1); }
  const measure = (s) => {
    const grow = steps[s * W + 2], moved = steps[s * W + 1] - far.baseError + grow + 2 * cell, Q = new Float32Array(V * 3), corners = [];
    for (let v = 0; v < V; v++) for (let k = 0; k < 3; k++) Q[v * 3 + k] = P[v * 3 + k] + N[v * 3 + k] * grow;
    for (let t = 0; t < T; t++) {
      if (!(far.chain.death[t] < 0 || far.chain.death[t] > s)) continue;
      const c = [0, 1, 2].map((k) => ancestor(far.chain, far.index[t * 3 + k], s));
      if (c[0] !== c[1] && c[1] !== c[2] && c[0] !== c[2]) corners.push(...c);
    }
    const index = Uint32Array.from(corners);
    let error = 0;
    for (let t = 0; t < index.length / 3; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => index[t * 3 + k] * 3);
      for (const p of [[Q[a], Q[a + 1], Q[a + 2]], [(Q[a] + Q[b] + Q[c]) / 3, (Q[a + 1] + Q[b + 1] + Q[c + 1]) / 3, (Q[a + 2] + Q[b + 2] + Q[c + 2]) / 3]]) { tree(p[0], p[1], p[2]); error = Math.max(error, Math.sqrt(closest[0])); }
    }
    const inside = insideClosed(Q, index), near = triangleGrid(Q, index, cell);
    for (let i = 0; i < depth.length; i++) {
      if (depth[i] > moved) continue;
      const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
      if (inside(x, y, z)) continue;
      near(x, y, z);
      error = Math.max(error, Math.sqrt(closest[0]));
    }
    return error;
  };
  // Measured at every sixteenth step and the last few, between them taken in proportion, then rising strictly as the
  // morph search needs.
  const sampled = new Set([0, S]);
  for (let s = 0; s <= S; s += 16) sampled.add(s);
  for (let s = Math.max(0, S - 32); s <= S; s++) sampled.add(s);
  const keys = [...sampled].sort((p, q) => p - q), measured = new Map(keys.map((s) => [s, measure(s)])), errors = new Float64Array(S + 1);
  for (let i = 0; i < keys.length; i++) {
    const s0 = keys[i], s1 = keys[Math.min(i + 1, keys.length - 1)];
    for (let s = s0; s <= s1; s++) errors[s] = measured.get(s0) + (measured.get(s1) - measured.get(s0)) * (s1 > s0 ? (s - s0) / (s1 - s0) : 0);
  }
  const summed = [steps[1], steps[S * W + 1]];
  for (let s = 0; s <= S; s++) steps[s * W + 1] = s > 0 ? Math.max(errors[s], steps[(s - 1) * W + 1] * (1 + 4e-6) + 1e-7) : errors[0];
  Object.assign(far.stats, { summedErrorRange: summed.map((e) => +e.toFixed(4)), baseError: +steps[1].toFixed(4), errorRange: [+steps[1].toFixed(4), +steps[S * W + 1].toFixed(4)] });
}

// ------------------------------------------------------------------------------------------------ the skeleton
// A tree bends in the wind by its bones (js/wgsl/continuum-wind.js): a trunk of five and nine boughs off it, eighteen
// branchlets off those, or a palm's six of trunk and thirteen fronds of two. Each is a damped spring whose stiffness
// holds the moment the wind's pressure at 10 m/s puts on the wood and leaves it carries (theirs and every bone's
// beyond it) to a set bend, the trunk's by how slender the tree stands, swinging at a frequency falling as the tree is
// taller. Wood is 700 kg/m³ about a tube as thick as its triangles' edges; leaves 0.6 kg/m² of the share of a card a
// leaf fills, their drag sheltered the deeper they lie in the crown.
const WOOD_DENSITY = 700, LEAF_AREAL_DENSITY = 0.6, LEAF_FILL = 0.56, LEAF_OPTICAL_DEPTH = 0.4, REF_PRESSURE = 0.6125 * 10 * 10;
const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const unit3 = (x, y, z, fallback = [0, 1, 0]) => { const l = Math.hypot(x, y, z); return l > 1e-6 ? [x / l, y / l, z / l] : fallback; };
// The nearest point of segment a-b to p: its squared distance and how far along.
function towardSegment(px, py, pz, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], ab2 = abx * abx + aby * aby + abz * abz;
  const t = ab2 > 1e-8 ? clampTo(((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / ab2, 0, 1) : 0;
  const dx = px - a[0] - abx * t, dy = py - a[1] - aby * t, dz = pz - a[2] - abz * t;
  return { d2: dx * dx + dy * dy + dz * dz, t };
}
// k points spread as far apart as they will go, the first the one weighed most.
function spreadPoints(points, k, weight) {
  const n = points.length / 3, chosen = [];
  if (!n) return chosen;
  let first = 0, best = -1;
  for (let i = 0; i < n; i++) { const w = weight(i); if (w > best) { best = w; first = i; } }
  chosen.push(first);
  const near = new Float64Array(n).fill(Infinity);
  while (chosen.length < Math.min(k, n)) {
    const last = chosen[chosen.length - 1];
    let next = -1, score = -1;
    for (let i = 0; i < n; i++) {
      near[i] = Math.min(near[i], (points[i * 3] - points[last * 3]) ** 2 + (points[i * 3 + 1] - points[last * 3 + 1]) ** 2 + (points[i * 3 + 2] - points[last * 3 + 2]) ** 2);
      const s = near[i] * weight(i);
      if (s > score) { score = s; next = i; }
    }
    if (next < 0 || score <= 1e-8) break;
    chosen.push(next);
  }
  return chosen;
}
// The wood's triangles and the leaf cards', each its middle, area, mass and drag, from the corners baked (8 floats a
// corner, wood first).
function windElements(p, corners, woodTriangles, leafTriangles) {
  const tri = (t) => { const c = (k) => corners.subarray((t * 3 + k) * 8, (t * 3 + k) * 8 + 3); return [c(0), c(1), c(2)]; };
  const wood = [], leaves = [];
  const stem = p.dbhCentimetres ? p.dbhCentimetres / 200 : p.basalRadius || 0.35;
  for (let t = 0; t < woodTriangles; t++) {
    const [a, b, c] = tri(t), e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const area = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    if (!(area > 1e-8)) continue;
    const edge = Math.min(Math.hypot(...e1), Math.hypot(...e2), Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]));
    const radius = clampTo(edge * 0.85, 0.004, Math.max(0.08, stem));
    wood.push({ x: (a[0] + b[0] + c[0]) / 3, y: (a[1] + b[1] + c[1]) / 3, z: (a[2] + b[2] + c[2]) / 3, mass: area * radius * 0.5 * WOOD_DENSITY, drag: area * 0.32 });
  }
  let sx = 0, sy = 0, sz = 0, sa = 0;
  for (let t = woodTriangles; t < woodTriangles + leafTriangles; t++) {
    const [a, b, c] = tri(t), e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const area = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    if (!(area > 1e-8)) continue;
    const e = { x: (a[0] + b[0] + c[0]) / 3, y: (a[1] + b[1] + c[1]) / 3, z: (a[2] + b[2] + c[2]) / 3, area };
    sx += e.x * area; sy += e.y * area; sz += e.z * area; sa += area;
    leaves.push(e);
  }
  const crown = sa > 0 ? [sx / sa, sy / sa, sz / sa] : [0, p.high[1] * 0.6, 0];
  const reachOf = (e) => Math.hypot(e.x - crown[0], (e.y - crown[1]) * 0.85, e.z - crown[2]);
  const crownRadius = leaves.reduce((r, e) => Math.max(r, reachOf(e)), 0.5);
  for (const e of leaves) {
    const filled = e.area * LEAF_FILL;
    e.mass = filled * LEAF_AREAL_DENSITY;
    e.drag = filled * Math.exp(-LEAF_OPTICAL_DEPTH * (1 - clampTo(reachOf(e) / crownRadius, 0, 1)) * 2.2) * 0.72;
  }
  return { wood, leaves, crown, crownRadius };
}
// The bones, in order from the trunk's foot (each after its parent), and their rest as the GPU steps them: four vec4f a
// bone, [pivot, parent + 1 | group << 6 | 1 << 8], [axis, how far out along the tree it lies], [the lever from its pivot
// to where the wind presses what it carries, that drag area], [stiffness, natural angular frequency, damping ratio,
// largest bend].
function windSkeleton(p, { wood, leaves, crown, crownRadius }) {
  const groundY = Math.max(0, p.low[1]), H = Math.max(groundY + 0.8, p.high[1]) - groundY;
  const palm = p.species === 'palm' || p.species === 'royal_palm';
  const stem = p.dbhCentimetres ? p.dbhCentimetres / 100 : Math.max(0.05, (p.basalRadius || 0.25) * 1.35);
  const bones = [], bone = (parent, group, pivot, tip, radius, along) => bones.push({ parent, group, pivot, tip, radius, along });
  if (palm) {
    const top = groundY + H * 0.77, spine = [];
    let cx = 0, cz = 0;
    for (let s = 0; s <= 6; s++) {
      const lo = groundY + (s - 0.5) * ((top - groundY) / 6), hi = groundY + (s + 0.5) * ((top - groundY) / 6);
      let x = 0, z = 0, w = 0;
      for (const e of wood) if (e.y >= lo && e.y <= hi && Math.hypot(e.x - cx, e.z - cz) < Math.max(1.8, crownRadius * 0.45)) { x += e.x * e.mass; z += e.z * e.mass; w += e.mass; }
      if (w > 0) { cx = x / w; cz = z / w; }
      spine.push([cx, groundY + (s / 6) * (top - groundY), cz]);
    }
    for (let b = 0; b < 6; b++) bone(b - 1, 0, spine[b], spine[b + 1], Math.max(0.08, stem * 0.5 * (1 - 0.35 * (b / 6))), (b + 0.6) / 6);
    const hub = spine[6], outer = [];
    for (let i = 0; i < leaves.length; i += Math.max(1, Math.floor(leaves.length / 1800))) {
      const e = leaves[i];
      if (Math.hypot(e.x - hub[0], e.y - hub[1], e.z - hub[2]) > crownRadius * 0.35) outer.push(e.x, e.y, e.z);
    }
    const seeds = spreadPoints(outer, 13, (i) => outer[i * 3] ** 2 + outer[i * 3 + 2] ** 2 + outer[i * 3 + 1] ** 2 * 0.25);
    const tipOf = (k) => (seeds.length ? outer.slice(seeds[k % seeds.length] * 3, seeds[k % seeds.length] * 3 + 3)
      : [hub[0] + Math.cos((k / 13) * Math.PI * 2) * crownRadius, hub[1] + 0.5, hub[2] + Math.sin((k / 13) * Math.PI * 2) * crownRadius]);
    for (let k = 0; k < 13; k++) {
      const [ox, oy, oz] = tipOf(k), d = unit3(ox - hub[0], oy - hub[1], oz - hub[2]);
      const pivot = [hub[0] + d[0] * 0.14, hub[1] + d[1] * 0.08, hub[2] + d[2] * 0.14];
      bone(5, 1, pivot, [pivot[0] + (ox - pivot[0]) * 0.54, pivot[1] + (oy - pivot[1]) * 0.54 + 0.28, pivot[2] + (oz - pivot[2]) * 0.54], 0.06, 0.48);
    }
    for (let k = 0; k < 13; k++) bone(6 + k, 2, [...bones[6 + k].tip], tipOf(k), 0.03, 0.92);
  } else {
    const heights = [0, 0.14, 0.3, 0.48, 0.66, 0.84], spine = [];
    let cx = 0, cz = 0;
    heights.forEach((f, s) => {
      const y = groundY + f * H, band = 0.09 * H, reach = s === 0 ? Math.max(0.8, stem * 1.6) : Math.max(0.45, crownRadius * (0.22 + 0.12 * s));
      let x = 0, z = 0, w = 0;
      for (const e of wood) {
        const r = Math.hypot(e.x - cx, e.z - cz);
        if (Math.abs(e.y - y) <= band && r <= reach) { const k = e.mass / (0.05 + r); x += e.x * k; z += e.z * k; w += k; }
      }
      if (w > 0) { cx = x / w; cz = z / w; }
      spine.push([cx, y, cz]);
    });
    [0.08, 0.24, 0.44, 0.68, 0.9].forEach((along, b) => bone(b - 1, 0, spine[b], spine[b + 1], Math.max(0.015, stem * 0.5 * (1 - 0.58 * (b / 5))), along));
    const spineAt = (y) => {
      const f = clampTo((y - groundY) / H, 0, heights[5]);
      for (let b = 0; b < 5; b++) if (f <= heights[b + 1] || b === 4) {
        const u = clampTo((f - heights[b]) / Math.max(1e-4, heights[b + 1] - heights[b]), 0, 1);
        return { b, x: spine[b][0] + (spine[b + 1][0] - spine[b][0]) * u, y: spine[b][1] + (spine[b + 1][1] - spine[b][1]) * u, z: spine[b][2] + (spine[b + 1][2] - spine[b][2]) * u };
      }
      return { b: 4, x: spine[5][0], y: spine[5][1], z: spine[5][2] };
    };
    // Nine boughs toward the farthest-spread wood and leaves off the trunk, each forking a little below its reach.
    const candidates = [], radial = [];
    for (let i = 0; i < wood.length; i += Math.max(1, Math.floor(wood.length / 2200))) {
      const e = wood[i];
      if (e.y < groundY + 0.15 * H) continue;
      const s = spineAt(e.y), r = Math.hypot(e.x - s.x, e.z - s.z);
      if (r > Math.max(stem * 0.85, crownRadius * 0.16)) { candidates.push(e.x, e.y, e.z); radial.push(r); }
    }
    for (let i = 0; i < leaves.length; i += Math.max(1, Math.floor(leaves.length / 1800))) {
      const e = leaves[i], s = spineAt(e.y), r = Math.hypot(e.x - s.x, e.z - s.z);
      if (r > crownRadius * 0.22) { candidates.push(e.x, e.y, e.z); radial.push(r); }
    }
    const boughs = spreadPoints(candidates, 9, (i) => 0.35 + radial[i]);
    for (let s = 0; s < 9; s++) {
      const at = boughs[s % Math.max(1, boughs.length)];
      const [sx, sy, sz] = candidates.length ? candidates.slice(at * 3, at * 3 + 3)
        : [crown[0] + Math.cos((s / 9) * Math.PI * 2) * crownRadius * 0.7, groundY + (0.35 + 0.45 * ((s % 3) / 2)) * H, crown[2] + Math.sin((s / 9) * Math.PI * 2) * crownRadius * 0.7];
      const seed = spineAt(sy), forkY = clampTo(sy - Math.hypot(sx - seed.x, sz - seed.z) * 0.32, groundY + 0.13 * H, groundY + 0.8 * H), fork = spineAt(forkY);
      const out = unit3(sx - fork.x, 0, sz - fork.z, [1, 0, 0]), collar = Math.max(0.01, stem * 0.32 * (1 - 0.5 * ((forkY - groundY) / H)));
      const pivot = [fork.x + out[0] * collar, fork.y, fork.z + out[2] * collar];
      bone(fork.b, 1, pivot, [pivot[0] + (sx - pivot[0]) * 0.58, pivot[1] + (sy - pivot[1]) * 0.58, pivot[2] + (sz - pivot[2]) * 0.58], Math.max(0.008, stem * 0.14), 0.52);
    }
    // Eighteen branchlets over the outer foliage, each off the outer half of the bough nearest it.
    const twigs = [], twigRadial = [];
    for (let i = 0; i < leaves.length; i += Math.max(1, Math.floor(leaves.length / 2600))) {
      const e = leaves[i], s = spineAt(e.y);
      twigs.push(e.x, e.y, e.z); twigRadial.push(Math.hypot(e.x - s.x, (e.y - crown[1]) * 0.6, e.z - s.z));
    }
    const tips = spreadPoints(twigs, 18, (i) => 0.25 + twigRadial[i]);
    for (let m = 0; m < 18; m++) {
      const at = tips[m % Math.max(1, tips.length)];
      const [tx, ty, tz] = twigs.length ? twigs.slice(at * 3, at * 3 + 3)
        : [crown[0] + Math.cos((m / 18) * Math.PI * 2) * crownRadius * 0.9, groundY + (0.3 + 0.6 * ((m % 4) / 3)) * H, crown[2] + Math.sin((m / 18) * Math.PI * 2) * crownRadius * 0.9];
      let parent = 5, near = Infinity, anchor = bones[5].tip;
      for (let b = 5; b <= 13; b++) {
        const t = Math.max(0.45, towardSegment(tx, ty, tz, bones[b].pivot, bones[b].tip).t);
        const a = [0, 1, 2].map((k) => bones[b].pivot[k] + (bones[b].tip[k] - bones[b].pivot[k]) * t), d2 = (tx - a[0]) ** 2 + (ty - a[1]) ** 2 + (tz - a[2]) ** 2;
        if (d2 < near) { near = d2; parent = b; anchor = a; }
      }
      bone(parent, 2, anchor, [tx, ty, tz], Math.max(0.004, stem * 0.045), 0.9);
    }
  }
  if (bones.length > CONTINUUM_WIND_BONES || bones.some((b, i) => !(b.parent < i))) throw Error(`${p.species}: its skeleton is out of order`);
  // Every element to the bone nearest it (a leaf to the boughs and branchlets before the upper trunk), then its mass,
  // drag and their moments carried down from each bone to its parent.
  const B = bones.length, mass = new Float64Array(B), drag = new Float64Array(B), massAt = new Float64Array(B * 3), dragAt = new Float64Array(B * 3);
  const nearest = (x, y, z, leaf) => {
    let best = 0, score = Infinity;
    bones.forEach((b, i) => {
      if (leaf && b.group === 0 && y > groundY + 0.3 * H) return;
      const s = Math.max(0, Math.sqrt(towardSegment(x, y, z, b.pivot, b.tip).d2) - b.radius) * (leaf ? (b.group === 2 ? 0.88 : b.group === 1 ? 0.96 : 1.15) : 1);
      if (s < score) { score = s; best = i; }
    });
    return best;
  };
  const add = (b, x, y, z, m, d) => { mass[b] += m; drag[b] += d; massAt[b * 3] += x * m; massAt[b * 3 + 1] += y * m; massAt[b * 3 + 2] += z * m; dragAt[b * 3] += x * d; dragAt[b * 3 + 1] += y * d; dragAt[b * 3 + 2] += z * d; };
  for (const e of wood) add(nearest(e.x, e.y, e.z, false), e.x, e.y, e.z, e.mass, e.drag);
  for (const e of leaves) add(nearest(e.x, e.y, e.z, true), e.x, e.y, e.z, e.mass, e.drag);
  bones.forEach((b, i) => {
    const length = Math.max(0.08, Math.hypot(b.tip[0] - b.pivot[0], b.tip[1] - b.pivot[1], b.tip[2] - b.pivot[2]));
    const mid = [0, 1, 2].map((k) => (b.pivot[k] + b.tip[k]) / 2);
    const m = Math.max(0, Math.PI * b.radius * b.radius * length * WOOD_DENSITY * 0.35 - mass[i]), d = Math.max(0, Math.max(0.02, b.radius * length) - drag[i]);
    mass[i] += m; drag[i] += d;
    for (let k = 0; k < 3; k++) { massAt[i * 3 + k] += mid[k] * m; dragAt[i * 3 + k] += mid[k] * d; }
  });
  for (let i = B - 1; i > 0; i--) {
    const q = bones[i].parent;
    mass[q] += mass[i]; drag[q] += drag[i];
    for (let k = 0; k < 3; k++) { massAt[q * 3 + k] += massAt[i * 3 + k]; dragAt[q * 3 + k] += dragAt[i * 3 + k]; }
  }
  const totalMass = Math.max(0.5, mass[0]), slender = clampTo(H / Math.max(stem, 0.035 * H), 8, 95);
  const omega0 = clampTo(((2 * Math.PI * 1.12) / Math.sqrt(Math.max(1.1, H))) * (30 / slender) ** 0.18, 1.15, 7.5);
  const rest = new Float32Array(CONTINUUM_WIND_BONES * 16);
  bones.forEach((b, i) => {
    const axis = unit3(b.tip[0] - b.pivot[0], b.tip[1] - b.pivot[1], b.tip[2] - b.pivot[2]);
    const lever = [0, 1, 2].map((k) => dragAt[i * 3 + k] / drag[i] - b.pivot[k]);
    const length = Math.max(0.06, Math.hypot(b.tip[0] - b.pivot[0], b.tip[1] - b.pivot[1], b.tip[2] - b.pivot[2]));
    // Leaves stand in a crown about a bough, so even a wind along it lifts it.
    if (Math.abs(lever[1]) < 0.24 * length) lever[1] = (lever[1] >= 0 ? 1 : -1) * 0.24 * length;
    const torque = Math.max(0.15, REF_PRESSURE * drag[i] * Math.max(0.08, Math.hypot(...lever)));
    let bend, omega, damping, most;
    if (b.group === 0) { bend = (0.0045 + 0.0165 * b.along) * (slender / 30) ** 0.65; omega = omega0 * (0.92 + 0.36 * b.along); damping = 0.29; most = 0.19 * (0.42 + 0.78 * b.along); }
    else if (b.group === 1) { bend = (palm ? 0.078 : 0.05) * (slender / 30) ** 0.3; omega = omega0 * (palm ? 1.85 : 2.2) * (0.08 / clampTo(mass[i] / totalMass, 0.005, 0.5)) ** 0.12; damping = 0.25; most = palm ? 0.48 : 0.3; }
    else { bend = (palm ? 0.13 : 0.095) * (slender / 30) ** 0.22; omega = omega0 * (palm ? 3.25 : 4.15) * (0.02 / clampTo(mass[i] / totalMass, 0.001, 0.2)) ** 0.14; damping = 0.22; most = palm ? 0.6 : 0.42; }
    rest.set([...b.pivot, (b.parent + 1) | (b.group << 6) | (1 << 8), ...axis, b.along, ...lever, drag[i], Math.max(1.2, torque / Math.max(bend, 0.002)), clampTo(omega, 1, 16.5), damping, most], i * 16);
  });
  return {
    bones, groundY, H, rest: Array.from(rest, (v) => +v.toPrecision(7)),
    summary: { bones: B, heightMetres: +H.toFixed(2), slenderness: +slender.toFixed(2), massKg: +totalMass.toFixed(1), dragM2: +drag[0].toFixed(2), frequencyHz: +(omega0 / (2 * Math.PI)).toFixed(3) },
  };
}
// The two bones that carry a point and the first's share: by its three nearest bones' capsules, so the shares change
// smoothly across every seam (equal where the two nearest are, the first alone where the second and third are). Wood at
// the trunk's foot stands on the first trunk bone alone.
function windSkin({ bones, groundY, H }, x, y, z, leaf = false) {
  if (!leaf && y <= groundY + Math.min(0.32, 0.045 * H)) return { bone0: 0, bone1: 0, weight0: 1 };
  let b0 = 0, b1 = 0, d0 = Infinity, d1 = Infinity, d2 = Infinity;
  bones.forEach((b, i) => {
    const s = Math.max(0.01, Math.sqrt(towardSegment(x, y, z, b.pivot, b.tip).d2 + 0.04) - Math.min(b.radius * 0.65, 0.16)) * (leaf && b.group === 0 && y > groundY + 0.32 * H ? 1.35 : 1) + i * 1e-6;
    if (s < d0) { d2 = d1; d1 = d0; b1 = b0; d0 = s; b0 = i; } else if (s < d1) { d2 = d1; d1 = s; b1 = i; } else if (s < d2) d2 = s;
  });
  if (!Number.isFinite(d1) || b0 === b1) return { bone0: b0, bone1: b0, weight0: 1 };
  const ref = Number.isFinite(d2) ? d2 : d1 + 1, u0 = Math.max(0, ref - d0) ** 1.35, u1 = Math.max(0, ref - d1) ** 1.35;
  if (u0 + u1 <= 1e-7) return { bone0: b0, bone1: b1, weight0: 0.5 };
  const weight0 = clampTo(u0 / (u0 + u1), 0.5, 1);
  return weight0 > 0.996 ? { bone0: b0, bone1: b0, weight0: 1 } : { bone0: b0, bone1: b1, weight0 };
}

function main(source, indices, canopy) {
  const read = (v, offset, count) => source.subarray(v * SOURCE_STRIDE + offset, v * SOURCE_STRIDE + offset + count);
  // Leaves are two quads sharing an edge; a pack whose leaves are single quads has each cut across its middle into
  // the same two (the bake of the forest's clusters did likewise).
  function leafSource(p) {
    const first = p.leaf.firstIndex;
    if (p.leaf.indexCount >= 6 && indices[first + 3] === indices[first + 2] && indices[first + 4] === indices[first + 1]) {
      const leaves = p.leaf.indexCount / 6, map = new Uint32Array(leaves * 8);
      const pos = new Float32Array(map.length * 3), nrm = new Float32Array(map.length * 3), uv = new Float32Array(map.length * 2);
      const mean = (u, v, offset, count) => Array.from({ length: count }, (_, k) => (read(u, offset, count)[k] + read(v, offset, count)[k]) / 2);
      for (let leaf = 0; leaf < leaves; leaf++) {
        const at = p.leaf.firstIndex + leaf * 6, a = indices[at], b = indices[at + 1], c = indices[at + 2], d = indices[at + 5];
        if (indices[at + 3] !== c || indices[at + 4] !== b) throw Error(`${p.species}: leaf ${leaf} is not a single quad`);
        [[a, a], [b, b], [b, d], [a, c], [a, c], [b, d], [d, d], [c, c]].forEach(([u, v], k) => {
          const out = leaf * 8 + k;
          map[out] = u;
          pos.set(mean(u, v, 0, 3), out * 3);
          const n = mean(u, v, 3, 3), length = Math.hypot(...n) || 1;
          nrm.set(n.map((value) => value / length), out * 3);
          uv.set(mean(u, v, 8, 2), out * 2);
        });
      }
      return { map, leaves: { pos, nrm, uv, vpl: 8 } };
    }
    const leaves = p.leaf.indexCount / 12, map = new Uint32Array(leaves * 8);
    for (let leaf = 0; leaf < leaves; leaf++) {
      const at = p.leaf.firstIndex + leaf * 12, i = (k) => indices[at + k];
      map.set([i(0), i(1), i(2), i(5), i(6), i(7), i(8), i(11)], leaf * 8);
    }
    const pos = new Float32Array(map.length * 3), nrm = new Float32Array(map.length * 3), uv = new Float32Array(map.length * 2);
    map.forEach((v, k) => { pos.set(read(v, 0, 3), k * 3); nrm.set(read(v, 3, 3), k * 3); uv.set(read(v, 8, 2), k * 2); });
    return { map, leaves: { pos, nrm, uv, vpl: 8 } };
  }
  // A source vertex's surface, for the packer.
  const surfaceOf = (v, leaf) => ({
    material: Math.round(source[v * SOURCE_STRIDE + 13]), leaf, colour: Array.from(read(v, 10, 3)), exposure: source[v * SOURCE_STRIDE + 7], canopy: canopy ? canopy[v] / 255 : 1,
  });
  return async function bakePrototype(p, firstLayer) {
    const t0 = Date.now();
    const foliage = p.nativeMaterials.find((m) => m.name.startsWith('foliage') || m.name.startsWith('leaf'));
    const leaf = leafSource(p);
    // The wood, each corner with its source vertex in its kind, so corners weld only where the pack's mesh shares a
    // vertex; its foot flared into the ground.
    const woodIndex = indices.subarray(p.wood.firstIndex, p.wood.firstIndex + p.wood.indexCount), woodTriangles = woodIndex.length / 3;
    const leafTriangles = (leaf.map.length / 8) * 4, corners = new Float32Array((woodTriangles + leafTriangles) * 3 * 8);
    woodIndex.forEach((v, k) => corners.set([...flareRoot(read(v, 0, 3)), ...read(v, 3, 3), FOREST_CONTINUUM_BARK, v], k * 8));
    // The leaf cards, as triangles, for the far body's wrap.
    for (let card = 0, at = woodIndex.length; card < leaf.map.length / 8; card++) {
      for (const k of [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]) {
        const c = card * 8 + k;
        corners.set([...leaf.leaves.pos.subarray(c * 3, c * 3 + 3), ...leaf.leaves.nrm.subarray(c * 3, c * 3 + 3), FOREST_CONTINUUM_LEAF, leaf.map[c]], at * 8);
        at++;
      }
    }
    const name = `${p.species}${p.cohort ? `-${p.cohort}` : ''}`;
    const wood = { name, vertices: corners.subarray(0, woodTriangles * 24), triangles: woodTriangles, parts: new Uint32Array(woodTriangles) };
    const whole = { name, vertices: corners, triangles: woodTriangles + leafTriangles, parts: new Uint32Array(woodTriangles + leafTriangles) };
    const welded = weldDrawn(wood), woodUV = new Float32Array(welded.count * 2);
    for (let v = 0; v < welded.count; v++) woodUV.set(read(welded.kind[v * 2 + 1], 8, 2), v * 2);
    const clusters = await bakeClusters(welded, {
      uv: woodUV, leaves: { ...leaf.leaves, mask: foliage ? leafMask(foliage.albedo.file) : null, error: LEAF_ERROR_SHARE, part: 0 },
    });
    const drawn = weldDrawn(whole), far = bakeFar(whole, drawn);
    outlineErrors(far, drawn);

    // The packed vertices: the wood's welded ones, then the leaves' (js/continuum-bake.js bakeClusters).
    const L = clusters.leafVertices, W = welded.count, all = W + L.source.length;
    const position = new Float32Array(all * 3), normal = new Float32Array(all * 3);
    position.set(welded.position); position.set(L.position, W * 3); normal.set(welded.normal); normal.set(L.normal, W * 3);
    tightenClusterSpheres(clusters, position, (r) => clusters.order[clusters.indices[r.first]] < W);
    continuumFarFirst(clusters, far);
    const isLeaf = (v) => v >= W, sourceOf = (v) => (isLeaf(v) ? leaf.map[L.source[v - W]] : welded.kind[v * 2 + 1]);
    const uvOf = (v) => (isLeaf(v) ? [L.uv[(v - W) * 2], L.uv[(v - W) * 2 + 1]] : [woodUV[v * 2], woodUV[v * 2 + 1]]);
    const uvLow = [Infinity, Infinity], uvHigh = [-Infinity, -Infinity];
    for (const v of clusters.order) {
      const uv = uvOf(v);
      for (let k = 0; k < 2; k++) { uvLow[k] = Math.min(uvLow[k], uv[k]); uvHigh[k] = Math.max(uvHigh[k], uv[k]); }
    }
    // Its skeleton, and the bones that carry each point. A leaf card is carried whole by the bark nearest its foot
    // (its corner nearest the wood, within 0.28 m), so it never tears from its twig; one far from any bark by the
    // boughs and branchlets nearest its foot. Each of its points flutters by how far along the card from the foot it
    // lies. Coarser cards are their finest card's, grown, and are carried as it is.
    const skeleton = windSkeleton(p, windElements(p, corners, woodTriangles, leafTriangles));
    const woodWord = new Uint32Array(W);
    const CELL = 0.28, bark = new Map(), key = (x, y, z) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
    const addBark = (x, y, z, skin) => { const k = key(x, y, z); if (!bark.has(k)) bark.set(k, []); bark.get(k).push([x, y, z, skin]); };
    for (let v = 0; v < W; v++) {
      const [x, y, z] = position.subarray(v * 3, v * 3 + 3), skin = windSkin(skeleton, x, y, z);
      woodWord[v] = packContinuumWindBones(skin);
      addBark(x, y, z, skin);
    }
    for (let t = 0; t < welded.index.length / 3; t++) {
      const c = [0, 1, 2].map((a) => (welded.position[welded.index[t * 3] * 3 + a] + welded.position[welded.index[t * 3 + 1] * 3 + a] + welded.position[welded.index[t * 3 + 2] * 3 + a]) / 3);
      addBark(c[0], c[1], c[2], windSkin(skeleton, c[0], c[1], c[2]));
    }
    const nearestBark = (x, y, z) => {
      let best = null, d2 = CELL * CELL;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const s of bark.get(key(x + dx * CELL, y + dy * CELL, z + dz * CELL)) ?? []) {
          const d = (s[0] - x) ** 2 + (s[1] - y) ** 2 + (s[2] - z) ** 2;
          if (d < d2) { d2 = d; best = s; }
        }
      }
      return best ? { d2, skin: best[3] } : null;
    };
    const cards = leaf.map.length / 8, cardSkin = new Array(cards), along = new Float32Array(leaf.map.length);
    let locked = 0;
    for (let c = 0; c < cards; c++) {
      const P = (k) => leaf.leaves.pos.subarray((c * 8 + k) * 3, (c * 8 + k) * 3 + 3);
      let foot = -1, found = null;
      for (let k = 0; k < 8; k++) { const near = nearestBark(...P(k)); if (near && (!found || near.d2 < found.d2)) { found = near; foot = k; } }
      if (found) locked++;
      else {
        let score = Infinity;
        for (let k = 0; k < 8; k++) { const [x, y, z] = P(k); for (const b of skeleton.bones) { const d = towardSegment(x, y, z, b.pivot, b.tip).d2; if (d < score) { score = d; foot = k; } } }
      }
      const F = P(foot), reach = Math.max(1e-4, ...Array.from({ length: 8 }, (_, k) => Math.hypot(P(k)[0] - F[0], P(k)[1] - F[1], P(k)[2] - F[2])));
      for (let k = 0; k < 8; k++) along[c * 8 + k] = Math.hypot(P(k)[0] - F[0], P(k)[1] - F[1], P(k)[2] - F[2]) / reach;
      cardSkin[c] = found ? found.skin : windSkin(skeleton, F[0], F[1], F[2], true);
    }
    const windOf = (v) => {
      if (!isLeaf(v)) return woodWord[v];
      const s = L.source[v - W], card = Math.floor(s / 8);
      return packContinuumWindBones({ ...cardSkin[card], phase: ((card * 0.6180339887) % 1 + 1) % 1, along: along[s], leaf: true });
    };
    // The far body is carried by the same bones: its crown by the boughs and branchlets, its trunk by the trunk.
    const farWind = (i) => {
      const [x, y, z] = far.position.subarray(i * 3, i * 3 + 3);
      return packContinuumWindBones(windSkin(skeleton, x, y, z, y > skeleton.groundY + 0.32 * skeleton.H));
    };
    // The splat wears the leaves' mean, of their commonest layer.
    const layers = new Map(), mean = [0, 0, 0, 0, 0];
    for (const v of leaf.map) {
      const s = surfaceOf(v, true);
      layers.set(s.material, (layers.get(s.material) ?? 0) + 1);
      mean[0] += s.colour[0]; mean[1] += s.colour[1]; mean[2] += s.colour[2]; mean[3] += s.exposure; mean[4] += s.canopy;
    }
    const n = Math.max(1, leaf.map.length), commonest = [...layers].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const look = { material: commonest, leaf: leaf.map.length > 0, colour: mean.slice(0, 3).map((c) => c / n), exposure: mean[3] / n, canopy: mean[4] / n };
    const packed = packForestContinuumBody({
      triangles: woodTriangles + leafTriangles, surface: (v) => surfaceOf(sourceOf(v), isLeaf(v)), uv: uvOf,
      wind: windOf, farWind,
      farSurface: (t) => surfaceOf(far.kinds[t * 2 + 1], far.kinds[t * 2] === FOREST_CONTINUUM_LEAF),
      look, uvRange: [uvLow[0], uvLow[1], Math.max(uvHigh[0] - uvLow[0], 1e-3), Math.max(uvHigh[1] - uvLow[1], 1e-3)], firstLayer,
    }, { welded: { position, normal }, clusters, far });
    const ms = Date.now() - t0;
    console.log(`${String(p.id).padStart(2)} ${name.padEnd(20)} wood ${woodTriangles} · leaves ${leafTriangles} tris · ${clusters.count} clusters, ${clusters.levels} levels, root ${clusters.rootError.toFixed(3)} m · wrap ${far.stats.cell} m, ${far.stats.baseTriangles} → ${far.stats.coreTriangles} in ${far.stats.steps} steps (depth ${far.stats.depth}), ${far.stats.errorRange.join('–')} m (summed ${far.stats.summedErrorRange.join('–')} m), handoff at step ${far.farFirst} (${far.stats.farFirstTriangles} ≤ ${far.stats.rootTriangles}, ${far.stats.handoffError} m for the roots' ${clusters.rootError.toFixed(3)} m) · bound ${packed.radius.toFixed(2)} m · ${skeleton.summary.bones} bones, ${skeleton.summary.frequencyHz} Hz, ${(100 * locked / Math.max(1, cards)).toFixed(1)}% of cards on bark · ${(ms / 1000).toFixed(1)} s`);
    const fingerprint = sha256(Buffer.concat([asBytes(corners), Buffer.from(JSON.stringify([p.nativeMaterials, firstLayer]))]));
    return { p, name, clusters, far, packed, ms, fingerprint, sourceTriangles: woodTriangles + leafTriangles, wind: { ...skeleton.summary, barkLockedCards: +(locked / Math.max(1, cards)).toFixed(4), bones: skeleton.rest } };
  };
}

// The baked atlas read back and checked against its manifest and the pack: every prototype a type, in order, each
// with its clusters and its far body, and the atlas the cut reads.
function check() {
  const baked = JSON.parse(fs.readFileSync(ASSETS['manifest.json'], 'utf8'));
  validateForestContinuumManifest(baked);
  const bytes = zlib.gunzipSync(fs.readFileSync(ASSETS['atlas.bin.gz']));
  if (bytes.length !== baked.atlas.bytes || sha256(bytes) !== baked.atlas.sha256) throw Error(`${packName}: the forest atlas does not match its receipt`);
  const words = checkContinuumAtlas(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), 'forest');
  if (words[CONTINUUM_HEADER.typeCount] !== manifest.prototypes.length || baked.types.length !== manifest.prototypes.length) throw Error(`${packName}: the atlas holds ${baked.types.length} types for ${manifest.prototypes.length} prototypes`);
  baked.types.forEach((type, id) => {
    const p = manifest.prototypes[id], at = words[CONTINUUM_HEADER.typesAt] + id * CONTINUUM_TYPE_WORDS;
    if (type.name !== `${p.species}${p.cohort ? `-${p.cohort}` : ''}`) throw Error(`${packName}: type ${id} is ${type.name}, not prototype ${p.species}`);
    const floats = new Float32Array(words.buffer, words.byteOffset + at * 4, CONTINUUM_TYPE_WORDS);
    if (!(floats[CONTINUUM_TYPE.sphere + 3] > 0)) throw Error(`${packName}: type ${id} has no bound`);
  });
  const types = continuumAtlasTypes(words);
  console.log(`${packName}: ${types.length} types, ${words[CONTINUUM_HEADER.clusterCount]} clusters, ${words[CONTINUUM_HEADER.vertexCount]} vertices, far bodies of ${types.map((t) => t.farChunks).join('/')} chunks · checked`);
}

if (checkOnly) check();
else {
  const started = Date.now();
  await MeshoptSimplifier.ready;
  const source = asFloats(gunzip('vertices.bin.gz')), indices = asWords(gunzip('indices.bin.gz'));
  const canopyFile = path.join(dir, 'canopy-shade.bin.gz'), canopy = fs.existsSync(canopyFile) ? zlib.gunzipSync(fs.readFileSync(canopyFile)) : null;
  if (source.length / SOURCE_STRIDE >= 1 << 24) throw Error('A pack this large cannot name its source vertices in a float');
  const bakePrototype = main(source, indices, canopy), baked = [];
  let firstLayer = 0;
  for (const p of manifest.prototypes) {
    if (!only || p.species === only) baked.push(await bakePrototype(p, firstLayer));
    firstLayer += p.nativeMaterials.length;
  }
  if (only) { console.log(`--only bakes nothing to disk: ${((Date.now() - started) / 1000).toFixed(1)} s`); process.exit(0); }
  const atlas = assembleContinuumAtlas(baked.map((b) => b.packed.words)), H = CONTINUUM_HEADER;
  const types = baked.map(({ p, name, clusters, far, packed: { low, span, centre, radius }, ms, fingerprint, sourceTriangles, wind }) => ({
    id: p.id, name, fingerprint, sourceTriangles,
    quantization: { low: low.map((v) => +v.toFixed(5)), span: +span.toFixed(5) }, sphere: [...centre.map((v) => +v.toFixed(4)), +radius.toFixed(4)],
    clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootError: +clusters.rootError.toFixed(4), leafClusters: clusters.stats.leafClusters, leafLevels: clusters.stats.leafLevels },
    chain: far.stats, splat: far.splat, wind, bakeMs: ms,
  }));
  fs.mkdirSync(OUT, { recursive: true });
  const bytes = asBytes(atlas), gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(ASSETS['atlas.bin.gz'], gz);
  const out = {
    format: FOREST_CONTINUUM_FORMAT, version: FOREST_CONTINUUM_VERSION, generator: 'scripts/prepare-forest-continuum.mjs', pack: packName,
    layout: { atlasVersion: CONTINUUM_ATLAS_VERSION, header: CONTINUUM_HEADER, material: FOREST_CONTINUUM_MATERIAL, streams: atlas[H.streams] },
    totals: { types: types.length, clusters: atlas[H.clusterCount], vertices: atlas[H.vertexCount], indices: atlas[H.indexCount], sourceTriangles: types.reduce((n, t) => n + t.sourceTriangles, 0), farTriangles: baked.reduce((n, b) => n + b.far.index.length / 3, 0) },
    types,
    atlas: { words: atlas.length, bytes: bytes.length, sha256: sha256(bytes), gzip: { file: 'atlas.bin.gz', bytes: gz.length, sha256: sha256(gz) } },
    bakeSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  validateForestContinuumManifest(out);
  fs.writeFileSync(ASSETS['manifest.json'], `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${packName}: ${types.length} types · ${atlas[H.clusterCount]} clusters · atlas ${(bytes.length / 1048576).toFixed(1)} MiB, ${(gz.length / 1048576).toFixed(1)} MiB gzipped · ${out.bakeSeconds} s`);
  check();
}
