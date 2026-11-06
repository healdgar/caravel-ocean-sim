// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// In the running game, with no window: the free camera's cannon strikes a forest trunk and a foreshore palm, the root the GPU
// reads is what changes, and a tree shot down is still down when the game comes back from a saved link.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { coastalRegionStageURL } from '../js/landfall.js';

let browser, server, base;
before(async () => {
  server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`, '--disable-gpu-watchdog'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); server?.close(); });

async function open(region, params = {}, state = null) {
  const url = coastalRegionStageURL(base, region, 'dock', 'clear', 1650);
  for (const [key, value] of Object.entries({ w: 640, h: 360, polygons: 'fixed', view: 'free', sunElev: 50, clouds: 0, follower: 0, prow: 0, ...params })) url.searchParams.set(key, String(value));
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } }), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errors.push(m.text()); });
  await page.goto(url.toString() + (state ? `&state=${state}` : ''));
  await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', null, { timeout: 240000, polling: 200 });
  assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready');
  await page.waitForFunction(() => window.oceanFleet?.terrain?.forestTrunks?.trees > 0, null, { timeout: 120000, polling: 200 });
  return { page, errors };
}

// A tree of this species out in the open, away from any building, with a clear line to stand on.
const pickTree = (page, species, range) => page.evaluate(({ species, range }) => {
  const t = oceanFleet.terrain, grid = t.forestTrunks, roots = grid.roots, names = grid.shapes.map((s) => s?.species);
  const buildings = (t.ports ?? []).flatMap((q) => q.instances ?? []);
  const cx = t.port?.center?.x ?? 0, cz = t.port?.center?.z ?? 0, list = [];
  for (let i = 0; i < grid.trees; i++) if (names[roots[grid.rootOf[i] * 12 + 8] | 0] === species) list.push(grid.rootOf[i]);
  list.sort((a, b) => Math.hypot(roots[a * 12] - cx, roots[a * 12 + 2] - cz) - Math.hypot(roots[b * 12] - cx, roots[b * 12 + 2] - cz));
  for (const index of list.slice(0, 1600)) {
    const x = roots[index * 12], y = roots[index * 12 + 1], z = roots[index * 12 + 2];
    if (t.groundSample(x, z) < 1.5 || buildings.some((b) => Math.hypot(b.x - x, b.z - z) < 70 + Math.max(b.width ?? 10, b.length ?? 10))) continue;
    for (let a = 0; a < 16; a++) {
      const angle = (a / 16) * Math.PI * 2, ex = x + Math.cos(angle) * range, ez = z + Math.sin(angle) * range, eyeY = Math.max(t.groundSample(ex, ez) + 2.2, y + 2.4);
      let clear = true;
      for (let s = 0.08; s <= 0.92 && clear; s += 0.04) clear = t.groundSample(x + (ex - x) * s, z + (ez - z) * s) <= y + 1.6 + (eyeY - y - 1.6) * s - 0.3;
      for (let k = 0; k < grid.trees && clear; k++) {
        const q = grid.rootOf[k] * 12;
        if (q === index * 12) continue;
        const along = ((roots[q] - ex) * (x - ex) + (roots[q + 2] - ez) * (z - ez)) / (range * range);
        if (along >= -0.05 && along <= 1 && Math.hypot(roots[q] - (ex + (x - ex) * along), roots[q + 2] - (ez + (z - ez) * along)) < 9) clear = false;
      }
      if (clear) return { x, y, z, ex, eyeY, ez, scale: roots[index * 12 + 3] };
    }
  }
  return null;
}, { species, range });

const cameraAt = ({ x, y, z, ex, eyeY, ez, scale }) => {
  const dx = x - ex, dz = z - ez, yaw = (Math.atan2(dx, -dz) * 180) / Math.PI, pitch = (Math.atan2(y + 1.5 * scale - eyeY, Math.hypot(dx, dz)) * 180) / Math.PI;
  return [ex, eyeY, ez, yaw, pitch].join(',');
};
const readTree = (page, tree) => page.evaluate(({ x, z }) => {
  const t = oceanFleet.terrain, roots = t.forestTrunks.roots;
  let at = -1;
  for (let i = 0; i < t.forestTrunks.count; i++) if (roots[i * 12] === x && roots[i * 12 + 2] === z) { at = i * 12; break; }
  oceanFleet.portDamage.snapshot(t.ports);
  return { found: at >= 0, struck: roots[at + 11], scale: roots[at + 3], impacts: t.sceneryImpacts?.length ?? 0, last: t.sceneryImpacts?.at(-1) ?? null, saved: oceanFleet.portDamage.forestStrikes(t.forestStrikeKey), buildings: (t.port?.instances ?? []).filter((b) => b.damageState?.hits).length };
}, tree);
async function fire(page, shot) {
  await page.keyboard.down('f');
  await page.waitForFunction((n) => window.oceanFreeCannon.state.guns[0].roundsFired >= n, shot, { timeout: 60000, polling: 50 });
  await page.keyboard.up('f');
}
const canvasChange = (page, a, b) => page.evaluate(async ([p, q]) => {
  const read = async (text) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + text;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height).data;
  };
  const [u, v] = await Promise.all([read(p), read(q)]);
  let changed = 0;
  for (let i = 0; i < u.length; i += 4) if (Math.abs(u[i] - v[i]) + Math.abs(u[i + 1] - v[i + 1]) + Math.abs(u[i + 2] - v[i + 2]) > 30) changed++;
  return changed;
}, [a.toString('base64'), b.toString('base64')]);
// Hide everything but the picture, so a change in it is a change in the world.
const picture = (page) => page.addStyleTag({ content: 'body > *:not(canvas){visibility:hidden !important}canvas{visibility:visible !important}body::after{display:none !important}' });

test('the free cannon snaps a foreshore palm where its trunk is drawn, and it stays down in a saved game', { timeout: 590000 }, async () => {
  let tree;
  { const { page } = await open('san-juan'); tree = await pickTree(page, 'palm', 34); await page.close(); }
  assert.ok(tree, 'a palm in the open');
  let link;
  {
    const { page, errors } = await open('san-juan', { cam: cameraAt(tree) });
    try {
      await picture(page);
      await page.waitForTimeout(4000);
      const before = await page.screenshot();
      assert.deepEqual(await readTree(page, tree).then((r) => [r.found, r.struck, r.impacts]), [true, 0, 0]);
      await fire(page, 1);
      await page.waitForFunction(() => oceanFleet.terrain.sceneryImpacts?.length > 0, null, { timeout: 30000, polling: 50 });
      await page.waitForTimeout(500);
      const hit = await readTree(page, tree);
      assert.equal(hit.last.sceneryType, 'palm', 'it was a palm that stopped the ball');
      assert.ok(hit.struck < 0, `the ball felled it: ${hit.struck}`);
      assert.equal(hit.scale, Math.fround(tree.scale), 'it comes down: it does not vanish');
      assert.equal(hit.buildings, 0);
      // Struck on the trunk, not a metre and more off it in the air.
      const off = Math.hypot(hit.last.position[0] - tree.x, hit.last.position[2] - tree.z);
      assert.ok(off < 1.2, `struck ${off.toFixed(2)} m from the foot`);
      await page.waitForTimeout(8000);
      const after = await page.screenshot(), changed = await canvasChange(page, before, after);
      assert.ok(changed > 600, `the picture changed: ${changed} pixels`);
      const settled = await readTree(page, tree);
      assert.ok(settled.struck <= -1e8, 'once down it stays down, whatever the clock does');
      assert.equal(settled.saved.length, 1, 'the tree is in the save');
      link = await page.evaluate(async () => {
        const { encodeGameStateParam } = await import('/js/sharing.js');
        return encodeGameStateParam({ v: 1, portDamage: oceanFleet.portDamage.forLink(oceanFleet.terrain.port, oceanFleet.terrain.forestStrikeKey) });
      });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
  {
    const { page, errors } = await open('san-juan', { cam: cameraAt(tree) }, link);
    try {
      const back = await readTree(page, tree);
      assert.ok(back.found, 'the same tree');
      assert.ok(back.struck <= -1e8, 'it was down before the coast was seen, with no fall to replay');
      const passes = await page.evaluate(async ({ x, y, z, scale }) => {
        const { sweepForestTrunks } = await import('/js/forest-trunks.js');
        // Well up the trunk, leaning or not, there is no trunk any more.
        const h = y + 7 * scale, grid = oceanFleet.terrain.forestTrunks, line = [[x - 2.5, h, z], [x + 2.5, h, z]];
        return sweepForestTrunks(grid, line[0], line[1], 0.07) === null;
      }, tree);
      assert.ok(passes, 'a ball passes where the trunk stood');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test('the free cannon wounds a hardwood, the next ball fells it, and the sweep costs nothing to speak of', { timeout: 590000 }, async () => {
  let tree;
  { const { page } = await open('jamestown'); tree = await pickTree(page, 'chestnut', 30); await page.close(); }
  assert.ok(tree, 'a chestnut in the open');
  const { page, errors } = await open('jamestown', { cam: cameraAt(tree) });
  try {
    await picture(page);
    await page.waitForTimeout(4000);
    const before = await page.screenshot();
    let rounds = 1, state;
    await fire(page, rounds);
    await page.waitForFunction(() => oceanFleet.terrain.sceneryImpacts?.length > 0, null, { timeout: 30000, polling: 50 });
    await page.waitForTimeout(400);
    state = await readTree(page, tree);
    assert.equal(state.last.sceneryType, 'tree');
    assert.ok(state.struck > 0, `the first ball leaves a wound and the tree standing: ${state.struck}`);
    // Past the smoke, the wound is to be seen.
    await page.waitForTimeout(9000);
    const wounded = await page.screenshot();
    assert.ok(await canvasChange(page, before, wounded) > 8, 'the wound shows');
    while (state.struck > 0 && rounds < 8) {
      await page.waitForTimeout(1100);
      await fire(page, ++rounds);
      await page.waitForFunction((n) => oceanFleet.terrain.sceneryImpacts?.length >= n, rounds, { timeout: 30000, polling: 50 });
      await page.waitForTimeout(400);
      state = await readTree(page, tree);
    }
    assert.ok(state.struck < 0, `felled after ${rounds} balls`);
    assert.ok(rounds >= 2, 'a hardwood takes more than one');
    // A broadside's worth of sweeps through this forest, on the page, at the page's own speed.
    const perFrame = await page.evaluate(async ({ x, y, z }) => {
      const { sweepForestTrunks } = await import('/js/forest-trunks.js');
      const grid = oceanFleet.terrain.forestTrunks, started = performance.now();
      let sweeps = 0;
      for (let repeat = 0; repeat < 60; repeat++) for (let b = 0; b < 52; b++) for (let s = 0; s < 40; s++) {
        const px = x - 60 + s * 2.83, pz = z - 60 + (b / 52) * 120;
        sweepForestTrunks(grid, [px, y + 3, pz], [px + 2.83, y + 3, pz], 0.073);
        sweeps++;
      }
      return ((performance.now() - started) / sweeps) * 104;
    }, tree);
    console.log(`jamestown: a Victory broadside costs ${perFrame.toFixed(3)} ms of sweep a frame`);
    assert.ok(perFrame < 1.5, `${perFrame} ms a frame`);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
