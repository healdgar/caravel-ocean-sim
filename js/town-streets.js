// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A town's ways, worked out once when its buildings are placed. Each door joins the ways by the
// cheapest walk over the ground, so ways merge as real ones do, and how many trips cross a stretch
// decides whether it is a street, a lane or a path. A road then leaves for the country.
// The result is immutable: a distance field the land shader reads, and routes a compute pass walks.
import { WALL_SOLID_HALF_WIDTH_M, enclosurePlan, pointOnEnclosureWall, pointWithinEnclosure } from './fort-plan.js';

const CELL_M = 2;
// A deck that butts onto another, as a pier's head mole does, can be walked from one to the other.
const DECK_RUNS_ON_M = 1;
const SITE_MARGIN_M = 26;
const MOST_TOWN_RADIUS_M = 560;
const WALL_CLEARANCE_M = 1;
const DRY_GROUND_M = 0.35;
const NEAR_WALL_COST = 0.7;
const SLOPE_COST = 16;
const WORN_WAY_COST = 0.35;
const EXTRA_LINKS = 14;
const LINK_REACH_M = 130;
const LINK_DETOUR = 2.2;
const MOST_ROOM_CELLS = 4;
const ROAD_CELL_M = 8;
const ROAD_REACH_M = 800;
const ROADS = 2;
const ROAD_SEPARATION_RADIANS = 1.2;
const ROAD_WIDTH_M = 4.4;
const ROAD_MOST_GRADE = 0.5;
const ROAD_WANDER = 1.1;
export const STREET_FIELD_RANGE_M = 16;
export const STREET_FIELD_EDGE_M = 4;
const MOST_FIELD_SIZE = 2048;
const FIELD_METRES_PER_TEXEL = 1;
export const ROUTE_STEP_M = 1.25;
export const WALKER_WORDS = 12;
const WALKING_SPEEDS = [1.0, 1.55];
const INDOOR_SECONDS = [15, 80];
const PAUSE_SECONDS = 9;
const PAUSE_SHARE = 0.3;

const NOT_WALKED_ON = new Set(['timber_mole_pier', 'stone_quay_seawall', 'stone_arch_bridge', 'indigenous_palisade_ring', 'english_triangular_palisade_fort']);
const WITHOUT_DOORS = new Set(['stone_quay_seawall', 'stone_arch_bridge', 'indigenous_palisade_ring', 'english_triangular_palisade_fort', 'curtain_wall_and_gate', 'acueducto_de_piedra']);
// Places in the open, where someone arriving stays in view rather than going indoors.
const OPEN_AIR = new Set(['timber_mole_pier', 'open_lonja_loggia', 'indigenous_canoe_landing', 'taino_batey_court']);
const DEFENCES = new Set(['bastion_trace_fortress', 'stone_sea_bastion', 'torreon_atalaya_farol']);
// How often people have business at a place. Anything else counts for two.
const PLACE_BUSINESS = Object.freeze({
  timber_mole_pier: 5, open_lonja_loggia: 6, casa_de_contratacion: 5, catedral_basilica: 6, mission_chapel: 4, royal_warehouse: 4,
  royal_atarazanas_arsenal: 3, palacio_del_gobernador: 3, mosteiro_dos_jeronimos: 3, colonial_town_block: 3, bastion_trace_fortress: 1,
  stone_sea_bastion: 1, torreon_atalaya_farol: 1, walled_mule_corral: 1, taino_batey_court: 5, taino_cacique_caney: 4, indigenous_canoe_landing: 4,
});
// People abroad at once at each size of town, before those indoors are taken off.
const TOWNSFOLK_BY_STAGE = Object.freeze({
  'citadel-metropolis': 520, 'fortified-port': 360, settlement: 220, outpost: 110,
  'sovereign-polity': 180, 'fortified-federation': 120, 'thriving-village': 100, 'epidemic-impacted': 40,
});
const TOWNSFOLK_DEFAULT = 90;

function seededRandom(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Lowest cost first. Stale entries are skipped by the caller.
class CostHeap {
  constructor() { this.cost = []; this.cell = []; }
  get size() { return this.cell.length; }
  clear() { this.cost.length = 0; this.cell.length = 0; }
  push(cost, cell) {
    const costs = this.cost, cells = this.cell;
    let i = cells.length;
    costs.push(cost); cells.push(cell);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (costs[up] <= cost) break;
      costs[i] = costs[up]; cells[i] = cells[up];
      i = up;
    }
    costs[i] = cost; cells[i] = cell;
  }
  pop() {
    const costs = this.cost, cells = this.cell, top = cells[0], cost = costs.pop(), cell = cells.pop();
    const n = cells.length;
    if (n) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && costs[child + 1] < costs[child]) child++;
        if (costs[child] >= cost) break;
        costs[i] = costs[child]; cells[i] = cells[child];
        i = child;
      }
      costs[i] = cost; cells[i] = cell;
    }
    return top;
  }
}

