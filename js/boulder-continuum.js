// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Ground-cover boulders: each archetype's physical cleavage polyhedron, the ballistic ray-sweep against it and the
// fracture a shot enrols it in (js/building-fracture.js), and its drawing through the one continuum (AGENTS.md rule 3).
// Each archetype's polyhedron, the very triangles a shot is swept against, is baked offline by the one bake
// (scripts/prepare-boulder-continuum.mjs, js/continuum-bake.js) into a type of the boulders' atlas. Every resident
// rock is then a RIGID record of the one cut (js/continuum-scene.js), its type stretched to its radius and height and
// turned to its basis, cut on the GPU at the scene's one pixel error and stood on the ground the land draws
// (CONTINUUM_GROUNDED); a rock shot apart is drawn as its pieces, SHARDED, with the struck buildings'.
import { ROCK_ARCHETYPES, rockArchetypeFromSeed } from './vegetation.js';
import { BUILDING_SHARD_KINDS, buildingKindWithYaw, noteBuildingMesh, traceShotAtBuilding } from './building-fracture.js';
import {
  CONTINUUM_ATLAS_VERSION, CONTINUUM_HEADER_WORDS, CONTINUUM_NEVER, CONTINUUM_TYPE, CONTINUUM_RECORD, CONTINUUM_RECORD_WORDS, CONTINUUM_STRETCHED,
  continuumFloatWord, continuumRoom, loadContinuumAtlas, packContinuumBody,
} from './continuum-format.js';
import { createContinuumScene, requestContinuumAtlas } from './continuum-scene.js';
import { CONTINUUM_GROUNDED } from './continuum-ground.js';

export const BOULDER_DENSITY_KG_M3 = 2650;
export const BOULDER_TOUGHNESS = 1.35;

const BOULDER_RAW_SURFACE = 1.6;
const FRACTURE_STRIDE = 8;
// A rock as ground cover lays it (js/vegetation.js groundCoverInstances): x, y, z, radius, height, seed, and the
// ground's slope along x and z.
const SOURCE_INSTANCE_FLOATS = 8;
const BOULDER_EMPTY_SLOT = 0xffffffff;
const BOULDER_CELL_M = 32;

const boulderSeededRandom = (initial) => {
  let seed = initial >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
};

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm3 = (v) => {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
};

// Exact orthonormal + scale frame shared identically between CPU ray-sweep/fracture and WGSL continuum shaders.
export function boulderBasisFromInstance(x, y, z, radius, height, seed, sx = 0, sz = 0) {
  const up = norm3([-sx * 0.55, 1.0, -sz * 0.55]);
  const yaw = (seed ?? 0) * Math.PI * 2;
  const hx = Math.cos(yaw), hz = Math.sin(yaw);
  const axisZ = norm3(cross3([hx, 0, hz], up));
  const axisX = norm3(cross3(up, axisZ));
  return {
    origin: [x, y, z],
    axisX,
    axisY: up,
    axisZ,
    scale: [radius, height, radius],
    yaw,
  };
}

export function boulderLocalToWorldPoint(basis, lx, ly, lz) {
  const { origin, axisX, axisY, axisZ, scale } = basis;
  const sx = lx * scale[0], sy = ly * scale[1], sz = lz * scale[2];
  return [
    origin[0] + axisX[0] * sx + axisY[0] * sy + axisZ[0] * sz,
    origin[1] + axisX[1] * sx + axisY[1] * sy + axisZ[1] * sz,
    origin[2] + axisX[2] * sx + axisY[2] * sy + axisZ[2] * sz,
  ];
}

export function boulderWorldToLocalPoint(basis, wx, wy, wz) {
  const { origin, axisX, axisY, axisZ, scale } = basis;
  const dx = wx - origin[0], dy = wy - origin[1], dz = wz - origin[2];
  return [
    (dx * axisX[0] + dy * axisX[1] + dz * axisX[2]) / Math.max(1e-4, scale[0]),
    (dx * axisY[0] + dy * axisY[1] + dz * axisY[2]) / Math.max(1e-4, scale[1]),
    (dx * axisZ[0] + dy * axisZ[1] + dz * axisZ[2]) / Math.max(1e-4, scale[2]),
  ];
}

export function boulderLocalToWorldNormal(basis, nx, ny, nz) {
  const { axisX, axisY, axisZ, scale } = basis;
  const rawLen = Math.hypot(nx, ny, nz) || 1;
  const ix = nx / Math.max(1e-4, scale[0]);
  const iy = ny / Math.max(1e-4, scale[1]);
  const iz = nz / Math.max(1e-4, scale[2]);
  const wx = axisX[0] * ix + axisY[0] * iy + axisZ[0] * iz;
  const wy = axisX[1] * ix + axisY[1] * iy + axisZ[1] * iz;
  const wz = axisX[2] * ix + axisY[2] * iy + axisZ[2] * iz;
  const wLen = Math.hypot(wx, wy, wz) || 1;
  const s = rawLen / wLen;
  return [wx * s, wy * s, wz * s];
}

function orderConvexFace(indices, vertices, outwardNormal) {
  const unique = [];
  for (const idx of indices) {
    if (!unique.includes(idx)) unique.push(idx);
  }
  if (unique.length < 3) return [];
  let cx = 0, cy = 0, cz = 0;
  for (const idx of unique) {
    const p = vertices[idx];
    cx += p[0]; cy += p[1]; cz += p[2];
  }
  const inv = 1 / unique.length;
  cx *= inv; cy *= inv; cz *= inv;
  const n = norm3(outwardNormal);
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3(cross3(ref, n));
  const v = cross3(n, u);
  unique.sort((ia, ib) => {
    const pa = vertices[ia], pb = vertices[ib];
    const aa = Math.atan2(
      (pa[0] - cx) * v[0] + (pa[1] - cy) * v[1] + (pa[2] - cz) * v[2],
      (pa[0] - cx) * u[0] + (pa[1] - cy) * u[1] + (pa[2] - cz) * u[2],
    );
    const ab = Math.atan2(
      (pb[0] - cx) * v[0] + (pb[1] - cy) * v[1] + (pb[2] - cz) * v[2],
      (pb[0] - cx) * u[0] + (pb[1] - cy) * u[1] + (pb[2] - cz) * u[2],
    );
    return aa - ab;
  });
  return unique;
}

function createInitialBox(x0, x1, y0, y1, z0, z1) {
  const vertices = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const specs = [
    [[0, 1, 2, 3], [0, 0, -1]],
    [[4, 5, 6, 7], [0, 0, 1]],
    [[0, 4, 7, 3], [-1, 0, 0]],
    [[1, 5, 6, 2], [1, 0, 0]],
    [[0, 1, 5, 4], [0, -1, 0]],
    [[3, 2, 6, 7], [0, 1, 0]],
  ];
  const faces = specs.map(([ring, n]) => ({
    v: orderConvexFace(ring, vertices, n),
    n,
    raw: false,
    neighbor: -1,
  }));
  return { vertices, faces };
}

function clonePolyhedron(poly) {
  return {
    vertices: poly.vertices.map((p) => [p[0], p[1], p[2]]),
    faces: poly.faces.map((f) => ({
      v: f.v.slice(),
      n: [f.n[0], f.n[1], f.n[2]],
      raw: f.raw,
      neighbor: f.neighbor,
    })),
  };
}

