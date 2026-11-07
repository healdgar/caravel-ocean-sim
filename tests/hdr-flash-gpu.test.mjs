// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Pixels that blaze for one frame. Three things did it: leaves dividing colour by a coverage of nothing,
// figures whose attributes were read outside their triangles, and bloom that let one pixel light a wide
// circle. tests/flash-probe.mjs says how a flash is counted. Exposed 64 is far past white on screen.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { runFlashMeasure, setSun, summariseFlashes } from './flash-probe.mjs';
import { SCENES, SUNS, forestCamera, openScene, shipLook, slowPath, townCamera } from '../scripts/flash-survey.mjs';

let browser, server, base;
before(async () => {
  server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`, '--disable-gpu-watchdog'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); server?.close(); });

const scene = (id) => SCENES.find((s) => s.id === id);

// Nothing a surface does may be a hundred times brighter than a sunlit wall for one frame only.
const quiet = (t, label, summary) => {
  t.diagnostic(`${label}: ${JSON.stringify({ perSecond: summary.hdrFlashesPerSecond, byPeak: summary.hdrByPeak, shown: summary.displayFlashesPerSecond, peak: summary.peakExposed, worst: summary.worst[0] })}`);
  assert.equal(summary.nan + summary.inf, 0, `${label}: no NaN or infinity reaches the resolved image`);
  assert.ok(summary.hdrByPeak['>=256'] === 0, `${label}: flashes of 256 or more: ${JSON.stringify(summary.worst)}`);
  assert.ok(summary.hdrByPeak['>=64'] <= 0.5, `${label}: flashes of 64 or more: ${JSON.stringify(summary.worst)}`);
};

test('from the crow\'s nest at the Lisbon start, watching the forest with the ship under way, nothing flashes', { timeout: 300000 }, async (t) => {
  const { page, errors } = await openScene(browser, base, scene('lisbon-crows-nest'));
  try {
    const camera = await page.evaluate(`(${scene('lisbon-crows-nest').camera.fn})()`);
    const summary = summariseFlashes(await runFlashMeasure(page, { frames: 180, settle: 45, pose: shipLook(camera.target) }));
    quiet(t, 'crow\'s nest', summary);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('people, soldiers and leaves in a town stay quiet as the camera drifts', { timeout: 300000 }, async (t) => {
  const { page, errors } = await openScene(browser, base, scene('lisbon-town'));
  try {
    const camera = await page.evaluate(`(${townCamera})()`);
    await page.evaluate((c) => Object.assign(window.oceanFleet.camera, c), camera);
    const sun = SUNS.find((s) => s.id === 'side-noon');
    await setSun(page, sun.elevation, (camera.yaw * 180) / Math.PI + sun.offset);
    quiet(t, 'town', summariseFlashes(await runFlashMeasure(page, { frames: 120, settle: 45, pose: slowPath(camera) })));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('a forest with the sun behind and beside the camera stays quiet', { timeout: 300000 }, async (t) => {
  const { page, errors } = await openScene(browser, base, scene('forest-jamestown'));
  try {
    const camera = await page.evaluate(`(${forestCamera})(160)`);
    await page.evaluate((c) => Object.assign(window.oceanFleet.camera, c), camera);
    for (const id of ['low-behind', 'side-noon']) {
      const sun = SUNS.find((s) => s.id === id);
      await setSun(page, sun.elevation, (camera.yaw * 180) / Math.PI + sun.offset);
      quiet(t, id, summariseFlashes(await runFlashMeasure(page, { frames: 120, settle: 45, pose: slowPath(camera) })));
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

// The first bloom level and the composite, fed by hand: what they must refuse, and what they must leave alone.
test('bloom and composite refuse NaN, infinity and a lone pixel, and leave the sun and a flash alone', { timeout: 120000 }, async (t) => {
  const page = await browser.newPage();
  try {
    await page.route('**/__flash-guard', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`${base}__flash-guard`);
    const result = await page.evaluate(async () => {
      const { BLOOM_DOWN, COMPOSITE } = await import('/js/wgsl/post.js');
      const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice(), errors = [], B = GPUBufferUsage, T = GPUTextureUsage;
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const SIZE = 64;
      const toHalf = (v) => {
        if (Number.isNaN(v)) return 0x7e00;
        if (v === Infinity) return 0x7c00;
        if (v === 0) return 0;
        const e = Math.floor(Math.log2(v));
        return ((e + 15) << 10) + Math.round((v / 2 ** e - 1) * 1024);
      };
      const pipeline = (code, format) => {
        const module = device.createShaderModule({ code });
        return device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
      };
      const down = pipeline(BLOOM_DOWN, 'rgba16float'), composite = pipeline(COMPOSITE, 'rgba8unorm'), sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
      const run = async (paint) => {
        const pixels = new Uint16Array(SIZE * SIZE * 4);
        for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
          const v = paint(x, y);
          pixels.set([toHalf(v), toHalf(v), toHalf(v), toHalf(1)], (y * SIZE + x) * 4);
        }
        const source = device.createTexture({ size: [SIZE, SIZE], format: 'rgba16float', usage: T.TEXTURE_BINDING | T.COPY_DST });
        device.queue.writeTexture({ texture: source }, pixels, { bytesPerRow: SIZE * 8 }, [SIZE, SIZE]);
        const target = device.createTexture({ size: [SIZE / 2, SIZE / 2], format: 'rgba16float', usage: T.RENDER_ATTACHMENT | T.COPY_SRC | T.TEXTURE_BINDING });
        const shown = device.createTexture({ size: [SIZE, SIZE], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.COPY_SRC });
        const params = device.createBuffer({ size: 16, usage: B.UNIFORM | B.COPY_DST });
        device.queue.writeBuffer(params, 0, new Float32Array([1 / SIZE, 1 / SIZE, 1, 0]));
        const compParams = device.createBuffer({ size: 32, usage: B.UNIFORM | B.COPY_DST });
        device.queue.writeBuffer(compParams, 0, new Float32Array([1.35, 0.1, 0, 0, 1.05, 1.06, 0, 1]));
        const encoder = device.createCommandEncoder();
        let pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
        pass.setPipeline(down);
        pass.setBindGroup(0, device.createBindGroup({ layout: down.getBindGroupLayout(0), entries: [source.createView(), sampler, { buffer: params }].map((resource, binding) => ({ binding, resource })) }));
        pass.draw(3);
        pass.end();
        pass = encoder.beginRenderPass({ colorAttachments: [{ view: shown.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
        pass.setPipeline(composite);
        pass.setBindGroup(0, device.createBindGroup({ layout: composite.getBindGroupLayout(0), entries: [source.createView(), target.createView(), sampler, { buffer: compParams }].map((resource, binding) => ({ binding, resource })) }));
        pass.draw(3);
        pass.end();
        const bloomRead = device.createBuffer({ size: 256 * (SIZE / 2), usage: B.COPY_DST | B.MAP_READ }), shownRead = device.createBuffer({ size: 256 * SIZE, usage: B.COPY_DST | B.MAP_READ });
        encoder.copyTextureToBuffer({ texture: target }, { buffer: bloomRead, bytesPerRow: 256 }, [SIZE / 2, SIZE / 2]);
        encoder.copyTextureToBuffer({ texture: shown }, { buffer: shownRead, bytesPerRow: 256 }, [SIZE, SIZE]);
        device.queue.submit([encoder.finish()]);
        await Promise.all([bloomRead.mapAsync(GPUMapMode.READ), shownRead.mapAsync(GPUMapMode.READ)]);
        const words = new Uint16Array(bloomRead.getMappedRange()), bytes = new Uint8Array(shownRead.getMappedRange());
        const decode = (w) => { const e = (w >> 10) & 31, m = w & 1023; return e === 31 ? (m ? NaN : Infinity) : e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15); };
        let peak = 0, broken = 0, sum = 0;
        for (let y = 0; y < SIZE / 2; y++) for (let x = 0; x < SIZE / 2; x++) {
          const v = decode(words[(y * 256) / 2 + x * 4]);
          if (!Number.isFinite(v)) broken++;
          else { peak = Math.max(peak, v); sum += v; }
        }
        const summary = { peak, sum, broken, centre: bytes[(SIZE / 2) * 256 + (SIZE / 2) * 4 + 1], corner: bytes[4 * 256 + 4 * 4 + 1] };
        bloomRead.unmap();
        shownRead.unmap();
        for (const resource of [source, target, shown, params, compParams, bloomRead, shownRead]) resource.destroy();
        return summary;
      };
      const dim = 0.05, C = SIZE / 2, out = {};
      out.dim = await run(() => dim);
      out.lone = await run((x, y) => (x === C && y === C ? 16376 : dim));
      out.nan = await run((x, y) => (x === C && y === C ? NaN : dim));
      out.infinity = await run((x, y) => (x === C && y === C ? Infinity : dim));
      out.sun = await run((x, y) => (Math.hypot(x + 0.5 - C, y + 0.5 - C) < 3 ? 16376 : dim));
      out.flash = await run((x, y) => (Math.hypot(x + 0.5 - C, y + 0.5 - C) < 8 ? 300 : dim));
      out.edge = await run((x) => (x < C ? 40 : dim));
      await device.queue.onSubmittedWorkDone();
      device.destroy();
      return { errors, out };
    });
    t.diagnostic(JSON.stringify(result.out));
    assert.deepEqual(result.errors, []);
    const { dim, lone, nan, infinity, sun, flash, edge } = result.out;
    for (const bad of [nan, infinity]) {
      assert.equal(bad.broken, 0, 'nothing broken leaves the first bloom level');
      assert.ok(Math.abs(bad.corner - dim.corner) <= 2, 'and changes nothing far from it');
    }
    assert.ok(nan.peak <= dim.peak * 1.01, 'a NaN adds no light to bloom');
    assert.ok(infinity.peak < 1.5, `infinity counts as one very bright pixel: ${infinity.peak}`);
    assert.ok(lone.peak < 1.5, `one pixel at the top of the range lights bloom by at most a sunlit wall: ${lone.peak}`);
    assert.ok(lone.sum - dim.sum < 6, `and its total light in bloom stays small: ${lone.sum - dim.sum}`);
    assert.ok(lone.centre > 240, `it still shows, as a pixel: ${lone.centre}`);
    assert.ok(sun.peak > 8000, `the sun's disc reaches bloom at full strength: ${sun.peak}`);
    assert.ok(flash.peak > 250, `a muzzle flash reaches bloom at full strength: ${flash.peak}`);
    assert.ok(edge.peak > 35, `the bright side of a hard edge is not dimmed: ${edge.peak}`);
    assert.ok(sun.centre >= 250 && flash.centre >= 250, `the sun and a flash stay white on screen: ${sun.centre} ${flash.centre}`);
  } finally { await page.close(); }
});
