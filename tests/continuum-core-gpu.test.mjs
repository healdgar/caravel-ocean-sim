// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one continuum's shared core, run on the GPU and held to plain references: the forest's own sample split at seed
// 0, splat thinning that keeps area, the cluster cut's drawn test and prefix, and the morph step search.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

const hash = (value) => {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
};
// forestCrownSamples as js/forest-scenery.js has it, before the core.
const forestSamples = (share, px, py, samples) => {
  if (share <= 0) return 0;
  const random = hash(px ^ hash((Math.imul(py, 0x9e3779b9) + 0x51ed270b) >>> 0));
  const count = Math.min(samples, Math.floor(Math.fround(Math.fround(share * samples) + Math.fround((random & 65535) / 65536))));
  const bits = count >= 32 ? 0xffffffff : (1 << count) - 1;
  const rotation = (random >>> 16) % samples;
  return ((bits << rotation) | (bits >>> (samples - rotation))) & ((1 << samples) - 1);
};

test('the continuum core on the GPU matches its references', { timeout: 120000 }, async () => {
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const args = process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'];
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args });
    const page = await browser.newPage();
    await page.route('**/__continuum-core', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__continuum-core`);
    const result = await page.evaluate(async () => {
      const { CONTINUUM_CORE_WGSL, continuumClusterPrefixWGSL, continuumMorphStepWGSL } = await import('/js/continuum-core.js');
      const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice(), errors = [];
      device.onuncapturederror = (e) => errors.push(e.error.message);
      const code = CONTINUUM_CORE_WGSL + /* wgsl */`
@group(0) @binding(0) var<storage, read> parentErrors: array<f32>;
@group(0) @binding(1) var<storage, read> stepErrors: array<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
${continuumClusterPrefixWGSL('testPrefix', (i) => `parentErrors[${i}]`)}
${continuumMorphStepWGSL('testMorph', (s) => `stepErrors[2u + (${s}) * 3u]`)}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i < 1024u) {
    // Samples: shares in 1/7 steps over a 32 x 4 patch of pixels, 4 and 8 samples, seed 0.
    let share = f32(i % 8u) / 7.0; let px = (i / 8u) % 32u; let py = i / 256u;
    out[i] = continuumSamples(share, vec2f(f32(px) + 0.5, f32(py) + 0.5), 4u, 0u) | (continuumSamples(share, vec2f(f32(px) + 0.5, f32(py) + 0.5), 8u, 0u) << 8u);
  }
  if (i < 256u) {
    let pixels = f32(i) / 128.0;
    out[1024u + i] = bitcast<u32>(continuumThin(pixels, i * 2654435761u));
  }
  if (i == 0u) {
    out[1280u] = testPrefix(1u, 6u, 0.25);
    out[1281u] = testPrefix(1u, 6u, 10.0);
    out[1282u] = testPrefix(1u, 6u, 0.0);
    let m0 = testMorph(4u, 0.30); out[1283u] = u32(m0.x); out[1284u] = bitcast<u32>(m0.y);
    let m1 = testMorph(4u, 99.0); out[1285u] = u32(m1.x);
    let m2 = testMorph(4u, 0.05); out[1286u] = u32(m2.x); out[1287u] = bitcast<u32>(m2.y);
    // A cluster 0.02 m of error at 10 m with a 1000 px focal spans 2 px; its parent 0.05 m spans 5 px.
    out[1288u] = u32(continuumClusterDrawn(0.02, vec3f(0.0, 0.0, 10.0), 0.0, 0.05, vec3f(0.0, 0.0, 10.0), 0.0, 1000.0, 3.0));
    out[1289u] = u32(continuumClusterDrawn(0.02, vec3f(0.0, 0.0, 10.0), 0.0, 0.05, vec3f(0.0, 0.0, 10.0), 0.0, 1000.0, 6.0));
    out[1290u] = u32(continuumClusterDrawn(0.02, vec3f(0.0, 0.0, 10.0), 0.0, 0.05, vec3f(0.0, 0.0, 10.0), 0.0, 1000.0, 1.0));
  }
}`;
      const module = device.createShaderModule({ code });
      const bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error').map((m) => m.message);
      if (bad.length) return { bad };
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const data = (values) => { const b = device.createBuffer({ size: Math.max(16, values.length * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, new Float32Array(values)); return b; };
      // Index 0 is not part of the run; the run's parent errors fall from coarse to fine.
      const parents = data([99, 2.0, 1.0, 0.5, 0.25, 0.1, 0.05]);
      // Step errors at base 2, stride 3: 0.1, 0.2, 0.4, 0.8, 1.6.
      const steps = data([0, 0, 0.1, 0, 0, 0.2, 0, 0, 0.4, 0, 0, 0.8, 0, 0, 1.6]);
      const out = device.createBuffer({ size: 1300 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const read = device.createBuffer({ size: 1300 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: parents } }, { binding: 1, resource: { buffer: steps } }, { binding: 2, resource: { buffer: out } }] }));
      pass.dispatchWorkgroups(16); pass.end();
      encoder.copyBufferToBuffer(out, 0, read, 0, 1300 * 4);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const u = Array.from(new Uint32Array(read.getMappedRange().slice(0))), f = Array.from(new Float32Array(new Uint32Array(u).buffer));
      return { u, f, errors };
    });
    assert.deepEqual(result.bad ?? [], []);
    assert.deepEqual(result.errors, []);
    const { u, f } = result;
    for (let i = 0; i < 1024; i++) {
      const share = Math.fround(Math.fround(i % 8) / 7), px = Math.floor(i / 8) % 32, py = Math.floor(i / 256);
      assert.equal(u[i] & 0xff, forestSamples(share, px, py, 4), `4 samples, share ${share} at ${px},${py}`);
      assert.equal(u[i] >>> 8, forestSamples(share, px, py, 8), `8 samples, share ${share} at ${px},${py}`);
    }
    // Thinning: whole above a pixel, gone below 0.16 px, and on average the kept area matches the area asked for.
    let kept = 0, wanted = 0;
    for (let i = 0; i < 256; i++) {
      const pixels = i / 128, scale = f[1024 + i];
      if (pixels >= 1) assert.equal(scale, 1);
      else if (pixels < 0.16) assert.equal(scale, 0);
      else { if (scale > 0) assert.ok(Math.abs(scale - 1 / pixels) < 1e-5); kept += scale > 0 ? (pixels * scale) ** 2 : 0; wanted += pixels ** 2; }
    }
    assert.ok(Math.abs(kept / wanted - 1) < 0.35, `thinning keeps area: ${kept.toFixed(2)} of ${wanted.toFixed(2)}`);
    assert.deepEqual([u[1280], u[1281], u[1282]], [3, 0, 6], 'prefix: parents coarser than finest');
    assert.equal(u[1283], 1); assert.ok(Math.abs(f[1284] - 0.5) < 1e-5, 'morph halfway from 0.2 to 0.4');
    assert.equal(u[1285], 4, 'past the last step');
    assert.equal(u[1286], 0); assert.equal(f[1287], 0, 'before the first step');
    assert.deepEqual([u[1288], u[1289], u[1290]], [1, 0, 0], 'drawn where it fits and its parent does not');
  } finally {
    await browser?.close();
    server.close();
  }
});
