// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What a ship carries besides her hull, rig and guns, all of it hers and posed on the GPU (AGENTS.md rules 1 to 3).
//
// Her assembly gains the geometry at her stations (appendVesselStations, before js/ship-mesh.js indexes her): the
// crow's nest basket on her mainmast, her flagstaff and outlicker with her ensign's cloth, her masthead pennant, and
// her working anchor's iron and fairlead ring at the port cathead. They are parts like any other: baked into her
// continuum, struck by shot, carried off with their shard.
//
// Her detail layer (buildVesselDetail) is what is thinner than a ball: the connectors of her rig (parrel collars,
// trusses, lifts, the stern outlicker's guys and sheet), her mooring lines and gangplanks, and her anchor's rode. It
// is static records: anchors, each a fixed place in the frame of one triangle of her assembly (so it rides the posed
// part it is made fast to, keyed by that part's vertices); tubes between anchors; and line vertices. Her pose pass
// (js/vessel-pose.js) lays the lines into the tail of her posed vertices, and her cut draws them with her clusters
// (js/wgsl/ship-continuum.js SHIP_CONTINUUM_LINE_LIST).
//
// Each frame the CPU uploads only her compact state (writeVesselDetailState): the colours she wears, the wind, her
// anchor's place, heading and rode, and her mooring's progress and far ends. Her colours' cloth is flown, and her
// anchor's iron let go, by the stations pass on the GPU (js/wgsl/vessel-detail.js).
import { ANCHOR_IRON } from './anchor-iron.js';
import { anchorEquipment, anchorEyeOffset } from './anchor-state.js';
import { boatRotate, crowsNestDesignStation, sternEnsignDesignStation } from './boat.js';
import { vesselHull, modelDeck, modelDeckWidth } from './hull.js';
import { RIG_MASTS, mastPoint } from './rigging.js';
import { SAIL_PLAN, lateenRestPoint } from './lateen.js';
import { VICTORY_MASTS, VICTORY_SAILS, victoryMastPoint } from './models/victory.js';
import { ADDITIONAL_DESIGNS } from './models/additional.js';
import { ROWING_DESIGNS } from './models/rowing.js';
import { LATER_SAIL_DESIGNS } from './models/later-sail.js';
import { proceduralRigContext } from './additional-rig.js';
import { surfaceRestPoint } from './rig-surface.js';
import { resolveShipNode } from './ship-models.js';
import { VESSEL_ENSIGN_MATERIAL, VESSEL_PENNANT_MATERIAL } from './wgsl/ship-colours.js';
import { VESSEL_DETAIL_STATIONS, VESSEL_DETAIL_LINES } from './wgsl/vessel-detail.js';

// ------------------------------------------------------------------------------------------------ mooring
// The four lines she makes fast to a pier, and to a vessel she lies alongside (design z forward, as js/boarding-
// docking.js has them): where along her each is made fast, and where along the pier or the other vessel it lands.
export const VESSEL_PIER_LINES = Object.freeze([
  Object.freeze({ name: 'Bow line', shipZ: 3.3, pierAlong: 4.4 }),
  Object.freeze({ name: 'Fore spring', shipZ: 1.6, pierAlong: -0.9 }),
  Object.freeze({ name: 'Aft spring', shipZ: -1.5, pierAlong: 1.1 }),
  Object.freeze({ name: 'Stern fast', shipZ: -3.4, pierAlong: -4.2 }),
]);
export const VESSEL_ALONGSIDE_LINES = Object.freeze([
  Object.freeze({ name: 'Fore grappling hook', shipZ: 3.1, targetZ: 3.0 }),
  Object.freeze({ name: 'Forward spring line', shipZ: 1.2, targetZ: 1.1 }),
  Object.freeze({ name: 'Waist grappling hook', shipZ: -1.1, targetZ: -1.1 }),
  Object.freeze({ name: 'Quarter fast line', shipZ: -3.1, targetZ: -3.0 }),
]);
// Her rail where a line is made fast (design units, z forward), on her side `sideSign` (-1 port, 1 starboard).
export const vesselPierLineFast = (boat, z, sideSign) => [sideSign * Math.max(0.55, modelDeckWidth(boat, z) - 0.08), modelDeck(boat, z) + 0.34, z];
export const vesselAlongsideLineFast = (boat, z, sideSign) => [sideSign * Math.max(0.55, modelDeckWidth(boat, z) - 0.06), modelDeck(boat, z) + 0.38, z];
// The gangplanks run beside the second and third lines.
export const VESSEL_GANGPLANK_LINES = Object.freeze([1, 2]);

const VESSEL_MOOR_SEGMENTS = 10, VESSEL_MOOR_RADIUS = 0.042;
const VESSEL_GANGPLANK_WIDTH = 0.72, VESSEL_GANGPLANK_THICKNESS = 0.08;
const VESSEL_RODE_SPANS = 48;

// ------------------------------------------------------------------------------------------------ stations
// Her model as built at her own dimensions, for the stations, her design scale (metres per design unit) with it.
function vesselDetailBoat(model) {
  const frame = vesselHull(model.id).frame;
  const boat = { modelId: model.id, length: model.runtime.length, beam: model.runtime.beam };
  return { boat, scale: [model.runtime.beam / frame.beam, frame.verticalScale, model.runtime.length / frame.length] };
}
const vesselDetailUnit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/**
 * Adds the geometry at her stations to her raw mesh (nine floats a corner, unindexed) and names it in `groups`:
 * `lookout.crows-nest`, `flag.colours` (staff, outlicker and ensign), `rig.pennant`, and, when she carries an anchor,
 * `anchor.port.iron` and `anchor.port.ring`. Returns the longer mesh.
 */
