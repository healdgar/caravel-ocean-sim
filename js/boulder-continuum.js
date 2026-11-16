// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Physical 3D geological cleavage boulder decomposition, ballistic ray-sweep & fracture enrolment,
// and 4-stage GPU Continuous Splat Decimation (Near/Mid polyhedron -> MSAA sample_mask crossfade ->
// genus-0 progressive half-edge collapse continuum -> 1-triangle horizon splat with stochastic thinning).

import { FRAME_WGSL, ATMO_CORE_WGSL } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { SHADOW_FRAME } from './wgsl/shadows.js';
import { ROCK_ARCHETYPES, rockArchetypeFromSeed } from './vegetation.js';
import { BUILDING_SHARD_KINDS, buildingKindWithYaw, noteBuildingMesh, traceShotAtBuilding } from './building-fracture.js';

export const BOULDER_DENSITY_KG_M3 = 2650;
export const BOULDER_TOUGHNESS = 1.35;
export const BOULDER_BAND_START_PX = 16.0;
export const BOULDER_BAND_END_PX = 10.5;
export const BOULDER_SPLAT_HANDOFF_PX = 4.5;
export const BOULDER_SPLAT_PIXELS = 3.5;
export const BOULDER_MIN_PIXELS = 1.0;

const BOULDER_RAW_SURFACE = 1.6;
const BOULDER_RAW_LENGTH_SQUARED = 2.0;
const FRACTURE_STRIDE = 8;
const CONTINUUM_INSTANCE_FLOATS = 12;
const CONTINUUM_INSTANCE_BYTES = CONTINUUM_INSTANCE_FLOATS * 4;
const SOURCE_INSTANCE_FLOATS = 8;
const SOURCE_INSTANCE_BYTES = SOURCE_INSTANCE_FLOATS * 4;
const BOULDER_DRAW_WORDS = 4;
const BOULDER_EMPTY_SLOT = 0xffffffff;
const MAX_MORPH_STEPS = 48;
const MAX_POLY_VERTS = 64;
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

// Builds a closed genus-0 progressive half-edge collapse continuum from the outer boulder polyhedron
// down to a minimal 4–6 triangle closed tetrahedron/bipyramid core, plus integrated horizon splat optics.
function buildBoulderMorphContinuum(outerPoly, archetype) {
  const baseVerts = outerPoly.vertices.map((p) => [p[0], p[1], p[2]]);
  const baseTris = [];
  const vertNormals = Array.from({ length: baseVerts.length }, () => [0, 0, 0]);
  let totalArea = 0;
  let weightedNormalY = 0;

  for (const face of outerPoly.faces) {
    const ring = face.v;
    for (let i = 1; i + 1 < ring.length; i++) {
      const a = ring[0], b = ring[i], c = ring[i + 1];
      baseTris.push([a, b, c]);
      const ab = sub3(baseVerts[b], baseVerts[a]);
      const ac = sub3(baseVerts[c], baseVerts[a]);
      const cr = cross3(ab, ac);
      const area2 = Math.hypot(cr[0], cr[1], cr[2]);
      totalArea += 0.5 * area2;
      weightedNormalY += 0.5 * cr[1];
      for (const v of [a, b, c]) {
        vertNormals[v][0] += cr[0];
        vertNormals[v][1] += cr[1];
        vertNormals[v][2] += cr[2];
      }
    }
  }
  for (let v = 0; v < vertNormals.length; v++) {
    vertNormals[v] = norm3(vertNormals[v]);
  }

  const baseStats = measurePolyhedron(outerPoly);
  const vCount = baseVerts.length;
  const curMap = Int32Array.from({ length: vCount }, (_, i) => i);
  const activeTris = baseTris.map((t) => [t[0], t[1], t[2]]);

  const stepMaps = [Int32Array.from(curMap)];
  const stepErrors = [0];
  const stepScales = [1.0];

  const computeMappedVolume = (tris, map) => {
    let vol6 = 0;
    const ref = baseVerts[map[tris[0][0]]];
    for (const [ta, tb, tc] of tris) {
      const a = map[ta], b = map[tb], c = map[tc];
      if (a === b || b === c || c === a) continue;
      const p0 = sub3(baseVerts[a], ref);
      const p1 = sub3(baseVerts[b], ref);
      const p2 = sub3(baseVerts[c], ref);
      vol6 += dot3(p0, cross3(p1, p2));
    }
    return Math.max(1e-5, vol6 / 6);
  };

  let curActiveTris = activeTris.slice();
  let accumErr = 0;
  for (let step = 0; step < MAX_MORPH_STEPS - 1; step++) {
    if (curActiveTris.length <= 6) break;
    // Build vertex adjacency on current active mesh.
    const adj = new Map();
    const ensureSet = (v) => {
      let s = adj.get(v);
      if (!s) { s = new Set(); adj.set(v, s); }
      return s;
    };
    for (const [a, b, c] of curActiveTris) {
      ensureSet(a).add(b); ensureSet(a).add(c);
      ensureSet(b).add(a); ensureSet(b).add(c);
      ensureSet(c).add(a); ensureSet(c).add(b);
    }
    if (adj.size <= 4) break;

    let bestU = -1, bestW = -1, bestCost = Infinity, bestEdgeLen = 0;
    for (const [u, neighbors] of adj) {
      for (const w of neighbors) {
        if (u === w) continue;
        // Manifold link condition: |N(u) ∩ N(w)| must equal 2 so collapsing u -> w never pinches an edge.
        const nw = adj.get(w);
        if (!nw) continue;
        let shared = 0;
        for (const x of neighbors) if (nw.has(x)) shared++;
        if (shared !== 2) continue;

        let valid = true;
        let maxFlipPenalty = 0;
        for (const [a, b, c] of curActiveTris) {
          if (a !== u && b !== u && c !== u) continue;
          if (a === w || b === w || c === w) continue;
          const na = a === u ? w : a;
          const nb = b === u ? w : b;
          const nc = c === u ? w : c;
          const oldCross = cross3(sub3(baseVerts[b], baseVerts[a]), sub3(baseVerts[c], baseVerts[a]));
          const newCross = cross3(sub3(baseVerts[nb], baseVerts[na]), sub3(baseVerts[nc], baseVerts[na]));
          const oldLen = Math.hypot(oldCross[0], oldCross[1], oldCross[2]);
          const newLen = Math.hypot(newCross[0], newCross[1], newCross[2]);
          if (newLen < 1e-6) { valid = false; break; }
          const cosang = dot3(oldCross, newCross) / (oldLen * newLen);
          if (cosang < 0.22) { valid = false; break; }
          const pen = 1 - cosang;
          if (pen > maxFlipPenalty) maxFlipPenalty = pen;
        }
        if (!valid) continue;

        const pu = baseVerts[u], pw = baseVerts[w];
        const edgeLen = Math.hypot(pu[0] - pw[0], pu[1] - pw[1], pu[2] - pw[2]);
        // Prefer collapsing interior/upper facets into grounded silhouette anchors.
        const basalPenalty = pu[1] < -0.08 && pw[1] > 0.05 ? 0.35 : 0;
        const cost = edgeLen * (1 + 0.85 * maxFlipPenalty) + basalPenalty;
        if (cost < bestCost) {
          bestCost = cost;
          bestU = u;
          bestW = w;
          bestEdgeLen = edgeLen;
        }
      }
    }

    if (bestU < 0) break;

    for (let v = 0; v < vCount; v++) {
      if (curMap[v] === bestU) curMap[v] = bestW;
    }
    const nextTris = [];
    for (const [a, b, c] of curActiveTris) {
      const na = a === bestU ? bestW : a;
      const nb = b === bestU ? bestW : b;
      const nc = c === bestU ? bestW : c;
      if (na === nb || nb === nc || nc === na) continue;
      nextTris.push([na, nb, nc]);
    }
    if (nextTris.length < 4) break;
    curActiveTris = nextTris;

    accumErr = Math.max(accumErr + 1e-4, accumErr * 0.35 + bestEdgeLen);
    const curVol = computeMappedVolume( baseTris, curMap );
    const silScale = Math.min(1.24, Math.max(1.0, Math.cbrt(baseStats.volume / curVol)));

    stepMaps.push(Int32Array.from(curMap));
    stepErrors.push(accumErr);
    stepScales.push(silScale);
  }

  const maxErr = Math.max(1e-4, stepErrors[stepErrors.length - 1]);
  const normThresholds = stepErrors.map((e) => e / maxErr);

  // Compute step-specific smoothed vertex normals for continuous optical shading across collapse steps.
  const stepVertNormals = stepMaps.map((map, stepIdx) => {
    const accum = Array.from({ length: vCount }, () => [0, 0, 0]);
    for (const [ta, tb, tc] of baseTris) {
      const a = map[ta], b = map[tb], c = map[tc];
      if (a === b || b === c || c === a) continue;
      const cr = cross3(sub3(baseVerts[b], baseVerts[a]), sub3(baseVerts[c], baseVerts[a]));
      accum[a][0] += cr[0]; accum[a][1] += cr[1]; accum[a][2] += cr[2];
      accum[b][0] += cr[0]; accum[b][1] += cr[1]; accum[b][2] += cr[2];
      accum[c][0] += cr[0]; accum[c][1] += cr[1]; accum[c][2] += cr[2];
    }
    const out = new Array(vCount);
    for (let v = 0; v < vCount; v++) {
      const mv = map[v];
      const n = accum[mv];
      out[v] = (n[0] || n[1] || n[2]) ? norm3(n) : vertNormals[mv];
      // Blend silhouette preservation scale around boulder centroid.
      void stepIdx;
    }
    return out;
  });

  // Integrated stone palette per archetype (granite, limestone, ironstone, basalt, gneiss, sandstone).
  const ARCHETYPE_COLOURS = [
    [0.46, 0.45, 0.43],
    [0.54, 0.51, 0.45],
    [0.48, 0.41, 0.35],
    [0.33, 0.34, 0.36],
    [0.43, 0.44, 0.41],
    [0.51, 0.46, 0.39],
  ];
  const meanColour = ARCHETYPE_COLOURS[archetype % ARCHETYPE_COLOURS.length];
  const splatOptics = Object.freeze({
    centre: Object.freeze([...baseStats.centroid]),
    rx: +((baseStats.max[0] - baseStats.min[0] + baseStats.max[2] - baseStats.min[2]) * 0.27).toFixed(4),
    ry: +((baseStats.max[1] - baseStats.min[1]) * 0.52).toFixed(4),
    colour: Object.freeze(meanColour),
    ambientResponse: +(0.58 + 0.22 * Math.max(0, weightedNormalY / Math.max(1e-4, totalArea))).toFixed(4),
  });

  return Object.freeze({
    archetype,
    baseVerts,
    baseTris,
    vertNormals,
    numSteps: stepMaps.length - 1,
    coreTriCount: curActiveTris.length,
    stepMaps,
    stepVertNormals,
    stepErrors,
    normThresholds,
    stepScales,
    centroid: baseStats.centroid,
    splatOptics,
  });
}

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
  const morph = buildBoulderMorphContinuum(outerPoly, arch);
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
    morph,
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

