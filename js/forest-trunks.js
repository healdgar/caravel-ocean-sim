// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What a ball meets in a forest. The roots the GPU draws are kept on the CPU, so a grid over them finds the trees near a
// ball's line, and each tree's wood is its species' chains of round sections (js/forest-trunk-shapes.js), turned and
// scaled as the forest vertex shader turns and scales it. Leaves and twigs thinner than a ball are not in the chains.
//
// What shot has done to a tree lives in its root, in floats the shader reads, written only when a ball lands:
//   identity.w (float 11)  0 whole; above 0 wounded, FOREST_WOUND_* below; below 0 felled, minus the time the fall began.
//   identity.y (float 9)   Once felled, where it broke and which way it fell, FOREST_FALL_* below. Until then, its sink.
import { FOREST_TRUNK_SHAPES } from './forest-trunk-shapes.js';
import { createTaskYieldBudget } from './task-yield.js';

const TRUNK_ROOT_FLOATS = 12;
const TRUNK_ROOT_SCALE = 3, TRUNK_ROOT_YAW = 4, TRUNK_ROOT_TINT = 5, TRUNK_ROOT_PROTOTYPE = 8, TRUNK_ROOT_FALL = 9, TRUNK_ROOT_STRUCK = 11;
const TRUNK_CELL_M = 16;
const TRUNK_TREE_FLOATS = 9;
const TRUNK_BOX_LEAF = 4;
// The grid builds this many trees between looks at the clock.
const TRUNK_TREES_PER_STEP = 2048;

// A felled tree that came down long ago, or before this session began.
export const FOREST_LONG_FALLEN = -1e9;
// Twenty-four bits of whole number, so a float holds them exactly.
export const FOREST_FALL_HEIGHT_STEPS = 32, FOREST_FALL_BEARINGS = 128, FOREST_FALL_REST_MIN_DEG = 60;
export const FOREST_WOUND_BEARINGS = 64;
// A foreshore palm stands by the sea and leans out over it: the direction its grown trunk leans, in scripts/grow-tropical-trees.mjs.
const COCONUT_LEAN_RADIANS = Math.atan2(0.5, 1.5);

// Where terrain.js plants a palm of the foreshore fringe. The forest draws what this says, and shot strikes it.
export function foreshorePalmPlacement(shape, seaX, seaZ, basalRadius) {
  const scale = 1 + shape * 0.55, lean = Math.hypot(seaX, seaZ);
  return {
    scale,
    sink: Math.max(0.12, basalRadius * scale * lean + 0.08),
    yaw: lean > 0.01 ? Math.atan2(seaZ, seaX) - COCONUT_LEAN_RADIANS : shape * Math.PI * 2,
  };
}

// --- One species' wood ---------------------------------------------------------------------------------------------

function trunkBoxOf(capsules, order, first, count) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = first; i < first + count; i++) {
    const at = order[i] * 8;
    for (let end = 0; end < 2; end++) {
      const r = capsules[at + end * 4 + 3];
      for (let k = 0; k < 3; k++) {
        const value = capsules[at + end * 4 + k];
        if (value - r < box[k]) box[k] = value - r;
        if (value + r > box[k + 3]) box[k + 3] = value + r;
      }
    }
  }
  return box;
}

