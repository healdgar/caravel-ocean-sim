// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The ship's company in the game itself, drawn through the people continuum (js/crew.js on js/crew-continuum-draw.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { CONTINUUM_LISTS } from '../js/continuum-format.js';

// The bodies' streams are published, not committed: a checkout without them cannot draw people at all.
const baked = ['sailor-male', 'villager-female', 'captain'].every((id) => fs.existsSync(new URL(`../assets/crew/continuum/${id}/atlas.bin.gz`, import.meta.url)));
let server, browser, origin;
before(async () => {
  server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); if (server) await new Promise((r) => server.close(r)); });

test('the company on deck is cut and drawn through the continuum: clusters near, everyone once, shadows cast', { skip: !baked && 'continuum bodies not baked here', timeout: 600000 }, async () => {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errors.push(m.text()); if (/Crew continuum/.test(m.text())) errors.push(m.text()); });
  // The game's device, kept as it is made, so the test can read the company's indirect draws back.
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) { const device = await request.apply(this, args); window.crewContinuumTestDevice ??= device; return device; };
  });
  try {
    await page.goto(`${origin}?ship=nina&fleet=&view=ship&clouds=0&w=640&h=400`);
    await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', null, { timeout: 300000, polling: 200 });
    assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready', errors.join('\n'));
    // Close over her deck, so the near people are cut from their clusters.
    await page.evaluate(() => { const orbit = window.oceanFleet.orbit; orbit.distance = 12; orbit.elevation = 0.4; });
    await page.waitForTimeout(3000);
    const result = await page.evaluate(async (lists) => {
      const crew = window.oceanFleet.vessels[0].crew, device = window.crewContinuumTestDevice ?? null;
      const draws = crew.continuumDraws();
      if (!device || !draws.length) return { people: crew.state.crew.filter((s) => s.visible).length, draws: draws.length, read: null };
      const read = [];
      // Each batch's draws open with every list's indirect record, four words each.
      for (const { buffer } of draws) {
        const copy = device.createBuffer({ size: lists.length * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, copy, 0, lists.length * 16);
        device.queue.submit([encoder.finish()]);
        await copy.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(copy.getMappedRange().slice(0));
        read.push(Object.fromEntries(lists.map((name, i) => [name, words[i * 4 + 1]])));
        copy.destroy();
      }
      return { people: crew.state.crew.filter((s) => s.visible).length, draws: draws.length, read };
    }, CONTINUUM_LISTS);
    assert.deepEqual(errors, []);
    assert.ok(result.draws >= 2, `${result.draws} batches drawn`);
    if (result.read) {
      const total = (name) => result.read.reduce((n, r) => n + r[name], 0);
      console.log('instances by list', Object.fromEntries(CONTINUUM_LISTS.map((name) => [name, total(name)])), 'people', result.people);
      assert.ok(total('clusters') + total('small clusters') > result.people, `near people are cut from clusters (${total('clusters')} and ${total('small clusters')} small)`);
      assert.ok(total('shadow far body') + total('shadow clusters') > 0, 'and cast shadows');
    }
  } finally { await page.close(); }
});
