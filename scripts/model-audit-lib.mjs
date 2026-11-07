// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Compares the hand-written numbers that describe a model with the triangles actually drawn.
// Everything here works in a ship's own frame, in metres above her design waterline, so a measured
// number can be set straight beside the number the game uses. See scripts/model-audit.mjs.
import { createShipAssetCache } from '../js/ship-mesh.js';
import { SHIP_MODELS } from '../js/ship-models.js';
import { boatHydrodynamics } from '../js/boat.js';
import { SHARD_KINDS } from '../js/ship-fracture.js';

export const SHIP_IDS = Object.freeze(['nina', 'pinta', 'santa-maria', 'victory', 'oseberg', 'lusoria', 'taino-canoe', 'flying-cloud', 'gipsy-moth-iv']);

// What a triangle is, as far as a ball or a boot cares.
export const PART = Object.freeze({ hull: 1, mast: 2, spar: 4, cloth: 8, rope: 16, flag: 32, gun: 64, oar: 128 });
export const PART_NAMES = Object.freeze(Object.fromEntries(Object.entries(PART).map(([name, bit]) => [bit, name])));
export const SOLID = PART.hull | PART.mast | PART.spar | PART.gun;
export const DRAWN = SOLID | PART.cloth | PART.rope | PART.oar;
const CLOTH_MATERIALS = new Set([9, 13]), ROPE_MATERIALS = new Set([2, 12, 19]), FLAG_MATERIALS = new Set([11]);

function classifyPart(groupId, material) {
  if (/^mast\./.test(groupId)) return ROPE_MATERIALS.has(material) ? PART.rope : PART.mast;
  if (/^(rowing\.(propulsor|station)|helm\.steering-oar)/.test(groupId)) return PART.oar;
  if (/^flag\./.test(groupId) || FLAG_MATERIALS.has(material)) return PART.flag;
  if (CLOTH_MATERIALS.has(material)) return PART.cloth;
  if (ROPE_MATERIALS.has(material)) return PART.rope;
  if (/^(yard\.|spar\.|bow\.bowsprit|lookout\.|fitting\.)/.test(groupId)) return PART.spar;
  if (/^gun[.:]|^gunnery\./.test(groupId)) return PART.gun;
  return PART.hull;
}

// A bounding volume tree over triangles, so that a hundred thousand lines can each ask what they meet.
export function createMeshIndex(positions, indices, partOf = null) {
  const triangles = indices.length / 3, order = new Uint32Array(triangles), lo = new Float64Array(triangles * 3), hi = new Float64Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    order[t] = t;
    for (let c = 0; c < 3; c++) {
      const a = positions[indices[t * 3] * 3 + c], b = positions[indices[t * 3 + 1] * 3 + c], d = positions[indices[t * 3 + 2] * 3 + c];
      lo[t * 3 + c] = Math.min(a, b, d);
      hi[t * 3 + c] = Math.max(a, b, d);
    }
  }
  const nodes = [];
  const build = (first, count) => {
    const node = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], first, count, left: null, right: null };
    const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let i = first; i < first + count; i++) {
      const t = order[i] * 3;
      for (let c = 0; c < 3; c++) {
        if (lo[t + c] < node.min[c]) node.min[c] = lo[t + c];
        if (hi[t + c] > node.max[c]) node.max[c] = hi[t + c];
        const mid = (lo[t + c] + hi[t + c]) * 0.5;
        if (mid < cmin[c]) cmin[c] = mid;
        if (mid > cmax[c]) cmax[c] = mid;
      }
    }
    if (count > 6) {
      const size = [cmax[0] - cmin[0], cmax[1] - cmin[1], cmax[2] - cmin[2]];
      const axis = size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
      if (size[axis] > 1e-6) {
        const split = (cmin[axis] + cmax[axis]) * 0.5;
        let i = first, j = first + count - 1;
        while (i <= j) {
          const t = order[i] * 3;
          if ((lo[t + axis] + hi[t + axis]) * 0.5 < split) i++;
          else { const swap = order[i]; order[i] = order[j]; order[j] = swap; j--; }
        }
        const leftCount = i - first;
        if (leftCount > 0 && leftCount < count) {
          node.left = build(first, leftCount);
          node.right = build(i, count - leftCount);
          node.count = 0;
        }
      }
    }
    nodes.push(node);
    return node;
  };
  const root = build(0, triangles);

  function boxEntry(node, o, inv, limit) {
    let near = 0, far = limit;
    for (let c = 0; c < 3; c++) {
      const a = (node.min[c] - o[c]) * inv[c], b = (node.max[c] - o[c]) * inv[c];
      const low = Math.min(a, b), high = Math.max(a, b);
      if (low > near) near = low;
      if (high < far) far = high;
      if (near > far) return Infinity;
    }
    return near;
  }
  function triangleHit(t, o, d) {
    const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const e1x = positions[ib] - ax, e1y = positions[ib + 1] - ay, e1z = positions[ib + 2] - az;
    const e2x = positions[ic] - ax, e2y = positions[ic + 1] - ay, e2z = positions[ic + 2] - az;
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return Infinity;
    const inv = 1 / det, sx = o[0] - ax, sy = o[1] - ay, sz = o[2] - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return Infinity;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) return Infinity;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }
  // The first triangle of these kinds on a line, at least `from` along it. d need not be unit length.
  function first(o, d, limit = Infinity, mask = 0xff, from = 0, skip = null) {
    const inv = [1 / (d[0] || 1e-30), 1 / (d[1] || 1e-30), 1 / (d[2] || 1e-30)];
    let best = limit, struck = -1;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (boxEntry(node, o, inv, best) === Infinity) continue;
      if (node.left) { stack.push(node.left, node.right); continue; }
      for (let i = node.first; i < node.first + node.count; i++) {
        const t = order[i];
        if (partOf && !(partOf[t] & mask)) continue;
        if (skip && skip(t)) continue;
        const at = triangleHit(t, o, d);
        if (at >= from && at < best) { best = at; struck = t; }
      }
    }
    return struck < 0 ? null : { t: best, triangle: struck };
  }
  function pointToTriangle(p, t) {
    const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
    const a = [positions[ia], positions[ia + 1], positions[ia + 2]], b = [positions[ib], positions[ib + 1], positions[ib + 2]], c = [positions[ic], positions[ic + 1], positions[ic + 2]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    let q;
    if (d1 <= 0 && d2 <= 0) q = a;
    else {
      const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]], d3 = dot(ab, bp), d4 = dot(ac, bp);
      if (d3 >= 0 && d4 <= d3) q = b;
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); q = [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; }
        else {
          const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], d5 = dot(ab, cp), d6 = dot(ac, cp);
          if (d6 >= 0 && d5 <= d6) q = c;
          else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); q = [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
            else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); q = [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
              else { const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom; q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]; }
            }
          }
        }
      }
    }
    return { distance: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), point: q };
  }
  // The nearest surface of these kinds to a point.
  function nearest(p, mask = 0xff, limit = Infinity, skip = null) {
    let best = limit, struck = -1, point = null;
    const boxDistance = (node) => {
      let sum = 0;
      for (let c = 0; c < 3; c++) {
        const away = p[c] < node.min[c] ? node.min[c] - p[c] : p[c] > node.max[c] ? p[c] - node.max[c] : 0;
        sum += away * away;
      }
      return Math.sqrt(sum);
    };
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (boxDistance(node) >= best) continue;
      if (node.left) {
        const a = boxDistance(node.left), b = boxDistance(node.right);
        if (a < b) stack.push(node.right, node.left); else stack.push(node.left, node.right);
        continue;
      }
      for (let i = node.first; i < node.first + node.count; i++) {
        const t = order[i];
        if (partOf && !(partOf[t] & mask)) continue;
        if (skip && skip(t)) continue;
        const near = pointToTriangle(p, t);
        if (near.distance < best) { best = near.distance; struck = t; point = near.point; }
      }
    }
    return struck < 0 ? null : { distance: best, triangle: struck, point };
  }
  return { first, nearest, min: root.min, max: root.max, triangles };
}

// The smallest named group holding each triangle. Groups may nest.
function leafGroups(groups, triangles) {
  const ranked = groups.map((g, index) => ({ index, first: Math.floor(g.firstVertex / 3), count: Math.floor(g.vertexCount / 3) }))
    .filter((r) => r.count > 0).sort((a, b) => b.count - a.count || a.index - b.index);
  const leaf = new Int32Array(triangles).fill(-1);
  for (const r of ranked) leaf.fill(r.index, r.first, Math.min(triangles, r.first + r.count));
  return leaf;
}

const assets = createShipAssetCache();
const meshCache = new Map();

// A ship's mesh in her own metres. `live` is what the running game drew: its own vertices, indices and groups, and
// the GPU's posed design-frame buffer, 8 floats a vertex, where the rig stands as drawn. Node and the browser round
// floats differently, so their meshes can differ by a few vertices: never mix one's indices with the other's buffer.
export function loadShip(id, live = null) {
  const key = id + (live ? '/posed' : '/rest');
  if (meshCache.has(key)) return meshCache.get(key);
  const built = assets.get(id), asset = live ? { ...built, vertices: live.vertices, indices: live.indices, groups: live.groups } : built;
  const model = asset.model, frame = model.designFrame, runtime = model.runtime;
  const scale = [runtime.beam / frame.beam, frame.verticalScale, runtime.length / frame.length];
  const count = asset.vertices.length / 9, positions = new Float64Array(count * 3), materials = new Uint8Array(count);
  for (let v = 0; v < count; v++) {
    const source = live ? v * 8 : v * 9, data = live ? live.posed : asset.vertices;
    for (let c = 0; c < 3; c++) positions[v * 3 + c] = data[source + c] * scale[c];
    materials[v] = Math.floor(asset.vertices[v * 9 + 6]);
  }
  const triangles = asset.indices.length / 3, leaf = leafGroups(asset.groups, triangles), partOf = new Uint8Array(triangles);
  const groupId = (t) => (leaf[t] >= 0 ? String(asset.groups[leaf[t]].id) : '(ungrouped)');
  for (let t = 0; t < triangles; t++) partOf[t] = classifyPart(groupId(t), materials[asset.indices[t * 3]]);
  // Some standing lines are drawn in fitting material, so they count as hull above. The fracture table knows a bare
  // tube for a rope, and a ball goes through rope: the shot's reckoning leaves them out.
  const { vertexShards, shardKinds } = live ?? { vertexShards: built.fracture.vertexShards, shardKinds: built.fracture.shards.map((s) => s?.kind ?? 0) };
  const isLine = (t) => partOf[t] === PART.hull && shardKinds[vertexShards[asset.indices[t * 3]]] === SHARD_KINDS.line;
  const hydro = boatHydrodynamics(runtime.length, runtime.beam, undefined, 0, id);
  const ship = {
    id, model, asset, scale, positions, materials, partOf, leaf, groupId, isLine, hydro, posed: !!live,
    index: createMeshIndex(positions, asset.indices, partOf),
    boat: (extra = {}) => ({ modelId: id, model, length: runtime.length, beam: runtime.beam, x: 0, z: 0, heading: 0, pitch: 0, roll: 0, heave: -hydro.sinkage, hydrodynamics: hydro, showProw: true, ...extra }),
  };
  meshCache.set(key, ship);
  return ship;
}

