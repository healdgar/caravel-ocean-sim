// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How a ship comes apart. Parts say what a piece is; damage says how much it has taken; fracture says
// which pieces leave, and what goes with them. A vertex never moves on its own here. Every piece moves
// as one rigid body, so nothing can stretch or pinch, and whatever it held up goes with it.
//
// Built once per model, like Unreal's geometry collection:
//  - shard 0 is everything that stays (keel, decks, hull below the waterline).
//  - Skin parts break into plank-sized shards, using the same Voronoi cells as building masonry.
//  - A mast divides at its fracture heights. Everything on it (rings, tops, yards, sails, rigging) belongs
//    to the section it is fixed to, so those fall as one body. No fitting is left standing in space.
//  - Touching shards are linked. A shard with no path back to what stays is released as well.
// Vertices shared between shards are duplicated at the end of the vertex buffer. Earlier vertices keep
// their bytes and intact ships look exactly as they did.
//
// At runtime JavaScript runs only when a ship is hit. It writes one compact flight record per released
// shard, and js/wgsl/ship-fracture.js evaluates the flight on the GPU every frame.

import { sampleVoronoiBlockCell } from './part-assembly.js';
import { classifyShipPartTaxonomy, expandShipPartGroups } from './ship-part-taxonomy.js';
import { SHIP_FRACTURE_POSE_UPDATE } from './wgsl/ship-fracture.js';

// [mast, axis z, height of the topmast break, height of the full break], in design units.
export function shipMastSpecs(modelId) {
  if (modelId === 'taino-canoe') return [];
  if (modelId === 'oseberg' || modelId === 'lusoria') return [['main', 0.0, 4.2, 1.15]];
  if (modelId === 'gipsy-moth-iv') return [['main', -1.15, 4.8, 1.25], ['mizzen', 2.7, 3.4, 1.15]];
  if (modelId === 'nina') return [['fore', -1.94, 5.1, 1.45], ['main', 2.14, 4.35, 1.35], ['mizzen', 4.86, 3.95, 1.85]];
  if (modelId === 'pinta') return [['fore', -3.18, 4.2, 1.45], ['main', 0.1, 5.2, 1.35], ['mizzen', 3.8, 3.8, 1.75]];
  if (modelId === 'santa-maria') return [['fore', -3.55, 4.6, 1.65], ['main', 0.05, 5.65, 1.45], ['mizzen', 4.51, 4.1, 1.95]];
  if (modelId === 'flying-cloud') return [['fore', -3.31, 5.6, 1.45], ['main', -0.11, 6.1, 1.4], ['mizzen', 3.45, 5.1, 1.55]];
  // Victory's breaks are her real joints: the stump's top, and the doubling at each lower masthead.
  return [['fore', -3.55, 5.72, 1.59], ['main', 0.05, 6.18, 1.55], ['mizzen', 3.53, 5.15, 2.08]];
}

// Masts stepped in overlapping sections already separate at their joints, so nothing needs cutting.
const SPLICED_MASTS = new Set(['victory']);

export const SHARD_KINDS = Object.freeze({ skin: 1, whole: 2, gun: 3, mast: 4, line: 5 });
const WATERLINE_MARGIN = 0.35, ROPE_MATERIALS = new Set([2, 12, 19]);
// A line is made fast this far below its top end, in design units, which decides the section it goes with.
export const LINE_MADE_FAST_BELOW_TOP = 0.5;

const isHullSkin = (id) => /^(hull$|hull\.(planking|outer|inner|clinker-laps|gunwales|wales|closure)|wale:)/.test(id);
const isUpperSkin = (id) => /^(bulwark:-?\d|bulwark\.(port|starboard)|bulwark$|cabin$|cabin\.|structure\.|stern\.|transom|rail\.|bow\.structure)/.test(id);
const isRig = (id) => /^(mast\.|yard\.|spar\.|sail\.|rig\.|rope\.|tackle\.|lookout\.)/.test(id);
const isFixed = (id) => /^(mast\.trunk\.|flag\.|deck\.|hatch\.|magazine\.|helm\.|rowing\.|boat\.|frames\.|stair|hull\.(keel|sternpost|stem|frames|copper|closed|carved|stern-frames|keel-stem)|bulwark\.frames|bow\.(stem|knee|cutwater))/.test(id);

function shardFamily(id) {
  if (isHullSkin(id)) return 'hull';
  if (isUpperSkin(id)) return id.replace(/[:.].*$/, '');
  return null;
}

function leafGroups(groups, triangles) {
  const ranked = groups
    .map((group, index) => ({ group, index, first: Math.floor(group.firstVertex / 3), count: Math.floor(group.vertexCount / 3) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index);
  const leaf = new Int32Array(triangles).fill(-1);
  for (const r of ranked) leaf.fill(r.index, r.first, Math.min(triangles, r.first + r.count));
  return leaf;
}

// The original typed array, plus whatever has been appended to it, read as one sequence of floats.
function createVertexStore(vertices) {
  const base = vertices.length, extra = [];
  return {
    get: (i) => (i < base ? vertices[i] : extra[i - base]),
    get length() { return base + extra.length; },
    push(...values) { extra.push(...values); },
    copyVertex(v) { for (let c = 0; c < 9; c++) extra.push(this.get(v * 9 + c)); },
    finish() { const out = new Float32Array(base + extra.length); out.set(vertices); out.set(extra, base); return out; },
  };
}

const quantize = (x, y, z) => (Math.round(x * 1000) + 32768) * 4294967296 + (Math.round(y * 1000) + 32768) * 65536 + (Math.round(z * 1000) + 32768);

// One rope, spar or fitting is one connected island of triangles.
function connectedIslands(triangleList, indices, store) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const next = parent.get(x); parent.set(x, r); x = next; }
    return r;
  };
  const keyOf = (t, k) => { const at = indices[t * 3 + k] * 9; return quantize(store.get(at), store.get(at + 1), store.get(at + 2)); };
  for (const t of triangleList) {
    const a = keyOf(t, 0), b = keyOf(t, 1), c = keyOf(t, 2);
    for (const key of [a, b, c]) if (!parent.has(key)) parent.set(key, key);
    parent.set(find(b), find(a));
    parent.set(find(c), find(a));
  }
  const islands = new Map();
  for (const t of triangleList) {
    const root = find(keyOf(t, 0));
    let island = islands.get(root);
    if (!island) islands.set(root, island = { triangles: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], material: Math.floor(store.get(indices[t * 3] * 9 + 6)) });
    island.triangles.push(t);
    for (let k = 0; k < 3; k++) {
      const at = indices[t * 3 + k] * 9;
      for (let c = 0; c < 3; c++) {
        const value = store.get(at + c);
        if (value < island.min[c]) island.min[c] = value;
        if (value > island.max[c]) island.max[c] = value;
      }
    }
  }
  return [...islands.values()];
}

