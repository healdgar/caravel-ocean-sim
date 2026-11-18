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
//              half-edge at a time to one closed core of four, whatever shells and holes it began with: the one
//              simplifier's voxel pieces and chain (js/continuum-bake.js voxelPieces, collapseChain). Each vertex rides the ship vertex of its piece nearest it, so the far
//              body moves as the ship does; each step's error is measured posed against the ship.
//   splat      one view-facing ellipse with the far body's outline area seen side on and end on, and its colour.
// Streams are written gzipped beside a manifest with their receipts.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildDag } from '../third_party/threejs-nanites/dag/build.ts';
// The one simplifier every family's bake shares (js/continuum-bake.js): its chain, its voxel pieces and rides, its
// measures, used here as they are there.
import {
  closest, closestOnTriangle, triangleSpheres, triangleGrid, surfaceArea, ancestor, collapseChain, outline, voxelPieces, pointGrid,
} from '../js/continuum-bake.js';
import { getTradeVesselArchetype, poseTradeVesselPoint, tradeMaterialLinearColor } from '../js/trade-vessels.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { vesselHull } from '../js/hull.js';
import { anchorEquipment } from '../js/anchor-state.js';
import { VESSEL_ENSIGN_MATERIAL, VESSEL_PENNANT_MATERIAL } from '../js/wgsl/ship-colours.js';
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
// Canvas, and her colours' bunting: the far body's second piece (see bakeFar).
const CANVAS = new Set([9, 13, VESSEL_ENSIGN_MATERIAL, VESSEL_PENNANT_MATERIAL]);
// What a far-body vertex is, for the collapses to keep borders between: wood, canvas, iron and paint, the rest.
const materialClass = (m) => { const k = Math.floor(m); return CANVAS.has(k) ? 1 : (k === 3 || k === 4 || k === 8 || k === 11 || k === 20 || k === 22) ? 2 : k >= 21 && k <= 26 ? 3 : 0; };
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
// The outline is cast end on and side on.
const SHIP_VIEWS = [[0, 1, 2], [2, 1, 0]];
// Vertex colours blur what lies within half their spacing, which counts as error too.
const appearance = (area, vertices) => 0.5 * Math.sqrt(area / Math.max(vertices, 1));

