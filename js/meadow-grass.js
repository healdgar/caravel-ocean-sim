// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Meadow grass, cut and drawn through the one continuum (AGENTS.md rule 3; js/meadow-continuum.js for the atlas,
// scripts/prepare-meadow-grass.mjs for its bake). A meadow is 4 m patches of the groves' full-resolution sward laid
// edge to edge on a world grid wherever the cover map (below) says grass grows. Every frame the GPU, on the shared
// core (js/continuum-core.js) and the scene's one pixel error:
//   - lists the blocks of 16 x 16 patches in view that hold any grass;
//   - decides each of their patches: near, its clusters, cut by projected error; across the core's handoff band, its
//     closed canopy body takes each pixel's samples from them (@builtin(sample_mask), never a blend); farther, that
//     body morphs down its half-edge collapses to a core of six triangles; at a few pixels its single splat takes the
//     samples; under a pixel the splat is thinned by a hash and the survivors grown to keep the meadow's covered area;
//   - enters each drawn piece in one of three lists, each drawn with one indirect call.
// A distant meadow is therefore its patches' own far end: canopy cores, then splats carrying the sward's mean colour
// seen from above and from the side, thinned and grown below a pixel. Nothing else draws grass.
// Grass is never a target: shot passes through it. Craters bury it, and passing shot and blast rings part it, in the
// vertex stage, from the land's own crater field and the frame's ballistic wakes.
import { requestOnce } from './gpu-program-cache.js';
import { CONTINUUM_CORE_WGSL, continuumClusterPrefixWGSL, continuumMorphStepWGSL, continuumPixelError } from './continuum-core.js';
import { FRAME_WGSL, ATMO_CORE_WGSL } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { CLOUD_SAMPLE } from './wgsl/clouds.js';
import { SHADOW_FRAME } from './wgsl/shadows.js';
import { terrainSurfaceSample } from './terrain-model.js';
import { CITY_BLOCK_FLOATS, CITY_GROUND } from './old-world-city.js';
import { INLAND_WATER_FLOATS } from './wgsl/inland-water.js';
import { LAND_CRATER_SAMPLE_WGSL, LAND_CRATER_TEXELS, LAND_CRATER_CELL_M, LAND_CRATER_TILE_M } from './wgsl/land-craters.js';
import { streetEdgeAt } from './town-streets.js';
import {
  MEADOW_PATCH_METRES, MEADOW_CONTINUUM_HEADER, MEADOW_CONTINUUM_VARIANT, MEADOW_CONTINUUM_VARIANT_WORDS, MEADOW_CONTINUUM_CLUSTER_WORDS,
  MEADOW_CONTINUUM_CLUSTER_TRIANGLES, MEADOW_CONTINUUM_VERTEX_WORDS, MEADOW_CONTINUUM_STEP_WORDS, MEADOW_CONTINUUM_TRIANGLE_WORDS,
  MEADOW_CONTINUUM_NEVER, MEADOW_CONTINUUM_HOPS, MEADOW_CONTINUUM_CHUNK_TRIANGLES, MEADOW_CONTINUUM_OFFSET_UNIT, MEADOW_CONTINUUM_STIFFNESS_UNIT,
} from './meadow-continuum.js';

export const MEADOW_MAX_SHOT_WAKES = 16;
export const MEADOW_MAX_BLAST_RINGS = 16;
export const MEADOW_WAKE_BUFFER_BYTES = 1040; // 16B counts + 16 * 32B ShotWake + 16 * 32B BlastRing = 1040B
const MEADOW_COVER_DESKTOP = 2048; // 4.0 m/texel across 8192 m region with bilinear SDF filtering
const MEADOW_COVER_MOBILE = 1024;

