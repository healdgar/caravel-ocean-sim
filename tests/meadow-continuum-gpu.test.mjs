// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Meadow grass on the one continuum (AGENTS.md rule 3): every patch in view is stood each frame as a record of the one
// format by the meadow's stand pass, and the one cut (js/continuum-scene.js) draws it: near, its sward's clusters;
// across the handoff its clusters and body both; farther its body alone, collapsing with distance; at a few pixels
// its splat, thinned below a pixel. Nothing selects, lists or draws grass but the one cut, which the census counts.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, before, after } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

let browser, server, base;
before(async () => {
  server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-unsafe-webgpu', `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`, '--disable-gpu-watchdog'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); server?.close(); });

// What the meadow's view of the one cut really drew, list by list, read back from its indirect arguments
// (js/continuum-scene.js draw: one drawIndirect a list, at the list's index times 16 bytes), and every pipeline made.
const LISTS = ['clusters', 'small clusters', 'far body', 'splat'];
const instrument = () => {
  const r = window.meadowAudit = { device: null, draws: [], capture: false, pipelines: [], errors: [] };
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) { const d = await request.apply(this, args); r.device ??= d; d.addEventListener('uncapturederror', (e) => r.errors.push(e.error.message)); return d; };
  for (const name of ['createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (desc) { r.pipelines.push(desc.label ?? ''); return original.call(this, desc); };
  }
  const pass = GPURenderPassEncoder.prototype, pipelines = new WeakMap();
  const setPipeline = pass.setPipeline; pass.setPipeline = function (p) { pipelines.set(this, p.label || ''); return setPipeline.call(this, p); };
  const indirect = pass.drawIndirect; pass.drawIndirect = function (b, o) { if (r.capture && pipelines.get(this) === 'meadowContinuum view') r.draws.push({ buffer: b, offset: o }); return indirect.call(this, b, o); };
};
const drawn = (page) => page.evaluate(async (lists) => {
  const r = window.meadowAudit; r.draws.length = 0; r.capture = true;
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); r.capture = false;
  const totals = Object.fromEntries(lists.map((name) => [name, 0])), contents = new Map();
  for (const buffer of new Set(r.draws.map((d) => d.buffer))) {
    const read = r.device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), encoder = r.device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, read, 0, buffer.size); r.device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    contents.set(buffer, new Uint32Array(read.getMappedRange().slice(0))); read.unmap(); read.destroy();
  }
  for (const d of r.draws) { const words = contents.get(d.buffer), at = d.offset / 4; totals[lists[d.offset / 16]] += words[at] * words[at + 1] / 3; }
  return { totals, pipelines: r.pipelines, errors: r.errors, census: window.oceanContinuumCensus?.latest ?? null };
}, LISTS);

test('Lisbon\'s grass is stood by the meadow and cut, near to the horizon, by the one continuum alone', { timeout: 360000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { const text = m.text(); if ((m.type() === 'error' && !/404|favicon/.test(text)) || (m.type() === 'warning' && /\[Invalid |validation|exceeds|GPU error|While (calling|validating|encoding)/.test(text))) errors.push(text); });
  const requested = []; page.on('request', (r) => requested.push(new URL(r.url()).pathname));
  try {
    await page.addInitScript(instrument);
    await page.goto(`${base}?region=lisbon&landfall=harbor&follower=0`);
    await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', undefined, { timeout: 200000, polling: 250 });
    assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready');
    for (let waited = 0; waited < 120000 && !requested.some((path) => path.includes('/meadows-gpu/atlas.bin')); waited += 500) await page.waitForTimeout(500);
    assert.ok(requested.some((path) => /\/portugal\/meadows-gpu\/atlas\.bin/.test(path)), 'Lisbon draws the Portugal sward\'s own atlas');
    await page.waitForTimeout(9000);
    const result = await drawn(page);
    const { totals } = result;
    assert.ok(totals.clusters + totals['small clusters'] > 0, `near grass draws as its clusters: ${JSON.stringify(totals)}`);
    assert.ok(totals['far body'] + totals.splat > 0, `far grass draws as its body and splats: ${JSON.stringify(totals)}`);
    // Grass has one path: the meadow's stand pass and the one cut's programs. The meadow's own cut, its lists, its
    // tiers and its pipelines are gone, as are the ground cover's grass and its cull.
    const grassy = [...new Set(result.pipelines.filter((label) => /meadow|ground cover|grass/i.test(label)))].sort();
    assert.deepEqual(grassy, ['meadow stand blocks', 'meadow stand finish', 'meadow stand patches', 'meadow stand reset', 'meadowContinuum view']);
    // The census counts the meadow from the one cut's own records.
    assert.ok(result.census?.families?.meadow > 0, 'the meadow reaches the continuum census');
    assert.ok(!('ground' in (result.census?.families ?? {})), 'no ground-cover grass in the census');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'shots/meadow-continuum-lisbon-harbor.png' });
  } finally { await page.close(); }
});

test('the meadow bends in the wind, and hard wind moves it further', { timeout: 360000 }, async () => {
  const sample = async (windSpeed) => {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } }), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${base}?region=lisbon&landfall=harbor&follower=0&weather=clear&windSpeed=${windSpeed}`);
      await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', undefined, { timeout: 200000, polling: 250 });
      await page.waitForTimeout(9000);
      const frames = [];
      for (let i = 0; i < 2; i++) { frames.push(await page.screenshot({ clip: { x: 0, y: 180, width: 960, height: 360 } })); await page.waitForTimeout(900); }
      assert.deepEqual(errors, []);
      return await page.evaluate(async ([a, b]) => {
        const read = async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
        const [p, q] = await Promise.all([read(a), read(b)]); let changed = 0; for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 24) changed++; return changed;
      }, frames.map((f) => f.toString('base64')));
    } finally { await page.close(); }
  };
  const calm = await sample(0.01), gale = await sample(16);
  assert.ok(gale > calm, `hard wind should change more of the picture: calm ${calm}, gale ${gale}`);
});
