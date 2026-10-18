import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const port = process.env.TEST_PORT || 8082;
const origin = `http://localhost:${port}`;
let server, browser;

before(async () => {
  server = spawn(process.execPath, ['server.mjs', port], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'inherit'] });
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(([code]) => { throw new Error(`Test server exited: ${code}`); }),
  ]);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'],
  });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

test('fused FFT reproduces analytical travelling waves in every cascade', { timeout: 120000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/__test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`${origin}/__test`);
    const result = await page.evaluate(async () => {
      const { N, CASCADES } = await import('/js/wgsl/common.js');
      const { FFT_ROWS, FFT_COLS } = await import('/js/wgsl/sim.js');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter; enable software WebGPU or use a supported Chromium.');
      const device = await adapter.requestDevice();
      const errors = [];
      device.onuncapturederror = e => errors.push(e.error.message);
      const pipes = await Promise.all([FFT_ROWS, FFT_COLS].map(code => device.createComputePipelineAsync({
        layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      })));
      const buffer = (size, usage) => device.createBuffer({ size, usage });
      const bytes = N * N * CASCADES * 16;
      const ubo = buffer(224, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const h0 = buffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const rows = [0, 1].map(() => buffer(bytes, GPUBufferUsage.STORAGE));
      const textures = [0, 1, 2].map(() => device.createTexture({
        size: [N, N, CASCADES], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      }));
      const bind = (pipe, resources) => device.createBindGroup({
        layout: pipe.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })),
      });
      const groups = [
        bind(pipes[0], [ubo, h0, ...rows].map(buffer => ({ buffer }))),
        bind(pipes[1], [...rows.map(buffer => ({ buffer })), ...textures.map(t => t.createView({ dimension: '2d-array' }))]),
      ];
      const sim = new Float32Array(56);
      sim.set([1103, 211.3, 39.7, 7.43, 1.393, 0.2617]);
      sim[50] = 600;
      const modes = [[3, 5], [-7, 2], [0, 11], [13, 0], [63, -41], [-127, 113]];
      const waves = modes.map(([x, y], c) => {
        const kx = 2 * Math.PI * x / sim[c], kz = 2 * Math.PI * y / sim[c];
        const k = Math.hypot(kx, kz), amplitude = Math.min(0.5, 0.05 / k);
        const w0 = 2 * Math.PI / sim[50];
        const omega = Math.floor(Math.sqrt(9.81 * k + 7.4e-5 * k ** 3) / w0) * w0;
        return { x, y, kx, kz, k, amplitude, omega };
      });
      const initial = new Float32Array(bytes / 4);
      for (let c = 0; c < CASCADES; c++) {
        const { x, y, amplitude } = waves[c];
        const index = (x, y) => ((c * N + (y + N) % N) * N + (x + N) % N) * 4;
        initial[index(x, y)] = amplitude / 2;
        initial[index(-x, -y) + 2] = amplitude / 2;
        initial[index(0, 0)] = 10; // The zero-frequency term must be suppressed.
      }
      device.queue.writeBuffer(h0, 0, initial);
      const points = [[0, 0], [1, 17], [31, 99], [128, 128], [197, 23], [255, 255]];
      const sampleCount = CASCADES * points.length * textures.length;
      const read = buffer(sampleCount * 256, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      function half(bits) {
        const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, fraction = bits & 1023;
        return sign * (exponent ? (1 + fraction / 1024) * 2 ** (exponent - 15) : fraction * 2 ** -24);
      }
      let maxError = 0, checked = 0;
      for (const [time, choppy] of [[0, 1.25], [1.25, 0], [3.25, 1.25]]) {
        sim[48] = choppy; sim[52] = time;
        device.queue.writeBuffer(ubo, 0, sim);
        const enc = device.createCommandEncoder(), cp = enc.beginComputePass();
        for (let i = 0; i < pipes.length; i++) {
          cp.setPipeline(pipes[i]); cp.setBindGroup(0, groups[i]); cp.dispatchWorkgroups(N, 1, CASCADES);
        }
        cp.end();
        let sample = 0;
        for (let c = 0; c < CASCADES; c++) for (const [x, y] of points) for (const texture of textures) {
          enc.copyTextureToBuffer({ texture, origin: [x, y, c] }, { buffer: read, offset: sample++ * 256, bytesPerRow: 256 }, [1, 1, 1]);
        }
        device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = new Uint16Array(read.getMappedRange());
        sample = 0;
        for (let c = 0; c < CASCADES; c++) for (const [x, y] of points) {
          const w = waves[c], phase = 2 * Math.PI * (w.x * x + w.y * y) / N - w.omega * time;
          const height = w.amplitude * Math.cos(phase), slope = -w.amplitude * Math.sin(phase);
          const sx = slope * w.kx, sz = slope * w.kz, jacobian = -choppy * height / w.k;
          const expected = [
            [choppy * sx / w.k, height, choppy * sz / w.k, jacobian * w.kx * w.kz],
            [sx, sz, jacobian * w.kx ** 2, jacobian * w.kz ** 2],
            [sx * sx, sz * sz, sx * sz, 0],
          ];
          for (const vector of expected) {
            for (let j = 0; j < 4; j++) {
              const value = half(values[sample * 128 + j]);
              if (!Number.isFinite(value)) throw new Error('Non-finite FFT output');
              maxError = Math.max(maxError, Math.abs(value - vector[j])); checked++;
            }
            sample++;
          }
        }
        read.unmap();
      }
      device.destroy();
      return { maxError, checked, errors };
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.checked, 1296);
    assert.ok(result.maxError < 0.0005, `FFT absolute error: ${result.maxError}`);
  } finally { await page.close(); }
});