// A tree's sections in a flat box tree, each node eight floats: six bounds, then the first section and how many, or if it
// holds other nodes, the node after them and 0. `size` is how many times the size of the tree measured the wood is made.
function compileTrunkShape(species, trunks, limbs, size = 1) {
  const sections = [], onTrunk = [];
  const add = (chains, trunk) => {
    for (const chain of chains) for (let i = 0; i + 7 < chain.length; i += 4) {
      for (let k = 0; k < 8; k++) sections.push(chain[i + k] * size);
      onTrunk.push(trunk ? 1 : 0);
    }
  };
  add(trunks, true);
  add(limbs, false);
  const count = onTrunk.length, source = Float32Array.from(sections), order = new Uint32Array(count), nodes = [];
  for (let i = 0; i < count; i++) order[i] = i;
  const build = (first, n) => {
    const box = trunkBoxOf(source, order, first, n), at = nodes.length;
    nodes.push(...box, first, n);
    if (n <= TRUNK_BOX_LEAF) return;
    const size = [box[3] - box[0], box[4] - box[1], box[5] - box[2]], axis = size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
    const mid = (i) => source[i * 8 + axis] + source[i * 8 + 4 + axis];
    order.set(Array.from(order.subarray(first, first + n)).sort((a, b) => mid(a) - mid(b)), first);
    build(first, n >> 1);
    build(first + (n >> 1), n - (n >> 1));
    nodes[at + 6] = nodes.length / 8;
    nodes[at + 7] = 0;
  };
  if (count) build(0, count);
  const capsules = new Float32Array(count * 8), trunkFlags = new Uint8Array(count);
  let reach = 0, top = -Infinity, bottom = Infinity, trunkTop = 0, trunkArea = 0, trunkLength = 0;
  for (let i = 0; i < count; i++) {
    const from = order[i];
    capsules.set(source.subarray(from * 8, from * 8 + 8), i * 8);
    trunkFlags[i] = onTrunk[from];
    for (let end = 0; end < 2; end++) {
      const x = source[from * 8 + end * 4], y = source[from * 8 + end * 4 + 1], z = source[from * 8 + end * 4 + 2], r = source[from * 8 + end * 4 + 3];
      reach = Math.max(reach, Math.hypot(x, z) + r);
      top = Math.max(top, y + r);
      bottom = Math.min(bottom, y - r);
      if (onTrunk[from]) trunkTop = Math.max(trunkTop, y);
    }
    if (onTrunk[from]) {
      const length = Math.hypot(source[from * 8 + 4] - source[from * 8], source[from * 8 + 5] - source[from * 8 + 1], source[from * 8 + 6] - source[from * 8 + 2]);
      const radius = (source[from * 8 + 3] + source[from * 8 + 7]) / 2;
      trunkArea += radius * length;
      trunkLength += length;
    }
  }
  return {
    species, capsules, onTrunk: trunkFlags, nodes: Float32Array.from(nodes), count, reach, top, bottom, trunkTop,
    // What a ball must break through to fell it: the trunk's own mean radius, measured along its length.
    trunkRadius: trunkLength > 0 ? trunkArea / trunkLength : 0,
    collarRadius: (trunks[0]?.[3] ?? 0) * size,
  };
}

// A species' wood as it was measured or, given `stands`, as it stands for a tree of that species drawn at another size:
// made as tall as that tree (height, in metres to the top of its leaves), with the trunk a ball must break through as
// stout as that tree's own (trunkRadius, in metres).
const compiledTrunkShapes = new Map();
export function forestTrunkShape(species, stands = null) {
  const key = stands ? `${species} ${stands.height} ${stands.trunkRadius}` : species;
  if (compiledTrunkShapes.has(key)) return compiledTrunkShapes.get(key);
  const table = FOREST_TRUNK_SHAPES[species];
  let shape = null;
  if (table && (table.trunks.length || table.limbs.length)) {
    shape = compileTrunkShape(species, table.trunks, table.limbs, stands ? stands.height / table.height : 1);
    if (stands) shape.trunkRadius = stands.trunkRadius;
  }
  compiledTrunkShapes.set(key, shape);
  return shape;
}

// --- The grid ------------------------------------------------------------------------------------------------------

const trunkCellHash = (cx, cz, mask) => (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) & mask;

