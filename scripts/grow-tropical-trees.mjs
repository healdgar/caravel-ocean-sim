#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Grows the subtropical forest pack: a royal palm with its pale column, green crownshaft and plumed
// fronds; a coconut with its leaning ringed trunk and drooping fronds; a ceiba, a buttressed emergent
// with a flat spreading crown; and a red mangrove, a low dome on arching prop roots.
//   python3 scripts/paint-tropical-leaves.py assets/forest-scenery/subtropical
//   node scripts/grow-tropical-trees.mjs
//   node scripts/prepare-forest-clusters.mjs subtropical
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

const DIR = 'assets/forest-scenery/subtropical';
const STRIDE = 14;
const WOOD = 3, LEAF = 4;
const BARK = 0, LEAFLET = [2, 3, 4];
const manifest = JSON.parse(fs.readFileSync(`${DIR}/manifest.json`, 'utf8'));
const asFloats = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const asWords = (b) => new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const oldVertices = asFloats(zlib.gunzipSync(fs.readFileSync(`${DIR}/vertices.bin.gz`)));
const oldIndices = asWords(zlib.gunzipSync(fs.readFileSync(`${DIR}/indices.bin.gz`)));

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const UP = [0, 1, 0], GOLDEN = Math.PI * (3 - Math.sqrt(5));

