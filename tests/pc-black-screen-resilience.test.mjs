// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { WAKE_UPDATE } from '../js/wgsl/interaction.js';
import { SURFACE_WAVE_UPDATE } from '../js/wgsl/surface-waves.js';
import { FOAM_UPDATE, ARRAY16_MIPS } from '../js/wgsl/sim.js';
import { CLOUD_RESOLVE } from '../js/wgsl/clouds.js';
import { WATER_OPTICS, WATER_TRANSMISSION, WATER_AIR_TRANSMISSION, WATER_SCENE_MIP_WGSL } from '../js/wgsl/water-optics.js';
import { createSubmergedShader } from '../js/water-optics.js';
import { WATER_FILTER } from '../js/wgsl/caravel.js';
import { createOpticalOcean, HEIGHT_PROBE } from '../js/wgsl/ocean.js';
import {
  CAMERA_MEDIUM_GUARD_WGSL,
  UNDERWATER_MEDIUM,
  applyCameraMedium,
} from '../js/wgsl/underwater.js';
import {
  BLOOM_DOWN,
  BLOOM_UP,
  COMPOSITE,
  createUnderwaterPost,
} from '../js/wgsl/post.js';
import { pruneWGSLFunctions } from '../js/wgsl-prune.js';
import {
  copyVessel,
  createVesselProbeState,
  acceptVesselProbe,
  stepVessel,
} from '../js/vessels.js';
import {
  requestWebGPUAdapter,
  requestWebGPUDevice,
} from '../js/webgpu-adapter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('1. D3D12/DXC signed pow(..., 2.0) NaN traps are eliminated from wake, surface-waves, terrain, and gunnery shaders', () => {
  const interactionSrc = readRepoFile('js/wgsl/interaction.js');
  const surfaceWavesSrc = readRepoFile('js/wgsl/surface-waves.js');
  const terrainSrc = readRepoFile('js/wgsl/terrain.js');
  const gunnerySrc = readRepoFile('js/wgsl/gunnery.js');

  assert.equal(/\bpow\s*\([^;]*,\s*2\.0\s*\)/.test(interactionSrc), false, 'interaction.js must not call pow(..., 2.0)');
  assert.equal(/\bpow\s*\([^;]*,\s*2\.0\s*\)/.test(surfaceWavesSrc), false, 'surface-waves.js must not call pow(..., 2.0)');
  assert.equal(/\bpow\s*\([^;]*,\s*2\.0\s*\)/.test(terrainSrc), false, 'terrain.js must not call pow(..., 2.0)');
  assert.equal(/\bpow\s*\([^;]*,\s*2\.0\s*\)/.test(gunnerySrc), false, 'gunnery.js must not call pow(..., 2.0)');

  assert.match(WAKE_UPDATE, /fn\s+wakeSqr\s*\(\s*x\s*:\s*f32\s*\)\s*->\s*f32\s*\{\s*return\s+x\s*\*\s*x\s*;\s*\}/);
  assert.match(SURFACE_WAVE_UPDATE, /fn\s+swSqr\s*\(\s*x\s*:\s*f32\s*\)\s*->\s*f32\s*\{\s*return\s+x\s*\*\s*x\s*;\s*\}/);
  assert.match(SURFACE_WAVE_UPDATE, /pow\s*\(\s*max\s*\(\s*abs\s*\(\s*uLong\s*\)\s*,\s*0\.0\s*\)\s*,\s*2\.35\s*\)/);
});

