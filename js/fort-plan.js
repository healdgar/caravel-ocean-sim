// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Where an enclosing fort's walls stand. The geometry builder draws from this plan and the town
// layout keeps buildings clear of it, so the two cannot disagree.
// Plans are in the fort's own frame, in metres: +X across, +Z from the gate towards the far bastion.
const TRIANGULAR_FORT = 'english_triangular_palisade_fort';
const PALISADE_RING = 'indigenous_palisade_ring';
const RING_POSTS = 28;
// Between a wall's centre line and a building: the firing step or berm, and room to walk.
const FORT_WALL_CLEARANCE_M = 3.5;
// Where a curtain stops, past the bastion's radius, so that its end is buried in the parapet.
const CURTAIN_INTO_PARAPET_M = 0.1;
// A wall's thickness, taken off each side of a parapet opening so that no curtain meets one.
const EMBRASURE_WALL_MARGIN = (3 * Math.PI) / 180;
// One bay in six of a bastion's parapet is left open for a gun.
const EMBRASURE_EVERY_BAYS = 6;
const BASTION_BAYS = 24;

function bastionGunOnBay([bx, bz], bastionRadius, bay) {
  const angle = ((bay + 0.5) / BASTION_BAYS) * Math.PI * 2;
  const nx = Math.cos(angle), nz = Math.sin(angle);
  const rCarriage = Math.max(0.8, bastionRadius - 0.95);
  return { x: bx + nx * rCarriage, z: bz + nz * rCarriage, nx, nz };
}
// The sample spacing when checking the ground under a wall.
const WALL_GROUND_STEP_M = 8;
const FORT_GATE_HALF_WIDTH_M = 2.2;
// How far either side of its gate a way is held straight, so that smoothing cannot cut through the wall.
const GATE_APPROACH_M = 7;
// Nothing is built in front of a gate or just behind it, or the people inside could not get out.
const GATE_APRON_HALF_WIDTH_M = 5;
const GATE_APRON_REACH_M = 14;
// How far either side of a wall's centre line there is no walking: wall, firing step and berm.
export const WALL_SOLID_HALF_WIDTH_M = 1.5;

// Verified via CADCraft v0.18.0 (`assets/artcraft/fort-trace-italienne.dxf`):
// 16th-century trace italienne bastion-to-curtain geometric ratios.
export const CADCRAFT_TRACE_ITALIENNE_RATIOS = Object.freeze({
  cornerInsetRatio: 0.86,
  bastionRadiusRatio: 0.24,
  maxBastionRadiusM: 6.4,
  wallClearanceM: FORT_WALL_CLEARANCE_M,
  wallSolidHalfWidthM: WALL_SOLID_HALF_WIDTH_M,
  gateHalfWidthM: FORT_GATE_HALF_WIDTH_M,
  embrasureEveryBays: EMBRASURE_EVERY_BAYS,
  bastionBays: BASTION_BAYS,
});

function curtainBetween([ax, az], [bx, bz], stop) {
  const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz) || 1;
  const ux = dx / length, uz = dz / length;
  return [[ax + ux * stop, az + uz * stop], [bx - ux * stop, bz - uz * stop]];
}

// A gate in a curtain at (mx, mz), looking along (nx, nz), with what keeps the way through it open.
function gateOnCurtain(mx, mz, nx, nz) {
  const ux = -nz, uz = nx, at = (a, b) => [mx + ux * a + nx * b, mz + uz * a + nz * b];
  return {
    gate: { x: mx, z: mz, nx, nz, ux, uz },
    gateEdges: [at(-FORT_GATE_HALF_WIDTH_M, 0), at(FORT_GATE_HALF_WIDTH_M, 0)],
    gateApron: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => at(a * GATE_APRON_HALF_WIDTH_M, b * GATE_APRON_REACH_M)),
    gateApproach: [-1, 1].map((side) => {
      const a = side * (FORT_GATE_HALF_WIDTH_M + WALL_SOLID_HALF_WIDTH_M);
      return [at(a, -GATE_APPROACH_M), at(a, GATE_APPROACH_M)];
    }),
  };
}