function random(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

class Mesh {
  vertices = []; indices = [];
  vertex(position, normal, kind, shade, uv, colour, material) {
    this.vertices.push(...position, ...normal, kind, shade, ...uv, ...colour, material);
    return this.vertices.length / STRIDE - 1;
  }
}

// A tube along a path of rings. Each ring: centre, radius, colour.
function tube(mesh, rings, sides, uRepeat, vPerMetre, shade) {
  let length = 0;
  rings.forEach((ring, r) => {
    const next = rings[Math.min(r + 1, rings.length - 1)], prev = rings[Math.max(r - 1, 0)];
    const along = unit(sub(next.at, prev.at));
    const side = unit(cross(along, Math.abs(along[1]) > 0.9 ? [1, 0, 0] : UP)), other = cross(along, side);
    if (r) length += Math.hypot(...sub(ring.at, rings[r - 1].at));
    for (let k = 0; k <= sides; k++) {
      const angle = (k / sides) * Math.PI * 2, out = add(mul(side, Math.cos(angle)), mul(other, Math.sin(angle)));
      const reach = ring.radius * (ring.shape ? ring.shape(angle) : 1);
      mesh.vertex(add(ring.at, mul(out, reach)), out, WOOD, shade, [(k / sides) * uRepeat, length * vPerMetre], ring.colour, BARK);
    }
  });
  const first = mesh.vertices.length / STRIDE - (rings.length * (sides + 1)), rowSize = sides + 1;
  for (let r = 0; r + 1 < rings.length; r++) for (let k = 0; k < sides; k++) {
    const a = first + r * rowSize + k, b = a + 1, c = a + rowSize, d = c + 1;
    mesh.indices.push(a, c, b, b, c, d);
  }
}

// One leaflet: a blade of two quads along its length, the pattern every tree's leaves in the pack use.
function leaflet(leaves, leafIndices, start, direction, across, length, width, sag, colour, material, shade, outward) {
  const point = (t) => add(add(start, mul(direction, length * t)), [0, -sag * length * t * t, 0]);
  const middle = point(0.5), end = point(1), half = mul(across, width / 2);
  const facing = (() => { let n = unit(cross(direction, across)); if (n[1] < 0) n = mul(n, -1); return unit(add(add(mul(n, 0.7), mul(UP, 0.35)), mul(outward, 0.25))); })();
  const put = (p, u, v) => leaves.vertex(p, facing, LEAF, shade, [u, v], colour, material);
  const a = put(sub(start, mul(half, 0.7)), 0, 0), b = put(add(start, mul(half, 0.7)), 0, 1);
  const c = put(add(middle, half), 0.5, 1), d = put(sub(middle, half), 0.5, 0);
  const e = put(add(end, mul(half, 0.5)), 1, 1), f = put(sub(end, mul(half, 0.5)), 1, 0);
  leafIndices.push(a, b, c, a, c, d, d, c, e, d, e, f);
}

function frond(wood, leaves, leafIndices, rng, base, azimuth, elevation, spec, age) {
  const length = spec.frondLength * (0.82 + 0.26 * rng()) * (1 - 0.22 * (1 - age));
  const heading = [Math.cos(azimuth), 0, Math.sin(azimuth)], SEGMENTS = 12;
  const droop = spec.droop * (0.7 + 0.5 * age) * (0.9 + 0.2 * rng());
  const path = [{ at: base, along: unit(add(mul(heading, Math.cos(elevation)), mul(UP, Math.sin(elevation)))) }];
  for (let s = 1; s <= SEGMENTS; s++) {
    const t = s / SEGMENTS, angle = elevation - droop * t ** 1.5;
    const along = unit(add(mul(heading, Math.cos(angle)), mul(UP, Math.sin(angle))));
    path.push({ at: add(path[s - 1].at, mul(along, length / SEGMENTS)), along });
  }
  const rachisColour = age > 0.8 ? [0.55, 0.47, 0.2] : [0.34, 0.42, 0.16];
  tube(wood.mesh, path.map(({ at }, s) => ({ at, radius: spec.rachisRadius * (1 - (0.92 * s) / SEGMENTS) + 0.004, colour: rachisColour })), 4, 1, 1.5, 0.6);
  const side = unit(cross(heading, UP));
  const tone = LEAFLET[Math.floor(rng() * LEAFLET.length)];
  const colour = age > 0.8 ? [1, 0.84, 0.5] : age < 0.3 ? [1, 1, 0.82] : [0.95, 0.97, 0.86];
  const pairs = spec.leafletPairs;
  for (let p = 0; p < pairs; p++) {
    const t = 0.1 + (0.9 * p) / pairs, position = t * SEGMENTS, at = Math.min(SEGMENTS - 1, Math.floor(position)), f = position - at;
    const point = add(mul(path[at].at, 1 - f), mul(path[at + 1].at, f)), along = path[at + 1].along;
    const normal = unit(cross(side, along));
    const size = spec.leafletLength * Math.sin(Math.PI * (0.12 + 0.86 * t)) ** 0.6 * (0.9 + 0.2 * rng());
    for (const hand of [-1, 1]) {
      // Plumed fronds carry leaflets in several planes; others in one flat V.
      const plane = spec.plumes ? [0.15, 0.95, -0.55][(p + (hand > 0 ? 1 : 0)) % 3] : 0.32;
      const out = unit(add(add(mul(side, hand), mul(normal, plane + (rng() - 0.5) * 0.12)), mul(along, 0.55 + 0.25 * t)));
      const across = unit(cross(out, normal));
      const sag = spec.leafletSag * (0.5 + 0.8 * t) * (0.8 + 0.4 * rng());
      leaflet(leaves.mesh, leafIndices, point, out, across, size, spec.leafletWidth, sag, colour, tone, 0.52 + 0.34 * t, heading);
    }
  }
}

function coconuts(mesh, rng, crown, count) {
  for (let n = 0; n < count; n++) {
    const angle = rng() * Math.PI * 2, at = add(crown, [Math.cos(angle) * (0.2 + rng() * 0.16), -0.2 - rng() * 0.5, Math.sin(angle) * (0.2 + rng() * 0.16)]);
    const colour = rng() > 0.45 ? [0.42, 0.5, 0.18] : [0.34, 0.24, 0.12], radius = 0.1 + rng() * 0.03, rows = 4, sides = 6;
    const rings = [];
    for (let r = 0; r <= rows; r++) { const a = (r / rows) * Math.PI; rings.push({ at: add(at, [0, -Math.cos(a) * radius, 0]), radius: Math.max(0.004, Math.sin(a) * radius), colour }); }
    tube(mesh, rings, sides, 1, 2, 0.5);
  }
}

function growRoyalPalm() {
  const rng = random(11), height = 13.6, mesh = new Mesh(), leaves = new Mesh(), leafIndices = [];
  const SHAFT = 0.74, RINGS = 28, rings = [];
  const pale = [0.88, 0.86, 0.8], shaftColour = [0.34, 0.6, 0.2];
  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS, y = t * height * 0.9;
    const bulge = 0.07 * Math.exp(-(((t - 0.5) / 0.22) ** 2));
    const radius = t < SHAFT ? 0.2 + bulge + 0.16 * Math.exp(-y / 0.7) : 0.19 - 0.12 * ((t - SHAFT) / (1 - SHAFT));
    const lean = [0.06 * Math.sin(t * 2.4), y, 0.04 * Math.sin(t * 1.7)];
    rings.push({ at: lean, radius, colour: t < SHAFT ? pale : shaftColour });
  }
  tube(mesh, rings, 12, 2, 0.45, 0.62);
  const crown = rings.at(-1).at, FRONDS = 16;
  for (let f = 0; f < FRONDS; f++) {
    const age = f / (FRONDS - 1), elevation = (78 - 88 * age) * (Math.PI / 180);
    frond({ mesh }, { mesh: leaves }, leafIndices, rng, add(crown, [0, -0.5 * age, 0]), f * GOLDEN, elevation, { frondLength: 3.7, droop: 1.15, rachisRadius: 0.055, leafletPairs: 78, leafletLength: 0.82, leafletWidth: 0.05, leafletSag: 0.5, plumes: true }, age);
  }
  return { mesh, leaves, leafIndices, height, crownRadius: 3.9, basalRadius: 0.36, far: { crownLow: height * 0.72, crownHigh: height * 1.1, crownRadius: 3.9, trunkRadius: 0.26, trunkHeight: height * 0.86, flare: 1.12 } };
}

