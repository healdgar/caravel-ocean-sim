// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Freshwater rivers, mill-leats, canals and dammed estate ponds on Old World boards.
// Drawn in the main opaque pass with depth writes and zero discard so Apple TBDR
// hidden-surface removal stays intact while carved terrain banks clip waterlines cleanly.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SAMPLE } from './clouds.js';
import { SHADOW_FRAME } from './shadows.js';

export const INLAND_WATER_FLOATS = 8;

export const INLAND_WATER_WGSL = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
struct InlandNearDomain {
  domain: vec4f,
  grid: vec4f,
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(12) var<uniform> nearTerrain: InlandNearDomain;
` + SHADOW_FRAME + SKY_RENDER_FUNCS + CLOUD_SAMPLE + /* wgsl */ `
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;

struct InlandWaterOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) rawXZ: vec2f,
  @location(2) flow: vec2f,
  @location(3) params: vec3f,
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

@vertex fn inlandWaterVS(
  @location(0) position: vec3f,
  @location(1) flow: vec2f,
  @location(2) params: vec3f,
) -> InlandWaterOut {
  var o: InlandWaterOut;
  let calm = 1.0 - 0.65 * clamp(abs(params.y), 0.0, 1.0);
  let swell = 0.012 * calm * sin(dot(position.xz, vec2f(0.85, 0.63)) - F.camPos.w * 2.2);
  let shifted = position + vec3f(nearTerrain.grid.y, swell, nearTerrain.grid.z);
  o.world = shifted;
  o.rawXZ = position.xz;
  o.flow = flow;
  o.params = params;
  o.pos = F.viewProj * vec4f(earthCurve(shifted - F.camPos.xyz, F.camPos.y), 1.0);
  return o;
}

