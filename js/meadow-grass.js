// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// 100% GPU Lush Botanical Meadow Grass Continuum on seamless 1.75 m x 1.75 m tiles (3.0625 m^2):
//   - Near / Mid (L0..L3, ~4,420 -> 2,140 -> 960 -> 384 tris/tile = ~1,444 tris/m^2 at LOD0, 100% full density inside ~20 m):
//     1. Arched 3-segment (5-tri, 7-vert) ryegrass, cocksfoot & fescue tussock sheaves (70%)
//     2. Dense broad low-arching clover, ribwort & basal turf ground-huggers (20%, >80% oblique turf fullness)
//     3. Tall sunlit golden oat/barley panicles & subtle 3D Mediterranean coastal wildflowers (10%)
//   - Anti-grid variety: toroidal-Poisson tussocks + per-cell deterministic 90-deg quadrant rotation + world-space moisture/height modulation.
//   - Far Continuum (out to ~780 m): MSAA @builtin(sample_mask) handoff into a closed genus-0 (Euler = 2) D4-symmetric
//     sculpted tussock-canopy morph.bin (cullMode: 'back', O(1) u8x4 ancestor lookup), morphing into 1-triangle horizon
//     splats (< 3.5 px) with stochastic sub-pixel thinning (< 1.0 px) and area-preserving inverseSqrt(keepProb) inflation.
//   - Ballistics: GPU cannonball crater burial, radial blast parting, soot scorching & thrown-soil dusting,
//     live low-flying cannonball V-wake furrows + hot-shot tip singeing, and 26 m/s impact shockwave rings.
import { requestOnce } from './gpu-program-cache.js';
import { FRAME_WGSL, ATMO_CORE_WGSL } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { CLOUD_SAMPLE } from './wgsl/clouds.js';
import { SHADOW_FRAME } from './wgsl/shadows.js';
import { terrainSurfaceSample } from './terrain-model.js';
import { CITY_BLOCK_FLOATS, CITY_GROUND } from './old-world-city.js';
import { INLAND_WATER_FLOATS } from './wgsl/inland-water.js';
import { LAND_CRATER_SAMPLE_WGSL, LAND_CRATER_TEXELS, LAND_CRATER_CELL_M, LAND_CRATER_TILE_M } from './wgsl/land-craters.js';
import { streetEdgeAt } from './town-streets.js';

export const MEADOW_TILE_METRES = 1.75;
export const MEADOW_FADE_IN_PX = 22.0;
export const MEADOW_FADE_OUT_PX = 16.5;
export const MEADOW_SPLAT_PX = 3.5;
export const MEADOW_MIN_PX = 1.0;
export const MEADOW_BUCKETS = 8;
export const MEADOW_DRAW_WORDS = 4;
export const MEADOW_MAX_SHOT_WAKES = 16;
export const MEADOW_MAX_BLAST_RINGS = 16;
export const MEADOW_WAKE_BUFFER_BYTES = 1040; // 16B counts + 16 * 32B ShotWake + 16 * 32B BlastRing = 1040B

const MEADOW_MACRO_MUL = 6; // 6 x 1.75 m = 10.50 m outer continuum/splat ring reaching ~782 m radius
const MEADOW_INST_FLOATS = 8;
const MEADOW_VERT_WORDS = 8;
const MEADOW_CLUSTER_WORDS = 12;
const MEADOW_MORPH_VERTS = 26;
const MEADOW_MORPH_FACES = 48;
const MEADOW_MORPH_STEPS = 21;
const MEADOW_MORPH_REMAP_OFFSET = MEADOW_MORPH_VERTS * MEADOW_VERT_WORDS + MEADOW_MORPH_FACES * 3; // 352
const MEADOW_MORPH_REMAP_WORDS = 276;
const MEADOW_MORPH_VAR_WORDS = MEADOW_MORPH_REMAP_OFFSET + MEADOW_MORPH_REMAP_WORDS; // 628 words = 2512 bytes
const MEADOW_GRID_SIDE_DESKTOP = 152; // 152 x 152 (~266 m near span) + 6x outer continuum ring (~782 m radius)
const MEADOW_GRID_SIDE_MOBILE = 96;   // 96 x 96 (~168 m near span) + 6x outer continuum ring (~488 m radius)
export const MEADOW_MAX_DIST = (MEADOW_GRID_SIDE_DESKTOP / 2) * MEADOW_TILE_METRES * MEADOW_MACRO_MUL - 16.0;
const MEADOW_COARSE_GRID = 64;
const MEADOW_BUCKET_SPAN = 32768;
const MEADOW_COVER_DESKTOP = 2048; // 4.0 m/texel across 8192 m region with bilinear SDF filtering
const MEADOW_COVER_MOBILE = 1024;

// Literal paths: build.mjs scans string literals from js/meadow-grass.js to emit content-hashed URLs.
export const PORTUGAL_MEADOW_GRASS_ASSETS = Object.freeze({
  'manifest.json': 'assets/ground-cover/portugal/meadows-gpu/manifest.json',
  'vertices.bin.gz': 'assets/ground-cover/portugal/meadows-gpu/vertices.bin.gz',
  'indices.bin.gz': 'assets/ground-cover/portugal/meadows-gpu/indices.bin.gz',
  'clusters.bin.gz': 'assets/ground-cover/portugal/meadows-gpu/clusters.bin.gz',
  'morph.bin.gz': 'assets/ground-cover/portugal/meadows-gpu/morph.bin.gz',
});

export function validateMeadowGrass(manifest) {
  if (manifest?.format !== 'waterworld.meadow-grass-gpu' || (manifest.version !== 1 && manifest.version !== 2)) {
    throw Error('Invalid meadow grass manifest format or version');
  }
  if (manifest.levels !== 4 || !(manifest.tileMetres > 0) || manifest.strideBytes !== 32 || manifest.clusterRecordWords !== MEADOW_CLUSTER_WORDS) {
    throw Error('Invalid meadow grass manifest geometry layout');
  }
  const err = manifest.levelErrors, perr = manifest.levelParentErrors;
  if (!Array.isArray(err) || !Array.isArray(perr) || err.length !== 4 || perr.length !== 4) {
    throw Error('Meadow grass manifest missing 4-level DAG error tables');
  }
  for (let i = 0; i < 4; i++) {
    if (!(err[i] < perr[i])) throw Error(`Meadow DAG level ${i} child error must be strictly below parent error`);
    if (i > 0 && !(err[i] > err[i - 1] && perr[i] > perr[i - 1])) {
      throw Error(`Meadow DAG level ${i} errors must be strictly monotonic`);
    }
  }
  const m = manifest.morph;
  if (!m || m.vertexCount !== MEADOW_MORPH_VERTS || m.faceCount !== MEADOW_MORPH_FACES || m.steps !== MEADOW_MORPH_STEPS ||
      m.ancestorTableOffsetWords !== MEADOW_MORPH_REMAP_OFFSET || m.bytesPerVariant !== MEADOW_MORPH_VAR_WORDS * 4) {
    throw Error('Meadow grass morph spec does not match GPU shader constants');
  }
  const vars = manifest.variantRecords;
  if (!Array.isArray(vars) || vars.length < 12) throw Error('Meadow grass manifest requires 12 variantRecords');
  for (const v of vars) {
    if (v.genusZeroEuler !== 2) throw Error(`Meadow variant ${v.variantId} continuum is not genus-0 (Euler=${v.genusZeroEuler})`);
    if (!(v.coreTriCount >= 4 && v.coreTriCount <= 6)) throw Error(`Meadow variant ${v.variantId} coreTriCount=${v.coreTriCount} out of 4..6 range`);
  }
  for (const k of ['vertices.bin', 'indices.bin', 'clusters.bin', 'morph.bin']) {
    const f = manifest.files?.[k];
    if (!f || !(f.bytes > 0) || typeof f.sha256 !== 'string' || f.sha256.length !== 64) {
      throw Error(`Meadow grass manifest missing integrity record for ${k}`);
    }
  }
  return manifest;
}

