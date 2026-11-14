// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Ocean-going merchant ships (cogs, carracks, caravels, harbor barques) and inland river trade barges
// built from the canonical boat-part system (ship-mesh, ship-part-taxonomy, part-assembly, ship-fracture,
// ship-collider) with real oak/canvas PBR optics and full cannon destructibility.
import { FRAME_WGSL, ATMO_CORE_WGSL, HULL_HOLE_LIMIT, HULL_CRATER_LIMIT } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { SHADOW_FRAME } from './wgsl/shadows.js';
import { VESSEL_LIGHTING, CANVAS_OPTICS } from './wgsl/vessel.js';
import { SHIP_FRACTURE_POSE_UPDATE } from './wgsl/ship-fracture.js';
import { terrainSurfaceSample } from './terrain-model.js';
import { createShipAssetCache } from './ship-mesh.js';
import { getShipModel } from './ship-models.js';
import { rowingDesign, rowingDeck } from './models/rowing.js';
import { computeArchetypeScaleSpec, expandShipPartGroups } from './ship-part-taxonomy.js';
import { createPartAssemblyCatalog, bakeVesselImpactMarks } from './part-assembly.js';
import { prepareShipFracture, createShipFractureGPU } from './ship-fracture.js';
import { createShipCollider } from './ship-collider.js';
import { createVesselDamageState, stepVesselDamage } from './gunnery-control.js';
import { HULL_DAMAGE_UNIFORM_BYTES, writeHullFloodUniform, writeHullCraters } from './hull-flood.js';
import { POSED_VERTEX_LAYOUT } from './vessel-pose.js';

export const TRADE_VESSEL_VERTEX_FLOATS = 9; // pos(3), norm(3), material(1), uv(2)
export const TRADE_VESSEL_INSTANCE_FLOATS = 12; // posYaw(4), attitudeScaleArch(4), animSink(4)
export const TRADE_VESSEL_ARCHETYPES = 7; // 0: cog sail, 1: cog moored, 2: carrack sail, 3: carrack moored, 4: river barge, 5: lateen caravel, 6: harbor barque
export const MAX_TRADE_VESSELS = 96;

export const VESSEL_CONTINUUM_BAND = 0.25;
export const VESSEL_ERROR_PIXELS = 1.5;
export const VESSEL_SPLAT_PIXELS = 3.5;
export const VESSEL_MIN_PIXELS = 1.0;

const TV_HULL_FLOOD_WORDS = 4 * (2 + 2 * HULL_HOLE_LIMIT);
const BARGE_Y_LIFT = 0.12;

const ARCHETYPE_SPECS = Object.freeze([
  Object.freeze({ index: 0, label: 'Underway Cog', modelId: 'pinta', length: 17.5, beam: 5.5, furlSails: false, unmasted: false, addCargo: false }),
  Object.freeze({ index: 1, label: 'Anchored Cog', modelId: 'pinta', length: 17.5, beam: 5.5, furlSails: true, unmasted: false, addCargo: false }),
  Object.freeze({ index: 2, label: 'Underway Carrack', modelId: 'santa-maria', length: 23.6, beam: 7.9, furlSails: false, unmasted: false, addCargo: false }),
  Object.freeze({ index: 3, label: 'Anchored Carrack', modelId: 'santa-maria', length: 23.6, beam: 7.9, furlSails: true, unmasted: false, addCargo: false }),
  Object.freeze({ index: 4, label: 'River Trade Barge', modelId: 'lusoria', length: 13.0, beam: 3.0, furlSails: true, unmasted: true, addCargo: true }),
  Object.freeze({ index: 5, label: 'Lateen Caravel', modelId: 'nina', length: 16.2, beam: 4.9, furlSails: false, unmasted: false, addCargo: false }),
  Object.freeze({ index: 6, label: 'Harbor Barque', modelId: 'nina', length: 10.6, beam: 3.3, furlSails: false, unmasted: false, addCargo: false }),
]);

let sharedAssetCache = null;
const archetypeCache = new Array(TRADE_VESSEL_ARCHETYPES).fill(null);

function warpSectionZ(z, kWaist) {
  const uZ = Math.max(-1, Math.min(1, z / 6.0));
  return z + kWaist * z * (1.0 - uZ * uZ);
}

// Appends a single triangle into a flat 9-float stream (computing analytic normal when omitted).
function pushTri9(verts, inds, a, b, c, matId, uvs = null, na = null, nb = null, nc = null) {
  let nx, ny, nz;
  if (!na || !nb || !nc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    nx = uy * vz - uz * vy;
    ny = uz * vx - ux * vz;
    nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-8) return;
    nx /= len; ny /= len; nz /= len;
  }
  const baseV = Math.floor(verts.length / 9);
  const uv0 = uvs?.[0] ?? [0.25, 0.25];
  const uv1 = uvs?.[1] ?? [0.75, 0.25];
  const uv2 = uvs?.[2] ?? [0.5, 0.75];
  const n0 = na ?? [nx, ny, nz];
  const n1 = nb ?? [nx, ny, nz];
  const n2 = nc ?? [nx, ny, nz];
  verts.push(
    a[0], a[1], a[2], n0[0], n0[1], n0[2], matId, uv0[0], uv0[1],
    b[0], b[1], b[2], n1[0], n1[1], n1[2], matId, uv1[0], uv1[1],
    c[0], c[1], c[2], n2[0], n2[1], n2[2], matId, uv2[0], uv2[1],
  );
  inds.push(baseV, baseV + 1, baseV + 2);
}

function pushQuad9(verts, inds, a, b, c, d, matId, uv = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
  pushTri9(verts, inds, a, b, c, matId, [uv[0], uv[1], uv[2]]);
  pushTri9(verts, inds, a, c, d, matId, [uv[0], uv[2], uv[3]]);
}

// Appends a tapered horizontal or vertical cylindrical drum/bundle between p0 and p1 in design space.
function appendTaperedCylinder(verts, inds, p0, p1, rMid, rEnd, sides, matId, bulgeProfile = 0, radialScale = [1, 1]) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-5) return;
  const ax = [dx / len, dy / len, dz / len];
  const ref = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = ax[1] * ref[2] - ax[2] * ref[1];
  let uy = ax[2] * ref[0] - ax[0] * ref[2];
  let uz = ax[0] * ref[1] - ax[1] * ref[0];
  const uLen = Math.hypot(ux, uy, uz) || 1;
  ux /= uLen; uy /= uLen; uz /= uLen;
  const vx = ax[1] * uz - ax[2] * uy;
  const vy = ax[2] * ux - ax[0] * uz;
  const vz = ax[0] * uy - ax[1] * ux;
  const rings = bulgeProfile > 0 ? 5 : 2;
  const ringPts = [];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const rad = rEnd + (rMid - rEnd) * Math.sin(t * Math.PI);
    const cx = p0[0] + dx * t, cy = p0[1] + dy * t, cz = p0[2] + dz * t;
    const pts = [];
    for (let s = 0; s < sides; s++) {
      const ang = (s / sides) * Math.PI * 2;
      const ca = Math.cos(ang) * rad * radialScale[0];
      const sa = Math.sin(ang) * rad * radialScale[1];
      pts.push([cx + ux * ca + vx * sa, cy + uy * ca + vy * sa, cz + uz * ca + vz * sa]);
    }
    ringPts.push(pts);
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const ns = (s + 1) % sides;
      const u0 = r / rings, u1 = (r + 1) / rings, v0 = s / sides, v1 = (s + 1) / sides;
      pushQuad9(verts, inds, ringPts[r][s], ringPts[r + 1][s], ringPts[r + 1][ns], ringPts[r][ns], matId, [
        [u0, v0], [u1, v0], [u1, v1], [u0, v1],
      ]);
    }
  }
  // End caps
  for (const endIdx of [0, rings]) {
    const center = endIdx === 0 ? p0 : p1;
    const pts = ringPts[endIdx];
    for (let s = 0; s < sides; s++) {
      const ns = (s + 1) % sides;
      if (endIdx === 0) pushTri9(verts, inds, center, pts[ns], pts[s], matId);
      else pushTri9(verts, inds, center, pts[s], pts[ns], matId);
    }
  }
}

function appendFurledSailBundle(verts, inds, minP, maxP, matCanvas = 9, matRope = 12) {
  const sx = maxP[0] - minP[0], sy = maxP[1] - minP[1], sz = maxP[2] - minP[2];
  const span = Math.hypot(sx, sy, sz);
  if (span < 0.25) return;
  const rDrop = Math.min(0.14, span * 0.045);
  // Hang compactly beneath the yard centerline
  const trim = 0.08;
  const p0 = [
    minP[0] + sx * trim,
    minP[1] + sy * trim - rDrop * 0.9,
    minP[2] + sz * trim,
  ];
  const p1 = [
    maxP[0] - sx * trim,
    maxP[1] - sy * trim - rDrop * 0.9,
    maxP[2] - sz * trim,
  ];
  // Main furled canvas bunt (bulges thicker amidships like stowed sailcloth)
  appendTaperedCylinder(verts, inds, p0, p1, rDrop * 1.15, rDrop * 0.42, 8, matCanvas, 1);
  // Tightly wound rope gasket lashings along the yard
  for (const frac of [0.16, 0.36, 0.5, 0.64, 0.84]) {
    const gx0 = p0[0] + (p1[0] - p0[0]) * (frac - 0.014);
    const gy0 = p0[1] + (p1[1] - p0[1]) * (frac - 0.014);
    const gz0 = p0[2] + (p1[2] - p0[2]) * (frac - 0.014);
    const gx1 = p0[0] + (p1[0] - p0[0]) * (frac + 0.014);
    const gy1 = p0[1] + (p1[1] - p0[1]) * (frac + 0.014);
    const gz1 = p0[2] + (p1[2] - p0[2]) * (frac + 0.014);
    const bandR = rDrop * (0.48 + 0.72 * Math.sin(frac * Math.PI));
    appendTaperedCylinder(verts, inds, [gx0, gy0, gz0], [gx1, gy1, gz1], bandR, bandR, 8, matRope, 0);
  }
}