// Builds a grid over these roots, yielding between batches. The roots stay the grid's own: when the forest streams it
// gets a new array, and shot strikes the array this names until the next grid is ready. speciesOf names, for each kind of
// tree the roots hold, its species, or is the wood that stands for it (forestTrunkShape).
export function* prepareForestTrunkGridSteps(roots, count, speciesOf) {
  const shapes = speciesOf.map((species) => (typeof species === 'string' ? forestTrunkShape(species) : species));
  const tree = new Float32Array(count * TRUNK_TREE_FLOATS), rootOf = new Uint32Array(count), shapeOf = new Uint8Array(count), cells = new Int32Array(count * 2);
  let n = 0, minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, widest = 0;
  for (let i = 0; i < count; i++) {
    const at = i * TRUNK_ROOT_FLOATS, scale = roots[at + TRUNK_ROOT_SCALE], prototype = roots[at + TRUNK_ROOT_PROTOTYPE] | 0, shape = shapes[prototype];
    if (!(scale > 0) || !shape) continue;
    const x = roots[at], y = roots[at + 1], z = roots[at + 2], yaw = roots[at + TRUNK_ROOT_YAW], reach = shape.reach * scale;
    const t = n * TRUNK_TREE_FLOATS;
    tree[t] = x; tree[t + 1] = y; tree[t + 2] = z; tree[t + 3] = scale; tree[t + 4] = Math.cos(yaw); tree[t + 5] = Math.sin(yaw);
    tree[t + 6] = reach; tree[t + 7] = y + shape.bottom * scale; tree[t + 8] = y + shape.top * scale;
    rootOf[n] = i;
    shapeOf[n] = prototype;
    cells[n * 2] = Math.floor(x / TRUNK_CELL_M);
    cells[n * 2 + 1] = Math.floor(z / TRUNK_CELL_M);
    if (tree[t + 7] < minY) minY = tree[t + 7];
    if (tree[t + 8] > maxY) maxY = tree[t + 8];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    if (reach > widest) widest = reach;
    n++;
    if ((i & (TRUNK_TREES_PER_STEP - 1)) === 0) yield;
  }
  // An open table of the cells that hold a tree. A coast and its streamed sections can be 70 km across, mostly sea.
  let size = 64;
  while (size < n * 2) size *= 2;
  const mask = size - 1, keyX = new Int32Array(size), keyZ = new Int32Array(size), filled = new Uint8Array(size), counts = new Uint32Array(size);
  const slotOf = (cx, cz) => {
    let h = trunkCellHash(cx, cz, mask);
    while (filled[h] && (keyX[h] !== cx || keyZ[h] !== cz)) h = (h + 1) & mask;
    return h;
  };
  for (let i = 0; i < n; i++) {
    const h = slotOf(cells[i * 2], cells[i * 2 + 1]);
    filled[h] = 1; keyX[h] = cells[i * 2]; keyZ[h] = cells[i * 2 + 1]; counts[h]++;
    if ((i & (TRUNK_TREES_PER_STEP - 1)) === 0) yield;
  }
  const starts = new Uint32Array(size);
  for (let h = 0, total = 0; h < size; h++) { starts[h] = total; total += counts[h]; }
  yield;
  // In cell order, so a query reads neighbours next to one another.
  const placed = new Uint32Array(size), sorted = new Float32Array(n * TRUNK_TREE_FLOATS), sortedRoot = new Uint32Array(n), sortedShape = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const h = slotOf(cells[i * 2], cells[i * 2 + 1]), to = starts[h] + placed[h]++;
    sorted.set(tree.subarray(i * TRUNK_TREE_FLOATS, (i + 1) * TRUNK_TREE_FLOATS), to * TRUNK_TREE_FLOATS);
    sortedRoot[to] = rootOf[i];
    sortedShape[to] = shapeOf[i];
    if ((i & (TRUNK_TREES_PER_STEP - 1)) === 0) yield;
  }
  return { roots, count, trees: n, shapes, tree: sorted, rootOf: sortedRoot, shapeOf: sortedShape, mask, keyX, keyZ, filled, counts, starts, widest, minX, maxX, minZ, maxZ, minY, maxY };
}

