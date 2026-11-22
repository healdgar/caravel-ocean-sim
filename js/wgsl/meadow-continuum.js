// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Meadow grass in the one continuum's pipeline family (js/wgsl/continuum-cut.js): the pass that stands its patches and
// the material that wears them. Their cut, their shadow, their capture under water and their sway are the one cut's
// (the WIND kind, draped, js/wgsl/continuum-wind.js); this is only where each 4 m patch stands each frame and how its
// sward is worn (js/meadow-continuum.js for the atlas, js/meadow-grass.js for the cover map and the CPU's part).
//   stand     the blocks of 16 x 16 patches in view, or in the shadow map's box, that hold any grass are listed and
//             counted by their distance; the records are spent nearest first, every patch near and, where a view asks
//             more than the scene holds, far blocks stood coarser, one record stretched over many patches; then one
//             workgroup a listed block writes each of its patches the cover map grows as a record of the one format:
//             its variant (the mix growing most at its middle, one of four by a hash of where it lies), stood on the
//             ground the land draws, as tall as the meadow's lushness and billow grow it and shot presses it, draped
//             over the ground under its square, swayed by the gust fronts rolling downwind across the meadow, and
//             parted by passing shot and blast rings. The select's workgroups are written for an indirect dispatch.
//   material  the sward's own colour, lit as the old meadow lit it: wind-ripple sheen, translucent seed heads, crater
//             soot and singe. A far body or splat shows the ground through the share its sward lets the eye see. Where
//             the cover map thins the sward, where water or a crater takes it, the material keeps fewer of a pixel's
//             samples (rule 2: a cut by the sample mask alone): clump by clump for the sward, evenly for the rest.
// Grass is never a target: shot passes through it.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SHADOW_FRAME, LAND_CLOTH_SHADOW } from './shadows.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SHADOW_BINDINGS } from './clouds.js';
import { LAND_CRATER_SAMPLE_WGSL, LAND_CRATER_TEXELS, LAND_CRATER_CELL_M, LAND_CRATER_TILE_M } from './land-craters.js';
import { CONTINUUM_RECORD_WGSL, CONTINUUM_ROW } from './continuum-cut.js';
import { CONTINUUM_WIND_FORM, CONTINUUM_WIND_DRAPED_POSE } from './continuum-wind.js';
import { CONTINUUM_HEADER, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, CONTINUUM_KIND, CONTINUUM_KIND_SHIFT, CONTINUUM_STRETCHED } from '../continuum-format.js';
import { CONTINUUM_GROUNDED, continuumGroundWGSL } from '../continuum-ground.js';
import { MEADOW_PATCH_METRES, MEADOW_CONTINUUM_MATERIAL, MEADOW_CONTINUUM_STIFFNESS_UNIT } from '../meadow-continuum.js';

export const MEADOW_MAX_SHOT_WAKES = 16;
export const MEADOW_MAX_BLAST_RINGS = 16;
export const MEADOW_WAKE_BUFFER_BYTES = 1040; // 16B counts + 16 * 32B ShotWake + 16 * 32B BlastRing = 1040B
// Patches to a block's side: the stand pass lists the blocks in view, then stands their patches.
export const MEADOW_BLOCK_PATCHES = 16;
// The scene's records are spent nearest first. Each listed block is counted in a band of its distance from the eye
// (three to an octave, from 8 m), at each grain it could be stood at: a patch of 4 m, or 2, 4, 8 or 16 patches to a
// side as one record stretched over them (CONTINUUM_STRETCHED). The bands nearest the eye keep the finest grain the
// records allow; beyond, a band's grain doubles with each octave, so a far record's size on screen stays a near one's.
export const MEADOW_BANDS = 32, MEADOW_GRAINS = 5;
// The blocks-in-view list begins with its own indirect dispatch, then each band's count at each grain and the grain
// each band is stood at.
export const MEADOW_WORK_HEADER = 4 + MEADOW_BANDS * (MEADOW_GRAINS + 1);
// A block's upper bounds of the records it can take at each grain (meadowBlockGrains), in one word: 9, 7, 5, 3 and 1
// bits from the finest.
export const MEADOW_GRAIN_BITS = Object.freeze([[0, 9], [9, 7], [16, 5], [21, 3], [24, 1]]);
// A patch's pose data, in vec4f: its stretch (STRETCHED), then the WIND kind's for a draped body.
export const MEADOW_CONTINUUM_POSE = 1 + CONTINUUM_WIND_DRAPED_POSE;
// The shared uniform, MeadowCfg: 9 vec4.
export const MEADOW_CONTINUUM_CFG_BYTES = 144;
// The stand pass's own buffer: the select's workgroups (x, y, z), then how many records it wrote.
export const MEADOW_CONTINUUM_STOOD_BYTES = 16;
// Where the scene's data binds in a meadow view: group 2. Group 0 is the meadow's own, group 1 the clouds'.
export const MEADOW_CONTINUUM_DATA = Object.freeze({ group: 2, binding: 0 });
// The gust's wave number along the wind: the 14 m rollers of the wind field (grassWindWave).
export const MEADOW_GUST_WAVE = (2 * Math.PI) / 14;
// A block's bounds: how far its sward reaches above its highest ground and its plants overhang its edge, and how far
// the GPU's ground may lie from the heights the CPU read.
const MEADOW_REACH_UP = 2.0, MEADOW_OVERHANG = 1.0, MEADOW_GROUND_SLACK = 2.0;

// What the stand pass and the material both know: the hash, the ground, the shared uniform, the mixes, the wind and
// what shot does to grass.
const MEADOW_COMMON_WGSL = LAND_CRATER_SAMPLE_WGSL + /* wgsl */ `
const MEADOW_PATCH: f32 = ${MEADOW_PATCH_METRES.toFixed(4)};
const MEADOW_BLOCK: i32 = ${MEADOW_BLOCK_PATCHES};
struct MeadowNearDomain {
  domain: vec4f,
  grid: vec4f
};
struct MeadowCfg {
  domain: vec4f, // the cover map's region: centre x, z, span; the waterline
  params: vec4u, // samples a pixel, the cover map's size, records the stand pass may write, 1 when shadows are cast
  crater: vec4f, // the crater field's origin x, z, its tile metres, 1 when bound
  blocks: vec4i, // the region's first block x, z; blocks across x, z
  scene: vec4f,  // the scene's pixel error (js/continuum-core.js), the gust's wave number, 0, 0
  more: vec4u,   // 0, blocks in the region, 1 when primary section (landLight valid), 0
  mixes: array<vec4f, 3> // each mix's (lowland, upland, margin) colour (linear) and cover from above: its variants' mean
};
struct ShotWake {
  posRad: vec4f,    // x, y, z (unshifted coast world m), signedRadius (< 0 = hot shot)
  velTrail: vec4f   // vx, vy, vz (m/s), trailLen (m)
};
struct BlastRing {
  posAge: vec4f,    // x, y, z (unshifted coast world m), ageSec
  params: vec4f     // strength, speed (26 m/s), maxAge (2.2 s), hot
};
// 1040-byte ballistic air-wake & impact shockwave uniform buffer (16 + 16*32 + 16*32 = 1040 bytes).
struct MeadowWakeFrame {
  counts: vec4u,    // shotCount (<= 16), ringCount (<= 16), 0, 0
  shots: array<ShotWake, ${MEADOW_MAX_SHOT_WAKES}>,
  rings: array<BlastRing, ${MEADOW_MAX_BLAST_RINGS}>
};
struct MeadowBallisticDeform {
  pushXZ: vec2f,
  pressDown: f32,
  buryDepth: f32,
  hotSinge: f32
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
fn meadowDomainUV(unshiftedXZ: vec2f) -> vec2f {
  return clamp((unshiftedXZ - cfg.domain.xy) / cfg.domain.z + 0.5, vec2f(0.0002), vec2f(0.9998));
}
// The cover map at a point: how much grass grows (r), its role (g: 0 lowland, 0.5 upland, 1 margin), its lushness (b).
fn meadowCoverAt(unshiftedXZ: vec2f) -> vec4f {
  return textureSampleLevel(meadowCover, landSampler, meadowDomainUV(unshiftedXZ), 0.0);
}
// A smooth field over the world in 0..1 that changes over some 40 m: value noise on a lattice of hashed corners.
fn meadowDrift(at: vec2f) -> f32 {
  let p = at / 41.0;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  let h = vec4f(f32(meadowHash2(i) & 65535u), f32(meadowHash2(i + vec2i(1, 0)) & 65535u), f32(meadowHash2(i + vec2i(0, 1)) & 65535u), f32(meadowHash2(i + vec2i(1, 1)) & 65535u)) / 65535.0;
  return mix(mix(h.x, h.y, u.x), mix(h.z, h.w, u.x), u.y);
}
// How much of each mix (lowland, upland, margin) grows at a point, from the cover map's role and, where upland, a
// drift into margin tens of metres across. A patch takes the mix with the most at its middle; a far body's colour and
// cover blend them point by point, so where the mix changes no patch's edge shows.
fn meadowMixWeights(role: f32, at: vec2f) -> vec3f {
  let margin = max(smoothstep(0.67, 0.77, role), smoothstep(0.30, 0.40, role) * smoothstep(0.57, 0.67, meadowDrift(at)));
  let upland = smoothstep(0.19, 0.29, role) * (1.0 - margin);
  return vec3f(1.0 - margin - upland, upland, margin);
}
// The colour (linear) and the share of the ground the sward hides from above, of the mixes at a point.
fn meadowMixMean(role: f32, at: vec2f) -> vec4f {
  let w = meadowMixWeights(role, at);
  return w.x * cfg.mixes[0] + w.y * cfg.mixes[1] + w.z * cfg.mixes[2];
}
// The share of the ground a sward that hides 'cover' of it from above hides seen at 'cosine' to its normal: each
// layer of it the line of sight crosses lets through as much as one does from above.
fn meadowHides(cover: f32, cosine: f32) -> f32 { return 1.0 - pow(clamp(1.0 - cover, 0.0, 1.0), 1.0 / max(abs(cosine), 0.04)); }
fn meadowWindDirection() -> vec2f {
  let raw = F.windP[0].xy;
  return select(vec2f(0.82, 0.57), normalize(raw), dot(raw, raw) > 0.0004);
}

// Travelling multi-octave wind-gust wave advecting downwind at windSpeed * 1.15:
//   - 14.0 m primary gust rollers (k1 = 2*pi / 14.0 = 0.4488), the stand pass's gust fronts
//   -  4.5 m secondary wind ripples (k2 = 2*pi / 4.5 = 1.3963)
//   - Curved across-wind wavefronts + travelling gust-cell packets
fn meadowWindField(worldXZ: vec2f, time: f32, windParam: vec4f) -> vec2f {
  let windDir = meadowWindDirection();
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let rawSpeed = max(windParam.z, 0.0);
  let speed = max(rawSpeed, 0.8);
  let advect = time * speed * 1.05;
  let u = dot(worldXZ, windDir);
  let v = dot(worldXZ, acrossDir);
  let frontWarp = sin(v * 0.085 + time * 0.24) * 2.35 + cos(v * 0.19 - time * 0.31) * 1.15;
  let roller14 = sin((u - advect) * 0.4488 + frontWarp);
  let ripple45 = sin((u - advect * 1.06) * 1.3963 + cos(v * 0.48 - time * 0.52) * 1.40);
  let fineWave = sin((u - advect * 1.14) * 2.35 + sin(v * 0.92 + time * 0.72) * 1.05);
  let gustPacket = 0.56 + 0.44 * sin((u - advect * 0.82) * 0.165 + sin(v * 0.072) * 1.8) * cos(v * 0.095 + time * 0.21);
  let windGain = smoothstep(0.35, 9.5, rawSpeed);
  let swell = (roller14 * 0.60 + ripple45 * 0.28 + fineWave * 0.12) * gustPacket * windGain;
  let gust01 = smoothstep(-0.50, 0.76, swell) * windGain;
  return vec2f(gust01, swell);
}
fn meadowWindCurl(worldXZ: vec2f, time: f32, windDir: vec2f, speed: f32) -> f32 {
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let advect = time * max(speed, 0.8) * 1.05;
  let u = dot(worldXZ, windDir) - advect;
  let v = dot(worldXZ, acrossDir);
  return sin(v * 1.38 + u * 0.42) * cos(u * 1.12 - v * 0.54 + time * 1.35);
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
`;

