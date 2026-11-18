// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A coast as Castle and Commons' model founded it (its board: js/board-model.js), stood up in this game. The board
// says only what stands where. Everything that stands is this game's own: each building a type written in Cairn
// (js/old-world-buildings.js), so it is drawn, lit, struck and broken as every other; walls, towers and gates by
// the same masons as the city generator's (js/old-world-city.js); woodland handed to the forest; water left as the
// game has it. Ground keeps the look of its geography: what the board adds to it is drawn by the GPU
// (js/board-stamp.js) from the compact tables made here once.
import { CITY_BLOCK_FLOATS, CITY_GROUND, CITY_ROOF, CITY_TREES, CITY_WALL, cityFootprintsOverlap, cityMasonry, footprint, local, makeHash, mulberry, rectDist, segDist, segRectDist } from './old-world-city.js';
import { CITY_BASTION, CITY_BUILDING_TYPES, CITY_CHURCH, CITY_CURTAIN, CITY_GATE, CITY_HALL, CITY_HOUSE_STOREYS, CITY_PAINT, CITY_PENTICE, CITY_STOREY_M, CITY_THATCH_ROOF, CITY_TYPE, CITY_TYPED_ROOF, cityHouseType, cityVariant } from './old-world-buildings.js';
import { WORKS_BRIDGE, WORKS_WHEEL } from './old-world-works.js';
import { NATIVE_PALISADE } from './native-works.js';

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
  // The houses of the peoples of the Americas (js/native-works.js): far off, a vault is a gable and a dome or a cone a
  // pyramid, each roofed in straw (their seventh word), its walls of bark (17), mats and thatch (15) or cane (10).
  barkLonghouse: ['BARK_LONGHOUSE', CITY_ROOF.GABLE, 17, 3.7, true, false, true], wetu: ['WETU', CITY_ROOF.PYRAMID, 17, 2, false, false, true],
  arbourHouse: ['ARBOUR_HOUSE', CITY_ROOF.GABLE, 15, 3.6, true, false, true], bohio: ['BOHIO', CITY_ROOF.PYRAMID, 10, 5.2, false, false, true],
  caney: ['CANEY', CITY_ROOF.GABLE, 10, 5, true, false, true], maloca: ['MALOCA', CITY_ROOF.GABLE, 15, 3, true, false, true],
  chiefHouse: ['CHIEF_HOUSE', CITY_ROOF.GABLE, 17, 3.6, true, false, true], charnelHouse: ['CHARNEL_HOUSE', CITY_ROOF.GABLE, 15, 3.3, true, false, true],
  sweatLodge: ['SWEAT_LODGE', CITY_ROOF.PYRAMID, 17, 1.1, false, false, true],
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

export function widenBoardRiverHalfWidth(rawHw, isCanal = false) {
  const h = Number.isFinite(rawHw) ? Math.max(0.75, rawHw) : 2.5;
  if (isCanal) return Math.max(6.0, h * 1.35);
  return h >= 1.5 ? Math.min(14.5, 4.4 + h * 2.15) : Math.max(2.8, h * 2.1);
}

export function widenBoardRivers(rawRivers) {
  if (!Array.isArray(rawRivers)) return [];
  return rawRivers.map((river) => {
    const src = river?.points;
    if (!src || src.length < 3) return river;
    const isCanal = Boolean(river.canal);
    const pts = new Array(src.length);
    for (let i = 0; i + 2 < src.length; i += 3) {
      pts[i] = src[i];
      pts[i + 1] = src[i + 1];
      pts[i + 2] = widenBoardRiverHalfWidth(src[i + 2], isCanal);
    }
    return { ...river, points: pts };
  });
}
function roadDirectionAt(P, segIdx, t, win = 14) {
  const ax = P[segIdx], az = P[segIdx + 1], bx = P[segIdx + 2], bz = P[segIdx + 3];
  const cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
  let backX = ax, backZ = az, rem = win, px = cx, pz = cz, k = segIdx;
  while (k >= 0 && rem > 1e-6) {
    const qx = P[k], qz = P[k + 1], d = Math.hypot(px - qx, pz - qz);
    if (d >= rem) {
      const f = rem / d;
      backX = px + (qx - px) * f; backZ = pz + (qz - pz) * f;
      rem = 0; break;
    }
    rem -= d; px = qx; pz = qz; k -= 2;
    backX = px; backZ = pz;
  }
  let fwdX = bx, fwdZ = bz;
  rem = win; px = cx; pz = cz; k = segIdx + 2;
  while (k + 1 < P.length && rem > 1e-6) {
    const qx = P[k], qz = P[k + 1], d = Math.hypot(qx - px, qz - pz);
    if (d >= rem) {
      const f = rem / d;
      fwdX = px + (qx - px) * f; fwdZ = pz + (qz - pz) * f;
      rem = 0; break;
    }
    rem -= d; px = qx; pz = qz; k += 2;
    fwdX = px; fwdZ = pz;
  }
  const dx = fwdX - backX, dz = fwdZ - backZ, L = Math.hypot(dx, dz);
  if (L > 1e-4) return [dx / L, dz / L];
  const segL = Math.hypot(bx - ax, bz - az);
  return segL > 1e-6 ? [(bx - ax) / segL, (bz - az) / segL] : [1, 0];
}
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
          const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 14)) continue;
          // Align along the smoothed ±14 m road tangent and guard extreme grazing angles so bridges seat bank-to-bank cleanly.
          const [ux, uz] = roadDirectionAt(P, i, t, 14);
          const riverLen = Math.hypot(dx - cx, dz - cz);
          const sine = riverLen > 1e-6 ? Math.abs(ux * (dz - cz) - uz * (dx - cx)) / riverLen : 1;
          const half = R[j + 2] + (R[j + 5] - R[j + 2]) * u;
          out.push({ x, z, ux, uz, span: 2 * half / Math.max(0.42, sine), stone: road.stone });
        }
      }
    }
  }
  return out;
}
// The model's kind of a stretch of wall where a cliff is itself the wall.
const BOARD_WALL_CLIFF = 1;
// A wharf's deck stands this far above the sea at the least.
const BOARD_WHARF_M = 1.2;

/**
 * Chain adjacent waterfront wharf lots continuously along the local shoreline contour (`∇inland` tangent),
 * snapping endpoints corner-to-corner and unifying deck elevations without staggered gaps.
 */
