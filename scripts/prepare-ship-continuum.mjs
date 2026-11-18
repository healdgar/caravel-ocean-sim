#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes each ship body into the ship continuum (AGENTS.md rule 3; js/ship-continuum.js).
//   node scripts/prepare-ship-continuum.mjs [--only=trade-cog-underway] [--out=assets/ships/continuum] [--cells=360]
//                                           [--close=0.3] [--close-canvas=0.14] [--chain=8000]
// Each body is the ship's own assembly, as the game builds it: a trade vessel's (js/trade-vessels.js
// getTradeVesselArchetype) or a ship the player sails (js/ship-mesh.js createShipAssetCache). A player's ship is posed
// on the GPU alone (js/vessel-pose.js: its canvas, yards, oars, helm, guns and parts), so its spheres are not measured
// in poses but grown by how far each of its points can move (playerSlack); every one still holds its points.
// For each body:
//   clusters   a cluster hierarchy the GPU cuts by projected error. Each part (a group of the assembly) and each
//              fracture shard is clustered apart, its boundary a seam both sides coarsen together, so no simplified
//              triangle crosses a part or a shard. Each group's error is measured in every pose the ship takes (oars
//              through their stroke, the helm over, canvas set, half brailed and brailed), and every sphere holds
//              its points in all of them, so the cut keeps its bound while the parts move and poses nothing.
//   far body   the ship (less its cordage, thinner than any pixel it would cover) voxelized in two pieces, what is
//              rigid closed over gaps under --close metres and the canvas under --close-canvas, each drawn as a
//              closed surface (marching tetrahedra), together simplified to --chain triangles, then collapsed one
//              half-edge at a time to a few. Each vertex rides the ship vertex of its piece nearest it, so the far
//              body moves as the ship does; each step's error is measured posed against the ship.
//   splat      one view-facing ellipse with the far body's outline area seen side on and end on, and its colour.
// Streams are written gzipped beside a manifest with their receipts.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildDag } from '../third_party/threejs-nanites/dag/build.ts';
// What every rigid family's bake shares (scripts/continuum-bake.mjs), used here as it is there.
import { closest, closestOnTriangle, triangleSpheres, surfaceArea, ancestor } from './continuum-bake.mjs';
import { getTradeVesselArchetype, poseTradeVesselPoint, tradeMaterialLinearColor } from '../js/trade-vessels.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { vesselHull } from '../js/hull.js';
import {
  SHIP_CONTINUUM_FORMAT, SHIP_CONTINUUM_VERSION, SHIP_CONTINUUM_CLUSTER_WORDS, SHIP_CONTINUUM_FAR_VERTEX_WORDS, SHIP_CONTINUUM_STEP_WORDS,
  SHIP_CONTINUUM_NEVER, SHIP_CONTINUUM_MAX_DEPTH, SHIP_CONTINUUM_BODIES,
  packShipContinuumCluster, packShipContinuumFarVertex, shipContinuumSourceKey, shipContinuumSurface, validateShipContinuumManifest,
} from '../js/ship-continuum.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = option('out', 'assets/ships/continuum');
const ONLY = option('only', null);
// Voxels along the ship's longest side, and the gap (metres) the far body closes over.
const CELLS = Number(option('cells', 360));
const CLOSE_METRES = Number(option('close', 0.3));
const CLOSE_CANVAS_METRES = Number(option('close-canvas', 0.14));
// The far body's base, in triangles, and where its collapse stops (a closed body needs four).
const CHAIN_BASE_TRIANGLES = Number(option('chain', 8000));
const CHAIN_LEAST_TRIANGLES = 4;
// Cordage: the far body leaves it out (the clusters keep every strand).
const ROPE = new Set([2, 12, 19]);
// Canvas: the far body's second piece (see bakeFar).
const CANVAS = new Set([9, 13]);
// What a far-body vertex is, for the collapses to keep borders between: wood, canvas, iron and paint, the rest.
const materialClass = (m) => { const k = Math.floor(m); return k === 9 || k === 13 ? 1 : (k === 3 || k === 4 || k === 8 || k === 11 || k === 20 || k === 22) ? 2 : k >= 21 && k <= 26 ? 3 : 0; };
// Where a sphere's points stray outside the poses measured, this margin covers it (metres).
const SPHERE_MARGIN = 0.01;

// ------------------------------------------------------------------------------------------------ the ship
// The ship's triangles by part: each triangle's group of the assembly and its fracture shard. A vertex on a boundary
// is copied into each part that uses it, so the copies coarsen along the boundary together, as a seam. The copies are
// listed by the vertex they copy, so the GPU draws the ship's own vertices, the ones its collider and fracture use.
function splitParts(arch) {
  const V = arch.vertices.length / 9, T = arch.indices.length / 3, triGroup = new Int32Array(T).fill(-1);
  arch.groups.forEach((g, gi) => { for (let i = g.firstVertex; i < g.firstVertex + g.vertexCount; i += 3) triGroup[i / 3] = gi; });
  const shards = arch.fracture.vertexShards, keys = new Map(), triPart = new Uint32Array(T);
  for (let t = 0; t < T; t++) {
    const key = (triGroup[t] + 1) * 65536 + shards[arch.indices[t * 3]];
    if (!keys.has(key)) keys.set(key, keys.size);
    triPart[t] = keys.get(key);
  }
  const own = new Int32Array(V).fill(-1), source = Array.from({ length: V }, (_, v) => v), part = new Array(V).fill(0), copies = new Map();
  // A triangle with two corners the same draws nothing (the game drops parts it does not show that way).
  const drawn = [];
  for (let t = 0; t < T; t++) {
    const a = arch.indices[t * 3], b = arch.indices[t * 3 + 1], c = arch.indices[t * 3 + 2];
    if (a !== b && b !== c && a !== c) drawn.push(t);
  }
  const index = new Uint32Array(drawn.length * 3);
  for (let i = 0; i < drawn.length; i++) {
    const t = drawn[i], p = triPart[t];
    for (let k = 0; k < 3; k++) {
      const v = arch.indices[t * 3 + k];
      if (own[v] < 0) { own[v] = p; part[v] = p; }
      if (own[v] === p) { index[i * 3 + k] = v; continue; }
      let copy = copies.get(v * 65536 + p);
      if (copy === undefined) { copy = source.length; copies.set(v * 65536 + p, copy); source.push(v); part.push(p); }
      index[i * 3 + k] = copy;
    }
  }
  const n = source.length, s = arch.designScale;
  const design = new Float32Array(n * 3), designNormal = new Float32Array(n * 3), position = new Float32Array(n * 3), normal = new Float32Array(n * 3), uv = new Float32Array(n * 2), material = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const o = source[v] * 9;
    for (let k = 0; k < 3; k++) { design[v * 3 + k] = arch.vertices[o + k]; designNormal[v * 3 + k] = arch.vertices[o + 3 + k]; position[v * 3 + k] = arch.vertices[o + k] * s[k]; }
    const m = [arch.vertices[o + 3] / s[0], arch.vertices[o + 4] / s[1], arch.vertices[o + 5] / s[2]], l = Math.hypot(...m) || 1;
    for (let k = 0; k < 3; k++) normal[v * 3 + k] = m[k] / l;
    material[v] = arch.vertices[o + 6]; uv[v * 2] = arch.vertices[o + 7]; uv[v * 2 + 1] = arch.vertices[o + 8];
  }
  return { count: n, original: V, copies: n - V, parts: keys.size, index, drawn, part: Uint32Array.from(part), source: Uint32Array.from(source), design, designNormal, position, normal, uv, material };
}