// The gate is in the curtain a side's sign picks: 0 the river curtain, as James Fort's principal gate was; -1 the west
// flank and +1 the east, for a fort whose gate must face inland. The houses keep clear of whichever it is.
export function triangularFortPlan(width, length, gateSide = 0) {
  const hw = width * 0.5, hl = length * 0.5;
  const sw = [-hw * 0.86, -hl * 0.72], se = [hw * 0.86, -hl * 0.72], north = [0, hl * 0.86];
  const bastionRadius = Math.min(6.4, Math.min(hw, hl) * 0.24);
  const stop = bastionRadius + CURTAIN_INTO_PARAPET_M;
  const river = curtainBetween(sw, se, stop), west = curtainBetween(sw, north, stop), east = curtainBetween(se, north, stop);
  const gateZ = river[0][1];
  const flank = gateSide < 0 ? west : east;
  const midX = (flank[0][0] + flank[1][0]) * 0.5, midZ = (flank[0][1] + flank[1][1]) * 0.5;
  const fx = flank[1][0] - flank[0][0], fz = flank[1][1] - flank[0][1], fl = Math.hypot(fx, fz) || 1;
  const opening = gateSide
    ? gateOnCurtain(midX, midZ, Math.sign(gateSide) * (Math.abs(fz) / fl), Math.abs(fx) / fl)
    : gateOnCurtain(0, gateZ, 0, -1);
  // Along the curtain from its southern end to the gate, and from the gate on to the far bulwark.
  const [one, two] = opening.gateEdges, nearest = Math.hypot(one[0] - flank[0][0], one[1] - flank[0][1]) < Math.hypot(two[0] - flank[0][0], two[1] - flank[0][1]);
  const spans = gateSide
    ? [river, gateSide < 0 ? east : west, [flank[0], nearest ? one : two], [nearest ? two : one, flank[1]]]
    : [[river[0], [-FORT_GATE_HALF_WIDTH_M, gateZ]], [[FORT_GATE_HALF_WIDTH_M, gateZ], river[1]], west, east];
  const m = gateSide > 0 ? -1 : 1, turned = gateSide > 0 ? Math.PI : 0, facing = gateSide > 0 ? 0 : Math.PI;
  return {
    bastions: [sw, se, north],
    bastionRadius,
    // The river curtain, then the west and east curtains. gateCurtain says which holds the gate.
    curtains: [river, west, east],
    gateCurtain: gateSide < 0 ? 1 : gateSide > 0 ? 2 : 0,
    gateHalfWidth: FORT_GATE_HALF_WIDTH_M,
    wallSpans: spans,
    ...opening,
    outline: [sw, se, north],
    guardhouse: gateSide
      ? { x: m * -13.5, z: 4.5, halfWidth: 3.4, halfLength: 4.2 }
      : { x: -Math.min(8.5, hw * 0.22), z: sw[1] + Math.min(5.2, hl * 0.22), halfWidth: Math.min(3.4, hw * 0.18), halfLength: Math.min(4.2, hl * 0.2) },
    // Slots are [x, z, turn]: set back from the walls, which lean in, with a street's width between
    // neighbours. A house's door is in its -X wall, so the west row turns to face the parade too.
    hallSlot: gateSide ? [0, 6, 0] : [0, 0, 0],
    cottageSlots: gateSide
      ? [[m * 14.5, -3, turned], [m * -15, -21, facing], [m * 27.8, -20.5, turned], [0, -20, turned]]
      : [[14.5, -3, 0], [-14.5, -3, Math.PI], [27.8, -20.5, 0], [-27.8, -20.5, Math.PI]],
    // Mounted on the raised circular corner bulwark decks behind their open embrasure bays.
    guns: [
      bastionGunOnBay(sw, bastionRadius, 18),
      bastionGunOnBay(sw, bastionRadius, 12),
      bastionGunOnBay(se, bastionRadius, 18),
      bastionGunOnBay(north, bastionRadius, 6),
    ],
  };
}

// The Dutch and French manner: four sides, a bastion at each corner, the gate in the side away from the water.
export function squareFortPlan(width, length) {
  const hw = width * 0.5, hl = length * 0.5;
  const corners = [[-hw * 0.86, -hl * 0.86], [hw * 0.86, -hl * 0.86], [hw * 0.86, hl * 0.86], [-hw * 0.86, hl * 0.86]];
  const bastionRadius = Math.min(6.4, Math.min(hw, hl) * 0.24), stop = bastionRadius + CURTAIN_INTO_PARAPET_M;
  const front = curtainBetween(corners[0], corners[1], stop), east = curtainBetween(corners[1], corners[2], stop);
  const back = curtainBetween(corners[3], corners[2], stop), west = curtainBetween(corners[0], corners[3], stop);
  const gateZ = corners[2][1], opening = gateOnCurtain(0, gateZ, 0, 1);
  return {
    bastions: corners,
    bastionRadius,
    curtains: [front, west, east, back],
    gateCurtain: 3,
    gateHalfWidth: FORT_GATE_HALF_WIDTH_M,
    wallSpans: [front, west, east, [back[0], [-FORT_GATE_HALF_WIDTH_M, gateZ]], [[FORT_GATE_HALF_WIDTH_M, gateZ], back[1]]],
    ...opening,
    outline: corners,
    guardhouse: { x: -10, z: gateZ - 8.6, halfWidth: 3.4, halfLength: 4.2 },
    hallSlot: [0, -6, 0],
    cottageSlots: (() => {
      const cx = Math.min(22, Math.max(8, hw * 0.86 - FORT_WALL_CLEARANCE_M - 4.5));
      const czSouth = -Math.min(14, Math.max(6, hl * 0.86 - FORT_WALL_CLEARANCE_M - 4.5));
      const czNorth = Math.min(12, Math.max(5, hl * 0.86 - FORT_WALL_CLEARANCE_M - 5.5));
      return [[cx, czSouth, 0], [-cx, czSouth, Math.PI], [cx, czNorth, 0], [-cx, czNorth, Math.PI]];
    })(),
    guns: [
      bastionGunOnBay(corners[0], bastionRadius, 18),
      bastionGunOnBay(corners[0], bastionRadius, 12),
      bastionGunOnBay(corners[1], bastionRadius, 18),
      bastionGunOnBay(corners[2], bastionRadius, 6),
    ],
  };
}

// A ring's baffled entrance is on its -Z side, where no post stands.
export const ringPostIsGate = (angle) => Math.abs(Math.sin(angle) + 1) < 0.07 && Math.abs(Math.cos(angle)) < 0.32;

export function palisadeRingPlan(width, length) {
  const radiusX = width * 0.5 * 0.9, radiusZ = length * 0.5 * 0.9, outline = [], wallSpans = [];
  const angleOf = (post) => (post / RING_POSTS) * Math.PI * 2;
  for (let post = 0; post < RING_POSTS; post++) {
    outline.push([Math.cos(angleOf(post)) * radiusX, Math.sin(angleOf(post)) * radiusZ]);
  }
  for (let post = 0; post < RING_POSTS; post++) {
    const next = (post + 1) % RING_POSTS;
    if (!ringPostIsGate(angleOf(post)) && !ringPostIsGate(angleOf(next))) wallSpans.push([outline[post], outline[next]]);
  }
  return { radiusX, radiusZ, bastions: [], bastionRadius: 0, outline, wallSpans, guardhouse: null };
}

