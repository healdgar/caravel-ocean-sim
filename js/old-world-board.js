// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A coast as Castle and Commons' model founded it (its board: js/board-model.js), stood up in this game. The board
// says only what stands where. Everything that stands is this game's own: each building a type written in Cairn
// (js/old-world-buildings.js), so it is drawn, lit, struck and broken as every other; walls, towers and gates by
// the same masons as the city generator's (js/old-world-city.js); woodland handed to the forest; water left as the
// game has it. Ground keeps the look of its geography: what the board adds to it is drawn by the GPU
// (js/board-stamp.js) from the compact tables made here once.
import { CITY_BLOCK_FLOATS, CITY_GROUND, CITY_ROOF, CITY_TREES, CITY_WALL, cityFootprintsOverlap, cityMasonry, footprint, local, makeHash, mulberry, rectDist, segDist } from './old-world-city.js';
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
export const BOARD_ROAD_BRIDGE = Object.freeze({ width: 6, arch: 11, rise: 0.5 });
export function boardRoadCrossings(roads, rivers) {
  const out = [];
  for (const river of rivers ?? []) {
    const R = river.points;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let j = 0; j + 2 < R.length; j += 3) { const pad = R[j + 2] + 1; x0 = Math.min(x0, R[j] - pad); x1 = Math.max(x1, R[j] + pad); z0 = Math.min(z0, R[j + 1] - pad); z1 = Math.max(z1, R[j + 1] + pad); }
    for (const road of roads ?? []) {
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
          if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 12)) continue;
          // Across a river met askew the water is wider along the road; a road is brought to no shallower a crossing than this.
          const sine = Math.abs(den) / (L * Math.hypot(dx - cx, dz - cz)), half = R[j + 2] + (R[j + 5] - R[j + 2]) * u;
          out.push({ x, z, ux: (bx - ax) / L, uz: (bz - az) / L, span: 2 * half / Math.max(0.35, sine) });
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
    const f = footprint(x, z, front, depth, yaw);
    if (taken(f, 0.8)) { dropped.port++; continue; }
    const left = stateOf ? stateOf[k] : 0;
    if (left) standLeft(k, f, left === 3);
    else if (arch === 'tower') {
      tower(x, z, 6.2, Math.max(10, Math.min(15, h)), 0.9);
      occupy(footprint(x, z, 7, 7, yaw));
    } else if (arch === 'wall') {
      // A length of wall the model stood by itself: its parapet toward the street it faces, or outward from the place.
      const long = Math.max(w, d) / 2, a = rot + (w >= d ? 0 : Math.PI / 2), ux = Math.cos(a), uz = -Math.sin(a), p = places[place] ?? seat;
      curtain(x - ux * long, z - uz * long, x + ux * long, z + uz * long, fx || fz ? [fx, fz] : [x - p.x, z - p.z], CITY_CURTAIN.height, 0.86);
    } else if (BOARD_WORKS[arch]) standWork(k, f, arch, Boolean(fx || fz));
    else if (arch === 'temple') {
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
        const near = 1 - Math.hypot(x - seat.x, z - seat.z) / seat.reach, lot = boardHashUnit(k, 59), merchant = arch === 'burgher' || arch === 'shop';
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
  // A track's bridge: its deck a little over the higher bank.
  for (let k = 0; k + 5 < spans.length; k += 6) {
    const x = ox + spans[k], z = oz + spans[k + 1], ux = spans[k + 2], uz = spans[k + 3], span = Math.max(4, spans[k + 4]), half = span / 2;
    if (!inside(x, z, 12)) continue;
    const deck = Math.max(heightAt(x - ux * half, z - uz * half), heightAt(x + ux * half, z + uz * half), BOARD_DRY_M) + 0.35;
    slight(spans[k + 5] ? CITY_TYPE.STONE_BRIDGE : CITY_TYPE.FOOTBRIDGE, x, deck, z, Math.atan2(ux, uz), 0.5, span + 1);
    built.bridges++;
  }
  // A road's bridge where it crosses a river: stone, the road's width, bank to bank in a run of arches no wider than
  // a mason of the time could turn.
  for (const q of boardRoadCrossings(board.roads, board.rivers)) {
    const x = ox + q.x, z = oz + q.z, reach = q.span / 2 + 1, T = CITY_BUILDING_TYPES[CITY_TYPE.STONE_BRIDGE];
    if (!inside(x, z, 12)) continue;
    const deck = Math.max(heightAt(x - q.ux * reach, z - q.uz * reach), heightAt(x + q.ux * reach, z + q.uz * reach), BOARD_DRY_M) + BOARD_ROAD_BRIDGE.rise;
    const arches = Math.max(1, Math.ceil(reach * 2 / BOARD_ROAD_BRIDGE.arch)), each = reach * 2 / arches;
    for (let a = 0; a < arches; a++) {
      const along = (a + 0.5) * each - reach;
      pushTyped(CITY_TYPE.STONE_BRIDGE, x + q.ux * along, deck, z + q.uz * along, Math.atan2(q.ux, q.uz), BOARD_ROAD_BRIDGE.width, T.height, each, 0.5, 0);
    }
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

  for (const river of board.rivers ?? []) {
    const pts = river.points;
    const m = Math.floor((pts?.length ?? 0) / 3);
    if (m < 2) continue;
    const isCanal = Boolean(river.canal);
    const rawProf = new Float32Array(m);
    for (let s = 0; s < m; s++) rawProf[s] = origAt(ox + pts[s * 3], oz + pts[s * 3 + 1]);
    const prof = new Float32Array(m);
    for (let s = 0; s < m; s++) {
      let sum = 0, cnt = 0;
      for (let d = -4; d <= 4; d++) {
        const idx = Math.max(0, Math.min(m - 1, s + d));
        sum += rawProf[idx]; cnt++;
      }
      const sm = sum / cnt;
      const hint = Number.isFinite(river.levels?.[s]) ? Math.min(sm, 0.25 * river.levels[s] + 0.75 * sm) : sm;
      prof[s] = s === 0 ? hint : Math.min(prof[s - 1], hint);
    }

    // Carve smooth valley channel into heights and mark wet cells so trees stay clear of watercourses.
    const carveStride = Math.max(1, Math.min(3, Math.floor(grid.step / 6)));
    for (let s = 0; s < m - 1; s += carveStride) {
      const s1 = Math.min(m - 1, s + carveStride);
      const ax = ox + pts[s * 3], az = oz + pts[s * 3 + 1], ahw = Math.max(0.6, pts[s * 3 + 2]);
      const bx = ox + pts[s1 * 3], bz = oz + pts[s1 * 3 + 1], bhw = Math.max(0.6, pts[s1 * 3 + 2]);
      const maxHw = Math.max(ahw, bhw);
      const baseFlatR = Math.max(maxHw, grid.step * 0.74);
      const outer = baseFlatR + grid.step * 1.1;
      const i0 = Math.max(1, Math.floor((Math.min(ax, bx) - outer - grid.x0) / grid.step));
      const i1 = Math.min(n - 2, Math.ceil((Math.max(ax, bx) + outer - grid.x0) / grid.step));
      const j0 = Math.max(1, Math.floor((Math.min(az, bz) - outer - grid.z0) / grid.step));
      const j1 = Math.min(n - 2, Math.ceil((Math.max(az, bz) + outer - grid.z0) / grid.step));
      const abx = bx - ax, abz = bz - az, ab2 = abx * abx + abz * abz || 1;
      for (let j = j0; j <= j1; j++) {
        const gz = grid.z0 + j * grid.step;
        for (let i = i0; i <= i1; i++) {
          const gx = grid.x0 + i * grid.step;
          const t = Math.max(0, Math.min(1, ((gx - ax) * abx + (gz - az) * abz) / ab2));
          const dist = Math.hypot(gx - (ax + abx * t), gz - (az + abz * t));
          if (dist >= outer) continue;
          const k = j * n + i;
          const hw = ahw + (bhw - ahw) * t;
          if (dist <= hw + grid.step * 0.45) wet[k] = 1;
          if (!heights) continue;
          const origH = uncarved[k];
          const padHit = nearPad(gx, gz);
          if (padHit && dist > hw + 1.2) continue;
          const flatR = padHit ? hw + 0.6 : baseFlatR;
          const wy = Math.max(origH > 0.45 ? 0.45 : -2.0, prof[s] + (prof[s1] - prof[s]) * t - 0.24);
          const depth = isCanal ? 1.35 : Math.min(2.2, 0.85 + 0.22 * hw);
          const bed = wy - depth;
          const u = dist <= flatR ? 0 : Math.min(1, (dist - flatR) / Math.max(1, outer - flatR));
          const sm = u * u * (3 - 2 * u);
          let target = dist <= flatR ? bed : bed * (1 - sm) + origH * sm;
          if (origH > 0.45) target = Math.max(0.30, target);
          if (target < heights[k]) heights[k] = target;
        }
      }
    }

    // Build continuous freshwater ribbon segments down to sea level.
    const stations = [];
    let accDist = 999;
    for (let s = 0; s < m; s++) {
      const wx = ox + pts[s * 3], wz = oz + pts[s * 3 + 1], hw = Math.max(0.65, pts[s * 3 + 2]);
      if (!inside(wx, wz, 6)) {
        if (stations.length >= 2) emitRiverRibbon(stations, isCanal);
        stations.length = 0; accDist = 999;
        continue;
      }
      const oh = origAt(wx, wz);
      if (oh <= 0.12) {
        if (stations.length >= 1) {
          stations.push({ wx, wz, hw, wy: 0.04, depth: Math.min(2.2, 0.85 + 0.22 * hw) });
          if (stations.length >= 2) emitRiverRibbon(stations, isCanal);
        }
        stations.length = 0; accDist = 999;
        continue;
      }
      if (stations.length > 0) {
        const prev = stations[stations.length - 1];
        const segD = Math.hypot(wx - prev.wx, wz - prev.wz);
        accDist += segD;
        if (accDist < 4.5 && s < m - 1) continue;
      }
      accDist = 0;
      const carvedBed = heights ? heightAt(wx, wz) : prof[s] - 1.1;
      const wy = Math.max(0.14, Math.max(prof[s] - 0.24, carvedBed + 0.16));
      const depth = Math.max(0.35, wy - carvedBed);
      stations.push({ wx, wz, hw, wy, depth });
    }
    if (stations.length >= 2) emitRiverRibbon(stations, isCanal);
  }

  function emitRiverRibbon(st, isCanal) {
    // Keep water surface monotonically non-increasing along each continuous reach.
    for (let i = 1; i < st.length; i++) st[i].wy = Math.min(st[i].wy, st[i - 1].wy);
    const kind = isCanal ? 1.0 : 0.0;
    let prevRow = null;
    for (let i = 0; i < st.length; i++) {
      const cur = st[i];
      const p0 = st[Math.max(0, i - 1)], p1 = st[Math.min(st.length - 1, i + 1)];
      const dx = p1.wx - p0.wx, dz = p1.wz - p0.wz, dLen = Math.hypot(dx, dz) || 1;
      const tx = dx / dLen, tz = dz / dLen;
      const nx = -tz, nz = tx;
      const slope = Math.max(0, (p0.wy - p1.wy) / dLen);
      const speed = isCanal ? 0.35 : Math.max(0.55, Math.min(3.0, 0.58 + Math.sqrt(slope) * 6.8));
      const fx = tx * speed, fz = tz * speed;
      const ribHw = cur.hw + Math.min(2.6, grid.step * 0.34);
      const vL = pushWaterVert(cur.wx - nx * ribHw, cur.wy - 0.025, cur.wz - nz * ribHw, fx, fz, cur.depth, -1.0, kind);
      const vC = pushWaterVert(cur.wx, cur.wy, cur.wz, fx, fz, cur.depth, 0.0, kind);
      const vR = pushWaterVert(cur.wx + nx * ribHw, cur.wy - 0.025, cur.wz + nz * ribHw, fx, fz, cur.depth, 1.0, kind);
      if (prevRow) {
        waterIdx.push(prevRow[0], vL, vC, prevRow[0], vC, prevRow[1]);
        waterIdx.push(prevRow[1], vC, vR, prevRow[1], vR, prevRow[2]);
      }
      prevRow = [vL, vC, vR];
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
    plan, town, roads, parcelAt, places, seat, inlandWater, herds,
    // Who mans the seat, by the model's own roll on the board's day: its port's posts are manned from it (js/crew.js).
    watch: seat.watch ? { ...seat.watch, place: seat.name, day: board.day ?? 0 } : null,
    // For the GPU, which stamps the country onto the ground's own colours: the furlong of every cell, each
    // furlong's use, and every way that runs across it.
    stamp: {
      size, index, uses, roads, streets, squares, lots, town: urban, lanes: board.lanes, rivers: board.rivers.map((river) => river.points),
      origin: { x: ox, z: oz }, span: region.span,
    },
  };
}
