// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The scene's triangle count against its one budget (AGENTS.md rule 3, item 5): the census sums each family's own
// indirect records on the GPU, indexed and not, adds what the CPU reports, and follows the records as they change.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { CONTINUUM_TRIANGLE_BUDGET, CONTINUUM_BASE_PIXEL_ERROR, continuumCoarsening, continuumPixelError, setContinuumPixelError } from '../js/continuum-core.js';
import { createAdaptivePolygons } from '../js/resolution.js';

test('one scene scalar: the governor starts at the core\'s base error and the core holds what it sets', () => {
  assert.equal(createAdaptivePolygons('auto').pixelError, CONTINUUM_BASE_PIXEL_ERROR);
  const doubled = CONTINUUM_BASE_PIXEL_ERROR * 2;
  assert.equal(setContinuumPixelError(doubled), doubled);
  assert.equal(continuumPixelError(), doubled);
  assert.equal(continuumCoarsening(), 2);
  assert.equal(setContinuumPixelError(Number.NaN), doubled, 'a bad value leaves the scalar as it was');
  setContinuumPixelError(CONTINUUM_BASE_PIXEL_ERROR);
  assert.equal(continuumCoarsening(), 1);
});

test('the census counts submitted triangles from the families\' own indirect records', { timeout: 120000 }, async () => {
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const args = process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args });
    const page = await browser.newPage();
    await page.route('**/__continuum-census', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__continuum-census`);
    const result = await page.evaluate(async () => {
      const { createContinuumCensus } = await import('/js/continuum-census.js');
      const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice(), errors = [];
      device.onuncapturederror = (e) => errors.push(e.error.message);
      const usage = GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
      // Two indexed records after 16 bytes of something else, and two non-indexed records.
      const indexed = device.createBuffer({ size: 16 + 40, usage });
      device.queue.writeBuffer(indexed, 16, new Uint32Array([384, 1000, 0, 0, 0, 36, 7, 0, 0, 0]));
      const plain = device.createBuffer({ size: 32, usage });
      device.queue.writeBuffer(plain, 0, new Uint32Array([3, 250000, 0, 0, 30, 2, 0, 0]));
      const census = createContinuumCensus(device);
      const frame = async (sources) => {
        const encoder = device.createCommandEncoder();
        census.encode(encoder, sources);
        device.queue.submit([encoder.finish()]);
        census.afterSubmit();
        await device.queue.onSubmittedWorkDone();
        for (let i = 0; i < 50 && !census.latest; i++) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 30));
        return census.latest;
      };
      const first = await frame([{ name: 'forest', draws: [{ buffer: indexed, offset: 16, records: 2, stride: 5 }] }, { name: 'splats', draws: [{ buffer: plain, offset: 0, records: 2, stride: 4 }] }]);
      // The forest's cut shrinks: the census follows the records the GPU holds now.
      device.queue.writeBuffer(indexed, 16, new Uint32Array([384, 10, 0, 0, 0]));
      const second = await frame([{ name: 'forest', draws: [{ buffer: indexed, offset: 16, records: 2, stride: 5 }] }, { name: 'splats', draws: [{ buffer: plain, offset: 0, records: 2, stride: 4 }] }]);
      census.destroy();
      return { first, second, errors };
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.first.families, { forest: 128 * 1000 + 12 * 7, splats: 250000 + 10 * 2 });
    assert.equal(result.first.total, 128084 + 250020);
    assert.equal(result.first.budget, CONTINUUM_TRIANGLE_BUDGET);
    assert.equal(result.second.families.forest, 128 * 10 + 12 * 7);
  } finally {
    await browser?.close();
    server.close();
  }
});