// ---------------------------------------------------------------------------------------------- the stand pass
// Each pass has its own bind group layout (js/meadow-grass.js), so the blocks-in-view list is written by one pass and
// read, and dispatched from, by the next.
export function meadowContinuumStandWGSL() {
  const T = CONTINUUM_TYPE, M = MEADOW_CONTINUUM_MATERIAL, W = CONTINUUM_WIND_FORM;
  const tag = ((CONTINUUM_KIND.WIND << CONTINUUM_KIND_SHIFT) | CONTINUUM_STRETCHED | CONTINUUM_GROUNDED) >>> 0;
  return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_RECORD_WGSL + continuumGroundWGSL(0, 17) + MEADOW_COMMON_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> cfg: MeadowCfg;
@group(0) @binding(2) var<uniform> nearTerrain: MeadowNearDomain;
@group(0) @binding(3) var elevation: texture_2d<f32>;
@group(0) @binding(4) var meadowCover: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> meadowAtlas: array<u32>;
@group(0) @binding(6) var<storage, read> meadowBlocks: array<vec4f>;            // a block's most cover, lowest and highest ground, records at each grain (bits)
@group(0) @binding(7) var<storage, read_write> meadowRecords: array<ContinuumRecord>;
@group(0) @binding(8) var<storage, read_write> meadowPoses: array<vec4f>;
@group(0) @binding(9) var<storage, read_write> meadowStood: array<atomic<u32>, 4>;
@group(0) @binding(10) var<storage, read_write> meadowBlockWork: array<atomic<u32>>; // the blocks in view, as the blocks pass writes them
@group(0) @binding(11) var<storage, read> meadowBlockList: array<u32>;             // and as the patches pass reads them
@group(0) @binding(12) var<uniform> shadowBox: ShadowFrame;                        // the land's shadow map (js/shadows.js)
@group(0) @binding(13) var<uniform> wakes: MeadowWakeFrame;
@group(0) @binding(14) var landCraterLookup: texture_2d<i32>;
@group(0) @binding(15) var landCraterField: texture_2d_array<f32>;
@group(0) @binding(16) var landSampler: sampler;
// A block listed for the camera carries this bit; one listed for the sun alone does not. Its band lies in the 5 bits
// below it.
const MEADOW_SEEN: u32 = 0x80000000u;
const MEADOW_BAND_SHIFT: u32 = 24u;
const MEADOW_WORK: u32 = ${MEADOW_WORK_HEADER}u;
const MEADOW_BANDS: u32 = ${MEADOW_BANDS}u;
const MEADOW_GRAINS: u32 = ${MEADOW_GRAINS}u;
// Where each band's counts (a word a grain) and then each band's grain lie in the blocks-in-view buffer.
const MEADOW_COUNTS: u32 = 4u;
const MEADOW_GRAIN: u32 = ${4 + MEADOW_BANDS * MEADOW_GRAINS}u;
fn meadowFocal() -> f32 { return F.screen.y / max(2.0 * length(F.camUp.xyz), 1e-4); }
fn meadowShift() -> vec3f { return vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z); }
fn meadowStandTypeF(model: u32, field: u32) -> f32 { return bitcast<f32>(meadowAtlas[meadowAtlas[${CONTINUUM_HEADER.typesAt}u] + model * ${CONTINUUM_TYPE_WORDS}u + field]); }
fn meadowOutside(at: vec3f, reach: f32) -> bool {
  let m = F.viewProj; let p = vec4f(at, 1.0);
  let w = vec4f(m[0].w, m[1].w, m[2].w, m[3].w); let x = vec4f(m[0].x, m[1].x, m[2].x, m[3].x); let y = vec4f(m[0].y, m[1].y, m[2].y, m[3].y);
  var planes = array<vec4f, 5>(w + x, w - x, w + y, w - y, w);
  for (var i = 0u; i < 5u; i++) { if (dot(planes[i], p) < -reach * length(planes[i].xyz)) { return true; } }
  return false;
}
// Whether a sphere about 'at' (the scene's frame, as the one cut casts it) reaches into the sun's box, when the land
// casts shadows.
fn meadowInLight(at: vec3f, reach: f32) -> bool {
  if (cfg.params.w == 0u || shadowBox.origin.w < 0.5) { return false; }
  let m = shadowBox.lightView;
  let scales = vec3f(length(vec3f(m[0].x, m[1].x, m[2].x)), length(vec3f(m[0].y, m[1].y, m[2].y)), length(vec3f(m[0].z, m[1].z, m[2].z))) * reach;
  let lit = (m * vec4f(at - shadowBox.origin.xyz, 1.0)).xyz;
  return abs(lit.x) <= 1.0 + scales.x && abs(lit.y) <= 1.0 + scales.y && lit.z >= -scales.z && lit.z <= 1.0 + scales.z;
}
// The ground the land draws at a point (js/continuum-ground.js), in the scene's frame.
fn meadowDrawnGround(at: vec2f, shift: vec3f) -> f32 { return meadowGroundY(at, cfg.domain, elevation) + continuumGroundLift(at + shift.xz); }

// The stand emptied, the blocks-in-view list's dispatch set and every band's counts cleared.
@compute @workgroup_size(64) fn meadowStandReset(@builtin(local_invocation_index) i: u32) {
  if (i == 0u) { atomicStore(&meadowStood[3], 0u); }
  for (var k = i; k < MEADOW_WORK; k += 64u) { atomicStore(&meadowBlockWork[k], select(0u, 1u, k == 1u || k == 2u)); }
}

