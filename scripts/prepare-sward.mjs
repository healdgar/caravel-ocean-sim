#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Grows the meadow groves of every pack: seamless 4 m tiles of closed sward, tuft by tuft and blade by blade at full
// resolution, in the meadow-groves format scripts/prepare-meadow-grass.mjs bakes into a meadow continuum. Usage:
// node scripts/prepare-sward.mjs [portugal] [tropical] (both when none is named). Kept out of git in
// assets/ground-cover/<pack>/meadows/; the baked atlas is what ships.
//
// A meadow is a turf, not plants stood apart on soil. Each mix is sown as:
//   - its bottom grasses: some three hundred tufts to the square metre, each a knot of tillers a few centimetres
//     across: a few short shoots and ten or so arching leaves, the older of them lying low and dry, two to three
//     square metres of leaf to the square metre of ground. Tufts stand closer than they are wide, so their leaves
//     cross and no tuft reads alone;
//   - its top grasses and herbs through that turf: tussocks, flowering culms and rosettes, a few to the square metre;
//   - its floor: the mat of low leaves and dead thatch at the turf's foot, which the bake lays as a sheet over the
//     ground (a grove's 'thatch': its colour and height), so what shows between blades is the sward's own shaded
//     floor, never the land's soil. A mix that grows on open sand has none.
// Three mixes a pack, four variants each, in the roles js/meadow-continuum.js gives them (MEADOW_MIX_ROLES: lowland,
// upland, margin). Every species is native to its coast at its date.
//
// How the seam is closed (the groves' contract): every plant rooted within its species' reach of an edge is the same
// in all four variants; the interior is sown afresh for each. A plant is never cut: one rooted by an edge overhangs
// into its neighbour. No mix varies across its tile more slowly than a tuft's breadth, so a field of tiles shows no
// tile: what varies over metres is the world's (the cover map and the shading's own fields).
//
// What the bake reads of an organ: a leaf, shoot or culm is rows of three vertices across its midrib and a tip (a
// shoot one row, 4 vertices; a leaf 7, 10, 13 or 16), and widens about its midrib; a spikelet is a closed spindle of
// 5 vertices, which grows about its centre. Colours are linear leaf reflectance. 'along' is how deep in the sward a
// point stands: a leaf's its height over its mix's leaf canopy, up to LEAF_ALONG at the canopy's top; a flowering
// stem's its height over the stem's, 1 at its head. 'stiffness' never falls under 1.5 (only the bake's floor is softer).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TILE = 4, VARIANTS = 4, STRIDE = 12, MARGIN = 0.03;
// The most 'along' a leaf reaches: the shading warms a point toward a ripe head from 0.76 (js/wgsl/meadow-continuum.js).
const LEAF_ALONG = 0.74;

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
const mix3 = (a, b, t) => a.map((v, k) => lerp(v, b[k], t));
const normalize = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A blade's width along its length, as a share of its widest: a grass leaf tapers from its sheath; a lanceolate
// leaf (a plantain's) is widest two fifths of the way out.
const PROFILES = {
  grass: (t) => 1 - t ** 1.6 * 0.85,
  lance: (t) => 0.3 + 0.7 * Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.82)) ** 0.8,
};

