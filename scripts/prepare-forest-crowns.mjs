#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes each tree's far crown: one rounded, closed surface in the shape of its leaves at three levels of
// detail, carrying the leaves' own colour and exposure at every vertex, with a column for the trunk
// beneath. js/forest-crowns.js draws it where single leaf cards can no longer be told apart, in place of
// every layer of them and of the wood.
//   node scripts/prepare-forest-crowns.mjs portugal [--only=oak] [--preview=folder]
// The surface follows the tree's own leaves, every one of them, pushed out as forestClusterVertex pushes
// far cards and as opaque as the far coverage makes them. It is one continuous, rounded body: boughs
// that stand a little apart are joined, hollows are filled and scraps are left out, so a far wood reads
// as crowns and not as cards. Its outline has the area of the tree's own shape (shapeArea), averaged over
// the directions a tree is seen from, so no wood looks thinner for it. Leaves and wood are read from the
// pack's clusters; bake those first.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { FOREST_CLUSTER_VERTEX_WORDS, packForestClusterVertex } from '../js/forest-clusters.js';
import { FOREST_CROWN_LEVELS, FOREST_CROWN_NEAREST } from '../js/forest-crowns.js';
import { CLOSE_METRES, CLUSTER_WORDS, CROWN_FINE_CELLS, PROJECTED_SHARE, compact, cross, leafField, linear, normalize, octahedral, openForestLeaves, relax, seenFrom, surface, vertexNormals, volume } from './forest-leaf-field.mjs';

const args = process.argv.slice(2);
const packName = args.find((a) => !a.startsWith('--')) ?? 'portugal';
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const previewDir = args.find((a) => a.startsWith('--preview='))?.slice(10);
const dir = path.join('assets/forest-scenery', packName);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const { clusterManifest, clusterIndices, clusterWords, clusterFloats, leafImage, clusterVertex, leafSamples } = openForestLeaves(dir);
// Triangles each level aims for. A level ends sooner if it cannot lose more without leaving the shape.
const LEVEL_TRIANGLES = [300, 112, 48];
// The cell each level's surface is found at, in cells of the leaf field. A coarse level is not the fine
// one with triangles taken away, which leaves shards and spikes: it is the surface of the same leaves
// seen less sharply, so each level is as round as its triangles can hold.
const LEVEL_CELLS = [CROWN_FINE_CELLS, 2.2, 3.2];


// Where a tree changes to its crown, as the error of the leaf cut drawn there: the cut in force at
// FOREST_CROWN_NEAREST in a view 1117 pixels high and 58 degrees tall. A sharper view or a spyglass
// reaches that cut further out, and the change goes out with it (forestClusterSelect).
const REFERENCE_PIXELS_PER_METRE = 1008, REFERENCE_LEAF_PIXELS = 1.2, REFERENCE_WOOD_PIXELS = 1.5;
const CHANGE_ERROR_METRES = FOREST_CROWN_NEAREST * REFERENCE_LEAF_PIXELS / REFERENCE_PIXELS_PER_METRE;
// The surface found is rounded this many times.
const ROUNDING = 8;
// A crease as deep as this share of the tree's span is as dark as creases get, and darker by CREASE_DEPTH;
// a lobe standing out as far is lighter by CREASE_LIFT, less because lobes are most of what is seen.
const CREASE_SHARE = 0.03, CREASE_DEPTH = 0.4, CREASE_LIFT = 0.12;
// What shows between a tree's cards stands behind and below its leaves, in their shade about as often as
// in the sun, so it counts at this share of the sunlit colour.
const BACKDROP_SHADE = 0.5;
// Packs whose trees stand apart on open ground, and how broad one may stand on screen as a crown, in leaf
// errors (js/forest-crowns.js): 30 pixels in the default view. Lisbon's woods are closed and need none.
const OPEN_GROWN = { subtropical: 25 };

