// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A port's waterfront, laid by the one rule every port is built by (AGENTS.md rule 3): its board's place (js/old-world-
// board.js layBoardCountry) faces the water, and its quay is laid along the shore nearest it in whole bays of stone,
// a chord of the shore to each section, corner to corner, never stretched (js/old-world-buildings.js CITY_QUAY); its
// moles run out from the quay's face to water a ship can lie in (CITY_PIER), as long as the depth asks; its slipway and
// careening shed stand on the beach past the ends of the quay. Every one is a city type of the one atlas, drawn by the
// continuum, struck, flooded and walked as drawn, and each is entered in the waterfront list the port's berths, ways,
// cleats and footing are read from (js/coastal-world.js, js/town-streets.js, js/port-props.js).
import { CITY_BUILDING_TYPES, CITY_PIER, CITY_QUAY, CITY_TYPE, CITY_TYPED_ROOF, cityFamilyOf } from './old-world-buildings.js';
import { CITY_ROOF, footprint } from './old-world-city.js';

// The quay's centre line runs this far inland of the water's edge: its face (depth/2 to seaward of it) stands a metre
// into the water.
const WATERFRONT_LINE_M = CITY_QUAY.depth / 2 - 1;
// A chord of the shore takes a section of quay only if the shore at its middle is within this of the line, and turns
// no more than this from the section before it.
const WATERFRONT_SAG_M = 2.5, WATERFRONT_TURN = 0.7;
// A quay is laid along a shore that is low: ground no higher than this behind its face.
const WATERFRONT_LOW_M = 4.5;
// How far from its place a port looks for its shore, at the least.
const WATERFRONT_REACH_M = 520;
// A mole runs out to water this deep at its head, or as near it as its longest reaches.
const WATERFRONT_BERTH_M = 3.5;
// The waterfront a place of `people` lays: its quay's length, and a mole to every so many metres of it.
const waterfrontLength = (people) => Math.min(640, Math.max(CITY_QUAY.bays[0] * CITY_QUAY.bay, 60 * Math.sqrt(Math.max(0, people) / 500)));
const WATERFRONT_PIER_EVERY_M = 140;
// Who builds ships on their beach and who careens them: a place of so many people.
const WATERFRONT_SLIPWAY_PEOPLE = 300, WATERFRONT_CAREENING_PEOPLE = 1000;

const waterfrontType = (key, k) => cityFamilyOf(CITY_TYPE[key]).from + k;

/**
 * Lays the waterfront of `place` (a board place in world metres). `inlandAt(x, z)` answers the distance inland of the
 * water's edge, `heightAt` the ground; `inside(x, z, pad)` whether a point is within the board; `taken(f, gap)`
 * whether a footprint meets anything stood. The masons' pushBlock and pushTyped stand each type; keep and occupy mark
 * its footprint. Answers the records, each { kind: 'quay'|'pier'|'slipway'|'careening', type, piece (its index among
 * the city's types), x, y (its floor), z, yaw (+z inland: its face to the water at -z), width, length, deck (the height
 * its deck is walked at, or null) }.
 */