// Keep scheduling deterministic and render to an ordinary GPU texture. Some headless
// SwiftShader builds support WebGPU but cannot present a WebGPU canvas swap chain.
function instrumentRenderer() {
  window.check = { callback: null, compute: {}, render: {}, errors: [], target: null };
  window.requestAnimationFrame = callback => { check.callback = callback; return 1; };
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const device = await requestDevice.apply(this, args);
    check.device = device;
    device.addEventListener('uncapturederror', e => check.errors.push(e.error.message));
    return device;
  };
  const configs = new WeakMap(), configure = GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure = function (desc) { configs.set(this, desc); return configure.call(this, desc); };
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    const desc = configs.get(this), { width, height } = this.canvas;
    if (!check.target || check.target.width !== width || check.target.height !== height) {
      check.target?.destroy();
      check.target = desc.device.createTexture({ size: [width, height], format: desc.format, usage: desc.usage });
    }
    return check.target;
  };
  const labels = new WeakMap(), setCompute = GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline = function (pipe) { labels.set(this, pipe.label); return setCompute.call(this, pipe); };
  const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.dispatchWorkgroups = function (x, y = 1, z = 1) {
    (check.compute[labels.get(this)] ||= []).push([x, y, z]);
    return dispatch.call(this, x, y, z);
  };
  const setRender = GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline = function (pipe) {
    check.render[pipe.label] = (check.render[pipe.label] || 0) + 1;
    return setRender.call(this, pipe);
  };
}

async function step(page) {
  const result = await page.evaluate(async () => {
    const callback = check.callback;
    check.callback = null; check.compute = {}; check.render = {};
    callback(performance.now());
    await check.device.queue.onSubmittedWorkDone();
    return { compute: check.compute, render: check.render, errors: check.errors };
  });
  assert.deepEqual(result.errors, []);
  return result;
}

async function slider(page, label, value) {
  await page.locator('label').filter({ hasText: label }).locator('input').evaluate((input, value) => {
    input.value = value; input.dispatchEvent(new Event('input'));
  }, String(value));
}