// The trunk under a far crown: one tapering column that follows the wood from the ground up into the
// crown, as wide and as dark as the wood drawn at that range. The boughs above it are inside the crown.
const TRUNK_SIDES = [5, 4, 3], TRUNK_RINGS = [4, 3, 2], TRUNK_FOOT_METRES = 0.03;
function trunkColumn(p, top, level) {
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
  const height = Math.min(top, highest) - TRUNK_FOOT_METRES, sides = TRUNK_SIDES[level], rings = TRUNK_RINGS[level];
  // A shrub whose leaves reach the ground shows no stem.
  if (!wood.length || height < 0.3) return null;
  const span = height / (rings - 1), positions = [], normals = [], looks = [], indices = [];
  // The stem alone, not the boughs that leave it: its width is read near the ground, where there is
  // nothing else, and each ring looks for wood only close to the ring below.
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
    // No wider than its wood's own area would make a single stem: prop roots are mostly air.
    return { centre: middle, radius: Math.min(reach / sum[0], inside / (2 * Math.PI * (to - from))), colour: [sum[3] / sum[0], sum[4] / sum[0], sum[5] / sum[0]], shade: sum[6] / sum[0], canopy: sum[7] / sum[0] };
  };
  const foot = gather(Math.min(0.15, height * 0.1), Math.min(1.2, Math.max(0.3, height * 0.25)), null, 0);
  if (!foot) return null;
  let last = foot;
  for (let j = 0; j < rings; j++) {
    const y = TRUNK_FOOT_METRES + j * span;
    const ring = (j && gather(y - span / 2, y + span / 2, last.centre, Math.max(foot.radius * 3, 0.5))) || last;
    last = ring;
    // A stem narrows as it climbs. A column of few sides is as wide, seen from all round, as the round stem it stands for.
    const radius = foot.radius * (1 - 0.45 * j / (rings - 1)), corner = radius * Math.PI / (sides * Math.sin(Math.PI / sides));
    for (let i = 0; i < sides; i++) {
      const angle = (i + j * 0.5) * 2 * Math.PI / sides, out = [Math.cos(angle), 0, Math.sin(angle)];
      positions.push(ring.centre[0] + out[0] * corner, y, ring.centre[1] + out[2] * corner); normals.push(...out); looks.push(ring);
    }
  }
  for (let j = 0; j < rings - 1; j++) for (let i = 0; i < sides; i++) {
    const a = j * sides + i, b = j * sides + (i + 1) % sides, e = a + sides, d = b + sides;
    indices.push(a, e, b, b, e, d);
  }
  for (let i = 1; i < sides - 1; i++) indices.push(0, i, i + 1, (rings - 1) * sides, (rings - 1) * sides + i + 1, (rings - 1) * sides + i);
  const mesh = { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
  if (volume(mesh) < 0) for (let i = 0; i < mesh.indices.length; i += 3) { const swap = mesh.indices[i + 1]; mesh.indices[i + 1] = mesh.indices[i + 2]; mesh.indices[i + 2] = swap; }
  return { ...mesh, normals, looks };
}