// ------------------------------------------------------------------------------------------------ poses
// Rest; canvas half brailed and brailed; the barge's oars through eight points of their stroke; the helm hard over
// both ways. A ship whose canvas never brails (moored, or a barge) and that has no oars or helm keeps rest alone.
function posesFor(archIndex) {
  const poses = [{ time: 0, phase: 0, motion: 0, furl: 0 }];
  if (archIndex !== 1 && archIndex !== 3 && archIndex !== 4) poses.push({ time: 0, phase: 0, motion: 0, furl: 0.5 }, { time: 0, phase: 0, motion: 0, furl: 1 });
  if (archIndex === 4) for (let k = 0; k < 8; k++) poses.push({ time: (k * 2 * Math.PI) / (2.15 * 8), phase: 0, motion: 1.4, furl: 0 });
  if (archIndex === 4 || archIndex === 6) for (const turn of [0.5, 1.5]) poses.push({ time: (turn * Math.PI) / 1.45, phase: 0, motion: 1.4, furl: 0 });
  return poses;
}
// Whether a material can move at all (oars, the helm, canvas and its bolt-ropes).
const moves = (m) => { const k = Math.floor(m); return k === 16 || k === 28 || k === 9 || k === 13 || k === 19; };
// Each pose's points, in metres. `design`, `normal`, `material`, `uv` per point; `rest` the rest pose's metres.
function posePoints(archIndex, scale, poses, { count, design, designNormal, material, uv, rest }) {
  return poses.map((pose, p) => {
    if (p === 0) return rest;
    const out = rest.slice();
    for (let v = 0; v < count; v++) {
      if (!moves(material[v])) continue;
      const posed = poseTradeVesselPoint(archIndex, design.subarray(v * 3, v * 3 + 3), designNormal.subarray(v * 3, v * 3 + 3), material[v], uv.subarray(v * 2, v * 2 + 2), pose).position;
      for (let k = 0; k < 3; k++) out[v * 3 + k] = posed[k] * scale[k];
    }
    return out;
  });
}

