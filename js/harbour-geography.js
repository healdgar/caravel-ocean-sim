// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What a harbour needs guarding, read from the height field alone: the water a ship must cross from the open sea to
// the anchorage off the town, where that water is narrowest, and which ground commands it. Works on any coast, real
// or made up. Everything is read once, when a port is laid out, on a fixed grid so that the answer does not depend
// on the resolution the terrain was built at.
const GRID_M = 32;
// Water shallower than this is foreshore. A ship does not go there, and a fort's feet may.
const WATER_M = -0.3;
// A channel a ship can use has this much water to the nearest land on each side.
const NAVIGABLE_CLEAR_M = 40;
const ANCHORAGE_CLEAR_M = 150;
const ANCHORAGE_LEAST_CLEAR_M = 64;
const ANCHORAGE_MOST_M = 4000;
// What shelter is worth against distance from the town, when ships choose where to lie. A wholly landlocked basin
// is worth going this much further for. Room to swing counts too, up to a point.
const SHELTER_WORTH_M = 1500;
const SHELTER_REACH_M = 2400;
const ANCHORAGE_ROOM_M = 320;
// How far a piece of the period reaches to any purpose against a ship.
export const HARBOUR_GUN_RANGE_M = 1000;
// A gun laid down further than this overshoots whatever is close under it.
const GUN_MOST_DEPRESSION = Math.tan((8 * Math.PI) / 180);
const GUN_ABOVE_GROUND_M = 7;
const TARGET_Y_M = 2;
// Water narrower than this can be closed by guns on one bank or crossed from both.
const NARROWS_MOST_WIDTH_M = 3400;
const NARROWS_ALONE_WIDTH_M = 1000;
// A narrow place is a real one if the water opens this much wider on both sides of it.
const NARROWS_OPENS_BY = 1.28;
const NARROWS_APART_M = 700;
const APPROACH_BEYOND_M = 4400;
const OPENING_WIDENS_BY = 2.2;
const OPENING_LEAST_SHELTER = 0.45;

function bilinear(heights, n, u, v) {
  const fx = Math.max(0, Math.min(n - 1, u * (n - 1))), fz = Math.max(0, Math.min(n - 1, v * (n - 1)));
  const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fz)), ax = fx - i, az = fz - j, k = j * n + i;
  return (heights[k] * (1 - ax) + heights[k + 1] * ax) * (1 - az) + (heights[k + n] * (1 - ax) + heights[k + n + 1] * ax) * az;
}

// Metres from every cell to the nearest cell of the other kind, by two chamfered passes.
function distanceToOther(isOther, nx, nz, cell) {
  const out = new Float32Array(nx * nz).fill(1e9), diagonal = cell * Math.SQRT2;
  for (let k = 0; k < nx * nz; k++) if (isOther(k)) out[k] = 0;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (i > 0) out[k] = Math.min(out[k], out[k - 1] + cell);
    if (j > 0) {
      out[k] = Math.min(out[k], out[k - nx] + cell);
      if (i > 0) out[k] = Math.min(out[k], out[k - nx - 1] + diagonal);
      if (i < nx - 1) out[k] = Math.min(out[k], out[k - nx + 1] + diagonal);
    }
  }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    if (i < nx - 1) out[k] = Math.min(out[k], out[k + 1] + cell);
    if (j < nz - 1) {
      out[k] = Math.min(out[k], out[k + nx] + cell);
      if (i < nx - 1) out[k] = Math.min(out[k], out[k + nx + 1] + diagonal);
      if (i > 0) out[k] = Math.min(out[k], out[k + nx - 1] + diagonal);
    }
  }
  return out;
}

class BestFirst {
  constructor() { this.keys = []; this.cells = []; }
  get size() { return this.cells.length; }
  push(key, cell) {
    const { keys, cells } = this;
    let i = cells.length;
    keys.push(key); cells.push(cell);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (keys[up] <= key) break;
      keys[i] = keys[up]; cells[i] = cells[up];
      i = up;
    }
    keys[i] = key; cells[i] = cell;
  }
  pop() {
    const { keys, cells } = this, top = cells[0], key = keys.pop(), cell = cells.pop(), n = cells.length;
    if (n) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child]; cells[i] = cells[child];
        i = child;
      }
      keys[i] = key; cells[i] = cell;
    }
    return top;
  }
}