// Clips a closed 3D convex polyhedron against half-space n · p <= d.
// Preserves exact shared edge vertices so V - E + F = 2 holds on every resulting cell.
function clipConvexPolyhedron(poly, planeN, d, isRaw = false, neighbor = -1) {
  if (!poly || !poly.faces.length) return null;
  const n = norm3(planeN);
  const vCount = poly.vertices.length;
  const sd = new Float64Array(vCount);
  const EPS = 1e-7;
  let neg = 0, pos = 0;
  for (let i = 0; i < vCount; i++) {
    const val = dot3(n, poly.vertices[i]) - d;
    if (Math.abs(val) <= EPS) {
      sd[i] = 0;
    } else {
      sd[i] = val;
      if (val < 0) neg++;
      else pos++;
    }
  }
  if (neg === 0) return null;
  if (pos === 0) return poly;

  const newVerts = [];
  const remap = new Int32Array(vCount).fill(-1);
  for (let i = 0; i < vCount; i++) {
    if (sd[i] <= 0) {
      remap[i] = newVerts.length;
      const p = poly.vertices[i];
      newVerts.push([p[0], p[1], p[2]]);
    }
  }

  const edgeCache = new Map();
  const capVerts = new Set();
  const cutEdge = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * 65536 + hi;
    const hit = edgeCache.get(key);
    if (hit !== undefined) return hit;
    const da = sd[a], db = sd[b];
    const t = da / (da - db);
    const pa = poly.vertices[a], pb = poly.vertices[b];
    const idx = newVerts.length;
    newVerts.push([
      pa[0] + (pb[0] - pa[0]) * t,
      pa[1] + (pb[1] - pa[1]) * t,
      pa[2] + (pb[2] - pa[2]) * t,
    ]);
    edgeCache.set(key, idx);
    return idx;
  };

  const newFaces = [];
  for (const face of poly.faces) {
    const ring = face.v;
    const out = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const da = sd[a], db = sd[b];
      if (da <= 0) {
        const ra = remap[a];
        out.push(ra);
        if (da === 0) capVerts.add(ra);
      }
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const mid = cutEdge(a, b);
        out.push(mid);
        capVerts.add(mid);
      }
    }
    const ordered = orderConvexFace(out, newVerts, face.n);
    if (ordered.length >= 3) {
      newFaces.push({
        v: ordered,
        n: [face.n[0], face.n[1], face.n[2]],
        raw: face.raw,
        neighbor: face.neighbor,
      });
    }
  }

  if (capVerts.size >= 3) {
    const capOrdered = orderConvexFace([...capVerts], newVerts, n);
    if (capOrdered.length >= 3) {
      newFaces.push({
        v: capOrdered,
        n,
        raw: isRaw,
        neighbor,
      });
    }
  }

  if (newFaces.length < 4) return null;
  // Prune any vertices orphaned by face pruning so vertex degrees stay cleanly >= 3.
  const used = new Int32Array(newVerts.length).fill(-1);
  const compactVerts = [];
  for (const f of newFaces) {
    for (let i = 0; i < f.v.length; i++) {
      const oldIdx = f.v[i];
      if (used[oldIdx] < 0) {
        used[oldIdx] = compactVerts.length;
        compactVerts.push(newVerts[oldIdx]);
      }
      f.v[i] = used[oldIdx];
    }
  }
  return { vertices: compactVerts, faces: newFaces };
}

// Exact divergence-theorem volume, centre of mass, bounds, and manifold Euler invariants.
export function measurePolyhedron(poly) {
  let vol6 = 0, cx = 0, cy = 0, cz = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of poly.vertices) {
    for (let c = 0; c < 3; c++) {
      if (p[c] < min[c]) min[c] = p[c];
      if (p[c] > max[c]) max[c] = p[c];
    }
  }
  const ref = poly.vertices[0] ?? [0, 0, 0];
  let directedEdges = 0;
  const halfEdges = new Set();
  for (const face of poly.faces) {
    const ring = face.v;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      halfEdges.add(a * 65536 + b);
      directedEdges++;
    }
    const p0 = sub3(poly.vertices[ring[0]], ref);
    for (let i = 1; i + 1 < ring.length; i++) {
      const p1 = sub3(poly.vertices[ring[i]], ref);
      const p2 = sub3(poly.vertices[ring[i + 1]], ref);
      const det = dot3(p0, cross3(p1, p2));
      vol6 += det;
      cx += det * (ref[0] + (p0[0] + p1[0] + p2[0]) * 0.25);
      cy += det * (ref[1] + (p0[1] + p1[1] + p2[1]) * 0.25);
      cz += det * (ref[2] + (p0[2] + p1[2] + p2[2]) * 0.25);
    }
  }
  let unmatchedHalfEdges = 0;
  for (const key of halfEdges) {
    const a = Math.floor(key / 65536), b = key % 65536;
    if (!halfEdges.has(b * 65536 + a)) unmatchedHalfEdges++;
  }
  const volume = Math.max(0, vol6 / 6);
  const centroid = vol6 > 1e-9
    ? [cx / vol6, cy / vol6, cz / vol6]
    : [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];
  const V = poly.vertices.length;
  const E = directedEdges / 2;
  const F = poly.faces.length;
  return {
    volume,
    centroid,
    min,
    max,
    V,
    E,
    F,
    euler: V - E + F,
    watertight: unmatchedHalfEdges === 0 && V - E + F === 2 && volume > 1e-6,
    unmatchedHalfEdges,
  };
}

function buildOuterBoulderPolyhedron(archetype) {
  const rand = boulderSeededRandom(29173 + archetype * 13007);
  const star = [0, 0.28, 0];
  let poly = createInitialBox(-1.45, 1.45, -0.22, 1.15, -1.45, 1.45);

  const cutAroundStar = (dir, dist) => {
    const n = norm3(dir);
    const d = dot3(n, star) + dist;
    const clipped = clipConvexPolyhedron(poly, n, d, false, -1);
    if (clipped) poly = clipped;
  };

  // Grounded basal root plane at y = -0.20 keeps every boulder firmly embedded on slopes.
  cutAroundStar([0, -1, 0], 0.48);

  const topTilt = archetype === 0
    ? [0.22, 0.96, 0.12]
    : archetype === 2
      ? [0.46, 0.84, -0.26]
      : archetype === 5
        ? [0.07, 0.99, -0.05]
        : [0.16 + rand() * 0.24, 0.92, 0.14 - rand() * 0.28];
  const topDist = archetype === 0 ? 0.44 : archetype === 2 ? 0.50 : archetype === 4 ? 0.46 : 0.48 + rand() * 0.08;
  cutAroundStar(topTilt, topDist);

  const sideCount = archetype === 5 ? 7 : 9 + (archetype % 3);
  const phase = rand() * Math.PI * 2;
  for (let i = 0; i < sideCount; i++) {
    const az = phase + (i / sideCount) * Math.PI * 2 + (rand() - 0.5) * (archetype === 5 ? 0.14 : 0.34);
    const el = archetype === 3 && i % 2 === 0 ? 0.48 : archetype === 5 ? 0.08 : (rand() - 0.16) * 0.62;
    const dist = (archetype === 1 || archetype === 2 ? 0.60 : 0.66) + rand() * 0.18;
    cutAroundStar([Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)], dist);
  }

  // Upper brow bevel planes create natural geological facets and corners.
  const bevelCount = archetype === 5 ? 5 : 6;
  for (let i = 0; i < bevelCount; i++) {
    const az = phase + 0.37 + (i / bevelCount) * Math.PI * 2;
    const el = 0.56 + rand() * 0.22;
    const dist = 0.52 + rand() * 0.12;
    cutAroundStar([Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)], dist);
  }
  // Basal undercut / heel planes so boulders tuck cleanly into soil without overhanging skirts.
  for (let i = 0; i < 5; i++) {
    const az = phase + 0.61 + (i / 5) * Math.PI * 2;
    cutAroundStar([Math.cos(az) * 0.86, -0.51, Math.sin(az) * 0.86], 0.68 + rand() * 0.08);
  }

  // Normalize horizontal extent to ~0.92 and vertical span to [-0.20, 0.80] while preserving planarity.
  const stretchX = archetype === 0 ? 1.12 : archetype === 4 ? 1.06 : 0.90 + rand() * 0.22;
  const stretchZ = archetype === 0 ? 0.86 : archetype === 4 ? 0.94 : 0.86 + rand() * 0.22;
  let minY = Infinity, maxY = -Infinity, maxXZ = 0;
  for (const p of poly.vertices) {
    p[0] *= stretchX;
    p[2] *= stretchZ;
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    const r = Math.hypot(p[0], p[2]);
    if (r > maxXZ) maxXZ = r;
  }
  const xzScale = 0.92 / Math.max(1e-3, maxXZ);
  const yScale = 1.0 / Math.max(1e-3, maxY - minY);
  for (const p of poly.vertices) {
    p[0] *= xzScale;
    p[2] *= xzScale;
    p[1] = -0.20 + (p[1] - minY) * yScale;
  }
  // Recompute exact unit face normals after affine stretch/normalization.
  for (const f of poly.faces) {
    const a = poly.vertices[f.v[0]], b = poly.vertices[f.v[1]], c = poly.vertices[f.v[2]];
    f.n = norm3(cross3(sub3(b, a), sub3(c, a)));
  }
  return poly;
}