export const round = (value, digits = 2) => (Number.isFinite(value) ? +value.toFixed(digits) : value === Infinity ? null : value);
export function percentile(values, share) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
}
export function tally(map, key, by = 1) { map[key] = (map[key] ?? 0) + by; }
export const topOf = (map, n = 4) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ');
export { SHIP_MODELS };

// --- Lines fired at a thing from every side ---------------------------------------------------------------------

const unit = (v) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const pointOn = (o, d, t) => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];

// Parallel lines across a thing's silhouette from one bearing and elevation, cut off where they would be under water.
export function* linesAcross(min, max, { bearings = 24, elevations = [0, -6, 10], columns = 48, rows = 32, margin = 1.5, seaLevel = 0 } = {}) {
  const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const reach = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 + 20;
  for (let b = 0; b < bearings; b++) for (const elevation of elevations) {
    const bearing = (b / bearings) * Math.PI * 2, e = (elevation * Math.PI) / 180;
    const d = [-Math.sin(bearing) * Math.cos(e), Math.sin(e), -Math.cos(bearing) * Math.cos(e)];
    const across = [Math.cos(bearing), 0, -Math.sin(bearing)], up = unit([across[1] * d[2] - across[2] * d[1], across[2] * d[0] - across[0] * d[2], across[0] * d[1] - across[1] * d[0]]);
    const upward = up[1] < 0 ? up.map((x) => -x) : up;
    let uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
      const r = [x - centre[0], y - centre[1], z - centre[2]];
      const u = r[0] * across[0] + r[2] * across[2], v = r[0] * upward[0] + r[1] * upward[1] + r[2] * upward[2];
      uLo = Math.min(uLo, u); uHi = Math.max(uHi, u); vLo = Math.min(vLo, v); vHi = Math.max(vHi, v);
    }
    for (let i = 0; i < columns; i++) for (let j = 0; j < rows; j++) {
      const u = uLo - margin + (uHi - uLo + 2 * margin) * ((i + 0.5) / columns), v = vLo - margin + (vHi - vLo + 2 * margin) * ((j + 0.5) / rows);
      const mid = [centre[0] + across[0] * u + upward[0] * v, centre[1] + across[1] * u + upward[1] * v, centre[2] + across[2] * u + upward[2] * v];
      let from = pointOn(mid, d, -reach), length = reach * 2;
      if (seaLevel !== null) {
        // Above the sea only: a ball that reaches the water splashes there, whatever is beneath.
        if (Math.abs(d[1]) < 1e-9) { if (from[1] < seaLevel) continue; }
        else {
          const at = (seaLevel - from[1]) / d[1];
          if (d[1] < 0) length = Math.min(length, at);
          else if (at > 0) { from = pointOn(from, d, at); length -= at; }
          if (length <= 0) continue;
        }
      }
      yield { from, d, length, bearing: b, elevation };
    }
  }
}

// Walk a line through the sweep in the steps a real ball takes, as the game does.
export function marchSweep(line, sweepStep, stepMetres = 3.4) {
  const steps = Math.max(1, Math.ceil(line.length / stepMetres)), size = line.length / steps;
  for (let i = 0; i < steps; i++) {
    const a = pointOn(line.from, line.d, i * size), b = pointOn(line.from, line.d, (i + 1) * size);
    const hit = sweepStep(a, b);
    if (hit) return { distance: (i + hit.fraction) * size, hit };
  }
  return null;
}

// --- Check 1: collision against mesh ------------------------------------------------------------------------------

export const SHOT_TOLERANCE_M = 0.5, AIR_GAP_M = 1;

// Where a mast really stands, from its own triangles: its axis near the deck, and how far up it goes.
export function measuredMasts(ship) {
  const names = [...new Set(ship.asset.groups.map((g) => String(g.id).match(/^mast\.(?:trunk\.)?([a-z]+)/)?.[1]).filter(Boolean))].filter((n) => ['fore', 'main', 'mizzen'].includes(n));
  const out = [];
  const { asset, positions } = ship;
  for (const name of names) {
    let foot = Infinity, top = -Infinity;
    const vertices = [];
    for (const g of asset.groups) {
      const id = String(g.id);
      if (!new RegExp(`^mast\\.(trunk\\.)?${name}\\b`).test(id)) continue;
      for (let i = g.firstVertex; i < g.firstVertex + g.vertexCount; i++) {
        if (asset.vertices[asset.indices[i] * 9 + 6] === undefined) continue;
        const material = Math.floor(asset.vertices[asset.indices[i] * 9 + 6]);
        if (ROPE_MATERIALS.has(material)) continue;
        const v = asset.indices[i] * 3, y = positions[v + 1];
        vertices.push(positions[v], y, positions[v + 2]);
        if (y < foot) foot = y;
        if (y > top) top = y;
      }
    }
    if (!vertices.length) continue;
    // The lowest fifth of the mast is the trunk with nothing hung on it.
    const low = foot + (top - foot) * 0.2, xs = [], zs = [];
    for (let i = 0; i < vertices.length; i += 3) if (vertices[i + 1] <= low) { xs.push(vertices[i]); zs.push(vertices[i + 2]); }
    out.push({ name, x: percentile(xs, 0.5), z: percentile(zs, 0.5), foot, top });
  }
  return out;
}

// Fires the fan at a ship through the game's own sweep and asks the mesh what each line should have met.
export function auditShipCollision(ship, sweepShipSegment, createVesselDamageState, fan = {}) {
  // Her rig stands as the game set it. At rest her hatch is shut, as the rest mesh has it.
  const { index, partOf, groupId, isLine } = ship, boat = ship.boat(ship.posed ? fan.pose : { hatchesClosed: 1 });
  // As the fleet holds her: createShipGunnery gives every vessel a damage state before the first shot.
  if (fan.fresh !== true) createVesselDamageState(boat);
  const heave = boat.heave, radius = fan.radius ?? 0.07;
  const seaLevel = -heave; // In her frame the sea stands where her heave puts it.
  const masts = measuredMasts(ship), mastNames = new Set(masts.map((m) => m.name));
  const row = {
    lines: 0, struck: 0, agree: 0, softStop: 0, softThrough: 0,
    airHull: 0, airRig: 0, airGaps: [], throughHull: 0, throughMast: 0, throughSpar: 0, throughGun: 0, lateHull: 0, lateMast: 0,
    groupsMissed: {}, offset: [], wrongMast: 0, phantomMast: 0, rigHits: 0, phantomNames: {}, worstAir: null, worstThrough: null,
  };
  const worldToSweep = (p) => [p[0], p[1] + heave, p[2]];
  const step = (a, b) => sweepShipSegment(worldToSweep(a), worldToSweep(b), radius, boat, null, null);
  for (const line of linesAcross(index.min, index.max, { ...fan, seaLevel })) {
    row.lines++;
    const shot = marchSweep(line, step, fan.stepMetres ?? 3.4);
    const solid = index.first(line.from, line.d, line.length, SOLID, 0, isLine);
    const any = index.first(line.from, line.d, line.length, DRAWN);
    if (!shot && !solid) { if (any) row.softThrough++; continue; }
    row.struck++;
    const bucket = solid ? PART_NAMES[partOf[solid.triangle]] : null;
    if (!shot) {
      row[`through${bucket[0].toUpperCase()}${bucket.slice(1)}`]++;
      tally(row.groupsMissed, groupId(solid.triangle).replace(/\d+/g, '#'));
      const at = pointOn(line.from, line.d, solid.t);
      if (!row.worstThrough || bucket === 'mast') row.worstThrough = { at: at.map((x) => round(x, 1)), part: groupId(solid.triangle) };
      continue;
    }
    if (solid && solid.t < shot.distance - SHOT_TOLERANCE_M) {
      if (bucket === 'mast' || bucket === 'spar') row.lateMast++; else row.lateHull++;
      tally(row.groupsMissed, groupId(solid.triangle).replace(/\d+/g, '#'));
      continue;
    }
    const at = pointOn(line.from, line.d, shot.distance);
    const near = index.nearest(at, DRAWN, 12);
    const gap = near ? near.distance : 12;
    if (shot.hit.hitZone === 'rigging') {
      row.rigHits++;
      if (!mastNames.has(shot.hit.mastGroup)) { row.phantomMast++; tally(row.phantomNames, shot.hit.mastGroup); }
      else if (masts.length) {
        // A mast is the nearest one, and a yard the one it hangs on, however far along her its tip reaches.
        const nearest = masts.reduce((a, m) => (Math.abs(m.z - at[2]) < Math.abs(a.z - at[2]) ? m : a)), part = index.nearest(at, PART.mast | PART.spar, 2);
        const named = part && partOf[part.triangle] === PART.spar ? groupId(part.triangle).match(/\b(fore|main|mizzen)\b/)?.[1] ?? null : nearest.name;
        if (named && named !== shot.hit.mastGroup) row.wrongMast++;
      }
    }
    if (gap > AIR_GAP_M) {
      if (shot.hit.hitZone === 'rigging') row.airRig++; else row.airHull++;
      row.airGaps.push(gap);
      if (!row.worstAir || gap > row.worstAir.gap) row.worstAir = { gap: round(gap, 1), at: at.map((x) => round(x, 1)), zone: shot.hit.hitZone };
      continue;
    }
    // The ball has a radius, so it can stop on a mast its centre line would pass.
    const standing = !solid || solid.t > shot.distance + SHOT_TOLERANCE_M ? index.nearest(at, SOLID, SHOT_TOLERANCE_M, isLine) : null;
    if (standing || (solid && Math.abs(solid.t - shot.distance) <= SHOT_TOLERANCE_M)) { row.agree++; if (solid) row.offset.push(Math.abs(solid.t - shot.distance)); }
    else row.softStop++;
  }
  const share = (n) => round((100 * n) / Math.max(1, row.struck), 1);
  return {
    id: ship.id, posed: ship.posed, lines: row.lines, struck: row.struck,
    agreePct: share(row.agree), softStopPct: share(row.softStop),
    airHullPct: share(row.airHull), airRigPct: share(row.airRig),
    throughHullPct: share(row.throughHull + row.lateHull), throughMastPct: share(row.throughMast + row.lateMast + row.throughSpar),
    throughGunPct: share(row.throughGun), airGapMedianM: round(percentile(row.airGaps, 0.5)), airGapMaxM: round(row.airGaps.length ? Math.max(...row.airGaps) : 0),
    missedGroups: topOf(row.groupsMissed, 5),
    rigHits: row.rigHits, phantomMastPct: round((100 * row.phantomMast) / Math.max(1, row.rigHits), 1), phantomNames: Object.keys(row.phantomNames).join(','),
    wrongMastPct: round((100 * row.wrongMast) / Math.max(1, row.rigHits), 1), worstAir: row.worstAir, worstThrough: row.worstThrough,
  };
}