// ------------------------------------------------------------------------------------------------ geometry
// Nearest point of a list of triangles to p, pruned by each triangle's bounding sphere. Returns the triangle's
// position in the list, with its barycentric pair in `closest`; -1 for an empty list.
function nearestTriangle(px, py, pz, list, P, spheres) {
  let best = Infinity, found = -1, bs = 0, bt = 0;
  for (let k = 0; k < list.length; k++) {
    const t = list[k], sx = spheres[t * 4] - px, sy = spheres[t * 4 + 1] - py, sz = spheres[t * 4 + 2] - pz;
    const gap = Math.sqrt(sx * sx + sy * sy + sz * sz) - spheres[t * 4 + 3];
    if (gap > 0 && gap * gap >= best) continue;
    const a = P.corners[t * 3] * 3, b = P.corners[t * 3 + 1] * 3, c = P.corners[t * 3 + 2] * 3, X = P.position;
    closestOnTriangle(px, py, pz, X[a], X[a + 1], X[a + 2], X[b], X[b + 1], X[b + 2], X[c], X[c + 1], X[c + 2]);
    if (closest[0] < best) { best = closest[0]; found = k; bs = closest[1]; bt = closest[2]; }
  }
  closest[0] = best; closest[1] = bs; closest[2] = bt;
  return found;
}
// How far apart, in the worst pose, point v of `from` and the barycentric point on triangle (a, b, c) of `to` are.
function posedGap(from, v, to, a, b, c, s, t) {
  const r = 1 - s - t;
  let worst = 0;
  for (let p = 0; p < from.length; p++) {
    const X = from[p], Y = to[p];
    const dx = X[v * 3] - (r * Y[a * 3] + s * Y[b * 3] + t * Y[c * 3]);
    const dy = X[v * 3 + 1] - (r * Y[a * 3 + 1] + s * Y[b * 3 + 1] + t * Y[c * 3 + 1]);
    const dz = X[v * 3 + 2] - (r * Y[a * 3 + 2] + s * Y[b * 3 + 2] + t * Y[c * 3 + 2]);
    worst = Math.max(worst, dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(worst);
}
function posedTriangleGap(posed, from, to) {
  let worst = 0;
  for (const X of posed) {
    let dx = 0, dy = 0, dz = 0;
    for (const [[a, b, c], s, t, sign] of [[from[0], from[1], from[2], 1], [to[0], to[1], to[2], -1]]) {
      const r = 1 - s - t;
      dx += sign * (r * X[a * 3] + s * X[b * 3] + t * X[c * 3]);
      dy += sign * (r * X[a * 3 + 1] + s * X[b * 3 + 1] + t * X[c * 3 + 1]);
      dz += sign * (r * X[a * 3 + 2] + s * X[b * 3 + 2] + t * X[c * 3 + 2]);
    }
    worst = Math.max(worst, dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(worst);
}
// The nearest of a set of points to p, by a uniform grid of cells `cell` metres wide.
function pointGrid(position, members, cell) {
  const buckets = new Map(), key = (x, y, z) => ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096);
  for (const v of members) {
    const k = key(Math.floor(position[v * 3] / cell), Math.floor(position[v * 3 + 1] / cell), Math.floor(position[v * 3 + 2] / cell));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(v);
  }
  return (px, py, pz) => {
    const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
    let best = -1, bestD = Infinity;
    for (let ring = 0; ring < 4096; ring++) {
      if (best >= 0 && (ring - 1) * cell > Math.sqrt(bestD)) break;
      for (let x = cx - ring; x <= cx + ring; x++) for (let y = cy - ring; y <= cy + ring; y++) for (let z = cz - ring; z <= cz + ring; z++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== ring) continue;
        for (const v of buckets.get(key(x, y, z)) ?? []) {
          const d = (position[v * 3] - px) ** 2 + (position[v * 3 + 1] - py) ** 2 + (position[v * 3 + 2] - pz) ** 2;
          if (d < bestD) { bestD = d; best = v; }
        }
      }
    }
    return best;
  };
}

// ------------------------------------------------------------------------------------------------ clusters
// The builder's group error, measured posed: each point a group removes is matched, at rest, to its nearest point on
// what the group keeps of the same part, and the error is the farthest those two come apart in any pose.
function posedGroupError(body, posed) {
  const kept = new Int32Array(body.count).fill(-1), seen = new Int32Array(body.count).fill(-1), P = { position: body.position, corners: null };
  let stamp = 0;
  return (children, simplified, error) => {
    stamp++;
    const count = simplified.length / 3;
    if (!count) return error;
    for (const v of simplified) kept[v] = stamp;
    const byPart = new Map(), every = Array.from({ length: count }, (_, t) => t);
    for (let t = 0; t < count; t++) {
      const p = body.part[simplified[t * 3]];
      if (!byPart.has(p)) byPart.set(p, []);
      byPart.get(p).push(t);
    }
    P.corners = simplified;
    const spheres = triangleSpheres(body.position, simplified, every);
    let worst = 0;
    for (const v of children) {
      if (kept[v] === stamp || seen[v] === stamp) continue;
      seen[v] = stamp;
      const list = byPart.get(body.part[v]) ?? every;
      const k = nearestTriangle(body.position[v * 3], body.position[v * 3 + 1], body.position[v * 3 + 2], list, P, spheres);
      const t = list[k];
      worst = Math.max(worst, posedGap(posed, v, posed, simplified[t * 3], simplified[t * 3 + 1], simplified[t * 3 + 2], closest[1], closest[2]));
    }
    return Math.max(worst, error);
  };
}
// The radius about `centre` that holds `vertices` in every pose.
function posedReach(posed, vertices, centre) {
  let r = 0;
  const slack = posed.slack;
  for (const X of posed) for (const v of vertices) r = Math.max(r, Math.hypot(X[v * 3] - centre[0], X[v * 3 + 1] - centre[1], X[v * 3 + 2] - centre[2]) + (slack ? slack[v] : 0));
  return r;
}

async function bakeClusters(body, posed) {
  const dag = await buildDag({
    id: 0, bark: { pos: body.position, nrm: body.normal, uv: body.uv, idx: body.index },
    leaves: { pos: new Float32Array(0), nrm: new Float32Array(0), uv: new Float32Array(0), vpl: 8 },
    barkParts: body.part, barkGroupError: posedGroupError(body, posed),
  });
  const count = dag.meta.length / 4;
  const verticesOf = (c) => new Set(dag.idx.subarray(dag.meta[c * 4], dag.meta[c * 4] + dag.meta[c * 4 + 1] * 3));
  let groupCount = 0;
  for (let c = 0; c < count; c++) groupCount = Math.max(groupCount, dag.groups[c * 2] + 1, dag.groups[c * 2 + 1] + 1);
  const children = Array.from({ length: groupCount }, () => []);
  for (let c = 0; c < count; c++) if (dag.groups[c * 2 + 1] >= 0) children[dag.groups[c * 2 + 1]].push(c);
  // Each group's sphere, grown to hold its points in every pose and every child group's sphere, so a coarser level
  // is never projected finer than the level it replaces. Groups are made finest first.
  const groupCentre = (g) => Array.from(dag.rec.subarray(children[g][0] * 16 + 4, children[g][0] * 16 + 7)), groupRadius = new Float64Array(groupCount);
  for (let g = 0; g < groupCount; g++) {
    if (!children[g].length) continue;
    const vertices = new Set(), centre = groupCentre(g);
    for (const c of children[g]) for (const v of verticesOf(c)) vertices.add(v);
    groupRadius[g] = Math.max(dag.rec[children[g][0] * 16 + 7], posedReach(posed, vertices, centre) + SPHERE_MARGIN);
    for (const c of children[g]) {
      const own = dag.groups[c * 2];
      if (own < 0) continue;
      if (own >= g) throw Error(`Group ${g} is made before its child group ${own}`);
      const o = groupCentre(own);
      groupRadius[g] = Math.max(groupRadius[g], Math.hypot(centre[0] - o[0], centre[1] - o[1], centre[2] - o[2]) + groupRadius[own]);
    }
  }
  const records = [];
  for (let c = 0; c < count; c++) {
    const r = dag.rec.subarray(c * 16, c * 16 + 16), own = dag.groups[c * 2], parent = dag.groups[c * 2 + 1];
    const cullCentre = [r[8], r[9], r[10]], cull = [...cullCentre, Math.max(r[11], posedReach(posed, verticesOf(c), cullCentre) + SPHERE_MARGIN)];
    const lod = own >= 0 ? [...groupCentre(own), groupRadius[own]] : cull;
    records.push({
      cluster: c, lod, parentLod: parent >= 0 ? [...groupCentre(parent), groupRadius[parent]] : lod, cull,
      error: r[12], parentError: parent >= 0 ? r[13] : Infinity, level: dag.meta[c * 4 + 2],
    });
  }
  // Coarsest parent first: what an instance can draw at its nearest point is then a prefix.
  records.sort((p, q) => q.parentError - p.parentError || q.error - p.error);
  const indices = new Uint32Array(dag.idx.length), clusters = new Uint32Array(count * SHIP_CONTINUUM_CLUSTER_WORDS);
  let first = 0, triangles = 0, rootError = 0;
  records.forEach((record, k) => {
    const at = dag.meta[record.cluster * 4], tris = dag.meta[record.cluster * 4 + 1];
    if (tris > 128) throw Error(`A cluster holds ${tris} triangles`);
    indices.set(dag.idx.subarray(at, at + tris * 3), first);
    clusters.set(packShipContinuumCluster({ ...record, first, triangles: tris }), k * SHIP_CONTINUUM_CLUSTER_WORDS);
    first += tris * 3;
    triangles += tris;
    if (record.parentError === Infinity) rootError = Math.max(rootError, record.error);
  });
  return { indices, clusters, count, triangles, groupCount, levels: dag.stats.barkLevels, roots: dag.stats.barkRoots, rootError };
}

// ------------------------------------------------------------------------------------------------ far body
// The ship as voxels `h` metres wide: every triangle but the cordage's, closed over gaps of `close` cells and filled
// within, each piece of fewer than `least` voxels dropped.
function voxelize(arch, keep, h, close, least) {
  const s = arch.designScale, V = arch.vertices.length / 9, P = new Float64Array(V * 3);
  for (let v = 0; v < V; v++) for (let k = 0; k < 3; k++) P[v * 3 + k] = arch.vertices[v * 9 + k] * s[k];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of keep) for (let c = 0; c < 3; c++) { const v = arch.indices[t * 3 + c]; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[v * 3 + k]); hi[k] = Math.max(hi[k], P[v * 3 + k]); } }
  const pad = close + 2, origin = lo.map((l) => l - pad * h), dims = [0, 1, 2].map((k) => Math.ceil((hi[k] - lo[k]) / h) + 2 * pad + 1);
  const [nx, ny, nz] = dims, N = nx * ny * nz, surface = new Uint8Array(N);
  const cellOf = (x, y, z) => Math.floor((x - origin[0]) / h) + nx * (Math.floor((y - origin[1]) / h) + ny * Math.floor((z - origin[2]) / h));
  for (const t of keep) {
    const [a, b, c] = [0, 1, 2].map((k) => arch.indices[t * 3 + k] * 3);
    const longest = Math.max(Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]), Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]), Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]));
    const n = Math.max(1, Math.ceil(longest / (h / 3)));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, w = j / n, r = 1 - u - w;
      surface[cellOf(r * P[a] + u * P[b] + w * P[c], r * P[a + 1] + u * P[b + 1] + w * P[c + 1], r * P[a + 2] + u * P[b + 2] + w * P[c + 2])] = 1;
    }
  }
  const strides = [1, nx, nx * ny];
  // A cube's dilation, an axis at a time, by a running count over each line.
  const dilate = (src, r) => {
    let a = src.slice(), b = new Uint8Array(N);
    if (r <= 0) return a;
    for (let axis = 0; axis < 3; axis++) {
      const len = dims[axis], stride = strides[axis], [u, w] = [0, 1, 2].filter((k) => k !== axis);
      for (let j = 0; j < dims[w]; j++) for (let i = 0; i < dims[u]; i++) {
        const start = i * strides[u] + j * strides[w];
        let count = 0;
        for (let k = 0; k < Math.min(r, len); k++) count += a[start + k * stride];
        for (let k = 0; k < len; k++) {
          if (k + r < len) count += a[start + (k + r) * stride];
          if (k - r - 1 >= 0) count -= a[start + (k - r - 1) * stride];
          b[start + k * stride] = count > 0 ? 1 : 0;
        }
      }
      [a, b] = [b, a];
    }
    return a;
  };
  const grown = dilate(surface, close), outside = new Uint8Array(N), queue = new Int32Array(N);
  let head = 0, tail = 0;
  const reach = (i) => { if (!grown[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) reach(x + nx * (y + ny * z));
  while (head < tail) {
    const i = queue[head++], x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    if (x > 0) reach(i - 1); if (x < nx - 1) reach(i + 1);
    if (y > 0) reach(i - nx); if (y < ny - 1) reach(i + nx);
    if (z > 0) reach(i - nx * ny); if (z < nz - 1) reach(i + nx * ny);
  }
  // Closing: what the grown outside does not reach, with every surface voxel kept and grown by one, so a sheet
  // is three voxels thick and never touches itself only across a corner (which would open a handle in it).
  const away = dilate(outside, close), thick = dilate(surface, 1), solid = new Uint8Array(N);
  for (let i = 0; i < N; i++) solid[i] = !away[i] || thick[i] ? 1 : 0;
  // Pieces: 6-connected; the small ones go.
  const label = new Int32Array(N).fill(-1), sizes = [];
  for (let start = 0; start < N; start++) {
    if (!solid[start] || label[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    head = tail = 0;
    label[start] = id; queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++], x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      size++;
      for (const [ok, j] of [[x > 0, i - 1], [x < nx - 1, i + 1], [y > 0, i - nx], [y < ny - 1, i + nx], [z > 0, i - nx * ny], [z < nz - 1, i + nx * ny]]) {
        if (ok && solid[j] && label[j] < 0) { label[j] = id; queue[tail++] = j; }
      }
    }
    sizes.push(size);
  }
  let dropped = 0;
  for (let i = 0; i < N; i++) if (solid[i] && sizes[label[i]] < least) { solid[i] = 0; dropped++; }
  const kept = sizes.filter((n) => n >= least).length;
  return { solid, away, dims, origin, h, pieces: kept, droppedPieces: sizes.length - kept, droppedVoxels: dropped };
}
// The solid's surface by marching tetrahedra over the voxel centres, each cube cut into the six tetrahedra about its
// main diagonal (Kuhn's), the same in every cube, so the surface is closed and every edge has two triangles.
function marchingTetrahedra({ solid, dims, origin, h }) {
  const [nx, ny] = dims, sxy = nx * ny, offsets = [0, 1, nx, nx + 1, sxy, sxy + 1, sxy + nx, sxy + nx + 1];
  const tets = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map(([a, b]) => [0, 1 << a, (1 << a) | (1 << b), 7]);
  const vertexOf = new Map(), position = [], index = [];
  const at = (i) => [origin[0] + ((i % nx) + 0.5) * h, origin[1] + ((Math.floor(i / nx) % ny) + 0.5) * h, origin[2] + (Math.floor(i / sxy) + 0.5) * h];
  // The vertex halfway along the edge from corner ca to corner cb (ca's bits a subset of cb's) of the cube at `base`.
  const edge = (base, ca, cb) => {
    const lowCorner = (ca & cb) === ca ? ca : cb, high = lowCorner === ca ? cb : ca, i = base + offsets[lowCorner], key = i * 8 + (high ^ lowCorner);
    let v = vertexOf.get(key);
    if (v === undefined) {
      const p = at(i), q = at(base + offsets[high]);
      v = position.length / 3;
      position.push((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2);
      vertexOf.set(key, v);
    }
    return v;
  };
  const emit = (a, b, c, inward, outward) => {
    const P = position, e = [0, 1, 2].map((k) => P[b * 3 + k] - P[a * 3 + k]), f = [0, 1, 2].map((k) => P[c * 3 + k] - P[a * 3 + k]);
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
    const g = [0, 1, 2].map((k) => outward[k] - inward[k]);
    if (n[0] * g[0] + n[1] * g[1] + n[2] * g[2] >= 0) index.push(a, b, c); else index.push(a, c, b);
  };
  const corner = (base, c) => at(base + offsets[c]);
  for (let z = 0; z < dims[2] - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const base = x + nx * (y + ny * z);
    let mask = 0;
    for (let c = 0; c < 8; c++) if (solid[base + offsets[c]]) mask |= 1 << c;
    if (mask === 0 || mask === 255) continue;
    for (const tet of tets) {
      const inside = tet.filter((c) => mask & (1 << c)), outside = tet.filter((c) => !(mask & (1 << c)));
      if (!inside.length || !outside.length) continue;
      const mean = (cs) => { const s = [0, 0, 0]; for (const c of cs) { const p = corner(base, c); for (let k = 0; k < 3; k++) s[k] += p[k] / cs.length; } return s; };
      const inward = mean(inside), outward = mean(outside);
      if (inside.length === 1) emit(edge(base, inside[0], outside[0]), edge(base, inside[0], outside[1]), edge(base, inside[0], outside[2]), inward, outward);
      else if (outside.length === 1) emit(edge(base, outside[0], inside[0]), edge(base, outside[0], inside[1]), edge(base, outside[0], inside[2]), inward, outward);
      else {
        const [i0, i1] = inside, [o0, o1] = outside, A = edge(base, i0, o0), B = edge(base, i0, o1), C = edge(base, i1, o1), D = edge(base, i1, o0);
        emit(A, B, C, inward, outward);
        emit(A, C, D, inward, outward);
      }
    }
  }
  return { position: Float32Array.from(position), index: Uint32Array.from(index) };
}
function edgeCensus(index) {
  const edges = new Map();
  for (let t = 0; t < index.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = index[t + k], b = index[t + ((k + 1) % 3)], key = a < b ? a * 16777216 + b : b * 16777216 + a;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  let boundary = 0, nonManifold = 0;
  for (const n of edges.values()) { if (n === 1) boundary++; if (n > 2) nonManifold++; }
  const vertices = new Set(index).size;
  return { edges: edges.size, boundary, nonManifold, euler: vertices - edges.size + index.length / 3 };
}

// Half-edge collapses, cheapest first by quadric error (Garland and Heckbert), each vertex moving onto a neighbour
// so every survivor keeps its own place, colour and the ship vertex it rides. A collapse that would pinch the
// surface (the link condition) or fold a triangle over is refused, and one across a border of class costs six times.
// `fold(living)` is the least cosine a triangle may turn through. Stops at `least` triangles.
function collapseSurface(position, index, region, least, fold) {
  const V = position.length / 3, T = index.length / 3, corners = Int32Array.from(index), alive = new Uint8Array(T).fill(1), death = new Int32Array(T).fill(-1);
  const Q = new Float64Array(V * 10), fans = Array.from({ length: V }, () => []);
  for (let t = 0; t < T; t++) {
    const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3;
    const ex = position[b] - position[a], ey = position[b + 1] - position[a + 1], ez = position[b + 2] - position[a + 2];
    const fx = position[c] - position[a], fy = position[c + 1] - position[a + 1], fz = position[c + 2] - position[a + 2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz) || 1e-12, w = l / 2;
    nx /= l; ny /= l; nz /= l;
    const d = -(nx * position[a] + ny * position[a + 1] + nz * position[a + 2]);
    for (let k = 0; k < 3; k++) {
      const v = corners[t * 3 + k], o = v * 10;
      Q[o] += w * nx * nx; Q[o + 1] += w * nx * ny; Q[o + 2] += w * nx * nz; Q[o + 3] += w * nx * d; Q[o + 4] += w * ny * ny;
      Q[o + 5] += w * ny * nz; Q[o + 6] += w * ny * d; Q[o + 7] += w * nz * nz; Q[o + 8] += w * nz * d; Q[o + 9] += w * d * d;
      fans[v].push(t);
    }
  }
  const cost = (u, v) => {
    const x = position[v * 3], y = position[v * 3 + 1], z = position[v * 3 + 2], a = u * 10, b = v * 10, q = (k) => Q[a + k] + Q[b + k];
    const e = q(0) * x * x + 2 * q(1) * x * y + 2 * q(2) * x * z + 2 * q(3) * x + q(4) * y * y + 2 * q(5) * y * z + 2 * q(6) * y + q(7) * z * z + 2 * q(8) * z + q(9);
    const l2 = (position[u * 3] - x) ** 2 + (position[u * 3 + 1] - y) ** 2 + (position[u * 3 + 2] - z) ** 2;
    return (Math.max(0, e) + 1e-4 * l2 * l2) * (region[u] === region[v] ? 1 : 6);
  };
  // A vertex's ring, into `out`, its dead triangles dropped from its fan as it goes; `mark` stamped with `tick`.
  const markA = new Int32Array(V), markB = new Int32Array(V);
  let tick = 0;
  const ring = (v, out, mark) => {
    tick++;
    out.length = 0;
    const fan = fans[v];
    let n = 0;
    for (let i = 0; i < fan.length; i++) {
      const t = fan[i];
      if (!alive[t]) continue;
      fan[n++] = t;
      for (let k = 0; k < 3; k++) { const c = corners[t * 3 + k]; if (c !== v && mark[c] !== tick) { mark[c] = tick; out.push(c); } }
    }
    fan.length = n;
    return tick;
  };
  const ringU = [], ringV = [], scratch = [];
  let living = T;
  const turn = (a, b, c, u, v) => {
    const P = position, A = (a === u ? v : a) * 3, B = (b === u ? v : b) * 3, C = (c === u ? v : c) * 3, a3 = a * 3, b3 = b * 3, c3 = c * 3;
    const ex = P[b3] - P[a3], ey = P[b3 + 1] - P[a3 + 1], ez = P[b3 + 2] - P[a3 + 2], fx = P[c3] - P[a3], fy = P[c3 + 1] - P[a3 + 1], fz = P[c3 + 2] - P[a3 + 2];
    const gx = P[B] - P[A], gy = P[B + 1] - P[A + 1], gz = P[B + 2] - P[A + 2], hx = P[C] - P[A], hy = P[C + 1] - P[A + 1], hz = P[C + 2] - P[A + 2];
    const n0 = [ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx], n1 = [gy * hz - gz * hy, gz * hx - gx * hz, gx * hy - gy * hx];
    const l0 = Math.hypot(...n0), l1 = Math.hypot(...n1);
    if (l1 < 1e-12) return -2;
    return l0 < 1e-12 ? 1 : (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1);
  };
  const valid = (u, v) => {
    const tu = ring(u, ringU, markA);
    ring(v, ringV, markB);
    let shared = 0, common = 0;
    for (const t of fans[u]) if (corners[t * 3] === v || corners[t * 3 + 1] === v || corners[t * 3 + 2] === v) shared++;
    for (const w of ringV) if (w !== u && markA[w] === tu) common++;
    if (shared !== 2 || common !== 2) return false;
    // A tetrahedron is the least a closed piece can be.
    if (ringU.length === 3 && ringV.length === 3) return false;
    const least = fold(living);
    for (const t of fans[u]) {
      const a = corners[t * 3], b = corners[t * 3 + 1], c = corners[t * 3 + 2];
      if (a === v || b === v || c === v) continue;
      if (turn(a, b, c, u, v) < least) return false;
    }
    return true;
  };
  // A binary heap of (cost, u, v, u's stamp) in typed arrays.
  let hc = new Float64Array(1 << 16), hu = new Int32Array(1 << 16), hv = new Int32Array(1 << 16), hs = new Int32Array(1 << 16), hn = 0;
  const push = (c, u, v, s) => {
    if (hn === hc.length) {
      const grow = (a) => { const b = new a.constructor(a.length * 2); b.set(a); return b; };
      hc = grow(hc); hu = grow(hu); hv = grow(hv); hs = grow(hs);
    }
    let i = hn++;
    while (i > 0) { const j = (i - 1) >> 1; if (hc[j] <= c) break; hc[i] = hc[j]; hu[i] = hu[j]; hv[i] = hv[j]; hs[i] = hs[j]; i = j; }
    hc[i] = c; hu[i] = u; hv[i] = v; hs[i] = s;
  };
  let topU = 0, topV = 0, topS = 0;
  const pop = () => {
    topU = hu[0]; topV = hv[0]; topS = hs[0];
    const n = --hn, c = hc[n], u = hu[n], v = hv[n], s = hs[n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = -1, mc = c;
      if (l < n && hc[l] < mc) { m = l; mc = hc[l]; }
      if (r < n && hc[r] < mc) { m = r; mc = hc[r]; }
      if (m < 0) break;
      hc[i] = hc[m]; hu[i] = hu[m]; hv[i] = hv[m]; hs[i] = hs[m]; i = m;
    }
    hc[i] = c; hu[i] = u; hv[i] = v; hs[i] = s;
  };
  const stamp = new Int32Array(V), dieStep = new Int32Array(V).fill(-1), target = new Int32Array(V).fill(-1);
  // Each vertex offers its cheapest collapse; a refused one makes way for its next cheapest that is allowed.
  const offer = (u) => {
    ring(u, scratch, markA);
    let best = Infinity, to = -1;
    for (const w of scratch) { const c = cost(u, w); if (c < best) { best = c; to = w; } }
    if (to >= 0) push(best, u, to, stamp[u]);
  };
  const offerAllowed = (u, refused) => {
    ring(u, scratch, markA);
    const options = scratch.filter((w) => w !== refused).map((w) => [cost(u, w), w]).sort((p, q) => p[0] - q[0]);
    for (const [c, w] of options) if (valid(u, w)) { push(c, u, w, stamp[u]); return; }
  };
  for (let v = 0; v < V; v++) offer(v);
  let steps = 0;
  const neighbours = [];
  while (living > least && hn) {
    pop();
    const u = topU, v = topV;
    if (topS !== stamp[u] || dieStep[u] >= 0 || dieStep[v] >= 0) continue;
    if (!valid(u, v)) { offerAllowed(u, v); continue; }
    const step = steps++;
    dieStep[u] = step; target[u] = v;
    for (const t of fans[u]) {
      if (!alive[t]) continue;
      if (corners[t * 3] === v || corners[t * 3 + 1] === v || corners[t * 3 + 2] === v) { alive[t] = 0; death[t] = step + 1; living--; continue; }
      for (let k = 0; k < 3; k++) if (corners[t * 3 + k] === u) corners[t * 3 + k] = v;
      fans[v].push(t);
    }
    fans[u].length = 0;
    for (let k = 0; k < 10; k++) Q[v * 10 + k] += Q[u * 10 + k];
    ring(v, neighbours, markB);
    const around = neighbours.slice();
    stamp[v]++;
    for (const w of around) stamp[w]++;
    offer(v);
    for (const w of around) offer(w);
  }
  return { dieStep, target, death, corners, alive, steps, living };
}
// Uniform Taubin smoothing (lambda 0.5, mu -0.53): takes the voxel lattice's steps off a closed surface without
// shrinking it.
function taubin(position, index, rounds) {
  const V = position.length / 3, count = new Int32Array(V + 1);
  for (let i = 0; i < index.length; i++) count[index[i] + 1]++;
  for (let v = 0; v < V; v++) count[v + 1] += count[v];
  const fill = count.slice(0, V), next = new Int32Array(index.length);
  // Each half-edge a -> b gives a its neighbour b; on a closed surface, each neighbour once.
  for (let t = 0; t < index.length; t += 3) for (let k = 0; k < 3; k++) next[fill[index[t + k]]++] = index[t + ((k + 1) % 3)];
  const out = Float32Array.from(position), mean = new Float32Array(V * 3);
  for (let r = 0; r < rounds * 2; r++) {
    const f = r % 2 ? -0.53 : 0.5;
    mean.fill(0);
    for (let v = 0; v < V; v++) {
      const n = count[v + 1] - count[v];
      if (!n) continue;
      for (let i = count[v]; i < count[v + 1]; i++) for (let k = 0; k < 3; k++) mean[v * 3 + k] += out[next[i] * 3 + k] / n;
    }
    for (let v = 0; v < V; v++) if (count[v + 1] > count[v]) for (let k = 0; k < 3; k++) out[v * 3 + k] += f * (mean[v * 3 + k] - out[v * 3 + k]);
  }
  return out;
}
// The nearest of a set of triangles to a point, by a uniform grid of cells `cell` metres wide over their bounds.
// Returns the triangle's position in `triangles` (-1 for none), with its barycentric pair in `closest`.
function triangleGrid(position, corners, triangles, cell) {
  const buckets = new Map(), key = (x, y, z) => ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096), seen = new Int32Array(triangles.length);
  let query = 0;
  triangles.forEach((t, k) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 3; c++) for (let a = 0; a < 3; a++) { const x = position[corners[t * 3 + c] * 3 + a]; lo[a] = Math.min(lo[a], x); hi[a] = Math.max(hi[a], x); }
    for (let x = Math.floor(lo[0] / cell); x <= Math.floor(hi[0] / cell); x++) for (let y = Math.floor(lo[1] / cell); y <= Math.floor(hi[1] / cell); y++) for (let z = Math.floor(lo[2] / cell); z <= Math.floor(hi[2] / cell); z++) {
      const at = key(x, y, z);
      if (!buckets.has(at)) buckets.set(at, []);
      buckets.get(at).push(k);
    }
  });
  return (px, py, pz) => {
    query++;
    const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
    let best = Infinity, found = -1, bs = 0, bt = 0;
    for (let r = 0; r < 512; r++) {
      if (found >= 0 && (r - 1) * cell > Math.sqrt(best)) break;
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== r) continue;
        for (const k of buckets.get(key(x, y, z)) ?? []) {
          if (seen[k] === query) continue;
          seen[k] = query;
          const t = triangles[k], a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3, X = position;
          closestOnTriangle(px, py, pz, X[a], X[a + 1], X[a + 2], X[b], X[b + 1], X[b + 2], X[c], X[c + 1], X[c + 2]);
          if (closest[0] < best) { best = closest[0]; found = k; bs = closest[1]; bt = closest[2]; }
        }
      }
    }
    closest[0] = best; closest[1] = bs; closest[2] = bt;
    return found;
  };
}

