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

// The game's own shader preparation, as js/main.js gives every program.
async function programs(device) {
  const { withCelestialFrame } = await import('/js/wgsl/celestial.js');
  const { withSceneShadowCount } = await import('/js/wgsl/shadows.js');
  const { pruneWGSLFunctions } = await import('/js/wgsl-prune.js');
  const { createGPUProgramCache } = await import('/js/gpu-program-cache.js');
  const compiled = [];
  const { shader } = createGPUProgramCache({ device, prepare: (code) => pruneWGSLFunctions(withCelestialFrame(withSceneShadowCount(code, 1))), report: (messages, code, label) => {
    for (const m of messages) if (m.type === 'error') compiled.push(`${label}:${m.lineNum}:${m.linePos} ${m.message} | ${code.split('\n')[m.lineNum - 1]?.trim()}`);
  } });
  return { shader, compiled };
}

test('the one cut, the crew\'s view of it, its capture under water, its stands and its pose all compile and link', { timeout: 180000 }, async () => {
  const page = await blank();
  try {
    const result = await page.evaluate(async (source) => {
      const { requestCrewContinuumPipelines, requestCrewContinuumPose } = await import('/js/crew-continuum-draw.js');
      const { continuumModuleWGSL, CONTINUUM_ENTRY_LAYOUT } = await import('/js/wgsl/continuum-cut.js');
      const { CREW_CONTINUUM_MATERIAL } = await import('/js/wgsl/crew-continuum.js');
      const { WATER_CAPTURE_DIRECTIVE, waterCaptureWGSL } = await import('/js/water-optics.js');
      const adapter = await navigator.gpu.requestAdapter(), errors = [];
      const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage, maxSampledTexturesPerShaderStage: adapter.limits.maxSampledTexturesPerShaderStage } });
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const { shader, compiled } = await (0, eval)(`(${source})`)(device);
      const P = await requestCrewContinuumPipelines({ device, shader });
      const pose = await requestCrewContinuumPose({ device, shader });
      // Under water the crew's view is cut by the water's capture, drawing the coarse cut.
      const module = await shader(continuumModuleWGSL({ pass: 'capture', material: CREW_CONTINUUM_MATERIAL, capture: { directive: WATER_CAPTURE_DIRECTIVE, tail: (o) => waterCaptureWGSL({ ...o, surfaceWaves: false, land: false }) } }), 'crewContinuum capture');
      const capture = await device.createRenderPipelineAsync({
        layout: 'auto', vertex: { module, entryPoint: 'continuumCaptureVS', buffers: CONTINUUM_ENTRY_LAYOUT }, fragment: { module, entryPoint: 'submergedFS', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' }, multisample: { count: 1 },
      });
      // The view takes the crew's group 0, the shadow set's group 1 and the cut's data group 2.
      const groups = [0, 1, 2].map((g) => { try { return P.view.pipeline.getBindGroupLayout(g) ? 1 : 0; } catch { return -1; } });
      const view = continuumModuleWGSL({ pass: 'view', material: CREW_CONTINUUM_MATERIAL }).replace(/\/\/.*$/gm, '');
      await device.queue.onSubmittedWorkDone();
      return { errors, compiled, groups, made: [P.programs.select, P.programs.shadow, P.view.pipeline, P.stand.afloat, P.stand.ashore, pose, capture].every(Boolean), discards: /\bdiscard\b/.test(view) };
    }, programs.toString());
    assert.deepEqual(result.compiled, []);
    assert.deepEqual(result.errors, []);
    assert.ok(result.made);
    assert.deepEqual(result.groups, [1, 1, 1]);
    assert.equal(result.discards, false, 'no main pass people are drawn by discards');
  } finally { await page.close(); }
});