// Fires the fan at one building, through the game's own sweep, in the states a real port holds it in.
export function auditBuildingCollision(prefabId, lib, fan = {}) {
  const { getBuildingParts, createPortFractures, prepareBuildingFracture, buildingFractureStateOf, classifyBuildingMaterial, createBuildingDamageState, sweepBuildingSegment } = lib;
  const parts = getBuildingParts(prefabId), dims = parts.dimensions, ox = 40, oz = -30, ground = 2;
  const scene = (yaw) => {
    const cos = Math.cos(yaw), sin = Math.sin(yaw), vertices = new Float32Array(parts.vertices), count = vertices.length / 8, positions = new Float64Array(count * 3);
    for (let v = 0; v < count; v++) {
      const px = parts.vertices[v * 8], py = parts.vertices[v * 8 + 1], pz = parts.vertices[v * 8 + 2];
      vertices[v * 8] = ox + px * cos + pz * sin;
      vertices[v * 8 + 1] = py + ground;
      vertices[v * 8 + 2] = oz - px * sin + pz * cos;
      positions[v * 3] = vertices[v * 8]; positions[v * 3 + 1] = vertices[v * 8 + 1]; positions[v * 3 + 2] = vertices[v * 8 + 2];
    }
    return { vertices, index: createMeshIndex(positions, parts.indices), yaw };
  };
  const newInstance = (yaw) => ({ prefabId, x: ox, z: oz, y: ground, baseY: ground, yaw, ...dims });
  const fire = (port, index) => {
    const row = { struck: 0, agree: 0, air: 0, through: 0, late: 0, early: 0, maxOffset: 0, maxAir: 0 };
    // Only what stands above the ground can be shot at.
    for (const line of linesAcross(index.min, index.max, { seaLevel: ground + 0.02, bearings: 8, elevations: [0, -8], columns: 18, rows: 12, ...fan })) {
      const hit = sweepBuildingSegment(line.from, pointOn(line.from, line.d, line.length), 0.07, port);
      const solid = index.first(line.from, line.d, line.length);
      if (!hit && !solid) continue;
      row.struck++;
      if (!hit) { row.through++; continue; }
      const at = hit.fraction * line.length;
      const gap = index.nearest(pointOn(line.from, line.d, at), 0xff, 30)?.distance ?? 30;
      row.maxAir = Math.max(row.maxAir, gap);
      if (solid && solid.t < at - SHOT_TOLERANCE_M) { row.late++; row.maxOffset = Math.max(row.maxOffset, at - solid.t); continue; }
      if (gap > AIR_GAP_M) { row.air++; continue; }
      if (solid && Math.abs(solid.t - at) > SHOT_TOLERANCE_M) { row.early++; row.maxOffset = Math.max(row.maxOffset, Math.abs(solid.t - at)); continue; }
      row.agree++;
    }
    return row;
  };
  const turned = scene(0.7), square = scene(0);
  // As a mesh: what any port hands the shot before its building is first hit.
  const meshed = newInstance(turned.yaw), meshPort = { center: { x: ox, z: oz }, instances: [meshed] };
  createBuildingDamageState(meshed);
  createPortFractures({ device: null, port: meshPort, geometry: { vertices: turned.vertices, indices: parts.indices, partAssembly: parts.partAssembly }, portIndices: null, groundAt: () => ground });
  const mesh = fire(meshPort, turned.index);
  // As pieces: once it has been hit and cut up, though nothing has left it yet.
  const cut = ({ vertices, index, yaw }) => {
    const instance = newInstance(yaw), port = { center: { x: ox, z: oz }, instances: [instance] };
    createBuildingDamageState(instance);
    const prepared = prepareBuildingFracture({ vertices, indices: parts.indices, catalog: parts.partAssembly, instanceIndex: 0, instance, materialClass: classifyBuildingMaterial(prefabId), groundAt: () => ground });
    buildingFractureStateOf(instance.damageState, prepared.fracture);
    return { row: fire(port, index), reach: prepared.fracture.reach };
  };
  const piecesSquare = cut(square), piecesTurned = cut(turned);
  const half = (reach) => Math.max(-reach.min[0], reach.max[0], -reach.min[2], reach.max[2]);
  const meshHalf = Math.max(square.index.max[0] - ox, ox - square.index.min[0], square.index.max[2] - oz, oz - square.index.min[2]);
  return {
    id: prefabId, triangles: turned.index.triangles, nominal: [dims.width, dims.height, dims.length].map((v) => round(v, 1)).join('×'),
    drawnTopM: round(square.index.max[1] - ground, 1), meshHalfM: round(meshHalf, 1), reachSquareM: round(half(piecesSquare.reach), 1), reachTurnedM: round(half(piecesTurned.reach), 1),
    mesh, piecesSquare: piecesSquare.row, piecesTurned: piecesTurned.row,
  };
}

// Every port and year: are its buildings known to the shot by their meshes, and is each mesh really that building?
export function auditPortMeshes(pack, lib) {
  const { createPortFractures, buildingReach, traceShotAtBuilding } = lib, port = pack.port, geometry = pack.portGeometry;
  const instances = port?.instances ?? [];
  createPortFractures({ device: null, port, geometry, portIndices: null, groundAt: () => 0 });
  let noted = 0, misplaced = 0;
  for (const inst of instances) {
    const reach = buildingReach(inst);
    if (!reach) continue;
    noted++;
    // Its mesh, seen from its own frame, must surround its own origin or come within its footprint.
    const away = Math.max(reach.min[0], -reach.max[0], reach.min[2], -reach.max[2]);
    if (away > Math.max(inst.width ?? 10, inst.length ?? 10)) misplaced++;
  }
  return { instances: instances.length, noted, misplaced, prefabs: [...new Set(instances.map((i) => i.prefabId))] };
}

// --- Trees and palms --------------------------------------------------------------------------------------------

// A ball goes through wood thinner than itself, as it does through a frond. This is that thickness, in a tree at scale one.
export const WOOD_STOPS_BALL_M = 0.06;
// One forest prototype drawn as the forest vertex shader draws it. Wood a ball cannot go through is hard; a twig or a frond
// is a soft thing. How thick each triangle's wood is comes from the mesh: the distance across its tube to the far wall.
export function forestPrototypeIndex(manifest, vertices, indices, prototypeId, { scale = 1, yaw = 0, origin = [0, 0, 0] } = {}) {
  const p = manifest.prototypes[prototypeId], stride = 14, c = Math.cos(yaw), s = Math.sin(yaw);
  const ranges = [[p.wood, PART.rope], [p.leaf, PART.cloth]], triangles = (p.wood.indexCount + p.leaf.indexCount) / 3;
  const positions = new Float64Array(triangles * 9), order = new Uint32Array(triangles * 3), partOf = new Uint8Array(triangles);
  let t = 0;
  for (const [range, part] of ranges) for (let i = range.firstIndex; i < range.firstIndex + range.indexCount; i += 3) {
    for (let k = 0; k < 3; k++) {
      const at = indices[i + k] * stride;
      let x = vertices[at], y = vertices[at + 1], z = vertices[at + 2];
      const r2 = x * x + z * z;
      if (part === PART.rope && ((y < 0.025 && r2 > 0.7) || (y < -0.01 && r2 > 0.22))) {
        x = 0; y = 0; z = 0;
      }
      positions[t * 9 + k * 3] = origin[0] + (c * x - s * z) * scale;
      // Roots below the soil line press flat onto it.
      positions[t * 9 + k * 3 + 1] = Math.max(origin[1], origin[1] + y * scale);
      positions[t * 9 + k * 3 + 2] = origin[2] + (s * x + c * z) * scale;
      order[t * 3 + k] = t * 3 + k;
    }
    partOf[t++] = part;
  }
  const woodTriangles = p.wood.indexCount / 3, wood = createMeshIndex(positions, order.subarray(0, woodTriangles * 3)), across = new Float32Array(woodTriangles);
  let collar = 0;
  for (let w = 0; w < woodTriangles; w++) {
    let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 3; k++) {
      const at = indices[p.wood.firstIndex + w * 3 + k] * stride;
      cx += positions[w * 9 + k * 3] / 3; cy += positions[w * 9 + k * 3 + 1] / 3; cz += positions[w * 9 + k * 3 + 2] / 3;
      nx += c * vertices[at + 3] - s * vertices[at + 5]; ny += vertices[at + 4]; nz += s * vertices[at + 3] + c * vertices[at + 5];
    }
    const n = Math.hypot(nx, ny, nz) || 1, hit = wood.first([cx, cy, cz], [-nx / n, -ny / n, -nz / n], 8 * scale, 0xff, 1e-3, (other) => other === w);
    // A tube's far wall faces away from here. Behind a flat strip of bark there is only whatever comes next.
    let farWall = false;
    if (hit) {
      let fx = 0, fy = 0, fz = 0;
      for (let k = 0; k < 3; k++) {
        const at = indices[p.wood.firstIndex + hit.triangle * 3 + k] * stride;
        fx += c * vertices[at + 3] - s * vertices[at + 5]; fy += vertices[at + 4]; fz += s * vertices[at + 3] + c * vertices[at + 5];
      }
      farWall = -(fx * nx + fy * ny + fz * nz) / (n * (Math.hypot(fx, fy, fz) || 1)) >= 0.25;
    }
    across[w] = farWall ? hit.t / 2 / scale : 0;
    if (Math.hypot(cx - origin[0], cz - origin[2]) < 2 * scale && cy < origin[1] + 0.5 * scale && across[w] > collar) collar = across[w];
  }
  // A slender tree is still a tree: its own stem counts as trunk, however thin. Its other wood is as thin as any twig.
  const isStem = (w) => across[w] >= collar * 0.4 && Math.hypot(positions[w * 9] - origin[0], positions[w * 9 + 2] - origin[2]) <= 0.45 * scale;
  const trunkMin = [Infinity, Infinity, Infinity], trunkMax = [-Infinity, -Infinity, -Infinity];
  for (let w = 0; w < woodTriangles; w++) {
    if (across[w] < WOOD_STOPS_BALL_M && !isStem(w)) continue;
    partOf[w] = PART.hull;
    for (let k = 0; k < 3; k++) {
      const x = positions[w * 9 + k * 3], y = positions[w * 9 + k * 3 + 1], z = positions[w * 9 + k * 3 + 2];
      if (Math.hypot(x - origin[0], z - origin[2]) > 2.5 * scale) continue;
      trunkMin[0] = Math.min(trunkMin[0], x); trunkMin[1] = Math.min(trunkMin[1], y); trunkMin[2] = Math.min(trunkMin[2], z);
      trunkMax[0] = Math.max(trunkMax[0], x); trunkMax[1] = Math.max(trunkMax[1], y); trunkMax[2] = Math.max(trunkMax[2], z);
    }
  }
  return { index: createMeshIndex(positions, order, partOf), species: p.species, spec: p, trunk: { min: trunkMin, max: trunkMax } };
}