export function appendVesselStations(model, raw, groups) {
  const { boat, scale } = vesselDetailBoat(model);
  const start = raw.length / 9, out = [];
  const put = (p, n, material, u = 0, v = 0) => out.push(p[0], p[1], p[2], n[0], n[1], n[2], material, u, v);
  const group = (id, nodeId, from) => { if (out.length > from) groups.push({ id, nodeId, firstVertex: start + from / 9, vertexCount: (out.length - from) / 9 }); };
  // A tube in design units, its normals as design directions (a design-space surface, as her hull is).
  const tube = (a, b, r0, r1, sides, material) => {
    const d = vesselDetailUnit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    if (!(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 1e-5)) return;
    const seed = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = vesselDetailUnit([d[1] * seed[2] - d[2] * seed[1], d[2] * seed[0] - d[0] * seed[2], d[0] * seed[1] - d[1] * seed[0]]);
    const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    const ring = (i) => { const t = (i / sides) * Math.PI * 2; return [0, 1, 2].map((k) => u[k] * Math.cos(t) + w[k] * Math.sin(t)); };
    for (let i = 0; i < sides; i++) {
      const n0 = ring(i), n1 = ring(i + 1);
      const at = (p, n, r) => [p[0] + n[0] * r, p[1] + n[1] * r, p[2] + n[2] * r];
      const corners = [[a, n0, r0, i, 0], [a, n1, r0, i + 1, 0], [b, n0, r1, i, 1], [b, n0, r1, i, 1], [a, n1, r0, i + 1, 0], [b, n1, r1, i + 1, 1]];
      for (const [p, n, r, k, e] of corners) put(at(p, n, r), n, material, k / sides, e);
    }
  };
  // A sheet of cloth in the plane x = base x, its corners (u along the fly, v down the hoist) placed by `place`.
  const cloth = (columns, rows, material, place) => {
    const corner = (i, j) => put(place(i / columns, j / rows), [1, 0, 0], material, i / columns, j / rows);
    for (let i = 0; i < columns; i++) for (let j = 0; j < rows; j++) {
      corner(i, j); corner(i + 1, j); corner(i, j + 1);
      corner(i, j + 1); corner(i + 1, j); corner(i + 1, j + 1);
    }
  };
  const WOOD = 1, IRON = 3, GILT = 25;
  const cn = crowsNestDesignStation(boat), stern = sternEnsignDesignStation(boat);

  // The crow's nest (cesto de gavia) on the mainmast at the lookout's station: an iron collar on the mast, oak floor
  // and breast rings, an iron hoop, staves, floor planks and the knees that carry it.
  let from = out.length;
  if (cn.showBasket) {
    const c = [cn.x, cn.y, cn.z], ring = (r, y, a) => [c[0] + Math.cos(a) * r, c[1] + y, c[2] + Math.sin(a) * r];
    const segments = 12, inner = 0.085, bottom = 0.38, mid = 0.43, top = 0.48, height = 0.52;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
      tube(ring(inner, -0.02, a0), ring(inner, -0.02, a1), 0.032, 0.032, 5, IRON);
      tube(ring(bottom, 0, a0), ring(bottom, 0, a1), 0.04, 0.04, 6, WOOD);
      tube(ring(mid, height * 0.52, a0), ring(mid, height * 0.52, a1), 0.025, 0.025, 5, IRON);
      tube(ring(top, height, a0), ring(top, height, a1), 0.044, 0.044, 6, WOOD);
      tube(ring(bottom, 0, a0), ring(top, height, a0), 0.026, 0.022, 5, WOOD);
      tube(ring(0.065, 0, a0), ring(bottom, 0, a0), 0.028, 0.026, 5, WOOD);
      tube(ring(0.068, -0.22, a0), ring(bottom, 0, a0), 0.032, 0.026, 5, WOOD);
    }
  }
  group('lookout.crows-nest', 'mast.main', from);

  // Her stern flagstaff on its outlicker bracket, run back into the transom, with a gilt truck; then her ensign.
  from = out.length;
  if (stern.showEnsign) {
    const reach = Math.max(0.38, stern.outlickerSpan), b = [stern.x, stern.y, stern.z];
    const at = (p) => [b[0] + p[0], b[1] + p[1], b[2] + (p[2] < 0 ? p[2] * reach : p[2])];
    tube(at([0, -0.02, -1]), at([0, 0, 0]), 0.042, 0.038, 8, WOOD);
    tube(at([0, -0.36, -0.78]), at([0, -0.02, -0.18]), 0.034, 0.03, 6, WOOD);
    tube(at([0, -0.02, -0.82]), at([0, -0.02, -0.76]), 0.046, 0.046, 6, IRON);
    tube(at([0, 0, -0.06]), at([0, 0, 0.02]), 0.044, 0.044, 6, IRON);
    tube(at([0, 0, 0]), at([0, 2.45, 1.42]), 0.036, 0.022, 8, WOOD);
    tube(at([0, 2.43, 1.41]), at([0, 2.52, 1.46]), 0.048, 0.015, 8, GILT);
    // The ensign at rest, hoisted on the staff and streaming aft; the stations pass flies it.
    const fly = (2.25 * Math.max(0.85, scale[0])) / scale[2];
    cloth(14, 8, VESSEL_ENSIGN_MATERIAL, (u, v) => {
      const y = b[1] + 2.35 - v * 1.28;
      return [b[0], y - u * (1 - 0.35 * u) * 0.14, b[2] + (y - b[1]) * 0.58 + u * fly];
    });
  }
  group('flag.colours', 'hull', from);

  // Her masthead pennant above the mainmast.
  from = out.length;
  if (cn.showPennant) {
    const top = cn.y + cn.pennantLift - 0.03, z = cn.headZ ?? cn.z, fly = (2.85 * Math.max(0.85, scale[0])) / scale[2];
    cloth(10, 2, VESSEL_PENNANT_MATERIAL, (u, v) => [cn.x, top - v * 0.24 * (1 - 0.72 * u) - u * (1 - 0.35 * u) * 0.14, z + u * fly]);
  }
  group('rig.pennant', 'mast.main', from);

  // Her working anchor at the port cathead, hung by its eye below the fairlead, with the fairlead's iron ring. In
  // metres, to her design units.
  const equipment = anchorEquipment(boat);
  if (equipment) {
    const fair = resolveShipNode(boat, 'anchor.port.fairlead', { space: 'design' }), rs = equipment.renderScale;
    const origin = [fair[0], fair[1] - (0.65 * rs) / scale[1], fair[2]];
    from = out.length;
    for (let i = 0; i < ANCHOR_IRON.length; i += 6) {
      put([0, 1, 2].map((k) => origin[k] + (ANCHOR_IRON[i + k] * rs) / scale[k]), vesselDetailUnit([0, 1, 2].map((k) => ANCHOR_IRON[i + 3 + k] * scale[k])), IRON);
    }
    group('anchor.port.iron', 'anchor.port.root', from);
    from = out.length;
    const radius = 0.1 * rs, bar = 0.025 * rs, segments = 10, sides = 4;
    const metres = (a, r) => [Math.cos(a) * radius + Math.cos(a) * r[0], Math.sin(a) * radius + Math.sin(a) * r[0], r[1]];
    for (let i = 0; i < segments; i++) for (let j = 0; j < sides; j++) {
      const corner = (si, sj) => {
        const a = ((i + si) / segments) * Math.PI * 2, b = ((j + sj) / sides) * Math.PI * 2;
        const n = [Math.cos(a) * Math.cos(b), Math.sin(a) * Math.cos(b), Math.sin(b)];
        const m = metres(a, [bar * Math.cos(b), bar * Math.sin(b)]);
        put([0, 1, 2].map((k) => fair[k] + m[k] / scale[k]), vesselDetailUnit([0, 1, 2].map((k) => n[k] * scale[k])), IRON, (i + si) / segments, (j + sj) / sides);
      };
      corner(0, 0); corner(1, 0); corner(0, 1); corner(0, 1); corner(1, 0); corner(1, 1);
    }
    group('anchor.port.ring', 'anchor.port.root', from);
  }
  const longer = new Float32Array(raw.length + out.length);
  longer.set(raw);
  longer.set(out, raw.length);
  return longer;
}

