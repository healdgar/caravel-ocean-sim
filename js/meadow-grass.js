// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// 100% GPU Nanite-style meadow grasses: 4-level seamless overlap turf + wavy tendrils DAG,
// MSAA sample_mask handoff into a full-footprint genus-0 progressive collapse continuum,
// 3D footprint-preserving 1-triangle horizon splats, 4 m anti-aliased SDF water/road/building masking,
// and world-space billowing wind waves fused continuously into terrain lighting.
import { requestOnce } from './gpu-program-cache.js';
import { FRAME_WGSL, ATMO_CORE_WGSL } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { CLOUD_SAMPLE } from './wgsl/clouds.js';
import { SHADOW_FRAME } from './wgsl/shadows.js';
import { terrainSurfaceSample } from './terrain-model.js';
import { CITY_BLOCK_FLOATS, CITY_GROUND } from './old-world-city.js';
import { INLAND_WATER_FLOATS } from './wgsl/inland-water.js';

export const MEADOW_TILE_METRES = 1.35;
export const MEADOW_FADE_IN_PX = 18.0;
export const MEADOW_FADE_OUT_PX = 11.5;
export const MEADOW_SPLAT_PX = 3.5;
export const MEADOW_MIN_PX = 1.0;
export const MEADOW_BUCKETS = 8;
export const MEADOW_DRAW_WORDS = 4;
const MEADOW_INST_FLOATS = 8;
const MEADOW_VERT_WORDS = 8;
const MEADOW_CLUSTER_WORDS = 12;
const MEADOW_MORPH_VERTS = 22;
const MEADOW_MORPH_FACES = 40;
const MEADOW_MORPH_STEPS = 17;
const MEADOW_MORPH_VAR_WORDS = 364; // 22*8 + 40*3 + 17*4 = 364 words = 1456 bytes
const MEADOW_GRID_SIDE_DESKTOP = 320;
const MEADOW_GRID_SIDE_MOBILE = 176;
const MEADOW_BUCKET_SPAN = 16384;
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
  if (!m || m.vertexCount !== MEADOW_MORPH_VERTS || m.faceCount !== MEADOW_MORPH_FACES || m.steps !== MEADOW_MORPH_STEPS || m.bytesPerVariant !== MEADOW_MORPH_VAR_WORDS * 4) {
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
// R = cover (0..255), G = mix (0 pasture, 128 waste, 255 field-margin), B = height modulation (0..255), A = 255.
// Stage A evaluates smooth countryside topography/biome/urban fields on a <=512 grid and bilinearly upsamples;
// Stage B rasterizes exact analytical SDF capsules, triangles, ellipses, and rotated OBBs for ALL rivers, streams,
// canals, ponds, rendered inlandWater meshes, roads, village lanes, streets, bridges, squares, and buildings/cottages.
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

  // Stage A: Smooth base countryside density (continuous across scattered trees/pastures; zero 16 m square holes!)
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
      // Keep full continuous meadow grass around lone trees, olive groves, and open copses;
      // taper smoothly only inside deep closed-canopy dark woods (marked > 175..245).
      const forestFade = parkBonus ? 1.0 : 1.0 - smooth01(175, 245, marked);
      if (forestFade <= 0.005) continue;

      const n1 = valueNoise2D(wx * 0.018, wz * 0.018);
      const n2 = valueNoise2D(wx * 0.062 + 17.3, wz * 0.062 - 9.1);
      const patch = 0.82 + 0.18 * (n1 * 0.65 + n2 * 0.35);

      let dens = (0.84 + 0.16 * n1) * patch * slopeFade * forestFade * dryFade * swashFade * urbanFade;
      let mixVal = 0;
      let hScale = 172;
      if (parkBonus) {
        dens = Math.max(dens, 0.92 * dryFade * swashFade);
        mixVal = 210;
        hScale = 182;
      } else if (slope > 0.24 || y > 185) {
        mixVal = 128;
        hScale = 142;
      } else if (marked >= 68) {
        mixVal = 255;
        hScale = 192;
      } else {
        mixVal = n2 > 0.58 ? 255 : 0;
        hScale = 176;
      }

      baseR[idx] = Math.max(0, Math.min(255, dens * 255));
      baseG[idx] = mixVal;
      baseB[idx] = Math.max(0, Math.min(255, hScale * (0.88 + 0.24 * n2)));
    }
  }

  // Upsample smooth base onto full `size x size` grid + enforce exact 4 m coastal shoreline clearance
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

  // Stage B: Exact 4 m analytical SDF carving for all water bodies, roads, lanes, bridges, squares, and buildings!
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

  // 4. Exact triangle + edge-pad rasterization of EVERY rendered inlandWater mesh triangle (confluences, rapids, leats)
  const iwVerts = inlandWater?.vertices, iwIdx = inlandWater?.indices;
  if (iwVerts?.length >= INLAND_WATER_FLOATS * 3 && iwIdx?.length >= 3) {
    const padClear = Math.max(3.6, step * 0.92), featherR = 4.4, padMax = padClear + featherR;
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
  } else if (port?.streets?.samples?.length >= 4) {
    const s = port.streets.samples;
    for (let k = 0; k + 3 < s.length; k += 4) {
      const sx = s[k], sz = s[k + 2], hw = Math.max(2.0, s[k + 3] || 2.5);
      if (k + 7 < s.length && Math.hypot(s[k + 4] - sx, s[k + 6] - sz) < 18) {
        carveTaperedCapsule(sx, sz, hw, s[k + 4], s[k + 6], Math.max(2.0, s[k + 7] || 2.5), 0.8, 2.4, 0);
      } else {
        carveTaperedCapsule(sx, sz, hw, sx, sz, hw, 0.8, 2.4, 0);
      }
    }
  }

  // Bridges from either activeBoard or port.country
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