// Split a spar's triangles near one height. Records grow only at the end, so earlier vertices keep their
// bytes. A cut vertex stays on its original edge, and both sides share it, so an intact spar has the same
// surface and no seam. The rim wanders up and down its edges, which reads as splinters once the two part.
function cutIsland(island, height, indices, store, newIndices) {
  const base = indices.length / 3;
  const indexOf = (t, k) => (t < base ? indices[t * 3 + k] : newIndices[(t - base) * 3 + k]);
  const setTriangle = (t, a, b, c) => {
    const target = t < base ? indices : newIndices, at = (t < base ? t : t - base) * 3;
    target[at] = a; target[at + 1] = b; target[at + 2] = c;
  };
  const below = [], above = [], rim = [];
  // Across the spar, not along its rake.
  const radius = Math.min(island.max[0] - island.min[0], island.max[2] - island.min[2]) * 0.5;
  const at = (v, c) => store.get(v * 9 + c);
  const edgeCut = new Map();
  const cutVertex = (a, b) => {
    const key = a < b ? a * 1e7 + b : b * 1e7 + a;
    if (edgeCut.has(key)) return edgeCut.get(key);
    const span = at(b, 1) - at(a, 1), level = (height - at(a, 1)) / span;
    const wander = Math.sin((at(a, 0) + (at(b, 0) - at(a, 0)) * level) * 91.7 + (at(a, 2) + (at(b, 2) - at(a, 2)) * level) * 53.3) * radius * 0.42;
    const t = Math.max(0.02, Math.min(0.98, (height + wander - at(a, 1)) / span)), record = [];
    for (let c = 0; c < 9; c++) record.push(c === 6 ? at(a, 6) : at(a, c) + (at(b, c) - at(a, c)) * t);
    const v = store.length / 9;
    store.push(...record);
    edgeCut.set(key, v);
    return v;
  };
  for (const t of island.triangles) {
    const tri = [indexOf(t, 0), indexOf(t, 1), indexOf(t, 2)];
    const up = tri.map((v) => at(v, 1) > height);
    const count = up.filter(Boolean).length;
    if (count === 0) { below.push(t); continue; }
    if (count === 3) { above.push(t); continue; }
    const lone = up.findIndex((u) => u === (count === 1));
    const L = tri[lone], P = tri[(lone + 1) % 3], Q = tri[(lone + 2) % 3];
    const loneAbove = at(L, 1) > height;
    const M = cutVertex(L, P), N = cutVertex(L, Q);
    // The original triangle's slot keeps its place in its group; the two extra triangles go at the end.
    setTriangle(t, L, M, N);
    (loneAbove ? above : below).push(t);
    const start = newIndices.length / 3;
    newIndices.push(M, P, Q, M, Q, N);
    (loneAbove ? below : above).push(base + start, base + start + 1);
    rim.push([M, N]);
  }
  // A cap of fresh wood closes each side, material 17 wherever the spar was painted. It sits just inside
  // the rim and points into the other side, so nothing shows until the spar parts.
  if (rim.length) {
    let cx = 0, cz = 0, cy = 0, n = 0;
    for (const edge of rim) for (const v of edge) { cx += at(v, 0); cy += at(v, 1); cz += at(v, 2); n++; }
    cx /= n; cy /= n; cz /= n;
    for (const [side, ny] of [[below, 1], [above, -1]]) {
      const copy = (x, y, z, u, v) => { const i = store.length / 9; store.push(x, y, z, 0, ny, 0, 17, u, v); return i; };
      const inset = (v) => copy(cx + (at(v, 0) - cx) * 0.98, at(v, 1), cz + (at(v, 2) - cz) * 0.98, at(v, 7), at(v, 8));
      const centre = copy(cx, cy + ny * radius * 0.5, cz, cx, cz);
      for (const [a, b] of rim) {
        const ca = inset(a), cb = inset(b), start = newIndices.length / 3;
        newIndices.push(centre, ca, cb);
        side.push(base + start);
      }
    }
  }
  return { below, above };
}

function mastOfPart(id, nodeId, modelId, specs) {
  const named = classifyShipPartTaxonomy(modelId, { id, nodeId }).mastGroup;
  if (named && specs.some((s) => s[0] === named)) return named;
  return null;
}

const nearestMast = (specs, z) => specs.reduce((best, s) => (Math.abs(s[1] - z) < Math.abs(best[1] - z) ? s : best), specs[0]);

/**
 * Prepare a model's fracture data. Returns grown vertex and index arrays plus the fracture table.
 * Groups address index ranges, so every original triangle stays in its slot; new triangles go at the end
 * under `mast.<id>.cut` groups.
 */