// Lines through one standing tree, through the game's own scenery sweep.
export function auditTreeCollision({ index, trunk }, terrain, sweepScenerySegment, fan = {}) {
  const row = { struck: 0, agree: 0, air: 0, through: 0, late: 0, softStop: 0, softThrough: 0, airGaps: [], woodLines: 0, woodStopped: 0, allWoodLines: 0, allWoodStopped: 0 };
  const step = (a, b) => sweepScenerySegment(a, b, 0.07, terrain, null);
  for (const line of linesAcross(index.min, index.max, { seaLevel: null, bearings: 12, elevations: [0, -6], columns: 28, rows: 40, margin: 1, ...fan })) {
    const shot = marchSweep(line, step);
    const wood = index.first(line.from, line.d, line.length, PART.hull);
    const anyWood = index.first(line.from, line.d, line.length, PART.hull | PART.rope);
    const any = index.first(line.from, line.d, line.length);
    if (wood) row.woodLines++;
    if (anyWood) row.allWoodLines++;
    if (!shot && !any) continue;
    if (!shot && !wood) { row.softThrough++; continue; }
    row.struck++;
    if (!shot) { row.through++; continue; }
    if (wood) row.woodStopped++;
    if (anyWood) row.allWoodStopped++;
    if (wood && wood.t < shot.distance - SHOT_TOLERANCE_M) { row.late++; continue; }
    const gap = index.nearest(pointOn(line.from, line.d, shot.distance), 0xff, 30)?.distance ?? 30;
    if (gap > AIR_GAP_M) { row.air++; row.airGaps.push(gap); continue; }
    if (wood && Math.abs(wood.t - shot.distance) <= SHOT_TOLERANCE_M) row.agree++; else row.softStop++;
  }
  // Then lines fired only at the trunk, close together: most of a tree's silhouette is air and twigs.
  let trunkLines = 0, trunkStopped = 0, trunkAgree = 0;
  if (Number.isFinite(trunk?.min[0])) for (const line of linesAcross(trunk.min, trunk.max, { seaLevel: null, bearings: 12, elevations: [0, -6], columns: 24, rows: 32, margin: 0.1, ...fan })) {
    const wood = index.first(line.from, line.d, line.length, PART.hull);
    if (!wood) continue;
    trunkLines++;
    const shot = marchSweep(line, step);
    if (!shot) continue;
    trunkStopped++;
    if (Math.abs(wood.t - shot.distance) <= SHOT_TOLERANCE_M) trunkAgree++;
  }
  const share = (n) => round((100 * n) / Math.max(1, row.struck), 1);
  return { trunkLines, trunkStoppedPct: round((100 * trunkStopped) / Math.max(1, trunkLines), 1), trunkAgreePct: round((100 * trunkAgree) / Math.max(1, trunkLines), 1), struck: row.struck, agreePct: share(row.agree), softStopPct: share(row.softStop), airPct: share(row.air), throughPct: share(row.through + row.late), airGapMedianM: round(percentile(row.airGaps, 0.5)), woodLines: row.woodLines, woodStoppedPct: round((100 * row.woodStopped) / Math.max(1, row.woodLines), 1), allWoodStoppedPct: round((100 * row.allWoodStopped) / Math.max(1, row.allWoodLines), 1), topM: round(index.max[1]), reachM: round(Math.max(-index.min[0], index.max[0], -index.min[2], index.max[2])) };
}

// --- Check 2: stations against the model --------------------------------------------------------------------------

const down = [0, -1, 0], upward = [0, 1, 0];
// What stands under a point, if anything: the first solid surface below `from`.
export function floorUnder(ship, x, y, z, mask = PART.hull | PART.gun) {
  const hit = ship.index.first([x, y, z], down, 40, mask);
  return hit ? { y: y - hit.t, triangle: hit.triangle } : null;
}
// What a boot stands on. A boot is 10 cm across, and a deck is planks with 9 mm seams between them: one line down
// through a seam, or along the edge between two triangles, found the deck below and called a sailor afloat. Of a
// boot's width either way, the surface nearest his feet.
const BOOT_REACH = 0.05;
export function floorBeneath(ship, x, y, z, feet, mask = PART.hull | PART.gun) {
  let best = null;
  for (const [dx, dz] of [[0, 0], [BOOT_REACH, 0], [-BOOT_REACH, 0], [0, BOOT_REACH], [0, -BOOT_REACH]]) {
    const floor = floorUnder(ship, x + dx, y, z + dz, mask);
    if (floor && (!best || Math.abs(feet - floor.y) < Math.abs(feet - best.y))) best = floor;
  }
  return best;
}

export function auditMasts(ship, lib) {
  const { shipMastSpecs, modelDeck, vesselRailHeight } = lib, boat = ship.boat(), sy = ship.scale[1], sz = ship.scale[2];
  const specs = shipMastSpecs(ship.id), measured = measuredMasts(ship), rows = [];
  let rigTop = -Infinity;
  for (let t = 0; t < ship.partOf.length; t++) {
    if (!(ship.partOf[t] & (PART.mast | PART.spar | PART.cloth))) continue;
    for (let k = 0; k < 3; k++) rigTop = Math.max(rigTop, ship.positions[ship.asset.indices[t * 3 + k] * 3 + 1]);
  }
  for (const spec of specs) {
    const m = measured.find((q) => q.name === spec[0]);
    const deck = modelDeck(boat, spec[1]) * sy;
    rows.push({
      mast: spec[0], tableZ: round(spec[1] * sz), meshZ: m ? round(m.z) : null, offZ: m ? round(Math.abs(spec[1] * sz - m.z)) : null, offX: m ? round(Math.abs(m.x)) : null,
      deck: round(deck), foot: m ? round(m.foot) : null, top: m ? round(m.top) : null, topBreak: round(spec[2] * sy), fullBreak: round(spec[3] * sy),
      footAboveDeck: m ? round(m.foot - deck) : null, fullBreakAboveDeck: round(spec[3] * sy - deck), topBreakBelowTop: m ? round(m.top - spec[2] * sy) : null,
    });
  }
  // Names the mesh has that the table does not, and the other way about.
  const unlisted = measured.filter((m) => !specs.some((s) => s[0] === m.name)).map((m) => m.name), missing = specs.filter((s) => !measured.some((m) => m.name === s[0])).map((s) => s[0]);
  const railAmidships = vesselRailHeight(boat, 0) - ship.hydro.sinkage;
  return { rows, unlisted, missing, rigTopMeshM: round(rigTop), railAmidshipsM: round(railAmidships), ...auditMastStrikes(ship, lib, railAmidships) };
}

// From her rail to her rig's top, a ball fired at whatever mast or spar stands first on the line must stop there.
function auditMastStrikes(ship, lib, rail, stepMetres = 0.5, stationMetres = 0.1) {
  const boat = ship.boat({ hatchesClosed: 1 }), { index, partOf } = ship, reach = (index.max[0] - index.min[0]) / 2 + 20;
  if (!lib.sweepShipSegment) return {};
  lib.createVesselDamageState(boat);
  let lowest = Infinity, highest = -Infinity, gap = 0, worstGap = 0, seen = false;
  for (let y = rail + stepMetres; y < index.max[1]; y += stepMetres) {
    let mast = false, struck = false;
    for (let z = index.min[2]; z < index.max[2] && !struck; z += stationMetres) {
      const from = [reach, y, z], solid = index.first(from, [-1, 0, 0], reach * 2, SOLID, 0, ship.isLine);
      if (!solid || partOf[solid.triangle] !== PART.mast) continue;
      mast = true;
      const hit = lib.sweepShipSegment([reach, y + boat.heave, z], [-reach, y + boat.heave, z], 0.07, boat, null, null);
      struck = hit?.hitZone === 'rigging' && Math.abs(hit.fraction * reach * 2 - solid.t) <= SHOT_TOLERANCE_M;
    }
    if (!mast) continue;
    seen = true;
    if (struck) { lowest = Math.min(lowest, y); highest = Math.max(highest, y); gap = 0; }
    else worstGap = Math.max(worstGap, gap += stepMetres);
  }
  return seen ? { mastStruckFromM: round(lowest), mastStruckToM: round(highest), mastDeadBandM: round(worstGap) } : {};
}