// Each species, in metres. A tuft holds `shoots` short straight blades and `leaves` arching ones spread over
// `spread`; `lax` of its leaves are old and lie low; `culms` flowering stems (a count, or a chance under one) rise
// to `culm` and bear `head`. Colours: a young, a mature and a dead leaf's reflectance, and its head's.
const PACKS = {
  portugal: {
    out: 'assets/ground-cover/portugal/meadows', seed: 1650,
    season: { place: 'Estremadura, Portugal, c. 1650', note: 'late spring: the turf green, the top grasses in flower and beginning to dry' },
    species: {
      ryegrass: {
        scientific: 'Lolium perenne', common: 'perennial ryegrass', spread: 0.035, shoots: [3, 5], shootLength: [0.04, 0.09], shootWidth: [0.0035, 0.005],
        leaves: [9, 13], leafLength: [0.07, 0.2], leafWidth: [0.004, 0.0065], rise: [0.45, 0.9], droop: [0.08, 0.32], lax: 0.3, dry: 0.12,
        culms: 0.12, culm: [0.25, 0.45], head: 'spike', young: [0.13, 0.30, 0.06], mature: [0.09, 0.22, 0.05], dead: [0.36, 0.31, 0.14], headColour: [0.24, 0.30, 0.11], stiffness: [4, 9],
      },
      bent: {
        scientific: 'Agrostis castellana', common: 'highland bent', spread: 0.04, shoots: [3, 5], shootLength: [0.035, 0.08], shootWidth: [0.0025, 0.004],
        leaves: [9, 13], leafLength: [0.06, 0.16], leafWidth: [0.003, 0.0048], rise: [0.4, 0.88], droop: [0.1, 0.35], lax: 0.3, dry: 0.15,
        culms: 0.1, culm: [0.3, 0.5], head: 'haze', young: [0.16, 0.30, 0.08], mature: [0.12, 0.24, 0.07], dead: [0.38, 0.32, 0.15], headColour: [0.30, 0.22, 0.16], stiffness: [3, 7],
      },
      poa: {
        scientific: 'Poa annua', common: 'annual meadow-grass', spread: 0.03, shoots: [3, 5], shootLength: [0.03, 0.06], shootWidth: [0.003, 0.0045],
        leaves: [7, 10], leafLength: [0.04, 0.1], leafWidth: [0.0035, 0.0055], rise: [0.35, 0.85], droop: [0.08, 0.3], lax: 0.35, dry: 0.1,
        culms: 0.08, culm: [0.1, 0.2], head: 'haze', young: [0.19, 0.34, 0.08], mature: [0.15, 0.29, 0.07], dead: [0.40, 0.35, 0.16], headColour: [0.30, 0.34, 0.16], stiffness: [2, 5],
      },
      fescue: {
        scientific: 'Festuca rubra', common: 'red fescue', spread: 0.035, shoots: [4, 6], shootLength: [0.04, 0.09], shootWidth: [0.0015, 0.0025],
        leaves: [12, 17], leafLength: [0.08, 0.22], leafWidth: [0.002, 0.0032], rise: [0.45, 0.9], droop: [0.12, 0.38], lax: 0.3, dry: 0.22,
        culms: 0.1, culm: [0.3, 0.55], head: 'haze', young: [0.12, 0.25, 0.08], mature: [0.09, 0.19, 0.07], dead: [0.36, 0.30, 0.15], headColour: [0.30, 0.20, 0.14], stiffness: [5, 10],
      },
      cocksfoot: {
        scientific: 'Dactylis glomerata', common: 'cocksfoot', spread: 0.075, shoots: [10, 16], shootLength: [0.04, 0.1], shootWidth: [0.004, 0.006],
        leaves: [34, 52], leafLength: [0.18, 0.45], leafWidth: [0.005, 0.009], rise: [0.55, 0.92], droop: [0.25, 0.6], lax: 0.22, dry: 0.16,
        culms: [3, 5], culm: [0.6, 1.05], head: 'lumps', young: [0.14, 0.27, 0.10], mature: [0.11, 0.22, 0.09], dead: [0.37, 0.32, 0.16], headColour: [0.30, 0.31, 0.17], stiffness: [8, 15],
      },
      wildOat: {
        scientific: 'Avena sterilis', common: 'sterile wild oat', spread: 0.03, shoots: [3, 6], shootLength: [0.04, 0.09], shootWidth: [0.004, 0.006],
        leaves: [8, 13], leafLength: [0.15, 0.4], leafWidth: [0.007, 0.012], rise: [0.55, 0.9], droop: [0.3, 0.65], lax: 0.2, dry: 0.2,
        culms: [1, 3], culm: [0.7, 1.15], head: 'oat', young: [0.18, 0.31, 0.09], mature: [0.15, 0.27, 0.08], dead: [0.42, 0.36, 0.17], headColour: [0.40, 0.38, 0.18], stiffness: [9, 16],
      },
      brome: {
        scientific: 'Bromus diandrus', common: 'ripgut brome', spread: 0.035, shoots: [4, 7], shootLength: [0.03, 0.08], shootWidth: [0.003, 0.005],
        leaves: [9, 15], leafLength: [0.1, 0.26], leafWidth: [0.004, 0.007], rise: [0.5, 0.9], droop: [0.3, 0.65], lax: 0.25, dry: 0.25,
        culms: [2, 4], culm: [0.4, 0.8], head: 'brome', young: [0.17, 0.29, 0.09], mature: [0.14, 0.25, 0.08], dead: [0.40, 0.33, 0.16], headColour: [0.33, 0.27, 0.17], stiffness: [6, 12],
      },
      ribwort: {
        scientific: 'Plantago lanceolata', common: 'ribwort plantain', spread: 0.012, shoots: [0, 0], shootLength: [0.02, 0.03], shootWidth: [0.004, 0.005],
        leaves: [7, 11], leafLength: [0.08, 0.18], leafWidth: [0.014, 0.024], rise: [0.25, 0.7], droop: [0.1, 0.35], lax: 0.3, dry: 0.08, profile: 'lance',
        culms: [1, 3], culm: [0.2, 0.42], head: 'ovoid', young: [0.12, 0.26, 0.06], mature: [0.09, 0.20, 0.05], dead: [0.30, 0.24, 0.11], headColour: [0.13, 0.10, 0.07], stiffness: [5, 9],
      },
    },
    // Tufts and plants a square metre, the height of each mix's leaf canopy, and its thatch.
    mixes: {
      pasture: {
        description: 'a grazed ryegrass and bent turf, closed over its thatch, with cocksfoot tussocks, ribwort and a few wild oats and bromes in flower',
        canopy: 0.17, thatch: { colour: [0.07, 0.09, 0.035], height: 0.02 },
        components: { ryegrass: 135, bent: 95, poa: 55, cocksfoot: 1.1, ribwort: 5, wildOat: 2.5, brome: 2.5 },
      },
      waste: {
        description: 'rank brome and wild oat over a fescue and bent turf on dry slopes, its tops turning to straw',
        canopy: 0.3, thatch: { colour: [0.09, 0.09, 0.04], height: 0.02 },
        components: { fescue: 100, bent: 95, poa: 35, brome: 20, wildOat: 9, ribwort: 2, cocksfoot: 0.3 },
      },
      'field-margin': {
        description: 'tall wild oat and cocksfoot through a lush ryegrass turf against a hedge bank',
        canopy: 0.34, thatch: { colour: [0.065, 0.088, 0.034], height: 0.02 },
        components: { ryegrass: 120, bent: 80, poa: 45, wildOat: 11, brome: 6, cocksfoot: 1.5, ribwort: 3 },
      },
    },
  },
  tropical: {
    out: 'assets/ground-cover/tropical/meadows', seed: 1550,
    season: { place: 'Caribbean coasts c. 1550', note: 'the end of the wet season, in flower' },
    // Every species is native to the tropical Americas; guinea and Bermuda grass came later with the slave trade.
    species: {
      carpet: {
        scientific: 'Axonopus compressus', common: 'carpet grass', spread: 0.045, shoots: [3, 5], shootLength: [0.02, 0.05], shootWidth: [0.005, 0.008],
        leaves: [9, 13], leafLength: [0.05, 0.13], leafWidth: [0.007, 0.012], rise: [0.2, 0.7], droop: [0.1, 0.3], lax: 0.4, dry: 0.08,
        culms: 0.1, culm: [0.18, 0.32], head: 'pair', young: [0.15, 0.29, 0.08], mature: [0.11, 0.23, 0.06], dead: [0.34, 0.31, 0.14], headColour: [0.28, 0.30, 0.13], stiffness: [2, 6],
      },
      sourPaspalum: {
        scientific: 'Paspalum conjugatum', common: 'sour paspalum', spread: 0.05, shoots: [3, 5], shootLength: [0.025, 0.06], shootWidth: [0.004, 0.007],
        leaves: [9, 13], leafLength: [0.07, 0.18], leafWidth: [0.007, 0.012], rise: [0.3, 0.8], droop: [0.12, 0.35], lax: 0.35, dry: 0.1,
        culms: 0.3, culm: [0.25, 0.45], head: 'pair', young: [0.17, 0.30, 0.08], mature: [0.13, 0.25, 0.07], dead: [0.36, 0.32, 0.14], headColour: [0.30, 0.31, 0.13], stiffness: [3, 8],
      },
      nutSedge: {
        scientific: 'Cyperus rotundus', common: 'nut sedge', spread: 0.015, shoots: [1, 3], shootLength: [0.04, 0.08], shootWidth: [0.003, 0.005],
        leaves: [5, 8], leafLength: [0.16, 0.3], leafWidth: [0.004, 0.006], rise: [0.6, 0.9], droop: [0.25, 0.5], lax: 0.15, dry: 0.08,
        culms: 0.6, culm: [0.25, 0.45], head: 'umbel', young: [0.16, 0.31, 0.09], mature: [0.12, 0.25, 0.07], dead: [0.36, 0.32, 0.15], headColour: [0.30, 0.22, 0.12], stiffness: [5, 10],
      },
      broomsedge: {
        scientific: 'Andropogon bicornis', common: 'West Indian broomsedge bluestem', spread: 0.09, shoots: [8, 14], shootLength: [0.05, 0.12], shootWidth: [0.004, 0.006],
        leaves: [44, 70], leafLength: [0.3, 0.7], leafWidth: [0.004, 0.007], rise: [0.6, 0.93], droop: [0.25, 0.5], lax: 0.2, dry: 0.3,
        culms: [6, 11], culm: [0.85, 1.35], head: 'plume', young: [0.20, 0.30, 0.11], mature: [0.17, 0.26, 0.10], dead: [0.44, 0.36, 0.18], headColour: [0.55, 0.47, 0.25], stiffness: [6, 14],
      },
      dropseed: {
        scientific: 'Sporobolus virginicus', common: 'seashore dropseed', spread: 0.07, shoots: [3, 5], shootLength: [0.03, 0.07], shootWidth: [0.002, 0.0035],
        leaves: [16, 24], leafLength: [0.05, 0.12], leafWidth: [0.002, 0.004], rise: [0.55, 0.85], droop: [0.05, 0.2], lax: 0.1, dry: 0.15,
        culms: 0.5, culm: [0.2, 0.4], head: 'dense', young: [0.22, 0.30, 0.13], mature: [0.19, 0.27, 0.12], dead: [0.36, 0.34, 0.19], headColour: [0.36, 0.34, 0.19], stiffness: [9, 18],
      },
      seashorePaspalum: {
        scientific: 'Paspalum vaginatum', common: 'seashore paspalum', spread: 0.08, shoots: [3, 5], shootLength: [0.02, 0.055], shootWidth: [0.003, 0.005],
        leaves: [14, 20], leafLength: [0.05, 0.12], leafWidth: [0.003, 0.005], rise: [0.3, 0.6], droop: [0.1, 0.25], lax: 0.3, dry: 0.12,
        culms: 0.25, culm: [0.15, 0.3], head: 'pair', young: [0.16, 0.29, 0.10], mature: [0.13, 0.25, 0.09], dead: [0.34, 0.31, 0.15], headColour: [0.29, 0.30, 0.14], stiffness: [5, 10],
      },
      sandbur: {
        scientific: 'Cenchrus echinatus', common: 'southern sandbur', spread: 0.05, shoots: [2, 4], shootLength: [0.03, 0.07], shootWidth: [0.004, 0.006],
        leaves: [10, 18], leafLength: [0.1, 0.22], leafWidth: [0.005, 0.009], rise: [0.3, 0.65], droop: [0.3, 0.55], lax: 0.3, dry: 0.15,
        culms: [1, 3], culm: [0.3, 0.55], head: 'bur', young: [0.18, 0.30, 0.10], mature: [0.15, 0.26, 0.09], dead: [0.38, 0.33, 0.16], headColour: [0.38, 0.33, 0.16], stiffness: [4, 9],
      },
    },
    mixes: {
      pasture: {
        description: 'a close carpet-grass and sour-paspalum turf, closed over its thatch, with nut sedge',
        canopy: 0.1, thatch: { colour: [0.07, 0.09, 0.035], height: 0.02 },
        components: { carpet: 190, sourPaspalum: 85, nutSedge: 8 },
      },
      savanna: {
        description: 'broomsedge bluestem tussocks through a sour-paspalum and carpet-grass turf',
        canopy: 0.26, thatch: { colour: [0.08, 0.088, 0.038], height: 0.02 },
        components: { sourPaspalum: 125, carpet: 120, broomsedge: 1.8, nutSedge: 6 },
      },
      strand: {
        description: 'mats of seashore dropseed and seashore paspalum with sandbur on open coastal sand',
        canopy: 0.1,
        components: { dropseed: 62, seashorePaspalum: 58, sandbur: 2.5 },
      },
    },
  },
};