export function prepareShipFracture({ modelId, model = null, vertices, indices, groups }) {
  const frame = model?.designFrame, runtime = model?.runtime;
  const scale = [
    frame?.beam && runtime?.beam ? runtime.beam / frame.beam : 1,
    frame?.verticalScale ?? 1,
    frame?.length && runtime?.length ? runtime.length / frame.length : 1,
  ];
  const lengthMetres = runtime?.length ?? 20;
  // Plank-sized on a caravel, longer lengths of timber on a first-rate.
  const cellFactor = Math.max(0.75, Math.min(1.4, lengthMetres / 26));
  const specs = shipMastSpecs(modelId);
  const allGroups = expandShipPartGroups(modelId, groups, vertices, indices);
  const baseTriangles = indices.length / 3;
  const leaf = leafGroups(allGroups, baseTriangles);
  const outIndices = indices.slice();
  const store = createVertexStore(vertices), extraIndices = [];

  const byGroup = new Map();
  for (let t = 0; t < baseTriangles; t++) {
    const g = leaf[t];
    if (g < 0) continue;
    (byGroup.get(g) ?? byGroup.set(g, []).get(g)).push(t);
  }

  // triangle -> shard key
  const triKeys = new Map();
  const shardMeta = new Map(), skinNames = new Map();
  const assign = (t, key, meta) => { triKeys.set(t, key); if (!shardMeta.has(key)) shardMeta.set(key, meta); };
  const newGroupRanges = new Map();
  // [triangle, mast number + 1] for every spar, so a shot can strike one and hurt the right mast.
  const sparTriangles = [];
  const markSpar = (list, mastId) => { const number = specs.findIndex((spec) => spec[0] === mastId) + 1; for (const t of list) sparTriangles.push(t, number); };

  for (const [g, triangles] of byGroup) {
    const group = allGroups[g], id = String(group.id ?? '');
    if (isFixed(id)) {
      if (/^mast\.trunk\./.test(id) && specs.length) markSpar(triangles, mastOfPart(id, group.nodeId ?? '', modelId, specs) ?? nearestMast(specs, store.get(outIndices[triangles[0] * 3] * 9 + 2))[0]);
      continue;
    }
    if (isRig(id)) {
      if (!specs.length) continue;
      const named = mastOfPart(id, group.nodeId ?? '', modelId, specs);
      const isSpar = /^mast\./.test(id);
      const wholePart = /^(sail\.|yard\.|spar\.|tackle\.)/.test(id);
      // Sails and yards hang as one thing; a mast or a set of standing rigging is many.
      const islands = wholePart
        ? (() => {
            const island = { triangles, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], material: -1 };
            for (const t of triangles) for (let k = 0; k < 3; k++) {
              const at = outIndices[t * 3 + k] * 9;
              for (let c = 0; c < 3; c++) {
                const value = store.get(at + c);
                if (value < island.min[c]) island.min[c] = value;
                if (value > island.max[c]) island.max[c] = value;
              }
            }
            return [island];
          })()
        : connectedIslands(triangles, outIndices, store);
      for (const island of islands) {
        const midZ = (island.min[2] + island.max[2]) * 0.5;
        const spec = (named && specs.find((s) => s[0] === named)) || nearestMast(specs, midZ);
        const [mast, mastZ, topCut, fullCut] = spec;
        const pieces = [{ triangles: island.triangles, min: island.min, max: island.max, material: island.material }];
        // A pole mast has no joint, so give it one at each break height.
        if (isSpar && !SPLICED_MASTS.has(modelId) && island.max[1] - island.min[1] > 1) {
          for (const height of [fullCut, topCut]) {
            for (let p = pieces.length - 1; p >= 0; p--) {
              const piece = pieces[p];
              if (piece.min[1] >= height || piece.max[1] <= height) continue;
              const before = extraIndices.length;
              const { below, above } = cutIsland(piece, height, outIndices, store, extraIndices);
              if (extraIndices.length > before) {
                const ranges = newGroupRanges.get(`mast.${mast}.cut`) ?? { first: before / 3, nodeId: group.nodeId, end: 0 };
                ranges.end = extraIndices.length / 3;
                newGroupRanges.set(`mast.${mast}.cut`, ranges);
              }
              pieces.splice(p, 1,
                { triangles: below, min: [piece.min[0], piece.min[1], piece.min[2]], max: [piece.max[0], height, piece.max[2]], material: piece.material },
                { triangles: above, min: [piece.min[0], height, piece.min[2]], max: [piece.max[0], piece.max[1], piece.max[2]], material: piece.material });
            }
          }
        }
        for (const piece of pieces) {
          // Some standing lines are drawn in fitting material, but a bare open tube is still a rope.
          // So is anything long in the rigging that is not a spar. A triangular headsail hangs from a stay,
          // and goes with it as a rigid sheet would stand up out of the sea.
          const longest = Math.max(piece.max[0] - piece.min[0], piece.max[1] - piece.min[1], piece.max[2] - piece.min[2]);
          const isRope = ROPE_MATERIALS.has(piece.material) || /jib|staysail/.test(id)
            || (!wholePart && ((piece.triangles.length <= 16 && longest > 0.4) || (!isSpar && longest > 1)));
          const mid = (piece.min[1] + piece.max[1]) * 0.5;
          // A line belongs to what its top end is made fast to. Anything rigid belongs to where it sits.
          const anchorY = isRope ? piece.max[1] - LINE_MADE_FAST_BELOW_TOP : mid;
          let segment = anchorY >= topCut ? 2 : anchorY >= fullCut ? 1 : 0;
          if (isSpar && !isRope) markSpar(piece.triangles, mast);
          if (isRope && segment === 0) segment = 1;
          // An upper sail's running rig hangs from that sail, wherever its line lies at rest.
          if (isRope && /\.t[2-9](\.|$)/.test(id)) segment = 2;
          if (wholePart && segment === 0) segment = 1;
          if (segment === 0) continue;
          // A stay led to another mast goes when either mast goes: it has nothing to end on.
          let ledTo = null;
          if (isRope) {
            let lowY = Infinity, lowX = 0, lowZ = 0;
            for (const t of piece.triangles) for (let k = 0; k < 3; k++) {
              const v = (t < baseTriangles ? outIndices[t * 3 + k] : extraIndices[(t - baseTriangles) * 3 + k]) * 9, y = store.get(v + 1);
              if (y < lowY) { lowY = y; lowX = store.get(v); lowZ = store.get(v + 2); }
            }
            const other = specs.find((o) => o[0] !== mast && Math.abs(lowX) < 0.4 && Math.abs(lowZ - o[1]) < 0.4 && lowY > o[3] + 0.2);
            if (other) ledTo = { mast: other[0], segment: lowY >= other[2] ? 2 : 1 };
          }
          const key = `mast:${mast}:${segment}:${isRope ? 'line' : 'spar'}${ledTo ? `:${ledTo.mast}:${ledTo.segment}` : ''}`;
          const meta = { kind: isRope ? SHARD_KINDS.line : SHARD_KINDS.mast, partId: id, mast, segment, ledTo };
          for (const t of piece.triangles) assign(t, key, meta);
        }
      }
      continue;
    }
    const gun = /^gunnery\.recoil\.(\d+)$/.exec(id);
    if (gun) {
      const meta = { kind: SHARD_KINDS.gun, partId: id, gunId: Number(gun[1]) };
      for (const t of triangles) assign(t, `gun:${gun[1]}`, meta);
      continue;
    }
    const family = shardFamily(id);
    let spanZ = 0, min = Infinity, max = -Infinity;
    for (const t of triangles) for (let k = 0; k < 3; k++) {
      const z = store.get(outIndices[t * 3 + k] * 9 + 2);
      if (z < min) min = z;
      if (z > max) max = z;
    }
    spanZ = max - min;
    if (family && (triangles.length > 60 || spanZ * scale[2] > cellFactor * 3)) {
      const hullFamily = family === 'hull', k = 1 / cellFactor;
      for (const t of triangles) {
        let x = 0, y = 0, z = 0;
        for (let j = 0; j < 3; j++) { const at = outIndices[t * 3 + j] * 9; x += store.get(at); y += store.get(at + 1); z += store.get(at + 2); }
        x /= 3; y /= 3; z /= 3;
        if (hullFamily && y < WATERLINE_MARGIN) continue;
        const cell = sampleVoronoiBlockCell(x * scale[0] * k, y * scale[1] * k, z * scale[2] * k, true);
        // Plank-shaped cells on each side of her, numbered without building a string per triangle.
        const number = (x >= 0 ? 1 : 0) + 2 * ((Math.round(cell.sx * 10) + 8192) * 268435456 + (Math.round(cell.sy * 10) + 8192) * 16384 + (Math.round(cell.sz * 10) + 8192));
        const names = skinNames.get(family) ?? skinNames.set(family, new Map()).get(family);
        let key = names.get(number);
        if (!key) names.set(number, key = `skin:${family}:${x >= 0 ? 1 : -1}:${number}`);
        assign(t, key, { kind: SHARD_KINDS.skin, partId: id, family });
      }
      continue;
    }
    // Small fittings are one piece: rails, head timbers, port lids, chainwales, catheads and the like.
    const layerFitting = /^(bulwark|bow\.|gun\.lid|gun\.(lower|middle|upper|quarter|forecastle)|chainwale\.|anchor|stern\.|rail\.|wale)/.test(id);
    if (layerFitting && triangles.length <= 450 && spanZ <= 2.2) {
      const key = `whole:${id}`;
      for (const t of triangles) assign(t, key, { kind: SHARD_KINDS.whole, partId: id });
    }
  }

  // Fold slivers into a neighbour: they read as confetti and each costs a flight record.
  const posTable = new Map();
  const tris = baseTriangles + extraIndices.length / 3;
  const triIndex = (t, k) => (t < baseTriangles ? outIndices[t * 3 + k] : extraIndices[(t - baseTriangles) * 3 + k]);
  const shardTris = new Map();
  for (const [t, key] of triKeys) (shardTris.get(key) ?? shardTris.set(key, []).get(key)).push(t);
  for (const [key, list] of shardTris) {
    for (const t of list) for (let k = 0; k < 3; k++) {
      const at = triIndex(t, k) * 9, p = quantize(store.get(at), store.get(at + 1), store.get(at + 2));
      const owners = posTable.get(p);
      if (!owners) posTable.set(p, [key]);
      else if (!owners.includes(key)) owners.push(key);
    }
  }
  for (const [key, list] of shardTris) {
    if (!key.startsWith('skin:') || list.length >= 12) continue;
    const family = key.split(':').slice(0, 3).join(':');
    let target = null;
    for (const t of list) {
      for (let k = 0; k < 3 && !target; k++) {
        const at = triIndex(t, k) * 9, owners = posTable.get(quantize(store.get(at), store.get(at + 1), store.get(at + 2)));
        target = owners?.find((o) => o !== key && o.startsWith(family) && (shardTris.get(o)?.length ?? 0) >= 12) ?? null;
      }
      if (target) break;
    }
    if (!target) continue;
    for (const t of list) { triKeys.set(t, target); shardTris.get(target).push(t); }
    shardTris.delete(key);
    shardMeta.delete(key);
  }

  // Number the shards.
  const keys = [...shardTris.keys()];
  const shardIndex = new Map(keys.map((key, i) => [key, i + 1]));
  const shardCount = keys.length + 1;

  // Give each shard its own copy of any vertex it shares.
  const combined = new Uint32Array(tris * 3);
  combined.set(outIndices);
  if (extraIndices.length) combined.set(extraIndices, outIndices.length);
  const owner = new Int32Array(store.length / 9 + tris * 3).fill(-1);
  const copies = new Map();
  const triShard = new Uint32Array(tris);
  for (const [t, key] of triKeys) triShard[t] = shardIndex.get(key);
  for (let t = 0; t < tris; t++) {
    const s = triShard[t];
    for (let k = 0; k < 3; k++) {
      const slot = t * 3 + k, v = combined[slot];
      if (owner[v] === -1) { owner[v] = s; continue; }
      if (owner[v] === s) continue;
      const copyKey = v * 65536 + s;
      let copy = copies.get(copyKey);
      if (copy === undefined) {
        copy = store.length / 9;
        store.copyVertex(v);
        copies.set(copyKey, copy);
        owner[copy] = s;
      }
      combined[slot] = copy;
    }
  }
  const outVertices = store.finish();
  const sparMasts = new Uint8Array(tris);
  for (let i = 0; i < sparTriangles.length; i += 2) sparMasts[sparTriangles[i]] = sparTriangles[i + 1];
  const vertexCount = outVertices.length / 9;
  const vertexShards = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) vertexShards[v] = owner[v] > 0 ? owner[v] : 0;

  // What each shard is.
  const shards = [null];
  for (const key of keys) {
    const list = shardTris.get(key), meta = shardMeta.get(key);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let area = 0;
    for (const t of list) {
      const a = combined[t * 3] * 9, b = combined[t * 3 + 1] * 9, c = combined[t * 3 + 2] * 9;
      for (const at of [a, b, c]) for (let i = 0; i < 3; i++) {
        if (outVertices[at + i] < min[i]) min[i] = outVertices[at + i];
        if (outVertices[at + i] > max[i]) max[i] = outVertices[at + i];
      }
      const ux = (outVertices[b] - outVertices[a]) * scale[0], uy = (outVertices[b + 1] - outVertices[a + 1]) * scale[1], uz = (outVertices[b + 2] - outVertices[a + 2]) * scale[2];
      const wx = (outVertices[c] - outVertices[a]) * scale[0], wy = (outVertices[c + 1] - outVertices[a + 1]) * scale[1], wz = (outVertices[c + 2] - outVertices[a + 2]) * scale[2];
      area += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    }
    shards.push({
      index: shards.length, ...meta, min, max, area,
      centroid: [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5],
      triangleCount: list.length, links: [], anchored: false,
    });
  }

  // Contact: anything within a few centimetres of real scale touches. Skin and fittings only; rigging hangs.
  const free = (s) => s.kind === SHARD_KINDS.skin || s.kind === SHARD_KINDS.whole;
  const cellSize = 0.18 * Math.max(1, cellFactor);
  const cells = new Map();
  for (let v = 0; v < vertexCount; v++) {
    const at = v * 9;
    const ix = Math.floor((outVertices[at] * scale[0]) / cellSize), iy = Math.floor((outVertices[at + 1] * scale[1]) / cellSize), iz = Math.floor((outVertices[at + 2] * scale[2]) / cellSize);
    const key = (ix + 4096) * 67108864 + (iy + 4096) * 8192 + (iz + 4096);
    const s = vertexShards[v], list = cells.get(key);
    if (!list) cells.set(key, [s]);
    else if (!list.includes(s)) list.push(s);
  }
  for (const list of cells.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      const a = shards[list[i]];
      if (a && !free(a)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = shards[list[j]];
        if (b && !free(b)) continue;
        if (!a) { b.anchored = true; continue; }
        if (!b) { a.anchored = true; continue; }
        if (!a.links.includes(b.index)) { a.links.push(b.index); b.links.push(a.index); }
      }
    }
  }
  // A component that never touched what stays is held by geometry too coarse to see. Leave it standing.
  const seen = new Uint8Array(shardCount);
  for (const shard of shards) {
    if (!shard || !free(shard) || seen[shard.index]) continue;
    const stack = [shard.index], component = [];
    let anchored = false;
    seen[shard.index] = 1;
    while (stack.length) {
      const s = shards[stack.pop()];
      component.push(s);
      anchored ||= s.anchored;
      for (const next of s.links) if (!seen[next]) { seen[next] = 1; stack.push(next); }
    }
    if (!anchored) for (const s of component) s.anchored = true;
  }

  // Where a spar stands at a height, from its own vertices. A raked mast moves along her as it rises.
  const sparStation = (number, height, fallback) => {
    let sum = 0, count = 0;
    for (let t = 0; t < tris; t++) {
      if (sparMasts[t] !== number) continue;
      for (let k = 0; k < 3; k++) {
        const at = combined[t * 3 + k] * 9;
        if (Math.abs(outVertices[at]) < 0.3 && Math.abs(outVertices[at + 1] - height) < 0.3) { sum += outVertices[at + 2]; count++; }
      }
    }
    return count ? sum / count : fallback;
  };
  const masts = {};
  for (const [index, [mast, z, topCut, fullCut]] of specs.entries()) {
    const of = (segment) => shards.filter((s) => s && s.mast === mast && s.segment === segment).map((s) => s.index);
    const led = (segment) => shards.filter((s) => s?.ledTo?.mast === mast && s.ledTo.segment === segment).map((s) => s.index);
    masts[mast] = { z, topCut, fullCut, topZ: sparStation(index + 1, topCut, z), fullZ: sparStation(index + 1, fullCut, z), upper: [...of(2), ...led(2)], lower: [...of(1), ...led(1)] };
  }
  const outGroups = [...groups];
  for (const [id, range] of newGroupRanges) {
    outGroups.push({ id, nodeId: range.nodeId, firstVertex: baseTriangles * 3 + range.first * 3, vertexCount: (range.end - range.first) * 3 });
  }
  const fracture = Object.freeze({
    modelId,
    scale: Object.freeze(scale),
    beamMetres: runtime?.beam ?? 6,
    // A first-rate's oak takes more shots than a caravel's.
    toughness: Math.max(1, Math.sqrt(lengthMetres / 20)),
    designFrame: frame ?? null,
    shardCount,
    vertexShards,
    vertices: outVertices,
    indices: combined,
    sparMasts,
    shards: Object.freeze(shards),
    masts: Object.freeze(masts),
    strikable: Object.freeze(shards.filter((s) => s && free(s)).map((s) => s.index)),
    guns: Object.freeze(shards.filter((s) => s && s.kind === SHARD_KINDS.gun).map((s) => s.index)),
  });
  return { vertices: outVertices, indices: combined, groups: outGroups, fracture };
}

