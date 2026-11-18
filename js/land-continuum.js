// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The land through the one continuum (AGENTS.md rule 3; js/wgsl/land-continuum.js for its programs). A piece of land
// is baked once, when it comes or its ground or a neighbour's changes: its lattice of heights, a quadtree of patches
// over it with each patch's error, and for every lattice point the error its morph waits for. Every frame the GPU
// cuts every piece at the scene's one pixel error and draws each piece's lists with indirect calls.
//
// The finest cut is the lattice itself, which the height queries read (terrainSurfaceSample in js/terrain-model.js),
// and below it, where shot has dug or a river runs, the pits to the crater tiles' own cell and the banks to theirs
// (landContinuumDig).
//
// After the cut, the land writes the ground it has chosen to draw into the field every family that stands on the
// ground reads (js/continuum-ground.js), on the GPU, from the patches each cut kept.
import { requestOnce } from './gpu-program-cache.js';
import {
  LAND_CONTINUUM_PATCH, LAND_CONTINUUM_TESSELLATIONS, LAND_CONTINUUM_LISTS, LAND_CONTINUUM_SLOTS, LAND_CONTINUUM_DRAW_WORDS,
  LAND_CONTINUUM_RECORDS, LAND_CONTINUUM_CAPTURE_COARSENING, LAND_CONTINUUM_NODE_WORDS, LAND_CONTINUUM_POINT_FLOATS,
  LAND_CONTINUUM_PIECE_BYTES, LAND_CONTINUUM_VIEW_BYTES, landContinuumIndices, landContinuumCutWGSL,
  landContinuumFinest, landGroundWriteWGSL, LAND_GROUND_ROOM, LAND_GROUND_WORK_WORDS,
} from './wgsl/land-continuum.js';
import { continuumGroundField, continuumGroundForget, CONTINUUM_GROUND_TEXELS, CONTINUUM_GROUND_CUTS, CONTINUUM_GROUND_LEVELS } from './continuum-ground.js';
import { continuumPixelError } from './continuum-core.js';

// How much a parent's error stands above its children's, so that a parent and its child are never both drawn.
const LAND_CONTINUUM_RISE = 1.01;
// Height a node's sphere keeps over its ground for the morph's own motion, beyond twice its error.
const LAND_CONTINUUM_ROOM = 0.25;
const landLog2 = (value) => {
  const shift = Math.round(Math.log2(value));
  if (!(value > 0) || 2 ** shift !== value) throw new Error(`Land continuum needs a power of two, not ${value}`);
  return shift;
};
const landTrailing = (value, cap) => (value === 0 ? cap : Math.min(cap, 31 - Math.clz32(value & -value)));
const landFround = Math.fround;

/**
 * Bake one piece. `spec`:
 *   n, cell, heights, kind     the lattice: side, grid units a cell, heights and kind.y (n * n each)
 *   gx, gz                     grid point of the lattice's (0,0)
 *   window                     a finer lattice inside it, or null: {n, cell, gx, gz, heights, kind}, lying on
 *                              coarse cells and holding the coarse heights where their points meet
 *   edges                      lattice units between the points each edge shares with its neighbour, [x = 0, x = N,
 *                              z = 0, z = N]; the edge's other points must already lie on the line between those
 *   grid                       the grid every piece is placed on: {x0, z0, g}
 *   marks                      what lies on the lattice finer than it: pits shot has dug, a river's banks
 *                              (landContinuumDig)
 * Returns the lattice records, the node records and the piece's numbers, the nodes in finest units
 * (landContinuumFinest); the lattice's own units are worked in here and in the helpers it returns, nowhere else.
 */
