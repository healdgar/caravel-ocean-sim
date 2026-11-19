// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Verifies GPU anatomical diversity, child allometry, eye-socket safety, and proportion smoothing (js/wgsl/human-morph.js).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

let server, browser, origin;
before(async () => {
  server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: process.env.WEBGPU_BACKEND === 'metal'
      ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog']
      : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'],
  });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); if (server) await new Promise((r) => server.close(r)); });

test('GPU human morph produces bounded diversity, child allometry, zero animal drift, and eye-socket safety', { timeout: 60000 }, async () => {
  const page = await browser.newPage();
  await page.route('**/__human-morph', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto(`${origin}/__human-morph`);
  try {
    const res = await page.evaluate(async () => {
      const { HUMAN_MORPH_WGSL } = await import('/js/wgsl/human-morph.js');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const N = 256;
      const wgsl = HUMAN_MORPH_WGSL + /* wgsl */`
struct Out {
  stage: vec4f,
  riderStage: vec4f,
  animalDelta: vec4f,
  footDelta: vec4f,
  eyeDelta: vec4f,
  headGrow: vec4f,
  jawDelta: vec4f,
};
@group(0) @binding(0) var<storage, read_write> out: array<Out>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= ${N}u) { return; }
  let female = (id & 1u) != 0u;
  let st = humanLifeStage(id, true, false);
  let rst = humanLifeStage(id, true, true);
  let sz = humanMorphPackZ(id, female);
  let sw = humanMorphPackW(st.y, st.z, false);

  let eyeY = select(1.662, 1.591, female);
  let eyeZ = select(0.075, 0.084, female);
  let pAnimal = vec3f(0.12, 1.25, 0.08);
  let pFoot = vec3f(0.06, 0.02, 0.04);
  let pEye = vec3f(0.034, eyeY, eyeZ);
  let pCrown = vec3f(0.0, select(1.75, 1.67, female), 0.0);
  let pJaw = vec3f(0.045, eyeY - 0.095, eyeZ - 0.036);

  out[id] = Out(
    st,
    rst,
    vec4f(humanMorphPoint(pAnimal, 0u, 0u) - pAnimal, 0.0),
    vec4f(humanMorphPoint(pFoot, sz, sw) - pFoot, 0.0),
    vec4f(humanMorphPoint(pEye, sz, sw) - pEye, 0.0),
    vec4f(humanMorphPoint(pCrown, sz, sw) - pCrown, 0.0),
    vec4f(humanMorphPoint(pJaw, sz, sw) - pJaw, 0.0)
  );
}
`;
      const mod = device.createShaderModule({ code: wgsl });
      const info = await mod.getCompilationInfo();
      const errs = info.messages.filter((m) => m.type === 'error').map((m) => m.message);
      if (errs.length) return { errs };

      const strideFloats = 28;
      const bytes = N * strideFloats * 4;
      const buf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
      const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(N / 64); pass.end();
      enc.copyBufferToBuffer(buf, 0, read, 0, bytes);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();

      let children = 0, elders = 0, riderChildren = 0;
      let maxAnimal = 0, maxFoot = 0, maxEyeLocal = 0, minChildCrown = Infinity, maxJaw = 0;
      let jawMin = Infinity, jawMax = -Infinity;
      for (let i = 0; i < N; i++) {
        const o = i * strideFloats;
        const scale = data[o], childness = data[o + 1], elderness = data[o + 2];
        const rChild = data[o + 5];
        if (childness > 0.35) { children++; minChildCrown = Math.min(minChildCrown, data[o + 21]); }
        if (elderness > 0.25) elders++;
        if (rChild > 0.01) riderChildren++;
        maxAnimal = Math.max(maxAnimal, Math.hypot(data[o + 8], data[o + 9], data[o + 10]));
        maxFoot = Math.max(maxFoot, Math.hypot(data[o + 12], data[o + 13], data[o + 14]));
        const jawX = data[o + 24];
        if (childness === 0) { jawMin = Math.min(jawMin, jawX); jawMax = Math.max(jawMax, jawX); }
        maxJaw = Math.max(maxJaw, Math.abs(jawX));
        if (childness === 0 && elderness === 0) {
          maxEyeLocal = Math.max(maxEyeLocal, Math.hypot(data[o + 16], data[o + 17], data[o + 18]));
        }
      }
      return { errs, children, elders, riderChildren, maxAnimal, maxFoot, maxEyeLocal, minChildCrown, maxJaw, jawSpan: jawMax - jawMin };
    });

    assert.deepEqual(res.errs, []);
    assert.ok(res.children >= 25 && res.children <= 75, `expected ~18% children in 256 townsfolk, got ${res.children}`);
    assert.ok(res.elders >= 15 && res.elders <= 65, `expected ~15% elders in 256 townsfolk, got ${res.elders}`);
    assert.equal(res.riderChildren, 0, 'never spawn young children solo on horseback');
    assert.equal(res.maxAnimal, 0, 'animals/horses (spareZ == 0) stay 100% unmorphed');
    assert.equal(res.maxFoot, 0, 'feet stay 100% locked to ground');
    assert.ok(res.minChildCrown > 0.012, `children get proportionally larger cranium (got min +${res.minChildCrown.toFixed(4)}m)`);
    assert.ok(res.maxJaw < 0.025, `jaw width variation stays bounded (max ${res.maxJaw.toFixed(4)}m)`);
    assert.ok(res.jawSpan > 0.004, `adults exhibit genuine facial diversity (jaw span ${res.jawSpan.toFixed(4)}m)`);
    assert.ok(res.maxEyeLocal < 0.005, `adult eye centers stay tightly protected (max ${res.maxEyeLocal.toFixed(4)}m)`);
  } finally {
    await page.close();
  }
});