// The outline a mesh casts, end on and side on, on a grid over the ship: each pixel's nearest triangle (-1 where none).
function outline(position, normal, corners, triangles, inflate, frame) {
  const { low, size, cells } = frame, views = [[0, 1, 2], [2, 1, 0]], result = [];
  for (const [ax, ay, az] of views) {
    const depth = new Float32Array(cells * cells).fill(Infinity), nearest = new Int32Array(cells * cells).fill(-1);
    for (const t of triangles) {
      const v = [0, 1, 2].map((k) => corners[t * 3 + k]);
      const x = v.map((w) => ((position[w * 3 + ax] + normal[w * 3 + ax] * inflate - low[ax]) / size) * cells);
      const y = v.map((w) => ((position[w * 3 + ay] + normal[w * 3 + ay] * inflate - low[ay]) / size) * cells);
      const z = v.map((w) => position[w * 3 + az]);
      const area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]);
      if (Math.abs(area) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(...x))), x1 = Math.min(cells - 1, Math.ceil(Math.max(...x))), y0 = Math.max(0, Math.floor(Math.min(...y))), y1 = Math.min(cells - 1, Math.ceil(Math.max(...y)));
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5, cy = py + 0.5, w0 = ((x[1] - cx) * (y[2] - cy) - (x[2] - cx) * (y[1] - cy)) / area, w1 = ((x[2] - cx) * (y[0] - cy) - (x[0] - cx) * (y[2] - cy)) / area, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * z[0] + w1 * z[1] + w2 * z[2], at = py * cells + px;
        if (d < depth[at]) { depth[at] = d; nearest[at] = t; }
      }
    }
    let covered = 0;
    for (const t of nearest) if (t >= 0) covered++;
    result.push({ covered, nearest });
  }
  return result;
}
// Vertex colours blur what lies within half their spacing, which counts as error too.
const appearance = (area, vertices) => 0.5 * Math.sqrt(area / Math.max(vertices, 1));

