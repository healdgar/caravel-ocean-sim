#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes a pack's grove: a closed stand of its trees, mixed as a wood of them is, as the canopy a viewer
// outside it sees. js/forest-groves.js lays that canopy over every piece of ground a coast marks as forest,
// so a wood is closed however far it runs and however few of its trees are planted one by one.
//   node scripts/prepare-forest-groves.mjs portugal [--preview=folder]
// The grove is one square of ground that repeats. Its trees stand as a seeded wood's do, the tall ones
// first and the rest filling between them, and their leaves (every one, as scripts/forest-leaf-field.mjs
// reads them) are added into one field. Where that field is as dense as each tree's own far crown is
// (scripts/prepare-forest-crowns.mjs; bake the crowns first), the wood is solid: the top of the solid is
// the canopy, kept as a height over each square metre with the colour, exposure and facing of the leaves
// seen there and the tree that owns it. Coarser copies of the same map, each half as fine, are the tiers a
// far wood is drawn at; the coarsest is a few lumps to the grove.
// Several groves are baked. Trees whose crowns reach a grove's edge are the same in all of them, so any
// grove stands beside any other with no seam, and what differs is the wood inside.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { FOREST_GROVE_LEVELS, FOREST_GROVE_MAPS, FOREST_GROVE_TEXELS, FOREST_GROVE_TREE_FLOATS, FOREST_GROVE_VARIANTS } from '../js/forest-groves.js';
import { CROWN_FINE_CELLS, normalize, octahedral, openForestLeaves, seenFrom, solidOf } from './forest-leaf-field.mjs';

const args = process.argv.slice(2);
const packName = args.find((a) => !a.startsWith('--')) ?? 'portugal';
const previewDir = args.find((a) => a.startsWith('--preview='))?.slice(10);
const dir = path.join('assets/forest-scenery', packName);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const crowns = JSON.parse(fs.readFileSync(path.join(dir, 'crowns/manifest.json'), 'utf8'));
const { leafSamples } = openForestLeaves(dir);

// The stand each pack grows. Scales are the ones retargetForestPackToProcedural (js/terrain.js) gives a
// tree well inland: about its own size where the pack's manifest says its trees are full grown, and the
// enlargement a pack of young trees is drawn at where it does not. The tall trees stand apart from each
// other by `apart` times the sum of their crown radii; the rest stand FILL_APART from each other and
// TALL_APART from a tall one.
const fullGrown = manifest.stature === 'full-grown';
const STANDS = {
  portugal: {
    tileMetres: 128,
    // Full-grown trees by a harbour are planted at this share of their size inland, and the canopy stands as
    // much lower there (js/forest-groves.js). A stand that names none keeps that module's own share.
    harbourHeight: fullGrown ? 0.94 : undefined,
    tall: { cohort: 'veteran', mix: { oak: 0.3, chestnut: 0.2, maple: 0.18, elm: 0.17, birch: 0.15 }, scale: () => (fullGrown ? [1.0, 1.2] : [2.5, 3.19]), apart: 1.05 },
    fill: { cohort: 'canopy', mix: { oak: 0.3, chestnut: 0.2, maple: 0.18, elm: 0.17, birch: 0.15 }, scale: () => (fullGrown ? [0.94, 1.14] : [2.0, 2.64]) },
  },
  // A ceiba's crown is sixty metres across, so its grove is twice the size and its map half as fine.
  subtropical: {
    tileMetres: 256,
    tall: { mix: { ceiba: 1 }, scale: () => [2.1, 2.76], apart: 0.85 },
    fill: { mix: { ceiba: 0.2, royal_palm: 0.48, palm: 0.32 }, scale: (species) => (species === 'ceiba' ? [1.3, 1.9] : [1.22, 1.54]) },
  },
};
const FILL_APART = 0.6, TALL_APART = 0.8;
const stand = STANDS[packName];
if (!stand) throw Error(`No stand is named for ${packName}`);
const TILE = stand.tileMetres, CELL = TILE / FOREST_GROVE_TEXELS;
// A tree whose crown comes within this of the grove's edge is one of the trees every grove shares.
const SHARED_MARGIN = 4 * CELL;
// Cells of the next grove round kept on each side while the canopy is found, so that it closes over the edge.
const PAD = 8;
// Leaves are read as points this far apart, before the tree is scaled.
const SAMPLE_METRES = 0.35;
// Gaps narrower than this between crowns are closed, and a tree owns the canopy this far past its crown.
const CLOSE_CELLS = 3, OWN_CELLS = 3;
// A crown darkens where its neighbours stand between it and the sky: the sky is looked for this far round.
const HORIZON_METRES = 14, HORIZON_EXPOSURE = 0.5, HORIZON_ESCAPE = 0.6;
// What shows between a tree's cards stands in shade about as often as in the sun (scripts/prepare-forest-crowns.mjs).
const BACKDROP_SHADE = 0.5;
// A wood seen from outside is lumps, not leaves: each crown a rounded mass, and the hollows between crowns
// closed over. Hollows narrower than twice FILL_METRES are filled, and each height is then spread over
// ROUND_METRES, so no crown stands as a cliff beside the next. A tree that stands above the wood keeps
// EMERGENT of its rise over the grove's middle height: seen from outside, a wood's roof is nearly level,
// and a tall tree is a swell in it, not a tower. Within AGREE_CELLS of a grove's edge the heights are
// drawn to the first grove's, so that every grove meets every other at the same height.
const FILL_METRES = 3, ROUND_METRES = 2.4, EMERGENT = 0.55, AGREE_CELLS = 6;

