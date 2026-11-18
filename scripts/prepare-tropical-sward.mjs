#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Grows the tropical meadow groves: seamless 4 m tiles of the native grasses of Caribbean coasts c. 1550, plant by
// plant at full resolution, in forestmodeler's meadow-groves format (gardenplans/meadow.py), so that
// scripts/prepare-meadow-grass.mjs bakes them into a meadow continuum exactly as it bakes the Portuguese groves.
// Kept out of git in assets/ground-cover/tropical/meadows/; the baked atlas is what ships.
//
// Three mixes, four variants each, as the Portuguese groves and in the same roles (js/meadow-continuum.js,
// MEADOW_MIX_ROLES: lowland, upland, margin):
//   - pasture: a close carpet-grass sward (Axonopus compressus) with sour paspalum and nut sedge;
//   - savanna: broomsedge bluestem tussocks (Andropogon bicornis) over sour paspalum and carpet grass;
//   - strand: seashore dropseed (Sporobolus virginicus) and seashore paspalum with sandbur on coastal sand.
// Every species is native to the tropical Americas; guinea and Bermuda grass came later with the slave trade.
//
// How the seam is closed (the groves' own contract): every plant rooted within the edge band (its species' greatest
// reach plus a margin) is the same in all four variants; the interior is sown afresh for each, and an interior plant
// that would reach an edge is dropped. A plant is never cut: one rooted by an edge overhangs into its neighbour.
//
// A leaf or culm is rows of three vertices across its midrib and a tip, so the bake widens it about its midrib; a
// spikelet is a small closed diamond the bake grows about its centre. Colours are linear leaf reflectance.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(root, 'assets/ground-cover/tropical/meadows');
const TILE = 4, VARIANTS = 4, STRIDE = 12, SEED = 1550, MARGIN = 0.05;