export function bakeLandContinuumPiece(spec) {
  const { n, cell, heights, kind = null, window = null } = spec;
  const fine = window ? window.cell : cell, shiftF = landLog2(fine), bs = landLog2(cell / fine);
  const N = (n - 1) << bs, T = landLog2(N);
  const wn = window ? window.n - 1 : 0, wx = window ? (window.gx - spec.gx) / fine : 0, wz = window ? (window.gz - spec.gz) / fine : 0;
  if (window && (!Number.isInteger(wx) || !Number.isInteger(wz) || wx % (1 << bs) || wz % (1 << bs) || wn % (1 << bs))) throw new Error('Land continuum window must lie on coarse cells');
  const baseCount = n * n, winCount = window ? window.n * window.n : 0, P = LAND_CONTINUUM_POINT_FLOATS;
  const lattice = new Float32Array((baseCount + winCount) * P);
  for (let k = 0; k < baseCount; k++) { lattice[k * P] = heights[k]; lattice[k * P + 1] = kind ? kind[k] : 0; }
  for (let k = 0; k < winCount; k++) { lattice[(baseCount + k) * P] = window.heights[k]; lattice[(baseCount + k) * P + 1] = window.kind ? window.kind[k] : 0; }
  const windowed = (x, z) => wn > 0 && x >= wx && z >= wz && x <= wx + wn && z <= wz + wn;
  const at = (x, z) => (windowed(x, z) ? baseCount + (z - wz) * (wn + 1) + (x - wx) : (z >> bs) * n + (x >> bs)) * P;
  const h = (x, z) => lattice[at(x, z)];
  // Every lattice point once: the coarse lattice's outside the window, then the window's.
  const points = (level, visit) => {
    if (level >= bs) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const x = i << bs, z = j << bs; if (!windowed(x, z)) visit(x, z); }
    for (let j = 0; j <= wn; j++) for (let i = 0; i <= wn; i++) visit(wx + i, wz + j);
  };
  // Levels: patches of 16 cells at stride 2^level while they fit, then the root's far end, one patch of fewer cells.
  const levels = [];
  let total = 0;
  for (let level = 0; level <= T; level++) {
    const extent = Math.min(LAND_CONTINUUM_PATCH << level, N), side = N / extent, cells = extent >> level;
    levels.push({ level, extent, side, cells, first: total, list: LAND_CONTINUUM_TESSELLATIONS.indexOf(cells) });
    total += side * side;
  }
  const exists = (L, ix, iz) => L.level >= bs || (wn > 0 && ix * L.extent >= wx && iz * L.extent >= wz && (ix + 1) * L.extent <= wx + wn && (iz + 1) * L.extent <= wz + wn);
  const error = new Float32Array(total), low = new Float32Array(total).fill(Infinity), high = new Float32Array(total).fill(-Infinity);
  const leaf = new Uint8Array(total);
  // Each node's error: the most the ground departs from its level's triangles anywhere in it, its edges included.
  for (const L of levels) {
    const s = 1 << L.level, cellsAcross = N / s;
    points(L.level, (x, z) => {
      const cx = Math.min(Math.floor(x / s), cellsAcross - 1), cz = Math.min(Math.floor(z / s), cellsAcross - 1);
      const a = (x - cx * s) / s, b = (z - cz * s) / s, x0 = cx * s, z0 = cz * s;
      const line = a + b <= 1
        ? h(x0, z0) + a * (h(x0 + s, z0) - h(x0, z0)) + b * (h(x0, z0 + s) - h(x0, z0))
        : h(x0 + s, z0 + s) + (1 - a) * (h(x0, z0 + s) - h(x0 + s, z0 + s)) + (1 - b) * (h(x0 + s, z0) - h(x0 + s, z0 + s));
      const height = h(x, z), departure = Math.abs(height - line);
      const ix = Math.min(Math.floor(x / L.extent), L.side - 1), iz = Math.min(Math.floor(z / L.extent), L.side - 1);
      const xs = x % L.extent === 0 && ix > 0 && x < N ? [ix - 1, ix] : [ix], zs = z % L.extent === 0 && iz > 0 && z < N ? [iz - 1, iz] : [iz];
      for (const jz of zs) for (const jx of xs) {
        const k = L.first + jz * L.side + jx;
        if (departure > error[k]) error[k] = departure;
        if (height < low[k]) low[k] = height;
        if (height > high[k]) high[k] = height;
      }
    });
  }
  // Children, and each parent's error above all of theirs.
  const children = (L, ix, iz) => {
    if (L.level === 0) return [];
    const C = levels[L.level - 1], out = [];
    const span = L.extent === C.extent ? [[0, 0]] : [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (const [dx, dz] of span) {
      const cx = L.extent === C.extent ? ix : ix * 2 + dx, cz = L.extent === C.extent ? iz : iz * 2 + dz;
      if (exists(C, cx, cz)) out.push(C.first + cz * C.side + cx);
    }
    return out;
  };
  const grid = spec.grid, metres = grid.g * fine;
  for (const L of levels) for (let iz = 0; iz < L.side; iz++) for (let ix = 0; ix < L.side; ix++) {
    if (!exists(L, ix, iz)) continue;
    const k = L.first + iz * L.side + ix, kids = children(L, ix, iz);
    if (!kids.length) { leaf[k] = 1; continue; }
    for (const c of kids) {
      error[k] = Math.max(error[k], landFround(error[c] * LAND_CONTINUUM_RISE));
      low[k] = Math.min(low[k], low[c]); high[k] = Math.max(high[k], high[c]);
    }
  }
  // The error each edge's shared points leave at each level: the same figures in both pieces that share the edge.
  const edges = spec.edges ?? [1 << bs, 1 << bs, 1 << bs, 1 << bs];
  const along = edges.map((step, e) => {
    const point = (t) => (e === 0 ? [0, t] : e === 1 ? [N, t] : e === 2 ? [t, 0] : [t, N]);
    const byLevel = [];
    for (const L of levels) {
      const s = 1 << L.level, row = new Float32Array(L.side);
      if (s > step) for (let t = 0; t <= N; t += step) {
        const t0 = Math.min(Math.floor(t / s), N / s - 1) * s, a = (t - t0) / s;
        const [ax, az] = point(t0), [bx, bz] = point(t0 + s), [px, pz] = point(t);
        const departure = Math.abs(h(px, pz) - (h(ax, az) + a * (h(bx, bz) - h(ax, az))));
        const i = Math.min(Math.floor(t / L.extent), L.side - 1);
        row[i] = Math.max(row[i], departure);
        if (t % L.extent === 0 && i > 0 && t < N) row[i - 1] = Math.max(row[i - 1], departure);
      }
      if (L.level > 0) {
        const C = byLevel[L.level - 1];
        for (let i = 0; i < L.side; i++) {
          const kids = L.extent === levels[L.level - 1].extent ? [i] : [2 * i, 2 * i + 1];
          for (const c of kids) row[i] = Math.max(row[i], landFround(C[c] * LAND_CONTINUUM_RISE));
        }
      }
      byLevel.push(row);
    }
    return byLevel;
  });
  // Points that never leave their coarser neighbours' line: the corners, where the walk starts, and the window's
  // border points finer than the coarse lattice, beside which a coarse patch outside may be drawn at any distance.
  const pinned = (x, z) => ((x === 0 || x === N) && (z === 0 || z === N))
    || (wn > 0 && windowed(x, z) && (x === wx || x === wx + wn || z === wz || z === wz + wn) && ((x | z) & ((1 << bs) - 1)) !== 0);
  // The error each point waits for: the least of the coarser patches that hold it.
  const waits = (x, z) => {
    const level = Math.min(landTrailing(x, T), landTrailing(z, T));
    if (level >= T || pinned(x, z)) return 0;
    const edge = x === 0 ? 0 : x === N ? 1 : z === 0 ? 2 : z === N ? 3 : -1;
    if (edge >= 0) {
      const t = edge < 2 ? z : x, L = levels[level + 1], row = along[edge][level + 1];
      const i = Math.min(Math.floor(t / L.extent), L.side - 1);
      return t % L.extent === 0 && i > 0 ? Math.min(row[i], row[i - 1]) : row[i];
    }
    for (let up = level + 1; up <= T; up++) {
      const L = levels[up], ix = Math.min(Math.floor(x / L.extent), L.side - 1), iz = Math.min(Math.floor(z / L.extent), L.side - 1);
      const xs = x % L.extent === 0 && ix > 0 ? [ix - 1, ix] : [ix], zs = z % L.extent === 0 && iz > 0 ? [iz - 1, iz] : [iz];
      let least = Infinity;
      for (const jz of zs) for (const jx of xs) if (exists(L, jx, jz)) least = Math.min(least, error[L.first + jz * L.side + jx]);
      if (least < Infinity) return least;
    }
    return 0;
  };
  points(0, (x, z) => { lattice[at(x, z) + 2] = waits(x, z); });
  // Every lattice point within a world rectangle, by the float its record starts at.
  const forPoints = (rect, visit) => {
    const ux = (w) => ((w - grid.x0) / grid.g - spec.gx) / fine, uz = (w) => ((w - grid.z0) / grid.g - spec.gz) / fine;
    const x0 = Math.max(0, Math.ceil(ux(rect.x0))), x1 = Math.min(N, Math.floor(ux(rect.x1)));
    const z0 = Math.max(0, Math.ceil(uz(rect.z0))), z1 = Math.min(N, Math.floor(uz(rect.z1)));
    if (x0 > x1 || z0 > z1) return;
    const c = 1 << bs;
    for (let z = Math.ceil(z0 / c) * c; z <= z1; z += c) for (let x = Math.ceil(x0 / c) * c; x <= x1; x += c) if (!windowed(x, z)) visit(at(x, z), x, z);
    if (wn > 0) for (let z = Math.max(z0, wz); z <= Math.min(z1, wz + wn); z++) for (let x = Math.max(x0, wx); x <= Math.min(x1, wx + wn); x++) visit(at(x, z), x, z);
  };
  // The lowest and highest ground under a rectangle of the lattice (its own units), its cells' corners all counted.
  const range = (xa, za, xb, zb) => {
    const s = wn > 0 && xa >= wx && za >= wz && xb <= wx + wn && zb <= wz + wn ? 1 : 1 << bs;
    let lo = Infinity, hi = -Infinity;
    for (let z = Math.floor(za / s) * s; z <= Math.min(N, Math.ceil(zb / s) * s); z += s) for (let x = Math.floor(xa / s) * s; x <= Math.min(N, Math.ceil(xb / s) * s); x += s) {
      const v = h(x, z);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi];
  };
  // Spheres round each node's ground, room left for what its morph can lift or lower, and holding its children's.
  const sphere = new Float32Array(total * 4);
  for (let l = 0; l < levels.length; l++) {
    const L = levels[l];
    for (let iz = 0; iz < L.side; iz++) for (let ix = 0; ix < L.side; ix++) {
      const k = L.first + iz * L.side + ix;
      if (!exists(L, ix, iz)) continue;
      const room = 2 * (l + 1 < levels.length ? Math.max(error[k], error[levels[l + 1].first + Math.floor(iz * L.extent / levels[l + 1].extent) * levels[l + 1].side + Math.floor(ix * L.extent / levels[l + 1].extent)]) : error[k]) + LAND_CONTINUUM_ROOM;
      const x0 = grid.x0 + (spec.gx + ix * L.extent * fine) * grid.g, z0 = grid.z0 + (spec.gz + iz * L.extent * fine) * grid.g, w = L.extent * metres;
      const y0 = low[k] - room, y1 = high[k] + room;
      sphere.set([x0 + w / 2, (y0 + y1) / 2, z0 + w / 2, Math.hypot(w / 2, (y1 - y0) / 2, w / 2)], k * 4);
      for (const c of children(L, ix, iz)) {
        const reach = Math.hypot(sphere[c * 4] - sphere[k * 4], sphere[c * 4 + 1] - sphere[k * 4 + 1], sphere[c * 4 + 2] - sphere[k * 4 + 2]) + sphere[c * 4 + 3];
        if (reach > sphere[k * 4 + 3]) sphere[k * 4 + 3] = reach;
      }
    }
  }
  // The nodes the GPU reads: every one that exists, each knowing its parent, in finest units.
  const R = shiftF + landContinuumFinest(grid.g);
  if (R < 0) throw new Error('Land continuum lattice is finer than the finest it cuts');
  const index = new Int32Array(total).fill(-1);
  let count = 0, room = 0;
  for (const L of levels) for (let iz = 0; iz < L.side; iz++) for (let ix = 0; ix < L.side; ix++) if (exists(L, ix, iz)) { index[L.first + iz * L.side + ix] = count++; if (L.list === 0) room++; }
  const words = new Uint32Array(count * LAND_CONTINUUM_NODE_WORDS), floats = new Float32Array(words.buffer), base = new Float32Array(count);
  for (let l = 0; l < levels.length; l++) {
    const L = levels[l], U = levels[l + 1];
    for (let iz = 0; iz < L.side; iz++) for (let ix = 0; ix < L.side; ix++) {
      const k = L.first + iz * L.side + ix, i = index[k];
      if (i < 0) continue;
      const parent = U ? index[U.first + Math.floor(iz * L.extent / U.extent) * U.side + Math.floor(ix * L.extent / U.extent)] : -1;
      const o = i * LAND_CONTINUUM_NODE_WORDS;
      floats.set(sphere.subarray(k * 4, k * 4 + 4), o);
      floats[o + 4] = leaf[k] ? 0 : error[k];
      words[o + 5] = parent < 0 ? 0xffffffff : parent;
      words.set([(ix * L.extent) << R, (iz * L.extent) << R, L.level + R, L.cells, L.list, leaf[k]], o + 6);
      base[i] = sphere[k * 4 + 3];
    }
  }
  const baked = {
    lattice, nodes: words, count, capacity: count, room, base, dug: new Float32Array(count),
    T: T + R, bs: bs + R, shiftF: shiftF - R, N: N << R, n, R,
    place: { grid, gx: spec.gx, gz: spec.gz },
    window: window ? { x: wx << R, z: wz << R, n: wn << R, first: baseCount * P } : null,
    // For tests, in the lattice's own units: each node's error by level and place, and the error a point waits for.
    errorAt: (level, ix, iz) => error[levels[level].first + iz * levels[level].side + ix],
    waitsAt: (x, z) => lattice[at(x, z) + 2],
    heightAt: h,
    forPoints, pinned, range,
  };
  for (const m of spec.marks ?? []) landContinuumDig(baked, m);
  return baked;
}

