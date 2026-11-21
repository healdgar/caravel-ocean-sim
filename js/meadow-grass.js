// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Meadow grass, drawn through the one continuum alone (AGENTS.md rule 3; js/meadow-continuum.js for the atlas,
// scripts/prepare-meadow-grass.mjs for its bake, js/wgsl/meadow-continuum.js for its stand pass and material). A
// meadow is 4 m patches of the groves' full-resolution sward laid edge to edge on a world grid wherever the cover map
// (below) says grass grows. Every frame the meadow's stand pass writes each patch in view, or in the shadow map's box,
// as a record of the one format, draped over the ground the land draws and swayed by the WIND kind; the one cut
// (js/continuum-scene.js) cuts each at the scene's one pixel error, draws it with the meadow's material, casts its
// shadow and draws it under water. Nothing here selects, lists or draws a patch of its own.
// Grass is never a target: shot passes through it. Craters bury it, and passing shot and blast rings part it, from
// the land's own crater field and the frame's ballistic wakes.
import { requestOnce } from './gpu-program-cache.js';
import { continuumPixelError } from './continuum-core.js';
import { continuumProfile } from './continuum-profiles.js';
import { CONTINUUM_HEADER, CONTINUUM_TYPE_WORDS, continuumRoom } from './continuum-format.js';
import { CONTINUUM_ROW } from './wgsl/continuum-cut.js';
import { createContinuumScene, requestContinuumAtlas, requestContinuumPrograms, requestContinuumView, continuumAtlasPages } from './continuum-scene.js';
import { continuumGroundView } from './continuum-ground.js';
import { LAND_SHADOW_FORMAT } from './shadows.js';
import { terrainSurfaceSample } from './terrain-model.js';
import { CITY_BLOCK_FLOATS, CITY_GROUND } from './old-world-city.js';
import { INLAND_WATER_FLOATS } from './wgsl/inland-water.js';
import { LAND_CRATER_TILE_M } from './wgsl/land-craters.js';
import { streetEdgeAt, unpackRouteHalfWidthSlope } from './town-streets.js';
import { MEADOW_PATCH_METRES, MEADOW_MIX_ROLES, MEADOW_CONTINUUM_MATERIAL } from './meadow-continuum.js';
import {
  MEADOW_MAX_SHOT_WAKES, MEADOW_MAX_BLAST_RINGS, MEADOW_WAKE_BUFFER_BYTES, MEADOW_BLOCK_PATCHES, MEADOW_WORK_HEADER, MEADOW_CONTINUUM_POSE,
  MEADOW_CONTINUUM_CFG_BYTES, MEADOW_CONTINUUM_STOOD_BYTES, MEADOW_GUST_WAVE, MEADOW_CONTINUUM_SPEC, MEADOW_GRAIN_BITS, meadowContinuumStandWGSL,
} from './wgsl/meadow-continuum.js';

const MEADOW_COVER_DESKTOP = 2048; // 4.0 m/texel across 8192 m region with bilinear SDF filtering
const MEADOW_COVER_MOBILE = 1024;
// The most records the stand pass may write a frame (the patches in view and in the shadow map's box), held further
// to what the device lets one buffer bind. Because meadowStandBudget coarsens blocks beyond 64 m (grain 2..16),
// even an 8 km hillside fits in ~3k-8k records, so 1<<18 desktop / 1<<16 mobile gives >30x headroom with ~8x less VRAM.
const MEADOW_CONTINUUM_CAPACITY = 1 << 18, MEADOW_CONTINUUM_MOBILE_CAPACITY = 1 << 16, MEADOW_CONTINUUM_SECONDARY_CAPACITY = 1 << 16;
// The ground meadows stop at.
const MEADOW_WATERLINE = 0.75;

