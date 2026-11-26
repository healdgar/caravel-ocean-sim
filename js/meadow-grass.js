// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Meadow grass: blades made on the GPU each frame from where they stand in the world (js/wgsl/meadow-blades.js for
// the passes and the blades' look). No tile, patch or atlas: the cover map below says where grass grows, how lush and
// which of a pack's three mixes, and each blade is sown, kept or thinned, leaned by the wind and drawn on the GPU;
// the CPU writes the cover map when the land changes and a few uniforms a frame. A blade near is a curved strip that
// turns about its stem to face the eye; far off, or seen end on from above, a splat of the sward's own colour at its
// tip; between, as few as hide the ground, widened to keep it hidden.
// Grass is never a target: shot passes through it. Craters bury it, and passing shot and blast rings part it, from
// the land's own crater field and the frame's ballistic wakes.
import { requestOnce } from './gpu-program-cache.js';
import { continuumPixelError, CONTINUUM_BASE_PIXEL_ERROR, CONTINUUM_MIN_PIXELS, CONTINUUM_SPLAT_PIXELS } from './continuum-core.js';
import { continuumProfile } from './continuum-profiles.js';
import { continuumGroundView } from './continuum-ground.js';
import { LAND_SHADOW_FORMAT } from './shadows.js';
import { terrainSurfaceSample } from './terrain-model.js';
import { CITY_BLOCK_FLOATS, CITY_GROUND } from './old-world-city.js';
import { INLAND_WATER_FLOATS } from './wgsl/inland-water.js';
import { LAND_CRATER_TILE_M } from './wgsl/land-craters.js';
import { streetEdgeAt, unpackRouteHalfWidthSlope } from './town-streets.js';
import { MEADOW_MIX_ROLES } from './meadow-continuum.js';
import { MEADOW_MAX_SHOT_WAKES, MEADOW_MAX_BLAST_RINGS, MEADOW_WAKE_BUFFER_BYTES, MEADOW_CONTINUUM_CFG_BYTES, MEADOW_GUST_WAVE } from './wgsl/meadow-continuum.js';
import {
  MEADOW_BLADE_LEVELS, MEADOW_BLADE_GRID, MEADOW_BLADE_REACH, MEADOW_BLADE_DEPTH, MEADOW_BLADE_SEGMENTS, MEADOW_BLADE_RECORD_BYTES,
  MEADOW_BLADE_CELL_HEADER, MEADOW_BLADE_DRAW_WORDS, MEADOW_SPECIES_MOST, MEADOW_SWARD_BYTES, MEADOW_BLADE_FRAME_BYTES,
  meadowBladesComputeWGSL, meadowBladesDrawWGSL,
} from './wgsl/meadow-blades.js';

const MEADOW_COVER_DESKTOP = 2048; // 4.0 m/texel across 8192 m region with bilinear SDF filtering
const MEADOW_COVER_MOBILE = 1024;
// The ground meadows stop at.
const MEADOW_WATERLINE = 0.75;
// The blades each list holds (near, middle, far) and the cells the cells pass may list: the primary section's on a
// desktop, a neighbouring section's, and a phone's.
const MEADOW_BLADE_ROOM = Object.freeze({
  primary: Object.freeze([196608, 524288, 1048576, 131072]),
  secondary: Object.freeze([49152, 131072, 262144, 65536]),
  mobile: Object.freeze([32768, 131072, 262144, 65536]),
});
// A phone draws its narrowest blades this much wider, and so fewer of them.
const MEADOW_BLADE_MOBILE_COARSER = 1.25;

// Each coast's sward, by its climate: three mixes in the roles of MEADOW_MIX_ROLES, each of species with their share
// of the mix, their colour at the foot and the tip (linear), height and width (m), how far they droop at rest, how
// stiff they stand, and the shares bearing a head (its colour and length along the blade), dry and in flower. A mix
// grows as densely as its density says, of the fullest sward (js/wgsl/meadow-blades.js MEADOW_BLADE_DENSITY).
const meadowSpecies = (share, height, width, foot, tip, droop, stiffness, { head = 0, headColour = [0.13, 0.12, 0.06], headLength = 0.2, dry = 0, flower = 0 } = {}) =>
  Object.freeze({ share, height, width, foot, tip, droop, stiffness, head, headColour, headLength, dry, flower });