// Compact, 100% loop-free D3D12-safe compute shader: 1 thread = 1 seamless overlap turf+tendrils tile,
// 32-byte uniform, bilinear + 4-corner riverbank survival test, continuous world-space wind-lay orientation,
// and smooth radial continuum culling (zero square grid boundary, zero 16 m blocks, zero D3D12 PSO spike).
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

fn meadowCoverTapR(uv: vec2f, cDim: i32) -> f32 {
  let lim = max(cDim - 1, 1);
  let tc = clamp(vec2i(uv * f32(cDim)), vec2i(0), vec2i(lim));
  return textureLoad(meadowCover, tc, 0).r;
}

fn meadowPush(bucket: u32, posRot: vec4f, attrs: vec4f) {
  let slot = atomicAdd(&meadowDraws[bucket * 4u + 1u], 1u);
  if (slot < cfg.params.y) {
    let base = (bucket * cfg.params.y + slot) * 2u;
    meadowInstWords[base] = posRot;
    meadowInstWords[base + 1u] = attrs;
  }
}

@compute @workgroup_size(8, 8) fn meadowSelect(@builtin(global_invocation_id) gid: vec3u) {
  let gridSide = cfg.params.x;
  if (gid.x >= gridSide || gid.y >= gridSide) { return; }
  let halfGrid = i32(gridSide / 2u);
  let shiftXZ = nearTerrain.grid.yz;
  let camUnshifted = F.camPos.xz - shiftXZ;
  let camCell = vec2i(floor(camUnshifted / ${MEADOW_TILE_METRES}));
  let cellIJ = camCell + vec2i(i32(gid.x) - halfGrid, i32(gid.y) - halfGrid);

  let seed = meadowHash2(cellIJ);
  // Subtle 0.12 m cell jitter keeps tendril roots organic while preserving 100% overlap of the 2.12 m turf plateau
  let jx = (f32((seed >> 8u) & 255u) / 255.0 - 0.5) * 0.12;
  let jz = (f32((seed >> 16u) & 255u) / 255.0 - 0.5) * 0.12;
  let originXZ = vec2f(cellIJ) * ${MEADOW_TILE_METRES} + vec2f(jx, jz);
  let centerXZ = originXZ + vec2f(${MEADOW_TILE_METRES * 0.5});

  // Circular continuum radius strictly inside the square grid so no outer square boundary is ever visible
  let maxRadius = f32(gridSide) * ${0.5 * MEADOW_TILE_METRES} - 12.0;
  let horizDist = distance(centerXZ, camUnshifted);
  if (horizDist > maxRadius + 2.0) { return; }

  let uv = (centerXZ - cfg.domain.xy) / cfg.domain.z + 0.5;
  if (uv.x <= 0.002 || uv.x >= 0.998 || uv.y <= 0.002 || uv.y >= 0.998) { return; }

  let cDim = i32(cfg.params.w);
  let cov = meadowCoverBilinear(uv, cDim);
  let cOff = 0.68 / cfg.domain.z;
  let maxCorner = max(
    max(meadowCoverTapR(uv + vec2f(cOff, cOff), cDim), meadowCoverTapR(uv + vec2f(-cOff, cOff), cDim)),
    max(meadowCoverTapR(uv + vec2f(cOff, -cOff), cDim), meadowCoverTapR(uv + vec2f(-cOff, -cOff), cDim)),
  );
  if (max(cov.r, maxCorner) < 0.015) { return; }

  let groundY = meadowGroundY(centerXZ, cfg.domain, elevation);
  if (groundY < cfg.domain.w) { return; }

  let shiftedCenter = vec3f(centerXZ.x + shiftXZ.x, groundY + 0.25, centerXZ.y + shiftXZ.y);
  let rel = earthCurve(shiftedCenter - F.camPos.xyz, F.camPos.y);
  let dist = length(rel);

  let clip = F.viewProj * vec4f(rel, 1.0);
  let margin = 2.25;
  if (clip.w < -margin) { return; }
  let wGuard = max(clip.w, 0.25) * 1.22 + margin;
  if (abs(clip.x) > wGuard || abs(clip.y) > wGuard) { return; }

  let mixJitter = f32((seed >> 24u) & 255u) / 255.0;
  var mixIdx = 0u;
  if (cov.g > 0.72 || (cov.g > 0.35 && mixJitter > 0.65)) {
    mixIdx = 2u;
  } else if (cov.g > 0.24) {
    mixIdx = 1u;
  }
  let variantId = mixIdx * 4u + (seed & 3u);

  // Continuous world-space wind-lay stream orientation (zero 90-degree parquet tile rotations!)
  let rawWind = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawWind), dot(rawWind, rawWind) > 0.0004);
  let swirl = 0.32 * sin(centerXZ.x * 0.047 + cos(centerXZ.y * 0.041) * 1.6)
            + 0.20 * cos(centerXZ.y * 0.073 - centerXZ.x * 0.039);
  let rotJitter = (f32((seed >> 4u) & 255u) / 255.0 - 0.5) * 0.18;
  let rotRad = atan2(windDir.y, windDir.x) + swirl + rotJitter;
  let scaleY = 1.0;
  let posRot = vec4f(originXZ.x, groundY, originXZ.y, rotRad);
  let seedF = bitcast<f32>(seed);

  let focal = F.screen.y / max(2.0 * length(F.camUp.xyz), 0.0001);
  let spanPx = (${MEADOW_TILE_METRES} * focal) / max(dist, 0.45);
  let allowedErr = (1.15 * dist) / max(focal, 0.001);
  let vFirst = variantId * 4u;

  if (spanPx >= ${MEADOW_FADE_IN_PX}) {
    let e1 = bitcast<f32>(meadowClusters[(vFirst + 1u) * ${MEADOW_CLUSTER_WORDS}u + 4u]);
    let e2 = bitcast<f32>(meadowClusters[(vFirst + 2u) * ${MEADOW_CLUSTER_WORDS}u + 4u]);
    let e3 = bitcast<f32>(meadowClusters[(vFirst + 3u) * ${MEADOW_CLUSTER_WORDS}u + 4u]);
    let lvl = select(select(select(0u, 1u, allowedErr >= e1), 2u, allowedErr >= e2), 3u, allowedErr >= e3);
    let chosen = vFirst + lvl;
    let cb = chosen * ${MEADOW_CLUSTER_WORDS}u;
    let parentErr = bitcast<f32>(meadowClusters[cb + 3u]);
    let selfErr = bitcast<f32>(meadowClusters[cb + 4u]);
    let levelT = clamp((allowedErr - selfErr) / max(parentErr - selfErr, 0.001), 0.0, 1.0);
    meadowPush(lvl, posRot, vec4f(bitcast<f32>(chosen), scaleY, levelT, seedF));
    return;
  }

  if (spanPx > ${MEADOW_FADE_OUT_PX}) {
    let fade = smoothstep(${MEADOW_FADE_IN_PX}, ${MEADOW_FADE_OUT_PX}, spanPx);
    let cIdx = vFirst + 3u;
    meadowPush(4u, posRot, vec4f(bitcast<f32>(cIdx), scaleY, fade, seedF));
    meadowPush(5u, posRot, vec4f(bitcast<f32>(variantId), scaleY, fade, seedF));
    return;
  }

  if (spanPx >= ${MEADOW_SPLAT_PX}) {
    let u = clamp((${MEADOW_FADE_OUT_PX} - spanPx) / ${MEADOW_FADE_OUT_PX - MEADOW_SPLAT_PX}, 0.0, 1.0) * ${MEADOW_MORPH_STEPS}.0;
    let stepIdx = min(${MEADOW_MORPH_STEPS - 1}u, u32(floor(u)));
    let morphT = clamp(u - f32(stepIdx), 0.0, 0.999);
    meadowPush(6u, posRot, vec4f(bitcast<f32>(variantId), scaleY, f32(stepIdx) + morphT, seedF));
    return;
  }

  var inflate = 1.0;
  if (spanPx < ${MEADOW_MIN_PX}) {
    let keepProb = clamp(spanPx * spanPx, 0.04, 1.0);
    let uRand = f32(seed & 65535u) / 65536.0;
    if (uRand > keepProb) { return; }
    inflate = min(4.0, inverseSqrt(keepProb));
  }
  meadowPush(7u, posRot, vec4f(bitcast<f32>(variantId), scaleY, inflate, seedF));
}
`;

const MEADOW_COMMON_WGSL = MEADOW_HASH_GROUND_WGSL + /* wgsl */ `
struct MeadowCfg {
  domain: vec4f,    // region.x, region.z, region.span, minElev
  params: vec4u,    // gridSide, bucketSpan, sampleCount, coverSize
  splats: array<vec4f, 24>, // [v*2] = (centreY, rx, ry, coreTris), [v*2+1] = (meanR, meanG, meanB, tileMetres)
};