// Builds a `building-fracture.js` `prepared` package ({ vertices, initial, indices, fracture })
// for a specific struck ground-cover boulder in world coordinates.
// - shard 0: anchored basal stump (stays rooted in ground with RAW_SURFACE cleavage scar top faces)
// - shards 1..K: convex cleavage wedges & corner/brow spall chips with RAW_SURFACE = 1.6 interior faces
//   collapsed in `initial` until a neighboring shard breaks away!
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
  const initial = rest.slice();
  const vertexShards = new Uint32Array(shardTagList);
  const finalIndices = new Uint32Array(indexList);

  // Collapse RAW_SURFACE interior cleavage faces of strikable shards 1..K to shard centroids while unexposed.
  // Shard 0's RAW_SURFACE scar faces stay open inside shards 1..K so they appear immediately as a raw cleavage scar!
  for (let v = 0; v < vertexShards.length; v++) {
    const s = vertexShards[v];
    if (!s) continue;
    const at = v * FRACTURE_STRIDE;
    const n2 = rest[at + 3] * rest[at + 3] + rest[at + 4] * rest[at + 4] + rest[at + 5] * rest[at + 5];
    if (n2 < BOULDER_RAW_LENGTH_SQUARED) continue;
    const c = shards[s].centroid;
    initial[at] = c[0];
    initial[at + 1] = c[1];
    initial[at + 2] = c[2];
  }

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

  return { vertices: rest, initial, indices: finalIndices, fracture };
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

// ============================================================================
// 4-Stage GPU Boulder Continuum (AGENTS.md Rules 2 & 3)
//   Stage 1 (>= 16.0 px): Near/Mid full physical cleavage polyhedron (`lod 0`)
//   Stage 2 (16.0 -> 10.5 px): Deterministic MSAA @builtin(sample_mask) crossfade (zero discard)
//   Stage 3 (10.5 -> 3.5 px): Genus-0 progressive half-edge collapse continuum (`boulderMorph` -> 4-6 core tris)
//   Stage 4 (< 3.5 px): 1-triangle view-facing horizon splat + < 1.0 px stochastic thinning w/ inverseSqrt(keepProb) inflation
// ============================================================================

function packMorphGpuData() {
  const templates = getAllBoulderCleavageTemplates();
  let maxTris = 0;
  for (const t of templates) {
    if (t.morph.baseTris.length > maxTris) maxTris = t.morph.baseTris.length;
  }
  const vertsPerArchStep = MAX_POLY_VERTS;
  const floatsPerVert = 8; // pos.xyz, silScale, normal.xyz, shade
  const tableFloats = new Float32Array(ROCK_ARCHETYPES * MAX_MORPH_STEPS * vertsPerArchStep * floatsPerVert);
  const stepMeta = new Float32Array(ROCK_ARCHETYPES * MAX_MORPH_STEPS * 4); // normThreshold, silScale, numSteps, archTag
  const morphVertexAttribs = [];

  // Static corner buffer for morph draws: each vertex carries (baseVertIdx, archTag) per archetype slice.
  for (let arch = 0; arch < ROCK_ARCHETYPES; arch++) {
    const t = templates[arch];
    const m = t.morph;
    const archTag = (arch + 0.5) / ROCK_ARCHETYPES;

    for (let s = 0; s < MAX_MORPH_STEPS; s++) {
      const clampedS = Math.min(s, m.numSteps);
      const map = m.stepMaps[clampedS];
      const nrms = m.stepVertNormals[clampedS];
      const silScale = m.stepScales[clampedS];
      const thresh = s <= m.numSteps ? m.normThresholds[s] : 1.0;

      const metaBase = (arch * MAX_MORPH_STEPS + s) * 4;
      stepMeta[metaBase] = thresh;
      stepMeta[metaBase + 1] = silScale;
      stepMeta[metaBase + 2] = m.numSteps;
      stepMeta[metaBase + 3] = archTag;

      for (let v = 0; v < Math.min(vertsPerArchStep, m.baseVerts.length); v++) {
        const mv = map[v];
        const p = m.baseVerts[mv];
        const c = m.centroid;
        const sx = c[0] + (p[0] - c[0]) * silScale;
        const sy = c[1] + (p[1] - c[1]) * silScale;
        const sz = c[2] + (p[2] - c[2]) * silScale;
        const vn = nrms[v];
        const heightTerm = Math.max(0, Math.min(1, (sy + 0.20) / 1.0));
        const shade = 0.44 + 0.54 * (heightTerm * 0.58 + (0.65 + 0.35 * Math.max(0, vn[1])) * 0.42);
        const off = ((arch * MAX_MORPH_STEPS + s) * vertsPerArchStep + v) * floatsPerVert;
        tableFloats[off] = sx;
        tableFloats[off + 1] = sy;
        tableFloats[off + 2] = sz;
        tableFloats[off + 3] = archTag;
        tableFloats[off + 4] = vn[0];
        tableFloats[off + 5] = vn[1];
        tableFloats[off + 6] = vn[2];
        tableFloats[off + 7] = shade;
      }
    }

    for (let ti = 0; ti < maxTris; ti++) {
      const tri = ti < m.baseTris.length ? m.baseTris[ti] : [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        morphVertexAttribs.push(tri[k], arch);
      }
    }
  }

  const splatArchetypeUniforms = new Float32Array(ROCK_ARCHETYPES * 8);
  for (let arch = 0; arch < ROCK_ARCHETYPES; arch++) {
    const opt = templates[arch].morph.splatOptics;
    const o = arch * 8;
    splatArchetypeUniforms[o] = opt.centre[0];
    splatArchetypeUniforms[o + 1] = opt.centre[1];
    splatArchetypeUniforms[o + 2] = opt.centre[2];
    splatArchetypeUniforms[o + 3] = opt.rx;
    splatArchetypeUniforms[o + 4] = opt.colour[0];
    splatArchetypeUniforms[o + 5] = opt.colour[1];
    splatArchetypeUniforms[o + 6] = opt.colour[2];
    splatArchetypeUniforms[o + 7] = opt.ry;
  }

  return {
    tableFloats,
    stepMeta,
    morphCornerVerts: new Uint32Array(morphVertexAttribs),
    morphVertsPerArch: maxTris * 3,
    splatArchetypeUniforms,
  };
}

