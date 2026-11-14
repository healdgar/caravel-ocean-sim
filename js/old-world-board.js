// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A coast as Castle and Commons' model founded it (its board: js/board-model.js), stood up in this game. The board
// says only what stands where. Everything that stands is this game's own: each building a type written in Cairn
// (js/old-world-buildings.js), so it is drawn, lit, struck and broken as every other; walls, towers and gates by
// the same masons as the city generator's (js/old-world-city.js); woodland handed to the forest; water left as the
// game has it. Ground keeps the look of its geography: what the board adds to it is drawn by the GPU
// (js/board-stamp.js) from the compact tables made here once.
import { CITY_BLOCK_FLOATS, CITY_GROUND, CITY_ROOF, CITY_TREES, CITY_WALL, cityFootprintsOverlap, cityMasonry, footprint, local, makeHash, mulberry, rectDist, segDist, segRectDist } from './old-world-city.js';
import { CITY_BUILDING_TYPES, CITY_CHURCH, CITY_CURTAIN, CITY_HALL, CITY_HOUSE_STOREYS, CITY_PAINT, CITY_STOREY_M, CITY_THATCH_ROOF, CITY_TYPE, CITY_TYPED_ROOF, cityHouseType } from './old-world-buildings.js';
import { WORKS_FENCE_M, WORKS_WHEEL } from './old-world-works.js';