// The lists a patch's pieces are entered in, each drawn with one indirect call, and the vertices of one entry: a
// cluster, 32 canopy-body triangles, or a splat. The unused vertices are degenerate.
export const MEADOW_CONTINUUM_LISTS = Object.freeze(['clusters', 'far body', 'splat']);
export const MEADOW_CONTINUUM_LIST_VERTICES = Object.freeze([3 * MEADOW_CONTINUUM_CLUSTER_TRIANGLES, 3 * MEADOW_CONTINUUM_CHUNK_TRIANGLES, 3]);
// Patches to a block's side: the cut lists the blocks in view, then decides their patches.
export const MEADOW_BLOCK_PATCHES = 16;
// Room in each list; for the patches drawn, and for those whose clusters are cut. A patch past the room is dropped
// and counted (MEADOW_COUNTER.lost).
export const MEADOW_CONTINUUM_ROOM = Object.freeze({ clusters: 65536, far: 262144, splat: 393216, states: 524288, near: 8192 });
const MEADOW_CONTINUUM_MOBILE_ROOM = Object.freeze({ clusters: 32768, far: 131072, splat: 196608, states: 262144, near: 4096 });
// What an entry is, in the top four bits of its second word.
export const MEADOW_CLUSTER_ENTRY = 1, MEADOW_FAR_ENTRY = 2, MEADOW_SPLAT_ENTRY = 3;
// The counters: each list's draw (four words), then the patches drawn and those lost for room.
export const MEADOW_COUNTER_WORDS = 16;
export const MEADOW_COUNTER = Object.freeze({ states: 12, lost: 13 });
// The work lists (blocks in view, patches to cut by clusters) begin with their own indirect dispatch.
const MEADOW_WORK_HEADER = 4;
// The shared uniform: 7 vec4s.
const MEADOW_CFG_BYTES = 112;
// How each draw reads its list: the list buffer bound as an instance-rate vertex buffer at the list's first entry.
const MEADOW_ENTRY_LAYOUT = Object.freeze([Object.freeze({ arrayStride: 8, stepMode: 'instance', attributes: Object.freeze([Object.freeze({ shaderLocation: 0, offset: 0, format: 'uint32x2' })]) })]);
// How far the sward may stand from where its bounds were baked: grown by the meadow's lushness and billow, bent by
// the wind, and the land under a patch off the plane through its middle.
const MEADOW_SWAY = 0.75;
// A block's bounds: how far its sward reaches above its highest ground and its plants overhang its edge, and how far
// the GPU's ground may lie from the heights the CPU read.
const MEADOW_REACH_UP = 2.0, MEADOW_OVERHANG = 1.0, MEADOW_GROUND_SLACK = 2.0;
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
// R = cover (0..255), G = mix (0 pasture, 128 waste, 255 field-margin), B = height/lushness modulation (0..255), A = 255.
export function buildMeadowCoverMap({
  region,
  heights,
  biome,
  beaches = null,
  port = null,
  city = null,
  board = null,
  inlandWater = null,
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
        mixVal = 210;
        hScale = 186;
      } else if (slope > 0.24 || y > 185) {
        mixVal = 128;
        hScale = 148;
      } else if (marked >= 68) {
        mixVal = 255;
        hScale = 196;
      } else {
        mixVal = n2 > 0.58 ? 255 : 0;
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
      for (let k = 0; k + 3 < s.length; k += 4) {
        const sx = s[k], sz = s[k + 2], hw = Math.max(1.8, s[k + 3] || 2.2);
        if (k + 7 < s.length && Math.hypot(s[k + 4] - sx, s[k + 6] - sz) < 18) {
          carveTaperedCapsule(sx, sz, hw, s[k + 4], s[k + 6], Math.max(1.8, s[k + 7] || 2.2), 0.95, 2.5, 0);
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

const MEADOW_HASH_GROUND_WGSL = /* wgsl */ `
struct MeadowNearDomain {
  domain: vec4f,
  grid: vec4f,
};

fn meadowHash(x_in: u32) -> u32 {
  var x = x_in * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (x >> 22u) ^ x;
}

fn meadowHash2(p: vec2i) -> u32 {
  return meadowHash(bitcast<u32>(p.x) ^ meadowHash(bitcast<u32>(p.y) + 0x9e3779b9u));
}

fn meadowGroundY(p: vec2f, domain: vec4f, elevTex: texture_2d<f32>) -> f32 {
  let dim = vec2i(textureDimensions(elevTex));
  let limit = max(dim - vec2i(1), vec2i(1));
  let uv = clamp((p - domain.xy) / domain.z + 0.5, vec2f(0.0), vec2f(1.0));
  let q = uv * vec2f(limit);
  let i = min(vec2i(floor(q)), max(limit - vec2i(1), vec2i(0)));
  let f = q - vec2f(i);
  let nx = min(i + vec2i(1, 0), limit);
  let ny = min(i + vec2i(0, 1), limit);
  let nxy = min(i + vec2i(1, 1), limit);
  let a = textureLoad(elevTex, i, 0).r;
  let b = textureLoad(elevTex, nx, 0).r;
  let c = textureLoad(elevTex, ny, 0).r;
  let d = textureLoad(elevTex, nxy, 0).r;
  return select(d + (1.0 - f.x) * (c - d) + (1.0 - f.y) * (b - d), a + f.x * (b - a) + f.y * (c - a), f.x + f.y <= 1.0);
}
`;

const MEADOW_AT = MEADOW_CONTINUUM_HEADER, MEADOW_VARIANT_AT = MEADOW_CONTINUUM_VARIANT;

// What the cut and the drawing both know: the shared uniform, the atlas's layout and a patch's state.
const MEADOW_ATLAS_WGSL = /* wgsl */ `
const MEADOW_PATCH: f32 = ${MEADOW_PATCH_METRES.toFixed(4)};
const MEADOW_BLOCK: i32 = ${MEADOW_BLOCK_PATCHES};
const MEADOW_NEVER: u32 = ${MEADOW_CONTINUUM_NEVER}u;
const MEADOW_SWAY: f32 = ${MEADOW_SWAY.toFixed(4)};
struct MeadowCfg {
  domain: vec4f, // the cover map's region: centre x, z, span; the waterline
  params: vec4u, // samples a pixel, the cover map's size, 0, 0
  crater: vec4f, // the crater field's origin x, z, its tile metres, 1 when bound
  blocks: vec4i, // the region's first block x, z; blocks across x, z
  scene: vec4f,  // the scene's pixel error (js/continuum-core.js), 0, 0, 0
  room: vec4u,   // room in the lists: clusters, far body, splats; room for patches drawn
  more: vec4u,   // room for patches cut by clusters; blocks in the region; 0, 0
};
fn meadowVariant(variant: u32, field: u32) -> u32 { return meadowAtlas[meadowAtlas[${MEADOW_AT.variantsAt}u] + variant * ${MEADOW_CONTINUUM_VARIANT_WORDS}u + field]; }
fn meadowVariantF(variant: u32, field: u32) -> f32 { return bitcast<f32>(meadowVariant(variant, field)); }
fn meadowVariantSphere(variant: u32) -> vec4f {
  return vec4f(meadowVariantF(variant, ${MEADOW_VARIANT_AT.sphere}u), meadowVariantF(variant, ${MEADOW_VARIANT_AT.sphere + 1}u), meadowVariantF(variant, ${MEADOW_VARIANT_AT.sphere + 2}u), meadowVariantF(variant, ${MEADOW_VARIANT_AT.sphere + 3}u));
}
fn meadowStep(variant: u32, step: u32, word: u32) -> u32 { return meadowAtlas[meadowVariant(variant, ${MEADOW_VARIANT_AT.steps}u) + step * ${MEADOW_CONTINUUM_STEP_WORDS}u + word]; }
fn meadowStepF(variant: u32, step: u32, word: u32) -> f32 { return bitcast<f32>(meadowStep(variant, step, word)); }
fn meadowClusterWord(cluster: u32, word: u32) -> u32 { return meadowAtlas[meadowAtlas[${MEADOW_AT.clustersAt}u] + cluster * ${MEADOW_CONTINUUM_CLUSTER_WORDS}u + word]; }
fn meadowClusterF(cluster: u32, word: u32) -> f32 { return bitcast<f32>(meadowClusterWord(cluster, word)); }
fn meadowClusterSphere(cluster: u32, word: u32) -> vec4f {
  return vec4f(meadowClusterF(cluster, word), meadowClusterF(cluster, word + 1u), meadowClusterF(cluster, word + 2u), meadowClusterF(cluster, word + 3u));
}
fn meadowUnpackSlopeNormal(packed: u32) -> vec3f {
  let sxz = unpack2x16snorm(packed);
  return normalize(vec3f(sxz.x, sqrt(max(0.04, 1.0 - dot(sxz, sxz))), sxz.y));
}
// A patch drawn this frame: which it is (its world cell, kept relative to the region's first block), how its
// pixels are shared (the handoff's share | the splat's << 8 | its variant << 16), its far body's step | morph << 16
// (or, drawn as a splat alone, the splat's scale), and its ground's slope.
struct MeadowState { cell: vec2i, share: u32, splatShare: u32, variant: u32, step: u32, morph: f32, splatScale: f32, slope: vec3f, seed: u32 };
fn meadowStateOf(index: u32) -> MeadowState {
  let s = meadowStates[index];
  var out: MeadowState;
  out.cell = vec2i(i32(s.x & 65535u), i32(s.x >> 16u)) + cfg.blocks.xy * MEADOW_BLOCK;
  out.share = s.y & 255u;
  out.splatShare = (s.y >> 8u) & 255u;
  out.variant = (s.y >> 16u) & 255u;
  out.step = s.z & 65535u;
  out.morph = f32(s.z >> 16u) / 65535.0;
  out.splatScale = select(1.0, bitcast<f32>(s.z), out.splatShare == 255u);
  out.slope = meadowUnpackSlopeNormal(s.w);
  out.seed = meadowHash2(out.cell);
  return out;
}
`;

// --------------------------------------------------------------------------------------------- the cut
export const MEADOW_CUT_WGSL = FRAME_WGSL + CONTINUUM_CORE_WGSL + MEADOW_HASH_GROUND_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> cfg: MeadowCfg;
@group(0) @binding(2) var<uniform> nearTerrain: MeadowNearDomain;
@group(0) @binding(3) var elevation: texture_2d<f32>;
@group(0) @binding(4) var meadowCover: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> meadowAtlas: array<u32>;
@group(0) @binding(6) var<storage, read> meadowBlocks: array<vec4f>;            // a block's most cover, lowest and highest ground
@group(0) @binding(7) var<storage, read_write> meadowStates: array<vec4u>;
@group(0) @binding(8) var<storage, read_write> meadowLists: array<vec2u>;
@group(0) @binding(9) var<storage, read_write> meadowCounters: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> meadowBlockWork: array<atomic<u32>>; // the blocks in view, as the blocks pass writes them
@group(0) @binding(11) var<storage, read> meadowBlockList: array<u32>;             // and as the patches pass reads them
@group(0) @binding(12) var<storage, read_write> meadowNearWork: array<atomic<u32>>;  // the patches cut by clusters, as written
@group(0) @binding(13) var<storage, read> meadowNearList: array<u32>;              // and as read
` + MEADOW_ATLAS_WGSL + /* wgsl */ `
const MEADOW_FULL: u32 = 0xffffffffu;
const MEADOW_STATES: u32 = ${MEADOW_COUNTER.states}u;
const MEADOW_LOST: u32 = ${MEADOW_COUNTER.lost}u;
const MEADOW_WORK: u32 = ${MEADOW_WORK_HEADER}u;
// The morph search reads the steps of the variant in hand.
var<private> meadowSteps: u32;
${continuumClusterPrefixWGSL('meadowClusterPrefix', (i) => `meadowClusterF(${i}, 13u)`)}
${continuumMorphStepWGSL('meadowMorphStep', (i) => `bitcast<f32>(meadowAtlas[meadowSteps + (${i}) * ${MEADOW_CONTINUUM_STEP_WORDS}u + 1u])`)}
fn meadowFocal() -> f32 { return F.screen.y / max(2.0 * length(F.camUp.xyz), 1e-4); }
fn meadowShift() -> vec3f { return vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z); }
fn meadowOutside(at: vec3f, reach: f32) -> bool {
  let m = F.viewProj; let p = vec4f(at, 1.0);
  let w = vec4f(m[0].w, m[1].w, m[2].w, m[3].w); let x = vec4f(m[0].x, m[1].x, m[2].x, m[3].x); let y = vec4f(m[0].y, m[1].y, m[2].y, m[3].y);
  let planes = array<vec4f, 5>(w + x, w - x, w + y, w - y, w);
  for (var i = 0u; i < 5u; i++) { if (dot(planes[i], p) < -reach * length(planes[i].xyz)) { return true; } }
  return false;
}
// Room for 'count' entries in a list: the first one's index, or MEADOW_FULL.
fn meadowAppend(list: u32, count: u32) -> u32 {
  let room = array<u32, 3>(cfg.room.x, cfg.room.y, cfg.room.z);
  let first = array<u32, 3>(0u, cfg.room.x, cfg.room.x + cfg.room.y);
  let at = atomicAdd(&meadowCounters[list * 4u + 1u], count);
  if (at + count > room[list]) {
    atomicSub(&meadowCounters[list * 4u + 1u], count);
    atomicAdd(&meadowCounters[MEADOW_LOST], 1u);
    return MEADOW_FULL;
  }
  return first[list] + at;
}
fn meadowCoverAt(uv: vec2f) -> vec4f {
  let limit = max(vec2i(textureDimensions(meadowCover)) - vec2i(1), vec2i(1));
  let q = clamp(uv, vec2f(0.0), vec2f(1.0)) * vec2f(limit);
  let i = min(vec2i(floor(q)), max(limit - vec2i(1), vec2i(0)));
  let f = q - vec2f(i);
  let c00 = textureLoad(meadowCover, i, 0);
  let c10 = textureLoad(meadowCover, min(i + vec2i(1, 0), limit), 0);
  let c01 = textureLoad(meadowCover, min(i + vec2i(0, 1), limit), 0);
  let c11 = textureLoad(meadowCover, min(i + vec2i(1, 1), limit), 0);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}
// A point of a patch, in its own metres, stood on the ground under it (without the world's offset).
fn meadowStand(origin: vec2f, local: vec3f) -> vec3f {
  let xz = origin + local.xz;
  return vec3f(xz.x, meadowGroundY(xz, cfg.domain, elevation) + local.y, xz.y);
}

// The counters and work lists emptied, each draw's vertex count set.
@compute @workgroup_size(16) fn meadowReset(@builtin(local_invocation_index) i: u32) {
  let vertices = array<u32, 3>(${MEADOW_CONTINUUM_LIST_VERTICES.map((n) => `${n}u`).join(', ')});
  atomicStore(&meadowCounters[i], select(0u, vertices[min(i / 4u, 2u)], i < 12u && i % 4u == 0u));
  if (i < 4u) {
    atomicStore(&meadowBlockWork[i], select(0u, 1u, i == 1u || i == 2u));
    atomicStore(&meadowNearWork[i], select(0u, 1u, i == 1u || i == 2u));
  }
}

// One thread a block of the region: those holding grass above the waterline and in view are listed, and the
// patches pass is dispatched once for each.
@compute @workgroup_size(64) fn meadowBlocksInView(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= cfg.more.y) { return; }
  let data = meadowBlocks[id.x];
  if (data.x < 0.02 || data.z < cfg.domain.w - ${MEADOW_GROUND_SLACK.toFixed(1)}) { return; }
  let across = u32(max(cfg.blocks.z, 1));
  let side = MEADOW_PATCH * f32(MEADOW_BLOCK);
  let low = vec2f(cfg.blocks.xy + vec2i(i32(id.x % across), i32(id.x / across))) * side;
  let bottom = data.y - ${MEADOW_GROUND_SLACK.toFixed(1)};
  let top = data.z + ${(MEADOW_REACH_UP + MEADOW_GROUND_SLACK).toFixed(1)};
  let centre = vec3f(low.x + side * 0.5, (bottom + top) * 0.5, low.y + side * 0.5);
  let reach = length(vec3f(side * 0.5 + ${MEADOW_OVERHANG.toFixed(1)}, (top - bottom) * 0.5, side * 0.5 + ${MEADOW_OVERHANG.toFixed(1)}));
  if (meadowOutside(earthCurve(centre + meadowShift() - F.camPos.xyz, F.camPos.y), reach)) { return; }
  let at = atomicAdd(&meadowBlockWork[0], 1u);
  atomicStore(&meadowBlockWork[MEADOW_WORK + at], id.x);
}

// How one patch is drawn this frame.
fn meadowDecide(cell: vec2i) {
  let origin = vec2f(cell) * MEADOW_PATCH;
  let half = MEADOW_PATCH * 0.5;
  let middle = origin + vec2f(half);
  let uv = (middle - cfg.domain.xy) / cfg.domain.z + 0.5;
  if (any(uv <= vec2f(0.002)) || any(uv >= vec2f(0.998))) { return; }
  // Grass where the cover map grows it at its middle or a corner, on dry ground.
  let cover = meadowCoverAt(uv);
  let o = half / cfg.domain.z;
  let corners = max(max(meadowCoverAt(uv + vec2f(o, o)).r, meadowCoverAt(uv + vec2f(-o, o)).r), max(meadowCoverAt(uv + vec2f(o, -o)).r, meadowCoverAt(uv + vec2f(-o, -o)).r));
  if (max(cover.r, corners) < 0.02) { return; }
  let ground = meadowGroundY(middle, cfg.domain, elevation);
  if (ground < cfg.domain.w) { return; }
  let hx = (meadowGroundY(middle + vec2f(half, 0.0), cfg.domain, elevation) - meadowGroundY(middle - vec2f(half, 0.0), cfg.domain, elevation)) / MEADOW_PATCH;
  let hz = (meadowGroundY(middle + vec2f(0.0, half), cfg.domain, elevation) - meadowGroundY(middle - vec2f(0.0, half), cfg.domain, elevation)) / MEADOW_PATCH;
  let slope = normalize(vec3f(-hx, 1.0, -hz));
  // Its variant: the cover map's mix (pasture, waste, field margin), one of four by a hash of where it lies.
  let seed = meadowHash2(cell);
  let jitter = f32((seed >> 24u) & 255u) / 255.0;
  var mixIndex = 0u;
  if (cover.g > 0.72 || (cover.g > 0.35 && jitter > 0.65)) { mixIndex = 2u; } else if (cover.g > 0.24) { mixIndex = 1u; }
  let variant = mixIndex * 4u + (seed & 3u);
  // Everything the variant can draw, stood on the plane of its ground.
  let sphere = meadowVariantSphere(variant);
  let centre = vec3f(origin.x + sphere.x, ground + sphere.y + hx * (sphere.x - half) + hz * (sphere.z - half), origin.y + sphere.z);
  let reach = sphere.w * (1.0 + abs(hx) + abs(hz)) + MEADOW_SWAY;
  let relative = centre + meadowShift() - F.camPos.xyz;
  if (meadowOutside(earthCurve(relative, F.camPos.y), reach)) { return; }
  let away = max(length(relative), 1e-3);
  let focal = meadowFocal();
  let pixels = cfg.scene.x;
  meadowSteps = meadowVariant(variant, ${MEADOW_VARIANT_AT.steps}u);
  let steps = meadowVariant(variant, ${MEADOW_VARIANT_AT.stepCount}u);
  // Where the far body's error at its first step is all the scene allows, it takes over from the clusters, over a
  // band of distance.
  let farFirst = meadowVariant(variant, ${MEADOW_VARIANT_AT.farFirst}u);
  let start = meadowStepF(variant, farFirst, 1u) * focal / pixels;
  let share = u32(round(continuumHandoff(away, start) * 255.0));
  // Its span: the width of a disc of the area the patch shows from here (its ground at this slant, its canopy
  // standing up).
  let toward = relative / away;
  let canopy = meadowVariantF(variant, ${MEADOW_VARIANT_AT.canopy}u);
  let area = MEADOW_PATCH * MEADOW_PATCH * abs(toward.y) + MEADOW_PATCH * canopy * (abs(toward.x) + abs(toward.z));
  let span = 2.0 * sqrt(area / 3.14159265) * focal / away;
  let splatShare = u32(round(continuumSplatShare(span) * 255.0));
  var splat = false; var chunks = 0u; var step = 0u; var morph = 0.0; var splatScale = 1.0;
  if (share > 0u) {
    splatScale = continuumThin(span, seed);
    splat = splatShare > 0u && splatScale > 0.0;
    if (splatShare < 255u) {
      let chosen = meadowMorphStep(steps, pixels * away / focal);
      step = u32(chosen.x); morph = chosen.y;
      if (step < farFirst) { step = farFirst; morph = 0.0; }
      chunks = (meadowStep(variant, step, 0u) + ${MEADOW_CONTINUUM_CHUNK_TRIANGLES - 1}u) / ${MEADOW_CONTINUUM_CHUNK_TRIANGLES}u;
    }
  }
  let near = share < 255u;
  if (!near && !splat && chunks == 0u) { return; }
  let slot = atomicAdd(&meadowCounters[MEADOW_STATES], 1u);
  if (slot >= cfg.room.w) { atomicSub(&meadowCounters[MEADOW_STATES], 1u); atomicAdd(&meadowCounters[MEADOW_LOST], 1u); return; }
  let local = vec2u(cell - cfg.blocks.xy * MEADOW_BLOCK);
  let third = select(step | (u32(round(morph * 65535.0)) << 16u), bitcast<u32>(splatScale), splatShare == 255u);
  meadowStates[slot] = vec4u(local.x | (local.y << 16u), share | (splatShare << 8u) | (variant << 16u), third, pack2x16snorm(slope.xz));
  if (splat) {
    let at = meadowAppend(2u, 1u);
    if (at != MEADOW_FULL) { meadowLists[at] = vec2u(slot, ${MEADOW_SPLAT_ENTRY}u << 28u); }
  }
  if (chunks > 0u) {
    let at = meadowAppend(1u, chunks);
    if (at != MEADOW_FULL) { for (var c = 0u; c < chunks; c++) { meadowLists[at + c] = vec2u(slot, c | (${MEADOW_FAR_ENTRY}u << 28u)); } }
  }
  if (near) {
    let at = atomicAdd(&meadowNearWork[0], 1u);
    if (at >= cfg.more.x) { atomicSub(&meadowNearWork[0], 1u); atomicAdd(&meadowCounters[MEADOW_LOST], 1u); }
    else { atomicStore(&meadowNearWork[MEADOW_WORK + at], slot); }
  }
}

// One workgroup a listed block, four of its patches a lane.
@compute @workgroup_size(64) fn meadowPatches(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let block = meadowBlockList[MEADOW_WORK + group.x];
  let across = u32(max(cfg.blocks.z, 1));
  let first = (cfg.blocks.xy + vec2i(i32(block % across), i32(block / across))) * MEADOW_BLOCK;
  for (var k = 0u; k < 4u; k++) {
    let p = lane + k * 64u;
    meadowDecide(first + vec2i(i32(p % u32(MEADOW_BLOCK)), i32(p / u32(MEADOW_BLOCK))));
  }
}

var<workgroup> meadowNear: vec4u;     // the patch's state, its variant's first cluster, the clusters to try, 0
var<workgroup> meadowNearView: vec4f; // focal, allowed pixels, how much the ground's slope widens a sphere, 0
// One workgroup a patch cut by clusters: the clusters drawn at its distance, by the core's own test, those in view
// entered in the list.
@compute @workgroup_size(64) fn meadowClusters(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  if (lane == 0u) {
    let index = meadowNearList[MEADOW_WORK + group.x];
    let state = meadowStateOf(index);
    let origin = vec2f(state.cell) * MEADOW_PATCH;
    let focal = meadowFocal();
    let pixels = cfg.scene.x;
    let tilt = (abs(state.slope.x) + abs(state.slope.z)) / max(state.slope.y, 0.2);
    let sphere = meadowVariantSphere(state.variant);
    let reach = sphere.w * (1.0 + tilt) + MEADOW_SWAY;
    let away = length(meadowStand(origin, sphere.xyz) + meadowShift() - F.camPos.xyz);
    let first = meadowVariant(state.variant, ${MEADOW_VARIANT_AT.clusterFirst}u);
    let candidates = meadowClusterPrefix(first, meadowVariant(state.variant, ${MEADOW_VARIANT_AT.clusterCount}u), pixels * max(away - reach, 0.25) / focal);
    meadowNear = vec4u(index, first, candidates, 0u);
    meadowNearView = vec4f(focal, pixels, tilt, 0.0);
  }
  let chosen = workgroupUniformLoad(&meadowNear);
  let view = workgroupUniformLoad(&meadowNearView);
  if (chosen.z == 0u) { return; }
  let origin = vec2f(meadowStateOf(chosen.x).cell) * MEADOW_PATCH;
  let shift = meadowShift() - F.camPos.xyz;
  let grow = 1.0 + view.z;
  for (var i = lane; i < chosen.z; i += 64u) {
    let c = chosen.y + i;
    let lod = meadowClusterSphere(c, 0u);
    let parent = meadowClusterSphere(c, 4u);
    if (!continuumClusterDrawn(meadowClusterF(c, 12u), meadowStand(origin, lod.xyz) + shift, lod.w * grow + MEADOW_SWAY,
      meadowClusterF(c, 13u), meadowStand(origin, parent.xyz) + shift, parent.w * grow + MEADOW_SWAY, view.x, view.y)) { continue; }
    let cull = meadowClusterSphere(c, 8u);
    if (meadowOutside(earthCurve(meadowStand(origin, cull.xyz) + shift, F.camPos.y), cull.w * grow + MEADOW_SWAY)) { continue; }
    let at = meadowAppend(0u, 1u);
    if (at != MEADOW_FULL) { meadowLists[at] = vec2u(chosen.x, c | (${MEADOW_CLUSTER_ENTRY}u << 28u)); }
  }
}
`;

// --------------------------------------------------------------------------------------------- drawing
const MEADOW_COMMON_WGSL = MEADOW_HASH_GROUND_WGSL + LAND_CRATER_SAMPLE_WGSL + /* wgsl */ `
struct ShotWake {
  posRad: vec4f,    // x, y, z (unshifted coast world m), signedRadius (< 0 = hot shot)
  velTrail: vec4f,  // vx, vy, vz (m/s), trailLen (m)
};

struct BlastRing {
  posAge: vec4f,    // x, y, z (unshifted coast world m), ageSec
  params: vec4f,    // strength, speed (26 m/s), maxAge (2.2 s), hot
};

// 1040-byte ballistic air-wake & impact shockwave uniform buffer (16 + 16*32 + 16*32 = 1040 bytes).
struct MeadowWakeFrame {
  counts: vec4u,    // shotCount (<= 16), ringCount (<= 16), 0, 0
  shots: array<ShotWake, ${MEADOW_MAX_SHOT_WAKES}>,
  rings: array<BlastRing, ${MEADOW_MAX_BLAST_RINGS}>,
};

// Travelling multi-octave wind-gust wave advecting downwind at windSpeed * 1.15:
//   - 14.0 m primary gust rollers (k1 = 2*pi / 14.0 = 0.4488)
//   -  4.5 m secondary wind ripples (k2 = 2*pi / 4.5 = 1.3963)
//   - Curved across-wind wavefronts + travelling gust-cell packets
fn grassWindWave(worldXZ: vec2f, time: f32, windParam: vec4f) -> vec2f {
  let rawDir = windParam.xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let speed = max(windParam.z, 5.2);
  let advect = time * speed * 1.15;
  let u = dot(worldXZ, windDir);
  let v = dot(worldXZ, acrossDir);

  let frontWarp = sin(v * 0.085 + time * 0.24) * 2.35 + cos(v * 0.19 - time * 0.31) * 1.15;
  let roller14 = sin((u - advect) * 0.4488 + frontWarp);
  let ripple45 = sin((u - advect * 1.06) * 1.3963 + cos(v * 0.48 - time * 0.52) * 1.40);
  let fineWave = sin((u - advect * 1.14) * 2.35 + sin(v * 0.92 + time * 0.72) * 1.05);

  let gustPacket = 0.56 + 0.44 * sin((u - advect * 0.82) * 0.165 + sin(v * 0.072) * 1.8) * cos(v * 0.095 + time * 0.21);
  let swell = (roller14 * 0.60 + ripple45 * 0.28 + fineWave * 0.12) * gustPacket;
  let gust01 = smoothstep(-0.50, 0.76, swell);
  return vec2f(gust01, swell);
}

fn meadowWindField(worldXZ: vec2f, time: f32, windParam: vec4f) -> vec2f {
  return grassWindWave(worldXZ, time, windParam);
}

fn meadowWindCurl(worldXZ: vec2f, time: f32, windDir: vec2f, speed: f32) -> f32 {
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let advect = time * max(speed, 5.2) * 1.15;
  let u = dot(worldXZ, windDir) - advect;
  let v = dot(worldXZ, acrossDir);
  return sin(v * 1.38 + u * 0.42) * cos(u * 1.12 - v * 0.54 + time * 0.9);
}

fn meadowWorldBillow(p: vec2f) -> vec3f {
  let warp = vec2f(sin(p.y * 0.13 + 1.3), cos(p.x * 0.11 - 0.8)) * 2.4;
  let q = p + warp;
  let a1 = q.x * 0.44 + q.y * 0.35;
  let a2 = -q.x * 0.29 + q.y * 0.41 + 2.1;
  let a3 = q.x * 0.14 - q.y * 0.18 + 0.7;
  let h = 1.0 + 0.14 * sin(a1) * cos(a2 * 0.85) + 0.10 * sin(a2) + 0.08 * cos(a3);
  let gx = 0.06 * cos(a1) * cos(a2 * 0.85) * 0.44 - 0.05 * cos(a2) * 0.29 - 0.03 * sin(a3) * 0.14;
  let gz = 0.06 * cos(a1) * cos(a2 * 0.85) * 0.35 + 0.05 * cos(a2) * 0.41 + 0.03 * sin(a3) * 0.18;
  return vec3f(h, gx * 0.10, gz * 0.10);
}
`;

export const MEADOW_RENDER_WGSL = FRAME_WGSL + ATMO_CORE_WGSL + SHADOW_FRAME + SKY_RENDER_FUNCS + CLOUD_SAMPLE + CONTINUUM_CORE_WGSL + MEADOW_COMMON_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var<uniform> cfg: MeadowCfg;
@group(0) @binding(6) var elevation: texture_2d<f32>;
@group(0) @binding(7) var<storage, read> meadowAtlas: array<u32>;
@group(0) @binding(8) var<storage, read> meadowStates: array<vec4u>;
@group(0) @binding(12) var<uniform> nearTerrain: MeadowNearDomain;
@group(0) @binding(13) var<uniform> wakes: MeadowWakeFrame;
@group(0) @binding(14) var landCraterLookup: texture_2d<i32>;
@group(0) @binding(15) var landLight: texture_2d<f32>;
@group(0) @binding(16) var meadowCover: texture_2d<f32>;
@group(0) @binding(17) var landAlbedo: texture_2d<f32>;
@group(0) @binding(18) var landSampler: sampler;
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;
@group(0) @binding(22) var landCraterField: texture_2d_array<f32>;
` + MEADOW_ATLAS_WGSL + /* wgsl */ `
struct MeadowVertexOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) colour: vec3f,
  @location(3) windInfo: vec4f,    // along, gust, swell, 1
  @location(4) tendrilFlow: vec4f, // bentUnshiftedXZ.xy, camDist, 1
  @location(5) damageInfo: vec2f,  // hotSinge, bendSlope
  @location(6) @interpolate(flat) coverage: vec4u, // the draw (1 clusters, 2 far body, 3 splat), handoff | splat << 8, the patch's seed, samples
};

struct MeadowEntry { @location(0) entry: vec2u };

// A vertex of the sward or of a canopy body, as the atlas holds it, in its patch's own metres.
struct MeadowVertexData {
  pos: vec3f,
  nrm: vec3f,
  col: vec3f,
  along: f32,
  stiff: f32,
  tuftRand: f32,
  offset: vec3f,
};

struct MeadowBallisticDeform {
  pushXZ: vec2f,
  pressDown: f32,
  buryDepth: f32,
  hotSinge: f32,
};

fn meadowOctahedral(e: vec2f) -> vec3f {
  let f = e * 2.0 - 1.0;
  var n = vec3f(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0); n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}
fn meadowSigned8(v: u32) -> f32 { return f32(bitcast<i32>((v & 255u) << 24u) >> 24u) * ${MEADOW_CONTINUUM_OFFSET_UNIT.toFixed(8)}; }
fn meadowPoint(vertex: u32) -> MeadowVertexData {
  let at = meadowAtlas[${MEADOW_AT.verticesAt}u] + vertex * ${MEADOW_CONTINUUM_VERTEX_WORDS}u;
  let w0 = meadowAtlas[at]; let w1 = meadowAtlas[at + 1u]; let w2 = meadowAtlas[at + 2u]; let w3 = meadowAtlas[at + 3u];
  let low = vec3f(bitcast<f32>(meadowAtlas[${MEADOW_AT.low}u]), bitcast<f32>(meadowAtlas[${MEADOW_AT.low + 1}u]), bitcast<f32>(meadowAtlas[${MEADOW_AT.low + 2}u]));
  var p: MeadowVertexData;
  p.pos = low + vec3f(f32(w0 & 65535u), f32(w0 >> 16u), f32(w1 & 65535u)) * (bitcast<f32>(meadowAtlas[${MEADOW_AT.span}u]) / 65535.0);
  p.along = f32((w1 >> 16u) & 255u) / 255.0;
  p.stiff = max(f32((w1 >> 24u) & 15u) * ${MEADOW_CONTINUUM_STIFFNESS_UNIT.toFixed(4)}, 0.8);
  p.tuftRand = (f32(w1 >> 28u) + 0.5) / 16.0;
  p.nrm = meadowOctahedral(vec2f(f32(w2 & 255u), f32((w2 >> 8u) & 255u)) / 255.0);
  p.offset = vec3f(meadowSigned8(w2 >> 16u), meadowSigned8(w2 >> 24u), meadowSigned8(w3 >> 24u));
  p.col = pow(vec3f(f32(w3 & 255u), f32((w3 >> 8u) & 255u), f32((w3 >> 16u) & 255u)) / 255.0, vec3f(2.2));
  return p;
}

fn meadowHidden() -> MeadowVertexOut {
  var o: MeadowVertexOut;
  o.pos = vec4f(2.0, 2.0, 0.0, 1.0);
  return o;
}

fn meadowDomainUV(unshiftedXZ: vec2f) -> vec2f {
  return clamp((unshiftedXZ - cfg.domain.xy) / cfg.domain.z + 0.5, vec2f(0.0005), vec2f(0.9995));
}

fn meadowGroundColour(unshiftedXZ: vec2f) -> vec3f {
  return pow(textureSampleLevel(landAlbedo, landSampler, meadowDomainUV(unshiftedXZ), 0.0).rgb, vec3f(2.2));
}

fn meadowCoverAt(unshiftedXZ: vec2f) -> vec4f {
  return textureSampleLevel(meadowCover, landSampler, meadowDomainUV(unshiftedXZ), 0.0);
}

// Evaluates GPU crater burial + radial blast parting, live low-flying cannonball V-wake furrows,
// and expanding 26 m/s impact shockwave rings at world position unshiftedXZ.
fn meadowEvalBallistics(unshiftedXZ: vec2f, groundY: f32, seed: u32) -> MeadowBallisticDeform {
  var out = MeadowBallisticDeform(vec2f(0.0), 0.0, 0.0, 0.0);

  // 1. Cannonball craters (O(1) lookup into 8 m r16sint grid + [81, 81] rgba16float field array)
  let cCell = landCraterLookupCell(unshiftedXZ, cfg.crater.xy);
  let cLayer = landCraterLayerAt(cCell, cfg.crater.w, landCraterLookup);
  if (cLayer >= 0) {
    let cUV = clamp(landCraterFieldUV(unshiftedXZ, cfg.crater.xy, cCell), vec2f(0.015), vec2f(0.985));
    let cField = textureSampleLevel(landCraterField, landSampler, cUV, cLayer, 0.0);
    if (cField.r < -0.025 || cField.g > 0.65) {
      let bury = max(smoothstep(-0.006, -0.032, cField.r), smoothstep(0.56, 0.70, cField.g));
      out.buryDepth = max(out.buryDepth, bury);
    }
    if (cField.a > 0.01 && out.buryDepth < 0.98) {
      let e = vec2f(${(1 / LAND_CRATER_TEXELS).toFixed(6)}, 0.0);
      let hX1 = textureSampleLevel(landCraterField, landSampler, cUV + e.xy, cLayer, 0.0).r;
      let hX0 = textureSampleLevel(landCraterField, landSampler, cUV - e.xy, cLayer, 0.0).r;
      let hZ1 = textureSampleLevel(landCraterField, landSampler, cUV + e.yx, cLayer, 0.0).r;
      let hZ0 = textureSampleLevel(landCraterField, landSampler, cUV - e.yx, cLayer, 0.0).r;
      let negGrad = -vec2f(hX1 - hX0, hZ1 - hZ0) * ${(1 / (2 * LAND_CRATER_CELL_M)).toFixed(2)};
      let gLen = length(negGrad);
      let tileCenter = cfg.crater.xy + (vec2f(cCell) + vec2f(0.5)) * ${LAND_CRATER_TILE_M.toFixed(1)};
      let fallbackOut = normalize(select(vec2f(1.0, 0.0), unshiftedXZ - tileCenter, length(unshiftedXZ - tileCenter) > 0.01));
      let outDir = select(fallbackOut, negGrad / max(gLen, 0.0001), gLen > 0.012);
      let rimBlast = clamp(cField.a * 1.15 + cField.g * 0.65, 0.0, 1.0);
      out.pushXZ += outDir * (0.28 * rimBlast);
      out.pressDown = max(out.pressDown, clamp(rimBlast * 0.85, 0.0, 0.88));
    }
  }

  // 2. Live low-flying cannonball air-wakes (clearY < 3.5 m V-wake furrow + damped whip oscillation)
  let shotCount = min(wakes.counts.x, ${MEADOW_MAX_SHOT_WAKES}u);
  for (var si = 0u; si < shotCount; si++) {
    let sw = wakes.shots[si];
    let ballPos = sw.posRad.xyz;
    let signedRad = sw.posRad.w;
    let rad = max(abs(signedRad), 0.04);
    let vel = sw.velTrail.xyz;
    let hSpeed = length(vel.xz);
    let fwd = select(vec2f(1.0, 0.0), vel.xz / max(hSpeed, 0.001), hSpeed > 0.2);
    let side = vec2f(-fwd.y, fwd.x);
    let relXZ = unshiftedXZ - ballPos.xz;
    let alongTrack = dot(relXZ, fwd);
    let trailLen = clamp(sw.velTrail.w, 6.0, 30.0);
    if (alongTrack > -trailLen && alongTrack < 1.35) {
      let tBehind = clamp(-alongTrack / max(hSpeed, 12.0), 0.0, 1.5);
      let passY = ballPos.y - vel.y * tBehind;
      let clearY = passY - groundY;
      if (clearY >= -0.65 && clearY < 3.5) {
        let wakeHalfW = max(0.40, rad * 4.6 + tBehind * 2.75) * (1.0 - clamp(max(0.0, clearY) / 3.5, 0.0, 1.0) * 0.42);
        let lat = dot(relXZ, side);
        let absLat = abs(lat);
        if (absLat < wakeHalfW * 1.75) {
          let lowFactor = pow(1.0 - clamp(max(0.0, clearY) / 3.5, 0.0, 1.0), 1.35);
          let axialEnv = smoothstep(1.35, -0.12, alongTrack) * exp(-tBehind * 2.35) * (1.0 - smoothstep(trailLen * 0.72, trailLen, -alongTrack));
          let latNorm = absLat / max(wakeHalfW, 0.15);
          let latEnv = exp(-latNorm * latNorm * 1.45);
          let whip = cos(tBehind * 18.5 - latNorm * 2.1);
          let tieSign = f32(seed & 1u) * 2.0 - 1.0;
          let outSign = select(select(-1.0, 1.0, lat >= 0.0), tieSign, absLat < 0.03);
          let env = lowFactor * axialEnv * latEnv;
          out.pushXZ += (side * outSign * (0.78 * whip + 0.30) + fwd * (0.50 * whip + 0.24)) * (0.44 * env);
          out.pressDown = max(out.pressDown, clamp(env * 0.82, 0.0, 0.82));
          if (signedRad < 0.0 && clearY < 1.85) {
            let singe = (1.0 - clamp(max(0.0, clearY) / 1.85, 0.0, 1.0)) * latEnv * smoothstep(0.55, -0.10, alongTrack) * exp(-tBehind * 1.4);
            out.hotSinge = max(out.hotSinge, clamp(singe, 0.0, 1.0));
          }
        }
      }
    }
  }

  // 3. Expanding 26 m/s impact shockwave rings (2.2 s radial pressure wave)
  let ringCount = min(wakes.counts.y, ${MEADOW_MAX_BLAST_RINGS}u);
  for (var ri = 0u; ri < ringCount; ri++) {
    let rg = wakes.rings[ri];
    let age = rg.posAge.w;
    let maxAge = max(rg.params.z, 0.2);
    if (age >= 0.0 && age < maxAge) {
      let ringSpeed = max(rg.params.y, 8.0);
      let strength = clamp(rg.params.x, 0.0, 2.5);
      let toBlade = unshiftedXZ - rg.posAge.xz;
      let rDist = length(toBlade);
      let frontR = age * ringSpeed;
      let bandW = 2.35 + age * 1.55;
      let deltaR = rDist - frontR;
      if (abs(deltaR) < bandW * 2.25) {
        let timeFade = pow(1.0 - age / maxAge, 1.45) / sqrt(1.0 + frontR * 0.08);
        let packet = exp(-(deltaR * deltaR) / (bandW * bandW)) * cos((deltaR / bandW) * 2.55);
        let radDir = select(vec2f(1.0, 0.0), toBlade / max(rDist, 0.05), rDist > 0.05);
        let waveAmp = 0.34 * strength * timeFade * packet;
        out.pushXZ += radDir * waveAmp;
        out.pressDown = max(out.pressDown, clamp(abs(waveAmp) * 1.15, 0.0, 0.55));
      }
    }
  }

  return out;
}

// A point of a patch stood on the ground under it, grown by the meadow's lushness and billow, bent by the wind and
// parted by shot. 'blade': a point of the sward, thinned plant by plant where the cover thins; otherwise of a canopy
// body, which sinks there instead.
fn meadowShadePlace(state: MeadowState, vd: MeadowVertexData, blade: bool) -> MeadowVertexOut {
  let seed = state.seed;
  let unshiftedXZ = vec2f(state.cell) * MEADOW_PATCH + vd.pos.xz;
  let groundY = meadowGroundY(unshiftedXZ, cfg.domain, elevation);
  let shiftXZ = nearTerrain.grid.yz;
  let camDist = distance(vec3f(unshiftedXZ.x + shiftXZ.x, groundY, unshiftedXZ.y + shiftXZ.y), F.camPos.xyz);

  let vCov = meadowCoverAt(unshiftedXZ);

  // Strict waterline & submerged terrain exclusion (zero blades on sea, estuaries, or carved inlandWater!)
  let dryLand = step(cfg.domain.w, groundY);

  // Organic ecotone blending along paths, beaches & riverbanks (cover 0.55 -> 0.06):
  // per-clump deterministic hash breaks borders into scattered tussocks & short grazed tufts (scaleY 0.40..1.0)
  // rather than uniform sparse needles!
  var tuftAlive = smoothstep(0.06, 0.55, vCov.r);
  var ecotoneScaleY = 1.0;
  if (blade) {
    let keepFrac = smoothstep(0.06, 0.55, vCov.r);
    let clumpHash = clamp(fract(vd.tuftRand * 1.07 + f32((seed >> 8u) & 255u) / 256.0), 0.04, 0.96);
    tuftAlive = smoothstep(clumpHash - 0.06, clumpHash + 0.06, keepFrac);
    ecotoneScaleY = mix(0.40, 1.0, keepFrac);
  }
  let bladeAlive = tuftAlive * dryLand;
  let heightWeight = ecotoneScaleY * bladeAlive;

  let wind = meadowWindField(unshiftedXZ, F.camPos.w, F.windP[0]);
  let rawDir = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let windSpeed = max(F.windP[0].z, 5.2);
  let curl = meadowWindCurl(unshiftedXZ, F.camPos.w, windDir, windSpeed);

  let billow = meadowWorldBillow(unshiftedXZ);
  let cellVigor = 0.92 + 0.16 * (f32((seed >> 16u) & 255u) / 255.0);
  let hBoost = (0.82 + 0.44 * vCov.b) * billow.x * cellVigor;

  let ballistics = meadowEvalBallistics(unshiftedXZ, groundY, seed);

  // Tuck retired / submerged / crater-buried roots cleanly beneath terrain surface.
  let marginRetired = max(1.0 - smoothstep(0.03, 0.06, vCov.r * dryLand), 1.0 - smoothstep(0.02, 0.16, bladeAlive));
  let edgeTuck = -0.045 * marginRetired - 0.090 * ballistics.buryDepth;

  let flexAlong = clamp(vd.along * 1.26, 0.0, 1.12);
  let wavePress = (1.0 - 0.14 * wind.x * smoothstep(0.15, 0.80, flexAlong))
                * (1.0 - ballistics.pressDown * smoothstep(0.05, 0.55, vd.along));

  var heightM = vd.pos.y + edgeTuck;
  if (vd.pos.y >= 0.0) {
    heightM = vd.pos.y * hBoost * heightWeight * (1.0 - ballistics.buryDepth) * wavePress + edgeTuck;
  }
  let posH = max(0.0, heightM);

  // Rolling multi-octave wind-gust bend along^1.65 deflecting flexible upper blades by up to ~40 deg (sin 40 deg = 0.643)!
  let bendProfile = pow(flexAlong, 1.65) * bladeAlive * (1.0 - ballistics.buryDepth);
  let speedNorm = clamp(windSpeed / 9.2, 0.58, 1.42);
  let stiffFactor = 9.5 / (clamp(vd.stiff, 3.0, 22.0) + 4.5);
  let tipFlutter = sin(dot(unshiftedXZ, windDir) * 2.35 - F.camPos.w * 5.8 + f32(seed & 31u) * 0.35) * 0.045 * wind.x;
  let bendSin = clamp((0.08 + 0.62 * wind.x * speedNorm + tipFlutter) * stiffFactor, 0.0, 0.66);
  let bendDir = normalize(windDir + acrossDir * (curl * (0.12 + 0.22 * wind.x)));
  let dispWind = posH * bendSin * bendProfile;
  let blastFlex = smoothstep(0.04, 0.75, vd.along) * (1.0 - ballistics.buryDepth);
  let dispXZ = bendDir * dispWind + ballistics.pushXZ * blastFlex;

  // Arc-length preserving vertical drop so 40-deg gust bends never stretch blade geometry
  let sinTheta = clamp(length(dispXZ) / max(posH, 0.055), 0.0, 0.78);
  let arcDrop = posH * (1.0 - sqrt(max(0.25, 1.0 - sinTheta * sinTheta))) * smoothstep(0.08, 0.65, flexAlong);

  let world = vec3f(unshiftedXZ.x + dispXZ.x + shiftXZ.x, groundY + heightM - arcDrop, unshiftedXZ.y + dispXZ.y + shiftXZ.y);

  // Normals lean on the ground's slope and tilt with the wind bend: nBent = normalize(nRest - bendDir * bendSlope * 0.85)
  let terrainN = state.slope;
  let nRest = normalize(vec3f(
    terrainN.x * 0.55 + vd.nrm.x * 0.72 - billow.y,
    max(0.32, terrainN.y * 0.65 + vd.nrm.y * 0.68),
    terrainN.z * 0.55 + vd.nrm.z * 0.72 - billow.z,
  ));
  let bendSlope = clamp(1.65 * bendSin * pow(max(flexAlong, 0.02), 0.65), 0.0, 0.96) * bladeAlive;
  let bendDir3 = vec3f(bendDir.x, 0.0, bendDir.y);
  let swardN = normalize(nRest - bendDir3 * (bendSlope * 0.85) + vec3f(ballistics.pushXZ.x, 0.0, ballistics.pushXZ.y) * 1.15);
  let bentN = normalize(mix(terrainN, swardN, bladeAlive));

  var o: MeadowVertexOut;
  o.world = world;
  o.normal = bentN;
  o.colour = vd.col;
  o.windInfo = vec4f(vd.along, wind.x, wind.y, 1.0);
  o.tendrilFlow = vec4f(unshiftedXZ - dispXZ * 0.65, camDist, 1.0);
  o.damageInfo = vec2f(ballistics.hotSinge, bendSlope);
  o.pos = F.viewProj * vec4f(earthCurve(world - F.camPos.xyz, F.camPos.y), 1.0);
  return o;
}

// A cluster's vertex: a point of the sward, its organ widened as its level keeps fewer of them.
fn meadowClusterVertex(state: MeadowState, cluster: u32, vertex: u32) -> MeadowVertexOut {
  let packed = meadowClusterWord(cluster, 15u);
  if (vertex / 3u >= (packed & 255u)) { return meadowHidden(); }
  var p = meadowPoint(meadowAtlas[meadowAtlas[${MEADOW_AT.indicesAt}u] + meadowClusterWord(cluster, 14u) + vertex]);
  p.pos += p.offset * (meadowVariantF(state.variant, ${MEADOW_VARIANT_AT.growth}u + ((packed >> 8u) & 255u)) - 1.0);
  return meadowShadePlace(state, p, true);
}

// Where canopy-body vertex v has gone by step s: each record is the step it collapses at and the vertex it joins.
fn meadowAncestor(variant: u32, vertex: u32, step: u32) -> u32 {
  let records = meadowVariant(variant, ${MEADOW_VARIANT_AT.records}u);
  var v = vertex;
  for (var hop = 0u; hop < ${MEADOW_CONTINUUM_HOPS}u; hop++) {
    let record = meadowAtlas[records + v];
    let at = record & 65535u;
    if (at == MEADOW_NEVER || at >= step) { break; }
    v = record >> 16u;
  }
  return v;
}
// One corner of the canopy body at its step, on its way to where the next collapse takes it, grown along its normals
// by what the collapses have taken off the outline.
fn meadowFarVertex(state: MeadowState, chunk: u32, vertex: u32) -> MeadowVertexOut {
  let variant = state.variant;
  let triangle = chunk * ${MEADOW_CONTINUUM_CHUNK_TRIANGLES}u + vertex / 3u;
  if (triangle >= meadowStep(variant, state.step, 0u)) { return meadowHidden(); }
  let at = meadowVariant(variant, ${MEADOW_VARIANT_AT.triangles}u) + triangle * ${MEADOW_CONTINUUM_TRIANGLE_WORDS}u;
  let next = min(state.step + 1u, meadowVariant(variant, ${MEADOW_VARIANT_AT.stepCount}u));
  let a = meadowAncestor(variant, meadowAtlas[at + vertex % 3u], state.step);
  let b = meadowAncestor(variant, a, next);
  let first = meadowVariant(variant, ${MEADOW_VARIANT_AT.chainVertices}u);
  let pa = meadowPoint(first + a);
  let pb = meadowPoint(first + b);
  let grow = mix(meadowStepF(variant, state.step, 2u), meadowStepF(variant, next, 2u), state.morph);
  var p = pa;
  p.pos = mix(pa.pos + pa.nrm * grow, pb.pos + pb.nrm * grow, state.morph);
  let n = mix(pa.nrm, pb.nrm, state.morph);
  p.nrm = select(vec3f(0.0, 1.0, 0.0), normalize(n), dot(n, n) > 1e-6);
  p.col = mix(pa.col, pb.col, state.morph);
  p.along = mix(pa.along, pb.along, state.morph);
  p.stiff = mix(pa.stiff, pb.stiff, state.morph);
  return meadowShadePlace(state, p, false);
}

// The splat: one triangle facing the eye, circumscribing an ellipse as wide as the patch across the line of sight
// and as high as it stands at this slant, shrunk to the area the patch shows from here (as the cut measured it),
// to the share of it grass covers, and grown where the splat is thinned to keep the horizon's covered area. Its
// colour is the sward's own, seen from above and from the side.
fn meadowSplatVertex(state: MeadowState, vertex: u32) -> MeadowVertexOut {
  let variant = state.variant;
  let middle = vec2f(state.cell) * MEADOW_PATCH + vec2f(MEADOW_PATCH * 0.5);
  let ground = meadowGroundY(middle, cfg.domain, elevation);
  let cover = meadowCoverAt(middle);
  let ballistics = meadowEvalBallistics(middle, ground, state.seed);
  let canopy = meadowVariantF(variant, ${MEADOW_VARIANT_AT.canopy}u);
  let standing = canopy * (0.82 + 0.44 * cover.b) * meadowWorldBillow(middle).x * (1.0 - ballistics.buryDepth);
  let shift = vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  let centre = vec3f(middle.x, ground + standing * 0.5, middle.y) + shift;
  let relative = centre - F.camPos.xyz;
  let toward = relative / max(length(relative), 1e-3);
  let level = length(toward.xz);
  let wide = MEADOW_PATCH * max((abs(toward.x) + abs(toward.z)) / max(level, 1e-6), 1.0);
  let tall = abs(toward.y) * wide + canopy * level;
  let area = MEADOW_PATCH * MEADOW_PATCH * abs(toward.y) + MEADOW_PATCH * canopy * (abs(toward.x) + abs(toward.z));
  let fit = sqrt(area / max(0.785398 * wide * tall, 1e-6));
  let k = 0.7776 * state.splatScale * fit * sqrt(smoothstep(0.06, 0.55, cover.r)) * (1.0 - ballistics.buryDepth);
  let corner = array<vec2f, 3>(vec2f(0.0, 2.0), vec2f(-1.7320508, -1.0), vec2f(1.7320508, -1.0))[min(vertex, 2u)];
  let world = centre + normalize(F.camRight.xyz) * (corner.x * wide * 0.5 * k) + normalize(F.camUp.xyz) * (corner.y * tall * 0.5 * k);

  let wind = meadowWindField(middle, F.camPos.w, F.windP[0]);
  let rawDir = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let bendSlope = 0.55 * wind.x;
  let top = vec3f(meadowVariantF(variant, ${MEADOW_VARIANT_AT.topColour}u), meadowVariantF(variant, ${MEADOW_VARIANT_AT.topColour + 1}u), meadowVariantF(variant, ${MEADOW_VARIANT_AT.topColour + 2}u));
  let side = vec3f(meadowVariantF(variant, ${MEADOW_VARIANT_AT.sideColour}u), meadowVariantF(variant, ${MEADOW_VARIANT_AT.sideColour + 1}u), meadowVariantF(variant, ${MEADOW_VARIANT_AT.sideColour + 2}u));
  var o: MeadowVertexOut;
  o.world = world;
  o.normal = normalize(state.slope - vec3f(windDir.x, 0.0, windDir.y) * (bendSlope * 0.70) + vec3f(0.0, 0.14, 0.0));
  o.colour = mix(side, top, abs(toward.y));
  o.windInfo = vec4f(0.48, wind.x, wind.y, 1.0);
  o.tendrilFlow = vec4f(middle, distance(centre, F.camPos.xyz), 1.0);
  o.damageInfo = vec2f(ballistics.hotSinge, bendSlope);
  o.pos = F.viewProj * vec4f(earthCurve(world - F.camPos.xyz, F.camPos.y), 1.0);
  return o;
}

@vertex fn meadowVS(@builtin(vertex_index) vertex: u32, listed: MeadowEntry) -> MeadowVertexOut {
  let state = meadowStateOf(listed.entry.x);
  let what = listed.entry.y >> 28u;
  let item = listed.entry.y & 0x0fffffffu;
  var out: MeadowVertexOut;
  if (what == ${MEADOW_CLUSTER_ENTRY}u) { out = meadowClusterVertex(state, item, vertex); }
  else if (what == ${MEADOW_FAR_ENTRY}u) { out = meadowFarVertex(state, item, vertex); }
  else { out = meadowSplatVertex(state, vertex); }
  out.coverage = vec4u(what, state.share | (state.splatShare << 8u), state.seed, cfg.params.x);
  return out;
}

fn meadowShadowVis(world: vec3f, normal: vec3f) -> f32 {
  if (landSH.origin.w < 0.5) { return 1.0; }
  let p = landSH.lightView * vec4f(world - landSH.origin.xyz + normal * 0.05 + landSH.sun.xyz * 0.04, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let fade = smoothstep(0.0, 0.06, edge) * step(0.0, p.z) * step(p.z, 1.0);
  if (fade <= 0.0) { return 1.0; }
  let refZ = min(p.z - 0.08 / max(landSH.sun.w, 1.0), 0.99999);
  let s = textureSampleCompareLevel(landSolidShadow, landShadowCompare, uv, refZ);
  return mix(1.0, s, fade);
}

fn meadowTendrilCloud(bentXZ: vec2f, camDist: f32, windDir: vec2f, gust: f32) -> vec2f {
  let pixel = camDist * 2.0 * length(F.camUp.xyz) / max(F.screen.y, 1.0);
  let wTuft = 1.0 - smoothstep(0.035, 0.110, pixel);
  if (wTuft <= 0.001) { return vec2f(0.5, 0.0); }

  let acrossDir = vec2f(-windDir.y, windDir.x);
  let dA = windDir * 0.961 + acrossDir * 0.276;
  let sA = vec2f(-dA.y, dA.x);
  let dB = windDir * 0.946 - acrossDir * 0.325;
  let sB = vec2f(-dB.y, dB.x);

  let uA = dot(bentXZ, dA);
  let vA = dot(bentXZ, sA);
  let uB = dot(bentXZ, dB);
  let vB = dot(bentXZ, sB);

  let envA = 0.5 + 0.5 * sin(uA * 3.15 + sin(vA * 2.45) * 1.45 - F.camPos.w * 1.05);
  let envB = 0.5 + 0.5 * cos(uB * 2.75 - cos(vB * 2.95) * 1.35 - F.camPos.w * 0.88);
  let wispA = sin(vA * 12.4 + sin(uA * 2.25) * 1.25) * envA;
  let wispB = sin(vB * 16.8 - cos(uB * 2.85) * 1.15) * envB;
  let slopeA = cos(vA * 12.4 + sin(uA * 2.25) * 1.25) * envA;
  let slopeB = cos(vB * 16.8 - cos(uB * 2.85) * 1.15) * envB;

  let signal = (wispA * 0.54 + wispB * 0.46) * wTuft;
  let density = clamp(0.5 + signal * 0.26 + (gust - 0.5) * 0.05 * wTuft, 0.0, 1.0);
  let crossTilt = (slopeA * 0.42 + slopeB * 0.36) * wTuft;
  return vec2f(density, crossTilt);
}

fn meadowShade(in: MeadowVertexOut, frontFacing: bool) -> vec4f {
  let rawDir = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let acrossDir = vec2f(-windDir.y, windDir.x);

  let along = clamp(in.windInfo.x, 0.0, 1.0);
  let gust = clamp(in.windInfo.y, 0.0, 1.0);
  let swell = in.windInfo.z;
  let distFade = clamp(in.tendrilFlow.w, 0.0, 1.0);
  let bendSlope = clamp(in.damageInfo.y, 0.0, 1.0);
  let isContinuum = in.coverage.x >= 2u;

  let unshiftedWorldXZ = in.world.xz - nearTerrain.grid.yz;
  let fCov = meadowCoverAt(unshiftedWorldXZ);
  let marginFade = smoothstep(0.06, 0.55, fCov.r) * distFade;
  let swardWeight = select(clamp((0.55 + 0.45 * smoothstep(0.06, 0.55, fCov.r)) * distFade, 0.0, 1.0), marginFade, isContinuum);

  // Natural Iberian Meadow Albedo (ZERO 62% brown dirt washout!):
  //   - World-space moisture & lushness patches blend smoothly between lush emerald pasture,
  //     Mediterranean olive-sage fescue, and sun-warmed straw.
  //   - Root base (along < 0.18) grounds gently with 20% warm soil/thatch tint + physical root AO (0.42 -> 1.0).
  //   - Tall culm seed-heads (along > 0.78) warm toward sunlit golden oat!
  let groundCol = meadowGroundColour(unshiftedWorldXZ);
  let mWarp = vec2f(sin(unshiftedWorldXZ.y * 0.042 + 1.7), cos(unshiftedWorldXZ.x * 0.038 - 0.9)) * 4.5;
  let mp = unshiftedWorldXZ + mWarp;
  let moistLow = 0.5 + 0.5 * sin(mp.x * 0.072 + mp.y * 0.056) * cos(mp.x * 0.046 - mp.y * 0.078 + 1.1);
  let moistMid = 0.5 + 0.5 * sin(mp.x * 0.21 - mp.y * 0.17 + 2.4);
  let moisture = clamp(moistLow * 0.68 + moistMid * 0.32 + (fCov.b - 0.55) * 0.45, 0.0, 1.0);

  let emeraldPasture = vec3f(0.046, 0.150, 0.030);
  let oliveSageFescue = vec3f(0.078, 0.134, 0.040);
  let sunWarmedStraw = vec3f(0.148, 0.136, 0.052);
  let goldenOatTip = vec3f(0.206, 0.170, 0.060);

  let patchGreen = mix(
    mix(sunWarmedStraw, oliveSageFescue, smoothstep(0.10, 0.48, moisture)),
    emeraldPasture,
    smoothstep(0.45, 0.88, moisture),
  );

  // Preserve distinct wildflower corolla pigments (chamomile ivory, rose mallow, scarlet field poppy)
  let isFlower = select(
    clamp(max(in.colour.b - in.colour.g * 0.58, in.colour.r - in.colour.g * 1.32) * 10.0, 0.0, 1.0),
    0.0,
    isContinuum,
  );
  let tussockLum = clamp(in.colour.g / 0.142, 0.72, 1.28);
  var grassPigment = mix(in.colour * 1.06, patchGreen * tussockLum, 0.44);
  // Warm tall culm seed-heads (along > 0.78) toward sunlit golden oat
  let oatHeadT = smoothstep(0.76, 0.94, along);
  grassPigment = mix(grassPigment, goldenOatTip, oatHeadT * 0.82);
  // Gentle 20% warm soil/thatch root grounding on along < 0.18
  let warmSoil = mix(groundCol, vec3f(0.072, 0.066, 0.034), 0.45);
  grassPigment = mix(grassPigment, warmSoil, 0.20 * (1.0 - smoothstep(0.0, 0.18, along)));

  let organCol = mix(grassPigment, in.colour * 1.06, isFlower);
  let ao = mix(0.42, 1.0, smoothstep(0.0, 0.55, along));
  let shadedBladeCol = organCol * mix(1.0, ao, swardWeight * 0.75);

  let horizonGround = mix(groundCol, patchGreen * 0.78, 0.36 * marginFade);
  var baseCol = select(
    mix(horizonGround, shadedBladeCol, distFade),
    mix(groundCol, shadedBladeCol, swardWeight),
    isContinuum,
  );

  // Per-pixel crater soot/ash scorching around inner rim + thrown-soil dusting across outer apron
  let cCellF = landCraterLookupCell(unshiftedWorldXZ, cfg.crater.xy);
  let cLayerF = landCraterLayerAt(cCellF, cfg.crater.w, landCraterLookup);
  if (cLayerF >= 0) {
    let cUVf = clamp(landCraterFieldUV(unshiftedWorldXZ, cfg.crater.xy, cCellF), vec2f(0.015), vec2f(0.985));
    let cFieldF = textureSampleLevel(landCraterField, landSampler, cUVf, cLayerF, 0.0);
    if (cFieldF.a > 0.005) {
      let inBowl = max(smoothstep(-0.005, -0.030, cFieldF.r), smoothstep(0.62, 0.82, cFieldF.g));
      let innerRimChar = smoothstep(0.18, 0.68, cFieldF.g) * (1.0 - inBowl * 0.65);
      let apronDust = clamp(cFieldF.a * 0.85 + cFieldF.g * 0.45, 0.0, 1.0) * (1.0 - innerRimChar * 0.5);
      let thrownEarth = mix(groundCol * vec3f(0.86, 0.78, 0.68), vec3f(0.20, 0.17, 0.12), cFieldF.b * 0.65);
      let sootAsh = mix(vec3f(0.015, 0.013, 0.011), vec3f(0.048, 0.044, 0.040), clamp(along * 0.7, 0.0, 1.0));
      baseCol = mix(baseCol, thrownEarth, apronDust * (0.45 + 0.45 * (1.0 - along)));
      baseCol = mix(baseCol, sootAsh, innerRimChar * 0.82);
      baseCol = mix(baseCol, groundCol * 0.48, inBowl);
    }
  }

  let hotSinge = clamp(in.damageInfo.x, 0.0, 1.0) * smoothstep(0.35, 0.92, along);
  if (hotSinge > 0.001) {
    let emberSoot = mix(vec3f(0.022, 0.016, 0.011), vec3f(0.11, 0.048, 0.014), smoothstep(0.70, 0.98, along));
    baseCol = mix(baseCol, emberSoot, hotSinge * 0.88);
  }

  let tf = meadowTendrilCloud(in.tendrilFlow.xy, in.tendrilFlow.z, windDir, gust);
  var n = normalize(in.normal + vec3f(acrossDir.x * tf.y * 0.18, 0.03, acrossDir.y * tf.y * 0.18) * swardWeight);
  if (!frontFacing) { n = normalize(vec3f(-n.x * 0.55, abs(n.y), -n.z * 0.55)); }

  // Shimmering wind-ripple contrast across gust crests & upright lulls
  let crest = smoothstep(-0.38, 0.65, swell);
  let tendrilHighlight = mix(1.0, mix(0.92, 1.09, tf.x), swardWeight);
  let windTone = mix(
    vec3f(1.0),
    mix(vec3f(0.90, 0.94, 0.88), vec3f(1.14, 1.15, 1.02), crest),
    swardWeight * (0.30 + 0.70 * along),
  );
  let albedo = clamp(baseCol * tendrilHighlight * windTone, vec3f(0.0), vec3f(0.36));

  let landUV = (unshiftedWorldXZ - cfg.domain.xy) / cfg.domain.z + 0.5;
  let edgeDist = min(min(landUV.x, 1.0 - landUV.x), min(landUV.y, 1.0 - landUV.y));
  let inDomain = smoothstep(0.0, 0.08, edgeDist);
  let bakedLight = textureSampleLevel(landLight, sampC, clamp(landUV, vec2f(0.0), vec2f(1.0)), 0.0).rg;
  var sunlight = bakedLight.r;
  if (inDomain < 1.0 && CF.screen.w > 0.5 && F.sunDir.y > 0.0) {
    let cMid = cloudUV(in.world * 0.001 + F.sunDir.xyz * (max(CF.shape.x, 0.5) / max(F.sunDir.y, 0.15)));
    let cD = textureSampleLevel(cloudDensity, cloudSampler, clamp(cMid, vec3f(0.0), vec3f(1.0)), 1.0).r;
    let cL = textureSampleLevel(cloudLight, cloudSampler, clamp(cMid, vec3f(0.0), vec3f(1.0)), 1.0).b;
    let cloudVis = clamp(exp(-max(cD, 0.0) * CF.shape.z * 0.6) * mix(1.0, cL, 0.5), 0.0, 1.0);
    sunlight = mix(cloudVis, bakedLight.r, inDomain);
  }
  let shadowVis = meadowShadowVis(in.world, n);
  let direct = sunIlluminance() * sunlight * solarShadowVisibility(vec3f(shadowVis)).x;

  let nDotL = max(dot(n, F.sunDir.xyz), 0.0);
  let wrap = max(0.0, dot(n, F.sunDir.xyz) * 0.50 + 0.50) * (0.14 + 0.14 * along) * swardWeight;
  let v = normalize(F.camPos.xyz - in.world);

  // Forward subsurface sunlight translucency (backscatter through bent golden-green upper blades & panicles)
  let sunFwd = pow(max(dot(-v, F.sunDir.xyz), 0.0), 2.1);
  let backTransmission = max(0.0, -dot(n, F.sunDir.xyz)) * 0.50 + 0.50;
  let backscatter = (0.28 * backTransmission + 0.92 * sunFwd)
                  * smoothstep(0.24, 0.88, along)
                  * (0.65 + 0.55 * gust)
                  * (0.70 + 0.30 * tf.x)
                  * swardWeight;

  let skyDir = normalize(vec3f(n.x * 0.65, max(n.y, 0.12), n.z * 0.65));
  let skyIrr = textureSampleLevel(envCube, sampC, skyDir, 6.0).rgb;
  let bounceDir = normalize(vec3f(n.x * 0.5, -0.55, n.z * 0.5));
  let groundIrr = textureSampleLevel(envCube, sampC, bounceDir, 6.5).rgb * vec3f(0.84, 0.86, 0.68);
  let ambient = mix(groundIrr * 0.50, skyIrr, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)) * mix(1.0, ao, swardWeight);

  // Silky grazing-angle + Kajiya-Kay specular sheen across wind-flattened wave troughs!
  let hRaw = v + F.sunDir.xyz;
  let h = select(vec3f(0.0, 1.0, 0.0), normalize(hRaw), length(hRaw) > 1e-5);
  let nDotH = max(dot(n, h), 0.0);
  let graze = pow(clamp(1.0 - max(dot(n, v), 0.0), 0.0, 1.0), 2.3);
  let flatGust = clamp(gust * 0.65 + bendSlope * 0.45, 0.0, 1.0);
  let fiberTan = normalize(vec3f(windDir.x * (0.36 + 0.56 * flatGust), max(0.18, 0.78 - 0.50 * flatGust), windDir.y * (0.36 + 0.56 * flatGust)));
  let tDotH = clamp(dot(fiberTan, h), -1.0, 1.0);
  let sinTH = sqrt(max(0.0, 1.0 - tDotH * tDotH));
  let troughFlatten = smoothstep(0.28, 0.86, flatGust) * (0.25 + 0.75 * along);
  let waveSheen = (pow(sinTH, 14.0) * (0.010 + 0.036 * crest * troughFlatten)
                + pow(nDotH, 16.0) * 0.028 * troughFlatten * (0.35 + 0.65 * graze))
                * max(F.sunDir.y, 0.03) * swardWeight;
  let skyWaveSheen = skyIrr * (0.016 + 0.048 * troughFlatten * graze) * ao * swardWeight;

  let diffuseWeight = mix(1.0, 0.90, swardWeight);
  let transAlbedo = mix(albedo * vec3f(1.22, 1.38, 0.58), goldenOatTip * 1.15, oatHeadT * 0.65);
  var col = albedo * (direct * (nDotL * diffuseWeight + wrap) / PI + ambient)
          + transAlbedo * (direct * backscatter * 0.52 / PI)
          + (direct / PI) * waveSheen * vec3f(0.94, 0.98, 0.72)
          + skyWaveSheen;
  col += lunarSurface(n, v, albedo, 0.76, vec3f(0.034), vec3f(mix(1.0, bakedLight.g, inDomain)) * lunarShadowVisibility(vec3f(shadowVis)));
  col = surfaceAir(col, in.world);
  return vec4f(col, 1.0);
}

// The samples of this pixel each draw takes (continuumSamples, the shared core's split): the far side the handoff's
// share and the clusters the rest; of the far side's, the splat its own share and the canopy body the rest. Every
// sample is drawn by exactly one of the three.
struct MeadowCoverageOut {
  @location(0) colour: vec4f,
  @builtin(sample_mask) mask: u32,
};
fn meadowMask(coverage: vec4u, pixel: vec2f) -> u32 {
  let samples = clamp(coverage.w, 1u, 8u);
  let all = (1u << samples) - 1u;
  let handoff = continuumSamples(f32(coverage.y & 255u) / 255.0, pixel, samples, coverage.z);
  let splat = handoff & continuumSamples(f32((coverage.y >> 8u) & 255u) / 255.0, pixel, samples, coverage.z + 7u);
  if (coverage.x == ${MEADOW_CLUSTER_ENTRY}u) { return all & ~handoff; }
  if (coverage.x == ${MEADOW_FAR_ENTRY}u) { return handoff & ~splat; }
  return splat;
}

@fragment fn meadowFS(in: MeadowVertexOut, @builtin(front_facing) front: bool) -> MeadowCoverageOut {
  var o: MeadowCoverageOut;
  o.colour = meadowShade(in, front);
  o.mask = meadowMask(in.coverage, in.pos.xy);
  return o;
}
`;

// The cut's four passes (each with its own bind group layout, so a work list is written by one pass and read, and
// dispatched from, by the next) and the two drawing pipelines: the sward's clusters, seen from both sides, and the
// closed canopy bodies and splats, their far faces left out.
export function requestMeadowPipelines({ device, shader, format = 'rgba16float', samples = 4 }) {
  return requestOnce(device, `meadow continuum ${format} ${samples}`, async () => {
    const C = GPUShaderStage.COMPUTE;
    const buffer = (binding, type) => ({ binding, visibility: C, buffer: { type } });
    const texture = (binding) => ({ binding, visibility: C, texture: { sampleType: 'unfilterable-float' } });
    const uniforms = [buffer(0, 'uniform'), buffer(1, 'uniform'), buffer(2, 'uniform')];
    const entries = {
      reset: [buffer(9, 'storage'), buffer(10, 'storage'), buffer(12, 'storage')],
      blocks: [...uniforms, buffer(6, 'read-only-storage'), buffer(10, 'storage')],
      patches: [...uniforms, texture(3), texture(4), buffer(5, 'read-only-storage'), buffer(7, 'storage'), buffer(8, 'storage'), buffer(9, 'storage'), buffer(11, 'read-only-storage'), buffer(12, 'storage')],
      clusters: [...uniforms, texture(3), buffer(5, 'read-only-storage'), buffer(7, 'storage'), buffer(8, 'storage'), buffer(9, 'storage'), buffer(13, 'read-only-storage')],
    };
    const points = { reset: 'meadowReset', blocks: 'meadowBlocksInView', patches: 'meadowPatches', clusters: 'meadowClusters' };
    const cutModule = await shader(MEADOW_CUT_WGSL, 'meadow continuum cut');
    const layouts = {}, cut = {};
    for (const [name, list] of Object.entries(entries)) {
      layouts[name] = device.createBindGroupLayout({ label: `meadow continuum ${name}`, entries: list });
      cut[name] = await device.createComputePipelineAsync({
        label: `meadow continuum ${name}`, layout: device.createPipelineLayout({ label: `meadow continuum ${name}`, bindGroupLayouts: [layouts[name]] }),
        compute: { module: cutModule, entryPoint: points[name] },
      });
    }
    const renderModule = await shader(MEADOW_RENDER_WGSL, 'meadow continuum render');
    const draw = (label, cullMode) => device.createRenderPipelineAsync({
      label, layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'meadowVS', buffers: MEADOW_ENTRY_LAYOUT },
      fragment: { module: renderModule, entryPoint: 'meadowFS', targets: [{ format }] },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: samples },
    });
    const clusters = await draw('meadow continuum clusters', 'none');
    const far = await draw('meadow continuum far', 'back');
    return { ...cut, layouts, clusterDraw: clusters, farDraw: far };
  });
}

