// What a city plan is made of, and the masons who stand it. Every town is its board's (Castle and
// Commons' own generator, js/old-world-board.js): an Old World city, a town of the peoples of the
// Americas, or a town Spain or Portugal planted. The plan is made once, when the land is built, and
// never per frame: a list of blocks (twelve numbers each), the plots buildings stand on, which trees
// and grass keep off; the streets as ways for the paving field; and answers about any point of
// ground: house, street, square, garden or yard, and whether a tree may stand there.
// Each house, church, tower and gate is a building of a type written in Cairn (js/old-world-buildings.js),
// stood at its own size and drawn by the one continuum (js/city-continuum-draw.js).
import { CITY_BASTION, CITY_BUILDING_TYPES, CITY_CURTAIN, CITY_GATE, CITY_TYPE, CITY_TYPED_ROOF, cityVariant } from './old-world-buildings.js';
import { WORKS_FENCE } from './old-world-works.js';

export const CITY_BLOCK_FLOATS = 12;
export const CITY_ROOF = Object.freeze({ GABLE: 0, HIP: 1, PYRAMID: 2, FLAT: 3 });
// Wall materials are the land shader's building kinds: 19 is a house wall with its windows.
export const CITY_WALL = Object.freeze({ HOUSE: 19, STUCCO: 12, ASHLAR: 11 });
export const CITY_GROUND = Object.freeze({ YARD: 0, STREET: 1, SQUARE: 2, HOUSE: 3, PARK: 4, CASTLE: 5 });
export const CITY_TREES = Object.freeze({ NONE: 0, SQUARE: 1, PARK: 2, YARD: 3 });

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