export const BOULDER_CONTINUUM_COMPUTE_WGSL = FRAME_WGSL + /* wgsl */ `
struct SourceBoulder {
  root: vec4f,
  shape: vec4f,
};
struct ContinuumBoulder {
  root: vec4f,
  shape: vec4f,
  packMeta: vec4u,
};
struct CullParams {
  pixelScale: f32,
  sampleCount: u32,
  capacity: u32,
  nearCap: u32,
  morphCap: u32,
  splatCap: u32,
  morphBaseOffset: u32,
  splatBaseOffset: u32,
  worldShift: vec4f,
  splatOptics: array<vec4f, ${ROCK_ARCHETYPES * 2}>,
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> P: CullParams;
@group(0) @binding(2) var<storage, read> srcInstances: array<SourceBoulder>;
@group(0) @binding(3) var<storage, read> slotGroups: array<u32>;
@group(0) @binding(4) var<storage, read> stepMeta: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> shownOut: array<ContinuumBoulder>;
@group(0) @binding(6) var<storage, read_write> draws: array<atomic<u32>>;

fn boulderHash(slot: u32, seed: f32) -> f32 {
  var x = slot ^ bitcast<u32>(seed * 4096.0 + 13.37);
  x = ((x >> 16u) ^ x) * 0x45d9f3bu;
  x = ((x >> 16u) ^ x) * 0x45d9f3bu;
  x = (x >> 16u) ^ x;
  return f32(x & 0x00ffffffu) / 16777216.0;
}

fn boulderSampleMask(slot: u32, coverage: f32, sampleCount: u32) -> u32 {
  let sc = max(1u, min(8u, sampleCount));
  let fullMask = (1u << sc) - 1u;
  let onCount = u32(clamp(round(coverage * f32(sc)), 0.0, f32(sc)));
  if (onCount == 0u) { return 0u; }
  if (onCount >= sc) { return fullMask; }
  let rot = ((slot * 0x9e3779b9u) >> 24u) % sc;
  let raw = (1u << onCount) - 1u;
  return ((raw << rot) | (raw >> (sc - rot))) & fullMask;
}

fn boulderInFrustum(relative: vec3f, radius: f32) -> bool {
  let clip = F.viewProj * vec4f(relative, 1.0);
  let rowW = vec3f(F.viewProj[0].w, F.viewProj[1].w, F.viewProj[2].w);
  for (var a = 0u; a < 2u; a++) {
    let row = vec3f(F.viewProj[0][a], F.viewProj[1][a], F.viewProj[2][a]);
    if (clip.w + clip[a] < -radius * length(rowW + row) || clip.w - clip[a] < -radius * length(rowW - row)) {
      return false;
    }
  }
  return clip.w >= -radius * length(rowW);
}

fn boulderProjectedDiameterPx(relative: vec3f, diameter: f32) -> f32 {
  let dist = max(0.25, length(relative));
  let focal = F.screen.y / max(1e-4, 2.0 * length(F.camUp.xyz));
  return (diameter * focal / dist) * P.pixelScale;
}

fn packMorphStep(arch: u32, allowedErr: f32) -> vec2u {
  let base = arch * ${MAX_MORPH_STEPS}u;
  let numSteps = u32(stepMeta[base].z);
  if (numSteps == 0u || allowedErr <= 0.0) {
    return vec2u(0u, 0u);
  }
  var lo = 0u;
  var hi = numSteps;
  for (var iter = 0u; iter < 6u; iter++) {
    let mid = (lo + hi + 1u) >> 1u;
    if (stepMeta[base + mid].x <= allowedErr) {
      lo = mid;
    } else {
      hi = mid - 1u;
    }
  }
  if (lo >= numSteps) {
    return vec2u(numSteps, 0u);
  }
  let e0 = stepMeta[base + lo].x;
  let e1 = max(e0 + 1e-4, stepMeta[base + lo + 1u].x);
  let t = clamp((allowedErr - e0) / (e1 - e0), 0.0, 1.0);
  return vec2u(lo, u32(round(t * 65535.0)));
}

fn emitNear(arch: u32, src: SourceBoulder, mask: u32) {
  if (mask == 0u) { return; }
  let idx = atomicAdd(&draws[arch * ${BOULDER_DRAW_WORDS}u + 1u], 1u);
  if (idx < P.nearCap) {
    shownOut[arch * P.nearCap + idx] = ContinuumBoulder(src.root, src.shape, vec4u(mask, arch, 0u, bitcast<u32>(1.0)));
  }
}

fn emitMorph(arch: u32, src: SourceBoulder, mask: u32, stepPack: vec2u) {
  if (mask == 0u) { return; }
  let drawBucket = ${ROCK_ARCHETYPES}u + arch;
  let idx = atomicAdd(&draws[drawBucket * ${BOULDER_DRAW_WORDS}u + 1u], 1u);
  if (idx < P.morphCap) {
    let packed = (stepPack.x & 0xffffu) | ((stepPack.y & 0xffffu) << 16u);
    shownOut[P.morphBaseOffset + arch * P.morphCap + idx] = ContinuumBoulder(src.root, src.shape, vec4u(mask, arch, packed, bitcast<u32>(1.0)));
  }
}

fn emitSplat(arch: u32, src: SourceBoulder, mask: u32, inflate: f32) {
  if (mask == 0u) { return; }
  let drawBucket = ${ROCK_ARCHETYPES * 2}u;
  let idx = atomicAdd(&draws[drawBucket * ${BOULDER_DRAW_WORDS}u + 1u], 1u);
  if (idx < P.splatCap) {
    shownOut[P.splatBaseOffset + idx] = ContinuumBoulder(src.root, src.shape, vec4u(mask, arch, 0u, bitcast<u32>(inflate)));
  }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= P.capacity || slot >= arrayLength(&srcInstances)) { return; }
  let group = slotGroups[slot];
  if (group >= 2u) { return; }

  let src = srcInstances[slot];
  let radius = src.root.w;
  let height = src.shape.x;
  if (radius <= 0.02 || height <= 0.02) { return; }

  let centerWorld = src.root.xyz + vec3f(P.worldShift.x, height * 0.28, P.worldShift.y);
  let relative = centerWorld - F.camPos.xyz;
  let boundR = length(vec2f(radius * 1.15, height * 0.85));
  if (!boulderInFrustum(relative, boundR)) { return; }

  let arch = u32(clamp(floor(fract(src.shape.y * 17.31 + f32(group) * 0.5) * f32(${ROCK_ARCHETYPES})), 0.0, f32(${ROCK_ARCHETYPES - 1})));
  let diameter = max(radius * 1.84, height * 1.05);
  let px = boulderProjectedDiameterPx(relative, diameter);
  if (px < 0.16) { return; }

  let sc = max(1u, min(8u, P.sampleCount));
  let fullMask = (1u << sc) - 1u;

  // Stage 1: Near / Mid full physical cleavage polyhedron (>= 16.0 px).
  if (px >= ${BOULDER_BAND_START_PX}) {
    emitNear(arch, src, fullMask);
    return;
  }

  // Stage 2: Proportional MSAA @builtin(sample_mask) handoff (16.0 -> 10.5 px, zero double-blend, zero discard).
  if (px >= ${BOULDER_BAND_END_PX}) {
    let fade = clamp((${BOULDER_BAND_START_PX} - px) / (${BOULDER_BAND_START_PX} - ${BOULDER_BAND_END_PX}), 0.0, 1.0);
    let nearMask = boulderSampleMask(slot, 1.0 - fade, sc);
    let farMask = fullMask ^ nearMask;
    emitNear(arch, src, nearMask);
    let stepPack = packMorphStep(arch, fade * 0.14);
    emitMorph(arch, src, farMask, stepPack);
    return;
  }

  // Stage 3: Continuous genus-0 half-edge collapse continuum (10.5 -> 3.5 px), with MSAA handoff into 1-tri splat over 4.5 -> 3.5 px.
  if (px >= ${BOULDER_SPLAT_PIXELS}) {
    let errNorm = pow(clamp((${BOULDER_BAND_START_PX} - px) / (${BOULDER_BAND_START_PX} - ${BOULDER_SPLAT_PIXELS}), 0.0, 1.0), 1.2);
    let stepPack = packMorphStep(arch, errNorm);
    if (px < ${BOULDER_SPLAT_HANDOFF_PX}) {
      let sFade = clamp((${BOULDER_SPLAT_HANDOFF_PX} - px) / (${BOULDER_SPLAT_HANDOFF_PX} - ${BOULDER_SPLAT_PIXELS}), 0.0, 1.0);
      let morphMask = boulderSampleMask(slot + 17u, 1.0 - sFade, sc);
      let splatMask = fullMask ^ morphMask;
      emitMorph(arch, src, morphMask, stepPack);
      emitSplat(arch, src, splatMask, 1.0);
    } else {
      emitMorph(arch, src, fullMask, stepPack);
    }
    return;
  }

  // Stage 4: 1-triangle view-facing horizon splat (< 3.5 px) + sub-pixel stochastic hash thinning (< 1.0 px) with area-preserving inflation.
  var inflate = 1.0;
  if (px < ${BOULDER_MIN_PIXELS}) {
    let keepProb = clamp(px * px, 0.035, 1.0);
    if (boulderHash(slot, src.shape.y) >= keepProb) { return; }
    inflate = inverseSqrt(keepProb);
  }
  emitSplat(arch, src, fullMask, inflate);
}
`;