// One thread a block of the region: those holding grass above the waterline and in view, or in the sun's box, are
// listed (marked MEADOW_SEEN for the camera, with their band), counted in their band at every grain, and the patches
// pass is dispatched once for each.
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
  // The sward stands on the ground the land draws (js/continuum-ground.js), off the true ground by up to its bound.
  let size = length(vec3f(side * 0.5 + ${MEADOW_OVERHANG.toFixed(1)}, (top - bottom) * 0.5, side * 0.5 + ${MEADOW_OVERHANG.toFixed(1)}));
  let dist = length(centre + meadowShift() - F.camPos.xyz);
  let nearDist = max(dist - size, 0.0);
  let reach = size + continuumGroundBound(cfg.scene.x, meadowFocal(), dist + size);
  let seen = (cfg.scene.z <= 0.0 || nearDist < cfg.scene.z) && !meadowOutside(earthCurve(centre + meadowShift() - F.camPos.xyz, F.camPos.y), reach);
  let lit = (cfg.scene.w <= 0.0 || nearDist <= cfg.scene.w) && meadowInLight(centre, reach);
  if (!seen && !lit) { return; }
  let band = u32(clamp(floor(log2(max(nearDist, 8.0) / 8.0) * 3.0), 0.0, f32(MEADOW_BANDS - 1u)));
  let most = bitcast<u32>(data.w);
  var bits = array<vec2u, 5>(${MEADOW_GRAIN_BITS.map(([at, n]) => `vec2u(${at}u, ${(1 << n) - 1}u)`).join(', ')});
  for (var g = 0u; g < MEADOW_GRAINS; g++) { atomicAdd(&meadowBlockWork[MEADOW_COUNTS + band * MEADOW_GRAINS + g], (most >> bits[g].x) & bits[g].y); }
  let at = atomicAdd(&meadowBlockWork[0], 1u);
  atomicStore(&meadowBlockWork[MEADOW_WORK + at], id.x | (band << MEADOW_BAND_SHIFT) | select(0u, MEADOW_SEEN, seen));
}

// The grain of each band, the nearest first: the finest that fits the records, as far out as it can go. Bands from s
// out are coarsened, their grain doubling every three bands (an octave) beyond s; the search takes the farthest s
// whose bands' counts fit, so the near bands keep every patch and an overflow coarsens only the far. Each count is an
// upper bound of the records its blocks take at that grain, so no patch is ever stood past the scene's capacity.
fn meadowGrainFrom(band: u32, s: i32) -> u32 { return select(u32(min((i32(band) - s) / 3 + 1, i32(MEADOW_GRAINS) - 1)), 0u, i32(band) < s); }
@compute @workgroup_size(1) fn meadowStandBudget() {
  // Size the fine grain=1 (4 m) radius directly from the live grazing perspective cutoff so tuning pixel error
  // from 1 px ("best") to coarser budgets keeps 3D cluster patches at grain=1 while coarsening pure 2D bands beyond.
  let grazingDist = 0.145 * meadowFocal() / max(cfg.scene.x, 1.0);
  var s = i32(clamp(ceil(log2(max(grazingDist, 32.0) / 8.0) * 3.0), 6.0, 12.0));
  for (; s > 6; s--) {
    var total = 0u;
    for (var b = 0u; b < MEADOW_BANDS; b++) { total += atomicLoad(&meadowBlockWork[MEADOW_COUNTS + b * MEADOW_GRAINS + meadowGrainFrom(b, s)]); }
    if (total <= cfg.params.z) { break; }
  }
  for (var b = 0u; b < MEADOW_BANDS; b++) { atomicStore(&meadowBlockWork[MEADOW_GRAIN + b], meadowGrainFrom(b, s)); }
}

// A point of a patch's square (x, z) turned about the vertical as its record's turn of cosine and sine cs turns it.
fn meadowTurned(p: vec2f, cs: vec2f) -> vec2f { return vec2f(p.x * cs.x + p.y * cs.y, p.y * cs.x - p.x * cs.y); }

