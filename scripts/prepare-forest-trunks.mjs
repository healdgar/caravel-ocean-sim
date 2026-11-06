#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A ball meets a tree's wood as chains of round sections, one table per species. This measures them from the wood the
// forest draws: each tube's rings are found from the mesh's own connections, and a ring counts only if its wood faces out
// from its middle, all round, at one distance. Nothing here is written by hand, so rerun it after changing a pack.
//
//   node scripts/prepare-forest-trunks.mjs
//
// Writes js/forest-trunk-shapes.js. tests/forest-trunks.test.mjs holds the table to the meshes.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
export const FOREST_PACK_SETS = Object.freeze(['subtropical', 'saba']);
// A ball goes through wood thinner than itself. 24-pounder shot is 7.3 cm in radius; trees stand at scale one or more.
export const TRUNK_SHAPE_MIN_RADIUS_M = 0.06;
export const TRUNK_STEM_MIN_RADIUS_M = 0.015;
const RING_TOLERANCE_M = 0.035;
const SOIL_CLEARANCE_M = 0.15;
const STRIDE = 14;

export function readForestPack(set) {
  const dir = new URL(`assets/forest-scenery/${set}/`, root), manifest = JSON.parse(readFileSync(new URL('manifest.json', dir)));
  const vb = gunzipSync(readFileSync(new URL('vertices.bin.gz', dir))), ib = gunzipSync(readFileSync(new URL('indices.bin.gz', dir)));
  return { manifest, vertices: new Float32Array(vb.buffer, vb.byteOffset, vb.byteLength / 4), indices: new Uint32Array(ib.buffer, ib.byteOffset, ib.byteLength / 4) };
}