// ------------------------------------------------------------------------------------------------ her rig's connectors
// The single description of her rig's connectors, at rest: each anchor a point of her assembly as built (on a mast, a
// yard or spar, her canvas, her bowsprit or her hull), each tube between two of them plus fixed offsets.
function vesselRigRecorder() {
  const anchors = [], tubes = [];
  let lines = 0;
  // Mode 6 is oak (iron when flagged), mode 7 hemp, as the connectors were first drawn.
  const material = (mode, flag) => (mode === 7 ? 12 : flag > 0.5 ? 3 : 1);
  const push = (ai, ax, ay, az, bi, bx, by, bz, cat, r0, r1, sides, mode, flag) =>
    tubes.push({ a: [ax, ay, az, ai], b: [bx, by, bz, bi], cat, shape: [r0, r1, material(mode, flag), 0], sides });
  return {
    anchors, tubes,
    anchor(p, kind) { anchors.push({ p: [p[0], p[1], p[2]], kind }); return anchors.length - 1; },
    tube(ai, ax, ay, az, bi, bx, by, bz, r0, r1, sides, mode, flag = 0) { push(ai, ax, ay, az, bi, bx, by, bz, [-1, 0, 0, 0], r0, r1, sides, mode, flag); },
    catenary(ai, ax, ay, az, bi, bx, by, bz, sag, radius, segs, mode = 7, flag = 0.45) {
      const line = lines++;
      for (let i = 1; i <= segs; i++) push(ai, ax, ay, az, bi, bx, by, bz, [(i - 1) / segs, i / segs, sag, line], radius, radius, 5, mode, flag);
    },
  };
}
// Every yard is bound to its mast by a parrel collar and truss yoke (racamento).
function vesselParrelCollar(rec, mast, yard, mastRadius = 0.085) {
  const segments = 6, r = mastRadius + 0.025;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
    const x0 = Math.cos(a0) * r, z0 = Math.sin(a0) * r;
    rec.tube(mast, x0, 0.02, z0, mast, Math.cos(a1) * r, 0.02, Math.sin(a1) * r, 0.02, 0.02, 5, 7, 0.45);
    // A wooden parrel truck (vertello).
    if (i % 2 === 0) rec.tube(mast, x0, 0.02 - 0.028, z0, mast, x0, 0.02 + 0.028, z0, 0.026, 0.026, 5, 6, 0);
  }
  // The iron-strapped sling band about the yard, and the hemp truss legs and halyard tie (ostaga) to the mast.
  rec.tube(yard, 0, -0.035, -0.035, yard, 0, 0.035, 0.035, 0.034, 0.034, 6, 6, 1);
  rec.tube(mast, 0, 0.16, 0, yard, 0, 0, 0, 0.022, 0.02, 5, 7, 0.5);
  rec.tube(mast, 0, -0.06, -0.04, yard, 0, 0, 0, 0.02, 0.018, 5, 7, 0.5);
  rec.tube(mast, 0, -0.06, 0.04, yard, 0, 0, 0, 0.02, 0.018, 5, 7, 0.5);
}
// An overhanging mizzen is sheeted to a stout stern outlicker (botaló) run out of the transom and guyed to her
// quarters; its sheet (escota de mesana) leads from the clew through the outlicker's block to a taffrail cleat.
function vesselOutlicker(rec, clewPos, hullEndZ, transomY, quarterHalfBeam, outlickerTipZ) {
  const tipZ = Math.max(outlickerTipZ, clewPos[2] + 0.16), tipY = transomY + 0.02, guyZ = hullEndZ - 0.28;
  const transom = rec.anchor([0, transomY, hullEndZ], 'hull'), tip = rec.anchor([0, tipY, tipZ], 'hull');
  const port = rec.anchor([-quarterHalfBeam, transomY - 0.04, guyZ], 'hull'), starboard = rec.anchor([quarterHalfBeam, transomY - 0.04, guyZ], 'hull');
  const cleat = rec.anchor([quarterHalfBeam * 0.35, transomY + 0.05, hullEndZ - 0.22], 'hull'), clew = rec.anchor(clewPos, 'cloth');
  rec.tube(transom, 0, -0.03, -0.35, tip, 0, 0, 0, 0.046, 0.034, 8, 6, 0);
  rec.tube(transom, 0, -0.38, -0.18, transom, 0, -0.01, 0.24, 0.036, 0.03, 6, 6, 0);
  rec.tube(transom, 0, -0.02, -0.03, transom, 0, -0.02, 0.04, 0.052, 0.052, 6, 6, 1);
  rec.tube(tip, 0, 0, -0.08, tip, 0, 0, 0.02, 0.046, 0.042, 6, 6, 1);
  rec.catenary(port, 0, 0, 0, tip, 0, 0, -0.04, 0.03, 0.016, 4, 7, 0.4);
  rec.catenary(starboard, 0, 0, 0, tip, 0, 0, -0.04, 0.03, 0.016, 4, 7, 0.4);
  rec.catenary(clew, 0, 0, 0, tip, 0, 0.03, -0.04, 0.04, 0.02, 6, 7, 0.5);
  rec.catenary(tip, 0, 0.03, -0.04, cleat, 0, 0, 0, 0.02, 0.016, 4, 7, 0.5);
}
function vesselTraceRig(modelId, rec) {
  if (modelId === 'taino-canoe') return;
  const stern = sternEnsignDesignStation({ modelId });
  const mid = (a, b) => [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1]), 0.5 * (a[2] + b[2])];
  if (modelId === 'victory') {
    for (const sail of VICTORY_SAILS) {
      if (sail.kind === 'square') {
        vesselParrelCollar(rec, rec.anchor(victoryMastPoint(sail.mast, sail.pivot[1]), 'mast'), rec.anchor(sail.pivot, 'yard'), VICTORY_MASTS[sail.mast]?.r0 ?? 0.1);
      } else if (sail.kind === 'spanker') {
        const [throat, peak, boomEnd, jaws] = sail.corners;
        vesselParrelCollar(rec, rec.anchor(victoryMastPoint(sail.mast, throat[1]), 'mast'), rec.anchor(throat, 'yard'), 0.085);
        rec.catenary(rec.anchor(victoryMastPoint(sail.mast, throat[1] + 0.82), 'mast'), 0, 0, 0, rec.anchor(peak, 'yard'), 0, 0, 0, 0.018, 0.015, 3, 7, 0.48);
        vesselParrelCollar(rec, rec.anchor(victoryMastPoint(sail.mast, jaws[1]), 'mast'), rec.anchor(jaws, 'yard'), 0.095);
        rec.catenary(rec.anchor(victoryMastPoint(sail.mast, throat[1] + 0.35), 'mast'), 0, 0, 0, rec.anchor(boomEnd, 'yard'), 0, 0, 0, 0.022, 0.015, 3, 7, 0.48);
      }
    }
    // The mizzen's crossjack yard, which carries no sail of its own.
    const crossjack = victoryMastPoint(2, 4.87);
    vesselParrelCollar(rec, rec.anchor(crossjack, 'mast'), rec.anchor([0, 4.87, crossjack[2] - 0.15], 'yard'), VICTORY_MASTS[2]?.r0 ?? 0.09);
    return;
  }
  const design = ADDITIONAL_DESIGNS[modelId] ?? ROWING_DESIGNS[modelId] ?? LATER_SAIL_DESIGNS[modelId] ?? null;
  if (modelId === 'nina' || !design) {
    for (const sail of SAIL_PLAN) {
      vesselParrelCollar(rec, rec.anchor(mastPoint(sail.mast, sail.pivot[1]), 'mast'), rec.anchor(sail.pivot, 'yard'), RIG_MASTS[sail.mast]?.r ?? 0.085);
    }
    const boat = { modelId: 'nina' };
    vesselOutlicker(rec, lateenRestPoint(2, 0, 1), 5.6, modelDeck(boat, 5.55) + 0.14, Math.max(0.42, modelDeckWidth(boat, 5.55) * 0.72), stern.z + 0.12);
    return;
  }
  const context = proceduralRigContext(modelId);
  if (!context?.surfaces?.length) return;
  for (const surface of context.surfaces) {
    if (surface.kind === 'headsail') continue;
    const mast = context.masts?.[surface.mast];
    const spar = surface.spars?.[0], headA = spar ? spar.a : surface.corners?.[0], headB = spar ? spar.b : surface.corners?.[1];
    if (surface.name === 'spritsail') {
      // Santa María's spritsail yard is slung under her bowsprit and lifted from its end.
      const yard = headA && headB ? mid(headA, headB) : surface.pivot, bs = design.bowsprit;
      const t = bs ? Math.max(0, Math.min(1, (yard[2] - bs.a[2]) / (bs.b[2] - bs.a[2] || -1))) : 0.65;
      const on = bs ? [0, 1, 2].map((k) => bs.a[k] + (bs.b[k] - bs.a[k]) * t) : [0, yard[1] + 0.12, yard[2]];
      vesselParrelCollar(rec, rec.anchor(on, bs ? 'bowsprit' : 'hull'), rec.anchor(yard, 'yard'), bs?.r0 ?? 0.065);
      if (headA && headB && bs) {
        const end = rec.anchor(bs.b, 'bowsprit');
        for (const h of [headA, headB]) rec.catenary(end, 0, 0, 0, rec.anchor([h[0] * 0.88, h[1], h[2]], 'yard'), 0, 0, 0, 0.015, 0.013, 3, 7, 0.45);
      }
      continue;
    }
    if (!mast) continue;
    const mastAt = (y) => (context.mastPoint ? context.mastPoint(surface.mast, y) : [0, y, mast.z ?? 0]);
    if (surface.kind === 'gaff' || surface.kind === 'bermudan') {
      for (const s of surface.spars ?? []) {
        vesselParrelCollar(rec, rec.anchor(mastAt(s.a[1]), 'mast'), rec.anchor(s.a, 'yard'), mast.radius ?? 0.075);
        const lift = Math.min(mast.topY ?? s.a[1] + 1.2, s.a[1] + 1.15);
        rec.catenary(rec.anchor(mastAt(lift), 'mast'), 0, 0, 0, rec.anchor(s.b, 'yard'), 0, 0, 0, 0.02, 0.014, 3, 7, 0.48);
      }
      if (surface.kind === 'bermudan' && surface.corners?.[0]) {
        const head = surface.corners[0];
        rec.tube(rec.anchor(mastAt(head[1]), 'mast'), 0, 0, 0, rec.anchor(head, 'cloth'), 0, 0, 0, 0.018, 0.016, 5, 7, 0.5);
      }
      continue;
    }
    const yard = spar ? mid(spar.a, spar.b) : surface.pivot;
    vesselParrelCollar(rec, rec.anchor(mastAt(yard[1]), 'mast'), rec.anchor(yard, 'yard'), mast.radius ?? 0.08);
    if (surface.kind === 'square' && headA && headB) {
      const lift = rec.anchor(mastAt(Math.min(mast.topY ?? yard[1] + 0.52, yard[1] + 0.52)), 'mast');
      for (const h of [headA, headB]) rec.catenary(lift, 0, 0, 0, rec.anchor([h[0] * 0.86, h[1], h[2]], 'yard'), 0, 0, 0, 0.015, 0.013, 3, 7, 0.45);
    }
  }
  // An overhanging mizzen lateen (Pinta's, Santa María's) is sheeted to a stern outlicker.
  const mizzen = context.surfaces.find((s) => s.kind === 'lateen' && (s.corners?.[2]?.[2] ?? 0) >= 5.5);
  if (mizzen) {
    const boat = { modelId };
    vesselOutlicker(rec, surfaceRestPoint(mizzen, 0, 1), 6, modelDeck(boat, 5.95) + 0.14, Math.max(0.48, modelDeckWidth(boat, 5.95) * 0.72), stern.z + 0.12);
  }
}