const BOULDER_BASIS_WGSL = /* wgsl */ `
fn boulderBasis(shape: vec4f, outUp: ptr<function, vec3f>, outX: ptr<function, vec3f>, outZ: ptr<function, vec3f>) {
  let up = normalize(vec3f(-shape.z * 0.55, 1.0, -shape.w * 0.55));
  let yaw = shape.y * 6.283185307179586;
  let h = vec3f(cos(yaw), 0.0, sin(yaw));
  let az = normalize(cross(h, up));
  let ax = normalize(cross(up, az));
  *outUp = up;
  *outX = ax;
  *outZ = az;
}

fn boulderStonePalette(archTag: f32, seed: f32) -> vec3f {
  let idx = clamp(u32(floor(archTag * 6.0)), 0u, 5u);
  var base = vec3f(0.24, 0.23, 0.21);
  if (idx == 1u) { base = vec3f(0.32, 0.29, 0.24); }
  else if (idx == 2u) { base = vec3f(0.27, 0.22, 0.18); }
  else if (idx == 3u) { base = vec3f(0.16, 0.17, 0.18); }
  else if (idx == 4u) { base = vec3f(0.22, 0.23, 0.21); }
  else if (idx == 5u) { base = vec3f(0.29, 0.25, 0.20); }
  let tint = 0.90 + 0.20 * fract(seed * 31.7 + archTag * 5.3);
  return base * tint;
}
`;

const BOULDER_COMMON_SHADING_WGSL = BOULDER_BASIS_WGSL + /* wgsl */ `
fn boulderWorldShift() -> vec3f { return vec3f(0.0); }
fn boulderProjectClip(shiftedWorld: vec3f) -> vec4f {
  return F.viewProj * vec4f(shiftedWorld - F.camPos.xyz, 1.0);
}
fn shadeBoulderRock(worldNormal: vec3f, albedo: vec3f, aoShade: f32, unshiftedWorld: vec3f, localY: f32) -> vec4f {
  let n = normalize(worldNormal);
  let sunDir = normalize(select(vec3f(0.45, 0.76, 0.46), F.sunDir.xyz, length(F.sunDir.xyz) > 0.01));
  let ndl = max(0.0, dot(n, sunDir));
  let hemi = 0.5 + 0.5 * n.y;
  let skyAmb = mix(vec3f(0.20, 0.19, 0.17), vec3f(0.40, 0.45, 0.52), hemi);
  let viewDir = normalize(F.camPos.xyz - unshiftedWorld);
  let halfVec = normalize(sunDir + viewDir);
  let spec = pow(max(0.0, dot(n, halfVec)), 18.0) * 0.06 * ndl;
  let sunCol = vec3f(1.04, 0.98, 0.90);
  let lit = albedo * 1.65 * aoShade * (skyAmb + sunCol * (0.78 * ndl)) + vec3f(spec) + localY * 0.0;
  return vec4f(lit, 1.0);
}
`;

const BOULDER_SCENE_SHADING_WGSL = ATMO_CORE_WGSL + SHADOW_FRAME + /* wgsl */ `
struct Land { domain: vec4f };
struct NearLand { domain: vec4f, grid: vec4f };
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var landLight: texture_2d<f32>;
@group(0) @binding(6) var<uniform> LAND: Land;
@group(0) @binding(7) var landAlbedo: texture_2d<f32>;
@group(0) @binding(8) var landSampler: sampler;
@group(0) @binding(9) var vegetationMask: texture_2d<f32>;
@group(0) @binding(12) var<uniform> nearTerrain: NearLand;
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;
` + SKY_RENDER_FUNCS + BOULDER_BASIS_WGSL + /* wgsl */ `
fn boulderWorldShift() -> vec3f { return vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z); }
fn boulderProjectClip(shiftedWorld: vec3f) -> vec4f {
  return F.viewProj * vec4f(earthCurve(shiftedWorld - F.camPos.xyz, F.camPos.y), 1.0);
}
fn boulderLandShadow(world: vec3f, normal: vec3f) -> f32 {
  if (landSH.origin.w < 0.5) { return 1.0; }
  let facing = select(-1.0, 1.0, dot(normal, landSH.sun.xyz) >= 0.0);
  let offset = normal * facing * 0.032 + landSH.sun.xyz * 0.025;
  let p = landSH.lightView * vec4f(world - landSH.origin.xyz + offset, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let fade = smoothstep(0.0, 0.06, edge) * step(0.0, p.z) * step(p.z, 1.0);
  if (fade <= 0.0) { return 1.0; }
  let refZ = min(p.z - 0.08 / max(landSH.sun.w, 1.0), 0.99999);
  let s1 = textureSampleCompareLevel(landSolidShadow, landShadowCompare, uv, refZ);
  return mix(1.0, s1, fade);
}
fn shadeBoulderRock(worldNormal: vec3f, baseLitho: vec3f, aoShade: f32, unshiftedWorld: vec3f, localY: f32) -> vec4f {
  let shiftedWorld = unshiftedWorld + boulderWorldShift();
  let camDist = distance(shiftedWorld, F.camPos.xyz);
  let grainFade = smoothstep(48.0, 10.0, camDist);
  let crystal = sin(unshiftedWorld.x * 9.5 + unshiftedWorld.z * 7.1) * 0.5 + cos(unshiftedWorld.y * 12.3 - unshiftedWorld.x * 5.7) * 0.5;
  let gx = cos(unshiftedWorld.x * 19.0 + unshiftedWorld.z * 11.0) * 0.072 * grainFade;
  let gz = sin(unshiftedWorld.z * 19.0 - unshiftedWorld.x * 11.0) * 0.072 * grainFade;
  let n = normalize(normalize(worldNormal) + vec3f(gx, 0.0, gz));

  let uv = clamp((unshiftedWorld.xz - LAND.domain.xy) / LAND.domain.z + 0.5, vec2f(0.0), vec2f(1.0));
  let source = pow(textureSampleLevel(landAlbedo, landSampler, uv, 1.0).rgb, vec3f(2.2));
  let vegetation = textureSampleLevel(vegetationMask, landSampler, uv, 0.0).r;
  let lichenNoise = sin(unshiftedWorld.x * 2.4 + unshiftedWorld.z * 1.9) * cos(unshiftedWorld.z * 3.1 - unshiftedWorld.x * 2.7);
  let lichen = smoothstep(0.55, 0.88, max(n.y, 0.0)) * smoothstep(0.20, 0.75, lichenNoise) * smoothstep(0.08, 0.45, vegetation);
  let rootMask = 1.0 - smoothstep(-0.18, 0.14, localY);

  let shade = 0.68 + aoShade * 0.34;
  var albedo = mix(baseLitho, source, 0.22) * shade * (0.90 + 0.12 * max(n.y, 0.0) + crystal * 0.045 * grainFade);
  albedo = mix(albedo, vec3f(0.24, 0.27, 0.16) * shade, lichen * 0.58);
  albedo = mix(albedo, source * 0.74, rootMask * 0.40);

  let roughness = clamp(0.76 - crystal * 0.05 + lichen * 0.14, 0.54, 0.92);
  let sunlight = textureSampleLevel(landLight, sampC, uv, 0.0);
  let shadowed = vec3f(boulderLandShadow(unshiftedWorld, n));
  let direct = sunIlluminance() * sunlight.r * solarShadowVisibility(shadowed).x;
  let ambient = textureSampleLevel(envCube, sampC, vec3f(0.0, 1.0, 0.0), 7.0).rgb;
  let diffuse = max(dot(n, F.sunDir.xyz), 0.0);
  let visibility = 0.35 + 0.32 * max(n.y, 0.0);
  let wet = (1.0 - smoothstep(0.6, 3.2, unshiftedWorld.y)) * 0.55;
  let vEye = normalize(F.camPos.xyz - shiftedWorld);

  var color = albedo * (1.0 - wet * 0.3) * (direct * diffuse / PI + ambient * visibility);
  let sunDirSafe = normalize(select(vec3f(0.0, 1.0, 0.0), F.sunDir.xyz, length(F.sunDir.xyz) > 0.001));
  let hRaw = vEye + sunDirSafe;
  let hVec = select(vec3f(0.0, 1.0, 0.0), normalize(hRaw), length(hRaw) > 1e-5);
  let nDotH = max(dot(n, hVec), 0.0);
  color += direct * pow(nDotH, mix(14.0, 36.0, wet)) * (0.042 + wet * 0.11);
  color += lunarSurface(n, vEye, albedo, roughness, vec3f(0.035), vec3f(sunlight.g) * lunarShadowVisibility(shadowed));
  color += lightningSurface(n, vEye, albedo, roughness) + worldFireSurface(shiftedWorld, n, vEye, albedo, roughness);
  return vec4f(surfaceAir(color, shiftedWorld), 1.0);
}
`;