export function buildForestTrunkGrid(roots, count, speciesOf) {
  const steps = prepareForestTrunkGridSteps(roots, count, speciesOf);
  let next;
  do { next = steps.next(); } while (!next.done);
  return next.value;
}

export async function buildForestTrunkGridAsync(roots, count, speciesOf, { isCancelled = () => false } = {}) {
  const steps = prepareForestTrunkGridSteps(roots, count, speciesOf), pause = createTaskYieldBudget();
  for (;;) {
    if (isCancelled()) return null;
    const next = steps.next();
    if (next.done) return next.value;
    const waiting = pause();
    if (waiting) await waiting;
  }
}

// --- The sweep -----------------------------------------------------------------------------------------------------

// Where a line meets a round section, from a to b, as a fraction of the line in [0, 1], or -1. Iñigo Quilez's capsule test.
function trunkSectionEntry(ox, oy, oz, dx, dy, dz, dd, ax, ay, az, bx, by, bz, r) {
  const bax = bx - ax, bay = by - ay, baz = bz - az, oax = ox - ax, oay = oy - ay, oaz = oz - az;
  const baba = bax * bax + bay * bay + baz * baz, bard = bax * dx + bay * dy + baz * dz, baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz, oaoa = oax * oax + oay * oay + oaz * oaz, rr = r * r;
  const a = baba * dd - bard * bard, b = baba * rdoa - baoa * bard, c = baba * oaoa - baoa * baoa - rr * baba;
  if (a > 1e-12) {
    const h = b * b - a * c;
    if (h < 0) return -1;
    const root = Math.sqrt(h), t = (-b - root) / a;
    if (t > 1) return -1;
    const along = baoa + t * bard;
    if (along > 0 && along < baba) {
      if (t >= 0) return t;
      return (-b + root) / a >= 0 ? 0 : -1;
    }
  }
  // The round ends.
  const toA = trunkSphereEntry(oax, oay, oaz, dx, dy, dz, dd, rr), toB = trunkSphereEntry(ox - bx, oy - by, oz - bz, dx, dy, dz, dd, rr);
  if (toA < 0) return toB;
  if (toB < 0) return toA;
  return Math.min(toA, toB);
}
function trunkSphereEntry(ox, oy, oz, dx, dy, dz, dd, rr) {
  const b = dx * ox + dy * oy + dz * oz, c = ox * ox + oy * oy + oz * oz - rr, h = b * b - dd * c;
  if (h < 0 || dd <= 0) return -1;
  const root = Math.sqrt(h), t = (-b - root) / dd;
  if (t > 1) return -1;
  if (t >= 0) return t;
  return (-b + root) / dd >= 0 ? 0 : -1;
}

/**
 * The first wood on this line, of the trees that still stand. `from` and `to` are world points, the ball's own radius
 * counts, and nothing is allocated unless something is struck.
 */
