// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// 100% GPU Nanite-style meadow grasses: 4-level coverage-preserving cluster DAG,
// MSAA sample_mask handoff into a genus-0 progressive collapse continuum,
// 1-triangle horizon splats with stochastic sub-pixel thinning, and 2D advected wind waves.
import { requestOnce } from './gpu-program-cache.js';
import { FRAME_WGSL, ATMO_CORE_WGSL } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { CLOUD_SAMPLE } from './wgsl/clouds.js';
import { SHADOW_FRAME } from './wgsl/shadows.js';
import { terrainSurfaceSample } from './terrain-model.js';
import { portClearanceEnvelope } from './coastal-world.js';
import { streetEdgeAt } from './town-streets.js';
import { createInlandWaterSampler } from './inland-water.js';
import { CITY_BLOCK_FLOATS, CITY_GROUND } from './old-world-city.js';

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
const MEADOW_MORPH_STEPS = 18;
const MEADOW_MORPH_VAR_WORDS = 368; // 22*8 + 40*3 + 18*4 = 368 words = 1472 bytes
const MEADOW_GRID_SIDE_DESKTOP = 320;
const MEADOW_GRID_SIDE_MOBILE = 176;
const MEADOW_BUCKET_SPAN = 16384;

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

function buildCityBlockSpatialIndex(blocks, region) {
  if (!(blocks?.length >= CITY_BLOCK_FLOATS)) return null;
  const span = region.span, x0 = region.x - span * 0.5, z0 = region.z - span * 0.5;
  const gridN = 64, invStep = gridN / span;
  const cells = new Array(gridN * gridN);
  const count = Math.floor(blocks.length / CITY_BLOCK_FLOATS);
  for (let b = 0; b < count; b++) {
    const o = b * CITY_BLOCK_FLOATS;
    const bx = blocks[o], bz = blocks[o + 2], yaw = blocks[o + 3], w = blocks[o + 4], d = blocks[o + 5];
    if (!(w > 0 && d > 0)) continue;
    const hw = w * 0.5 + 1.1, hd = d * 0.5 + 1.1;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const ext = Math.hypot(hw, hd);
    const i0 = Math.max(0, Math.floor((bx - ext - x0) * invStep));
    const i1 = Math.min(gridN - 1, Math.floor((bx + ext - x0) * invStep));
    const j0 = Math.max(0, Math.floor((bz - ext - z0) * invStep));
    const j1 = Math.min(gridN - 1, Math.floor((bz + ext - z0) * invStep));
    const rec = { bx, bz, hw, hd, cosY, sinY };
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * gridN + i;
        if (!cells[idx]) cells[idx] = [rec];
        else cells[idx].push(rec);
      }
    }
  }
  return (x, z) => {
    const i = Math.floor((x - x0) * invStep), j = Math.floor((z - z0) * invStep);
    if (i < 0 || j < 0 || i >= gridN || j >= gridN) return false;
    const list = cells[j * gridN + i];
    if (!list) return false;
    for (let k = 0; k < list.length; k++) {
      const r = list[k];
      const dx = x - r.bx, dz = z - r.bz;
      const lx = dx * r.cosY - dz * r.sinY;
      const lz = dx * r.sinY + dz * r.cosY;
      if (Math.abs(lx) <= r.hw && Math.abs(lz) <= r.hd) return true;
    }
    return false;
  };
}