function bakeFar(arch, body, poses, lap) {
  const archIndex = arch.index, s = arch.designScale, V0 = arch.vertices.length / 9;
  // The far body's pieces: what is rigid, and the canvas, which brails up its yard. Each piece rides only ship
  // vertices of its own kind, so canvas going aloft never drags the hull or a mast with it.
  const kindOf = (t) => { const m = Math.floor(arch.vertices[arch.indices[t * 3] * 9 + 6]); return ROPE.has(m) ? -1 : CANVAS.has(m) ? 1 : 0; };
  const keep = [[], []];
  for (const t of body.drawn) { const k = kindOf(t); if (k >= 0) keep[k].push(t); }
  // The voxels: CELLS along the longest side of the ship.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < V0; v++) for (let k = 0; k < 3; k++) { const x = arch.vertices[v * 9 + k] * s[k]; lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x); }
  const h = Math.max(...hi.map((x, k) => x - lo[k])) / CELLS, pieces = [];
  const merged = { position: [], index: [], kind: [] };
  for (const kind of [0, 1]) {
    if (!keep[kind].length) continue;
    const close = Math.max(1, Math.round((kind ? CLOSE_CANVAS_METRES : CLOSE_METRES) / h));
    const voxels = voxelize(arch, keep[kind], h, close, 27);
    const surface = marchingTetrahedra(voxels);
    const census = edgeCensus(surface.index);
    if (census.boundary || census.nonManifold) throw Error(`The voxel surface is open: ${JSON.stringify(census)}`);
    const at = merged.position.length / 3;
    for (const x of surface.position) merged.position.push(x);
    for (const v of surface.index) merged.index.push(v + at);
    for (let v = 0; v < surface.position.length / 3; v++) merged.kind.push(kind);
    pieces.push({ kind, voxels, close: close * h, count: voxels.pieces, genus: (2 * voxels.pieces - census.euler) / 2, surface: surface.index.length / 3 });
    lap(`${kind ? 'canvas' : 'rigid'}: voxels ${voxels.dims.join('x')} at ${(h * 100).toFixed(1)} cm closed over ${(close * h * 100).toFixed(0)} cm, ${voxels.pieces} pieces of genus ${(2 * voxels.pieces - census.euler) / 2} in all, ${surface.index.length / 3} triangles`);
  }
  const surfaceIndex = Uint32Array.from(merged.index), smooth = taubin(Float32Array.from(merged.position), surfaceIndex, 8);
  // The base: the surface collapsed to CHAIN_BASE_TRIANGLES, no triangle turned more than sixty degrees.
  const reduced = collapseSurface(smooth, surfaceIndex, Uint8Array.from(merged.kind), CHAIN_BASE_TRIANGLES, () => 0.5), simplified = [];
  for (let t = 0; t < reduced.alive.length; t++) if (reduced.alive[t]) simplified.push(reduced.corners[t * 3], reduced.corners[t * 3 + 1], reduced.corners[t * 3 + 2]);
  const used = [...new Set(simplified)], local = new Map(used.map((v, i) => [v, i])), V = used.length, T = simplified.length / 3;
  const index = Uint32Array.from(simplified, (v) => local.get(v)), position = new Float32Array(V * 3), kindOfBase = Uint8Array.from(used, (v) => merged.kind[v]);
  used.forEach((v, i) => position.set(smooth.subarray(v * 3, v * 3 + 3), i * 3));
  const census = edgeCensus(index);
  if (census.boundary || census.nonManifold) throw Error(`The far body's base is open: ${JSON.stringify(census)}`);
  // Normals: area weighted, in metres.
  const normal = new Float32Array(V * 3);
  for (let t = 0; t < T; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => index[t * 3 + k]), e = [0, 1, 2].map((k) => position[b * 3 + k] - position[a * 3 + k]), f = [0, 1, 2].map((k) => position[c * 3 + k] - position[a * 3 + k]);
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normal[v * 3 + k] += n[k];
  }
  for (let v = 0; v < V; v++) { const l = Math.hypot(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]) || 1; for (let k = 0; k < 3; k++) normal[v * 3 + k] /= l; }
  lap(`base ${T} triangles`);

  // Each base vertex rides the nearest ship vertex of its own kind, and takes the mean colour of the ship's surface
  // of its kind nearest it (each triangle given to the base vertex of its kind nearest its middle, by area).
  const shipVertices = [[], []], baseVertices = [[], []], baseTriangles = [[], []];
  for (const kind of [0, 1]) {
    const referenced = new Uint8Array(V0);
    for (const t of keep[kind]) for (let k = 0; k < 3; k++) referenced[arch.indices[t * 3 + k]] = 1;
    for (let v = 0; v < V0; v++) if (referenced[v]) shipVertices[kind].push(v);
  }
  for (let i = 0; i < V; i++) baseVertices[kindOfBase[i]].push(i);
  for (let t = 0; t < T; t++) baseTriangles[kindOfBase[index[t * 3]]].push(t);
  const rides = new Uint32Array(V), sums = new Float64Array(V * 4), classes = new Float64Array(V * 4);
  for (const kind of [0, 1]) {
    if (!baseVertices[kind].length) continue;
    const nearestShip = pointGrid(body.position, shipVertices[kind], 0.25), nearestBase = pointGrid(position, baseVertices[kind], 0.25);
    for (const i of baseVertices[kind]) rides[i] = nearestShip(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
    for (const t of keep[kind]) {
      const [a, b, c] = [0, 1, 2].map((k) => arch.indices[t * 3 + k]), X = body.position;
      const e = [0, 1, 2].map((k) => X[b * 3 + k] - X[a * 3 + k]), f = [0, 1, 2].map((k) => X[c * 3 + k] - X[a * 3 + k]);
      const area = 0.5 * Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]);
      if (!(area > 0)) continue;
      const i = nearestBase((X[a * 3] + X[b * 3] + X[c * 3]) / 3, (X[a * 3 + 1] + X[b * 3 + 1] + X[c * 3 + 1]) / 3, (X[a * 3 + 2] + X[b * 3 + 2] + X[c * 3 + 2]) / 3);
      const m = body.material[a], colour = tradeMaterialLinearColor(m);
      for (let k = 0; k < 3; k++) sums[i * 4 + k] += area * colour[k];
      sums[i * 4 + 3] += area;
      classes[i * 4 + materialClass(m)] += area;
    }
  }
  const colour = new Float32Array(V * 3), region = new Uint8Array(V);
  for (let i = 0; i < V; i++) {
    const fallback = tradeMaterialLinearColor(body.material[rides[i]]);
    for (let k = 0; k < 3; k++) colour[i * 3 + k] = sums[i * 4 + 3] > 0 ? sums[i * 4 + k] / sums[i * 4 + 3] : fallback[k];
    let best = materialClass(body.material[rides[i]]);
    for (let k = 0; k < 4; k++) if (classes[i * 4 + k] > classes[i * 4 + best]) best = k;
    region[i] = best;
  }
  // The base in design units, and posed: each base vertex moves as the ship vertex it rides would, standing where it does.
  const design = new Float32Array(V * 3), designNormal = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    const n = [0, 1, 2].map((k) => normal[i * 3 + k] * s[k]), l = Math.hypot(...n) || 1;
    for (let k = 0; k < 3; k++) { design[i * 3 + k] = position[i * 3 + k] / s[k]; designNormal[i * 3 + k] = n[k] / l; }
  }
  const baseMaterial = Float32Array.from(rides, (v) => body.material[v]), baseUV = new Float32Array(V * 2);
  rides.forEach((v, i) => { baseUV[i * 2] = body.uv[v * 2]; baseUV[i * 2 + 1] = body.uv[v * 2 + 1]; });
  const chainPosed = posePoints(archIndex, s, poses, { count: V, design, designNormal, material: baseMaterial, uv: baseUV, rest: position });
  lap('rides');

  // The base's own error against the ship, posed: each ship point of a kind (not cordage) matched at rest to its
  // nearest base triangle of that kind. A point the closing buried deeper than its own radius cannot be seen from
  // outside the ship, and is not counted.
  const allBase = Array.from({ length: T }, (_, t) => t), P = { position, corners: index }, spheres = triangleSpheres(position, index, allBase);
  const shipPosed = body.posed;
  let geometric = 0, buried = 0;
  for (const piece of pieces) {
    const { voxels } = piece, [nx, ny] = voxels.dims, list = baseTriangles[piece.kind], nearestOnBase = triangleGrid(position, index, list, 0.5);
    for (const v of shipVertices[piece.kind]) {
      const x = body.position[v * 3], y = body.position[v * 3 + 1], z = body.position[v * 3 + 2];
      const cell = Math.floor((x - voxels.origin[0]) / voxels.h) + nx * (Math.floor((y - voxels.origin[1]) / voxels.h) + ny * Math.floor((z - voxels.origin[2]) / voxels.h));
      if (voxels.solid[cell] && !voxels.away[cell]) { buried++; continue; }
      const t = list[nearestOnBase(x, y, z)];
      geometric = Math.max(geometric, posedGap(shipPosed, v, chainPosed, index[t * 3], index[t * 3 + 1], index[t * 3 + 2], closest[1], closest[2]));
    }
  }
  const baseError = Math.max(geometric, appearance(surfaceArea(index, allBase, position), V));
  lap(`base error ${geometric.toFixed(3)} m (${buried} buried points)`);

  // Folds are refused while the body has triangles to spare; near the core, only a triangle turned right over is.
  const chain = collapseSurface(position, index, region, CHAIN_LEAST_TRIANGLES, (living) => (living > 400 ? 0.2 : living > 60 ? -0.3 : -0.9)), S = chain.steps;
  let depth = 0;
  for (let v = 0; v < V; v++) { let d = 0; for (let w = v; chain.dieStep[w] >= 0; w = chain.target[w]) d++; depth = Math.max(depth, d); }
  if (depth > SHIP_CONTINUUM_MAX_DEPTH) throw Error(`The far body's collapses run ${depth} deep`);
  lap(`chain ${S} steps to ${chain.living} triangles, ${depth} deep`);
  // Errors and inflation, measured at every eighth step and the last few, between them taken in proportion.
  const baseFans = Array.from({ length: V }, () => []);
  allBase.forEach((t) => { for (let k = 0; k < 3; k++) baseFans[index[t * 3 + k]].push(t); });
  const low = [0, 1, 2].map((k) => Math.min(...Array.from({ length: V }, (_, i) => position[i * 3 + k])) - 0.5), high = [0, 1, 2].map((k) => Math.max(...Array.from({ length: V }, (_, i) => position[i * 3 + k])) + 0.5);
  const frame = { low, size: Math.max(...high.map((x, k) => x - low[k])), cells: 256 };
  const baseOutline = outline(position, normal, index, allBase, 0, frame);
  const wanted = baseOutline[0].covered + baseOutline[1].covered;
  const measured = new Map(), sampled = new Set([0, S]);
  for (let step = 0; step <= S; step += 8) sampled.add(step);
  for (let step = Math.max(0, S - 48); step <= S; step++) sampled.add(step);
  const stepCorners = new Uint32Array(T * 3);
  for (const step of [...sampled].sort((p, q) => p - q)) {
    const living = allBase.filter((t) => chain.death[t] < 0 || chain.death[t] > step);
    for (const t of living) for (let k = 0; k < 3; k++) stepCorners[t * 3 + k] = ancestor(chain, index[t * 3 + k], step);
    const fans = new Map();
    for (const t of living) for (let k = 0; k < 3; k++) { const a = stepCorners[t * 3 + k]; if (!fans.has(a)) fans.set(a, []); fans.get(a).push(t); }
    const stepP = { position, corners: stepCorners }, stepSpheres = triangleSpheres(position, stepCorners, allBase);
    let error = 0;
    // Each base point against the triangles of the vertex it has collapsed into.
    for (let v = 0; v < V; v++) {
      const list = fans.get(ancestor(chain, v, step)) ?? [];
      const k = nearestTriangle(position[v * 3], position[v * 3 + 1], position[v * 3 + 2], list, stepP, stepSpheres);
      if (k < 0) continue;
      const t = list[k];
      error = Math.max(error, posedGap(chainPosed, v, chainPosed, stepCorners[t * 3], stepCorners[t * 3 + 1], stepCorners[t * 3 + 2], closest[1], closest[2]));
    }
    // Each surviving triangle's middle against the base it has replaced.
    const members = new Map();
    for (let v = 0; v < V; v++) { const a = ancestor(chain, v, step); if (!members.has(a)) members.set(a, []); members.get(a).push(v); }
    for (const t of living) {
      const [a, b, c] = [0, 1, 2].map((k) => stepCorners[t * 3 + k]), candidates = new Set();
      for (const corner of [a, b, c]) for (const m of members.get(corner) ?? []) for (const u of baseFans[m]) candidates.add(u);
      const list = [...candidates], x = (position[a * 3] + position[b * 3] + position[c * 3]) / 3, y = (position[a * 3 + 1] + position[b * 3 + 1] + position[c * 3 + 1]) / 3, z = (position[a * 3 + 2] + position[b * 3 + 2] + position[c * 3 + 2]) / 3;
      const k = nearestTriangle(x, y, z, list, P, spheres);
      if (k < 0) continue;
      const u = list[k];
      error = Math.max(error, posedTriangleGap(chainPosed, [[a, b, c], 1 / 3, 1 / 3], [[index[u * 3], index[u * 3 + 1], index[u * 3 + 2]], closest[1], closest[2]]));
    }
    const vertices = fans.size, area = surfaceArea(stepCorners, living, position);
    // How far along its normals the surface must grow to cast the base's outline again.
    let inflate = 0;
    const cast = (d) => { const o = outline(position, normal, stepCorners, living, d, frame); return o[0].covered + o[1].covered; };
    if (step > 0 && cast(0) < wanted) {
      let lo = 0, hi = frame.size * 0.03;
      for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (cast(mid) < wanted) lo = mid; else hi = mid; }
      inflate = (lo + hi) / 2;
    }
    measured.set(step, { error: Math.max(baseError + error, appearance(area, vertices)), inflate });
  }
  const keys = [...measured.keys()].sort((p, q) => p - q), errors = new Float32Array(S + 1), inflates = new Float32Array(S + 1);
  for (let i = 0; i < keys.length; i++) {
    const s0 = keys[i], s1 = keys[Math.min(i + 1, keys.length - 1)], m0 = measured.get(s0), m1 = measured.get(s1);
    for (let step = s0; step <= s1; step++) {
      const f = s1 > s0 ? (step - s0) / (s1 - s0) : 0;
      errors[step] = m0.error + (m1.error - m0.error) * f;
      inflates[step] = m0.inflate + (m1.inflate - m0.inflate) * f;
    }
  }
  // Rising strictly, so the morph search always has room between one step and the next.
  for (let step = 1; step <= S; step++) errors[step] = Math.max(errors[step], errors[step - 1] * 1.0005 + 1e-6);
  if (!errors.every(Number.isFinite)) throw Error('The far body has a step without an error');
  lap('chain errors');

  // Triangles in order of death, latest first: those alive at step s are a prefix.
  const order = allBase.slice().sort((p, q) => (chain.death[q] < 0 ? Infinity : chain.death[q]) - (chain.death[p] < 0 ? Infinity : chain.death[p]));
  const steps = new Uint32Array((S + 1) * SHIP_CONTINUUM_STEP_WORDS), stepFloats = new Float32Array(steps.buffer);
  const dying = new Int32Array(S + 2);
  for (let t = 0; t < T; t++) if (chain.death[t] >= 0) dying[chain.death[t]]++;
  let alive = T;
  for (let step = 0; step <= S; step++) {
    alive -= dying[step];
    steps[step * SHIP_CONTINUUM_STEP_WORDS] = alive;
    stepFloats[step * SHIP_CONTINUUM_STEP_WORDS + 1] = errors[step];
    stepFloats[step * SHIP_CONTINUUM_STEP_WORDS + 2] = inflates[step];
  }
  if (steps[0] !== T || steps[S * SHIP_CONTINUUM_STEP_WORDS] !== chain.living) throw Error('Chain prefix counts disagree');

  // The splat: the far body's bounds, its outline's area end on and side on, and the colour the side shows.
  const bottom = low[1] + 0.5, top = high[1] - 0.5, cellArea = (frame.size / frame.cells) ** 2, ry = (top - bottom) / 2;
  const [endOn, sideOn] = baseOutline, mean = [0, 0, 0];
  for (const t of sideOn.nearest) if (t >= 0) for (let k = 0; k < 3; k++) mean[k] += (colour[index[t * 3] * 3 + k] + colour[index[t * 3 + 1] * 3 + k] + colour[index[t * 3 + 2] * 3 + k]) / (3 * sideOn.covered);
  const centre = [0, 1, 2].map((k) => (low[k] + high[k]) / 2);
  const splat = {
    centre: centre.map((v) => +v.toFixed(4)), ry: +ry.toFixed(4),
    rxSide: +((sideOn.covered * cellArea) / (Math.PI * ry)).toFixed(4), rxEnd: +((endOn.covered * cellArea) / (Math.PI * ry)).toFixed(4),
    colour: mean.map((v) => +v.toFixed(5)),
  };
  return {
    V, T, S, index, order, steps, chain, design, designNormal, colour, region, rides, depth, splat,
    stats: {
      voxel: +h.toFixed(4), pieces: pieces.map((p) => ({ kind: p.kind ? 'canvas' : 'rigid', close: +p.close.toFixed(4), grid: p.voxels.dims, count: p.count, dropped: p.voxels.droppedPieces, genus: p.genus, surfaceTriangles: p.surface })),
      baseTriangles: T, baseVertices: V, baseError: +baseError.toFixed(4), baseGeometric: +geometric.toFixed(4), steps: S, coreTriangles: chain.living, depth,
      errorRange: [+errors[0].toFixed(4), +errors[S].toFixed(4)], inflateMax: +Math.max(...inflates).toFixed(4), euler: census.euler,
    },
  };
}

