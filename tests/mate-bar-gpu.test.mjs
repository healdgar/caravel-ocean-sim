// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The first mate's bar lies at the lower left of the running game. Whatever the window, it covers no control of the
// page: on a phone held upright the helm fills the foot of the screen and the bar sits above it; where a window has
// no room for it clear of the controls above and the helm below, it gives way.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

let browser, server, base;
before(async () => {
  server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-unsafe-webgpu', `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`, '--disable-gpu-watchdog'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); server?.close(); });

test('the mate\'s bar covers no control: above the helm on a phone, and out of the way where a window has no room', { timeout: 600000 }, async (t) => {
  for (const [width, height, shown] of [[390, 844, true], [844, 390, true], [1280, 800, true], [384, 256, false]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`${base}?ship=nina&fleet=&view=ship&clouds=0&w=160&h=108`);
    await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', null, { timeout: 300000, polling: 200 });
    assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready');
    await page.waitForFunction(() => { const bar = document.getElementById('storyteller-says'); return bar && !bar.hidden; }, null, { timeout: 60000, polling: 200 });
    const found = await page.evaluate(() => {
      const bar = document.getElementById('storyteller-says'), m = bar.getBoundingClientRect(), helm = document.getElementById('helm-controls').getBoundingClientRect(), covered = [];
      for (const el of document.querySelectorAll('button,input,select,a,[role=group]')) {
        if (bar.contains(el) || el.hidden || getComputedStyle(el).visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.height && r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top) covered.push(el.id || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24));
      }
      return { shown: m.height > 0, foot: m.bottom, helmTop: helm.top, covered };
    });
    t.diagnostic(`${width}×${height}: ${JSON.stringify(found)}`);
    assert.equal(found.shown, shown, `${width}×${height}`);
    assert.deepEqual(found.covered, [], `${width}×${height}`);
    if (shown) assert.ok(found.foot <= found.helmTop, `${width}×${height}: its foot at ${found.foot}, the helm's top at ${found.helmTop}`);
    // A control the bar lay over in a small window answers a click.
    if (!shown) { await page.getByRole('button', { name: 'Camera views', exact: true }).click({ timeout: 5000 }); assert.equal(await page.evaluate(() => document.getElementById('camera-panel').hidden), false); }
    await page.close();
  }
});