// Bake static meadow coverage map: R = cover (0..255), G = mix (0 pasture, 128 waste, 255 field-margin),
// B = blade height scale (0..255 -> 0.65..1.25), A = 255. Computed once per coast/DEM update, zero per-frame CPU cost.
export function buildMeadowCoverMap({ region, heights, biome, beaches = null, port = null, city = null, size = 512 }) {
  const cover = new Uint8Array(size * size * 4);
  if (!region || !heights) return cover;
  const span = region.span, x0 = region.x - span * 0.5, z0 = region.z - span * 0.5, step = span / size;
  const maskSize = region.biomeSize || Math.round(Math.sqrt(biome?.length || 0)) || 512;
  const hasBiome = biome instanceof Uint8Array && biome.length === maskSize * maskSize;
  const dry = beaches?.drySandMask, swash = beaches?.swashMask;
  const inside = span * 0.5 - 0.01;
  const ground = (x, z) => terrainSurfaceSample(
    heights,
    Math.max(region.x - inside, Math.min(region.x + inside, x)),
    Math.max(region.z - inside, Math.min(region.z + inside, z)),
    region,
  );
  const waterAt = port?.country ? createInlandWaterSampler(port.country, { margin: 2.5 }) : null;
  const streets = port?.streets ?? null;
  const town = port?.clearRadius > 0 && port?.instances?.length ? port : null;
  const blockAt = buildCityBlockSpatialIndex(city?.blocks, region);
  const hasCityGround = typeof city?.groundAt === 'function';

  const rawR = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    const wz = z0 + (j + 0.5) * step;
    const bj = Math.min(maskSize - 1, Math.floor((j + 0.5) * maskSize / size)) * maskSize;
    for (let i = 0; i < size; i++) {
      const wx = x0 + (i + 0.5) * step;
      const idx = j * size + i;
      const cell = bj + Math.min(maskSize - 1, Math.floor((i + 0.5) * maskSize / size));
      const p4 = idx * 4;
      cover[p4 + 3] = 255;

      const y = ground(wx, wz);
      if (!(y >= 0.9) || y > 840) continue;
      if (dry && dry[cell] > 95) continue;
      if (swash && swash[cell] > 40) continue;
      if (waterAt?.(wx, wz)) continue;
      if (streets && streetEdgeAt(streets, wx, wz) < 3.2) continue;
      if (town && !portClearanceEnvelope(town, wx, wz, 2.0)) continue;

      let parkBonus = false;
      if (hasCityGround) {
        const cg = city.groundAt(wx, wz);
        if (cg === CITY_GROUND.STREET || cg === CITY_GROUND.SQUARE || cg === CITY_GROUND.HOUSE || cg === CITY_GROUND.CASTLE) continue;
        parkBonus = cg === CITY_GROUND.PARK;
      }
      if (blockAt?.(wx, wz)) continue;

      const sx = (ground(wx + 2.0, wz) - ground(wx - 2.0, wz)) * 0.25;
      const sz = (ground(wx, wz + 2.0) - ground(wx, wz - 2.0)) * 0.25;
      const slope = Math.hypot(sx, sz);
      if (!(slope <= 0.44)) continue;

      const marked = hasBiome ? biome[cell] : 20;
      const altFade = Math.min(1, Math.max(0, (y - 0.9) / 2.6));
      const slopeFade = Math.min(1, Math.max(0, (0.44 - slope) / 0.16));
      const n1 = valueNoise2D(wx * 0.022, wz * 0.022);
      const n2 = valueNoise2D(wx * 0.075 + 17.3, wz * 0.075 - 9.1);
      const patch = 0.72 + 0.28 * (n1 * 0.65 + n2 * 0.35);

      let dens = 0;
      let mixVal = 0;
      let hScale = 165;
      if (parkBonus) {
        dens = 0.92;
        mixVal = 235;
        hScale = 185;
      } else if (marked < 42) {
        dens = (0.76 + 0.24 * n1) * altFade * slopeFade * patch;
        if (slope > 0.22 || y > 180) {
          mixVal = 128; // waste / highland scrub grass
          hScale = 135;
        } else {
          mixVal = n2 > 0.56 ? 255 : 0; // blend pasture + field-margin
          hScale = 178;
        }
      } else if (marked < 102) {
        const marginFade = 1.0 - Math.max(0, (marked - 42) / 60);
        dens = (0.68 + 0.24 * n2) * marginFade * altFade * slopeFade;
        mixVal = 255; // field-margin tall herbs/grasses
        hScale = 198;
      } else {
        continue;
      }

      rawR[idx] = Math.max(0, Math.min(255, Math.round(dens * 255)));
      cover[p4 + 1] = mixVal;
      cover[p4 + 2] = Math.max(0, Math.min(255, Math.round(hScale * (0.85 + 0.3 * n2))));
    }
  }

  // Soften cover edges once while strictly masking out forbidden hard boundaries (water/street/buildings)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const idx = j * size + i;
      if (rawR[idx] === 0) {
        cover[idx * 4] = 0;
        continue;
      }
      const l = i > 0 ? rawR[idx - 1] : rawR[idx];
      const r = i + 1 < size ? rawR[idx + 1] : rawR[idx];
      const d = j > 0 ? rawR[idx - size] : rawR[idx];
      const u = j + 1 < size ? rawR[idx + size] : rawR[idx];
      cover[idx * 4] = Math.round(rawR[idx] * 0.5 + (l + r + d + u) * 0.125);
    }
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

