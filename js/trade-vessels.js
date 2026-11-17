// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Ocean-going merchant ships (cogs, carracks, caravels, harbor barques) and inland river trade barges
// built from the canonical boat-part system (ship-mesh, ship-part-taxonomy, part-assembly, ship-fracture,
// ship-collider) with real oak/canvas PBR optics and full cannon destructibility.
import { FRAME_WGSL, ATMO_CORE_WGSL, CASCADES, HULL_HOLE_LIMIT, HULL_CRATER_LIMIT } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { SHADOW_FRAME } from './wgsl/shadows.js';
import { VESSEL_LIGHTING, CANVAS_OPTICS } from './wgsl/vessel.js';
import { CONTINUUM_SPLAT_PIXELS, CONTINUUM_MIN_PIXELS, CONTINUUM_CORE_WGSL, continuumCoarsening } from './continuum-core.js';
import { SURFACE_WAVE_SAMPLE } from './wgsl/surface-waves.js';
import { SHIP_FRACTURE_POSE_UPDATE } from './wgsl/ship-fracture.js';
import { CREW_JOINT_BLEND_WGSL } from './wgsl/crew.js';
import { CREW_JOINT_COUNT } from './crew-skeleton.js';
import { terrainSurfaceSample } from './terrain-model.js';
import { createShipAssetCache } from './ship-mesh.js';
import { getShipModel } from './ship-models.js';
import { rowingDesign, rowingDeck, rowingHullDeck, rowingHullWidth } from './models/rowing.js';
import { boatHydrodynamics } from './boat.js';
import { createWaterOptics } from './water-optics.js';
import { computeArchetypeScaleSpec } from './ship-part-taxonomy.js';
import { createPartAssemblyCatalog, bakeVesselImpactMarks } from './part-assembly.js';
import { prepareShipFracture, createShipFractureGPU } from './ship-fracture.js';
import { createShipCollider } from './ship-collider.js';
import { createVesselDamageState, stepVesselDamage } from './gunnery-control.js';
import { HULL_DAMAGE_UNIFORM_BYTES, writeHullFloodUniform, writeHullCraters } from './hull-flood.js';
import { addHullHole, stepHullHoles } from './hull-holes.js';
import { POSED_VERTEX_LAYOUT } from './vessel-pose.js';
import { attachCrewComponents, ensureCrewComponentPacks, packCrewCompMask, packCrewFaceW } from './crew-components.js';
import { colonialGroomMask, reconcileColonialGroomAndComp } from './crew.js';
import { DRESS_MASK_SCALE } from './indigenous-dress.js';
import { createDistantCrewLOD } from './crew-lod.js';
import { bakeTownClips, bakeWorkStationClip } from './town-clips.js';
import { poseSeatedCrew, solveCrewLimb, turnBone } from './crew-pose.js';
import { poseCrewFingers } from './crew-physics.js';
import { sharedNeuralPbrBank } from './neural-pbr.js';
import { withNeuralPbrTradeVessels } from './wgsl/neural-pbr.js';

export const TRADE_VESSEL_VERTEX_FLOATS = 9; // pos(3), norm(3), material(1), uv(2)
export const TRADE_VESSEL_INSTANCE_FLOATS = 12; // posYaw(4), attitudeScaleArch(4), animSink(4)
export const TRADE_VESSEL_ARCHETYPES = 7; // 0: cog sail, 1: cog moored, 2: carrack sail, 3: carrack moored, 4: river barge, 5: lateen caravel, 6: harbor barque
export const MAX_TRADE_VESSELS = 84;
export const MAX_DECK_STATIONS_PER_VESSEL = 10;
export const DECK_CREW_TIERS = 4;
export const DECK_CREW_CROSSFADE_HI_PX = 10.0;
export const DECK_CREW_SPLAT_PIXELS = 4.0;
// Deck-crew splats thin below the continuum's own limit (continuumThin in js/continuum-core.js).
export const DECK_CREW_MIN_PIXELS = CONTINUUM_MIN_PIXELS;

export const VESSEL_CONTINUUM_BAND = 0.25;
// The vessel cut's pixel error at the scene's base error; the cut and the near band below scale with
// continuumCoarsening(), so they follow the scene's one pixel-error scalar (AGENTS.md rule 3, item 5).
export const VESSEL_ERROR_PIXELS = 1.5;
// Projected ship span, in pixels at the base error, over which the full part-built ship hands off to its continuum.
export const VESSEL_NEAR_HI_PIXELS = 38.0;
export const VESSEL_NEAR_LO_PIXELS = 27.0;
export const VESSEL_SPLAT_PIXELS = CONTINUUM_SPLAT_PIXELS;
export const VESSEL_MIN_PIXELS = CONTINUUM_MIN_PIXELS;

const TV_HULL_FLOOD_WORDS = 4 * (2 + 2 * HULL_HOLE_LIMIT);
const BARGE_Y_LIFT = 0.0;
const BARGE_FLOOR_LIFT_METRES = 0.26;
const BARGE_BENCH_LIFT_METRES = 0.19;
const BARGE_CRUTCH_LIFT_METRES = 0.255;
const BARGE_PIVOT_AFT_SHIFT_M = 0.21;
const BARGE_INBOARD_LEVER_METRES = 0.88;
const BARGE_OAR_SLOPE_M = -0.37;
const BARGE_SEAT_INBOARD_FROM_PIVOT_M = 0.72;

const ARCHETYPE_SPECS = Object.freeze([
  Object.freeze({ index: 0, label: 'Underway Cog', modelId: 'pinta', length: 18.6, beam: 5.7, furlSails: false, unmasted: false, addCargo: false }),
  Object.freeze({ index: 1, label: 'Anchored Cog', modelId: 'pinta', length: 18.6, beam: 5.7, furlSails: true, unmasted: false, addCargo: false }),
  Object.freeze({ index: 2, label: 'Underway Carrack', modelId: 'santa-maria', length: 23.6, beam: 7.9, furlSails: false, unmasted: false, addCargo: false }),
  Object.freeze({ index: 3, label: 'Anchored Carrack', modelId: 'santa-maria', length: 23.6, beam: 7.9, furlSails: true, unmasted: false, addCargo: false }),
  Object.freeze({ index: 4, label: 'River Trade Barge', modelId: 'lusoria', length: 13.0, beam: 3.0, furlSails: true, unmasted: true, addCargo: true }),
  Object.freeze({ index: 5, label: 'Lateen Caravel', modelId: 'nina', length: 16.2, beam: 4.9, furlSails: false, unmasted: false, addCargo: false }),
  Object.freeze({ index: 6, label: 'Harbor Barque', modelId: 'nina', length: 10.6, beam: 3.3, furlSails: false, unmasted: false, addCargo: false }),
]);

function effectiveTaxonomyLength(spec, model) {
  if (spec.modelId === 'pinta' && !spec.unmasted) {
    return Math.max(spec.length, (model?.runtime?.length || 25.908) * 0.80);
  }
  return spec.length;
}

let sharedAssetCache = null;
const archetypeCache = new Array(TRADE_VESSEL_ARCHETYPES).fill(null);

function archetypeDesignScale(spec, model) {
  const frame = model?.designFrame ?? { length: 12, beam: 3.6, verticalScale: 1 };
  const rtLen = model?.runtime?.length || spec.length || 12;
  const rtBeam = model?.runtime?.beam || spec.beam || 3.6;
  const hullYRatio = Math.max(0.56, Math.min(1.08, Math.sqrt((spec.length / rtLen) * (spec.beam / rtBeam))));
  return [
    spec.beam / (frame.beam || 3.6),
    (frame.verticalScale || 1) * hullYRatio,
    spec.length / (frame.length || 12),
  ];
}

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
  const n0 = na ?? [nx, ny, nz];
  const n1 = nb ?? [nx, ny, nz];
  const n2 = nc ?? [nx, ny, nz];
  const planarUV = (pt) => {
    const ax = Math.abs(n0[0]), ay = Math.abs(n0[1]), az = Math.abs(n0[2]);
    if (ay >= ax && ay >= az) return [pt[0] * 0.96, pt[2] * 0.36];
    if (az >= ax) return [pt[1] * 0.96, pt[0] * 0.36];
    return [pt[1] * 0.96, pt[2] * 0.36];
  };
  const uv0 = uvs?.[0] ?? planarUV(a);
  const uv1 = uvs?.[1] ?? planarUV(b);
  const uv2 = uvs?.[2] ?? planarUV(c);
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

// Appends a tapered horizontal or vertical cylindrical drum/bundle between p0 and p1 in design space (indexed rings for compact GPU vertex count).
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
  const rings = bulgeProfile > 0 ? 4 : 1;
  const circumScale = Math.max(0.18, 2 * Math.PI * Math.max(rMid, rEnd) * 0.96);
  const axialScale = Math.max(0.12, len * 0.42);
  const baseV = Math.floor(verts.length / 9);
  const ringPts = [];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const rad = rEnd + (rMid - rEnd) * Math.sin(t * Math.PI);
    const cx = p0[0] + dx * t, cy = p0[1] + dy * t, cz = p0[2] + dz * t;
    const pts = [];
    for (let s = 0; s <= sides; s++) {
      const ang = ((s % sides) / sides) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const rx = ca * rad * radialScale[0];
      const ry = sa * rad * radialScale[1];
      const px = cx + ux * rx + vx * ry;
      const py = cy + uy * rx + vy * ry;
      const pz = cz + uz * rx + vz * ry;
      let nx = ux * (ca / Math.max(0.05, radialScale[0])) + vx * (sa / Math.max(0.05, radialScale[1]));
      let ny = uy * (ca / Math.max(0.05, radialScale[0])) + vy * (sa / Math.max(0.05, radialScale[1]));
      let nz = uz * (ca / Math.max(0.05, radialScale[0])) + vz * (sa / Math.max(0.05, radialScale[1]));
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      verts.push(px, py, pz, nx, ny, nz, matId, (s / sides) * circumScale, t * axialScale);
      if (s < sides) pts.push([px, py, pz]);
    }
    ringPts.push(pts);
  }
  const stride = sides + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const i00 = baseV + r * stride + s;
      const i10 = baseV + (r + 1) * stride + s;
      const i11 = i10 + 1;
      const i01 = i00 + 1;
      inds.push(i00, i10, i11, i00, i11, i01);
    }
  }
  // End caps
  for (const [endIdx, sign] of [[0, -1], [rings, 1]]) {
    const center = endIdx === 0 ? p0 : p1;
    const pts = ringPts[endIdx];
    const cIdx = Math.floor(verts.length / 9);
    const nCap = [ax[0] * sign, ax[1] * sign, ax[2] * sign];
    verts.push(center[0], center[1], center[2], nCap[0], nCap[1], nCap[2], matId, 0.5, 0.5);
    const rimStart = Math.floor(verts.length / 9);
    for (let s = 0; s < sides; s++) {
      const pt = pts[s];
      verts.push(pt[0], pt[1], pt[2], nCap[0], nCap[1], nCap[2], matId, 0.5, 0.5);
    }
    for (let s = 0; s < sides; s++) {
      const ns = (s + 1) % sides;
      if (endIdx === 0) inds.push(cIdx, rimStart + ns, rimStart + s);
      else inds.push(cIdx, rimStart + s, rimStart + ns);
    }
  }
}

function appendFurledSailBundle(verts, inds, minP, maxP, matCanvas = 9, matRope = 12, mastHead = null) {
  const sx = maxP[0] - minP[0], sy = maxP[1] - minP[1], sz = maxP[2] - minP[2];
  const span = Math.hypot(sx, sy, sz);
  if (span < 0.25) return;
  const rDrop = Math.min(0.155, span * 0.048);
  // Hang compactly beneath the yard centerline with a stout midships bunt.
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
  appendTaperedCylinder(verts, inds, p0, p1, rDrop * 1.24, rDrop * 0.42, 10, matCanvas, 1);
  // Secondary tucked fold underneath for cloth depth
  appendTaperedCylinder(verts, inds, [p0[0] + sx * 0.12, p0[1] - rDrop * 0.28, p0[2] + sz * 0.12],
    [p1[0] - sx * 0.12, p1[1] - rDrop * 0.28, p1[2] - sz * 0.12], rDrop * 0.72, rDrop * 0.28, 8, matCanvas, 1);
  // Tightly wound rope gasket lashings along the yard
  for (const frac of [0.10, 0.24, 0.38, 0.5, 0.62, 0.76, 0.90]) {
    const gx0 = p0[0] + (p1[0] - p0[0]) * (frac - 0.014);
    const gy0 = p0[1] + (p1[1] - p0[1]) * (frac - 0.014);
    const gz0 = p0[2] + (p1[2] - p0[2]) * (frac - 0.014);
    const gx1 = p0[0] + (p1[0] - p0[0]) * (frac + 0.014);
    const gy1 = p0[1] + (p1[1] - p0[1]) * (frac + 0.014);
    const gz1 = p0[2] + (p1[2] - p0[2]) * (frac + 0.014);
    const bandR = rDrop * (0.48 + 0.78 * Math.sin(frac * Math.PI));
    appendTaperedCylinder(verts, inds, [gx0, gy0, gz0], [gx1, gy1, gz1], bandR, bandR, 8, matRope, 0);
  }
  // Keep standing yard lifts supporting braced yardarms when moored.
  if (mastHead) {
    for (const endP of [p0, p1]) {
      if (Math.hypot(mastHead[0] - endP[0], mastHead[1] - endP[1], mastHead[2] - endP[2]) > 0.4) {
        appendTaperedCylinder(verts, inds, mastHead, endP, 0.012, 0.012, 5, matRope, 0);
      }
    }
  }
}

function appendRoundedBox9(verts, inds, cx, cy, cz, hx, hy, hz, matId, bulge = 0.06, includeBottom = true) {
  const b = (s) => 1 + bulge * (1 - Math.abs(s));
  const corners = [
    [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
    [cx + hx * b(0), cy + hy, cz + hz * b(0)], [cx - hx * b(0), cy + hy, cz + hz * b(0)],
  ];
  const [c0, c1, c2, c3, c4, c5, c6, c7] = corners;
  const ux = Math.max(0.08, hx * 2 * 0.96), uy = Math.max(0.08, hy * 2 * 0.96), uz = Math.max(0.08, hz * 2 * 0.42);
  const boxUV = (su, sv) => [[0, 0], [su, 0], [su, sv], [0, sv]];
  pushQuad9(verts, inds, c4, c5, c6, c7, matId, boxUV(uy, ux)); // +z
  pushQuad9(verts, inds, c1, c0, c3, c2, matId, boxUV(uy, ux)); // -z
  pushQuad9(verts, inds, c5, c1, c2, c6, matId, boxUV(uy, uz)); // +x
  pushQuad9(verts, inds, c0, c4, c7, c3, matId, boxUV(uy, uz)); // -x
  pushQuad9(verts, inds, c7, c6, c2, c3, matId, boxUV(ux, uz)); // +y
  if (includeBottom) {
    pushQuad9(verts, inds, c0, c1, c5, c4, matId, boxUV(ux, uz)); // -y
  }
}

function appendLusoriaCargo(verts, inds, groups, modelId = 'lusoria', designScale = [0.833333, 1.319496, 1.083333]) {
  const d = rowingDesign(modelId);
  const sxBase = d.runtime.beam / d.frame.beam;
  const floorLiftDesign = BARGE_FLOOR_LIFT_METRES / (designScale[1] || 1);
  const dunnageClearDesign = 0.015 / (designScale[1] || 1);
  const crutchLiftDesign = BARGE_CRUTCH_LIFT_METRES / (designScale[1] || 1);
  const raisedDeckAt = (z) => rowingDeck(modelId, z) + floorLiftDesign;
  const hullInnerHalfW = (z, y, margin = 0.014) => Math.max(0.0, rowingHullWidth(modelId, z, y) - d.shellThicknessMetres / sxBase - margin);
  const nextGroup = (id, nodeId, fn) => {
    const startIdx = inds.length;
    fn();
    if (inds.length > startIdx) {
      groups.push({ id, nodeId, firstVertex: startIdx, vertexCount: inds.length - startIdx });
    }
  };
  // Watertight tarred oak bilge ceiling pan beneath floorboards + raised timber fore/aft cuddy decks capping bow & stern bays
  nextGroup('hull.sole.ceiling', 'hull', () => {
    const zStops = [-4.76, -3.60, -2.40, -1.20, 0.0, 1.20, 2.40, 3.60, 4.76];
    for (let s = 0; s + 1 < zStops.length; s++) {
      const z0 = zStops[s], z1 = zStops[s + 1];
      const y0 = raisedDeckAt(z0) - 0.022;
      const y1 = raisedDeckAt(z1) - 0.022;
      const w0 = hullInnerHalfW(z0, y0, 0.016);
      const w1 = hullInnerHalfW(z1, y1, 0.016);
      if (w0 < 0.02 && w1 < 0.02) continue;
      pushQuad9(verts, inds, [-w0, y0, z0], [w0, y0, z0], [w1, y1, z1], [-w1, y1, z1], 14, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
  });
  for (const [endTag, zStops, bulkZ, bulkN] of [
    ['fore', [-5.88, -5.56, -5.22, -4.92, -4.68], -4.68, 1],
    ['aft', [4.68, 4.92, 5.22, 5.56, 5.88], 4.68, -1],
  ]) {
    nextGroup(`hull.cuddy.${endTag}`, 'hull', () => {
      for (let s = 0; s + 1 < zStops.length; s++) {
        const z0 = zStops[s], z1 = zStops[s + 1];
        const y0 = raisedDeckAt(z0) + 0.018;
        const y1 = raisedDeckAt(z1) + 0.018;
        const w0 = hullInnerHalfW(z0, y0, 0.014);
        const w1 = hullInnerHalfW(z1, y1, 0.014);
        if (w0 < 0.012 && w1 < 0.012) continue;
        pushQuad9(verts, inds, [-w0, y0, z0], [w0, y0, z0], [w1, y1, z1], [-w1, y1, z1], 0, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      }
      const yTop = raisedDeckAt(bulkZ) + 0.018;
      const yBot = rowingDeck(modelId, bulkZ) - 0.02;
      const wTop = hullInnerHalfW(bulkZ, yTop, 0.014);
      const wBot = hullInnerHalfW(bulkZ, yBot, 0.018);
      if (wTop > 0.04) {
        if (bulkN > 0) {
          pushQuad9(verts, inds, [-wBot, yBot, bulkZ], [wBot, yBot, bulkZ], [wTop, yTop, bulkZ], [-wTop, yTop, bulkZ], 1);
        } else {
          pushQuad9(verts, inds, [wBot, yBot, bulkZ], [-wBot, yBot, bulkZ], [-wTop, yTop, bulkZ], [wTop, yTop, bulkZ], 1);
        }
      }
    });
  }
  // Structural oak coamings, fender rub-strakes, gunwale oarlock chocks (escalameiras), mooring bitts & raised dunnage
  for (const [side, tag] of [[-1, 'port'], [1, 'starboard']]) {
    nextGroup(`hull.coaming.${tag}`, 'hull', () => {
      for (let k = 0; k < 6; k++) {
        const z0 = -2.95 + k * 0.98;
        const z1 = z0 + 0.98;
        const w0 = Math.max(0.32, rowingHullWidth(modelId, z0, rowingHullDeck(modelId, z0)) - 0.16);
        const w1 = Math.max(0.32, rowingHullWidth(modelId, z1, rowingHullDeck(modelId, z1)) - 0.16);
        const y0 = rowingHullDeck(modelId, z0) + 0.032;
        const y1 = rowingHullDeck(modelId, z1) + 0.032;
        appendTaperedCylinder(verts, inds, [side * w0, y0, z0], [side * w1, y1, z1], 0.026, 0.024, 6, 17, 0);
      }
    });
    nextGroup(`hull.rubrail.${tag}`, 'hull', () => {
      for (let k = 0; k < 8; k++) {
        const z0 = -4.2 + k * 1.05;
        const z1 = z0 + 1.05;
        const y0 = rowingHullDeck(modelId, z0) - 0.065;
        const y1 = rowingHullDeck(modelId, z1) - 0.065;
        const w0 = Math.max(0.18, rowingHullWidth(modelId, z0, y0) + 0.014);
        const w1 = Math.max(0.18, rowingHullWidth(modelId, z1, y1) + 0.014);
        appendTaperedCylinder(verts, inds, [side * w0, y0, z0], [side * w1, y1, z1], 0.022, 0.020, 6, 16, 0);
      }
    });
    for (const [zBitt, endTag] of [[-4.35, 'fore'], [4.82, 'aft']]) {
      nextGroup(`hull.bitt.${endTag}.${tag}`, 'hull', () => {
        const yb = raisedDeckAt(zBitt) + 0.012 / (designScale[1] || 1);
        const xb = side * Math.max(0.16, rowingHullWidth(modelId, zBitt, yb) * 0.52);
        appendRoundedBox9(verts, inds, xb, yb + 0.12, zBitt, 0.034, 0.12, 0.034, 1, 0.02, false);
        appendTaperedCylinder(verts, inds, [xb - 0.065, yb + 0.19, zBitt], [xb + 0.065, yb + 0.19, zBitt], 0.018, 0.018, 6, 3, 0);
      });
    }
  }
  // Carved oak gunwale rowlock blocks (escalameiras) & twin hardwood tholepins for the 4 active sweep pairs
  for (const st of d.stations) {
    const pairIdx = st.index >> 1;
    if (!ACTIVE_BARGE_OAR_PAIRS.has(pairIdx)) continue;
    const side = st.side;
    const pz = st.pivot[2] + BARGE_PIVOT_AFT_SHIFT_M / (designScale[2] || 1);
    const railY = rowingHullDeck(modelId, pz);
    const px = side * rowingHullWidth(modelId, pz, railY);
    const pivY = railY + 0.065 / d.frame.verticalScale + crutchLiftDesign;
    const midY = (railY - 0.03 + (pivY - 0.028)) * 0.5;
    const halfH = Math.max(0.04, (pivY - 0.028 - (railY - 0.03)) * 0.5);
    const sideName = side < 0 ? 'port' : 'starboard';
    const pairTag = String(pairIdx + 1).padStart(2, '0');
    nextGroup(`hull.oarlock.${sideName}.${pairTag}`, 'hull', () => {
      appendRoundedBox9(verts, inds, px - side * 0.028, midY, pz, 0.048, halfH, 0.095, 1, 0.02, false);
      for (const zSign of [-1, 1]) {
        appendTaperedCylinder(
          verts, inds,
          [px, pivY - 0.045, pz + zSign * 0.052],
          [px, pivY + 0.075, pz + zSign * 0.052],
          0.014, 0.012, 6, 17, 0,
        );
      }
    });
  }
  // Raised oak dunnage battens strictly in the 3 open hold bays between benches #2, #5, #8, #11 (zero -y bottom face)
  const dunnageHalfH = 0.016;
  for (const [dTag, z0, z1] of [['fore', -2.30, -1.30], ['mid', -0.42, 0.56], ['aft', 1.38, 2.34]]) {
    nextGroup(`deck.dunnage.${dTag}`, 'deck.main', () => {
      const zm = (z0 + z1) * 0.5;
      const ym = raisedDeckAt(zm) + dunnageClearDesign + dunnageHalfH;
      for (const bx of [-0.24, 0.0, 0.24]) {
        appendRoundedBox9(verts, inds, bx, ym, zm, 0.030, dunnageHalfH, (z1 - z0) * 0.5, 1, 0, false);
      }
    });
  }
  const cargoBaseAt = (z) => raisedDeckAt(z) + dunnageClearDesign + dunnageHalfH * 2;
  // 1. Staved oak wine & olive oil casks with iron hoops (fore hold bay, |x*ds0| <= 0.30 m)
  nextGroup('cargo.casks', 'deck.main', () => {
    const caskSpots = [
      [-0.21, -2.02, 0.005], [0.21, -2.02, 0.005],
      [-0.21, -1.52, 0.005], [0.21, -1.52, 0.005],
      [0.0, -1.78, 0.215],
    ];
    for (const [cx, cz, liftY] of caskSpots) {
      const halfL = 0.23, rMid = 0.132, rEnd = 0.104;
      const yc = cargoBaseAt(cz) + rMid + liftY;
      appendTaperedCylinder(verts, inds, [cx, yc, cz - halfL], [cx, yc, cz + halfL], rMid, rEnd, 10, 1, 1);
      for (const hOff of [-0.15, 0.15]) {
        appendTaperedCylinder(
          verts, inds,
          [cx, yc, cz + hOff - 0.020], [cx, yc, cz + hOff + 0.020],
          rMid * 0.96, rMid * 0.96, 10, 3, 0,
        );
      }
    }
  });
  // 2. Corded cloth & raw-wool merchant bales with hemp lashings (midships hold bay, |x*ds0| <= 0.36 m)
  nextGroup('cargo.bales', 'deck.main', () => {
    const baleSpots = [
      [-0.20, 0.04, 0.20, 0.15, 0.22, 0.0],
      [0.20, 0.06, 0.20, 0.15, 0.22, 0.0],
      [0.0, 0.34, 0.24, 0.15, 0.20, 0.0],
      [0.0, 0.16, 0.19, 0.13, 0.20, 0.29],
    ];
    for (const [bx, bz, hx, hy, hz, liftY] of baleSpots) {
      const cy = cargoBaseAt(bz) + hy + liftY;
      appendRoundedBox9(verts, inds, bx, cy, bz, hx, hy, hz, 9, 0.08, false);
      for (const lOff of [-hz * 0.45, hz * 0.45]) {
        appendTaperedCylinder(verts, inds, [bx - hx * 1.03, cy, bz + lOff], [bx + hx * 1.03, cy, bz + lOff], 0.018, 0.018, 6, 12, 0, [1, hy / hx]);
      }
    }
  });
  // 3. Stacked plump grain sacks (aft hold bay, |x*ds0| <= 0.35 m)
  nextGroup('cargo.sacks', 'deck.main', () => {
    const sackSpots = [
      [-0.22, 1.64, 0.005], [0.0, 1.66, 0.005], [0.22, 1.64, 0.005],
      [-0.12, 1.88, 0.165], [0.13, 1.86, 0.165],
    ];
    for (const [sx, sz, liftY] of sackSpots) {
      const cy = cargoBaseAt(sz) + 0.095 + liftY;
      appendTaperedCylinder(verts, inds, [sx, cy, sz - 0.19], [sx, cy, sz + 0.19], 0.125, 0.068, 8, 13, 1, [1.15, 0.85]);
      appendTaperedCylinder(verts, inds, [sx, cy, sz + 0.15], [sx, cy, sz + 0.20], 0.048, 0.048, 6, 12, 0);
    }
  });
  // 4. Pine merchant crates, olive-oil amphorae & coiled hemp mooring hawsers (clear of all 4 benches & crew)
  nextGroup('cargo.crates.fore', 'deck.main', () => {
    for (const [cx, cz] of [[-0.17, -3.92], [0.17, -3.88]]) {
      const yd = raisedDeckAt(cz) + 0.015 / (designScale[1] || 1) + 0.10;
      appendRoundedBox9(verts, inds, cx, yd, cz, 0.14, 0.10, 0.17, 1, 0.02, false);
    }
  });
  nextGroup('cargo.crates.aft', 'deck.main', () => {
    for (const [cx, cz] of [[-0.17, 2.16], [0.17, 2.18]]) {
      const yd = cargoBaseAt(cz) + 0.095;
      appendRoundedBox9(verts, inds, cx, yd, cz, 0.14, 0.095, 0.16, 1, 0.02, false);
    }
  });
  nextGroup('cargo.amphorae', 'deck.main', () => {
    for (const [ax, az] of [[-0.15, -0.32], [0.0, -0.34], [0.15, -0.31]]) {
      const yd = cargoBaseAt(az);
      appendTaperedCylinder(verts, inds, [ax, yd + 0.01, az], [ax, yd + 0.27, az], 0.080, 0.036, 8, 24, 1);
    }
  });
  for (const [cTag, cz] of [['fore', -4.22], ['aft', 3.18]]) {
    nextGroup(`cargo.coil.${cTag}`, 'deck.main', () => {
      const yd = raisedDeckAt(cz) + 0.025;
      appendTaperedCylinder(verts, inds, [0, yd + 0.004, cz], [0, yd + 0.046, cz], 0.13, 0.11, 10, 12, 0);
    });
  }
}

function probeDeckPlankY(verts, targetX, targetZ, radX, radZ, fallbackY, maxY = Infinity) {
  let best = -Infinity;
  for (const mul of [1, 1.85]) {
    const rx = radX * mul, rz = radZ * mul;
    for (let i = 0; i < verts.length; i += 9) {
      if (Math.floor(verts[i + 6]) !== 0) continue;
      if (verts[i + 4] < 0.72) continue;
      const x = verts[i], y = verts[i + 1], z = verts[i + 2];
      if (y > maxY) continue;
      if (Math.abs(x - targetX) <= rx && Math.abs(z - targetZ) <= rz && y > best) {
        best = y;
      }
    }
    if (Number.isFinite(best)) return best;
  }
  return fallbackY;
}

function appendDeckStowedCargo9(verts, inds, origin, designScale, countScale = 1) {
  const invX = 1 / (designScale[0] || 1);
  const invY = 1 / (designScale[1] || 1);
  const invZ = 1 / (designScale[2] || 1);
  const [ox, oy, oz] = origin;
  // Hooped oak wine/spice casks (matId 1 staves + matId 3 wrought-iron hoops)
  const rMid = 0.21, halfL = 0.32;
  const caskOffsets = countScale >= 2
    ? [[-0.22, 0, -0.22], [0.22, 0, -0.20], [0.0, rMid * 1.72, -0.21]]
    : [[-0.16, 0, -0.18]];
  for (const [lx, ly, lz] of caskOffsets) {
    const cx = ox + lx * invX;
    const cy = oy + (rMid + ly) * invY;
    const cz = oz + lz * invZ;
    appendTaperedCylinder(verts, inds, [cx, cy, cz - halfL * invZ], [cx, cy, cz + halfL * invZ], rMid * invX, rMid * 0.82 * invX, 9, 1, 1, [1, (rMid * invY) / Math.max(1e-4, rMid * invX)]);
    for (const hOff of [-0.19, 0.19]) {
      appendTaperedCylinder(
        verts, inds,
        [cx, cy, cz + (hOff - 0.022) * invZ], [cx, cy, cz + (hOff + 0.022) * invZ],
        rMid * 0.97 * invX, rMid * 0.97 * invX, 9, 3, 0,
        [1, (rMid * invY) / Math.max(1e-4, rMid * invX)],
      );
    }
  }
  // Corded linen/wool merchant bale (matId 23 burlap + matId 12 hemp rope lashings — immune to sail furl)
  const bx = ox + 0.04 * invX;
  const by = oy + 0.20 * invY;
  const bz = oz + 0.28 * invZ;
  const hx = 0.28 * invX, hy = 0.20 * invY, hz = 0.24 * invZ;
  appendRoundedBox9(verts, inds, bx, by, bz, hx, hy, hz, 23, 0.08);
  for (const lOff of [-hz * 0.45, hz * 0.45]) {
    appendTaperedCylinder(verts, inds, [bx - hx * 1.03, by, bz + lOff], [bx + hx * 1.03, by, bz + lOff], 0.022 * invX, 0.022 * invX, 6, 12, 0);
  }
}

const ACTIVE_BARGE_OAR_PAIRS = new Set([1, 4, 7, 10]);

// Appends only physical stowed waist casks/bales (no duplicate steering oars/tillers on lusoria or nina).
function appendDeckFixtures(verts, inds, groups, spec, scaleSpec, model) {
  if (spec.index === 4 && spec.modelId === 'lusoria') {
    return;
  }
  const designScale = archetypeDesignScale(spec, model);
  const addGroup = (id, nodeId, fn) => {
    const startIdx = inds.length;
    fn();
    if (inds.length > startIdx) {
      groups.push({ id, nodeId, firstVertex: startIdx, vertexCount: inds.length - startIdx });
    }
  };

  let waistDeckY = 0.72, bestWaistY = -Infinity;
  for (let i = 0; i < verts.length; i += 9) {
    if (Math.floor(verts[i + 6]) !== 0 || verts[i + 4] < 0.72) continue;
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (Math.abs(x) < 1.05 && z > -2.2 && z < 1.1 && y < 1.16 && y > bestWaistY) {
      bestWaistY = y;
      waistDeckY = y;
    }
  }
  const isLarge = spec.index === 2 || spec.index === 3;
  const isMedium = spec.index === 0 || spec.index === 1;
  const isCaravel = spec.index === 5;
  const isBarque = spec.index === 6;
  const waistMaxY = waistDeckY + 0.30;

  const cargoX = isBarque ? -0.24 : isCaravel ? 0.20 : 0.22;
  const cargoZ = isBarque ? -0.35 : isCaravel ? 0.42 : -1.72;
  const cargoY = probeDeckPlankY(verts, cargoX, cargoZ, 0.55, 0.65, waistDeckY, waistMaxY);
  addGroup('cargo.deck', 'hull', () => {
    appendDeckStowedCargo9(verts, inds, [cargoX, cargoY, cargoZ], designScale, isLarge || isMedium ? 2 : 1);
  });
}

// Pure deck-crew station metadata (zero mesh triangles) driving both GPU-skinned crew-skeleton humans and locate() inspection.
export function buildTradeDeckStations(verts, spec, scaleSpec, model) {
  const designScale = archetypeDesignScale(spec, model);
  const deckStations = [];
  const recordStation = (station, role, poseKind, originDesign, yaw, oarPhaseOffset = 0, extra = null) => {
    const x = originDesign[0] * designScale[0];
    const y = originDesign[1] * designScale[1];
    const z = originDesign[2] * designScale[2];
    deckStations.push(Object.freeze({
      station,
      role,
      poseKind,
      x,
      y,
      z,
      yaw,
      oarPhaseOffset,
      localMetres: Object.freeze([x, y, z]),
      ...(extra || {}),
    }));
  };

  if (spec.modelId === 'taino-canoe') {
    for (let i = 0; i < 4; i++) {
      const zDes = -1.6 + i * 1.1;
      recordStation(`crew:${i}`, 'paddler', 'paddle', [i % 2 === 0 ? -0.16 : 0.16, 0.18, zDes], Math.PI, i * 0.28);
    }
    return deckStations;
  }

  if (spec.index === 4 && spec.modelId === 'lusoria') {
    const d = rowingDesign('lusoria');
    const pivots = bargeOarPivotsForWGSL();
    const floorLiftDesign = BARGE_FLOOR_LIFT_METRES / (designScale[1] || 1);
    const benchLiftDesign = BARGE_BENCH_LIFT_METRES / (designScale[1] || 1);
    const helmZ = warpSectionZ(4.42, scaleSpec.waistWarpK);
    const helmY = rowingDeck('lusoria', 4.42) + floorLiftDesign + BARGE_Y_LIFT;
    recordStation('pilot', 'pilot', 'helm', [0.24, helmY, helmZ], Math.PI - 0.16, 0);

    const factorRawZ = -3.36;
    const factorZ = warpSectionZ(factorRawZ, scaleSpec.waistWarpK);
    const factorY = rowingDeck('lusoria', factorRawZ) + floorLiftDesign + BARGE_Y_LIFT;
    recordStation('merchant', 'merchant', 'merchant', [0.0, factorY, factorZ], 0.14, 0);

    let oarIdx = 0;
    for (const st of d.stations) {
      const pairIdx = st.index >> 1;
      if (!ACTIVE_BARGE_OAR_PAIRS.has(pairIdx)) continue;
      if (deckStations.length >= MAX_DECK_STATIONS_PER_VESSEL) break;
      const stIdx = st.index | 0;
      const px = pivots[stIdx * 4 + 0];
      const side = pivots[stIdx * 4 + 3] || st.side;
      // Seat each oarsman squarely atop his physical wooden thwart plank facing straight aft (+Z, yaw === 0).
      const sx = px - side * (BARGE_SEAT_INBOARD_FROM_PIVOT_M / designScale[0]);
      const sz = warpSectionZ(st.seat[2], scaleSpec.waistWarpK);
      const soleY = rowingDeck('lusoria', st.seat[2]) + floorLiftDesign + BARGE_Y_LIFT;
      const benchTopY = st.seat[1] + benchLiftDesign + BARGE_Y_LIFT;
      const seatHeightMetres = Math.max(0.22, (benchTopY - soleY) * designScale[1]);
      recordStation(`crew:${oarIdx}`, 'oarsman', 'row', [sx, soleY, sz], 0, pairIdx * 0.16, {
        oarSide: side,
        oarStationIdx: stIdx,
        seatHeightMetres,
      });
      oarIdx++;
    }
    return deckStations;
  }

  let sternDeckY = 1.15, bestSternY = -Infinity, deckMaxZ = 3.2;
  let foreDeckY = 0.95, bestForeY = -Infinity, foreZ = -2.3;
  let waistDeckY = 0.72, bestWaistY = -Infinity;
  for (let i = 0; i < verts.length; i += 9) {
    if (Math.floor(verts[i + 6]) !== 0 || verts[i + 4] < 0.72) continue;
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (Math.abs(x) < 0.75 && z > 1.8 && z < 4.35 && y > bestSternY) {
      bestSternY = y;
      sternDeckY = y;
      deckMaxZ = z;
    }
    if (Math.abs(x) < 0.6 && z < -1.0 && z > -4.6 && y > bestForeY) {
      bestForeY = y;
      foreDeckY = y;
      foreZ = Math.max(-4.35, Math.min(-2.1, z + 0.35));
    }
    if (Math.abs(x) < 1.05 && z > -2.2 && z < 1.1 && y < 1.16 && y > bestWaistY) {
      bestWaistY = y;
      waistDeckY = y;
    }
  }
  const isLarge = spec.index === 2 || spec.index === 3;
  const isMedium = spec.index === 0 || spec.index === 1;
  const isCaravel = spec.index === 5;
  const isBarque = spec.index === 6;
  const waistMaxY = waistDeckY + 0.30;
  const sternMaxY = sternDeckY + 0.25;
  const helmZ = Math.min(4.2, Math.max(2.4, deckMaxZ - 0.35));
  const helmX = -0.22;

  if (isBarque) {
    const captOrig = [helmX, probeDeckPlankY(verts, helmX, helmZ, 0.45, 0.55, sternDeckY, sternMaxY), helmZ];
    recordStation('captain', 'captain', 'helm', captOrig, Math.PI - 0.14, 0);
  } else {
    const captX = 0.34;
    const captZ = Math.max(2.35, Math.min(3.35, helmZ - 0.55));
    const captY = probeDeckPlankY(verts, captX, captZ, 0.5, 0.6, sternDeckY, sternMaxY);
    recordStation('captain', 'captain', 'brace', [captX, captY, captZ], 2.82, 0);

    const helmY = probeDeckPlankY(verts, helmX, helmZ, 0.45, 0.55, sternDeckY, sternMaxY);
    recordStation('crew:0', 'pilot', 'helm', [helmX, helmY, helmZ], Math.PI - 0.12, 0);
  }

  const merchX = isBarque ? 0.28 : isCaravel ? 0.38 : 0.44;
  const merchZ = isBarque ? 0.45 : isCaravel ? 1.12 : -1.04;
  const merchY = probeDeckPlankY(verts, merchX, merchZ, 0.55, 0.65, waistDeckY, waistMaxY);
  recordStation('merchant', 'merchant', 'merchant', [merchX, merchY, merchZ], 2.35, 0);

  const lookX = 0.22;
  const lookY = probeDeckPlankY(verts, lookX, foreZ, 0.5, 0.6, foreDeckY, foreDeckY + 0.30);
  recordStation(isBarque ? 'crew:0' : 'crew:1', 'crew', 'idle', [lookX, lookY, foreZ], Math.PI - 0.08, 0);

  if (isMedium || isLarge) {
    const bosunX = -0.46, bosunZ = -2.15;
    const bosunY = probeDeckPlankY(verts, bosunX, bosunZ, 0.55, 0.65, waistDeckY, waistMaxY);
    recordStation('crew:2', 'crew', 'brace', [bosunX, bosunY, bosunZ], 0.78, 0);
  }

  if (isLarge) {
    const aftWaistX = -0.62, aftWaistZ = 0.72;
    const aftWaistY = probeDeckPlankY(verts, aftWaistX, aftWaistZ, 0.55, 0.65, waistDeckY, waistMaxY);
    recordStation('crew:3', 'crew', 'brace', [aftWaistX, aftWaistY, aftWaistZ], 2.55, 0);

    const poopHandX = -0.48, poopHandZ = Math.min(4.1, helmZ + 0.28);
    const poopHandY = probeDeckPlankY(verts, poopHandX, poopHandZ, 0.5, 0.55, sternDeckY, sternMaxY);
    recordStation('crew:4', 'crew', 'idle', [poopHandX, poopHandY, poopHandZ], Math.PI - 0.25, 0);
  }
  return deckStations;
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
  const s4 = ARCHETYPE_SPECS[4];
  const model4 = getShipModel(s4.modelId);
  const ds4 = archetypeDesignScale(s4, model4);
  const crutchLiftDesign = BARGE_CRUTCH_LIFT_METRES / (ds4[1] || 1);
  for (const s of d.stations) {
    const idx = s.index | 0;
    if (idx < 0 || idx >= 24) continue;
    const rawPz = s.pivot[2] + BARGE_PIVOT_AFT_SHIFT_M / (ds4[2] || 1);
    const railY = rowingHullDeck('lusoria', rawPz);
    const px = s.side * rowingHullWidth('lusoria', rawPz, railY);
    const pz = warpSectionZ(rawPz, scaleSpec.waistWarpK);
    pivots[idx * 4 + 0] = px;
    pivots[idx * 4 + 1] = railY + 0.065 / d.frame.verticalScale + crutchLiftDesign + BARGE_Y_LIFT;
    pivots[idx * 4 + 2] = pz;
    pivots[idx * 4 + 3] = s.side;
  }
  return pivots;
}

let cachedBargeOarPivots = null;
export function bargeOarPivotsForWGSL() {
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
  let sumArea = 0;
  let meanR = 0, meanG = 0, meanB = 0;
  let minY = Infinity, maxY = -Infinity;
  let minZHull = Infinity, maxZHull = -Infinity;
  for (let i = 0; i < vertCountAll; i++) {
    const o = i * 9;
    const x = vertices[o] * sx;
    const y = vertices[o + 1] * sy;
    const z = vertices[o + 2] * sz;
    const mat = Math.floor(vertices[o + 6]);
    const col = tradeMaterialLinearColor(vertices[o + 6]);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (mat !== 9 && mat !== 13 && mat !== 10 && y <= beam * 0.9 + 2.2) {
      if (z < minZHull) minZHull = z;
      if (z > maxZHull) maxZHull = z;
    }
    const w = (mat === 9 || mat === 13) ? 1.8 : 1.0;
    sumArea += w;
    meanR += col[0] * w;
    meanG += col[1] * w;
    meanB += col[2] * w;
  }
  if (!Number.isFinite(minY)) minY = -beam * 0.25;
  if (!Number.isFinite(maxY)) maxY = maxAirDraftMetres;
  if (!Number.isFinite(minZHull) || maxZHull - minZHull < 1.0) {
    minZHull = -length * 0.5;
    maxZHull = length * 0.5;
  }
  const invW = 1 / Math.max(1e-4, sumArea);
  const meanColour = [meanR * invW, meanG * invW, meanB * invW];

  // Sample longitudinal profile slabs [0..N_RINGS-1] from real scaled geometry so every ship
  // keeps pointed bow, tapered transom, sheer/castles, and crisp sail-fin / mast silhouettes.
  const N_RINGS = 6;
  const zSpan = Math.max(2.0, maxZHull - minZHull);
  const hullBins = Array.from({ length: N_RINGS }, () => ({
    maxX: 0, minY: 0, maxDeckY: 0.4, hullColR: 0, hullColG: 0, hullColB: 0, hullN: 0,
    deckColR: 0, deckColG: 0, deckColB: 0, deckN: 0,
    sailMaxX: 0, sailMaxY: -Infinity, sailMinY: Infinity, sailN: 0,
    sailColR: 0, sailColG: 0, sailColB: 0,
    mastMaxY: -Infinity, mastN: 0,
  }));
  const hullTopCut = Math.max(1.8, beam * 0.85);
  for (let i = 0; i < vertCountAll; i++) {
    const o = i * 9;
    const x = vertices[o] * sx;
    const y = vertices[o + 1] * sy;
    const z = vertices[o + 2] * sz;
    const mat = Math.floor(vertices[o + 6]);
    const col = tradeMaterialLinearColor(vertices[o + 6]);
    const bin = Math.max(0, Math.min(N_RINGS - 1, Math.floor(((z - minZHull) / zSpan) * N_RINGS)));
    const b = hullBins[bin];
    if (mat === 9 || mat === 13) {
      b.sailMaxX = Math.max(b.sailMaxX, Math.abs(x));
      if (y > b.sailMaxY) b.sailMaxY = y;
      if (y < b.sailMinY) b.sailMinY = y;
      b.sailColR += col[0]; b.sailColG += col[1]; b.sailColB += col[2];
      b.sailN++;
    } else if (mat === 10) {
      if (y > b.mastMaxY) b.mastMaxY = y;
      b.mastN++;
    } else {
      if (Math.abs(x) > b.maxX && y <= hullTopCut && !(spec.index === 4 && mat === 16)) b.maxX = Math.abs(x);
      if (y < b.minY) b.minY = y;
      if (y <= hullTopCut && y > b.maxDeckY) b.maxDeckY = y;
      if (y < 0.9) {
        b.hullColR += col[0]; b.hullColG += col[1]; b.hullColB += col[2]; b.hullN++;
      } else {
        b.deckColR += col[0]; b.deckColG += col[1]; b.deckColB += col[2]; b.deckN++;
      }
    }
  }

  // Single connected closed genus-0 articulated ship cross-section:
  // Bow apex -> N_RINGS x K=6 contour rings [keel, stbd sheer, stbd upper/sail, ridge/peak, port upper/sail, port sheer] -> Stern apex.
  // V = 2 + 6*6 = 38 vertices, F = 6 + 5*12 + 6 = 72 tris, E = 108 edges -> V - E + F = 2.
  const K = 6;
  const initPos = [];
  const vertColors = new Float32Array((2 + N_RINGS * K) * 3);
  const vertSailMask = new Float32Array(2 + N_RINGS * K);
  const setVertColor = (vi, col, isSail = 0) => {
    vertColors[vi * 3 + 0] = Math.min(1, col[0]);
    vertColors[vi * 3 + 1] = Math.min(1, col[1]);
    vertColors[vi * 3 + 2] = Math.min(1, col[2]);
    vertSailMask[vi] = isSail;
  };

  const bFirst = hullBins[0];
  const bLast = hullBins[N_RINGS - 1];
  const bowY = Math.max(0.15, (bFirst.minY + bFirst.maxDeckY) * 0.55);
  const sternY = Math.max(0.35, (bLast.minY + bLast.maxDeckY) * 0.55);
  initPos.push([0, bowY, minZHull - 0.12]);
  setVertColor(0, [0.24, 0.16, 0.10], 0);

  for (let r = 0; r < N_RINGS; r++) {
    const b = hullBins[r];
    const u = (r + 0.5) / N_RINGS;
    const zR = minZHull + u * zSpan;
    const taper = Math.sin(Math.pow(u, 0.85) * Math.PI);
    const halfB = Math.max(0.28, b.maxX > 0.1 ? b.maxX : beam * 0.48 * Math.max(0.35, taper));
    const keelY = Math.min(-0.22, b.minY < -0.1 ? b.minY * 0.85 : -Math.max(0.32, beam * 0.22));
    const deckY = Math.max(0.45, b.maxDeckY);
    const sheerY = Math.max(0.18, deckY * 0.82);

    const hCol = b.hullN > 0 ? [b.hullColR / b.hullN, b.hullColG / b.hullN, b.hullColB / b.hullN] : [0.25, 0.17, 0.11];
    const dCol = b.deckN > 0 ? [b.deckColR / b.deckN, b.deckColG / b.deckN, b.deckColB / b.deckN] : [0.33, 0.24, 0.15];
    const sCol = b.sailN > 0 ? [b.sailColR / b.sailN, b.sailColG / b.sailN, b.sailColB / b.sailN] : [0.80, 0.74, 0.61];

    const hasSail = !spec.furlSails && !spec.unmasted && b.sailN > 0 && b.sailMaxY > deckY + 1.0;
    const hasBareMast = spec.furlSails && !spec.unmasted && b.mastN > 0 && b.mastMaxY > deckY + 1.2;

    let shX, shY, peakY, topCol, topMask;
    if (hasSail) {
      shX = Math.max(0.32, Math.min(beam * 1.45, b.sailMaxX > 0.2 ? b.sailMaxX * 0.92 : beam * 0.55));
      const sailMid = Number.isFinite(b.sailMinY) ? (b.sailMinY * 0.45 + b.sailMaxY * 0.55) : (deckY + (b.sailMaxY - deckY) * 0.5);
      shY = Math.max(sheerY + 0.35, sailMid);
      peakY = Math.max(shY + 0.45, b.sailMaxY * 0.96);
      topCol = sCol;
      topMask = 1.0;
    } else if (hasBareMast) {
      shX = Math.max(0.22, halfB * 0.32);
      shY = deckY + 0.30;
      peakY = Math.max(deckY + 0.85, b.mastMaxY * 0.92);
      topCol = [0.40, 0.30, 0.20];
      topMask = 0.0;
    } else {
      shX = Math.max(0.20, halfB * 0.45);
      shY = deckY + 0.12;
      peakY = deckY + 0.28;
      topCol = dCol;
      topMask = 0.0;
    }

    const baseV = initPos.length;
    initPos.push([0, keelY, zR]);        // 0: keel bottom
    initPos.push([+halfB, sheerY, zR]);  // 1: starboard sheer
    initPos.push([+shX, shY, zR]);       // 2: starboard yard/shoulder
    initPos.push([0, peakY, zR]);        // 3: dorsal sail/castle/mast apex
    initPos.push([-shX, shY, zR]);       // 4: port yard/shoulder
    initPos.push([-halfB, sheerY, zR]);  // 5: port sheer

    setVertColor(baseV + 0, [0.06, 0.05, 0.04], 0);
    setVertColor(baseV + 1, hCol, 0);
    setVertColor(baseV + 2, topCol, topMask);
    setVertColor(baseV + 3, topCol, topMask);
    setVertColor(baseV + 4, topCol, topMask);
    setVertColor(baseV + 5, hCol, 0);
  }

  const topIdx = initPos.length;
  initPos.push([0, sternY, maxZHull + 0.05]);
  setVertColor(topIdx, [0.26, 0.18, 0.11], 0);
  const V = initPos.length;

  const cx = 0;
  const cy = Math.max(0.25, (minY + maxY) * 0.42);
  const cz = 0;

  // CCW outward closed winding (Euler characteristic V - E + F = 2)
  const rawTris = [];
  for (let s = 0; s < K; s++) {
    const n = (s + 1) % K;
    rawTris.push([0, 1 + n, 1 + s]);
  }
  for (let r = 0; r < N_RINGS - 1; r++) {
    const r0 = 1 + r * K, r1 = 1 + (r + 1) * K;
    for (let s = 0; s < K; s++) {
      const n = (s + 1) % K;
      rawTris.push([r0 + s, r0 + n, r1 + n]);
      rawTris.push([r0 + s, r1 + n, r1 + s]);
    }
  }
  const sternRing = 1 + (N_RINGS - 1) * K;
  for (let s = 0; s < K; s++) {
    const n = (s + 1) % K;
    rawTris.push([sternRing + s, sternRing + n, topIdx]);
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
  let prevErr = 0.05;
  let stepIdx = 0;
  const MAX_COLLAPSE_STEPS = 56;

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
    const minDot = aliveTris > 18 ? 0.05 : -0.35;
    for (const [key, shared] of edgeTris.entries()) {
      if (shared.length !== 2) continue;
      const sep = key.indexOf(':');
      const u = Number(key.slice(0, sep));
      const v = Number(key.slice(sep + 1));
      if (!vertAlive[u] || !vertAlive[v]) continue;
      let commonCount = 0;
      for (const n of adjVerts[u]) {
        if (adjVerts[v].has(n)) commonCount++;
      }
      if (commonCount !== 2) continue;

      const pu = curPos[u], pv = curPos[v];
      const mid = [(pu[0] + pv[0]) * 0.5, (pu[1] + pv[1]) * 0.5, (pu[2] + pv[2]) * 0.5];
      const edgeLen = Math.hypot(pu[0] - pv[0], pu[1] - pv[1], pu[2] - pv[2]);
      const seamPenalty = vertSailMask[u] !== vertSailMask[v] ? 1.85 : 1.0;
      const cost = edgeLen * seamPenalty;
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
        if (l1 < 1e-5 || (n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1 + 1e-8) < minDot) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      if (cost < bestCost) {
        bestCost = cost;
        bestEdge = { u, v, mid, shared, edgeLen };
      }
    }

    if (!bestEdge) break;
    const { u, v, mid, shared, edgeLen } = bestEdge;
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
    const scale = Math.max(1.0, Math.min(1.12, Math.cbrt(vol0 / Math.max(stats.vol, 1e-4))));
    const nextErr = Math.max(prevErr + 0.035, edgeLen * 0.45);
    prevErr = nextErr;
    stepErrorsList.push(nextErr);
    stepScalesList.push(scale);
    statePositions.push(stats.outPos);
    stateNormals.push(stats.outNorm);
    stepIdx++;
  }

  // Keep true angular <=6-triangle ship core (zero spherical balloon projection).
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

  const totalStates = statePositions.length;
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

  const rxSplat = Math.max(0.9, beam * 0.54);
  const rySplat = Math.max(0.7, (maxY - minY) * 0.46);
  const rzSplat = Math.max(1.8, length * 0.52);
  const radius = Math.max(length * 0.54, maxAirDraftMetres * 0.54, Math.hypot(beam * 0.5, length * 0.5));
  // Start continuum only beyond full-rig silhouette span (~38 px -> 27 px MSAA handoff, never bubbling near harbor vessels).
  const startError = Math.max(0.65, Math.min(2.4, Math.max(length, maxAirDraftMetres) * 0.045));
  stepErrorsList[0] = startError;
  for (let s = 1; s < totalStates; s++) {
    if (stepErrorsList[s] <= stepErrorsList[s - 1]) stepErrorsList[s] = stepErrorsList[s - 1] + 0.06;
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
    vertSailMask,
    splat: Object.freeze({
      centre: [cx, cy, cz],
      rx: rxSplat,
      ry: rySplat,
      rz: rzSplat,
      radius,
      colour: meanColour,
    }),
  });
}

function recomputeClothNormalsInPlace(verts, inds, matFloorSet) {
  const vCount = Math.floor(verts.length / 9);
  const accX = new Float64Array(vCount);
  const accY = new Float64Array(vCount);
  const accZ = new Float64Array(vCount);
  const touched = new Uint8Array(vCount);
  for (let i = 0; i + 2 < inds.length; i += 3) {
    const i0 = inds[i], i1 = inds[i + 1], i2 = inds[i + 2];
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    const m0 = Math.floor(verts[i0 * 9 + 6]);
    if (!matFloorSet.has(m0)) continue;
    if (Math.floor(verts[i1 * 9 + 6]) !== m0 || Math.floor(verts[i2 * 9 + 6]) !== m0) continue;
    const ax = verts[i0 * 9], ay = verts[i0 * 9 + 1], az = verts[i0 * 9 + 2];
    const bx = verts[i1 * 9], by = verts[i1 * 9 + 1], bz = verts[i1 * 9 + 2];
    const cx = verts[i2 * 9], cy = verts[i2 * 9 + 1], cz = verts[i2 * 9 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const origDot = nx * (verts[i0 * 9 + 3] + verts[i1 * 9 + 3] + verts[i2 * 9 + 3])
      + ny * (verts[i0 * 9 + 4] + verts[i1 * 9 + 4] + verts[i2 * 9 + 4])
      + nz * (verts[i0 * 9 + 5] + verts[i1 * 9 + 5] + verts[i2 * 9 + 5]);
    if (origDot < 0) { nx = -nx; ny = -ny; nz = -nz; }
    accX[i0] += nx; accY[i0] += ny; accZ[i0] += nz; touched[i0] = 1;
    accX[i1] += nx; accY[i1] += ny; accZ[i1] += nz; touched[i1] = 1;
    accX[i2] += nx; accY[i2] += ny; accZ[i2] += nz; touched[i2] = 1;
  }
  for (let v = 0; v < vCount; v++) {
    if (!touched[v]) continue;
    const len = Math.hypot(accX[v], accY[v], accZ[v]);
    if (len > 1e-8) {
      const o = v * 9;
      const prevLen = Math.hypot(verts[o + 3], verts[o + 4], verts[o + 5]) || 1;
      verts[o + 3] = (accX[v] / len) * prevLen;
      verts[o + 4] = (accY[v] / len) * prevLen;
      verts[o + 5] = (accZ[v] / len) * prevLen;
    }
  }
}

function appendNeutralBargeSweepOars(verts, inds, groups, designScale) {
  const d = rowingDesign('lusoria');
  const pivots = bargeOarPivotsForWGSL();
  const sx = designScale[0] || 1, sy = designScale[1] || 1;
  for (const st of d.stations) {
    const pairIdx = st.index >> 1;
    if (!ACTIVE_BARGE_OAR_PAIRS.has(pairIdx)) continue;
    const stIdx = st.index | 0;
    const px = pivots[stIdx * 4 + 0];
    const py = pivots[stIdx * 4 + 1];
    const pz = pivots[stIdx * 4 + 2];
    const side = pivots[stIdx * 4 + 3] || st.side;
    const matId = 16 + stIdx / 64;
    const startIdx = inds.length;

    // Exact 3D collinear sweep ray through pivot (px, py, pz) at physical slope m = BARGE_OAR_SLOPE_M (-0.34): 0.000 mm kink.
    const ptOnRay = (rMetres) => [
      px + side * (rMetres / sx),
      py + (rMetres * BARGE_OAR_SLOPE_M) / sy,
      pz,
    ];
    const tipIn = ptOnRay(-BARGE_INBOARD_LEVER_METRES);
    const collarIn = ptOnRay(-0.065);
    const collarOut = ptOnRay(0.085);
    const neckEnd = ptOnRay(1.88);
    const bladeTip = ptOnRay(2.68);

    // Ergonomic tapered wooden loom, leather tholepin collar seated on (px,py,pz), and straight outboard sweep shaft
    appendTaperedCylinder(verts, inds, tipIn, collarIn, 0.025, 0.021, 8, matId, 0);
    appendTaperedCylinder(verts, inds, collarIn, collarOut, 0.036, 0.035, 8, matId, 0);
    appendTaperedCylinder(verts, inds, collarOut, neckEnd, 0.031, 0.023, 8, matId, 0);

    // Closed 6-face 3D tapered wooden river-sweep blade (perpendicular athwartships at Z === pz, dipping into water)
    const axX = bladeTip[0] - neckEnd[0], axY = bladeTip[1] - neckEnd[1];
    const axLen = Math.hypot(axX, axY) || 1;
    const nX = -axY / axLen * side, nY = axX / axLen * side;
    const halfThk = 0.010;
    const halfWRoot = 0.052, halfWTip = 0.082;
    const mkCorner = (base, hw, sZ, sN) => [
      base[0] + nX * halfThk * sN,
      base[1] + nY * halfThk * sN,
      base[2] + hw * sZ,
    ];
    const f0 = mkCorner(neckEnd, halfWRoot, -1, 1);
    const f1 = mkCorner(bladeTip, halfWTip, -1, 1);
    const f2 = mkCorner(bladeTip, halfWTip, 1, 1);
    const f3 = mkCorner(neckEnd, halfWRoot, 1, 1);
    const b0 = mkCorner(neckEnd, halfWRoot, -1, -1);
    const b1 = mkCorner(bladeTip, halfWTip, -1, -1);
    const b2 = mkCorner(bladeTip, halfWTip, 1, -1);
    const b3 = mkCorner(neckEnd, halfWRoot, 1, -1);
    pushQuad9(verts, inds, f0, f1, f2, f3, matId);
    pushQuad9(verts, inds, b3, b2, b1, b0, matId);
    pushQuad9(verts, inds, f0, b0, b1, f1, matId);
    pushQuad9(verts, inds, f1, b1, b2, f2, matId);
    pushQuad9(verts, inds, f2, b2, b3, f3, matId);
    pushQuad9(verts, inds, f3, b3, b0, f0, matId);

    if (inds.length > startIdx) {
      groups.push({
        id: `rowing.propulsor.${st.id}`,
        nodeId: `rowing.${st.id}`,
        firstVertex: startIdx,
        vertexCount: inds.length - startIdx,
        motion: { type: 'rowing-blade', stationId: st.id },
      });
    }
  }
}

function appendBargeSteeringSweep(verts, inds, groups) {
  // Aft starboard quarter oak crutch block + twin hardwood tholepins mounted on top of the gunwale (z = 4.86)
  const zCrutch = 4.86;
  const railY = rowingHullDeck('lusoria', zCrutch);
  const railX = rowingHullWidth('lusoria', zCrutch, railY);
  const pCrutch = [railX + 0.025, railY + 0.145, zCrutch];

  const crutchStart = inds.length;
  appendRoundedBox9(verts, inds, railX - 0.015, railY + 0.042, zCrutch, 0.052, 0.052, 0.095, 1, 0.02, false);
  for (const zSign of [-1, 1]) {
    appendTaperedCylinder(
      verts, inds,
      [railX + 0.015, railY + 0.065, zCrutch + zSign * 0.054],
      [railX + 0.015, railY + 0.185, zCrutch + zSign * 0.054],
      0.015, 0.013, 6, 17, 0,
    );
  }
  if (inds.length > crutchStart) {
    groups.push({
      id: 'hull.steering-crutch',
      nodeId: 'hull',
      firstVertex: crutchStart,
      vertexCount: inds.length - crutchStart,
    });
  }

  // Straight collinear stern steering sweep (matId = 28) resting OVER the starboard gunwale crutch (strictly > railY)
  const sweepStart = inds.length;
  const dX = 0.22, dY = -0.82, dZ = 0.72;
  const sweepPt = (t) => [pCrutch[0] + dX * t, pCrutch[1] + dY * t, pCrutch[2] + dZ * t];
  const loomHead = sweepPt(-0.44);
  const collarIn = sweepPt(-0.08);
  const collarOut = sweepPt(0.10);
  const neckEnd = sweepPt(0.68);
  const bladeTip = sweepPt(0.98);

  appendTaperedCylinder(verts, inds, loomHead, collarIn, 0.026, 0.030, 8, 28, 0);
  appendTaperedCylinder(verts, inds, collarIn, collarOut, 0.038, 0.037, 8, 28, 0);
  appendTaperedCylinder(verts, inds, collarOut, neckEnd, 0.032, 0.025, 8, 28, 0);
  // Mortised athwartships hardwood tiller bar extending inboard from loomHead to pilot station
  appendTaperedCylinder(verts, inds, loomHead, [0.20, loomHead[1] - 0.015, loomHead[2] - 0.06], 0.020, 0.017, 7, 28, 0);

  // Closed 6-face 3D tapered wooden steering blade aligned fore-and-aft in the river wake
  const halfThk = 0.012;
  const halfWRoot = 0.056, halfWTip = 0.095;
  const mkBlade = (base, hw, sChord, sSide) => [
    base[0] + halfThk * sSide,
    base[1] + hw * 0.62 * sChord,
    base[2] + hw * 0.78 * sChord,
  ];
  const f0 = mkBlade(neckEnd, halfWRoot, -1, 1);
  const f1 = mkBlade(bladeTip, halfWTip, -1, 1);
  const f2 = mkBlade(bladeTip, halfWTip, 1, 1);
  const f3 = mkBlade(neckEnd, halfWRoot, 1, 1);
  const b0 = mkBlade(neckEnd, halfWRoot, -1, -1);
  const b1 = mkBlade(bladeTip, halfWTip, -1, -1);
  const b2 = mkBlade(bladeTip, halfWTip, 1, -1);
  const b3 = mkBlade(neckEnd, halfWRoot, 1, -1);
  pushQuad9(verts, inds, f0, f1, f2, f3, 28);
  pushQuad9(verts, inds, b3, b2, b1, b0, 28);
  pushQuad9(verts, inds, f0, b0, b1, f1, 28);
  pushQuad9(verts, inds, f1, b1, b2, f2, 28);
  pushQuad9(verts, inds, f2, b2, b3, f3, 28);
  pushQuad9(verts, inds, f3, b3, b0, f0, 28);

  if (inds.length > sweepStart) {
    groups.push({
      id: 'helm.steering-oar',
      nodeId: 'helm.rudder',
      firstVertex: sweepStart,
      vertexCount: inds.length - sweepStart,
    });
  }
}

function collectGroupUniqueVerts(inds, group) {
  const set = new Set();
  const end = Math.min(inds.length, group.firstVertex + group.vertexCount);
  for (let i = group.firstVertex; i < end; i++) set.add(inds[i]);
  return set;
}

function measureYardEndpoints(verts, inds, yg) {
  const bounds = groupDesignBounds(verts, inds, yg);
  if (!Number.isFinite(bounds.min[0])) return null;
  const spanX = bounds.max[0] - bounds.min[0];
  const spanZ = bounds.max[2] - bounds.min[2];
  const uniq = collectGroupUniqueVerts(inds, yg);
  if (spanX >= spanZ) {
    let y0 = 0, z0 = 0, n0 = 0, y1 = 0, z1 = 0, n1 = 0;
    const tol = Math.max(0.08, spanX * 0.06);
    for (const vi of uniq) {
      const x = verts[vi * 9], y = verts[vi * 9 + 1], z = verts[vi * 9 + 2];
      if (x <= bounds.min[0] + tol) { y0 += y; z0 += z; n0++; }
      if (x >= bounds.max[0] - tol) { y1 += y; z1 += z; n1++; }
    }
    const cy = (bounds.min[1] + bounds.max[1]) * 0.5;
    const cz = (bounds.min[2] + bounds.max[2]) * 0.5;
    return {
      isLateen: false,
      p0: [bounds.min[0], n0 ? y0 / n0 : cy, n0 ? z0 / n0 : cz],
      p1: [bounds.max[0], n1 ? y1 / n1 : cy, n1 ? z1 / n1 : cz],
      cy,
      cz,
    };
  }
  let x0 = 0, y0 = 0, n0 = 0, x1 = 0, y1 = 0, n1 = 0;
  const tol = Math.max(0.10, spanZ * 0.05);
  for (const vi of uniq) {
    const x = verts[vi * 9], y = verts[vi * 9 + 1], z = verts[vi * 9 + 2];
    if (z <= bounds.min[2] + tol) { x0 += x; y0 += y; n0++; }
    if (z >= bounds.max[2] - tol) { x1 += x; y1 += y; n1++; }
  }
  const cx = (bounds.min[0] + bounds.max[0]) * 0.5;
  const cy = (bounds.min[1] + bounds.max[1]) * 0.5;
  const cz = (bounds.min[2] + bounds.max[2]) * 0.5;
  return {
    isLateen: true,
    p0: [n0 ? x0 / n0 : cx, n0 ? y0 / n0 : bounds.min[1], bounds.min[2]],
    p1: [n1 ? x1 / n1 : cx, n1 ? y1 / n1 : bounds.max[1], bounds.max[2]],
    cy,
    cz,
  };
}

function poseArchetypeSailsAndRig(warpedVerts, strippedInds, strippedGroups, spec) {
  const vCount = Math.floor(warpedVerts.length / 9);
  const mastCenterZ = (mastId) => {
    const mg = strippedGroups.find((g) => g.id === `mast.${mastId}`);
    if (!mg) return 0;
    const mb = groupDesignBounds(warpedVerts, strippedInds, mg);
    return Number.isFinite(mb.min[2]) ? (mb.min[2] + mb.max[2]) * 0.5 : 0;
  };

  // Harbor Barque (Arch 6): step single mainmast + lateen spar & sail forward by dZ = -1.55 toward midships balance.
  if (spec.index === 6) {
    const barqueShiftGroups = new Set([
      'mast.main', 'mast.main.cut', 'yard.main', 'sail.main.canvas', 'sail.main.edge',
    ]);
    const shiftVerts = new Set();
    for (const g of strippedGroups) {
      if (barqueShiftGroups.has(g.id)) {
        for (const vi of collectGroupUniqueVerts(strippedInds, g)) shiftVerts.add(vi);
      }
    }
    for (const vi of shiftVerts) {
      warpedVerts[vi * 9 + 2] -= 1.55;
    }
  }

  // 1. Square sails & stitched bolt-ropes (m == 9 & m == 19 on pinta / santa-maria, surfCode in {1, 2, 4, 5}):
  //    3D windward forward (-Z) aerodynamic belly + subtle upward foot roach while keeping v=0 on yard and clews pinned.
  if (!spec.furlSails && !spec.unmasted && (spec.modelId === 'pinta' || spec.modelId === 'santa-maria')) {
    const sqBounds = new Map();
    for (let v = 0; v < vCount; v++) {
      const m = warpedVerts[v * 9 + 6];
      const kind = Math.floor(m);
      if (kind !== 9 && kind !== 19) continue;
      const code = Math.round((m - kind) * 64);
      if (code === 3 || code <= 0) continue;
      const y = warpedVerts[v * 9 + 1];
      let b = sqBounds.get(code);
      if (!b) { b = { minY: Infinity, maxY: -Infinity }; sqBounds.set(code, b); }
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
    }
    for (let v = 0; v < vCount; v++) {
      const o = v * 9;
      const m = warpedVerts[o + 6];
      const kind = Math.floor(m);
      if (kind !== 9 && kind !== 19) continue;
      const code = Math.round((m - kind) * 64);
      const b = sqBounds.get(code);
      if (!b) continue;
      const spanY = Math.max(0.6, b.maxY - b.minY);
      const belly = Math.max(0.42, Math.min(0.85, spanY * 0.135));
      const u = Math.max(0, Math.min(1, warpedVerts[o + 7]));
      const vv = Math.max(0, Math.min(1, warpedVerts[o + 8]));
      const sinU = Math.sin(Math.PI * u);
      const sinV = Math.sin(Math.PI * Math.pow(vv, 0.85));
      const dz = -belly * (sinV * (0.42 + 0.58 * sinU) + 0.28 * vv * vv * sinU) + (u - 0.5) * vv * 0.06;
      const dy = spanY * 0.032 * vv * vv * sinU;
      warpedVerts[o + 1] += dy;
      warpedVerts[o + 2] += dz;
    }
  }

  // 2. Lateen yards & lateen sails + bolt-ropes (Arch 0..3 mizzen-lateen & Arch 5..6 fore/main/mizzen):
  //    Lateral mast clearance (xOffset = +0.40 design) + 3D leeward aerodynamic belly so zero spars/sails slice masts at X = 0.
  const lateenConfigs = [];
  if (spec.modelId === 'pinta' || spec.modelId === 'santa-maria') {
    lateenConfigs.push({ yardId: 'yard.mizzen-lateen', code: 3, mastId: 'mizzen', belly: 0.54, xOff: 0.40 });
  } else if (spec.modelId === 'nina') {
    if (spec.index === 5) {
      lateenConfigs.push(
        { yardId: 'yard.fore', code: 4, mastId: 'fore', belly: 0.82, xOff: 0.42 },
        { yardId: 'yard.main', code: 8, mastId: 'main', belly: 0.68, xOff: 0.40 },
        { yardId: 'yard.mizzen', code: 12, mastId: 'mizzen', belly: 0.50, xOff: 0.38 },
      );
    } else if (spec.index === 6) {
      lateenConfigs.push({ yardId: 'yard.main', code: 8, mastId: 'main', belly: 0.70, xOff: 0.40 });
    }
  }

  for (const cfg of lateenConfigs) {
    const zMast = mastCenterZ(cfg.mastId);
    const yardShiftAtZ = (z) => cfg.xOff - 0.025 * (z - zMast);
    const yg = strippedGroups.find((g) => g.id === cfg.yardId);
    if (yg && yg.vertexCount > 0) {
      for (const vi of collectGroupUniqueVerts(strippedInds, yg)) {
        const z = warpedVerts[vi * 9 + 2];
        warpedVerts[vi * 9] += yardShiftAtZ(z);
      }
    }
    if (spec.furlSails || spec.unmasted) continue;

    let zPeak = zMast + 1.8, zTack = zMast - 1.8, nPeak = 0, nTack = 0;
    let yClew = 2.0, zClew = zMast + 2.2, nClew = 0;
    for (let v = 0; v < vCount; v++) {
      const o = v * 9;
      const m = warpedVerts[o + 6];
      const kind = Math.floor(m);
      if ((kind !== 13 && kind !== 19) || Math.round((m - kind) * 64) !== cfg.code) continue;
      const u = warpedVerts[o + 7], vv = warpedVerts[o + 8];
      if (u <= 0.03 && vv <= 0.03) { zPeak = (zPeak * nPeak + warpedVerts[o + 2]) / (nPeak + 1); nPeak++; }
      if (u >= 0.97 && vv <= 0.03) { zTack = (zTack * nTack + warpedVerts[o + 2]) / (nTack + 1); nTack++; }
      if (u <= 0.03 && vv >= 0.97) {
        yClew = (yClew * nClew + warpedVerts[o + 1]) / (nClew + 1);
        zClew = (zClew * nClew + warpedVerts[o + 2]) / (nClew + 1);
        nClew++;
      }
    }
    const xPeak = yardShiftAtZ(zPeak);
    const xTack = yardShiftAtZ(zTack);
    const xClew = cfg.xOff + 0.24;

    for (let v = 0; v < vCount; v++) {
      const o = v * 9;
      const m = warpedVerts[o + 6];
      const kind = Math.floor(m);
      if ((kind !== 13 && kind !== 19) || Math.round((m - kind) * 64) !== cfg.code) continue;
      const u = Math.max(0, Math.min(1, warpedVerts[o + 7]));
      const vv = Math.max(0, Math.min(1, warpedVerts[o + 8]));
      const w = Math.max(0, 1 - u - vv);
      const yardX = xPeak + (xTack - xPeak) * u;
      const footT = u < 0.999 ? Math.min(1, vv / Math.max(1e-4, 1 - u)) : 0;
      const xCloth = (1 - vv) * yardX + vv * xClew
        + cfg.belly * (6.2 * u * vv * w + 0.38 * Math.sin(Math.PI * vv) * (1 - u) + 0.32 * Math.sin(Math.PI * u) * footT);
      const tubeOff = kind === 19 ? Math.max(-0.018, Math.min(0.018, warpedVerts[o])) : 0;
      warpedVerts[o] = xCloth + tubeOff;
    }

    // Keep attached running halyard/tack/sheet endpoints connected to the laterally offset lateen spar & clew
    for (const rg of strippedGroups) {
      const isMizzenRun = (spec.modelId === 'pinta' || spec.modelId === 'santa-maria') && rg.id === 'rig.running';
      const isNinaRun = spec.modelId === 'nina' && /^rope\.\d+\.(?:halyard|tack|sheet)$/i.test(rg.id) && rg.nodeId === `mast.${cfg.mastId}`;
      if (!isMizzenRun && !isNinaRun) continue;
      for (const vi of collectGroupUniqueVerts(strippedInds, rg)) {
        const o = vi * 9;
        const x = warpedVerts[o], y = warpedVerts[o + 1], z = warpedVerts[o + 2];
        if (Math.abs(x) > 0.08) continue;
        if (isMizzenRun && z < zTack - 0.35) continue;
        if (Math.hypot(y - yClew, z - zClew) < 0.32) {
          warpedVerts[o] += xClew;
        } else if (y > 1.6 && z >= Math.min(zTack, zPeak) - 0.35 && z <= Math.max(zTack, zPeak) + 0.35) {
          warpedVerts[o] += yardShiftAtZ(z);
        }
      }
    }
  }

  if (!spec.furlSails && !spec.unmasted) {
    recomputeClothNormalsInPlace(warpedVerts, strippedInds, new Set([9, 13]));
  }
}

function appendHarborBarqueRigging(verts, inds, groups) {
  const mastGroup = groups.find((g) => g.id === 'mast.main');
  const yardGroup = groups.find((g) => g.id === 'yard.main');
  if (!mastGroup || !yardGroup) return;
  const mb = groupDesignBounds(verts, inds, mastGroup);
  const zMast = (mb.min[2] + mb.max[2]) * 0.5;
  const yHound = mb.min[1] + (mb.max[1] - mb.min[1]) * 0.86;
  const hound = [0, yHound, zMast - 0.04];

  // Probe stemhead & port/starboard gunwale sheer rails from actual hull geometry
  let zStem = -5.6, yStem = 1.25;
  let railY = 1.05, railHalfX = 1.48;
  for (let i = 0; i < verts.length; i += 9) {
    const m = Math.floor(verts[i + 6]);
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if ((m === 1 || m === 5 || m === 16 || m === 15) && Math.abs(x) < 0.25 && z < zStem && y > 0.65) {
      zStem = z;
      yStem = Math.max(yStem, y);
    }
    if ((m === 15 || m === 17 || m === 1) && Math.abs(z - zMast) < 0.55 && y > 0.80 && y < 1.65 && Math.abs(x) > 0.9) {
      railHalfX = Math.max(railHalfX, Math.abs(x) - 0.08);
      railY = Math.max(railY, Math.min(1.42, y));
    }
  }
  const stemAnchor = [0, Math.min(1.55, yStem - 0.05), Math.max(-6.15, zStem + 0.32)];

  let pTack = [0.45, 1.9, zMast - 2.4];
  let pSling = [0.40, 5.2, zMast + 0.2];
  let pClew = [0.64, 2.4, zMast + 2.6];
  const ye = measureYardEndpoints(verts, inds, yardGroup);
  if (ye) {
    pTack = ye.p0;
    pSling = [(ye.p0[0] + ye.p1[0]) * 0.5, (ye.p0[1] + ye.p1[1]) * 0.5, (ye.p0[2] + ye.p1[2]) * 0.5];
  }
  for (let i = 0; i < verts.length; i += 9) {
    const m = verts[i + 6];
    if (Math.floor(m) === 13 && Math.round((m - 13) * 64) === 8 && verts[i + 7] <= 0.03 && verts[i + 8] >= 0.97) {
      pClew = [verts[i], verts[i + 1], verts[i + 2]];
      break;
    }
  }

  const standStart = inds.length;
  appendTaperedCylinder(verts, inds, hound, stemAnchor, 0.020, 0.018, 6, 2, 0);
  appendTaperedCylinder(verts, inds, [0, yHound - 0.05, zMast - 0.04], [0, yHound + 0.05, zMast - 0.04], 0.095, 0.090, 8, 16, 0);
  for (const side of [-1, 1]) {
    for (const zOff of [-0.18, 0.36]) {
      const chX = side * railHalfX;
      const chZ = zMast + zOff;
      const upperDead = [chX * 0.94, railY + 0.26, chZ];
      const lowerDead = [chX, railY + 0.04, chZ];
      appendTaperedCylinder(verts, inds, [side * 0.06, yHound, zMast], upperDead, 0.015, 0.014, 6, 2, 0);
      appendTaperedCylinder(verts, inds, upperDead, lowerDead, 0.028, 0.028, 6, 16, 0);
    }
  }
  if (inds.length > standStart) {
    groups.push({ id: 'rig.standing.barque', nodeId: 'mast.main', firstVertex: standStart, vertexCount: inds.length - standStart });
  }

  const runStart = inds.length;
  appendTaperedCylinder(verts, inds, pTack, [0.06, 0.98, Math.max(stemAnchor[2] + 0.55, pTack[2] - 0.25)], 0.013, 0.012, 5, 12, 0);
  appendTaperedCylinder(verts, inds, pSling, [0.10, yHound + 0.08, zMast + 0.04], 0.014, 0.013, 5, 12, 0);
  appendTaperedCylinder(verts, inds, [0.08, yHound + 0.06, zMast + 0.06], [-0.18, 0.95, zMast + 0.18], 0.012, 0.012, 5, 12, 0);
  appendTaperedCylinder(verts, inds, pClew, [Math.min(railHalfX * 0.85, 1.15), 2.34, Math.min(4.8, pClew[2] + 0.55)], 0.013, 0.012, 5, 12, 0);
  if (inds.length > runStart) {
    groups.push({ id: 'rig.running.barque', nodeId: 'mast.main', firstVertex: runStart, vertexCount: inds.length - runStart });
  }
}

function measureArchetypeSailBrailSpecs(verts) {
  const byCode = new Map();
  const vCount = Math.floor(verts.length / 9);
  for (let i = 0; i < vCount; i++) {
    const o = i * 9;
    const m = verts[o + 6];
    const kind = Math.floor(m);
    if (kind !== 9 && kind !== 13) continue;
    const code = Math.min(15, Math.max(0, Math.round((m - kind) * 64)));
    let rec = byCode.get(code);
    if (!rec) {
      rec = {
        isLateen: kind === 13,
        minY: Infinity, maxY: -Infinity,
        yardYSum: 0, yardZSum: 0, yardN: 0,
        peakSum: [0, 0, 0], peakN: 0,
        tackSum: [0, 0, 0], tackN: 0,
      };
      byCode.set(code, rec);
    }
    const x = verts[o], y = verts[o + 1], z = verts[o + 2];
    const u = verts[o + 7], v = verts[o + 8];
    if (y < rec.minY) rec.minY = y;
    if (y > rec.maxY) rec.maxY = y;
    if (kind === 9) {
      if (v <= 0.025) { rec.yardYSum += y; rec.yardZSum += z; rec.yardN++; }
    } else {
      if (u <= 0.03 && v <= 0.03) { rec.peakSum[0] += x; rec.peakSum[1] += y; rec.peakSum[2] += z; rec.peakN++; }
      if (u >= 0.97 && v <= 0.03) { rec.tackSum[0] += x; rec.tackSum[1] += y; rec.tackSum[2] += z; rec.tackN++; }
    }
  }
  const out = {};
  for (const [code, r] of byCode.entries()) {
    if (r.isLateen) {
      const peak = r.peakN ? r.peakSum.map((s) => s / r.peakN) : [0.35, r.maxY, 3.0];
      const tack = r.tackN ? r.tackSum.map((s) => s / r.tackN) : [0.45, r.minY, -1.0];
      out[code] = Object.freeze({ isLateen: true, peak: Object.freeze(peak), tack: Object.freeze(tack) });
    } else {
      const yardY = r.yardN ? r.yardYSum / r.yardN : r.maxY;
      const yardZ = r.yardN ? r.yardZSum / r.yardN : 0;
      out[code] = Object.freeze({ isLateen: false, yardY, yardZ, footY: r.minY });
    }
  }
  return Object.freeze(out);
}

function buildArchetypeData(index) {
  const spec = ARCHETYPE_SPECS[index] ?? ARCHETYPE_SPECS[0];
  if (!sharedAssetCache) sharedAssetCache = createShipAssetCache();
  const base = sharedAssetCache.get(spec.modelId);
  const model = getShipModel(spec.modelId);
  const taxLength = effectiveTaxonomyLength(spec, model);
  const scaleSpec = computeArchetypeScaleSpec({ modelId: spec.modelId, length: taxLength, beam: spec.beam });
  const designScale0 = archetypeDesignScale(spec, model);

  let vertsArr = Array.from(base.vertices);
  let indsArr = Array.from(base.indices);
  let groupsArr = base.groups.map((g) => ({ ...g }));

  // Anchored cogs/carracks replace spread square/lateen sails and running gear with furled linen bundles under each active yard.
  // River barges drop masts, standing/running rigging, unused benches, and all old galley oar geometry (rebuilt in neutral sweep=0 rest pose).
  let dropRegex = null;
  if (spec.index === 4) {
    dropRegex = /^(?:(?:mast|yard|sail|rig|lookout|flag|anchor)(?:\.|$)|helm\.steering-oar|rowing\.(?:station|propulsor)\.rower\.)/i;
    const d = rowingDesign('lusoria');
    const sxBase = d.runtime.beam / d.frame.beam;
    const floorLiftDesign = BARGE_FLOOR_LIFT_METRES / (designScale0[1] || 1);
    const benchLiftDesign = BARGE_BENCH_LIFT_METRES / (designScale0[1] || 1);
    const activeSeatZs = [...ACTIVE_BARGE_OAR_PAIRS].map((p) => d.stations[p * 2].seat[2]);

    // 1. Raise interior floorboards (+0.26 m hull metres) & clamp strictly inside hull.outer so tips never poke through stems
    const floorGroup = groupsArr.find((g) => g.id === 'deck.floorboards');
    if (floorGroup) {
      const wNewByVert = new Map();
      for (const vi of collectGroupUniqueVerts(indsArr, floorGroup)) {
        const o = vi * 9;
        const yOld = vertsArr[o + 1], z = vertsArr[o + 2];
        const yNew = yOld + floorLiftDesign;
        const wOld = Math.max(0.06, rowingHullWidth('lusoria', z, yOld) - d.shellThicknessMetres / sxBase);
        const wNew = Math.max(0.0, rowingHullWidth('lusoria', z, yNew) - d.shellThicknessMetres / sxBase - 0.012);
        vertsArr[o] *= (wNew / wOld);
        vertsArr[o + 1] = yNew;
        wNewByVert.set(vi, wNew);
      }
      const fEnd = Math.min(indsArr.length, floorGroup.firstVertex + floorGroup.vertexCount);
      for (let t = floorGroup.firstVertex; t + 2 < fEnd; t += 3) {
        const i0 = indsArr[t], i1 = indsArr[t + 1], i2 = indsArr[t + 2];
        if ((wNewByVert.get(i0) ?? 0) < 0.015 || (wNewByVert.get(i1) ?? 0) < 0.015 || (wNewByVert.get(i2) ?? 0) < 0.015) {
          indsArr[t] = indsArr[t + 1] = indsArr[t + 2] = 0;
        }
      }
    }

    // 1b. Drop coplanar stem centerline triangles in `hull.inner` where port & starboard inner() clamped to x === 0
    const innerGroup = groupsArr.find((g) => g.id === 'hull.inner');
    if (innerGroup) {
      const iEnd = Math.min(indsArr.length, innerGroup.firstVertex + innerGroup.vertexCount);
      for (let t = innerGroup.firstVertex; t + 2 < iEnd; t += 3) {
        const i0 = indsArr[t], i1 = indsArr[t + 1], i2 = indsArr[t + 2];
        if (Math.abs(vertsArr[i0 * 9]) < 0.004 && Math.abs(vertsArr[i1 * 9]) < 0.004 && Math.abs(vertsArr[i2 * 9]) < 0.004) {
          indsArr[t] = indsArr[t + 1] = indsArr[t + 2] = 0;
        }
      }
    }

    // 2. Filter `rowing.benches` so ONLY the 4 active wooden thwarts (#2, #5, #8, #11) remain; drop all 10 unused benches!
    const benchGroup = groupsArr.find((g) => g.id === 'rowing.benches');
    if (benchGroup) {
      const end = Math.min(indsArr.length, benchGroup.firstVertex + benchGroup.vertexCount);
      const keptBenchVerts = new Set();
      for (let t = benchGroup.firstVertex; t + 2 < end; t += 3) {
        const i0 = indsArr[t], i1 = indsArr[t + 1], i2 = indsArr[t + 2];
        const cz = (vertsArr[i0 * 9 + 2] + vertsArr[i1 * 9 + 2] + vertsArr[i2 * 9 + 2]) / 3;
        const cy = (vertsArr[i0 * 9 + 1] + vertsArr[i1 * 9 + 1] + vertsArr[i2 * 9 + 1]) / 3;
        const ny = (vertsArr[i0 * 9 + 4] + vertsArr[i1 * 9 + 4] + vertsArr[i2 * 9 + 4]) / 3;
        const isActiveBench = activeSeatZs.some((sz) => Math.abs(cz - sz) < 0.24);
        const isBottomLegCap = ny < -0.82 && cy < rowingDeck('lusoria', cz) + 0.08;
        if (!isActiveBench || isBottomLegCap) {
          indsArr[t] = indsArr[t + 1] = indsArr[t + 2] = 0;
        } else {
          keptBenchVerts.add(i0); keptBenchVerts.add(i1); keptBenchVerts.add(i2);
        }
      }
      for (const vi of keptBenchVerts) {
        const o = vi * 9;
        const yOld = vertsArr[o + 1], z = vertsArr[o + 2];
        const soleOrig = rowingDeck('lusoria', z);
        if (yOld > soleOrig + 0.10) {
          const yNew = yOld + benchLiftDesign;
          const wOld = Math.max(0.12, rowingHullWidth('lusoria', z, yOld) - d.shellThicknessMetres / sxBase);
          const wNew = Math.max(0.12, rowingHullWidth('lusoria', z, yNew) - d.shellThicknessMetres / sxBase);
          vertsArr[o] *= (wNew / wOld);
          vertsArr[o + 1] = yNew;
        } else {
          vertsArr[o + 1] = soleOrig + floorLiftDesign + 0.004;
        }
      }
    }

    // 3. Offset `deck.stores` (+0.012 m clear of raised floorboards), omitting bottom -y faces & bailer box under Bench #11
    const storesGroup = groupsArr.find((g) => g.id === 'deck.stores');
    if (storesGroup) {
      const end = Math.min(indsArr.length, storesGroup.firstVertex + storesGroup.vertexCount);
      const keptStoreVerts = new Set();
      for (let t = storesGroup.firstVertex; t + 2 < end; t += 3) {
        const i0 = indsArr[t], i1 = indsArr[t + 1], i2 = indsArr[t + 2];
        const cz = (vertsArr[i0 * 9 + 2] + vertsArr[i1 * 9 + 2] + vertsArr[i2 * 9 + 2]) / 3;
        const cy = (vertsArr[i0 * 9 + 1] + vertsArr[i1 * 9 + 1] + vertsArr[i2 * 9 + 1]) / 3;
        const ny = (vertsArr[i0 * 9 + 4] + vertsArr[i1 * 9 + 4] + vertsArr[i2 * 9 + 4]) / 3;
        const underBench11 = cz > 2.45 && cz < 3.05;
        const coplanarBottom = ny < -0.82 && cy < rowingDeck('lusoria', cz) + 0.05;
        if (underBench11 || coplanarBottom) {
          indsArr[t] = indsArr[t + 1] = indsArr[t + 2] = 0;
        } else {
          keptStoreVerts.add(i0); keptStoreVerts.add(i1); keptStoreVerts.add(i2);
        }
      }
      const storesLift = floorLiftDesign + 0.012 / (designScale0[1] || 1);
      for (const vi of keptStoreVerts) {
        vertsArr[vi * 9 + 1] += storesLift;
      }
    }
  } else if (spec.unmasted) {
    dropRegex = /^(?:mast|yard|sail|rig|lookout|flag)(?:\.|$)/i;
  } else if (spec.furlSails) {
    dropRegex = /^(?:sail\.(?!furled\.)|rig\.running(?:\.|$))/i;
  } else if (spec.index === 6) {
    // Harbor Barque: prune 3-mast caravel bowsprit overhang (z < -4.2), detached stay-attachments, and 3-mast ropes
    dropRegex = /^(?:rig\.stay-attachments|tackle\.|rope\.)/i;
    const bowGrp = groupsArr.find((g) => g.id === 'bow.structure');
    if (bowGrp) {
      const end = Math.min(indsArr.length, bowGrp.firstVertex + bowGrp.vertexCount);
      for (let t = bowGrp.firstVertex; t + 2 < end; t += 3) {
        const i0 = indsArr[t], i1 = indsArr[t + 1], i2 = indsArr[t + 2];
        const minZ = Math.min(vertsArr[i0 * 9 + 2], vertsArr[i1 * 9 + 2], vertsArr[i2 * 9 + 2]);
        if (minZ < -4.2) indsArr[t] = indsArr[t + 1] = indsArr[t + 2] = 0;
      }
    }
    const mainMastGrp = groupsArr.find((g) => g.id === 'mast.main');
    if (mainMastGrp) {
      const end = Math.min(indsArr.length, mainMastGrp.firstVertex + mainMastGrp.vertexCount);
      for (let t = mainMastGrp.firstVertex; t + 2 < end; t += 3) {
        const i0 = indsArr[t], i1 = indsArr[t + 1], i2 = indsArr[t + 2];
        const maxAbsX = Math.max(Math.abs(vertsArr[i0 * 9]), Math.abs(vertsArr[i1 * 9]), Math.abs(vertsArr[i2 * 9]));
        if (maxAbsX > 0.36) indsArr[t] = indsArr[t + 1] = indsArr[t + 2] = 0;
      }
    }
  }

  // Eliminate 0.000 mm coplanar stern z-fighting on Cog (pinta: Arch 0, 1) & Carrack (santa-maria: Arch 2, 3)
  if (spec.modelId === 'pinta' || spec.modelId === 'santa-maria') {
    for (const bulwarkId of ['bulwark.port', 'bulwark.starboard']) {
      const bg = groupsArr.find((g) => g.id === bulwarkId);
      if (!bg) continue;
      const bEnd = Math.min(indsArr.length, bg.firstVertex + bg.vertexCount);
      for (let t = bg.firstVertex; t + 2 < bEnd; t += 3) {
        const i0 = indsArr[t], i1 = indsArr[t + 1], i2 = indsArr[t + 2];
        const cz = (vertsArr[i0 * 9 + 2] + vertsArr[i1 * 9 + 2] + vertsArr[i2 * 9 + 2]) / 3;
        const nz = (vertsArr[i0 * 9 + 5] + vertsArr[i1 * 9 + 5] + vertsArr[i2 * 9 + 5]) / 3;
        if (cz > 5.992 && Math.abs(nz) > 0.90) {
          indsArr[t] = indsArr[t + 1] = indsArr[t + 2] = 0;
        }
      }
    }

    const winGrp = groupsArr.find((g) => g.id === 'stern.windows');
    if (winGrp) {
      const wEnd = Math.min(indsArr.length, winGrp.firstVertex + winGrp.vertexCount);
      const parent = new Map();
      const findRoot = (v) => {
        let r = v;
        while (parent.get(r) !== r) r = parent.get(r);
        let cur = v;
        while (cur !== r) {
          const nxt = parent.get(cur);
          parent.set(cur, r);
          cur = nxt;
        }
        return r;
      };
      const unionVerts = (a, b) => {
        const ra = findRoot(a), rb = findRoot(b);
        if (ra !== rb) parent.set(rb, ra);
      };
      for (let t = winGrp.firstVertex; t + 2 < wEnd; t += 3) {
        const i0 = indsArr[t], i1 = indsArr[t + 1], i2 = indsArr[t + 2];
        for (const vi of [i0, i1, i2]) if (!parent.has(vi)) parent.set(vi, vi);
        unionVerts(i0, i1);
        unionVerts(i0, i2);
      }
      const comps = new Map();
      for (let t = winGrp.firstVertex; t + 2 < wEnd; t += 3) {
        const i0 = indsArr[t], i1 = indsArr[t + 1], i2 = indsArr[t + 2];
        const root = findRoot(i0);
        let comp = comps.get(root);
        if (!comp) {
          comp = {
            tris: [],
            verts: new Set(),
            minX: Infinity, maxX: -Infinity,
            minY: Infinity, maxY: -Infinity,
            minZ: Infinity, maxZ: -Infinity,
            mat: Math.floor(vertsArr[i0 * 9 + 6]),
          };
          comps.set(root, comp);
        }
        comp.tris.push(t);
        for (const vi of [i0, i1, i2]) {
          comp.verts.add(vi);
          const vx = vertsArr[vi * 9], vy = vertsArr[vi * 9 + 1], vz = vertsArr[vi * 9 + 2];
          if (vx < comp.minX) comp.minX = vx;
          if (vx > comp.maxX) comp.maxX = vx;
          if (vy < comp.minY) comp.minY = vy;
          if (vy > comp.maxY) comp.maxY = vy;
          if (vz < comp.minZ) comp.minZ = vz;
          if (vz > comp.maxZ) comp.maxZ = vz;
        }
      }
      for (const comp of comps.values()) {
        // Drop Santa María's central 5th window at x = 0 so hull.sternpost & helm.rudder stock never impale it
        if (spec.modelId === 'santa-maria' && Math.abs(comp.minX) < 0.14 && Math.abs(comp.maxX) < 0.14 && comp.maxY < 1.95) {
          for (const t of comp.tris) indsArr[t] = indsArr[t + 1] = indsArr[t + 2] = 0;
          continue;
        }
        const spanX = comp.maxX - comp.minX;
        const spanY = comp.maxY - comp.minY;
        if (comp.mat === 11 && comp.maxZ < 6.05) {
          // Shift stern window crown-glass aft (+0.014 design Z: 6.008 -> 6.022) clear of 6.008 oak casing box
          for (const vi of comp.verts) vertsArr[vi * 9 + 2] += 0.014;
        } else if ((comp.mat === 1 || comp.mat === 17) && comp.minZ > 6.005 && comp.maxZ < 6.035 && (spanX < 0.04 || spanY < 0.04)) {
          // Shift muntin bars aft (+0.020 vertical / +0.024 horizontal design Z) clear of glass & crossing muntins
          const dz = spanX < spanY ? 0.020 : 0.024;
          for (const vi of comp.verts) vertsArr[vi * 9 + 2] += dz;
        }
      }
    }
  }

  if (spec.addCargo && spec.modelId === 'lusoria') {
    appendLusoriaCargo(vertsArr, indsArr, groupsArr, spec.modelId, designScale0);
  }

  // First compaction drops stripped masts/sails/orphan benches cleanly before non-rubberband scaling.
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
  tmpState.syncVesselDamage(null, { modelId: spec.modelId, length: taxLength, beam: spec.beam });
  const warpedVerts = tmpState.applyToVertices(stripped.vertices);

  if (spec.index === 4) {
    for (let i = 0; i < warpedVerts.length; i += 9) {
      warpedVerts[i + 1] += BARGE_Y_LIFT;
    }
  } else {
    poseArchetypeSailsAndRig(warpedVerts, stripped.indices, stripped.groups, spec);
  }

  let preCompactVerts = warpedVerts;
  let preCompactInds = stripped.indices;
  let preCompactGroups = stripped.groups;
  const deckStations = buildTradeDeckStations(warpedVerts, spec, scaleSpec, model);
  {
    const fixVerts = Array.from(warpedVerts);
    const fixInds = Array.from(stripped.indices);
    const fixGroups = stripped.groups.map((g) => ({ ...g }));

    if (spec.index === 4) {
      appendNeutralBargeSweepOars(fixVerts, fixInds, fixGroups, designScale0);
      appendBargeSteeringSweep(fixVerts, fixInds, fixGroups);
    } else if (spec.index === 6) {
      appendHarborBarqueRigging(fixVerts, fixInds, fixGroups);
    } else if (spec.furlSails && !spec.unmasted) {
      const yardGroups = fixGroups.filter((g) => /^yard\./i.test(g.id) && g.vertexCount > 0);
      const mastHeads = fixGroups.filter((g) => /^mast\.(?:fore|main|mizzen)$/i.test(g.id) && g.vertexCount > 0).map((mg) => {
        const mb = groupDesignBounds(warpedVerts, stripped.indices, mg);
        return Number.isFinite(mb.max[1]) ? [(mb.min[0] + mb.max[0]) * 0.5, mb.max[1] * 0.92, (mb.min[2] + mb.max[2]) * 0.5] : null;
      }).filter(Boolean);
      for (const yg of yardGroups) {
        const ye = measureYardEndpoints(warpedVerts, stripped.indices, yg);
        if (!ye) continue;
        let mastHead = null;
        if (!ye.isLateen && !/spritsail/i.test(yg.id)) {
          let bestD = Infinity;
          for (const mh of mastHeads) {
            const d = Math.hypot(mh[2] - ye.cz, (mh[1] - ye.cy) * 0.35);
            if (d < bestD) { bestD = d; mastHead = mh; }
          }
        }
        const startIdx = fixInds.length;
        appendFurledSailBundle(fixVerts, fixInds, ye.p0, ye.p1, 9, 12, mastHead);
        if (fixInds.length > startIdx) {
          fixGroups.push({
            id: `sail.furled.${yg.id.slice(5)}`,
            nodeId: yg.nodeId || yg.id,
            firstVertex: startIdx,
            vertexCount: fixInds.length - startIdx,
          });
        }
      }
    }

    appendDeckFixtures(fixVerts, fixInds, fixGroups, spec, scaleSpec, model);
    preCompactVerts = new Float32Array(fixVerts);
    preCompactInds = new Uint32Array(fixInds);
    preCompactGroups = fixGroups;
  }

  // Second compaction eliminates triangles collapsed by discrete pruning (e.g., Harbor Barque pruned masts or reduced oar pairs).
  const finalMesh = filterAndCompactMesh(preCompactVerts, preCompactInds, preCompactGroups, null);
  const sailBrailSpecs = measureArchetypeSailBrailSpecs(finalMesh.vertices);

  const preFracture = prepareShipFracture({
    modelId: spec.modelId,
    model,
    vertices: finalMesh.vertices,
    indices: finalMesh.indices,
    groups: finalMesh.groups,
  });

  const frame = model.designFrame;
  const designScale = archetypeDesignScale(spec, model);
  const yRatio0 = designScale[1] / (frame.verticalScale || 1);

  let maxYDesign = -Infinity;
  for (let i = 1; i < preFracture.vertices.length; i += 9) {
    if (preFracture.vertices[i] > maxYDesign) maxYDesign = preFracture.vertices[i];
  }
  const maxAirDraftMetres = spec.modelId === 'lusoria'
    ? Math.max(1.95, Math.min(2.25, maxYDesign * designScale[1] + 1.05))
    : Math.max(0.5, maxYDesign * designScale[1]);

  const partAssembly = createPartAssemblyCatalog({
    domain: 'ship',
    modelId: spec.modelId,
    vertices: preFracture.vertices,
    vertexStride: 9,
    indices: preFracture.indices,
    groups: preFracture.groups,
  });

  const rawCollider = createShipCollider({
    model,
    vertices: preFracture.vertices,
    indices: preFracture.indices,
    groups: preFracture.groups,
    fracture: preFracture.fracture,
  });
  const collider = {
    ...rawCollider,
    frame: {
      ...rawCollider.frame,
      verticalScale: designScale[1],
    },
  };

  const baseHydro = spec.modelId === 'lusoria'
    ? rowingDesign('lusoria')
    : boatHydrodynamics(spec.length, spec.beam, 14, 0, spec.modelId);

  const draft = spec.modelId === 'lusoria'
    ? 0.305
    : Math.max(0.85, (baseHydro.draft - baseHydro.sinkage) * yRatio0);
  const freeboard = spec.modelId === 'lusoria'
    ? 0.55 * yRatio0
    : Math.max(0.55, (baseHydro.freeboard + baseHydro.sinkage) * yRatio0);
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
    deckStations,
    sailBrailSpecs,
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
 * Returns true if segment `(ax, az) -> (bx, bz)` (or point when `bx === ax && bz === az`)
 * crosses a collapsed bridge, stone pier constriction, or bridge deck soffit lower than `surfY + requiredAirDraft`.
 */
export function blockedByLowBridge(
  ax,
  az,
  bx = ax,
  bz = az,
  surfY = 0,
  requiredAirDraft = 16,
  requiredHalfBeam = 1.6,
  bridges = [],
) {
  if (!Array.isArray(bridges) || bridges.length === 0) return false;
  const segDx = bx - ax, segDz = bz - az;
  const segLen = Math.hypot(segDx, segDz);
  const steps = Math.max(1, Math.min(48, Math.ceil(segLen / 5.0)));
  const minClearance = Math.max(0.5, requiredAirDraft) + 0.30;
  for (let bi = 0; bi < bridges.length; bi++) {
    const b = bridges[bi];
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
    const deckY = Number.isFinite(b.deckY) ? b.deckY : -999;
    const hasAxis = Number.isFinite(b.ux) && Number.isFinite(b.uz) && (Math.abs(b.ux) + Math.abs(b.uz) > 0.1);
    const ux = hasAxis ? b.ux : Math.cos(b.yaw || 0);
    const uz = hasAxis ? b.uz : Math.sin(b.yaw || 0);
    const halfSpan = Math.max(7, (b.length || 14) * 0.56) + requiredHalfBeam;
    const halfDeckW = Math.max(3.0, (b.halfWidth || 2.4)) + requiredHalfBeam + 2.5;
    const radialReach = Math.max(8.5, (b.length || 14) * 0.56 + requiredHalfBeam);
    // Quick bounding-circle reject against segment midpoint
    const midX = (ax + bx) * 0.5, midZ = (az + bz) * 0.5;
    if (Math.hypot(midX - b.x, midZ - b.z) > segLen * 0.5 + radialReach + halfDeckW + 6) continue;

    let crossesFootprint = false;
    for (let s = 0; s <= steps; s++) {
      const u = steps > 0 ? s / steps : 0;
      const px = ax + segDx * u;
      const pz = az + segDz * u;
      const dx = px - b.x, dz = pz - b.z;
      if (hasAxis || Number.isFinite(b.yaw)) {
        const alongSpan = Math.abs(dx * ux + dz * uz);
        const acrossDeck = Math.abs(-dx * uz + dz * ux);
        if (alongSpan <= halfSpan && acrossDeck <= halfDeckW) {
          crossesFootprint = true;
          break;
        }
      }
      if (Math.hypot(dx, dz) <= radialReach) {
        crossesFootprint = true;
        break;
      }
    }
    if (!crossesFootprint) continue;
    if (b.collapsed) return true;
    if (Number.isFinite(b.archSpan) && b.archSpan < requiredHalfBeam * 2.15) return true;
    const soffitY = Number.isFinite(b.soffitY) ? b.soffitY : (deckY - 0.35);
    if ((soffitY - surfY) < minClearance - 0.30 || (deckY - surfY) < minClearance) return true;
  }
  return false;
}

/**
 * Searches concentric rings up to `maxRadius` for safe water where `bed <= minDepth` with lateral `clearance`.
 * Returns `{ x, z }` on success, or `null` if no safe deep water exists within `maxRadius` (never returns raw inland coords).
 */
export function nearestSafeWater(
  wx,
  wz,
  minDepth = -2.6,
  minR = 0,
  maxRadius = 1800,
  clearance = 16,
  isSafeWaterFn = null,
) {
  if (typeof isSafeWaterFn !== 'function') return { x: wx, z: wz };
  if (minR <= 0 && isSafeWaterFn(wx, wz, minDepth, clearance)) return { x: wx, z: wz };
  const stepR = 22;
  for (let r = Math.max(stepR, minR); r <= maxRadius; r += stepR) {
    const samples = Math.max(16, Math.min(56, Math.ceil((2 * Math.PI * r) / 42)));
    for (let k = 0; k < samples; k++) {
      const ang = (k / samples) * Math.PI * 2;
      const cx = wx + Math.cos(ang) * r;
      const cz = wz + Math.sin(ang) * r;
      if (isSafeWaterFn(cx, cz, minDepth, clearance)) return { x: cx, z: cz };
    }
  }
  return null;
}

/**
 * Normalizes live board merchant ships (`W.ships`), sea/river caravans, and navigable `riverReaches`
 * into an ordered list of vessel route records for rendering or CPU verification.
 */
export function buildTradeVesselRoutes(
  snapshot,
  origin = { x: 0, z: 0 },
  {
    riverReaches = [],
    places = [],
    seaLevel = 0,
    heights = null,
    region = null,
    port = null,
    bridges = [],
    terrain = null,
    worldOffset = null,
    inlandWaterAt = null,
  } = {},
) {
  const routes = [];
  const ox = origin.x || 0, oz = origin.z || 0;
  const wOff = worldOffset || terrain?.getWorldOffset?.() || { x: 0, z: 0 };
  const offX = Number.isFinite(wOff?.x) ? wOff.x : 0;
  const offZ = Number.isFinite(wOff?.z) ? wOff.z : 0;
  const effInlandWaterAt = typeof inlandWaterAt === 'function'
    ? inlandWaterAt
    : (typeof terrain?.inlandWaterAt === 'function' ? (wx, wz) => terrain.inlandWaterAt(wx, wz) : null);
  const effectiveReaches = (Array.isArray(riverReaches) && riverReaches.length > 0)
    ? riverReaches
    : (Array.isArray(port?.country?.riverReaches) ? port.country.riverReaches : []);

  const hasHeightGrid = Boolean(heights && region && Number.isFinite(region.span) && region.span > 0);
  const bedRegion = hasHeightGrid
    ? (region.size ? region : { ...region, size: Math.round(Math.sqrt(heights.length)) })
    : null;
  // Align region lookup regardless of whether `region.x/z` was stored in land-local coords (matching `origin`)
  // or camera-world coords (`origin + worldOffset`).
  const regionUsesShiftedWorld = Boolean(
    bedRegion
    && (Math.abs(offX) > 1e-3 || Math.abs(offZ) > 1e-3)
    && Math.hypot((ox + offX) - (bedRegion.x || 0), (oz + offZ) - (bedRegion.z || 0))
       + 1 < Math.hypot(ox - (bedRegion.x || 0), oz - (bedRegion.z || 0)),
  );
  const hasBedSampler = Boolean(terrain?.height || terrain?.groundSample || (bedRegion && bedRegion.size));

  // Evaluates riverbed/seabed elevation at route-local coordinates `(lx, lz)` (where world = `(lx + offX, lz + offZ)`).
  const bedElevationAt = (lx, lz) => {
    if (terrain?.height) {
      const y = terrain.height(lx + offX, lz + offZ);
      if (Number.isFinite(y)) return y;
    }
    if (terrain?.groundSample) {
      const y = terrain.groundSample(lx + offX, lz + offZ);
      if (Number.isFinite(y)) return y;
    }
    if (!bedRegion || !bedRegion.size) return -12;
    const qx = regionUsesShiftedWorld ? lx + offX : lx;
    const qz = regionUsesShiftedWorld ? lz + offZ : lz;
    const half = bedRegion.span * 0.5 - 0.5;
    if (Math.abs(qx - bedRegion.x) > half + 2 || Math.abs(qz - bedRegion.z) > half + 2) {
      // Outside local terrain heightmap: open sea stays deep when coastal side is wet, inland stays clamped to edge height.
      const cx = Math.max(bedRegion.x - half, Math.min(bedRegion.x + half, qx));
      const cz = Math.max(bedRegion.z - half, Math.min(bedRegion.z + half, qz));
      const edgeY = terrainSurfaceSample(heights, cx, cz, bedRegion);
      return Number.isFinite(edgeY) ? edgeY : -12;
    }
    const y = terrainSurfaceSample(heights, qx, qz, bedRegion);
    return Number.isFinite(y) ? y : -12;
  };

  // Bridge list normalized into route-local coordinates `(lx, lz)` matching `origin`.
  const normBridges = (bridges ?? []).map((b) => {
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) return null;
    if ((Math.abs(offX) > 1e-3 || Math.abs(offZ) > 1e-3)
        && Math.hypot((b.x - offX) - ox, (b.z - offZ) - oz) + 50 < Math.hypot(b.x - ox, b.z - oz)) {
      return { ...b, x: b.x - offX, z: b.z - offZ };
    }
    return b;
  }).filter(Boolean);

  const dockBerth = port?.dockBerth || null;
  const berthX = dockBerth ? (dockBerth.wx ?? dockBerth.x ?? NaN) : NaN;
  const berthZ = dockBerth ? (dockBerth.wz ?? dockBerth.z ?? NaN) : NaN;

  const parseFlatPairs = (arr) => {
    const out = [];
    for (let i = 0; i + 1 < arr.length; i += 2) out.push({ x: arr[i], z: arr[i + 1] });
    return out;
  };
  const reachStations = (r) => {
    const seaConn = Boolean(r?.seaConnected);
    const normStation = (wxRaw, wzRaw, hwRaw, wyRaw, depthRaw, vx, vz, thalwegB, estuaryTRaw, seaMouthRaw) => {
      let wx = wxRaw, wz = wzRaw;
      if ((Math.abs(offX) > 1e-3 || Math.abs(offZ) > 1e-3)
          && Math.hypot((wx - offX) - ox, (wz - offZ) - oz) + 50 < Math.hypot(wx - ox, wz - oz)) {
        wx -= offX;
        wz -= offZ;
      }
      const hw = Number.isFinite(hwRaw) ? hwRaw : (r?.minHalfWidth ?? 2.5);
      const wy = Number.isFinite(wyRaw) ? wyRaw : seaLevel;
      const depth = Number.isFinite(depthRaw) ? depthRaw : Math.max(0.85, hw * 0.42);
      const estuaryT = Number.isFinite(estuaryTRaw)
        ? estuaryTRaw
        : (seaConn && wy <= seaLevel + 0.35 ? Math.max(0, 1 - Math.max(0, wy - seaLevel) / 0.35) : 0);
      const seaMouth = Boolean(seaMouthRaw ?? (seaConn && (estuaryT > 0.45 || wy <= seaLevel + 0.08)));
      return {
        wx,
        wz,
        hw,
        wy: seaMouth && estuaryT > 0.72 ? seaLevel + (wy - seaLevel) * Math.max(0, (1 - estuaryT) / 0.28) : wy,
        depth,
        thalweg: Number.isFinite(thalwegB) ? thalwegB : 0,
        vx: Number.isFinite(vx) ? vx : NaN,
        vz: Number.isFinite(vz) ? vz : NaN,
        estuaryT,
        seaMouth,
      };
    };
    if (Array.isArray(r?.stations)) {
      return r.stations.map((s) => normStation(
        s.wx ?? s.x, s.wz ?? s.z, s.hw, s.wy ?? s.y, s.depth, s.vx, s.vz, s.thalweg, s.estuaryT, s.seaMouth,
      ));
    }
    if (Array.isArray(r?.points)) {
      return r.points.map(([wx, wz, hw, wy, p4, vx, vz, thalwegB, estuaryT]) =>
        normStation(wx, wz, hw, wy, p4, vx, vz, thalwegB, estuaryT, undefined));
    }
    return [];
  };
  const parsedReachChains = effectiveReaches.map((r) => reachStations(r)).filter((sts) => sts.length >= 2);
  const riverSampleAt = (lx, lz) => {
    if (effInlandWaterAt) {
      const iw = effInlandWaterAt(lx + offX, lz + offZ);
      if (iw && Number.isFinite(iw.wy)) {
        if (!Number.isFinite(iw.hw) || !Number.isFinite(iw.dist) || iw.dist <= iw.hw * 0.92) {
          return iw;
        }
      }
    }
    let bestFrac = Infinity, bestSample = null;
    for (let ci = 0; ci < parsedReachChains.length; ci++) {
      const sts = parsedReachChains[ci];
      for (let i = 1; i < sts.length; i++) {
        const a = sts[i - 1], b = sts[i];
        const dx = b.wx - a.wx, dz = b.wz - a.wz;
        const lenSq = dx * dx + dz * dz;
        const u = lenSq > 1e-6 ? Math.max(0, Math.min(1, ((lx - a.wx) * dx + (lz - a.wz) * dz) / lenSq)) : 0;
        const px = a.wx + dx * u, pz = a.wz + dz * u;
        const dist = Math.hypot(lx - px, lz - pz);
        const hw = Math.max(0.5, a.hw + (b.hw - a.hw) * u);
        if (dist <= hw * 0.92) {
          const frac = dist / hw;
          if (frac < bestFrac) {
            bestFrac = frac;
            const wy = a.wy + (b.wy - a.wy) * u;
            const depth = a.depth + (b.depth - a.depth) * u;
            const vx = (Number.isFinite(a.vx) && Number.isFinite(b.vx)) ? a.vx + (b.vx - a.vx) * u : (Number.isFinite(a.vx) ? a.vx : b.vx);
            const vz = (Number.isFinite(a.vz) && Number.isFinite(b.vz)) ? a.vz + (b.vz - a.vz) * u : (Number.isFinite(a.vz) ? a.vz : b.vz);
            const estuaryT = a.estuaryT + (b.estuaryT - a.estuaryT) * u;
            bestSample = { wy, hw, depth, vx, vz, estuaryT, dist, seaMouth: Boolean(a.seaMouth || b.seaMouth) };
          }
        }
      }
    }
    return bestSample;
  };
  const riverYAt = (lx, lz) => {
    const rs = riverSampleAt(lx, lz);
    return rs && Number.isFinite(rs.wy) ? rs.wy : seaLevel;
  };

  // True when `(lx, lz)` has deep open/estuary water (`bed <= minDepth`, not perched above sea level in a narrow upland river).
  const isSafeWater = (lx, lz, minDepth = -2.6, clearance = 16) => {
    if (Number.isFinite(berthX) && Number.isFinite(berthZ) && Math.hypot(lx - berthX, lz - berthZ) < 52) {
      return false;
    }
    if (!hasBedSampler) {
      // Without a terrain sampler, still reject narrow/perched inland river channels for sea ships.
      const rs = riverSampleAt(lx, lz);
      if (rs && ((rs.wy > seaLevel + 0.35) || (Number.isFinite(rs.hw) && rs.hw < Math.max(12, clearance)))) {
        return false;
      }
      return true;
    }
    const bed = bedElevationAt(lx, lz);
    if (bed > minDepth) return false;
    // Reject perched river channels (`wy > seaLevel + 0.45 m` or narrow `hw < clearance`) even if thalweg was carved deeply.
    const rs = riverSampleAt(lx, lz);
    if (rs && ((rs.wy > seaLevel + 0.45) || (Number.isFinite(rs.hw) && rs.hw < Math.max(12, clearance * 0.85)))) {
      return false;
    }
    if (clearance > 0) {
      const diag = clearance * 0.7071;
      if (bedElevationAt(lx + clearance, lz) > minDepth + 0.35) return false;
      if (bedElevationAt(lx - clearance, lz) > minDepth + 0.35) return false;
      if (bedElevationAt(lx, lz + clearance) > minDepth + 0.35) return false;
      if (bedElevationAt(lx, lz - clearance) > minDepth + 0.35) return false;
      if (bedElevationAt(lx + diag, lz + diag) > minDepth + 0.45) return false;
      if (bedElevationAt(lx - diag, lz + diag) > minDepth + 0.45) return false;
      if (bedElevationAt(lx + diag, lz - diag) > minDepth + 0.45) return false;
      if (bedElevationAt(lx - diag, lz - diag) > minDepth + 0.45) return false;
    }
    return true;
  };

  const findNearestSafeWater = (lx, lz, minDepth = -2.6, minR = 0, maxRadius = 1800, clearance = 16) =>
    nearestSafeWater(lx, lz, minDepth, minR, maxRadius, clearance, isSafeWater);

  const isSegmentSafeWater = (a, b, minDepth = -1.8, clearance = 14) => {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(4, Math.min(96, Math.ceil(dist / 18)));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      if (!isSafeWater(a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u, minDepth, clearance)) return false;
    }
    return true;
  };

  const archAirDraft = (archIdx, scale = 1) => {
    const a = getTradeVesselArchetype(archIdx);
    return (a?.maxAirDraftMetres ?? (archIdx === 4 ? 2.15 : 18.0)) * (scale || 1);
  };
  const archHalfBeam = (archIdx, scale = 1) => {
    const a = getTradeVesselArchetype(archIdx);
    return Math.max(1.2, (a?.beam ?? 4.8) * 0.5 * (scale || 1));
  };

  /**
   * Clamps a sea polyline to deep, bridge-clear water:
   * - Drops/truncates any inland endpoint or segment where `nearestSafeWater` returns `null`,
   *   where `isSegmentSafeWater` fails across sandbars/land, OR where `blockedByLowBridge` triggers!
   */
  const clampSeaPolyToSafeWater = (
    poly,
    minDepth = -2.4,
    clearance = 16,
    airDraft = 18.0,
    halfBeam = 2.8,
  ) => {
    if (!poly || !Array.isArray(poly.pts) || poly.pts.length < 2) return null;
    const rawPts = poly.pts;
    const segMinDepth = Math.min(-1.5, minDepth + 0.35);
    const segClearance = Math.max(8, clearance * 0.72);

    const traceFrom = (ordered) => {
      const kept = [];
      let started = false;
      for (let i = 0; i < ordered.length; i++) {
        const p = ordered[i];
        const snapR = !started ? 1800 : 420;
        const safe = findNearestSafeWater(p.x, p.z, minDepth, 0, snapR, clearance);
        if (!safe) {
          if (started) break;
          continue;
        }
        const surfY = Math.max(seaLevel, riverYAt(safe.x, safe.z) - 0.04);
        if (blockedByLowBridge(safe.x, safe.z, safe.x, safe.z, surfY, airDraft, halfBeam, normBridges)) {
          if (started) break;
          continue;
        }
        if (!started) {
          kept.push({ x: safe.x, y: seaLevel, z: safe.z });
          started = true;
          continue;
        }
        const prev = kept[kept.length - 1];
        const d = Math.hypot(safe.x - prev.x, safe.z - prev.z);
        if (d < 0.75 && i < ordered.length - 1) continue;
        const segSurfY = Math.max(seaLevel, riverYAt((prev.x + safe.x) * 0.5, (prev.z + safe.z) * 0.5) - 0.04);
        const segOk = isSegmentSafeWater(prev, safe, segMinDepth, segClearance)
          && !blockedByLowBridge(prev.x, prev.z, safe.x, safe.z, segSurfY, airDraft, halfBeam, normBridges);
        if (segOk) {
          kept.push({ x: safe.x, y: seaLevel, z: safe.z });
        } else {
          // Binary-search furthest safe point along `prev -> safe` right before shoal / bridge mouth and truncate!
          let lo = 0, hi = 1;
          for (let it = 0; it < 7; it++) {
            const mid = (lo + hi) * 0.5;
            const cand = { x: prev.x + (safe.x - prev.x) * mid, z: prev.z + (safe.z - prev.z) * mid };
            const cSurf = Math.max(seaLevel, riverYAt(cand.x, cand.z) - 0.04);
            if (isSafeWater(cand.x, cand.z, segMinDepth, segClearance)
                && isSegmentSafeWater(prev, cand, segMinDepth, segClearance)
                && !blockedByLowBridge(prev.x, prev.z, cand.x, cand.z, cSurf, airDraft, halfBeam, normBridges)) {
              lo = mid;
            } else {
              hi = mid;
            }
          }
          if (lo > 0.08) {
            const stopX = prev.x + (safe.x - prev.x) * lo;
            const stopZ = prev.z + (safe.z - prev.z) * lo;
            if (Math.hypot(stopX - prev.x, stopZ - prev.z) >= 8) {
              kept.push({ x: stopX, y: seaLevel, z: stopZ });
            }
          }
          break;
        }
      }
      return kept;
    };

    // Walk from whichever end starts in open safe water so inland river tails are truncated cleanly.
    const firstSafe = isSafeWater(rawPts[0].x, rawPts[0].z, minDepth, clearance);
    const lastSafe = isSafeWater(rawPts[rawPts.length - 1].x, rawPts[rawPts.length - 1].z, minDepth, clearance);
    let finalPts;
    if (!firstSafe && lastSafe) {
      finalPts = traceFrom(rawPts.slice().reverse()).reverse();
    } else {
      finalPts = traceFrom(rawPts);
      if (finalPts.length < 2 && lastSafe) {
        finalPts = traceFrom(rawPts.slice().reverse()).reverse();
      }
    }
    if (!finalPts || finalPts.length < 2) return null;
    let acc = 0;
    const pts = finalPts.map((p, idx) => {
      if (idx > 0) acc += Math.hypot(p.x - finalPts[idx - 1].x, p.z - finalPts[idx - 1].z);
      return { x: p.x, y: seaLevel, z: p.z, acc };
    });
    return acc >= 24 ? { pts, totalLen: acc } : null;
  };

  /**
   * Enforces bridge air-draft, horizontal span clearance, and wet river bed across fallback river routes
   * (used only in synthetic tests when `effectiveReaches` is empty).
   */
  const clampRiverPolyToSafeChannel = (poly, airDraft = 2.15, halfBeam = 1.5) => {
    if (!poly || !Array.isArray(poly.pts) || poly.pts.length < 2) return null;
    const runs = [];
    let cur = [];
    const flushRun = () => {
      if (cur.length >= 2) {
        let len = 0;
        const built = cur.map((p, idx) => {
          if (idx > 0) len += Math.hypot(p.x - cur[idx - 1].x, p.z - cur[idx - 1].z);
          return { ...p, acc: len };
        });
        if (len >= 65) runs.push({ pts: built, totalLen: len });
      }
      cur = [];
    };
    for (let i = 0; i < poly.pts.length; i++) {
      const p = poly.pts[i];
      const surfY = Number.isFinite(p.y) ? p.y : riverYAt(p.x, p.z);
      const ptBlocked = blockedByLowBridge(p.x, p.z, p.x, p.z, surfY, airDraft, halfBeam, normBridges)
        || (hasBedSampler && !riverSampleAt(p.x, p.z) && bedElevationAt(p.x, p.z) > surfY - 0.35);
      if (ptBlocked) {
        flushRun();
        continue;
      }
      if (cur.length > 0) {
        const prev = cur[cur.length - 1];
        const midSurfY = Math.max(prev.y ?? surfY, surfY, riverYAt((prev.x + p.x) * 0.5, (prev.z + p.z) * 0.5));
        if (blockedByLowBridge(prev.x, prev.z, p.x, p.z, midSurfY, airDraft, halfBeam, normBridges)) {
          flushRun();
          cur.push({ ...p, y: surfY });
          continue;
        }
      }
      cur.push({ ...p, y: surfY });
    }
    flushRun();
    if (!runs.length) return null;
    runs.sort((a, b) => b.totalLen - a.totalLen);
    return runs[0];
  };

  // Build topological graph of rendered `riverReaches` stations (pruning reaches narrower than `hw < 2.2 m`
  // or shallower than `depth < 0.55 m`, and subdividing to dense `<= 3.2 m` station spacing).
  const MIN_RIVER_HW = 2.2;
  const MIN_RIVER_DEPTH = 0.55;
  const DENSE_RIVER_STEP = 3.2;
  const minNavScale = 0.62;
  const minNavAir = archAirDraft(4, minNavScale);
  const minNavHalfBeam = archHalfBeam(4, minNavScale);
  const navSubChains = [];
  const riverGraphNodes = [];

  const interpReachStation = (a, b, u) => {
    const estuaryT = a.estuaryT + (b.estuaryT - a.estuaryT) * u;
    const seaMouth = Boolean(a.seaMouth || b.seaMouth || estuaryT > 0.72);
    const rawWy = a.wy + (b.wy - a.wy) * u;
    const wy = seaMouth && estuaryT > 0.72
      ? seaLevel + (rawWy - seaLevel) * Math.max(0, (1 - estuaryT) / 0.28)
      : rawWy;
    return {
      wx: a.wx + (b.wx - a.wx) * u,
      wz: a.wz + (b.wz - a.wz) * u,
      hw: a.hw + (b.hw - a.hw) * u,
      wy,
      depth: a.depth + (b.depth - a.depth) * u,
      thalweg: a.thalweg + (b.thalweg - a.thalweg) * u,
      vx: (Number.isFinite(a.vx) && Number.isFinite(b.vx)) ? a.vx + (b.vx - a.vx) * u : (Number.isFinite(a.vx) ? a.vx : b.vx),
      vz: (Number.isFinite(a.vz) && Number.isFinite(b.vz)) ? a.vz + (b.vz - a.vz) * u : (Number.isFinite(a.vz) ? a.vz : b.vz),
      estuaryT,
      seaMouth,
    };
  };

  for (let ci = 0; ci < parsedReachChains.length; ci++) {
    const rawSts = parsedReachChains[ci];
    const dense = [];
    for (let i = 0; i < rawSts.length; i++) {
      if (i === 0) {
        dense.push(rawSts[0]);
        continue;
      }
      const a = rawSts[i - 1], b = rawSts[i];
      const segD = Math.hypot(b.wx - a.wx, b.wz - a.wz);
      const nSteps = Math.max(1, Math.ceil(segD / DENSE_RIVER_STEP));
      for (let k = 1; k <= nSteps; k++) {
        dense.push(k === nSteps ? b : interpReachStation(a, b, k / nSteps));
      }
    }
    let curSeg = [];
    const flushSub = () => {
      if (curSeg.length >= 3) {
        let len = 0, minHw = Infinity;
        for (let i = 0; i < curSeg.length; i++) {
          minHw = Math.min(minHw, curSeg[i].hw);
          if (i > 0) len += Math.hypot(curSeg[i].wx - curSeg[i - 1].wx, curSeg[i].wz - curSeg[i - 1].wz);
        }
        if (len >= 65) {
          const subIdx = navSubChains.length;
          const nodeIds = [];
          for (let i = 0; i < curSeg.length; i++) {
            const nid = riverGraphNodes.length;
            riverGraphNodes.push({
              id: nid,
              subIdx,
              ...curSeg[i],
              adj: [],
              comp: -1,
            });
            nodeIds.push(nid);
            if (i > 0) {
              const prevId = nodeIds[i - 1];
              const w = Math.hypot(curSeg[i].wx - curSeg[i - 1].wx, curSeg[i].wz - curSeg[i - 1].wz);
              riverGraphNodes[prevId].adj.push({ to: nid, w });
              riverGraphNodes[nid].adj.push({ to: prevId, w });
            }
          }
          navSubChains.push({ stations: curSeg.slice(), nodeIds, length: len, minHw });
        }
      }
      curSeg = [];
    };
    for (let i = 0; i < dense.length; i++) {
      const s = dense[i];
      const prev = curSeg.length > 0 ? curSeg[curSeg.length - 1] : s;
      const midWy = Math.max(prev.wy, s.wy);
      const navOk = s.hw >= MIN_RIVER_HW
        && s.depth >= MIN_RIVER_DEPTH
        && !blockedByLowBridge(prev.wx, prev.wz, s.wx, s.wz, midWy, minNavAir, minNavHalfBeam, normBridges);
      if (navOk) curSeg.push(s);
      else flushSub();
    }
    flushSub();
  }

  // Link river confluences & junctions strictly where water ribbons overlap without crossing dry banks.
  for (let si = 0; si < navSubChains.length; si++) {
    const cA = navSubChains[si];
    const endCandidates = [cA.nodeIds[0], cA.nodeIds[cA.nodeIds.length - 1]];
    for (const aId of endCandidates) {
      const a = riverGraphNodes[aId];
      let bestId = -1, bestD = Infinity;
      for (let sj = 0; sj < navSubChains.length; sj++) {
        if (sj === si) continue;
        const cB = navSubChains[sj];
        for (let k = 0; k < cB.nodeIds.length; k++) {
          const bId = cB.nodeIds[k];
          const b = riverGraphNodes[bId];
          const d = Math.hypot(b.wx - a.wx, b.wz - a.wz);
          const maxJoin = Math.min(18, (a.hw + b.hw) * 0.95);
          if (d < bestD && d <= maxJoin && Math.abs(b.wy - a.wy) <= 1.2) {
            const mx = (a.wx + b.wx) * 0.5, mz = (a.wz + b.wz) * 0.5;
            if ((d <= 3.6 || riverSampleAt(mx, mz))
                && !blockedByLowBridge(a.wx, a.wz, b.wx, b.wz, Math.max(a.wy, b.wy), minNavAir, minNavHalfBeam, normBridges)) {
              bestD = d;
              bestId = bId;
            }
          }
        }
      }
      if (bestId >= 0) {
        a.adj.push({ to: bestId, w: Math.max(0.1, bestD) });
        riverGraphNodes[bestId].adj.push({ to: aId, w: Math.max(0.1, bestD) });
      }
    }
  }

  const riverGraphComponents = [];
  for (let i = 0; i < riverGraphNodes.length; i++) {
    if (riverGraphNodes[i].comp >= 0) continue;
    const compId = riverGraphComponents.length;
    const queue = [i];
    riverGraphNodes[i].comp = compId;
    const members = [];
    let edgeSum = 0;
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      members.push(u);
      for (const e of riverGraphNodes[u].adj) {
        edgeSum += e.w;
        if (riverGraphNodes[e.to].comp < 0) {
          riverGraphNodes[e.to].comp = compId;
          queue.push(e.to);
        }
      }
    }
    riverGraphComponents.push({ id: compId, nodes: members, approxLen: edgeSum * 0.5 });
  }

  const dijkstraRiverFrom = (startId) => {
    const N = riverGraphNodes.length;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const visited = new Uint8Array(N);
    dist[startId] = 0;
    const compId = riverGraphNodes[startId].comp;
    const compNodes = riverGraphComponents[compId]?.nodes ?? [];
    for (let step = 0; step < compNodes.length; step++) {
      let u = -1, best = Infinity;
      for (let k = 0; k < compNodes.length; k++) {
        const cand = compNodes[k];
        if (!visited[cand] && dist[cand] < best) {
          best = dist[cand];
          u = cand;
        }
      }
      if (u < 0) break;
      visited[u] = 1;
      for (const e of riverGraphNodes[u].adj) {
        const nd = best + e.w;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = u;
        }
      }
    }
    return { dist, prev };
  };

  const buildDenseRouteFromNodePath = (nodePath, desiredScale) => {
    if (!nodePath || nodePath.length < 2) return null;
    const expanded = [];
    let minHw = Infinity;
    for (let i = 0; i < nodePath.length; i++) {
      const cur = riverGraphNodes[nodePath[i]];
      minHw = Math.min(minHw, cur.hw);
      if (i === 0) {
        expanded.push(cur);
        continue;
      }
      const prev = riverGraphNodes[nodePath[i - 1]];
      const segD = Math.hypot(cur.wx - prev.wx, cur.wz - prev.wz);
      const steps = Math.max(1, Math.ceil(segD / DENSE_RIVER_STEP));
      for (let k = 1; k <= steps; k++) {
        expanded.push(k === steps ? cur : interpReachStation(prev, cur, k / steps));
      }
    }
    const bargeBaseBeam = getTradeVesselArchetype(4).beam || 3.0;
    const maxBeamScale = Math.max(0.58, (minHw - 0.55) / (bargeBaseBeam * 0.5));
    const effScale = Math.max(0.58, Math.min(desiredScale, maxBeamScale));
    const reqAir = archAirDraft(4, effScale);
    const reqHalfBeam = archHalfBeam(4, effScale);

    const runs = [];
    let curRun = [];
    const flush = () => {
      if (curRun.length >= 2) {
        let acc = 0;
        const pts = curRun.map((s, idx) => {
          if (idx > 0) acc += Math.hypot(s.wx - curRun[idx - 1].wx, s.wz - curRun[idx - 1].wz);
          return {
            x: s.wx,
            y: s.wy,
            z: s.wz,
            hw: s.hw,
            depth: s.depth,
            vx: s.vx,
            vz: s.vz,
            estuaryT: s.estuaryT,
            seaMouth: Boolean(s.seaMouth),
            acc,
          };
        });
        if (acc >= 65) runs.push({ pts, totalLen: acc, scale: effScale });
      }
      curRun = [];
    };
    for (let i = 0; i < expanded.length; i++) {
      const s = expanded[i];
      const prev = curRun.length > 0 ? curRun[curRun.length - 1] : s;
      const surfY = Math.max(prev.wy, s.wy);
      if (blockedByLowBridge(prev.wx, prev.wz, s.wx, s.wz, surfY, reqAir, reqHalfBeam, normBridges)) {
        flush();
        if (!blockedByLowBridge(s.wx, s.wz, s.wx, s.wz, s.wy, reqAir, reqHalfBeam, normBridges)) {
          curRun.push(s);
        }
      } else {
        curRun.push(s);
      }
    }
    flush();
    if (!runs.length) return null;
    runs.sort((a, b) => b.totalLen - a.totalLen);
    return runs[0];
  };

  const routeOnRiverGraph = (rawPairs, desiredScale = 0.96) => {
    if (!riverGraphNodes.length || !Array.isArray(rawPairs) || rawPairs.length < 2) return null;
    const sx = ox + rawPairs[0].x, sz = oz + rawPairs[0].z;
    const ex = ox + rawPairs[rawPairs.length - 1].x, ez = oz + rawPairs[rawPairs.length - 1].z;
    const mx = ox + rawPairs[rawPairs.length >> 1].x, mz = oz + rawPairs[rawPairs.length >> 1].z;

    let bestComp = null;
    let bestScore = Infinity;
    for (let ci = 0; ci < riverGraphComponents.length; ci++) {
      const comp = riverGraphComponents[ci];
      if (comp.approxLen < 65) continue;
      let sNode = -1, sD = Infinity;
      let eNode = -1, eD = Infinity;
      let mD = Infinity;
      for (const nid of comp.nodes) {
        const n = riverGraphNodes[nid];
        const ds = Math.hypot(n.wx - sx, n.wz - sz);
        const de = Math.hypot(n.wx - ex, n.wz - ez);
        const dm = Math.hypot(n.wx - mx, n.wz - mz);
        if (ds < sD) { sD = ds; sNode = nid; }
        if (de < eD) { eD = de; eNode = nid; }
        if (dm < mD) mD = dm;
      }
      const score = Math.min(sD + eD, mD * 2 + Math.min(sD, eD));
      if (score < bestScore) {
        bestScore = score;
        bestComp = { comp, compIdx: ci, sNode, eNode, sD, eD };
      }
    }
    if (!bestComp || Math.min(bestComp.sD, bestComp.eD) > 900) return null;

    const { dist, prev } = dijkstraRiverFrom(bestComp.sNode);
    let targetNode = bestComp.eNode;
    if (!Number.isFinite(dist[targetNode]) || dist[targetNode] < 65) {
      let farNode = -1, farDist = 0;
      for (const nid of bestComp.comp.nodes) {
        if (Number.isFinite(dist[nid]) && dist[nid] > farDist) {
          farDist = dist[nid];
          farNode = nid;
        }
      }
      if (farDist < 65 || farNode < 0) return null;
      targetNode = farNode;
    }

    const nodePath = [];
    const subIndices = new Set();
    for (let cur = targetNode; cur >= 0; cur = prev[cur]) {
      nodePath.push(cur);
      if (Number.isInteger(riverGraphNodes[cur]?.subIdx)) subIndices.add(riverGraphNodes[cur].subIdx);
      if (cur === bestComp.sNode) break;
    }
    nodePath.reverse();
    const built = buildDenseRouteFromNodePath(nodePath, desiredScale);
    if (!built) return null;
    return { ...built, compIdx: bestComp.compIdx, subIndices };
  };

  const harborBySlot = new Map();
  for (const h of snapshot?.harborFleet ?? []) {
    if (h?.slot) harborBySlot.set(h.slot, h);
  }

  // Track occupied sea berths across docked `ship:*` & `roadstead:*` vessels so zero hulls snap onto the identical safeB coordinate.
  const MIN_DOCK_BERTH_SPACING = 42.0;
  const occupiedBerths = [];
  if (dockBerth && Number.isFinite(berthX) && Number.isFinite(berthZ)) {
    occupiedBerths.push({ x: berthX, z: berthZ });
  }
  const resolveUnoccupiedBerth = (rawX, rawZ, rot = 0, minDepth = -2.6, clearance = 16, reqAir = 16, reqHalfBeam = 2.5, minSpacing = MIN_DOCK_BERTH_SPACING) => {
    const isClearSpot = (cx, cz) => (
      !blockedByLowBridge(cx, cz, cx, cz, seaLevel, reqAir, reqHalfBeam, normBridges)
      && occupiedBerths.every((b) => Math.hypot(b.x - cx, b.z - cz) >= minSpacing)
    );
    const safe0 = findNearestSafeWater(rawX, rawZ, minDepth, 0, 1800, clearance);
    if (safe0 && isClearSpot(safe0.x, safe0.z)) return safe0;
    const baseX = safe0 ? safe0.x : rawX;
    const baseZ = safe0 ? safe0.z : rawZ;
    const baseAng = rot || 0;
    for (const dist of [46, 90, 136, 186, 242, 308, 385]) {
      for (let a = 0; a < 16; a++) {
        // Alternate along-quay directions (+/-rot) first before fanning outward into the anchorage
        const step = (a & 1) ? -((a + 1) >> 1) : (a >> 1);
        const ang = baseAng + (step / 16) * Math.PI * 2;
        const qx = baseX + Math.sin(ang) * dist;
        const qz = baseZ - Math.cos(ang) * dist;
        if (isSafeWater(qx, qz, minDepth, clearance) && isClearSpot(qx, qz)) {
          return { x: qx, z: qz };
        }
        const nudged = findNearestSafeWater(qx, qz, minDepth, 0, 95, clearance);
        if (nudged && isClearSpot(nudged.x, nudged.z)) {
          return nudged;
        }
      }
    }
    return null;
  };

  for (const sh of snapshot?.ships ?? []) {
    if (routes.length >= MAX_TRADE_VESSELS) break;
    const carrack = sh.kind === 'carrack' || sh.kind === 'hulk';
    const scale = sh.kind === 'carrack' ? 1.08 : sh.kind === 'hulk' ? 0.98 : sh.kind === 'great cog' ? 0.96 : 0.88;
    const archIdx = sh.phase === 'dock' ? (carrack ? 3 : 1) : (carrack ? 2 : 0);
    const reqAir = archAirDraft(archIdx, scale);
    const reqHalfBeam = archHalfBeam(archIdx, scale);
    const minDepth = carrack ? -2.8 : -2.4;
    const clearance = carrack ? 20 : 14;
    const berthClear = carrack ? 22 : 16;
    const rawPoly = Array.isArray(sh.points) && sh.points.length >= 4
      ? buildPolylineRoute(parseFlatPairs(sh.points), { x: ox, z: oz }, () => seaLevel)
      : null;
    const poly = rawPoly ? clampSeaPolyToSafeWater(rawPoly, minDepth, clearance, reqAir, reqHalfBeam) : null;
    const portBerths = Array.isArray(sh.portBerths)
      ? sh.portBerths.map((b) => {
          const safeB = findNearestSafeWater(ox + b.x, oz + b.z, -2.6, 0, 1800, berthClear);
          if (!safeB || blockedByLowBridge(safeB.x, safeB.z, safeB.x, safeB.z, seaLevel, reqAir, reqHalfBeam, normBridges)) {
            return null;
          }
          if (occupiedBerths.some((ob) => Math.hypot(ob.x - safeB.x, ob.z - safeB.z) < MIN_DOCK_BERTH_SPACING)) {
            const alt = resolveUnoccupiedBerth(safeB.x, safeB.z, b.rot || 0, -2.6, berthClear, reqAir, reqHalfBeam, MIN_DOCK_BERTH_SPACING);
            if (!alt) return null;
            return { x: alt.x, y: seaLevel, z: alt.z, rot: b.rot || 0, shore: Boolean(b.shore) };
          }
          return { x: safeB.x, y: seaLevel, z: safeB.z, rot: b.rot || 0, shore: Boolean(b.shore) };
        }).filter(Boolean)
      : [];
    const shipMeta = {
      shipName: sh.shipName || '',
      homePort: sh.homePort || sh.from || '',
      from: sh.from || '',
      to: sh.to || '',
      kind: sh.kind || 'cog',
      tonnage: sh.tonnage || 0,
      cargo: sh.cargo ? { ...sh.cargo } : {},
      load: sh.load ? { ...sh.load } : {},
      captain: sh.captain ?? null,
      merchant: sh.merchant ?? null,
      crew: Array.isArray(sh.crew) ? sh.crew : [],
      pilot: sh.captain ?? null,
    };
    if (sh.phase === 'dock' && sh.berth) {
      const safeB = resolveUnoccupiedBerth(
        ox + sh.berth.x, oz + sh.berth.z, sh.berth.rot || 0, -2.6, berthClear, reqAir, reqHalfBeam, MIN_DOCK_BERTH_SPACING,
      );
      if (!safeB) continue;
      occupiedBerths.push({ x: safeB.x, z: safeB.z });
      routes.push({
        id: `ship:${sh.id}`, shipId: sh.id, mode: 'sea', phase: 'dock',
        archetype: archIdx,
        scale,
        depart: sh.t0 ?? 0, arrive: sh.t1 ?? 1, until: sh.until ?? 0, waited: sh.waited ?? 0, bi: sh.bi ?? -1,
        berth: { x: safeB.x, y: seaLevel, z: safeB.z, rot: sh.berth.rot || 0, shore: Boolean(sh.berth.shore) },
        portBerths,
        pts: poly?.pts ?? null, totalLen: poly?.totalLen ?? 0,
        phaseOffset: (hashU32(sh.id | 0, 17) % 1000) / 1000,
        ...shipMeta,
      });
      continue;
    }
    if (!poly) continue;
    routes.push({
      id: `ship:${sh.id}`, shipId: sh.id, mode: 'sea', phase: sh.phase === 'out' ? 'out' : 'in',
      archetype: archIdx,
      scale,
      depart: sh.t0 ?? 0, arrive: sh.t1 ?? 1, until: sh.until ?? 0, waited: sh.waited ?? 0, bi: sh.bi ?? -1,
      berth: null,
      portBerths,
      pts: poly.pts, totalLen: poly.totalLen,
      phaseOffset: (hashU32(sh.id | 0, 29) % 1000) / 1000,
      ...shipMeta,
    });
  }

  // Synthesize primary deep-water harbor roadstead moorings & local shuttles BEFORE inland caravans/riverboats
  // so every loop strictly obeys `routes.length < MAX_TRADE_VESSELS` without evicting harbor vessels.
  const harbors = (places ?? []).filter((p) => p && (p.harbor || p.harbour));
  const fallbackCoastal = harbors.length === 0
    ? (places ?? []).filter((p) =>
        p && !p.riverside && (p.kind === 'capital' || p.kind === 'town')
        && findNearestSafeWater(p.x, p.z, -2.6, 0, 420, 16) !== null)
    : [];
  const seaHarbors = harbors.length ? harbors : fallbackCoastal;
  const primary = seaHarbors[0]
    || (dockBerth && Number.isFinite(berthX) && Number.isFinite(berthZ) ? { x: berthX, z: berthZ, kind: 'town', harbor: true } : null);
  if (primary && routes.length < MAX_TRADE_VESSELS) {
    const hx = primary.x, hz = primary.z;
    {
      let addedAnchor = 0;
      const anchorSpots = [];
      for (let dist = 190; dist <= 640 && addedAnchor < 4 && routes.length < MAX_TRADE_VESSELS; dist += 90) {
        for (let a = 0; a < 16 && addedAnchor < 4 && routes.length < MAX_TRADE_VESSELS; a++) {
          const ang = (a / 16) * Math.PI * 2 + dist * 0.017;
          const ax = hx + Math.cos(ang) * dist;
          const az = hz + Math.sin(ang) * dist;
          const arch = (addedAnchor % 2 === 0) ? 3 : 1;
          const archScale = arch === 3 ? 1.04 : 0.94;
          if (!isSafeWater(ax, az, -3.0, 22)) continue;
          if (blockedByLowBridge(ax, az, ax, az, seaLevel, archAirDraft(arch, archScale), archHalfBeam(arch, archScale), normBridges)) continue;
          if (dockBerth && Number.isFinite(berthX) && Number.isFinite(berthZ) && Math.hypot(berthX - ax, berthZ - az) < 85) continue;
          if (occupiedBerths.some((e) => Math.hypot(e.x - ax, e.z - az) < 60)) continue;
          if (anchorSpots.some((e) => Math.hypot(e.x - ax, e.z - az) < 80)) continue;
          anchorSpots.push({ x: ax, z: az });
          occupiedBerths.push({ x: ax, z: az });
          const slotId = `roadstead:${addedAnchor}`;
          const hf = harborBySlot.get(slotId);
          routes.push({
            id: slotId, mode: 'sea', phase: 'dock',
            archetype: arch, scale: archScale,
            depart: 0, arrive: 1,
            berth: { x: ax, y: seaLevel, z: az, rot: ang + Math.PI * 0.5 + (addedAnchor * 0.35) },
            pts: null, totalLen: 0,
            phaseOffset: ((hashU32(addedAnchor + 11, 71) % 1000) / 1000),
            shipName: hf?.shipName || '',
            homePort: hf?.homePort || '',
            kind: arch === 3 ? 'carrack' : 'great cog',
            captain: hf?.captain ?? null,
            merchant: hf?.merchant ?? null,
            crew: Array.isArray(hf?.crew) ? hf.crew : [],
            pilot: hf?.captain ?? null,
          });
          addedAnchor++;
        }
      }
    }

    const harborShuttleCount = routes.filter((r) => r.id.startsWith('harbor:')).length;
    if (harborShuttleCount < 4 && routes.length < MAX_TRADE_VESSELS) {
      const candidateTracks = [];
      for (let i = 0; i < seaHarbors.length; i++) {
        for (let j = i + 1; j < seaHarbors.length; j++) {
          const a = findNearestSafeWater(seaHarbors[i].x, seaHarbors[i].z, -2.0, 70, 520, 14);
          const b = findNearestSafeWater(seaHarbors[j].x, seaHarbors[j].z, -2.0, 70, 520, 14);
          if (!a || !b) continue;
          const mid = findNearestSafeWater((a.x + b.x) * 0.5, (a.z + b.z) * 0.5, -2.2, 0, 420, 14);
          if (!mid) continue;
          if (Math.hypot(b.x - a.x, b.z - a.z) >= 240
              && isSegmentSafeWater(a, mid, -1.8, 12)
              && isSegmentSafeWater(mid, b, -1.8, 12)
              && !blockedByLowBridge(a.x, a.z, mid.x, mid.z, seaLevel, 16.0, 2.5, normBridges)
              && !blockedByLowBridge(mid.x, mid.z, b.x, b.z, seaLevel, 16.0, 2.5, normBridges)) {
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
          if (isSafeWater(wx, wz, -2.0, 14) && !blockedByLowBridge(wx, wz, wx, wz, seaLevel, 16.0, 2.5, normBridges)) {
            rawWaypoints.push({ x: wx, z: wz });
          }
        }
        const safeTrack = [];
        for (const wp of rawWaypoints) {
          const prev = safeTrack[safeTrack.length - 1];
          if (!prev || (isSegmentSafeWater(prev, wp, -1.8, 12) && !blockedByLowBridge(prev.x, prev.z, wp.x, wp.z, seaLevel, 16.0, 2.5, normBridges))) {
            safeTrack.push(wp);
          }
        }
        if (safeTrack.length >= 2) candidateTracks.push(safeTrack);
      }

      let addedShuttles = 0;
      for (let ti = 0; ti < candidateTracks.length && addedShuttles < 5 && routes.length < MAX_TRADE_VESSELS; ti++) {
        const raw = candidateTracks[ti];
        const arch = (ti % 2 === 0) ? 6 : 5;
        const archScale = arch === 5 ? 0.96 : 1.0;
        const reqAir = archAirDraft(arch, archScale);
        const reqHalfBeam = archHalfBeam(arch, archScale);
        let acc = 0;
        let bridgeBlocked = false;
        const linePts = raw.map((p, idx) => {
          if (idx > 0) {
            acc += Math.hypot(p.x - raw[idx - 1].x, p.z - raw[idx - 1].z);
            if (blockedByLowBridge(raw[idx - 1].x, raw[idx - 1].z, p.x, p.z, seaLevel, reqAir, reqHalfBeam, normBridges)) {
              bridgeBlocked = true;
            }
          }
          return { x: p.x, y: seaLevel, z: p.z, acc };
        });
        if (bridgeBlocked || acc < 120) continue;
        const slotId = `harbor:${ti}`;
        const hf = harborBySlot.get(slotId) || harborBySlot.get(`harbor:${ti % 6}`);
        routes.push({
          id: slotId, mode: 'sea', phase: 'shuttle',
          archetype: arch, scale: archScale,
          depart: 0, arrive: 1, berth: null,
          pts: linePts, totalLen: acc,
          phaseOffset: ((hashU32(ti + 5, 97) % 1000) / 1000),
          shipName: hf?.shipName || '',
          homePort: hf?.homePort || '',
          kind: arch === 6 ? 'barque' : 'caravel',
          captain: hf?.captain ?? null,
          merchant: hf?.merchant ?? null,
          crew: Array.isArray(hf?.crew) ? hf.crew : [],
          pilot: hf?.captain ?? null,
        });
        addedShuttles++;
      }
    }
  }

  const coveredRiverSubIndices = new Set();
  const coveredRiverComps = new Map(); // compIdx -> count of board river boats on this component

  for (const c of snapshot?.list ?? []) {
    if (routes.length >= MAX_TRADE_VESSELS) break;
    if (c.mode !== 'sea' && c.mode !== 'river') continue;
    if (!Array.isArray(c.points) || c.points.length < 4) continue;
    const isRiver = c.mode === 'river';
    const stableKeyStr = String(c.key ?? `${c.from ?? ''}>${c.to ?? ''}:${c.depart ?? c.index ?? 0}`);
    let stableKeyHash = 2166136261;
    for (let ki = 0; ki < stableKeyStr.length; ki++) {
      stableKeyHash = Math.imul(stableKeyHash ^ stableKeyStr.charCodeAt(ki), 16777619) >>> 0;
    }
    const seaArchetype = [5, 0, 2, 5][hashU32(stableKeyHash, 41) & 3];
    const archIdx = isRiver ? 4 : seaArchetype;
    let scale = isRiver ? (0.94 + (hashU32(stableKeyHash, 43) % 7) * 0.01) : seaArchetype === 5 ? 0.92 : 0.94;
    const pairs = parseFlatPairs(c.points);
    let poly = null;
    if (isRiver && parsedReachChains.length > 0) {
      poly = routeOnRiverGraph(pairs, scale);
      if (poly?.scale) scale = poly.scale;
    } else {
      const reqAir = archAirDraft(archIdx, scale);
      const reqHalfBeam = archHalfBeam(archIdx, scale);
      const rawPoly = buildPolylineRoute(pairs, { x: ox, z: oz }, isRiver ? riverYAt : () => seaLevel);
      poly = rawPoly
        ? (isRiver
            ? clampRiverPolyToSafeChannel(rawPoly, reqAir, reqHalfBeam)
            : clampSeaPolyToSafeWater(rawPoly, -2.2, 14, reqAir, reqHalfBeam))
        : null;
    }
    if (!poly) continue;
    let phaseOffset = Number.isFinite(c.phaseOffset) ? c.phaseOffset : (hashU32(stableKeyHash, 53) % 1000) / 1000;
    if (isRiver) {
      if (poly.subIndices) for (const si of poly.subIndices) coveredRiverSubIndices.add(si);
      if (Number.isInteger(poly.compIdx)) {
        const slotOnComp = coveredRiverComps.get(poly.compIdx) ?? 0;
        coveredRiverComps.set(poly.compIdx, slotOnComp + 1);
        phaseOffset = (phaseOffset + slotOnComp * 0.381966) % 1.0;
      }
    }
    routes.push({
      id: `caravan:${c.key ?? c.index}`, caravanKey: c.key ?? null, mode: c.mode, phase: 'caravan',
      archetype: archIdx,
      scale,
      depart: c.depart ?? 0, arrive: Math.max((c.depart ?? 0) + 0.1, c.arrive ?? 1),
      berth: null,
      shipName: c.shipName || '',
      homePort: c.homePort || '',
      kind: isRiver ? 'river barge' : seaArchetype === 5 ? 'caravel' : seaArchetype === 2 ? 'carrack' : 'cog',
      cargo: c.good ? { [c.good]: c.qty || 1 } : {},
      captain: c.captain ?? null,
      merchant: c.merchant ?? null,
      crew: Array.isArray(c.crew) ? c.crew : [],
      pilot: c.pilot ?? c.captain ?? null,
      oarsmen: Number.isFinite(c.oarsmen) ? c.oarsmen : 0,
      pts: poly.pts, totalLen: poly.totalLen,
      phaseOffset,
    });
  }

  // Canonical sim-driven manned river boats (`snapshot.riverBoats` from BOARD_MODEL), snapped & routed strictly
  // along rendered `riverReaches` centerlines (`<= 3.2 m` spacing) whenever `parsedReachChains` is present.
  const simRiverBoats = Array.isArray(snapshot?.riverBoats) ? snapshot.riverBoats : [];
  for (let ri = 0; ri < simRiverBoats.length && routes.length < MAX_TRADE_VESSELS; ri++) {
    const rb = simRiverBoats[ri];
    if (!rb || !Array.isArray(rb.points) || rb.points.length < 4) continue;
    let rbScale = Number.isFinite(rb.scale) ? Math.max(0.92, Math.min(1.04, rb.scale)) : 0.96;
    const pairs = parseFlatPairs(rb.points);
    let poly = null;
    if (parsedReachChains.length > 0) {
      poly = routeOnRiverGraph(pairs, rbScale);
      if (poly?.scale) rbScale = poly.scale;
    } else {
      const reqAir = archAirDraft(4, rbScale);
      const reqHalfBeam = archHalfBeam(4, rbScale);
      const rawPoly = buildPolylineRoute(pairs, { x: ox, z: oz }, riverYAt);
      poly = rawPoly ? clampRiverPolyToSafeChannel(rawPoly, reqAir, reqHalfBeam) : null;
    }
    if (!poly) continue;
    let phaseOffset = Number.isFinite(rb.phaseOffset)
      ? rb.phaseOffset
      : ((hashU32((rb.id ?? ri) + 3, 61) % 1000) / 1000);
    if (poly.subIndices) for (const si of poly.subIndices) coveredRiverSubIndices.add(si);
    if (Number.isInteger(poly.compIdx)) {
      const slotOnComp = coveredRiverComps.get(poly.compIdx) ?? 0;
      coveredRiverComps.set(poly.compIdx, slotOnComp + 1);
      phaseOffset = (phaseOffset + slotOnComp * 0.381966) % 1.0;
    }
    const rbCargo = rb.cargo && typeof rb.cargo === 'object'
      ? { ...rb.cargo }
      : (rb.good ? { [rb.good]: rb.qty || 2 } : {});
    routes.push({
      id: `riverBoat:${rb.id ?? ri}`,
      riverBoatId: rb.id ?? ri,
      caravanKey: rb.key ?? null,
      mode: 'river',
      phase: rb.phase || 'shuttle',
      archetype: 4,
      scale: rbScale,
      depart: rb.depart ?? 0,
      arrive: Math.max((rb.depart ?? 0) + 0.25, rb.arrive ?? 1),
      berth: null,
      shipName: rb.shipName || `Barca do Tejo ${rb.id ?? (ri + 1)}`,
      homePort: rb.homePort || '',
      from: rb.from || '',
      to: rb.to || '',
      kind: 'river barge',
      cargo: rbCargo,
      captain: rb.captain ?? null,
      merchant: rb.merchant ?? null,
      crew: Array.isArray(rb.crew) ? rb.crew : [],
      pilot: rb.pilot ?? null,
      oarsmen: Number.isFinite(rb.oarsmen) ? rb.oarsmen : 4,
      pts: poly.pts,
      totalLen: poly.totalLen,
      phaseOffset,
    });
  }

  // Supplement any navigable rendered river reaches (`hw >= 2.2 m`, `depth >= 0.55 m`, bridge-clear)
  // ONLY when not already served by a board river route (`riverBoat:*` or `caravan:*`).
  if (navSubChains.length > 0 && routes.length < MAX_TRADE_VESSELS) {
    const navigable = navSubChains
      .map((sc, subIdx) => ({ sc, subIdx }))
      .filter(({ sc }) => sc.length >= 150)
      .sort((a, b) => b.sc.length - a.sc.length);
    for (let ri = 0; ri < navigable.length && routes.length < MAX_TRADE_VESSELS; ri++) {
      const { sc: reach, subIdx } = navigable[ri];
      const firstNode = riverGraphNodes[reach.nodeIds[0]];
      const reachComp = firstNode?.comp ?? -1;
      if (coveredRiverSubIndices.has(subIdx) || (reachComp >= 0 && coveredRiverComps.has(reachComp))) continue;
      const sts = reach.stations;
      const sampleProbes = [sts[0], sts[sts.length >> 1], sts[sts.length - 1]];
      const alreadyCovered = routes.some((rt) =>
        rt.mode === 'river'
        && Array.isArray(rt.pts)
        && sampleProbes.some((sp) => sp && rt.pts.some((q) => Math.hypot(q.x - sp.wx, q.z - sp.wz) < 210)),
      );
      if (alreadyCovered) continue;
      const bargeBaseBeam = getTradeVesselArchetype(4).beam || 3.0;
      const bargeScale = Math.max(0.76, Math.min(0.98, Math.max(0.92, (reach.minHw - 0.55) / (bargeBaseBeam * 0.5))));
      const built = buildDenseRouteFromNodePath(reach.nodeIds, bargeScale);
      if (!built || built.totalLen < 120) continue;
      const boats = built.totalLen > 920 ? 2 : 1;
      for (let b = 0; b < boats && routes.length < MAX_TRADE_VESSELS; b++) {
        routes.push({
          id: `reach:${subIdx}:${b}`, mode: 'river', phase: 'shuttle',
          archetype: 4, scale: built.scale * (b === 0 ? 1.0 : 0.96),
          depart: 0, arrive: 1, berth: null,
          kind: 'river barge',
          cargo: { fish: 2 + (b & 1) },
          pilot: null, oarsmen: 4,
          pts: built.pts, totalLen: built.totalLen,
          phaseOffset: (((hashU32(subIdx + 1, 13) % 1000) / 1000) + b * 0.5) % 1.0,
        });
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
    const yaw = route.berth.rot || 0;
    return {
      x: route.berth.x,
      y: route.berth.y ?? 0,
      z: route.berth.z,
      vx: 0,
      vz: 0,
      yaw,
      heading: (yaw * 180) / Math.PI,
      pitch: 0,
      roll: 0,
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
  } else if (route.phase === 'caravan') {
    const rawShare = (boardDay - route.depart) / days;
    const share = (rawShare >= 0 && rawShare <= 1) ? rawShare : ((route.phaseOffset || 0) * 1.65);
    const vFloor = calSpeed < minSpeed ? Math.max(0, minSpeed - calSpeed) : 0;
    signedDist = share * L + vFloor * elapsedSec;
  } else {
    const share = Math.max(0, Math.min(1, (boardDay - route.depart) / days));
    const baseDist = (route.phase === 'out' ? 1 - share : share) * L;
    const vFloor = calSpeed < minSpeed ? Math.max(0, minSpeed - calSpeed) : 0;
    signedDist = baseDist + (route.phase === 'out' ? -1 : 1) * vFloor * elapsedSec;
  }

  let dist, forwardSign = 1;
  if (route.phase === 'shuttle' || route.phase === 'caravan') {
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
  const slopePitch = Math.asin(ty);

  return {
    x: at.x,
    y: at.y,
    z: at.z,
    vx: tx * speed,
    vz: tz * speed,
    yaw,
    heading: (yaw * 180) / Math.PI,
    pitch: slopePitch,
    roll: 0,
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
    vx: state === 'docked' || state === 'anchored' ? 0 : (seedState?.vx ?? 0),
    vz: state === 'docked' || state === 'anchored' ? 0 : (seedState?.vz ?? 0),
    waterY: seedState?.y ?? (route.berth?.y ?? 0),
    channelHw: 0,
    crossTrackM: 0,
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
 * shoal & collision avoidance, harbor approach/docking/departure kinematics, or channel-locked river flow.
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
  beam = archIndex === 4 ? 2.4 : 4.8,
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
      ai.vx = 0;
      ai.vz = 0;
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
      ai.y = route.berth?.y ?? 0;
      ai.pitch = 0;
      ai.roll = 0;
      ai.speed = 0;
      ai.vx = 0;
      ai.vz = 0;
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
      ai.y = berth?.y ?? 0;
      ai.pitch = 0;
      ai.roll = 0;
      ai.speed = Math.max(0, ai.speed * Math.exp(-h * 3.0));
      ai.vx = 0;
      ai.vz = 0;
      ai.motion = 0;
      ai.sailSet += (0.04 - ai.sailSet) * (1 - Math.exp(-h * 1.6));
      ai.tacking = false;
      ai.heldByWeather = activeStorm;
      ai.etaDays = 0;
      ai.progress = 1;
      return;
    }

    // River barges: strict rendered-river centerline guidance, cross-track clamping, and exact station water elevation
    if (isBarge && pts && pts.length >= 2) {
      ai.wpIndex = Math.max(0, Math.min(pts.length - 1, ai.wpIndex | 0));
      let target = pts[ai.wpIndex];
      let probeIw = null;
      if (riverFlowAt) {
        const candIw = riverFlowAt(ai.x + worldOffsetX, ai.z + worldOffsetZ);
        if (candIw && (!Number.isFinite(candIw.dist) || !Number.isFinite(candIw.hw) || candIw.dist <= candIw.hw * 0.92)) {
          probeIw = candIw;
        }
      }
      const localHalfWidth = Number.isFinite(target.hw)
        ? target.hw
        : (Number.isFinite(probeIw?.hw) ? probeIw.hw : 3.5);
      const arriveR = Math.max(3.6, Math.min(7.5, localHalfWidth * 0.95));
      let distToWp = Math.hypot(target.x - ai.x, target.z - ai.z);
      let wpGuard = 0;
      while (distToWp < arriveR && wpGuard++ < 16) {
        if (ai.dirSign > 0) {
          if (ai.wpIndex < pts.length - 1) ai.wpIndex++;
          else { ai.dirSign = -1; ai.wpIndex = Math.max(0, pts.length - 2); }
        } else {
          if (ai.wpIndex > 0) ai.wpIndex--;
          else { ai.dirSign = 1; ai.wpIndex = Math.min(pts.length - 1, 1); }
        }
        target = pts[Math.max(0, Math.min(pts.length - 1, ai.wpIndex))];
        distToWp = Math.hypot(target.x - ai.x, target.z - ai.z);
      }

      let cvx = Number.isFinite(target.vx) ? target.vx : 0;
      let cvz = Number.isFinite(target.vz) ? target.vz : 0;
      if (probeIw && Number.isFinite(probeIw.vx) && Number.isFinite(probeIw.vz)) {
        cvx = probeIw.vx;
        cvz = probeIw.vz;
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

      const refPrev = pts[Math.max(0, ai.wpIndex - 1)];
      const refNext = pts[Math.min(pts.length - 1, ai.wpIndex + 1)];
      const rdx = refNext.x - refPrev.x, rdz = refNext.z - refPrev.z;
      const rlen = Math.hypot(rdx, rdz) || 1;
      const hullHalfB0 = Math.max(0.85, beam * 0.5);
      const maxAimLat = Math.max(0.0, Math.min(localHalfWidth * 0.90 - hullHalfB0, localHalfWidth - hullHalfB0 - 0.25));
      const aimLat = (ai.dirSign >= 0 ? 1 : -1) * Math.min(maxAimLat, 0.28 * localHalfWidth);
      const aimX = target.x + (-rdz / rlen) * aimLat;
      const aimZ = target.z + (rdx / rlen) * aimLat;
      const distToAim = Math.hypot(aimX - ai.x, aimZ - ai.z);
      const tx = distToAim > 1e-3 ? (aimX - ai.x) / distToAim : Math.sin(ai.yaw);
      const tz = distToAim > 1e-3 ? (aimZ - ai.z) / distToAim : -Math.cos(ai.yaw);
      const flowTrackAlong = cvx * tx + cvz * tz;
      const upstream = flowTrackAlong < -0.15;
      let oarWaterSpeed = upstream
        ? Math.max(1.55, Math.min(2.65, Math.abs(flowTrackAlong) + 0.95))
        : 1.05;

      // Longitudinal river-channel spacing & speed modulation so barges on the same leg never drive through each other
      let passingUrgency = 0;
      let speedMul = 1.0;
      if (avoidTargets && avoidTargets.length > 0) {
        const minFollowM = Math.max(19.0, length * 1.48);
        const stopDistM = Math.max(18.0, minFollowM * 0.92);
        for (let k = 0; k < avoidTargets.length; k++) {
          const other = avoidTargets[k];
          if (!other || other.id === route.id) continue;
          const oxOther = (other.x ?? 0) - worldOffsetX;
          const ozOther = (other.z ?? 0) - worldOffsetZ;
          const dxO = oxOther - ai.x, dzO = ozOther - ai.z;
          const sep = Math.hypot(dxO, dzO);
          if (sep > 48 || sep < 1e-3) continue;
          const fwd = dxO * tx + dzO * tz;
          const lat = Math.abs(-dxO * tz + dzO * tx);
          if (lat > Math.max(8.0, localHalfWidth * 1.35)) continue;
          const obx = Math.sin(other.yaw ?? 0), obz = -Math.cos(other.yaw ?? 0);
          const sameHeading = tx * obx + tz * obz;
          if (sameHeading > 0.25) {
            if (fwd > -1.5 && sep < stopDistM + 22.0) {
              speedMul = Math.min(speedMul, sep <= stopDistM ? 0.0 : Math.max(0.0, (sep - stopDistM) / 22.0));
            } else if (fwd < -1.5 && sep < minFollowM * 0.85) {
              speedMul = Math.max(speedMul, 1.18);
            }
          } else if (fwd > -length) {
            passingUrgency = Math.max(passingUrgency, 1 - sep / 48);
          }
        }
        oarWaterSpeed *= speedMul;
      }

      // Steersman crabs only into cross-track current so downstream hulls ride river flow cleanly (and hold station when braking).
      const driftScale = speedMul < 0.35 ? (speedMul / 0.35) : 1.0;
      const crossVx = (cvx - flowTrackAlong * tx) * driftScale;
      const crossVz = (cvz - flowTrackAlong * tz) * driftScale;
      const crabVx = tx * oarWaterSpeed - crossVx * 0.78;
      const crabVz = tz * oarWaterSpeed - crossVz * 0.78;
      const desiredYaw = (Math.abs(crabVx) + Math.abs(crabVz) > 1e-3) ? Math.atan2(crabVx, -crabVz) : Math.atan2(tx, -tz);
      const dYaw = wrapAnglePi(desiredYaw - ai.yaw);
      const maxTurn = 0.85 * h;
      ai.yaw = wrapAnglePi(ai.yaw + Math.max(-maxTurn, Math.min(maxTurn, dYaw)));

      const bowX = Math.sin(ai.yaw), bowZ = -Math.cos(ai.yaw);
      const gvx = bowX * oarWaterSpeed + cvx * 0.78 * driftScale;
      const gvz = bowZ * oarWaterSpeed + cvz * 0.78 * driftScale;
      const groundSpd = speedMul <= 0.01 ? 0.0 : Math.max(0.05, Math.hypot(gvx, gvz));
      ai.speed += (groundSpd - ai.speed) * (1 - Math.exp(-h * 2.4));
      ai.x += gvx * h;
      ai.z += gvz * h;
      ai.vx = gvx;
      ai.vz = gvz;
      ai.motion = speedMul <= 0.02
        ? 0.0
        : (upstream ? Math.min(1.5, 1.15 + Math.abs(flowTrackAlong) * 0.35) : Math.max(0.5, 0.78 - flowTrackAlong * 0.18))
          * Math.max(0.25, Math.min(1.15, oarWaterSpeed / 1.15));
      ai.sailSet = 0;
      ai.tacking = false;
      ai.heldByWeather = false;

      // Project `(ai.x, ai.z)` onto active `riverReaches` centerline segment & hold starboard-hand (+0.28*hw) channel lane
      let bestSegIdx = Math.max(1, Math.min(pts.length - 1, ai.wpIndex));
      let bestU = 0;
      let bestDistSq = Infinity;
      const searchWindow = (lo, hi) => {
        for (let i = lo; i <= hi; i++) {
          const a = pts[i - 1], b = pts[i];
          const dx = b.x - a.x, dz = b.z - a.z;
          const lenSq = dx * dx + dz * dz;
          const u = lenSq > 1e-6 ? Math.max(0, Math.min(1, ((ai.x - a.x) * dx + (ai.z - a.z) * dz) / lenSq)) : 0;
          const px = a.x + dx * u, pz = a.z + dz * u;
          const dSq = (ai.x - px) * (ai.x - px) + (ai.z - pz) * (ai.z - pz);
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestSegIdx = i;
            bestU = u;
          }
        }
      };
      searchWindow(Math.max(1, ai.wpIndex - 10), Math.min(pts.length - 1, ai.wpIndex + 10));
      if (bestDistSq > 144) searchWindow(1, pts.length - 1);

      const segA = pts[bestSegIdx - 1];
      const segB = pts[bestSegIdx];
      const sdx = segB.x - segA.x, sdz = segB.z - segA.z;
      const slen = Math.hypot(sdx, sdz) || 1;
      const cx = segA.x + sdx * bestU;
      const cz = segA.z + sdz * bestU;
      const snx = -sdz / slen, snz = sdx / slen;
      const dLat = (ai.x - cx) * snx + (ai.z - cz) * snz;

      let stHw = (Number.isFinite(segA.hw) && Number.isFinite(segB.hw))
        ? (segA.hw + (segB.hw - segA.hw) * bestU)
        : (Number.isFinite(segB.hw) ? segB.hw : segA.hw);
      let stWy = (Number.isFinite(segA.y) && Number.isFinite(segB.y))
        ? (segA.y + (segB.y - segA.y) * bestU)
        : (Number.isFinite(segB.y) ? segB.y : (segA.y ?? 0));
      const stSeaMouth = Boolean(segA.seaMouth || segB.seaMouth);
      const stEstuaryT = (Number.isFinite(segA.estuaryT) && Number.isFinite(segB.estuaryT))
        ? (segA.estuaryT + (segB.estuaryT - segA.estuaryT) * bestU)
        : (stSeaMouth ? 1 : 0);

      if (riverFlowAt) {
        const iwCenter = riverFlowAt(cx + worldOffsetX, cz + worldOffsetZ);
        if (iwCenter && (!Number.isFinite(iwCenter.dist) || !Number.isFinite(iwCenter.hw) || iwCenter.dist <= iwCenter.hw * 0.92)) {
          if (!Number.isFinite(stHw) && Number.isFinite(iwCenter.hw)) stHw = iwCenter.hw;
          if (Number.isFinite(iwCenter.wy)) stWy = iwCenter.wy;
        }
      }
      if (stSeaMouth && stEstuaryT > 0.72) {
        stWy *= Math.max(0, (1 - stEstuaryT) / 0.28);
      }

      const slopeSign = ai.dirSign >= 0 ? 1 : -1;
      const hullHalfBeam = Math.max(0.85, beam * 0.5);
      const effHw = Number.isFinite(stHw) ? stHw : 3.5;
      const maxLat = Math.max(0.0, Math.min(effHw * 0.90 - hullHalfBeam, effHw - hullHalfBeam - 0.25));
      const laneFrac = 0.28 + passingUrgency * 0.06;
      const targetLat = slopeSign * Math.min(maxLat, laneFrac * effHw);
      ai.laneLat = Number.isFinite(ai.laneLat)
        ? (ai.laneLat + (targetLat - ai.laneLat) * Math.min(1, h * 2.0))
        : targetLat;
      const steeredLat = dLat + (ai.laneLat - dLat) * Math.min(1, h * 3.2);
      const clampedLat = Math.max(-maxLat, Math.min(maxLat, steeredLat));
      ai.x = cx + snx * clampedLat;
      ai.z = cz + snz * clampedLat;
      ai.y = stWy;
      ai.waterY = stWy;
      ai.channelHw = effHw;
      ai.crossTrackM = Math.abs(clampedLat);

      const dyAlong = ((segB.y ?? stWy) - (segA.y ?? stWy)) * slopeSign;
      ai.pitch = Math.max(-0.14, Math.min(0.14, Math.asin(Math.max(-0.18, Math.min(0.18, dyAlong / slen)))));
      ai.roll = 0;

      const L = Math.max(1, route.totalLen || 1);
      const projAcc = (segA.acc ?? 0) + slen * bestU;
      const remSegs = ai.dirSign > 0 ? Math.max(0, L - projAcc) : Math.max(0, projAcc);
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
        const stepX = (targetX - ai.x) * Math.min(1, h * 1.4);
        const stepZ = (targetZ - ai.z) * Math.min(1, h * 1.4);
        ai.x += stepX;
        ai.z += stepZ;
        ai.vx = h > 1e-4 ? stepX / h : 0;
        ai.vz = h > 1e-4 ? stepZ / h : 0;
        ai.speed = Math.min(ai.speed, distBerth * 0.5);
        if (distBerth <= 2.0 && Math.abs(wrapAnglePi(brot - ai.yaw)) < 0.22) {
          ai.state = 'docked';
          ai.dirtySync = true;
        }
        ai.sailSet += (sailTarget - ai.sailSet) * (1 - Math.exp(-h * 1.8));
        ai.y = dest.y ?? 0;
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
          } else if (route.phase === 'shuttle' || route.phase === 'caravan') {
            ai.dirSign = -1;
            ai.wpIndex = Math.max(0, pts.length - 2);
          }
        } else {
          if (ai.wpIndex > 0) {
            ai.wpIndex--;
          } else if (route.phase === 'shuttle' || route.phase === 'caravan') {
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

    // Windward polar & autonomous headwind tacking (clamped to actual safe lateral channel width)
    const polarDesired = computeSailingPolar(desiredCourse, windVec, archIndex, { storm: activeStorm });
    let steerYaw = desiredCourse;
    ai.tackTimer += h;
    const allowTack = ai.state === 'inbound' || ai.state === 'outbound' || ai.state === 'caravan' || ai.state === 'shuttle';
    if (allowTack && polarDesired.inNoGoZone && polarDesired.windSpeed >= 0.8) {
      let xtrack = 0;
      let maxTackCorridor = 85;
      if (pts && pts.length >= 2) {
        const aIdx = Math.max(0, Math.min(pts.length - 1, ai.wpIndex - ai.dirSign));
        const bIdx = Math.max(0, Math.min(pts.length - 1, ai.wpIndex));
        const a = pts[aIdx], b = pts[bIdx];
        const sx = b.x - a.x, sz = b.z - a.z;
        const sl = Math.hypot(sx, sz) || 1;
        const nx = -sz / sl, nz = sx / sl;
        xtrack = (ai.x - a.x) * nx + (ai.z - a.z) * nz;
        if (bedAt) {
          const reqBed = (Number.isFinite(ai.waterY) ? ai.waterY : 0) - (draft + 0.65);
          let freeNeg = 0, freePos = 0;
          for (let d = 10; d <= 95; d += 10) {
            if (bedAt(ai.x + worldOffsetX - nx * d, ai.z + worldOffsetZ - nz * d) <= reqBed) freeNeg = d;
            else break;
          }
          for (let d = 10; d <= 95; d += 10) {
            if (bedAt(ai.x + worldOffsetX + nx * d, ai.z + worldOffsetZ + nz * d) <= reqBed) freePos = d;
            else break;
          }
          const safeHalf = Math.max(0, Math.min(freeNeg, freePos) - Math.max(7, length * 0.48));
          maxTackCorridor = Math.min(85, safeHalf);
        }
      }
      if (maxTackCorridor < 14) {
        // Channel too narrow to tack safely: hold channel centerline so hull never tacks onto riverbanks.
        ai.tacking = false;
        steerYaw = desiredCourse;
      } else {
        if ((Math.abs(xtrack) > maxTackCorridor && ai.tackTimer > 3.5) || ai.tackTimer > 30) {
          ai.tackSide = -ai.tackSide;
          ai.tackTimer = 0;
        }
        steerYaw = wrapAnglePi(polarDesired.upwindAngle + ai.tackSide * polarDesired.beta);
        ai.tacking = true;
      }
    } else {
      ai.tacking = false;
    }

    // Shoal grounding lookahead
    let avoidTurn = 0;
    const minDepth = (Number.isFinite(ai.waterY) ? ai.waterY : 0) - (draft + 0.65);
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
    const gvx = bowX * ai.speed + windTo[0] * leeMag;
    const gvz = bowZ * ai.speed + windTo[1] * leeMag;
    ai.x += gvx * h;
    ai.z += gvz * h;
    ai.vx = gvx;
    ai.vz = gvz;
    ai.y = 0;
    ai.pitch += (0 - ai.pitch) * Math.min(1, h * 3);
    ai.roll += (actualPolar.heel - ai.roll) * Math.min(1, h * 2.2);
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

const BARGE_ROW_SWEEP_RAD = 0.30;
const BARGE_ROW_DIP_RAD = 0.12;

function buildSailBrailWGSL() {
  const rowsA = [];
  const rowsB = [];
  for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
    const arch = getTradeVesselArchetype(a);
    const specs = arch.sailBrailSpecs || {};
    for (let s = 0; s < 16; s++) {
      const rec = specs[s];
      if (!rec) {
        rowsA.push('vec4f(-1.0, 0.0, 0.0, 0.0)');
        rowsB.push('vec4f(0.0, 0.0, 0.0, 0.0)');
      } else if (rec.isLateen) {
        rowsA.push(`vec4f(1.0, ${rec.peak[0].toFixed(4)}, ${rec.peak[1].toFixed(4)}, ${rec.peak[2].toFixed(4)})`);
        rowsB.push(`vec4f(1.0, ${rec.tack[0].toFixed(4)}, ${rec.tack[1].toFixed(4)}, ${rec.tack[2].toFixed(4)})`);
      } else {
        rowsA.push(`vec4f(0.0, ${rec.yardY.toFixed(4)}, ${rec.yardZ.toFixed(4)}, ${rec.footY.toFixed(4)})`);
        rowsB.push('vec4f(0.0, 0.0, 0.0, 0.0)');
      }
    }
  }
  return /* wgsl */ `
const SAIL_BRAIL_A = array<vec4f, ${TRADE_VESSEL_ARCHETYPES * 16}>(
  ${rowsA.join(',\n  ')}
);
const SAIL_BRAIL_B = array<vec4f, ${TRADE_VESSEL_ARCHETYPES * 16}>(
  ${rowsB.join(',\n  ')}
);

fn animateTradeSailBrail(pIn: vec3f, nIn: vec3f, material: f32, uv: vec2f, furlRaw: f32, archIdx: u32) -> array<vec3f, 2> {
  let furl = clamp(furlRaw, 0.0, 1.0);
  if (furl <= 0.002 || archIdx == 1u || archIdx == 3u || archIdx == 4u) { return array<vec3f, 2>(pIn, nIn); }
  let mFloor = floor(material);
  let m = u32(max(0.0, mFloor));
  if (m != 9u && m != 13u && m != 19u) { return array<vec3f, 2>(pIn, nIn); }
  let surfCode = min(15u, u32(max(0.0, round((material - mFloor) * 64.0))));
  let idx = min(${TRADE_VESSEL_ARCHETYPES - 1}u, archIdx) * 16u + surfCode;
  let infoA = SAIL_BRAIL_A[idx];
  if (infoA.x < -0.5) { return array<vec3f, 2>(pIn, nIn); }

  var p = pIn;
  var n = nIn;
  let nLen = max(length(nIn), 1e-5);
  let u = clamp(uv.x, 0.0, 1.0);
  let v = clamp(uv.y, 0.0, 1.0);

  if (infoA.x > 0.5) {
    // Lateen sail canvas (13u) & stitched bolt-ropes (19u): uv.y == 0 IS the oblique yard line from peak (u=0) to tack (u=1).
    let peakP = infoA.yzw;
    let tackP = SAIL_BRAIL_B[idx].yzw;
    let uBrail = clamp(u + v * 0.34, 0.0, 1.0);
    let buntSag = (0.045 + 0.085 * sin(uBrail * 3.14159265)) * v;
    let yardPt = mix(peakP, tackP, uBrail) - vec3f(0.0, buntSag, 0.0);
    let vGate = clamp(v * 20.0, 0.0, 1.0);
    let wBrail = furl * 0.96 * vGate;
    p = mix(p, yardPt, wBrail);
    let foldN = normalize(vec3f(0.88, -0.36 * v - 0.08, 0.22 * sin(u * 12.566)));
    n = normalize(mix(nIn / nLen, foldN, furl * 0.52 * vGate)) * nLen;
  } else {
    // Square sail canvas (9u) & stitched bolt-ropes (19u): lift foot smoothly up beneath exact yardY (never above yardY!).
    let yardY = infoA.y;
    let yardZ = infoA.z;
    let vGate = clamp(v * 20.0, 0.0, 1.0);
    let buntDrop = (0.055 + 0.115 * sin(u * 3.14159265)) * v;
    let targetY = min(yardY, yardY - buntDrop);
    let targetZ = yardZ - (0.04 + 0.075 * sin(u * 3.14159265)) * v;
    p.y = mix(p.y, targetY, furl * 0.96 * vGate);
    p.z = mix(p.z, targetZ, furl * 0.92 * vGate);
    p.x *= (1.0 - 0.16 * furl * v);
    let foldN = normalize(vec3f((u - 0.5) * 0.25, -0.48 * v, -0.86));
    n = normalize(mix(nIn / nLen, foldN, furl * 0.52 * vGate)) * nLen;
  }
  return array<vec3f, 2>(p, n);
}
`;
}

const SAIL_BRAIL_WGSL = /* @__PURE__ */ buildSailBrailWGSL();

const REST_TO_POSED_WGSL = /* wgsl */ `
struct SourceVertex { px: f32, py: f32, pz: f32, nx: f32, ny: f32, nz: f32, mat: f32, u: f32, v: f32 };
struct PosedVertex { position: vec4f, normal: vec4f };
struct PoseUniform { phase: f32, motion: f32, archetype: f32, furl: f32 };

${SAIL_BRAIL_WGSL}

@group(0) @binding(0) var<storage, read> srcVerts: array<SourceVertex>;
@group(0) @binding(1) var<storage, read_write> dstPosed: array<PosedVertex>;
@group(0) @binding(2) var<uniform> P: PoseUniform;

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  if (idx >= arrayLength(&srcVerts) || idx >= arrayLength(&dstPosed)) { return; }
  let sv = srcVerts[idx];
  let brailed = animateTradeSailBrail(
    vec3f(sv.px, sv.py, sv.pz),
    vec3f(sv.nx, sv.ny, sv.nz),
    sv.mat,
    vec2f(sv.u, sv.v),
    P.furl,
    u32(max(0.0, round(P.archetype))),
  );
  dstPosed[idx].position = vec4f(brailed[0], 0.0);
  dstPosed[idx].normal = vec4f(brailed[1], 0.0);
}
`;

// Every vessel handoff splits a pixel's samples with the continuum core's continuumSamples: the coarser side takes
// continuumSamples(share, pixel, samples, seed), the finer side its complement against the full mask, both from
// the same flat integer share and the same instance seed, so each sample is drawn exactly once.

export function tradeVesselsSource(damaged = false, samples = 4, { submergedCapture = false } = {}) {
  const safeSamples = Math.max(1, Math.min(4, samples | 0));
  const sampleMaskAll = (1 << safeSamples) - 1;
  const useSubmergedEntry = Boolean(submergedCapture && !damaged);
  const rawSource = CONTINUUM_CORE_WGSL + FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + SHADOW_FRAME + VESSEL_LIGHTING + CANVAS_OPTICS + /* wgsl */ `
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
  @location(6) @interpolate(flat) yawPitchRollScale: vec4f,
  @location(7) stateMatArch: vec3f,
  // Intact: the near-to-continuum handoff share (of 65535) and the instance seed, exactly as the select pass packed them.
  @location(8) @interpolate(flat) fade: vec2u,
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
  let mInt = u32(max(0.0, floor(matTone.x)));
  if (matTone.x > 5.5 && mInt == 16u && abs(archF - 4.0) < 0.5) {
    let stationIdx = min(23u, u32(max(0.0, round((matTone.x - 16.0) * 64.0))));
    let piv = BARGE_OAR_PIVOTS[stationIdx];
    let side = piv.w;
    let oarActive = motion > 0.035;
    let cyc = select(3.14159265, F.camPos.w * 2.15 + phase + f32(stationIdx >> 1u) * 0.16, oarActive);
    let sweep = sin(cyc) * ${BARGE_ROW_SWEEP_RAD.toFixed(4)};
    let dip = -cos(cyc) * ${BARGE_ROW_DIP_RAD.toFixed(4)};
    var d = p - piv.xyz;
    var nOar = n;
    // Rigid Rodrigues rotation around the exact collinear oar shaft axis (zero shaft bending across recovery feathering)
    let scBarge = ARCHETYPE_SCALES[4u];
    let uShaft = normalize(vec3f(side / scBarge.x, (${BARGE_OAR_SLOPE_M.toFixed(6)}) / scBarge.y, 0.0));
    let feather = max(0.0, -cos(cyc)) * 0.65;
    if (feather > 0.001) {
      let cf = cos(feather); let sf = sin(feather);
      let dPar = uShaft * dot(uShaft, d);
      d = dPar + (d - dPar) * cf + cross(uShaft, d) * (sf * side);
      let nPar = uShaft * dot(uShaft, nOar);
      nOar = nPar + (nOar - nPar) * cf + cross(uShaft, nOar) * (sf * side);
    }
    let cy = cos(sweep * side); let sy = sin(sweep * side);
    let dYaw = vec3f(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);
    let cr = cos(dip * side); let sr = sin(dip * side);
    p = piv.xyz + vec3f(dYaw.x * cr - dYaw.y * sr, dYaw.x * sr + dYaw.y * cr, dYaw.z);
    let nYaw = vec3f(nOar.x * cy - nOar.z * sy, nOar.y, nOar.x * sy + nOar.z * cy);
    n = vec3f(nYaw.x * cr - nYaw.y * sr, nYaw.x * sr + nYaw.y * cr, nYaw.z);
  } else if (mInt == 28u && motion > 0.05 && (abs(archF - 4.0) < 0.5 || abs(archF - 6.0) < 0.5)) {
    let helmSwing = sin(F.camPos.w * 1.45 + phase) * 0.075 * min(motion, 1.4);
    p.x += helmSwing;
  }
  ${damaged ? '' : 'let brailed = animateTradeSailBrail(p, n, material, uv, instAnim.w, aIdx); p = brailed[0]; n = brailed[1];'}
  return array<vec3f, 2>(p, n);
}

fn vesselWorldTransform(srcPos: vec3f, srcNorm: vec3f, material: f32, uv: vec2f, posYaw: vec4f, att: vec4f, anim: vec4f) -> array<vec3f, 3> {
  let aIdx = min(u32(${TRADE_VESSEL_ARCHETYPES - 1}), u32(max(0.0, round(att.w))));
  let sc4 = ARCHETYPE_SCALES[aIdx];
  let scaleMetres = sc4.xyz * att.z;
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
  let tr = vesselWorldTransform(rawPos, rawNorm, v.material, v.uv, v.instPosYaw, v.instAttitude, v.instAnim);
  let shifted = tr[0] + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  var o: TVVertexOut;
  o.pos = F.viewProj * vec4f(earthCurve(shifted - F.camPos.xyz, F.camPos.y), 1.0);
  o.world = shifted;
  o.normal = tr[1];
  o.local = v.pos;
  o.normalLocal = tr[2];
  o.matId = u32(max(0.0, floor(v.material)));
  o.uv = v.uv;
  o.yawPitchRollScale = vec4f(v.instPosYaw.w, v.instAttitude.x, v.instAttitude.y, max(v.instAttitude.z, 0.25));
  ${damaged ? `o.stateMatArch = vec3f(select(0.0, clamp(nLen - 1.0, 0.0, 1.5), nLen > 1.002), v.material, v.instAttitude.w);
  o.fade = vec2u(0u);` : `// instAnim.z holds share16 + 65536 * seed as an exact integer float (TRADE_VESSEL_SELECT_WGSL).
  let fadeWord = u32(max(round(v.instAnim.z), 0.0));
  o.fade = vec2u(fadeWord & 0xFFFFu, fadeWord >> 16u);
  o.stateMatArch = vec3f(f32(o.fade.x) / 65535.0, v.material, v.instAttitude.w);`}
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
  return m == 0u || m == 1u || m == 5u || m == 6u || m == 7u || m == 10u || m == 14u || m == 15u || m == 16u || m == 17u || m == 18u || m == 28u;
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
  let dmgVal = in.stateMatArch.x;
  if (isWoodMat(in.matId) && hullHoleRim(in.local) < 0.0) { discard; }
  if (isRopeMat(in.matId) && ropeParted(in.local, dmgVal)) { discard; }
  if (isSailMat(in.matId) && dmgVal > 0.04 && canvasTearMask(in.uv, in.local, in.matId, dmgVal) > 0.0) { discard; }
  return vec4f(0.0);
}
` : ''}

fn tvShadeFragment(in: TVVertexOut, front: bool) -> vec4f {
  let stateVal = in.stateMatArch.x;
  let rawMat = in.stateMatArch.y;
  let archF = in.stateMatArch.z;
  let aIdx = min(u32(${TRADE_VESSEL_ARCHETYPES - 1}), u32(max(0.0, round(archF))));
  let sc4 = ARCHETYPE_SCALES[aIdx];
  let draftRatio = max(sc4.w, 0.4);
  let tvYaw = in.yawPitchRollScale.x;
  let tvPitch = in.yawPitchRollScale.y;
  let tvRoll = in.yawPitchRollScale.z;
  let tvScaleMul = in.yawPitchRollScale.w;
  let tvScaleMetres = sc4.xyz * tvScaleMul;
  let p = in.local;
  let tvMetres = p * tvScaleMetres;
  let tvNpbrMarker = 1;
  let matFrac = fract(rawMat);
  let m = in.matId;
  let isLusoria = abs(archF - 4.0) < 0.5;
  let isLusoriaOar = (m == 16u && isLusoria && matFrac > 0.004);
  let isLusoriaSweep = (m == 17u && isLusoria);
  let isGunwaleTube = isLusoria && m == 15u && abs(in.normalLocal.y) > 0.58;

  // Metric oak grain UVs matching Niña's 0.96 across-grain × 0.36 along-grain density across all 7 archetypes
  let course = select(tvMetres.y / 0.24, in.uv.x * 18.0, m == 15u);
  let courseBoard = floor(course);
  var oakUV = in.uv;
  if (m == 15u) {
    oakUV = select(
      vec2f(course * 0.24 + courseBoard * 0.37, tvMetres.z * 0.36 + fract(sin(courseBoard * 17.1) * 437.5)),
      vec2f(tvMetres.x * 0.96, tvMetres.z * 0.36),
      isGunwaleTube
    );
  } else if (m == 10u || isLusoriaOar || isLusoriaSweep) {
    let upSpar = abs(in.normalLocal.y) < 0.55 && !isLusoriaOar && !isLusoriaSweep;
    let sparAng = atan2(in.normalLocal.x, in.normalLocal.z);
    oakUV = select(
      vec2f((tvMetres.y + tvMetres.z) * 0.96, tvMetres.x * 0.42),
      vec2f(sparAng * 0.35, tvMetres.y * 0.45),
      upSpar
    );
  } else if (m == 0u) {
    oakUV = vec2f(tvMetres.x * 0.96, tvMetres.z * 0.33);
  } else if (isWoodMat(m) || m == 28u) {
    let horiz = abs(in.normalLocal.y) > 0.65;
    let zFace = abs(in.normalLocal.z) > 0.72;
    oakUV = select(
      select(vec2f(tvMetres.y * 0.96, tvMetres.z * 0.35), vec2f(tvMetres.y * 0.96, tvMetres.x * 0.35), zFace),
      vec2f(tvMetres.x * 0.96, tvMetres.z * 0.35),
      horiz
    );
  }

  // Uniform control flow: sample oak albedo and evaluate screen-space derivatives before any branches.
  let timberRaw = pow(textureSample(oakAlbedo, oakSampler, oakUV).rgb, vec3f(2.2));
  let relief = dot(timberRaw, vec3f(0.2126, 0.7152, 0.0722));
  let broad = gnoise(vec2f(oakUV.x * 18.0, oakUV.y * 0.7));
  let grain = gnoise(vec2f(oakUV.x * 180.0 + broad * 3.0, oakUV.y * 5.0));
  let oakFootprint = max(length(dpdx(oakUV)), length(dpdy(oakUV)));
  let courseAA = max(fwidth(course), 0.001);
  let deckPlankStep = select(0.145, 0.17, isLusoria);
  let deckCourse = (tvMetres.x + 2.4) / deckPlankStep;
  let deckPlankId = floor(deckCourse);
  let deckAA = max(fwidth(deckCourse), 0.002);
  let deckButtCoord = (tvMetres.z + fract(deckPlankId * 0.413) * 2.0) / 2.6;
  let deckButtAA = max(fwidth(deckButtCoord), 0.001);
  let alongHull = select(tvMetres.z, tvMetres.x, abs(in.normalLocal.z) > 0.72 && m != 15u);
  let buttCoord = (alongHull + fract(sin(courseBoard * 73.17) * 4321.1) * 2.6) / 2.6;
  let buttAA = max(fwidth(buttCoord), 0.0005);
  let sailDepth = canvasThickness(in.uv, m);
  let clothSeam = abs(fract(in.uv.x * 10.0) - 0.5);
  let clothAA = max(fwidth(clothSeam), 0.001);
  let weaveAA = max(fwidth(in.uv.x + in.uv.y), 0.001);
  let reefDist = min(abs(in.uv.y - 0.26), abs(in.uv.y - 0.52));
  let reefAA = max(fwidth(in.uv.y), 0.0005);
  let dxW = dpdx(in.world);
  let dyW = dpdy(in.world);
  let metFootprint = max(length(dpdx(tvMetres)), length(dpdy(tvMetres)));

  let nBase = normalize(in.normal) * select(-1.0, 1.0, front);
  var n = nBase;
  let sx = cross(dyW, nBase);
  let sy = cross(nBase, dxW);
  let det = dot(dxW, sx);
  let invDet = sign(det) / max(abs(det), 1e-6);

  let timber = timberRaw * vec3f(1.02, 0.98, 0.88);
  let strakeEdge = min(fract(course), 1.0 - fract(course));
  let seam = select(1.0 - smoothstep(0.008, 0.035 + courseAA, strakeEdge), 0.0, isGunwaleTube);
  let buttEdge = min(fract(buttCoord), 1.0 - fract(buttCoord));
  let buttSeam = select(1.0 - smoothstep(0.001, 0.004 + buttAA, buttEdge), 0.0, isGunwaleTube);
  let deckEdge = min(fract(deckCourse), 1.0 - fract(deckCourse));
  let deckSeam = 1.0 - smoothstep(0.014, 0.038 + deckAA, deckEdge);
  let deckButtEdge = min(fract(deckButtCoord), 1.0 - fract(deckButtCoord));
  let deckButtSeam = 1.0 - smoothstep(0.001, 0.004 + deckButtAA, deckButtEdge);
  let deckCaulk = max(deckSeam, deckButtSeam * 0.85);
  let boardHash = 0.88 + 0.16 * fract(sin(courseBoard * 74.17) * 4321.1);

  // Authentic Cog/Carrack castle framing ONLY on elevated Cog (0,1) & Carrack (2,3) fore/aft castle bulkheads (never lower hull strakes)
  let isCogOrCarrack = aIdx <= 3u;
  let isCarrack = aIdx == 2u || aIdx == 3u;
  let castleForeZ = select(-3.85, -3.55, isCarrack);
  let castleAftZ = select(2.35, 1.95, isCarrack);
  let isCastleWall = isCogOrCarrack && m == 15u && p.y > 1.85 && abs(in.normalLocal.x) > 0.32 && (p.z > castleAftZ || p.z < castleForeZ);
  let castleMoulding = select(0.0, 1.0 - smoothstep(0.14, 0.22, abs(fract(course * 0.3333) - 0.5) * 3.0), isCastleWall);
  let castleFuttock = select(0.0, 1.0 - smoothstep(0.038, 0.062, abs(fract(p.z / 0.62) - 0.5)), isCastleWall && isCarrack && castleMoulding < 0.5);
  let castleRelief = castleMoulding * 0.0024 + castleFuttock * 0.0018;

  let plankedWall = !isGunwaleTube && (m == 15u || (m == 1u && abs(in.normalLocal.y) < 0.35));
  let woodJoin = select(select(0.0, deckCaulk * 0.85, m == 0u), max(seam, buttSeam * 0.8), plankedWall);
  let woodBump = relief * 0.006 + grain * 0.00065 * (1.0 - smoothstep(0.0005, 0.004, oakFootprint)) - woodJoin * 0.0018 + castleRelief;
  let woodGrad = (dpdx(woodBump) * sx + dpdy(woodBump) * sy) * invDet;

  // Sail canvas 10-panel pillowing, seam puckering & reef-band relief
  let panelPillow = sin(fract(in.uv.x * 10.0 + 0.5) * 3.14159265);
  let seamPucker = sin(in.uv.y * 95.0 + floor(in.uv.x * 10.0) * 2.3) * (1.0 - smoothstep(0.0, 0.08, clothSeam));
  let reefBand = select(0.0, 1.0 - smoothstep(0.007, 0.014 + reefAA, reefDist), m == 9u);
  let canvasRelief = (panelPillow * 0.0032 + seamPucker * 0.0011 + reefBand * 0.0018) * (1.0 - smoothstep(0.004, 0.025, weaveAA));
  let canvasGrad = (dpdx(canvasRelief) * sx + dpdy(canvasRelief) * sy) * invDet;

  // Cast-iron micro-oxide & pit relief
  let ironCoarse = gnoise(vec2f(tvMetres.z * 9.0 + tvMetres.x * 5.0, tvMetres.y * 9.0));
  let ironPits = gnoise(vec2f(tvMetres.z * 68.0, tvMetres.y * 68.0 + tvMetres.x * 34.0));
  let ironRelief = (ironCoarse * 0.0016 - smoothstep(0.62, 0.92, ironPits) * 0.0014) * (1.0 - smoothstep(0.008, 0.045, metFootprint));
  let ironGrad = (dpdx(ironRelief) * sx + dpdy(ironRelief) * sy) * invDet;

  // Dynamic waterline wave-splash capillary meniscus
  let tvWet = clamp((1.0 - smoothstep(0.0, 0.34, abs(in.world.y))) * select(0.0, 0.62, in.world.y < 1.6 && abs(in.normalLocal.x) > 0.22), 0.0, 0.85);

  var albedo = timber * boardHash;
  var rough = clamp(0.86 + (0.2 - relief) * 0.20 + (grain - 0.5) * 0.08, 0.78, 0.95);
  var metal = 0.0;
  var isSail = false;
  var emitGlow = vec3f(0.0);

  if (isWoodMat(m) || m == 28u) {
    n = normalize(nBase - clamp(woodGrad, vec3f(-0.36), vec3f(0.36)));
  }

  if (m == 0u) {
    // Weathered caulked deck planks matching Niña deck joinery
    let plankSalt = 0.88 + 0.16 * fract(sin(deckPlankId * 74.17) * 4321.1);
    let endJoint = abs(fract(deckButtCoord) - 0.5);
    albedo = timber * plankSalt * mix(0.32, 1.0, smoothstep(0.001, 0.004 + deckButtAA, endJoint));
    albedo = mix(albedo, vec3f(0.015, 0.011, 0.008), deckCaulk * 0.86);
    rough = mix(rough, 0.94, deckCaulk);
  } else if (m == 15u) {
    // Exterior hull planking: caulked strakes, castle mouldings & waterproof Stockholm pitch-tar below waterline
    let tar = select(1.0 - smoothstep(-0.22 * draftRatio, 0.02, p.y), 0.0, isGunwaleTube);
    albedo = timber * boardHash * 0.93 * (1.0 - max(seam, buttSeam * 0.8) * 0.58);
    albedo = mix(albedo, vec3f(0.025, 0.022, 0.018), tar * 0.90);
    rough = mix(rough, 0.78, tar);
    if (isCastleWall) {
      let frameWeight = clamp(castleMoulding + castleFuttock * 0.88, 0.0, 1.0);
      if (frameWeight > 0.01) {
        albedo = mix(albedo, timber * vec3f(0.20, 0.18, 0.15), frameWeight);
        rough = mix(rough, 0.90, frameWeight);
      }
    }
  } else if (m == 10u) {
    // Pine masts & yards with longitudinal checking + dark wrought-iron mast hoops
    let sparHoriz2 = dot(in.normalLocal.xz, in.normalLocal.xz);
    let sparAngle = select(0.0, atan2(in.normalLocal.x, in.normalLocal.z), sparHoriz2 > 1e-8);
    let sparGrain = 0.92 + 0.08 * sin(sparAngle * 24.0 + gnoise(vec2f(p.y * 6.0, p.z * 6.0)) * 4.0);
    let checkCrack = smoothstep(0.86, 0.95, sin(sparAngle * 11.0 + p.y * 2.5));
    let band = select(0.0, 1.0 - smoothstep(0.036, 0.075, abs(fract(p.y * 0.65) - 0.5)), sparHoriz2 > 0.35);
    albedo = mix(timber * vec3f(1.08, 0.92, 0.68) * sparGrain * (1.0 - checkCrack * 0.28), vec3f(0.032, 0.031, 0.029), band * 0.78);
    metal = mix(0.0, 0.45, band * 0.78);
    rough = mix(clamp(0.74 + (1.0 - sparGrain) * 0.14 + checkCrack * 0.12, 0.68, 0.90), 0.58, band);
  } else if (m == 16u && !isLusoriaOar) {
    // Tarred wales, stempost, deadeyes & stay collars matching Niña (caravel.js:558)
    albedo = timber * vec3f(0.20, 0.18, 0.15) * (1.0 - seam * 0.30);
    rough = 0.90;
  } else if (m == 17u && !isLusoriaSweep) {
    // Warm ochre painted cap rails, catheads, transom mouldings & balustrade rails matching Niña (caravel.js:559)
    albedo = timber * vec3f(1.10, 1.00, 0.80) * (1.0 - seam * 0.25);
    rough = clamp(rough - 0.04, 0.74, 0.90);
  } else if (m == 1u || m == 5u || m == 6u || m == 7u || m == 14u || m == 16u || m == 17u || m == 18u || m == 28u) {
    // Oak frames, oars, steering sweeps/tillers, casks, benches & sternpost
    let isKeelOrPost = (abs(p.x) < 0.068 && p.y < -0.46) || (abs(p.x) < 0.055 && p.z > 5.25 && p.y < 1.05);
    let isCapRail = p.y > 0.58 && in.normalLocal.y > 0.52 && abs(p.x) > 0.32 && m == 1u;
    let baseOak = select(select(vec3f(0.88, 0.84, 0.76), vec3f(1.06, 0.94, 0.74), isLusoriaOar || isLusoriaSweep || m == 28u), vec3f(1.10, 1.00, 0.80), isCapRail);
    albedo = mix(timber * baseOak * (1.0 - woodJoin * 0.45), timber * vec3f(0.20, 0.18, 0.15), select(0.0, 0.88, isKeelOrPost));
    if (m == 14u) { albedo *= 0.62; }
  } else if (m == 3u || m == 8u) {
    // Cast & wrought iron anchors, ordnance, pintle straps, chainplates & barrel hoops
    let oxide = smoothstep(0.56, 0.88, ironCoarse);
    albedo = mix(vec3f(0.038, 0.037, 0.036), vec3f(0.085, 0.042, 0.024), oxide * 0.38);
    rough = mix(0.48, 0.78, oxide);
    metal = mix(0.76, 0.18, oxide);
    n = normalize(nBase - clamp(ironGrad, vec3f(-0.18), vec3f(0.18)));
  } else if (m == 4u) {
    albedo = vec3f(0.018, 0.014, 0.011);
    rough = 0.92;
  } else if (m == 2u || m == 12u || m == 19u) {
    // 3D Helical 3-strand laid hemp shrouds (2u), running lines (12u) & bolt-ropes (19u)
    let rLoc = normalize(in.normalLocal);
    let ropeLenM = length(tvMetres) * 0.85 + in.uv.y * 2.4;
    let ropeAz = atan2(rLoc.x, rLoc.z + rLoc.y * 0.35);
    let layPhase = ropeLenM * 52.0 + ropeAz * 3.0;
    let layFade = 1.0 - smoothstep(0.6, 2.6, metFootprint * 52.0);
    let strandCos = abs(cos(layPhase * 0.5));
    let groove = 1.0 - strandCos;
    let yarnRipple = sin(ropeLenM * 220.0 - ropeAz * 9.0) * 0.06 * layFade;
    let baseCord = select(vec3f(0.29, 0.22, 0.135), vec3f(0.036, 0.030, 0.024), m == 2u);
    albedo = baseCord * mix(1.0, 0.58 + 0.52 * strandCos + yarnRipple, layFade);
    rough = select(0.88, 0.76, m == 2u) + groove * 0.08 * layFade;
    let twistTilt = sin(layPhase) * 0.24 * layFade;
    n = normalize(nBase + rotateVessel(vec3f(0.0, twistTilt, twistTilt * 0.5), tvYaw, tvPitch, tvRoll));
  } else if (m == 9u || m == 13u) {
    // Woven flax/hemp Baltic canvas with 10-panel seams, reef bands, belly highlights & micro-relief
    isSail = true;
    let warpWeft = 0.95 + 0.05 * gnoise(in.uv * vec2f(95.0, 82.0)) * (1.0 - smoothstep(0.004, 0.022, weaveAA));
    let seamLine = 1.0 - smoothstep(0.008, 0.026 + clothAA, clothSeam);
    let tint = select(vec3f(0.64, 0.59, 0.49), vec3f(0.58, 0.52, 0.41), m == 13u && p.y < 1.3);
    albedo = tint * warpWeft * (1.0 - seamLine * 0.14 - reefBand * 0.10) * clamp(1.10 - (sailDepth - 1.0) * 0.16, 0.74, 1.08);
    rough = mix(0.93, 0.86, max(seamLine, reefBand));
    n = normalize(nBase - clamp(canvasGrad, vec3f(-0.24), vec3f(0.24)));
  } else if (m == 11u) {
    // Recessed crown-glass cabin mullions & glowing stern poop lanterns matching Niña (caravel.js:520)
    let mxEdge = min(fract(p.x * 11.0), 1.0 - fract(p.x * 11.0));
    let myEdge = min(fract(p.y * 10.0), 1.0 - fract(p.y * 10.0));
    let paneMask = smoothstep(0.06, 0.14, min(mxEdge, myEdge));
    let muntinCol = vec3f(0.42, 0.24, 0.055);
    let glassCol = vec3f(0.014, 0.028, 0.032);
    albedo = mix(muntinCol, glassCol, paneMask);
    rough = mix(0.52, 0.07, paneMask);
    metal = mix(0.35, 0.22, paneMask);
    if (p.z > 5.75 && abs(p.x) < 0.22) {
      let dusk = smoothstep(0.35, -0.05, F.sunDir.y);
      emitGlow = vec3f(1.35, 0.72, 0.22) * (0.28 + 0.95 * dusk);
    }
  } else if (m == 20u) {
    albedo = vec3f(0.020, 0.018, 0.015) * mix(0.90, 1.05, relief);
    rough = 0.86;
    n = normalize(nBase - clamp(woodGrad * 0.75, vec3f(-0.25), vec3f(0.25)));
  } else if (m == 21u || m == 25u) {
    albedo = vec3f(0.48, 0.28, 0.065);
    rough = select(0.84, 0.42, m == 25u);
    metal = select(0.0, 0.68, m == 25u);
  } else if (m == 22u) {
    albedo = vec3f(0.32, 0.13, 0.065);
    rough = 0.48;
    metal = 0.70;
  } else if (m == 23u) {
    // Stowed corded merchant wool/linen burlap bales
    let baleWeave = 0.88 + 0.18 * gnoise(in.uv * 42.0 + tvMetres.xz * 18.0);
    albedo = vec3f(0.48, 0.41, 0.29) * baleWeave;
    rough = 0.93;
    n = normalize(nBase - clamp(canvasGrad * 0.8, vec3f(-0.20), vec3f(0.20)));
  } else if (m == 24u) {
    // Un-glazed kiln-fired Baetican terracotta olive-oil amphorae & red pigment trim
    let clayVar = 0.90 + 0.16 * gnoise(vec2f((tvMetres.x + tvMetres.z) * 28.0, tvMetres.y * 34.0));
    albedo = select(vec3f(0.28, 0.032, 0.020), vec3f(0.44, 0.19, 0.095) * clayVar, isLusoria);
    rough = select(0.83, 0.79, isLusoria);
  } else if (m == 26u) {
    albedo = vec3f(0.020, 0.042, 0.10);
  }

  if (tvWet > 0.01 && m != 3u && m != 8u && m != 11u && m != 22u && m != 25u) {
    albedo *= mix(1.0, 0.62, tvWet);
    rough = mix(rough, 0.34, tvWet * 0.55);
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
  if (stateVal > 0.04) {
    let charMix = clamp(stateVal * 0.58, 0.0, 0.82);
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

  let lit = diffTint * amb * 0.82 + direct + spec + envSpec + emitGlow;
  return vec4f(surfaceAir(lit, in.world), 1.0);
}

${damaged || useSubmergedEntry ? `
@fragment fn ${useSubmergedEntry ? 'tvSubmergedFS' : 'tvFS'}(in: TVVertexOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return tvShadeFragment(in, front);
}
` : `
struct TVFragmentOut { @location(0) color: vec4f, @builtin(sample_mask) mask: u32 };
@fragment fn tvSolidFS(in: TVVertexOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return tvShadeFragment(in, front);
}
@fragment fn tvFS(in: TVVertexOut, @builtin(front_facing) front: bool) -> TVFragmentOut {
  let color = tvShadeFragment(in, front);
  // The continuum takes these samples of the pixel (tvContFS); the full ship keeps the rest.
  let takeMask = continuumSamples(f32(in.fade.x) / 65535.0, in.pos.xy, TV_SAMPLES, in.fade.y);
  let keepMask = (~takeMask) & TV_SAMPLE_MASK_ALL;
  var outF: TVFragmentOut;
  outF.color = color;
  outF.mask = keepMask;
  return outF;
}
`}
`;
  return withNeuralPbrTradeVessels(rawSource);
}

export const TRADE_VESSELS_WGSL = /* @__PURE__ */ tradeVesselsSource(false);

export function tradeVesselsSubmergedSource() {
  return tradeVesselsSource(false, 1, { submergedCapture: true });
}

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
  params: vec4f, // cut pixel error (VESSEL_ERROR_PIXELS x coarsening), coarsening, pad, pad
  arch: array<ArchContInfo, ${TRADE_VESSEL_ARCHETYPES}>,
};
`;

const TRADE_CONT_HALF_TRIS = MAX_TRADE_VESSELS * 100;

function buildTradeVesselClearWGSL() {
  const counts = inspectTradeVesselArchetypes().map((a) => `${a.indexCount}u`);
  return /* wgsl */ `
const ARCHETYPE_INDEX_COUNTS = array<u32, ${TRADE_VESSEL_ARCHETYPES}>(${counts.join(', ')});
@group(0) @binding(8) var<storage, read_write> indirect: array<u32>;
@compute @workgroup_size(1) fn main() {
  for (var s = 0u; s < 28u; s++) {
    let base = s * 5u;
    indirect[base] = ARCHETYPE_INDEX_COUNTS[s % ${TRADE_VESSEL_ARCHETYPES}u];
    indirect[base + 1u] = 0u;
    indirect[base + 2u] = 0u;
    indirect[base + 3u] = 0u;
    indirect[base + 4u] = 0u;
  }
  indirect[140u] = 0u; indirect[141u] = 1u; indirect[142u] = 0u; indirect[143u] = 0u;
  indirect[144u] = 0u; indirect[145u] = 1u; indirect[146u] = ${TRADE_CONT_HALF_TRIS * 3}u; indirect[147u] = 0u;
  indirect[148u] = 0u; indirect[149u] = 1u; indirect[150u] = 0u; indirect[151u] = 0u;
}
`;
}

const TRADE_VESSEL_SELECT_WGSL = CONTINUUM_CORE_WGSL + FRAME_WGSL + SHADOW_FRAME + TRADE_SHARED_TYPES_WGSL + /* wgsl */ `
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
  let worldCenter = shipWorld + rotateVesselSel(arch.splatCenterRad.xyz * scaleMul, yaw, pitch, roll);
  let toCenter = worldCenter - F.camPos.xyz;
  let dist = max(length(toCenter), 1.0);
  let boundRad = arch.splatCenterRad.w * scaleMul;
  let clip = F.viewProj * vec4f(earthCurve(toCenter, F.camPos.y), 1.0);
  if (clip.w < -boundRad * 1.4) { return; }
  let tanX = max(length(F.camRight.xyz), 0.15);
  let tanY = max(length(F.camUp.xyz), 0.15);
  let wEff = max(clip.w, 1.0);
  if (abs(clip.x) > wEff * 1.18 + boundRad / tanX || abs(clip.y) > wEff * 1.18 + boundRad / tanY) { return; }

  let focal = 0.5 * F.screen.y / tanY;
  let startErrM = max(arch.splatExtentCol.z, 0.04) * scaleMul;
  // The scene's one pixel-error scalar: the cut's error and the near band both coarsen with it (1 at base).
  let errPx = selP.params.x;
  let coarsening = selP.params.y;
  let spanPx = continuumPixels(2.0 * boundRad, focal, dist);
  let nearHiPx = ${VESSEL_NEAR_HI_PIXELS.toFixed(1)} * coarsening;
  let nearLoPx = ${VESSEL_NEAR_LO_PIXELS.toFixed(1)} * coarsening;

  // Keep full articulated part-built ships crisp across harbor/combat distances until ~38 px total screen span,
  // then MSAA sample_mask crossfade cleanly into the ship-profile continuum over 38 -> 27 px (at base error).
  if (spanPx > nearLoPx) {
    let rawShare = select(clamp(smoothstep(nearHiPx, nearLoPx, spanPx), 0.0, 0.999), 0.0, spanPx >= nearHiPx);
    // A share too small for the continuum half to be listed (below) keeps the ship whole and solid, so the two
    // sides of the band are always drawn together and each takes exactly the other's complement.
    let rawPacked = u32(round(rawShare * 65535.0));
    let sharePacked = select(rawPacked, 0u, rawPacked <= 130u);
    var outInst = inst;
    // share16 + 65536 * instance seed, exact in f32 (i < ${MAX_TRADE_VESSELS}); tvVS unpacks it to a flat vec2u.
    outInst.animSink.z = f32(sharePacked + (i << 16u));
    let nearSlot = atomicAdd(&indirect[aIdx * 5u + 1u], 1u);
    if (nearSlot < ${MAX_TRADE_VESSELS}u) {
      nearOut[aIdx * ${MAX_TRADE_VESSELS}u + nearSlot] = outInst;
    }
    if (sharePacked == 0u) {
      // 100% opaque intact hull -> TBDR hardware Early-Z / HSR solid slice 14..20
      let solidSlot = atomicAdd(&indirect[(14u + aIdx) * 5u + 1u], 1u);
      if (solidSlot < ${MAX_TRADE_VESSELS}u) {
        nearOut[(14u + aIdx) * ${MAX_TRADE_VESSELS}u + solidSlot] = outInst;
      }
    } else {
      // MSAA crossfade band (38 -> 27 px) -> sample_mask slice 21..27 + continuum crossfade half
      let fadeSlot = atomicAdd(&indirect[(21u + aIdx) * 5u + 1u], 1u);
      if (fadeSlot < ${MAX_TRADE_VESSELS}u) {
        nearOut[(21u + aIdx) * ${MAX_TRADE_VESSELS}u + fadeSlot] = outInst;
      }
      // The continuum's half of the band; its seed is entry.x == i, the same instance seed packed above.
      let triCount = u32(round(stepMeta[arch.counts.x].z));
      let startVert = atomicAdd(&indirect[144u], triCount * 3u);
      let startTri = startVert / 3u;
      if (startTri + triCount <= selP.ctrl.y) {
        for (var t = 0u; t < triCount; t++) {
          contList[${TRADE_CONT_HALF_TRIS}u + startTri + t] = vec4u(i, t, 0u, sharePacked);
        }
      }
    }
    return;
  }

  if (spanPx <= CONTINUUM_SPLAT_PIXELS) {
    // Sub-pixel horizon splats thin by the core's area-preserving hash, seeded by the instance so it holds still.
    let inflate = continuumThin(spanPx, i);
    if (inflate <= 0.0) { return; }
    let bow = vec2f(sin(yaw), -cos(yaw));
    let viewXZ = normalize(vec2f(toCenter.x, toCenter.z) + vec2f(1e-5, 0.0));
    let broadFactor = abs(bow.x * viewXZ.y - bow.y * viewXZ.x);
    let worldHalfW = mix(arch.splatExtentCol.x, arch.splatExtentCol.w, broadFactor) * scaleMul * inflate;
    let worldHalfH = arch.splatExtentCol.y * scaleMul * inflate;
    let sVert = atomicAdd(&indirect[148u], 3u);
    let sIdx = sVert / 3u;
    if (sIdx < selP.ctrl.w) {
      splatList[sIdx * 2u] = vec4f(worldCenter, worldHalfW);
      splatList[sIdx * 2u + 1u] = vec4f(arch.splatCol.rgb, worldHalfH);
    }
    return;
  }

  let stepBase = arch.counts.x;
  let stepCount = arch.counts.y;
  let distAtLo = (2.0 * boundRad * focal) / nearLoPx;
  // Allowed error in the archetype's own (unscaled) metres: the instance's scale folds into the focal length.
  let rawErr = continuumAllowedError(errPx, focal * scaleMul, dist);
  let errAtLo = continuumAllowedError(errPx, focal * scaleMul, distAtLo);
  let stepMaxErr = stepMeta[stepBase + stepCount].x;
  // The morph reaches the minimal core by ~CONTINUUM_SPLAT_PIXELS at base error (27 / 7.7 px), sooner when coarser,
  // and never later than the splat, so a finer-than-base scalar cannot pop from a detailed cut into the splat.
  let morphSpan = min(6.7, nearLoPx / CONTINUUM_SPLAT_PIXELS - 1.0);
  let contT = clamp((rawErr - errAtLo) / max(errAtLo * morphSpan, 1e-3), 0.0, 1.0);
  let allowedErr = mix(startErrM, stepMaxErr, contT);
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
  let startVert = atomicAdd(&indirect[140u], triCount * 3u);
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
  return CONTINUUM_CORE_WGSL + FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + VESSEL_LIGHTING + TRADE_SHARED_TYPES_WGSL + /* wgsl */ `
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
  // The band's share (of 65535; 65535 outside the band) and the instance seed, matching the full ship's tvFS.
  @location(3) @interpolate(flat) fade: vec2u,
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
  let vi = baseIndices[arch.counts.z + entry.y * 3u + corner];
  let stepVerts = u32(max(1.0, round(arch.splatCol.w)));
  let v0 = contStates[arch.counts.w + stepIdx * stepVerts + vi];
  let v1 = contStates[arch.counts.w + min(stepIdx + 1u, arch.counts.y) * stepVerts + vi];
  let colEntry = contVertCols[stepVerts * aIdx + vi];
  var rawLocalP = mix(vec3f(v0.px, v0.py, v0.pz), vec3f(v1.px, v1.py, v1.pz), morphT);
  if (colEntry.a > 0.5) {
    let sailFrac = clamp(1.0 - inst.animSink.w, 0.0, 1.0);
    let anchorY = max(1.4, arch.splatExtentCol.y * 0.42);
    rawLocalP.x *= mix(0.08, 1.0, sailFrac);
    rawLocalP.y = mix(anchorY, rawLocalP.y, mix(0.28, 1.0, sailFrac));
  }
  let scaleMul = max(inst.attScaleArch.z, 0.25);
  let localP = rawLocalP * scaleMul;
  let n0 = unpack4x8unorm(v0.normPacked).xyz * 2.0 - 1.0;
  let n1 = unpack4x8unorm(v1.normPacked).xyz * 2.0 - 1.0;
  let localN = normalize(mix(n0, n1, morphT) + vec3f(0.0, 1e-4, 0.0));
  let shipWorld = inst.posYaw.xyz + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  let worldP = shipWorld + rotateVesselCont(localP, inst.posYaw.w, inst.attScaleArch.x, inst.attScaleArch.y);
  let worldN = normalize(rotateVesselCont(localN, inst.posYaw.w, inst.attScaleArch.x, inst.attScaleArch.y));

  var o: TVContOut;
  o.pos = F.viewProj * vec4f(earthCurve(worldP - F.camPos.xyz, F.camPos.y), 1.0);
  o.world = worldP;
  o.normal = worldN;
  o.color = colEntry.rgb;
  o.fade = vec2u(entry.w & 0xFFFFu, entry.x);
  return o;
}

fn tvContShade(in: TVContOut, front: bool) -> vec4f {
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
  return vec4f(surfaceAir(lit, in.world), 1.0);
}

struct TVContFragOut { @location(0) color: vec4f, @builtin(sample_mask) mask: u32 };
@fragment fn tvContSolidFS(in: TVContOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return tvContShade(in, front);
}
@fragment fn tvContFS(in: TVContOut, @builtin(front_facing) front: bool) -> TVContFragOut {
  let color = tvContShade(in, front);
  // Exactly the samples the full ship's tvFS gives up; whole outside the band.
  let mask = select(continuumSamples(f32(in.fade.x) / 65535.0, in.pos.xy, TV_CONT_SAMPLES, in.fade.y), TV_CONT_MASK_ALL, in.fade.x >= 65535u);
  return TVContFragOut(color, mask);
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

export const TRADE_VESSEL_CONTINUUM_WGSL = /* @__PURE__ */ buildTradeVesselContinuumWGSL(4);
export const TRADE_VESSEL_SPLAT_WGSL = /* @__PURE__ */ buildTradeVesselSplatWGSL(4);

// ============================================================================
// GPU Multi-Point Ocean & River Wave Buoyancy Compute Pass (Zero CPU Readbacks)
// ============================================================================
export const TRADE_VESSEL_WAVE_WGSL = FRAME_WGSL + SURFACE_WAVE_SAMPLE + TRADE_SHARED_TYPES_WGSL + /* wgsl */ `
struct TradeWaveParams {
  ctrl: vec4u,   // x: activeCount, y: maxSlots, z: hasSeaDisp, w: pad
  timing: vec4f, // x: dt, y: elapsedSec, z: windSpeed, w: storm
};
struct VesselWaveInput {
  posYaw: vec4f,  // x: localX, y: baseWaterY, z: localZ, w: yaw
  spans: vec4f,   // x: zSpan, y: xSpan, z: totalSinkage, w: minKeelY
  weights: vec4f, // x: swellWeight, y: wakeWeight, z: basePitch, w: baseRoll
  slots: vec4u,   // x: stateSlot, y: intactSlot, z: crewSlot, w: flags (bit0: groundedOrSunk, bit1: isRiver, bit2: reset)
};
struct VesselHydroState {
  pose: vec4f,    // x: heaveY, y: pitch, z: roll, w: initialized
  vel: vec4f,     // x: heaveVel, y: pitchVel, z: rollVel, w: pad
};

@group(0) @binding(0) var<uniform> waveP: TradeWaveParams;
@group(0) @binding(1) var<uniform> F: Frame;
@group(0) @binding(2) var<uniform> nearTerrain: TradeNearDomain;
@group(0) @binding(3) var<storage, read> waveIn: array<VesselWaveInput>;
@group(0) @binding(4) var<storage, read_write> hydroState: array<VesselHydroState>;
@group(0) @binding(5) var<storage, read_write> srcInstances: array<TradeInstance>;
@group(0) @binding(6) var<storage, read_write> crewInstances: array<TradeInstance>;
@group(0) @binding(7) var seaDispTex: texture_2d_array<f32>;
@group(0) @binding(8) var seaSamp: sampler;
@group(0) @binding(9) var wakeSamp: sampler;
@group(0) @binding(10) var<uniform> SW: SurfaceWaveUniform;
@group(0) @binding(11) var surfaceWaveTex: texture_2d_array<f32>;

fn tvSeaDisplacement(p: vec2f, footprint: f32) -> vec3f {
  var d = vec3f(0.0);
  let seaSize = f32(textureDimensions(seaDispTex).x);
  for (var c = 0u; c < ${CASCADES}u; c++) {
    let invL = F.cascInvL[c >> 2u][c & 3u];
    let texel = max(1.0 / (max(invL, 1e-4) * max(seaSize, 1.0)), 1e-4);
    let lod = select(0.0, clamp(log2(max(footprint / texel, 1.0)) + 0.75, 0.0, 8.0), seaSize > 1.5);
    let w = select(1.0, clamp(1.0 - smoothstep(1.5, 4.0, footprint * invL), 0.0, 1.0), seaSize > 1.5);
    d += textureSampleLevel(seaDispTex, seaSamp, p * invL, i32(c), lod).xyz * w;
  }
  return d;
}

fn tvSampleWaterOffset(p: vec2f, footprint: f32, swellWeight: f32, wakeWeight: f32, isRiver: bool, elapsedSec: f32) -> f32 {
  var seaY = 0.0;
  if (swellWeight > 0.001) {
    if (waveP.ctrl.z > 0u) {
      var q = p;
      for (var it = 0; it < 3; it++) {
        q = p - tvSeaDisplacement(q, footprint).xz;
      }
      seaY = tvSeaDisplacement(q, footprint).y * swellWeight;
    } else {
      let wv = waveP.timing.zw;
      let wSpd = length(wv);
      let wDir = select(vec2f(1.0, 0.0), wv / max(wSpd, 1e-3), wSpd > 1e-3);
      let hs = min(1.45, 0.07 + wSpd * wSpd * 0.0046);
      seaY = hs * (
        0.64 * sin(dot(p, wDir) * 0.055 - elapsedSec * 0.735)
        + 0.36 * sin(dot(p, vec2f(wDir.x * 0.82 - wDir.y * 0.57, wDir.y * 0.82 + wDir.x * 0.57)) * 0.098 - elapsedSec * 0.98)
      ) * swellWeight;
    }
  }
  let wakeCap = select(0.42, 0.12, isRiver);
  let rawWakeSample = surfaceWaveAt(p).x;
  let safeWakeSample = select(0.0, rawWakeSample, (rawWakeSample == rawWakeSample) && ((bitcast<u32>(rawWakeSample) & 0x7fffffffu) < 0x7f800000u) && abs(rawWakeSample) <= 1e4);
  let rawWake = safeWakeSample * wakeWeight;
  let wakeY = clamp(rawWake, -wakeCap, wakeCap);
  var chopY = 0.0;
  if (isRiver && wakeWeight > 0.001) {
    chopY = (
      sin(dot(p, vec2f(0.41, 0.29)) - elapsedSec * 2.15) * 0.013
      + sin(dot(p, vec2f(-0.27, 0.53)) + elapsedSec * 1.65) * 0.009
    ) * wakeWeight;
  }
  let totalOffset = seaY + wakeY + chopY;
  if (!(totalOffset == totalOffset) || ((bitcast<u32>(totalOffset) & 0x7fffffffu) >= 0x7f800000u) || abs(totalOffset) > 1e4) {
    return 0.0;
  }
  return totalOffset;
}

fn tvFiniteVec4(v: vec4f) -> bool {
  let okEq = all(v == v) && !any(v != v);
  let okBits = all((bitcast<vec4u>(v) & vec4u(0x7fffffffu)) < vec4u(0x7f800000u));
  return okEq && okBits && all(abs(v) <= vec4f(1e4));
}

fn tvStepDampedSpring(x: f32, v: f32, goal: f32, omega: f32, zeta: f32, dt: f32) -> vec2f {
  let k = omega * omega;
  let c = 2.0 * zeta * omega;
  let denom = 1.0 + c * dt + k * dt * dt;
  let nv = (v + dt * k * (goal - x)) / denom;
  let nx = x + dt * nv;
  return vec2f(nx, nv);
}

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= waveP.ctrl.x) { return; }
  let inp = waveIn[i];
  let maxSlots = waveP.ctrl.y;
  let stateSlot = min(inp.slots.x, max(1u, maxSlots) - 1u);
  let intactSlot = inp.slots.y;
  let crewSlot = inp.slots.z;
  let flags = inp.slots.w;
  let groundedOrSunk = (flags & 1u) != 0u;
  let isRiver = (flags & 2u) != 0u;
  let forceReset = (flags & 4u) != 0u;

  let yaw = inp.posYaw.w;
  let bow = vec2f(sin(yaw), -cos(yaw));
  let stbd = vec2f(cos(yaw), sin(yaw));
  let zSpan = max(1.8, inp.spans.x);
  let xSpan = max(0.75, inp.spans.y);
  let totalSinkage = inp.spans.z;
  let minKeelY = inp.spans.w;
  let swellWeight = inp.weights.x;
  let wakeWeight = inp.weights.y;
  let basePitch = inp.weights.z;
  let baseRoll = inp.weights.w;
  let elapsedSec = select(F.camPos.w, waveP.timing.y, abs(waveP.timing.y) > 1e-5);
  let footprint = max(1.35, xSpan * 1.15);

  let pMid = inp.posYaw.xz + nearTerrain.grid.yz;
  let hMid = tvSampleWaterOffset(pMid, footprint, swellWeight, wakeWeight, isRiver, elapsedSec);
  let hBow = tvSampleWaterOffset(pMid + bow * zSpan, footprint, swellWeight, wakeWeight, isRiver, elapsedSec);
  let hStern = tvSampleWaterOffset(pMid - bow * zSpan, footprint, swellWeight, wakeWeight, isRiver, elapsedSec);
  let hPort = tvSampleWaterOffset(pMid - stbd * xSpan, footprint, swellWeight, wakeWeight, isRiver, elapsedSec);
  let hStbd = tvSampleWaterOffset(pMid + stbd * xSpan, footprint, swellWeight, wakeWeight, isRiver, elapsedSec);

  var targetY = max(minKeelY, inp.posYaw.y - totalSinkage);
  var targetPitch = basePitch;
  var targetRoll = baseRoll;
  if (!groundedOrSunk) {
    let waveMean = (hBow + hStern + hPort + hStbd + 2.0 * hMid) / 6.0;
    let pitchGain = select(0.78, 0.58, isRiver);
    let rollGain = select(0.74, 0.52, isRiver);
    let wavePitch = atan2(hBow - hStern, 2.0 * zSpan) * pitchGain;
    let waveRoll = atan2(hStbd - hPort, 2.0 * xSpan) * rollGain;
    targetY = max(minKeelY, inp.posYaw.y + waveMean - totalSinkage);
    targetPitch = basePitch + clamp(wavePitch, -0.32, 0.32);
    targetRoll = baseRoll + clamp(waveRoll, -0.38, 0.38);
  }

  var st = hydroState[stateSlot];
  let dt = clamp(waveP.timing.x, 0.0, 0.05);
  let stCorrupt = !tvFiniteVec4(st.pose) || !tvFiniteVec4(st.vel);
  if (forceReset || st.pose.w < 0.5 || groundedOrSunk || stCorrupt) {
    st.pose = vec4f(targetY, targetPitch, targetRoll, 1.0);
    st.vel = vec4f(0.0);
  } else if (dt > 1e-5) {
    let omegaH = clamp(3.8 / sqrt(max(zSpan * 0.22, 0.55)), 2.1, 4.6);
    let omegaP = clamp(3.2 / sqrt(max(zSpan * 0.25, 0.55)), 1.8, 4.0);
    let omegaR = clamp(2.8 / sqrt(max(xSpan * 0.55, 0.45)), 1.5, 3.6);
    let zeta = select(0.86, 0.94, isRiver);
    let hs = tvStepDampedSpring(st.pose.x, st.vel.x, targetY, omegaH, zeta, dt);
    let ps = tvStepDampedSpring(st.pose.y, st.vel.y, targetPitch, omegaP, zeta, dt);
    let rs = tvStepDampedSpring(st.pose.z, st.vel.z, targetRoll, omegaR, zeta, dt);
    st.pose = vec4f(max(minKeelY, hs.x), ps.x, rs.x, 1.0);
    st.vel = vec4f(hs.y, ps.y, rs.y, 0.0);
    if (!tvFiniteVec4(st.pose) || !tvFiniteVec4(st.vel)) {
      st.pose = vec4f(targetY, targetPitch, targetRoll, 1.0);
      st.vel = vec4f(0.0);
    }
  } else {
    st.pose.x = max(minKeelY, st.pose.x);
  }
  hydroState[stateSlot] = st;

  if (intactSlot < maxSlots && intactSlot < arrayLength(&srcInstances)) {
    srcInstances[intactSlot].posYaw.y = st.pose.x;
    srcInstances[intactSlot].attScaleArch.x = st.pose.y;
    srcInstances[intactSlot].attScaleArch.y = st.pose.z;
  }
  if (crewSlot < maxSlots && crewSlot < arrayLength(&crewInstances)) {
    crewInstances[crewSlot].posYaw.y = st.pose.x;
    crewInstances[crewSlot].attScaleArch.x = st.pose.y;
    crewInstances[crewSlot].attScaleArch.y = st.pose.z;
  }
}
`;

// ============================================================================
// 100% GPU Crew-Skeleton Rigged Deck-Crew Assets, 3D Merchant Codex & Shaders
// ============================================================================
const DECK_CREW_MODELS = 2; // 0: male (sailor), 1: female
const DECK_CREW_BUCKETS = DECK_CREW_MODELS * DECK_CREW_TIERS + DECK_CREW_MODELS * 2; // 0..7 solid render, 8..9 shadow, 10..11 crossfade
const DECK_CREW_DRAW_WORDS = 68; // 12 * 5 DrawIndexedIndirect + 4 DrawIndirect splat + 4 pad
const DECK_CREW_BODY_WORDS = 8; // 32 bytes per visible soul
const DECK_CREW_STATION_WORDS = 8; // 32 bytes per (vesselSlot, stationIdx)
const DECK_CREW_LOOK_WORDS = 20; // 80 bytes TownLook
const DECK_CREW_MAX_TOTAL = MAX_TRADE_VESSELS * MAX_DECK_STATIONS_PER_VESSEL;
const DECK_CREW_JOINT_FLOATS = CREW_JOINT_COUNT * 16;

const DECK_CREW_VERTEX_BUFFERS = Object.freeze([{
  arrayStride: 60,
  stepMode: 'vertex',
  attributes: Object.freeze([
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x3' },
    { shaderLocation: 3, offset: 36, format: 'uint16x4' },
    { shaderLocation: 4, offset: 44, format: 'float32x4' },
  ]),
}]);

const DECK_CREW_SHIRTS = Object.freeze([
  [0.58, 0.53, 0.43], [0.20, 0.28, 0.36], [0.42, 0.14, 0.09], [0.30, 0.32, 0.20],
  [0.48, 0.36, 0.20], [0.16, 0.21, 0.31], [0.54, 0.49, 0.38], [0.25, 0.18, 0.13],
]);
const DECK_CREW_COATS_ELITE = Object.freeze([
  [0.11, 0.15, 0.26], [0.36, 0.08, 0.07], [0.16, 0.12, 0.08], [0.12, 0.21, 0.16],
  [0.26, 0.17, 0.09], [0.22, 0.11, 0.20],
]);
const DECK_CREW_TROUSERS = Object.freeze([
  [0.11, 0.09, 0.075], [0.09, 0.11, 0.14], [0.16, 0.12, 0.08], [0.19, 0.15, 0.11],
  [0.07, 0.07, 0.08], [0.22, 0.11, 0.07],
]);
const DECK_CREW_PEOPLE = Object.freeze([
  { skin: [0.74, 0.45, 0.31], hair: [0.048, 0.024, 0.014], face: [0.98, 1.02, 0.003, 1.00] },
  { skin: [0.66, 0.38, 0.23], hair: [0.012, 0.009, 0.008], face: [1.03, 0.98, -0.004, 0.96] },
  { skin: [0.56, 0.30, 0.17], hair: [0.016, 0.011, 0.009], face: [1.04, 1.00, 0.002, 0.98] },
  { skin: [0.39, 0.18, 0.10], hair: [0.010, 0.007, 0.006], face: [1.04, 1.02, 0.004, 0.94] },
  { skin: [0.21, 0.085, 0.048], hair: [0.012, 0.008, 0.007], face: [1.04, 1.02, -0.002, 0.96] },
  { skin: [0.80, 0.52, 0.36], hair: [0.31, 0.065, 0.016], face: [0.99, 0.96, 0.002, 1.02] },
  { skin: [0.61, 0.33, 0.20], hair: [0.030, 0.016, 0.011], face: [1.01, 1.00, 0.004, 0.98] },
  { skin: [0.46, 0.22, 0.12], hair: [0.011, 0.008, 0.007], face: [1.04, 1.01, 0.003, 0.93] },
]);

function deckCrewHash(a, b = 0) {
  let h = (Math.imul((a | 0) + 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function deckCrewStringHash(str) {
  const s = String(str ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h | 0;
}

function invertMat4ColMajor(m) {
  const inv = new Float32Array(16);
  const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
  const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
  const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
  const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

  const b00 = m00 * m11 - m01 * m10;
  const b01 = m00 * m12 - m02 * m10;
  const b02 = m00 * m13 - m03 * m10;
  const b03 = m01 * m12 - m02 * m11;
  const b04 = m01 * m13 - m03 * m11;
  const b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30;
  const b07 = m20 * m32 - m22 * m30;
  const b08 = m20 * m33 - m23 * m30;
  const b09 = m21 * m32 - m22 * m31;
  const b10 = m21 * m33 - m23 * m31;
  const b11 = m22 * m33 - m23 * m32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-10) {
    inv[0] = 1; inv[5] = 1; inv[10] = 1; inv[15] = 1;
    return inv;
  }
  const invDet = 1.0 / det;
  inv[0] = (m11 * b11 - m12 * b10 + m13 * b09) * invDet;
  inv[1] = (-m01 * b11 + m02 * b10 - m03 * b09) * invDet;
  inv[2] = (m31 * b05 - m32 * b04 + m33 * b03) * invDet;
  inv[3] = (-m21 * b05 + m22 * b04 - m23 * b03) * invDet;
  inv[4] = (-m10 * b11 + m12 * b08 - m13 * b07) * invDet;
  inv[5] = (m00 * b11 - m02 * b08 + m03 * b07) * invDet;
  inv[6] = (-m30 * b05 + m32 * b02 - m33 * b01) * invDet;
  inv[7] = (m20 * b05 - m22 * b02 + m23 * b01) * invDet;
  inv[8] = (m10 * b10 - m11 * b08 + m13 * b06) * invDet;
  inv[9] = (-m00 * b10 + m01 * b08 - m03 * b06) * invDet;
  inv[10] = (m30 * b04 - m31 * b02 + m33 * b00) * invDet;
  inv[11] = (-m20 * b04 + m21 * b02 - m23 * b00) * invDet;
  inv[12] = (-m10 * b09 + m11 * b07 - m12 * b06) * invDet;
  inv[13] = (m00 * b09 - m01 * b07 + m02 * b06) * invDet;
  inv[14] = (-m30 * b03 + m31 * b01 - m32 * b00) * invDet;
  inv[15] = (m20 * b03 - m21 * b01 + m22 * b00) * invDet;
  return inv;
}

// Clones a crew GLB model, attaches 3D period garment/hat/beard components, and appends a
// watertight 3D leather-and-parchment merchant codex mesh bound to `hand_l` (comp = 24u).
export function appendMerchantCodexToModel(srcModel, sex = 'male') {
  if (!srcModel?.vertices || !srcModel?.animator) return null;
  const rawBytes = srcModel.vertices.buffer.slice(
    srcModel.vertices.byteOffset,
    srcModel.vertices.byteOffset + srcModel.vertices.byteLength,
  );
  const model = {
    ...srcModel,
    componentsAttached: Boolean(srcModel.componentsAttached),
    distantIndices: srcModel.distantIndices ?? null,
    vertices: new Float32Array(rawBytes),
    vertexCount: srcModel.vertexCount ?? (srcModel.vertices.byteLength / 60),
    indices: srcModel.indices.slice(),
    lods: Array.isArray(srcModel.lods)
      ? srcModel.lods.map((l) => ({ ...l, indices: l.indices.slice(), indexCount: l.indexCount ?? l.indices.length }))
      : null,
  };
  if (!model.componentsAttached) {
    attachCrewComponents(model, sex);
  }

  const distantIndices = createDistantCrewLOD(model);
  const a = model.animator;
  const handNode = a.nodeIndex ? a.nodeIndex('hand_l') : -1;
  const handJoint = handNode >= 0 && a.joints ? a.joints.indexOf(handNode) : -1;
  if (handJoint < 0 || !a.inverseBinds) {
    const baseLods = model.lods ?? [{ indices: model.indices, indexCount: model.indices.length }];
    return {
      model,
      tiers: [
        baseLods[0],
        baseLods[1] ?? baseLods[0],
        baseLods[2] ?? baseLods[1] ?? baseLods[0],
        { indices: distantIndices, indexCount: distantIndices.length },
      ],
      codexVertexCount: 0,
      codexIndexCount: 0,
    };
  }

  const ibm = a.inverseBinds.subarray(handJoint * 16, handJoint * 16 + 16);
  const bindWorld = invertMat4ColMajor(ibm);
  const codexVerts = [];
  const codexInds = [];
  const baseVert = model.vertexCount ?? (model.vertices.byteLength / 60);

  const pushCodexBox = (x0, x1, y0, y1, z0, z1, garment, shadeBase) => {
    const faces = [
      { n: [0, 0, 1], p: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], s: 1.06 },
      { n: [0, 0, -1], p: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], s: 0.88 },
      { n: [1, 0, 0], p: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], s: 0.98 },
      { n: [-1, 0, 0], p: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], s: 0.92 },
      { n: [0, 1, 0], p: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], s: 1.08 },
      { n: [0, -1, 0], p: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], s: 0.82 },
    ];
    for (const f of faces) {
      const vStart = baseVert + codexVerts.length;
      const sh = Math.max(0.66, Math.min(1.16, shadeBase * f.s));
      const nx = bindWorld[0] * f.n[0] + bindWorld[4] * f.n[1] + bindWorld[8] * f.n[2];
      const ny = bindWorld[1] * f.n[0] + bindWorld[5] * f.n[1] + bindWorld[9] * f.n[2];
      const nz = bindWorld[2] * f.n[0] + bindWorld[6] * f.n[1] + bindWorld[10] * f.n[2];
      const nLen = Math.hypot(nx, ny, nz) || 1;
      for (const pt of f.p) {
        const px = bindWorld[0] * pt[0] + bindWorld[4] * pt[1] + bindWorld[8] * pt[2] + bindWorld[12];
        const py = bindWorld[1] * pt[0] + bindWorld[5] * pt[1] + bindWorld[9] * pt[2] + bindWorld[13];
        const pz = bindWorld[2] * pt[0] + bindWorld[6] * pt[1] + bindWorld[10] * pt[2] + bindWorld[14];
        codexVerts.push({
          pos: [px, py, pz],
          nrm: [nx / nLen, ny / nLen, nz / nLen],
          // comp = 24u => color.g = 48.0 + sh; garment = 5u (leather) or 6u (parchment) => color.b = 2*garment + sh
          col: [sh, 48.0 + sh, 2.0 * garment + sh],
        });
      }
      codexInds.push(vStart, vStart + 1, vStart + 2, vStart, vStart + 2, vStart + 3);
    }
  };

  // 1. Stiff dark-leather ledger boards & ribbed spine held in hand_l palm
  pushCodexBox(-0.072, 0.072, 0.025, 0.205, 0.014, 0.026, 5, 0.94);
  // 2. Cream laid-rag parchment page block slightly inset from leather boards
  pushCodexBox(-0.064, 0.066, 0.033, 0.197, 0.026, 0.048, 6, 1.04);
  // 3. Upper leather cover leaf & brass fore-edge clasp strap
  pushCodexBox(-0.072, 0.072, 0.025, 0.205, 0.048, 0.055, 5, 0.98);
  pushCodexBox(0.058, 0.075, 0.098, 0.132, 0.013, 0.057, 5, 1.12);

  const totalVerts = baseVert + codexVerts.length;
  const mergedBuf = new ArrayBuffer(totalVerts * 60);
  new Uint8Array(mergedBuf).set(new Uint8Array(model.vertices.buffer, model.vertices.byteOffset, baseVert * 60));
  const f32 = new Float32Array(mergedBuf);
  const u16 = new Uint16Array(mergedBuf);
  for (let i = 0; i < codexVerts.length; i++) {
    const vIdx = baseVert + i;
    const fOff = vIdx * 15;
    const uOff = vIdx * 30;
    const cv = codexVerts[i];
    f32[fOff + 0] = cv.pos[0];
    f32[fOff + 1] = cv.pos[1];
    f32[fOff + 2] = cv.pos[2];
    f32[fOff + 3] = cv.nrm[0];
    f32[fOff + 4] = cv.nrm[1];
    f32[fOff + 5] = cv.nrm[2];
    f32[fOff + 6] = cv.col[0];
    f32[fOff + 7] = cv.col[1];
    f32[fOff + 8] = cv.col[2];
    u16[uOff + 18] = handJoint;
    u16[uOff + 19] = 0;
    u16[uOff + 20] = 0;
    u16[uOff + 21] = 0;
    f32[fOff + 11] = 1.0;
    f32[fOff + 12] = 0.0;
    f32[fOff + 13] = 0.0;
    f32[fOff + 14] = 0.0;
  }
  model.vertices = f32;
  model.vertexCount = totalVerts;

  const appendInds = (arr) => {
    const out = new Uint32Array(arr.length + codexInds.length);
    out.set(arr, 0);
    out.set(codexInds, arr.length);
    return { indices: out, indexCount: out.length };
  };
  const baseLods = model.lods ?? [{ indices: model.indices, indexCount: model.indices.length }];
  const tier0 = appendInds(baseLods[0].indices);
  const tier1 = appendInds((baseLods[1] ?? baseLods[0]).indices);
  const tier2Src = baseLods[2] ?? baseLods[1] ?? baseLods[0];
  const tier2 = { indices: new Uint32Array(tier2Src.indices), indexCount: tier2Src.indices.length };
  const tier3 = { indices: new Uint32Array(distantIndices), indexCount: distantIndices.length };

  return {
    model,
    tiers: [tier0, tier1, tier2, tier3],
    codexVertexCount: codexVerts.length,
    codexIndexCount: codexInds.length,
  };
}

// Bakes 7 crew-skeleton deck station clips once at init:
// 0: Idle (from bakeTownClips), 1: Work/Watch, 2: Helm, 3: Merchant (holding raised codex in hand_l),
// 4: Seated Port Sweep Row (side = -1), 5: Seated Starboard Sweep Row (side = +1), 6: Seated Paddle (taino-canoe).
export function bakeDeckCrewClips(a) {
  const town = bakeTownClips(a);
  const idleStart = town.layout[0];
  const idleCount = Math.min(28, Math.max(1, town.layout[1]));
  const idleDur = a.clips.get('Idle')?.duration ?? 1.6;
  const braceCount = 20;
  const helmCount = 20;
  const merchCount = 24;
  const rowCount = 24;
  const paddleCount = 20;

  const counts = [idleCount, braceCount, helmCount, merchCount, rowCount, rowCount, paddleCount];
  const layout = new Uint32Array(counts.length * 2);
  let totalFrames = 0;
  for (let c = 0; c < counts.length; c++) {
    layout[c * 2] = totalFrames;
    layout[c * 2 + 1] = counts[c];
    totalFrames += counts[c];
  }
  const palettes = new Float32Array(totalFrames * DECK_CREW_JOINT_FLOATS);

  // Clip 0: Idle (copied from bakeTownClips clip 0)
  palettes.set(
    town.palettes.subarray(idleStart * DECK_CREW_JOINT_FLOATS, (idleStart + idleCount) * DECK_CREW_JOINT_FLOATS),
    layout[0] * DECK_CREW_JOINT_FLOATS,
  );

  // Clip 1: Deckhand Work / Watch (upright standing sailor tending lines & deck gear; never combat-crouch 'Brace')
  bakeWorkStationClip(a, braceCount, idleDur, (f) => {
    palettes.set(a.palette, (layout[2] + f) * DECK_CREW_JOINT_FLOATS);
  });

  // Clip 2: Helm (both hands gripping tiller / wheel forward with natural downward elbows & subtle steering sway)
  const spine2 = a.nodeIndex ? a.nodeIndex('spine_02') : -1;
  const neck1 = a.nodeIndex ? a.nodeIndex('neck_01') : -1;
  const dummyStanding = { position: [0, 0, 0], yaw: 0, pitch: 0, roll: 0, climbPitch: 0, scale: [1, 1, 1] };
  for (let f = 0; f < helmCount; f++) {
    const ang = (f / helmCount) * Math.PI * 2;
    const sway = Math.sin(ang) * 0.04;
    a.sample('Idle', (f / helmCount) * idleDur);
    if (spine2 >= 0) turnBone(a, spine2, [0, 1, 0], [sway * 0.25, Math.cos(0.08), Math.sin(0.08)]);
    const chest = spine2 >= 0 ? Array.from(a.world[spine2].subarray(12, 15)) : [0, 1.22, 0];
    solveCrewLimb(a, ['upperarm_l', 'lowerarm_l', 'hand_l'], [chest[0] + 0.16 + sway, chest[1] - 0.12, chest[2] + 0.28], [0.68, -0.35, -0.45]);
    solveCrewLimb(a, ['upperarm_r', 'lowerarm_r', 'hand_r'], [chest[0] - 0.16 + sway, chest[1] - 0.14, chest[2] + 0.26], [-0.68, -0.35, -0.45]);
    poseCrewFingers(a, dummyStanding, 0.88, 0.88);
    a.update();
    palettes.set(a.palette, (layout[4] + f) * DECK_CREW_JOINT_FLOATS);
  }

  // Clip 3: Merchant / Supercargo (left hand cradling open 3D leather codex at chest, right hand reckoning cargo)
  for (let f = 0; f < merchCount; f++) {
    const ang = (f / merchCount) * Math.PI * 2;
    const breathe = Math.sin(ang) * 0.012;
    const tally = Math.sin(ang) * 0.045;
    const nod = Math.cos(ang) * 0.035;
    a.sample('Idle', (f / merchCount) * idleDur);
    if (spine2 >= 0) turnBone(a, spine2, [0, 1, 0], [0, Math.cos(0.06), Math.sin(0.06)]);
    if (neck1 >= 0) turnBone(a, neck1, [0, 1, 0], [0.03 * Math.sin(ang), Math.cos(0.16 + nod), Math.sin(0.16 + nod)]);
    const chest = spine2 >= 0 ? Array.from(a.world[spine2].subarray(12, 15)) : [0, 1.22, 0];
    solveCrewLimb(a, ['upperarm_l', 'lowerarm_l', 'hand_l'], [chest[0] + 0.13, chest[1] - 0.05 + breathe, chest[2] + 0.25], [0.68, -0.35, -0.45]);
    solveCrewLimb(a, ['upperarm_r', 'lowerarm_r', 'hand_r'], [chest[0] - 0.12 - tally * 0.4, chest[1] - 0.01 + tally, chest[2] + 0.27], [-0.68, -0.35, -0.45]);
    a.update();
    palettes.set(a.palette, (layout[6] + f) * DECK_CREW_JOINT_FLOATS);
  }

  // Clips 4 & 5: Port (side = -1) & Starboard (side = +1) Sweep-Oar Rowing
  // Computed directly from Archetype 4's actual warped inboard oar shaft centerline & BARGE_OAR_PIVOTS
  // using the exact same R_roll(dip*side) * R_yaw(sweep*side) rotation as `animateTradeOar` in WGSL.
  const dummySeated = { position: [0, 0, 0], yaw: 0, pitch: 0, roll: 0, climbPitch: 0, scale: [1, 1, 1] };
  const bargeArch = getTradeVesselArchetype(4);
  const pivots = bargeOarPivotsForWGSL();
  const ds = bargeArch.designScale;
  const measureInboardTipDesign = (stIdx, side, px, py, pz) => {
    const bv = bargeArch.vertices;
    let bestInboardX = Infinity;
    const oarPts = [];
    for (let i = 0; i < bv.length; i += 9) {
      const m = bv[i + 6];
      if (Math.floor(m) === 16 && Math.round((m - 16) * 64) === stIdx) {
        const vx = bv[i], vy = bv[i + 1], vz = bv[i + 2];
        if ((vx - px) * side <= 0) {
          oarPts.push([vx, vy, vz]);
          if (vx * side < bestInboardX) bestInboardX = vx * side;
        }
      }
    }
    const endRing = oarPts.filter((q) => q[0] * side <= bestInboardX + 0.035);
    if (!endRing.length) return [px - side * 0.635, py + 0.068, pz + 0.755];
    let sx = 0, sy = 0, sz = 0;
    for (const q of endRing) { sx += q[0]; sy += q[1]; sz += q[2]; }
    return [sx / endRing.length, sy / endRing.length, sz / endRing.length];
  };

  for (const [clipSlot, side] of [[8, -1], [10, 1]]) {
    const sideStations = bargeArch.deckStations.filter((s) => s.role === 'oarsman' && s.oarSide === side);
    const refSt = sideStations.find((s) => (s.oarStationIdx >> 1) === 4)
      || sideStations[0]
      || bargeArch.deckStations.find((s) => s.role === 'oarsman');
    const stIdx = refSt?.oarStationIdx ?? (side < 0 ? 8 : 9);
    const px = pivots[stIdx * 4 + 0];
    const py = pivots[stIdx * 4 + 1];
    const pz = pivots[stIdx * 4 + 2];
    const tip = measureInboardTipDesign(stIdx, side, px, py, pz);
    const dxTip = tip[0] - px, dyTip = tip[1] - py, dzTip = tip[2] - pz;
    // Average pivot-from-seat vector across all 4 active thwarts on this side so every oarsman grips within <1.5 cm of his shaft
    let relPivX = side * BARGE_SEAT_INBOARD_FROM_PIVOT_M;
    let relPivY = 0.38;
    let relPivZ = 0.39;
    let seatY = Number.isFinite(refSt?.seatHeightMetres) ? refSt.seatHeightMetres : 0.238;
    if (sideStations.length > 0) {
      let sumX = 0, sumY = 0, sumZ = 0, sumSeat = 0;
      for (const s of sideStations) {
        const si = s.oarStationIdx;
        sumX += pivots[si * 4 + 0] * ds[0] - s.localMetres[0];
        sumY += pivots[si * 4 + 1] * ds[1] - s.localMetres[1];
        sumZ += pivots[si * 4 + 2] * ds[2] - s.localMetres[2];
        sumSeat += Number.isFinite(s.seatHeightMetres) ? s.seatHeightMetres : 0.238;
      }
      relPivX = sumX / sideStations.length;
      relPivY = sumY / sideStations.length;
      relPivZ = sumZ / sideStations.length;
      seatY = sumSeat / sideStations.length;
    }
    const stYaw = refSt?.yaw ?? 0;
    const cSt = Math.cos(stYaw), sSt = Math.sin(stYaw);

    const gripPointLocal = (frac, ang) => {
      const sweep = Math.sin(ang) * BARGE_ROW_SWEEP_RAD;
      const dip = -Math.cos(ang) * BARGE_ROW_DIP_RAD;
      const dx = dxTip * frac, dy = dyTip * frac, dz = dzTip * frac;
      const cy = Math.cos(sweep * side), sy = Math.sin(sweep * side);
      const dYawX = dx * cy - dz * sy;
      const dYawY = dy;
      const dYawZ = dx * sy + dz * cy;
      const cr = Math.cos(dip * side), sr = Math.sin(dip * side);
      const rx = dYawX * cr - dYawY * sr;
      const ry = dYawX * sr + dYawY * cr;
      const rz = dYawZ;
      const wx = relPivX + rx * ds[0];
      const wy = relPivY + ry * ds[1];
      const wz = relPivZ + rz * ds[2];
      return [
        wx * cSt - wz * sSt,
        wy,
        wx * sSt + wz * cSt,
      ];
    };

    for (let f = 0; f < rowCount; f++) {
      const ang = (f / rowCount) * Math.PI * 2;
      const innerGrip = gripPointLocal(0.90, ang);
      const outerGrip = gripPointLocal(0.72, ang);
      // Character faces straight aft (+Z, yaw === 0): +X is left arm (`hand_l`), -X is right arm (`hand_r`).
      // Port (`side = -1`): `innerGrip` is closer to +X (`hand_l`), `outerGrip` is closer to -X (`hand_r`).
      // Starboard (`side = +1`): `outerGrip` is closer to +X (`hand_l`), `innerGrip` is closer to -X (`hand_r`).
      const hands = side < 0 ? [innerGrip, outerGrip] : [outerGrip, innerGrip];
      const strokeFwd = -Math.sin(ang);
      const recovDip = Math.max(0, -Math.cos(ang));
      const lean = 0.11 + 0.23 * strokeFwd + 0.06 * recovDip;
      a.sample('Idle', 0);
      poseSeatedCrew(a, dummySeated, {
        seat: [0, seatY, 0.095 * strokeFwd],
        feet: [[0.13, 0.0, 0.46], [-0.13, 0.0, 0.46]],
        hands: [[0.18, 0.92, 0.18], [-0.18, 0.92, 0.18]],
        body: { lean },
      });
      const spFlex = 0.02 + 0.045 * recovDip;
      for (const spName of ['spine_01', 'spine_02', 'spine_03']) {
        const spNode = a.nodeIndex ? a.nodeIndex(spName) : -1;
        if (spNode >= 0) turnBone(a, spNode, [0, 1, 0], [0, Math.cos(spFlex), Math.sin(spFlex)]);
      }
      solveCrewLimb(a, ['upperarm_l', 'lowerarm_l', 'hand_l'], hands[0], [0.46, seatY + 0.30, -0.34]);
      solveCrewLimb(a, ['upperarm_r', 'lowerarm_r', 'hand_r'], hands[1], [-0.46, seatY + 0.30, -0.34]);
      poseCrewFingers(a, dummySeated, 0.92, 0.92);
      a.update();
      palettes.set(a.palette, (layout[clipSlot] + f) * DECK_CREW_JOINT_FLOATS);
    }
  }

  // Clip 6: Seated Paddle (for taino-canoe)
  for (let f = 0; f < paddleCount; f++) {
    const ang = (f / paddleCount) * Math.PI * 2;
    const stroke = Math.sin(ang);
    const lift = Math.cos(ang);
    const lean = 0.20 * stroke + 0.08;
    a.sample('Idle', 0);
    poseSeatedCrew(a, dummySeated, {
      seat: [0, 0.24, -0.04],
      feet: [[0.13, 0.02, 0.38], [-0.13, 0.02, 0.38]],
      hands: [
        [0.12, 1.08 - 0.06 * stroke, 0.24 + 0.12 * stroke],
        [-0.24, 0.64 + 0.07 * lift, 0.34 + 0.20 * stroke],
      ],
      body: { lean },
    });
    poseCrewFingers(a, dummySeated, 0.90, 0.90);
    a.update();
    palettes.set(a.palette, (layout[12] + f) * DECK_CREW_JOINT_FLOATS);
  }

  a.sample('Idle', 0);
  return { palettes, layout };
}

const DECK_CREW_SHARED_WGSL = /* wgsl */ `
struct DeckCrewConfig {
  ctrl: vec4u,        // activeVessels, maxStationsPerVessel, bucketSpan, samples
  splatCtrl: vec4u,   // maxSplats, lookCount, maleBraceStart, maleBraceLen
  femaleBrace: vec4u, // femaleBraceStart, femaleBraceLen, pad, pad
  thresholds: vec4f,  // hiCrossPx (10.0), splatPx (4.0), minPx (1.0, informational: continuumThin uses CONTINUUM_MIN_PIXELS), pad
};
struct DeckStationGPU {
  localPosYaw: vec4f, // x, y, z (metres), yaw
  stationMeta: vec4u, // flags(active|model<<1|merchant<<2|poseKind<<4), clipFirst|(clipLen<<16), lookIdx, phaseBits
};
struct DeckCrewBody {
  localPosYaw: vec4f,
  vesselSlot: u32,
  framesPacked: u32,  // frameA | (frameB << 16)
  blendBrace: u32,    // blend16 | (braceWeight16 << 16)
  lookFlags: u32,     // lookIdx(10) | (isMerchant<<10) | (braceFrame<<11) | (splatFade11<<21)
};
struct TownLook {
  shirt: vec4f,
  trousers: vec4f,
  skin: vec4f,
  hair: vec4f,
  face: vec4f,
};
`;

export function buildDeckCrewClearWGSL(tierCounts = [[300, 300, 300, 300], [300, 300, 300, 300]]) {
  const m0 = tierCounts[0] ?? [300, 300, 300, 300];
  const m1 = tierCounts[1] ?? m0;
  const bucketIdxCounts = [
    m0[0], m0[1], m0[2], m0[3],
    m1[0], m1[1], m1[2], m1[3],
    m0[3], m1[3],
    m0[3], m1[3],
  ].map((n) => `${Math.max(0, n | 0)}u`);
  return /* wgsl */ `
const DECK_BUCKET_INDEX_COUNTS = array<u32, ${DECK_CREW_BUCKETS}>(${bucketIdxCounts.join(', ')});
@group(0) @binding(0) var<storage, read_write> crewDraws: array<u32>;
@compute @workgroup_size(1) fn main() {
  for (var b = 0u; b < ${DECK_CREW_BUCKETS}u; b++) {
    let base = b * 5u;
    crewDraws[base] = DECK_BUCKET_INDEX_COUNTS[b];
    crewDraws[base + 1u] = 0u;
    crewDraws[base + 2u] = 0u;
    crewDraws[base + 3u] = 0u;
    crewDraws[base + 4u] = 0u;
  }
  crewDraws[60u] = 0u;
  crewDraws[61u] = 1u;
  crewDraws[62u] = 0u;
  crewDraws[63u] = 0u;
}
`;
}

export const DECK_CREW_CLEAR_WGSL = /* @__PURE__ */ buildDeckCrewClearWGSL();

export const DECK_CREW_SELECT_WGSL = CONTINUUM_CORE_WGSL + FRAME_WGSL + SHADOW_FRAME + TRADE_SHARED_TYPES_WGSL + DECK_CREW_SHARED_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> nearTerrain: TradeNearDomain;
@group(0) @binding(2) var<uniform> crewCfg: DeckCrewConfig;
@group(0) @binding(3) var<storage, read> srcInstances: array<TradeInstance>;
@group(0) @binding(4) var<storage, read> crewStations: array<DeckStationGPU>;
@group(0) @binding(5) var<storage, read> crewLooks: array<TownLook>;
@group(0) @binding(6) var<storage, read_write> crewBodies: array<DeckCrewBody>;
@group(0) @binding(7) var<storage, read_write> crewSplatList: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> crewDraws: array<atomic<u32>>;
@group(0) @binding(9) var<uniform> landSH: ShadowFrame;

fn rotateDeckShip(v: vec3f, heading: f32, pitch: f32, roll: f32) -> vec3f {
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
  let gid = id.x;
  let maxSt = max(crewCfg.ctrl.y, 1u);
  let vesselSlot = gid / maxSt;
  if (vesselSlot >= crewCfg.ctrl.x) { return; }
  let st = crewStations[gid];
  let flags = st.stationMeta.x;
  if ((flags & 1u) == 0u) { return; }

  let inst = srcInstances[vesselSlot];
  let yaw = inst.posYaw.w;
  let pitch = inst.attScaleArch.x;
  let roll = inst.attScaleArch.y;
  let scaleMul = max(inst.attScaleArch.z, 0.25);
  let shipWorld = inst.posYaw.xyz + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);

  let modelIdx = (flags >> 1u) & 1u;
  let isMerchant = (flags >> 2u) & 1u;
  let poseKind = (flags >> 4u) & 7u;
  let isSeated = poseKind >= 4u;
  let bodyHeightM = select(1.74, 1.16, isSeated);
  let halfHeightM = bodyHeightM * 0.5;
  let splatLocalOffset = select(vec3f(0.0, halfHeightM, 0.0), vec3f(0.0, halfHeightM + 0.06, 0.10), isSeated);

  let stDeck = st.localPosYaw.xyz * scaleMul;
  let worldCenter = shipWorld + rotateDeckShip(stDeck + splatLocalOffset, yaw, pitch, roll);
  let shipUpWorld = normalize(rotateDeckShip(vec3f(0.0, 1.0, 0.0), yaw, pitch, roll));

  let clipFirst = st.stationMeta.y & 0xFFFFu;
  let clipLen = max(1u, (st.stationMeta.y >> 16u) & 0xFFFFu);
  let lookIdx = min(st.stationMeta.z, max(1u, crewCfg.splatCtrl.y) - 1u);
  let phaseOff = bitcast<f32>(st.stationMeta.w);

  var cyc = fract(F.camPos.w * 0.42 + phaseOff);
  if (isSeated) {
    let oarActive = inst.animSink.y > 0.035;
    let rowRad = F.camPos.w * 2.15 + inst.animSink.x + phaseOff;
    cyc = select(
      0.5,
      fract(rowRad / 6.2831853),
      oarActive,
    );
  }
  let exactFrame = clamp(cyc * f32(clipLen), 0.0, max(0.0, f32(clipLen) - 1e-3));
  let f0 = min(u32(exactFrame), clipLen - 1u);
  let f1 = (f0 + 1u) % clipLen;
  let blend = fract(exactFrame);

  var braceWeight = 0.0;
  if (!isSeated) {
    braceWeight = select(
      clamp((abs(roll) - 0.14) * 2.2, 0.0, 0.45),
      0.0,
      poseKind == 1u,
    );
  }
  let braceStart = select(crewCfg.splatCtrl.z, crewCfg.femaleBrace.x, modelIdx == 1u);
  let braceLen = max(1u, select(crewCfg.splatCtrl.w, crewCfg.femaleBrace.y, modelIdx == 1u));
  let braceFrame = braceStart + (u32(fract(F.camPos.w * 0.38 + phaseOff) * f32(braceLen)) % braceLen);

  let framesPacked = (clipFirst + f0) | ((clipFirst + f1) << 16u);
  let blendBrace = u32(round(blend * 65535.0)) | (u32(round(braceWeight * 65535.0)) << 16u);

  // 1. Shadow caster bucket when inside land shadow frustum
  let toCamRaw = worldCenter - F.camPos.xyz;
  let rawDist = length(toCamRaw);
  if (landSH.origin.w > 0.5 && rawDist < 360.0) {
    let shP = landSH.lightView * vec4f(worldCenter - landSH.origin.xyz, 1.0);
    if (abs(shP.x) <= 1.12 && abs(shP.y) <= 1.12 && shP.z >= -0.15 && shP.z <= 1.12) {
      let shBucket = 8u + modelIdx;
      let shSlot = atomicAdd(&crewDraws[shBucket * 5u + 1u], 1u);
      if (shSlot < crewCfg.ctrl.z) {
        let shFlags = (lookIdx & 0x3FFu) | (isMerchant << 10u) | ((braceFrame & 0x3FFu) << 11u);
        crewBodies[shBucket * crewCfg.ctrl.z + shSlot] = DeckCrewBody(
          st.localPosYaw, vesselSlot, framesPacked, blendBrace, shFlags,
        );
      }
    }
  }

  // 2. Camera frustum & continuous pixel-span LOD / MSAA crossfade / 1-triangle silhouette splat
  let curved = earthCurve(toCamRaw, F.camPos.y);
  let dist = max(length(curved), 0.75);
  let clip = F.viewProj * vec4f(curved, 1.0);
  let tanX = max(length(F.camRight.xyz), 0.15);
  let tanY = max(length(F.camUp.xyz), 0.15);
  let wEff = max(clip.w, 1.0);
  if (clip.w < -1.6 || abs(clip.x) > wEff * 1.16 + 1.4 / tanX || abs(clip.y) > wEff * 1.16 + 1.4 / tanY) { return; }

  let focal = 0.5 * F.screen.y / tanY;
  let pixels = continuumPixels(bodyHeightM, focal, dist);
  let hiCrossPx = crewCfg.thresholds.x; // 10.0 px
  let splatPx = crewCfg.thresholds.y;   // 4.0 px

  if (pixels >= hiCrossPx) {
    let tier = select(select(select(3u, 2u, pixels >= 26.0), 1u, pixels >= 68.0), 0u, pixels >= 150.0);
    let bucket = modelIdx * 4u + tier;
    let slot = atomicAdd(&crewDraws[bucket * 5u + 1u], 1u);
    if (slot < crewCfg.ctrl.z) {
      let lookFlags = (lookIdx & 0x3FFu) | (isMerchant << 10u) | ((braceFrame & 0x3FFu) << 11u);
      crewBodies[bucket * crewCfg.ctrl.z + slot] = DeckCrewBody(
        st.localPosYaw, vesselSlot, framesPacked, blendBrace, lookFlags,
      );
    }
    return;
  }

  let look = crewLooks[lookIdx];
  let meanCol = look.shirt.rgb * 0.46 + look.trousers.rgb * 0.30 + look.skin.rgb * 0.14 + look.hair.rgb * 0.10;
  let baseHalfW = select(0.28, 0.33, isSeated);
  let baseHalfH = select(halfHeightM * 1.04, halfHeightM * 0.96, isSeated);
  let signedHalfW = select(baseHalfW, -baseHalfW, isSeated);

  if (pixels > splatPx) {
    // 10.0 -> 4.0 px: MSAA @builtin(sample_mask) crossfade between distant 3D mesh (buckets 10..11) and 1-triangle silhouette splat
    let rawShare = clamp(smoothstep(hiCrossPx, splatPx, pixels), 0.0, 0.999);
    let fadeBits = min(2047u, u32(round(rawShare * 2047.0)));
    let bucket = 10u + modelIdx;
    let slot = atomicAdd(&crewDraws[bucket * 5u + 1u], 1u);
    if (slot < crewCfg.ctrl.z) {
      let lookFlags = (lookIdx & 0x3FFu) | (isMerchant << 10u) | ((braceFrame & 0x3FFu) << 11u) | (fadeBits << 21u);
      crewBodies[bucket * crewCfg.ctrl.z + slot] = DeckCrewBody(
        st.localPosYaw, vesselSlot, framesPacked, blendBrace, lookFlags,
      );
    }
    let sVert = atomicAdd(&crewDraws[60u], 3u);
    let sIdx = sVert / 3u;
    if (sIdx < crewCfg.splatCtrl.x) {
      crewSplatList[sIdx * 3u] = vec4f(worldCenter, signedHalfW);
      crewSplatList[sIdx * 3u + 1u] = vec4f(meanCol, baseHalfH);
      // fadeBits + 2048 * lookIdx (the body's seed, as the mesh side reads it), exact in f32.
      crewSplatList[sIdx * 3u + 2u] = vec4f(shipUpWorld, f32(fadeBits | ((lookIdx & 0x3FFu) << 11u)));
    }
    return;
  }

  // <= 4.0 px down to < 1.0 px: 1-triangle silhouette splat, thinned below CONTINUUM_MIN_PIXELS by the core's
  // area-preserving hash and inflation.
  let inflate = continuumThin(pixels, gid);
  if (inflate <= 0.0) { return; }
  let sVert = atomicAdd(&crewDraws[60u], 3u);
  let sIdx = sVert / 3u;
  if (sIdx < crewCfg.splatCtrl.x) {
    crewSplatList[sIdx * 3u] = vec4f(worldCenter, signedHalfW * inflate);
    crewSplatList[sIdx * 3u + 1u] = vec4f(meanCol, baseHalfH * inflate);
    // 2047: the whole splat, no band.
    crewSplatList[sIdx * 3u + 2u] = vec4f(shipUpWorld, f32(2047u | ((lookIdx & 0x3FFu) << 11u)));
  }
}
`;

const DECK_CREW_SKINNING_HELPERS_WGSL = CREW_JOINT_BLEND_WGSL + /* wgsl */ `
struct DeckCrewInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) bones: vec4u,
  @location(4) weights: vec4f,
  @builtin(instance_index) instance: u32,
};
struct DeckCrewSurface { position: vec3f, normal: vec3f };

fn deckCrewRamp(lo: f32, hi: f32, x: f32) -> vec2f {
  let t = clamp((x - lo) / (hi - lo), 0.0, 1.0);
  return vec2f(t * t * (3.0 - 2.0 * t), 6.0 * t * (1.0 - t) / (hi - lo));
}
fn deckCrewDressOf(hairW: f32) -> u32 {
  return u32(fract(hairW) * ${DRESS_MASK_SCALE}.0 + 0.5);
}
fn deckCrewPieceHidden(color: vec3f, dress: u32) -> bool {
  let piece = u32(color.r * 0.5);
  return piece > 0u && ((dress >> (piece - 1u)) & 1u) == 0u;
}
fn deckCrewCompMask(faceW: f32) -> u32 {
  return select(0u, u32((-faceW) * 0.5), faceW < 0.0);
}
fn deckCrewEyeOpen(faceW: f32) -> f32 {
  if (faceW < 0.0) {
    let raw = -faceW;
    return raw - f32(u32(raw * 0.5)) * 2.0;
  }
  return select(faceW, faceW - 2.0, faceW > 1.5);
}
fn deckCrewCompHidden(color: vec3f, compMask: u32, isMerchant: bool) -> bool {
  let comp = u32(color.g * 0.5);
  if (comp == 0u) { return false; }
  if (comp == 24u) { return !isMerchant; }
  let hair = compMask & 7u;
  let hat = (compMask >> 3u) & 7u;
  let beard = (compMask >> 6u) & 3u;
  let gar = (compMask >> 8u) & 7u;
  if (comp <= 5u) {
    if (comp != hair) { return true; }
    if (hat == 3u) { return true; }
    if (hat == 1u) { return comp != 3u; }
    if (hat == 2u || hat == 4u) { return comp == 1u || comp == 5u; }
    return false;
  }
  if (comp <= 9u) { return hat == 0u || comp != 5u + hat; }
  if (comp <= 12u) { return beard == 0u || comp != 9u + beard; }
  return gar == 0u || comp != 12u + gar;
}
fn deckCrewMorph(p: vec3f, normal: vec3f, f: vec4f, sex: f32, comp: u32) -> DeckCrewSurface {
  if (comp == 24u) { return DeckCrewSurface(p, normal); }
  let headY = select(1.600, 1.550, sex > 0.5);
  let build = (deckCrewCompMask(f.w) >> 11u) & 3u;
  if (p.y <= headY + 0.015) {
    if (build == 0u || p.y <= 0.68 || p.y >= 1.40 || abs(p.x) >= 0.25) { return DeckCrewSurface(p, normal); }
    let env = deckCrewRamp(0.68, 0.86, p.y).x * (1.0 - deckCrewRamp(1.24, 1.40, p.y).x) * (1.0 - deckCrewRamp(0.20, 0.25, abs(p.x)).x);
    let sx = select(select(0.11, -0.085, build == 1u), 0.095 * deckCrewRamp(0.84, 1.18, p.y).x, build == 2u);
    let sz = select(select(0.10, -0.095, build == 1u), 0.075, build == 2u);
    let belly = select(0.0, 0.030 * smoothstep(-0.02, 0.08, p.z) * (1.0 - deckCrewRamp(1.06, 1.24, p.y).x), build == 3u);
    let qx = p.x * (1.0 + sx * env);
    let qz = -0.025 + (p.z + 0.025) * (1.0 + sz * env) + belly * env;
    let nrm = normalize(vec3f(normal.x / (1.0 + sx * env), normal.y, normal.z / (1.0 + sz * env)));
    return DeckCrewSurface(vec3f(qx, p.y, qz), nrm);
  }
  let eyeY = select(1.666, 1.612, sex > 0.5);
  let head = deckCrewRamp(headY + 0.015, headY + 0.065, p.y);
  let jaw = vec2f(1.0, 0.0) - deckCrewRamp(headY + 0.06, headY + 0.13, p.y);
  let width = 1.0 + head.x * ((f.x - 1.0) + (f.y - 1.0) * jaw.x);
  let widthY = head.y * ((f.x - 1.0) + (f.y - 1.0) * jaw.x) + head.x * (f.y - 1.0) * jaw.y;
  let nx = vec2f(1.0, 0.0) - deckCrewRamp(0.012, 0.045, abs(p.x));
  let ny0 = deckCrewRamp(eyeY - 0.065, eyeY - 0.025, p.y);
  let ny1 = vec2f(1.0, 0.0) - deckCrewRamp(eyeY + 0.005, eyeY + 0.04, p.y);
  let nz = deckCrewRamp(0.045, 0.085, p.z);
  let nose = nx.x * ny0.x * ny1.x * nz.x;
  let noseD = vec3f(
    nx.y * sign(p.x) * ny0.x * ny1.x * nz.x,
    nx.x * (ny0.y * ny1.x + ny0.x * ny1.y) * nz.x,
    nx.x * ny0.x * ny1.x * nz.y,
  );
  let noseScale = f.z * 0.35;
  let ex0 = deckCrewRamp(0.015, 0.026, abs(p.x));
  let ex1 = vec2f(1.0, 0.0) - deckCrewRamp(0.058, 0.080, abs(p.x));
  let ey = vec2f(1.0, 0.0) - deckCrewRamp(0.016, 0.040, abs(p.y - eyeY));
  let ez = deckCrewRamp(0.015, 0.055, p.z);
  let eye = ex0.x * ex1.x * ey.x * ez.x;
  let eyeD = vec3f(
    (ex0.y * ex1.x + ex0.x * ex1.y) * sign(p.x) * ey.x * ez.x,
    ex0.x * ex1.x * ey.y * sign(p.y - eyeY) * ez.x,
    ex0.x * ex1.x * ey.x * ez.y,
  );
  let eyeOpen = 1.0 + (deckCrewEyeOpen(f.w) - 1.0) * 0.35;
  let eyeShift = (p.y - eyeY) * (eyeOpen - 1.0);
  let eyeGradient = eyeShift * eyeD + vec3f(0.0, (eyeOpen - 1.0) * eye, 0.0);
  let dx = vec3f(width, eyeGradient.x, noseScale * noseD.x);
  let dy = vec3f(p.x * widthY, 1.0 + eyeGradient.y, noseScale * noseD.y);
  let dz = vec3f(0.0, eyeGradient.z, 1.0 + noseScale * noseD.z);
  let morphed = normalize(cross(dy, dz) * normal.x + cross(dz, dx) * normal.y + cross(dx, dy) * normal.z);
  return DeckCrewSurface(vec3f(p.x * width, p.y + eyeShift * eye, p.z + noseScale * nose), morphed);
}
fn deckCrewClothed(tagged: vec3f, p: vec3f, shirt: vec3f, trousers: vec3f, skin: vec3f, hair: vec3f, isIndigenous: bool, dress: u32, compMask: u32) -> vec4f {
  if (tagged.b < -1.0) {
    return vec4f(tagged, select(0.0, 1.0, tagged.b < -10.5));
  }
  let garment = u32(tagged.b * 0.5);
  if (garment > 0u) {
    let piece = u32(tagged.r * 0.5);
    let comp = u32(tagged.g * 0.5);
    let rawShade = vec3f(tagged.r - 2.0 * f32(piece), tagged.g - 2.0 * f32(comp), tagged.b - 2.0 * f32(garment));
    let shadeLuma = clamp(dot(rawShade, vec3f(0.299, 0.587, 0.114)), 0.64, 1.16);
    let compShade = mix(vec3f(shadeLuma), clamp(rawShade, vec3f(0.62), vec3f(1.18)), select(0.20, 0.45, garment == 3u));
    let shade = select(rawShade, compShade, comp > 0u);
    var worn = select(select(select(hair, skin, garment == 3u), trousers, garment == 2u), shirt, garment == 1u);
    if (garment == 5u) {
      let acc = (compMask >> 13u) & 3u;
      var pal = select(select(select(vec3f(0.24, 0.13, 0.065), vec3f(0.38, 0.065, 0.048), acc == 1u), vec3f(0.085, 0.125, 0.20), acc == 2u), vec3f(0.46, 0.35, 0.19), acc == 3u);
      if (comp == 9u) { pal = select(vec3f(0.14, 0.145, 0.155), pal * 0.65, acc == 1u || acc == 2u); }
      if (comp == 24u) { pal = select(vec3f(0.20, 0.10, 0.052), vec3f(0.58, 0.44, 0.16), tagged.r > 1.09); }
      worn = pal;
    } else if (garment == 6u) {
      let acc = (compMask >> 13u) & 3u;
      let rawLinen = select(vec3f(0.46, 0.41, 0.33), vec3f(0.72, 0.66, 0.52), comp == 24u);
      let kerchiefPal = select(select(rawLinen, vec3f(0.36, 0.085, 0.062), acc == 1u), vec3f(0.11, 0.16, 0.26), acc == 2u);
      worn = select(rawLinen, kerchiefPal, comp == 8u);
    }
    return vec4f(worn * shade, select(0.0, 1.0, garment == 3u));
  }
  let color = vec3f(tagged.r - 2.0 * f32(u32(tagged.r * 0.5)), tagged.gb);
  let isShirt = distance(color, vec3f(0.55, 0.47, 0.31)) < 0.001;
  let isLower = distance(color, vec3f(0.095, 0.12, 0.15)) < 0.001;
  let isHair = distance(color, vec3f(0.045, 0.019, 0.009)) < 0.001;
  let isArmSkin = isIndigenous && isShirt && abs(p.x) > 0.155 && p.y > 0.86 && p.y < 1.48;
  let isCalfSkin = isIndigenous && isLower && p.y > 0.21 && p.y < 0.62;
  var worn = color;
  if (isShirt) { worn = select(shirt, skin, isArmSkin); }
  if (isLower) { worn = select(trousers, skin, isCalfSkin); }
  if (distance(color, vec3f(0.36, 0.18, 0.10)) < 0.001) { worn = skin; }
  if (isHair) { worn = hair; }
  return vec4f(worn, select(0.0, 1.0, distance(color, vec3f(0.36, 0.18, 0.10)) < 0.001 || isArmSkin || isCalfSkin));
}
fn rotateVesselCrew(v: vec3f, heading: f32, pitch: f32, roll: f32) -> vec3f {
  let cr = cos(roll); let sr = sin(roll);
  let cp = cos(pitch); let sp = sin(pitch);
  let ch = cos(heading); let sh = sin(heading);
  let xx = cr * v.x - sr * v.y;
  let yy = sr * v.x + cr * v.y;
  let yp = cp * yy - sp * v.z;
  let zp = sp * yy + cp * v.z;
  return vec3f(ch * xx - sh * zp, yp, sh * xx + ch * zp);
}
`;

export function buildDeckCrewRenderWGSL(samples = 4) {
  const safeSamples = Math.max(1, Math.min(4, samples | 0));
  const sampleMaskAll = (1 << safeSamples) - 1;
  return CONTINUUM_CORE_WGSL + FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + SHADOW_FRAME + VESSEL_LIGHTING + TRADE_SHARED_TYPES_WGSL + DECK_CREW_SHARED_WGSL + DECK_CREW_SKINNING_HELPERS_WGSL + /* wgsl */ `
const TV_CREW_SAMPLES: u32 = ${safeSamples}u;
const TV_CREW_MASK_ALL: u32 = ${sampleMaskAll}u;

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(12) var<uniform> nearTerrain: TradeNearDomain;
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;

@group(1) @binding(0) var<storage, read> bodies: array<DeckCrewBody>;
@group(1) @binding(1) var<storage, read> poses: array<mat4x4f>;
@group(1) @binding(2) var<storage, read> looks: array<TownLook>;
@group(1) @binding(3) var<storage, read> srcInstances: array<TradeInstance>;

fn deckBonePose(frameA: u32, frameB: u32, blend: f32, braceFrame: u32, braceW: f32, bone: u32, isFemale: bool) -> mat4x4f {
  let b = min(bone, ${CREW_JOINT_COUNT - 1}u);
  let piv = crewRestJoint(b, isFemale);
  var m = poses[frameA * ${CREW_JOINT_COUNT}u + b];
  if (blend > 0.001 && frameA != frameB) { m = crewBlendJoint(m, poses[frameB * ${CREW_JOINT_COUNT}u + b], blend, piv); }
  if (braceW > 0.001) { m = crewBlendJoint(m, poses[braceFrame * ${CREW_JOINT_COUNT}u + b], braceW, piv); }
  return m;
}
fn deckSkinPose(frameA: u32, frameB: u32, blend: f32, braceFrame: u32, braceW: f32, bones: vec4u, weights: vec4f, isFemale: bool) -> mat4x4f {
  var skin = mat4x4f(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
  if (weights.x > 0.0) { skin += deckBonePose(frameA, frameB, blend, braceFrame, braceW, bones.x, isFemale) * weights.x; }
  if (weights.y > 0.0) { skin += deckBonePose(frameA, frameB, blend, braceFrame, braceW, bones.y, isFemale) * weights.y; }
  if (weights.z > 0.0) { skin += deckBonePose(frameA, frameB, blend, braceFrame, braceW, bones.z, isFemale) * weights.z; }
  if (weights.w > 0.0) { skin += deckBonePose(frameA, frameB, blend, braceFrame, braceW, bones.w, isFemale) * weights.w; }
  return skin;
}

fn deckCrewShadowVis(world: vec3f, normal: vec3f) -> f32 {
  if (landSH.origin.w < 0.5) { return 1.0; }
  let p = landSH.lightView * vec4f(world - landSH.origin.xyz + normal * 0.04 + landSH.sun.xyz * 0.03, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let fade = smoothstep(0.0, 0.06, edge) * step(0.0, p.z) * step(p.z, 1.0);
  if (fade <= 0.0) { return 1.0; }
  let refZ = min(p.z - 0.10 / max(landSH.sun.w, 1.0), 0.99999);
  let s = textureSampleCompareLevel(landSolidShadow, landShadowCompare, uv, refZ);
  return mix(1.0, s, fade);
}

struct DeckCrewVSOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(perspective, centroid) world: vec3f,
  @location(1) @interpolate(perspective, centroid) normal: vec3f,
  @location(2) @interpolate(perspective, centroid) color: vec3f,
  @location(3) @interpolate(perspective, centroid) skin: f32,
  // The mesh-to-splat band's share (of 2047) and the body's seed (its look index), as the splat side reads them.
  @location(4) @interpolate(flat) fade: vec2u,
  @location(5) @interpolate(perspective, centroid) bodyPos: vec3f,
};

@vertex fn tvCrewVS(v: DeckCrewInput) -> DeckCrewVSOut {
  let body = bodies[v.instance];
  let lookIdx = body.lookFlags & 0x3FFu;
  let isMerchant = ((body.lookFlags >> 10u) & 1u) != 0u;
  let braceFrame = (body.lookFlags >> 11u) & 0x3FFu;
  let fade = vec2u((body.lookFlags >> 21u) & 0x7FFu, lookIdx);
  let look = looks[lookIdx];
  let dress = deckCrewDressOf(look.hair.w);
  let compMask = deckCrewCompMask(look.face.w);

  var out: DeckCrewVSOut;
  if (deckCrewCompHidden(v.color, compMask, isMerchant) || deckCrewPieceHidden(v.color, dress)) {
    out.pos = vec4f(2.0, 2.0, 0.0, 1.0);
    out.world = vec3f(0.0);
    out.normal = vec3f(0.0, 1.0, 0.0);
    out.color = vec3f(0.0);
    out.skin = 0.0;
    out.fade = vec2u(0u);
    out.bodyPos = vec3f(0.0);
    return out;
  }

  let comp = u32(v.color.g * 0.5);
  let surface = deckCrewMorph(v.position, v.normal, look.face, look.skin.w, comp);
  let frameA = body.framesPacked & 0xFFFFu;
  let frameB = (body.framesPacked >> 16u) & 0xFFFFu;
  let blend = f32(body.blendBrace & 0xFFFFu) / 65535.0;
  let braceW = f32((body.blendBrace >> 16u) & 0xFFFFu) / 65535.0;

  let isFemale = look.skin.w > 0.5;
  let skinMat = deckSkinPose(frameA, frameB, blend, braceFrame, braceW, v.bones, v.weights, isFemale);
  let localP = (skinMat * vec4f(surface.position, 1.0)).xyz;
  let localN = (skinMat * vec4f(surface.normal, 0.0)).xyz;

  let cY = cos(body.localPosYaw.w);
  let sY = sin(body.localPosYaw.w);
  let turnedP = vec3f(localP.x * cY + localP.z * sY, localP.y, localP.z * cY - localP.x * sY);
  let turnedN = vec3f(localN.x * cY + localN.z * sY, localN.y, localN.z * cY - localN.x * sY);

  let inst = srcInstances[body.vesselSlot];
  let scaleMul = max(inst.attScaleArch.z, 0.25);
  let crewBodyScale = 1.0;
  let shipLocalP = body.localPosYaw.xyz * scaleMul + turnedP * crewBodyScale;
  let shipWorld = inst.posYaw.xyz + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  let worldP = shipWorld + rotateVesselCrew(shipLocalP, inst.posYaw.w, inst.attScaleArch.x, inst.attScaleArch.y);
  let worldN = normalize(rotateVesselCrew(turnedN, inst.posYaw.w, inst.attScaleArch.x, inst.attScaleArch.y));

  let clothed = deckCrewClothed(v.color, v.position, look.shirt.rgb, look.trousers.rgb, look.skin.rgb, look.hair.rgb, look.face.w > 1.5, dress, compMask);
  out.pos = F.viewProj * vec4f(earthCurve(worldP - F.camPos.xyz, F.camPos.y), 1.0);
  out.world = worldP;
  out.normal = worldN;
  out.color = clothed.rgb;
  out.skin = clothed.w;
  out.fade = fade;
  out.bodyPos = v.position;
  return out;
}

fn tvCrewShade(in: DeckCrewVSOut, front: bool) -> vec4f {
  let dPdx = dpdx(in.world); let dPdy = dpdy(in.world);
  let dBpdx = dpdx(in.bodyPos); let dBpdy = dpdy(in.bodyPos);
  let nGeom = normalize(in.normal) * select(-1.0, 1.0, front);
  let clothGate = 1.0 - clamp(in.skin, 0.0, 1.0);
  let bpFoot = max(length(dBpdx), length(dBpdy));
  let fineFade = (1.0 - smoothstep(0.0009, 0.0036, bpFoot)) * step(1e-6, bpFoot) * clothGate;
  let twillFade = (1.0 - smoothstep(0.0035, 0.016, bpFoot)) * step(1e-6, bpFoot) * clothGate;
  let uWeave = (in.bodyPos.x + in.bodyPos.z) * 210.0 * 6.2831853;
  let vWeave = in.bodyPos.y * 210.0 * 6.2831853;
  let tWeave = (in.bodyPos.x * 44.0 - in.bodyPos.y * 36.0 + in.bodyPos.z * 40.0) * 6.2831853;
  let gradFine = vec3f(cos(uWeave) * 210.0, cos(vWeave) * 210.0, cos(uWeave) * 210.0) * (0.00018 * fineFade);
  let gradTwill = vec3f(cos(tWeave) * 44.0, -cos(tWeave) * 36.0, cos(tWeave) * 40.0) * (0.00055 * twillFade);
  let gradBp = gradFine + gradTwill;
  let dhdx = dot(gradBp, dBpdx); let dhdy = dot(gradBp, dBpdy);
  let r1 = cross(dPdy, nGeom); let r2 = cross(nGeom, dPdx);
  let det = dot(dPdx, r1);
  let invDet = 1.0 / select(max(abs(det), 1e-8), -max(abs(det), 1e-8), det < 0.0);
  let n = normalize(nGeom - (r1 * dhdx + r2 * dhdy) * select(0.0, invDet, abs(det) > 1e-8));
  let clothCol = in.color * (1.0 + sin(uWeave) * sin(vWeave) * 0.032 * fineFade + sin(tWeave) * 0.022 * twillFade);
  let sunDir = normalize(F.sunDir.xyz);
  let viewDir = normalize(F.camPos.xyz - in.world);
  let sunVis = solarShadowVisibility(vec3f(deckCrewShadowVis(in.world, n)));
  let sunRad = sunIlluminance() * sunVis;
  let nDotL = max(dot(n, sunDir), 0.0);
  let skinWrap = select(0.0, max(0.0, dot(n, sunDir) * 0.55 + 0.45) * 0.18, in.skin > 0.5);
  let skyCol = skyAtmo(normalize(vec3f(n.x * 0.35, max(n.y, 0.14), n.z * 0.35)));
  let seaCol = skyAtmo(vec3f(0.0, 0.25, 0.0)) * 0.45 + F.waterCol.rgb * 0.65;
  let amb = vesselAmbient(n, skyCol, seaCol);

  let rough = select(0.84, 0.56, in.skin > 0.5);
  let direct = (clothCol / PI) * sunRad * (nDotL + skinWrap * vec3f(1.0, 0.48, 0.32));
  let spec = select(vec3f(0.0), vesselSpecular(n, viewDir, sunDir, rough, vec3f(0.036)) * sunRad * nDotL, nDotL > 0.0);
  let c1 = clamp(1.0 - max(dot(n, viewDir), 0.0), 0.0, 1.0);
  let c2 = c1 * c1;
  let clothSheen = select((c2 * c2) * 0.045, 0.0, in.skin > 0.5);
  let envCol = textureSampleLevel(envCube, sampC, reflect(-viewDir, n), rough * 6.5).rgb * 0.035;

  let lit = clothCol * (amb * 0.85 + clothSheen * skyCol) + direct + spec + envCol;
  return vec4f(surfaceAir(lit, in.world), 1.0);
}

struct DeckCrewFragOut {
  @location(0) color: vec4f,
  @builtin(sample_mask) mask: u32,
};

@fragment fn tvCrewSolidFS(in: DeckCrewVSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return tvCrewShade(in, front);
}

@fragment fn tvCrewFS(in: DeckCrewVSOut, @builtin(front_facing) front: bool) -> DeckCrewFragOut {
  let color = tvCrewShade(in, front);
  // The splat takes these samples (tvCrewSplatFS); the mesh keeps the rest. Share 0 drops nothing.
  let dropMask = continuumSamples(f32(in.fade.x) / 2047.0, in.pos.xy, TV_CREW_SAMPLES, in.fade.y);
  let keepMask = (~dropMask) & TV_CREW_MASK_ALL;
  return DeckCrewFragOut(color, keepMask);
}
`;
}

export const DECK_CREW_RENDER_WGSL = /* @__PURE__ */ buildDeckCrewRenderWGSL(4);

export const DECK_CREW_SHADOW_WGSL = SHADOW_FRAME + TRADE_SHARED_TYPES_WGSL + DECK_CREW_SHARED_WGSL + DECK_CREW_SKINNING_HELPERS_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F_unused: vec4f;
@group(0) @binding(12) var<uniform> nearTerrain: TradeNearDomain;
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;

@group(1) @binding(0) var<storage, read> bodies: array<DeckCrewBody>;
@group(1) @binding(1) var<storage, read> poses: array<mat4x4f>;
@group(1) @binding(2) var<storage, read> looks: array<TownLook>;
@group(1) @binding(3) var<storage, read> srcInstances: array<TradeInstance>;

fn deckBonePoseSh(frameA: u32, frameB: u32, blend: f32, braceFrame: u32, braceW: f32, bone: u32, isFemale: bool) -> mat4x4f {
  let b = min(bone, ${CREW_JOINT_COUNT - 1}u);
  let piv = crewRestJoint(b, isFemale);
  var m = poses[frameA * ${CREW_JOINT_COUNT}u + b];
  if (blend > 0.001 && frameA != frameB) { m = crewBlendJoint(m, poses[frameB * ${CREW_JOINT_COUNT}u + b], blend, piv); }
  if (braceW > 0.001) { m = crewBlendJoint(m, poses[braceFrame * ${CREW_JOINT_COUNT}u + b], braceW, piv); }
  return m;
}
fn deckSkinPoseSh(frameA: u32, frameB: u32, blend: f32, braceFrame: u32, braceW: f32, bones: vec4u, weights: vec4f, isFemale: bool) -> mat4x4f {
  var skin = mat4x4f(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
  if (weights.x > 0.0) { skin += deckBonePoseSh(frameA, frameB, blend, braceFrame, braceW, bones.x, isFemale) * weights.x; }
  if (weights.y > 0.0) { skin += deckBonePoseSh(frameA, frameB, blend, braceFrame, braceW, bones.y, isFemale) * weights.y; }
  if (weights.z > 0.0) { skin += deckBonePoseSh(frameA, frameB, blend, braceFrame, braceW, bones.z, isFemale) * weights.z; }
  if (weights.w > 0.0) { skin += deckBonePoseSh(frameA, frameB, blend, braceFrame, braceW, bones.w, isFemale) * weights.w; }
  return skin;
}

@vertex fn tvCrewShadowVS(v: DeckCrewInput) -> @builtin(position) vec4f {
  let body = bodies[v.instance];
  let lookIdx = body.lookFlags & 0x3FFu;
  let isMerchant = ((body.lookFlags >> 10u) & 1u) != 0u;
  let braceFrame = (body.lookFlags >> 11u) & 0x3FFu;
  let look = looks[lookIdx];
  let dress = deckCrewDressOf(look.hair.w);
  let compMask = deckCrewCompMask(look.face.w);
  if (deckCrewCompHidden(v.color, compMask, isMerchant) || deckCrewPieceHidden(v.color, dress)) {
    return vec4f(2.0, 2.0, 0.0, 1.0);
  }
  let frameA = body.framesPacked & 0xFFFFu;
  let frameB = (body.framesPacked >> 16u) & 0xFFFFu;
  let blend = f32(body.blendBrace & 0xFFFFu) / 65535.0;
  let braceW = f32((body.blendBrace >> 16u) & 0xFFFFu) / 65535.0;
  let isFemale = look.skin.w > 0.5;
  let skinMat = deckSkinPoseSh(frameA, frameB, blend, braceFrame, braceW, v.bones, v.weights, isFemale);
  let localP = (skinMat * vec4f(v.position, 1.0)).xyz;
  let cY = cos(body.localPosYaw.w);
  let sY = sin(body.localPosYaw.w);
  let turnedP = vec3f(localP.x * cY + localP.z * sY, localP.y, localP.z * cY - localP.x * sY);
  let inst = srcInstances[body.vesselSlot];
  let scaleMul = max(inst.attScaleArch.z, 0.25);
  let crewBodyScale = 1.0;
  let shipLocalP = body.localPosYaw.xyz * scaleMul + turnedP * crewBodyScale;
  let shipWorld = inst.posYaw.xyz + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  let worldP = shipWorld + rotateVesselCrew(shipLocalP, inst.posYaw.w, inst.attScaleArch.x, inst.attScaleArch.y);
  let _keep = F_unused.x * 0.0;
  return landSH.lightView * vec4f(worldP - landSH.origin.xyz + vec3f(_keep, 0.0, 0.0), 1.0);
}
`;

export function buildDeckCrewSplatWGSL(samples = 4) {
  const safeSamples = Math.max(1, Math.min(4, samples | 0));
  const sampleMaskAll = (1 << safeSamples) - 1;
  return CONTINUUM_CORE_WGSL + FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + VESSEL_LIGHTING + /* wgsl */ `
const TV_CREW_SPLAT_SAMPLES: u32 = ${safeSamples}u;
const TV_CREW_SPLAT_MASK_ALL: u32 = ${sampleMaskAll}u;

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(1) @binding(0) var<storage, read> crewSplatList: array<vec4f>;

struct DeckCrewSplatOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) color: vec3f,
  @location(2) uv: vec2f,
  // The band's share (of 2047; 2047 is the whole splat) and the body's seed, as tvCrewFS reads them.
  @location(3) @interpolate(flat) fade: vec2u,
  @location(4) @interpolate(flat) seatedFlag: u32,
};

fn humanSilhouetteInside(p: vec2f, isSeated: bool) -> bool {
  if (abs(p.x) > 1.0 || abs(p.y) > 1.0) { return false; }
  if (isSeated) {
    // Seated oarsman silhouette strictly above hull sole (y >= -0.84: bent knees/lap + upright torso + head crown)
    let headD = length((p - vec2f(0.0, 0.72)) * vec2f(1.85, 3.6));
    if (headD <= 1.0) { return true; }
    let torsoHalfW = mix(0.68, 0.90, smoothstep(-0.12, 0.34, p.y)) * (1.0 - 0.34 * smoothstep(0.36, 0.54, p.y));
    if (p.y >= -0.12 && p.y <= 0.54 && abs(p.x) <= torsoHalfW) { return true; }
    let lapHalfW = mix(0.52, 0.72, smoothstep(-0.84, -0.12, p.y));
    return p.y >= -0.84 && p.y <= -0.10 && abs(p.x) <= lapHalfW;
  }
  // Head & hat crown (y in [0.48, 0.96])
  let headD = length((p - vec2f(0.0, 0.72)) * vec2f(1.85, 3.8));
  if (headD <= 1.0) { return true; }
  // Shoulders & torso (y in [-0.14, 0.52])
  let torsoHalfW = mix(0.62, 0.92, smoothstep(-0.14, 0.36, p.y)) * (1.0 - 0.35 * smoothstep(0.38, 0.54, p.y));
  if (p.y >= -0.14 && p.y <= 0.52 && abs(p.x) <= torsoHalfW) { return true; }
  // Legs / coat skirt (y in [-0.98, -0.10])
  let legHalfW = mix(0.46, 0.60, smoothstep(-0.98, -0.10, p.y));
  let strideGap = p.y < -0.36 && abs(p.x) < 0.08;
  return p.y >= -0.98 && p.y <= -0.10 && abs(p.x) <= legHalfW && !strideGap;
}

@vertex fn tvCrewSplatVS(@builtin(vertex_index) vid: u32) -> DeckCrewSplatOut {
  let sIdx = vid / 3u;
  let corner = vid % 3u;
  let s0 = crewSplatList[sIdx * 3u];
  let s1 = crewSplatList[sIdx * 3u + 1u];
  let s2 = crewSplatList[sIdx * 3u + 2u];
  var uv = vec2f(0.0, 2.0);
  if (corner == 1u) { uv = vec2f(-1.7320508, -1.0); }
  else if (corner == 2u) { uv = vec2f(1.7320508, -1.0); }

  let halfW = abs(s0.w);
  let isSeated = select(0u, 1u, s0.w < 0.0);
  let toCam = normalize(F.camPos.xyz - s0.xyz);
  let refUp = normalize(s2.xyz + vec3f(0.0, 1e-4, 0.0));
  let right = normalize(cross(select(refUp, vec3f(1.0, 0.0, 0.0), abs(dot(refUp, toCam)) > 0.96), toCam));
  let up = normalize(cross(toCam, right));
  let worldP = s0.xyz + right * (uv.x * halfW) + up * (uv.y * s1.w);

  var o: DeckCrewSplatOut;
  o.pos = F.viewProj * vec4f(earthCurve(worldP - F.camPos.xyz, F.camPos.y), 1.0);
  o.world = worldP;
  o.color = s1.rgb;
  o.uv = uv;
  let fadeWord = u32(max(round(s2.w), 0.0));
  o.fade = vec2u(fadeWord & 0x7FFu, fadeWord >> 11u);
  o.seatedFlag = isSeated;
  return o;
}

struct DeckCrewSplatFragOut {
  @location(0) color: vec4f,
  @builtin(sample_mask) mask: u32,
};

@fragment fn tvCrewSplatFS(in: DeckCrewSplatOut) -> DeckCrewSplatFragOut {
  let ux = dpdx(in.uv);
  let uy = dpdy(in.uv);
  let isSeated = in.seatedFlag != 0u;
  var silMask = 0u;
  if (TV_CREW_SPLAT_SAMPLES <= 1u) {
    if (humanSilhouetteInside(in.uv, isSeated)) { silMask = 1u; }
  } else {
    let offs = array<vec2f, 4>(vec2f(-0.125, -0.375), vec2f(0.375, -0.125), vec2f(-0.375, 0.125), vec2f(0.125, 0.375));
    for (var s = 0u; s < 4u; s++) {
      let puv = in.uv + ux * offs[s].x + uy * offs[s].y;
      if (humanSilhouetteInside(puv, isSeated)) { silMask |= (1u << s); }
    }
  }
  // Exactly the samples the mesh's tvCrewFS gives up; whole past the band.
  let fadeMask = select(
    continuumSamples(f32(in.fade.x) / 2047.0, in.pos.xy, TV_CREW_SPLAT_SAMPLES, in.fade.y),
    TV_CREW_SPLAT_MASK_ALL,
    in.fade.x >= 2047u,
  );
  let mask = silMask & fadeMask;
  let viewDir = normalize(F.camPos.xyz - in.world);
  let n = normalize(vec3f(in.uv.x * 0.45, 0.35 + in.uv.y * 0.25, 0.0) + viewDir * 0.65);
  let sunDir = normalize(F.sunDir.xyz);
  let sunRad = sunIlluminance();
  let nDotL = max(dot(n, sunDir), 0.0);
  let skyCol = skyAtmo(vec3f(0.0, 0.45, 0.0));
  let seaCol = skyAtmo(vec3f(0.0, 0.22, 0.0)) * 0.45 + F.waterCol.rgb * 0.65;
  let amb = vesselAmbient(n, skyCol, seaCol);
  let envHaze = textureSampleLevel(envCube, sampC, viewDir, 6.0).rgb * 0.025;
  let lit = in.color * (amb * 0.85 + (sunRad * nDotL) / PI) + envHaze;
  return DeckCrewSplatFragOut(vec4f(surfaceAir(lit, in.world), 1.0), mask);
}
`;
}

export const DECK_CREW_SPLAT_WGSL = /* @__PURE__ */ buildDeckCrewSplatWGSL(4);

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
    const [pipe, nearSolidPipe, shadowPipe] = await Promise.all([
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
        label: 'trade vessels near solid',
        layout: 'auto',
        vertex: { module, entryPoint: 'tvVS', buffers: INTACT_VERTEX_BUFFERS },
        fragment: { module, entryPoint: 'tvSolidFS', targets: [{ format }] },
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
    return { pipe, nearSolidPipe, shadowPipe };
  });
}

function createPlaceholderOak(device) {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const wave = Math.sin(x * 0.55 + Math.sin(y * 0.18) * 2.2) * 0.5 + 0.5;
      const pore = Math.sin(y * 1.9 + x * 3.1) > 0.82 ? -14 : 0;
      const grain = (wave - 0.5) * 24 + pore;
      const off = (y * S + x) * 4;
      data[off] = Math.max(40, Math.min(220, Math.round(146 + grain)));
      data[off + 1] = Math.max(28, Math.min(180, Math.round(108 + grain * 0.78)));
      data[off + 2] = Math.max(16, Math.min(130, Math.round(70 + grain * 0.55)));
      data[off + 3] = 255;
    }
  }
  const tex = device.createTexture({
    label: 'trade vessel oak fallback',
    size: [S, S],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: S * 4 }, [S, S]);
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
  sharedCrew = null,
  waterOptics = null,
  submerged = null,
} = {}) {
  if (!device || !shader || !resources) return null;

  let destroyed = false;
  let lastContext = null;
  let contextRiverAt = null;

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
  const U_INDEX = GPUBufferUsage.INDEX ?? 16;
  const U_UNIFORM = GPUBufferUsage.UNIFORM ?? 64;
  const U_STORAGE = GPUBufferUsage.STORAGE ?? 128;
  const U_INDIRECT = GPUBufferUsage.INDIRECT ?? 256;
  const U_COPY_DST = GPUBufferUsage.COPY_DST ?? 8;
  const U_COPY_SRC = GPUBufferUsage.COPY_SRC ?? 4;

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
  // The cut follows the scene's one pixel-error scalar: rewritten with the per-frame upload (writeSelectParams).
  const writeSelectParams = () => {
    const coarsening = continuumCoarsening();
    selectParamsFloats[0] = VESSEL_ERROR_PIXELS * coarsening;
    selectParamsFloats[1] = coarsening;
  };
  writeSelectParams();

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
      contVertColsArray[cOff + 3] = c.vertSailMask ? c.vertSailMask[i] : 0.0;
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
  const nearOutBuffer = device.createBuffer({ label: 'trade vessel near out', size: 28 * NEAR_SLICE_BYTES, usage: U_STORAGE | U_VERTEX });
  const contListBuffer = device.createBuffer({ label: 'trade vessel cont list', size: 2 * TRADE_CONT_HALF_TRIS * 16, usage: U_STORAGE });
  const splatListBuffer = device.createBuffer({ label: 'trade vessel splat list', size: MAX_TRADE_VESSELS * 2 * 16, usage: U_STORAGE });
  // COPY_SRC: the continuum census reads the draws' own arguments (continuumDraws below).
  const indirectBuffer = device.createBuffer({ label: 'trade vessel indirect', size: 156 * 4, usage: U_STORAGE | U_INDIRECT | U_COPY_DST | U_COPY_SRC });

  const waveParamsBuf = new ArrayBuffer(32);
  const waveParamsU32 = new Uint32Array(waveParamsBuf, 0, 4);
  const waveParamsF32 = new Float32Array(waveParamsBuf, 16, 4);
  waveParamsU32[0] = 0;
  waveParamsU32[1] = MAX_TRADE_VESSELS;
  waveParamsU32[2] = oceanBridge?.dispView ? 1 : 0;
  waveParamsU32[3] = 0;
  const waveInputBuf = new ArrayBuffer(MAX_TRADE_VESSELS * 64);
  const waveInputF32 = new Float32Array(waveInputBuf);
  const waveInputU32 = new Uint32Array(waveInputBuf);
  const waveParamsBuffer = device.createBuffer({ label: 'trade vessel wave params', size: 32, usage: U_UNIFORM | U_COPY_DST });
  device.queue.writeBuffer(waveParamsBuffer, 0, waveParamsBuf);
  const vesselWaveInputBuffer = device.createBuffer({ label: 'trade vessel wave inputs', size: waveInputBuf.byteLength, usage: U_STORAGE | U_COPY_DST });
  const vesselHydroStateBuffer = device.createBuffer({ label: 'trade vessel hydro state', size: MAX_TRADE_VESSELS * 32, usage: U_STORAGE | U_COPY_DST });

  const T_BINDING = globalThis.GPUTextureUsage?.TEXTURE_BINDING ?? 4;
  const seaDispFallbackTex = device.createTexture({
    label: 'trade vessel sea disp fallback',
    size: [1, 1, CASCADES],
    format: 'rgba16float',
    usage: T_BINDING,
  });
  const seaDispFallbackView = seaDispFallbackTex.createView({ dimension: '2d-array' });
  const swFallbackTex = device.createTexture({
    label: 'trade vessel surface wave fallback',
    size: [1, 1, 2],
    format: 'rgba16float',
    usage: T_BINDING,
  });
  const swFallbackView = swFallbackTex.createView({ dimension: '2d-array' });
  const swUniformFallbackBuffer = device.createBuffer({ label: 'trade vessel sw uniform fallback', size: 64, usage: U_UNIFORM | U_COPY_DST });
  const waveRepeatSampler = oceanBridge?.simSampler ?? device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear' });
  const waveClampSampler = device.createSampler({ addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', magFilter: 'linear', minFilter: 'linear' });

  const oakFallback = createPlaceholderOak(device);
  let oakView = oakFallback.view;
  const oakSampler = oceanBridge?.oakSampler ?? oakFallback.sampler;

  const canCompute = typeof computePipe === 'function' || typeof device.createComputePipelineAsync === 'function';
  const makeCompute = computePipe || (canCompute
    ? (src, lbl) => device.createComputePipelineAsync({
        label: lbl,
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: src }), entryPoint: 'main' },
      })
    : null);

  const continuumPromise = canCompute
    ? getPipelineEntry(device, `continuum:${format}:${samples}:${Boolean(computePipe)}`, async () => {
        const [wavePipe, clearPipe, selectPipe, contModule, splatModule] = await Promise.all([
          makeCompute(TRADE_VESSEL_WAVE_WGSL, 'trade vessel wave hydro'),
          makeCompute(buildTradeVesselClearWGSL(), 'trade vessel clear'),
          makeCompute(TRADE_VESSEL_SELECT_WGSL, 'trade vessel select'),
          shader(buildTradeVesselContinuumWGSL(samples), 'trade vessel continuum'),
          shader(buildTradeVesselSplatWGSL(samples), 'trade vessel splat'),
        ]);
        const [continuumSolidPipe, continuumPipe, splatPipe] = await Promise.all([
          device.createRenderPipelineAsync({
            label: 'trade vessel continuum solid',
            layout: 'auto',
            vertex: { module: contModule, entryPoint: 'tvContVS' },
            fragment: { module: contModule, entryPoint: 'tvContSolidFS', targets: [{ format }] },
            primitive: { topology: 'triangle-list', cullMode: 'back' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
            multisample: { count: samples },
          }),
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
        return { wavePipe, clearPipe, selectPipe, continuumSolidPipe, continuumPipe, splatPipe };
      })
    : Promise.resolve(null);

  const surfaceWavesPromise = oceanBridge?.surfaceWaves
    ? Promise.resolve(oceanBridge.surfaceWaves).catch(() => null)
    : Promise.resolve(null);
  const waterOpticsPromise = waterOptics?.capture
    ? Promise.resolve(waterOptics)
    : submerged?.capture
      ? Promise.resolve(submerged)
      : oceanBridge?.waterOptics
        ? Promise.resolve(oceanBridge.waterOptics).catch(() => null)
        : (oceanBridge?.dispView && oceanBridge?.simSampler)
          ? surfaceWavesPromise.then((sw) => createWaterOptics({
              device,
              shader,
              seaView: oceanBridge.dispView,
              seaSampler: oceanBridge.simSampler,
              format,
              surfaceWaves: sw,
            })).catch(() => null)
          : Promise.resolve(null);

  const [{ pipe, nearSolidPipe, shadowPipe }, continuumPipes, resolvedSurfaceWaves, resolvedWaterOptics] = await Promise.all([
    requestTradeVesselsPipelines({ device, shader, format, samples, shadowFormat }),
    continuumPromise,
    surfaceWavesPromise,
    waterOpticsPromise,
  ]);
  const submergedCapture = resolvedWaterOptics?.capture
    ? await resolvedWaterOptics.capture({
        source: tradeVesselsSubmergedSource(),
        vertex: { entryPoint: 'tvVS', buffers: INTACT_VERTEX_BUFFERS },
        entry: 'tvSubmergedFS',
        world: 'in.world',
        groups: 2,
        land: false,
      }).catch((err) => {
        console.warn('[trade-vessels submerged]', err);
        return null;
      })
    : null;
  if (destroyed) {
    for (const g of archGPUs) { g.vertexBuffer.destroy(); g.indexBuffer.destroy(); }
    for (const b of instanceBuffers) b.destroy();
    for (const b of [
      selectUniformBuffer, stepMetaBuffer, contBaseIndicesBuffer, contStatesBuffer,
      contVertColsBuffer, srcInstancesBuffer, nearOutBuffer, contListBuffer, splatListBuffer, indirectBuffer,
      waveParamsBuffer, vesselWaveInputBuffer, vesselHydroStateBuffer, swUniformFallbackBuffer,
    ]) b.destroy();
    seaDispFallbackTex.destroy();
    swFallbackTex.destroy();
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

  const wavePipe = continuumPipes?.wavePipe ?? null;
  const clearPipe = continuumPipes?.clearPipe ?? null;
  const selectPipe = continuumPipes?.selectPipe ?? null;
  const continuumSolidPipe = continuumPipes?.continuumSolidPipe ?? null;
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
  let contSolidGroup0 = continuumSolidPipe ? pickEntries(continuumSolidPipe, [0, 1, 2, 3, 4, 12]) : null;
  const contSolidGroup1 = continuumSolidPipe
    ? device.createBindGroup({
        layout: continuumSolidPipe.getBindGroupLayout(1),
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
  let solidBindGroup = nearSolidPipe ? pickEntries(nearSolidPipe, [0, 1, 2, 3, 4, 12, 19, 20, 21]) : bindGroup;
  let shadowBindGroup = pickEntries(shadowPipe, [0, 12, 19]);
  const neuralPbr = sharedNeuralPbrBank(device, { autoLoad: typeof location !== 'undefined' });
  const makeGroup1 = (targetPipe, extraEntries = []) => device.createBindGroup({
    layout: targetPipe.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: oakView },
      { binding: 1, resource: oakSampler },
      ...neuralPbr.vesselBindings(3, 4),
      ...extraEntries,
    ],
  });
  let intactGroup1 = makeGroup1(pipe);
  let solidGroup1 = nearSolidPipe ? makeGroup1(nearSolidPipe) : intactGroup1;
  let submergedGroup0 = submergedCapture?.pipeline ? pickEntries(submergedCapture.pipeline, [0, 1, 2, 3, 4, 12, 19, 20, 21]) : null;
  let submergedGroup1 = submergedCapture?.pipeline ? makeGroup1(submergedCapture.pipeline) : null;

  // ==========================================================================
  // 100% GPU Rigged Deck-Crew Renderer (crew skeleton, CREW_JOINT_COUNT joints) State & Buffers
  // ==========================================================================
  const CREW_BUCKET_SPAN = Math.ceil(DECK_CREW_MAX_TOTAL / 16) * 16; // 848 * 32B = 27136B (256-byte aligned)
  const CREW_BODY_SLICE_BYTES = CREW_BUCKET_SPAN * DECK_CREW_BODY_WORDS * 4;
  const CREW_LOOK_CAP = Math.max(64, DECK_CREW_MAX_TOTAL);

  const crewConfigBuf = new ArrayBuffer(64);
  const crewConfigU32 = new Uint32Array(crewConfigBuf, 0, 12);
  const crewConfigF32 = new Float32Array(crewConfigBuf, 48, 4);
  crewConfigU32[0] = 0;
  crewConfigU32[1] = MAX_DECK_STATIONS_PER_VESSEL;
  crewConfigU32[2] = CREW_BUCKET_SPAN;
  crewConfigU32[3] = samples;
  crewConfigU32[4] = DECK_CREW_MAX_TOTAL;
  crewConfigU32[5] = 1;
  crewConfigF32[0] = DECK_CREW_CROSSFADE_HI_PX;
  crewConfigF32[1] = DECK_CREW_SPLAT_PIXELS;
  crewConfigF32[2] = DECK_CREW_MIN_PIXELS;
  crewConfigF32[3] = 0;

  const crewStationsBuf = new ArrayBuffer(DECK_CREW_MAX_TOTAL * DECK_CREW_STATION_WORDS * 4);
  const crewStationsF32 = new Float32Array(crewStationsBuf);
  const crewStationsU32 = new Uint32Array(crewStationsBuf);
  const crewLooksF32 = new Float32Array(CREW_LOOK_CAP * DECK_CREW_LOOK_WORDS);
  const crewSrcInstancesScratch = new Float32Array(MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS);

  const crewConfigBuffer = device.createBuffer({ label: 'trade deck crew cfg', size: 64, usage: U_UNIFORM | U_COPY_DST });
  device.queue.writeBuffer(crewConfigBuffer, 0, crewConfigBuf);
  const crewSrcInstancesBuffer = device.createBuffer({ label: 'trade deck crew src instances', size: NEAR_SLICE_BYTES, usage: U_STORAGE | U_COPY_DST });
  const crewStationsBuffer = device.createBuffer({ label: 'trade deck crew stations', size: crewStationsBuf.byteLength, usage: U_STORAGE | U_COPY_DST });
  const crewLooksBuffer = device.createBuffer({ label: 'trade deck crew looks', size: crewLooksF32.byteLength, usage: U_STORAGE | U_COPY_DST });
  const crewBodiesBuffer = device.createBuffer({ label: 'trade deck crew bodies', size: DECK_CREW_BUCKETS * CREW_BODY_SLICE_BYTES, usage: U_STORAGE });
  const crewSplatListBuffer = device.createBuffer({ label: 'trade deck crew splats', size: DECK_CREW_MAX_TOTAL * 3 * 16, usage: U_STORAGE });
  const crewIndirectBuffer = device.createBuffer({ label: 'trade deck crew indirect', size: DECK_CREW_DRAW_WORDS * 4, usage: U_STORAGE | U_INDIRECT | U_COPY_DST | U_COPY_SRC });

  const makeWaveBindGroups = (curResources = resources) => {
    if (!wavePipe) return null;
    const byBinding = new Map(curResources.map(([b, r]) => [b, r]));
    const frameRes = byBinding.get(0);
    const nearRes = byBinding.get(12);
    if (!frameRes || !nearRes) return null;
    const swUniformRes = resolvedSurfaceWaves?.uniform
      ? { buffer: resolvedSurfaceWaves.uniform }
      : { buffer: swUniformFallbackBuffer };
    const mk = (swView) => device.createBindGroup({
      layout: wavePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: waveParamsBuffer } },
        { binding: 1, resource: frameRes },
        { binding: 2, resource: nearRes },
        { binding: 3, resource: { buffer: vesselWaveInputBuffer } },
        { binding: 4, resource: { buffer: vesselHydroStateBuffer } },
        { binding: 5, resource: { buffer: srcInstancesBuffer } },
        { binding: 6, resource: { buffer: crewSrcInstancesBuffer } },
        { binding: 7, resource: oceanBridge?.dispView ?? seaDispFallbackView },
        { binding: 8, resource: waveRepeatSampler },
        { binding: 9, resource: waveClampSampler },
        { binding: 10, resource: swUniformRes },
        { binding: 11, resource: swView },
      ],
    });
    if (resolvedSurfaceWaves?.views?.length >= 2) {
      return [mk(resolvedSurfaceWaves.views[0]), mk(resolvedSurfaceWaves.views[1])];
    }
    return [mk(swFallbackView)];
  };
  let waveBindGroups = makeWaveBindGroups(resources);
  let activeWaveVesselCount = 0;

  let deckCrewGPU = null;
  let activeCrewVessels = 0;
  let activeDeckSoulCount = 0;
  let crewStationsDirty = true;
  let crewEncoded = false;
  let lastSharedCrewToken = 0;

  function releaseDeckCrewGPU(state) {
    if (!state) return;
    for (const b of state.ownedBuffers ?? []) b?.destroy?.();
  }

  function writeDeckCrewLook(lookIdx, soul, role, stationSeed, modelIdx) {
    const female = modelIdx === 1;
    const h0 = deckCrewHash(stationSeed, 11);
    const h1 = deckCrewHash(stationSeed, 23);
    const h2 = deckCrewHash(stationSeed, 37);
    const h3 = deckCrewHash(stationSeed, 53);
    const h4 = deckCrewHash(stationSeed, 71);
    const h5 = deckCrewHash(stationSeed, 89);

    const person = DECK_CREW_PEOPLE[Math.floor(h0 * DECK_CREW_PEOPLE.length) % DECK_CREW_PEOPLE.length];
    const isElite = role === 'captain' || role === 'merchant';
    const shirt = isElite
      ? DECK_CREW_COATS_ELITE[Math.floor(h1 * DECK_CREW_COATS_ELITE.length) % DECK_CREW_COATS_ELITE.length]
      : DECK_CREW_SHIRTS[Math.floor(h1 * DECK_CREW_SHIRTS.length) % DECK_CREW_SHIRTS.length];
    const trousers = DECK_CREW_TROUSERS[Math.floor(h2 * DECK_CREW_TROUSERS.length) % DECK_CREW_TROUSERS.length];

    const hairPool = female ? [2, 3, 4, 5] : [0, 1, 2, 3];
    const hair = hairPool[Math.floor(h3 * hairPool.length) % hairPool.length];

    let hat = 0;
    if (role === 'captain') {
      hat = female ? 2 : (h4 < 0.62 ? 4 : 2);
    } else if (role === 'merchant') {
      hat = female ? (h4 < 0.55 ? 3 : 2) : (h4 < 0.52 ? 2 : (h4 < 0.82 ? 1 : 4));
    } else if (role === 'pilot') {
      hat = female ? 2 : (h4 < 0.58 ? 2 : 1);
    } else if (role === 'paddler') {
      hat = 0;
    } else {
      hat = female
        ? [0, 1, 2, 3][Math.floor(h4 * 4) % 4]
        : [0, 1, 2, 0][Math.floor(h4 * 4) % 4];
    }

    const beard = (female || role === 'paddler')
      ? 0
      : (isElite
          ? [1, 2, 2, 3][Math.floor(h5 * 4) % 4]
          : [0, 1, 2, 3][Math.floor(h5 * 4) % 4]);

    let garment = 0;
    if (female) {
      garment = isElite ? 3 : [1, 3, 4, 2][Math.floor(h2 * 4) % 4];
    } else if (role === 'captain' || role === 'merchant') {
      garment = h3 < 0.78 ? 1 : 4;
    } else if (role === 'pilot') {
      garment = h3 < 0.65 ? 1 : 4;
    } else if (role === 'paddler') {
      garment = 0;
    } else {
      garment = [0, 1, 4, 2][Math.floor((h2 + h3) * 2) % 4];
    }

    const build = role === 'merchant'
      ? (h5 < 0.45 ? 3 : 0)
      : (role === 'oarsman' ? (h5 < 0.60 ? 2 : 0) : (Math.floor(h5 * 4) & 3));
    const accent = isElite ? (h1 < 0.55 ? 1 : 2) : (Math.floor(h4 * 4) & 3);
    const rawCompMask = packCrewCompMask({ hair, hat, beard, garment, build, accent });
    const isIndig = role === 'paddler';
    const sex = female ? 'female' : 'male';
    const reconciled = isIndig
      ? { dress: 0, compMask: 0 }
      : reconcileColonialGroomAndComp(
          colonialGroomMask(sex, lookIdx, { isCaptain: role === 'captain' && hat === 0 }),
          rawCompMask,
          sex,
          { seed: lookIdx },
        );

    const at = lookIdx * DECK_CREW_LOOK_WORDS;
    crewLooksF32[at + 0] = shirt[0];
    crewLooksF32[at + 1] = shirt[1];
    crewLooksF32[at + 2] = shirt[2];
    crewLooksF32[at + 3] = 0;
    crewLooksF32[at + 4] = trousers[0];
    crewLooksF32[at + 5] = trousers[1];
    crewLooksF32[at + 6] = trousers[2];
    crewLooksF32[at + 7] = 0;
    crewLooksF32[at + 8] = person.skin[0];
    crewLooksF32[at + 9] = person.skin[1];
    crewLooksF32[at + 10] = person.skin[2];
    crewLooksF32[at + 11] = modelIdx;
    crewLooksF32[at + 12] = person.hair[0];
    crewLooksF32[at + 13] = person.hair[1];
    crewLooksF32[at + 14] = person.hair[2];
    crewLooksF32[at + 15] = reconciled.dress / DRESS_MASK_SCALE;
    crewLooksF32[at + 16] = person.face[0];
    crewLooksF32[at + 17] = person.face[1];
    crewLooksF32[at + 18] = person.face[2];
    crewLooksF32[at + 19] = packCrewFaceW(person.face[3], reconciled.compMask, isIndig);
  }

  function resolveStationSoul(route, st, stationIndex) {
    const crewList = Array.isArray(route.crew) && route.crew.length
      ? route.crew
      : (Array.isArray(route.oarsmen) ? route.oarsmen : []);
    if (st.station === 'captain') {
      return route.captain ?? route.pilot ?? null;
    }
    if (st.station === 'pilot') {
      return route.pilot ?? route.captain ?? null;
    }
    if (st.station === 'merchant') {
      return route.merchant ?? null;
    }
    if (st.station.startsWith('crew:')) {
      const ci = Number(st.station.slice(5)) | 0;
      if (crewList[ci]) return crewList[ci];
      // Ensure every active river-barge oar (`mode === 'river'` / `archetype === 4`) has a seated oarsman at the handle.
      if (route.mode === 'river' || route.archetype === 4 || String(route.id || '').startsWith('reach:')) {
        return { id: null, syntheticSeed: deckCrewStringHash(`${route.id}:oar:${ci}`), sex: 'm', role: st.role };
      }
    } else if (st.station === 'pilot' && (route.mode === 'river' || String(route.id || '').startsWith('reach:'))) {
      return { id: null, syntheticSeed: deckCrewStringHash(`${route.id}:pilot:${stationIndex}`), sex: 'm', role: 'pilot' };
    }
    return null;
  }

  function syncDeckCrewStationTables() {
    crewStationsU32.fill(0);
    let slot = 0;
    let lookCount = 0;
    let soulTotal = 0;

    const clipIndexForStation = (st) => {
      const poseKind = st.poseKind;
      if (poseKind === 'brace') return 1;
      if (poseKind === 'helm') return 2;
      if (poseKind === 'merchant') return 3;
      if (poseKind === 'row') return (st.oarSide ?? -1) > 0 ? 5 : 4;
      if (poseKind === 'paddle') return 6;
      return 0;
    };

    for (let vi = 0; vi < vessels.length && slot < MAX_TRADE_VESSELS; vi++) {
      const v = vessels[vi];
      if (v.boat?.damage?.sunk) continue;
      v.crewSlot = slot;
      const stations = Array.isArray(v.arch?.deckStations) ? v.arch.deckStations : [];
      const r = v.route;
      const isReachShuttle = String(r.id || '').startsWith('reach:');
      for (let si = 0; si < stations.length && si < MAX_DECK_STATIONS_PER_VESSEL; si++) {
        const st = stations[si];
        let soul = resolveStationSoul(r, st, si);
        if (!soul && isReachShuttle && st.station === 'pilot') {
          soul = { id: null, syntheticSeed: deckCrewStringHash(`${r.id}:pilot`), sex: 'm', role: 'pilot' };
        }
        if (!soul) continue;

        const seedBase = soul.id != null
          ? (Number(soul.id) || deckCrewStringHash(String(soul.id)))
          : (soul.syntheticSeed ?? deckCrewStringHash(`${r.id}:${st.station}`));
        const sexStr = String(soul.sex || '').toLowerCase();
        const modelIdx = (sexStr === 'f' || sexStr === 'female') && deckCrewGPU?.hasDistinctFemale ? 1 : 0;
        const clipIdx = clipIndexForStation(st);
        const clipLayout = deckCrewGPU
          ? (modelIdx === 1 ? deckCrewGPU.femaleLayout : deckCrewGPU.maleLayout)
          : null;
        const clipFirst = clipLayout ? clipLayout[clipIdx * 2] : 0;
        const clipLen = clipLayout ? Math.max(1, clipLayout[clipIdx * 2 + 1]) : 1;

        const lookIdx = Math.min(CREW_LOOK_CAP - 1, lookCount++);
        writeDeckCrewLook(lookIdx, soul, st.role, seedBase ^ (si * 7919), modelIdx);

        const isMerchant = st.role === 'merchant' ? 1 : 0;
        const flags = 1 | (modelIdx << 1) | (isMerchant << 2) | ((clipIdx & 7) << 4);
        const phaseVal = st.poseKind === 'row' || st.poseKind === 'paddle'
          ? (st.oarPhaseOffset || 0)
          : deckCrewHash(seedBase, 97);

        const gid = slot * MAX_DECK_STATIONS_PER_VESSEL + si;
        const wOff = gid * DECK_CREW_STATION_WORDS;
        const invScale = 1 / Math.max(0.25, v.scaleMul || 1);
        const stLocalY = (st.poseKind === 'row' && Number.isFinite(st.seatHeightMetres))
          ? (st.localMetres[1] + st.seatHeightMetres * (1 - invScale))
          : st.localMetres[1];
        crewStationsF32[wOff + 0] = st.localMetres[0];
        crewStationsF32[wOff + 1] = stLocalY;
        crewStationsF32[wOff + 2] = st.localMetres[2];
        crewStationsF32[wOff + 3] = st.yaw || 0;
        crewStationsU32[wOff + 4] = flags >>> 0;
        crewStationsU32[wOff + 5] = ((clipFirst & 0xFFFF) | ((clipLen & 0xFFFF) << 16)) >>> 0;
        crewStationsU32[wOff + 6] = lookIdx >>> 0;
        crewStationsF32[wOff + 7] = phaseVal;
        soulTotal++;
      }
      slot++;
    }

    activeCrewVessels = slot;
    activeDeckSoulCount = soulTotal;
    const uploadLooks = Math.max(1, lookCount);
    if (lookCount === 0) {
      writeDeckCrewLook(0, null, 'crew', 1, 0);
    }
    crewConfigU32[0] = activeCrewVessels;
    crewConfigU32[5] = uploadLooks;
    if (deckCrewGPU) {
      crewConfigU32[6] = deckCrewGPU.maleLayout[2];
      crewConfigU32[7] = deckCrewGPU.maleLayout[3];
      crewConfigU32[8] = deckCrewGPU.femaleLayout[2];
      crewConfigU32[9] = deckCrewGPU.femaleLayout[3];
    }
    device.queue.writeBuffer(crewConfigBuffer, 0, crewConfigBuf);
    if (activeCrewVessels > 0) {
      device.queue.writeBuffer(
        crewStationsBuffer,
        0,
        crewStationsBuf,
        0,
        activeCrewVessels * MAX_DECK_STATIONS_PER_VESSEL * DECK_CREW_STATION_WORDS * 4,
      );
    }
    device.queue.writeBuffer(crewLooksBuffer, 0, crewLooksF32, 0, uploadLooks * DECK_CREW_LOOK_WORDS);
    crewStationsDirty = false;
  }

  function rebuildDeckCrewBindGroups(state, curResources = resources) {
    if (!state) return;
    const byBinding = new Map(curResources.map(([b, r]) => [b, r]));
    state.clearBindGroup = device.createBindGroup({
      layout: state.clearPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: crewIndirectBuffer } }],
    });
    state.selectBindGroup = device.createBindGroup({
      layout: state.selectPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: byBinding.get(0) },
        { binding: 1, resource: byBinding.get(12) },
        { binding: 2, resource: { buffer: crewConfigBuffer } },
        { binding: 3, resource: { buffer: crewSrcInstancesBuffer } },
        { binding: 4, resource: { buffer: crewStationsBuffer } },
        { binding: 5, resource: { buffer: crewLooksBuffer } },
        { binding: 6, resource: { buffer: crewBodiesBuffer } },
        { binding: 7, resource: { buffer: crewSplatListBuffer } },
        { binding: 8, resource: { buffer: crewIndirectBuffer } },
        { binding: 9, resource: byBinding.get(19) },
      ],
    });
    state.solidGroup0 = state.solidPipe
      ? pickEntries(state.solidPipe, [0, 1, 2, 3, 4, 12, 19, 20, 21], curResources)
      : null;
    state.renderGroup0 = pickEntries(state.renderPipe, [0, 1, 2, 3, 4, 12, 19, 20, 21], curResources);
    state.shadowGroup0 = pickEntries(state.shadowPipe, [0, 12, 19], curResources);
    state.splatGroup0 = pickEntries(state.splatPipe, [0, 1, 2, 3, 4], curResources);
    state.splatGroup1 = device.createBindGroup({
      layout: state.splatPipe.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: crewSplatListBuffer } }],
    });

    const bodySlice = (bucket) => ({
      buffer: crewBodiesBuffer,
      offset: bucket * CREW_BODY_SLICE_BYTES,
      size: CREW_BODY_SLICE_BYTES,
    });
    state.solidGroup1 = [];
    state.fadeGroup1 = [];
    state.renderGroup1 = [];
    state.shadowGroup1 = [];
    const solidPipeLayout1 = (state.solidPipe ?? state.renderPipe).getBindGroupLayout(1);
    const fadePipeLayout1 = state.renderPipe.getBindGroupLayout(1);
    for (let m = 0; m < DECK_CREW_MODELS; m++) {
      const mGeo = state.models[m];
      for (let t = 0; t < DECK_CREW_TIERS; t++) {
        const bucket = m * DECK_CREW_TIERS + t;
        const g1 = device.createBindGroup({
          layout: solidPipeLayout1,
          entries: [
            { binding: 0, resource: bodySlice(bucket) },
            { binding: 1, resource: { buffer: mGeo.palette } },
            { binding: 2, resource: { buffer: crewLooksBuffer } },
            { binding: 3, resource: { buffer: crewSrcInstancesBuffer } },
          ],
        });
        state.solidGroup1.push(g1);
        state.renderGroup1.push(g1);
      }
      state.fadeGroup1.push(device.createBindGroup({
        layout: fadePipeLayout1,
        entries: [
          { binding: 0, resource: bodySlice(10 + m) },
          { binding: 1, resource: { buffer: mGeo.palette } },
          { binding: 2, resource: { buffer: crewLooksBuffer } },
          { binding: 3, resource: { buffer: crewSrcInstancesBuffer } },
        ],
      }));
      state.shadowGroup1.push(device.createBindGroup({
        layout: state.shadowPipe.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: bodySlice(8 + m) },
          { binding: 1, resource: { buffer: mGeo.palette } },
          { binding: 2, resource: { buffer: crewLooksBuffer } },
          { binding: 3, resource: { buffer: crewSrcInstancesBuffer } },
        ],
      }));
    }
  }

  async function installSharedCrew(nextShared) {
    if (!nextShared || !canCompute || !makeCompute || destroyed) return null;
    const token = ++lastSharedCrewToken;
    try {
      const [resolved] = await Promise.all([
        Promise.resolve(nextShared),
        ensureCrewComponentPacks().catch(() => null),
      ]);
      if (destroyed || token !== lastSharedCrewToken || !resolved) return null;
      const maleSrc = resolved?.sailor ?? resolved?.models?.[0] ?? null;
      const femaleSrc = resolved?.female ?? resolved?.models?.[1] ?? maleSrc;
      if (!maleSrc?.vertices || !maleSrc?.animator) return null;

      const maleBuilt = appendMerchantCodexToModel(maleSrc, 'male');
      const hasDistinctFemale = Boolean(femaleSrc && femaleSrc !== maleSrc && femaleSrc.vertices && femaleSrc.animator);
      const femaleBuilt = hasDistinctFemale ? appendMerchantCodexToModel(femaleSrc, 'female') : maleBuilt;
      if (!maleBuilt) return null;

      const maleClips = bakeDeckCrewClips(maleBuilt.model.animator);
      const femaleClips = hasDistinctFemale && femaleBuilt ? bakeDeckCrewClips(femaleBuilt.model.animator) : maleClips;

      const tierCounts = [
        maleBuilt.tiers.map((t) => t.indexCount),
        femaleBuilt.tiers.map((t) => t.indexCount),
      ];
      const pipeKey = `deckCrew:${format}:${samples}:${shadowFormat}:${Boolean(computePipe)}:${tierCounts[0].join(',')}:${tierCounts[1].join(',')}`;
      const pipes = await getPipelineEntry(device, pipeKey, async () => {
        const [cClearPipe, cSelectPipe, renderMod, shadowMod, splatMod] = await Promise.all([
          makeCompute(buildDeckCrewClearWGSL(tierCounts), 'trade deck crew clear'),
          makeCompute(DECK_CREW_SELECT_WGSL, 'tradeCrewSelect'),
          shader(buildDeckCrewRenderWGSL(samples), 'trade deck crew render'),
          shader(DECK_CREW_SHADOW_WGSL, 'trade deck crew shadow'),
          shader(buildDeckCrewSplatWGSL(samples), 'trade deck crew splat'),
        ]);
        const [cSolidPipe, cRenderPipe, cShadowPipe, cSplatPipe] = await Promise.all([
          device.createRenderPipelineAsync({
            label: 'trade deck crew solid',
            layout: 'auto',
            vertex: { module: renderMod, entryPoint: 'tvCrewVS', buffers: DECK_CREW_VERTEX_BUFFERS },
            fragment: { module: renderMod, entryPoint: 'tvCrewSolidFS', targets: [{ format }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
            multisample: { count: samples },
          }),
          device.createRenderPipelineAsync({
            label: 'trade deck crew render',
            layout: 'auto',
            vertex: { module: renderMod, entryPoint: 'tvCrewVS', buffers: DECK_CREW_VERTEX_BUFFERS },
            fragment: { module: renderMod, entryPoint: 'tvCrewFS', targets: [{ format }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
            multisample: { count: samples },
          }),
          device.createRenderPipelineAsync({
            label: 'trade deck crew shadow',
            layout: 'auto',
            vertex: { module: shadowMod, entryPoint: 'tvCrewShadowVS', buffers: DECK_CREW_VERTEX_BUFFERS },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
          }),
          device.createRenderPipelineAsync({
            label: 'trade deck crew splat',
            layout: 'auto',
            vertex: { module: splatMod, entryPoint: 'tvCrewSplatVS' },
            fragment: { module: splatMod, entryPoint: 'tvCrewSplatFS', targets: [{ format }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
            multisample: { count: samples },
          }),
        ]);
        return { cClearPipe, cSelectPipe, cSolidPipe, cRenderPipe, cShadowPipe, cSplatPipe };
      });
      if (destroyed || token !== lastSharedCrewToken) return null;

      const ownedBuffers = [];
      const mkOwned = (lbl, typed, usage) => {
        const buf = device.createBuffer({ label: lbl, size: Math.max(16, typed.byteLength), usage: usage | U_COPY_DST });
        if (typed.byteLength) device.queue.writeBuffer(buf, 0, typed);
        ownedBuffers.push(buf);
        return buf;
      };
      const buildModelGPU = (built, clips, tag) => ({
        vertex: mkOwned(`trade deck crew ${tag} verts`, built.model.vertices, U_VERTEX),
        tiers: built.tiers.map((t, ti) => ({
          indexCount: t.indexCount,
          buffer: mkOwned(`trade deck crew ${tag} idx t${ti}`, t.indices, U_INDEX),
        })),
        palette: mkOwned(`trade deck crew ${tag} clips`, clips.palettes, U_STORAGE),
      });
      const m0GPU = buildModelGPU(maleBuilt, maleClips, 'male');
      const m1GPU = hasDistinctFemale ? buildModelGPU(femaleBuilt, femaleClips, 'female') : m0GPU;

      const nextState = {
        clearPipe: pipes.cClearPipe,
        selectPipe: pipes.cSelectPipe,
        solidPipe: pipes.cSolidPipe,
        renderPipe: pipes.cRenderPipe,
        shadowPipe: pipes.cShadowPipe,
        splatPipe: pipes.cSplatPipe,
        models: [m0GPU, m1GPU],
        hasDistinctFemale,
        maleLayout: maleClips.layout,
        femaleLayout: femaleClips.layout,
        ownedBuffers,
        clearBindGroup: null,
        selectBindGroup: null,
        solidGroup0: null,
        renderGroup0: null,
        shadowGroup0: null,
        splatGroup0: null,
        splatGroup1: null,
        solidGroup1: [],
        fadeGroup1: [],
        renderGroup1: [],
        shadowGroup1: [],
      };
      rebuildDeckCrewBindGroups(nextState, resources);
      const prev = deckCrewGPU;
      deckCrewGPU = nextState;
      releaseDeckCrewGPU(prev);
      crewStationsDirty = true;
      if (vessels.length) syncDeckCrewStationTables();
      return nextState;
    } catch (err) {
      console.error('[trade-vessels sharedCrew]', err);
      return null;
    }
  }

  // Lazy compilation for damaged-boat pipelines (render, depth prepass, shadow, compute restToPosed) triggered on first cannon hit / grounding breach.
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
      dmgState.gpuCompiled = true;
    }).catch((err) => {
      console.error('[trade-vessels promote]', err);
    });
  }
  const ensureDamagedSlot = promoteDamagedBoat;

  if (oceanBridge?.oakTex) {
    Promise.resolve(oceanBridge.oakTex).then((tex) => {
      if (!tex || destroyed) return;
      oakView = tex.createView();
      intactGroup1 = makeGroup1(pipe);
      solidGroup1 = nearSolidPipe ? makeGroup1(nearSolidPipe) : intactGroup1;
      if (submergedCapture?.pipeline) submergedGroup1 = makeGroup1(submergedCapture.pipeline);
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
  let hasEncodedGpuOnce = false;
  let dirtySyncFlag = false;
  let lastEnv = { windVec: [8, 0], storm: false, avoidVessels: null };
  const counts = new Uint32Array(TRADE_VESSEL_ARCHETYPES);
  const scratch = Array.from({ length: TRADE_VESSEL_ARCHETYPES }, () => new Float32Array(MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS));
  const allIntactScratch = new Float32Array(MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS);
  const wakeCandPool = Array.from({ length: MAX_TRADE_VESSELS }, () => ({
    dSq: 0,
    desc: { x: 0, z: 0, vx: 0, vz: 0, length: 0, beam: 0, draft: 0, displacement: 0, isRiver: false },
  }));
  const wakeCandActive = [];
  const wakeOutScratch = [];

  if (sharedCrew) {
    await installSharedCrew(sharedCrew);
  }

  const compatibleArch = (a, b) => a === b || (a <= 1 && b <= 1) || ((a === 2 || a === 3) && (b === 2 || b === 3));

  const freeHydroSlots = Array.from({ length: MAX_TRADE_VESSELS }, (_, i) => MAX_TRADE_VESSELS - 1 - i);
  const allocHydroSlot = () => (freeHydroSlots.length > 0 ? freeHydroSlots.pop() : 0);
  const freeHydroSlot = (slot) => {
    if (Number.isInteger(slot) && slot >= 0 && slot < MAX_TRADE_VESSELS && !freeHydroSlots.includes(slot)) {
      freeHydroSlots.push(slot);
    }
  };

  function sumCargoUnits(bag) {
    if (!bag || typeof bag !== 'object') return 0;
    let s = 0;
    for (const val of Object.values(bag)) {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) s += n;
    }
    return s;
  }

  function computeVesselHydrostatics(arch, scaleMul, route) {
    const cargoUnits = sumCargoUnits(route?.cargo) + sumCargoUnits(route?.load) + (Number(route?.qty) > 0 ? Number(route.qty) : 0);
    const capUnits = Math.max(8, Number(route?.tonnage) > 0 ? Number(route.tonnage) * 0.75 : (arch.unmasted ? 10 : 36));
    const phaseDefaultFill = route?.phase === 'dock' ? 0.52 : (route?.phase === 'in' ? 0.82 : 0.68);
    const fill = cargoUnits > 0 ? Math.max(0.22, Math.min(1.0, cargoUnits / capUnits)) : phaseDefaultFill;

    let refL = arch.length;
    let refB = arch.beam;
    let provDays = 16;
    let cargoTonnes = 12;
    if (arch.index === 0 || arch.index === 1) {
      provDays = 18 + 14 * fill;
      cargoTonnes = 14 + 20 * fill;
    } else if (arch.index === 2 || arch.index === 3) {
      provDays = 22 + 16 * fill;
      cargoTonnes = 40 + 34 * fill;
    } else if (arch.index === 4) {
      provDays = 2 + 2 * fill;
      cargoTonnes = 0.35 + 0.55 * fill;
    } else if (arch.index === 5) {
      provDays = 12 + 12 * fill;
      cargoTonnes = 5 + 15 * fill;
    } else {
      refL = 16.2;
      refB = 4.9;
      provDays = 10 + 10 * fill;
      cargoTonnes = 5 + 12 * fill;
    }

    const baseH = boatHydrodynamics(refL, refB, provDays, cargoTonnes, arch.modelId);
    const refToArch = arch.length / Math.max(1, refL);
    const yRatio = arch.designScale[1] / Math.max(0.1, arch.model?.designFrame?.verticalScale || 1);
    const effScale = refToArch * scaleMul;
    const lightDraft = arch.draft * scaleMul;
    let hydroSinkage = Math.max(0, (baseH.sinkage || 0) * yRatio * effScale);
      if (arch.index === 4) {
      // Loaded river barges sit 0.24-0.34 m deep in the river while keeping sole-boards dry
      hydroSinkage = Math.max(0.024 * scaleMul, Math.min(0.042 * scaleMul, hydroSinkage));
      hydroSinkage = Math.min(hydroSinkage, Math.max(0.018, 0.340 - lightDraft));
      hydroSinkage = Math.max(hydroSinkage, Math.max(0.018, 0.245 - lightDraft));
    } else {
      // Loaded ocean ships & harbor barques immerse 0.14-0.46 m deeper at their true waterline
      hydroSinkage = Math.max(0.14, Math.min(0.46, hydroSinkage));
    }
    const loadedDraft = lightDraft + hydroSinkage;
    const loadedFreeboard = Math.max(0.05, arch.freeboard * scaleMul - hydroSinkage);
    const volScale3 = Math.pow(effScale, 3);
    const massKg = Math.max(650, (baseH.mass || 8000) * volScale3);
    const wpArea = Math.max(2.5, (baseH.waterplaneArea || refL * refB * 0.72) * effScale * effScale);
    return {
      fill,
      lightDraft,
      hydroSinkage,
      draft: loadedDraft,
      freeboard: loadedFreeboard,
      massKg,
      hydrodynamics: {
        mass: massKg,
        addedMass: Math.max(80, (baseH.addedMass || massKg * 0.12) * volScale3),
        centreOfGravity: (baseH.centreOfGravity ?? -lightDraft * 0.4) * effScale,
        sinkage: hydroSinkage,
        pitchInertia: Math.max(400, (baseH.pitchInertia || massKg * (refL * refL) / 14) * Math.pow(effScale, 5)),
        rollInertia: Math.max(150, (baseH.rollInertia || massKg * (refB * refB) / 10) * Math.pow(effScale, 5)),
        draft: loadedDraft,
        freeboard: loadedFreeboard,
        waterplaneArea: wpArea,
      },
    };
  }

  function scaledColliderFor(arch, scaleMul) {
    if (Math.abs(scaleMul - 1) < 1e-5) return arch.collider;
    return Object.freeze({
      ...arch.collider,
      frame: Object.freeze({
        ...arch.collider.frame,
        verticalScale: arch.designScale[1] * scaleMul,
      }),
    });
  }

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

  function makeTradeVesselRecord(route) {
    const aIdx = Math.max(0, Math.min(TRADE_VESSEL_ARCHETYPES - 1, route.archetype | 0));
    const arch = archGPUs[aIdx].arch;
    const scaleMul = route.scale || 1;
    const length = arch.length * scaleMul;
    const beam = arch.beam * scaleMul;
    const hydro = computeVesselHydrostatics(arch, scaleMul, route);
    const boat = {
      id: route.id,
      archetype: aIdx,
      modelId: arch.modelId,
      model: arch.model,
      collider: scaledColliderFor(arch, scaleMul),
      partAssembly: arch.partAssembly,
      fracture: arch.fracture,
      length,
      beam,
      draft: hydro.draft,
      lightDraft: hydro.lightDraft,
      freeboard: hydro.freeboard,
      maxAirDraft: Math.max(0.35, (arch.maxAirDraftMetres ?? 2.15) * scaleMul - hydro.hydroSinkage),
      mass: hydro.massKg,
      hydrodynamics: hydro.hydrodynamics,
      x: 0,
      z: 0,
      heave: 0,
      yaw: 0,
      heading: 0,
      pitch: 0,
      roll: 0,
      aground: false,
      groundingRoll: 0,
      groundingPitch: 0,
      dismastedByBridge: false,
      waterY: 0,
      bedY: -12,
      waterDepth: 12,
      sailFore: arch.index === 1 || arch.index === 3 || arch.index === 4 ? 0 : 1,
      sailMain: arch.index === 1 || arch.index === 3 || arch.index === 4 ? 0 : 1,
      sailMizzen: arch.index === 1 || arch.index === 3 || arch.index === 4 || arch.index === 6 ? 0 : 1,
      showProw: true,
      target: { heave: 0, pitch: 0, roll: 0 },
      damage: null,
    };
    boat.damage = createVesselDamageState(boat);

    // Pass 0 elapsed for brand-new voyages (`phase !== 'shuttle'` when `simElapsedSec > 2`) so newly created
    // inbound ships start at `pts[0]` offshore instead of teleporting `vFloor * simElapsedSec` meters into harbors.
    const initElapsed = route.phase === 'shuttle' ? simElapsedSec : 0;
    const s0 = sampleTradeVesselState(route, boardDay, daysPerSecond, initElapsed);
    const ai = createVesselAutopilotState(route, aIdx, s0, simElapsedSec);
    boat.x = ai.x;
    boat.z = ai.z;
    boat.heave = ai.y - hydro.hydroSinkage;
    boat.waterY = ai.y;
    boat.target.heave = ai.y;
    boat.yaw = ai.yaw;
    boat.heading = (ai.yaw * 180) / Math.PI;
    const hydroSlot = allocHydroSlot();
    if (vesselHydroStateBuffer && device?.queue?.writeBuffer) {
      const initHydro = new Float32Array([boat.heave, s0.pitch || 0, s0.roll || 0, 1.0, 0, 0, 0, 0]);
      device.queue.writeBuffer(vesselHydroStateBuffer, hydroSlot * 32, initHydro);
    }
    return {
      route,
      arch,
      archIndex: aIdx,
      scaleMul,
      spawnedAtSec: simElapsedSec,
      hydroSinkage: hydro.hydroSinkage,
      lightDraft: hydro.lightDraft,
      hydroSlot,
      hydroInitialized: false,
      intactSlot: 0xFFFFFFFF >>> 0,
      boat,
      ai,
      crewSlot: -1,
      lastState: s0,
      lastPoseFurl: -1,
      promoting: false,
      damaged: null,
    };
  }
  const makeLiveVessel = makeTradeVesselRecord;

  const isVesselDamaged = (v) => Boolean(
    (v.boat.damage?.hits ?? 0) > 0
    || (v.boat.damage?.holes?.length ?? 0) > 0
    || (v.boat.damage?.floodingTonnes ?? 0) > 0
    || v.boat.aground
    || v.boat.dismastedByBridge
    || v.boat.damage?.sunk
  );
  const isDeepSettledWreck = (v) => Boolean(
    v.boat.damage?.settledWreck && v.boat.heave < (v.boat.target?.heave ?? 0) - 12
  );

  function rebuildVesselsFromRoutes() {
    const cappedRoutes = routes.slice(0, MAX_TRADE_VESSELS);
    const prevById = new Map(vessels.map((v) => [v.route.id, v]));
    const orphanReachBarges = vessels.filter((v) => String(v.route.id || '').startsWith('reach:') && !cappedRoutes.some((r) => r.id === v.route.id));
    const kept = new Set();
    const matchedPrev = new Array(cappedRoutes.length).fill(null);

    // Pass 1: Match existing vessels & preserve damaged wrecks BEFORE allocating any new hydroSlots so allocHydroSlot() never wraps to 0.
    for (let ri = 0; ri < cappedRoutes.length; ri++) {
      const route = cappedRoutes[ri];
      let prev = prevById.get(route.id);
      const aIdx = Math.max(0, Math.min(TRADE_VESSEL_ARCHETYPES - 1, route.archetype | 0));
      if (!prev && aIdx === 4 && String(route.id || '').startsWith('riverBoat:') && orphanReachBarges.length > 0 && Array.isArray(route.pts) && route.pts.length >= 2) {
        let bestIdx = -1, bestDist = 260;
        for (let oi = 0; oi < orphanReachBarges.length; oi++) {
          const cand = orphanReachBarges[oi];
          if (kept.has(cand)) continue;
          let minRouteDist = Infinity;
          for (let pi = 0; pi < route.pts.length; pi += Math.max(1, Math.floor(route.pts.length / 16))) {
            const d = Math.hypot(route.pts[pi].x - cand.ai.x, route.pts[pi].z - cand.ai.z);
            if (d < minRouteDist) minRouteDist = d;
          }
          if (minRouteDist < bestDist) { bestDist = minRouteDist; bestIdx = oi; }
        }
        if (bestIdx >= 0) prev = orphanReachBarges[bestIdx];
      }
      if (prev && compatibleArch(prev.archIndex, aIdx) && !kept.has(prev)) {
        kept.add(prev);
        matchedPrev[ri] = prev;
      }
    }

    const extraDamaged = [];
    for (const oldV of vessels) {
      if (!kept.has(oldV) && isVesselDamaged(oldV) && !isDeepSettledWreck(oldV) && cappedRoutes.length + extraDamaged.length < MAX_TRADE_VESSELS) {
        kept.add(oldV);
        extraDamaged.push(oldV);
      }
    }

    // Free all unkept hydroSlots upfront before `makeLiveVessel` allocates any new slot.
    for (const oldV of vessels) {
      if (!kept.has(oldV)) {
        freeHydroSlot(oldV.hydroSlot);
        destroyVesselDamaged(oldV);
      }
    }

    // Pass 2: Update matched vessels in place and spawn new vessels into freed hydroSlots.
    const nextVessels = cappedRoutes.map((route, ri) => {
      const prev = matchedPrev[ri];
      const aIdx = Math.max(0, Math.min(TRADE_VESSEL_ARCHETYPES - 1, route.archetype | 0));
      if (prev) {
        if (!isVesselDamaged(prev)) {
          if (prev.archIndex !== aIdx && route.phase !== 'dock' && (prev.archIndex === 1 || prev.archIndex === 3)) {
            const upIdx = prev.archIndex === 1 ? 0 : 2;
            const nextArch = archGPUs[upIdx].arch;
            prev.archIndex = upIdx;
            prev.arch = nextArch;
            prev.boat.archetype = upIdx;
            prev.boat.model = nextArch.model;
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
          prev.boat.collider = scaledColliderFor(prev.arch, prev.scaleMul);
          const hydro = computeVesselHydrostatics(prev.arch, prev.scaleMul, route);
          prev.hydroSinkage = hydro.hydroSinkage;
          prev.lightDraft = hydro.lightDraft;
          prev.boat.draft = hydro.draft;
          prev.boat.lightDraft = hydro.lightDraft;
          prev.boat.freeboard = hydro.freeboard;
          prev.boat.mass = hydro.massKg;
          prev.boat.hydrodynamics = hydro.hydrodynamics;
          prev.boat.maxAirDraft = Math.max(0.35, (prev.arch.maxAirDraftMetres ?? 2.15) * prev.scaleMul - hydro.hydroSinkage);
        }
        return prev;
      }
      return makeLiveVessel(route);
    });
    for (const oldV of extraDamaged) nextVessels.push(oldV);
    vessels = nextVessels;
    crewStationsDirty = true;
    updateAllVessels(0, simElapsedSec, lastContext?.terrain ?? null, true, lastEnv);
  }

  function makeBedSampler(terrain) {
    if (typeof terrain?.height === 'function') return (wx, wz) => terrain.height(wx, wz);
    if (typeof terrain?.groundSample === 'function') return (wx, wz) => terrain.groundSample(wx, wz);
    if (lastContext?.heights && lastContext?.region) {
      const reg = lastContext.region.size ? lastContext.region : { ...lastContext.region, size: Math.round(Math.sqrt(lastContext.heights.length)) };
      const h = lastContext.heights;
      return (wx, wz) => terrainSurfaceSample(h, wx - worldOffsetX, wz - worldOffsetZ, reg);
    }
    return null;
  }

  function sampleOceanSwellElevation(wx, wz, elapsedSec, windVec, stormFlag, waveProbeFn) {
    if (typeof waveProbeFn === 'function') {
      const p = waveProbeFn(wx, wz, elapsedSec);
      if (typeof p === 'number' && Number.isFinite(p)) return p;
      if (p && typeof p === 'object') {
        const y = p.y ?? p.heave ?? p.height;
        if (Number.isFinite(y)) return y;
      }
    }
    const wvx = windVec?.[0] ?? 8;
    const wvz = windVec?.[1] ?? 0;
    const wSpd = Math.hypot(wvx, wvz);
    const ux = wSpd > 1e-3 ? wvx / wSpd : 1;
    const uz = wSpd > 1e-3 ? wvz / wSpd : 0;
    const sx = ux * 0.82 - uz * 0.57;
    const sz = uz * 0.82 + ux * 0.57;
    const cx = ux * 0.64 + uz * 0.77;
    const cz = uz * 0.64 - ux * 0.77;
    const hs = Math.min(1.55, 0.07 + wSpd * wSpd * 0.0048) * (stormFlag ? 1.42 : 1.0);
    // Dispersive deep-water gravity wave superposition (omega^2 = g * k)
    const k1 = 0.052, w1 = Math.sqrt(9.81 * k1);
    const k2 = 0.094, w2 = Math.sqrt(9.81 * k2);
    const k3 = 0.165, w3 = Math.sqrt(9.81 * k3);
    return hs * (
      0.56 * Math.sin((wx * ux + wz * uz) * k1 - elapsedSec * w1)
      + 0.29 * Math.sin((wx * sx + wz * sz) * k2 - elapsedSec * w2 + 1.37)
      + 0.15 * Math.sin((wx * cx + wz * cz) * k3 - elapsedSec * w3 + 2.81)
    );
  }

  function updateAllVessels(dt, elapsedSec, terrain = null, forceUpload = false, env = lastEnv) {
    if (!vessels.length) {
      counts.fill(0);
      totalIntact = 0;
      activeCrewVessels = 0;
      activeWaveVesselCount = 0;
      selectParamsCtrl[0] = 0;
      device.queue.writeBuffer(selectUniformBuffer, 0, selectParamsCtrl);
      crewConfigU32[0] = 0;
      device.queue.writeBuffer(crewConfigBuffer, 0, crewConfigU32, 0, 4);
      waveParamsU32[0] = 0;
      device.queue.writeBuffer(waveParamsBuffer, 0, waveParamsU32, 0, 4);
      gpuSelectionEncoded = false;
      crewEncoded = false;
      return;
    }
    const off = terrain?.getWorldOffset?.() ?? lastContext?.worldOffset ?? null;
    if (off && Number.isFinite(off.x) && Number.isFinite(off.z)) {
      worldOffsetX = off.x;
      worldOffsetZ = off.z;
    }

    const bedAt = makeBedSampler(terrain);
    const riverFlowAt = typeof terrain?.inlandWaterAt === 'function'
      ? (wx, wz) => terrain.inlandWaterAt(wx, wz)
      : (typeof lastContext?.inlandWaterAt === 'function'
          ? (wx, wz) => lastContext.inlandWaterAt(wx, wz)
          : contextRiverAt);
    const hasTerrainProbe = Boolean(bedAt || riverFlowAt);
    const waveProbeFn = terrain?.waveProbe ?? oceanBridge?.waveProbe ?? terrain?.sampleWave ?? null;
    const waveShelterFn = typeof terrain?.waveShelter === 'function' ? terrain.waveShelter.bind(terrain) : null;
    const activeBridges = terrain?.bridges ?? lastContext?.bridges ?? null;

    const nearReg = terrain?.region ?? lastContext?.region ?? null;
    const nearHalfSpan = Number.isFinite(nearReg?.span) ? nearReg.span * 0.485 : Infinity;
    const nearCx = Number(nearReg?.x ?? 0) + worldOffsetX;
    const nearCz = Number(nearReg?.z ?? 0) + worldOffsetZ;
    const isPointInNearWaterDomain = (qx, qz) => (
      !nearReg || (Math.abs(qx - nearCx) <= nearHalfSpan && Math.abs(qz - nearCz) <= nearHalfSpan)
    );

    const sampleColumn = (qx, qz, riverFallbackY = null, minRiverDepth = 0) => {
      const rawBed = bedAt ? bedAt(qx, qz) : -12;
      const bY = Number.isFinite(rawBed) ? rawBed : -12;
      const inNear = isPointInNearWaterDomain(qx, qz);
      const iw = (inNear && riverFlowAt) ? riverFlowAt(qx, qz) : null;
      const iwDepth = Number.isFinite(iw?.depth) ? iw.depth : 0;
      const hasInland = Boolean(
        iw
        && Number.isFinite(iw.wy)
        && (!Number.isFinite(iw.dist) || !Number.isFinite(iw.hw) || iw.dist <= iw.hw * 0.92)
        && (iwDepth > 0.04 || iw.wy > bY + 0.02)
      );
      if (riverFallbackY !== null) {
        if (hasInland) {
          const carvedBed = iwDepth > 0.04 ? (iw.wy - iwDepth) : (iw.wy - Math.max(0.45, minRiverDepth * 0.55));
          const effBed = Math.min(bY, carvedBed);
          return {
            bedY: effBed,
            iw,
            hasInland: true,
            waterY: iw.wy,
            waterDepth: iw.wy - effBed,
          };
        }
        if (bY < 0.25) {
          const effBed = Math.min(bY, -Math.max(0.55, minRiverDepth * 0.6));
          return {
            bedY: effBed,
            iw: null,
            hasInland: false,
            waterY: 0,
            waterDepth: -effBed,
          };
        }
        if (!riverFlowAt) {
          const wY = Number.isFinite(riverFallbackY) ? riverFallbackY : 0;
          const effBed = bedAt ? bY : (wY - Math.max(0.8, minRiverDepth));
          return {
            bedY: effBed,
            iw: null,
            hasInland: true,
            waterY: wY,
            waterDepth: wY - effBed,
          };
        }
        return {
          bedY: bY,
          iw: null,
          hasInland: false,
          waterY: -999,
          waterDepth: -999 - bY,
        };
      }
      const wY = hasInland ? iw.wy : (bY < 0.2 ? 0 : -999);
      const effBed = hasInland ? Math.min(bY, iw.wy - Math.max(0.05, iwDepth)) : bY;
      return {
        bedY: effBed,
        iw,
        hasInland,
        waterY: wY,
        waterDepth: wY - effBed,
      };
    };

    const peerTargets = [];
    if (Array.isArray(env?.avoidVessels)) {
      for (const b of env.avoidVessels) if (b) peerTargets.push(b);
    }
    for (const u of vessels) peerTargets.push(u.boat);

    counts.fill(0);
    totalIntact = 0;
    const windVec = env?.windVec ?? [8, 0];
    const stormFlag = Boolean(env?.storm);
    const swellDirRad = Math.atan2(windVec?.[1] ?? 0, windVec?.[0] ?? 8);

    for (const v of vessels) {
      const dmg = v.boat.damage;
      const ai = v.ai;
      v.intactSlot = 0xFFFFFFFF >>> 0;
      if (dmg.sunk && ai.state !== 'sunk') {
        ai.state = 'sunk';
        dirtySyncFlag = true;
        crewStationsDirty = true;
      }

      const prevAiX = ai.x;
      const prevAiZ = ai.z;
      const prevSpeed = ai.speed || 0;

      const rigFactor = dmg.hits > 0 ? Math.max(0.06, dmg.rigIntegrity ?? 1) : 1;
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
        beam: v.boat.beam,
        draft: v.boat.draft,
      });
      if (dmg.hits > 0 || (dmg.floodingTonnes ?? 0) > 0) {
        ai.speed *= rigFactor * Math.max(0.20, 1 - 0.68 * sinkFrac);
      }
      if (ai.dirtySync) {
        dirtySyncFlag = true;
        ai.dirtySync = false;
      }

      const bowX = Math.sin(ai.yaw), bowZ = -Math.cos(ai.yaw);
      const stbdX = Math.cos(ai.yaw), stbdZ = Math.sin(ai.yaw);
      const halfL = v.boat.length * 0.44;
      const halfB = v.boat.beam * 0.45;

      const isRiverRoute = v.route?.mode === 'river';
      const riverFallbackY = isRiverRoute ? ai.y : null;
      const minRiverChannelDepth = isRiverRoute ? Math.max(v.boat.draft * 1.8, 0.55) : 0;
      const probeHalfL = isRiverRoute ? v.boat.length * 0.18 : halfL;
      const sampleVesselCol = (qx, qz) => sampleColumn(qx, qz, riverFallbackY, minRiverChannelDepth);

      let wx = ai.x + worldOffsetX;
      let wz = ai.z + worldOffsetZ;

      let colMid = hasTerrainProbe ? sampleVesselCol(wx, wz) : { bedY: -12, iw: null, hasInland: false, waterY: ai.y, waterDepth: ai.y + 12 };
      let colBow = hasTerrainProbe ? sampleVesselCol(wx + bowX * probeHalfL, wz + bowZ * probeHalfL) : colMid;
      let colStern = hasTerrainProbe ? sampleVesselCol(wx - bowX * probeHalfL, wz - bowZ * probeHalfL) : colMid;
      if (isRiverRoute && colMid.waterY > -500) {
        ai.y = colMid.waterY;
        ai.waterY = colMid.waterY;
      }

      // 1. Physical Bridge Collision (mast dismasting when deckY < waterY + maxAirDraft, pier/soffit hull halt & breach)
      if (!dmg.sunk && Array.isArray(activeBridges) && activeBridges.length > 0) {
        const surfForBridge = colMid.waterY > -500 ? colMid.waterY : 0;
        const maxAirDraft = v.boat.maxAirDraft ?? ((v.arch.maxAirDraftMetres ?? 2.15) * v.scaleMul);
        for (const br of activeBridges) {
          if (!br || br.collapsed || !Number.isFinite(br.deckY)) continue;
          const ux = Number.isFinite(br.ux) ? br.ux : 0;
          const uz = Number.isFinite(br.uz) ? br.uz : 1;
          const dx = wx - (br.x ?? 0);
          const dz = wz - (br.z ?? 0);
          const alongSpan = dx * ux + dz * uz;
          const acrossChan = -dx * uz + dz * ux;
          const halfSpan = (br.length || 16) * 0.5;
          const bridgeHalfW = (br.halfWidth || 2.2) + 1.1;
          if (Math.abs(alongSpan) > halfSpan + halfB + 2.4 || Math.abs(acrossChan) > bridgeHalfW + halfL * 0.42) continue;

          const curMastInt = typeof dmg.mastIntegrity === 'number'
            ? dmg.mastIntegrity
            : Math.max(dmg.mastIntegrity?.fore ?? 1, dmg.mastIntegrity?.main ?? 1, dmg.mastIntegrity?.mizzen ?? 1);
          if (!v.arch.unmasted && curMastInt > 0 && br.deckY < surfForBridge + maxAirDraft) {
            if (dmg.mastIntegrity && typeof dmg.mastIntegrity === 'object') {
              dmg.mastIntegrity.fore = 0;
              dmg.mastIntegrity.main = 0;
              dmg.mastIntegrity.mizzen = 0;
            } else {
              dmg.mastIntegrity = 0;
            }
            if (dmg.mastState && typeof dmg.mastState === 'object') {
              dmg.mastState.fore = 2;
              dmg.mastState.main = 2;
              dmg.mastState.mizzen = 2;
            }
            if (dmg.partDamage) {
              dmg.partDamage['mast.fore'] = 1;
              dmg.partDamage['mast.main'] = 1;
              dmg.partDamage['mast.mizzen'] = 1;
            }
            dmg.rigIntegrity = 0;
            dmg.foreMastDown = true;
            dmg.mainMastDown = true;
            dmg.mizzenMastDown = true;
            dmg.hits = (dmg.hits ?? 0) + 1;
            dmg.revision = (dmg.revision ?? 0) + 1;
            v.boat.dismastedByBridge = true;
            ai.sailSet = 0;
            ai.speed *= 0.20;
            ensureDamagedSlot(v);
            dirtySyncFlag = true;
          }

          const bridgeSpans = Array.isArray(br.cityIndices) && br.cityIndices.length > 0 ? br.cityIndices.length : ((br.length || 0) >= 28 ? 2 : 1);
          const hitsAbutmentPier = !isRiverRoute && Math.abs(alongSpan) >= Math.max(1.6, halfSpan - halfB - 1.15);
          const hitsCenterPier = !isRiverRoute && bridgeSpans >= 2 && (bridgeSpans % 2) === 0 && Math.abs(alongSpan) <= halfB + 1.15;
          const hitsLowSoffit = br.deckY < surfForBridge + Math.max(1.05, v.boat.freeboard * 0.92);
          if ((hitsAbutmentPier || hitsCenterPier || hitsLowSoffit) && Math.abs(acrossChan) <= bridgeHalfW + halfL * 0.30) {
            const impactSpeed = Math.max(prevSpeed, ai.speed || 0);
            const signOut = acrossChan >= 0 ? 1 : -1;
            const pushDist = (bridgeHalfW + halfL * 0.32) - Math.abs(acrossChan);
            if (pushDist > 0) {
              ai.x += (-uz * signOut) * pushDist;
              ai.z += (ux * signOut) * pushDist;
              wx = ai.x + worldOffsetX;
              wz = ai.z + worldOffsetZ;
            } else {
              ai.x = prevAiX;
              ai.z = prevAiZ;
              wx = ai.x + worldOffsetX;
              wz = ai.z + worldOffsetZ;
            }
            ai.speed = 0;
            ai.vx = 0;
            ai.vz = 0;
            ai.motion = 0;
            if (impactSpeed > 0.55) {
              ensureDamagedSlot(v);
              dmg.hits = (dmg.hits ?? 0) + 1;
              const holeY = -Math.max(0.22, v.boat.draft * 0.45);
              const holeZ = -halfL * 0.82;
              const scInv = 1 / Math.max(0.35, v.scaleMul);
              addHullHole(dmg, {
                design: [0, holeY / Math.max(0.2, v.arch.designScale[1] * v.scaleMul), holeZ * scInv],
                local: [0, holeY, holeZ],
                radius: Math.max(0.11, Math.min(0.34, 0.08 + impactSpeed * 0.065)),
                side: 1,
                compartment: 'foreStarboard',
              });
              dmg.floodingTonnes = (dmg.floodingTonnes ?? 0) + Math.max(0.25, impactSpeed * 0.55);
            }
            colMid = hasTerrainProbe ? sampleVesselCol(wx, wz) : colMid;
            colBow = hasTerrainProbe ? sampleVesselCol(wx + bowX * probeHalfL, wz + bowZ * probeHalfL) : colMid;
            colStern = hasTerrainProbe ? sampleVesselCol(wx - bowX * probeHalfL, wz - bowZ * probeHalfL) : colMid;
          }
        }
      }

      // 2. Real Grounding & Bottom Hull Breaches (`waterDepth < draft * 0.92`)
      // Sea-going ships check full bow/mid/stern keel span; flat-bottomed river skiffs check in-channel midships depth.
      const groundThreshold = v.boat.draft * (isRiverRoute ? 0.45 : 0.92);
      const minHullDepth = isRiverRoute
        ? colMid.waterDepth
        : Math.min(colMid.waterDepth, colBow.waterDepth, colStern.waterDepth);
      if (!dmg.sunk && hasTerrainProbe && minHullDepth < groundThreshold) {
        const wasAground = Boolean(v.boat.aground);
        const impactSpeed = Math.max(prevSpeed, ai.speed || 0);

        // Clamp back to shoal contact boundary along step vector so vessel never plows inland
        const movedDist = Math.hypot(ai.x - prevAiX, ai.z - prevAiZ);
        if (movedDist > 1e-4) {
          const prevWCol = sampleVesselCol(prevAiX + worldOffsetX, prevAiZ + worldOffsetZ);
          if (prevWCol.waterDepth >= groundThreshold) {
            let lo = 0, hi = 1;
            for (let it = 0; it < 6; it++) {
              const mid = (lo + hi) * 0.5;
              const tx = prevAiX + (ai.x - prevAiX) * mid + worldOffsetX;
              const tz = prevAiZ + (ai.z - prevAiZ) * mid + worldOffsetZ;
              const cM = sampleVesselCol(tx, tz);
              const cB = sampleVesselCol(tx + bowX * probeHalfL, tz + bowZ * probeHalfL);
              const cS = sampleVesselCol(tx - bowX * probeHalfL, tz - bowZ * probeHalfL);
              const dTest = isRiverRoute ? cM.waterDepth : Math.min(cM.waterDepth, cB.waterDepth, cS.waterDepth);
              if (dTest >= groundThreshold) lo = mid;
              else hi = mid;
            }
            const stopU = Math.min(1, lo + 0.12 * (hi - lo));
            ai.x = prevAiX + (ai.x - prevAiX) * stopU;
            ai.z = prevAiZ + (ai.z - prevAiZ) * stopU;
            wx = ai.x + worldOffsetX;
            wz = ai.z + worldOffsetZ;
          } else {
            ai.x = prevAiX;
            ai.z = prevAiZ;
            wx = ai.x + worldOffsetX;
            wz = ai.z + worldOffsetZ;
          }
        }

        // If placed on dry land (`waterY <= -500` or `waterDepth <= 0.05`), push sea ships outward down bed gradient to wet shoreline edge
        colMid = sampleVesselCol(wx, wz);
        if (!isRiverRoute && colMid.waterDepth <= 0.05) {
          for (let step = 0; step < 6 && colMid.waterDepth <= 0.08; step++) {
            const bE = sampleVesselCol(wx + 4, wz).bedY;
            const bW = sampleVesselCol(wx - 4, wz).bedY;
            const bN = sampleVesselCol(wx, wz + 4).bedY;
            const bS = sampleVesselCol(wx, wz - 4).bedY;
            const gx = bE - bW, gz = bN - bS;
            const gl = Math.hypot(gx, gz);
            if (gl < 1e-4) break;
            ai.x -= (gx / gl) * 3.5;
            ai.z -= (gz / gl) * 3.5;
            wx = ai.x + worldOffsetX;
            wz = ai.z + worldOffsetZ;
            colMid = sampleVesselCol(wx, wz);
          }
        }
        colBow = sampleVesselCol(wx + bowX * probeHalfL, wz + bowZ * probeHalfL);
        colStern = sampleVesselCol(wx - bowX * probeHalfL, wz - bowZ * probeHalfL);

        ai.speed = 0;
        ai.vx = 0;
        ai.vz = 0;
        ai.motion = 0;
        v.boat.aground = true;
        if (!v.boat.groundingContact) v.boat.groundingContact = { substrate: 'shoal' };

        const colPort = sampleVesselCol(wx - stbdX * halfB, wz - stbdZ * halfB);
        const colStbd = sampleVesselCol(wx + stbdX * halfB, wz + stbdZ * halfB);
        const shoalSeverity = Math.max(0.18, Math.min(1.0, (v.boat.draft - Math.max(0, colMid.waterDepth)) / Math.max(0.35, v.boat.draft)));
        const rawSlopeRoll = Math.atan2(colStbd.bedY - colPort.bedY, Math.max(1.8, halfB * 2));
        const bilgeHeel = Math.abs(rawSlopeRoll) < 0.05 ? (ai.tackSide || 1) * 0.16 * shoalSeverity : 0;
        const targetGroundRoll = Math.max(-0.42, Math.min(0.42, rawSlopeRoll * 0.85 + bilgeHeel));
        const targetGroundPitch = Math.max(-0.24, Math.min(0.24, Math.atan2(colBow.bedY - colStern.bedY, Math.max(3.5, halfL * 2)) * 0.78));
        const settleRate = dt > 0 ? (1 - Math.exp(-dt * 3.2)) : 1;
        v.boat.groundingRoll = (v.boat.groundingRoll ?? 0) + (targetGroundRoll - (v.boat.groundingRoll ?? 0)) * settleRate;
        v.boat.groundingPitch = (v.boat.groundingPitch ?? 0) + (targetGroundPitch - (v.boat.groundingPitch ?? 0)) * settleRate;

        const breachThreshold = isRiverRoute ? 4.2 : 1.15;
        if (!wasAground && impactSpeed > breachThreshold) {
          ensureDamagedSlot(v);
          const foreStrike = colBow.waterDepth <= colStern.waterDepth;
          const holeZ = foreStrike ? -halfL * 0.72 : halfL * 0.65;
          const holeX = (colStbd.bedY >= colPort.bedY ? 1 : -1) * halfB * 0.26;
          const comp = `${foreStrike ? 'fore' : 'aft'}${holeX >= 0 ? 'Starboard' : 'Port'}`;
          const holeY = -Math.max(0.24, (v.lightDraft ?? v.boat.draft) * 0.82);
          const holeRadius = Math.max(0.11, Math.min(0.38, 0.085 + (impactSpeed - 1.15) * 0.075));
          const sxInv = 1 / Math.max(0.25, v.arch.designScale[0] * v.scaleMul);
          const syInv = 1 / Math.max(0.25, v.arch.designScale[1] * v.scaleMul);
          const szInv = 1 / Math.max(0.25, v.arch.designScale[2] * v.scaleMul);
          addHullHole(dmg, {
            design: [holeX * sxInv, holeY * syInv, holeZ * szInv],
            local: [holeX, holeY, holeZ],
            radius: holeRadius,
            side: holeX >= 0 ? 1 : -1,
            compartment: comp,
          });
          if (impactSpeed > 2.15) {
            addHullHole(dmg, {
              design: [-holeX * 0.6 * sxInv, holeY * 0.94 * syInv, 0],
              local: [-holeX * 0.6, holeY * 0.94, 0],
              radius: holeRadius * 0.78,
              side: holeX >= 0 ? -1 : 1,
              compartment: holeX >= 0 ? 'midPort' : 'midStarboard',
            });
          }
          dmg.waterlineBreachArea = (dmg.waterlineBreachArea ?? 0) + Math.PI * holeRadius * holeRadius * 0.55;
          dmg.hits = (dmg.hits ?? 0) + 1;
          dmg.floodingTonnes = (dmg.floodingTonnes ?? 0) + Math.max(0.35, (impactSpeed - 1.0) * 0.85);
          dirtySyncFlag = true;
        }
      } else if (v.boat.aground && (!hasTerrainProbe || minHullDepth >= v.boat.draft * 1.02)) {
        v.boat.aground = false;
      }
      if (!v.boat.aground && ((v.boat.groundingRoll ?? 0) !== 0 || (v.boat.groundingPitch ?? 0) !== 0)) {
        const relax = dt > 0 ? Math.exp(-dt * 2.5) : 0;
        v.boat.groundingRoll = (v.boat.groundingRoll ?? 0) * relax;
        v.boat.groundingPitch = (v.boat.groundingPitch ?? 0) * relax;
        if (Math.abs(v.boat.groundingRoll) < 1e-4) v.boat.groundingRoll = 0;
        if (Math.abs(v.boat.groundingPitch) < 1e-4) v.boat.groundingPitch = 0;
      }

      // 3. Real Water Surface Elevation, Loaded Hydrostatic Sinkage & Wave Attitude
      const meanWaterY = colMid.waterY;
      const estuaryT = colMid.hasInland
        ? (Number.isFinite(colMid.iw?.estuaryT)
            ? colMid.iw.estuaryT
            : (colMid.waterY < 0.35 && colMid.waterDepth > 2.0 ? Math.max(0, 1 - colMid.waterY / 0.35) : 0))
        : (colMid.waterY > -500 ? 1.0 : 0.0);

      let rawShelter = 1.0;
      if (waveShelterFn) {
        if (
          !Number.isFinite(v._cachedShelter) ||
          v._shelterTerrain !== terrain ||
          (wx - v._shelterX) * (wx - v._shelterX) + (wz - v._shelterZ) * (wz - v._shelterZ) >= 64 ||
          Math.abs(swellDirRad - v._shelterSwellDir) > 0.05
        ) {
          v._cachedShelter = waveShelterFn(wx, wz, swellDirRad);
          v._shelterX = wx;
          v._shelterZ = wz;
          v._shelterSwellDir = swellDirRad;
          v._shelterTerrain = terrain;
        }
        rawShelter = v._cachedShelter;
      }
      const shelterMod = Number.isFinite(rawShelter) ? Math.max(0.18, Math.min(1.0, rawShelter)) : 1.0;
      const rawSwellWeight = (estuaryT > 0.20 && meanWaterY > -500 && !v.boat.aground && !dmg.sunk)
        ? Math.max(0, Math.min(1, (estuaryT - 0.20) / 0.80)) * shelterMod
        : 0.0;
      const swellWeight = v.archIndex === 4 ? Math.min(0.42, rawSwellWeight) : rawSwellWeight;
      const wakeWeight = (meanWaterY > -500 && !v.boat.aground && !dmg.sunk)
        ? (isRiverRoute ? 0.85 : Math.max(0.35, shelterMod))
        : 0.0;
      const zSpan = Math.max(1.8, v.boat.length * 0.42);
      const xSpan = Math.max(0.75, v.boat.beam * 0.44);

      const refBoat = env?.avoidVessels?.[0] ?? null;
      const hasPlayerRef = Boolean(refBoat && Number.isFinite(refBoat.x) && Number.isFinite(refBoat.z));
      const hasAnyDamage = (dmg.hits ?? 0) > 0 || (dmg.holes?.length ?? 0) > 0 || (dmg.floodingTonnes ?? 0) > 0 || v.boat.aground || dmg.sunk;
      const skipCpuWaveSample = hasEncodedGpuOnce
        && Boolean(wavePipe && waveBindGroups)
        && !hasAnyDamage
        && typeof waveProbeFn !== 'function'
        && (!hasPlayerRef || ((wx - refBoat.x) * (wx - refBoat.x) + (wz - refBoat.z) * (wz - refBoat.z) > 14400));

      let waveHeave = 0;
      let wavePitch = 0;
      let waveRoll = 0;
      if (swellWeight > 0.001 && !skipCpuWaveSample) {
        const hMid = sampleOceanSwellElevation(wx, wz, elapsedSec, windVec, stormFlag, waveProbeFn);
        const hBow = sampleOceanSwellElevation(wx + bowX * zSpan, wz + bowZ * zSpan, elapsedSec, windVec, stormFlag, waveProbeFn);
        const hStern = sampleOceanSwellElevation(wx - bowX * zSpan, wz - bowZ * zSpan, elapsedSec, windVec, stormFlag, waveProbeFn);
        const hPort = sampleOceanSwellElevation(wx - stbdX * xSpan, wz - stbdZ * xSpan, elapsedSec, windVec, stormFlag, waveProbeFn);
        const hStbd = sampleOceanSwellElevation(wx + stbdX * xSpan, wz + stbdZ * xSpan, elapsedSec, windVec, stormFlag, waveProbeFn);
        waveHeave = ((hBow + hStern + hPort + hStbd + 2 * hMid) / 6) * swellWeight;
        wavePitch = Math.atan2(hBow - hStern, zSpan * 2) * 0.78 * swellWeight;
        waveRoll = Math.atan2(hStbd - hPort, xSpan * 2) * 0.74 * swellWeight;
      }

      const baseWaterY = meanWaterY > -500 ? meanWaterY : (colMid.bedY + v.boat.draft * 0.15);
      const surfY = baseWaterY + waveHeave;
      v.boat.target.heave = meanWaterY > -500 ? meanWaterY : -999;
      v.boat.target.pitch = wavePitch;
      v.boat.target.roll = waveRoll;
      v.boat.waterY = meanWaterY;
      v.boat.bedY = colMid.bedY;
      v.boat.waterDepth = colMid.waterDepth;

      const hydroSinkage = v.hydroSinkage ?? 0;
      const lightDraft = v.lightDraft ?? (v.arch.draft * v.scaleMul);
      const minKeelHeave = hasTerrainProbe ? (colMid.bedY + lightDraft * 0.88) : -Infinity;
      const basePitchNoWave = (estuaryT > 0.20 ? ai.pitch * 0.35 : ai.pitch) + (v.boat.groundingPitch ?? 0);
      const baseRollNoWave = ai.roll + (v.boat.groundingRoll ?? 0);

      // Pre-populate current hull pose before stepping hydrostatic hole inflow & damage
      const preSinkage = hydroSinkage + (dmg.floodingSinkage ?? 0);
      v.boat.x = wx;
      v.boat.z = wz;
      v.boat.yaw = ai.yaw;
      v.boat.heave = Math.max(minKeelHeave, surfY - preSinkage);
      v.boat.pitch = basePitchNoWave + wavePitch + (dmg.floodingPitch ?? 0);
      v.boat.roll = baseRollNoWave + waveRoll + (dmg.floodingRoll ?? 0);

      // 4. Step Hydrostatic Flooding, Hull Holes & Sinking every frame when holed, flooding, hit, grounded, or sunk
      const needsDamageStep = hasAnyDamage;
      if (needsDamageStep) {
        if ((dmg.hits ?? 0) > 0 || (dmg.holes?.length ?? 0) > 0 || (dmg.floodingTonnes ?? 0) > 0 || dmg.sunk) {
          ensureDamagedSlot(v);
        }
        if (dt > 0) {
          const prevTonnes = dmg.floodingTonnes ?? 0;
          const prevPlugSum = (dmg.holes ?? []).reduce((s, h) => s + (h.plug ?? 0), 0);
          const relTerrain = bedAt
            ? { height: (qx, qz) => bedAt(qx, qz) - (meanWaterY > -500 ? meanWaterY : 0) }
            : null;
          stepVesselDamage(v.boat, dt, relTerrain);
          if (dmg.sunk && ai.state !== 'sunk') {
            ai.state = 'sunk';
            dirtySyncFlag = true;
            crewStationsDirty = true;
          }

          const afterPlugSum = (dmg.holes ?? []).reduce((s, h) => s + (h.plug ?? 0), 0);
          const holeRes = (dmg.holes?.length ?? 0) > 0 && Math.abs(afterPlugSum - prevPlugSum) < 1e-6
            ? stepHullHoles(v.boat, dmg, dt)
            : stepHullHoles(v.boat, dmg, 0);

          // Guarantee physical hydrostatic flooding integration whenever holes admit water and stepVesselDamage didn't already advance tonnes
          if (holeRes.totalFlow > 0 && !dmg.sunk && Math.abs((dmg.floodingTonnes ?? 0) - prevTonnes) < 1e-5) {
            dmg.floodingTonnes = prevTonnes + holeRes.totalFlow * dt;
            const wpArea = Math.max(4, v.boat.hydrodynamics?.waterplaneArea ?? (v.boat.length * v.boat.beam * 0.72));
            dmg.floodingSinkage = Math.max(dmg.floodingSinkage ?? 0, dmg.floodingTonnes / (1.025 * wpArea));
            const bowFlow = holeRes.byCompartment.bow ?? 0;
            const sternFlow = holeRes.byCompartment.stern ?? 0;
            const trimDelta = ((bowFlow - sternFlow) * dt) / Math.max(12, (v.boat.mass / 1000) * 0.35);
            dmg.floodingPitch = Math.max(-0.38, Math.min(0.38, (dmg.floodingPitch ?? 0) - trimDelta));
            let sideTorque = 0;
            for (const h of dmg.holes ?? []) sideTorque += (h.side || 0) * (h.flow || 0);
            dmg.floodingRoll = Math.max(-0.55, Math.min(0.55, (dmg.floodingRoll ?? 0) + (sideTorque * dt) / Math.max(8, (v.boat.mass / 1000) * 0.22)));
            if (dmg.floodingSinkage >= v.boat.freeboard * 1.02 + v.boat.draft * 0.25) {
              dmg.sunk = true;
              ai.state = 'sunk';
              dirtySyncFlag = true;
              crewStationsDirty = true;
            }
          }
        } else if ((dmg.holes?.length ?? 0) > 0) {
          stepHullHoles(v.boat, dmg, 0);
        }
      }

      const floodSinkage = dmg.floodingSinkage ?? 0;
      const totalSinkage = hydroSinkage + floodSinkage;
      const effY = Math.max(minKeelHeave, surfY - totalSinkage);
      const basePitch = basePitchNoWave + (dmg.floodingPitch ?? 0);
      const baseRoll = baseRollNoWave + (dmg.floodingRoll ?? 0);
      const effPitch = basePitch + wavePitch;
      const effRoll = baseRoll + waveRoll;
      const headingDeg = (ai.yaw * 180) / Math.PI;
      v.boat.x = wx;
      v.boat.z = wz;
      v.boat.heave = effY;
      v.boat.yaw = ai.yaw;
      v.boat.heading = headingDeg;
      v.boat.pitch = effPitch;
      v.boat.roll = effRoll;

      const wm = (v._waveMeta ??= {
        baseWaterY: 0, zSpan: 0, xSpan: 0, totalSinkage: 0, minKeelY: -1e6,
        swellWeight: 0, wakeWeight: 0, basePitch: 0, baseRoll: 0, flags: 0,
      });
      wm.baseWaterY = baseWaterY;
      wm.zSpan = zSpan;
      wm.xSpan = xSpan;
      wm.totalSinkage = totalSinkage;
      wm.minKeelY = Number.isFinite(minKeelHeave) ? minKeelHeave : -1e6;
      wm.swellWeight = swellWeight;
      wm.wakeWeight = wakeWeight;
      wm.basePitch = basePitch;
      wm.baseRoll = baseRoll;
      wm.flags = ((v.boat.aground || dmg.sunk || meanWaterY <= -500) ? 1 : 0)
        | (isRiverRoute ? 2 : 0)
        | (!v.hydroInitialized ? 4 : 0);

      const fixedFurledOrBarge = v.archIndex === 1 || v.archIndex === 3 || v.archIndex === 4;
      const mastIntScalar = typeof dmg.mastIntegrity === 'number'
        ? dmg.mastIntegrity
        : Math.max(dmg.mastIntegrity?.fore ?? 1, dmg.mastIntegrity?.main ?? 1, dmg.mastIntegrity?.mizzen ?? 1);
      const effSailSet = v.boat.dismastedByBridge || mastIntScalar <= 0 ? 0 : (ai.sailSet ?? 1);
      const furl = fixedFurledOrBarge ? 0 : Math.max(0, Math.min(1, 1 - effSailSet));
      v.boat.sailFore = fixedFurledOrBarge ? 0 : effSailSet;
      v.boat.sailMain = fixedFurledOrBarge ? 0 : effSailSet;
      v.boat.sailMizzen = (fixedFurledOrBarge || v.archIndex === 6) ? 0 : effSailSet;

      const motion = (dmg.sunk || v.boat.aground) ? 0 : ai.motion * Math.max(0.15, dmg.hits > 0 ? (dmg.rigIntegrity ?? 1) : 1);
      const phaseAnim = ai.phaseRad + elapsedSec * 1.35;
      const ls = (v.lastState ??= {
        x: 0, y: 0, z: 0, yaw: 0, heading: 0, pitch: 0, roll: 0,
        bowDir: [0, -1], scale: 1, phase: 0, archetype: 0, motion: 0, speed: 0, sailSet: 1,
      });
      ls.x = ai.x;
      ls.y = surfY;
      ls.z = ai.z;
      ls.yaw = ai.yaw;
      ls.heading = headingDeg;
      ls.pitch = effPitch;
      ls.roll = effRoll;
      ls.bowDir[0] = bowX;
      ls.bowDir[1] = bowZ;
      ls.scale = v.scaleMul;
      ls.phase = ai.phaseRad;
      ls.archetype = v.archIndex;
      ls.motion = motion;
      ls.speed = ai.speed;
      ls.sailSet = effSailSet;

      if ((v.damaged?.ready || v.damaged?.gpuCompiled) && v.damaged.fractureGPU) {
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
        d.hullData[1] = v.arch.designScale[1] * v.scaleMul;
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
        inst[8] = phaseAnim; inst[9] = motion; inst[10] = floodSinkage; inst[11] = furl;
        device.queue.writeBuffer(d.instBuffer, 0, inst);
        d.ready = true;
        continue;
      }

      // Intact (or still compiling damaged pipeline) instance batch: upload flat GPU select source; skip legacy CPU per-archetype packing once GPU selection is active
      // Note: `instAnim.z` (`offI + 10`) is MSAA crossfade `stateVal` in intact `tvVS` (NEVER `floodSinkage`!).
      const a = v.archIndex;
      const idx = counts[a];
      if (idx < MAX_TRADE_VESSELS) {
        counts[a] = idx + 1;
        if (!hasEncodedGpuOnce) {
          const dst = scratch[a];
          const offI = idx * TRADE_VESSEL_INSTANCE_FLOATS;
          dst[offI] = ai.x; dst[offI + 1] = effY; dst[offI + 2] = ai.z; dst[offI + 3] = ai.yaw;
          dst[offI + 4] = effPitch; dst[offI + 5] = effRoll; dst[offI + 6] = v.scaleMul; dst[offI + 7] = a;
          dst[offI + 8] = phaseAnim; dst[offI + 9] = motion; dst[offI + 10] = 0.0; dst[offI + 11] = furl;
        }
      }
      if (totalIntact < MAX_TRADE_VESSELS) {
        v.intactSlot = totalIntact >>> 0;
        const flatOff = totalIntact * TRADE_VESSEL_INSTANCE_FLOATS;
        allIntactScratch[flatOff] = ai.x; allIntactScratch[flatOff + 1] = effY; allIntactScratch[flatOff + 2] = ai.z; allIntactScratch[flatOff + 3] = ai.yaw;
        allIntactScratch[flatOff + 4] = effPitch; allIntactScratch[flatOff + 5] = effRoll; allIntactScratch[flatOff + 6] = v.scaleMul; allIntactScratch[flatOff + 7] = a;
        allIntactScratch[flatOff + 8] = phaseAnim; allIntactScratch[flatOff + 9] = motion; allIntactScratch[flatOff + 10] = 0.0; allIntactScratch[flatOff + 11] = furl;
        totalIntact++;
      }
    }

    if (crewStationsDirty) {
      syncDeckCrewStationTables();
    }
    let crewSlotCursor = 0;
    for (let vi = 0; vi < vessels.length; vi++) {
      const v = vessels[vi];
      if (v.boat?.damage?.sunk || crewSlotCursor >= MAX_TRADE_VESSELS) {
        v.crewSlot = -1;
        continue;
      }
      v.crewSlot = crewSlotCursor;
      const ls = v.lastState;
      const dmg = v.boat.damage;
      const fixedFurledOrBarge = v.archIndex === 1 || v.archIndex === 3 || v.archIndex === 4;
      const effSailSet = v.boat.dismastedByBridge || (dmg.mastIntegrity ?? 1) <= 0 ? 0 : (ls?.sailSet ?? v.ai.sailSet ?? 1);
      const furl = fixedFurledOrBarge ? 0 : Math.max(0, Math.min(1, 1 - effSailSet));
      const cOff = crewSlotCursor * TRADE_VESSEL_INSTANCE_FLOATS;
      crewSrcInstancesScratch[cOff + 0] = v.ai.x;
      crewSrcInstancesScratch[cOff + 1] = v.boat.heave;
      crewSrcInstancesScratch[cOff + 2] = v.ai.z;
      crewSrcInstancesScratch[cOff + 3] = v.ai.yaw;
      crewSrcInstancesScratch[cOff + 4] = v.boat.pitch;
      crewSrcInstancesScratch[cOff + 5] = v.boat.roll;
      crewSrcInstancesScratch[cOff + 6] = v.scaleMul;
      crewSrcInstancesScratch[cOff + 7] = v.archIndex;
      crewSrcInstancesScratch[cOff + 8] = v.ai.phaseRad + elapsedSec * 1.35;
      crewSrcInstancesScratch[cOff + 9] = ls?.motion ?? 0;
      crewSrcInstancesScratch[cOff + 10] = dmg.floodingSinkage ?? 0;
      crewSrcInstancesScratch[cOff + 11] = furl;
      crewSlotCursor++;
    }

    let waveCount = 0;
    for (let vi = 0; vi < vessels.length && waveCount < MAX_TRADE_VESSELS; vi++) {
      const v = vessels[vi];
      const wm = v._waveMeta;
      if (!wm) continue;
      const wOff = waveCount * 16;
      waveInputF32[wOff + 0] = v.ai.x;
      waveInputF32[wOff + 1] = wm.baseWaterY;
      waveInputF32[wOff + 2] = v.ai.z;
      waveInputF32[wOff + 3] = v.ai.yaw;
      waveInputF32[wOff + 4] = wm.zSpan;
      waveInputF32[wOff + 5] = wm.xSpan;
      waveInputF32[wOff + 6] = wm.totalSinkage;
      waveInputF32[wOff + 7] = wm.minKeelY;
      waveInputF32[wOff + 8] = wm.swellWeight;
      waveInputF32[wOff + 9] = wm.wakeWeight;
      waveInputF32[wOff + 10] = wm.basePitch;
      waveInputF32[wOff + 11] = wm.baseRoll;
      waveInputU32[wOff + 12] = (v.hydroSlot ?? waveCount) >>> 0;
      waveInputU32[wOff + 13] = (v.intactSlot ?? 0xFFFFFFFF) >>> 0;
      waveInputU32[wOff + 14] = (v.crewSlot >= 0 ? v.crewSlot : 0xFFFFFFFF) >>> 0;
      waveInputU32[wOff + 15] = wm.flags >>> 0;
      waveCount++;
    }
    activeWaveVesselCount = waveCount;

    if (forceUpload || Math.abs(elapsedSec - lastUploadTime) >= 1 / 65) {
      lastUploadTime = elapsedSec;
      selectParamsCtrl[0] = totalIntact;
      selectParamsCtrl[1] = MAX_CONT_TRIS;
      selectParamsCtrl[2] = samples;
      selectParamsCtrl[3] = MAX_TRADE_VESSELS;
      writeSelectParams();
      device.queue.writeBuffer(selectUniformBuffer, 0, selectParamsBuf, 0, 32);
      waveParamsU32[0] = activeWaveVesselCount;
      waveParamsU32[1] = MAX_TRADE_VESSELS;
      waveParamsU32[2] = oceanBridge?.dispView ? 1 : 0;
      waveParamsU32[3] = 0;
      waveParamsF32[0] = Math.max(0, Math.min(0.05, Number.isFinite(dt) ? dt : 0));
      waveParamsF32[1] = Number.isFinite(elapsedSec) ? elapsedSec : 0;
      waveParamsF32[2] = (windVec?.[0] ?? 8) * (stormFlag ? 1.25 : 1.0);
      waveParamsF32[3] = (windVec?.[1] ?? 0) * (stormFlag ? 1.25 : 1.0);
      device.queue.writeBuffer(waveParamsBuffer, 0, waveParamsBuf);
      if (activeWaveVesselCount > 0) {
        device.queue.writeBuffer(vesselWaveInputBuffer, 0, waveInputBuf, 0, activeWaveVesselCount * 64);
      }
      if (totalIntact > 0) {
        device.queue.writeBuffer(srcInstancesBuffer, 0, allIntactScratch, 0, totalIntact * TRADE_VESSEL_INSTANCE_FLOATS);
      }
      if (crewSlotCursor > 0) {
        device.queue.writeBuffer(crewSrcInstancesBuffer, 0, crewSrcInstancesScratch, 0, crewSlotCursor * TRADE_VESSEL_INSTANCE_FLOATS);
      }
      gpuSelectionEncoded = false;
      crewEncoded = false;
      if (!hasEncodedGpuOnce) {
        for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
          if (counts[a] > 0) {
            device.queue.writeBuffer(instanceBuffers[a], 0, scratch[a], 0, counts[a] * TRADE_VESSEL_INSTANCE_FLOATS);
          }
        }
      }
    }
  }

  function buildReachChannelSampler(reaches) {
    const valid = Array.isArray(reaches)
      ? reaches.filter((r) => Array.isArray(r?.points) && r.points.length >= 2)
      : [];
    if (!valid.length) return null;
    return (wx, wz) => {
      let bestRatio = Infinity;
      let bestHit = null;
      for (let ri = 0; ri < valid.length; ri++) {
        const pts = valid[ri].points;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const lenSq = dx * dx + dz * dz;
          const u = lenSq > 1e-6 ? Math.max(0, Math.min(1, ((wx - a[0]) * dx + (wz - a[1]) * dz) / lenSq)) : 0;
          const px = a[0] + dx * u, pz = a[1] + dz * u;
          const dist = Math.hypot(wx - px, wz - pz);
          const hw = Math.max(0.5, (a[2] ?? 3.5) + ((b[2] ?? 3.5) - (a[2] ?? 3.5)) * u);
          if (dist > hw * 0.92) continue;
          const ratio = dist / hw;
          if (ratio < bestRatio) {
            bestRatio = ratio;
            const wy = (a[3] ?? 0) + ((b[3] ?? 0) - (a[3] ?? 0)) * u;
            const depth = Math.max(0.45, (a[4] ?? 1.2) + ((b[4] ?? 1.2) - (a[4] ?? 1.2)) * u);
            const vx = (a[5] ?? 0) + ((b[5] ?? 0) - (a[5] ?? 0)) * u;
            const vz = (a[6] ?? 0) + ((b[6] ?? 0) - (a[6] ?? 0)) * u;
            const estuaryT = (Number.isFinite(a[8]) && Number.isFinite(b[8]))
              ? (a[8] + (b[8] - a[8]) * u)
              : 0;
            bestHit = { wy, hw, depth, vx, vz, estuaryT, dist };
          }
        }
      }
      return bestHit;
    };
  }

  return {
    get count() { return routes.length; },
    get deckCrewCount() { return activeDeckSoulCount; },
    get activeWaveCount() { return activeWaveVesselCount; },
    setSharedCrew(nextSharedCrew) {
      return installSharedCrew(nextSharedCrew);
    },
    setTraffic(snapshot, origin, riverReaches = [], places = [], context = null) {
      if (context) lastContext = context;
      const effReaches = (Array.isArray(riverReaches) && riverReaches.length > 0)
        ? riverReaches
        : (Array.isArray(lastContext?.port?.country?.riverReaches) ? lastContext.port.country.riverReaches : []);
      contextRiverAt = buildReachChannelSampler(effReaches);
      routes = buildTradeVesselRoutes(snapshot, origin, { riverReaches: effReaches, places, ...(lastContext || {}) });
      lastUploadTime = -Infinity;
      if (Number.isFinite(snapshot?.day)) boardDay = snapshot.day;
      rebuildVesselsFromRoutes();
    },
    locate() {
      const rotLocal = (lx, ly, lz, yaw, pitch, roll) => {
        const cr = Math.cos(roll), sr = Math.sin(roll);
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        const ch = Math.cos(yaw), sh = Math.sin(yaw);
        const xx = cr * lx - sr * ly;
        const yy = sr * lx + cr * ly;
        const yp = cp * yy - sp * lz;
        const zp = sp * yy + cp * lz;
        return [ch * xx - sh * zp, yp, sh * xx + ch * zp];
      };
      return vessels.map((v) => {
        const effY = Number.isFinite(v.boat?.heave) ? v.boat.heave : v.ai.y;
        const effPitch = Number.isFinite(v.boat?.pitch) ? v.boat.pitch : v.ai.pitch;
        const effRoll = Number.isFinite(v.boat?.roll) ? v.boat.roll : v.ai.roll;
        const r = v.route;
        const shipLabel = r.shipName || r.id;
        const portSuffix = r.homePort ? ` of ${r.homePort}` : '';
        const actionVerb = v.boat?.aground
          ? 'stranded aground aboard'
          : r.phase === 'dock'
            ? 'at anchor aboard'
            : r.phase === 'out'
              ? 'putting to sea aboard'
              : r.mode === 'river'
                ? 'working river passage aboard'
                : 'sailing aboard';
        const deckPeople = [];
        if (!v.boat?.damage?.sunk && Array.isArray(v.arch?.deckStations)) {
          const crewList = Array.isArray(r.crew) && r.crew.length
            ? r.crew
            : (Array.isArray(r.oarsmen) ? r.oarsmen : []);
          for (const st of v.arch.deckStations) {
            let soul = null;
            let duty = '';
            if (st.station === 'captain') {
              soul = r.captain ?? r.pilot ?? null;
              duty = `commanding ${shipLabel}${portSuffix}`;
            } else if (st.station === 'pilot') {
              soul = r.pilot ?? r.captain ?? null;
              duty = `piloting ${shipLabel}${portSuffix}`;
            } else if (st.station === 'merchant') {
              soul = r.merchant ?? null;
              duty = `tending cargo manifest ${actionVerb} ${shipLabel}${portSuffix}`;
            } else if (st.station.startsWith('crew:')) {
              const ci = Number(st.station.slice(5)) | 0;
              soul = crewList[ci] ?? null;
              duty = `${soul?.role || 'mariner'} ${actionVerb} ${shipLabel}${portSuffix}`;
            }
            if (!soul || soul.id == null) continue;
            const [wx, wy, wz] = rotLocal(
              st.localMetres[0] * v.scaleMul,
              st.localMetres[1] * v.scaleMul,
              st.localMetres[2] * v.scaleMul,
              v.ai.yaw,
              effPitch,
              effRoll,
            );
            deckPeople.push({
              soul,
              station: st.station,
              role: st.role,
              poseKind: st.poseKind,
              vesselId: r.id,
              shipName: shipLabel,
              homePort: r.homePort || '',
              shipKind: r.kind || v.arch.label,
              phase: r.phase,
              x: v.ai.x + wx,
              y: effY + wy,
              z: v.ai.z + wz,
              doing: duty,
            });
          }
        }
        const dmg = v.boat?.damage;
        return {
          x: v.ai.x,
          y: effY,
          z: v.ai.z,
          worldX: v.boat?.x ?? (v.ai.x + worldOffsetX),
          worldZ: v.boat?.z ?? (v.ai.z + worldOffsetZ),
          yaw: v.ai.yaw,
          heading: (v.ai.yaw * 180) / Math.PI,
          pitch: effPitch,
          roll: effRoll,
          bowDir: [Math.sin(v.ai.yaw), -Math.cos(v.ai.yaw)],
          scale: v.scaleMul,
          archetype: v.archIndex,
          archLabel: v.arch.label,
          speed: v.ai.speed,
          motion: v.ai.motion,
          sailSet: v.ai.sailSet,
          aiState: v.ai.state,
          tacking: v.ai.tacking,
          etaDays: v.ai.etaDays,
          id: r.id,
          mode: r.mode,
          phase: r.phase,
          phaseRad: v.ai.phaseRad,
          shipName: r.shipName || '',
          homePort: r.homePort || '',
          kind: r.kind || v.arch.label,
          tonnage: r.tonnage || 0,
          draft: v.boat?.draft ?? v.arch.draft,
          lightDraft: +(v.lightDraft ?? v.arch.draft).toFixed(3),
          sinkage: +(v.hydroSinkage ?? 0).toFixed(3),
          maxAirDraft: v.boat?.maxAirDraft ?? v.arch.maxAirDraftMetres,
          waterY: v.boat?.waterY ?? effY,
          bedY: v.boat?.bedY ?? -12,
          waterDepth: v.boat?.waterDepth ?? 12,
          channelHw: Number.isFinite(v.ai.channelHw) ? +v.ai.channelHw.toFixed(3) : null,
          crossTrackM: Number.isFinite(v.ai.crossTrackM) ? +v.ai.crossTrackM.toFixed(3) : 0,
          aground: Boolean(v.boat?.aground),
          dismastedByBridge: Boolean(v.boat?.dismastedByBridge),
          mastIntegrity: typeof dmg?.mastIntegrity === 'number'
            ? dmg.mastIntegrity
            : Math.max(dmg?.mastIntegrity?.fore ?? 1, dmg?.mastIntegrity?.main ?? 1, dmg?.mastIntegrity?.mizzen ?? 1),
          floodingTonnes: +(dmg?.floodingTonnes ?? 0).toFixed(2),
          holesCount: dmg?.holes?.length ?? 0,
          sunk: Boolean(dmg?.sunk),
          cargo: r.cargo ?? {},
          load: r.load ?? {},
          captain: r.captain ?? null,
          merchant: r.merchant ?? null,
          crew: Array.isArray(r.crew) ? r.crew : [],
          pilot: r.pilot ?? null,
          oarsmen: r.oarsmen ?? 0,
          deckPeople,
        };
      });
    },
    getWakeSources(center = null, maxCount = 24) {
      const cap = Math.max(0, Math.min(24, maxCount | 0));
      wakeOutScratch.length = 0;
      if (!cap || !vessels.length) return wakeOutScratch;
      const cx = Number(center?.x ?? center?.[0]);
      const cz = Number(center?.z ?? center?.[2] ?? center?.[1]);
      const hasCenter = Number.isFinite(cx) && Number.isFinite(cz);
      wakeCandActive.length = 0;
      let poolIdx = 0;
      for (let i = 0; i < vessels.length && poolIdx < wakeCandPool.length; i++) {
        const v = vessels[i];
        const dmg = v.boat?.damage;
        if (dmg?.sunk || v.boat?.aground || (v.boat?.waterY ?? 0) <= -500) continue;
        let vx = Number.isFinite(v.ai.vx) ? v.ai.vx : Math.sin(v.ai.yaw) * (v.ai.speed || 0);
        let vz = Number.isFinite(v.ai.vz) ? v.ai.vz : -Math.cos(v.ai.yaw) * (v.ai.speed || 0);
        let speed = Math.hypot(vx, vz);
        if (speed < 1e-4 && (v.ai.speed || 0) > 0.20) {
          vx = Math.sin(v.ai.yaw) * v.ai.speed;
          vz = -Math.cos(v.ai.yaw) * v.ai.speed;
          speed = v.ai.speed;
        }
        if (speed <= 0.20) continue;
        const wx = v.boat?.x ?? (v.ai.x + worldOffsetX);
        const wz = v.boat?.z ?? (v.ai.z + worldOffsetZ);
        if (!Number.isFinite(wx) || !Number.isFinite(wz)) continue;
        const slot = wakeCandPool[poolIdx++];
        slot.dSq = hasCenter ? ((wx - cx) * (wx - cx) + (wz - cz) * (wz - cz)) : i;
        const d = slot.desc;
        d.x = wx;
        d.z = wz;
        d.vx = vx;
        d.vz = vz;
        d.length = v.boat.length;
        d.beam = v.boat.beam;
        d.draft = v.boat.draft;
        d.displacement = +((v.boat.mass || 12000) / 1000).toFixed(2);
        d.isRiver = v.route?.mode === 'river';
        wakeCandActive.push(slot);
      }
      if (hasCenter && wakeCandActive.length > 1) {
        wakeCandActive.sort((a, b) => a.dSq - b.dSq);
      }
      for (let i = 0; i < wakeCandActive.length && i < cap; i++) wakeOutScratch.push(wakeCandActive[i].desc);
      return wakeOutScratch;
    },
    consumeDirtySync() {
      const dirty = dirtySyncFlag;
      dirtySyncFlag = false;
      return dirty;
    },
    getMaritimeReport() {
      const ships = [];
      const caravans = [];
      const riverBoats = [];
      for (const v of vessels) {
        const entry = {
          state: v.ai.state,
          progress: v.ai.progress,
          etaDays: v.ai.etaDays,
          heldByWeather: v.ai.heldByWeather,
          aground: Boolean(v.boat.aground),
          sunk: Boolean(v.boat.damage?.sunk),
          ...(v.route.pilot ? { pilot: v.route.pilot } : {}),
        };
        if (v.route.shipId != null) {
          ships.push({ ...entry, id: v.route.shipId, berthIndex: v.route.bi ?? -1 });
        } else if (v.route.riverBoatId != null) {
          riverBoats.push({ ...entry, id: v.route.riverBoatId });
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
        riverBoats,
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
      solidBindGroup = nearSolidPipe ? pickEntries(nearSolidPipe, [0, 1, 2, 3, 4, 12, 19, 20, 21]) : bindGroup;
      shadowBindGroup = pickEntries(shadowPipe, [0, 12, 19]);
      waveBindGroups = makeWaveBindGroups(resources);
      if (submergedCapture?.pipeline) {
        submergedGroup0 = pickEntries(submergedCapture.pipeline, [0, 1, 2, 3, 4, 12, 19, 20, 21]);
      }
      if (selectPipe) selectBindGroup = makeSelectBindGroup(resources);
      if (continuumSolidPipe) contSolidGroup0 = pickEntries(continuumSolidPipe, [0, 1, 2, 3, 4, 12]);
      if (continuumPipe) contGroup0 = pickEntries(continuumPipe, [0, 1, 2, 3, 4, 12]);
      if (splatPipe) splatGroup0 = pickEntries(splatPipe, [0, 1, 2, 3, 4]);
      if (deckCrewGPU) rebuildDeckCrewBindGroups(deckCrewGPU, resources);
      for (const v of vessels) {
        if (v.damaged && damagedAssets) rebindDamagedVessel(v);
      }
    },
    encode(pass) {
      if (wavePipe && waveBindGroups && activeWaveVesselCount > 0) {
        const swIdx = resolvedSurfaceWaves?.views?.length >= 2 ? (resolvedSurfaceWaves.current & 1) : 0;
        const wbg = waveBindGroups[swIdx] ?? waveBindGroups[0];
        if (wbg) {
          pass.setPipeline(wavePipe);
          pass.setBindGroup(0, wbg);
          pass.dispatchWorkgroups(Math.ceil(activeWaveVesselCount / 64));
          for (let vi = 0; vi < vessels.length; vi++) {
            vessels[vi].hydroInitialized = true;
          }
        }
      }
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
        if (gpuSelectionEncoded) hasEncodedGpuOnce = true;
      }
      if (deckCrewGPU?.clearBindGroup && deckCrewGPU?.selectBindGroup) {
        pass.setPipeline(deckCrewGPU.clearPipe);
        pass.setBindGroup(0, deckCrewGPU.clearBindGroup);
        pass.dispatchWorkgroups(1);
        const totalStations = activeCrewVessels * MAX_DECK_STATIONS_PER_VESSEL;
        if (totalStations > 0 && activeDeckSoulCount > 0) {
          pass.setPipeline(deckCrewGPU.selectPipe);
          pass.setBindGroup(0, deckCrewGPU.selectBindGroup);
          pass.dispatchWorkgroups(Math.ceil(totalStations / 64));
        }
        crewEncoded = true;
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
    drawSubmerged(pass, above = false) {
      if (!submergedCapture || !submergedGroup0 || !submergedGroup1 || !vessels.length) return;
      submergedCapture.bind(pass, above);
      pass.setBindGroup(0, submergedGroup0);
      pass.setBindGroup(1, submergedGroup1);
      if (gpuSelectionEncoded && typeof pass.drawIndexedIndirect === 'function') {
        for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
          if (above && !counts[a]) continue;
          const { vertexBuffer, indexBuffer } = archGPUs[a];
          pass.setVertexBuffer(0, vertexBuffer);
          pass.setVertexBuffer(1, nearOutBuffer, a * NEAR_SLICE_BYTES, NEAR_SLICE_BYTES);
          pass.setIndexBuffer(indexBuffer, 'uint32');
          pass.drawIndexedIndirect(indirectBuffer, a * 20);
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
    },
    draw(pass, elapsedSec = NaN) {
      const t = Number.isFinite(elapsedSec) ? elapsedSec : (hasSimClock ? simElapsedSec : performance.now() * 0.001);
      if (!hasSimClock || Number.isFinite(elapsedSec)) {
        updateAllVessels(0, t, null, false, lastEnv);
      }
      if (!pipe || !bindGroup) return;
      const canIndirect = typeof pass.drawIndexedIndirect === 'function' && typeof pass.drawIndirect === 'function';
      if (gpuSelectionEncoded && continuumPipe && splatPipe && canIndirect) {
        if (totalIntact > 0) {
          // 1. 100% opaque near hulls (spanPx >= 38) -> TBDR hardware Early-Z / HSR solid pipeline (no sample_mask)
          const useSolidPipe = nearSolidPipe ?? pipe;
          pass.setPipeline(useSolidPipe);
          pass.setBindGroup(0, nearSolidPipe ? solidBindGroup : bindGroup);
          pass.setBindGroup(1, nearSolidPipe ? solidGroup1 : intactGroup1);
          for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
            if (!counts[a]) continue;
            const { vertexBuffer, indexBuffer } = archGPUs[a];
            pass.setVertexBuffer(0, vertexBuffer);
            pass.setVertexBuffer(1, nearOutBuffer, (14 + a) * NEAR_SLICE_BYTES, NEAR_SLICE_BYTES);
            pass.setIndexBuffer(indexBuffer, 'uint32');
            pass.drawIndexedIndirect(indirectBuffer, (14 + a) * 20);
          }
          // 2. 100% opaque continuum hulls (spanPx <= 27) -> TBDR hardware Early-Z / HSR solid pipeline
          if (continuumSolidPipe && contSolidGroup0 && contSolidGroup1) {
            pass.setPipeline(continuumSolidPipe);
            pass.setBindGroup(0, contSolidGroup0);
            pass.setBindGroup(1, contSolidGroup1);
            pass.drawIndirect(indirectBuffer, 560);
          }
          // 3. MSAA sample_mask crossfade band (27 < spanPx < 38): near crossfade + continuum crossfade
          pass.setPipeline(pipe);
          pass.setBindGroup(0, bindGroup);
          pass.setBindGroup(1, intactGroup1);
          for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
            if (!counts[a]) continue;
            const { vertexBuffer, indexBuffer } = archGPUs[a];
            pass.setVertexBuffer(0, vertexBuffer);
            pass.setVertexBuffer(1, nearOutBuffer, (21 + a) * NEAR_SLICE_BYTES, NEAR_SLICE_BYTES);
            pass.setIndexBuffer(indexBuffer, 'uint32');
            pass.drawIndexedIndirect(indirectBuffer, (21 + a) * 20);
          }
          pass.setPipeline(continuumPipe);
          pass.setBindGroup(0, contGroup0);
          pass.setBindGroup(1, contGroup1);
          pass.drawIndirect(indirectBuffer, 576);
          // 4. Horizon silhouette splats (spanPx <= 3.5)
          pass.setPipeline(splatPipe);
          pass.setBindGroup(0, splatGroup0);
          pass.setBindGroup(1, splatGroup1);
          pass.drawIndirect(indirectBuffer, 592);
        }
      } else {
        const useSolidPipe = nearSolidPipe ?? pipe;
        pass.setPipeline(useSolidPipe);
        pass.setBindGroup(0, nearSolidPipe ? solidBindGroup : bindGroup);
        pass.setBindGroup(1, nearSolidPipe ? solidGroup1 : intactGroup1);
        for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
          if (!counts[a]) continue;
          const { arch, vertexBuffer, indexBuffer } = archGPUs[a];
          pass.setVertexBuffer(0, vertexBuffer);
          pass.setVertexBuffer(1, instanceBuffers[a]);
          pass.setIndexBuffer(indexBuffer, 'uint32');
          pass.drawIndexed(arch.indexCount, counts[a]);
        }
      }

      if (crewEncoded && deckCrewGPU && activeDeckSoulCount > 0 && canIndirect) {
        // 1. 100% opaque close/mid-range deck crew (pixels >= 10) -> TBDR hardware Early-Z / HSR solid pipeline
        const crewSolid = deckCrewGPU.solidPipe ?? deckCrewGPU.renderPipe;
        pass.setPipeline(crewSolid);
        pass.setBindGroup(0, deckCrewGPU.solidGroup0 ?? deckCrewGPU.renderGroup0);
        for (let m = 0; m < DECK_CREW_MODELS; m++) {
          const mGeo = deckCrewGPU.models[m];
          pass.setVertexBuffer(0, mGeo.vertex);
          for (let tier = 0; tier < DECK_CREW_TIERS; tier++) {
            const bucket = m * DECK_CREW_TIERS + tier;
            pass.setBindGroup(1, deckCrewGPU.solidGroup1[bucket]);
            pass.setIndexBuffer(mGeo.tiers[tier].buffer, 'uint32');
            pass.drawIndexedIndirect(crewIndirectBuffer, bucket * 20);
          }
        }
        // 2. MSAA sample_mask crossfade crew band (4 < pixels < 10) -> buckets 10..11
        pass.setPipeline(deckCrewGPU.renderPipe);
        pass.setBindGroup(0, deckCrewGPU.renderGroup0);
        for (let m = 0; m < DECK_CREW_MODELS; m++) {
          const mGeo = deckCrewGPU.models[m];
          pass.setVertexBuffer(0, mGeo.vertex);
          pass.setBindGroup(1, deckCrewGPU.fadeGroup1[m]);
          pass.setIndexBuffer(mGeo.tiers[DECK_CREW_TIERS - 1].buffer, 'uint32');
          pass.drawIndexedIndirect(crewIndirectBuffer, (10 + m) * 20);
        }
        // 3. Distant 1-triangle silhouette splat crew (pixels <= 10)
        pass.setPipeline(deckCrewGPU.splatPipe);
        pass.setBindGroup(0, deckCrewGPU.splatGroup0);
        pass.setBindGroup(1, deckCrewGPU.splatGroup1);
        pass.drawIndirect(crewIndirectBuffer, 240);
      }
    },
    // The indirect draws draw() submits in the main scene pass this frame, for the continuum census
    // (js/continuum-census.js). Damaged ships (drawDamaged) and the pre-selection fallback are sized on the CPU.
    continuumDraws() {
      const draws = [];
      if (gpuSelectionEncoded && continuumPipe && splatPipe && totalIntact > 0) {
        draws.push(
          { buffer: indirectBuffer, offset: 14 * 20, records: TRADE_VESSEL_ARCHETYPES, stride: 5 }, // whole ships, solid
          { buffer: indirectBuffer, offset: 21 * 20, records: TRADE_VESSEL_ARCHETYPES, stride: 5 }, // whole ships, band
          { buffer: indirectBuffer, offset: 140 * 4, records: 3, stride: 4 }, // continuum solid, continuum band, splats
        );
      }
      if (crewEncoded && deckCrewGPU && activeDeckSoulCount > 0) {
        draws.push(
          { buffer: crewIndirectBuffer, offset: 0, records: DECK_CREW_MODELS * DECK_CREW_TIERS, stride: 5 }, // tiers, solid
          { buffer: crewIndirectBuffer, offset: 10 * 20, records: DECK_CREW_MODELS, stride: 5 }, // mesh side of the band
          { buffer: crewIndirectBuffer, offset: 240, records: 1, stride: 4 }, // splats
        );
      }
      return draws;
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
            if (!counts[a]) continue;
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
      if (crewEncoded && deckCrewGPU && activeDeckSoulCount > 0 && typeof pass.drawIndexedIndirect === 'function') {
        pass.setPipeline(deckCrewGPU.shadowPipe);
        pass.setBindGroup(0, deckCrewGPU.shadowGroup0);
        for (let m = 0; m < DECK_CREW_MODELS; m++) {
          const mGeo = deckCrewGPU.models[m];
          pass.setVertexBuffer(0, mGeo.vertex);
          pass.setBindGroup(1, deckCrewGPU.shadowGroup1[m]);
          pass.setIndexBuffer(mGeo.tiers[DECK_CREW_TIERS - 1].buffer, 'uint32');
          pass.drawIndexedIndirect(crewIndirectBuffer, (8 + m) * 20);
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
      releaseDeckCrewGPU(deckCrewGPU);
      deckCrewGPU = null;
      for (const g of archGPUs) {
        g.vertexBuffer?.destroy?.();
        g.indexBuffer?.destroy?.();
      }
      for (const b of instanceBuffers) b?.destroy?.();
      for (const b of [
        selectUniformBuffer, stepMetaBuffer, contBaseIndicesBuffer, contStatesBuffer,
        contVertColsBuffer, srcInstancesBuffer, nearOutBuffer, contListBuffer, splatListBuffer, indirectBuffer,
        waveParamsBuffer, vesselWaveInputBuffer, vesselHydroStateBuffer, swUniformFallbackBuffer,
        crewConfigBuffer, crewSrcInstancesBuffer, crewStationsBuffer, crewLooksBuffer,
        crewBodiesBuffer, crewSplatListBuffer, crewIndirectBuffer,
      ]) b?.destroy?.();
      seaDispFallbackTex?.destroy?.();
      swFallbackTex?.destroy?.();
      oakFallback.tex?.destroy?.();
      routes = [];
      vessels = [];
    },
  };
}
