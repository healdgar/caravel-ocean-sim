#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes a pack's grove: one square of closed wood that repeats, as where each of its trees stands, its turn,
// scale and kind. js/forest-groves.js lays it over every piece of ground a coast marks as forest, and
// js/terrain.js plants each of its trees there as a root of the forest pack, drawn, struck and swayed as any.
//   node scripts/prepare-forest-stands.mjs portugal
// The trees stand as a seeded wood's do, the tall ones first and the rest filling between them, each kept
// apart from the others by its crown: how far nine tenths of its leaves reach (scripts/forest-leaf-field.mjs).
// Several groves are baked. Trees whose crowns reach a grove's edge are the same in all of them, so any
// grove stands beside any other with no seam, and what differs is the wood inside.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FOREST_GROVE_TREE_FLOATS, FOREST_GROVE_VARIANTS } from '../js/forest-groves.js';
import { openForestLeaves } from './forest-leaf-field.mjs';

const args = process.argv.slice(2);
const packName = args.find((a) => !a.startsWith('--')) ?? 'portugal';
const dir = path.join('assets/forest-scenery', packName);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
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
    // Full-grown trees by a harbour are planted at this share of their size inland, and a grove's are as much
    // smaller there (js/forest-groves.js). A stand that names none keeps that module's own share.
    harbourHeight: fullGrown ? 0.94 : undefined,
    // Closed copses & groves draw from the competitive intermixed stand-grown (`canopy`) cohort where neighboring
    // species competed for light & soil, while open-grown `veteran` specimens stand alone in parks/squares/roadsides.
    tall: { cohort: 'canopy', mix: { oak: 0.3, chestnut: 0.22, maple: 0.18, elm: 0.18, birch: 0.12 }, scale: () => (fullGrown ? [1.06, 1.24] : [2.5, 3.19]), apart: 1.25 },
    fill: { cohort: 'canopy', mix: { oak: 0.24, chestnut: 0.18, maple: 0.20, elm: 0.16, birch: 0.22 }, scale: () => (fullGrown ? [0.88, 1.08] : [2.0, 2.64]) },
  },
  // A hard-winter coast's wood: balsam fir and tamarack under a scatter of maple, oak and birch, as the
  // Acadian forest stood; the gaps between them go to birch and tamarack, the pioneers of cleared ground.
  northern: {
    tileMetres: 128,
    harbourHeight: fullGrown ? 0.94 : undefined,
    tall: { cohort: 'canopy', mix: { fir: 0.4, maple: 0.2, oak: 0.12, larch: 0.16, birch: 0.12 }, scale: () => (fullGrown ? [1.06, 1.24] : [2.5, 3.19]), apart: 1.25 },
    fill: { cohort: 'canopy', mix: { fir: 0.32, maple: 0.14, oak: 0.06, larch: 0.22, birch: 0.26 }, scale: () => (fullGrown ? [0.88, 1.08] : [2.0, 2.64]) },
  },
  // A ceiba's crown is sixty metres across, so its grove is twice the size.
  subtropical: {
    tileMetres: 256,
    tall: { mix: { ceiba: 1 }, scale: () => [2.1, 2.76], apart: 0.85 },
    fill: { mix: { ceiba: 0.2, royal_palm: 0.48, palm: 0.32 }, scale: (species) => (species === 'ceiba' ? [1.3, 1.9] : [1.22, 1.54]) },
  },
};
const FILL_APART = fullGrown ? 0.92 : 0.6, TALL_APART = fullGrown ? 1.02 : 0.8;
const stand = STANDS[packName];
if (!stand) throw Error(`No stand is named for ${packName}`);
// A grove is laid out on a grid of 128 squares a side: a tree whose crown comes within four of them of its
// edge is one of the trees every grove shares.
const TILE = stand.tileMetres, SHARED_MARGIN = 4 * TILE / 128;
// Leaves are read as points this far apart, before the tree is scaled.
const SAMPLE_METRES = 0.35;
// Hollows wider than twice this between full-grown crowns are planted with whichever kind fits.
const FILL_METRES = fullGrown ? 5 : 3;

function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Every tree the stand may hold: how far its crown reaches, and how tall it stands.
const kinds = manifest.prototypes.map((p) => {
  const samples = leafSamples(p, () => SAMPLE_METRES), n = samples.points.length;
  const reach = new Float32Array(n), order = new Uint32Array(n);
  let seen = 0;
  samples.points.forEach((s, i) => { seen += s.seen; reach[i] = Math.hypot(s.at[0], s.at[2]); order[i] = i; });
  // The crown's radius: nine tenths of what is seen of the leaves stands inside it.
  order.sort((a, b) => reach[a] - reach[b]);
  let within = 0, radius = 0;
  for (const i of order) { within += samples.points[i].seen; radius = reach[i]; if (within >= seen * 0.9) break; }
  return { p, radius, height: samples.high[1] };
});

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
// A hollow is then left wherever no crown comes within FILL_METRES. plantBare stands whichever kind fits in
// each, which is mostly birch, as in the gaps of a grown wood.
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
const random = seeded({ portugal: 0x9e3779b1, northern: 0xc2b2ae35 }[packName] ?? 0x85ebca6b);
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

// A tree's place is its number in the grove, and the first place is left empty.
const treeFloats = new Float32Array(FOREST_GROVE_VARIANTS * maxTrees * FOREST_GROVE_TREE_FLOATS), stats = [];
for (const [variant, trees] of groves.entries()) {
  trees.forEach((t, id) => treeFloats.set([t.x, t.z, t.yaw, t.scale, t.kind.p.id, t.radius, t.kind.height * t.scale, t.shared ? 1 : 0], (variant * maxTrees + id + 1) * FOREST_GROVE_TREE_FLOATS));
  stats.push({ trees: trees.length, tall: trees.filter((t) => t.tall).length, shared: trees.filter((t) => t.shared).length });
  console.log(`grove ${variant}: ${trees.length} trees (${stats[variant].tall} tall, ${stats[variant].shared} shared)`);
}
const bytes = Buffer.from(treeFloats.buffer), gz = zlib.gzipSync(bytes, { level: 9 });
const outDir = path.join(dir, 'groves');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'trees.bin.gz'), gz);
const sha = (b) => createHash('sha256').update(b).digest('hex');
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
  format: 'waterworld.forest-groves', version: 2, tileMetres: TILE, variants: FOREST_GROVE_VARIANTS, maxTrees, treeFloats: FOREST_GROVE_TREE_FLOATS,
  ...(stand.harbourHeight ? { harbourHeight: stand.harbourHeight } : {}),
  files: { 'trees.bin': { bytes: bytes.length, sha256: sha(bytes), gzip: { file: 'trees.bin.gz', bytes: gz.length, sha256: sha(gz) } } },
  groves: stats,
}, null, 1));
console.log(maxTrees - 1, 'trees at most in a grove; trees.bin', sha(bytes));