// ---------------------------------------------------------------------------------------------------
// Flight. Each shard has four vec4 on the GPU:
//   [pivot.xyz (design units), t0]            when and about where it left
//   [velocity.xyz (m/s), settleAt]            free flight ends when it meets the water
//   [spin.xyz (rad/s), hideAt]                axis and rate; hideAt < 0 means it never goes
//   [hinge seconds, gravity scale, sink m/s, frozen age]
// Frozen age is -2 for intact, -1 for on the clock, and otherwise the age it is held at.
export const FRACTURE_RECORD_FLOATS = 16;
export const FRACTURE_INTACT = -2, FRACTURE_GRAVITY = 9.80665;
const INTACT = FRACTURE_INTACT, LIVE = -1, GRAVITY = FRACTURE_GRAVITY;

export function createShipFractureState(fracture) {
  const records = new Float32Array(fracture.shardCount * FRACTURE_RECORD_FLOATS);
  for (let s = 0; s < fracture.shardCount; s++) records[s * FRACTURE_RECORD_FLOATS + 15] = INTACT;
  return {
    fracture,
    records,
    broken: new Uint8Array(fracture.shardCount),
    wear: new Float32Array(fracture.shardCount),
    brokenCount: 0,
    dirty: new Set(),
    flying: new Set(),
    flightEnds: -Infinity,
    epoch: 0,
    revision: 0,
    partsGone: null,
    sideTops: null,
  };
}