// ------------------------------------------------------------------------------------------------ anchors
// What each triangle of her assembly is, by the smallest group that names it: the parts an anchor may ride.
const VESSEL_DETAIL_SOFT = new Set([2, 9, 12, 13, 19, VESSEL_ENSIGN_MATERIAL, VESSEL_PENNANT_MATERIAL]);
function vesselTriangleKinds(vertices, indices, groups) {
  const T = indices.length / 3, leaf = new Int32Array(T).fill(-1);
  const order = groups.map((_, i) => i).sort((a, b) => groups[b].vertexCount - groups[a].vertexCount);
  for (const g of order) { const { firstVertex, vertexCount } = groups[g]; for (let i = firstVertex; i < firstVertex + vertexCount; i += 3) leaf[i / 3] = g; }
  const kinds = new Map(['hull', 'mast', 'yard', 'cloth', 'bowsprit', 'iron', 'ring'].map((k) => [k, []]));
  for (let t = 0; t < T; t++) {
    const id = leaf[t] >= 0 ? String(groups[leaf[t]].id) : '', m = Math.floor(vertices[indices[t * 3] * 9 + 6]);
    if (id === 'anchor.port.iron') kinds.get('iron').push(t);
    else if (id === 'anchor.port.ring') kinds.get('ring').push(t);
    else if (/^mast\./.test(id)) kinds.get('mast').push(t);
    else if (/^(yard|spar)\./.test(id)) kinds.get('yard').push(t);
    else if (/^sail\./.test(id) && (m === 9 || m === 13)) kinds.get('cloth').push(t);
    else if (/^bow\.bowsprit/.test(id)) kinds.get('bowsprit').push(t);
    else if (!/^(mast|yard|spar|sail|rig|rope|tackle|lookout|flag|anchor|helm|gun|hatch|rowing|boat|bow\.bowsprit)/.test(id) && !VESSEL_DETAIL_SOFT.has(m)) kinds.get('hull').push(t);
  }
  return kinds;
}
// The closest point of triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5), as its squared distance.
function vesselClosestSquared(p, a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const at = (q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]], d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return at([a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]); }
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return at([a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at([b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}
// Each anchor held by the triangle of its kind nearest it (a hull triangle when she has none of that kind): the
// triangle's corners and the anchor's place in its frame, in metres.
function vesselHoldAnchors(points, vertices, indices, kinds, scale) {
  const metres = (v) => [vertices[v * 9] * scale[0], vertices[v * 9 + 1] * scale[1], vertices[v * 9 + 2] * scale[2]];
  const spheres = new Map();
  const sphereOf = (kind) => {
    if (spheres.has(kind)) return spheres.get(kind);
    const list = kinds.get(kind).length ? kinds.get(kind) : kinds.get('hull'), out = [];
    for (const t of list) {
      const i = indices[t * 3], j = indices[t * 3 + 1], k = indices[t * 3 + 2];
      if (i === j || j === k || i === k) continue;
      const a = metres(i), b = metres(j), c = metres(k);
      const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], f = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const area = Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]);
      if (!(area > 1e-10) || !(Math.hypot(...e) > 1e-5)) continue;
      const centre = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      const radius = Math.max(...[a, b, c].map((q) => Math.hypot(q[0] - centre[0], q[1] - centre[1], q[2] - centre[2])));
      out.push({ t, a, b, c, centre, radius, area });
    }
    if (!out.length) throw Error(`No ${kind} triangle for a detail anchor`);
    spheres.set(kind, out);
    return out;
  };
  return points.map(({ p, kind }) => {
    const q = [p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]];
    let best = null, bestSquared = Infinity;
    for (const s of sphereOf(kind)) {
      const near = Math.hypot(q[0] - s.centre[0], q[1] - s.centre[1], q[2] - s.centre[2]) - s.radius;
      if (near > 0 && near * near > bestSquared + 1e-8) continue;
      const d = vesselClosestSquared(q, s.a, s.b, s.c);
      if (d < bestSquared - 1e-8 || (d <= bestSquared + 1e-8 && s.area > (best?.area ?? 0))) { best = s; bestSquared = Math.min(d, bestSquared); }
    }
    const { t, a, b, c } = best;
    const e1 = vesselDetailUnit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const f = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = vesselDetailUnit([e1[1] * f[2] - e1[2] * f[1], e1[2] * f[0] - e1[0] * f[2], e1[0] * f[1] - e1[1] * f[0]]);
    const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    const r = [q[0] - a[0], q[1] - a[1], q[2] - a[2]], dot = (x) => x[0] * r[0] + x[1] * r[1] + x[2] * r[2];
    return { corners: [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]], local: [dot(e1), dot(e2), dot(n)] };
  });
}