export function sweepForestTrunks(grid, from, to, radius = 0.08) {
  if (!grid?.trees) return null;
  const ax = from[0], ay = from[1], az = from[2], bx = to[0], by = to[1], bz = to[2];
  const lowY = (ay < by ? ay : by) - radius, highY = (ay > by ? ay : by) + radius;
  if (highY < grid.minY || lowY > grid.maxY) return null;
  const lowX = (ax < bx ? ax : bx) - radius, highX = (ax > bx ? ax : bx) + radius, lowZ = (az < bz ? az : bz) - radius, highZ = (az > bz ? az : bz) + radius;
  const widest = grid.widest;
  if (highX + widest < grid.minX || lowX - widest > grid.maxX || highZ + widest < grid.minZ || lowZ - widest > grid.maxZ) return null;
  const { tree, rootOf, shapeOf, shapes, mask, keyX, keyZ, filled, counts, starts, roots } = grid;
  const cx0 = Math.floor((lowX - widest) / TRUNK_CELL_M), cx1 = Math.floor((highX + widest) / TRUNK_CELL_M), cz0 = Math.floor((lowZ - widest) / TRUNK_CELL_M), cz1 = Math.floor((highZ + widest) / TRUNK_CELL_M);
  const lineX = bx - ax, lineY = by - ay, lineZ = bz - az;
  let best = 1.0000001, bestTree = -1, bestSection = -1;
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
    let h = trunkCellHash(cx, cz, mask);
    while (filled[h] && (keyX[h] !== cx || keyZ[h] !== cz)) h = (h + 1) & mask;
    if (!filled[h]) continue;
    const start = starts[h], end = start + counts[h];
    for (let i = start; i < end; i++) {
      const t = i * TRUNK_TREE_FLOATS, x = tree[t], z = tree[t + 2], reach = tree[t + 6] + radius;
      if (x + reach < lowX || x - reach > highX || z + reach < lowZ || z - reach > highZ || tree[t + 8] < lowY || tree[t + 7] > highY) continue;
      const scale = tree[t + 3], c = tree[t + 4], s = tree[t + 5], shape = shapes[shapeOf[i]], y = tree[t + 1];
      // A felled tree's sections stand only as high as the stump it left.
      const root = rootOf[i] * TRUNK_ROOT_FLOATS, stump = roots[root + TRUNK_ROOT_STRUCK] < 0 ? ((roots[root + TRUNK_ROOT_FALL] | 0) & 2047) / FOREST_FALL_HEIGHT_STEPS : Infinity;
      const fx = ax - x, fz = az - z, ox = (c * fx + s * fz) / scale, oy = (ay - y) / scale, oz = (-s * fx + c * fz) / scale;
      const dx = (c * lineX + s * lineZ) / scale, dy = lineY / scale, dz = (-s * lineX + c * lineZ) / scale, dd = dx * dx + dy * dy + dz * dz;
      const ballR = radius / scale, nodes = shape.nodes, capsules = shape.capsules;
      const ex = ox + dx, ey = oy + dy, ez = oz + dz;
      const boxLowX = (ox < ex ? ox : ex) - ballR, boxHighX = (ox > ex ? ox : ex) + ballR, boxLowY = (oy < ey ? oy : ey) - ballR, boxHighY = (oy > ey ? oy : ey) + ballR, boxLowZ = (oz < ez ? oz : ez) - ballR, boxHighZ = (oz > ez ? oz : ez) + ballR;
      for (let n = 0, total = nodes.length; n < total;) {
        const holds = nodes[n + 7];
        if (nodes[n] > boxHighX || nodes[n + 1] > boxHighY || nodes[n + 2] > boxHighZ || nodes[n + 3] < boxLowX || nodes[n + 4] < boxLowY || nodes[n + 5] < boxLowZ || nodes[n + 1] > stump) {
          n = holds > 0 ? n + 8 : nodes[n + 6] * 8;
          continue;
        }
        if (holds > 0) {
          const first = nodes[n + 6], last = first + holds;
          for (let k = first; k < last; k++) {
            const at = k * 8, ra = capsules[at + 3], rb = capsules[at + 7];
            if (capsules[at + 1] > stump && capsules[at + 5] > stump) continue;
            const entry = trunkSectionEntry(ox, oy, oz, dx, dy, dz, dd, capsules[at], capsules[at + 1], capsules[at + 2], capsules[at + 4], capsules[at + 5], capsules[at + 6], (ra > rb ? ra : rb) + ballR);
            if (entry >= 0 && entry < best) { best = entry; bestTree = i; bestSection = k; }
          }
        }
        n += 8;
      }
    }
  }
  if (bestTree < 0) return null;
  return describeTrunkHit(grid, bestTree, bestSection, best, from, lineX, lineY, lineZ);
}

