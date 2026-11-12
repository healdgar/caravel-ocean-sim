// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The model on the page: founded in a worker, the page's own thread left free, and the board it founds there the
// same, to the last number, as the one Node founds from the same request (so a board baked ahead and a board
// founded in play are one thing).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { boardRequest } from '../js/board-model.js';
import { openBoard } from '../scripts/board-host.mjs';

const SPAN = 4096, SAMPLES = 129, SITE = { name: 'Porto Novo', culture: 'iberian', x: 150, z: 380 };
// The bay of tests/board-model.test.mjs, written so that the page can make the very same ground.
const BAY = `(x, z) => {
  const shore = 600 + 260 * Math.cos(x / 700) - 0.00012 * x * x, inland = shore - z;
  if (inland <= 0) return Math.max(-60, inland * 0.05);
  return Math.min(180, inland * 0.07 + 18 * Math.sin(x / 310) * Math.sin(z / 270) * Math.min(1, inland / 400)
    - 9 * Math.exp(-(x * x) / (2 * 120 * 120)) * Math.min(1, inland / 300));
}`;
const digest = (board) => createHash('sha256').update(JSON.stringify(board)).digest('hex');

test('a worker founds the board Node founds, lives the days Node lives, and leaves the page its frames', { timeout: 900000 }, async (t) => {
  const server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.route('**/__board', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(origin + '/__board');
    const seen = await page.evaluate(async ({ SPAN, SAMPLES, SITE, BAY }) => {
      const { boardRequest, boardKey } = await import('/js/board-model.js'), { openBoardWorker } = await import('/js/board-worker.js');
      const height = (0, eval)(BAY), heights = new Float32Array(SAMPLES * SAMPLES);
      for (let j = 0; j < SAMPLES; j++) for (let i = 0; i < SAMPLES; i++) heights[j * SAMPLES + i] = height((i / (SAMPLES - 1) - 0.5) * SPAN, (j / (SAMPLES - 1) - 0.5) * SPAN);
      const request = boardRequest({ heights, span: SPAN, site: SITE, seed: 1550, era: 1550, seat: 0.5 });
      // The page's own thread, watched: a timer that should fire every 50 ms however hard the worker works.
      let ticks = 0, worst = 0, last = performance.now();
      const watch = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; ticks++; }, 50);
      const began = performance.now(), heard = [];
      const model = await openBoardWorker(request);
      model.on.progress = (told) => heard.push(told);
      await model.ready;
      const board = await model.hook('board'), founded = performance.now() - began;
      clearInterval(watch);
      const later = await model.hook('live', 5), again = await model.hook('board');
      model.close();
      return { key: boardKey(request), board: JSON.stringify(board), later: JSON.stringify(later), again: JSON.stringify(again), founded, ticks, worst, heard: heard.length };
    }, { SPAN, SAMPLES, SITE, BAY });
    assert.deepEqual(errors, []);

    const height = (0, eval)(BAY), heights = new Float32Array(SAMPLES * SAMPLES);
    for (let j = 0; j < SAMPLES; j++) for (let i = 0; i < SAMPLES; i++) heights[j * SAMPLES + i] = height((i / (SAMPLES - 1) - 0.5) * SPAN, (j / (SAMPLES - 1) - 0.5) * SPAN);
    const open = await openBoard(boardRequest({ heights, span: SPAN, site: SITE, seed: 1550, era: 1550, seat: 0.5 }));
    const later = await open.live(5);
    await open.close();
    t.diagnostic(JSON.stringify({ foundedMs: Math.round(seen.founded), ticks: seen.ticks, worstGapMs: Math.round(seen.worst), progress: seen.heard, bytes: seen.board.length }));

    assert.equal(createHash('sha256').update(seen.board).digest('hex'), digest(open.board), 'the worker and Node found one board');
    assert.equal(createHash('sha256').update(seen.later).digest('hex'), digest(later), 'and live the same five days');
    assert.equal(seen.again, seen.later, 'a hook asked again answers as it stands');
    assert.ok(seen.heard > 3, 'the founding is heard as it goes');
    // While the worker founded a country, the page's timer kept its beat.
    assert.ok(seen.founded > 500, `founding took ${seen.founded} ms`);
    assert.ok(seen.ticks > seen.founded / 50 * 0.7, `${seen.ticks} ticks in ${Math.round(seen.founded)} ms`);
    assert.ok(seen.worst < 400, `the page's thread was held ${Math.round(seen.worst)} ms at worst`);
  } finally { await browser?.close(); server.close(); }
});