// Compact, 100% loop-free D3D12-safe compute shader: 1 thread = 1 volumetric cloud+tendrils tile,
// 32-byte uniform, flat vec4f pair stores (zero struct-copy or nested-loop HLSL/DXC memory spike).
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
  let jx = (f32((seed >> 8u) & 255u) / 255.0 - 0.5) * 0.42;
  let jz = (f32((seed >> 16u) & 255u) / 255.0 - 0.5) * 0.42;
  let originXZ = vec2f(cellIJ) * ${MEADOW_TILE_METRES} + vec2f(jx, jz);
  let centerXZ = originXZ + vec2f(${MEADOW_TILE_METRES * 0.5});

  let uv = (centerXZ - cfg.domain.xy) / cfg.domain.z + 0.5;
  if (uv.x <= 0.002 || uv.x >= 0.998 || uv.y <= 0.002 || uv.y >= 0.998) { return; }

  let cDim = i32(cfg.params.w);
  let covCoord = clamp(vec2i(uv * f32(cDim)), vec2i(0), vec2i(cDim - 1));
  let cov = textureLoad(meadowCover, covCoord, 0);
  if (cov.r < 0.12) { return; }

  let groundY = meadowGroundY(centerXZ, cfg.domain, elevation);
  if (groundY < cfg.domain.w) { return; }

  let shiftedCenter = vec3f(centerXZ.x + shiftXZ.x, groundY + 0.35, centerXZ.y + shiftXZ.y);
  let rel = earthCurve(shiftedCenter - F.camPos.xyz, F.camPos.y);
  let dist = length(rel);

  let clip = F.viewProj * vec4f(rel, 1.0);
  let margin = 1.85;
  if (clip.w < -margin) { return; }
  let wGuard = max(clip.w, 0.25) * 1.18 + margin;
  if (abs(clip.x) > wGuard || abs(clip.y) > wGuard) { return; }

  let mixJitter = f32((seed >> 24u) & 255u) / 255.0;
  var mixIdx = 0u;
  if (cov.g > 0.72 || (cov.g > 0.35 && mixJitter > 0.65)) {
    mixIdx = 2u;
  } else if (cov.g > 0.24) {
    mixIdx = 1u;
  }
  let variantId = mixIdx * 4u + (seed & 3u);
  let rotQuad = (seed >> 4u) & 3u;
  let rotRad = f32(rotQuad) * 1.57079633 + (f32((seed >> 6u) & 3u) - 1.5) * 0.26;
  let scaleY = clamp(0.76 + cov.b * 0.56, 0.68, 1.38) * (0.88 + 0.26 * cov.r);
  let posRot = vec4f(originXZ.x, groundY, originXZ.y, rotRad);
  let seedF = bitcast<f32>(seed);

  let focal = F.screen.y / max(2.0 * length(F.camUp.xyz), 0.0001);
  let spanPx = (${MEADOW_TILE_METRES} * focal) / max(dist, 0.45);
  let allowedErr = (1.15 * dist) / max(focal * scaleY, 0.001);
  let vFirst = variantId * 4u;

  if (spanPx >= ${MEADOW_FADE_IN_PX}) {
    // Branchless monotonic 4-level DAG cut (L0 -> L1 -> L2 -> L3) with smooth per-level morphT
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
    // Deterministic MSAA sample_mask crossfade between L3 cloud+tendrils (Bucket 4) and Genus-0 continuum (Bucket 5)
    let fade = smoothstep(${MEADOW_FADE_IN_PX}, ${MEADOW_FADE_OUT_PX}, spanPx);
    let cIdx = vFirst + 3u;
    meadowPush(4u, posRot, vec4f(bitcast<f32>(cIdx), scaleY, fade, seedF));
    meadowPush(5u, posRot, vec4f(bitcast<f32>(variantId), scaleY, fade, seedF));
    return;
  }

  if (spanPx >= ${MEADOW_SPLAT_PX}) {
    // Continuous half-edge collapse continuum (18 collapse steps down to 4 core tris)
    let u = clamp((${MEADOW_FADE_OUT_PX} - spanPx) / ${MEADOW_FADE_OUT_PX - MEADOW_SPLAT_PX}, 0.0, 1.0) * ${MEADOW_MORPH_STEPS}.0;
    let stepIdx = min(${MEADOW_MORPH_STEPS - 1}u, u32(floor(u)));
    let morphT = clamp(u - f32(stepIdx), 0.0, 0.999);
    meadowPush(6u, posRot, vec4f(bitcast<f32>(variantId), scaleY, f32(stepIdx) + morphT, seedF));
    return;
  }

  // < 3.5 px: 1-triangle view-facing horizon splat + sub-pixel stochastic thinning (< 1.0 px)
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
  let curve = sin(v * 0.075 + time * 0.22) * 2.15 + cos(v * 0.19 - time * 0.34) * 1.05;
  let p1 = u * 0.31 - time * speed * 0.58 + curve;
  let p2 = u * 0.78 - time * speed * 1.04 + cos(v * 0.33 - time * 0.47) * 1.30;
  let p3 = u * 1.72 - time * speed * 1.68 + sin(v * 0.88 + time * 0.62) * 0.95;
  let catsPaw = 0.58 + 0.42 * sin(u * 0.095 - time * speed * 0.24 + sin(v * 0.06) * 1.8) * cos(v * 0.085 + time * 0.19);
  let swell = (sin(p1) * 0.56 + sin(p2) * 0.29 + sin(p3) * 0.15) * catsPaw;
  return vec2f(clamp(0.46 + 0.62 * swell, 0.0, 1.0), swell);
}