function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Every tree the stand may hold: its leaves as points, how far its crown reaches, and what its far crown says of it.
const POINT = 13;
const kinds = manifest.prototypes.map((p) => {
  const crown = crowns.prototypes.find((q) => q.id === p.id);
  if (!crown) throw Error(`No far crown for ${p.species}: bake the crowns first`);
  const samples = leafSamples(p, () => SAMPLE_METRES), n = samples.points.length, points = new Float32Array(n * POINT);
  const mean = [0, 0, 0, 0, 0, 0, 0, 0], reach = new Float32Array(n), order = new Uint32Array(n);
  let seen = 0;
  samples.points.forEach((s, i) => {
    points.set([...s.at, s.area * s.opacity, s.seen, ...s.colour, s.shade, s.canopy, ...s.lean], i * POINT);
    for (let k = 0; k < 3; k++) { mean[k] += s.seen * s.colour[k]; mean[5 + k] += s.seen * s.lean[k]; }
    mean[3] += s.seen * s.shade; mean[4] += s.seen * s.canopy; seen += s.seen;
    reach[i] = Math.hypot(s.at[0], s.at[2]); order[i] = i;
  });
  // The crown's radius: nine tenths of what is seen of the leaves stands inside it.
  order.sort((a, b) => reach[a] - reach[b]);
  let within = 0, radius = 0;
  for (const i of order) { within += samples.points[i].seen; radius = reach[i]; if (within >= seen * 0.9) break; }
  return {
    p, crown, points, count: n, radius, furthest: reach[order[n - 1]], height: samples.high[1], look: mean.map((v) => v / Math.max(seen, 1e-9)),
    // What one square metre of this tree's leaves adds to the field, where the field reads 1 at its far crown's surface.
    level: crown.stats.cellMetres * CROWN_FINE_CELLS / crown.stats.level,
    coverShare: crown.stats.leavesCoverShare, ownShare: crown.stats.cardsCoverShareAtChange,
  };
});
// The colour most of the pack's trees show, as the crowns have it: what stands behind a thin tree's cards.
const packColour = [0, 1, 2].map((k) => { const sorted = kinds.map((q) => q.look[k]).sort((a, b) => a - b), half = sorted.length >> 1; return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2; });

