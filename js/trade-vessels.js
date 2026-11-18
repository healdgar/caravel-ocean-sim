// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Ocean-going merchant ships (cogs, carracks, caravels, harbor barques) and inland river trade barges
// built from the canonical boat-part system (ship-mesh, ship-part-taxonomy, part-assembly, ship-fracture,
// ship-collider) with real oak/canvas PBR optics and full cannon destructibility.
import { FRAME_WGSL, ATMO_CORE_WGSL, CASCADES, HULL_HOLE_LIMIT, HULL_CRATER_LIMIT } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { SHADOW_FRAME } from './wgsl/shadows.js';
import { VESSEL_LIGHTING, CANVAS_OPTICS } from './wgsl/vessel.js';
import { SURFACE_WAVE_SAMPLE } from './wgsl/surface-waves.js';
import { SHIP_FRACTURE_POSE_UPDATE } from './wgsl/ship-fracture.js';
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
import { packCrewCompMask, packCrewFaceW } from './crew-components.js';
import { colonialGroomMask, reconcileColonialGroomAndComp, CREW_ACTOR_FLOATS } from './crew.js';
import { DRESS_MASK_SCALE } from './indigenous-dress.js';
import {
  createCrewContinuumBatch, createCrewContinuumPoser, createCrewContinuumWorldHull, crewContinuumBodyFor, crewContinuumRestPlaces,
  loadCrewContinuumBody, requestCrewContinuumPipelines, requestCrewContinuumPose,
} from './crew-continuum-draw.js';
import { CREW_CONTINUUM_LOOK_WORDS, CREW_CONTINUUM_ORDER_IMPORTANT, CREW_CONTINUUM_PLACED_WGSL, CREW_CONTINUUM_PLACED_WORDS } from './wgsl/crew-continuum.js';
import { bakeTownClips, bakeWorkStationClip } from './town-clips.js';
import { poseSeatedCrew, solveCrewLimb, turnBone } from './crew-pose.js';
import { poseCrewFingers } from './crew-physics.js';
import { sharedNeuralPbrBank } from './neural-pbr.js';
import { withNeuralPbrTradeVessels } from './wgsl/neural-pbr.js';
import { SHIP_CONTINUUM_BODIES, SHIP_CONTINUUM_MATERIAL, SHIP_CONTINUUM_TURN_WGSL, loadShipContinuum, shipContinuumTurn } from './ship-continuum.js';
import { CONTINUUM_KIND, CONTINUUM_DAMAGED, CONTINUUM_IMPORTANT_FLAG, CONTINUUM_HEADER, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, continuumAtlasTypes, continuumRoom } from './continuum-format.js';
import { CONTINUUM_RECORD_WGSL } from './wgsl/continuum-cut.js';
import { SHIP_RIDER_HEADER, SHIP_DRAPED_SAILS, SHIP_DRAPED_OARS, SHIP_DRAPED_BLOCK, SHIP_DRAPED_CANVAS, SHIP_DRAPED_OARED, SHIP_DRAPED_HELM } from './wgsl/ship-kinds.js';
import { requestContinuumPrograms, requestContinuumView, requestContinuumCapture, continuumCaptureDraw, uploadContinuumAtlas, createContinuumScene } from './continuum-scene.js';

export const TRADE_VESSEL_VERTEX_FLOATS = 9; // pos(3), norm(3), material(1), uv(2)
export const TRADE_VESSEL_INSTANCE_FLOATS = 12; // posYaw(4), attitudeScaleArch(4), animSink(4)
export const TRADE_VESSEL_ARCHETYPES = 7; // 0: cog sail, 1: cog moored, 2: carrack sail, 3: carrack moored, 4: river barge, 5: lateen caravel, 6: harbor barque
export const MAX_TRADE_VESSELS = 84;
export const MAX_DECK_STATIONS_PER_VESSEL = 10;

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

// A material's mean linear albedo, for the far body's vertex colours and the splat (scripts/prepare-ship-continuum.mjs).
export function tradeMaterialLinearColor(matId) {
  const m = Math.floor(matId);
  if (m === 9 || m === 13) return [0.82, 0.75, 0.62]; // Baltic canvas
  if (m === 16 || m === 15 || m === 6) return [0.34, 0.25, 0.16]; // decks / spars / oars
  if (m === 2 || m === 12 || m === 19) return [0.36, 0.28, 0.18]; // cordage
  if (m === 3 || m === 4 || m === 8 || m === 11) return [0.16, 0.15, 0.15]; // ironwork / gunwales
  return [0.27, 0.18, 0.11]; // oak hull & castles
}