// A node more, a child of `parent` at its level and corner (finest units): a leaf, its sphere round the lattice's
// ground beneath it.
function landContinuumAppend(baked, parent, x0, z0, level) {
  const W = LAND_CONTINUUM_NODE_WORDS;
  if (baked.count === baked.capacity) {
    const capacity = baked.capacity * 2 + 64, nodes = new Uint32Array(capacity * W), base = new Float32Array(capacity), dug = new Float32Array(capacity);
    nodes.set(baked.nodes); base.set(baked.base); dug.set(baked.dug);
    Object.assign(baked, { nodes, base, dug, capacity });
  }
  const { grid, gx, gz } = baked.place, grids = 2 ** baked.shiftF, unit = grid.g * grids, lattice = 2 ** -baked.R;
  const i = baked.count++, o = i * W, words = baked.nodes, floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  const extent = LAND_CONTINUUM_PATCH * 2 ** level, [lo, hi] = baked.range(x0 * lattice, z0 * lattice, (x0 + extent) * lattice, (z0 + extent) * lattice);
  const w = extent * unit, radius = Math.hypot(w / 2, (hi - lo) / 2 + LAND_CONTINUUM_ROOM, w / 2);
  floats.set([grid.x0 + (gx + (x0 + extent / 2) * grids) * grid.g, (lo + hi) / 2, grid.z0 + (gz + (z0 + extent / 2) * grids) * grid.g, radius, 0], o);
  words.set([parent, x0, z0, level, LAND_CONTINUUM_PATCH, 0, 1], o + 5);
  baked.base[i] = radius; baked.dug[i] = 0; baked.room++;
  return i;
}