// One patch stood as a record of the one cut, if grass grows on it and it is in view or in the sun's box: a patch of
// the cover map's own, or at a coarser grain (its band's, meadowStandBudget) as many patches to a side, one record
// stretched over them.
fn meadowStandPatch(cell: vec2i, grain: u32, blockSeen: bool) {
  let g = f32(grain);
  let origin = vec2f(cell) * MEADOW_PATCH;
  let half = MEADOW_PATCH * 0.5 * g;
  let middle = origin + vec2f(half);
  let uv = (middle - cfg.domain.xy) / cfg.domain.z + 0.5;
  if (any(uv <= vec2f(0.0002)) || any(uv >= vec2f(0.9998))) { return; }
  // Grass where the cover map grows it at its middle or a corner (a coarse patch: anywhere on a lattice of at most
  // five points a side over it), on dry ground.
  let cover = meadowCoverAt(middle);
  var corners = max(max(meadowCoverAt(middle + vec2f(half, half)).r, meadowCoverAt(middle + vec2f(-half, half)).r), max(meadowCoverAt(middle + vec2f(half, -half)).r, meadowCoverAt(middle + vec2f(-half, -half)).r));
  if (grain > 1u) {
    let steps = min(grain, 4u);let step = 2.0 * half / f32(steps);
    for (var j = 0u; j <= steps && corners < 0.02; j++) { for (var i = 0u; i <= steps; i++) { corners = max(corners, meadowCoverAt(origin + vec2f(f32(i), f32(j)) * step).r); } }
  }
  if (max(cover.r, corners) < 0.02) { return; }
  let ground = meadowGroundY(middle, cfg.domain, elevation);
  if (ground < cfg.domain.w) { return; }
  let shift = meadowShift();
  // Conservative early frustum + light-box rejection before ballistics, 5x drawn-ground, 4x cover/billow & wind math.
  let approxCentre = vec3f(middle.x, ground + 0.45, middle.y);
  let approxRel = approxCentre + shift - F.camPos.xyz;
  let approxReach = half * 1.65 + 4.5 + continuumGroundBound(cfg.scene.x, meadowFocal(), max(length(approxRel), 1.0));
  let approxSeen = blockSeen && !meadowOutside(earthCurve(approxRel, F.camPos.y), approxReach);
  if (!approxSeen && !meadowInLight(approxCentre, approxReach)) { return; }
  // Its variant: the mix (lowland, upland, margin) with the most of its middle, one of four, and turned a quarter
  // turn one way or another about its middle, each by a hash of where it lies, so no variant's grain runs the same
  // way down a row of patches. Every variant's square is alike at its edge, so turned it still meets its neighbours.
  // Anchor seed & variant to the stable 4 m world center cell so distant grain coarsening keeps consistent grass tone.
  let seed = meadowHash2(vec2i(floor(middle / MEADOW_PATCH)));
  let pick = meadowHash(seed ^ 0x68e31da4u);
  let mixes = meadowMixWeights(cover.g, middle);
  let model = select(select(0u, 1u, mixes.y > mixes.x), 2u, mixes.z > max(mixes.x, mixes.y)) * 4u + (pick & 3u);
  let quarter = (pick >> 2u) & 3u;
  // The turn's cosine and sine, and the quaternion that turns its type's +x toward -z by as much (continuumQuat).
  let turnCS = select(
    select(vec2f(1.0, 0.0), vec2f(0.0, 1.0), quarter == 1u),
    select(vec2f(-1.0, 0.0), vec2f(0.0, -1.0), quarter == 3u),
    quarter >= 2u
  );
  let turn = select(
    select(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(0.0, 0.70710678, 0.0, 0.70710678), quarter == 1u),
    select(vec4f(0.0, 1.0, 0.0, 0.0), vec4f(0.0, 0.70710678, 0.0, -0.70710678), quarter == 3u),
    quarter >= 2u
  );
  // It stands on the true ground under its middle, and the one cut raises it at its anchor (GROUNDED) to the ground
  // the land draws there: the view's cut in the view and its shadow, the captures' under water. Its anchor is where its
  // type's corner falls, turned about the middle.
  let anchor = middle - meadowTurned(vec2f(half), turnCS);
  let place = vec3f(anchor.x, ground, anchor.y);
  let lifted = continuumGroundLift(anchor + shift.xz);
  let stood = place.y + lifted;
  let distHint = length(vec3f(middle.x, stood, middle.y) + shift - F.camPos.xyz);
  var ballistics = MeadowBallisticDeform(vec2f(0.0), 0.0, 0.0, 0.0);
  if (distHint <= 90.0) {
    ballistics = meadowEvalBallistics(middle, ground, seed);
  }
  // Draped over the ground the view draws under the corners of its type's square (the WIND kind's DRAPED form), from
  // where its anchor is raised to, and sunk by as much as that drape would float over the ground drawn at its middle.
  // A capture raises it by its own cut at the anchor, and the drape carries it over the view's ground between. A
  // coarse patch's square is its type's stretched by its grain; its corners, in its type's order, where its turn puts
  // them.
  let low = vec2f(meadowStandTypeF(model, ${T.low}u), meadowStandTypeF(model, ${T.low + 2}u)) * g;
  let span = meadowStandTypeF(model, ${T.span}u) * g;
  let c0 = anchor + meadowTurned(low, turnCS);
  let c1 = anchor + meadowTurned(low + vec2f(span, 0.0), turnCS);
  let c2 = anchor + meadowTurned(low + vec2f(0.0, span), turnCS);
  let c3 = anchor + meadowTurned(low + vec2f(span), turnCS);
  // Drape each corner squarely onto the drawn ground; on convex ridges add the small positive clearance needed so
  // the patch's middle clears the crest rather than pushing the four corners under the terrain (which Z-fights).
  let d0 = meadowDrawnGround(c0, shift) - stood;
  let d1 = meadowDrawnGround(c1, shift) - stood;
  let d2 = meadowDrawnGround(c2, shift) - stood;
  let d3 = meadowDrawnGround(c3, shift) - stood;
  let midGround = meadowDrawnGround(middle, shift) - stood;
  let midGap = max(midGround - 0.25 * (d0 + d1 + d2 + d3), 0.0);
  let antiZFight = min(0.12, distHint * 0.00035) * smoothstep(35.0, 140.0, distHint);
  var drape = vec4f(d0, d1, d2, d3) + vec4f(midGap + antiZFight);
  // As tall as the meadow's lushness and billow grow it where each corner stands, pressed down by shot and blast and
  // sunk into a crater: the height is the ground's own field, so neighbours meet at one height and no row of patches
  // steps up or down from the next. Where the cover thins toward a path, a beach or a bank, its plants stand lower.
  // Both are the share standing at the corners, of the tallest.
  let k0 = meadowCoverAt(c0); let k1 = meadowCoverAt(c1); let k2 = meadowCoverAt(c2); let k3 = meadowCoverAt(c3);
  let pressed = (1.0 - 0.7 * ballistics.pressDown) * (1.0 - ballistics.buryDepth);
  let grows = clamp((vec4f(0.82) + 0.44 * vec4f(k0.b, k1.b, k2.b, k3.b)) * vec4f(meadowWorldBillow(c0).x, meadowWorldBillow(c1).x, meadowWorldBillow(c2).x, meadowWorldBillow(c3).x) * pressed, vec4f(0.05), vec4f(2.0));
  let tall = max(max(grows.x, grows.y), max(grows.z, grows.w));
  let thins = mix(vec4f(0.4), vec4f(1.0), smoothstep(vec4f(0.06), vec4f(0.55), vec4f(k0.r, k1.r, k2.r, k3.r))) * grows / tall;
  let standing = clamp((thins - vec4f(0.4)) / 0.6, vec4f(0.0), vec4f(1.0));
  // The gust fronts: the wind field's 14 m rollers rolling downwind (meadowWindField), each patch's sward bent as the
  // front crosses it (the kind's phase, less its wave number times how far downwind a point stands), as strongly as
  // the gust packet over it and the wind's speed bend it.
  let downwind = meadowWindDirection();
  let rawSpeed = max(F.windP[0].z, 0.0);
  let speed = max(rawSpeed, 0.8);
  let t = F.camPos.w;
  let u = dot(middle, downwind);
  let v = dot(middle, vec2f(-downwind.y, downwind.x));
  let advect = t * speed * 1.05;
  let warp = sin(v * 0.085 + t * 0.24) * 2.35 + cos(v * 0.19 - t * 0.31) * 1.15;
  let packet = 0.56 + 0.44 * sin((u - advect * 0.82) * 0.165 + sin(v * 0.072) * 1.8) * cos(v * 0.095 + t * 0.21);
  let wave = cfg.scene.y;
  let phase = 3.14159265 - 1.1 * t + wave * advect - warp;
  let windLean = smoothstep(0.5, 11.5, rawSpeed) * clamp(rawSpeed / 10.5, 0.0, 1.55);
  let strength = meadowStandTypeF(model, ${M.sway}u) * tall * (0.015 * smoothstep(0.2, 2.5, rawSpeed) + 0.64 * packet * windLean) * 0.75;
  // In view, or in the sun's box: its type's sphere where its stretch and drape put it, grown by its sway, its push
  // and how far the drawn ground may lie from the true.
  let sphere = vec4f(meadowStandTypeF(model, ${T.sphere}u), meadowStandTypeF(model, ${T.sphere + 1}u), meadowStandTypeF(model, ${T.sphere + 2}u), meadowStandTypeF(model, ${T.sphere + 3}u));
  let deviation = max(max(abs(drape.x), abs(drape.y)), max(abs(drape.z), abs(drape.w)));
  let centre = place + vec3f(sphere.x * g, lifted + sphere.y * tall + dot(drape, vec4f(0.25)), sphere.z * g);
  let radius = sphere.w * max(tall, g) + deviation + abs(strength) * 1.1 + length(ballistics.pushXZ);
  let relative = centre + shift - F.camPos.xyz;
  let reach = radius + continuumGroundBound(cfg.scene.x, meadowFocal(), length(relative) + radius);
  let seen = blockSeen && !meadowOutside(earthCurve(relative, F.camPos.y), reach);
  if (!seen && !meadowInLight(centre, reach)) { return; }
  // The budget (meadowStandBudget) leaves room for every record its bands can take; the test only guards the buffer.
  let slot = atomicAdd(&meadowStood[3], 1u);
  if (slot >= cfg.params.z) { return; }
  let pose = slot * ${MEADOW_CONTINUUM_POSE}u;
  // Stretched over its grain across, as tall as it grows; its sway and push in its type's metres across, so a coarse
  // patch sways the metres a fine one does.
  meadowPoses[pose] = vec4f(g, tall, g, 0.0);
  meadowPoses[pose + 1u] = vec4f(phase, strength / g, packet, ${W.DRAPED}.0);
  meadowPoses[pose + 2u] = drape / tall;
  let push = meadowTurned(ballistics.pushXZ, vec2f(turnCS.x, -turnCS.y)) / g;
  meadowPoses[pose + 3u] = vec4f(push.x, 0.0, push.y, wave);
  meadowPoses[pose + 4u] = standing;
  // Its seed is where it lies, so its samples' pattern and its splat's thinning are its own however the patches are
  // listed.
  meadowRecords[slot] = ContinuumRecord(vec4f(place, 1.0), turn, vec4u(model | ${tag}u, pose, seed, 0u), vec4u(0u));
}

// One workgroup a listed block, at its band's grain: four of its patches a lane at the finest, fewer and larger coarser.
@compute @workgroup_size(64) fn meadowStandPatches(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let listed = meadowBlockList[MEADOW_WORK + group.x];
  let block = listed & ((1u << MEADOW_BAND_SHIFT) - 1u);
  let coarse = meadowBlockList[MEADOW_GRAIN + ((listed >> MEADOW_BAND_SHIFT) & (MEADOW_BANDS - 1u))];
  let grain = 1u << coarse;
  let side = u32(MEADOW_BLOCK) >> coarse;
  let across = u32(max(cfg.blocks.z, 1));
  let first = (cfg.blocks.xy + vec2i(i32(block % across), i32(block / across))) * MEADOW_BLOCK;
  for (var k = 0u; k < 4u; k++) {
    let p = lane + k * 64u;
    if (p >= side * side) { break; }
    meadowStandPatch(first + vec2i(i32(p % side), i32(p / side)) * i32(grain), grain, (listed & MEADOW_SEEN) != 0u);
  }
}