function growCoconut() {
  const rng = random(23), height = 10.4, mesh = new Mesh(), leaves = new Mesh(), leafIndices = [];
  const RINGS = 40, rings = [];
  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS, y = t * height;
    const ringScar = r % 2 ? 1 : 1.035;
    const radius = (0.13 + 0.05 * (1 - t) + 0.22 * Math.exp(-y / 0.55)) * ringScar;
    const shade = r % 2 ? 1 : 0.8;
    const lean = [1.5 * t * t + 0.18 * Math.sin(t * 5), y * (1 - 0.04 * t), 0.5 * t * t];
    rings.push({ at: lean, radius, colour: [1 * shade, 0.92 * shade, 0.8 * shade] });
  }
  tube(mesh, rings, 10, 2, 0.5, 0.6);
  const crown = rings.at(-1).at, FRONDS = 26;
  coconuts(mesh, rng, crown, 11);
  for (let f = 0; f < FRONDS; f++) {
    const age = f / (FRONDS - 1), elevation = (70 - 95 * age) * (Math.PI / 180);
    frond({ mesh }, { mesh: leaves }, leafIndices, rng, add(crown, [0, -0.35 * age, 0]), f * GOLDEN, elevation, { frondLength: 4.5, droop: 1.45, rachisRadius: 0.05, leafletPairs: 62, leafletLength: 0.92, leafletWidth: 0.055, leafletSag: 0.85, plumes: false }, age);
  }
  return { mesh, leaves, leafIndices, height, crownRadius: 4.8, basalRadius: 0.34, far: { crownLow: height * 0.62, crownHigh: height * 1.08, crownRadius: 4.2, trunkRadius: 0.2, trunkHeight: height * 0.9, flare: 1.12 } };
}