// Decomposes outerPoly into 19 watertight convex geological cleavage cells via 3D Power/Laguerre diagram:
//   - site 0: anchored basal stump (shard 0)
//   - sites 1..5: heavy interior core cleavage wedges (5 shards)
//   - sites 6..18: outer corner/shoulder/brow spall & flake chips (13 shards)
function decomposeBoulderCleavage(outerPoly, archetype) {
  const rand = boulderSeededRandom(91813 + archetype * 7919);
  const sites = [];
  // Site 0: grounded basal root stump.
  sites.push({ pos: [0, -0.14, 0], weight: 0.045, role: 'stump', hardness: 99 });

  // Sites 1..5: 5 heavy interior core cleavage wedges resting on the basal stump.
  const corePhase = rand() * Math.PI * 2;
  for (let i = 0; i < 5; i++) {
    const a = corePhase + (i / 5) * Math.PI * 2 + (rand() - 0.5) * 0.24;
    const r = 0.23 + rand() * 0.06;
    const y = 0.20 + (i % 2) * 0.08 + (rand() - 0.5) * 0.04;
    sites.push({
      pos: [Math.cos(a) * r, y, Math.sin(a) * r],
      weight: 0.012,
      role: 'core',
      hardness: 1.06,
    });
  }

  // Sites 6..13: 8 outer shoulder & corner spall chips.
  const spallPhase = corePhase + 0.31;
  for (let i = 0; i < 8; i++) {
    const a = spallPhase + (i / 8) * Math.PI * 2 + (rand() - 0.5) * 0.18;
    const r = 0.66 + (i % 2) * 0.07;
    const y = 0.16 + (i % 3) * 0.13 + (rand() - 0.5) * 0.04;
    sites.push({
      pos: [Math.cos(a) * r, y, Math.sin(a) * r],
      weight: -0.018,
      role: 'spall',
      hardness: 0.44,
    });
  }

  // Sites 14..18: 5 upper brow & crown flake chips.
  for (let i = 0; i < 4; i++) {
    const a = spallPhase + 0.39 + (i / 4) * Math.PI * 2 + (rand() - 0.5) * 0.20;
    const r = 0.42 + rand() * 0.08;
    const y = 0.58 + rand() * 0.08;
    sites.push({
      pos: [Math.cos(a) * r, y, Math.sin(a) * r],
      weight: -0.015,
      role: 'spall',
      hardness: 0.38,
    });
  }
  sites.push({
    pos: [(rand() - 0.5) * 0.08, 0.74, (rand() - 0.5) * 0.08],
    weight: -0.016,
    role: 'spall',
    hardness: 0.36,
  });

  const rawCells = [];
  for (let i = 0; i < sites.length; i++) {
    let cell = clonePolyhedron(outerPoly);
    const si = sites[i].pos, wi = sites[i].weight;
    const si2 = dot3(si, si) - wi;
    for (let j = 0; j < sites.length && cell; j++) {
      if (i === j) continue;
      const sj = sites[j].pos, wj = sites[j].weight;
      const sj2 = dot3(sj, sj) - wj;
      const diff = sub3(sj, si);
      const len = Math.hypot(diff[0], diff[1], diff[2]);
      if (len < 1e-6) continue;
      const n = [diff[0] / len, diff[1] / len, diff[2] / len];
      const d = 0.5 * (sj2 - si2) / len;
      cell = clipConvexPolyhedron(cell, n, d, true, j);
    }
    if (cell) {
      const stats = measurePolyhedron(cell);
      if (stats.watertight && stats.volume > 1e-5) {
        rawCells.push({ siteIndex: i, role: sites[i].role, hardness: sites[i].hardness, poly: cell, stats });
      }
    }
  }

  // Ensure shard 0 is always the grounded basal stump; re-index surviving cells densely 0..K.
  rawCells.sort((a, b) => (a.siteIndex === 0 ? -1 : b.siteIndex === 0 ? 1 : a.siteIndex - b.siteIndex));
  const siteToShard = new Map();
  rawCells.forEach((entry, shardIdx) => siteToShard.set(entry.siteIndex, shardIdx));
  for (const entry of rawCells) {
    for (const f of entry.poly.faces) {
      if (f.raw && f.neighbor >= 0) {
        f.neighbor = siteToShard.get(f.neighbor) ?? -1;
      }
    }
  }
  return rawCells;
}

// The outer polyhedron as it is drawn: eight floats a corner (position, normal, how lit its facet is, its archetype's
// tag), every face a fan, its normals creased where facets meet at more than some fifteen degrees.
function buildNearPolyhedronVertices(outerPoly, archetype) {
  const out = [];
  const archTag = (archetype + 0.5) / ROCK_ARCHETYPES;
  // Crease-aware vertex normals on exterior faces so geological facets stay crisp while gentle bends smooth.
  const vIncident = Array.from({ length: outerPoly.vertices.length }, () => []);
  outerPoly.faces.forEach((f, fi) => {
    for (const v of f.v) vIncident[v].push(fi);
  });

  for (let fi = 0; fi < outerPoly.faces.length; fi++) {
    const face = outerPoly.faces[fi];
    const fn = face.n;
    const ring = face.v;
    for (let k = 1; k + 1 < ring.length; k++) {
      for (const v of [ring[0], ring[k], ring[k + 1]]) {
        let sx = 0, sy = 0, sz = 0;
        for (const nfi of vIncident[v]) {
          const nf = outerPoly.faces[nfi].n;
          if (dot3(nf, fn) >= 0.965) {
            sx += nf[0]; sy += nf[1]; sz += nf[2];
          }
        }
        const vn = (sx || sy || sz) ? norm3([sx, sy, sz]) : fn;
        const p = outerPoly.vertices[v];
        const heightTerm = Math.max(0, Math.min(1, (p[1] + 0.20) / 1.0));
        const upLight = 0.65 + 0.35 * Math.max(0, fn[1]);
        const shade = 0.42 + 0.56 * (heightTerm * 0.6 + upLight * 0.4);
        out.push(p[0], p[1], p[2], vn[0], vn[1], vn[2], shade, archTag);
      }
    }
  }
  return new Float32Array(out);
}