// The share of bearings on which land stands within reach of this water.
function shelterAt(grid, k) {
  const { nx, cell, ground } = grid, x = grid.xOf(k), z = grid.zOf(k), rays = 16;
  let blocked = 0;
  for (let r = 0; r < rays; r++) {
    const angle = (r / rays) * Math.PI * 2, dx = Math.cos(angle), dz = Math.sin(angle);
    for (let d = cell * 2; d <= SHELTER_REACH_M; d += cell * 2) {
      const m = grid.at(x + dx * d, z + dz * d);
      if (m < 0) break;
      if (ground[m] >= WATER_M) { blocked++; break; }
    }
  }
  return blocked / rays;
}

const STEPS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

// The stretches of the chart's edge where water runs off it, each as a list of cells in order round the edge.
function waterEdges(grid, usable) {
  const { nx, nz } = grid, ring = [];
  for (let i = 0; i < nx; i++) ring.push(i);
  for (let j = 1; j < nz; j++) ring.push(j * nx + nx - 1);
  for (let i = nx - 2; i >= 0; i--) ring.push((nz - 1) * nx + i);
  for (let j = nz - 2; j > 0; j--) ring.push(j * nx);
  const first = ring.findIndex((k) => !usable(k));
  if (first < 0) return [ring];
  const edges = [];
  let run = null;
  for (let s = 1; s <= ring.length; s++) {
    const k = ring[(first + s) % ring.length];
    if (usable(k)) (run ??= []).push(k);
    else if (run) { edges.push(run); run = null; }
  }
  return edges;
}

/**
 * Read a coast. `town` is where the settlement meets the water, and `seaward` a compass bearing out to sea if the
 * record gives one. region.span and region.size say how heights lies on the ground, x east and z south.
 */
