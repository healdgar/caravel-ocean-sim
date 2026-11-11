// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A coast as Castle and Commons' model founded it (its board: js/board-model.js), stood up in this game. The board
// says only what stands where. Everything that stands is this game's own: each building a type written in Cairn
// (js/old-world-buildings.js), so it is drawn, lit, struck and broken as every other; walls, towers and gates by
// the same masons as the city generator's (js/old-world-city.js); woodland handed to the forest; water left as the
// game has it. Ground keeps the look of its geography: what the board adds to it is drawn by the GPU
// (js/board-stamp.js) from the compact tables made here once.
import { CITY_BLOCK_FLOATS, CITY_GROUND, CITY_ROOF, CITY_TREES, CITY_WALL, cityFootprintsOverlap, cityMasonry, footprint, local, makeHash, mulberry, rectDist, segDist } from './old-world-city.js';
import { CITY_BUILDING_TYPES, CITY_CHURCH, CITY_CURTAIN, CITY_HALL, CITY_HOUSE_STOREYS, CITY_STOREY_M, CITY_TYPE, CITY_TYPED_ROOF, cityHouseType } from './old-world-buildings.js';

// The board's furlongs are drawn into a square of cells this many to a side, each cell holding the furlong it
// lies in (plus one; none is 0). The same square answers the land's questions here and is the GPU's to stamp from.
export const BOARD_INDEX_SIZE = 1024;
// What the model calls a furlong's holding (LK) and standing (LS), as its program has them.
const BOARD_HELD = Object.freeze({ NONE: 0, FIELD: 1, HUFE: 2, MEADOW: 3, GARDEN: 4, VINE: 5, DEMESNE: 6, CLOSE: 7 });
const BOARD_STANDS = Object.freeze({ WILD: 0, WOOD: 1, TILLED: 2, PASTURE: 3, SCRUB: 4, BURNT: 5 });
// The chance a furlong of each land use (OLD_WORLD_LAND) is bounded by a line of trees.
const BOARD_HEDGED_SHARE = [0, 0.6, 0.3, 0.3, 0.25, 0.25, 0.22, 0, 0];
// A stone curtain stands CITY_CURTAIN.height; a palisade this high.
const BOARD_PALISADE_M = 5.5;
const BOARD_HOUSE_TINTS = [0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 4];
const BOARD_DRY_M = 1.0;

function boardHashUnit(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Fill a closed figure of [x, z, x, z...] cells into the index square with a value.
function fillBoardFigure(index, size, points, value) {
  const n = points.length / 2;
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) { lo = Math.min(lo, points[k * 2 + 1]); hi = Math.max(hi, points[k * 2 + 1]); }
  const crossings = [];
  for (let j = Math.max(0, Math.floor(lo)); j <= Math.min(size - 1, Math.floor(hi)); j++) {
    const y = j + 0.5;
    crossings.length = 0;
    for (let k = 0; k < n; k++) {
      const ax = points[k * 2], ay = points[k * 2 + 1], bx = points[((k + 1) % n) * 2], by = points[((k + 1) % n) * 2 + 1];
      if ((ay <= y) !== (by <= y)) crossings.push(ax + (bx - ax) * (y - ay) / (by - ay));
    }
    crossings.sort((a, b) => a - b);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      for (let i = Math.max(0, Math.round(crossings[c])); i < Math.min(size, Math.round(crossings[c + 1])); i++) index[j * size + i] = value;
    }
  }
}

/**
 * Stand a board up on its ground. `baked` is a board with what it was founded for (assets/boards/*.json); `region`
 * the ground's square; `grid` its lattice ({n, step, x0, z0}); `heightAt` its heights; `port` the port already
 * placed there, whose own buildings and streets the board gives way to. `LAND` is OLD_WORLD_LAND, `fieldAt` and
 * `distanceTo` the lattice's own readers (js/old-world.js).
 */