// Where a vertex of archetype `archIndex` stands in a pose, in design units: the same motion the GPU gives it (the
// DRAPED kind's oar, helm and brail, js/wgsl/ship-kinds.js, and a damaged vessel's rest pose pass), for the continuum's bake to measure each
// cluster's error and bound in every pose a vessel takes. `time` stands for the frame clock (F.camPos.w).
export function poseTradeVesselPoint(archIndex, position, normal, material, uv, { time = 0, phase = 0, motion = 0, furl = 0 } = {}) {
  let [px, py, pz] = position;
  let [nx, ny, nz] = normal;
  const mInt = Math.floor(Math.max(0, material));
  const oarCode = Math.round((material - 16) * 64);
  if (material > 5.5 && mInt === 16 && oarCode >= 1 && archIndex === 4) {
    const station = Math.min(23, oarCode - 1);
    const pivots = bargeOarPivotsForWGSL();
    const pivot = [pivots[station * 4], pivots[station * 4 + 1], pivots[station * 4 + 2]], side = pivots[station * 4 + 3];
    const cyc = motion > 0.035 ? time * 2.15 + phase + (station >> 1) * 0.16 : Math.PI;
    const sweep = Math.sin(cyc) * 0.30, dip = -Math.cos(cyc) * 0.12;
    const scale = getTradeVesselArchetype(4).designScale;
    let d = [px - pivot[0], py - pivot[1], pz - pivot[2]], n = [nx, ny, nz];
    const shaft = [side / scale[0], BARGE_OAR_SLOPE_M / scale[1], 0], shaftLength = Math.hypot(...shaft);
    const u = shaft.map((v) => v / shaftLength);
    const feather = Math.max(0, -Math.cos(cyc)) * 0.65;
    const turn = (v, c, s) => {
      const along = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      return [0, 1, 2].map((k) => u[k] * along + (v[k] - u[k] * along) * c + cross[k] * s);
    };
    if (feather > 0.001) { const c = Math.cos(feather), s = Math.sin(feather) * side; d = turn(d, c, s); n = turn(n, c, s); }
    const cy = Math.cos(sweep * side), sy = Math.sin(sweep * side), cr = Math.cos(dip * side), sr = Math.sin(dip * side);
    const swing = (v) => { const y = [v[0] * cy - v[2] * sy, v[1], v[0] * sy + v[2] * cy]; return [y[0] * cr - y[1] * sr, y[0] * sr + y[1] * cr, y[2]]; };
    const pd = swing(d);
    [px, py, pz] = [pivot[0] + pd[0], pivot[1] + pd[1], pivot[2] + pd[2]];
    [nx, ny, nz] = swing(n);
  } else if (mInt === 28 && motion > 0.05 && (archIndex === 4 || archIndex === 6)) {
    px += Math.sin(time * 1.45 + phase) * 0.075 * Math.min(motion, 1.4);
  }
  const f = Math.min(1, Math.max(0, furl));
  if (f > 0.002 && archIndex !== 1 && archIndex !== 3 && archIndex !== 4 && (mInt === 9 || mInt === 13 || mInt === 19)) {
    const code = Math.min(15, Math.round(Math.max(0, (material - Math.floor(material)) * 64)));
    const rec = getTradeVesselArchetype(archIndex).sailBrailSpecs?.[code];
    if (rec) {
      const nLength = Math.max(Math.hypot(nx, ny, nz), 1e-5);
      const u = Math.min(1, Math.max(0, uv[0])), v = Math.min(1, Math.max(0, uv[1]));
      const gate = Math.min(1, Math.max(0, v * 20));
      const blend = (a, b, t) => a + (b - a) * t;
      const unit = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
      let fold;
      if (rec.isLateen) {
        const brail = Math.min(1, Math.max(0, u + v * 0.34)), sag = (0.045 + 0.085 * Math.sin(brail * Math.PI)) * v;
        const yard = [0, 1, 2].map((k) => blend(rec.peak[k], rec.tack[k], brail) - (k === 1 ? sag : 0));
        const w = f * 0.96 * gate;
        [px, py, pz] = [blend(px, yard[0], w), blend(py, yard[1], w), blend(pz, yard[2], w)];
        fold = unit(0.88, -0.36 * v - 0.08, 0.22 * Math.sin(u * 12.566));
      } else {
        const drop = (0.055 + 0.115 * Math.sin(u * Math.PI)) * v;
        const targetY = Math.min(rec.yardY, rec.yardY - drop), targetZ = rec.yardZ - (0.04 + 0.075 * Math.sin(u * Math.PI)) * v;
        py = blend(py, targetY, f * 0.96 * gate);
        pz = blend(pz, targetZ, f * 0.92 * gate);
        px *= 1 - 0.16 * f * v;
        fold = unit((u - 0.5) * 0.25, -0.48 * v, -0.86);
      }
      const bent = unit(...[nx, ny, nz].map((c, k) => blend(c / nLength, fold[k], f * 0.52 * gate)));
      [nx, ny, nz] = bent.map((c) => c * nLength);
    }
  }
  return { position: [px, py, pz], normal: [nx, ny, nz] };
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
    // Station + 1, so plain material 16 (the rubrails) is never taken for an oar.
    const matId = 16 + (stIdx + 1) / 64;
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

// A damaged vessel's posed assembly, written into her slot of the scene's pose buffer (js/wgsl/ship-kinds.js, RIDER)
// before her fracture pass flies its shards (js/ship-fracture.js): each vertex of her own scarred copy, her oars swept
// through their stroke and her helm swung by her motion on the frame's clock, then her canvas brailed by her furl, as
// the DRAPED kind poses a whole vessel. Every normal keeps its length: past 1 it is the damage the RIDER kind reads.
export const REST_TO_POSED_WGSL = FRAME_WGSL + /* wgsl */ `
struct SourceVertex { px: f32, py: f32, pz: f32, nx: f32, ny: f32, nz: f32, mat: f32, u: f32, v: f32 };
struct PosedVertex { position: vec4f, normal: vec4f };
struct PoseUniform { phase: f32, motion: f32, archetype: f32, furl: f32 };

${buildArchetypeScaleWGSL()}
${buildBargeOarPivotsWGSL()}
${SAIL_BRAIL_WGSL}

@group(0) @binding(0) var<storage, read> srcVerts: array<SourceVertex>;
@group(0) @binding(1) var<storage, read_write> dstPosed: array<PosedVertex>;
@group(0) @binding(2) var<uniform> P: PoseUniform;
@group(0) @binding(3) var<uniform> F: Frame;

// An oar through its stroke about its thole, feathered about its own shaft on the recovery; the helm swung.
fn restPoseRowed(pos: vec3f, norm: vec3f, material: f32, archIdx: u32) -> array<vec3f, 2> {
  var p = pos;
  var n = norm;
  let m = u32(max(0.0, floor(material)));
  let oarCode = round((material - 16.0) * 64.0);
  if (archIdx == 4u && m == 16u && oarCode >= 1.0) {
    let station = min(23u, u32(oarCode) - 1u);
    let piv = BARGE_OAR_PIVOTS[station];
    let side = piv.w;
    let cyc = select(3.14159265, F.camPos.w * 2.15 + P.phase + f32(station >> 1u) * 0.16, P.motion > 0.035);
    let sweep = sin(cyc) * ${BARGE_ROW_SWEEP_RAD.toFixed(4)};
    let dip = -cos(cyc) * ${BARGE_ROW_DIP_RAD.toFixed(4)};
    var d = p - piv.xyz;
    let scBarge = ARCHETYPE_SCALES[4u];
    let uShaft = normalize(vec3f(side / scBarge.x, (${BARGE_OAR_SLOPE_M.toFixed(6)}) / scBarge.y, 0.0));
    let feather = max(0.0, -cos(cyc)) * 0.65;
    if (feather > 0.001) {
      let cf = cos(feather); let sf = sin(feather);
      let dPar = uShaft * dot(uShaft, d);
      d = dPar + (d - dPar) * cf + cross(uShaft, d) * (sf * side);
      let nPar = uShaft * dot(uShaft, n);
      n = nPar + (n - nPar) * cf + cross(uShaft, n) * (sf * side);
    }
    let cy = cos(sweep * side); let sy = sin(sweep * side);
    let dYaw = vec3f(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);
    let cr = cos(dip * side); let sr = sin(dip * side);
    p = piv.xyz + vec3f(dYaw.x * cr - dYaw.y * sr, dYaw.x * sr + dYaw.y * cr, dYaw.z);
    let nYaw = vec3f(n.x * cy - n.z * sy, n.y, n.x * sy + n.z * cy);
    n = vec3f(nYaw.x * cr - nYaw.y * sr, nYaw.x * sr + nYaw.y * cr, nYaw.z);
  } else if (m == 28u && P.motion > 0.05 && (archIdx == 4u || archIdx == 6u)) {
    p.x += sin(F.camPos.w * 1.45 + P.phase) * 0.075 * min(P.motion, 1.4);
  }
  return array<vec3f, 2>(p, n);
}

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  if (idx >= arrayLength(&srcVerts) || idx >= arrayLength(&dstPosed)) { return; }
  let sv = srcVerts[idx];
  let archIdx = min(${TRADE_VESSEL_ARCHETYPES - 1}u, u32(max(0.0, round(P.archetype))));
  let rowed = restPoseRowed(vec3f(sv.px, sv.py, sv.pz), vec3f(sv.nx, sv.ny, sv.nz), sv.mat, archIdx);
  let brailed = animateTradeSailBrail(rowed[0], rowed[1], sv.mat, vec2f(sv.u, sv.v), P.furl, archIdx);
  dstPosed[idx].position = vec4f(brailed[0], 0.0);
  dstPosed[idx].normal = vec4f(brailed[1], 0.0);
}
`;

// ============================================================================
// The trade vessels' material in the one continuum's pipeline family (js/wgsl/continuum-cut.js)
// ============================================================================
// Every trade vessel is one record of one scene of the one cut (js/continuum-scene.js), of the type her archetype's
// body is (js/ship-continuum.js). Whole, the DRAPED kind poses her from her record's spare words (phase, motion, furl);
// damaged, the RIDER kind carries her clusters on her own posed assembly in her slot of the scene's pose buffer, which
// her rest pose pass and her fracture pass write, and the cut draws her clusters alone. This is only how her surface is
// worn and lit: oak, pitch, iron, hemp and canvas where her clusters are drawn, her far body's and her splat's own
// colour beyond them, her scars from her slot's hull damage, and what shot has holed, parted or torn taken out of her
// samples by the material's mask (rule 2: no discard).
export const TRADE_VESSEL_DAMAGED_SLOTS = 16;

// Group 0: the frame, the sky's light and the land's shadow set, as the near terrain binds them. Group 1 (in the
// material's own text): the oak, the damaged slots' hull damage and the neural material bank. Group 2: the scene.
const tradeVesselContinuumPreludeWGSL = () => FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + SHADOW_FRAME + VESSEL_LIGHTING + CANVAS_OPTICS + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;
`;

const tradeVesselContinuumRawWGSL = () => /* wgsl */ `
@group(1) @binding(0) var oakAlbedo: texture_2d<f32>;
@group(1) @binding(1) var oakSampler: sampler;
struct HullCrater { at: vec3f, packed: u32 };
struct HullDamage {
  scale: vec4f,
  level: vec4f,
  holes: array<vec4f, ${HULL_HOLE_LIMIT}>,
  flows: array<vec4f, ${HULL_HOLE_LIMIT}>,
  craters: array<HullCrater, ${HULL_CRATER_LIMIT}>,
};
// Each damaged slot's hull damage (js/hull-flood.js), one HULL_DAMAGE_UNIFORM_BYTES apart.
@group(1) @binding(2) var<storage, read> hullDamage: array<HullDamage, ${TRADE_VESSEL_DAMAGED_SLOTS}>;

${buildArchetypeScaleWGSL()}

// What a corner of a vessel hands her fragments: where it stands on her at rest, in design units, and its normal
// there; its material, UV and damage; her archetype, her damaged slot (0 when whole) and scale; her turn; and the far
// body's or the splat's own colour (sqrt-encoded rgb8: the far body's in its triangle's word, the splat's in her type's
// material block).
fn tradeVesselContinuumVarying(s: ContinuumSurface, v: ptr<function, ContinuumVarying>) {
  let designScale = max(vec3f(continuumTypeF(s.model, ${SHIP_CONTINUUM_MATERIAL.designScale}u), continuumTypeF(s.model, ${SHIP_CONTINUUM_MATERIAL.designScale + 1}u), continuumTypeF(s.model, ${SHIP_CONTINUUM_MATERIAL.designScale + 2}u)), vec3f(1e-4));
  let pointed = s.vertex != CONTINUUM_NO_VERTEX;
  let rides = select(0u, shipRiderVertex(s.vertex), pointed);
  let ridden = continuumPointAt(s.model, rides);
  let material = select(0.0, bitcast<f32>(ridden.word), pointed);
  (*v).local = select(s.local, ridden.position, pointed) / designScale;
  let unturned = continuumQuat(vec4f(-s.record.turn.xyz, s.record.turn.w), s.normal);
  (*v).normalLocal = normalize(unturned * designScale + vec3f(0.0, 1e-6, 0.0));
  (*v).uv = select(vec2f(0.5), continuumUV(rides), pointed);
  (*v).state = vec2f(s.wear, material);
  let slot = u32(max(bitcast<f32>(s.record.spare.x), 0.0)) >> 16u;
  (*v).ids = vec4u(u32(max(0.0, floor(material))), min(s.model, ${TRADE_VESSEL_ARCHETYPES - 1}u), slot, bitcast<u32>(max(s.record.place.w, 0.25)));
  (*v).turn = s.record.turn;
  let word = select(continuumType(s.model, ${SHIP_CONTINUUM_MATERIAL.splat}u), s.word, s.what == CONTINUUM_FAR_ENTRY);
  let colour = vec3f(f32(word & 255u), f32((word >> 8u) & 255u), f32((word >> 16u) & 255u)) / 255.0;
  (*v).colour = colour * colour;
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

// A damaged slot's shot holes about a point at rest (design units): below 0 inside one, else how near its rim.
fn hullHoleRim(slot: u32, p: vec3f) -> f32 {
  var rim = 0.0;
  let metres = p * hullDamage[slot].scale.xyz;
  let holes = min(u32(hullDamage[slot].scale.w), ${HULL_HOLE_LIMIT}u);
  for (var i = 0u; i < holes; i++) {
    let hole = hullDamage[slot].holes[i];
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

// Her clusters' surface, as her parts are built: shaded wherever she is drawn, and kept where her clusters are.
fn tvShadeFragment(in: ContinuumVarying, front: bool) -> vec4f {
  let stateVal = in.state.x;
  let rawMat = in.state.y;
  let aIdx = min(in.ids.y, ${TRADE_VESSEL_ARCHETYPES - 1}u);
  let sc4 = ARCHETYPE_SCALES[aIdx];
  let draftRatio = max(sc4.w, 0.4);
  let tvTurn = in.turn;
  let tvEye = continuumEye();
  let tvScaleMul = bitcast<f32>(in.ids.w);
  let tvScaleMetres = sc4.xyz * tvScaleMul;
  let p = in.local;
  let tvMetres = p * tvScaleMetres;
  let tvNpbrMarker = 1;
  let matFrac = fract(rawMat);
  let m = in.ids.x;
  let isLusoria = aIdx == 4u;
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
    n = normalize(nBase + continuumQuat(tvTurn, vec3f(0.0, twistTilt, twistTilt * 0.5)));
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

  let tvSlot = in.ids.z;
  if (tvSlot > 0u) {
    let slot = min(tvSlot - 1u, ${TRADE_VESSEL_DAMAGED_SLOTS - 1}u);
    let holeRim = select(0.0, max(hullHoleRim(slot, p), 0.0), isWoodMat(m) && u32(hullDamage[slot].scale.w) > 0u);
    if (holeRim > 0.0) {
      let splinter = 0.58 + 0.85 * gnoise(vec2f(p.z * 90.0, p.y * 140.0));
      albedo = mix(albedo, vec3f(0.45, 0.32, 0.19) * splinter, holeRim);
      rough = mix(rough, 0.96, holeRim);
      metal *= (1.0 - holeRim);
    }
    let craterCount = min(u32(hullDamage[slot].level.w), ${HULL_CRATER_LIMIT}u);
    if (craterCount > 0u && isWoodMat(m)) {
      var scorch = 0.0;
      for (var ci = 0u; ci < craterCount; ci++) {
        let cr = hullDamage[slot].craters[ci];
        let crRad = max(0.06, f32(cr.packed & 0xFFFu) / 4000.0);
        let dCr = length((p - cr.at) * vec3f(0.85, 1.15, 1.0));
        scorch = max(scorch, 1.0 - smoothstep(crRad * 0.45, crRad * 2.2 + 0.12, dCr));
      }
      albedo = mix(albedo, vec3f(0.032, 0.025, 0.020), scorch * 0.88);
      rough = mix(rough, 0.98, scorch);
    }
  }
  if (stateVal > 0.04) {
    let charMix = clamp(stateVal * 0.58, 0.0, 0.82);
    albedo = mix(albedo, vec3f(0.045, 0.035, 0.026), charMix);
    rough = max(rough, 0.92);
  }

  let sunDir = normalize(F.sunDir.xyz);
  let viewDir = normalize(tvEye - in.world);
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
  return vec4f(continuumAir(lit, in.world), 1.0);
}

// The far body and the splat: their own colour, lit as the vessel is. A splat faces the eye whichever way it is wound.
fn tvFarShade(in: ContinuumVarying, front: bool) -> vec4f {
  let n = normalize(in.normal) * select(select(-1.0, 1.0, front), 1.0, in.coverage.x == CONTINUUM_SPLAT_ENTRY);
  let farSun = normalize(F.sunDir.xyz);
  let farView = normalize(continuumEye() - in.world);
  let sunRad = sunIlluminance() * solarShadowVisibility(vec3f(tradeShadowVis(in.world, n)));
  let nDotL = max(dot(n, farSun), 0.0);
  let skyCol = skyAtmo(normalize(vec3f(n.x * 0.35, max(n.y, 0.14), n.z * 0.35)));
  let seaCol = skyAtmo(vec3f(0.0, 0.25, 0.0)) * 0.45 + F.waterCol.rgb * 0.65;
  let amb = vesselAmbient(n, skyCol, seaCol);
  let rough = 0.86;
  let f0 = vec3f(0.04);
  let direct = (in.colour / PI) * sunRad * nDotL;
  let spec = select(vec3f(0.0), vesselSpecular(n, farView, farSun, rough, f0) * sunRad * nDotL, nDotL > 0.0);
  let envSpec = textureSampleLevel(envCube, sampC, reflect(-farView, n), rough * 7.0).rgb * vesselEnvironment(n, farView, rough, f0) * 0.28;
  return vec4f(continuumAir(in.colour * amb * 0.82 + direct + spec + envSpec, in.world), 1.0);
}

// Both shades in uniform control flow (the clusters' samples the oak and takes derivatives), the one drawn chosen.
fn tradeVesselContinuumShade(in: ContinuumVarying, front: bool) -> vec4f {
  let near = tvShadeFragment(in, front);
  let far = tvFarShade(in, front);
  return select(near, far, in.coverage.x != CONTINUUM_CLUSTER_ENTRY);
}

// The samples a damaged vessel's clusters keep: none where shot has holed her timber, parted her rope or torn her canvas.
fn tradeVesselContinuumMask(in: ContinuumVarying, front: bool) -> u32 {
  let tvSlot = in.ids.z;
  if (tvSlot == 0u || in.coverage.x != CONTINUUM_CLUSTER_ENTRY) { return 0xffffffffu; }
  let slot = min(tvSlot - 1u, ${TRADE_VESSEL_DAMAGED_SLOTS - 1}u);
  let m = in.ids.x;
  let dmg = in.state.x;
  if (isWoodMat(m) && hullHoleRim(slot, in.local) < 0.0) { return 0u; }
  if (isRopeMat(m) && ropeParted(in.local, dmg)) { return 0u; }
  if (isSailMat(m) && dmg > 0.04 && canvasTearMask(in.uv, in.local, m, dmg) > 0.0) { return 0u; }
  return 0xffffffffu;
}
`;

// The trade vessels' material (js/wgsl/continuum-cut.js), its view drawn by requestContinuumView and, under water, its
// capture by requestContinuumCapture. Its shading is composed once, the neural material bank's evaluation laid into it
// (js/wgsl/neural-pbr.js withNeuralPbrTradeVessels).
let tradeVesselContinuumShading = null;
export const TRADE_VESSEL_CONTINUUM_MATERIAL = Object.freeze({
  name: 'tradeVesselContinuum', prelude: tradeVesselContinuumPreludeWGSL, core: false, data: Object.freeze({ group: 2, binding: 0 }),
  varyings: [['local', 'vec3f'], ['normalLocal', 'vec3f'], ['uv', 'vec2f'], ['state', 'vec2f'], ['colour', 'vec3f'], ['ids', 'vec4u', true], ['turn', 'vec4f', true]],
  wgsl: () => (tradeVesselContinuumShading ??= withNeuralPbrTradeVessels(tradeVesselContinuumRawWGSL())),
  salt: 5,
  // Sails, awnings and planking are open shells, lit from whichever side is seen.
  cullMode: 'none', air: true, capture: true, mask: true,
});

// Each archetype's DRAPED block (js/wgsl/ship-kinds.js), SHIP_DRAPED_BLOCK + 1 vec4f an archetype in archetype order:
// her design scale and what moves on her; a row unread; her sixteen sails' yard rows (-1: none; 0: square, its yard's
// y and z and its foot's y; 1: lateen, its peak) and their tack rows (a lateen's tack); the barge's twenty-four oar
// pivots (x, y, z, side); and the stroke (sweep, dip, the oar's slope in metres).
export function tradeVesselDrapedBlocks() {
  const rows = SHIP_DRAPED_BLOCK + 1, out = new Float32Array(TRADE_VESSEL_ARCHETYPES * rows * 4);
  const pivots = bargeOarPivotsForWGSL();
  for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
    const arch = getTradeVesselArchetype(a), at = a * rows * 4, specs = arch.sailBrailSpecs || {};
    const moves = (a === 1 || a === 3 || a === 4 ? 0 : SHIP_DRAPED_CANVAS) | (a === 4 ? SHIP_DRAPED_OARED : 0) | (a === 4 || a === 6 ? SHIP_DRAPED_HELM : 0);
    out.set([arch.designScale[0], arch.designScale[1], arch.designScale[2], moves], at);
    for (let s = 0; s < SHIP_DRAPED_SAILS; s++) {
      const rec = specs[s], sail = at + (2 + s) * 4, tack = at + (2 + SHIP_DRAPED_SAILS + s) * 4;
      if (!rec) out[sail] = -1;
      else if (rec.isLateen) { out.set([1, rec.peak[0], rec.peak[1], rec.peak[2]], sail); out.set([1, rec.tack[0], rec.tack[1], rec.tack[2]], tack); }
      else out.set([0, rec.yardY, rec.yardZ, rec.footY], sail);
    }
    out.set(pivots.subarray(0, SHIP_DRAPED_OARS * 4), at + (2 + SHIP_DRAPED_SAILS * 2) * 4);
    out.set([BARGE_ROW_SWEEP_RAD, BARGE_ROW_DIP_RAD, BARGE_OAR_SLOPE_M, 0], at + SHIP_DRAPED_BLOCK * 4);
  }
  return out;
}

const TRADE_SHARED_TYPES_WGSL = /* wgsl */ `
struct TradeNearDomain { domain: vec4f, grid: vec4f };
struct TradeInstance {
  posYaw: vec4f,
  attScaleArch: vec4f,
  animSink: vec4f,
};
`;

// ============================================================================
// GPU Multi-Point Ocean & River Wave Buoyancy Compute Pass (Zero CPU Readbacks)
// ============================================================================
// Each vessel's heave, pitch and roll are stood into her continuum record (her place's height and her turn) and her
// deck crew's instance, so neither the cut nor the crew waits on the CPU for her pose.
export const TRADE_VESSEL_WAVE_WGSL = FRAME_WGSL + SURFACE_WAVE_SAMPLE + TRADE_SHARED_TYPES_WGSL + CONTINUUM_RECORD_WGSL + SHIP_CONTINUUM_TURN_WGSL + /* wgsl */ `
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
@group(0) @binding(5) var<storage, read_write> vesselRecords: array<ContinuumRecord>;
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

  if (intactSlot < maxSlots && intactSlot < arrayLength(&vesselRecords)) {
    vesselRecords[intactSlot].place.y = st.pose.x;
    vesselRecords[intactSlot].turn = shipContinuumTurn(yaw, st.pose.y, st.pose.z);
  }
  if (crewSlot < maxSlots && crewSlot < arrayLength(&crewInstances)) {
    crewInstances[crewSlot].posYaw.y = st.pose.x;
    crewInstances[crewSlot].attScaleArch.x = st.pose.y;
    crewInstances[crewSlot].attScaleArch.y = st.pose.z;
  }
}
`;

// ============================================================================
// Deck hands, placed on the GPU and drawn through the people continuum (AGENTS.md rule 3)
// ============================================================================
// Each soul at a vessel's deck station is placed each frame by one compute pass, from the vessel's pose on the GPU
// and the station's clip, as a CrewPlaced record (js/wgsl/crew-continuum.js) compacted by the body they wear. The
// continuum's pose pass, cut and draws do the rest, as for the townsfolk; nothing on the CPU touches them a frame.
// Bodies a ship may carry: hands of either sex, captains and factors, and the paddlers of an island canoe.
const DECK_CREW_BODY_LIMIT = 8;
// Each body's run of slots begins where a bind group may (256 bytes of joints and actors).
const DECK_CREW_SLOT_ALIGNMENT = 16;
// The counts the placing pass keeps: each body's indirect dispatch (count, 1, 1, unused).
export const DECK_CREW_DISPATCH_WORDS = 4;
export const DECK_CREW_COUNT_WORDS = DECK_CREW_BODY_LIMIT * DECK_CREW_DISPATCH_WORDS;
// A station: where on the deck and which way (4 floats), what it does (4 words), and who stands there (4 words).
export const DECK_CREW_STATION_WORDS = 12;
// The pass's uniform: its counts (4 words), and each body's first slot, room, and work clip (4 words each).
export const DECK_CREW_CONFIG_BYTES = 16 + DECK_CREW_BODY_LIMIT * 16;
// Moisture slots the drawing reads (four): dry but for the rain.
const DECK_CREW_MOISTURE_SLOTS = 4;
const DECK_CREW_LOOK_WORDS = CREW_CONTINUUM_LOOK_WORDS;
const DECK_CREW_MAX_TOTAL = MAX_TRADE_VESSELS * MAX_DECK_STATIONS_PER_VESSEL;
const DECK_CREW_JOINT_FLOATS = CREW_JOINT_COUNT * 16;
const DECK_CREW_JOINT_BYTES = CREW_JOINT_COUNT * 64;
const DECK_CREW_ACTOR_BYTES = CREW_ACTOR_FLOATS * 4;
const DECK_CREW_PLACED_BYTES = CREW_CONTINUUM_PLACED_WORDS * 4;

// The body a soul at a station wears: captains, and factors who are men, the captain's; island paddlers their own pair.
export function deckCrewBodyFor(role, female) {
  return crewContinuumBodyFor({
    sex: female ? 'female' : 'male',
    role: role === 'captain' || (role === 'merchant' && !female) ? 'captain' : 'hand',
    culture: role === 'paddler' ? 'caribbean' : null,
  });
}

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
      if (Math.floor(m) === 16 && Math.round((m - 16) * 64) === stIdx + 1) {
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

// The pass that places every deck hand, and the one that empties its counts before it. One module, two entry points.
export const DECK_CREW_PLACE_WGSL = FRAME_WGSL + SHADOW_FRAME + TRADE_SHARED_TYPES_WGSL + CREW_CONTINUUM_PLACED_WGSL + /* wgsl */ `
struct DeckCrewConfig {
  ctrl: vec4u,                                    // vessels, stations a vessel, bodies, looks
  runs: array<vec4u, ${DECK_CREW_BODY_LIMIT}>,    // each body's first slot, room, and work clip's first frame and length
};
struct DeckStation {
  localPosYaw: vec4f, // metres on the deck, and the way they face
  work: vec4u,        // active | body << 1 | clip << 4, the clip's first frame | its length << 16, look, phase (f32 bits)
  who: vec4u,         // identity, unused, unused, unused
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> nearTerrain: TradeNearDomain;
@group(0) @binding(2) var<uniform> deckCfg: DeckCrewConfig;
@group(0) @binding(3) var<storage, read> srcInstances: array<TradeInstance>;
@group(0) @binding(4) var<storage, read> stations: array<DeckStation>;
@group(0) @binding(5) var<storage, read_write> placed: array<CrewPlaced>;
@group(0) @binding(6) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(7) var<uniform> landSH: ShadowFrame;
@group(0) @binding(8) var<storage, read_write> moisture: array<vec2f>;

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

@compute @workgroup_size(${DECK_CREW_BODY_LIMIT}) fn deckCrewReset(@builtin(local_invocation_index) body: u32) {
  atomicStore(&counts[body * ${DECK_CREW_DISPATCH_WORDS}u], 0u);
}

@compute @workgroup_size(64) fn deckCrewPlace(@builtin(global_invocation_id) id: vec3u) {
  // Rain and sleet wet them, as they do the townsfolk; nothing else the frame carries does.
  if (id.x == 0u) {
    let rain = clamp(F.reserved.x, 0.0, 1.0) * select(0.0, 1.0, F.reserved.y < 0.5 || (F.reserved.y > 1.5 && F.reserved.y < 2.5));
    for (var i = 0u; i < ${DECK_CREW_MOISTURE_SLOTS}u; i++) { moisture[i] = vec2f(rain * 0.65, rain * 0.75); }
  }
  let vesselSlot = id.x / max(deckCfg.ctrl.y, 1u);
  if (vesselSlot >= deckCfg.ctrl.x) { return; }
  let st = stations[id.x];
  let flags = st.work.x;
  if ((flags & 1u) == 0u) { return; }

  let inst = srcInstances[vesselSlot];
  let yaw = inst.posYaw.w;
  let pitch = inst.attScaleArch.x;
  let roll = inst.attScaleArch.y;
  let scaleMul = max(inst.attScaleArch.z, 0.25);
  let shipWorld = inst.posYaw.xyz + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  let body = min((flags >> 1u) & 7u, ${DECK_CREW_BODY_LIMIT - 1}u);
  let clipKind = (flags >> 4u) & 7u;
  let isSeated = clipKind >= 4u;

  // Where they stand, carried with the vessel. The station scales with the hull; an adult never does.
  let crewBodyScale = 1.0;
  let cY = cos(st.localPosYaw.w);
  let sY = sin(st.localPosYaw.w);
  let origin = shipWorld + rotateDeckShip(st.localPosYaw.xyz * scaleMul, yaw, pitch, roll);
  let transform = mat4x4f(
    vec4f(rotateDeckShip(vec3f(cY, 0.0, -sY), yaw, pitch, roll) * crewBodyScale, 0.0),
    vec4f(rotateDeckShip(vec3f(0.0, 1.0, 0.0), yaw, pitch, roll) * crewBodyScale, 0.0),
    vec4f(rotateDeckShip(vec3f(sY, 0.0, cY), yaw, pitch, roll) * crewBodyScale, 0.0),
    vec4f(origin, 1.0),
  );

  // Kept if in sight, or near enough to cast a shadow into it.
  let centre = origin + transform[1].xyz * select(0.87, 0.64, isSeated);
  let toCam = centre - F.camPos.xyz;
  var kept = false;
  if (landSH.origin.w > 0.5 && length(toCam) < 360.0) {
    let shP = landSH.lightView * vec4f(centre - landSH.origin.xyz, 1.0);
    kept = abs(shP.x) <= 1.12 && abs(shP.y) <= 1.12 && shP.z >= -0.15 && shP.z <= 1.12;
  }
  let clip = F.viewProj * vec4f(earthCurve(toCam, F.camPos.y), 1.0);
  let tanX = max(length(F.camRight.xyz), 0.15);
  let tanY = max(length(F.camUp.xyz), 0.15);
  let wEff = max(clip.w, 1.0);
  kept = kept || !(clip.w < -1.6 || abs(clip.x) > wEff * 1.16 + 1.4 / tanX || abs(clip.y) > wEff * 1.16 + 1.4 / tanY);
  if (!kept) { return; }

  // The station's clip: oarsmen and paddlers pull with the vessel's stroke, and rest when it does not row.
  let clipFirst = st.work.y & 0xFFFFu;
  let clipLen = max(1u, st.work.y >> 16u);
  let phase = bitcast<f32>(st.work.w);
  var cycle = fract(F.camPos.w * 0.42 + phase);
  if (isSeated) {
    cycle = select(0.5, fract((F.camPos.w * 2.15 + inst.animSink.x + phase) / 6.2831853), inst.animSink.y > 0.035);
  }
  let exact = clamp(cycle * f32(clipLen), 0.0, max(0.0, f32(clipLen) - 1e-3));
  let f0 = min(u32(exact), clipLen - 1u);
  let f1 = (f0 + 1u) % clipLen;
  // Those standing lean into the work as the deck rolls under them; those already at it, and the seated, do not.
  let run = deckCfg.runs[body];
  let brace = select(clamp((abs(roll) - 0.14) * 2.2, 0.0, 0.45), 0.0, isSeated || clipKind == 1u);
  let braceLen = max(run.w, 1u);
  let braceFrame = run.z + u32(fract(F.camPos.w * 0.38 + phase) * f32(braceLen)) % braceLen;

  let rank = atomicAdd(&counts[body * ${DECK_CREW_DISPATCH_WORDS}u], 1u);
  if (rank >= run.y) { return; }
  // The people of a vessel taking water are cut finer, as anything damaged is.
  let important = select(0u, ${CREW_CONTINUUM_ORDER_IMPORTANT}u, inst.animSink.z > 0.001);
  placed[run.x + rank] = CrewPlaced(
    transform,
    vec4u(clipFirst + f0, clipFirst + f1, braceFrame, st.work.z),
    vec4f(fract(exact), brace, 0.0, 0.0),
    vec4u(st.who.x, 0u, important, 0u),
  );
}
`;

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

// Every trade vessel is drawn through the one continuum (AGENTS.md rule 3): one scene of the one cut, cut by the select
// and cast by the shadow program every family shares, its view (and its capture under water) composed from the
// vessels' material. Asked early, the programs are ready when the vessels are.
export function requestTradeVesselsPipelines({
  device,
  shader,
  format = 'rgba16float',
  samples = 1,
  shadowFormat = 'depth32float',
} = {}) {
  if (!device || !shader) return Promise.resolve(null);
  return Promise.all([
    requestContinuumPrograms({ device, shader, shadowFormat }),
    requestContinuumView({ device, shader, material: TRADE_VESSEL_CONTINUUM_MATERIAL, format, samples }),
  ]).then(([programs, view]) => ({ programs, view }));
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
  fetchAsset = fetch,
} = {}) {
  if (!device || !shader || !resources) return null;

  let destroyed = false;
  let lastContext = null;
  let contextRiverAt = null;

  const archs = inspectTradeVesselArchetypes();
  // Each archetype's body, baked offline from this same assembly (scripts/prepare-ship-continuum.mjs), in archetype
  // order: an instance's archetype is its body. Nothing is drawn until every body is here.
  const shipBodyIds = SHIP_CONTINUUM_BODIES.filter((b) => b.family === 'trade').sort((a, b) => a.archetype - b.archetype).map((b) => b.id);
  const shipDataPromise = loadShipContinuum({ ids: shipBodyIds, sources: shipBodyIds.map((_, a) => archs[a]), label: 'trade vessel continuum', fetchAsset });

  // The deck crew's instances: each vessel's pose as the wave pass leaves it, for the crew's placing pass.
  const NEAR_SLICE_BYTES = MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS * 4;
  const U_VERTEX = GPUBufferUsage.VERTEX ?? 32;
  const U_INDEX = GPUBufferUsage.INDEX ?? 16;
  const U_UNIFORM = GPUBufferUsage.UNIFORM ?? 64;
  const U_STORAGE = GPUBufferUsage.STORAGE ?? 128;
  const U_INDIRECT = GPUBufferUsage.INDIRECT ?? 256;
  const U_COPY_DST = GPUBufferUsage.COPY_DST ?? 8;
  const U_COPY_SRC = GPUBufferUsage.COPY_SRC ?? 4;

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

  const wavePromise = canCompute
    ? getPipelineEntry(device, `wave:${Boolean(computePipe)}`, () => Promise.resolve(makeCompute(TRADE_VESSEL_WAVE_WGSL, 'trade vessel wave hydro')))
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

  const [pipes, wavePipe, shipData, resolvedSurfaceWaves, resolvedWaterOptics] = await Promise.all([
    requestTradeVesselsPipelines({ device, shader, format, samples, shadowFormat }),
    wavePromise,
    shipDataPromise,
    surfaceWavesPromise,
    waterOpticsPromise,
  ]);
  // Seen from under the water, a vessel is her coarse cut (the shadow map's lists) through the water's own capture.
  const capture = await requestContinuumCapture(resolvedWaterOptics?.capture ? resolvedWaterOptics : null, TRADE_VESSEL_CONTINUUM_MATERIAL).catch((err) => {
    console.warn('[trade-vessels submerged]', err);
    return null;
  });
  if (destroyed) {
    for (const b of [waveParamsBuffer, vesselWaveInputBuffer, vesselHydroStateBuffer, swUniformFallbackBuffer]) b.destroy();
    seaDispFallbackTex.destroy();
    swFallbackTex.destroy();
    oakFallback.tex.destroy();
    return null;
  }
  const { programs, view } = pipes;

  // The trade bodies' atlas, type a being archetype a; and each body's bounding radius (metres at scale 1), which a
  // damaged vessel's flying shards reach beyond.
  const atlasWords = shipData.words;
  const atlas = { buffer: uploadContinuumAtlas(device, atlasWords, 'trade vessel'), types: continuumAtlasTypes(atlasWords) };
  const atlasFloats = new Float32Array(atlasWords.buffer, atlasWords.byteOffset, atlasWords.length);
  const typeRadius = atlas.types.map((_, t) => atlasFloats[atlasWords[CONTINUUM_HEADER.typesAt] + t * CONTINUUM_TYPE_WORDS + CONTINUUM_TYPE.sphere + 3]);

  // The scene's pose buffer (js/wgsl/ship-kinds.js): each archetype's DRAPED block, then each damaged slot's RIDER header
  // (where her posed assembly begins and its stride; her design scale), then each slot's posed assembly, each run
  // 256-aligned so her rest pose and fracture passes bind it alone.
  const drapedRows = SHIP_DRAPED_BLOCK + 1;
  const headersAt = TRADE_VESSEL_ARCHETYPES * drapedRows;
  const align256 = (bytes) => Math.ceil(bytes / 256) * 256;
  const slotsAt = align256((headersAt + TRADE_VESSEL_DAMAGED_SLOTS * SHIP_RIDER_HEADER) * 16);
  const slotBytes = align256(Math.max(1, ...shipData.assemblies.map((a) => a?.vertexCount ?? 0)) * 32);
  const poses = device.createBuffer({ label: 'trade vessel poses', size: slotsAt + TRADE_VESSEL_DAMAGED_SLOTS * slotBytes, usage: U_STORAGE | U_COPY_DST });
  device.queue.writeBuffer(poses, 0, tradeVesselDrapedBlocks());
  const riderHeaders = new Float32Array(TRADE_VESSEL_DAMAGED_SLOTS * SHIP_RIDER_HEADER * 4);
  for (let k = 0; k < TRADE_VESSEL_DAMAGED_SLOTS; k++) riderHeaders.set([(slotsAt + k * slotBytes) / 16, 2, 0, 0, 1, 1, 1, 0], k * SHIP_RIDER_HEADER * 4);
  device.queue.writeBuffer(poses, headersAt * 16, riderHeaders);
  // Each damaged slot's hull damage (js/hull-flood.js), which her material scars and holes her by.
  const hullDamageBuffer = device.createBuffer({ label: 'trade vessel hull damage', size: TRADE_VESSEL_DAMAGED_SLOTS * HULL_DAMAGE_UNIFORM_BYTES, usage: U_STORAGE | U_COPY_DST });

  // One scene of the one cut holds every vessel, each list's room as any mix of the archetypes may fill it.
  const { room } = continuumRoom(atlas.types, atlas.types.map(() => MAX_TRADE_VESSELS));
  const bufferOf = (curResources, binding) => curResources.find(([b]) => b === binding)?.[1]?.buffer ?? null;
  const makeScene = (curResources) => createContinuumScene({
    device, atlas, programs, capacity: MAX_TRADE_VESSELS, room, view, poses,
    frame: bufferOf(curResources, 0), shadowUniform: bufferOf(curResources, 19), samples, label: 'trade vessel',
  });
  let scene = makeScene(resources);
  let sceneFrame = bufferOf(resources, 0), sceneShadow = bufferOf(resources, 19);
  // The records the scene last sent, which its cut reads.
  let sentIntact = 0;

  // The material's groups: the frame, the sky's light and the land's shadow set (0); the oak, the damaged slots' hull
  // damage and the neural material bank (1). The scene binds its own (2).
  const SEEN_BINDINGS = [0, 1, 2, 3, 4, 19, 20, 21];
  const neuralPbr = sharedNeuralPbrBank(device, { autoLoad: typeof location !== 'undefined' });
  const seenEntries = (curResources) => {
    const byBinding = new Map(curResources);
    return SEEN_BINDINGS.map((binding) => ({ binding, resource: byBinding.get(binding) }));
  };
  const group1For = (pipeline) => device.createBindGroup({
    layout: pipeline.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: oakView },
      { binding: 1, resource: oakSampler },
      { binding: 2, resource: { buffer: hullDamageBuffer } },
      ...neuralPbr.vesselBindings(3, 4),
    ],
  });
  let sceneGroup = null, shadeGroup = null, under = null;
  const regroup = () => {
    const entries = seenEntries(resources);
    sceneGroup = device.createBindGroup({ label: 'trade vessel continuum', layout: view.pipeline.getBindGroupLayout(0), entries });
    shadeGroup = group1For(view.pipeline);
    under = continuumCaptureDraw(capture, entries, { bind: group1For });
  };
  regroup();

  // ==========================================================================
  // Deck hands: the stations and looks the placing pass reads, and the counts it keeps
  // ==========================================================================
  const CREW_LOOK_CAP = Math.max(64, DECK_CREW_MAX_TOTAL);
  const deckConfigBuf = new ArrayBuffer(DECK_CREW_CONFIG_BYTES);
  const deckConfigU32 = new Uint32Array(deckConfigBuf);
  const crewStationsBuf = new ArrayBuffer(DECK_CREW_MAX_TOTAL * DECK_CREW_STATION_WORDS * 4);
  const crewStationsF32 = new Float32Array(crewStationsBuf);
  const crewStationsU32 = new Uint32Array(crewStationsBuf);
  const crewLooksF32 = new Float32Array(CREW_LOOK_CAP * DECK_CREW_LOOK_WORDS);
  const crewSrcInstancesScratch = new Float32Array(MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS);

  const crewConfigBuffer = device.createBuffer({ label: 'trade deck crew config', size: DECK_CREW_CONFIG_BYTES, usage: U_UNIFORM | U_COPY_DST });
  const crewSrcInstancesBuffer = device.createBuffer({ label: 'trade deck crew src instances', size: NEAR_SLICE_BYTES, usage: U_STORAGE | U_COPY_DST });
  const crewStationsBuffer = device.createBuffer({ label: 'trade deck crew stations', size: crewStationsBuf.byteLength, usage: U_STORAGE | U_COPY_DST });
  const crewLooksBuffer = device.createBuffer({ label: 'trade deck crew looks', size: crewLooksF32.byteLength, usage: U_STORAGE | U_COPY_DST });
  // INDIRECT: each body's pose pass and cut are dispatched from it, and its old body drawn. COPY_SRC: read back by tests.
  const crewCountsBuffer = device.createBuffer({ label: 'trade deck crew counts', size: DECK_CREW_COUNT_WORDS * 4, usage: U_STORAGE | U_INDIRECT | U_COPY_DST | U_COPY_SRC });
  const crewMoistureBuffer = device.createBuffer({ label: 'trade deck crew moisture', size: DECK_CREW_MOISTURE_SLOTS * 8, usage: U_STORAGE });

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
        { binding: 5, resource: { buffer: scene.records } },
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

  // What the people continuum draws deck hands with (setPeople: the scene's frame, lights and shadow set), the crew's
  // shared assets (the painted faces' picture and its sampler), and this device's deck-crew programs.
  let deckDrawing = null;
  let deckShared = null;
  let deckPrograms = null;
  let deckProgramsAsked = null;
  // Each continuum body by id once fetched: null while it comes, false if it cannot be had (its people are not drawn).
  const deckBodies = new Map();
  // Each rig's deck clips and rest places, baked once.
  const deckRigs = new Map();
  const deckOwned = [];
  let deckHull = null;
  // The company drawn: each body's run of slots, its buffers, batches and passes. Laid again when the runs change.
  let deckCompany = null;
  let activeCrewVessels = 0;
  let activeDeckSoulCount = 0;
  let crewStationsDirty = true;
  let crewEncoded = false;

  const deckOwnedBuffer = (label, data, usage) => {
    const buf = device.createBuffer({ label, size: Math.max(16, data.byteLength), usage: usage | U_COPY_DST });
    device.queue.writeBuffer(buf, 0, data);
    deckOwned.push(buf);
    return buf;
  };
  const requestDeckCrewPrograms = () => getPipelineEntry(device, `deckCrew:${format}:${samples}`, async () => {
    const module = await shader(DECK_CREW_PLACE_WGSL, 'trade deck crew place');
    const [place, reset, pose, continuum] = await Promise.all([
      device.createComputePipelineAsync({ label: 'trade deck crew place', layout: 'auto', compute: { module, entryPoint: 'deckCrewPlace' } }),
      device.createComputePipelineAsync({ label: 'trade deck crew reset', layout: 'auto', compute: { module, entryPoint: 'deckCrewReset' } }),
      requestCrewContinuumPose({ device, shader }),
      requestCrewContinuumPipelines({ device, shader, format, samples }),
    ]);
    return { place, reset, pose, continuum };
  });
  // A continuum body, asked for the first time a soul wears it; the tables are laid again when it comes.
  const deckBodyOf = (id) => {
    if (!deckPrograms?.continuum) return null;
    if (!deckBodies.has(id)) {
      deckBodies.set(id, null);
      loadCrewContinuumBody(device, id).then((body) => {
        if (destroyed) return;
        deckBodies.set(id, body);
        crewStationsDirty = true;
      }).catch((error) => {
        // People are drawn through the continuum alone: a body that cannot be had is said, and its people not drawn.
        deckBodies.set(id, false);
        console.error(`Trade deck crews: the ${id} body cannot be had, so its people are not drawn`, error);
      });
    }
    return deckBodies.get(id) || null;
  };
  const deckRigOf = (animator) => {
    let rig = deckRigs.get(animator);
    if (!rig) {
      const { palettes, layout } = bakeDeckCrewClips(animator);
      rig = {
        layout,
        palette: deckOwnedBuffer('trade deck crew clips', palettes, U_STORAGE),
        rest: deckOwnedBuffer('trade deck crew rest places', crewContinuumRestPlaces(animator), U_STORAGE),
      };
      deckRigs.set(animator, rig);
    }
    return rig;
  };

  function writeDeckCrewLook(lookIdx, role, stationSeed, female) {
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

    // The pieces they put on (hair, hat, beard, garment), packed with the face.
    const hairPool = female ? [2, 3, 4, 5] : [0, 1, 2, 3];
    const hair = hairPool[Math.floor(h3 * hairPool.length) % hairPool.length];
    let hat = 0;
    if (role === 'captain') {
      hat = female ? 2 : (h4 < 0.62 ? 4 : 2);
    } else if (role === 'merchant') {
      hat = female ? (h4 < 0.55 ? 3 : 2) : (h4 < 0.52 ? 2 : (h4 < 0.82 ? 1 : 4));
    } else if (role === 'pilot') {
      hat = female ? 2 : (h4 < 0.58 ? 2 : 1);
    } else if (role !== 'paddler') {
      hat = female ? [0, 1, 2, 3][Math.floor(h4 * 4) % 4] : [0, 1, 2, 0][Math.floor(h4 * 4) % 4];
    }
    const beard = (female || role === 'paddler')
      ? 0
      : (isElite ? [1, 2, 2, 3][Math.floor(h5 * 4) % 4] : [0, 1, 2, 3][Math.floor(h5 * 4) % 4]);
    let garment = 0;
    if (female) {
      garment = isElite ? 3 : [1, 3, 4, 2][Math.floor(h2 * 4) % 4];
    } else if (isElite) {
      garment = h3 < 0.78 ? 1 : 4;
    } else if (role === 'pilot') {
      garment = h3 < 0.65 ? 1 : 4;
    } else if (role !== 'paddler') {
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
    crewLooksF32.set([shirt[0], shirt[1], shirt[2], 0], at);
    crewLooksF32.set([trousers[0], trousers[1], trousers[2], 0], at + 4);
    crewLooksF32.set([person.skin[0], person.skin[1], person.skin[2], female ? 1 : 0], at + 8);
    crewLooksF32.set([person.hair[0], person.hair[1], person.hair[2], reconciled.dress / DRESS_MASK_SCALE], at + 12);
    crewLooksF32.set([person.face[0], person.face[1], person.face[2], packCrewFaceW(person.face[3], reconciled.compMask, isIndig)], at + 16);
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

  // Who stands at each station, which body they wear and which clip they work: laid out on the CPU when the traffic,
  // a body, or the drawing changes, never a frame.
  function syncDeckCrewStationTables() {
    crewStationsU32.fill(0);
    crewStationsDirty = false;
    const clipIndexForStation = (st) => {
      const poseKind = st.poseKind;
      if (poseKind === 'brace') return 1;
      if (poseKind === 'helm') return 2;
      if (poseKind === 'merchant') return 3;
      if (poseKind === 'row') return (st.oarSide ?? -1) > 0 ? 5 : 4;
      if (poseKind === 'paddle') return 6;
      return 0;
    };

    const souls = [];
    let slot = 0;
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
        const female = sexStr === 'f' || sexStr === 'female';
        souls.push({ v, st, si, gid: slot * MAX_DECK_STATIONS_PER_VESSEL + si, seedBase, female, body: deckCrewBodyFor(st.role, female) });
      }
      slot++;
    }
    activeCrewVessels = slot;
    activeDeckSoulCount = souls.length;

    // Each body's run of slots, in order of its first wearer, and the rig its clips are baked from: the continuum
    // body's own. Until it has come, its people are not drawn.
    const runs = [];
    const runOf = new Map();
    let slots = 0;
    const drawn = Boolean(deckDrawing && deckPrograms && (deckDrawing.shared ?? deckShared)?.captainTexView);
    for (const soul of souls) {
      if (!drawn) break;
      if (!runOf.has(soul.body)) {
        if (runs.length >= DECK_CREW_BODY_LIMIT) { runOf.set(soul.body, null); continue; }
        const body = deckBodyOf(soul.body);
        const animator = body?.standIn?.animator ?? null;
        const run = animator ? { id: soul.body, index: runs.length, body, rig: deckRigOf(animator), people: 0 } : null;
        runOf.set(soul.body, run);
        if (run) runs.push(run);
      }
      const run = runOf.get(soul.body);
      if (run) run.people++;
    }
    for (const run of runs) {
      run.first = slots;
      run.capacity = Math.ceil(run.people / DECK_CREW_SLOT_ALIGNMENT) * DECK_CREW_SLOT_ALIGNMENT;
      slots += run.capacity;
    }

    let looks = 0;
    for (const soul of souls) {
      const run = runOf.get(soul.body);
      if (!run) continue;
      const { st, si, gid, seedBase } = soul;
      const clipIdx = clipIndexForStation(st);
      const clipFirst = run.rig.layout[clipIdx * 2];
      const clipLen = Math.max(1, run.rig.layout[clipIdx * 2 + 1]);
      const lookIdx = Math.min(CREW_LOOK_CAP - 1, looks++);
      writeDeckCrewLook(lookIdx, st.role, seedBase ^ (si * 7919), soul.female);
      const phaseVal = st.poseKind === 'row' || st.poseKind === 'paddle'
        ? (st.oarPhaseOffset || 0)
        : deckCrewHash(seedBase, 97);
      const invScale = 1 / Math.max(0.25, soul.v.scaleMul || 1);
      const stLocalY = (st.poseKind === 'row' && Number.isFinite(st.seatHeightMetres))
        ? (st.localMetres[1] + st.seatHeightMetres * (1 - invScale))
        : st.localMetres[1];
      const wOff = gid * DECK_CREW_STATION_WORDS;
      crewStationsF32.set([st.localMetres[0], stLocalY, st.localMetres[2], st.yaw || 0], wOff);
      crewStationsU32[wOff + 4] = (1 | (run.index << 1) | ((clipIdx & 7) << 4)) >>> 0;
      crewStationsU32[wOff + 5] = ((clipFirst & 0xFFFF) | ((clipLen & 0xFFFF) << 16)) >>> 0;
      crewStationsU32[wOff + 6] = lookIdx >>> 0;
      crewStationsF32[wOff + 7] = phaseVal;
      // Who they are, for the thinning and the sample mask: the same soul keeps the same seed wherever they stand.
      crewStationsU32[wOff + 8] = ((seedBase >>> 0) % 0x3fffffff) >>> 0;
    }

    deckConfigU32.fill(0);
    deckConfigU32.set([activeCrewVessels, MAX_DECK_STATIONS_PER_VESSEL, runs.length, Math.max(1, looks)], 0);
    // Each body's work clip is what its standing people brace into as the deck rolls.
    runs.forEach((run, b) => deckConfigU32.set([run.first, run.capacity, run.rig.layout[2], run.rig.layout[3]], 4 + b * 4));
    device.queue.writeBuffer(crewConfigBuffer, 0, deckConfigBuf);
    if (activeCrewVessels > 0) {
      device.queue.writeBuffer(crewStationsBuffer, 0, crewStationsBuf, 0, activeCrewVessels * MAX_DECK_STATIONS_PER_VESSEL * DECK_CREW_STATION_WORDS * 4);
    }
    if (looks) device.queue.writeBuffer(crewLooksBuffer, 0, crewLooksF32, 0, looks * DECK_CREW_LOOK_WORDS);

    const key = runs.map((run) => `${run.id}:${run.capacity}`).join('|');
    if (!runs.length) disposeDeckCompany();
    else if (deckCompany?.key !== key) buildDeckCompany(runs, slots, key);
  }

  function disposeDeckCompany() {
    if (!deckCompany) return;
    for (const b of [deckCompany.placed, deckCompany.joints, deckCompany.actors]) b.destroy();
    for (const made of [...deckCompany.posers, ...deckCompany.batches]) made?.destroy?.();
    deckCompany = null;
  }

  // The company's buffers and passes: one continuum batch a body, posed, cut and drawn on the GPU.
  function buildDeckCompany(runs, slots, key) {
    disposeDeckCompany();
    const d = deckDrawing;
    const shared = d.shared ?? deckShared;
    const P = deckPrograms;
    const placed = device.createBuffer({ label: 'trade deck crew placed', size: slots * DECK_CREW_PLACED_BYTES, usage: U_STORAGE });
    const joints = device.createBuffer({ label: 'trade deck crew joints', size: slots * DECK_CREW_JOINT_BYTES, usage: U_STORAGE });
    const actors = device.createBuffer({ label: 'trade deck crew actors', size: slots * DECK_CREW_ACTOR_BYTES, usage: U_STORAGE });
    const countWords = new Uint32Array(DECK_CREW_COUNT_WORDS);
    for (let b = 0; b < DECK_CREW_BODY_LIMIT; b++) countWords.set([0, 1, 1, 0], b * DECK_CREW_DISPATCH_WORDS);
    device.queue.writeBuffer(crewCountsBuffer, 0, countWords);
    deckHull ??= createCrewContinuumWorldHull(device, 'trade deck crew world frame');
    const main = [
      { buffer: d.frameUBO }, { buffer: deckHull }, { buffer: joints }, { buffer: actors }, d.transView, d.sampClamp, d.envCubeView,
      { buffer: d.sunVisBuf }, { buffer: crewMoistureBuffer }, d.skyView,
      { binding: 13, resource: shared.captainTexView }, { binding: 14, resource: shared.captainSampler },
    ];
    const countedOf = (b) => ({ buffer: crewCountsBuffer, offset: b * DECK_CREW_DISPATCH_WORDS * 4 });
    const batches = runs.map((run, b) => createCrewContinuumBatch({
      device, pipelines: P.continuum, body: run.body, capacity: run.capacity, first: run.first, samples,
      frame: d.frameUBO, hull: deckHull, bones: joints, actor: actors, main, shadows: d.shadows, counted: countedOf(b),
    }));
    const posers = runs.map((run, b) => createCrewContinuumPoser({
      device, pipeline: P.pose, placed, palettes: run.rig.palette, looks: crewLooksBuffer, rest: run.rig.rest, joints, actors,
      orders: batches[b].orders, first: run.first, counted: countedOf(b),
    }));
    deckCompany = {
      key, runs, placed, joints, actors, batches, posers,
      resetGroup: device.createBindGroup({ label: 'trade deck crew reset', layout: P.reset.getBindGroupLayout(0), entries: [{ binding: 6, resource: { buffer: crewCountsBuffer } }] }),
      placeGroup: null,
    };
    rebuildDeckCrewPlaceGroup(resources);
  }

  function rebuildDeckCrewPlaceGroup(curResources = resources) {
    if (!deckCompany) return;
    const byBinding = new Map(curResources.map(([b, r]) => [b, r]));
    deckCompany.placeGroup = device.createBindGroup({
      label: 'trade deck crew place',
      layout: deckPrograms.place.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: byBinding.get(0) },
        { binding: 1, resource: byBinding.get(12) },
        { binding: 2, resource: { buffer: crewConfigBuffer } },
        { binding: 3, resource: { buffer: crewSrcInstancesBuffer } },
        { binding: 4, resource: { buffer: crewStationsBuffer } },
        { binding: 5, resource: { buffer: deckCompany.placed } },
        { binding: 6, resource: { buffer: crewCountsBuffer } },
        { binding: 7, resource: byBinding.get(19) },
        { binding: 8, resource: { buffer: crewMoistureBuffer } },
      ],
    });
  }

  async function installSharedCrew(nextShared) {
    const resolved = await Promise.resolve(nextShared).catch(() => null);
    if (destroyed || !resolved) return null;
    deckShared = resolved;
    crewStationsDirty = true;
    return resolved;
  }
  // What the people continuum draws with, from the scene: its frame and lights, the land's shadow set, and the crew's
  // shared assets. Deck hands are drawn once it is given.
  function setDeckPeople(drawing) {
    if (!drawing || drawing === deckDrawing || !canCompute || destroyed) return deckProgramsAsked;
    deckDrawing = drawing;
    if (drawing.shared) deckShared = drawing.shared;
    crewStationsDirty = true;
    deckProgramsAsked ??= requestDeckCrewPrograms().then((programs) => {
      if (destroyed) return null;
      deckPrograms = programs;
      crewStationsDirty = true;
      return programs;
    }).catch((error) => {
      console.error('[trade-vessels deck crew]', error);
      return null;
    });
    return deckProgramsAsked;
  }

  // A damaged vessel's rest pose pass, compiled on the first breach (cannon hit or grounding). She takes a slot of the
  // scene's pose buffer when she is promoted; with every slot held she waits for one, and is promoted when it comes free.
  let damagedAssetPromise = null;
  let damagedAssets = null;
  // The vessel posed in each damaged slot, or null.
  const damagedSlots = new Array(TRADE_VESSEL_DAMAGED_SLOTS).fill(null);
  const ensureDamagedAssets = () => {
    if (damagedAssetPromise) return damagedAssetPromise;
    damagedAssetPromise = getPipelineEntry(device, `damagedRest:${Boolean(computePipe)}`, async () => {
      const restPosePipe = await (computePipe
        ? computePipe(REST_TO_POSED_WGSL, 'trade vessel rest pose')
        : device.createComputePipelineAsync({
            label: 'trade vessel rest pose',
            layout: 'auto',
            compute: { module: device.createShaderModule({ code: REST_TO_POSED_WGSL }), entryPoint: 'main' },
          }));
      return { restPosePipe };
    }).then((assets) => {
      if (destroyed) return null;
      damagedAssets = assets;
      return assets;
    }).catch((err) => {
      console.error('[trade-vessels damaged]', err);
      return null;
    });
    return damagedAssetPromise;
  };

  // Her rest pose pass's group: her own scarred copy of the assembly posed into her slot's run of the pose buffer, on
  // the frame's clock.
  function bindDamagedPose(v) {
    const d = v.damaged;
    if (!damagedAssets || !d) return;
    d.poseBindGroup = device.createBindGroup({
      layout: damagedAssets.restPosePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: d.sourceBuffer } },
        { binding: 1, resource: { buffer: poses, offset: d.posedOffset, size: d.posedSize } },
        { binding: 2, resource: { buffer: d.poseUniform } },
        { binding: 3, resource: { buffer: bufferOf(resources, 0) } },
      ],
    });
  }

  function promoteDamagedBoat(v) {
    if (v.damaged || v.promoting || destroyed) return;
    const slot = damagedSlots.indexOf(null);
    if (slot < 0) {
      v.awaitingDamagedSlot = true;
      return;
    }
    v.awaitingDamagedSlot = false;
    v.promoting = true;
    damagedSlots[slot] = v;
    // Her own copy of the assembly her body was baked with (the riders name its vertices), to take her scars; and her
    // RIDER header's design scale.
    const drawn = shipData.assemblies[v.archIndex];
    const meshCopy = drawn.vertices.slice();
    const sourceBuffer = device.createBuffer({
      label: `trade vessel damaged src ${v.route.id}`,
      size: meshCopy.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(sourceBuffer, 0, meshCopy);
    const scale = archs[v.archIndex].designScale;
    device.queue.writeBuffer(poses, (headersAt + slot * SHIP_RIDER_HEADER + 1) * 16, new Float32Array([scale[0], scale[1], scale[2], 0]));
    const poseUniform = device.createBuffer({
      label: `trade vessel pose uniform ${v.route.id}`,
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const dmgState = {
      ready: false,
      meshCopy,
      sourceBuffer,
      // Her slot, and her run of the pose buffer (bytes).
      slot,
      posedOffset: slotsAt + slot * slotBytes,
      posedSize: drawn.vertexCount * 32,
      hullData: new Float32Array(TV_HULL_FLOOD_WORDS),
      craterData: new Float32Array(HULL_CRATER_LIMIT * 4),
      craterRevision: -1,
      poseUniform,
      poseData: new Float32Array(4),
      poseBindGroup: null,
      fractureGPU: null,
      // Her run has been posed at least once: until then her record stays whole (DRAPED).
      posedOnce: false,
      needsRestCopy: true,
      // Her oars or helm moved last frame, so she is posed once more as they come to rest.
      moving: false,
    };
    v.damaged = dmgState;

    const fractureCompute = computePipe || ((src, lbl) => device.createComputePipelineAsync({
      label: lbl,
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: src }), entryPoint: 'main' },
    }));

    Promise.all([
      ensureDamagedAssets(),
      createShipFractureGPU({
        device, computePipe: fractureCompute, posedBuffer: poses, posedOffset: dmgState.posedOffset, posedSize: dmgState.posedSize,
        fracture: drawnFractureOf(v.archIndex),
      }),
    ]).then(([assets, fractureGPU]) => {
      if (destroyed || !assets || !fractureGPU || v.damaged !== dmgState) {
        fractureGPU?.destroy?.();
        return;
      }
      dmgState.fractureGPU = fractureGPU;
      bindDamagedPose(v);
      dmgState.gpuCompiled = true;
    }).catch((err) => {
      console.error('[trade-vessels promote]', err);
    });
  }
  const ensureDamagedSlot = promoteDamagedBoat;
  // An archetype's fracture as its body's vertices fly: its shards, with each baked vertex's.
  const drawnFractures = new Map();
  const drawnFractureOf = (archIndex) => {
    if (!drawnFractures.has(archIndex)) drawnFractures.set(archIndex, Object.freeze({ ...archs[archIndex].fracture, vertexShards: shipData.assemblies[archIndex].vertexShards }));
    return drawnFractures.get(archIndex);
  };

  if (oceanBridge?.oakTex) {
    Promise.resolve(oceanBridge.oakTex).then((tex) => {
      if (!tex || destroyed) return;
      oakView = tex.createView();
      regroup();
    }).catch(() => {});
  }

  let routes = [];
  let vessels = [];
  let boardDay = 0, daysPerSecond = 0, simElapsedSec = 0, hasSimClock = false;
  let worldOffsetX = 0, worldOffsetZ = 0;
  let lastUploadTime = -Infinity;
  let totalIntact = 0;
  // Once the wave pass has posed the vessels on the GPU, the CPU stops sampling the swell for those it leaves to it.
  let hasEncodedGpuOnce = false;
  let dirtySyncFlag = false;
  let lastEnv = { windVec: [8, 0], storm: false, avoidVessels: null };
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
    v.awaitingDamagedSlot = false;
    const d = v.damaged;
    if (!d) return;
    if (d.slot >= 0 && damagedSlots[d.slot] === v) damagedSlots[d.slot] = null;
    d.sourceBuffer?.destroy?.();
    d.poseUniform?.destroy?.();
    d.fractureGPU?.destroy?.();
    v.damaged = null;
  }

  function makeTradeVesselRecord(route) {
    const aIdx = Math.max(0, Math.min(TRADE_VESSEL_ARCHETYPES - 1, route.archetype | 0));
    const arch = archs[aIdx];
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
            const nextArch = archs[upIdx];
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
      totalIntact = 0;
      sentIntact = 0;
      activeCrewVessels = 0;
      activeWaveVesselCount = 0;
      activeDeckSoulCount = 0;
      deckConfigU32[0] = 0;
      device.queue.writeBuffer(crewConfigBuffer, 0, deckConfigU32, 0, 4);
      waveParamsU32[0] = 0;
      device.queue.writeBuffer(waveParamsBuffer, 0, waveParamsU32, 0, 4);
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

      // One waiting for a damaged slot is promoted when one comes free.
      if (v.awaitingDamagedSlot && !v.damaged) promoteDamagedBoat(v);
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
        // Her oars and helm (the barge's, the river boat's helm) swing with her motion: posed each frame they move,
        // and once more as they come to rest.
        const moving = (v.archIndex === 4 || v.archIndex === 6) && motion > 0.05;
        if (moving || d.moving) d.needsRestCopy = true;
        d.moving = moving;
        if (Math.abs(v.lastPoseFurl - furl) > 0.004) {
          v.lastPoseFurl = furl;
          d.needsRestCopy = true;
        }

        const hullAt = d.slot * HULL_DAMAGE_UNIFORM_BYTES;
        writeHullFloodUniform(d.hullData, v.boat);
        d.hullData[1] = v.arch.designScale[1] * v.scaleMul;
        device.queue.writeBuffer(hullDamageBuffer, hullAt, d.hullData);
        const rev = dmg.cratersRevision ?? dmg.revision ?? 0;
        if (rev !== d.craterRevision) {
          d.craterRevision = rev;
          writeHullCraters(d.craterData, dmg.craters ?? []);
          device.queue.writeBuffer(hullDamageBuffer, hullAt + TV_HULL_FLOOD_WORDS * 4, d.craterData);
        }

        d.poseData[0] = phaseAnim;
        d.poseData[1] = motion;
        d.poseData[2] = v.archIndex;
        d.poseData[3] = furl;
        device.queue.writeBuffer(d.poseUniform, 0, d.poseData);

        d.ready = true;
      }

      // Every vessel is one record of the scene. Whole, the DRAPED kind poses her from her record (her phase, motion and
      // furl); once her slot's run is posed, the RIDER kind carries her clusters on it (her shards in flight, her canvas
      // brailed) and the cut draws her clusters alone, her slot in her identity's high bits for her material. A vessel
      // hit, flooding or aground is cut finer.
      const wreck = v.damaged;
      const drawnDamaged = Boolean(wreck?.ready && wreck.posedOnce);
      const important = (dmg.hits ?? 0) > 0 || floodSinkage > 0 || Boolean(v.boat.aground);
      v.identity ??= deckCrewStringHash(v.route.id) & 32767;
      if (totalIntact < MAX_TRADE_VESSELS) {
        if (!wreck?.ready) v.intactSlot = totalIntact >>> 0;
        scene.place(totalIntact, {
          position: [ai.x, effY, ai.z], scale: v.scaleMul, turn: shipContinuumTurn(ai.yaw, effPitch, effRoll), type: v.archIndex,
          kind: drawnDamaged ? CONTINUUM_KIND.RIDER : CONTINUUM_KIND.DRAPED,
          flags: (important ? CONTINUUM_IMPORTANT_FLAG : 0) | (drawnDamaged ? CONTINUUM_DAMAGED : 0),
          pose: drawnDamaged ? headersAt + wreck.slot * SHIP_RIDER_HEADER : v.archIndex * drapedRows,
          seed: v.identity,
          reach: drawnDamaged ? typeRadius[v.archIndex] * v.scaleMul + 20 : 0,
          identity: v.identity + (drawnDamaged ? (wreck.slot + 1) * 65536 : 0), phase: phaseAnim, motion, furl,
        });
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
      scene.send(0, totalIntact);
      sentIntact = totalIntact;
      if (crewSlotCursor > 0) {
        device.queue.writeBuffer(crewSrcInstancesBuffer, 0, crewSrcInstancesScratch, 0, crewSlotCursor * TRADE_VESSEL_INSTANCE_FLOATS);
      }
      crewEncoded = false;
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
    // What deck hands are drawn with through the people continuum: { frameUBO, transView, skyView, sampClamp,
    // envCubeView, sunVisBuf, shadows (the land's), shared (the crew's assets) }, from the scene that owns them.
    setPeople(drawing) {
      return setDeckPeople(drawing);
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
      // A new frame or land shadow uniform: the scene is laid again over them, its records carried across.
      if (bufferOf(resources, 0) !== sceneFrame || bufferOf(resources, 19) !== sceneShadow) {
        const old = scene;
        scene = makeScene(resources);
        sceneFrame = bufferOf(resources, 0);
        sceneShadow = bufferOf(resources, 19);
        scene.words.set(old.words);
        scene.send(0, sentIntact);
        scene.setCount(sentIntact);
        const retire = device.queue.onSubmittedWorkDone?.();
        if (retire) retire.then(() => old.destroy(), () => old.destroy());
        else old.destroy();
      }
      regroup();
      waveBindGroups = makeWaveBindGroups(resources);
      rebuildDeckCrewPlaceGroup(resources);
      for (const v of vessels) {
        if (v.damaged && damagedAssets) bindDamagedPose(v);
      }
    },
    encode(pass) {
      // Each damaged vessel's run of the pose buffer: her scarred assembly posed (oars, helm, canvas), then her shards
      // flown from it. The fracture pass moves the posed vertices in place, so the rest pose comes first whenever it runs.
      if (damagedAssets) {
        for (const v of vessels) {
          const d = v.damaged;
          if (!d?.ready || !d.fractureGPU || !d.poseBindGroup) continue;
          if (!d.needsRestCopy && !d.fractureGPU.active) continue;
          d.needsRestCopy = false;
          pass.setPipeline(damagedAssets.restPosePipe);
          pass.setBindGroup(0, d.poseBindGroup);
          pass.dispatchWorkgroups(Math.ceil(shipData.assemblies[v.archIndex].vertexCount / 64));
          d.fractureGPU.encode(pass);
          d.posedOnce = true;
        }
      }
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
          hasEncodedGpuOnce = true;
        }
      }
      // Every vessel cut from the records the wave pass just stood: each into the lists the draws read.
      scene.setWorldOffset(worldOffsetX, worldOffsetZ);
      scene.setCount(sentIntact);
      scene.encode(pass);
      // Deck hands: their counts emptied, everyone in sight placed from the vessels the wave pass just posed, each body's
      // people posed, then each body's cut, as many workgroups as the placing pass kept.
      if (deckCompany?.placeGroup && activeDeckSoulCount > 0) {
        const c = deckCompany;
        c.batches.forEach((batch, b) => batch?.update(c.runs[b].capacity));
        pass.setPipeline(deckPrograms.reset);
        pass.setBindGroup(0, c.resetGroup);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(deckPrograms.place);
        pass.setBindGroup(0, c.placeGroup);
        pass.dispatchWorkgroups(Math.ceil(activeCrewVessels * MAX_DECK_STATIONS_PER_VESSEL / 64));
        for (const poser of c.posers) poser.encode(pass);
        for (const batch of c.batches) batch?.encodeSelect(pass);
        crewEncoded = true;
      }
    },
    // Seen from under the water: every vessel's coarse cut, through the water's own capture of her material.
    drawSubmerged(pass, above = false) {
      under?.draw(pass, [scene], above);
    },
    draw(pass, elapsedSec = NaN) {
      const t = Number.isFinite(elapsedSec) ? elapsedSec : (hasSimClock ? simElapsedSec : performance.now() * 0.001);
      if (!hasSimClock || Number.isFinite(elapsedSec)) {
        updateAllVessels(0, t, null, false, lastEnv);
      }
      // Opaque, with no discard: every vessel, whole or damaged, in the view's four lists by one pipeline, each keeping
      // the samples that are its own across a handoff, and a damaged one's holes, parted rope and torn canvas masked out.
      scene.draw(pass, sceneGroup, shadeGroup);

      // Deck hands, opaque with the rest: no discard, so the GPU shades only what shows.
      if (crewEncoded && deckCompany) {
        for (const batch of deckCompany.batches) batch.drawOpaque(pass);
      }
    },
    // The indirect draws draw() submits in the main scene pass this frame, for the continuum census
    // (js/continuum-census.js). Every vessel is drawn through them; none is sized on the CPU.
    continuumDraws() {
      return scene.continuumDraws();
    },
    // The scene and its buffers, for whoever reads them back (tests): its records, lists, draws and pose buffer.
    get continuum() {
      return { scene, records: scene.records, list: scene.list, draws: scene.draws, lists: scene.lists, poses, count: sentIntact, bodies: shipBodyIds };
    },
    // The deck hands' own draws, for the census's one family of people (js/main.js).
    peopleDraws() {
      return crewEncoded && deckCompany ? deckCompany.batches.flatMap((batch) => batch.continuumDraws()) : [];
    },
    // The deck hands' bodies (each that has come, drawn through the continuum), and the counts their placing pass
    // keeps, for whoever reads them back.
    get deckCrew() {
      return deckCompany
        ? { bodies: deckCompany.runs.map((run) => ({ id: run.id, continuum: true, first: run.first, capacity: run.capacity })), counts: crewCountsBuffer }
        : null;
    },
    // Every vessel's coarse cut casts her shadow, a damaged one's clusters on her posed run; then the deck hands'.
    drawShadow(pass) {
      scene.drawShadow(pass);
      if (crewEncoded && deckCompany) {
        for (const batch of deckCompany.batches) batch.drawShadow(pass);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const v of vessels) destroyVesselDamaged(v);
      disposeDeckCompany();
      for (const b of deckOwned) b?.destroy?.();
      deckOwned.length = 0;
      deckHull?.destroy?.();
      scene.destroy();
      for (const b of [
        atlas.buffer, poses, hullDamageBuffer, waveParamsBuffer, vesselWaveInputBuffer, vesselHydroStateBuffer, swUniformFallbackBuffer,
        crewConfigBuffer, crewSrcInstancesBuffer, crewStationsBuffer, crewLooksBuffer,
        crewCountsBuffer, crewMoistureBuffer,
      ]) b?.destroy?.();
      seaDispFallbackTex?.destroy?.();
      swFallbackTex?.destroy?.();
      oakFallback.tex?.destroy?.();
      routes = [];
      vessels = [];
    },
  };
}
