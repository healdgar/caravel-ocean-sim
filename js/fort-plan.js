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

function curtainBetween([ax, az], [bx, bz], stop) {
  const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz) || 1;
  const ux = dx / length, uz = dz / length;
  return [[ax + ux * stop, az + uz * stop], [bx - ux * stop, bz - uz * stop]];
}

export function triangularFortPlan(width, length) {
  const hw = width * 0.5, hl = length * 0.5;
  const sw = [-hw * 0.86, -hl * 0.72], se = [hw * 0.86, -hl * 0.72], north = [0, hl * 0.86];
  const bastionRadius = Math.min(6.4, Math.min(hw, hl) * 0.24);
  const stop = bastionRadius + CURTAIN_INTO_PARAPET_M;
  const river = curtainBetween(sw, se, stop), west = curtainBetween(sw, north, stop), east = curtainBetween(se, north, stop);
  const gateZ = river[0][1];
  return {
    bastions: [sw, se, north],
    bastionRadius,
    // The river curtain, whose middle is the gate, then the west and east curtains.
    curtains: [river, west, east],
    gateHalfWidth: FORT_GATE_HALF_WIDTH_M,
    wallSpans: [[river[0], [-FORT_GATE_HALF_WIDTH_M, gateZ]], [[FORT_GATE_HALF_WIDTH_M, gateZ], river[1]], west, east],
    gateApron: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => [sx * GATE_APRON_HALF_WIDTH_M, gateZ + sz * GATE_APRON_REACH_M]),
    gateApproach: [-1, 1].map((side) => {
      const x = side * (FORT_GATE_HALF_WIDTH_M + WALL_SOLID_HALF_WIDTH_M);
      return [[x, gateZ - GATE_APPROACH_M], [x, gateZ + GATE_APPROACH_M]];
    }),
    outline: [sw, se, north],
    guardhouse: {
      x: -Math.min(8.5, hw * 0.22),
      z: sw[1] + Math.min(5.2, hl * 0.22),
      halfWidth: Math.min(3.4, hw * 0.18),
      halfLength: Math.min(4.2, hl * 0.2),
    },
    // Slots are [x, z, turn]: set back from the walls, which lean in, with a street's width between
    // neighbours. A house's door is in its -X wall, so the west row turns to face the parade too.
    hallSlot: [0, 0, 0],
    cottageSlots: [[14.5, -3, 0], [-14.5, -3, Math.PI], [27.8, -20.5, 0], [-27.8, -20.5, Math.PI]],
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
  if (inst.prefabId === TRIANGULAR_FORT) return triangularFortPlan(inst.width, inst.length);
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
  if (plan.gateApron) {
    const [[, outerZ]] = plan.gateApron;
    points.push(fortLocalToWorld(candidate, 0, outerZ), fortLocalToWorld(candidate, 0, outerZ * 0.5 + plan.curtains[0][0][1] * 0.5));
  }
  plan.outline.forEach(([ax, az], i) => {
    const [bx, bz] = plan.outline[(i + 1) % plan.outline.length];
    const stops = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / WALL_GROUND_STEP_M));
    for (let s = 0; s < stops; s++) points.push(fortLocalToWorld(candidate, ax + ((bx - ax) * s) / stops, az + ((bz - az) * s) / stops));
  });
  return points;
}