// ------------------------------------------------------------------------------------------------ main
function receipt(bytes, dir, name) {
  const gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(dir, `${name}.gz`), gz);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), gzip: { file: `${name}.gz`, bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex') } };
}
const asBytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);

// ------------------------------------------------------------------------------------------------ the player's ships
const shipAssets = createShipAssetCache();
// A ship the player sails, in the terms the bake takes: her assembly as js/ship-mesh.js builds it, in metres by the
// hull transform's own scale (js/wgsl/caravel.js: beam over 3.6, the frame's vertical scale, length over 12).
function playerAssembly(modelId) {
  const asset = shipAssets.get(modelId), model = asset.model, frame = vesselHull(modelId).frame;
  return {
    index: -1, label: model.name, length: model.runtime.length,
    designScale: Float32Array.of(model.runtime.beam / frame.beam, frame.verticalScale, model.runtime.length / frame.length),
    vertices: asset.vertices, indices: asset.indices, groups: asset.groups, fracture: asset.fracture,
    vertexCount: asset.vertices.length / 9, indexCount: asset.indices.length, triangleCount: asset.indices.length / 3,
  };
}
// How far each point of a player's ship can move from rest (metres): canvas, cordage, spars, oars and the helm swing
// with the rig, a yard's end as far as six tenths of her length; the rest (guns run in and out, hatches, the rudder)
// a metre and a half.
const RIGGED = new Set([2, 9, 10, 12, 13, 16, 19, 28]);
function playerSlack(arch, body) {
  const slack = new Float32Array(body.count), rig = 0.6 * arch.length;
  for (let v = 0; v < body.count; v++) slack[v] = RIGGED.has(Math.floor(body.material[v])) ? rig : 1.5;
  return slack;
}