export function enclosurePlan(inst) {
  if (inst.prefabId === TRIANGULAR_FORT) return inst.enclosureShape === 'square' ? squareFortPlan(inst.width, inst.length) : triangularFortPlan(inst.width, inst.length, inst.gateSide ?? 0);
  if (inst.prefabId === PALISADE_RING) return palisadeRingPlan(inst.width, inst.length);
  return null;
}

// Parapet bays run counter-clockwise from +X. A gun's opening never falls where a curtain joins.
export function bastionBayIsEmbrasure(plan, bastion, bay, bays) {
  if (bay % EMBRASURE_EVERY_BAYS !== 0) return false;
  const [bx, bz] = plan.bastions[bastion], halfBay = Math.PI / bays;
  const middle = ((bay + 0.5) / bays) * Math.PI * 2;
  return !plan.bastions.some(([ox, oz], other) => {
    if (other === bastion) return false;
    const turn = Math.atan2(oz - bz, ox - bx) - middle;
    return Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) < halfBay + EMBRASURE_WALL_MARGIN;
  });
}

// Whether a point stands on an enclosure's wall or bastion, rather than in its gate or clear of it.
// A ring has no doors inside it, so nobody walks into one at all.
export function pointOnEnclosureWall(enclosure, plan, x, z, halfWidth = WALL_SOLID_HALF_WIDTH_M) {
  if (!plan.gateHalfWidth) return pointWithinEnclosure(enclosure, plan, x, z, halfWidth);
  const [lx, lz] = worldToFortLocal(enclosure, x, z);
  if (plan.bastions.some(([bx, bz]) => Math.hypot(lx - bx, lz - bz) <= plan.bastionRadius + halfWidth)) return true;
  return [...plan.wallSpans, ...(plan.gateApproach ?? [])].some(([[ax, az], [bx, bz]]) => {
    const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz) || 1;
    const along = ((lx - ax) * dx + (lz - az) * dz) / length;
    if (along < 0 || along > length) return false;
    return Math.abs((lx - ax) * dz - (lz - az) * dx) / length <= halfWidth;
  });
}

// Whether a point lies within `margin` of an enclosure's walls, or anywhere inside them.
export function pointWithinEnclosure(enclosure, plan, x, z, margin) {
  const local = worldToFortLocal(enclosure, x, z);
  if (depthInConvexOutline(local, plan.outline) >= -margin) return true;
  return plan.bastions.some(([bx, bz]) => Math.hypot(local[0] - bx, local[1] - bz) <= plan.bastionRadius + margin);
}

export function fortLocalToWorld(fort, lx, lz) {
  const c = Math.cos(fort.yaw), s = Math.sin(fort.yaw);
  return { x: fort.x + lx * c + lz * s, z: fort.z - lx * s + lz * c };
}

function worldToFortLocal(fort, x, z) {
  const c = Math.cos(fort.yaw), s = Math.sin(fort.yaw), dx = x - fort.x, dz = z - fort.z;
  return [dx * c - dz * s, dx * s + dz * c];
}

function footprintCorners(x, z, yaw, width, length) {
  const c = Math.cos(yaw), s = Math.sin(yaw), hw = width * 0.5, hl = length * 0.5;
  return [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]].map(([lx, lz]) => [x + lx * c + lz * s, z - lx * s + lz * c]);
}

// Whether two convex outlines leave `gap` metres between them along some axis.
function convexOutlinesApart(a, b, gap = 0) {
  for (const outline of [a, b]) {
    for (let i = 0; i < outline.length; i++) {
      const [px, pz] = outline[i], [qx, qz] = outline[(i + 1) % outline.length];
      const length = Math.hypot(qx - px, qz - pz) || 1;
      const nx = (pz - qz) / length, nz = (qx - px) / length;
      let aLow = Infinity, aHigh = -Infinity, bLow = Infinity, bHigh = -Infinity;
      for (const [x, z] of a) { const d = x * nx + z * nz; if (d < aLow) aLow = d; if (d > aHigh) aHigh = d; }
      for (const [x, z] of b) { const d = x * nx + z * nz; if (d < bLow) bLow = d; if (d > bHigh) bHigh = d; }
      if (aLow - bHigh >= gap || bLow - aHigh >= gap) return true;
    }
  }
  return false;
}

// How far inside a convex outline a point lies, to its nearest edge; negative when outside.
function depthInConvexOutline([x, z], outline) {
  let area = 0;
  for (let i = 0; i < outline.length; i++) {
    const [px, pz] = outline[i], [qx, qz] = outline[(i + 1) % outline.length];
    area += px * qz - qx * pz;
  }
  const winding = area < 0 ? -1 : 1;
  let depth = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const [px, pz] = outline[i], [qx, qz] = outline[(i + 1) % outline.length];
    const edge = Math.hypot(qx - px, qz - pz) || 1;
    depth = Math.min(depth, (winding * ((qx - px) * (z - pz) - (qz - pz) * (x - px))) / edge);
  }
  return depth;
}

