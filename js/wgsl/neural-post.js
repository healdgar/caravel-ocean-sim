// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// WebGPU WGSL shaders for the 1-Step Conditional Flow & Detail Pass:
//   1. createNeuralEncodeWGSL: Quarter-resolution G-buffer proxy & stem 1x1 encoder (pack2x16float)
//   2. createNeuralTrunkWGSL:  Workgroup-tiled 2-block Multi-Scale ConvNeXt (3x3 + dil-5 + dil-14)
//                              with motion-reprojected temporal latent stabilization
//   3. createNeuralComposite:  Fused full-resolution joint-bilateral GI upsample + zero-bias
//                              3x3 -> 8 (tanh) -> 3 optical micro-detail CNN inside COMPOSITE

import { FRAME_WGSL, SANE_HDR } from './common.js';

export const NEURAL_WEIGHTS_STRUCT_WGSL = /* wgsl */ `
struct NeuralWeights {
  stemW:    array<mat4x4f, 9>,
  stemB:    array<vec4f, 3>,
  b1Spat:   array<vec4f, 27>,
  b1Dil:    array<vec4f, 12>,
  b1SpatB:  array<vec4f, 3>,
  b1ExpW:   array<mat4x4f, 12>,
  b1ExpB:   array<vec4f, 4>,
  b1ProjW:  array<mat4x4f, 12>,
  b1ProjB:  array<vec4f, 3>,
  b2Spat:   array<vec4f, 27>,
  b2Dil:    array<vec4f, 12>,
  b2SpatB:  array<vec4f, 3>,
  b2ExpW:   array<mat4x4f, 12>,
  b2ExpB:   array<vec4f, 4>,
  b2ProjW:  array<mat4x4f, 12>,
  b2ProjB:  array<vec4f, 3>,
  headW:    array<mat4x4f, 3>,
  headB:    vec4f,
  detailW1: array<mat4x4f, 9>,
  detailW2: array<mat4x4f, 3>,
};

struct NeuralParams {
  prevViewProj: mat4x4f,
  camDelta:     vec4f,   // xyz = camPos_t - camPos_{t-1}, w = historyValid (0 or 1)
  tuning:       vec4f,   // x = strength, y = giGain, z = detailGain, w = temporalAlpha
};

fn neuralSilu(v: vec4f) -> vec4f {
  return v / (vec4f(1.0) + exp(-clamp(v, vec4f(-20.0), vec4f(20.0))));
}

fn neuralLuma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}
`;