/**
 * What lies on the lattice finer than it, `mark`: a pit shot has dug (landCraterMark in js/land-craters.js) or a
 * river's banks (js/land-banks.js). {x0, x1, z0, z1} the world square it reaches at all; over(x0, x1, z0, z1) the most
 * it moves the ground over the blocks a world rectangle touches; at(x, z) over the block a point is in, the figure
 * the GPU reads for a point between the lattice's (landContinuumDug); finest, the level its own cell is drawn at.
 * Every node keeps as much error as the mark moves the ground under it, and room in its sphere; every leaf where it
 * moves the ground at all splits on down to its finest level; every lattice point waits for what it does there; and
 * every ancestor stays above. No point between the lattice's waits for more than any patch holding it keeps, so no
 * crack opens, and ground it leaves flat is not split. Returns the nodes changed, whether any were added, and the
 * lattice's records changed ([first, last] float, the piece's own lattice and the survey's apart).
 */
export function landContinuumDig(baked, mark) {
  const W = LAND_CONTINUUM_NODE_WORDS, { grid, gx, gz } = baked.place, finest = mark.finest ?? 0;
  const unit = grid.g * 2 ** baked.shiftF, ox = grid.x0 + gx * grid.g, oz = grid.z0 + gz * grid.g;
  const amountOf = (i) => {
    const o = i * W, words = baked.nodes, w = words[o + 9] * 2 ** words[o + 8] * unit, x0 = ox + words[o + 6] * unit, z0 = oz + words[o + 7] * unit;
    return mark.over(x0, x0 + w, z0, z0 + w);
  };
  const changed = new Set(), stack = [];
  let grew = false;
  for (let i = 0; i < baked.count; i++) { const amount = amountOf(i); if (amount > 0) stack.push(i, amount); }
  while (stack.length) {
    const amount = stack.pop(), i = stack.pop(), o = i * W, words = baked.nodes, floats = new Float32Array(words.buffer, words.byteOffset, words.length);
    if (baked.dug[i] < amount) { baked.dug[i] = amount; changed.add(i); }
    floats[o + 3] = Math.max(floats[o + 3], baked.base[i] + 3 * baked.dug[i]);
    if (!words[o + 11]) {
      if (floats[o + 4] < amount) { floats[o + 4] = amount; changed.add(i); }
      continue;
    }
    const level = words[o + 8], x0 = words[o + 6], z0 = words[o + 7];
    if (level <= finest || words[o + 9] !== LAND_CONTINUUM_PATCH) continue;
    // A leaf where it moves the ground gives way to four children a level finer, which split on where it moves theirs.
    words[o + 11] = 0; floats[o + 4] = Math.max(floats[o + 4], amount); changed.add(i);
    const half = LAND_CONTINUUM_PATCH * 2 ** (level - 1);
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const c = landContinuumAppend(baked, i, x0 + dx * half, z0 + dz * half, level - 1);
      changed.add(c); grew = true;
      const under = amountOf(c);
      if (under > 0) stack.push(c, under);
    }
  }
  // Every ancestor above its children, and round them.
  const words = baked.nodes, floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  for (const start of [...changed]) {
    for (let i = start, parent = words[i * W + 5]; parent !== 0xffffffff; i = parent, parent = words[parent * W + 5]) {
      const c = i * W, o = parent * W;
      const error = Math.fround(floats[c + 4] * LAND_CONTINUUM_RISE), reach = Math.hypot(floats[c] - floats[o], floats[c + 1] - floats[o + 1], floats[c + 2] - floats[o + 2]) + floats[c + 3];
      if (floats[o + 4] >= error && floats[o + 3] >= reach) break;
      floats[o + 4] = Math.max(floats[o + 4], error); floats[o + 3] = Math.max(floats[o + 3], reach);
      changed.add(parent);
    }
  }
  // And every lattice point waits for what it does there, but the pinned, which never leave their line.
  const lattice = baked.lattice, split = baked.window ? baked.window.first : Infinity, spans = [[Infinity, -1], [Infinity, -1]];
  const fine = 2 ** (baked.shiftF + baked.R) * grid.g;
  baked.forPoints(mark, (k, x, z) => {
    if (baked.pinned(x, z)) return;
    const amount = mark.at(ox + x * fine, oz + z * fine);
    if (lattice[k + 2] >= amount) return;
    lattice[k + 2] = amount;
    const span = spans[k >= split ? 1 : 0];
    span[0] = Math.min(span[0], k); span[1] = Math.max(span[1], k);
  });
  return { changed, grew, spans: spans.filter(([, last]) => last >= 0) };
}