// One tuft's mesh: vertices (STRIDE floats each) and triangles, every organ a separate piece.
function growTuft(spec, canopy, at, seed) {
  const rand = random(seed), vertices = [], indices = [];
  // A leaf is never a seed head: it stands at most LEAF_ALONG along, by its height in the canopy; a flowering stem
  // and its head climb from there to 1 at the head (culmTop, while they are grown).
  let culmTop = 0;
  const alongOf = (y) => { const leaf = LEAF_ALONG * Math.max(0, Math.min(1, y / canopy)); return culmTop ? Math.max(leaf, Math.min(1, y / culmTop)) : leaf; };
  const push = (p, n, colour, stiffness) => { vertices.push(p[0], p[1], p[2], n[0], n[1], n[2], colour[0], colour[1], colour[2], alongOf(p[1]), stiffness, 0); return vertices.length / STRIDE - 1; };
  // A blade: rows of three (left, midrib, right) along a midrib path, closing on a tip; folded a little along its
  // midrib and turned a little about it. `colourAt` gives its colour from foot (0) to tip (1).
  const strip = (spine, width, colourAt, stiffness, profile = PROFILES.grass, twist = 0) => {
    const rows = spine.length - 1, first = vertices.length / STRIDE;
    let normal = [0, 1, 0];
    for (let r = 0; r < rows; r++) {
      const p = spine[r], t = r / rows, along = normalize(spine[r + 1].map((v, k) => v - p[k]));
      const flat = cross(along, [0, 1, 0]), side0 = normalize(flat.every((v) => Math.abs(v) < 1e-6) ? [1, 0, 0] : flat), normal0 = normalize(cross(side0, along));
      const a = twist * t, side = side0.map((v, k) => v * Math.cos(a) + normal0[k] * Math.sin(a));
      normal = normal0.map((v, k) => v * Math.cos(a) - side0[k] * Math.sin(a));
      const w = width * profile(t) * 0.5, colour = colourAt(t);
      for (const k of [-1, 0, 1]) push(p.map((v, i) => v + side[i] * w * k - (k ? normal[i] * w * 0.25 : 0)), k ? normalize(normal.map((v, i) => v + side[i] * 0.45 * k)) : normal, colour, stiffness);
    }
    push(spine[rows], normal, colourAt(1), stiffness);
    for (let r = 0; r + 1 < rows; r++) {
      const a = first + r * 3, b = a + 3;
      indices.push(a, a + 1, b + 1, a, b + 1, b, a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
    }
    const a = first + (rows - 1) * 3, t = first + rows * 3;
    indices.push(a, a + 1, t, a + 1, a + 2, t);
  };
  // A spikelet: a closed spindle of five corners along `axis`.
  const spikelet = (c, axis, length, width, colour, stiffness) => {
    const first = vertices.length / STRIDE, d = normalize(axis), flat = cross(d, [0.31, 0.17, 0.93]), u = normalize(flat), w = cross(d, u);
    const corners = [c.map((v, k) => v + d[k] * length * 0.5), c.map((v, k) => v - d[k] * length * 0.5)];
    for (let k = 0; k < 3; k++) { const g = (k / 3) * Math.PI * 2; corners.push(c.map((v, i) => v + (u[i] * Math.cos(g) + w[i] * Math.sin(g)) * width * 0.5)); }
    for (const p of corners) push([p[0], Math.max(0.003, p[1]), p[2]], normalize(p.map((v, k) => v - c[k])), colour, stiffness);
    for (let k = 0; k < 3; k++) { const a = first + 2 + k, b = first + 2 + ((k + 1) % 3); indices.push(first, a, b, first + 1, b, a); }
  };
  // A path rising from `base` along `heading` (level), bending over by `droop` of its length.
  const arc = (base, heading, length, rise, droop, rows) => {
    const out = [], level = Math.sqrt(Math.max(0, 1 - rise * rise));
    for (let r = 0; r <= rows; r++) {
      const t = r / rows, lean = level + droop * t * t, climb = rise - droop * t * t * 1.4;
      out.push([base[0] + heading[0] * lean * length * t, Math.max(0.004, base[1] + climb * length * t), base[2] + heading[1] * lean * length * t]);
    }
    return out;
  };
  const shade = () => 0.86 + 0.28 * rand();
  // A leaf's colour: young to mature by its age, dead when it has died; a living leaf's tip may have dried.
  const leafColour = (age, dead) => {
    const s = shade(), live = mix3(spec.young, spec.mature, age).map((v) => v * s), straw = spec.dead.map((v) => v * s);
    if (dead) return () => straw;
    const scorch = rand() < 0.3 ? 0.4 + 0.6 * rand() : 0;
    return (t) => (scorch && t > 0.55 ? mix3(live, straw, scorch * Math.min(1, (t - 0.55) / 0.35)) : live);
  };
  const vigour = 0.75 + 0.5 * rand(), stiffness = () => Math.max(1.5, range(rand, spec.stiffness));
  const foot = () => { const r = Math.sqrt(rand()) * spec.spread, a = rand() * Math.PI * 2; return [[at[0] + Math.cos(a) * r, 0, at[1] + Math.sin(a) * r], a, r]; };
  const profile = PROFILES[spec.profile ?? 'grass'];

  // The underfur: short straight shoots at every lean, one row and a tip each.
  const shoots = Math.round(range(rand, spec.shoots));
  for (let s = 0; s < shoots; s++) {
    const [base, a] = foot(), turn = a + (rand() - 0.5) * 3.2, tilt = 0.12 + 0.75 * rand(), length = range(rand, spec.shootLength) * vigour;
    const tip = [base[0] + Math.cos(turn) * Math.sin(tilt) * length, Math.cos(tilt) * length, base[2] + Math.sin(turn) * Math.sin(tilt) * length];
    const colour = leafColour(rand() * 0.7, rand() < spec.dry * 0.6);
    strip([[base[0], 0.002, base[2]], tip], range(rand, spec.shootWidth), colour, stiffness());
  }
  // The leaves: arching out of the tuft every way; the lax ones old, low and often dead.
  const leaves = Math.round(range(rand, spec.leaves));
  for (let l = 0; l < leaves; l++) {
    const [base, a, r] = foot(), lax = rand() < spec.lax;
    const out = r > 1e-4 ? [Math.cos(a), Math.sin(a)] : [1, 0], turn = rand() * Math.PI * 2;
    const heading = normalize([out[0] * 0.6 + Math.cos(turn), out[1] * 0.6 + Math.sin(turn)]);
    const length = range(rand, spec.leafLength) * vigour * (lax ? 0.85 : 1), rows = length < 0.09 ? 2 : length < 0.22 ? 3 : length < 0.4 ? 4 : 5;
    const rise = lax ? 0.12 + 0.3 * rand() : range(rand, spec.rise), droop = lax ? 0.05 + 0.2 * rand() : range(rand, spec.droop);
    const colour = leafColour(lax ? 0.6 + 0.4 * rand() : rand(), rand() < (lax ? spec.dry * 2.2 : spec.dry * 0.6));
    strip(arc([base[0], 0.003, base[2]], heading, length, rise, droop, rows), range(rand, spec.leafWidth), colour, stiffness(), profile, (rand() - 0.5) * 1.4);
  }
  // The flowering stems and their heads.
  const culms = Array.isArray(spec.culms) ? Math.round(range(rand, spec.culms)) : (rand() < spec.culms ? 1 : 0);
  for (let c = 0; c < culms; c++) {
    const [base, a] = foot(), tall = range(rand, spec.culm) * (0.85 + 0.3 * rand()), stiff = stiffness() * 1.4;
    culmTop = tall;
    const lean = normalize([Math.cos(a) + (rand() - 0.5) * 1.6, Math.sin(a) + (rand() - 0.5) * 1.6]);
    const stem = arc([base[0], 0.003, base[2]], lean, tall, 0.95 + rand() * 0.045, 0.03 + rand() * 0.09, tall > 0.5 ? 6 : 4);
    const green = mix3(spec.mature, spec.dead, 0.25 + 0.4 * rand()).map((v) => v * shade());
    strip(stem, 0.0026, () => green, stiff);
    const top = stem[stem.length - 1], axis = normalize(top.map((v, k) => v - stem[stem.length - 2][k])), ripe = spec.headColour.map((v) => v * shade());
    const pointOn = (t) => { const f = Math.min(stem.length - 1.001, t * (stem.length - 1)), i = Math.floor(f); return stem[i].map((v, k) => lerp(v, stem[i + 1][k], f - i)); };
    const around = () => { const g = rand() * Math.PI * 2; return [Math.cos(g), Math.sin(g)]; };
    if (spec.head === 'spike') {
      // Ryegrass: spikelets set edgewise up a flat rachis, alternating.
      const n = 8 + Math.floor(rand() * 5), side = normalize(cross(axis, [0.2, 0.1, 1]));
      for (let k = 0; k < n; k++) { const p = pointOn(1 - (0.34 * (k + 0.5)) / n), s = k % 2 ? 1 : -1; spikelet(p.map((v, i) => v + side[i] * s * 0.004), axis.map((v, i) => v + side[i] * s * 0.45), 0.012, 0.0032, ripe, stiff); }
    } else if (spec.head === 'haze') {
      // A bent's or meadow-grass's open panicle: hair-fine branches, a spikelet at each end.
      const n = 4 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const p = pointOn(1 - 0.3 * (k / n)), g = around(), reach = tall * (0.07 + 0.07 * rand());
        const end = [p[0] + g[0] * reach, p[1] + reach * (0.5 + 0.5 * rand()), p[2] + g[1] * reach];
        strip([p, end], 0.0009, () => ripe, stiff);
        spikelet(end, [g[0], 1, g[1]], 0.004, 0.0018, ripe, stiff);
      }
    } else if (spec.head === 'oat' || spec.head === 'brome') {
      // A nodding panicle: branches arching out and down, a long spikelet hanging from each with its awns.
      const oat = spec.head === 'oat', n = oat ? 5 + Math.floor(rand() * 4) : 4 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const p = pointOn(1 - 0.32 * (k / n)), g = around(), reach = (oat ? 0.05 : 0.035) + 0.04 * rand();
        const end = [p[0] + g[0] * reach, p[1] - reach * (0.1 + 0.5 * rand()), p[2] + g[1] * reach];
        strip([p, end], 0.001, () => ripe, stiff);
        const hang = normalize([g[0] * 0.5, -1, g[1] * 0.5]), size = oat ? 0.022 : 0.032, centre = end.map((v, i) => v + hang[i] * size * 0.5);
        spikelet(centre, hang, size, oat ? 0.0065 : 0.0045, ripe, stiff);
        const awnFrom = centre.map((v, i) => v + hang[i] * size * 0.4), awns = oat ? 1 : 2;
        for (let m = 0; m < awns; m++) { const w = around(), far = awnFrom.map((v, i) => v + hang[i] * 0.03 + [w[0], 0, w[1]][i] * 0.012); strip([awnFrom, far], 0.0008, () => ripe, stiff); }
      }
    } else if (spec.head === 'lumps') {
      // Cocksfoot: dense one-sided clusters on a few stiff branches.
      const n = 3 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const p = pointOn(1 - 0.22 * (k / n)), g = around(), reach = 0.012 + 0.03 * (k / n);
        const end = [p[0] + g[0] * reach, p[1] + reach * 0.6, p[2] + g[1] * reach];
        if (k) strip([p, end], 0.0012, () => ripe, stiff);
        spikelet(k ? end : top, [g[0] * 0.4, 1, g[1] * 0.4], 0.017, 0.011, ripe, stiff);
      }
    } else if (spec.head === 'ovoid') {
      // Ribwort: one dark ovoid spike on a bare scape.
      spikelet(top, axis, 0.02, 0.008, ripe, stiff);
    } else if (spec.head === 'pair' || spec.head === 'umbel') {
      // Paspalum's two arms, or a sedge's rays: short racemes from the culm's top, spikelets along them.
      const arms = spec.head === 'pair' ? 2 : 5;
      for (let m = 0; m < arms; m++) {
        const g = around(), length = spec.head === 'pair' ? 0.06 + rand() * 0.05 : 0.03 + rand() * 0.04, arm = arc(top, g, length, 0.35, 0.15, 2);
        strip(arm, 0.0016, () => ripe, stiff);
        for (let k = 0; k < 3; k++) { const f = (k + 0.5) / 3, p = arm[0].map((v, i) => lerp(v, arm[2][i], f)); spikelet([p[0], p[1] - 0.002, p[2]], [g[0], 0.3, g[1]], 0.006, 0.003, ripe, stiff); }
      }
    } else if (spec.head === 'plume') {
      // Andropogon's hairy racemes in their spathes: a loose pale plume down the upper third.
      for (let k = 0; k < 14; k++) { const p = pointOn(1 - 0.35 * rand()); spikelet([p[0] + (rand() - 0.5) * 0.08, p[1] - rand() * 0.04, p[2] + (rand() - 0.5) * 0.08], [rand() - 0.5, 1, rand() - 0.5], 0.02, 0.008, ripe, stiff); }
    } else {
      // A dense spike (dropseed) or a spike of burs (sandbur).
      const bur = spec.head === 'bur', n = bur ? 6 : 8;
      for (let k = 0; k < n; k++) { const p = pointOn(1 - (0.3 * (k + 0.5)) / n); spikelet([p[0] + (rand() - 0.5) * 0.006, p[1], p[2] + (rand() - 0.5) * 0.006], bur ? [rand() - 0.5, rand() - 0.5, rand() - 0.5] : axis, bur ? 0.008 : 0.012, bur ? 0.007 : 0.004, ripe, stiff); }
    }
  }
  return { vertices, indices };
}