async function bake(entry) {
  const started = Date.now(), lap = (label) => console.log(`  ${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${label}`);
  const player = entry.family === 'player';
  const arch = player ? playerAssembly(entry.model) : getTradeVesselArchetype(entry.archetype);
  console.log(`${entry.id}: ${arch.label}, ${arch.vertexCount} vertices, ${arch.triangleCount} triangles`);
  const body = splitParts(arch), poses = player ? [{ time: 0, phase: 0, motion: 0, furl: 0 }] : posesFor(arch.index);
  body.posed = posePoints(arch.index, arch.designScale, poses, { count: body.count, design: body.design, designNormal: body.designNormal, material: body.material, uv: body.uv, rest: body.position });
  if (player) body.posed.slack = playerSlack(arch, body);
  lap(`${body.parts} parts, ${body.copies} seam copies, ${poses.length} poses`);
  const clusters = await bakeClusters(body, body.posed);
  lap(`${clusters.count} clusters, ${clusters.levels} levels, root error ${clusters.rootError.toFixed(3)} m`);
  const far = bakeFar(arch, body, poses, lap);

  // The ship's bound, in every pose, cordage and all.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], drawnVertices = [...new Set(body.index)];
  for (const X of body.posed) for (const v of drawnVertices) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], X[v * 3 + k]); hi[k] = Math.max(hi[k], X[v * 3 + k]); }
  const centre = lo.map((l, k) => (l + hi[k]) / 2);
  let radius = 0;
  radius = posedReach(body.posed, drawnVertices, centre);

  // The far body: its vertices, each vertex's collapse (the step it goes at, and where), its triangles in order of
  // death, and its steps.
  const { V, T, S } = far, farWords = new Uint32Array(V * SHIP_CONTINUUM_FAR_VERTEX_WORDS + V + T * 3 + far.steps.length);
  for (let i = 0; i < V; i++) farWords.set(packShipContinuumFarVertex({
    position: far.design.subarray(i * 3, i * 3 + 3), normal: far.designNormal.subarray(i * 3, i * 3 + 3), colour: far.colour.subarray(i * 3, i * 3 + 3), kind: far.region[i], source: far.rides[i],
  }), i * SHIP_CONTINUUM_FAR_VERTEX_WORDS);
  const recordsAt = V * SHIP_CONTINUUM_FAR_VERTEX_WORDS, trianglesAt = recordsAt + V, stepsAt = trianglesAt + T * 3;
  for (let i = 0; i < V; i++) farWords[recordsAt + i] = ((far.chain.dieStep[i] < 0 ? SHIP_CONTINUUM_NEVER : far.chain.dieStep[i]) | ((far.chain.target[i] < 0 ? i : far.chain.target[i]) << 16)) >>> 0;
  far.order.forEach((t, k) => { for (let c = 0; c < 3; c++) farWords[trianglesAt + k * 3 + c] = far.index[t * 3 + c]; });
  farWords.set(far.steps, stepsAt);

  const dir = path.join(OUT, entry.id);
  fs.mkdirSync(dir, { recursive: true });
  const copies = body.source.subarray(body.original);
  const files = {
    'clusters.bin': receipt(asBytes(clusters.clusters), dir, 'clusters.bin'),
    'indices.bin': receipt(asBytes(clusters.indices), dir, 'indices.bin'),
    'copies.bin': receipt(asBytes(copies), dir, 'copies.bin'),
    'far.bin': receipt(asBytes(farWords), dir, 'far.bin'),
    ...(player ? {
      // The assembly's corners as baked, by which the runtime renumbers the clusters onto the ship as built there.
      'corners.bin': receipt(asBytes(Uint32Array.from(arch.indices)), dir, 'corners.bin'),
    } : {
      // The assembly as baked: the vertices the clusters name and the shard each one flies with when the ship breaks.
      'vertices.bin': receipt(asBytes(arch.vertices), dir, 'vertices.bin'),
      'shards.bin': receipt(asBytes(Uint32Array.from(arch.fracture.vertexShards)), dir, 'shards.bin'),
    }),
  };
  const surface = shipContinuumSurface(arch.vertices, arch.indices);
  const manifest = {
    format: SHIP_CONTINUUM_FORMAT, version: SHIP_CONTINUUM_VERSION, id: entry.id, family: entry.family, archetype: entry.archetype, model: entry.model, label: arch.label,
    source: {
      vertices: arch.vertexCount, indices: arch.indexCount, shards: arch.fracture.shardCount,
      key: createHash('sha256').update(shipContinuumSourceKey(arch)).digest('hex'),
      surface: { area: surface.area, centroid: surface.centroid, materials: surface.materials },
      designScale: Array.from(arch.designScale, (v) => +v.toFixed(6)),
    },
    clusterWords: SHIP_CONTINUUM_CLUSTER_WORDS, farVertexWords: SHIP_CONTINUUM_FAR_VERTEX_WORDS, stepWords: SHIP_CONTINUUM_STEP_WORDS,
    clusterCount: clusters.count, indexCount: clusters.indices.length, copyCount: copies.length,
    clusters: { triangles: clusters.triangles, levels: clusters.levels, roots: clusters.roots, groups: clusters.groupCount, parts: body.parts, rootError: +clusters.rootError.toFixed(4) },
    far: { vertexCount: V, triangleCount: T, stepCount: S, offsets: { vertices: 0, records: recordsAt, triangles: trianglesAt, steps: stepsAt }, ...far.stats },
    splat: far.splat,
    bound: { centre: centre.map((v) => +v.toFixed(4)), radius: +(radius + SPHERE_MARGIN).toFixed(4) },
    poses: poses.length, files,
  };
  validateShipContinuumManifest(manifest);
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  const gz = Object.values(files).reduce((sum, f) => sum + f.gzip.bytes, 0);
  console.log(`  ${clusters.count} clusters (${clusters.triangles} triangles) · far body ${T} → ${far.stats.coreTriangles} triangles in ${S} steps, ${far.stats.errorRange.join('–')} m · ${(gz / 1048576).toFixed(2)} MiB gzipped · ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return manifest;
}

for (const entry of SHIP_CONTINUUM_BODIES) {
  if (ONLY && !ONLY.split(',').includes(entry.id)) continue;
  await bake(entry);
}