function random(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash(...values) {
  let h = 0x811c9dc5;
  for (const v of values) { h = Math.imul(h ^ (v | 0), 0x01000193); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 13; }
  return h >>> 0;
}
const lerp = (a, b, t) => a + (b - a) * t;
const range = (rand, [a, b]) => lerp(a, b, rand());
const normalize = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Each species: its tillers, leaves and inflorescence, in metres. Colours are a young and an old leaf's reflectance.
const SPECIES = {
  broomsedge: {
    scientific: 'Andropogon bicornis', common: 'West Indian broomsedge bluestem', tillers: [26, 44], spread: 0.09,
    leaves: [3, 5], leafLength: [0.35, 0.75], leafWidth: [0.004, 0.007], rise: [0.55, 0.85], droop: [0.25, 0.5], rows: 7,
    culm: [0.85, 1.35], culmShare: 0.45, head: 'plume', young: [0.20, 0.30, 0.11], old: [0.44, 0.36, 0.18], stiffness: [6, 14],
  },
  sourPaspalum: {
    scientific: 'Paspalum conjugatum', common: 'sour paspalum', tillers: [8, 14], spread: 0.16,
    leaves: [3, 5], leafLength: [0.08, 0.18], leafWidth: [0.006, 0.011], rise: [0.25, 0.5], droop: [0.25, 0.45], rows: 5,
    culm: [0.25, 0.45], culmShare: 0.35, head: 'pair', young: [0.17, 0.30, 0.08], old: [0.27, 0.30, 0.11], stiffness: [3, 8],
  },
  carpet: {
    scientific: 'Axonopus compressus', common: 'carpet grass', tillers: [10, 18], spread: 0.2,
    leaves: [3, 5], leafLength: [0.06, 0.14], leafWidth: [0.005, 0.009], rise: [0.15, 0.35], droop: [0.2, 0.4], rows: 4,
    culm: [0.18, 0.32], culmShare: 0.15, head: 'pair', young: [0.15, 0.29, 0.08], old: [0.24, 0.28, 0.10], stiffness: [2, 6],
  },
  nutSedge: {
    scientific: 'Cyperus rotundus', common: 'nut sedge', tillers: [1, 2], spread: 0.02,
    leaves: [4, 7], leafLength: [0.18, 0.32], leafWidth: [0.004, 0.006], rise: [0.6, 0.85], droop: [0.25, 0.45], rows: 5,
    culm: [0.25, 0.45], culmShare: 0.6, head: 'umbel', young: [0.16, 0.31, 0.09], old: [0.28, 0.30, 0.12], stiffness: [5, 10],
  },
  dropseed: {
    scientific: 'Sporobolus virginicus', common: 'seashore dropseed', tillers: [10, 18], spread: 0.18,
    leaves: [4, 7], leafLength: [0.05, 0.12], leafWidth: [0.002, 0.004], rise: [0.55, 0.8], droop: [0.05, 0.15], rows: 4,
    culm: [0.2, 0.4], culmShare: 0.3, head: 'spike', young: [0.22, 0.30, 0.13], old: [0.34, 0.33, 0.18], stiffness: [9, 18],
  },
  seashorePaspalum: {
    scientific: 'Paspalum vaginatum', common: 'seashore paspalum', tillers: [10, 16], spread: 0.18,
    leaves: [3, 5], leafLength: [0.05, 0.12], leafWidth: [0.003, 0.005], rise: [0.3, 0.55], droop: [0.15, 0.3], rows: 4,
    culm: [0.15, 0.3], culmShare: 0.2, head: 'pair', young: [0.16, 0.29, 0.10], old: [0.27, 0.29, 0.13], stiffness: [5, 10],
  },
  sandbur: {
    scientific: 'Cenchrus echinatus', common: 'southern sandbur', tillers: [4, 9], spread: 0.1,
    leaves: [3, 5], leafLength: [0.1, 0.22], leafWidth: [0.005, 0.009], rise: [0.3, 0.6], droop: [0.3, 0.5], rows: 5,
    culm: [0.3, 0.55], culmShare: 0.5, head: 'spike', young: [0.18, 0.30, 0.10], old: [0.36, 0.33, 0.16], stiffness: [4, 9],
  },
};
// Plants a square metre of each, as a closed sward at the end of the wet season.
const MIXES = {
  pasture: { description: 'a close carpet-grass sward with sour paspalum and nut sedge', components: { carpet: 20, sourPaspalum: 6, nutSedge: 8 } },
  savanna: { description: 'broomsedge bluestem tussocks over sour paspalum and carpet grass', components: { broomsedge: 2.2, sourPaspalum: 6, carpet: 10, nutSedge: 6 } },
  strand: { description: 'seashore dropseed and seashore paspalum with sandbur on coastal sand', components: { dropseed: 14, seashorePaspalum: 9, sandbur: 3 } },
};

// One plant's mesh: vertices (STRIDE floats each) and triangles, its organs separate pieces.
function growPlant(species, at, seed) {
  const s = SPECIES[species], rand = random(seed), vertices = [], indices = [];
  const height = s.culm[1] * 1.05;
  const push = (p, n, colour, along, stiffness) => { vertices.push(p[0], p[1], p[2], n[0], n[1], n[2], colour[0], colour[1], colour[2], along, stiffness, 0); return vertices.length / STRIDE - 1; };
  // A strip of rows across a midrib path, closing on a tip: rows of three (left, middle, right), double-sided.
  const strip = (spine, width, colour, stiffness) => {
    const rows = spine.length - 1, first = vertices.length / STRIDE;
    for (let r = 0; r < rows; r++) {
      const p = spine[r], q = spine[r + 1], along = normalize(q.map((v, k) => v - p[k]));
      const side = normalize(cross(along, [0, 1, 0]).every((v) => Math.abs(v) < 1e-6) ? [1, 0, 0] : cross(along, [0, 1, 0]));
      const normal = normalize(cross(side, along)), w = width * (1 - (r / rows) ** 1.6 * 0.85) * 0.5;
      // The blade folds a little along its midrib.
      const keel = normal.map((v) => v * w * 0.25);
      for (const k of [-1, 0, 1]) push([p[0] + side[0] * w * k - (k ? keel[0] : 0), p[1] + side[1] * w * k - (k ? keel[1] : 0), p[2] + side[2] * w * k - (k ? keel[2] : 0)], normal, colour, p[1] / height, stiffness);
    }
    const tip = spine[rows], last = normalize(tip.map((v, k) => v - spine[rows - 1][k]));
    const side = normalize(cross(last, [0, 1, 0]).every((v) => Math.abs(v) < 1e-6) ? [1, 0, 0] : cross(last, [0, 1, 0]));
    push(tip, normalize(cross(side, last)), colour, tip[1] / height, stiffness);
    for (let r = 0; r + 1 < rows; r++) {
      const a = first + r * 3, b = a + 3;
      indices.push(a, a + 1, b + 1, a, b + 1, b, a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
    }
    const a = first + (rows - 1) * 3, t = first + rows * 3;
    indices.push(a, a + 1, t, a + 1, a + 2, t);
  };
  // A spikelet: a closed diamond of four corners.
  const spikelet = (c, size, colour, stiffness) => {
    const first = vertices.length / STRIDE, d = normalize([rand() - 0.5, 0.6 + rand(), rand() - 0.5]), side = normalize(cross(d, [0.3, 0.1, 1]));
    const up = cross(side, d);
    const corners = [c.map((v, k) => v - d[k] * size), c.map((v, k) => v + d[k] * size), c.map((v, k) => v + side[k] * size * 0.35 + up[k] * size * 0.2), c.map((v, k) => v - side[k] * size * 0.35 + up[k] * size * 0.2)];
    for (const p of corners) push(p, normalize(p.map((v, k) => v - c[k])), colour, p[1] / height, stiffness);
    indices.push(first, first + 2, first + 1, first, first + 1, first + 3, first, first + 3, first + 2, first + 1, first + 2, first + 3);
  };
  // A path rising from `base` along `heading`, bending over by `droop` of its length.
  const arc = (base, heading, length, rise, droop, rows) => {
    const out = [];
    for (let r = 0; r <= rows; r++) {
      const t = r / rows, up = Math.sqrt(Math.max(0, 1 - rise * rise));
      const lean = up + droop * t * t, climb = rise - droop * t * t * 1.4;
      out.push([base[0] + heading[0] * lean * length * t, Math.max(0.002, base[1] + climb * length * t), base[2] + heading[1] * lean * length * t]);
    }
    return out;
  };
  const colourOf = (age) => s.young.map((v, k) => lerp(v, s.old[k], age) * (0.85 + 0.3 * rand()));
  const tillers = Math.round(range(rand, s.tillers));
  for (let t = 0; t < tillers; t++) {
    const r = Math.sqrt(rand()) * s.spread, a = rand() * Math.PI * 2, base = [at[0] + Math.cos(a) * r, 0, at[1] + Math.sin(a) * r];
    const outward = r > 1e-4 ? [Math.cos(a), Math.sin(a)] : [Math.cos(rand() * 6.28), Math.sin(rand() * 6.28)];
    const leaves = Math.round(range(rand, s.leaves)), stiffness = range(rand, s.stiffness);
    for (let l = 0; l < leaves; l++) {
      const turn = a + (rand() - 0.5) * 1.6 + (l % 2 ? Math.PI * 0.85 : 0), heading = normalize([outward[0] + Math.cos(turn) * 0.8, outward[1] + Math.sin(turn) * 0.8]);
      const length = range(rand, s.leafLength) * (1 - l / (leaves + 2) * 0.4), start = [base[0], 0.004 + l * 0.012 * length * 4, base[2]];
      strip(arc(start, heading, length, range(rand, s.rise), range(rand, s.droop), s.rows), range(rand, s.leafWidth), colourOf(l === 0 ? 0.6 + rand() * 0.4 : rand() * 0.4), stiffness);
    }
    if (rand() < s.culmShare) {
      const tall = range(rand, s.culm), lean = normalize([outward[0] + (rand() - 0.5), outward[1] + (rand() - 0.5)]);
      const culm = arc([base[0], 0.003, base[2]], lean, tall, 0.93 + rand() * 0.06, 0.04 + rand() * 0.08, 8);
      strip(culm, 0.0022, colourOf(0.5 + rand() * 0.3), stiffness * 1.4);
      const top = culm[culm.length - 1], straw = s.old.map((v) => v * (1.05 + rand() * 0.2));
      if (s.head === 'plume') {
        // Andropogon's hairy racemes in their spathes: a loose plume down the upper third.
        for (let k = 0; k < 18; k++) { const p = culm[5 + (k % 4)]; spikelet([p[0] + (rand() - 0.5) * 0.08, p[1] - rand() * 0.05, p[2] + (rand() - 0.5) * 0.08], 0.009, straw.map((v) => Math.min(0.75, v * 1.5)), stiffness); }
      } else if (s.head === 'pair' || s.head === 'umbel') {
        // Paspalum's two arms, or a sedge's rays: short racemes from the culm's top, spikelets along them.
        const arms = s.head === 'pair' ? 2 : 5;
        for (let m = 0; m < arms; m++) {
          const g = rand() * 6.28, armLength = s.head === 'pair' ? 0.06 + rand() * 0.05 : 0.03 + rand() * 0.04;
          const arm = arc(top, [Math.cos(g), Math.sin(g)], armLength, 0.35, 0.15, 3);
          strip(arm, 0.0016, straw, stiffness);
          for (let k = 0; k < 5; k++) { const p = arm[1 + (k % 3)]; spikelet([p[0], p[1] - 0.003, p[2]], 0.0035, straw, stiffness); }
        }
      } else {
        // A dense spike (dropseed) or a spike of burs (sandbur).
        for (let k = 0; k < 10; k++) { const p = culm[6 + (k % 3)]; spikelet([p[0] + (rand() - 0.5) * 0.01, p[1] - k * 0.006, p[2] + (rand() - 0.5) * 0.01], 0.004, straw, stiffness); }
      }
    }
  }
  return { vertices, indices };
}

// Where a plant of each species stands in a tile: jittered points, wrapped, with an even spacing for its density.
function sow(mix, seed, keep) {
  const rand = random(seed), plants = [];
  for (const [species, perM2] of Object.entries(MIXES[mix].components)) {
    const n = Math.round(perM2 * TILE * TILE), cells = Math.ceil(Math.sqrt(n)), size = TILE / cells;
    const slots = [];
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) slots.push([i, j]);
    for (let k = slots.length - 1; k > 0; k--) { const m = Math.floor(rand() * (k + 1)); [slots[k], slots[m]] = [slots[m], slots[k]]; }
    for (const [i, j] of slots.slice(0, n)) {
      const x = (i + 0.15 + rand() * 0.7) * size, z = (j + 0.15 + rand() * 0.7) * size;
      if (keep(x, z, species)) plants.push({ species, root: [x, z], seed: hash(seed, Math.round(x * 1000), Math.round(z * 1000)) });
    }
  }
  return plants;
}

function main() {
  const reach = Object.fromEntries(Object.keys(SPECIES).map((k) => {
    const s = SPECIES[k];
    return [k, s.spread + Math.max(s.leafLength[1], s.culm[1] * 0.35) + 0.12];
  }));
  const vertexChunks = [], indexChunks = [], groves = {};
  let vertexCount = 0, indexCount = 0;
  const edge = (x, z) => Math.min(x, z, TILE - x, TILE - z);
  for (const [mixIndex, mix] of Object.keys(MIXES).entries()) {
    const band = Math.max(...Object.keys(MIXES[mix].components).map((k) => reach[k])) + MARGIN;
    const shared = sow(mix, hash(SEED, mixIndex, 0x5ba7ed), (x, z) => edge(x, z) < band);
    const variants = [];
    for (let v = 0; v < VARIANTS; v++) {
      const interior = sow(mix, hash(SEED, mixIndex, v, 0x1e7e), (x, z, species) => edge(x, z) >= band && edge(x, z) > reach[species]);
      const plants = [...shared.map((p) => ({ ...p, shared: true })), ...interior.map((p) => ({ ...p, shared: false }))];
      // Biggest first, jittered, as the groves order their clumps.
      plants.sort((a, b) => reach[b.species] * (0.8 + (a.seed % 1000) / 2500) - reach[a.species] * (0.8 + (b.seed % 1000) / 2500));
      const firstVertex = vertexCount, firstIndex = indexCount, clumps = [];
      for (const plant of plants) {
        const mesh = growPlant(plant.species, plant.root, plant.seed), n = mesh.vertices.length / STRIDE;
        const verts = Float32Array.from(mesh.vertices), centre = [0, 0, 0];
        for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) centre[k] += verts[i * STRIDE + k] / n;
        let radius = 0;
        for (let i = 0; i < n; i++) radius = Math.max(radius, Math.hypot(verts[i * STRIDE] - centre[0], verts[i * STRIDE + 1] - centre[1], verts[i * STRIDE + 2] - centre[2]));
        clumps.push({ firstIndex: indexCount, indexCount: mesh.indices.length, firstVertex: vertexCount, vertexCount: n, centre: centre.map((c) => +c.toFixed(4)), radius: +radius.toFixed(4), root: plant.root.map((c) => +c.toFixed(4)), species: Object.keys(SPECIES).indexOf(plant.species), shared: plant.shared });
        vertexChunks.push(verts); indexChunks.push(Uint32Array.from(mesh.indices, (i) => i + vertexCount));
        vertexCount += n; indexCount += mesh.indices.length;
      }
      variants.push({ variant: v, firstIndex, indexCount: indexCount - firstIndex, firstVertex, vertexCount: vertexCount - firstVertex, triangles: (indexCount - firstIndex) / 3, plants: plants.length, sharedPlants: shared.length, drawnShare: 1, clumps });
      console.log(`${mix} v${v}: ${plants.length} plants (${shared.length} shared), ${(indexCount - firstIndex) / 3} triangles`);
    }
    groves[mix] = { description: MIXES[mix].description, components: Object.entries(MIXES[mix].components).map(([k, perM2]) => ({ herb: k, scientific: SPECIES[k].scientific, common: SPECIES[k].common, plantsPerM2: perM2 })), edgeBandMetres: +band.toFixed(4), variants };
  }
  const vertexBytes = Buffer.concat(vertexChunks.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  const indexBytes = Buffer.concat(indexChunks.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  fs.mkdirSync(OUT, { recursive: true });
  const stream = (name, bytes, count) => { const gz = zlib.gzipSync(bytes, { level: 6 }); fs.writeFileSync(path.join(OUT, name), gz); return { file: name, encoding: 'gzip', bytes: bytes.byteLength, gzipBytes: gz.byteLength, sha256: sha(gz), rawSha256: sha(bytes), count }; };
  const manifest = {
    format: 'waterworld.meadow-groves', version: 1, generator: 'scripts/prepare-tropical-sward.mjs', tileMetres: TILE, variants: VARIANTS, mixes: Object.keys(MIXES),
    coordinates: 'Y up, metres; tile spans [0, tileMetres] in X (east) and Z (south); plants near an edge overhang it and are shared by every variant',
    season: { place: 'Caribbean coasts c. 1550', note: 'the end of the wet season, in flower' }, topology: 'triangle-list', frontFace: 'ccw', doubleSided: true, indexFormat: 'uint32', indexBase: 'absolute',
    vertexLayout: { strideBytes: STRIDE * 4, floats: STRIDE, attributes: ['position', 'normal', 'colour', 'along', 'stiffness', 'anchor'] },
    species: Object.entries(SPECIES).map(([herb, s], index) => ({ index, herb, scientific: s.scientific, common: s.common })),
    streams: { vertices: stream('vertices.bin.gz', vertexBytes, vertexCount), indices: stream('indices.bin.gz', indexBytes, indexCount) },
    groves,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`Tropical groves: ${vertexCount} vertices, ${indexCount / 3} triangles`);
}

main();