// People in a row before the camera, 2 m to 2.5 km, at rest in their bind pose; the one cut is read back.
test('each person is cut by distance: clusters near, the far body past the handoff, a splat at the horizon', { timeout: 300000 }, async () => {
  const page = await blank();
  try {
    const result = await page.evaluate(async (source) => {
      const { loadCrewContinuumBody, requestCrewContinuumPipelines, createCrewContinuumBatch } = await import('/js/crew-continuum-draw.js');
      const { CREW_JOINT_COUNT } = await import('/js/crew-skeleton.js');
      const adapter = await navigator.gpu.requestAdapter();
      const features = ['texture-compression-bc', 'texture-compression-astc'].filter((f) => adapter.features.has(f));
      const device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits: { maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage, maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 256 << 20), maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 << 20) } }), errors = [];
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const B = GPUBufferUsage, buffer = (data, usage) => { const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST | B.COPY_SRC }); device.queue.writeBuffer(b, 0, data); return b; };
      const body = await loadCrewContinuumBody(device, 'sailor-male');
      const { shader } = await (0, eval)(`(${source})`)(device);
      const P = await requestCrewContinuumPipelines({ device, shader });
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
      // The one cut's draws open with every list's indirect record, four words each.
      const [{ buffer: drawsBuffer }] = batch.continuumDraws(), readDraws = device.createBuffer({ size: 96, usage: B.COPY_DST | B.MAP_READ });
      encoder.copyBufferToBuffer(drawsBuffer, 0, readDraws, 0, 96);
      device.queue.submit([encoder.finish()]);
      await readDraws.mapAsync(GPUMapMode.READ);
      const draws = Array.from(new Uint32Array(readDraws.getMappedRange().slice(0)));
      return { draws, errors, handoff: body.manifest.chain.farFirst, steps: body.manifest.chain.steps };
    }, programs.toString());
    assert.deepEqual(result.errors, []);
    // clusters, small clusters, far body, splat; then the shadow's far body and clusters.
    const instances = [0, 1, 2, 3, 4, 5].map((i) => result.draws[i * 4 + 1]);
    console.log('instances by list', instances, 'handoff', result.handoff, 'of', result.steps);
    assert.ok(instances[0] + instances[1] > 100, `clusters ${instances[0]} and ${instances[1]} small`);
    assert.ok(instances[2] > 0, `far bodies ${instances[2]}`);
    assert.ok(instances[3] >= 1, `splats ${instances[3]}`);
    assert.ok(instances[4] + instances[5] >= 11, `shadow pieces ${instances[4]} and ${instances[5]}`);
  } finally { await page.close(); }
});

