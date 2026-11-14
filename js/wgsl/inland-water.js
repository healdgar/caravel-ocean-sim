// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Ocean-grade fluvial renderer for rivers, mill-leats, canals, estate ponds, and estuary-to-sea convergence.
// Features dual-phase Lagrangian flow advection, swirling shear & cutwater eddies, thalweg upwelling boils,
// standing riffle V-chevrons, Snell refraction with advected caustics, Beer-Lambert absorption, LEAN specular
// slope statistics, and physical wave-current coupling into coastal ocean swells.
import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS, ENV_SIZE, N, CASCADES, FOAM_MODEL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SAMPLE } from './clouds.js';
import { SHADOW_FRAME } from './shadows.js';
import { COASTAL_WATER } from './terrain.js';
import { surfaceWaveSource } from './surface-coupling.js';

export const INLAND_WATER_FLOATS = 12;

export const INLAND_WATER_WGSL = FOAM_MODEL + FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
struct InlandNearDomain {
  domain: vec4f,
  grid: vec4f,
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var dispTex: texture_2d_array<f32>;
@group(0) @binding(6) var derivTex: texture_2d_array<f32>;
@group(0) @binding(7) var momTex: texture_2d_array<f32>;
@group(0) @binding(8) var foamTex: texture_2d<f32>;
@group(0) @binding(9) var sampR: sampler;
@group(0) @binding(10) var<storage, read> sunVis: array<f32, 4>;
@group(0) @binding(12) var<uniform> nearTerrain: InlandNearDomain;
` + surfaceWaveSource(0, 14, 15, 'sampC') + SHADOW_FRAME + SKY_RENDER_FUNCS + CLOUD_SAMPLE + COASTAL_WATER + /* wgsl */ `
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;

const ENV_MAXMIP: f32 = ${ENV_MIPS - 1}.0;
const ENV_TEXELS_PER_RAD: f32 = ${ENV_SIZE}.0 / 1.5708;
const TEX_N: f32 = ${N}.0;

struct InlandWaterOut {
  @invariant @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) rawXZ: vec2f,
  @location(2) flow: vec2f,
  @location(3) coordThal: vec4f,  // alongS, hwMean, thalwegB, kind
  @location(4) hydroVars: vec4f,  // localDepth, bankB, eddy, riffle
  @location(5) xzOcean: vec2f,    // shifted Lagrangian XZ for ocean sample continuity
  @location(6) rel: vec3f,        // camera-relative displaced position
};