export const MEADOW_SWARDS = Object.freeze({
  portugal: Object.freeze({
    flower: [0.62, 0.62, 0.55],
    mixes: [
      // Hay meadow: rye-grass, fescue, bent, timothy, clover and ox-eye daisies, knee high and more by early summer.
      { density: 1.0, species: [
        meadowSpecies(0.30, 0.70, 0.0045, [0.025, 0.088, 0.012], [0.049, 0.172, 0.018], 0.55, 8, { head: 0.08, dry: 0.02 }),
        meadowSpecies(0.20, 0.85, 0.0050, [0.029, 0.085, 0.015], [0.056, 0.160, 0.022], 0.50, 9, { head: 0.10, headColour: [0.14, 0.12, 0.07], headLength: 0.18, dry: 0.03 }),
        meadowSpecies(0.22, 0.48, 0.0030, [0.024, 0.086, 0.012], [0.044, 0.165, 0.018], 0.62, 6, { head: 0.06, headColour: [0.12, 0.10, 0.08], headLength: 0.22, dry: 0.03 }),
        meadowSpecies(0.10, 1.05, 0.0035, [0.031, 0.084, 0.017], [0.060, 0.150, 0.026], 0.22, 12, { head: 0.55, headColour: [0.12, 0.11, 0.07], headLength: 0.14, dry: 0.04 }),
        meadowSpecies(0.12, 0.25, 0.0110, [0.020, 0.075, 0.012], [0.039, 0.140, 0.019], 0.70, 5, { flower: 0.10 }),
        meadowSpecies(0.06, 0.60, 0.0030, [0.027, 0.080, 0.015], [0.048, 0.135, 0.021], 0.12, 10, { flower: 0.5 }),
      ] },
      // Hill pasture: red fescue, cocksfoot, bent, thyme and wild oat, shorter and greyer.
      { density: 0.9, species: [
        meadowSpecies(0.35, 0.40, 0.0025, [0.032, 0.080, 0.017], [0.061, 0.142, 0.028], 0.58, 7, { head: 0.10, headColour: [0.16, 0.12, 0.08], dry: 0.08 }),
        meadowSpecies(0.22, 0.70, 0.0060, [0.031, 0.082, 0.019], [0.058, 0.145, 0.028], 0.45, 10, { head: 0.25, headColour: [0.15, 0.13, 0.08], dry: 0.06 }),
        meadowSpecies(0.25, 0.36, 0.0030, [0.027, 0.084, 0.015], [0.053, 0.150, 0.024], 0.62, 6, { head: 0.10, headColour: [0.14, 0.11, 0.09], headLength: 0.25, dry: 0.05 }),
        meadowSpecies(0.10, 0.18, 0.0080, [0.029, 0.066, 0.019], [0.053, 0.105, 0.033], 0.60, 5, { dry: 0.04, flower: 0.12 }),
        meadowSpecies(0.08, 0.85, 0.0060, [0.039, 0.086, 0.022], [0.076, 0.138, 0.038], 0.30, 9, { head: 0.60, headColour: [0.20, 0.17, 0.08], headLength: 0.25, dry: 0.20 }),
      ] },
      // Field and road margins: wild oat, brome, cocksfoot, ribwort and poppies, tall and seeding.
      { density: 0.85, species: [
        meadowSpecies(0.30, 0.95, 0.0070, [0.039, 0.090, 0.022], [0.081, 0.148, 0.038], 0.35, 10, { head: 0.55, headColour: [0.21, 0.17, 0.08], headLength: 0.25, dry: 0.25 }),
        meadowSpecies(0.25, 0.75, 0.0050, [0.034, 0.088, 0.019], [0.068, 0.145, 0.032], 0.48, 8, { head: 0.45, headColour: [0.17, 0.12, 0.09], headLength: 0.25, dry: 0.20 }),
        meadowSpecies(0.20, 0.75, 0.0060, [0.031, 0.086, 0.019], [0.058, 0.150, 0.028], 0.45, 10, { head: 0.25, headColour: [0.15, 0.13, 0.08], dry: 0.12 }),
        meadowSpecies(0.10, 0.45, 0.0040, [0.027, 0.078, 0.019], [0.051, 0.125, 0.030], 0.12, 12, { head: 0.70, headColour: [0.09, 0.08, 0.05], headLength: 0.12, dry: 0.05 }),
        meadowSpecies(0.15, 0.50, 0.0040, [0.031, 0.088, 0.019], [0.053, 0.135, 0.027], 0.22, 9, { head: 0.10, headColour: [0.35, 0.03, 0.02], headLength: 0.10, flower: 0.10 }),
      ] },
    ],
  }),
  tropical: Object.freeze({
    flower: [0.52, 0.50, 0.30],
    mixes: [
      { density: 1.0, species: [
        meadowSpecies(0.40, 0.25, 0.0060, [0.035, 0.100, 0.018], [0.065, 0.180, 0.030], 0.55, 7, { head: 0.06, headColour: [0.12, 0.12, 0.05], headLength: 0.18, dry: 0.03 }),
        meadowSpecies(0.25, 0.55, 0.0070, [0.040, 0.100, 0.022], [0.070, 0.160, 0.035], 0.45, 9, { head: 0.20, headColour: [0.12, 0.10, 0.06], dry: 0.06 }),
        meadowSpecies(0.20, 0.38, 0.0050, [0.040, 0.110, 0.022], [0.070, 0.170, 0.035], 0.30, 10, { head: 0.20, headColour: [0.13, 0.09, 0.05], headLength: 0.10, dry: 0.04 }),
        meadowSpecies(0.15, 0.20, 0.0120, [0.030, 0.090, 0.020], [0.050, 0.140, 0.030], 0.60, 5, { flower: 0.10 }),
      ] },
      { density: 0.8, species: [
        meadowSpecies(0.45, 0.85, 0.0040, [0.080, 0.075, 0.035], [0.170, 0.120, 0.060], 0.25, 10, { head: 0.20, headColour: [0.20, 0.16, 0.10], headLength: 0.25, dry: 0.45 }),
        meadowSpecies(0.30, 0.50, 0.0030, [0.050, 0.080, 0.030], [0.100, 0.120, 0.050], 0.50, 7, { head: 0.30, headColour: [0.16, 0.12, 0.09], headLength: 0.30, dry: 0.40 }),
        meadowSpecies(0.25, 0.45, 0.0070, [0.045, 0.090, 0.028], [0.080, 0.140, 0.040], 0.45, 9, { head: 0.15, headColour: [0.12, 0.10, 0.06], dry: 0.20 }),
      ] },
      { density: 0.4, species: [
        meadowSpecies(0.60, 0.22, 0.0040, [0.040, 0.095, 0.030], [0.070, 0.150, 0.045], 0.50, 8, { head: 0.10, headColour: [0.13, 0.11, 0.06], dry: 0.15 }),
        meadowSpecies(0.40, 0.30, 0.0040, [0.070, 0.080, 0.035], [0.130, 0.120, 0.060], 0.35, 8, { head: 0.30, headColour: [0.18, 0.15, 0.08], headLength: 0.15, dry: 0.40 }),
      ] },
    ],
  }),
});
// The straw a dry blade turns to, foot and tip (js/wgsl/meadow-blades.js MEADOW_STRAW_FOOT and _TIP).
const MEADOW_STRAW = Object.freeze([[0.092, 0.078, 0.036], [0.215, 0.178, 0.084]]);