function outlineReachesDisc(outline, [cx, cz], radius) {
  if (depthInConvexOutline([cx, cz], outline) >= 0) return true;
  for (let i = 0; i < outline.length; i++) {
    const [px, pz] = outline[i], [qx, qz] = outline[(i + 1) % outline.length];
    const dx = qx - px, dz = qz - pz;
    const t = Math.max(0, Math.min(1, ((cx - px) * dx + (cz - pz) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(px + dx * t - cx, pz + dz * t - cz) < radius) return true;
  }
  return false;
}

function worldOutline(inst, plan) {
  return plan.outline.map(([lx, lz]) => {
    const { x, z } = fortLocalToWorld(inst, lx, lz);
    return [x, z];
  });
}

// Which side of an enclosure's walls a footprint stands on: 'inside', 'outside', or 'crossing'
// when it comes within `clearance` of a wall, a bastion or the fort's guardhouse.
export function footprintSide(enclosure, x, z, yaw, width, length, clearance = FORT_WALL_CLEARANCE_M) {
  const plan = enclosurePlan(enclosure);
  const corners = footprintCorners(x, z, yaw, width, length).map(([cx, cz]) => worldToFortLocal(enclosure, cx, cz));
  if (plan.bastions.some((bastion) => outlineReachesDisc(corners, bastion, plan.bastionRadius + clearance))) return 'crossing';
  if (plan.gateApron && !convexOutlinesApart(corners, plan.gateApron)) return 'crossing';
  if (corners.every((corner) => depthInConvexOutline(corner, plan.outline) >= clearance)) {
    const keep = plan.guardhouse;
    if (!keep) return 'inside';
    const house = [[keep.x - keep.halfWidth, keep.z - keep.halfLength], [keep.x + keep.halfWidth, keep.z - keep.halfLength],
      [keep.x + keep.halfWidth, keep.z + keep.halfLength], [keep.x - keep.halfWidth, keep.z + keep.halfLength]];
    return convexOutlinesApart(corners, house, clearance) ? 'inside' : 'crossing';
  }
  return convexOutlinesApart(corners, plan.outline, clearance) ? 'outside' : 'crossing';
}

// A building may stand wholly inside the fort it belongs to, and wholly outside every other.
export function footprintFitsEnclosures(instances, x, z, yaw, width, length, home = null) {
  for (const other of instances) {
    if (!enclosurePlan(other)) continue;
    if (footprintSide(other, x, z, yaw, width, length) !== (other === home ? 'inside' : 'outside')) return false;
  }
  return true;
}

// Nothing already placed stands on this enclosure's line, and it stands apart from any other.
export function enclosureSiteIsClear(candidate, instances) {
  const plan = enclosurePlan(candidate);
  const outline = worldOutline(candidate, plan);
  for (const other of instances) {
    const otherPlan = enclosurePlan(other);
    if (otherPlan) {
      const gap = plan.bastionRadius + otherPlan.bastionRadius + FORT_WALL_CLEARANCE_M;
      if (!convexOutlinesApart(outline, worldOutline(other, otherPlan), gap)) return false;
    } else if (footprintSide(candidate, other.x, other.z, other.yaw, other.width, other.length) !== 'outside') {
      return false;
    }
  }
  return true;
}

// Points along an enclosure's walls and at its bastions, for reading the ground they stand on.
export function enclosureGroundPoints(candidate) {
  const plan = enclosurePlan(candidate);
  const points = plan.bastions.map(([lx, lz]) => fortLocalToWorld(candidate, lx, lz));
  if (plan.gate) {
    const { x, z, nx, nz } = plan.gate;
    points.push(fortLocalToWorld(candidate, x + nx * GATE_APRON_REACH_M, z + nz * GATE_APRON_REACH_M), fortLocalToWorld(candidate, x + nx * GATE_APRON_REACH_M * 0.5, z + nz * GATE_APRON_REACH_M * 0.5));
  }
  plan.outline.forEach(([ax, az], i) => {
    const [bx, bz] = plan.outline[(i + 1) % plan.outline.length];
    const stops = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / WALL_GROUND_STEP_M));
    for (let s = 0; s < stops; s++) points.push(fortLocalToWorld(candidate, ax + ((bx - ax) * s) / stops, az + ((bz - az) * s) / stops));
  });
  return points;
}

// ---------------------------------------------------------------------------------------------------------------------
// A stone or earth fort's trace: the line of its walls, drawn to fit the ground it stands on. Worked out once, when the
// port is laid out, and kept on the building. The geometry builder, the guns and the garrison all read it.
// In the fort's own frame -Z looks at the water it guards. Outlines run so that a wall's outside is on the right hand
// going round, as x then z increase: (uz, -ux) for a wall running along (ux, uz).
// ---------------------------------------------------------------------------------------------------------------------
export const TRACE_PARAPET_M = 1.75;
export const TRACE_RAMPART_EDGE_M = 2.1;
export const TRACE_BATTER_M = 1.6;
// How far a trace's scarp and fittings stand beyond its line. A building's footprint is the line and this much more.
const TRACE_OVERHANG_M = 4;
const TRACE_GUN_ARC_DEGREES = 65;
export const TRACE_GUN_ARC_COS = Math.cos((TRACE_GUN_ARC_DEGREES * Math.PI) / 180);
const TRACE_GATE_HALF_WIDTH_M = 1.9;
const GUN_APART_M = 4;
const DRUM_SIDES = 16;
const RAY_STEP_M = 3;
const FIT_RAYS = 32;

export function outlineArea(outline) {
  let area = 0;
  for (let i = 0; i < outline.length; i++) {
    const [ax, az] = outline[i], [bx, bz] = outline[(i + 1) % outline.length];
    area += ax * bz - bx * az;
  }
  return area * 0.5;
}