export function readHarbourGeography(heights, region, { town = null, seaward = null, seawardHint = null, anchorageAt = null } = {}) {
  const span = region.span, n = region.size;
  const nx = Math.round(span / GRID_M) + 1, nz = nx, cell = span / (nx - 1), count = nx * nz;
  const originX = region.x - span * 0.5, originZ = region.z - span * 0.5;
  const ground = new Float32Array(count);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) ground[j * nx + i] = bilinear(heights, n, i / (nx - 1), j / (nz - 1));
  const clear = distanceToOther((k) => ground[k] >= WATER_M, nx, nz, cell);
  const dry = distanceToOther((k) => ground[k] < WATER_M, nx, nz, cell);
  const grid = { nx, nz, cell, originX, originZ, span, ground, clear, dry, region };
  const at = (x, z) => {
    const i = Math.round((x - originX) / cell), j = Math.round((z - originZ) / cell);
    return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i;
  };
  const xOf = (k) => originX + (k % nx) * cell, zOf = (k) => originZ + Math.floor(k / nx) * cell;
  Object.assign(grid, { at, xOf, zOf });

  // Bodies of water a ship can move about in, and which reach the edge of the chart.
  const body = new Int32Array(count).fill(-1), bodies = [];
  const navigable = (k) => clear[k] >= NAVIGABLE_CLEAR_M;
  for (let k = 0; k < count; k++) {
    if (body[k] >= 0 || !navigable(k)) continue;
    const id = bodies.length, stack = [k];
    let cells = 0, open = false;
    body[k] = id;
    while (stack.length) {
      const c = stack.pop(), i = c % nx, j = Math.floor(c / nx);
      cells++;
      if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) open = true;
      for (const [di, dj] of STEPS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        const m = nj * nx + ni;
        if (body[m] < 0 && navigable(m)) { body[m] = id; stack.push(m); }
      }
    }
    bodies.push({ cells, open });
  }

  const townX = town?.x ?? region.x, townZ = town?.z ?? region.z;
  // The anchorage is the best water near the town from which a ship can get to sea: sheltered if there is any.
  let anchorCell = -1, anchorScore = Infinity, townCell = -1, townDistance = Infinity;
  for (const least of [ANCHORAGE_CLEAR_M, ANCHORAGE_LEAST_CLEAR_M]) {
    for (let j = 0; j < nz; j += 2) for (let i = 0; i < nx; i += 2) {
      const k = j * nx + i;
      if (clear[k] < least || body[k] < 0 || !bodies[body[k]].open) continue;
      const d = Math.hypot(xOf(k) - townX, zOf(k) - townZ);
      if (d > ANCHORAGE_MOST_M && !anchorageAt) continue;
      if (d < townDistance) { townDistance = d; townCell = k; }
      // Where the record says ships lay, if it says.
      const score = anchorageAt
        ? Math.hypot(xOf(k) - anchorageAt.x, zOf(k) - anchorageAt.z) * 3 - Math.min(clear[k], ANCHORAGE_ROOM_M)
        : d - SHELTER_WORTH_M * shelterAt(grid, k) - Math.min(clear[k], ANCHORAGE_ROOM_M);
      if (score < anchorScore) { anchorScore = score; anchorCell = k; }
    }
    if (anchorCell >= 0) break;
  }
  const out = {
    grid, town: { x: townX, z: townZ }, kind: 'landlocked', anchorage: null, townWater: null, route: [], approach: [], narrows: [], mouth: null, opening: null,
    sea: null, targets: [],
  };
  if (anchorCell < 0) return out;
  // Stand a little out from the bank, where ships really lie.
  let anchor = anchorCell;
  for (let hop = 0; hop < 6; hop++) {
    let best = anchor;
    for (const [di, dj] of STEPS) {
      const m = anchor + dj * nx + di;
      if (m >= 0 && m < count && body[m] === body[anchorCell] && clear[m] > clear[best]) best = m;
    }
    if (best === anchor) break;
    anchor = best;
  }
  out.anchorage = { x: xOf(anchor), z: zOf(anchor), clear: clear[anchor], shelter: shelterAt(grid, anchor) };
  out.townWater = { x: xOf(townCell), z: zOf(townCell), clear: clear[townCell] };

  // Where a ship comes from: the stretch of the chart's edge most like open sea.
  const anchorBody = body[anchor];
  const edges = waterEdges(grid, (k) => body[k] === anchorBody);
  const lookout = seaward ?? seawardHint, wantedX = lookout === null ? 0 : Math.sin((lookout * Math.PI) / 180), wantedZ = lookout === null ? 0 : -Math.cos((lookout * Math.PI) / 180);
  let seaEdge = null, seaScore = -Infinity;
  for (const edge of edges) {
    const middle = edge[edge.length >> 1], dx = xOf(middle) - out.anchorage.x, dz = zOf(middle) - out.anchorage.z, length = Math.hypot(dx, dz) || 1;
    let widest = 0;
    for (const k of edge) if (clear[k] > widest) widest = clear[k];
    const size = edge.length * cell + widest, alignment = (dx * wantedX + dz * wantedZ) / length;
    // A record's word is law, whatever the chart shows. A guess only tips the balance.
    const score = seaward !== null ? alignment * 1e6 + size : size * (1.25 + alignment);
    if (score > seaScore) { seaScore = score; seaEdge = edge; }
  }
  if (!seaEdge) return out;
  out.sea = { x: xOf(seaEdge[seaEdge.length >> 1]), z: zOf(seaEdge[seaEdge.length >> 1]), width: seaEdge.length * cell, edges: edges.length };

  // The widest water all the way out, then the shortest way that keeps to it and to the middle of the channel.
  const widestTo = new Float32Array(count), heap = new BestFirst();
  for (const k of seaEdge) { widestTo[k] = clear[k]; heap.push(-clear[k], k); }
  while (heap.size) {
    const c = heap.pop(), i = c % nx, j = Math.floor(c / nx), have = widestTo[c];
    for (const [di, dj] of STEPS) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const m = nj * nx + ni;
      if (body[m] !== anchorBody) continue;
      const could = Math.min(have, clear[m]);
      if (could > widestTo[m]) { widestTo[m] = could; heap.push(-could, m); }
    }
  }
  const bottleneck = widestTo[anchor] * 0.85;
  const cost = new Float64Array(count).fill(Infinity), from = new Int32Array(count).fill(-1);
  cost[anchor] = 0;
  heap.push(0, anchor);
  const isSea = new Uint8Array(count);
  for (const k of seaEdge) isSea[k] = 1;
  let reached = -1;
  while (heap.size) {
    const c = heap.pop();
    if (isSea[c]) { reached = c; break; }
    const i = c % nx, j = Math.floor(c / nx);
    for (const [di, dj, length] of STEPS) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const m = nj * nx + ni;
      if (body[m] !== anchorBody || clear[m] < Math.min(bottleneck, clear[anchor] * 0.85)) continue;
      const step = cost[c] + length * cell * (1 + 300 / clear[m]);
      if (step < cost[m]) { cost[m] = step; from[m] = c; heap.push(step, m); }
    }
  }
  if (reached < 0) return out;
  const cells = [];
  for (let c = reached; c >= 0; c = from[c]) cells.push(c);
  cells.reverse();
  let travelled = 0;
  out.route = cells.map((k, s) => {
    if (s) travelled += Math.hypot(xOf(k) - xOf(cells[s - 1]), zOf(k) - zOf(cells[s - 1]));
    return { x: xOf(k), z: zOf(k), clear: clear[k], s: travelled };
  });
  readNarrows(out);
  // The water guns must hold: from the anchorage out past the outermost narrows, or some way out to sea.
  const lastGuarded = out.mouth ? out.mouth.s : out.opening ? out.opening.s : 0;
  out.approach = out.route.filter((p) => p.s <= lastGuarded + APPROACH_BEYOND_M);
  out.targets = guardedTargets(out);
  // A river runs off the chart two ways, and is not much wider near the town than where it leaves.
  const riverine = edges.length > 1 && out.anchorage.clear < 1100 && out.anchorage.shelter >= OPENING_LEAST_SHELTER;
  out.kind = out.mouth ? 'mouth' : riverine ? 'river' : out.opening ? 'opening' : 'roadstead';
  return out;
}