// The select's workgroups for the records written, ${CONTINUUM_ROW} a row; every record of the last row past them gone.
@compute @workgroup_size(64) fn meadowStandFinish(@builtin(global_invocation_id) id: vec3u) {
  let n = min(atomicLoad(&meadowStood[3]), cfg.params.z);
  let across = min(n, ${CONTINUUM_ROW}u); let rows = (n + ${CONTINUUM_ROW - 1}u) / ${CONTINUUM_ROW}u;
  if (id.x == 0u) { atomicStore(&meadowStood[0], across); atomicStore(&meadowStood[1], rows); atomicStore(&meadowStood[2], 1u); }
  let tail = n + id.x;
  if (tail < across * rows && tail < cfg.params.z) { meadowRecords[tail].tag.x = CONTINUUM_GONE; }
}
`;
}

// ---------------------------------------------------------------------------------------------- the material
// Group 0: the frame, the sky's light, the meadow's uniform, ground, cover map and shot, and the land's light, albedo
// and shadow map. Group 1 is the clouds'; group 2 the scene's data; group 3 is left to the water's capture.
const meadowContinuumPreludeWGSL = () => FRAME_WGSL + ATMO_CORE_WGSL + SHADOW_FRAME + SKY_RENDER_FUNCS + CLOUD_SHADOW_BINDINGS + MEADOW_COMMON_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var<uniform> cfg: MeadowCfg;
@group(0) @binding(6) var elevation: texture_2d<f32>;
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
` + LAND_CLOTH_SHADOW + /* wgsl */ `
fn meadowGroundColour(unshiftedXZ: vec2f) -> vec3f {
  return pow(textureSampleLevel(landAlbedo, landSampler, meadowDomainUV(unshiftedXZ), 0.0).rgb, vec3f(2.2));
}
fn meadowShadowVis(world: vec3f, normal: vec3f) -> vec3f {
  if (landSH.origin.w < 0.5) { return vec3f(1.0); }
  let p = landSH.lightView * vec4f(world - landSH.origin.xyz + normal * 0.05 + landSH.sun.xyz * 0.04, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let fade = smoothstep(0.0, 0.06, edge) * step(0.0, p.z) * step(p.z, 1.0);
  if (fade <= 0.0) { return vec3f(1.0); }
  let refZ = min(p.z - 0.08 / max(landSH.sun.w, 1.0), 0.99999);
  let s = textureSampleCompareLevel(landSolidShadow, landShadowCompare, uv, refZ);
  return mix(vec3f(1.0), s * landClothShadow(uv, refZ), fade);
}
// Aperiodic isotropic hash-lattice value noise (zero sine stripes, zero checkerboard grids) for organic grass tussocks.
fn meadowOrganicNoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = f32(meadowHash2(i) & 65535u);
  let b = f32(meadowHash2(i + vec2i(1, 0)) & 65535u);
  let c = f32(meadowHash2(i + vec2i(0, 1)) & 65535u);
  let d = f32(meadowHash2(i + vec2i(1, 1)) & 65535u);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * (2.0 / 65535.0) - 1.0;
}

// Multi-scale screen-footprint-filtered organic grass tuft, tussock & panicle detail field
// (vec4f: density, crossTilt, oatCrest, clumpShadow). Every octave uses aperiodic rotated hash-lattice noise
// band-limited strictly before Nyquist so grass detail continues organically across CLUSTER -> FAR -> SPLAT
// all the way to the horizon with ZERO stripes, ZERO checkerboards, ZERO shimmer, and ZERO abrupt dropoff.
fn meadowSwardDetail(bentXZ: vec2f, pixel: f32, windDir: vec2f, gust: f32) -> vec4f {
  // Band 1: ~0.42 m crisp blade tufts & individual seed-head specks (near -> ~190 m)
  let wFine = 1.0 - smoothstep(0.08, 0.28, pixel);
  // Band 2: ~1.45 m organic meadow tussock clumps & golden-oat panicle clusters (near -> ~700 m)
  let wMid = 1.0 - smoothstep(0.32, 1.25, pixel);
  // Band 3: ~4.8 m irregular pasture turf patches & soil/sward mottling (mid -> horizon)
  let wBroad = 1.0 - smoothstep(1.40, 5.20, pixel);

  var sig = 0.0;
  var tilt = 0.0;
  var oat = 0.0;
  var shadow = 0.0;

  if (wFine > 0.001) {
    // Rotated aperiodic dual-scale blade-clump grain (2.4 m^-1 and 4.6 m^-1)
    let q0 = vec2f(bentXZ.x * 0.866 - bentXZ.y * 0.500, bentXZ.x * 0.500 + bentXZ.y * 0.866) * 2.35;
    let q1 = vec2f(bentXZ.x * 0.342 + bentXZ.y * 0.940, -bentXZ.x * 0.940 + bentXZ.y * 0.342) * 4.55 + vec2f(19.3, -11.7);
    let n0 = meadowOrganicNoise(q0);
    let n1 = meadowOrganicNoise(q1);
    let fSig = n0 * 0.58 + n1 * 0.42;
    let fSlope = meadowOrganicNoise(q0 + vec2f(0.35, 0.0)) - n0;
    sig += fSig * 0.82 * wFine;
    tilt += fSlope * 0.72 * wFine;
    oat += smoothstep(0.18, 0.72, fSig) * 0.56 * wFine;
    shadow += (1.0 - smoothstep(-0.68, 0.05, fSig)) * 0.46 * wFine;
  }

  if (wMid > 0.001) {
    // Rotated organic tussock clumps (0.72 m^-1 and 1.38 m^-1)
    let r0 = vec2f(bentXZ.x * 0.643 - bentXZ.y * 0.766, bentXZ.x * 0.766 + bentXZ.y * 0.643) * 0.72 + vec2f(-31.4, 17.8);
    let r1 = vec2f(bentXZ.x * 0.966 + bentXZ.y * 0.259, -bentXZ.x * 0.259 + bentXZ.y * 0.966) * 1.38 + vec2f(47.1, 29.2);
    let m0 = meadowOrganicNoise(r0);
    let m1 = meadowOrganicNoise(r1);
    let mSig = m0 * 0.55 + m1 * 0.45;
    let mSlope = meadowOrganicNoise(r1 + vec2f(0.35, 0.0)) - m1;
    sig += mSig * 0.65 * wMid;
    tilt += mSlope * 0.48 * wMid;
    oat += smoothstep(0.16, 0.68, mSig) * 0.48 * wMid;
    shadow += (1.0 - smoothstep(-0.64, 0.08, mSig)) * 0.38 * wMid;
  }

  if (wBroad > 0.001) {
    // Broad natural meadow pasture mottling (0.21 m^-1 and 0.41 m^-1)
    let s0 = vec2f(bentXZ.x * 0.788 + bentXZ.y * 0.616, -bentXZ.x * 0.616 + bentXZ.y * 0.788) * 0.21 + vec2f(13.7, -42.9);
    let s1 = vec2f(bentXZ.x * 0.259 - bentXZ.y * 0.966, bentXZ.x * 0.966 + bentXZ.y * 0.259) * 0.41 + vec2f(-53.2, -18.6);
    let bSig = meadowOrganicNoise(s0) * 0.60 + meadowOrganicNoise(s1) * 0.40;
    sig += bSig * 0.42 * wBroad;
    oat += smoothstep(0.15, 0.65, bSig) * 0.30 * wBroad;
    shadow += (1.0 - smoothstep(-0.60, 0.12, bSig)) * 0.24 * wBroad;
  }

  let density = clamp(0.5 + sig * 0.28 + (gust - 0.5) * 0.05 * max(wFine, wMid), 0.0, 1.0);
  return vec4f(density, clamp(tilt, -0.75, 0.75), clamp(oat, 0.0, 1.0), clamp(shadow, 0.0, 1.0));
}

struct MeadowParallaxHit {
  hitH: f32,
  cavityOcc: f32,
  gradXZ: vec2f,
  detailEnergy: f32
};

// High-frequency, Nyquist-band-limited vertical grass-blade & straw-stalk field for seamless 2D FAR & SPLAT grass.
// Uses fine stalk scales (~4.5 cm, ~9.5 cm, ~26 cm, ~1.0 m) — ZERO 32 cm smooth moss pillows, ZERO stacked pancake
// slices, ZERO bulbous cushion normals — so the 3D -> 2D MSAA handoff matches crisp sunlit blades & golden oat tips
// seamlessly at any viewing angle and runs ~3x faster on GPU fragment ALU!
fn meadowParallaxSward(
  unshiftedWorldXZ: vec2f,
  viewDir: vec3f,
  windDir: vec2f,
  gust: f32,
  bendSlope: f32,
  footPixel: f32,
  dist: f32
) -> MeadowParallaxHit {
  // Strict Nyquist band-limiting per stalk scale so each octave fades cleanly into its exact mean before aliasing:
  let wBlade = 1.0 - smoothstep(0.014, 0.048, footPixel); // ~4.5 cm individual blade needles (near/mid top-down & mid grazing)
  let wStalk = 1.0 - smoothstep(0.036, 0.125, footPixel); // ~10 cm crisp stalk & seed-head tufts (~15..95 m)
  let wTuft  = 1.0 - smoothstep(0.11, 0.38, footPixel);   // ~28 cm wild oat / fescue pockets (~30..300 m)
  let wSward = 1.0 - smoothstep(0.45, 1.85, footPixel);   // ~1.1 m organic pasture density & shade (~100 m..1.5 km)
  let detailEnergy = clamp(wBlade * 0.34 + wStalk * 0.34 + wTuft * 0.22 + wSward * 0.10, 0.0, 1.0);

  let canopyH = 0.28;
  // Subtle single-layer view-ray + wind-bend parallax displacement (clamped smoothly so grazing angles never smear!)
  let rayShift = -viewDir.xz / max(abs(viewDir.y), 0.45) * (0.12 * canopyH);
  let bendShift = -windDir * ((0.05 + 0.22 * gust + 0.14 * bendSlope) * canopyH * 0.55);
  let p = unshiftedWorldXZ + bendShift + rayShift;

  var h = 0.56;
  var tipSpeck = 0.0;
  var crevice = 0.0;
  var microTilt = vec2f(0.0);

  if (wBlade > 0.001) {
    // 22 m^-1 (~4.5 cm) crisp needle-fine grass blades & micro-gaps
    let q0 = vec2f(p.x * 0.8660 - p.y * 0.5000, p.x * 0.5000 + p.y * 0.8660) * 21.5 + vec2f(5.1, -9.3);
    let q1 = vec2f(p.x * 0.3420 + p.y * 0.9397, -p.x * 0.9397 + p.y * 0.3420) * 34.0 + vec2f(-17.4, 13.7);
    let n0 = meadowOrganicNoise(q0);
    let n1 = meadowOrganicNoise(q1);
    let bSig = n0 * 0.62 + n1 * 0.38;
    h += bSig * (0.28 * wBlade);
    tipSpeck += smoothstep(0.26, 0.78, bSig) * (0.42 * wBlade);
    crevice += (1.0 - smoothstep(-0.72, -0.05, bSig)) * (0.34 * wBlade);
    microTilt += vec2f(n0, n1) * (0.14 * wBlade);
  }
  if (wStalk > 0.001) {
    // 10.5 m^-1 (~9.5 cm) fine blade-clump & oat seed-head wisps
    let r0 = vec2f(p.x * 0.6428 - p.y * 0.7660, p.x * 0.7660 + p.y * 0.6428) * 10.4 + vec2f(23.7, -14.2);
    let r1 = vec2f(p.x * 0.9659 + p.y * 0.2588, -p.x * 0.2588 + p.y * 0.9659) * 15.8 + vec2f(-31.2, -19.5);
    let m0 = meadowOrganicNoise(r0);
    let m1 = meadowOrganicNoise(r1);
    let sSig = m0 * 0.58 + m1 * 0.42;
    h += sSig * (0.24 * wStalk);
    tipSpeck += smoothstep(0.22, 0.76, sSig) * (0.38 * wStalk);
    crevice += (1.0 - smoothstep(-0.68, 0.0, sSig)) * (0.28 * wStalk);
    microTilt += vec2f(m0, m1) * (0.10 * wStalk);
  }
  if (wTuft > 0.001) {
    // 3.8 m^-1 (~26 cm) subtle tussock height variation (NO bulbous bump normals!)
    let t0 = vec2f(p.x * 0.7880 + p.y * 0.6157, -p.x * 0.6157 + p.y * 0.7880) * 3.8 + vec2f(-11.8, 27.4);
    let nT = meadowOrganicNoise(t0);
    h += nT * (0.14 * wTuft);
    tipSpeck += smoothstep(0.24, 0.78, nT) * (0.22 * wTuft);
    crevice += (1.0 - smoothstep(-0.65, 0.05, nT)) * (0.18 * wTuft);
  }
  if (wSward > 0.001) {
    // 0.92 m^-1 (~1.1 m) broad organic meadow variation
    let w0 = vec2f(p.x * 0.2588 - p.y * 0.9659, p.x * 0.9659 + p.y * 0.2588) * 0.92 + vec2f(41.3, 18.6);
    let nW = meadowOrganicNoise(w0);
    h += nW * (0.09 * wSward);
    tipSpeck += smoothstep(0.20, 0.75, nW) * (0.12 * wSward);
  }

  let finalH = clamp(h + tipSpeck * 0.26, 0.24, 0.98);
  return MeadowParallaxHit(finalH, clamp(crevice, 0.0, 0.65), microTilt, detailEnergy);
}
`;