export function shipFractureStateOf(damage, fracture) {
  if (!damage || !fracture) return null;
  if (damage.fracture?.fracture !== fracture) damage.fracture = createShipFractureState(fracture);
  return damage.fracture;
}

// Delay leaves the shard where it is for that long: a wall above a breach does not all let go at once.
export function writeFlight(state, s, flight, now) {
  const r = state.records, at = s * FRACTURE_RECORD_FLOATS, { pivot, velocity, spin, hinge = 0, gravity = 1, sink = 0, linger = 2, settle = null, keep = false, delay = 0 } = flight;
  const scaleY = state.fracture.scale[1];
  if (!state.flying.size) state.epoch = now;
  let settleAt = settle;
  if (settleAt === null) {
    const height = Math.max(0, pivot[1] * scaleY), g = GRAVITY * gravity;
    settleAt = hinge + (g > 0 ? (velocity[1] + Math.sqrt(velocity[1] * velocity[1] + 2 * g * height)) / g : 0);
  }
  r.set([pivot[0], pivot[1], pivot[2], now - state.epoch + delay, velocity[0], velocity[1], velocity[2], settleAt, spin[0], spin[1], spin[2], keep ? -1 : settleAt + linger, hinge, gravity, sink, LIVE], at);
  state.dirty.add(s);
  state.flying.add(s);
  const ends = now + delay + (keep ? settleAt : settleAt + linger);
  if (ends > state.flightEnds) state.flightEnds = ends;
  state.revision++;
}

function markBroken(state, s) {
  if (state.broken[s]) return false;
  state.broken[s] = 1;
  state.brokenCount++;
  return true;
}

// A cheap repeatable number for this shard, so a replayed battle looks the same.
const shardNoise = (s, salt) => { const x = Math.sin(s * 12.9898 + salt * 78.233) * 43758.5453; return x - Math.floor(x); };

// A shard shot away flies from where it was, spinning. Light splinters and window frames fly fast; heavy oak hull strakes heave outward with realistic mass.
function blowOff(state, s, now, { side = 0, power = 1, up = 1, drop = false } = {}) {
  const shard = state.fracture.shards[s];
  if (!shard || !markBroken(state, s)) return false;
  const a = shardNoise(s, 1), b = shardNoise(s, 2), c = shardNoise(s, 3);
  const outward = side || (shard.centroid[0] >= 0 ? 1 : -1);
  const [sx, sy, sz] = state.fracture.scale;
  const boxVol = Math.max(0.01, (shard.max[0] - shard.min[0]) * sx * (shard.max[1] - shard.min[1]) * sy * (shard.max[2] - shard.min[2]) * sz * 0.25);
  const massScale = power >= 1.8 ? 1.0 : Math.min(1.25, Math.max(0.42, 0.52 / Math.cbrt(boxVol)));
  const effPower = power * massScale;
  const velocity = drop
    ? [outward * (0.3 + a), 0.2 * b, (c - 0.5)]
    : [outward * (1.8 + 4.2 * a) * effPower, (0.8 + 3.2 * b) * up * effPower, (c - 0.5) * 4.0 * effPower];
  const rate = drop ? 1 + 2 * b : (2 + 5 * c) * Math.min(1.5, effPower);
  const axis = [a - 0.5, b - 0.5, c - 0.5], n = Math.hypot(...axis) || 1;
  writeFlight(state, s, { pivot: shard.centroid, velocity, spin: axis.map((v) => (v / n) * rate), linger: 95, sink: 0.012 }, now);
  return true;
}

// Whatever has lost its last path to the hull comes down too.
function releaseUnsupported(state, now) {
  const { shards, strikable } = state.fracture;
  const held = new Uint8Array(shards.length), stack = [];
  // Her frames hold her planking, so a hull plank goes only when nothing around it is left.
  const holds = (shard) => shard.anchored || (shard.family === 'hull' && shard.links.some((n) => !state.broken[n]));
  for (const s of strikable) if (!state.broken[s] && holds(shards[s])) { held[s] = 1; stack.push(s); }
  while (stack.length) for (const next of shards[stack.pop()].links) if (!held[next] && !state.broken[next]) { held[next] = 1; stack.push(next); }
  let released = 0;
  for (const s of strikable) if (!state.broken[s] && !held[s] && blowOff(state, s, now, { drop: true })) released++;
  return released;
}

function nearestDistanceMetres(shard, point, scale) {
  let sum = 0;
  for (let c = 0; c < 3; c++) {
    const d = point[c] < shard.min[c] ? shard.min[c] - point[c] : point[c] > shard.max[c] ? point[c] - shard.max[c] : 0;
    sum += (d * scale[c]) ** 2;
  }
  return Math.sqrt(sum);
}