export function createNeuralEncodeWGSL({ depthGuided = false, samples = 4 } = {}) {
  const sampleCount = Math.max(1, Math.floor(samples));
  const depthTexType = sampleCount === 1 ? 'texture_depth_2d' : 'texture_depth_multisampled_2d';
  const depthSampleArg = sampleCount === 1 ? '0' : 's';
  const depthDecl = depthGuided
    ? /* wgsl */ `@group(0) @binding(5) var sceneDepth: ${depthTexType};`
    : '';
  const depthHelpers = depthGuided ? /* wgsl */ `
const NEURAL_NEAR_Z: f32 = 0.05;
fn neuralLoadFrontDepth(px: vec2i, dims: vec2i) -> f32 {
  let c = clamp(px, vec2i(0), dims - vec2i(1));
  var d = 0.0;
  for (var s = 0; s < ${sampleCount}; s++) {
    d = max(d, textureLoad(sceneDepth, c, ${depthSampleArg}));
  }
  return d;
}
fn neuralViewPosAt(px: vec2i, dims: vec2i, d: f32) -> vec3f {
  let uv = (vec2f(px) + 0.5) / vec2f(dims);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let vDir = F.camFwd.xyz + ndc.x * F.camRight.xyz + ndc.y * F.camUp.xyz;
  return vDir * (NEURAL_NEAR_Z / max(d, 1e-7));
}
fn neuralReconstructNormal(px: vec2i, dims: vec2i, d0: f32, p0: vec3f) -> vec3f {
  let dL = neuralLoadFrontDepth(px + vec2i(-1, 0), dims);
  let dR = neuralLoadFrontDepth(px + vec2i( 1, 0), dims);
  let dU = neuralLoadFrontDepth(px + vec2i(0, -1), dims);
  let dD = neuralLoadFrontDepth(px + vec2i(0,  1), dims);
  let z0 = NEURAL_NEAR_Z / max(d0, 1e-7);
  let zL = select(1e6, NEURAL_NEAR_Z / max(dL, 1e-7), dL > 0.0);
  let zR = select(1e6, NEURAL_NEAR_Z / max(dR, 1e-7), dR > 0.0);
  let zU = select(1e6, NEURAL_NEAR_Z / max(dU, 1e-7), dU > 0.0);
  let zD = select(1e6, NEURAL_NEAR_Z / max(dD, 1e-7), dD > 0.0);
  let errL = abs(zL - z0);
  let errR = abs(zR - z0);
  let errU = abs(zU - z0);
  let errD = abs(zD - z0);
  let pL = neuralViewPosAt(px + vec2i(-1, 0), dims, max(dL, 1e-6));
  let pR = neuralViewPosAt(px + vec2i( 1, 0), dims, max(dR, 1e-6));
  let pU = neuralViewPosAt(px + vec2i(0, -1), dims, max(dU, 1e-6));
  let pD = neuralViewPosAt(px + vec2i(0,  1), dims, max(dD, 1e-6));
  let maxJump = 0.06 * z0 + 0.08;
  let fallbackDx = F.camRight.xyz * (z0 * 0.003);
  let fallbackDy = -F.camUp.xyz * (z0 * 0.003);
  let rawDx = select(pR - p0, p0 - pL, errL < errR);
  let rawDy = select(pD - p0, p0 - pU, errU < errD);
  let dx = select(fallbackDx, rawDx, min(errL, errR) < maxJump);
  let dy = select(fallbackDy, rawDy, min(errU, errD) < maxJump);
  let n = cross(dy, dx);
  let len2 = dot(n, n);
  if (len2 < 1e-12) { return normalize(-p0); }
  var nw = n * inverseSqrt(len2);
  if (dot(nw, -p0) < 0.0) { nw = -nw; }
  return nw;
}
` : '';

  const featureX2Block = depthGuided ? /* wgsl */ `
  var repK = 5;
  var bestLumaDiff = 1e9;
  for (var k = 0; k < 16; k++) {
    let diff = abs(lumas[k] - meanY);
    if (diff < bestLumaDiff) {
      bestLumaDiff = diff;
      repK = k;
    }
  }
  let bestSubPx = clamp(basePx + vec2i(repK & 3, repK >> 2), vec2i(0), dims - vec2i(1));
  let bestDepth = neuralLoadFrontDepth(bestSubPx, dims);
  let camR = normalize(F.camRight.xyz);
  let camU = normalize(F.camUp.xyz);
  if (bestDepth > 0.0) {
    let p0 = neuralViewPosAt(bestSubPx, dims, bestDepth);
    let nWorld = neuralReconstructNormal(bestSubPx, dims, bestDepth, p0);
    let zEye = NEURAL_NEAR_Z / bestDepth;
    let depthCode = clamp(log2(1.0 + zEye * 0.15) * 0.18, 0.02, 1.0);
    x2 = vec4f(dot(nWorld, camR), dot(nWorld, camU), dot(nWorld, sunDir), depthCode);
    skyOrDepthGuide = depthCode;
  } else {
    x2 = vec4f(0.0);
    skyOrDepthGuide = 0.0;
  }
  ` : /* wgsl */ `
  let ray = normalize(F.camFwd.xyz + ndc.x * F.camRight.xyz + ndc.y * F.camUp.xyz);
  let skyLike = smoothstep(-0.01, 0.22, ray.y) * exp(-detailEnergy * 5.0);
  x2 = vec4f(ray.y, dot(ray, sunDir), sunDir.y, skyLike);
  skyOrDepthGuide = 1.0 - skyLike;
  `;

  return FRAME_WGSL + SANE_HDR + NEURAL_WEIGHTS_STRUCT_WGSL + depthHelpers + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> NW: NeuralWeights;
@group(0) @binding(2) var hdrTex: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> featBuf: array<u32>;
@group(0) @binding(4) var currGuideOut: texture_storage_2d<rgba16float, write>;
${depthDecl}

@compute @workgroup_size(8, 8)
fn neuralEncode(@builtin(global_invocation_id) gid: vec3u) {
  let qDims = vec2i(textureDimensions(currGuideOut));
  if (i32(gid.x) >= qDims.x || i32(gid.y) >= qDims.y) { return; }
  let dims = vec2i(textureDimensions(hdrTex));
  let qx = i32(gid.x);
  let qy = i32(gid.y);
  let basePx = vec2i(qx * 4, qy * 4);

  var sumC = vec3f(0.0);
  var lumas: array<f32, 16>;
  var sumY = 0.0;
  var sumLeft = 0.0; var sumRight = 0.0;
  var sumTop = 0.0;  var sumBot = 0.0;

  for (var dy = 0; dy < 4; dy++) {
    for (var dx = 0; dx < 4; dx++) {
      let sp = clamp(basePx + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
      let c = saneHDR(textureLoad(hdrTex, sp, 0).rgb);
      let y = log2(1.0 + neuralLuma(c));
      let k = dy * 4 + dx;
      lumas[k] = y;
      sumC += c;
      sumY += y;
      if (dx < 2) { sumLeft += y; } else { sumRight += y; }
      if (dy < 2) { sumTop += y; } else { sumBot += y; }
    }
  }

  let meanC = sumC * (1.0 / 16.0);
  let meanLogC = log2(vec3f(1.0) + meanC);
  let meanY = sumY * (1.0 / 16.0);
  var madY = 0.0;
  for (var k = 0; k < 16; k++) {
    madY += abs(lumas[k] - meanY);
  }
  let detailEnergy = clamp((madY * (1.0 / 16.0)) / (0.08 + meanY * 0.35), 0.0, 2.0);
  let gradX = clamp((sumRight - sumLeft) * 0.125, -1.5, 1.5);
  let gradY = clamp((sumBot - sumTop) * 0.125, -1.5, 1.5);
  let denom = meanC.r + meanC.g + meanC.b + 0.03;
  let warmth = (meanC.r - meanC.b) / denom;
  let greenness = (meanC.g - 0.5 * (meanC.r + meanC.b)) / denom;

  let uv = (vec2f(f32(qx), f32(qy)) + 0.5) / vec2f(qDims);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let sunDir = normalize(F.sunDir.xyz);

  let x0 = vec4f(meanLogC, detailEnergy);
  let x1 = vec4f(gradX, gradY, warmth, greenness);
  var x2: vec4f;
  var skyOrDepthGuide: f32;
  ${featureX2Block}

  // Fused 1x1 Stem Projection + SiLU -> pack2x16float (24 bytes/cell)
  let h0 = neuralSilu(NW.stemB[0] + NW.stemW[0] * x0 + NW.stemW[1] * x1 + NW.stemW[2] * x2);
  let h1 = neuralSilu(NW.stemB[1] + NW.stemW[3] * x0 + NW.stemW[4] * x1 + NW.stemW[5] * x2);
  let h2 = neuralSilu(NW.stemB[2] + NW.stemW[6] * x0 + NW.stemW[7] * x1 + NW.stemW[8] * x2);

  let base = u32(qy * qDims.x + qx) * 6u;
  featBuf[base + 0u] = pack2x16float(h0.xy);
  featBuf[base + 1u] = pack2x16float(h0.zw);
  featBuf[base + 2u] = pack2x16float(h1.xy);
  featBuf[base + 3u] = pack2x16float(h1.zw);
  featBuf[base + 4u] = pack2x16float(h2.xy);
  featBuf[base + 5u] = pack2x16float(h2.zw);

  textureStore(currGuideOut, vec2i(qx, qy), vec4f(meanY, warmth, greenness, skyOrDepthGuide));
}
`;
}

export function createNeuralTrunkWGSL({ depthGuided = false } = {}) {
  const reprojectClipWGSL = depthGuided ? /* wgsl */ `
    let zEye = max(0.05, (exp2(guide.w / 0.18) - 1.0) / 0.15);
    let prevClip = NP.prevViewProj * vec4f(vDir * zEye + NP.camDelta.xyz, 1.0);
  ` : /* wgsl */ `
    let prevClip = NP.prevViewProj * vec4f(vDir, 0.0);
  `;

  // Unroll 3x3 depthwise taps with compile-time constant uniform indices so Metal/Vulkan/D3D12
  // promote NW.b1Spat / NW.b2Spat into constant registers with zero dynamic uniform indexing.
  const buildUnrolled3x3 = (txVar, tyVar, stride, accPfx, weightField) => {
    const lines = [];
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const dxExpr = dx === 0 ? txVar : (dx < 0 ? `${txVar} - 1` : `${txVar} + 1`);
        const dyExpr = dy === 0 ? tyVar : (dy < 0 ? `${tyVar} - 1` : `${tyVar} + 1`);
        const idxVar = `${accPfx}Idx${k}`;
        lines.push(`  let ${idxVar} = ((${dyExpr}) * ${stride} + (${dxExpr})) * 3;`);
        lines.push(`  ${accPfx}a += wgTile[${idxVar} + 0] * NW.${weightField}[${k * 3 + 0}];`);
        lines.push(`  ${accPfx}b += wgTile[${idxVar} + 1] * NW.${weightField}[${k * 3 + 1}];`);
        lines.push(`  ${accPfx}c += wgTile[${idxVar} + 2] * NW.${weightField}[${k * 3 + 2}];`);
        k++;
      }
    }
    return lines.join('\n');
  };
  const b1SpatUnrolledWGSL = buildUnrolled3x3('tx', 'ty', 12, 's1', 'b1Spat');
  const b2SpatUnrolledWGSL = buildUnrolled3x3('bx', 'by', 10, 's2', 'b2Spat');

  return FRAME_WGSL + NEURAL_WEIGHTS_STRUCT_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> NW: NeuralWeights;
@group(0) @binding(2) var<uniform> NP: NeuralParams;
@group(0) @binding(3) var<storage, read> featBuf: array<u32>;
@group(0) @binding(4) var currGuideTex: texture_2d<f32>;
@group(0) @binding(5) var prevGuideTex: texture_2d<f32>;
@group(0) @binding(6) var prevLightTex: texture_2d<f32>;
@group(0) @binding(7) var linSamp: sampler;
@group(0) @binding(8) var currLightOut: texture_storage_2d<rgba16float, write>;

// Shared 12x12 tile of 12-channel activations (144 * 3 * 16 = 6,912 bytes < 16 KB WebGPU guarantee)
var<workgroup> wgTile: array<vec4f, 432>;

struct Feat12 { a: vec4f, b: vec4f, c: vec4f };

fn readFeatGlobal(q: vec2i, qDims: vec2i) -> Feat12 {
  let cq = clamp(q, vec2i(0), qDims - vec2i(1));
  let base = u32(cq.y * qDims.x + cq.x) * 6u;
  let a01 = unpack2x16float(featBuf[base + 0u]);
  let a23 = unpack2x16float(featBuf[base + 1u]);
  let b01 = unpack2x16float(featBuf[base + 2u]);
  let b23 = unpack2x16float(featBuf[base + 3u]);
  let c01 = unpack2x16float(featBuf[base + 4u]);
  let c23 = unpack2x16float(featBuf[base + 5u]);
  return Feat12(vec4f(a01, a23), vec4f(b01, b23), vec4f(c01, c23));
}

fn evalBlock1(tx: i32, ty: i32, qGlobal: vec2i, qDims: vec2i) -> Feat12 {
  let centerIdx = (ty * 12 + tx) * 3;
  let h0a = wgTile[centerIdx + 0];
  let h0b = wgTile[centerIdx + 1];
  let h0c = wgTile[centerIdx + 2];

  var s1a = NW.b1SpatB[0];
  var s1b = NW.b1SpatB[1];
  var s1c = NW.b1SpatB[2];

${b1SpatUnrolledWGSL}

  let d0 = readFeatGlobal(qGlobal + vec2i(-5, 0), qDims);
  let d1 = readFeatGlobal(qGlobal + vec2i( 5, 0), qDims);
  let d2 = readFeatGlobal(qGlobal + vec2i(0, -5), qDims);
  let d3 = readFeatGlobal(qGlobal + vec2i(0,  5), qDims);
  s1a += d0.a * NW.b1Dil[0] + d1.a * NW.b1Dil[3] + d2.a * NW.b1Dil[6] + d3.a * NW.b1Dil[9];
  s1b += d0.b * NW.b1Dil[1] + d1.b * NW.b1Dil[4] + d2.b * NW.b1Dil[7] + d3.b * NW.b1Dil[10];
  s1c += d0.c * NW.b1Dil[2] + d1.c * NW.b1Dil[5] + d2.c * NW.b1Dil[8] + d3.c * NW.b1Dil[11];

  let e0 = neuralSilu(NW.b1ExpB[0] + NW.b1ExpW[0] * s1a + NW.b1ExpW[1] * s1b + NW.b1ExpW[2] * s1c);
  let e1 = neuralSilu(NW.b1ExpB[1] + NW.b1ExpW[3] * s1a + NW.b1ExpW[4] * s1b + NW.b1ExpW[5] * s1c);
  let e2 = neuralSilu(NW.b1ExpB[2] + NW.b1ExpW[6] * s1a + NW.b1ExpW[7] * s1b + NW.b1ExpW[8] * s1c);
  let e3 = neuralSilu(NW.b1ExpB[3] + NW.b1ExpW[9] * s1a + NW.b1ExpW[10] * s1b + NW.b1ExpW[11] * s1c);

  let p0 = NW.b1ProjB[0] + NW.b1ProjW[0] * e0 + NW.b1ProjW[1] * e1 + NW.b1ProjW[2] * e2 + NW.b1ProjW[3] * e3;
  let p1 = NW.b1ProjB[1] + NW.b1ProjW[4] * e0 + NW.b1ProjW[5] * e1 + NW.b1ProjW[6] * e2 + NW.b1ProjW[7] * e3;
  let p2 = NW.b1ProjB[2] + NW.b1ProjW[8] * e0 + NW.b1ProjW[9] * e1 + NW.b1ProjW[10] * e2 + NW.b1ProjW[11] * e3;

  return Feat12(h0a + p0, h0b + p1, h0c + p2);
}

@compute @workgroup_size(8, 8)
fn neuralTrunk(
  @builtin(workgroup_id) wgid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(local_invocation_index) tid: u32,
) {
  let qDims = vec2i(textureDimensions(currLightOut));
  let baseQ = vec2i(i32(wgid.x) * 8, i32(wgid.y) * 8);

  // 1. Cooperatively load 12x12 stem feature halo into wgTile
  for (var idx = tid; idx < 144u; idx += 64u) {
    let tx = i32(idx % 12u);
    let ty = i32(idx / 12u);
    let f = readFeatGlobal(baseQ + vec2i(tx - 2, ty - 2), qDims);
    let at = idx * 3u;
    wgTile[at + 0u] = f.a;
    wgTile[at + 1u] = f.b;
    wgTile[at + 2u] = f.c;
  }
  workgroupBarrier();

  // 2. Evaluate Block 1 across the 10x10 interior so Block 2 has an exact 1-cell halo
  var b1Out0: Feat12;
  var b1Out1: Feat12;
  let has0 = tid < 100u;
  let has1 = (tid + 64u) < 100u;
  if (has0) {
    let bx = i32(tid % 10u);
    let by = i32(tid / 10u);
    b1Out0 = evalBlock1(bx + 1, by + 1, baseQ + vec2i(bx - 1, by - 1), qDims);
  }
  if (has1) {
    let id1 = tid + 64u;
    let bx = i32(id1 % 10u);
    let by = i32(id1 / 10u);
    b1Out1 = evalBlock1(bx + 1, by + 1, baseQ + vec2i(bx - 1, by - 1), qDims);
  }
  workgroupBarrier();

  if (has0) {
    let at = tid * 3u;
    wgTile[at + 0u] = b1Out0.a;
    wgTile[at + 1u] = b1Out0.b;
    wgTile[at + 2u] = b1Out0.c;
  }
  if (has1) {
    let at = (tid + 64u) * 3u;
    wgTile[at + 0u] = b1Out1.a;
    wgTile[at + 1u] = b1Out1.b;
    wgTile[at + 2u] = b1Out1.c;
  }
  workgroupBarrier();

  // 3. Evaluate Block 2 + Flow Output Head + Motion-Reprojected Temporal Gate on 8x8 output
  let q = baseQ + vec2i(i32(lid.x), i32(lid.y));
  if (q.x >= qDims.x || q.y >= qDims.y) { return; }

  let bx = i32(lid.x) + 1;
  let by = i32(lid.y) + 1;
  let cIdx = (by * 10 + bx) * 3;
  let h1a = wgTile[cIdx + 0];
  let h1b = wgTile[cIdx + 1];
  let h1c = wgTile[cIdx + 2];

  var s2a = NW.b2SpatB[0];
  var s2b = NW.b2SpatB[1];
  var s2c = NW.b2SpatB[2];

${b2SpatUnrolledWGSL}

  let w0 = readFeatGlobal(q + vec2i(-14, 0), qDims);
  let w1 = readFeatGlobal(q + vec2i( 14, 0), qDims);
  let w2 = readFeatGlobal(q + vec2i(0, -14), qDims);
  let w3 = readFeatGlobal(q + vec2i(0,  14), qDims);
  s2a += w0.a * NW.b2Dil[0] + w1.a * NW.b2Dil[3] + w2.a * NW.b2Dil[6] + w3.a * NW.b2Dil[9];
  s2b += w0.b * NW.b2Dil[1] + w1.b * NW.b2Dil[4] + w2.b * NW.b2Dil[7] + w3.b * NW.b2Dil[10];
  s2c += w0.c * NW.b2Dil[2] + w1.c * NW.b2Dil[5] + w2.c * NW.b2Dil[8] + w3.c * NW.b2Dil[11];

  let g0 = neuralSilu(NW.b2ExpB[0] + NW.b2ExpW[0] * s2a + NW.b2ExpW[1] * s2b + NW.b2ExpW[2] * s2c);
  let g1 = neuralSilu(NW.b2ExpB[1] + NW.b2ExpW[3] * s2a + NW.b2ExpW[4] * s2b + NW.b2ExpW[5] * s2c);
  let g2 = neuralSilu(NW.b2ExpB[2] + NW.b2ExpW[6] * s2a + NW.b2ExpW[7] * s2b + NW.b2ExpW[8] * s2c);
  let g3 = neuralSilu(NW.b2ExpB[3] + NW.b2ExpW[9] * s2a + NW.b2ExpW[10] * s2b + NW.b2ExpW[11] * s2c);

  let h2a = h1a + NW.b2ProjB[0] + NW.b2ProjW[0] * g0 + NW.b2ProjW[1] * g1 + NW.b2ProjW[2] * g2 + NW.b2ProjW[3] * g3;
  let h2b = h1b + NW.b2ProjB[1] + NW.b2ProjW[4] * g0 + NW.b2ProjW[5] * g1 + NW.b2ProjW[6] * g2 + NW.b2ProjW[7] * g3;
  let h2c = h1c + NW.b2ProjB[2] + NW.b2ProjW[8] * g0 + NW.b2ProjW[9] * g1 + NW.b2ProjW[10] * g2 + NW.b2ProjW[11] * g3;

  let raw = NW.headB + NW.headW[0] * h2a + NW.headW[1] * h2b + NW.headW[2] * h2c;
  let guide = textureLoad(currGuideTex, q, 0);
  let surfaceGate = clamp(guide.w * (1.0 / 0.04), 0.0, 1.0);

  let occLogGain = 2.25 * tanh(clamp(raw.x, -15.0, 15.0)) * surfaceGate;
  let rPos = max(raw.yzw, vec3f(0.0));
  let sqrtBounce = 1.75 * tanh(clamp(rPos, vec3f(0.0), vec3f(15.0))) * surfaceGate;
  var outLight = vec4f(occLogGain, sqrtBounce);

  // Motion-vector reprojection into previous frame's latent buffer
  if (NP.camDelta.w > 0.5 && surfaceGate > 0.001) {
    let uv = (vec2f(q) + 0.5) / vec2f(qDims);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let vDir = F.camFwd.xyz + ndc.x * F.camRight.xyz + ndc.y * F.camUp.xyz;
    ${reprojectClipWGSL}
    if (prevClip.w > 1e-4) {
      let prevNdc = prevClip.xy / prevClip.w;
      let prevUv = vec2f(prevNdc.x * 0.5 + 0.5, 0.5 - prevNdc.y * 0.5);
      if (all(prevUv >= vec2f(0.0)) && all(prevUv <= vec2f(1.0))) {
        let prevGuideRaw = textureSampleLevel(prevGuideTex, linSamp, prevUv, 0.0);
        let prevLightRaw = textureSampleLevel(prevLightTex, linSamp, prevUv, 0.0);
        let prevGuide = select(vec4f(0.0), clamp(prevGuideRaw, vec4f(-16.0), vec4f(16.0)), prevGuideRaw == prevGuideRaw);
        let prevLight = select(vec4f(0.0), clamp(prevLightRaw, vec4f(-8.0), vec4f(8.0)), prevLightRaw == prevLightRaw);
        let diff = abs(guide - prevGuide);
        let conf = exp(-dot(diff, vec4f(3.2, 4.5, 4.5, 9.0)));
        let alpha = NP.tuning.w * conf;
        outLight = mix(outLight, prevLight, alpha);
      }
    }
  }

  textureStore(currLightOut, q, outLight);
}
`;
}

// Injects fused joint-bilateral neural illumination upsampling + zero-bias 3x3 -> 8 -> 3
// optical micro-detail CNN into COMPOSITE right after `c = saneHDR(c);`, with zero extra
// full-resolution render pass. Supports both plain COMPOSITE and createUnderwaterPost(COMPOSITE, 'composite').
export function createNeuralComposite(compositeSource) {
  const anchor = /c\s*=\s*saneHDR\s*\(\s*c\s*\)\s*;/;
  if (!anchor.test(compositeSource)) {
    throw new Error('Unrecognized COMPOSITE source for neural light pass');
  }
  const declarations = NEURAL_WEIGHTS_STRUCT_WGSL + /* wgsl */ `
@group(1) @binding(0) var neuralLightTex: texture_2d<f32>;
@group(1) @binding(1) var neuralGuideTex: texture_2d<f32>;
@group(1) @binding(2) var<uniform> NW: NeuralWeights;
@group(1) @binding(3) var<uniform> NP: NeuralParams;

fn neuralApplyHDR(cIn: vec3f, pc: vec2i, uv: vec2f, dimsI: vec2i) -> vec3f {
  let strength = NP.tuning.x;
  if (strength <= 0.001) { return cIn; }

  let cLuma = neuralLuma(cIn);
  let cLogY = log2(1.0 + cLuma);
  let denom = cIn.r + cIn.g + cIn.b + 0.03;
  let cWarm = (cIn.r - cIn.b) / denom;
  let cGreen = (cIn.g - 0.5 * (cIn.r + cIn.b)) / denom;

  // 1. Joint-bilateral upsampling of 1/4-res 3D-guided illumination & contact occlusion
  let qDims = vec2i(textureDimensions(neuralLightTex));
  let qMax = qDims - vec2i(1);
  let qCoord = uv * vec2f(qDims) - 0.5;
  let qBase = vec2i(floor(qCoord));
  let qFrac = qCoord - vec2f(qBase);

  let qp00 = clamp(qBase, vec2i(0), qMax);
  let qp10 = clamp(qBase + vec2i(1, 0), vec2i(0), qMax);
  let qp01 = clamp(qBase + vec2i(0, 1), vec2i(0), qMax);
  let qp11 = clamp(qBase + vec2i(1, 1), vec2i(0), qMax);

  let g00 = textureLoad(neuralGuideTex, qp00, 0);
  let g10 = textureLoad(neuralGuideTex, qp10, 0);
  let g01 = textureLoad(neuralGuideTex, qp01, 0);
  let g11 = textureLoad(neuralGuideTex, qp11, 0);

  let e00 = exp(-abs(cLogY - g00.x) * 7.2 - (abs(cWarm - g00.y) + abs(cGreen - g00.z)) * 6.8);
  let e10 = exp(-abs(cLogY - g10.x) * 7.2 - (abs(cWarm - g10.y) + abs(cGreen - g10.z)) * 6.8);
  let e01 = exp(-abs(cLogY - g01.x) * 7.2 - (abs(cWarm - g01.y) + abs(cGreen - g01.z)) * 6.8);
  let e11 = exp(-abs(cLogY - g11.x) * 7.2 - (abs(cWarm - g11.y) + abs(cGreen - g11.z)) * 6.8);

  let maxEdgeW = max(max(e00, e10), max(e01, e11));
  let w00 = 1e-5 + (1.0 - qFrac.x) * (1.0 - qFrac.y) * e00;
  let w10 = 1e-5 + qFrac.x * (1.0 - qFrac.y) * e10;
  let w01 = 1e-5 + (1.0 - qFrac.x) * qFrac.y * e01;
  let w11 = 1e-5 + qFrac.x * qFrac.y * e11;
  let invWSum = 1.0 / (w00 + w10 + w01 + w11);

  let s00 = clamp(g00.w * (1.0 / 0.04), 0.0, 1.0);
  let s10 = clamp(g10.w * (1.0 / 0.04), 0.0, 1.0);
  let s01 = clamp(g01.w * (1.0 / 0.04), 0.0, 1.0);
  let s11 = clamp(g11.w * (1.0 / 0.04), 0.0, 1.0);
  let surfaceMask = (s00 * w00 + s10 * w10 + s01 * w01 + s11 * w11) * invWSum;
  if (surfaceMask <= 0.001) { return cIn; }

  let l00 = textureLoad(neuralLightTex, qp00, 0);
  let l10 = textureLoad(neuralLightTex, qp10, 0);
  let l01 = textureLoad(neuralLightTex, qp01, 0);
  let l11 = textureLoad(neuralLightTex, qp11, 0);
  let light = (l00 * w00 + l10 * w10 + l01 * w01 + l11 * w11) * invWSum;
  let bilateralConf = smoothstep(0.05, 0.36, maxEdgeW);

  // 2. Zero-extra-HDR-read compact optical relief MLP from center pixel residual (cLogY - gMeanY) + guide slopes
  let gMeanY = (g00.x * w00 + g10.x * w10 + g01.x * w01 + g11.x * w11) * invWSum;
  let hf = cLogY - gMeanY;
  let gx = 0.25 * ((g10.x - g00.x) + (g11.x - g01.x));
  let gy = 0.25 * ((g01.x - g00.x) + (g11.x - g10.x));
  let yN = -hf - gy;
  let yS = -hf + gy;
  let yW = -hf - gx;
  let yE = -hf + gx;
  let gradMag = abs(yN) + abs(yS) + abs(yE) + abs(yW);

  let d0 = vec4f(yN - gx, yN, yN + gx, yW) * 3.0;
  let d2 = vec4f(-hf * 3.0, -hf * 3.0, cWarm * gradMag * 4.0, cGreen * gradMag * 4.0);
  let dh0 = tanh(clamp(NW.detailW1[0] * d0 + NW.detailW1[2] * d2, vec4f(-12.0), vec4f(12.0)));
  let detLogRGB = (NW.detailW2[0] * dh0).xyz;

  // Suppress micro-sharpening on specular sun glints and clear sky dome
  let glintGuard = 1.0 / (1.0 + max(0.0, cLuma - 1.25) * 1.5);
  let detailGain = clamp(detLogRGB * (NP.tuning.z * 1.75 * strength * surfaceMask * glintGuard), vec3f(-0.92), vec3f(0.92));

  // 3. Physically energy-bounded composition in linear HDR space (calibrated for AgX 16.5-stop curve):
  //    - Zero-centered EV contact occlusion darkens corners/seams/alleys (-1.3 to -2.4 EV) without washing open sea
  //    - Color-preserving albedo reflectance keeps dark timber deep while warming shaded limestone & canvas
  let giScale = NP.tuning.y * strength * surfaceMask * bilateralConf;
  let occStops = clamp(light.x * giScale * 1.70, -2.40, 0.05);
  let occFactor = exp2(occStops);
  let sqrtB = max(light.yzw, vec3f(0.0));
  let bounceLinear = sqrtB * sqrtB;
  let surfAlbedo = clamp(cIn / (0.055 + cLuma), vec3f(0.0), vec3f(0.92));
  let shadowReceptivity = 1.0 / (1.0 + cLuma * 1.85);
  let bounceAdd = surfAlbedo * bounceLinear * (giScale * 1.15 * shadowReceptivity * glintGuard);

  let lit = cIn * occFactor + bounceAdd;
  return max(vec3f(0.0), lit * exp2(detailGain));
}
`;

  const injected = compositeSource.replace(
    anchor,
    'c = saneHDR(c);\n  c = neuralApplyHDR(c, pc, in.uv, vec2i(dims));',
  );
  return declarations + injected;
}