// Where along the way out the water is narrow. A place counts if it opens wider on both sides of it.
function readNarrows(out) {
  const { route, grid } = out;
  const width = route.map((p) => p.clear * 2);
  const seen = [];
  for (let s = 1; s < route.length - 1; s++) {
    const here = width[s];
    if (here > NARROWS_MOST_WIDTH_M) continue;
    let lowest = true;
    for (let t = s - 1; t >= 0 && route[s].s - route[t].s < 320 && lowest; t--) if (width[t] < here) lowest = false;
    for (let t = s + 1; t < route.length && route[t].s - route[s].s < 320 && lowest; t++) if (width[t] < here) lowest = false;
    if (!lowest) continue;
    let inside = 0, outside = 0;
    for (let t = 0; t < s; t++) inside = Math.max(inside, width[t]);
    for (let t = s + 1; t < route.length; t++) outside = Math.max(outside, width[t]);
    if (outside < here * NARROWS_OPENS_BY) continue;
    // A long inner reach counts as well as a wide one: the town may lie in the channel itself.
    const insideReach = route[s].s > 500;
    if (inside < here * NARROWS_OPENS_BY && !(insideReach && here <= NARROWS_ALONE_WIDTH_M)) continue;
    if (seen.some((other) => Math.abs(other.s - route[s].s) < NARROWS_APART_M && other.width <= here)) continue;
    for (let i = seen.length - 1; i >= 0; i--) if (Math.abs(seen[i].s - route[s].s) < NARROWS_APART_M) seen.splice(i, 1);
    seen.push({ s: route[s].s, index: s, width: here, x: route[s].x, z: route[s].z, inside, outside });
  }
  for (const place of seen) Object.assign(place, shoresAcross(out, place.index));
  out.narrows = seen.filter((place) => place.left && place.right);
  // The mouth is the outermost narrow place. What lies inside it is an inner narrows.
  if (out.narrows.length) out.mouth = out.narrows[out.narrows.length - 1];
  // No narrows: the place the water round the anchorage opens out into something wider.
  if (!out.mouth && route.length > 2 && out.anchorage.shelter >= OPENING_LEAST_SHELTER) {
    const start = Math.max(route[0].clear, 80);
    const opens = route.find((p) => p.clear > start * OPENING_WIDENS_BY && p.s > 120);
    if (opens && opens.clear < NARROWS_MOST_WIDTH_M) out.opening = { s: opens.s, x: opens.x, z: opens.z, width: opens.clear * 2 };
  }
}