// Her rig's connectors at rest, as her detail records hold them: anchors (design units, z aft, each on the part it
// rides) and the tubes between them (each end an anchor's index in .w and an offset from it in .xyz; shape.z material).
export function vesselRigAtRest(modelId) {
  const rec = vesselRigRecorder();
  vesselTraceRig(modelId, rec);
  return rec;
}

// ------------------------------------------------------------------------------------------------ the static records
const VESSEL_DETAIL_HEADER = 8;
/**
 * Her detail layer and stations as the GPU passes read them (js/wgsl/vessel-detail.js), from her assembly as indexed
 * and fractured: `model` (vec4 records), and its counts. `lineVertexCount` is the vertices her pose pass writes after
 * her assembly's posed vertices (three vec4 each).
 */
export function buildVesselDetail({ model, vertices, indices, groups }) {
  const { boat, scale } = vesselDetailBoat(model);
  const vertexCount = vertices.length / 9;
  const kinds = vesselTriangleKinds(vertices, indices, groups);
  const rec = vesselRigAtRest(model.id);
  // Her mooring lines' fasts aboard: to a pier, then to a vessel; port, then starboard; line by line.
  const moorAt = rec.anchors.length;
  for (const [specs, fast] of [[VESSEL_PIER_LINES, vesselPierLineFast], [VESSEL_ALONGSIDE_LINES, vesselAlongsideLineFast]]) {
    for (const side of [-1, 1]) for (const spec of specs) { const p = fast(boat, spec.shipZ, side); rec.anchors.push({ p: [p[0], p[1], -p[2]], kind: 'hull' }); }
  }
  const equipment = anchorEquipment(boat);
  let fairAnchor = 0, origin = [0, 0, 0];
  if (equipment) {
    const fair = resolveShipNode(boat, 'anchor.port.fairlead', { space: 'design' });
    fairAnchor = rec.anchors.length;
    rec.anchors.push({ p: [fair[0], fair[1], fair[2]], kind: 'ring' });
    origin = [fair[0], fair[1] - (0.65 * equipment.renderScale) / scale[1], fair[2]];
  }
  const held = vesselHoldAnchors(rec.anchors, vertices, indices, kinds, scale);
  // Her tubes: the rig's, then her mooring lines', her gangplanks', and her rode's.
  const tubes = rec.tubes.slice();
  for (let line = 0; line < 4; line++) for (let k = 1; k <= VESSEL_MOOR_SEGMENTS; k++) {
    tubes.push({ a: [0, 0, 0, 0], b: [0, 0, 0, 0], cat: [(k - 1) / VESSEL_MOOR_SEGMENTS, k / VESSEL_MOOR_SEGMENTS, 0, line], shape: [VESSEL_MOOR_RADIUS, VESSEL_MOOR_RADIUS, 12, 1], sides: 5 });
  }
  for (const line of VESSEL_GANGPLANK_LINES) tubes.push({ a: [0, 0, 0, 0], b: [0, 0, 0, 0], cat: [0, 0, 0, line], shape: [VESSEL_GANGPLANK_WIDTH, VESSEL_GANGPLANK_THICKNESS, 1, 3], box: true });
  if (equipment) for (let k = 0; k < VESSEL_RODE_SPANS; k++) {
    tubes.push({ a: [0, 0, 0, 0], b: [0, 0, 0, 0], cat: [k / VESSEL_RODE_SPANS, (k + 1) / VESSEL_RODE_SPANS, 0, 0], shape: [equipment.rodeRadius, equipment.rodeRadius, 12, 2], sides: 5 });
  }
  const lineVertices = [];
  tubes.forEach((tube, index) => {
    if (tube.box) { for (let face = 0; face < 6; face++) for (let corner = 0; corner < 6; corner++) lineVertices.push(index, face, corner, 0); return; }
    for (let i = 0; i < tube.sides; i++) {
      const f0 = i / tube.sides, f1 = (i + 1) / tube.sides;
      for (const [ring, end] of [[f0, 0], [f1, 0], [f0, 1], [f0, 1], [f1, 0], [f1, 1]]) lineVertices.push(index, ring, end, 0);
    }
  });
  // Her stations: the corners of her colours' cloth, and of her working anchor's iron.
  const roles = new Map(), iron = groups.filter((g) => g.id === 'anchor.port.iron');
  for (let t = 0; t < indices.length / 3; t++) {
    const m = Math.floor(vertices[indices[t * 3] * 9 + 6]);
    const role = m === VESSEL_ENSIGN_MATERIAL ? 0 : m === VESSEL_PENNANT_MATERIAL ? 1 : -1;
    if (role >= 0) for (let k = 0; k < 3; k++) roles.set(indices[t * 3 + k], role);
  }
  for (const g of iron) for (let i = g.firstVertex; i < g.firstVertex + g.vertexCount; i++) roles.set(indices[i], 2);
  const stations = [...roles].sort((a, b) => a[0] - b[0]);

  const anchorsAt = VESSEL_DETAIL_HEADER, tubesAt = anchorsAt + held.length * 2, linesAt = tubesAt + tubes.length * 4, lineVertexCount = lineVertices.length / 4;
  const stationsAt = linesAt + lineVertexCount, records = new Float32Array((stationsAt + stations.length) * 4);
  const cn = crowsNestDesignStation(boat), stern = sternEnsignDesignStation(boat);
  records.set([held.length, tubes.length, lineVertexCount, stations.length], 0);
  records.set([anchorsAt, tubesAt, linesAt, stationsAt], 4);
  records.set([stern.x, stern.y, stern.z, stern.showEnsign ? 1 : 0], 8);
  records.set([cn.x, cn.y + cn.pennantLift, cn.headZ ?? cn.z, cn.showPennant ? 1 : 0], 12);
  records.set([...origin, equipment ? 1 : 0], 16);
  records.set([moorAt, fairAnchor, 0, 0], 20);
  records.set([vertexCount, equipment?.renderScale ?? 0, equipment?.rodeRadius ?? 0, 0], 24);
  held.forEach(({ corners, local }, i) => records.set([...corners, 0, ...local, 0], (anchorsAt + i * 2) * 4));
  tubes.forEach((tube, i) => records.set([...tube.a, ...tube.b, ...tube.cat, ...tube.shape], (tubesAt + i * 4) * 4));
  records.set(lineVertices, linesAt * 4);
  stations.forEach(([v, role], i) => records.set([v, role, 0, 0], (stationsAt + i) * 4));
  if (!records.every(Number.isFinite)) throw Error(`Non-finite detail records for ${model.id}`);
  return Object.freeze({ modelId: model.id, model: records, lineVertexCount, stationCount: stations.length, anchorCount: held.length, tubeCount: tubes.length });
}

