// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The people continuum on the GPU (js/wgsl/crew-continuum.js, js/crew-continuum-draw.js).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

let server, browser, origin;
before(async () => {
  server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); if (server) await new Promise((r) => server.close(r)); });

async function blank() {
  const page = await browser.newPage();
  await page.route('**/__crew-continuum', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto(`${origin}/__crew-continuum`);
  return page;
}

test('the cut, every draw and the shadow compile and link against the crew\'s own bindings', { timeout: 180000 }, async () => {
  const page = await blank();
  try {
    const result = await page.evaluate(async () => {
      const { crewContinuumSelectWGSL, crewContinuumRenderWGSL, crewContinuumShadowWGSL, CREW_CONTINUUM_ENTRY_LAYOUT } = await import('/js/wgsl/crew-continuum.js');
      const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersInVertexStage: Math.min(8, adapter.limits.maxStorageBuffersInVertexStage ?? 8) } }), errors = [];
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const compile = async (code, label) => {
        const module = device.createShaderModule({ label, code }), info = await module.getCompilationInfo();
        const bad = info.messages.filter((m) => m.type === 'error');
        if (bad.length) throw Error(`${label}: ${bad.map((m) => `${m.lineNum}:${m.linePos} ${m.message} | ${code.split('\n')[m.lineNum - 1]?.trim()}`).join('\n')}`);
        return module;
      };
      const select = await compile(crewContinuumSelectWGSL(), 'select'), render = await compile(crewContinuumRenderWGSL(), 'render'), shadow = await compile(crewContinuumShadowWGSL(), 'shadow');
      const made = [];
      made.push(await device.createComputePipelineAsync({ layout: 'auto', compute: { module: select, entryPoint: 'crewContinuumSelect' } }));
      const draw = (vs, fs, depth, writeMask = 0xf) => device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: render, entryPoint: vs, buffers: CREW_CONTINUUM_ENTRY_LAYOUT },
        fragment: { module: render, entryPoint: fs, targets: [{ format: 'rgba16float', writeMask }] }, primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', ...depth }, multisample: { count: 4 } });
      const laying = { depthWriteEnabled: true, depthCompare: 'greater' }, equal = { depthWriteEnabled: false, depthCompare: 'equal' };
      for (const [vs, fs, depth, mask] of [
        ['crewContinuumClusterVS', 'crewContinuumFS', laying], ['crewContinuumChainVS', 'crewContinuumFarFS', laying], ['crewContinuumSplatVS', 'crewContinuumFarFS', laying],
        ['crewContinuumClusterVS', 'crewContinuumSurviving', laying, 0], ['crewContinuumChainVS', 'crewContinuumSurviving', laying, 0],
        ['crewContinuumClusterVS', 'crewContinuumFS', equal], ['crewContinuumChainVS', 'crewContinuumFarFS', equal],
      ]) made.push(await draw(vs, fs, depth, mask));
      made.push(await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: shadow, entryPoint: 'crewContinuumShadowVS', buffers: CREW_CONTINUUM_ENTRY_LAYOUT }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' } }));
      // Every render pipeline takes the crew's whole group 0 and the continuum's whole group 2.
      const counts = made.slice(1).map((p) => [0, 2].map((g) => { try { return p.getBindGroupLayout(g) ? 1 : 0; } catch { return -1; } }));
      await device.queue.onSubmittedWorkDone();
      return { pipelines: made.length, counts, errors };
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.pipelines, 9);
  } finally { await page.close(); }
});