// The directions a tree is seen from: all round it, from a little below to well above. Each is the
// way to the viewer.
const VIEWS = [];
for (const [row, elevation] of [-12, 2, 16, 34, 56].entries()) for (let k = 0; k < 12; k++) {
  const az = (k + row * 0.37) * Math.PI / 6, el = elevation * Math.PI / 180;
  const towards = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  const right = normalize(cross([0, 1, 0], towards));
  VIEWS.push({ towards, right, up: cross(towards, right) });
}
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
// What the far leaves show from one direction, pixel by pixel: the nearest leaf wins each share of a
// pixel, as the depth buffer has it. Kept are how much of the pixel they cover and, of the leaves seen
// there, the colour, exposure, facing and depth. A crown's vertices are coloured from these pictures.
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
// The area of a tree's shape from one direction: what its leaves cover, with the gaps between boughs
// closed and the holes inside filled, as an eye joins them at range. A crown's outline is given this
// area, so a tree of thin foliage keeps its full shape and does not shrink to a core.
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
// A closed surface's outline from one direction, at twice the frame's fineness.
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
// The colour most of the pack's trees show: the middle one, so that one bright species does not set it.
// It is what shows between the cards of a thin tree seen against a wooded hill.
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
const vertexWords = [], indexWords = [], prototypes = [];
let vertexCount = 0;
for (const p of manifest.prototypes) {
  if (only && p.species !== only) continue;
  const started = Date.now();
  const samples = leafSamples(p, cellFor);
  const field = leafField(samples), { step } = field;
  const frames = VIEWS.map((view) => viewFrame(view, field.origin, field.origin.map((v, k) => v + field.size[k] * step), step));
  const wanted = VIEWS.map((view, k) => leafSeen(samples, view, frames[k]));
  const coveredArea = wanted.reduce((sum, w) => sum + w.area, 0), wantedArea = wanted.reduce((sum, w, k) => sum + shapeArea(w.through, frames[k]), 0), coverShare = Math.min(1, coveredArea / wantedArea);
  // Where the crown takes over, the game is drawing the tree as a few large cards, and they cover less of
  // its shape than its leaves do: the forest behind shows between them.
  const changing = leafSamples(p, () => step, CHANGE_ERROR_METRES), changeArea = VIEWS.reduce((sum, view, k) => sum + leafSeen(changing, view, frames[k]).area, 0), ownShare = Math.min(1, changeArea / wantedArea);
  const outlined = (mesh) => VIEWS.reduce((sum, view, k) => sum + outline(mesh, view, frames[k]).area, 0);
  // The level whose surface covers what the leaves cover: a higher level gives a smaller crown.
  const fit = (field) => {
    let lowLevel = 0, highLevel = 0;
    for (let i = 0; i < field.smooth.length; i++) highLevel = Math.max(highLevel, field.smooth[i]);
    lowLevel = highLevel * 1e-4;
    for (let pass = 0; pass < 14; pass++) {
      const level = Math.sqrt(lowLevel * highLevel), mesh = relax(surface(field, level), ROUNDING);
      if (mesh && mesh.indices.length && outlined(mesh) > wantedArea) lowLevel = level; else highLevel = level;
    }
    const mesh = relax(surface(field, lowLevel), ROUNDING);
    if (volume(mesh) < 0) for (let i = 0; i < mesh.indices.length; i += 3) { const swap = mesh.indices[i + 1]; mesh.indices[i + 1] = mesh.indices[i + 2]; mesh.indices[i + 2] = swap; }
    return { mesh, level: lowLevel, cell: field.step };
  };
  const fitted = LEVEL_CELLS.map((cells) => fit(leafField(samples, step * cells))), fine = fitted[0];

  const foliage = p.nativeMaterials.filter((m) => /^(foliage|leaf)/.test(m.name)), foliageMean = [0, 1, 2].map((k) => foliage.reduce((sum, m) => sum + leafImage(m.albedo.file).mean[k], 0) / foliage.length);
  const whole = [0, 0, 0, 0, 0, 0, 0, 0];
  let wholeSeen = 0;
  for (const s of samples.points) { for (let k = 0; k < 3; k++) { whole[k] += s.seen * s.colour[k]; whole[5 + k] += s.seen * s.lean[k]; } whole[3] += s.seen * s.shade; whole[4] += s.seen * s.canopy; wholeSeen += s.seen; }
  const fallback = whole.map((v) => v / wholeSeen);
  const posSpan = Math.max(...[0, 1, 2].map((k) => samples.high[k] - samples.low[k]), 1e-3);

  // What a viewer sees of the leaves at one place on the crown: every direction that looks onto that
  // side of it gives the leaves its picture holds there, unless something nearer stood in the way.
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
  // Each level, cut down and then grown about its middle until its outline covers what the leaves do:
  // a coarser surface cuts corners, and the woods must not look thinner for it.
  const cut = LEVEL_TRIANGLES.map((target, k) => {
    const from = fitted[k].mesh;
    let reduced = compact(from), error = 0;
    if (from.indices.length / 3 > target) {
      const [kept, reported] = MeshoptSimplifier.simplify(from.indices, from.positions, 3, target * 3, posSpan, ['ErrorAbsolute']);
      reduced = compact({ positions: from.positions, indices: kept }); error = reported;
    }
    const count = reduced.positions.length / 3, middle = [0, 0, 0];
    for (let i = 0; i < reduced.positions.length; i++) middle[i % 3] += reduced.positions[i] / count;
    const grow = Math.min(1.3, Math.max(1, Math.sqrt(wantedArea / Math.max(outlined(reduced), 1e-9))));
    for (let i = 0; i < reduced.positions.length; i++) reduced.positions[i] = middle[i % 3] + (reduced.positions[i] - middle[i % 3]) * grow;
    return { reduced, error: Math.hypot(error, (grow - 1) * posSpan / 2), count, grow, cell: fitted[k].cell, trunk: trunkColumn(p, middle[1], k) };
  });
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const { reduced, trunk } of cut) for (const positions of [reduced.positions, trunk?.positions ?? []]) for (let i = 0; i < positions.length; i++) { low[i % 3] = Math.min(low[i % 3], positions[i]); high[i % 3] = Math.max(high[i % 3], positions[i]); }
  const posScale = Math.max(high[0] - low[0], high[1] - low[1], high[2] - low[2], 1e-3), quant = { low, posScale, uvLow: [0, 0], uvScale: [1, 1] };
  const firstVertex = vertexCount, levels = [], previews = [];
  // For the log: what all the views together show of the leaves, beside what the crown's vertices were given.
  const shown = new Float64Array(SEEN_CHANNELS), given = new Float64Array(8);
  let shownCover = 0, unseen = 0, alike = 0;
  for (const { seen, through } of wanted) for (let i = 0; i < through.length; i++) { for (let c = 0; c < SEEN_CHANNELS; c++) shown[c] += seen[i * SEEN_CHANNELS + c]; shownCover += 1 - through[i]; }
  for (const [levelId, { reduced, error, count, grow, cell, trunk }] of cut.entries()) {
    const normals = vertexNormals(reduced), out = [];
    // Light finds the lobes of a crown and misses the creases between them. How far each vertex stands
    // out of, or back from, the surface smoothed around it says which it is, and its leaves' exposure is
    // raised or lowered by that: the crown then shows its roundness under any light.
    const smoothed = relax(reduced, 4).positions, creased = new Float32Array(count);
    for (let v = 0; v < count; v++) {
      let depth = 0;
      for (let k = 0; k < 3; k++) depth += (smoothed[v * 3 + k] - reduced.positions[v * 3 + k]) * normals[v * 3 + k];
      creased[v] = Math.max(-1, Math.min(1, depth / (posSpan * CREASE_SHARE)));
    }
    for (let v = 0; v < count; v++) {
      const at = [reduced.positions[v * 3], reduced.positions[v * 3 + 1], reduced.positions[v * 3 + 2]], normal = [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]];
      const viewed = seenAt(at, normal), look = viewed ?? seenFrom(field, at, normal, fallback), lean = normalize(look.slice(5, 8));
      look[3] = Math.min(1, look[3] * (1 - CREASE_DEPTH * Math.max(creased[v], 0) + CREASE_LIFT * Math.max(-creased[v], 0)));
      // Between its leaves a tree shows the dark inside of itself, and between its cards at the change it
      // shows the forest behind. The crown has no gaps, so its colour is the leaves' mixed with both in the
      // shares they leave open: a thin birch among oaks comes in as the yellow-green haze its cards made,
      // not as a solid body of its brightest leaf.
      for (let c = 0; c < 3; c++) look[c] = coverShare * (ownShare * look[c] + (1 - ownShare) * BACKDROP_SHADE * packColour[c]);
      // How alike the leaves seen at one place face: the length of their mean normal there.
      if (!levelId) { if (!viewed) unseen++; for (let c = 0; c < 8; c++) given[c] += look[c] / count; alike += Math.min(1, Math.hypot(...look.slice(5, 8))) / count; }
      // The normal kept is the leaves' own, not the surface's: the crown is lit as the leaves it stands for.
      // The surface's own goes where a card keeps its place on the leaf map, and gives the crown its roundness.
      out.push(...packForestClusterVertex({ position: at, normal: Math.hypot(...look.slice(5, 8)) > 1e-3 ? lean : [0, 1, 0], uv: octahedral(normal), colour: look.slice(0, 3).map((c) => Math.min(1, c)), material: 0, shade: look[3], canopy: look[4] }, quant));
    }
    // A level stands in for leaves no finer than a cell and a half of its own, and strays further where it was cut down.
    // Material 1 marks the trunk, which the crown's shader lights as wood.
    const trunkVertices = trunk ? trunk.positions.length / 3 : 0;
    for (let v = 0; v < trunkVertices; v++) out.push(...packForestClusterVertex({ position: [...trunk.positions.subarray(v * 3, v * 3 + 3)], normal: trunk.normals.slice(v * 3, v * 3 + 3), uv: octahedral(trunk.normals.slice(v * 3, v * 3 + 3)), colour: trunk.looks[v].colour.map((c) => Math.min(1, c)), material: 1, shade: trunk.looks[v].shade, canopy: trunk.looks[v].canopy }, quant));
    const trunkIndices = trunk ? trunk.indices.length : 0;
    levels.push({ firstIndex: indexWords.length, indexCount: reduced.indices.length + trunkIndices, errorMetres: +Math.hypot(cell * 1.5, error).toFixed(4), triangles: (reduced.indices.length + trunkIndices) / 3, vertices: count + trunkVertices, trunkTriangles: trunkIndices / 3, grown: +grow.toFixed(3), outlineShare: +(outlined(reduced) / wantedArea).toFixed(4) });
    for (const v of reduced.indices) indexWords.push(vertexCount + v);
    if (trunk) for (const v of trunk.indices) indexWords.push(vertexCount + count + v);
    vertexWords.push(Uint32Array.from(out));
    vertexCount += count + trunkVertices;
    if (previewDir) previews.push(outline(reduced, VIEWS[13], frames[13]));
    if (levelId) levels[levelId].errorMetres = Math.max(levels[levelId].errorMetres, +(levels[levelId - 1].errorMetres * 1.6).toFixed(4));
  }
  if (previewDir) {
    const frame = frames[13], cover = wanted[13].through;
    writePreview(`${p.id}-${p.species}${p.cohort ? '-' + p.cohort : ''}.png`, [
      { width: frame.width * 2, height: frame.height * 2, value: (x, y) => 1 - cover[(y >> 1) * frame.width + (x >> 1)] },
      ...previews.map((o) => ({ width: o.width, height: o.height, value: (x, y) => o.mask[y * o.width + x] })),
    ]);
  }
  const material = foliage[0];
  prototypes.push({
    id: p.id, species: p.species, ...(p.cohort ? { cohort: p.cohort } : {}), firstVertex, vertexCount: vertexCount - firstVertex, low, posScale, levels,
    // A tree wears its crown from where its leaves are drawn this coarse (forestClusterSelect).
    leafErrorMetres: +CHANGE_ERROR_METRES.toFixed(4), leaves: samples.cards,
    // How broad the tree's shape is, as the side of a square of its mean outline: on open ground a broad
    // tree keeps its leaves to a longer range (OPEN_GROWN).
    breadthMetres: +Math.sqrt(wantedArea / VIEWS.length).toFixed(3),
    // What the crown's shader needs of the leaves it stands for: how alike the cards seen at one place
    // face, how much light passes through one, and what turning one over does to its colour.
    look: {
      alike: +Math.max(0.05, alike).toFixed(4), transmission: material.transmission, roughness: material.roughness,
      undersideGain: foliageMean.map((c, k) => +(1 + material.underside * (linear(material.undersideReference[k]) / Math.max(c, 1e-3) - 1)).toFixed(4)),
    },
    stats: { undersideSeenLevel: +(wanted.slice(12, 24).reduce((sum, w) => sum + w.underside, 0) / 12).toFixed(3), undersideSeenAbove: +(wanted.slice(36, 48).reduce((sum, w) => sum + w.underside, 0) / 12).toFixed(3), cellMetres: +step.toFixed(4), level: +fine.level.toPrecision(4), fineTriangles: fine.mesh.indices.length / 3, leafAreaSquareMetres: +samples.leafArea.toFixed(1), meanOutlineSquareMetres: +(wantedArea / VIEWS.length).toFixed(2), leavesCoverShare: +(coveredArea / wantedArea).toFixed(3), cardsCoverShareAtChange: +ownShare.toFixed(3), ms: Date.now() - started },
  });
  console.log(' '.repeat(20), `leaves show exposure ${(shown[3] / shownCover).toFixed(3)} colour ${[0, 1, 2].map((c) => (shown[c] / shownCover).toFixed(3))}; crown has ${given[3].toFixed(3)} and ${[0, 1, 2].map((c) => given[c].toFixed(3))}; ${unseen} of ${cut[0].count} vertices no view saw; whole tree ${fallback[3].toFixed(3)}`);
  console.log(`${p.species}${p.cohort ? ' ' + p.cohort : ''}`.padEnd(20), `${samples.cards} leaves covering ${(coveredArea / wantedArea * 100).toFixed(0)}% of their shape, ${changing.cards} cards ${(ownShare * 100).toFixed(0)}% at the change · alike ${alike.toFixed(2)} · cell ${step.toFixed(2)} m · fine ${fine.mesh.indices.length / 3} tris ·`, levels.map((l) => `${l.triangles} tris (${l.trunkTriangles} trunk) ±${l.errorMetres.toFixed(2)} m, grown ${l.grown}, outline ${(l.outlineShare * 100).toFixed(0)}%`).join(' · '), `· ${Date.now() - started} ms`);
}

const vertexBytes = Buffer.concat(vertexWords.map((w) => Buffer.from(w.buffer, w.byteOffset, w.byteLength)));
const outputs = { 'vertices.bin': vertexBytes, 'indices.bin': Buffer.from(Uint32Array.from(indexWords).buffer) };
const outDir = path.join(dir, 'crowns');
fs.mkdirSync(outDir, { recursive: true });
const files = {};
for (const [name, bytes] of Object.entries(outputs)) {
  const gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(outDir, `${name}.gz`), gz);
  files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), gzip: { file: `${name}.gz`, bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex') } };
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ format: 'waterworld.forest-crowns', version: 1, vertexWords: FOREST_CLUSTER_VERTEX_WORDS, levels: FOREST_CROWN_LEVELS, vertexCount, indexCount: indexWords.length, ...(OPEN_GROWN[packName] ? { widestLeafErrors: OPEN_GROWN[packName] } : {}), files, prototypes }, null, 1));
console.log('total', vertexCount, 'vertices,', indexWords.length / 3, 'triangles,', Object.values(files).reduce((sum, f) => sum + f.gzip.bytes, 0), 'bytes gzipped');