const templateCache = new Array(ROCK_ARCHETYPES).fill(null);

export function getBoulderCleavageTemplate(archetype = 0) {
  const arch = Math.max(0, Math.min(ROCK_ARCHETYPES - 1, archetype | 0));
  if (templateCache[arch]) return templateCache[arch];

  const outerPoly = buildOuterBoulderPolyhedron(arch);
  const outerStats = measurePolyhedron(outerPoly);
  const cells = decomposeBoulderCleavage(outerPoly, arch);
  const nearVertices = buildNearPolyhedronVertices(outerPoly, arch);

  // Pre-build ray-castable local outer triangles for exact intact boulder collision sweeps.
  const outerTriangles = [];
  for (const face of outerPoly.faces) {
    const ring = face.v;
    for (let i = 1; i + 1 < ring.length; i++) {
      outerTriangles.push({
        a: outerPoly.vertices[ring[0]],
        b: outerPoly.vertices[ring[i]],
        c: outerPoly.vertices[ring[i + 1]],
        n: face.n,
      });
    }
  }

  let shardVolumeSum = 0;
  for (const c of cells) shardVolumeSum += c.stats.volume;

  const template = Object.freeze({
    archetype: arch,
    outerPoly,
    outerStats,
    outerTriangles,
    cells,
    shardCount: cells.length,
    shardVolumeSum,
    nearVertices,
    nearVertexCount: nearVertices.length / 8,
  });
  templateCache[arch] = template;
  return template;
}

export function getAllBoulderCleavageTemplates() {
  const list = [];
  for (let a = 0; a < ROCK_ARCHETYPES; a++) list.push(getBoulderCleavageTemplate(a));
  return list;
}

// Builds a `building-fracture.js` `prepared` package ({ vertices, indices, fracture })
// for a specific struck ground-cover boulder in world coordinates.
// - shard 0: anchored basal stump (stays rooted in ground with RAW_SURFACE cleavage scar top faces)
// - shards 1..K: convex cleavage wedges & corner/brow spall chips with RAW_SURFACE = 1.6 interior faces
export function prepareBoulderFracture(boulder, {
  groundAt = () => 0,
  waterAt = null,
  instanceIndex = 0,
} = {}) {
  const archetype = boulder.archetype ?? rockArchetypeFromSeed(boulder.seed ?? 0, boulder.group ?? 0);
  const template = getBoulderCleavageTemplate(archetype);
  const basis = boulder.basis ?? boulderBasisFromInstance(
    boulder.x, boulder.y, boulder.z,
    boulder.radius, boulder.height, boulder.seed,
    boulder.sx ?? 0, boulder.sz ?? 0,
  );
  const originX = basis.origin[0], originY = basis.origin[1], originZ = basis.origin[2];
  const cosY = Math.cos(basis.yaw), sinY = Math.sin(basis.yaw);
  const toLocal = (wx, wy, wz) => {
    const dx = wx - originX, dz = wz - originZ;
    return [dx * cosY - dz * sinY, wy, dx * sinY + dz * cosY];
  };
  const toWorld = (lx, ly, lz) => [originX + lx * cosY + lz * sinY, ly, originZ - lx * sinY + lz * cosY];
  const stoneKind = buildingKindWithYaw(11, basis.yaw);
  const scaleDet = Math.max(1e-3, basis.scale[0] * basis.scale[1] * basis.scale[2]);

  const restList = [];
  const indexList = [];
  const shardTagList = [];
  const shards = [null]; // shard 0 is null (the anchored basal stump, never strikable / never flies away).

  for (let s = 0; s < template.cells.length; s++) {
    const cell = template.cells[s];
    const poly = cell.poly;
    const worldVerts = poly.vertices.map((lp) => boulderLocalToWorldPoint(basis, lp[0], lp[1], lp[2]));

    let wMin = [Infinity, Infinity, Infinity], wMax = [-Infinity, -Infinity, -Infinity];
    let lMin = [Infinity, Infinity, Infinity], lMax = [-Infinity, -Infinity, -Infinity];
    for (const wp of worldVerts) {
      const lp = toLocal(wp[0], wp[1], wp[2]);
      for (let c = 0; c < 3; c++) {
        if (wp[c] < wMin[c]) wMin[c] = wp[c];
        if (wp[c] > wMax[c]) wMax[c] = wp[c];
        if (lp[c] < lMin[c]) lMin[c] = lp[c];
        if (lp[c] > lMax[c]) lMax[c] = lp[c];
      }
    }

    const wCentroid = boulderLocalToWorldPoint(
      basis,
      cell.stats.centroid[0],
      cell.stats.centroid[1],
      cell.stats.centroid[2],
    );
    const outNormalSum = [0, 0, 0];
    const linksSet = new Set();
    let touchesStump = false;

    for (const face of poly.faces) {
      const rawScale = face.raw ? BOULDER_RAW_SURFACE : 1.0;
      const wn = boulderLocalToWorldNormal(
        basis,
        face.n[0] * rawScale,
        face.n[1] * rawScale,
        face.n[2] * rawScale,
      );
      if (!face.raw) {
        outNormalSum[0] += wn[0];
        outNormalSum[1] += wn[1];
        outNormalSum[2] += wn[2];
      } else if (face.neighbor === 0) {
        touchesStump = true;
      } else if (face.neighbor > 0 && face.neighbor !== s) {
        linksSet.add(face.neighbor);
      }

      const ring = face.v;
      const baseV = restList.length / FRACTURE_STRIDE;
      for (let i = 0; i < ring.length; i++) {
        const wp = worldVerts[ring[i]];
        const lp = poly.vertices[ring[i]];
        const heightTerm = Math.max(0, Math.min(1, (lp[1] + 0.20) / 1.0));
        const shade = face.raw
          ? 0.56 + 0.22 * heightTerm
          : 0.44 + 0.52 * (0.55 * heightTerm + 0.45 * Math.max(0, face.n[1] * 0.5 + 0.5));
        restList.push(wp[0], wp[1], wp[2], wn[0], wn[1], wn[2], stoneKind, shade);
        shardTagList.push(s);
      }
      for (let i = 1; i + 1 < ring.length; i++) {
        indexList.push(baseV, baseV + i, baseV + i + 1);
      }
    }

    if (s > 0) {
      const volume = Math.max(0.003, cell.stats.volume * scaleDet);
      const massKg = Math.max(4.5, volume * BOULDER_DENSITY_KG_M3);
      const fallbackDir = sub3(wCentroid, [originX, originY + 0.15 * basis.scale[1], originZ]);
      const normal = (outNormalSum[0] || outNormalSum[1] || outNormalSum[2])
        ? norm3(outNormalSum)
        : norm3(fallbackDir);
      const groundHere = groundAt(wCentroid[0], wCentroid[2]);
      shards.push({
        index: s,
        kind: BUILDING_SHARD_KINDS.block,
        partId: `boulder_${archetype}:${cell.role}`,
        partKey: `boulder_${cell.role}`,
        role: cell.role,
        hardness: cell.hardness,
        timber: false,
        earth: false,
        floorSlab: false,
        roof: false,
        ceiling: false,
        span: cell.role === 'core' ? 2 : 1,
        min: wMin,
        max: wMax,
        localMin: lMin,
        localMax: lMax,
        volume,
        massKg,
        centroid: wCentroid,
        normal,
        links: [...linksSet],
        above: [],
        below: [],
        side: [],
        anchored: Boolean(touchesStump || wMin[1] <= groundHere + 0.08),
      });
    }
  }

  // Populate vertical/lateral support relations across shared cleavage planes.
  // Outer spalls bond monolithically to adjacent interior core wedges so far-side spalls remain attached
  // when only the struck face chips away, while collapsing naturally if their supporting core wedge cleaves.
  for (let s = 1; s < shards.length; s++) {
    const a = shards[s];
    for (const nb of a.links) {
      if (nb <= s || !shards[nb]) continue;
      const b = shards[nb];
      if (a.role === 'spall' && b.role === 'core') {
        a.below.push(nb);
        b.above.push(s);
        continue;
      }
      if (b.role === 'spall' && a.role === 'core') {
        b.below.push(s);
        a.above.push(nb);
        continue;
      }
      const dy = a.centroid[1] - b.centroid[1];
      const minH = Math.min(a.localMax[1] - a.localMin[1], b.localMax[1] - b.localMin[1]);
      if (Math.abs(dy) > 0.32 * minH) {
        if (dy > 0) { a.below.push(nb); b.above.push(s); }
        else { b.below.push(s); a.above.push(nb); }
      } else {
        a.side.push(nb);
        b.side.push(s);
      }
    }
  }

  const rest = new Float32Array(restList);
  const vertexShards = new Uint32Array(shardTagList);
  const finalIndices = new Uint32Array(indexList);

  let rMin = [Infinity, Infinity, Infinity], rMax = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vertexShards.length; v++) {
    const at = v * FRACTURE_STRIDE;
    const lp = toLocal(rest[at], rest[at + 1], rest[at + 2]);
    for (let c = 0; c < 3; c++) {
      if (lp[c] < rMin[c]) rMin[c] = lp[c];
      if (lp[c] > rMax[c]) rMax[c] = lp[c];
    }
  }

  const floorAt = () => -Infinity;
  const fracture = Object.freeze({
    instanceIndex,
    prefabId: `boulder_arch_${archetype}`,
    boulder: true,
    density: BOULDER_DENSITY_KG_M3,
    toughness: BOULDER_TOUGHNESS,
    firstIndex: 0,
    indexCount: finalIndices.length,
    blockScale: 1,
    surface: Object.freeze({ vertices: rest, indices: finalIndices }),
    reach: Object.freeze({ min: rMin, max: rMax }),
    scale: Object.freeze([1, 1, 1]),
    shardCount: shards.length,
    vertexShards,
    shards: Object.freeze(shards),
    strikable: Object.freeze(shards.filter(Boolean).map((s) => s.index)),
    guns: Object.freeze([]),
    toLocal,
    toWorld,
    groundAt,
    waterAt,
    floorAt,
    originX,
    originZ,
  });

  return { vertices: rest, indices: finalIndices, fracture };
}

