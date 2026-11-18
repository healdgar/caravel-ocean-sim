// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Offline dataset capture for the WebGPU 3D-Guided Neural Light & Detail Pass.
// Renders diverse coastal, port, fortress, town, forest, and open-ocean scenes,
// evaluates a 96-ray metric 3D screen-space path-traced GI + contact-occlusion
// reference compute shader on the GPU, and exports paired feature/target tensors.

import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { coastalRegionStageURL, landfallStageURL } from '../js/landfall.js';
import { aimAtBuilding } from './fort-battle.mjs';

const outDir = process.argv[2] || path.resolve('.neural-dataset');
fs.mkdirSync(outDir, { recursive: true });

const WIDTH = 640;
const HEIGHT = 400;
const QW = WIDTH >> 2;
const QH = HEIGHT >> 2;

const SCENES = [
  { name: 'lisbon-dock-golden', region: 'lisbon', stage: 'dock', weather: 'clear', params: { ship: 'victory', sunElev: 11, sunAzim: 118 } },
  { name: 'lisbon-dock-midday', region: 'lisbon', stage: 'dock', weather: 'clear', params: { ship: 'nina', sunElev: 52, sunAzim: 168 } },
  { name: 'lisbon-town-alleys', region: 'lisbon', stage: 'dock', weather: 'clear', params: { ship: 'victory', view: 'free', cam: '-70,34,-6250,0,-24', sunElev: 28, sunAzim: 135 } },
  { name: 'lisbon-bastion', region: 'lisbon', stage: 'dock', weather: 'clear', fort: true, params: { ship: 'victory', sunElev: 19, sunAzim: 145 } },
  { name: 'san-juan-harbour', region: 'san-juan', stage: 'dock', weather: 'clear', params: { ship: 'nina', sunElev: 34, sunAzim: 110 } },
  { name: 'saba-volcanic-coast', region: 'saba', stage: 'coast', weather: 'clear', params: { ship: 'nina', sunElev: 24, sunAzim: 95 } },
  { name: 'open-ocean-sunset-deck', ocean: true, params: { ship: 'nina', boat: 1, sunElev: 5.5, sunAzim: 18, clouds: 0.45, windSpeed: 9 } },
  { name: 'open-ocean-victory-orbit', ocean: true, params: { ship: 'victory', view: 'ship', sunElev: 38, sunAzim: 140, clouds: 0.65, windSpeed: 11 } },
];

function installCaptureHook() {
  window.__NEURAL_CAPTURE__ = { hdrTex: null, depthMS: null, frameUBO: null, device: null };

  const origReqDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const dev = await origReqDevice.apply(this, args);
    window.__NEURAL_CAPTURE__.device = dev;
    return dev;
  };

  const origCreateBuffer = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function (desc) {
    let nextDesc = desc;
    if (desc?.label && desc.label.includes('frame ubo')) {
      nextDesc = { ...desc, usage: desc.usage | GPUBufferUsage.COPY_SRC };
    }
    const buf = origCreateBuffer.call(this, nextDesc);
    if (desc?.label && desc.label.includes('frame ubo')) {
      window.__NEURAL_CAPTURE__.frameUBO = buf;
    }
    return buf;
  };

  const origCreateTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (desc) {
    const sizeArr = Array.isArray(desc.size) ? desc.size : [desc.size.width, desc.size.height ?? 1, desc.size.depthOrArrayLayers ?? 1];
    const isFull = sizeArr[0] === 640 && sizeArr[1] === 400 && (sizeArr[2] ?? 1) === 1;
    let nextDesc = desc;
    if (isFull && desc.format === 'rgba16float' && (desc.sampleCount ?? 1) === 1 && (desc.mipLevelCount ?? 1) === 1 && !desc.label) {
      nextDesc = { ...desc, usage: desc.usage | GPUTextureUsage.COPY_SRC };
    }
    const tex = origCreateTexture.call(this, nextDesc);
    if (isFull && desc.format === 'rgba16float' && (desc.sampleCount ?? 1) === 1 && (desc.mipLevelCount ?? 1) === 1 && !desc.label) {
      window.__NEURAL_CAPTURE__.hdrTex = tex;
    }
    if (isFull && desc.format === 'depth32float' && desc.sampleCount === 4) {
      window.__NEURAL_CAPTURE__.depthMS = tex;
    }
    return tex;
  };

  const origBeginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
    if (desc?.depthStencilAttachment && desc?.colorAttachments?.[0]?.resolveTarget) {
      desc = {
        ...desc,
        depthStencilAttachment: {
          ...desc.depthStencilAttachment,
          depthStoreOp: 'store',
        },
      };
    }
    return origBeginRenderPass.call(this, desc);
  };
}