function strike(state, point, { radius, amount, side = 0, power = 1, now }) {
  const { shards, strikable, scale } = state.fracture;
  let broke = 0;
  for (const s of strikable) {
    if (state.broken[s]) continue;
    const shard = shards[s], d = nearestDistanceMetres(shard, point, scale);
    if (d >= radius) continue;
    const fall = 1 - (d / radius) ** 2;
    state.wear[s] += amount * fall;
    if (state.wear[s] >= 1 && blowOff(state, s, now, { side, power })) broke++;
  }
  return broke;
}

// A section topples from its break like a felled tree, then goes over the side and floats.
function fellMast(state, mastId, stage, side, now, { snap = false } = {}) {
  const fracture = state.fracture, mast = fracture.masts[mastId];
  if (!mast) return 0;
  const list = stage === 'topmast' ? mast.upper : [...mast.lower, ...mast.upper];
  const fresh = list.filter((s) => markBroken(state, s));
  if (!fresh.length) return 0;
  if (snap) {
    for (const s of fresh) writeFrozenGone(state, s);
    return fresh.length;
  }
  const cut = stage === 'topmast' ? mast.topCut : mast.fullCut;
  const [sx, sy, sz] = fracture.scale;
  let top = cut;
  for (const s of fresh) if (fracture.shards[s].max[1] > top) top = fracture.shards[s].max[1];
  const length = (top - cut) * sy, drop = Math.max(0.5, cut * sy);
  const hinge = Math.max(0.5, 0.36 * Math.sqrt(length));
  const fall = Math.sqrt((2 * drop) / GRAVITY);
  const rate = ((2 * Math.PI) / 3) / (0.5 * hinge + fall);
  const clear = fracture.beamMetres * 0.5 + length * 0.06;
  const pivot = [0, cut, (stage === 'topmast' ? mast.topZ : mast.fullZ) + (side > 0 ? 0.01 : -0.01)];
  // It lands flat. A plain sideways topple would leave the yards standing up out of the sea, so one turn
  // about a skew axis carries the mast down to the water and rolls its yards level on the way.
  const roll = shardNoise(fresh[0], 5) >= 0.5 ? 1 : -1, third = 1 / Math.sqrt(3);
  const flight = {
    pivot,
    velocity: [(side * clear) / fall, 0, (shardNoise(fresh[0], 4) - 0.5) * 2],
    spin: [-roll * side * third * rate, -roll * third * rate, -side * third * rate],
    hinge,
    sink: 0.012,
    linger: Math.min(180, 75 + length),
  };
  for (const s of fresh) {
    // Rope has no stiffness to fall with. It goes with the mast as it starts to lean, then is gone, parted.
    const rope = fracture.shards[s].kind === SHARD_KINDS.line;
    writeFlight(state, s, rope ? { ...flight, linger: -0.7 * fall } : flight, now);
  }
  return fresh.length;
}

function writeFrozenGone(state, s) {
  const r = state.records, at = s * FRACTURE_RECORD_FLOATS, shard = state.fracture.shards[s];
  r.set([shard.centroid[0], shard.centroid[1], shard.centroid[2], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], at);
  state.dirty.add(s);
  state.revision++;
}

function dismountGun(state, event, now) {
  const { shards, guns, scale } = state.fracture;
  let best = -1, bestDistance = Infinity;
  for (const s of guns) {
    if (state.broken[s]) continue;
    const c = shards[s].centroid, d = Math.hypot((c[0] - event.x) * scale[0], (c[1] - event.y) * scale[1], (c[2] - event.z) * scale[2]);
    if (d < bestDistance) { bestDistance = d; best = s; }
  }
  if (best < 0 || bestDistance > Math.max(4, scale[2] * 1.2) || !markBroken(state, best)) return 0;
  const side = event.side || 1, slew = shardNoise(best, 6) >= 0.5 ? 1 : -1;
  // Knocked off its trucks and left where it lands. It stays aboard.
  writeFlight(state, best, { pivot: shards[best].centroid, velocity: [-side * 2.2, -0.9, slew * 0.8], spin: [0.6 * slew, 1.8 * slew, side * 0.9], gravity: 0, settle: 0.35, keep: true }, now);
  return 1;
}

const STRIKE_RULES = Object.freeze({
  'internal-deck': { amount: 0.22, radius: 0.65 },
  'back-wall': { amount: 0.45, radius: 0.9 },
  'window-shatter': { amount: 1.2, radius: 1.2 },
});

/**
 * Turn damage events into releases. Events are the `damage.pendingBakes` the gunnery code queues. Pure
 * JavaScript with no graphics device, called only when a ship is hit.
 */
export function applyFractureEvents(fracture, damage, events, now = 0) {
  const state = shipFractureStateOf(damage, fracture);
  if (!state) return 0;
  let released = 0;
  const reach = Math.max(1, Math.min(1.4, fracture.scale[2] / 2));
  for (const event of events) {
    if (!event) continue;
    if (event.kind === 'sail-rip') continue;
    if (event.kind === 'mast-break') {
      released += fellMast(state, event.mastGroup ?? 'main', event.stage ?? 'topmast', event.side || 1, now);
      continue;
    }
    if (event.kind === 'cannon-dismount') { released += dismountGun(state, event, now); continue; }
    const point = [Number(event.x) || 0, Number(event.y) || 0, Number(event.z) || 0];
    if (event.kind === 'magazine-explosion') {
      const powder = Math.max(0.15, Math.min(1, Number(event.powderFraction) || 0.85));
      released += strike(state, point, { radius: (4 + 7 * powder) * reach, amount: 1 + 2 * powder, power: 1.6 + 1.6 * powder, now });
      released += releaseUnsupported(state, now);
      continue;
    }
    if (event.kind === 'hull-crack') {
      // Her back breaks here: the planking across this station goes on both sides, for the whole depth above water.
      const width = 1.6 * reach;
      for (const s of fracture.strikable) {
        const shard = fracture.shards[s];
        if (Math.abs(shard.centroid[2] - point[2]) * fracture.scale[2] < width && blowOff(state, s, now, { power: 0.9 })) released++;
      }
      continue;
    }
    const rule = STRIKE_RULES[event.kind];
    const severity = Math.max(0.25, Number(event.severity) || 0.6);
    const penetrating = (Number(event.stepDepth) || 0) >= 0.22;
    const amount = (rule?.amount ?? (penetrating ? 1.12 : 0.40) * severity) / fracture.toughness;
    const radius = (rule?.radius ?? (penetrating ? 0.98 : 0.76)) * reach;
    released += strike(state, point, { radius, amount, side: event.side ?? (point[0] >= 0 ? 1 : -1), power: 0.65 + severity * 0.5, now });
  }
  released += destroyWreckedParts(state, damage, now);
  if (released) released += releaseUnsupported(state, now);
  return released;
}

// A fitting whose part has taken all it can comes away, rather than vanishing where it stood.
function destroyWreckedParts(state, damage, now) {
  const partDamage = damage?.partDamage;
  if (!partDamage) return 0;
  let released = 0;
  for (const s of state.fracture.strikable) {
    const shard = state.fracture.shards[s];
    if (shard.kind === SHARD_KINDS.whole && !state.broken[s] && (partDamage[shard.partId] ?? 0) >= 0.65 && blowOff(state, s, now, {})) released++;
  }
  return released;
}