test('2. Persistent ping-pong & mip compute shaders sanitize NaN/Inf before textureStore and ocean shaders prune cleanly', () => {
  for (const [name, code] of [
    ['WAKE_UPDATE', WAKE_UPDATE],
    ['SURFACE_WAVE_UPDATE', SURFACE_WAVE_UPDATE],
    ['FOAM_UPDATE', FOAM_UPDATE],
    ['CLOUD_RESOLVE', CLOUD_RESOLVE],
  ]) {
    const storeIdx = code.lastIndexOf('textureStore(');
    assert.ok(storeIdx > 0, `${name} must contain textureStore`);
    assert.ok(
      /(!=)|(==)/.test(code.slice(0, storeIdx)) && /0x7f800000u/.test(code.slice(0, storeIdx)),
      `${name} must explicitly guard NaN and Inf before textureStore`,
    );
  }

  assert.match(WAKE_UPDATE, /1e4/);
  assert.match(SURFACE_WAVE_UPDATE, /1e4/);
  assert.match(ARRAY16_MIPS, /0x7f800000u/);
  assert.match(WATER_SCENE_MIP_WGSL, /6\.0e4/);
  assert.match(WATER_OPTICS, /fn\s+waterOpticsCleanTexel/);
  assert.match(WATER_FILTER, /saneHDR/);
  assert.match(HEIGHT_PROBE, /abs\(rawH\)\s*<\s*1e4/);

  const submerged = createSubmergedShader(
    `fn surfaceAir(c:vec3f,w:vec3f)->vec3f{return c;}
     struct V{@builtin(position)pos:vec4f,@location(0)world:vec3f};
     @fragment fn fs(v:V)->@location(0)vec4f{return vec4f(1.0);}`,
  );
  assert.match(submerged, /vec3f\(6\.0e4\)/);

  // Verify WATER_TRANSMISSION + WATER_AIR_TRANSMISSION contains no duplicate fn definitions
  const combinedOcean = createOpticalOcean('', true, true, true);
  const pruned = pruneWGSLFunctions(combinedOcean);
  assert.ok(pruned.includes('@fragment fn fs'), 'createOpticalOcean should prune cleanly with zero duplicate helper functions');
  assert.equal((WATER_OPTICS + WATER_TRANSMISSION.replace(WATER_OPTICS, '') + WATER_AIR_TRANSMISSION).match(/fn\s+waterOpticsCleanTexel/g)?.length, 1);
});