// Metres inside the outline, to the nearest wall. Negative outside it. Any simple outline.
export function depthInOutline(outline, x, z) {
  let inside = false, nearest = Infinity;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ax, az] = outline[i], [bx, bz] = outline[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
    const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    nearest = Math.min(nearest, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return inside ? nearest : -nearest;
}

// Triangles over a simple outline, as indices, by clipping ears.
export function triangulateOutline(outline) {
  const left = outline.map((_, i) => i), triangles = [];
  const cross = (a, b, c) => (outline[b][0] - outline[a][0]) * (outline[c][1] - outline[a][1]) - (outline[b][1] - outline[a][1]) * (outline[c][0] - outline[a][0]);
  const inTriangle = (p, a, b, c) => cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
  let guard = outline.length * outline.length + 8;
  while (left.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < left.length; i++) {
      const a = left[(i + left.length - 1) % left.length], b = left[i], c = left[(i + 1) % left.length];
      if (cross(a, b, c) <= 1e-9) continue;
      if (left.some((p) => p !== a && p !== b && p !== c && inTriangle(p, a, b, c))) continue;
      triangles.push(a, b, c);
      left.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (left.length === 3) triangles.push(left[0], left[1], left[2]);
  return triangles;
}

// The outline moved inward by a distance, corners mitred and the mitre limited at sharp points.
export function insetOutline(outline, inward) {
  const count = outline.length;
  return outline.map((point, i) => {
    const before = outline[(i + count - 1) % count], after = outline[(i + 1) % count];
    let ax = point[0] - before[0], az = point[1] - before[1], bx = after[0] - point[0], bz = after[1] - point[1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    // The way in from each wall is on its left hand going round.
    const nx = -az - bz, nz = ax + bx, length = Math.hypot(nx, nz) || 1, half = (nx / length) * -az + (nz / length) * ax;
    const reach = inward / Math.max(0.42, half);
    return [point[0] + (nx / length) * reach, point[1] + (nz / length) * reach];
  });
}

// Simplify a closed line, keeping corners that stand out by more than a tolerance.
function simplifyClosed(points, tolerance, most) {
  const keep = new Set([0, points.length >> 1]);
  const split = (from, to) => {
    let worst = -1, worstAt = -1;
    const [ax, az] = points[from], [bx, bz] = points[to % points.length], dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz) || 1;
    for (let i = from + 1; i < to; i++) {
      const d = Math.abs((points[i][0] - ax) * dz - (points[i][1] - az) * dx) / length;
      if (d > worst) { worst = d; worstAt = i; }
    }
    if (worstAt >= 0 && worst > tolerance) {
      keep.add(worstAt);
      split(from, worstAt);
      split(worstAt, to);
    }
  };
  const half = points.length >> 1;
  split(0, half);
  split(half, points.length);
  const kept = [...keep].sort((a, b) => a - b).map((i) => points[i]);
  // Too many corners: the least of them goes first.
  while (kept.length > most) {
    let least = Infinity, leastAt = 0;
    kept.forEach((p, i) => {
      const a = kept[(i + kept.length - 1) % kept.length], b = kept[(i + 1) % kept.length], dx = b[0] - a[0], dz = b[1] - a[1];
      const d = Math.abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / (Math.hypot(dx, dz) || 1);
      if (d < least) { least = d; leastAt = i; }
    });
    kept.splice(leastAt, 1);
  }
  return kept;
}

function withoutShortWalls(outline, least) {
  let out = outline;
  for (let pass = 0; pass < 8; pass++) {
    const at = out.findIndex((p, i) => Math.hypot(out[(i + 1) % out.length][0] - p[0], out[(i + 1) % out.length][1] - p[1]) < least);
    if (at < 0 || out.length <= 4) return out;
    out = out.filter((_, i) => i !== at);
  }
  return out;
}

// Each wall has a kind: curtain, or the face or flank of a bastion, or front (a battery's water front). A bastion takes
// the place of a corner, its flanks standing square to the curtains and its faces running out to a point.
function traceWithBastions(base, wantsBastion) {
  const outline = [], kinds = [], salients = [], count = base.length;
  const lengthOf = (i) => Math.hypot(base[(i + 1) % count][0] - base[i][0], base[(i + 1) % count][1] - base[i][1]);
  for (let i = 0; i < count; i++) {
    const p = base[i], before = base[(i + count - 1) % count], after = base[(i + 1) % count];
    const la = lengthOf((i + count - 1) % count), lb = lengthOf(i);
    const ax = (p[0] - before[0]) / la, az = (p[1] - before[1]) / la, bx = (after[0] - p[0]) / lb, bz = (after[1] - p[1]) / lb;
    const turn = ax * bz - az * bx;
    if (!(turn > 0.25) || !wantsBastion(i, p) || Math.min(la, lb) < 22) {
      outline.push(p);
      kinds.push('curtain');
      continue;
    }
    const flank = Math.min(9.5, Math.max(4.8, Math.min(la, lb) * 0.17)), shoulder = flank * 0.8, out = flank * 1.6;
    const ox = ax - bx, oz = az - bz, ol = Math.hypot(ox, oz) || 1;
    outline.push([p[0] - ax * flank, p[1] - az * flank]);
    kinds.push('flank');
    outline.push([p[0] - ax * flank + az * shoulder, p[1] - az * flank - ax * shoulder]);
    kinds.push('face');
    salients.push(outline.length);
    outline.push([p[0] + (ox / ol) * out, p[1] + (oz / ol) * out]);
    kinds.push('face');
    outline.push([p[0] + bx * flank + bz * shoulder, p[1] + bz * flank - bx * shoulder]);
    kinds.push('flank');
    outline.push([p[0] + bx * flank, p[1] + bz * flank]);
    kinds.push('curtain');
  }
  return { outline, kinds, salients };
}

function rectangleBase(hw, hl) { return [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]]; }

// One point to the water, as Sao Juliao had three bastions seaward and two to the land.
function pentagonBase(hw, hl) {
  const base = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    base.push([Math.cos(a) * hw, Math.sin(a) * hl]);
  }
  return base;
}