const TEACHER_WGSL = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  camPos:   vec4f,
  camRight: vec4f,
  camUp:    vec4f,
  camFwd:   vec4f,
  sunDir:   vec4f,
  screen:   vec4f,
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var hdrTex: texture_2d<f32>;
@group(0) @binding(2) var depthMS: texture_depth_multisampled_2d;
@group(0) @binding(3) var<storage, read_write> outFastFeat: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> outDepthFeat: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> outTeacherGI: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> outFullHdrDepth: array<vec4f>;

const PI: f32 = 3.14159265358979;
const NEAR_Z: f32 = 0.05;

fn saneHDR(c: vec3f) -> vec3f {
  let nan = (bitcast<vec3u>(c) & vec3u(0x7fffffffu)) > vec3u(0x7f800000u);
  return select(clamp(c, vec3f(0.0), vec3f(65504.0)), vec3f(0.0), any(nan));
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn loadFrontDepth(px: vec2i, dims: vec2i) -> f32 {
  let c = clamp(px, vec2i(0), dims - vec2i(1));
  var d = 0.0;
  for (var s = 0; s < 4; s++) {
    d = max(d, textureLoad(depthMS, c, s));
  }
  return d;
}

fn viewPosAt(px: vec2i, dims: vec2i, d: f32) -> vec3f {
  let uv = (vec2f(px) + 0.5) / vec2f(dims);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let vDir = F.camFwd.xyz + ndc.x * F.camRight.xyz + ndc.y * F.camUp.xyz;
  let zEye = NEAR_Z / max(d, 1e-7);
  return vDir * zEye;
}

fn reconstructNormal(px: vec2i, dims: vec2i, d0: f32, p0: vec3f) -> vec3f {
  let dL = loadFrontDepth(px + vec2i(-1, 0), dims);
  let dR = loadFrontDepth(px + vec2i( 1, 0), dims);
  let dU = loadFrontDepth(px + vec2i(0, -1), dims);
  let dD = loadFrontDepth(px + vec2i(0,  1), dims);
  let pL = viewPosAt(px + vec2i(-1, 0), dims, max(dL, 1e-6));
  let pR = viewPosAt(px + vec2i( 1, 0), dims, max(dR, 1e-6));
  let pU = viewPosAt(px + vec2i(0, -1), dims, max(dU, 1e-6));
  let pD = viewPosAt(px + vec2i(0,  1), dims, max(dD, 1e-6));
  let dxL = p0 - pL;
  let dxR = pR - p0;
  let dyU = p0 - pU;
  let dyD = pD - p0;
  let useL = abs(dL - d0) < abs(dR - d0) && dL > 0.0;
  let useU = abs(dU - d0) < abs(dD - d0) && dU > 0.0;
  let dx = select(dxR, dxL, useL);
  let dy = select(dyD, dyU, useU);
  let n = cross(dy, dx);
  let len2 = dot(n, n);
  if (len2 < 1e-12) {
    return normalize(-p0);
  }
  var nw = n * inverseSqrt(len2);
  if (dot(nw, -p0) < 0.0) { nw = -nw; }
  return nw;
}

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

@compute @workgroup_size(8, 8)
fn dumpFull(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec2i(textureDimensions(hdrTex));
  if (i32(gid.x) >= dims.x || i32(gid.y) >= dims.y) { return; }
  let px = vec2i(gid.xy);
  let c = saneHDR(textureLoad(hdrTex, px, 0).rgb);
  let d = loadFrontDepth(px, dims);
  let zEye = select(0.0, NEAR_Z / d, d > 0.0);
  outFullHdrDepth[u32(px.y * dims.x + px.x)] = vec4f(c, zEye);
}

@compute @workgroup_size(8, 8)
fn computeTeacher(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec2i(textureDimensions(hdrTex));
  let qDims = dims / 4;
  if (i32(gid.x) >= qDims.x || i32(gid.y) >= qDims.y) { return; }
  let qx = i32(gid.x);
  let qy = i32(gid.y);
  let basePx = vec2i(qx * 4, qy * 4);

  // 1. Gather 4x4 patch statistics matching runtime NEURAL_ENCODE
  var sumC = vec3f(0.0);
  var lumas: array<f32, 16>;
  var sumY = 0.0;
  var sumLeft = 0.0; var sumRight = 0.0;
  var sumTop = 0.0;  var sumBot = 0.0;
  var bestDepth = 0.0;
  var bestSubPx = basePx + vec2i(1, 1);

  for (var dy = 0; dy < 4; dy++) {
    for (var dx = 0; dx < 4; dx++) {
      let sp = clamp(basePx + vec2i(dx, dy), vec2i(0), dims - vec2i(1));
      let c = saneHDR(textureLoad(hdrTex, sp, 0).rgb);
      let y = log2(1.0 + luma(c));
      let k = dy * 4 + dx;
      lumas[k] = y;
      sumC += c;
      sumY += y;
      if (dx < 2) { sumLeft += y; } else { sumRight += y; }
      if (dy < 2) { sumTop += y; } else { sumBot += y; }
      let d = loadFrontDepth(sp, dims);
      if (d > bestDepth) {
        bestDepth = d;
        bestSubPx = sp;
      }
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
  let ray = normalize(F.camFwd.xyz + ndc.x * F.camRight.xyz + ndc.y * F.camUp.xyz);
  let sunDir = normalize(F.sunDir.xyz);
  let skyLike = smoothstep(-0.02, 0.22, ray.y) * exp(-detailEnergy * 5.0);

  let idx3 = u32(qy * qDims.x + qx) * 3u;
  outFastFeat[idx3 + 0u] = vec4f(meanLogC, detailEnergy);
  outFastFeat[idx3 + 1u] = vec4f(gradX, gradY, warmth, greenness);
  outFastFeat[idx3 + 2u] = vec4f(ray.y, dot(ray, sunDir), sunDir.y, skyLike);

  let camR = normalize(F.camRight.xyz);
  let camU = normalize(F.camUp.xyz);
  var nViewXY = vec2f(0.0);
  var nDotSun = 0.0;
  var depthCode = 0.0;

  if (bestDepth > 0.0) {
    let p0 = viewPosAt(bestSubPx, dims, bestDepth);
    let nWorld = reconstructNormal(bestSubPx, dims, bestDepth, p0);
    nViewXY = vec2f(dot(nWorld, camR), dot(nWorld, camU));
    nDotSun = dot(nWorld, sunDir);
    let zEye = NEAR_Z / bestDepth;
    depthCode = clamp(log2(1.0 + zEye * 0.15) * 0.18, 0.02, 1.0);
  }
  outDepthFeat[idx3 + 0u] = vec4f(meanLogC, detailEnergy);
  outDepthFeat[idx3 + 1u] = vec4f(gradX, gradY, warmth, greenness);
  outDepthFeat[idx3 + 2u] = vec4f(nViewXY.x, nViewXY.y, nDotSun, depthCode);

  // 2. Reference 96-ray metric 3D screen-space path-traced GI + contact occlusion
  let qIdx = u32(qy * qDims.x + qx);
  if (bestDepth <= 0.0) {
    outTeacherGI[qIdx] = vec4f(0.0);
    return;
  }

  let p0 = viewPosAt(bestSubPx, dims, bestDepth);
  let z0 = NEAR_Z / bestDepth;
  if (z0 > 1800.0) {
    outTeacherGI[qIdx] = vec4f(0.0);
    return;
  }
  let n0 = reconstructNormal(bestSubPx, dims, bestDepth, p0);
  let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n0.y) > 0.92);
  let t1 = normalize(cross(upRef, n0));
  let t2 = cross(n0, t1);

  var occNearSum = 0.0;
  var occMidSum = 0.0;
  var bounceSum = vec3f(0.0);
  let numRays = 96u;
  let distFade = 1.0 - smoothstep(450.0, 1600.0, z0);

  // Scale search radii gently with distance so nearby planks/embrasures & distant forts both resolve
  let rNearMax = clamp(0.45 + z0 * 0.028, 0.45, 4.5);
  let rMidMax = clamp(4.5 + z0 * 0.14, 4.5, 28.0);

  for (var r = 0u; r < numRays; r++) {
    let h0 = pcg(qIdx * 1973u + r * 9277u + 17u);
    let u1 = (f32(r) + (f32(h0 & 1023u) / 1024.0)) / f32(numRays);
    let u2 = f32((h0 >> 10u) & 4095u) / 4096.0;
    let rad = sqrt(clamp(u1, 0.0, 0.995));
    let phi = 2.0 * PI * u2;
    let dirLocal = vec3f(rad * cos(phi), rad * sin(phi), sqrt(max(0.0, 1.0 - u1)));
    let omega = normalize(t1 * dirLocal.x + t2 * dirLocal.y + n0 * dirLocal.z);

    var hitNear = 0.0;
    var hitMid = 0.0;
    var rayBounce = vec3f(0.0);
    let maxDist = select(rMidMax, rNearMax, (r & 1u) == 0u);
    let steps = 16u;

    for (var s = 1u; s <= steps; s++) {
      let frac = f32(s) / f32(steps);
      let t = maxDist * (frac * frac * 0.82 + frac * 0.18);
      let samplePos = p0 + omega * t + n0 * (0.015 + z0 * 0.0015);
      let clip = F.viewProj * vec4f(samplePos, 1.0);
      if (clip.w <= 0.05) { continue; }
      let sNdc = clip.xy / clip.w;
      if (abs(sNdc.x) > 0.998 || abs(sNdc.y) > 0.998) { break; }
      let sUv = vec2f(sNdc.x * 0.5 + 0.5, 0.5 - sNdc.y * 0.5);
      let sPx = vec2i(sUv * vec2f(dims));
      let sDepth = loadFrontDepth(sPx, dims);
      if (sDepth <= 0.0) { continue; }
      let sZ = NEAR_Z / sDepth;
      let pen = clip.w - sZ;
      let thickness = max(0.28, t * 0.55 + z0 * 0.012);
      if (pen > 0.012 + z0 * 0.0015 && pen < thickness) {
        let w = 1.0 - frac * 0.65;
        if (t <= rNearMax) {
          hitNear = max(hitNear, w);
        } else {
          hitMid = max(hitMid, w * 0.75);
        }
        let hitHdr = saneHDR(textureLoad(hdrTex, clamp(sPx, vec2i(0), dims - vec2i(1)), 0).rgb);
        let cappedHdr = hitHdr / (1.0 + luma(hitHdr) * 0.35);
        let distAtten = 1.0 / (1.0 + t * 0.16);
        rayBounce = cappedHdr * distAtten * dirLocal.z;
        break;
      }
    }
    if ((r & 1u) == 0u) {
      occNearSum += hitNear;
    } else {
      occMidSum += hitMid;
    }
    bounceSum += rayBounce;
  }

  let occNear = occNearSum / f32(numRays / 2u);
  let occMid = occMidSum / f32(numRays / 2u);
  let totalOcc = clamp(occNear * 0.72 + occMid * 0.42, 0.0, 0.92) * distFade;
  // Center log-gain slightly so flat open surfaces keep neutral exposure while crevices deepen
  let occLogGain = clamp((-totalOcc * 0.95 + 0.11 * distFade), -0.75, 0.14);
  let bounceIrr = clamp((bounceSum / f32(numRays)) * 2.6 * distFade, vec3f(0.0), vec3f(1.5));
  outTeacherGI[qIdx] = vec4f(occLogGain, bounceIrr);
}
`;

const server = createDevServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'],
});

const manifest = { width: WIDTH, height: HEIGHT, qw: QW, qh: QH, scenes: [] };

for (const scene of SCENES) {
  let url;
  if (scene.ocean) {
    url = new URL(base);
    url.searchParams.set('ocean', '1');
  } else if (scene.region === 'saba') {
    url = landfallStageURL(base, scene.stage, scene.weather);
  } else {
    url = coastalRegionStageURL(base, scene.region, scene.stage, scene.weather, 1650);
  }
  url.searchParams.set('w', String(WIDTH));
  url.searchParams.set('h', String(HEIGHT));
  url.searchParams.set('polygons', 'fixed');
  url.searchParams.set('reset', '1');
  for (const [k, v] of Object.entries(scene.params || {})) {
    url.searchParams.set(k, String(v));
  }

  console.log(`[capture] Loading ${scene.name} ...`);
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.addInitScript(installCaptureHook);
  await page.goto(url.toString());
  await page.waitForFunction(
    () => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed',
    null,
    { timeout: 120000, polling: 200 },
  );
  const state = await page.evaluate(() => window.oceanStartup?.state);
  if (state !== 'ready') {
    throw new Error(`Scene ${scene.name} failed startup`);
  }
  await page.waitForTimeout(3500);
  if (scene.fort) {
    await page.evaluate(aimAtBuilding, { prefab: 'city_battery', face: 1, height: 6, yaw: -14, elevation: 6, distance: 58 });
    await page.waitForTimeout(1500);
  }

  const buffers = await page.evaluate(async ({ teacherWgsl, qw, qh, width, height }) => {
    // Wait two animation frames so hdrTex and depthMS hold fresh resolved scene data
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const { device, hdrTex, depthMS, frameUBO } = window.__NEURAL_CAPTURE__;
    if (!device || !hdrTex || !depthMS || !frameUBO) {
      throw new Error('Missing captured WebGPU handles');
    }

    const module = device.createShaderModule({ code: teacherWgsl, label: 'teacher capture' });
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter((m) => m.type === 'error');
    if (errs.length) throw new Error(errs.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n'));

    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth', multisampled: true } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const pipeTeacher = await device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'computeTeacher' } });
    const pipeFull = await device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'dumpFull' } });

    const featBytes = qw * qh * 3 * 16;
    const giBytes = qw * qh * 16;
    const fullBytes = width * height * 16;

    const mkStorage = (size) => device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const mkRead = (size) => device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const bFast = mkStorage(featBytes);
    const bDepth = mkStorage(featBytes);
    const bGI = mkStorage(giBytes);
    const bFull = mkStorage(fullBytes);

    const rFast = mkRead(featBytes);
    const rDepth = mkRead(featBytes);
    const rGI = mkRead(giBytes);
    const rFull = mkRead(fullBytes);

    const bg = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: frameUBO, size: 160 } },
        { binding: 1, resource: hdrTex.createView() },
        { binding: 2, resource: depthMS.createView() },
        { binding: 3, resource: { buffer: bFast } },
        { binding: 4, resource: { buffer: bDepth } },
        { binding: 5, resource: { buffer: bGI } },
        { binding: 6, resource: { buffer: bFull } },
      ],
    });

    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setBindGroup(0, bg);
    cp.setPipeline(pipeTeacher);
    cp.dispatchWorkgroups(Math.ceil(qw / 8), Math.ceil(qh / 8));
    cp.setPipeline(pipeFull);
    cp.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    cp.end();

    enc.copyBufferToBuffer(bFast, 0, rFast, 0, featBytes);
    enc.copyBufferToBuffer(bDepth, 0, rDepth, 0, featBytes);
    enc.copyBufferToBuffer(bGI, 0, rGI, 0, giBytes);
    enc.copyBufferToBuffer(bFull, 0, rFull, 0, fullBytes);
    device.queue.submit([enc.finish()]);

    await Promise.all([rFast.mapAsync(GPUMapMode.READ), rDepth.mapAsync(GPUMapMode.READ), rGI.mapAsync(GPUMapMode.READ), rFull.mapAsync(GPUMapMode.READ)]);
    const toB64 = (buf) => {
      const bytes = new Uint8Array(buf.getMappedRange());
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    };
    const res = {
      fastB64: toB64(rFast),
      depthB64: toB64(rDepth),
      giB64: toB64(rGI),
      fullB64: toB64(rFull),
    };
    for (const b of [rFast, rDepth, rGI, rFull]) { b.unmap(); b.destroy(); }
    for (const b of [bFast, bDepth, bGI, bFull]) b.destroy();
    return res;
  }, { teacherWgsl: TEACHER_WGSL, qw: QW, qh: QH, width: WIDTH, height: HEIGHT });

  fs.writeFileSync(path.join(outDir, `${scene.name}.fast.f32`), Buffer.from(buffers.fastB64, 'base64'));
  fs.writeFileSync(path.join(outDir, `${scene.name}.depth.f32`), Buffer.from(buffers.depthB64, 'base64'));
  fs.writeFileSync(path.join(outDir, `${scene.name}.gi.f32`), Buffer.from(buffers.giB64, 'base64'));
  fs.writeFileSync(path.join(outDir, `${scene.name}.full.f32`), Buffer.from(buffers.fullB64, 'base64'));
  manifest.scenes.push(scene.name);
  console.log(`[capture] Saved ${scene.name} (${QW}x${QH} quarter, ${WIDTH}x${HEIGHT} full)`);
  await page.close();
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await browser.close();
server.closeAllConnections?.();
server.close();
console.log(`[capture] Complete: ${manifest.scenes.length} scenes written to ${outDir}`);
process.exit(0);