export async function loadMeadowGrass({ assets = PORTUGAL_MEADOW_GRASS_ASSETS, fetchAsset = fetch, signal } = {}) {
  const get = async (name) => {
    const res = await fetchAsset(assets[name], signal ? { signal } : undefined);
    if (!res.ok) throw Error(`Meadow grass asset unavailable (${res.status}): ${name}`);
    return res;
  };
  const manifest = validateMeadowGrass(await (await get('manifest.json')).json());
  const stream = async (name) => {
    const receipt = manifest.files[name];
    const res = await get(`${name}.gz`);
    const bytes = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if (bytes.byteLength !== receipt.bytes) throw Error(`Meadow grass stream size mismatch: ${name}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('');
    if (hex !== receipt.sha256) throw Error(`Meadow grass stream SHA-256 mismatch: ${name}`);
    return bytes;
  };
  const [vertices, indices, clusters, morph] = await Promise.all(['vertices.bin', 'indices.bin', 'clusters.bin', 'morph.bin'].map(stream));
  if (vertices.byteLength !== manifest.vertexCount * MEADOW_VERT_WORDS * 4 ||
      indices.byteLength !== manifest.triangleCount * 3 * 4 ||
      clusters.byteLength !== manifest.clusterCount * MEADOW_CLUSTER_WORDS * 4 ||
      morph.byteLength !== manifest.variantRecords.length * MEADOW_MORPH_VAR_WORDS * 4) {
    throw Error('Meadow grass streams do not match manifest sizes');
  }
  return { manifest, vertices, indices, clusters, morph };
}

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

// 100% loop-free D3D12-safe compute shader on 1.75 m dense near lattice (gid.z == 0)
// seamlessly partitioned into a 6x (10.50 m) outer continuum + horizon-splat ring out to ~782 m (gid.z == 1):
//   - Holds 100% full LOD0 density (cut = 0, retireT = 0) inside ~20 m, then smoothly retires across [0 -> 1 -> 2 -> 3].
//   - Zero loops, zero 90-deg float constants, per-tile slope normal packed into posRot.w via pack2x16snorm.
export const MEADOW_STEP_WGSL = FRAME_WGSL + MEADOW_HASH_GROUND_WGSL + /* wgsl */ `
struct MeadowStepCfg {
  domain: vec4f, // region.x, region.z, region.span, minElev
  params: vec4u, // gridSide, bucketSpan, clustersPerVariant, coverSize
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> cfg: MeadowStepCfg;
@group(0) @binding(2) var<uniform> nearTerrain: MeadowNearDomain;
@group(0) @binding(3) var elevation: texture_2d<f32>;
@group(0) @binding(4) var meadowCover: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> meadowClusters: array<u32>;
@group(0) @binding(6) var<storage, read_write> meadowInstWords: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> meadowDraws: array<atomic<u32>>;

fn meadowCoverBilinear(uv: vec2f, cDim: i32) -> vec4f {
  let lim = max(cDim - 1, 1);
  let q = clamp(uv, vec2f(0.0), vec2f(1.0)) * f32(lim);
  let i0 = min(vec2i(floor(q)), vec2i(max(lim - 1, 0)));
  let f = q - vec2f(i0);
  let c00 = textureLoad(meadowCover, i0, 0);
  let c10 = textureLoad(meadowCover, min(i0 + vec2i(1, 0), vec2i(lim)), 0);
  let c01 = textureLoad(meadowCover, min(i0 + vec2i(0, 1), vec2i(lim)), 0);
  let c11 = textureLoad(meadowCover, min(i0 + vec2i(1, 1), vec2i(lim)), 0);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

fn meadowPush(bucket: u32, posRot: vec4f, attrs: vec4f) {
  let slot = atomicAdd(&meadowDraws[bucket * 4u + 1u], 1u);
  if (slot < cfg.params.y) {
    let base = (bucket * cfg.params.y + slot) * 2u;
    meadowInstWords[base] = posRot;
    meadowInstWords[base + 1u] = attrs;
  }
}

@compute @workgroup_size(8, 1, 1) fn meadowReset(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < ${MEADOW_BUCKETS}u) {
    atomicStore(&meadowDraws[gid.x * 4u + 1u], 0u);
  }
}

@compute @workgroup_size(8, 8, 1) fn meadowSelect(@builtin(global_invocation_id) gid: vec3u) {
  let gridSide = cfg.params.x;
  if (gid.x >= gridSide || gid.y >= gridSide || gid.z >= 2u) { return; }
  let halfGrid = i32(gridSide / 2u);
  let innerMacroR = halfGrid / ${MEADOW_MACRO_MUL};
  let innerCellR = innerMacroR * ${MEADOW_MACRO_MUL};
  let offIJ = vec2i(i32(gid.x) - halfGrid, i32(gid.y) - halfGrid);

  let isMacro = gid.z == 1u;
  if (!isMacro) {
    if (offIJ.x < -innerCellR || offIJ.x >= innerCellR || offIJ.y < -innerCellR || offIJ.y >= innerCellR) { return; }
  } else {
    if (offIJ.x >= -innerMacroR && offIJ.x < innerMacroR && offIJ.y >= -innerMacroR && offIJ.y < innerMacroR) { return; }
  }

  let shiftXZ = nearTerrain.grid.yz;
  let camUnshifted = F.camPos.xz - shiftXZ;
  let unitTileM = ${MEADOW_TILE_METRES.toFixed(4)};
  let macroTileM = ${(MEADOW_TILE_METRES * MEADOW_MACRO_MUL).toFixed(4)};
  let macroCam = vec2i(floor(camUnshifted / macroTileM));

  let tileScale = select(1.0, ${MEADOW_MACRO_MUL}.0, isMacro);
  let tileM = unitTileM * tileScale;
  let cellIJ = select(macroCam * ${MEADOW_MACRO_MUL} + offIJ, macroCam + offIJ, isMacro);
  let seed = meadowHash2(cellIJ ^ select(vec2i(0), vec2i(0x27d4eb2f, 0x165667b1), isMacro));
  let originXZ = vec2f(cellIJ) * tileM;
  let centerXZ = originXZ + vec2f(tileM * 0.5);

  let outerMaxR = f32(halfGrid) * macroTileM - 16.0;
  let horizDist = distance(centerXZ, camUnshifted);
  if (horizDist > outerMaxR) { return; }

  let uv = (centerXZ - cfg.domain.xy) / cfg.domain.z + 0.5;
  if (uv.x <= 0.002 || uv.x >= 0.998 || uv.y <= 0.002 || uv.y >= 0.998) { return; }

  let cDim = i32(cfg.params.w);
  let cov = meadowCoverBilinear(uv, cDim);
  let cOff = (tileM * 0.48) / cfg.domain.z;
  let cPP = meadowCoverBilinear(uv + vec2f(cOff, cOff), cDim).r;
  let cNP = meadowCoverBilinear(uv + vec2f(-cOff, cOff), cDim).r;
  let cPN = meadowCoverBilinear(uv + vec2f(cOff, -cOff), cDim).r;
  let cNN = meadowCoverBilinear(uv + vec2f(-cOff, -cOff), cDim).r;
  let maxCorner = max(max(cPP, cNP), max(cPN, cNN));
  let minCorner = min(min(cov.r, min(cPP, cNP)), min(cPN, cNN));
  let minReq = select(0.020, 0.14, isMacro);
  if (max(cov.r, maxCorner) < minReq) { return; }

  let groundY = meadowGroundY(centerXZ, cfg.domain, elevation);
  if (groundY < cfg.domain.w) { return; }

  let shiftedCenter = vec3f(centerXZ.x + shiftXZ.x, groundY + 0.25, centerXZ.y + shiftXZ.y);
  let rel = earthCurve(shiftedCenter - F.camPos.xyz, F.camPos.y);
  let dist = length(rel);

  let clip = F.viewProj * vec4f(rel, 1.0);
  let margin = tileM * 0.95 + 1.8;
  if (clip.w < -margin) { return; }
  let wGuard = max(clip.w, 0.25) * 1.24 + margin;
  if (abs(clip.x) > wGuard || abs(clip.y) > wGuard) { return; }

  let epsH = max(1.5, tileM * 0.35);
  let hx = (meadowGroundY(centerXZ + vec2f(epsH, 0.0), cfg.domain, elevation) - meadowGroundY(centerXZ - vec2f(epsH, 0.0), cfg.domain, elevation)) / (2.0 * epsH);
  let hz = (meadowGroundY(centerXZ + vec2f(0.0, epsH), cfg.domain, elevation) - meadowGroundY(centerXZ - vec2f(0.0, epsH), cfg.domain, elevation)) / (2.0 * epsH);
  let slopeN = normalize(vec3f(-hx, 1.0, -hz));
  let packedSlope = bitcast<f32>(pack2x16snorm(slopeN.xz));

  let mixJitter = f32((seed >> 24u) & 255u) / 255.0;
  var mixIdx = 0u;
  if (cov.g > 0.72 || (cov.g > 0.35 && mixJitter > 0.65)) {
    mixIdx = 2u;
  } else if (cov.g > 0.24) {
    mixIdx = 1u;
  }
  let variantId = mixIdx * 4u + (seed & 3u);

  let posRot = vec4f(originXZ.x, groundY, originXZ.y, packedSlope);
  let seedF = bitcast<f32>(seed);

  let focal = F.screen.y / max(2.0 * length(F.camUp.xyz), 0.0001);
  let rawUnitSpanPx = (unitTileM * focal) / max(dist, 0.45);
  let innerOrigin = vec2f(macroCam * ${MEADOW_MACRO_MUL}) * unitTileM;
  let boxDist = max(abs(centerXZ.x - innerOrigin.x), abs(centerXZ.y - innerOrigin.y));
  let innerBoxR = f32(innerCellR) * unitTileM;
  let boxFade = smoothstep(innerBoxR - 18.0, innerBoxR - 2.5, boxDist);
  let spanPx = select(
    mix(rawUnitSpanPx, min(rawUnitSpanPx, ${MEADOW_FADE_OUT_PX.toFixed(1)} - 0.25), boxFade),
    min(rawUnitSpanPx, ${MEADOW_FADE_OUT_PX.toFixed(1)} - 0.25),
    isMacro,
  );
  let allowedErr = dist / max(focal, 1.0);
  let vFirst = variantId * 4u;

  if (!isMacro && spanPx >= ${MEADOW_FADE_IN_PX.toFixed(1)}) {
    let e1 = bitcast<f32>(meadowClusters[(vFirst + 1u) * ${MEADOW_CLUSTER_WORDS}u + 4u]);
    let e2 = bitcast<f32>(meadowClusters[(vFirst + 2u) * ${MEADOW_CLUSTER_WORDS}u + 4u]);
    let e3 = bitcast<f32>(meadowClusters[(vFirst + 3u) * ${MEADOW_CLUSTER_WORDS}u + 4u]);
    let lvl = select(select(select(0u, 1u, allowedErr >= e1), 2u, allowedErr >= e2), 3u, allowedErr >= e3);
    let chosen = vFirst + lvl;
    let cb = chosen * ${MEADOW_CLUSTER_WORDS}u;
    let parentErr = bitcast<f32>(meadowClusters[cb + 3u]);
    let selfErr = bitcast<f32>(meadowClusters[cb + 4u]);
    // Hold 100% full LOD0 density inside ~20 m (70% of L0 error band), then smoothly retire sub-blades with zero pop!
    let bandStart = mix(selfErr, parentErr, select(0.28, 0.70, lvl == 0u));
    let levelT = clamp((allowedErr - bandStart) / max(parentErr - bandStart, 0.0005), 0.0, 1.0);
    meadowPush(lvl, posRot, vec4f(bitcast<f32>(chosen), tileScale, levelT, seedF));
    return;
  }

  if (!isMacro && spanPx > ${MEADOW_FADE_OUT_PX.toFixed(1)}) {
    let fade = smoothstep(${MEADOW_FADE_IN_PX.toFixed(1)}, ${MEADOW_FADE_OUT_PX.toFixed(1)}, spanPx);
    let cIdx = vFirst + 3u;
    meadowPush(4u, posRot, vec4f(bitcast<f32>(cIdx), tileScale, fade, seedF));
    meadowPush(5u, posRot, vec4f(bitcast<f32>(variantId), tileScale, fade, seedF));
    return;
  }

  let tileSpanPx = (tileM * focal) / max(dist, 0.45);
  if (tileSpanPx >= ${MEADOW_SPLAT_PX.toFixed(1)}) {
    let uRaw = clamp((${MEADOW_FADE_OUT_PX.toFixed(1)} - spanPx) / ${(MEADOW_FADE_OUT_PX - MEADOW_SPLAT_PX).toFixed(1)}, 0.0, 1.0) * ${MEADOW_MORPH_STEPS}.0;
    // Keep full 5x5 terrain-draped vertex grid on macro-tiles bordering roads, rivers, or steep ridges
    let u = select(uRaw, 0.0, isMacro && minCorner < 0.42);
    let stepIdx = min(${MEADOW_MORPH_STEPS - 1}u, u32(floor(u)));
    let morphT = clamp(u - f32(stepIdx), 0.0, 0.999);
    meadowPush(6u, posRot, vec4f(bitcast<f32>(variantId), tileScale, f32(stepIdx) + morphT, seedF));
    return;
  }

  var inflate = 1.0;
  if (tileSpanPx < ${MEADOW_MIN_PX.toFixed(1)}) {
    let keepProb = clamp(tileSpanPx * tileSpanPx, 0.04, 1.0);
    let uRand = f32(seed & 65535u) / 65536.0;
    if (uRand > keepProb) { return; }
    inflate = min(4.0, inverseSqrt(keepProb));
  }
  meadowPush(7u, posRot, vec4f(bitcast<f32>(variantId), tileScale, inflate, seedF));
}
`;

const MEADOW_COMMON_WGSL = MEADOW_HASH_GROUND_WGSL + LAND_CRATER_SAMPLE_WGSL + /* wgsl */ `
struct MeadowCfg {
  domain: vec4f,            // region.x, region.z, region.span, minElev
  params: vec4u,            // gridSide, bucketSpan, sampleCount, coverSize
  crater: vec4f,            // originX, originZ, tileMetres (8.0), enabled (0 or 1)
  splats: array<vec4f, 24>, // [v*2] = (centreY, rx, ry, coreTris), [v*2+1] = (meanR, meanG, meanB, tileMetres)
};

struct MeadowInst {
  posRot: vec4f,    // tileOriginX, groundY_center, tileOriginZ, bitcast<f32>(pack2x16snorm(slopeNormal.xz))
  attrs: vec4f,     // bitcast<f32>(clusterOrVariant), tileScale, morphParam, bitcast<f32>(seed)
};

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

// Lossless right-handed (det = +1) 90-deg quadrant rotation in XZ: preserves CCW triangle winding & D4 border welds!
fn meadowRotQuadXZ(v: vec2f, q: u32) -> vec2f {
  if (q == 1u) { return vec2f(-v.y, v.x); }
  if (q == 2u) { return vec2f(-v.x, -v.y); }
  if (q == 3u) { return vec2f(v.y, -v.x); }
  return v;
}
`;

export const MEADOW_RENDER_WGSL = FRAME_WGSL + ATMO_CORE_WGSL + SHADOW_FRAME + SKY_RENDER_FUNCS + CLOUD_SAMPLE + MEADOW_COMMON_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var<uniform> cfg: MeadowCfg;
@group(0) @binding(6) var elevation: texture_2d<f32>;
@group(0) @binding(7) var<storage, read> meadowVerts: array<u32>;
@group(0) @binding(8) var<storage, read> meadowIndices: array<u32>;
@group(0) @binding(9) var<storage, read> meadowClusters: array<u32>;
@group(0) @binding(10) var<storage, read> meadowMorph: array<u32>;
@group(0) @binding(11) var<storage, read> meadowInstances: array<MeadowInst>;
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
@group(2) @binding(0) var<uniform> meadowDraw: vec4u; // offsetInst, bucketId, 0, 0

struct MeadowVertexOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) colour: vec3f,
  @location(3) windInfo: vec4f,    // along, gust, swell, fade
  @location(4) tendrilFlow: vec4f, // bentUnshiftedXZ.xy, camDist, distFade
  @location(5) damageInfo: vec2f,  // hotSinge, bendSlope
};

struct MeadowVertexData {
  pos: vec3f,
  nrm: vec3f,
  col: vec3f,
  along: f32,
  stiff: f32,
  wTag: f32,
  tuftRand: f32,
  morphXZ: vec2f,
};

struct MeadowBallisticDeform {
  pushXZ: vec2f,
  pressDown: f32,
  buryDepth: f32,
  hotSinge: f32,
};

fn meadowReadClusterVert(vi: u32) -> MeadowVertexData {
  let b = vi * ${MEADOW_VERT_WORDS}u;
  let rgba = unpack4x8unorm(meadowVerts[b + 4u]);
  let sn = unpack4x8snorm(meadowVerts[b + 3u]);
  let morphXZ = unpack2x16float(meadowVerts[b + 7u]);
  return MeadowVertexData(
    vec3f(bitcast<f32>(meadowVerts[b]), bitcast<f32>(meadowVerts[b + 1u]), bitcast<f32>(meadowVerts[b + 2u])),
    normalize(sn.xyz),
    pow(rgba.rgb, vec3f(2.2)),
    bitcast<f32>(meadowVerts[b + 5u]),
    max(bitcast<f32>(meadowVerts[b + 6u]), 0.8),
    sn.w,
    rgba.a,
    morphXZ,
  );
}

fn meadowMorphRawXZ(vBase: u32, vi: u32) -> vec2f {
  let b = vBase + vi * ${MEADOW_VERT_WORDS}u;
  return vec2f(bitcast<f32>(meadowMorph[b]), bitcast<f32>(meadowMorph[b + 2u]));
}

fn meadowReadMorphVert(vBase: u32, vi: u32, tileScale: f32) -> MeadowVertexData {
  let b = vBase + vi * ${MEADOW_VERT_WORDS}u;
  let rgba = unpack4x8unorm(meadowMorph[b + 4u]);
  let halfTile = ${(MEADOW_TILE_METRES * 0.5).toFixed(4)} * tileScale;
  return MeadowVertexData(
    vec3f(
      bitcast<f32>(meadowMorph[b]) * tileScale + halfTile,
      bitcast<f32>(meadowMorph[b + 1u]),
      bitcast<f32>(meadowMorph[b + 2u]) * tileScale + halfTile,
    ),
    normalize(unpack4x8snorm(meadowMorph[b + 3u]).xyz),
    pow(rgba.rgb, vec3f(2.2)),
    bitcast<f32>(meadowMorph[b + 5u]),
    max(bitcast<f32>(meadowMorph[b + 6u]), 0.8),
    1.0,
    1.0,
    vec2f(0.0),
  );
}

fn meadowDegenerateOut() -> MeadowVertexOut {
  var o: MeadowVertexOut;
  o.pos = vec4f(0.0, 0.0, 0.0, 1.0);
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

fn meadowUnpackSlopeNormal(packedSlopeF: f32) -> vec3f {
  let sxz = unpack2x16snorm(bitcast<u32>(packedSlopeF));
  return normalize(vec3f(sxz.x, sqrt(max(0.04, 1.0 - dot(sxz, sxz))), sxz.y));
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

fn meadowShadePlace(inst: MeadowInst, vd: MeadowVertexData, fadeVal: f32) -> MeadowVertexOut {
  let seed = bitcast<u32>(inst.attrs.w);
  let rotQ = (seed >> 2u) & 3u;
  let tileScale = max(inst.attrs.y, 1.0);
  let halfTile = ${(MEADOW_TILE_METRES * 0.5).toFixed(4)} * tileScale;

  // Per-cell deterministic 90-deg (0/90/180/270) rotation around cell center -> zero grid stripes or seams!
  let rotLocalXZ = meadowRotQuadXZ(vd.pos.xz - vec2f(halfTile), rotQ) + vec2f(halfTile);
  let unshiftedXZ = inst.posRot.xz + rotLocalXZ;
  let groundY = meadowGroundY(unshiftedXZ, cfg.domain, elevation);
  let shiftXZ = nearTerrain.grid.yz;
  let camUnshifted = F.camPos.xz - shiftXZ;
  let horizDist = distance(unshiftedXZ, camUnshifted);
  let camDist = distance(vec3f(unshiftedXZ.x + shiftXZ.x, groundY, unshiftedXZ.y + shiftXZ.y), F.camPos.xyz);

  let vCov = meadowCoverAt(unshiftedXZ);
  let maxOuterR = f32(cfg.params.x / 2u) * ${(MEADOW_TILE_METRES * MEADOW_MACRO_MUL).toFixed(4)} - 16.0;
  let distFade = 1.0 - smoothstep(maxOuterR * 0.80, maxOuterR, horizDist);

  // Strict waterline & submerged terrain exclusion (zero blades on sea, estuaries, or carved inlandWater!)
  let dryLand = step(cfg.domain.w, groundY);

  // Organic ecotone blending along paths, beaches & riverbanks (cover 0.55 -> 0.06):
  // per-clump deterministic hash breaks borders into scattered tussocks & short grazed tufts (scaleY 0.40..1.0)
  // rather than uniform sparse needles!
  let isClusterBlade = vd.tuftRand < 0.995;
  var tuftAlive = smoothstep(0.06, 0.55, vCov.r);
  var ecotoneScaleY = 1.0;
  if (isClusterBlade) {
    let keepFrac = smoothstep(0.06, 0.55, vCov.r);
    let clumpHash = clamp(fract(vd.tuftRand * 1.07 + f32((seed >> 8u) & 255u) / 256.0), 0.04, 0.96);
    tuftAlive = smoothstep(clumpHash - 0.06, clumpHash + 0.06, keepFrac);
    ecotoneScaleY = mix(0.40, 1.0, keepFrac);
  }
  let bladeAlive = tuftAlive * distFade * dryLand;
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
  let marginRetired = max(1.0 - smoothstep(0.03, 0.06, vCov.r * distFade * dryLand), 1.0 - smoothstep(0.02, 0.16, bladeAlive));
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

  // Rotate vertex normals with the 90-deg cell quadrant AND tilt dynamically with the wind bend:
  //   nBent = normalize(nRest - bendDir * bendSlope * 0.85)
  let terrainN = meadowUnpackSlopeNormal(inst.posRot.w);
  let rotNrmXZ = meadowRotQuadXZ(vd.nrm.xz, rotQ);
  let nRest = normalize(vec3f(
    terrainN.x * 0.55 + rotNrmXZ.x * 0.72 - billow.y,
    max(0.32, terrainN.y * 0.65 + vd.nrm.y * 0.68),
    terrainN.z * 0.55 + rotNrmXZ.y * 0.72 - billow.z,
  ));
  let bendSlope = clamp(1.65 * bendSin * pow(max(flexAlong, 0.02), 0.65), 0.0, 0.96) * bladeAlive;
  let bendDir3 = vec3f(bendDir.x, 0.0, bendDir.y);
  let swardN = normalize(nRest - bendDir3 * (bendSlope * 0.85) + vec3f(ballistics.pushXZ.x, 0.0, ballistics.pushXZ.y) * 1.15);
  let bentN = normalize(mix(terrainN, swardN, bladeAlive));

  var o: MeadowVertexOut;
  o.world = world;
  o.normal = bentN;
  o.colour = vd.col;
  o.windInfo = vec4f(vd.along, wind.x, wind.y, fadeVal);
  o.tendrilFlow = vec4f(unshiftedXZ - dispXZ * 0.65, camDist, distFade);
  o.damageInfo = vec2f(ballistics.hotSinge, bendSlope);
  o.pos = F.viewProj * vec4f(earthCurve(world - F.camPos.xyz, F.camPos.y), 1.0);
  return o;
}

@vertex fn meadowClusterVS(@builtin(instance_index) ii: u32, @builtin(vertex_index) vid: u32) -> MeadowVertexOut {
  let inst = meadowInstances[meadowDraw.x + ii];
  let cIdx = bitcast<u32>(inst.attrs.x);
  let cBase = cIdx * ${MEADOW_CLUSTER_WORDS}u;
  let firstIdx = meadowClusters[cBase];
  let idxCount = meadowClusters[cBase + 1u];
  if (vid >= idxCount) { return meadowDegenerateOut(); }
  let vi = meadowIndices[firstIdx + vid];
  var vd = meadowReadClusterVert(vi);
  let isFade = meadowDraw.y == 4u;
  if (!isFade) {
    let levelT = clamp(inst.attrs.z, 0.0, 1.0);
    if (vd.wTag < 0.0) {
      let startT = clamp((-vd.wTag - 0.10) / 0.86, 0.0, 0.56);
      let settle = smoothstep(startT, min(1.0, startT + 0.44), levelT);
      vd.pos = vec3f(
        vd.pos.x + vd.morphXZ.x * settle,
        mix(vd.pos.y, -0.015, settle),
        vd.pos.z + vd.morphXZ.y * settle,
      );
      vd.along = mix(vd.along, 0.0, settle);
    } else {
      vd.pos = vec3f(vd.pos.x + vd.morphXZ.x * levelT, vd.pos.y, vd.pos.z + vd.morphXZ.y * levelT);
    }
  }
  let fadeVal = select(1.0, inst.attrs.z, isFade);
  return meadowShadePlace(inst, vd, fadeVal);
}

// O(1) cumulative vertex ancestor lookup (1 storage read, zero loops):
// unpacks (v0, v1) u8 pair at stepIdx from flat baked u8x4 table in morph.bin!
fn meadowMorphStepRemap(vBase: u32, vi: u32, stepIdx: u32) -> vec2u {
  let e = stepIdx * ${MEADOW_MORPH_VERTS}u + vi;
  let word = meadowMorph[vBase + ${MEADOW_MORPH_REMAP_OFFSET}u + (e >> 1u)];
  let pair = (word >> ((e & 1u) * 16u)) & 0xffffu;
  return vec2u(pair & 0xffu, (pair >> 8u) & 0xffu);
}

fn meadowMorphCornerWorldXZ(originXZ: vec2f, vBase: u32, pair: vec2u, morphT: f32, tileScale: f32, rotQ: u32) -> vec2f {
  let rawXZ = mix(meadowMorphRawXZ(vBase, pair.x), meadowMorphRawXZ(vBase, pair.y), morphT) * tileScale;
  let halfTile = ${(MEADOW_TILE_METRES * 0.5).toFixed(4)} * tileScale;
  return originXZ + meadowRotQuadXZ(rawXZ, rotQ) + vec2f(halfTile);
}

@vertex fn meadowContVS(@builtin(instance_index) ii: u32, @builtin(vertex_index) vid: u32) -> MeadowVertexOut {
  let inst = meadowInstances[meadowDraw.x + ii];
  let variantId = bitcast<u32>(inst.attrs.x);
  let tileScale = max(inst.attrs.y, 1.0);
  let vBase = variantId * ${MEADOW_MORPH_VAR_WORDS}u;
  let face = vid / 3u;
  let corner = vid % 3u;
  let faceBase = vBase + ${MEADOW_MORPH_VERTS * MEADOW_VERT_WORDS}u + face * 3u;

  let isFade = meadowDraw.y == 5u;
  let stepIdx = select(min(${MEADOW_MORPH_STEPS - 1}u, u32(floor(inst.attrs.z))), 0u, isFade);
  let morphT = select(clamp(inst.attrs.z - floor(inst.attrs.z), 0.0, 1.0), 0.0, isFade);

  let rA = meadowMorphStepRemap(vBase, meadowMorph[faceBase], stepIdx);
  let rB = meadowMorphStepRemap(vBase, meadowMorph[faceBase + 1u], stepIdx);
  let rC = meadowMorphStepRemap(vBase, meadowMorph[faceBase + 2u], stepIdx);
  if (rA.x == rB.x || rB.x == rC.x || rC.x == rA.x) { return meadowDegenerateOut(); }

  // Prevent outer macro-continuum triangles from ever spanning onto roads, beaches, or rivers.
  if (tileScale > 1.5) {
    let seed = bitcast<u32>(inst.attrs.w);
    let rotQ = (seed >> 2u) & 3u;
    let wA = meadowMorphCornerWorldXZ(inst.posRot.xz, vBase, rA, morphT, tileScale, rotQ);
    let wB = meadowMorphCornerWorldXZ(inst.posRot.xz, vBase, rB, morphT, tileScale, rotQ);
    let wC = meadowMorphCornerWorldXZ(inst.posRot.xz, vBase, rC, morphT, tileScale, rotQ);
    let minCov = min(meadowCoverAt(wA).r, min(meadowCoverAt(wB).r, meadowCoverAt(wC).r));
    let minGnd = min(
      meadowGroundY(wA, cfg.domain, elevation),
      min(meadowGroundY(wB, cfg.domain, elevation), meadowGroundY(wC, cfg.domain, elevation)),
    );
    if (minCov < 0.14 || minGnd < cfg.domain.w) { return meadowDegenerateOut(); }
  }

  let pair = select(select(rC, rB, corner == 1u), rA, corner == 0u);
  let a = meadowReadMorphVert(vBase, pair.x, tileScale);
  let b = meadowReadMorphVert(vBase, pair.y, tileScale);
  let vd = MeadowVertexData(
    mix(a.pos, b.pos, morphT),
    normalize(mix(a.nrm, b.nrm, morphT)),
    mix(a.col, b.col, morphT),
    mix(a.along, b.along, morphT),
    mix(a.stiff, b.stiff, morphT),
    1.0,
    1.0,
    vec2f(0.0),
  );
  return meadowShadePlace(inst, vd, inst.attrs.z);
}

@vertex fn meadowSplatVS(@builtin(instance_index) ii: u32, @builtin(vertex_index) vid: u32) -> MeadowVertexOut {
  let inst = meadowInstances[meadowDraw.x + ii];
  let variantId = min(11u, bitcast<u32>(inst.attrs.x));
  let tileScale = max(inst.attrs.y, 1.0);
  let sA = cfg.splats[variantId * 2u];
  let sB = cfg.splats[variantId * 2u + 1u];
  let inflate = clamp(inst.attrs.z, 1.0, 4.0);
  let unshiftedCenter = inst.posRot.xz + vec2f(${(MEADOW_TILE_METRES * 0.5).toFixed(4)} * tileScale);
  let shiftXZ = nearTerrain.grid.yz;
  let camUnshifted = F.camPos.xz - shiftXZ;
  let horizDist = distance(unshiftedCenter, camUnshifted);
  let maxOuterR = f32(cfg.params.x / 2u) * ${(MEADOW_TILE_METRES * MEADOW_MACRO_MUL).toFixed(4)} - 16.0;
  let distFade = 1.0 - smoothstep(maxOuterR * 0.80, maxOuterR, horizDist);

  let rx = sA.y * tileScale * inflate;
  let ry = sA.z * inflate;
  let camRightXZ = normalize(select(vec2f(1.0, 0.0), F.camRight.xz, length(F.camRight.xz) > 0.01));
  let camFwdXZ = vec2f(-camRightXZ.y, camRightXZ.x);

  let p0XZ = unshiftedCenter + camFwdXZ * (rx * 1.35);
  let p1XZ = unshiftedCenter - camFwdXZ * (rx * 0.85) - camRightXZ * (rx * 1.45);
  let p2XZ = unshiftedCenter - camFwdXZ * (rx * 0.85) + camRightXZ * (rx * 1.45);
  if (tileScale > 1.5) {
    let minCov = min(meadowCoverAt(p0XZ).r, min(meadowCoverAt(p1XZ).r, meadowCoverAt(p2XZ).r));
    if (minCov < 0.14) { return meadowDegenerateOut(); }
  }

  var sampleXZ = p0XZ;
  var oyBase = ry * 1.75;
  if (vid == 1u) {
    sampleXZ = p1XZ;
    oyBase = 0.0;
  } else if (vid == 2u) {
    sampleXZ = p2XZ;
    oyBase = 0.0;
  }

  let vCov = meadowCoverAt(sampleXZ);
  let groundY0 = meadowGroundY(sampleXZ, cfg.domain, elevation);
  if (groundY0 < cfg.domain.w) { return meadowDegenerateOut(); }
  let coverFade = smoothstep(0.06, 0.55, vCov.r);
  let swardWeight = coverFade * distFade;
  let seed = bitcast<u32>(inst.attrs.w);
  let ballistics = meadowEvalBallistics(sampleXZ, groundY0, seed);
  let edgeTuck = -0.045 * (1.0 - smoothstep(0.03, 0.06, vCov.r * distFade)) - 0.090 * ballistics.buryDepth;

  let wind = meadowWindField(sampleXZ, F.camPos.w, F.windP[0]);
  let rawDir = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let oy = oyBase * swardWeight * (1.0 - ballistics.buryDepth) * (1.0 - ballistics.pressDown * 0.7) + edgeTuck;
  let worldXZ = sampleXZ + windDir * (wind.x * max(0.0, oy) * 0.45) + ballistics.pushXZ * 0.5;
  let groundY = select(groundY0, meadowGroundY(worldXZ, cfg.domain, elevation), length(worldXZ - sampleXZ) > 0.08);
  let camDist = distance(vec3f(worldXZ.x + shiftXZ.x, groundY, worldXZ.y + shiftXZ.y), F.camPos.xyz);

  let terrainN = meadowUnpackSlopeNormal(inst.posRot.w);
  let bendSlope = 0.55 * wind.x * swardWeight;
  let swardN = normalize(terrainN - vec3f(windDir.x, 0.0, windDir.y) * (bendSlope * 0.70) + vec3f(0.0, 0.14, 0.0));

  let world = vec3f(worldXZ.x + shiftXZ.x, groundY + oy, worldXZ.y + shiftXZ.y);
  var o: MeadowVertexOut;
  o.world = world;
  o.normal = normalize(mix(terrainN, swardN, swardWeight));
  o.colour = sB.rgb;
  o.windInfo = vec4f(0.48, wind.x, wind.y, 1.0);
  o.tendrilFlow = vec4f(worldXZ, camDist, distFade);
  o.damageInfo = vec2f(ballistics.hotSinge, bendSlope);
  o.pos = F.viewProj * vec4f(earthCurve(world - F.camPos.xyz, F.camPos.y), 1.0);
  return o;
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
  let isContinuum = meadowDraw.y >= 5u;

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

fn meadowSampleMask(share: f32, pixel: vec2f, samples: u32) -> u32 {
  let full = (1u << samples) - 1u;
  if (share <= 0.0) { return 0u; }
  if (share >= 1.0) { return full; }
  let p = vec2u(pixel);
  let rnd = meadowHash(p.x ^ meadowHash(p.y * 0x9e3779b9u + 0x51ed270bu));
  let cnt = min(samples, u32(floor(share * f32(samples) + f32(rnd & 65535u) / 65536.0)));
  let bits = (1u << cnt) - 1u;
  let rot = (rnd >> 16u) % samples;
  return ((bits << rot) | (bits >> (samples - rot))) & full;
}

struct MeadowCoverageOut {
  @location(0) colour: vec4f,
  @builtin(sample_mask) mask: u32,
};

@fragment fn meadowFS(in: MeadowVertexOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return meadowShade(in, front);
}

@fragment fn meadowClusterFadeFS(in: MeadowVertexOut, @builtin(front_facing) front: bool) -> MeadowCoverageOut {
  let samples = max(1u, cfg.params.z);
  let full = (1u << samples) - 1u;
  let contMask = meadowSampleMask(in.windInfo.w, in.pos.xy, samples);
  var o: MeadowCoverageOut;
  o.colour = meadowShade(in, front);
  o.mask = full & (~contMask);
  return o;
}

@fragment fn meadowContFadeFS(in: MeadowVertexOut, @builtin(front_facing) front: bool) -> MeadowCoverageOut {
  let samples = max(1u, cfg.params.z);
  var o: MeadowCoverageOut;
  o.colour = meadowShade(in, front);
  o.mask = meadowSampleMask(in.windInfo.w, in.pos.xy, samples);
  return o;
}
`;

export function requestMeadowPipelines({ device, shader, format = 'rgba16float', samples = 4 }) {
  return requestOnce(device, `meadow grass ${format} ${samples}`, async () => {
    // Compile sequentially across all pipelines so Windows D3D12 DXC never spikes PSO heap memory.
    const stepMod = await shader(MEADOW_STEP_WGSL, 'meadow grass step');
    const resetPipe = await device.createComputePipelineAsync({
      label: 'meadow reset',
      layout: 'auto',
      compute: { module: stepMod, entryPoint: 'meadowReset' },
    });
    const stepPipe = await device.createComputePipelineAsync({
      label: 'meadow select',
      layout: 'auto',
      compute: { module: stepMod, entryPoint: 'meadowSelect' },
    });
    const renderMod = await shader(MEADOW_RENDER_WGSL, 'meadow grass render');
    const depth = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' };
    const mkPipe = (label, vs, fs, cullMode = 'none') => device.createRenderPipelineAsync({
      label,
      layout: 'auto',
      vertex: { module: renderMod, entryPoint: vs },
      fragment: { module: renderMod, entryPoint: fs, targets: [{ format }] },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode },
      depthStencil: depth,
      multisample: { count: samples },
    });
    const clusterPipe = await mkPipe('meadow clusters', 'meadowClusterVS', 'meadowFS', 'none');
    const clusterFadePipe = await mkPipe('meadow cluster fade', 'meadowClusterVS', 'meadowClusterFadeFS', 'none');
    // Closed genus-0 sculpted continuum uses cullMode: 'back' so underground bottom cap faces are 100% hardware-culled!
    const contFadePipe = await mkPipe('meadow continuum fade', 'meadowContVS', 'meadowContFadeFS', 'back');
    const contSolidPipe = await mkPipe('meadow continuum solid', 'meadowContVS', 'meadowFS', 'back');
    const splatPipe = await mkPipe('meadow splat', 'meadowSplatVS', 'meadowFS', 'none');
    return [stepPipe, clusterPipe, clusterFadePipe, contFadePipe, contSolidPipe, splatPipe, resetPipe];
  });
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
  if (!pack?.vertices?.byteLength || !pack?.indices?.byteLength || !pack?.clusters?.byteLength || !pack?.morph?.byteLength) {
    return null;
  }
  const B = GPUBufferUsage;
  const mkBuf = (label, data, usage) => {
    const buf = device.createBuffer({ label, size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST });
    if (data.byteLength) device.queue.writeBuffer(buf, 0, data);
    return buf;
  };

  const [stepPipe, clusterPipe, clusterFadePipe, contFadePipe, contSolidPipe, splatPipe, resetPipe] = await requestMeadowPipelines({
    device,
    shader,
    format,
    samples,
  });

  const gridSide = isMobile ? MEADOW_GRID_SIDE_MOBILE : MEADOW_GRID_SIDE_DESKTOP;
  const maxMeadowDist = (gridSide * 0.5) * MEADOW_TILE_METRES * MEADOW_MACRO_MUL - 16.0;
  const vertsBuf = mkBuf('meadow verts', pack.vertices, B.STORAGE);
  const idxBuf = mkBuf('meadow indices', pack.indices, B.STORAGE);
  const clusterBuf = mkBuf('meadow clusters', pack.clusters, B.STORAGE);
  const morphBuf = mkBuf('meadow morph', pack.morph, B.STORAGE);
  const instancesBuf = device.createBuffer({
    label: 'meadow instances',
    size: MEADOW_BUCKETS * MEADOW_BUCKET_SPAN * MEADOW_INST_FLOATS * 4,
    usage: B.STORAGE,
  });

  const clU32 = new Uint32Array(pack.clusters.buffer, pack.clusters.byteOffset, Math.floor(pack.clusters.byteLength / 4));
  const lvlMaxIdx = [13500, 6600, 3000, 1200];
  for (let i = 0; i + MEADOW_CLUSTER_WORDS <= clU32.length; i += MEADOW_CLUSTER_WORDS) {
    const idxCnt = clU32[i + 1];
    const lvl = Math.min(3, clU32[i + 2]);
    if (idxCnt > lvlMaxIdx[lvl]) lvlMaxIdx[lvl] = idxCnt;
  }
  const bucketCaps = [
    lvlMaxIdx[0],
    lvlMaxIdx[1],
    lvlMaxIdx[2],
    lvlMaxIdx[3],
    lvlMaxIdx[3],
    MEADOW_MORPH_FACES * 3,
    MEADOW_MORPH_FACES * 3,
    3,
  ];
  const drawTemplate = new Uint32Array(MEADOW_BUCKETS * MEADOW_DRAW_WORDS);
  for (let b = 0; b < MEADOW_BUCKETS; b++) drawTemplate[b * MEADOW_DRAW_WORDS] = bucketCaps[b];
  const drawsBuf = mkBuf('meadow draws', drawTemplate, B.STORAGE | B.INDIRECT);

  const stepCfgData = new ArrayBuffer(32);
  const stepCfgF = new Float32Array(stepCfgData);
  const stepCfgU = new Uint32Array(stepCfgData);

  // MeadowCfg = domain(16) + params(16) + crater(16) + splats(24 * 16) = 432 bytes
  const cfgBufData = new ArrayBuffer((3 + 24) * 16);
  const cfgF = new Float32Array(cfgBufData);
  const cfgU = new Uint32Array(cfgBufData);

  let boundCraters = null;
  let unsubscribeCraters = null;

  const syncCraterCfg = () => {
    const orig = boundCraters?.regionOrigin;
    cfgF[8] = orig ? orig[0] : (region.x - region.span * 0.5);
    cfgF[9] = orig ? orig[1] : (region.z - region.span * 0.5);
    cfgF[10] = LAND_CRATER_TILE_M;
    cfgF[11] = boundCraters?.fieldTexture && boundCraters?.lookupTexture ? 1.0 : 0.0;
  };

  const writeRegionCfg = (reg) => {
    stepCfgF[0] = reg.x;
    stepCfgF[1] = reg.z;
    stepCfgF[2] = reg.span;
    stepCfgF[3] = 0.75;
    stepCfgU[4] = gridSide;
    stepCfgU[5] = MEADOW_BUCKET_SPAN;
    stepCfgU[6] = 4;
    stepCfgU[7] = coverSize;

    cfgF[0] = reg.x;
    cfgF[1] = reg.z;
    cfgF[2] = reg.span;
    cfgF[3] = 0.75;
    cfgU[4] = gridSide;
    cfgU[5] = MEADOW_BUCKET_SPAN;
    cfgU[6] = samples;
    cfgU[7] = coverSize;
    syncCraterCfg();
  };
  writeRegionCfg(region);
  for (let v = 0; v < 12; v++) {
    const rec = pack.manifest.variantRecords[v];
    const base = 12 + v * 8;
    cfgF[base] = rec.splat.centreY;
    cfgF[base + 1] = rec.splat.rx;
    cfgF[base + 2] = rec.splat.ry;
    cfgF[base + 3] = rec.coreTriCount;
    cfgF[base + 4] = rec.splat.meanCol[0];
    cfgF[base + 5] = rec.splat.meanCol[1];
    cfgF[base + 6] = rec.splat.meanCol[2];
    cfgF[base + 7] = pack.manifest.tileMetres;
  }
  const stepCfgBuf = mkBuf('meadow step cfg', new Uint8Array(stepCfgData), B.UNIFORM);
  const cfgBuf = mkBuf('meadow cfg', new Uint8Array(cfgBufData), B.UNIFORM);

  // 1040-byte MeadowWakeFrame uniform buffer + zero-alloc CPU packing views
  const wakeData = new ArrayBuffer(MEADOW_WAKE_BUFFER_BYTES);
  const wakeU32 = new Uint32Array(wakeData);
  const wakeF32 = new Float32Array(wakeData);
  const wakeBuf = mkBuf('meadow ballistic wakes', new Uint8Array(wakeData), B.UNIFORM);
  let wakesWereEmpty = true;

  // 1x1 fallback crater textures when no craters are bound or before first impact allocates fieldTexture
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

  const bucketUniforms = [];
  for (let b = 0; b < MEADOW_BUCKETS; b++) {
    bucketUniforms.push(mkBuf(`meadow bucket ${b}`, new Uint32Array([b * MEADOW_BUCKET_SPAN, b, 0, 0]), B.UNIFORM));
  }

  let activeResources = resources;
  let stepGroup = null;
  const resetGroup = device.createBindGroup({
    label: 'meadow reset group',
    layout: resetPipe.getBindGroupLayout(0),
    entries: [{ binding: 7, resource: { buffer: drawsBuf } }],
  });
  const pipeGroups = new Map();
  const pipeCloudGroups = new Map();
  const bucketBindGroups = new Map();

  const CLOUD_PIPES = [clusterPipe, clusterFadePipe, contFadePipe, contSolidPipe, splatPipe];
  for (const pipe of CLOUD_PIPES) {
    pipeCloudGroups.set(pipe, clouds.bindVolume(pipe));
  }

  function buildPipeBindGroups(resList) {
    pipeGroups.clear();
    bucketBindGroups.clear();
    const resMap = new Map(resList);
    const elevationView = elevation.createView();
    const coverView = coverTexture.createView();
    const craterLookupView = (boundCraters?.lookupTexture ?? fallbackCraterLookup).createView();
    const craterFieldView = (boundCraters?.fieldTexture ?? fallbackCraterField).createView({ dimension: '2d-array' });
    const extraMap = new Map([
      [5, { buffer: cfgBuf }],
      [6, elevationView],
      [7, { buffer: vertsBuf }],
      [8, { buffer: idxBuf }],
      [9, { buffer: clusterBuf }],
      [10, { buffer: morphBuf }],
      [11, { buffer: instancesBuf }],
      [12, { buffer: nearDomain }],
      [13, { buffer: wakeBuf }],
      [14, craterLookupView],
      [15, resMap.get(5)],
      [16, coverView],
      [17, resMap.get(7)],
      [18, resMap.get(8)],
      [22, craterFieldView],
    ]);
    const getRes = (id) => extraMap.get(id) ?? resMap.get(id);

    stepGroup = device.createBindGroup({
      label: 'meadow select group',
      layout: stepPipe.getBindGroupLayout(0),
      entries: [
        [0, getRes(0)],
        [1, { buffer: stepCfgBuf }],
        [2, getRes(12)],
        [3, elevationView],
        [4, coverView],
        [5, { buffer: clusterBuf }],
        [6, { buffer: instancesBuf }],
        [7, { buffer: drawsBuf }],
      ].map(([binding, resource]) => ({ binding, resource })),
    });

    const pipeSpecs = [
      [clusterPipe, 'meadow cluster', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], [0, 1, 2, 3]],
      [clusterFadePipe, 'meadow cluster fade', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], [4]],
      [contFadePipe, 'meadow cont fade', [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], [5]],
      [contSolidPipe, 'meadow cont solid', [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], [6]],
      [splatPipe, 'meadow splat', [0, 1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], [7]],
    ];
    for (const [pipe, name, ids, buckets] of pipeSpecs) {
      pipeGroups.set(pipe, device.createBindGroup({
        label: `${name} group0`,
        layout: pipe.getBindGroupLayout(0),
        entries: ids.map((id) => ({ binding: id, resource: getRes(id) })),
      }));
      const bLayout = pipe.getBindGroupLayout(2);
      for (const b of buckets) {
        bucketBindGroups.set(b, device.createBindGroup({
          label: `${name} bucket ${b}`,
          layout: bLayout,
          entries: [{ binding: 0, resource: { buffer: bucketUniforms[b] } }],
        }));
      }
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
  let worldOffX = 0, worldOffZ = 0;
  let covMinX = -Infinity, covMaxX = Infinity, covMinZ = -Infinity, covMaxZ = Infinity;
  const coarseMaxCover = new Uint8Array(MEADOW_COARSE_GRID * MEADOW_COARSE_GRID);
  const coarseMinY = new Float32Array(MEADOW_COARSE_GRID * MEADOW_COARSE_GRID);
  const coarseMaxY = new Float32Array(MEADOW_COARSE_GRID * MEADOW_COARSE_GRID);
  let lastEncodeActive = true;

  function isCameraInMeadowRange(camOrFrame = null, viewProjArg = null) {
    if (!coverTexels) return false;
    let camX = NaN, camY = NaN, camZ = NaN;
    let vp = viewProjArg && viewProjArg.length >= 16 ? viewProjArg : null;
    if (camOrFrame) {
      if ((camOrFrame instanceof Float32Array || Array.isArray(camOrFrame)) && camOrFrame.length >= 19) {
        camX = camOrFrame[16];
        camY = camOrFrame[17];
        camZ = camOrFrame[18];
        if (!vp) vp = camOrFrame;
      } else if (typeof camOrFrame === 'object') {
        camX = Number(camOrFrame.x ?? camOrFrame[0]);
        camY = Number(camOrFrame.y ?? camOrFrame[1] ?? 6);
        camZ = Number(camOrFrame.z ?? camOrFrame[2]);
      }
    }
    if (!Number.isFinite(camX) || !Number.isFinite(camZ)) return true;
    const ux = camX - worldOffX;
    const uz = camZ - worldOffZ;
    const reach = maxMeadowDist + 60.0;
    if (ux < covMinX - reach || ux > covMaxX + reach || uz < covMinZ - reach || uz > covMaxZ + reach) {
      return false;
    }

    const span = curRegion.span;
    const rx0 = curRegion.x - span * 0.5;
    const rz0 = curRegion.z - span * 0.5;
    const cellM = span / MEADOW_COARSE_GRID;
    const invCell = MEADOW_COARSE_GRID / span;
    const ci0 = Math.max(0, Math.floor((ux - reach - rx0) * invCell));
    const ci1 = Math.min(MEADOW_COARSE_GRID - 1, Math.floor((ux + reach - rx0) * invCell));
    const cj0 = Math.max(0, Math.floor((uz - reach - rz0) * invCell));
    const cj1 = Math.min(MEADOW_COARSE_GRID - 1, Math.floor((uz + reach - rz0) * invCell));
    if (ci0 > ci1 || cj0 > cj1) return false;

    const reachSq = reach * reach;
    let hasNearby = false;
    let lMinX = Infinity, lMaxX = -Infinity, lMinY = Infinity, lMaxY = -Infinity, lMinZ = Infinity, lMaxZ = -Infinity;
    for (let cj = cj0; cj <= cj1; cj++) {
      const cz0 = rz0 + cj * cellM, cz1 = cz0 + cellM;
      const dz = Math.max(cz0 - uz, 0, uz - cz1);
      const dzSq = dz * dz;
      if (dzSq > reachSq) continue;
      const row = cj * MEADOW_COARSE_GRID;
      for (let ci = ci0; ci <= ci1; ci++) {
        if (!coarseMaxCover[row + ci]) continue;
        const cx0 = rx0 + ci * cellM, cx1 = cx0 + cellM;
        const dx = Math.max(cx0 - ux, 0, ux - cx1);
        if (dx * dx + dzSq > reachSq) continue;
        hasNearby = true;
        if (cx0 < lMinX) lMinX = cx0;
        if (cx1 > lMaxX) lMaxX = cx1;
        if (cz0 < lMinZ) lMinZ = cz0;
        if (cz1 > lMaxZ) lMaxZ = cz1;
        const cMinY = coarseMinY[row + ci], cMaxY = coarseMaxY[row + ci];
        if (cMinY < lMinY) lMinY = cMinY;
        if (cMaxY > lMaxY) lMaxY = cMaxY;
      }
    }
    if (!hasNearby) return false;

    // Safe vertical altitude check: above 3.2 km over highest nearby grass ground, macro-tiles are sub-0.3 px and blend into landAlbedo.
    if (Number.isFinite(camY) && camY - lMaxY > Math.max(maxMeadowDist * 3.5, 2800)) {
      return false;
    }

    // Safe conservative frustum sphere check against nearby covered meadow AABB
    if (vp && Number.isFinite(camY)) {
      const boxMinY = lMinY - 32.0, boxMaxY = lMaxY + 18.0;
      const cx = (lMinX + lMaxX) * 0.5 + worldOffX;
      const cy = (boxMinY + boxMaxY) * 0.5;
      const cz = (lMinZ + lMaxZ) * 0.5 + worldOffZ;
      const rad = Math.hypot(lMaxX - lMinX, boxMaxY - boxMinY, lMaxZ - lMinZ) * 0.5 + 24.0;
      const rx = cx - camX, ry = cy - camY, rz = cz - camZ;
      const isCamRel = Math.abs(vp[12]) < 1e-4 && Math.abs(vp[13]) < 1e-4 && Math.abs(vp[15]) < 1e-4;
      const px = isCamRel ? rx : cx, py = isCamRel ? ry : cy, pz = isCamRel ? rz : cz;
      const clipX = vp[0] * px + vp[4] * py + vp[8] * pz + vp[12];
      const clipY = vp[1] * px + vp[5] * py + vp[9] * pz + vp[13];
      const clipW = vp[3] * px + vp[7] * py + vp[11] * pz + vp[15];
      if (clipW < -rad * Math.hypot(vp[3], vp[7], vp[11])) return false;
      if (clipW + clipX < -rad * Math.hypot(vp[3] + vp[0], vp[7] + vp[4], vp[11] + vp[8])) return false;
      if (clipW - clipX < -rad * Math.hypot(vp[3] - vp[0], vp[7] - vp[4], vp[11] - vp[8])) return false;
      if (clipW + clipY < -rad * Math.hypot(vp[3] + vp[1], vp[7] + vp[5], vp[11] + vp[9])) return false;
      if (clipW - clipY < -rad * Math.hypot(vp[3] - vp[1], vp[7] - vp[5], vp[11] - vp[9])) return false;
    }
    return true;
  }

  function sync(next = {}) {
    if (next.region !== undefined) curRegion = next.region;
    if (next.heights !== undefined) curHeights = next.heights;
    if (next.biome !== undefined) curBiome = next.biome;
    if (next.beaches !== undefined) curBeaches = next.beaches;
    if (next.port !== undefined) curPort = next.port;
    if (next.city !== undefined) curCity = next.city;
    if (next.board !== undefined) curBoard = next.board;
    if (next.inlandWater !== undefined) curInlandWater = next.inlandWater;
    writeRegionCfg(curRegion);
    device.queue.writeBuffer(stepCfgBuf, 0, stepCfgData, 0, 32);
    device.queue.writeBuffer(cfgBuf, 0, cfgBufData, 0, 48);
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
    coverTexels = 0;
    coarseMaxCover.fill(0);
    coarseMinY.fill(Infinity);
    coarseMaxY.fill(-Infinity);
    covMinX = Infinity; covMaxX = -Infinity; covMinZ = Infinity; covMaxZ = -Infinity;
    const span = curRegion.span;
    const rx0 = curRegion.x - span * 0.5, rz0 = curRegion.z - span * 0.5;
    const step = span / coverSize;
    const hN = curRegion.size || Math.round(Math.sqrt(curHeights?.length || 0));
    const hasH = hN >= 2 && curHeights?.length >= hN * hN;
    for (let j = 0; j < coverSize; j++) {
      const cj = Math.min(MEADOW_COARSE_GRID - 1, Math.floor((j * MEADOW_COARSE_GRID) / coverSize));
      const wz = rz0 + (j + 0.5) * step;
      const hj = hasH ? Math.min(hN - 1, Math.floor(((j + 0.5) / coverSize) * (hN - 1))) * hN : 0;
      const row = j * coverSize;
      for (let i = 0; i < coverSize; i++) {
        const r = map[(row + i) * 4];
        if (r >= 32) coverTexels++;
        if (r >= 5) {
          const wx = rx0 + (i + 0.5) * step;
          if (wx < covMinX) covMinX = wx;
          if (wx > covMaxX) covMaxX = wx;
          if (wz < covMinZ) covMinZ = wz;
          if (wz > covMaxZ) covMaxZ = wz;
          const ci = Math.min(MEADOW_COARSE_GRID - 1, Math.floor((i * MEADOW_COARSE_GRID) / coverSize));
          const cIdx = cj * MEADOW_COARSE_GRID + ci;
          if (r > coarseMaxCover[cIdx]) coarseMaxCover[cIdx] = r;
          const gy = hasH
            ? curHeights[hj + Math.min(hN - 1, Math.floor(((i + 0.5) / coverSize) * (hN - 1)))]
            : 0;
          if (gy < coarseMinY[cIdx]) coarseMinY[cIdx] = gy;
          if (gy > coarseMaxY[cIdx]) coarseMaxY[cIdx] = gy;
        }
      }
    }
    for (let k = 0; k < coarseMaxCover.length; k++) {
      if (!coarseMaxCover[k]) {
        coarseMinY[k] = 0;
        coarseMaxY[k] = 0;
      }
    }
    device.queue.writeTexture({ texture: coverTexture }, map, { bytesPerRow: coverSize * 4 }, [coverSize, coverSize]);
  }

  function bindCraters(nextCraters = null) {
    unsubscribeCraters?.();
    unsubscribeCraters = null;
    boundCraters = nextCraters || null;
    const applyCraterBinding = () => {
      syncCraterCfg();
      device.queue.writeBuffer(cfgBuf, 32, cfgBufData, 32, 16);
      buildPipeBindGroups(activeResources);
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
  if (craters) {
    bindCraters(craters);
  } else {
    buildPipeBindGroups(activeResources);
  }

  const DRAW_ORDER = [
    [clusterPipe, [0, 1, 2, 3]],
    [clusterFadePipe, [4]],
    [contFadePipe, [5]],
    [contSolidPipe, [6]],
    [splatPipe, [7]],
  ];

  return {
    stats: {
      loaded: true,
      style: pack.manifest.style ?? 'botanical-tussock-continuum',
      variants: pack.manifest.variantRecords.length,
      clusters: pack.manifest.clusterCount,
      triangles: pack.manifest.triangleCount,
      gridSide,
      coverSize,
      get coveredTexels() { return coverTexels; },
    },
    sync,
    bindCraters,
    setBallisticWakes,
    setWorldOffset(dx = 0, dz = 0) {
      worldOffX = Number.isFinite(dx) ? dx : 0;
      worldOffZ = Number.isFinite(dz) ? dz : 0;
    },
    rebind(nextResources) {
      activeResources = nextResources;
      buildPipeBindGroups(activeResources);
    },
    encode(pass, camOrFrame = null, viewProjArg = null) {
      if (!isCameraInMeadowRange(camOrFrame, viewProjArg)) {
        lastEncodeActive = false;
        return;
      }
      lastEncodeActive = true;
      pass.setPipeline(resetPipe);
      pass.setBindGroup(0, resetGroup);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(stepPipe);
      pass.setBindGroup(0, stepGroup);
      const groups = Math.ceil(gridSide / 8);
      pass.dispatchWorkgroups(groups, groups, 2);
    },
    draw(pass, camOrFrame = null, viewProjArg = null) {
      if (!coverTexels || !lastEncodeActive) return;
      if (camOrFrame && !isCameraInMeadowRange(camOrFrame, viewProjArg)) return;
      for (const [pipe, buckets] of DRAW_ORDER) {
        pass.setPipeline(pipe);
        pass.setBindGroup(0, pipeGroups.get(pipe));
        pass.setBindGroup(1, pipeCloudGroups.get(pipe));
        for (const b of buckets) {
          pass.setBindGroup(2, bucketBindGroups.get(b));
          pass.drawIndirect(drawsBuf, b * 16);
        }
      }
    },
    drawOpaque(pass, camOrFrame = null, viewProjArg = null) {
      this.draw(pass, camOrFrame, viewProjArg);
    },
    destroy() {
      unsubscribeCraters?.();
      unsubscribeCraters = null;
      boundCraters = null;
      vertsBuf.destroy();
      idxBuf.destroy();
      clusterBuf.destroy();
      morphBuf.destroy();
      instancesBuf.destroy();
      drawsBuf.destroy();
      stepCfgBuf.destroy();
      cfgBuf.destroy();
      wakeBuf.destroy();
      fallbackCraterLookup.destroy();
      fallbackCraterField.destroy();
      coverTexture.destroy();
      for (const b of bucketUniforms) b.destroy();
    },
  };
}