function rayTriangleHit(ox, oy, oz, dx, dy, dz, a, b, c) {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-10 && det < 1e-10) return Infinity;
  const inv = 1 / det;
  const sx = ox - a[0], sy = oy - a[1], sz = oz - a[2];
  const u = inv * (sx * px + sy * py + sz * pz);
  if (u < -1e-4 || u > 1 + 1e-4) return Infinity;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = inv * (dx * qx + dy * qy + dz * qz);
  if (v < -1e-4 || u + v > 1 + 1e-4) return Infinity;
  const t = inv * (e2x * qx + e2y * qy + e2z * qz);
  return t >= 0 && t <= 1 ? t : Infinity;
}

// Spatial field of active ground-cover boulders for exact roundshot sweep + on-demand fracture enrolment.
export function createBoulderField({
  getPort = null,
  groundAt = () => 0,
  waterAt = null,
  onBoulderHidden = null,
} = {}) {
  const bySlot = new Map();
  const grid = new Map();
  const fracturedByKey = new Map();
  const cellKey = (cx, cz) => (cx + 65536) * 131072 + (cz + 65536);
  const coordKey = (x, z, seed) => `${Math.round(x * 20)}:${Math.round(z * 20)}:${Math.round(seed * 10000)}`;

  const addGrid = (rec) => {
    const r = rec.boundRadius;
    const x0 = Math.floor((rec.x - r) / BOULDER_CELL_M), x1 = Math.floor((rec.x + r) / BOULDER_CELL_M);
    const z0 = Math.floor((rec.z - r) / BOULDER_CELL_M), z1 = Math.floor((rec.z + r) / BOULDER_CELL_M);
    rec.cells = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cellKey(cx, cz);
        rec.cells.push(k);
        let list = grid.get(k);
        if (!list) { list = []; grid.set(k, list); }
        list.push(rec);
      }
    }
  };

  const removeGrid = (rec) => {
    for (const k of rec.cells ?? []) {
      const list = grid.get(k);
      if (!list) continue;
      const idx = list.indexOf(rec);
      if (idx >= 0) list.splice(idx, 1);
      if (!list.length) grid.delete(k);
    }
    rec.cells = null;
  };

  let sweepStamp = 0;

  const enrolRecord = (rec) => {
    if (rec.enrolledInstance) return rec.enrolledInstance;
    const prepared = prepareBoulderFracture(rec, { groundAt, waterAt });
    const reach = prepared.fracture.reach;
    const instance = {
      id: `boulder_${rec.key}`,
      prefabId: `boulder_arch_${rec.archetype}`,
      label: 'Boulder',
      boulder: true,
      noRebuild: true,
      x: rec.x,
      y: rec.y,
      baseY: rec.y,
      z: rec.z,
      yaw: rec.basis.yaw,
      width: rec.radius * 2,
      depth: rec.radius * 2,
      length: rec.radius * 2,
      height: rec.height,
      foundationDepth: 0.35 * rec.height,
      roofHeight: 0,
      materialClass: 'masonry',
      damageState: {
        materialClass: 'masonry',
        hits: 0,
        forgivenHits: 0,
        damageJoules: 0,
        maxEnergy: 260000,
        integrity: 1,
        state: 'intact',
        partDamage: {},
        craters: [],
        pendingBakes: [],
        fires: [],
        worldFires: [],
        revision: 0,
      },
      fractureSource: () => {
        if (!rec.hiddenFromContinuum) {
          rec.hiddenFromContinuum = true;
          if (rec.slot >= 0) onBoulderHidden?.(rec.slot);
        }
        return { prepared };
      },
    };
    noteBuildingMesh(instance, {
      vertices: prepared.vertices,
      indices: prepared.indices,
      firstIndex: 0,
      endIndex: prepared.indices.length,
      min: reach.min,
      max: reach.max,
    });
    const port = typeof getPort === 'function' ? getPort(rec.x, rec.z) : null;
    if (port) {
      if (!Array.isArray(port.instances)) port.instances = [];
      port.instances.push(instance);
      rec.port = port;
    }
    rec.prepared = prepared;
    rec.enrolledInstance = instance;
    fracturedByKey.set(rec.key, rec);
    return instance;
  };

  return {
    get size() { return bySlot.size; },
    setInstances(slot, floats, slotGroups) {
      const count = Math.min(Math.floor(floats.length / SOURCE_INSTANCE_FLOATS), slotGroups.length);
      for (let i = 0; i < count; i++) {
        const s = slot + i;
        const prev = bySlot.get(s);
        if (prev) { removeGrid(prev); bySlot.delete(s); }
        const grp = slotGroups[i] >>> 0;
        if (grp >= 2 || grp === BOULDER_EMPTY_SLOT) continue;
        const o = i * SOURCE_INSTANCE_FLOATS;
        const x = floats[o], y = floats[o + 1], z = floats[o + 2], radius = floats[o + 3];
        const height = floats[o + 4], seed = floats[o + 5], sx = floats[o + 6], sz = floats[o + 7];
        if (!(radius > 0.05 && height > 0.05)) continue;
        const key = coordKey(x, z, seed);
        const existingFractured = fracturedByKey.get(key);
        if (existingFractured) {
          existingFractured.slot = s;
          if (existingFractured.hiddenFromContinuum) onBoulderHidden?.(s);
          bySlot.set(s, existingFractured);
          addGrid(existingFractured);
          continue;
        }
        const archetype = rockArchetypeFromSeed(seed, grp);
        const basis = boulderBasisFromInstance(x, y, z, radius, height, seed, sx, sz);
        const boundRadius = Math.hypot(radius * 1.05, height * 0.85) + 0.15;
        const center = boulderLocalToWorldPoint(basis, 0, 0.28, 0);
        const rec = {
          slot: s,
          key,
          group: grp,
          archetype,
          x, y, z, radius, height, seed, sx, sz,
          basis,
          center,
          boundRadius,
          cells: null,
          stamp: 0,
          hiddenFromContinuum: false,
          enrolledInstance: null,
          prepared: null,
          port: null,
        };
        bySlot.set(s, rec);
        addGrid(rec);
      }
    },
    // The rock at slot `slot`, or null: whether it is hidden from the continuum, standing as its pieces.
    recordAt(slot) { return bySlot.get(slot) ?? null; },
    clearSlots(slot, count = 1) {
      for (let i = 0; i < count; i++) {
        const s = slot + i;
        const rec = bySlot.get(s);
        if (!rec) continue;
        removeGrid(rec);
        bySlot.delete(s);
        if (rec.enrolledInstance) rec.slot = -1;
      }
    },
    sweepBoulderSegment(from, to, radius = 0.08, options = null) {
      if (!grid.size && !fracturedByKey.size) return null;
      const stamp = ++sweepStamp;
      const x0 = from[0], y0 = from[1], z0 = from[2];
      const x1 = to[0], y1 = to[1], z1 = to[2];
      const segMinY = Math.min(y0, y1) - radius;
      const segMaxY = Math.max(y0, y1) + radius;
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      const segLenSq = dx * dx + dy * dy + dz * dz;

      let cx = Math.floor(x0 / BOULDER_CELL_M), cz = Math.floor(z0 / BOULDER_CELL_M);
      const ex = Math.floor(x1 / BOULDER_CELL_M), ez = Math.floor(z1 / BOULDER_CELL_M);
      const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
      let tx = dx === 0 ? Infinity : ((cx + (dx > 0 ? 1 : 0)) * BOULDER_CELL_M - x0) / dx;
      let tz = dz === 0 ? Infinity : ((cz + (dz > 0 ? 1 : 0)) * BOULDER_CELL_M - z0) / dz;
      const dtx = dx === 0 ? Infinity : BOULDER_CELL_M / Math.abs(dx);
      const dtz = dz === 0 ? Infinity : BOULDER_CELL_M / Math.abs(dz);

      let best = null;
      const testRecord = (rec) => {
        if (rec.stamp === stamp) return;
        rec.stamp = stamp;
        const br = rec.boundRadius + radius;
        if (segMaxY < rec.center[1] - br || segMinY > rec.center[1] + br) return;
        // Quick closest-point sphere reject.
        const tProj = segLenSq > 1e-9
          ? Math.max(0, Math.min(1, ((rec.center[0] - x0) * dx + (rec.center[1] - y0) * dy + (rec.center[2] - z0) * dz) / segLenSq))
          : 0;
        const qx = x0 + dx * tProj - rec.center[0];
        const qy = y0 + dy * tProj - rec.center[1];
        const qz = z0 + dz * tProj - rec.center[2];
        if (qx * qx + qy * qy + qz * qz > br * br) return;

        if (rec.enrolledInstance) {
          const hit = traceShotAtBuilding(rec.enrolledInstance, from, to);
          if (hit && Number.isFinite(hit.t) && hit.t >= 0 && hit.t <= 1 && (!best || hit.t < best.fraction)) {
            best = {
              fraction: hit.t,
              kind: 'scenery',
              sceneryType: 'boulder',
              boulder: rec,
              slot: rec.slot,
              archetype: rec.archetype,
              sceneryPos: [...rec.center],
              position: [x0 + dx * hit.t, y0 + dy * hit.t, z0 + dz * hit.t],
              normal: hit.normal ?? [0, 1, 0],
            };
          }
          return;
        }

        // Transform segment into boulder local frame (inflated by shot radius) and sweep exact cleavage triangles.
        const inflateX = 1 + radius / Math.max(0.2, rec.radius);
        const inflateY = 1 + radius / Math.max(0.2, rec.height);
        const l0 = boulderWorldToLocalPoint(rec.basis, x0, y0, z0);
        const l1 = boulderWorldToLocalPoint(rec.basis, x1, y1, z1);
        const ox = l0[0] / inflateX, oy = l0[1] / inflateY, oz = l0[2] / inflateX;
        const rdx = l1[0] / inflateX - ox, rdy = l1[1] / inflateY - oy, rdz = l1[2] / inflateX - oz;
        const tris = getBoulderCleavageTemplate(rec.archetype).outerTriangles;
        let hitT = Infinity, hitTri = null;
        for (let tIdx = 0; tIdx < tris.length; tIdx++) {
          const tri = tris[tIdx];
          const t = rayTriangleHit(ox, oy, oz, rdx, rdy, rdz, tri.a, tri.b, tri.c);
          if (t < hitT) {
            hitT = t;
            hitTri = tri;
          }
        }
        if (hitTri && (!best || hitT < best.fraction)) {
          const wn = norm3(boulderLocalToWorldNormal(rec.basis, hitTri.n[0], hitTri.n[1], hitTri.n[2]));
          best = {
            fraction: hitT,
            kind: 'scenery',
            sceneryType: 'boulder',
            boulder: rec,
            slot: rec.slot,
            archetype: rec.archetype,
            sceneryPos: [...rec.center],
            position: [x0 + dx * hitT, y0 + dy * hitT, z0 + dz * hitT],
            normal: wn,
          };
        }
      };

      const maxSteps = Math.abs(ex - cx) + Math.abs(ez - cz) + 2;
      for (let step = 0; step < maxSteps; step++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (let oz = -1; oz <= 1; oz++) {
            const list = grid.get(cellKey(cx + ox, cz + oz));
            if (list) for (let i = 0; i < list.length; i++) testRecord(list[i]);
          }
        }
        if (cx === ex && cz === ez) break;
        if (tx < tz) { cx += stepX; tx += dtx; }
        else { cz += stepZ; tz += dtz; }
      }

      void options;
      return best;
    },
    strikeBoulder(event) {
      if (!event) return null;
      const pos = event.position ?? event.surfacePosition ?? event.sceneryPos;
      if (!pos) return null;
      const energy = event.energy ?? 120000;
      const normal = event.normal ?? [0, 1, 0];

      const targets = [];
      if (event.boulder) {
        targets.push({ rec: event.boulder, hitPos: pos, hitNormal: normal, scale: 1.0 });
      } else if (Number.isInteger(event.slot) && bySlot.has(event.slot)) {
        targets.push({ rec: bySlot.get(event.slot), hitPos: pos, hitNormal: normal, scale: 1.0 });
      } else {
        const reach = Math.max(1.8, event.blastRadius ?? 2.6);
        const cx0 = Math.floor((pos[0] - reach) / BOULDER_CELL_M), cx1 = Math.floor((pos[0] + reach) / BOULDER_CELL_M);
        const cz0 = Math.floor((pos[2] - reach) / BOULDER_CELL_M), cz1 = Math.floor((pos[2] + reach) / BOULDER_CELL_M);
        const seen = new Set();
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let cz = cz0; cz <= cz1; cz++) {
            const list = grid.get(cellKey(cx, cz));
            if (!list) continue;
            for (const rec of list) {
              if (seen.has(rec)) continue;
              seen.add(rec);
              const d = Math.hypot(rec.center[0] - pos[0], rec.center[1] - pos[1], rec.center[2] - pos[2]);
              if (d <= reach + rec.boundRadius) {
                const dir = norm3([rec.center[0] - pos[0], 0.35, rec.center[2] - pos[2]]);
                const surfacePt = [
                  rec.center[0] - dir[0] * rec.radius * 0.72,
                  rec.center[1],
                  rec.center[2] - dir[2] * rec.radius * 0.72,
                ];
                const fall = Math.max(0.45, 1 - d / (reach + rec.boundRadius + 0.5));
                targets.push({ rec, hitPos: surfacePt, hitNormal: dir, scale: fall });
              }
            }
          }
        }
      }

      if (!targets.length) return null;
      let enrolledCount = 0;
      for (const { rec, hitPos, hitNormal, scale } of targets) {
        const instance = enrolRecord(rec);
        const effEnergy = energy * scale;
        const severity = Math.min(1.38, Math.max(0.58, Math.cbrt(effEnergy / 95000) * 0.92));
        const sizeScale = Math.min(1.35, Math.max(0.65, rec.radius));
        const craterRadius = Math.min(rec.boundRadius * 0.72, Math.max(0.42, (0.34 + severity * 0.36) * sizeScale));
        const stepDepth = (event.blastOnly ? 0.26 : 0.38) * sizeScale;
        instance.damageState.pendingBakes.push({
          kind: 'stone-crater',
          x: +hitPos[0].toFixed(3),
          y: +hitPos[1].toFixed(3),
          z: +hitPos[2].toFixed(3),
          nx: +(hitNormal[0] ?? 0).toFixed(3),
          ny: +(hitNormal[1] ?? 1).toFixed(3),
          nz: +(hitNormal[2] ?? 0).toFixed(3),
          radius: +craterRadius.toFixed(3),
          stepDepth,
          severity: +severity.toFixed(3),
          materialClass: 'stone',
        });
        enrolledCount++;
      }
      return {
        chipped: enrolledCount > 0,
        targetsStruck: enrolledCount,
        boulderInstance: targets[0].rec.enrolledInstance,
      };
    },
  };
}