// A limb or twig: a curving path, bent by a pull upward and a little wander, as a tapered tube.
function limb(mesh, rng, { start, direction, length, radius, tip = 0.25, segments, sides, pull = 0, wander = 0.2, colour, shade }) {
  const rings = [], points = [];
  let at = start, along = unit(direction);
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    rings.push({ at, radius: radius * (1 - (1 - tip) * t), colour });
    points.push({ at, along, t });
    along = unit(add(add(along, [0, pull / segments, 0]), [(rng() - 0.5) * wander, (rng() - 0.5) * wander * 0.4, (rng() - 0.5) * wander]));
    at = add(at, mul(along, length / segments));
  }
  tube(mesh, rings, sides, 1, 1 / Math.max(0.2, radius * 8), shade);
  return points;
}
const pointOn = (points, t) => points[Math.min(points.length - 1, Math.round(t * (points.length - 1)))];
function splay(direction, rng, spread, lift = 0) {
  const side = unit(cross(direction, Math.abs(direction[1]) > 0.9 ? [1, 0, 0] : UP)), other = cross(direction, side);
  const angle = rng() * Math.PI * 2, tilt = Math.tan(spread) * (0.6 + 0.4 * rng());
  return unit(add(add(direction, add(mul(side, Math.cos(angle) * tilt), mul(other, Math.sin(angle) * tilt))), [0, lift, 0]));
}
// How much open sky a leaf sees: dark deep in the crown, bright on its outer shell.
function crownLight(at, crown) {
  const d = [(at[0] - crown.centre[0]) / crown.radius, (at[1] - crown.centre[1]) / crown.depth, (at[2] - crown.centre[2]) / crown.radius];
  const out = Math.min(1, Math.hypot(d[0], d[1], d[2]));
  return { shade: 0.42 + 0.46 * out * out, outward: unit([d[0], d[1] + 0.25, d[2]]) };
}

function growCeiba() {
  const rng = random(37), height = 18.5, mesh = new Mesh(), leaves = new Mesh(), leafIndices = [];
  const bole = height * 0.64, rings = [], FINS = 6, FIN_STEPS = 34, colour = [0.82, 0.82, 0.74];
  for (let r = 0; r <= FIN_STEPS; r++) {
    const t = r / FIN_STEPS, y = t * t * bole, radius = 0.34 + 0.2 * (1 - t) ** 1.5;
    // Plank buttresses: thin fins running out from the trunk, gone a few metres up.
    const fin = 4.2 * Math.exp(-y / 1.25);
    rings.push({ at: [0.02 * Math.sin(y * 0.4), y - 0.25, 0.02 * Math.cos(y * 0.3)], radius, colour, shape: (angle) => 1 + fin * Math.max(0, Math.cos(FINS * angle / 2 + 0.6)) ** 10 });
  }
  tube(mesh, rings, 36, 3, 0.35, 0.56);
  const crown = { centre: [0, height * 0.82, 0], radius: 11, depth: 3.6 };
  const barkColour = [0.7, 0.7, 0.62];
  const TIERS = 5;
  for (let tier = 0; tier < TIERS; tier++) {
    const y = bole * (0.8 + 0.2 * (tier / (TIERS - 1)));
    const count = 4, offset = tier * 1.1;
    for (let n = 0; n < count; n++) {
      const azimuth = offset + (n / count) * Math.PI * 2 + (rng() - 0.5) * 0.5, elevation = (8 + tier * 6 + rng() * 8) * (Math.PI / 180);
      const direction = [Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation)];
      const main = limb(mesh, rng, { start: [0, y, 0], direction, length: 6.4 + rng() * 2.4 - tier * 0.5, radius: 0.2 - tier * 0.015, segments: 7, sides: 6, pull: 0.08, wander: 0.09, colour: barkColour, shade: 0.5 });
      const SIDE = 7;
      for (let b = 0; b < SIDE; b++) {
        const on = pointOn(main, 0.32 + (0.68 * b) / (SIDE - 1));
        const branch = limb(mesh, rng, { start: on.at, direction: splay(on.along, rng, 0.75, 0.08), length: 2.4 + rng() * 1.5, radius: 0.05, segments: 3, sides: 4, pull: 0.04, wander: 0.2, colour: barkColour, shade: 0.54 });
        for (let w = 0; w < 8; w++) {
          const near = pointOn(branch, 0.15 + 0.85 * (w / 7));
          const twig = limb(mesh, rng, { start: near.at, direction: splay(near.along, rng, 0.8, 0.06), length: 0.9 + rng() * 0.6, radius: 0.016, segments: 2, sides: 3, wander: 0.2, colour: [0.5, 0.52, 0.34], shade: 0.6 });
          // Hands of leaflets, as a ceiba's palmate leaves are.
          for (let hand = 0; hand < 5; hand++) {
            const node = add(pointOn(twig, 0.2 + 0.2 * hand).at, [0, 0.02, 0]);
            const { shade, outward } = crownLight(node, crown);
            const material = LEAFLET[Math.floor(rng() * LEAFLET.length)], turn = rng() * Math.PI * 2;
            for (let f = 0; f < 6; f++) {
              const a = turn + (f / 6) * Math.PI * 2;
              const dir = unit([Math.cos(a), -0.12 + rng() * 0.2, Math.sin(a)]);
              const across = unit(cross(dir, UP));
              const tint = 0.9 + rng() * 0.15;
              leaflet(leaves, leafIndices, node, dir, across, 0.48 + rng() * 0.12, 0.18, 0.22, [tint, tint, tint * 0.92], material, shade, outward);
            }
          }
        }
      }
    }
  }
  return { mesh, leaves, leafIndices, height, crownRadius: crown.radius, basalRadius: 1.1, far: { crownLow: height * 0.66, crownHigh: height * 1.02, crownRadius: crown.radius, trunkRadius: 0.5, trunkHeight: bole, flare: 1.38 } };
}