const NEIGHBOURS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

function createGrid(minX, minZ, maxX, maxZ, cell) {
  const nx = Math.ceil((maxX - minX) / cell) + 1, nz = Math.ceil((maxZ - minZ) / cell) + 1, count = nx * nz;
  return {
    minX, minZ, cell, nx, nz, count,
    cost: new Float32Array(count).fill(Infinity),
    best: new Float64Array(count),
    from: new Int32Array(count),
    visit: new Uint32Array(count),
    run: 0,
    heap: new CostHeap(),
    x: (c) => minX + (c % nx) * cell,
    z: (c) => minZ + Math.floor(c / nx) * cell,
    at: (x, z) => {
      const i = Math.round((x - minX) / cell), j = Math.round((z - minZ) / cell);
      return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i;
    },
  };
}
// Cheapest walks out from `sources` until `stop` accepts a cell, which is returned, or -1.
function flood(grid, sources, stop, stepCost = (c) => grid.cost[c], guardCorners = true) {
  const { nx, nz, best, from, visit, heap } = grid, run = ++grid.run;
  heap.clear();
  for (const c of sources) { best[c] = 0; from[c] = -1; visit[c] = run; heap.push(0, c); }
  while (heap.size) {
    const costHere = heap.cost[0], c = heap.pop();
    if (costHere > best[c]) continue;
    if (stop(c)) return c;
    const i = c % nx, j = Math.floor(c / nx);
    for (const [di, dj, length] of NEIGHBOURS) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const n = nj * nx + ni, step = stepCost(n);
      if (!Number.isFinite(step)) continue;
      // Do not cut the corner of something solid.
      if (guardCorners && length > 1 && (!Number.isFinite(stepCost(j * nx + ni)) || !Number.isFinite(stepCost(nj * nx + i)))) continue;
      const total = costHere + step * length;
      if (visit[n] !== run || total < best[n]) { visit[n] = run; best[n] = total; from[n] = c; heap.push(total, n); }
    }
  }
  return -1;
}
function walkBack(grid, end) {
  const path = [];
  for (let c = end; c !== -1; c = grid.from[c]) path.push(c);
  return path;
}

function localToWorld(inst, lx, lz) {
  const c = Math.cos(inst.yaw ?? 0), s = Math.sin(inst.yaw ?? 0);
  return { x: inst.x + lx * c + lz * s, z: inst.z - lx * s + lz * c };
}
function worldToLocal(inst, x, z) {
  const c = Math.cos(inst.yaw ?? 0), s = Math.sin(inst.yaw ?? 0), dx = x - inst.x, dz = z - inst.z;
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}
// The walkable top of a pier, quay or bridge, and how far either side of its middle one may walk.
function deckOf(inst) {
  const top = inst.y + inst.height;
  if (inst.prefabId === 'timber_mole_pier') return { y: top, halfWidth: inst.width * 0.5 - 0.9 };
  if (inst.prefabId === 'stone_quay_seawall') return { y: top, halfWidth: inst.width * 0.5 };
  if (inst.prefabId === 'stone_arch_bridge') return { y: top - 0.85 + 0.14, halfWidth: Math.min(4.2, inst.width * 0.5) - 0.9 };
  return null;
}

function chaikin(points) {
  const out = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i], [bx, bz] = points[i + 1];
    out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
  }
  out.push(points[points.length - 1]);
  return out;
}
function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}
function resample(points, step) {
  const out = [points[0]];
  let carried = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i];
    const length = Math.hypot(bx - ax, bz - az);
    if (length <= 0) continue;
    let along = step - carried;
    while (along <= length) {
      out.push([ax + (bx - ax) * (along / length), az + (bz - az) * (along / length)]);
      along += step;
    }
    carried = length - (along - step);
  }
  const last = points[points.length - 1], tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.25) out.push(last);
  return out;
}