export function layBoardWaterfront({ place, seat = false, sovereign = false, heightAt, inlandAt, inside, taken, keep, occupy, pushBlock, pushTyped, typedTypes, rr = Math.random }) {
  const out = [];
  if (!place) return out;
  // The way to the water at a point: down the slope of the distance inland.
  const toWater = (x, z) => {
    const e = 4, gx = inlandAt(x + e, z) - inlandAt(x - e, z), gz = inlandAt(x, z + e) - inlandAt(x, z - e), L = Math.hypot(gx, gz);
    return L > 1e-4 ? [-gx / L, -gz / L] : null;
  };
  // Signed distance inland from the true heightAt === 0 waterline along `toWater` (whereas `inlandAt` is only cell-centred).
  const shoreAtLine = (x, z) => {
    const w = toWater(x, z);
    if (!w) return inlandAt(x, z);
    const h0 = heightAt(x, z);
    // Search along w (towards water, +t) if dry, or -w (inland, -t) if wet, up to 48 m for the 0 m crossing.
    if (h0 >= 0) {
      let prevT = 0;
      for (let t = 4; t <= 48; t += 4) {
        if (heightAt(x + w[0] * t, z + w[1] * t) <= 0) {
          let lo = prevT, hi = t;
          for (let b = 0; b < 6; b++) {
            const mid = (lo + hi) * 0.5;
            if (heightAt(x + w[0] * mid, z + w[1] * mid) > 0) lo = mid; else hi = mid;
          }
          return (lo + hi) * 0.5;
        }
        prevT = t;
      }
      return Math.max(48, inlandAt(x, z));
    }
    let prevT = 0;
    for (let t = 4; t <= 48; t += 4) {
      if (heightAt(x - w[0] * t, z - w[1] * t) >= 0) {
        let lo = prevT, hi = t;
        for (let b = 0; b < 6; b++) {
          const mid = (lo + hi) * 0.5;
          if (heightAt(x - w[0] * mid, z - w[1] * mid) < 0) lo = mid; else hi = mid;
        }
        return -(lo + hi) * 0.5;
      }
      prevT = t;
    }
    return -48;
  };
  // A point moved across the shore onto the quay's line, holding it `from` a joint at `chord` metres.
  const onLine = (x, z, line = WATERFRONT_LINE_M) => {
    for (let i = 0; i < 6; i++) {
      const w = toWater(x, z);
      if (!w) return [x, z];
      const err = shoreAtLine(x, z) - line;
      if (Math.abs(err) < 0.05) break;
      x += w[0] * err; z += w[1] * err;
    }
    return [x, z];
  };

  // The shore nearest the place: down the slope of the distance inland from its middle, as far as its reach (any
  // distance for the seat). When a place's centre lies in the water (as Porto's sits on the Douro), rings out from it
  // find the nearest dry bank first.
  const reach = seat ? Infinity : Math.max(WATERFRONT_REACH_M, 1.2 * (place.radius || 0));
  let [ax, az] = [place.x, place.z];
  if (inlandAt(ax, az) <= 0) {
    let bank = null;
    for (let r = 4; r <= 2000 && !bank; r += 4) {
      const n = Math.max(8, Math.ceil((2 * Math.PI * r) / 8));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 2 * Math.PI, sx = place.x + Math.cos(a) * r, sz = place.z + Math.sin(a) * r;
        if (!inside(sx, sz, 40) || inlandAt(sx, sz) <= 0 || heightAt(sx, sz) > WATERFRONT_LOW_M) continue;
        bank = [sx, sz];
        break;
      }
    }
    if (!bank) return out;
    [ax, az] = bank;
  }
  for (let i = 0; i < 800; i++) {
    const d = inlandAt(ax, az) - WATERFRONT_LINE_M;
    if (d < 0.5) break;
    const w = toWater(ax, az);
    if (!w) return out;
    const step = Math.min(d, 12);
    ax += w[0] * step; az += w[1] * step;
  }
  [ax, az] = onLine(ax, az);
  if (Math.hypot(ax - place.x, az - place.z) > reach || !inside(ax, az, 40) || Math.abs(shoreAtLine(ax, az) - WATERFRONT_LINE_M) > WATERFRONT_SAG_M) return out;

  // A native place lays no stone quay: its canoes are drawn up on the strand, with a tidal fish weir in the shallows
  // before them; a proclaimed sovereign polity also runs a timber trade mole out to deep water.
  if (place.earthen) {
    const w0 = toWater(ax, az);
    if (!w0) return out;
    const birchbark = place.culture === 'iroquoian' || place.culture === 'massachusett' || place.culture === 'lenape';
    const type = waterfrontType('CANOE_LANDING', birchbark ? 1 : 0), T = CITY_BUILDING_TYPES[type];
    const dir0 = [-w0[1], w0[0]], want = seat && (place.people || 0) >= 450 ? 2 : 1;
    let laid = 0;
    const offsets = [0];
    for (let step = 18; step <= 252; step += 18) offsets.push(-step, step);
    for (const off of offsets) {
      if (laid >= want) break;
      const [x, z] = onLine(ax + dir0[0] * off, az + dir0[1] * off, T.length / 2 - 2.5);
      const w = toWater(x, z);
      if (!w || !inside(x, z, 24)) continue;
      const yaw = Math.atan2(-w[0], -w[1]), f = footprint(x, z, T.width, T.length, yaw);
      let lo = Infinity, hi = -Infinity;
      for (const [lx, lz] of [[-1, 0], [1, 0], [0, 1], [-1, 1], [1, 1]]) {
        const h = heightAt(x + lx * f.c * T.width / 2 + lz * f.s * T.length / 2, z - lx * f.s * T.width / 2 + lz * f.c * T.length / 2);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      if (lo < -0.9 || hi - lo > 5.0 || hi > WATERFRONT_LOW_M + 3.5 || taken(f, 1.5)) continue;
      const floor = Math.max(0.25, (lo + hi) / 2), tone = 0.72 + 0.18 * rr();
      keep(f); occupy(f);
      pushBlock(f, T.height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, birchbark ? 17 : 10, tone, { floor, plinth: Math.max(0.3, floor - lo + 0.4), range: hi - lo });
      pushTyped(type, x, floor, z, yaw, tone);
      out.push({ kind: 'canoe', type, piece: typedTypes.length - 1, x, y: floor, z, yaw, width: T.width, length: T.length, deck: null });
      laid++;
    }
    if (seat && sovereign) {
      const pierFamily = cityFamilyOf(CITY_TYPE.PIER), [rx, rz] = onLine(ax + dir0[0] * 26, az + dir0[1] * 26, 0), pw = toWater(rx, rz);
      if (pw) {
        const nx = -pw[0], nz = -pw[1], pyaw = Math.atan2(nx, nz);
        let pick = null;
        for (let k = 0; k < pierFamily.count; k++) {
          const pt = pierFamily.from + k, PT = CITY_BUILDING_TYPES[pt];
          let wet = true;
          for (let t = 4; t <= PT.length; t += 4) if (heightAt(rx - nx * t, rz - nz * t) > 0.2) { wet = false; break; }
          if (!wet) break;
          const head = heightAt(rx - nx * PT.length, rz - nz * PT.length);
          pick = { type: pt, T: PT, head };
          if (head <= -WATERFRONT_BERTH_M) break;
        }
        if (pick && pick.head <= -1) {
          const { type: pt, T: PT } = pick, px = rx - nx * PT.length / 2, pz = rz - nz * PT.length / 2, pf = footprint(px, pz, PT.width, PT.length, pyaw);
          if (inside(px, pz, 20) && !taken(pf, 1)) {
            keep(pf);
            const tone = 0.7 + 0.2 * rr();
            pushBlock(pf, PT.height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, 10, tone, { floor: 0, plinth: 0.3, range: 0 });
            pushTyped(pt, px, 0, pz, pyaw, tone);
            out.push({ kind: 'pier', type: pt, piece: typedTypes.length - 1, x: px, y: 0, z: pz, yaw: pyaw, width: PT.width, length: PT.length, deck: CITY_PIER.deck, head: pick.head });
          }
        }
      }
    }
    return out;
  }

  // A section of quay from joint a to joint b: its middle on the line, its face to the water.
  const section = (a, b) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const w = toWater(mx, mz);
    if (!w) return null;
    // The normal of the chord that runs inland.
    let nx = -uz, nz = ux;
    if (nx * -w[0] + nz * -w[1] < 0) { nx = -nx; nz = -nz; }
    return { x: mx, z: mz, yaw: Math.atan2(nx, nz), ux, uz, nx, nz, L };
  };
  const fits = (s, bays) => {
    if (!s || !inside(s.x, s.z, 30) || Math.abs(shoreAtLine(s.x, s.z) - WATERFRONT_LINE_M) > WATERFRONT_SAG_M) return null;
    // The ground behind its face, along its back: low enough for a quay, and dry.
    const back = [s.x + s.nx * (CITY_QUAY.depth / 2 - 0.5), s.z + s.nz * (CITY_QUAY.depth / 2 - 0.5)];
    if (heightAt(...back) > WATERFRONT_LOW_M || heightAt(...back) < -0.5) return null;
    const f = footprint(s.x, s.z, bays * CITY_QUAY.bay, CITY_QUAY.depth, s.yaw);
    return taken(f, 0.5) ? null : f;
  };

  // The run of quay: sections out from the anchor along the shore each way in turn, the largest whose chord keeps to
  // the shore, until the run is as long as the place asks or the shore turns, rises or is taken. Its own sections are
  // kept only once the run is laid, so that each meets the one before it at their joint.
  const want = Math.round(waterfrontLength(place.people || 0) / CITY_QUAY.bay);
  const ends = [{ joint: [ax, az], dir: null, open: true }, { joint: [ax, az], dir: null, open: true }];
  {
    const w = toWater(ax, az);
    if (!w) return out;
    ends[0].dir = [-w[1], w[0]]; ends[1].dir = [w[1], -w[0]];
  }
  const sections = [[], []];
  let bays = 0;
  for (let turn = 0; bays < want && (ends[0].open || ends[1].open); turn++) {
    const side = turn % 2, end = ends[side];
    if (!end.open) continue;
    let laid = null;
    for (let k = CITY_QUAY.bays.length - 1; k >= 0 && !laid; k--) {
      const n = CITY_QUAY.bays[k], chord = n * CITY_QUAY.bay;
      if (bays + n > want + 2 && k > 0) continue;
      let [ex, ez] = [end.joint[0] + end.dir[0] * chord, end.joint[1] + end.dir[1] * chord];
      for (let i = 0; i < 4; i++) {
        [ex, ez] = onLine(ex, ez);
        const L = Math.hypot(ex - end.joint[0], ez - end.joint[1]) || 1;
        ex = end.joint[0] + (ex - end.joint[0]) * chord / L; ez = end.joint[1] + (ez - end.joint[1]) * chord / L;
      }
      const ux = (ex - end.joint[0]) / chord, uz = (ez - end.joint[1]) / chord;
      if (ux * end.dir[0] + uz * end.dir[1] < Math.cos(WATERFRONT_TURN)) continue;
      const s = section(end.joint, [ex, ez]), f = fits(s, n);
      if (!f) continue;
      laid = { s, f, n, e: [ex, ez], u: [ux, uz] };
    }
    if (!laid) { end.open = false; continue; }
    sections[side].push(laid);
    bays += laid.n;
    end.joint = laid.e; end.dir = laid.u;
  }
  const run = [...sections[0].reverse(), ...sections[1]];
  for (const { s, f, n } of run) {
    const type = waterfrontType('QUAY', CITY_QUAY.bays.indexOf(n)), T = CITY_BUILDING_TYPES[type], tone = 0.84 + 0.1 * rr();
    pushBlock(f, T.height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, 11, tone, { floor: 0, plinth: 0.3, range: 0 });
    pushTyped(type, s.x, 0, s.z, s.yaw, tone);
    keep(f); occupy(f);
    out.push({ kind: 'quay', type, piece: typedTypes.length - 1, x: s.x, y: 0, z: s.z, yaw: s.yaw, width: T.width, length: T.length, deck: CITY_QUAY.deck });
  }

  // Its moles: evenly along the run, each from the quay's face straight out to water a ship lies in.
  const runLength = run.reduce((sum, r) => sum + r.n * CITY_QUAY.bay, 0);
  const moles = Math.max(1, Math.min(4, Math.round(runLength / WATERFRONT_PIER_EVERY_M)));
  const pierFamily = cityFamilyOf(CITY_TYPE.PIER);
  const roots = [];
  if (run.length) {
    for (let m = 0; m < moles; m++) {
      let at = (m + 0.5) / moles * runLength;
      for (const r of run) {
        const len = r.n * CITY_QUAY.bay;
        if (at > len) { at -= len; continue; }
        const off = at - len / 2;
        roots.push({ x: r.s.x + r.s.ux * off - r.s.nx * CITY_QUAY.depth / 2, z: r.s.z + r.s.uz * off - r.s.nz * CITY_QUAY.depth / 2, nx: r.s.nx, nz: r.s.nz, yaw: r.s.yaw });
        break;
      }
    }
  } else {
    // No shore to lay a quay on: a mole rooted on the dry strand just above the water's edge.
    const w = toWater(ax, az), [rx, rz] = onLine(ax, az, 4);
    if (w) roots.push({ x: rx, z: rz, nx: -w[0], nz: -w[1], yaw: Math.atan2(-w[0], -w[1]), strand: true });
  }
  for (const root of roots) {
    let pick = null;
    for (let k = 0; k < pierFamily.count; k++) {
      const type = pierFamily.from + k, T = CITY_BUILDING_TYPES[type];
      // Over the water past its root, and the deeper at its head the better until a ship lies there afloat.
      let wet = true;
      for (let t = root.strand ? 8 : 4; t <= T.length; t += 4) if (heightAt(root.x - root.nx * t, root.z - root.nz * t) > 0.2) { wet = false; break; }
      if (!wet) break;
      const head = heightAt(root.x - root.nx * T.length, root.z - root.nz * T.length);
      pick = { type, T, head };
      if (head <= -WATERFRONT_BERTH_M) break;
    }
    if (!pick || pick.head > -1) continue;
    const { type, T } = pick, x = root.x - root.nx * T.length / 2, z = root.z - root.nz * T.length / 2;
    const f = footprint(x, z, T.width, T.length, root.yaw);
    // Clear of all but the quay it runs out from: what it meets beyond the first metres off the quay's face.
    const clear = footprint(x - root.nx * 2, z - root.nz * 2, T.width, T.length - 4, root.yaw);
    if (!inside(x, z, 20) || taken(clear, 1)) continue;
    keep(f);
    const tone = 0.7 + 0.2 * rr();
    pushBlock(f, T.height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, 10, tone, { floor: 0, plinth: 0.3, range: 0 });
    pushTyped(type, x, 0, z, root.yaw, tone);
    out.push({ kind: 'pier', type, piece: typedTypes.length - 1, x, y: 0, z, yaw: root.yaw, width: T.width, length: T.length, deck: CITY_PIER.deck, head: pick.head });
  }

  // Its slipway and careening shed: on the beach past either end of the quay, their water ends at its edge.
  const beach = [];
  if (seat && (place.people || 0) >= WATERFRONT_SLIPWAY_PEOPLE) beach.push(['slipway', 'SLIPWAY']);
  if (seat && (place.people || 0) >= WATERFRONT_CAREENING_PEOPLE) beach.push(['careening', 'CAREENING_SHED']);
  beach.forEach(([kind, key], side) => {
    const type = waterfrontType(key, 0), T = CITY_BUILDING_TYPES[type];
    let placedShed = false;
    for (const which of [side, 1 - side]) {
      if (placedShed) break;
      const end = ends[which];
      let [sx, sz] = end.joint, [dx, dz] = end.dir;
      for (let tries = 0; tries < 28; tries++) {
        const step = tries === 0 ? 8 + T.width / 2 : 12;
        [sx, sz] = onLine(sx + dx * step, sz + dz * step);
        const sw = toWater(sx, sz);
        if (!sw || !inside(sx, sz, 30)) break;
        dx = which === 0 ? -sw[1] : sw[1];
        dz = which === 0 ? sw[0] : -sw[0];
        const [x, z] = onLine(sx, sz, T.length / 2 - 3);
        const w = toWater(x, z);
        if (!w || !inside(x, z, 30)) continue;
        const yaw = Math.atan2(-w[0], -w[1]), f = footprint(x, z, T.width, T.length, yaw);
        let lo = Infinity, hi = -Infinity;
        for (const [lx, lz] of [[-1, 0], [1, 0], [0, 1], [-1, 1], [1, 1]]) {
          const h = heightAt(x + lx * f.c * T.width / 2 + lz * f.s * T.length / 2, z - lx * f.s * T.width / 2 + lz * f.c * T.length / 2);
          lo = Math.min(lo, h); hi = Math.max(hi, h);
        }
        if (lo < -1.2 || hi - lo > 5.5 || hi > WATERFRONT_LOW_M + 4 || taken(f, 1.5)) continue;
        const floor = Math.max(0.3, (lo + hi) / 2), tone = 0.7 + 0.2 * rr();
        keep(f); occupy(f);
        pushBlock(f, T.height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, 10, tone, { floor, plinth: Math.max(0.3, floor - lo + 0.5), range: hi - lo });
        pushTyped(type, x, floor, z, yaw, tone);
        out.push({ kind, type, piece: typedTypes.length - 1, x, y: floor, z, yaw, width: T.width, length: T.length, deck: null });
        placedShed = true;
        break;
      }
    }
  });
  return out;
}