function appendRoundedBox9(verts, inds, cx, cy, cz, hx, hy, hz, matId, bulge = 0.06) {
  const b = (s) => 1 + bulge * (1 - Math.abs(s));
  const corners = [
    [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
    [cx + hx * b(0), cy + hy, cz + hz * b(0)], [cx - hx * b(0), cy + hy, cz + hz * b(0)],
  ];
  const [c0, c1, c2, c3, c4, c5, c6, c7] = corners;
  pushQuad9(verts, inds, c4, c5, c6, c7, matId); // +z
  pushQuad9(verts, inds, c1, c0, c3, c2, matId); // -z
  pushQuad9(verts, inds, c5, c1, c2, c6, matId); // +x
  pushQuad9(verts, inds, c0, c4, c7, c3, matId); // -x
  pushQuad9(verts, inds, c7, c6, c2, c3, matId); // +y
  pushQuad9(verts, inds, c0, c1, c5, c4, matId); // -y
}

function appendLusoriaCargo(verts, inds, groups, modelId = 'lusoria') {
  const nextGroup = (id, fn) => {
    const startIdx = inds.length;
    fn();
    if (inds.length > startIdx) {
      groups.push({ id, nodeId: 'deck.main', firstVertex: startIdx, vertexCount: inds.length - startIdx });
    }
  };
  // 1. Staved oak wine & olive oil casks with iron hoops (aboard hold floorboards)
  nextGroup('cargo.casks', () => {
    const caskSpots = [
      [-0.24, -2.55, 0], [0.24, -2.55, 0],
      [-0.24, -1.75, 0.02], [0.24, -1.75, -0.02],
      [0.0, -2.15, 0.25], [0.0, -1.25, 0.0],
    ];
    for (const [cx, cz, liftY] of caskSpots) {
      const yDeck = rowingDeck(modelId, cz);
      const halfL = 0.28, rMid = 0.145, rEnd = 0.112;
      const yc = yDeck + rMid + liftY;
      appendTaperedCylinder(verts, inds, [cx, yc, cz - halfL], [cx, yc, cz + halfL], rMid, rEnd, 10, 1, 1);
      // Fore & aft forged iron hoops
      for (const hOff of [-0.18, 0.18]) {
        appendTaperedCylinder(
          verts, inds,
          [cx, yc, cz + hOff - 0.022], [cx, yc, cz + hOff + 0.022],
          rMid * 0.96, rMid * 0.96, 10, 3, 0,
        );
      }
    }
  });
  // 2. Corded cloth & raw-wool merchant bales with hemp lashings
  nextGroup('cargo.bales', () => {
    const baleSpots = [
      [-0.26, 0.35, 0.24, 0.18, 0.30, 0],
      [0.25, 0.40, 0.24, 0.18, 0.30, 0],
      [-0.02, 0.95, 0.28, 0.18, 0.32, 0],
      [0.02, 0.62, 0.22, 0.15, 0.24, 0.35],
    ];
    for (const [bx, bz, hx, hy, hz, liftY] of baleSpots) {
      const yDeck = rowingDeck(modelId, bz);
      const cy = yDeck + hy + liftY;
      appendRoundedBox9(verts, inds, bx, cy, bz, hx, hy, hz, 9, 0.08);
      // Crossing hemp cord lashings (matId 12)
      for (const lOff of [-hz * 0.45, hz * 0.45]) {
        appendTaperedCylinder(verts, inds, [bx - hx * 1.03, cy, bz + lOff], [bx + hx * 1.03, cy, bz + lOff], 0.02, 0.02, 6, 12, 0, [1, hy / hx]);
      }
    }
  });
  // 3. Stacked plump grain sacks aft
  nextGroup('cargo.sacks', () => {
    const sackSpots = [
      [-0.25, 2.05, 0], [0.02, 2.08, 0], [0.27, 2.05, 0],
      [-0.14, 2.55, 0.20], [0.16, 2.52, 0.20], [0.0, 2.28, 0.38],
    ];
    for (const [sx, sz, liftY] of sackSpots) {
      const yDeck = rowingDeck(modelId, sz);
      const cy = yDeck + 0.11 + liftY;
      appendTaperedCylinder(verts, inds, [sx, cy, sz - 0.22], [sx, cy, sz + 0.22], 0.14, 0.075, 8, 13, 1, [1.15, 0.85]);
      // Tied sack neck collar (matId 12)
      appendTaperedCylinder(verts, inds, [sx, cy, sz + 0.18], [sx, cy, sz + 0.23], 0.055, 0.055, 6, 12, 0);
    }
  });
}

// Resolves each triangle to its innermost leaf group index, drops unwanted groups, compacts
// vertices/indices, and emits non-overlapping contiguous group ranges for fracture/collider/assembly.
function filterAndCompactMesh(vertices, indices, groups, dropRegex = null) {
  const triCount = Math.floor(indices.length / 3);
  const validGroups = groups.map((g, idx) => ({
    idx,
    id: String(g.id ?? 'hull'),
    nodeId: String(g.nodeId ?? 'hull'),
    motion: g.motion ?? null,
    first: Math.max(0, g.firstVertex ?? 0),
    count: Math.max(0, g.vertexCount ?? 0),
  })).filter((g) => g.count > 0);
  // Smallest-span group wins per triangle (same rule as part-assembly.js & ship-fracture.js).
  validGroups.sort((a, b) => b.count - a.count || a.idx - b.idx);
  const triGroup = new Int32Array(triCount).fill(-1);
  for (let i = 0; i < validGroups.length; i++) {
    const g = validGroups[i];
    const t0 = Math.floor(g.first / 3);
    const t1 = Math.min(triCount, Math.floor((g.first + g.count) / 3));
    if (t1 > t0) triGroup.fill(i, t0, t1);
  }

  // Group kept triangles by leaf group so contiguous group ranges stay clean without splitting into hundreds of slices.
  const buckets = new Map();
  for (let t = 0; t < triCount; t++) {
    const gi = triGroup[t];
    const g = gi >= 0 ? validGroups[gi] : { id: 'hull.outer', nodeId: 'hull', motion: null };
    if (dropRegex && dropRegex.test(g.id)) continue;
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    const a0 = i0 * 9, a1 = i1 * 9, a2 = i2 * 9;
    // Skip zero-area / collapsed triangles (from invisible parts in applyToVertices)
    const d01 = Math.hypot(vertices[a1] - vertices[a0], vertices[a1 + 1] - vertices[a0 + 1], vertices[a1 + 2] - vertices[a0 + 2]);
    const d02 = Math.hypot(vertices[a2] - vertices[a0], vertices[a2 + 1] - vertices[a0 + 1], vertices[a2 + 2] - vertices[a0 + 2]);
    if (d01 < 1e-5 || d02 < 1e-5) continue;
    let list = buckets.get(g.id);
    if (!list) {
      list = { meta: g, tris: [] };
      buckets.set(g.id, list);
    }
    list.tris.push(i0, i1, i2);
  }

  const oldToNew = new Int32Array(Math.floor(vertices.length / 9)).fill(-1);
  const newVerts = [];
  const newInds = [];
  const newGroups = [];
  let nextV = 0;
  for (const { meta, tris } of buckets.values()) {
    const firstVertex = newInds.length;
    for (let k = 0; k < tris.length; k++) {
      const oldIdx = tris[k];
      let mapped = oldToNew[oldIdx];
      if (mapped < 0) {
        mapped = nextV++;
        oldToNew[oldIdx] = mapped;
        const at = oldIdx * 9;
        for (let f = 0; f < 9; f++) newVerts.push(vertices[at + f]);
      }
      newInds.push(mapped);
    }
    newGroups.push({
      id: meta.id,
      nodeId: meta.nodeId,
      firstVertex,
      vertexCount: newInds.length - firstVertex,
      ...(meta.motion ? { motion: meta.motion } : {}),
    });
  }
  return {
    vertices: new Float32Array(newVerts),
    indices: new Uint32Array(newInds),
    groups: newGroups,
  };
}

function groupDesignBounds(vertices, indices, group) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const end = Math.min(indices.length, group.firstVertex + group.vertexCount);
  for (let i = group.firstVertex; i < end; i++) {
    const at = indices[i] * 9;
    for (let c = 0; c < 3; c++) {
      const v = vertices[at + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

// Computes lusoria active oar pivot locks (up to 24 design coords: [px, py, pz, side]) for WGSL animation.
function buildBargeOarPivots(scaleSpec) {
  const pivots = new Float32Array(24 * 4);
  const d = rowingDesign('lusoria');
  for (const s of d.stations) {
    const idx = s.index | 0;
    if (idx < 0 || idx >= 24) continue;
    const pz = warpSectionZ(s.pivot[2], scaleSpec.waistWarpK);
    pivots[idx * 4 + 0] = s.pivot[0];
    pivots[idx * 4 + 1] = s.pivot[1] + BARGE_Y_LIFT;
    pivots[idx * 4 + 2] = pz;
    pivots[idx * 4 + 3] = s.side;
  }
  return pivots;
}

let cachedBargeOarPivots = null;
function bargeOarPivotsForWGSL() {
  if (cachedBargeOarPivots) return cachedBargeOarPivots;
  const s4 = ARCHETYPE_SPECS[4];
  const spec = computeArchetypeScaleSpec({ modelId: s4.modelId, length: s4.length, beam: s4.beam });
  cachedBargeOarPivots = buildBargeOarPivots(spec);
  return cachedBargeOarPivots;
}

function tradeMaterialLinearColor(matId) {
  const m = Math.floor(matId);
  if (m === 9 || m === 13) return [0.82, 0.75, 0.62]; // Baltic canvas
  if (m === 16 || m === 15 || m === 6) return [0.34, 0.25, 0.16]; // decks / spars / oars
  if (m === 2 || m === 12 || m === 19) return [0.36, 0.28, 0.18]; // cordage
  if (m === 3 || m === 4 || m === 8 || m === 11) return [0.16, 0.15, 0.15]; // ironwork / gunwales
  return [0.27, 0.18, 0.11]; // oak hull & castles
}

function buildVesselContinuum(spec, vertices, indices, designScale, beam, length, maxAirDraftMetres) {
  const sx = designScale[0], sy = designScale[1], sz = designScale[2];
  const vertCountAll = Math.floor(vertices.length / 9);
  const sampleStep = Math.max(1, Math.floor(vertCountAll / 240));
  const pts = [];
  const cols = [];
  let sumArea = 0;
  let meanR = 0, meanG = 0, meanB = 0;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < vertCountAll; i += sampleStep) {
    const o = i * 9;
    const x = vertices[o] * sx;
    const y = vertices[o + 1] * sy;
    const z = vertices[o + 2] * sz;
    const col = tradeMaterialLinearColor(vertices[o + 6]);
    pts.push([x, y, z]);
    cols.push(col);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const w = vertices[o + 6] === 9 || vertices[o + 6] === 13 ? 1.8 : 1.0;
    sumArea += w;
    meanR += col[0] * w;
    meanG += col[1] * w;
    meanB += col[2] * w;
  }
  if (!Number.isFinite(minY)) minY = -beam * 0.25;
  if (!Number.isFinite(maxY)) maxY = maxAirDraftMetres;
  const invW = 1 / Math.max(1e-4, sumArea);
  const meanColour = [meanR * invW, meanG * invW, meanB * invW];

  const cx = 0;
  const cy = Math.max(0.25, (minY + maxY) * 0.42);
  const cz = 0;
  const rxEll = Math.max(0.9, beam * 0.54);
  const ryEll = Math.max(0.7, (maxY - minY) * 0.46);
  const rzEll = Math.max(1.8, length * 0.52);

  // Genus-0 watertight manifold sphere topology: R=5 rings x K=10 sectors (V=52, E=150, F=100; V - E + F = 2)
  const RINGS = 5, SEGS = 10;
  const dirs = [[0, -1, 0]];
  for (let r = 1; r <= RINGS; r++) {
    const theta = (r / (RINGS + 1)) * Math.PI - Math.PI * 0.5;
    const ct = Math.cos(theta), st = Math.sin(theta);
    for (let s = 0; s < SEGS; s++) {
      const phi = (s / SEGS) * Math.PI * 2;
      dirs.push([Math.sin(phi) * ct, st, -Math.cos(phi) * ct]);
    }
  }
  dirs.push([0, 1, 0]);
  const V = dirs.length;
  const topIdx = V - 1;

  const initPos = new Array(V);
  const vertColors = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    const d = dirs[i];
    let wSum = 0.05, rAccum = Math.hypot(d[0] * rxEll, d[1] * ryEll, d[2] * rzEll) * 0.05;
    let cR = meanColour[0] * 0.05, cG = meanColour[1] * 0.05, cB = meanColour[2] * 0.05;
    for (let k = 0; k < pts.length; k++) {
      const qx = pts[k][0] - cx, qy = pts[k][1] - cy, qz = pts[k][2] - cz;
      const qLen = Math.hypot(qx, qy, qz);
      if (qLen < 1e-4) continue;
      const dot = (qx * d[0] + qy * d[1] + qz * d[2]) / qLen;
      if (dot > 0.08) {
        const w = Math.pow(dot, 6);
        wSum += w;
        rAccum += w * (qx * d[0] + qy * d[1] + qz * d[2]);
        cR += w * cols[k][0];
        cG += w * cols[k][1];
        cB += w * cols[k][2];
      }
    }
    const rEnv = rAccum / wSum;
    const rEll = 1 / Math.hypot(d[0] / rxEll, d[1] / ryEll, d[2] / rzEll);
    const rFinal = 0.62 * Math.max(rEll * 0.65, rEnv) + 0.38 * rEll;
    initPos[i] = [cx + d[0] * rFinal, cy + d[1] * rFinal, cz + d[2] * rFinal];
    vertColors[i * 3] = Math.min(1, cR / wSum);
    vertColors[i * 3 + 1] = Math.min(1, cG / wSum);
    vertColors[i * 3 + 2] = Math.min(1, cB / wSum);
  }

  // CCW outward winding verified against center
  const rawTris = [];
  for (let s = 0; s < SEGS; s++) {
    const n = (s + 1) % SEGS;
    rawTris.push([0, 1 + n, 1 + s]);
  }
  for (let r = 0; r < RINGS - 1; r++) {
    const r0 = 1 + r * SEGS, r1 = 1 + (r + 1) * SEGS;
    for (let s = 0; s < SEGS; s++) {
      const n = (s + 1) % SEGS;
      rawTris.push([r0 + s, r0 + n, r1 + n]);
      rawTris.push([r0 + s, r1 + n, r1 + s]);
    }
  }
  const topRing = 1 + (RINGS - 1) * SEGS;
  for (let s = 0; s < SEGS; s++) {
    const n = (s + 1) % SEGS;
    rawTris.push([topRing + s, topRing + n, topIdx]);
  }
  for (const t of rawTris) {
    const a = initPos[t[0]], b = initPos[t[1]], c = initPos[t[2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (a[0] + b[0] + c[0]) / 3 - cx, my = (a[1] + b[1] + c[1]) / 3 - cy, mz = (a[2] + b[2] + c[2]) / 3 - cz;
    if (nx * mx + ny * my + nz * mz < 0) {
      const tmp = t[1]; t[1] = t[2]; t[2] = tmp;
    }
  }

  const F = rawTris.length;
  const tris = rawTris.map((t) => [...t]);
  const triAlive = new Uint8Array(F).fill(1);
  const retireStep = new Int32Array(F).fill(999999);
  const curPos = initPos.map((p) => [...p]);
  const vertAlive = new Uint8Array(V).fill(1);
  const ancestor = Int32Array.from({ length: V }, (_, i) => i);
  const resolveVert = (u) => {
    let cur = u;
    while (ancestor[cur] !== cur) cur = ancestor[cur];
    return cur;
  };

  const computeMeshVolumeAndNormals = () => {
    let vol6 = 0;
    const norms = Array.from({ length: V }, () => [0, 0, 0]);
    for (let t = 0; t < F; t++) {
      if (!triAlive[t]) continue;
      const a = curPos[tris[t][0]], b = curPos[tris[t][1]], c = curPos[tris[t][2]];
      const ax = a[0] - cx, ay = a[1] - cy, az = a[2] - cz;
      const bx = b[0] - cx, by = b[1] - cy, bz = b[2] - cz;
      const ccx = c[0] - cx, ccy = c[1] - cy, ccz = c[2] - cz;
      const crx = by * ccz - bz * ccy, cry = bz * ccx - bx * ccz, crz = bx * ccy - by * ccx;
      vol6 += ax * crx + ay * cry + az * crz;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const fnx = uy * vz - uz * vy, fny = uz * vx - ux * vz, fnz = ux * vy - uy * vx;
      for (let k = 0; k < 3; k++) {
        norms[tris[t][k]][0] += fnx;
        norms[tris[t][k]][1] += fny;
        norms[tris[t][k]][2] += fnz;
      }
    }
    const outNorm = new Float32Array(V * 3);
    const outPos = new Float32Array(V * 3);
    for (let i = 0; i < V; i++) {
      const r = resolveVert(i);
      const p = curPos[r];
      const n = norms[r];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      outPos[i * 3] = p[0]; outPos[i * 3 + 1] = p[1]; outPos[i * 3 + 2] = p[2];
      outNorm[i * 3] = n[0] / nl; outNorm[i * 3 + 1] = n[1] / nl; outNorm[i * 3 + 2] = n[2] / nl;
    }
    return { vol: Math.max(1e-3, Math.abs(vol6) / 6), outPos, outNorm };
  };

  const statePositions = [];
  const stateNormals = [];
  const stepErrorsList = [0];
  const stepScalesList = [1.0];
  const initialStats = computeMeshVolumeAndNormals();
  const vol0 = initialStats.vol;
  statePositions.push(initialStats.outPos);
  stateNormals.push(initialStats.outNorm);

  let aliveTris = F;
  let prevErr = 0.02;
  let stepIdx = 0;
  const MAX_COLLAPSE_STEPS = 48;

  while (aliveTris > 6 && stepIdx < MAX_COLLAPSE_STEPS) {
    const adjVerts = Array.from({ length: V }, () => new Set());
    const edgeTris = new Map();
    for (let t = 0; t < F; t++) {
      if (!triAlive[t]) continue;
      const [a, b, c] = tris[t];
      adjVerts[a].add(b); adjVerts[a].add(c);
      adjVerts[b].add(a); adjVerts[b].add(c);
      adjVerts[c].add(a); adjVerts[c].add(b);
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const u = Math.min(p, q), v = Math.max(p, q);
        const key = `${u}:${v}`;
        let list = edgeTris.get(key);
        if (!list) { list = []; edgeTris.set(key, list); }
        list.push(t);
      }
    }

    let bestEdge = null;
    let bestCost = Infinity;
    for (const [key, shared] of edgeTris.entries()) {
      if (shared.length !== 2) continue;
      const sep = key.indexOf(':');
      const u = Number(key.slice(0, sep));
      const v = Number(key.slice(sep + 1));
      if (!vertAlive[u] || !vertAlive[v]) continue;
      // Strict link condition keeps genus-0 closed 2-manifold intact
      let commonCount = 0;
      for (const n of adjVerts[u]) {
        if (adjVerts[v].has(n)) commonCount++;
      }
      if (commonCount !== 2) continue;

      const pu = curPos[u], pv = curPos[v];
      const mid = [(pu[0] + pv[0]) * 0.5, (pu[1] + pv[1]) * 0.5, (pu[2] + pv[2]) * 0.5];
      const edgeLen = Math.hypot(pu[0] - pv[0], pu[1] - pv[1], pu[2] - pv[2]);
      let valid = true;
      for (let t = 0; t < F; t++) {
        if (!triAlive[t] || t === shared[0] || t === shared[1]) continue;
        const tri = tris[t];
        if (!tri.includes(u) && !tri.includes(v)) continue;
        const a0 = curPos[tri[0]], b0 = curPos[tri[1]], c0 = curPos[tri[2]];
        const u0x = b0[0] - a0[0], u0y = b0[1] - a0[1], u0z = b0[2] - a0[2];
        const v0x = c0[0] - a0[0], v0y = c0[1] - a0[1], v0z = c0[2] - a0[2];
        const n0x = u0y * v0z - u0z * v0y, n0y = u0z * v0x - u0x * v0z, n0z = u0x * v0y - u0y * v0x;
        const a1 = (tri[0] === u || tri[0] === v) ? mid : a0;
        const b1 = (tri[1] === u || tri[1] === v) ? mid : b0;
        const c1 = (tri[2] === u || tri[2] === v) ? mid : c0;
        const u1x = b1[0] - a1[0], u1y = b1[1] - a1[1], u1z = b1[2] - a1[2];
        const v1x = c1[0] - a1[0], v1y = c1[1] - a1[1], v1z = c1[2] - a1[2];
        const n1x = u1y * v1z - u1z * v1y, n1y = u1z * v1x - u1x * v1z, n1z = u1x * v1y - u1y * v1x;
        const l0 = Math.hypot(n0x, n0y, n0z), l1 = Math.hypot(n1x, n1y, n1z);
        if (l1 < 1e-5 || (n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1 + 1e-8) < 0.05) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      if (edgeLen < bestCost) {
        bestCost = edgeLen;
        bestEdge = { u, v, mid, shared };
      }
    }

    if (!bestEdge) break;
    const { u, v, mid, shared } = bestEdge;
    curPos[v] = mid;
    vertAlive[u] = 0;
    ancestor[u] = v;
    for (const t of shared) {
      triAlive[t] = 0;
      retireStep[t] = stepIdx;
      aliveTris--;
    }
    for (let t = 0; t < F; t++) {
      if (!triAlive[t]) continue;
      for (let k = 0; k < 3; k++) {
        if (tris[t][k] === u) tris[t][k] = v;
      }
    }

    const stats = computeMeshVolumeAndNormals();
    const scale = Math.max(1.0, Math.min(1.18, Math.cbrt(vol0 / Math.max(stats.vol, 1e-4))));
    const nextErr = Math.max(prevErr + 0.012, bestCost * 0.45);
    prevErr = nextErr;
    stepErrorsList.push(nextErr);
    stepScalesList.push(scale);
    statePositions.push(stats.outPos);
    stateNormals.push(stats.outNorm);
    stepIdx++;
  }

  // Final morph state projects surviving <=6-triangle core onto analytical silhouette ellipsoid
  const ellPos = new Float32Array(V * 3);
  const ellNorm = new Float32Array(V * 3);
  const prevPos = statePositions[statePositions.length - 1];
  for (let i = 0; i < V; i++) {
    const px = prevPos[i * 3] - cx, py = prevPos[i * 3 + 1] - cy, pz = prevPos[i * 3 + 2] - cz;
    const s = 1 / Math.max(1e-4, Math.hypot(px / rxEll, py / ryEll, pz / rzEll));
    ellPos[i * 3] = cx + px * s;
    ellPos[i * 3 + 1] = cy + py * s;
    ellPos[i * 3 + 2] = cz + pz * s;
    const nx = (px * s) / (rxEll * rxEll);
    const ny = (py * s) / (ryEll * ryEll);
    const nz = (pz * s) / (rzEll * rzEll);
    const nl = Math.hypot(nx, ny, nz) || 1;
    ellNorm[i * 3] = nx / nl; ellNorm[i * 3 + 1] = ny / nl; ellNorm[i * 3 + 2] = nz / nl;
  }
  const endErr = Math.max(prevErr + 0.08, 0.24 * Math.max(rxEll, ryEll, rzEll));
  stepErrorsList.push(endErr);
  stepScalesList.push(1.0);
  statePositions.push(ellPos);
  stateNormals.push(ellNorm);

  // Order triangles by descending retireStep so core <=6 triangles lead and collapsing tris retire cleanly at the tail
  const order = Array.from({ length: F }, (_, t) => t).sort((a, b) => retireStep[b] - retireStep[a]);
  const baseIndices = new Uint32Array(F * 3);
  const sortedRetire = new Int32Array(F);
  for (let i = 0; i < F; i++) {
    const t = order[i];
    const rt = rawTris[t];
    baseIndices[i * 3] = rt[0];
    baseIndices[i * 3 + 1] = rt[1];
    baseIndices[i * 3 + 2] = rt[2];
    sortedRetire[i] = retireStep[t];
  }

  const totalStates = statePositions.length; // stepCount + 1
  const stepCount = totalStates - 1;
  const activeTriCounts = new Uint32Array(totalStates);
  for (let s = 0; s < totalStates; s++) {
    let count = 0;
    while (count < F && sortedRetire[count] >= s) count++;
    activeTriCounts[s] = count;
  }

  const morphPositions = new Float32Array(totalStates * V * 3);
  const morphNormals = new Float32Array(totalStates * V * 3);
  for (let s = 0; s < totalStates; s++) {
    const sc = stepScalesList[s];
    const sp = statePositions[s];
    const sn = stateNormals[s];
    const dstOff = s * V * 3;
    for (let i = 0; i < V; i++) {
      morphPositions[dstOff + i * 3] = cx + (sp[i * 3] - cx) * sc;
      morphPositions[dstOff + i * 3 + 1] = cy + (sp[i * 3 + 1] - cy) * sc;
      morphPositions[dstOff + i * 3 + 2] = cz + (sp[i * 3 + 2] - cz) * sc;
      morphNormals[dstOff + i * 3] = sn[i * 3];
      morphNormals[dstOff + i * 3 + 1] = sn[i * 3 + 1];
      morphNormals[dstOff + i * 3 + 2] = sn[i * 3 + 2];
    }
  }

  const radius = Math.hypot(rxEll, ryEll, rzEll);
  // Finest continuum geometric error ~ 0.08 * max(beam, airDraft) ensures crisp full-rig near ship transitioning cleanly past ~150-300 m
  const startError = Math.max(0.08, Math.min(0.45, beam * 0.05));
  stepErrorsList[0] = startError;
  for (let s = 1; s < totalStates; s++) {
    if (stepErrorsList[s] <= stepErrorsList[s - 1]) stepErrorsList[s] = stepErrorsList[s - 1] + 0.015;
  }

  return Object.freeze({
    vertCount: V,
    triCount: F,
    coreTriCount: activeTriCounts[totalStates - 1],
    stepCount,
    stateCount: totalStates,
    genusZeroEuler: V - ((F * 3) / 2) + F,
    baseIndices,
    activeTriCounts,
    stepErrors: new Float32Array(stepErrorsList),
    stepScales: new Float32Array(stepScalesList),
    morphPositions,
    morphNormals,
    vertColors,
    splat: Object.freeze({
      centre: [cx, cy, cz],
      rx: rxEll,
      ry: ryEll,
      rz: rzEll,
      radius,
      colour: meanColour,
    }),
  });
}

function buildArchetypeData(index) {
  const spec = ARCHETYPE_SPECS[index] ?? ARCHETYPE_SPECS[0];
  if (!sharedAssetCache) sharedAssetCache = createShipAssetCache();
  const base = sharedAssetCache.get(spec.modelId);
  const model = getShipModel(spec.modelId);
  const scaleSpec = computeArchetypeScaleSpec({ modelId: spec.modelId, length: spec.length, beam: spec.beam });

  let vertsArr = Array.from(base.vertices);
  let indsArr = Array.from(base.indices);
  let groupsArr = expandShipPartGroups(spec.modelId, base.groups, base.vertices, base.indices).map((g) => ({ ...g }));

  // Anchored cogs/carracks replace spread square/lateen sails and running gear with furled linen bundles under each active yard.
  // River barges drop masts, standing/running rigging, and excess galley oar pairs so cargo & compact sweeps fit narrow canals.
  let dropRegex = null;
  if (spec.index === 4) {
    dropRegex = /^(?:(?:mast|yard|sail|rig|lookout|flag)\.|rowing\.(?:station|propulsor)\.rower\.(?:port|starboard)\.(?:01|03|06|07|10)$)/i;
  } else if (spec.unmasted) {
    dropRegex = /^(mast|yard|sail|rig|lookout|flag)\./i;
  } else if (spec.furlSails) {
    dropRegex = /^(sail|rig\.running)\./i;
    const yardGroups = groupsArr.filter((g) => /^yard\./i.test(g.id));
    for (const yg of yardGroups) {
      const bounds = groupDesignBounds(base.vertices, base.indices, yg);
      if (!Number.isFinite(bounds.min[0])) continue;
      // Determine spar endpoints across its longest axis (square yards run X; lateen yards run Z).
      const spanX = bounds.max[0] - bounds.min[0];
      const spanZ = bounds.max[2] - bounds.min[2];
      const cy = (bounds.min[1] + bounds.max[1]) * 0.5;
      const p0 = spanX >= spanZ
        ? [bounds.min[0], cy, (bounds.min[2] + bounds.max[2]) * 0.5]
        : [(bounds.min[0] + bounds.max[0]) * 0.5, bounds.min[1] + (bounds.max[1] - bounds.min[1]) * 0.25, bounds.min[2]];
      const p1 = spanX >= spanZ
        ? [bounds.max[0], cy, (bounds.min[2] + bounds.max[2]) * 0.5]
        : [(bounds.min[0] + bounds.max[0]) * 0.5, bounds.min[1] + (bounds.max[1] - bounds.min[1]) * 0.75, bounds.max[2]];
      const startIdx = indsArr.length;
      appendFurledSailBundle(vertsArr, indsArr, p0, p1, 9, 12);
      if (indsArr.length > startIdx) {
        groupsArr.push({
          id: `sail.furled.${yg.id.slice(5)}`,
          nodeId: 'hull',
          firstVertex: startIdx,
          vertexCount: indsArr.length - startIdx,
        });
      }
    }
  }

  if (spec.addCargo && spec.modelId === 'lusoria') {
    appendLusoriaCargo(vertsArr, indsArr, groupsArr, spec.modelId);
  }

  // First compaction drops stripped masts/sails cleanly before non-rubberband scaling.
  const stripped = filterAndCompactMesh(
    vertsArr instanceof Float32Array ? vertsArr : new Float32Array(vertsArr),
    indsArr instanceof Uint32Array ? indsArr : new Uint32Array(indsArr),
    groupsArr,
    dropRegex,
  );

  // Apply Universal Boat Part Taxonomy non-rubberband warping, discrete mast/oar pruning, and rig-height scaling.
  const tmpCatalog = createPartAssemblyCatalog({
    domain: 'ship',
    modelId: spec.modelId,
    vertices: stripped.vertices,
    vertexStride: 9,
    indices: stripped.indices,
    groups: stripped.groups,
  });
  const tmpState = tmpCatalog.createState();
  tmpState.syncVesselDamage(null, { modelId: spec.modelId, length: spec.length, beam: spec.beam });
  const warpedVerts = tmpState.applyToVertices(stripped.vertices);

  if (spec.index === 4) {
    const pivots = bargeOarPivotsForWGSL();
    for (let i = 0; i < warpedVerts.length; i += 9) {
      warpedVerts[i + 1] += BARGE_Y_LIFT;
      const mat = warpedVerts[i + 6];
      if (Math.floor(mat) === 16) {
        const stationIdx = Math.min(23, Math.max(0, Math.round((mat - 16.0) * 64.0)));
        const pairIdx = stationIdx >> 1;
        const px = pivots[stationIdx * 4];
        const py = pivots[stationIdx * 4 + 1];
        const pz = pivots[stationIdx * 4 + 2];
        const side = pivots[stationIdx * 4 + 3];
        if (pairIdx !== 1 && pairIdx !== 3 && pairIdx !== 4 && pairIdx !== 7 && pairIdx !== 8 && pairIdx !== 10 && pairIdx !== 11) {
          warpedVerts[i] = px;
          warpedVerts[i + 1] = py;
          warpedVerts[i + 2] = pz;
        } else {
          const dx = warpedVerts[i] - px;
          const dy = warpedVerts[i + 1] - py;
          if (dx * side > 0) {
            warpedVerts[i] = px + dx * 0.46;
            warpedVerts[i + 1] = py + dy * 0.62;
          }
        }
      }
    }
  }

  // Second compaction eliminates triangles collapsed by discrete pruning (e.g., Harbor Barque pruned masts or reduced oar pairs).
  const finalMesh = filterAndCompactMesh(warpedVerts, stripped.indices, stripped.groups, null);

  const preFracture = prepareShipFracture({
    modelId: spec.modelId,
    model,
    vertices: finalMesh.vertices,
    indices: finalMesh.indices,
    groups: finalMesh.groups,
  });

  const frame = model.designFrame;
  const designScale = [
    spec.beam / (frame.beam || 3.6),
    frame.verticalScale || 1,
    spec.length / (frame.length || 12),
  ];

  let maxYDesign = -Infinity;
  for (let i = 1; i < preFracture.vertices.length; i += 9) {
    if (preFracture.vertices[i] > maxYDesign) maxYDesign = preFracture.vertices[i];
  }
  const maxAirDraftMetres = Math.max(0.5, maxYDesign * designScale[1]);

  const partAssembly = createPartAssemblyCatalog({
    domain: 'ship',
    modelId: spec.modelId,
    vertices: preFracture.vertices,
    vertexStride: 9,
    indices: preFracture.indices,
    groups: preFracture.groups,
  });

  const collider = createShipCollider({
    model,
    vertices: preFracture.vertices,
    indices: preFracture.indices,
    groups: preFracture.groups,
    fracture: preFracture.fracture,
  });

  const baseHydro = spec.modelId === 'lusoria'
    ? rowingDesign('lusoria')
    : { draft: Math.max(0.9, spec.beam * 0.34), freeboard: Math.max(0.8, spec.beam * 0.28) };

  const draft = spec.modelId === 'lusoria' ? 0.38 : Math.max(1.1, spec.beam * 0.34);
  const freeboard = spec.modelId === 'lusoria' ? 0.55 : Math.max(1.0, spec.beam * 0.28);
  const continuum = buildVesselContinuum(
    spec,
    preFracture.vertices,
    preFracture.indices,
    designScale,
    spec.beam,
    spec.length,
    maxAirDraftMetres,
  );

  return Object.freeze({
    index: spec.index,
    label: spec.label,
    modelId: spec.modelId,
    model,
    length: spec.length,
    beam: spec.beam,
    draft,
    freeboard,
    designScale,
    scaleSpec,
    maxAirDraftMetres,
    vertices: preFracture.vertices,
    indices: preFracture.indices,
    groups: preFracture.groups,
    partAssembly,
    fracture: preFracture.fracture,
    collider,
    continuum,
    vertexCount: Math.floor(preFracture.vertices.length / 9),
    indexCount: preFracture.indices.length,
    triangleCount: Math.floor(preFracture.indices.length / 3),
    baseHydro,
  });
}

export function getTradeVesselArchetype(index) {
  const idx = Math.max(0, Math.min(TRADE_VESSEL_ARCHETYPES - 1, index | 0));
  if (!archetypeCache[idx]) archetypeCache[idx] = buildArchetypeData(idx);
  return archetypeCache[idx];
}

export function inspectTradeVesselArchetypes() {
  return Array.from({ length: TRADE_VESSEL_ARCHETYPES }, (_, i) => getTradeVesselArchetype(i));
}

function hashU32(a, b = 0) {
  let x = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) | 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function buildPolylineRoute(rawPts, origin, elevationAt = null) {
  const pts = [];
  let total = 0;
  for (let i = 0; i < rawPts.length; i++) {
    const p = rawPts[i];
    const x = origin.x + p.x;
    const z = origin.z + p.z;
    const y = Number.isFinite(p.wy) ? p.wy : (elevationAt ? elevationAt(x, z) : 0);
    if (pts.length) {
      const prev = pts[pts.length - 1];
      const seg = Math.hypot(x - prev.x, z - prev.z);
      if (seg < 0.5 && i < rawPts.length - 1) continue;
      total += seg;
    }
    pts.push({
      x,
      y,
      z,
      vx: Number.isFinite(p.vx) ? p.vx : NaN,
      vz: Number.isFinite(p.vz) ? p.vz : NaN,
      acc: total,
    });
  }
  return pts.length >= 2 && total > 1 ? { pts, totalLen: total } : null;
}

function evalPolylineAt(pts, dist) {
  const flowAt = (a, b, u, dx, dz, len2) => {
    const hasA = Number.isFinite(a?.vx) && Number.isFinite(a?.vz);
    const hasB = Number.isFinite(b?.vx) && Number.isFinite(b?.vz);
    if (hasA && hasB) return [a.vx + (b.vx - a.vx) * u, a.vz + (b.vz - a.vz) * u];
    if (hasA) return [a.vx, a.vz];
    if (hasB) return [b.vx, b.vz];
    return [(dx / len2) * 0.85, (dz / len2) * 0.85];
  };
  if (dist <= 0) {
    const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y, dz = pts[1].z - pts[0].z;
    const len2 = Math.hypot(dx, dz) || 1;
    const [vx, vz] = flowAt(pts[0], pts[1], 0, dx, dz, len2);
    return { x: pts[0].x, y: pts[0].y, z: pts[0].z, tx: dx / len2, ty: dy / len2, tz: dz / len2, vx, vz };
  }
  const last = pts[pts.length - 1];
  if (dist >= last.acc) {
    const prev = pts[pts.length - 2];
    const dx = last.x - prev.x, dy = last.y - prev.y, dz = last.z - prev.z;
    const len2 = Math.hypot(dx, dz) || 1;
    const [vx, vz] = flowAt(prev, last, 1, dx, dz, len2);
    return { x: last.x, y: last.y, z: last.z, tx: dx / len2, ty: dy / len2, tz: dz / len2, vx, vz };
  }
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].acc >= dist) {
      const a = pts[i - 1], b = pts[i], span = Math.max(1e-4, b.acc - a.acc), u = (dist - a.acc) / span;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, len2 = Math.hypot(dx, dz) || 1;
      const [vx, vz] = flowAt(a, b, u, dx, dz, len2);
      return {
        x: a.x + dx * u,
        y: a.y + dy * u,
        z: a.z + dz * u,
        tx: dx / len2,
        ty: dy / len2,
        tz: dz / len2,
        vx,
        vz,
      };
    }
  }
  return { x: last.x, y: last.y, z: last.z, tx: 0, ty: 0, tz: -1, vx: 0, vz: 0 };
}

/**
 * Normalizes live board merchant ships (`W.ships`), sea/river caravans, and navigable `riverReaches`
 * into an ordered list of vessel route records for rendering or CPU verification.
 */
export function buildTradeVesselRoutes(snapshot, origin = { x: 0, z: 0 }, { riverReaches = [], places = [], seaLevel = 0, heights = null, region = null, port = null, bridges = [] } = {}) {
  const routes = [];
  const ox = origin.x || 0, oz = origin.z || 0;
  const hasBedSampler = Boolean(heights && region && Number.isFinite(region.span) && region.span > 0);
  const bedRegion = hasBedSampler ? (region.size ? region : { ...region, size: Math.round(Math.sqrt(heights.length)) }) : null;
  const bedElevationAt = (wx, wz) => {
    if (!bedRegion || !bedRegion.size) return -12;
    const half = bedRegion.span * 0.5 - 0.5;
    const cx = Math.max(bedRegion.x - half, Math.min(bedRegion.x + half, wx));
    const cz = Math.max(bedRegion.z - half, Math.min(bedRegion.z + half, wz));
    const y = terrainSurfaceSample(heights, cx, cz, bedRegion);
    return Number.isFinite(y) ? y : -12;
  };
  const dockBerth = port?.dockBerth || null;
  const berthX = dockBerth ? (dockBerth.wx ?? dockBerth.x ?? NaN) : NaN;
  const berthZ = dockBerth ? (dockBerth.wz ?? dockBerth.z ?? NaN) : NaN;
  const isSafeWater = (wx, wz, maxBedY = -2.6, clearance = 18) => {
    if (Number.isFinite(berthX) && Number.isFinite(berthZ) && Math.hypot(wx - berthX, wz - berthZ) < 52) {
      return false;
    }
    if (bedElevationAt(wx, wz) > maxBedY) return false;
    if (clearance > 0 && bedRegion) {
      if (bedElevationAt(wx + clearance, wz) > maxBedY + 0.35) return false;
      if (bedElevationAt(wx - clearance, wz) > maxBedY + 0.35) return false;
      if (bedElevationAt(wx, wz + clearance) > maxBedY + 0.35) return false;
      if (bedElevationAt(wx, wz - clearance) > maxBedY + 0.35) return false;
    }
    return true;
  };
  const nearestSafeWater = (wx, wz, maxBedY = -2.6, minDist = 0, maxRadius = 420, clearance = 18) => {
    if (isSafeWater(wx, wz, maxBedY, clearance) && minDist <= 0) return { x: wx, z: wz };
    for (let r = Math.max(22, minDist); r <= maxRadius; r += 22) {
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const cx = wx + Math.cos(ang) * r;
        const cz = wz + Math.sin(ang) * r;
        if (isSafeWater(cx, cz, maxBedY, clearance)) return { x: cx, z: cz };
      }
    }
    return { x: wx, z: wz };
  };
  const clampSeaPolyToSafeWater = (poly, maxBedY = -2.4, clearance = 14) => {
    if (!poly || !bedRegion) return poly;
    const pts = [];
    let acc = 0;
    for (let i = 0; i < poly.pts.length; i++) {
      const p = poly.pts[i];
      const safe = nearestSafeWater(p.x, p.z, maxBedY, 0, 360, clearance);
      if (pts.length) {
        const prev = pts[pts.length - 1];
        const seg = Math.hypot(safe.x - prev.x, safe.z - prev.z);
        if (seg < 0.5 && i < poly.pts.length - 1) continue;
        acc += seg;
      }
      pts.push({ x: safe.x, y: p.y, z: safe.z, acc });
    }
    return pts.length >= 2 && acc > 1 ? { pts, totalLen: acc } : poly;
  };
  const isSegmentSafeWater = (a, b, maxBedY = -1.6, clearance = 14) => {
    for (let k = 0; k <= 4; k++) {
      const u = k / 4;
      if (!isSafeWater(a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u, maxBedY, clearance)) return false;
    }
    return true;
  };

  const parseFlatPairs = (arr) => {
    const out = [];
    for (let i = 0; i + 1 < arr.length; i += 2) out.push({ x: arr[i], z: arr[i + 1] });
    return out;
  };
  const reachStations = (r) => {
    if (Array.isArray(r?.stations)) return r.stations;
    if (Array.isArray(r?.points)) {
      return r.points.map(([wx, wz, hw, wy, p4, vx, vz, thalwegB]) => ({
        wx, wz, hw, wy,
        thalweg: Number.isFinite(thalwegB) ? thalwegB : p4,
        vx: Number.isFinite(vx) ? vx : NaN,
        vz: Number.isFinite(vz) ? vz : NaN,
      }));
    }
    return [];
  };
  const riverYAt = (wx, wz) => {
    let bestD = Infinity, bestY = seaLevel + 0.04;
    for (const reach of riverReaches) {
      for (const st of reachStations(reach)) {
        const d = (st.wx - wx) ** 2 + (st.wz - wz) ** 2;
        if (d < bestD) { bestD = d; bestY = st.wy; }
      }
    }
    return bestD < 2500 ? bestY : seaLevel + 0.04;
  };
  const blockedByLowBridge = (wx, wz, wy) => {
    for (const b of bridges ?? []) {
      if (!b || !Number.isFinite(b.deckY)) continue;
      const reach = Math.max(8, (b.length || 12) * 0.55);
      // Barges under 2.4 m air-draft pass freely beneath higher arched stone bridges.
      if (Math.hypot(wx - b.x, wz - b.z) <= reach && (b.deckY - wy) < 2.65) return true;
    }
    return false;
  };

  for (const sh of snapshot?.ships ?? []) {
    const carrack = sh.kind === 'carrack' || sh.kind === 'hulk';
    const scale = sh.kind === 'carrack' ? 1.08 : sh.kind === 'hulk' ? 0.98 : sh.kind === 'great cog' ? 0.96 : 0.88;
    const rawPoly = Array.isArray(sh.points) && sh.points.length >= 4 ? buildPolylineRoute(parseFlatPairs(sh.points), { x: ox, z: oz }, () => seaLevel) : null;
    const poly = rawPoly ? clampSeaPolyToSafeWater(rawPoly, -2.4, carrack ? 20 : 14) : null;
    const portBerths = Array.isArray(sh.portBerths)
      ? sh.portBerths.map((b) => {
          const safeB = nearestSafeWater(ox + b.x, oz + b.z, -2.6, 0, 420, carrack ? 22 : 16);
          return { x: safeB.x, y: seaLevel, z: safeB.z, rot: b.rot || 0, shore: Boolean(b.shore) };
        })
      : [];
    if (sh.phase === 'dock' && sh.berth) {
      const safeB = nearestSafeWater(ox + sh.berth.x, oz + sh.berth.z, -2.6, 0, 420, carrack ? 22 : 16);
      routes.push({
        id: `ship:${sh.id}`, shipId: sh.id, mode: 'sea', phase: 'dock',
        archetype: carrack ? 3 : 1,
        scale,
        depart: sh.t0 ?? 0, arrive: sh.t1 ?? 1, until: sh.until ?? 0, waited: sh.waited ?? 0, bi: sh.bi ?? -1,
        berth: { x: safeB.x, y: seaLevel, z: safeB.z, rot: sh.berth.rot || 0, shore: Boolean(sh.berth.shore) },
        portBerths,
        pts: poly?.pts ?? null, totalLen: poly?.totalLen ?? 0,
        phaseOffset: (hashU32(sh.id | 0, 17) % 1000) / 1000,
      });
      continue;
    }
    if (!poly) continue;
    routes.push({
      id: `ship:${sh.id}`, shipId: sh.id, mode: 'sea', phase: sh.phase === 'out' ? 'out' : 'in',
      archetype: carrack ? 2 : 0,
      scale,
      depart: sh.t0 ?? 0, arrive: sh.t1 ?? 1, until: sh.until ?? 0, waited: sh.waited ?? 0, bi: sh.bi ?? -1,
      berth: null,
      portBerths,
      pts: poly.pts, totalLen: poly.totalLen,
      phaseOffset: (hashU32(sh.id | 0, 29) % 1000) / 1000,
    });
  }

  for (const c of snapshot?.list ?? []) {
    if (c.mode !== 'sea' && c.mode !== 'river') continue;
    if (!Array.isArray(c.points) || c.points.length < 4) continue;
    const isRiver = c.mode === 'river';
    const rawPoly = buildPolylineRoute(parseFlatPairs(c.points), { x: ox, z: oz }, isRiver ? riverYAt : () => seaLevel);
    const poly = rawPoly && !isRiver ? clampSeaPolyToSafeWater(rawPoly, -2.2, 14) : rawPoly;
    if (!poly) continue;
    const seaArchetype = [5, 0, 2, 5][(hashU32(c.index | 0, 41)) & 3];
    routes.push({
      id: `caravan:${c.key ?? c.index}`, caravanKey: c.key ?? null, mode: c.mode, phase: 'caravan',
      archetype: isRiver ? 4 : seaArchetype,
      scale: isRiver ? 0.78 : seaArchetype === 5 ? 0.92 : 0.94,
      depart: c.depart ?? 0, arrive: Math.max((c.depart ?? 0) + 0.1, c.arrive ?? 1),
      berth: null,
      pts: poly.pts, totalLen: poly.totalLen,
      phaseOffset: (hashU32(c.index | 0, 53) % 1000) / 1000,
    });
  }

  // Navigable-reach river trade barges steered into the deep thalweg channel clear of low bridges and banks.
  const navigable = [];
  for (const r of riverReaches) {
    const stations = reachStations(r);
    let seg = [];
    const flush = () => {
      if (seg.length >= 3) {
        let len = 0, minHw = Infinity;
        for (let i = 0; i < seg.length; i++) {
          minHw = Math.min(minHw, seg[i].hw || 2.2);
          if (i > 0) len += Math.hypot(seg[i].wx - seg[i - 1].wx, seg[i].wz - seg[i - 1].wz);
        }
        if (len >= 160) navigable.push({ stations: seg.slice(), length: len, minHw });
      }
      seg = [];
    };
    for (const s of stations) {
      if ((s.hw ?? r.minHalfWidth ?? 0) >= 2.05 && !blockedByLowBridge(s.wx, s.wz, s.wy)) seg.push(s);
      else flush();
    }
    flush();
  }
  navigable.sort((a, b) => b.length - a.length);
  for (let ri = 0; ri < navigable.length && routes.length < MAX_TRADE_VESSELS; ri++) {
    const reach = navigable[ri];
    const sts = reach.stations;
    const bargeScale = Math.max(0.60, Math.min(0.92, (reach.minHw - 0.35) / 2.15));
    const halfSpan = 2.10 * bargeScale;
    const pts = sts.map((s, idx) => {
      const prev = sts[Math.max(0, idx - 1)];
      const next = sts[Math.min(sts.length - 1, idx + 1)];
      const dx = next.wx - prev.wx, dz = next.wz - prev.wz;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const maxLat = Math.max(0, (s.hw || 2.2) - halfSpan - 0.25);
      const lat = Number.isFinite(s.thalweg) ? s.thalweg * Math.min(1.0, maxLat * 0.65) : 0;
      return {
        x: s.wx + nx * lat,
        z: s.wz + nz * lat,
        wy: s.wy,
        vx: Number.isFinite(s.vx) ? s.vx : NaN,
        vz: Number.isFinite(s.vz) ? s.vz : NaN,
      };
    });
    let acc = 0;
    const linePts = pts.map((p, idx) => {
      if (idx > 0) acc += Math.hypot(p.x - pts[idx - 1].x, p.z - pts[idx - 1].z);
      return { x: p.x, y: p.wy, z: p.z, vx: p.vx, vz: p.vz, acc };
    });
    const boats = reach.length > 900 ? 2 : 1;
    for (let b = 0; b < boats && routes.length < MAX_TRADE_VESSELS; b++) {
      routes.push({
        id: `reach:${ri}:${b}`, mode: 'river', phase: 'shuttle',
        archetype: 4, scale: bargeScale * (b === 0 ? 1.0 : 0.94),
        depart: 0, arrive: 1, berth: null,
        pts: linePts, totalLen: acc,
        phaseOffset: ((hashU32(ri + 1, b + 7) % 1000) / 1000),
      });
    }
  }

  // Synthesize a procedural harbor & bay fleet: anchored ocean carracks/cogs + moving lateen caravels and harbor barques.
  const harbors = (places ?? []).filter((p) => p && (p.harbor || p.harbour || p.kind === 'capital' || p.kind === 'town' || p.kind === 'village'));
  const primary = harbors.find((p) => p.harbor || p.harbour || p.kind === 'capital' || p.kind === 'town')
    || (dockBerth ? { x: berthX, z: berthZ, kind: 'town', harbor: true } : harbors[0]);
  if (primary) {
    const hx = primary.x, hz = primary.z;
    const existingDockSpots = routes.filter((r) => r.phase === 'dock' && r.berth).map((r) => r.berth);
    if (existingDockSpots.length < 4) {
      let addedAnchor = 0;
      const anchorSpots = [];
      for (let dist = 160; dist <= 520 && addedAnchor < 4; dist += 90) {
        for (let a = 0; a < 16 && addedAnchor < 4; a++) {
          const ang = (a / 16) * Math.PI * 2 + dist * 0.017;
          const ax = hx + Math.cos(ang) * dist;
          const az = hz + Math.sin(ang) * dist;
          if (!isSafeWater(ax, az, -3.0, 22)) continue;
          if (existingDockSpots.some((e) => Math.hypot(e.x - ax, e.z - az) < 75)) continue;
          if (anchorSpots.some((e) => Math.hypot(e.x - ax, e.z - az) < 75)) continue;
          anchorSpots.push({ x: ax, z: az });
          const arch = (addedAnchor % 2 === 0) ? 3 : 1;
          routes.push({
            id: `roadstead:${addedAnchor}`, mode: 'sea', phase: 'dock',
            archetype: arch, scale: arch === 3 ? 1.04 : 0.94,
            depart: 0, arrive: 1,
            berth: { x: ax, y: seaLevel, z: az, rot: ang + Math.PI * 0.5 + (addedAnchor * 0.35) },
            pts: null, totalLen: 0,
            phaseOffset: ((hashU32(addedAnchor + 11, 71) % 1000) / 1000),
          });
          addedAnchor++;
        }
      }
    }

    const harborShuttleCount = routes.filter((r) => r.id.startsWith('harbor:')).length;
    if (harborShuttleCount < 4 && routes.length < MAX_TRADE_VESSELS) {
      const candidateTracks = [];
      for (let i = 0; i < harbors.length; i++) {
        for (let j = i + 1; j < harbors.length; j++) {
          const a = nearestSafeWater(harbors[i].x, harbors[i].z, -2.0, 70, 380, 14);
          const b = nearestSafeWater(harbors[j].x, harbors[j].z, -2.0, 70, 380, 14);
          const mid = nearestSafeWater((a.x + b.x) * 0.5, (a.z + b.z) * 0.5, -2.2, 0, 340, 14);
          if (Math.hypot(b.x - a.x, b.z - a.z) >= 240 && isSegmentSafeWater(a, mid, -1.8, 12) && isSegmentSafeWater(mid, b, -1.8, 12)) {
            candidateTracks.push([a, mid, b]);
          }
        }
      }
      for (let band = 0; band < 6 && candidateTracks.length < 7; band++) {
        const radius = 260 + band * 165;
        const arc0 = (band * 0.95) - 1.2;
        const rawWaypoints = [];
        for (let step = 0; step < 5; step++) {
          const ang = arc0 + step * 0.42;
          const wx = hx + Math.cos(ang) * radius;
          const wz = hz + Math.sin(ang) * radius;
          if (isSafeWater(wx, wz, -2.0, 14)) rawWaypoints.push({ x: wx, z: wz });
        }
        const safeTrack = [];
        for (const wp of rawWaypoints) {
          if (!safeTrack.length || isSegmentSafeWater(safeTrack[safeTrack.length - 1], wp, -1.8, 12)) safeTrack.push(wp);
        }
        if (safeTrack.length >= 2) candidateTracks.push(safeTrack);
      }

      let addedShuttles = 0;
      for (let ti = 0; ti < candidateTracks.length && addedShuttles < 5 && routes.length < MAX_TRADE_VESSELS; ti++) {
        const raw = candidateTracks[ti];
        let acc = 0;
        const linePts = raw.map((p, idx) => {
          if (idx > 0) acc += Math.hypot(p.x - raw[idx - 1].x, p.z - raw[idx - 1].z);
          return { x: p.x, y: seaLevel, z: p.z, acc };
        });
        if (acc < 120) continue;
        const arch = (ti % 2 === 0) ? 6 : 5;
        routes.push({
          id: `harbor:${ti}`, mode: 'sea', phase: 'shuttle',
          archetype: arch, scale: arch === 5 ? 0.96 : 1.0,
          depart: 0, arrive: 1, berth: null,
          pts: linePts, totalLen: acc,
          phaseOffset: ((hashU32(ti + 5, 97) % 1000) / 1000),
        });
        addedShuttles++;
      }
    }
  }

  return routes.slice(0, MAX_TRADE_VESSELS);
}