function buildBoulderNearWGSL(sceneShading = false) {
  return FRAME_WGSL + (sceneShading ? BOULDER_SCENE_SHADING_WGSL : BOULDER_COMMON_SHADING_WGSL) + /* wgsl */ `
struct NearVSIn {
  @location(0) localPos: vec3f,
  @location(1) localNrm: vec3f,
  @location(2) shadeAndArch: vec2f,
  @location(3) instRoot: vec4f,
  @location(4) instShape: vec4f,
  @location(5) instMeta: vec4u,
};
struct BoulderVarying {
  @builtin(position) clipPos: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) worldNrm: vec3f,
  @location(2) colour: vec3f,
  @location(3) shadeAndLocalY: vec2f,
  @location(4) @interpolate(flat) mask: u32,
};
struct FragOut {
  @location(0) color: vec4f,
  @builtin(sample_mask) mask: u32,
};

@group(0) @binding(0) var<uniform> F: Frame;

@vertex
fn vsMain(v: NearVSIn) -> BoulderVarying {
  var up: vec3f; var ax: vec3f; var az: vec3f;
  boulderBasis(v.instShape, &up, &ax, &az);
  let radius = v.instRoot.w;
  let height = v.instShape.x;
  let worldPos = v.instRoot.xyz
    + ax * (v.localPos.x * radius)
    + up * (v.localPos.y * height)
    + az * (v.localPos.z * radius);
  let worldNrm = normalize(
    ax * (v.localNrm.x / max(0.05, radius))
    + up * (v.localNrm.y / max(0.05, height))
    + az * (v.localNrm.z / max(0.05, radius))
  );
  var o: BoulderVarying;
  o.clipPos = boulderProjectClip(worldPos + boulderWorldShift());
  o.worldPos = worldPos;
  o.worldNrm = worldNrm;
  o.colour = boulderStonePalette(v.shadeAndArch.y, v.instShape.y);
  o.shadeAndLocalY = vec2f(v.shadeAndArch.x, v.localPos.y);
  o.mask = v.instMeta.x;
  return o;
}

@fragment
fn fsMain(v: BoulderVarying) -> FragOut {
  var out: FragOut;
  out.color = shadeBoulderRock(v.worldNrm, v.colour, v.shadeAndLocalY.x, v.worldPos, v.shadeAndLocalY.y);
  out.mask = v.mask;
  return out;
}
`;
}

function buildBoulderMorphWGSL(sceneShading = false) {
  const tableBinding = sceneShading
    ? '@group(1) @binding(0) var<storage, read> morphTable: array<MorphEntry>;'
    : '@group(0) @binding(1) var<storage, read> morphTable: array<MorphEntry>;';
  return FRAME_WGSL + (sceneShading ? BOULDER_SCENE_SHADING_WGSL : BOULDER_COMMON_SHADING_WGSL) + /* wgsl */ `
struct MorphEntry {
  posAndArch: vec4f,
  nrmAndShade: vec4f,
};
struct MorphVSIn {
  @location(0) cornerInfo: vec2u,
  @location(1) instRoot: vec4f,
  @location(2) instShape: vec4f,
  @location(3) instMeta: vec4u,
};
struct BoulderVarying {
  @builtin(position) clipPos: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) worldNrm: vec3f,
  @location(2) colour: vec3f,
  @location(3) shadeAndLocalY: vec2f,
  @location(4) @interpolate(flat) mask: u32,
};
struct FragOut {
  @location(0) color: vec4f,
  @builtin(sample_mask) mask: u32,
};

@group(0) @binding(0) var<uniform> F: Frame;
${tableBinding}

fn fetchMorph(arch: u32, step: u32, vertIdx: u32) -> MorphEntry {
  let s = min(step, ${MAX_MORPH_STEPS - 1}u);
  let idx = (arch * ${MAX_MORPH_STEPS}u + s) * ${MAX_POLY_VERTS}u + min(vertIdx, ${MAX_POLY_VERTS - 1}u);
  return morphTable[idx];
}

@vertex
fn vsMain(v: MorphVSIn) -> BoulderVarying {
  let arch = min(v.instMeta.y, ${ROCK_ARCHETYPES - 1}u);
  let packed = v.instMeta.z;
  let step0 = packed & 0xffffu;
  let morphT = f32((packed >> 16u) & 0xffffu) / 65535.0;
  let e0 = fetchMorph(arch, step0, v.cornerInfo.x);
  let e1 = fetchMorph(arch, step0 + 1u, v.cornerInfo.x);

  let localPos = mix(e0.posAndArch.xyz, e1.posAndArch.xyz, morphT);
  let localNrm = normalize(mix(e0.nrmAndShade.xyz, e1.nrmAndShade.xyz, morphT));
  let shade = mix(e0.nrmAndShade.w, e1.nrmAndShade.w, morphT);

  var up: vec3f; var ax: vec3f; var az: vec3f;
  boulderBasis(v.instShape, &up, &ax, &az);
  let radius = v.instRoot.w;
  let height = v.instShape.x;
  let worldPos = v.instRoot.xyz
    + ax * (localPos.x * radius)
    + up * (localPos.y * height)
    + az * (localPos.z * radius);
  let worldNrm = normalize(
    ax * (localNrm.x / max(0.05, radius))
    + up * (localNrm.y / max(0.05, height))
    + az * (localNrm.z / max(0.05, radius))
  );

  var o: BoulderVarying;
  o.clipPos = boulderProjectClip(worldPos + boulderWorldShift());
  o.worldPos = worldPos;
  o.worldNrm = worldNrm;
  o.colour = boulderStonePalette(e0.posAndArch.w, v.instShape.y);
  o.shadeAndLocalY = vec2f(shade, localPos.y);
  o.mask = v.instMeta.x;
  return o;
}

@fragment
fn fsMain(v: BoulderVarying) -> FragOut {
  var out: FragOut;
  out.color = shadeBoulderRock(v.worldNrm, v.colour, v.shadeAndLocalY.x, v.worldPos, v.shadeAndLocalY.y);
  out.mask = v.mask;
  return out;
}
`;
}

function buildBoulderSplatWGSL(sceneShading = false) {
  const splatBinding = sceneShading
    ? '@group(1) @binding(0) var<uniform> S: SplatUniforms;'
    : '@group(0) @binding(1) var<uniform> S: SplatUniforms;';
  return FRAME_WGSL + (sceneShading ? BOULDER_SCENE_SHADING_WGSL : BOULDER_COMMON_SHADING_WGSL) + /* wgsl */ `
struct SplatUniforms {
  optics: array<vec4f, ${ROCK_ARCHETYPES * 2}>,
};
struct SplatVSIn {
  @builtin(vertex_index) vid: u32,
  @location(0) instRoot: vec4f,
  @location(1) instShape: vec4f,
  @location(2) instMeta: vec4u,
};
struct SplatVarying {
  @builtin(position) clipPos: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) worldNrm: vec3f,
  @location(2) colour: vec3f,
  @location(3) shadeAndLocalY: vec2f,
  @location(4) @interpolate(flat) mask: u32,
};
struct FragOut {
  @location(0) color: vec4f,
  @builtin(sample_mask) mask: u32,
};

@group(0) @binding(0) var<uniform> F: Frame;
${splatBinding}

@vertex
fn vsMain(v: SplatVSIn) -> SplatVarying {
  let arch = min(v.instMeta.y, ${ROCK_ARCHETYPES - 1}u);
  let inflate = bitcast<f32>(v.instMeta.w);
  let optA = S.optics[arch * 2u];
  let optB = S.optics[arch * 2u + 1u];

  var up: vec3f; var ax: vec3f; var az: vec3f;
  boulderBasis(v.instShape, &up, &ax, &az);
  let radius = v.instRoot.w * inflate;
  let height = v.instShape.x * inflate;

  let centreUnshifted = v.instRoot.xyz
    + ax * (optA.x * radius)
    + up * (optA.y * height)
    + az * (optA.z * radius);
  let shift = boulderWorldShift();
  let centreShifted = centreUnshifted + shift;

  let toCam = normalize(F.camPos.xyz - centreShifted);
  let splatRefUp = select(up, vec3f(1.0, 0.0, 0.0), abs(dot(up, toCam)) > 0.999 || abs(toCam.y) > 0.999);
  let camRightRaw = cross(splatRefUp, toCam);
  let camRight = select(vec3f(1.0, 0.0, 0.0), normalize(camRightRaw), length(camRightRaw) > 1e-5);
  let billboardUp = normalize(cross(toCam, camRight));

  let rx = optA.w * radius;
  let ry = optB.w * height;

  // Single 3-vertex grounded dome/wedge triangle matching projected boulder area (~0.77 * pi * rx * ry).
  var uv = vec2f(-1.18, -0.78);
  if (v.vid == 1u) { uv = vec2f(1.18, -0.78); }
  else if (v.vid == 2u) { uv = vec2f(0.0, 1.28); }

  let offset = camRight * (uv.x * rx) + billboardUp * (uv.y * ry);
  let worldPos = centreUnshifted + offset;
  let domeNrm = normalize(camRight * (uv.x * 0.55) + billboardUp * (0.38 + max(-0.25, uv.y) * 0.52) + toCam * 0.62);

  var o: SplatVarying;
  o.clipPos = boulderProjectClip(centreShifted + offset);
  o.worldPos = worldPos;
  o.worldNrm = domeNrm;
  o.colour = boulderStonePalette((f32(arch) + 0.5) / 6.0, v.instShape.y);
  o.shadeAndLocalY = vec2f(clamp(0.58 + 0.24 * uv.y, 0.42, 0.96), uv.y * 0.45);
  o.mask = v.instMeta.x;
  return o;
}

@fragment
fn fsMain(v: SplatVarying) -> FragOut {
  var out: FragOut;
  out.color = shadeBoulderRock(v.worldNrm, v.colour, v.shadeAndLocalY.x, v.worldPos, v.shadeAndLocalY.y);
  out.mask = v.mask;
  return out;
}
`;
}