const meadowContinuumMaterialWGSL = () => {
  const T = CONTINUUM_TYPE, M = MEADOW_CONTINUUM_MATERIAL;
  return /* wgsl */ `
// A colour word: three square roots of a linear colour, 8 bits each.
fn meadowColourOf(word: u32) -> vec3f { let root = unpack4x8unorm(word).rgb; return root * root; }
// Each corner's look, from what the atlas holds of it and what grows where it stands now:
//   colour  the sward's own colour (linear)
//   blade   how far along its stalk it stands, the gust and swell of the wind field there, and the share of the
//           ground its sward hides from the eye (1 for the sward's own organs)
//   flow    where it stands (the frame's world, unshifted), how far off the eye is, and the share of it the cover
//           map, the water and the craters keep
//   harm    how singed it is, how far the wind bends it, and its clump's threshold (-1 for a far body or splat)
fn meadowContinuumVarying(s: ContinuumSurface, v: ptr<function, ContinuumVarying>) {
  let seed = s.record.tag.z;
  let splat = s.what == CONTINUUM_SPLAT_ENTRY;
  let cluster = s.what == CONTINUUM_CLUSTER_ENTRY;
  // A splat is read at its patch's middle; every other corner where it stands.
  let at = select(s.world.xz, continuumPlace(s.record, vec3f(MEADOW_PATCH * 0.5, 0.0, MEADOW_PATCH * 0.5)).xz, splat);
  let eye = continuumEye();
  // The ground's slope under the patch, from the heights its drape holds at its square's corners.
  let data = continuumKindData(s.record);
  let tall = continuumStretch(s.record).y;
  let h = continuumPoses[data + 1u] * tall;
  let span = max(continuumTypeF(s.model, ${T.span}u), 1e-3);
  let slope = continuumQuat(s.record.turn, normalize(vec3f(-0.5 * (h.y - h.x + h.w - h.z) / span, 1.0, -0.5 * (h.z - h.x + h.w - h.y) / span)));
  let cover = meadowCoverAt(at);
  let groundY = meadowGroundY(at, cfg.domain, elevation);
  let dist = distance(s.world, eye);
  var ballistics = MeadowBallisticDeform(vec2f(0.0), 0.0, 0.0, 0.0);
  if (dist <= 90.0) {
    ballistics = meadowEvalBallistics(at, groundY, seed);
  }
  let wind = meadowWindField(at, F.camPos.w, F.windP[0]);
  let windDir = meadowWindDirection();
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let windSpeed = max(F.windP[0].z, 0.0);
  let curl = meadowWindCurl(at, F.camPos.w, windDir, windSpeed);
  let billow = meadowWorldBillow(at);
  let mean = meadowMixMean(cover.g, at);
  // The sward's organs carry their own along, stiffness and clump; a far body and splat are as the type's sward
  // shows from here, its stiffness a body's.
  var along = continuumTypeF(s.model, ${M.seenAlong}u);
  var stiff = 9.0;
  var clump = -1.0;
  var colour = mean.rgb;
  var hides = 1.0;
  var rest = vec3f(0.0, 1.0, 0.0);
  if (cluster) {
    along = f32(s.high & 255u) / 255.0;
    stiff = max(f32((s.high >> 8u) & 15u) * ${MEADOW_CONTINUUM_STIFFNESS_UNIT.toFixed(4)}, 0.8);
    clump = clamp(fract((f32(s.high >> 12u) + 0.5) / 16.0 * 1.07 + f32((seed >> 8u) & 255u) / 256.0), 0.04, 0.96);
    colour = meadowColourOf(s.word);
    rest = s.normal;
  } else if (s.what == CONTINUUM_FAR_ENTRY) {
    // A far vertex's colour and cover are its optical moments' (its albedo and its share of ground hidden), the mean
    // of the sward seen about it, morphed down the chain with it. Far off a patch is one with the field it lies in: its
    // colour and cover are mostly the mean of the mixes growing where it stands (the world's own, which runs on
    // across patches), its own sward's showing only as a little unevenness, and none of it as collapse makes each
    // vertex stand for more; at the edge, which every variant shares, they are that mean at every step, so no line runs
    // between patches, nor where the mix changes, and no patch reads as a tile of its own.
    let state = continuumState(s.instance);
    let farFirst = f32(continuumType(s.model, ${T.farFirst}u));
    let steps = f32(continuumType(s.model, ${T.stepCount}u));
    let coarse = clamp((f32(state.y & 65535u) + bitcast<f32>(state.z) - farFirst) / max(steps - farFirst, 1.0), 0.0, 1.0);
    let inside = max(abs(s.local.x - MEADOW_PATCH * 0.5), abs(s.local.z - MEADOW_PATCH * 0.5));
    let whole = max(max(0.75, smoothstep(0.0, 0.15, coarse)), smoothstep(MEADOW_PATCH * 0.5 - 0.5, MEADOW_PATCH * 0.5, inside));
    let toward = normalize(s.world - eye);
    let top = meadowColourOf(continuumType(s.model, ${M.top}u));
    let side = meadowColourOf(continuumType(s.model, ${M.side}u)) * mean.rgb / max(top, vec3f(1e-4));
    let dirMean = mix(side, mean.rgb, abs(toward.y));
    colour = mix(s.albedo.rgb, dirMean, whole);
    hides = meadowHides(mix(s.albedo.a, mean.a, whole), dot(-toward, slope));
  } else {
    // The splat: seen from above, the mean of the mixes growing here, as the far body's coarse colour is; from the
    // side, the variant's side colour in proportion.
    let toward = normalize(s.world - eye);
    let top = meadowColourOf(continuumType(s.model, ${M.top}u));
    let side = meadowColourOf(continuumType(s.model, ${M.side}u)) * mean.rgb / max(top, vec3f(1e-4));
    colour = mix(side, mean.rgb, abs(toward.y));
    hides = meadowHides(mean.a, dot(toward, slope));
  }
  // The wind's bend, as the shading reads it: crisp high-frequency blade quiver in light air, building into
  // rolling multi-octave gusts as real wind speed increases.
  let flexAlong = clamp(along * 1.26, 0.0, 1.12);
  let speedNorm = smoothstep(0.5, 11.5, windSpeed) * clamp(windSpeed / 10.5, 0.0, 1.55);
  let quiverEnv = smoothstep(0.15, 2.4, windSpeed) * mix(0.55, 1.0, clamp(windSpeed / 9.5, 0.0, 1.0));
  let stiffFactor = 9.5 / (clamp(stiff, 3.0, 22.0) + 4.5);
  let qRate = 5.8 + 3.6 * fract(f32(seed & 255u) / 256.0) + clamp(windSpeed, 0.0, 16.0) * 0.24;
  let tipFlutter = (sin(dot(at, windDir) * 2.9 + F.camPos.w * qRate + f32(seed & 31u) * 0.35) * 0.085 + cos(F.camPos.w * (qRate * 1.37) + f32((seed >> 5u) & 31u) * 0.41) * 0.045) * quiverEnv;
  let bendSin = clamp((0.015 * quiverEnv + 0.64 * wind.x * speedNorm + tipFlutter) * stiffFactor, 0.0, 0.68);
  let bendDir = normalize(windDir + acrossDir * (curl * (0.10 + 0.22 * wind.x)));
  var bendSlope = clamp(1.65 * bendSin * pow(max(flexAlong, 0.02), 0.65), 0.0, 0.96) * (1.0 - ballistics.buryDepth);
  var normal: vec3f;
  if (splat) {
    bendSlope = 0.55 * wind.x;
    normal = normalize(slope - vec3f(windDir.x, 0.0, windDir.y) * (bendSlope * 0.70) + vec3f(0.0, 0.14, 0.0));
  } else {
    // A body is lit as its sward is, whose blades face every way, not as the heights its top follows.
    let nRest = normalize(vec3f(slope.x * 0.55 + rest.x * 0.72 - billow.y, max(0.32, slope.y * 0.65 + rest.y * 0.68), slope.z * 0.55 + rest.z * 0.72 - billow.z));
    normal = normalize(nRest - vec3f(bendDir.x, 0.0, bendDir.y) * (bendSlope * 0.85) + vec3f(ballistics.pushXZ.x, 0.0, ballistics.pushXZ.y) * 1.15);
  }
  (*v).normal = normal;
  (*v).colour = colour;
  (*v).blade = vec4f(along, wind.x, wind.y, hides);
  // What the cover map keeps of it here, none on water, none where a crater has buried it.
  let keep = smoothstep(0.06, 0.55, cover.r) * step(cfg.domain.w, groundY) * (1.0 - ballistics.buryDepth);
  (*v).flow = vec4f(s.world.xz, dist, keep);
  (*v).harm = vec4f(ballistics.hotSinge, bendSlope, clump, 0.0);
}

// The samples of a pixel the sward keeps (rule 2: a cut by the sample mask, never a killed fragment): the sward's clumps each
// whole or gone as the cover map thins it, a far body and splat thinned evenly, each pixel rounding its share its own
// way.
fn meadowContinuumCoverage(v: ContinuumVarying, front: bool) -> u32 {
  let keep = clamp(v.flow.w, 0.0, 1.0);
  let share = select(keep, smoothstep(v.harm.z - 0.06, v.harm.z + 0.06, keep), v.harm.z >= 0.0);
  if (share >= 0.999) { return 0xffffffffu; }
  let n = clamp(v.coverage.w, 1u, 8u);
  let p = vec2u(v.position.xy);
  let random = continuumHash(v.coverage.z ^ continuumHash(p.x ^ continuumHash(p.y * 0x9e3779b9u + 0x6d656164u)));
  let count = min(n, u32(floor(share * f32(n) + f32(random & 65535u) / 65536.0)));
  let bits = (1u << count) - 1u;
  let rotation = (random >> 16u) % n;
  return ((bits << rotation) | (bits >> (n - rotation))) & ((1u << n) - 1u);
}

fn meadowContinuumShade(v: ContinuumVarying, frontFacing: bool) -> vec4f {
  let windDir = meadowWindDirection();
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let world = v.world + continuumShift();

  let along = clamp(v.blade.x, 0.0, 1.0);
  let gust = clamp(v.blade.y, 0.0, 1.0);
  let swell = v.blade.z;
  let bendSlope = clamp(v.harm.y, 0.0, 1.0);
  let isContinuum = v.coverage.x != CONTINUUM_CLUSTER_ENTRY;

  let dist = v.flow.z;
  let unshiftedWorldXZ = v.world.xz;
  let fCov = meadowCoverAt(unshiftedWorldXZ);
  let marginFade = smoothstep(0.06, 0.55, fCov.r);
  // Screen-space world footprint (derivatives computed in strictly uniform control flow):
  // Preserve grazing-angle anisotropy so tufts looking up 30..180 m hillsides keep horizontal resolution near isoFoot
  // while still band-limiting cleanly before Nyquist with zero shimmer.
  let dxW = dpdx(unshiftedWorldXZ);
  let dyW = dpdy(unshiftedWorldXZ);
  let isoFoot = dist * 2.0 * length(F.camUp.xyz) / max(F.screen.y, 1.0);
  let minorFoot = min(length(dxW), length(dyW));
  let majorFoot = min(max(length(dxW), length(dyW)), isoFoot * 1.65);
  let footPixel = mix(max(isoFoot, minorFoot), majorFoot, 0.22);

  let view = normalize(F.camPos.xyz - world);
  let viewGrazing = clamp(1.0 - abs(dot(view, normalize(v.normal))), 0.0, 1.0);
  let horizGraze = clamp(1.0 - abs(view.y), 0.0, 1.0);
  let grazeFactor = smoothstep(0.18, 0.88, max(viewGrazing, horizGraze));

  // On FAR & SPLAT, step a real 5-layer view-ray parallax volumetric grass shell through the 0.36 m canopy;
  // on physical 3D CLUSTER blades, evaluate the lighter surface micro-detail field.
  var sd = vec4f(0.5, 0.0, 0.0, 0.0);
  var para = MeadowParallaxHit(along, 0.0, vec2f(0.0), 1.0);
  if (isContinuum) {
    para = meadowParallaxSward(unshiftedWorldXZ, view, windDir, gust, bendSlope, footPixel, v.flow.z);
  } else {
    sd = meadowSwardDetail(unshiftedWorldXZ, footPixel, windDir, gust);
  }

  let hitH = para.hitH;
  // A body or splat is as much sward as its parallax ray intercepts: tufts above the root floor are full grass,
  // while deep inter-tuft cavities let shadowed humus peek through just like gaps between physical 3D blades.
  let farHidesBase = clamp(v.blade.w * 1.18 + 0.16 * marginFade, 0.0, 1.0);
  let farHides = mix(farHidesBase, 1.0, max(grazeFactor * 0.78, smoothstep(0.24, 0.44, hitH) * 0.92));
  let swardWeight = select(clamp(0.55 + 0.45 * marginFade, 0.0, 1.0), marginFade * farHides, isContinuum);
  // Drive effAlong physically from parallax hitH on FAR/SPLAT (zero artificial +0.24 beige bias!).
  let effAlong = select(along, hitH, isContinuum);

  // Natural Iberian Meadow Albedo (exact hue & luminance parity between 3D CLUSTER blades and FAR/SPLAT parallax shells):
  //   - World-space moisture & lushness patches blend smoothly between lush emerald pasture,
  //     Mediterranean olive-sage fescue, and sun-warmed straw.
  //   - Root cavities (effAlong < 0.24) ground with warm soil/thatch tint + deep physical root AO (0.36..0.55).
  //   - Tall sunlit crests (effAlong > 0.76..0.78) warm toward crisp golden oat seed-heads ONLY at the very tips!
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
    smoothstep(0.45, 0.88, moisture)
  );

  // Preserve distinct wildflower corolla pigments (chamomile ivory, rose mallow, scarlet field poppy)
  let isFlower = select(
    clamp(max(v.colour.b - v.colour.g * 0.58, v.colour.r - v.colour.g * 1.32) * 10.0, 0.0, 1.0),
    0.0,
    isContinuum
  );
  let tussockLum = clamp(v.colour.g / 0.142, 0.72, 1.28);
  var grassPigment = mix(v.colour * 1.06, patchGreen * tussockLum, 0.44);
  // Crisp golden oat seed-heads ONLY on the highest tuft tips (hitH > 0.78, matching CLUSTER smoothstep(0.76, 0.94, along)).
  // Past tuft resolution on distant hills (detailEnergy -> 0), keep only the subtle ~11% area-average tip warmth.
  let farTipAvg = (1.0 - para.detailEnergy) * (0.08 + 0.07 * smoothstep(0.38, 0.72, hitH));
  let oatHeadT = select(
    smoothstep(0.76, 0.94, along),
    clamp(smoothstep(0.78, 0.95, hitH) + farTipAvg, 0.0, 0.92),
    isContinuum
  );
  grassPigment = mix(grassPigment, goldenOatTip, oatHeadT * 0.82);
  // Warm soil/thatch root grounding inside deep root cavities
  let warmSoil = mix(groundCol, vec3f(0.072, 0.066, 0.034), 0.45);
  grassPigment = mix(
    grassPigment,
    warmSoil,
    select(0.20 * (1.0 - smoothstep(0.0, 0.18, effAlong)), 0.28 * (1.0 - smoothstep(0.12, 0.34, hitH)), isContinuum)
  );

  let organCol = mix(grassPigment, v.colour * 1.06, isFlower);
  let clusterAO = mix(0.46, 1.0, smoothstep(0.0, 0.55, along));
  let paraAO = mix(0.56, 1.0, smoothstep(0.24, 0.82, hitH))
             * (1.0 - para.cavityOcc * 0.14);
  let ao = select(clusterAO, clamp(paraAO, 0.50, 1.0), isContinuum);
  let shadedBladeCol = organCol * mix(1.0, ao, swardWeight * 0.78);
  let shadowedUnderGround = groundCol * mix(1.0, 0.52, marginFade);
  var baseCol = mix(shadowedUnderGround, shadedBladeCol, select(1.0, swardWeight, isContinuum));

  // Per-pixel crater soot/ash scorching around inner rim + thrown-soil dusting across outer apron
  if (cfg.crater.w > 0.5 && dist < 180.0) {
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
        let sootAsh = mix(vec3f(0.015, 0.013, 0.011), vec3f(0.048, 0.044, 0.040), clamp(effAlong * 0.7, 0.0, 1.0));
        baseCol = mix(baseCol, thrownEarth, apronDust * (0.45 + 0.45 * (1.0 - effAlong)));
        baseCol = mix(baseCol, sootAsh, innerRimChar * 0.82);
        baseCol = mix(baseCol, groundCol * 0.48, inBowl);
      }
    }
  }

  let hotSinge = clamp(v.harm.x, 0.0, 1.0) * smoothstep(0.35, 0.92, effAlong);
  if (hotSinge > 0.001) {
    let emberSoot = mix(vec3f(0.022, 0.016, 0.011), vec3f(0.11, 0.048, 0.014), smoothstep(0.70, 0.98, effAlong));
    baseCol = mix(baseCol, emberSoot, hotSinge * 0.88);
  }

  let tf = select(sd.xy, vec2f(hitH, 0.0), isContinuum);
  // Perturb normal from parallax tuft gradient + travelling 14 m wind rollers on FAR/SPLAT so wind waves and
  // micro-tuft lighting roll continuously from near 3D blades -> mid widened blades -> far parallax shells -> horizon.
  let clusterPerturb = vec3f(acrossDir.x * sd.y * 0.18, 0.03, acrossDir.y * sd.y * 0.18);
  let paraPerturb = vec3f(
    para.gradXZ.x * 0.22 - windDir.x * (swell * 0.14),
    0.04,
    para.gradXZ.y * 0.22 - windDir.y * (swell * 0.14)
  );
  var n = normalize(v.normal + select(clusterPerturb, paraPerturb, isContinuum) * swardWeight);
  if (!frontFacing) { n = normalize(vec3f(-n.x * 0.55, abs(n.y), -n.z * 0.55)); }

  // Shimmering wind-ripple contrast across gust crests & upright lulls (matched identically on CLUSTER & FAR/SPLAT)
  let crest = smoothstep(-0.38, 0.65, swell);
  let tendrilHighlight = mix(
    1.0,
    select(mix(0.92, 1.09, sd.x), mix(0.92, 1.08, hitH), isContinuum),
    swardWeight
  );
  let windTrough = vec3f(0.90, 0.94, 0.88);
  let windPeak = vec3f(1.14, 1.15, 1.02);
  let windTone = mix(
    vec3f(1.0),
    mix(windTrough, windPeak, crest),
    swardWeight * (0.30 + 0.70 * effAlong)
  );
  let albedo = clamp(baseCol * tendrilHighlight * windTone, vec3f(0.0), vec3f(0.36));

  let landUV = (unshiftedWorldXZ - cfg.domain.xy) / cfg.domain.z + 0.5;
  let edgeDist = min(min(landUV.x, 1.0 - landUV.x), min(landUV.y, 1.0 - landUV.y));
  let inDomain = select(0.0, smoothstep(0.0, 0.08, edgeDist), cfg.more.z != 0u);
  let bakedLight = textureSampleLevel(landLight, sampC, clamp(landUV, vec2f(0.0), vec2f(1.0)), 0.0).rg;
  let terrainSun = mix(1.0, bakedLight.r, inDomain);
  let sunlight = terrainSun * solarShadowVisibility(vec3f(cloudShadowAt(world * 0.001, F.sunDir.xyz))).x;
  // The shadow map is drawn in the scene's frame, as the one cut casts into it; skip beyond meadow shadowMaxDistance (32 m).
  var shadowVis = vec3f(1.0);
  if (dist < 34.0) {
    shadowVis = mix(meadowShadowVis(v.world, n), vec3f(1.0), smoothstep(28.0, 34.0, dist));
  }
  let direct = sunIlluminance() * sunlight * solarShadowVisibility(shadowVis);

  let nDotL = max(dot(n, F.sunDir.xyz), 0.0);
  let wrap = max(0.0, dot(n, F.sunDir.xyz) * 0.50 + 0.50) * (0.14 + 0.14 * effAlong) * swardWeight;

  // Forward subsurface sunlight translucency (identical physical energy on CLUSTER & FAR/SPLAT)
  let sunFwd = pow(max(dot(-view, F.sunDir.xyz), 0.0), 2.1);
  let backTransmission = max(0.0, -dot(n, F.sunDir.xyz)) * 0.50 + 0.50;
  let backscatter = (0.28 * backTransmission + 0.92 * sunFwd)
                  * smoothstep(0.24, 0.88, effAlong)
                  * (0.65 + 0.55 * gust)
                  * (0.70 + 0.30 * tf.x)
                  * swardWeight;

  let skyDir = normalize(vec3f(n.x * 0.65, max(n.y, 0.12), n.z * 0.65));
  let skyIrr = textureSampleLevel(envCube, sampC, skyDir, 6.0).rgb;
  let bounceDir = normalize(vec3f(n.x * 0.5, -0.55, n.z * 0.5));
  let groundIrr = textureSampleLevel(envCube, sampC, bounceDir, 6.5).rgb * vec3f(0.84, 0.86, 0.68);
  let ambient = mix(groundIrr * 0.50, skyIrr, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)) * mix(1.0, ao, swardWeight);

  // Silky grazing-angle + Kajiya-Kay specular sheen across wind-flattened wave troughs!
  let hRaw = view + F.sunDir.xyz;
  let h = select(vec3f(0.0, 1.0, 0.0), normalize(hRaw), length(hRaw) > 1e-5);
  let nDotH = max(dot(n, h), 0.0);
  let graze = pow(clamp(1.0 - max(dot(n, view), 0.0), 0.0, 1.0), 2.3);
  let flatGust = clamp(gust * 0.65 + bendSlope * 0.45, 0.0, 1.0);
  let fiberTan = normalize(vec3f(windDir.x * (0.36 + 0.56 * flatGust), max(0.18, 0.78 - 0.50 * flatGust), windDir.y * (0.36 + 0.56 * flatGust)));
  let tDotH = clamp(dot(fiberTan, h), -1.0, 1.0);
  let sinTH = sqrt(max(0.0, 1.0 - tDotH * tDotH));
  let troughFlatten = smoothstep(0.28, 0.86, flatGust) * (0.25 + 0.75 * effAlong);
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
  col += lunarSurface(n, view, albedo, 0.76, vec3f(0.034), vec3f(mix(1.0, bakedLight.g, inDomain)) * lunarShadowVisibility(shadowVis));
  return vec4f(continuumAir(col, world), 1.0);
}
`;
};

// The meadow's material (js/wgsl/continuum-cut.js). Its blades are open shells, seen from both sides; grass only grows
// above MEADOW_WATERLINE (0.75 m), so it skips the underwater capture pass.
export const MEADOW_CONTINUUM_SPEC = Object.freeze({
  name: 'meadowContinuum', prelude: meadowContinuumPreludeWGSL, core: false, data: MEADOW_CONTINUUM_DATA,
  varyings: [['colour', 'vec3f'], ['blade', 'vec4f'], ['flow', 'vec4f'], ['harm', 'vec4f']],
  wgsl: meadowContinuumMaterialWGSL, salt: 5,
  cullMode: 'none', air: true, capture: false, coverage: true,
});