fn meadowWindField(worldXZ: vec2f, time: f32, windParam: vec4f) -> vec2f {
  return grassWindWave(worldXZ, time, windParam);
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
  @location(3) windInfo: vec4f,   // along, gust, swell, fade
  @location(4) tendrilFlow: vec4f, // bentUnshiftedXZ.xy, camDist, hueShift
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

fn meadowGroundColour(unshiftedXZ: vec2f) -> vec3f {
  let landUV = clamp((unshiftedXZ - cfg.domain.xy) / cfg.domain.z + 0.5, vec2f(0.001), vec2f(0.999));
  return pow(textureSampleLevel(landAlbedo, landSampler, landUV, 1.5).rgb, vec3f(2.2));
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
  let seed = bitcast<u32>(inst.attrs.w);
  let hueShift = 0.90 + 0.22 * (f32((seed >> 10u) & 255u) / 255.0);

  let wind = meadowWindField(unshiftedXZ, F.camPos.w, F.windP[0]);
  let rawDir = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let shiftXZ = nearTerrain.grid.yz;
  let camDist = distance(vec3f(unshiftedXZ.x + shiftXZ.x, groundY, unshiftedXZ.y + shiftXZ.y), F.camPos.xyz);

  // Smoothly taper physical height only far beyond the eye while keeping volumetric sward cushion full near/mid
  let heightTaper = 1.0 - 0.76 * smoothstep(65.0, 260.0, camDist);
  let rawY = vd.pos.y * inst.attrs.y * heightTaper;

  // Travelling wave trough compression + sweeping S-curve tendril kinematics
  let alongFlex = pow(clamp(vd.along, 0.0, 1.0), 1.45);
  let wavePress = 1.0 - 0.20 * wind.x * smoothstep(0.08, 0.65, vd.along);
  let heightM = select(rawY, rawY * wavePress, rawY > 0.0);
  let posH = max(0.0, heightM);

  // Strong, graceful rolling wave sweep across both volumetric billows & emergent tendrils
  let stiffNorm = clamp(vd.stiff, 1.8, 28.0);
  let waveSweep = (0.14 + 0.34 * wind.x + 0.09 * wind.y) * alongFlex * (10.5 / (stiffNorm + 6.5));
  let phaseLag = sin(dot(unshiftedXZ, windDir) * 0.85 - F.camPos.w * 4.2 - vd.along * 2.1 + f32(seed & 15u) * 0.4);
  let crossEddy = sin(dot(unshiftedXZ, acrossDir) * 1.35 + F.camPos.w * 2.7 + f32((seed >> 4u) & 15u)) * 0.042 * alongFlex;
  let bendMain = min(waveSweep + phaseLag * 0.048 * alongFlex, max(0.03, posH * 0.92 + 0.08 * alongFlex));
  let dispXZ = windDir * bendMain + acrossDir * crossEddy;
  let arcDrop = (bendMain * bendMain) * 0.36 / max(posH + 0.08, 0.14);

  let world = vec3f(unshiftedXZ.x + dispXZ.x + shiftXZ.x, groundY + heightM - arcDrop, unshiftedXZ.y + dispXZ.y + shiftXZ.y);
  let nrX = vd.nrm.x * c - vd.nrm.z * s;
  let nrZ = vd.nrm.x * s + vd.nrm.z * c;
  // Tilt surface normal along the sweeping wind wave so gusts flash silver-chartreuse sheen across hillsides
  let waveTilt = (0.28 + 0.42 * wind.x) * (0.35 + 0.65 * vd.along);
  let bentN = normalize(vec3f(nrX + windDir.x * waveTilt, max(0.26, vd.nrm.y + 0.18), nrZ + windDir.y * waveTilt));

  let groundCol = meadowGroundColour(unshiftedXZ);
  // Keep lush botanical sward green near/mid while blending smoothly into distant hillside ground albedo
  let lushSward = mix(vd.col * hueShift, groundCol * vec3f(0.76, 1.08, 0.62), 0.22);
  let distMix = smoothstep(65.0, 220.0, camDist);

  var o: MeadowVertexOut;
  o.world = world;
  o.normal = bentN;
  o.colour = mix(lushSward, groundCol, distMix * 0.88);
  o.windInfo = vec4f(vd.along, wind.x, wind.y, fadeVal);
  o.tendrilFlow = vec4f(unshiftedXZ - dispXZ * 0.72, camDist, hueShift);
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
      // Smoothly fold retiring tendrils horizontally AND vertically down into the volumetric grass cloud cushion
      vd.pos = vec3f(
        vd.pos.x + vd.morphXZ.x * settle,
        mix(vd.pos.y, min(vd.pos.y, 0.11), settle),
        vd.pos.z + vd.morphXZ.y * settle,
      );
      vd.along = mix(vd.along, min(vd.along, 0.42), settle);
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
  let groundY = meadowGroundY(unshiftedCenter, cfg.domain, elevation);
  let shiftXZ = nearTerrain.grid.yz;
  let camDist = distance(vec3f(unshiftedCenter.x + shiftXZ.x, groundY, unshiftedCenter.y + shiftXZ.y), F.camPos.xyz);
  let heightTaper = 1.0 - 0.76 * smoothstep(65.0, 260.0, camDist);
  let rx = sA.y * inflate;
  let ry = sA.z * inst.attrs.y * inflate * heightTaper;

  let camRightXZ = normalize(select(vec2f(1.0, 0.0), F.camRight.xz, length(F.camRight.xz) > 0.01));
  var ox = 0.0;
  var oy = ry * 2.1;
  if (vid == 1u) { ox = -rx * 1.45; oy = 0.0; }
  else if (vid == 2u) { ox = rx * 1.45; oy = 0.0; }

  let wind = meadowWindField(unshiftedCenter, F.camPos.w, F.windP[0]);
  let rawDir = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let worldXZ = unshiftedCenter + camRightXZ * ox + windDir * (wind.x * oy * 0.42);

  let seed = bitcast<u32>(inst.attrs.w);
  let hueShift = 0.90 + 0.20 * (f32((seed >> 10u) & 255u) / 255.0);
  let groundCol = meadowGroundColour(unshiftedCenter);
  let world = vec3f(worldXZ.x + shiftXZ.x, groundY + oy, worldXZ.y + shiftXZ.y);
  var o: MeadowVertexOut;
  o.world = world;
  o.normal = normalize(vec3f(windDir.x * wind.x * 0.36, 1.0, windDir.y * wind.x * 0.36));
  o.colour = mix(sB.rgb * hueShift, groundCol, 0.86);
  o.windInfo = vec4f(clamp(oy / max(ry * 2.0, 0.12), 0.0, 1.0), wind.x, wind.y, 1.0);
  o.tendrilFlow = vec4f(unshiftedCenter, camDist, hueShift);
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

fn meadowCloudShadow(world: vec3f) -> f32 {
  if (CF.screen.w <= 0.5 || F.sunDir.y <= 0.0) { return 1.0; }
  let cMid = cloudUV(world * 0.001 + F.sunDir.xyz * (max(CF.shape.x, 0.5) / max(F.sunDir.y, 0.15)));
  let cD = textureSampleLevel(cloudDensity, cloudSampler, clamp(cMid, vec3f(0.0), vec3f(1.0)), 1.0).r;
  let cL = textureSampleLevel(cloudLight, cloudSampler, clamp(cMid, vec3f(0.0), vec3f(1.0)), 1.0).b;
  return clamp(exp(-max(cD, 0.0) * CF.shape.z * 0.6) * mix(1.0, cL, 0.5), 0.0, 1.0);
}

// Evaluates anisotropic wind-combed volumetric grass tendril streams across the cloud cushion,
// automatically band-limited by pixel footprint so close views reveal lush wavy tendril locks with zero distant shimmer.
fn meadowTendrilCloud(bentXZ: vec2f, camDist: f32, windDir: vec2f, gust: f32) -> vec2f {
  let pixel = camDist * 2.0 * length(F.camUp.xyz) / max(F.screen.y, 1.0);
  let wCoarse = 1.0 - smoothstep(0.14, 0.52, pixel);
  if (wCoarse <= 0.001) { return vec2f(0.5, 0.0); }
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let u = dot(bentXZ, windDir);
  let v = dot(bentXZ, acrossDir);

  // Flowing S-warped tendril locks stretched 5.5:1 along wind direction
  let warp1 = sin(u * 1.85 - F.camPos.w * 1.4 + cos(v * 1.3) * 0.8) * 0.42;
  let lock1 = sin((v + warp1) * 11.5) * 0.5 + 0.5;
  let lockSlope1 = cos((v + warp1) * 11.5);

  let wFine = 1.0 - smoothstep(0.035, 0.16, pixel);
  let warp2 = cos(u * 4.3 - F.camPos.w * 2.3 - sin(v * 3.1) * 0.55) * 0.22;
  let lock2 = (sin((v + warp2) * 29.0 + u * 2.7) * 0.5 + 0.5) * wFine;
  let lockSlope2 = cos((v + warp2) * 29.0 + u * 2.7) * wFine;

  let density = mix(0.5, clamp(lock1 * 0.65 + lock2 * 0.35 + gust * 0.08, 0.0, 1.0), wCoarse);
  let crossTilt = (lockSlope1 * 0.62 + lockSlope2 * 0.38) * wCoarse;
  return vec2f(density, crossTilt);
}

fn meadowShade(in: MeadowVertexOut, frontFacing: bool) -> vec4f {
  let rawDir = F.windP[0].xy;
  let windDir = select(vec2f(0.82, 0.57), normalize(rawDir), dot(rawDir, rawDir) > 0.0004);
  let acrossDir = vec2f(-windDir.y, windDir.x);

  let along = clamp(in.windInfo.x, 0.0, 1.0);
  let gust = in.windInfo.y;
  let swell = in.windInfo.z;
  let tf = meadowTendrilCloud(in.tendrilFlow.xy, in.tendrilFlow.z, windDir, gust);

  var n = normalize(in.normal + vec3f(acrossDir.x * tf.y * 0.28, 0.08, acrossDir.y * tf.y * 0.28));
  if (!frontFacing) { n = normalize(vec3f(-n.x * 0.45, abs(n.y), -n.z * 0.45)); }

  // Volumetric Beer-Lambert self-occlusion inside turf cushion + wind-wave trough/crest tonal depth
  let opticalDepth = (1.0 - along) * (1.45 - 0.52 * tf.x);
  let volSelfShadow = clamp(exp(-opticalDepth * 0.92), 0.34, 1.0);
  let crest = smoothstep(-0.36, 0.68, swell);
  let tendrilHighlight = mix(0.84, 1.16, tf.x);
  let windTone = mix(vec3f(0.76, 0.88, 0.72), vec3f(1.22, 1.24, 0.84), crest);
  let albedo = clamp(in.colour * volSelfShadow * tendrilHighlight * windTone, vec3f(0.0), vec3f(0.32));

  let shadow = meadowShadowVis(in.world, n) * meadowCloudShadow(in.world);
  let sunVis = solarShadowVisibility(vec3f(shadow));
  let nDotL = max(dot(n, F.sunDir.xyz), 0.0);
  // Soft volumetric wrap + chlorophyll forward-scattering scaled strictly by albedo & 1/PI (matching landFinishShadowed)
  let wrap = max(0.0, dot(n, F.sunDir.xyz) * 0.50 + 0.50) * (0.24 + 0.14 * along);
  let v = normalize(F.camPos.xyz - in.world);
  let backLit = pow(max(dot(-v, F.sunDir.xyz), 0.0), 2.4) * (0.35 + 0.65 * along) * (0.65 + 0.35 * tf.x);
  let directSun = sunIlluminance() * sunVis;

  let skyDir = normalize(vec3f(n.x * 0.65, max(n.y, 0.14), n.z * 0.65));
  let skyIrr = textureSampleLevel(envCube, sampC, skyDir, 6.0).rgb;
  let bounceDir = normalize(vec3f(n.x * 0.5, -0.55, n.z * 0.5));
  let groundIrr = textureSampleLevel(envCube, sampC, bounceDir, 6.5).rgb * vec3f(0.82, 0.84, 0.66);
  let ambient = mix(groundIrr * 0.50, skyIrr, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)) * mix(0.56, 1.0, along);

  // Anisotropic Kajiya-Kay wind-combed wave sheen scaled by 1/PI so wave crests shimmer emerald-gold without bleaching
  let fiberTan = normalize(vec3f(windDir.x * (0.48 + 0.44 * gust), 0.52 - 0.24 * gust, windDir.y * (0.48 + 0.44 * gust)));
  let h = normalize(v + F.sunDir.xyz);
  let tDotH = clamp(dot(fiberTan, h), -1.0, 1.0);
  let sinTH = sqrt(max(0.0, 1.0 - tDotH * tDotH));
  let waveSheen = pow(sinTH, 16.0) * (0.008 + 0.026 * crest * gust) * (0.28 + 0.72 * along) * max(F.sunDir.y, 0.0);

  let transAlbedo = albedo * vec3f(1.18, 1.32, 0.62);
  var col = albedo * (directSun * (nDotL * 0.82 + wrap) / PI + ambient)
          + transAlbedo * (directSun * backLit * 0.55 / PI)
          + (directSun / PI) * waveSheen * vec3f(0.82, 0.94, 0.52);
  col += lunarSurface(n, v, albedo, 0.76, vec3f(0.020), lunarShadowVisibility(vec3f(shadow)));
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
  elevation,
  nearDomain,
  resources,
  clouds,
  format = 'rgba16float',
  samples = 4,
  isMobile = false,
  coverSize = 512,
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

  // Derive exact maximum index counts per level directly from baked cluster records
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

  // Separate 32-byte compute step uniform from 416-byte render splat uniform
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
    const extraMap = new Map([
      [5, { buffer: cfgBuf }],
      [6, elevationView],
      [7, { buffer: vertsBuf }],
      [8, { buffer: idxBuf }],
      [9, { buffer: clusterBuf }],
      [10, { buffer: morphBuf }],
      [11, { buffer: instancesBuf }],
      [12, { buffer: nearDomain }],
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
        [4, coverTexture.createView()],
        [5, { buffer: clusterBuf }],
        [6, { buffer: instancesBuf }],
        [7, { buffer: drawsBuf }],
      ].map(([binding, resource]) => ({ binding, resource })),
    });

    const pipeSpecs = [
      [clusterPipe, 'meadow cluster', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 17, 18, 19, 20, 21], [0, 1, 2, 3]],
      [clusterFadePipe, 'meadow cluster fade', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 17, 18, 19, 20, 21], [4]],
      [contFadePipe, 'meadow cont fade', [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 17, 18, 19, 20, 21], [5]],
      [contSolidPipe, 'meadow cont solid', [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 17, 18, 19, 20, 21], [6]],
      [splatPipe, 'meadow splat', [0, 1, 2, 3, 4, 5, 6, 11, 12, 17, 18, 19, 20, 21], [7]],
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

  let coverTexels = 0;
  function sync(next = {}) {
    const nextReg = next.region ?? region;
    const nextH = next.heights ?? heights;
    const nextB = next.biome ?? biome;
    const nextBeaches = next.beaches !== undefined ? next.beaches : beaches;
    const nextPort = next.port !== undefined ? next.port : port;
    const nextCity = next.city !== undefined ? next.city : city;
    writeRegionCfg(nextReg);
    device.queue.writeBuffer(stepCfgBuf, 0, stepCfgData, 0, 32);
    device.queue.writeBuffer(cfgBuf, 0, cfgBufData, 0, 32);
    const map = buildMeadowCoverMap({
      region: nextReg,
      heights: nextH,
      biome: nextB,
      beaches: nextBeaches,
      port: nextPort,
      city: nextCity,
      size: coverSize,
    });
    coverTexels = 0;
    for (let i = 0; i < map.length; i += 4) if (map[i] >= 32) coverTexels++;
    device.queue.writeTexture({ texture: coverTexture }, map, { bytesPerRow: coverSize * 4 }, [coverSize, coverSize]);
  }

  sync({ region, heights, biome, beaches, port, city });
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