function chooseDoor(inst, grid, towards) {
  const hw = inst.width * 0.5, hl = inst.length * 0.5;
  if (inst.prefabId === 'timber_mole_pier') {
    // People walk out along the pier deck, stopping clear of the pierhead capstan and Padrão beacon plinth.
    const reach = Math.max(2.0, hl - 8.2);
    const a = localToWorld(inst, 0, reach), b = localToWorld(inst, 0, -reach);
    const head = grid.groundAt(a.x, a.z) < grid.groundAt(b.x, b.z) ? a : b;
    const cell = nearestFreeCell(grid, head.x, head.z);
    return cell < 0 ? null : { inst, cell, outside: head, inside: head };
  }
  if (inst.trace?.gate) {
    // A fort is entered by its gate, from wherever its footprint ends in that direction.
    const { x, z, nx, nz } = inst.trace.gate;
    let out = 0;
    while (Math.abs(x + nx * out) <= hw + WALL_CLEARANCE_M && Math.abs(z + nz * out) <= hl + WALL_CLEARANCE_M && out < 120) out += CELL_M * 0.5;
    const outside = localToWorld(inst, x + nx * out, z + nz * out), cell = nearestFreeCell(grid, outside.x, outside.z);
    if (cell >= 0 && Math.hypot(grid.x(cell) - outside.x, grid.z(cell) - outside.z) <= CELL_M * 2.5) return { inst, cell, outside, inside: localToWorld(inst, x - nx * 1.6, z - nz * 1.6) };
  }
  const sides = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([sx, sz]) => {
    const middle = localToWorld(inst, sx * hw, sz * hl);
    return { sx, sz, facing: (middle.x - inst.x) * (towards.x - inst.x) + (middle.z - inst.z) * (towards.z - inst.z) };
  });
  // Colonial buildings have their door in the -X wall, and Indigenous houses in the -Z one.
  const preferred = inst.indigenous ? [sides[2], sides[3], sides[0], sides[1]] : [sides[0], sides[1], sides[2], sides[3]];
  const order = DEFENCES.has(inst.prefabId) ? [...sides].sort((a, b) => b.facing - a.facing) : preferred;
  for (const { sx, sz } of order) {
    const reach = (sx ? hw : hl) + WALL_CLEARANCE_M + CELL_M * 0.5;
    const outside = localToWorld(inst, sx * reach, sz * reach);
    const cell = nearestFreeCell(grid, outside.x, outside.z);
    if (cell < 0) continue;
    if (Math.hypot(grid.x(cell) - outside.x, grid.z(cell) - outside.z) > CELL_M * 2.5) continue;
    const insideReach = Math.max(0, (sx ? hw : hl) - 1.6);
    return { inst, cell, outside, inside: localToWorld(inst, sx * insideReach, sz * insideReach) };
  }
  return null;
}
function nearestFreeCell(grid, x, z) {
  const start = grid.at(x, z);
  if (start < 0) return -1;
  if (Number.isFinite(grid.cost[start])) return start;
  const si = start % grid.nx, sj = Math.floor(start / grid.nx);
  for (let r = 1; r <= 4; r++) {
    let best = -1, bestD = Infinity;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const i = si + di, j = sj + dj;
      if (i < 0 || j < 0 || i >= grid.nx || j >= grid.nz) continue;
      const c = j * grid.nx + i;
      if (!Number.isFinite(grid.cost[c])) continue;
      const d = Math.hypot(grid.x(c) - x, grid.z(c) - z);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

// Straight runs where nothing solid is crossed and the way stays near the walked line.
function straighten(grid, path) {
  const clear = (a, b) => {
    const ax = grid.x(a), az = grid.z(a), bx = grid.x(b), bz = grid.z(b);
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / (grid.cell * 0.5));
    for (let s = 1; s < steps; s++) {
      const c = grid.at(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps);
      if (c < 0 || !Number.isFinite(grid.cost[c])) return false;
    }
    return true;
  };
  const kept = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = Math.min(path.length - 1, i + 14);
    while (j > i + 1 && !clear(path[i], path[j])) j--;
    kept.push(path[j]);
    i = j;
  }
  return kept;
}

function stampField(field, size, window, ways) {
  const texel = window.span / size, x0 = window.x - window.span * 0.5, z0 = window.z - window.span * 0.5;
  const edges = new Float32Array(size * size).fill(STREET_FIELD_RANGE_M - STREET_FIELD_EDGE_M);
  for (const way of ways) {
    const pts = way.points;
    for (let p = 1; p < pts.length; p++) {
      const [ax, az, aw, ap] = pts[p - 1], [bx, bz, bw, bp] = pts[p];
      const reach = Math.max(aw, bw) * 0.5 + 8;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / texel)), i1 = Math.min(size - 1, Math.ceil((Math.max(ax, bx) + reach - x0) / texel));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - z0) / texel)), j1 = Math.min(size - 1, Math.ceil((Math.max(az, bz) + reach - z0) / texel));
      const dx = bx - ax, dz = bz - az, lengthSq = Math.max(1e-6, dx * dx + dz * dz);
      for (let j = j0; j <= j1; j++) {
        const z = z0 + (j + 0.5) * texel;
        for (let i = i0; i <= i1; i++) {
          const x = x0 + (i + 0.5) * texel;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq));
          const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
          const edge = d - (aw + (bw - aw) * t) * 0.5, k = j * size + i;
          if (edge < edges[k]) {
            edges[k] = edge;
            field[k * 2 + 1] = Math.round((ap + (bp - ap) * t) * 255);
          }
        }
      }
    }
  }
  for (let k = 0; k < edges.length; k++) field[k * 2] = Math.round(Math.max(0, Math.min(1, (edges[k] + STREET_FIELD_EDGE_M) / STREET_FIELD_RANGE_M)) * 255);
  return field;
}