const edgeDistance = (x, z) => Math.min(x, TILE - x, z, TILE - z);
const wrapped = (d) => d - TILE * Math.round(d / TILE);
const choose = (group, random) => {
  const named = kinds.filter((q) => group.mix[q.p.species] > 0 && (!group.cohort || q.p.cohort === group.cohort));
  if (!named.length) throw Error(`The stand names no tree the pack has: ${Object.keys(group.mix)}`);
  const total = named.reduce((sum, q) => sum + group.mix[q.p.species], 0);
  let u = random() * total;
  for (const q of named) { u -= group.mix[q.p.species]; if (u <= 0) return q; }
  return named[named.length - 1];
};
// Trees are tried at random places until none more will fit. A tree keeps the place it is given only if
// it is of the wanted kind there: shared, or not.
// Full-grown crowns run from three metres across to thirty, and kinds tried at random until none fits
// would fill every gap between the oaks with birch. A stand of full-grown trees keeps to its mix by count
// instead: the kind furthest behind its share goes in next, and planting ends when that kind finds no place.
// A hollow is then left wherever no crown comes within FILL_METRES, too broad for the canopy to close over
// by itself. plantBare stands whichever kind fits in each, which is mostly birch, as in the gaps of a grown wood.
function plantBare(trees, group, shared, random) {
  for (let misses = 0, tries = 0; misses < 4000 && tries < 4e6; tries++) {
    const x = random() * TILE, z = random() * TILE;
    if (trees.some((t) => Math.hypot(wrapped(t.x - x), wrapped(t.z - z)) < t.radius + FILL_METRES)) continue;
    const kind = choose(group, random), [low, high] = group.scale(kind.p.species);
    const scale = low + random() * (high - low), radius = kind.radius * scale, yaw = random() * Math.PI * 2;
    if ((edgeDistance(x, z) < radius + SHARED_MARGIN) !== shared) continue;
    const clear = trees.every((t) => Math.hypot(wrapped(t.x - x), wrapped(t.z - z)) >= (t.tall ? TALL_APART : FILL_APART) * (radius + t.radius));
    if (clear) { trees.push({ x, z, yaw, scale, radius, kind, tall: false, shared }); misses = 0; } else misses++;
  }
}
function plant(trees, group, tall, shared, random) {
  const behind = () => {
    const named = kinds.filter((q) => group.mix[q.p.species] > 0 && (!group.cohort || q.p.cohort === group.cohort));
    if (!named.length) throw Error(`The stand names no tree the pack has: ${Object.keys(group.mix)}`);
    const standing = (q) => trees.filter((t) => t.tall === tall && t.kind === q).length / group.mix[q.p.species];
    return named.reduce((least, q) => (standing(q) < standing(least) ? q : least));
  };
  let next = fullGrown ? behind() : null;
  for (let misses = 0; misses < 4000;) {
    const x = random() * TILE, z = random() * TILE, kind = next ?? choose(group, random), [low, high] = group.scale(kind.p.species);
    const scale = low + random() * (high - low), radius = kind.radius * scale, yaw = random() * Math.PI * 2;
    if ((edgeDistance(x, z) < radius + SHARED_MARGIN) !== shared) continue;
    const clear = trees.every((t) => Math.hypot(wrapped(t.x - x), wrapped(t.z - z)) >= (tall && t.tall ? group.apart : tall || t.tall ? TALL_APART : FILL_APART) * (radius + t.radius));
    if (clear) { trees.push({ x, z, yaw, scale, radius, kind, tall, shared }); misses = 0; if (next) next = behind(); } else misses++;
  }
  if (fullGrown && !tall) plantBare(trees, group, shared, random);
}
const random = seeded(packName === 'portugal' ? 0x9e3779b1 : 0x85ebca6b);
const sharedTrees = [];
plant(sharedTrees, stand.tall, true, true, random);
plant(sharedTrees, stand.fill, false, true, random);
const groves = Array.from({ length: FOREST_GROVE_VARIANTS }, () => {
  const trees = [...sharedTrees];
  plant(trees, stand.tall, true, false, random);
  plant(trees, stand.fill, false, false, random);
  return trees;
});
const maxTrees = Math.max(...groves.map((g) => g.length)) + 1;
if (maxTrees > 4095) throw Error('A grove holds more trees than its map can name');
const tallest = Math.max(...groves.flat().map((t) => t.kind.height * t.scale));