/**
 * When a vessel founders and sinks, loose upper-works wooden timbers, hatches, rails, and planking
 * float free and continue to bob on the waves above the wreck.
 */
export function releaseSinkingWreckage(fracture, damage, now = 0) {
  const state = shipFractureStateOf(damage, fracture);
  if (!state || state.sunkWreckageReleased) return 0;
  state.sunkWreckageReleased = true;
  let released = 0;
  const candidates = [];
  for (const s of fracture.strikable) {
    if (state.broken[s]) continue;
    const shard = fracture.shards[s];
    if (!shard || (shard.kind !== SHARD_KINDS.skin && shard.kind !== SHARD_KINDS.whole)) continue;
    if (shard.centroid[1] < 0.05) continue;
    candidates.push(s);
  }
  candidates.sort((a, b) => fracture.shards[b].centroid[1] - fracture.shards[a].centroid[1]);
  const targetCount = Math.min(20, Math.max(8, Math.floor(candidates.length * 0.22)));
  const stride = Math.max(1, Math.floor(candidates.length / Math.max(1, targetCount)));
  for (let i = 0; i < candidates.length && released < targetCount; i += stride) {
    const s = candidates[i];
    const side = fracture.shards[s].centroid[0] >= 0 ? 1 : -1;
    if (blowOff(state, s, now, { side, power: 0.55, up: 0.35 })) released++;
  }
  return released;
}

/**
 * Keep the shards in step with what damage says when no event told us: a reload, a re-raised rig, a
 * remounted gun or a full repair. Runs once there is nothing queued.
 */
export function syncFractureWithDamage(fracture, damage) {
  const state = shipFractureStateOf(damage, fracture);
  if (!state) return false;
  let changed = false;
  const gone = new Set();
  for (const [mastId, mast] of Object.entries(fracture.masts)) {
    const stage = damage.mastState?.[mastId] ?? 0;
    if (stage >= 1) for (const s of mast.upper) gone.add(s);
    if (stage >= 2) for (const s of mast.lower) gone.add(s);
  }
  for (const mast of Object.values(fracture.masts)) {
    for (const s of [...mast.upper, ...mast.lower]) {
      if (gone.has(s) && markBroken(state, s)) { writeFrozenGone(state, s); changed = true; }
      else if (!gone.has(s) && state.broken[s]) { restoreShard(state, s); changed = true; }
    }
  }
  if ((damage.dismountedGuns ?? 0) === 0) {
    for (const s of fracture.guns) if (state.broken[s]) { restoreShard(state, s); changed = true; }
  }
  if (Array.isArray(damage.fractureRestore)) {
    for (const s of damage.fractureRestore) {
      if (fracture.strikable.includes(s) && markBroken(state, s)) { writeFrozenGone(state, s); changed = true; }
    }
    damage.fractureRestore = null;
  }
  return changed;
}

function restoreShard(state, s) {
  if (state.broken[s]) { state.broken[s] = 0; state.brokenCount--; }
  state.wear[s] = 0;
  state.flying.delete(s);
  state.records[s * FRACTURE_RECORD_FLOATS + 15] = INTACT;
  state.dirty.add(s);
  state.revision++;
}

// Flights over are held at their last age, so the clock can stop and restart without moving them.
export function settleFinishedFlights(state, now) {
  if (!state.flying.size) return false;
  let any = false;
  const clock = now - state.epoch;
  for (const s of state.flying) {
    const at = s * FRACTURE_RECORD_FLOATS, r = state.records, age = clock - r[at + 3], settleAt = r[at + 7], hideAt = r[at + 11];
    const finished = hideAt >= 0 ? age >= hideAt : age >= settleAt;
    if (!finished) continue;
    r[at + 15] = hideAt >= 0 ? hideAt : settleAt;
    state.flying.delete(s);
    state.dirty.add(s);
    any = true;
  }
  return any;
}

export function brokenShardList(damage) {
  const state = damage?.fracture;
  if (!state) return [];
  const list = [];
  for (const s of state.fracture.strikable) if (state.broken[s]) list.push(s);
  return list;
}

// ---------------------------------------------------------------------------------------------------
// What the rest of the game asks of the pieces. Design units throughout, and none of it runs until
// something has broken.

// Parts with nothing left of them, so a hit is never credited to one.
export function fracturePartsGone(state) {
  if (state.partsGone?.revision === state.revision) return state.partsGone.ids;
  const { shards, strikable } = state.fracture, gone = new Set(), standing = new Set();
  for (const s of strikable) (state.broken[s] ? gone : standing).add(shards[s].partId);
  for (const id of standing) gone.delete(id);
  state.partsGone = { revision: state.revision, ids: gone };
  return gone;
}

const SIDE_STATIONS = 112, SIDE_DESIGN_SPAN = 14, SIDE_PIECE_MARGIN = 0.05;
const sidePieceTables = new WeakMap();
// The pieces that make up her side, by station. Built once per model.
function sidePiecesByStation(fracture) {
  let table = sidePieceTables.get(fracture);
  if (table) return table;
  table = Array.from({ length: SIDE_STATIONS }, () => []);
  for (const s of fracture.strikable) {
    const shard = fracture.shards[s];
    if (shard.kind !== SHARD_KINDS.skin && !/^(bulwark|rail)/.test(shard.partId)) continue;
    const first = Math.max(0, Math.floor((shard.min[2] / SIDE_DESIGN_SPAN + 0.5) * SIDE_STATIONS));
    const last = Math.min(SIDE_STATIONS - 1, Math.floor((shard.max[2] / SIDE_DESIGN_SPAN + 0.5) * SIDE_STATIONS));
    for (let i = first; i <= last; i++) table[i].push(shard);
  }
  sidePieceTables.set(fracture, table);
  return table;
}

/**
 * Height of what is left of her side above the deck at a station, or null where nothing has gone from it.
 * `deckAt(z)` gives the deck height there. Cached until the next break, since the crew ask constantly.
 */
export function fractureSideTop(state, side, z, deckAt) {
  if (!state?.brokenCount) return null;
  if (state.sideTops?.revision !== state.revision) {
    const stations = sidePiecesByStation(state.fracture), tops = [new Float32Array(SIDE_STATIONS), new Float32Array(SIDE_STATIONS)];
    for (let i = 0; i < SIDE_STATIONS; i++) {
      const deck = deckAt(((i + 0.5) / SIDE_STATIONS - 0.5) * SIDE_DESIGN_SPAN);
      for (let which = 0; which < 2; which++) {
        let gone = false, top = deck;
        for (const shard of stations[i]) {
          if (shard.max[1] <= deck || (which ? shard.max[0] < SIDE_PIECE_MARGIN : shard.min[0] > -SIDE_PIECE_MARGIN)) continue;
          if (state.broken[shard.index]) gone = true;
          else if (shard.max[1] > top) top = shard.max[1];
        }
        tops[which][i] = gone ? top : NaN;
      }
    }
    state.sideTops = { revision: state.revision, tops };
  }
  const i = Math.max(0, Math.min(SIDE_STATIONS - 1, Math.floor((z / SIDE_DESIGN_SPAN + 0.5) * SIDE_STATIONS)));
  const top = state.sideTops.tops[side > 0 ? 1 : 0][i];
  return Number.isNaN(top) ? null : top;
}