/**
 * Computes world pose `{ x, y, z, yaw, heading, pitch, roll, bowDir, scale, phase, archetype, motion, speed, dist }`
 * using canonical `-Z` bow orientation (`yaw = Math.atan2(tx, -tz)` so `boatRotate(0,0,-1, yaw, 0, 0) === (tx, 0, tz)`).
 */
export function sampleTradeVesselState(route, boardDay, daysPerSecond, elapsedSec, overrideDist = null) {
  const phaseRad = (route.phaseOffset || 0) * Math.PI * 2;
  if (route.phase === 'dock' && route.berth) {
    const bob = Math.sin(elapsedSec * 1.15 + phaseRad) * 0.14;
    const roll = Math.sin(elapsedSec * 0.9 + phaseRad * 1.7) * 0.024;
    const yaw = route.berth.rot || 0;
    return {
      x: route.berth.x,
      y: route.berth.y + bob,
      z: route.berth.z,
      yaw,
      heading: (yaw * 180) / Math.PI,
      pitch: Math.sin(elapsedSec * 0.72 + phaseRad) * 0.012,
      roll,
      bowDir: [Math.sin(yaw), -Math.cos(yaw)],
      scale: route.scale,
      phase: phaseRad,
      archetype: route.archetype,
      motion: 0,
      speed: 0,
      dist: 0,
    };
  }
  const L = Math.max(1, route.totalLen);
  const days = Math.max(0.01, route.arrive - route.depart);
  const minSpeed = route.mode === 'river' ? 1.15 : 2.25;
  const calSpeed = route.phase === 'shuttle' ? 0 : (L / days) * Math.max(0, daysPerSecond || 0);
  const speed = Math.max(calSpeed, minSpeed);

  let signedDist;
  if (overrideDist !== null && Number.isFinite(overrideDist)) {
    signedDist = overrideDist;
  } else if (route.phase === 'shuttle') {
    signedDist = (route.phaseOffset * L + minSpeed * elapsedSec);
  } else {
    const share = Math.max(0, Math.min(1, (boardDay - route.depart) / days));
    const baseDist = (route.phase === 'out' ? 1 - share : share) * L;
    const vFloor = calSpeed < minSpeed ? Math.max(0, minSpeed - calSpeed) : 0;
    signedDist = baseDist + (route.phase === 'out' ? -1 : 1) * vFloor * elapsedSec;
  }

  let dist, forwardSign = 1;
  if (route.phase === 'shuttle') {
    const span = L * 2;
    const m = ((signedDist % span) + span) % span;
    if (m <= L) { dist = m; forwardSign = 1; }
    else { dist = span - m; forwardSign = -1; }
  } else {
    const cycle = L + 60;
    const wrapped = ((signedDist % cycle) + cycle) % cycle;
    dist = wrapped > L ? L : wrapped;
    if (route.phase === 'out') forwardSign = -1;
  }

  const at = evalPolylineAt(route.pts, Math.max(0, Math.min(L, dist)));
  const tx = at.tx * forwardSign, tz = at.tz * forwardSign;
  const ty = Math.max(-0.22, Math.min(0.22, (at.ty || 0) * forwardSign));
  // Bow is -Z: boatRotate(0, 0, -1, yaw, 0, 0) = (+sin(yaw), 0, -cos(yaw)).
  const yaw = Math.atan2(tx, -tz);
  const swellBob = route.mode === 'sea' ? Math.sin(elapsedSec * 1.1 + phaseRad) * 0.16 : Math.sin(elapsedSec * 1.8 + phaseRad) * 0.03;
  const roll = Math.sin(elapsedSec * 0.9 + phaseRad * 1.7) * (route.mode === 'river' ? 0.014 : 0.030);
  const slopePitch = Math.asin(ty);
  const pitch = slopePitch + Math.sin(elapsedSec * 0.8 + phaseRad) * (route.mode === 'river' ? 0.008 : 0.018);

  return {
    x: at.x,
    y: at.y + swellBob,
    z: at.z,
    yaw,
    heading: (yaw * 180) / Math.PI,
    pitch,
    roll,
    bowDir: [Math.sin(yaw), -Math.cos(yaw)],
    scale: route.scale,
    phase: phaseRad,
    archetype: route.archetype,
    motion: speed / minSpeed,
    speed,
    dist: signedDist,
  };
}