export function auditGuns(ship, lib) {
  const { createGunDefinitions, createNavalBattleGunDefinitions, gunModelDirection } = lib, s = ship.scale, sea = ship.hydro.sinkage;
  const toM = (p) => [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
  const canon = createGunDefinitions(ship.id), guns = createNavalBattleGunDefinitions(ship.id), rows = [];
  for (const gun of guns) {
    const muzzle = toM(gun.muzzleDesign), breech = toM(gun.breechDesign), station = toM(gun.station);
    // A gun's group may hold nested groups, so ask its triangle range and not the smallest name.
    const ranges = ship.asset.groups.filter((g) => String(g.id) === String(gun.meshGroup)).map((g) => [g.firstVertex / 3, (g.firstVertex + g.vertexCount) / 3]);
    const own = (t) => ranges.some(([a, b]) => t >= a && t < b);
    const hasMesh = ranges.length > 0;
    const notOwn = (t) => !own(t);
    const muzzleOff = hasMesh ? ship.index.nearest(muzzle, 0xff, 30, notOwn)?.distance ?? 30 : null;
    const breechOff = hasMesh ? ship.index.nearest(breech, 0xff, 30, notOwn)?.distance ?? 30 : null;
    const dir = unit(gunModelDirection(gun, s, 0, 0));
    const blocked = ship.index.first(muzzle, dir, 6, SOLID, 0.02, own);
    const floor = floorBeneath(ship, station[0], station[1] + 1.2, station[2], station[1], PART.hull);
    const hullNear = ship.index.nearest(muzzle, PART.hull, 30)?.distance ?? 30;
    rows.push({
      id: gun.id, group: gun.meshGroup, abstract: !hasMesh, kind: gun.kind, side: gun.side, visibleCrew: !!gun.visibleCrew,
      muzzleM: muzzle.map((v) => round(v)), muzzleOff: round(muzzleOff), breechOff: round(breechOff),
      muzzleAboveSea: round(muzzle[1] - sea), hullNear: round(hullNear),
      blockedAt: blocked ? round(blocked.t) : null, blockedBy: blocked ? ship.groupId(blocked.triangle) : null,
      stationGap: floor ? round(station[1] - floor.y) : null, breechAboveFloor: round(breech[1] - station[1]),
    });
  }
  return { canonical: canon.length, battle: guns.length, rows };
}

// Is a standing body at this point on something, inside the ship, and clear of what is around it?
export function standingAt(ship, x, y, z) {
  // From the knee down, so that a tiller or a wheel overhead is not taken for the floor.
  const floor = floorBeneath(ship, x, y + 0.5, z, y);
  const clearance = (height) => ship.index.nearest([x, y + height, z], PART.hull | PART.mast | PART.gun, 2);
  const chest = clearance(1.1), knee = clearance(0.45), up = ship.index.first([x, y + 0.2, z], upward, 3, PART.hull | PART.gun | PART.mast | PART.spar);
  // A side at any height of his legs and a boot either way along the ship: at knee height alone, the line runs out
  // through a gunport, or along the edge between two triangles of the hull.
  const side = (direction) => [0.15, 0.35, 0.7].some((height) => [0, BOOT_REACH, -BOOT_REACH].some((dz) => ship.index.first([x, y + height, z + dz], [direction, 0, 0], 40, PART.hull)));
  const portSide = side(-1), starboardSide = side(1);
  return {
    floorGap: floor ? y - floor.y : null, floorPart: floor ? ship.groupId(floor.triangle) : null,
    chest: chest?.distance ?? 2, chestPart: chest ? ship.groupId(chest.triangle) : null, knee: knee?.distance ?? 2, kneePart: knee ? ship.groupId(knee.triangle) : null,
    headroom: up ? up.t + 0.2 : Infinity, enclosed: portSide && starboardSide, roofed: !!(ship.index.first([x, y + 2.4, z], down, 1.9, PART.hull | PART.gun)),
  };
}

export function auditCrewStations(ship, lib) {
  const { createCompany } = lib, company = createCompany(undefined, ship.id, { fullWatch: true }), rows = [];
  for (const s of company.crew) {
    const p = s.position, seated = s.role === 'Rower' || s.role === 'Paddler' || /seat|rower|paddl/i.test(s.stationKey ?? '') || Number.isFinite(s.y);
    const at = standingAt(ship, p[0], p[1], p[2]);
    rows.push({ id: s.id, key: s.stationKey, role: s.role, seated, at: p.map((v) => round(v)), ...at });
  }
  const standing = rows.filter((r) => !r.seated);
  const floating = rows.filter((r) => r.floorGap === null || r.floorGap > 0.15), sunk = rows.filter((r) => r.floorGap !== null && r.floorGap < -0.1);
  const pressed = standing.filter((r) => r.chest < 0.12), outside = rows.filter((r) => !r.enclosed), low = standing.filter((r) => r.headroom < 1.55);
  return {
    crew: rows.length, seated: rows.length - standing.length, floating: floating.length, sunk: sunk.length, pressed: pressed.length, outside: outside.length, lowHeadroom: low.length,
    maxFloat: round(Math.max(0, ...floating.map((r) => r.floorGap ?? 9))), maxSink: round(Math.max(0, ...sunk.map((r) => -r.floorGap))), minChest: round(Math.min(2, ...standing.map((r) => r.chest))),
    worst: [...floating, ...sunk, ...pressed, ...outside, ...low].slice(0, 6).map((r) => ({ key: r.key, role: r.role, at: r.at, floorGap: round(r.floorGap), floorPart: r.floorPart, chest: round(r.chest), chestPart: r.chestPart, headroom: round(r.headroom), enclosed: r.enclosed })),
  };
}

// Every place the walk grid says a body may stand, against the deck actually drawn there.
export function auditWalkways(ship, lib, step = 0.4) {
  const { crewNavigationClear, modelDeck, modelDeckWidth, vesselHull } = lib, boat = ship.boat(), s = ship.scale;
  const bounds = vesselHull(boat).bounds ?? [-6, 6];
  let clear = 0, noFloor = 0, floating = 0, inside = 0, sunk = 0, blocked = 0, worstFloat = 0, worstSink = 0;
  const worst = [], parts = {};
  for (let Z = bounds[0] * s[2]; Z <= bounds[1] * s[2]; Z += step) {
    const zd = Z / s[2];
    let half;
    try { half = modelDeckWidth(boat, zd) * s[0]; } catch { continue; }
    if (!(half > 0)) continue;
    for (let X = -half; X <= half; X += step) {
      const xd = X / s[0], y = modelDeck(boat, zd, xd) * s[1];
      if (!Number.isFinite(y) || !crewNavigationClear([X, y, Z], boat)) continue;
      clear++;
      const at = standingAt(ship, X, y, Z);
      if (at.floorGap === null) { noFloor++; if (worst.length < 4) worst.push({ what: 'no floor', at: [round(X), round(y), round(Z)] }); continue; }
      if (at.floorGap > 0.12 && at.roofed) { inside++; continue; }
      if (at.floorGap > 0.12) { floating++; worstFloat = Math.max(worstFloat, at.floorGap); if (worst.length < 4) worst.push({ what: 'stands above floor', gap: round(at.floorGap), part: at.floorPart, at: [round(X), round(y), round(Z)] }); }
      else if (at.floorGap < -0.12) { sunk++; worstSink = Math.max(worstSink, -at.floorGap); tally(parts, at.floorPart.replace(/\d+/g, '#')); if (worst.length < 4) worst.push({ what: 'under something', gap: round(at.floorGap), part: at.floorPart, at: [round(X), round(y), round(Z)] }); }
      if (at.chest < 0.1 || at.knee < 0.05) { blocked++; tally(parts, (at.chest < 0.1 ? at.chestPart : at.kneePart).replace(/\d+/g, '#')); }
    }
  }
  return { clear, noFloor, floating, inside, sunk, blocked, worstFloat: round(worstFloat), worstSink: round(worstSink), blockedBy: topOf(parts, 4), worst };
}

export function auditChainwales(ship, lib) {
  const { victoryChainwale, VICTORY_MASTS } = lib;
  if (ship.id !== 'victory') return null;
  const s = ship.scale;
  let samples = 0, worstY = 0, worstOuter = 0, missing = 0;
  for (const [index, mast] of VICTORY_MASTS.entries()) for (const side of [-1, 1]) {
    const first = victoryChainwale(index, side, mast.z + mast.shrouds.lowerStart);
    for (let i = 0; i <= 8; i++) {
      const z = first.z0 + (first.z1 - first.z0) * ((i + 0.5) / 9), c = victoryChainwale(index, side, z);
      const x = ((c.inner + c.outer) / 2) * s[0];
      const group = `chainwale.${mast.id}.${side}`;
      const skipOthers = (t) => !ship.groupId(t).startsWith(group);
      const hit = ship.index.first([x, c.y * s[1] + 2, z * s[2]], down, 6, 0xff, 0, skipOthers);
      samples++;
      if (!hit) { missing++; continue; }
      worstY = Math.max(worstY, Math.abs(c.y * s[1] + 2 - hit.t - c.y * s[1]));
      const out = ship.index.first([side * 40, c.y * s[1] - 0.02, z * s[2]], [-side, 0, 0], 80, 0xff, 0, skipOthers);
      if (out) worstOuter = Math.max(worstOuter, Math.abs(Math.abs(side * 40 - side * out.t) - Math.abs(c.outer) * s[0]));
    }
  }
  return { samples, missing, worstYM: round(worstY), worstOuterM: round(worstOuter) };
}

// Named attachment points against what is drawn, in the same pose.
export function auditNodes(ship, lib, pose = {}) {
  const { resolveShipNode } = lib, boat = ship.boat(pose), rows = [];
  for (const [id, node] of Object.entries(ship.model.nodes)) {
    // The camera is an eye, not an attachment.
    if (/^(hull$|deck\.|station\.|helm\.camera)/.test(id) || node.kind === 'frame' && !/^mast\./.test(id)) continue;
    let p;
    try { p = resolveShipNode(boat, id, { space: 'vessel', side: -1, time: pose.time ?? 0, wind: pose.wind ?? 0 }); } catch { continue; }
    if (!p || !p.every(Number.isFinite)) continue;
    const near = ship.index.nearest(p, DRAWN | PART.flag, 30);
    rows.push({ id, kind: node.kind, moving: !!node.motion, off: near ? near.distance : 30, part: near ? ship.groupId(near.triangle) : null });
  }
  const loose = rows.filter((r) => r.off > 0.25).sort((a, b) => b.off - a.off);
  return { nodes: rows.length, loose: loose.length, worst: loose.slice(0, 6).map((r) => `${r.id} ${round(r.off)}m`).join(', '), rows: loose.map((r) => ({ id: r.id, off: round(r.off), moving: r.moving })) };
}

// Each rope is one island of triangles. Both of its ends should be made fast to something.
export function auditRopeEnds(ship, tolerance = 0.3) {
  const { asset, positions, partOf } = ship, indices = asset.indices, parent = new Map();
  const key = (v) => `${Math.round(positions[v * 3] * 500)},${Math.round(positions[v * 3 + 1] * 500)},${Math.round(positions[v * 3 + 2] * 500)}`;
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(x) !== r) { const next = parent.get(x); parent.set(x, r); x = next; } return r; };
  const triangles = [];
  for (let t = 0; t < partOf.length; t++) {
    if (partOf[t] !== PART.rope) continue;
    triangles.push(t);
    const a = key(indices[t * 3]), b = key(indices[t * 3 + 1]), c = key(indices[t * 3 + 2]);
    for (const k of [a, b, c]) if (!parent.has(k)) parent.set(k, k);
    parent.set(find(b), find(a)); parent.set(find(c), find(a));
  }
  const islands = new Map();
  for (const t of triangles) {
    const root = find(key(indices[t * 3]));
    let island = islands.get(root);
    if (!island) islands.set(root, island = { triangles: new Set(), vertices: new Set(), group: ship.groupId(t) });
    island.triangles.add(t);
    for (let k = 0; k < 3; k++) island.vertices.add(indices[t * 3 + k]);
  }
  let ropes = 0, loose = 0, worst = 0, worstAt = null;
  const looseGroups = {};
  for (const island of islands.values()) {
    const verts = [...island.vertices];
    if (verts.length < 6) continue;
    const p = (v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]], dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const centre = [0, 0, 0];
    for (const v of verts) { const q = p(v); centre[0] += q[0]; centre[1] += q[1]; centre[2] += q[2]; }
    centre.forEach((_, i) => { centre[i] /= verts.length; });
    let a = verts[0], best = -1;
    for (const v of verts) { const d = dist(p(v), centre); if (d > best) { best = d; a = v; } }
    let b = verts[0]; best = -1;
    for (const v of verts) { const d = dist(p(v), p(a)); if (d > best) { best = d; b = v; } }
    if (best < 0.5) continue; // A fitting, not a line.
    ropes++;
    const skip = (t) => island.triangles.has(t);
    for (const end of [a, b]) {
      const near = ship.index.nearest(p(end), DRAWN, 20, skip), gap = near ? near.distance : 20;
      if (gap > tolerance) { loose++; tally(looseGroups, island.group.replace(/\d+/g, '#')); if (gap > worst) { worst = gap; worstAt = p(end).map((v) => round(v, 1)); } }
    }
  }
  return { ropes, looseEnds: loose, worstM: round(worst), worstAt, groups: topOf(looseGroups, 4) };
}

// --- Check 3: waterline and hull ----------------------------------------------------------------------------------