export function layBoardCountry({ baked, region, grid, heightAt, port, wet, LAND, fieldAt, distanceTo }) {
  const started = typeof performance === 'object' ? performance.now() : 0;
  const board = baked.board, ox = region.x, oz = region.z, half = region.span / 2;
  const bounds = { x0: ox - half, z0: oz - half, x1: ox + half, z1: oz + half };
  const inside = (x, z, pad) => x > bounds.x0 + pad && x < bounds.x1 - pad && z > bounds.z0 + pad && z < bounds.z1 - pad;
  const rr = mulberry((Math.round(port.center.x * 7.3) * 73856093) ^ (Math.round(port.center.z * 5.1) * 19349663) ^ (board.seed | 0) ^ 0x2b0a4d17);
  const blocks = [], typed = [], typedTypes = [], typedBlocks = [], gates = [], lots = [], churches = [];
  const solids = makeHash(32), placed = makeHash(16), segs = makeHash(24);
  const keep = (f, r = Math.hypot(f.w, f.d) / 2) => solids.add(f, f.x - r, f.z - r, f.x + r, f.z + r);
  const { seatBlock, pushBlock, pushTyped, curtain, tower, gate } = cityMasonry({ heightAt, blocks, typed, typedTypes, typedBlocks, gates, keep, rr });
  // The port's own buildings stand where they stand; the board builds round them.
  for (const inst of port.instances || []) {
    const f = { x: inst.x, z: inst.z, w: (inst.width ?? 12) + 2, d: (inst.depth ?? inst.length ?? 20) + 2, c: inst._cosNegYaw ?? Math.cos(inst.yaw ?? 0), s: inst._sinNegYaw ?? Math.sin(inst.yaw ?? 0) };
    keep(f);
  }
  const taken = (f, gap) => solids.some(f.x, f.z, Math.hypot(f.w, f.d) / 2 + 34, (o) => cityFootprintsOverlap(f, o, gap));
  const occupy = (f) => { const r = Math.hypot(f.w, f.d) / 2; placed.add(f, f.x - r, f.z - r, f.x + r, f.z + r); lots.push(f); };

  const places = board.places.map((p) => ({ ...p, x: ox + p.x, z: oz + p.z }));
  const seat = places[0];
  const dropped = { wet: 0, port: 0, steep: 0, edge: 0 };

  /* ---- streets and squares: where they run, for the ground's answers; the seat's own to the paving field ---- */
  const streets = [], squares = [], paving = [];
  places.forEach((place, at) => {
    for (const street of place.streets) {
      const pts = [];
      for (let k = 0; k < street.points.length; k += 2) pts.push([ox + street.points[k], oz + street.points[k + 1]]);
      const lane = street.kind === 'lane' || street.kind === 'alley', st = { pts, hw: Math.max(1.2, street.half), kind: street.kind, place: at, paved: lane ? 0.5 : 1 };
      streets.push(st);
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        segs.add({ ax, az, bx, bz, hw: st.hw }, Math.min(ax, bx) - st.hw, Math.min(az, bz) - st.hw, Math.max(ax, bx) + st.hw, Math.max(az, bz) + st.hw);
      }
      if (at === 0 && pts.length > 1) paving.push({ points: pts.filter(([x, z]) => inside(x, z, 4)).map(([x, z]) => [x, z, st.hw * 2, st.paved]) });
    }
    for (const sq of place.squares) {
      const rad = sq.rad, mean = rad.reduce((a, b) => a + b, 0) / rad.length, R = Math.max(...rad);
      const square = { x: ox + sq.x, z: oz + sq.z, rad, R, mean, kind: sq.kind === 'green' ? 'park' : 'square', place: at };
      squares.push(square);
      if (at === 0 && square.kind === 'square') paving.push({ points: [[square.x - 0.5, square.z, mean * 2, 1], [square.x + 0.5, square.z, mean * 2, 1]] });
    }
  });
  for (let k = paving.length - 1; k >= 0; k--) if (paving[k].points.length < 2) paving.splice(k, 1);
  const squareRadius = (p, x, z) => {
    const n = p.rad.length, a = Math.atan2(z - p.z, x - p.x) / (2 * Math.PI) * n, i = Math.floor(a), f = a - i;
    return p.rad[((i % n) + n) % n] * (1 - f) + p.rad[(((i + 1) % n) + n) % n] * f;
  };
  const inSquare = (x, z, pad) => { for (const p of squares) { const d = Math.hypot(x - p.x, z - p.z); if (d < p.R + pad && d < squareRadius(p, x, z) + pad) return p; } return null; };
  const streetEdge = (x, z, reach) => { let bd = reach; segs.some(x, z, reach + 6, (g) => { const d = segDist(x, z, g.ax, g.az, g.bx, g.bz) - g.hw; if (d < bd) bd = d; }); return bd; };

  /* ---- walls: a ring of radii about a centre, one to each bearing, with gates where the model has them ---- */
  const ring = (cx, cz, rad, kind, gateAngles, stoneHeight, towerEvery = 56) => {
    const n = rad.length, pts = [], first = gates.length;
    for (let k = 0; k < n; k++) {
      const a = k / n * 2 * Math.PI, x = cx + Math.cos(a) * rad[k], z = cz + Math.sin(a) * rad[k];
      const dry = inside(x, z, 20) && heightAt(x, z) > 1.4;
      pts.push({ x, z, stone: !kind || kind[k] >= 2, open: (kind && !kind[k]) || !dry || taken(footprint(x, z, 6, 6, 0), 2) });
    }
    for (const angle of gateAngles) {
      const at = ((angle / (2 * Math.PI) * n) % n + n) % n, k = Math.floor(at), f = at - k, a = pts[k], b = pts[(k + 1) % n];
      if (a.open || b.open) continue;
      gates.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, half: 3.4, k });
    }
    let since = towerEvery;
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[(k + 1) % n], prev = pts[(k + n - 1) % n];
      if (a.open) { since = towerEvery; continue; }
      const height = a.stone ? stoneHeight : BOARD_PALISADE_M;
      const nearGate = gates.some((q) => Math.hypot(q.x - a.x, q.z - a.z) < q.half + 9);
      if (a.stone && !nearGate && (since >= towerEvery || prev.open || b.open)) { tower(a.x, a.z, 6.2, height + 3.5 + rr() * 1.5, 0.86 + rr() * 0.12); since = 0; }
      if (b.open) continue;
      curtain(a.x, a.z, b.x, b.z, [a.x - cx, a.z - cz], height, a.stone ? 0.84 + rr() * 0.1 : 0.62 + rr() * 0.08);
      since += Math.hypot(b.x - a.x, b.z - a.z);
    }
    for (let g = first; g < gates.length; g++) {
      const q = gates[g], a = pts[q.k], b = pts[(q.k + 1) % n], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      gate(q, (b.x - a.x) / L, (b.z - a.z) / L);
    }
  };
  for (const place of places) {
    if (place.wall) ring(place.x, place.z, place.wall.rad, place.wall.kind, place.wall.gates, CITY_CURTAIN.height);
    const hill = place.castle?.hill, citadel = place.castle?.citadel;
    if (hill?.rad?.length) ring(ox + hill.x, oz + hill.z, hill.rad, hill.kind, [hill.gate], Math.max(7.5, hill.height || 0) + 2, 40);
    if (citadel?.rad?.length) ring(ox + citadel.x, oz + citadel.z, citadel.rad, null, [citadel.gate], 9.5, 48);
  }

  /* ---- buildings: each one the model stood, as this game's type of that size, turned to its street ---- */
  const { count, stand, form, kinds } = board.buildings, arches = board.arches;
  let houses = 0;
  const standHouse = (k, f, storeys, toStreet) => {
    const wallH = storeys * CITY_STOREY_M + boardHashUnit(k, 11) * 0.5;
    const base = seatBlock(f, toStreet ? heightAt(f.x - Math.sin(f.yaw) * (f.d / 2 + 1.5), f.z - Math.cos(f.yaw) * (f.d / 2 + 1.5)) : null);
    if (base.range > 7.5) { dropped.steep++; return; }
    const hue = form[k * 3 + 2], tone = BOARD_HOUSE_TINTS[Math.floor(boardHashUnit(k, 23) * BOARD_HOUSE_TINTS.length)] + 0.2 + 0.75 * (hue > 0 && hue < 1 ? hue : boardHashUnit(k, 31));
    // A broad front keeps its eaves to the street; a narrow, deep plot more often turns its gable to it.
    const eaves = boardHashUnit(k, 47) < (f.w >= f.d * 0.8 ? 0.85 : 0.5), type = cityHouseType(storeys, eaves), T = CITY_BUILDING_TYPES[type], up = wallH / T.height;
    if (eaves) pushBlock(footprint(f.x, f.z, f.d, f.w, f.yaw + Math.PI / 2), wallH, 0.36 * T.length / 2 * up, CITY_ROOF.GABLE + CITY_TYPED_ROOF, CITY_WALL.HOUSE, tone, base);
    else pushBlock(f, wallH, 0.5 * T.width / 2 * up, CITY_ROOF.GABLE + CITY_TYPED_ROOF, CITY_WALL.HOUSE, tone, base);
    pushTyped(type, f.x, base.floor, f.z, f.yaw, f.w, wallH, f.d, tone);
    occupy(f); houses++;
  };
  const standChurch = (k, f, great, tall) => {
    const C = great ? CITY_CHURCH.great : CITY_CHURCH.parish;
    const w = Math.max(8, Math.min(great ? 17 : 13, f.w)), d = Math.max(18, Math.min(great ? 44 : 32, f.d)), h = Math.max(9, Math.min(16, tall));
    const across = w / C.width, along = d / C.depth, up = h / C.height, tw = C.tower * across, td = C.tower * along;
    const nave = footprint(f.x, f.z, w, d, f.yaw), base = seatBlock(nave), tone = 0.94 + boardHashUnit(k, 5) * 0.06;
    if (base.range > 9) { dropped.steep++; return; }
    pushBlock(nave, h, (0.42 * C.width / 2 + 0.6) * up, CITY_ROOF.GABLE + CITY_TYPED_ROOF, great ? CITY_WALL.ASHLAR : CITY_WALL.STUCCO, tone, base);
    const sides = great ? [-1, 1] : [boardHashUnit(k, 7) < 0.5 ? -1 : 1];
    for (const side of sides) {
      const [tx, tz] = local(nave, side * (w / 2 + tw / 2 - 0.3 * across), -d / 2 + td / 2), top = seatBlock(footprint(tx, tz, tw, td, f.yaw));
      blocks.push(tx, base.floor, tz, f.yaw, tw, td, (C.height + CITY_CHURCH.towerRise) * up, CITY_CHURCH.spire * up, CITY_ROOF.PYRAMID + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, 0.93, Math.max(top.plinth, base.floor - top.floor + top.plinth));
    }
    pushTyped(great ? CITY_TYPE.CHURCH_GREAT : sides[0] < 0 ? CITY_TYPE.CHURCH_LEFT : CITY_TYPE.CHURCH_RIGHT, nave.x, base.floor, nave.z, f.yaw, w, h, d, tone, 1 + sides.length);
    const whole = footprint(nave.x, nave.z, w + 2 * tw, d, f.yaw);
    keep(whole); occupy(whole);
    churches.push({ x: nave.x, z: nave.z, great });
  };
  for (let k = 0; k < count; k++) {
    const place = kinds[k * 6], arch = arches[kinds[k * 6 + 1]], church = kinds[k * 6 + 4];
    const x = ox + stand[k * 6], z = oz + stand[k * 6 + 1], rot = stand[k * 6 + 2], w = stand[k * 6 + 3], d = stand[k * 6 + 4], h = stand[k * 6 + 5];
    if (!inside(x, z, 12)) { dropped.edge++; continue; }
    if (heightAt(x, z) < BOARD_DRY_M) { dropped.wet++; continue; }
    // Turned so that its own back (+z) is away from its street; a quarter turn swaps its front and depth.
    const fx = form[k * 3], fz = form[k * 3 + 1];
    let yaw = rot, front = w, depth = d;
    if (fx || fz) {
      const want = Math.atan2(-fx, -fz);
      let best = 0, least = 9;
      for (let q = 0; q < 4; q++) { const a = rot + q * Math.PI / 2, off = Math.abs(Math.atan2(Math.sin(a - want), Math.cos(a - want))); if (off < least) { least = off; best = q; } }
      yaw = rot + best * Math.PI / 2;
      if (best & 1) { front = d; depth = w; }
    }
    const f = footprint(x, z, front, depth, yaw);
    if (taken(f, 0.8)) { dropped.port++; continue; }
    if (arch === 'temple') {
      // A church's length runs back from its door.
      const long = front > depth ? footprint(x, z, depth, front, yaw + Math.PI / 2) : f;
      standChurch(k, long, (church & 3) === 3, h);
    } else if (arch === 'keep') {
      tower(x, z, Math.max(9, Math.min(14, Math.max(w, d))), Math.max(18, h), 0.95, CITY_TYPE.KEEP);
      occupy(footprint(x, z, Math.max(w, d), Math.max(w, d), yaw));
    } else if (arch === 'hall') {
      const long = front > depth ? footprint(x, z, depth, front, yaw + Math.PI / 2) : f;
      const floor = pushBlock(long, CITY_HALL.height, CITY_HALL.roof, CITY_ROOF.HIP + CITY_TYPED_ROOF, CITY_WALL.HOUSE, 0.9);
      pushTyped(CITY_TYPE.HALL, long.x, floor, long.z, long.yaw, long.w, CITY_HALL.height, long.d, 0.9);
      keep(long); occupy(long);
    } else {
      // The model builds low: a house of one or two floors. A port city of the sixteenth century stood tall and
      // close toward its middle, so the seat's houses gain floors as they near it.
      let storeys = Math.max(1, Math.min(CITY_HOUSE_STOREYS, Math.round(h / CITY_STOREY_M)));
      if (arch === 'shed') storeys = 1;
      else if (place === 0 && seat.reach > 0) {
        const near = 1 - Math.hypot(x - seat.x, z - seat.z) / seat.reach;
        storeys = Math.min(CITY_HOUSE_STOREYS, storeys + (near > 0.72 ? 2 : near > 0.4 ? 1 : 0) + (arch === 'burgher' && near > 0.55 ? 1 : 0));
      }
      standHouse(k, f, storeys, fx || fz);
    }
  }

  /* ---- what any point of a town's ground is, and where a tree may stand in it ---- */
  const houseNear = (x, z, reach) => placed.some(x, z, reach, (o) => rectDist(o, x, z) <= reach);
  const groundAt = (x, z) => {
    if (houseNear(x, z, 0)) return CITY_GROUND.HOUSE;
    if (streetEdge(x, z, 1) <= 0.4) return CITY_GROUND.STREET;
    const p = inSquare(x, z, 0);
    return p ? (p.kind === 'park' ? CITY_GROUND.PARK : CITY_GROUND.SQUARE) : CITY_GROUND.YARD;
  };
  const cityTreesAt = (x, z) => {
    const p = inSquare(x, z, 0);
    if (p) {
      if (streetEdge(x, z, 5) < 4) return CITY_TREES.NONE;
      if (p.kind === 'park') return houseNear(x, z, 3) ? CITY_TREES.NONE : CITY_TREES.PARK;
      const at = Math.hypot(x - p.x, z - p.z) / squareRadius(p, x, z);
      return at > 0.66 && at < 0.92 ? CITY_TREES.SQUARE : CITY_TREES.NONE;
    }
    if (streetEdge(x, z, 4) < 3.5 || houseNear(x, z, 3.2) || !houseNear(x, z, 24)) return CITY_TREES.NONE;
    if (solids.some(x, z, 6, (o) => rectDist(o, x, z) < 4)) return CITY_TREES.NONE;
    return CITY_TREES.YARD;
  };
  // A ring of shade round each market place, a few trees on each green.
  const standing = [];
  for (const p of squares) {
    const around = Math.max(6, Math.round(2 * Math.PI * 0.8 * p.mean / 9.5));
    for (let k = 0; k < around; k++) {
      const a = k / around * 2 * Math.PI, far = squareRadius(p, p.x + Math.cos(a), p.z + Math.sin(a)) * 0.8, x = p.x + Math.cos(a) * far, z = p.z + Math.sin(a) * far;
      if (inside(x, z, 8) && heightAt(x, z) > BOARD_DRY_M && cityTreesAt(x, z) !== CITY_TREES.NONE) standing.push([x, z]);
    }
  }

  /* ---- the town on the lattice: where it stands, how far beyond it each point lies, how near its middle ---- */
  const n = grid.n, urbanMark = new Uint8Array(n * n), early = new Float32Array(n * n).fill(-1);
  const mark = (x, z, reach, place) => {
    const i0 = Math.max(0, Math.floor((x - reach - grid.x0) / grid.step)), i1 = Math.min(n - 1, Math.ceil((x + reach - grid.x0) / grid.step));
    const j0 = Math.max(0, Math.floor((z - reach - grid.z0) / grid.step)), j1 = Math.min(n - 1, Math.ceil((z + reach - grid.z0) / grid.step));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = grid.x0 + i * grid.step, pz = grid.z0 + j * grid.step;
      if (Math.hypot(px - x, pz - z) > reach + grid.step * 0.5) continue;
      const k = j * n + i, p = places[place];
      urbanMark[k] = 1;
      if (early[k] < 0) early[k] = Math.min(1, Math.hypot(px - p.x, pz - p.z) / Math.max(60, p.reach || p.radius || 200));
    }
  };
  for (const f of lots) mark(f.x, f.z, 14, 0);
  for (let k = 0; k < count; k++) {
    const x = ox + stand[k * 6], z = oz + stand[k * 6 + 1];
    if (inside(x, z, 12) && heightAt(x, z) >= BOARD_DRY_M) mark(x, z, 14, kinds[k * 6]);
  }
  for (const p of squares) mark(p.x, p.z, p.mean, p.place);
  const urban = new Float32Array(n * n);
  let cells = 0;
  for (let k = 0; k < urban.length; k++) if (urbanMark[k]) { urban[k] = 1; cells++; }
  const town = { grid: urban, urban, beyond: distanceTo(urbanMark, n, grid.step), early, area: cells * grid.step * grid.step, inland: distanceTo(wet, n, grid.step) };

  /* ---- the furlongs: every cell of the index square knows its furlong; every furlong its use ---- */
  const size = BOARD_INDEX_SIZE, cell = region.span / size, index = new Uint16Array(size * size);
  const fields = board.fields, uses = new Array(fields.length), figures = new Array(fields.length);
  const toCell = (v) => (v + half) / cell;
  fields.forEach((field, id) => {
    const cells = new Float64Array(field.points.length), figure = new Float64Array(field.points.length);
    for (let k = 0; k < field.points.length; k += 2) {
      cells[k] = toCell(field.points[k]); cells[k + 1] = toCell(field.points[k + 1]);
      figure[k] = ox + field.points[k]; figure[k + 1] = oz + field.points[k + 1];
    }
    fillBoardFigure(index, size, cells, id + 1);
    figures[id] = figure;
    let kind;
    if (field.state === BOARD_STANDS.WOOD) kind = LAND.WOOD;
    else if (field.state === BOARD_STANDS.TILLED) {
      kind = field.kind === BOARD_HELD.GARDEN ? LAND.GARDEN : field.kind === BOARD_HELD.VINE ? LAND.VINES : field.kind === BOARD_HELD.CLOSE ? LAND.OLIVES : field.kind === BOARD_HELD.MEADOW ? LAND.PASTURE
        // Corn stands one year in two.
        : boardHashUnit(id, 3) < 0.38 ? LAND.FALLOW : LAND.CORN;
    } else if (field.state === BOARD_STANDS.PASTURE) kind = LAND.PASTURE;
    else if (field.state === BOARD_STANDS.SCRUB) kind = LAND.SCRUB;
    else if (field.state === BOARD_STANDS.BURNT) kind = LAND.FALLOW;
    // No one's ground: rough grazing with a tree here and there, as the country round a city was.
    else kind = LAND.PASTURE;
    const wild = field.state === BOARD_STANDS.WILD;
    uses[id] = {
      kind, wild, place: field.place, heading: field.heading, strip: field.strip,
      shade: boardHashUnit(id, 17), turn: boardHashUnit(id, 29),
      wooded: kind === LAND.PASTURE && boardHashUnit(id, 41) < (wild ? 0.62 : 0.4),
      hedged: !wild && boardHashUnit(id, 53) < BOARD_HEDGED_SHARE[kind],
    };
  });
  // How far a point lies inside its furlong: to the nearest side of the figure.
  const edgeOf = (id, x, z) => {
    const p = figures[id], m = p.length / 2;
    let best = 1e9;
    for (let k = 0; k < m; k++) best = Math.min(best, segDist(x, z, p[k * 2], p[k * 2 + 1], p[((k + 1) % m) * 2], p[((k + 1) % m) * 2 + 1]));
    return best;
  };
  const NO_PARCEL = { use: { kind: LAND.SCRUB, wild: true, shade: 0.5, turn: 0.5, wooded: false, hedged: false }, edge: 1e9, i: 0, j: 0 };
  const parcelAt = (x, z) => {
    const i = Math.floor((x - bounds.x0) / cell), j = Math.floor((z - bounds.z0) / cell);
    const id = i < 0 || j < 0 || i >= size || j >= size ? -1 : index[j * size + i] - 1;
    if (id < 0) return NO_PARCEL;
    const use = uses[id];
    return { use, edge: use.hedged ? edgeOf(id, x, z) : 1e9, i: id, j: 0 };
  };

  /* ---- roads between the places, for the trees that line them and for the stamp ---- */
  const roads = board.roads.map((road) => { const line = []; for (let k = 0; k < road.points.length; k += 2) line.push([ox + road.points[k], oz + road.points[k + 1]]); return line; }).filter((line) => line.length > 1);

  const blockCount = blocks.length / CITY_BLOCK_FLOATS;
  const plan = {
    blocks: new Float32Array(blocks), count: blockCount, houses, streets, places: squares, gates, churches, lots, paving, standing,
    typed: new Float32Array(typed), typedTypes: new Uint32Array(typedTypes), typedCount: typedTypes.length, typedBlocks: new Uint32Array(typedBlocks),
    groundAt, treesAt: cityTreesAt,
    stats: {
      blocks: blockCount, typed: typedTypes.length, houses, streets: streets.length, churches: churches.length, gates: gates.length,
      lanes: streets.filter((s) => s.kind === 'lane' || s.kind === 'alley').length, squares: squares.length, places: places.length,
      furlongs: fields.length, people: board.people, dropped,
      milliseconds: typeof performance === 'object' ? performance.now() - started : 0,
    },
  };
  return {
    plan, town, roads, parcelAt, places, seat,
    // For the GPU, which stamps the country onto the ground's own colours: the furlong of every cell, each
    // furlong's use, and every way that runs across it.
    stamp: {
      size, index, uses, roads, streets, squares, lots, town: urban, lanes: board.lanes, rivers: board.rivers.map((river) => river.points),
      origin: { x: ox, z: oz }, span: region.span,
    },
  };
}