@fragment fn inlandWaterFS(in: InlandWaterOut) -> @location(0) vec4f {
  let dx = dpdx(in.rawXZ);
  let dy = dpdy(in.rawXZ);
  let footprint = sqrt(dot(dx, dx) + dot(dy, dy));
  let detail1 = 1.0 - smoothstep(0.16, 0.68, footprint * 1.35);
  let detail2 = 1.0 - smoothstep(0.14, 0.58, footprint * 2.9);

  let speed = length(in.flow);
  let isPond = in.params.z > 1.5;
  let isCanal = abs(in.params.z - 1.0) < 0.4;
  let dir = select(normalize(F.windP[0].xy + vec2f(1e-4, 0.0)), in.flow / max(speed, 1e-4), speed > 1e-3);
  let across = vec2f(-dir.y, dir.x);
  let t = F.camPos.w;
  let adv1 = select(0.48 + speed * 0.72, 0.18, isPond);
  let adv2 = select(0.86 + speed * 1.15, 0.31, isPond);

  let p1 = vec2f(dot(in.rawXZ, across) * 1.35, dot(in.rawXZ, dir) * 0.92 - t * adv1);
  let p2 = vec2f(dot(in.rawXZ, across) * 2.85 + 11.7, dot(in.rawXZ, dir) * 2.05 - t * adv2 - 5.3);

  var grad = vec2f(0.0);
  if (detail1 > 0.0) {
    let e = 0.16;
    let gx = gnoise(p1 + vec2f(e, 0.0)) - gnoise(p1 - vec2f(e, 0.0));
    let gz = gnoise(p1 + vec2f(0.0, e)) - gnoise(p1 - vec2f(0.0, e));
    grad += (across * gx * 1.35 + dir * gz * 0.92) * (0.055 * detail1);
  }
  if (detail2 > 0.0) {
    let e = 0.14;
    let gx = gnoise(p2 + vec2f(e, 0.0)) - gnoise(p2 - vec2f(e, 0.0));
    let gz = gnoise(p2 + vec2f(0.0, e)) - gnoise(p2 - vec2f(0.0, e));
    grad += (across * gx * 2.85 + dir * gz * 2.05) * (0.022 * detail2);
  }
  let chopScale = select(clamp(0.55 + speed * 0.32, 0.45, 1.35), 0.38, isPond || isCanal);
  let n = normalize(vec3f(-grad.x * chopScale, 1.0, -grad.y * chopScale));

  let bankAbs = clamp(abs(in.params.y), 0.0, 1.0);
  let depth = max(0.08, in.params.x * (1.0 - 0.62 * bankAbs * bankAbs));
  let pebble = select(0.0, gnoise(in.rawXZ * 3.4) * (1.0 - smoothstep(0.12, 0.55, footprint * 3.4)), detail2 > 0.0);
  let bedShallow = vec3f(0.115, 0.098, 0.074) * (1.0 + 0.18 * pebble);
  let bedDeep = select(vec3f(0.036, 0.048, 0.038), vec3f(0.028, 0.044, 0.040), isPond);
  let bedAlbedo = mix(bedShallow, bedDeep, smoothstep(0.22, 1.65, depth));

  let sunUp = max(F.sunDir.y, 0.0);
  let shadow = inlandShadowVis(in.world) * inlandCloudShadow(in.world);
  let sunVis = solarShadowVisibility(vec3f(shadow));
  let directIrr = sunIlluminance() * sunVis * max(dot(vec3f(0.0, 1.0, 0.0), F.sunDir.xyz), 0.0);
  let skyAmb = skyAtmo(vec3f(0.0, 1.0, 0.0)) * 0.42;
  let bedLit = bedAlbedo * (directIrr / PI + skyAmb);

  // Beer-Lambert freshwater absorption (tannin/chlorophyll tint) + body scatter.
  let absorb = exp(-depth * vec3f(0.72, 0.34, 0.24));
  let bodyTint = select(vec3f(0.018, 0.052, 0.050), vec3f(0.015, 0.045, 0.046), isPond);
  let bodyScatter = bodyTint * (directIrr * 0.22 + skyAmb * 0.85) * (1.0 - absorb);
  var waterBody = bedLit * absorb + bodyScatter;

  // Riffle foam on steeper mountain brooks and mill-tailraces.
  let riffle = smoothstep(1.35, 2.75, speed) * (0.45 + 0.55 * clamp(0.5 + 0.65 * gnoise(p1 * 1.4), 0.0, 1.0));
  let bankLace = smoothstep(0.84, 0.99, bankAbs) * smoothstep(0.85, 2.1, speed) * 0.32;
  let foamAmt = clamp(riffle * 0.48 + bankLace, 0.0, 0.68) * (0.4 + 0.6 * detail1);
  let foamCol = vec3f(0.76, 0.79, 0.80) * (directIrr / PI + skyAmb * 1.15);

  let v = normalize(F.camPos.xyz - in.world);
  let nDotV = max(dot(n, v), 1e-4);
  let f0 = 0.021;
  let fresnel = clamp(f0 + (0.92 - f0) * pow(1.0 - nDotV, 5.0), 0.02, 0.92) * (1.0 - foamAmt * 0.72);

  var reflDir = reflect(-v, n);
  reflDir.y = max(reflDir.y, 0.015);
  let rough = clamp(mix(0.065, 0.22, clamp(speed * 0.18 + footprint * 0.06, 0.0, 1.0)), 0.06, 0.35);
  let skyRefl = textureSampleLevel(envCube, sampC, normalize(reflDir), rough * 5.2).rgb;

  // Sun GGX glint on flowing ripples.
  let h = normalize(v + F.sunDir.xyz);
  let nDotH = max(dot(n, h), 0.0);
  let nDotL = max(dot(n, F.sunDir.xyz), 0.0);
  let a2 = max(rough * rough * rough * rough, 1e-4);
  let denom = nDotH * nDotH * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * denom * denom);
  let sunSpec = sunIlluminance() * sunVis * min(D * fresnel * nDotL / max(4.0 * nDotV, 1e-3), 3.5) * (1.0 - foamAmt * 0.8);

  var col = mix(waterBody, skyRefl, fresnel) + sunSpec;
  col = mix(col, foamCol, foamAmt);
  col += lunarSurface(n, v, bodyTint, rough, vec3f(f0), lunarShadowVisibility(vec3f(shadow)));
  col = surfaceAir(col, in.world);
  return vec4f(col, 1.0);
}
`;