struct MeadowInst {
  posRot: vec4f,    // tileOriginX, groundY_center, tileOriginZ, rotRad
  attrs: vec4f,     // bitcast<f32>(clusterOrVariant), scaleY, morphParam, bitcast<f32>(seed)
};

// Synchronized 2D advected wind wave shared identically by 3D volumetric tendrils and distant hillside terrain.
fn grassWindWave(worldXZ: vec2f, time: f32, windParam: vec4f) -> vec2f {
  let rawDir = windParam.xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let speed = max(windParam.z, 4.8);
  let u = dot(worldXZ, windDir);
  let v = dot(worldXZ, acrossDir);
  let curve = sin(v * 0.065 + time * 0.20) * 3.10 + cos(v * 0.14 - time * 0.31) * 1.75;
  let p1 = u * 0.26 - time * speed * 0.54 + curve;
  let p2 = u * 0.62 - time * speed * 0.96 + cos(v * 0.23 - time * 0.43) * 2.10;
  let p3 = u * 1.28 - time * speed * 1.52 + sin(v * 0.51 + time * 0.58) * 1.85;
  let spanBreak = 0.55 + 0.45 * cos(v * 0.19 + sin(u * 0.11) * 1.4 - time * 0.25);
  let catsPaw = (0.54 + 0.46 * sin(u * 0.085 - time * speed * 0.22 + sin(v * 0.055) * 2.1) * cos(v * 0.078 + time * 0.18)) * spanBreak;
  let swell = (sin(p1) * 0.58 + sin(p2) * 0.28 + sin(p3) * 0.14) * catsPaw;
  return vec2f(clamp(0.46 + 0.60 * swell, 0.0, 1.0), swell);
}

fn meadowWindField(worldXZ: vec2f, time: f32, windParam: vec4f) -> vec2f {
  return grassWindWave(worldXZ, time, windParam);
}