function wrapAnglePi(a) {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/**
 * Computes physical point-of-sail performance for a hull at `bowYaw` under horizontal `windVec`
 * (direction wind blows TOWARD, matching frameWind). Returns beat limits, polar target speed,
 * storm reefing sailSet, heel, and leeway angle.
 */
export function computeSailingPolar(bowYaw, windVec = [8, 0], archIndex = 0, { storm = false } = {}) {
  const wx = windVec?.[0] ?? 0;
  const wz = windVec?.[1] ?? 0;
  const windSpeed = Math.hypot(wx, wz);
  if (archIndex === 4) {
    return {
      windSpeed,
      offWindRad: Math.PI * 0.5,
      beta: 0,
      upwindAngle: 0,
      inNoGoZone: false,
      targetSpeed: 1.30,
      targetSailSet: 0,
      heel: 0,
      leewayRad: 0,
    };
  }
  const lateen = archIndex === 5 || archIndex === 6;
  const hullMax = archIndex === 2 || archIndex === 3 ? 4.9 : archIndex === 5 ? 5.2 : archIndex === 6 ? 3.9 : 4.25;
  const beta = (lateen ? 46 : 62) * (Math.PI / 180);

  if (windSpeed < 0.25) {
    return {
      windSpeed,
      offWindRad: Math.PI * 0.5,
      beta,
      upwindAngle: 0,
      inNoGoZone: false,
      targetSpeed: 0.75,
      targetSailSet: 1.0,
      heel: 0,
      leewayRad: 0,
    };
  }

  const invW = 1 / windSpeed;
  // Wind blows TOWARD (wx, wz); UPWIND comes FROM (-wx, -wz).
  const upX = -wx * invW;
  const upZ = -wz * invW;
  const upwindAngle = Math.atan2(upX, -upZ);
  const bx = Math.sin(bowYaw);
  const bz = -Math.cos(bowYaw);
  const cosOff = Math.max(-1, Math.min(1, bx * upX + bz * upZ));
  const offWindRad = Math.acos(cosOff);
  const sideCross = bx * (-upZ) - bz * upX;

  const heavyWind = storm || windSpeed > 14;
  const effWind = Math.min(1.25, Math.max(0.28, (windSpeed / 8.5) * (heavyWind ? 0.78 : 1.0)));
  const targetSailSet = heavyWind ? 0.45 : 1.0;

  let polarGain;
  if (offWindRad < 0.65) {
    polarGain = 0.08 * (offWindRad / 0.65); // In irons: minimal momentum only
  } else if (offWindRad < beta) {
    const t = (offWindRad - 0.65) / Math.max(0.05, beta - 0.65);
    polarGain = 0.08 + t * (lateen ? 0.66 : 0.52);
  } else if (offWindRad < 1.57) {
    const t = (offWindRad - beta) / Math.max(0.05, 1.57 - beta);
    polarGain = (lateen ? 0.74 : 0.60) + t * ((lateen ? 1.08 : 0.96) - (lateen ? 0.74 : 0.60));
  } else if (offWindRad < 2.35) {
    const t = (offWindRad - 1.57) / (2.35 - 1.57);
    polarGain = (lateen ? 1.08 : 0.96) + Math.sin(t * Math.PI) * 0.14 + t * (lateen ? 0.06 : 0.14);
  } else {
    const t = (offWindRad - 2.35) / Math.max(0.05, Math.PI - 2.35);
    polarGain = (lateen ? 1.14 : 1.10) - t * (lateen ? 0.24 : 0.12);
  }

  const targetSpeed = Math.max(0.25, hullMax * effWind * polarGain);
  const heelScale = Math.sin(offWindRad) * Math.min(1.3, windSpeed / 9.5) * (heavyWind ? 0.11 : 0.075);
  const heel = Math.sign(sideCross || 1) * heelScale * (lateen ? 0.9 : 1.0);
  const leewayRad = Math.sin(offWindRad) * (heavyWind ? 0.09 : 0.045) * (lateen ? 0.75 : 1.15);

  return {
    windSpeed,
    offWindRad,
    beta,
    upwindAngle,
    inNoGoZone: offWindRad < beta * 0.96,
    targetSpeed,
    targetSailSet,
    heel,
    leewayRad,
    windTo: [wx * invW, wz * invW],
  };
}

/**
 * Initializes persistent physical autopilot state from a route descriptor without locking
 * future motion to calendar timestamps.
 */
export function createVesselAutopilotState(route, archIndex, seedState, simTime = 0) {
  const phaseRad = (route.phaseOffset || 0) * Math.PI * 2;
  const pts = route.pts;
  const isAnchored = route.id?.startsWith('roadstead:') || (route.phase === 'dock' && !route.shipId);
  let state = 'shuttle';
  let wpIndex = pts ? Math.min(pts.length - 1, 1) : 0;
  let dirSign = 1;
  let sailSet = archIndex === 4 || archIndex === 1 || archIndex === 3 ? 0.05 : 1.0;

  if (route.phase === 'dock') {
    state = isAnchored ? 'anchored' : 'docked';
    sailSet = archIndex === 1 || archIndex === 3 ? 0.05 : 0.05;
  } else if (route.phase === 'in') {
    state = 'inbound';
    dirSign = 1;
    if (pts && pts.length >= 2) {
      wpIndex = 1;
      for (let i = 1; i < pts.length; i++) {
        wpIndex = i;
        if (pts[i].acc >= (seedState?.dist ?? 0)) break;
      }
    }
  } else if (route.phase === 'out') {
    state = 'outbound';
    dirSign = -1;
    if (pts && pts.length >= 2) {
      wpIndex = pts.length - 2;
      const dTarget = Math.max(0, Math.min(route.totalLen || 0, seedState?.dist ?? (route.totalLen || 0)));
      for (let i = pts.length - 2; i >= 0; i--) {
        wpIndex = i;
        if (pts[i].acc <= dTarget) break;
      }
    }
  } else if (route.phase === 'caravan') {
    state = 'caravan';
    dirSign = 1;
    if (pts && pts.length >= 2) {
      for (let i = 1; i < pts.length; i++) {
        wpIndex = i;
        if (pts[i].acc >= (seedState?.dist ?? 0)) break;
      }
    }
  } else if (route.phase === 'shuttle') {
    state = 'shuttle';
    const span = Math.max(1, route.totalLen || 1) * 2;
    const rawD = (((seedState?.dist ?? 0) % span) + span) % span;
    dirSign = rawD <= (route.totalLen || 1) ? 1 : -1;
    const d = dirSign > 0 ? rawD : span - rawD;
    if (pts && pts.length >= 2) {
      if (dirSign > 0) {
        wpIndex = 1;
        for (let i = 1; i < pts.length; i++) { wpIndex = i; if (pts[i].acc >= d) break; }
      } else {
        wpIndex = pts.length - 2;
        for (let i = pts.length - 2; i >= 0; i--) { wpIndex = i; if (pts[i].acc <= d) break; }
      }
    }
  }

  return {
    state,
    archIndex,
    x: seedState?.x ?? (route.berth?.x ?? 0),
    y: seedState?.y ?? (route.berth?.y ?? 0),
    z: seedState?.z ?? (route.berth?.z ?? 0),
    yaw: seedState?.yaw ?? (route.berth?.rot ?? 0),
    speed: state === 'docked' || state === 'anchored' ? 0 : (seedState?.speed ?? 2.5),
    motion: state === 'docked' || state === 'anchored' ? 0 : (seedState?.motion ?? 1.0),
    pitch: seedState?.pitch ?? 0,
    roll: seedState?.roll ?? 0,
    sailSet,
    wpIndex,
    dirSign,
    tackSide: ((hashU32(Math.round((phaseRad + 1) * 977), 13) & 1) === 0) ? 1 : -1,
    tackTimer: 0,
    progress: route.phase === 'dock' ? 1 : 0,
    etaDays: 0,
    tacking: false,
    heldByWeather: false,
    dirtySync: false,
    dockTarget: route.berth ? { ...route.berth } : null,
    phaseRad,
    simTime,
  };
}

/**
 * Advances one autonomous vessel step using wind polars, tacking in headwinds, leeway/heel,
 * shoal & collision avoidance, harbor approach/docking/departure kinematics, or river flow.
 */
export function stepTradeVesselAutopilot(ai, route, archIndex, {
  dt = 0.016,
  elapsedSec = 0,
  windVec = [8, 0],
  storm = false,
  daysPerSecond = 0,
  worldOffsetX = 0,
  worldOffsetZ = 0,
  bedAt = null,
  riverFlowAt = null,
  avoidTargets = null,
  length = 17.5,
  draft = 1.6,
} = {}) {
  const safeDt = Math.max(0, Math.min(8, dt));
  const stepSlice = (h) => {
    const pts = route.pts;
    const isBarge = archIndex === 4 || route.mode === 'river';
    const berth = ai.dockTarget || route.berth || route.portBerths?.[0] || null;
    const activeStorm = Boolean(storm || Math.hypot(windVec?.[0] ?? 0, windVec?.[1] ?? 0) >= 14.5);

    if (ai.state === 'sunk') {
      ai.speed = 0;
      ai.motion = 0;
      ai.heldByWeather = false;
      ai.etaDays = 0;
      return;
    }

    if (ai.state === 'anchored') {
      const targetYaw = (route.berth?.rot ?? ai.yaw) + Math.sin(elapsedSec * 0.14 + ai.phaseRad) * 0.08;
      ai.yaw = wrapAnglePi(ai.yaw + Math.max(-0.08 * h, Math.min(0.08 * h, wrapAnglePi(targetYaw - ai.yaw))));
      ai.x += ((route.berth?.x ?? ai.x) - ai.x) * Math.min(1, h * 1.2);
      ai.z += ((route.berth?.z ?? ai.z) - ai.z) * Math.min(1, h * 1.2);
      ai.y = (route.berth?.y ?? 0) + Math.sin(elapsedSec * 1.15 + ai.phaseRad) * 0.14;
      ai.pitch = Math.sin(elapsedSec * 0.72 + ai.phaseRad) * 0.012;
      ai.roll = Math.sin(elapsedSec * 0.9 + ai.phaseRad * 1.7) * 0.024;
      ai.speed = 0;
      ai.motion = 0;
      ai.sailSet += (0.04 - ai.sailSet) * (1 - Math.exp(-h * 1.6));
      ai.heldByWeather = false;
      ai.etaDays = 0;
      ai.progress = 1;
      return;
    }

    if (ai.state === 'docked') {
      const bx = berth ? berth.x : ai.x;
      const bz = berth ? berth.z : ai.z;
      const brot = berth ? (berth.rot || 0) : ai.yaw;
      ai.x += (bx - ai.x) * Math.min(1, h * 1.8);
      ai.z += (bz - ai.z) * Math.min(1, h * 1.8);
      ai.yaw = wrapAnglePi(ai.yaw + Math.max(-0.25 * h, Math.min(0.25 * h, wrapAnglePi(brot - ai.yaw))));
      ai.y = (berth?.y ?? 0) + Math.sin(elapsedSec * 1.15 + ai.phaseRad) * 0.12;
      ai.pitch = Math.sin(elapsedSec * 0.72 + ai.phaseRad) * 0.012;
      ai.roll = Math.sin(elapsedSec * 0.9 + ai.phaseRad * 1.7) * (activeStorm ? 0.045 : 0.020);
      ai.speed = Math.max(0, ai.speed * Math.exp(-h * 3.0));
      ai.motion = 0;
      ai.sailSet += (0.04 - ai.sailSet) * (1 - Math.exp(-h * 1.6));
      ai.tacking = false;
      ai.heldByWeather = activeStorm;
      ai.etaDays = 0;
      ai.progress = 1;
      return;
    }

    // River barges: true flow drift + upstream/downstream oar speed and cadence
    if (isBarge && pts && pts.length >= 2) {
      let target = pts[Math.max(0, Math.min(pts.length - 1, ai.wpIndex))];
      let distToWp = Math.hypot(target.x - ai.x, target.z - ai.z);
      if (distToWp < 22) {
        if (ai.dirSign > 0) {
          if (ai.wpIndex < pts.length - 1) ai.wpIndex++;
          else if (route.phase === 'shuttle') { ai.dirSign = -1; ai.wpIndex = Math.max(0, pts.length - 2); }
        } else {
          if (ai.wpIndex > 0) ai.wpIndex--;
          else if (route.phase === 'shuttle') { ai.dirSign = 1; ai.wpIndex = Math.min(pts.length - 1, 1); }
        }
        target = pts[Math.max(0, Math.min(pts.length - 1, ai.wpIndex))];
        distToWp = Math.hypot(target.x - ai.x, target.z - ai.z);
      }

      const tx = distToWp > 1e-3 ? (target.x - ai.x) / distToWp : Math.sin(ai.yaw);
      const tz = distToWp > 1e-3 ? (target.z - ai.z) / distToWp : -Math.cos(ai.yaw);
      const desiredYaw = Math.atan2(tx, -tz);
      const dYaw = wrapAnglePi(desiredYaw - ai.yaw);
      const maxTurn = 0.42 * h;
      ai.yaw = wrapAnglePi(ai.yaw + Math.max(-maxTurn, Math.min(maxTurn, dYaw)));

      const bowX = Math.sin(ai.yaw), bowZ = -Math.cos(ai.yaw);
      let cvx = Number.isFinite(target.vx) ? target.vx : 0;
      let cvz = Number.isFinite(target.vz) ? target.vz : 0;
      if (riverFlowAt) {
        const iw = riverFlowAt(ai.x + worldOffsetX, ai.z + worldOffsetZ);
        if (iw && Number.isFinite(iw.vx) && Number.isFinite(iw.vz)) {
          cvx = iw.vx;
          cvz = iw.vz;
        }
      } else {
        const prevIdx = Math.max(0, Math.min(pts.length - 1, ai.wpIndex - ai.dirSign));
        const a = pts[prevIdx], b = target;
        if (Number.isFinite(a?.vx) && Number.isFinite(a?.vz) && Number.isFinite(b?.vx) && Number.isFinite(b?.vz)) {
          const segLen = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          const u = Math.max(0, Math.min(1, 1 - distToWp / segLen));
          cvx = a.vx + (b.vx - a.vx) * u;
          cvz = a.vz + (b.vz - a.vz) * u;
        } else if (!Number.isFinite(target.vx)) {
          const d0 = pts[Math.max(0, ai.wpIndex - 1)], d1 = pts[Math.min(pts.length - 1, ai.wpIndex + 1)];
          const dl = Math.hypot(d1.x - d0.x, d1.z - d0.z) || 1;
          cvx = ((d1.x - d0.x) / dl) * 0.9;
          cvz = ((d1.z - d0.z) / dl) * 0.9;
        }
      }

      const flowAlong = cvx * bowX + cvz * bowZ;
      const upstream = flowAlong < -0.15;
      const oarDrive = upstream ? 1.85 : 1.05;
      const desiredGround = Math.max(0.45, oarDrive + flowAlong * (upstream ? 0.65 : 1.0));
      ai.speed += (desiredGround - ai.speed) * (1 - Math.exp(-h * 2.2));
      const crossFlow = cvx * (-bowZ) + cvz * bowX;
      ai.x += (bowX * ai.speed - bowZ * crossFlow * 0.12) * h;
      ai.z += (bowZ * ai.speed + bowX * crossFlow * 0.12) * h;
      ai.motion = upstream ? Math.min(1.5, 1.15 + Math.abs(flowAlong) * 0.35) : Math.max(0.5, 0.78 - flowAlong * 0.18);
      ai.sailSet = 0;
      ai.tacking = false;
      ai.heldByWeather = false;

      const atSlope = target.y - (pts[Math.max(0, ai.wpIndex - ai.dirSign)]?.y ?? target.y);
      const segD = Math.max(1, Math.hypot(target.x - (pts[Math.max(0, ai.wpIndex - ai.dirSign)]?.x ?? target.x), target.z - (pts[Math.max(0, ai.wpIndex - ai.dirSign)]?.z ?? target.z)));
      ai.y = target.y + Math.sin(elapsedSec * 1.8 + ai.phaseRad) * 0.03;
      ai.pitch = Math.max(-0.18, Math.min(0.18, Math.asin(Math.max(-0.2, Math.min(0.2, atSlope / segD))))) + Math.sin(elapsedSec * 0.8 + ai.phaseRad) * 0.008;
      ai.roll = Math.sin(elapsedSec * 0.9 + ai.phaseRad * 1.7) * 0.014;

      const L = Math.max(1, route.totalLen || 1);
      const remSegs = ai.dirSign > 0
        ? Math.max(0, L - (pts[Math.max(0, ai.wpIndex - 1)]?.acc ?? 0))
        : (pts[ai.wpIndex]?.acc ?? 0);
      ai.progress = Math.max(0, Math.min(1, 1 - remSegs / L));
      const dPerSec = Math.max(daysPerSecond || 0, 1 / 180);
      ai.etaDays = (remSegs / Math.max(0.35, ai.speed)) * dPerSec;
      return;
    }

    // Sea sailing vessel autopilot
    let targetX = ai.x, targetZ = ai.z;
    let targetSpeedCap = Infinity;
    let sailTarget = activeStorm ? 0.45 : 1.0;

    if (ai.state === 'waiting_berth') {
      const last = pts?.[pts.length - 1] || berth || { x: ai.x, z: ai.z };
      const prev = pts?.[Math.max(0, pts.length - 2)] || last;
      const inDx = prev.x - last.x, inDz = prev.z - last.z;
      const inL = Math.hypot(inDx, inDz) || 1;
      const holdX = last.x + (inDx / inL) * 115 + Math.sin(elapsedSec * 0.18 + ai.phaseRad) * 32;
      const holdZ = last.z + (inDz / inL) * 115 + Math.cos(elapsedSec * 0.18 + ai.phaseRad) * 32;
      targetX = holdX;
      targetZ = holdZ;
      targetSpeedCap = 1.05;
      sailTarget = 0.22;
      ai.heldByWeather = activeStorm;
      ai.etaDays = 0.15;
    } else if (ai.state === 'approaching') {
      const dest = berth || pts?.[pts.length - 1] || { x: ai.x, z: ai.z };
      targetX = dest.x;
      targetZ = dest.z;
      const distBerth = Math.hypot(targetX - ai.x, targetZ - ai.z);
      targetSpeedCap = distBerth < 75 ? 1.8 : 2.9;
      sailTarget = activeStorm ? 0.30 : 0.42;
      ai.etaDays = 0;
      if (distBerth <= 26) {
        ai.state = 'docking';
        ai.dirtySync = true;
      }
    } else if (ai.state === 'docking') {
      const dest = berth || { x: ai.x, z: ai.z, rot: ai.yaw };
      targetX = dest.x;
      targetZ = dest.z;
      const distBerth = Math.hypot(targetX - ai.x, targetZ - ai.z);
      const brot = dest.rot || ai.yaw;
      targetSpeedCap = Math.max(0.45, Math.min(1.4, distBerth * 0.12));
      sailTarget = 0.06;
      ai.etaDays = 0;
      if (distBerth <= 4.5) {
        // Align alongside berth cleanly without snap
        const desiredDockYaw = distBerth < 2.2 ? brot : Math.atan2(targetX - ai.x, -(targetZ - ai.z));
        const dYaw = wrapAnglePi(desiredDockYaw - ai.yaw);
        ai.yaw = wrapAnglePi(ai.yaw + Math.max(-0.45 * h, Math.min(0.45 * h, dYaw)));
        ai.x += (targetX - ai.x) * Math.min(1, h * 1.4);
        ai.z += (targetZ - ai.z) * Math.min(1, h * 1.4);
        ai.speed = Math.min(ai.speed, distBerth * 0.5);
        if (distBerth <= 2.0 && Math.abs(wrapAnglePi(brot - ai.yaw)) < 0.22) {
          ai.state = 'docked';
          ai.dirtySync = true;
        }
        ai.sailSet += (sailTarget - ai.sailSet) * (1 - Math.exp(-h * 1.8));
        ai.y = Math.sin(elapsedSec * 1.15 + ai.phaseRad) * 0.12;
        return;
      }
    } else if (ai.state === 'departing') {
      const mouthIdx = pts && pts.length >= 2 ? Math.max(0, pts.length - 2) : 0;
      const wp = pts?.[mouthIdx] || { x: ai.x - Math.sin(ai.yaw) * 90, z: ai.z + Math.cos(ai.yaw) * 90 };
      targetX = wp.x;
      targetZ = wp.z;
      targetSpeedCap = 2.6;
      sailTarget = activeStorm ? 0.38 : 0.60;
      const distOut = berth ? Math.hypot(ai.x - berth.x, ai.z - berth.z) : Math.hypot(targetX - ai.x, targetZ - ai.z);
      if (distOut > 52 || Math.hypot(targetX - ai.x, targetZ - ai.z) < 28) {
        ai.state = 'outbound';
        ai.dirSign = -1;
        ai.wpIndex = Math.max(0, mouthIdx - 1);
      }
    } else if (pts && pts.length >= 2) {
      let wp = pts[Math.max(0, Math.min(pts.length - 1, ai.wpIndex))];
      let distWp = Math.hypot(wp.x - ai.x, wp.z - ai.z);
      if (distWp < 36) {
        if (ai.dirSign > 0) {
          if (ai.wpIndex < pts.length - 1) {
            ai.wpIndex++;
          } else if (ai.state === 'inbound' && route.phase === 'in') {
            if (berth && (route.waited || 0) === 0 && !activeStorm) {
              ai.state = 'approaching';
            } else {
              ai.state = 'waiting_berth';
            }
            ai.dirtySync = true;
          } else if (route.phase === 'shuttle') {
            ai.dirSign = -1;
            ai.wpIndex = Math.max(0, pts.length - 2);
          }
        } else {
          if (ai.wpIndex > 0) {
            ai.wpIndex--;
          } else if (route.phase === 'shuttle') {
            ai.dirSign = 1;
            ai.wpIndex = Math.min(pts.length - 1, 1);
          }
        }
        wp = pts[Math.max(0, Math.min(pts.length - 1, ai.wpIndex))];
        distWp = Math.hypot(wp.x - ai.x, wp.z - ai.z);
      }
      targetX = wp.x;
      targetZ = wp.z;

      // Also transition early if close to harbor mouth on inbound leg
      if (ai.state === 'inbound' && ai.wpIndex >= pts.length - 1 && distWp < 88) {
        if (berth && (route.waited || 0) === 0 && !activeStorm) {
          ai.state = 'approaching';
        } else {
          ai.state = 'waiting_berth';
        }
        ai.dirtySync = true;
      }
    }

    const dxT = targetX - ai.x;
    const dzT = targetZ - ai.z;
    const distT = Math.hypot(dxT, dzT);
    const desiredCourse = distT > 0.5 ? Math.atan2(dxT, -dzT) : ai.yaw;

    // Windward polar & autonomous headwind tacking
    const polarDesired = computeSailingPolar(desiredCourse, windVec, archIndex, { storm: activeStorm });
    let steerYaw = desiredCourse;
    ai.tackTimer += h;
    const allowTack = ai.state === 'inbound' || ai.state === 'outbound' || ai.state === 'caravan' || ai.state === 'shuttle';
    if (allowTack && polarDesired.inNoGoZone && polarDesired.windSpeed >= 0.8) {
      // Cross-track deviation relative to current corridor segment
      let xtrack = 0;
      if (pts && pts.length >= 2) {
        const aIdx = Math.max(0, Math.min(pts.length - 1, ai.wpIndex - ai.dirSign));
        const bIdx = Math.max(0, Math.min(pts.length - 1, ai.wpIndex));
        const a = pts[aIdx], b = pts[bIdx];
        const sx = b.x - a.x, sz = b.z - a.z;
        const sl = Math.hypot(sx, sz) || 1;
        xtrack = ((ai.x - a.x) * (-sz) + (ai.z - a.z) * sx) / sl;
      }
      if ((Math.abs(xtrack) > 85 && ai.tackTimer > 8) || ai.tackTimer > 30) {
        ai.tackSide = -ai.tackSide;
        ai.tackTimer = 0;
      }
      steerYaw = wrapAnglePi(polarDesired.upwindAngle + ai.tackSide * polarDesired.beta);
      ai.tacking = true;
    } else {
      ai.tacking = false;
    }

    // Shoal grounding lookahead
    let avoidTurn = 0;
    const minDepth = -(draft + 0.65);
    if (bedAt) {
      const probeDist = Math.max(22, length * 2.1);
      const bedL = bedAt(ai.x + worldOffsetX + Math.sin(ai.yaw - 0.42) * probeDist, ai.z + worldOffsetZ - Math.cos(ai.yaw - 0.42) * probeDist);
      const bedR = bedAt(ai.x + worldOffsetX + Math.sin(ai.yaw + 0.42) * probeDist, ai.z + worldOffsetZ - Math.cos(ai.yaw + 0.42) * probeDist);
      const bedF = bedAt(ai.x + worldOffsetX + Math.sin(ai.yaw) * probeDist * 0.85, ai.z + worldOffsetZ - Math.cos(ai.yaw) * probeDist * 0.85);
      if (bedF > minDepth || bedL > minDepth || bedR > minDepth) {
        if (bedL > bedR + 0.15) avoidTurn += 0.65;
        else if (bedR > bedL + 0.15) avoidTurn -= 0.65;
        else avoidTurn += (ai.tackSide || 1) * 0.55;
        if (ai.tacking && ai.tackTimer > 4) {
          ai.tackSide = bedL > bedR ? 1 : -1;
          ai.tackTimer = 0;
        }
        targetSpeedCap = Math.min(targetSpeedCap, 1.6);
      }
    }

    // Traffic & player vessel COLREG-style avoidance
    if (avoidTargets && ai.state !== 'docking' && ai.state !== 'departing') {
      const bx = Math.sin(ai.yaw), bz = -Math.cos(ai.yaw);
      const rx = -bz, rz = bx; // starboard vector
      for (let k = 0; k < avoidTargets.length; k++) {
        const other = avoidTargets[k];
        if (!other || other.id === route.id) continue;
        const ox = (other.x ?? 0) - worldOffsetX;
        const oz = (other.z ?? 0) - worldOffsetZ;
        const dx = ox - ai.x, dz = oz - ai.z;
        const sep = Math.hypot(dx, dz);
        const safeR = Math.max(40, (length + (other.length ?? 16)) * 2.2);
        if (sep < safeR && sep > 0.5) {
          const fwd = dx * bx + dz * bz;
          if (fwd > -length * 0.5) {
            const stbd = dx * rx + dz * rz;
            const urgency = 1 - sep / safeR;
            avoidTurn += (stbd >= 0 ? -0.55 : 0.72) * urgency;
            if (sep < safeR * 0.55) targetSpeedCap = Math.min(targetSpeedCap, 1.4);
          }
        }
      }
    }

    const desiredTurn = wrapAnglePi(steerYaw - ai.yaw) + avoidTurn;
    const turnRate = (ai.state === 'docking' || ai.state === 'departing' ? 0.36 : 0.22) * (16 / Math.max(10, length));
    const maxTurn = turnRate * h;
    ai.yaw = wrapAnglePi(ai.yaw + Math.max(-maxTurn, Math.min(maxTurn, desiredTurn)));

    const actualPolar = computeSailingPolar(ai.yaw, windVec, archIndex, { storm: activeStorm });
    const desSpeed = Math.min(targetSpeedCap, actualPolar.targetSpeed);
    ai.speed += (desSpeed - ai.speed) * (1 - Math.exp(-h * 1.45));
    const finalSail = Math.min(sailTarget, actualPolar.targetSailSet);
    ai.sailSet += (finalSail - ai.sailSet) * (1 - Math.exp(-h * 1.65));

    const bowX = Math.sin(ai.yaw), bowZ = -Math.cos(ai.yaw);
    const windTo = actualPolar.windTo || [0, 0];
    const leeMag = ai.speed * actualPolar.leewayRad;
    ai.x += (bowX * ai.speed + windTo[0] * leeMag) * h;
    ai.z += (bowZ * ai.speed + windTo[1] * leeMag) * h;
    ai.y = Math.sin(elapsedSec * 1.1 + ai.phaseRad) * 0.16;
    const wavePitch = Math.sin(elapsedSec * 0.8 + ai.phaseRad) * 0.018;
    const waveRoll = Math.sin(elapsedSec * 0.9 + ai.phaseRad * 1.7) * 0.030;
    ai.pitch += (wavePitch - ai.pitch) * Math.min(1, h * 3);
    ai.roll += (actualPolar.heel + waveRoll - ai.roll) * Math.min(1, h * 2.2);
    ai.motion = Math.min(1.6, ai.speed / 2.25);
    ai.heldByWeather = Boolean(activeStorm && (ai.tacking || actualPolar.targetSpeed < 1.8));

    // Remaining distance & realistic VMG-based ETA for board sync
    const L = Math.max(1, route.totalLen || 1);
    let remDist = distT;
    if (pts && pts.length >= 2) {
      if (ai.dirSign > 0) remDist = distT + Math.max(0, (pts[pts.length - 1].acc || 0) - (pts[ai.wpIndex]?.acc || 0));
      else remDist = distT + (pts[ai.wpIndex]?.acc || 0);
    }
    ai.progress = ai.state === 'docking' || ai.state === 'approaching'
      ? 1
      : Math.max(0, Math.min(1, 1 - remDist / L));
    const vmg = Math.max(0.28, (bowX * (distT > 0.5 ? dxT / distT : bowX) + bowZ * (distT > 0.5 ? dzT / distT : bowZ)) * ai.speed);
    const dPerSec = Math.max(daysPerSecond || 0, 1 / 180);
    ai.etaDays = ai.state === 'docking' || ai.state === 'approaching' ? 0 : (remDist / vmg) * dPerSec;
  };

  let rem = safeDt;
  let steps = 0;
  do {
    const h = rem > 0.25 ? Math.min(0.25, rem) : rem;
    stepSlice(h);
    rem -= h;
    steps++;
  } while (rem > 1e-6 && steps < 32);

  return ai;
}

function buildArchetypeScaleWGSL() {
  const rows = [];
  for (let i = 0; i < TRADE_VESSEL_ARCHETYPES; i++) {
    const a = getTradeVesselArchetype(i);
    rows.push(`vec4f(${a.designScale[0].toFixed(6)}, ${a.designScale[1].toFixed(6)}, ${a.designScale[2].toFixed(6)}, ${a.draft.toFixed(4)})`);
  }
  return `const ARCHETYPE_SCALES = array<vec4f, ${TRADE_VESSEL_ARCHETYPES}>(\n  ${rows.join(',\n  ')}\n);`;
}

function buildBargeOarPivotsWGSL() {
  const pivots = bargeOarPivotsForWGSL();
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const o = i * 4;
    rows.push(`vec4f(${pivots[o].toFixed(5)}, ${pivots[o + 1].toFixed(5)}, ${pivots[o + 2].toFixed(5)}, ${pivots[o + 3].toFixed(2)})`);
  }
  return `const BARGE_OAR_PIVOTS = array<vec4f, 24>(\n  ${rows.join(',\n  ')}\n);`;
}