// Where a tuft of each species stands in a tile: one to a cell of an even grid, anywhere in its cell.
function sow(mix, seed, keep) {
  const rand = random(seed), plants = [];
  for (const [species, perM2] of Object.entries(mix.components)) {
    const n = Math.round(perM2 * TILE * TILE), cells = Math.ceil(Math.sqrt(n)), size = TILE / cells;
    const slots = [];
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) slots.push([i, j]);
    for (let k = slots.length - 1; k > 0; k--) { const m = Math.floor(rand() * (k + 1)); [slots[k], slots[m]] = [slots[m], slots[k]]; }
    for (const [i, j] of slots.slice(0, n)) {
      const x = (i + 0.04 + rand() * 0.92) * size, z = (j + 0.04 + rand() * 0.92) * size;
      if (keep(x, z, species)) plants.push({ species, root: [x, z], seed: hash(seed, Math.round(x * 10000), Math.round(z * 10000)) });
    }
  }
  return plants;
}

function growPack(name) {
  const pack = PACKS[name], out = path.join(root, pack.out), names = Object.keys(pack.species);
  // How far a tuft of each species may overhang where it is rooted.
  const reach = Object.fromEntries(names.map((k) => { const s = pack.species[k]; return [k, s.spread + Math.max(s.leafLength[1] * 1.25, s.culm[1] * 0.42 + 0.12) + 0.02]; }));
  const vertexChunks = [], indexChunks = [], groves = {};
  let vertexCount = 0, indexCount = 0;
  const edge = (x, z) => Math.min(x, z, TILE - x, TILE - z);
  for (const [mixIndex, mixName] of Object.keys(pack.mixes).entries()) {
    const mix = pack.mixes[mixName], band = (species) => reach[species] + MARGIN;
    const shared = sow(mix, hash(pack.seed, mixIndex, 0x5ba7ed), (x, z, species) => edge(x, z) < band(species));
    const variants = [];
    for (let v = 0; v < VARIANTS; v++) {
      const interior = sow(mix, hash(pack.seed, mixIndex, v, 0x1e7e), (x, z, species) => edge(x, z) >= band(species));
      const plants = [...shared.map((p) => ({ ...p, shared: true })), ...interior.map((p) => ({ ...p, shared: false }))];
      const firstVertex = vertexCount, firstIndex = indexCount, clumps = [];
      for (const plant of plants) {
        const mesh = growTuft(pack.species[plant.species], mix.canopy, plant.root, plant.seed), n = mesh.vertices.length / STRIDE;
        if (!n) continue;
        clumps.push({ firstIndex: indexCount, indexCount: mesh.indices.length, firstVertex: vertexCount, vertexCount: n, root: plant.root.map((c) => +c.toFixed(4)), species: names.indexOf(plant.species), shared: plant.shared });
        vertexChunks.push(Float32Array.from(mesh.vertices)); indexChunks.push(Uint32Array.from(mesh.indices, (i) => i + vertexCount));
        vertexCount += n; indexCount += mesh.indices.length;
      }
      variants.push({ variant: v, firstIndex, indexCount: indexCount - firstIndex, firstVertex, vertexCount: vertexCount - firstVertex, triangles: (indexCount - firstIndex) / 3, plants: clumps.length, sharedPlants: shared.length, drawnShare: 1, clumps });
      console.log(`${name} ${mixName} v${v}: ${clumps.length} tufts (${shared.length} shared), ${(indexCount - firstIndex) / 3} triangles, ${vertexCount - firstVertex} vertices`);
    }
    groves[mixName] = {
      description: mix.description, canopyMetres: mix.canopy, ...(mix.thatch ? { thatch: mix.thatch } : {}),
      components: Object.entries(mix.components).map(([k, perM2]) => ({ herb: k, scientific: pack.species[k].scientific, common: pack.species[k].common, plantsPerM2: perM2 })),
      edgeBandMetres: +Math.max(...Object.keys(mix.components).map(band)).toFixed(4), variants,
    };
  }
  const vertexBytes = Buffer.concat(vertexChunks.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  const indexBytes = Buffer.concat(indexChunks.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  fs.mkdirSync(out, { recursive: true });
  const stream = (file, bytes, count) => { const gz = zlib.gzipSync(bytes, { level: 6 }); fs.writeFileSync(path.join(out, file), gz); return { file, encoding: 'gzip', bytes: bytes.byteLength, gzipBytes: gz.byteLength, sha256: sha(gz), rawSha256: sha(bytes), count }; };
  const manifest = {
    format: 'waterworld.meadow-groves', version: 1, generator: 'scripts/prepare-sward.mjs', pack: name, tileMetres: TILE, variants: VARIANTS, mixes: Object.keys(pack.mixes),
    coordinates: 'Y up, metres; tile spans [0, tileMetres] in X (east) and Z (south); plants near an edge overhang it and are shared by every variant',
    season: pack.season, topology: 'triangle-list', frontFace: 'ccw', doubleSided: true, indexFormat: 'uint32', indexBase: 'absolute',
    vertexLayout: { strideBytes: STRIDE * 4, floats: STRIDE, attributes: ['position', 'normal', 'colour', 'along', 'stiffness', 'anchor'] },
    species: names.map((herb, index) => ({ index, herb, scientific: pack.species[herb].scientific, common: pack.species[herb].common })),
    streams: { vertices: stream('vertices.bin.gz', vertexBytes, vertexCount), indices: stream('indices.bin.gz', indexBytes, indexCount) },
    groves,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  console.log(`${name} groves: ${vertexCount} vertices, ${indexCount / 3} triangles`);
}

const named = process.argv.slice(2);
for (const name of named) if (!PACKS[name]) throw Error(`No sward pack ${name}; there are ${Object.keys(PACKS).join(', ')}`);
for (const name of named.length ? named : Object.keys(PACKS)) growPack(name);
