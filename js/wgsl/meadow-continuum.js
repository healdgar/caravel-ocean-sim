// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Meadow grass in the one continuum's pipeline family (js/wgsl/continuum-cut.js): the pass that stands its patches and
// the material that wears them. Their cut, their shadow, their capture under water and their sway are the one cut's
// (the WIND kind, draped, js/wgsl/continuum-wind.js); this is only where each 4 m patch stands each frame and how its
// sward is worn (js/meadow-continuum.js for the atlas, js/meadow-grass.js for the cover map and the CPU's part).
//   stand     the blocks of 16 x 16 patches in view, or in the shadow map's box, that hold any grass are listed; then one
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
import { SHADOW_FRAME } from './shadows.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SAMPLE } from './clouds.js';
import { LAND_CRATER_SAMPLE_WGSL, LAND_CRATER_TEXELS, LAND_CRATER_CELL_M, LAND_CRATER_TILE_M } from './land-craters.js';
import { CONTINUUM_RECORD_WGSL, CONTINUUM_ROW } from './continuum-cut.js';
import { CONTINUUM_WIND_FORM, CONTINUUM_WIND_POSE } from './continuum-wind.js';
import { CONTINUUM_HEADER, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, CONTINUUM_KIND, CONTINUUM_KIND_SHIFT, CONTINUUM_STRETCHED } from '../continuum-format.js';
import { continuumGroundWGSL } from '../continuum-ground.js';
import { MEADOW_PATCH_METRES, MEADOW_CONTINUUM_MATERIAL, MEADOW_CONTINUUM_STIFFNESS_UNIT } from '../meadow-continuum.js';