// The canopy of one grove.
const texels = FOREST_GROVE_TEXELS, wide = texels + PAD * 2, layers = Math.ceil((tallest + 3) / CELL) + 3, cells = wide * layers * wide;
const origin = [-PAD * CELL, -CELL, -PAD * CELL];
// The canopy's heights as a far viewer has them: hollows filled, then each height spread over its neighbours.
// The grove repeats, so both read round its edges.
function rounded(height) {
  const n = FOREST_GROVE_TEXELS, at = (x, z) => ((z + n) % n) * n + (x + n) % n;
  const reach = Math.max(1, Math.round(FILL_METRES / CELL)), disc = [];
  for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) if (dx * dx + dz * dz <= reach * reach + 0.5) disc.push([dx, dz]);
  const over = (from, pick) => Float32Array.from(from, (v, i) => { const x = i % n, z = (i / n) | 0; for (const [dx, dz] of disc) v = pick(v, from[at(x + dx, z + dz)]); return v; });
  let next = over(over(height, Math.max), Math.min);
  const sigma = ROUND_METRES / CELL, span = Math.ceil(sigma * 3), weights = Array.from({ length: span * 2 + 1 }, (_, k) => Math.exp(-((k - span) ** 2) / (2 * sigma * sigma)));
  const total = weights.reduce((sum, w) => sum + w, 0);
  for (const [dx, dz] of [[1, 0], [0, 1]]) next = Float32Array.from(next, (_, i) => { const x = i % n, z = (i / n) | 0; let sum = 0; for (let k = -span; k <= span; k++) sum += weights[k + span] * next[at(x + dx * k, z + dz * k)]; return sum / total; });
  const middle = Float32Array.from(next).sort()[next.length >> 1];
  return next.map((h) => (h > middle ? middle + (h - middle) * EMERGENT : h));
}
function canopy(trees, reference) {
  const field = new Float32Array(cells), weight = new Float32Array(cells), seen = new Float32Array(cells), colour = new Float32Array(cells * 3), shade = new Float32Array(cells), shadeCanopy = new Float32Array(cells), lean = new Float32Array(cells * 3);
  for (const t of trees) {
    const { points, count, level } = t.kind, c = Math.cos(t.yaw), s = t.scale * Math.sin(t.yaw), cs = t.scale * c, area = t.scale * t.scale, add = area * t.scale * level / (CELL * CELL * CELL), far = t.kind.furthest * t.scale + CELL;
    // The grove repeats: a tree near an edge also stands just past the far one.
    for (const dx of [-TILE, 0, TILE]) for (const dz of [-TILE, 0, TILE]) {
      const ox = t.x + dx, oz = t.z + dz;
      if (ox + far < origin[0] || ox - far > origin[0] + wide * CELL || oz + far < origin[2] || oz - far > origin[2] + wide * CELL) continue;
      for (let i = 0; i < count; i++) {
        const at = i * POINT, px = points[at], pz = points[at + 2];
        const x = Math.floor((ox + cs * px - s * pz - origin[0]) / CELL), y = Math.floor((points[at + 1] * t.scale - origin[1]) / CELL), z = Math.floor((oz + s * px + cs * pz - origin[2]) / CELL);
        if (x < 0 || y < 0 || z < 0 || x >= wide || y >= layers || z >= wide) continue;
        const cell = (z * layers + y) * wide + x, show = points[at + 4] * area;
        field[cell] += points[at + 3] * add; weight[cell] += points[at + 3] * area; seen[cell] += show;
        colour[cell * 3] += show * points[at + 5]; colour[cell * 3 + 1] += show * points[at + 6]; colour[cell * 3 + 2] += show * points[at + 7];
        shade[cell] += show * points[at + 8]; shadeCanopy[cell] += show * points[at + 9];
        const lx = points[at + 10], lz = points[at + 12];
        lean[cell * 3] += show * (c * lx - Math.sin(t.yaw) * lz); lean[cell * 3 + 1] += show * points[at + 11]; lean[cell * 3 + 2] += show * (Math.sin(t.yaw) * lx + c * lz);
      }
    }
  }
  // One pass of 1 2 1 along each axis, as a single tree's field has (leafField).
  const smooth = field, strides = [1, wide, wide * layers], sizes = [wide, layers, wide];
  for (let axis = 0; axis < 3; axis++) {
    const from = Float32Array.from(smooth), stride = strides[axis];
    for (let z = 0; z < wide; z++) for (let y = 0; y < layers; y++) for (let x = 0; x < wide; x++) {
      const i = (z * layers + y) * wide + x, at = [x, y, z][axis];
      smooth[i] = (2 * from[i] + (at > 0 ? from[i - stride] : 0) + (at < sizes[axis] - 1 ? from[i + stride] : 0)) / 4;
    }
  }
  const density = Float32Array.from(weight, (v) => v / (CELL * CELL));
  const size = [wide, layers, wide], solid = solidOf({ size, smooth, step: CELL }, 1, { closeMetres: CLOSE_CELLS * CELL, smallest: 8 });
  if (!solid) throw Error('The grove grew no canopy');
  const leaves = { step: CELL, density, seen, colour, shade, shadeCanopy, lean, at: (q) => { const x = Math.floor((q[0] - origin[0]) / CELL), y = Math.floor((q[1] - origin[1]) / CELL), z = Math.floor((q[2] - origin[2]) / CELL); return x < 0 || y < 0 || z < 0 || x >= wide || y >= layers || z >= wide ? -1 : (z * layers + y) * wide + x; } };

  // The canopy's height over each texel: the top of what is solid there. All beneath it counts as solid,
  // since nothing beneath a closed canopy is seen from outside the wood.
  const count = texels * texels, height = new Float32Array(count), owner = new Uint16Array(count);
  for (let z = 0; z < texels; z++) for (let x = 0; x < texels; x++) for (let y = layers - 2; y >= 0; y--) {
    const here = solid[((z + PAD) * layers + y) * wide + x + PAD];
    if (here < 0) continue;
    const above = solid[((z + PAD) * layers + y + 1) * wide + x + PAD];
    height[z * texels + x] = Math.max(0, origin[1] + (y + 0.5 + here / (here - Math.min(above, -1e-6))) * CELL);
    break;
  }
  // The tree that owns each texel: the one whose crown it is deepest in. At the grove's edge only a shared
  // tree may own, so that the next grove names the same one.
  for (let z = 0; z < texels; z++) for (let x = 0; x < texels; x++) {
    const i = z * texels + x;
    const px = (x + 0.5) * CELL, pz = (z + 0.5) * CELL, edge = edgeDistance(px, pz) < 1.5 * CELL;
    let best = Infinity, loose = Infinity, looseId = 0;
    trees.forEach((t, id) => {
      if (edge && !t.shared) return;
      const d = Math.hypot(wrapped(t.x - px), wrapped(t.z - pz)), depth = d / t.radius;
      if (d <= t.radius + OWN_CELLS * CELL && depth < best) { best = depth; owner[i] = id + 1; }
      if (depth < loose) { loose = depth; looseId = id + 1; }
    });
    if (!owner[i]) owner[i] = looseId;
  }
  const at = (x, z) => ((z + texels) % texels) * texels + (x + texels) % texels;
  // The leaves are looked for where they are; the canopy stands where its rounding puts it.
  const top = rounded(height);
  if (reference) for (let z = 0; z < texels; z++) for (let x = 0; x < texels; x++) {
    const d = Math.min(x, texels - x, z, texels - z) / AGREE_CELLS, own = d >= 1 ? 1 : d * d * (3 - 2 * d), i = z * texels + x;
    top[i] = reference[i] + (top[i] - reference[i]) * own;
  }
  const slope = (heights, n, x, z, cell) => { const get = (a, b) => heights[((b + n) % n) * n + (a + n) % n]; return normalize([-(get(x + 1, z) - get(x - 1, z)) / (2 * cell), 1, -(get(x, z + 1) - get(x, z - 1)) / (2 * cell)]); };
  // How much of the sky a texel sees past its neighbours, looking eight ways.
  const reachCells = Math.max(2, Math.round(HORIZON_METRES / CELL)), sky = new Float32Array(count);
  for (let z = 0; z < texels; z++) for (let x = 0; x < texels; x++) {
    let open = 0;
    for (let k = 0; k < 8; k++) {
      const dx = Math.round(Math.cos(k * Math.PI / 4)), dz = Math.round(Math.sin(k * Math.PI / 4)), stride = Math.hypot(dx, dz) * CELL;
      let rise = 0;
      for (let step = 1; step <= reachCells; step++) rise = Math.max(rise, (top[at(x + dx * step, z + dz * step)] - top[z * texels + x]) / (step * stride));
      open += 1 - rise / Math.hypot(rise, 1);
    }
    sky[z * texels + x] = open / 8;
  }
  const look = new Float32Array(count * 8), facing = new Float32Array(count * 3);
  let alike = 0, standing = 0;
  for (let z = 0; z < texels; z++) for (let x = 0; x < texels; x++) {
    const i = z * texels + x;
    if (!owner[i]) continue;
    const kind = trees[owner[i] - 1].kind;
    const found = seenFrom(leaves, [(x + 0.5) * CELL, height[i], (z + 0.5) * CELL], slope(height, texels, x, z, CELL), kind.look);
    // A tree shows the dark inside of itself between its leaves, and at range the wood behind between its
    // cards: the same mixing its far crown is given, so a grove and the trees planted in it are one colour.
    for (let k = 0; k < 3; k++) look[i * 8 + k] = kind.coverShare * (kind.ownShare * found[k] + (1 - kind.ownShare) * BACKDROP_SHADE * packColour[k]);
    look[i * 8 + 3] = found[3] * (1 - HORIZON_EXPOSURE * (1 - sky[i])); look[i * 8 + 4] = found[4] * (1 - HORIZON_ESCAPE * (1 - sky[i]));
    for (let k = 0; k < 3; k++) look[i * 8 + 5 + k] = found[5 + k];
    alike += Math.min(1, Math.hypot(found[5], found[6], found[7])); if (height[i] > 0) standing++;
    facing.set(slope(top, texels, x, z, CELL), i * 3);
  }
  return { height: top, owner, look, facing, alike: alike / count, standing: standing / count, slope };
}