export const BOULDER_NEAR_RENDER_WGSL = buildBoulderNearWGSL(false);
export const BOULDER_MORPH_RENDER_WGSL = buildBoulderMorphWGSL(false);
export const BOULDER_SPLAT_RENDER_WGSL = buildBoulderSplatWGSL(false);

const BOULDER_SHADOW_NEAR_WGSL = SHADOW_FRAME + BOULDER_BASIS_WGSL + /* wgsl */ `
struct NearVSIn {
  @location(0) localPos: vec3f,
  @location(1) localNrm: vec3f,
  @location(2) shadeAndArch: vec2f,
  @location(3) instRoot: vec4f,
  @location(4) instShape: vec4f,
  @location(5) instMeta: vec4u,
};
@group(0) @binding(0) var<uniform> landSH: ShadowFrame;
@vertex
fn vsMain(v: NearVSIn) -> @builtin(position) vec4f {
  var up: vec3f; var ax: vec3f; var az: vec3f;
  boulderBasis(v.instShape, &up, &ax, &az);
  let worldPos = v.instRoot.xyz
    + ax * (v.localPos.x * v.instRoot.w)
    + up * (v.localPos.y * v.instShape.x)
    + az * (v.localPos.z * v.instRoot.w);
  return landSH.lightView * vec4f(worldPos - landSH.origin.xyz, 1.0);
}
`;

const BOULDER_SHADOW_MORPH_WGSL = SHADOW_FRAME + BOULDER_BASIS_WGSL + /* wgsl */ `
struct MorphEntry {
  posAndArch: vec4f,
  nrmAndShade: vec4f,
};
struct MorphVSIn {
  @location(0) cornerInfo: vec2u,
  @location(1) instRoot: vec4f,
  @location(2) instShape: vec4f,
  @location(3) instMeta: vec4u,
};
@group(0) @binding(0) var<uniform> landSH: ShadowFrame;
@group(0) @binding(1) var<storage, read> morphTable: array<MorphEntry>;
fn fetchMorph(arch: u32, step: u32, vertIdx: u32) -> MorphEntry {
  let s = min(step, ${MAX_MORPH_STEPS - 1}u);
  let idx = (arch * ${MAX_MORPH_STEPS}u + s) * ${MAX_POLY_VERTS}u + min(vertIdx, ${MAX_POLY_VERTS - 1}u);
  return morphTable[idx];
}
@vertex
fn vsMain(v: MorphVSIn) -> @builtin(position) vec4f {
  let arch = min(v.instMeta.y, ${ROCK_ARCHETYPES - 1}u);
  let packed = v.instMeta.z;
  let step0 = packed & 0xffffu;
  let morphT = f32((packed >> 16u) & 0xffffu) / 65535.0;
  let e0 = fetchMorph(arch, step0, v.cornerInfo.x);
  let e1 = fetchMorph(arch, step0 + 1u, v.cornerInfo.x);
  let localPos = mix(e0.posAndArch.xyz, e1.posAndArch.xyz, morphT);
  var up: vec3f; var ax: vec3f; var az: vec3f;
  boulderBasis(v.instShape, &up, &ax, &az);
  let worldPos = v.instRoot.xyz
    + ax * (localPos.x * v.instRoot.w)
    + up * (localPos.y * v.instShape.x)
    + az * (localPos.z * v.instRoot.w);
  return landSH.lightView * vec4f(worldPos - landSH.origin.xyz, 1.0);
}
`;