// A line round whatever land there is about the origin, no further than an ellipse: a fort drawn to fit its ground.
function fittedBase(landAt, reachX, reachZ, margin, tolerance, most) {
  let centreX = 0, centreZ = 0, rays = [];
  for (let pass = 0; pass < 4; pass++) {
    rays = [];
    for (let r = 0; r < FIT_RAYS; r++) {
      const angle = (r / FIT_RAYS) * Math.PI * 2, dx = Math.cos(angle), dz = Math.sin(angle);
      const reach = 1 / Math.hypot(dx / reachX, dz / reachZ);
      let d = 0;
      while (d + RAY_STEP_M <= reach && landAt(centreX + dx * (d + RAY_STEP_M), centreZ + dz * (d + RAY_STEP_M))) d += RAY_STEP_M;
      rays.push(Math.max(0, d - margin));
    }
    // Stand in the middle of the ground it has.
    let sumX = 0, sumZ = 0;
    rays.forEach((d, r) => {
      const angle = (r / FIT_RAYS) * Math.PI * 2;
      sumX += Math.cos(angle) * d;
      sumZ += Math.sin(angle) * d;
    });
    centreX += (sumX / FIT_RAYS) * 0.9;
    centreZ += (sumZ / FIT_RAYS) * 0.9;
  }
  const line = rays.map((d, r) => {
    const angle = (r / FIT_RAYS) * Math.PI * 2, smooth = (d + rays[(r + 1) % FIT_RAYS] + rays[(r + FIT_RAYS - 1) % FIT_RAYS]) / 3, used = Math.min(d, smooth + 2);
    return [centreX + Math.cos(angle) * used, centreZ + Math.sin(angle) * used];
  });
  return withoutShortWalls(simplifyClosed(line, tolerance, most), 7);
}

// A long low work with its feet at the water's edge, its front following the shore and a straight wall behind.
function batteryBase(landAt, halfLength, depth) {
  const stations = [];
  for (let x = -halfLength; x <= halfLength + 0.01; x += 7) {
    let z = depth * 0.5, last = z;
    while (z > -depth * 3 && landAt(x, z - RAY_STEP_M)) { z -= RAY_STEP_M; last = z; }
    stations.push([x, last]);
  }
  // Nobody builds out on a sandbar, or back round a creek: a sudden step in the front is cut off.
  const middle = stations[stations.length >> 1][1];
  const front = stations.map(([x, z]) => [x, Math.max(middle - depth * 0.8, Math.min(middle + depth * 0.8, z))]);
  const back = middle + depth;
  // Going round with the outside on the right hand: along the front in +X, then back along the rear wall.
  const kept = [front[0]];
  for (let i = 1; i < front.length - 1; i++) {
    const a = kept[kept.length - 1], b = front[i], c = front[i + 1];
    const off = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / (Math.hypot(c[0] - a[0], c[1] - a[1]) || 1);
    if (off > 1.2) kept.push(b);
  }
  kept.push(front[front.length - 1]);
  return [...kept, [halfLength, back], [-halfLength, back]];
}

// A corner wherever a wall crosses a line of constant z, so that each wall lies wholly to one side of it.
function splitWallsAcross(outline, kinds, salients, z) {
  const outOutline = [], outKinds = [], moved = new Map();
  outline.forEach((p, i) => {
    const q = outline[(i + 1) % outline.length];
    moved.set(i, outOutline.length);
    outOutline.push(p);
    outKinds.push(kinds[i]);
    if ((p[1] < z) !== (q[1] < z) && Math.abs(p[1] - z) > 0.2 && Math.abs(q[1] - z) > 0.2) {
      const t = (z - p[1]) / (q[1] - p[1]);
      outOutline.push([p[0] + (q[0] - p[0]) * t, z]);
      outKinds.push(kinds[i]);
    }
  });
  return { outline: outOutline, kinds: outKinds, salients: salients.map((at) => moved.get(at)) };
}

// The part of an outline to one side of a line of constant z.
export function clipOutlineAt(outline, z, keepLow) {
  const out = [], kept = (p) => (keepLow ? p[1] <= z + 1e-6 : p[1] >= z - 1e-6);
  outline.forEach((a, i) => {
    const b = outline[(i + 1) % outline.length];
    if (kept(a)) out.push(a);
    if (kept(a) !== kept(b)) {
      const t = (z - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, z]);
    }
  });
  return out;
}

// The biggest box about the middle of an outline that stands clear of its walls, for the buildings inside it.
function innerYard(outline, clearance) {
  let sumX = 0, sumZ = 0;
  for (const [x, z] of outline) { sumX += x; sumZ += z; }
  const cx = sumX / outline.length, cz = sumZ / outline.length, fits = (hx, hz) => {
    for (const sx of [-1, -0.5, 0, 0.5, 1]) for (const sz of [-1, -0.5, 0, 0.5, 1]) {
      if (depthInOutline(outline, cx + sx * hx, cz + sz * hz) < clearance) return false;
    }
    return true;
  };
  let hx = 2, hz = 2;
  if (!fits(hx, hz)) return null;
  for (let grow = 0; grow < 60; grow++) {
    const wider = fits(hx + 1, hz), longer = fits(hx, hz + 1);
    if (!wider && !longer) break;
    if (wider && (hx <= hz || !longer)) hx += 1;
    else hz += 1;
  }
  return { x: cx, z: cz, halfWidth: hx, halfLength: hz };
}

/**
 * Draw a fort to fit a site. landAt(lx, lz) says whether there is ground for a wall at a point in the fort's frame, and
 * openAt(lx, lz, nx, nz) how far the water runs clear of land from a wall looking that way, as a share. gateToward is
 * the way inland or to the town, in the same frame.
 *   shape: star, headland, fitted, islet, battery or drum.
 * The origin of the result is the middle of its footprint: offsetX and offsetZ say how far that moved from the site.
 */