// The same canopy half as fine: each texel the mean of the four under it, owned by the tree that stands
// tallest among them, and facing as its own heights slope.
function coarser(level, n, cell, slope) {
  const half = n / 2, count = half * half, next = { height: new Float32Array(count), owner: new Uint16Array(count), look: new Float32Array(count * 8), facing: new Float32Array(count * 3) };
  for (let z = 0; z < half; z++) for (let x = 0; x < half; x++) {
    const i = z * half + x;
    let top = -1, weight = 0;
    for (const from of [z * 2 * n + x * 2, z * 2 * n + x * 2 + 1, (z * 2 + 1) * n + x * 2, (z * 2 + 1) * n + x * 2 + 1]) {
      next.height[i] += level.height[from] / 4;
      if (!level.owner[from]) continue;
      if (level.height[from] > top) { top = level.height[from]; next.owner[i] = level.owner[from]; }
      for (let k = 0; k < 8; k++) next.look[i * 8 + k] += level.look[from * 8 + k];
      weight++;
    }
    for (let k = 0; k < 8; k++) next.look[i * 8 + k] /= Math.max(weight, 1);
  }
  for (let z = 0; z < half; z++) for (let x = 0; x < half; x++) next.facing.set(slope(next.height, half, x, z, cell * 2), (z * half + x) * 3);
  return next;
}