// The wood welded across seams, with what is joined to what.
export function weldForestWood(prototype, vertices, indices) {
  const { firstIndex, indexCount } = prototype.wood, ids = new Map(), positions = [], normals = [], triangles = new Uint32Array(indexCount);
  const idOf = (v) => {
    const at = v * STRIDE, key = `${Math.round(vertices[at] * 1000)},${Math.round(vertices[at + 1] * 1000)},${Math.round(vertices[at + 2] * 1000)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      ids.set(key, id);
      positions.push(vertices[at], vertices[at + 1], vertices[at + 2]);
      normals.push(vertices[at + 3], vertices[at + 4], vertices[at + 5]);
    }
    return id;
  };
  for (let i = 0; i < indexCount; i++) triangles[i] = idOf(indices[firstIndex + i]);
  const count = positions.length / 3, neighbours = Array.from({ length: count }, () => new Set()), edgeUse = new Map();
  const edge = (a, b) => {
    if (a === b) return;
    neighbours[a].add(b); neighbours[b].add(a);
    const key = a < b ? a * count + b : b * count + a;
    edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
  };
  for (let t = 0; t < indexCount; t += 3) { edge(triangles[t], triangles[t + 1]); edge(triangles[t + 1], triangles[t + 2]); edge(triangles[t + 2], triangles[t]); }
  const open = new Set();
  for (const [key, uses] of edgeUse) if (uses === 1) { open.add(Math.floor(key / count)); open.add(key % count); }
  return { positions: Float64Array.from(positions), normals: Float64Array.from(normals), triangles, neighbours, open, count };
}

const centroidOf = (group, positions) => {
  let x = 0, y = 0, z = 0;
  for (const v of group) { x += positions[v * 3]; y += positions[v * 3 + 1]; z += positions[v * 3 + 2]; }
  return [x / group.length, y / group.length, z / group.length];
};
const meanRadius = (group, c, positions) => {
  let r = 0;
  for (const v of group) r += Math.hypot(positions[v * 3] - c[0], positions[v * 3 + 1] - c[1], positions[v * 3 + 2] - c[2]);
  return r / group.length;
};

// Where a tube's wave of rings starts: the lowest open end of its thickest, or else its lowest point.
function ringSource(component, wood) {
  const { positions, neighbours, open } = wood;
  const edges = component.filter((v) => open.has(v)), seen = new Set(), loops = [];
  for (const start of edges) {
    if (seen.has(start)) continue;
    const loop = [], stack = [start];
    seen.add(start);
    while (stack.length) {
      const v = stack.pop();
      loop.push(v);
      for (const n of neighbours[v]) if (open.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
    }
    loops.push(loop);
  }
  let lowest = component[0];
  for (const v of component) if (positions[v * 3 + 1] < positions[lowest * 3 + 1]) lowest = v;
  let best = null, bestScore = -Infinity;
  for (const loop of loops) {
    const c = centroidOf(loop, positions), r = meanRadius(loop, c, positions);
    if (loop.length < 5 || r > 1.5) continue;
    const score = r - c[1] * 0.02;
    if (score > bestScore) { bestScore = score; best = loop; }
  }
  if (best && meanRadius(best, centroidOf(best, positions), positions) > 0.03) return best;
  // A tube closed at its foot starts from the ring standing at its foot: level if it stands upright, else square to
  // the way the tube runs.
  const level = component.filter((v) => positions[v * 3 + 1] <= positions[lowest * 3 + 1] + 0.012);
  if (level.length >= 4) return level;
  const middle = centroidOf(component, positions), axis = [0, 1, 2].map((k) => middle[k] - positions[lowest * 3 + k]), length = Math.hypot(...axis) || 1;
  let nearest = Infinity;
  for (const n of neighbours[lowest]) nearest = Math.min(nearest, Math.hypot(positions[n * 3] - positions[lowest * 3], positions[n * 3 + 1] - positions[lowest * 3 + 1], positions[n * 3 + 2] - positions[lowest * 3 + 2]));
  const along = (v) => ((positions[v * 3] - positions[lowest * 3]) * axis[0] + (positions[v * 3 + 1] - positions[lowest * 3 + 1]) * axis[1] + (positions[v * 3 + 2] - positions[lowest * 3 + 2]) * axis[2]) / length;
  const ring = component.filter((v) => along(v) <= Math.max(0.012, nearest * 0.35));
  return ring.length >= 4 ? ring : [lowest];
}

// Rings in order along each tube: a wave of equal mesh distance from the source, split where the tube branches.
export function forestWoodRings(wood) {
  const { positions, neighbours, count } = wood, component = new Int32Array(count).fill(-1), components = [];
  for (let v = 0; v < count; v++) {
    if (component[v] >= 0 || !neighbours[v].size) continue;
    const list = [], stack = [v];
    component[v] = components.length;
    while (stack.length) {
      const a = stack.pop();
      list.push(a);
      for (const b of neighbours[a]) if (component[b] < 0) { component[b] = components.length; stack.push(b); }
    }
    components.push(list);
  }
  const ringOf = new Int32Array(count).fill(-1), rings = [];
  for (const list of components) {
    let frontier = ringSource(list, wood);
    for (const v of frontier) ringOf[v] = -2;
    while (frontier.length) {
      const inFrontier = new Set(frontier), grouped = new Set(), next = [];
      for (const start of frontier) {
        if (grouped.has(start)) continue;
        const group = [], stack = [start];
        grouped.add(start);
        while (stack.length) {
          const a = stack.pop();
          group.push(a);
          for (const b of neighbours[a]) if (inFrontier.has(b) && !grouped.has(b)) { grouped.add(b); stack.push(b); }
        }
        const id = rings.length, centre = centroidOf(group, positions);
        rings.push({ id, centre, radius: meanRadius(group, centre, positions), size: group.length, parents: new Set(), round: ringRoundness(group, centre, wood) });
        for (const v of group) ringOf[v] = id;
        for (const v of group) for (const n of neighbours[v]) if (ringOf[n] >= 0 && ringOf[n] !== id) rings[id].parents.add(ringOf[n]);
      }
      for (const v of frontier) for (const n of neighbours[v]) if (ringOf[n] === -1) { ringOf[n] = -2; next.push(n); }
      frontier = next;
    }
  }
  return rings;
}

// How much a wave of vertices is a ring round a tube: its wood faces away from its middle, all round, at one distance.
// A mat of roots or a wave crossing a fork does not.
function ringRoundness(group, centre, { positions, normals }) {
  let outward = 0, sum = 0, sum2 = 0;
  for (const v of group) {
    const dx = positions[v * 3] - centre[0], dy = positions[v * 3 + 1] - centre[1], dz = positions[v * 3 + 2] - centre[2], d = Math.hypot(dx, dy, dz) || 1;
    outward += (dx * normals[v * 3] + dy * normals[v * 3 + 1] + dz * normals[v * 3 + 2]) / d;
    sum += d;
    sum2 += d * d;
  }
  const mean = sum / group.length, spread = Math.sqrt(Math.max(0, sum2 / group.length - mean * mean));
  return { outward: outward / group.length, spread: spread / (mean || 1) };
}

const isTubeRing = (ring) => ring.size >= 4 && ring.round.outward >= 0.55 && ring.round.spread <= 0.42;

// Rings of tubes at least this thick, joined into chains running up each tube, thickest first.
export function trunkChains(rings, minRadius = TRUNK_SHAPE_MIN_RADIUS_M) {
  const good = new Map();
  for (const ring of rings) if (ring.radius >= minRadius && isTubeRing(ring)) good.set(ring.id, { ...ring, children: [] });
  for (const ring of good.values()) for (const parent of ring.parents) if (good.has(parent)) good.get(parent).children.push(ring.id);
  const taken = new Set(), chains = [];
  const walk = (start) => {
    const chain = [start];
    let at = start;
    taken.add(start.id);
    for (;;) {
      const next = at.children.map((id) => good.get(id)).filter((r) => !taken.has(r.id)).sort((a, b) => b.radius - a.radius)[0];
      if (!next) break;
      taken.add(next.id);
      chain.push(next);
      at = next;
    }
    return chain;
  };
  for (const start of [...good.values()].filter((r) => ![...r.parents].some((p) => good.has(p))).sort((a, b) => b.radius - a.radius)) chains.push(walk(start));
  for (;;) {
    const branch = [...good.values()].filter((r) => !taken.has(r.id)).sort((a, b) => b.radius - a.radius)[0];
    if (!branch) break;
    const parent = [...branch.parents].map((p) => good.get(p)).find(Boolean), chain = walk(branch);
    if (parent) chain.unshift(parent);
    chains.push(chain);
  }
  return chains.filter((chain) => chain.length > 1);
}

// Fewer sections, none straying from the rings by more than the tolerance.
function simplify(chain, tolerance = RING_TOLERANCE_M) {
  const keep = new Uint8Array(chain.length);
  keep[0] = keep[chain.length - 1] = 1;
  const stack = [[0, chain.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const A = chain[a], B = chain[b], ab = [0, 1, 2].map((k) => B.centre[k] - A.centre[k]), length2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
    let worst = -1, worstError = tolerance;
    for (let i = a + 1; i < b; i++) {
      const C = chain[i], t = Math.max(0, Math.min(1, ((C.centre[0] - A.centre[0]) * ab[0] + (C.centre[1] - A.centre[1]) * ab[1] + (C.centre[2] - A.centre[2]) * ab[2]) / length2));
      const off = Math.hypot(C.centre[0] - A.centre[0] - ab[0] * t, C.centre[1] - A.centre[1] - ab[1] * t, C.centre[2] - A.centre[2] - ab[2] * t);
      const error = off + Math.abs(C.radius - (A.radius + (B.radius - A.radius) * t));
      if (error > worstError) { worstError = error; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return chain.filter((_, i) => keep[i]);
}

// A trunk stands on the ground and rises: however slender, it is what a ball must meet. Other wood counts only if it is
// as thick as a ball. A clump has several trunks. Roots and low limbs, which do not rise, are not trunks.
export function measureTrunkShape(prototype, vertices, indices, { minRadius = TRUNK_SHAPE_MIN_RADIUS_M, stemRadius = TRUNK_STEM_MIN_RADIUS_M } = {}) {
  const wood = weldForestWood(prototype, vertices, indices), rings = forestWoodRings(wood);
  const rise = (chain) => Math.max(...chain.map((r) => r.centre[1])), foot = (chain) => Math.min(...chain.map((r) => r.centre[1]));
  const stemsAll = trunkChains(rings, stemRadius).filter((chain) => foot(chain) < Math.max(1.5, prototype.high[1] * 0.12));
  const top = Math.max(0, ...stemsAll.map(rise));
  const stems = stemsAll.filter((chain) => rise(chain) >= top * 0.45);
  const onStem = new Set(stems.flatMap((chain) => chain.map((r) => r.id)));
  // Roots under the soil line are pressed flat onto it by the shader, where the ground stops a ball first.
  const limbs = trunkChains(rings.filter((ring) => !onStem.has(ring.id) && ring.centre[1] >= SOIL_CLEARANCE_M), minRadius);
  // Adding zero turns the minus zero a small negative rounds to into plain zero, as it reads back from the table.
  const flat = (chain) => simplify(chain).flatMap((r) => [...r.centre.map((v) => +v.toFixed(2) + 0), +r.radius.toFixed(3)]);
  return { species: prototype.species, trunks: stems.sort((a, b) => rise(b) - rise(a)).map(flat), limbs: limbs.map(flat) };
}

export function writeForestTrunkShapes(shapes) {
  const lines = ['// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.',
    '// Generated from the wood each forest pack draws by scripts/prepare-forest-trunks.mjs. Do not edit.',
    '// Metres in a tree\'s own frame, before its yaw and scale. Each chain is x, y, z, radius at each ring, along one tube.',
    'export const FOREST_TRUNK_SHAPES = Object.freeze({'];
  for (const shape of shapes) {
    lines.push(`  ${shape.species}: { trunks: ${JSON.stringify(shape.trunks)}, limbs: ${JSON.stringify(shape.limbs)} },`);
  }
  lines.push('});', '');
  writeFileSync(new URL('js/forest-trunk-shapes.js', root), lines.join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shapes = [];
  for (const set of FOREST_PACK_SETS) {
    const { manifest, vertices, indices } = readForestPack(set);
    for (const prototype of manifest.prototypes) {
      const shape = measureTrunkShape(prototype, vertices, indices);
      shapes.push(shape);
      const nodes = (chains) => chains.reduce((n, chain) => n + chain.length / 4, 0);
      console.log(`${shape.species}: ${shape.trunks.length} trunk chains, ${nodes(shape.trunks)} rings; ${shape.limbs.length} limb chains, ${nodes(shape.limbs)} rings`);
    }
  }
  writeForestTrunkShapes(shapes);
}