function bakeFar(arch, body, poses, lap) {
  const archIndex = arch.index, s = arch.designScale, V0 = arch.vertices.length / 9;
  // The far body's pieces: what is rigid, and the canvas, which brails up its yard. Each piece rides only ship
  // vertices of its own kind, so canvas going aloft never drags the hull or a mast with it.
  // Her working anchor's iron is let go from her (js/vessel-detail.js): the far body leaves it out.
  const kindOf = (t) => { const m = Math.floor(arch.vertices[arch.indices[t * 3] * 9 + 6]); return ROPE.has(m) || arch.letGo?.[arch.indices[t * 3]] ? -1 : CANVAS.has(m) ? 1 : 0; };
  const keep = [[], []];
  for (const t of body.drawn) { const k = kindOf(t); if (k >= 0) keep[k].push(t); }
  // The ship in metres, and the voxels: CELLS along her longest side.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], metres = new Float64Array(V0 * 3);
  for (let v = 0; v < V0; v++) for (let k = 0; k < 3; k++) { const x = arch.vertices[v * 9 + k] * s[k]; metres[v * 3 + k] = x; lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x); }
  const h = Math.max(...hi.map((x, k) => x - lo[k])) / CELLS;
  // The base: the pieces' surfaces collapsed together to CHAIN_BASE_TRIANGLES, no triangle turned more than sixty
  // degrees, each base vertex riding the ship vertex of its own piece nearest it.
  const far = voxelPieces(metres, arch.indices, [
    { name: 'rigid', triangles: keep[0], close: CLOSE_METRES }, { name: 'canvas', triangles: keep[1], close: CLOSE_CANVAS_METRES },
  ], { h, base: CHAIN_BASE_TRIANGLES, fold: () => 0.5, lap });
  const { position, index, normal, rides, census, pieces } = far, kindOfBase = far.piece, V = position.length / 3, T = index.length / 3;
  lap(`base ${T} triangles`);

  // Each base vertex takes the mean colour of the ship's surface of its kind nearest it (each triangle given to the
  // base vertex of its kind nearest its middle, by area).
  const { sourceVertices: shipVertices, baseVertices } = far, sums = new Float64Array(V * 4), classes = new Float64Array(V * 4);
  for (const kind of [0, 1]) {
    if (!baseVertices[kind].length) continue;
    const nearestBase = pointGrid(position, baseVertices[kind], 0.25);
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
  const nearestOnBase = triangleGrid(position, index, 0.5), triangleKind = Uint8Array.from({ length: T }, (_, t) => kindOfBase[index[t * 3]]);
  for (const { piece: kind, voxels } of pieces) {
    const ofKind = (t) => triangleKind[t] === kind;
    for (const v of shipVertices[kind]) {
      const x = body.position[v * 3], y = body.position[v * 3 + 1], z = body.position[v * 3 + 2];
      if (voxels.buried(x, y, z)) { buried++; continue; }
      const t = nearestOnBase(x, y, z, ofKind);
      geometric = Math.max(geometric, posedGap(shipPosed, v, chainPosed, index[t * 3], index[t * 3 + 1], index[t * 3 + 2], closest[1], closest[2]));
    }
  }
  const baseError = Math.max(geometric, appearance(surfaceArea(index, allBase, position), V));
  lap(`base error ${geometric.toFixed(3)} m (${buried} buried points)`);

  // Folds are refused while the body has triangles to spare; near the core, only a triangle turned right over is. A
  // collapse across a border of class costs six times; shells and holes the link condition cannot pass are closed last.
  const chain = collapseChain(position, index, CHAIN_LEAST_TRIANGLES, { region }), S = chain.steps.length;
  let depth = 0;
  for (let v = 0; v < V; v++) { let d = 0; for (let w = v; chain.dieStep[w] >= 0; w = chain.target[w]) d++; depth = Math.max(depth, d); }
  if (depth > SHIP_CONTINUUM_MAX_DEPTH) throw Error(`The far body's collapses run ${depth} deep`);
  lap(`chain ${S} steps to ${chain.living} triangles, ${depth} deep`);
  // Errors and inflation, measured at every eighth step and the last few, between them taken in proportion.
  const baseFans = Array.from({ length: V }, () => []);
  allBase.forEach((t) => { for (let k = 0; k < 3; k++) baseFans[index[t * 3 + k]].push(t); });
  const low = [0, 1, 2].map((k) => Math.min(...Array.from({ length: V }, (_, i) => position[i * 3 + k])) - 0.5), high = [0, 1, 2].map((k) => Math.max(...Array.from({ length: V }, (_, i) => position[i * 3 + k])) + 0.5);
  const frame = { low, size: Math.max(...high.map((x, k) => x - low[k])), cells: 256 };
  const baseOutline = outline(position, normal, index, allBase, 0, frame, (t) => t, SHIP_VIEWS);
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
    const cast = (d) => { const o = outline(position, normal, stepCorners, living, d, frame, null, SHIP_VIEWS); return o[0].covered + o[1].covered; };
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
  for (const t of sideOn.label) if (t >= 0) for (let k = 0; k < 3; k++) mean[k] += (colour[index[t * 3] * 3 + k] + colour[index[t * 3 + 1] * 3 + k] + colour[index[t * 3 + 2] * 3 + k]) / (3 * sideOn.covered);
  const centre = [0, 1, 2].map((k) => (low[k] + high[k]) / 2);
  const splat = {
    centre: centre.map((v) => +v.toFixed(4)), ry: +ry.toFixed(4),
    rxSide: +((sideOn.covered * cellArea) / (Math.PI * ry)).toFixed(4), rxEnd: +((endOn.covered * cellArea) / (Math.PI * ry)).toFixed(4),
    colour: mean.map((v) => +v.toFixed(5)),
  };
  return {
    V, T, S, index, order, steps, chain, design, designNormal, colour, region, rides, depth, splat,
    stats: {
      voxel: +h.toFixed(4), pieces: pieces.map((p) => ({ kind: p.piece ? 'canvas' : 'rigid', close: +p.close.toFixed(4), grid: p.voxels.dims, count: p.count, dropped: p.voxels.droppedPieces, genus: p.genus, surfaceTriangles: p.surface })),
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
// Her working anchor's iron (js/vessel-detail.js) is marked by vertex: once let go it lies as far from her as her
// longest rode.
function playerAssembly(modelId) {
  const asset = shipAssets.get(modelId), model = asset.model, frame = vesselHull(modelId).frame;
  const letGo = new Uint8Array(asset.vertices.length / 9);
  for (const g of asset.groups) if (g.id === 'anchor.port.iron') for (let i = g.firstVertex; i < g.firstVertex + g.vertexCount; i++) letGo[asset.indices[i]] = 1;
  return {
    letGo, rode: anchorEquipment({ modelId })?.maxRode ?? 0,
    index: -1, label: model.name, length: model.runtime.length,
    designScale: Float32Array.of(model.runtime.beam / frame.beam, frame.verticalScale, model.runtime.length / frame.length),
    vertices: asset.vertices, indices: asset.indices, groups: asset.groups, fracture: asset.fracture,
    vertexCount: asset.vertices.length / 9, indexCount: asset.indices.length, triangleCount: asset.indices.length / 3,
  };
}
// How far each point of a player's ship can move from rest (metres): canvas, her colours, cordage, spars, oars and the
// helm swing with the rig, a yard's end as far as six tenths of her length; her anchor's iron as far as its rode runs;
// the rest (guns run in and out, hatches, the rudder) a metre and a half.
const RIGGED = new Set([2, 9, 10, 12, 13, 16, 19, 28, VESSEL_ENSIGN_MATERIAL, VESSEL_PENNANT_MATERIAL]);
function playerSlack(arch, body) {
  const slack = new Float32Array(body.count), rig = 0.6 * arch.length;
  for (let v = 0; v < body.count; v++) slack[v] = arch.letGo[body.source[v]] ? arch.rode : RIGGED.has(Math.floor(body.material[v])) ? rig : 1.5;
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

  // The ship's bound, in every pose, cordage and all; her anchor let go is bound by its own clusters, not hers.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], drawnVertices = [...new Set(body.index)].filter((v) => !arch.letGo?.[body.source[v]]);
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
