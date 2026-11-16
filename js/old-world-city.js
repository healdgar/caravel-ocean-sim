// An Old World city laid out on the ground its people need, by the procedures of Castle and
// Commons (healdgar's medieval kingdom simulator, MIT): streets walked along the lie of the
// land, back lanes branching wherever there is room and joining what they meet, houses built
// lot by lot along every frontage, squares, a wall drawn round the old town with gates where
// the roads cross it, a castle on the height and churches on the main streets.
//
// The plan is made once, when the land is built, and never per frame. What it hands on is a
// list of blocks (twelve numbers each) that the land renderer draws as instances of one mesh,
// the streets as ways for the paving field, and answers about any point of ground: house,
// street, square, garden or yard, and whether a tree may stand there. Each house, church,
// tower and gate is also given its type, a building written in Cairn
// (js/old-world-buildings.js), which the renderer draws in place of the block close to.
import { CITY_CHURCH, CITY_BUILDING_TYPES, CITY_CURTAIN, CITY_GATE, CITY_HALL, CITY_STOREY_M, CITY_TYPE, CITY_TYPED_ROOF, cityHousePick, cityHouseType } from './old-world-buildings.js';

export const CITY_BLOCK_FLOATS = 12;
export const CITY_ROOF = Object.freeze({ GABLE: 0, HIP: 1, PYRAMID: 2, FLAT: 3 });
// Wall materials are the land shader's building kinds: 19 is a house wall with its windows.
export const CITY_WALL = Object.freeze({ HOUSE: 19, STUCCO: 12, ASHLAR: 11 });
export const CITY_GROUND = Object.freeze({ YARD: 0, STREET: 1, SQUARE: 2, HOUSE: 3, PARK: 4, CASTLE: 5 });
export const CITY_TREES = Object.freeze({ NONE: 0, SQUARE: 1, PARK: 2, YARD: 3 });

const STRIDE_M = 8;
const TURNS = [-0.3, -0.15, 0, 0.15, 0.3];
const PLACE_RAYS = 24;
const WALL_RAYS = 144;
const WALL_HEIGHT_M = CITY_CURTAIN.height;
const WALL_THICK_M = CITY_CURTAIN.thick;

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A grid of lists: what lies near a point, without asking everything.
export function makeHash(cell) {
  const cells = new Map(), key = (i, j) => (i + 32768) * 65536 + (j + 32768);
  return {
    add(item, x0, z0, x1, z1) {
      for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
        const k = key(i, j); let list = cells.get(k); if (!list) cells.set(k, list = []); list.push(item);
      }
    },
    // Calls fn on each thing near; stops and answers true as soon as fn does.
    some(x, z, r, fn) {
      for (let j = Math.floor((z - r) / cell); j <= Math.floor((z + r) / cell); j++) for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++) {
        const list = cells.get(key(i, j));
        if (list) for (let n = 0; n < list.length; n++) if (fn(list[n]) === true) return true;
      }
      return false;
    },
  };
}

export function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

function segsCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz, den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den, u = ((cx - ax) * rz - (cz - az) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [ax + rx * t, az + rz * t] : null;
}

// A footprint is a box on the ground: centre, width across its local x, depth along its local
// z, and the cosine and sine of its turn. Local to world as the port's buildings have it:
// x + lx*c + lz*s, z - lx*s + lz*c.
export function footprint(x, z, w, d, yaw) { return { x, z, w, d, yaw, c: Math.cos(yaw), s: Math.sin(yaw) }; }
export function rectDist(f, px, pz) {
  const dx = px - f.x, dz = pz - f.z, lx = Math.abs(dx * f.c - dz * f.s) - f.w / 2, lz = Math.abs(dx * f.s + dz * f.c) - f.d / 2;
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
}
export function segRectDist(f, ax, az, bx, bz) {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
  let best = Infinity;
  for (let i = 0; i <= n && best > 0; i++) best = Math.min(best, rectDist(f, ax + (bx - ax) * i / n, az + (bz - az) * i / n));
  return best;
}
function overlap(a, b, gap) {
  const dx = b.x - a.x, dz = b.z - a.z, ha = a.w / 2 + gap, da = a.d / 2 + gap, hb = b.w / 2, db = b.d / 2;
  const cc = Math.abs(a.c * b.c + a.s * b.s), ss = Math.abs(a.s * b.c - a.c * b.s);
  return !(Math.abs(dx * a.c - dz * a.s) > ha + hb * cc + db * ss || Math.abs(dx * a.s + dz * a.c) > da + hb * ss + db * cc ||
    Math.abs(dx * b.c - dz * b.s) > hb + ha * cc + da * ss || Math.abs(dx * b.s + dz * b.c) > db + ha * ss + da * cc);
}
export const cityFootprintsOverlap = overlap;
export function local(f, lx, lz) { return [f.x + lx * f.c + lz * f.s, f.z - lx * f.s + lz * f.c]; }

export function resampleCityLine(pts, step) {
  const out = [pts[0]];
  let need = step;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], L = Math.hypot(bx - ax, bz - az);
    let t = need;
    while (t <= L) { out.push([ax + (bx - ax) * t / L, az + (bz - az) * t / L]); t += step; }
    need = t - L;
  }
  const last = pts[pts.length - 1], tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.3) out.push(last); else out[out.length - 1] = last;
  return out;
}

// An open place: ground bounded by a ring of radii, one to each bearing.
function placeRadius(p, x, z) {
  const a = Math.atan2(z - p.z, x - p.x) / (2 * Math.PI) * PLACE_RAYS, i = Math.floor(a), f = a - i;
  const r0 = p.rad[((i % PLACE_RAYS) + PLACE_RAYS) % PLACE_RAYS], r1 = p.rad[(((i + 1) % PLACE_RAYS) + PLACE_RAYS) % PLACE_RAYS];
  return r0 + (r1 - r0) * f;
}
function placeHit(p, x, z, pad) {
  const d = Math.hypot(x - p.x, z - p.z);
  return d < p.R + pad && d < placeRadius(p, x, z) + pad;
}

/**
 * The masons. How a plan's blocks and typed buildings are stood on ground that is not level, and how a wall, its
 * towers and its gates are built of them. `gates` are the openings a curtain leaves ({x, z, half}); `keep` marks
 * a footprint as taken; `rr` answers a number from 0 to 1.
 */
export function cityMasonry({ heightAt, blocks, typed, typedTypes, typedBlocks, gates, keep, rr }) {
  /* ---- how a block stands on ground that is not level: its floor at the height of its
     street side, its walls carried down to the lowest corner ---- */
  const seatBlock = (f, front = null) => {
    const hw = f.w / 2, hd = f.d / 2;
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const [lx, lz] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) { const [x, z] = local(f, lx, lz), h = heightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h; }
    const floor = front === null ? sum / 4 : Math.max(lo, Math.min(hi, front));
    return { floor, plinth: floor - lo + 0.7, range: hi - lo };
  };
  const pushBlock = (f, wallH, roofH, roof, wallKind, tone, base = null) => {
    const { floor, plinth } = base ?? seatBlock(f);
    blocks.push(f.x, floor, f.z, f.yaw, f.w, f.d, wallH, roofH, roof, wallKind, tone, plinth);
    return floor;
  };
  // A building of a Cairn type: where it stands and how it is turned, and how far its type is
  // stretched across, up and along to fill the plan's footprint. The blocks pushed just before
  // it are its own (`own` of them): they stand in for it far off, and go when it is shot down.
  const pushTyped = (type, x, floor, z, yaw, across, up, along, tone, own = 1) => {
    const T = CITY_BUILDING_TYPES[type];
    typed.push(x, floor, z, yaw, across / T.width, up / T.height, along / T.length, tone);
    typedTypes.push(type);
    typedBlocks.push(blocks.length / CITY_BLOCK_FLOATS - own, own);
  };

  /* ---- the wall and the castle, built of blocks ---- */
  const curtain = (ax, az, bx, bz, out, height, tone) => {
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 11)), ux = (bx - ax) / L, uz = (bz - az) / L, yaw = Math.atan2(ux, uz);
    for (let i = 0; i < n; i++) {
      const mx = ax + (bx - ax) * (i + 0.5) / n, mz = az + (bz - az) * (i + 0.5) / n, len = L / n;
      if (gates.some((q) => Math.hypot(q.x - mx, q.z - mz) < q.half + len / 2)) continue;
      const f = footprint(mx, mz, WALL_THICK_M, len + 0.5, yaw), base = seatBlock(f);
      pushBlock(f, height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, tone, base);
      keep(f);
      // Merlons along the outward edge.
      const side = (-uz * out[0] + ux * out[1]) >= 0 ? 1 : -1, ox = -uz * side * 0.8, oz = ux * side * 0.8, count = Math.floor(len / (2 * CITY_CURTAIN.merlon));
      for (let m = 0; m < count; m++) {
        const t = (m + 0.5) / count - 0.5;
        blocks.push(mx + ux * len * t + ox, base.floor + height, mz + uz * len * t + oz, yaw, CITY_CURTAIN.parapet, CITY_CURTAIN.merlon, CITY_CURTAIN.rise, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, tone, 0);
      }
      // Close to, a length of the wall's own type, its parapet turned outward.
      const type = len + 0.5 < (CITY_CURTAIN.short + CITY_CURTAIN.long) / 2 ? CITY_TYPE.CURTAIN_SHORT : CITY_TYPE.CURTAIN_LONG;
      pushTyped(type, mx, base.floor, mz, side > 0 ? yaw : yaw + Math.PI, WALL_THICK_M, height, len + 0.5, tone, 1 + count);
    }
  };
  const tower = (x, z, side, height, tone, type = CITY_TYPE.WALL_TOWER) => {
    const f = footprint(x, z, side, side, rr() * 0.3);
    const floor = pushBlock(f, height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, tone);
    pushTyped(type, x, floor, z, f.yaw, side, height, side, tone);
    keep(f);
  };
  // A gate in a wall running along (ux, uz): a tower to either side and an arched passage under a chamber between
  // them. Far off, the chamber alone.
  const gate = (q, ux, uz) => {
    for (const s of [-1, 1]) tower(q.x + ux * s * (q.half + 3.2), q.z + uz * s * (q.half + 3.2), 5.6, 13.5, 0.92);
    const span = 2 * q.half + 0.8, floor = heightAt(q.x, q.z);
    blocks.push(q.x, floor + CITY_GATE.passage, q.z, Math.atan2(ux, uz), CITY_GATE.thick, span, CITY_GATE.chamber, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, 0.9, 0);
    pushTyped(CITY_TYPE.GATE, q.x, floor, q.z, Math.atan2(-uz, ux), span, CITY_GATE.passage + CITY_GATE.chamber, CITY_GATE.thick, 0.9);
  };
  return { seatBlock, pushBlock, pushTyped, curtain, tower, gate };
}