test('bow contacts, persistent wake, impact spray, landing foam, and resets agree on the GPU', { timeout: 180000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/__interaction_test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`${origin}/__interaction_test`);
    const result = await page.evaluate(async () => {
      const { createWaterInteraction } = await import('/js/interaction.js');
      const { WAKE_SIZE, SPRAY_COUNT, SHEET_COUNT } = await import('/js/wgsl/interaction.js');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const errors = []; device.onuncapturederror = e => errors.push(e.error.message);
      const B = GPUBufferUsage, T = GPUTextureUsage;
      const frame = device.createBuffer({ size: 384, usage: B.UNIFORM | B.COPY_DST });
      const hull = device.createBuffer({ size: 96, usage: B.UNIFORM | B.COPY_DST });
      const f = new Float32Array(96); f.fill(1, 48, 54); device.queue.writeBuffer(frame, 0, f);
      const h = new Float32Array(24); h[0] = h[5] = 1; h[10] = -1; h[12] = 3.6; h[13] = 12; h[22] = 1;
      const sea = device.createTexture({ size: [1, 1, 6], format: 'rgba16float', usage: T.TEXTURE_BINDING | T.COPY_DST });
      const env = device.createTexture({ size: [32, 32, 6], mipLevelCount: 6, format: 'rgba16float', usage: T.TEXTURE_BINDING });
      const trans = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: T.TEXTURE_BINDING });
      const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
      const shader = async (code, label) => {
        const module = device.createShaderModule({ code, label });
        const info = await module.getCompilationInfo();
        const bad = info.messages.filter(m => m.type === 'error');
        if (bad.length) throw new Error(label + ': ' + bad.map(m => m.message).join('\n'));
        return module;
      };
      const computePipe = async (code, label) => device.createComputePipelineAsync({ label, layout: 'auto', compute: { module: await shader(code, label), entryPoint: 'main' } });
      const fx = await createWaterInteraction({ device, frameUBO: frame, hullUBO: hull, seaView: sea.createView({ dimension: '2d-array' }), seaSampler: sampler, envView: env.createView({ dimension: 'cube' }), transView: trans.createView(), shader, computePipe });
      const boat = { showProw: true, effects: true, length: 12, beam: 3.6, x: 0, z: 0, speed: 0, revision: 0 };
      let tick = 0;
      async function advance(count, dt = 1 / 60) {
        for (let i = 0; i < count; i++) {
          h[16] = boat.x; h[18] = boat.z;
          device.queue.writeBuffer(hull, 0, h);
          fx.update(boat, dt, ++tick * dt, tick, 0, 0);
          const enc = device.createCommandEncoder(), cp = enc.beginComputePass(); fx.encode(cp); cp.end();
          device.queue.submit([enc.finish()]);
        }
        await device.queue.onSubmittedWorkDone();
      }
      async function read(buffer, size) {
        const staging = device.createBuffer({ size, usage: B.COPY_DST | B.MAP_READ });
        const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(buffer, 0, staging, 0, size); device.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(staging.getMappedRange().slice(0)); staging.unmap(); staging.destroy(); return out;
      }
      function half(n) {
        const e = (n >> 10) & 31, f = n & 1023;
        return (n & 32768 ? -1 : 1) * (e === 31 ? Infinity : e ? (1 + f / 1024) * 2 ** (e - 15) : f * 2 ** -24);
      }
      async function wake() {
        const size = WAKE_SIZE * WAKE_SIZE * 8;
        const staging = device.createBuffer({ size, usage: B.COPY_DST | B.MAP_READ });
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: fx.textures[fx.current] }, { buffer: staging, bytesPerRow: WAKE_SIZE * 8 }, [WAKE_SIZE, WAKE_SIZE]);
        device.queue.submit([enc.finish()]); await staging.mapAsync(GPUMapMode.READ);
        const values = Float32Array.from(new Uint16Array(staging.getMappedRange()), half); staging.unmap(); staging.destroy(); return values;
      }
      const live = values => values.filter((v, i) => i % 12 === 3 && v > 0).length;
      await advance(2);
      const resting = { contacts: Array.from(await read(fx.contacts, 32 * 64)), live: live(await read(fx.drops, SPRAY_COUNT * 48)), wake: (await wake()).reduce((a, b) => Math.max(a, b), 0) };
      boat.speed = 12;
      await advance(90);
      const movingContacts = await read(fx.contacts, 32 * 64), movingWake = await wake();
      let maxHeight = 0, foam = 0, finite = true;
      for (let i = 0; i < movingWake.length; i += 4) { maxHeight = Math.max(maxHeight, Math.abs(movingWake[i])); foam += movingWake[i + 2]; finite &&= Number.isFinite(movingWake[i]) && Number.isFinite(movingWake[i + 1]); }
      const moving = { live: live(await read(fx.drops, SPRAY_COUNT * 48)), sheets: (await read(fx.sheets,SHEET_COUNT*64)).filter((v,i)=>i%16===7 && v>0).length, maxHeight, foam };
      // Buoyancy and rendering sample this same field: probe its strongest texel centre.
      let peak = 0;
      for (let i = 0; i < movingWake.length; i += 4) if (movingWake[i] > movingWake[peak]) peak = i;
      const cell = peak / 4;
      f[16] = (cell % WAKE_SIZE + 0.5 - 128) * 0.5;
      f[18] = (Math.floor(cell / WAKE_SIZE) + 0.5 - 128) * 0.5;
      device.queue.writeBuffer(frame, 0, f);
      const { HEIGHT_PROBE } = await import('/js/wgsl/ocean.js');
      const probe = await computePipe(HEIGHT_PROBE, 'wake buoyancy fixture');
      const probeBoat = device.createBuffer({ size: 32, usage: B.UNIFORM });
      const probeOut = device.createBuffer({ size: 64, usage: B.STORAGE | B.COPY_SRC });
      const probeEnc = device.createCommandEncoder(), probePass = probeEnc.beginComputePass();
      probePass.setPipeline(probe);
      probePass.setBindGroup(0, device.createBindGroup({ layout: probe.getBindGroupLayout(0), entries: [
        { buffer: frame }, sea.createView({ dimension: '2d-array' }), sampler, { buffer: probeOut }, { buffer: probeBoat }, { buffer: fx.uniform }, fx.views[fx.current], fx.sampler,
      ].map((resource, binding) => ({ binding, resource })) }));
      probePass.dispatchWorkgroups(1); probePass.end(); device.queue.submit([probeEnc.finish()]);
      const probeError = Math.abs((await read(probeOut, 64))[9] - movingWake[peak]);
      // Recentring the grid retains the disturbance in world space.
      boat.x = 10;
      await advance(1);
      const shifted = await wake();
      let retained = 0;
      for (let y = 3; y < WAKE_SIZE - 3; y++) for (let x = 24; x < WAKE_SIZE - 3; x++) {
        const previous = movingWake[(y * WAKE_SIZE + x) * 4 + 2];
        if (previous > 0.02 && shifted[(y * WAKE_SIZE + x - 20) * 4 + 2] > previous * 0.8) retained++;
      }
      // Large dt and speed must remain bounded and finite, including sharp turns/changes.
      boat.speed = 40;
      await advance(24, 0.1);
      for (const n of await wake()) finite &&= Number.isFinite(n);
      boat.effects = false; await advance(1);
      const disabled = { live: live(await read(fx.drops, SPRAY_COUNT * 48)), wake: (await wake()).some(n => n !== 0) };
      boat.effects = true; boat.speed = 0; boat.x = 0; boat.revision++; h[17] = 5;
      await advance(5);
      const dry = Array.from(await read(fx.contacts, 32 * 64));
      h[17] = 0; boat.revision++; await advance(2);
      // A stationary bow still throws spray as a crest rises into it. 0x3000 = 0.125 m.
      device.queue.writeTexture({ texture: sea }, new Uint16Array([0, 0x3000, 0, 0]), { bytesPerRow: 8 }, [1, 1, 1]);
      await advance(1);
      const impact = Array.from(await read(fx.contacts, 32 * 64));
      const launched=(await read(fx.sheets,SHEET_COUNT*64)).filter((v,i)=>i%16===7 && v>0).length;
      const impactWake=await wake();
      await advance(60);
      const propagatedWake=await wake();
      let outgoing=0;
      for(let cell=0;cell<WAKE_SIZE*WAKE_SIZE;cell++){
        const x=(cell%WAKE_SIZE+.5-128)*.5,z=(Math.floor(cell/WAKE_SIZE)+.5-128)*.5;
        let distance=Infinity;
        for(let c=0;c<32;c++)distance=Math.min(distance,Math.hypot(x-impact[c*16],z-impact[c*16+2]));
        if(distance>2.5)outgoing=Math.max(outgoing,Math.abs(propagatedWake[cell*4])-Math.abs(impactWake[cell*4]));
      }
      await advance(90);
      const settled={sheets:(await read(fx.sheets,SHEET_COUNT*64)).filter((v,i)=>i%16===7 && v>0).length,
        particles:live(await read(fx.drops,SPRAY_COUNT*48)),contacts:Array.from(await read(fx.contacts,32*64))};
      // A second distinct rise must launch another event, after the first sheet has vanished.
      device.queue.writeTexture({texture:sea},new Uint16Array([0,0x3400,0,0]),{bytesPerRow:8},[1,1,1]);
      await advance(1);
      const second=Array.from(await read(fx.contacts,32*64));
      device.queue.writeTexture({texture:sea},new Uint16Array([0,0x3000,0,0]),{bytesPerRow:8},[1,1,1]);
      // Deposit one known descending droplet into a quiet cell, without CPU production hooks.
      boat.effects = false; await advance(1); boat.effects = true; boat.revision++; await advance(2);
      const inject = await computePipe(`struct D { p:vec4f, v:vec4f, s:vec4f }; @group(0) @binding(0) var<storage,read_write> d:array<D>; @compute @workgroup_size(1) fn main(){ d[0].p=vec4f(20,0.14,20,1); d[0].v=vec4f(0,-3,0,1); d[0].s=vec4f(0.03,0,0,1); }`, 'landing fixture');
      const enc = device.createCommandEncoder(), cp = enc.beginComputePass(); cp.setPipeline(inject);
      cp.setBindGroup(0, device.createBindGroup({ layout: inject.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: fx.drops } }] })); cp.dispatchWorkgroups(1); cp.end(); device.queue.submit([enc.finish()]);
      await advance(1);
      const landing = (await wake())[((128 + 40) * WAKE_SIZE + 128 + 40) * 4 + 2];
      const landedLive = (await read(fx.drops, 48))[3];
      // Roll, pitch, and heading must move the emitter with the hull/water intersection.
      const { boatRotate } = await import('/js/boat.js');
      const { hullHalfWidth } = await import('/js/hull.js');
      boatRotate(h.subarray(0, 3), 1, 0, 0, 0.7, 0.08, 0.25);
      boatRotate(h.subarray(4, 7), 0, 1, 0, 0.7, 0.08, 0.25);
      boatRotate(h.subarray(8, 11), 0, 0, -1, 0.7, 0.08, 0.25);
      boat.revision++; await advance(2);
      const tilted = await read(fx.contacts, 32 * 64);
      let contactError = 0;
      for (let i = 0; i < 32; i++) {
        const p = tilted.subarray(i * 16, i * 16 + 3);
        const dot = offset => p.reduce((sum, v, j) => sum + v * h[offset + j], 0);
        const x = dot(0), y = dot(4), z = -dot(8);
        const expectedWidth = hullHalfWidth(z,y);
        contactError = Math.max(contactError, Math.abs(Math.abs(x) - expectedWidth), Math.abs(p[1] - 0.125));
      }
      device.destroy();
      return { resting, moving, probeError, contacts: Array.from(movingContacts), retained, finite, disabled, dry, impact, landing, landedLive, contactError, launched, outgoing, settled, second, errors };
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.resting.live, 0); assert.equal(result.resting.wake, 0);
    assert.ok(result.resting.contacts.every((v, i) => i % 16 !== 3 || v === 0));
    assert.equal(result.moving.live,0,'steady speed on flat water must not become a droplet fountain');
    assert.equal(result.moving.sheets,0,'calm displacement does not launch impact sheets');
    assert.ok(result.moving.maxHeight > 0.02 && result.moving.maxHeight <= 1.11);
    assert.ok(result.moving.foam > 1);
    assert.ok(result.probeError < 0.001, `Buoyancy differs from wake texture: ${result.probeError}`);
    for (let i = 0; i < 16; i++) {
      assert.ok(Math.abs(result.contacts[i * 16] + result.contacts[(i + 16) * 16]) < 1e-5, 'port/starboard contact symmetry');
      assert.ok(Math.abs(result.contacts[i * 16 + 3] - result.contacts[(i + 16) * 16 + 3]) < 1e-5, 'port/starboard energy symmetry');
    }
    assert.ok(result.retained > 20, 'wake must remain in world space when its grid moves');
    assert.ok(result.finite); assert.deepEqual(result.disabled, { live: 0, wake: false });
    assert.ok(result.dry.every((v, i) => i % 16 !== 3 || v === 0), 'dry hull emits no spray');
    assert.ok(result.launched>10,'a rising crest launches a coherent sheet population');
    assert.ok(result.outgoing>0.0001,`impact must radiate away from the hull: ${result.outgoing}`);
    assert.equal(result.settled.sheets,0,'impact sheets expire between waves');
    assert.equal(result.settled.particles,0,'mist settles between waves');
    assert.ok(result.settled.contacts.every((v,i)=>i%16!==7 || v<0.0001),'impact energy decays on a held water level');
    assert.ok(result.second.some((v,i)=>i%16===15 && v>result.impact[i]),'the next crest triggers another launch');
    assert.ok(result.impact.some((v, i) => i % 16 === 3 && v > 0.2), 'relative wave impact drives emission at zero boat speed');
    assert.ok(result.landing > 0, 'landing deposits foam'); assert.ok(result.landedLive <= 0, 'landed particle is retired');
    assert.ok(result.contactError < 0.02, `Tilted hull contact error: ${result.contactError}`);
  } finally { await page.close(); }
});