/**
 * The masons. How a plan's blocks and typed buildings are stood on ground that is not level, and how a wall, its
 * towers and its gates are built of them. `gates` are the openings a curtain leaves ({x, z}); `keep` marks a footprint
 * as taken; `rr` answers a number from 0 to 1. Every building is stood at its type's own size (js/old-world-buildings.js
 * cityVariant chooses the size of its family that fits its plot): nothing is stretched.
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
  // A building of a Cairn type, at its own size: where it stands, how it is turned, and its tone. The blocks pushed
  // just before it are its plot's (`own` of them), which keep trees and grass off it and go when it is shot down.
  const pushTyped = (type, x, floor, z, yaw, tone, own = 1) => {
    typed.push(x, floor, z, yaw, tone);
    typedTypes.push(type);
    typedBlocks.push(blocks.length / CITY_BLOCK_FLOATS - own, own);
  };
  // The type of `type`'s family that fits plot `f` (`up` high, if asked), and the ground it stands on within it: the
  // middle of its front, and back from the street as far as the plot's own front (`front`) or in the plot's middle.
  const fit = (type, f, front = false, up = null) => {
    const id = cityVariant(type, f.w, f.d, up), T = CITY_BUILDING_TYPES[id], [x, z] = local(f, 0, front ? (T.length - f.d) / 2 : 0);
    return { type: id, T, at: footprint(x, z, T.width, T.length, f.yaw) };
  };

  /* ---- a run of a modular work: a wall, a fence, a palisade ---- */
  // The sections of a run from a to b of a work built in units of `unit` metres, a section of so many of them as
  // `counts` has (in steps of one, from the least): as many units in all as the run is long, or as covers it and
  // `past` beyond each end (`cover`), or as near that as a whole unit comes; each section no longer than lets it stand
  // on its own ground within `sink` of it at either end, where the ground falls along the run. Each is
  // { x, z, yaw, units, half, ux, uz }: its middle, its turn (+z along the run), and its half-length.
  const sections = (ax, az, bx, bz, { unit, counts, past = 0, cover = false, sink = 0.25 }) => {
    const L = Math.hypot(bx - ax, bz - az), out = [];
    if (L < 1e-3) return out;
    const ux = (bx - ax) / L, uz = (bz - az) / L, yaw = Math.atan2(ux, uz), least = counts[0], most = counts[counts.length - 1];
    const units = Math.max(least, cover ? Math.ceil((L + 2 * past) / unit - 1e-6) : Math.round((L + 2 * past) / unit));
    let fall = 0;
    for (let k = 0, n = Math.max(1, Math.ceil(L / 2)); k < n; k++) {
      const h0 = heightAt(ax + (bx - ax) * k / n, az + (bz - az) * k / n), h1 = heightAt(ax + (bx - ax) * (k + 1) / n, az + (bz - az) * (k + 1) / n);
      fall = Math.max(fall, Math.abs(h1 - h0) * n / L);
    }
    const longest = Math.max(2 * least - 1, Math.min(most, Math.floor(2 * sink / Math.max(1e-3, fall) / unit)));
    const n = Math.ceil(units / longest), each = Math.floor(units / n), extra = units % n;
    let at = (L - units * unit) / 2;
    for (let i = 0; i < n; i++) {
      const count = each + (i < extra ? 1 : 0), half = count * unit / 2, mid = at + half;
      out.push({ x: ax + ux * mid, z: az + uz * mid, yaw, units: count, half, ux, uz });
      at += 2 * half;
    }
    return out;
  };
  // Where a section stands on its run: the higher of its ends' mean and a little below its middle, so that neither end
  // hangs over a hollow.
  const seatRun = ({ x, z, half, ux, uz }) => Math.max(0.5 * (heightAt(x - ux * half, z - uz * half) + heightAt(x + ux * half, z + uz * half)), heightAt(x, z) - 0.22);
  // A field fence from a to b, of rails or dry stone (js/old-world-works.js WORKS_FENCE): its panels or courses laid in
  // sections where `clear(x, z, half)` lets each stand, each rail section owning the post at its start and a post
  // ending every stretch of them. Answers how many sections it laid.
  const fence = (ax, az, bx, bz, stone, { tone = 0.5, clear = () => true } = {}) => {
    const type = stone ? CITY_TYPE.FENCE_STONE : CITY_TYPE.FENCE_RAIL;
    const list = sections(ax, az, bx, bz, stone ? { unit: WORKS_FENCE.course, counts: WORKS_FENCE.courses, past: 0.35 } : { unit: WORKS_FENCE.panel, counts: WORKS_FENCE.panels });
    let laid = 0, open = null;
    const post = () => { if (open) pushTyped(CITY_TYPE.FENCE_POST, open[0], heightAt(open[0], open[1]), open[1], open[2], tone, 0); open = null; };
    for (const run of list) {
      if (!clear(run.x, run.z, run.half)) { post(); continue; }
      pushTyped(cityVariant(type, null, 2 * run.half), run.x, seatRun(run), run.z, run.yaw, tone, 0);
      laid++;
      open = stone ? null : [run.x + run.ux * run.half, run.z + run.uz * run.half, run.yaw];
    }
    post();
    return laid;
  };

  /* ---- the wall and the castle ---- */
  // The bastions stood on the wall's line so far, each { x, z, half }: the curtain is not built through one.
  const bastions = [];
  // A curtain from a to b, its parapet toward `out`, as high as the nearest of its heights to `height`: whole bays,
  // covering the run and a little past each end into the towers and turns that close it, broken where a gate stands
  // across it (to the middles of the gate's towers) and where a bastion stands on it.
  const curtain = (ax, az, bx, bz, out, height, tone) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1) return;
    const ux = (bx - ax) / L, uz = (bz - az) / L, yaw = Math.atan2(ux, uz), side = (-uz * out[0] + ux * out[1]) >= 0 ? 1 : -1;
    const cuts = [];
    for (const q of gates) {
      const t = (q.x - ax) * ux + (q.z - az) * uz, off = Math.abs((q.z - az) * ux - (q.x - ax) * uz);
      if (off < CITY_GATE.thick && t > -CITY_GATE.reach && t < L + CITY_GATE.reach) cuts.push([t - CITY_GATE.reach, t + CITY_GATE.reach]);
    }
    for (const q of bastions) {
      const t = (q.x - ax) * ux + (q.z - az) * uz, off = Math.abs((q.z - az) * ux - (q.x - ax) * uz);
      if (off < CITY_CURTAIN.thick && t > -q.half && t < L + q.half) cuts.push([t - q.half + CITY_CURTAIN.bay / 2, t + q.half - CITY_CURTAIN.bay / 2]);
    }
    cuts.sort((p, q) => p[0] - q[0]);
    const lay = (s0, s1) => {
      if (s1 - s0 < 1) return;
      for (const run of sections(ax + ux * s0, az + uz * s0, ax + ux * s1, az + uz * s1, { unit: CITY_CURTAIN.bay, counts: CITY_CURTAIN.bays, past: 0.25, cover: true, sink: 1 })) {
        const type = cityVariant(CITY_TYPE.CURTAIN, null, 2 * run.half, height), f = footprint(run.x, run.z, CITY_CURTAIN.thick, 2 * run.half, yaw), base = seatBlock(f);
        pushBlock(f, CITY_BUILDING_TYPES[type].height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, tone, base);
        keep(f);
        pushTyped(type, run.x, base.floor, run.z, side > 0 ? yaw : yaw + Math.PI, tone);
      }
    };
    let from = 0;
    for (const [c0, c1] of cuts) { lay(from, Math.min(L, c0)); from = Math.max(from, c1); }
    lay(from, L);
  };
  // A tower of the wall (or the keep) as near `side` broad and `height` high as its family has one. Answers its footprint.
  const tower = (x, z, side, height, tone, type = CITY_TYPE.WALL_TOWER) => {
    const id = cityVariant(type, side, side, height), T = CITY_BUILDING_TYPES[id], f = footprint(x, z, T.width, T.length, rr() * 0.3);
    const floor = pushBlock(f, T.height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, tone);
    pushTyped(id, x, floor, z, f.yaw, tone);
    keep(f);
    return f;
  };
  // A bastion standing out from the wall's line at (x, z) toward (ox, oz), as high as the nearest of its heights to
  // `height`: of the size its family has nearest `half` to either side. The curtain is then not built through it.
  const bastion = (x, z, ox, oz, half, height, tone) => {
    const id = cityVariant(CITY_TYPE.BASTION, 2 * half, 2 * half, height), T = CITY_BUILDING_TYPES[id], W = T.width / 2, yaw = Math.atan2(oz, -ox);
    const f = footprint(x + ox * W, z + oz * W, T.width, T.length, yaw), floor = pushBlock(f, T.height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, tone);
    pushTyped(id, f.x, floor, f.z, yaw, tone);
    keep(f);
    bastions.push({ x, z, half: W });
    return f;
  };
  // A gate in a wall running along (ux, uz): a tower to either side and an arched passage under a chamber between
  // them, each of its one size.
  const gate = (q, ux, uz) => {
    for (const s of [-1, 1]) tower(q.x + ux * s * CITY_GATE.reach, q.z + uz * s * CITY_GATE.reach, CITY_GATE.tower, CITY_GATE.passage + CITY_GATE.chamber + 1, 0.92);
    const floor = heightAt(q.x, q.z), yaw = Math.atan2(-uz, ux), f = footprint(q.x, q.z, CITY_GATE.span, CITY_GATE.thick, yaw);
    blocks.push(q.x, floor, q.z, yaw, CITY_GATE.span, CITY_GATE.thick, CITY_GATE.passage + CITY_GATE.chamber, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, 0.9, 0);
    keep(f);
    pushTyped(CITY_TYPE.GATE, q.x, floor, q.z, yaw, 0.9);
  };
  return { seatBlock, pushBlock, pushTyped, fit, sections, seatRun, fence, curtain, tower, bastion, gate };
}
