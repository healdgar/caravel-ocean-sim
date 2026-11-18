// What a city plan is made of, and the masons who stand it. An Old World city is its board's
// (Castle and Commons' own generator, js/old-world-board.js); a colonial port is planned here
// (planColonialStreets, buildColonialCityFabric). Either way the plan is made once, when the land
// is built, and never per frame: a list of blocks (twelve numbers each), the plots buildings stand
// on, which trees and grass keep off; the streets as ways for the paving field; and answers about any
// point of ground: house, street, square, garden or yard, and whether a tree may stand there.
// Each house, church, tower and gate is a building of a type written in Cairn (js/old-world-buildings.js),
// stood at its own size and drawn by the one continuum (js/city-continuum-draw.js).
import { CITY_BUILDING_TYPES, CITY_CURTAIN, CITY_GATE, CITY_TYPE, CITY_TYPED_ROOF, cityHousePick, cityHouseType, cityVariant } from './old-world-buildings.js';
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
  // A curtain from a to b, its parapet toward `out`, as high as the nearest of its heights to `height`: whole bays,
  // covering the run and a little past each end into the towers and turns that close it, broken where a gate stands
  // across it (to the middles of the gate's towers).
  const curtain = (ax, az, bx, bz, out, height, tone) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1) return;
    const ux = (bx - ax) / L, uz = (bz - az) / L, yaw = Math.atan2(ux, uz), side = (-uz * out[0] + ux * out[1]) >= 0 ? 1 : -1;
    const cuts = [];
    for (const q of gates) {
      const t = (q.x - ax) * ux + (q.z - az) * uz, off = Math.abs((q.z - az) * ux - (q.x - ax) * uz);
      if (off < CITY_GATE.thick && t > -CITY_GATE.reach && t < L + CITY_GATE.reach) cuts.push([t - CITY_GATE.reach, t + CITY_GATE.reach]);
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
  // A gate in a wall running along (ux, uz): a tower to either side and an arched passage under a chamber between
  // them, each of its one size.
  const gate = (q, ux, uz) => {
    for (const s of [-1, 1]) tower(q.x + ux * s * CITY_GATE.reach, q.z + uz * s * CITY_GATE.reach, CITY_GATE.tower, CITY_GATE.passage + CITY_GATE.chamber + 1, 0.92);
    const floor = heightAt(q.x, q.z), yaw = Math.atan2(-uz, ux), f = footprint(q.x, q.z, CITY_GATE.span, CITY_GATE.thick, yaw);
    blocks.push(q.x, floor, q.z, yaw, CITY_GATE.span, CITY_GATE.thick, CITY_GATE.passage + CITY_GATE.chamber, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, 0.9, 0);
    keep(f);
    pushTyped(CITY_TYPE.GATE, q.x, floor, q.z, yaw, 0.9);
  };
  return { seatBlock, pushBlock, pushTyped, fit, sections, seatRun, fence, curtain, tower, gate };
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
  const { seatBlock, pushBlock, pushTyped, fit, curtain, tower, gate } = cityMasonry({
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
            rr(); // The throw that once raised its walls past its storeys, kept so the rest of the plan falls as it did.
            const eaves = manner !== 'timber' || rr() < 0.55;
            // Its own size of its kind, fronted on the street where its plot is.
            const { type, T, at } = fit(cityHouseType(storeys, manner !== 'timber' && eaves, cityHousePick(fx, fz)), f, true);
            const rise = eaves ? 0.36 * T.length * 0.5 : 0.5 * T.width * 0.5;
            const tone = manner === 'timber' ? 0.28 + rr() * 0.32 : 0.52 + rr() * 0.42;
            const wallKind = manner === 'timber' ? CITY_WALL.HOUSE : (rich ? CITY_WALL.STUCCO : CITY_WALL.HOUSE);
            const blockFp = eaves ? footprint(fx, fz, d, w, lotYaw + Math.PI * 0.5) : f;
            const floor = pushBlock(blockFp, T.height, rise, CITY_ROOF.GABLE + CITY_TYPED_ROOF, wallKind, tone, seatBlock(at, base.floor));
            pushTyped(type, at.x, floor, at.z, lotYaw, tone, 1);
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