test('3. applyCameraMedium and underwater post shaders safely bypass NaN seaY, camY, or medium RGB instead of blacking out', () => {
  const air = [0.42, 0.58, 0.77];
  const sub = [0.04, 0.19, 0.28];

  const nanSea = new Float32Array(16);
  nanSea[9] = Number.NaN;
  assert.equal(applyCameraMedium(air, sub, nanSea, { camPos: { y: 4.0 } }), air);

  const infSea = new Float32Array(16);
  infSea[9] = Number.POSITIVE_INFINITY;
  assert.equal(applyCameraMedium(air, sub, infSea, { camPos: { y: 4.0 } }), air);

  const airSea = new Float32Array(16);
  airSea[9] = 0.2;
  assert.equal(applyCameraMedium(air, sub, airSea, { camPos: { y: 3.5 } }), air);

  const deepSea = new Float32Array(16);
  deepSea[9] = 5.0;
  assert.equal(applyCameraMedium(air, [Number.NaN, 0.2, 0.3], deepSea, { camPos: { y: 1.0 } }), air);
  assert.equal(applyCameraMedium(air, sub, deepSea, { camPos: { y: 1.0 } }), sub);

  assert.match(CAMERA_MEDIUM_GUARD_WGSL, /!\(seaY == seaY\)/);
  assert.match(CAMERA_MEDIUM_GUARD_WGSL, /!\(camY == camY\)/);
  assert.match(CAMERA_MEDIUM_GUARD_WGSL, /!\(r == r\)/);
  assert.match(UNDERWATER_MEDIUM, /!uwScalarFinite\(surfaceY\)/);
  assert.match(UNDERWATER_MEDIUM, /!\(r==r\)/);

  const uwBloom = createUnderwaterPost(BLOOM_DOWN, 'bloom');
  const uwComposite = createUnderwaterPost(COMPOSITE, 'composite');
  assert.match(uwBloom, /!postCameraScalarFinite\(postCameraSea\[9\]\)/);
  assert.match(uwComposite, /applyCameraMedium\(/);
});

test('4. BLOOM_DOWN, BLOOM_UP, and COMPOSITE enforce saneHDR across all mip levels, <= 3.0e4 f16 ceiling, and exposure/output guards', () => {
  // BLOOM_DOWN must sanitize taps in BOTH first-mip (Karis) and deeper-mip branches and clamp <= 3.0e4
  assert.match(BLOOM_DOWN, /let sa = saneHDR\(a\);/);
  assert.match(BLOOM_DOWN, /min\(saneHDR\(o\),\s*vec3f\(3\.0e4\)\)/);

  // BLOOM_UP must sanitize taps and clamp both tent and 3x3 branches <= 3.0e4
  assert.match(BLOOM_UP, /fn tap\(uv: vec2f\) -> vec3f \{ return saneHDR\(/);
  const upClamps = BLOOM_UP.match(/vec3f\(3\.0e4\)/g) ?? [];
  assert.ok(upClamps.length >= 2, 'BLOOM_UP must clamp both folded-tent and 9-tap outputs <= 3.0e4');

  // COMPOSITE must sanitize bloom sample, guard exposure U.p.x against NaN/<=0, and guard final output o
  assert.match(COMPOSITE, /saneHDR\(textureSampleLevel\(bloom,\s*samp,\s*in\.uv,\s*0\.0\)\.rgb\)/);
  assert.match(COMPOSITE, /U\.p\.x == U\.p\.x/);
  assert.match(COMPOSITE, /U\.p\.x > 0\.0/);
  assert.match(COMPOSITE, /clamp\(U\.p\.x,\s*1e-4,\s*1e4\)/);
  assert.match(COMPOSITE, /all\(o == o\)/);
});

test('5. acceptVesselProbe rejects non-finite or runaway probe arrays and stepVessel self-heals poisoned boat state', () => {
  const seed = {
    length: 24,
    beam: 7.2,
    eye: 4,
    heading: 90,
    x: 120,
    z: -85,
    provisionDays: 30,
    cargoTonnes: 0,
    sailFore: 1,
    sailMain: 1,
    sailMizzen: 1,
  };
  const boat = copyVessel(seed, { distance: 0, side: 0 });
  const probe = createVesselProbeState();

  const goodHeights = new Float32Array(16);
  goodHeights.fill(0.5, 0, 10);
  goodHeights[10] = 0.01;
  goodHeights[11] = -0.02;
  assert.equal(acceptVesselProbe(boat, probe, goodHeights, 1.0, boat.revision, boat.length, boat.beam), true);
  const savedTarget = { ...boat.target };
  const savedHeave = boat.heave;

  for (const badVal of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 25000]) {
    const bad = new Float32Array(goodHeights);
    bad[4] = badVal;
    assert.equal(
      acceptVesselProbe(boat, probe, bad, 1.1, boat.revision, boat.length, boat.beam),
      false,
      `acceptVesselProbe must reject probe containing ${badVal}`,
    );
    assert.deepEqual(boat.target, savedTarget);
    assert.equal(boat.heave, savedHeave);
  }

  assert.equal(acceptVesselProbe(boat, probe, null, 1.2, boat.revision, boat.length, boat.beam), false);
  assert.equal(acceptVesselProbe(boat, probe, new Float32Array(6), 1.2, boat.revision, boat.length, boat.beam), false);

  // Poison boat state and verify stepVessel self-heals to finite state
  boat.heave = Number.NaN;
  boat.pitch = Number.POSITIVE_INFINITY;
  boat.roll = Number.NaN;
  boat.x = Number.NaN;
  boat.z = Number.NEGATIVE_INFINITY;
  boat.heading = Number.NaN;
  boat.target.heave = Number.NaN;
  stepVessel(boat, probe, 1 / 60, 1.2, 6, 45, 0);

  for (const key of ['x', 'z', 'heading', 'heave', 'pitch', 'roll']) {
    assert.equal(Number.isFinite(boat[key]), true, `boat.${key} must self-heal to a finite number`);
  }
  for (const key of ['heave', 'pitch', 'roll']) {
    assert.equal(Number.isFinite(boat.target[key]), true, `boat.target.${key} must self-heal to a finite number`);
  }

  const tradeVesselsSrc = readRepoFile('js/trade-vessels.js');
  assert.match(tradeVesselsSrc, /safeWakeSample/);
  assert.match(tradeVesselsSrc, /fn tvFiniteVec4/);
  assert.match(tradeVesselsSrc, /dot\(in\.normalLocal\.xz,\s*in\.normalLocal\.xz\)/);
  assert.match(tradeVesselsSrc, /sparHoriz2\s*>\s*1e-8/);
});

test('6. requestWebGPUAdapter rejects under-limit (< 8 storage buffers) adapters and requestWebGPUDevice clamps & falls back cleanly', async () => {
  const compatTooSmall = {
    features: new Set(),
    limits: {
      maxStorageBuffersPerShaderStage: 4,
      maxStorageBuffersInVertexStage: 4,
    },
  };
  const fallbackValid = {
    features: new Set(),
    limits: {
      maxStorageBuffersPerShaderStage: 8,
      maxStorageBuffersInVertexStage: 8,
    },
  };
  const gpu = {
    async requestAdapter(options) {
      if (options?.featureLevel === 'compatibility') return compatTooSmall;
      if (options?.forceFallbackAdapter === true) return fallbackValid;
      return null;
    },
  };
  const picked = await requestWebGPUAdapter(gpu, { retries: 0 });
  assert.equal(picked.adapter, fallbackValid, 'must skip compatibility adapter with < 8 storage buffers per stage');

  // Verify requiredLimits clamping against adapter.limits
  const seenDescriptors = [];
  const hiLimAdapter = {
    features: new Set(['timestamp-query', 'texture-compression-bc']),
    limits: {
      maxStorageBuffersPerShaderStage: 16,
      maxStorageBuffersInVertexStage: 8,
      maxBufferSize: 1024 * 1024 * 1024,
      maxStorageBufferBindingSize: 512 * 1024 * 1024,
    },
    async requestDevice(desc) {
      seenDescriptors.push(desc);
      return { ok: true, desc };
    },
  };
  const dev1 = await requestWebGPUDevice(hiLimAdapter, ['timestamp-query', 'texture-compression-bc']);
  assert.equal(dev1.ok, true);
  assert.deepEqual(seenDescriptors[0].requiredLimits, {
    maxStorageBuffersPerShaderStage: 8,
    maxStorageBuffersInVertexStage: 8,
    maxBufferSize: 1024 * 1024 * 1024,
    maxStorageBufferBindingSize: 512 * 1024 * 1024,
  });

  // A device that refuses the adapter's own sizes is asked again at the former caps, then at its defaults.
  const cappedCalls = [];
  const cappingAdapter = {
    features: new Set(),
    limits: { maxStorageBuffersPerShaderStage: 8, maxBufferSize: 4 * 1024 * 1024 * 1024, maxStorageBufferBindingSize: 4 * 1024 * 1024 * 1024 },
    async requestDevice(desc) {
      cappedCalls.push(desc);
      if (desc?.requiredLimits?.maxBufferSize > 512 * 1024 * 1024) throw new TypeError('Limit rejected by driver');
      return { capped: desc?.requiredLimits };
    },
  };
  const dev3 = await requestWebGPUDevice(cappingAdapter);
  assert.deepEqual(dev3.capped, { maxStorageBuffersPerShaderStage: 8, maxBufferSize: 512 * 1024 * 1024, maxStorageBufferBindingSize: 256 * 1024 * 1024 });

  // Verify fallback retry without requiredLimits when requestDevice rejects limits
  const retryCalls = [];
  const pickyAdapter = {
    features: new Set(['texture-compression-bc']),
    limits: {
      maxStorageBuffersPerShaderStage: 8,
      maxBufferSize: 512 * 1024 * 1024,
      maxStorageBufferBindingSize: 256 * 1024 * 1024,
    },
    async requestDevice(desc) {
      retryCalls.push(desc);
      if (desc?.requiredLimits) {
        throw new TypeError('Limit rejected by driver');
      }
      return { recovered: true };
    },
  };
  const dev2 = await requestWebGPUDevice(pickyAdapter, ['texture-compression-bc']);
  assert.equal(dev2.recovered, true);
  assert.ok(retryCalls.length >= 2);
  assert.equal('requiredLimits' in retryCalls[retryCalls.length - 1], false);
});

test('7. #err HUD banner, post-startup device.lost recovery, swapchain/init-flag ordering, boulder async pipelines, and forest-wind TDR/NaN guards', () => {
  const html = readRepoFile('index.html');
  const errLine = html.split('\n').find((line) => /#err\s*\{/.test(line));
  assert.ok(errLine, '#err style rule must exist in index.html');
  assert.equal(/inset\s*:\s*0/.test(errLine), false, '#err must not use full-screen inset:0');
  assert.equal(/background\s*:\s*#000\b/.test(errLine), false, '#err must not paint an opaque #000 full-screen wall');
  assert.match(errLine, /max-width\s*:\s*680px/);

  const mainSrc = readRepoFile('js/main.js');
  assert.match(mainSrc, /let gpuDeviceLost = false,\s*firstFrameRendered = false/);
  assert.match(mainSrc, /if \(info\?\.reason === 'destroyed'\) return;/);
  assert.match(mainSrc, /Restore Now/);
  assert.match(mainSrc, /waterworld\.deviceLostReloadAt/);
  assert.match(mainSrc, /if \(gpuDeviceLost\) return;/);

  // Verify ctx.getCurrentTexture() is wrapped in try/catch BEFORE clearing one-shot flags
  const swapTryIdx = mainSrc.indexOf('swapTex = ctx.getCurrentTexture()');
  const clearFlagsIdx = mainSrc.indexOf('if (ranSpectrum) needSpectrum = false;');
  const submitIdx = mainSrc.indexOf('device.queue.submit(submitList);');
  assert.ok(swapTryIdx > 0 && clearFlagsIdx > swapTryIdx && submitIdx > swapTryIdx, 'one-shot flags must clear only after getCurrentTexture() succeeds');

  // Verify probe readback finite + < 1e4 check and writeFrame exposure/camera guard
  assert.match(mainSrc, /!heights\.every\(\(val\) => Number\.isFinite\(val\) && Math\.abs\(val\) < 1e4\)/);
  assert.match(mainSrc, /Number\.isFinite\(exposure\) && exposure > 0 \? exposure : 1\.0/);

  // Verify boulder-continuum uses async pipeline compilation (with sync fallback only when *Async is absent on mock test devices)
  const boulderSrc = readRepoFile('js/boulder-continuum.js');
  assert.match(boulderSrc, /export async function createBoulderContinuum/);
  assert.match(boulderSrc, /typeof device\.createComputePipelineAsync === 'function'/);
  assert.match(boulderSrc, /typeof device\.createRenderPipelineAsync === 'function'/);
  assert.equal((boulderSrc.match(/device\.createComputePipeline\s*\(/g) ?? []).length, 1, 'sync compute pipeline used only inside makeComputeAsync fallback');
  assert.equal((boulderSrc.match(/device\.createRenderPipeline\s*\(/g) ?? []).length, 1, 'sync render pipeline used only inside makeRenderAsync fallback');
  assert.match(boulderSrc, /device\.createComputePipelineAsync\s*\(/);
  assert.match(boulderSrc, /device\.createRenderPipelineAsync\s*\(/);

  // Verify forest-wind uses 12-slot odd-stride hash probing and guards simState/theta/omegaVel
  const forestWindSrc = readRepoFile('js/forest-wind.js');
  assert.match(forestWindSrc, /2654435761u/);
  assert.match(forestWindSrc, /\b[sp]<12u/);
  assert.equal(/s<256u/.test(forestWindSrc.slice(forestWindSrc.indexOf('fn forestWindPromoteRoots'))), false);
  assert.match(forestWindSrc, /dot\(theta,theta\)<1e4/);
  assert.match(forestWindSrc, /dot\(omegaVel,omegaVel\)<1e6/);
});

test('8. Build & GPU contract: zero aliased ES imports in js/*.js and P2 D3D12 fast-math guards present', () => {
  const checkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        checkDir(full);
      } else if (entry.name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8');
        const aliasMatch = /^\s*import\s*\{[^}]*\bas\b[^}]*\}\s*from\b/m.exec(src);
        assert.equal(aliasMatch, null, `build.mjs forbids aliased import in ${path.relative(ROOT, full)}`);
      }
    }
  };
  checkDir(path.join(ROOT, 'js'));

  assert.match(readRepoFile('js/meadow-grass.js'), /pow\(clamp\(1\.0 - max\(dot\(n, v\), 0\.0\), 0\.0, 1\.0\), 2\.3\)/);
  assert.match(readRepoFile('js/wgsl/inland-water.js'), /select\(0\.0, atan2\(d\.y, d\.x\), dot\(d, d\) > 1e-8\)/);
  // Continuum splats (animals among them) face the eye by its direction, with no azimuth to take at a degenerate vector.
  assert.doesNotMatch(readRepoFile('js/wgsl/continuum-kinds.js'), /\batan2\(/);
  assert.match(readRepoFile('js/wgsl/ground-detail.js'), /select\(0\.0,atan2\(turned\.y,turned\.x\),dot\(turned,turned\)>1e-8\)/);
  assert.match(readRepoFile('js/wgsl/land-craters.js'), /select\(0\.0,atan2\(q\.y,q\.x\),dot\(q,q\)>1e-8\)/);
  assert.match(readRepoFile('js/wgsl/caravel.js'), /select\(0\.0, atan2\(paneUV\.y, paneUV\.x\), dot\(paneUV, paneUV\) > 1e-8\)/);
});