function describeTrunkHit(grid, i, section, fraction, from, lineX, lineY, lineZ) {
  const t = i * TRUNK_TREE_FLOATS, { tree } = grid, shape = grid.shapes[grid.shapeOf[i]], x = tree[t], y = tree[t + 1], z = tree[t + 2], scale = tree[t + 3], c = tree[t + 4], s = tree[t + 5];
  const hx = from[0] + lineX * fraction, hy = from[1] + lineY * fraction, hz = from[2] + lineZ * fraction;
  // In the tree's own frame: the section's axis at the point struck.
  const fx = hx - x, fz = hz - z, px = (c * fx + s * fz) / scale, py = (hy - y) / scale, pz = (-s * fx + c * fz) / scale, at = section * 8, cap = shape.capsules;
  const ax = cap[at], ay = cap[at + 1], az = cap[at + 2], bax = cap[at + 4] - ax, bay = cap[at + 5] - ay, baz = cap[at + 6] - az, len2 = bax * bax + bay * bay + baz * baz || 1;
  const along = Math.max(0, Math.min(1, ((px - ax) * bax + (py - ay) * bay + (pz - az) * baz) / len2));
  const nx = px - ax - bax * along, ny = py - ay - bay * along, nz = pz - az - baz * along, n = Math.hypot(nx, ny, nz) || 1;
  const rootIndex = grid.rootOf[i], wx = c * nx - s * nz, wz = s * nx + c * nz;
  return {
    fraction,
    kind: 'scenery',
    sceneryType: shape.species === 'palm' || shape.species === 'royal_palm' ? 'palm' : 'tree',
    treeIndex: rootIndex,
    sceneryPos: [x, y, z],
    normal: [wx / n, ny / n, wz / n],
    forestTree: {
      roots: grid.roots, rootIndex, x, z, species: shape.species, onTrunk: shape.onTrunk[section] === 1,
      // Where on the tree, in its own frame: the shader wounds and breaks it at this height.
      height: ay + bay * along,
    },
  };
}

// --- What shot does ------------------------------------------------------------------------------------------------

// A ball's energy is spent breaking the wood across the trunk. A 24-pounder carries about 1,200 kJ at the muzzle and
// half that at long range: one snaps a palm or a slender tree, and it takes two or more to bring down a hardwood.
const TRUNK_BREAK_JOULES_PER_M2 = 8000000;
const STRIKE_LIMB_SHARE = 0.25;
const TREE_STRIKE_REACH_M = 6;
const STRIKE_BLAST_DAMAGE = 1 / 3;
const STRIKE_CHAR = 0.6;
export const FOREST_FALL_SECONDS = 3.6;

const encodeTreeFall = (height, bearing, restDegrees) => {
  const turn = ((bearing / (Math.PI * 2)) % 1 + 1) % 1;
  return (Math.max(0, Math.min(2047, Math.round(height * FOREST_FALL_HEIGHT_STEPS))))
    | ((Math.round(turn * FOREST_FALL_BEARINGS) % FOREST_FALL_BEARINGS) << 11)
    | (Math.max(0, Math.min(63, Math.round(restDegrees - FOREST_FALL_REST_MIN_DEG))) << 18);
};
const encodeTreeWound = (height, bearing, severity) => {
  const turn = ((bearing / (Math.PI * 2)) % 1 + 1) % 1;
  return Math.max(1, Math.min(2047, Math.round(height * FOREST_FALL_HEIGHT_STEPS)))
    | ((Math.round(turn * FOREST_WOUND_BEARINGS) % FOREST_WOUND_BEARINGS) << 11)
    | (Math.max(0, Math.min(127, Math.round(severity * 127))) << 17);
};

export const forestStrikeKey = (x, z) => Math.round(x * 100) * 1e7 + Math.round(z * 100);