export function auditWaterline(ship, lib) {
  const { vesselRailHeight, modelDeck, modelHullWidth, vesselHull } = lib, boat = ship.boat(), s = ship.scale, h = ship.hydro, sea = h.sinkage, index = ship.index;
  const bounds = vesselHull(boat).bounds ?? [-6, 6], HULL = PART.hull;
  let bottom = Infinity, sideX = 0, foreZ = Infinity, aftZ = -Infinity, foreGroup = '', aftGroup = '', sideTopLimit = -Infinity;
  const keepHull = (id) => !/^(anchor|helm\.(rudder|steering)|bow\.(arms|headrail|headtimber|grating)|boat\.|rig\.)/.test(id);
  for (let t = 0; t < ship.partOf.length; t++) {
    if (ship.partOf[t] !== HULL || !keepHull(ship.groupId(t))) continue;
    for (let k = 0; k < 3; k++) {
      const v = ship.asset.indices[t * 3 + k] * 3, x = ship.positions[v], y = ship.positions[v + 1], z = ship.positions[v + 2];
      if (y < bottom) bottom = y;
      if (Math.abs(x) > sideX) sideX = Math.abs(x);
      if (z < foreZ) { foreZ = z; foreGroup = ship.groupId(t); }
      if (z > aftZ) { aftZ = z; aftGroup = ship.groupId(t); }
      if (y > sideTopLimit) sideTopLimit = y;
    }
  }
  const notHullProper = (t) => !keepHull(ship.groupId(t));
  // Across the hull at a station: how wide it is, and how high its side stands.
  const widthAt = (y, z) => {
    const a = index.first([sideX + 3, y, z], [-1, 0, 0], sideX * 2 + 6, HULL, 0, notHullProper), b = index.first([-sideX - 3, y, z], [1, 0, 0], sideX * 2 + 6, HULL, 0, notHullProper);
    return a && b ? { right: sideX + 3 - a.t, left: -sideX - 3 + b.t } : null;
  };
  const stations = 41, top = index.max[1] + 2, rail = [], deckErrors = [], railErrors = [];
  const hullFore = bounds[0] * s[2], hullAft = bounds[1] * s[2];
  for (let i = 1; i < stations; i++) {
    const z = hullFore + (hullAft - hullFore) * (i / stations);
    let widest = 0;
    for (let y = bottom; y < top; y += 0.25) { const w = widthAt(y, z); if (w) widest = Math.max(widest, w.right, -w.left); }
    if (widest < 0.05) continue;
    // The top of her side: looking in from abeam, the highest height at which the first thing met stands out near her side.
    const sideTop = (side) => {
      const outside = side * (sideX + 3);
      for (let y = Math.min(top, sideTopLimit); y > bottom; y -= 0.05) {
        const hit = index.first([outside, y, z], [-side, 0, 0], sideX * 2 + 6, HULL, 0, notHullProper);
        if (hit && Math.abs(outside - side * hit.t) >= widest * 0.55) return y;
      }
      return -Infinity;
    };
    const measured = Math.min(sideTop(-1), sideTop(1));
    if (!Number.isFinite(measured)) continue;
    const u = (i / stations);
    rail.push({ z: round(z), u: round(u), rail: round(measured - sea) });
    const game = vesselRailHeight(boat, z);
    if (game !== null) railErrors.push(Math.abs(game - measured));
    // The deck: what a boot meets partway to the side, away from the centreline's hatches.
    const zd = z / s[2];
    // Benches and hatches stand on the deck, so the lowest of several places is the deck itself.
    const across = [0.2, 0.32, 0.44, 0.56].flatMap((share) => [-share * widest, share * widest]);
    const hits = across.map((x) => ({ x, y: floorUnder(ship, x, measured + 0.5, z, HULL)?.y })).filter((h) => Number.isFinite(h.y));
    if (hits.length) {
      const lowest = hits.reduce((a, b) => (b.y < a.y ? b : a));
      let want;
      try { want = modelDeck(boat, zd, lowest.x / s[0]) * s[1]; } catch { want = null; }
      if (want !== null) deckErrors.push(Math.abs(want - lowest.y));
    }
  }
  const central = rail.filter((r) => r.u > 0.2 && r.u < 0.8);
  const lowest = rail.reduce((a, r) => (r.rail < a.rail ? r : a), rail[0]), lowestCentral = central.reduce((a, r) => (r.rail < a.rail ? r : a), central[0]);
  // The hand-drawn hull formula, used for buoyancy and the walking deck, against the planks actually drawn.
  const formula = [];
  for (let zd = bounds[0] + 0.1; zd < bounds[1]; zd += (bounds[1] - bounds[0]) / 24) {
    for (let y = -h.draft * 0.9 + sea; y < h.freeboard + sea; y += Math.max(0.2, (h.draft + h.freeboard) / 8)) {
      let f; try { f = modelHullWidth(boat, zd, y / s[1]) * s[0]; } catch { continue; }
      const w = widthAt(y, zd * s[2]);
      if (!(f > 0.02) || !w) continue;
      formula.push(Math.abs(f - (w.right - w.left) / 2));
    }
  }
  // Displaced volume integrated from the mesh, against the table the hull floats by.
  let volume = 0, waterplane = 0;
  const dz = 0.25 * Math.max(1, boat.length / 20), dy = Math.max(0.02, h.draft / 30);
  for (let z = foreZ; z < aftZ; z += dz) {
    const w0 = widthAt(sea - 0.01, z);
    if (w0) waterplane += (w0.right - w0.left) * dz;
    for (let y = bottom + dy / 2; y < sea; y += dy) {
      const w = widthAt(y, z);
      if (w) volume += (w.right - w.left) * dz * dy;
    }
  }
  return {
    id: ship.id, draftTableM: round(h.draft), draftMeshM: round(sea - bottom), freeboardTableM: round(h.freeboard),
    railMinM: round(lowest.rail), railMinAtZ: lowest.z, railMidMinM: round(lowestCentral.rail), railMidAtZ: lowestCentral.z, railAmidshipsM: round(rail[Math.floor(rail.length / 2)].rail),
    railFormulaP90M: round(percentile(railErrors, 0.9)), railFormulaMaxM: round(railErrors.length ? Math.max(...railErrors) : 0),
    deckFormulaP75M: round(percentile(deckErrors, 0.75)), deckFormulaMaxM: round(deckErrors.length ? Math.max(...deckErrors) : 0),
    hullFormulaP90M: round(percentile(formula, 0.9)), hullFormulaMaxM: round(formula.length ? Math.max(...formula) : 0),
    beamRuntimeM: round(boat.beam), beamMeshM: round(sideX * 2), lengthRuntimeM: round(boat.length), lengthMeshM: round(aftZ - foreZ), foreZ: round(foreZ), aftZ: round(aftZ), foreGroup, aftGroup,
    volumeTableM3: round(h.volume, 0), volumeMeshM3: round(volume, 0), volumeErrorPct: round((100 * (volume - h.volume)) / h.volume, 1),
    waterplaneTableM2: round(h.waterplaneArea, 0), waterplaneMeshM2: round(waterplane, 0),
  };
}

// --- Check 4: crew and props --------------------------------------------------------------------------------------

const SOLE_LOOK = 0.28;
// Each sailor's skinned surface. An edge of his body that crosses a solid surface is a real intersection, not
// merely an arm reaching round something. Depth is how far past that surface the part reaches from his own middle.
export function auditCrewBodies(ship, lib, crewMeshes, { everyNth = 3, rowingPhase = 0.22, settle = 40 } = {}) {
  const { createCompany, stepCompany } = lib;
  const boat = ship.boat({ rudder: 0, rollVelocity: 0, sailFore: 1, sailMain: 1, sailMizzen: 1, crew: false, hatchesClosed: 0 });
  if (ship.model.geometry === 'rowing-procedural-v1') boat.rowingState = { phase: rowingPhase, rate: 0.45, effortPort: 0.6, effortStarboard: 0.6, cadence: 0.45 };
  const company = createCompany(undefined, ship.id, { fullWatch: true });
  for (let i = 0; i < settle; i++) stepCompany(company, boat, 0.05, 2);
  return crewBodiesOf(ship, lib, crewMeshes, company, boat, { everyNth });
}
// A company as it stands now, on this boat.
export function crewBodiesOf(ship, lib, crewMeshes, company, boat, { everyNth = 3 } = {}) {
  const { poseCrewWork, applyCrewRealism } = lib, rows = [], kinds = {}, MASK = PART.hull | PART.mast | PART.gun;
  for (const s of company.crew) {
    const mesh = (s.indigenous && crewMeshes[`classic-${s.sex}`]) || crewMeshes[s.sex], a = mesh.animator;
    // In the order the game draws him, js/crew.js: a hand on a tiller closes its fingers only in applyCrewRealism.
    a.sample('Idle', s.time, 'Walk', s.walkTime, s.walk);
    if (s.brace > 0.001 && !(s.job?.rung > 0)) a.blend('Brace', s.time, s.brace);
    poseCrewWork(a, s, boat);
    applyCrewRealism(a, s, boat, 1 / 60);
    const f = new Float32Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength / 4), u = new Uint16Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength / 2);
    const count = mesh.vertices.byteLength / 60, world = new Float64Array(count * 3), centre = [0, 0, 0];
    let lowest = Infinity;
    for (let i = 0; i < count; i++) {
      const local = [0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const at = u[i * 30 + 18 + k] * 16, w = f[i * 15 + 11 + k];
        if (!w) continue;
        for (let c = 0; c < 3; c++) local[c] += w * (a.palette[at + c] * f[i * 15] + a.palette[at + 4 + c] * f[i * 15 + 1] + a.palette[at + 8 + c] * f[i * 15 + 2] + a.palette[at + 12 + c]);
      }
      for (let c = 0; c < 3; c++) {
        world[i * 3 + c] = s.transform[c] * local[0] + s.transform[c + 4] * local[1] + s.transform[c + 8] * local[2] + s.transform[c + 12];
        centre[c] += world[i * 3 + c];
      }
      if (world[i * 3 + 1] < lowest) lowest = world[i * 3 + 1];
    }
    centre.forEach((_, c) => { centre[c] /= count; });
    const indices = mesh.indices, crossed = {};
    let edges = 0;
    for (let t = 0; t < indices.length; t += 3 * everyNth) for (let k = 0; k < 3; k++) {
      const p = indices[t + k] * 3, q = indices[t + (k + 1) % 3] * 3;
      const o = [world[p], world[p + 1], world[p + 2]], d = [world[q] - o[0], world[q + 1] - o[1], world[q + 2] - o[2]];
      const hit = ship.index.first(o, d, 1, MASK);
      if (hit) { edges++; tally(crossed, ship.groupId(hit.triangle)); }
    }
    let deepest = 0, part = null;
    const crossedNames = new Set(Object.keys(crossed));
    if (crossedNames.size) for (let i = 0; i < count; i += 2) {
      const p = [world[i * 3], world[i * 3 + 1], world[i * 3 + 2]], d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]], length = Math.hypot(d[0], d[1], d[2]) || 1;
      const hit = ship.index.first(centre, [d[0] / length, d[1] / length, d[2] / length], length, MASK);
      if (hit && crossedNames.has(ship.groupId(hit.triangle)) && length - hit.t > deepest) { deepest = length - hit.t; part = ship.groupId(hit.triangle); }
    }
    // The soles against what is under them, looking from below the lowest thwart's underside: a toe under the next
    // bench has the bench over it, not through it.
    let soleDepth = 0, soles = 0;
    for (let i = 0; i < count; i++) {
      if (world[i * 3 + 1] > lowest + 0.03) continue;
      const hit = ship.index.first([world[i * 3], lowest + SOLE_LOOK, world[i * 3 + 2]], down, 1.2, PART.hull);
      if (hit) { soleDepth += SOLE_LOOK - hit.t; soles++; }
    }
    const worstPart = Object.entries(crossed).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    if (edges >= 6) tally(kinds, worstPart.replace(/\d+/g, '#'));
    rows.push({ key: s.stationKey, role: s.role, job: s.job?.kind ?? null, stage: s.job?.stage ?? null, at: centre.map((v) => round(v, 1)), edges, deepest, part: part ?? worstPart, soleBelow: soles ? soleDepth / soles : null });
  }
  const bad = rows.filter((r) => r.edges >= 6 && r.deepest > 0.08).sort((a, b) => b.deepest - a.deepest);
  const sunk = rows.filter((r) => r.soleBelow !== null && r.soleBelow > 0.04);
  return {
    crew: rows.length, intersecting: rows.filter((r) => r.edges >= 6).length, throughDeep: bad.length, deepestM: round(bad[0]?.deepest ?? 0),
    soleSunk: sunk.length, soleSunkMaxM: round(Math.max(0, ...sunk.map((r) => r.soleBelow))),
    rows, parts: topOf(kinds, 5), worst: bad.slice(0, 6).map((r) => ({ key: r.key, role: r.role, at: r.at, deepest: round(r.deepest), part: r.part, edges: r.edges })),
  };
}