/**
 * Pieces that share edges: every edge's common points take the heights of the piece with the most authority, its
 * other points the line between them (worked as the GPU works a line, so the point lies on it exactly), and every
 * corner the height of the piece with the most authority that holds it. `pieces` is a Map of key to
 * {sx, sz, n, cell, heights, authority, order}; neighbours are at sx ± 1, sz ± 1. Returns, for `key`, the heights
 * to bake and each edge's step in the piece's cells.
 */
export function landContinuumSeams(pieces, key) {
  const piece = pieces.get(key), { n, sx, sz } = piece;
  const out = Float32Array.from(piece.heights);
  const at = (p, i, j) => p.heights[j * p.n + i];
  const ranks = (a, b) => (a.authority !== b.authority ? a.authority > b.authority : a.order < b.order);
  const find = (x, z) => { for (const p of pieces.values()) if (p.sx === x && p.sz === z) return p; return null; };
  const grid = new Map();
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) grid.set(`${dx},${dz}`, dx || dz ? find(sx + dx, sz + dz) : piece);
  const steps = [];
  // Edges: x = 0 (west, neighbour -1,0), x = N (east), z = 0 (north, 0,-1), z = N (south).
  const sides = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  sides.forEach(([dx, dz], e) => {
    const other = grid.get(`${dx},${dz}`);
    const cells = n - 1, otherCells = other ? other.n - 1 : cells, ratio = Math.max(1, cells / otherCells), step = Math.round(ratio);
    steps.push(step);
    const source = other && ranks(other, piece) ? other : piece;
    const mine = (t) => (e === 0 ? [0, t] : e === 1 ? [cells, t] : e === 2 ? [t, 0] : [t, cells]);
    // The neighbour's index of the same point: its far edge, at its own spacing.
    const theirs = (t) => {
      const u = t * (source.n - 1) / cells, far = source.n - 1;
      return source === piece ? mine(t) : e === 0 ? [far, u] : e === 1 ? [0, u] : e === 2 ? [u, far] : [u, 0];
    };
    for (let t = step; t < cells; t += step) { const [i, j] = mine(t), [si, sj] = theirs(t); out[j * n + i] = at(source, si, sj); }
  });
  // Corners: the most authoritative of the pieces round each.
  for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    let best = piece, bi = cx * (n - 1), bj = cz * (n - 1);
    for (const [ox, oz] of [[0, 0], [cx * 2 - 1, 0], [0, cz * 2 - 1], [cx * 2 - 1, cz * 2 - 1]]) {
      const p = grid.get(`${ox},${oz}`);
      if (p && ranks(p, best)) { best = p; bi = (ox ? 1 - cx : cx) * (p.n - 1); bj = (oz ? 1 - cz : cz) * (p.n - 1); }
    }
    out[cz * (n - 1) * n + cx * (n - 1)] = at(best, bi, bj);
  }
  // Each edge's other points on the line between its common ones, coarsest first, in single precision.
  sides.forEach((_, e) => {
    const cells = n - 1, step = steps[e];
    const index = (t) => (e === 0 ? t * n : e === 1 ? t * n + cells : e === 2 ? t : cells * n + t);
    for (let width = step; width > 1; width >>= 1) {
      for (let t = 0; t + width <= cells; t += width) out[index(t + width / 2)] = landFround(landFround(out[index(t)] + out[index(t + width)]) * 0.5);
    }
  });
  return { heights: out, edges: steps };
}