// ------------------------------------------------------------------------------------------------ her compact state
export const VESSEL_DETAIL_STATE_FLOATS = 64;
/**
 * Her compact state for the frame, all the CPU sends of her detail: the code of the colours she wears and whether she
 * has struck; the wind ([direction x, z], speed); her anchor's state (js/anchor-state.js); and her mooring
 * (js/boarding-docking.js mooringLinesState), or null.
 */
export function writeVesselDetailState(target, { boat, code = 1, surrendered = false, wind = [0.7, 0.7, 8], anchor = null, mooring = null }) {
  if (!(target instanceof Float32Array) || target.length !== VESSEL_DETAIL_STATE_FLOATS) throw Error('Vessel detail state has the wrong shape');
  target.fill(0);
  target.set([code, surrendered ? 1 : 0, wind[0], wind[1], wind[2]], 0);
  if (anchor?.installed && anchor.phase !== 'stowed') {
    const p = anchor.position;
    target.set([p.x, p.y, p.z, 1, ((anchor.worldHeading ?? 0) * Math.PI) / 180, anchor.rode, anchor.bed ?? -120, anchorEyeOffset(boat)], 8);
  }
  if (mooring?.lines) {
    target.set([mooring.progress, mooring.tension, mooring.castingOff ? 1 : 0, mooring.gangplank, mooring.lines, mooring.vessel ? 1 : 0, mooring.side, 0], 16);
    mooring.far.forEach((p, i) => { if (i < 4) target.set([p[0], p[1], p[2], 0], 24 + i * 4); });
    const other = mooring.target;
    if (other) {
      const frame = vesselHull(other).frame, h = ((other.heading ?? 0) * Math.PI) / 180, axis = [0, 0, 0];
      const scales = [(other.beam ?? frame.beam) / frame.beam, frame.verticalScale, (other.length ?? frame.length) / frame.length];
      [[1, 0, 0], [0, 1, 0], [0, 0, -1]].forEach((d, k) => {
        boatRotate(axis, d[0], d[1], d[2], h, other.pitch ?? 0, other.roll ?? 0);
        target.set([...axis, scales[k]], 40 + k * 4);
      });
      target.set([other.x ?? 0, other.heave ?? 0, other.z ?? 0, 0], 52);
    }
  }
  return target;
}

