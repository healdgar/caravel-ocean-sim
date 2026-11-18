// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The passing trade vessels in the game itself, cut and drawn through the ship continuum (js/trade-vessels.js on
// js/ship-continuum-draw.js): the cut's lists read back at Lisbon's harbour and checked, ship by ship, against the
// instances they were cut from and the bodies the bake made (assets/ships/continuum).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { SHIP_CONTINUUM_ASSETS, SHIP_CONTINUUM_BODIES, SHIP_CONTINUUM_STEP_WORDS } from '../js/ship-continuum.js';
import {
  SHIP_CONTINUUM_DAMAGED_LIST, SHIP_CONTINUUM_DAMAGED_SHIFT, SHIP_CONTINUUM_INSTANCE_FLOATS, SHIP_CONTINUUM_INSTANCE_VERTICES,
  SHIP_CONTINUUM_LISTS, SHIP_CONTINUUM_SHADOW_LIST,
} from '../js/wgsl/ship-continuum.js';

const at = (file) => new URL(`../${file}`, import.meta.url);
// Each body's cluster count and, for each step of its far body, the triangles alive.
const bodies = Object.fromEntries(SHIP_CONTINUUM_BODIES.map(({ id }) => {
  const manifest = JSON.parse(fs.readFileSync(at(SHIP_CONTINUUM_ASSETS[id]['manifest.json']), 'utf8'));
  const far = zlib.gunzipSync(fs.readFileSync(at(SHIP_CONTINUUM_ASSETS[id]['far.bin.gz']))), words = new Uint32Array(far.buffer, far.byteOffset, far.length / 4);
  const alive = Array.from({ length: manifest.far.stepCount + 1 }, (_, s) => words[manifest.far.offsets.steps + s * SHIP_CONTINUUM_STEP_WORDS]);
  return [id, { clusters: manifest.clusterCount, alive }];
}));
const chunks = (body, step) => Math.ceil(bodies[body].alive[step] / 128);

let browser, server, base;
before(async () => {
  server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-unsafe-webgpu', `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`, '--disable-gpu-watchdog'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); server?.close(); });

const instrument = () => {
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...a) { return window.shipContinuumDevice ??= await request.apply(this, a); };
};
// The cut as it stands after a frame: every list's draw, the per-ship state words, every entry, and the instances.
const readCut = (page) => page.evaluate(async () => {
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  const device = window.shipContinuumDevice, c = window.oceanTradeVessels.continuum;
  const read = async (buffer, bytes) => {
    const copy = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, copy, 0, bytes); device.queue.submit([encoder.finish()]);
    await copy.mapAsync(GPUMapMode.READ); const bytesOut = copy.getMappedRange().slice(0); copy.destroy(); return bytesOut;
  };
  // Read in one submission's wake: the cut, its draws and the instances it read are of the same frame.
  const [draws, list, instances] = await Promise.all([read(c.draws, c.draws.size), read(c.list, c.list.size), read(c.instances, Math.max(16, c.count * 48))]);
  return {
    count: c.count, bodies: c.bodies, lists: c.lists,
    draws: Array.from(new Uint32Array(draws)), list: Array.from(new Uint32Array(list)), instances: Array.from(new Float32Array(instances)),
    census: window.oceanContinuumCensus?.latest?.families ?? null,
  };
});

async function open(query) {
  const url = new URL(base);
  for (const [k, v] of Object.entries({ region: 'lisbon', landfall: 'harbor', follower: '0', w: 960, h: 540, census: '1', ...query })) url.searchParams.set(k, String(v));
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } }), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errors.push(m.text()); if (/[Ss]hip continuum/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', null, { timeout: 300000, polling: 200 });
  assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready', errors.join('\n'));
  await page.waitForFunction(() => window.oceanTradeVessels?.continuum?.count > 0, null, { timeout: 240000, polling: 500 });
  await page.waitForTimeout(3000);
  return { page, errors };
}