// The land on either hand at a place on the way out, as seen going out to sea.
function shoresAcross(out, index) {
  const { route, grid } = out, { at, ground, cell } = grid;
  const a = route[Math.max(0, index - 3)], b = route[Math.min(route.length - 1, index + 3)];
  const length = Math.hypot(b.x - a.x, b.z - a.z) || 1, ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;
  const shore = (hand) => {
    let best = null;
    for (let turn = -50; turn <= 50; turn += 10) {
      const angle = Math.atan2(uz, ux) + hand * Math.PI * 0.5 + (turn * Math.PI) / 180, dx = Math.cos(angle), dz = Math.sin(angle);
      for (let d = cell; d <= NARROWS_MOST_WIDTH_M; d += cell * 0.5) {
        const k = at(route[index].x + dx * d, route[index].z + dz * d);
        if (k < 0) break;
        if (ground[k] >= WATER_M) {
          if (!best || d < best.d) best = { d, x: route[index].x + dx * d, z: route[index].z + dz * d };
          break;
        }
      }
    }
    return best;
  };
  const left = shore(-1), right = shore(1);
  return { left, right, ux, uz };
}

function guardedTargets(out) {
  const targets = [], { anchorage, approach, grid } = out;
  for (let s = 0, last = -Infinity; s < approach.length; s++) {
    if (approach[s].s - last < 80) continue;
    last = approach[s].s;
    targets.push({ x: approach[s].x, z: approach[s].z, weight: 1 });
  }
  // The anchorage counts for most: it is what the guns are there to keep.
  for (const water of out.townWater ? [anchorage, out.townWater] : [anchorage]) {
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2, x = water.x + Math.cos(angle) * water.clear * 0.6, z = water.z + Math.sin(angle) * water.clear * 0.6, k = grid.at(x, z);
      if (k >= 0 && grid.ground[k] < WATER_M) targets.push({ x, z, weight: 1.5 });
    }
  }
  for (const place of out.narrows) {
    for (const t of [-0.5, 0, 0.5]) targets.push({ x: place.x - place.uz * place.width * t * 0.7, z: place.z + place.ux * place.width * t * 0.7, weight: 3 });
  }
  return targets;
}

// Whether a straight flight from a gun at this ground to a ship at this spot meets the land or goes over it.
export function gunLineClear(grid, x, z, gunY, tx, tz) {
  const { at, ground, cell } = grid, length = Math.hypot(tx - x, tz - z);
  if (length < 1) return true;
  if ((gunY - TARGET_Y_M) / length > GUN_MOST_DEPRESSION) return false;
  const steps = Math.ceil(length / cell);
  for (let s = 1; s < steps; s++) {
    const t = s / steps, k = at(x + (tx - x) * t, z + (tz - z) * t);
    if (k < 0) continue;
    if (ground[k] > gunY + (TARGET_Y_M - gunY) * t) return false;
  }
  return true;
}

