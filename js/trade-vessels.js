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
    pts.push({ x, y, z, acc: total });
  }
  return pts.length >= 2 && total > 1 ? { pts, totalLen: total } : null;
}

function evalPolylineAt(pts, dist) {
  if (dist <= 0) {
    const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y, dz = pts[1].z - pts[0].z;
    const len2 = Math.hypot(dx, dz) || 1;
    return { x: pts[0].x, y: pts[0].y, z: pts[0].z, tx: dx / len2, ty: dy / len2, tz: dz / len2 };
  }
  const last = pts[pts.length - 1];
  if (dist >= last.acc) {
    const prev = pts[pts.length - 2];
    const dx = last.x - prev.x, dy = last.y - prev.y, dz = last.z - prev.z;
    const len2 = Math.hypot(dx, dz) || 1;
    return { x: last.x, y: last.y, z: last.z, tx: dx / len2, ty: dy / len2, tz: dz / len2 };
  }
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].acc >= dist) {
      const a = pts[i - 1], b = pts[i], span = Math.max(1e-4, b.acc - a.acc), u = (dist - a.acc) / span;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, len2 = Math.hypot(dx, dz) || 1;
      return {
        x: a.x + dx * u,
        y: a.y + dy * u,
        z: a.z + dz * u,
        tx: dx / len2,
        ty: dy / len2,
        tz: dz / len2,
      };
    }
  }
  return { x: last.x, y: last.y, z: last.z, tx: 0, ty: 0, tz: -1 };
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
    if (Array.isArray(r?.points)) return r.points.map(([wx, wz, hw, wy, thalweg]) => ({ wx, wz, hw, wy, thalweg }));
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
    if (sh.phase === 'dock' && sh.berth) {
      const safeB = nearestSafeWater(ox + sh.berth.x, oz + sh.berth.z, -2.6, 0, 420, carrack ? 22 : 16);
      routes.push({
        id: `ship:${sh.id}`, mode: 'sea', phase: 'dock',
        archetype: carrack ? 3 : 1,
        scale,
        depart: sh.t0 ?? 0, arrive: sh.t1 ?? 1,
        berth: { x: safeB.x, y: seaLevel, z: safeB.z, rot: sh.berth.rot || 0 },
        pts: poly?.pts ?? null, totalLen: poly?.totalLen ?? 0,
        phaseOffset: (hashU32(sh.id | 0, 17) % 1000) / 1000,
      });
      continue;
    }
    if (!poly) continue;
    routes.push({
      id: `ship:${sh.id}`, mode: 'sea', phase: sh.phase === 'out' ? 'out' : 'in',
      archetype: carrack ? 2 : 0,
      scale,
      depart: sh.t0 ?? 0, arrive: sh.t1 ?? 1,
      berth: null,
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
      id: `caravan:${c.key ?? c.index}`, mode: c.mode, phase: 'caravan',
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
      return { x: s.wx + nx * lat, z: s.wz + nz * lat, wy: s.wy };
    });
    let acc = 0;
    const linePts = pts.map((p, idx) => {
      if (idx > 0) acc += Math.hypot(p.x - pts[idx - 1].x, p.z - pts[idx - 1].z);
      return { x: p.x, y: p.wy, z: p.z, acc };
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

const REST_TO_POSED_WGSL = /* wgsl */ `
struct SourceVertex { px: f32, py: f32, pz: f32, nx: f32, ny: f32, nz: f32, mat: f32, u: f32, v: f32 };
struct PosedVertex { position: vec4f, normal: vec4f };
struct PoseUniform { phase: f32, motion: f32, archetype: f32, pad: f32 };

${buildBargeOarPivotsWGSL()}

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
  dstPosed[idx].position = vec4f(p, 0.0);
  dstPosed[idx].normal = vec4f(n, 0.0);
}
`;

export function tradeVesselsSource(damaged = false) {
  return FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + SHADOW_FRAME + VESSEL_LIGHTING + CANVAS_OPTICS + /* wgsl */ `
struct TradeNearDomain { domain: vec4f, grid: vec4f };

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
  ${damaged ? '@location(7) damage: f32,' : ''}
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

fn animateTradeOar(pos: vec3f, norm: vec3f, material: f32, instAnim: vec4f, archF: f32) -> array<vec3f, 2> {
  var p = pos;
  var n = norm;
  let matTone = vec2f(material, 0.0);
  let phase = instAnim.x;
  let motion = instAnim.y;
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
  return array<vec3f, 2>(p, n);
}

fn vesselWorldTransform(srcPos: vec3f, srcNorm: vec3f, material: f32, posYaw: vec4f, att: vec4f, anim: vec4f) -> array<vec3f, 3> {
  let aIdx = min(u32(${TRADE_VESSEL_ARCHETYPES - 1}), u32(max(0.0, round(att.w))));
  let sc4 = ARCHETYPE_SCALES[aIdx];
  let scaleMetres = vec3f(sc4.x * att.z, sc4.y, sc4.z * att.z);
  let animated = animateTradeOar(srcPos, srcNorm, material, anim, att.w);
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
  let tr = vesselWorldTransform(rawPos, rawNorm, v.material, v.instPosYaw, v.instAttitude, v.instAnim);
  ` : `
  let tr = vesselWorldTransform(rawPos, rawNorm, v.material, v.instPosYaw, v.instAttitude, v.instAnim);
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
  ${damaged ? 'o.damage = select(0.0, clamp(nLen - 1.0, 0.0, 1.5), nLen > 1.002);' : ''}
  return o;
}

@vertex fn tvShadowVS(v: TVVertexIn) -> @builtin(position) vec4f {
  ${damaged ? `
  let tr = vesselWorldTransform(v.posedPos, v.posedNorm, v.material, v.instPosYaw, v.instAttitude, v.instAnim);
  ` : `
  let tr = vesselWorldTransform(v.pos, v.norm, v.material, v.instPosYaw, v.instAttitude, v.instAnim);
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

@fragment fn tvFS(in: TVVertexOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
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
  return vec4f(surfaceAir(lit, in.world), 1.0);
}
`;
}

export const TRADE_VESSELS_WGSL = tradeVesselsSource(false);

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
    const module = await shader(TRADE_VESSELS_WGSL, 'trade vessels');
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

  const instanceBuffers = archGPUs.map((_, i) => device.createBuffer({
    label: `trade vessel instances ${i}`,
    size: MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  }));

  const oakFallback = createPlaceholderOak(device);
  let oakView = oakFallback.view;
  const oakSampler = oceanBridge?.oakSampler ?? oakFallback.sampler;

  const { pipe, shadowPipe } = await requestTradeVesselsPipelines({ device, shader, format, samples, shadowFormat });
  if (destroyed) {
    for (const g of archGPUs) { g.vertexBuffer.destroy(); g.indexBuffer.destroy(); }
    for (const b of instanceBuffers) b.destroy();
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
  const counts = new Uint32Array(TRADE_VESSEL_ARCHETYPES);
  const scratch = Array.from({ length: TRADE_VESSEL_ARCHETYPES }, () => new Float32Array(MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS));

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
    const signDir = route.phase === 'out' ? -1 : 1;
    const baseDist = route.phase === 'shuttle'
      ? (route.phaseOffset || 0) * Math.max(1, route.totalLen || 1)
      : s0.dist;
    return {
      route,
      arch,
      archIndex: aIdx,
      scaleMul,
      boat,
      travelDist: baseDist,
      dirSign: signDir,
      lastState: s0,
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
      if (prev && prev.archIndex === aIdx && !kept.has(prev)) {
        kept.add(prev);
        if (!isVesselDamaged(prev)) {
          if (prev.route.phase !== route.phase) {
            prev.dirSign = route.phase === 'out' ? -1 : 1;
            prev.travelDist = route.phase === 'shuttle'
              ? (route.phaseOffset || 0) * Math.max(1, route.totalLen || 1)
              : sampleTradeVesselState(route, boardDay, daysPerSecond, simElapsedSec).dist;
          }
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
    updateAllVessels(0, simElapsedSec, null, true);
  }

  function updateAllVessels(dt, elapsedSec, terrain = null, forceUpload = false) {
    if (!vessels.length) { counts.fill(0); return; }
    const off = terrain?.getWorldOffset?.();
    if (off && Number.isFinite(off.x) && Number.isFinite(off.z)) {
      worldOffsetX = off.x;
      worldOffsetZ = off.z;
    }

    counts.fill(0);
    for (const v of vessels) {
      const dmg = v.boat.damage;
      let s;
      if (v.route.phase === 'dock') {
        s = sampleTradeVesselState(v.route, boardDay, daysPerSecond, elapsedSec);
      } else {
        const base = sampleTradeVesselState(v.route, boardDay, daysPerSecond, elapsedSec, v.travelDist);
        const rigFactor = dmg.hits > 0 ? Math.max(0.12, dmg.rigIntegrity ?? 1) : 1;
        const sinkFrac = Math.min(1, (dmg.floodingSinkage ?? 0) / Math.max(0.4, v.boat.freeboard));
        const speedFactor = (dmg.sunk || v.boat.aground) ? 0 : rigFactor * Math.max(0.25, 1 - 0.65 * sinkFrac);
        if (dt > 0) v.travelDist += base.speed * speedFactor * v.dirSign * dt;
        s = sampleTradeVesselState(v.route, boardDay, daysPerSecond, elapsedSec, v.travelDist);
      }
      v.lastState = s;

      const wx = s.x + worldOffsetX;
      const wz = s.z + worldOffsetZ;
      let baseWaterY = s.y;
      if (terrain?.inlandWaterAt) {
        const iw = terrain.inlandWaterAt(wx, wz);
        if (iw && Number.isFinite(iw.wy)) {
          baseWaterY = iw.wy + (v.route.mode === 'sea' ? Math.sin(elapsedSec * 1.1 + s.phase) * 0.14 : Math.sin(elapsedSec * 1.8 + s.phase) * 0.03);
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
      const effPitch = s.pitch + (dmg.floodingPitch ?? 0);
      const effRoll = s.roll + (dmg.floodingRoll ?? 0);
      v.boat.x = wx;
      v.boat.z = wz;
      v.boat.heave = effY;
      v.boat.yaw = s.yaw;
      v.boat.heading = s.heading;
      v.boat.pitch = effPitch;
      v.boat.roll = effRoll;

      const rigScale = dmg.hits > 0 ? Math.max(0.15, dmg.rigIntegrity ?? 1) : 1;
      const motion = dmg.sunk ? 0 : s.motion * rigScale;

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

        writeHullFloodUniform(d.hullData, v.boat);
        device.queue.writeBuffer(d.hullUniform, 0, d.hullData);
        const rev = dmg.cratersRevision ?? dmg.revision ?? 0;
        if (rev !== d.craterRevision) {
          d.craterRevision = rev;
          writeHullCraters(d.craterData, dmg.craters ?? []);
          device.queue.writeBuffer(d.hullUniform, TV_HULL_FLOOD_WORDS * 4, d.craterData);
        }

        d.poseData[0] = s.phase;
        d.poseData[1] = motion;
        d.poseData[2] = v.archIndex;
        d.poseData[3] = 0;
        device.queue.writeBuffer(d.poseUniform, 0, d.poseData);

        const inst = d.instData;
        inst[0] = s.x; inst[1] = effY; inst[2] = s.z; inst[3] = s.yaw;
        inst[4] = effPitch; inst[5] = effRoll; inst[6] = s.scale; inst[7] = v.archIndex;
        inst[8] = s.phase; inst[9] = motion; inst[10] = sinkage; inst[11] = 0;
        device.queue.writeBuffer(d.instBuffer, 0, inst);
        continue;
      }

      // Intact (or still compiling damaged pipeline) instance batch
      const a = v.archIndex;
      const idx = counts[a];
      if (idx >= MAX_TRADE_VESSELS) continue;
      const dst = scratch[a];
      const offI = idx * TRADE_VESSEL_INSTANCE_FLOATS;
      dst[offI] = s.x; dst[offI + 1] = effY; dst[offI + 2] = s.z; dst[offI + 3] = s.yaw;
      dst[offI + 4] = effPitch; dst[offI + 5] = effRoll; dst[offI + 6] = s.scale; dst[offI + 7] = a;
      dst[offI + 8] = s.phase; dst[offI + 9] = motion; dst[offI + 10] = sinkage; dst[offI + 11] = 0;
      counts[a] = idx + 1;
    }

    if (forceUpload || Math.abs(elapsedSec - lastUploadTime) >= 1 / 65) {
      lastUploadTime = elapsedSec;
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
    locate(elapsedSec = NaN) {
      const t = Number.isFinite(elapsedSec) ? elapsedSec : (hasSimClock ? simElapsedSec : performance.now() * 0.001);
      return vessels.map((v) => {
        const s = sampleTradeVesselState(v.route, boardDay, daysPerSecond, t, v.route.phase === 'dock' ? null : v.travelDist);
        return {
          ...s,
          id: v.route.id,
          mode: v.route.mode,
          phase: v.route.phase,
          phaseRad: s.phase,
        };
      });
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
    stepSimulation(dt, simTime, _windSpeed = 8, terrain = null) {
      if (Number.isFinite(simTime)) { simElapsedSec = simTime; hasSimClock = true; }
      updateAllVessels(dt, simElapsedSec, terrain, true);
    },
    rebind(nextResources) {
      resources = nextResources;
      bindGroup = pickEntries(pipe, [0, 1, 2, 3, 4, 12, 19, 20, 21]);
      shadowBindGroup = pickEntries(shadowPipe, [0, 12, 19]);
      for (const v of vessels) {
        if (v.damaged && damagedAssets) rebindDamagedVessel(v);
      }
    },
    encode(pass) {
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
        updateAllVessels(0, t, null, false);
      }
      if (!pipe || !bindGroup) return;
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
        for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
          if (!counts[a]) continue;
          const { arch, vertexBuffer, indexBuffer } = archGPUs[a];
          pass.setVertexBuffer(0, vertexBuffer);
          pass.setVertexBuffer(1, instanceBuffers[a]);
          pass.setIndexBuffer(indexBuffer, 'uint32');
          pass.drawIndexed(arch.indexCount, counts[a]);
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
      oakFallback.tex?.destroy?.();
      routes = [];
      vessels = [];
    },
  };
}