// Every list against the instances it was cut from and the bodies: what each ship drew, and where.
function check(cut) {
  const { count, lists, draws, list, instances } = cut;
  assert.deepEqual(cut.bodies, SHIP_CONTINUUM_BODIES.map(({ id }) => id), 'the trade bodies, by archetype');
  const entries = (L) => {
    const [first, room] = lists[L], n = draws[L * 4 + 1];
    assert.ok(n <= room, `${SHIP_CONTINUUM_LISTS[L]} holds no more than its room`);
    return Array.from({ length: n }, (_, i) => [list[(first + i) * 2], list[(first + i) * 2 + 1]]);
  };
  SHIP_CONTINUUM_LISTS.forEach((name, L) => {
    assert.equal(draws[L * 4], SHIP_CONTINUUM_INSTANCE_VERTICES[L], `${name} draws whole instances`);
    assert.equal(draws[L * 4 + 2] + draws[L * 4 + 3], 0, `${name} draws from its list's start`);
  });
  const ships = Array.from({ length: count }, (_, s) => {
    const f = instances.slice(s * SHIP_CONTINUUM_INSTANCE_FLOATS, (s + 1) * SHIP_CONTINUUM_INSTANCE_FLOATS);
    return {
      body: cut.bodies[Math.round(f[7])], damaged: (Math.round(f[10]) >>> SHIP_CONTINUUM_DAMAGED_SHIFT) & 31,
      share: (list[s * 4] >>> 8) & 255, splatShare: (list[s * 4] >>> 16) & 255, step: list[s * 4 + 1] & 0xffff, shadowStep: list[s * 4 + 1] >>> 16,
      clusters: new Set(), far: [], splat: 0, shadow: [], damagedClusters: 0,
    };
  });
  for (const [ship, i] of entries(0)) {
    assert.ok(ship < count && i < bodies[ships[ship].body].clusters, `cluster ${i} of ship ${ship} is one its body has`);
    assert.ok(!ships[ship].clusters.has(i), `ship ${ship} draws cluster ${i} once`);
    ships[ship].clusters.add(i);
  }
  for (const [ship, c] of entries(1)) ships[ship].far.push(c);
  for (const [ship] of entries(2)) ships[ship].splat++;
  for (const [ship, c] of entries(SHIP_CONTINUUM_SHADOW_LIST)) ships[ship].shadow.push(c);
  for (let L = SHIP_CONTINUUM_DAMAGED_LIST; L < SHIP_CONTINUUM_LISTS.length; L++) for (const [ship] of entries(L)) ships[ship].damagedClusters++;
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  ships.forEach((s, k) => {
    if (s.damaged) return;
    // Every whole ship casts its shadow from its far body at the shadow map's step, seen or not.
    assert.deepEqual(s.shadow.sort((x, y) => x - y), range(chunks(s.body, s.shadowStep)), `ship ${k} (${s.body}) shadow is its far body at step ${s.shadowStep}`);
    // Handed off (in part) to the far continuum: its far body at the chosen step, all of it, and/or its splat.
    if (s.share > 0 && s.splatShare < 255) assert.deepEqual(s.far.sort((x, y) => x - y), range(chunks(s.body, s.step)), `ship ${k} (${s.body}) far body at step ${s.step}`);
    else assert.equal(s.far.length, 0, `ship ${k} draws no far body unless handed to it`);
    assert.ok(s.splat <= (s.share > 0 && s.splatShare > 0 ? 1 : 0), `ship ${k} draws at most one splat, and only when it is far`);
    assert.ok(s.share < 255 || s.clusters.size === 0, `ship ${k} draws no clusters once wholly handed off`);
    assert.equal(s.damagedClusters, 0, `whole ship ${k} enters no damaged list`);
  });
  const tally = Object.fromEntries(SHIP_CONTINUUM_LISTS.slice(0, SHIP_CONTINUUM_DAMAGED_LIST).map((name, L) => [name, draws[L * 4 + 1]]));
  if (cut.census) assert.ok(cut.census['trade vessels'] > 0, `the census counts the vessels: ${JSON.stringify(cut.census)}`);
  return { count, tally, near: ships.filter((s) => s.clusters.size > 0).length, far: ships.filter((s) => s.far.length || s.splat).length };
}

test('trade vessels at Lisbon\'s harbour are cut on the GPU into clusters, far bodies, splats and shadows, each ship as its body allows', { timeout: 900000 }, async () => {
  fs.mkdirSync(at('shots'), { recursive: true });
  // The harbour as the game opens it: the vessels out on the river, far bodies and splats.
  const first = await open({});
  let target;
  try {
    const seen = check(await readCut(first.page));
    await first.page.screenshot({ path: new URL('../shots/ship-continuum-lisbon-harbour.png', import.meta.url).pathname });
    console.log('ship continuum, harbour', JSON.stringify(seen));
    assert.ok(seen.count > 0 && seen.far > 0, `vessels across the harbour are drawn from the far continuum (${seen.far} of ${seen.count})`);
    target = await first.page.evaluate(() => {
      const all = window.oceanTradeVessels.locate().filter((v) => v.mode === 'sea');
      all.sort((a, b) => (a.phase === 'dock' ? 0 : 1) - (b.phase === 'dock' ? 0 : 1) || a.speed - b.speed);
      return all[0];
    });
    assert.deepEqual(first.errors, []);
  } finally { await first.page.close(); }
  assert.ok(target, 'a vessel to stand beside');

  // Off her beam: she is cut from her clusters, the rest hand off by distance.
  const off = [Math.cos(target.yaw) * 30, Math.sin(target.yaw) * 30];
  const eye = [target.worldX + off[0], (target.y ?? 0) + 8, target.worldZ + off[1]];
  const dx = target.worldX - eye[0], dz = target.worldZ - eye[2];
  const yaw = (Math.atan2(dx, -dz) * 180) / Math.PI, pitch = (Math.atan2(-6, Math.hypot(dx, dz)) * 180) / Math.PI;
  const { page, errors } = await open({ view: 'free', prow: '0', cam: `${eye[0].toFixed(1)},${eye[1].toFixed(1)},${eye[2].toFixed(1)},${yaw.toFixed(2)},${pitch.toFixed(2)}` });
  try {
    const seen = check(await readCut(page));
    await page.screenshot({ path: new URL('../shots/ship-continuum-lisbon-near.png', import.meta.url).pathname });
    console.log('ship continuum, beside', JSON.stringify({ target: { id: target.id, kind: target.kind, phase: target.phase }, ...seen }));
    assert.ok(seen.near > 0, `the vessel beside the eye is cut from her clusters (${seen.near} of ${seen.count})`);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