// How far the fallen part comes down: its tip rests on the ground where it lands, past level if that lies below.
function treeRestingDegrees(root, at, record, shape, groundAt) {
  if (!groundAt || !shape) return 90;
  const scale = root[at + TRUNK_ROOT_SCALE], hinge = root[at + 1] + record.height * scale, reach = Math.max(0.5, (shape.top - record.height) * scale);
  const ground = groundAt(root[at] + Math.cos(record.bearing) * reach, root[at + 2] + Math.sin(record.bearing) * reach);
  if (!Number.isFinite(ground)) return 90;
  return Math.max(60, Math.min(120, 90 + Math.atan2(hinge - ground, reach) * 180 / Math.PI));
}

function writeStruckRoot(root, at, record, { falling = false, now = 0 } = {}) {
  if (record.damage >= 1) {
    root[at + TRUNK_ROOT_FALL] = encodeTreeFall(record.height, record.bearing, record.rest ?? 90);
    root[at + TRUNK_ROOT_STRUCK] = falling ? -Math.max(now, 1e-3) : FOREST_LONG_FALLEN;
  } else if (record.wounded) {
    root[at + TRUNK_ROOT_STRUCK] = encodeTreeWound(record.height, record.bearing, Math.min(1, record.damage + 0.25));
  }
}

function ensureStrikeRecord(strikes, x, z) {
  const key = forestStrikeKey(x, z);
  let record = strikes.get(key);
  if (!record) { record = { x, z, hits: 0, damage: 0, height: 1, bearing: 0, wounded: false, rest: 90, chars: 0 }; strikes.set(key, record); }
  return record;
}

const treeStands = (roots, at) => roots[at + TRUNK_ROOT_SCALE] > 0 && roots[at + TRUNK_ROOT_STRUCK] >= 0;

/**
 * A ball struck this tree. The record in `strikes` is what is saved, and the root is what the GPU reads: the caller writes
 * the root's 48 bytes to the buffer and nothing else. `impact` says how hard and which way it flew.
 */
export function strikeForestTree(roots, index, shape, { energy, bearing, height, onTrunk = true, hot = false, now = 0, groundAt = null }, strikes) {
  const at = index * TRUNK_ROOT_FLOATS;
  if (!treeStands(roots, at)) return null;
  const record = ensureStrikeRecord(strikes, roots[at], roots[at + 2]), scale = roots[at + TRUNK_ROOT_SCALE];
  const radius = Math.min(0.42, (shape?.trunkRadius || 0.2) * scale), resisted = TRUNK_BREAK_JOULES_PER_M2 * Math.PI * radius * radius;
  record.hits++;
  record.damage = Math.min(1, record.damage + (energy / resisted) * (onTrunk ? 1 : STRIKE_LIMB_SHARE));
  // Only a ball on the trunk says where the trunk goes.
  if (onTrunk || !record.wounded) {
    record.height = onTrunk ? height : Math.max(0.6, Math.min(height, (shape?.trunkTop ?? 2) * 0.5));
    record.bearing = bearing;
    record.wounded = true;
  }
  if (hot) { record.chars++; for (let k = 0; k < 3; k++) roots[at + TRUNK_ROOT_TINT + k] *= STRIKE_CHAR; }
  const felled = record.damage >= 1;
  if (felled) record.rest = treeRestingDegrees(roots, at, record, shape, groundAt);
  writeStruckRoot(roots, at, record, { falling: felled, now });
  return { record, felled };
}