// Domain-warped 2D hummock billows (8 m, 14 m, 26 m organic swells):
// spans continuously across tile boundaries with zero 1.35 m grid repetition or 1D plane-wave stripes.
fn meadowWorldBillow(p: vec2f) -> vec3f {
  let warp = vec2f(sin(p.y * 0.16 + 1.3), cos(p.x * 0.14 - 0.8)) * 1.9;
  let q = p + warp;
  let a1 = q.x * 0.58 + q.y * 0.43;
  let a2 = -q.x * 0.37 + q.y * 0.51 + 2.1;
  let a3 = q.x * 0.19 - q.y * 0.24 + 0.7;
  let h = 1.0 + 0.14 * sin(a1) * cos(a2 * 0.85) + 0.11 * sin(a2) + 0.09 * cos(a3);
  let gx = 0.08 * cos(a1) * cos(a2 * 0.85) * 0.58 - 0.07 * cos(a2) * 0.37 - 0.05 * sin(a3) * 0.19;
  let gz = 0.08 * cos(a1) * cos(a2 * 0.85) * 0.43 + 0.07 * cos(a2) * 0.51 + 0.05 * sin(a3) * 0.24;
  return vec3f(h, gx * 0.12, gz * 0.12);
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
@group(0) @binding(15) var landLight: texture_2d<f32>;
@group(0) @binding(16) var meadowCover: texture_2d<f32>;
@group(0) @binding(17) var landAlbedo: texture_2d<f32>;
@group(0) @binding(18) var landSampler: sampler;
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;
@group(2) @binding(0) var<uniform> meadowDraw: vec4u; // offsetInst, bucketId, 0, 0

struct MeadowVertexOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) colour: vec3f,
  @location(3) windInfo: vec4f,    // along, gust, swell, fade
  @location(4) tendrilFlow: vec4f, // bentUnshiftedXZ.xy, camDist, swardWeight
};

struct MeadowVertexData {
  pos: vec3f,
  nrm: vec3f,
  col: vec3f,
  along: f32,
  stiff: f32,
  wTag: f32,
  morphXZ: vec2f,
};

fn meadowReadClusterVert(vi: u32) -> MeadowVertexData {
  let b = vi * ${MEADOW_VERT_WORDS}u;
  let srgb = unpack4x8unorm(meadowVerts[b + 4u]).rgb;
  let sn = unpack4x8snorm(meadowVerts[b + 3u]);
  let morphXZ = unpack2x16float(meadowVerts[b + 7u]);
  return MeadowVertexData(
    vec3f(bitcast<f32>(meadowVerts[b]), bitcast<f32>(meadowVerts[b + 1u]), bitcast<f32>(meadowVerts[b + 2u])),
    normalize(sn.xyz),
    pow(srgb, vec3f(2.2)),
    bitcast<f32>(meadowVerts[b + 5u]),
    max(bitcast<f32>(meadowVerts[b + 6u]), 0.8),
    sn.w,
    morphXZ,
  );
}