// The same rigid motion the GPU applies, for tests and tools. Not used by the renderer.
export function evaluateShardFlight(record, clock, point, scale) {
  const frozen = record[15];
  if (frozen < -1.5) return [...point];
  const t = frozen >= 0 ? frozen : Math.max(0, clock - record[3]);
  const pivot = [record[0], record[1], record[2]], hideAt = record[11];
  if (hideAt >= 0 && t >= hideAt) return pivot;
  const settleAt = record[7], hinge = record[12], gravity = record[13], sink = record[14];
  const spin = [record[8], record[9], record[10]], rate = Math.hypot(...spin);
  const free = Math.max(0, Math.min(t, settleAt) - hinge);
  const held = Math.min(t, hinge);
  const angle = (hinge > 0 ? (0.5 * rate * held * held) / hinge : 0) + rate * free;
  const relative = [(point[0] - pivot[0]) * scale[0], (point[1] - pivot[1]) * scale[1], (point[2] - pivot[2]) * scale[2]];
  let moved = relative;
  if (rate > 1e-6) {
    const axis = spin.map((v) => v / rate), c = Math.cos(angle), s = Math.sin(angle);
    const dot = axis[0] * relative[0] + axis[1] * relative[1] + axis[2] * relative[2];
    const cross = [axis[1] * relative[2] - axis[2] * relative[1], axis[2] * relative[0] - axis[0] * relative[2], axis[0] * relative[1] - axis[1] * relative[0]];
    moved = relative.map((v, i) => v * c + cross[i] * s + axis[i] * dot * (1 - c));
  }
  const disp = [
    record[4] * free,
    record[5] * free - 0.5 * GRAVITY * gravity * free * free - sink * Math.max(0, t - settleAt),
    record[6] * free,
  ];
  return [pivot[0] + (moved[0] + disp[0]) / scale[0], pivot[1] + (moved[1] + disp[1]) / scale[1], pivot[2] + (moved[2] + disp[2]) / scale[2]];
}

const fractureGPUOwners = new WeakMap();

// One per vessel. The compute pass exists only once something has broken, and runs after every other pose stage.
export async function createShipFractureGPU({ device, computePipe, posedBuffer, fracture, shared = null }) {
  let assets = shared;
  if (!assets) {
    const pipeline = await computePipe(SHIP_FRACTURE_POSE_UPDATE, 'ship fracture');
    const vertexShards = device.createBuffer({ label: `${fracture.modelId} vertex shards`, size: fracture.vertexShards.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertexShards, 0, fracture.vertexShards);
    assets = Object.freeze({ device, pipeline, vertexShards, fracture });
    fractureGPUOwners.set(assets, { references: 0 });
  }
  const owner = fractureGPUOwners.get(assets);
  owner.references++;
  const recordBytes = fracture.shardCount * FRACTURE_RECORD_FLOATS * 4;
  const records = device.createBuffer({ label: `${fracture.modelId} shard flights`, size: recordBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const clockBuffer = device.createBuffer({ label: `${fracture.modelId} fracture clock`, size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const clockData = new Float32Array([0, GRAVITY, 0, 0, fracture.scale[0], fracture.scale[1], fracture.scale[2], 0]);
  const intact = new Float32Array(fracture.shardCount * FRACTURE_RECORD_FLOATS);
  for (let s = 0; s < fracture.shardCount; s++) intact[s * FRACTURE_RECORD_FLOATS + 15] = INTACT;
  device.queue.writeBuffer(records, 0, intact);
  device.queue.writeBuffer(clockBuffer, 0, clockData);
  const group = device.createBindGroup({
    layout: assets.pipeline.getBindGroupLayout(0),
    entries: [posedBuffer, assets.vertexShards, records, clockBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const workgroups = Math.ceil(fracture.vertexShards.length / 64);
  let current = null, active = false, destroyed = false, seenRevision = -1;
  const flush = () => {
    if (!current?.dirty.size) return false;
    for (const s of current.dirty) device.queue.writeBuffer(records, s * FRACTURE_RECORD_FLOATS * 4, current.records, s * FRACTURE_RECORD_FLOATS, FRACTURE_RECORD_FLOATS);
    current.dirty.clear();
    return true;
  };
  return {
    assets,
    get active() { return active; },
    apply(damage, events, now) { return applyFractureEvents(fracture, damage, events, now); },
    // Called every frame, but does nothing unless something changed.
    sync(damage, boat = null) {
      if (destroyed) return false;
      const frame = fracture.designFrame;
      if (frame?.beam && frame.length && boat?.beam && boat.length) {
        const sx = boat.beam / frame.beam, sz = boat.length / frame.length;
        if (Math.abs(sx - clockData[4]) > 1e-4 || Math.abs(sz - clockData[6]) > 1e-4) {
          clockData[4] = sx;
          clockData[6] = sz;
          device.queue.writeBuffer(clockBuffer, 0, clockData);
        }
      }
      const next = damage ? shipFractureStateOf(damage, fracture) : null;
      if (next !== current) {
        // A new ship in this hull, or a full repair: everything back on her first.
        device.queue.writeBuffer(records, 0, intact);
        current = next;
        if (current) for (let s = 1; s < fracture.shardCount; s++) if (current.records[s * FRACTURE_RECORD_FLOATS + 15] !== INTACT) current.dirty.add(s);
        seenRevision = -1;
      }
      if (!current) { active = false; return false; }
      if (!damage.pendingBakes?.length && damage.revision !== seenRevision) {
        seenRevision = damage.revision;
        syncFractureWithDamage(fracture, damage);
      }
      const wrote = flush();
      active = current.brokenCount > 0;
      return wrote;
    },
    // The clock runs only while something is in the air, a single small write per frame.
    tick(damage, now, boat = null) {
      if (destroyed) return;
      if (damage?.sunk && current && !current.sunkWreckageReleased) {
        if (releaseSinkingWreckage(fracture, damage, now)) active = true;
      }
      if (!current || damage?.fracture !== current || !current.flying.size) return;
      settleFinishedFlights(current, now);
      clockData[0] = now - current.epoch;
      clockData[2] = boat ? Math.max(0, (boat.target?.heave ?? 0) - (boat.heave ?? 0)) : 0;
      clockData[3] = boat?.roll ?? 0;
      clockData[7] = boat?.pitch ?? 0;
      device.queue.writeBuffer(clockBuffer, 0, clockData, 0, 8);
      flush();
    },
    reset() {
      if (destroyed) return;
      if (current) current = null;
      active = false;
      seenRevision = -1;
      device.queue.writeBuffer(records, 0, intact);
    },
    encode(pass) {
      if (destroyed || !active) return false;
      pass.setPipeline(assets.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(workgroups);
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      records.destroy();
      clockBuffer.destroy();
      owner.references--;
      if (!owner.references) assets.vertexShards.destroy();
    },
  };
}