test('deck overtopping retains water, flows downhill, drains, and dries independently', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__deck_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__deck_test`);
    const result=await page.evaluate(async()=>{
      const {createDeckWash}=await import('/js/deck.js');
      const {DECK_COLS:W,DECK_ROWS:H}=await import('/js/wgsl/deck.js');
      const {boatRotate}=await import('/js/boat.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const buffer=size=>device.createBuffer({size,usage:B.UNIFORM|B.COPY_DST});
      const frameUBO=buffer(384),hullUBO=buffer(96),uniform=buffer(64);
      const f=new Float32Array(96);f.fill(1,48,54);device.queue.writeBuffer(frameUBO,0,f);
      const h=new Float32Array(24);h[0]=h[5]=1;h[10]=-1;h[12]=3.6;h[13]=12;h[22]=1;
      const u=new Float32Array(16);u[9]=1;
      const sea=device.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const env=device.createTexture({size:[32,32,6],mipLevelCount:6,format:'rgba16float',usage:T.TEXTURE_BINDING});
      const trans=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const shader=async(code,label)=>{
        const module=device.createShaderModule({code,label});
        const info=await module.getCompilationInfo();
        const bad=info.messages.filter(m=>m.type==='error');if(bad.length)throw new Error(bad.map(m=>m.message).join('\n'));
        return module;
      };
      const computePipe=async(code,label)=>device.createComputePipelineAsync({layout:'auto',compute:{module:await shader(code,label),entryPoint:'main'}});
      const deck=await createDeckWash({device,frameUBO,hullUBO,uniform,seaView:sea.createView({dimension:'2d-array'}),seaSampler:sampler,envView:env.createView({dimension:'cube'}),transView:trans.createView(),shader,computePipe});
      const seaHeight=half=>device.queue.writeTexture({texture:sea},new Uint16Array([0,half,0,0]),{bytesPerRow:8},[1,1,1]);
      async function advance(n,dt=1/60,reset=false){
        u[6]=dt;u[7]=reset?1:0;device.queue.writeBuffer(uniform,0,u);device.queue.writeBuffer(hullUBO,0,h);
        // Every submission advances exactly four bounded water substeps.
        for(let i=0;i<n;i++){
          const enc=device.createCommandEncoder(),cp=enc.beginComputePass();deck.encode(cp);cp.end();device.queue.submit([enc.finish()]);
        }
        await device.queue.onSubmittedWorkDone();
      }
      async function read(){
        const size=W*H*16,read=device.createBuffer({size,usage:B.COPY_DST|B.MAP_READ});
        const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture:deck.textures[0]},{buffer:read,bytesPerRow:W*16},[W,H]);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const a=new Float32Array(read.getMappedRange().slice(0));read.unmap();read.destroy();
        let water=0,wet=0,drain=0,center=0,moment=0,roof=0,max=0,finite=true;
        for(let i=0;i<W*H;i++){
          const z=(Math.floor(i/W)+0.5)/H*11.9-6.3,x=i%W;
          const width=Math.max(0.04,1.8*Math.sqrt(Math.max(0.0006,1-(z<0?-z/6.4:z/7.4)**2))-0.04);
          const volume=a[i*4]*2*width/W*11.9/H;
          water+=volume;wet+=a[i*4+2];drain+=Math.max(0,a[i*4+3]);
          moment+=(x/(W-1)*2-1)*volume;max=Math.max(max,a[i*4]);
          if(x>10 && x<22)center+=volume;if(z>=2.7)roof+=volume;
        }
        for(const n of a)finite&&=Number.isFinite(n);
        return{water,wet,drain,center,moment,roof,max,finite};
      }
      await advance(1,1/60,true);seaHeight(0x3c00);await advance(60);const belowRail=await read();
      seaHeight(0x4000);await advance(120);const flooded=await read(); // two-metre crest
      seaHeight(0);await advance(1);const retained=await read();
      boatRotate(h.subarray(0,3),1,0,0,0,0,0.22);boatRotate(h.subarray(4,7),0,1,0,0,0,0.22);boatRotate(h.subarray(8,11),0,0,-1,0,0,0.22);
      await advance(90);const tilted=await read();
      await advance(600);const drained=await read();
      await advance(1800);const drying=await read();
      u[9]=0;await advance(1);const disabled=await read();u[9]=1;
      // The frame limit used during slow rendering still yields finite bounded water.
      seaHeight(0x4800);await advance(30,0.1);const submerged=await read();
      await advance(1,1/60,true);const reset=await read();
      device.destroy();return{belowRail,flooded,retained,tilted,drained,drying,disabled,submerged,reset,errors};
    });
    assert.deepEqual(result.errors,[]);
    assert.equal(result.belowRail.water,0,'water below the bulwark must not seep through the hull');
    assert.ok(result.flooded.water>0.1 && result.flooded.center>0.01,'overtopping must travel into the deck');
    assert.equal(result.flooded.roof,0,'a lower crest must not flood the raised quarterdeck');
    assert.ok(result.retained.water>result.flooded.water*0.8,'the deck must retain wash after the sea recedes');
    assert.ok(result.tilted.drain>0,'scupper outflow drives runoff strips');
    assert.ok(result.tilted.moment<0,'wash moves toward the low port rail');
    assert.ok(result.drained.water<result.retained.water*0.3,`water drains between encounters: ${JSON.stringify(result)}`);
    assert.ok(result.drained.wet>10,'wet timber outlasts standing water');
    assert.ok(result.drying.wet<result.drained.wet*0.9,'wetness must eventually dry instead of rounding to a permanent film');
    assert.ok(result.submerged.finite && result.submerged.max<=1.201,'deep immersion stays bounded at low frame rates');
    assert.equal(result.disabled.water,0);assert.equal(result.reset.water,0);assert.equal(result.reset.wet,0);
  }finally{await page.close();}
});

test('foam forms at breaking compression, stays bounded, and clears between crests', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__foam_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__foam_test`);
    const result=await page.evaluate(async()=>{
      const {FOAM_MODEL}=await import('/js/wgsl/common.js');
      const device=await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const code=FOAM_MODEL+`@group(0) @binding(0) var<storage,read_write> out:array<vec4f>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
        let dt=select(1.0/30.0,1.0/120.0,id.x==1u); let steps=u32(round(8.0/dt));
        let calm=breakingCompression(-0.3,0.0,0.0,0.45);
        let crest=breakingCompression(-1.5,0.0,0.0,0.45);
        var f=0.0;for(var i=0u;i<steps;i++){f=foamCoverage(f,crest,1.7,0.85,dt);}
        let peak=f;for(var i=0u;i<u32(round(3.0/dt));i++){f=foamCoverage(f,calm,1.7,0.85,dt);}
        out[id.x]=vec4f(calm,crest,peak,f);
      }`;
      const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}});
      const out=device.createBuffer({size:32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const read=device.createBuffer({size:32,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
      const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(pipe);
      cp.setBindGroup(0,device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:out}}]}));cp.dispatchWorkgroups(2);cp.end();
      enc.copyBufferToBuffer(out,0,read,0,32);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();device.destroy();return {values,errors};
    });
    assert.deepEqual(result.errors,[]);const a=result.values.slice(0,4),b=result.values.slice(4);
    assert.equal(a[0],0);assert.equal(a[1],1);
    assert.ok(a[2]>0.5 && a[2]<0.9,'sustained breaking remains fractional coverage');
    assert.ok(a[3]<0.08,'foam clears within three seconds after a crest passes');
    for(let i=0;i<4;i++)assert.ok(Math.abs(a[i]-b[i])<1e-5,'30 Hz and 120 Hz coverage agree');
  }finally{await page.close();}
});

