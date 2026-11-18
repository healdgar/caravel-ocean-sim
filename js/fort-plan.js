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
// A fort's trace: the line of its walls, as its works are built (portWorkBuildings below). The guns and the garrison read it.
// In the fort's own frame -Z looks at the water it guards. Outlines run so that a wall's outside is on the right hand
// going round, as x then z increase: (uz, -ux) for a wall running along (ux, uz).
// ---------------------------------------------------------------------------------------------------------------------
const TRACE_GUN_ARC_DEGREES = 65;
export const TRACE_GUN_ARC_COS = Math.cos((TRACE_GUN_ARC_DEGREES * Math.PI) / 180);
const TRACE_GATE_HALF_WIDTH_M = 1.9;

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

// A trace's walls, each with its own direction and the way out from it.
export function traceWalls(trace) {
  const { outline, kinds } = trace, count = outline.length;
  return outline.map((p, i) => {
    const q = outline[(i + 1) % count], length = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const ux = (q[0] - p[0]) / length, uz = (q[1] - p[1]) / length;
    return { index: i, ax: p[0], az: p[1], bx: q[0], bz: q[1], ux, uz, nx: uz, nz: -ux, length, kind: kinds[i] };
  });
}

// The works a port's board stands (js/old-world-board.js; port.works) as the buildings its guns and its garrison know:
// each in its own frame (x across its front, -z out to the water), its line, guns, salients and gate as a trace is
// written. Made once for the works the port has, and kept with it, so that each work is one building throughout.
// A work is built of the city's types, and is struck through them (js/city-targets.js, js/gunnery-control.js
// strikeWorkThroughPiece): each gun keeps the type it stands `on` and its own `piece`, and the `bore` its type has.
const WORK_PREFAB = Object.freeze({ fort: 'city_fort', battery: 'city_battery', tower: 'city_watchtower' });
// Where a work gun's gunner stands: back from its trunnions toward its breech, and out beside it clear of its wheel.
export const WORK_GUNNER_BACK_M = 1.2;
export const WORK_GUNNER_BESIDE_M = 1.25;
export function portWorkBuildings(port) {
  if (!port) return [];
  if (port.workBuildings && port.workBuildings.works === port.works) return port.workBuildings.list;
  const list = (port.works ?? []).filter((work) => work?.guns?.length && work.outline?.length >= 3 && work.bore).map((work) => {
    const c = Math.cos(work.turn ?? 0), s = Math.sin(work.turn ?? 0), y = work.y ?? 0;
    const toLocal = ([wx, wz]) => { const dx = wx - work.x, dz = wz - work.z; return [dx * c - dz * s, dx * s + dz * c]; };
    const outline = work.outline.map(toLocal), kinds = outline.map(() => 'curtain');
    const nearest = ([px, pz]) => outline.reduce((best, q, i) => (Math.hypot(q[0] - px, q[1] - pz) < Math.hypot(outline[best][0] - px, outline[best][1] - pz) ? i : best), 0);
    const guns = work.guns.map((gun) => {
      const [x, z] = toLocal([gun.x, gun.z]);
      return { x, z, nx: gun.nx * c - gun.nz * s, nz: gun.nx * s + gun.nz * c, wall: gun.wall, y: gun.y - y, on: gun.on, piece: gun.piece, bore: work.bore };
    });
    const walls = traceWalls({ outline, kinds });
    // Its gate in the wall nearest it, or, where it has none (a battery's open gorge), the wall that faces most landward.
    const gateAt = work.gate ? toLocal([work.gate.x, work.gate.z]) : null;
    const wallTo = gateAt
      ? walls.reduce((best, w) => (Math.hypot((w.ax + w.bx) / 2 - gateAt[0], (w.az + w.bz) / 2 - gateAt[1]) < Math.hypot((best.ax + best.bx) / 2 - gateAt[0], (best.az + best.bz) / 2 - gateAt[1]) ? w : best))
      : walls.reduce((best, w) => (w.nz > best.nz ? w : best));
    const deck = guns.reduce((sum, gun) => sum + gun.y, 0) / guns.length;
    const trace = {
      outline, kinds, guns,
      salients: work.salients?.length ? work.salients.map(nearest) : outline.map((_, i) => i),
      gate: { wall: wallTo.index, x: gateAt ? gateAt[0] : (wallTo.ax + wallTo.bx) / 2, z: gateAt ? gateAt[1] : (wallTo.az + wallTo.bz) / 2, nx: wallTo.nx, nz: wallTo.nz, ux: wallTo.ux, uz: wallTo.uz, halfWidth: TRACE_GATE_HALF_WIDTH_M },
    };
    return {
      id: `work:${work.name}`, prefabId: WORK_PREFAB[work.kind] ?? 'city_fort', label: work.name, work, trace,
      x: work.x, z: work.z, y, baseY: y, yaw: work.turn ?? 0, width: work.w, depth: work.d, length: work.d, height: deck,
      armed: true, hasMagazine: work.kind === 'fort',
    };
  });
  port.workBuildings = { works: port.works, list };
  return list;
}

// The work a type of the city's belongs to, by its place in the city's count (js/old-world-board.js `types`), or null.
export function portWorkOfPiece(port, index) {
  if (!(index >= 0)) return null;
  for (const building of portWorkBuildings(port)) {
    const [first, after] = building.work.types ?? [0, 0];
    if (index >= first && index < after) return building;
  }
  return null;
}

// Whether a man of a work's garrison, at `lx, lz` in the work's frame, stands on a piece of it (a struck type of the
// city, js/city-targets.js): within its plot.
export function workPieceUnder(piece, work, lx, lz) {
  const cw = Math.cos(work.yaw ?? 0), sw = Math.sin(work.yaw ?? 0), cp = Math.cos(piece.yaw ?? 0), sp = Math.sin(piece.yaw ?? 0);
  const dx = (work.x ?? 0) + lx * cw + lz * sw - (piece.x ?? 0), dz = (work.z ?? 0) - lx * sw + lz * cw - (piece.z ?? 0);
  const px = dx * cp - dz * sp, pz = dx * sp + dz * cp;
  return Math.abs(px) <= (piece.width ?? 0) / 2 && Math.abs(pz) <= (piece.depth ?? piece.length ?? 0) / 2;
}