function growMangrove() {
  const rng = random(53), height = 7.8, mesh = new Mesh(), leaves = new Mesh(), leafIndices = [];
  const crown = { centre: [0, 5.1, 0], radius: 4.7, depth: 2.9 };
  const barkColour = [1, 0.86, 0.74], rootColour = [0.92, 0.74, 0.6];
  const STEMS = 3, stems = [];
  for (let s = 0; s < STEMS; s++) {
    const a = (s / STEMS) * Math.PI * 2 + 0.4, lean = 0.22 + rng() * 0.18;
    stems.push(limb(mesh, rng, { start: [Math.cos(a) * 0.12, 0.55, Math.sin(a) * 0.12], direction: [Math.cos(a) * lean, 1, Math.sin(a) * lean], length: 3.2 + rng() * 0.7, radius: 0.13, tip: 0.5, segments: 5, sides: 7, pull: -0.1, wander: 0.2, colour: barkColour, shade: 0.5 }));
  }
  // Prop roots arch out of the stems and down into the mud, which is what makes it a mangrove.
  const ROOTS = 20;
  for (let r = 0; r < ROOTS; r++) {
    const stem = stems[r % STEMS], from = pointOn(stem, rng() * 0.42).at, a = (r / ROOTS) * Math.PI * 2 + rng() * 0.3;
    const reach = 1.5 + rng() * 2.1, control = [from[0] + Math.cos(a) * reach * 0.55, from[1] + 0.5, from[2] + Math.sin(a) * reach * 0.55];
    const end = [Math.cos(a) * reach, -0.35, Math.sin(a) * reach], rings = [], STEPS = 8, thick = 0.04 + rng() * 0.02;
    for (let k = 0; k <= STEPS; k++) {
      const t = k / STEPS, u = 1 - t;
      rings.push({ at: [u * u * from[0] + 2 * u * t * control[0] + t * t * end[0], u * u * from[1] + 2 * u * t * control[1] + t * t * end[1], u * u * from[2] + 2 * u * t * control[2] + t * t * end[2]], radius: thick * (1 + 0.5 * t), colour: rootColour });
    }
    tube(mesh, rings, 4, 1, 1.2, 0.42);
  }
  // A dense low dome: limbs from each stem, branches, then twigs carrying thick leaves in pairs.
  for (const stem of stems) {
    for (let l = 0; l < 6; l++) {
      const on = pointOn(stem, 0.5 + 0.5 * (l / 5));
      const main = limb(mesh, rng, { start: on.at, direction: splay(on.along, rng, 0.95, 0.05), length: 2.1 + rng() * 1.1, radius: 0.055, segments: 4, sides: 5, pull: 0.05, wander: 0.32, colour: barkColour, shade: 0.5 });
      for (let b = 0; b < 7; b++) {
        const near = pointOn(main, 0.15 + 0.85 * (b / 6));
        const branch = limb(mesh, rng, { start: near.at, direction: splay(near.along, rng, 0.85, 0.05), length: 1 + rng() * 0.7, radius: 0.02, segments: 2, sides: 3, wander: 0.3, colour: barkColour, shade: 0.55 });
        for (let w = 0; w < 9; w++) {
          const twig = limb(mesh, rng, { start: pointOn(branch, 0.1 + 0.9 * (w / 8)).at, direction: splay(near.along, rng, 0.9, 0.1), length: 0.48 + rng() * 0.3, radius: 0.008, segments: 2, sides: 3, wander: 0.2, colour: [0.42, 0.42, 0.26], shade: 0.6 });
          const material = LEAFLET[Math.floor(rng() * LEAFLET.length)];
          for (let pair = 0; pair < 5; pair++) {
            const point = pointOn(twig, 0.2 + (0.8 * pair) / 4), { shade, outward } = crownLight(point.at, crown);
            for (const hand of [-1, 1]) {
              const dir = unit(add(mul(unit(cross(point.along, UP)), hand), mul(point.along, 0.75)));
              const across = unit(cross(dir, UP)), tint = 0.92 + rng() * 0.12;
              leaflet(leaves, leafIndices, point.at, dir, across, 0.38 + rng() * 0.08, 0.2, 0.12, [tint, tint, tint], material, shade, outward);
            }
          }
        }
      }
    }
  }
  return { mesh, leaves, leafIndices, height, crownRadius: crown.radius, basalRadius: 0.55, far: { crownLow: 2.6, crownHigh: height, crownRadius: crown.radius, trunkRadius: 0.3, trunkHeight: 3, flare: 1.38 } };
}