test('renderer invalidates only changed sky inputs and skips disabled bloom', { timeout: 600000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 64, height: 48 } });
  try {
    await page.addInitScript(instrumentRenderer);
    // Scheduling is checked with clear volumes; the focused cloud fixture below
    // exercises populated raymarching without full 256px reflection faces on a CPU GPU.
    await page.goto(`${origin}/?prow=0&clouds=0&cam=0,30,0,0,-5.5&shot=test.png&frames=100000`);
    await page.waitForFunction(() => check.callback, undefined, { polling: 100, timeout: 120000 });
    let frame = await step(page);
    assert.equal(frame.compute.skyview.length, 1);
    assert.equal(frame.compute['env cube'][0][2], 6);
    assert.ok(frame.compute['cube mips'].every(d => d[2] === 6));
    assert.equal(frame.compute['cloud density'].length, 1);
    assert.equal(frame.compute['cloud lighting'].length, 1);
    assert.equal(frame.compute['cloud rays'].length, 1);
    assert.equal(frame.compute['cloud resolve'].length, 1);
    assert.equal(frame.render['bloom down'], 6); // 32 x 24 supports six mip levels.
    assert.equal(frame.render['bloom up'], 5);

    frame = await step(page);
    assert.equal(frame.compute.skyview, undefined);
    assert.equal(frame.compute.transmittance, undefined);
    assert.equal(frame.compute['sim init'], undefined);
    assert.equal(frame.compute['sim evolve'], undefined);
    assert.equal(frame.compute['height probe'], undefined);
    assert.equal(frame.compute['cloud density'], undefined);
    assert.equal(frame.compute['cloud lighting'], undefined);
    assert.equal(frame.compute['cloud rays'].length, 1);
    assert.equal(frame.compute['env cube'][0][2], 1);
    assert.ok(frame.compute['cube mips'].every(d => d[2] === 1));

    await slider(page, 'Sun azimuth', 25);
    frame = await step(page);
    assert.equal(frame.compute.skyview, undefined); // The LUT is relative to the sun.
    assert.equal(frame.compute['cloud density'], undefined);
    assert.equal(frame.compute['cloud lighting'].length, 1);
    assert.equal(frame.compute['env cube'][0][2], 6);

    await slider(page, 'Sun elevation', 10);
    frame = await step(page);
    assert.equal(frame.compute.skyview.length, 1);
    assert.equal(frame.compute.transmittance, undefined);

    await slider(page, 'Haze', 4);
    frame = await step(page);
    for (const key of ['transmittance', 'multiscatter', 'skyview']) assert.equal(frame.compute[key].length, 1);

    await page.keyboard.down('KeyE');
    frame = await step(page);
    await page.keyboard.up('KeyE');
    assert.equal(frame.compute.skyview.length, 1);
    assert.equal(frame.compute.transmittance, undefined);

    await slider(page, 'Choppiness', 0.5);
    await slider(page, 'Bloom', 0);
    frame = await step(page);
    assert.equal(frame.compute['sim init'], undefined);
    assert.equal(frame.render['bloom down'], undefined);
    assert.equal(frame.render['bloom up'], undefined);
    assert.equal(frame.render.composite, 1);

    await slider(page, 'Wind speed', 10);
    await slider(page, 'Bloom', 0.1);
    await page.setViewportSize({ width: 1, height: 1 });
    frame = await step(page);
    assert.equal(frame.compute['sim init'].length, 1);
    assert.equal(frame.compute['cloud density'], undefined, 'wind advects the material instead of rebuilding it');
    assert.equal(frame.compute['height probe'].length, 1);
    assert.equal(frame.render['bloom down'], 1);
    assert.equal(frame.render['bloom up'], undefined);

    // The target is deliberately 1x1; exercise the control's change handler directly.
    await page.getByLabel('Show ship', { exact: true }).evaluate(input => { input.checked = true; input.dispatchEvent(new Event('change')); });
    frame = await step(page);
    for (const key of ['hull contact', 'impact sheets', 'local wake', 'spray update', 'height probe']) assert.equal(frame.compute[key].length, 1);
    assert.equal(frame.render['bow sheets'], 1); assert.equal(frame.render.spray, 1);
    await page.getByLabel('Wakes & spray', { exact: true }).evaluate(input => { input.checked = false; input.dispatchEvent(new Event('change')); });
    await step(page); // One dispatch clears active particles and the local field.
    frame = await step(page);
    assert.equal(frame.compute['local wake'], undefined);
    assert.equal(frame.compute['spray update'], undefined);
    assert.equal(frame.render['bow sheets'], undefined); assert.equal(frame.render.spray, undefined);
  } finally { await page.close(); }
});