export function drawFortTrace({ shape = 'star', sizeM = null, bastions = 4, landAt, openAt = () => 1, gateToward = [0, 1], guns = null, earth = false, terraces = false }) {
  let drawn, keep = false;
  const asked = sizeM ?? [];
  if (shape === 'battery') {
    const halfLength = Math.max(18, Math.min(60, (asked[0] ?? 74) * 0.5)), depth = Math.max(9, Math.min(20, asked[1] ?? 13));
    const base = batteryBase(landAt, halfLength, depth);
    drawn = { outline: base, kinds: base.map((_, i) => (i >= base.length - 2 ? 'curtain' : 'front')), salients: [] };
  } else if (shape === 'drum') {
    const radius = Math.max(9, Math.min(31, (asked[0] ?? 30) * 0.5)), base = [];
    for (let i = 0; i < DRUM_SIDES; i++) base.push([Math.cos((i / DRUM_SIDES) * Math.PI * 2) * radius, Math.sin((i / DRUM_SIDES) * Math.PI * 2) * radius]);
    drawn = { outline: base, kinds: base.map(() => 'curtain'), salients: [] };
    keep = true;
  } else if (shape === 'star') {
    // As big as the record says, or as the ground will take it.
    const across = asked[0] ?? 60, along = asked[1] ?? across;
    search: for (const scale of [1, 0.88, 0.76, 0.64]) {
      const hw = Math.max(16, (across * scale) / 2 - 7), hl = Math.max(16, (along * scale) / 2 - 7);
      const trial = traceWithBastions(bastions === 5 ? pentagonBase(hw + 3, hl + 3) : rectangleBase(hw, hl), () => true);
      drawn = trial;
      // Rather than shrink, it stands back from the water until its feet are dry.
      for (const back of [0, 8, 16, 24, 34, 46]) {
        if (trial.outline.filter(([x, z]) => landAt(x, z + back)).length >= trial.outline.length * 0.86) {
          drawn = { ...trial, outline: trial.outline.map(([x, z]) => [x, z + back]) };
          break search;
        }
      }
    }
  } else {
    // Stretched the way the ground runs. Corners on the land side get bastions; those over the water do not need them.
    const reachX = Math.max(shape === 'islet' ? 16 : 24, (asked[0] ?? (shape === 'islet' ? 56 : shape === 'headland' ? 72 : 76)) / 2);
    const reachZ = Math.max(shape === 'islet' ? 16 : 24, (asked[1] ?? (shape === 'islet' ? 56 : shape === 'headland' ? 124 : 76)) / 2);
    let base = fittedBase(landAt, reachX, reachZ, 1.5, 2.6, 9);
    if (outlineArea(base) < 0) base.reverse();
    // No shape to speak of here: a plain square, on whatever foundations it takes.
    if (base.length < 3 || outlineArea(base) < 380) base = rectangleBase(15, 15);
    const middleZ = base.reduce((sum, p) => sum + p[1], 0) / base.length;
    drawn = traceWithBastions(base, (_, p) => shape !== 'islet' && p[1] >= middleZ - 4);
  }

  // Centre the footprint on the origin.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of drawn.outline) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const shiftX = (minX + maxX) / 2, shiftZ = (minZ + maxZ) / 2;
  let outline = drawn.outline.map(([x, z]) => [x - shiftX, z - shiftZ]), kinds = drawn.kinds;
  const hw = (maxX - minX) / 2 + TRACE_OVERHANG_M, hl = (maxZ - minZ) / 2 + TRACE_OVERHANG_M;
  // A long work on a point steps down towards the water, with its lowest guns nearest it. The step is a wall across it.
  let lowZ = null, lowDrop = 0, salients = drawn.salients;
  if (terraces && maxZ - minZ >= 70) {
    lowZ = -(maxZ - minZ) / 2 + (maxZ - minZ) * 0.34;
    lowDrop = 3.2;
    ({ outline, kinds, salients } = splitWallsAcross(outline, kinds, salients, lowZ));
  }
  const trace = { shape, earth, outline, kinds, salients, keep, guns: [], buildings: [], lowZ, lowDrop };
  const walls = traceWalls(trace);
  trace.shortestWall = walls.reduce((least, wall) => Math.min(least, wall.length), Infinity);

  // The gate is in the curtain facing most nearly inland, and it wants ground outside it.
  const gateLength = Math.hypot(gateToward[0], gateToward[1]) || 1, gx = gateToward[0] / gateLength, gz = gateToward[1] / gateLength;
  let gateWall = -1, gateScore = -Infinity;
  for (const wall of walls) {
    if (wall.length < 8 || wall.kind === 'face' || wall.kind === 'flank') continue;
    const mx = (wall.ax + wall.bx) / 2 + shiftX, mz = (wall.az + wall.bz) / 2 + shiftZ;
    const score = wall.nx * gx + wall.nz * gz + (landAt(mx + wall.nx * 14, mz + wall.nz * 14) ? 0.5 : 0);
    if (score > gateScore) { gateScore = score; gateWall = wall.index; }
  }
  if (gateWall < 0) gateWall = walls.reduce((best, wall) => (wall.nx * gx + wall.nz * gz > best.nx * gx + best.nz * gz ? wall : best), walls[0]).index;
  const gateAt = walls[gateWall];
  trace.gate = { wall: gateWall, x: (gateAt.ax + gateAt.bx) / 2, z: (gateAt.az + gateAt.bz) / 2, nx: gateAt.nx, nz: gateAt.nz, ux: gateAt.ux, uz: gateAt.uz, halfWidth: TRACE_GATE_HALF_WIDTH_M };

  // Guns go on the walls that look over clear water, best first, spread evenly. A gate's wall has none.
  const most = guns ?? (shape === 'battery' ? 7 : shape === 'drum' ? 6 : shape === 'islet' ? 6 : shape === 'star' ? 10 : 12);
  const spacing = shape === 'battery' ? 7 : 6.5;
  const carriageDepth = TRACE_PARAPET_M + 0.42;
  const gunSlotFits = (wall, along) => {
    const x = wall.ax + wall.ux * along, z = wall.az + wall.uz * along;
    const cx = x - wall.nx * carriageDepth, cz = z - wall.nz * carriageDepth;
    if (depthInOutline(outline, cx, cz) < TRACE_PARAPET_M + 0.35) return false;
    if (lowZ !== null && Math.abs(cz - lowZ) < 1.45) return false;
    return true;
  };
  // A flank looks along its own curtain at the next bastion: its guns are for the ditch, and they stay out of this.
  const ranked = walls.filter((wall) => wall.length >= 4 && wall.index !== gateWall && wall.kind !== 'flank' && gunSlotFits(wall, wall.length * 0.5)).map((wall) => {
    const mx = (wall.ax + wall.bx) / 2, mz = (wall.az + wall.bz) / 2;
    return { wall, open: openAt(mx + shiftX, mz + shiftZ, wall.nx, wall.nz), room: Math.max(1, Math.floor(wall.length / spacing)), count: 0, guns: [] };
  }).sort((a, b) => b.open - b.wall.nz * 0.3 - (a.open - a.wall.nz * 0.3));
  let placed = 0;
  for (let round = 0; round < 8 && placed < most; round++) {
    for (const entry of ranked) {
      if (placed >= most) break;
      if (entry.count >= entry.room || entry.count > round) continue;
      // A wall with no water before it gets a gun only once the others are full.
      if (entry.open < 0.3 && round < 2) continue;
      entry.count++;
      placed++;
    }
  }
  // A wall's guns, so many spread evenly along it. One with no room behind it, or that would share a platform with
  // another wall's gun round a sharp corner, is left out.
  const standGuns = (entry, count) => {
    const { wall } = entry, standing = ranked.flatMap((other) => (other === entry ? [] : other.guns)), first = standing.length;
    const margin = count > 1 ? Math.min(wall.length * 0.22, 2.2) : 0;
    const usable = wall.length - margin * 2;
    for (let s = 0; s < count; s++) {
      const along = margin + (usable * (s + 0.5)) / count;
      if (!gunSlotFits(wall, along)) continue;
      const x = wall.ax + wall.ux * along, z = wall.az + wall.uz * along;
      const cx = x - wall.nx * carriageDepth, cz = z - wall.nz * carriageDepth;
      if (standing.some((gun) => Math.hypot(gun.x - x, gun.z - z) < GUN_APART_M || Math.hypot(gun.x - gun.nx * carriageDepth - cx, gun.z - gun.nz * carriageDepth - cz) < 2.2)) continue;
      standing.push({ x, z, nx: wall.nx, nz: wall.nz, wall: wall.index, along });
    }
    return standing.slice(first);
  };
  for (const entry of ranked) entry.guns = standGuns(entry, entry.count);
  // A gun left out goes to the best wall with room for one more, so a fort mounts what its walls were given.
  let owed = placed - ranked.reduce((sum, entry) => sum + entry.guns.length, 0);
  for (let carried = true; owed > 0 && carried;) {
    carried = false;
    for (const entry of ranked) {
      if (owed <= 0) break;
      if (entry.count >= entry.room) continue;
      const guns = standGuns(entry, entry.count + 1);
      if (guns.length <= entry.guns.length) continue;
      entry.guns = guns;
      entry.count++;
      owed--;
      carried = true;
    }
  }
  trace.guns = ranked.flatMap((entry) => entry.guns);
  const yard = innerYard(lowZ === null ? outline : clipOutlineAt(outline, lowZ, false), TRACE_RAMPART_EDGE_M + 3);
  if (yard && !keep) {
    if (yard.halfWidth >= 9 && yard.halfLength >= 7) {
      const barracks = Math.min(yard.halfLength * 1.7, 22);
      trace.buildings.push({ kind: 'barracks', x: yard.x - yard.halfWidth + 3, z: yard.z, halfWidth: 2.4, halfLength: barracks / 2 });
      trace.buildings.push({ kind: 'barracks', x: yard.x + yard.halfWidth - 3, z: yard.z, halfWidth: 2.4, halfLength: barracks / 2 });
      trace.buildings.push({ kind: 'magazine', x: yard.x, z: yard.z + Math.min(yard.halfLength - 4, 6), radius: Math.min(3.6, yard.halfLength * 0.4) });
    } else if (yard.halfWidth >= 4 && yard.halfLength >= 4) {
      trace.buildings.push({ kind: 'barracks', x: yard.x, z: yard.z, halfWidth: Math.min(2.4, yard.halfWidth - 1), halfLength: Math.min(5, yard.halfLength - 1) });
    }
  }
  return { trace, offsetX: shiftX, offsetZ: shiftZ, width: hw * 2, length: hl * 2 };
}

// A trace's walls, each with its own direction and the way out from it.
export function traceWalls(trace) {
  const { outline, kinds } = trace, count = outline.length;
  return outline.map((p, i) => {
    const q = outline[(i + 1) % count], length = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const ux = (q[0] - p[0]) / length, uz = (q[1] - p[1]) / length;
    return { index: i, ax: p[0], az: p[1], bx: q[0], bz: q[1], ux, uz, nx: uz, nz: -ux, length, kind: kinds[i] };
  });
}