// How much of the guarded water a fort at this spot could lay guns on: a share, and the way that water lies from it.
export function commandFrom(harbour, x, z, { range = HARBOUR_GUN_RANGE_M, targets = harbour.targets, gunAbove = GUN_ABOVE_GROUND_M } = {}) {
  const { grid } = harbour, k = grid.at(x, z);
  const gunY = (k >= 0 ? Math.max(0, grid.ground[k]) : 0) + gunAbove;
  let total = 0, held = 0, sumX = 0, sumZ = 0;
  for (const target of targets) {
    total += target.weight;
    const d = Math.hypot(target.x - x, target.z - z);
    if (d > range || d < 1) continue;
    if (!gunLineClear(grid, x, z, gunY, target.x, target.z)) continue;
    held += target.weight;
    // Nearer water matters more to a gun.
    const pull = target.weight * (1.2 - d / range) / d;
    sumX += (target.x - x) * pull;
    sumZ += (target.z - z) * pull;
  }
  const length = Math.hypot(sumX, sumZ);
  return { share: total ? held / total : 0, held, faceX: length ? sumX / length : 0, faceZ: length ? sumZ / length : 0 };
}

// What share of the country round a spot is water, at a radius: a point of land reads high, a bay's head low.
export function waterRound(grid, x, z, radius) {
  let wet = 0;
  const rays = 32;
  for (let r = 0; r < rays; r++) {
    const angle = (r / rays) * Math.PI * 2, k = grid.at(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
    if (k < 0 || grid.ground[k] < WATER_M) wet++;
  }
  return wet / rays;
}

/**
 * The best ground for a fort that must hold the water, among land near a place. Searches outward to `reach` metres.
 * `side` limits it to one hand of a line: {x, z, ux, uz, hand}, going along (ux, uz); hand -1 left and +1 right.
 * `taken` are spots others stand on, with how far apart they must be. Returns null if nothing near will do.
 */
export function bestGroundNear(harbour, near, { reach = 700, side = null, taken = [], apart = 170, highest = 70, furthestFromWater = 150, flatOver = 40, mostRise = 9, leastFromWater = 0, commandWeight = 1, nearWeight = 0.5, pointWeight = 0.25, targets = harbour.targets } = {}) {
  const { grid } = harbour, { nx, nz, cell, ground, dry, at, xOf, zOf } = grid;
  const i0 = Math.max(0, Math.floor((near.x - reach - grid.originX) / cell)), i1 = Math.min(nx - 1, Math.ceil((near.x + reach - grid.originX) / cell));
  const j0 = Math.max(0, Math.floor((near.z - reach - grid.originZ) / cell)), j1 = Math.min(nz - 1, Math.ceil((near.z + reach - grid.originZ) / cell));
  let best = null;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const k = j * nx + i, h = ground[k];
    if (h < 0.6 || h > highest || dry[k] > furthestFromWater || dry[k] < leastFromWater) continue;
    const x = xOf(k), z = zOf(k), d = Math.hypot(x - near.x, z - near.z);
    if (d > reach) continue;
    if (side && ((x - side.x) * -side.uz + (z - side.z) * side.ux) * side.hand <= 0) continue;
    if (taken.some((spot) => Math.hypot(spot.x - x, spot.z - z) < (spot.apart ?? apart))) continue;
    // A fort wants room to stand: no cliff within its own walls.
    let low = Infinity, high = -Infinity;
    for (const [dx, dz] of [[flatOver, 0], [-flatOver, 0], [0, flatOver], [0, -flatOver]]) {
      const m = at(x + dx, z + dz);
      if (m < 0) continue;
      const g = Math.max(0, ground[m]);
      if (g < low) low = g;
      if (g > high) high = g;
    }
    if (high - Math.max(low, h) > mostRise) continue;
    const command = commandFrom(harbour, x, z, { targets }).share;
    // A bluff has dead water under it, and costs a gun its first few hundred metres.
    const score = command * commandWeight - (d / reach) * nearWeight + waterRound(grid, x, z, 220) * pointWeight - (dry[k] / furthestFromWater) * 0.2 - Math.max(0, h - 14) * 0.012 * commandWeight;
    if (!best || score > best.score) best = { x, z, score, command, h, dry: dry[k] };
  }
  return best;
}