function hash2D(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise2D(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2D(ix, iz), b = hash2D(ix + 1, iz);
  const c = hash2D(ix, iz + 1), d = hash2D(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function smooth01(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
}

function sampleGridBilinear(arr, n, u, v) {
  const qx = Math.max(0, Math.min(n - 1, u * (n - 1)));
  const qz = Math.max(0, Math.min(n - 1, v * (n - 1)));
  const i0 = Math.min(n - 2, Math.floor(qx)), j0 = Math.min(n - 2, Math.floor(qz));
  const fx = qx - i0, fz = qz - j0;
  const row0 = j0 * n, row1 = (j0 + 1) * n;
  const a = arr[row0 + i0], b = arr[row0 + i0 + 1];
  const c = arr[row1 + i0], d = arr[row1 + i0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

function pointToSegDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 1e-8) {
    const ex = px - ax, ez = pz - az;
    return ex * ex + ez * ez;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  const ex = px - (ax + dx * t), ez = pz - (az + dz * t);
  return ex * ex + ez * ez;
}

function pointInTri2D(px, pz, ax, az, bx, bz, cx, cz) {
  const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
  const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
  const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// Bake static high-resolution (2048x2048 = 4 m/texel) anti-aliased SDF meadow coverage map:
// R = cover (0..255), G = the mix's role (MEADOW_MIX_ROLES: 0 lowland, 128 upland, 255 margin), B = height/lushness
// modulation (0..255), A = 255. A pack whose margin is a strand (`coast`) sows it on the low ground behind its beaches,
// and its upland on scrub as on slopes.
export function buildMeadowCoverMap({
  region,
  heights,
  biome,
  beaches = null,
  port = null,
  city = null,
  board = null,
  inlandWater = null,
  coast = false,
  size = MEADOW_COVER_DESKTOP,
}) {
  const cover = new Uint8Array(size * size * 4);
  if (!region || !heights) return cover;
  const span = region.span, x0 = region.x - span * 0.5, z0 = region.z - span * 0.5;
  const step = span / size, invStep = size / span, invSpan = 1 / span;
  const maskSize = region.biomeSize || Math.round(Math.sqrt(biome?.length || 0)) || 512;
  const hasBiome = biome instanceof Uint8Array && biome.length === maskSize * maskSize;
  const dry = beaches?.drySandMask, swash = beaches?.swashMask;
  const hGridN = region.size || Math.round(Math.sqrt(heights.length));
  const hasFastHeights = hGridN >= 2 && heights.length >= hGridN * hGridN;
  const inside = span * 0.5 - 0.01;
  const ground = (x, z) => terrainSurfaceSample(
    heights,
    Math.max(region.x - inside, Math.min(region.x + inside, x)),
    Math.max(region.z - inside, Math.min(region.z + inside, z)),
    region,
  );
  const fastGround = hasFastHeights
    ? (wx, wz) => sampleGridBilinear(heights, hGridN, (wx - x0) * invSpan, (wz - z0) * invSpan)
    : ground;

  const activeBoard = board?.rivers
    ? board
    : port?.country?.stamp?.rivers
      ? port.country.stamp
      : port?.country?.board?.rivers
        ? port.country.board
        : null;
  const townArr = activeBoard?.town;
  const townLattice = townArr?.length ? Math.round(Math.sqrt(townArr.length)) : 0;
  const hasCityGround = typeof city?.groundAt === 'function';

  const baseN = Math.min(size, 512);
  const baseStep = span / baseN;
  const baseR = new Float32Array(baseN * baseN);
  const baseG = new Float32Array(baseN * baseN);
  const baseB = new Float32Array(baseN * baseN);

  for (let j = 0; j < baseN; j++) {
    const wz = z0 + (j + 0.5) * baseStep;
    const v = (j + 0.5) / baseN;
    const bj = Math.min(maskSize - 1, Math.floor(v * maskSize)) * maskSize;
    for (let i = 0; i < baseN; i++) {
      const wx = x0 + (i + 0.5) * baseStep;
      const u = (i + 0.5) / baseN;
      const idx = j * baseN + i;
      const cell = bj + Math.min(maskSize - 1, Math.floor(u * maskSize));

      const y = ground(wx, wz);
      if (!(y >= 0.4) || y > 860) continue;

      const dryFade = dry ? 1.0 - smooth01(48, 120, dry[cell]) : 1.0;
      const swashFade = swash ? 1.0 - smooth01(16, 60, swash[cell]) : 1.0;
      if (dryFade * swashFade <= 0.005) continue;

      let urbanFade = 1.0;
      if (townLattice >= 2) {
        const uVal = sampleGridBilinear(townArr, townLattice, u, v);
        urbanFade = 1.0 - smooth01(0.30, 0.78, uVal);
        if (urbanFade <= 0.005) continue;
      }

      let parkBonus = false;
      if (hasCityGround && !activeBoard) {
        const cg = city.groundAt(wx, wz);
        if (cg === CITY_GROUND.STREET || cg === CITY_GROUND.SQUARE || cg === CITY_GROUND.HOUSE || cg === CITY_GROUND.CASTLE) continue;
        parkBonus = cg === CITY_GROUND.PARK;
      }

      const sx = (fastGround(wx + 3.0, wz) - fastGround(wx - 3.0, wz)) / 6.0;
      const sz = (fastGround(wx, wz + 3.0) - fastGround(wx, wz - 3.0)) / 6.0;
      const slope = Math.hypot(sx, sz);
      const slopeFade = 1.0 - smooth01(0.38, 0.72, slope);
      if (slopeFade <= 0.005) continue;

      const marked = hasBiome ? biome[cell] : 20;
      const forestFade = parkBonus ? 1.0 : 1.0 - smooth01(175, 245, marked);
      if (forestFade <= 0.005) continue;

      const n1 = valueNoise2D(wx * 0.018, wz * 0.018);
      const n2 = valueNoise2D(wx * 0.062 + 17.3, wz * 0.062 - 9.1);
      const patch = 0.84 + 0.16 * (n1 * 0.65 + n2 * 0.35);

      let dens = (0.86 + 0.14 * n1) * patch * slopeFade * forestFade * dryFade * swashFade * urbanFade;
      let mixVal = 0;
      let hScale = 176;
      if (parkBonus) {
        dens = Math.max(dens, 0.94 * dryFade * swashFade);
        mixVal = coast ? 0 : 210;
        hScale = 186;
      } else if (coast && ((dry && dry[cell] > 0) || (y < 2.6 && slope < 0.12))) {
        mixVal = 255;
        hScale = 150;
      } else if (slope > 0.24 || y > 185) {
        mixVal = 128;
        hScale = 148;
      } else if (marked >= 68) {
        mixVal = coast ? 128 : 255;
        hScale = 196;
      } else {
        mixVal = !coast && n2 > 0.58 ? 255 : 0;
        hScale = 180;
      }

      baseR[idx] = Math.max(0, Math.min(255, dens * 255));
      baseG[idx] = mixVal;
      baseB[idx] = Math.max(0, Math.min(255, hScale * (0.88 + 0.24 * n2)));
    }
  }

  if (baseN === size) {
    for (let j = 0; j < size; j++) {
      const wz = z0 + (j + 0.5) * step;
      for (let i = 0; i < size; i++) {
        const idx = j * size + i;
        const p4 = idx * 4;
        cover[p4 + 3] = 255;
        const r0 = baseR[idx];
        if (r0 <= 0.5) continue;
        const wx = x0 + (i + 0.5) * step;
        const y = fastGround(wx, wz);
        const altFade = smooth01(1.10, 2.85, y);
        if (altFade <= 0.004) continue;
        cover[p4] = Math.round(r0 * altFade);
        cover[p4 + 1] = Math.round(baseG[idx]);
        cover[p4 + 2] = Math.round(baseB[idx]);
      }
    }
  } else {
    for (let j = 0; j < size; j++) {
      const wz = z0 + (j + 0.5) * step;
      const v = (j + 0.5) / size;
      for (let i = 0; i < size; i++) {
        const idx = j * size + i;
        const p4 = idx * 4;
        cover[p4 + 3] = 255;
        const u = (i + 0.5) / size;
        const r0 = sampleGridBilinear(baseR, baseN, u, v);
        if (r0 <= 0.5) continue;
        const wx = x0 + (i + 0.5) * step;
        const y = fastGround(wx, wz);
        const altFade = smooth01(1.10, 2.85, y);
        if (altFade <= 0.004) continue;
        cover[p4] = Math.round(r0 * altFade);
        cover[p4 + 1] = Math.round(sampleGridBilinear(baseG, baseN, u, v));
        cover[p4 + 2] = Math.round(sampleGridBilinear(baseB, baseN, u, v));
      }
    }
  }

  const carveTaperedCapsule = (ax, az, hwA, bx, bz, hwB, padClear, featherR, minKeep = 0) => {
    const maxR = Math.max(hwA, hwB) + padClear + featherR;
    const minX = Math.min(ax, bx) - maxR, maxX = Math.max(ax, bx) + maxR;
    const minZ = Math.min(az, bz) - maxR, maxZ = Math.max(az, bz) + maxR;
    if (maxX < x0 || minX > x0 + span || maxZ < z0 || minZ > z0 + span) return;
    const i0 = Math.max(0, Math.floor((minX - x0) * invStep));
    const i1 = Math.min(size - 1, Math.floor((maxX - x0) * invStep));
    const j0 = Math.max(0, Math.floor((minZ - z0) * invStep));
    const j1 = Math.min(size - 1, Math.floor((maxZ - z0) * invStep));
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    const isPt = lenSq <= 1e-8;
    const invLenSq = isPt ? 0 : 1 / lenSq;

    for (let j = j0; j <= j1; j++) {
      const wz = z0 + (j + 0.5) * step;
      const row = j * size;
      for (let i = i0; i <= i1; i++) {
        const p4 = (row + i) * 4;
        const cur = cover[p4];
        if (cur === 0) continue;
        const wx = x0 + (i + 0.5) * step;
        const t = isPt ? 0 : Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) * invLenSq));
        const cx = ax + dx * t, cz = az + dz * t;
        const d = Math.hypot(wx - cx, wz - cz);
        const clearR = hwA + (hwB - hwA) * t + padClear;
        if (d <= clearR) {
          cover[p4] = minKeep === 0 ? 0 : Math.min(cur, Math.round(cur * minKeep));
        } else if (d < clearR + featherR) {
          const keep = minKeep + (1 - minKeep) * smooth01(0, featherR, d - clearR);
          const next = Math.round(cur * keep);
          if (next < cur) cover[p4] = next;
        }
      }
    }
  };

  const carveOBB = (cx, cz, cosY, sinY, hw, hd, featherR) => {
    const ext = Math.hypot(hw + featherR, hd + featherR);
    if (cx + ext < x0 || cx - ext > x0 + span || cz + ext < z0 || cz - ext > z0 + span) return;
    const i0 = Math.max(0, Math.floor((cx - ext - x0) * invStep));
    const i1 = Math.min(size - 1, Math.floor((cx + ext - x0) * invStep));
    const j0 = Math.max(0, Math.floor((cz - ext - z0) * invStep));
    const j1 = Math.min(size - 1, Math.floor((cz + ext - z0) * invStep));
    for (let j = j0; j <= j1; j++) {
      const dz = z0 + (j + 0.5) * step - cz;
      const row = j * size;
      for (let i = i0; i <= i1; i++) {
        const p4 = (row + i) * 4;
        const cur = cover[p4];
        if (cur === 0) continue;
        const dx = x0 + (i + 0.5) * step - cx;
        const lx = dx * cosY - dz * sinY;
        const lz = dx * sinY + dz * cosY;
        const qx = Math.max(0, Math.abs(lx) - hw);
        const qz = Math.max(0, Math.abs(lz) - hd);
        if (qx === 0 && qz === 0) {
          cover[p4] = 0;
        } else {
          const d = Math.hypot(qx, qz);
          if (d < featherR) {
            const next = Math.round(cur * smooth01(0, featherR, d));
            if (next < cur) cover[p4] = next;
          }
        }
      }
    }
  };

  // 1. Carve ALL river reaches & canals from port.country
  const reaches = port?.country?.riverReaches ?? [];
  for (const reach of reaches) {
    const stations = Array.isArray(reach?.stations)
      ? reach.stations
      : Array.isArray(reach?.points)
        ? reach.points.map(([wx, wz, hw, wy, , , , , estuaryT]) => ({ wx, wz, hw, wy, estuaryT }))
        : null;
    if (!stations || stations.length < 2) continue;
    for (let k = 0; k < stations.length - 1; k++) {
      const a = stations[k], b = stations[k + 1];
      if (!a || !b) continue;
      if ((a.estuaryT ?? 0) > 0.52 && (b.estuaryT ?? 0) > 0.52 && Math.max(a.wy ?? 0, b.wy ?? 0) <= 0.03) continue;
      carveTaperedCapsule(a.wx, a.wz, Math.max(1.8, a.hw ?? 2.4), b.wx, b.wz, Math.max(1.8, b.hw ?? 2.4), 3.0, 4.6, 0);
    }
  }

  // 2. Carve ALL board river polylines at full station resolution (stride = 3: rx, rz, hw)
  if (activeBoard?.rivers) {
    const ox = activeBoard.origin?.x ?? 0, oz = activeBoard.origin?.z ?? 0;
    for (const river of activeBoard.rivers) {
      for (let k = 3; k + 2 < river.length; k += 3) {
        carveTaperedCapsule(
          ox + river[k - 3], oz + river[k - 2], Math.max(1.8, river[k - 1]),
          ox + river[k], oz + river[k + 1], Math.max(1.8, river[k + 2]),
          3.0, 4.6, 0,
        );
      }
    }
  }

  // 3. Carve ALL estate & mill ponds
  for (const p of port?.country?.ponds ?? []) {
    const wx = p?.wx ?? p?.cx, wz = p?.wz ?? p?.cz;
    const rx = (p?.rx ?? p?.radius ?? 0) + 3.0, rz = (p?.rz ?? p?.radius ?? 0) + 3.0;
    if (!Number.isFinite(wx) || !Number.isFinite(wz) || !(rx > 3.0 && rz > 3.0)) continue;
    const feather = 4.5;
    const ext = Math.max(rx, rz) + feather;
    const cosR = Math.cos(-(p.rot ?? 0)), sinR = Math.sin(-(p.rot ?? 0));
    const i0 = Math.max(0, Math.floor((wx - ext - x0) * invStep));
    const i1 = Math.min(size - 1, Math.floor((wx + ext - x0) * invStep));
    const j0 = Math.max(0, Math.floor((wz - ext - z0) * invStep));
    const j1 = Math.min(size - 1, Math.floor((wz + ext - z0) * invStep));
    for (let j = j0; j <= j1; j++) {
      const dz = z0 + (j + 0.5) * step - wz;
      const row = j * size;
      for (let i = i0; i <= i1; i++) {
        const p4 = (row + i) * 4;
        if (cover[p4] === 0) continue;
        const dx = x0 + (i + 0.5) * step - wx;
        const lx = dx * cosR - dz * sinR, lz = dx * sinR + dz * cosR;
        const normR = Math.hypot(lx / rx, lz / rz);
        if (normR <= 1.0) {
          cover[p4] = 0;
        } else {
          const approxM = (normR - 1.0) * Math.min(rx, rz);
          if (approxM < feather) {
            cover[p4] = Math.min(cover[p4], Math.round(cover[p4] * smooth01(0, feather, approxM)));
          }
        }
      }
    }
  }

  // 4. Exact triangle + edge-pad rasterization of EVERY rendered inlandWater mesh triangle
  const iwVerts = inlandWater?.vertices, iwIdx = inlandWater?.indices;
  if (iwVerts?.length >= INLAND_WATER_FLOATS * 3 && iwIdx?.length >= 3) {
    const padClear = Math.max(4.0, step * Math.SQRT2 + 0.16), featherR = 4.4, padMax = padClear + featherR;
    const padClearSq = padClear * padClear, padMaxSq = padMax * padMax;
    for (let t = 0; t + 2 < iwIdx.length; t += 3) {
      const o0 = iwIdx[t] * INLAND_WATER_FLOATS;
      const o1 = iwIdx[t + 1] * INLAND_WATER_FLOATS;
      const o2 = iwIdx[t + 2] * INLAND_WATER_FLOATS;
      const ax = iwVerts[o0], az = iwVerts[o0 + 2];
      const bx = iwVerts[o1], bz = iwVerts[o1 + 2];
      const cx = iwVerts[o2], cz = iwVerts[o2 + 2];
      const minX = Math.min(ax, bx, cx) - padMax, maxX = Math.max(ax, bx, cx) + padMax;
      const minZ = Math.min(az, bz, cz) - padMax, maxZ = Math.max(az, bz, cz) + padMax;
      if (maxX < x0 || minX > x0 + span || maxZ < z0 || minZ > z0 + span) continue;
      const i0 = Math.max(0, Math.floor((minX - x0) * invStep));
      const i1 = Math.min(size - 1, Math.floor((maxX - x0) * invStep));
      const j0 = Math.max(0, Math.floor((minZ - z0) * invStep));
      const j1 = Math.min(size - 1, Math.floor((maxZ - z0) * invStep));
      for (let j = j0; j <= j1; j++) {
        const wz = z0 + (j + 0.5) * step;
        const row = j * size;
        for (let i = i0; i <= i1; i++) {
          const p4 = (row + i) * 4;
          const cur = cover[p4];
          if (cur === 0) continue;
          const wx = x0 + (i + 0.5) * step;
          if (pointInTri2D(wx, wz, ax, az, bx, bz, cx, cz)) {
            cover[p4] = 0;
            continue;
          }
          const dSq = Math.min(
            pointToSegDistSq(wx, wz, ax, az, bx, bz),
            pointToSegDistSq(wx, wz, bx, bz, cx, cz),
            pointToSegDistSq(wx, wz, cx, cz, ax, az),
          );
          if (dSq <= padClearSq) {
            cover[p4] = 0;
          } else if (dSq < padMaxSq) {
            const next = Math.round(cur * smooth01(padClear, padMax, Math.sqrt(dSq)));
            if (next < cur) cover[p4] = next;
          }
        }
      }
    }
  }

  // 5. Carve roads, village lanes, streets, bridges & squares
  if (activeBoard) {
    const ox = activeBoard.origin?.x ?? 0, oz = activeBoard.origin?.z ?? 0;
    for (const road of activeBoard.roads ?? []) {
      for (let k = 1; k < road.length; k++) {
        carveTaperedCapsule(road[k - 1][0], road[k - 1][1], 3.4, road[k][0], road[k][1], 3.4, 0.6, 2.8, 0);
      }
    }
    const lanes = activeBoard.lanes ?? [];
    for (let k = 0; k + 3 < lanes.length; k += 4) {
      carveTaperedCapsule(ox + lanes[k], oz + lanes[k + 1], 1.6, ox + lanes[k + 2], oz + lanes[k + 3], 1.6, 0.5, 2.4, 0);
    }
    for (const st of activeBoard.streets ?? []) {
      const pts = st?.pts;
      if (!pts || pts.length < 2) continue;
      const hw = st.kind === 'road' ? Math.max(st.hw || 3.2, 3.2) : st.kind === 'quay' ? Math.max(st.hw || 3.4, 3.4) : (st.hw || 2.2);
      for (let k = 1; k < pts.length; k++) {
        carveTaperedCapsule(pts[k - 1][0], pts[k - 1][1], hw, pts[k][0], pts[k][1], hw, 0.6, 2.4, 0);
      }
    }
    for (const sq of activeBoard.squares ?? []) {
      carveTaperedCapsule(sq.x - 0.5, sq.z, sq.mean || 6, sq.x + 0.5, sq.z, sq.mean || 6, 1.0, 3.0, 0);
    }
    for (const lot of activeBoard.lots ?? []) {
      carveOBB(lot.x, lot.z, lot.c ?? 1, lot.s ?? 0, (lot.w || 6) * 0.5 + 1.3, (lot.d || 6) * 0.5 + 1.3, 3.4);
    }
  }
  if (port?.streets) {
    const stObj = port.streets;
    for (const way of stObj.ways ?? []) {
      const pts = way?.points;
      if (!pts || pts.length < 2) continue;
      const hw = Math.max(1.4, (way.halfWidth ?? way.width * 0.5) || 2.0);
      for (let k = 1; k < pts.length; k++) {
        carveTaperedCapsule(pts[k - 1][0], pts[k - 1][1], hw, pts[k][0], pts[k][1], hw, 0.9, 2.5, 0);
      }
    }
    for (const way of stObj.cityWays ?? []) {
      const pts = way?.points;
      if (!pts || pts.length < 2) continue;
      const hw = Math.max(1.4, (way.halfWidth ?? way.width * 0.5) || 2.0);
      for (let k = 1; k < pts.length; k++) {
        carveTaperedCapsule(pts[k - 1][0], pts[k - 1][1], hw, pts[k][0], pts[k][1], hw, 0.9, 2.5, 0);
      }
    }
    if (stObj.samples?.length >= 4) {
      const s = stObj.samples;
      const sampleHw = (raw) => Math.min(8.0, Math.max(1.8, unpackRouteHalfWidthSlope(raw)[0] || 2.2));
      for (let k = 0; k + 3 < s.length; k += 4) {
        const sx = s[k], sz = s[k + 2], hw = sampleHw(s[k + 3]);
        if (k + 7 < s.length && Math.hypot(s[k + 4] - sx, s[k + 6] - sz) < 18) {
          carveTaperedCapsule(sx, sz, hw, s[k + 4], s[k + 6], sampleHw(s[k + 7]), 0.95, 2.5, 0);
        } else {
          carveTaperedCapsule(sx, sz, hw, sx, sz, hw, 0.95, 2.5, 0);
        }
      }
    }
    if (stObj.window?.span > 0) {
      const wHalf = stObj.window.span * 0.5 + 4;
      const i0 = Math.max(0, Math.floor((stObj.window.x - wHalf - x0) * invStep));
      const i1 = Math.min(size - 1, Math.ceil((stObj.window.x + wHalf - x0) * invStep));
      const j0 = Math.max(0, Math.floor((stObj.window.z - wHalf - z0) * invStep));
      const j1 = Math.min(size - 1, Math.ceil((stObj.window.z + wHalf - z0) * invStep));
      for (let j = j0; j <= j1; j++) {
        const wz = z0 + (j + 0.5) * step;
        const row = j * size;
        for (let i = i0; i <= i1; i++) {
          const p4 = (row + i) * 4;
          const cur = cover[p4];
          if (cur === 0) continue;
          const edge = streetEdgeAt(stObj, x0 + (i + 0.5) * step, wz);
          if (edge <= 0.45) {
            cover[p4] = 0;
          } else if (edge < 2.95) {
            const next = Math.round(cur * smooth01(0.45, 2.95, edge));
            if (next < cur) cover[p4] = next;
          }
        }
      }
    }
  }

  const bridges = activeBoard?.bridges ?? port?.country?.bridges ?? [];
  for (const br of bridges) {
    const hl = Math.max(4, (br.length || 10) * 0.5 + 2.0);
    const hw = Math.max(br.halfWidth || 2.8, 2.8);
    carveTaperedCapsule(br.x - br.ux * hl, br.z - br.uz * hl, hw, br.x + br.ux * hl, br.z + br.uz * hl, hw, 1.2, 2.8, 0);
  }

  // 6. Carve ALL urban, village & frontier cottage OBBs (city.blocks & port.instances)
  const blocks = city?.blocks;
  if (blocks?.length >= CITY_BLOCK_FLOATS) {
    for (let o = 0; o + CITY_BLOCK_FLOATS <= blocks.length; o += CITY_BLOCK_FLOATS) {
      const bx = blocks[o], bz = blocks[o + 2], yaw = blocks[o + 3], w = blocks[o + 4], d = blocks[o + 5];
      if (!(w > 0 && d > 0)) continue;
      carveOBB(bx, bz, Math.cos(yaw), Math.sin(yaw), w * 0.5 + 1.3, d * 0.5 + 1.3, 3.4);
    }
  }
  for (const inst of port?.instances ?? []) {
    if (!Number.isFinite(inst?.x) || !Number.isFinite(inst?.z)) continue;
    const yaw = inst.yaw || 0;
    const w = inst.width || 8, d = inst.length || 8;
    carveOBB(inst.x, inst.z, Math.cos(yaw), Math.sin(yaw), w * 0.5 + 1.4, d * 0.5 + 1.4, 3.4);
  }

  return cover;
}


// The blocks of `region` on the world's grid of blocks, and for each the most grass the cover map grows on or beside
// it and the lowest and highest ground under that grass: what the stand pass's first pass reads.
export function meadowBlocksOf({ cover, size, region, heights }) {
  const side = MEADOW_PATCH_METRES * MEADOW_BLOCK_PATCHES, span = region.span;
  const x0 = region.x - span * 0.5, z0 = region.z - span * 0.5, step = span / size;
  const first = [Math.floor(x0 / side), Math.floor(z0 / side)];
  const across = [Math.ceil((x0 + span) / side) - first[0], Math.ceil((z0 + span) / side) - first[1]];
  const data = new Float32Array(across[0] * across[1] * 4);
  for (let b = 0; b < across[0] * across[1]; b++) data.set([0, Infinity, -Infinity, 0], b * 4);
  const n = region.size || Math.round(Math.sqrt(heights?.length || 0));
  const hasHeights = n >= 2 && heights?.length >= n * n;
  // A patch reads the cover map bilinearly at its middle and its corners: a texel touches the blocks within a texel
  // and half a patch of it.
  const reach = step + MEADOW_PATCH_METRES * 0.5;
  // Which patches could stand at all: those with a point the stand pass reads (a patch's middle and corners, or a
  // coarse patch's lattice, all on its patches' edges) within a texel of grass.
  const P = MEADOW_PATCH_METRES, cellsX = across[0] * MEADOW_BLOCK_PATCHES, cellsZ = across[1] * MEADOW_BLOCK_PATCHES;
  const cellX0 = first[0] * MEADOW_BLOCK_PATCHES, cellZ0 = first[1] * MEADOW_BLOCK_PATCHES, cells = new Uint8Array(cellsX * cellsZ);
  let texels = 0;
  for (let j = 0; j < size; j++) {
    const wz = z0 + (j + 0.5) * step, v = (j + 0.5) / size;
    for (let i = 0; i < size; i++) {
      const r = cover[(j * size + i) * 4];
      if (r >= 32) texels++;
      if (r < 5) continue;
      const wx = x0 + (i + 0.5) * step, u = (i + 0.5) / size;
      const y = hasHeights ? sampleGridBilinear(heights, n, u, v) : 0;
      const bi0 = Math.max(0, Math.floor((wx - reach) / side) - first[0]), bi1 = Math.min(across[0] - 1, Math.floor((wx + reach) / side) - first[0]);
      const bj0 = Math.max(0, Math.floor((wz - reach) / side) - first[1]), bj1 = Math.min(across[1] - 1, Math.floor((wz + reach) / side) - first[1]);
      for (let bj = bj0; bj <= bj1; bj++) for (let bi = bi0; bi <= bi1; bi++) {
        const at = (bj * across[0] + bi) * 4;
        data[at] = Math.max(data[at], r / 255);
        data[at + 1] = Math.min(data[at + 1], y);
        data[at + 2] = Math.max(data[at + 2], y);
      }
      const ci0 = Math.max(0, Math.ceil((wx - step) / P) - 1 - cellX0), ci1 = Math.min(cellsX - 1, Math.floor((wx + step) / P) - cellX0);
      const cj0 = Math.max(0, Math.ceil((wz - step) / P) - 1 - cellZ0), cj1 = Math.min(cellsZ - 1, Math.floor((wz + step) / P) - cellZ0);
      for (let cj = cj0; cj <= cj1; cj++) if (ci0 <= ci1) cells.fill(1, cj * cellsX + ci0, cj * cellsX + ci1 + 1);
    }
  }
  for (let b = 0; b < across[0] * across[1]; b++) if (!(data[b * 4] > 0)) data.set([0, 0, 0, 0], b * 4);
  // Each block's most records at each grain (js/wgsl/meadow-continuum.js meadowStandBudget): its patches that could
  // stand, and its squares of 2, 4, 8 and 16 patches holding any.
  const grains = new Uint32Array(data.buffer, data.byteOffset, data.length), B = MEADOW_BLOCK_PATCHES;
  for (let bj = 0; bj < across[1]; bj++) for (let bi = 0; bi < across[0]; bi++) {
    const at = (bj * across[0] + bi) * 4;
    if (!(data[at] > 0)) continue;
    let word = 0;
    MEADOW_GRAIN_BITS.forEach(([shift], level) => {
      const g = 1 << level, side = B >> level;
      let n = 0;
      for (let gz = 0; gz < side; gz++) for (let gx = 0; gx < side; gx++) {
        let any = false;
        for (let z = 0; z < g && !any; z++) {
          const row = (bj * B + gz * g + z) * cellsX + bi * B + gx * g;
          for (let x = 0; x < g; x++) if (cells[row + x]) { any = true; break; }
        }
        if (any) n++;
      }
      word |= n << shift;
    });
    grains[at + 3] = word >>> 0;
  }
  return { first, across, count: across[0] * across[1], data, texels };
}

// The stand pass's five programs, each with its own bind group layout, so the blocks-in-view list is written by one
// pass and read, and dispatched from, by the next. One set a device, compiled one after another (D3D12 runs out of
// pipeline state memory compiling them at once).
export function requestMeadowStand(device, shader) {
  return requestOnce(device, 'meadow continuum stand', async () => {
    const C = GPUShaderStage.COMPUTE;
    const buffer = (binding, type) => ({ binding, visibility: C, buffer: { type } });
    const texture = (binding, sampleType, viewDimension = '2d') => ({ binding, visibility: C, texture: { sampleType, viewDimension } });
    const uniforms = [buffer(0, 'uniform'), buffer(1, 'uniform'), buffer(2, 'uniform')];
    const entries = {
      reset: [buffer(9, 'storage'), buffer(10, 'storage')],
      blocks: [...uniforms, buffer(6, 'read-only-storage'), buffer(10, 'storage'), buffer(12, 'uniform')],
      budget: [buffer(0, 'uniform'), buffer(1, 'uniform'), buffer(10, 'storage')],
      patches: [...uniforms, texture(3, 'unfilterable-float'), texture(4, 'float'), buffer(5, 'read-only-storage'), buffer(7, 'storage'), buffer(8, 'storage'), buffer(9, 'storage'),
        buffer(11, 'read-only-storage'), buffer(12, 'uniform'), buffer(13, 'uniform'), texture(14, 'sint'), texture(15, 'float', '2d-array'),
        { binding: 16, visibility: C, sampler: { type: 'filtering' } }, texture(17, 'unfilterable-float', '2d-array')],
      finish: [buffer(1, 'uniform'), buffer(7, 'storage'), buffer(9, 'storage')],
    };
    const points = { reset: 'meadowStandReset', blocks: 'meadowBlocksInView', budget: 'meadowStandBudget', patches: 'meadowStandPatches', finish: 'meadowStandFinish' };
    const module = await shader(meadowContinuumStandWGSL(), 'meadow stand');
    const layouts = {}, pipelines = {};
    const names = Object.keys(entries);
    for (const name of names) {
      layouts[name] = device.createBindGroupLayout({ label: `meadow stand ${name}`, entries: entries[name] });
    }
    const built = await Promise.all(names.map((name) => device.createComputePipelineAsync({
      label: `meadow stand ${name}`, layout: device.createPipelineLayout({ label: `meadow stand ${name}`, bindGroupLayouts: [layouts[name]] }),
      compute: { module, entryPoint: points[name] },
    })));
    names.forEach((name, i) => { pipelines[name] = built[i]; });
    return { layouts, pipelines };
  });
}
// What each stand pass binds.
const MEADOW_STAND_BINDINGS = Object.freeze({ reset: [9, 10], blocks: [0, 1, 2, 6, 10, 12], budget: [0, 1, 10], patches: [0, 1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17], finish: [1, 7, 9] });
// What the material's view, and its capture under water, bind in group 0.
const MEADOW_VIEW_BINDINGS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24]);