// How far outside a way this point lies, in metres; negative is on it. Used to keep plants off.
export function streetEdgeAt(streets, x, z) {
  if (!streets) return Infinity;
  const { window, field, size } = streets;
  const u = (x - window.x) / window.span + 0.5, v = (z - window.z) / window.span + 0.5;
  if (u <= 0 || v <= 0 || u >= 1 || v >= 1) return Infinity;
  const k = Math.floor(v * size) * size + Math.floor(u * size);
  return (field[k * 2] / 255) * STREET_FIELD_RANGE_M - STREET_FIELD_EDGE_M;
}

export function layTownStreets(port, groundAt, { townsfolkScale = 1, mostFieldSize = MOST_FIELD_SIZE } = {}) {
  const all = port?.instances ?? [];
  if (all.length < 2 || !port.center) return null;
  const started = typeof performance === 'object' ? performance.now() : 0;
  const random = seededRandom(`${port.regionId ?? 'port'}:${port.year ?? 0}`);
  const centre = port.center;

  // The ground the town stands on, and what is solid on it.
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const nearby = all.filter((inst) => Math.hypot(inst.x - centre.x, inst.z - centre.z) < MOST_TOWN_RADIUS_M);
  if (nearby.length < 2) return null;
  for (const inst of nearby) {
    const r = Math.hypot(inst.width, inst.length) * 0.5 + SITE_MARGIN_M;
    minX = Math.min(minX, inst.x - r); maxX = Math.max(maxX, inst.x + r);
    minZ = Math.min(minZ, inst.z - r); maxZ = Math.max(maxZ, inst.z + r);
  }
  const grid = createGrid(minX, minZ, maxX, maxZ, CELL_M);
  grid.groundAt = groundAt;
  const heightAt = new Float32Array(grid.count);
  for (let c = 0; c < grid.count; c++) {
    const h = groundAt(grid.x(c), grid.z(c));
    heightAt[c] = h;
    grid.cost[c] = h < DRY_GROUND_M ? Infinity : 1;
  }
  for (let c = 0; c < grid.count; c++) {
    if (!Number.isFinite(grid.cost[c])) continue;
    const i = c % grid.nx, j = Math.floor(c / grid.nx);
    const left = heightAt[j * grid.nx + Math.max(0, i - 1)], right = heightAt[j * grid.nx + Math.min(grid.nx - 1, i + 1)];
    const down = heightAt[Math.max(0, j - 1) * grid.nx + i], up = heightAt[Math.min(grid.nz - 1, j + 1) * grid.nx + i];
    const grade = Math.hypot(right - left, up - down) / (2 * CELL_M);
    grid.cost[c] = 1 + SLOPE_COST * grade * grade;
  }
  const decks = [];
  const solid = (inst, c, margin) => {
    const { lx, lz } = worldToLocal(inst, grid.x(c), grid.z(c));
    return Math.abs(lx) <= inst.width * 0.5 + margin && Math.abs(lz) <= inst.length * 0.5 + margin;
  };
  for (const inst of nearby) {
    const reach = Math.hypot(inst.width, inst.length) * 0.5 + WALL_CLEARANCE_M + CELL_M * 2;
    const i0 = Math.max(0, Math.floor((inst.x - reach - minX) / CELL_M)), i1 = Math.min(grid.nx - 1, Math.ceil((inst.x + reach - minX) / CELL_M));
    const j0 = Math.max(0, Math.floor((inst.z - reach - minZ) / CELL_M)), j1 = Math.min(grid.nz - 1, Math.ceil((inst.z + reach - minZ) / CELL_M));
    const deck = deckOf(inst);
    if (deck) decks.push({ inst, ...deck });
    const walled = enclosurePlan(inst);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = j * grid.nx + i;
      // Nobody walks through a palisade: the way into a fort is by its gate.
      if (walled && pointOnEnclosureWall(inst, walled, grid.x(c), grid.z(c))) grid.cost[c] = Infinity;
      else if (walled && Number.isFinite(grid.cost[c]) && pointOnEnclosureWall(inst, walled, grid.x(c), grid.z(c), WALL_SOLID_HALF_WIDTH_M + CELL_M)) grid.cost[c] += NEAR_WALL_COST;
      if (deck) {
        const { lx, lz } = worldToLocal(inst, grid.x(c), grid.z(c));
        if (Math.abs(lx) <= deck.halfWidth + CELL_M * 0.2 && Math.abs(lz) <= inst.length * 0.5 + DECK_RUNS_ON_M) grid.cost[c] = 1;
      } else if (!NOT_WALKED_ON.has(inst.prefabId)) {
        if (solid(inst, c, WALL_CLEARANCE_M)) grid.cost[c] = Infinity;
        else if (Number.isFinite(grid.cost[c]) && solid(inst, c, WALL_CLEARANCE_M + CELL_M)) grid.cost[c] += NEAR_WALL_COST;
      }
    }
  }
  const surfaceAt = (x, z) => {
    let y = groundAt(x, z);
    for (const { inst, y: top, halfWidth } of decks) {
      const { lx, lz } = worldToLocal(inst, x, z);
      if (Math.abs(lz) <= inst.length * 0.5 + DECK_RUNS_ON_M && Math.abs(lx) <= halfWidth + 1.2 && top > y) y = top;
    }
    return y;
  };

  // Doors.
  const doors = [];
  for (const inst of nearby) {
    if (WITHOUT_DOORS.has(inst.prefabId)) continue;
    const door = chooseDoor(inst, grid, centre);
    if (door) doors.push({ ...door, business: PLACE_BUSINESS[inst.prefabId] ?? 2 });
  }
  if (doors.length < 2) return null;

  // Each unjoined door in turn takes the cheapest walk to any way already there.
  const onWay = new Uint8Array(grid.count);
  const wayX = new Float32Array(grid.count), wayZ = new Float32Array(grid.count);
  const ways = [];
  const addWay = (path) => {
    // path runs from the new end to a cell already on the ways.
    const kept = straighten(grid, path);
    let points = kept.map((c) => (onWay[c] ? [wayX[c], wayZ[c]] : [grid.x(c), grid.z(c)]));
    if (kept.length > 2) points = chaikin(chaikin(points));
    const line = resample(points, CELL_M * 0.75);
    let scan = 0;
    for (const c of path) {
      const x = grid.x(c), z = grid.z(c);
      let bestD = Infinity, best = scan;
      for (let k = scan; k < Math.min(line.length, scan + 24); k++) {
        const d = Math.hypot(line[k][0] - x, line[k][1] - z);
        if (d < bestD) { bestD = d; best = k; }
      }
      scan = best;
      if (!onWay[c]) { wayX[c] = line[best][0]; wayZ[c] = line[best][1]; }
      onWay[c] = 1;
    }
    ways.push({ line, cells: path });
  };
  const hub = doors.reduce((a, b) => (b.business * 200 - Math.hypot(b.inst.x - centre.x, b.inst.z - centre.z) > a.business * 200 - Math.hypot(a.inst.x - centre.x, a.inst.z - centre.z) ? b : a));
  onWay[hub.cell] = 1; wayX[hub.cell] = grid.x(hub.cell); wayZ[hub.cell] = grid.z(hub.cell);
  const waiting = new Map();
  for (const door of doors) if (door.cell !== hub.cell) waiting.set(door.cell, door);
  const wayCells = () => { const list = []; for (let c = 0; c < grid.count; c++) if (onWay[c]) list.push(c); return list; };
  const joined = new Set([hub]);
  while (waiting.size) {
    const reached = flood(grid, wayCells(), (c) => waiting.has(c));
    if (reached < 0) break;
    joined.add(waiting.get(reached));
    waiting.delete(reached);
    addWay(walkBack(grid, reached));
  }
  for (const door of doors) if (onWay[door.cell]) joined.add(door);
  const reachable = doors.filter((door) => joined.has(door));
  // A fort or a lookout may stand off by itself on a point of land. Anything else with no way to it is a fault.
  const strandedDoors = doors.filter((door) => !joined.has(door) && !door.inst.trace && door.inst.prefabId !== 'torreon_atalaya_farol').map((door) => door.inst.prefabId);
  const stranded = strandedDoors.length;

  // A tree of ways sends people the long way round. Where two neighbours are far apart by road, link them.
  const wayCost = (c) => (onWay[c] ? 1 : Infinity);
  // Ways already walked were checked when laid, and a diagonal step along one is no corner to cut.
  const shortestOnWays = (a, b) => (flood(grid, [a], (c) => c === b, wayCost, false) === b ? grid.best[b] : Infinity);
  let links = 0;
  const candidates = [];
  for (let a = 0; a < reachable.length; a++) for (let b = a + 1; b < reachable.length; b++) {
    const straight = Math.hypot(grid.x(reachable[a].cell) - grid.x(reachable[b].cell), grid.z(reachable[a].cell) - grid.z(reachable[b].cell));
    if (straight > 12 && straight < LINK_REACH_M) candidates.push({ a: reachable[a], b: reachable[b], straight });
  }
  candidates.sort((p, q) => p.straight - q.straight);
  for (const { a, b, straight } of candidates) {
    if (links >= EXTRA_LINKS) break;
    if (shortestOnWays(a.cell, b.cell) * CELL_M < straight * LINK_DETOUR) continue;
    const reached = flood(grid, [b.cell], (c) => c === a.cell, (c) => (onWay[c] ? grid.cost[c] * WORN_WAY_COST : grid.cost[c]));
    if (reached < 0) continue;
    addWay(walkBack(grid, reached));
    links++;
  }

  // Trips. Places with more business see more of them, and walkers share the routes.
  const totalBusiness = reachable.reduce((sum, door) => sum + door.business, 0);
  const pickDoor = () => {
    let roll = random() * totalBusiness;
    for (const door of reachable) { roll -= door.business; if (roll <= 0) return door; }
    return reachable[reachable.length - 1];
  };
  const traffic = new Float32Array(grid.count);
  const trips = [];
  const tripCount = Math.max(12, Math.min(110, reachable.length * 4));
  for (let attempt = 0; trips.length < tripCount && attempt < tripCount * 6; attempt++) {
    const a = pickDoor(), b = pickDoor();
    if (a === b) continue;
    if (flood(grid, [a.cell], (c) => c === b.cell, wayCost, false) !== b.cell) continue;
    const cells = walkBack(grid, b.cell).reverse();
    if (cells.length < 6) continue;
    trips.push({ a, b, cells, business: a.business + b.business, walkers: [] });
  }
  if (!trips.length) return null;
  // Who walks which, since a way is as wide as those who use it have worn it.
  const people = Math.round((TOWNSFOLK_BY_STAGE[port.stage] ?? TOWNSFOLK_DEFAULT) * townsfolkScale);
  const walkerTrip = new Uint16Array(people);
  const totalTripBusiness = trips.reduce((sum, trip) => sum + trip.business, 0);
  for (let w = 0; w < people; w++) {
    let roll = random() * totalTripBusiness, chosen = trips.length - 1;
    for (let t = 0; t < trips.length; t++) { roll -= trips[t].business; if (roll <= 0) { chosen = t; break; } }
    walkerTrip[w] = chosen;
    for (const c of trips[chosen].cells) traffic[c] += 1;
  }
  let busiest = 1;
  for (let c = 0; c < grid.count; c++) if (traffic[c] > busiest) busiest = traffic[c];

  // What each stretch became. Only a grown town paves its busy streets.
  const indigenous = Boolean(port.hasIndigenousSettlement && !port.hasColonialPort);
  const paves = !indigenous && (port.stage === 'citadel-metropolis' || port.stage === 'fortified-port');
  const widestStreet = indigenous ? 3 : paves ? 6.5 : 4.6;
  const narrowest = indigenous ? 1.7 : 2.2;
  const widthOf = (c) => {
    const use = Math.pow(traffic[c] / busiest, 0.6);
    return narrowest + (widestStreet - narrowest) * smoothstep(0.08, 0.6, use);
  };
  // How far a walker may stray before meeting a wall, by rings out from each way cell.
  const roomOf = (c) => {
    const i = c % grid.nx, j = Math.floor(c / grid.nx);
    for (let r = 1; r <= MOST_ROOM_CELLS; r++) {
      for (let d = -r; d <= r; d++) {
        for (const [ni, nj] of [[i + d, j - r], [i + d, j + r], [i - r, j + d], [i + r, j + d]]) {
          if (ni < 0 || nj < 0 || ni >= grid.nx || nj >= grid.nz || !Number.isFinite(grid.cost[nj * grid.nx + ni])) return (r - 0.5) * CELL_M;
        }
      }
    }
    return MOST_ROOM_CELLS * CELL_M;
  };
  const pavingOf = (c) => (paves ? smoothstep(0.1, 0.24, Math.pow(traffic[c] / busiest, 0.6)) : 0);
  const fieldWays = ways.map(({ line, cells }) => {
    const points = line.map(([x, z]) => {
      // The nearest of this way's cells says how it is used here.
      let best = cells[0], bestD = Infinity;
      for (const c of cells) {
        const d = Math.hypot(grid.x(c) - x, grid.z(c) - z);
        if (d < bestD) { bestD = d; best = c; }
      }
      return [x, z, Math.max(narrowest, widthOf(best)), pavingOf(best)];
    });
    return { points };
  });

  // A road or two leaves town by the easiest ground and fades out in the country.
  const roads = [];
  {
    const reach = ROAD_REACH_M + ROAD_CELL_M * 4;
    const roadGrid = createGrid(centre.x - reach, centre.z - reach, centre.x + reach, centre.z + reach, ROAD_CELL_M);
    const heights = new Float32Array(roadGrid.count);
    for (let c = 0; c < roadGrid.count; c++) heights[c] = groundAt(roadGrid.x(c), roadGrid.z(c));
    const wanderA = random() * 6.28, wanderB = random() * 6.28, wanderC = random() * 6.28;
    for (let c = 0; c < roadGrid.count; c++) {
      if (heights[c] < DRY_GROUND_M + 0.4) continue;
      const i = c % roadGrid.nx, j = Math.floor(c / roadGrid.nx);
      if (i === 0 || j === 0 || i === roadGrid.nx - 1 || j === roadGrid.nz - 1) continue;
      const grade = Math.hypot(heights[c + 1] - heights[c - 1], heights[c + roadGrid.nx] - heights[c - roadGrid.nx]) / (2 * ROAD_CELL_M);
      // Old roads wander: round a field, along a rise. Nothing here is level enough to be straight.
      const x = roadGrid.x(c), z = roadGrid.z(c);
      const wander = Math.sin(x * 0.013 + wanderA) * Math.sin(z * 0.017 + wanderB) + Math.sin(x * 0.007 - z * 0.011 + wanderC);
      roadGrid.cost[c] = grade > ROAD_MOST_GRADE ? Infinity : 1 + ROAD_WANDER * (1 + wander * 0.5) + 30 * grade * grade;
    }
    for (const inst of all) {
      const walled = enclosurePlan(inst);
      const r = Math.hypot(inst.width, inst.length) * 0.5 + 2 + ROAD_CELL_M;
      const i0 = Math.floor((inst.x - r - roadGrid.minX) / ROAD_CELL_M), i1 = Math.ceil((inst.x + r - roadGrid.minX) / ROAD_CELL_M);
      const j0 = Math.floor((inst.z - r - roadGrid.minZ) / ROAD_CELL_M), j1 = Math.ceil((inst.z + r - roadGrid.minZ) / ROAD_CELL_M);
      for (let j = Math.max(0, j0); j <= Math.min(roadGrid.nz - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(roadGrid.nx - 1, i1); i++) {
        const c = j * roadGrid.nx + i;
        // A road is too coarse to find a gate, so it keeps out of a fort altogether.
        if (walled && pointWithinEnclosure(inst, walled, roadGrid.x(c), roadGrid.z(c), ROAD_CELL_M)) roadGrid.cost[c] = Infinity;
        if (NOT_WALKED_ON.has(inst.prefabId)) continue;
        const { lx, lz } = worldToLocal(inst, roadGrid.x(c), roadGrid.z(c));
        if (Math.abs(lx) <= inst.width * 0.5 + 2 && Math.abs(lz) <= inst.length * 0.5 + 2) roadGrid.cost[c] = Infinity;
      }
    }
    // Set out from wherever the ways reach furthest from the water.
    const sources = [];
    const seen = new Set();
    for (const c of wayCells()) {
      const rc = roadGrid.at(grid.x(c), grid.z(c));
      if (rc >= 0 && Number.isFinite(roadGrid.cost[rc]) && !seen.has(rc)) { seen.add(rc); sources.push(rc); }
    }
    const taken = [];
    for (let r = 0; r < ROADS && sources.length; r++) {
      const end = flood(roadGrid, sources, (c) => {
        const dx = roadGrid.x(c) - centre.x, dz = roadGrid.z(c) - centre.z;
        if (Math.hypot(dx, dz) < ROAD_REACH_M) return false;
        const bearing = Math.atan2(dx, dz);
        return taken.every((t) => Math.abs(Math.atan2(Math.sin(bearing - t), Math.cos(bearing - t))) > ROAD_SEPARATION_RADIANS);
      });
      if (end < 0) break;
      taken.push(Math.atan2(roadGrid.x(end) - centre.x, roadGrid.z(end) - centre.z));
      const path = walkBack(roadGrid, end).reverse();
      const line = resample(chaikin(chaikin(path.filter((_, k) => k % 3 === 0 || k === path.length - 1).map((c) => [roadGrid.x(c), roadGrid.z(c)]))), 4);
      const width = indigenous ? 2.2 : ROAD_WIDTH_M, count = line.length;
      fieldWays.push({ points: line.map(([x, z], k) => [x, z, width * (1 - smoothstep(0.82, 1, k / Math.max(1, count - 1)) * 0.75), indigenous ? 0 : 0.5]), road: true });
      roads.push(line);
    }
  }

  // The distance field the land shader reads.
  let lowX = Infinity, lowZ = Infinity, highX = -Infinity, highZ = -Infinity;
  for (const { points } of fieldWays) for (const [x, z] of points) {
    lowX = Math.min(lowX, x); highX = Math.max(highX, x); lowZ = Math.min(lowZ, z); highZ = Math.max(highZ, z);
  }
  const span = Math.max(highX - lowX, highZ - lowZ) + 2 * (STREET_FIELD_RANGE_M + 8);
  const size = Math.min(mostFieldSize, Math.ceil(span / FIELD_METRES_PER_TEXEL));
  const window = { x: (lowX + highX) * 0.5, z: (lowZ + highZ) * 0.5, span };
  const field = stampField(new Uint8Array(size * size * 2), size, window, fieldWays);

  // Routes: each trip as evenly spaced samples of position and how far either side one may stray.
  const routeSamples = [];
  const routes = trips.map(({ a, b, cells }) => {
    const raw = [[a.inside.x, a.inside.z], [a.outside.x, a.outside.z]];
    for (const c of cells) raw.push([wayX[c] || grid.x(c), wayZ[c] || grid.z(c)]);
    raw.push([b.outside.x, b.outside.z], [b.inside.x, b.inside.z]);
    // Ease the corners where one way meets another, keeping both doors where they are.
    const eased = raw.map((point, k) => {
      if (k < 2 || k >= raw.length - 2) return point;
      const prev = raw[k - 1], next = raw[k + 1];
      return [(prev[0] + 2 * point[0] + next[0]) * 0.25, (prev[1] + 2 * point[1] + next[1]) * 0.25];
    });
    const line = resample(eased, ROUTE_STEP_M);
    const first = routeSamples.length / 4;
    const heights = line.map(([x, z]) => surfaceAt(x, z));
    // Over a step from ground to deck, a walker climbs rather than jumps.
    const climbed = heights.map((_, k) => {
      let sum = 0, weight = 0;
      for (let d = -3; d <= 3; d++) {
        const h = heights[k + d];
        if (h === undefined) continue;
        sum += h; weight++;
      }
      return sum / weight;
    });
    for (let k = 0; k < line.length; k++) {
      const [x, z] = line[k];
      const c = grid.at(x, z);
      const halfWidth = c >= 0 && onWay[c] ? Math.min(widthOf(c) * 0.5, roomOf(c)) : narrowest * 0.5;
      const onPier = (a.inst.prefabId === 'timber_mole_pier' || b.inst.prefabId === 'timber_mole_pier') && climbed[k] > 1.8;
      routeSamples.push(x, climbed[k], z, Math.max(0, halfWidth - (onPier ? 1.15 : 0.45)));
    }
    return { first, count: line.length, length: (line.length - 1) * ROUTE_STEP_M };
  });

  // The walkers. All of their motion is a function of time, so nothing is kept from frame to frame.
  const walkers = new ArrayBuffer(people * WALKER_WORDS * 4);
  const words = new Uint32Array(walkers), floats = new Float32Array(walkers);
  for (let w = 0; w < people; w++) {
    const route = routes[walkerTrip[w]];
    const trip = trips[walkerTrip[w]];
    const at = w * WALKER_WORDS;
    const speed = WALKING_SPEEDS[0] + (WALKING_SPEEDS[1] - WALKING_SPEEDS[0]) * random();
    const pauses = random() < PAUSE_SHARE;
    let first = route.first, count = route.count;
    if (count > 8 && OPEN_AIR.has(trip.b.inst.prefabId)) {
      count = Math.max(4, count - (w % Math.min(8, Math.floor(count * 0.35))));
    } else if (count > 8 && OPEN_AIR.has(trip.a.inst.prefabId)) {
      const trim = w % Math.min(8, Math.floor(count * 0.35));
      first += trim;
      count -= trim;
    }
    words[at] = first;
    words[at + 1] = count;
    floats[at + 2] = random();
    floats[at + 3] = speed;
    floats[at + 4] = 0.25 + 0.75 * random(); // Each keeps to one side of their way of going.
    floats[at + 5] = pauses ? 0.2 + 0.6 * random() : 0;
    floats[at + 6] = pauses ? PAUSE_SECONDS * (0.5 + random()) : 0;
    floats[at + 7] = INDOOR_SECONDS[0] + (INDOOR_SECONDS[1] - INDOOR_SECONDS[0]) * random();
    floats[at + 8] = (count - 1) * ROUTE_STEP_M;
    floats[at + 9] = random(); // How readily they stay out after dark.
    words[at + 10] = Math.floor(random() * 0xffff);
    const pierTrip = trip.a.inst.prefabId === 'timber_mole_pier' || trip.b.inst.prefabId === 'timber_mole_pier';
    words[at + 11] = (w & 1) | (OPEN_AIR.has(trip.a.inst.prefabId) ? 2 : 0) | (OPEN_AIR.has(trip.b.inst.prefabId) ? 4 : 0) | (pierTrip ? 8 : 0);
  }

  return {
    window, field, size,
    ways: fieldWays,
    doors: reachable.map((door) => ({ prefabId: door.inst.prefabId, x: door.outside.x, z: door.outside.z })),
    samples: new Float32Array(routeSamples),
    walkers: floats,
    people,
    stats: {
      doors: doors.length, stranded, strandedDoors, links, trips: trips.length, roads: roads.length, people,
      wayMetres: Math.round(fieldWays.reduce((sum, way) => sum + polylineLength(way.points), 0)),
      fieldBytes: field.byteLength, milliseconds: typeof performance === 'object' ? performance.now() - started : 0,
    },
  };
}