// People in a row before the camera, 2 m to 2.5 km, at rest in their bind pose; the cut is read back.
test('each person is cut by distance: clusters near, the far body past the handoff, a splat at the horizon', { timeout: 300000 }, async () => {
  const page = await blank();
  try {
    const result = await page.evaluate(async () => {
      const { loadCrewContinuumBody, requestCrewContinuumPipelines, createCrewContinuumBatch } = await import('/js/crew-continuum-draw.js');
      const { CREW_JOINT_COUNT } = await import('/js/crew-skeleton.js');
      const adapter = await navigator.gpu.requestAdapter();
      const features = ['texture-compression-bc', 'texture-compression-astc'].filter((f) => adapter.features.has(f));
      const device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits: { maxStorageBuffersInVertexStage: Math.min(8, adapter.limits.maxStorageBuffersInVertexStage ?? 8), maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 256 << 20), maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 << 20) } }), errors = [];
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const B = GPUBufferUsage, buffer = (data, usage) => { const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST | B.COPY_SRC }); device.queue.writeBuffer(b, 0, data); return b; };
      const body = await loadCrewContinuumBody(device, 'sailor-male');
      await body.loaded;
      const P = await requestCrewContinuumPipelines({ device, shader: async (code, label) => device.createShaderModule({ code, label }) });
      const distances = [2, 5, 12, 20, 24, 40, 80, 160, 320, 640, 2560], N = distances.length;
      const tanY = Math.tan(Math.PI / 6), W = 1920, H = 1080, f = 1 / tanY, near = 0.1;
      const frame = new Float32Array(132);
      frame.set([f * H / W, 0, 0, 0, 0, f, 0, 0, 0, 0, 0, -1, 0, 0, near, 0], 0);
      frame.set([0, 1.6, 0, 0], 16); frame.set([tanY * W / H, 0, 0, 0], 20); frame.set([0, tanY, 0, 0], 24); frame.set([0, 0, -1, 0], 28); frame.set([0, 1, 0, 1], 32); frame.set([W, H, 1 / W, 1 / H], 36);
      const hull = new Float32Array(52); hull.set([1, 0, 0, 1, 0, 1, 0, 0, 0, 0, -1, 0], 0);
      const joints = new Float32Array(N * CREW_JOINT_COUNT * 16);
      for (let j = 0; j < N * CREW_JOINT_COUNT; j++) joints.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], j * 16);
      const actors = new Float32Array(N * 36);
      distances.forEach((d, i) => actors.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -d, 1], i * 36));
      const shadowFrame = new Float32Array(28); shadowFrame[24] = 0.05; shadowFrame[25] = 0.05;
      const frameUBO = buffer(frame, B.UNIFORM), hullUBO = buffer(hull, B.UNIFORM), bones = buffer(joints, B.STORAGE), actor = buffer(actors, B.STORAGE);
      const batch = createCrewContinuumBatch({ device, pipelines: P, body, capacity: N, frame: frameUBO, hull: hullUBO, bones, actor, main: [], shadows: { uniform: buffer(shadowFrame, B.UNIFORM), bind: () => null } });
      batch.update(distances.map(() => ({})));
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      batch.encodeSelect(pass); pass.end();
      const readStates = device.createBuffer({ size: N * 16, usage: B.COPY_DST | B.MAP_READ }), readDraws = device.createBuffer({ size: 96, usage: B.COPY_DST | B.MAP_READ });
      encoder.copyBufferToBuffer(batch.draws, 0, readDraws, 0, 96);
      encoder.copyBufferToBuffer(batch.list, 0, readStates, 0, N * 16);
      device.queue.submit([encoder.finish()]);
      await Promise.all([readDraws.mapAsync(GPUMapMode.READ), readStates.mapAsync(GPUMapMode.READ)]);
      const draws = Array.from(new Uint32Array(readDraws.getMappedRange().slice(0))), words = new Uint32Array(readStates.getMappedRange().slice(0)), floats = new Float32Array(words.buffer);
      const people = distances.map((d, i) => ({ d, handoff: (words[i * 4] >>> 8) & 255, splat: (words[i * 4] >>> 16) & 255, step: words[i * 4 + 1] & 65535, shadowStep: words[i * 4 + 1] >>> 16, morph: floats[i * 4 + 2], thin: floats[i * 4 + 3] }));
      return { draws, people, errors, base: body.manifest.chain.errorRange[0], steps: body.manifest.chain.stepCount };
    });
    assert.deepEqual(result.errors, []);
    const instances = [0, 1, 2, 3, 4, 5].map((i) => result.draws[i * 4 + 1]);
    console.log('instances by list', instances, 'base error', result.base);
    for (const p of result.people) console.log(`  ${String(p.d).padStart(5)} m  handoff ${p.handoff}  splat ${p.splat}  step ${p.step}/${result.steps} morph ${p.morph.toFixed(2)}  shadow step ${p.shadowStep}  thin ${p.thin.toFixed(2)}`);
    // The far body takes over where its own error is all 3 px allow (focal 935 px): base error x 935 / 3, over 30% more.
    const start = result.base * (1080 / (2 * Math.tan(Math.PI / 6))) / 3;
    for (const p of result.people) {
      if (p.d < start) assert.equal(p.handoff, 0, `${p.d} m is inside the handoff`);
      if (p.d > start * 1.3) assert.equal(p.handoff, 255, `${p.d} m is past the handoff`);
      if (p.d > 500) assert.equal(p.splat, 255, `${p.d} m is a splat`);
      if (p.d < 300) assert.equal(p.splat, 0, `${p.d} m is no splat`);
    }
    const far = result.people.filter((p) => p.handoff === 255 && p.splat < 255);
    for (let i = 1; i < far.length; i++) assert.ok(far[i].step >= far[i - 1].step, 'the far body coarsens with distance');
    assert.ok(far.at(-1).step > far[0].step, 'and does coarsen');
    assert.ok(instances[0] > 100, `clusters ${instances[0]}`);
    assert.ok(instances[1] > 0, `far body pieces ${instances[1]}`);
    assert.ok(instances[2] >= 1, `splats ${instances[2]}`);
    assert.equal(instances[3] + instances[4], 0, 'nobody was ordered cut');
    assert.ok(instances[5] >= 11, `shadow pieces ${instances[5]}`);
  } finally { await page.close(); }
});