const grown = { royal_palm: growRoyalPalm(), palm: growCoconut(), ceiba: growCeiba(), mangrove: growMangrove() };
const vertices = [], indices = [];
const appendOld = (range, remap) => {
  const first = indices.length;
  for (let k = 0; k < range.indexCount; k++) {
    const old = oldIndices[range.firstIndex + k];
    if (!remap.has(old)) { remap.set(old, vertices.length / STRIDE); for (let w = 0; w < STRIDE; w++) vertices.push(oldVertices[old * STRIDE + w]); }
    indices.push(remap.get(old));
  }
  return { ...range, firstIndex: first };
};
// The far model is a small dome on a post, which the far shader widens and squashes. These undo that
// so that it matches the grown tree's real crown, and it holds the same size when the tree hands over.
function fitFarModel(far, fit) {
  const used = [...new Set(Array.from({ length: far.indexCount }, (_, k) => indices[far.firstIndex + k]))];
  const WOOD_KIND = 3.5;
  const crown = used.filter((v) => vertices[v * STRIDE + 6] >= WOOD_KIND), post = used.filter((v) => vertices[v * STRIDE + 6] < WOOD_KIND);
  const reach = (list) => Math.max(...list.map((v) => Math.hypot(vertices[v * STRIDE], vertices[v * STRIDE + 2])), 1e-3);
  const heights = (list) => list.map((v) => vertices[v * STRIDE + 1]);
  const crownReach = reach(crown), crownLow = Math.min(...heights(crown)), crownHigh = Math.max(...heights(crown));
  for (const v of crown) {
    const at = v * STRIDE, t = (vertices[at + 1] - crownLow) / Math.max(crownHigh - crownLow, 1e-3);
    vertices[at] *= fit.crownRadius / (crownReach * fit.flare); vertices[at + 2] *= fit.crownRadius / (crownReach * fit.flare);
    vertices[at + 1] = (fit.crownLow + (fit.crownHigh - fit.crownLow) * t + 0.35) / 0.66;
  }
  const postReach = reach(post), postHigh = Math.max(...heights(post));
  for (const v of post) {
    const at = v * STRIDE;
    vertices[at] *= fit.trunkRadius / (postReach * 2.6); vertices[at + 2] *= fit.trunkRadius / (postReach * 2.6);
    vertices[at + 1] *= fit.trunkHeight / (Math.max(postHigh, 1e-3) * 0.72);
  }
}
const appendNew = (mesh, list) => {
  const base = vertices.length / STRIDE, first = indices.length;
  for (const v of mesh.vertices) vertices.push(v);
  for (const i of list) indices.push(i + base);
  return { firstIndex: first, indexCount: list.length };
};
for (const p of manifest.prototypes) {
  const remap = new Map(), palm = grown[p.species];
  if (!palm) throw Error(`No growth recipe for ${p.species}`);
  const wood = appendNew(palm.mesh, palm.mesh.indices), leaf = appendNew(palm.leaves, palm.leafIndices);
  p.wood = { ...p.wood, ...wood }; p.leaf = { ...p.leaf, ...leaf }; p.far = appendOld(p.far, remap);
  fitFarModel(p.far, palm.far);
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const m of [palm.mesh, palm.leaves]) for (let i = 0; i < m.vertices.length; i += STRIDE) for (let a = 0; a < 3; a++) { low[a] = Math.min(low[a], m.vertices[i + a]); high[a] = Math.max(high[a], m.vertices[i + a]); }
  for (let k = 0; k < p.far.indexCount; k++) {
    const at = indices[p.far.firstIndex + k] * STRIDE;
    for (let a = 0; a < 3; a++) { low[a] = Math.min(low[a], vertices[at + a]); high[a] = Math.max(high[a], vertices[at + a]); }
  }
  const centre = [0, 1, 2].map((a) => (low[a] + high[a]) / 2);
  p.low = low; p.high = high; p.centre = centre; p.radius = Math.hypot(...sub(high, centre));
  p.heightMetres = palm.height; p.crownRadiusMetres = palm.crownRadius; p.crownRadius = palm.crownRadius; p.basalRadius = palm.basalRadius;
  console.log(p.species.padEnd(11), `wood ${wood.indexCount / 3} tris, ${leaf.indexCount / 12} leaflets, ${leaf.indexCount / 3} tris, radius ${p.radius.toFixed(1)} m`);
  for (const material of p.nativeMaterials) {
    if (!material.name.startsWith('foliage')) continue;
    const bytes = fs.readFileSync(`${DIR}/${material.albedo.file}`);
    material.albedo.bytes = bytes.length; material.albedo.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
}
const certified = { from: { vertices: manifest.files['vertices.bin'].sha256, indices: manifest.files['indices.bin'].sha256 } };
const receipt = (name, data, count, countKey) => {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength), gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(`${DIR}/${name}.gz`, gz);
  manifest.files[name] = { ...manifest.files[name], bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), gzip: { file: `${name}.gz`, bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex') }, [countKey]: count };
};
receipt('vertices.bin', Float32Array.from(vertices), vertices.length / STRIDE, 'vertexCount');
receipt('indices.bin', Uint32Array.from(indices), indices.length, 'indexCount');
// The loader skips its long geometry checks for streams it recognises, so it must recognise these.
let loader = fs.readFileSync('js/forest-scenery.js', 'utf8');
loader = loader.replace(certified.from.vertices, manifest.files['vertices.bin'].sha256).replace(certified.from.indices, manifest.files['indices.bin'].sha256);
fs.writeFileSync('js/forest-scenery.js', loader);
fs.writeFileSync(`${DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log('vertices', vertices.length / STRIDE, 'indices', indices.length, 'sha', manifest.files['vertices.bin'].sha256.slice(0, 12));