// --------------------------------------------------------------------------------------------- the GPU
export function requestLandContinuumPipelines({ device, shader }) {
  return requestOnce(device, 'land continuum cut', async () => {
    const [module, ground] = await Promise.all([shader(landContinuumCutWGSL(), 'land continuum cut'), shader(landGroundWriteWGSL(), 'land drawn ground')]);
    const [reset, cut, clear, write] = await Promise.all([
      device.createComputePipelineAsync({ label: 'land continuum reset', layout: 'auto', compute: { module, entryPoint: 'landContinuumReset' } }),
      device.createComputePipelineAsync({ label: 'land continuum cut', layout: 'auto', compute: { module, entryPoint: 'landContinuumCut' } }),
      device.createComputePipelineAsync({ label: 'land drawn ground clear', layout: 'auto', compute: { module: ground, entryPoint: 'landGroundClear' } }),
      device.createComputePipelineAsync({ label: 'land drawn ground', layout: 'auto', compute: { module: ground, entryPoint: 'landGroundWrite' } }),
    ]);
    return { reset, cut, clear, write };
  });
}

/**
 * Every piece of land, cut and drawn. `pipelines` from requestLandContinuumPipelines, `view` the land material's view
 * pipeline and `capture` its under-water capture or null (requestContinuumView and requestContinuumCapture in
 * js/continuum-scene.js, with landContinuumMaterial from js/wgsl/land-continuum.js), `frame` the scene's frame uniform,
 * `grid` the grid every piece is placed on: {x0, z0, g}.
 */