const SAIL_BRAIL_WGSL = /* wgsl */ `
fn animateTradeSailBrail(pIn: vec3f, material: f32, uv: vec2f, furlRaw: f32, archIdx: u32) -> vec3f {
  let furl = clamp(furlRaw, 0.0, 1.0);
  if (furl <= 0.002 || archIdx == 1u || archIdx == 3u || archIdx == 4u) { return pIn; }
  let m = u32(max(0.0, floor(material)));
  if (m != 9u && m != 13u) { return pIn; }
  var p = pIn;
  if (uv.y > 0.001) {
    var spanY = 4.2;
    if (archIdx == 0u) {
      spanY = select(4.25, 6.10, p.z > -0.8);
    } else if (archIdx == 2u) {
      if (p.y > 7.2) { spanY = 1.55; }
      else if (p.y < 2.2 && p.z < -5.0) { spanY = 1.05; }
      else if (p.z < -2.0) { spanY = 4.15; }
      else if (p.z < 3.0) { spanY = 4.95; }
      else { spanY = 4.75; }
    }
    let gather = furl * clamp(uv.y, 0.0, 1.0) * 0.88;
    p.y += spanY * gather;
    p.x *= (1.0 - 0.16 * gather);
  } else {
    let targetY = clamp(p.y + (1.0 - smoothstep(2.0, 9.5, p.y)) * 2.5, p.y, 10.6);
    p.y = mix(p.y, targetY, furl * 0.86);
    p.x *= (1.0 - furl * 0.82);
  }
  return p;
}
`;

const REST_TO_POSED_WGSL = /* wgsl */ `
struct SourceVertex { px: f32, py: f32, pz: f32, nx: f32, ny: f32, nz: f32, mat: f32, u: f32, v: f32 };
struct PosedVertex { position: vec4f, normal: vec4f };
struct PoseUniform { phase: f32, motion: f32, archetype: f32, furl: f32 };

${buildBargeOarPivotsWGSL()}
${SAIL_BRAIL_WGSL}

@group(0) @binding(0) var<storage, read> srcVerts: array<SourceVertex>;
@group(0) @binding(1) var<storage, read_write> dstPosed: array<PosedVertex>;
@group(0) @binding(2) var<uniform> P: PoseUniform;

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  if (idx >= arrayLength(&srcVerts) || idx >= arrayLength(&dstPosed)) { return; }
  let sv = srcVerts[idx];
  var p = vec3f(sv.px, sv.py, sv.pz);
  var n = vec3f(sv.nx, sv.ny, sv.nz);
  let matTone = vec2f(sv.mat, sv.u);
  if (matTone.x > 5.5 && u32(floor(matTone.x)) == 16u && abs(P.archetype - 4.0) < 0.5 && P.motion > 0.05) {
    let stationIdx = min(23u, u32(max(0.0, round((matTone.x - 16.0) * 64.0))));
    let piv = BARGE_OAR_PIVOTS[stationIdx];
    let side = piv.w;
    let cyc = P.phase * 1.15 + f32(stationIdx >> 1u) * 0.16;
    let sweep = sin(cyc) * 0.36 * min(P.motion, 1.5);
    let dip = cos(cyc) * 0.18 * min(P.motion, 1.5);
    let d = p - piv.xyz;
    let cy = cos(sweep * side); let sy = sin(sweep * side);
    let dYaw = vec3f(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);
    let cr = cos(dip * side); let sr = sin(dip * side);
    p = piv.xyz + vec3f(dYaw.x * cr - dYaw.y * sr, dYaw.x * sr + dYaw.y * cr, dYaw.z);
    let nYaw = vec3f(n.x * cy - n.z * sy, n.y, n.x * sy + n.z * cy);
    n = vec3f(nYaw.x * cr - nYaw.y * sr, nYaw.x * sr + nYaw.y * cr, nYaw.z);
  }
  p = animateTradeSailBrail(p, sv.mat, vec2f(sv.u, sv.v), P.furl, u32(max(0.0, round(P.archetype))));
  dstPosed[idx].position = vec4f(p, 0.0);
  dstPosed[idx].normal = vec4f(n, 0.0);
}
`;

const VESSEL_SAMPLE_MASK_WGSL = /* wgsl */ `
fn vesselCovHash(v: u32) -> u32 {
  var h = v;
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}
fn vesselCrownSamples(share: f32, pixel: vec2f, samples: u32) -> u32 {
  if (share <= 0.0) { return 0u; }
  let s = clamp(samples, 1u, 4u);
  let fullMask = (1u << s) - 1u;
  if (share >= 1.0) { return fullMask; }
  let p = vec2u(pixel);
  let random = vesselCovHash(p.x ^ vesselCovHash(p.y * 0x9e3779b9u + 0x51ed270bu));
  let count = min(s, u32(floor(share * f32(s) + f32(random & 65535u) / 65536.0)));
  let bits = (1u << count) - 1u;
  let rotation = (random >> 16u) % s;
  return ((bits << rotation) | (bits >> (s - rotation))) & fullMask;
}
`;

export function tradeVesselsSource(damaged = false, samples = 4) {
  const safeSamples = Math.max(1, Math.min(4, samples | 0));
  const sampleMaskAll = (1 << safeSamples) - 1;
  return FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + SHADOW_FRAME + VESSEL_LIGHTING + CANVAS_OPTICS + VESSEL_SAMPLE_MASK_WGSL + /* wgsl */ `
struct TradeNearDomain { domain: vec4f, grid: vec4f };
const TV_SAMPLES: u32 = ${safeSamples}u;
const TV_SAMPLE_MASK_ALL: u32 = ${sampleMaskAll}u;

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(12) var<uniform> nearTerrain: TradeNearDomain;
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;

@group(1) @binding(0) var oakAlbedo: texture_2d<f32>;
@group(1) @binding(1) var oakSampler: sampler;
${damaged ? `
struct HullCrater { at: vec3f, packed: u32 };
struct HullDamage {
  scale: vec4f,
  level: vec4f,
  holes: array<vec4f, ${HULL_HOLE_LIMIT}>,
  flows: array<vec4f, ${HULL_HOLE_LIMIT}>,
  craters: array<HullCrater, ${HULL_CRATER_LIMIT}>,
};
@group(1) @binding(2) var<uniform> hullDamage: HullDamage;
` : ''}

${buildArchetypeScaleWGSL()}
${buildBargeOarPivotsWGSL()}
${SAIL_BRAIL_WGSL}

struct TVVertexIn {
  @location(0) pos: vec3f,
  @location(1) norm: vec3f,
  @location(2) material: f32,
  @location(3) uv: vec2f,
  ${damaged ? `
  @location(4) posedPos: vec3f,
  @location(5) posedNorm: vec3f,
  @location(6) instPosYaw: vec4f,
  @location(7) instAttitude: vec4f,
  @location(8) instAnim: vec4f,
  ` : `
  @location(4) instPosYaw: vec4f,
  @location(5) instAttitude: vec4f,
  @location(6) instAnim: vec4f,
  `}
};

struct TVVertexOut {
  ${damaged ? '@invariant ' : ''}@builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec3f,
  @location(3) normalLocal: vec3f,
  @location(4) @interpolate(flat) matId: u32,
  @location(5) uv: vec2f,
  @location(6) draftRatio: f32,
  ${damaged ? '@location(7) damage: f32,' : '@location(7) fadeShare: f32,'}
};

fn rotateVessel(v: vec3f, heading: f32, pitch: f32, roll: f32) -> vec3f {
  let cr = cos(roll); let sr = sin(roll);
  let cp = cos(pitch); let sp = sin(pitch);
  let ch = cos(heading); let sh = sin(heading);
  let xx = cr * v.x - sr * v.y;
  let yy = sr * v.x + cr * v.y;
  let yp = cp * yy - sp * v.z;
  let zp = sp * yy + cp * v.z;
  return vec3f(ch * xx - sh * zp, yp, sh * xx + ch * zp);
}

fn animateTradeOar(pos: vec3f, norm: vec3f, material: f32, uv: vec2f, instAnim: vec4f, archF: f32) -> array<vec3f, 2> {
  var p = pos;
  var n = norm;
  let matTone = vec2f(material, 0.0);
  let phase = instAnim.x;
  let motion = instAnim.y;
  let aIdx = min(u32(${TRADE_VESSEL_ARCHETYPES - 1}), u32(max(0.0, round(archF))));
  if (matTone.x > 5.5 && u32(floor(matTone.x)) == 16u && abs(archF - 4.0) < 0.5 && motion > 0.05) {
    let stationIdx = min(23u, u32(max(0.0, round((matTone.x - 16.0) * 64.0))));
    let piv = BARGE_OAR_PIVOTS[stationIdx];
    let side = piv.w;
    let cyc = F.camPos.w * 2.15 + phase + f32(stationIdx >> 1u) * 0.16;
    let sweep = sin(cyc) * 0.36 * min(motion, 1.5);
    let dip = cos(cyc) * 0.18 * min(motion, 1.5);
    let d = p - piv.xyz;
    let cy = cos(sweep * side); let sy = sin(sweep * side);
    let dYaw = vec3f(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);
    let cr = cos(dip * side); let sr = sin(dip * side);
    p = piv.xyz + vec3f(dYaw.x * cr - dYaw.y * sr, dYaw.x * sr + dYaw.y * cr, dYaw.z);
    let nYaw = vec3f(n.x * cy - n.z * sy, n.y, n.x * sy + n.z * cy);
    n = vec3f(nYaw.x * cr - nYaw.y * sr, nYaw.x * sr + nYaw.y * cr, nYaw.z);
  }
  p = animateTradeSailBrail(p, material, uv, instAnim.w, aIdx);
  return array<vec3f, 2>(p, n);
}

fn vesselWorldTransform(srcPos: vec3f, srcNorm: vec3f, material: f32, uv: vec2f, posYaw: vec4f, att: vec4f, anim: vec4f) -> array<vec3f, 3> {
  let aIdx = min(u32(${TRADE_VESSEL_ARCHETYPES - 1}), u32(max(0.0, round(att.w))));
  let sc4 = ARCHETYPE_SCALES[aIdx];
  let scaleMetres = vec3f(sc4.x * att.z, sc4.y, sc4.z * att.z);
  let animated = animateTradeOar(srcPos, srcNorm, material, uv, anim, att.w);
  let unitLocalN = normalize(animated[1] / max(length(animated[1]), 1e-5));
  let wpLocal = rotateVessel(animated[0] * scaleMetres, posYaw.w, att.x, att.y);
  let wn = normalize(rotateVessel(unitLocalN / max(scaleMetres, vec3f(0.05)), posYaw.w, att.x, att.y));
  let wp = posYaw.xyz + wpLocal;
  return array<vec3f, 3>(wp, wn, unitLocalN);
}

@vertex fn tvVS(v: TVVertexIn) -> TVVertexOut {
  ${damaged ? `
  let rawPos = v.posedPos;
  let rawNorm = v.posedNorm;
  ` : `
  let rawPos = v.pos;
  let rawNorm = v.norm;
  `}
  let nLen = max(length(v.norm), length(rawNorm));
  ${damaged ? `
  let tr = vesselWorldTransform(rawPos, rawNorm, v.material, v.uv, v.instPosYaw, v.instAttitude, v.instAnim);
  ` : `
  let tr = vesselWorldTransform(rawPos, rawNorm, v.material, v.uv, v.instPosYaw, v.instAttitude, v.instAnim);
  `}
  let aIdx = min(u32(${TRADE_VESSEL_ARCHETYPES - 1}), u32(max(0.0, round(v.instAttitude.w))));
  let sc4 = ARCHETYPE_SCALES[aIdx];
  let shifted = tr[0] + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  var o: TVVertexOut;
  o.pos = F.viewProj * vec4f(earthCurve(shifted - F.camPos.xyz, F.camPos.y), 1.0);
  o.world = shifted;
  o.normal = tr[1];
  o.local = v.pos;
  o.normalLocal = tr[2];
  o.matId = u32(max(0.0, floor(v.material)));
  o.uv = v.uv;
  o.draftRatio = max(sc4.w, 0.4);
  ${damaged ? 'o.damage = select(0.0, clamp(nLen - 1.0, 0.0, 1.5), nLen > 1.002);' : 'o.fadeShare = clamp(v.instAnim.z, 0.0, 1.0);'}
  return o;
}

@vertex fn tvShadowVS(v: TVVertexIn) -> @builtin(position) vec4f {
  ${damaged ? `
  let tr = vesselWorldTransform(v.posedPos, v.posedNorm, v.material, v.uv, v.instPosYaw, v.instAttitude, v.instAnim);
  ` : `
  let tr = vesselWorldTransform(v.pos, v.norm, v.material, v.uv, v.instPosYaw, v.instAttitude, v.instAnim);
  `}
  let shifted = tr[0] + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  return landSH.lightView * vec4f(shifted - landSH.origin.xyz, 1.0);
}

fn tradeShadowVis(world: vec3f, normal: vec3f) -> f32 {
  if (landSH.origin.w < 0.5) { return 1.0; }
  let p = landSH.lightView * vec4f(world - landSH.origin.xyz + normal * 0.04 + landSH.sun.xyz * 0.03, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let fade = smoothstep(0.0, 0.06, edge) * step(0.0, p.z) * step(p.z, 1.0);
  let refZ = min(p.z - 0.08 / max(landSH.sun.w, 1.0), 0.99999);
  let s = textureSampleCompareLevel(landSolidShadow, landShadowCompare, clamp(uv, vec2f(0.001), vec2f(0.999)), refZ);
  return mix(1.0, s, fade);
}

fn isWoodMat(m: u32) -> bool {
  return m == 0u || m == 1u || m == 5u || m == 6u || m == 7u || m == 10u || m == 14u || m == 15u || m == 16u || m == 17u || m == 18u;
}
fn isRopeMat(m: u32) -> bool { return m == 2u || m == 12u || m == 19u; }
fn isSailMat(m: u32) -> bool { return m == 9u || m == 13u; }

${damaged ? `
fn hullHoleRim(p: vec3f) -> f32 {
  var rim = 0.0;
  let metres = p * hullDamage.scale.xyz;
  for (var i = 0u; i < u32(hullDamage.scale.w); i++) {
    let hole = hullDamage.holes[i];
    let d = metres - hole.xyz;
    if (abs(d.x) > 1.2) { continue; }
    let distance = length(d.yz * vec2f(1.0, 0.82));
    if (distance > hole.w * 1.8 + 0.08) { continue; }
    let around = d.yz / max(length(d.yz), 0.0001);
    let ragged = 0.84 + 0.55 * gnoise(around * 1.7 + hole.xz * 9.0) + 0.2 * gnoise(vec2f(metres.z * 22.0, metres.y * 48.0));
    let edge = hole.w * ragged;
    if (distance < edge) { return -1.0; }
    rim = max(rim, 1.0 - smoothstep(edge, edge * 1.3 + 0.035, distance));
  }
  return rim;
}
fn ropeParted(p: vec3f, dmg: f32) -> bool {
  return dmg > 0.58 && gnoise(vec2f((p.x + p.z) * 32.0, p.y * 48.0)) > 1.18 - dmg * 0.65;
}
fn canvasTearMask(uv: vec2f, p: vec3f, mat: u32, dmg: f32) -> f32 {
  let warpTear = gnoise(vec2f(uv.x * 42.0 + floor(uv.x * 10.0) * 3.7, uv.y * 8.5));
  let shotTear = gnoise(vec2f(uv.x * 16.0 + p.x * 2.1, uv.y * 16.0 + p.y * 1.9));
  let fray = gnoise(vec2f(uv.x * 170.0, uv.y * 55.0));
  let sqEdge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let triEdge = min(min(uv.x, uv.y), (1.0 - uv.x - uv.y) * 0.70710678);
  let keepRim = (1.0 - smoothstep(0.0, 0.035, select(sqEdge, triEdge, mat == 13u))) * 0.35;
  let val = warpTear * 0.48 + shotTear * 0.34 + fray * 0.18 - keepRim;
  let thr = clamp(0.96 - dmg * 0.56, 0.24, 0.92);
  return val - thr;
}
@fragment fn surviving(in: TVVertexOut) -> @location(0) vec4f {
  if (isWoodMat(in.matId) && hullHoleRim(in.local) < 0.0) { discard; }
  if (isRopeMat(in.matId) && ropeParted(in.local, in.damage)) { discard; }
  if (isSailMat(in.matId) && in.damage > 0.04 && canvasTearMask(in.uv, in.local, in.matId, in.damage) > 0.0) { discard; }
  return vec4f(0.0);
}
` : ''}

${damaged ? '' : 'struct TVFragmentOut { @location(0) color: vec4f, @builtin(sample_mask) mask: u32 };'}
@fragment fn tvFS(in: TVVertexOut, @builtin(front_facing) front: bool) -> ${damaged ? '@location(0) vec4f' : 'TVFragmentOut'} {
  // Uniform control flow: sample oak albedo and evaluate derivatives before any branches.
  let timberRaw = pow(textureSample(oakAlbedo, oakSampler, in.uv * vec2f(1.2, 1.2)).rgb, vec3f(2.2));
  let course = select(in.local.y * 9.0, in.uv.x * 18.0, in.matId == 15u);
  let courseAA = max(fwidth(course), 0.001);
  let deckCourse = (in.local.x + 1.8) / 0.145;
  let deckAA = max(fwidth(deckCourse), 0.002);
  let sailDepth = canvasThickness(in.uv, in.matId);

  let p = in.local;
  let nBase = normalize(in.normal) * select(-1.0, 1.0, front);
  var n = nBase;
  let m = in.matId;
  let timber = mix(vec3f(0.24, 0.16, 0.095), timberRaw * vec3f(1.05, 0.96, 0.84), 0.78);
  let strakeEdge = min(fract(course), 1.0 - fract(course));
  let seam = 1.0 - smoothstep(0.008, 0.036 + courseAA, strakeEdge);
  let deckEdge = min(fract(deckCourse), 1.0 - fract(deckCourse));
  let deckSeam = 1.0 - smoothstep(0.014, 0.040 + deckAA, deckEdge);
  let boardHash = 0.88 + 0.18 * fract(sin(floor(course) * 74.17) * 4321.1);

  var albedo = timber * boardHash;
  var rough = 0.84;
  var metal = 0.0;
  var isSail = false;

  if (m == 0u) {
    // Weathered caulked deck planks
    albedo = mix(timber * vec3f(1.12, 1.06, 0.94), vec3f(0.016, 0.012, 0.009), deckSeam * 0.84);
    rough = mix(0.82, 0.94, deckSeam);
  } else if (m == 15u) {
    // Exterior hull planking: caulked seams + waterproof Stockholm pitch-tar strictly at/below waterline
    let tar = 1.0 - smoothstep(-0.14, 0.03, p.y);
    albedo = mix(timber * boardHash * (1.0 - seam * 0.55), vec3f(0.022, 0.018, 0.014), tar * 0.88);
    rough = mix(0.84, 0.72, tar);
  } else if (m == 10u) {
    // Pine masts & yards with weathered checking + iron mast bands
    let band = 1.0 - smoothstep(0.04, 0.09, abs(fract(p.y * 0.65) - 0.5));
    albedo = mix(timber * vec3f(1.10, 0.94, 0.72), vec3f(0.032, 0.030, 0.028), band * 0.65);
    metal = mix(0.0, 0.45, band * 0.65);
    rough = mix(0.76, 0.58, band);
  } else if (m == 1u || m == 5u || m == 6u || m == 7u || m == 14u || m == 16u || m == 17u || m == 18u) {
    // Oak frames, oars, casks, benches & bulwark timber
    albedo = timber * select(vec3f(0.90, 0.82, 0.70), vec3f(0.82, 0.74, 0.62), m == 16u || m == 17u) * (1.0 - seam * 0.35);
    rough = 0.84;
  } else if (m == 3u || m == 8u) {
    // Forged wrought iron anchors, ordnance & barrel hoops
    albedo = vec3f(0.055, 0.052, 0.050);
    rough = 0.44;
    metal = 0.78;
  } else if (m == 4u) {
    albedo = vec3f(0.020, 0.016, 0.013);
    rough = 0.88;
  } else if (m == 2u || m == 12u || m == 19u) {
    // Standing tarred shrouds (2u) & natural hemp running rigging/lashings (12u, 19u)
    albedo = select(vec3f(0.24, 0.19, 0.12), vec3f(0.045, 0.038, 0.030), m == 2u);
    rough = 0.94;
  } else if (m == 9u || m == 13u) {
    // Woven Baltic linen canvas (9u square sails / bales, 13u lateen sails / sacks)
    isSail = true;
    let woven = 0.95 + 0.05 * gnoise(in.uv * vec2f(24.0, 18.0));
    let tint = select(vec3f(0.62, 0.58, 0.49), vec3f(0.56, 0.50, 0.39), m == 13u && in.local.y < 1.3);
    albedo = tint * woven * clamp(1.12 - (sailDepth - 1.0) * 0.18, 0.72, 1.08);
    rough = 0.93;
  } else if (m == 11u) {
    // Glazed stern windows
    albedo = vec3f(0.025, 0.042, 0.048);
    rough = 0.08;
    metal = 0.25;
  } else if (m == 20u) {
    albedo = vec3f(0.025, 0.022, 0.018);
    rough = 0.86;
  } else if (m == 21u || m == 25u) {
    albedo = vec3f(0.48, 0.28, 0.065);
    rough = select(0.84, 0.42, m == 25u);
    metal = select(0.0, 0.68, m == 25u);
  } else if (m == 22u) {
    albedo = vec3f(0.32, 0.13, 0.065);
    rough = 0.48;
    metal = 0.70;
  } else if (m == 23u) {
    albedo = vec3f(0.66, 0.62, 0.52);
  } else if (m == 24u) {
    albedo = vec3f(0.28, 0.032, 0.020);
  } else if (m == 26u) {
    albedo = vec3f(0.020, 0.042, 0.10);
  }

  ${damaged ? `
  let holeRim = select(0.0, max(hullHoleRim(p), 0.0), isWoodMat(m) && u32(hullDamage.scale.w) > 0u);
  if (holeRim > 0.0) {
    let splinter = 0.58 + 0.85 * gnoise(vec2f(p.z * 90.0, p.y * 140.0));
    albedo = mix(albedo, vec3f(0.45, 0.32, 0.19) * splinter, holeRim);
    rough = mix(rough, 0.96, holeRim);
    metal *= (1.0 - holeRim);
  }
  let craterCount = u32(hullDamage.level.w);
  if (craterCount > 0u && isWoodMat(m)) {
    var scorch = 0.0;
    for (var ci = 0u; ci < craterCount; ci++) {
      let cr = hullDamage.craters[ci];
      let crRad = max(0.06, f32(cr.packed & 0xFFFu) / 4000.0);
      let dCr = length((p - cr.at) * vec3f(0.85, 1.15, 1.0));
      scorch = max(scorch, 1.0 - smoothstep(crRad * 0.45, crRad * 2.2 + 0.12, dCr));
    }
    albedo = mix(albedo, vec3f(0.032, 0.025, 0.020), scorch * 0.88);
    rough = mix(rough, 0.98, scorch);
  }
  if (in.damage > 0.04) {
    let charMix = clamp(in.damage * 0.58, 0.0, 0.82);
    albedo = mix(albedo, vec3f(0.045, 0.035, 0.026), charMix);
    rough = max(rough, 0.92);
  }
  ` : ''}

  let sunDir = normalize(F.sunDir.xyz);
  let viewDir = normalize(F.camPos.xyz - in.world);
  let sunVis = solarShadowVisibility(vec3f(tradeShadowVis(in.world, n)));
  let sunRad = sunIlluminance() * sunVis;
  let nDotL = max(dot(n, sunDir), 0.0);
  let skyCol = skyAtmo(normalize(vec3f(n.x * 0.35, max(n.y, 0.14), n.z * 0.35)));
  let seaCol = skyAtmo(vec3f(0.0, 0.25, 0.0)) * 0.45 + F.waterCol.rgb * 0.65;
  let amb = vesselAmbient(n, skyCol, seaCol);

  let diffTint = albedo * (1.0 - metal);
  let f0 = mix(vec3f(0.04), albedo, metal);
  var direct = (diffTint / PI) * sunRad * nDotL;
  if (isSail) {
    let backCos = max(dot(-n, sunDir), 0.0);
    let trans = canvasTransmission(sailDepth, max(backCos, 0.20));
    direct += albedo * sunRad * trans * backCos * 0.42;
  }
  let spec = select(vec3f(0.0), vesselSpecular(n, viewDir, sunDir, rough, f0) * sunRad * nDotL, nDotL > 0.0);
  let refl = reflect(-viewDir, n);
  let envCol = textureSampleLevel(envCube, sampC, refl, rough * 7.0).rgb;
  let envSpec = envCol * vesselEnvironment(n, viewDir, rough, f0) * select(0.28, 0.85, metal > 0.1 || rough < 0.25);

  let lit = diffTint * amb * 0.82 + direct + spec + envSpec;
  ${damaged ? `
  return vec4f(surfaceAir(lit, in.world), 1.0);
}
  ` : `
  let takeMask = vesselCrownSamples(in.fadeShare, in.pos.xy, TV_SAMPLES);
  let keepMask = (~takeMask) & TV_SAMPLE_MASK_ALL;
  var outF: TVFragmentOut;
  outF.color = vec4f(surfaceAir(lit, in.world), 1.0);
  outF.mask = keepMask;
  return outF;
}
  `}
`;
}