// The three maps of one level: where the canopy is and whose, what colour it shows, and which way it faces.
const byte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
function pack(level, n) {
  const maps = Array.from({ length: FOREST_GROVE_MAPS }, () => new Uint8Array(n * n * 4));
  for (let i = 0; i < n * n; i++) {
    const h = Math.max(0, Math.min(4095, Math.round(level.height[i] / heightMetres * 4095))), o = level.owner[i], l = level.look.subarray(i * 8, i * 8 + 8);
    maps[0].set([h >> 4, ((h & 15) << 4) | (o >> 8), o & 255, byte(l[4])], i * 4);
    maps[1].set([byte(Math.sqrt(l[0])), byte(Math.sqrt(l[1])), byte(Math.sqrt(l[2])), byte(l[3])], i * 4);
    const lean = Math.hypot(l[5], l[6], l[7]) > 1e-3 ? normalize([l[5], l[6], l[7]]) : [0, 1, 0], [u, v] = octahedral(lean);
    maps[2].set([byte(u), byte(v), byte(level.facing[i * 3] * 0.5 + 0.5), byte(level.facing[i * 3 + 2] * 0.5 + 0.5)], i * 4);
  }
  return maps;
}

function writePicture(name, width, height, rgb) {
  const raw = path.join(os.tmpdir(), `forest-grove-preview-${process.pid}.bin`);
  fs.writeFileSync(raw, rgb);
  execFileSync('python3', ['-c', 'import sys;from PIL import Image;Image.frombytes("RGB",(int(sys.argv[2]),int(sys.argv[3])),open(sys.argv[1],"rb").read()).save(sys.argv[4])', raw, String(width), String(height), path.join(previewDir, name)]);
  fs.rmSync(raw);
}