// A blast near a tree, not a ball in it: it chars the nearest, and the third fells it. Returns its index, or -1.
export function strikeForestRoot(roots, count, x, z, strikes, { now = 0, shapeOf = () => null, groundAt = null } = {}) {
  let best = -1, bestDistance = TREE_STRIKE_REACH_M;
  for (let i = 0; i < count; i++) {
    const at = i * TRUNK_ROOT_FLOATS;
    if (!treeStands(roots, at)) continue;
    const distance = Math.hypot(roots[at] - x, roots[at + 2] - z);
    if (distance < bestDistance) { best = i; bestDistance = distance; }
  }
  if (best < 0) return -1;
  const at = best * TRUNK_ROOT_FLOATS, record = ensureStrikeRecord(strikes, roots[at], roots[at + 2]);
  record.hits++;
  record.chars++;
  record.damage = Math.min(1, record.damage + STRIKE_BLAST_DAMAGE + 1e-9);
  for (let k = 0; k < 3; k++) roots[at + TRUNK_ROOT_TINT + k] *= STRIKE_CHAR;
  if (record.damage >= 1) {
    if (!record.wounded) { record.height = 0.8; record.bearing = Math.atan2(roots[at + 2] - z, roots[at] - x); }
    record.rest = treeRestingDegrees(roots, at, record, shapeOf(roots[at + TRUNK_ROOT_PROTOTYPE] | 0), groundAt);
    writeStruckRoot(roots, at, record, { falling: true, now });
  }
  return best;
}

// Puts what is remembered back on a freshly streamed set of roots. A tree that fell before stays down. Saved positions can
// come back a fraction off, the same coast being laid out elsewhere on a later visit, so a tree is known within 2 cm.
const STRIKE_MATCH_M = 0.02;
const strikeCell = (x, z) => Math.floor(x) * 1e6 + Math.floor(z);
export function reapplyForestStrikes(roots, count, strikes) {
  if (!strikes.size) return;
  const cells = new Map();
  for (const record of strikes.values()) {
    for (const dx of [-STRIKE_MATCH_M, STRIKE_MATCH_M]) for (const dz of [-STRIKE_MATCH_M, STRIKE_MATCH_M]) {
      const key = strikeCell(record.x + dx, record.z + dz);
      let list = cells.get(key);
      if (!list) cells.set(key, list = []);
      if (!list.includes(record)) list.push(record);
    }
  }
  for (let i = 0; i < count; i++) {
    const at = i * TRUNK_ROOT_FLOATS, x = roots[at], z = roots[at + 2], list = cells.get(strikeCell(x, z));
    if (!list) continue;
    const record = list.find((r) => Math.abs(r.x - x) <= STRIKE_MATCH_M && Math.abs(r.z - z) <= STRIKE_MATCH_M);
    if (!record) continue;
    // From here on this root's own position names it, so the next ball finds what it has already suffered.
    strikes.delete(forestStrikeKey(record.x, record.z));
    record.x = x;
    record.z = z;
    strikes.set(forestStrikeKey(x, z), record);
    for (let k = 0; k < record.chars; k++) for (let c = 0; c < 3; c++) roots[at + TRUNK_ROOT_TINT + c] *= STRIKE_CHAR;
    writeStruckRoot(roots, at, record);
  }
}

// The saved form: one line per tree, short enough to keep every tree a long war brings down. Positions are in centimetres
// from the coast's own centre.
export function forestStrikesToSave(strikes, origin = { x: 0, z: 0 }) {
  const out = [];
  for (const r of strikes.values()) out.push([Math.round((r.x - origin.x) * 100), Math.round((r.z - origin.z) * 100), r.hits, +r.damage.toFixed(3), +r.height.toFixed(2), +r.bearing.toFixed(2), Math.round(r.rest), r.chars, r.wounded ? 1 : 0]);
  return out;
}
export function forestStrikesFromSave(saved, origin = { x: 0, z: 0 }, strikes = new Map()) {
  for (const line of Array.isArray(saved) ? saved : []) {
    if (!Array.isArray(line) || !line.every(Number.isFinite)) continue;
    const [xCm, zCm, hits, damage, height, bearing, rest, chars, wounded] = line, x = origin.x + xCm / 100, z = origin.z + zCm / 100;
    strikes.set(forestStrikeKey(x, z), { x, z, hits, damage, height, bearing, rest, chars, wounded: wounded === 1 });
  }
  return strikes;
}