export async function createMeadowGrass({
  device,
  shader,
  pack,
  region,
  heights,
  biome,
  beaches = null,
  port = null,
  city = null,
  board = null,
  inlandWater = null,
  craters = null,
  elevation = null,
  nearDomain,
  resources,
  clouds,
  format = 'rgba16float',
  samples = 4,
  shadowFormat = LAND_SHADOW_FORMAT,
  waterOptics = null,
  isMobile = false,
  isSecondary = false,
  coverSize = (isMobile || isSecondary) ? MEADOW_COVER_MOBILE : MEADOW_COVER_DESKTOP,
  capacityLimit = null,
  worldOffset = null,
}) {
  if (!(pack?.words?.length > 0) || !pack.manifest) return null;
  const B = GPUBufferUsage;
  const land0 = new Map(resources);
  const frame = land0.get(0)?.buffer, shadowUniform = land0.get(19)?.buffer;
  if (!frame || !shadowUniform) throw Error('The meadow is cut and lit by the land\'s frame and shadow map, and there are none');
  // The atlas, the one cut's programs, the meadow's view and its stand pass, asked for at once, the programs binding as
  // many pages as the atlas takes. Meadow grass only grows above MEADOW_WATERLINE (0.75 m), so it never draws into the
  // underwater submerged-geometry capture pass.
  const pages = continuumAtlasPages(device, pack.words.length);
  const [atlas, programs, view, stand] = await Promise.all([
    requestContinuumAtlas(device, `meadow ${pack.manifest.pack}`, async () => pack),
    requestContinuumPrograms({ device, shader, shadowFormat, pages }),
    requestContinuumView({ device, shader, material: MEADOW_CONTINUUM_SPEC, format, samples, pages }),
    requestMeadowStand(device, shader),
  ]);
  if (atlas.types.length !== pack.manifest.types.length) throw Error(`The meadow continuum atlas holds ${atlas.types.length} types, its manifest ${pack.manifest.types.length}: rebake it`);
  // The pack's mixes in their roles: a strand for a margin sows it behind the beaches.
  const coast = (pack.manifest.mixes ?? [])[MEADOW_MIX_ROLES.indexOf('margin')] === 'strand';
  const mkBuf = (label, size, usage, data = null) => {
    const buf = device.createBuffer({ label, size: Math.max(16, size), usage });
    if (data?.byteLength) device.queue.writeBuffer(buf, 0, data);
    return buf;
  };

  // One scene of every patch the stand pass may write a frame, as many as the device binds in one buffer (a patch's
  // pose data is its largest share), its room split evenly over the variants. Secondary coastal sections share the
  // exact same GPU atlas & compiled pipelines with compact cover/capacity so neighbor tiles add minimal VRAM.
  const defaultCapacity = isSecondary
    ? (isMobile ? (1 << 16) : MEADOW_CONTINUUM_SECONDARY_CAPACITY)
    : (isMobile ? MEADOW_CONTINUUM_MOBILE_CAPACITY : MEADOW_CONTINUUM_CAPACITY);
  const wanted = Number.isFinite(capacityLimit) && capacityLimit > 0 ? Math.floor(capacityLimit) : defaultCapacity;
  const most = Math.floor(Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) / (MEADOW_CONTINUUM_POSE * 16));
  const perType = Math.floor(Math.min(wanted, most) / atlas.types.length);
  const { capacity, room } = continuumRoom(atlas.types, atlas.types.map(() => perType));
  const meadowProfile = isMobile ? { ...continuumProfile('meadow'), errorScale: 3.10, taperMetres: 0, taperPower: 1.0, shadowMaxDistance: 20 } : 'meadow';
  const scene = createContinuumScene({ device, atlas, programs, capacity, room, view, poseRoom: capacity * MEADOW_CONTINUUM_POSE, frame, shadowUniform, samples, label: isSecondary ? 'meadow secondary' : 'meadow', written: true, profile: meadowProfile });
  scene.setCount(capacity);
  scene.setWorldOffset(worldOffset?.x ?? 0, worldOffset?.z ?? 0);
  const stood = mkBuf('meadow stood', MEADOW_CONTINUUM_STOOD_BYTES, B.STORAGE | B.INDIRECT);
  let blockWork = null, blocksBuf = null, blockCount = 0;

  // The uniform the stand pass and the material read: MeadowCfg.
  const cfgData = new ArrayBuffer(MEADOW_CONTINUUM_CFG_BYTES);
  const cfgF = new Float32Array(cfgData), cfgU = new Uint32Array(cfgData), cfgI = new Int32Array(cfgData);
  const cfgBuf = mkBuf('meadow continuum cfg', MEADOW_CONTINUUM_CFG_BYTES, B.UNIFORM | B.COPY_DST);
  cfgU.set([samples, coverSize, capacity, 1], 4);
  cfgF.set([continuumPixelError(), MEADOW_GUST_WAVE, 0, 0], 16);
  cfgU[22] = isSecondary ? 0 : 1; // cfg.more.z: 1 when primary section (landLight valid), 0 for secondary sections
  // Each mix's colour and cover from above, the mean of its variants (meadowMixMean): a colour word holds three
  // square roots of a linear colour.
  const words = pack.words, floats = new Float32Array(words.buffer, words.byteOffset, words.length), M = MEADOW_CONTINUUM_MATERIAL;
  const mixCounts = [0, 0, 0];
  for (let t = 0; t < atlas.types.length; t++) {
    const at = words[CONTINUUM_HEADER.typesAt] + t * CONTINUUM_TYPE_WORDS, mix = words[at + M.mix], top = words[at + M.top];
    if (!(mix < 3)) continue;
    for (let k = 0; k < 3; k++) cfgF[24 + mix * 4 + k] += ((top >>> (8 * k)) & 255) ** 2 / 65025;
    cfgF[24 + mix * 4 + 3] += floats[at + M.coverage];
    mixCounts[mix]++;
  }
  for (let mix = 0; mix < 3; mix++) for (let k = 0; k < 4; k++) cfgF[24 + mix * 4 + k] /= Math.max(1, mixCounts[mix]);
  let cfgDirty = true;

  let boundCraters = null;
  let unsubscribeCraters = null;
  const syncCraterCfg = (reg) => {
    const orig = boundCraters?.regionOrigin;
    cfgF[8] = orig ? orig[0] : (reg.x - reg.span * 0.5);
    cfgF[9] = orig ? orig[1] : (reg.z - reg.span * 0.5);
    cfgF[10] = LAND_CRATER_TILE_M;
    cfgF[11] = boundCraters?.fieldTexture && boundCraters?.lookupTexture ? 1.0 : 0.0;
    cfgDirty = true;
  };

  // 1040-byte MeadowWakeFrame uniform buffer + zero-alloc CPU packing views
  const wakeData = new ArrayBuffer(MEADOW_WAKE_BUFFER_BYTES);
  const wakeU32 = new Uint32Array(wakeData);
  const wakeF32 = new Float32Array(wakeData);
  const wakeBuf = mkBuf('meadow ballistic wakes', MEADOW_WAKE_BUFFER_BYTES, B.UNIFORM | B.COPY_DST, new Uint8Array(wakeData));
  let wakesWereEmpty = true;

  // 1x1 crater textures while no craters are bound, or before the first impact allocates the field
  const fallbackCraterLookup = device.createTexture({
    label: 'meadow crater lookup fallback',
    size: [1, 1],
    format: 'r16sint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: fallbackCraterLookup }, new Int16Array([-1]), { offset: 0 }, [1, 1]);
  const fallbackCraterField = device.createTexture({
    label: 'meadow crater field fallback',
    size: [1, 1, 1],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: fallbackCraterField }, new Uint16Array(4), { offset: 0 }, [1, 1, 1]);

  const coverTexture = device.createTexture({
    label: isSecondary ? 'meadow secondary cover' : 'meadow cover',
    size: [coverSize, coverSize],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  let ownedElevation = null;
  let ownedElevSize = 0;
  let elevationView = elevation ? elevation.createView() : null;
  const coverView = coverTexture.createView();
  const syncOwnedElevation = (reg, hArr) => {
    if (elevation || !hArr?.length) return false;
    const nextSize = reg?.size || Math.round(Math.sqrt(hArr.length));
    if (!(nextSize >= 2) || hArr.length < nextSize * nextSize) return false;
    let resized = false;
    if (!ownedElevation || ownedElevSize !== nextSize) {
      ownedElevation?.destroy();
      ownedElevSize = nextSize;
      ownedElevation = device.createTexture({
        label: isSecondary ? 'meadow secondary elevation' : 'meadow elevation',
        size: [nextSize, nextSize],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      elevationView = ownedElevation.createView();
      resized = true;
    }
    const src = hArr instanceof Float32Array ? hArr : new Float32Array(hArr);
    device.queue.writeTexture({ texture: ownedElevation }, src, { bytesPerRow: nextSize * 4 }, [nextSize, nextSize]);
    return resized;
  };

  // The stand pass's bind groups, one a pass, and the view's group: rebuilt when the region's blocks,
  // the land's resources or the craters change.
  let activeResources = resources;
  let standGroups = null, viewGroup = null;
  const cloudGroup = clouds.bindVolume(view.pipeline, 'shadow');
  function buildGroups() {
    if (!elevationView) return;
    const land = new Map(activeResources);
    const craterLookupView = (boundCraters?.lookupTexture ?? fallbackCraterLookup).createView();
    const craterFieldView = (boundCraters?.fieldTexture ?? fallbackCraterField).createView({ dimension: '2d-array' });
    if (blocksBuf) {
      const resource = {
        0: land.get(0), 1: { buffer: cfgBuf }, 2: { buffer: nearDomain }, 3: elevationView, 4: coverView, 5: { buffer: atlas.buffer },
        6: { buffer: blocksBuf }, 7: { buffer: scene.records }, 8: { buffer: scene.poses }, 9: { buffer: stood }, 10: { buffer: blockWork }, 11: { buffer: blockWork },
        12: land.get(19), 13: { buffer: wakeBuf }, 14: craterLookupView, 15: craterFieldView, 16: land.get(8), 17: continuumGroundView(device),
      };
      standGroups = Object.fromEntries(Object.entries(MEADOW_STAND_BINDINGS).map(([name, ids]) => [name, device.createBindGroup({
        label: `meadow stand ${name}`, layout: stand.layouts[name], entries: ids.map((binding) => ({ binding, resource: resource[binding] })),
      })]));
    }
    const own = new Map([
      [5, { buffer: cfgBuf }], [6, elevationView], [13, { buffer: wakeBuf }], [14, craterLookupView], [15, land.get(5)], [16, coverView],
      [17, land.get(7)], [18, land.get(8)], [22, craterFieldView],
    ]);
    const entries = MEADOW_VIEW_BINDINGS.map((binding) => ({ binding, resource: own.get(binding) ?? land.get(binding) }));
    viewGroup = device.createBindGroup({ label: 'meadow view', layout: view.pipeline.getBindGroupLayout(0), entries });
  }

  let curRegion = region;
  let curHeights = heights;
  let curBiome = biome;
  let curBeaches = beaches;
  let curPort = port;
  let curCity = city;
  let curBoard = board;
  let curInlandWater = inlandWater;
  let coverTexels = 0;
  let active = false;
  let destroyed = false;

  function sync(next = {}) {
    if (next.region !== undefined) curRegion = next.region;
    if (next.heights !== undefined) curHeights = next.heights;
    if (next.biome !== undefined) curBiome = next.biome;
    if (next.beaches !== undefined) curBeaches = next.beaches;
    if (next.port !== undefined) curPort = next.port;
    if (next.city !== undefined) curCity = next.city;
    if (next.board !== undefined) curBoard = next.board;
    if (next.inlandWater !== undefined) curInlandWater = next.inlandWater;
    const elevResized = syncOwnedElevation(curRegion, curHeights);
    const map = buildMeadowCoverMap({
      region: curRegion,
      heights: curHeights,
      biome: curBiome,
      beaches: curBeaches,
      port: curPort,
      city: curCity,
      board: curBoard,
      inlandWater: curInlandWater,
      size: coverSize,
      coast,
    });
    device.queue.writeTexture({ texture: coverTexture }, map, { bytesPerRow: coverSize * 4 }, [coverSize, coverSize]);
    const blocks = meadowBlocksOf({ cover: map, size: coverSize, region: curRegion, heights: curHeights });
    coverTexels = blocks.texels;
    const grown = blocks.count !== blockCount;
    if (grown) {
      blocksBuf?.destroy(); blockWork?.destroy();
      blockCount = blocks.count;
      blocksBuf = mkBuf('meadow continuum blocks', blockCount * 16, B.STORAGE | B.COPY_DST | B.COPY_SRC);
      blockWork = mkBuf('meadow continuum blocks in view', (MEADOW_WORK_HEADER + blockCount) * 4, B.STORAGE | B.INDIRECT | B.COPY_SRC);
    }
    device.queue.writeBuffer(blocksBuf, 0, blocks.data);
    cfgF.set([curRegion.x, curRegion.z, curRegion.span, MEADOW_WATERLINE], 0);
    cfgI.set([blocks.first[0], blocks.first[1], blocks.across[0], blocks.across[1]], 12);
    cfgU[21] = blockCount;
    syncCraterCfg(curRegion);
    if (grown || elevResized) buildGroups();
  }

  function bindCraters(nextCraters = null) {
    unsubscribeCraters?.();
    unsubscribeCraters = null;
    boundCraters = nextCraters || null;
    const applyCraterBinding = () => {
      syncCraterCfg(curRegion);
      buildGroups();
    };
    if (typeof boundCraters?.onReallocate === 'function') {
      unsubscribeCraters = boundCraters.onReallocate(applyCraterBinding);
    }
    applyCraterBinding();
  }

  function setBallisticWakes(shots = null, rings = null) {
    let shotCount = 0;
    const shotBase = 4; // float offset after counts: vec4u (16 bytes)
    if (shots instanceof Float32Array) {
      shotCount = Math.min(MEADOW_MAX_SHOT_WAKES, Math.floor(shots.length / 8));
      if (shotCount > 0) wakeF32.set(shots.subarray(0, shotCount * 8), shotBase);
    } else if (Array.isArray(shots)) {
      for (let i = 0; i < shots.length && shotCount < MEADOW_MAX_SHOT_WAKES; i++) {
        const s = shots[i];
        if (!s || s.active === false || s.dead === true) continue;
        const x = s.x ?? s.pos?.[0] ?? s.position?.[0];
        const y = s.y ?? s.pos?.[1] ?? s.position?.[1];
        const z = s.z ?? s.pos?.[2] ?? s.position?.[2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        const vx = s.vx ?? s.vel?.[0] ?? s.velocity?.[0] ?? 0;
        const vy = s.vy ?? s.vel?.[1] ?? s.velocity?.[1] ?? 0;
        const vz = s.vz ?? s.vel?.[2] ?? s.velocity?.[2] ?? 0;
        const speed = Math.hypot(vx, vy, vz);
        const absR = Math.max(0.04, Math.abs(s.signedRadius ?? s.radius ?? 0.08));
        const isHot = (s.signedRadius !== undefined && s.signedRadius < 0) || Boolean(s.hot || s.heated || s.heatedShot);
        const signedRadius = isHot ? -absR : absR;
        const trailLen = s.trailLen ?? Math.max(6.0, Math.min(28.0, speed * 0.22));
        const o = shotBase + shotCount * 8;
        wakeF32[o] = x;
        wakeF32[o + 1] = y;
        wakeF32[o + 2] = z;
        wakeF32[o + 3] = signedRadius;
        wakeF32[o + 4] = vx;
        wakeF32[o + 5] = vy;
        wakeF32[o + 6] = vz;
        wakeF32[o + 7] = trailLen;
        shotCount++;
      }
    }

    let ringCount = 0;
    const ringBase = 4 + MEADOW_MAX_SHOT_WAKES * 8; // float offset 132 (byte 528)
    if (rings instanceof Float32Array) {
      ringCount = Math.min(MEADOW_MAX_BLAST_RINGS, Math.floor(rings.length / 8));
      if (ringCount > 0) wakeF32.set(rings.subarray(0, ringCount * 8), ringBase);
    } else if (Array.isArray(rings)) {
      for (let i = 0; i < rings.length && ringCount < MEADOW_MAX_BLAST_RINGS; i++) {
        const r = rings[i];
        if (!r || r.active === false) continue;
        const x = r.x ?? r.pos?.[0] ?? r.position?.[0];
        const z = r.z ?? r.pos?.[2] ?? r.position?.[2];
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const y = r.y ?? r.pos?.[1] ?? r.position?.[1] ?? 0;
        const maxAge = r.maxAge ?? r.duration ?? 2.2;
        const age = r.age ?? r.ageSec ?? r.t ?? 0;
        if (!(age >= 0 && age <= maxAge)) continue;
        const strength = r.strength ?? (r.energyJ ? Math.min(2.0, Math.max(0.35, Math.cbrt(r.energyJ / 1.1e6))) : 1.0);
        const speed = r.speed ?? 26.0;
        const hot = r.hot || r.heated ? 1.0 : 0.0;
        const o = ringBase + ringCount * 8;
        wakeF32[o] = x;
        wakeF32[o + 1] = y;
        wakeF32[o + 2] = z;
        wakeF32[o + 3] = age;
        wakeF32[o + 4] = strength;
        wakeF32[o + 5] = speed;
        wakeF32[o + 6] = maxAge;
        wakeF32[o + 7] = hot;
        ringCount++;
      }
    }

    if (shotCount === 0 && ringCount === 0) {
      if (wakesWereEmpty) return;
      wakeU32[0] = 0;
      wakeU32[1] = 0;
      wakeU32[2] = 0;
      wakeU32[3] = 0;
      device.queue.writeBuffer(wakeBuf, 0, wakeData, 0, 16);
      wakesWereEmpty = true;
      return;
    }

    wakeU32[0] = shotCount;
    wakeU32[1] = ringCount;
    wakeU32[2] = 0;
    wakeU32[3] = 0;
    device.queue.writeBuffer(wakeBuf, 0, wakeData, 0, MEADOW_WAKE_BUFFER_BYTES);
    wakesWereEmpty = false;
  }

  sync({ region, heights, biome, beaches, port, city, board, inlandWater });
  if (craters) bindCraters(craters);
  else buildGroups();

  const manifestTypes = pack.manifest.types ?? [];
  return {
    stats: {
      loaded: true,
      backend: 'continuum',
      style: pack.manifest.format,
      pack: pack.manifest.pack,
      mixes: pack.manifest.mixes,
      variants: manifestTypes.length,
      clusters: manifestTypes.reduce((n, v) => n + v.clusters, 0),
      sourceTriangles: manifestTypes.reduce((n, v) => n + v.sourceTriangles, 0),
      farError: pack.manifest.farError,
      atlasBytes: words.byteLength,
      patchMetres: MEADOW_PATCH_METRES,
      coverSize,
      coast,
      isSecondary: Boolean(isSecondary),
      submerged: false,
      capacity,
      room,
      get coveredTexels() { return coverTexels; },
      get blocks() { return blockCount; },
    },
    scene,
    sync,
    bindCraters,
    setBallisticWakes,
    rebind(nextResources) {
      activeResources = nextResources;
      buildGroups();
    },
    // Where the scene's frame lies in the world's (js/terrain.js setWorldOffset); the stand pass reads it from the
    // land's near domain.
    setWorldOffset(x = 0, z = 0) {
      if (!destroyed) scene.setWorldOffset(x, z);
    },
    // In the frame's compute pass: every patch of grass in view or in the sun's box stood, the far ones coarser if the
    // view asks more than the scene holds, then the one cut over them.
    encode(pass) {
      active = !destroyed && coverTexels > 0 && standGroups !== null;
      if (!active) return;
      const pixels = continuumPixelError(), mp = continuumProfile('meadow');
      if (cfgF[16] !== Math.fround(pixels) || cfgF[18] !== Math.fround(mp.maxDistance) || cfgF[19] !== Math.fround(mp.shadowMaxDistance)) {
        cfgF[16] = pixels; cfgF[18] = mp.maxDistance; cfgF[19] = mp.shadowMaxDistance; cfgDirty = true;
      }
      if (cfgDirty) { device.queue.writeBuffer(cfgBuf, 0, cfgData); cfgDirty = false; }
      const P = stand.pipelines;
      pass.setPipeline(P.reset);
      pass.setBindGroup(0, standGroups.reset);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(P.blocks);
      pass.setBindGroup(0, standGroups.blocks);
      pass.dispatchWorkgroups(Math.ceil(blockCount / 64));
      pass.setPipeline(P.budget);
      pass.setBindGroup(0, standGroups.budget);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(P.patches);
      pass.setBindGroup(0, standGroups.patches);
      pass.dispatchWorkgroupsIndirect(blockWork, 0);
      pass.setPipeline(P.finish);
      pass.setBindGroup(0, standGroups.finish);
      pass.dispatchWorkgroups(CONTINUUM_ROW / 64);
      scene.encode(pass, { buffer: stood });
    },
    draw(pass) {
      if (active && !destroyed) scene.draw(pass, viewGroup, cloudGroup);
    },
    // The one cut's shadow of the patches, cast into the land's shadow map.
    drawShadow(pass) {
      if (active && !destroyed) scene.drawShadow(pass);
    },
    // Meadow grass only grows above MEADOW_WATERLINE (0.75 m); no-op so submerged capture never redraws dry-land grass.
    drawSubmerged(_pass, _above = false) {},
    // The indirect draws the view submits, for the continuum census (js/continuum-census.js).
    continuumDraws() {
      return active && !destroyed ? scene.continuumDraws() : [];
    },
    destroy() {
      destroyed = true;
      active = false;
      unsubscribeCraters?.();
      unsubscribeCraters = null;
      boundCraters = null;
      scene.destroy();
      for (const buf of [stood, blockWork, blocksBuf, cfgBuf, wakeBuf]) buf?.destroy();
      fallbackCraterLookup.destroy();
      fallbackCraterField.destroy();
      coverTexture.destroy();
      ownedElevation?.destroy();
      ownedElevation = null;
    },
  };
}

// Lightweight helper for attaching real procedural meadow grass to a loaded neighbor coastal section.
// Shares the already-uploaded GPU meadow atlas and compiled pipelines via requestContinuumAtlas,
// using compact 1024 cover & 1<<17 capacity and returning null immediately for pure-ocean tiles.
export async function createSectionMeadowGrass(section, ctx) {
  if (!section?.region || !section?.heights?.length || !section?.resources || !ctx?.pack) return null;
  const h = section.heights;
  let hasLand = false;
  for (let i = 0; i < h.length; i++) {
    if (h[i] >= MEADOW_WATERLINE) { hasLand = true; break; }
  }
  if (!hasLand) return null;
  return createMeadowGrass({
    ...ctx,
    region: section.region,
    heights: section.heights,
    biome: section.biome ?? null,
    beaches: section.beaches ?? null,
    port: section.port ?? null,
    city: section.city ?? null,
    board: section.board ?? null,
    inlandWater: section.inlandWater ?? null,
    elevation: section.elevation ?? null,
    resources: section.resources,
    isSecondary: true,
  });
}