// A sward as the GPU reads it (MeadowSward), and each mix's mean colour as seen from above, the share of each kind
// of blade weighed in (MeadowCfg's mixes: the sward far off, where a pixel holds many blades).
export function packMeadowSward(sward) {
  const data = new ArrayBuffer(MEADOW_SWARD_BYTES), f = new Float32Array(data), u = new Uint32Array(data);
  const means = [];
  let next = 0;
  sward.mixes.forEach((mix, m) => {
    const total = mix.species.reduce((n, s) => n + s.share, 0);
    if (next + mix.species.length > MEADOW_SPECIES_MOST) throw Error(`A meadow sward holds at most ${MEADOW_SPECIES_MOST} species`);
    u.set([next, mix.species.length, 0, 0], m * 4);
    f[12 + m] = mix.density;
    let ends = 0;
    const mean = [0, 0, 0];
    for (const s of mix.species) {
      ends += s.share / total;
      const at = (12 + 8) + next * 20;
      f.set([...s.foot, s.height, ...s.tip, s.width, ends, s.droop, s.stiffness, s.head, s.dry, s.flower, 0, 0, ...s.headColour, s.headLength], at);
      for (let k = 0; k < 3; k++) {
        const green = s.foot[k] + (s.tip[k] - s.foot[k]) * 0.775, straw = MEADOW_STRAW[0][k] + (MEADOW_STRAW[1][k] - MEADOW_STRAW[0][k]) * 0.775;
        const blade = green * (1 - s.dry) + straw * s.dry;
        const look = blade * (1 - s.flower * 0.6 - s.head * 0.5) + sward.flower[k] * s.flower * 0.6 + s.headColour[k] * s.head * 0.5;
        mean[k] += look * s.share / total;
      }
      next++;
    }
    means.push(mean);
  });
  f.set([...sward.flower, 0], 16);
  return { data, means };
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

// The blade field's programs, one set a device, colour format and sample count: the five compute passes, each with
// its own bind group layout (a buffer one pass writes is read, and dispatched from, by the next), and the three
// draws, one a list, differing only in their blades' segments. Compiled one after another (D3D12 runs out of pipeline
// state memory compiling them at once).
const MEADOW_BLADE_PASSES = Object.freeze({
  reset: Object.freeze([7, 8]),
  cells: Object.freeze([0, 1, 2, 3, 8, 14]),
  args: Object.freeze([7, 8, 14]),
  sow: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17]),
  finish: Object.freeze([7, 14]),
});
const MEADOW_BLADE_ENTRY_POINTS = Object.freeze({ reset: 'meadowBladeReset', cells: 'meadowBladeCells', args: 'meadowBladeArgs', sow: 'meadowBladeSow', finish: 'meadowBladeFinish' });
// What the draws bind in group 0, beside the land's own (the frame, the sky's light, the land's light and shadow map).
const MEADOW_BLADE_VIEW_BINDINGS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 18, 19, 20, 21, 24]);
export function requestMeadowBladePrograms(device, shader, format, samples) {
  return requestOnce(device, `meadow blades ${format} ${samples}`, async () => {
    const C = GPUShaderStage.COMPUTE, VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const buffer = (binding, type, visibility = C) => ({ binding, visibility, buffer: { type } });
    const texture = (binding, sampleType, viewDimension = '2d', visibility = C) => ({ binding, visibility, texture: { sampleType, viewDimension } });
    const sampler = (binding, type, visibility = C) => ({ binding, visibility, sampler: { type } });
    const computeEntries = {
      0: buffer(0, 'uniform'), 1: buffer(1, 'uniform'), 2: buffer(2, 'uniform'), 3: texture(3, 'unfilterable-float'), 4: texture(4, 'float'),
      5: buffer(5, 'uniform'), 6: buffer(6, 'storage'), 7: buffer(7, 'storage'), 8: buffer(8, 'storage'), 9: buffer(9, 'uniform'),
      10: texture(10, 'sint'), 11: texture(11, 'float', '2d-array'), 12: sampler(12, 'filtering'), 13: texture(13, 'unfilterable-float', '2d-array'),
      14: buffer(14, 'uniform'), 15: buffer(15, 'read-only-storage'), 16: buffer(16, 'storage'), 17: buffer(17, 'storage'),
    };
    const computeModule = await shader(meadowBladesComputeWGSL(), 'meadow blades sow');
    const layouts = {}, passes = {};
    for (const [name, ids] of Object.entries(MEADOW_BLADE_PASSES)) {
      layouts[name] = device.createBindGroupLayout({ label: `meadow blades ${name}`, entries: ids.map((id) => computeEntries[id]) });
    }
    for (const name of Object.keys(MEADOW_BLADE_PASSES)) {
      passes[name] = await device.createComputePipelineAsync({
        label: `meadow blades ${name}`, layout: device.createPipelineLayout({ label: `meadow blades ${name}`, bindGroupLayouts: [layouts[name]] }),
        compute: { module: computeModule, entryPoint: MEADOW_BLADE_ENTRY_POINTS[name] },
      });
    }
    const view = device.createBindGroupLayout({ label: 'meadow blades view', entries: [
      buffer(0, 'uniform', VF), texture(1, 'float', '2d', VF), texture(2, 'float', '2d', VF), sampler(3, 'filtering', VF), texture(4, 'float', 'cube', VF),
      buffer(5, 'uniform', VF), buffer(6, 'uniform', VF), buffer(7, 'uniform', VF), buffer(8, 'read-only-storage', VF), buffer(9, 'uniform', VF),
      texture(15, 'float', '2d', VF), texture(16, 'float', '2d', VF), sampler(18, 'filtering', VF), buffer(19, 'uniform', VF),
      texture(20, 'depth', '2d', VF), sampler(21, 'comparison', VF), buffer(24, 'read-only-storage', VF),
    ] });
    const clouds = device.createBindGroupLayout({ label: 'meadow blades clouds', entries: [
      buffer(0, 'uniform', VF), texture(5, 'float', '2d', VF), sampler(6, 'filtering', VF),
    ] });
    const layout = device.createPipelineLayout({ label: 'meadow blades view', bindGroupLayouts: [view, clouds] });
    const drawModule = await shader(meadowBladesDrawWGSL(), 'meadow blades view');
    const draws = [];
    for (const segments of MEADOW_BLADE_SEGMENTS) {
      draws.push(await device.createRenderPipelineAsync({
        label: `meadow blades ${segments}`, layout,
        vertex: { module: drawModule, entryPoint: 'meadowBladeVS', constants: { MEADOW_BLADE_SEGMENTS_DRAWN: segments } },
        fragment: { module: drawModule, entryPoint: 'meadowBladeFS', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: samples },
      }));
    }
    return { layouts, passes, view, draws };
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
  const swardName = pack?.sward;
  const sward = MEADOW_SWARDS[swardName];
  if (!sward) return null;
  void shadowFormat; void waterOptics; void capacityLimit; void worldOffset;
  const B = GPUBufferUsage;
  const land0 = new Map(resources);
  const frame = land0.get(0)?.buffer;
  if (!frame) throw Error('The meadow is lit by the land\'s frame, and there is none');
  const programs = await requestMeadowBladePrograms(device, shader, format, samples);
  // A strand for a margin sows it behind the beaches.
  const coast = swardName === 'tropical';
  const mkBuf = (label, size, usage, data = null) => {
    const buf = device.createBuffer({ label, size: Math.max(16, size), usage });
    if (data?.byteLength) device.queue.writeBuffer(buf, 0, data);
    return buf;
  };
  const room = isMobile ? MEADOW_BLADE_ROOM.mobile : isSecondary ? MEADOW_BLADE_ROOM.secondary : MEADOW_BLADE_ROOM.primary;
  const label = isSecondary ? 'meadow secondary' : 'meadow';
  const lists = room.slice(0, 3).map((n, k) => mkBuf(`${label} blades ${MEADOW_BLADE_SEGMENTS[k]}`, n * MEADOW_BLADE_RECORD_BYTES, B.STORAGE));
  const cells = mkBuf(`${label} blade cells`, (MEADOW_BLADE_CELL_HEADER + 2 * room[3]) * 4, B.STORAGE | B.INDIRECT | B.COPY_SRC);
  const draws = mkBuf(`${label} blade draws`, MEADOW_BLADE_DRAW_WORDS * 4, B.STORAGE | B.INDIRECT | B.COPY_SRC);

  // The sward, and each mix's mean colour far off.
  const packed = packMeadowSward(sward);
  const swardBuf = mkBuf(`${label} sward`, MEADOW_SWARD_BYTES, B.UNIFORM | B.COPY_DST, new Uint8Array(packed.data));
  // The uniform the passes and the draws read: MeadowCfg.
  const cfgData = new ArrayBuffer(MEADOW_CONTINUUM_CFG_BYTES);
  const cfgF = new Float32Array(cfgData), cfgU = new Uint32Array(cfgData);
  const cfgBuf = mkBuf(`${label} cfg`, MEADOW_CONTINUUM_CFG_BYTES, B.UNIFORM | B.COPY_DST);
  cfgU.set([samples, coverSize, room[2], 1], 4);
  cfgF.set([continuumPixelError(), MEADOW_GUST_WAVE, 0, 0], 16);
  cfgU[22] = isSecondary ? 0 : 1; // cfg.more.z: 1 when primary section (landLight valid), 0 for secondary sections
  packed.means.forEach((mean, m) => cfgF.set([...mean, 1], 24 + m * 4));
  let cfgDirty = true;
  // The per-frame uniform: MeadowBladeFrame.
  const frameData = new ArrayBuffer(MEADOW_BLADE_FRAME_BYTES);
  const frameF = new Float32Array(frameData), frameU = new Uint32Array(frameData);
  const frameBuf = mkBuf(`${label} blade frame`, MEADOW_BLADE_FRAME_BYTES, B.UNIFORM | B.COPY_DST);
  frameU.set(room, 8);

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
  const wakeBuf = mkBuf(`${label} ballistic wakes`, MEADOW_WAKE_BUFFER_BYTES, B.UNIFORM | B.COPY_DST, new Uint8Array(wakeData));
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
    label: `${label} cover`,
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
        label: `${label} elevation`,
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

  // The passes' bind groups, one a pass, and the draws', one a list: rebuilt when the land's resources or the
  // craters change.
  let activeResources = resources;
  let passGroups = null, viewGroups = null;
  const cloudGroup = clouds.bindVolume(programs.draws[0], 'shadow');
  function buildGroups() {
    if (!elevationView) return;
    const land = new Map(activeResources);
    const craterLookupView = (boundCraters?.lookupTexture ?? fallbackCraterLookup).createView();
    const craterFieldView = (boundCraters?.fieldTexture ?? fallbackCraterField).createView({ dimension: '2d-array' });
    const resource = {
      0: land.get(0), 1: { buffer: cfgBuf }, 2: { buffer: nearDomain }, 3: elevationView, 4: coverView, 5: { buffer: swardBuf },
      6: { buffer: lists[0] }, 7: { buffer: draws }, 8: { buffer: cells }, 9: { buffer: wakeBuf }, 10: craterLookupView, 11: craterFieldView,
      12: land.get(8), 13: continuumGroundView(device), 14: { buffer: frameBuf }, 15: { buffer: cells }, 16: { buffer: lists[1] }, 17: { buffer: lists[2] },
    };
    passGroups = Object.fromEntries(Object.entries(MEADOW_BLADE_PASSES).map(([name, ids]) => [name, device.createBindGroup({
      label: `${label} blades ${name}`, layout: programs.layouts[name], entries: ids.map((binding) => ({ binding, resource: resource[binding] })),
    })]));
    viewGroups = lists.map((list, k) => {
      const own = new Map([
        [5, { buffer: cfgBuf }], [6, { buffer: swardBuf }], [7, { buffer: frameBuf }], [8, { buffer: list }], [9, { buffer: nearDomain }],
        [15, land.get(5)], [16, coverView], [18, land.get(8)],
      ]);
      return device.createBindGroup({
        label: `${label} blades view ${MEADOW_BLADE_SEGMENTS[k]}`, layout: programs.view,
        entries: MEADOW_BLADE_VIEW_BINDINGS.map((binding) => ({ binding, resource: own.get(binding) ?? land.get(binding) })),
      });
    });
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
    let texels = 0;
    for (let i = 0; i < map.length; i += 4) if (map[i] >= 32) texels++;
    coverTexels = texels;
    cfgF.set([curRegion.x, curRegion.z, curRegion.span, MEADOW_WATERLINE], 0);
    syncCraterCfg(curRegion);
    if (elevResized || !passGroups) buildGroups();
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

  const cellGroups = Math.ceil(MEADOW_BLADE_GRID * MEADOW_BLADE_GRID / 64);
  return {
    stats: {
      loaded: true,
      backend: 'blades',
      pack: swardName,
      mixes: MEADOW_MIX_ROLES.slice(),
      species: sward.mixes.reduce((n, m) => n + m.species.length, 0),
      coverSize,
      coast,
      isSecondary: Boolean(isSecondary),
      submerged: false,
      capacity: room.slice(0, 3).reduce((n, k) => n + k, 0),
      room: room.slice(),
      bufferBytes: room.slice(0, 3).reduce((n, k) => n + k * MEADOW_BLADE_RECORD_BYTES, 0) + (MEADOW_BLADE_CELL_HEADER + 2 * room[3]) * 4,
      get coveredTexels() { return coverTexels; },
    },
    sync,
    bindCraters,
    setBallisticWakes,
    rebind(nextResources) {
      activeResources = nextResources;
      buildGroups();
    },
    // The passes read where the frame lies in the world from the land's near domain.
    setWorldOffset() {},
    // In the frame's compute pass: the cells in view listed, their blades sown, kept and leaned, and each list's draw
    // written.
    encode(pass) {
      active = !destroyed && coverTexels > 0 && passGroups !== null;
      if (!active) return;
      const scale = continuumPixelError() / CONTINUUM_BASE_PIXEL_ERROR, mp = continuumProfile('meadow');
      const least = CONTINUUM_MIN_PIXELS * scale * (isMobile ? MEADOW_BLADE_MOBILE_COARSER : 1);
      const shot = cfgF[11] > 0.5 || !wakesWereEmpty ? 1 : 0;
      if (frameF[0] !== Math.fround(least) || frameF[1] !== Math.fround(CONTINUUM_SPLAT_PIXELS * scale) || frameF[4] !== Math.fround(mp.maxDistance) || frameU[12] !== shot || frameF[2] !== Math.fround(MEADOW_BLADE_DEPTH)) {
        frameF.set([least, CONTINUUM_SPLAT_PIXELS * scale, MEADOW_BLADE_DEPTH, MEADOW_BLADE_REACH, mp.maxDistance, 0, 0, 0], 0);
        frameU[12] = shot;
        device.queue.writeBuffer(frameBuf, 0, frameData);
      }
      if (cfgDirty) { device.queue.writeBuffer(cfgBuf, 0, cfgData); cfgDirty = false; }
      const P = programs.passes;
      pass.setPipeline(P.reset);
      pass.setBindGroup(0, passGroups.reset);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(P.cells);
      pass.setBindGroup(0, passGroups.cells);
      pass.dispatchWorkgroups(cellGroups, MEADOW_BLADE_LEVELS);
      pass.setPipeline(P.args);
      pass.setBindGroup(0, passGroups.args);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(P.sow);
      pass.setBindGroup(0, passGroups.sow);
      pass.dispatchWorkgroupsIndirect(cells, 4);
      pass.setPipeline(P.finish);
      pass.setBindGroup(0, passGroups.finish);
      pass.dispatchWorkgroups(1);
    },
    draw(pass) {
      if (!active || destroyed) return;
      for (let k = 0; k < 3; k++) {
        pass.setPipeline(programs.draws[k]);
        pass.setBindGroup(0, viewGroups[k]);
        pass.setBindGroup(1, cloudGroup);
        pass.drawIndirect(draws, k * 16);
      }
    },
    // Blades cast no shadow of their own into the land's map: the sward shades itself, darker toward its foot.
    drawShadow(_pass) {},
    // Meadow grass only grows above MEADOW_WATERLINE (0.75 m); no-op so submerged capture never redraws dry-land grass.
    drawSubmerged(_pass, _above = false) {},
    // For tests and diagnosis only, never a frame: the blades each list was given (and room for), the splats'
    // breadth and the cells listed.
    async readCounts() {
      const read = device.createBuffer({ label: `${label} counts read`, size: 96, usage: B.MAP_READ | B.COPY_DST });
      const encoder = device.createCommandEncoder({ label: `${label} counts read` });
      encoder.copyBufferToBuffer(draws, 0, read, 0, 64);
      encoder.copyBufferToBuffer(cells, 0, read, 64, 32);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      read.destroy();
      return { near: words[12], middle: words[13], far: words[14], breadth: new Float32Array(words.buffer)[15], cells: words[16], room: room.slice() };
    },
    // The indirect draws the view submits, for the continuum census (js/continuum-census.js).
    continuumDraws() {
      return active && !destroyed ? [{ buffer: draws, offset: 0, records: 3, stride: 4 }] : [];
    },
    destroy() {
      destroyed = true;
      active = false;
      unsubscribeCraters?.();
      unsubscribeCraters = null;
      boundCraters = null;
      for (const buf of [...lists, cells, draws, swardBuf, cfgBuf, frameBuf, wakeBuf]) buf?.destroy();
      fallbackCraterLookup.destroy();
      fallbackCraterField.destroy();
      coverTexture.destroy();
      ownedElevation?.destroy();
      ownedElevation = null;
    },
  };
}

// The meadow of a neighbouring coastal section: its own cover map and blades, the same programs, less room.
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