// The company at work for a while: does anyone walk on nothing?
export function auditCrewRoutes(ship, lib, { seconds = 60, dt = 0.1 } = {}) {
  const { createCompany, stepCompany } = lib, boat = ship.boat({ rudder: 0, rollVelocity: 0, sailFore: 1, sailMain: 1, sailMizzen: 1, crew: false, hatchesClosed: 0 });
  if (ship.model.geometry === 'rowing-procedural-v1') boat.rowingState = { phase: 0.22, rate: 0.45, effortPort: 0.6, effortStarboard: 0.6, cadence: 0.45 };
  const company = createCompany(undefined, ship.id, { fullWatch: true });
  let samples = 0, floating = 0, buried = 0, worstFloat = 0, worstBury = 0;
  const who = {}, cells = {};
  for (let i = 0; i < seconds / dt; i++) {
    stepCompany(company, boat, dt, 2);
    if (i % 5) continue;
    for (const s of company.crew) {
      if (s.casualtyState === 'fallen') continue;
      const p = s.position;
      // A hand climbing the shrouds is meant to be off the deck.
      let deck = null;
      try { deck = lib.crewDeckHeight(boat, p[2] / ship.scale[2], p[0] / ship.scale[0]) * ship.scale[1]; } catch { deck = null; }
      if (deck !== null && p[1] > deck + 0.6) continue;
      const floor = floorBeneath(ship, p[0], p[1] + 0.25, p[2], p[1]);
      samples++;
      const gap = floor ? p[1] - floor.y : 9;
      if (gap > 0.2) { floating++; worstFloat = Math.max(worstFloat, gap); tally(who, s.stationKey); tally(cells, `${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])}`); }
      else if (gap < -0.1) { buried++; worstBury = Math.max(worstBury, -gap); tally(who, s.stationKey); }
    }
  }
  return { samples, floatingPct: round((100 * floating) / Math.max(1, samples), 1), buriedPct: round((100 * buried) / Math.max(1, samples), 1), worstFloatM: round(worstFloat), worstBuryM: round(worstBury), who: topOf(who, 6), cells: topOf(cells, 3) };
}

// Every prop of a port against the ground, the water and the building it is said to stand on.
export function auditPortProps(pack, lib, propModels) {
  const { terrainSurfaceSample, PROP_MODELS, layPortProps } = lib, port = pack.port, region = pack.region;
  const groundAt = (x, z) => terrainSurfaceSample(pack.heights, x, z, region);
  const geometry = pack.portGeometry, stride = 8, count = geometry.vertices.length / stride, positions = new Float64Array(count * 3);
  for (let v = 0; v < count; v++) for (let c = 0; c < 3; c++) positions[v * 3 + c] = geometry.vertices[v * stride + c];
  const index = createMeshIndex(positions, geometry.indices);
  const props = port.props ?? layPortProps(port, groundAt);
  const row = { id: region.id, cleats: 0, cleatOff: 0, cleatWorst: 0, cleatNoMesh: 0, jetties: 0, jettyRootHigh: 0, jettyHeadDry: 0, jettyFarDeep: 0, jettyRootBuriedM: 0, jettyDetails: [] };
  for (const prop of props) {
    if (prop.model === 0) {
      row.cleats++;
      // From just above: a crane or a shed roof overhead is not what it stands on.
      const hit = index.first([prop.x, prop.y + 0.4, prop.z], [0, -1, 0], 40);
      if (!hit) { row.cleatNoMesh++; continue; }
      const off = Math.abs(prop.y + 0.4 - hit.t - prop.y);
      if (off > 0.1) row.cleatOff++;
      row.cleatWorst = Math.max(row.cleatWorst, off);
    } else {
      row.jetties++;
      const model = propModels[prop.model], half = PROP_MODELS[prop.model].metres / 2;
      const seaX = Math.sin(prop.yaw), seaZ = Math.cos(prop.yaw);
      const root = groundAt(prop.x - seaX * half, prop.z - seaZ * half), head = groundAt(prop.x + seaX * half, prop.z + seaZ * half);
      const deck = 1.5; // JETTY_DECK_ABOVE_SEA_M: its deck stands this high above the sea wherever it is.
      if (root > deck) { row.jettyRootHigh++; row.jettyRootBuriedM = Math.max(row.jettyRootBuriedM, root - deck); }
      if (head >= 0) row.jettyHeadDry++;
      row.jettyDetails.push({ model: PROP_MODELS[prop.model].id, rootGround: round(root), headGround: round(head), standsAt: round(model.standsAt) });
    }
  }
  row.cleatWorst = round(row.cleatWorst);
  row.jettyRootBuriedM = round(row.jettyRootBuriedM);
  return row;
}

// A jetty's deck in its own model: `deckShare` is a hand-written fraction of its height.
export function auditJettyModel(spec, model) {
  const count = model.vertices.length / 8, positions = new Float64Array(count * 3);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v++) for (let c = 0; c < 3; c++) { const value = model.vertices[v * 8 + c]; positions[v * 3 + c] = value; lo[c] = Math.min(lo[c], value); hi[c] = Math.max(hi[c], value); }
  const index = createMeshIndex(positions, model.indices), tops = [];
  for (let i = 0; i < 24; i++) for (const x of [-0.25, 0, 0.25]) {
    const z = lo[2] + (hi[2] - lo[2]) * ((i + 0.5) / 24), hit = index.first([x * (hi[0] - lo[0]), hi[1] + 1, z], [0, -1, 0], hi[1] - lo[1] + 2);
    if (hit) tops.push(hi[1] + 1 - hit.t);
  }
  const deckMesh = percentile(tops, 0.5), deckClaim = model.height * (spec.deckShare ?? 0);
  return { id: spec.id, lengthM: round(hi[2] - lo[2]), widthM: round(hi[0] - lo[0]), heightM: round(hi[1] - lo[1]), deckClaimM: round(deckClaim), deckMeshM: round(deckMesh), deckAboveSeaM: round(model.standsAt + deckMesh), wantAboveSeaM: 1.5 };
}

// --- Check 5: surface -------------------------------------------------------------------------------------------

const TIMBER_MATERIALS = new Map([[0, 'deck'], [1, 'oak'], [5, 'oak-5'], [6, 'oak-6'], [7, 'trim'], [10, 'spar'], [14, 'wood-14'], [15, 'hull plank'], [16, 'wale/post'], [17, 'wood-17'], [18, 'wood-18'], [20, 'paint-20'], [21, 'paint-21'], [23, 'paint-23'], [24, 'paint-24'], [26, 'paint-26']]);

// How many times the oak texture repeats per metre across and along the grain, area-weighted, by material.
export function auditSurface(ship) {
  const { asset, positions, partOf } = ship, indices = asset.indices, vertices = asset.vertices, totals = new Map();
  const triangles = indices.length / 3, gradient = (a, b, c, ua, ub, uc) => {
    // The direction and rate at which a coordinate changes across a triangle.
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
    if (nn < 1e-14) return null;
    const du1 = ub - ua, du2 = uc - ua;
    const g = [du1 * (e2[1] * n[2] - e2[2] * n[1]) + du2 * (n[1] * e1[2] - n[2] * e1[1]), du1 * (e2[2] * n[0] - e2[0] * n[2]) + du2 * (n[2] * e1[0] - n[0] * e1[2]), du1 * (e2[0] * n[1] - e2[1] * n[0]) + du2 * (n[0] * e1[1] - n[1] * e1[0])];
    return { g: g.map((v) => v / nn), area: Math.sqrt(nn) / 2 };
  };
  for (let t = 0; t < triangles; t++) {
    if (partOf[t] & (PART.cloth | PART.rope | PART.flag)) continue;
    const v = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]], material = Math.floor(vertices[v[0] * 9 + 6]);
    if (!TIMBER_MATERIALS.has(material)) continue;
    const [a, b, c] = v.map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
    const gu = gradient(a, b, c, vertices[v[0] * 9 + 7], vertices[v[1] * 9 + 7], vertices[v[2] * 9 + 7]);
    const gv = gradient(a, b, c, vertices[v[0] * 9 + 8], vertices[v[1] * 9 + 8], vertices[v[2] * 9 + 8]);
    if (!gu || !gv || !(gu.area > 1e-5)) continue;
    let entry = totals.get(material);
    if (!entry) totals.set(material, entry = { area: 0, samples: [] });
    entry.area += gu.area;
    entry.samples.push([Math.hypot(...gu.g), Math.hypot(...gv.g), gu.area]);
  }
  const weighted = (samples, index) => {
    const sorted = samples.filter((s) => Number.isFinite(s[index])).sort((a, b) => a[index] - b[index]), half = sorted.reduce((sum, s) => sum + s[2], 0) / 2;
    let sum = 0;
    for (const s of sorted) { sum += s[2]; if (sum >= half) return s[index]; }
    return 0;
  };
  const rows = {};
  for (const [material, entry] of totals) rows[material] = { name: TIMBER_MATERIALS.get(material), areaM2: round(entry.area, 1), acrossPerM: round(weighted(entry.samples, 0), 3), alongPerM: round(weighted(entry.samples, 1), 3) };
  const [sx, sy, sz] = ship.scale;
  return {
    id: ship.id, materials: rows,
    // Planks the hull shader draws in design units, so they grow with the ship. Only the Iberian ships draw deck seams.
    deckPlankM: round(0.145 * sx, 3), wallCourseM: round(0.16 * sy, 3), plankButtM: round(2.6 * sz, 2), deckButtM: round(2.3 * sz, 2),
    hullCourseM: rows[15]?.acrossPerM ? round(1 / (18 * rows[15].acrossPerM), 3) : null,
  };
}

// --- Everything, and what it flags ----------------------------------------------------------------------------------

export const FAST_FAN = Object.freeze({ bearings: 12, elevations: [0, -6], columns: 28, rows: 20 });
export const FULL_FAN = Object.freeze({ bearings: 24, elevations: [0, -6, 10], columns: 48, rows: 32 });

export function auditShip(ship, lib, { fan = FULL_FAN, crewMeshes = null, everyNth = 3, routeSeconds = 60, pose = {} } = {}) {
  const row = { id: ship.id, posed: ship.posed };
  row.collision = auditShipCollision(ship, lib.sweepShipSegment, lib.createVesselDamageState, { ...fan, pose });
  row.masts = auditMasts(ship, lib);
  row.guns = auditGuns(ship.posed ? loadShip(ship.id) : ship, lib);
  row.crewStations = auditCrewStations(ship, lib);
  row.crewRoutes = auditCrewRoutes(ship, lib, { seconds: routeSeconds });
  row.walkways = auditWalkways(ship, lib);
  row.chainwales = auditChainwales(ship, lib);
  row.nodes = auditNodes(ship, lib, pose);
  row.ropes = auditRopeEnds(ship);
  row.waterline = auditWaterline(ship, lib);
  if (crewMeshes) row.crewBodies = auditCrewBodies(ship, lib, crewMeshes, { everyNth });
  row.surface = auditSurface(ship);
  return row;
}