fn meadowReadMorphVert(vBase: u32, vi: u32) -> MeadowVertexData {
  let b = vBase + vi * ${MEADOW_VERT_WORDS}u;
  let srgb = unpack4x8unorm(meadowMorph[b + 4u]).rgb;
  return MeadowVertexData(
    vec3f(bitcast<f32>(meadowMorph[b]), bitcast<f32>(meadowMorph[b + 1u]), bitcast<f32>(meadowMorph[b + 2u])) + vec3f(${MEADOW_TILE_METRES * 0.5}, 0.0, ${MEADOW_TILE_METRES * 0.5}),
    normalize(unpack4x8snorm(meadowMorph[b + 3u]).xyz),
    pow(srgb, vec3f(2.2)),
    bitcast<f32>(meadowMorph[b + 5u]),
    max(bitcast<f32>(meadowMorph[b + 6u]), 0.8),
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

fn meadowSlopeNormal(unshiftedXZ: vec2f) -> vec3f {
  let hx = (meadowGroundY(unshiftedXZ + vec2f(2.0, 0.0), cfg.domain, elevation) - meadowGroundY(unshiftedXZ - vec2f(2.0, 0.0), cfg.domain, elevation)) * 0.25;
  let hz = (meadowGroundY(unshiftedXZ + vec2f(0.0, 2.0), cfg.domain, elevation) - meadowGroundY(unshiftedXZ - vec2f(0.0, 2.0), cfg.domain, elevation)) * 0.25;
  return normalize(vec3f(-hx, 1.0, -hz));
}

// Evaluates multi-scale world-space botanical sward albedo anchored to the underlying pasture/field landAlbedo,
// with zero per-tile hueShift so overlapping patches weld without a single seam or checkerboard!
fn meadowSwardColour(unshiftedXZ: vec2f, groundCol: vec3f, vertCol: vec3f, along: f32) -> vec3f {
  let wTone = 0.5 + 0.5 * sin(unshiftedXZ.x * 0.058 + cos(unshiftedXZ.y * 0.051) * 1.7)
                        * cos(unshiftedXZ.y * 0.043 - unshiftedXZ.x * 0.036);
  let fescue = 0.5 + 0.5 * sin(unshiftedXZ.x * 0.17 + sin(unshiftedXZ.y * 0.14) * 1.3)
                         * cos(unshiftedXZ.y * 0.15 - unshiftedXZ.x * 0.11);
  let patchWarm = 0.5 + 0.5 * sin(unshiftedXZ.x * 0.019 - unshiftedXZ.y * 0.023 + 1.4);
  let tone = clamp(wTone * 0.68 + fescue * 0.32, 0.0, 1.0);
  let gLum = clamp(dot(groundCol, vec3f(0.2126, 0.7152, 0.0722)), 0.022, 0.26);
  let chloBase = mix(vec3f(0.028, 0.068, 0.019), vec3f(0.056, 0.092, 0.025), tone) * (0.68 + 1.95 * gLum);
  let tipWarm = mix(vertCol, vec3f(0.092, 0.098, 0.028), patchWarm * 0.34) * (0.86 + 0.28 * tone);
  let botan = mix(chloBase, tipWarm, smoothstep(0.50, 0.94, along));
  return mix(groundCol * vec3f(0.80, 1.08, 0.66), botan, 0.50);
}

fn meadowShadePlace(inst: MeadowInst, vd: MeadowVertexData, fadeVal: f32) -> MeadowVertexOut {
  let halfT = ${MEADOW_TILE_METRES * 0.5};
  let c = cos(inst.posRot.w);
  let s = sin(inst.posRot.w);
  let lx = vd.pos.x - halfT;
  let lz = vd.pos.z - halfT;
  let rx = lx * c - lz * s + halfT;
  let rz = lx * s + lz * c + halfT;

  let unshiftedXZ = inst.posRot.xz + vec2f(rx, rz);
  let groundY = meadowGroundY(unshiftedXZ, cfg.domain, elevation);
  let shiftXZ = nearTerrain.grid.yz;
  let camUnshifted = F.camPos.xz - shiftXZ;
  let horizDist = distance(unshiftedXZ, camUnshifted);
  let camDist = distance(vec3f(unshiftedXZ.x + shiftXZ.x, groundY, unshiftedXZ.y + shiftXZ.y), F.camPos.xyz);

  // Per-vertex SDF height envelope; per-pixel colour/cover is evaluated in meadowShade so triangle Z-crossings
  // happen strictly inside the zero-swardWeight band (vCov.r < 0.036) with zero polygon sawtooth!
  let vCov = meadowCoverAt(unshiftedXZ);
  let coverFade = smoothstep(0.08, 0.62, vCov.r);
  let maxRadius = f32(cfg.params.x) * ${0.5 * MEADOW_TILE_METRES} - 12.0;
  let distFade = 1.0 - smoothstep(maxRadius * 0.42, maxRadius, horizDist);
  let swardWeight = coverFade * distFade;

  let wind = meadowWindField(unshiftedXZ, F.camPos.w, F.windP[0]);
  let rawDir = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let acrossDir = vec2f(-windDir.y, windDir.x);

  // World-space volumetric cloud billows: identical at shared worldXZ across overlapping neighbor sheets!
  let billow = meadowWorldBillow(unshiftedXZ);
  let hBoost = (0.78 + 0.46 * vCov.b) * billow.x;

  // Emergent tendrils flex strongly in wind waves; flat overlap sheet (along <= 0.48) moves purely as a continuous world field!
  let tendrilOnly = smoothstep(0.49, 0.92, vd.along);
  let alongFlex = pow(clamp(vd.along, 0.0, 1.0), 1.55) * swardWeight;
  let wavePress = 1.0 - 0.18 * wind.x * smoothstep(0.10, 0.70, vd.along);
  let edgeTuck = -0.045 * (1.0 - smoothstep(0.002, 0.036, vCov.r * distFade));

  var heightM = vd.pos.y - 0.018;
  if (vd.pos.y >= 0.0) {
    heightM = vd.pos.y * hBoost * swardWeight * wavePress + edgeTuck;
  }
  let posH = max(0.0, heightM);

  let seed = bitcast<u32>(inst.attrs.w);
  let stiffNorm = clamp(vd.stiff, 2.0, 24.0);
  let waveSweep = (0.12 + 0.34 * wind.x + 0.08 * wind.y) * alongFlex * (10.5 / (stiffNorm + 6.5));
  let phaseLag = sin(dot(unshiftedXZ, windDir) * 0.85 - F.camPos.w * 4.2 - vd.along * 2.1 + f32(seed & 15u) * 0.4) * tendrilOnly;
  let crossEddy = sin(dot(unshiftedXZ, acrossDir) * 1.35 + F.camPos.w * 2.7 + f32((seed >> 4u) & 15u)) * 0.038 * alongFlex * tendrilOnly;
  let bendMain = min(waveSweep + phaseLag * 0.045 * alongFlex, max(0.02, posH * 0.92 + 0.06 * alongFlex));
  let dispXZ = windDir * bendMain + acrossDir * crossEddy;
  let arcDrop = (bendMain * bendMain) * 0.34 / max(posH + 0.08, 0.14);

  let world = vec3f(unshiftedXZ.x + dispXZ.x + shiftXZ.x, groundY + heightM - arcDrop, unshiftedXZ.y + dispXZ.y + shiftXZ.y);

  let terrainN = meadowSlopeNormal(unshiftedXZ);
  let nrX = (vd.nrm.x * c - vd.nrm.z * s) * tendrilOnly;
  let nrZ = (vd.nrm.x * s + vd.nrm.z * c) * tendrilOnly;
  let waveTilt = (0.24 + 0.38 * wind.x) * (0.30 + 0.70 * vd.along);
  let swardN = normalize(vec3f(
    terrainN.x - billow.y + nrX + windDir.x * waveTilt,
    max(0.32, terrainN.y + 0.12),
    terrainN.z - billow.z + nrZ + windDir.y * waveTilt,
  ));
  let bentN = normalize(mix(terrainN, swardN, swardWeight));

  var o: MeadowVertexOut;
  o.world = world;
  o.normal = bentN;
  o.colour = vd.col;
  o.windInfo = vec4f(vd.along, wind.x, wind.y, fadeVal);
  o.tendrilFlow = vec4f(unshiftedXZ - dispXZ * 0.70, camDist, distFade);
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
        mix(vd.pos.y, min(vd.pos.y, 0.14), settle),
        vd.pos.z + vd.morphXZ.y * settle,
      );
      vd.along = mix(vd.along, min(vd.along, 0.48), settle);
    } else {
      vd.pos = vec3f(vd.pos.x + vd.morphXZ.x * levelT, vd.pos.y, vd.pos.z + vd.morphXZ.y * levelT);
    }
  }
  let fadeVal = select(1.0, inst.attrs.z, isFade);
  return meadowShadePlace(inst, vd, fadeVal);
}

fn meadowMorphStepRemap(vBase: u32, vi: u32, stepIdx: u32) -> vec2u {
  let stepBase = vBase + ${(MEADOW_MORPH_VERTS * MEADOW_VERT_WORDS + MEADOW_MORPH_FACES * 3)}u;
  var v0 = vi;
  var v1 = vi;
  for (var s = 0u; s <= stepIdx; s++) {
    let sb = stepBase + s * 4u;
    let retired = meadowMorph[sb];
    let dst = meadowMorph[sb + 1u];
    if (s < stepIdx) {
      if (v0 == retired) { v0 = dst; }
      if (v1 == retired) { v1 = dst; }
    } else {
      if (v1 == retired) { v1 = dst; }
    }
  }
  return vec2u(v0, v1);
}

