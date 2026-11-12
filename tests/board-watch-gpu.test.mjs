// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Whoever stands a post of a founded port's forts is one of its model's own people: of its watch, of a host that
// lies in it, or holding it for its lord. In the running game each is named when pointed at and answers when asked,
// as the townsfolk do, and no one is at a post and in the street at once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { coastalRegionStageURL } from '../js/landfall.js';

let browser, server, base;
before(async () => {
  server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-unsafe-webgpu', `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`, '--disable-gpu-watchdog'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); server?.close(); });

test('Lisbon\'s fort posts are manned by the model\'s watch: each named, each answering, none in the street too', { timeout: 600000 }, async (t) => {
  // By the palace turret on the waterfront, looking at its crown.
  const url = coastalRegionStageURL(base, 'lisbon', 'dock', 'clear', 1550);
  for (const [k, v] of Object.entries({ w: 1280, h: 860, clouds: 0, follower: 0, view: 'free', cam: '84,23,-5878,-44,-4' })) url.searchParams.set(k, String(v));
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [];
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errors.push(m.text()); });
  await page.goto(url.toString());
  await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', null, { timeout: 300000, polling: 200 });
  assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready');

  // The posts are manned the moment the land is: the roll is in the board the land was laid from.
  const roll = JSON.parse(readFileSync(new URL('../assets/boards/lisbon-1550.json', import.meta.url), 'utf8')).board.places[0].watch;
  const posts = await page.evaluate(() => oceanFolk.posts.map((p) => ({ id: p.soul?.id, name: p.soul?.name, sex: p.soul?.sex, of: p.soul?.of, post: p.post, kind: p.kind, doing: p.doing, seen: p.seen })));
  const watch = await page.evaluate(() => { const w = oceanFolk.watch; return w && { place: w.place, garrison: w.garrison, men: w.men.length }; });
  assert.deepEqual(watch, { place: 'Lisboa', garrison: roll.garrison, men: roll.men.length });
  assert.ok(posts.length >= 40, `${posts.length} posts`);
  assert.deepEqual(posts.map((p) => p.id), roll.men.slice(0, posts.length).map((one) => one.id), 'the roll\'s men, in its order');
  for (const p of posts) assert.ok(p.name && p.post && /^(on watch|on guard|holding the place) /.test(p.doing), JSON.stringify(p));
  const figures = await page.evaluate(() => oceanLand.pack.port.garrison.soldiers.map((s) => ({ name: s.name, sex: s.sex, soul: s.soul?.name, soulSex: s.soul?.sex })));
  assert.equal(figures.length, posts.length, 'no figure stands a post without being one of them');
  for (const one of figures) { assert.equal(one.name, one.soul); assert.equal(one.sex, one.soulSex === 'f' ? 'female' : 'male'); }

  // On the roofs and crowns too: the lookouts of the towers and over the gate.
  const aloft = posts.filter((p) => p.kind === 'crown' || p.kind === 'gate-roof');
  assert.ok(aloft.length >= 4 && aloft.every((p) => p.name), `${aloft.length} aloft`);

  // Pointed at, one of them is named; clicked, they answer from the model's record of them.
  await page.waitForFunction(() => window.oceanBoard?.state === 'alive', null, { timeout: 240000, polling: 300 });
  await page.waitForTimeout(1500);
  const inSight = (await page.evaluate(() => oceanFolk.posts.filter((p) => p.seen).map((p) => ({ id: p.soul.id, name: p.soul.name, post: p.post, kind: p.kind, x: p.seen.x, y: p.seen.y, tall: p.seen.tall }))))
    .filter((p) => p.kind === 'crown' && p.tall >= 14 && p.x > 60 && p.x < 1220 && p.y > 60 && p.y < 800).sort((a, b) => b.tall - a.tall);
  assert.ok(inSight.length >= 1, 'a lookout on the turret\'s crown is in sight');
  const one = inSight[0];
  // Whoever passes between the eye and the turret is the one pointed at while they pass: wait for a clear sight of him.
  await page.waitForFunction(([x, y, id]) => oceanFolk.under(x, y)?.soul?.id === id, [one.x, one.y, one.id], { timeout: 60000, polling: 250 });
  await page.mouse.move(one.x + 40, one.y + 40); await page.mouse.move(one.x, one.y, { steps: 4 }); await page.waitForTimeout(400);
  const label = await page.evaluate(() => { const el = document.getElementById('folk-name'); return el && !el.hidden ? el.textContent : null; });
  assert.ok(label && label.startsWith(one.name) && label.endsWith(' · ' + one.post), `${label} for ${one.name}`);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForFunction(() => { const el = document.getElementById('folk-card'); return el && !el.hidden && el.querySelector('.folk-facts'); }, null, { timeout: 60000, polling: 200 });
  const card = await page.evaluate(() => document.getElementById('folk-card').innerText);
  assert.ok(card.includes(one.name) && /on watch on the crown of the /.test(card) && /You find me on watch on the crown of the /.test(card), card.slice(0, 400));
  assert.match(card, /Home|Household/);
  t.diagnostic(card.split('\n').filter(Boolean).slice(1, 4).join(' | '));

  // Once the model's people are about the streets, no one of the watch is among them.
  await page.waitForFunction(() => window.oceanFolk?.plan?.laid >= 1, null, { timeout: 240000, polling: 300 });
  const both = await page.evaluate(() => { const posted = new Set(oceanFolk.posts.map((p) => p.soul.id)); return { walkers: oceanFolk.souls.length, soulless: oceanFolk.souls.filter((s) => !s).length, both: oceanFolk.souls.filter((s) => s && posted.has(s.id)).length }; });
  assert.ok(both.walkers > 100, `${both.walkers} about the town`); assert.equal(both.soulless, 0, 'everyone about is a person'); assert.equal(both.both, 0);
  assert.deepEqual(errors, []);
  await page.close();
});