export const MEADOW_MAX_SHOT_WAKES = 16;
export const MEADOW_MAX_BLAST_RINGS = 16;
export const MEADOW_WAKE_BUFFER_BYTES = 1040; // 16B counts + 16 * 32B ShotWake + 16 * 32B BlastRing = 1040B
// Patches to a block's side: the stand pass lists the blocks in view, then stands their patches.
export const MEADOW_BLOCK_PATCHES = 16;
// The blocks-in-view list begins with its own indirect dispatch.
export const MEADOW_WORK_HEADER = 4;
// A patch's pose data, in vec4f: its stretch (STRETCHED), then the WIND kind's.
export const MEADOW_CONTINUUM_POSE = 1 + CONTINUUM_WIND_POSE;
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
  grid: vec4f,
};
struct MeadowCfg {
  domain: vec4f, // the cover map's region: centre x, z, span; the waterline
  params: vec4u, // samples a pixel, the cover map's size, records the stand pass may write, 1 when shadows are cast
  crater: vec4f, // the crater field's origin x, z, its tile metres, 1 when bound
  blocks: vec4i, // the region's first block x, z; blocks across x, z
  scene: vec4f,  // the scene's pixel error (js/continuum-core.js), the gust's wave number, 0, 0
  more: vec4u,   // 0, blocks in the region, 0, 0
  mixes: array<vec4f, 3>, // each mix's (lowland, upland, margin) colour (linear) and cover from above: its variants' mean
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
struct MeadowBallisticDeform {
  pushXZ: vec2f,
  pressDown: f32,
  buryDepth: f32,
  hotSinge: f32,
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
  return clamp((unshiftedXZ - cfg.domain.xy) / cfg.domain.z + 0.5, vec2f(0.0005), vec2f(0.9995));
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
  const tag = ((CONTINUUM_KIND.WIND << CONTINUUM_KIND_SHIFT) | CONTINUUM_STRETCHED) >>> 0;
  return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_RECORD_WGSL + continuumGroundWGSL(0, 17) + MEADOW_COMMON_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> cfg: MeadowCfg;
@group(0) @binding(2) var<uniform> nearTerrain: MeadowNearDomain;
@group(0) @binding(3) var elevation: texture_2d<f32>;
@group(0) @binding(4) var meadowCover: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> meadowAtlas: array<u32>;
@group(0) @binding(6) var<storage, read> meadowBlocks: array<vec4f>;            // a block's most cover, lowest and highest ground
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
// A block listed for the camera carries this bit; one listed for the sun alone does not.
const MEADOW_SEEN: u32 = 0x80000000u;
const MEADOW_WORK: u32 = ${MEADOW_WORK_HEADER}u;
fn meadowFocal() -> f32 { return F.screen.y / max(2.0 * length(F.camUp.xyz), 1e-4); }
fn meadowShift() -> vec3f { return vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z); }
fn meadowStandTypeF(model: u32, field: u32) -> f32 { return bitcast<f32>(meadowAtlas[meadowAtlas[${CONTINUUM_HEADER.typesAt}u] + model * ${CONTINUUM_TYPE_WORDS}u + field]); }
fn meadowOutside(at: vec3f, reach: f32) -> bool {
  let m = F.viewProj; let p = vec4f(at, 1.0);
  let w = vec4f(m[0].w, m[1].w, m[2].w, m[3].w); let x = vec4f(m[0].x, m[1].x, m[2].x, m[3].x); let y = vec4f(m[0].y, m[1].y, m[2].y, m[3].y);
  let planes = array<vec4f, 5>(w + x, w - x, w + y, w - y, w);
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

// The stand emptied and the blocks-in-view list's dispatch set.
@compute @workgroup_size(4) fn meadowStandReset(@builtin(local_invocation_index) i: u32) {
  if (i == 0u) { atomicStore(&meadowStood[3], 0u); }
  atomicStore(&meadowBlockWork[i], select(0u, 1u, i == 1u || i == 2u));
}

// One thread a block of the region: those holding grass above the waterline and in view, or in the sun's box, are
// listed (marked MEADOW_SEEN for the camera), and the patches pass is dispatched once for each.
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
  let reach = size + continuumGroundBound(cfg.scene.x, meadowFocal(), length(centre + meadowShift() - F.camPos.xyz) + size);
  let seen = !meadowOutside(earthCurve(centre + meadowShift() - F.camPos.xyz, F.camPos.y), reach);
  if (!seen && !meadowInLight(centre, reach)) { return; }
  let at = atomicAdd(&meadowBlockWork[0], 1u);
  atomicStore(&meadowBlockWork[MEADOW_WORK + at], id.x | select(0u, MEADOW_SEEN, seen));
}

// One patch stood as a record of the one cut, if grass grows on it and it is in view or in the sun's box.
fn meadowStandPatch(cell: vec2i, blockSeen: bool) {
  let origin = vec2f(cell) * MEADOW_PATCH;
  let half = MEADOW_PATCH * 0.5;
  let middle = origin + vec2f(half);
  let uv = (middle - cfg.domain.xy) / cfg.domain.z + 0.5;
  if (any(uv <= vec2f(0.002)) || any(uv >= vec2f(0.998))) { return; }
  // Grass where the cover map grows it at its middle or a corner, on dry ground.
  let cover = meadowCoverAt(middle);
  let corners = max(max(meadowCoverAt(middle + vec2f(half, half)).r, meadowCoverAt(middle + vec2f(-half, half)).r), max(meadowCoverAt(middle + vec2f(half, -half)).r, meadowCoverAt(middle + vec2f(-half, -half)).r));
  if (max(cover.r, corners) < 0.02) { return; }
  let ground = meadowGroundY(middle, cfg.domain, elevation);
  if (ground < cfg.domain.w) { return; }
  // Its variant: the mix (lowland, upland, margin) with the most of its middle, one of four by a hash of where it lies.
  let seed = meadowHash2(cell);
  let mixes = meadowMixWeights(cover.g, middle);
  let model = select(select(0u, 1u, mixes.y > mixes.x), 2u, mixes.z > max(mixes.x, mixes.y)) * 4u + (seed & 3u);
  let shift = meadowShift();
  // It stands on the ground the land draws under its middle, as tall as the meadow's lushness and billow grow it (a
  // patch a little taller or shorter than its neighbours), pressed down by shot and blast and sunk into a crater.
  let place = vec3f(origin.x, meadowDrawnGround(middle, shift), origin.y);
  let ballistics = meadowEvalBallistics(middle, ground, seed);
  let vigour = 0.92 + 0.16 * f32((seed >> 16u) & 255u) / 255.0;
  let tall = clamp((0.82 + 0.44 * cover.b) * meadowWorldBillow(middle).x * vigour * (1.0 - 0.7 * ballistics.pressDown) * (1.0 - ballistics.buryDepth), 0.05, 2.0);
  // Draped over the ground drawn under the corners of its type's square (the WIND kind's DRAPED form), and sunk by
  // as much as that drape would float over the ground at its middle.
  let low = vec2f(meadowStandTypeF(model, ${T.low}u), meadowStandTypeF(model, ${T.low + 2}u));
  let span = meadowStandTypeF(model, ${T.span}u);
  let c0 = origin + low;
  var drape = vec4f(meadowDrawnGround(c0, shift), meadowDrawnGround(c0 + vec2f(span, 0.0), shift), meadowDrawnGround(c0 + vec2f(0.0, span), shift), meadowDrawnGround(c0 + vec2f(span), shift)) - vec4f(place.y);
  drape -= vec4f(max(dot(drape, vec4f(0.25)), 0.0));
  // The gust fronts: the wind field's 14 m rollers rolling downwind (meadowWindField), each patch's sward bent as the
  // front crosses it (the kind's phase, less its wave number times how far downwind a point stands), as strongly as
  // the gust packet over it and the wind's speed bend it.
  let downwind = meadowWindDirection();
  let speed = max(F.windP[0].z, 5.2);
  let t = F.camPos.w;
  let u = dot(middle, downwind);
  let v = dot(middle, vec2f(-downwind.y, downwind.x));
  let advect = t * speed * 1.15;
  let warp = sin(v * 0.085 + t * 0.24) * 2.35 + cos(v * 0.19 - t * 0.31) * 1.15;
  let packet = 0.56 + 0.44 * sin((u - advect * 0.82) * 0.165 + sin(v * 0.072) * 1.8) * cos(v * 0.095 + t * 0.21);
  let wave = cfg.scene.y;
  let phase = 3.14159265 - 1.1 * t + wave * advect - warp;
  let strength = meadowStandTypeF(model, ${M.sway}u) * tall * (0.08 + 0.62 * packet * clamp(speed / 9.2, 0.58, 1.42)) * 0.75;
  // In view, or in the sun's box: its type's sphere where its stretch and drape put it, grown by its sway, its push
  // and how far the drawn ground may lie from the true.
  let sphere = vec4f(meadowStandTypeF(model, ${T.sphere}u), meadowStandTypeF(model, ${T.sphere + 1}u), meadowStandTypeF(model, ${T.sphere + 2}u), meadowStandTypeF(model, ${T.sphere + 3}u));
  let deviation = max(max(abs(drape.x), abs(drape.y)), max(abs(drape.z), abs(drape.w)));
  let centre = place + vec3f(sphere.x, sphere.y * tall + dot(drape, vec4f(0.25)), sphere.z);
  let radius = sphere.w * max(tall, 1.0) + deviation + abs(strength) * 1.8 + length(ballistics.pushXZ);
  let relative = centre + shift - F.camPos.xyz;
  let reach = radius + continuumGroundBound(cfg.scene.x, meadowFocal(), length(relative) + radius);
  let seen = blockSeen && !meadowOutside(earthCurve(relative, F.camPos.y), reach);
  if (!seen && !meadowInLight(centre, reach)) { return; }
  let slot = atomicAdd(&meadowStood[3], 1u);
  if (slot >= cfg.params.z) { return; }
  let pose = slot * ${MEADOW_CONTINUUM_POSE}u;
  meadowPoses[pose] = vec4f(1.0, tall, 1.0, 0.0);
  meadowPoses[pose + 1u] = vec4f(phase, strength, 0.0, ${W.DRAPED}.0);
  meadowPoses[pose + 2u] = drape / tall;
  meadowPoses[pose + 3u] = vec4f(ballistics.pushXZ.x, 0.0, ballistics.pushXZ.y, wave);
  // Its seed is where it lies, so its samples' pattern and its splat's thinning are its own however the patches are
  // listed.
  meadowRecords[slot] = ContinuumRecord(vec4f(place, 1.0), vec4f(0.0, 0.0, 0.0, 1.0), vec4u(model | ${tag}u, pose, seed, 0u), vec4u(0u));
}

// One workgroup a listed block, four of its patches a lane.
@compute @workgroup_size(64) fn meadowStandPatches(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let listed = meadowBlockList[MEADOW_WORK + group.x];
  let block = listed & ~MEADOW_SEEN;
  let across = u32(max(cfg.blocks.z, 1));
  let first = (cfg.blocks.xy + vec2i(i32(block % across), i32(block / across))) * MEADOW_BLOCK;
  for (var k = 0u; k < 4u; k++) {
    let p = lane + k * 64u;
    meadowStandPatch(first + vec2i(i32(p % u32(MEADOW_BLOCK)), i32(p / u32(MEADOW_BLOCK))), (listed & MEADOW_SEEN) != 0u);
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
const meadowContinuumPreludeWGSL = () => FRAME_WGSL + ATMO_CORE_WGSL + SHADOW_FRAME + SKY_RENDER_FUNCS + CLOUD_SAMPLE + MEADOW_COMMON_WGSL + /* wgsl */ `
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
fn meadowGroundColour(unshiftedXZ: vec2f) -> vec3f {
  return pow(textureSampleLevel(landAlbedo, landSampler, meadowDomainUV(unshiftedXZ), 0.0).rgb, vec3f(2.2));
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
  let at = select(s.world.xz, s.record.place.xz + vec2f(MEADOW_PATCH * 0.5), splat);
  let eye = continuumEye();
  // The ground's slope under the patch, from the heights its drape holds at its square's corners.
  let data = continuumKindData(s.record);
  let tall = continuumStretch(s.record).y;
  let h = continuumPoses[data + 1u] * tall;
  let span = max(continuumTypeF(s.model, ${T.span}u), 1e-3);
  let slope = normalize(vec3f(-0.5 * (h.y - h.x + h.w - h.z) / span, 1.0, -0.5 * (h.z - h.x + h.w - h.y) / span));
  let cover = meadowCoverAt(at);
  let groundY = meadowGroundY(at, cfg.domain, elevation);
  let ballistics = meadowEvalBallistics(at, groundY, seed);
  let wind = meadowWindField(at, F.camPos.w, F.windP[0]);
  let windDir = meadowWindDirection();
  let acrossDir = vec2f(-windDir.y, windDir.x);
  let windSpeed = max(F.windP[0].z, 5.2);
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
    // A far triangle's colour and cover are its metre of sward's. As collapse makes each stand for more, they go to the
    // mean of the mixes growing where it stands, so the coarse body shows no triangle of its own; at the edge, which
    // every variant shares, they are that mean at every step, so no line runs between patches, nor where the mix changes.
    let state = continuumState(s.instance);
    let farFirst = f32(continuumType(s.model, ${T.farFirst}u));
    let steps = f32(continuumType(s.model, ${T.stepCount}u));
    let coarse = clamp((f32(state.y & 65535u) + bitcast<f32>(state.z) - farFirst) / max(steps - farFirst, 1.0), 0.0, 1.0);
    let inside = max(abs(s.local.x - MEADOW_PATCH * 0.5), abs(s.local.z - MEADOW_PATCH * 0.5));
    let whole = max(smoothstep(0.0, 0.15, coarse), smoothstep(MEADOW_PATCH * 0.5 - 0.5, MEADOW_PATCH * 0.5, inside));
    colour = mix(meadowColourOf(s.word), mean.rgb, whole);
    hides = meadowHides(mix(f32(s.word >> 24u) / 255.0, mean.a, whole), dot(normalize(eye - s.world), slope));
  } else {
    // The splat: seen from above, the mean of the mixes growing here, as the far body's coarse colour is; from the
    // side, the variant's side colour in proportion.
    let toward = normalize(s.world - eye);
    let top = meadowColourOf(continuumType(s.model, ${M.top}u));
    let side = meadowColourOf(continuumType(s.model, ${M.side}u)) * mean.rgb / max(top, vec3f(1e-4));
    colour = mix(side, mean.rgb, abs(toward.y));
    hides = meadowHides(mean.a, dot(toward, slope));
  }
  // The wind's bend, as the shading reads it: rolling multi-octave gusts bending flexible upper blades by up to ~40
  // degrees, curled across the wind, and the normal leaning on the ground's slope and tilting with the bend.
  let flexAlong = clamp(along * 1.26, 0.0, 1.12);
  let speedNorm = clamp(windSpeed / 9.2, 0.58, 1.42);
  let stiffFactor = 9.5 / (clamp(stiff, 3.0, 22.0) + 4.5);
  let tipFlutter = sin(dot(at, windDir) * 2.35 - F.camPos.w * 5.8 + f32(seed & 31u) * 0.35) * 0.045 * wind.x;
  let bendSin = clamp((0.08 + 0.62 * wind.x * speedNorm + tipFlutter) * stiffFactor, 0.0, 0.66);
  let bendDir = normalize(windDir + acrossDir * (curl * (0.12 + 0.22 * wind.x)));
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
  (*v).flow = vec4f(s.world.xz, distance(s.world, eye), keep);
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

  let unshiftedWorldXZ = v.world.xz;
  let fCov = meadowCoverAt(unshiftedWorldXZ);
  let marginFade = smoothstep(0.06, 0.55, fCov.r);
  // A body or splat is as much sward as its sward hides of the ground from here; the rest is the ground's own colour.
  let swardWeight = select(clamp(0.55 + 0.45 * smoothstep(0.06, 0.55, fCov.r), 0.0, 1.0), marginFade * clamp(v.blade.w, 0.0, 1.0), isContinuum);

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
    clamp(max(v.colour.b - v.colour.g * 0.58, v.colour.r - v.colour.g * 1.32) * 10.0, 0.0, 1.0),
    0.0,
    isContinuum,
  );
  let tussockLum = clamp(v.colour.g / 0.142, 0.72, 1.28);
  var grassPigment = mix(v.colour * 1.06, patchGreen * tussockLum, 0.44);
  // Warm tall culm seed-heads (along > 0.78) toward sunlit golden oat
  let oatHeadT = smoothstep(0.76, 0.94, along);
  grassPigment = mix(grassPigment, goldenOatTip, oatHeadT * 0.82);
  // Gentle 20% warm soil/thatch root grounding on along < 0.18
  let warmSoil = mix(groundCol, vec3f(0.072, 0.066, 0.034), 0.45);
  grassPigment = mix(grassPigment, warmSoil, 0.20 * (1.0 - smoothstep(0.0, 0.18, along)));

  let organCol = mix(grassPigment, v.colour * 1.06, isFlower);
  let ao = mix(0.42, 1.0, smoothstep(0.0, 0.55, along));
  let shadedBladeCol = organCol * mix(1.0, ao, swardWeight * 0.75);
  var baseCol = mix(groundCol, shadedBladeCol, select(1.0, swardWeight, isContinuum));

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

  let hotSinge = clamp(v.harm.x, 0.0, 1.0) * smoothstep(0.35, 0.92, along);
  if (hotSinge > 0.001) {
    let emberSoot = mix(vec3f(0.022, 0.016, 0.011), vec3f(0.11, 0.048, 0.014), smoothstep(0.70, 0.98, along));
    baseCol = mix(baseCol, emberSoot, hotSinge * 0.88);
  }

  let tf = meadowTendrilCloud(v.flow.xy, v.flow.z, windDir, gust);
  var n = normalize(v.normal + vec3f(acrossDir.x * tf.y * 0.18, 0.03, acrossDir.y * tf.y * 0.18) * swardWeight);
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
    let cMid = cloudUV(world * 0.001 + F.sunDir.xyz * (max(CF.shape.x, 0.5) / max(F.sunDir.y, 0.15)));
    let cD = textureSampleLevel(cloudDensity, cloudSampler, clamp(cMid, vec3f(0.0), vec3f(1.0)), 1.0).r;
    let cL = textureSampleLevel(cloudLight, cloudSampler, clamp(cMid, vec3f(0.0), vec3f(1.0)), 1.0).b;
    let cloudVis = clamp(exp(-max(cD, 0.0) * CF.shape.z * 0.6) * mix(1.0, cL, 0.5), 0.0, 1.0);
    sunlight = mix(cloudVis, bakedLight.r, inDomain);
  }
  // The shadow map is drawn in the scene's frame, as the one cut casts into it.
  let shadowVis = meadowShadowVis(v.world, n);
  let direct = sunIlluminance() * sunlight * solarShadowVisibility(vec3f(shadowVis)).x;

  let nDotL = max(dot(n, F.sunDir.xyz), 0.0);
  let wrap = max(0.0, dot(n, F.sunDir.xyz) * 0.50 + 0.50) * (0.14 + 0.14 * along) * swardWeight;
  let view = normalize(F.camPos.xyz - world);

  // Forward subsurface sunlight translucency (backscatter through bent golden-green upper blades & panicles)
  let sunFwd = pow(max(dot(-view, F.sunDir.xyz), 0.0), 2.1);
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
  let hRaw = view + F.sunDir.xyz;
  let h = select(vec3f(0.0, 1.0, 0.0), normalize(hRaw), length(hRaw) > 1e-5);
  let nDotH = max(dot(n, h), 0.0);
  let graze = pow(clamp(1.0 - max(dot(n, view), 0.0), 0.0, 1.0), 2.3);
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
  col += lunarSurface(n, view, albedo, 0.76, vec3f(0.034), vec3f(mix(1.0, bakedLight.g, inDomain)) * lunarShadowVisibility(vec3f(shadowVis)));
  return vec4f(continuumAir(col, world), 1.0);
}
`;
};

// The meadow's material (js/wgsl/continuum-cut.js). Its blades are open shells, seen from both sides; it is seen under
// water too, through the water's own capture.
export const MEADOW_CONTINUUM_SPEC = Object.freeze({
  name: 'meadowContinuum', prelude: meadowContinuumPreludeWGSL, core: false, data: MEADOW_CONTINUUM_DATA,
  varyings: [['colour', 'vec3f'], ['blade', 'vec4f'], ['flow', 'vec4f'], ['harm', 'vec4f']],
  wgsl: meadowContinuumMaterialWGSL, salt: 5,
  cullMode: 'none', air: true, capture: true, coverage: true,
});