// Every measurement that breaks its limit, by a key that stays the same from run to run.
export function flagsOf(results) {
  const flags = [];
  const add = (key, value, limit, note = '') => flags.push({ key, value: round(value, 2), limit, note });
  const reference = results.ships.find((r) => r.id === 'nina')?.surface;
  for (const r of results.ships) {
    const c = r.collision;
    if (c.airRigPct > 5) add(`collision.air-rig/${r.id}`, c.airRigPct, 5, `balls stop in air around the rig, median ${c.airGapMedianM} m from anything`);
    if (c.airHullPct > 2) add(`collision.air-hull/${r.id}`, c.airHullPct, 2, 'balls stop in air beside the hull');
    if (c.throughHullPct > 1) add(`collision.through-hull/${r.id}`, c.throughHullPct, 1, c.missedGroups);
    if (c.throughMastPct > 1) add(`collision.through-mast/${r.id}`, c.throughMastPct, 1, c.missedGroups);
    if (c.phantomMastPct > 0) add(`collision.phantom-mast/${r.id}`, c.phantomMastPct, 0, `rig hits credited to ${c.phantomNames}, which she does not have`);
    if (c.wrongMastPct > 3) add(`collision.wrong-mast/${r.id}`, c.wrongMastPct, 3, 'rig hits credited to a mast other than the nearest');
    const m = r.masts;
    for (const q of m.rows) {
      if (q.offZ !== null && q.offZ > 0.4) add(`mast.station/${r.id}/${q.mast}`, q.offZ, 0.4, `table ${q.tableZ} m, mesh ${q.meshZ} m`);
      if (q.fullBreakAboveDeck < 0.2) add(`mast.break-below-deck/${r.id}/${q.mast}`, q.fullBreakAboveDeck, 0.2, `full break ${q.fullBreak} m, deck ${q.deck} m`);
      if (q.footAboveDeck !== null && q.footAboveDeck > 0.1) add(`mast.foot-floats/${r.id}/${q.mast}`, q.footAboveDeck, 0.1);
    }
    if (m.unlisted.length || m.missing.length) add(`mast.names/${r.id}`, m.unlisted.length + m.missing.length, 0, `unlisted ${m.unlisted} missing ${m.missing}`);
    if (m.mastDeadBandM > 1) add(`mast.dead-band/${r.id}`, m.mastDeadBandM, 1, `lines at a mast that pass it, up to this far running, above her rail at ${m.railAmidshipsM} m`);
    const guns = r.guns.rows;
    const worstBy = (key, list = guns) => list.reduce((a, g) => Math.max(a, Math.abs(g[key] ?? 0)), 0);
    if (worstBy('muzzleOff') > 0.2) add(`gun.muzzle-off/${r.id}`, worstBy('muzzleOff'), 0.2);
    if (worstBy('breechOff') > 0.2) add(`gun.breech-off/${r.id}`, worstBy('breechOff'), 0.2);
    const blocked = guns.filter((g) => g.blockedAt !== null);
    if (blocked.length) add(`gun.blocked/${r.id}`, blocked.length, 0, `${blocked[0].group} into ${blocked[0].blockedBy} at ${blocked[0].blockedAt} m`);
    const visible = guns.filter((g) => g.visibleCrew || g.abstract), stationWorst = worstBy('stationGap', visible);
    if (stationWorst > 0.15) add(`gun.station-off-floor/${r.id}`, stationWorst, 0.15, visible.slice().sort((a, b) => Math.abs(b.stationGap ?? 0) - Math.abs(a.stationGap ?? 0))[0].group);
    const stray = guns.filter((g) => g.abstract && g.kind !== 'bow');
    if (stray.length) add(`gun.undrawn/${r.id}`, stray.length, 0, 'fires from a place with no gun drawn');
    const st = r.crewStations;
    if (st.floating) add(`crew.station-floats/${r.id}`, st.floating, 0, `up to ${st.maxFloat} m`);
    if (st.sunk - st.seated > 0) add(`crew.station-under/${r.id}`, st.sunk - st.seated, 0, `up to ${st.maxSink} m under something`);
    if (st.pressed) add(`crew.station-pressed/${r.id}`, st.pressed, 0, `chest ${st.minChest} m from a solid`);
    if (st.outside) add(`crew.station-outside/${r.id}`, st.outside, 0, 'no hull to one side at knee height');
    const route = r.crewRoutes;
    if (route.floatingPct > 0.5) add(`crew.route-floats/${r.id}`, route.floatingPct, 0.5, `${route.who}; up to ${route.worstFloatM} m`);
    if (route.buriedPct > 0.5) add(`crew.route-buried/${r.id}`, route.buriedPct, 0.5, `${route.who}; up to ${route.worstBuryM} m`);
    const w = r.walkways;
    if (w.noFloor) add(`walk.no-floor/${r.id}`, w.noFloor, 0);
    if (w.floating) add(`walk.over-nothing/${r.id}`, w.floating, 0, `of ${w.clear} cells; up to ${w.worstFloat} m`);
    if (w.inside) add(`walk.inside-structure/${r.id}`, w.inside, 0, `of ${w.clear} cells: under a roof with no floor`);
    if (w.blocked) add(`walk.through-solid/${r.id}`, w.blocked, 0, `of ${w.clear} cells; ${w.blockedBy}`);
    if (r.chainwales?.missing) add(`chainwale.missing/${r.id}`, r.chainwales.missing, 0, `of ${r.chainwales.samples} samples`);
    if (r.chainwales?.worstYM > 0.1) add(`chainwale.height/${r.id}`, r.chainwales.worstYM, 0.1);
    if (r.nodes.loose) add(`node.loose/${r.id}`, r.nodes.loose, 0, r.nodes.worst);
    if (r.ropes.looseEnds) add(`rope.loose/${r.id}`, r.ropes.looseEnds, 0, `of ${r.ropes.ropes} lines; worst ${r.ropes.worstM} m; ${r.ropes.groups}`);
    const h = r.waterline;
    if (h.railMidMinM < 0.8) add(`hull.low-rail/${r.id}`, h.railMidMinM, 0.8, `at z ${h.railMidAtZ} m`);
    if (Math.abs(h.volumeErrorPct) > 5) add(`hull.volume/${r.id}`, h.volumeErrorPct, 5);
    if (h.hullFormulaP90M > 0.15) add(`hull.width-formula/${r.id}`, h.hullFormulaP90M, 0.15);
    if (h.railFormulaP90M > 0.3) add(`hull.rail-formula/${r.id}`, h.railFormulaP90M, 0.3, 'vesselRailHeight against the rail drawn');
    if (h.deckFormulaP75M > 0.2) add(`hull.deck-formula/${r.id}`, h.deckFormulaP75M, 0.2, 'modelDeck against the deck drawn');
    const b = r.crewBodies;
    if (b?.throughDeep) add(`crew.through-solid/${r.id}`, b.deepestM, 0.08, `${b.throughDeep} of ${b.crew}; worst ${b.worst[0]?.key} through ${b.worst[0]?.part}`);
    if (b?.soleSunk) add(`crew.soles-sunk/${r.id}`, b.soleSunkMaxM, 0.04, `${b.soleSunk} of ${b.crew}`);
    if (reference && r.id !== 'nina') for (const [material, q] of Object.entries(r.surface.materials)) {
      const base = reference.materials[material];
      // A sliver of a material on the Niña says nothing about what the material should look like.
      if (!base || !(q.areaM2 > 5) || !(base.areaM2 > 10)) continue;
      const across = q.acrossPerM / base.acrossPerM, along = q.alongPerM / base.alongPerM;
      if (across > 1.67 || across < 0.6) add(`surface.grain-across/${r.id}/${q.name}`, across, 1.67, `${q.acrossPerM}/m against Niña's ${base.acrossPerM}/m`);
      if (along > 1.67 || along < 0.6) add(`surface.grain-along/${r.id}/${q.name}`, along, 1.67, `${q.alongPerM}/m against Niña's ${base.alongPerM}/m`);
    }
    if (reference && r.surface.wallCourseM / reference.wallCourseM > 1.67) add(`surface.wall-course/${r.id}`, r.surface.wallCourseM, round(reference.wallCourseM * 1.67, 2), `wall courses ${r.surface.wallCourseM} m wide against Niña's ${reference.wallCourseM} m`);
  }
  for (const b of results.buildings ?? []) {
    const out = b.mesh.through + b.mesh.late + b.mesh.air + b.mesh.early;
    if (out) add(`building.mesh/${b.id}`, out, 0, 'a shot and the mesh disagree on an intact building');
    const share = (row, n) => (100 * n) / Math.max(1, row.struck);
    if (share(b.piecesSquare, b.piecesSquare.air) > 2) add(`building.pieces-air-square/${b.id}`, share(b.piecesSquare, b.piecesSquare.air), 2);
    if (share(b.piecesTurned, b.piecesTurned.air) > 2) add(`building.pieces-air-turned/${b.id}`, share(b.piecesTurned, b.piecesTurned.air), 2, `reach grows from ${b.reachSquareM} m to ${b.reachTurnedM} m when turned; stops up to ${round(b.piecesTurned.maxAir, 1)} m from it`);
    if (share(b.piecesTurned, b.piecesTurned.through) > 2) add(`building.pieces-through/${b.id}`, share(b.piecesTurned, b.piecesTurned.through), 2);
  }
  for (const p of results.ports ?? []) {
    if (p.noted !== p.instances) add(`port.unknown-to-shot/${p.id}`, p.instances - p.noted, 0);
    if (p.misplaced) add(`port.mesh-misplaced/${p.id}`, p.misplaced, 0);
    if (p.cleatOff) add(`prop.cleat-off/${p.id}`, p.cleatOff, 0, `up to ${p.cleatWorst} m`);
    if (p.cleatNoMesh) add(`prop.cleat-no-mesh/${p.id}`, p.cleatNoMesh, 0);
    if (p.jettyRootHigh) add(`prop.jetty-root-buried/${p.id}`, p.jettyRootBuriedM, 0, 'the shore end stands in rising ground');
    if (p.jettyHeadDry) add(`prop.jetty-head-dry/${p.id}`, p.jettyHeadDry, 0);
  }
  for (const j of results.jetties ?? []) if (Math.abs(j.deckAboveSeaM - j.wantAboveSeaM) > 0.2) add(`prop.jetty-deck/${j.id}`, j.deckAboveSeaM, j.wantAboveSeaM);
  for (const t of results.trees ?? []) {
    if (t.mode === 'forest' && t.trunkStoppedPct < 50) add(`tree.no-collision/${t.species}`, t.trunkStoppedPct, 50, 'lines through the trunk that any shot stops');
    if (t.mode === 'foreshore' && t.airPct > 10) add(`tree.palm-air/${t.species}`, t.airPct, 10, `a ball stops ${t.airGapMedianM} m from anything`);
  }
  return flags.sort((a, b) => a.key.localeCompare(b.key));
}