export function alignWaterfrontWharves(wharfItems, { inlandAt, heightAt = null, minDeckY = BOARD_WHARF_M } = {}) {
  const result = new Map();
  if (!Array.isArray(wharfItems) || wharfItems.length === 0 || typeof inlandAt !== 'function') return result;

  const shoreBasis = (px, pz, fallbackRot = 0) => {
    const e = 8;
    let gx = (inlandAt(px + e, pz) - inlandAt(px - e, pz)) / (2 * e);
    let gz = (inlandAt(px, pz + e) - inlandAt(px, pz - e)) / (2 * e);
    let gl = Math.hypot(gx, gz);
    if (gl < 1e-3 && typeof heightAt === 'function') {
      gx = (heightAt(px + e, pz) - heightAt(px - e, pz)) / (2 * e);
      gz = (heightAt(px, pz + e) - heightAt(px, pz - e)) / (2 * e);
      gl = Math.hypot(gx, gz);
    }
    const wx = gl > 1e-4 ? -gx / gl : Math.sin(fallbackRot);
    const wz = gl > 1e-4 ? -gz / gl : Math.cos(fallbackRot);
    return { wx, wz, tx: -wz, tz: wx, gl };
  };

  const nodes = wharfItems.map((item, idx) => {
    const id = item.index ?? idx;
    const b = shoreBasis(item.x, item.z, item.rot ?? 0);
    return {
      id,
      place: item.place ?? 0,
      x: item.x,
      z: item.z,
      rot: item.rot ?? 0,
      w: Number.isFinite(item.w) ? item.w : 7,
      d: Number.isFinite(item.d) ? item.d : 30,
      inland: inlandAt(item.x, item.z),
      ...b,
    };
  });

  // Connected components of adjacent wharves along the same shoreline contour (<= 52 m, aligned waterward normal).
  const visited = new Uint8Array(nodes.length);
  for (let s = 0; s < nodes.length; s++) {
    if (visited[s]) continue;
    const cluster = [];
    const queue = [s];
    visited[s] = 1;
    while (queue.length > 0) {
      const u = queue.pop();
      cluster.push(nodes[u]);
      for (let v = 0; v < nodes.length; v++) {
        if (visited[v] || nodes[v].place !== nodes[u].place) continue;
        if (Math.hypot(nodes[v].x - nodes[u].x, nodes[v].z - nodes[u].z) > 52) continue;
        if (nodes[u].wx * nodes[v].wx + nodes[u].wz * nodes[v].wz <= 0.35) continue;
        visited[v] = 1;
        queue.push(v);
      }
    }

    if (cluster.length === 1) {
      const u = cluster[0];
      const rx = Math.sin(u.rot), rz = Math.cos(u.rot);
      const alongDot = rx * u.tx + rz * u.tz;
      const waterDot = rx * u.wx + rz * u.wz;
      let yaw;
      if (Math.abs(alongDot) >= Math.abs(waterDot)) {
        const sgn = alongDot >= 0 ? 1 : -1;
        yaw = Math.atan2(u.tx * sgn, u.tz * sgn);
      } else {
        const sgn = waterDot >= -0.25 ? 1 : -1;
        yaw = Math.atan2(u.wx * sgn, u.wz * sgn);
      }
      const w = Math.max(5.65, Math.min(9.4, u.w));
      const d = Math.max(24.2, Math.min(40.2, u.d));
      const groundY = typeof heightAt === 'function' ? heightAt(u.x, u.z) : minDeckY;
      const floor = Math.max(minDeckY, Math.min(minDeckY + 1.8, groundY));
      result.set(u.id, { x: u.x, z: u.z, yaw, w, d, floor, chained: false });
      continue;
    }

    // Multi-wharf waterfront run: sort along shoreline contour tangent and chain joints corner-to-corner.
    let mwx = 0, mwz = 0, cx = 0, cz = 0;
    for (const u of cluster) { mwx += u.wx; mwz += u.wz; cx += u.x; cz += u.z; }
    cx /= cluster.length; cz /= cluster.length;
    const ml = Math.hypot(mwx, mwz) || 1;
    mwx /= ml; mwz /= ml;
    const mtx = -mwz, mtz = mwx;
    cluster.sort((a, b) => ((a.x - cx) * mtx + (a.z - cz) * mtz) - ((b.x - cx) * mtx + (b.z - cz) * mtz));

    const sortedInlands = cluster.map((u) => u.inland).sort((a, b) => a - b);
    const targetInland = sortedInlands[Math.floor(sortedInlands.length / 2)];
    const m = cluster.length;
    const segLens = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let rawSpan;
      if (i === 0) rawSpan = Math.hypot(cluster[1].x - cluster[0].x, cluster[1].z - cluster[0].z);
      else if (i === m - 1) rawSpan = Math.hypot(cluster[m - 1].x - cluster[m - 2].x, cluster[m - 1].z - cluster[m - 2].z);
      else rawSpan = 0.5 * Math.hypot(cluster[i + 1].x - cluster[i - 1].x, cluster[i + 1].z - cluster[i - 1].z);
      const baseLen = rawSpan >= 14 ? rawSpan : (cluster[i].d || 30);
      segLens[i] = Math.max(24.2, Math.min(40.0, baseLen));
    }

    const nudgeToContour = (px, pz, refTx, refTz) => {
      const b = shoreBasis(px, pz);
      if (b.gl < 1e-4) return { x: px, z: pz, tx: refTx, tz: refTz };
      const orient = (b.tx * refTx + b.tz * refTz) >= 0 ? 1 : -1;
      const err = Math.max(-5.5, Math.min(5.5, inlandAt(px, pz) - targetInland));
      return {
        x: px + b.wx * err * 0.72,
        z: pz + b.wz * err * 0.72,
        tx: b.tx * orient,
        tz: b.tz * orient,
      };
    };

    const mid = Math.floor(m / 2);
    const anchor = nudgeToContour(cluster[mid].x, cluster[mid].z, mtx, mtz);
    const joints = new Array(m + 1);
    const jMid0 = nudgeToContour(anchor.x - 0.5 * segLens[mid] * anchor.tx, anchor.z - 0.5 * segLens[mid] * anchor.tz, anchor.tx, anchor.tz);
    joints[mid] = [jMid0.x, jMid0.z];
    let fwdTx = jMid0.tx, fwdTz = jMid0.tz;
    for (let i = mid; i < m; i++) {
      const j0 = joints[i], L = segLens[i];
      const probe = shoreBasis(j0[0] + 0.5 * L * fwdTx, j0[1] + 0.5 * L * fwdTz);
      if (probe.gl > 1e-4) {
        const sgn = (probe.tx * fwdTx + probe.tz * fwdTz) >= 0 ? 1 : -1;
        fwdTx = probe.tx * sgn; fwdTz = probe.tz * sgn;
      }
      const cand = nudgeToContour(j0[0] + L * fwdTx, j0[1] + L * fwdTz, fwdTx, fwdTz);
      const dx = cand.x - j0[0], dz = cand.z - j0[1], dL = Math.hypot(dx, dz) || L;
      const clampedL = Math.max(24.2, Math.min(40.0, dL));
      joints[i + 1] = [j0[0] + (dx / dL) * clampedL, j0[1] + (dz / dL) * clampedL];
      fwdTx = cand.tx; fwdTz = cand.tz;
    }
    let backTx = jMid0.tx, backTz = jMid0.tz;
    for (let i = mid - 1; i >= 0; i--) {
      const j1 = joints[i + 1], L = segLens[i];
      const probe = shoreBasis(j1[0] - 0.5 * L * backTx, j1[1] - 0.5 * L * backTz);
      if (probe.gl > 1e-4) {
        const sgn = (probe.tx * backTx + probe.tz * backTz) >= 0 ? 1 : -1;
        backTx = probe.tx * sgn; backTz = probe.tz * sgn;
      }
      const cand = nudgeToContour(j1[0] - L * backTx, j1[1] - L * backTz, backTx, backTz);
      const dx = j1[0] - cand.x, dz = j1[1] - cand.z, dL = Math.hypot(dx, dz) || L;
      const clampedL = Math.max(24.2, Math.min(40.0, dL));
      joints[i] = [j1[0] - (dx / dL) * clampedL, j1[1] - (dz / dL) * clampedL];
      backTx = cand.tx; backTz = cand.tz;
    }

    // Unified deck height across the continuous waterfront wharf run so adjacent boards meet level.
    const bankSamples = [];
    for (let i = 0; i < m; i++) {
      const mx = 0.5 * (joints[i][0] + joints[i + 1][0]), mz = 0.5 * (joints[i][1] + joints[i + 1][1]);
      if (typeof heightAt === 'function') bankSamples.push(heightAt(mx, mz));
    }
    bankSamples.sort((a, b) => a - b);
    const medBankY = bankSamples.length ? bankSamples[Math.floor(bankSamples.length / 2)] : minDeckY;
    const unifiedFloor = Math.max(minDeckY, Math.min(minDeckY + 1.6, medBankY));

    const segDirs = [];
    for (let i = 0; i < m; i++) {
      const dx = joints[i + 1][0] - joints[i][0], dz = joints[i + 1][1] - joints[i][1], L = Math.hypot(dx, dz) || 1;
      segDirs.push([dx / L, dz / L, L]);
    }
    for (let i = 0; i < m; i++) {
      const u = cluster[i];
      const [ux, uz, chordL] = segDirs[i];
      const w = Math.max(5.65, Math.min(9.4, u.w));
      const bendA = i > 0 ? Math.acos(Math.max(-1, Math.min(1, segDirs[i - 1][0] * ux + segDirs[i - 1][1] * uz))) : 0;
      const bendB = i + 1 < m ? Math.acos(Math.max(-1, Math.min(1, ux * segDirs[i + 1][0] + uz * segDirs[i + 1][1]))) : 0;
      const miterPad = 0.5 * w * (Math.tan(0.5 * Math.min(0.35, bendA)) + Math.tan(0.5 * Math.min(0.35, bendB)));
      const d = Math.max(24.2, Math.min(40.35, chordL + miterPad));
      const mx = 0.5 * (joints[i][0] + joints[i + 1][0]);
      const mz = 0.5 * (joints[i][1] + joints[i + 1][1]);
      result.set(u.id, {
        x: mx,
        z: mz,
        yaw: Math.atan2(ux, uz),
        w,
        d,
        floor: unifiedFloor,
        jointStart: joints[i],
        jointEnd: joints[i + 1],
        chained: true,
      });
    }
  }
  return result;
}
// How high on a front its pentice is fixed, and the bracket its sign hangs from; a low house carries them lower.
const BOARD_PENTICE_M = 2.75, BOARD_SIGN_M = 3.7, BOARD_STAKE_M = 3.4;
// A stone curtain stands CITY_CURTAIN.height; a palisade this high.
const BOARD_PALISADE_M = 5.5;
// How paved the trodden ways of a place built of earth and timber are (a road of the country is 0.48, a lane 0.35).
const BOARD_EARTH_PAVED = 0.3;
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
  const rivers = widenBoardRivers(board.rivers);
  const bounds = { x0: ox - half, z0: oz - half, x1: ox + half, z1: oz + half };
  const inside = (x, z, pad) => x > bounds.x0 + pad && x < bounds.x1 - pad && z > bounds.z0 + pad && z < bounds.z1 - pad;
  const rr = mulberry((Math.round(port.center.x * 7.3) * 73856093) ^ (Math.round(port.center.z * 5.1) * 19349663) ^ (board.seed | 0) ^ 0x2b0a4d17);
  const blocks = [], typed = [], typedTypes = [], typedBlocks = [], gates = [], lots = [], churches = [];
  // How many of the types stood just after a building are fixed to it (its pentice, sign, ale-stake): they are
  // no targets of their own, and go when it is shot down.
  const attached = new Map();
  const solids = makeHash(32), placed = makeHash(16), segs = makeHash(24), riverSegs = makeHash(32);
  const keep = (f, r = Math.hypot(f.w, f.d) / 2) => solids.add(f, f.x - r, f.z - r, f.x + r, f.z + r);
  const hitsRiverCorridor = (fp, pad = 0) => riverSegs.some(
    fp.x,
    fp.z,
    Math.hypot(fp.w, fp.d) * 0.5 + 16 + pad,
    (g) => segRectDist(fp, g.ax, g.az, g.bx, g.bz) < g.hw + pad
  );
  const { seatBlock, pushBlock, pushTyped, fit, sections, seatRun, fence: layFence, curtain, tower, bastion, gate } = cityMasonry({ heightAt, blocks, typed, typedTypes, typedBlocks, gates, keep, rr });
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
      const lane = street.kind === 'lane' || street.kind === 'alley', st = { pts, hw: Math.max(1.2, street.half), kind: street.kind, place: at, paved: place.earthen ? BOARD_EARTH_PAVED : lane ? 0.5 : 1 };
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
      // A market is paved and a green grassed; any other open place of the model (a dance ground, a plaza, an ocara) is
      // bare trodden ground.
      const square = { x: ox + sq.x, z: oz + sq.z, rad, R, mean, kind: sq.kind === 'green' ? 'park' : sq.kind === 'market' ? 'square' : 'ground', place: at };
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
  // Register every river channel corridor with bank safety clearance so streets, plots, and blocks never stand in flowing water.
  for (const river of rivers) {
    const pts = river?.points;
    if (!pts || pts.length < 6) continue;
    for (let k = 0; k + 5 < pts.length; k += 3) {
      const ax = ox + pts[k], az = oz + pts[k + 1], bx = ox + pts[k + 3], bz = oz + pts[k + 4];
      const hw = Math.max(2.8, (pts[k + 2] + pts[k + 5]) * 0.5) + 2.8;
      const g = { ax, az, bx, bz, hw, river: true };
      riverSegs.add(g, Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw);
    }
  }
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
  // going up: which stretches stand so far. A stone circuit of the Italian trace has its angled bastions `bastionEvery`
  // metres apart along each standing run, as the model draws its trace, none within CITY_BASTION.clear of a run's end
  // or beside a gate; a tower stands where a bastion does not.
  const ring = (cx, cz, rad, kind, gateAngles, stoneHeight, towerEvery = 56, stone = true, built = null, bastionEvery = 0) => {
    const n = rad.length, pts = [], first = gates.length;
    for (let k = 0; k < n; k++) {
      const a = k / n * 2 * Math.PI, x = cx + Math.cos(a) * rad[k], z = cz + Math.sin(a) * rad[k];
      const dryPt = inside(x, z, 20) && heightAt(x, z) > 1.4 && !hitsRiverCorridor(footprint(x, z, 8, 8, 0), 0);
      pts.push({ x, z, stone, open: (kind && kind[k] === BOARD_WALL_CLIFF) || (built && !built[k]) || !dryPt || taken(footprint(x, z, 6, 6, 0), 2) });
    }
    for (const angle of gateAngles) {
      const at = ((angle / (2 * Math.PI) * n) % n + n) % n, k = Math.floor(at), f = at - k, a = pts[k], b = pts[(k + 1) % n];
      if (a.open || b.open) continue;
      gates.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, half: 3.4, k });
    }
    const flanked = [];
    if (stone && bastionEvery > 0) {
      const step = (k) => Math.hypot(pts[(k + 1) % n].x - pts[k].x, pts[(k + 1) % n].z - pts[k].z);
      // How far along its run each point stands from the run's open ends, behind and ahead (all the way round when none).
      const behind = new Float32Array(n).fill(Infinity), ahead = new Float32Array(n).fill(Infinity);
      for (let k = 0; k < n; k++) {
        if (pts[k].open) continue;
        for (let j = 1, d = 0; j < n; j++) { const p = (k - j + n) % n; d += step(p); if (pts[p].open) { behind[k] = d; break; } }
        for (let j = 1, d = 0; j < n; j++) { const p = (k + j) % n; d += step((p + n - 1) % n); if (pts[p].open) { ahead[k] = d; break; } }
      }
      let along = bastionEvery;
      for (let k = 0; k < n; k++) {
        const a = pts[k], b = pts[(k + 1) % n], prev = pts[(k + n - 1) % n];
        if (a.open) { along = bastionEvery; continue; }
        along += step((k + n - 1) % n);
        if (along < bastionEvery || Math.min(behind[k], ahead[k]) < CITY_BASTION.clear) continue;
        const tl = Math.hypot(b.x - prev.x, b.z - prev.z) || 1, tx = (b.x - prev.x) / tl, tz = (b.z - prev.z) / tl;
        const side = (-tz * (a.x - cx) + tx * (a.z - cz)) >= 0 ? 1 : -1, ox = -tz * side, oz = tx * side, half = CITY_BASTION.half;
        if (gates.some((q) => Math.hypot(q.x - a.x, q.z - a.z) < q.half + half + CITY_GATE.reach)) continue;
        const reach = footprint(a.x + ox * half, a.z + oz * half, 2 * half, 2 * half, Math.atan2(oz, -ox));
        if (!inside(reach.x, reach.z, 20) || heightAt(a.x + ox * 2 * half, a.z + oz * 2 * half) <= 1.4 || hitsRiverCorridor(reach, 0) || taken(reach, 1)) continue;
        bastion(a.x, a.z, ox, oz, half, stoneHeight, 0.84 + rr() * 0.1);
        flanked.push({ x: a.x, z: a.z, half });
        along = 0;
      }
    }
    let since = towerEvery;
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[(k + 1) % n], prev = pts[(k + n - 1) % n];
      if (a.open) { since = towerEvery; continue; }
      const height = a.stone ? stoneHeight : BOARD_PALISADE_M;
      const nearGate = gates.some((q) => Math.hypot(q.x - a.x, q.z - a.z) < q.half + 9) || flanked.some((q) => Math.hypot(q.x - a.x, q.z - a.z) < q.half + 6);
      if (a.stone && !nearGate && (since >= towerEvery || prev.open || b.open)) { tower(a.x, a.z, 6.2, height + 3.5 + rr() * 1.5, 0.86 + rr() * 0.12); since = 0; }
      if (b.open) continue;
      const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
      if (hitsRiverCorridor(footprint(mx, mz, Math.hypot(b.x - a.x, b.z - a.z), 4, Math.atan2(b.x - a.x, b.z - a.z)), 0)) {
        since = towerEvery;
        continue;
      }
      curtain(a.x, a.z, b.x, b.z, [a.x - cx, a.z - cz], height, a.stone ? 0.84 + rr() * 0.1 : 0.62 + rr() * 0.08);
      since += Math.hypot(b.x - a.x, b.z - a.z);
    }
    for (let g = first; g < gates.length; g++) {
      const q = gates[g], a = pts[q.k], b = pts[(q.k + 1) % n], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      gate(q, (b.x - a.x) / L, (b.z - a.z) / L);
    }
  };
  // How long a ring of radii, one to each bearing, runs about its centre.
  const circuitLength = (rad) => { let L = 0; for (let k = 0, n = rad.length; k < n; k++) { const a = k / n * 2 * Math.PI, b = (k + 1) / n * 2 * Math.PI; L += Math.hypot(Math.cos(b) * rad[(k + 1) % n] - Math.cos(a) * rad[k], Math.sin(b) * rad[(k + 1) % n] - Math.sin(a) * rad[k]); } return L; };
  // A place built of earth and timber is ringed by a palisade of stakes (js/native-works.js), stood a section at a time
  // along the model's circuit, whole metres of its stakes, each on its own ground; open where the model has a gate,
  // where a way runs through it, over water and where the cliff is the wall.
  let palisadeLengths = 0;
  const stakes = (cx, cz, rad, kind, gateAngles, standing = null) => {
    const n = rad.length, corner = (k) => { const a = (k % n) / n * 2 * Math.PI; return [cx + Math.cos(a) * rad[k % n], cz + Math.sin(a) * rad[k % n]]; };
    const openings = gateAngles.map((angle) => { const at = ((angle / (2 * Math.PI) * n) % n + n) % n, k = Math.floor(at), f = at - k, [ax, az] = corner(k), [bx, bz] = corner(k + 1); return [ax + (bx - ax) * f, az + (bz - az) * f]; });
    const per = 3, unit = per * NATIVE_PALISADE.stake, counts = NATIVE_PALISADE.stakes.map((stakes) => stakes / per), width = CITY_BUILDING_TYPES[CITY_TYPE.PALISADE].width;
    for (let k = 0; k < n; k++) {
      if ((kind && kind[k] === BOARD_WALL_CLIFF) || (standing && !standing[k])) continue;
      const [ax, az] = corner(k), [bx, bz] = corner(k + 1);
      if (Math.hypot(bx - ax, bz - az) < 0.5) continue;
      for (const run of sections(ax, az, bx, bz, { unit, counts, past: 0.1, cover: true, sink: 0.35 })) {
        const { x, z, yaw, half, ux, uz } = run, x0 = x - ux * half, z0 = z - uz * half, x1 = x + ux * half, z1 = z + uz * half;
        if (!inside(x, z, 20) || heightAt(x, z) <= BOARD_DRY_M || hitsRiverCorridor(footprint(x, z, 1.2, 2 * half, yaw), 0)) continue;
        if (openings.some(([gx, gz]) => Math.hypot(gx - x, gz - z) < 3.4 + half)) continue;
        if ([[x0, z0], [x, z], [x1, z1]].some(([px, pz]) => streetEdge(px, pz, 3) < 0.6)) continue;
        const f = footprint(x, z, width, 2 * half, yaw);
        if (taken(f, 0.3)) continue;
        pushTyped(cityVariant(CITY_TYPE.PALISADE, null, 2 * half), x, seatRun(run), z, yaw, 0.5, 0);
        keep(f); palisadeLengths++;
      }
    }
  };
  for (const place of places) {
    if (place.wall && place.earthen) stakes(place.x, place.z, place.wall.rad, place.wall.kind, place.wall.gates, place.wall.built ?? null);
    else if (place.wall) ring(place.x, place.z, place.wall.rad, place.wall.kind, place.wall.gates, CITY_CURTAIN.height, 56, place.walls >= 2 || place.wall.bastions, place.wall.built ?? null, place.wall.bastions ? CITY_BASTION.every : 0);
    const hill = place.castle?.hill, citadel = place.castle?.citadel;
    if (hill?.rad?.length) ring(ox + hill.x, oz + hill.z, hill.rad, hill.kind, [hill.gate], Math.max(7.5, hill.height || 0) + 2, 40, hill.walls >= 2 && !hill.timber);
    // The model's citadel is a bastioned work: a bastion to each quarter of its circuit.
    if (citadel?.rad?.length) ring(ox + citadel.x, oz + citadel.z, citadel.rad, null, [citadel.gate], 9.5, 48, true, null, circuitLength(citadel.rad) / 4);
  }

  /* ---- buildings: each one the model stood, as this game's type of that size, turned to its street ---- */
  const { count, stand, form, kinds } = board.buildings, arches = board.arches;
  const market = board.quarters?.indexOf('market') ?? -1, quarter = board.buildings.quarter ?? null;
  let houses = 0, fronts = 0, stalls = 0;
  const works = board.works ?? {}, stateOf = board.buildings.state ?? null, wheelOf = new Map();
  for (let w = 0; w + 2 < (works.wheels?.length ?? 0); w += 3) wheelOf.set(works.wheels[w], [ox + works.wheels[w + 1], oz + works.wheels[w + 2]]);
  const built = { thatched: 0, native: 0, palisade: palisadeLengths, roadBridges: 0, dams: 0, windmills: 0, watermills: 0, wheels: 0, stores: 0, sheds: 0, halls: 0, others: 0, ruins: 0, fences: 0, bridges: 0, yards: 0, graves: 0, cairns: 0, tents: 0, standards: 0, scaffolds: 0 };
  // The wash of a house, its own from where it stands in the model's list.
  const washOf = (k) => { const hue = form[k * 3 + 2]; return BOARD_HOUSE_TINTS[Math.floor(boardHashUnit(k, 23) * BOARD_HOUSE_TINTS.length)] + 0.2 + 0.75 * (hue > 0 && hue < 1 ? hue : boardHashUnit(k, 31)); };
  // A thing of the street: a type stood as it is written, with no block of its own; of its family, the one as broad
  // as `across` if that is asked.
  const furnish = (type, x, y, z, yaw, paint, tone, across = null) => pushTyped(cityVariant(type, across), x, y, z, yaw, paint + 0.3 + 0.65 * tone, 0);
  const placeWallRadiusAt = (pl, wx, wz) => {
    const rad = pl?.wall?.rad;
    if (!rad?.length) return pl?.reach || pl?.radius || Infinity;
    const n = rad.length, a = Math.atan2(wz - pl.z, wx - pl.x) / (2 * Math.PI) * n, i = Math.floor(a), f = a - i;
    return rad[((i % n) + n) % n] * (1 - f) + rad[(((i + 1) % n) + n) % n] * f;
  };
  const royalAnchors = [];
  for (const pl of places) {
    if (pl?.castle?.keep) royalAnchors.push({ x: ox + pl.castle.keep.x, z: oz + pl.castle.keep.z });
  }
  for (const inst of port.instances ?? []) {
    if (/Royal Palace|Waterfront Palace/i.test(inst?.label || '')) {
      royalAnchors.push({ x: inst.x, z: inst.z });
    }
  }
  if (seat?.kind === 'capital') royalAnchors.push({ x: seat.x, z: seat.z });
  const nearRoyalOrKeep = (wx, wz) => {
    for (let i = 0; i < royalAnchors.length; i++) {
      if (Math.hypot(wx - royalAnchors[i].x, wz - royalAnchors[i].z) <= 180) return true;
    }
    return false;
  };

  // The street front of a house of trade: fixed to its front wall (`f`, the house as it is drawn), hung out over the street.
  const standFront = (k, f, floor, wallH, extraMural = false) => {
    const arch = arches[kinds[k * 6 + 1]], look = BOARD_STREETFRONT[arch === 'burgher' && quarter && quarter[k] === market ? 'shop' : arch];
    if (!look) return;
    // Suppress urban retail shop-awnings on extra-mural country road spokes; wayside inns/smithies keep only signs or bushes.
    if (extraMural && !look.sign && !look.bush) return;
    const hue = form[k * 3 + 2], hu = hue > 0 && hue < 1 ? hue : boardHashUnit(k, 31), side = hu > 0.5 ? 1 : -1;
    // Under the eaves of a house of one floor; never so near the ground that a head meets them.
    const penticeY = Math.min(BOARD_PENTICE_M, Math.max(2.25, wallH - 0.7)), signY = Math.min(BOARD_SIGN_M, Math.max(2.7, wallH - 0.3)), stakeY = Math.min(BOARD_STAKE_M, Math.max(2.9, wallH - 0.3));
    if (look.awn && !extraMural) { const [x, z] = local(f, 0, -f.d / 2); furnish(CITY_TYPE.PENTICE, x, floor + penticeY, z, f.yaw, look.awn === true ? BOARD_CLOTHS[Math.floor(hu * 5)] : look.awn, boardHashUnit(k, 67), f.w - CITY_PENTICE.inset); }
    if (look.sign) { const [x, z] = local(f, f.w * 0.36 * side, -f.d / 2); furnish(CITY_TYPE.SIGN, x, floor + signY, z, f.yaw, look.sign, boardHashUnit(k, 71)); }
    if (look.bush) { const [x, z] = local(f, -f.w * 0.36 * side, -f.d / 2); furnish(CITY_TYPE.ALE_STAKE, x, floor + stakeY, z, f.yaw, CITY_PAINT.GREEN, boardHashUnit(k, 73)); }
    fronts++;
  };
  // A house on its plot `f`: of its storeys, ridge and manner, the size that best fills the plot, fronted on its street.
  // Its storeys are their own height; a house outside the walls is of one.
  const standHouse = (k, f, storeys, toStreet, mannered = true, { extraMural = false, royalProximity = false } = {}) => {
    // A broad front keeps its eaves to the street; a narrow, deep plot more often turns its gable to it.
    const eaves = boardHashUnit(k, 47) < (f.w >= f.d * 0.8 ? 0.85 : 0.5);
    const { type, T, at } = fit(cityHouseType(extraMural ? 1 : storeys, eaves, (mannered && !extraMural) ? (royalProximity ? 0.85 : boardHashUnit(k, 53)) : 0), f, toStreet);
    const base = seatBlock(at, toStreet ? heightAt(at.x - Math.sin(at.yaw) * (at.d / 2 + 1.5), at.z - Math.cos(at.yaw) * (at.d / 2 + 1.5)) : null);
    if (base.range > 7.5) { dropped.steep++; return; }
    const tone = royalProximity ? (0.90 + boardHashUnit(k, 29) * 0.09) : washOf(k);
    const wallMat = royalProximity ? (boardHashUnit(k, 63) < 0.45 ? CITY_WALL.ASHLAR : CITY_WALL.STUCCO) : CITY_WALL.HOUSE;
    if (eaves) pushBlock(footprint(f.x, f.z, f.d, f.w, f.yaw + Math.PI / 2), T.height, 0.36 * T.length / 2, CITY_ROOF.GABLE + CITY_TYPED_ROOF, wallMat, tone, base);
    else pushBlock(f, T.height, 0.5 * T.width / 2, CITY_ROOF.GABLE + CITY_TYPED_ROOF, wallMat, tone, base);
    pushTyped(type, at.x, base.floor, at.z, at.yaw, tone);
    occupy(at); houses++;
    const house = typedTypes.length - 1;
    if (toStreet) standFront(k, at, base.floor, T.height, extraMural);
    if (typedTypes.length - 1 > house) attached.set(house, typedTypes.length - 1 - house);
  };
  // A church on its plot, its length running back from its door: of the breadths and nave bays it is built in, the
  // one that best fills the plot (never less than a parish's nave of three bays).
  const standChurch = (k, f, great) => {
    const family = great ? CITY_TYPE.CHURCH_GREAT : boardHashUnit(k, 7) < 0.5 ? CITY_TYPE.CHURCH_LEFT : CITY_TYPE.CHURCH_RIGHT;
    const plot = footprint(f.x, f.z, Math.max(CITY_CHURCH.parish[0].width, f.w), Math.max(18, f.d), f.yaw);
    const { type, T, at: nave } = fit(family, plot), C = great ? CITY_CHURCH.great : CITY_CHURCH.parish.find((P) => P.width === T.width);
    const base = seatBlock(nave), tone = 0.94 + boardHashUnit(k, 5) * 0.06;
    if (base.range > 9) { dropped.steep++; return; }
    pushBlock(nave, T.height, 0.42 * T.width / 2 + 0.6, CITY_ROOF.GABLE + CITY_TYPED_ROOF, great ? CITY_WALL.ASHLAR : CITY_WALL.STUCCO, tone, base);
    const sides = great ? [-1, 1] : [family === CITY_TYPE.CHURCH_LEFT ? -1 : 1];
    for (const side of sides) {
      const [tx, tz] = local(nave, side * (T.width / 2 + C.tower / 2 - 0.3), -T.length / 2 + C.tower / 2), top = seatBlock(footprint(tx, tz, C.tower, C.tower, f.yaw));
      blocks.push(tx, base.floor, tz, f.yaw, C.tower, C.tower, C.height + CITY_CHURCH.towerRise, CITY_CHURCH.spire, CITY_ROOF.PYRAMID + CITY_TYPED_ROOF, CITY_WALL.ASHLAR, 0.93, Math.max(top.plinth, base.floor - top.floor + top.plinth));
    }
    pushTyped(type, nave.x, base.floor, nave.z, f.yaw, tone, 1 + sides.length);
    const whole = footprint(nave.x, nave.z, T.width + 2 * C.tower, T.length, f.yaw);
    keep(whole); occupy(whole);
    churches.push({ x: nave.x, z: nave.z, great });
  };
  // One of the model's works that is no house: of its kind, the size that best fills the plot the model gave it,
  // fronted on its street where it has one.
  const standWork = (k, f, arch, toStreet, as = BOARD_WORKS[arch], wharfOverride = null) => {
    const [key, roof, wall, rise, ridgeAlong, fronted] = as;
    const thatch = key === 'COT' || as === BOARD_THATCHED[arch] || as[6] ? CITY_THATCH_ROOF : 0;
    const { type, T, at: g } = fit(CITY_TYPE[key], f, toStreet && key !== 'WHARF');
    if (key === 'WHARF') g.isWharf = true;
    const base = key === 'WHARF' ? { floor: wharfOverride?.floor ?? Math.max(BOARD_WHARF_M, heightAt(g.x, g.z)), plinth: 0.3, range: 0 }
      : seatBlock(g, toStreet ? heightAt(g.x - Math.sin(g.yaw) * (g.d / 2 + 1.5), g.z - Math.cos(g.yaw) * (g.d / 2 + 1.5)) : null);
    if (base.range > 9) { dropped.steep++; return; }
    const hu = boardHashUnit(k, 31), paint = arch === 'tannery' ? CITY_PAINT.BROWN : arch === 'dyer' ? BOARD_CLOTHS[Math.floor(hu * 5)] : arch === 'toll' ? CITY_PAINT.RED : -1;
    const tone = paint >= 0 ? paint + 0.3 + 0.65 * hu : key === 'WINDMILL' || key === 'DOVECOTE' || key === 'WHARF' ? 0.2 + 0.75 * hu : washOf(k);
    // Its plot's block: the quarry's is its face, a wharf's its deck.
    const Far = key === 'QUARRY' ? footprint(...local(g, 0, g.d * 0.3), g.w, g.d * 0.4, g.yaw) : ridgeAlong ? footprint(g.x, g.z, g.d, g.w, g.yaw + Math.PI / 2) : g;
    pushBlock(Far, key === 'WHARF' ? 0.05 : key === 'QUARRY' ? 1.3 : T.height, rise, roof + CITY_TYPED_ROOF + thatch, wall, wall === 19 || paint < 0 && wall === 12 ? tone : 0.86 + 0.1 * hu, base);
    pushTyped(type, g.x, base.floor, g.z, g.yaw, tone);
    if (thatch) g.thatch = true;
    keep(g); occupy(g);
    const stood = typedTypes.length - 1;
    if (fronted && toStreet) standFront(k, g, base.floor, T.height);
    if (typedTypes.length - 1 > stood) attached.set(stood, typedTypes.length - 1 - stood);
    if (key === 'WINDMILL') built.windmills++; else if (key === 'WATERMILL') built.watermills++; else if (key === 'GRANARY' || key === 'BARN') built.stores++; else if (key === 'SHED') built.sheds++; else if (key === 'STONE_HALL') built.halls++; else if (as[6]) { built.native++; houses++; } else if (thatch && key !== 'COT') { built.thatched++; houses++; } else built.others++;
  };
  // What is left of a building the model has burnt to its walls (a ruin, a house's bays and depth) or thrown down (a heap).
  const standLeft = (k, f, heap) => {
    const { type, at } = fit(heap ? CITY_TYPE.RUBBLE : CITY_TYPE.RUIN, f), base = seatBlock(at);
    if (base.range > 9) { dropped.steep++; return; }
    const tone = washOf(k);
    pushBlock(at, heap ? 0.6 : 2.4, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, heap ? 11 : 12, heap ? 0.8 : tone, base);
    pushTyped(type, at.x, base.floor, at.z, at.yaw, tone);
    occupy(at); built.ruins++;
  };
  const wayClearance = (fp) => {
    let minC = Infinity, pushX = 0, pushZ = 0, roadHit = false;
    let minRiverC = Infinity, riverPushX = 0, riverPushZ = 0;
    const Reach = Math.hypot(fp.w, fp.d) * 0.5 + 22;
    const dirFromSeg = (g) => {
      const dx = g.bx - g.ax, dz = g.bz - g.az, l2 = dx * dx + dz * dz;
      const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((fp.x - g.ax) * dx + (fp.z - g.az) * dz) / l2)) : 0;
      const px = g.ax + dx * t, pz = g.az + dz * t, ox0 = fp.x - px, oz0 = fp.z - pz, L = Math.hypot(ox0, oz0);
      if (L > 1e-4) return [ox0 / L, oz0 / L];
      if (l2 > 1e-4) { const inv = 1 / Math.sqrt(l2); return [-dz * inv, dx * inv]; }
      return [0, 0];
    };
    segs.some(fp.x, fp.z, Reach, (g) => {
      const c = segRectDist(fp, g.ax, g.az, g.bx, g.bz) - g.hw;
      if (c < minC) {
        minC = c;
        roadHit = Boolean(g.road);
        [pushX, pushZ] = dirFromSeg(g);
      }
      return false;
    });
    riverSegs.some(fp.x, fp.z, Reach, (g) => {
      const c = segRectDist(fp, g.ax, g.az, g.bx, g.bz) - g.hw;
      if (c < minRiverC) {
        minRiverC = c;
        [riverPushX, riverPushZ] = dirFromSeg(g);
      }
      if (c < minC) {
        minC = c;
        roadHit = false;
        [pushX, pushZ] = dirFromSeg(g);
      }
      return false;
    });
    return { clearance: minC, pushX, pushZ, roadHit, riverClearance: minRiverC, riverPushX, riverPushZ };
  };

  // Pre-align waterfront wharves along local sea/river shoreline contours (`∇inland` tangent) so adjacent
  // wharf lots chain corner-to-corner with level decks instead of scattering as staggered boxes.
  const rawWharves = [];
  for (let k = 0; k < count; k++) {
    if (arches[kinds[k * 6 + 1]] !== 'wharf' || (stateOf && stateOf[k])) continue;
    const wx = ox + stand[k * 6], wz = oz + stand[k * 6 + 1];
    if (!inside(wx, wz, 12)) continue;
    rawWharves.push({
      index: k,
      place: kinds[k * 6],
      x: wx,
      z: wz,
      rot: stand[k * 6 + 2],
      w: stand[k * 6 + 3],
      d: stand[k * 6 + 4],
    });
  }
  let wharfOverrides = null;
  if (rawWharves.length > 0) {
    const wharfWet = new Uint8Array(wet);
    for (const river of rivers) {
      const pts = river?.points;
      if (!pts || pts.length < 6) continue;
      for (let k = 0; k + 5 < pts.length; k += 3) {
        const ax = ox + pts[k], az = oz + pts[k + 1], bx = ox + pts[k + 3], bz = oz + pts[k + 4];
        const hw = Math.max(2.0, (pts[k + 2] + pts[k + 5]) * 0.5);
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - grid.x0) / grid.step));
        const i1 = Math.min(grid.n - 1, Math.ceil((Math.max(ax, bx) + hw - grid.x0) / grid.step));
        const j0 = Math.max(0, Math.floor((Math.min(az, bz) - hw - grid.z0) / grid.step));
        const j1 = Math.min(grid.n - 1, Math.ceil((Math.max(az, bz) + hw - grid.z0) / grid.step));
        for (let j = j0; j <= j1; j++) {
          const gz = grid.z0 + j * grid.step;
          for (let i = i0; i <= i1; i++) {
            if (segDist(grid.x0 + i * grid.step, gz, ax, az, bx, bz) <= hw) wharfWet[j * grid.n + i] = 1;
          }
        }
      }
    }
    const wharfInland = distanceTo(wharfWet, grid.n, grid.step);
    wharfOverrides = alignWaterfrontWharves(rawWharves, {
      inlandAt: (px, pz) => fieldAt(wharfInland, grid, px, pz),
      heightAt,
      minDeckY: BOARD_WHARF_M,
    });
  }
  const wharfTaken = (fp) => solids.some(
    fp.x,
    fp.z,
    Math.hypot(fp.w, fp.d) / 2 + 34,
    (o) => cityFootprintsOverlap(fp, o, o.isWharf ? -1.5 : 0.8),
  );

  for (let k = 0; k < count; k++) {
    const place = kinds[k * 6], arch = arches[kinds[k * 6 + 1]], church = kinds[k * 6 + 4];
    const wharfAlign = arch === 'wharf' && wharfOverrides ? wharfOverrides.get(k) : null;
    const x = wharfAlign ? wharfAlign.x : ox + stand[k * 6];
    const z = wharfAlign ? wharfAlign.z : oz + stand[k * 6 + 1];
    const rot = wharfAlign ? wharfAlign.yaw : stand[k * 6 + 2];
    const w = wharfAlign ? wharfAlign.w : stand[k * 6 + 3];
    const d = wharfAlign ? wharfAlign.d : stand[k * 6 + 4];
    const h = stand[k * 6 + 5];
    if (!inside(x, z, 12)) { dropped.edge++; continue; }
    if (heightAt(x, z) < BOARD_DRY_M && arch !== 'wharf') { dropped.wet++; continue; }
    // Turned so that its own back (+z) is away from its street; a quarter turn swaps its front and depth.
    const fx = wharfAlign ? 0 : form[k * 3], fz = wharfAlign ? 0 : form[k * 3 + 1];
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
    let bx = x, bz = z;
    if (wheel) {
      let best = 0, most = -Infinity;
      for (let q = 0; q < 4; q++) { const a = rot + q * Math.PI / 2, toward = (wheel[0] - x) * Math.cos(a) - (wheel[1] - z) * Math.sin(a); if (toward > most) { most = toward; best = q; } }
      yaw = rot + best * Math.PI / 2; front = best & 1 ? d : w; depth = best & 1 ? w : d;
      // Stood so far toward that water as brings its wheel there: the mill is its one size.
      const shift = Math.max(0, most - CITY_BUILDING_TYPES[CITY_TYPE.WATERMILL].width / 2 - WORKS_WHEEL.out);
      bx += Math.cos(yaw) * shift; bz -= Math.sin(yaw) * shift;
      built.wheels++;
    }
    let f = footprint(bx, bz, front, depth, yaw);
    const keepClearOfWater = arch !== 'mill' && arch !== 'wharf' && arch !== 'bridge';
    if (keepClearOfWater && arch !== 'wall' && arch !== 'tower' && arch !== 'keep') {
      let wc = wayClearance(f);
      if (wc.clearance < -0.35 || hitsRiverCorridor(f, 0)) {
        for (const step of [0.8, 1.8, 3.0, 4.5, 6.5, 9.0, 12.0, 15.5, 19.5]) {
          const inRiver = hitsRiverCorridor(f, 0);
          const pxDir = inRiver && (wc.riverPushX || wc.riverPushZ) ? wc.riverPushX : wc.pushX;
          const pzDir = inRiver && (wc.riverPushX || wc.riverPushZ) ? wc.riverPushZ : wc.pushZ;
          const cx = x + pxDir * step, cz = z + pzDir * step;
          if (!inside(cx, cz, 12) || heightAt(cx, cz) < BOARD_DRY_M) continue;
          const cand = footprint(cx, cz, front, depth, yaw);
          if (taken(cand, 0.8) || hitsRiverCorridor(cand, 0)) continue;
          const nextWc = wayClearance(cand);
          if (hitsRiverCorridor(f, 0) || nextWc.clearance > wc.clearance + 0.25) {
            bx = cx; bz = cz; f = cand; wc = nextWc;
            if (!hitsRiverCorridor(f, 0) && wc.clearance >= -0.35) break;
          }
        }
        if (hitsRiverCorridor(f, 0)) { dropped.wet++; continue; }
        if (wc.clearance < -0.95 || (wc.roadHit && wc.clearance < -0.45)) { dropped.port++; continue; }
      }
    } else if (keepClearOfWater && hitsRiverCorridor(f, -1.0)) {
      dropped.wet++;
      continue;
    }
    if (arch === 'wharf' ? wharfTaken(f) : taken(f, 0.8)) { dropped.port++; continue; }
    const left = stateOf ? stateOf[k] : 0;
    if (left) standLeft(k, f, left === 3);
    else if (arch === 'tower') {
      occupy(tower(bx, bz, 6.2, Math.max(10, Math.min(15, h)), 0.9));
    } else if (arch === 'wall') {
      // A length of wall the model stood by itself: its parapet toward the street it faces, or outward from the place.
      const long = Math.max(w, d) / 2, a = rot + (w >= d ? 0 : Math.PI / 2), ux = Math.cos(a), uz = -Math.sin(a), p = places[place] ?? seat;
      curtain(bx - ux * long, bz - uz * long, bx + ux * long, bz + uz * long, fx || fz ? [fx, fz] : [bx - p.x, bz - p.z], CITY_CURTAIN.height, 0.86);
    } else if (BOARD_WORKS[arch]) standWork(k, f, arch, Boolean(fx || fz), BOARD_WORKS[arch], wharfAlign);
    else if (arch === 'temple') {
      // A church's length runs back from its door.
      const long = front > depth ? footprint(bx, bz, depth, front, yaw + Math.PI / 2) : f;
      standChurch(k, long, (church & 3) === 3);
    } else if (arch === 'keep') {
      occupy(tower(bx, bz, Math.max(9, Math.min(14, Math.max(w, d))), Math.max(18, h), 0.95, CITY_TYPE.KEEP));
    } else if (arch === 'hall') {
      const { type, T, at } = fit(CITY_TYPE.HALL, front > depth ? footprint(bx, bz, depth, front, yaw + Math.PI / 2) : f);
      const floor = pushBlock(at, T.height, CITY_HALL.roof, CITY_ROOF.HIP + CITY_TYPED_ROOF, CITY_WALL.HOUSE, 0.9);
      pushTyped(type, at.x, floor, at.z, at.yaw, 0.9);
      keep(at); occupy(at);
    } else if (kinds[k * 6 + 2] === 0 && BOARD_THATCHED[arch]) {
      standWork(k, f, arch, Boolean(fx || fz), BOARD_THATCHED[arch]);
    } else {
      // The model builds low: a house of one or two floors, and so stood most of an Iberian port of the sixteenth
      // century. Toward the seat's middle they gain a floor; four were the merchants' houses of its middle streets,
      // and five the tallest of those (the Rua Nova's "three, four and even five").
      let storeys = Math.max(1, Math.min(2, Math.round(h / CITY_STOREY_M)));
      const plain = arch === 'shed' || arch === 'longhouse';
      const pl = places[place] ?? seat;
      const wallR = placeWallRadiusAt(pl, bx, bz);
      const distFromCenter = Math.hypot(bx - pl.x, bz - pl.z);
      const extraMural = Boolean(pl?.wall?.rad?.length && distFromCenter > wallR * 1.05);
      const royalProximity = !plain && !extraMural && nearRoyalOrKeep(bx, bz);
      if (plain || extraMural) storeys = 1;
      else if (royalProximity) {
        const lot = boardHashUnit(k, 59);
        storeys = Math.max(storeys, lot < 0.45 ? 4 : 3);
      } else if (place === 0 && seat.reach > 0) {
        const near = 1 - Math.hypot(bx - seat.x, bz - seat.z) / seat.reach, lot = boardHashUnit(k, 59), merchant = arch === 'burgher' || arch === 'shop';
        if (near > 0.72) storeys = merchant ? (lot < 0.1 ? 5 : lot < 0.4 ? 4 : 3) : lot < 0.55 ? 3 : 2;
        else if (near > 0.4) storeys = Math.min(3, storeys + (lot < (merchant ? 0.5 : 0.25) ? 1 : 0));
      }
      standHouse(k, f, Math.min(CITY_HOUSE_STOREYS, storeys), fx || fz, !plain && !extraMural, { extraMural, royalProximity });
    }
  }

  /* ---- the open places: a well on a green; on a market place its cross, and stalls round it ---- */
  const open = (x, z, reach) => inside(x, z, 8) && heightAt(x, z) > BOARD_DRY_M && !hitsRiverCorridor(footprint(x, z, reach, reach, 0), -1.0) && !taken(footprint(x, z, reach, reach, 0), 0.5) && !placed.some(x, z, reach, (o) => rectDist(o, x, z) <= reach * 0.5);
  squares.forEach((p, at) => {
    if (p.kind === 'ground') return;
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
  const slight = (type, x, y, z, yaw, tone = 0.5) => pushTyped(type, x, y, z, yaw, tone, 0);
  const dry = (x, z, pad = 6) => inside(x, z, pad) && heightAt(x, z) > BOARD_DRY_M && !hitsRiverCorridor(footprint(x, z, 6, 6, 0), 1.0);
  // A run of fence from one point to another, a section at a time, each on its own ground; none where a building
  // stands or a street runs through.
  const spans = works.trackBridges ?? [];
  const roadCrossings = boardRoadCrossings(board.roads, rivers, board.places);
  const portBridges = (port.instances ?? []).filter((inst) => inst?.prefabId === 'stone_arch_bridge');
  const measureRiverCrossingAt = (bx, bz, ux, uz) => {
    const lx = bx - ox, lz = bz - oz;
    let bestD = 32, best = null;
    for (const river of rivers) {
      const pts = river?.points;
      if (!pts || pts.length < 6) continue;
      for (let j = 0; j + 5 < pts.length; j += 3) {
        const cx = pts[j], cz = pts[j + 1], dx = pts[j + 3], dz = pts[j + 4];
        const rx = dx - cx, rz = dz - cz, l2 = rx * rx + rz * rz;
        const u = l2 > 1e-6 ? Math.max(0, Math.min(1, ((lx - cx) * rx + (lz - cz) * rz) / l2)) : 0;
        const px = cx + rx * u, pz = cz + rz * u, d = Math.hypot(lx - px, lz - pz);
        if (d < bestD) {
          bestD = d;
          const hw = pts[j + 2] + (pts[j + 5] - pts[j + 2]) * u;
          const rLen = Math.sqrt(l2) || 1;
          const sine = Math.abs(ux * rz - uz * rx) / rLen;
          const s0 = Math.floor(j / 3), s1 = s0 + 1;
          const lv0 = Number.isFinite(river.levels?.[s0]) ? river.levels[s0] : heightAt(ox + cx, oz + cz) - 0.55;
          const lv1 = Number.isFinite(river.levels?.[s1]) ? river.levels[s1] : heightAt(ox + dx, oz + dz) - 0.55;
          const wy = Math.max(0.05, lv0 + (lv1 - lv0) * u);
          best = { hw, span: (2 * hw) / Math.max(0.42, sine), wy };
        }
      }
    }
    return best;
  };
  const trackBridgeSpecs = [];
  for (let k = 0; k + 5 < spans.length; k += 6) {
    const x = ox + spans[k], z = oz + spans[k + 1], ux = spans[k + 2], uz = spans[k + 3];
    const crossing = measureRiverCrossingAt(x, z, ux, uz);
    const span = Math.max(6, spans[k + 4], crossing ? crossing.span : 0);
    trackBridgeSpecs.push({ x, z, ux, uz, span, isStone: Boolean(spans[k + 5]), crossing });
  }
  // On a bridge and at its two ±6 m approaches the way is open: no fence is run across it.
  const inBridgeStrip = (x, z, bx, bz, ux, uz, halfLen, halfW) => {
    const dx = x - bx, dz = z - bz;
    return Math.abs(dx * ux + dz * uz) < halfLen && Math.abs(dx * uz - dz * ux) < halfW;
  };
  const bridged = (x, z) => {
    for (const tb of trackBridgeSpecs) {
      if (inBridgeStrip(x, z, tb.x, tb.z, tb.ux, tb.uz, tb.span / 2 + 6, 4.5)) return true;
    }
    for (const q of roadCrossings) {
      const reach = Math.max(4.5, q.span / 2 + 2.6);
      if (inBridgeStrip(x, z, ox + q.x, oz + q.z, q.ux, q.uz, reach + 6, 4.8)) return true;
    }
    for (const pb of portBridges) {
      const ux = Math.sin(pb.yaw ?? 0), uz = Math.cos(pb.yaw ?? 0);
      if (inBridgeStrip(x, z, pb.x, pb.z, ux, uz, (pb.length ?? 24) * 0.5 + 6, (pb.width ?? 9.6) * 0.5 + 2)) return true;
    }
    return false;
  };
  const snapRoadOrStreet = (bx, bz, outX, outZ, halfLen, px, pz, maxDist = 28) => {
    let bestD = maxDist, bestPt = null;
    segs.some(px, pz, maxDist + 16, (g) => {
      const dx = g.bx - g.ax, dz = g.bz - g.az, l2 = dx * dx + dz * dz;
      const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - g.ax) * dx + (pz - g.az) * dz) / l2)) : 0;
      const cx = g.ax + dx * t, cz = g.az + dz * t;
      if ((cx - bx) * outX + (cz - bz) * outZ <= halfLen * 0.45) return;
      const d = Math.hypot(px - cx, pz - cz);
      if (d < bestD) { bestD = d; bestPt = [cx, cz]; }
    });
    return bestPt;
  };
  const stampBridgeApproach = (bx, bz, ux, uz, length, width) => {
    const halfLen = length * 0.5;
    for (const dir of [-1, 1]) {
      const outX = ux * dir, outZ = uz * dir;
      const ex = bx + outX * halfLen, ez = bz + outZ * halfLen;
      const inX = ex - outX * 2.0, inZ = ez - outZ * 2.0;
      const extX = ex + outX * 4.5, extZ = ez + outZ * 4.5;
      const snap = snapRoadOrStreet(bx, bz, outX, outZ, halfLen, extX, extZ, 28);
      const rawPts = [
        [inX, inZ, width, 0.85],
        [ex, ez, width, 0.85],
        [extX, extZ, Math.max(4.4, width * 0.9), 0.72],
        ...(snap ? [[snap[0], snap[1], 5.0, 0.56]] : []),
      ].filter(([qx, qz]) => inside(qx, qz, 4));
      if (rawPts.length >= 2) paving.push({ points: rawPts });
    }
  };
  // Weld/miter torn roadside corners on legacy unmitered baked boards (`(flag & 4) === 0`), split any fence
  // crossing *across* a road/lane carriageway into clean `>= 4.2 m` gateways flanked by terminal posts,
  // preserve 100% of roadside verge fences (`streetEdge >= -0.15`), and pack terrain slope shear (`-100 + dzSlope`).
  const prepareFenceRuns = (raw) => {
    const segList = [];
    for (let k = 0; k + 4 < raw.length; k += 5) {
      const ax = ox + raw[k], az = oz + raw[k + 1], bx = ox + raw[k + 2], bz = oz + raw[k + 3], flag = raw[k + 4] | 0;
      if (Math.hypot(bx - ax, bz - az) < 1.2) continue;
      segList.push({ ax, az, bx, bz, stone: (flag & 1) !== 0, onWay: (flag & 2) !== 0, mitered: (flag & 4) !== 0 });
    }
    if (segList.length === 0 || segList.every((s) => s.mitered)) return segList;

    const epHash = makeHash(8);
    const eps = [];
    for (let i = 0; i < segList.length; i++) {
      const s = segList[i];
      const a = { seg: i, end: 0, x: s.ax, z: s.az };
      const b = { seg: i, end: 1, x: s.bx, z: s.bz };
      eps.push(a, b);
      epHash.add(a, a.x - 3.2, a.z - 3.2, a.x + 3.2, a.z + 3.2);
      epHash.add(b, b.x - 3.2, b.z - 3.2, b.x + 3.2, b.z + 3.2);
    }
    const exactConnected = (ep) => {
      let deg = 0;
      epHash.some(ep.x, ep.z, 0.3, (o) => { if (o.seg !== ep.seg && Math.hypot(o.x - ep.x, o.z - ep.z) < 0.2) deg++; return deg > 0; });
      return deg > 0;
    };
    const snapped = new Uint8Array(eps.length);
    for (let ei = 0; ei < eps.length; ei++) {
      if (snapped[ei]) continue;
      const eA = eps[ei], sA = segList[eA.seg];
      if (sA.mitered || exactConnected(eA)) continue;
      let bestIdx = -1, bestDist = 3.05;
      epHash.some(eA.x, eA.z, 3.1, (eB) => {
        if (eB.seg === eA.seg) return false;
        const j = eB.seg * 2 + eB.end;
        if (snapped[j] || exactConnected(eB)) return false;
        const sB = segList[eB.seg];
        if (!sA.onWay && !sB.onWay) return false;
        const d = Math.hypot(eB.x - eA.x, eB.z - eA.z);
        if (d < bestDist && d > 0.08) {
          // Do not weld opposite verges across a lane carriageway!
          const mx = 0.5 * (eA.x + eB.x), mz = 0.5 * (eA.z + eB.z);
          if (streetEdge(mx, mz, 2.5) >= -0.15) {
            bestDist = d;
            bestIdx = j;
          }
        }
        return false;
      });
      if (bestIdx >= 0) {
        const eB = eps[bestIdx], sB = segList[eB.seg];
        const oAx = eA.end === 0 ? sA.bx : sA.ax, oAz = eA.end === 0 ? sA.bz : sA.az;
        const oBx = eB.end === 0 ? sB.bx : sB.ax, oBz = eB.end === 0 ? sB.bz : sB.az;
        const lA = Math.hypot(eA.x - oAx, eA.z - oAz) || 1, lB = Math.hypot(eB.x - oBx, eB.z - oBz) || 1;
        const uAx = (eA.x - oAx) / lA, uAz = (eA.z - oAz) / lA;
        const uBx = (eB.x - oBx) / lB, uBz = (eB.z - oBz) / lB;
        const det = uAx * uBz - uAz * uBx;
        let jx = 0.5 * (eA.x + eB.x), jz = 0.5 * (eA.z + eB.z);
        if (Math.abs(det) > 0.2) {
          const dx = eB.x - eA.x, dz = eB.z - eA.z;
          const tA = (dx * uBz - dz * uBx) / det;
          const tB = (dx * uAz - dz * uAx) / det;
          if (Math.abs(tA) <= 3.2 && Math.abs(tB) <= 3.2) {
            const cx = eA.x + uAx * tA, cz = eA.z + uAz * tA;
            if (streetEdge(cx, cz, 2.5) >= -0.15) { jx = cx; jz = cz; }
          }
        }
        if (eA.end === 0) { sA.ax = jx; sA.az = jz; } else { sA.bx = jx; sA.bz = jz; }
        if (eB.end === 0) { sB.ax = jx; sB.az = jz; } else { sB.bx = jx; sB.bz = jz; }
        eA.x = jx; eA.z = jz; eB.x = jx; eB.z = jz;
        snapped[ei] = 1;
        snapped[bestIdx] = 1;
      }
    }
    // Also snap dangling inland field-divider endpoints onto shifted roadside fences at T-junctions.
    const onWayHash = makeHash(16);
    for (const s of segList) {
      if (s.onWay) onWayHash.add(s, Math.min(s.ax, s.bx) - 3.0, Math.min(s.az, s.bz) - 3.0, Math.max(s.ax, s.bx) + 3.0, Math.max(s.az, s.bz) + 3.0);
    }
    for (let ei = 0; ei < eps.length; ei++) {
      if (snapped[ei]) continue;
      const ep = eps[ei], s = segList[ep.seg];
      if (s.onWay || s.mitered || exactConnected(ep)) continue;
      let bestD = 2.65, bestX = ep.x, bestZ = ep.z, hit = false;
      onWayHash.some(ep.x, ep.z, 2.8, (w) => {
        const dx = w.bx - w.ax, dz = w.bz - w.az, l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) return false;
        const t = Math.max(0, Math.min(1, ((ep.x - w.ax) * dx + (ep.z - w.az) * dz) / l2));
        const px = w.ax + dx * t, pz = w.az + dz * t, d = Math.hypot(px - ep.x, pz - ep.z);
        if (d < bestD && d > 0.05 && streetEdge(0.5 * (ep.x + px), 0.5 * (ep.z + pz), 2.5) >= -0.15) {
          bestD = d; bestX = px; bestZ = pz; hit = true;
        }
        return false;
      });
      if (hit) {
        if (ep.end === 0) { s.ax = bestX; s.az = bestZ; } else { s.bx = bestX; s.bz = bestZ; }
        ep.x = bestX; ep.z = bestZ;
      }
    }
    return segList;
  };

  const layFenceSubRun = (ax, az, bx, bz, stone) => {
    if (Math.hypot(bx - ax, bz - az) < 1.65) return;
    built.fences += layFence(ax, az, bx, bz, stone, { clear: (x, z) => dry(x, z) && !bridged(x, z) && streetEdge(x, z, 2.5) >= -0.15 && !placed.some(x, z, 4, (o) => rectDist(o, x, z) <= 1.2) && !solids.some(x, z, 4, (o) => rectDist(o, x, z) <= 1.2) });
  };

  const fence = (ax, az, bx, bz, stone) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1.65) return;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const samples = Math.max(2, Math.ceil(L / 0.85));
    const gaps = [];
    let gapStart = -1;
    for (let s = 0; s <= samples; s++) {
      const d = (s / samples) * L;
      const inWay = streetEdge(ax + ux * d, az + uz * d, 2.5) < -0.15;
      if (inWay && gapStart < 0) gapStart = d;
      else if (!inWay && gapStart >= 0) {
        const prevD = ((s - 1) / samples) * L;
        const mid = 0.5 * (gapStart + prevD), half = Math.max(2.1, 0.5 * (prevD - gapStart) + 0.35);
        gaps.push([Math.max(0, mid - half), Math.min(L, mid + half)]);
        gapStart = -1;
      }
    }
    if (gapStart >= 0) {
      const mid = 0.5 * (gapStart + L), half = Math.max(2.1, 0.5 * (L - gapStart) + 0.35);
      gaps.push([Math.max(0, mid - half), L]);
    }
    if (gaps.length === 0) {
      layFenceSubRun(ax, az, bx, bz, stone);
      return;
    }
    // Merge overlapping `>= 4.2 m` carriageway gateway openings and emit flanked sub-runs.
    const merged = [gaps[0]];
    for (let g = 1; g < gaps.length; g++) {
      const prev = merged[merged.length - 1];
      if (gaps[g][0] <= prev[1] + 1.4) prev[1] = Math.max(prev[1], gaps[g][1]);
      else merged.push(gaps[g]);
    }
    let cur = 0;
    for (const [g0, g1] of merged) {
      if (g0 - cur >= 1.65) layFenceSubRun(ax + ux * cur, az + uz * cur, ax + ux * g0, az + uz * g0, stone);
      cur = Math.max(cur, g1);
    }
    if (L - cur >= 1.65) layFenceSubRun(ax + ux * cur, az + uz * cur, bx, bz, stone);
  };
  for (const run of prepareFenceRuns(works.fences ?? [])) fence(run.ax, run.az, run.bx, run.bz, run.stone);
  // A bridge `need` metres long from bank to bank, its middle at x, z and running along u, its deck at `deck`: of stone,
  // as few arches as reach, each of the least span of three that does (js/old-world-works.js WORKS_BRIDGE), `width`
  // wide; or of timber, as few bents as reach, in as few lengths as its longest. Answers how long it is as built, and
  // its buildings.
  const footbridgeMost = WORKS_BRIDGE.bent * WORKS_BRIDGE.bents[WORKS_BRIDGE.bents.length - 1] + 0.6;
  const layBridge = (x, z, ux, uz, need, deck, stone, width) => {
    let pieces, each, type;
    if (stone) {
      pieces = Math.max(1, Math.ceil(need / WORKS_BRIDGE.arches[WORKS_BRIDGE.arches.length - 1]));
      each = WORKS_BRIDGE.arches.find((span) => span * pieces >= need) ?? WORKS_BRIDGE.arches[WORKS_BRIDGE.arches.length - 1];
      type = pieces > 1 ? CITY_TYPE.STONE_BRIDGE_SPAN : CITY_TYPE.STONE_BRIDGE;
    } else {
      pieces = Math.max(1, Math.ceil(need / footbridgeMost));
      const bents = Math.max(WORKS_BRIDGE.bents[0], Math.min(WORKS_BRIDGE.bents[WORKS_BRIDGE.bents.length - 1], Math.ceil((need / pieces - 0.6) / WORKS_BRIDGE.bent - 1e-6)));
      each = WORKS_BRIDGE.bent * bents + 0.6;
      type = CITY_TYPE.FOOTBRIDGE;
    }
    const length = pieces * each, cityIndices = [];
    for (let a = 0; a < pieces; a++) {
      const along = (a + 0.5) * each - length / 2;
      pushTyped(cityVariant(type, stone ? width : null, each), x + ux * along, deck, z + uz * along, Math.atan2(ux, uz), 0.5, 0);
      cityIndices.push(typedTypes.length - 1);
      built.bridges++;
    }
    return { length, cityIndices };
  };
  // A track's bridge and road/street crossings: seated above channel flood levels with masonry or timber piers.
  const bridges = [];
  for (const tb of trackBridgeSpecs) {
    const { x, z, ux, uz, span, isStone, crossing } = tb, half = span / 2;
    if (!inside(x, z, 12)) continue;
    // Deduplicate track crossings that collide with a primary road crossing (which builds the aligned wide bridge).
    if (roadCrossings.some((q) => Math.hypot(ox + q.x - x, oz + q.z - z) < 18)) continue;
    const nearPort = portBridges.find((pb) => Math.hypot(pb.x - x, pb.z - z) < 24);
    const hA = heightAt(x - ux * (half + 2.5), z - uz * (half + 2.5));
    const hB = heightAt(x + ux * (half + 2.5), z + uz * (half + 2.5));
    if (Math.max(hA, hB) <= 0.12) continue;
    const minNavDeck = (crossing && crossing.hw >= 5.5) ? (crossing.wy + 2.75) : -Infinity;
    const deck = Math.max(Math.max(hA, hB, BOARD_DRY_M) + 0.55, minNavDeck);
    if (nearPort) {
      const pux = Math.sin(nearPort.yaw ?? 0), puz = Math.cos(nearPort.yaw ?? 0), pLen = nearPort.length ?? (span + 4.0), pW = nearPort.width ?? 9.6;
      bridges.push({ x: nearPort.x, z: nearPort.z, ux: pux, uz: puz, length: pLen, halfWidth: pW * 0.5, deckY: Math.max(nearPort.y ?? deck, minNavDeck), span, isStone: true, cityIndices: [], collapsed: false });
      stampBridgeApproach(nearPort.x, nearPort.z, pux, puz, pLen, pW);
      continue;
    }
    const width = isStone ? WORKS_BRIDGE.widths[0] : CITY_BUILDING_TYPES[CITY_TYPE.FOOTBRIDGE].width;
    const { length: totalLen, cityIndices } = layBridge(x, z, ux, uz, span + 4.0, deck, isStone, width);
    bridges.push({ x, z, ux, uz, length: totalLen, halfWidth: width * 0.5, deckY: deck, span, isStone, cityIndices, collapsed: false });
    stampBridgeApproach(x, z, ux, uz, totalLen, width);
  }
  // A road's or arterial street's bridge where it crosses a river: stone, the road's width, bank to bank in arches.
  for (const q of roadCrossings) {
    const x = ox + q.x, z = oz + q.z, reach = Math.max(4.5, q.span / 2 + 2.6);
    if (!inside(x, z, 12)) continue;
    if (bridges.some((b) => Math.hypot(b.x - x, b.z - z) < 14)) continue;
    const hA = heightAt(x - q.ux * (reach + 1.5), z - q.uz * (reach + 1.5));
    const hB = heightAt(x + q.ux * (reach + 1.5), z + q.uz * (reach + 1.5));
    if (Math.max(hA, hB) <= 0.12) continue;
    const crossing = measureRiverCrossingAt(x, z, q.ux, q.uz);
    const minNavDeck = (crossing && crossing.hw >= 5.5) ? (crossing.wy + 2.75) : -Infinity;
    const deck = Math.max(Math.max(hA, hB, BOARD_DRY_M) + BOARD_ROAD_BRIDGE.rise, minNavDeck);
    const nearPort = portBridges.find((pb) => Math.hypot(pb.x - x, pb.z - z) < 24);
    if (nearPort) {
      const pux = Math.sin(nearPort.yaw ?? 0), puz = Math.cos(nearPort.yaw ?? 0), pLen = nearPort.length ?? (reach * 2), pW = nearPort.width ?? 9.6;
      bridges.push({ x: nearPort.x, z: nearPort.z, ux: pux, uz: puz, length: pLen, halfWidth: pW * 0.5, deckY: Math.max(nearPort.y ?? deck, minNavDeck), span: q.span, isStone: true, cityIndices: [], collapsed: false });
      stampBridgeApproach(nearPort.x, nearPort.z, pux, puz, pLen, pW);
      continue;
    }
    const isStone = q.stone !== false;
    const bridgeWidth = isStone ? BOARD_ROAD_BRIDGE.width : CITY_BUILDING_TYPES[CITY_TYPE.FOOTBRIDGE].width;
    const { length, cityIndices } = layBridge(x, z, q.ux, q.uz, reach * 2, deck, isStone, bridgeWidth);
    bridges.push({ x, z, ux: q.ux, uz: q.uz, length, halfWidth: bridgeWidth * 0.5, deckY: deck, span: q.span, isStone, cityIndices, collapsed: false });
    stampBridgeApproach(x, z, q.ux, q.uz, length, bridgeWidth);
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
      if (p.kind === 'ground' || streetEdge(x, z, 5) < 4) return CITY_TREES.NONE;
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

  /* ---- inland water: carve fluvial river/canal troughs and ponds, stand masonry weirs, and build hydraulic water ribbons ---- */
  const n = grid.n;
  const uncarved = heights ? heights.slice() : null;
  const origAt = uncarved ? ((x, z) => fieldAt(uncarved, grid, x, z)) : heightAt;
  const waterVerts = [], waterIdx = [];
  const pushWaterVert = (wx, wy, wz, kind, vx, vz, alongS, halfWidth, localDepth, bankB, thalwegB, eddy, riffle) => {
    const id = waterVerts.length / 12;
    const eddyIdx = Math.round(Math.max(0, Math.min(1, eddy)) * 255);
    const riffleFrac = Math.max(0, Math.min(0.996, riffle / 1.5));
    waterVerts.push(
      wx, wy, wz, kind,
      vx, vz, alongS, halfWidth,
      localDepth, bankB, thalwegB, eddyIdx + riffleFrac,
    );
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
  const bridgePad = (gx, gz) => bridges.some((b) => Math.hypot(gx - b.x, gz - b.z) < b.span * 0.65 + 4);
  const bridgeClearance = (gx, gz) => {
    let minD = Infinity;
    for (const b of bridges) {
      const d = Math.hypot(gx - b.x, gz - b.z) - (b.span * 0.55 + 4);
      if (d < minD) minD = d;
    }
    return minD <= 0 ? 0 : Math.min(1, minD / 14);
  };
  // Centripetal Catmull-Rom resampling of the sim's coarse course so bends sweep naturally while
  // preserving exact bridge crossings and confluences.
  const smoothFluvialCourse = (rawPts, isCanal) => {
    const dedup = [];
    for (const p of rawPts) {
      const prev = dedup[dedup.length - 1];
      if (!prev || Math.hypot(p.wx - prev.wx, p.wz - prev.wz) >= 0.75) dedup.push(p);
    }
    if (dedup.length < 2) return dedup;
    const out = [];
    const cr = (p0, p1, p2, p3, t, field) => {
      const t2 = t * t, t3 = t2 * t;
      return 0.5 * (
        (2 * p1[field])
        + (-p0[field] + p2[field]) * t
        + (2 * p0[field] - 5 * p1[field] + 4 * p2[field] - p3[field]) * t2
        + (-p0[field] + 3 * p1[field] - 3 * p2[field] + p3[field]) * t3
      );
    };
    const m = dedup.length;
    for (let i = 0; i < m - 1; i++) {
      const p0 = dedup[Math.max(0, i - 1)], p1 = dedup[i], p2 = dedup[i + 1], p3 = dedup[Math.min(m - 1, i + 2)];
      const segL = Math.hypot(p2.wx - p1.wx, p2.wz - p1.wz);
      const subSteps = isCanal ? Math.max(1, Math.min(8, Math.ceil(segL / 4.0))) : Math.max(1, Math.min(12, Math.ceil(segL / 2.4)));
      for (let s = 0; s < subSteps; s++) {
        const t = s / subSteps;
        if (s === 0) {
          out.push({ ...p1 });
          continue;
        }
        const linearX = p1.wx + (p2.wx - p1.wx) * t;
        const linearZ = p1.wz + (p2.wz - p1.wz) * t;
        const splineX = isCanal ? linearX : cr(p0, p1, p2, p3, t, 'wx');
        const splineZ = isCanal ? linearZ : cr(p0, p1, p2, p3, t, 'wz');
        const pin = bridgeClearance(linearX, linearZ);
        const wx = linearX + (splineX - linearX) * (0.22 + 0.78 * pin);
        const wz = linearZ + (splineZ - linearZ) * (0.22 + 0.78 * pin);
        const hw = Math.max(0.75, p1.hw + (p2.hw - p1.hw) * t);
        const wy = p1.wy + (p2.wy - p1.wy) * t;
        const oh = origAt(wx, wz);
        out.push({
          wx, wz, hw, wy,
          bankMaxY: oh,
          depth: isCanal ? 1.45 : Math.min(2.6, 1.05 + 0.25 * hw),
          seaMouth: Boolean(p1.seaMouth && p2.seaMouth),
          hwL: hw, hwR: hw, thalwegB: 0, curvature: 0, alongS: 0,
        });
      }
    }
    out.push({ ...dedup[m - 1], hwL: dedup[m - 1].hw, hwR: dedup[m - 1].hw, thalwegB: 0, curvature: 0, alongS: 0 });
    return out;
  };

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
  const projectOntoChain = (wx, wz, ost, maxSegIdx = ost.length - 2) => {
    let best = null;
    const lim = Math.min(ost.length - 2, maxSegIdx);
    for (let k = 0; k <= lim; k++) {
      const p0 = ost[k], p1 = ost[k + 1];
      const dx = p1.wx - p0.wx, dz = p1.wz - p0.wz, d2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((wx - p0.wx) * dx + (wz - p0.wz) * dz) / d2));
      const px = p0.wx + dx * t, pz = p0.wz + dz * t;
      const d = Math.hypot(wx - px, wz - pz);
      if (!best || d < best.d) {
        const ohw = p0.hw + (p1.hw - p0.hw) * t;
        best = { k, t, px, pz, d, ohw, p0, p1 };
      }
    }
    return best;
  };
  const refreshChainKinematics = (st) => {
    let accumS = 0;
    for (let i = 0; i < st.length; i++) {
      if (i > 0) accumS += Math.hypot(st[i].wx - st[i - 1].wx, st[i].wz - st[i - 1].wz);
      st[i].alongS = accumS;
      const p0 = st[Math.max(0, i - 1)], p1 = st[Math.min(st.length - 1, i + 1)];
      const dx = p1.wx - p0.wx, dz = p1.wz - p0.wz, dLen = Math.hypot(dx, dz) || 1;
      st[i].tx = dx / dLen;
      st[i].tz = dz / dLen;
      st[i].nx = -st[i].tz;
      st[i].nz = st[i].tx;
      st[i].dLen = dLen;
    }
    return accumS;
  };

  for (let rIdx = 0; rIdx < rivers.length; rIdx++) {
    const river = rivers[rIdx], pts = river.points, m = Math.floor((pts?.length ?? 0) / 3);
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

    let stations = [];
    const flushReach = () => {
      if (stations.length >= 2 && (isCanal || stations.length >= 5 || stations[0].bankMaxY >= 1.5)) {
        const dense = smoothFluvialCourse(stations, isCanal);
        if (dense.length >= 2) reachChains.push({ rIdx, isCanal, stations: dense });
      }
      stations.length = 0;
    };
    for (let s = 0; s < m; s++) {
      const wx = ox + pts[s * 3], wz = oz + pts[s * 3 + 1], hw = Math.max(0.75, pts[s * 3 + 2]);
      if (!inside(wx, wz, 6)) { flushReach(); continue; }
      const oh = origAt(wx, wz);
      if (oh <= 0.12) {
        if (stations.length >= 1) {
          const reachedSea = !isCanal && stations.length >= 4;
          stations.push({ wx, wz, hw, wy: 0.02, bankMaxY: 0.18, depth: Math.min(2.6, 1.05 + 0.25 * hw), seaMouth: true, hwL: hw, hwR: hw, thalwegB: 0, curvature: 0, alongS: 0 });
          flushReach();
          if (reachedSea) break;
        } else {
          stations.length = 0;
        }
        continue;
      }
      stations.push({ wx, wz, hw, wy: prof[s], bankMaxY: oh, depth: isCanal ? 1.45 : Math.min(2.6, 1.05 + 0.25 * hw), seaMouth: false, hwL: hw, hwR: hw, thalwegB: 0, curvature: 0, alongS: 0 });
    }
    flushReach();
  }

  // 1. Compute fluvial bend curvature, outer-bend cut-bank thalweg shift, and pool-riffle modulation.
  for (let cIdx = 0; cIdx < reachChains.length; cIdx++) {
    const chain = reachChains[cIdx], st = chain.stations, isCanal = chain.isCanal;
    const accumS = refreshChainKinematics(st);
    // Box-filtered curvature over ~18 m to capture smooth bend centrifuges without jitter.
    const rawCurv = new Float32Array(st.length);
    for (let i = 1; i < st.length - 1; i++) {
      const prev = st[Math.max(0, i - 3)], next = st[Math.min(st.length - 1, i + 3)];
      const ds = Math.max(2.0, next.alongS - prev.alongS);
      // Center-of-curvature vector dT/ds points INWARD; centrifugal outer cut-bank points OUTWARD (-dT/ds).
      const ax = (next.tx - prev.tx) / ds, az = (next.tz - prev.tz) / ds;
      rawCurv[i] = -(ax * st[i].nx + az * st[i].nz);
    }
    for (let i = 0; i < st.length; i++) {
      let sumK = 0, cnt = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(st.length - 1, i + 2); k++) { sumK += rawCurv[k]; cnt++; }
      const curv = isCanal || st[i].seaMouth ? 0 : (sumK / Math.max(1, cnt));
      st[i].curvature = curv;
      const free = (1 - Math.exp(-st[i].alongS * 0.08)) * (1 - Math.exp(-Math.max(0, accumS - st[i].alongS) * 0.08));
      const bClear = bridgeClearance(st[i].wx, st[i].wz);
      const thalweg = Math.max(-0.56, Math.min(0.56, curv * st[i].hw * 3.4 * free * bClear));
      st[i].thalwegB = thalweg;
      // Organic fluvial width undulation + outer-bend widening, pinned cleanly under bridges.
      const riffleWave = Math.sin(st[i].alongS * 0.075 + cIdx * 1.9);
      const widenOuter = 1 + (0.14 * Math.sin(st[i].alongS * 0.052 + cIdx * 2.7) + 0.18 * Math.max(0, thalweg)) * free * bClear;
      const widenInner = 1 + (0.14 * Math.sin(st[i].alongS * 0.052 + cIdx * 2.7 + 0.9) + 0.18 * Math.max(0, -thalweg)) * free * bClear;
      st[i].hwL = isCanal || st[i].seaMouth ? st[i].hw : Math.max(0.7, st[i].hw * widenInner);
      st[i].hwR = isCanal || st[i].seaMouth ? st[i].hw : Math.max(0.7, st[i].hw * widenOuter);
      st[i].hw = 0.5 * (st[i].hwL + st[i].hwR);
      const poolBoost = 1 + 0.34 * Math.min(1, Math.abs(thalweg) * 1.8) - 0.12 * riffleWave * free * bClear;
      if (!isCanal && !st[i].seaMouth) st[i].depth = Math.max(0.65, Math.min(3.1, st[i].depth * poolBoost));
    }
  }

  // 2. Unified confluence detection, tail trimming, and smooth curved bridge extension into mainstems,
  //    followed by tidewater sea-mouth flare extension (before final wy leveling and bed carving).
  for (let c = 0; c < reachChains.length; c++) {
    const chain = reachChains[c], st = chain.stations;
    const origEnd = st[st.length - 1];
    if (!chain.isCanal && st.length >= 2 && !origEnd?.seaMouth) {
      let bestJoin = null;
      for (let o = 0; o < reachChains.length; o++) {
        if (o === c || reachChains[o].isCanal) continue;
        if (reachChains[o].mouthJoin?.otherIdx === c) continue;
        const ost = reachChains[o].stations;
        if (ost.length < 2) continue;
        const oHasSeaMouth = Boolean(ost[ost.length - 1]?.seaMouth);
        for (let k = 0; k < ost.length - 1; k++) {
          const p0 = ost[k], p1 = ost[k + 1];
          const dx = p1.wx - p0.wx, dz = p1.wz - p0.wz, d2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((origEnd.wx - p0.wx) * dx + (origEnd.wz - p0.wz) * dz) / d2));
          const px = p0.wx + dx * t, pz = p0.wz + dz * t;
          const ohw = p0.hw + (p1.hw - p0.hw) * t;
          const segHw = Math.max(p0.hw, ohw);
          const isHeadOnTail = k >= ost.length - 2 && !oHasSeaMouth && t > 0.65;
          if (isHeadOnTail && !(ohw > origEnd.hw + 0.4 || (Math.abs(ohw - origEnd.hw) <= 0.4 && o < c))) continue;
          const reach = segHw + origEnd.hw + 10.0;
          const d = Math.hypot(origEnd.wx - px, origEnd.wz - pz);
          if (d <= reach && (!bestJoin || d < bestJoin.d)) {
            bestJoin = { o, k, t, px, pz, d, ohw, ost };
          }
        }
      }
      if (bestJoin) {
        const { ost, o } = bestJoin;
        // Trim any tail stations of `c` already inside `ost`'s wet half-width (`segDist < ost[k].hw * 0.82`).
        while (st.length > 2) {
          const tail = st[st.length - 1];
          const proj = projectOntoChain(tail.wx, tail.wz, ost);
          const refHw = Math.max(ost[proj.k].hw, proj.ohw);
          if (proj.d < refHw * 0.82) st.pop();
          else break;
        }
        const approach = st[st.length - 1];
        const prev = st[st.length - 2];
        const adx = approach.wx - prev.wx, adz = approach.wz - prev.wz, aLen = Math.hypot(adx, adz) || 1;
        const atx = adx / aLen, atz = adz / aLen;
        // Project confluence target onto mainstem centerline (preferring origEnd's projection when forward of approach).
        let targetProj = projectOntoChain(origEnd.wx, origEnd.wz, ost);
        if ((targetProj.px - approach.wx) * atx + (targetProj.pz - approach.wz) * atz < -0.5) {
          targetProj = projectOntoChain(approach.wx, approach.wz, ost);
        }
        const p0 = ost[targetProj.k], p1 = ost[targetProj.k + 1];
        const txP = targetProj.px, tzP = targetProj.pz;
        const bridgeDist = Math.hypot(txP - approach.wx, tzP - approach.wz);
        const ohw = targetProj.ohw;
        const mainDepth = p0.depth + (p1.depth - p0.depth) * targetProj.t;
        const mainWy = p0.wy + (p1.wy - p0.wy) * targetProj.t;
        const targetHw = Math.min(ohw * 0.92, Math.max(approach.hw, Math.min(ohw * 0.82, approach.hw * 1.35)));
        if (bridgeDist > 0.25) {
          const fwdDot = (txP - approach.wx) * atx + (tzP - approach.wz) * atz;
          const handleLen = Math.max(0, Math.min(bridgeDist * 0.45, fwdDot * 0.62));
          const cxCtrl = approach.wx + atx * handleLen;
          const czCtrl = approach.wz + atz * handleLen;
          const bridgeSteps = 3;
          for (let s = 1; s <= bridgeSteps; s++) {
            const u = s / bridgeSteps, inv = 1 - u;
            const wx = inv * inv * approach.wx + 2 * inv * u * cxCtrl + u * u * txP;
            const wz = inv * inv * approach.wz + 2 * inv * u * czCtrl + u * u * tzP;
            const hw = approach.hw + (targetHw - approach.hw) * u;
            st.push({
              wx,
              wz,
              hw,
              hwL: hw,
              hwR: hw,
              wy: approach.wy + (mainWy - approach.wy) * u,
              bankMaxY: origAt(wx, wz),
              depth: approach.depth + (mainDepth - approach.depth) * u,
              seaMouth: false,
              thalwegB: approach.thalwegB * inv,
              curvature: approach.curvature * inv,
              alongS: 0,
            });
          }
        } else {
          approach.wx = txP;
          approach.wz = tzP;
          approach.hw = targetHw;
          approach.hwL = targetHw;
          approach.hwR = targetHw;
        }
        refreshChainKinematics(st);
        chain.mouthJoin = { otherIdx: o, k: targetProj.k, t: targetProj.t, wx: txP, wz: tzP };
      }
    }

    const last = st[st.length - 1];
    if (last?.seaMouth && !chain.mouthJoin && st.length >= 2) {
      const prev = st[Math.max(0, st.length - 4)];
      const dx = last.wx - prev.wx, dz = last.wz - prev.wz, L = Math.hypot(dx, dz) || 1;
      const ux = dx / L, uz = dz / L;
      const shoreX = last.wx, shoreZ = last.wz, shoreAlong = last.alongS;
      for (let k = Math.max(1, st.length - 12); k < st.length; k++) {
        const s = st[k];
        const ds = Math.max(0, shoreAlong - s.alongS);
        if (ds >= 18) continue;
        const flare = Math.pow(1 - ds / 18, 1.5);
        const wMul = 1 + 0.35 * flare;
        s.hw *= wMul;
        s.hwL = (s.hwL ?? s.hw) * wMul;
        s.hwR = (s.hwR ?? s.hw) * wMul;
      }
      const baseW = last.hw;
      last.wy = 0.03;
      chain.shoreIdx = st.length - 1;
      chain.shoreS = shoreAlong;
      const distSteps = [3, 6, 10, 14, 19, 25, 31, 38, 46, 54];
      let maxOut = 0;
      for (const distOut of distSteps) {
        const qx = shoreX + ux * distOut, qz = shoreZ + uz * distOut;
        if (!inside(qx, qz, 6) || origAt(qx, qz) > 0.22) break;
        maxOut = distOut;
        const mw = baseW * (1 + distOut / 32);
        const taper = 1 - 0.18 * (distOut / 54);
        st.push({
          wx: qx,
          wz: qz,
          hw: mw,
          hwL: mw,
          hwR: mw,
          wy: Math.max(0.0, 0.028 * Math.exp(-distOut / 9)),
          bankMaxY: origAt(qx, qz),
          depth: Math.max(1.15, last.depth * taper),
          seaMouth: true,
          seaPlume: distOut > 6,
          distOut,
          thalwegB: 0,
          curvature: 0,
          alongS: shoreAlong + distOut,
        });
      }
      refreshChainKinematics(st);
      chain.seaMouthCarve = maxOut > 0 ? { shoreX, shoreZ, ux, uz, baseW, maxOut } : null;
    }
  }

  // Densify reach stations near confluence zones (<= 0.70 m spacing) so intersecting bank/bed strips carve clean troughs.
  const confluenceCenters = reachChains
    .filter((ch) => ch.mouthJoin)
    .map((ch) => ({
      wx: ch.mouthJoin.wx,
      wz: ch.mouthJoin.wz,
      r: Math.max(16, (ch.stations[ch.stations.length - 1]?.hw ?? 3) * 3.5 + 12),
    }));
  if (confluenceCenters.length > 0) {
    for (const chain of reachChains) {
      const st = chain.stations;
      const dense = [st[0]];
      for (let i = 0; i < st.length - 1; i++) {
        const a = st[i], b = st[i + 1];
        const mx = 0.5 * (a.wx + b.wx), mz = 0.5 * (a.wz + b.wz);
        let nearConf = false;
        for (const c of confluenceCenters) {
          if (Math.hypot(mx - c.wx, mz - c.wz) <= c.r + Math.max(a.hw, b.hw)) { nearConf = true; break; }
        }
        const segLen = Math.hypot(b.wx - a.wx, b.wz - a.wz);
        const steps = nearConf && !b.seaPlume ? Math.max(1, Math.min(8, Math.ceil(segLen / 0.68))) : 1;
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          dense.push({
            ...a,
            wx: a.wx + (b.wx - a.wx) * t,
            wz: a.wz + (b.wz - a.wz) * t,
            hw: a.hw + (b.hw - a.hw) * t,
            hwL: (a.hwL ?? a.hw) + ((b.hwL ?? b.hw) - (a.hwL ?? a.hw)) * t,
            hwR: (a.hwR ?? a.hw) + ((b.hwR ?? b.hw) - (a.hwR ?? b.hw)) * t,
            wy: a.wy + (b.wy - a.wy) * t,
            bankMaxY: origAt(a.wx + (b.wx - a.wx) * t, a.wz + (b.wz - a.wz) * t),
            depth: a.depth + (b.depth - a.depth) * t,
            seaMouth: Boolean(a.seaMouth && b.seaMouth),
            seaPlume: Boolean(a.seaPlume && b.seaPlume),
            thalwegB: (a.thalwegB ?? 0) + ((b.thalwegB ?? 0) - (a.thalwegB ?? 0)) * t,
            curvature: (a.curvature ?? 0) + ((b.curvature ?? 0) - (a.curvature ?? 0)) * t,
            alongS: 0,
          });
        }
        dense.push(b);
      }
      chain.stations = dense;
      refreshChainKinematics(dense);
      if (chain.shoreS != null) {
        let bestIdx = 0, bestDiff = Infinity;
        for (let i = 0; i < dense.length; i++) {
          const d = Math.abs(dense[i].alongS - chain.shoreS);
          if (d < bestDiff) { bestDiff = d; bestIdx = i; }
        }
        chain.shoreIdx = bestIdx;
      }
    }
  }

  // 3. Compute initial bank crests & PAV hydraulic water-surface profile, then smooth confluence wy matching.
  const updateChainCrests = (chain, clampInitialWy) => {
    const st = chain.stations;
    for (let i = 0; i < st.length; i++) {
      const p0 = st[Math.max(0, i - 1)], p1 = st[Math.min(st.length - 1, i + 1)];
      const dx = p1.wx - p0.wx, dz = p1.wz - p0.wz, dLen = Math.hypot(dx, dz) || 1;
      const tx = dx / dLen, tz = dz / dLen, nx = -tz, nz = tx;
      const bankW = Math.max(1.85, Math.min(4.8, 1.45 + st[i].hw * 0.45));
      const crestHwL = (st[i].hwL ?? st[i].hw) + bankW;
      const crestHwR = (st[i].hwR ?? st[i].hw) + bankW;
      const lx = st[i].wx - nx * crestHwL, lz = st[i].wz - nz * crestHwL;
      const rx = st[i].wx + nx * crestHwR, rz = st[i].wz + nz * crestHwR;
      const ly = inside(lx, lz, 2) ? triHeightAt(lx, lz) : origAt(lx, lz);
      const ry = inside(rx, rz, 2) ? triHeightAt(rx, rz) : origAt(rx, rz);
      st[i].tx = tx; st[i].tz = tz; st[i].nx = nx; st[i].nz = nz; st[i].dLen = dLen;
      st[i].crestHwL = crestHwL; st[i].crestHwR = crestHwR; st[i].crestHw = 0.5 * (crestHwL + crestHwR);
      st[i].lx = lx; st[i].lz = lz; st[i].ly = ly; st[i].rx = rx; st[i].rz = rz; st[i].ry = ry;
      if (clampInitialWy && !st[i].seaMouth) {
        const natMin = Math.min(origAt(lx, lz), origAt(rx, rz));
        const cap = Math.min(st[i].wy, Math.min(ly, ry) - 0.16, natMin - 0.30);
        st[i].wy = Math.max(0.06, cap);
      }
    }
  };
  for (const chain of reachChains) {
    updateChainCrests(chain, true);
    const st = chain.stations;
    const leveled = pavMonotoneDesc(st.map((s) => s.wy));
    for (let i = 0; i < st.length; i++) {
      if (!st[i].seaMouth) st[i].wy = Math.max(0.06, Math.min(st[i].wy, leveled[i]));
      else st[i].wy = Math.max(0.0, st[i].wy);
      if (i > 0) st[i].wy = Math.min(st[i].wy, st[i - 1].wy);
    }
  }

  const confluenceJoins = [];
  for (let a = 0; a < reachChains.length; a++) {
    const chainA = reachChains[a], trib = chainA.stations, end = trib[trib.length - 1];
    if (end.seaMouth && !chainA.mouthJoin) continue;
    let bestB = chainA.mouthJoin?.otherIdx ?? -1;
    let mainProj = null;
    if (bestB >= 0) {
      mainProj = projectOntoChain(end.wx, end.wz, reachChains[bestB].stations);
    } else if (!chainA.isCanal) {
      let bestD = Infinity;
      for (let b = 0; b < reachChains.length; b++) {
        if (a === b || reachChains[b].isCanal) continue;
        const proj = projectOntoChain(end.wx, end.wz, reachChains[b].stations);
        if (proj && proj.d < proj.ohw + end.hw + 10.0 && proj.d < bestD) {
          bestD = proj.d;
          bestB = b;
          mainProj = proj;
        }
      }
    }
    if (bestB >= 0 && mainProj) {
      confluenceJoins.push({ tribIdx: a, mainIdx: bestB, trib, end });
    }
  }
  const DRAWDOWN_SPAN_M = 25.0;
  for (let pass = 0; pass < 3; pass++) {
    for (const jn of confluenceJoins) {
      const { trib, end, mainIdx } = jn;
      const mainSt = reachChains[mainIdx].stations;
      const proj = projectOntoChain(end.wx, end.wz, mainSt);
      const targetWy = proj.p0.wy + (proj.p1.wy - proj.p0.wy) * proj.t;
      jn.main = proj.t < 0.5 ? proj.p0 : proj.p1;
      jn.proj = proj;
      const endS = end.alongS;
      if (targetWy < end.wy) {
        for (let i = 0; i < trib.length; i++) {
          const ds = Math.max(0, endS - trib[i].alongS);
          if (ds >= DRAWDOWN_SPAN_M) continue;
          const u = ds / DRAWDOWN_SPAN_M;
          const sm = u * u * (3 - 2 * u);
          trib[i].wy = Math.min(trib[i].wy, targetWy + Math.max(0, trib[i].wy - targetWy) * sm);
        }
      }
      end.wy = targetWy;
      for (let i = trib.length - 2; i >= 0; i--) {
        trib[i].wy = Math.max(trib[i].wy, trib[i + 1].wy);
      }
      for (let i = 1; i < trib.length; i++) {
        trib[i].wy = Math.min(trib[i].wy, trib[i - 1].wy);
      }
    }
  }
  for (const chain of reachChains) {
    if (chain.isCanal) continue;
    for (let i = 1; i < chain.stations.length; i++) {
      chain.stations[i].wy = Math.min(chain.stations[i].wy, chain.stations[i - 1].wy);
    }
    let y = -Infinity;
    for (let i = chain.stations.length - 1; i >= 0; i--) {
      y = Math.max(y, chain.stations[i].wy);
      chain.stations[i].wy = y;
    }
  }

  // 4. Carve asymmetric riverbed troughs and sea-mouth bars into heights AFTER confluence extension & final wy leveling.
  for (let cIdx = 0; cIdx < reachChains.length; cIdx++) {
    const chain = reachChains[cIdx], st = chain.stations;
    const carveStride = grid.step > 20 ? 2 : 1;
    for (let s = 0; s < st.length - 1; s += carveStride) {
      const s1 = Math.min(st.length - 1, s + carveStride);
      const a = st[s], b = st[s1];
      const maxHw = Math.max(a.hw, b.hw);
      const baseFlatR = grid.step > 20 ? maxHw + 0.5 : maxHw * 0.72;
      const outer = grid.step > 20 ? baseFlatR + Math.min(grid.step * 0.55, 8.0) : maxHw + 4.4;
      const scanR = Math.max(outer, maxHw + grid.step * 0.45);
      const i0 = Math.max(1, Math.floor((Math.min(a.wx, b.wx) - scanR - grid.x0) / grid.step));
      const i1 = Math.min(n - 2, Math.ceil((Math.max(a.wx, b.wx) + scanR - grid.x0) / grid.step));
      const j0 = Math.max(1, Math.floor((Math.min(a.wz, b.wz) - scanR - grid.z0) / grid.step));
      const j1 = Math.min(n - 2, Math.ceil((Math.max(a.wz, b.wz) + scanR - grid.z0) / grid.step));
      const abx = b.wx - a.wx, abz = b.wz - a.wz, ab2 = abx * abx + abz * abz || 1;
      for (let j = j0; j <= j1; j++) {
        const gz = grid.z0 + j * grid.step;
        for (let i = i0; i <= i1; i++) {
          const gx = grid.x0 + i * grid.step;
          const t = Math.max(0, Math.min(1, ((gx - a.wx) * abx + (gz - a.wz) * abz) / ab2));
          const cx = a.wx + abx * t, cz = a.wz + abz * t;
          const nx = a.nx + (b.nx - a.nx) * t, nz = a.nz + (b.nz - a.nz) * t;
          const signedCross = (gx - cx) * nx + (gz - cz) * nz;
          const dist = Math.hypot(gx - cx, gz - cz);
          if (dist >= scanR) continue;
          const k = j * n + i;
          const hw = a.hw + (b.hw - a.hw) * t;
          const thal = (a.thalwegB ?? 0) + ((b.thalwegB ?? 0) - (a.thalwegB ?? 0)) * t;
          if (dist <= hw + grid.step * 0.45) wet[k] = 1;
          if (!heights || dist >= outer) continue;
          const origH = uncarved[k];
          const padHit = nearPad(gx, gz);
          if (padHit && dist > hw + 1.0) continue;
          const flatR = padHit ? hw + 0.4 : baseFlatR;
          const wy = Math.max(-2.0, a.wy + (b.wy - a.wy) * t - 0.14);
          const baseDepth = a.depth + (b.depth - a.depth) * t;
          const normCross = Math.max(-1, Math.min(1, signedCross / Math.max(hw, 0.5)));
          const symShape = Math.max(0, 1 - normCross * normCross);
          const skewFocus = 0.65 + 0.48 * Math.exp(-1.8 * (normCross - thal) ** 2);
          const bed = wy - baseDepth * Math.max(0.28, symShape * skewFocus + 0.25);
          const u = dist <= flatR ? 0 : Math.min(1, (dist - flatR) / Math.max(0.75, outer - flatR));
          const sm = u * u * (3 - 2 * u);
          const target = dist <= flatR ? bed : bed * (1 - sm) + origH * sm;
          if (target < heights[k]) heights[k] = target;
        }
      }
    }
    if (heights && chain.seaMouthCarve) {
      const { shoreX, shoreZ, ux, uz, baseW, maxOut } = chain.seaMouthCarve;
      const endX = shoreX + ux * Math.min(maxOut, 48), endZ = shoreZ + uz * Math.min(maxOut, 48);
      const padW = baseW * 2.6 + grid.step;
      const i0 = Math.max(1, Math.floor((Math.min(shoreX, endX) - padW - grid.x0) / grid.step));
      const i1 = Math.min(n - 2, Math.ceil((Math.max(shoreX, endX) + padW - grid.x0) / grid.step));
      const j0 = Math.max(1, Math.floor((Math.min(shoreZ, endZ) - padW - grid.z0) / grid.step));
      const j1 = Math.min(n - 2, Math.ceil((Math.max(shoreZ, endZ) + padW - grid.z0) / grid.step));
      const maxCarve = Math.min(maxOut, 46);
      for (let j = j0; j <= j1; j++) {
        const gz = grid.z0 + j * grid.step;
        for (let i = i0; i <= i1; i++) {
          const gx = grid.x0 + i * grid.step;
          const along = (gx - shoreX) * ux + (gz - shoreZ) * uz;
          if (along < -2 || along > maxCarve + grid.step * 0.5) continue;
          const across = Math.abs(-(gx - shoreX) * uz + (gz - shoreZ) * ux);
          const mw = baseW * (1 + Math.max(0, along) / 32) * 1.25;
          if (across > mw) continue;
          if (nearPad(gx, gz) && across > mw * 0.8) continue;
          const uAcross = across / Math.max(1, mw);
          const fade = (1 - uAcross * uAcross) * Math.max(0, 1 - Math.max(0, along - maxCarve + 8) / 8);
          const barBed = -0.95 - 0.018 * Math.max(0, along) + 0.22 * Math.exp(-(((along - 30) / 11) ** 2));
          const k = j * n + i;
          const carved = heights[k] + (barBed - heights[k]) * fade;
          if (carved < heights[k]) heights[k] = carved;
        }
      }
    }
  }
  // Refresh outer bank crest heights (ly, ry) against the carved terrain surface so crests sit watertightly on heights.
  for (const chain of reachChains) updateChainCrests(chain, false);

  // Convex hull helper for watertight 2D sub-grid terrain riverCuts clipping across junctions (zero dry-rim pyramid!).
  const convexHull2D = (pts) => {
    const sorted = pts.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    if (sorted.length < 3) return sorted;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  };
  const pushRiverCutPoly = (rawPts) => {
    const poly = rawPts.length > 3 ? convexHull2D(rawPts) : rawPts;
    if (poly.length < 3) return;
    let area2 = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      area2 += a[0] * b[1] - b[0] * a[1];
      x0 = Math.min(x0, a[0]); z0 = Math.min(z0, a[1]);
      x1 = Math.max(x1, a[0]); z1 = Math.max(z1, a[1]);
    }
    if (Math.abs(area2) > 1e-4) riverCuts.push({ x0, z0, x1, z1, poly });
  };
  for (const jn of confluenceJoins) {
    const { end, proj } = jn;
    if (!proj) continue;
    const m0 = proj.p0, m1 = proj.p1;
    const eL = (end.hwL ?? end.hw) + 0.35, eR = (end.hwR ?? end.hw) + 0.35;
    const m0L = (m0.hwL ?? m0.hw) + 0.35, m0R = (m0.hwR ?? m0.hw) + 0.35;
    const m1L = (m1.hwL ?? m1.hw) + 0.35, m1R = (m1.hwR ?? m1.hw) + 0.35;
    pushRiverCutPoly([
      [end.wx - end.nx * eL, end.wz - end.nz * eL],
      [end.wx + end.nx * eR, end.wz + end.nz * eR],
      [m0.wx - m0.nx * m0L, m0.wz - m0.nz * m0L],
      [m0.wx + m0.nx * m0R, m0.wz + m0.nz * m0R],
      [m1.wx - m1.nx * m1L, m1.wz - m1.nz * m1L],
      [m1.wx + m1.nx * m1R, m1.wz + m1.nz * m1R],
    ]);
  }

  // 5. Build a spatial segment grid across all reaches so intersecting bank strips depress cleanly below other channels.
  const SEG_CELL = 16.0;
  const reachSegGrid = new Map();
  for (let oIdx = 0; oIdx < reachChains.length; oIdx++) {
    const ost = reachChains[oIdx].stations;
    for (let s = 0; s < ost.length - 1; s++) {
      const a = ost[s], b = ost[s + 1];
      if (a.seaPlume && b.seaPlume) continue;
      const maxR = Math.max(a.crestHwL ?? a.crestHw, a.crestHwR ?? a.crestHw, b.crestHwL ?? b.crestHw, b.crestHwR ?? b.crestHw) + 1.5;
      const seg = { oIdx, a, b, abx: b.wx - a.wx, abz: b.wz - a.wz, ab2: (b.wx - a.wx) ** 2 + (b.wz - a.wz) ** 2 || 1, maxR };
      const gx0 = Math.floor((Math.min(a.wx, b.wx) - maxR) / SEG_CELL);
      const gx1 = Math.floor((Math.max(a.wx, b.wx) + maxR) / SEG_CELL);
      const gz0 = Math.floor((Math.min(a.wz, b.wz) - maxR) / SEG_CELL);
      const gz1 = Math.floor((Math.max(a.wz, b.wz) + maxR) / SEG_CELL);
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const key = `${gx},${gz}`;
          let bucket = reachSegGrid.get(key);
          if (!bucket) reachSegGrid.set(key, bucket = []);
          bucket.push(seg);
        }
      }
    }
  }
  const pushDepressedBankVert = (cIdx, vx, vy, vz, nx, ny, nz, wetAmt) => {
    const bucket = reachSegGrid.get(`${Math.floor(vx / SEG_CELL)},${Math.floor(vz / SEG_CELL)}`);
    let clampedY = vy, clampedWet = wetAmt;
    if (bucket) {
      for (let k = 0; k < bucket.length; k++) {
        const seg = bucket[k];
        if (seg.oIdx === cIdx) continue;
        const { a, b, abx, abz, ab2, maxR } = seg;
        const t = Math.max(0, Math.min(1, ((vx - a.wx) * abx + (vz - a.wz) * abz) / ab2));
        const cx = a.wx + abx * t, cz = a.wz + abz * t;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d >= maxR) continue;
        const snx = a.nx + (b.nx - a.nx) * t, snz = a.nz + (b.nz - a.nz) * t;
        const signedCross = (vx - cx) * snx + (vz - cz) * snz;
        const hwL = (a.hwL ?? a.hw) + ((b.hwL ?? b.hw) - (a.hwL ?? a.hw)) * t;
        const hwR = (a.hwR ?? a.hw) + ((b.hwR ?? b.hw) - (a.hwR ?? a.hw)) * t;
        const crestL = (a.crestHwL ?? a.crestHw) + ((b.crestHwL ?? b.crestHw) - (a.crestHwL ?? a.crestHw)) * t;
        const crestR = (a.crestHwR ?? a.crestHw) + ((b.crestHwR ?? b.crestHw) - (a.crestHwR ?? a.crestHw)) * t;
        const crestY = signedCross < 0 ? a.ly + (b.ly - a.ly) * t : a.ry + (b.ry - a.ry) * t;
        const hwSide = signedCross < 0 ? hwL : hwR;
        const crestSide = signedCross < 0 ? crestL : crestR;
        if (d >= crestSide) continue;
        const wyO = a.wy + (b.wy - a.wy) * t;
        const depthO = a.depth + (b.depth - a.depth) * t;
        const bedYO = wyO - depthO;
        const shoreYO = Math.min(crestY, wyO - Math.min(0.24, Math.max(0.10, depthO * 0.24)));
        const wetShelf = hwSide + 0.36;
        let surfOrBedY;
        let subShare;
        if (d <= hwSide) {
          const u = d / Math.max(0.35, hwSide);
          const sm = u * u * (3 - 2 * u);
          surfOrBedY = bedYO + (shoreYO - bedYO) * sm;
          subShare = 1.0 - 0.18 * sm;
        } else if (d <= wetShelf) {
          surfOrBedY = shoreYO;
          subShare = 0.82;
        } else {
          const u = Math.min(1, (d - wetShelf) / Math.max(0.45, crestSide - wetShelf));
          const sm = u * u * (3 - 2 * u);
          surfOrBedY = shoreYO + (crestY - shoreYO) * sm;
          subShare = 0.82 * (1 - sm);
        }
        if (surfOrBedY < clampedY) clampedY = surfOrBedY;
        if (subShare > clampedWet) clampedWet = subShare;
      }
    }
    return pushBankVert(vx, clampedY, vz, nx, ny, nz, clampedWet);
  };

  for (let cIdx = 0; cIdx < reachChains.length; cIdx++) {
    const chain = reachChains[cIdx], st = chain.stations, isCanal = chain.isCanal;
    emitRiverRibbon(st, isCanal, cIdx, chain);
    let length = 0, minHalfWidth = Infinity;
    const reachPts = [];
    for (let i = 0; i < st.length; i++) {
      const cur = st[i];
      minHalfWidth = Math.min(minHalfWidth, cur.hw);
      if (i > 0) length += Math.hypot(cur.wx - st[i - 1].wx, cur.wz - st[i - 1].wz);
      const speed = cur.speedCenter ?? (isCanal ? 0.35 : 0.9);
      reachPts.push([cur.wx, cur.wz, cur.hw, cur.wy, cur.depth, cur.tx * speed, cur.tz * speed, cur.thalwegB, cur.estuaryT ?? 0]);
    }
    riverReaches.push({ id: cIdx, isCanal, minHalfWidth, length, seaConnected: Boolean(st[st.length - 1].seaMouth), points: reachPts });
    // Emit shared-crest embankment + subdivided bank ramps + asymmetric thalweg bed strips and convex 2D cut tris.
    let prevRow = null;
    for (let i = 0; i < st.length; i++) {
      const cur = st[i], nx = cur.nx, nz = cur.nz;
      if (cur.seaPlume) { prevRow = null; continue; }
      const hwL = cur.hwL ?? cur.hw, hwR = cur.hwR ?? cur.hw, thal = cur.thalwegB ?? 0;
      const crestHwL = cur.crestHwL ?? cur.crestHw, crestHwR = cur.crestHwR ?? cur.crestHw;
      const bedOff = thal * cur.hw * 0.45;
      const bedHwL = Math.max(0.32, hwL * (0.58 - thal * 0.25));
      const bedHwR = Math.max(0.32, hwR * (0.58 + thal * 0.25));
      const bedY = cur.wy - cur.depth;
      const subMargin = Math.min(0.24, Math.max(0.10, cur.depth * 0.24));
      const slY = Math.min(cur.ly, cur.wy - subMargin);
      const srY = Math.min(cur.ry, cur.wy - subMargin);
      const bankDxL = Math.max(0.6, crestHwL - hwL);
      const bankDxR = Math.max(0.6, crestHwR - hwR);
      const lSlopeLen = Math.hypot(bankDxL, Math.max(0, cur.ly - slY));
      const rSlopeLen = Math.hypot(bankDxR, Math.max(0, cur.ry - srY));
      const lnx = (cur.ly - slY) / lSlopeLen, lny = bankDxL / lSlopeLen;
      const rnx = (cur.ry - srY) / rSlopeLen, rny = bankDxR / rSlopeLen;
      const slX = cur.wx - nx * hwL, slZ = cur.wz - nz * hwL;
      const srX = cur.wx + nx * hwR, srZ = cur.wz + nz * hwR;
      const vCL = pushDepressedBankVert(cIdx, cur.lx, cur.ly, cur.lz, 0, 1, 0, 0.0);
      const vML1 = pushDepressedBankVert(cIdx, cur.lx + (slX - cur.lx) * 0.34, cur.ly + (slY - cur.ly) * 0.34, cur.lz + (slZ - cur.lz) * 0.34, nx * lnx, lny, nz * lnx, 0.24);
      const vML2 = pushDepressedBankVert(cIdx, cur.lx + (slX - cur.lx) * 0.68, cur.ly + (slY - cur.ly) * 0.68, cur.lz + (slZ - cur.lz) * 0.68, nx * lnx, lny, nz * lnx, 0.56);
      const vSL = pushDepressedBankVert(cIdx, slX, slY, slZ, nx * lnx, lny, nz * lnx, 0.82);
      const vBL = pushDepressedBankVert(cIdx, cur.wx + nx * (bedOff - bedHwL), bedY - 0.12 * cur.depth * Math.max(0, thal), cur.wz + nz * (bedOff - bedHwL), nx * 0.28, 0.96, nz * 0.28, 1.0);
      const vBR = pushDepressedBankVert(cIdx, cur.wx + nx * (bedOff + bedHwR), bedY - 0.12 * cur.depth * Math.max(0, -thal), cur.wz + nz * (bedOff + bedHwR), -nx * 0.28, 0.96, -nz * 0.28, 1.0);
      const vSR = pushDepressedBankVert(cIdx, srX, srY, srZ, -nx * rnx, rny, -nz * rnx, 0.82);
      const vMR2 = pushDepressedBankVert(cIdx, cur.rx + (srX - cur.rx) * 0.68, cur.ry + (srY - cur.ry) * 0.68, cur.rz + (srZ - cur.rz) * 0.68, -nx * rnx, rny, -nz * rnx, 0.56);
      const vMR1 = pushDepressedBankVert(cIdx, cur.rx + (srX - cur.rx) * 0.34, cur.ry + (srY - cur.ry) * 0.34, cur.rz + (srZ - cur.rz) * 0.34, -nx * rnx, rny, -nz * rnx, 0.24);
      const vCR = pushDepressedBankVert(cIdx, cur.rx, cur.ry, cur.rz, 0, 1, 0, 0.0);
      const row = [vCL, vML1, vML2, vSL, vBL, vBR, vSR, vMR2, vMR1, vCR];
      if (prevRow) {
        const pSt = st[i - 1];
        pushRiverCutPoly([[pSt.lx, pSt.lz], [cur.lx, cur.lz], [cur.rx, cur.rz]]);
        pushRiverCutPoly([[pSt.lx, pSt.lz], [cur.rx, cur.rz], [pSt.rx, pSt.rz]]);
        for (let b = 0; b < row.length - 1; b++) {
          pushBankTri(prevRow[b], row[b], row[b + 1]);
          pushBankTri(prevRow[b], row[b + 1], prevRow[b + 1]);
        }
      }
      prevRow = row;
    }
  }

  function emitRiverRibbon(st, isCanal, cIdx, chain) {
    // 11-across hydraulic mesh with local flow vectors, shifted thalweg depth, bend separation eddies, bridge pier wakes & estuary sea-mouth blend.
    for (let i = 1; i < st.length; i++) st[i].wy = Math.min(st[i].wy, st[i - 1].wy);
    const hasSeaMouth = Boolean(!isCanal && st[st.length - 1]?.seaMouth && !chain?.mouthJoin);
    const shoreS = chain?.shoreS ?? st[st.length - 1].alongS ?? 0;
    const totalS = Math.max(1, st[st.length - 1].alongS ?? 1);
    const shoreHw = st[Math.min(st.length - 1, chain?.shoreIdx ?? st.length - 1)]?.hw ?? 3;
    const tidalSpan = Math.min(80, Math.max(26, shoreHw * 10));
    const tidalStartS = Math.max(0, shoreS - tidalSpan);
    let maxEstT = 0;
    const lanes = [-1.0, -0.84, -0.66, -0.46, -0.24, 0.0, 0.24, 0.46, 0.66, 0.84, 1.0];
    let prevRow = null;
    for (let i = 0; i < st.length; i++) {
      const cur = st[i], p0 = st[Math.max(0, i - 1)], p1 = st[Math.min(st.length - 1, i + 1)];
      const dx = p1.wx - p0.wx, dz = p1.wz - p0.wz, dLen = Math.hypot(dx, dz) || 1;
      const tx = dx / dLen, tz = dz / dLen, nx = -tz, nz = tx;
      const slope = Math.max(0, (p0.wy - p1.wy) / dLen);
      const speed = isCanal ? 0.36 : Math.max(0.58, Math.min(3.35, 0.65 + Math.sqrt(slope) * 7.6));
      cur.speedCenter = speed;
      let estuaryT = 0;
      if (hasSeaMouth) {
        const sPos = cur.alongS ?? 0;
        if (sPos <= tidalStartS || cur.wy > 0.68) estuaryT = 0;
        else if (sPos <= shoreS) {
          estuaryT = 0.38 * ((sPos - tidalStartS) / Math.max(1, shoreS - tidalStartS)) * Math.min(1, Math.max(0, (0.68 - cur.wy) / 0.55));
        } else {
          estuaryT = 0.38 + 0.62 * ((sPos - shoreS) / Math.max(1, totalS - shoreS));
        }
        maxEstT = Math.max(maxEstT, Math.min(1, estuaryT));
        estuaryT = maxEstT;
      }
      cur.estuaryT = estuaryT;
      const vertKind = isCanal ? 1.0 : Math.min(0.95, estuaryT * 0.95);
      const seaOpen = Math.max(0, Math.min(1, (estuaryT - 0.36) / 0.18));
      const jetDecay = hasSeaMouth ? (1 - 0.68 * Math.max(0, (estuaryT - 0.28) / 0.72)) : 1;
      const hwL = (cur.hwL ?? cur.hw) + 0.45, hwR = (cur.hwR ?? cur.hw) + 0.45, hwMean = 0.5 * (hwL + hwR);
      const thal = cur.thalwegB ?? 0;
      // Check proximity just downstream of bridges to excite cutwater eddies.
      let pierWake = 0;
      for (const b of bridges) {
        const bx = cur.wx - b.x, bz = cur.wz - b.z;
        const down = bx * tx + bz * tz;
        if (down > -3.5 && down < 16.0 && Math.hypot(bx, bz) < hwMean + 10.0) {
          const w = (1 - Math.max(0, down) / 16.0) * (down < 0 ? Math.max(0, 1 + down / 3.5) : 1);
          if (w > pierWake) pierWake = w;
        }
      }
      const row = lanes.map((bt) => {
        const edge = Math.abs(bt);
        const span = bt < 0 ? hwL * bt : hwR * bt;
        // Asymmetric depth: deepest near thalwegB (cut bank), shoaling gently across inner point bar, feathered at edge.
        const edgeTaper = Math.max(0, 1 - edge * edge);
        const thalFactor = Math.exp(-1.55 * (bt - thal) * (bt - thal));
        const asymMul = isCanal ? (1 - 0.55 * edge * edge) : (0.16 + 0.92 * edgeTaper * (0.52 + 0.62 * thalFactor));
        const flankMinDepth = seaOpen * cur.depth * 0.65;
        const localDepth = Math.max(flankMinDepth, bt === -1.0 || bt === 1.0 ? 0.0 : cur.depth * asymMul);
        const yOff = (edge > 0.95 ? -0.04 : edge > 0.65 ? -0.012 : 0.0) * (1 - seaOpen);

        // Lateral velocity shear profile + bend separation counter-current on steep inner point bars + sea-mouth outflow fan.
        const distFromThal = bt - thal;
        const coreVel = Math.max(0.16, 1.08 * Math.exp(-0.92 * distFromThal * distFromThal));
        const bendSep = (!isCanal && !seaOpen && Math.abs(thal) > 0.16 && bt * thal < -0.10)
          ? Math.min(1, (Math.abs(thal) - 0.16) * 2.4 * Math.min(1, (-bt * Math.sign(thal) - 0.10) * 1.8))
          : 0;
        const alongScale = coreVel * (1 - 1.28 * bendSep);
        // Subtle helicoidal cross-current on bends; outward radial fan where outflow spreads into the bay.
        const crossScale = (!isCanal && !cur.seaMouth) ? thal * 0.11 * edgeTaper : 0;
        const baseVx = (tx * alongScale + nx * crossScale) * speed * jetDecay;
        const baseVz = (tz * alongScale + nz * crossScale) * speed * jetDecay;
        const fanAngle = bt * 0.40 * seaOpen;
        const cf = Math.cos(fanAngle), sf = Math.sin(fanAngle);
        const vx = baseVx * cf - baseVz * sf;
        const vz = baseVx * sf + baseVz * cf;
        const localSpeed = Math.hypot(vx, vz);

        const shearEddy = Math.min(1, (edge > 0.4 ? (edge - 0.4) * 0.95 : 0.12) * Math.min(1.2, speed / 1.1));
        const eddy = Math.min(1, Math.max(shearEddy, bendSep * 0.95, pierWake * (1 - 0.5 * Math.abs(bt)) * 0.92));
        const froude = localSpeed / Math.sqrt(9.81 * Math.max(0.18, localDepth));
        const riffle = isCanal ? 0 : Math.min(1.48, Math.max(0, (froude - 0.16) * 1.35 + Math.max(0, slope - 0.008) * 18.0)) * (1 - seaOpen);

        return pushWaterVert(
          cur.wx + nx * span,
          cur.wy + yOff,
          cur.wz + nz * span,
          vertKind,
          vx, vz,
          cur.alongS ?? i * 2.5,
          hwMean,
          localDepth,
          bt,
          thal,
          eddy,
          riffle,
        );
      });
      if (prevRow) {
        for (let b = 0; b < lanes.length - 1; b++) {
          waterIdx.push(prevRow[b], row[b], row[b + 1], prevRow[b], row[b + 1], prevRow[b + 1]);
        }
      }
      prevRow = row;
    }
  }

  // Carve & fill any dammed estate ponds with concentric rings & circulation eddies.
  const ponds = [];
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
    let maxR = 4;
    for (let k = 0; k < pm; k++) maxR = Math.max(maxR, Math.hypot(poly[k * 2] - cx, poly[k * 2 + 1] - cz));
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
    ponds.push({ cx, cz, wy: pondY, depth: 1.75, radius: maxR, poly, x0: px0, z0: pz0, x1: px1, z1: pz1 });
    const centerV = pushWaterVert(cx, pondY, cz, 2.0, 0.04, 0.02, 0, maxR, 1.75, 0.0, 0.0, 0.18, 0.0);
    const ringFracs = [0.24, 0.52, 0.78, 1.0];
    let prevRing = null;
    for (let rf = 0; rf < ringFracs.length; rf++) {
      const frac = ringFracs[rf], ringV = [];
      for (let k = 0; k < pm; k++) {
        const wx = poly[k * 2], wz = poly[k * 2 + 1];
        const rx = cx + (wx - cx) * frac * (rf === ringFracs.length - 1 ? 1.06 : 1.0);
        const rz = cz + (wz - cz) * frac * (rf === ringFracs.length - 1 ? 1.06 : 1.0);
        const dx = rx - cx, dz = rz - cz, rLen = Math.hypot(dx, dz) || 1;
        // Slow wind/weir circulation swirl around pond rim.
        const swirl = 0.09 * frac;
        ringV.push(pushWaterVert(
          rx,
          rf === ringFracs.length - 1 ? pondY - 0.025 : pondY,
          rz,
          2.0,
          0.03 - (dz / rLen) * swirl,
          0.02 + (dx / rLen) * swirl,
          frac * maxR,
          maxR,
          rf === ringFracs.length - 1 ? 0.0 : 1.75 * (1 - 0.82 * frac * frac),
          frac,
          0.0,
          0.22 * frac,
          0.0,
        ));
      }
      if (!prevRing) {
        for (let k = 0; k < pm; k++) waterIdx.push(centerV, ringV[k], ringV[(k + 1) % pm]);
      } else {
        for (let k = 0; k < pm; k++) {
          const kn = (k + 1) % pm;
          waterIdx.push(prevRing[k], ringV[k], ringV[kn], prevRing[k], ringV[kn], prevRing[kn]);
        }
      }
      prevRing = ringV;
    }
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
    plan, town, roads, parcelAt, places, seat, inlandWater, ponds, herds, loneTrees, bridges,
    riverCut: riverCuts.length ? { cuts: riverCuts, bankVerts: new Float32Array(bankVerts), bankIndices: new Uint32Array(bankIndices) } : null,
    riverReaches,
    // Who mans the seat, by the model's own roll on the board's day: its port's posts are manned from it (js/crew.js).
    watch: seat.watch ? { ...seat.watch, place: seat.name, day: board.day ?? 0 } : null,
    // For the GPU, which stamps the country onto the ground's own colours: the furlong of every cell, each
    // furlong's use, and every way that runs across it.
    stamp: {
      size, index, uses, roads, streets, squares, lots, town: urban, lanes: board.lanes, rivers: rivers.map((river) => river.points), bridges,
      origin: { x: ox, z: oz }, span: region.span,
    },
  };
}