// ------------------------------------------------------------------------------------------------ the continuum
export const BOULDER_CONTINUUM_FORMAT = 'waterworld.boulder-continuum';
// A boulder manifest is of the atlas's own version: a rebake is the only way to a new one.
export const BOULDER_CONTINUUM_VERSION = CONTINUUM_ATLAS_VERSION;
// A boulder type's material block (js/continuum-format.js CONTINUUM_TYPE.material): its archetype's tag,
// (archetype + 0.5) / ROCK_ARCHETYPES (f32), by which its lithology is chosen.
export const BOULDER_CONTINUUM_MATERIAL = Object.freeze({ archetype: CONTINUUM_TYPE.material });
// One type an archetype, in archetype order.
export const BOULDER_CONTINUUM_TYPES = Object.freeze(Array.from({ length: ROCK_ARCHETYPES }, (_, archetype) => `boulder-${archetype}`));
// The land's resources (js/terrain.js nearResources) the boulders' material binds in its group 0
// (js/wgsl/boulder-continuum.js).
export const BOULDER_CONTINUUM_BINDINGS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 19, 20, 21, 24]);
// The baked atlas and its manifest. Spelled out, not composed, because the build publishes (and versions) only the
// asset paths it finds quoted in the source. Both are kept in git: boulders are drawn from nothing else.
export const BOULDER_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/boulder-continuum/manifest.json',
  'atlas.bin.gz': 'assets/boulder-continuum/atlas.bin.gz',
});