/**
 * Lay a city out. heightAt, urbanAt (0..1, the town where at least a half), earlyAt (0 the
 * first ground built on, 1 the last, below 0 outside) and inlandAt (metres from water) answer
 * for any point. Roads are polylines running in from the country to the waterfront. Obstacles
 * are the port's own buildings, ways its streets as the paving field has them.
 */
export function layOldWorldCity({ heightAt, urbanAt, earlyAt, inlandAt, seat, roads = [], obstacles = [], ways = [], people = 0, bounds, lattice = 16 }) {
  const started = typeof performance === 'object' ? performance.now() : 0;
  const rr = mulberry((Math.round(seat.x * 7.3) * 73856093) ^ (Math.round(seat.z * 5.1) * 19349663) ^ 0x51ed270b);
  const streets = [], places = [], gates = [], blocks = [], lots = [], typed = [], typedTypes = [], typedBlocks = [];
  const segs = makeHash(24), solids = makeHash(32), placed = makeHash(16), wallSegs = makeHash(32), laneEnds = makeHash(40), spurEnds = makeHash(160);
  const churches = [];

  const ground = (x, z) => x > bounds.x0 + 8 && x < bounds.x1 - 8 && z > bounds.z0 + 8 && z < bounds.z1 - 8 && urbanAt(x, z) >= 0.5 && heightAt(x, z) > 1.0;
  const inPlace = (x, z, pad) => { for (const p of places) if (placeHit(p, x, z, pad)) return p; return null; };
  const addStreet = (pts, hw, kind, paved) => {
    if (pts.length < 2) return null;
    const st = { pts, hw, kind, paved, id: streets.length };
    streets.push(st);
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      segs.add({ ax, az, bx, bz, hw, st }, Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw);
    }
    return st;
  };
  // The nearest street whose edge lies within pad.
  const nearStreet = (x, z, pad, skip) => {
    let best = null, bd = pad;
    segs.some(x, z, pad + 6, (g) => { if (g.st === skip) return; const d = segDist(x, z, g.ax, g.az, g.bx, g.bz) - g.hw; if (d < bd) { bd = d; best = g; } });
    return best;
  };
  const streetEdge = (x, z, reach) => {
    let bd = reach;
    segs.some(x, z, reach + 6, (g) => { const d = segDist(x, z, g.ax, g.az, g.bx, g.bz) - g.hw; if (d < bd) bd = d; });
    return bd;
  };
  const hitsSolid = (ax, az, bx, bz, hw) => solids.some((ax + bx) / 2, (az + bz) / 2, Math.hypot(bx - ax, bz - az) / 2 + hw + 2, (o) => segRectDist(o, ax, az, bx, bz) < hw + 0.6);
  const crossesWall = (ax, az, bx, bz) => wallSegs.some((ax + bx) / 2, (az + bz) / 2, STRIDE_M, (g) => segsCross(ax, az, bx, bz, g.ax, g.az, g.bx, g.bz) !== null || segDist(bx, bz, g.ax, g.az, g.bx, g.bz) < 7);
  for (const o of obstacles) {
    const f = { x: o.x, z: o.z, w: o.w + 2, d: o.d + 2, c: o.c, s: o.s }, r = Math.hypot(f.w, f.d) / 2;
    solids.add(f, f.x - r, f.z - r, f.x + r, f.z + r);
  }

  /* ---- a street walked along the lie of the land: eight metres at a time, the easiest of five
     headings, stopping at water, walls and the town's edge and joining any street it comes to ---- */
  const walk = (x, z, hd, maxLen, skip, hw, { straight = 1, cross = false, join = true, shore = 0 } = {}) => {
    const pts = [];
    let L = 0;
    while (L < maxLen) {
      let best = null, bc = 1e9;
      const h0 = heightAt(x, z);
      for (const d of TURNS) {
        const h2 = hd + d, nx = x + Math.cos(h2) * STRIDE_M, nz = z + Math.sin(h2) * STRIDE_M;
        if (!ground(nx, nz) || inPlace(nx, nz, 3) || (!cross && (hitsSolid(x, z, nx, nz, hw) || crossesWall(x, z, nx, nz)))) continue;
        const cost = Math.abs(d) * 0.6 * straight + Math.abs(heightAt(nx, nz) - h0) * 0.5 + rr() * 0.15 + (shore ? Math.abs(inlandAt(nx, nz) - shore) * 0.12 : 0);
        if (cost < bc) { bc = cost; best = [nx, nz, h2]; }
      }
      if (!best) break;
      [x, z, hd] = best; L += STRIDE_M; pts.push([x, z]);
      if (join && L > 16) {
        const g = nearStreet(x, z, 9, skip);
        if (g) {
          const dx = g.bx - g.ax, dz = g.bz - g.az, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - g.ax) * dx + (z - g.az) * dz) / l2));
          pts.push([g.ax + dx * t, g.az + dz * t]);
          return { pts, joined: true };
        }
        const g2 = nearStreet(x, z, 22, skip); // running alongside another street: turn in and meet it
        if (g2) hd = Math.atan2((g2.az + g2.bz) / 2 - z, (g2.ax + g2.bx) / 2 - x);
      }
    }
    return { pts, joined: false };
  };

  /* ---- branching: every street offers a start each twenty metres, to either side. A lane is
     begun only where there is room for it: open town ground thirty metres out with no street
     near, and no other lane leaving the parent close by. It leaves square to its parent, give
     or take, and each start is tried once ---- */
  const tried = new Set();
  const branch = (parents, { ends, spacing, endSpacing, room, length, hw, kind, paved, straightLate = 1 }) => {
    const starts = [];
    for (const st of parents) {
      if (st.kind === 'port' && st.hw < 2) continue;
      const pts = st.starts ??= resampleCityLine(st.pts, 20);
      const offer = (i, side, px, pz, tx, tz, ahead) => {
        const key = (st.id * 4096 + i) * 4 + side + 1 + (kind === 'lane' ? 0 : 2 ** 40);
        if (!tried.has(key)) starts.push({ px, pz, st, side, key, tx, tz, ahead, k: Math.hypot(px - seat.x, pz - seat.z) + rr() * 60 });
      };
      for (let i = 1; i < pts.length - 1; i++) {
        const [px, pz] = pts[i], a = pts[i - 1], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        for (const side of [-1, 1]) offer(i, side, px, pz, (b[0] - a[0]) / L, (b[1] - a[1]) / L, false);
      }
      // A lane that ended in open ground may be carried on from its end.
      if (st.kind === 'lane' && !st.joined && pts.length > 1) {
        const [px, pz] = pts[pts.length - 1], a = pts[pts.length - 2], L = Math.hypot(px - a[0], pz - a[1]) || 1;
        offer(pts.length - 1, 0, px, pz, (px - a[0]) / L, (pz - a[1]) / L, true);
      }
    }
    starts.sort((a, b) => a.k - b.k);
    const made = [];
    for (const o of starts) {
      const early = earlyAt(o.px, o.pz), near = early >= 0 && early < 0.35 ? 0.8 : 1;
      const nx = o.ahead ? o.tx : -o.tz * o.side, nz = o.ahead ? o.tz : o.tx * o.side, out = o.st.hw + room;
      // Room: open ground out to the side, and no street already serving it.
      if (!ground(o.px + nx * out, o.pz + nz * out) || inPlace(o.px + nx * out, o.pz + nz * out, 6) || nearStreet(o.px + nx * out, o.pz + nz * out, room * 0.72 * near, null) ||
        nearStreet(o.px + nx * (o.st.hw + room * 0.5), o.pz + nz * (o.st.hw + room * 0.5), room * 0.25, o.st)) { tried.add(o.key); continue; }
      if (!o.ahead && ends.some(o.px, o.pz, spacing, (e) => e.st !== o.st && Math.hypot(e.x - o.px, e.z - o.pz) < (e.first ? spacing : endSpacing) * near)) continue;
      tried.add(o.key);
      const late = early > 0.62, straight = late ? straightLate : 1;
      const hd = Math.atan2(nz, nx) + (rr() - 0.5) * (late && straightLate > 1 ? 0.12 : 0.5);
      const len = length[0] + rr() * length[1], off = o.st.hw + 2;
      const mx = o.px + Math.cos(hd) * off, mz = o.pz + Math.sin(hd) * off;
      if (!ground(mx, mz) || inPlace(mx, mz, 3) || nearStreet(mx, mz, 0.5, o.st) || hitsSolid(o.px, o.pz, mx, mz, hw) || crossesWall(o.px, o.pz, mx, mz)) continue;
      const r = walk(mx, mz, hd, len, o.st, hw, { straight });
      if (r.pts.length < 4 && !r.joined) continue;
      const lane = [[o.px, o.pz], [mx, mz], ...r.pts], end = lane[lane.length - 1];
      const laid = addStreet(lane, hw, kind, paved(o.px, o.pz));
      laid.joined = r.joined;
      made.push(laid);
      ends.add({ x: o.px, z: o.pz, first: true, st: laid }, o.px, o.pz, o.px, o.pz);
      ends.add({ x: end[0], z: end[1], first: false, st: laid }, end[0], end[1], end[0], end[1]);
    }
    return made;
  };

  /* ---- the streets that are there before any lane: the port's own, the roads in from the
     country, the way along the waterfront ---- */
  for (const way of ways) {
    const pts = way.points.map((p) => [p[0], p[1]]);
    if (pts.length < 2) continue;
    addStreet(resampleCityLine(pts, STRIDE_M), Math.max(1.5, (way.points[0][2] || 3) / 2), 'port', way.points[0][3] ?? 1);
  }
  const mains = [];
  for (const road of roads) {
    let first = road.findIndex(([x, z]) => ground(x, z));
    if (first < 0) continue;
    first = Math.max(0, first - 1);
    const st = addStreet(resampleCityLine(road.slice(first), STRIDE_M), 3.4, 'road', 1);
    if (st) mains.push(st);
  }
  {
    // The quay street: found near the seat a stone's throw from the water, and walked both ways.
    let start = null, bd = 1e9;
    for (let j = -12; j <= 12; j++) for (let i = -12; i <= 12; i++) {
      const x = seat.x + i * 12, z = seat.z + j * 12, inl = inlandAt(x, z);
      if (!ground(x, z) || inl < 12 || inl > 26) continue;
      const d = Math.hypot(i, j); if (d < bd) { bd = d; start = [x, z]; }
    }
    if (start) {
      const e = 6, gx = inlandAt(start[0] + e, start[1]) - inlandAt(start[0] - e, start[1]), gz = inlandAt(start[0], start[1] + e) - inlandAt(start[0], start[1] - e);
      const along = Math.atan2(gz, gx) + Math.PI / 2;
      const a = walk(start[0], start[1], along, 2600, null, 3.6, { cross: true, join: false, shore: 17 }).pts;
      const b = walk(start[0], start[1], along + Math.PI, 2600, null, 3.6, { cross: true, join: false, shore: 17 }).pts;
      const st = addStreet([...b.reverse(), start, ...a], 3.6, 'quay', 1);
      if (st) mains.push(st);
    }
  }

  /* ---- open places: a great square on the first road a few hundred metres in, a small one
     wherever two roads meet ---- */
  const openPlace = (x, z, rx, rz, ang, kind) => {
    const rad = new Float32Array(PLACE_RAYS);
    let R = 0;
    for (let k = 0; k < PLACE_RAYS; k++) {
      const a = k / PLACE_RAYS * 2 * Math.PI, ca = Math.cos(a - ang), sa = Math.sin(a - ang);
      let r = (rx * rz) / Math.hypot(rz * ca, rx * sa) * (0.9 + 0.2 * rr());
      // Bounded by the first water or cliff along the ray.
      for (let t = 6; t < r; t += 6) if (!ground(x + Math.cos(a) * t, z + Math.sin(a) * t)) { r = t - 3; break; }
      rad[k] = Math.max(4, r); R = Math.max(R, rad[k]);
    }
    const place = { x, z, rad, R, kind, rx, rz, ang };
    places.push(place);
    return place;
  };
  if (mains.length && mains[0].kind === 'road') {
    const pts = mains[0].pts;
    let arc = 0;
    for (let i = pts.length - 1; i > 0; i--) {
      arc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (arc > 420 && ground(pts[i][0], pts[i][1]) && !hitsSolid(pts[i][0] - 40, pts[i][1], pts[i][0] + 40, pts[i][1], 30)) {
        const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
        const big = Math.sqrt(Math.max(1, people) / 100000);
        openPlace(pts[i][0], pts[i][1], 34 + 34 * big, 22 + 20 * big, a, 'square');
        break;
      }
    }
  }
  for (const st of mains.slice(1)) {
    if (st.kind !== 'road') continue;
    const [x, z] = st.pts[st.pts.length - 1];
    if (ground(x, z) && !inPlace(x, z, 60) && Math.hypot(x - seat.x, z - seat.z) > 160) openPlace(x, z, 15 + rr() * 6, 12 + rr() * 5, rr() * Math.PI, 'square');
  }

  /* ---- the long streets off the roads and the quay, laid before the wall so that each has its gate ---- */
  const cobbledOldTown = (x, z) => { const e = earlyAt(x, z); return e >= 0 && e < 0.55 ? 1 : 0.5; };
  const spurs = branch([...mains, ...streets.filter((s) => s.kind === 'port')], { ends: spurEnds, spacing: 150, endSpacing: 90, room: 70, length: [280, 620], hw: 2.8, kind: 'street', paved: () => 1, straightLate: 1.6 });
  mains.push(...spurs);

  /* ---- the castle: the highest ground of the old town, if it stands well above the waterfront ---- */
  let castle = null;
  {
    const base = heightAt(seat.x, seat.z);
    let best = null, bs = -1e9;
    for (let z = seat.z - 1400; z <= seat.z + 1400; z += 28) for (let x = seat.x - 1400; x <= seat.x + 1400; x += 28) {
      if (!ground(x, z)) continue;
      const e = earlyAt(x, z); if (e < 0 || e > 0.55) continue;
      const h = heightAt(x, z), score = h - 0.012 * Math.hypot(x - seat.x, z - seat.z);
      if (h < base + 28 || score <= bs) continue;
      if (nearStreet(x, z, 64, null) || inPlace(x, z, 70)) continue;
      // A summit, not a hillside: nothing higher close by.
      let top = true;
      for (let k = 0; k < 8 && top; k++) if (heightAt(x + Math.cos(k * Math.PI / 4) * 45, z + Math.sin(k * Math.PI / 4) * 45) > h + 1.5) top = false;
      if (top) { bs = score; best = [x, z]; }
    }
    if (best) castle = openPlace(best[0], best[1], 58, 58, 0, 'castle');
  }

  /* ---- the wall: round the old town, the part first built on. From the old town's middle a
     ray goes out each two and a half degrees to the last old ground; the line through their
     ends, eased, is the wall. Water guards its own side. ---- */
  const wall = { pts: [], centre: null };
  const wallShare = people > 40000 ? 0.4 : 0.65;
  {
    let sx = 0, sz = 0, sn = 0;
    for (let z = bounds.z0; z <= bounds.z1; z += 24) for (let x = bounds.x0; x <= bounds.x1; x += 24) {
      const e = earlyAt(x, z);
      if (e >= 0 && e <= wallShare && ground(x, z)) { sx += x; sz += z; sn++; }
    }
    if (sn * 576 > 5e4) {
      const cx = sx / sn, cz = sz / sn;
      let rad = new Float32Array(WALL_RAYS);
      for (let k = 0; k < WALL_RAYS; k++) {
        const a = k / WALL_RAYS * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
        let last = 0;
        for (let r = 12; r < 3200; r += 6) {
          const x = cx + ca * r, z = cz + sa * r, e = earlyAt(x, z);
          if (e >= 0 && e <= wallShare && ground(x, z)) last = r; else if (r - last > 70) break;
        }
        rad[k] = last + 10;
      }
      for (let pass = 0; pass < 2; pass++) {
        const next = new Float32Array(WALL_RAYS);
        for (let k = 0; k < WALL_RAYS; k++) next[k] = (rad[(k + WALL_RAYS - 1) % WALL_RAYS] + 2 * rad[k] + rad[(k + 1) % WALL_RAYS]) / 4;
        rad = next;
      }
      wall.centre = [cx, cz];
      for (let k = 0; k < WALL_RAYS; k++) {
        const a = k / WALL_RAYS * 2 * Math.PI, x = cx + Math.cos(a) * rad[k], z = cz + Math.sin(a) * rad[k];
        const dry = x > bounds.x0 + 20 && x < bounds.x1 - 20 && z > bounds.z0 + 20 && z < bounds.z1 - 20 && heightAt(x, z) > 1.4 && inlandAt(x, z) > 20;
        const f = footprint(x, z, 6, 6, 0);
        const open = !dry || (castle && placeHit(castle, x, z, 6)) || solids.some(x, z, 12, (o) => overlap(f, o, 2));
        wall.pts.push({ x, z, open });
      }
      for (let k = 0; k < WALL_RAYS; k++) {
        const a = wall.pts[k], b = wall.pts[(k + 1) % WALL_RAYS];
        if (a.open || b.open) continue;
        wallSegs.add({ ax: a.x, az: a.z, bx: b.x, bz: b.z, k }, Math.min(a.x, b.x) - 8, Math.min(a.z, b.z) - 8, Math.max(a.x, b.x) + 8, Math.max(a.z, b.z) + 8);
      }
      // A gate wherever a street laid before the wall crosses its line.
      for (const st of streets) for (let i = 1; i < st.pts.length; i++) {
        const [ax, az] = st.pts[i - 1], [bx, bz] = st.pts[i];
        wallSegs.some((ax + bx) / 2, (az + bz) / 2, STRIDE_M, (g) => {
          const at = segsCross(ax, az, bx, bz, g.ax, g.az, g.bx, g.bz);
          if (at && !gates.some((q) => Math.hypot(q.x - at[0], q.z - at[1]) < 24)) gates.push({ x: at[0], z: at[1], half: st.hw + 1.8, k: g.k });
        });
      }
    }
  }

  /* ---- the masons: blocks seated on the ground, the wall and the castle built of them ---- */
  const keep = (f, r = Math.hypot(f.w, f.d) / 2) => solids.add(f, f.x - r, f.z - r, f.x + r, f.z + r);
  const { seatBlock, pushBlock, pushTyped, curtain, tower, gate } = cityMasonry({ heightAt, blocks, typed, typedTypes, typedBlocks, gates, keep, rr });
  if (wall.centre) {
    let since = 40;
    for (let k = 0; k < WALL_RAYS; k++) {
      const a = wall.pts[k], b = wall.pts[(k + 1) % WALL_RAYS], prev = wall.pts[(k + WALL_RAYS - 1) % WALL_RAYS];
      if (a.open) { since = 60; continue; }
      const nearGate = gates.some((q) => Math.hypot(q.x - a.x, q.z - a.z) < q.half + 9);
      if (!nearGate && (since >= 56 || prev.open || b.open)) { tower(a.x, a.z, 6.2, 12 + rr() * 1.5, 0.86 + rr() * 0.12); since = 0; }
      if (b.open) continue;
      curtain(a.x, a.z, b.x, b.z, [a.x - wall.centre[0], a.z - wall.centre[1]], WALL_HEIGHT_M, 0.84 + rr() * 0.1);
      since += Math.hypot(b.x - a.x, b.z - a.z);
    }
    for (const q of gates) {
      const a = wall.pts[q.k], b = wall.pts[(q.k + 1) % WALL_RAYS], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      gate(q, (b.x - a.x) / L, (b.z - a.z) / L);
    }
  }
  if (castle) {
    const n = 10, ring = [];
    for (let k = 0; k < n; k++) {
      const a = (k + 0.5 * rr()) / n * 2 * Math.PI, r = 44 + rr() * 9;
      ring.push([castle.x + Math.cos(a) * r, castle.z + Math.sin(a) * r]);
    }
    for (let k = 0; k < n; k++) {
      const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % n];
      if (heightAt(ax, az) > 1.4 && heightAt(bx, bz) > 1.4) curtain(ax, az, bx, bz, [ax - castle.x, az - castle.z], 9.5, 0.9);
      tower(ax, az, 7, 13.5 + rr() * 2, 0.92);
    }
    const turn = rr() * Math.PI;
    tower(castle.x + Math.cos(turn) * 14, castle.z + Math.sin(turn) * 14, 13, 21, 0.95, CITY_TYPE.KEEP);
    const hall = footprint(castle.x - Math.cos(turn) * 13, castle.z - Math.sin(turn) * 13, CITY_HALL.width, CITY_HALL.depth, turn + 0.4);
    const hallFloor = pushBlock(hall, CITY_HALL.height, CITY_HALL.roof, CITY_ROOF.HIP + CITY_TYPED_ROOF, CITY_WALL.HOUSE, 0.9); keep(hall);
    pushTyped(CITY_TYPE.HALL, hall.x, hallFloor, hall.z, hall.yaw, CITY_HALL.width, CITY_HALL.height, CITY_HALL.depth, 0.9);
  }

  /* ---- whether a footprint may be built: on dry town ground, off every street and open
     place, clear of the wall and of whatever stands already ---- */
  const fits = (f, gap) => {
    const hw = f.w / 2, hd = f.d / 2;
    let lo = Infinity, hi = -Infinity;
    for (const [lx, lz] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [0, 0], [0, -hd], [0, hd], [-hw, 0], [hw, 0]]) {
      const [x, z] = local(f, lx, lz);
      if (!ground(x, z) || inPlace(x, z, 1.2)) return false;
      const h = heightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (hi - lo > 5.5) return false;
    const r = Math.hypot(hw, hd);
    if (segs.some(f.x, f.z, r + 6, (g) => segRectDist(f, g.ax, g.az, g.bx, g.bz) < g.hw + 0.3)) return false;
    if (wallSegs.some(f.x, f.z, r + 8, (g) => segRectDist(f, g.ax, g.az, g.bx, g.bz) < 6)) return false;
    if (solids.some(f.x, f.z, r + 2, (o) => overlap(f, o, 0.8))) return false;
    return !placed.some(f.x, f.z, r + gap, (o) => overlap(f, o, gap));
  };
  const occupy = (f) => { const r = Math.hypot(f.w, f.d) / 2; placed.add(f, f.x - r, f.z - r, f.x + r, f.z + r); lots.push(f); };

  /* ---- churches, on the main streets and well apart, the first and greatest nearest the seat ---- */
  {
    const want = Math.max(2, Math.min(34, Math.round(people / 3200)));
    const sites = [];
    for (const st of mains) {
      const pts = resampleCityLine(st.pts, 26);
      for (let i = 1; i < pts.length - 1; i++) {
        const [mx, mz] = pts[i], L = Math.hypot(pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1]) || 1;
        const ux = (pts[i + 1][0] - pts[i - 1][0]) / L, uz = (pts[i + 1][1] - pts[i - 1][1]) / L;
        for (const side of [-1, 1]) sites.push({ mx, mz, px: -uz * side, pz: ux * side, hw: st.hw, k: rr() });
      }
    }
    const first = castle ? [(seat.x + castle.x) / 2, (seat.z + castle.z) / 2] : [seat.x, seat.z];
    const byFirst = [...sites].sort((a, b) => Math.hypot(a.mx - first[0], a.mz - first[1]) - Math.hypot(b.mx - first[0], b.mz - first[1]));
    sites.sort((a, b) => a.k - b.k);
    for (const c of [...byFirst.slice(0, 60), ...sites]) {
      if (churches.length >= want) break;
      if (churches.some((q) => Math.hypot(q.x - c.mx, q.z - c.mz) < 200)) continue;
      // A church is its type stretched a little: the parish churches differ in size, not in kind.
      const great = churches.length === 0, C = great ? CITY_CHURCH.great : CITY_CHURCH.parish;
      const w = great ? C.width : 9.5 + rr() * 3, d = great ? C.depth : 22 + rr() * 10, h = great ? C.height : 9.5 + rr() * 3;
      const across = w / C.width, along = d / C.depth, up = h / C.height, tw = C.tower * across, td = C.tower * along;
      const set = c.hw + 3 + d / 2, yaw = Math.atan2(c.px, c.pz);
      const nave = footprint(c.mx + c.px * set, c.mz + c.pz * set, w, d, yaw);
      if (!fits(footprint(nave.x, nave.z, w + 2 * tw + 1, d, yaw), 2.5)) continue;
      const base = seatBlock(nave, heightAt(c.mx, c.mz)), tone = 0.94 + rr() * 0.06;
      pushBlock(nave, h, (0.42 * C.width / 2 + 0.6) * up, CITY_ROOF.GABLE + CITY_TYPED_ROOF, great ? CITY_WALL.ASHLAR : CITY_WALL.STUCCO, tone, base);
      const sides = great ? [-1, 1] : [rr() < 0.5 ? -1 : 1];
      for (const side of sides) {
        const [tx, tz] = local(nave, side * (w / 2 + tw / 2 - 0.3 * across), -d / 2 + td / 2);
        const t = footprint(tx, tz, tw, td, yaw), top = seatBlock(t);
        blocks.push(tx, base.floor, tz, yaw, tw, td, (C.height + CITY_CHURCH.towerRise) * up, CITY_CHURCH.spire * up, CITY_ROOF.PYRAMID + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, 0.93, Math.max(top.plinth, base.floor - top.floor + top.plinth));
      }
      pushTyped(great ? CITY_TYPE.CHURCH_GREAT : sides[0] < 0 ? CITY_TYPE.CHURCH_LEFT : CITY_TYPE.CHURCH_RIGHT, nave.x, base.floor, nave.z, yaw, w, h, d, tone, 1 + sides.length);
      const whole = footprint(nave.x, nave.z, w + 2 * tw, d, yaw);
      keep(whole); occupy(whole);
      churches.push({ x: nave.x, z: nave.z, great });
    }
  }

  /* ---- walled gardens in the later town: a convent's cerca, a great house's orchard ---- */
  {
    const want = Math.round(people / 14000);
    const tries = [];
    for (let z = bounds.z0 + lattice; z < bounds.z1; z += 56) for (let x = bounds.x0 + lattice; x < bounds.x1; x += 56) {
      const e = earlyAt(x, z);
      if (e > 0.5 && ground(x, z)) tries.push([x + (rr() - 0.5) * 30, z + (rr() - 0.5) * 30, rr()]);
    }
    tries.sort((a, b) => a[2] - b[2]);
    let made = 0;
    for (const [x, z] of tries) {
      if (made >= want) break;
      const r = 26 + rr() * 18;
      if (!ground(x, z) || nearStreet(x, z, r + 6, null) || inPlace(x, z, r + 180)) continue;
      if (solids.some(x, z, r + 6, (o) => rectDist(o, x, z) < r + 4) || wallSegs.some(x, z, r + 10, (g) => segDist(x, z, g.ax, g.az, g.bx, g.bz) < r + 8)) continue;
      let dry = true;
      for (let k = 0; k < 8 && dry; k++) dry = ground(x + Math.cos(k * Math.PI / 4) * r, z + Math.sin(k * Math.PI / 4) * r);
      if (!dry) continue;
      openPlace(x, z, r, r * (0.7 + rr() * 0.3), rr() * Math.PI, 'park');
      made++;
    }
  }

  /* ---- back lanes, round after round, each round branching from the streets the last one made ---- */
  for (let round = 0; round < 24; round++) {
    if (!branch(streets, { ends: laneEnds, spacing: 30, endSpacing: 14, room: 32, length: [40, 120], hw: 2, kind: 'lane', paved: cobbledOldTown, straightLate: 2.2 }).length) break;
  }

  /* ---- houses, lot by lot along each side of every street: shoulder to shoulder in the old
     town, with yards between toward the edge ---- */
  let houses = 0;
  const TINTS = [0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 4];
  const buildLot = (mx, mz, ux, uz, side, st) => {
    const px = -uz * side, pz = ux * side;
    let e = earlyAt(mx + px * 8, mz + pz * 8); if (e < 0) e = 1;
    const central = e < 0.3, late = e > 0.62, main = st.kind !== 'lane';
    const front = central ? 5.2 + rr() * 2 : late ? 6 + rr() * 3.2 : 5.4 + rr() * 2.4;
    const depth = central ? 11 + rr() * 4 : late ? 8 + rr() * 3.5 : 10 + rr() * 4;
    const gap = central ? 0.08 : late ? (rr() < 0.45 ? 0.12 : 0.5 + rr() * 2.4) : rr() < 0.75 ? 0.1 : 0.4 + rr();
    const set = st.hw + (central ? 0.5 : 0.9) + depth / 2;
    const f = footprint(mx + px * set, mz + pz * set, front, depth, Math.atan2(px, pz));
    if (!fits(f, gap)) return 0;
    occupy(f);
    // Most of an Iberian port of the sixteenth century stood one to three floors. Four were the merchants' houses
    // on the main streets of its middle, and five the tallest of those (the Rua Nova's "three, four and even five").
    const high = rr(), trade = (central || late) && main ? rr() : 1;
    const storeys = central ? 2 + (high < 0.6 ? 1 : 0) + (trade < 0.3 ? 1 : 0) + (trade < 0.07 && high < 0.6 ? 1 : 0)
      : late ? 1 + (high < 0.4 ? 1 : 0) + (trade < 0.12 ? 1 : 0) : 1 + (high < 0.8 ? 1 : 0) + (high < 0.22 ? 1 : 0);
    const wallH = storeys * CITY_STOREY_M + rr() * 0.5, base = seatBlock(f, heightAt(mx, mz));
    const tone = TINTS[Math.floor(rr() * TINTS.length)] + 0.2 + 0.75 * rr();
    const eaves = rr() < 0.74, type = cityHouseType(storeys, eaves, cityHousePick(f.x, f.z)), T = CITY_BUILDING_TYPES[type], up = wallH / T.height;
    if (eaves) {
      // Eaves to the street: the ridge runs along it, the gables are party walls.
      pushBlock(footprint(f.x, f.z, depth, front, f.yaw + Math.PI / 2), wallH, 0.36 * T.length / 2 * up, CITY_ROOF.GABLE + CITY_TYPED_ROOF, CITY_WALL.HOUSE, tone, base);
    } else {
      pushBlock(f, wallH, 0.5 * T.width / 2 * up, CITY_ROOF.GABLE + CITY_TYPED_ROOF, CITY_WALL.HOUSE, tone, base);
    }
    pushTyped(type, f.x, base.floor, f.z, f.yaw, front, wallH, depth, tone);
    houses++;
    return front + gap;
  };
  const frontage = (st) => {
    for (const side of [-1, 1]) {
      let carry = 2 + rr() * 2;
      for (let i = 1; i < st.pts.length; i++) {
        const [ax, az] = st.pts[i - 1], [bx, bz] = st.pts[i], L = Math.hypot(bx - ax, bz - az);
        if (L < 1e-6) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L;
        let t = carry;
        while (t < L) {
          const took = buildLot(ax + ux * t, az + uz * t, ux, uz, side, st);
          t += took ? took : 2.2;
        }
        carry = t - L;
      }
    }
  };
  const order = { port: 0, road: 1, quay: 2, street: 3, lane: 4 };
  for (const st of [...streets].sort((a, b) => order[a.kind] - order[b.kind] || a.id - b.id)) frontage(st);

  /* ---- what any point of the town's ground is ---- */
  const houseNear = (x, z, reach) => placed.some(x, z, reach, (o) => rectDist(o, x, z) <= reach);
  const groundAt = (x, z) => {
    if (houseNear(x, z, 0)) return CITY_GROUND.HOUSE;
    if (streetEdge(x, z, 1) <= 0.4) return CITY_GROUND.STREET;
    const p = inPlace(x, z, 0);
    return p ? (p.kind === 'park' ? CITY_GROUND.PARK : p.kind === 'castle' ? CITY_GROUND.CASTLE : CITY_GROUND.SQUARE) : CITY_GROUND.YARD;
  };
  // Where a tree may stand in the town: round a square, in a walled garden, in a back yard.
  const treesAt = (x, z) => {
    const p = inPlace(x, z, 0);
    if (p) {
      if (p.kind === 'castle' || streetEdge(x, z, 5) < 4) return CITY_TREES.NONE;
      if (p.kind === 'park') return houseNear(x, z, 3) ? CITY_TREES.NONE : CITY_TREES.PARK;
      const ring = Math.hypot(x - p.x, z - p.z) / placeRadius(p, x, z);
      return ring > 0.66 && ring < 0.92 ? CITY_TREES.SQUARE : CITY_TREES.NONE;
    }
    const e = earlyAt(x, z);
    if (e < 0.4 || streetEdge(x, z, 4) < 3.5 || houseNear(x, z, 3.2) || !houseNear(x, z, 24)) return CITY_TREES.NONE;
    if (wallSegs.some(x, z, 8, (g) => segDist(x, z, g.ax, g.az, g.bx, g.bz) < 6) || solids.some(x, z, 6, (o) => rectDist(o, x, z) < 4)) return CITY_TREES.NONE;
    return CITY_TREES.YARD;
  };

  // Trees the town plants on purpose: a ring of shade round each square, an orchard in each
  // walled garden, set out by the pace and not by chance.
  const standing = [];
  for (const p of places) {
    if (p.kind === 'square') {
      const around = Math.max(8, Math.round(2 * Math.PI * 0.8 * (p.rx + p.rz) / 2 / 9.5));
      for (let k = 0; k < around; k++) {
        const a = k / around * 2 * Math.PI, far = p.rad[Math.round(a / (2 * Math.PI) * PLACE_RAYS) % PLACE_RAYS] * 0.8;
        const x = p.x + Math.cos(a) * far, z = p.z + Math.sin(a) * far;
        if (treesAt(x, z) === CITY_TREES.SQUARE) standing.push([x, z]);
      }
    } else if (p.kind === 'park') {
      for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) {
        const x = p.x + (i + (j & 1) * 0.5) * 8.5, z = p.z + j * 7.4;
        if (placeHit(p, x, z, -4) && treesAt(x, z) === CITY_TREES.PARK) standing.push([x, z]);
      }
    }
  }

  // The streets and squares as the paving field takes them: points of x, z, width and surface.
  const paving = [];
  for (const st of streets) if (st.kind !== 'port') paving.push({ points: st.pts.map(([x, z]) => [x, z, st.hw * 2, st.paved]) });
  for (const p of places) {
    if (p.kind !== 'square') continue;
    const minor = Math.min(p.rx, p.rz), major = Math.max(p.rx, p.rz), a = p.rx >= p.rz ? p.ang : p.ang + Math.PI / 2, reach = Math.max(0.5, major - minor);
    paving.push({ points: [[p.x - Math.cos(a) * reach, p.z - Math.sin(a) * reach, minor * 2, 1], [p.x + Math.cos(a) * reach, p.z + Math.sin(a) * reach, minor * 2, 1]] });
  }

  const count = blocks.length / CITY_BLOCK_FLOATS;
  return {
    blocks: new Float32Array(blocks), count, houses, streets, places, wall, gates, castle, churches, lots, paving, standing,
    typed: new Float32Array(typed), typedTypes: new Uint32Array(typedTypes), typedCount: typedTypes.length,
    // For each typed building, its first block and how many blocks are its own.
    typedBlocks: new Uint32Array(typedBlocks),
    groundAt, treesAt,
    stats: {
      blocks: count, typed: typedTypes.length, houses, streets: streets.length, churches: churches.length, gates: gates.length,
      lanes: streets.filter((s) => s.kind === 'lane').length,
      streetMetres: Math.round(streets.reduce((sum, st) => { let L = 0; for (let i = 1; i < st.pts.length; i++) L += Math.hypot(st.pts[i][0] - st.pts[i - 1][0], st.pts[i][1] - st.pts[i - 1][1]); return sum + L; }, 0)),
      squares: places.filter((p) => p.kind === 'square').length, parks: places.filter((p) => p.kind === 'park').length,
      milliseconds: typeof performance === 'object' ? performance.now() - started : 0,
    },
  };
}

function hashColonialSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/**
 * Street-first topography-, shoreline-, hydrology-, and polity-driven colonial urban plan:
 * - 'spanish' (*Leyes de Indias* *traza*): harbour *Calle de la Marina*, bench-sited *Plaza Mayor*,
 *   and terrain-conforming *damero* grid (*quadras* ~64–82 m) clipped/warped around bluffs & rivers.
 * - 'portuguese' (*Cidade Baixa / Cidade Alta*): contour-following *Rua da Ribeira* + switchback
 *   *ladeira* streets climbing to an elevated bluff *Largo da Sé* & ridge spine.
 * - 'timber' (North European Tidewater): organic wharf lane + ridge main street + cross lanes.
 */
export function planColonialStreets({
  region,
  heights,
  heightAt,
  riverHits,
  shoreCrossAt,
  frameToWorld,
  bearingRad,
  stage = 'settlement',
  expansionTier = 0,
  manner = 'spanish',
}) {
  const seedKey = `${region.id || `${(region.latitude ?? 0).toFixed(4)},${(region.longitude ?? 0).toFixed(4)}`}:${manner}`;
  const rr = mulberry(hashColonialSeed(seedKey));
  const slopeAt = (x, z) => Math.hypot(heightAt(x + 6, z) - heightAt(x - 6, z), heightAt(x, z + 6) - heightAt(x, z - 6)) / 12;
  const dryAt = (x, z, pad = 5) => {
    const h = heightAt(x, z);
    return Number.isFinite(h) && h >= 1.15 && h <= 68 && !riverHits(x, z, pad);
  };

  // Sample smoothed local shoreline contour across [-150..150] m along shore
  const shorePts = [];
  for (let a = -150; a <= 150; a += 15) {
    const c = shoreCrossAt(a);
    shorePts.push({ along: a, cross: Number.isFinite(c) ? c : 0 });
  }
  const shoreAt = (along) => {
    const u = Math.max(0, Math.min(shorePts.length - 1.001, (along + 150) / 15));
    const i = Math.floor(u), f = u - i;
    return shorePts[i].cross * (1 - f) + shorePts[i + 1].cross * f;
  };

  // Estimate local shoreline tangent tilt from shore contour
  const shoreSlope = (shoreAt(45) - shoreAt(-45)) / 90;
  const gridTilt = Math.max(-0.22, Math.min(0.22, Math.atan(shoreSlope) + (rr() - 0.5) * 0.10));
  const gridYaw = bearingRad + gridTilt;
  const inX = Math.sin(gridYaw), inZ = -Math.cos(gridYaw);
  const alX = Math.cos(gridYaw), alZ = Math.sin(gridYaw);

  const streets = [];
  const pushStreet = (pts, hw, kind = 'street', paved = 0.85) => {
    const clean = [];
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      if (!dryAt(x, z, 4.2) || slopeAt(x, z) > 0.24) {
        if (clean.length >= 2) streets.push({ pts: resampleCityLine(clean, 8), hw, kind, paved });
        clean.length = 0;
        continue;
      }
      if (!clean.length || Math.hypot(x - clean[clean.length - 1][0], z - clean[clean.length - 1][1]) > 1.5) {
        clean.push([x, z]);
      }
    }
    if (clean.length >= 2) streets.push({ pts: resampleCityLine(clean, 8), hw, kind, paved });
  };

  // 1. Waterfront quay / Ribeira / Water Street following actual harbour contour
  const quaySpan = stage === 'outpost' ? 68 : stage === 'settlement' ? 98 : stage === 'fortified-port' ? 124 : 142;
  const wfPts = [];
  for (let a = -quaySpan; a <= quaySpan; a += 14) {
    const inOff = shoreAt(a) + (manner === 'timber' ? 20 : 19);
    const p = frameToWorld(a, inOff);
    wfPts.push([p.x, p.z]);
  }
  pushStreet(wfPts, manner === 'timber' ? 3.2 : 4.2, 'quay', stage === 'outpost' ? 0.35 : 0.92);

  // 2. Site Plaza Mayor / Cidade Alta Largo / Tidewater Market Green from real terrain relief
  let plazaAlong = (rr() - 0.5) * 24;
  let plazaInland = manner === 'portuguese' ? 98 : manner === 'timber' ? 68 : 78;
  let bestScore = -Infinity;
  const inMin = manner === 'portuguese' ? 70 : 44;
  const inMax = manner === 'portuguese' ? 156 : 128;
  for (let a = -54; a <= 54; a += 12) {
    for (let d = inMin; d <= inMax; d += 12) {
      const p = frameToWorld(a, shoreAt(a) + d);
      if (!dryAt(p.x, p.z, 16)) continue;
      const h = heightAt(p.x, p.z);
      const sl = slopeAt(p.x, p.z);
      if (sl > (manner === 'portuguese' ? 0.21 : 0.19)) continue;
      const elevTerm = manner === 'portuguese'
        ? Math.min(14, h * 0.85) - sl * 28
        : -sl * 38 - Math.abs(h - 4.2) * 0.45 - Math.abs(d - 78) * 0.03;
      const jitter = ( (((Math.imul(a + 97, 73856093) ^ Math.imul(d + 31, 19349663)) >>> 0) % 1000) / 1000 ) * 0.65;
      const sc = elevTerm - Math.abs(a) * 0.025 + jitter;
      if (sc > bestScore) {
        bestScore = sc;
        plazaAlong = a;
        plazaInland = shoreAt(a) + d;
      }
    }
  }
  const plazaCenter = frameToWorld(plazaAlong, plazaInland);
  const plazaW = manner === 'timber' ? 28 : stage === 'outpost' ? 32 : 42;
  const plazaD = manner === 'timber' ? 24 : stage === 'outpost' ? 28 : 36;

  const quadraW = Math.round(64 + rr() * 18);
  const quadraD = Math.round(62 + rr() * 16);
  const solares = [];
  const pushSolarSlot = (x, z, yaw, kind = 'solar', rank = 1) => {
    if (!dryAt(x, z, 7) || slopeAt(x, z) > 0.22) return;
    if (Math.hypot(x - plazaCenter.x, z - plazaCenter.z) < Math.max(plazaW, plazaD) * 0.46) return;
    solares.push({ x, z, yaw, kind, rank });
  };

  if (manner === 'portuguese') {
    // Portuguese Ultramar: Cidade Baixa Ribeira + diagonal contour-climbing Ladeiras + Cidade Alta spine
    const baixaA = frameToWorld(plazaAlong - 34, shoreAt(plazaAlong - 34) + 20);
    const baixaB = frameToWorld(plazaAlong + 34, shoreAt(plazaAlong + 34) + 20);
    const midBend1 = frameToWorld(plazaAlong - 8 + (rr() - 0.5) * 14, (shoreAt(plazaAlong) + 20 + plazaInland) * 0.52);
    const midBend2 = frameToWorld(plazaAlong + 14 + (rr() - 0.5) * 14, (shoreAt(plazaAlong) + 20 + plazaInland) * 0.56);
    const altaW = { x: plazaCenter.x - alX * (plazaW * 0.56), z: plazaCenter.z - alZ * (plazaW * 0.56) };
    const altaE = { x: plazaCenter.x + alX * (plazaW * 0.56), z: plazaCenter.z + alZ * (plazaW * 0.56) };
    pushStreet([[baixaA.x, baixaA.z], [midBend1.x, midBend1.z], [altaW.x, altaW.z]], 3.4, 'street', 0.9);
    pushStreet([[baixaB.x, baixaB.z], [midBend2.x, midBend2.z], [altaE.x, altaE.z]], 3.4, 'street', 0.9);

    // Cidade Alta ridge spine street following hill crest
    const spineReach = stage === 'outpost' ? 58 : stage === 'settlement' ? 96 : 138 + expansionTier * 8;
    const ridgePts = [];
    for (let s = -spineReach; s <= spineReach; s += 16) {
      let bestR = 0, bestH = -Infinity;
      for (const off of [-14, -7, 0, 7, 14]) {
        const tx = plazaCenter.x + alX * s + inX * off;
        const tz = plazaCenter.z + alZ * s + inZ * off;
        const th = heightAt(tx, tz);
        if (dryAt(tx, tz, 6) && slopeAt(tx, tz) <= 0.20 && th > bestH) { bestH = th; bestR = off; }
      }
      ridgePts.push([plazaCenter.x + alX * s + inX * bestR, plazaCenter.z + alZ * s + inZ * bestR]);
    }
    pushStreet(ridgePts, 3.8, 'street', 0.92);
    if (stage !== 'outpost') {
      const backD = quadraD * 0.82;
      const backPts = ridgePts.map(([x, z]) => [x + inX * backD, z + inZ * backD]);
      pushStreet(backPts, 3.1, 'lane', 0.78);
      for (const s of [-quadraW, 0, quadraW]) {
        pushStreet([
          [plazaCenter.x + alX * s - inX * (plazaD * 0.55), plazaCenter.z + alZ * s - inZ * (plazaD * 0.55)],
          [plazaCenter.x + alX * s + inX * (backD + 18), plazaCenter.z + alZ * s + inZ * (backD + 18)],
        ], 3.0, 'lane', 0.8);
      }
    }
  } else if (manner === 'timber') {
    // North European Tidewater: organic main street from wharf/palisade inland + cross lanes
    const mainReach = stage === 'outpost' ? 78 : stage === 'settlement' ? 118 : 156 + expansionTier * 8;
    const mainAlong = (rr() - 0.5) * 18;
    const mainPts = [];
    let drift = mainAlong;
    for (let d = 18; d <= mainReach; d += 16) {
      let bestTurn = 0, bestSl = Infinity;
      for (const stepA of [-5, 0, 5]) {
        const cand = frameToWorld(drift + stepA, shoreAt(drift + stepA) + d);
        const sl = slopeAt(cand.x, cand.z);
        if (dryAt(cand.x, cand.z, 5) && sl < bestSl) { bestSl = sl; bestTurn = stepA; }
      }
      drift += bestTurn * 0.65;
      const p = frameToWorld(drift, shoreAt(drift) + d);
      mainPts.push([p.x, p.z]);
    }
    pushStreet(mainPts, 3.3, 'street', stage === 'outpost' ? 0.25 : 0.65);
    const crossDists = stage === 'outpost' ? [54] : stage === 'settlement' ? [48, 86] : [46, 82, 118, 148];
    const crossSpan = stage === 'outpost' ? 48 : stage === 'settlement' ? 78 : 108;
    for (const cd of crossDists) {
      const cPts = [];
      for (let a = -crossSpan; a <= crossSpan; a += 16) {
        const p = frameToWorld(a, shoreAt(a) + cd + Math.sin(a * 0.03 + cd) * 4);
        cPts.push([p.x, p.z]);
      }
      pushStreet(cPts, 2.8, 'lane', stage === 'citadel-metropolis' ? 0.65 : 0.3);
    }
  } else {
    // Spanish Indies (*Leyes de Indias* *traza*): orthogonal *damero* grid warped gently around contours
    const colsHalf = stage === 'outpost' ? 1 : stage === 'settlement' ? 2 : stage === 'fortified-port' ? 2 : 3;
    const rowsIn = stage === 'outpost' ? 1 : stage === 'settlement' ? 2 : stage === 'fortified-port' ? 3 : 3;
    const warpPt = (uAlong, vIn) => {
      const bx = plazaCenter.x + alX * uAlong + inX * vIn;
      const bz = plazaCenter.z + alZ * uAlong + inZ * vIn;
      const gx = (heightAt(bx + 8, bz) - heightAt(bx - 8, bz)) / 16;
      const gz = (heightAt(bx, bz + 8) - heightAt(bx, bz - 8)) / 16;
      const sl = Math.hypot(gx, gz);
      const shift = sl > 0.08 ? Math.min(6.5, (sl - 0.08) * 32) : 0;
      return [bx - (sl > 1e-4 ? (gx / sl) * shift : 0), bz - (sl > 1e-4 ? (gz / sl) * shift : 0)];
    };
    const alongStations = [];
    for (let ci = -colsHalf; ci <= colsHalf; ci++) {
      if (ci === 0) {
        alongStations.push(-plazaW * 0.56, plazaW * 0.56);
      } else {
        const sign = Math.sign(ci);
        alongStations.push(sign * (plazaW * 0.56 + (Math.abs(ci) - 1) * quadraW + quadraW));
      }
    }
    const inStations = [-plazaD * 0.56, plazaD * 0.56];
    for (let ri = 1; ri <= rowsIn; ri++) inStations.push(plazaD * 0.56 + ri * quadraD);
    // Seaward connector avenues from harbour quay to Plaza Mayor
    const seaBack = -Math.max(24, plazaInland - shoreAt(plazaAlong) - 18);
    for (const u of alongStations) {
      const pts = [];
      for (let v = seaBack; v <= inStations[inStations.length - 1] + 12; v += 14) {
        pts.push(warpPt(u, v));
      }
      pushStreet(pts, Math.abs(u) < plazaW ? 4.0 : 3.3, 'street', stage === 'outpost' ? 0.45 : 0.9);
    }
    for (const v of inStations) {
      const spanU = alongStations[alongStations.length - 1] + 12;
      const pts = [];
      for (let u = -spanU; u <= spanU; u += 14) {
        pts.push(warpPt(u, v));
      }
      pushStreet(pts, Math.abs(v) < plazaD ? 4.0 : 3.3, 'street', stage === 'outpost' ? 0.45 : 0.9);
    }
  }

  // Harvest street-fronting *solar* candidate sites along traced streets (ordered from plaza/quay outward)
  for (const st of streets) {
    for (let i = 1; i < st.pts.length; i += 2) {
      const [ax, az] = st.pts[i - 1], [bx, bz] = st.pts[i];
      const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
      if (L < 5) continue;
      const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
      const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      for (const side of [-1, 1]) {
        if (st.kind === 'quay' && (nx * side * inX + nz * side * inZ) < 0) continue; // never place buildings on the water side of the quay street
        const sx = mx + nx * side * (st.hw + 10.5);
        const sz = mz + nz * side * (st.hw + 10.5);
        const faceYaw = Math.atan2(-(nx * side), -(nz * side)) + Math.PI * 0.5;
        const dPlaza = Math.hypot(sx - plazaCenter.x, sz - plazaCenter.z);
        pushSolarSlot(sx, sz, faceYaw, st.kind === 'quay' ? 'waterfront' : 'solar', dPlaza);
      }
    }
  }
  solares.sort((a, b) => a.rank - b.rank);

  // Smoothly grade ONLY the street ribbons & Plaza Mayor / Largo court into `heights` (zero rectangular slab!)
  if (heights && region?.size > 1) {
    const n = region.size, span = region.span, step = span / (n - 1);
    const x0 = region.x - span * 0.5, z0 = region.z - span * 0.5;
    // Grade Plaza court gently toward its natural mean
    const plazaMeanY = Math.max(2.2, heightAt(plazaCenter.x, plazaCenter.z));
    const pr = Math.max(plazaW, plazaD) * 0.72 + step;
    const pi0 = Math.max(1, Math.floor((plazaCenter.x - pr - x0) / step));
    const pi1 = Math.min(n - 2, Math.ceil((plazaCenter.x + pr - x0) / step));
    const pj0 = Math.max(1, Math.floor((plazaCenter.z - pr - z0) / step));
    const pj1 = Math.min(n - 2, Math.ceil((plazaCenter.z + pr - z0) / step));
    for (let j = pj0; j <= pj1; j++) {
      const wz = z0 + j * step;
      for (let i = pi0; i <= pi1; i++) {
        const k = j * n + i;
        if (heights[k] < 1.35) continue;
        const wx = x0 + i * step;
        const dx = wx - plazaCenter.x, dz = wz - plazaCenter.z;
        const u = Math.abs(dx * alX + dz * alZ) / (plazaW * 0.62);
        const v = Math.abs(dx * inX + dz * inZ) / (plazaD * 0.62);
        const m = Math.max(u, v);
        if (m >= 1.25) continue;
        const t = m <= 0.75 ? 1 : 1 - ((m - 0.75) / 0.5);
        const w = t * t * (3 - 2 * t) * 0.78;
        const target = plazaMeanY + (dx * inX + dz * inZ) * 0.015;
        heights[k] = heights[k] * (1 - w) + target * w;
      }
    }
    // Grade street ribbons smoothly along their natural profile (strictly inland of foreshore/berth contours)
    for (const st of streets) {
      if (st.kind === 'quay') continue;
      const pts = st.pts;
      const targetY = pts.map(([x, z]) => Math.max(1.6, heightAt(x, z)));
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 1; k < targetY.length - 1; k++) targetY[k] = (targetY[k - 1] + 2 * targetY[k] + targetY[k + 1]) * 0.25;
      }
      const band = st.hw + 4.5;
      for (let s = 1; s < pts.length; s++) {
        const [ax, az] = pts[s - 1], [bx, bz] = pts[s];
        const i0 = Math.max(1, Math.floor((Math.min(ax, bx) - band - x0) / step));
        const i1 = Math.min(n - 2, Math.ceil((Math.max(ax, bx) + band - x0) / step));
        const j0 = Math.max(1, Math.floor((Math.min(az, bz) - band - z0) / step));
        const j1 = Math.min(n - 2, Math.ceil((Math.max(az, bz) + band - z0) / step));
        const dx = bx - ax, dz = bz - az, l2 = Math.max(1e-6, dx * dx + dz * dz);
        for (let j = j0; j <= j1; j++) {
          const wz = z0 + j * step;
          for (let i = i0; i <= i1; i++) {
            const k = j * n + i;
            if (heights[k] < 1.35) continue;
            const wx = x0 + i * step;
            const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / l2));
            const d = Math.hypot(wx - (ax + dx * t), wz - (az + dz * t));
            if (d >= band) continue;
            const u = d <= st.hw ? 1 : 1 - (d - st.hw) / (band - st.hw);
            const w = u * u * (3 - 2 * u) * 0.72;
            const wantY = targetY[s - 1] * (1 - t) + targetY[s] * t;
            heights[k] = heights[k] * (1 - w) + wantY * w;
          }
        }
      }
    }
  }

  // Civic frontage anchors directly on Plaza Mayor / Cidade Alta & Harbour Quay
  const civicEdge = (uMul, vMul, faceInwardYaw) => ({
    x: plazaCenter.x + alX * (uMul * (plazaW * 0.5 + 15)) + inX * (vMul * (plazaD * 0.5 + 15)),
    z: plazaCenter.z + alZ * (uMul * (plazaW * 0.5 + 15)) + inZ * (vMul * (plazaD * 0.5 + 15)),
    yaw: faceInwardYaw,
  });
  const aduanaAlong = Math.max(-28, Math.min(28, plazaAlong * 0.45));
  const waterfrontBase = shoreAt(aduanaAlong) + 32;

  return {
    rr,
    manner,
    gridYaw,
    alX,
    alZ,
    inX,
    inZ,
    quadraW,
    quadraD,
    quaySpan,
    shoreAt,
    plaza: { x: plazaCenter.x, z: plazaCenter.z, w: plazaW, d: plazaD, along: plazaAlong, inland: plazaInland },
    civic: {
      aduana: { ...frameToWorld(aduanaAlong, waterfrontBase), yaw: gridYaw },
      lonja: { ...frameToWorld(aduanaAlong - 26, waterfrontBase - 8), yaw: gridYaw + Math.PI * 0.5 },
      warehouse: { ...frameToWorld(aduanaAlong + 42, waterfrontBase + 2), yaw: gridYaw },
      arsenal: { ...frameToWorld(aduanaAlong + 76, waterfrontBase - 4), yaw: gridYaw },
      warehouse2: { ...frameToWorld(aduanaAlong - 64, waterfrontBase + 8), yaw: gridYaw },
      catedral: civicEdge(0, 1, gridYaw),
      chapel: civicEdge(-1, 0, gridYaw + Math.PI * 0.5),
      palacio: civicEdge(1, 0, gridYaw - Math.PI * 0.5),
      portales: civicEdge(0, -1, gridYaw + Math.PI),
    },
    streets,
    solares,
  };
}