// The board's furlongs are drawn into a square of cells this many to a side, each cell holding the furlong it
// lies in (plus one; none is 0). The same square answers the land's questions here and is the GPU's to stamp from.
export const BOARD_INDEX_SIZE = 1024;
// What the model calls a furlong's holding (LK) and standing (LS), as its program has them.
const BOARD_HELD = Object.freeze({ NONE: 0, FIELD: 1, HUFE: 2, MEADOW: 3, GARDEN: 4, VINE: 5, DEMESNE: 6, CLOSE: 7 });
const BOARD_STANDS = Object.freeze({ WILD: 0, WOOD: 1, TILLED: 2, PASTURE: 3, SCRUB: 4, BURNT: 5 });
// The chance a furlong of each land use (OLD_WORLD_LAND) is bounded by a line of trees.
const BOARD_HEDGED_SHARE = [0, 0.6, 0.3, 0.3, 0.25, 0.25, 0.22, 0, 0];
// What hangs on a trade's front, by the model's own rule (its STREETFRONT): a pentice over the open shop (`true`, a
// cloth of the house's own colour), a sign board on its bracket, the ale-stake's bush. A burgher's house in the
// market quarter is a shop.
export const BOARD_STREETFRONT = Object.freeze({
  shop: { awn: true, sign: CITY_PAINT.BLUE }, bakery: { awn: CITY_PAINT.BROWN, sign: CITY_PAINT.GOLD }, tavern: { sign: CITY_PAINT.GREEN, bush: true }, inn: { sign: CITY_PAINT.RED, bush: true, awn: CITY_PAINT.BROWN },
  smithy: { awn: CITY_PAINT.DARK, sign: CITY_PAINT.DARK }, tannery: { awn: CITY_PAINT.BROWN }, warehouse: { sign: CITY_PAINT.BROWN }, bath: { sign: CITY_PAINT.BLUE, awn: CITY_PAINT.BROWN }, hospital: { sign: CITY_PAINT.LINEN },
  dyer: { awn: true }, toll: { sign: CITY_PAINT.RED }, guildhall: { sign: CITY_PAINT.GOLD, awn: CITY_PAINT.BLUE },
});
const BOARD_CLOTHS = [CITY_PAINT.RED, CITY_PAINT.BLUE, CITY_PAINT.GOLD, CITY_PAINT.GREEN, CITY_PAINT.BROWN], BOARD_STALL_CLOTHS = [CITY_PAINT.RED, CITY_PAINT.BLUE, CITY_PAINT.GOLD, CITY_PAINT.GREEN, CITY_PAINT.LINEN];
// What each of the model's kinds of building is stood as, where it is neither house, church nor castle: its type;
// the roof, wall and rise of the plain block that stands in for it far off; whether its ridge lies along the street;
// and whether a trade's sign may hang on its front.
export const BOARD_WORKS = Object.freeze({
  windmill: ['WINDMILL', CITY_ROOF.PYRAMID, 12, 1.8, false, false], mill: ['WATERMILL', CITY_ROOF.GABLE, 12, 2.2, true, false], granary: ['GRANARY', CITY_ROOF.PYRAMID, 10, 2.3, false, false],
  shed: ['SHED', CITY_ROOF.GABLE, 10, 0.95, true, false], grange: ['BARN', CITY_ROOF.GABLE, 12, 3.1, true, true], warehouse: ['BARN', CITY_ROOF.GABLE, 12, 3.1, true, true],
  dovecote: ['DOVECOTE', CITY_ROOF.PYRAMID, 12, 1.6, false, false], toll: ['TOLL', CITY_ROOF.GABLE, 11, 1.6, true, true], cot: ['COT', CITY_ROOF.GABLE, 12, 2, true, false],
  winepress: ['WINEPRESS', CITY_ROOF.GABLE, 11, 2, true, false], tannery: ['VATS', CITY_ROOF.GABLE, 10, 1.1, true, false], dyer: ['VATS', CITY_ROOF.GABLE, 10, 1.1, true, false],
  chapter: ['STONE_HALL', CITY_ROOF.GABLE, 11, 3.2, true, true], refectory: ['STONE_HALL', CITY_ROOF.GABLE, 11, 3.2, true, true], bath: ['STONE_HALL', CITY_ROOF.GABLE, 11, 3.2, true, true],
  hospital: ['STONE_HALL', CITY_ROOF.GABLE, 11, 3.2, true, true], guildhall: ['STONE_HALL', CITY_ROOF.GABLE, 11, 3.2, true, true],
  cloister: ['CLOISTER', CITY_ROOF.FLAT, 11, 0, false, false], court: ['COURT', CITY_ROOF.GABLE, 19, 1.5, true, false], wharf: ['WHARF', CITY_ROOF.FLAT, 10, 0, false, false], quarry: ['QUARRY', CITY_ROOF.FLAT, 11, 0, false, false],
});
// The model roofs its poorest building (its tier 0) in thatch across villages, suburbs and poorer town quarters alike:
// by the model's kind of house or trade-house, what it is stood as at tier 0, in the terms of BOARD_WORKS.
export const BOARD_THATCHED = Object.freeze({
  house: ['THATCH_HOUSE', CITY_ROOF.GABLE, CITY_WALL.HOUSE, 3.6, true, false],
  longhouse: ['THATCH_LONGHOUSE', CITY_ROOF.GABLE, CITY_WALL.HOUSE, 3.3, true, false],
  shop: ['THATCH_HOUSE', CITY_ROOF.GABLE, CITY_WALL.HOUSE, 3.6, true, true],
  bakery: ['THATCH_HOUSE', CITY_ROOF.GABLE, CITY_WALL.HOUSE, 3.6, true, true],
  tavern: ['THATCH_HOUSE', CITY_ROOF.GABLE, CITY_WALL.HOUSE, 3.6, true, true],
});
// Where a road of the model crosses one of its rivers: the middle of the crossing, the way the road runs there, and
// the water's width along the road. The model keeps no list of these (its own page finds them as it draws its
// roads), so they are found here from its record of both. `roads` are {points: [x, z, …]}, `rivers` {points: [x, z,
// half-width, …]}; a second road at a crossing uses the bridge already there.
export const BOARD_ROAD_BRIDGE = Object.freeze({ width: 6, arch: 11, rise: 0.65 });
export function boardRoadCrossings(roads, rivers, places = null) {
  const out = [];
  const candidates = [];
  for (const road of roads ?? []) {
    if (road?.points?.length >= 4) candidates.push({ points: road.points, stone: true, rank: 0 });
  }
  for (const place of places ?? []) {
    for (const st of place?.streets ?? []) {
      if (!st?.points || st.points.length < 4) continue;
      if (st.kind !== 'road' && st.kind !== 'street' && st.kind !== 'lane') continue;
      candidates.push({ points: st.points, stone: st.kind !== 'lane', rank: st.kind === 'road' ? 1 : st.kind === 'street' ? 2 : 3 });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  for (const river of rivers ?? []) {
    const R = river.points;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let j = 0; j + 2 < R.length; j += 3) { const pad = R[j + 2] + 1; x0 = Math.min(x0, R[j] - pad); x1 = Math.max(x1, R[j] + pad); z0 = Math.min(z0, R[j + 1] - pad); z1 = Math.max(z1, R[j + 1] + pad); }
    for (const road of candidates) {
      const P = road.points;
      for (let i = 0; i + 3 < P.length; i += 2) {
        const ax = P[i], az = P[i + 1], bx = P[i + 2], bz = P[i + 3];
        if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(az, bz) < z0 || Math.min(az, bz) > z1) continue;
        for (let j = 0; j + 5 < R.length; j += 3) {
          const cx = R[j], cz = R[j + 1], dx = R[j + 3], dz = R[j + 4], den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
          if (Math.abs(den) < 1e-9) continue;
          const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
          if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
          const L = Math.hypot(bx - ax, bz - az), x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 14)) continue;
          // Across a river met askew the water is wider along the road; a road is brought to no shallower a crossing than this.
          const sine = Math.abs(den) / (L * Math.hypot(dx - cx, dz - cz)), half = R[j + 2] + (R[j + 5] - R[j + 2]) * u;
          out.push({ x, z, ux: (bx - ax) / L, uz: (bz - az) / L, span: 2 * half / Math.max(0.35, sine), stone: road.stone });
        }
      }
    }
  }
  return out;
}
// The model's kind of a stretch of wall where a cliff is itself the wall.
const BOARD_WALL_CLIFF = 1;
// A type is fitted to the plot the model gave its building, never beyond recognition.
const BOARD_FIT = [0.8, 1.35];
// A wharf's deck stands this far above the sea at the least.
const BOARD_WHARF_M = 1.2;
// How high on a front its pentice is fixed, and the bracket its sign hangs from; a low house carries them lower.
const BOARD_PENTICE_M = 2.75, BOARD_SIGN_M = 3.7, BOARD_STAKE_M = 3.4;
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
export function layBoardCountry({ baked, region, grid, heights = null, heightAt, port, wet, LAND, fieldAt, distanceTo }) {
  const started = typeof performance === 'object' ? performance.now() : 0;
  const board = baked.board, ox = region.x, oz = region.z, half = region.span / 2;
  const bounds = { x0: ox - half, z0: oz - half, x1: ox + half, z1: oz + half };
  const inside = (x, z, pad) => x > bounds.x0 + pad && x < bounds.x1 - pad && z > bounds.z0 + pad && z < bounds.z1 - pad;
  const rr = mulberry((Math.round(port.center.x * 7.3) * 73856093) ^ (Math.round(port.center.z * 5.1) * 19349663) ^ (board.seed | 0) ^ 0x2b0a4d17);
  const blocks = [], typed = [], typedTypes = [], typedBlocks = [], gates = [], lots = [], churches = [];
  // How many of the types stood just after a building are fixed to it (its pentice, sign, ale-stake): they are
  // no targets of their own, and go when it is shot down.
  const attached = new Map();
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

  /* ---- streets and squares: every settlement stamps its own ways; trimmed roads and lanes feed the paving field too ---- */
  const streets = [], squares = [], paving = [];
  const placeSegs = places.map(() => []);
  const placeStreetR = new Float32Array(places.length);
  places.forEach((place, at) => {
    let maxR = 0;
    for (const street of place.streets) {
      const pts = [];
      for (let k = 0; k < street.points.length; k += 2) {
        const sx = ox + street.points[k], sz = oz + street.points[k + 1];
        pts.push([sx, sz]);
        maxR = Math.max(maxR, Math.hypot(sx - place.x, sz - place.z) + Math.max(1.2, street.half));
      }
      const lane = street.kind === 'lane' || street.kind === 'alley', st = { pts, hw: Math.max(1.2, street.half), kind: street.kind, place: at, paved: lane ? 0.5 : 1 };
      streets.push(st);
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        const seg = { ax, az, bx, bz, hw: st.hw, place: at };
        segs.add(seg, Math.min(ax, bx) - st.hw, Math.min(az, bz) - st.hw, Math.max(ax, bx) + st.hw, Math.max(az, bz) + st.hw);
        placeSegs[at].push(seg);
      }
      if (pts.length > 1) paving.push({ points: pts.filter(([x, z]) => inside(x, z, 4)).map(([x, z]) => [x, z, st.hw * 2, st.paved]) });
    }
    placeStreetR[at] = maxR > 0 ? Math.max(18, maxR) : 0;
    for (const sq of place.squares) {
      const rad = sq.rad, mean = rad.reduce((a, b) => a + b, 0) / rad.length, R = Math.max(...rad);
      const square = { x: ox + sq.x, z: oz + sq.z, rad, R, mean, kind: sq.kind === 'green' ? 'park' : 'square', place: at };
      squares.push(square);
      if (square.kind === 'square' && inside(square.x, square.z, 4)) paving.push({ points: [[square.x - 0.5, square.z, mean * 2, 1], [square.x + 0.5, square.z, mean * 2, 1]] });
    }
  });
  const snapToPlaceStreet = (at, px, pz, maxDist = 32) => {
    let bestD = maxDist, bestPt = null;
    for (const g of placeSegs[at]) {
      const dx = g.bx - g.ax, dz = g.bz - g.az, l2 = dx * dx + dz * dz;
      const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - g.ax) * dx + (pz - g.az) * dz) / l2)) : 0;
      const cx = g.ax + dx * t, cz = g.az + dz * t, d = Math.hypot(px - cx, pz - cz);
      if (d < bestD) { bestD = d; bestPt = [cx, cz]; }
    }
    return bestPt;
  };
  const insidePlaceCore = (px, pz) => {
    for (let at = 0; at < places.length; at++) {
      const sr = placeStreetR[at];
      if (sr <= 0 || Math.hypot(px - places[at].x, pz - places[at].z) >= sr - 4) continue;
      if (placeSegs[at].some((g) => segDist(px, pz, g.ax, g.az, g.bx, g.bz) < g.hw + 22)) return at;
    }
    return -1;
  };
  const trimRoadThroughPlaces = (rawLine) => {
    const dense = [];
    for (let i = 0; i < rawLine.length; i++) {
      const p = rawLine[i];
      if (i > 0) {
        const q = rawLine[i - 1], segL = Math.hypot(p[0] - q[0], p[1] - q[1]);
        let nearPlace = false;
        if (segL > 12) {
          const mx = (p[0] + q[0]) * 0.5, mz = (p[1] + q[1]) * 0.5, halfL = segL * 0.5 + 32;
          for (let at = 0; at < places.length; at++) {
            if (placeStreetR[at] > 0 && Math.hypot(mx - places[at].x, mz - places[at].z) < placeStreetR[at] + halfL) { nearPlace = true; break; }
          }
        }
        if (nearPlace) {
          const steps = Math.ceil(segL / 10);
          for (let s = 1; s < steps; s++) dense.push([q[0] + (p[0] - q[0]) * s / steps, q[1] + (p[1] - q[1]) * s / steps]);
        }
      }
      dense.push(p);
    }
    const out = [];
    let cur = [], prevCore = -1;
    for (let i = 0; i < dense.length; i++) {
      const p = dense[i], core = insidePlaceCore(p[0], p[1]);
      if (core >= 0) {
        if (cur.length > 0) {
          const junction = snapToPlaceStreet(core, cur[cur.length - 1][0], cur[cur.length - 1][1]);
          if (junction) cur.push(junction);
          if (cur.length >= 2) out.push(cur);
          cur = [];
        }
        prevCore = core;
      } else {
        if (cur.length === 0 && prevCore >= 0) {
          const junction = snapToPlaceStreet(prevCore, p[0], p[1]);
          if (junction) cur.push(junction);
        }
        cur.push(p);
        prevCore = -1;
      }
    }
    if (cur.length >= 2) out.push(cur);
    return out;
  };
  const roads = [];
  for (const road of board.roads ?? []) {
    const rawLine = [];
    for (let k = 0; k < road.points.length; k += 2) rawLine.push([ox + road.points[k], oz + road.points[k + 1]]);
    if (rawLine.length < 2) continue;
    const pieces = trimRoadThroughPlaces(rawLine);
    const keepList = pieces.length ? pieces : [rawLine];
    for (const line of keepList) {
      let arc = 0;
      for (let i = 1; i < line.length; i++) arc += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      if (arc < 4) continue;
      roads.push(line);
      for (let i = 1; i < line.length; i++) {
        const [ax, az] = line[i - 1], [bx, bz] = line[i], hw = 2.6;
        segs.add({ ax, az, bx, bz, hw, road: true }, Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw);
      }
      const bounded = line.filter(([x, z]) => inside(x, z, 4));
      if (bounded.length > 1) paving.push({ points: bounded.map(([x, z]) => [x, z, 5.2, 0.48]) });
    }
  }
  const rawLanes = board.lanes ?? [];
  for (let k = 0; k + 3 < rawLanes.length; k += 4) {
    const ax = ox + rawLanes[k], az = oz + rawLanes[k + 1], bx = ox + rawLanes[k + 2], bz = oz + rawLanes[k + 3], hw = 1.5;
    segs.add({ ax, az, bx, bz, hw, lane: true }, Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw);
    if (inside(ax, az, 4) || inside(bx, bz, 4)) paving.push({ points: [[ax, az, 3.0, 0.35], [bx, bz, 3.0, 0.35]] });
  }
  for (let k = paving.length - 1; k >= 0; k--) if (paving[k].points.length < 2) paving.splice(k, 1);
  const squareRadius = (p, x, z) => {
    const n = p.rad.length, a = Math.atan2(z - p.z, x - p.x) / (2 * Math.PI) * n, i = Math.floor(a), f = a - i;
    return p.rad[((i % n) + n) % n] * (1 - f) + p.rad[(((i + 1) % n) + n) % n] * f;
  };
  const inSquare = (x, z, pad) => { for (const p of squares) { const d = Math.hypot(x - p.x, z - p.z); if (d < p.R + pad && d < squareRadius(p, x, z) + pad) return p; } return null; };
  const streetEdge = (x, z, reach) => { let bd = reach; segs.some(x, z, reach + 6, (g) => { const d = segDist(x, z, g.ax, g.az, g.bx, g.bz) - g.hw; if (d < bd) bd = d; }); return bd; };

  /* ---- walls: a ring of radii about a centre, one to each bearing, with gates where the model has them ---- */
  // The model says of each stretch how its line was chosen, not what it is built of: 0 a wall on open ground, 1 a
  // cliff that is itself the wall (nothing is built there), 2 a wall along a bank, 3 one on the crest of a slope.
  // What it is built of is the circuit's own: stone, or a palisade. `built` is given while a circuit is still
  // going up: which stretches stand so far.
  const ring = (cx, cz, rad, kind, gateAngles, stoneHeight, towerEvery = 56, stone = true, built = null) => {
    const n = rad.length, pts = [], first = gates.length;
    for (let k = 0; k < n; k++) {
      const a = k / n * 2 * Math.PI, x = cx + Math.cos(a) * rad[k], z = cz + Math.sin(a) * rad[k];
      const dry = inside(x, z, 20) && heightAt(x, z) > 1.4;
      pts.push({ x, z, stone, open: (kind && kind[k] === BOARD_WALL_CLIFF) || (built && !built[k]) || !dry || taken(footprint(x, z, 6, 6, 0), 2) });
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
    if (place.wall) ring(place.x, place.z, place.wall.rad, place.wall.kind, place.wall.gates, CITY_CURTAIN.height, 56, place.walls >= 2 || place.wall.bastions, place.wall.built ?? null);
    const hill = place.castle?.hill, citadel = place.castle?.citadel;
    if (hill?.rad?.length) ring(ox + hill.x, oz + hill.z, hill.rad, hill.kind, [hill.gate], Math.max(7.5, hill.height || 0) + 2, 40, hill.walls >= 2 && !hill.timber);
    if (citadel?.rad?.length) ring(ox + citadel.x, oz + citadel.z, citadel.rad, null, [citadel.gate], 9.5, 48);
  }

  /* ---- buildings: each one the model stood, as this game's type of that size, turned to its street ---- */
  const { count, stand, form, kinds } = board.buildings, arches = board.arches;
  const market = board.quarters?.indexOf('market') ?? -1, quarter = board.buildings.quarter ?? null;
  let houses = 0, fronts = 0, stalls = 0;
  const works = board.works ?? {}, stateOf = board.buildings.state ?? null, wheelOf = new Map();
  for (let w = 0; w + 2 < (works.wheels?.length ?? 0); w += 3) wheelOf.set(works.wheels[w], [ox + works.wheels[w + 1], oz + works.wheels[w + 2]]);
  const built = { thatched: 0, roadBridges: 0, dams: 0, windmills: 0, watermills: 0, wheels: 0, stores: 0, sheds: 0, halls: 0, others: 0, ruins: 0, fences: 0, bridges: 0, yards: 0, graves: 0, cairns: 0, tents: 0, standards: 0, scaffolds: 0 };
  // The wash of a house, its own from where it stands in the model's list.
  const washOf = (k) => { const hue = form[k * 3 + 2]; return BOARD_HOUSE_TINTS[Math.floor(boardHashUnit(k, 23) * BOARD_HOUSE_TINTS.length)] + 0.2 + 0.75 * (hue > 0 && hue < 1 ? hue : boardHashUnit(k, 31)); };
  const fit = (v, of) => Math.max(BOARD_FIT[0] * of, Math.min(BOARD_FIT[1] * of, v));
  // A thing of the street: a type stood as it is written, unstretched unless told, with no block of its own.
  const furnish = (type, x, y, z, yaw, paint, tone, across = CITY_BUILDING_TYPES[type].width) => {
    const T = CITY_BUILDING_TYPES[type];
    pushTyped(type, x, y, z, yaw, across, T.height, T.length, paint + 0.3 + 0.65 * tone, 0);
  };
  // The street front of a house of trade: fixed to its front wall, hung out over the street.
  const standFront = (k, f, floor, wallH) => {
    const arch = arches[kinds[k * 6 + 1]], look = BOARD_STREETFRONT[arch === 'burgher' && quarter && quarter[k] === market ? 'shop' : arch];
    if (!look) return;
    const hue = form[k * 3 + 2], hu = hue > 0 && hue < 1 ? hue : boardHashUnit(k, 31), side = hu > 0.5 ? 1 : -1;
    // Under the eaves of a house of one floor; never so near the ground that a head meets them.
    const penticeY = Math.min(BOARD_PENTICE_M, Math.max(2.25, wallH - 0.7)), signY = Math.min(BOARD_SIGN_M, Math.max(2.7, wallH - 0.3)), stakeY = Math.min(BOARD_STAKE_M, Math.max(2.9, wallH - 0.3));
    if (look.awn) { const [x, z] = local(f, 0, -f.d / 2); furnish(CITY_TYPE.PENTICE, x, floor + penticeY, z, f.yaw, look.awn === true ? BOARD_CLOTHS[Math.floor(hu * 5)] : look.awn, boardHashUnit(k, 67), f.w * 0.82); }
    if (look.sign) { const [x, z] = local(f, f.w * 0.36 * side, -f.d / 2); furnish(CITY_TYPE.SIGN, x, floor + signY, z, f.yaw, look.sign, boardHashUnit(k, 71)); }
    if (look.bush) { const [x, z] = local(f, -f.w * 0.36 * side, -f.d / 2); furnish(CITY_TYPE.ALE_STAKE, x, floor + stakeY, z, f.yaw, CITY_PAINT.GREEN, boardHashUnit(k, 73)); }
    fronts++;
  };
  const standHouse = (k, f, storeys, toStreet, mannered = true) => {
    const wallH = storeys * CITY_STOREY_M + boardHashUnit(k, 11) * 0.5;
    const base = seatBlock(f, toStreet ? heightAt(f.x - Math.sin(f.yaw) * (f.d / 2 + 1.5), f.z - Math.cos(f.yaw) * (f.d / 2 + 1.5)) : null);
    if (base.range > 7.5) { dropped.steep++; return; }
    const tone = washOf(k);
    // A broad front keeps its eaves to the street; a narrow, deep plot more often turns its gable to it.
    const eaves = boardHashUnit(k, 47) < (f.w >= f.d * 0.8 ? 0.85 : 0.5), type = cityHouseType(storeys, eaves, mannered ? boardHashUnit(k, 53) : 0), T = CITY_BUILDING_TYPES[type], up = wallH / T.height;
    if (eaves) pushBlock(footprint(f.x, f.z, f.d, f.w, f.yaw + Math.PI / 2), wallH, 0.36 * T.length / 2 * up, CITY_ROOF.GABLE + CITY_TYPED_ROOF, CITY_WALL.HOUSE, tone, base);
    else pushBlock(f, wallH, 0.5 * T.width / 2 * up, CITY_ROOF.GABLE + CITY_TYPED_ROOF, CITY_WALL.HOUSE, tone, base);
    pushTyped(type, f.x, base.floor, f.z, f.yaw, f.w, wallH, f.d, tone);
    occupy(f); houses++;
    const house = typedTypes.length - 1;
    if (toStreet) standFront(k, f, base.floor, wallH);
    if (typedTypes.length - 1 > house) attached.set(house, typedTypes.length - 1 - house);
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
  // One of the model's works that is no house: its own type, fitted to the plot the model gave it.
  const standWork = (k, f, arch, toStreet, as = BOARD_WORKS[arch]) => {
    const [key, roof, wall, rise, ridgeAlong, fronted] = as, type = CITY_TYPE[key], T = CITY_BUILDING_TYPES[type];
    const thatch = key === 'COT' || as === BOARD_THATCHED[arch] ? CITY_THATCH_ROOF : 0;
    const g = footprint(f.x, f.z, fit(f.w, T.width), fit(f.d, T.length), f.yaw), up = T.height * (0.95 + 0.1 * boardHashUnit(k, 11));
    const base = key === 'WHARF' ? { floor: Math.max(BOARD_WHARF_M, heightAt(g.x, g.z)), plinth: 0.3, range: 0 }
      : seatBlock(g, toStreet ? heightAt(g.x - Math.sin(g.yaw) * (g.d / 2 + 1.5), g.z - Math.cos(g.yaw) * (g.d / 2 + 1.5)) : null);
    if (base.range > 9) { dropped.steep++; return; }
    const hu = boardHashUnit(k, 31), paint = arch === 'tannery' ? CITY_PAINT.BROWN : arch === 'dyer' ? BOARD_CLOTHS[Math.floor(hu * 5)] : arch === 'toll' ? CITY_PAINT.RED : -1;
    const tone = paint >= 0 ? paint + 0.3 + 0.65 * hu : key === 'WINDMILL' || key === 'DOVECOTE' || key === 'WHARF' ? 0.2 + 0.75 * hu : washOf(k);
    // Far off, a plain block of its size: the quarry's is its face, a wharf's its deck.
    const Far = key === 'QUARRY' ? footprint(...local(g, 0, g.d * 0.3), g.w, g.d * 0.4, g.yaw) : ridgeAlong ? footprint(g.x, g.z, g.d, g.w, g.yaw + Math.PI / 2) : g;
    pushBlock(Far, key === 'WHARF' ? 0.05 : key === 'QUARRY' ? 1.3 : up, rise * (ridgeAlong ? g.d / T.length : g.w / T.width), roof + CITY_TYPED_ROOF + thatch, wall, wall === 19 || paint < 0 && wall === 12 ? tone : 0.86 + 0.1 * hu, base);
    pushTyped(type, g.x, base.floor, g.z, g.yaw, g.w, up, g.d, tone);
    if (thatch) g.thatch = true;
    keep(g); occupy(g);
    const stood = typedTypes.length - 1;
    if (fronted && toStreet) standFront(k, g, base.floor, up);
    if (typedTypes.length - 1 > stood) attached.set(stood, typedTypes.length - 1 - stood);
    if (key === 'WINDMILL') built.windmills++; else if (key === 'WATERMILL') built.watermills++; else if (key === 'GRANARY' || key === 'BARN') built.stores++; else if (key === 'SHED') built.sheds++; else if (key === 'STONE_HALL') built.halls++; else if (thatch && key !== 'COT') { built.thatched++; houses++; } else built.others++;
  };
  // What is left of a building the model has burnt to its walls (a ruin) or thrown down (a heap).
  const standLeft = (k, f, heap) => {
    const type = heap ? CITY_TYPE.RUBBLE : CITY_TYPE.RUIN, T = CITY_BUILDING_TYPES[type], base = seatBlock(f);
    if (base.range > 9) { dropped.steep++; return; }
    const tone = washOf(k), up = heap ? T.height : Math.max(3, Math.min(7, stand[k * 6 + 5]));
    pushBlock(f, heap ? 0.6 : up * 0.6, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, heap ? 11 : 12, heap ? 0.8 : tone, base);
    pushTyped(type, f.x, base.floor, f.z, f.yaw, f.w, up, f.d, tone);
    occupy(f); built.ruins++;
  };
  const wayClearance = (fp) => {
    let minC = Infinity, pushX = 0, pushZ = 0, roadHit = false;
    const Reach = Math.hypot(fp.w, fp.d) * 0.5 + 8;
    segs.some(fp.x, fp.z, Reach, (g) => {
      const c = segRectDist(fp, g.ax, g.az, g.bx, g.bz) - g.hw;
      if (c < minC) {
        minC = c;
        roadHit = Boolean(g.road);
        const dx = g.bx - g.ax, dz = g.bz - g.az, l2 = dx * dx + dz * dz;
        const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((fp.x - g.ax) * dx + (fp.z - g.az) * dz) / l2)) : 0;
        const px = g.ax + dx * t, pz = g.az + dz * t, ox0 = fp.x - px, oz0 = fp.z - pz, L = Math.hypot(ox0, oz0);
        if (L > 1e-4) { pushX = ox0 / L; pushZ = oz0 / L; }
        else if (l2 > 1e-4) { const inv = 1 / Math.sqrt(l2); pushX = -dz * inv; pushZ = dx * inv; }
      }
      return false;
    });
    return { clearance: minC, pushX, pushZ, roadHit };
  };
  for (let k = 0; k < count; k++) {
    const place = kinds[k * 6], arch = arches[kinds[k * 6 + 1]], church = kinds[k * 6 + 4];
    const x = ox + stand[k * 6], z = oz + stand[k * 6 + 1], rot = stand[k * 6 + 2], w = stand[k * 6 + 3], d = stand[k * 6 + 4], h = stand[k * 6 + 5];
    if (!inside(x, z, 12)) { dropped.edge++; continue; }
    if (heightAt(x, z) < BOARD_DRY_M && arch !== 'wharf') { dropped.wet++; continue; }
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
    // A watermill is turned to its water: the wheel's side of its type toward where the model's wheel turns.
    const wheel = arch === 'mill' ? wheelOf.get(k) : null;
    if (wheel) {
      let best = 0, most = -Infinity;
      for (let q = 0; q < 4; q++) { const a = rot + q * Math.PI / 2, toward = (wheel[0] - x) * Math.cos(a) - (wheel[1] - z) * Math.sin(a); if (toward > most) { most = toward; best = q; } }
      yaw = rot + best * Math.PI / 2; front = best & 1 ? d : w; depth = best & 1 ? w : d;
      // As broad as brings the wheel to that water.
      front = Math.max(front, 2 * (most - WORKS_WHEEL.out));
      built.wheels++;
    }
    let bx = x, bz = z;
    let f = footprint(bx, bz, front, depth, yaw);
    if (arch !== 'mill' && arch !== 'wharf' && arch !== 'wall' && arch !== 'tower' && arch !== 'keep' && arch !== 'bridge') {
      let wc = wayClearance(f);
      if (wc.clearance < -0.35) {
        for (const step of [0.8, 1.6, 2.4, 3.2]) {
          const cx = x + wc.pushX * step, cz = z + wc.pushZ * step;
          if (!inside(cx, cz, 12) || heightAt(cx, cz) < BOARD_DRY_M) continue;
          const cand = footprint(cx, cz, front, depth, yaw);
          if (taken(cand, 0.8)) continue;
          const nextWc = wayClearance(cand);
          if (nextWc.clearance > wc.clearance + 0.25) {
            bx = cx; bz = cz; f = cand; wc = nextWc;
            if (wc.clearance >= -0.35) break;
          }
        }
        if (wc.clearance < -0.95 || (wc.roadHit && wc.clearance < -0.45)) { dropped.port++; continue; }
      }
    }
    if (taken(f, 0.8)) { dropped.port++; continue; }
    const left = stateOf ? stateOf[k] : 0;
    if (left) standLeft(k, f, left === 3);
    else if (arch === 'tower') {
      tower(bx, bz, 6.2, Math.max(10, Math.min(15, h)), 0.9);
      occupy(footprint(bx, bz, 7, 7, yaw));
    } else if (arch === 'wall') {
      // A length of wall the model stood by itself: its parapet toward the street it faces, or outward from the place.
      const long = Math.max(w, d) / 2, a = rot + (w >= d ? 0 : Math.PI / 2), ux = Math.cos(a), uz = -Math.sin(a), p = places[place] ?? seat;
      curtain(bx - ux * long, bz - uz * long, bx + ux * long, bz + uz * long, fx || fz ? [fx, fz] : [bx - p.x, bz - p.z], CITY_CURTAIN.height, 0.86);
    } else if (BOARD_WORKS[arch]) standWork(k, f, arch, Boolean(fx || fz));
    else if (arch === 'temple') {
      // A church's length runs back from its door.
      const long = front > depth ? footprint(bx, bz, depth, front, yaw + Math.PI / 2) : f;
      standChurch(k, long, (church & 3) === 3, h);
    } else if (arch === 'keep') {
      tower(bx, bz, Math.max(9, Math.min(14, Math.max(w, d))), Math.max(18, h), 0.95, CITY_TYPE.KEEP);
      occupy(footprint(bx, bz, Math.max(w, d), Math.max(w, d), yaw));
    } else if (arch === 'hall') {
      const long = front > depth ? footprint(bx, bz, depth, front, yaw + Math.PI / 2) : f;
      const floor = pushBlock(long, CITY_HALL.height, CITY_HALL.roof, CITY_ROOF.HIP + CITY_TYPED_ROOF, CITY_WALL.HOUSE, 0.9);
      pushTyped(CITY_TYPE.HALL, long.x, floor, long.z, long.yaw, long.w, CITY_HALL.height, long.d, 0.9);
      keep(long); occupy(long);
    } else if (kinds[k * 6 + 2] === 0 && BOARD_THATCHED[arch]) {
      standWork(k, f, arch, Boolean(fx || fz), BOARD_THATCHED[arch]);
    } else {
      // The model builds low: a house of one or two floors, and so stood most of an Iberian port of the sixteenth
      // century. Toward the seat's middle they gain a floor; four were the merchants' houses of its middle streets,
      // and five the tallest of those (the Rua Nova's "three, four and even five").
      let storeys = Math.max(1, Math.min(2, Math.round(h / CITY_STOREY_M)));
      const plain = arch === 'shed' || arch === 'longhouse';
      if (plain) storeys = 1;
      else if (place === 0 && seat.reach > 0) {
        const near = 1 - Math.hypot(bx - seat.x, bz - seat.z) / seat.reach, lot = boardHashUnit(k, 59), merchant = arch === 'burgher' || arch === 'shop';
        if (near > 0.72) storeys = merchant ? (lot < 0.1 ? 5 : lot < 0.4 ? 4 : 3) : lot < 0.55 ? 3 : 2;
        else if (near > 0.4) storeys = Math.min(3, storeys + (lot < (merchant ? 0.5 : 0.25) ? 1 : 0));
      }
      standHouse(k, f, Math.min(CITY_HOUSE_STOREYS, storeys), fx || fz, !plain);
    }
  }

  /* ---- the open places: a well on a green; on a market place its cross, and stalls round it ---- */
  const open = (x, z, reach) => inside(x, z, 8) && heightAt(x, z) > BOARD_DRY_M && !taken(footprint(x, z, reach, reach, 0), 0.5) && !placed.some(x, z, reach, (o) => rectDist(o, x, z) <= reach * 0.5);
  squares.forEach((p, at) => {
    if (p.kind === 'park') { if (open(p.x, p.z, 4.2)) furnish(CITY_TYPE.WELL, p.x, heightAt(p.x, p.z), p.z, boardHashUnit(at, 79) * Math.PI, 0, 0.5); return; }
    if (open(p.x, p.z, 3.2)) furnish(CITY_TYPE.MARKET_CROSS, p.x, heightAt(p.x, p.z), p.z, 0, 0, 0.5);
    const place = places[p.place], n = place.kind === 'capital' ? 12 : 7;
    for (let k = 0; k < n; k++) {
      const a = k / n * 2 * Math.PI + 0.3, far = squareRadius(p, p.x + Math.cos(a), p.z + Math.sin(a)) * 0.62, x = p.x + Math.cos(a) * far, z = p.z + Math.sin(a) * far;
      if (!open(x, z, 3.6)) continue;
      furnish(CITY_TYPE.STALL, x, heightAt(x, z), z, -a, BOARD_STALL_CLOTHS[(k * 3 + place.name.length) % BOARD_STALL_CLOTHS.length], boardHashUnit(at * 31 + k, 83));
      stalls++;
    }
  });

  /* ---- the slighter works of the model: fences, the bridges of its tracks, churchyards, cairns, camps, hosts, works in hand ---- */
  const slight = (type, x, y, z, yaw, tone = 0.5, along = CITY_BUILDING_TYPES[type].length) => { const T = CITY_BUILDING_TYPES[type]; pushTyped(type, x, y, z, yaw, T.width, T.height, along, tone, 0); };
  const dry = (x, z, pad = 6) => inside(x, z, pad) && heightAt(x, z) > BOARD_DRY_M;
  // A run of fence from one point to another, a length at a time, each on its own ground; none where a building
  // stands or a street runs through.
  const spans = works.trackBridges ?? [];
  // On a bridge and at its two ends the way is open: no fence is run across it.
  const bridged = (x, z) => { for (let k = 0; k + 5 < spans.length; k += 6) { const dx = x - ox - spans[k], dz = z - oz - spans[k + 1], ux = spans[k + 2], uz = spans[k + 3]; if (Math.abs(dx * ux + dz * uz) < spans[k + 4] / 2 + 3 && Math.abs(dx * uz - dz * ux) < 4) return true; } return false; };
  const fence = (ax, az, bx, bz, stone) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1.5) return;
    const n = Math.max(1, Math.round(L / WORKS_FENCE_M)), yaw = Math.atan2(bx - ax, bz - az), type = stone ? CITY_TYPE.FENCE_STONE : CITY_TYPE.FENCE_RAIL;
    for (let i = 0; i < n; i++) {
      const x = ax + (bx - ax) * (i + 0.5) / n, z = az + (bz - az) * (i + 0.5) / n;
      if (!dry(x, z) || bridged(x, z) || streetEdge(x, z, 3) < 0.6 || placed.some(x, z, 4, (o) => rectDist(o, x, z) <= 1.2) || solids.some(x, z, 4, (o) => rectDist(o, x, z) <= 1.2)) continue;
      slight(type, x, heightAt(x, z), z, yaw, 0.5, L / n);
      built.fences++;
    }
  };
  const fences = works.fences ?? [];
  for (let k = 0; k + 4 < fences.length; k += 5) fence(ox + fences[k], oz + fences[k + 1], ox + fences[k + 2], oz + fences[k + 3], fences[k + 4] & 1);
  // A track's bridge and road/street crossings: seated above channel flood levels with masonry or timber piers.
  const bridges = [];
  for (let k = 0; k + 5 < spans.length; k += 6) {
    const x = ox + spans[k], z = oz + spans[k + 1], ux = spans[k + 2], uz = spans[k + 3], span = Math.max(6, spans[k + 4]), half = span / 2;
    if (!inside(x, z, 12)) continue;
    const hA = heightAt(x - ux * (half + 2.5), z - uz * (half + 2.5));
    const hB = heightAt(x + ux * (half + 2.5), z + uz * (half + 2.5));
    if (Math.max(hA, hB) <= 0.12) continue;
    const deck = Math.max(hA, hB, BOARD_DRY_M) + 0.55;
    const isStone = Boolean(spans[k + 5]);
    const totalLen = span + 3.0;
    slight(isStone ? CITY_TYPE.STONE_BRIDGE : CITY_TYPE.FOOTBRIDGE, x, deck, z, Math.atan2(ux, uz), 0.5, totalLen);
    const width = CITY_BUILDING_TYPES[isStone ? CITY_TYPE.STONE_BRIDGE : CITY_TYPE.FOOTBRIDGE].width;
    bridges.push({ x, z, ux, uz, length: totalLen, halfWidth: width * 0.5, deckY: deck, span, isStone });
    built.bridges++;
  }
  // A road's or arterial street's bridge where it crosses a river: stone, the road's width, bank to bank in arches.
  for (const q of boardRoadCrossings(board.roads, board.rivers, board.places)) {
    const x = ox + q.x, z = oz + q.z, reach = Math.max(4.5, q.span / 2 + 2.4), T = CITY_BUILDING_TYPES[q.stone === false ? CITY_TYPE.FOOTBRIDGE : CITY_TYPE.STONE_BRIDGE];
    if (!inside(x, z, 12)) continue;
    if (bridges.some((b) => Math.hypot(b.x - x, b.z - z) < 14)) continue;
    const hA = heightAt(x - q.ux * (reach + 1.5), z - q.uz * (reach + 1.5));
    const hB = heightAt(x + q.ux * (reach + 1.5), z + q.uz * (reach + 1.5));
    if (Math.max(hA, hB) <= 0.12) continue;
    const deck = Math.max(hA, hB, BOARD_DRY_M) + BOARD_ROAD_BRIDGE.rise;
    const isStone = q.stone !== false;
    const bridgeType = isStone ? CITY_TYPE.STONE_BRIDGE : CITY_TYPE.FOOTBRIDGE;
    const bridgeWidth = isStone ? BOARD_ROAD_BRIDGE.width : T.width;
    const arches = isStone ? Math.max(1, Math.ceil(reach * 2 / BOARD_ROAD_BRIDGE.arch)) : 1, each = reach * 2 / arches;
    for (let a = 0; a < arches; a++) {
      const along = (a + 0.5) * each - reach;
      pushTyped(bridgeType, x + q.ux * along, deck, z + q.uz * along, Math.atan2(q.ux, q.uz), bridgeWidth, T.height, each, 0.5, 0);
      built.bridges++;
    }
    bridges.push({ x, z, ux: q.ux, uz: q.uz, length: reach * 2, halfWidth: bridgeWidth * 0.5, deckY: deck, span: q.span, isStone });
    built.roadBridges++;
  }
  // A churchyard: a dry-stone wall about it, and its graves as they are dug.
  for (const yard of works.yards ?? []) {
    const p = yard.points, m = p.length / 2;
    let cx = 0, cz = 0;
    for (let k = 0; k < m; k++) { cx += ox + p[k * 2]; cz += oz + p[k * 2 + 1]; fence(ox + p[k * 2], oz + p[k * 2 + 1], ox + p[((k + 1) % m) * 2], oz + p[((k + 1) % m) * 2 + 1], 1); }
    cx /= m; cz /= m;
    built.yards++;
    for (let g = 0, plots = Math.min(5, Math.ceil(yard.graves / 6)); g < plots; g++) {
      const a = g / plots * 2 * Math.PI + boardHashUnit(yard.church, 97) * 6, far = plots > 1 ? 3.6 : 0, x = cx + Math.cos(a) * far, z = cz + Math.sin(a) * far;
      if (dry(x, z)) { slight(CITY_TYPE.GRAVES, x, heightAt(x, z), z, boardHashUnit(yard.church, 101 + g) * Math.PI); built.graves++; }
    }
  }
  const cairns = works.memorials ?? [];
  for (let k = 0; k + 1 < cairns.length; k += 2) { const x = ox + cairns[k], z = oz + cairns[k + 1]; if (dry(x, z)) { slight(CITY_TYPE.CAIRN, x, heightAt(x, z), z, boardHashUnit(k, 103) * Math.PI); built.cairns++; } }
  // Tents in rings about a middle: a robbers' camp in the woods, a host in the field under its standard.
  const camp = (x, z, tents, paint, seed) => {
    for (let t = 0, ring = 0, at = 0; t < tents; t++, at++) {
      const around = 5 + ring * 5; if (at >= around) { ring++; at = 0; }
      const a = at / around * 2 * Math.PI + ring * 0.5, far = 6 + ring * 5.5, tx = x + Math.cos(a) * far, tz = z + Math.sin(a) * far;
      if (!dry(tx, tz) || placed.some(tx, tz, 5, (o) => rectDist(o, tx, tz) <= 2)) continue;
      slight(CITY_TYPE.TENT, tx, heightAt(tx, tz), tz, Math.atan2(tx - x, tz - z), paint + 0.3 + 0.65 * boardHashUnit(seed, t)); built.tents++;
    }
  };
  const camps = works.camps ?? [];
  for (let k = 0; k + 2 < camps.length; k += 3) camp(ox + camps[k], oz + camps[k + 1], Math.max(3, Math.min(9, Math.round(camps[k + 2] / 4))), CITY_PAINT.BROWN, 107 + k);
  (works.armies ?? []).forEach((host, at) => {
    const x = ox + host.x, z = oz + host.z;
    if (!dry(x, z)) return;
    slight(CITY_TYPE.STANDARD, x, heightAt(x, z), z, boardHashUnit(at, 109) * Math.PI, BOARD_CLOTHS[(host.house | 0) % BOARD_CLOTHS.length] + 0.6); built.standards++;
    camp(x, z, Math.max(4, Math.min(24, Math.round(host.men / 25))), CITY_PAINT.LINEN, 113 + at);
  });
  // A work in hand. On a building that stands (its fabric being mended, raised or rebuilt): a scaffold against its
  // back, a side or its front, whichever is clear, its frame to the wall. On open ground (something new): scaffold
  // and stacks where it will stand.
  const clearAt = (x, z, but) => dry(x, z) && streetEdge(x, z, 3) > 0.6 && !placed.some(x, z, 6, (o) => o !== but && rectDist(o, x, z) <= 2.6);
  for (const site of works.sites ?? []) {
    const x = ox + site.x, z = oz + site.z;
    let on = null;
    placed.some(x, z, 1, (o) => { if (rectDist(o, x, z) > 0.5) return false; on = o; return true; });
    if (!on) {
      if (site.kind !== 'fabric' && clearAt(x, z, null)) { slight(CITY_TYPE.SCAFFOLD, x, heightAt(x, z), z, boardHashUnit(Math.round(x), Math.round(z)) * Math.PI); built.scaffolds++; }
      continue;
    }
    for (const [ux, uz, half, turn] of [[0, 1, on.d / 2, Math.PI], [1, 0, on.w / 2, -Math.PI / 2], [-1, 0, on.w / 2, Math.PI / 2], [0, -1, on.d / 2, 0]]) {
      const [px, pz] = local(on, ux * (half + 2.8), uz * (half + 2.8));
      if (!clearAt(px, pz, on)) continue;
      slight(CITY_TYPE.SCAFFOLD, px, heightAt(px, pz), pz, on.yaw + turn); built.scaffolds++;
      break;
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

  /* ---- inland water: carve river/canal troughs and dammed ponds into heights, stand masonry weirs, and build water ribbons ---- */
  const n = grid.n;
  const uncarved = heights ? heights.slice() : null;
  const origAt = uncarved ? ((x, z) => fieldAt(uncarved, grid, x, z)) : heightAt;
  const waterVerts = [], waterIdx = [];
  const pushWaterVert = (wx, wy, wz, fx, fz, depth, bankT, kind) => {
    const id = waterVerts.length / 8;
    waterVerts.push(wx, wy, wz, fx, fz, depth, bankT, kind);
    return id;
  };
  const nearPad = (gx, gz) => placed.some(gx, gz, 9, (o) => rectDist(o, gx, gz) < 3.2) || solids.some(gx, gz, 14, (o) => rectDist(o, gx, gz) < 3.2);

  // Stand masonry weirs across estate pond dams before carving basins behind them.
  for (const place of places) {
    const dam = place.pond?.dam;
    if (!dam || !Number.isFinite(dam.x) || !Number.isFinite(dam.z)) continue;
    const dx = ox + dam.x, dz = oz + dam.z;
    if (!inside(dx, dz, 14)) continue;
    const tx = -Math.sin(dam.angle || 0), tz = Math.cos(dam.angle || 0);
    const lo = Number.isFinite(dam.lo) ? dam.lo : -8, hi = Number.isFinite(dam.hi) ? dam.hi : 8;
    const ax = dx + tx * lo, az = dz + tz * lo, bx = dx + tx * hi, bz = dz + tz * hi;
    const weirH = Math.max(2.6, Math.min(7.5, (place.pond.level ?? origAt(dx, dz)) - (dam.bed ?? origAt(dx, dz) - 2.2) + 0.9));
    curtain(ax, az, bx, bz, [Math.cos(dam.angle || 0), Math.sin(dam.angle || 0)], weirH, 0.88);
    built.dams++;
  }

  // Pool-Adjacent-Violators descending isotonic smoother + confluence leveling + sub-grid river cuts.
  const triHeightAt = heights ? ((x, z) => {
    const fx = Math.max(0, Math.min(n - 1.0001, (x - grid.x0) / grid.step));
    const fz = Math.max(0, Math.min(n - 1.0001, (z - grid.z0) / grid.step));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const k = j * n + i;
    const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + n], h11 = heights[k + n + 1];
    const mainDiag = Math.abs(h00 - h11) < Math.abs(h10 - h01) - 0.01;
    if (mainDiag) return u <= v ? h00 + (h01 - h00) * v + (h11 - h01) * u : h00 + (h10 - h00) * u + (h11 - h10) * v;
    return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h10 * (1 - v) + h01 * (1 - u) + h11 * (u + v - 1);
  }) : heightAt;
  const pavMonotoneDesc = (vals) => {
    const blocks = [];
    for (let i = 0; i < vals.length; i++) {
      blocks.push({ sum: vals[i], count: 1, lo: i, hi: i });
      while (blocks.length >= 2) {
        const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
        if (a.sum / a.count < b.sum / b.count) {
          a.sum += b.sum; a.count += b.count; a.hi = b.hi;
          blocks.pop();
        } else break;
      }
    }
    const out = new Float32Array(vals.length);
    for (const b of blocks) {
      const avg = b.sum / b.count;
      for (let i = b.lo; i <= b.hi; i++) out[i] = avg;
    }
    return out;
  };
  const riverRuns = [];
  for (let rIdx = 0; rIdx < (board.rivers?.length ?? 0); rIdx++) {
    const river = board.rivers[rIdx], pts = river.points, m = Math.floor((pts?.length ?? 0) / 3);
    if (m < 2) continue;
    const isCanal = Boolean(river.canal);
    const rawProf = new Float32Array(m);
    for (let s = 0; s < m; s++) {
      const wx = ox + pts[s * 3], wz = oz + pts[s * 3 + 1], oh = origAt(wx, wz);
      const lvl = Number.isFinite(river.levels?.[s]) ? river.levels[s] : oh - 0.55;
      rawProf[s] = Math.min(oh - 0.35, 0.72 * lvl + 0.28 * (oh - 0.35));
    }
    const prof = pavMonotoneDesc(rawProf);
    for (let s = 1; s < m; s++) prof[s] = Math.min(prof[s - 1], prof[s]);
    riverRuns.push({ rIdx, pts, m, isCanal, prof });

    // Tight sub-grid carving into heights strictly along the channel interior so 16 m bank shoulders retain
    // full natural valley relief while coarse distant LODs stay safely below water.
    const carveStride = Math.max(1, Math.min(2, Math.floor(grid.step / 8)));
    for (let s = 0; s < m - 1; s += carveStride) {
      const s1 = Math.min(m - 1, s + carveStride);
      const ax = ox + pts[s * 3], az = oz + pts[s * 3 + 1], ahw = Math.max(0.6, pts[s * 3 + 2]);
      const bx = ox + pts[s1 * 3], bz = oz + pts[s1 * 3 + 1], bhw = Math.max(0.6, pts[s1 * 3 + 2]);
      const maxHw = Math.max(ahw, bhw);
      const baseFlatR = grid.step > 20 ? maxHw + 0.5 : maxHw * 0.72;
      const outer = grid.step > 20 ? baseFlatR + Math.min(grid.step * 0.55, 8.0) : maxHw + 4.2;
      const wetOuter = maxHw + grid.step * 0.45;
      const scanR = Math.max(outer, wetOuter);
      const i0 = Math.max(1, Math.floor((Math.min(ax, bx) - scanR - grid.x0) / grid.step));
      const i1 = Math.min(n - 2, Math.ceil((Math.max(ax, bx) + scanR - grid.x0) / grid.step));
      const j0 = Math.max(1, Math.floor((Math.min(az, bz) - scanR - grid.z0) / grid.step));
      const j1 = Math.min(n - 2, Math.ceil((Math.max(az, bz) + scanR - grid.z0) / grid.step));
      const abx = bx - ax, abz = bz - az, ab2 = abx * abx + abz * abz || 1;
      for (let j = j0; j <= j1; j++) {
        const gz = grid.z0 + j * grid.step;
        for (let i = i0; i <= i1; i++) {
          const gx = grid.x0 + i * grid.step;
          const t = Math.max(0, Math.min(1, ((gx - ax) * abx + (gz - az) * abz) / ab2));
          const dist = Math.hypot(gx - (ax + abx * t), gz - (az + abz * t));
          if (dist >= scanR) continue;
          const k = j * n + i;
          const hw = ahw + (bhw - ahw) * t;
          if (dist <= hw + grid.step * 0.45) wet[k] = 1;
          if (!heights || dist >= outer) continue;
          const origH = uncarved[k];
          const padHit = nearPad(gx, gz);
          if (padHit && dist > hw + 1.0) continue;
          const flatR = padHit ? hw + 0.4 : baseFlatR;
          const wy = Math.max(origH > 0.45 ? 0.45 : -2.0, prof[s] + (prof[s1] - prof[s]) * t - 0.24);
          const depth = isCanal ? 1.35 : Math.min(2.2, 0.85 + 0.22 * hw);
          const bed = wy - depth;
          const u = dist <= flatR ? 0 : Math.min(1, (dist - flatR) / Math.max(0.75, outer - flatR));
          const sm = u * u * (3 - 2 * u);
          let target = dist <= flatR ? bed : bed * (1 - sm) + origH * sm;
          if (origH > 0.45) target = Math.max(0.30, target);
          if (target < heights[k]) heights[k] = target;
        }
      }
    }
  }

  // Build smoothed river reaches with shared embankment crests and confluence join leveling.
  const reachChains = [], riverReaches = [], riverCuts = [], bankVerts = [], bankIndices = [];
  const pushBankVert = (x, y, z, nx, ny, nz, wetAmt) => {
    const id = bankVerts.length / 8;
    bankVerts.push(x, y, z, nx, ny, nz, 2.0, Math.max(0, Math.min(1, wetAmt)));
    return id;
  };
  const pushBankTri = (ia, ib, ic) => {
    const ax = bankVerts[ia * 8], az = bankVerts[ia * 8 + 2];
    const bx = bankVerts[ib * 8], bz = bankVerts[ib * 8 + 2];
    const cx = bankVerts[ic * 8], cz = bankVerts[ic * 8 + 2];
    const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (Math.abs(crossY) < 1e-6) return;
    if (crossY > 0) bankIndices.push(ia, ib, ic);
    else bankIndices.push(ia, ic, ib);
  };
  // Protect bridge abutment approaches from being carved below road deck.
  const bridgePad = (gx, gz) => bridges.some((b) => Math.hypot(gx - b.x, gz - b.z) < b.span * 0.65 + 4);
  const inChannel = (chainIdx, wx, wz, hw) => {
    for (let o = 0; o < reachChains.length; o++) {
      if (o === chainIdx || reachChains[o].isCanal) continue;
      const ost = reachChains[o].stations;
      for (let k = 0; k < ost.length - 1; k++) {
        const ohw = ost[k].hw;
        if (!(ohw > hw + 0.4 || (Math.abs(ohw - hw) <= 0.4 && o < chainIdx))) continue;
        if (segDist(wx, wz, ost[k].wx, ost[k].wz, ost[k + 1].wx, ost[k + 1].wz) < ohw * 0.7) {
          return { o, k, ost };
        }
      }
    }
    return null;
  };

  for (const run of riverRuns) {
    const { pts, m, isCanal, prof } = run;
    let stations = [], accDist = 999;
    const flushReach = () => {
      if (stations.length >= 2) reachChains.push({ run, isCanal, stations: stations.slice() });
      stations.length = 0; accDist = 999;
    };
    for (let s = 0; s < m; s++) {
      const wx = ox + pts[s * 3], wz = oz + pts[s * 3 + 1], hw = Math.max(0.75, pts[s * 3 + 2]);
      if (!inside(wx, wz, 6)) { flushReach(); continue; }
      const oh = origAt(wx, wz);
      if (oh <= 0.12) {
        if (stations.length >= 1) {
          stations.push({ wx, wz, hw, wy: 0.02, bankMaxY: 0.18, depth: Math.min(2.4, 1.05 + 0.25 * hw), seaMouth: true });
          flushReach();
        } else {
          stations.length = 0; accDist = 999;
        }
        continue;
      }
      if (stations.length > 0) {
        const prev = stations[stations.length - 1];
        accDist += Math.hypot(wx - prev.wx, wz - prev.wz);
        if (accDist < 4.5 && s < m - 1) continue;
      }
      accDist = 0;
      stations.push({ wx, wz, hw, wy: prof[s], bankMaxY: origAt(wx, wz), depth: isCanal ? 1.45 : Math.min(2.4, 1.05 + 0.25 * hw), seaMouth: false });
    }
    flushReach();
  }

  // Trim tributary tongues overlapping main stems and extend sea mouths softly below tidewater (`drawnPart`).
  for (let c = 0; c < reachChains.length; c++) {
    const chain = reachChains[c], st = chain.stations;
    if (!chain.isCanal && st.length > 2) {
      let cutAt = st.length - 1;
      let joinTarget = null;
      while (cutAt > 1) {
        const hit = inChannel(c, st[cutAt - 1].wx, st[cutAt - 1].wz, st[cutAt - 1].hw);
        if (!hit) break;
        joinTarget = hit;
        cutAt--;
      }
      if (cutAt < st.length - 1) {
        st.length = cutAt + 1;
      } else {
        const endHit = inChannel(c, st[st.length - 1].wx, st[st.length - 1].wz, st[st.length - 1].hw);
        if (endHit) joinTarget = endHit;
      }
      if (joinTarget) {
        const { ost, k } = joinTarget;
        const p0 = ost[k], p1 = ost[k + 1];
        const dx = p1.wx - p0.wx, dz = p1.wz - p0.wz, d2 = dx * dx + dz * dz || 1;
        const end = st[st.length - 1];
        const t = Math.max(0, Math.min(1, ((end.wx - p0.wx) * dx + (end.wz - p0.wz) * dz) / d2));
        end.wx = p0.wx + dx * t;
        end.wz = p0.wz + dz * t;
        end.hw = Math.min(p0.hw * 0.92, end.hw * 1.6);
        if (st.length > 2) st[st.length - 2].hw *= 1.22;
        chain.mouthJoin = { otherIdx: joinTarget.o, k };
      }
    }
    const last = st[st.length - 1];
    if (last?.seaMouth && !chain.mouthJoin && st.length >= 2) {
      const prev = st[st.length - 2];
      const dx = last.wx - prev.wx, dz = last.wz - prev.wz, L = Math.hypot(dx, dz) || 1;
      const ux = dx / L, uz = dz / L, baseW = last.hw * 1.12;
      last.hw = baseW;
      last.wy = -0.02;
      for (const distOut of [10, 22]) {
        const qx = last.wx + ux * distOut, qz = last.wz + uz * distOut;
        if (!inside(qx, qz, 6) || origAt(qx, qz) > 0.12) break;
        st.push({ wx: qx, wz: qz, hw: baseW * (1 + distOut / 64), wy: -0.08 - distOut * 0.015, bankMaxY: origAt(qx, qz), depth: last.depth, seaMouth: true });
      }
    }
  }

  // Compute left/right normals & exact watertight bank crest elevations per reach, then PAV level + confluence joins.
  for (const chain of reachChains) {
    const st = chain.stations;
    for (let i = 0; i < st.length; i++) {
      const p0 = st[Math.max(0, i - 1)], p1 = st[Math.min(st.length - 1, i + 1)];
      const dx = p1.wx - p0.wx, dz = p1.wz - p0.wz, dLen = Math.hypot(dx, dz) || 1;
      const tx = dx / dLen, tz = dz / dLen, nx = -tz, nz = tx;
      const bankW = Math.max(1.85, Math.min(4.8, 1.45 + st[i].hw * 0.45));
      const crestHw = st[i].hw + bankW;
      const lx = st[i].wx - nx * crestHw, lz = st[i].wz - nz * crestHw;
      const rx = st[i].wx + nx * crestHw, rz = st[i].wz + nz * crestHw;
      const ly = inside(lx, lz, 2) ? triHeightAt(lx, lz) : origAt(lx, lz);
      const ry = inside(rx, rz, 2) ? triHeightAt(rx, rz) : origAt(rx, rz);
      st[i].tx = tx; st[i].tz = tz; st[i].nx = nx; st[i].nz = nz; st[i].dLen = dLen;
      st[i].crestHw = crestHw; st[i].lx = lx; st[i].lz = lz; st[i].ly = ly; st[i].rx = rx; st[i].rz = rz; st[i].ry = ry;
      if (!st[i].seaMouth) {
        const natMin = Math.min(origAt(lx, lz), origAt(rx, rz));
        const cap = Math.min(st[i].wy, Math.min(ly, ry) - 0.16, natMin - 0.30);
        st[i].wy = Math.max(0.06, cap);
      }
    }
    const leveled = pavMonotoneDesc(st.map((s) => s.wy));
    for (let i = 0; i < st.length; i++) {
      if (!st[i].seaMouth) st[i].wy = Math.max(0.06, Math.min(st[i].wy, leveled[i]));
      if (i > 0) st[i].wy = Math.min(st[i].wy, st[i - 1].wy);
    }
  }
  // Confluence join leveling (`levelRiverJoins` + upstream backwater leveling `levelRiverRuns`): match tributary ends cleanly.
  const confluenceJoins = [];
  for (let a = 0; a < reachChains.length; a++) {
    const chainA = reachChains[a], trib = chainA.stations, end = trib[trib.length - 1];
    if (end.seaMouth && !chainA.mouthJoin) continue;
    let bestB = chainA.mouthJoin?.otherIdx ?? -1, bestJ = chainA.mouthJoin?.k ?? -1, bestD = Infinity;
    if (bestB < 0) {
      for (let b = 0; b < reachChains.length; b++) {
        if (a === b) continue;
        const main = reachChains[b].stations;
        for (let j = 0; j < main.length; j++) {
          const reach = main[j].hw + end.hw + 8;
          const d = Math.hypot(end.wx - main[j].wx, end.wz - main[j].wz);
          if (d < reach && d < bestD) { bestD = d; bestB = b; bestJ = j; }
        }
      }
    }
    if (bestB >= 0) {
      const targetWy = reachChains[bestB].stations[bestJ].wy;
      end.wy = Math.min(end.wy, targetWy);
      for (let i = trib.length - 2; i >= 0; i--) trib[i].wy = Math.max(trib[i].wy, trib[i + 1].wy);
      confluenceJoins.push({ trib, end, main: reachChains[bestB].stations[bestJ] });
    }
  }
  // Ensure backwater propagates cleanly upstream with no local water humps.
  for (const chain of reachChains) {
    if (chain.isCanal) continue;
    let y = -Infinity;
    for (let i = chain.stations.length - 1; i >= 0; i--) {
      y = Math.max(y, chain.stations[i].wy);
      chain.stations[i].wy = y;
    }
  }

  function riverJoinPolygon(end, main) {
    const pts = [
      [end.lx, end.lz], [end.rx, end.rz],
      [main.lx, main.lz], [main.rx, main.rz],
    ];
    const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cz = pts.reduce((s, p) => s + p[1], 0) / 4;
    pts.sort((a, b) => Math.atan2(a[1] - cz, a[0] - cx) - Math.atan2(b[1] - cz, b[0] - cx));
    return pts;
  }
  for (const jn of confluenceJoins) {
    const poly = riverJoinPolygon(jn.end, jn.main);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [px, pz] of poly) { x0 = Math.min(x0, px); z0 = Math.min(z0, pz); x1 = Math.max(x1, px); z1 = Math.max(z1, pz); }
    riverCuts.push({ x0, z0, x1, z1, poly });
    const bedY = Math.min(jn.end.wy - jn.end.depth * 0.75, jn.main.wy - jn.main.depth * 0.75);
    const vc = pushBankVert(jn.main.wx, bedY, jn.main.wz, 0, 1, 0, 1.0);
    const rim = poly.map(([px, pz]) => pushBankVert(px, triHeightAt(px, pz), pz, 0, 1, 0, 0.05));
    for (let k = 0; k < rim.length; k++) pushBankTri(vc, rim[k], rim[(k + 1) % rim.length]);
  }

  for (let cIdx = 0; cIdx < reachChains.length; cIdx++) {
    const chain = reachChains[cIdx], st = chain.stations, isCanal = chain.isCanal;
    emitRiverRibbon(st, isCanal);
    let length = 0, minHalfWidth = Infinity;
    const reachPts = [];
    for (let i = 0; i < st.length; i++) {
      minHalfWidth = Math.min(minHalfWidth, st[i].hw);
      if (i > 0) length += Math.hypot(st[i].wx - st[i - 1].wx, st[i].wz - st[i - 1].wz);
      reachPts.push([st[i].wx, st[i].wz, st[i].hw, st[i].wy]);
    }
    riverReaches.push({ id: cIdx, isCanal, minHalfWidth, length, seaConnected: Boolean(st[st.length - 1].seaMouth), points: reachPts });
    // Emit shared-crest embankment + bed strips and matching 2D cut quads for sub-grid terrain clipping.
    let prevRow = null;
    for (let i = 0; i < st.length; i++) {
      const cur = st[i], nx = cur.nx, nz = cur.nz;
      const bedHw = Math.max(0.35, cur.hw * 0.62), bedY = cur.wy - cur.depth;
      const shoreHw = cur.hw;
      const slY = Math.min(cur.ly, Math.max(cur.wy + 0.02, cur.wy * 0.72 + bedY * 0.28));
      const srY = Math.min(cur.ry, Math.max(cur.wy + 0.02, cur.wy * 0.72 + bedY * 0.28));
      const bankDx = Math.max(0.6, cur.crestHw - shoreHw);
      const lSlopeLen = Math.hypot(bankDx, Math.max(0, cur.ly - slY));
      const rSlopeLen = Math.hypot(bankDx, Math.max(0, cur.ry - srY));
      const lnx = (cur.ly - slY) / lSlopeLen, lny = bankDx / lSlopeLen;
      const rnx = (cur.ry - srY) / rSlopeLen, rny = bankDx / rSlopeLen;
      const vCL = pushBankVert(cur.lx, cur.ly, cur.lz, 0, 1, 0, 0.0);
      const vSL = pushBankVert(cur.wx - nx * shoreHw, slY, cur.wz - nz * shoreHw, nx * lnx, lny, nz * lnx, 0.76);
      const vBL = pushBankVert(cur.wx - nx * bedHw, bedY, cur.wz - nz * bedHw, nx * 0.28, 0.96, nz * 0.28, 1.0);
      const vBR = pushBankVert(cur.wx + nx * bedHw, bedY, cur.wz + nz * bedHw, -nx * 0.28, 0.96, -nz * 0.28, 1.0);
      const vSR = pushBankVert(cur.wx + nx * shoreHw, srY, cur.wz + nz * shoreHw, -nx * rnx, rny, -nz * rnx, 0.76);
      const vCR = pushBankVert(cur.rx, cur.ry, cur.rz, 0, 1, 0, 0.0);
      const row = [vCL, vSL, vBL, vBR, vSR, vCR];
      if (prevRow) {
        const pSt = st[i - 1];
        const poly = [[pSt.lx, pSt.lz], [cur.lx, cur.lz], [cur.rx, cur.rz], [pSt.rx, pSt.rz]];
        riverCuts.push({
          x0: Math.min(poly[0][0], poly[1][0], poly[2][0], poly[3][0]),
          z0: Math.min(poly[0][1], poly[1][1], poly[2][1], poly[3][1]),
          x1: Math.max(poly[0][0], poly[1][0], poly[2][0], poly[3][0]),
          z1: Math.max(poly[0][1], poly[1][1], poly[2][1], poly[3][1]),
          poly,
        });
        for (let b = 0; b < 5; b++) {
          pushBankTri(prevRow[b], row[b], row[b + 1]);
          pushBankTri(prevRow[b], row[b + 1], prevRow[b + 1]);
        }
      }
      prevRow = row;
    }
  }

  function emitRiverRibbon(st, isCanal) {
    // 5-across water strip tucked under the sloped wet banks so edges never float or Z-fight.
    for (let i = 1; i < st.length; i++) st[i].wy = Math.min(st[i].wy, st[i - 1].wy);
    const kind = isCanal ? 1.0 : 0.0;
    const lanes = [-1.0, -0.55, 0.0, 0.55, 1.0];
    let prevRow = null;
    for (let i = 0; i < st.length; i++) {
      const cur = st[i], p0 = st[Math.max(0, i - 1)], p1 = st[Math.min(st.length - 1, i + 1)];
      const dx = p1.wx - p0.wx, dz = p1.wz - p0.wz, dLen = Math.hypot(dx, dz) || 1;
      const tx = dx / dLen, tz = dz / dLen, nx = -tz, nz = tx;
      const slope = Math.max(0, (p0.wy - p1.wy) / dLen);
      const speed = isCanal ? 0.35 : Math.max(0.55, Math.min(3.0, 0.58 + Math.sqrt(slope) * 6.8));
      const ribHw = cur.hw + 0.45;
      const row = lanes.map((bt) => {
        const edge = Math.abs(bt);
        const yOff = edge > 0.9 ? -0.035 : edge > 0.4 ? -0.008 : 0.0;
        const speedMul = 1.0 - edge * 0.25;
        return pushWaterVert(cur.wx + nx * ribHw * bt, cur.wy + yOff, cur.wz + nz * ribHw * bt, tx * speed * speedMul, tz * speed * speedMul, cur.depth * (1.0 - edge * 0.42), bt, kind);
      });
      if (prevRow) {
        for (let b = 0; b < 4; b++) {
          waterIdx.push(prevRow[b], row[b], row[b + 1], prevRow[b], row[b + 1], prevRow[b + 1]);
        }
      }
      prevRow = row;
    }
  }

  // Carve & fill any dammed estate ponds.
  for (const place of places) {
    const pond = place.pond, p = pond?.points;
    if (!p || p.length < 6) continue;
    const pm = Math.floor(p.length / 2);
    let cx = 0, cz = 0, rimMin = Infinity, px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity;
    const poly = new Float64Array(pm * 2);
    for (let k = 0; k < pm; k++) {
      const wx = ox + p[k * 2], wz = oz + p[k * 2 + 1];
      poly[k * 2] = wx; poly[k * 2 + 1] = wz;
      cx += wx; cz += wz;
      px0 = Math.min(px0, wx); px1 = Math.max(px1, wx);
      pz0 = Math.min(pz0, wz); pz1 = Math.max(pz1, wz);
      rimMin = Math.min(rimMin, origAt(wx, wz));
    }
    cx /= pm; cz /= pm;
    if (!inside(cx, cz, 16) || rimMin <= 0.4) continue;
    const pondY = Math.max(0.55, rimMin - 0.22);
    const inPoly = (x, z) => {
      let insideFlag = false;
      for (let a = 0, b = pm - 1; a < pm; b = a++) {
        const ax = poly[a * 2], az = poly[a * 2 + 1], bx = poly[b * 2], bz = poly[b * 2 + 1];
        if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) insideFlag = !insideFlag;
      }
      return insideFlag;
    };
    const i0 = Math.max(1, Math.floor((px0 - grid.step - grid.x0) / grid.step));
    const i1 = Math.min(n - 2, Math.ceil((px1 + grid.step - grid.x0) / grid.step));
    const j0 = Math.max(1, Math.floor((pz0 - grid.step - grid.z0) / grid.step));
    const j1 = Math.min(n - 2, Math.ceil((pz1 + grid.step - grid.z0) / grid.step));
    for (let j = j0; j <= j1; j++) {
      const gz = grid.z0 + j * grid.step;
      for (let i = i0; i <= i1; i++) {
        const gx = grid.x0 + i * grid.step;
        if (!inPoly(gx, gz)) continue;
        const k = j * n + i;
        wet[k] = 1;
        if (heights && !nearPad(gx, gz)) heights[k] = Math.min(heights[k], Math.max(0.32, pondY - 1.75));
      }
    }
    const centerV = pushWaterVert(cx, pondY, cz, 0.08, 0.04, 1.75, 0.0, 2.0);
    const ringV = [];
    for (let k = 0; k < pm; k++) {
      const wx = poly[k * 2], wz = poly[k * 2 + 1];
      const ex = wx + (wx - cx) * 0.08, ez = wz + (wz - cz) * 0.08;
      ringV.push(pushWaterVert(ex, pondY - 0.02, ez, 0.08, 0.04, 0.45, 1.0, 2.0));
    }
    for (let k = 0; k < pm; k++) waterIdx.push(centerV, ringV[k], ringV[(k + 1) % pm]);
  }

  const inlandWater = waterIdx.length ? {
    vertices: new Float32Array(waterVerts),
    indices: new Uint32Array(waterIdx),
  } : null;

  /* ---- the town on the lattice: where it stands, how far beyond it each point lies, how near its middle ---- */
  const urbanMark = new Uint8Array(n * n), early = new Float32Array(n * n).fill(-1);
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

  /* ---- the model's standing wood mask (2 bits/cell: 0 open, 1 broadleaf forest, 2 pine forest, 3 scrub wood) ---- */
  const woodGrid = Number.isInteger(board.grid) && board.grid > 0 ? board.grid : 0;
  const woodCellM = woodGrid > 0 ? region.span / woodGrid : 0;
  let woodBytes = null;
  if (typeof board.woods === 'string' && board.woods.length > 0 && woodGrid > 0) {
    const raw = atob(board.woods);
    woodBytes = new Uint8Array(raw.length);
    for (let k = 0; k < raw.length; k++) woodBytes[k] = raw.charCodeAt(k);
  }
  const cellWoodCode = (cx, cz) => {
    if (cx < 0 || cz < 0 || cx >= woodGrid || cz >= woodGrid) return 0;
    const c = cz * woodGrid + cx;
    return (woodBytes[c >> 2] >> ((c & 3) * 2)) & 3;
  };
  const woodCodeAt = (x, z) => {
    if (!woodBytes) return -1;
    return cellWoodCode(Math.floor((x - ox + half) / woodCellM), Math.floor((z - oz + half) / woodCellM));
  };
  const woodNoise2 = (ux, uz, salt) => {
    const i = Math.floor(ux), j = Math.floor(uz), a = ux - i, b = uz - j;
    const su = a * a * (3 - 2 * a), sv = b * b * (3 - 2 * b);
    const p00 = boardHashUnit(i * 73856093 ^ j * 19349663, salt);
    const p10 = boardHashUnit((i + 1) * 73856093 ^ j * 19349663, salt);
    const p01 = boardHashUnit(i * 73856093 ^ (j + 1) * 19349663, salt);
    const p11 = boardHashUnit((i + 1) * 73856093 ^ (j + 1) * 19349663, salt);
    return (p00 * (1 - su) + p10 * su) * (1 - sv) + (p01 * (1 - su) + p11 * su) * sv;
  };
  // Smooth organic wood density (0..1) across cell edges so forest borders curve and feather naturally.
  const woodShareAt = (x, z) => {
    if (!woodBytes) return -1;
    const wx = x + (woodNoise2(x / 38, z / 38, 0x31a7) - 0.5) * woodCellM * 0.62;
    const wz = z + (woodNoise2(x / 38, z / 38, 0x7b9d) - 0.5) * woodCellM * 0.62;
    const u = (wx - ox + half) / woodCellM - 0.5, v = (wz - oz + half) / woodCellM - 0.5;
    const i = Math.floor(u), j = Math.floor(v), fx = u - i, fz = v - j;
    const d00 = (cellWoodCode(i, j) === 1 || cellWoodCode(i, j) === 2) ? 1 : 0;
    const d10 = (cellWoodCode(i + 1, j) === 1 || cellWoodCode(i + 1, j) === 2) ? 1 : 0;
    const d01 = (cellWoodCode(i, j + 1) === 1 || cellWoodCode(i, j + 1) === 2) ? 1 : 0;
    const d11 = (cellWoodCode(i + 1, j + 1) === 1 || cellWoodCode(i + 1, j + 1) === 2) ? 1 : 0;
    return (d00 * (1 - fx) + d10 * fx) * (1 - fz) + (d01 * (1 - fx) + d11 * fx) * fz;
  };

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
    const wild = field.state === BOARD_STANDS.WILD;
    let kind;
    if (field.state === BOARD_STANDS.WOOD) kind = LAND.WOOD;
    else if (wild && (field.wood ?? 0) >= 0.5) kind = LAND.WOOD;
    else if (field.state === BOARD_STANDS.TILLED) {
      kind = field.kind === BOARD_HELD.GARDEN ? LAND.GARDEN : field.kind === BOARD_HELD.VINE ? LAND.VINES : field.kind === BOARD_HELD.CLOSE ? LAND.OLIVES : field.kind === BOARD_HELD.MEADOW ? LAND.PASTURE
        // Corn stands one year in two.
        : boardHashUnit(id, 3) < 0.38 ? LAND.FALLOW : LAND.CORN;
    } else if (field.state === BOARD_STANDS.PASTURE) kind = LAND.PASTURE;
    else if (field.state === BOARD_STANDS.SCRUB) kind = LAND.SCRUB;
    else if (field.state === BOARD_STANDS.BURNT) kind = LAND.FALLOW;
    // Open waste and unclaimed non-forest ground: open grassland (lone trees come from the model's treeSpots).
    else kind = LAND.PASTURE;
    uses[id] = {
      kind, wild, place: field.place, heading: field.heading, strip: field.strip,
      shade: boardHashUnit(id, 17), turn: boardHashUnit(id, 29),
      wooded: false,
      hedged: !wild && boardHashUnit(id, 53) < BOARD_HEDGED_SHARE[kind],
    };
  });
  // Unploughed steep/wet corners inside worked furlongs keep their dense forest in Castle and Commons; clear
  // the cultivated parcel tint on those wooded texels (keeping at least the last furlong represented in index).
  if (woodBytes) {
    for (let j = 0; j < size; j++) {
      const wz = bounds.z0 + (j + 0.5) * cell;
      for (let i = 0; i < size; i++) {
        const slot = index[j * size + i];
        if (!slot || slot === fields.length) continue;
        const u = uses[slot - 1];
        if (u.wild || u.kind === LAND.WOOD) continue;
        const wx = bounds.x0 + (i + 0.5) * cell;
        if (woodShareAt(wx, wz) >= 0.45) index[j * size + i] = 0;
      }
    }
  }
  // How far a point lies inside its furlong: to the nearest side of the figure.
  const edgeOf = (id, x, z) => {
    const p = figures[id], m = p.length / 2;
    let best = 1e9;
    for (let k = 0; k < m; k++) best = Math.min(best, segDist(x, z, p[k * 2], p[k * 2 + 1], p[((k + 1) % m) * 2], p[((k + 1) % m) * 2 + 1]));
    return best;
  };
  const DENSE_WOOD_USE = { kind: LAND.WOOD, wild: true, shade: 0.5, turn: 0.5, wooded: true, hedged: false };
  const SCRUB_WOOD_USE = { kind: LAND.SCRUB, wild: true, shade: 0.5, turn: 0.5, wooded: false, hedged: false };
  const OPEN_WASTE_USE = { kind: LAND.PASTURE, wild: true, shade: 0.5, turn: 0.5, wooded: false, hedged: false };
  const NO_PARCEL = { use: OPEN_WASTE_USE, edge: 1e9, woodEdge: 0, i: 0, j: 0 };
  const parcelAt = (x, z) => {
    const wShare = woodShareAt(x, z);
    const wCode = woodCodeAt(x, z);
    const i = Math.floor((x - bounds.x0) / cell), j = Math.floor((z - bounds.z0) / cell);
    const id = i < 0 || j < 0 || i >= size || j >= size ? -1 : index[j * size + i] - 1;
    if (wShare >= 0.45) {
      return { use: id >= 0 && uses[id].kind === LAND.WOOD ? uses[id] : DENSE_WOOD_USE, edge: 1e9, woodEdge: 1, i: Math.max(0, id), j: 0 };
    }
    const woodEdge = wShare > 0.06 ? (wShare - 0.06) / 0.39 : 0;
    if (wCode === 3) {
      return { use: id >= 0 && uses[id].kind === LAND.SCRUB ? uses[id] : SCRUB_WOOD_USE, edge: 1e9, woodEdge, i: Math.max(0, id), j: 0 };
    }
    if (id < 0) return woodEdge > 0 ? { use: OPEN_WASTE_USE, edge: 1e9, woodEdge, i: 0, j: 0 } : NO_PARCEL;
    const use = uses[id];
    // Inside a mostly-wooded WILD furlong, non-forested cells stay open rough waste beyond the wood's feathered margin.
    if (wShare >= 0 && use.wild && use.kind === LAND.WOOD) return { use: OPEN_WASTE_USE, edge: 1e9, woodEdge, i: id, j: 0 };
    return { use, edge: use.hedged ? edgeOf(id, x, z) : 1e9, woodEdge, i: id, j: 0 };
  };

  /* ---- roads between places are already trimmed and registered before building placement above ---- */

  /* ---- standing livestock herds on pastures, rough commons and oak woods ---- */
  const pastureByPlace = Array.from({ length: places.length }, () => []);
  const woodByPlace = Array.from({ length: places.length }, () => []);
  const wildPastures = [];
  fields.forEach((field, id) => {
    const fx = ox + field.x, fz = oz + field.z;
    if (!inside(fx, fz, 28) || heightAt(fx, fz) < 1.35) return;
    if (fieldAt(town.urban, grid, fx, fz) > 0.2 || fieldAt(town.inland, grid, fx, fz) < 6) return;
    const clearEdge = edgeOf(id, fx, fz);
    if (clearEdge < 7) return;
    const rec = { id, x: fx, z: fz, r: Math.min(28, Math.max(5.5, clearEdge - 2.5)), heading: field.heading || 0 };
    const useKind = uses[id].kind;
    if (field.place >= 0 && field.place < places.length) {
      if (useKind === LAND.PASTURE || useKind === LAND.OLIVES || useKind === LAND.FALLOW) pastureByPlace[field.place].push(rec);
      else if (useKind === LAND.WOOD || useKind === LAND.SCRUB) woodByPlace[field.place].push(rec);
    } else if (useKind === LAND.PASTURE || useKind === LAND.SCRUB) {
      wildPastures.push(rec);
    }
  });
  let totalRawHerds = 0;
  for (const p of places) {
    const h = p.herds;
    if (h) totalRawHerds += (h.sheep || 0) + (h.cattle || 0) + (h.swine || 0) + (h.horses || 0);
  }
  const MAX_HERD_HEAD = 1440;
  const herdScale = totalRawHerds > MAX_HERD_HEAD ? MAX_HERD_HEAD / totalRawHerds : 1;
  const herdFloats = [];
  const speciesScale = [[0.90, 0.22], [0.92, 0.18], [0.88, 0.24], [0.94, 0.14]];
  const placeFlock = (pool, fallbackPool, countWanted, species, seedSalt) => {
    const list = pool.length ? pool : fallbackPool.length ? fallbackPool : wildPastures;
    if (!list.length || countWanted <= 0) return;
    const flockSize = species === 0 ? 12 : species === 2 ? 9 : 7;
    let left = countWanted, fIdx = 0;
    while (left > 0 && herdFloats.length < MAX_HERD_HEAD * 8) {
      const take = Math.min(left, flockSize);
      left -= take;
      const pick = list[Math.floor(boardHashUnit(seedSalt + fIdx * 17, species + 11) * list.length) % list.length];
      fIdx++;
      const flockYaw = (pick.heading || 0) + (boardHashUnit(seedSalt + fIdx, 41) - 0.5) * 1.2;
      for (let m = 0; m < take; m++) {
        const hSeed = seedSalt * 131 + fIdx * 37 + m;
        const ang = boardHashUnit(hSeed, 3) * 2 * Math.PI;
        const rad = Math.sqrt(boardHashUnit(hSeed, 7)) * pick.r * 0.62;
        const ax = pick.x + Math.cos(ang) * rad, az = pick.z + Math.sin(ang) * rad;
        if (!inside(ax, az, 16) || heightAt(ax, az) < 1.1 || nearPad(ax, az) || streetEdge(ax, az, 4) < 1.8) continue;
        const roamR = Math.max(2.2, Math.min(11.5, pick.r * 0.34));
        const phase = boardHashUnit(hSeed, 13) * 2 * Math.PI;
        const coatSeed = boardHashUnit(hSeed, 19);
        const [sBase, sSpan] = speciesScale[species];
        const sc = sBase + boardHashUnit(hSeed, 23) * sSpan;
        herdFloats.push(ax, az, roamR, phase, coatSeed, sc, species, flockYaw);
      }
    }
  };
  if (totalRawHerds > 0) {
    places.forEach((place, pi) => {
      const h = place.herds;
      if (!h) return;
      const scaleCnt = (nHead) => nHead > 0 ? Math.max(Math.min(nHead, 4), Math.round(nHead * herdScale)) : 0;
      placeFlock(pastureByPlace[pi], wildPastures, scaleCnt(h.sheep || 0), 0, pi * 97 + 1);
      placeFlock(pastureByPlace[pi], wildPastures, scaleCnt(h.cattle || 0), 1, pi * 97 + 2);
      placeFlock(woodByPlace[pi], pastureByPlace[pi], scaleCnt(h.swine || 0), 2, pi * 97 + 3);
      placeFlock(pastureByPlace[pi], wildPastures, scaleCnt(h.horses || 0), 3, pi * 97 + 4);
    });
  } else {
    // Un-lived day-0 boards without exported herd counts still carry modest starter flocks on their pastures.
    places.forEach((_, pi) => {
      placeFlock(pastureByPlace[pi], wildPastures, Math.min(18, pastureByPlace[pi].length * 3), 0, pi * 97 + 1);
      placeFlock(pastureByPlace[pi], wildPastures, Math.min(8, pastureByPlace[pi].length * 2), 1, pi * 97 + 2);
      placeFlock(woodByPlace[pi], pastureByPlace[pi], Math.min(6, woodByPlace[pi].length * 2), 2, pi * 97 + 3);
    });
  }
  const herds = herdFloats.length ? new Float32Array(herdFloats) : null;
  built.herds = herdFloats.length / 8;

  /* ---- lone trees and copses of the model's open country, marshes and scrub outside dense woods ---- */
  const rawLone = board.loneTrees ?? [];
  const loneFloats = [];
  for (let k = 0; k + 3 < rawLone.length; k += 4) {
    const wx = ox + rawLone[k], wz = oz + rawLone[k + 1];
    if (!inside(wx, wz, 8) || heightAt(wx, wz) <= BOARD_DRY_M || fieldAt(town.inland, grid, wx, wz) < 4) continue;
    if (fieldAt(town.urban, grid, wx, wz) >= 0.45 || streetEdge(wx, wz, 4) < 3.5 || houseNear(wx, wz, 3.5)) continue;
    if (solids.some(wx, wz, 6, (o) => rectDist(o, wx, wz) < 4)) continue;
    if (woodShareAt(wx, wz) >= 0.45) continue;
    loneFloats.push(wx, wz, rawLone[k + 2], rawLone[k + 3]);
  }
  const loneTrees = loneFloats.length ? new Float32Array(loneFloats) : null;
  built.loneTrees = loneFloats.length / 4;

  const blockCount = blocks.length / CITY_BLOCK_FLOATS;
  const plan = {
    blocks: new Float32Array(blocks), count: blockCount, houses, streets, places: squares, gates, churches, lots, paving, standing,
    typed: new Float32Array(typed), typedTypes: new Uint32Array(typedTypes), typedCount: typedTypes.length, typedBlocks: new Uint32Array(typedBlocks),
    typedAttached: Uint8Array.from({ length: typedTypes.length }, (_, i) => attached.get(i) ?? 0),
    groundAt, treesAt: cityTreesAt,
    stats: {
      blocks: blockCount, typed: typedTypes.length, houses, streets: streets.length, churches: churches.length, gates: gates.length,
      lanes: streets.filter((s) => s.kind === 'lane' || s.kind === 'alley').length, squares: squares.length, places: places.length,
      furlongs: fields.length, people: board.people, day: board.day ?? 0, fronts, stalls, built, dropped,
      milliseconds: typeof performance === 'object' ? performance.now() - started : 0,
    },
  };
  return {
    plan, town, roads, parcelAt, places, seat, inlandWater, herds, loneTrees, bridges,
    riverCut: riverCuts.length ? { cuts: riverCuts, bankVerts: new Float32Array(bankVerts), bankIndices: new Uint32Array(bankIndices) } : null,
    riverReaches,
    // Who mans the seat, by the model's own roll on the board's day: its port's posts are manned from it (js/crew.js).
    watch: seat.watch ? { ...seat.watch, place: seat.name, day: board.day ?? 0 } : null,
    // For the GPU, which stamps the country onto the ground's own colours: the furlong of every cell, each
    // furlong's use, and every way that runs across it.
    stamp: {
      size, index, uses, roads, streets, squares, lots, town: urban, lanes: board.lanes, rivers: board.rivers.map((river) => river.points), bridges,
      origin: { x: ox, z: oz }, span: region.span,
    },
  };
}
