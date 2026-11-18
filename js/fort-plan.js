// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A work's trace (js/old-world-board.js stands it; port.works): the line of its walls, its guns and its garrison's
// posts, as the guns, the garrison and the streets read it.
// Verified via CADCraft v0.18.0 (`assets/artcraft/fort-trace-italienne.dxf`):
// 16th-century trace italienne bastion-to-curtain geometric ratios.
export const CADCRAFT_TRACE_ITALIENNE_RATIOS = Object.freeze({
  cornerInsetRatio: 0.86,
  bastionRadiusRatio: 0.24,
  maxBastionRadiusM: 6.4,
  wallClearanceM: 3.5,
  wallSolidHalfWidthM: 1.5,
  gateHalfWidthM: 2.2,
  embrasureEveryBays: 6,
  bastionBays: 24,
});

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