// The blocks of `region` on the world's grid of blocks, and for each the most grass the cover map grows on or beside
// it and the lowest and highest ground under that grass: what the cut's first pass reads.
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
    }
  }
  for (let b = 0; b < across[0] * across[1]; b++) if (!(data[b * 4] > 0)) data.set([0, 0, 0, 0], b * 4);
  return { first, across, count: across[0] * across[1], data, texels };
}

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
  elevation,
  nearDomain,
  resources,
  clouds,
  format = 'rgba16float',
  samples = 4,
  isMobile = false,
  coverSize = isMobile ? MEADOW_COVER_MOBILE : MEADOW_COVER_DESKTOP,
}) {
  if (!(pack?.words?.length > 0) || !pack.manifest) return null;
  const B = GPUBufferUsage;
  const P = await requestMeadowPipelines({ device, shader, format, samples });
  const room = isMobile ? MEADOW_CONTINUUM_MOBILE_ROOM : MEADOW_CONTINUUM_ROOM;
  const mkBuf = (label, size, usage, data = null) => {
    const buf = device.createBuffer({ label, size: Math.max(16, size), usage });
    if (data?.byteLength) device.queue.writeBuffer(buf, 0, data);
    return buf;
  };

  // The atlas, once; the patches drawn and the three lists, each a list's room; the counters, each list's draw first.
  const atlasBuf = mkBuf('meadow continuum atlas', pack.words.byteLength, B.STORAGE | B.COPY_DST, pack.words);
  const statesBuf = mkBuf('meadow continuum states', room.states * 16, B.STORAGE | B.COPY_SRC);
  const listsBuf = mkBuf('meadow continuum lists', (room.clusters + room.far + room.splat) * 8, B.STORAGE | B.VERTEX | B.COPY_SRC);
  const countersBuf = mkBuf('meadow continuum draws', MEADOW_COUNTER_WORDS * 4, B.STORAGE | B.INDIRECT | B.COPY_SRC);
  const nearWork = mkBuf('meadow continuum near patches', (MEADOW_WORK_HEADER + room.near) * 4, B.STORAGE | B.INDIRECT | B.COPY_SRC);
  let blockWork = null, blocksBuf = null, blockCount = 0;

  // The uniform both the cut and the drawing read: MeadowCfg.
  const cfgData = new ArrayBuffer(MEADOW_CFG_BYTES);
  const cfgF = new Float32Array(cfgData), cfgU = new Uint32Array(cfgData), cfgI = new Int32Array(cfgData);
  const cfgBuf = mkBuf('meadow continuum cfg', MEADOW_CFG_BYTES, B.UNIFORM | B.COPY_DST);
  cfgU.set([samples, coverSize, 0, 0], 4);
  cfgU.set([room.clusters, room.far, room.splat, room.states], 20);
  cfgU[24] = room.near;
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
    label: 'meadow cover',
    size: [coverSize, coverSize],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const elevationView = elevation.createView(), coverView = coverTexture.createView();

  // The cut's bind groups, one a pass; rebuilt when the region's blocks are.
  let cutGroups = null;
  const buildCutGroups = () => {
    const resource = {
      0: new Map(activeResources).get(0), 1: { buffer: cfgBuf }, 2: { buffer: nearDomain }, 3: elevationView, 4: coverView,
      5: { buffer: atlasBuf }, 6: { buffer: blocksBuf }, 7: { buffer: statesBuf }, 8: { buffer: listsBuf }, 9: { buffer: countersBuf },
      10: { buffer: blockWork }, 11: { buffer: blockWork }, 12: { buffer: nearWork }, 13: { buffer: nearWork },
    };
    const bindings = { reset: [9, 10, 12], blocks: [0, 1, 2, 6, 10], patches: [0, 1, 2, 3, 4, 5, 7, 8, 9, 11, 12], clusters: [0, 1, 2, 3, 5, 7, 8, 9, 13] };
    cutGroups = Object.fromEntries(Object.entries(bindings).map(([name, ids]) => [name, device.createBindGroup({
      label: `meadow continuum ${name}`, layout: P.layouts[name], entries: ids.map((binding) => ({ binding, resource: resource[binding] })),
    })]));
  };

  // The drawing's bind groups, one a pipeline; rebuilt when the land's resources or the craters change.
  let activeResources = resources;
  const drawGroups = new Map();
  const cloudGroups = new Map([[P.clusterDraw, clouds.bindVolume(P.clusterDraw)], [P.farDraw, clouds.bindVolume(P.farDraw)]]);
  function buildDrawGroups(resList) {
    const resMap = new Map(resList);
    const craterLookupView = (boundCraters?.lookupTexture ?? fallbackCraterLookup).createView();
    const craterFieldView = (boundCraters?.fieldTexture ?? fallbackCraterField).createView({ dimension: '2d-array' });
    const extraMap = new Map([
      [5, { buffer: cfgBuf }],
      [6, elevationView],
      [7, { buffer: atlasBuf }],
      [8, { buffer: statesBuf }],
      [12, { buffer: nearDomain }],
      [13, { buffer: wakeBuf }],
      [14, craterLookupView],
      [15, resMap.get(5)],
      [16, coverView],
      [17, resMap.get(7)],
      [18, resMap.get(8)],
      [22, craterFieldView],
    ]);
    const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
    for (const pipe of [P.clusterDraw, P.farDraw]) {
      drawGroups.set(pipe, device.createBindGroup({
        label: `${pipe.label} group0`,
        layout: pipe.getBindGroupLayout(0),
        entries: ids.map((id) => ({ binding: id, resource: extraMap.get(id) ?? resMap.get(id) })),
      }));
    }
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
    });
    device.queue.writeTexture({ texture: coverTexture }, map, { bytesPerRow: coverSize * 4 }, [coverSize, coverSize]);
    const blocks = meadowBlocksOf({ cover: map, size: coverSize, region: curRegion, heights: curHeights });
    coverTexels = blocks.texels;
    if (blocks.count !== blockCount) {
      blocksBuf?.destroy(); blockWork?.destroy();
      blockCount = blocks.count;
      blocksBuf = mkBuf('meadow continuum blocks', blockCount * 16, B.STORAGE | B.COPY_DST | B.COPY_SRC);
      blockWork = mkBuf('meadow continuum blocks in view', (MEADOW_WORK_HEADER + blockCount) * 4, B.STORAGE | B.INDIRECT | B.COPY_SRC);
      buildCutGroups();
    }
    device.queue.writeBuffer(blocksBuf, 0, blocks.data);
    cfgF.set([curRegion.x, curRegion.z, curRegion.span, MEADOW_WATERLINE], 0);
    cfgI.set([blocks.first[0], blocks.first[1], blocks.across[0], blocks.across[1]], 12);
    cfgU[25] = blockCount;
    syncCraterCfg(curRegion);
  }

  function bindCraters(nextCraters = null) {
    unsubscribeCraters?.();
    unsubscribeCraters = null;
    boundCraters = nextCraters || null;
    const applyCraterBinding = () => {
      syncCraterCfg(curRegion);
      buildDrawGroups(activeResources);
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
  else buildDrawGroups(activeResources);

  // Each list's first entry and room, in entries; the clusters and splats are drawn seen from both sides, the closed
  // canopy bodies from outside.
  const lists = [[0, room.clusters, P.clusterDraw], [room.clusters, room.far, P.farDraw], [room.clusters + room.far, room.splat, P.clusterDraw]];
  const variants = pack.manifest.variants ?? [];
  return {
    stats: {
      loaded: true,
      style: pack.manifest.format,
      variants: variants.length,
      clusters: variants.reduce((n, v) => n + v.clusters, 0),
      sourceTriangles: variants.reduce((n, v) => n + v.sourceTriangles, 0),
      patchMetres: MEADOW_PATCH_METRES,
      coverSize,
      room,
      get coveredTexels() { return coverTexels; },
      get blocks() { return blockCount; },
    },
    lists: MEADOW_CONTINUUM_LISTS,
    counters: countersBuf,
    states: statesBuf,
    listBuffer: listsBuf,
    nearWork,
    get blockWork() { return blockWork; },
    sync,
    bindCraters,
    setBallisticWakes,
    rebind(nextResources) {
      activeResources = nextResources;
      buildCutGroups();
      buildDrawGroups(activeResources);
    },
    // The cut: every patch of grass in view decided on the GPU, each list's draw written for draw().
    encode(pass) {
      active = !destroyed && coverTexels > 0 && cutGroups !== null;
      if (!active) return;
      const pixels = continuumPixelError();
      if (cfgF[16] !== Math.fround(pixels)) { cfgF[16] = pixels; cfgDirty = true; }
      if (cfgDirty) { device.queue.writeBuffer(cfgBuf, 0, cfgData); cfgDirty = false; }
      pass.setPipeline(P.reset);
      pass.setBindGroup(0, cutGroups.reset);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(P.blocks);
      pass.setBindGroup(0, cutGroups.blocks);
      pass.dispatchWorkgroups(Math.ceil(blockCount / 64));
      pass.setPipeline(P.patches);
      pass.setBindGroup(0, cutGroups.patches);
      pass.dispatchWorkgroupsIndirect(blockWork, 0);
      pass.setPipeline(P.clusters);
      pass.setBindGroup(0, cutGroups.clusters);
      pass.dispatchWorkgroupsIndirect(nearWork, 0);
    },
    draw(pass) {
      if (!active || destroyed) return;
      lists.forEach(([at, n, pipe], index) => {
        pass.setPipeline(pipe);
        pass.setBindGroup(0, drawGroups.get(pipe));
        pass.setBindGroup(1, cloudGroups.get(pipe));
        pass.setVertexBuffer(0, listsBuf, at * 8, n * 8);
        pass.drawIndirect(countersBuf, index * 16);
      });
    },
    // draw()'s indirect records, one a list, for the continuum census (js/continuum-census.js).
    continuumDraws() {
      if (destroyed || !active) return [];
      return [{ buffer: countersBuf, offset: 0, records: MEADOW_CONTINUUM_LISTS.length, stride: 4 }];
    },
    destroy() {
      destroyed = true;
      active = false;
      unsubscribeCraters?.();
      unsubscribeCraters = null;
      boundCraters = null;
      for (const buf of [atlasBuf, statesBuf, listsBuf, countersBuf, nearWork, blockWork, blocksBuf, cfgBuf, wakeBuf]) buf?.destroy();
      fallbackCraterLookup.destroy();
      fallbackCraterField.destroy();
      coverTexture.destroy();
    },
  };
}