export function createLandContinuum({ device, pipelines: P, view: viewPipeline, capture = null, frame, grid, shared = [] }) {
  const B = GPUBufferUsage;
  const { indices, firsts } = landContinuumIndices();
  const indexBuffer = device.createBuffer({ label: 'land continuum patches', size: Math.ceil(indices.byteLength / 4) * 4, usage: B.INDEX | B.COPY_DST });
  device.queue.writeBuffer(indexBuffer, 0, indices.buffer, 0, Math.ceil(indices.byteLength / 4) * 4);
  const draws = device.createBuffer({ label: 'land continuum draws', size: LAND_CONTINUUM_RECORDS * LAND_CONTINUUM_DRAW_WORDS * 4, usage: B.STORAGE | B.INDIRECT | B.COPY_SRC });
  const viewBuffer = device.createBuffer({ label: 'land continuum view', size: LAND_CONTINUUM_VIEW_BYTES, usage: B.UNIFORM | B.COPY_DST });
  const viewFloats = new Float32Array(4);
  let viewChanged = true;
  const setView = (at, value) => { if (viewFloats[at] !== Math.fround(value)) { viewFloats[at] = value; viewChanged = true; } };
  // The drawn ground's field: every slot's workgroups to write it, emptied with the lists.
  const work = device.createBuffer({ label: 'land drawn ground work', size: LAND_CONTINUUM_SLOTS * LAND_GROUND_WORK_WORDS * 4, usage: B.STORAGE | B.INDIRECT });
  const resetGroup = device.createBindGroup({ layout: P.reset.getBindGroupLayout(0), entries: [{ binding: 6, resource: { buffer: draws } }, { binding: 8, resource: { buffer: work } }] });
  const field = continuumGroundField(device);
  const clearGroup = device.createBindGroup({ layout: P.clear.getBindGroupLayout(0), entries: [{ binding: 1, resource: field.view }] });
  const writeGroup = device.createBindGroup({ layout: P.write.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frame } }, { binding: 1, resource: field.view }] });
  const writeEmpty = device.createBindGroup({ layout: P.write.getBindGroupLayout(1), entries: [] });
  const pieces = new Map(), freeSlots = Array.from({ length: LAND_CONTINUUM_SLOTS }, (_, i) => LAND_CONTINUUM_SLOTS - 1 - i);
  const group = (layout, entries) => device.createBindGroup({ layout, entries: entries.map(([binding, resource]) => ({ binding, resource: resource instanceof GPUBuffer ? { buffer: resource } : resource })) });
  // The view's, the captures' and the drawn ground's group 2: the piece's own data and what every piece shares (the
  // craters' textures, the banks').
  const dataGroups = (piece) => {
    const data = [[50, viewBuffer], [51, piece.uniform], [52, piece.lattice], [53, piece.nodes], ...shared];
    piece.drawn = viewPipeline ? group(viewPipeline.getBindGroupLayout(2), data) : null;
    piece.captured = capture ? group(capture.pipeline.getBindGroupLayout(2), data) : null;
    piece.written = group(P.write.getBindGroupLayout(2), [...data, [62, piece.tiles]]);
  };
  let destroyed = false;

  const pieceBuffers = (piece) => [piece.lattice, piece.nodes, piece.uniform, piece.lists, piece.tiles];
  function release(piece) { for (const b of pieceBuffers(piece)) b.destroy(); freeSlots.push(piece.slot); }
  /**
   * A piece, new or changed. `baked` from bakeLandContinuumPiece; `land` the land's group 0 for the view's pipeline
   * and `captureLand` the same for the capture's; `near` the world bounds drawn as surveyed ground (kind 1).
   */
  function set(key, baked, { gx, gz, land, captureLand = null, near = null }) {
    const old = pieces.get(key);
    const slot = old ? old.slot : freeSlots.pop();
    if (slot === undefined) throw new Error('Land continuum has no slot left for another piece');
    const lattice = device.createBuffer({ label: `land ${key} lattice`, size: baked.lattice.byteLength, usage: B.STORAGE | B.COPY_DST });
    device.queue.writeBuffer(lattice, 0, baked.lattice);
    const piece = { key, slot, baked, gx, gz, lattice, land, captureLand, near };
    fit(piece);
    pieces.set(key, piece);
    if (old) { old.slot = -1; for (const b of pieceBuffers(old)) b.destroy(); }
    return piece;
  }
  // A piece's nodes, lists and numbers on the GPU, made again whenever its nodes are more.
  function fit(piece) {
    const { key, baked, slot, gx, gz, near } = piece, W = LAND_CONTINUUM_NODE_WORDS;
    for (const b of [piece.nodes, piece.uniform, piece.lists, piece.tiles]) b?.destroy();
    const nodes = device.createBuffer({ label: `land ${key} nodes`, size: Math.max(16, baked.count * W * 4), usage: B.STORAGE | B.COPY_DST });
    device.queue.writeBuffer(nodes, 0, baked.nodes.buffer, baked.nodes.byteOffset, baked.count * W * 4);
    const lists = device.createBuffer({ label: `land ${key} lists`, size: (2 * baked.room + 2 * (LAND_CONTINUUM_LISTS - 1)) * 4, usage: B.STORAGE | B.VERTEX | B.COPY_SRC });
    const words = new ArrayBuffer(LAND_CONTINUUM_PIECE_BYTES), i32 = new Int32Array(words), u32 = new Uint32Array(words), fl = new Float32Array(words);
    fl.set([grid.x0, grid.z0, grid.g, 0], 0);
    i32.set([gx, gz, baked.shiftF, baked.T], 4);
    u32.set([baked.n, baked.bs, 0, baked.count], 8);
    i32.set(baked.window ? [baked.window.x, baked.window.z, baked.window.n, baked.window.first] : [0, 0, 0, 0], 12);
    u32.set([slot, baked.room, baked.room + LAND_CONTINUUM_LISTS - 1, baked.R], 16);
    fl.set(near ?? [1, 0, 1, 0], 20);
    const uniform = device.createBuffer({ label: `land ${key} piece`, size: LAND_CONTINUUM_PIECE_BYTES, usage: B.UNIFORM | B.COPY_DST });
    device.queue.writeBuffer(uniform, 0, words);
    // The tiles of the drawn ground's field the cut names: a patch each, with its cut, level and place.
    const tiles = device.createBuffer({ label: `land ${key} drawn ground tiles`, size: LAND_GROUND_ROOM * 8, usage: B.STORAGE });
    Object.assign(piece, {
      nodes, uniform, lists, tiles,
      // The cut reads the nodes, not the lattice.
      cut: group(P.cut.getBindGroupLayout(0), [[0, frame], [1, viewBuffer], [2, uniform], [4, nodes], [5, lists], [6, draws], [7, tiles], [8, work]]),
      groups: Math.ceil(baked.count / 64),
    });
    dataGroups(piece);
  }
  const listRanges = (piece, cut) => {
    const base = cut ? piece.baked.room + LAND_CONTINUUM_LISTS - 1 : 0;
    return LAND_CONTINUUM_TESSELLATIONS.map((_, list) => (list === 0 ? [base, piece.baked.room] : [base + piece.baked.room + list - 1, 1]));
  };
  function drawPiece(pass, piece, cut) {
    listRanges(piece, cut).forEach(([first, room], list) => {
      pass.setVertexBuffer(0, piece.lists, first * 4, room * 4);
      pass.drawIndexedIndirect(draws, ((cut * LAND_CONTINUUM_SLOTS + piece.slot) * LAND_CONTINUUM_LISTS + list) * LAND_CONTINUUM_DRAW_WORDS * 4);
    });
  }
  // Shot has dug ground, `mark` as landContinuumDig has it: only the nodes and points changed are written, or the
  // nodes made again where there are more.
  function raise(key, mark) {
    const piece = pieces.get(key);
    if (!piece) return 0;
    const { baked } = piece, W = LAND_CONTINUUM_NODE_WORDS, { changed, grew, spans } = landContinuumDig(baked, mark);
    if (grew) fit(piece);
    else for (const i of changed) device.queue.writeBuffer(piece.nodes, i * W * 4, baked.nodes.buffer, baked.nodes.byteOffset + i * W * 4, W * 4);
    const lattice = baked.lattice;
    for (const [lo, hi] of spans) device.queue.writeBuffer(piece.lattice, lo * 4, lattice.buffer, lattice.byteOffset + lo * 4, (hi - lo + LAND_CONTINUUM_POINT_FLOATS) * 4);
    return changed.size;
  }
  return {
    pieces, draws, firsts, viewBuffer,
    set, raise,
    // What every piece's group 2 shares changed (the craters' textures were made again).
    setShared(entries) { shared = entries; for (const piece of pieces.values()) dataGroups(piece); },
    remove(key) { const piece = pieces.get(key); if (!piece) return; pieces.delete(key); release(piece); },
    // Every piece on another grid (a coast laid out at another span): each is drawn again only once set again.
    regrid(next) { grid = next; for (const piece of pieces.values()) release(piece); pieces.clear(); },
    // The land's group 0 for a piece changed (its textures were made again), with the same ground.
    rebind(key, land, captureLand = null) { const piece = pieces.get(key); if (piece) { piece.land = land; piece.captureLand = captureLand; } },
    setWorldOffset(x, z) { setView(2, x); setView(3, z); },
    // In the frame's compute pass, before any family that stands on the ground: every list emptied, then every piece
    // cut, then the drawn ground's field emptied and written from what each cut kept.
    encode(pass) {
      if (destroyed) return;
      // The scene's one pixel error, which every family's cut reads (js/continuum-core.js); the captures' is coarser.
      const pixels = continuumPixelError();
      setView(0, pixels); setView(1, pixels * LAND_CONTINUUM_CAPTURE_COARSENING);
      if (viewChanged) { device.queue.writeBuffer(viewBuffer, 0, viewFloats); viewChanged = false; }
      pass.setPipeline(P.reset); pass.setBindGroup(0, resetGroup);
      pass.dispatchWorkgroups(Math.ceil(Math.max(LAND_CONTINUUM_RECORDS, LAND_CONTINUUM_SLOTS * LAND_GROUND_WORK_WORDS) / 64));
      pass.setPipeline(P.cut);
      for (const piece of pieces.values()) {
        if (!piece.groups) continue;
        pass.setBindGroup(0, piece.cut);
        pass.dispatchWorkgroups(Math.min(piece.groups, 65535), Math.ceil(piece.groups / 65535));
      }
      const side = CONTINUUM_GROUND_TEXELS / 8;
      pass.setPipeline(P.clear); pass.setBindGroup(0, clearGroup);
      pass.dispatchWorkgroups(side, side, CONTINUUM_GROUND_CUTS * CONTINUUM_GROUND_LEVELS);
      pass.setPipeline(P.write); pass.setBindGroup(0, writeGroup); pass.setBindGroup(1, writeEmpty);
      for (const piece of pieces.values()) {
        if (!piece.groups) continue;
        pass.setBindGroup(2, piece.written);
        pass.dispatchWorkgroupsIndirect(work, piece.slot * LAND_GROUND_WORK_WORDS * 4);
      }
    },
    // Every piece's view lists. `clouds` is the land's group 1 for the view's pipeline.
    draw(pass, clouds) {
      if (destroyed || !pieces.size || !viewPipeline) return;
      pass.setPipeline(viewPipeline); pass.setBindGroup(1, clouds); pass.setIndexBuffer(indexBuffer, 'uint16');
      for (const piece of pieces.values()) { pass.setBindGroup(0, piece.land); pass.setBindGroup(2, piece.drawn); drawPiece(pass, piece, 0); }
    },
    // The water's captures: the coarser cut. The capture's pipeline and group 3 are already bound by capture.bind.
    drawCapture(pass, clouds) {
      if (destroyed || !capture || !pieces.size) return;
      pass.setBindGroup(1, clouds); pass.setIndexBuffer(indexBuffer, 'uint16');
      for (const piece of pieces.values()) { if (!piece.captureLand) continue; pass.setBindGroup(0, piece.captureLand); pass.setBindGroup(2, piece.captured); drawPiece(pass, piece, 1); }
    },
    // For the continuum census (js/continuum-census.js): every slot's view draws, unused ones empty.
    continuumDraws() { return destroyed ? [] : [{ buffer: draws, offset: 0, records: LAND_CONTINUUM_SLOTS * LAND_CONTINUUM_LISTS, stride: LAND_CONTINUUM_DRAW_WORDS }]; },
    // What the last cut kept, read back: for tests. Per piece, each cut's lists of nodes.
    async readCut() {
      const out = new Map();
      const drawBytes = LAND_CONTINUUM_RECORDS * LAND_CONTINUUM_DRAW_WORDS * 4;
      const staging = device.createBuffer({ size: drawBytes, usage: B.COPY_DST | B.MAP_READ });
      const listStaging = [];
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(draws, 0, staging, 0, drawBytes);
      for (const piece of pieces.values()) {
        const buffer = device.createBuffer({ size: piece.lists.size, usage: B.COPY_DST | B.MAP_READ });
        encoder.copyBufferToBuffer(piece.lists, 0, buffer, 0, piece.lists.size);
        listStaging.push([piece, buffer]);
      }
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const records = new Uint32Array(staging.getMappedRange().slice(0));
      staging.destroy();
      for (const [piece, buffer] of listStaging) {
        await buffer.mapAsync(GPUMapMode.READ);
        const entries = new Uint32Array(buffer.getMappedRange().slice(0));
        buffer.destroy();
        out.set(piece.key, [0, 1].map((cut) => listRanges(piece, cut).map(([first], list) => {
          const count = records[((cut * LAND_CONTINUUM_SLOTS + piece.slot) * LAND_CONTINUUM_LISTS + list) * LAND_CONTINUUM_DRAW_WORDS + 1];
          return Array.from(entries.subarray(first, first + count));
        })));
      }
      return out;
    },
    // No land: the drawn ground's field emptied, so every family stands on the true ground.
    destroy() { destroyed = true; for (const piece of pieces.values()) release(piece); pieces.clear(); for (const b of [indexBuffer, draws, viewBuffer, work]) b.destroy(); continuumGroundForget(device); },
  };
}