// People a GPU pass places (the townsfolk) are posed by one shared pass, from the record the placing pass wrote.
test('a placed person is posed from the clips, wounded and worn, with who they are in their orders', { timeout: 180000 }, async () => {
  const page = await blank();
  try {
    const result = await page.evaluate(async () => {
      const { crewContinuumPoseWGSL, CREW_CONTINUUM_PLACED_WORDS: P, CREW_CONTINUUM_LOOK_WORDS: L } = await import('/js/wgsl/crew-continuum.js');
      const { createCrewContinuumPoser } = await import('/js/crew-continuum-draw.js');
      const { CREW_JOINT_COUNT: N, CREW_SLOT } = await import('/js/crew-skeleton.js');
      const device = await (await navigator.gpu.requestAdapter()).requestDevice(), errors = [], B = GPUBufferUsage;
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const module = device.createShaderModule({ code: crewContinuumPoseWGSL() });
      const bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
      if (bad.length) throw Error(bad.map((m) => m.message).join('\n'));
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'crewContinuumPose' } });
      const made = (data, usage = B.STORAGE) => { const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST | B.COPY_SRC }); device.queue.writeBuffer(b, 0, data); return b; };
      // Two frames: at rest, and everything 0.2 m along x. The rest places put the left elbow somewhere to be found.
      const palettes = new Float32Array(2 * N * 16);
      for (let f = 0; f < 2; f++) for (let j = 0; j < N; j++) palettes.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, f * 0.2, 0, 0, 1], (f * N + j) * 16);
      const rest = new Float32Array(N * 4), elbow = CREW_SLOT.lowerarm_l;
      rest.set([0.3, 1.2, 0, 1], elbow * 4);
      const looks = new Float32Array(2 * L);
      looks.set([0.5, 0.4, 0.3, 0, 0.1, 0.1, 0.1, 0, 0.8, 0.6, 0.5, 1, 0.1, 0.05, 0.02, 0.25, 1, 1, 0, 1], L);
      // Slot 3: person 0 of a run that begins there, halfway between the frames, struck (forearm off, wound 15, seed 2).
      const placed = new ArrayBuffer(4 * P * 4), u = new Uint32Array(placed), f = new Float32Array(placed), at = 3 * P;
      f.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 5, 1], at);
      u.set([0, 1, 0, 1], at + 16);
      f.set([0.5, 0, 0, 0], at + 20);
      u.set([42, 1 | (15 << 3) | (2 << 11), 2, 4], at + 24);
      const joints = device.createBuffer({ size: 4 * N * 64, usage: B.STORAGE | B.COPY_SRC }), actors = device.createBuffer({ size: 4 * 144, usage: B.STORAGE | B.COPY_SRC });
      const orders = device.createBuffer({ size: 16, usage: B.STORAGE | B.COPY_SRC }), counted = made(new Uint32Array([1, 1, 1, 0]), B.INDIRECT);
      const poser = createCrewContinuumPoser({ device, pipeline, placed: made(new Uint8Array(placed)), palettes: made(palettes), looks: made(looks), rest: made(rest), joints, actors, orders, first: 3, counted: { buffer: counted, offset: 0 } });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      poser.encode(pass); pass.end();
      const read = (b, from, bytes) => { const r = device.createBuffer({ size: bytes, usage: B.COPY_DST | B.MAP_READ }); encoder.copyBufferToBuffer(b, from, r, 0, bytes); return r; };
      const reads = [read(joints, 3 * N * 64, N * 64), read(actors, 3 * 144, 144), read(orders, 0, 16)];
      device.queue.submit([encoder.finish()]);
      const [j, a, o] = await Promise.all(reads.map(async (r) => { await r.mapAsync(GPUMapMode.READ); return r.getMappedRange().slice(0); }));
      const jf = new Float32Array(j);
      return { errors, pelvis: [...jf.subarray(CREW_SLOT.pelvis * 16, CREW_SLOT.pelvis * 16 + 16)], elbow: [...jf.subarray(elbow * 16, elbow * 16 + 16)],
        hand: [...jf.subarray(CREW_SLOT.hand_l * 16, CREW_SLOT.hand_l * 16 + 16)], actor: [...new Float32Array(a)], orders: new Uint32Array(o)[0] };
    });
    const near = (a, b, why) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-4, `${why}: ${a} against ${b}`));
    assert.deepEqual(result.errors, []);
    near(result.pelvis, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0, 0, 1], 'halfway between the frames');
    // The forearm and all below it drawn in to where it parted: the elbow as posed, scaled to nothing about it.
    const stump = [0.3 + 0.1 - 0.001 * 0.3, 1.2 - 0.001 * 1.2, 0];
    for (const joint of [result.elbow, result.hand]) near(joint, [0.001, 0, 0, 0, 0, 0.001, 0, 0, 0, 0, 0.001, 0, ...stump, 1], 'severed at the elbow');
    near(result.actor.slice(0, 16), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 5, 1], 'where the record put them');
    near(result.actor.slice(16, 20), [0.5 * 0.55 + 0.2, 0.4 * 0.32, 0.3 * 0.32, 0.45], 'a shirt soaked through, and the wound in its w');
    near([result.actor[27], result.actor[31]], [1 + 0.06 + (2 / 7) * 0.32, 4.25], 'a woman with her bandage seed, in moisture slot 4 and her dress');
    assert.equal(result.orders, 2 | (43 << 2), 'cut finer, and known by who they are');
  } finally { await page.close(); }
});