// ------------------------------------------------------------------------------------------------ the GPU passes
const vesselDetailOwners = new WeakMap();
/**
 * Her detail's two passes over her posed vertices (`posedBuffer`, with room for her lines after her assembly's):
 * encodeStations after her parts are assembled, encodeLines after her shards fly (`fracture`, her
 * createShipFractureGPU, whose shards and flights say which anchors are still aboard).
 */
export async function createVesselDetailGPU({ device, computePipe, posedBuffer, sourceBuffer, hullUBO, detail, fracture = null, shared = null }) {
  let assets = shared;
  if (!assets) {
    const [stations, lines] = await Promise.all([
      detail.stationCount ? computePipe(VESSEL_DETAIL_STATIONS, 'vessel detail stations') : null,
      detail.lineVertexCount ? computePipe(VESSEL_DETAIL_LINES, 'vessel detail lines') : null,
    ]);
    const model = device.createBuffer({ label: `${detail.modelId} detail records`, size: detail.model.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(model, 0, detail.model);
    // Every vertex aboard when she has no fracture: shard 0 throughout.
    const aboard = device.createBuffer({ label: 'vessel detail, all aboard', size: 16, usage: GPUBufferUsage.STORAGE });
    assets = Object.freeze({ device, detail, stations, lines, model, aboard });
    vesselDetailOwners.set(assets, { references: 0 });
  }
  const owner = vesselDetailOwners.get(assets);
  owner.references++;
  const state = device.createBuffer({ label: `${detail.modelId} detail state`, size: VESSEL_DETAIL_STATE_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bind = (pipeline, buffers) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const stationsGroup = assets.stations ? bind(assets.stations, [hullUBO, posedBuffer, sourceBuffer, assets.model, state]) : null;
  const linesGroup = assets.lines ? bind(assets.lines, [hullUBO, posedBuffer, assets.model, fracture?.assets.vertexShards ?? assets.aboard, fracture?.records ?? assets.aboard, state]) : null;
  let destroyed = false;
  return {
    assets,
    update(values) { if (!destroyed) device.queue.writeBuffer(state, 0, values); },
    encodeStations(pass) {
      if (destroyed || !stationsGroup) return;
      pass.setPipeline(assets.stations); pass.setBindGroup(0, stationsGroup); pass.dispatchWorkgroups(Math.ceil(detail.stationCount / 64));
    },
    encodeLines(pass) {
      if (destroyed || !linesGroup) return;
      pass.setPipeline(assets.lines); pass.setBindGroup(0, linesGroup); pass.dispatchWorkgroups(Math.ceil(detail.lineVertexCount / 64));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      state.destroy();
      if (--owner.references === 0) { assets.model.destroy(); assets.aboard.destroy(); }
    },
  };
}