export const TRADE_VESSELS_WGSL = tradeVesselsSource(false);

const TRADE_SHARED_TYPES_WGSL = /* wgsl */ `
struct TradeNearDomain { domain: vec4f, grid: vec4f };
struct TradeInstance {
  posYaw: vec4f,
  attScaleArch: vec4f,
  animSink: vec4f,
};
struct ArchContInfo {
  splatCenterRad: vec4f,
  splatExtentCol: vec4f,
  splatCol: vec4f,
  counts: vec4u,
};
struct TradeSelectParams {
  ctrl: vec4u,
  params: vec4f,
  arch: array<ArchContInfo, ${TRADE_VESSEL_ARCHETYPES}>,
};
`;

function buildTradeVesselClearWGSL() {
  const counts = inspectTradeVesselArchetypes().map((a) => `${a.indexCount}u`);
  return /* wgsl */ `
const ARCHETYPE_INDEX_COUNTS = array<u32, ${TRADE_VESSEL_ARCHETYPES}>(${counts.join(', ')});
@group(0) @binding(8) var<storage, read_write> indirect: array<u32>;
@compute @workgroup_size(1) fn main() {
  for (var s = 0u; s < 14u; s++) {
    let base = s * 5u;
    indirect[base] = ARCHETYPE_INDEX_COUNTS[s % ${TRADE_VESSEL_ARCHETYPES}u];
    indirect[base + 1u] = 0u;
    indirect[base + 2u] = 0u;
    indirect[base + 3u] = 0u;
    indirect[base + 4u] = 0u;
  }
  indirect[70u] = 0u; indirect[71u] = 1u; indirect[72u] = 0u; indirect[73u] = 0u;
  indirect[74u] = 0u; indirect[75u] = 1u; indirect[76u] = 0u; indirect[77u] = 0u;
}
`;
}

const TRADE_VESSEL_SELECT_WGSL = FRAME_WGSL + SHADOW_FRAME + VESSEL_SAMPLE_MASK_WGSL + TRADE_SHARED_TYPES_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> nearTerrain: TradeNearDomain;
@group(0) @binding(2) var<uniform> selP: TradeSelectParams;
@group(0) @binding(3) var<storage, read> srcInstances: array<TradeInstance>;
@group(0) @binding(4) var<storage, read> stepMeta: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> nearOut: array<TradeInstance>;
@group(0) @binding(6) var<storage, read_write> contList: array<vec4u>;
@group(0) @binding(7) var<storage, read_write> splatList: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> indirect: array<atomic<u32>>;
@group(0) @binding(9) var<uniform> landSH: ShadowFrame;

fn rotateVesselSel(v: vec3f, heading: f32, pitch: f32, roll: f32) -> vec3f {
  let cr = cos(roll); let sr = sin(roll);
  let cp = cos(pitch); let sp = sin(pitch);
  let ch = cos(heading); let sh = sin(heading);
  let xx = cr * v.x - sr * v.y;
  let yy = sr * v.x + cr * v.y;
  let yp = cp * yy - sp * v.z;
  let zp = sp * yy + cp * v.z;
  return vec3f(ch * xx - sh * zp, yp, sh * xx + ch * zp);
}

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= selP.ctrl.x) { return; }
  let inst = srcInstances[i];
  let aIdx = min(u32(${TRADE_VESSEL_ARCHETYPES - 1}), u32(max(0.0, round(inst.attScaleArch.w))));
  let arch = selP.arch[aIdx];
  let yaw = inst.posYaw.w;
  let pitch = inst.attScaleArch.x;
  let roll = inst.attScaleArch.y;
  let scaleMul = max(inst.attScaleArch.z, 0.25);
  let shipWorld = inst.posYaw.xyz + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);

  // 1. Shadow frustum culling -> shadow DrawIndexedIndirect slices 7..13
  if (landSH.origin.w > 0.5) {
    let shPos = landSH.lightView * vec4f(shipWorld - landSH.origin.xyz, 1.0);
    if (abs(shPos.x) <= 1.25 && abs(shPos.y) <= 1.25 && shPos.z >= -0.25 && shPos.z <= 1.25) {
      let shSlot = atomicAdd(&indirect[(7u + aIdx) * 5u + 1u], 1u);
      if (shSlot < ${MAX_TRADE_VESSELS}u) {
        nearOut[(7u + aIdx) * ${MAX_TRADE_VESSELS}u + shSlot] = inst;
      }
    }
  }

  // 2. Camera frustum & screen-space continuum error selection
  let scaleXZ = vec3f(scaleMul, 1.0, scaleMul);
  let worldCenter = shipWorld + rotateVesselSel(arch.splatCenterRad.xyz * scaleXZ, yaw, pitch, roll);
  let toCenter = worldCenter - F.camPos.xyz;
  let dist = max(length(toCenter), 1.0);
  let boundRad = arch.splatCenterRad.w * max(scaleMul, 1.0);
  let clip = F.viewProj * vec4f(earthCurve(toCenter, F.camPos.y), 1.0);
  if (clip.w < -boundRad * 1.4) { return; }
  let tanX = max(length(F.camRight.xyz), 0.15);
  let tanY = max(length(F.camUp.xyz), 0.15);
  let wEff = max(clip.w, 1.0);
  if (abs(clip.x) > wEff * 1.18 + boundRad / tanX || abs(clip.y) > wEff * 1.18 + boundRad / tanY) { return; }

  let focal = 0.5 * F.screen.y / tanY;
  let startErrM = max(arch.splatExtentCol.z, 0.04) * scaleMul;
  let projStartErr = (startErrM * focal) / dist;
  let errPx = selP.params.x;
  let splatPx = selP.params.y;
  let minPx = selP.params.z;
  let band = selP.params.w;
  let bandHi = errPx * (1.0 + band);

  if (projStartErr >= errPx) {
    let nearSlot = atomicAdd(&indirect[aIdx * 5u + 1u], 1u);
    if (nearSlot < ${MAX_TRADE_VESSELS}u) {
      var outInst = inst;
      let share = select(clamp(smoothstep(bandHi, errPx, projStartErr), 0.0, 0.999), 0.0, projStartErr >= bandHi);
      outInst.animSink.z = share;
      nearOut[aIdx * ${MAX_TRADE_VESSELS}u + nearSlot] = outInst;
      if (share > 0.002) {
        let triCount = u32(round(stepMeta[arch.counts.x].z));
        let startVert = atomicAdd(&indirect[70u], triCount * 3u);
        let startTri = startVert / 3u;
        if (startTri + triCount <= selP.ctrl.y) {
          let sharePacked = u32(round(share * 65535.0));
          for (var t = 0u; t < triCount; t++) {
            contList[startTri + t] = vec4u(i, t, 0u, sharePacked);
          }
        }
      }
    }
    return;
  }

  let spanPx = (2.0 * boundRad * focal) / dist;
  if (spanPx <= splatPx) {
    let keepProb = clamp(spanPx / max(minPx, 1e-3), 0.06, 1.0);
    let h = vesselCovHash(i ^ u32(abs(inst.animSink.x) * 131.0));
    let keep = (spanPx >= minPx) || ((f32(h & 65535u) / 65536.0) <= keepProb);
    if (!keep) { return; }
    let inflate = select(1.0, 1.0 / sqrt(keepProb), spanPx < minPx);
    let bow = vec2f(sin(yaw), -cos(yaw));
    let viewXZ = normalize(vec2f(toCenter.x, toCenter.z) + vec2f(1e-5, 0.0));
    let broadFactor = abs(bow.x * viewXZ.y - bow.y * viewXZ.x);
    let worldHalfW = mix(arch.splatExtentCol.x, arch.splatExtentCol.w, broadFactor) * scaleMul * inflate;
    let worldHalfH = arch.splatExtentCol.y * inflate;
    let sVert = atomicAdd(&indirect[74u], 3u);
    let sIdx = sVert / 3u;
    if (sIdx < selP.ctrl.w) {
      splatList[sIdx * 2u] = vec4f(worldCenter, worldHalfW);
      splatList[sIdx * 2u + 1u] = vec4f(arch.splatCol.rgb, worldHalfH);
    }
    return;
  }

  let allowedErr = (errPx * dist) / max(focal * scaleMul, 1.0);
  let stepBase = arch.counts.x;
  let stepCount = arch.counts.y;
  var lo = 0u;
  var hi = select(0u, stepCount - 1u, stepCount > 0u);
  while (lo < hi) {
    let mid = (lo + hi + 1u) >> 1u;
    if (stepMeta[stepBase + mid].x <= allowedErr) { lo = mid; }
    else { hi = mid - 1u; }
  }
  let e0 = stepMeta[stepBase + lo].x;
  let e1 = stepMeta[stepBase + min(lo + 1u, stepCount)].x;
  let morphT = clamp((allowedErr - e0) / max(e1 - e0, 1e-4), 0.0, 1.0);
  let stepPacked = lo | (u32(round(morphT * 65535.0)) << 16u);
  let triCount = u32(round(stepMeta[stepBase + lo].z));
  let startVert = atomicAdd(&indirect[70u], triCount * 3u);
  let startTri = startVert / 3u;
  if (startTri + triCount <= selP.ctrl.y) {
    for (var t = 0u; t < triCount; t++) {
      contList[startTri + t] = vec4u(i, t, stepPacked, 65535u);
    }
  }
}
`;

export function buildTradeVesselContinuumWGSL(samples = 4) {
  const safeSamples = Math.max(1, Math.min(4, samples | 0));
  const sampleMaskAll = (1 << safeSamples) - 1;
  return FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + VESSEL_LIGHTING + VESSEL_SAMPLE_MASK_WGSL + TRADE_SHARED_TYPES_WGSL + /* wgsl */ `
const TV_CONT_SAMPLES: u32 = ${safeSamples}u;
const TV_CONT_MASK_ALL: u32 = ${sampleMaskAll}u;
struct ContState { px: f32, py: f32, pz: f32, normPacked: u32 };

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(12) var<uniform> nearTerrain: TradeNearDomain;

@group(1) @binding(0) var<uniform> selP: TradeSelectParams;
@group(1) @binding(1) var<storage, read> srcInstances: array<TradeInstance>;
@group(1) @binding(2) var<storage, read> contList: array<vec4u>;
@group(1) @binding(3) var<storage, read> baseIndices: array<u32>;
@group(1) @binding(4) var<storage, read> contStates: array<ContState>;
@group(1) @binding(5) var<storage, read> contVertCols: array<vec4f>;

fn rotateVesselCont(v: vec3f, heading: f32, pitch: f32, roll: f32) -> vec3f {
  let cr = cos(roll); let sr = sin(roll);
  let cp = cos(pitch); let sp = sin(pitch);
  let ch = cos(heading); let sh = sin(heading);
  let xx = cr * v.x - sr * v.y;
  let yy = sr * v.x + cr * v.y;
  let yp = cp * yy - sp * v.z;
  let zp = sp * yy + cp * v.z;
  return vec3f(ch * xx - sh * zp, yp, sh * xx + ch * zp);
}

struct TVContOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) fadeShare: f32,
};

@vertex fn tvContVS(@builtin(vertex_index) vid: u32) -> TVContOut {
  let triSlot = vid / 3u;
  let corner = vid % 3u;
  let entry = contList[triSlot];
  let inst = srcInstances[entry.x];
  let aIdx = min(u32(${TRADE_VESSEL_ARCHETYPES - 1}), u32(max(0.0, round(inst.attScaleArch.w))));
  let arch = selP.arch[aIdx];
  let stepIdx = entry.z & 0xFFFFu;
  let morphT = f32((entry.z >> 16u) & 0xFFFFu) / 65535.0;
  let share = f32(entry.w & 0xFFFFu) / 65535.0;
  let vi = baseIndices[arch.counts.z + entry.y * 3u + corner];
  let stepVerts = u32(max(1.0, round(arch.splatCol.w)));
  let v0 = contStates[arch.counts.w + stepIdx * stepVerts + vi];
  let v1 = contStates[arch.counts.w + min(stepIdx + 1u, arch.counts.y) * stepVerts + vi];
  let localP = mix(vec3f(v0.px, v0.py, v0.pz), vec3f(v1.px, v1.py, v1.pz), morphT) * vec3f(inst.attScaleArch.z, 1.0, inst.attScaleArch.z);
  let n0 = unpack4x8unorm(v0.normPacked).xyz * 2.0 - 1.0;
  let n1 = unpack4x8unorm(v1.normPacked).xyz * 2.0 - 1.0;
  let localN = normalize(mix(n0, n1, morphT) + vec3f(0.0, 1e-4, 0.0));
  let shipWorld = inst.posYaw.xyz + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  let worldP = shipWorld + rotateVesselCont(localP, inst.posYaw.w, inst.attScaleArch.x, inst.attScaleArch.y);
  let worldN = normalize(rotateVesselCont(localN / vec3f(max(inst.attScaleArch.z, 0.25), 1.0, max(inst.attScaleArch.z, 0.25)), inst.posYaw.w, inst.attScaleArch.x, inst.attScaleArch.y));

  var o: TVContOut;
  o.pos = F.viewProj * vec4f(earthCurve(worldP - F.camPos.xyz, F.camPos.y), 1.0);
  o.world = worldP;
  o.normal = worldN;
  o.color = contVertCols[stepVerts * aIdx + vi].rgb;
  o.fadeShare = share;
  return o;
}

struct TVContFragOut { @location(0) color: vec4f, @builtin(sample_mask) mask: u32 };
@fragment fn tvContFS(in: TVContOut, @builtin(front_facing) front: bool) -> TVContFragOut {
  let n = normalize(in.normal) * select(-1.0, 1.0, front);
  let sunDir = normalize(F.sunDir.xyz);
  let viewDir = normalize(F.camPos.xyz - in.world);
  let sunRad = sunIlluminance();
  let nDotL = max(dot(n, sunDir), 0.0);
  let skyCol = skyAtmo(normalize(vec3f(n.x * 0.35, max(n.y, 0.14), n.z * 0.35)));
  let seaCol = skyAtmo(vec3f(0.0, 0.25, 0.0)) * 0.45 + F.waterCol.rgb * 0.65;
  let amb = vesselAmbient(n, skyCol, seaCol);
  let albedo = in.color;
  let direct = (albedo / PI) * sunRad * nDotL;
  let spec = select(vec3f(0.0), vesselSpecular(n, viewDir, sunDir, 0.72, vec3f(0.04)) * sunRad * nDotL, nDotL > 0.0);
  let refl = reflect(-viewDir, n);
  let envCol = textureSampleLevel(envCube, sampC, refl, 5.0).rgb * 0.04;
  let lit = albedo * amb * 0.82 + direct + spec + envCol;
  let mask = select(vesselCrownSamples(in.fadeShare, in.pos.xy, TV_CONT_SAMPLES), TV_CONT_MASK_ALL, in.fadeShare >= 0.999);
  return TVContFragOut(vec4f(surfaceAir(lit, in.world), 1.0), mask);
}
`;
}

export function buildTradeVesselSplatWGSL(samples = 4) {
  const safeSamples = Math.max(1, Math.min(4, samples | 0));
  return FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + VESSEL_LIGHTING + /* wgsl */ `
const TV_SPLAT_SAMPLES: u32 = ${safeSamples}u;
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(1) @binding(0) var<storage, read> splatList: array<vec4f>;

struct TVSplatOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) color: vec3f,
  @location(2) uv: vec2f,
};

@vertex fn tvSplatVS(@builtin(vertex_index) vid: u32) -> TVSplatOut {
  let sIdx = vid / 3u;
  let corner = vid % 3u;
  let a = splatList[sIdx * 2u];
  let b = splatList[sIdx * 2u + 1u];
  var uv = vec2f(0.0, 2.0);
  if (corner == 1u) { uv = vec2f(-1.7320508, -1.0); }
  else if (corner == 2u) { uv = vec2f(1.7320508, -1.0); }
  let toCam = normalize(F.camPos.xyz - a.xyz);
  let right = normalize(cross(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(toCam.y) > 0.98), toCam));
  let up = normalize(cross(toCam, right));
  let worldP = a.xyz + right * (uv.x * a.w) + up * (uv.y * b.w);
  var o: TVSplatOut;
  o.pos = F.viewProj * vec4f(earthCurve(worldP - F.camPos.xyz, F.camPos.y), 1.0);
  o.world = worldP;
  o.color = b.rgb;
  o.uv = uv;
  return o;
}