fn inlandShadowVis(world: vec3f) -> f32 {
  if (landSH.origin.w < 0.5) { return 1.0; }
  let p = landSH.lightView * vec4f(world - landSH.origin.xyz + vec3f(0.0, 0.04, 0.0) + landSH.sun.xyz * 0.03, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let fade = smoothstep(0.0, 0.06, edge) * step(0.0, p.z) * step(p.z, 1.0);
  if (fade <= 0.0) { return 1.0; }
  let refZ = min(p.z - 0.08 / max(landSH.sun.w, 1.0), 0.99999);
  let s = textureSampleCompareLevel(landSolidShadow, landShadowCompare, uv, refZ);
  return mix(1.0, s, fade);
}

fn inlandCloudShadow(world: vec3f) -> f32 {
  if (CF.screen.w <= 0.5 || F.sunDir.y <= 0.0) { return 1.0; }
  let cMid = cloudUV(world * 0.001 + F.sunDir.xyz * (max(CF.shape.x, 0.5) / max(F.sunDir.y, 0.15)));
  let cD = textureSampleLevel(cloudDensity, cloudSampler, clamp(cMid, vec3f(0.0), vec3f(1.0)), 1.0).r;
  let cL = textureSampleLevel(cloudLight, cloudSampler, clamp(cMid, vec3f(0.0), vec3f(1.0)), 1.0).b;
  return clamp(exp(-max(cD, 0.0) * CF.shape.z * 0.6) * mix(1.0, cL, 0.5), 0.0, 1.0);
}

fn fresnelWater(c: f32) -> f32 {
  let x = 1.0 - clamp(c, 0.0, 1.0);
  let x2 = x * x;
  return 0.02 + 0.98 * x2 * x2 * x;
}

fn lambdaSmith(w: vec3f, cov: vec3f) -> f32 {
  let xz2 = max(dot(w.xz, w.xz), 1e-8);
  let il = inverseSqrt(xz2);
  let az = w.xz * il;
  let sig2 = az.x * az.x * cov.x + az.y * az.y * cov.y + 2.0 * az.x * az.y * cov.z;
  let cotT = w.y * il;
  let a = max(cotT, 1e-3) / sqrt(2.0 * max(sig2, 1e-7));
  if (a >= 1.6) { return 0.0; }
  return (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a);
}

// Standing/slow-propagating wave-current steepening on the river-mouth bar where outflow opposes coastal swells.
fn riverBarWave(p: vec2f, flowDir: vec2f, shoreDir: vec2f, speed: f32, t: f32) -> vec3f {
  let kAxis = normalize(shoreDir - flowDir * 0.85 + vec2f(1e-4, 0.0));
  let kSide = vec2f(kAxis.x * 0.82 - kAxis.y * 0.57, kAxis.x * 0.57 + kAxis.y * 0.82);
  let k1 = 0.82;
  let k2 = 1.65;
  let ph1 = dot(p, kAxis) * k1 - t * (1.45 - min(speed, 1.8) * 0.32) + gnoise(p * 0.065) * 1.4;
  let ph2 = dot(p, kSide) * k2 - t * 2.10 + gnoise(p * 0.12 + vec2f(4.3, 9.1)) * 1.1;
  let env = 0.58 + 0.42 * gnoise(p * 0.035 - flowDir * t * 0.12);
  let a1 = 0.072 * env;
  let a2 = 0.036 * env;
  let h = a1 * (sin(ph1) + 0.22 * cos(2.0 * ph1)) + a2 * sin(ph2);
  let s1 = a1 * k1 * (cos(ph1) - 0.44 * sin(2.0 * ph1));
  let s2 = a2 * k2 * cos(ph2);
  let sl = kAxis * s1 + kSide * s2;
  return vec3f(h, sl.x, sl.y);
}

fn noiseGrad(p: vec2f, eps: f32) -> vec2f {
  let gx = gnoise(p + vec2f(eps, 0.0)) - gnoise(p - vec2f(eps, 0.0));
  let gz = gnoise(p + vec2f(0.0, eps)) - gnoise(p - vec2f(0.0, eps));
  return vec2f(gx, gz) / (2.0 * eps);
}

// Spiral vortex wavelet gradient + dimple strength in shear margins and inner-bend eddies.
fn eddyVortex(p: vec2f, t: f32, spinSign: f32, scale: f32) -> vec3f {
  let sp = p / scale;
  let cell = floor(sp);
  let f = fract(sp) - 0.5;
  let hx = bitcast<u32>(i32(cell.x));
  let hy = bitcast<u32>(i32(cell.y));
  let h1 = f32(pcgHash((hx * 73856093u) ^ (hy * 19349663u)) & 65535u) / 65535.0;
  let h2 = f32(pcgHash((hx * 83492791u) ^ (hy * 2971215073u)) & 65535u) / 65535.0;
  let center = vec2f(h1 - 0.5, h2 - 0.5) * 0.42;
  let d = (f - center) * scale;
  let r = length(d) + 1e-4;
  let radDir = d / r;
  let tangDir = vec2f(-radDir.y, radDir.x) * spinSign;
  let coreEnv = exp(-r * r / (0.14 * scale * scale));
  let angle = atan2(d.y, d.x) * spinSign;
  let spiral = 2.0 * angle - r * (4.2 / scale) + t * (2.6 + h1 * 1.4);
  let dSlope = (radDir * (-4.2 / scale * sin(spiral)) + tangDir * (2.0 * sin(spiral) / max(r, 0.15))) * coreEnv * 0.065;
  return vec3f(dSlope.x, dSlope.y, coreEnv);
}

// Upwelling boil ("kolk") over deep fast thalwegs: smooth center slick ringed by diverging wavelets.
fn thalwegBoil(p: vec2f, t: f32, scale: f32) -> vec3f {
  let sp = p / scale;
  let cell = floor(sp);
  let f = fract(sp) - 0.5;
  let h = f32(pcgHash((bitcast<u32>(i32(cell.x)) * 49979687u) ^ (bitcast<u32>(i32(cell.y)) * 15485863u)) & 65535u) / 65535.0;
  let phase = fract(t * (0.28 + 0.16 * h) + h);
  let center = vec2f(cos(h * 6.283), sin(h * 11.4)) * 0.25;
  let d = (f - center) * scale;
  let r = length(d) + 1e-4;
  let radDir = d / r;
  let ringR = phase * scale * 0.44;
  let ringDist = r - ringR;
  let ringBand = exp(-ringDist * ringDist * 16.0) * sin(phase * PI);
  let slick = exp(-r * r / max(0.06, ringR * ringR + 0.04)) * sin(phase * PI);
  let sl = radDir * (-ringDist * 8.0 * ringBand * 0.045);
  return vec3f(sl.x, sl.y, clamp(slick, 0.0, 1.0));
}

@vertex fn inlandWaterVS(
  @location(0) posKind: vec4f,
  @location(1) flowCoord: vec4f,
  @location(2) hydro: vec4f,
) -> InlandWaterOut {
  var o: InlandWaterOut;
  let kind = posKind.w;
  let isPond = kind > 1.5;
  let isCanal = abs(kind - 1.0) < 0.03;
  let estuaryT = select(0.0, clamp(kind / 0.95, 0.0, 1.0), !isPond && !isCanal);
  let bankAbs = clamp(abs(hydro.y), 0.0, 1.0);
  let seaOpen = smoothstep(0.36, 0.54, estuaryT);
  let oceanConv = clamp(max(estuaryT, seaOpen * smoothstep(0.60, 1.0, bankAbs)), 0.0, 1.0);

  let packedInt = floor(hydro.w + 1e-4);
  let vEddy = clamp(packedInt / 255.0, 0.0, 1.0);
  let vRiffle = clamp(max(0.0, hydro.w - packedInt) * 1.5, 0.0, 1.5);

  let xzBase = posKind.xz + vec2f(nearTerrain.grid.y, nearTerrain.grid.z);
  let speed = length(flowCoord.xy);
  let flowDir = select(normalize(F.windP[0].xy + vec2f(1e-4, 0.0)), flowCoord.xy / max(speed, 1e-4), speed > 1e-3);
  let bankMask = mix(1.0 - 0.85 * smoothstep(0.68, 1.0, bankAbs), 1.0, seaOpen);
  let t = F.camPos.w;

  // Fluvial 3D surface displacement: outer-bend superelevation, eddy dimples, standing riffle trains & pond breeze.
  let superElev = select(0.0, 0.025 * hydro.z * (1.0 - bankAbs * bankAbs) * smoothstep(0.4, 2.2, speed), !isPond && !isCanal);
  let eddyDepress = -0.026 * vEddy * (0.5 + 0.5 * sin(flowCoord.z * 0.45 - t * 1.9 + hydro.y * 3.1));
  let riffleElev = 0.024 * vRiffle * cos(flowCoord.z * 2.1 - abs(hydro.y - hydro.z) * max(flowCoord.w, 1.0) * 0.85);
  let pondSwell = select(0.0, 0.010 * sin(dot(xzBase, vec2f(0.85, 0.63)) - t * 2.1), isPond);
  let fluvialY = (superElev + eddyDepress + riffleElev + pondSwell) * (1.0 - smoothstep(0.45, 0.88, oceanConv)) * bankMask;

  // Sea-mouth swell coupling: sample exact 6 ocean FFT cascades & coastal shoaling so surface matches coastalOcean.
  var oceanDisp = vec3f(0.0);
  var barY = 0.0;
  if (estuaryT > 0.001) {
    let cws = coastalWaveState(xzBase);
    let distApprox = distance(vec3f(xzBase.x, 0.0, xzBase.y), F.camPos.xyz);
    for (var c = 0u; c < ${CASCADES}u; c++) {
      let texel = F.cascL[c >> 2u][c & 3u] / TEX_N;
      let eff = max(1.6, distApprox * 0.003);
      let lod = log2(max(eff / texel, 1.0)) + 0.5;
      if (lod < 8.0) {
        let cw = select(cws.chopScale, cws.swellScale, c <= 1u);
        var d = textureSampleLevel(dispTex, sampR, xzBase * F.cascInvL[c >> 2u][c & 3u], c, lod).xyz * cw;
        if (c <= 1u) { d = coastalRefractDisp(d, cws); }
        oceanDisp += d;
      }
    }
    oceanDisp += cws.dispOffset;
    let barEnv = 4.0 * estuaryT * (1.0 - estuaryT) * (1.0 - smoothstep(0.72, 0.89, oceanConv)) * bankMask;
    let opposing = clamp(-dot(flowDir, cws.shoreDir) * 0.65 + 0.45, 0.0, 1.15);
    barY = riverBarWave(xzBase, flowDir, cws.shoreDir, speed, t).x * barEnv * opposing;
  }

  let seaBlendV = smoothstep(0.20, 0.36, estuaryT);
  let tideVert = smoothstep(0.03, 0.30, estuaryT);
  let horzW = smoothstep(0.18, 0.36, estuaryT);
  let vertW = mix(tideVert * bankMask, 1.0, seaBlendV);
  let displacedXZ = xzBase + oceanDisp.xz * horzW;
  let splashY = surfaceWaveAt(displacedXZ).x * mix(bankMask, 1.0, seaBlendV);
  let rawRelY = posKind.y + fluvialY + barY;
  let plumeRelY = max(rawRelY, 0.0) + mix(0.090, 0.055, smoothstep(0.42, 0.98, estuaryT));
  let relToOceanY = mix(
    rawRelY + select(0.0, 0.022 * smoothstep(0.005, 0.08, estuaryT) * bankMask, estuaryT > 0.001),
    plumeRelY,
    seaBlendV
  );
  let shifted = vec3f(
    displacedXZ.x,
    oceanDisp.y * vertW + splashY + relToOceanY,
    displacedXZ.y
  );

  o.world = shifted;
  o.rawXZ = posKind.xz;
  o.flow = flowCoord.xy;
  o.coordThal = vec4f(flowCoord.z, flowCoord.w, hydro.z, kind);
  o.hydroVars = vec4f(hydro.x, hydro.y, vEddy, vRiffle);
  o.xzOcean = xzBase;
  o.rel = shifted - F.camPos.xyz;
  let curved = mix(earthCurve(o.rel, F.camPos.y), o.rel, smoothstep(0.04, 0.36, estuaryT));
  o.pos = F.viewProj * vec4f(curved, 1.0);
  return o;
}

@fragment fn inlandWaterFS(in: InlandWaterOut) -> @location(0) vec4f {
  // Uniform control flow: compute footprints & filtered foam textures before any branches.
  let rawDx = dpdx(in.rawXZ);
  let rawDy = dpdy(in.rawXZ);
  let footprint = sqrt(dot(rawDx, rawDx) + dot(rawDy, rawDy));
  let dist = max(length(in.rel), 0.1);
  let xz = in.xzOcean;
  let t = F.camPos.w;

  let kind = in.coordThal.w;
  let isPond = kind > 1.5;
  let isCanal = abs(kind - 1.0) < 0.03;
  let estuaryT = select(0.0, clamp(kind / 0.95, 0.0, 1.0), !isPond && !isCanal);
  let bankAbs = clamp(abs(in.hydroVars.y), 0.0, 1.0);
  let seaOpen = smoothstep(0.36, 0.54, estuaryT);
  let oceanConv = clamp(max(estuaryT, seaOpen * smoothstep(0.60, 1.0, bankAbs)), 0.0, 1.0);
  let oceanBlend = smoothstep(0.16, 0.78, oceanConv);
  let fluvialW = 1.0 - smoothstep(0.45, 0.90, oceanConv);

  let speed = length(in.flow);
  let dir = select(normalize(F.windP[0].xy + vec2f(1e-4, 0.0)), in.flow / max(speed, 1e-4), speed > 1e-3);
  let across = vec2f(-dir.y, dir.x);

  // Staggered dual-phase Lagrangian advection along world current vector (continuous around bends).
  let advPeriod = select(1.85, 3.2, isPond);
  let phA = fract(t / advPeriod);
  let phB = fract(t / advPeriod + 0.5);
  let wA = 0.5 - 0.5 * cos(2.0 * PI * phA);
  let wB = 1.0 - wA;
  let advVel = select(in.flow * 0.72, vec2f(0.05, 0.035), isPond);
  let posA = in.rawXZ - advVel * (phA - 0.5) * advPeriod;
  let posB = in.rawXZ - advVel * (phB - 0.5) * advPeriod;

  let foamA = textureSample(foamTex, sampR, posA * 0.24);
  let foamB = textureSample(foamTex, sampR, posB * 0.24 + vec2f(0.37, 0.71));
  let gustN = textureSample(foamTex, sampR, xz * 0.011 + F.windP[0].xy * (t * 0.0004)).b;
  let ws = vec2f(dot(xz, F.windP[0].xy), dot(xz, vec2f(-F.windP[0].y, F.windP[0].x)));
  let streak = textureSample(foamTex, sampR, ws * vec2f(0.035, 0.11)).a;
  let bub = textureSample(foamTex, sampR, xz * 1.9 + vec2f(0.21, 0.53)).g;

  let patFluvial = mix(foamA.r * 0.76 + foamA.g * 0.24, foamB.r * 0.76 + foamB.g * 0.24, wB);
  let patOcean = textureSample(foamTex, sampR, xz * 0.23 + vec2f(0.013, 0.0) * t).r * 0.78 + bub * 0.22;
  let pat = mix(patFluvial, patOcean, oceanBlend);
  let fw = fwidth(pat) + 0.03;

  // ---- Fluvial surface mechanics (advected current trains, swirling eddies, boils, standing riffles) ----
  let detail1 = 1.0 - smoothstep(0.18, 0.75, footprint * 1.15);
  let detail2 = 1.0 - smoothstep(0.16, 0.65, footprint * 2.45);
  let eddyAmt = clamp(in.hydroVars.z, 0.0, 1.0);
  let riffleAmt = clamp(in.hydroVars.w, 0.0, 1.5);
  let thalDist = in.hydroVars.y - in.coordThal.z;
  let coreWeight = exp(-2.2 * thalDist * thalDist);
  let gust = mix(0.35, 1.2, smoothstep(0.3, 0.72, gustN));

  var fluvialSl = vec2f(0.0);
  var boilSlick = 0.0;
  var eddyDimple = 0.0;
  let spinSign = select(-1.0, 1.0, thalDist >= 0.0);

  if (fluvialW > 0.001) {
    if (detail1 > 0.0) {
      let g1A = noiseGrad(vec2f(dot(posA, across) * 1.45, dot(posA, dir) * 0.85), 0.16);
      let g1B = noiseGrad(vec2f(dot(posB, across) * 1.45 + 7.1, dot(posB, dir) * 0.85 + 3.9), 0.16);
      let g1 = mix(g1A, g1B, wB);
      // Cross-stream gravity-capillary train propagated gently along current.
      let qAngle = dot(in.rawXZ, across) * 1.9 + dot(in.rawXZ, dir) * 0.65 - t * (1.2 + speed * 0.9);
      let cap1 = (across * 1.9 + dir * 0.65) * (-cos(qAngle) * 0.014 * smoothstep(0.25, 1.8, speed));
      fluvialSl += ((across * g1.x * 1.45 + dir * g1.y * 0.85) * 0.058 + cap1) * detail1;
    }
    if (detail2 > 0.0) {
      let g2A = noiseGrad(vec2f(dot(posA, across) * 3.1 + 11.7, dot(posA, dir) * 2.15 - 5.3), 0.14);
      let g2B = noiseGrad(vec2f(dot(posB, across) * 3.1 + 19.3, dot(posB, dir) * 2.15 + 4.1), 0.14);
      let g2 = mix(g2A, g2B, wB);
      fluvialSl += (across * g2.x * 3.1 + dir * g2.y * 2.15) * (0.025 * detail2);
    }
    // Swirling eddies in lateral shear layers, inner point bars & bridge wakes.
    if (eddyAmt > 0.06 && detail1 > 0.0 && !isPond) {
      let vScale = clamp(in.coordThal.y * 0.55, 2.2, 6.8);
      let ev = mix(eddyVortex(posA, t, spinSign, vScale), eddyVortex(posB, t, spinSign, vScale), wB);
      fluvialSl += ev.xy * (eddyAmt * detail1 * (0.65 + 0.5 * speed));
      eddyDimple = ev.z * eddyAmt;
    }
    // Upwelling boils ("kolks") in the deep fast thalweg.
    if (coreWeight > 0.18 && speed > 0.55 && !isCanal && !isPond && detail1 > 0.0) {
      let bk = mix(thalwegBoil(posA, t, 3.6), thalwegBoil(posB, t, 3.6), wB);
      boilSlick = bk.z * coreWeight * smoothstep(0.55, 1.6, speed) * 0.65;
      fluvialSl = mix(fluvialSl, fluvialSl * (1.0 - boilSlick) + bk.xy * coreWeight * 0.85, detail1);
    }
    // Standing V-chevron riffle wave trains over shallow fast gravel bars.
    if (riffleAmt > 0.12 && !isCanal && !isPond && detail1 > 0.0) {
      let chevPhase = in.coordThal.x * 2.15 - abs(thalDist) * max(in.coordThal.y, 1.0) * 0.88 + gnoise(in.rawXZ * 0.45) * 0.7;
      let chevDir = dir * 2.15 - across * (spinSign * 1.15);
      fluvialSl += chevDir * (cos(chevPhase) * 0.042 * riffleAmt * detail1);
    }
    let roughScale = select(clamp(0.58 + speed * 0.28, 0.50, 1.45), 0.36, isPond || isCanal);
    fluvialSl *= roughScale;
  }

  // Dynamic splash & boat-wake height-field slope on upland rivers/estuaries.
  var splashSl = vec2f(0.0);
  var splashFoam = 0.0;
  if (SW.step.w > 0.5) {
    let dxW = max(SW.nearDomain.w, 0.35);
    let swC = surfaceWaveAt(xz);
    let swX = surfaceWaveAt(xz + vec2f(dxW, 0.0)).x - surfaceWaveAt(xz - vec2f(dxW, 0.0)).x;
    let swZ = surfaceWaveAt(xz + vec2f(0.0, dxW)).x - surfaceWaveAt(xz - vec2f(0.0, dxW)).x;
    splashSl = vec2f(swX, swZ) / (2.0 * dxW);
    splashFoam = clamp(swC.z + swC.w * 0.6, 0.0, 1.0);
  }

  // ---- Estuary-to-ocean wave-current convergence (derivTex / momTex / coastalWaveState) ----
  var oceanSl = vec2f(0.0);
  var oceanCov = vec3f(0.0);
  var jxx = 0.0;
  var jzz = 0.0;
  var jxz = 0.0;
  var barSl = vec2f(0.0);
  var barFoam = 0.0;
  var shoreBreak = 0.0;
  var cwsBed = -3.0;
  var cwsSwashH = in.world.y;

  if (estuaryT > 0.001) {
    let cws = coastalWaveState(xz);
    cwsBed = cws.bed;
    var s = vec2f(0.0);
    for (var c = 0u; c < ${CASCADES}u; c++) {
      let invL = F.cascInvL[c >> 2u][c & 3u];
      let uv = xz * invL;
      let cw = select(cws.chopScale, cws.swellScale, c <= 1u);
      let gk = mix(1.0, gust, select(0.0, select(0.5, 1.0, c >= 4u), c >= 3u)) * cw;
      let mipLod = max(0.0, log2(max(footprint * invL * TEX_N, 1.0)));
      let dv = textureSampleLevel(derivTex, sampR, uv, c, mipLod) * gk;
      let moments = textureSampleLevel(momTex, sampR, uv, c, mipLod);
      let mv = moments.xyz * (gk * gk);
      s += dv.xy;
      jxx += dv.z;
      jzz += dv.w;
      jxz += moments.w * gk;
      oceanCov += vec3f(max(mv.x - dv.x * dv.x, 0.0), max(mv.y - dv.y * dv.y, 0.0), mv.z - dv.x * dv.y);
    }
    let jx = max(1.0 + jxx, 0.15);
    let jz = max(1.0 + jzz, 0.15);
    oceanSl = coastalRefractSlope(xz, vec2f(s.x / jx, s.y / jz), cws) + cws.extraSlope;

    let bankMask = mix(1.0 - 0.85 * smoothstep(0.68, 1.0, bankAbs), 1.0, seaOpen);
    let barEnv = 4.0 * estuaryT * (1.0 - estuaryT) * (1.0 - smoothstep(0.72, 0.89, oceanConv)) * bankMask;
    let opposing = clamp(-dot(dir, cws.shoreDir) * 0.65 + 0.45, 0.0, 1.15);
    let bw = riverBarWave(xz, dir, cws.shoreDir, speed, t);
    let barScale = barEnv * opposing * (0.45 + 0.45 * min(speed, 2.0));
    barSl = bw.yz * barScale;
    let crestLine = smoothstep(0.015, 0.075, bw.x);
    barFoam = clamp(barEnv * opposing * crestLine * (0.48 + 0.52 * speed * 0.5), 0.0, 0.82);
    shoreBreak = coastalBreakerFoam(xz, cwsSwashH, oceanSl + barSl, cws);
  }

  let sl = fluvialSl * fluvialW + oceanSl * oceanBlend + barSl + splashSl;
  let nrm = normalize(vec3f(-sl.x, 1.0, -sl.y));

  // LEAN anisotropic covariance: preserves unresolved fluvial ripple sheen far upstream and merges seamlessly into oceanCov.
  let fluvialBaseVar = select(0.0022 + speed * 0.0026 + riffleAmt * 0.0045 + eddyAmt * 0.0020, 0.0014, isPond || isCanal);
  let unresFluvial = fluvialBaseVar * (1.0 - detail2 * 0.55) * (1.0 - boilSlick * 0.72) * fluvialW * fluvialW;
  let unresOcean = F.waterCol.w + 0.0035 * smoothstep(30.0, 500.0, dist);
  var cov = oceanCov * (oceanBlend * oceanBlend) + vec3f(unresOcean * oceanBlend + unresFluvial + length(barSl) * 0.015, unresOcean * oceanBlend + unresFluvial + length(barSl) * 0.015, 0.0);
  cov.x = max(cov.x, 1e-4);
  cov.y = max(cov.y, 1e-4);

  let V = normalize(F.camPos.xyz - in.world);
  let Ld = F.sunDir.xyz;
  let shadow = inlandShadowVis(in.world) * inlandCloudShadow(in.world);
  let sunVisNorm = solarShadowVisibility(vec3f(shadow));
  let sunlight = sunIlluminance() * sunVis[0];
  let sunE = sunlight * sunVisNorm;
  let waterSun = sunE;
  let moonE = lunarIlluminance() * sunVis[1] * lunarShadowVisibility(vec3f(shadow));

  let skyUp = textureSampleLevel(envCube, sampC, vec3f(0.0, 1.0, 0.0), ENV_MAXMIP).rgb;
  let skyHemi = skyUp * 0.4 + 0.15 * (
      textureSampleLevel(envCube, sampC, vec3f(0.94, 0.34, 0.0), ENV_MAXMIP - 1.0).rgb +
      textureSampleLevel(envCube, sampC, vec3f(-0.94, 0.34, 0.0), ENV_MAXMIP - 1.0).rgb +
      textureSampleLevel(envCube, sampC, vec3f(0.0, 0.34, 0.94), ENV_MAXMIP - 1.0).rgb +
      textureSampleLevel(envCube, sampC, vec3f(0.0, 0.34, -0.94), ENV_MAXMIP - 1.0).rgb);

  // ---- Sun & Moon glitter: exact anisotropic Gaussian LEAN microfacet BRDF matching ocean.js ----
  let Hv = normalize(V + Ld);
  let hs = -Hv.xz / max(Hv.y, 1e-3);
  let dsl = hs - sl;
  let det = max(cov.x * cov.y - cov.z * cov.z, 1e-10);
  let e = (dsl.x * dsl.x * cov.y + dsl.y * dsl.y * cov.x - 2.0 * dsl.x * dsl.y * cov.z) / det;
  let pdf = exp(-0.5 * e) / (2.0 * PI * sqrt(det));
  let hy2 = Hv.y * Hv.y;
  let Dm = pdf / max(hy2 * hy2, 1e-6);
  let G = 1.0 / (1.0 + lambdaSmith(V, cov) + lambdaSmith(Ld, cov));
  let Fh = fresnelWater(dot(V, Hv));
  let spec = sunE * (Fh * Dm * G / (4.0 * max(V.y, 0.02))) * step(0.0, Ld.y);

  var moonSpec = vec3f(0.0);
  if (lunarIrradiance() > 0.0) {
    let mh = normalize(V + lunarDirection());
    let ms = -mh.xz / max(mh.y, 1e-3) - sl;
    let me = (ms.x * ms.x * cov.y + ms.y * ms.y * cov.x - 2.0 * ms.x * ms.y * cov.z) / det;
    let md = exp(-0.5 * me) / (2.0 * PI * sqrt(det) * max(pow(mh.y, 4.0), 1e-6));
    let mg = 1.0 / (1.0 + lambdaSmith(V, cov) + lambdaSmith(lunarDirection(), cov));
    moonSpec = moonE * fresnelWater(dot(V, mh)) * md * mg / (4.0 * max(V.y, 0.02));
  }

  // ---- Grazing facet-tilted sky reflection (exact match to ocean.js) ----
  let sig = sqrt(max(cov.x + cov.y, 1e-6) * 0.5);
  let vh = normalize(vec3f(V.x, 0.0, V.z) + vec3f(1e-5, 0.0, 0.0));
  let sigV = sqrt(max(vh.x * vh.x * cov.x + vh.z * vh.z * cov.y + 2.0 * vh.x * vh.z * cov.z, 1e-6));
  let aV = max(V.y, 1e-3) / max(sqrt(1.0 - V.y * V.y), 1e-3) / (1.4142 * sigV);
  let tilt = 0.32 * sigV * (1.0 - smoothstep(0.0, 2.5, aV));
  let nV = normalize(nrm + vh * tilt);
  var R = reflect(-V, nV);
  R.y = abs(R.y) * 0.4 + max(R.y, 0.0) * 0.6;
  R = normalize(R);
  let envLod = clamp(log2(max(2.0 * sig * ENV_TEXELS_PER_RAD, 1.0)), 0.0, ENV_MAXMIP);
  let refl = textureSampleLevel(envCube, sampC, R, envLod).rgb;
  let nF = normalize(mix(nrm, vec3f(0.0, 1.0, 0.0), 0.45));
  let Fr = fresnelWater(max(dot(nF, V), 0.0));

  // ---- Refracted riverbed + advected solar caustics + Beer-Lambert freshwater-to-ocean convergence ----
  let depth = max(0.08, in.hydroVars.x * (1.0 - 0.55 * bankAbs * bankAbs * (1.0 - seaOpen)));
  let refr = refract(-V, nrm, 1.0 / 1.333);
  let rayStep = depth / max(-refr.y, 0.25);
  let bedXZ = in.rawXZ + refr.xz * clamp(rayStep, 0.0, 4.5);
  let pebble = select(0.0, gnoise(bedXZ * 3.4) * (1.0 - smoothstep(0.12, 0.55, footprint * 3.4)), detail2 > 0.0);
  let bankAO = mix(1.0, 0.72, smoothstep(0.58, 0.96, bankAbs) * (1.0 - seaOpen));
  let bedShallow = vec3f(0.118, 0.100, 0.075) * (1.0 + 0.20 * pebble);
  let bedDeep = select(vec3f(0.032, 0.046, 0.036), vec3f(0.025, 0.042, 0.039), isPond);
  let bedAlbedo = mix(bedShallow, bedDeep, smoothstep(0.20, 1.55, depth));

  // Current-advected underwater solar caustics along shallow gravel/sand beds.
  var caustic = 1.0;
  let sunUpOr = max(Ld.y, 0.0);
  if (sunUpOr > 0.03 && detail1 > 0.0 && fluvialW > 0.02) {
    let caA = abs(gnoise(posA * 2.1 + vec2f(3.2, -1.7)));
    let caB = abs(gnoise(posB * 2.1 + vec2f(-4.6, 5.1)));
    let netA = pow(clamp(1.0 - caA * 3.2, 0.0, 1.0), 2.4);
    let netB = pow(clamp(1.0 - caB * 3.2, 0.0, 1.0), 2.4);
    caustic = 1.0 + mix(netA, netB, wB) * 1.45 * smoothstep(0.06, 0.55, depth) * exp(-depth * 0.65) * detail1;
  }

  let directBed = sunE * max(Ld.y, 0.0) * caustic + moonE * max(lunarDirection().y, 0.0);
  let bedLit = bedAlbedo * (directBed * bankAO / PI + skyHemi * 0.55 * bankAO);

  let absorb = exp(-min(rayStep, 5.5) * vec3f(0.76, 0.34, 0.28));
  let riverTint = select(vec3f(0.017, 0.056, 0.045), vec3f(0.014, 0.046, 0.045), isPond);
  let riverScatter = riverTint * (skyHemi * 1.35 * bankAO + sunE * max(Ld.y, 0.0) * 0.62 * bankAO + moonE * max(lunarDirection().y, 0.0) * 0.62) * (1.0 - absorb);
  var riverBody = bedLit * absorb + riverScatter;

  var body = riverBody;
  if (estuaryT > 0.001) {
    var oceanBody = F.waterCol.rgb * (skyHemi * 1.6 + waterSun * max(Ld.y, 0.0) * 0.8 + moonE * max(lunarDirection().y, 0.0) * 0.8);
    let crest = clamp((in.world.y - 0.05) / 0.9, 0.0, 1.0);
    let toSun = max(dot(Ld, -V), 0.0);
    let thin = pow(clamp(0.5 - 0.5 * dot(Ld, nrm), 0.0, 1.0), 3.0);
    let k1 = F.sssCol.w * crest * crest * pow(toSun, 4.0) * thin * exp(-dist / 600.0);
    oceanBody += F.sssCol.rgb * mix(waterSun, sunE, 0.65) * k1;
    oceanBody = coastalBody(oceanBody, cwsBed);
    // Outflow sediment plume stays faintly greenish along the center jet longer than on flanking marine margins.
    let jetPlume = exp(-bankAbs * bankAbs * 1.8) * (1.0 - oceanBlend * 0.55);
    let plumeBody = mix(riverScatter + bedLit * absorb * 0.35, vec3f(0.028, 0.078, 0.060) * (skyHemi * 1.45 + waterSun * max(Ld.y, 0.0) * 0.72), 0.55 * (1.0 - absorb.r));
    body = mix(mix(riverBody, plumeBody, clamp(estuaryT * 1.4 * jetPlume, 0.0, 1.0)), oceanBody, oceanBlend);
  }

  // ---- Foam: advected riffle lace, swirling eddy scum, bridge cutwater wakes & river-bar breaker convergence ----
  let riffleCover = smoothstep(0.28, 1.15, riffleAmt) * (0.42 + 0.58 * clamp(0.5 + 0.65 * gnoise(posA * 0.9), 0.0, 1.0));
  let eddyCover = smoothstep(0.32, 0.92, eddyAmt) * smoothstep(0.65, 2.4, speed) * (0.28 + 0.45 * eddyDimple) * 0.58;
  let bankLace = smoothstep(0.84, 0.99, bankAbs) * (1.0 - seaOpen) * smoothstep(0.85, 2.1, speed) * 0.30;
  let freshOcean = select(0.0, breakingCompression(jxx, jzz, jxz, F.foamP.x), estuaryT > 0.001);
  let fluvialFoam = clamp(riffleCover * 0.62 + eddyCover + bankLace + splashFoam * 0.85, 0.0, 0.88);
  var cover = mix(fluvialFoam, max(max(freshOcean * 0.82 * F.foamP.z, shoreBreak * 0.92), barFoam), oceanBlend);
  cover = max(cover, barFoam);
  cover *= mix(mix(0.45, 1.0, smoothstep(0.25, 0.75, streak)), 1.0, clamp(riffleCover + barFoam + freshOcean, 0.0, 1.0));

  let soft = 0.04 + 0.14 * (1.0 - clamp(cover, 0.0, 1.0));
  let fm = smoothstep(1.0 - cover - fw - soft, 1.0 - cover + fw + soft, pat);
  var foamMask = clamp(fm * smoothstep(0.0, 0.45, cover), 0.0, 1.0) * (0.68 + 0.32 * smoothstep(0.3, 0.9, cover));
  foamMask = max(foamMask, max(freshOcean, barFoam) * smoothstep(0.26, 0.68, pat) * 0.82);
  foamMask = max(foamMask, shoreBreak * (0.58 + 0.42 * smoothstep(0.22, 0.78, pat)));
  foamMask = max(foamMask, cover * 0.22 * smoothstep(0.3, 0.75, pat));

  let foamAlb = vec3f(0.82, 0.87, 0.92) * (0.78 + 0.3 * bub);
  let foamAmb = skyHemi * 1.0;
  let foamAmbN = mix(foamAmb, vec3f(dot(foamAmb, vec3f(0.2126, 0.7152, 0.0722))), 0.85);
  let foamLit = foamAlb * ((sunE * max(dot(nrm, Ld), 0.0) + moonE * max(dot(nrm, lunarDirection()), 0.0)) * 0.318 * 0.5 + foamAmbN * 1.55);

  let effectiveFr = Fr * (1.0 - foamMask * 0.72);
  var col = body * (1.0 - effectiveFr) + refl * effectiveFr + spec + moonSpec;
  col = mix(col, foamLit, foamMask * 0.95);

  let surfaceAlbedo = mix(mix(riverTint, F.waterCol.rgb, oceanBlend), foamAlb, foamMask);
  col += lightningSurface(nrm, V, surfaceAlbedo, 0.23)
    + worldFireSurface(in.world, nrm, V, surfaceAlbedo, mix(0.14, 0.42, foamMask))
    + lightningCloud(reflect(-V, nrm)) * effectiveFr;

  if (estuaryT > 0.001) {
    let swashCol = coastalSwash(col, xz, cwsBed, cwsSwashH, foamLit);
    col = mix(col, swashCol, oceanBlend);
  }
  col = surfaceAir(col, in.world);
  let seaWing = smoothstep(0.38, 0.52, estuaryT);
  let lateralFade = mix(1.0, pow(clamp(1.0 - bankAbs, 0.0, 1.0), 1.65), seaWing);
  let axialFade = 1.0 - smoothstep(0.38, 0.95, estuaryT);
  let rippleHold = clamp(length(fluvialSl) * 2.0 + length(barSl) * 2.8 + barFoam * 0.85, 0.0, 0.40)
    * (1.0 - smoothstep(0.68, 0.95, estuaryT)) * lateralFade;
  let outAlpha = select(1.0, clamp(axialFade * lateralFade + rippleHold, 0.0, 1.0), estuaryT > 0.38);
  return vec4f(col, outAlpha);
}
`;
