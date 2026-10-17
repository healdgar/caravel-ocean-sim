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

test('renderer invalidates only changed sky inputs and skips disabled bloom', { timeout: 600000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 64, height: 48 } });
  try {
    await page.addInitScript(instrumentRenderer);
    await page.goto(`${origin}/?cam=0,30,0,0,-5.5&shot=test.png&frames=100000`);
    await page.waitForFunction(() => check.callback, undefined, { polling: 100, timeout: 120000 });
    let frame = await step(page);
    assert.equal(frame.compute.skyview.length, 1);
    assert.equal(frame.compute['env cube'][0][2], 6);
    assert.ok(frame.compute['cube mips'].every(d => d[2] === 6));
    assert.equal(frame.render['bloom down'], 6); // 32 x 24 supports six mip levels.
    assert.equal(frame.render['bloom up'], 5);

    frame = await step(page);
    assert.equal(frame.compute.skyview, undefined);
    assert.equal(frame.compute.transmittance, undefined);
    assert.equal(frame.compute['sim init'], undefined);
    assert.equal(frame.compute['sim evolve'], undefined);
    assert.equal(frame.compute['height probe'], undefined);
    assert.equal(frame.compute['env cube'][0][2], 1);
    assert.ok(frame.compute['cube mips'].every(d => d[2] === 1));

    await slider(page, 'Sun azimuth', 25);
    frame = await step(page);
    assert.equal(frame.compute.skyview, undefined); // The LUT is relative to the sun.
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
    assert.equal(frame.compute['height probe'].length, 1);
    assert.equal(frame.render['bloom down'], 1);
    assert.equal(frame.render['bloom up'], undefined);
  } finally { await page.close(); }
});

for (const bundle of ['ocean.html', 'ocean.min.html']) {
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