/**
 * Subdivides colonial *quadra*, *ladeira*, and Tidewater street frontages into individual
 * physical Cairn lots + GPU `CITY_BLOCK_FLOATS` continuum blocks, and encloses fortified
 * colonial ports with a continuous landward bastioned *muralla* circuit pierced by gates
 * where streets cross (zero monolithic `colonial_town_block` and zero orphan floating walls).
 */
export function buildColonialCityFabric({
  plan,
  heightAt,
  riverHits,
  obstacles = [],
  stage = 'settlement',
  fortificationTier = 1,
  expansionTier = 0,
}) {
  const { rr, manner, gridYaw, alX, alZ, inX, inZ, plaza, streets, quaySpan, shoreAt } = plan;
  const blocks = [], typed = [], typedTypes = [], typedBlocks = [], gates = [];
  const segs = makeHash(24), solids = makeHash(24), placed = makeHash(16), wallSegs = makeHash(24);
  const keep = (f) => {
    const reach = Math.hypot(f.w, f.d) * 0.5;
    placed.add(f, f.x - reach, f.z - reach, f.x + reach, f.z + reach);
  };
  const { seatBlock, pushBlock, pushTyped, curtain, tower, gate } = cityMasonry({
    heightAt, blocks, typed, typedTypes, typedBlocks, gates, keep, rr,
  });

  for (const o of obstacles) {
    const f = footprint(o.x, o.z, (o.width ?? o.w ?? 12) + 2, (o.length ?? o.depth ?? o.d ?? 14) + 2, o.yaw ?? 0);
    const r = Math.hypot(f.w, f.d) * 0.5;
    solids.add(f, f.x - r, f.z - r, f.x + r, f.z + r);
  }
  for (const st of streets) {
    for (let i = 1; i < st.pts.length; i++) {
      const [ax, az] = st.pts[i - 1], [bx, bz] = st.pts[i];
      segs.add({ ax, az, bx, bz, hw: st.hw, st }, Math.min(ax, bx) - st.hw, Math.min(az, bz) - st.hw, Math.max(ax, bx) + st.hw, Math.max(az, bz) + st.hw);
    }
  }
  const inPlaza = (x, z, pad = 0) => {
    const dx = x - plaza.x, dz = z - plaza.z;
    return Math.abs(dx * alX + dz * alZ) < plaza.w * 0.5 + pad && Math.abs(dx * inX + dz * inZ) < plaza.d * 0.5 + pad;
  };

  // 1. Continuous landward bastioned *muralla* circuit on fortified colonial ports (Spanish & Portuguese)
  const buildWallCircuit = manner !== 'timber' && (fortificationTier >= 3 || stage === 'citadel-metropolis' || (stage === 'fortified-port' && expansionTier >= 1));
  if (buildWallCircuit) {
    const flankR = Math.min(168, quaySpan + 22 + expansionTier * 6);
    const landR = Math.min(205, (plaza.inland - shoreAt(plaza.along)) + (stage === 'citadel-metropolis' ? 102 : 82) + expansionTier * 5);
    const poly = [];
    const nArc = 6;
    for (let k = 0; k <= nArc; k++) {
      const t = k / nArc;
      const ang = Math.PI * (1 - t); // left shoreline flank -> landward crown -> right shoreline flank
      const u = Math.cos(ang) * flankR;
      const v = Math.sin(ang) * landR;
      const wx = plaza.x + alX * u + inX * (v - (plaza.inland - shoreAt(u) - 18) * (1 - Math.sin(ang)));
      const wz = plaza.z + alZ * u + inZ * (v - (plaza.inland - shoreAt(u) - 18) * (1 - Math.sin(ang)));
      poly.push([wx, wz]);
    }
    // Pierce arched gates wherever a street crosses the landward wall trace
    for (let i = 0; i < poly.length - 1; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 8) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      wallSegs.add({ ax, az, bx, bz }, Math.min(ax, bx) - 6, Math.min(az, bz) - 6, Math.max(ax, bx) + 6, Math.max(az, bz) + 6);
      for (const st of streets) {
        if (st.kind === 'quay') continue;
        for (let s = 1; s < st.pts.length; s++) {
          const hit = segsCross(ax, az, bx, bz, st.pts[s - 1][0], st.pts[s - 1][1], st.pts[s][0], st.pts[s][1]);
          if (hit && heightAt(hit[0], hit[1]) >= 1.25 && !riverHits(hit[0], hit[1], 6) && !gates.some((g) => Math.hypot(g.x - hit[0], g.z - hit[1]) < 24)) {
            const g = { x: hit[0], z: hit[1], half: 3.4, ux, uz };
            gates.push(g);
          }
        }
      }
    }
    for (const g of gates) {
      if (!solids.some(g.x, g.z, 12, (o) => rectDist(o, g.x, g.z) < 6)) gate(g, g.ux, g.uz);
    }
    // Emit projecting bastion / flanking towers at dry polygon vertices & continuous curtain chords between them
    for (let i = 0; i < poly.length; i++) {
      const [vx, vz] = poly[i];
      if (heightAt(vx, vz) >= 1.25 && !riverHits(vx, vz, 6) && !gates.some((g) => Math.hypot(g.x - vx, g.z - vz) < 12) && !solids.some(vx, vz, 12, (o) => rectDist(o, vx, vz) < 6)) {
        tower(vx, vz, i === 0 || i === poly.length - 1 ? 6.8 : 7.4, 8.8, 0.88);
      }
    }
    for (let i = 0; i < poly.length - 1; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[i + 1];
      const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      if (heightAt(ax, az) < 1.1 || heightAt(bx, bz) < 1.1 || riverHits(mx, mz, 5)) continue;
      if (solids.some(mx, mz, Math.hypot(bx - ax, bz - az) * 0.5 + 4, (o) => segRectDist(o, ax, az, bx, bz) < 4.5)) continue;
      const out = [mx - plaza.x, mz - plaza.z];
      const ol = Math.hypot(out[0], out[1]) || 1;
      curtain(ax, az, bx, bz, [out[0] / ol, out[1] / ol], 7.4, 0.86);
    }
  }

  // 2. Subdivide street frontages into individual procedural *solares* / Cairn burgher lots
  let houses = 0;
  const maxLots = stage === 'outpost' ? (manner === 'timber' ? 4 : 8) : stage === 'settlement' ? 26 : stage === 'fortified-port' ? 54 + expansionTier * 6 : 82 + expansionTier * 8;
  for (const st of streets) {
    if (houses >= maxLots) break;
    for (const side of [-1, 1]) {
      let carry = 2 + rr() * 3;
      for (let i = 1; i < st.pts.length && houses < maxLots; i++) {
        const [ax, az] = st.pts[i - 1], [bx, bz] = st.pts[i];
        const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
        if (L < 3) continue;
        const ux = dx / L, uz = dz / L, nx = -uz * side, nz = ux * side;
        if (st.kind === 'quay' && (nx * inX + nz * inZ) < 0) continue;
        let t = carry;
        while (t < L && houses < maxLots) {
          const w = (manner === 'timber' ? 8.0 : 9.2) + rr() * 5.8;
          const d = (manner === 'timber' ? 10.5 : 11.8) + rr() * 6.4;
          const gap = manner === 'timber' ? 1.8 + rr() * 2.4 : 0.45 + rr() * 0.85;
          if (t + w * 0.5 > L) break;
          const fx = ax + ux * (t + w * 0.5) + nx * (st.hw + 0.8 + d * 0.5);
          const fz = az + uz * (t + w * 0.5) + nz * (st.hw + 0.8 + d * 0.5);
          const lotYaw = Math.atan2(nx, nz);
          const f = footprint(fx, fz, w, d, lotYaw);
          const h = heightAt(fx, fz);
          const base = seatBlock(f, heightAt(ax + ux * (t + w * 0.5), az + uz * (t + w * 0.5)));
          const clear =
            h >= 1.25 &&
            base.range <= 3.8 &&
            !riverHits(fx, fz, Math.max(w, d) * 0.6) &&
            !inPlaza(fx, fz, 2.5) &&
            !solids.some(fx, fz, (w + d) * 0.6 + 4, (o) => overlap(f, o, 1.4)) &&
            !placed.some(fx, fz, (w + d) * 0.6 + 2, (o) => overlap(f, o, 0.35)) &&
            !segs.some(fx, fz, (w + d) * 0.5 + 5, (g) => g.st !== st && segDist(fx, fz, g.ax, g.az, g.bx, g.bz) < g.hw + Math.min(w, d) * 0.45) &&
            !wallSegs.some(fx, fz, 12, (g) => segDist(fx, fz, g.ax, g.az, g.bx, g.bz) < 7.5);
          if (clear) {
            const dPlaza = Math.hypot(fx - plaza.x, fz - plaza.z);
            const rich = dPlaza < 85 || st.kind === 'quay';
            const storeys = stage === 'outpost' ? 1 : (rich && rr() < 0.68 ? 2 : rr() < 0.28 ? 2 : 1);
            const wallH = storeys * CITY_STOREY_M + (rich ? 0.55 : 0.15) + rr() * 0.45;
            const eaves = manner !== 'timber' || rr() < 0.55;
            const type = manner === 'timber'
              ? cityHouseType(storeys, false, cityHousePick(fx, fz))
              : cityHouseType(storeys, eaves, cityHousePick(fx, fz));
            const T = CITY_BUILDING_TYPES[type], up = wallH / T.height;
            const rise = eaves ? 0.36 * T.length * 0.5 * up : 0.5 * T.width * 0.5 * up;
            const tone = manner === 'timber' ? 0.28 + rr() * 0.32 : 0.52 + rr() * 0.42;
            const wallKind = manner === 'timber' ? CITY_WALL.HOUSE : (rich ? CITY_WALL.STUCCO : CITY_WALL.HOUSE);
            const blockFp = eaves ? footprint(fx, fz, d, w, lotYaw + Math.PI * 0.5) : f;
            const floor = pushBlock(blockFp, wallH, rise, CITY_ROOF.GABLE + CITY_TYPED_ROOF, wallKind, tone, base);
            pushTyped(type, fx, floor, fz, lotYaw, w, wallH, d, tone, 1);
            keep(f);
            houses++;
          }
          t += w + gap;
        }
        carry = Math.max(0, t - L);
      }
    }
  }

  const paving = streets.map((st) => ({ points: st.pts.map(([x, z]) => [x, z, st.hw * 2, st.paved]) }));
  paving.push({
    points: [
      [plaza.x - alX * (plaza.w * 0.45), plaza.z - alZ * (plaza.w * 0.45), plaza.d, stage === 'outpost' ? 0.45 : 0.95],
      [plaza.x + alX * (plaza.w * 0.45), plaza.z + alZ * (plaza.w * 0.45), plaza.d, stage === 'outpost' ? 0.45 : 0.95],
    ],
  });

  const count = blocks.length / CITY_BLOCK_FLOATS;
  return {
    blocks: new Float32Array(blocks),
    count,
    houses,
    streets,
    gates,
    paving,
    typed: new Float32Array(typed),
    typedTypes: new Uint32Array(typedTypes),
    typedCount: typedTypes.length,
    typedBlocks: new Uint32Array(typedBlocks),
    stats: { blocks: count, typed: typedTypes.length, houses, streets: streets.length, gates: gates.length },
  };
}