test('volumetric clouds clear, occlude, advect, and invalidate temporal history', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__cloud_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__cloud_test`);
    const result=await page.evaluate(async()=>{
      const {createVolumetricClouds}=await import('/js/clouds.js');
      const {FRAME_WGSL,ATMO_CORE_WGSL}=await import('/js/wgsl/common.js');
      const {SKY_RENDER_FUNCS}=await import('/js/wgsl/sky.js');
      const {CLOUD_SAMPLE}=await import('/js/wgsl/clouds.js');
      const device=await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const computePipe=async(code,label)=>device.createComputePipelineAsync({label,layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}});
      const frameUBO=device.createBuffer({size:384,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      const lut=device.createTexture({size:[1,1],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      device.queue.writeTexture({texture:lut},new Uint16Array([0x3c00,0x3c00,0x3c00,0x3c00]),{bytesPerRow:8},[1,1]);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const clouds=await createVolumetricClouds({device,frameUBO,transView:lut.createView(),skyView:lut.createView(),sampler,computePipe,fieldSize:[32,16,32]});
      const settings={clouds:0,cloudBase:1,cloudDepth:2,cloudDensity:1,cloudAnvil:0.8,cloudQuality:0.5,haze:3};
      const f=new Float32Array(96);f[17]=2;
      // Look upward through the layer. A camera-relative projection supplies
      // real history coordinates, including rotation and perspective divide.
      f[0]=2;f[7]=1;f[9]=2;f[14]=0.1;
      f[20]=0.5;f[26]=0.5;f[29]=1;f[33]=1;f[35]=14;
      f[36]=64;f[37]=48;f[38]=1/64;f[39]=1/48;f[56]=1;f[58]=20;f[72]=3;f[73]=0.01;
      const half=b=>{const e=(b>>10)&31,m=b&1023;return (b&32768?-1:1)*(e===31?(m?NaN:Infinity):e?(1+m/1024)*2**(e-15):m*2**-24);};
      async function read(texture){
        const row=Math.ceil(texture.width*8/256)*256;
        const buffer=device.createBuffer({size:row*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[texture.width,texture.height]);device.queue.submit([enc.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);const src=new Uint16Array(buffer.getMappedRange());const out=[];
        for(let y=0;y<texture.height;y++)for(let x=0;x<texture.width;x++)for(let c=0;c<4;c++)out.push(half(src[y*row/2+x*4+c]));
        buffer.unmap();buffer.destroy();return out;
      }
      async function advance(dt=1/60){
        f[70]++;device.queue.writeBuffer(frameUBO,0,f);clouds.update(f,settings,dt);
        const history=clouds.historyValid;const enc=device.createCommandEncoder(),pass=enc.beginComputePass();clouds.encode(pass);pass.end();device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();return history;
      }
      await advance();const clear=await read(clouds.output);
      settings.clouds=0.9;const coverageReset=await advance();const cloudy=await read(clouds.output);
      const accumulated=await advance();
      settings.cloudDensity=2;const densityReset=await advance();const dense=await read(clouds.output);
      await advance(20);const moved=await read(clouds.output);
      // Same volume / optical law powers the sunlight and reflected rays.
      const visibility=await computePipe(FRAME_WGSL+ATMO_CORE_WGSL+`
        @group(0) @binding(0) var<uniform> F:Frame;
        @group(0) @binding(1) var transLUT:texture_2d<f32>;
        @group(0) @binding(2) var skyLUT:texture_2d<f32>;
        @group(0) @binding(3) var sampC:sampler;
        @group(0) @binding(4) var<storage,read_write> result:array<f32>;
      `+SKY_RENDER_FUNCS+CLOUD_SAMPLE+`
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
          let origin=vec3f(f32(id.x%8u)*2.0-7.0,0.002,f32(id.x/8u)*2.0-3.0);
          result[id.x]=volumeSunVisibility(origin,vec3f(0,1,0));
        }
      `,'test cloud sunlight');
      const output=device.createBuffer({size:128,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const readback=device.createBuffer({size:128,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const visGroup=device.createBindGroup({layout:visibility.getBindGroupLayout(0),entries:[{binding:4,resource:{buffer:output}}]});
      const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(visibility);pass.setBindGroup(0,visGroup);pass.setBindGroup(1,clouds.bindVolume(visibility,true));pass.dispatchWorkgroups(32);pass.end();enc.copyBufferToBuffer(output,0,readback,0,128);device.queue.submit([enc.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const sun=new Float32Array(readback.getMappedRange()).reduce((a,b)=>a+b,0)/32;readback.unmap();
      f[36]=1;f[37]=1;const resized=await advance();const tiny=await read(clouds.output);
      f[16]=1000;const teleported=await advance();settings.clouds=0;await advance();const cleared=await read(clouds.output);
      const meanAlpha=v=>v.filter((_,i)=>i%4===3).reduce((a,b)=>a+b,0)/(v.length/4);
      const diff=dense.reduce((sum,v,i)=>sum+Math.abs(v-moved[i]),0)/dense.length;
      clouds.destroy();device.destroy();
      return {errors,clear:meanAlpha(clear),cloudy:meanAlpha(cloudy),dense:meanAlpha(dense),cleared:meanAlpha(cleared),diff,sun,
        coverageReset,densityReset,accumulated,resized,teleported,tiny:tiny.length,finite:[...clear,...cloudy,...dense,...moved,...tiny].every(Number.isFinite)};
    });
    assert.deepEqual(result.errors,[]);
    assert.ok(result.finite);
    assert.equal(result.clear,0);assert.equal(result.cleared,0);
    assert.ok(result.cloudy>0.05,JSON.stringify(result));
    assert.ok(result.dense>=result.cloudy,'greater optical density must not make clouds transparent');
    assert.ok(result.diff>0.005,'wind changes the visible material');
    assert.ok(result.sun>=0 && result.sun<1,'the same volume occludes direct sunlight');
    assert.equal(result.accumulated,true);
    for(const key of ['coverageReset','densityReset','resized','teleported'])assert.equal(result[key],false,key);
    assert.equal(result.tiny,4);
  }finally{await page.close();}
});

test('clouds extinguish the HDR sun and surface light together', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__sun_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__sun_test`);
    const result=await page.evaluate(async()=>{
      const {SUN_VIS}=await import('/js/wgsl/sky.js');
      const {SKY_BG}=await import('/js/wgsl/ocean.js');
      const device=await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const buffer=(size,usage)=>device.createBuffer({size,usage});
      const frame=buffer(384,B.UNIFORM|B.COPY_DST),cloud=buffer(128,B.UNIFORM|B.COPY_DST);
      const sun=buffer(16,B.STORAGE|B.COPY_SRC);
      const f=new Float32Array(96),c=new Float32Array(32);
      f[17]=2;f.set([0,0.5,-Math.sqrt(0.75)],28);f.set([0,0.5,-Math.sqrt(0.75),14],32);
      f.set([1,1,1,1/1024],36);f[72]=3;f[73]=0.01;
      c[24]=1;c[25]=2;c[31]=1;
      device.queue.writeBuffer(frame,0,f);
      const density=device.createTexture({dimension:'3d',size:[8,8,8],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      device.queue.writeTexture({texture:density},new Uint16Array(8*8*8*4).fill(0x3c00),{bytesPerRow:64,rowsPerImage:8},[8,8,8]);
      const lut=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      device.queue.writeTexture({texture:lut},new Uint16Array(4).fill(0x3c00),{bytesPerRow:8},[1,1]);
      const screen=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      // Camera rays stop at <0.8% transmittance. That is adequate for cloud
      // radiance, but must never be used to attenuate a 200,000-radiance sun.
      device.queue.writeTexture({texture:screen},new Uint16Array([0x3400,0x3400,0x3400,0x3bf0]),{bytesPerRow:8},[1,1]);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const vis=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:SUN_VIS}),entryPoint:'main'}});
      const module=device.createShaderModule({code:SKY_BG});
      const sky=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba32float'}]}});
      const group=(pipe,index,entries)=>device.createBindGroup({layout:pipe.getBindGroupLayout(index),entries:entries.map(([binding,resource])=>({binding,resource}))});
      const vg=group(vis,0,[[0,{buffer:frame}],[4,{buffer:sun}]]);
      const vc=group(vis,1,[[0,{buffer:cloud}],[1,density.createView()],[3,sampler]]);
      const sg=group(sky,0,[[0,{buffer:frame}],[1,lut.createView()],[2,lut.createView()],[3,sampler],[4,{buffer:sun}]]);
      const sc=group(sky,1,[[4,screen.createView()]]);
      const target=device.createTexture({size:[1,1],format:'rgba32float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});
      const read=buffer(512,B.COPY_DST|B.MAP_READ),values=[];
      for(const extinction of [0,0.4,8,30]){
        c[26]=extinction;device.queue.writeBuffer(cloud,0,c);
        const enc=device.createCommandEncoder(),cp=enc.beginComputePass();
        cp.setPipeline(vis);cp.setBindGroup(0,vg);cp.setBindGroup(1,vc);cp.dispatchWorkgroups(1);cp.end();
        const rp=enc.beginRenderPass({colorAttachments:[{view:target.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]});
        rp.setPipeline(sky);rp.setBindGroup(0,sg);rp.setBindGroup(1,sc);rp.draw(3);rp.end();
        enc.copyBufferToBuffer(sun,0,read,0,16);enc.copyTextureToBuffer({texture:target},{buffer:read,offset:256,bytesPerRow:256},[1,1]);
        device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const data=new Float32Array(read.getMappedRange());values.push({visibility:data[0],radiance:data[64]});read.unmap();
      }
      device.destroy();return {errors,values};
    });
    assert.deepEqual(result.errors,[]);
    const [clear,thin,opaque,thicker]=result.values;
    assert.equal(clear.visibility,1);assert.ok(clear.radiance>100000);
    assert.ok(thin.visibility>0.15 && thin.visibility<0.25,'thin cloud follows Beer attenuation');
    assert.ok(opaque.visibility<1e-8 && thicker.visibility<1e-8,'opaque clouds must not retain a sunlight floor');
    assert.ok(opaque.radiance<1 && thicker.radiance<1,'opaque clouds must hide the HDR solar disc');
    assert.ok(Math.abs((thin.radiance-opaque.radiance)/(clear.radiance-opaque.radiance)-thin.visibility)<1e-5,
      'visible disc and surface sunlight must use identical attenuation');
  }finally{await page.close();}
});

for (const bundle of ['ocean.html', 'ocean.min.html', 'docs/index.html']) {
  test(`${bundle} initializes all JavaScript and WGSL pipelines`, { timeout: 120000 }, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.addInitScript(instrumentRenderer);
      await page.goto(`${origin}/${bundle}?w=1&h=1`);
      await page.waitForFunction(() => check.callback, undefined, { polling: 100, timeout: 90000 });
      assert.deepEqual(await page.evaluate(async () => {
        await check.device.queue.onSubmittedWorkDone();
        return check.errors;
      }), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