@vertex fn meadowContVS(@builtin(instance_index) ii: u32, @builtin(vertex_index) vid: u32) -> MeadowVertexOut {
  let inst = meadowInstances[meadowDraw.x + ii];
  let variantId = bitcast<u32>(inst.attrs.x);
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

  let pair = select(select(rC, rB, corner == 1u), rA, corner == 0u);
  let a = meadowReadMorphVert(vBase, pair.x);
  let b = meadowReadMorphVert(vBase, pair.y);
  let vd = MeadowVertexData(
    mix(a.pos, b.pos, morphT),
    normalize(mix(a.nrm, b.nrm, morphT)),
    mix(a.col, b.col, morphT),
    mix(a.along, b.along, morphT),
    mix(a.stiff, b.stiff, morphT),
    mix(a.wTag, b.wTag, morphT),
    mix(a.morphXZ, b.morphXZ, morphT),
  );
  return meadowShadePlace(inst, vd, inst.attrs.z);
}

@vertex fn meadowSplatVS(@builtin(instance_index) ii: u32, @builtin(vertex_index) vid: u32) -> MeadowVertexOut {
  let inst = meadowInstances[meadowDraw.x + ii];
  let variantId = min(11u, bitcast<u32>(inst.attrs.x));
  let sA = cfg.splats[variantId * 2u];
  let sB = cfg.splats[variantId * 2u + 1u];
  let inflate = clamp(inst.attrs.z, 1.0, 4.0);
  let unshiftedCenter = inst.posRot.xz + vec2f(${MEADOW_TILE_METRES * 0.5});
  let shiftXZ = nearTerrain.grid.yz;
  let camUnshifted = F.camPos.xz - shiftXZ;
  let horizDist = distance(unshiftedCenter, camUnshifted);
  let maxRadius = f32(cfg.params.x) * ${0.5 * MEADOW_TILE_METRES} - 12.0;
  let distFade = 1.0 - smoothstep(maxRadius * 0.42, maxRadius, horizDist);

  let rx = sA.y * inflate;
  let ry = sA.z * inflate;
  // 3D ground+silhouette splat spanning both camRightXZ and camFwdXZ so aerial AND grazing views stay 100% gap-free
  let camRightXZ = normalize(select(vec2f(1.0, 0.0), F.camRight.xz, length(F.camRight.xz) > 0.01));
  let camFwdXZ = vec2f(-camRightXZ.y, camRightXZ.x);
  var offXZ = camFwdXZ * (rx * 1.55);
  var oyBase = ry * 1.9;
  if (vid == 1u) {
    offXZ = -camFwdXZ * (rx * 0.92) - camRightXZ * (rx * 1.65);
    oyBase = 0.0;
  } else if (vid == 2u) {
    offXZ = -camFwdXZ * (rx * 0.92) + camRightXZ * (rx * 1.65);
    oyBase = 0.0;
  }

  let sampleXZ = unshiftedCenter + offXZ;
  let vCov = meadowCoverAt(sampleXZ);
  let coverFade = smoothstep(0.08, 0.62, vCov.r);
  let swardWeight = coverFade * distFade;
  let edgeTuck = -0.045 * (1.0 - smoothstep(0.002, 0.036, vCov.r * distFade));

  let wind = meadowWindField(sampleXZ, F.camPos.w, F.windP[0]);
  let rawDir = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let oy = oyBase * swardWeight + edgeTuck;
  let worldXZ = sampleXZ + windDir * (wind.x * max(0.0, oy) * 0.40);
  let groundY = meadowGroundY(worldXZ, cfg.domain, elevation);
  let camDist = distance(vec3f(worldXZ.x + shiftXZ.x, groundY, worldXZ.y + shiftXZ.y), F.camPos.xyz);

  let terrainN = meadowSlopeNormal(worldXZ);
  let swardN = normalize(vec3f(terrainN.x + windDir.x * wind.x * 0.30, terrainN.y + 0.12, terrainN.z + windDir.y * wind.x * 0.30));

  let world = vec3f(worldXZ.x + shiftXZ.x, groundY + oy, worldXZ.y + shiftXZ.y);
  var o: MeadowVertexOut;
  o.world = world;
  o.normal = normalize(mix(terrainN, swardN, swardWeight));
  o.colour = sB.rgb;
  o.windInfo = vec4f(0.48, wind.x, wind.y, 1.0);
  o.tendrilFlow = vec4f(worldXZ, camDist, distFade);
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

// Evaluates zero-mean splayed wind-combed grass tufts (+14 deg / -17 deg / +0 deg),
// strictly band-limited by pixel footprint so close views show wispy tendril locks while aerial views have zero stripes.
fn meadowTendrilCloud(bentXZ: vec2f, camDist: f32, windDir: vec2f, gust: f32) -> vec2f {
  let pixel = camDist * 2.0 * length(F.camUp.xyz) / max(F.screen.y, 1.0);
  let wTuft = 1.0 - smoothstep(0.016, 0.048, pixel);
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

  let envA = 0.5 + 0.5 * sin(uA * 3.45 + sin(vA * 2.65) * 1.55 - F.camPos.w * 1.05);
  let envB = 0.5 + 0.5 * cos(uB * 2.95 - cos(vB * 3.15) * 1.45 - F.camPos.w * 0.88);
  let wispA = sin(vA * 15.7 + sin(uA * 2.45) * 1.35) * envA;
  let wispB = sin(vB * 21.3 - cos(uB * 3.05) * 1.25) * envB;
  let slopeA = cos(vA * 15.7 + sin(uA * 2.45) * 1.35) * envA;
  let slopeB = cos(vB * 21.3 - cos(uB * 3.05) * 1.25) * envB;

  let wFine = 1.0 - smoothstep(0.009, 0.028, pixel);
  let u = dot(bentXZ, windDir);
  let v = dot(bentXZ, acrossDir);
  let envC = 0.5 + 0.5 * sin(u * 5.4 - F.camPos.w * 1.8 + cos(v * 4.7) * 1.2);
  let wispC = sin(v * 31.5 + sin(u * 4.1) * 0.95) * envC * wFine;
  let slopeC = cos(v * 31.5 + sin(u * 4.1) * 0.95) * envC * wFine;

  let signal = (wispA * 0.42 + wispB * 0.36 + wispC * 0.22) * wTuft;
  let density = clamp(0.5 + signal * 0.36 + (gust - 0.5) * 0.05 * wTuft, 0.0, 1.0);
  let crossTilt = (slopeA * 0.38 + slopeB * 0.32 + slopeC * 0.20) * wTuft;
  return vec2f(density, crossTilt);
}

fn meadowShade(in: MeadowVertexOut, frontFacing: bool) -> vec4f {
  let rawDir = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let acrossDir = vec2f(-windDir.y, windDir.x);

  let along = clamp(in.windInfo.x, 0.0, 1.0);
  let gust = in.windInfo.y;
  let swell = in.windInfo.z;
  let distFade = clamp(in.tendrilFlow.w, 0.0, 1.0);

  // Per-pixel SDF cover + organic botanical tuft edge breakup:
  // guarantees swardWeight == 0.0 everywhere below fCov.r = 0.036 so Z-crossings into riverbanks/lanes are 100% invisible!
  let unshiftedWorldXZ = in.world.xz - nearTerrain.grid.yz;
  let fCov = meadowCoverAt(unshiftedWorldXZ);
  let marginTuft = sin(unshiftedWorldXZ.x * 2.35 + cos(unshiftedWorldXZ.y * 2.15) * 1.55) * 0.5
                 + cos(unshiftedWorldXZ.y * 0.87 - unshiftedWorldXZ.x * 0.73) * 0.5;
  let edgeBreak = marginTuft * 0.085 * smoothstep(0.05, 0.22, fCov.r) * (1.0 - smoothstep(0.45, 0.78, fCov.r));
  let swardWeight = clamp(smoothstep(0.08, 0.62, fCov.r + edgeBreak) * distFade, 0.0, 1.0);

  let groundCol = meadowGroundColour(unshiftedWorldXZ);
  let lushSward = meadowSwardColour(unshiftedWorldXZ, groundCol, in.colour, along);
  let baseCol = mix(groundCol, lushSward, swardWeight);

  let tf = meadowTendrilCloud(in.tendrilFlow.xy, in.tendrilFlow.z, windDir, gust);

  var n = normalize(in.normal + vec3f(acrossDir.x * tf.y * 0.24, 0.04, acrossDir.y * tf.y * 0.24) * swardWeight);
  if (!frontFacing) { n = normalize(vec3f(-n.x * 0.45, abs(n.y), -n.z * 0.45)); }

  // Volumetric self-occlusion & wind-wave tone converge smoothly to 1.0 as swardWeight -> 0,
  // guaranteeing exact radiometric fusion with landFinishShadowed at riverbanks, lanes, and far hillsides!
  let opticalDepth = (1.0 - along) * (0.68 - 0.34 * tf.x) * swardWeight;
  let volSelfShadow = clamp(exp(-opticalDepth), 0.58, 1.0);
  let crest = smoothstep(-0.36, 0.68, swell);
  let tendrilHighlight = mix(1.0, mix(0.88, 1.13, tf.x), swardWeight);
  let windTone = mix(vec3f(1.0), mix(vec3f(0.84, 0.92, 0.80), vec3f(1.16, 1.18, 0.88), crest), swardWeight);
  let albedo = clamp(baseCol * volSelfShadow * tendrilHighlight * windTone, vec3f(0.0), vec3f(0.32));

  // Sample the exact same terrain sunlight+cloud lightmap (landLight) used by landFinishShadowed
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
  let wrap = max(0.0, dot(n, F.sunDir.xyz) * 0.50 + 0.50) * (0.14 + 0.12 * along) * swardWeight;
  let v = normalize(F.camPos.xyz - in.world);
  let backLit = pow(max(dot(-v, F.sunDir.xyz), 0.0), 2.5) * smoothstep(0.45, 0.95, along) * (0.65 + 0.35 * tf.x) * swardWeight;

  let skyDir = normalize(vec3f(n.x * 0.65, max(n.y, 0.12), n.z * 0.65));
  let skyIrr = textureSampleLevel(envCube, sampC, skyDir, 6.0).rgb;
  let bounceDir = normalize(vec3f(n.x * 0.5, -0.55, n.z * 0.5));
  let groundIrr = textureSampleLevel(envCube, sampC, bounceDir, 6.5).rgb * vec3f(0.88, 0.80, 0.68);
  let ambient = mix(groundIrr * 0.54, skyIrr, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)) * mix(1.0, mix(0.76, 1.0, along), swardWeight);

  let fiberTan = normalize(vec3f(windDir.x * (0.48 + 0.44 * gust), 0.52 - 0.24 * gust, windDir.y * (0.48 + 0.44 * gust)));
  let h = normalize(v + F.sunDir.xyz);
  let tDotH = clamp(dot(fiberTan, h), -1.0, 1.0);
  let sinTH = sqrt(max(0.0, 1.0 - tDotH * tDotH));
  let waveSheen = pow(sinTH, 16.0) * (0.006 + 0.020 * crest * gust) * (0.30 + 0.70 * along) * max(F.sunDir.y, 0.0) * swardWeight;

  let diffuseWeight = mix(1.0, 0.86, swardWeight);
  let transAlbedo = albedo * vec3f(1.16, 1.28, 0.62);
  var col = albedo * (direct * (nDotL * diffuseWeight + wrap) / PI + ambient)
          + transAlbedo * (direct * backLit * 0.45 / PI)
          + (direct / PI) * waveSheen * vec3f(0.82, 0.94, 0.52);
  col += lunarSurface(n, v, albedo, 0.78, vec3f(0.032), vec3f(mix(1.0, bakedLight.g, inDomain)) * lunarShadowVisibility(vec3f(shadowVis)));
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
    // Compile sequentially rather than 6-way Promise.all so Windows D3D12 DXC never spikes PSO heap memory.
    const stepMod = await shader(MEADOW_STEP_WGSL, 'meadow grass step');
    const stepPipe = await device.createComputePipelineAsync({
      label: 'meadow select',
      layout: 'auto',
      compute: { module: stepMod, entryPoint: 'meadowSelect' },
    });
    const renderMod = await shader(MEADOW_RENDER_WGSL, 'meadow grass render');
    const depth = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' };
    const mkPipe = (label, vs, fs) => device.createRenderPipelineAsync({
      label,
      layout: 'auto',
      vertex: { module: renderMod, entryPoint: vs },
      fragment: { module: renderMod, entryPoint: fs, targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depth,
      multisample: { count: samples },
    });
    const clusterPipe = await mkPipe('meadow clusters', 'meadowClusterVS', 'meadowFS');
    const clusterFadePipe = await mkPipe('meadow cluster fade', 'meadowClusterVS', 'meadowClusterFadeFS');
    const contFadePipe = await mkPipe('meadow continuum fade', 'meadowContVS', 'meadowContFadeFS');
    const contSolidPipe = await mkPipe('meadow continuum solid', 'meadowContVS', 'meadowFS');
    const splatPipe = await mkPipe('meadow splat', 'meadowSplatVS', 'meadowFS');
    return [stepPipe, clusterPipe, clusterFadePipe, contFadePipe, contSolidPipe, splatPipe];
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

  const [stepPipe, clusterPipe, clusterFadePipe, contFadePipe, contSolidPipe, splatPipe] = await requestMeadowPipelines({
    device,
    shader,
    format,
    samples,
  });

  const gridSide = isMobile ? MEADOW_GRID_SIDE_MOBILE : MEADOW_GRID_SIDE_DESKTOP;
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
  const lvlMaxIdx = [720, 360, 180, 120];
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

  const cfgBufData = new ArrayBuffer((2 + 24) * 16);
  const cfgF = new Float32Array(cfgBufData);
  const cfgU = new Uint32Array(cfgBufData);
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
  };
  writeRegionCfg(region);
  for (let v = 0; v < 12; v++) {
    const rec = pack.manifest.variantRecords[v];
    const base = 8 + v * 8;
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
    const extraMap = new Map([
      [5, { buffer: cfgBuf }],
      [6, elevationView],
      [7, { buffer: vertsBuf }],
      [8, { buffer: idxBuf }],
      [9, { buffer: clusterBuf }],
      [10, { buffer: morphBuf }],
      [11, { buffer: instancesBuf }],
      [12, { buffer: nearDomain }],
      [15, resMap.get(5)],
      [16, coverView],
      [17, resMap.get(7)],
      [18, resMap.get(8)],
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
      [clusterPipe, 'meadow cluster', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 15, 16, 17, 18, 19, 20, 21], [0, 1, 2, 3]],
      [clusterFadePipe, 'meadow cluster fade', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 15, 16, 17, 18, 19, 20, 21], [4]],
      [contFadePipe, 'meadow cont fade', [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 15, 16, 17, 18, 19, 20, 21], [5]],
      [contSolidPipe, 'meadow cont solid', [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 15, 16, 17, 18, 19, 20, 21], [6]],
      [splatPipe, 'meadow splat', [0, 1, 2, 3, 4, 5, 6, 11, 12, 15, 16, 17, 18, 19, 20, 21], [7]],
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
    device.queue.writeBuffer(cfgBuf, 0, cfgBufData, 0, 32);
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
    for (let i = 0; i < map.length; i += 4) if (map[i] >= 32) coverTexels++;
    device.queue.writeTexture({ texture: coverTexture }, map, { bytesPerRow: coverSize * 4 }, [coverSize, coverSize]);
  }

  sync({ region, heights, biome, beaches, port, city, board, inlandWater });
  buildPipeBindGroups(activeResources);

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
      style: pack.manifest.style ?? 'volumetric-cloud-tendrils',
      variants: pack.manifest.variantRecords.length,
      clusters: pack.manifest.clusterCount,
      triangles: pack.manifest.triangleCount,
      gridSide,
      coverSize,
      get coveredTexels() { return coverTexels; },
    },
    sync,
    rebind(nextResources) {
      activeResources = nextResources;
      buildPipeBindGroups(activeResources);
    },
    encode(pass) {
      if (!coverTexels) return;
      device.queue.writeBuffer(drawsBuf, 0, drawTemplate);
      pass.setPipeline(stepPipe);
      pass.setBindGroup(0, stepGroup);
      const groups = Math.ceil(gridSide / 8);
      pass.dispatchWorkgroups(groups, groups);
    },
    draw(pass) {
      if (!coverTexels) return;
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
    destroy() {
      vertsBuf.destroy();
      idxBuf.destroy();
      clusterBuf.destroy();
      morphBuf.destroy();
      instancesBuf.destroy();
      drawsBuf.destroy();
      stepCfgBuf.destroy();
      cfgBuf.destroy();
      coverTexture.destroy();
      for (const b of bucketUniforms) b.destroy();
    },
  };
}