struct TVSplatFragOut { @location(0) color: vec4f, @builtin(sample_mask) mask: u32 };
@fragment fn tvSplatFS(in: TVSplatOut) -> TVSplatFragOut {
  let ux = dpdx(in.uv);
  let uy = dpdy(in.uv);
  var mask = 0u;
  if (TV_SPLAT_SAMPLES <= 1u) {
    if (dot(in.uv, in.uv) <= 1.0) { mask = 1u; }
  } else {
    let offs = array<vec2f, 4>(vec2f(-0.125, -0.375), vec2f(0.375, -0.125), vec2f(-0.375, 0.125), vec2f(0.125, 0.375));
    for (var s = 0u; s < 4u; s++) {
      let puv = in.uv + ux * offs[s].x + uy * offs[s].y;
      if (dot(puv, puv) <= 1.0) { mask |= (1u << s); }
    }
  }
  let n = normalize(vec3f(in.uv.x * 0.4, 0.72, -0.3) + normalize(F.camPos.xyz - in.world) * 0.55);
  let sunDir = normalize(F.sunDir.xyz);
  let viewDir = normalize(F.camPos.xyz - in.world);
  let sunRad = sunIlluminance();
  let nDotL = max(dot(n, sunDir), 0.0);
  let skyCol = skyAtmo(vec3f(0.0, 0.45, 0.0));
  let seaCol = skyAtmo(vec3f(0.0, 0.22, 0.0)) * 0.45 + F.waterCol.rgb * 0.65;
  let amb = vesselAmbient(n, skyCol, seaCol);
  let envHaze = textureSampleLevel(envCube, sampC, viewDir, 6.0).rgb * 0.02;
  let lit = in.color * (amb * 0.85 + (sunRad * nDotL) / PI) + envHaze;
  return TVSplatFragOut(vec4f(surfaceAir(lit, in.world), 1.0), mask);
}
`;
}

export const TRADE_VESSEL_CONTINUUM_WGSL = buildTradeVesselContinuumWGSL(4);
export const TRADE_VESSEL_SPLAT_WGSL = buildTradeVesselSplatWGSL(4);

const tradePipelineCache = new WeakMap();

function getPipelineEntry(device, cacheKey, builder) {
  let map = tradePipelineCache.get(device);
  if (!map) {
    map = new Map();
    tradePipelineCache.set(device, map);
  }
  if (!map.has(cacheKey)) {
    const p = builder().catch((err) => {
      map.delete(cacheKey);
      throw err;
    });
    map.set(cacheKey, p);
  }
  return map.get(cacheKey);
}

const INTACT_VERTEX_BUFFERS = Object.freeze([
  Object.freeze({
    arrayStride: TRADE_VESSEL_VERTEX_FLOATS * 4,
    stepMode: 'vertex',
    attributes: Object.freeze([
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32' },
      { shaderLocation: 3, offset: 28, format: 'float32x2' },
    ]),
  }),
  Object.freeze({
    arrayStride: TRADE_VESSEL_INSTANCE_FLOATS * 4,
    stepMode: 'instance',
    attributes: Object.freeze([
      { shaderLocation: 4, offset: 0, format: 'float32x4' },
      { shaderLocation: 5, offset: 16, format: 'float32x4' },
      { shaderLocation: 6, offset: 32, format: 'float32x4' },
    ]),
  }),
]);

const DAMAGED_VERTEX_BUFFERS = Object.freeze([
  INTACT_VERTEX_BUFFERS[0],
  POSED_VERTEX_LAYOUT,
  Object.freeze({
    arrayStride: TRADE_VESSEL_INSTANCE_FLOATS * 4,
    stepMode: 'instance',
    attributes: Object.freeze([
      { shaderLocation: 6, offset: 0, format: 'float32x4' },
      { shaderLocation: 7, offset: 16, format: 'float32x4' },
      { shaderLocation: 8, offset: 32, format: 'float32x4' },
    ]),
  }),
]);

export function requestTradeVesselsPipelines({
  device,
  shader,
  format = 'rgba16float',
  samples = 1,
  shadowFormat = 'depth32float',
} = {}) {
  if (!device || !shader) return Promise.resolve(null);
  const key = `intact:${format}:${samples}:${shadowFormat}`;
  return getPipelineEntry(device, key, async () => {
    const module = await shader(tradeVesselsSource(false, samples), 'trade vessels');
    const [pipe, shadowPipe] = await Promise.all([
      device.createRenderPipelineAsync({
        label: 'trade vessels render',
        layout: 'auto',
        vertex: { module, entryPoint: 'tvVS', buffers: INTACT_VERTEX_BUFFERS },
        fragment: { module, entryPoint: 'tvFS', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: samples },
      }),
      device.createRenderPipelineAsync({
        label: 'trade vessels shadow',
        layout: 'auto',
        vertex: { module, entryPoint: 'tvShadowVS', buffers: INTACT_VERTEX_BUFFERS },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      }),
    ]);
    return { pipe, shadowPipe };
  });
}

function createPlaceholderOak(device) {
  const tex = device.createTexture({
    label: 'trade vessel oak fallback',
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, new Uint8Array([146, 108, 70, 255]), { bytesPerRow: 4 }, [1, 1]);
  const sampler = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear' });
  return { tex, view: tex.createView(), sampler };
}

export async function createTradeVessels({
  device,
  format = 'rgba16float',
  samples = 1,
  shader,
  computePipe = null,
  oceanBridge = null,
  resources,
  shadowFormat = 'depth32float',
} = {}) {
  if (!device || !shader || !resources) return null;

  let destroyed = false;
  let lastContext = null;

  const archGPUs = inspectTradeVesselArchetypes().map((arch) => {
    const vertexBuffer = device.createBuffer({
      label: `trade vessel ${arch.index} (${arch.label}) verts`,
      size: arch.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, arch.vertices);
    const indexBuffer = device.createBuffer({
      label: `trade vessel ${arch.index} (${arch.label}) indices`,
      size: arch.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, arch.indices);
    return { arch, vertexBuffer, indexBuffer };
  });

  const NEAR_SLICE_BYTES = MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS * 4;
  const MAX_CONT_TRIS = MAX_TRADE_VESSELS * 100;
  const U_VERTEX = GPUBufferUsage.VERTEX ?? 32;
  const U_UNIFORM = GPUBufferUsage.UNIFORM ?? 64;
  const U_STORAGE = GPUBufferUsage.STORAGE ?? 128;
  const U_INDIRECT = GPUBufferUsage.INDIRECT ?? 256;
  const U_COPY_DST = GPUBufferUsage.COPY_DST ?? 8;

  const instanceBuffers = archGPUs.map((_, i) => device.createBuffer({
    label: `trade vessel instances ${i}`,
    size: NEAR_SLICE_BYTES,
    usage: U_VERTEX | U_COPY_DST,
  }));

  // Pack static half-edge continuum geometry across all 7 archetypes for GPU compute LOD + splat selection.
  const selectParamsBuf = new ArrayBuffer(480);
  const selectParamsCtrl = new Uint32Array(selectParamsBuf, 0, 4);
  const selectParamsFloats = new Float32Array(selectParamsBuf, 16, 4);
  const selectArchF32 = new Float32Array(selectParamsBuf, 32, TRADE_VESSEL_ARCHETYPES * 16);
  const selectArchU32 = new Uint32Array(selectParamsBuf, 32, TRADE_VESSEL_ARCHETYPES * 16);
  selectParamsCtrl[0] = 0;
  selectParamsCtrl[1] = MAX_CONT_TRIS;
  selectParamsCtrl[2] = samples;
  selectParamsCtrl[3] = MAX_TRADE_VESSELS;
  selectParamsFloats[0] = VESSEL_ERROR_PIXELS;
  selectParamsFloats[1] = VESSEL_SPLAT_PIXELS;
  selectParamsFloats[2] = VESSEL_MIN_PIXELS;
  selectParamsFloats[3] = VESSEL_CONTINUUM_BAND;

  let totalSteps = 0, totalContIndices = 0, totalStateVerts = 0, totalColVerts = 0;
  for (let a = 0; a < archGPUs.length; a++) {
    const c = archGPUs[a].arch.continuum;
    const fOff = a * 16;
    selectArchF32[fOff + 0] = c.splat.centre[0];
    selectArchF32[fOff + 1] = c.splat.centre[1];
    selectArchF32[fOff + 2] = c.splat.centre[2];
    selectArchF32[fOff + 3] = c.splat.radius;
    selectArchF32[fOff + 4] = c.splat.rx;
    selectArchF32[fOff + 5] = c.splat.ry;
    selectArchF32[fOff + 6] = c.stepErrors[0];
    selectArchF32[fOff + 7] = c.splat.rz;
    selectArchF32[fOff + 8] = c.splat.colour[0];
    selectArchF32[fOff + 9] = c.splat.colour[1];
    selectArchF32[fOff + 10] = c.splat.colour[2];
    selectArchF32[fOff + 11] = c.vertCount;
    selectArchU32[fOff + 12] = totalSteps;
    selectArchU32[fOff + 13] = c.stepCount;
    selectArchU32[fOff + 14] = totalContIndices;
    selectArchU32[fOff + 15] = totalStateVerts;
    totalSteps += c.stateCount;
    totalContIndices += c.baseIndices.length;
    totalStateVerts += c.stateCount * c.vertCount;
    totalColVerts += c.vertCount;
  }

  const stepMetaArray = new Float32Array(totalSteps * 4);
  const contBaseIdxArray = new Uint32Array(totalContIndices);
  const contStatesBuf = new ArrayBuffer(totalStateVerts * 16);
  const contStatesF32 = new Float32Array(contStatesBuf);
  const contStatesU32 = new Uint32Array(contStatesBuf);
  const contVertColsArray = new Float32Array(totalColVerts * 4);

  let stepCursor = 0, idxCursor = 0, stateVertCursor = 0, colVertCursor = 0;
  for (let a = 0; a < archGPUs.length; a++) {
    const c = archGPUs[a].arch.continuum;
    const stepBase = stepCursor;
    for (let s = 0; s < c.stateCount; s++) {
      const mOff = stepCursor * 4;
      stepMetaArray[mOff + 0] = c.stepErrors[s];
      stepMetaArray[mOff + 1] = c.stepScales[s];
      stepMetaArray[mOff + 2] = c.activeTriCounts[s];
      stepMetaArray[mOff + 3] = stepBase;
      stepCursor++;
      for (let i = 0; i < c.vertCount; i++) {
        const src = (s * c.vertCount + i) * 3;
        const wOff = stateVertCursor * 4;
        contStatesF32[wOff + 0] = c.morphPositions[src];
        contStatesF32[wOff + 1] = c.morphPositions[src + 1];
        contStatesF32[wOff + 2] = c.morphPositions[src + 2];
        const nx = Math.max(-1, Math.min(1, c.morphNormals[src]));
        const ny = Math.max(-1, Math.min(1, c.morphNormals[src + 1]));
        const nz = Math.max(-1, Math.min(1, c.morphNormals[src + 2]));
        const bx = Math.round((nx * 0.5 + 0.5) * 255) & 255;
        const by = Math.round((ny * 0.5 + 0.5) * 255) & 255;
        const bz = Math.round((nz * 0.5 + 0.5) * 255) & 255;
        contStatesU32[wOff + 3] = bx | (by << 8) | (bz << 16) | (255 << 24);
        stateVertCursor++;
      }
    }
    contBaseIdxArray.set(c.baseIndices, idxCursor);
    idxCursor += c.baseIndices.length;
    for (let i = 0; i < c.vertCount; i++) {
      const cOff = colVertCursor * 4;
      contVertColsArray[cOff + 0] = c.vertColors[i * 3];
      contVertColsArray[cOff + 1] = c.vertColors[i * 3 + 1];
      contVertColsArray[cOff + 2] = c.vertColors[i * 3 + 2];
      contVertColsArray[cOff + 3] = 1.0;
      colVertCursor++;
    }
  }

  const selectUniformBuffer = device.createBuffer({ label: 'trade vessel select uniform', size: selectParamsBuf.byteLength, usage: U_UNIFORM | U_COPY_DST });
  device.queue.writeBuffer(selectUniformBuffer, 0, selectParamsBuf);
  const stepMetaBuffer = device.createBuffer({ label: 'trade vessel step meta', size: stepMetaArray.byteLength, usage: U_STORAGE | U_COPY_DST });
  device.queue.writeBuffer(stepMetaBuffer, 0, stepMetaArray);
  const contBaseIndicesBuffer = device.createBuffer({ label: 'trade vessel cont indices', size: contBaseIdxArray.byteLength, usage: U_STORAGE | U_COPY_DST });
  device.queue.writeBuffer(contBaseIndicesBuffer, 0, contBaseIdxArray);
  const contStatesBuffer = device.createBuffer({ label: 'trade vessel cont states', size: contStatesBuf.byteLength, usage: U_STORAGE | U_COPY_DST });
  device.queue.writeBuffer(contStatesBuffer, 0, contStatesBuf);
  const contVertColsBuffer = device.createBuffer({ label: 'trade vessel cont cols', size: contVertColsArray.byteLength, usage: U_STORAGE | U_COPY_DST });
  device.queue.writeBuffer(contVertColsBuffer, 0, contVertColsArray);

  const srcInstancesBuffer = device.createBuffer({ label: 'trade vessel src instances', size: NEAR_SLICE_BYTES, usage: U_STORAGE | U_COPY_DST });
  const nearOutBuffer = device.createBuffer({ label: 'trade vessel near out', size: 14 * NEAR_SLICE_BYTES, usage: U_STORAGE | U_VERTEX });
  const contListBuffer = device.createBuffer({ label: 'trade vessel cont list', size: MAX_CONT_TRIS * 16, usage: U_STORAGE });
  const splatListBuffer = device.createBuffer({ label: 'trade vessel splat list', size: MAX_TRADE_VESSELS * 2 * 16, usage: U_STORAGE });
  const indirectBuffer = device.createBuffer({ label: 'trade vessel indirect', size: 80 * 4, usage: U_STORAGE | U_INDIRECT | U_COPY_DST });

  const oakFallback = createPlaceholderOak(device);
  let oakView = oakFallback.view;
  const oakSampler = oceanBridge?.oakSampler ?? oakFallback.sampler;

  const canCompute = typeof computePipe === 'function' || typeof device.createComputePipelineAsync === 'function';
  const continuumPromise = canCompute
    ? getPipelineEntry(device, `continuum:${format}:${samples}:${Boolean(computePipe)}`, async () => {
        const makeCompute = computePipe || ((src, lbl) => device.createComputePipelineAsync({
          label: lbl,
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: src }), entryPoint: 'main' },
        }));
        const [clearPipe, selectPipe, contModule, splatModule] = await Promise.all([
          makeCompute(buildTradeVesselClearWGSL(), 'trade vessel clear'),
          makeCompute(TRADE_VESSEL_SELECT_WGSL, 'trade vessel select'),
          shader(buildTradeVesselContinuumWGSL(samples), 'trade vessel continuum'),
          shader(buildTradeVesselSplatWGSL(samples), 'trade vessel splat'),
        ]);
        const [continuumPipe, splatPipe] = await Promise.all([
          device.createRenderPipelineAsync({
            label: 'trade vessel continuum',
            layout: 'auto',
            vertex: { module: contModule, entryPoint: 'tvContVS' },
            fragment: { module: contModule, entryPoint: 'tvContFS', targets: [{ format }] },
            primitive: { topology: 'triangle-list', cullMode: 'back' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
            multisample: { count: samples },
          }),
          device.createRenderPipelineAsync({
            label: 'trade vessel splat',
            layout: 'auto',
            vertex: { module: splatModule, entryPoint: 'tvSplatVS' },
            fragment: { module: splatModule, entryPoint: 'tvSplatFS', targets: [{ format }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
            multisample: { count: samples },
          }),
        ]);
        return { clearPipe, selectPipe, continuumPipe, splatPipe };
      })
    : Promise.resolve(null);

  const [{ pipe, shadowPipe }, continuumPipes] = await Promise.all([
    requestTradeVesselsPipelines({ device, shader, format, samples, shadowFormat }),
    continuumPromise,
  ]);
  if (destroyed) {
    for (const g of archGPUs) { g.vertexBuffer.destroy(); g.indexBuffer.destroy(); }
    for (const b of instanceBuffers) b.destroy();
    for (const b of [
      selectUniformBuffer, stepMetaBuffer, contBaseIndicesBuffer, contStatesBuffer,
      contVertColsBuffer, srcInstancesBuffer, nearOutBuffer, contListBuffer, splatListBuffer, indirectBuffer,
    ]) b.destroy();
    oakFallback.tex.destroy();
    return null;
  }

  const pickEntries = (targetPipe, needed, curResources = resources) => {
    const byBinding = new Map(curResources.map(([b, r]) => [b, r]));
    return device.createBindGroup({
      layout: targetPipe.getBindGroupLayout(0),
      entries: needed.map((b) => ({ binding: b, resource: byBinding.get(b) })),
    });
  };

  const clearPipe = continuumPipes?.clearPipe ?? null;
  const selectPipe = continuumPipes?.selectPipe ?? null;
  const continuumPipe = continuumPipes?.continuumPipe ?? null;
  const splatPipe = continuumPipes?.splatPipe ?? null;

  const makeSelectBindGroup = (curResources = resources) => {
    if (!selectPipe) return null;
    const byBinding = new Map(curResources.map(([b, r]) => [b, r]));
    return device.createBindGroup({
      layout: selectPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: byBinding.get(0) },
        { binding: 1, resource: byBinding.get(12) },
        { binding: 2, resource: { buffer: selectUniformBuffer } },
        { binding: 3, resource: { buffer: srcInstancesBuffer } },
        { binding: 4, resource: { buffer: stepMetaBuffer } },
        { binding: 5, resource: { buffer: nearOutBuffer } },
        { binding: 6, resource: { buffer: contListBuffer } },
        { binding: 7, resource: { buffer: splatListBuffer } },
        { binding: 8, resource: { buffer: indirectBuffer } },
        { binding: 9, resource: byBinding.get(19) },
      ],
    });
  };

  const clearBindGroup = clearPipe
    ? device.createBindGroup({
        layout: clearPipe.getBindGroupLayout(0),
        entries: [{ binding: 8, resource: { buffer: indirectBuffer } }],
      })
    : null;
  let selectBindGroup = makeSelectBindGroup(resources);
  let contGroup0 = continuumPipe ? pickEntries(continuumPipe, [0, 1, 2, 3, 4, 12]) : null;
  const contGroup1 = continuumPipe
    ? device.createBindGroup({
        layout: continuumPipe.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: selectUniformBuffer } },
          { binding: 1, resource: { buffer: srcInstancesBuffer } },
          { binding: 2, resource: { buffer: contListBuffer } },
          { binding: 3, resource: { buffer: contBaseIndicesBuffer } },
          { binding: 4, resource: { buffer: contStatesBuffer } },
          { binding: 5, resource: { buffer: contVertColsBuffer } },
        ],
      })
    : null;
  let splatGroup0 = splatPipe ? pickEntries(splatPipe, [0, 1, 2, 3, 4]) : null;
  const splatGroup1 = splatPipe
    ? device.createBindGroup({
        layout: splatPipe.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: splatListBuffer } }],
      })
    : null;

  let bindGroup = pickEntries(pipe, [0, 1, 2, 3, 4, 12, 19, 20, 21]);
  let shadowBindGroup = pickEntries(shadowPipe, [0, 12, 19]);
  const makeGroup1 = (targetPipe, extraEntries = []) => device.createBindGroup({
    layout: targetPipe.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: oakView },
      { binding: 1, resource: oakSampler },
      ...extraEntries,
    ],
  });
  let intactGroup1 = makeGroup1(pipe);

  // Lazy compilation for damaged-boat pipelines (render, depth prepass, shadow, compute restToPosed) triggered on first cannon hit.
  let damagedAssetPromise = null;
  let damagedAssets = null;
  const ensureDamagedAssets = () => {
    if (damagedAssetPromise) return damagedAssetPromise;
    damagedAssetPromise = getPipelineEntry(device, `damaged:${format}:${samples}:${shadowFormat}:${Boolean(computePipe)}`, async () => {
      const dmgSource = tradeVesselsSource(true);
      const dmgModule = await shader(dmgSource, 'trade vessels damaged');
      const [survivingPipe, shadePipe, dmgShadowPipe, restPosePipe] = await Promise.all([
        device.createRenderPipelineAsync({
          label: 'trade vessels damaged surviving',
          layout: 'auto',
          vertex: { module: dmgModule, entryPoint: 'tvVS', buffers: DAMAGED_VERTEX_BUFFERS },
          fragment: { module: dmgModule, entryPoint: 'surviving', targets: [{ format, writeMask: 0 }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
          multisample: { count: samples },
        }),
        device.createRenderPipelineAsync({
          label: 'trade vessels damaged shade',
          layout: 'auto',
          vertex: { module: dmgModule, entryPoint: 'tvVS', buffers: DAMAGED_VERTEX_BUFFERS },
          fragment: { module: dmgModule, entryPoint: 'tvFS', targets: [{ format }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' },
          multisample: { count: samples },
        }),
        device.createRenderPipelineAsync({
          label: 'trade vessels damaged shadow',
          layout: 'auto',
          vertex: { module: dmgModule, entryPoint: 'tvShadowVS', buffers: DAMAGED_VERTEX_BUFFERS },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
        }),
        computePipe
          ? computePipe(REST_TO_POSED_WGSL, 'trade vessel rest pose')
          : device.createComputePipelineAsync({
              label: 'trade vessel rest pose',
              layout: 'auto',
              compute: { module: device.createShaderModule({ code: REST_TO_POSED_WGSL }), entryPoint: 'main' },
            }),
      ]);
      const assets = { survivingPipe, shadePipe, dmgShadowPipe, restPosePipe };
      return assets;
    }).then((assets) => {
      if (destroyed) return null;
      damagedAssets = assets;
      for (const v of vessels) {
        if (v.damaged && !v.damaged.group0Surviving) {
          rebindDamagedVessel(v);
        }
      }
      return assets;
    }).catch((err) => {
      console.error('[trade-vessels damaged]', err);
      return null;
    });
    return damagedAssetPromise;
  };

  function rebindDamagedVessel(v) {
    if (!damagedAssets || !v.damaged) return;
    v.damaged.group0Surviving = pickEntries(damagedAssets.survivingPipe, [0, 12]);
    v.damaged.group0Shade = pickEntries(damagedAssets.shadePipe, [0, 1, 2, 3, 4, 12, 19, 20, 21]);
    v.damaged.group0Shadow = pickEntries(damagedAssets.dmgShadowPipe, [0, 12, 19]);
    v.damaged.group1Surviving = device.createBindGroup({
      layout: damagedAssets.survivingPipe.getBindGroupLayout(1),
      entries: [{ binding: 2, resource: { buffer: v.damaged.hullUniform } }],
    });
    v.damaged.group1Shade = makeGroup1(damagedAssets.shadePipe, [
      { binding: 2, resource: { buffer: v.damaged.hullUniform } },
    ]);
  }

  function promoteDamagedBoat(v) {
    if (v.damaged || v.promoting || destroyed) return;
    v.promoting = true;
    const { arch } = v;
    const meshCopy = arch.vertices.slice();
    const sourceBuffer = device.createBuffer({
      label: `trade vessel damaged src ${v.route.id}`,
      size: meshCopy.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(sourceBuffer, 0, meshCopy);
    const posedBuffer = device.createBuffer({
      label: `trade vessel damaged posed ${v.route.id}`,
      size: arch.vertexCount * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const instBuffer = device.createBuffer({
      label: `trade vessel damaged inst ${v.route.id}`,
      size: TRADE_VESSEL_INSTANCE_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const hullUniform = device.createBuffer({
      label: `trade vessel hull damage ${v.route.id}`,
      size: HULL_DAMAGE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const hullData = new Float32Array(TV_HULL_FLOOD_WORDS);
    const craterData = new Float32Array(HULL_CRATER_LIMIT * 4);
    const poseUniform = device.createBuffer({
      label: `trade vessel pose uniform ${v.route.id}`,
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const dmgState = {
      ready: false,
      meshCopy,
      sourceBuffer,
      posedBuffer,
      instBuffer,
      instData: new Float32Array(TRADE_VESSEL_INSTANCE_FLOATS),
      hullUniform,
      hullData,
      craterData,
      craterRevision: -1,
      poseUniform,
      poseData: new Float32Array(4),
      poseBindGroup: null,
      fractureGPU: null,
      group0Surviving: null,
      group0Shade: null,
      group0Shadow: null,
      group1Surviving: null,
      group1Shade: null,
      needsRestCopy: true,
    };
    v.damaged = dmgState;

    const fractureCompute = computePipe || ((src, lbl) => device.createComputePipelineAsync({
      label: lbl,
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: src }), entryPoint: 'main' },
    }));

    Promise.all([
      ensureDamagedAssets(),
      createShipFractureGPU({ device, computePipe: fractureCompute, posedBuffer, fracture: arch.fracture }),
    ]).then(([assets, fractureGPU]) => {
      if (destroyed || !assets || !fractureGPU) return;
      dmgState.fractureGPU = fractureGPU;
      dmgState.poseBindGroup = device.createBindGroup({
        layout: assets.restPosePipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: sourceBuffer } },
          { binding: 1, resource: { buffer: posedBuffer } },
          { binding: 2, resource: { buffer: poseUniform } },
        ],
      });
      rebindDamagedVessel(v);
      dmgState.ready = true;
    }).catch((err) => {
      console.error('[trade-vessels promote]', err);
    });
  }

  if (oceanBridge?.oakTex) {
    Promise.resolve(oceanBridge.oakTex).then((tex) => {
      if (!tex || destroyed) return;
      oakView = tex.createView();
      intactGroup1 = makeGroup1(pipe);
      for (const v of vessels) {
        if (v.damaged && damagedAssets) rebindDamagedVessel(v);
      }
    }).catch(() => {});
  }

  let routes = [];
  let vessels = [];
  let boardDay = 0, daysPerSecond = 0, simElapsedSec = 0, hasSimClock = false;
  let worldOffsetX = 0, worldOffsetZ = 0;
  let lastUploadTime = -Infinity;
  let totalIntact = 0;
  let gpuSelectionEncoded = false;
  let dirtySyncFlag = false;
  let lastEnv = { windVec: [8, 0], storm: false, avoidVessels: null };
  const counts = new Uint32Array(TRADE_VESSEL_ARCHETYPES);
  const scratch = Array.from({ length: TRADE_VESSEL_ARCHETYPES }, () => new Float32Array(MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS));
  const allIntactScratch = new Float32Array(MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS);

  const compatibleArch = (a, b) => a === b || (a <= 1 && b <= 1) || ((a === 2 || a === 3) && (b === 2 || b === 3));

  function destroyVesselDamaged(v) {
    const d = v.damaged;
    if (!d) return;
    d.sourceBuffer?.destroy?.();
    d.posedBuffer?.destroy?.();
    d.instBuffer?.destroy?.();
    d.hullUniform?.destroy?.();
    d.poseUniform?.destroy?.();
    d.fractureGPU?.destroy?.();
    v.damaged = null;
  }

  function makeLiveVessel(route) {
    const aIdx = Math.max(0, Math.min(TRADE_VESSEL_ARCHETYPES - 1, route.archetype | 0));
    const arch = archGPUs[aIdx].arch;
    const scaleMul = route.scale || 1;
    const length = arch.length * scaleMul;
    const beam = arch.beam * scaleMul;
    const massTonnes = arch.modelId === 'lusoria' ? 7 : Math.max(25, length * beam * arch.draft * 0.42);
    const massKg = massTonnes * 1000;
    const wpArea = Math.max(4, length * beam * 0.72);
    const boat = {
      id: route.id,
      archetype: aIdx,
      modelId: arch.modelId,
      model: arch.model,
      collider: arch.collider,
      partAssembly: arch.partAssembly,
      fracture: arch.fracture,
      length,
      beam,
      draft: arch.draft,
      freeboard: arch.freeboard,
      mass: massKg,
      hydrodynamics: {
        mass: massKg,
        addedMass: massKg * 0.12,
        centreOfGravity: arch.draft * 0.48,
        sinkage: 0,
        pitchInertia: Math.max(1000, massKg * (length * length) / 14),
        rollInertia: Math.max(400, massKg * (beam * beam) / 10),
        draft: arch.draft,
        freeboard: arch.freeboard,
        waterplaneArea: wpArea,
      },
      x: 0,
      z: 0,
      heave: 0,
      yaw: 0,
      heading: 0,
      pitch: 0,
      roll: 0,
      sailFore: arch.index === 1 || arch.index === 3 || arch.index === 4 ? 0 : 1,
      sailMain: arch.index === 1 || arch.index === 3 || arch.index === 4 ? 0 : 1,
      sailMizzen: arch.index === 1 || arch.index === 3 || arch.index === 4 || arch.index === 6 ? 0 : 1,
      showProw: true,
      target: { heave: 0 },
      damage: null,
    };
    boat.damage = createVesselDamageState(boat);

    const s0 = sampleTradeVesselState(route, boardDay, daysPerSecond, simElapsedSec);
    const ai = createVesselAutopilotState(route, aIdx, s0, simElapsedSec);
    boat.x = ai.x;
    boat.z = ai.z;
    boat.heave = ai.y;
    boat.yaw = ai.yaw;
    boat.heading = (ai.yaw * 180) / Math.PI;
    return {
      route,
      arch,
      archIndex: aIdx,
      scaleMul,
      boat,
      ai,
      lastState: s0,
      lastPoseFurl: -1,
      promoting: false,
      damaged: null,
    };
  }

  const isVesselDamaged = (v) => Boolean(
    (v.boat.damage?.hits ?? 0) > 0
    || (v.boat.damage?.floodingTonnes ?? 0) > 0
    || v.boat.damage?.sunk
  );
  const isDeepSettledWreck = (v) => Boolean(
    v.boat.damage?.settledWreck && v.boat.heave < (v.boat.target?.heave ?? 0) - 12
  );

  function rebuildVesselsFromRoutes() {
    const prevById = new Map(vessels.map((v) => [v.route.id, v]));
    const kept = new Set();
    const nextVessels = routes.map((route) => {
      const prev = prevById.get(route.id);
      const aIdx = Math.max(0, Math.min(TRADE_VESSEL_ARCHETYPES - 1, route.archetype | 0));
      if (prev && compatibleArch(prev.archIndex, aIdx) && !kept.has(prev)) {
        kept.add(prev);
        if (!isVesselDamaged(prev)) {
          // Promote moored cog/carrack to rigged archetype on departure while keeping sailSet continuous so canvas unfurls smoothly.
          if (prev.archIndex !== aIdx && route.phase !== 'dock' && (prev.archIndex === 1 || prev.archIndex === 3)) {
            const upIdx = prev.archIndex === 1 ? 0 : 2;
            const nextArch = archGPUs[upIdx].arch;
            prev.archIndex = upIdx;
            prev.arch = nextArch;
            prev.boat.archetype = upIdx;
            prev.boat.model = nextArch.model;
            prev.boat.collider = nextArch.collider;
            prev.boat.partAssembly = nextArch.partAssembly;
            prev.boat.fracture = nextArch.fracture;
          }
          const prevPhase = prev.route.phase;
          const ai = prev.ai;
          if (prevPhase !== route.phase) {
            if (route.phase === 'dock') {
              ai.dockTarget = route.berth ? { ...route.berth } : (ai.dockTarget || route.portBerths?.[0] || null);
              if (ai.state !== 'docked' && ai.state !== 'docking') ai.state = 'approaching';
            } else if (route.phase === 'out') {
              ai.state = 'departing';
              ai.dirSign = -1;
            } else if (route.phase === 'in') {
              if (ai.state !== 'approaching' && ai.state !== 'docking' && ai.state !== 'waiting_berth') {
                ai.state = 'inbound';
                ai.dirSign = 1;
              }
            }
          } else if (route.phase === 'in' && ai.state === 'waiting_berth' && (route.waited || 0) === 0 && route.portBerths?.length) {
            ai.dockTarget = route.portBerths[0] ? { ...route.portBerths[0] } : ai.dockTarget;
            if (ai.dockTarget) ai.state = 'approaching';
          }
          if (route.berth) ai.dockTarget = { ...route.berth };
          prev.route = route;
          prev.scaleMul = route.scale || 1;
          prev.boat.length = prev.arch.length * prev.scaleMul;
          prev.boat.beam = prev.arch.beam * prev.scaleMul;
        }
        return prev;
      }
      return makeLiveVessel(route);
    });
    for (const oldV of vessels) {
      if (!kept.has(oldV) && isVesselDamaged(oldV) && !isDeepSettledWreck(oldV) && nextVessels.length < MAX_TRADE_VESSELS) {
        kept.add(oldV);
        nextVessels.push(oldV);
      }
    }
    for (const oldV of vessels) {
      if (!kept.has(oldV)) destroyVesselDamaged(oldV);
    }
    vessels = nextVessels;
    updateAllVessels(0, simElapsedSec, null, true, lastEnv);
  }

  function makeBedSampler(terrain) {
    if (terrain?.groundSample) return (wx, wz) => terrain.groundSample(wx, wz);
    if (lastContext?.heights && lastContext?.region) {
      const reg = lastContext.region.size ? lastContext.region : { ...lastContext.region, size: Math.round(Math.sqrt(lastContext.heights.length)) };
      const h = lastContext.heights;
      return (wx, wz) => terrainSurfaceSample(h, wx - worldOffsetX, wz - worldOffsetZ, reg);
    }
    return null;
  }

  function updateAllVessels(dt, elapsedSec, terrain = null, forceUpload = false, env = lastEnv) {
    if (!vessels.length) {
      counts.fill(0);
      totalIntact = 0;
      selectParamsCtrl[0] = 0;
      device.queue.writeBuffer(selectUniformBuffer, 0, selectParamsCtrl);
      gpuSelectionEncoded = false;
      return;
    }
    const off = terrain?.getWorldOffset?.();
    if (off && Number.isFinite(off.x) && Number.isFinite(off.z)) {
      worldOffsetX = off.x;
      worldOffsetZ = off.z;
    }

    const bedAt = makeBedSampler(terrain);
    const riverFlowAt = terrain?.inlandWaterAt ? (wx, wz) => terrain.inlandWaterAt(wx, wz) : null;
    const peerTargets = [];
    if (Array.isArray(env?.avoidVessels)) {
      for (const b of env.avoidVessels) if (b) peerTargets.push(b);
    }
    for (const u of vessels) peerTargets.push(u.boat);

    counts.fill(0);
    totalIntact = 0;
    const windVec = env?.windVec ?? [8, 0];
    const stormFlag = Boolean(env?.storm);

    for (const v of vessels) {
      const dmg = v.boat.damage;
      const ai = v.ai;
      if (dmg.sunk && ai.state !== 'sunk') {
        ai.state = 'sunk';
        dirtySyncFlag = true;
      }

      const rigFactor = dmg.hits > 0 ? Math.max(0.12, dmg.rigIntegrity ?? 1) : 1;
      const sinkFrac = Math.min(1, (dmg.floodingSinkage ?? 0) / Math.max(0.4, v.boat.freeboard));
      const stepDt = (dmg.sunk || v.boat.aground) ? 0 : dt;
      stepTradeVesselAutopilot(ai, v.route, v.archIndex, {
        dt: stepDt,
        elapsedSec,
        windVec,
        storm: stormFlag,
        daysPerSecond,
        worldOffsetX,
        worldOffsetZ,
        bedAt,
        riverFlowAt,
        avoidTargets: peerTargets,
        length: v.boat.length,
        draft: v.boat.draft,
      });
      if (dmg.hits > 0 || dmg.floodingTonnes > 0) {
        ai.speed *= rigFactor * Math.max(0.25, 1 - 0.65 * sinkFrac);
      }
      if (ai.dirtySync) {
        dirtySyncFlag = true;
        ai.dirtySync = false;
      }

      const wx = ai.x + worldOffsetX;
      const wz = ai.z + worldOffsetZ;
      let baseWaterY = ai.y;
      if (riverFlowAt) {
        const iw = riverFlowAt(wx, wz);
        if (iw && Number.isFinite(iw.wy)) {
          baseWaterY = iw.wy + (v.route.mode === 'sea' ? Math.sin(elapsedSec * 1.1 + ai.phaseRad) * 0.14 : Math.sin(elapsedSec * 1.8 + ai.phaseRad) * 0.03);
        }
      }
      v.boat.target.heave = baseWaterY;

      if (dmg.hits > 0 || dmg.floodingTonnes > 0 || dmg.sunk) {
        promoteDamagedBoat(v);
        if (dt > 0) {
          const relTerrain = terrain?.groundSample
            ? { height: (qx, qz) => terrain.groundSample(qx, qz) - baseWaterY }
            : null;
          stepVesselDamage(v.boat, dt, relTerrain);
        }
      }

      const sinkage = dmg.floodingSinkage ?? 0;
      const effY = baseWaterY - sinkage;
      const effPitch = ai.pitch + (dmg.floodingPitch ?? 0);
      const effRoll = ai.roll + (dmg.floodingRoll ?? 0);
      const headingDeg = (ai.yaw * 180) / Math.PI;
      v.boat.x = wx;
      v.boat.z = wz;
      v.boat.heave = effY;
      v.boat.yaw = ai.yaw;
      v.boat.heading = headingDeg;
      v.boat.pitch = effPitch;
      v.boat.roll = effRoll;

      const fixedFurledOrBarge = v.archIndex === 1 || v.archIndex === 3 || v.archIndex === 4;
      const furl = fixedFurledOrBarge ? 0 : Math.max(0, Math.min(1, 1 - (ai.sailSet ?? 1)));
      v.boat.sailFore = fixedFurledOrBarge ? 0 : ai.sailSet;
      v.boat.sailMain = fixedFurledOrBarge ? 0 : ai.sailSet;
      v.boat.sailMizzen = (fixedFurledOrBarge || v.archIndex === 6) ? 0 : ai.sailSet;

      const motion = dmg.sunk ? 0 : ai.motion * Math.max(0.15, dmg.hits > 0 ? (dmg.rigIntegrity ?? 1) : 1);
      const phaseAnim = ai.phaseRad + elapsedSec * 1.35;
      v.lastState = {
        x: ai.x,
        y: baseWaterY,
        z: ai.z,
        yaw: ai.yaw,
        heading: headingDeg,
        pitch: ai.pitch,
        roll: ai.roll,
        bowDir: [Math.sin(ai.yaw), -Math.cos(ai.yaw)],
        scale: v.scaleMul,
        phase: ai.phaseRad,
        archetype: v.archIndex,
        motion,
        speed: ai.speed,
        sailSet: ai.sailSet,
      };

      if (v.damaged?.ready && v.damaged.fractureGPU) {
        const d = v.damaged;
        const pending = dmg.pendingBakes;
        if (pending.length > 0) {
          const batch = pending.splice(0, 6);
          d.fractureGPU.apply(dmg, batch, elapsedSec, v.boat);
          const range = bakeVesselImpactMarks(d.meshCopy, batch, 9);
          if (range) {
            device.queue.writeBuffer(d.sourceBuffer, range.byteOffset, d.meshCopy.buffer, d.meshCopy.byteOffset + range.byteOffset, range.byteLength);
            d.needsRestCopy = true;
          }
        }
        if (d.fractureGPU.sync(dmg, v.boat)) d.needsRestCopy = true;
        d.fractureGPU.tick(dmg, elapsedSec, v.boat);
        if (v.archIndex === 4 && motion > 0.05) d.needsRestCopy = true;
        if (Math.abs(v.lastPoseFurl - furl) > 0.004) {
          v.lastPoseFurl = furl;
          d.needsRestCopy = true;
        }

        writeHullFloodUniform(d.hullData, v.boat);
        device.queue.writeBuffer(d.hullUniform, 0, d.hullData);
        const rev = dmg.cratersRevision ?? dmg.revision ?? 0;
        if (rev !== d.craterRevision) {
          d.craterRevision = rev;
          writeHullCraters(d.craterData, dmg.craters ?? []);
          device.queue.writeBuffer(d.hullUniform, TV_HULL_FLOOD_WORDS * 4, d.craterData);
        }

        d.poseData[0] = phaseAnim;
        d.poseData[1] = motion;
        d.poseData[2] = v.archIndex;
        d.poseData[3] = furl;
        device.queue.writeBuffer(d.poseUniform, 0, d.poseData);

        const inst = d.instData;
        inst[0] = ai.x; inst[1] = effY; inst[2] = ai.z; inst[3] = ai.yaw;
        inst[4] = effPitch; inst[5] = effRoll; inst[6] = v.scaleMul; inst[7] = v.archIndex;
        inst[8] = phaseAnim; inst[9] = motion; inst[10] = sinkage; inst[11] = furl;
        device.queue.writeBuffer(d.instBuffer, 0, inst);
        continue;
      }

      // Intact (or still compiling damaged pipeline) instance batch: upload both flat GPU select source and per-archetype fallback
      const a = v.archIndex;
      const idx = counts[a];
      if (idx < MAX_TRADE_VESSELS) {
        const dst = scratch[a];
        const offI = idx * TRADE_VESSEL_INSTANCE_FLOATS;
        dst[offI] = ai.x; dst[offI + 1] = effY; dst[offI + 2] = ai.z; dst[offI + 3] = ai.yaw;
        dst[offI + 4] = effPitch; dst[offI + 5] = effRoll; dst[offI + 6] = v.scaleMul; dst[offI + 7] = a;
        dst[offI + 8] = phaseAnim; dst[offI + 9] = motion; dst[offI + 10] = sinkage; dst[offI + 11] = furl;
        counts[a] = idx + 1;
      }
      if (totalIntact < MAX_TRADE_VESSELS) {
        const flatOff = totalIntact * TRADE_VESSEL_INSTANCE_FLOATS;
        allIntactScratch[flatOff] = ai.x; allIntactScratch[flatOff + 1] = effY; allIntactScratch[flatOff + 2] = ai.z; allIntactScratch[flatOff + 3] = ai.yaw;
        allIntactScratch[flatOff + 4] = effPitch; allIntactScratch[flatOff + 5] = effRoll; allIntactScratch[flatOff + 6] = v.scaleMul; allIntactScratch[flatOff + 7] = a;
        allIntactScratch[flatOff + 8] = phaseAnim; allIntactScratch[flatOff + 9] = motion; allIntactScratch[flatOff + 10] = sinkage; allIntactScratch[flatOff + 11] = furl;
        totalIntact++;
      }
    }

    if (forceUpload || Math.abs(elapsedSec - lastUploadTime) >= 1 / 65) {
      lastUploadTime = elapsedSec;
      selectParamsCtrl[0] = totalIntact;
      selectParamsCtrl[1] = MAX_CONT_TRIS;
      selectParamsCtrl[2] = samples;
      selectParamsCtrl[3] = MAX_TRADE_VESSELS;
      device.queue.writeBuffer(selectUniformBuffer, 0, selectParamsCtrl);
      if (totalIntact > 0) {
        device.queue.writeBuffer(srcInstancesBuffer, 0, allIntactScratch, 0, totalIntact * TRADE_VESSEL_INSTANCE_FLOATS);
      }
      gpuSelectionEncoded = false;
      for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
        if (counts[a] > 0) {
          device.queue.writeBuffer(instanceBuffers[a], 0, scratch[a], 0, counts[a] * TRADE_VESSEL_INSTANCE_FLOATS);
        }
      }
    }
  }

  return {
    get count() { return routes.length; },
    setTraffic(snapshot, origin, riverReaches = [], places = [], context = null) {
      if (context) lastContext = context;
      routes = buildTradeVesselRoutes(snapshot, origin, { riverReaches, places, ...(lastContext || {}) });
      lastUploadTime = -Infinity;
      if (Number.isFinite(snapshot?.day)) boardDay = snapshot.day;
      rebuildVesselsFromRoutes();
    },
    locate() {
      return vessels.map((v) => ({
        x: v.ai.x,
        y: v.ai.y,
        z: v.ai.z,
        yaw: v.ai.yaw,
        heading: (v.ai.yaw * 180) / Math.PI,
        pitch: v.ai.pitch,
        roll: v.ai.roll,
        bowDir: [Math.sin(v.ai.yaw), -Math.cos(v.ai.yaw)],
        scale: v.scaleMul,
        archetype: v.archIndex,
        speed: v.ai.speed,
        motion: v.ai.motion,
        sailSet: v.ai.sailSet,
        aiState: v.ai.state,
        tacking: v.ai.tacking,
        etaDays: v.ai.etaDays,
        id: v.route.id,
        mode: v.route.mode,
        phase: v.route.phase,
        phaseRad: v.ai.phaseRad,
      }));
    },
    consumeDirtySync() {
      const dirty = dirtySyncFlag;
      dirtySyncFlag = false;
      return dirty;
    },
    getMaritimeReport() {
      const ships = [];
      const caravans = [];
      for (const v of vessels) {
        const entry = {
          state: v.ai.state,
          progress: v.ai.progress,
          etaDays: v.ai.etaDays,
          heldByWeather: v.ai.heldByWeather,
          sunk: Boolean(v.boat.damage?.sunk),
        };
        if (v.route.shipId != null) {
          ships.push({ ...entry, id: v.route.shipId, berthIndex: v.route.bi ?? -1 });
        } else if (v.route.caravanKey != null) {
          caravans.push({ ...entry, key: v.route.caravanKey });
        }
      }
      const wv = lastEnv?.windVec ?? [8, 0];
      return {
        ...(boardDay > 0 ? { day: Math.floor(boardDay) } : {}),
        storm: Boolean(lastEnv?.storm),
        windSpeed: Math.hypot(wv[0] ?? 0, wv[1] ?? 0),
        ships,
        caravans,
      };
    },
    getTargetVessels() {
      const out = [];
      for (const v of vessels) {
        const dmg = v.boat.damage;
        if (dmg.settledWreck && v.boat.heave < (v.boat.target?.heave ?? 0) - 12) continue;
        out.push(v.boat);
      }
      return out;
    },
    getWorldFires() {
      const fires = [];
      for (const v of vessels) {
        const wf = v.boat.damage?.worldFires;
        if (wf?.length) {
          for (const f of wf) fires.push(f);
        }
      }
      return fires;
    },
    setBoardClock(day, rate, elapsedSec = NaN) {
      if (Number.isFinite(day)) boardDay = day;
      if (Number.isFinite(rate)) daysPerSecond = rate;
      if (Number.isFinite(elapsedSec)) { simElapsedSec = elapsedSec; hasSimClock = true; }
    },
    stepSimulation(dt, simTime, windOrEnv = 8, terrain = null) {
      if (Number.isFinite(simTime)) { simElapsedSec = simTime; hasSimClock = true; }
      if (typeof windOrEnv === 'number') {
        lastEnv = { windVec: [windOrEnv, 0], storm: windOrEnv >= 15, avoidVessels: null };
      } else if (windOrEnv && typeof windOrEnv === 'object') {
        const spd = windOrEnv.windSpeed ?? 8;
        const dir = windOrEnv.windDir ?? 0;
        const wv = Array.isArray(windOrEnv.windVec) ? windOrEnv.windVec : [Math.cos(dir) * spd, Math.sin(dir) * spd];
        lastEnv = {
          windVec: wv,
          storm: Boolean(windOrEnv.storm ?? spd >= 15),
          avoidVessels: windOrEnv.avoidVessels ?? null,
        };
      }
      updateAllVessels(dt, simElapsedSec, terrain, true, lastEnv);
    },
    rebind(nextResources) {
      resources = nextResources;
      bindGroup = pickEntries(pipe, [0, 1, 2, 3, 4, 12, 19, 20, 21]);
      shadowBindGroup = pickEntries(shadowPipe, [0, 12, 19]);
      if (selectPipe) selectBindGroup = makeSelectBindGroup(resources);
      if (continuumPipe) contGroup0 = pickEntries(continuumPipe, [0, 1, 2, 3, 4, 12]);
      if (splatPipe) splatGroup0 = pickEntries(splatPipe, [0, 1, 2, 3, 4]);
      for (const v of vessels) {
        if (v.damaged && damagedAssets) rebindDamagedVessel(v);
      }
    },
    encode(pass) {
      if (clearPipe && clearBindGroup) {
        pass.setPipeline(clearPipe);
        pass.setBindGroup(0, clearBindGroup);
        pass.dispatchWorkgroups(1);
        if (selectPipe && selectBindGroup && totalIntact > 0) {
          pass.setPipeline(selectPipe);
          pass.setBindGroup(0, selectBindGroup);
          pass.dispatchWorkgroups(Math.ceil(totalIntact / 64));
        }
        gpuSelectionEncoded = Boolean(selectPipe && continuumPipe && splatPipe);
      }
      if (!damagedAssets || !vessels.length) return;
      for (const v of vessels) {
        const d = v.damaged;
        if (!d?.ready || !d.fractureGPU || !d.poseBindGroup) continue;
        if (!d.needsRestCopy && !d.fractureGPU.active) continue;
        d.needsRestCopy = false;
        pass.setPipeline(damagedAssets.restPosePipe);
        pass.setBindGroup(0, d.poseBindGroup);
        pass.dispatchWorkgroups(Math.ceil(v.arch.vertexCount / 64));
        d.fractureGPU.encode(pass);
      }
    },
    draw(pass, elapsedSec = NaN) {
      const t = Number.isFinite(elapsedSec) ? elapsedSec : (hasSimClock ? simElapsedSec : performance.now() * 0.001);
      if (!hasSimClock || Number.isFinite(elapsedSec)) {
        updateAllVessels(0, t, null, false, lastEnv);
      }
      if (!pipe || !bindGroup) return;
      if (gpuSelectionEncoded && continuumPipe && splatPipe && typeof pass.drawIndexedIndirect === 'function' && typeof pass.drawIndirect === 'function') {
        pass.setPipeline(pipe);
        pass.setBindGroup(0, bindGroup);
        pass.setBindGroup(1, intactGroup1);
        for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
          const { vertexBuffer, indexBuffer } = archGPUs[a];
          pass.setVertexBuffer(0, vertexBuffer);
          pass.setVertexBuffer(1, nearOutBuffer, a * NEAR_SLICE_BYTES, NEAR_SLICE_BYTES);
          pass.setIndexBuffer(indexBuffer, 'uint32');
          pass.drawIndexedIndirect(indirectBuffer, a * 20);
        }
        pass.setPipeline(continuumPipe);
        pass.setBindGroup(0, contGroup0);
        pass.setBindGroup(1, contGroup1);
        pass.drawIndirect(indirectBuffer, 280);
        pass.setPipeline(splatPipe);
        pass.setBindGroup(0, splatGroup0);
        pass.setBindGroup(1, splatGroup1);
        pass.drawIndirect(indirectBuffer, 296);
        return;
      }
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bindGroup);
      pass.setBindGroup(1, intactGroup1);
      for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
        if (!counts[a]) continue;
        const { arch, vertexBuffer, indexBuffer } = archGPUs[a];
        pass.setVertexBuffer(0, vertexBuffer);
        pass.setVertexBuffer(1, instanceBuffers[a]);
        pass.setIndexBuffer(indexBuffer, 'uint32');
        pass.drawIndexed(arch.indexCount, counts[a]);
      }
    },
    drawDamaged(pass) {
      if (!damagedAssets || !vessels.length) return;
      for (const v of vessels) {
        const d = v.damaged;
        if (!d?.ready || !d.group0Surviving || !d.group0Shade) continue;
        const { arch, indexBuffer } = archGPUs[v.archIndex];
        pass.setIndexBuffer(indexBuffer, 'uint32');
        // Depth prepass: discard holed timber, parted rope, and ripped canvas
        pass.setPipeline(damagedAssets.survivingPipe);
        pass.setBindGroup(0, d.group0Surviving);
        pass.setBindGroup(1, d.group1Surviving);
        pass.setVertexBuffer(0, d.sourceBuffer);
        pass.setVertexBuffer(1, d.posedBuffer);
        pass.setVertexBuffer(2, d.instBuffer);
        pass.drawIndexed(arch.indexCount, 1);
        // Color shading pass (depthCompare: 'equal')
        pass.setPipeline(damagedAssets.shadePipe);
        pass.setBindGroup(0, d.group0Shade);
        pass.setBindGroup(1, d.group1Shade);
        pass.setVertexBuffer(0, d.sourceBuffer);
        pass.setVertexBuffer(1, d.posedBuffer);
        pass.setVertexBuffer(2, d.instBuffer);
        pass.drawIndexed(arch.indexCount, 1);
      }
    },
    drawShadow(pass) {
      if (shadowPipe && shadowBindGroup) {
        pass.setPipeline(shadowPipe);
        pass.setBindGroup(0, shadowBindGroup);
        if (gpuSelectionEncoded && typeof pass.drawIndexedIndirect === 'function') {
          for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
            const { vertexBuffer, indexBuffer } = archGPUs[a];
            pass.setVertexBuffer(0, vertexBuffer);
            pass.setVertexBuffer(1, nearOutBuffer, (7 + a) * NEAR_SLICE_BYTES, NEAR_SLICE_BYTES);
            pass.setIndexBuffer(indexBuffer, 'uint32');
            pass.drawIndexedIndirect(indirectBuffer, (7 + a) * 20);
          }
        } else {
          for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
            if (!counts[a]) continue;
            const { arch, vertexBuffer, indexBuffer } = archGPUs[a];
            pass.setVertexBuffer(0, vertexBuffer);
            pass.setVertexBuffer(1, instanceBuffers[a]);
            pass.setIndexBuffer(indexBuffer, 'uint32');
            pass.drawIndexed(arch.indexCount, counts[a]);
          }
        }
      }
      if (damagedAssets?.dmgShadowPipe) {
        pass.setPipeline(damagedAssets.dmgShadowPipe);
        for (const v of vessels) {
          const d = v.damaged;
          if (!d?.ready || !d.group0Shadow) continue;
          const { arch, indexBuffer } = archGPUs[v.archIndex];
          pass.setBindGroup(0, d.group0Shadow);
          pass.setVertexBuffer(0, d.sourceBuffer);
          pass.setVertexBuffer(1, d.posedBuffer);
          pass.setVertexBuffer(2, d.instBuffer);
          pass.setIndexBuffer(indexBuffer, 'uint32');
          pass.drawIndexed(arch.indexCount, 1);
        }
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const v of vessels) destroyVesselDamaged(v);
      for (const g of archGPUs) {
        g.vertexBuffer?.destroy?.();
        g.indexBuffer?.destroy?.();
      }
      for (const b of instanceBuffers) b?.destroy?.();
      for (const b of [
        selectUniformBuffer, stepMetaBuffer, contBaseIndicesBuffer, contStatesBuffer,
        contVertColsBuffer, srcInstancesBuffer, nearOutBuffer, contListBuffer, splatListBuffer, indirectBuffer,
      ]) b?.destroy?.();
      oakFallback.tex?.destroy?.();
      routes = [];
      vessels = [];
    },
  };
}