export async function createBoulderContinuum(device, {
  frameUBO,
  resources = null,
  landShadowUniform = null,
  capacity = 65536,
  colorFormat = 'bgra8unorm',
  depthFormat = 'depth32float',
  depthCompare = 'greater-equal',
  sampleCount = 4,
  shadowDepthFormat = 'depth32float',
  shadowDepthCompare = 'less-equal',
  field: externalField = null,
  getPort = null,
  groundAt = () => 0,
  waterAt = null,
} = {}) {
  const U = GPUBufferUsage;
  const templates = getAllBoulderCleavageTemplates();
  const morphPack = packMorphGpuData();
  const useSceneShading = Array.isArray(resources) && resources.length > 0;
  const SCENE_BINDING_IDS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 19, 20, 21]);

  const nearCapPerArch = Math.max(256, Math.ceil(capacity / ROCK_ARCHETYPES));
  const morphCapPerArch = Math.max(512, Math.ceil(capacity / ROCK_ARCHETYPES));
  const splatCap = Math.max(1024, capacity);
  const morphBaseOffset = ROCK_ARCHETYPES * nearCapPerArch;
  const splatBaseOffset = morphBaseOffset + ROCK_ARCHETYPES * morphCapPerArch;
  const totalShownCap = splatBaseOffset + splatCap;

  const createBuf = (label, byteLength, usage) => device.createBuffer({
    label,
    size: Math.max(16, (byteLength + 3) & ~3),
    usage,
  });

  // Static near geometry buffer concatenating all 6 outer cleavage polyhedra.
  const nearFirstVert = new Uint32Array(ROCK_ARCHETYPES);
  const nearVertCount = new Uint32Array(ROCK_ARCHETYPES);
  let totalNearFloats = 0;
  for (let a = 0; a < ROCK_ARCHETYPES; a++) {
    nearFirstVert[a] = totalNearFloats / 8;
    nearVertCount[a] = templates[a].nearVertexCount;
    totalNearFloats += templates[a].nearVertices.length;
  }
  const nearVertData = new Float32Array(totalNearFloats);
  let floatCursor = 0;
  for (let a = 0; a < ROCK_ARCHETYPES; a++) {
    nearVertData.set(templates[a].nearVertices, floatCursor);
    floatCursor += templates[a].nearVertices.length;
  }
  const nearMeshBuf = createBuf('boulder continuum near mesh', nearVertData.byteLength, U.VERTEX | U.COPY_DST);
  device.queue.writeBuffer(nearMeshBuf, 0, nearVertData);

  const morphCornerBuf = createBuf('boulder continuum morph corners', morphPack.morphCornerVerts.byteLength, U.VERTEX | U.COPY_DST);
  device.queue.writeBuffer(morphCornerBuf, 0, morphPack.morphCornerVerts);

  const morphTableBuf = createBuf('boulder continuum morph table', morphPack.tableFloats.byteLength, U.STORAGE | U.COPY_DST);
  device.queue.writeBuffer(morphTableBuf, 0, morphPack.tableFloats);

  const stepMetaBuf = createBuf('boulder continuum step meta', morphPack.stepMeta.byteLength, U.STORAGE | U.COPY_DST);
  device.queue.writeBuffer(stepMetaBuf, 0, morphPack.stepMeta);

  const splatUniformBuf = createBuf('boulder continuum splat optics', morphPack.splatArchetypeUniforms.byteLength, U.UNIFORM | U.COPY_DST);
  device.queue.writeBuffer(splatUniformBuf, 0, morphPack.splatArchetypeUniforms);

  const srcInstancesBuf = createBuf('boulder continuum source instances', capacity * SOURCE_INSTANCE_BYTES, U.STORAGE | U.COPY_DST);
  const slotGroupsBuf = createBuf('boulder continuum slot groups', capacity * 4, U.STORAGE | U.COPY_DST);
  const emptied = new Uint32Array(capacity).fill(BOULDER_EMPTY_SLOT);
  device.queue.writeBuffer(slotGroupsBuf, 0, emptied);

  const shownBuf = createBuf('boulder continuum shown instances', totalShownCap * CONTINUUM_INSTANCE_BYTES, U.STORAGE | U.VERTEX);

  const drawBucketCount = ROCK_ARCHETYPES * 2 + 1;
  const resetDraws = new Uint32Array(drawBucketCount * BOULDER_DRAW_WORDS);
  for (let a = 0; a < ROCK_ARCHETYPES; a++) {
    resetDraws[a * BOULDER_DRAW_WORDS] = nearVertCount[a];
    resetDraws[a * BOULDER_DRAW_WORDS + 2] = nearFirstVert[a];
    const mb = ROCK_ARCHETYPES + a;
    resetDraws[mb * BOULDER_DRAW_WORDS] = morphPack.morphVertsPerArch;
    resetDraws[mb * BOULDER_DRAW_WORDS + 2] = a * morphPack.morphVertsPerArch;
  }
  resetDraws[ROCK_ARCHETYPES * 2 * BOULDER_DRAW_WORDS] = 3; // 1-triangle (3-vertex) horizon splat!
  const drawsBuf = createBuf('boulder continuum indirect draws', resetDraws.byteLength, U.STORAGE | U.INDIRECT | U.COPY_DST);
  device.queue.writeBuffer(drawsBuf, 0, resetDraws);

  // CullParams: 8 scalars (32 bytes) + worldShift vec4f (16 bytes) + 12 vec4f (192 bytes) = 240 bytes.
  const cullParamBytes = new ArrayBuffer(240);
  const cullParamF32 = new Float32Array(cullParamBytes);
  const cullParamU32 = new Uint32Array(cullParamBytes);
  let curPixelScale = 1;
  let curShiftX = 0, curShiftZ = 0;
  const writeCullParams = () => {
    cullParamF32[0] = curPixelScale;
    cullParamU32[1] = sampleCount;
    cullParamU32[2] = capacity;
    cullParamU32[3] = nearCapPerArch;
    cullParamU32[4] = morphCapPerArch;
    cullParamU32[5] = splatCap;
    cullParamU32[6] = morphBaseOffset;
    cullParamU32[7] = splatBaseOffset;
    cullParamF32[8] = curShiftX;
    cullParamF32[9] = curShiftZ;
    cullParamF32[10] = 0;
    cullParamF32[11] = 0;
    cullParamF32.set(morphPack.splatArchetypeUniforms, 12);
  };
  writeCullParams();
  const cullParamsBuf = createBuf('boulder continuum cull params', cullParamBytes.byteLength, U.UNIFORM | U.COPY_DST);
  device.queue.writeBuffer(cullParamsBuf, 0, cullParamBytes);

  const instanceAttribs = (baseShaderLocation) => ({
    arrayStride: CONTINUUM_INSTANCE_BYTES,
    stepMode: 'instance',
    attributes: [
      { shaderLocation: baseShaderLocation, offset: 0, format: 'float32x4' },
      { shaderLocation: baseShaderLocation + 1, offset: 16, format: 'float32x4' },
      { shaderLocation: baseShaderLocation + 2, offset: 32, format: 'uint32x4' },
    ],
  });

  const computeModule = device.createShaderModule({ label: 'boulder continuum compute', code: BOULDER_CONTINUUM_COMPUTE_WGSL });
  const nearModule = device.createShaderModule({ label: 'boulder near render', code: buildBoulderNearWGSL(useSceneShading) });
  const morphModule = device.createShaderModule({ label: 'boulder morph render', code: buildBoulderMorphWGSL(useSceneShading) });
  const splatModule = device.createShaderModule({ label: 'boulder splat render', code: buildBoulderSplatWGSL(useSceneShading) });

  const primitive = { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' };
  const depthStencil = { format: depthFormat, depthWriteEnabled: true, depthCompare };
  const multisample = { count: sampleCount };

  const useLightShadow = Boolean(landShadowUniform);
  const shadowNearShader = useLightShadow
    ? device.createShaderModule({ label: 'boulder shadow near light', code: BOULDER_SHADOW_NEAR_WGSL })
    : nearModule;
  const shadowMorphShader = useLightShadow
    ? device.createShaderModule({ label: 'boulder shadow morph light', code: BOULDER_SHADOW_MORPH_WGSL })
    : morphModule;
  const shadowDepthStencil = {
    format: shadowDepthFormat,
    depthWriteEnabled: true,
    depthCompare: shadowDepthCompare,
    ...(useLightShadow ? { depthBiasSlopeScale: 1.5 } : {}),
  };

  const makeComputeAsync = (desc) => typeof device.createComputePipelineAsync === 'function'
    ? device.createComputePipelineAsync(desc)
    : Promise.resolve(device.createComputePipeline(desc));
  const makeRenderAsync = (desc) => typeof device.createRenderPipelineAsync === 'function'
    ? device.createRenderPipelineAsync(desc)
    : Promise.resolve(device.createRenderPipeline(desc));

  const [
    computePipeline,
    nearPipeline,
    morphPipeline,
    splatPipeline,
    shadowNearPipeline,
    shadowMorphPipeline,
  ] = await Promise.all([
    makeComputeAsync({
      label: 'boulder continuum compute',
      layout: 'auto',
      compute: {
        module: computeModule,
        entryPoint: 'main',
      },
    }),
    makeRenderAsync({
      label: 'boulder continuum near',
      layout: 'auto',
      vertex: {
        module: nearModule,
        entryPoint: 'vsMain',
        buffers: [
          {
            arrayStride: 32,
            stepMode: 'vertex',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x2' },
            ],
          },
          instanceAttribs(3),
        ],
      },
      fragment: { module: nearModule, entryPoint: 'fsMain', targets: [{ format: colorFormat }] },
      primitive,
      depthStencil,
      multisample,
    }),
    makeRenderAsync({
      label: 'boulder continuum morph',
      layout: 'auto',
      vertex: {
        module: morphModule,
        entryPoint: 'vsMain',
        buffers: [
          {
            arrayStride: 8,
            stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32x2' }],
          },
          instanceAttribs(1),
        ],
      },
      fragment: { module: morphModule, entryPoint: 'fsMain', targets: [{ format: colorFormat }] },
      primitive,
      depthStencil,
      multisample,
    }),
    makeRenderAsync({
      label: 'boulder continuum splat',
      layout: 'auto',
      vertex: {
        module: splatModule,
        entryPoint: 'vsMain',
        buffers: [instanceAttribs(0)],
      },
      fragment: { module: splatModule, entryPoint: 'fsMain', targets: [{ format: colorFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
      multisample,
    }),
    makeRenderAsync({
      label: 'boulder continuum shadow near',
      layout: 'auto',
      vertex: {
        module: shadowNearShader,
        entryPoint: 'vsMain',
        buffers: [
          {
            arrayStride: 32,
            stepMode: 'vertex',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x2' },
            ],
          },
          instanceAttribs(3),
        ],
      },
      primitive,
      depthStencil: shadowDepthStencil,
    }),
    makeRenderAsync({
      label: 'boulder continuum shadow morph',
      layout: 'auto',
      vertex: {
        module: shadowMorphShader,
        entryPoint: 'vsMain',
        buffers: [
          {
            arrayStride: 8,
            stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32x2' }],
          },
          instanceAttribs(1),
        ],
      },
      primitive,
      depthStencil: shadowDepthStencil,
    }),
  ]);

  const computeBindGroup = device.createBindGroup({
    label: 'boulder continuum compute bg',
    layout: computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUBO } },
      { binding: 1, resource: { buffer: cullParamsBuf } },
      { binding: 2, resource: { buffer: srcInstancesBuf } },
      { binding: 3, resource: { buffer: slotGroupsBuf } },
      { binding: 4, resource: { buffer: stepMetaBuf } },
      { binding: 5, resource: { buffer: shownBuf } },
      { binding: 6, resource: { buffer: drawsBuf } },
    ],
  });

  const buildSceneGroup0 = (pipe, resList) => device.createBindGroup({
    label: 'boulder scene bg0',
    layout: pipe.getBindGroupLayout(0),
    entries: resList
      .filter(([b]) => SCENE_BINDING_IDS.has(b))
      .map(([binding, resource]) => ({ binding, resource })),
  });

  let nearBindGroup, morphBindGroup, splatBindGroup;
  let morphExtraBindGroup = null, splatExtraBindGroup = null;
  const bindRenderGroups = (resList) => {
    if (useSceneShading && resList) {
      nearBindGroup = buildSceneGroup0(nearPipeline, resList);
      morphBindGroup = buildSceneGroup0(morphPipeline, resList);
      splatBindGroup = buildSceneGroup0(splatPipeline, resList);
      morphExtraBindGroup ??= device.createBindGroup({
        label: 'boulder morph table bg1',
        layout: morphPipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: morphTableBuf } }],
      });
      splatExtraBindGroup ??= device.createBindGroup({
        label: 'boulder splat optics bg1',
        layout: splatPipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: splatUniformBuf } }],
      });
    } else {
      nearBindGroup = device.createBindGroup({
        label: 'boulder near bg',
        layout: nearPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: frameUBO } }],
      });
      morphBindGroup = device.createBindGroup({
        label: 'boulder morph bg',
        layout: morphPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: frameUBO } },
          { binding: 1, resource: { buffer: morphTableBuf } },
        ],
      });
      splatBindGroup = device.createBindGroup({
        label: 'boulder splat bg',
        layout: splatPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: frameUBO } },
          { binding: 1, resource: { buffer: splatUniformBuf } },
        ],
      });
    }
  };
  bindRenderGroups(resources);

  const shadowUniformBuf = useLightShadow ? landShadowUniform : frameUBO;
  const shadowNearBindGroup = device.createBindGroup({
    label: 'boulder shadow near bg',
    layout: shadowNearPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: shadowUniformBuf } }],
  });
  const shadowMorphBindGroup = device.createBindGroup({
    label: 'boulder shadow morph bg',
    layout: shadowMorphPipeline.getBindGroupLayout(0),
    entries: useLightShadow || !useSceneShading
      ? [
          { binding: 0, resource: { buffer: shadowUniformBuf } },
          { binding: 1, resource: { buffer: morphTableBuf } },
        ]
      : [{ binding: 0, resource: { buffer: shadowUniformBuf } }],
  });

  const singleClear = new Uint32Array([BOULDER_EMPTY_SLOT]);
  const clearSlot = (slot) => {
    if (!(slot >= 0 && slot < capacity)) return;
    device.queue.writeBuffer(slotGroupsBuf, slot * 4, singleClear);
  };
  const field = externalField ?? (getPort ? createBoulderField({
    getPort,
    groundAt,
    waterAt,
    onBoulderHidden: clearSlot,
  }) : null);

  return {
    capacity,
    field,
    rebind(nextResources) {
      if (useSceneShading && Array.isArray(nextResources)) bindRenderGroups(nextResources);
    },
    setInstances(slot, floats, slotGroups) {
      if (floats?.length) {
        device.queue.writeBuffer(srcInstancesBuf, slot * SOURCE_INSTANCE_BYTES, floats);
      }
      if (slotGroups?.length) {
        const filtered = new Uint32Array(slotGroups.length);
        for (let i = 0; i < slotGroups.length; i++) {
          const g = slotGroups[i] >>> 0;
          filtered[i] = g < 2 ? g : BOULDER_EMPTY_SLOT;
        }
        device.queue.writeBuffer(slotGroupsBuf, slot * 4, filtered);
        field?.setInstances(slot, floats, filtered);
      }
    },
    clearSlots(slot, count = 1) {
      if (count <= 0) return;
      device.queue.writeBuffer(slotGroupsBuf, slot * 4, emptied, 0, Math.min(count, emptied.length));
      field?.clearSlots(slot, count);
    },
    clearSlot,
    setPixelScale(scale = 1) {
      if (!Number.isFinite(scale) || Math.abs(scale - curPixelScale) < 1e-4) return;
      curPixelScale = scale;
      writeCullParams();
      device.queue.writeBuffer(cullParamsBuf, 0, cullParamBytes, 0, 48);
    },
    setWorldOffset(dx = 0, dz = 0) {
      const nx = Number.isFinite(dx) ? dx : 0;
      const nz = Number.isFinite(dz) ? dz : 0;
      if (Math.abs(nx - curShiftX) < 0.02 && Math.abs(nz - curShiftZ) < 0.02) return;
      curShiftX = nx;
      curShiftZ = nz;
      writeCullParams();
      device.queue.writeBuffer(cullParamsBuf, 0, cullParamBytes, 0, 48);
    },
    sweepBoulderSegment(from, to, radius = 0.08, options = null) {
      if (!field) return null;
      if (!curShiftX && !curShiftZ) return field.sweepBoulderSegment(from, to, radius, options);
      const hit = field.sweepBoulderSegment(
        [from[0] - curShiftX, from[1], from[2] - curShiftZ],
        [to[0] - curShiftX, to[1], to[2] - curShiftZ],
        radius,
        options,
      );
      if (!hit) return null;
      return {
        ...hit,
        sceneryPos: [hit.sceneryPos[0] + curShiftX, hit.sceneryPos[1], hit.sceneryPos[2] + curShiftZ],
        position: [hit.position[0] + curShiftX, hit.position[1], hit.position[2] + curShiftZ],
      };
    },
    strikeBoulder(event) {
      if (!field || !event) return null;
      if (!curShiftX && !curShiftZ) return field.strikeBoulder(event);
      const shiftPt = (p) => (Array.isArray(p) ? [p[0] - curShiftX, p[1], p[2] - curShiftZ] : p);
      return field.strikeBoulder({
        ...event,
        position: shiftPt(event.position),
        surfacePosition: shiftPt(event.surfacePosition),
        sceneryPos: shiftPt(event.sceneryPos),
      });
    },
    prepare(encoderOrPass) {
      device.queue.writeBuffer(drawsBuf, 0, resetDraws);
      const isEncoder = typeof encoderOrPass?.beginComputePass === 'function';
      const pass = isEncoder
        ? encoderOrPass.beginComputePass({ label: 'boulder continuum cull' })
        : encoderOrPass;
      pass.setPipeline(computePipeline);
      pass.setBindGroup(0, computeBindGroup);
      pass.dispatchWorkgroups(Math.ceil(capacity / 64));
      if (isEncoder) pass.end();
    },
    draw(pass) {
      pass.setPipeline(nearPipeline);
      pass.setBindGroup(0, nearBindGroup);
      pass.setVertexBuffer(0, nearMeshBuf);
      for (let a = 0; a < ROCK_ARCHETYPES; a++) {
        pass.setVertexBuffer(
          1,
          shownBuf,
          a * nearCapPerArch * CONTINUUM_INSTANCE_BYTES,
          nearCapPerArch * CONTINUUM_INSTANCE_BYTES,
        );
        pass.drawIndirect(drawsBuf, a * BOULDER_DRAW_WORDS * 4);
      }

      pass.setPipeline(morphPipeline);
      pass.setBindGroup(0, morphBindGroup);
      if (morphExtraBindGroup) pass.setBindGroup(1, morphExtraBindGroup);
      pass.setVertexBuffer(0, morphCornerBuf);
      for (let a = 0; a < ROCK_ARCHETYPES; a++) {
        pass.setVertexBuffer(
          1,
          shownBuf,
          (morphBaseOffset + a * morphCapPerArch) * CONTINUUM_INSTANCE_BYTES,
          morphCapPerArch * CONTINUUM_INSTANCE_BYTES,
        );
        pass.drawIndirect(drawsBuf, (ROCK_ARCHETYPES + a) * BOULDER_DRAW_WORDS * 4);
      }

      pass.setPipeline(splatPipeline);
      pass.setBindGroup(0, splatBindGroup);
      if (splatExtraBindGroup) pass.setBindGroup(1, splatExtraBindGroup);
      pass.setVertexBuffer(
        0,
        shownBuf,
        splatBaseOffset * CONTINUUM_INSTANCE_BYTES,
        splatCap * CONTINUUM_INSTANCE_BYTES,
      );
      pass.drawIndirect(drawsBuf, ROCK_ARCHETYPES * 2 * BOULDER_DRAW_WORDS * 4);
    },
    drawShadow(pass) {
      pass.setPipeline(shadowNearPipeline);
      pass.setBindGroup(0, shadowNearBindGroup);
      pass.setVertexBuffer(0, nearMeshBuf);
      for (let a = 0; a < ROCK_ARCHETYPES; a++) {
        pass.setVertexBuffer(
          1,
          shownBuf,
          a * nearCapPerArch * CONTINUUM_INSTANCE_BYTES,
          nearCapPerArch * CONTINUUM_INSTANCE_BYTES,
        );
        pass.drawIndirect(drawsBuf, a * BOULDER_DRAW_WORDS * 4);
      }

      pass.setPipeline(shadowMorphPipeline);
      pass.setBindGroup(0, shadowMorphBindGroup);
      pass.setVertexBuffer(0, morphCornerBuf);
      for (let a = 0; a < ROCK_ARCHETYPES; a++) {
        pass.setVertexBuffer(
          1,
          shownBuf,
          (morphBaseOffset + a * morphCapPerArch) * CONTINUUM_INSTANCE_BYTES,
          morphCapPerArch * CONTINUUM_INSTANCE_BYTES,
        );
        pass.drawIndirect(drawsBuf, (ROCK_ARCHETYPES + a) * BOULDER_DRAW_WORDS * 4);
      }
    },
    destroy() {
      for (const buf of [
        nearMeshBuf, morphCornerBuf, morphTableBuf, stepMetaBuf, splatUniformBuf,
        srcInstancesBuf, slotGroupsBuf, shownBuf, drawsBuf, cullParamsBuf,
      ]) {
        buf.destroy();
      }
    },
  };
}