// An archetype as the bake reads a type: its outer polyhedron, the very triangles a shot is swept against, eight
// floats a corner (position, normal, its facet's light and its archetype's tag), one part. It is closed and convex,
// so it is its own far body's base.
export function boulderContinuumSource(archetype) {
  const { nearVertices } = getBoulderCleavageTemplate(archetype);
  const triangles = nearVertices.length / 24;
  return { name: BOULDER_CONTINUUM_TYPES[archetype], vertices: Float32Array.from(nearVertices), triangles, parts: new Uint32Array(triangles), closed: true };
}

// How a boulder body is packed (js/continuum-format.js packContinuumBody): each point's facet light in its word (f32),
// each far triangle's that of the surface nearest it, and its archetype's tag.
export function packBoulderContinuumBody({ triangles, archetype }, baked) {
  const { welded, far } = baked;
  return packContinuumBody({
    triangles,
    material: [continuumFloatWord((archetype + 0.5) / ROCK_ARCHETYPES)],
    vertex: (v) => ({ word: continuumFloatWord(welded.kind[v * 2]) }),
    farWord: (t) => continuumFloatWord(far.kinds[t * 2]),
  }, baked);
}

export function validateBoulderContinuumManifest(manifest) {
  if (manifest?.format !== BOULDER_CONTINUUM_FORMAT || manifest.version !== BOULDER_CONTINUUM_VERSION) throw Error('Invalid boulder continuum manifest: rebake it');
  const { types, atlas } = manifest;
  if (!Array.isArray(types) || types.length !== BOULDER_CONTINUUM_TYPES.length) throw Error('The boulder continuum holds the wrong types');
  types.forEach((type, id) => {
    if (type.id !== id || type.name !== BOULDER_CONTINUUM_TYPES[id] || !/^[0-9a-f]{64}$/.test(type.fingerprint ?? '')) throw Error(`Boulder continuum type ${id} is malformed`);
    if (!(type.clusters?.count > 0) || !(type.chain?.baseTriangles >= 4) || !(type.chain.steps >= 1 && type.chain.steps < CONTINUUM_NEVER)) throw Error(`Boulder continuum type ${id} is incomplete`);
  });
  if (!(atlas?.words > CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4 || !/^[0-9a-f]{64}$/.test(atlas.sha256 ?? '') || !atlas.gzip?.file) throw Error('The boulder continuum atlas is malformed');
  return manifest;
}

// The atlas, fetched, unpacked and checked against its receipt and the cut. Resolves to { manifest, words }.
export function loadBoulderContinuum({ fetchAsset = fetch } = {}) {
  return loadContinuumAtlas({ assets: BOULDER_CONTINUUM_ASSETS, validate: validateBoulderContinuumManifest, label: 'boulder', fetchAsset });
}
// The atlas, fetched and uploaded once a device.
export function requestBoulderContinuumAtlas(device, fetchAsset = fetch) {
  return requestContinuumAtlas(device, 'boulder', () => loadBoulderContinuum({ fetchAsset }));
}

// The unit quaternion of an orthonormal, right-handed basis (its columns the basis's axes).
function boulderTurn({ axisX: x, axisY: y, axisZ: z }) {
  const trace = x[0] + y[1] + z[2];
  let q;
  if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4]; }
  else if (x[0] > y[1] && x[0] > z[2]) { const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2; q = [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
  else if (y[1] > z[2]) { const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2; q = [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
  else { const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2; q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s]; }
  const l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
}

// The ground cover's rocks, every one a RIGID record of the one cut: its archetype's type, stretched to its radius
// and height, turned to its basis, stood on the ground the land draws (CONTINUUM_GROUNDED), and cut at the scene's
// one pixel error. Ground cover lays its rocks in slots (`capacity` of them; js/terrain.js groundCoverInstances, a
// block of slots a patch); the records are kept dense, the last moved into any one let go. A rock shot apart is let
// go as its pieces take its place (js/building-fracture.js, which draws them SHARDED). `view` is the boulders'
// material's view (js/wgsl/boulder-continuum.js), `resources` the land's (js/terrain.js nearResources).
export function createBoulderContinuum({ device, atlas, programs, view, frame, shadowUniform, resources, capacity, samples = 4, getPort = null, groundAt = () => 0, waterAt = null }) {
  // Room for every rock to be of the heaviest archetype.
  const heaviest = { clusters: Math.max(...atlas.types.map((type) => type.clusters)), farChunks: Math.max(...atlas.types.map((type) => type.farChunks)) };
  const { room } = continuumRoom([heaviest], [capacity]);
  const scene = createContinuumScene({ device, atlas, programs, capacity, room, view, poseRoom: capacity, frame, shadowUniform, samples, label: 'boulders' });
  const W = CONTINUUM_RECORD_WORDS, R = CONTINUUM_RECORD;
  const slotRecord = new Int32Array(capacity).fill(-1), recordSlot = new Int32Array(capacity).fill(-1);
  const stretches = new Float32Array(Math.max(1, capacity) * 4);
  let count = 0, dirtyFrom = Infinity, dirtyTo = -1, shiftX = 0, shiftZ = 0;
  const touch = (r) => { dirtyFrom = Math.min(dirtyFrom, r); dirtyTo = Math.max(dirtyTo, r); };
  const add = (slot, x, y, z, radius, height, seed, sx, sz, group) => {
    const basis = boulderBasisFromInstance(x, y, z, radius, height, seed, sx, sz), r = count++;
    slotRecord[slot] = r; recordSlot[r] = slot;
    stretches.set([radius, height, radius, 0], r * 4);
    scene.place(r, {
      position: [x, y, z], turn: boulderTurn(basis), type: rockArchetypeFromSeed(seed, group), flags: CONTINUUM_STRETCHED | CONTINUUM_GROUNDED,
      pose: r, seed: Math.floor(seed * 0xffffffff) >>> 0, identity: seed,
    });
    touch(r);
  };
  const remove = (slot) => {
    if (!(slot >= 0 && slot < capacity)) return;
    const r = slotRecord[slot];
    if (r < 0) return;
    const last = --count;
    slotRecord[slot] = -1;
    if (r !== last) {
      const moved = recordSlot[last];
      scene.words.copyWithin(r * W, last * W, (last + 1) * W);
      scene.words[r * W + R.pose] = r;
      stretches.copyWithin(r * 4, last * 4, last * 4 + 4);
      slotRecord[moved] = r; recordSlot[r] = moved;
      touch(r);
    }
    recordSlot[last] = -1;
  };
  const flush = () => {
    if (dirtyTo >= dirtyFrom && dirtyFrom < count) {
      const to = Math.min(dirtyTo, count - 1);
      scene.send(dirtyFrom, to - dirtyFrom + 1);
      scene.writePoses(dirtyFrom, stretches.subarray(dirtyFrom * 4, (to + 1) * 4));
    }
    dirtyFrom = Infinity; dirtyTo = -1;
    scene.setCount(count);
  };
  const field = createBoulderField({ getPort, groundAt, waterAt, onBoulderHidden: (slot) => { remove(slot); flush(); } });
  const group1 = device.createBindGroup({ label: 'boulders unused', layout: view.pipeline.getBindGroupLayout(1), entries: [] });
  let group0 = null;
  const rebind = (next) => {
    group0 = device.createBindGroup({
      label: 'boulders land', layout: view.pipeline.getBindGroupLayout(0),
      entries: next.filter(([binding]) => BOULDER_CONTINUUM_BINDINGS.includes(binding)).map(([binding, resource]) => ({ binding, resource })),
    });
  };
  rebind(resources);
  const toLocal = (p) => (Array.isArray(p) ? [p[0] - shiftX, p[1], p[2] - shiftZ] : p);
  const toWorld = (p) => [p[0] + shiftX, p[1], p[2] + shiftZ];
  return {
    capacity,
    get activeCount() { return count; },
    field,
    rebind,
    // Slots `slot`.. laid anew from ground cover's rocks (SOURCE_INSTANCE_FLOATS a rock) and their groups: a group of 2
    // or more, or BOULDER_EMPTY_SLOT, lays none.
    setInstances(slot, floats, slotGroups) {
      if (!slotGroups?.length || !floats) return;
      const n = Math.min(slotGroups.length, capacity - Math.max(0, slot), Math.floor(floats.length / SOURCE_INSTANCE_FLOATS));
      for (let i = 0; i < n; i++) remove(slot + i);
      const laid = new Uint32Array(slotGroups.length).fill(BOULDER_EMPTY_SLOT);
      for (let i = 0; i < n; i++) if ((slotGroups[i] >>> 0) < 2) laid[i] = slotGroups[i] >>> 0;
      field.setInstances(slot, floats, laid);
      for (let i = 0; i < n; i++) {
        const group = laid[i], o = i * SOURCE_INSTANCE_FLOATS;
        if (group === BOULDER_EMPTY_SLOT || field.recordAt(slot + i)?.hiddenFromContinuum) continue;
        const [x, y, z, radius, height, seed, sx, sz] = floats.subarray(o, o + SOURCE_INSTANCE_FLOATS);
        if (!(radius > 0.02 && height > 0.02)) continue;
        add(slot + i, x, y, z, radius, height, seed, sx, sz, group);
      }
      flush();
    },
    clearSlots(slot, n = 1) {
      const end = Math.min(capacity, slot + n);
      for (let s = Math.max(0, slot); s < end; s++) remove(s);
      flush();
      field.clearSlots(slot, n);
    },
    clearSlot(slot) { remove(slot); flush(); },
    setWorldOffset(x = 0, z = 0) {
      shiftX = Number.isFinite(x) ? x : 0; shiftZ = Number.isFinite(z) ? z : 0;
      scene.setWorldOffset(shiftX, shiftZ);
    },
    setAim(fall) { scene.setAim(fall); },
    // A shot's sweep and strike, in the world's frame; the rocks lie in the scene's.
    sweepBoulderSegment(from, to, radius = 0.08, options = null) {
      const hit = field.sweepBoulderSegment(toLocal(from), toLocal(to), radius, options);
      return hit && (shiftX || shiftZ) ? { ...hit, sceneryPos: toWorld(hit.sceneryPos), position: toWorld(hit.position) } : hit;
    },
    strikeBoulder(event) {
      if (!event) return null;
      return field.strikeBoulder(shiftX || shiftZ ? { ...event, position: toLocal(event.position), surfacePosition: toLocal(event.surfacePosition), sceneryPos: toLocal(event.sceneryPos) } : event);
    },
    // In the frame's compute pass, after the land's, whose drawn ground the rocks stand on.
    encode(pass) { scene.encode(pass); },
    draw(pass) { scene.draw(pass, group0, group1); },
    drawShadow(pass) { scene.drawShadow(pass); },
    continuumDraws() { return scene.continuumDraws(); },
    destroy() { scene.destroy(); },
  };
}