const heightMetres = Math.ceil(tallest + 2);
if (previewDir) fs.mkdirSync(previewDir, { recursive: true });
const mapBytes = [], treeFloats = new Float32Array(FOREST_GROVE_VARIANTS * maxTrees * FOREST_GROVE_TREE_FLOATS), stats = [];
let alike = 0, reference = null;
for (const [variant, trees] of groves.entries()) {
  const started = Date.now(), fine = canopy(trees, reference), levels = [fine];
  reference ??= fine.height;
  for (let k = 1, n = texels, cell = CELL; k < FOREST_GROVE_LEVELS; k++, n /= 2, cell *= 2) levels.push(coarser(levels[k - 1], n, cell, fine.slope));
  const packed = levels.map((level, k) => pack(level, texels >> k));
  // One grove's bytes: each map in turn, and within a map each level from the finest.
  for (let map = 0; map < FOREST_GROVE_MAPS; map++) for (const maps of packed) mapBytes.push(maps[map]);
  // A tree's place is its number in the map, so the first place is left empty: no tree owns a gap.
  trees.forEach((t, id) => treeFloats.set([t.x, t.z, t.yaw, t.scale, t.kind.p.id, t.radius, t.kind.height * t.scale, t.shared ? 1 : 0], (variant * maxTrees + id + 1) * FOREST_GROVE_TREE_FLOATS));
  alike += fine.alike / FOREST_GROVE_VARIANTS;
  let mean = 0, highest = 0;
  for (const h of fine.height) { mean += h / fine.height.length; highest = Math.max(highest, h); }
  stats.push({ trees: trees.length, tall: trees.filter((t) => t.tall).length, shared: trees.filter((t) => t.shared).length, standingShare: +fine.standing.toFixed(4), meanHeightMetres: +mean.toFixed(2), highestMetres: +highest.toFixed(2) });
  console.log(`grove ${variant}: ${trees.length} trees (${stats[variant].tall} tall, ${stats[variant].shared} shared), canopy over ${(fine.standing * 100).toFixed(1)}% of the ground, ${mean.toFixed(1)} m high on average and ${highest.toFixed(1)} m at most · ${Date.now() - started} ms`);
  if (previewDir) {
    // Seen from above with the sun low in the west: three by three of the same grove, to show the seams.
    const side = texels * 3, picture = new Uint8Array(side * side * 3), sun = normalize([-0.6, 0.55, -0.35]);
    for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
      const i = (z % texels) * texels + x % texels, n = [fine.facing[i * 3], fine.facing[i * 3 + 1], fine.facing[i * 3 + 2]];
      const lit = (0.25 + 0.75 * Math.max(0, n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2])) * (0.3 + 0.7 * fine.look[i * 8 + 3]) * 3.2;
      for (let k = 0; k < 3; k++) picture[(z * side + x) * 3 + k] = byte(Math.sqrt(Math.min(1, fine.look[i * 8 + k] * lit)));
    }
    writePicture(`${packName}-grove-${variant}.png`, side, side, picture);
    const heights = new Uint8Array(texels * texels * 3);
    for (let i = 0; i < texels * texels; i++) heights.fill(byte(fine.height[i] / heightMetres), i * 3, i * 3 + 3);
    writePicture(`${packName}-grove-${variant}-height.png`, texels, texels, heights);
  }
}

// How the grove's leaves take light: the mean of its trees', each counted by the ground its crown covers.
const optics = [0, 0, 0, 0, 0];
let ground = 0;
for (const t of groves.flat()) {
  const share = t.radius * t.radius, look = t.kind.crown.look;
  optics[0] += share * look.transmission; optics[1] += share * look.roughness;
  for (let k = 0; k < 3; k++) optics[2 + k] += share * look.undersideGain[k];
  ground += share;
}
const outputs = { 'maps.bin': Buffer.concat(mapBytes.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength))), 'trees.bin': Buffer.from(treeFloats.buffer) };
const outDir = path.join(dir, 'groves');
fs.mkdirSync(outDir, { recursive: true });
const files = {};
for (const [name, bytes] of Object.entries(outputs)) {
  const gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(outDir, `${name}.gz`), gz);
  files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), gzip: { file: `${name}.gz`, bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex') } };
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
  format: 'waterworld.forest-groves', version: 1, tileMetres: TILE, texels, levels: FOREST_GROVE_LEVELS, variants: FOREST_GROVE_VARIANTS, maps: FOREST_GROVE_MAPS,
  heightMetres, maxTrees, treeFloats: FOREST_GROVE_TREE_FLOATS, ...(stand.harbourHeight ? { harbourHeight: stand.harbourHeight } : {}),
  look: { alike: +Math.max(0.05, alike).toFixed(4), transmission: +(optics[0] / ground).toFixed(4), roughness: +(optics[1] / ground).toFixed(4), undersideGain: optics.slice(2).map((v) => +(v / ground).toFixed(4)) },
  files, groves: stats,
}, null, 1));
console.log('total', Object.values(files).reduce((sum, f) => sum + f.gzip.bytes, 0), 'bytes gzipped;', maxTrees - 1, 'trees at most in a grove;', heightMetres, 'm is the tallest a canopy may stand');
